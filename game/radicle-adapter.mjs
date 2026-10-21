// Radicle adapter. The local bare at game/radicle.git/ is still used as a fast,
// deterministic rendezvous between peers in the same machine (no node round-trip
// per push). When RADICLE_PUSH_REMOTE is set (default on), each successful bare
// push is also mirrored to the project's real Radicle repo via git-remote-rad,
// so remote clients can browse the pushed branch at
//   <RADICLE_EXPLORER_BASE>/nodes/<RADICLE_SEED>/<rid>/commits/<sha>
// Both legs happen from the peer's work tree, so an auth/network hiccup on the
// rad leg does not corrupt the local bare.
//
//   game/radicle.git/                               (bare, local-only)
//     refs/heads/ActiveDimensions/<DimensionName>
//
// Each peer clones into game/radicle-work/<peer_id>/ and pushes/fetches there.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RADICLE_BARE = path.join(__dirname, 'radicle.git');
export const RADICLE_WORK = path.join(__dirname, 'radicle-work');
export const PROJECT_ROOT = path.resolve(__dirname, '..');

// Resolve the real Radicle repo once at module load. If the project root isn't
// a Radicle repo (or `rad` isn't installed), we fall back to local-bare-only
// mode and no explorer URL is emitted — the local /commit/:sha view still works.
const RADICLE_PUSH_REMOTE   = (process.env.RADICLE_PUSH_REMOTE ?? '1') !== '0';
const RADICLE_SEED          = process.env.RADICLE_SEED          || 'rosa.radicle.network';
const RADICLE_EXPLORER_BASE = process.env.RADICLE_EXPLORER_BASE || 'https://radicle.network';
// Default: emit raw explorer URLs (shareable, work from any browser). Setting
// RADICLE_ALIAS=chaosD6 instead routes the broadcast link through the local
// UI server as http://127.0.0.1:<UI_PORT>/r/<alias>/commits/<sha>, which 302s
// to the real explorer URL — pretty, but localhost-only. The /r endpoint
// stays wired either way so manually-typed aliased URLs still redirect.
const RADICLE_ALIAS         = process.env.RADICLE_ALIAS         ?? '';
const UI_PORT_FOR_REDIRECT  = process.env.UI_PORT               || '7357';
const RAD_BIN_DIR           = process.env.RAD_BIN_DIR           || path.join(os.homedir(), '.radicle', 'bin');
const GIT_PATH_WITH_RAD     = `${RAD_BIN_DIR}${path.delimiter}${process.env.PATH || ''}`;

// git-remote-rad signs pushes through ssh-agent. If SSH_AUTH_SOCK isn't in the
// current process env (common when the peer is spawned by a long-lived
// supervisor shell), probe known fallback paths so pushes still work.
async function detectSshAuthSock() {
  if (process.env.SSH_AUTH_SOCK) {
    try { await fs.stat(process.env.SSH_AUTH_SOCK); return process.env.SSH_AUTH_SOCK; } catch {}
  }
  const candidates = [
    path.join(os.homedir(), '.ssh', 'agent.sock'),
    process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'ssh-agent.socket') : null,
  ].filter(Boolean);
  for (const c of candidates) {
    try { await fs.stat(c); return c; } catch {}
  }
  return null;
}
const SSH_AUTH_SOCK = await detectSshAuthSock();

