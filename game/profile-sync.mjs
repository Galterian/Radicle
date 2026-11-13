// Player profile persistence in the chaosD6-Profiles Radicle repo, over plain
// git smart-HTTP (isomorphic-git, pure JS — no native git, no Radicle node on
// the phone). Live dimension sync is NOT done here; radicle-adapter.mjs stays
// off on mobile.
//
//   read : radicle-httpd on the OCI seed, depth 1, one ref only:
//          <readUrl>  refs/namespaces/<delegate NID>/refs/heads/profiles/<id>
//   write: infra/oci/profiles-push.mjs on the same host (git receive-pack +
//          X-Profile-Auth), which then `git push rad`es the branch so Radicle
//          replicates it.
//
// The player profile itself lives on the team branch refs/heads/teams/<Team> (`ref` option; owners and the
// per-character merge are in profile-radicle.mjs); profiles/<id> is each device's own branch (join requests).
// Each branch is an orphan holding one file, profile.json. A save is
// one commit whose parent is the remote tip (no merges: the whole profile is
// the state, last writer wins, the server only accepts fast-forwards). A save
// that cannot reach the server stays in pending.json and goes out on the next
// pull/save.
//
//   const ps = await openProfileStore({ dir: `${filesDir}/profiles` });
//   const profile = await ps.pull();          // null for a brand-new player
//   await ps.save({ ...profile, name: 'X' });  // → { pushed: true, oid }

import fs from 'node:fs';
import path from 'node:path';
import { generateIdentity, idFromPrivateKeyPem, profileRef, signPush, AUTH_HEADER } from './profile-auth.mjs';

const SEED_HOST = process.env.RADICLE_SEED_HOST || '92-5-138-121.sslip.io';
// Deployed by infra/oci/profiles-setup.sh (2026-11-13): chaosD6-Profiles and its sole delegate, the OCI node.
const PROFILES_RID = process.env.RADICLE_PROFILES_RID || 'rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH';
const OCI_NID = 'z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT';
const ZERO = '0000000000000000000000000000000000000000';
const FILE = 'profile.json';

export const DEFAULTS = {
  readUrl: process.env.PROFILES_READ_URL || (PROFILES_RID ? `https://${SEED_HOST}/${PROFILES_RID.replace(/^rad:/, '')}.git` : ''),
  pushUrl: process.env.PROFILES_PUSH_URL || `https://${SEED_HOST}/profiles-push`,
  // NID of the delegate (the OCI node) whose namespace holds the branches.
  // Empty = the read URL serves refs/heads/profiles/* directly (local tests,
  // or the push service's own fallback read path).
  namespace: process.env.PROFILES_NAMESPACE ?? (process.env.PROFILES_READ_URL ? '' : OCI_NID),
};

// A TLS-intercepting proxy (Zscaler on the dev PC) re-signs https: PROFILES_CA_FILE (PEM, added to Node's
// roots for this process's https requests), or <dir>/extra-ca.pem next to identity.pem, makes the seed
// trusted again. Neither → Node's defaults.
let caDone = false;
async function extraCa(dir) {
  if (caDone) return;
  caDone = true;
  const f = process.env.PROFILES_CA_FILE || (dir ? path.join(dir, 'extra-ca.pem') : '');
  if (!f || !fs.existsSync(f)) return;
  const [{ default: https }, { default: tls }] = await Promise.all([import('node:https'), import('node:tls')]);
  https.globalAgent.options.ca = [...tls.rootCertificates, fs.readFileSync(f, 'utf8')];
}

let gitMods = null;
async function loadGit(dir) {
  await extraCa(dir);
  if (!gitMods) {
    const [{ default: git }, { default: http }] = await Promise.all([
      import('isomorphic-git'), import('isomorphic-git/http/node'),
    ]);
    gitMods = { git, http };
  }
  return gitMods;
}

