// Radicle adapter. The local bare at game/radicle.git/ is still used as a fast,
// deterministic rendezvous between peers in the same machine (no node round-trip
// per push). When RADICLE_PUSH_REMOTE is set (default on), each successful bare
// push is also mirrored to the project's real Radicle repo via git-remote-rad.
// By default the adapter does NOT emit any public-mesh explorer URL — the
// Radicle network stays private to whichever peers hold the RID. Opt in by
// setting RADICLE_EXPLORER_BASE + RADICLE_SEED to a web explorer that
// replicates your project, and pushDimension() will then return
//   <RADICLE_EXPLORER_BASE>/nodes/<RADICLE_SEED>/<rid>/commits/<sha>
// as a clickable link. Both legs happen from the peer's work tree, so an
// auth/network hiccup on the rad leg does not corrupt the local bare.
//
//   game/radicle.git/                               (bare, local-only)
//     refs/heads/ActiveDimensions/<DimensionName>
//
// Each peer clones into game/radicle-work/<peer_id>/ and pushes/fetches there.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { publishDimensionPush, publishSeedPresence, seedsEnabled } from './local-seeds.mjs';

const pexec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// CHAOSD6_RADICLE_BARE / CHAOSD6_RADICLE_WORK: test launchers only (a temp bare + work dir).
export const RADICLE_BARE = process.env.CHAOSD6_RADICLE_BARE || path.join(__dirname, 'radicle.git');
export const RADICLE_WORK = process.env.CHAOSD6_RADICLE_WORK || path.join(__dirname, 'radicle-work');
export const PROJECT_ROOT = path.resolve(__dirname, '..');

// Mobile peers (nodejs-mobile inside the Android APK) have no git / rad /
// ssh-agent / radicle-node available: all of this module's exec paths would
// crash with ENOENT or do pointless work. Short-circuit to a disabled env so
// pushDimension / listPublishedDimensions / syncFromSeeds behave as no-ops and
// the module-load-time side effects (OCI connect, presence publish, startup
// sync) all skip. The desktop peer in the swarm is responsible for radicle
// writes. Set CHAOSD6_MOBILE=1 to activate.
const IS_MOBILE = process.env.CHAOSD6_MOBILE === '1';

// Resolve the real Radicle repo once at module load. If the project root isn't
// a Radicle repo (or `rad` isn't installed), we fall back to local-bare-only
// mode and no explorer URL is emitted — the local /commit/:sha view still works.
// RADICLE_SEED + RADICLE_EXPLORER_BASE default to empty so the adapter never
// advertises a public mesh host in its logs. Set them explicitly if (and only
// if) you want pushDimension() to return a clickable "explorer" link for a
// third-party viewer. The local-bare /commit/<sha> view in ui-server.mjs is
// unaffected either way.
const RADICLE_PUSH_REMOTE   = (process.env.RADICLE_PUSH_REMOTE ?? '1') !== '0';
// Defaults point at the project's Firebase-hosted Radicle Explorer deployment
// (static Svelte SPA at firebase/public/radicle, served from Hosting). The SPA
// talks to the OCI seed below for data — a public read-only radicle-httpd that
// anyone (phone, laptop, etc.) can reach without exposing the dev-PC. Local
// dev with no OCI is still fine: set RADICLE_SEED=localhost to generate
// loopback explorer URLs again.
const RADICLE_SEED          = process.env.RADICLE_SEED          || '92-5-138-121.sslip.io';
const RADICLE_EXPLORER_BASE = process.env.RADICLE_EXPLORER_BASE || 'https://dimensions-4e9ae.web.app';
// Dev-PC → OCI gossip link. If both are set at boot we `rad node connect` to
// the OCI seed so this peer's pushes gossip uphill (and incoming branches
// gossip back down) over one outbound TCP from the dev PC. No inbound port
// on the home network is required. Leave either unset to skip.
// NID below is the chaosD6 OCI seed deployed at 92-5-138-121.sslip.io; override
// via env for a different deployment.
const OCI_SEED_NID  = process.env.OCI_SEED_NID  || 'z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT';
const OCI_SEED_ADDR = process.env.OCI_SEED_ADDR || (RADICLE_SEED && RADICLE_SEED !== 'localhost' ? `${RADICLE_SEED}:8776` : '');
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