export const radicleEnv = await (async () => {
  if (!RADICLE_PUSH_REMOTE) return { enabled: false, reason: 'disabled via RADICLE_PUSH_REMOTE=0' };
  let rid = process.env.RADICLE_RID || '';
  let pushUrl = process.env.RADICLE_PUSH_URL || '';
  if (!pushUrl) {
    try {
      const { stdout } = await pexec('git', ['-C', PROJECT_ROOT, 'remote', 'get-url', '--push', 'rad'], { windowsHide: true });
      pushUrl = stdout.trim();
    } catch { /* not a rad repo */ }
  }
  if (!rid && pushUrl) {
    const m = pushUrl.match(/^rad:\/\/([^/]+)/);
    if (m) rid = m[1];
  }
  if (!rid) return { enabled: false, reason: 'no rad remote on project root (set RADICLE_RID to override)' };
  // Push needs the full rad://<RID>/<NID> form — pushing to the bare rad://<RID>
  // is rejected with "no public key given as a remote namespace".
  if (!/^rad:\/\/[^/]+\/[^/]+/.test(pushUrl)) {
    return { enabled: false, reason: `rad remote push URL missing NID suffix (got "${pushUrl}"); set RADICLE_PUSH_URL=rad://<RID>/<NID>` };
  }
  try {
    const st = await fs.stat(path.join(RAD_BIN_DIR, 'git-remote-rad'));
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    return { enabled: false, reason: `git-remote-rad not found at ${RAD_BIN_DIR}` };
  }
  const explorerBase = RADICLE_EXPLORER_BASE.replace(/\/+$/, '');
  // Explorer expects an URL-encoded colon between "rad" and the RID body.
  const ridInUrl = `rad%3A${rid}`;
  const rawCommitUrl = sha => `${explorerBase}/nodes/${RADICLE_SEED}/${ridInUrl}/commits/${sha}`;
  const rawTreeUrl   = (sha, pathIn = '') => `${explorerBase}/nodes/${RADICLE_SEED}/${ridInUrl}/tree/${sha}${pathIn ? '/' + pathIn.replace(/^\/+/, '') : ''}`;
  const alias = (RADICLE_ALIAS || '').trim();
  const makePretty = (kind, sha, pathIn = '') => {
    if (!alias) return kind === 'tree' ? rawTreeUrl(sha, pathIn) : rawCommitUrl(sha);
    const tail = kind === 'tree' ? `tree/${sha}${pathIn ? '/' + pathIn.replace(/^\/+/, '') : ''}` : `commits/${sha}`;
    return `http://127.0.0.1:${UI_PORT_FOR_REDIRECT}/r/${encodeURIComponent(alias)}/${tail}`;
  };
  return {
    enabled: true,
    rid,
    nid: pushUrl.split('/')[3] || null,
    alias: alias || null,
    remoteUrl: pushUrl,
    explorerBase,
    seed: RADICLE_SEED,
    commitUrl: sha => makePretty('commits', sha),
    treeUrl:   (sha, pathIn = '') => makePretty('tree', sha, pathIn),
    rawCommitUrl,
    rawTreeUrl,
  };
})();

if (!radicleEnv.enabled) {
  console.warn(`[radicle] remote push disabled (${radicleEnv.reason}); pushes stay on local bare only`);
} else {
  console.log(`[radicle] remote push → ${radicleEnv.remoteUrl} via git-remote-rad; explorer base ${radicleEnv.explorerBase}`);
}

