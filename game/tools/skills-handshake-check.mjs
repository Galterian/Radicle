// S4 foreign-skill handshake checks (skills-handshake.mjs).
//   node tools/skills-handshake-check.mjs                    unit checks → "all skills handshake checks passed"
//   node tools/skills-handshake-check.mjs --write-fixture <f> write the test player-branch skill (Quick Dodge) for live runs
// Sections 3-7 use a stub of the S2 engine (records registerForeignSkill calls); section 8 runs the real one
// (skills.mjs registerForeignSkill + skillHook) on the fixture.
import fs from 'node:fs';
process.env.CHAOSD6_SKILLS_CACHE ||= 'memory';   // createSkPeer below: never touch the real cache
process.env.SK_HTTPD = '0';
import { encodeFrame, createFrameDecoder, createBusRpc } from '../map-sync.mjs';
import { canonicalJson, skillHash } from '../skills-repo.mjs';
import { fxKey, attachDefsRpc, foreignCardFromRef } from '../effects-handshake.mjs';   // FXG: foreignCardFromRef
import * as SKM from '../skills.mjs';
import {
  skillSetId, bundledSkillSet, makeSkRef, parseSkRef, compactRef, skKey, prefixOf, skillShape, skillsEngine,
  createSkStore, createSkSync, createMemoryCache, gateSkills, skMissingUnion, skillRefsByActor, createSkPeer, skProtocol,
  gateSkillSet,
} from '../skills-handshake.mjs';