// Build a Radicle-env object for a given RID/push-URL pair. We call this twice
// so dim-branch pushes (`ActiveDimensions/*`) can land on a dedicated RID
// (`RADICLE_DIMS_RID`) while code-side commit/tree links still resolve against
// the main chaosD6 code repo (`RADICLE_RID`). Prefix is the env-var namespace;
// the second argument is a shared fallback so the dims env, if unconfigured,
// transparently falls back to the code env (= current single-RID behaviour).
async function buildEnv(prefix, fallback = null) {
  if (IS_MOBILE) return { enabled: false, reason: 'mobile peer — radicle disabled' };
  if (!RADICLE_PUSH_REMOTE) return { enabled: false, reason: 'disabled via RADICLE_PUSH_REMOTE=0' };
  let rid = process.env[`${prefix}RID`] || '';
  let pushUrl = process.env[`${prefix}PUSH_URL`] || '';
  // For the code env (prefix "RADICLE_"), fall back to the project's own rad
  // remote. The dims env has no project-root remote to probe — if its vars are
  // unset we return a special `fallback` marker handled by the caller.
  if (!pushUrl && prefix === 'RADICLE_') {
    try {
      const { stdout } = await pexec('git', ['-C', PROJECT_ROOT, 'remote', 'get-url', '--push', 'rad'], { windowsHide: true });
      pushUrl = stdout.trim();
    } catch { /* not a rad repo */ }
  }
  if (!rid && pushUrl) {
    const m = pushUrl.match(/^rad:\/\/([^/]+)/);
    if (m) rid = m[1];
  }
  if (!rid) {
    if (fallback) return { ...fallback, inherited: true };
    return { enabled: false, reason: `no ${prefix}RID set and no rad remote on project root` };
  }
  // Push needs the full rad://<RID>/<NID> form — pushing to the bare rad://<RID>
  // is rejected with "no public key given as a remote namespace". For the dims
  // env, we also accept an auto-derivation: if only RADICLE_DIMS_RID is set,
  // reuse the code env's NID suffix to build the push URL.
  if (!/^rad:\/\/[^/]+\/[^/]+/.test(pushUrl)) {
    if (fallback && fallback.enabled && fallback.nid) {
      pushUrl = `rad://${rid}/${fallback.nid}`;
    } else {
      return { enabled: false, reason: `rad remote push URL missing NID suffix (got "${pushUrl}"); set ${prefix}PUSH_URL=rad://<RID>/<NID>` };
    }
  }
  try {
    const st = await fs.stat(path.join(RAD_BIN_DIR, 'git-remote-rad'));
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    return { enabled: false, reason: `git-remote-rad not found at ${RAD_BIN_DIR}` };
  }
  const explorerBase = RADICLE_EXPLORER_BASE.replace(/\/+$/, '');
  const ridInUrl = `rad:${rid}`;
  const hasPublicExplorer = !!(explorerBase && RADICLE_SEED);
  const rawCommitUrl = sha => hasPublicExplorer ? `${explorerBase}/nodes/${RADICLE_SEED}/${ridInUrl}/commits/${sha}` : null;
  const rawTreeUrl   = (sha, pathIn = '') => hasPublicExplorer ? `${explorerBase}/nodes/${RADICLE_SEED}/${ridInUrl}/tree/${sha}${pathIn ? '/' + pathIn.replace(/^\/+/, '') : ''}` : null;
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
}

export const radicleEnv = await buildEnv('RADICLE_');
// Dedicated env for ActiveDimensions/* branch pushes. Set RADICLE_DIMS_RID
// (and optionally RADICLE_DIMS_PUSH_URL) to land dim branches on a separate
// Radicle repo — the one mobile peers shallow-fetch for the launcher's
// "Active dimensions" list. If unset, inherits the code env so existing
// single-RID deployments behave exactly as before.
export const dimsEnv = await buildEnv('RADICLE_DIMS_', radicleEnv);

if (!radicleEnv.enabled) {
  console.warn(`[radicle] remote push disabled (${radicleEnv.reason}); pushes stay on local bare only`);
} else {
  const explorerTail = radicleEnv.explorerBase ? `; explorer base ${radicleEnv.explorerBase}` : ` (private mesh — no public explorer base)`;
  console.log(`[radicle] remote push → ${radicleEnv.remoteUrl} via git-remote-rad${explorerTail}`);
  if (dimsEnv.enabled) {
    if (dimsEnv.rid !== radicleEnv.rid) {
      console.log(`[radicle] ActiveDimensions/* → ${dimsEnv.remoteUrl} (separate dims repo rad:${dimsEnv.rid.slice(0, 10)}…)`);
    } else if (dimsEnv.inherited) {
      console.log(`[radicle] ActiveDimensions/* → ${radicleEnv.remoteUrl} (dims repo inherits code RID — set RADICLE_DIMS_RID to split)`);
    }
  }
  // One-shot `rad node connect` to the OCI seed when both env vars are set.
  // The connection is kept alive by rad node, so a single dial is enough —
  // pushes gossip to OCI over this socket. Failures are logged and swallowed:
  // the dev-PC still works offline, just without the OCI mirror.
  if (OCI_SEED_NID && OCI_SEED_ADDR) {
    (async () => {
      try {
        const radBin = path.join(RAD_BIN_DIR, 'rad');
        const radEnv = { ...process.env, PATH: GIT_PATH_WITH_RAD };
        await pexec(radBin, ['node', 'connect', `${OCI_SEED_NID}@${OCI_SEED_ADDR}`], { windowsHide: true, env: radEnv, timeout: 5000 });
        console.log(`[radicle] connected to OCI seed ${OCI_SEED_NID.slice(0, 10)}… @ ${OCI_SEED_ADDR}`);
      } catch (e) {
        console.warn(`[radicle] OCI seed connect failed (${OCI_SEED_ADDR}): ${(e.stderr || e.message || '').toString().split('\n')[0].slice(0, 160)}`);
      }
    })();
  }
  // One-shot presence publish so this peer appears in the Firebase registry
  // immediately, even before the first dimension push. RADICLE_PUBLIC_ADDR
  // ("ip.ip.ip.ip:8776" — your box's reachable rad node listen) is what makes
  // this peer qualify as a priority seed; without it the row still shows up
  // in the explorer but fetchSeeds({requireAddr:true}) skips it.
  const bootAddr = process.env.RADICLE_PUBLIC_ADDR || '';
  publishSeedPresence({
    nid: radicleEnv.nid, rid: `rad:${radicleEnv.rid}`,
    alias: process.env.PEER_LABEL || process.env.USER || radicleEnv.nid.slice(0, 10),
    radicleAddr: bootAddr,
  }).then(r => {
    if (r?.ok)      console.log(`[radicle] presence registered${bootAddr ? ` as ${bootAddr}` : ' (no public addr — set RADICLE_PUBLIC_ADDR to become a priority seed)'}`);
    else if (r?.reason) console.warn(`[radicle] presence publish: ${r.reason.split('\n')[0].slice(0, 200)}`);
  }).catch(() => {});
}

