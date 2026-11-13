// chaosD6-Profiles write endpoint (runs on the OCI seed as the `radicle` user,
// behind caddy at /profiles-push). radicle-httpd is read-only, so phones push
// here with plain git smart-HTTP; this service
//   1. accepts exactly one ref update per push, to refs/heads/profiles/<id>
//      signed by <id>'s key, or to refs/heads/teams/<Team> signed by an owner
//      (X-Profile-Auth, see game/profile-auth.mjs),
//   2. lets `git receive-pack` apply it (receive.denyNonFastForwards=true,
//      receive.denyDeletes=true in the repo config → fast-forward only),
//   3. checks the new tree is just a small profile.json,
//   4. `git push rad <ref>` so the OCI node signs it into Radicle storage and
//      the network replicates it. Any failure after (2) rolls the ref back.
// It also serves git-upload-pack on the same repo as a fallback read path.
// Team branches (user ruling 2026-11-13): refs/heads/teams/<Team> holds a whole player profile. First claim
// wins: the creating push must list its signer in profile.json `owners`; afterwards only a key listed in the
// current tip's owners may move it, and the owner list may never become empty.
//
// Env: PROFILES_REPO (working `rad clone` of chaosD6-Profiles), PORT (8090),
//      HOST (127.0.0.1), BASE (/profiles-push), MIRROR_REMOTE (rad; "none" =
//      skip, for local tests), MAX_PROFILE_BYTES (262144),
//      PROFILES_STORAGE (Radicle storage of the repo; default
//      $HOME/.radicle/storage/<PROFILES_RID>), PROMOTE_EVERY_MS (3000; 0 = no
//      promoter). See "Promoter" below for the P2P write path.
//
// Deploy: copy this file + game/profile-auth.mjs into one directory
// (infra/oci/profiles-setup.sh does it).

import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
// Deployed side by side; in the repo it lives in game/.
const { verifyPush, AUTH_HEADER, isTeamRef, ownerIds } = await import('./profile-auth.mjs').catch(() => import('../../game/profile-auth.mjs'));

const REPO = process.env.PROFILES_REPO;
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '127.0.0.1';
const BASE = (process.env.BASE || '/profiles-push').replace(/\/$/, '');
const MIRROR = process.env.MIRROR_REMOTE || 'rad';
const MAX_PROFILE = Number(process.env.MAX_PROFILE_BYTES || 262144);   // a team profile holds every character
const MAX_BODY = 4 * 1024 * 1024;
const ZERO = '0000000000000000000000000000000000000000';
const REF_RE = /^refs\/heads\/profiles\/z6Mk[1-9A-HJ-NP-Za-km-z]+$/;
const pushable = (ref) => REF_RE.test(ref) || isTeamRef(ref);
if (!REPO) { console.error('PROFILES_REPO is required'); process.exit(2); }

const log = (...a) => console.log(new Date().toISOString(), ...a);

function run(cmd, args, { input, cwd = REPO } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const out = [], err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
    p.on('error', (e) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: e.message }));
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}
const git = (args, opts) => run('git', args, opts);

async function refOid(ref) {
  const r = await git(['rev-parse', '--verify', '-q', ref]);
  return r.code === 0 ? r.stdout.toString().trim() : ZERO;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const src = /gzip/i.test(req.headers['content-encoding'] || '') ? req.pipe(zlib.createGunzip()) : req;
    const chunks = []; let n = 0;
    src.on('data', (d) => { n += d.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(d); });
    src.on('end', () => resolve(Buffer.concat(chunks)));
    src.on('error', reject);
  });
}

/** Ref-update commands at the start of a receive-pack request (before the flush). */
function parseCommands(body) {
  const cmds = [];
  let i = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString(), 16);
    if (!Number.isFinite(len)) throw new Error('bad pkt-line');
    if (len === 0) return cmds;
    let line = body.subarray(i + 4, i + len).toString('latin1');
    line = line.split('\0')[0].replace(/\n$/, '');
    const [oldOid, newOid, ref] = line.split(' ');
    cmds.push({ oldOid, newOid, ref });
    i += len;
  }
  throw new Error('truncated command list');
}