let fails = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)?.slice(0, 160)}${ok ? '' : ` (want ${JSON.stringify(want)?.slice(0, 160)})`}`); };
const yes = (label, v) => eq(label, !!v, true);
const throws = (label, fn) => { try { fn(); eq(label, 'no throw', 'throws'); } catch { eq(label, 'throws', 'throws'); } };

// The test player-branch skill: Quick Dodge = the bundled Dodge definition (chaosd6.skill/1, S2) under its own id,
// i.e. a player branch of Dodge. S5 verdict ok; it uses skills_std, so the ref pins that lib.
const readJ = (u) => JSON.parse(fs.readFileSync(new URL(u, import.meta.url), 'utf8'));
const DODGE_FILE = readJ('../skills-data/skills/skill_dodge.json');
const STD = readJ('../skills-data/lib/skills_std.json');
// A player branch carries no built-in-only fields (skill isolation /2): not dealt (deal_order), no building slot /
// pass order / plan lock (part of the (seed,q,r) contract and the built-in fold), no card/ui block of Dodge's.
const BUILTIN_ONLY_FLAGS = ['buildingSkill', 'passOrder', 'planLock'];
const DODGE = (() => {
  const { deal_order, card, ui, ...d } = DODGE_FILE;
  d.flags = Object.fromEntries(Object.entries(d.flags || {}).filter(([k]) => !BUILTIN_ONLY_FLAGS.includes(k)));
  return d;
})();
export const QUICK_DODGE = { ...DODGE, id: 'skill_quick_dodge', name: 'Quick Dodge', version: '0.1.0', source: { collection: 'players', version: '0.1.0' }, extends: 'skill_dodge',
  text: 'One less combat damage to you this action (player branch of Dodge).' };
const wf = process.argv.indexOf('--write-fixture');
if (wf > 0) {
  const out = process.argv[wf + 1];
  fs.writeFileSync(out, JSON.stringify(QUICK_DODGE, null, 2) + '\n');
  console.log(`wrote ${out} (sha256 ${skillHash(QUICK_DODGE)})`);
  process.exit(0);
}
const MY_LIB = { id: 'sklib_t', version: '1.0.0', subs: { half: { params: ['x'], body: { '/': [{ var: 'x' }, 2] } } } };
const WITH_LIB = { ...QUICK_DODGE, id: 'skill_lib_dodge', uses: ['skills_std', 'sklib_t'] };
const MEGA = { ...QUICK_DODGE, id: 'skill_mega_dodge', flags: { ...QUICK_DODGE.flags, damageOff: 3 } };   // validator: out of bounds → reject

// Stub of the S2 engine: records registerForeignSkill calls.
function stubEngine() {
  const regs = [];
  return { regs, validate: null, isForeign: null, register: (key, id, flags, hooks, opts) => { regs.push({ key, id, flags, hooks, opts }); } };
}
const bundled = bundledSkillSet();

// ---------------------------------------------------------------- 1. set id stability
{
  const a = skillSetId({ libs: { std: 'a'.repeat(64) }, skills: { skill_x: 'c'.repeat(64), skill_a: 'd'.repeat(64) } });
  const b = skillSetId({ skills: { skill_a: 'd'.repeat(64), skill_x: 'c'.repeat(64) }, libs: { std: 'a'.repeat(64) } });
  eq('set id: key order never matters', a, b);
  yes('set id: another lib pin is another set', a !== skillSetId({ libs: { std: 'e'.repeat(64) }, skills: { skill_x: 'c'.repeat(64), skill_a: 'd'.repeat(64) } }));
  eq('bundled set id stable over two reads', bundledSkillSet().id, bundled.id);
  yes(`bundled set covers the 14 built-ins (${bundled.source})`, Object.keys(SKM.SKILL_RULES).every(id => bundled.builtinIds.has(id)));
  yes('a foreign id is not built-in', !bundled.builtinIds.has(QUICK_DODGE.id));
}

// ---------------------------------------------------------------- 2. refs carry libs
const REF = makeSkRef(QUICK_DODGE, [STD], { branch: 'players/ana/quick-dodge', commit: 'a'.repeat(40), verdict: 'ok' });
const REF_LIB = makeSkRef(WITH_LIB, [STD, MY_LIB]);
{
  eq('ref pins skills_std by hash', REF.libs, { skills_std: skillHash(STD) });
  eq('ref sha = sha256(canonical def)', REF.sha256, skillHash(QUICK_DODGE));
  eq('ref pins exactly the used libs', Object.keys(REF_LIB.libs), ['skills_std', 'sklib_t']);
  eq('parse(compact(ref)) round-trips', parseSkRef(compactRef(REF)), REF);
  throws('ref without libs rejected', () => parseSkRef({ ...REF, libs: undefined }));
  throws('ref with a bad lib sha rejected', () => parseSkRef({ ...REF, libs: { std: 'xyz' } }));
  throws('makeSkRef refuses an unpinnable lib', () => makeSkRef(WITH_LIB, [STD]));
  yes('skKey changes with a lib pin', skKey(REF_LIB) !== skKey({ ...REF_LIB, libs: { sklib_t: 'f'.repeat(64) } }));
  yes('skKey ignores provenance', skKey({ ...REF, branch: 'x', commit: '' }) === skKey(REF));
  yes('skKey ≠ fxKey of the same sha (own namespace)', skKey(REF) !== fxKey(REF));
  eq('skillShape reads top level or data', [skillShape(QUICK_DODGE).action_type, skillShape({ id: 'x', data: { action_type: 'B', is_permanent: true, point_buy_stat: 'vitality' } }).point_buy_stat], ['M', 'stat_vitality']);
}

// ---------------------------------------------------------------- mocked network
// libp2p: a real attachDefsRpc per node over an in-memory libp2p mock (streams = async queues), or the bus:
// createBusRpc pairs over a shared in-memory bus. Mirrors effects-handshake-check, plus the shared transport.
function queue() {
  const items = []; let ended = false, wake = null;
  return {
    push(x) { items.push(x); wake?.(); },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() { for (;;) { if (items.length) { yield items.shift(); continue; } if (ended) return; await new Promise(r => { wake = r; }); wake = null; } },
  };
}
function mockLibp2pNet() {
  const handlers = new Map();   // `${peer}|${proto}` -> fn
  const pair = () => { const c2s = queue(), s2c = queue(); return {
    client: { send: (b) => (c2s.push(b), true), onDrain: async () => {}, close: async () => c2s.end(), abort: () => { c2s.end(); s2c.end(); }, [Symbol.asyncIterator]: () => s2c[Symbol.asyncIterator]() },
    server: { send: (b) => (s2c.push(b), true), onDrain: async () => {}, close: async () => s2c.end(), abort: () => { c2s.end(); s2c.end(); }, [Symbol.asyncIterator]: () => c2s[Symbol.asyncIterator]() },
  }; };
  return {
    node: (id) => ({ handle: async (proto, fn) => { handlers.set(`${id}|${proto}`, fn); } }),
    connTo: (peer) => ({ newStream: async (proto) => { const h = handlers.get(`${peer}|${proto}`); if (!h) throw new Error(`protocol ${proto} not supported`); const p = pair(); h(p.server); return p.client; } }),
  };
}
function makeNet({ engineFor = () => stubEngine() } = {}) {
  const nodes = new Map(), blocked = new Set(), busNodes = new Map(), lp = mockLibp2pNet();
  const bus = { publish(ev) { setImmediate(() => { for (const [id, rpc] of busNodes) if (ev.to === id) rpc.deliver(ev); }); return 1; } };
  return {
    nodes, blocked,
    async add(id, { transport = 'libp2p', validate = null, engine = engineFor(id) } = {}) {
      const store = createSkStore({ bundled, validate, engine });
      const learned = [], shared = [];
      let rpc = null;
      const request = async (peer, msg) => {
        if (blocked.has(`${id}>${peer}`) || !nodes.has(peer)) throw Object.assign(new Error('no route'), { code: 'NO_ROUTE' });
        if (transport === 'bus') return busNodes.get(id).request(peer, msg);
        return rpc.request(peer, msg);
      };
      const sync = createSkSync({ selfId: id, store, cache: createMemoryCache(), request,
        onLearned: (p, src) => learned.push(src), onShared: (p, peer) => shared.push(peer) });
      busNodes.set(id, createBusRpc({ selfId: id, publish: (ev) => bus.publish(ev), handle: (m, o) => sync.handle(m, o), maxBytes: 24 * 1024 }));
      await attachDefsRpc({ proto: skProtocol('dim-s4unit'), busKind: 'sk', selfId: id, handle: (m, o) => sync.handle(m, o), libp2p: lp.node(id),
        openConnTo: (peer) => lp.connTo(peer), getBus: () => null, onTransport: (t) => { rpc = t; } });
      const n = { id, store, sync, learned, shared, engine };
      nodes.set(id, n);
      return n;
    },
  };
}

// ---------------------------------------------------------------- 3. fetch over mocked libp2p and the bus
{
  const net = makeNet();
  const A = await net.add('A'), B = await net.add('B');
  eq('A adopts its own skill', A.sync.adopt(QUICK_DODGE, REF, [STD]).status, 'ready');
  eq('A registered it with the engine', A.engine.regs.map(r => [r.id, r.key === skKey(REF), r.flags.damageOff, Object.keys(r.hooks), r.opts.uses, r.opts.libs.map(l => l.id), r.opts.meta.action_type]),
    [['skill_quick_dodge', true, 1, ['damage_in'], ['skills_std'], ['skills_std'], 'M']]);
  eq('B lacks it', B.store.status(REF), 'missing');
  eq('B fetches from the owner (libp2p /skills/1 stream)', await B.sync.ensure(compactRef(REF), { from: 'A' }), 'ready');
  eq('B learned from A', B.learned, ['A']);
  eq('A told it shared with B', A.shared, ['B']);
  eq('B announces it', B.sync.haveCsv(), `skill_quick_dodge@${prefixOf(REF.sha256)}`);
  eq('B registered it too (same key)', B.engine.regs.map(r => r.key), [skKey(REF)]);
  const net2 = makeNet();
  const A2 = await net2.add('A', { transport: 'bus' }), B2 = await net2.add('B', { transport: 'bus' });
  A2.sync.adopt(QUICK_DODGE, REF, [STD]);
  eq('fetch over the bus fallback', await B2.sync.ensure(REF, { from: 'A' }), 'ready');
  const A3 = await net.add('A3'), B3 = await net.add('B3');
  eq('a skill with its own lib adopts', A3.sync.adopt(WITH_LIB, REF_LIB, [STD, MY_LIB]).status, 'ready');
  eq('the lib comes along by hash', await B3.sync.ensure(REF_LIB, { from: 'A3' }), 'ready');
  yes('B3 holds the lib', B3.store.hasLib(skillHash(MY_LIB)));
  eq('registered with the def programs and both pinned libs', [canonicalJson(B3.engine.regs[0].hooks) === canonicalJson(WITH_LIB.hooks), B3.engine.regs[0].opts.libs.map(l => l.id).sort()], [true, ['skills_std', 'sklib_t']]);
}

// ---------------------------------------------------------------- 4. tamper / validator gate / local policy / ids
let checkSkill = null;
try { ({ checkSkill } = await import('./skills-rebalancing-check.mjs')); } catch (e) { console.log(`skip S5 validator (${e.message})`); }
{
  const net = makeNet();
  const E = await net.add('Evil'), A = await net.add('A'), B = await net.add('B');
  A.sync.adopt(QUICK_DODGE, REF, [STD]);
  const evil = { ...QUICK_DODGE, flags: { ...QUICK_DODGE.flags, damageOff: 2 } };
  const { blobFrames } = await import('../effects-handshake.mjs');
  E.sync.handle = (msg) => blobFrames('skill', evil).map(f => ({ ...f, sha: msg.sha }));
  eq('only Evil asked → missing', await B.sync.ensure(REF, { from: 'Evil' }), 'missing');
  eq('tamper counted', B.sync.stats().tampered, 1);
  B.sync.noteHolder(prefixOf(REF.sha256), 'Evil');
  eq('Evil then A → ready (from A)', await B.sync.ensure(REF, { from: 'A' }), 'ready');
  eq('B learned from A, not Evil', B.learned, ['A']);
  const mk = (o) => { const st = createSkStore({ bundled, engine: stubEngine(), ...o }); return st; };
  if (checkSkill) {
    yes(`S5 verdict on Quick Dodge is not reject (${checkSkill(QUICK_DODGE).verdict})`, checkSkill(QUICK_DODGE).verdict !== 'reject');
    const st = mk({ validate: (d) => checkSkill(d) }); st.addDef(MEGA);
    const p = st.prepare(makeSkRef(MEGA, [STD]));
    eq('S5 reject (damageOff 3 out of bounds) → refused', p.status, 'rejected');
    yes('…with the validator reason', /rebalance verdict reject/.test(p.reason));
  }
  const st1 = mk({ validate: () => ({ verdict: 'reject', reasons: ['SK_ACCEPT=0'] }) }); st1.addDef(QUICK_DODGE);
  eq('local refuse-all policy (SK_ACCEPT=0) → refused', st1.prepare(REF).status, 'rejected');
  const st2 = mk({ validate: () => { throw new Error('boom'); } }); st2.addDef(QUICK_DODGE);
  eq('validator error → refused (deterministic)', st2.prepare(REF).status, 'rejected');
  const st3 = mk({}); const dodgeVariant = { ...QUICK_DODGE, id: 'skill_dodge' }; st3.addDef(dodgeVariant);
  eq('a built-in id → refused (needs its own id)', st3.prepare(makeSkRef(dodgeVariant, [STD])).status, 'rejected');
  const st4 = createSkStore({ bundled, engine: null }); st4.addDef(QUICK_DODGE);
  eq('no program engine → refused', st4.prepare(REF).status, 'rejected');
  const st5 = mk({}); const other = { ...QUICK_DODGE, version: '0.2.0' }; st5.addDef(QUICK_DODGE); st5.addDef(other);
  eq('first def of an id → ready', st5.prepare(REF).status, 'ready');
  eq('a second def under the same id → refused', st5.prepare(makeSkRef(other, [STD])).status, 'rejected');
  const st7 = createSkStore({ bundled, engine: { ...stubEngine(), validate: () => ['hooks.damage_in: bad op'] } }); st7.addDef(QUICK_DODGE);
  eq('engine validateSkillDef errors → refused', st7.prepare(REF).status, 'rejected');
  const st8 = createSkStore({ bundled, engine: { ...stubEngine(), register: () => { throw new Error('bad'); } } }); st8.addDef(QUICK_DODGE);
  eq('registerForeignSkill throws → refused, never ready', st8.prepare(REF).status, 'rejected');
  const st6 = mk({}); st6.addDef(WITH_LIB);
  eq('a ref missing its lib bytes → missing', st6.prepare(REF_LIB).status, 'missing');
}

// ---------------------------------------------------------------- 5. have propagation A → B → C
{
  const net = makeNet();
  const A = await net.add('A'), B = await net.add('B'), C = await net.add('C');
  net.blocked.add('C>A');
  A.sync.adopt(QUICK_DODGE, REF, [STD]);
  const hA = A.sync.haveCsv();
  await Promise.all(B.sync.noteHave('A', hA));
  eq('B prefetched from A’s sk_have', B.store.status(REF), 'ready');
  await Promise.all(C.sync.noteHave('A', hA));
  eq('C cannot get it from A', C.store.status(REF), 'missing');
  C.sync.noteHave('B', B.sync.haveCsv());
  eq('C candidates: holder B before owner A', C.sync.candidates(prefixOf(REF.sha256), 'A'), ['B', 'A']);
  eq('C ensures the ref from A’s commit', await C.sync.ensure(REF, { from: 'A' }), 'ready');
  eq('C learned from B, not A', C.learned, ['B']);
  eq('B shared with C', B.shared, ['C']);
  eq('A never served C', A.shared, ['B']);
  eq('no prefetch for what C holds', C.sync.noteHave('B', B.sync.haveCsv()).length, 0);
}

// ---------------------------------------------------------------- 6. fallback determinism (strip rule)
{
  const net = makeNet();
  const A = await net.add('A'), B = await net.add('B'), C = await net.add('C');
  A.sync.adopt(QUICK_DODGE, REF, [STD]);
  await B.sync.ensure(REF, { from: 'A' });
  const wireRef = compactRef(REF);
  const mkReveals = () => [{ actor: 'A', action: 'M', skills: ['skill_powerful_attack', 'skill_quick_dodge'] }, { actor: 'B', action: 'A', skills: ['skill_powerful_attack'] }, { actor: 'C', action: 'EP', skills: [] }];
  const tapeWith = (missingBy) => [
    { type: 'evt_action_reveal', turn: 1, round: 0, actor_peer_id: 'A', payload: { skills: ['skill_powerful_attack', 'skill_quick_dodge'], sk_ref: [wireRef] } },
    { type: 'evt_action_reveal', turn: 1, round: 0, actor_peer_id: 'B', payload: { skills: ['skill_powerful_attack'] } },
    { type: 'evt_action_reveal', turn: 1, round: 0, actor_peer_id: 'C', payload: { skills: [], ...(missingBy === 'C' ? { sk_missing: [REF.sha256] } : {}) } },
  ];
  const isB = (id) => bundled.builtinIds.has(id);
  const gate = (n, tape) => { const rv = mkReveals(); const g = gateSkills(rv, skMissingUnion(rv, tape, 1, 0), (r) => n.store.status(r), skillRefsByActor(rv, tape, 1, 0), isB); return { rv, g }; };
  // (a) C reported missing → stripped on A, B and C alike (holders included), nobody abstains.
  const a = [A, B, C].map(n => gate(n, tapeWith('C')));
  const view = (x) => JSON.stringify({ tags: [...x.g.tags], abstain: x.g.abstain, skills: x.rv.map(r => r.skills), stripped: [...x.g.stripped] });
  eq('missing → stripped identically on A, B and C', a.map(view), a.map(() => view(a[0])));
  eq('the action resolves bare (built-in rider kept)', a[0].rv[0].skills, ['skill_powerful_attack']);
  eq('stripped tag', a[0].g.tags.get('A'), `stripped:${skKey(REF).slice(0, 16)}`);
  eq('nobody abstains when stripped', a.map(x => x.g.abstain), [false, false, false]);
  eq('stripped list names the owner and the skill', [...a[0].g.stripped], [['A', ['skill_quick_dodge']]]);
  // (b) nobody reported missing: holders keep it, the lacking peer strips + abstains (never guesses).
  const b = [A, B, C].map(n => gate(n, tapeWith(null)));
  eq('holders keep it with sk:<key16>', [b[0].g.tags.get('A'), b[1].g.tags.get('A')], [`sk:${skKey(REF).slice(0, 16)}`, `sk:${skKey(REF).slice(0, 16)}`]);
  eq('holders resolve the same skills', [b[0].rv[0].skills, b[1].rv[0].skills], [['skill_powerful_attack', 'skill_quick_dodge'], ['skill_powerful_attack', 'skill_quick_dodge']]);
  eq('lacking peer abstains', b.map(x => x.g.abstain), [false, false, true]);
  eq('lacking peer stripped it', b[2].rv[0].skills, ['skill_powerful_attack']);
  // (c) a foreign id with no ref (bonus plan, other build) is stripped by everyone, whatever they hold.
  const tapeNoRef = tapeWith(null).map(e => e.actor_peer_id === 'A' ? { ...e, payload: { ...e.payload, sk_ref: undefined } } : e);
  const c = [A, B, C].map(n => gate(n, tapeNoRef));
  eq('ref-less foreign id → stripped everywhere, no abstain', c.map(x => [x.rv[0].skills, x.g.tags.get('A'), x.g.abstain]), c.map(() => [['skill_powerful_attack'], 'bad:skill_quick_dodge', false]));
  // (d) built-in only: untouched (same array object), no tags → the state hash region gets no `sk` field.
  const rv = [{ actor: 'B', skills: ['skill_dodge', 'skill_bluff'] }]; const arr = rv[0].skills;
  const g = gateSkills(rv, new Set(), () => 'missing', new Map(), isB);
  yes('built-in only: no tags, nothing stripped, same array', g.tags.size === 0 && g.stripped.size === 0 && rv[0].skills === arr && !g.abstain);
  // (e) the holders' runs of the registered hook are byte-identical.
  eq('holders register the same program bytes under the same key', [canonicalJson(A.engine.regs[0].hooks) === canonicalJson(B.engine.regs[0].hooks), A.engine.regs[0].key === B.engine.regs[0].key], [true, true]);
}

// ---------------------------------------------------------------- 7. the peer adapter (forced card, gate, mine)
{
  const eng = stubEngine();
  const reg = await createSkPeer({ selfId: 'peer:T', dimId: 'dim-s4unit', log: () => {}, engine: eng, validate: checkSkill ? (d) => checkSkill(d) : null });
  const tmp = `${process.env.TMPDIR || '/tmp'}/_s4_qd_${process.pid}.json`;
  fs.writeFileSync(tmp, JSON.stringify(QUICK_DODGE));
  const card = reg.forcedCard(tmp);
  fs.unlinkSync(tmp);
  yes('forced card is a foreign skill card', card?.kind === 'skill' && card.skill_id === 'skill_quick_dodge' && card.requires === 'M' && card.sk?.sha256 === REF.sha256 && card.tags.includes('foreign'));
  eq('card source is a skill ref (S6 badge)', [card.source.kind, card.source.branch], ['skill', 'players/local/quick-dodge']);
  eq('engine registration', eng.regs.map(r => r.id), ['skill_quick_dodge']);
  eq('snapshot announces it', reg.snapshotFields(), { sk_have: `skill_quick_dodge@${prefixOf(REF.sha256)}` });
  eq('skillData of the foreign id', reg.skillData('skill_quick_dodge'), { action_type: 'M', is_permanent: false, point_buy_stat: null, name: 'Quick Dodge', text: QUICK_DODGE.text });
  eq('forced card pins skills_std', card.sk.libs, { skills_std: skillHash(STD) });
  eq('skillData of a built-in is not mine', reg.skillData('skill_dodge'), undefined);
  const myReveal = { skillRefs: [card.sk], skMissing: null };
  const tape = [{ type: 'evt_action_reveal', turn: 2, round: 1, actor_peer_id: 'peer:U', payload: { skills: [], sk_missing: [REF.sha256] } }];
  const rv = [{ actor: 'peer:T', action: 'M', skills: ['skill_quick_dodge'] }, { actor: 'peer:U', action: 'EP', skills: [] }];
  yes('needsGate with my foreign rider', reg.needsGate(rv, tape, { turn: 2, round: 1, myReveal }));
  const pr = await reg.prepareResolution(rv, tape, { turn: 2, round: 1, self: 'peer:T', myReveal });
  eq('my skill stripped when a revealer lacks it', [pr.mine, rv[0].skills, pr.abstain], [['skill_quick_dodge'], [], false]);
  const rv2 = [{ actor: 'peer:T', action: 'M', skills: ['skill_quick_dodge'] }];
  const pr2 = await reg.prepareResolution(rv2, [], { turn: 2, round: 2, self: 'peer:T', myReveal });
  eq('…and rides once nobody lacks it', [pr2.mine, rv2[0].skills, pr2.abstain], [[], ['skill_quick_dodge'], false]);
  const plain = [{ actor: 'x', skills: ['skill_dodge'] }];
  eq('built-in play: needsGate false', reg.needsGate(plain, [{ type: 'evt_action_reveal', turn: 0, round: 0, actor_peer_id: 'x', payload: { skills: ['skill_dodge'] } }], { turn: 0, round: 0, myReveal: { skillRefs: [] } }), false);
  // A peer that cannot run the program engine refuses → its reveal lists the sha → stripped everywhere.
  const noEng = await createSkPeer({ selfId: 'peer:N', dimId: 'dim-s4unit', log: () => {}, engine: null, validate: null });
  noEng.sync.noteHolder(prefixOf(REF.sha256), 'peer:T');
  const tapeC = [{ type: 'evt_action_commit', turn: 3, round: 0, actor_peer_id: 'peer:T', payload: { sk_ref: [card.sk] } }];
  noEng.store.addDef(QUICK_DODGE);   // bytes present, engine absent
  eq('peer without the engine lists it in sk_missing', await noEng.missingForReveal(tapeC, 3, 0), [REF.sha256]);
}

// ---------------------------------------------------------------- 8. real S2 engine (skills.mjs)
{
  const real = skillsEngine();
  if (!real) { fails++; console.log('FAIL skills.mjs has no registerForeignSkill (S2)'); }
  else {
    const st = createSkStore({ bundled, engine: real });
    st.addDef(QUICK_DODGE);
    eq('real engine: Quick Dodge prepares (validateSkillDef + registerForeignSkill)', st.prepare(REF).status, 'ready');
    yes('real engine: isForeignSkillId', real.isForeign('skill_quick_dodge'));
    // The resolver's damage_in call (peer.mjs passes 'skill_dodge') folds the registered foreign skill in.
    const run = (skills) => { const damage = new Map([['B', [{ source: 'action', amount: 3, attacker: 'A' }]]]); const r = { actor: 'B', skills };
      const ctx = { byActorPre: new Map([['B', r]]), skillFx: [], reveals: [r] }; SKM.skillHook('damage_in', 'skill_dodge', ctx, { damage }); return [damage.get('B')[0].amount, ctx.skillFx.map(f => f.skill)]; };
    eq('Quick Dodge riding: one less damage (3 -> 2)', run(['skill_quick_dodge']), [2, ['skill_quick_dodge']]);
    eq('stripped (bare action): full damage', run([]), [3, []]);
    const st2 = createSkStore({ bundled, engine: real }); const bad = { ...QUICK_DODGE, id: 'skill_bad_dodge', hooks: { damage_in: { no_such_op: [] } } }; st2.addDef(bad);
    eq('real engine: invalid program refused', st2.prepare(makeSkRef(bad, [STD])).status, 'rejected');
    SKM.clearForeignSkills?.();
  }
}

// ---------------------------------------------------------------- 9. FXG: foreign death-card gifts / profile cards {kind:'skill', id, ref}
{
  const net = makeNet();
  const A = await net.add('A'), B = await net.add('B'), C = await net.add('C');
  const R = await net.add('R', { validate: () => ({ verdict: 'reject', reasons: ['too strong'] }) });
  A.sync.adopt(QUICK_DODGE, REF, [STD]);
  await B.sync.ensure(REF, { from: 'A' });
  const tool = await createSkPeer({ selfId: 'peer:G', dimId: 'dim-fxg', log: () => {}, engine: stubEngine(), validate: null });
  const cardFor = tool.cardFor;
  const gift = { kind: 'skill', id: 'skill_quick_dodge', ref: compactRef(REF) };
  const fc = (x, n, o = {}) => foreignCardFromRef(x, { store: n.store, sync: n.sync, parseRef: parseSkRef, cardFor, from: 'A', ...o });
  const ra = await fc(gift, B);
  eq('skill gift in store → ready, held (src = where it came from)', [ra.status, ra.held, ra.src], ['ready', true, 'A']);
  yes('skill gift card = the foreign skill card (sk ref, requires M)', ra.card?.kind === 'skill' && ra.card.skill_id === 'skill_quick_dodge' && ra.card.requires === 'M' && ra.card.sk?.sha256 === REF.sha256 && ra.card.tags.includes('foreign'));
  const rb = await fc(gift, C);
  eq('skill gift needs fetch → ready from the giver', [rb.status, rb.src, C.learned], ['ready', 'A', ['A']]);
  eq('C registered it with its engine', C.engine.regs.map(r => r.key), [skKey(REF)]);
  eq('skill gift refused by the validator → rejected, no card', [(await fc(gift, R)).status, R.engine.regs.length], ['rejected', 0]);
  const D = await net.add('D'); net.blocked.add('D>A');
  eq('skill gift from an unreachable giver → missing', (await fc(gift, D)).status, 'missing');
  eq('skill gift ref for another id → bad', (await fc({ ...gift, id: 'skill_dodge' }, C)).status, 'bad');
  // Cache first (profile reload): the content cache holds the def → ready without any transport.
  const cache = createMemoryCache(); cache.put(QUICK_DODGE);
  const eng = stubEngine(), st = createSkStore({ bundled, engine: eng });
  const sy = createSkSync({ selfId: 'P', store: st, cache, request: null });
  const rf = await foreignCardFromRef(gift, { store: st, sync: sy, parseRef: parseSkRef, cardFor, timeoutMs: 500 });
  eq('skill profile card from the cache → ready, src cache', [rf.status, rf.src, eng.regs.length], ['ready', 'cache', 1]);
  // The adapter: a refused gift posts the `missing` skill_source notice.
  const uiSeen = [];
  const pe = await createSkPeer({ selfId: 'peer:H', dimId: 'dim-fxg', log: () => {}, engine: stubEngine(), validate: () => ({ verdict: 'reject', reasons: ['no'] }), ui: (m) => uiSeen.push(m) });
  pe.store.addDef(QUICK_DODGE);
  eq('adapter: refused skill gift → rejected', (await pe.cardFromRef(gift, { from: 'peer:X' })).status, 'rejected');
  eq('adapter: refused → UI notice', uiSeen.map(m => [m.kind, m.event, m.ref?.id, m.ref?.kind]), [['skill_source', 'missing', 'skill_quick_dodge', 'skill']]);
}

// ---------------------------------------------------------------- RF. a refuser's summoned companions refuse too (ruling 2026-11-19)
// (logs/swarm-0421: P-Agent5 refused Quick Dodge, P-Agent5-sum1 learned it from ally-1)
{
  const sel = await import('../foreign-select.mjs');
  const KEYS = ['FOREIGN_REFUSERS', 'FOREIGN_HOLDERS', 'FOREIGN_ORDER', 'OWNER_PEER_ID', 'PEER_LABEL', 'SK_ACCEPT'];
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  const setEnv = (o) => { for (const k of KEYS) delete process.env[k]; for (const [k, v] of Object.entries(o)) if (v !== undefined) process.env[k] = v; };
  const as = async (label, env = {}) => {
    setEnv({ FOREIGN_REFUSERS: 'P-Agent5', PEER_LABEL: label, ...env });
    const lines = [], p = await createSkPeer({ selfId: `peer:${label}`, label, dimId: 'dim-rf', log: (l) => lines.push(l), validate: null });
    p.store.addDef(QUICK_DODGE);
    return { refused: p.store.prepare(REF).status === 'rejected', role: sel.foreignRole(label), why: lines.find(l => / validator /.test(l))?.replace(/.* validator /, '') };
  };
  eq('RF: the listed refuser refuses Quick Dodge', await as('P-Agent5'), { refused: true, role: 'refuser', why: 'FOREIGN_REFUSERS (refuse all)' });
  eq('RF: its companion P-Agent5-sum1 refuses it too', await as('P-Agent5-sum1', { OWNER_PEER_ID: 'peer:P-Agent5' }), { refused: true, role: 'refuser', why: 'FOREIGN_REFUSERS (refuse all)' });
  eq('RF: a companion of that companion refuses too', (await as('P-Agent5-sum1-sum1', { OWNER_PEER_ID: 'peer:P-Agent5-sum1' })).refused, true);
  eq('RF: a companion of a non-refuser does not refuse', (await as('P-Agent4-sum1', { OWNER_PEER_ID: 'peer:P-Agent4' })).refused, false);
  eq('RF: SK_ACCEPT=0 inherited by the companion env → refuses', await as('P-Agent4-sum2', { OWNER_PEER_ID: 'peer:P-Agent4', SK_ACCEPT: '0' }), { refused: true, role: 'all', why: 'SK_ACCEPT=0 (refuse all)' });
  setEnv(saved);
}

// ---------------------------------------------------------------- VG. built-in skills by reference — the skill version gate (twin of effects F9)
{
  const mine = bundled.id.slice(0, 16);
  // The set comes from the definition files only (no data/skills.json, no SKILL_RULES table fallback).
  const files = fs.readdirSync(new URL('../skills-data/skills/', import.meta.url)).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();
  eq('VG bundle: source = the definition files', bundled.source, 'files');
  eq('VG bundle: no bundle errors', bundled.errors, []);
  eq('VG bundle: set hashes every definition file', Object.keys(bundled.set.skills), files);
  yes('VG bundle: every sha = skillHash(the whole file, card/ui included)', files.every(id => bundled.set.skills[id] === skillHash(readJ(`../skills-data/skills/${id}.json`))));
  eq('VG bundle: builtinIds = the definitions bundle', [...bundled.builtinIds].sort(), files);
  const os = await import('node:os'), path = await import('node:path');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-vg-'));
  fs.mkdirSync(path.join(empty, 'skills')); fs.mkdirSync(path.join(empty, 'lib'));
  fs.copyFileSync(new URL('../skills-data/lib/skills_std.json', import.meta.url), path.join(empty, 'lib', 'skills_std.json'));
  const none = bundledSkillSet(empty);
  eq('VG bundle: no definition files → error state (source none, no built-ins, an error line)', [none.source, none.builtinIds.size, /no skill definition files/.test(none.errors[0] || '')], ['none', 0, true]);
  yes('VG bundle: that build\'s pin differs from a healthy one', none.id.slice(0, 16) !== mine);
  fs.rmSync(empty, { recursive: true, force: true });

  eq('VG gate: same pin everywhere → no abstain', gateSkillSet([{ id: 'peer:b', sk_set: mine }, { id: 'peer:a', sk_set: mine }], mine), { abstain: false, mismatches: [], unknown: [] });
  eq('VG gate: another pin → abstain (sorted by unit); no pin on a Gun slim record = unknown, not a mismatch',
    gateSkillSet([{ id: 'peer:z', sk_set: '0123456789abcdef', full: true }, { id: 'peer:m', sk_set: mine, full: true }, { id: 'peer:c', full: false }, { id: 'peer:b', sk_set: 'ffffffffffffffff', full: false }], mine),
    { abstain: true, mismatches: [{ unit: 'peer:b', got: 'ffffffffffffffff', want: mine }, { unit: 'peer:z', got: '0123456789abcdef', want: mine }], unknown: ['peer:c'] });
  eq('VG gate: only slim pinless units → no abstain', gateSkillSet([{ id: 'peer:c', full: false }, { id: 'peer:d', sk_set: '', full: false }], mine).abstain, false);
  eq('VG gate: a FULL snapshot without a pin → mismatch', gateSkillSet([{ id: 'peer:x', full: true }], mine), { abstain: true, mismatches: [{ unit: 'peer:x', got: null, want: mine }], unknown: [] });
  eq('VG gate: alone in my view → no abstain', gateSkillSet([], mine).abstain, false);
  const emptyPerms = { permanents_csv: '' };   // a fresh monster: a full snapshot, no permanents, (here) no sk_set
  eq('VG gate: a full snapshot with an empty permanents_csv and no sk_set → mismatch', gateSkillSet([{ id: 'peer:y', sk_set: emptyPerms.sk_set || null, full: emptyPerms.permanents_csv !== undefined }], mine).abstain, true);

  // The adapter: log + UI once per unit|pin, returns the gate result.
  const lines = [], seen = [];
  const pg = await createSkPeer({ selfId: 'peer:V', dimId: 'dim-vg', log: (l) => lines.push(l), ui: (m) => seen.push(m), nameOf: (id) => (id === 'peer:z' ? 'Zed' : null), engine: stubEngine(), validate: null });
  eq('VG adapter: want = my 16-hex set pin', pg.setId.slice(0, 16), mine);
  const units = [{ id: 'peer:z', sk_set: '0123456789abcdef', full: true }, { id: 'peer:x', full: true }, { id: 'peer:c', full: false }, { id: 'peer:m', sk_set: mine, full: true }];
  const r1 = pg.gateBuiltins(units, { turn: 4, round: 1 });
  eq('VG adapter: returns the gate result', r1, gateSkillSet(units, mine));
  const vl = () => lines.filter(l => l.startsWith('SKILL VERSION GATE'));
  eq('VG adapter: one log line per mismatching unit', vl(), [
    `SKILL VERSION GATE T4.R2: peer:x runs built-in skill set none (full snapshot without a pin), mine ${mine} — no state hash from me while it is in play`,
    `SKILL VERSION GATE T4.R2: peer:z runs built-in skill set 0123456789abcdef, mine ${mine} — no state hash from me while it is in play`]);
  eq('VG adapter: ui version events', seen, [
    { kind: 'skill_source', event: 'version', ref: { id: 'builtin_skills', kind: 'skill', name: 'the built-in skills' }, peer: { peer_id: 'peer:x' }, got: null, want: mine },
    { kind: 'skill_source', event: 'version', ref: { id: 'builtin_skills', kind: 'skill', name: 'the built-in skills' }, peer: { peer_id: 'peer:z', name: 'Zed' }, got: '0123456789abcdef', want: mine }]);
  const r2 = pg.gateBuiltins(units, { turn: 4, round: 2 });
  eq('VG adapter: the same unit|pin again → still abstains, no second log / ui', [r2.abstain, vl().length, seen.length], [true, 2, 2]);
  pg.gateBuiltins([{ id: 'peer:z', sk_set: 'aaaaaaaaaaaaaaaa', full: true }], { turn: 5 });
  eq('VG adapter: a NEW pin of the same unit is reported (round absent → R1)', [vl().length, vl()[2]?.split(',')[0], seen.length, seen[2]?.got], [3, 'SKILL VERSION GATE T5.R1: peer:z runs built-in skill set aaaaaaaaaaaaaaaa', 3, 'aaaaaaaaaaaaaaaa']);
  eq('VG adapter: match → no abstain, nothing logged', [pg.gateBuiltins([{ id: 'peer:m', sk_set: mine, full: true }], { turn: 6, round: 0 }).abstain, vl().length], [false, 3]);

  // VG (peer.mjs wiring, chaosd6-8a agent F) — twins of the F9 regex tests in effects-handshake-check:
  //   1. sk_set on the SLIM snapshot (inside currentStateSnapshot before `if (slim) return s;`), not only the full heartbeat
  //   2. `const skVer = skPeer.gateBuiltins(...)` right next to `const fxVer`, same units, full by permanents_csv KEY presence
  //   3. `!skVer.abstain` guarding lastStateHashes.set and `|| skVer.abstain` blanking the published state_hash
  const peerSrcVG = fs.readFileSync(new URL('../peer.mjs', import.meta.url), 'utf8');
  eq('VG gate: peer.mjs sends sk_set on the slim envelope snapshot too',
    (peerSrcVG.match(/function currentStateSnapshot[\s\S]*?if \(slim\) return s;/) || [''])[0].includes('sk_set: skPeer.setId.slice(0, 16)'), true);
  eq('VG gate: peer.mjs computes skVer next to fxVer (full by permanents_csv key presence)',
    /const fxVer = fxPeer\.gateBuiltins\([^\n]*\n\s*const skVer = skPeer\.gateBuiltins\(\[\.\.\.view\.keys\(\)\]\.filter\(id => id !== PEER_ID_STRING\)\.map\(id => \(\{ id, sk_set: view\.get\(id\)\?\.sk_set \|\| null, full: view\.get\(id\)\?\.permanents_csv !== undefined \}\)\)/.test(peerSrcVG), true);
  eq('VG gate: peer.mjs withholds the state hash on skVer.abstain (lastStateHashes + published state_hash)',
    [/!skVer\.abstain \/\* SV \*\/\) lastStateHashes/.test(peerSrcVG), /\|\| skVer\.abstain \/\* SV: skill version gate \*\/ \? '' : stateHash/.test(peerSrcVG)], [true, true]);
}

console.log(fails ? `${fails} skills handshake check(s) FAILED` : 'all skills handshake checks passed');
process.exit(fails ? 1 : 0);