// Every git call made for a per-peer worktree is fenced with
// GIT_CEILING_DIRECTORIES = RADICLE_WORK. If the worktree's .git is missing or
// hollow (a sibling launcher's fsck-rebuild rm'd it while we were live), git
// would otherwise walk up the parents and happily operate on the *source
// checkout* — which is how ~/repo_radicle/chaosD6 got checked out onto
// ActiveDimensions/* branches and lost its working tree. With the ceiling set
// discovery stops at RADICLE_WORK and the call fails loudly instead.
const FENCED_ENV = { ...process.env, GIT_CEILING_DIRECTORIES: RADICLE_WORK };
async function git(args, cwd) {
  const { stdout } = await pexec('git', args, { cwd, windowsHide: true, env: FENCED_ENV });
  return stdout.trim();
}

// A worktree is only trusted when git itself says its top level IS that dir.
async function isValidWorkTree(dir) {
  try {
    const top = await git(['rev-parse', '--show-toplevel'], dir);
    return path.resolve(top) === path.resolve(dir);
  } catch { return false; }
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
  // The worktree's `rad` remote drives both the branch push and the fetch in
  // resetBranchToBare, and every push through pushDimension lands on an
  // ActiveDimensions/* branch — so this remote must point at the DIMS env
  // (which falls back to the code env when RADICLE_DIMS_RID is unset).
  if (!dimsEnv.enabled) return;
  try {
    const { stdout } = await pexec('git', ['-C', dir, 'remote', 'get-url', 'rad'], { windowsHide: true, env: FENCED_ENV });
    if (stdout.trim() === dimsEnv.remoteUrl) return;
    await pexec('git', ['-C', dir, 'remote', 'set-url', 'rad', dimsEnv.remoteUrl], { windowsHide: true, env: FENCED_ENV });
  } catch {
    await pexec('git', ['-C', dir, 'remote', 'add', 'rad', dimsEnv.remoteUrl], { windowsHide: true, env: FENCED_ENV });
  }
}

