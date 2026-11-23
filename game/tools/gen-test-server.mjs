#!/usr/bin/env node
// The OCI test service for generated drafts (2026-11-23, user: "phone talks to OCI only"): a phone cannot host the
// private test game, so it sends the draft here and polls. Runs tools/effect-gen-test.mjs (the same private Test Random
// game the desktop runs; the review by the local 8B) — ONE test at a time, low priority (systemd Nice / CPUWeight).
// Reached as https://<host>/gen-test/* through Caddy (infra/oci/gentest-setup.sh), same Bearer key as /llm and /llm-big.
//   GET  /health                 → { ok, busy }
//   POST /tests   { def }        → 202 { id } | 400 the validator refuses it | 401 | 409 busy (one at a time) | 413
//   GET  /tests/<id>             → { id, state: running|done, status: "[test] …", result? }
// The def must pass the same validator a peer runs on a foreign effect (effect-gen.mjs checkDraft) before a game starts.
// Results are kept 6 h (at most 30). Env: PORT (8097), HOST (127.0.0.1), GEN_TEST_KEY_FILE (/etc/chaosd6-llm/api-key),
// GEN_TEST_DIR (<tmp>/chaosd6-gentest-srv), GEN_TEST_MINUTES (3), LLM_BIG_URL (http://127.0.0.1:8096, the review).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkDraft } from '../effect-gen.mjs';
import { checkSkillDraft } from '../skill-gen.mjs';
import { checkClassDraft } from '../class-gen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT || 8097);
const HOST = process.env.HOST || '127.0.0.1';
const KEY_FILE = process.env.GEN_TEST_KEY_FILE || '/etc/chaosd6-llm/api-key';
const DIR = process.env.GEN_TEST_DIR || path.join(os.tmpdir(), 'chaosd6-gentest-srv');
const MINUTES = Math.max(1, Math.min(10, Number(process.env.GEN_TEST_MINUTES) || 3));
const BODY_MAX = 256 * 1024;
const KEEP_MS = 6 * 3600_000, KEEP_N = 30;
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
const readKey = () => { try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; } };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const tests = new Map();   // id → { id, state, status, result, at, child }
let running = null;
function prune() {
  const all = [...tests.values()].filter(t => t.state === 'done').sort((a, b) => b.at - a.at);
  for (const [i, t] of all.entries()) if (i >= KEEP_N || Date.now() - t.at > KEEP_MS) tests.delete(t.id);
}

// The test games' logs/<gentest-…>/ and sessions/GenTest-…/ (tapes, saves) are kept a day, then removed — the VM disk is small.
function sweepGameDirs() {
  for (const [base, re] of [[path.join(GAME, 'logs'), /^gentest-/], [path.join(GAME, 'sessions'), /^GenTest-/], [path.join(GAME, 'saves'), /^GenTest-/i]]) {
    let names = [];
    try { names = fs.readdirSync(base).filter(n => re.test(n)); } catch { continue; }
    for (const n of names) {
      try { const p = path.join(base, n); if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600_000) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  }
}

function authOk(req) {
  const key = readKey();
  if (!key) return false;   // no key file → nothing is served (never open)
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got), b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function body(req) {
  if (!/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw Object.assign(new Error('Content-Type must be application/json'), { code: 415 });
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > BODY_MAX) throw Object.assign(new Error('body too large'), { code: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('body is not JSON'), { code: 400 }); }
}

function start(def) {
  const id = `t_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
  const file = path.join(DIR, `${id}.def.json`), out = path.join(DIR, `${id}.result.json`);
  fs.writeFileSync(file, JSON.stringify(def, null, 2) + '\n', { mode: 0o600 });
  const t = { id, state: 'running', status: '[test] 0:00 queued', result: null, at: Date.now(), def_id: def.id };
  const key = readKey();
  const env = { ...process.env, LLM_BIG_URL: process.env.LLM_BIG_URL || 'http://127.0.0.1:8096', ...(key ? { LLM_BIG_KEY: key } : {}) };
  const child = spawn(process.execPath, [path.join(HERE, 'effect-gen-test.mjs'), file, '--minutes', String(MINUTES), '--every', '10', '--out', out, '--review'],
    { cwd: GAME, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.child = child;
  let buf = '';
  const feed = (c) => { buf += c; let k; while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k); buf = buf.slice(k + 1); if (l.startsWith('[test] ') && !l.startsWith('[test] RESULT ')) t.status = l; } };
  child.stdout.setEncoding('utf8'); child.stdout.on('data', feed);
  child.stderr.setEncoding('utf8'); child.stderr.on('data', feed);
  child.on('exit', (code) => {
    try { t.result = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { t.result = { pass: false, why: [`the test runner exited with code ${code} and no result`] }; }
    t.state = 'done'; t.at = Date.now(); t.child = null;
    for (const f of [file, out]) { try { fs.rmSync(f, { force: true }); } catch {} }
    if (running === t) running = null;
    log(`test ${id} (${t.def_id}) done: ${t.result.pass ? 'PASS' : 'FAIL'}`);
    prune(); sweepGameDirs();
  });
  tests.set(id, t); running = t;
  log(`test ${id} (${def.id}) started`);
  return t;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname.replace(/^\/gen-test(?=\/|$)/, '') || '/';
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, busy: !!running });
    if (!authOk(req)) return send(res, 401, { ok: false, error: 'missing or wrong key' });
    if (req.method === 'POST' && p === '/tests') {
      if (running) return send(res, 409, { ok: false, error: 'busy: a test game is running (one at a time) — try again in a few minutes' });
      const b = await body(req);
      const def = b.def;
      if (!def || typeof def !== 'object' || !/^(effect|skill|class)_[a-z0-9_]{1,58}$/.test(String(def.id || ''))) return send(res, 400, { ok: false, error: 'def with an effect, skill or class id required' });
      const v = String(def.id).startsWith('skill_') ? await checkSkillDraft(def) : String(def.id).startsWith('class_') ? await checkClassDraft(def) : await checkDraft(def);
      if (!v.ok) return send(res, 400, { ok: false, error: `the validator refuses it (${v.verdict})`, problems: v.problems });
      if (running) return send(res, 409, { ok: false, error: 'busy' });
      const t = start(def);
      return send(res, 202, { ok: true, id: t.id });
    }
    const m = /^\/tests\/(t_[a-z0-9]{8,30})$/.exec(p);
    if (req.method === 'GET' && m) {
      const t = tests.get(m[1]);
      if (!t) return send(res, 404, { ok: false, error: 'no such test (results are kept 6 h)' });
      return send(res, 200, { ok: true, id: t.id, state: t.state, status: t.status, ...(t.result ? { result: t.result } : {}) });
    }
    send(res, 404, { ok: false, error: 'not found' });
  } catch (e) { send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { ok: false, error: e.message }); }
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { running?.child?.kill('SIGTERM'); } catch {} setTimeout(() => process.exit(0), 4000).unref(); server.close(); });
server.listen(PORT, HOST, () => log(`[gen-test] http://${HOST}:${PORT} (${MINUTES} min games, key ${readKey() ? 'set' : 'MISSING — every request is refused'})`));
