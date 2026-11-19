#!/usr/bin/env node
// Proposal votes — publisher + collector (ruling 3, 2026-11-17). Spawned in the background by proposal-votes.mjs
// schedulePublish() after a vote (debounced; retried with back-off while a vote is owed). Also a CLI:
//   node game/proposal-votes-publish.mjs [--profile-file <profile.json>] [--nid <z6Mk… node NID>] [--no-sync] [--collect-only]
//
// Desktop (via 'git'), per def repo (rid) holding my signed votes:
//   1. <profile dir>/proposal-votes-git/<rid>.git (bare, created on first use), remote `rad` = rad://<rid>/<nid>
//   2. git fetch rad +refs/heads/votes/<voter> (my earlier tip, so the next commit fast-forwards; failure ignored)
//   3. publishVotesCommit → refs/heads/votes/<voter> = all my votes for that repo
//   4. git push rad refs/heads/votes/<voter>  → the LOCAL Radicle node's storage (my namespace)
//   5. rad sync <rid> --seed <OCI seed NID> --announce   — the OCI seed ONLY, never public seeds
// Phone (via 'bridge'): POST http://127.0.0.1:<port>/publish of the in-app node (bridge.json, feature "votes"):
//   { rid, ref: refs/heads/votes/<voter>, mode: 'snapshot', files: { votes/<id>/<file>: json }, prune_prefix: 'votes/',
//     remove: [], name, email, timestamp, message, seed: <OCI seed NID> } — the node commits in its namespace and
//   announces to `seed` only. A bridge without the "votes" feature → pending ("phone node cannot publish votes yet").
// Success → status.repos[rid] = { state: 'published', upto: <latest vote at>, count, voter, commit, at }.
// Failure (no ssh-agent, node down, repo not seeded locally, …) → { state: 'pending', error, tries, at }: the votes
// stay local (HUD "pending"); the scheduler retries later.
// Afterwards (desktop) collectAll(): every votes/* branch in the local Radicle storage of the three def repos
// (author votes dropped) + my local votes → <profile dir>/proposal_votes.collected.json (ruling 4 review flag).
// Test hooks: remoteUrlFor(rid, nid) (e.g. a bare repo path), radSync: false, bridgeFile, storageDirFor(rid).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './defs-repo.mjs';
import { loadVotes, votesFile, votesDir, voterIdentity, dedupeVotes, verifyVote, ridOf, voteBranch, votePath, publishVotesCommit,
  loadPublishStatus, savePublishStatus, publishFile, OCI_SEED_NID, NID_RE, DEFAULT_RIDS, collectVotesFromGit,
  saveCollections, collectedFile } from './proposal-votes.mjs';

const ridBare = (rid) => String(rid).replace(/^rad:/, '');
export const defaultRemoteUrl = (rid, nid) => `rad://${ridBare(rid)}${nid ? `/${nid}` : ''}`;
const radHome = () => process.env.RAD_HOME || path.join(os.homedir(), '.radicle');
export const defaultStorageDir = (rid) => path.join(radHome(), 'storage', ridBare(rid));

function toolEnv() {
  const env = { ...process.env };
  const radBin = path.join(os.homedir(), '.radicle', 'bin');
  if (fs.existsSync(radBin) && !String(env.PATH || '').includes(radBin)) env.PATH = `${radBin}${path.delimiter}${env.PATH || ''}`;
  // `wsl -- bash` shells skip ~/.bashrc → no SSH_AUTH_SOCK; the user's agent socket lives in ~/.ssh/agent.sock.
  const sock = path.join(os.homedir(), '.ssh', 'agent.sock');
  if (!env.SSH_AUTH_SOCK && fs.existsSync(sock)) env.SSH_AUTH_SOCK = sock;
  return env;
}
const run = (cmd, args, { env, timeout = 60e3, input } = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', env, timeout, input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const clipErr = (s) => s.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
const errText = (e) => clipErr(String(e?.stderr || '').trim() || e?.message || String(e));

/** My node NID (`rad self --nid`), or null. */
export function radNid(env = toolEnv()) {
  try { const n = run('rad', ['self', '--nid'], { env, timeout: 15e3 }); return NID_RE.test(n) ? n : null; } catch { return null; }
}

/** bridge.json of the phone's in-app node when it can publish votes, else { error }. */
export function readVotesBridge(file = process.env.CHAOSD6_RADICLE_BRIDGE || '') {
  let b;
  try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { error: 'phone Radicle node not running (no bridge.json)' }; }
  if (!b?.port || !b?.token) return { error: 'phone Radicle bridge.json incomplete' };
  if (!Array.isArray(b.features) || !b.features.includes('votes')) return { error: 'phone Radicle node cannot publish votes yet (bridge lacks the "votes" feature)' };
  return { bridge: b };
}

async function publishRepoGit({ rid, votes, me, nid, gitdir, remoteUrlFor, radSync, env }) {
  const branch = `refs/heads/${voteBranch(me.id)}`;
  let step = 'init';
  try {
    if (!fs.existsSync(path.join(gitdir, 'HEAD'))) { fs.mkdirSync(gitdir, { recursive: true }); run('git', ['init', '-q', '--bare', gitdir], { env }); }
    step = 'remote';
    const url = remoteUrlFor(rid, nid);
    try { run('git', ['--git-dir', gitdir, 'remote', 'set-url', 'rad', url], { env }); } catch { run('git', ['--git-dir', gitdir, 'remote', 'add', 'rad', url], { env }); }
    step = 'fetch';
    try { run('git', ['--git-dir', gitdir, 'fetch', '-q', 'rad', `+${branch}:${branch}`], { env, timeout: 60e3 }); } catch { /* first publish / offline: build on what we have */ }
    step = 'commit';
    publishVotesCommit({ gitdir, votes, voter: me.id, message: `proposal votes (${votes.length})` });
    const commit = run('git', ['--git-dir', gitdir, 'rev-parse', branch], { env });
    step = 'push';
    run('git', ['--git-dir', gitdir, 'push', '-q', 'rad', `${branch}:${branch}`], { env, timeout: 90e3 });
    if (radSync) {
      step = 'announce to the OCI seed';
      run('rad', ['sync', rid, '--seed', OCI_SEED_NID, '--announce', '--timeout', '30'], { env, timeout: 60e3 });
    }
    return { ok: true, commit };
  } catch (e) { return { ok: false, error: `${step}: ${errText(e)}` }; }
}