async function git(args, cwd) {
  const { stdout } = await pexec('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

// If a previous run was SIGKILL'd mid-push, the bare's ref files can end up
// pointing to objects that were never fully transferred. Future clones then
// fail with "cannot update ref 'refs/heads/main': trying to write ref … with
// nonexistent object X". fsck catches that cheaply; on failure we rebuild the
// bare from scratch (and clear the per-peer work trees so they re-clone).
async function fsckBare() {
  try {
    await pexec('git', ['--git-dir', RADICLE_BARE, 'fsck', '--connectivity-only', '--no-dangling'], { windowsHide: true });
    return true;
  } catch { return false; }
}

export async function ensureBare() {
  let exists = false;
  try { await fs.access(RADICLE_BARE); exists = true; } catch {}
  if (exists && !(await fsckBare())) {
    console.warn(`[radicle] bare repo at ${RADICLE_BARE} failed fsck — rebuilding`);
    await fs.rm(RADICLE_BARE, { recursive: true, force: true });
    await fs.rm(RADICLE_WORK, { recursive: true, force: true });
    exists = false;
  }
  if (exists) return;
  await fs.mkdir(RADICLE_BARE, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main'], RADICLE_BARE);
  console.log(`[radicle] bare repo at ${RADICLE_BARE}`);
}

function safePeerDir(peerId) { return peerId.replace(/[:/\\]/g, '-'); }

async function ensureRadRemote(dir) {
  if (!radicleEnv.enabled) return;
  try {
    const { stdout } = await pexec('git', ['-C', dir, 'remote', 'get-url', 'rad'], { windowsHide: true });
    if (stdout.trim() === radicleEnv.remoteUrl) return;
    await pexec('git', ['-C', dir, 'remote', 'set-url', 'rad', radicleEnv.remoteUrl], { windowsHide: true });
  } catch {
    await pexec('git', ['-C', dir, 'remote', 'add', 'rad', radicleEnv.remoteUrl], { windowsHide: true });
  }
}

export async function ensureWorkTree(peerId) {
  const dir = path.join(RADICLE_WORK, safePeerDir(peerId));
  try { await fs.access(path.join(dir, '.git')); await ensureRadRemote(dir); return dir; }
  catch { /* clone */ }
  await fs.mkdir(RADICLE_WORK, { recursive: true });
  // --initial-branch so an empty bare repo clones cleanly.
  await pexec('git', ['clone', '--origin', 'radicle', RADICLE_BARE, dir], { windowsHide: true });
  await git(['config', 'user.email', `${peerId}@chaosd6.local`], dir);
  await git(['config', 'user.name', peerId], dir);
  // Seed main so later checkouts have something to switch away from.
  try { await git(['commit', '--allow-empty', '-m', `init ${peerId}`], dir); await git(['push', 'radicle', 'main'], dir); } catch {}
  await ensureRadRemote(dir);
  return dir;
}

// Push the branch to the real Radicle repo via git-remote-rad. Scoped to its
// own call so failures (unauth, offline, slow sync) don't break the local-bare
// leg — they only disable the explorer URL for this push.
async function pushToRadicle(dir, branch) {
  if (!radicleEnv.enabled) return { published: false, reason: radicleEnv.reason };
  if (!SSH_AUTH_SOCK) return { published: false, reason: 'no ssh-agent socket found (SSH_AUTH_SOCK unset and no fallback at ~/.ssh/agent.sock); run `rad auth` or export SSH_AUTH_SOCK before launching' };
  try {
    const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
    const { stdout, stderr } = await pexec('git', ['-C', dir, 'push', 'rad', refspec], {
      windowsHide: true,
      env: { ...process.env, PATH: GIT_PATH_WITH_RAD, SSH_AUTH_SOCK },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { published: true, info: (stdout + stderr).trim() };
  } catch (e) {
    return { published: false, reason: (e.stderr || e.message || '').toString().split('\n').slice(0, 3).join(' | ').slice(0, 400) };
  }
}

// Rebuild the per-peer worktree branch on the bare repo's current tip. The
// worktree content is regenerated from scratch on every push, so any local
// history that diverged (another peer in this same clone pushed in between)
// is worthless — resetting onto the remote tip is always right and is what
// stops the "non-fast-forward" rejections two peers used to trade.
async function resetBranchToBare(dir, branch) {
  let tip = null;
  try { await git(['fetch', '--quiet', 'radicle', `+refs/heads/${branch}:refs/remotes/radicle/${branch}`], dir); tip = (await git(['rev-parse', `refs/remotes/radicle/${branch}`], dir)).trim(); } catch {}
  if (tip) {
    try { await git(['checkout', '-q', '-B', branch, tip], dir); } catch { await git(['checkout', '-q', '-B', branch], dir); await git(['reset', '--hard', tip], dir); }
  } else {
    try { await git(['checkout', '-q', branch], dir); } catch { await git(['checkout', '-q', '-b', branch], dir); }
  }
}

export async function pushDimension(peerId, dimensionName, filesByRelPath, removeRelPaths = []) {
  const dir = await ensureWorkTree(peerId);
  const branch = `ActiveDimensions/${dimensionName}`;
  let pushedLocal = false;
  for (let attempt = 0; attempt < 2 && !pushedLocal; attempt++) {
    await resetBranchToBare(dir, branch);
    for (const [rel, content] of Object.entries(filesByRelPath)) {
      const abs = path.join(dir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
    for (const rel of removeRelPaths) { try { await fs.rm(path.join(dir, rel), { force: true }); } catch {} }
    await git(['add', '-A'], dir);
    let changes = '';
    try { changes = await git(['status', '--porcelain'], dir); } catch {}
    if (!changes.trim()) return { pushed: false, reason: 'no-changes' };
    const stamp = new Date().toISOString();
    await git(['commit', '-q', '-m', `[${peerId}] push ${dimensionName} @ ${stamp}`], dir);
    try { await git(['push', '--quiet', 'radicle', branch], dir); pushedLocal = true; }
    catch (e) {
      // Lost a race with a sibling peer in this clone — rebuild on its tip once.
      if (attempt === 0 && /non-fast-forward|fetch first|rejected/.test(String(e.stderr || e.message))) continue;
      throw e;
    }
  }
  const head = (await git(['rev-parse', 'HEAD'], dir)).trim();
  const remote = await pushToRadicle(dir, branch);
  const published = remote.published && radicleEnv.enabled;
  const explorerUrl = published ? radicleEnv.commitUrl(head) : null;
  // Point the tree link at the pushed branch's content root. Using the commit
  // SHA (rather than the branch name) keeps the URL stable even if we later
  // rewrite the branch, and sidesteps slash-encoding in the branch path.
  const treeUrl = published ? radicleEnv.treeUrl(head, `ActiveDimensions/${dimensionName}`) : null;
  return { pushed: true, commit: head, branch, remote, explorerUrl, treeUrl };
}

export async function fetchDimension(peerId, dimensionName) {
  const dir = await ensureWorkTree(peerId);
  const branch = `ActiveDimensions/${dimensionName}`;
  try {
    await git(['fetch', 'radicle', branch], dir);
    await git(['checkout', branch], dir);
    try { await git(['pull', '--ff-only', 'radicle', branch], dir); } catch {}
    const head = await git(['rev-parse', 'HEAD'], dir);
    return { present: true, commit: head, work_dir: dir };
  } catch {
    return { present: false };
  }
}

// Where this node's Radicle storage keeps the repo: every namespace the seeds
// replicate to us lives there as refs/namespaces/<NID>/refs/heads/...
async function radStorageDir() {
  const radEnv = { ...process.env, PATH: GIT_PATH_WITH_RAD };
  const radBin = path.join(RAD_BIN_DIR, 'rad');
  let home = process.env.RAD_HOME || '';
  if (!home) { try { home = (await pexec(radBin, ['path'], { windowsHide: true, env: radEnv })).stdout.trim(); } catch {} }
  if (!home) home = path.join(process.env.HOME || '', '.radicle');
  return path.join(home, 'storage', radicleEnv.rid);
}

// Pull the latest refs for every namespace from the seeds (best effort, bounded).
export async function syncFromSeeds(timeoutSec = 10) {
  if (!radicleEnv.enabled) return false;
  const radEnv = { ...process.env, PATH: GIT_PATH_WITH_RAD };
  const radBin = path.join(RAD_BIN_DIR, 'rad');
  try { await pexec(radBin, ['sync', '--fetch', '--timeout', String(timeoutSec), `rad:${radicleEnv.rid}`], { cwd: PROJECT_ROOT, windowsHide: true, env: radEnv, timeout: (timeoutSec + 5) * 1000 }); return true; }
  catch (e) { console.warn(`[radicle] sync from seeds: ${(e.stderr || e.message).toString().split('\n')[0].slice(0, 160)}`); return false; }
}

// Read every ActiveDimensions/* branch in every namespace of the repo — not
// just the delegates'. Each player publishes their own *Door* into a dimension
// (doors/<peer>.json, door_version 2 — their piece of the puzzle) in their own
// namespace; this unions them. Returns
//   [{ dimension_name, dimension_id, dimension, doors: [{...door, nid, ref, commit}], namespaces: [nid], legacy_doors: [...] }]
// grouped by dimension name. legacy_doors carries the old host-written
// door-primary docs so old branches still show up (as history, never as live).
export async function listPublishedDimensions({ sync = true } = {}) {
  if (!radicleEnv.enabled) throw new Error(radicleEnv.reason);
  if (sync) await syncFromSeeds(8);
  const storage = await radStorageDir();
  let refs = '';
  try { refs = (await pexec('git', ['-C', storage, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/namespaces/*/refs/heads/ActiveDimensions/*'], { windowsHide: true })).stdout; }
  catch (e) { throw new Error(`cannot read radicle storage at ${storage}: ${(e.stderr || e.message).toString().split('\n')[0]}`); }

  const byName = new Map();
  for (const line of refs.split('\n').filter(Boolean)) {
    const [ref, commit] = line.split(' ');
    const m = ref.match(/^refs\/namespaces\/([^/]+)\/refs\/heads\/ActiveDimensions\/(.+)$/);
    if (!m) continue;
    const [, nid, dimensionName] = m;
    const base = `ActiveDimensions/${dimensionName}`;
    const show = async (rel) => JSON.parse((await pexec('git', ['-C', storage, 'show', `${ref}:${base}/${rel}`], { windowsHide: true })).stdout);
    const list = async (rel) => { try { return (await pexec('git', ['-C', storage, 'ls-tree', '--name-only', `${ref}:${base}/${rel}`], { windowsHide: true })).stdout.split('\n').filter(f => f.endsWith('.json')); } catch { return []; } };
    let dimension;
    try { dimension = await show('dimension.json'); } catch { continue; }
    const entry = byName.get(dimensionName) || { dimension_name: dimensionName, dimension_id: dimension.dimension_id || null, dimension, doors: [], namespaces: [], legacy_doors: [] };
    if (!entry.dimension_id && dimension.dimension_id) { entry.dimension_id = dimension.dimension_id; entry.dimension = dimension; }
    entry.namespaces.push(nid);
    for (const f of await list('doors')) {
      try {
        const doc = { ...(await show(`doors/${f}`)), nid, ref, commit };
        if (doc.door_version >= 2 && doc.peer_id) entry.doors.push(doc); else entry.legacy_doors.push(doc);
      } catch {}
    }
    byName.set(dimensionName, entry);
  }
  // Newest Door first within a dimension; dimensions with the freshest Door first.
  const out = [...byName.values()];
  for (const d of out) d.doors.sort((a, b) => Date.parse(b.pushed_at || 0) - Date.parse(a.pushed_at || 0));
  out.sort((a, b) => Date.parse(b.doors[0]?.pushed_at || b.legacy_doors[0]?.last_push?.at || 0) - Date.parse(a.doors[0]?.pushed_at || a.legacy_doors[0]?.last_push?.at || 0));
  return out;
}

// Elect the hourly pusher. Deterministic lottery per spec:
//   pusher = member with min( sha256(peer_id + hashgraph_head + interval_index) )
import { createHash } from 'node:crypto';
export function electPusher(peers, hashgraphHead, intervalIndex) {
  const scored = peers.map(p => {
    const h = createHash('sha256').update(`${p}|${hashgraphHead}|${intervalIndex}`).digest('hex');
    return { peer: p, score: h };
  });
  scored.sort((a, b) => a.score < b.score ? -1 : 1);
  return scored[0].peer;
}

// CLI entry: `node radicle-adapter.mjs init`
if (process.argv[1] && (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('radicle-adapter.mjs'))) {
  const cmd = process.argv[2];
  if (cmd === 'init') {
    await ensureBare();
    console.log('ok');
  } else if (cmd === 'push' && process.argv[3] && process.argv[4]) {
    const r = await pushDimension(process.argv[3], process.argv[4], { 'ping.txt': `pinged at ${new Date().toISOString()}\n` });
    console.log(r);
  } else {
    console.log('usage: node radicle-adapter.mjs init | push <peer_id> <dimension_name>');
  }
}
