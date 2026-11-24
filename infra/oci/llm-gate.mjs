// chaosD6 LLM gatekeeper (user 2026-11-23): the one door to the OCI model and test services, so phones never hold the
// API key. Caddy sends /llm/*, /llm-big/* and /gen-test(/*) here (infra/oci/llm-gate-setup.sh); this service
//   1. lets a request in when it carries the master key (Authorization: Bearer <key>, the user's desktop), or an
//      X-Chaos-Device header (game/oci-auth.mjs) — a fresh, unreplayed ed25519 signature over method, path, body,
//      by a device id that is an OWNER of a team branch (refs/heads/teams/*) of chaosD6-Profiles,
//   2. rate-limits each device per service (sliding windows; 429 + Retry-After),
//   3. forwards it with the master key to llama-server (/llm → :8095, /llm-big → :8096, prefix stripped) or the test
//      service (/gen-test → :8097, path kept), streaming the answer back (SSE), and aborts upstream if the client goes.
// GET …/health passes without auth. The owner list is re-read from PROFILES_REPO every OWNERS_TTL_MS.
//
// Env: PORT (8098), HOST (127.0.0.1), KEY_FILE (/etc/chaosd6-llm/api-key), PROFILES_REPO (/home/radicle/profiles-work),
//      ALLOW_FILE / DENY_FILE (/etc/chaosd6-llm/devices.{allow,deny}: one z6Mk id per line, # comments),
//      UPSTREAM_LLM / UPSTREAM_BIG / UPSTREAM_TEST (http://127.0.0.1:8095 / :8096 / :8097),
//      LIMIT_LLM (300/600) LIMIT_BIG (20/3600) LIMIT_TEST (12/3600): <requests>/<seconds> per device, POST only,
//      OWNERS_TTL_MS (60000). Deploy: this file + game/oci-auth.mjs + game/profile-auth.mjs in one directory.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const { verifyDeviceRequest, DEVICE_HEADER } = await import('./oci-auth.mjs').catch(() => import('../../game/oci-auth.mjs'));
const { ownerIds } = await import('./profile-auth.mjs').catch(() => import('../../game/profile-auth.mjs'));
const run = promisify(execFile);

const PORT = Number(process.env.PORT || 8098);
const HOST = process.env.HOST || '127.0.0.1';
const KEY_FILE = process.env.KEY_FILE || '/etc/chaosd6-llm/api-key';
const REPO = process.env.PROFILES_REPO || '/home/radicle/profiles-work';
const ALLOW_FILE = process.env.ALLOW_FILE || '/etc/chaosd6-llm/devices.allow';
const DENY_FILE = process.env.DENY_FILE || '/etc/chaosd6-llm/devices.deny';
const OWNERS_TTL = Number(process.env.OWNERS_TTL_MS || 60_000);
const limitOf = (v, d) => { const [n, s] = String(v || d).split('/').map(Number); return { n: n > 0 ? n : 1, ms: (s > 0 ? s : 60) * 1000 }; };
const ROUTES = [   // longest prefix first
  { prefix: '/llm-big', name: 'big', upstream: process.env.UPSTREAM_BIG || 'http://127.0.0.1:8096', strip: true, maxBody: 512 * 1024, limit: limitOf(process.env.LIMIT_BIG, '20/3600') },
  { prefix: '/llm', name: 'llm', upstream: process.env.UPSTREAM_LLM || 'http://127.0.0.1:8095', strip: true, maxBody: 128 * 1024, limit: limitOf(process.env.LIMIT_LLM, '300/600') },
  { prefix: '/gen-test', name: 'test', upstream: process.env.UPSTREAM_TEST || 'http://127.0.0.1:8097', strip: false, maxBody: 400 * 1024, limit: limitOf(process.env.LIMIT_TEST, '12/3600') },
];
const log = (...a) => console.log(new Date().toISOString(), ...a);
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const short = (id) => `${String(id).slice(0, 10)}…${String(id).slice(-4)}`;

