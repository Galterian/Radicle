// Radicle stand-in. Real Radicle requires the `rad` CLI + a heartwood node, which
// isn't installed on this box. We use a LOCAL BARE GIT REPO as the shared "rendezvous"
// — the git protocol semantics match sync_radicle_push.data (branch per Dimension,
// commits per push). Swap `git` with `rad` once the CLI is available; the shape is
// identical.
//
//   game/radicle.git/                               (bare)
//     refs/heads/ActiveDimensions/<DimensionName>
//
// Each peer clones into game/radicle-work/<peer_id>/ and pushes/fetches there.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RADICLE_BARE = path.join(__dirname, 'radicle.git');
export const RADICLE_WORK = path.join(__dirname, 'radicle-work');

async function git(args, cwd) {
  const { stdout } = await pexec('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

export async function ensureBare() {
  try { await fs.access(RADICLE_BARE); return; }
  catch { /* fall through */ }
  await fs.mkdir(RADICLE_BARE, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main'], RADICLE_BARE);
  console.log(`[radicle] bare repo at ${RADICLE_BARE}`);
}

function safePeerDir(peerId) { return peerId.replace(/[:/\\]/g, '-'); }

export async function ensureWorkTree(peerId) {
  const dir = path.join(RADICLE_WORK, safePeerDir(peerId));
  try { await fs.access(path.join(dir, '.git')); return dir; }
  catch { /* clone */ }
  await fs.mkdir(RADICLE_WORK, { recursive: true });
  // --initial-branch so an empty bare repo clones cleanly.
  await pexec('git', ['clone', '--origin', 'radicle', RADICLE_BARE, dir], { windowsHide: true });
  await git(['config', 'user.email', `${peerId}@chaosd6.local`], dir);
  await git(['config', 'user.name', peerId], dir);
  // Seed main so later checkouts have something to switch away from.
  try { await git(['commit', '--allow-empty', '-m', `init ${peerId}`], dir); await git(['push', 'radicle', 'main'], dir); } catch {}
  return dir;
}

export async function pushDimension(peerId, dimensionName, filesByRelPath) {
  const dir = await ensureWorkTree(peerId);
  const branch = `ActiveDimensions/${dimensionName}`;
  // Create / switch to the branch.
  try { await git(['checkout', branch], dir); }
  catch { await git(['checkout', '-b', branch], dir); }
  try { await git(['pull', '--ff-only', 'radicle', branch], dir); } catch { /* branch may not exist upstream yet */ }
  for (const [rel, content] of Object.entries(filesByRelPath)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  await git(['add', '-A'], dir);
  let changes = '';
  try { changes = await git(['status', '--porcelain'], dir); } catch {}
  if (!changes.trim()) return { pushed: false, reason: 'no-changes' };
  const stamp = new Date().toISOString();
  await git(['commit', '-m', `[${peerId}] push ${dimensionName} @ ${stamp}`], dir);
  await git(['push', 'radicle', branch], dir);
  const head = await git(['rev-parse', 'HEAD'], dir);
  return { pushed: true, commit: head, branch };
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
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('radicle-adapter.mjs')) {
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
