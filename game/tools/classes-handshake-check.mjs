// CH foreign-class handshake checks (classes-handshake.mjs; the classes twin of effects-/skills-handshake-check).
//   node tools/classes-handshake-check.mjs                     unit checks → "all classes handshake checks passed"
//   node tools/classes-handshake-check.mjs --write-fixture <f> write the test player-branch class (Marauder) for live runs
// Sections 3-7 use a stub register (records the registerForeignClass calls — several stores share one process);
// section 8 runs the real C2 engine (classes.mjs registerForeignClass + classHook + suspend / resume).
import fs from 'node:fs';
process.env.CHAOSD6_CLASSES_CACHE ||= 'memory';   // createClPeer below: never touch the real cache
process.env.CL_HTTPD = '0';
import { createBusRpc } from '../map-sync.mjs';
import { canonicalJson, classHash } from '../classes-repo.mjs';
import { fxKey, attachDefsRpc, foreignCardFromRef, blobFrames } from '../effects-handshake.mjs';
import { skKey } from '../skills-handshake.mjs';
import * as CL from '../classes.mjs';
import {
  classSetId, bundledClassSet, makeClRef, parseClRef, clRefOf, compactRef, clKey, prefixOf, classShape,
  createClStore, createClSync, createMemoryCache, gateClasses, gateBuiltins, clMissingUnion, classRefsByActor, createClPeer, clProtocol,
} from '../classes-handshake.mjs';