const readKey = () => { try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; } };
let MASTER = readKey();
if (!MASTER) log(`WARNING: no master key in ${KEY_FILE} — upstream calls carry none`);
const idList = (file) => { try { return new Set(fs.readFileSync(file, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(l => /^z6Mk/.test(l))); } catch { return new Set(); } };

// ---- owners: every id listed in refs/heads/teams/*:profile.json owners (+ ALLOW_FILE, − DENY_FILE) ----------------
let owners = { ids: new Map(), at: 0, error: '' };   // id → [team slugs]
async function loadOwners() {
  const ids = new Map();
  try {
    const { stdout } = await run('git', ['-C', REPO, 'for-each-ref', '--format=%(refname)', 'refs/heads/teams/'], { maxBuffer: 4 << 20 });
    for (const ref of stdout.split('\n').filter(Boolean)) {
      try {
        const { stdout: blob } = await run('git', ['-C', REPO, 'show', `${ref}:profile.json`], { maxBuffer: 4 << 20 });
        const team = ref.slice('refs/heads/teams/'.length);
        for (const id of ownerIds(JSON.parse(blob))) ids.set(id, [...(ids.get(id) || []), team]);
      } catch { /* an unreadable branch adds nobody */ }
    }
    owners = { ids, at: Date.now(), error: '' };
  } catch (e) { owners = { ...owners, at: Date.now(), error: e.message.split('\n')[0] }; log(`owners: ${owners.error}`); }
  return owners;
}
let loading = null;   // one git read at a time
const reloadOwners = () => (loading ||= loadOwners().finally(() => { loading = null; }));
async function allowed(id) {
  if (idList(DENY_FILE).has(id)) return { ok: false, why: 'this device is blocked' };
  if (idList(ALLOW_FILE).has(id)) return { ok: true, teams: ['(allow list)'] };
  // A bot's move has ~4.5 s: the owner list is refreshed in the background, a request only waits for the first read.
  if (!owners.at) await reloadOwners();
  else if (Date.now() - owners.at > OWNERS_TTL) reloadOwners();
  let teams = owners.ids.get(id);
  if (!teams && Date.now() - owners.at > 15_000) { await reloadOwners(); teams = owners.ids.get(id); }   // just approved? one fresh look (≤ 1 per 15 s)
  return teams ? { ok: true, teams } : { ok: false, why: `device ${short(id)} is not an owner of any team — approve it on a device of its team (profile sync)` };
}

// ---- replay + rate limits ---------------------------------------------------------------------------------------
const nonces = new Map();   // key → expiry
const seen = (k) => { const now = Date.now(); if (nonces.size > 50_000) for (const [x, t] of nonces) if (t < now) nonces.delete(x); if (nonces.has(k) && nonces.get(k) > now) return true; nonces.set(k, now + 11 * 60_000); return false; };
const hits = new Map();     // `${route} ${id}` → [times]
function rate(route, id) {
  const k = `${route.name} ${id}`, now = Date.now();
  const t = (hits.get(k) || []).filter(x => now - x < route.limit.ms);
  if (t.length >= route.limit.n) { hits.set(k, t); return Math.ceil((route.limit.ms - (now - t[0])) / 1000); }
  t.push(now); hits.set(k, t);
  return 0;
}

// ---- the proxy --------------------------------------------------------------------------------------------------
function send(res, status, msg, extra = {}) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify({ ok: false, error: msg }) + '\n');
}
const readBody = (req, max) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', (d) => { n += d.length; if (n > max) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); } else chunks.push(d); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://gate');
  const route = ROUTES.find(r => url.pathname === r.prefix || url.pathname.startsWith(`${r.prefix}/`));
  if (!route) return send(res, 404, 'no such service');
  const rest = url.pathname.slice(route.prefix.length) || '/';
  const health = req.method === 'GET' && /^\/health\/?$/.test(rest);
  const body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req, route.maxBody);
  let who = 'health';
  if (!health) {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (bearer && MASTER && same(bearer, MASTER)) who = 'master';
    else if (bearer && !req.headers[DEVICE_HEADER]) return send(res, 401, 'wrong API key');
    else {
      const { id } = verifyDeviceRequest(req.headers[DEVICE_HEADER], { method: req.method, target: url.pathname + url.search, body }, { seen });
      const a = await allowed(id);
      if (!a.ok) { log(`${req.method} ${url.pathname} ${short(id)} → 403 ${a.why}`); return send(res, 403, a.why); }
      if (req.method === 'POST') {
        const wait = rate(route, id);
        if (wait) { log(`${route.name} ${short(id)} → 429 (${route.limit.n}/${route.limit.ms / 1000}s)`); return send(res, 429, `too many ${route.name} requests from this device — try again in ${wait} s`, { 'Retry-After': String(wait) }); }
      }
      who = `${short(id)} [${a.teams.join(',')}]`;
    }
  }
  const t0 = Date.now();
  const up = new URL((route.strip ? rest : url.pathname) + url.search, route.upstream);
  const headers = { ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}), ...(req.headers.accept ? { Accept: req.headers.accept } : {}),
    ...(MASTER ? { Authorization: `Bearer ${MASTER}` } : {}), 'Content-Length': String(body.length) };
  let first = 0, left = false;   // ms to the upstream's headers; the client hung up before the answer was sent
  await new Promise((resolve) => {
    const u = http.request(up, { method: req.method, headers }, (ur) => {
      first = Date.now() - t0;
      const h = { ...ur.headers }; delete h.connection; delete h['transfer-encoding'];
      res.writeHead(ur.statusCode || 502, h);
      ur.pipe(res);
      ur.on('end', resolve); ur.on('error', resolve);
    });
    u.on('error', (e) => { send(res, 502, `upstream ${route.name}: ${e.code || e.message}`); resolve(); });
    res.on('close', () => { if (!res.writableEnded) { left = true; u.destroy(); } resolve(); });   // the client left: stop the model
    u.end(body);
  });
  // A client that gives up (a bot's ~4.5 s move budget) must not read as "200" — the model was too slow for it.
  if (!health) log(`${req.method} ${url.pathname} ${who} → ${left ? `CLIENT GAVE UP after ${Date.now() - t0} ms (${first ? `model answered headers at ${first} ms` : 'model had not answered'})` : `${res.statusCode} ${Date.now() - t0} ms`}`);
}

export function startGate({ port = PORT, host = HOST } = {}) {
  const srv = http.createServer((req, res) => {
    handle(req, res).catch((e) => send(res, e.status || 500, e.status ? e.message : 'gate error'));
  });
  // a long generation streams for many minutes: no server-side request timeout
  srv.requestTimeout = 0; srv.headersTimeout = 60_000;
  return new Promise((resolve) => srv.listen(port, host, () => { log(`llm-gate on ${host}:${srv.address().port} repo=${REPO} key=${MASTER ? 'set' : 'MISSING'}`); resolve(srv); }));
}
export const reloadKey = () => { MASTER = readKey(); return !!MASTER; };

if (import.meta.url === `file://${process.argv[1]}`) {
  await loadOwners();
  log(`owners: ${owners.ids.size} device id(s) in teams/*${owners.error ? ` (error: ${owners.error})` : ''}`);
  await startGate();
  process.on('SIGHUP', () => log(`SIGHUP: key ${reloadKey() ? 'reloaded' : 'MISSING'}`));
}