async function publishRepoBridge({ rid, votes, me, bridgeFile, fetchImpl = globalThis.fetch }) {
  const vb = readVotesBridge(bridgeFile);
  if (!vb.bridge) return { ok: false, error: vb.error };
  const files = {};
  for (const v of votes) files[votePath(v)] = canonicalJson(v) + '\n';
  const stamp = new Date();
  const body = JSON.stringify({ rid, ref: `refs/heads/${voteBranch(me.id)}`, mode: 'snapshot', files, remove: [], prune_prefix: 'votes/',
    name: me.id, email: `${me.id}@chaosd6`, timestamp: Math.floor(stamp.getTime() / 1000), message: `proposal votes (${votes.length})`, seed: OCI_SEED_NID });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60e3);
  try {
    const r = await fetchImpl(`http://127.0.0.1:${vb.bridge.port}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': vb.bridge.token }, body, signal: ctl.signal });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!j?.ok) return { ok: false, error: `bridge: ${j?.error || 'unknown error'}` };
    return { ok: true, commit: j.oid || null };
  } catch (e) { return { ok: false, error: `bridge: ${e.name === 'AbortError' ? 'timeout' : e.message}` }; }
  finally { clearTimeout(t); }
}

export async function publishAll({ profileFile = '', nid = null, via = process.env.CHAOSD6_MOBILE === '1' ? 'bridge' : 'git', remoteUrlFor = defaultRemoteUrl,
  radSync = true, bridgeFile = process.env.CHAOSD6_RADICLE_BRIDGE || '', fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const env = toolEnv();
  const me = voterIdentity(profileFile, '', { create: false });
  const status = loadPublishStatus(publishFile(profileFile));
  if (!me.privateKeyPem) return status;   // no profile key → nothing publishable (votes stay 'saved', local only)
  const mine = dedupeVotes(loadVotes(votesFile(profileFile))).filter(v => v.voter === me.id && verifyVote(v));
  const byRid = new Map();
  for (const v of mine) { const r = ridOf(v); if (!byRid.has(r)) byRid.set(r, []); byRid.get(r).push(v); }
  if (via === 'git' && byRid.size && radSync && !nid) nid = radNid(env);
  for (const [rid, votes] of byRid) {
    const upto = votes.map(v => v.at).sort().pop();
    const prev = status.repos[rid] || {};
    if (prev.state === 'published' && prev.voter === me.id && String(prev.upto) >= upto && prev.count === votes.length) continue;   // nothing new
    const res = via === 'bridge'
      ? await publishRepoBridge({ rid, votes, me, bridgeFile, fetchImpl })
      : await publishRepoGit({ rid, votes, me, nid, gitdir: path.join(votesDir(profileFile), 'proposal-votes-git', `${ridBare(rid)}.git`), remoteUrlFor, radSync, env });
    status.repos[rid] = res.ok
      ? { state: 'published', upto, count: votes.length, voter: me.id, commit: res.commit, via, at: now().toISOString(), tries: 0 }
      : { ...prev, state: 'pending', error: res.error, via, tries: (prev.tries | 0) + 1, at: now().toISOString() };
  }
  savePublishStatus(status, publishFile(profileFile));
  return status;
}

/** Everyone's votes from the local Radicle storage of the def repos (author votes dropped) + my local votes →
 *  <profile dir>/proposal_votes.collected.json. → { votes, rejected, repos }. */
export function collectAll({ profileFile = '', rids = Object.values(DEFAULT_RIDS), storageDirFor = defaultStorageDir, now = new Date() } = {}) {
  const votes = [...loadVotes(votesFile(profileFile)).filter(verifyVote)];
  const rejected = [], repos = [];
  for (const rid of [...new Set(rids)]) {
    const gitdir = storageDirFor(rid);
    if (!gitdir || !fs.existsSync(gitdir)) continue;
    try { const c = collectVotesFromGit({ gitdir }); votes.push(...c.votes); rejected.push(...c.rejected); repos.push(rid); }
    catch (e) { rejected.push({ ref: rid, path: '', why: errText(e) }); }
  }
  const all = dedupeVotes(votes);
  saveCollections(all, collectedFile(profileFile), now);
  return { votes: all, rejected, repos };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const profileFile = opt('--profile-file') || '';
  let pending = false;
  if (!argv.includes('--collect-only')) {
    const st = await publishAll({ profileFile, nid: opt('--nid') || null, radSync: !argv.includes('--no-sync') });
    for (const [rid, r] of Object.entries(st.repos)) console.log(`${rid} ${r.state}${r.error ? ` — ${r.error}` : ''}`);
    pending = Object.values(st.repos).some(r => r.state === 'pending');
  }
  try { const c = collectAll({ profileFile }); console.log(`collected ${c.votes.length} vote(s) from ${c.repos.length} repo(s), ${c.rejected.length} rejected`); }
  catch (e) { console.log(`collect failed: ${errText(e)}`); }
  process.exit(pending ? 1 : 0);
}