/** Load the player key from <dir>/identity.pem, creating it on first run. */
export function loadIdentity(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, 'identity.pem');
  if (!fs.existsSync(keyFile)) {
    const { privateKeyPem } = generateIdentity();
    fs.writeFileSync(keyFile, privateKeyPem, { mode: 0o600 });
  }
  const privateKeyPem = fs.readFileSync(keyFile, 'utf8');
  return { id: idFromPrivateKeyPem(privateKeyPem), privateKeyPem };
}

const httpReason = (e) => e?.data?.statusMessage || e?.data?.reason || e?.message || String(e);

/**
 * `ref` (default: this device's refs/heads/profiles/<id>) picks the branch, e.g. teamRef('Gold') for the
 * team profile; each branch gets its own shallow gitdir + pending file under `dir` (`name` keys them).
 */
export async function openProfileStore({ dir, readUrl = DEFAULTS.readUrl, pushUrl = DEFAULTS.pushUrl, namespace, ref: wantRef = null, name = null, log = () => {} } = {}) {
  namespace ??= readUrl === DEFAULTS.readUrl ? DEFAULTS.namespace : '';   // the delegate namespace belongs to the seed URL
  if (!dir) throw new Error('openProfileStore: dir required');
  if (!readUrl) throw new Error('openProfileStore: no read URL (set RADICLE_PROFILES_RID or PROFILES_READ_URL)');
  const { git, http } = await loadGit(dir);
  const identity = loadIdentity(dir);
  const { id } = identity;
  const ref = wantRef || profileRef(id);
  const readRef = namespace ? `refs/namespaces/${namespace}/${ref}` : ref;
  const key = name || (wantRef ? ref.replace(/^refs\/heads\//, '').replace(/[^\w-]+/g, '_') : null);
  const gitdir = path.join(dir, key ? `${key}.git` : 'repo.git');
  const pendingFile = path.join(dir, key ? `pending-${key}.json` : 'pending.json');
  if (!fs.existsSync(path.join(gitdir, 'HEAD'))) {
    await git.init({ fs, gitdir, bare: true, defaultBranch: ref.replace(/^refs\/heads\//, '') });
  }
  // The `--single-branch` refspec: only this player's ref is ever fetched.
  await git.setConfig({ fs, gitdir, path: 'remote.origin.url', value: readUrl });
  await git.setConfig({ fs, gitdir, path: 'remote.origin.fetch', value: `+${readRef}:refs/remotes/origin/profile` });

  /** Remote tip oid, or null if the player has never saved. Fetches depth 1. */
  async function fetchTip() {
    try {
      const r = await git.fetch({ fs, http, gitdir, remote: 'origin', remoteRef: readRef, singleBranch: true, depth: 1, tags: false });
      return r.fetchHead || null;
    } catch (e) {
      if (e?.code === 'NotFoundError') return null;
      throw e;
    }
  }

  async function readAt(oid) {
    const { blob } = await git.readBlob({ fs, gitdir, oid, filepath: FILE });
    return JSON.parse(Buffer.from(blob).toString('utf8'));
  }

  async function push(profile, parent) {
    const blob = await git.writeBlob({ fs, gitdir, blob: Buffer.from(JSON.stringify(profile, null, 2) + '\n') });
    const tree = await git.writeTree({ fs, gitdir, tree: [{ mode: '100644', path: FILE, oid: blob, type: 'blob' }] });
    const who = { name: id.slice(0, 16), email: `${id}@profiles.chaosd6`, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
    const oid = await git.writeCommit({ fs, gitdir, commit: { tree, parent: parent ? [parent] : [], author: who, committer: who, message: 'profile\n' } });
    await git.writeRef({ fs, gitdir, ref, value: oid, force: true });
    const headers = { [AUTH_HEADER]: signPush(identity.privateKeyPem, { ref, oldOid: parent || ZERO, newOid: oid }) };
    let r;
    try { r = await git.push({ fs, http, gitdir, url: pushUrl, ref, remoteRef: ref, headers }); } catch (e) { throw new Error(httpReason(e)); }
    const st = r.refs?.[ref];
    if (!r.ok || (st && !st.ok)) throw new Error(`push rejected: ${st?.error || r.error || 'unknown'}`);
    return oid;
  }

  async function flushPending(tip) {
    if (!fs.existsSync(pendingFile)) return { tip, flushed: false };
    const profile = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    const oid = await push(profile, tip);
    fs.rmSync(pendingFile, { force: true });
    log(`profile: pushed pending save ${oid.slice(0, 8)}`);
    return { tip: oid, flushed: true, profile };
  }

  return {
    id,
    ref,
    /** Remote tip, depth 1: { oid, profile } (both null when the branch does not exist yet). */
    async fetch() {
      const oid = await fetchTip();
      return { oid, profile: oid ? await readAt(oid) : null };
    },
    /** One commit on top of `parent` (null = create the branch), pushed; returns its oid or throws the server's reason. */
    commit: (profile, parent) => push(profile, parent || null),
    /** Latest saved profile (after flushing a pending offline save), or null. */
    async pull() {
      let tip = await fetchTip();
      const f = await flushPending(tip);
      if (f.flushed) return f.profile;
      return tip ? readAt(tip) : null;
    },
    /** Commit + push. Offline → kept in pending.json, `{ pushed: false }`. */
    async save(profile) {
      fs.writeFileSync(pendingFile, JSON.stringify(profile));
      try {
        const tip = await fetchTip();
        const { tip: oid } = await flushPending(tip);
        return { pushed: true, oid };
      } catch (e) {
        log(`profile: save kept locally (${e.message})`);
        return { pushed: false, error: e.message };
      }
    },
    /** The cached copy without touching the network. */
    async local() {
      if (fs.existsSync(pendingFile)) return JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      try { return await readAt(await git.resolveRef({ fs, gitdir, ref })); } catch { return null; }
    },
  };
}

/**
 * Every device branch (refs/heads/profiles/<id>) on the server with its profile.json, depth 1 each —
 * the join requests an owner device can approve. `skip(id)` avoids fetching ids already known.
 */
export async function listDeviceBranches({ dir, readUrl = DEFAULTS.readUrl, namespace, skip = () => false, max = 40 } = {}) {
  namespace ??= readUrl === DEFAULTS.readUrl ? DEFAULTS.namespace : '';
  const { git, http } = await loadGit(dir);
  const ns = namespace ? `refs/namespaces/${namespace}/` : '';
  const prefix = `${ns}refs/heads/profiles/`;
  let refs;
  try { refs = await git.listServerRefs({ http, url: readUrl, prefix, protocolVersion: 1 }); } catch (e) { throw new Error(httpReason(e)); }
  const gitdir = path.join(dir, 'requests.git');
  if (!fs.existsSync(path.join(gitdir, 'HEAD'))) await git.init({ fs, gitdir, bare: true });
  await git.setConfig({ fs, gitdir, path: 'remote.origin.url', value: readUrl });
  await git.setConfig({ fs, gitdir, path: 'remote.origin.fetch', value: `+${prefix}*:refs/remotes/origin/*` });
  const out = [];
  for (const { ref, oid } of refs.slice(0, 500)) {
    const id = ref.slice(prefix.length);
    if (!/^z6Mk/.test(id) || skip(id)) continue;
    if (out.length >= max) break;
    try {
      let have = true;
      try { await git.readCommit({ fs, gitdir, oid }); } catch { have = false; }
      if (!have) await git.fetch({ fs, http, gitdir, remote: 'origin', remoteRef: ref, ref: id, singleBranch: true, depth: 1, tags: false });
      const { blob } = await git.readBlob({ fs, gitdir, oid, filepath: FILE });
      out.push({ id, oid, profile: JSON.parse(Buffer.from(blob).toString('utf8')) });
    } catch (e) { if (process.env.PROFILE_SYNC_DEBUG) console.error('listDeviceBranches', id, e.message); }   // unreadable: not a request
  }
  return out;
}