function pkt(s) { return (s.length + 4).toString(16).padStart(4, '0') + s; }

async function advertise(res, service) {
  const r = await git([service.replace(/^git-/, ''), '--stateless-rpc', '--advertise-refs', '.']);
  if (r.code !== 0) return fail(res, 500, r.stderr);
  res.writeHead(200, { 'Content-Type': `application/x-${service}-advertisement`, 'Cache-Control': 'no-cache' });
  res.end(Buffer.concat([Buffer.from(pkt(`# service=${service}\n`) + '0000'), r.stdout]));
}

function fail(res, code, msg) {
  log(`-> ${code} ${String(msg).trim()}`);
  // isomorphic-git drops error bodies and keeps only the status line, so the
  // reason goes there too (single line, ASCII).
  const reason = String(msg).trim().split('\n')[0].replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
  res.writeHead(code, reason, { 'Content-Type': 'text/plain' });
  res.end(String(msg).trim() + '\n');
}

async function rollback(ref, oldOid, newOid) {
  const args = oldOid === ZERO ? ['update-ref', '-d', ref, newOid] : ['update-ref', ref, oldOid, newOid];
  const r = await git(args);
  if (r.code !== 0) log(`ROLLBACK FAILED for ${ref}: ${r.stderr}`);
}

async function profileAt(oid) {
  const blob = await git(['cat-file', 'blob', `${oid}:profile.json`]);
  if (blob.code !== 0) return null;
  try { return JSON.parse(blob.stdout.toString('utf8')); } catch { return null; }
}

async function checkTree(newOid) {
  const r = await git(['ls-tree', '-l', newOid]);
  if (r.code !== 0) return 'cannot read pushed tree';
  const rows = r.stdout.toString().trim().split('\n').filter(Boolean);
  if (rows.length !== 1) return 'tree must contain only profile.json';
  const [meta, name] = rows[0].split('\t');
  const [, type, , size] = meta.split(/\s+/);
  if (name !== 'profile.json' || type !== 'blob') return 'tree must contain only profile.json';
  if (Number(size) > MAX_PROFILE) return `profile.json larger than ${MAX_PROFILE} bytes`;
  const blob = await git(['cat-file', 'blob', `${newOid}:profile.json`]);
  try { JSON.parse(blob.stdout.toString('utf8')); } catch { return 'profile.json is not valid JSON'; }
  return null;
}

/** Why `newOid` may not become `ref` (null = fine). `owners`: the current tip's (null = unclaimed team). */
async function contentProblem(ref, newOid, owners, id) {
  const bad = await checkTree(newOid);
  if (bad || !isTeamRef(ref)) return bad;
  const next = ownerIds(await profileAt(newOid));
  if (!next.length) return 'a team profile needs at least one owner';
  if (owners === null && !next.includes(id)) return 'the first push of a team must list its own key in owners';
  return null;
}

/** `git push rad <ref>`; returns the error text, or null. */
async function mirror(ref) {
  if (MIRROR === 'none') return null;
  const m = await git(['push', MIRROR, `${ref}:${ref}`]);
  return m.code === 0 ? null : (m.stderr || 'failed');
}

