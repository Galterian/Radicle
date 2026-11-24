// Offline checks for the OCI gatekeeper (infra/oci/llm-gate.mjs) and the client side (oci-auth.mjs, remoteConfig,
// genConfig, gen-jobs remoteTest). Fake upstreams on loopback, a throwaway git repo as chaosD6-Profiles.
//   node tools/llm-gate-check.mjs   → "all llm-gate checks passed"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { deviceSigner, authHeaders, verifyDeviceRequest, DEVICE_HEADER, OCI_URLS } from '../oci-auth.mjs';
import { remoteConfig } from '../llm-route.mjs';
import { genConfig } from '../effect-gen.mjs';

let fails = 0;
const ok = (c, msg) => { if (c) console.log(`ok   ${msg}`); else { fails++; console.log(`FAIL ${msg}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-gate-'));
const MASTER = 'master-' + crypto.randomBytes(8).toString('hex');

function device(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'radicle'), { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(dir, 'radicle', 'identity.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const file = path.join(dir, 'profile.json');
  fs.writeFileSync(file, JSON.stringify({ team_name: 'MoonGuard' }));
  return { dir, file, signer: deviceSigner(file) };
}
const owner = device('owner'), stranger = device('stranger'), allowed = device('allowed'), blocked = device('blocked');

// ---- the profiles repo: teams/MoonGuard owned by `owner` (+ `blocked`, which the deny list then refuses) --------------
const repo = path.join(tmp, 'profiles-work');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
fs.mkdirSync(repo);
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'profile.json'), JSON.stringify({ team_name: 'MoonGuard', owners: [{ id: owner.signer.id, label: 'desk' }, blocked.signer.id] }));
git('checkout', '-q', '-b', 'teams/MoonGuard'); git('add', 'profile.json'); git('commit', '-q', '-m', 'team');
fs.writeFileSync(path.join(tmp, 'key'), MASTER + '\n');
fs.writeFileSync(path.join(tmp, 'allow'), `# test\n${allowed.signer.id}\n`);
fs.writeFileSync(path.join(tmp, 'deny'), `${blocked.signer.id}\n`);

// ---- fake upstreams: record what they got; /v1/chat/completions on big streams SSE slowly -------------------------
const got = [];
function upstream(name) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', d => chunks.push(d));
      req.on('end', () => {
        got.push({ name, method: req.method, url: req.url, auth: req.headers.authorization || '', device: req.headers[DEVICE_HEADER] || '', body: Buffer.concat(chunks).toString() });
        if (req.url.endsWith('/health')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}'); }
        if (name === 'big' && req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          let i = 0;
          const t = setInterval(() => { res.write(`data: {"n":${i}}\n\n`); if (++i === 3) { clearInterval(t); res.end('data: [DONE]\n\n'); } }, 120);
          res.on('close', () => clearInterval(t));
          return;
        }
        res.writeHead(name === 'test' && req.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, from: name, id: 't1' }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const [upLlm, upBig, upTest] = await Promise.all(['llm', 'big', 'test'].map(upstream));
const portOf = (s) => s.address().port;
Object.assign(process.env, {
  KEY_FILE: path.join(tmp, 'key'), PROFILES_REPO: repo, ALLOW_FILE: path.join(tmp, 'allow'), DENY_FILE: path.join(tmp, 'deny'),
  UPSTREAM_LLM: `http://127.0.0.1:${portOf(upLlm)}`, UPSTREAM_BIG: `http://127.0.0.1:${portOf(upBig)}`, UPSTREAM_TEST: `http://127.0.0.1:${portOf(upTest)}`,
  LIMIT_BIG: '2/3600', OWNERS_TTL_MS: '60000',
});
const { startGate } = await import('../../infra/oci/llm-gate.mjs');
const gate = await startGate({ port: 0, host: '127.0.0.1' });
const G = `http://127.0.0.1:${gate.address().port}`;
const last = () => got[got.length - 1];

async function call(method, p, { body = '', signer = null, bearer = '', header = null, signAs = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (signer) headers[DEVICE_HEADER] = signer.sign(method, `${G}${signAs || p}`, body);
  if (header) headers[DEVICE_HEADER] = header;
  const r = await fetch(`${G}${p}`, { method, headers, ...(method === 'GET' ? {} : { body }) });
  return { status: r.status, text: await r.text(), headers: r.headers };
}
const chat = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });

// ---- gate ----------------------------------------------------------------------------------------------------------
let r = await call('GET', '/llm/health');
ok(r.status === 200 && last().url === '/health' && last().name === 'llm', 'health passes without auth, /llm prefix stripped');
r = await call('POST', '/llm/v1/chat/completions', { body: chat });
ok(r.status === 401 && /X-Chaos-Device/.test(r.text), `no key, no signature → 401 (${r.status})`);
r = await call('POST', '/llm/v1/chat/completions', { body: chat, bearer: 'wrong' });
ok(r.status === 401 && /wrong API key/.test(r.text), 'wrong master key → 401');
const n0 = got.length;
r = await call('POST', '/llm/v1/chat/completions', { body: chat, bearer: MASTER });
ok(r.status === 200 && got.length === n0 + 1 && last().auth === `Bearer ${MASTER}` && last().body === chat, 'master key passes, upstream gets the master key and the body');
r = await call('POST', '/llm/v1/chat/completions', { body: chat, signer: owner.signer });
ok(r.status === 200 && last().auth === `Bearer ${MASTER}` && last().url === '/v1/chat/completions' && !last().device, 'team owner device passes; upstream sees the master key, not the device header');
r = await call('POST', '/llm/v1/chat/completions', { body: chat, bearer: 'old-rotated-key', signer: owner.signer });
ok(r.status === 200 && last().auth === `Bearer ${MASTER}`, 'an old (rotated) key + a valid owner signature still passes');
r = await call('POST', '/llm/v1/chat/completions', { body: chat, signer: stranger.signer });
ok(r.status === 403 && /not an owner/.test(r.text), `a device of no team → 403 (${r.status})`);
r = await call('POST', '/llm/v1/chat/completions', { body: chat, signer: allowed.signer });
ok(r.status === 200, 'allow-list device passes');
r = await call('POST', '/llm/v1/chat/completions', { body: chat, signer: blocked.signer });
ok(r.status === 403 && /blocked/.test(r.text), 'deny list wins over team ownership');
{ // tampered body, wrong path, replay, expired
  const h = owner.signer.sign('POST', `${G}/llm/v1/chat/completions`, chat);
  r = await call('POST', '/llm/v1/chat/completions', { body: chat.replace('hi', 'ho'), header: h });
  ok(r.status === 401 && /body/.test(r.text), 'body changed after signing → 401');
  r = await call('POST', '/llm-big/v1/chat/completions', { body: chat, signer: owner.signer, signAs: '/llm/v1/chat/completions' });
  ok(r.status === 401 && /signature/.test(r.text), 'signature for another path → 401');
  const h2 = owner.signer.sign('POST', `${G}/llm/v1/chat/completions`, chat);
  r = await call('POST', '/llm/v1/chat/completions', { body: chat, header: h2 });
  const r2 = await call('POST', '/llm/v1/chat/completions', { body: chat, header: h2 });
  ok(r.status === 200 && r2.status === 401 && /replayed/.test(r2.text), 'the same signed request twice → second 401 replayed');
  const a = JSON.parse(Buffer.from(h2, 'base64').toString());
  let why = '';
  try { verifyDeviceRequest(h2, { method: 'POST', target: '/llm/v1/chat/completions', body: chat }, { now: a.ts + 6 * 60_000 }); } catch (e) { why = e.message; }
  ok(/expired/.test(why), 'a signature older than 5 min → expired');
  try { why = ''; verifyDeviceRequest(Buffer.from(JSON.stringify({ ...a, id: stranger.signer.id })).toString('base64'), { method: 'POST', target: '/llm/v1/chat/completions', body: chat }); } catch (e) { why = e.message; }
  ok(/signature/.test(why), 'another id on the same signature → bad signature');
}
{ // streaming through the gate (big), then the rate limit (2/h)
  const t0 = Date.now(), resp = await fetch(`${G}/llm-big/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', [DEVICE_HEADER]: owner.signer.sign('POST', `${G}/llm-big/v1/chat/completions`, chat) }, body: chat });
  const reader = resp.body.getReader(); let first = 0, text = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (!first) first = Date.now() - t0; text += Buffer.from(value).toString(); }
  ok(resp.status === 200 && /\[DONE\]/.test(text) && first < 300 && resp.headers.get('content-type') === 'text/event-stream', `SSE streams through (first chunk after ${first} ms)`);
  r = await call('POST', '/llm-big/v1/chat/completions', { body: chat, signer: owner.signer });
  const r3 = await call('POST', '/llm-big/v1/chat/completions', { body: chat, signer: owner.signer });
  ok(r.status === 200 && r3.status === 429 && Number(r3.headers.get('retry-after')) > 0, `3rd big request in the hour → 429 Retry-After (${r3.status})`);
  r = await call('POST', '/llm-big/v1/chat/completions', { body: chat, bearer: MASTER });
  ok(r.status === 200, 'the master key is not rate-limited');
}
r = await call('POST', '/gen-test/tests', { body: '{"def":{}}', signer: owner.signer });
ok(r.status === 202 && last().name === 'test' && last().url === '/gen-test/tests', 'gen-test keeps its path');
r = await call('GET', '/gen-test/tests/t1', { signer: owner.signer });
ok(r.status === 200 && last().url === '/gen-test/tests/t1', 'signed GET of a test status passes');
r = await call('GET', '/nope', { bearer: MASTER });
ok(r.status === 404, 'other paths → 404');

// ---- clients ---------------------------------------------------------------------------------------------------------
{ const h = authHeaders({ key: 'k', signer: owner.signer }, 'POST', 'https://x/llm'); ok(h.Authorization === 'Bearer k' && !!h[DEVICE_HEADER], 'authHeaders: key AND device signature on https'); }
ok(!!authHeaders({ signer: owner.signer }, 'POST', 'https://x/llm')[DEVICE_HEADER], 'authHeaders: no key → device signature on https');
ok(Object.keys(authHeaders({ signer: owner.signer }, 'POST', 'http://127.0.0.1:8095/v1')).length === 0, 'authHeaders: never signs to a plain-http (local) server');
{
  const rc = remoteConfig({}, owner.file);
  ok(rc.url === OCI_URLS.llm && rc.key === '' && rc.signer?.id === owner.signer.id, 'remoteConfig: no llm.json → OCI /llm, signed by this device');
  const none = remoteConfig({}, path.join(tmp, 'nobody', 'profile.json'));
  ok(none.url === '' && !none.signer, 'remoteConfig: no identity → no remote route');
  fs.writeFileSync(path.join(owner.dir, 'llm.json'), JSON.stringify({ remote_url: 'https://h.example/llm', remote_key: 'rk' }));
  const k = remoteConfig({}, owner.file);
  ok(k.url === 'https://h.example/llm' && k.key === 'rk', 'remoteConfig: llm.json still wins');
  fs.unlinkSync(path.join(owner.dir, 'llm.json'));
  const g = genConfig({ CHAOSD6_MOBILE: '1' }, { file: path.join(owner.dir, 'llm.json') });
  ok(g.url === OCI_URLS.big && !g.key && g.signer?.id === owner.signer.id, `genConfig (phone, no llm.json) → OCI /llm-big, device-signed (${g.url})`);
}
{
  const { createGenJobs } = await import('../gen-jobs.mjs').catch(() => ({}));
  if (createGenJobs) {
    const jobs = createGenJobs({ dir: path.join(tmp, 'jobs'), draftsDir: path.join(tmp, 'effect-drafts'), llmFile: path.join(owner.dir, 'llm.json'), env: { CHAOSD6_MOBILE: '1' } });
    const rt = jobs.remoteTest();
    ok(rt?.url === OCI_URLS.test && !rt.key && rt.signer?.id === owner.signer.id, 'gen-jobs remoteTest (phone, no llm.json) → OCI /gen-test, device-signed');
  } else console.log('skip gen-jobs remoteTest (no createGenJobs export)');
}

gate.close(); upLlm.close(); upBig.close(); upTest.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `${fails} llm-gate check(s) FAILED` : 'all llm-gate checks passed');
process.exit(fails ? 1 : 0);
