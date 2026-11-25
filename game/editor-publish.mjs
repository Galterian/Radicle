// Rules editor — publish ONE new definition (skill / effect / class) on the team's player branch (EDITOR_SPEC ruling 2,
// 2026-11-22): `players/<team-slug>/<slug>` of chaosD6-Skills / -Effects / -Classes, never `main`. Used by
// game/editor-api.mjs (POST /rules/api/editor/definitions, definitions/retry, GET definitions/mine).
//
// The branch is the repo's `main` + one definition (game/tools/skills-repo-template/README.md "How to propose a skill"):
// tree = main's tree + <subdir>/<id>.json + index.json (the manifest map <subdir> gets <id>: sha256), parent = the
// branch's earlier tip (fast-forward; + main as a second parent when main moved since), else main.
// Commit author = committer = `<team name> <identity id>@chaosd6`; trailers
//   Chaosd6-Author: <identity id z6Mk…>
//   Chaosd6-Signature: ed25519:<base64 ed25519 signature over the UTF-8 hex string sha256(canonicalJson(def))>
// (verifyDefinitionSignature below is the reference check).
//
// Desktop (via 'git'), the same mechanics as proposal-votes-publish.mjs:
//   1. <profile dir>/editor-defs-git/<rid>.git (bare, created on first use), remote `rad` = rad://<rid>/<nid>
//   2. git fetch rad +refs/heads/<branch> (my earlier tip; failure ignored) and rad://<rid> main (required: no main →
//      pending "cannot read main", nothing committed)
//   3. commit (plumbing: read-tree / update-index / write-tree / commit-tree under a temp GIT_INDEX_FILE)
//   4. git push rad refs/heads/<branch>  → the LOCAL Radicle node (my namespace)
//   5. rad sync <rid> --seed <OCI seed NID> --announce   — the OCI seed ONLY, never public seeds
// Phone (via 'bridge'): POST http://127.0.0.1:<port>/publish of the in-app node, only when bridge.json lists the
//   "defs" feature (an older APK without it → pending "phone node cannot publish definitions yet"): { rid, ref,
//   mode: 'definition', base: 'refs/heads/main', files: { <subdir>/<id>.json: text }, manifest: { file: 'index.json', key,
//   id, sha256 }, name, email, timestamp, message, seed } → { ok, oid, unchanged? } | { ok:false, error } — the node
//   (radicle-node/ffi definition_commit) builds the same commit as commitGit in its namespace and announces to `seed`.
// Status: <profile dir>/editor-defs.json { version, defs: { "<kind>:<id>": { kind, id, team, slug, repo, branch, commit,
//   sha256, def, name, at, publish: { state: published|pending, error?, via, tries, at } } } }.
// Test hooks (`hooks`): profileFile, remoteUrlFor(rid, nid) (a bare repo path), radSync: false, bridgeFile, via,
//   env (extra env for git), fetchImpl, now, nid.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto, { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { canonicalJson, sha256Hex, PLAYER_BRANCH_PREFIX, MAIN_BRANCH } from './defs-repo.mjs';
import { rawPublicKeyFromId } from './profile-auth.mjs';
import { DEFAULT_RIDS, REPO_NAMES, OCI_SEED_NID, NID_RE } from './proposal-votes.mjs';
import { profileDir } from './profile.mjs';

export const KINDS = ['skill', 'effect', 'class'];
export const SUBDIRS = { skill: 'skills', effect: 'effects', class: 'classes' };
export const STATUS_FILE = 'editor-defs.json';
export const SIG_PREFIX = 'ed25519:';

