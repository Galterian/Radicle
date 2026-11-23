// Where a bot's llama-server request goes (AI skirmish routing, user ruling 2026-11-22):
//
//   1. local  — LLM_URL: this machine's llama-server (default http://127.0.0.1:8095, llm-brain.mjs llmConfig).
//   2. team   — a node of MY team that runs a model. A node proves it is my team by signing a challenge with its
//               device key (<profile dir>/radicle/identity.pem, the key profile sync lists in the team profile's
//               `owners`); my bot checks that id against MY team profile's owners. A self-declared team_name is not
//               enough. The prompt holds the bot's hand and legal plans, so it goes over a DIRECT libp2p stream only
//               (noise-encrypted to that node) — never the relay bus, which runs over public Nostr relays.
//               Opposing players' nodes never serve my bots (user ruling 2026-11-22): only a key in my team's owners.
//   3. remote — LLM_REMOTE_URL + LLM_REMOTE_KEY (or <profile dir>/llm.json {remote_url, remote_key}): the OCI seed's
//               /llm route (infra/oci/llm-setup.sh --public) — neutral infrastructure, HTTPS + an API key.
//
// Each step gets what is left of the planning budget; an unreachable / busy / refusing endpoint is skipped and rests
// a while. The answer is still only a pick among the options peer.mjs judged legal (llmApply); no answer = the rules.
//
// Serving (the node's human peer only, LLM_SERVE != '0'): /chaos/<dim>/llm/1 answers my team's bots from the local
// llama-server, at most LLM_SERVE_SLOTS (2) at a time — a full server answers `busy` at once so the bot moves on.
// Wire (one request frame, one reply frame; map-sync.mjs framing):
//   {op:'hello', from, nonce}                         → {op:'hello', from, id, team, nonce_s, sig}   sig over HELLO line
//   {op:'ask', from, id, sig, system, user, n, timeoutMs} → {op:'answer', choice, say, ms} | {op:'busy'} |
//                                                         {op:'denied', why} | {op:'error', error}   sig over ASK line
// Node 18 compatible, node:* only (+ llm-brain.mjs, map-sync.mjs framing, profile-auth.mjs ids).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { askLlm, SAY_MAX } from './llm-brain.mjs';
import { encodeFrame, createFrameDecoder } from './map-sync.mjs';
import { idFromPrivateKeyPem, rawPublicKeyFromId, ownerIds } from './profile-auth.mjs';

export const LLM_PROTO = (dimId) => `/chaos/${dimId}/llm/1`;
const DOMAIN = 'chaosd6-llm/1 ';
export const helloLine = (nonce, server, client) => `${DOMAIN}hello|${nonce}|${server}|${client}`;
export const askLine = (nonceS, client, server) => `${DOMAIN}ask|${nonceS}|${client}|${server}`;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_TEXT = 12_000;          // a planning prompt is ~1 KB; anything this big is not one
const MIN_TRY_MS = 500;           // less budget than this left: do not start another endpoint
const REST = { down: 30_000, busy: 4_000, denied: 300_000, timeout: 0 };
const VERIFIED_TTL_MS = 10 * 60_000;

// ---- identity: my device key + my team's owners, read-only (never creates a key) -------------------------------
// profileFile: the profile.json beside radicle/identity.pem (LLM_PROFILE_FILE, else PROFILE_FILE). null = no team route.
export function loadTeamAuth(profileFile) {
  if (!profileFile) return null;
  const keyFile = path.join(path.dirname(profileFile), 'radicle', 'identity.pem');
  try {
    const privateKeyPem = fs.readFileSync(keyFile, 'utf8');
    const auth = { id: idFromPrivateKeyPem(privateKeyPem), privateKeyPem, profileFile, team: '', owners: new Set(), mtime: 0 };
    refreshOwners(auth);
    return auth;
  } catch { return null; }
}
// Re-read the team + owners when profile.json changed (profile sync rewrites it as devices join).
export function refreshOwners(auth) {
  if (!auth?.profileFile) return auth;
  try {
    const st = fs.statSync(auth.profileFile);
    if (st.mtimeMs === auth.mtime) return auth;
    const p = JSON.parse(fs.readFileSync(auth.profileFile, 'utf8'));
    auth.team = String(p.team_name || '');
    auth.owners = new Set(ownerIds(p));
    auth.mtime = st.mtimeMs;
  } catch { /* keep the last good view */ }
  return auth;
}
// A team member: a team name and my own key among its owners (a device not yet approved is not one).
export const isTeamMember = (auth) => !!(auth && auth.team && auth.owners.has(auth.id));
export const signLine = (auth, line) => crypto.sign(null, Buffer.from(line), crypto.createPrivateKey(auth.privateKeyPem)).toString('base64');
export function verifyLine(id, line, sig) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, rawPublicKeyFromId(id)]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(line), key, Buffer.from(String(sig || ''), 'base64'));
  } catch { return false; }
}
// The id is one of MY team's owners and signed this line.
export const teamSigned = (auth, id, line, sig) => isTeamMember(auth) && auth.owners.has(id) && verifyLine(id, line, sig);