let fails = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)?.slice(0, 160)}${ok ? '' : ` (want ${JSON.stringify(want)?.slice(0, 160)})`}`); };
const yes = (label, v) => eq(label, !!v, true);
const throws = (label, fn) => { try { fn(); eq(label, 'no throw', 'throws'); } catch { eq(label, 'throws', 'throws'); } };

// The test player-branch class: Marauder = the bundled Reaver definition (chaosd6.class/1) under its own id, i.e. a
// player branch of the Reaver (`extends: class_reaver` → the C3 validator judges it against the Reaver: ratio 1, ok).
const readJ = (u) => JSON.parse(fs.readFileSync(new URL(u, import.meta.url), 'utf8'));
const REAVER = readJ('../classes-data/classes/class_reaver.json');
const STD = readJ('../classes-data/lib/classes_std.json');
export const MARAUDER = { ...REAVER, id: 'class_marauder', name: 'Marauder', version: '0.1.0', source: { collection: 'players', version: '0.1.0' }, extends: 'class_reaver',
  data: { ...REAVER.data, text: 'Your Empty Posture and Empty Move are treated as an Attack action. You may emit elements during your Attack (player branch of the Reaver).' } };
const wf = process.argv.indexOf('--write-fixture');
if (wf > 0) {
  const out = process.argv[wf + 1];
  fs.writeFileSync(out, JSON.stringify(MARAUDER, null, 2) + '\n');
  console.log(`wrote ${out} (sha256 ${classHash(MARAUDER)})`);
  process.exit(0);
}
const MY_LIB = { schema: 'chaosd6.class-lib/1', id: 'cllib_t', version: '1.0.0', subs: { half: { params: ['x'], body: { '/': [{ var: 'x' }, 2] } } } };
const WITH_LIB = { ...MARAUDER, id: 'class_lib_marauder', uses: ['classes_std', 'cllib_t'] };

// Stub register: records registerForeignClass calls.
function stubReg() { const regs = []; const register = (key, def, opts) => { regs.push({ key, id: def.id, def, libs: (opts.libs || []).map(l => l.id) }); return def; }; register.regs = regs; return register; }
const bundled = bundledClassSet();

// ---------------------------------------------------------------- 1. set id stability
{
  const a = classSetId({ libs: { std: 'a'.repeat(64) }, classes: { class_x: 'c'.repeat(64), class_a: 'd'.repeat(64) } });
  const b = classSetId({ classes: { class_a: 'd'.repeat(64), class_x: 'c'.repeat(64) }, libs: { std: 'a'.repeat(64) } });
  eq('set id: key order never matters', a, b);
  yes('set id: another lib pin is another set', a !== classSetId({ libs: { std: 'e'.repeat(64) }, classes: { class_x: 'c'.repeat(64), class_a: 'd'.repeat(64) } }));
  eq('bundled set id stable over two reads', bundledClassSet().id, bundled.id);
  eq('bundled set: 33 class files + classes_std', [Object.keys(bundled.set.classes).length, Object.keys(bundled.set.libs)], [33, ['classes_std']]);
  yes('bundled set covers the 33 built-ins', CL.CLASSES_IMPLEMENTED.every(id => bundled.builtinIds.has(id)));
  yes('a foreign id is not built-in', !bundled.builtinIds.has(MARAUDER.id));
}

// ---------------------------------------------------------------- 2. refs carry libs
const REF = makeClRef(MARAUDER, [STD], { branch: 'players/ana/marauder', commit: 'a'.repeat(40), verdict: 'ok' });
const REF_LIB = makeClRef(WITH_LIB, [STD, MY_LIB]);
{
  eq('ref pins classes_std by hash', REF.libs, { classes_std: classHash(STD) });
  eq('ref sha = sha256(canonical def)', REF.sha256, classHash(MARAUDER));
  eq('ref pins exactly the used libs', Object.keys(REF_LIB.libs), ['classes_std', 'cllib_t']);
  eq('parse(compact(ref)) round-trips', parseClRef(compactRef(REF)), REF);
  eq('clRefOf reads a snapshot JSON string', clRefOf(JSON.stringify(compactRef(REF)))?.sha256, REF.sha256);
  eq('clRefOf of junk → null', [clRefOf('{nope'), clRefOf(null), clRefOf({ id: 'class_x' })], [null, null, null]);
  throws('ref without libs rejected', () => parseClRef({ ...REF, libs: undefined }));
  throws('ref with a bad lib sha rejected', () => parseClRef({ ...REF, libs: { std: 'xyz' } }));
  throws('a non-class id rejected', () => parseClRef({ ...REF, id: 'skill_dodge' }));
  throws('makeClRef refuses an unpinnable lib', () => makeClRef(WITH_LIB, [STD]));
  yes('clKey changes with a lib pin', clKey(REF_LIB) !== clKey({ ...REF_LIB, libs: { cllib_t: 'f'.repeat(64) } }));
  yes('clKey ignores provenance', clKey({ ...REF, branch: 'x', commit: '' }) === clKey(REF));
  yes('clKey ≠ fxKey / skKey of the same sha (own namespace)', clKey(REF) !== fxKey(REF) && clKey(REF) !== skKey(REF));
  eq('classShape', classShape(MARAUDER), { name: 'Marauder', text: MARAUDER.data.text, kind: 'static', colors: REAVER.data.colors, extends: 'class_reaver', version: '0.1.0' });
}

// ---------------------------------------------------------------- mocked network (as skills-handshake-check)
function queue() {
  const items = []; let ended = false, wake = null;
  return {
    push(x) { items.push(x); wake?.(); },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() { for (;;) { if (items.length) { yield items.shift(); continue; } if (ended) return; await new Promise(r => { wake = r; }); wake = null; } },
  };
}
function mockLibp2pNet() {
  const handlers = new Map();
  const pair = () => { const c2s = queue(), s2c = queue(); return {
    client: { send: (b) => (c2s.push(b), true), onDrain: async () => {}, close: async () => c2s.end(), abort: () => { c2s.end(); s2c.end(); }, [Symbol.asyncIterator]: () => s2c[Symbol.asyncIterator]() },
    server: { send: (b) => (s2c.push(b), true), onDrain: async () => {}, close: async () => s2c.end(), abort: () => { c2s.end(); s2c.end(); }, [Symbol.asyncIterator]: () => c2s[Symbol.asyncIterator]() },
  }; };
  return {
    node: (id) => ({ handle: async (proto, fn) => { handlers.set(`${id}|${proto}`, fn); } }),
    connTo: (peer) => ({ newStream: async (proto) => { const h = handlers.get(`${peer}|${proto}`); if (!h) throw new Error(`protocol ${proto} not supported`); const p = pair(); h(p.server); return p.client; } }),
  };
}
function makeNet() {
  const nodes = new Map(), blocked = new Set(), busNodes = new Map(), lp = mockLibp2pNet();
  const bus = { publish(ev) { setImmediate(() => { for (const [id, rpc] of busNodes) if (ev.to === id) rpc.deliver(ev); }); return 1; } };
  return {
    nodes, blocked,
    async add(id, { transport = 'libp2p', validate = null, register = stubReg() } = {}) {
      const store = createClStore({ bundled, validate, register });
      const learned = [], shared = [];
      let rpc = null;
      const request = async (peer, msg) => {
        if (blocked.has(`${id}>${peer}`) || !nodes.has(peer)) throw Object.assign(new Error('no route'), { code: 'NO_ROUTE' });
        if (transport === 'bus') return busNodes.get(id).request(peer, msg);
        return rpc.request(peer, msg);
      };
      const sync = createClSync({ selfId: id, store, cache: createMemoryCache(), request,
        onLearned: (p, src) => learned.push(src), onShared: (p, peer) => shared.push(peer) });
      busNodes.set(id, createBusRpc({ selfId: id, publish: (ev) => bus.publish(ev), handle: (m, o) => sync.handle(m, o), maxBytes: 24 * 1024 }));
      await attachDefsRpc({ proto: clProtocol('dim-chunit'), busKind: 'cl', selfId: id, handle: (m, o) => sync.handle(m, o), libp2p: lp.node(id),
        openConnTo: (peer) => lp.connTo(peer), getBus: () => null, onTransport: (t) => { rpc = t; } });
      const n = { id, store, sync, learned, shared, register };
      nodes.set(id, n);
      return n;
    },
  };
}

// ---------------------------------------------------------------- 3. fetch over mocked libp2p and the bus
{
  const net = makeNet();
  const A = await net.add('A'), B = await net.add('B');
  eq('A adopts its own class', A.sync.adopt(MARAUDER, REF, [STD]).status, 'ready');
  eq('A registered it (key, id, libs)', A.register.regs.map(r => [r.key === clKey(REF), r.id, r.libs]), [[true, 'class_marauder', ['classes_std']]]);
  eq('B lacks it', B.store.status(REF), 'missing');
  eq('B fetches from the owner (libp2p /classes/1 stream)', await B.sync.ensure(compactRef(REF), { from: 'A' }), 'ready');
  eq('B learned from A', B.learned, ['A']);
  eq('A told it shared with B', A.shared, ['B']);
  eq('B announces it', B.sync.haveCsv(), `class_marauder@${prefixOf(REF.sha256)}`);
  eq('B registered the same bytes under the same key', [B.register.regs[0].key === clKey(REF), canonicalJson(B.register.regs[0].def) === canonicalJson(MARAUDER)], [true, true]);
  eq('readyById', B.store.readyById('class_marauder')?.key, clKey(REF));
  const net2 = makeNet();
  const A2 = await net2.add('A', { transport: 'bus' }), B2 = await net2.add('B', { transport: 'bus' });
  A2.sync.adopt(MARAUDER, REF, [STD]);
  eq('fetch over the bus fallback', await B2.sync.ensure(REF, { from: 'A' }), 'ready');
  const A3 = await net.add('A3'), B3 = await net.add('B3');
  eq('a class with its own lib adopts', A3.sync.adopt(WITH_LIB, REF_LIB, [STD, MY_LIB]).status, 'ready');
  eq('the lib comes along by hash', await B3.sync.ensure(REF_LIB, { from: 'A3' }), 'ready');
  eq('registered with both pinned libs', B3.register.regs[0].libs.sort(), ['classes_std', 'cllib_t']);
}

// ---------------------------------------------------------------- 4. tamper / validator gate / local policy / ids
let checkClass = null;
try { ({ checkClass } = await import('./classes-rebalancing-check.mjs')); } catch (e) { console.log(`skip C3 validator (${e.message})`); }
{
  const net = makeNet();
  const E = await net.add('Evil'), A = await net.add('A'), B = await net.add('B');
  A.sync.adopt(MARAUDER, REF, [STD]);
  const evil = { ...MARAUDER, flags: { ...MARAUDER.flags, stance: { EP: 'A', EM: 'A', P: 'A' } } };
  E.sync.handle = (msg) => blobFrames('class', evil).map(f => ({ ...f, sha: msg.sha }));
  eq('only Evil asked → missing', await B.sync.ensure(REF, { from: 'Evil' }), 'missing');
  eq('tamper counted', B.sync.stats().tampered, 1);
  B.sync.noteHolder(prefixOf(REF.sha256), 'Evil');
  eq('Evil then A → ready (from A)', await B.sync.ensure(REF, { from: 'A' }), 'ready');
  eq('B learned from A, not Evil', B.learned, ['A']);
  const mk = (o = {}) => createClStore({ bundled, register: stubReg(), ...o });
  if (checkClass) {
    const v = checkClass(MARAUDER);
    eq(`C3 verdict on the Marauder (baseline ${v.baseline?.id}, judged ${v.judged_ratio})`, v.verdict, 'ok');
    const st = mk({ validate: (d) => checkClass(d) }); st.addDef(MARAUDER);
    eq('with the real validator → ready, verdict ok', [st.prepare(REF).status, st.prepare(REF).verdict], ['ready', 'ok']);
    const nopower = { ...MARAUDER, id: 'class_vagrant', extends: undefined };
    const st0 = mk({ validate: (d) => checkClass(d) }); st0.addDef(nopower);
    eq('C3 reject (no extends, no power) → refused', st0.prepare(makeClRef(nopower, [STD])).status, 'rejected');
  }
  const st1 = mk({ validate: () => ({ verdict: 'reject', reasons: ['CL_ACCEPT=0'] }) }); st1.addDef(MARAUDER);
  eq('local refuse-all policy (CL_ACCEPT=0) → refused', st1.prepare(REF).status, 'rejected');
  const st2 = mk({ validate: () => { throw new Error('boom'); } }); st2.addDef(MARAUDER);
  eq('validator error → refused (deterministic)', st2.prepare(REF).status, 'rejected');
  const reaverVariant = { ...MARAUDER, id: 'class_reaver' };
  const st3 = mk(); st3.addDef(reaverVariant);
  eq('a built-in id → refused (needs its own id)', st3.prepare(makeClRef(reaverVariant, [STD])).status, 'rejected');
  const st5 = mk(); const other = { ...MARAUDER, version: '0.2.0' }; st5.addDef(MARAUDER); st5.addDef(other);
  eq('first def of an id → ready', st5.prepare(REF).status, 'ready');
  eq('a second def under the same id → refused', st5.prepare(makeClRef(other, [STD])).status, 'rejected');
  const bad = { ...MARAUDER, id: 'class_bad', hooks: { stance: { no_such_op: [] } } };
  const st7 = mk(); st7.addDef(bad);
  eq('validateClassDef errors (unknown op) → refused', st7.prepare(makeClRef(bad, [STD])).status, 'rejected');
  const marker = { ...MARAUDER, id: 'class_marker', hooks: { ...MARAUDER.hooks, ability: { engine: 'js', impl: 'peer.mjs#x' } } };
  const st9 = mk(); st9.addDef(marker);
  eq('a JS marker in a foreign class → refused', st9.prepare(makeClRef(marker, [STD])).status, 'rejected');
  const st8 = mk({ register: () => { throw new Error('bad'); } }); st8.addDef(MARAUDER);
  eq('registerForeignClass throws → refused, never ready', st8.prepare(REF).status, 'rejected');
  const st6 = mk(); st6.addDef(WITH_LIB);
  eq('a ref missing its lib bytes → missing', st6.prepare(REF_LIB).status, 'missing');
}

// ---------------------------------------------------------------- 5. have propagation A → B → C
{
  const net = makeNet();
  const A = await net.add('A'), B = await net.add('B'), C = await net.add('C');
  net.blocked.add('C>A');
  A.sync.adopt(MARAUDER, REF, [STD]);
  const hA = A.sync.haveCsv();
  await Promise.all(B.sync.noteHave('A', hA));
  eq('B prefetched from A’s cl_have', B.store.status(REF), 'ready');
  await Promise.all(C.sync.noteHave('A', hA));
  eq('C cannot get it from A', C.store.status(REF), 'missing');
  C.sync.noteHave('B', B.sync.haveCsv());
  eq('C ensures the ref from A’s snapshot', await C.sync.ensure(REF, { from: 'A' }), 'ready');
  eq('C learned from B, not A', C.learned, ['B']);
  eq('A never served C', A.shared, ['B']);
}

// ---------------------------------------------------------------- 6. fallback determinism (dormant rule)
{
  const net = makeNet();
  const A = await net.add('A'), B = await net.add('B'), C = await net.add('C');
  A.sync.adopt(MARAUDER, REF, [STD]);
  await B.sync.ensure(REF, { from: 'A' });
  const wireRef = compactRef(REF);
  const reveals = [{ actor: 'A', action: 'EP' }, { actor: 'B', action: 'A' }, { actor: 'C', action: 'EP' }];
  const units = [{ id: 'A', class_id: 'class_marauder', ref: wireRef }, { id: 'B', class_id: 'class_reaver' }, { id: 'C', class_id: 'class_monk' }];
  const tapeWith = (missingBy, aRef = wireRef) => [
    { type: 'evt_action_reveal', turn: 1, round: 0, actor_peer_id: 'A', payload: { ...(aRef ? { cl_ref: aRef } : {}) } },
    { type: 'evt_action_reveal', turn: 1, round: 0, actor_peer_id: 'B', payload: {} },
    { type: 'evt_action_reveal', turn: 1, round: 0, actor_peer_id: 'C', payload: { ...(missingBy === 'C' ? { cl_missing: [REF.sha256] } : {}) } },
  ];
  const isB = (id) => bundled.builtinIds.has(id);
  const gate = (n, tape, us = units) => gateClasses(us, clMissingUnion(reveals, tape, 1, 0), (r) => n.store.status(r), classRefsByActor(reveals, tape, 1, 0), isB, (id) => n.store.readyById(id)?.key ?? null);
  const view = (g) => JSON.stringify({ tags: [...g.tags], abstain: g.abstain, dormant: g.dormant });
  const k16 = clKey(REF).slice(0, 16);
  // (a) C reported missing → dormant on A, B and C alike (holders included), nobody abstains.
  const a = [A, B, C].map(n => gate(n, tapeWith('C')));
  eq('missing → dormant identically on A, B and C', a.map(view), a.map(() => view(a[0])));
  eq('dormant tag + list', [a[0].tags.get('A'), a[0].dormant, a[0].abstain], [`dormant:${k16}`, ['class_marauder'], false]);
  // (b) nobody reported missing: holders run it, the lacking peer abstains (never guesses).
  const b = [A, B, C].map(n => gate(n, tapeWith(null)));
  eq('holders run it with cl:<key16>', [b[0].tags.get('A'), b[1].tags.get('A'), b[0].dormant, b[1].dormant], [`cl:${k16}`, `cl:${k16}`, [], []]);
  eq('lacking peer abstains (and resolves it dormant)', b.map(x => x.abstain), [false, false, true]);
  eq('lacking peer: missing tag + ref', [b[2].tags.get('A'), b[2].missing.map(r => r.id)], [`missing:${k16}`, ['class_marauder']]);
  // (c) a non-revealer holder in view: its snapshot ref decides (no tag — only revealers are hashed).
  const watcher = [...units, { id: 'W', class_id: 'class_marauder', ref: JSON.stringify(wireRef) }];
  const c = gate(C, tapeWith(null), watcher);
  eq('non-revealer foreign holder, lacking here → abstain, no tag for W', [c.abstain, c.tags.has('W')], [true, false]);
  eq('…held here → runs', gate(B, tapeWith(null), watcher).abstain, false);
  // (d) a foreign class id with no ref anywhere → abstain (never guess its bytes).
  const d = gate(B, tapeWith(null, null), [{ id: 'A', class_id: 'class_marauder' }]);
  eq('ref-less foreign class → bad tag + abstain', [d.tags.get('A'), d.abstain], ['bad:class_marauder', true]);
  // (e) built-in only: no tags, no abstain.
  const e = gateClasses([{ id: 'B', class_id: 'class_reaver' }], new Set(), () => 'missing', new Map([['B', null]]), isB);
  yes('built-in only: no tags, nothing dormant', e.tags.size === 0 && !e.dormant.length && !e.abstain);
  // (f) a different def of the same id held here → not this ref → abstain.
  const other = { ...MARAUDER, version: '0.9.0' };
  const f = gateClasses(units, new Set(), () => 'ready', classRefsByActor(reveals, tapeWith(null), 1, 0), isB, () => clKey(makeClRef(other, [STD])));
  eq('another def of the id held here → abstain', [f.abstain, f.tags.get('A')], [true, `missing:${k16}`]);
}

// ---------------------------------------------------------------- 7. the peer adapter (boot, snapshot, reveal, gate)
{
  const uiSeen = [];
  const pe = await createClPeer({ selfId: 'peer:T', dimId: 'dim-chunit', log: () => {}, validate: checkClass ? (d) => checkClass(d) : null, ui: (m) => uiSeen.push(m) });
  const tmp = `${process.env.TMPDIR || '/tmp'}/_ch_marauder_${process.pid}.json`;
  fs.writeFileSync(tmp, JSON.stringify(MARAUDER));
  const info = await pe.boot({ file: tmp });
  fs.unlinkSync(tmp);
  eq('FORCE_FOREIGN_CLASS boot → my class info', [info?.id, info?.name, info?.kind, info?.extends, info?.ref?.branch], ['class_marauder', 'Marauder', 'static', 'class_reaver', 'players/local/marauder']);
  yes('registered with classes.mjs', CL.isForeignClassId('class_marauder'));
  eq('snapshot: cl_ref_json + cl_have', Object.keys(pe.snapshotFields()), ['cl_ref_json', 'cl_have']);
  eq('snapshot ref = my ref', clRefOf(pe.snapshotFields().cl_ref_json)?.sha256, REF.sha256);
  eq('Door field', pe.doorRef().cl_ref?.id, 'class_marauder');
  const card = pe.cardFor(pe.mine.prep, pe.mine.ref);
  eq('class card carries the source (badge)', [card.kind, card.class_id, card.source.kind, card.tags], ['class', 'class_marauder', 'class', ['foreign']]);
  // The gate sees my revealed ref; another revealer lacks it → dormant (my class sleeps this action).
  const myReveal = { clRef: pe.myRef(), clMissing: null };
  const rv = [{ actor: 'peer:T', action: 'EP' }, { actor: 'peer:U', action: 'EP' }];
  const units = [{ id: 'peer:T', class_id: 'class_marauder' }, { id: 'peer:U', class_id: 'class_monk' }];
  const tape = [{ type: 'evt_action_reveal', turn: 2, round: 1, actor_peer_id: 'peer:U', payload: { cl_missing: [REF.sha256] } }];
  yes('needsGate with my foreign class', pe.needsGate(units, tape, { turn: 2, round: 1, myReveal }));
  const pr = await pe.prepareResolution(rv, tape, { turn: 2, round: 1, self: 'peer:T', myReveal, units });
  eq('my class dormant when a revealer lacks it', [pr.mineDormant, pr.dormant, pr.abstain], [true, ['class_marauder'], false]);
  const pr2 = await pe.prepareResolution(rv, [], { turn: 2, round: 2, self: 'peer:T', myReveal, units });
  eq('…and runs once nobody lacks it', [pr2.mineDormant, pr2.tags.get('peer:T'), pr2.abstain], [false, `cl:${clKey(REF).slice(0, 16)}`, false]);
  // A peer whose policy refuses lists it at reveal → dormant everywhere.
  process.env.CL_ACCEPT = '0';
  const refuser = await createClPeer({ selfId: 'peer:N', dimId: 'dim-chunit', log: () => {}, ui: (m) => uiSeen.push(m) });
  delete process.env.CL_ACCEPT;
  refuser.store.addDef(MARAUDER);
  const tapeC = [{ type: 'evt_action_commit', turn: 3, round: 0, actor_peer_id: 'peer:T', payload: { cl_ref: pe.myRef() } }];
  eq('a refusing peer lists the commit ref in cl_missing', await refuser.missingForReveal(tapeC, 3, 0), [REF.sha256]);
  eq('…and the snapshot ref of a unit in view', await refuser.missingForReveal([], 3, 1, [{ id: 'peer:T', ref: pe.myRef() }]), [REF.sha256]);
  eq('…with a class_source missing notice', uiSeen.filter(m => m.kind === 'class_source').map(m => [m.event, m.ref.id, m.ref.kind])[0], ['missing', 'class_marauder', 'class']);
  // onPeerState / onEnvelope learn the ref of a peer.
  const watcher = await createClPeer({ selfId: 'peer:W', dimId: 'dim-chunit', log: () => {}, validate: null });
  watcher.onPeerState({ peer_id: 'peer:T', cl_ref_json: JSON.stringify(pe.myRef()) });
  eq('a snapshot cl_ref_json is remembered', watcher.refOf('peer:T')?.sha256, REF.sha256);
  yes('…and makes the adapter active', watcher.active);
  eq('built-in play: needsGate false', (await createClPeer({ selfId: 'peer:X', dimId: 'd', log: () => {}, validate: null })).needsGate([{ id: 'x', class_id: 'class_monk' }], [], { turn: 0, round: 0, myReveal: {} }), false);
  // FXG: a {kind:'class', id, ref} entry → the class card.
  const g = await pe.cardFromRef({ kind: 'class', id: 'class_marauder', ref: pe.myRef() });
  eq('FXG class gift held → ready card', [g.status, g.card?.kind, g.card?.class_id], ['ready', 'class', 'class_marauder']);
  eq('FXG class gift of another id → bad', (await foreignCardFromRef({ kind: 'class', id: 'class_monk', ref: pe.myRef() }, { store: pe.store, sync: pe.sync, parseRef: parseClRef, cardFor: pe.cardFor })).status, 'bad');
}

// ---------------------------------------------------------------- 8. real C2 engine: hooks, dormant, order
{
  yes('real engine: the Marauder is registered (section 7)', CL.isForeignClassId('class_marauder'));
  const ctx = { classData: () => ({}), elemStat: (el) => CL.ELEM_TO_STAT[el], sha: (s) => s };
  eq('Marauder stance EP / EM → A (its program)', [CL.classHook('stance', 'class_marauder', ctx, { code: 'EP' }), CL.classHook('stance', 'class_marauder', ctx, { code: 'EM' }), CL.classHook('stance', 'class_marauder', ctx, { code: 'B' })], ['A', 'A', null]);
  eq('Marauder emits A at every site', ['plan', 'destroy', 'manip', 'badge'].map(site => CL.classHook('emits', 'class_marauder', ctx, { code: 'A', site })), [true, true, true, true]);
  eq('Marauder answers the stance hook (CLASS_RULES flags)', (CL.CLASS_RULES.class_marauder?.hooks || []).includes('stance'), true);
  const cols = CL.classColours(ctx, 'class_marauder');
  yes('Marauder colours come from its definition', Object.values(cols).flat().length === REAVER.data.colors.length);
  eq('suspend → dormant', CL.suspendForeignClasses(['class_marauder', 'class_monk']), ['class_marauder']);
  eq('dormant: no flags, no stance, no colours, no emits', [CL.isClassSuspended('class_marauder'), 'class_marauder' in CL.CLASS_RULES, CL.classHook('stance', 'class_marauder', ctx, { code: 'EP' }), CL.classColours(ctx, 'class_marauder'), CL.classHook('emits', 'class_marauder', ctx, { code: 'A', site: 'plan' })],
    [true, false, null, {}, false]);
  eq('dormant = what an unknown class answers', ['stance', 'emits', 'colours', 'kind'].map(h => JSON.stringify(CL.classHook(h, 'class_marauder', ctx, { code: 'EP', site: 'plan' }))),
    ['stance', 'emits', 'colours', 'kind'].map(h => JSON.stringify(CL.classHook(h, 'class_nobody_knows', ctx, { code: 'EP', site: 'plan' }))));
  yes('built-ins untouched while suspended', CL.classHook('stance', 'class_reaver', ctx, { code: 'EP' }) === 'A');
  CL.resumeForeignClasses();
  eq('resume → back', [CL.isClassSuspended('class_marauder'), CL.classHook('stance', 'class_marauder', ctx, { code: 'EP' })], [false, 'A']);
  // Foreign rules follow the built-ins in id order, whatever the learn order.
  const z = { ...MARAUDER, id: 'class_zealot' }, b = { ...MARAUDER, id: 'class_brute' };
  CL.registerForeignClass('kz', z); CL.registerForeignClass('kb', b);
  const tail = Object.keys(CL.CLASS_RULES).slice(-3);
  eq('foreign CLASS_RULES order = id order', tail, ['class_brute', 'class_marauder', 'class_zealot']);
  CL.suspendForeignClasses(['class_brute']); CL.resumeForeignClasses();
  eq('…also after suspend / resume', Object.keys(CL.CLASS_RULES).slice(-3), ['class_brute', 'class_marauder', 'class_zealot']);
  eq('built-ins first, unchanged', Object.keys(CL.CLASS_RULES).slice(0, CL.CLASSES_IMPLEMENTED.length), CL.CLASSES_IMPLEMENTED);
  throws('a second definition under a registered id is refused', () => CL.registerForeignClass('kz2', { ...z, version: '0.3.0' }));
  CL.clearForeignClasses();
  yes('clearForeignClasses', !CL.isForeignClassId('class_marauder') && !('class_zealot' in CL.CLASS_RULES));
}

// ---------------------------------------------------------------- BR. built-ins by reference, hard version gate (phase 6, ruling 3)
{
  const pb = await createClPeer({ selfId: 'peer:B', dimId: 'dim-chbr', log: () => {}, validate: null, ui: () => {} });
  const k = pb.builtinKey('class_reaver');
  eq('a built-in pin = clKey(bundled definition + libs), 16 hex', k, clKey(makeClRef(REAVER, [STD])).slice(0, 16));
  eq('no pin for a foreign / unknown id', [pb.builtinKey('class_marauder'), pb.builtinKey('class_nope'), pb.builtinKey(null)], [null, null, null]);
  eq('snapshot: a built-in holder publishes cl_key (no foreign ref)', pb.snapshotFields('class_reaver'), { cl_key: k });
  eq('snapshot: no class → no cl_key', pb.snapshotFields(null), {});
  const keyOf = (id) => pb.builtinKey(id);
  eq('gate: same pins → resolves', gateBuiltins([{ id: 'peer:A', class_id: 'class_reaver', cl_key: k }, { id: 'peer:M', class_id: null }], keyOf), { abstain: false, mismatches: [] });
  eq('gate: another version → abstain (never silent)', gateBuiltins([{ id: 'peer:A', class_id: 'class_reaver', cl_key: '0123456789abcdef' }], keyOf),
    { abstain: true, mismatches: [{ unit: 'peer:A', class_id: 'class_reaver', got: '0123456789abcdef', want: k }] });
  eq('gate: no pin (an older build) → abstain', gateBuiltins([{ id: 'peer:A', class_id: 'class_reaver' }], keyOf).mismatches.map(m => m.got), [null]);
  eq('gate: a foreign class is the foreign gate\'s business', gateBuiltins([{ id: 'peer:A', class_id: 'class_marauder', cl_key: '' }], keyOf), { abstain: false, mismatches: [] });
  eq('gate: sorted by unit id (same log on every peer)', gateBuiltins([{ id: 'peer:Z', class_id: 'class_reaver' }, { id: 'peer:A', class_id: 'class_reaver' }], keyOf).mismatches.map(m => m.unit), ['peer:A', 'peer:Z']);
  const seen = [], pu = await createClPeer({ selfId: 'peer:C', dimId: 'dim-chbr', log: () => {}, validate: null, ui: (m) => seen.push(m) });
  pu.gateBuiltins([{ id: 'peer:A', class_id: 'class_reaver', cl_key: 'ffffffffffffffff' }], { turn: 3, round: 0 });
  pu.gateBuiltins([{ id: 'peer:A', class_id: 'class_reaver', cl_key: 'ffffffffffffffff' }], { turn: 3, round: 1 });
  eq('adapter: one UI notice per unit + pin (event version)', seen.map(m => [m.kind, m.event, m.ref.id, m.got, m.want]), [['class_source', 'version', 'class_reaver', 'ffffffffffffffff', k]]);
}

// ---------------------------------------------------------------- RF. a refuser's summoned companions refuse too (ruling 2026-11-19)
{
  const sel = await import('../foreign-select.mjs');
  const KEYS = ['FOREIGN_REFUSERS', 'FOREIGN_HOLDERS', 'FOREIGN_ORDER', 'OWNER_PEER_ID', 'PEER_LABEL', 'CL_ACCEPT'];
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  const setEnv = (o) => { for (const k of KEYS) delete process.env[k]; for (const [k, v] of Object.entries(o)) if (v !== undefined) process.env[k] = v; };
  const as = async (label, env = {}) => {
    setEnv({ FOREIGN_REFUSERS: 'P-Agent5', PEER_LABEL: label, ...env });
    const lines = [], p = await createClPeer({ selfId: `peer:${label}`, label, dimId: 'dim-rf', log: (l) => lines.push(l), validate: null });
    p.store.addDef(MARAUDER);
    const tapeC = [{ type: 'evt_action_commit', turn: 3, round: 0, actor_peer_id: 'peer:T', payload: { cl_ref: REF } }];
    return { missing: await p.missingForReveal(tapeC, 3, 0), role: sel.foreignRole(label), why: lines.find(l => / validator /.test(l))?.replace(/.* validator /, '') };
  };
  eq('RF: the listed refuser lists the Marauder in cl_missing', await as('P-Agent5'), { missing: [REF.sha256], role: 'refuser', why: 'FOREIGN_REFUSERS (refuse all)' });
  eq('RF: its companion P-Agent5-sum1 lists it too', await as('P-Agent5-sum1', { OWNER_PEER_ID: 'peer:P-Agent5' }), { missing: [REF.sha256], role: 'refuser', why: 'FOREIGN_REFUSERS (refuse all)' });
  eq('RF: a companion of that companion too', (await as('P-Agent5-sum1-sum1', { OWNER_PEER_ID: 'peer:P-Agent5-sum1' })).missing, [REF.sha256]);
  eq('RF: a companion of a non-refuser does not', (await as('P-Agent4-sum1', { OWNER_PEER_ID: 'peer:P-Agent4' })).missing, []);
  eq('RF: CL_ACCEPT=0 inherited by the companion env → lists it', await as('P-Agent4-sum2', { OWNER_PEER_ID: 'peer:P-Agent4', CL_ACCEPT: '0' }), { missing: [REF.sha256], role: 'all', why: 'CL_ACCEPT=0 (refuse all)' });
  setEnv(saved);
}

console.log(fails ? `${fails} classes handshake check(s) FAILED` : 'all classes handshake checks passed');
process.exit(fails ? 1 : 0);
