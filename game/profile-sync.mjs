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
// Each player's branch is an orphan holding one file, profile.json. A save is
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
const PROFILES_RID = process.env.RADICLE_PROFILES_RID || '';
const ZERO = '0000000000000000000000000000000000000000';
const FILE = 'profile.json';

export const DEFAULTS = {
  readUrl: process.env.PROFILES_READ_URL || (PROFILES_RID ? `https://${SEED_HOST}/${PROFILES_RID.replace(/^rad:/, '')}.git` : ''),
  pushUrl: process.env.PROFILES_PUSH_URL || `https://${SEED_HOST}/profiles-push`,
  // NID of the delegate (the OCI node) whose namespace holds the branches.
  // Empty = the read URL serves refs/heads/profiles/* directly (local tests,
  // or the push service's own fallback read path).
  namespace: process.env.PROFILES_NAMESPACE || '',
};

let gitMods = null;
async function loadGit() {
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

export async function openProfileStore({ dir, readUrl = DEFAULTS.readUrl, pushUrl = DEFAULTS.pushUrl, namespace = DEFAULTS.namespace, log = () => {} } = {}) {
  if (!dir) throw new Error('openProfileStore: dir required');
  if (!readUrl) throw new Error('openProfileStore: no read URL (set RADICLE_PROFILES_RID or PROFILES_READ_URL)');
  const { git, http } = await loadGit();
  const identity = loadIdentity(dir);
  const { id } = identity;
  const ref = profileRef(id);
  const readRef = namespace ? `refs/namespaces/${namespace}/${ref}` : ref;
  const gitdir = path.join(dir, 'repo.git');
  const pendingFile = path.join(dir, 'pending.json');
  if (!fs.existsSync(path.join(gitdir, 'HEAD'))) {
    await git.init({ fs, gitdir, bare: true, defaultBranch: `profiles/${id}` });
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
    const r = await git.push({ fs, http, gitdir, url: pushUrl, ref, remoteRef: ref, headers });
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