async function receive(req, res) {
  const body = await readBody(req);
  let cmds;
  try { cmds = parseCommands(body); } catch (e) { return fail(res, 400, e.message); }
  if (cmds.length !== 1) return fail(res, 400, 'exactly one ref update per push');
  const { oldOid, newOid, ref } = cmds[0];
  if (!pushable(ref)) return fail(res, 403, `refusing ${ref}`);
  if (newOid === ZERO) return fail(res, 403, 'deletes are not allowed');
  // Team branch: who owns it now (null = not claimed yet).
  const team = isTeamRef(ref);
  const tipOid = team ? await refOid(ref) : ZERO;
  const owners = team && tipOid !== ZERO ? ownerIds(await profileAt(tipOid)) : null;
  if (team && tipOid !== ZERO && oldOid === ZERO) return fail(res, 403, `team name taken: ${ref.slice('refs/heads/teams/'.length)} already belongs to another player`);
  let id;
  try {
    id = verifyPush(req.headers[AUTH_HEADER], { ref, oldOid, newOid }, Date.now(), {
      mayPush: (who, r) => (isTeamRef(r) ? (owners === null || owners.includes(who)) : REF_RE.test(r) && r === `refs/heads/profiles/${who}`),
    });
  } catch (e) {
    // The client sees the tip, so a second claimant arrives here (not via the ZERO check above).
    if (team && /not an owner/.test(e.message)) return fail(res, 403, `team name taken: ${ref.slice('refs/heads/teams/'.length)} belongs to other keys (${e.message}); an owner device must approve this id`);
    return fail(res, 403, e.message);
  }

  const r = await git(['receive-pack', '--stateless-rpc', '.'], { input: body });
  if (r.code !== 0) return fail(res, 500, r.stderr || 'receive-pack failed');
  if ((await refOid(ref)) !== newOid) {
    // Rejected by receive-pack itself (stale old oid, non-fast-forward): its
    // report-status already says why, pass it through.
    log(`${id.slice(0, 12)} ${ref.slice(-8)} rejected by receive-pack`);
    res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result' });
    return res.end(r.stdout);
  }
  const bad = await contentProblem(ref, newOid, owners, id);
  if (bad) { await rollback(ref, oldOid, newOid); return fail(res, 403, bad); }
  const m = await mirror(ref);
  if (m) { await rollback(ref, oldOid, newOid); return fail(res, 502, `radicle push failed: ${m}`); }
  log(`${id.slice(0, 12)} ${oldOid.slice(0, 8)}..${newOid.slice(0, 8)} ok${MIRROR !== 'none' ? ` → ${MIRROR}` : ''}`);
  res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-cache' });
  res.end(r.stdout);
}

async function upload(req, res) {
  const body = await readBody(req);
  const r = await git(['upload-pack', '--stateless-rpc', '.'], { input: body });
  if (r.code !== 0) return fail(res, 500, r.stderr);
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' });
  res.end(r.stdout);
}

// One push at a time: the ref check, rollback and rad push must not interleave.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

// ---- Promoter: the P2P write path (user ruling 2026-11-13: "P2P writer + OCI promotes") ----
// A phone running the in-app radicle-node commits its save to refs/heads/{teams/<Team>,profiles/<nid>} in
// its OWN namespace of Radicle storage, signs refs and announces; this node fetches it (seeding scope all),
// and Radicle has verified the namespace's signed refs by then, so the namespace NID is the author. Each
// poll looks for such refs that differ from the canonical branch and promotes them under the same rules
// as an HTTPS push: fast-forward only, owners for teams, own NID for profiles/<id>, profile.json only.

const STORAGE = process.env.PROFILES_STORAGE
  || `${process.env.HOME}/.radicle/storage/${(process.env.PROFILES_RID || 'rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH').replace(/^rad:/, '')}`;
const PROMOTE_EVERY = Number(process.env.PROMOTE_EVERY_MS || 3000);
const NID_RE = /^z6Mk[1-9A-HJ-NP-Za-km-z]+$/;
const done = new Set();   // `${nid} ${ref} ${oid}` already promoted or refused: not retried
const selfNid = (await run('rad', ['self', '--nid'])).stdout.toString().trim();

