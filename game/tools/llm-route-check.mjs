// Offline checks for llm-route.mjs (AI skirmish routing: local → own team → OCI). No llama-server needed:
// askImpl / fetchImpl are fakes, the team transport is a fake and then a real two-node libp2p round trip.
//   node tools/llm-route-check.mjs   → "all llm-route checks passed"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadTeamAuth, remoteConfig, createLlmRouter, attachLlmRpc, isTeamMember, signLine, verifyLine, helloLine, askLine } from '../llm-route.mjs';

let fails = 0;
const ok = (c, msg) => { if (c) console.log(`ok   ${msg}`); else { fails++; console.log(`FAIL ${msg}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-route-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A profile dir: profile.json + radicle/identity.pem (the layout profile-radicle.mjs uses).
function device(name, team, ownersOf = null) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'radicle'), { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(dir, 'radicle', 'identity.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const file = path.join(dir, 'profile.json');
  fs.writeFileSync(file, JSON.stringify({ team_name: team, owners: [] }));
  return { name, file, setOwners(ids) { fs.writeFileSync(file, JSON.stringify({ team_name: team, owners: ids.map(id => ({ id, label: 'x', added_at: 0 })) })); } };
}
const desk = device('desk', 'MoonGuard'), phone = device('phone', 'MoonGuard'), rival = device('rival', 'MoonGuard'), stranger = device('stranger', 'MoonGuard');
const ids = Object.fromEntries([desk, phone, rival, stranger].map(d => [d.name, loadTeamAuth(d.file).id]));
// My team = desk + phone. The rival CLAIMS the same team name and lists itself; the stranger is not approved anywhere.
desk.setOwners([ids.desk, ids.phone]); phone.setOwners([ids.desk, ids.phone]); rival.setOwners([ids.rival, ids.desk]); stranger.setOwners([ids.desk, ids.phone]);
const auth = Object.fromEntries([desk, phone, rival, stranger].map(d => [d.name, loadTeamAuth(d.file)]));

// 1. identity
ok(/^z6Mk/.test(ids.desk) && ids.desk !== ids.phone, 'device ids from identity.pem (z6Mk…)');
ok(loadTeamAuth(path.join(tmp, 'nobody', 'profile.json')) === null && !fs.existsSync(path.join(tmp, 'nobody')), 'no key → null, and no key is created');
ok(isTeamMember(auth.desk) && isTeamMember(auth.phone) && !isTeamMember(auth.stranger), 'team member = my key among my team owners');
const line = helloLine('n1', 'srv', 'cli');
ok(verifyLine(ids.desk, line, signLine(auth.desk, line)) && !verifyLine(ids.phone, line, signLine(auth.desk, line)), 'sign / verify per device key');
ok(!verifyLine(ids.desk, helloLine('n2', 'srv', 'cli'), signLine(auth.desk, line)), 'signature bound to the nonce');

// 2. remote config
fs.writeFileSync(path.join(tmp, 'phone', 'llm.json'), JSON.stringify({ remote_url: 'https://oci.example/llm/', remote_key: 'k1' }));
const rc = remoteConfig({}, phone.file);
ok(rc.url === 'https://oci.example/llm' && rc.key === 'k1', 'remote from <profile dir>/llm.json');
ok(remoteConfig({ LLM_REMOTE_URL: '0' }, phone.file).url === '', 'LLM_REMOTE_URL=0 turns the remote off');
{   // only the OCI 8B's url + key (the phone's Drafts key form / a desktop without remote_*): the 1.7B on the same host
  const f = path.join(tmp, 'big-only.json');
  fs.writeFileSync(f, JSON.stringify({ big_url: 'https://oci.example/llm-big', big_key: 'kb' }));
  const r = remoteConfig({ LLM_REMOTE_FILE: f });
  ok(r.url === 'https://oci.example/llm' && r.key === 'kb', 'big_url/big_key only → remote …/llm with the same key (LLM_REMOTE_FILE, no profile)');
  fs.writeFileSync(f, JSON.stringify({ big_url: 'https://oci.example/llm-big', big_key: 'kb', remote_url: 'https://other.example/llm' }));
  ok(remoteConfig({ LLM_REMOTE_FILE: f }).key === '', 'the big key never goes to another host');
}

// Fake model: answers choice 2 after `delay` ms, or the error string.
const fakeAsk = (tag, { delay = 5, error = null, choice = 2 } = {}) => async (cfg, q) => {
  calls.push(`${tag}:${cfg.url}`);
  await sleep(Math.min(delay, q.timeoutMs));
  if (delay > q.timeoutMs) return { error: 'timeout', ms: q.timeoutMs };
  return error ? { error, ms: delay } : { choice, say: `${tag} says hi`, ms: delay };
};
let calls = [];
const healthy = async () => ({ ok: true });
const servers = new Map();
const fakeRequest = (fromId) => async (pid, msg) => {
  const s = servers.get(pid);
  if (!s) throw Object.assign(new Error('no direct link'), { code: 'NO_ROUTE' });
  return s.handle(JSON.parse(JSON.stringify(msg)));
};
const mkServer = (pid, a, opts = {}) => {
  const r = createLlmRouter({ cfg: { url: `http://${pid}`, model: 'm' }, auth: a, selfId: pid, serve: true, fetchImpl: healthy, askImpl: fakeAsk(pid, opts), serveSlots: opts.slots ?? 2 });
  servers.set(pid, r);
  return r;
};

// 3. serving needs a healthy local llama + team membership
const sDesk = mkServer('P-desk', auth.desk), sRival = mkServer('P-rival', auth.rival), sStr = mkServer('P-stranger', auth.stranger);
ok(!sDesk.serving(), 'not serving before the first /health');
await sDesk.checkLocal(); await sRival.checkLocal(); await sStr.checkLocal();
ok(sDesk.serving() && !sStr.serving(), 'serving after /health; a non-member device never serves');

// 4. phone ally: no local model, candidates desk + rival + stranger (all claim MoonGuard)
const logs = [];
const ally = createLlmRouter({ cfg: { url: '', model: 'm' }, auth: auth.phone, selfId: 'P-ally', request: fakeRequest('P-ally'),
  candidates: () => ['P-desk', 'P-rival', 'P-stranger', 'P-gone'], askImpl: fakeAsk('none'), log: (t) => logs.push(t) });
ok(!ally.available(), 'nothing verified, no local, no remote → not available (rules only, no asking)');
await ally.refreshTeam();
ok(ally.verified.has('P-desk') && !ally.verified.has('P-rival') && !ally.verified.has('P-stranger'), 'only the owner-listed teammate is verified (rival claiming the team name refused)');
ok(logs.some(l => /P-rival NOT verified/.test(l)), 'refusal logged');
calls = [];
let a = await ally.ask({ system: 's', user: 'u', n: 3, timeoutMs: 2000 });
ok(a.via === 'team:P-desk' && a.choice === 2 && calls.join() === 'P-desk:http://P-desk', `team answer via the teammate (${a.via})`);

// 5. the rival's node asks my teammate directly: denied
const rivalCli = createLlmRouter({ cfg: { url: '' }, auth: auth.rival, selfId: 'P-rcli', request: fakeRequest('P-rcli'), candidates: () => ['P-desk'], askImpl: fakeAsk('x') });
await rivalCli.refreshTeam();
const ra = await rivalCli.ask({ system: 's', user: 'u', n: 3, timeoutMs: 1000 });
ok(rivalCli.verified.size === 0 && /denied/.test(ra.error || ''), `a rival that lists MY key in its own owners is still denied by my node (${ra.error})`);
const h = await sDesk.handle({ op: 'hello', from: 'P-rcli', nonce: 'abc' });
const den = await sDesk.handle({ op: 'ask', from: 'P-rcli', id: ids.rival, sig: signLine(auth.rival, askLine(h.nonce_s, 'P-rcli', 'P-desk')), system: 's', user: 'u', n: 3, timeoutMs: 500 });
ok(den.op === 'denied' && sDesk.stats.denied === 2 && sDesk.stats.served === 1, 'my teammate refuses a rival key (denied)');
const forged = await sDesk.handle({ op: 'ask', from: 'P-rcli', id: ids.phone, sig: signLine(auth.rival, askLine(h.nonce_s, 'P-rcli', 'P-desk')), system: 's', user: 'u', n: 3, timeoutMs: 500 });
ok(forged.op === 'denied', 'claiming a teammate id without its key: denied');
const replay = await sDesk.handle({ op: 'ask', from: 'P-other', id: ids.phone, sig: signLine(auth.phone, askLine(h.nonce_s, 'P-rcli', 'P-desk')), system: 's', user: 'u', n: 3, timeoutMs: 500 });
ok(replay.op === 'denied', 'a teammate signature replayed from another peer: denied');
ok((await sDesk.handle({ op: 'ask', from: 'P-ally', id: ids.phone, sig: 'x', system: 's'.repeat(13000), user: 'u', n: 3 })).op === 'denied', 'bad signature first, before any size work');

// 6. busy → next route (remote)
const sSlow = mkServer('P-slow', auth.desk, { delay: 300, slots: 1 }); await sSlow.checkLocal();
const ally2 = createLlmRouter({ cfg: { url: '' }, remote: { url: 'https://oci', key: 'k' }, auth: auth.phone, selfId: 'P-ally2', request: fakeRequest('P-ally2'),
  candidates: () => ['P-slow'], askImpl: fakeAsk('oci') });
await ally2.refreshTeam();
const [r1, r2] = await Promise.all([ally2.ask({ system: 's', user: 'u', n: 3, timeoutMs: 2000 }), ally2.ask({ system: 's', user: 'u', n: 3, timeoutMs: 2000 })]);
ok(r1.via === 'team:P-slow' && r2.via === 'remote', `one slot: second ask gets busy → remote (${r1.via}, ${r2.via})`);
ok(ally2.rest.get('team:P-slow') > Date.now(), 'busy teammate rests a few seconds');

// 7. local first; a slow local leaves ~1/3 of the budget for the fallback
calls = [];
const order = [];
const slowLocal = createLlmRouter({ cfg: { url: 'http://local' }, remote: { url: 'https://oci', key: 'k' }, auth: null, selfId: 'P-x',
  askImpl: async (cfg, q) => { order.push([cfg.url, q.timeoutMs]); if (cfg.url === 'http://local') { await sleep(q.timeoutMs); return { error: 'timeout', ms: q.timeoutMs }; } return { choice: 1, say: '', ms: 3 }; } });
a = await slowLocal.ask({ system: 's', user: 'u', n: 2, timeoutMs: 3000 });
ok(a.via === 'remote' && order[0][1] === 1950 && order[1][1] >= 900 && order[1][1] <= 1060, `local 65 % (${order[0][1]} ms), remote the rest (${order[1][1]} ms)`);
const onlyLocal = createLlmRouter({ cfg: { url: 'http://local' }, auth: null, selfId: 'P-y', askImpl: async (c, q) => ({ choice: 1, say: '', ms: q.timeoutMs }) });
ok((await onlyLocal.ask({ system: 's', user: 'u', n: 2, timeoutMs: 3000 })).ms === 3000, 'local alone gets the whole budget');
const downAll = createLlmRouter({ cfg: { url: 'http://local' }, auth: null, selfId: 'P-z', askImpl: async () => ({ error: 'ECONNREFUSED', ms: 1 }) });
a = await downAll.ask({ system: 's', user: 'u', n: 2, timeoutMs: 1000 });
ok(a.error && a.down === true && downAll.rest.get('local') > Date.now(), 'unreachable local → down, rests 30 s');

// 8. a teammate's answer outside 1..n is rejected
const sBad = mkServer('P-bad', auth.desk, { choice: 7 }); await sBad.checkLocal();
const ally3 = createLlmRouter({ cfg: { url: '' }, auth: auth.phone, selfId: 'P-ally3', request: fakeRequest('P-ally3'), candidates: () => ['P-bad'], askImpl: fakeAsk('x') });
await ally3.refreshTeam();
a = await ally3.ask({ system: 's', user: 'u', n: 3, timeoutMs: 1000 });
ok(!!a.error, 'teammate choice 7 of 3 → not used');

// 9. same device (desktop bots share the hero's key): never a "team" route
const deskBot = createLlmRouter({ cfg: { url: 'http://127.0.0.1:8095' }, auth: loadTeamAuth(desk.file), selfId: 'P-bot', request: fakeRequest('P-bot'), candidates: () => ['P-desk'], askImpl: fakeAsk('x'), fetchImpl: healthy });
await deskBot.refreshTeam();
ok(!deskBot.verified.has('P-desk'), 'my own hero (same device key) is not a team route — it is the same llama as local');

// 10. owners re-read: the phone removed from the team → its next ask is denied, and it stops being a member
await sleep(20);
desk.setOwners([ids.desk]);
const den2 = await sDesk.handle({ op: 'ask', from: 'P-ally', id: ids.phone, sig: signLine(auth.phone, askLine((await sDesk.handle({ op: 'hello', from: 'P-ally', nonce: 'q' })).nonce_s, 'P-ally', 'P-desk')), system: 's', user: 'u', n: 3, timeoutMs: 500 });
ok(den2.op === 'denied', 'owners re-read from profile.json: a removed device is denied');
desk.setOwners([ids.desk, ids.phone]);

// 11. real libp2p: two nodes, direct stream, hello + ask
try {
  const { createLibp2p } = await import('libp2p');
  const { tcp } = await import('@libp2p/tcp');
  const { noise } = await import('@chainsafe/libp2p-noise');
  const { yamux } = await import('@chainsafe/libp2p-yamux');
  const node = () => createLibp2p({ addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] }, transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()] });
  const [n1, n2] = await Promise.all([node(), node()]);
  await n1.start(); await n2.start();
  const proto = '/chaos/dim-check/llm/1';
  const connTo = (lp) => (pid) => lp.getConnections().find(c => c.status === 'open' && c.remotePeer.toString() === pid) || null;
  let srv = null;
  await attachLlmRpc({ libp2p: n1, proto, openConnTo: connTo(n1), handle: (m) => srv.handle(m) });
  srv = createLlmRouter({ cfg: { url: 'http://desk' }, auth: loadTeamAuth(desk.file), selfId: n1.peerId.toString(), serve: true, fetchImpl: healthy, askImpl: fakeAsk('desk') });
  await srv.checkLocal();
  const req = await attachLlmRpc({ libp2p: n2, proto, openConnTo: connTo(n2) });
  const cli = createLlmRouter({ cfg: { url: '' }, auth: loadTeamAuth(phone.file), selfId: n2.peerId.toString(), request: req, candidates: () => [n1.peerId.toString()], askImpl: fakeAsk('x') });
  let noRoute = null;
  try { await req(n1.peerId.toString(), { op: 'hello' }, 500); } catch (e) { noRoute = e.code; }
  ok(noRoute === 'NO_ROUTE', 'no direct connection → NO_ROUTE (never a relay)');
  await n2.dial(n1.getMultiaddrs()[0]);
  await cli.refreshTeam();
  a = await cli.ask({ system: 's', user: 'u', n: 4, timeoutMs: 2000 });
  ok(a.via === `team:${n1.peerId}` && a.choice === 2, `libp2p round trip: ${a.via?.slice(0, 20)}… choice ${a.choice} in ${a.ms} ms`);
  await n1.stop(); await n2.stop();
} catch (e) { fails++; console.log(`FAIL libp2p round trip: ${e.stack || e.message}`); }

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `${fails} llm-route check(s) FAILED` : 'all llm-route checks passed');
process.exit(fails ? 1 : 0);