const ridBare = (rid) => String(rid).replace(/^rad:/, '');
export const defaultRemoteUrl = (rid, nid) => `rad://${ridBare(rid)}${nid ? `/${nid}` : ''}`;
export const ridOfKind = (kind) => { const r = DEFAULT_RIDS[kind]; return r.startsWith('rad:') ? r : `rad:${r}`; };
/** def.id → the branch slug: the id without its kind prefix, `_` → `-` (skill_ice_wall → ice-wall). */
export const slugOf = (kind, id) => String(id).replace(new RegExp(`^${kind}_`), '').replace(/_/g, '-');
export const branchOf = (teamSlug, kind, id) => `${PLAYER_BRANCH_PREFIX}${teamSlug}/${slugOf(kind, id)}`;
export const defPath = (kind, id) => `${SUBDIRS[kind]}/${id}.json`;
export const defSha = (def) => sha256Hex(canonicalJson(def));
const dirOf = (hooks = {}) => (hooks.profileFile ? path.dirname(hooks.profileFile) : profileDir());
export const statusFile = (hooks = {}) => path.join(dirOf(hooks), STATUS_FILE);

// ------------------------------------------------------------------ signature
export function signDefinition(privateKeyPem, def) {
  return SIG_PREFIX + crypto.sign(null, Buffer.from(defSha(def), 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}
export function verifyDefinitionSignature(def, signature, authorId) {
  try {
    if (!String(signature || '').startsWith(SIG_PREFIX)) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPublicKeyFromId(authorId)]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(defSha(def), 'utf8'), key, Buffer.from(String(signature).slice(SIG_PREFIX.length), 'base64'));
  } catch { return false; }
}
/** `Key: value` trailers of a commit message → { key: value }. */
export const trailersOf = (msg) => Object.fromEntries(String(msg || '').split('\n').map(l => /^([A-Za-z0-9-]+): (.+)$/.exec(l.trim())).filter(Boolean).map(m => [m[1], m[2]]));

// ------------------------------------------------------------------ status store
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
export function loadStatus(hooks = {}) {
  try { const s = JSON.parse(fs.readFileSync(statusFile(hooks), 'utf8')); return { version: 1, defs: {}, ...s }; } catch { return { version: 1, defs: {} }; }
}
const saveStatus = (s, hooks) => writeJsonAtomic(statusFile(hooks), s);
/** My team's authored definitions (GET definitions/mine). */
export function listMine(teamSlug, hooks = {}) {
  return Object.values(loadStatus(hooks).defs).filter(d => d.slug === teamSlug).sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .map(({ kind, id, name, repo, branch, commit, sha256, at, publish }) => ({ kind, id, name, repo, branch, commit, sha256, at, publish }));
}

// ------------------------------------------------------------------ tools
function toolEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const radBin = path.join(os.homedir(), '.radicle', 'bin');
  if (fs.existsSync(radBin) && !String(env.PATH || '').includes(radBin)) env.PATH = `${radBin}${path.delimiter}${env.PATH || ''}`;
  // `wsl -- bash` shells skip ~/.bashrc → no SSH_AUTH_SOCK; the user's agent socket lives in ~/.ssh/agent.sock.
  const sock = path.join(os.homedir(), '.ssh', 'agent.sock');
  if (!env.SSH_AUTH_SOCK && fs.existsSync(sock)) env.SSH_AUTH_SOCK = sock;
  return env;
}
function run(cmd, args, { env, timeout = 60e3, input } = {}) {
  return new Promise((resolve, reject) => {
    const cp = execFile(cmd, args, { encoding: 'utf8', env, timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(String(stdout).trim());
    });
    if (input !== undefined) cp.stdin.end(input); else cp.stdin.end();
  });
}
const clipErr = (s) => s.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
const errText = (e) => clipErr(String(e?.stderr || '').trim() || e?.message || String(e));
export const publishVia = (hooks = {}) => hooks.via || (process.env.CHAOSD6_MOBILE === '1' ? 'bridge' : 'git');

/** bridge.json of the phone's in-app node when it can publish definitions, else { error }. */
export function readDefsBridge(file = process.env.CHAOSD6_RADICLE_BRIDGE || '') {
  let b;
  try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { error: 'phone Radicle node not running (no bridge.json)' }; }
  if (!b?.port || !b?.token) return { error: 'phone Radicle bridge.json incomplete' };
  if (!Array.isArray(b.features) || !b.features.includes('defs')) return { error: 'phone Radicle node cannot publish definitions yet (bridge lacks the "defs" feature)' };
  return { bridge: b };
}