export async function ensureWorkTree(peerId) {
  const dir = path.join(RADICLE_WORK, safePeerDir(peerId));
  // fs.access(.git) is not enough: a half-deleted .git (only logs/ and refs/
  // left behind by a concurrent rm) passes it, and git then discovers the
  // enclosing source repo. Ask git which repo it would use and re-clone unless
  // the answer is this very directory.
  if (await isValidWorkTree(dir)) { await ensureRadRemote(dir); return dir; }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(RADICLE_WORK, { recursive: true });
  // --initial-branch so an empty bare repo clones cleanly.
  await pexec('git', ['clone', '--origin', 'radicle', RADICLE_BARE, dir], { windowsHide: true, env: FENCED_ENV });
  if (!(await isValidWorkTree(dir))) throw new Error(`[radicle] ${dir} is not a standalone worktree after clone — refusing to run git here`);
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
  // The only caller is pushDimension — every branch here is ActiveDimensions/*
  // and must land on dimsEnv (which transparently falls back to codeEnv when
  // RADICLE_DIMS_RID is unset).
  if (!dimsEnv.enabled) return { published: false, reason: dimsEnv.reason };
  if (!SSH_AUTH_SOCK) return { published: false, reason: 'no ssh-agent socket found (SSH_AUTH_SOCK unset and no fallback at ~/.ssh/agent.sock); run `rad auth` or export SSH_AUTH_SOCK before launching' };
  try {
    const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
    const { stdout, stderr } = await pexec('git', ['-C', dir, 'push', 'rad', refspec], {
      windowsHide: true,
      env: { ...FENCED_ENV, PATH: GIT_PATH_WITH_RAD, SSH_AUTH_SOCK },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { published: true, info: (stdout + stderr).trim() };
  } catch (e) {
    return { published: false, reason: (e.stderr || e.message || '').toString().split('\n').slice(0, 3).join(' | ').slice(0, 400) };
  }
}

// Rebuild the per-peer worktree branch on the latest tip we can see. The
// worktree content is regenerated from scratch on every push, so any local
// history that diverged (another peer in this same clone pushed in between)
// is worthless — resetting onto the newest known tip is always right and is
// what stops the "non-fast-forward" rejections sibling peers used to trade.
//
// Two sources are consulted: the local bare (always), and the rad remote (if
// enabled). We pick whichever side is strictly ahead so the next commit builds
// on it; if neither is reachable, we just stay on the current branch.
async function resetBranchToBare(dir, branch) {
  const tips = [];
  try {
    await git(['fetch', '--quiet', 'radicle', `+refs/heads/${branch}:refs/remotes/radicle/${branch}`], dir);
    tips.push((await git(['rev-parse', `refs/remotes/radicle/${branch}`], dir)).trim());
  } catch {}
  // Fetch the dim branch from the dims remote so we rebuild on its tip.
  if (dimsEnv.enabled && SSH_AUTH_SOCK) {
    try {
      await pexec('git', ['-C', dir, 'fetch', '--quiet', 'rad', `+refs/heads/${branch}:refs/remotes/rad/${branch}`], {
        windowsHide: true,
        env: { ...FENCED_ENV, PATH: GIT_PATH_WITH_RAD, SSH_AUTH_SOCK },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000,
      });
      tips.push((await git(['rev-parse', `refs/remotes/rad/${branch}`], dir)).trim());
    } catch {}
  }
  let tip = tips[0] || null;
  for (const t of tips.slice(1)) {
    if (!t || t === tip) continue;
    try {
      const base = (await git(['merge-base', tip, t], dir)).trim();
      if (base === tip) tip = t;
    } catch {}
  }
  if (tip) {
    try { await git(['checkout', '-q', '-B', branch, tip], dir); } catch { await git(['checkout', '-q', '-B', branch], dir); await git(['reset', '--hard', tip], dir); }
  } else {
    try { await git(['checkout', '-q', branch], dir); } catch { await git(['checkout', '-q', '-b', branch], dir); }
  }
}

// The one place the dim branch name is built — desktop work-tree push, mobile
// bridge publish and fetchDimension all agree on it.
export const dimensionBranch = dimensionName => `ActiveDimensions/${dimensionName}`;

// A dimension name has to be ONE valid git ref component (it becomes
// refs/heads/ActiveDimensions/<Name> and the ActiveDimensions/<Name>/ folder).
// Names come from free text in the launcher (ui-server trims, nothing more), so
// the mobile path checks them against git-check-ref-format before handing them
// to the node. (The desktop path is left as it was: git itself rejects bad refs.)
export function isValidDimensionName(name) {
  if (typeof name !== 'string' || !name || name.length > 200) return false;
  if (/[\x00-\x20\x7f~^:?*[\\/]/.test(name)) return false;    // control chars, space, git specials, slashes
  if (name.includes('..') || name.includes('@{') || name === '@') return false;
  if (name.startsWith('.') || name.endsWith('.') || name.endsWith('.lock')) return false;
  return true;
}

// ---- Mobile publish through the in-app Radicle node (phone bridge) ----
// CHAOSD6_RADICLE_BRIDGE = path of bridge.json { port, token, nid, features }
// written by the node while it runs. A bridge without "publish" in `features`
// (older node) means "not supported" — the mobile peer then stays silent.
const MOBILE_DIMS_RID = (() => {
  const r = process.env.RADICLE_DIMS_RID || 'rad:z2xbfJfwT3kukR73m8LXmmuvchEwr';
  return r.startsWith('rad:') ? r : `rad:${r}`;
})();
const BRIDGE_PUBLISH_TIMEOUT_MS = Number(process.env.RADICLE_BRIDGE_PUBLISH_TIMEOUT_MS || 60000);
const BRIDGE_MAX_BODY = 8 * 1024 * 1024;

export function readPublishBridge(file = process.env.CHAOSD6_RADICLE_BRIDGE || '') {
  if (!file) return null;
  let b;
  try { b = JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch { return null; }
  if (!b || !b.port || !b.token) return null;
  if (!Array.isArray(b.features) || !b.features.includes('publish')) return null;
  return b;
}

// Mobile: the dims publisher when this phone can publish, else null. Re-read on
// every call — the node may come up (or go away) after the peer started.
export function mobileDimsPublisher() {
  if (!IS_MOBILE) return null;
  const bridge = readPublishBridge();
  return bridge ? { rid: MOBILE_DIMS_RID, nid: bridge.nid || null, bridge } : null;
}

// What a Door advertises as radicle.repo / radicle.namespace. Desktop: exactly
// what peer.mjs computed from dimsEnv before. Mobile: the dims RID + the
// node's NID when the bridge can publish, else the old local-bare/null.
export function dimsIdentity() {
  if (IS_MOBILE) {
    const p = mobileDimsPublisher();
    return p ? { repo: p.rid, namespace: p.nid } : { repo: 'rad:local-bare', namespace: null };
  }
  return { repo: dimsEnv.enabled ? `rad:${dimsEnv.rid}` : 'rad:local-bare', namespace: dimsEnv.enabled ? dimsEnv.nid : null };
}

// Repo-relative path under ActiveDimensions/<Name>/: no absolute paths, no
// backslashes, no empty / "." / ".." segments.
function validDimPath(rel, dimensionName) {
  if (typeof rel !== 'string' || !rel.startsWith(`${dimensionBranch(dimensionName)}/`)) return false;
  if (rel.includes('\\') || /[\x00-\x1f\x7f]/.test(rel)) return false;
  return rel.split('/').every(s => s && s !== '.' && s !== '..');
}

async function pushDimensionViaBridge(peerId, dimensionName, filesByRelPath, removeRelPaths, publisher) {
  if (!isValidDimensionName(dimensionName)) return { pushed: false, reason: `invalid-dimension-name: ${JSON.stringify(dimensionName)}` };
  const branch = dimensionBranch(dimensionName);
  const files = {};
  for (const [rel, content] of Object.entries(filesByRelPath || {})) {
    if (!validDimPath(rel, dimensionName)) return { pushed: false, reason: `invalid-path: ${rel}` };
    files[rel] = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  }
  const remove = [];
  for (const rel of removeRelPaths || []) {
    if (!validDimPath(rel, dimensionName)) return { pushed: false, reason: `invalid-path: ${rel}` };
    remove.push(rel);
  }
  const stamp = new Date();
  const body = JSON.stringify({
    rid: publisher.rid, ref: `refs/heads/${branch}`, files, remove, prune_prefix: 'ActiveDimensions/',
    name: peerId, email: `${peerId}@chaosd6.local`, timestamp: Math.floor(stamp.getTime() / 1000),
    message: `[${peerId}] push ${dimensionName} @ ${stamp.toISOString()}`, seed: OCI_SEED_NID,
  });
  if (Buffer.byteLength(body) > BRIDGE_MAX_BODY) return { pushed: false, reason: `bridge-body-too-large (${Buffer.byteLength(body)} bytes)` };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), BRIDGE_PUBLISH_TIMEOUT_MS);
  let j;
  try {
    const r = await fetch(`http://127.0.0.1:${publisher.bridge.port}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': publisher.bridge.token },
      body, signal: ctl.signal,
    });
    j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  } catch (e) {
    return { pushed: false, reason: `bridge-publish-failed: ${e.name === 'AbortError' ? 'timeout' : e.message}` };
  } finally { clearTimeout(t); }
  if (!j || !j.ok) return { pushed: false, reason: `bridge-publish-failed: ${(j && j.error) || 'unknown error'}` };
  if (j.unchanged) return { pushed: false, reason: 'no-changes', commit: j.oid || null };
  if (!j.oid) return { pushed: false, reason: 'bridge-publish-failed: no oid in reply' };
  const explorerBase = RADICLE_EXPLORER_BASE.replace(/\/+$/, '');
  const hasExplorer = !!(explorerBase && RADICLE_SEED);
  const explorerUrl = hasExplorer ? `${explorerBase}/nodes/${RADICLE_SEED}/${publisher.rid}/commits/${j.oid}` : null;
  const treeUrl = hasExplorer ? `${explorerBase}/nodes/${RADICLE_SEED}/${publisher.rid}/tree/${j.oid}/${branch}` : null;
  return { pushed: true, commit: j.oid, branch, remote: { published: true, info: `bridge → ${publisher.rid} ns ${publisher.nid || '?'}` }, explorerUrl, treeUrl };
}

export async function pushDimension(peerId, dimensionName, filesByRelPath, removeRelPaths = []) {
  // Mobile peers have no git/rad: they publish through the in-app node's
  // loopback bridge when it supports it, and stay silent otherwise.
  if (IS_MOBILE) {
    const publisher = mobileDimsPublisher();
    if (!publisher) return { pushed: false, reason: 'mobile-peer-no-radicle' };
    return pushDimensionViaBridge(peerId, dimensionName, filesByRelPath, removeRelPaths, publisher);
  }
  const dir = await ensureWorkTree(peerId);
  const branch = dimensionBranch(dimensionName);
  // Races can happen on BOTH legs: the local bare (sibling peer in this clone)
  // and the rad remote (sibling peer wrote through our shared NID namespace
  // first). Each peer's content is independent — a door file keyed by
  // peer_id — so losing a race means we overlay our file on top of their tip
  // and re-push. Give it a few shots before giving up.
  const MAX_ATTEMPTS = 3;
  let head = null, remote = { published: false, reason: 'not attempted' };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await resetBranchToBare(dir, branch);
    // Scrub any `ActiveDimensions/<Other>/` left over from a previous dim push
    // that reused this same work-tree. Without this, the first commit on a
    // new dim branch sucks in all prior dims' folders via `git add -A` below,
    // which is why shallow clones of REL2-Ashfall-Micro surfaced Ashfall-Micro
    // and REL-Ashfall-Micro trees too.
    const activeDir = path.join(dir, 'ActiveDimensions');
    try {
      for (const name of await fs.readdir(activeDir)) {
        if (name !== dimensionName) {
          await fs.rm(path.join(activeDir, name), { recursive: true, force: true });
        }
      }
    } catch { /* ActiveDimensions/ doesn't exist yet — fine */ }
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
    try { await git(['push', '--quiet', 'radicle', branch], dir); }
    catch (e) {
      // Lost the local-bare race — resetBranchToBare on next iteration will
      // pull in the sibling's tip and we rebuild on top.
      if (/non-fast-forward|fetch first|rejected/.test(String(e.stderr || e.message))) continue;
      throw e;
    }
    remote = await pushToRadicle(dir, branch);
    if (remote.published || !dimsEnv.enabled) { head = (await git(['rev-parse', 'HEAD'], dir)).trim(); break; }
    // rad push failed. Only retry if the failure was a race (non-ff). Auth /
    // network errors won't be fixed by another round-trip.
    if (!/non-fast-forward|fetch first|rejected/.test(remote.reason || '')) { head = (await git(['rev-parse', 'HEAD'], dir)).trim(); break; }
  }
  if (!head) throw new Error(`push ${dimensionName} failed after ${MAX_ATTEMPTS} attempts: ${remote.reason}`);
  const published = remote.published && dimsEnv.enabled;
  // Explorer/tree links point at the dims repo — that's where the branch
  // actually lives. On an inherited dimsEnv (code+dims same RID), these are
  // identical to what radicleEnv would've produced, so this is backward-safe.
  const explorerUrl = published ? dimsEnv.commitUrl(head) : null;
  // Point the tree link at the pushed branch's content root. Using the commit
  // SHA (rather than the branch name) keeps the URL stable even if we later
  // rewrite the branch, and sidesteps slash-encoding in the branch path.
  const treeUrl = published ? dimsEnv.treeUrl(head, `ActiveDimensions/${dimensionName}`) : null;
  // Firebase registry (firebase/ + game/local-seeds.mjs). Fire-and-forget — a
  // failure here is logged but never fails the push, because the local bare
  // and rad remote are already updated. The adapter in local-seeds.mjs is a
  // no-op when FIREBASE_PROJECT_ID / FIREBASE_API_KEY are unset. We advertise
  // the dims RID so the Firebase explorer's /explore page queries the right
  // repo for the ActiveDimensions list.
  if (seedsEnabled && dimsEnv.enabled) {
    const doorPath = Object.keys(filesByRelPath).find(k => /\/doors\/[^/]+\.json$/.test(k));
    const doorDoc  = doorPath ? (typeof filesByRelPath[doorPath] === 'string' ? safeParse(filesByRelPath[doorPath]) : filesByRelPath[doorPath]) : null;
    const subject  = `[${peerId}] push ${dimensionName}`;
    const addr = process.env.RADICLE_PUBLIC_ADDR || '';
    Promise.all([
      publishSeedPresence({ nid: dimsEnv.nid, rid: `rad:${dimsEnv.rid}`, alias: peerId, radicleAddr: addr }),
      publishDimensionPush({ dimensionName, nid: dimsEnv.nid, rid: `rad:${dimsEnv.rid}`, alias: peerId, doorDoc, commit: head, subject, branch }),
    ]).catch(e => console.warn(`[radicle] firebase registry publish failed: ${e.message}`));
  }
  return { pushed: true, commit: head, branch, remote, explorerUrl, treeUrl };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export async function fetchDimension(peerId, dimensionName) {
  const dir = await ensureWorkTree(peerId);
  const branch = dimensionBranch(dimensionName);
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
  // The caller walks ActiveDimensions/* namespaces — that's dim-branch data,
  // which lives in the dims repo's storage dir (same as code when inherited).
  return path.join(home, 'storage', dimsEnv.rid);
}

// Pull the latest refs for every namespace from the seeds (best effort, bounded).
// `rad sync --timeout <N>sec` is a PER-SEED budget, not a total: rad walks
// seeds sequentially until it hits its default replication target (3 seeds),
// so a realistic 8-sec timeout often totals 20–30s wall-clock. The outer
// pexec kill budget here is sized for that walk so a successful fetch does
// not look like a failure. The caller never blocks on this — the cache in
// `syncFromSeedsCached` serves whatever storage already has.
export async function syncFromSeeds(timeoutSec = 10) {
  if (!dimsEnv.enabled) return false;
  const radEnv = { ...process.env, PATH: GIT_PATH_WITH_RAD };
  const radBin = path.join(RAD_BIN_DIR, 'rad');
  const outerMs = Math.max(45_000, (timeoutSec * 4 + 10) * 1000);
  // Try the Firebase registry's priority seeds first: `rad node connect` adds
  // the peer to the live connection set so the subsequent `rad sync --fetch`
  // has somebody to talk to. Each connect call is budgeted tightly (3s) so a
  // stale registry row can't make boot hang. Failures are silent — if nobody
  // is registered yet, we fall straight through to the default gossip walk
  // and the error message still points the user at the obvious cause.
  try {
    const { priorityBootstrap } = await import('./local-seeds.mjs');
    const { seeds } = await priorityBootstrap({ rid: `rad:${dimsEnv.rid}`, max: 3 });
    for (const s of seeds) {
      const target = s.radicleAddr.includes('@') ? s.radicleAddr : `${s.nid}@${s.radicleAddr}`;
      try {
        await pexec(radBin, ['node', 'connect', target], { windowsHide: true, env: radEnv, timeout: 3000 });
        console.log(`[radicle] connected to priority seed ${s.alias || s.nid.slice(0, 10)} @ ${s.radicleAddr}`);
      } catch { /* seed unreachable; move on */ }
    }
    if (!seeds.length) console.log(`[radicle] no priority seeds registered yet in dimensions-4e9ae — publish from any live peer to populate`);
  } catch { /* local-seeds disabled or offline */ }
  // Privacy (2026-11-18): without --seed, rad picks seeds from the routing table — public seeds that once fetched
  // the repo — and dials them even with peers.type=static. Fetch from our own seed(s) only (RAD_SYNC_SEEDS, comma list).
  const seedArgs = (process.env.RAD_SYNC_SEEDS || 'z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT').split(',').map(s => s.trim()).filter(Boolean).flatMap(s => ['--seed', s]);
  try { await pexec(radBin, ['sync', '--fetch', ...seedArgs, '--timeout', `${timeoutSec}sec`, `rad:${dimsEnv.rid}`], { cwd: PROJECT_ROOT, windowsHide: true, env: radEnv, timeout: outerMs }); return true; }
  catch (e) {
    const msg = (e.stderr || e.message || '').toString().split('\n')[0].slice(0, 160);
    const killed = /ETIMEDOUT|SIGTERM|SIGKILL|killed/i.test(String(e.signal || e.code || msg));
    console.warn(`[radicle] sync from seeds ${killed ? 'took too long; the fetch is still running in the background' : 'failed'}: ${msg}`);
    return false;
  }
}

// Rate-limit syncFromSeeds: /api/dimensions is called on every launcher open,
// and if the seeds are unreachable the fetch burns its full timeout each time.
// Keep the FIRST sync per TTL inline so a cold open still refreshes, then let
// subsequent calls return immediately and refresh in the background. Both the
// launcher's "list dimensions" and the "start a new dimension" flows feel this.
const _SYNC_TTL_MS = 30_000;
let _lastSyncAt = 0;
let _syncInFlight = null;
let _syncEverCompleted = false;
async function syncFromSeedsCached(timeoutSec = 8) {
  const age = Date.now() - _lastSyncAt;
  if (_syncEverCompleted && age < _SYNC_TTL_MS) {
    // Fresh enough — don't block the caller. A background refresh still fires
    // when the window is older than half the TTL so idle launchers stay warm.
    if (age > _SYNC_TTL_MS / 2 && !_syncInFlight) {
      _syncInFlight = syncFromSeeds(timeoutSec).finally(() => { _lastSyncAt = Date.now(); _syncEverCompleted = true; _syncInFlight = null; });
    }
    return true;
  }
  if (!_syncInFlight) {
    _syncInFlight = syncFromSeeds(timeoutSec).finally(() => { _lastSyncAt = Date.now(); _syncEverCompleted = true; _syncInFlight = null; });
  }
  // Give the first-ever sync a short budget (2s). If the seeds are responsive
  // the sync finishes well inside that; if they're down, the launcher reads
  // the storage snapshot that is already on disk and the fetch keeps running
  // in the background to warm the cache for the next call.
  const BUDGET_MS = 2000;
  await Promise.race([_syncInFlight, new Promise(r => setTimeout(r, BUDGET_MS))]).catch(() => {});
  return true;
}
// Pre-warm the sync cache at module load so the first launcher open does not
// pay the 8-second seed timeout. Fire-and-forget; the cached ref snapshot
// (populated by the previous session's pushes) stays usable while the fetch
// runs in the background.
if (radicleEnv.enabled) { syncFromSeedsCached(8).catch(() => {}); }

// Read every ActiveDimensions/* branch in every namespace of the repo — not
// just the delegates'. Each player publishes their own *Door* into a dimension
// (doors/<peer>.json, door_version 2 — their piece of the puzzle) in their own
// namespace; this unions them. Returns
//   [{ dimension_name, dimension_id, dimension, doors: [{...door, nid, ref, commit}], namespaces: [nid], legacy_doors: [...] }]
// grouped by dimension name. legacy_doors carries the old host-written
// door-primary docs so old branches still show up (as history, never as live).
export async function listPublishedDimensions({ sync = true } = {}) {
  if (!radicleEnv.enabled) throw new Error(radicleEnv.reason);
  if (sync) await syncFromSeedsCached(8);
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

// ---- Local copies of dimension branches (launcher "✕ delete old dimension", user ruling 2026-11-15) ----
// Only the local bare (game/radicle.git) and the per-peer work trees are touched — never the Radicle
// storage (~/.radicle/storage: signed refs, re-fetched from the seeds anyway), never a push, never `rad`.

// Map<dimensionName, { sha, at }> of the local bare's ActiveDimensions/* branches (empty without a bare).
export async function localDimensionBranches() {
  const out = new Map();
  if (IS_MOBILE) return out;
  try {
    const { stdout } = await pexec('git', ['--git-dir', RADICLE_BARE, 'for-each-ref', '--format=%(refname) %(objectname) %(committerdate:iso-strict)', 'refs/heads/ActiveDimensions/*'], { windowsHide: true, env: FENCED_ENV, timeout: 10_000 });
    for (const line of stdout.split('\n').filter(Boolean)) {
      const [ref, sha, at] = line.split(' ');
      const name = ref.slice('refs/heads/ActiveDimensions/'.length);
      if (name) out.set(name, { sha, at: at || null });
    }
  } catch { /* no bare yet */ }
  return out;
}

// Bytes of the objects only this branch reaches in the local bare (what deleting it would free on the next gc).
// Cached by tip sha: ~0.3 s per branch the first time.
const _branchBytes = new Map();
export async function localBranchBytes(dimensionName, sha) {
  if (IS_MOBILE || !sha) return 0;
  const key = `${dimensionName}@${sha}`;
  if (_branchBytes.has(key)) return _branchBytes.get(key);
  const ref = `refs/heads/${dimensionBranch(dimensionName)}`;
  let n = 0;
  try {
    const { stdout } = await pexec('git', ['--git-dir', RADICLE_BARE, 'rev-list', '--disk-usage', '--objects', ref, '--not', `--exclude=${ref}`, '--all'], { windowsHide: true, env: FENCED_ENV, timeout: 15_000 });
    n = Number(stdout.trim()) || 0;
  } catch { n = 0; }
  _branchBytes.set(key, n);
  return n;
}

// Drop ActiveDimensions/<Name> from the local bare and from every per-peer work tree (its local branch unless
// checked out there, and the radicle/ + rad/ remote-tracking refs). Returns what went, for the report.
export async function forgetLocalDimension(dimensionName) {
  if (IS_MOBILE || !isValidDimensionName(dimensionName)) return { bare: false, work_trees: 0, skipped: [] };
  const branch = dimensionBranch(dimensionName);
  const out = { bare: false, work_trees: 0, skipped: [] };
  const gitIn = (args) => pexec('git', args, { windowsHide: true, env: FENCED_ENV, timeout: 10_000 });
  try {
    await gitIn(['--git-dir', RADICLE_BARE, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    await gitIn(['--git-dir', RADICLE_BARE, 'update-ref', '-d', `refs/heads/${branch}`]);
    out.bare = true;
  } catch { /* not in the bare */ }
  let dirs = [];
  try { dirs = (await fs.readdir(RADICLE_WORK, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => path.join(RADICLE_WORK, d.name)); } catch {}
  for (const dir of dirs) {
    if (!(await isValidWorkTree(dir))) continue;
    let touched = false;
    for (const ref of [`refs/remotes/radicle/${branch}`, `refs/remotes/rad/${branch}`]) {
      try { await gitIn(['-C', dir, 'rev-parse', '--verify', '--quiet', ref]); await gitIn(['-C', dir, 'update-ref', '-d', ref]); touched = true; } catch {}
    }
    try {
      await gitIn(['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      let head = '';
      try { head = (await gitIn(['-C', dir, 'symbolic-ref', '-q', 'HEAD'])).stdout.trim(); } catch {}
      if (head === `refs/heads/${branch}`) out.skipped.push(path.basename(dir));   // checked out: a peer may be using it
      else { await gitIn(['-C', dir, 'update-ref', '-d', `refs/heads/${branch}`]); touched = true; }
    } catch {}
    if (touched) out.work_trees++;
  }
  for (const k of [..._branchBytes.keys()]) if (k.startsWith(`${dimensionName}@`)) _branchBytes.delete(k);
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