async function promote(nid, ref, oid) {
  const key = `${nid} ${ref} ${oid}`;
  const tip = await refOid(ref);
  if (tip === oid) return done.add(key);
  const tmp = `refs/promote/${nid}/${ref.slice('refs/'.length)}`;
  const why = await (async () => {
    if (!pushable(ref)) return 'not a profile branch';
    if (!isTeamRef(ref) && ref !== `refs/heads/profiles/${nid}`) return 'another key\'s profile branch';
    const f = await git(['fetch', '-q', '--no-tags', STORAGE, `+refs/namespaces/${nid}/${ref}:${tmp}`]);
    if (f.code !== 0) return `fetch from storage: ${f.stderr.trim()}`;
    if (tip !== ZERO && (await git(['merge-base', '--is-ancestor', tip, oid])).code !== 0) {
      // An old save of theirs the branch has since moved past is not worth a log line.
      return (await git(['merge-base', '--is-ancestor', oid, tip])).code === 0 ? '' : 'not a fast-forward of the canonical branch';
    }
    const owners = isTeamRef(ref) && tip !== ZERO ? ownerIds(await profileAt(tip)) : null;
    if (owners && !owners.includes(nid)) return 'not an owner';
    return contentProblem(ref, oid, owners, nid);
  })();
  await git(['update-ref', '-d', tmp]);
  if (why !== null) {
    done.add(key);
    if (why) log(`promote ${nid.slice(0, 12)} ${ref} ${oid.slice(0, 8)} refused: ${why}`);
    return;
  }
  // Compare-and-swap on the tip we checked against (ZERO = must not exist yet).
  if ((await git(['update-ref', ref, oid, tip])).code !== 0) return;   // moved meanwhile; next poll re-checks
  const m = await mirror(ref);
  if (m) { await rollback(ref, tip, oid); return log(`promote ${ref} ${oid.slice(0, 8)}: radicle push failed, will retry: ${m.trim()}`); }
  done.add(key);
  log(`${nid.slice(0, 12)} ${tip.slice(0, 8)}..${oid.slice(0, 8)} ${ref} promoted from radicle${MIRROR !== 'none' ? ` → ${MIRROR}` : ''}`);
}

let storageWarned = false;
async function scan() {
  const r = await git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/namespaces/'], { cwd: STORAGE });
  if (r.code !== 0) {
    if (!storageWarned) log(`promoter: cannot read ${STORAGE}: ${r.stderr.trim()}`);
    storageWarned = true;
    return;
  }
  storageWarned = false;
  if (done.size > 20000) done.clear();
  for (const line of r.stdout.toString().split('\n')) {
    const m = line.match(/^([0-9a-f]{40}) refs\/namespaces\/([^/]+)\/(refs\/heads\/(?:teams|profiles)\/.+)$/);
    if (!m) continue;
    const [, oid, nid, ref] = m;
    if (nid === selfNid || !NID_RE.test(nid) || done.has(`${nid} ${ref} ${oid}`)) continue;
    try { await promote(nid, ref, oid); } catch (e) { log(`promote ${ref}: ${e.message}`); }
  }
}

let scanning = false;
if (PROMOTE_EVERY > 0) {
  setInterval(() => {
    if (scanning) return;
    scanning = true;
    serial(() => scan().finally(() => { scanning = false; }));
  }, PROMOTE_EVERY);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : null;
  const svc = url.searchParams.get('service');
  const h = (fn) => fn().catch((e) => { if (!res.headersSent) fail(res, 500, e.message); });
  if (req.method === 'GET' && p === '/info/refs' && (svc === 'git-receive-pack' || svc === 'git-upload-pack')) return h(() => advertise(res, svc));
  if (req.method === 'POST' && p === '/git-receive-pack') return serial(() => h(() => receive(req, res)));
  if (req.method === 'POST' && p === '/git-upload-pack') return h(() => upload(req, res));
  if (req.method === 'GET' && p === '/health') { res.writeHead(200); return res.end('ok\n'); }
  fail(res, 404, 'not found');
}).listen(PORT, HOST, () => log(`profiles-push on ${HOST}:${PORT}${BASE} repo=${REPO} mirror=${MIRROR}`));