let _ready = null;   // { at, value } — the desktop probe spawns git / rad: cache it
/** Can this node publish right now? → { mode: 'desktop'|'phone', ready, why? } (GET session `publish`). */
export async function publishReadiness(hooks = {}) {
  if (publishVia(hooks) === 'bridge') {
    const vb = readDefsBridge(hooks.bridgeFile ?? (process.env.CHAOSD6_RADICLE_BRIDGE || ''));
    return vb.bridge ? { mode: 'phone', ready: true } : { mode: 'phone', ready: false, why: vb.error };
  }
  if (_ready && Date.now() - _ready.at < 30e3 && !hooks.fresh) return _ready.value;
  const env = toolEnv(hooks.env);
  let value = { mode: 'desktop', ready: true };
  try { await run('git', ['--version'], { env, timeout: 10e3 }); } catch { value = { mode: 'desktop', ready: false, why: 'git not found' }; }
  if (value.ready && hooks.radSync !== false) {
    const nid = await radNid(env);
    if (!nid) value = { mode: 'desktop', ready: false, why: 'no Radicle identity (`rad self --nid` failed) — the commit is kept, publish stays pending' };
  }
  _ready = { at: Date.now(), value };
  return value;
}
async function radNid(env) {
  try { const n = await run('rad', ['self', '--nid'], { env, timeout: 15e3 }); return NID_RE.test(n) ? n : null; } catch { return null; }
}