// <profile dir>/llm.json → { remote_url, remote_key } (the OCI route; written by the user, never committed).
// LLM_REMOTE_FILE = that llm.json for a bot without a profile (the skirmish rivals / builders, 2026-11-23).
// No remote_url: the OCI 8B's host (big_url …/llm-big → …/llm); no remote_key on that same host: big_key (one key on OCI).
export function remoteConfig(env = {}, profileFile = '') {
  let f = {};
  const file = env.LLM_REMOTE_FILE || (profileFile ? path.join(path.dirname(profileFile), 'llm.json') : '');
  try { if (file) f = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  const big = String(f.big_url || '').replace(/\/+$/, '');
  const derived = /\/llm-big$/.test(big) ? big.replace(/\/llm-big$/, '/llm') : '';
  const url = String(env.LLM_REMOTE_URL ?? f.remote_url ?? derived).replace(/\/+$/, '');
  let sameHost = false;
  try { sameHost = !!big && new URL(url).host === new URL(big).host; } catch {}
  return { url: url === '0' ? '' : url, key: String(env.LLM_REMOTE_KEY ?? f.remote_key ?? (sameHost ? f.big_key || '' : '')) };
}

const okAnswer = (a, n) => a && Number.isInteger(a.choice) && a.choice >= 1 && a.choice <= n && typeof a.say === 'string' && a.say.length <= SAY_MAX + 2;

// ---- transport: direct libp2p only ------------------------------------------------------------------------------
// handle(msg) → Promise<reply>. Returns request(peerId, msg, timeoutMs) → Promise<reply>; throws NO_ROUTE without a
// direct connection (the relay bus is never used for prompts).
export async function attachLlmRpc({ libp2p, proto, openConnTo, handle = null, maxInbound = 4, log = () => {} }) {
  if (handle) await libp2p.handle(proto, async (stream) => {
    const timer = setTimeout(() => stream.abort(new Error('llm rpc timeout')), 15_000);
    try {
      const dec = createFrameDecoder(64 * 1024);
      let req = null;
      for await (const chunk of stream) for (const m of dec.push(chunk instanceof Uint8Array ? chunk : chunk.subarray())) req ??= m;
      if (!req) throw new Error('empty llm request');
      const reply = await handle(req);
      const f = encodeFrame(reply || { op: 'error', error: 'no reply' });
      if (!stream.send(f)) await stream.onDrain();
      await stream.close();
    } catch (e) { try { stream.abort(e); } catch {} }
    finally { clearTimeout(timer); }
  }, { maxInboundStreams: maxInbound });
  return async function request(peerId, msg, timeoutMs) {
    const conn = openConnTo(peerId);
    if (!conn) throw Object.assign(new Error('no direct link'), { code: 'NO_ROUTE' });
    const ms = Math.max(200, timeoutMs | 0);
    const stream = await conn.newStream(proto, { signal: AbortSignal.timeout(ms) });
    const timer = setTimeout(() => stream.abort(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms);
    try {
      if (!stream.send(encodeFrame(msg))) await stream.onDrain();
      await stream.close();
      const dec = createFrameDecoder(64 * 1024);
      for await (const chunk of stream) for (const m of dec.push(chunk instanceof Uint8Array ? chunk : chunk.subarray())) return m;
      throw new Error('no reply');
    } finally { clearTimeout(timer); }
  };
}

// ---- the router --------------------------------------------------------------------------------------------------
// cfg: llmConfig (local url/key, model, …); remote: remoteConfig(); auth: loadTeamAuth() | null; selfId: my peer id;
// request: attachLlmRpc() result (or null: no team route); candidates(): peer ids that advertise llm_srv, are on my
// side and claim my team (the claim is only a filter — the signature decides); serve: answer my team's bots.
export function createLlmRouter({ cfg, remote = { url: '', key: '' }, auth = null, selfId, request = null, candidates = () => [],
  serve = false, serveSlots = 2, now = () => Date.now(), log = () => {}, askImpl = askLlm, fetchImpl = globalThis.fetch }) {
  const rest = new Map();              // endpoint key → until (ms)
  const verified = new Map();          // peer id → { id, nonce_s, at }
  const myNonce = new Map();           // client peer id → nonce_s I handed it (server side)
  const stats = { local: 0, team: 0, remote: 0, failed: 0, served: 0, busy: 0, denied: 0 };
  let inflight = 0, localOk = false, healthAt = -Infinity;   // not served / advertised before the first /health
  const resting = (k) => (rest.get(k) || 0) > now();
  const rested = (k, why) => { const ms = REST[why] ?? 0; if (ms) rest.set(k, now() + ms); };
  const kindOf = (err) => (/^timeout/.test(err) ? 'timeout' : /^(busy|http 503|http 429)/.test(err) ? 'busy'
    : /^(denied|http 401|http 403)/.test(err) ? 'denied' : /^(http|malformed)/.test(err) ? 'timeout' : 'down');

  async function checkLocal() {   // the local server's /health, at most every 30 s (serving + llm_srv depend on it)
    if (!cfg.url || now() - healthAt < 30_000) return localOk;
    healthAt = now();
    try { localOk = (await fetchImpl(`${cfg.url}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { localOk = false; }
    return localOk;
  }
  const serving = () => !!(serve && localOk && isTeamMember(refreshOwners(auth)));

  // Background: prove the candidates are my team (hello), outside any planning budget.
  async function refreshTeam() {
    await checkLocal();
    if (!request || !isTeamMember(refreshOwners(auth))) return;
    for (const pid of candidates()) {
      const v = verified.get(pid);
      if ((v && now() - v.at < VERIFIED_TTL_MS) || resting(`team:${pid}`)) continue;
      const nonce = crypto.randomBytes(16).toString('base64');
      try {
        const r = await request(pid, { op: 'hello', from: selfId, nonce }, 3000);
        if (r?.op === 'hello' && r.id === auth.id) { rested(`team:${pid}`, 'denied'); continue; }   // my own device: the same llama as `local`
        if (r?.op === 'hello' && r.from === pid && r.team === auth.team && typeof r.nonce_s === 'string' && teamSigned(auth, r.id, helloLine(nonce, pid, selfId), r.sig)) {
          if (!v) log(`team model at ${pid} (device ${String(r.id).slice(0, 12)}…, ${auth.team}) verified`);
          verified.set(pid, { id: r.id, nonce_s: r.nonce_s, at: now() });
        } else { verified.delete(pid); rested(`team:${pid}`, 'denied'); log(`team model at ${pid} NOT verified (not a key of ${auth.team}'s owners) — never used`); }
      } catch (e) { rested(`team:${pid}`, e.code === 'NO_ROUTE' ? 'down' : 'busy'); }
    }
  }

  async function askTeam(pid, q, ms) {
    const v = verified.get(pid);
    const msg = { op: 'ask', from: selfId, id: auth.id, sig: signLine(auth, askLine(v.nonce_s, selfId, pid)), system: q.system, user: q.user, n: q.n, timeoutMs: Math.max(200, ms - 150) };
    const t0 = now();
    try {
      const r = await request(pid, msg, ms);
      if (r?.op === 'answer' && okAnswer(r, q.n)) return { choice: r.choice, say: r.say, ms: now() - t0 };
      if (r?.op === 'denied') verified.delete(pid);
      return { error: r?.op === 'busy' ? 'busy' : r?.op === 'denied' ? `denied ${r.why || ''}` : r?.op === 'error' ? `timeout ${r.error || ''}` : 'malformed answer', ms: now() - t0 };
    } catch (e) { return { error: e.code === 'TIMEOUT' || e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : (e.code || e.message || 'error'), ms: now() - t0 }; }
  }

  // ask({system, user, n, timeoutMs}) → {choice, say, ms, via} | {error, ms, down}
  async function ask(q) {
    const t0 = now(), deadline = t0 + Math.max(0, q.timeoutMs | 0);
    const left = () => deadline - now();
    const team = request && isTeamMember(refreshOwners(auth)) ? candidates().filter(pid => verified.has(pid) && !resting(`team:${pid}`)) : [];
    const remoteOn = !!remote.url && !resting('remote');
    const errs = [];
    let anyUp = false;
    const note = (k, r) => { const kind = kindOf(r.error || ''); if (kind !== 'down') anyUp = true; rested(k, kind); errs.push(`${k} ${r.error}`); };
    // 1. local — the whole budget when it is the only route, else ~2/3 so a slow local still leaves a fallback.
    if (cfg.url && !resting('local')) {
      const ms = team.length || remoteOn ? Math.round(left() * 0.65) : left();
      const r = await askImpl(cfg, { ...q, timeoutMs: ms });
      if (r && !r.error) { stats.local++; return { ...r, via: 'local' }; }
      note('local', r || { error: 'none' });
    }
    // 2. team — verified nodes of my team, direct libp2p.
    for (const pid of team) {
      if (left() < MIN_TRY_MS) break;
      const r = await askTeam(pid, q, left());
      if (!r.error) { stats.team++; return { ...r, via: `team:${pid}` }; }
      note(`team:${pid}`, r);
    }
    // 3. remote — the OCI route.
    if (remoteOn && left() >= MIN_TRY_MS) {
      const r = await askImpl({ ...cfg, url: remote.url, key: remote.key }, { ...q, timeoutMs: left() });
      if (r && !r.error) { stats.remote++; return { ...r, via: 'remote' }; }
      note('remote', r || { error: 'none' });
    }
    stats.failed++;
    return { error: errs.join('; ') || 'no model route', ms: now() - t0, down: !anyUp };
  }
  const available = () => !!(cfg.url || remote.url || verified.size);   // a route worth asking exists

  // Server side: my team's bots ask through me.
  async function handle(m) {
    if (!m || typeof m !== 'object' || typeof m.from !== 'string') return { op: 'error', error: 'bad request' };
    if (!serving()) return { op: 'denied', why: 'not serving' };
    if (m.op === 'hello') {
      if (typeof m.nonce !== 'string' || m.nonce.length > 64) return { op: 'error', error: 'bad hello' };
      let n = myNonce.get(m.from);
      if (!n) { n = crypto.randomBytes(16).toString('base64'); myNonce.set(m.from, n); if (myNonce.size > 500) myNonce.delete(myNonce.keys().next().value); }
      return { op: 'hello', from: selfId, id: auth.id, team: auth.team, nonce_s: n, sig: signLine(auth, helloLine(m.nonce, selfId, m.from)) };
    }
    if (m.op !== 'ask') return { op: 'error', error: 'unknown op' };
    const n = myNonce.get(m.from);
    if (!n || !teamSigned(auth, m.id, askLine(n, m.from, selfId), m.sig)) { stats.denied++; return { op: 'denied', why: 'not my team' }; }
    if (typeof m.system !== 'string' || typeof m.user !== 'string' || m.system.length + m.user.length > MAX_TEXT || !Number.isInteger(m.n) || m.n < 2 || m.n > 9) return { op: 'error', error: 'bad ask' };
    if (inflight >= serveSlots) { stats.busy++; return { op: 'busy' }; }
    inflight++;
    try {
      const r = await askImpl(cfg, { system: m.system, user: m.user, n: m.n, timeoutMs: Math.min(Number(m.timeoutMs) || 0, 8000) });
      if (r && !r.error) { stats.served++; return { op: 'answer', choice: r.choice, say: r.say, ms: r.ms }; }
      return { op: 'error', error: r?.error || 'no answer' };
    } finally { inflight--; }
  }

  return { ask, available, refreshTeam, handle, serving, checkLocal, stats, verified, rest };
}