// ------------------------------------------------------------------ desktop: git
// files [{ path, text }] + manifest [{ key, id, sha256 }] (index.json maps) on main's tree; subject / body = the message.
async function commitGit({ files, manifest: entries, subject, body, repoName, team, identity, branch, rid, gitdir, nid, remoteUrlFor, env, now }) {
  const ref = `refs/heads/${branch}`;
  const g = (args, o = {}) => run('git', ['--git-dir', gitdir, ...args], { env, ...o });
  let step = 'init';
  try {
    if (!fs.existsSync(path.join(gitdir, 'HEAD'))) { fs.mkdirSync(gitdir, { recursive: true }); await run('git', ['init', '-q', '--bare', gitdir], { env }); }
    step = 'remote';
    const url = remoteUrlFor(rid, nid);
    try { await g(['remote', 'set-url', 'rad', url]); } catch { await g(['remote', 'add', 'rad', url]); }
    step = 'fetch branch';
    try { await g(['fetch', '-q', 'rad', `+${ref}:${ref}`], { timeout: 60e3 }); } catch { /* first publish / offline: build on what we have */ }
    step = `read ${MAIN_BRANCH}`;
    const mainRef = `refs/remotes/rad/${MAIN_BRANCH}`;
    let fetchErr = null;
    try { await g(['fetch', '-q', remoteUrlFor(rid, null), `+refs/heads/${MAIN_BRANCH}:${mainRef}`], { timeout: 60e3 }); } catch (e) { fetchErr = e; }
    let main;
    try { main = await g(['rev-parse', '--verify', '-q', `${mainRef}^{commit}`]); } catch { main = null; }
    if (!main) return { ok: false, commit: null, error: `cannot read ${repoName} ${MAIN_BRANCH} (${fetchErr ? errText(fetchErr) : 'no main'}) — is the repo seeded on this node? (rad clone ${rid})` };
    let tip = null;
    try { tip = await g(['rev-parse', '--verify', '-q', `${ref}^{commit}`]); } catch { tip = null; }
    step = 'commit';
    const idx = path.join(os.tmpdir(), `chaosd6-editor-index-${process.pid}-${randomBytes(4).toString('hex')}`);
    const ienv = { ...env, GIT_INDEX_FILE: idx };
    let tree;
    try {
      await run('git', ['--git-dir', gitdir, 'read-tree', `${main}^{tree}`], { env: ienv });
      for (const fl of files) {
        const blob = await g(['hash-object', '-w', '--stdin'], { input: fl.text });
        await run('git', ['--git-dir', gitdir, 'update-index', '--add', '--cacheinfo', `100644,${blob},${fl.path}`], { env: ienv });
      }
      // index.json manifest (tools/manifest.mjs of the repo template): { format, hash, <subdir>: { id: sha256 }, lib… }
      let manifest = null;
      try { manifest = JSON.parse(await g(['cat-file', '-p', `${main}:index.json`])); } catch { manifest = null; }
      if (manifest && typeof manifest === 'object') {
        for (const { key, id, sha256 } of entries) {
          const map = { ...(manifest[key] || {}), [id]: sha256 };
          manifest[key] = Object.fromEntries(Object.keys(map).sort().map(k => [k, map[k]]));
        }
        const mblob = await g(['hash-object', '-w', '--stdin'], { input: JSON.stringify(manifest, null, 2) + '\n' });
        await run('git', ['--git-dir', gitdir, 'update-index', '--add', '--cacheinfo', `100644,${mblob},index.json`], { env: ienv });
      }
      tree = await run('git', ['--git-dir', gitdir, 'write-tree'], { env: ienv });
    } finally { try { fs.unlinkSync(idx); } catch {} }
    let commit = tip;
    if (!tip || (await g(['rev-parse', `${tip}^{tree}`])) !== tree) {
      const parents = [];
      if (tip) {
        parents.push(tip);
        let mainIn = false;
        try { await g(['merge-base', '--is-ancestor', main, tip]); mainIn = true; } catch { mainIn = false; }
        if (!mainIn) parents.push(main);
      } else parents.push(main);
      const who = { GIT_AUTHOR_NAME: team.name, GIT_AUTHOR_EMAIL: `${identity.id}@chaosd6`, GIT_COMMITTER_NAME: team.name, GIT_COMMITTER_EMAIL: `${identity.id}@chaosd6`,
        GIT_AUTHOR_DATE: now().toISOString(), GIT_COMMITTER_DATE: now().toISOString() };
      commit = await run('git', ['--git-dir', gitdir, 'commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-F', '-'], { env: { ...env, ...who }, input: body });
      await g(['update-ref', ref, commit, ...(tip ? [tip] : [])]);
    }
    return { ok: true, commit };
  } catch (e) { return { ok: false, commit: null, error: `${step}: ${errText(e)}` }; }
}
async function pushGit({ branch, rid, gitdir, radSync, env }) {
  const ref = `refs/heads/${branch}`;
  let step = 'push';
  try {
    await run('git', ['--git-dir', gitdir, 'push', '-q', 'rad', `${ref}:${ref}`], { env, timeout: 90e3 });
    if (radSync) {
      step = 'announce to the OCI seed';
      await run('rad', ['sync', rid, '--seed', OCI_SEED_NID, '--announce', '--timeout', '30'], { env, timeout: 60e3 });
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: `${step}: ${errText(e)}` }; }
}

// ------------------------------------------------------------------ phone: bridge
async function publishBridge({ kind, def, sha, identity, team, message, branch, rid, bridgeFile, fetchImpl, now }) {
  const vb = readDefsBridge(bridgeFile);
  if (!vb.bridge) return { ok: false, commit: null, error: vb.error };
  // The node (godot/android/radicle-node/ffi definition_commit) rebuilds commitGit's commit: same file bytes, same
  // index.json rewrite (JSON.stringify(…, null, 2) + '\n'), same parents rule, same message — keep `subject`/`message`
  // byte-identical to commitGit's so a definition gets the same commit oid from the phone and from a desktop.
  const subject = `${def.id} ${def.version}: ${String(message || def.name || 'new ' + kind).replace(/[\r\n]+/g, ' ').slice(0, 160)}`;
  const body = JSON.stringify({ rid, ref: `refs/heads/${branch}`, mode: 'definition', base: `refs/heads/${MAIN_BRANCH}`,
    files: { [defPath(kind, def.id)]: JSON.stringify(def, null, 2) + '\n' }, remove: [],
    manifest: { file: 'index.json', key: SUBDIRS[kind], id: def.id, sha256: sha },
    name: team.name, email: `${identity.id}@chaosd6`, timestamp: Math.floor(now().getTime() / 1000),
    message: `${subject}\n\nNew ${kind} by team ${team.name}, authored in the chaosD6 rules editor.\n\nChaosd6-Author: ${identity.id}\nChaosd6-Signature: ${signDefinition(identity.privateKeyPem, def)}\n`,
    seed: OCI_SEED_NID });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60e3);
  try {
    const r = await fetchImpl(`http://127.0.0.1:${vb.bridge.port}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': vb.bridge.token }, body, signal: ctl.signal });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!j?.ok) return { ok: false, commit: null, error: `bridge: ${j?.error || 'unknown error'}` };
    return { ok: true, commit: j.oid || null };
  } catch (e) { return { ok: false, commit: null, error: `bridge: ${e.name === 'AbortError' ? 'timeout' : e.message}` }; }
  finally { clearTimeout(t); }
}

// ------------------------------------------------------------------ entry points
let chain = Promise.resolve();   // one publish at a time per process (shared work repos + status file)
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

/** Commit `def` (already validated by the caller) on players/<team.slug>/<slug> and publish it.
 *  identity = { id, privateKeyPem }, team = { name, slug }. → { ok, ref: { repo, branch, commit, sha256, id }, publish: { state, error? } } */
export function publishDefinition({ kind, def, identity, team, message = '' }, hooks = {}) {
  return serial(async () => {
    if (!KINDS.includes(kind)) throw new Error(`unknown kind ${kind}`);
    if (!identity?.privateKeyPem) throw new Error('no identity key');
    const now = hooks.now || (() => new Date());
    const via = publishVia(hooks);
    const rid = ridOfKind(kind), sha = defSha(def), branch = branchOf(team.slug, kind, def.id);
    const key = `${kind}:${def.id}`;
    const status = loadStatus(hooks);
    const prev = status.defs[key] || {};
    let res;
    if (via === 'bridge') {
      res = await publishBridge({ kind, def, sha, identity, team, message, branch, rid, bridgeFile: hooks.bridgeFile ?? (process.env.CHAOSD6_RADICLE_BRIDGE || ''), fetchImpl: hooks.fetchImpl || globalThis.fetch, now });
    } else {
      const env = toolEnv(hooks.env);
      const radSync = hooks.radSync !== false;
      const nid = hooks.nid ?? (radSync ? await radNid(env) : null);
      const gitdir = path.join(dirOf(hooks), 'editor-defs-git', `${ridBare(rid)}.git`);
      const subject = `${def.id} ${def.version}: ${String(message || def.name || 'new ' + kind).replace(/[\r\n]+/g, ' ').slice(0, 160)}`;
      const body = `${subject}\n\nNew ${kind} by team ${team.name}, authored in the chaosD6 rules editor.\n\nChaosd6-Author: ${identity.id}\nChaosd6-Signature: ${signDefinition(identity.privateKeyPem, def)}\n`;
      res = await commitGit({ files: [{ path: defPath(kind, def.id), text: JSON.stringify(def, null, 2) + '\n' }], manifest: [{ key: SUBDIRS[kind], id: def.id, sha256: sha }],
        subject, body, repoName: REPO_NAMES[kind], identity, team, branch, rid, gitdir, nid, remoteUrlFor: hooks.remoteUrlFor || defaultRemoteUrl, env, now });
      if (res.ok) { const p = await pushGit({ branch, rid, gitdir, radSync, env }); if (!p.ok) res = { ...res, ok: false, error: p.error }; }
    }
    const at = now().toISOString();
    const publish = res.ok ? { state: 'published', via, tries: 0, at } : { state: 'pending', error: res.error, via, tries: (prev.sha256 === sha ? (prev.publish?.tries | 0) : 0) + 1, at };
    const rec = { kind, id: def.id, name: def.name, team: team.name, slug: team.slug, author: identity.id, repo: rid, branch,
      commit: res.commit || (prev.sha256 === sha ? prev.commit || null : null), sha256: sha, def, message: String(message || '').slice(0, 200), at, publish };
    status.defs[key] = rec;
    saveStatus(status, hooks);
    return { ok: true, ref: { repo: rid, branch, commit: rec.commit, sha256: sha, id: def.id }, publish: res.ok ? { state: 'published' } : { state: 'pending', error: res.error } };
  });
}

// ------------------------------------------------------------------ chaosD6-GameModels bundles (2026-11-25)
// A GameModels draft (game/gm-gen.mjs bundle: an NPC + its quests + the village / race it changes, a building, a
// monster) is ONE commit of several files on players/<team-slug>/<bundle-id-slug> of chaosD6-GameModels, every file a
// definition of that repo (<subdir>/<id>.json) + its sha256 in index.json (gamemodels.mjs defHash). The signature
// covers sha256(canonicalJson({ id, files: { <path>: <sha256> } })). Voting on the branch: the same as any player branch.
// Desktop: git + rad as above. Phone: its own Radicle node (bridge feature "gamemodels"), the same commit.
export const GAMEMODELS_RID = DEFAULT_RIDS.gamemodels;   // proposal-votes.mjs (published 2026-11-25; CHAOSD6_GAMEMODELS_RID overrides)
export const GAMEMODELS_REPO_NAME = REPO_NAMES.gamemodels;
export const gmBranchOf = (teamSlug, bundleId) => `${PLAYER_BRANCH_PREFIX}${teamSlug}/${String(bundleId).replace(/_/g, '-')}`;
/** The signed content of a bundle: { id, files: { path: sha256 } } of its definitions (defs = [[subdir, def, sha256]]). */
export const gmSignedOf = (id, defs) => ({ id, files: Object.fromEntries(defs.map(([sub, def, sha]) => [`${sub}/${def.id}.json`, sha]).sort(([a], [b]) => a.localeCompare(b))) });
/** bundle = { id, name, version, kind }, defs = [[subdir, def, sha256]] (the caller: gm-gen bundleDefs + gamemodels KINDS / defHash).
 *  → { ok, ref: { repo, branch, commit, id, sha256 }, publish: { state, error? } } — sha256 = of the signed content. */
export function publishGameModels({ bundle, defs, identity, team, message = '' }, hooks = {}) {
  return serial(async () => {
    if (!identity?.privateKeyPem) throw new Error('no identity key');
    if (!defs?.length) throw new Error('an empty bundle');
    const now = hooks.now || (() => new Date());
    const via = publishVia(hooks);
    const rid = hooks.rid || GAMEMODELS_RID, branch = gmBranchOf(team.slug, bundle.id);
    const signed = gmSignedOf(bundle.id, defs), sha = defSha(signed);
    const key = `gamemodels:${bundle.id}`;
    const status = loadStatus(hooks);
    const prev = status.defs[key] || {};
    let res;
    // The same commit inputs on both paths (files, manifest entries in this order, subject / body) → the same oid.
    const subject = `${bundle.id} ${bundle.version}: ${String(message || bundle.name || `new ${bundle.kind}`).replace(/[\r\n]+/g, ' ').slice(0, 160)}`;
    const list = defs.map(([sub, def]) => `- ${sub}/${def.id}.json (${def.version || ''})`).join('\n');
    const body = `${subject}\n\nA ${bundle.kind} by team ${team.name}, generated in the chaosD6 editor. Files:\n${list}\n\nChaosd6-Author: ${identity.id}\nChaosd6-Signature: ${signDefinition(identity.privateKeyPem, signed)}\n`;
    const files = defs.map(([sub, def]) => ({ path: `${sub}/${def.id}.json`, text: JSON.stringify(def, null, 2) + '\n' }));
    const manifest = defs.map(([sub, def, s]) => ({ key: sub, id: def.id, sha256: s }));
    if (via === 'bridge') {
      // The phone's own Radicle node (user 2026-11-25: the phone publishes by itself): ffi definition_commit with the
      // bridge feature "gamemodels" (the GameModels folders + several manifest entries), announced to the OCI seed.
      res = await publishGmBridge({ rid, branch, files, manifest, body, team, identity, bridgeFile: hooks.bridgeFile ?? (process.env.CHAOSD6_RADICLE_BRIDGE || ''),
        fetchImpl: hooks.fetchImpl || globalThis.fetch, now });
    } else {
      const env = toolEnv(hooks.env);
      const radSync = hooks.radSync !== false;
      const nid = hooks.nid ?? (radSync ? await radNid(env) : null);
      const gitdir = path.join(dirOf(hooks), 'editor-defs-git', `${ridBare(rid)}.git`);
      res = await commitGit({ files, manifest, subject, body, repoName: GAMEMODELS_REPO_NAME,
        identity, team, branch, rid, gitdir, nid, remoteUrlFor: hooks.remoteUrlFor || defaultRemoteUrl, env, now });
      if (res.ok) { const p = await pushGit({ branch, rid, gitdir, radSync, env }); if (!p.ok) res = { ...res, ok: false, error: p.error }; }
    }
    const at = now().toISOString();
    const publish = res.ok ? { state: 'published', via, tries: 0, at } : { state: 'pending', error: res.error, via, tries: (prev.sha256 === sha ? (prev.publish?.tries | 0) : 0) + 1, at };
    status.defs[key] = { kind: 'gamemodels', gm_kind: bundle.kind, id: bundle.id, name: bundle.name, team: team.name, slug: team.slug, author: identity.id, repo: rid, branch,
      commit: res.commit || (prev.sha256 === sha ? prev.commit || null : null), sha256: sha, files: signed.files, defs, version: bundle.version, message: String(message || '').slice(0, 200), at, publish };
    saveStatus(status, hooks);
    return { ok: true, ref: { repo: rid, branch, commit: status.defs[key].commit, sha256: sha, id: bundle.id }, publish: res.ok ? { state: 'published' } : { state: 'pending', error: res.error } };
  });
}

async function publishGmBridge({ rid, branch, files, manifest, body, team, identity, bridgeFile, fetchImpl, now }) {
  const vb = readDefsBridge(bridgeFile);
  if (!vb.bridge) return { ok: false, commit: null, error: vb.error };
  if (!vb.bridge.features.includes('gamemodels')) return { ok: false, commit: null, error: 'phone Radicle node cannot publish GameModels bundles yet (update the app: bridge lacks the "gamemodels" feature)' };
  const req = JSON.stringify({ rid, ref: `refs/heads/${branch}`, mode: 'definition', base: `refs/heads/${MAIN_BRANCH}`,
    files: Object.fromEntries(files.map(f => [f.path, f.text])), remove: [],
    manifest: manifest.map(m => ({ file: 'index.json', ...m })),
    name: team.name, email: `${identity.id}@chaosd6`, timestamp: Math.floor(now().getTime() / 1000), message: body, seed: OCI_SEED_NID });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 90e3);
  try {
    const r = await fetchImpl(`http://127.0.0.1:${vb.bridge.port}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': vb.bridge.token }, body: req, signal: ctl.signal });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!j?.ok) return { ok: false, commit: null, error: `bridge: ${j?.error || 'unknown error'}` };
    return { ok: true, commit: j.oid || null };
  } catch (e) { return { ok: false, commit: null, error: `bridge: ${e.name === 'AbortError' ? 'timeout' : e.message}` }; }
  finally { clearTimeout(t); }
}

/** Re-run the publish of a stored definition (POST definitions/retry). */
export async function retryDefinition({ kind, id, identity, team }, hooks = {}) {
  const rec = loadStatus(hooks).defs[`${kind}:${id}`];
  if (!rec) return { ok: false, error: `no authored ${kind} ${id}` };
  if (rec.slug !== team.slug) return { ok: false, error: `${id} belongs to team ${rec.team}` };
  if (kind === 'gamemodels') return publishGameModels({ bundle: { id: rec.id, name: rec.name, version: rec.version, kind: rec.gm_kind }, defs: rec.defs, identity, team, message: rec.message }, hooks);
  return publishDefinition({ kind, def: rec.def, identity, team, message: rec.message }, hooks);
}
