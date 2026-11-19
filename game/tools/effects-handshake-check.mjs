// E4 foreign-effect handshake checks (effects-handshake.mjs).
//   node tools/effects-handshake-check.mjs                    unit checks → "all handshake checks passed"
//   node tools/effects-handshake-check.mjs --write-fixture <f> write the test player-branch effect (Frost Lance) for live runs
import fs from 'node:fs';
import { createHash } from 'node:crypto';
process.env.CHAOSD6_EFFECTS_CACHE ||= 'memory';   // createFxPeer below: never touch the real cache
process.env.FX_HTTPD = '0';
import { canonicalJson, effectHash } from '../effects-repo.mjs';
import { encodeFrame, createFrameDecoder, createBusRpc } from '../map-sync.mjs';
import { resolveEffect, resolveEffectJs, isForeignEffectId, EFFECT_RULES } from '../effects.mjs';
import {
  effectSetId, libShaMap, bundledEffectSet, makeFxRef, parseFxRef, compactRef, fxKey, prefixOf,
  createFxStore, createFxSync, createMemoryCache, blobFrames, assembleBlob, gateReveals, missingUnion, createFxPeer,
  foreignCardFromRef,   // FXG
} from '../effects-handshake.mjs';
import { addArchivedCard, dropRandomDeckCard, loadProfile, validateCharacter, foreignRefOf } from '../profile.mjs';   // FXG

let fails = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)?.slice(0, 160)}${ok ? '' : ` (want ${JSON.stringify(want)?.slice(0, 160)})`}`); };
const yes = (label, v) => eq(label, !!v, true);
const throwsCode = (label, fn) => { try { fn(); eq(label, 'no throw', 'throws'); } catch (e) { eq(label, 'throws', 'throws'); } };

// The test player-branch effect: Frost Lance = Water + Air delta damage to one adjacent enemy (Lightning without the lock).
export const FROST_LANCE = {
  schema: 'chaosd6.effect/1', id: 'effect_frost_lance', name: 'Frost Lance', version: '0.1.0', source: { collection: 'players', version: '0.1.0' },
  elements: ['elem_water', 'elem_air'], cost: 2, kind: 'damage', duration: 'instant', every: { behaviour: 'none' },
  text: 'Delta damage (Water + Air) to one adjacent enemy.', flags: { damage: 'delta', scope: 'target' }, uses: ['std'],
  logic: { seq: [{ call: ['prelude'] }, { call: ['targets', 'target', 1, true] }, { call: ['require_recipients'] },
    { map: [{ var: 'recipients' }, { call: ['hit', { var: 'def' }, [{ obj: { kind: 'main', sum: { call: ['main_delta', { var: 'def' }] } } }]] }, 'def'] },
    { call: ['finish'] }] },
};

const wf = process.argv.indexOf('--write-fixture');
if (wf > 0) {
  const out = process.argv[wf + 1];
  fs.writeFileSync(out, JSON.stringify(FROST_LANCE, null, 2) + '\n');
  console.log(`wrote ${out} (sha256 ${effectHash(FROST_LANCE)})`);
  process.exit(0);
}

const bundled = bundledEffectSet();
const libsBy = (names) => names.map(n => bundled.libs.get(n));

// ---------------------------------------------------------------- 1. set id stability
{
  const a = effectSetId({ libs: { std: 'a'.repeat(64), e2a: 'b'.repeat(64) }, effects: { effect_x: 'c'.repeat(64), effect_a: 'd'.repeat(64) } });
  const b = effectSetId({ effects: { effect_a: 'd'.repeat(64), effect_x: 'c'.repeat(64) }, libs: { e2a: 'b'.repeat(64), std: 'a'.repeat(64) } });
  eq('set id: key order never matters', a, b);
  const c = effectSetId({ libs: { std: 'e'.repeat(64), e2a: 'b'.repeat(64) }, effects: { effect_x: 'c'.repeat(64), effect_a: 'd'.repeat(64) } });
  yes('set id: a different std is a different set', a !== c);
  eq('bundled set id stable over two reads', bundledEffectSet().id, bundled.id);
  yes('bundled set pins std', /^[0-9a-f]{64}$/.test(bundled.set.libs.std || ''));
  eq('bundled set pins every lib file', Object.keys(bundled.set.libs), [...bundled.libs.keys()].sort());
  const reordered = Object.fromEntries(Object.entries(bundled.libs.get('std')).reverse());
  eq('lib hash ignores key order', libShaMap([reordered]).std, bundled.set.libs.std);
  // HR (2026-11-18): the effect hook programs are part of the set id; a hook-less set keeps its pre-HR id
  const base = { libs: { std: 'a'.repeat(64) }, effects: { effect_x: 'c'.repeat(64) } };
  eq('set id: empty hooks = the pre-HR id', effectSetId({ ...base, hooks: {} }), createHash('sha256').update(canonicalJson(base)).digest('hex'));
  yes('set id: hooks change it', effectSetId({ ...base, hooks: { trap: 'f'.repeat(64) } }) !== effectSetId(base));
  yes('set id: another hook file version is another set', effectSetId({ ...base, hooks: { trap: 'f'.repeat(64) } }) !== effectSetId({ ...base, hooks: { trap: 'e'.repeat(64) } }));
  eq('bundled set pins every hook file', Object.keys(bundled.set.hooks || {}), [...bundled.hooks.keys()].sort());
  yes('bundled set has the channel/trap/holdings/summon hooks', ['channel', 'holdings', 'summon', 'trap'].every(k => /^[0-9a-f]{64}$/.test(bundled.set.hooks?.[k] || '')));
  eq('bundled hook sha = effectHash of the file', bundled.set.hooks?.trap, effectHash(bundled.hooks.get('trap')));
  const noHooks = bundledEffectSet(undefined, '/nonexistent-hooks-dir');
  eq('no hook dir → set id without hooks', noHooks.id, effectSetId({ libs: noHooks.set.libs, effects: noHooks.set.effects }));
  yes('hooks are in the bundled id', noHooks.id !== bundled.id);
}

// ---------------------------------------------------------------- 2. refs carry libs
const REF = makeFxRef(FROST_LANCE, libsBy(['std']), { branch: 'players/ana/frost-lance', commit: 'a'.repeat(40), verdict: 'boost' });
{
  eq('ref pins exactly the used libs', Object.keys(REF.libs), ['std']);
  eq('ref lib sha = sha256(canonical std)', REF.libs.std, effectHash(bundled.libs.get('std')));
  eq('ref effect sha = sha256(canonical def)', REF.sha256, effectHash(FROST_LANCE));
  eq('parse(compact(ref)) round-trips', parseFxRef(compactRef(REF)), REF);
  throwsCode('ref without libs rejected', () => parseFxRef({ ...REF, libs: undefined }));
  throwsCode('ref with a bad lib sha rejected', () => parseFxRef({ ...REF, libs: { std: 'xyz' } }));
  const k2 = fxKey({ ...REF, libs: { std: 'f'.repeat(64) } });
  yes('fxKey changes with the std pin', k2 !== fxKey(REF));
  yes('fxKey ignores provenance (branch / commit)', fxKey({ ...REF, branch: 'x', commit: '' }) === fxKey(REF));
  throwsCode('makeFxRef refuses an unpinnable lib', () => makeFxRef({ ...FROST_LANCE, uses: ['nope'] }, libsBy(['std'])));
}

// ---------------------------------------------------------------- blob framing
{
  const std = bundled.libs.get('std');
  const frames = blobFrames('lib', std, 2048);
  yes(`std lib in ${frames.length} frames ≤ 2048 B`, frames.length > 1 && frames.every(f => Buffer.byteLength(JSON.stringify(f)) <= 2048));
  const sha = effectHash(std);
  eq('frames reassemble to the canonical text', createHash('sha256').update(assembleBlob(frames, sha)).digest('hex'), sha);
  eq('a lost frame → null', assembleBlob(frames.slice(1), sha), null);
}

// ---------------------------------------------------------------- mocked network
// Each node: { id, store, sync }. route(from, to) decides reachability. Transport kinds:
//   'libp2p': frames through encodeFrame / createFrameDecoder;  'bus': a createBusRpc pair over a shared in-memory bus.
function makeNet() {
  const nodes = new Map(), blocked = new Set(), busNodes = new Map();
  const bus = { publish(ev) { setImmediate(() => { for (const [id, rpc] of busNodes) if (ev.to === id) rpc.deliver(ev); }); return 1; } };
  return {
    nodes, blocked,
    add(id, { transport = 'libp2p', validate = null, builtinRules = {}, onLearned = null, onShared = null } = {}) {
      const store = createFxStore({ bundled, builtinRules, validate });
      const learned = [], shared = [];
      const request = async (peer, msg) => {
        if (blocked.has(`${id}>${peer}`) || !nodes.has(peer)) throw Object.assign(new Error('no route'), { code: 'NO_ROUTE' });
        if (transport === 'bus') return busNodes.get(id).request(peer, msg);
        const dec = createFrameDecoder();
        const req = dec.push(encodeFrame(msg))[0];
        const out = nodes.get(peer).sync.handle(req);
        const back = createFrameDecoder();
        return { msgs: out.flatMap(m => back.push(encodeFrame(m))), via: 'libp2p' };
      };
      const sync = createFxSync({ selfId: id, store, cache: createMemoryCache(), request,
        onLearned: (p, src) => { learned.push(src); onLearned?.(p, src); }, onShared: (p, peer) => { shared.push(peer); onShared?.(p, peer); } });
      busNodes.set(id, createBusRpc({ selfId: id, publish: (ev) => bus.publish(ev), handle: (m, o) => sync.handle(m, o), maxBytes: 24 * 1024 }));
      const n = { id, store, sync, learned, shared };
      nodes.set(id, n);
      return n;
    },
  };
}
const flush = () => new Promise(r => setTimeout(r, 30));

// ---------------------------------------------------------------- 3. fetch (libp2p-framed and bus)
{
  const net = makeNet();
  const A = net.add('A'), B = net.add('B');
  eq('A adopts its own effect', A.sync.adopt(FROST_LANCE, REF, libsBy(['std'])).status, 'ready');
  eq('B lacks it', B.store.status(REF), 'missing');
  eq('B fetches from the caster (libp2p frames)', await B.sync.ensure(compactRef(REF), { from: 'A' }), 'ready');
  eq('B learned from A', B.learned, ['A']);
  eq('A told it shared with B', A.shared, ['B']);
  eq('B now announces it', B.sync.haveCsv(), `effect_frost_lance@${prefixOf(REF.sha256)}`);
  const netB = makeNet();
  const A2 = netB.add('A', { transport: 'bus' }), B2 = netB.add('B', { transport: 'bus' });
  A2.sync.adopt(FROST_LANCE, REF, libsBy(['std']));
  eq('fetch over the bus fallback', await B2.sync.ensure(REF, { from: 'A' }), 'ready');
  // A def that uses a lib B does not hold: the lib comes along by hash.
  const odd = { ...FROST_LANCE, id: 'effect_frost_lance_x', uses: ['mylib'], logic: { call: ['zap'] } };
  const myLib = { schema: 'chaosd6.effect-lib/1', id: 'mylib', version: '1.0.0', subs: { zap: { params: [], body: { put: ['status', 'fizzled'] } } } };
  const refOdd = makeFxRef(odd, [myLib]);
  const A3 = net.add('A3'); const B3 = net.add('B3');
  eq('a def with its own lib adopts', A3.sync.adopt(odd, refOdd, [myLib]).status, 'ready');
  eq('the lib is fetched by hash too', await B3.sync.ensure(refOdd, { from: 'A3' }), 'ready');
  yes('B3 holds the lib', B3.store.hasLib(effectHash(myLib)));
}

// ---------------------------------------------------------------- 4. tamper rejection / validator gate / built-in flags
{
  const net = makeNet();
  const E = net.add('Evil'), A = net.add('A'), B = net.add('B');
  A.sync.adopt(FROST_LANCE, REF, libsBy(['std']));
  // Evil answers every get with a stronger Frost Lance under the genuine sha.
  const evil = { ...FROST_LANCE, flags: { damage: 'delta', scope: 'everyone', range: 10 } };
  E.sync.handle = (msg) => blobFrames('effect', evil).map(f => ({ ...f, sha: msg.sha }));
  eq('only Evil asked → missing', await B.sync.ensure(REF, { from: 'Evil' }), 'missing');
  eq('tamper counted', B.sync.stats().tampered, 1);
  B.sync.noteHolder(prefixOf(REF.sha256), 'Evil');
  eq('Evil then A → ready (from A)', await B.sync.ensure(REF, { from: 'A' }), 'ready');
  eq('B learned from A, not Evil', B.learned, ['A']);
  // A poisoned cache entry is not trusted either (effects-repo cache verifies the name hash).
  const st = createFxStore({ bundled, validate: () => ({ verdict: 'reject', reasons: ['power 9× > hard cap'] }) });
  st.addDef(FROST_LANCE);
  eq('validator reject → rejected', st.prepare(REF).status, 'rejected');
  const st2 = createFxStore({ bundled, validate: () => { throw new Error('boom'); } });
  st2.addDef(FROST_LANCE);
  eq('validator error → rejected (deterministic)', st2.prepare(REF).status, 'rejected');
  const light = bundled.effects.get('effect_lightning');
  if (light) {
    const variant = { ...light, version: '9.0.0', flags: { ...light.flags, lock: 3 } };
    const st3 = createFxStore({ bundled, builtinRules: EFFECT_RULES });
    st3.addDef(variant);
    eq('a built-in id with other flags → rejected', st3.prepare(makeFxRef(variant, libsBy(variant.uses))).status, 'rejected');
    const same = { ...light, version: '9.0.1', text: 'reworded' };
    st3.addDef(same);
    eq('a built-in id with the same flags → ready', st3.prepare(makeFxRef(same, libsBy(same.uses))).status, 'ready');
  }
  const st4 = createFxStore({ bundled });
  st4.addDef(FROST_LANCE);
  const extraLib = [...bundled.libs.values()].find(l => l.id !== 'std');
  if (extraLib) eq('ref pinning a lib the def does not use → rejected', st4.prepare(parseFxRef({ ...REF, libs: { ...REF.libs, [extraLib.id]: effectHash(extraLib) } })).status, 'rejected');
  // Real E5 validator on the fixture (if present): not a reject.
  try {
    const { checkEffect } = await import('./rebalancing-check.mjs');
    const v = checkEffect(FROST_LANCE).verdict;
    yes(`E5 verdict on Frost Lance is not reject (${v})`, v !== 'reject');
  } catch (e) { console.log(`skip E5 validator (${e.message})`); }
}

// ---------------------------------------------------------------- 4b. validator 1.1.0: the ref-pinned libs are priced
{
  const std = bundled.libs.get('std');
  const strongStd = JSON.parse(JSON.stringify(std)); strongStd.version = '9.9.9';
  strongStd.subs.main_delta.body = { '*': [strongStd.subs.main_delta.body, 2] };   // every delta hit deals double
  const lance = { ...FROST_LANCE, id: 'effect_frost_lance_lr' };                    // own id: section 6 registers Frost Lance
  // the store hands the validator exactly the libs the ref pins
  const seen = [];
  const spy = createFxStore({ bundled, validate: (def, o) => { seen.push({ id: def.id, libs: (o?.libs || []).map(l => [l.id, effectHash(l)]), libShas: o?.libShas }); return { verdict: 'ok' }; } });
  spy.addDef(lance); spy.addLib(strongStd);
  const refStrong = makeFxRef(lance, [strongStd]);
  spy.prepare(refStrong);
  eq('store → validator gets the ref-pinned libs + ref.libs', seen[0], { id: lance.id, libs: [['std', effectHash(strongStd)]], libShas: refStrong.libs });
  let checkEffect = null;
  try { ({ checkEffect } = await import('./rebalancing-check.mjs')); } catch (e) { console.log(`skip 4b validator (${e.message})`); }
  if (checkEffect) {
    const vSave = process.env.FX_VALIDATOR; delete process.env.FX_VALIDATOR;
    const pv = await createFxPeer({ selfId: 'peer:V', dimId: 'dim-lr-validator', log: () => {} });
    if (vSave !== undefined) process.env.FX_VALIDATOR = vSave;
    pv.store.addDef(lance); pv.store.addLib(strongStd);
    const pS = pv.store.prepare(refStrong);
    eq('peer validator: same def, stronger std pinned → rejected (priced)', [pS.status, /logic exceeds/.test(pS.reason || '') && /damage/.test(pS.reason || '')], ['rejected', true]);
    const refB = makeFxRef(lance, libsBy(['std']));
    // direct checks first: once accepted, the id is a registered foreign effect (skews a later audit in this process)
    const direct = checkEffect(lance);
    eq('stamp carries the libs map (bundled)', direct.stamp.libs, { std: effectHash(std) });
    eq('stamp carries the libs map (ref-pinned)', checkEffect(lance, { libs: [strongStd], libShas: refStrong.libs }).stamp.libs, { std: effectHash(strongStd) });
    const mm = checkEffect(lance, { libs: [strongStd], libShas: refB.libs });
    eq('a lib whose hash ≠ ref.libs → reject', [mm.verdict, mm.errors.some(e => e.includes('≠ pinned'))], ['reject', true]);
    const pB = pv.store.prepare(refB);
    eq('peer validator: same def, bundled std pinned → ready (not reject)', [pB.status, pB.verdict !== 'reject'], ['ready', true]);
    eq('no libs given → bundled verdict (= the bundled-std ref)', direct.verdict, pB.verdict);
  }
}

// ---------------------------------------------------------------- 5. have propagation A → B → C
{
  const net = makeNet();
  const A = net.add('A'), B = net.add('B'), C = net.add('C');
  net.blocked.add('C>A');   // C cannot reach A at all
  A.sync.adopt(FROST_LANCE, REF, libsBy(['std']));
  const hA = A.sync.haveCsv();
  eq('A announces id@sha16', hA, `effect_frost_lance@${prefixOf(REF.sha256)}`);
  const p1 = B.sync.noteHave('A', hA); await Promise.all(p1);
  eq('B prefetched from A’s have', B.store.status(REF), 'ready');
  eq('B learned from A', B.learned, ['A']);
  const hB = B.sync.haveCsv();
  eq('B now announces it too', hB, hA);
  const pC = C.sync.noteHave('A', hA); await Promise.all(pC);
  eq('C cannot get it from A', C.store.status(REF), 'missing');
  C.sync.noteHave('B', hB);
  // C sees A's commit (caster A) — the announced holder B is asked before the caster.
  eq('C candidates: holder B before caster A', C.sync.candidates(prefixOf(REF.sha256), 'A'), ['B', 'A']);
  eq('C ensures the ref from A’s commit', await C.sync.ensure(REF, { from: 'A' }), 'ready');
  eq('C learned from B, not A', C.learned, ['B']);
  eq('B shared with C', B.shared, ['C']);
  eq('A never served C', A.shared, ['B']);
  const again = C.sync.noteHave('B', hB);
  eq('no prefetch for what C holds', again.length, 0);
}

// ---------------------------------------------------------------- 6. fallback determinism
const ELEM_TO_STAT = { elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' };
const sha = s => createHash('sha256').update(s).digest('hex');
function world(stats, tiles, sides) {
  return {
    me: 'A', elemStat: el => ELEM_TO_STAT[el], statFor: (id, el) => stats[id][ELEM_TO_STAT[el]], baseStat: (id, sk) => stats[id][sk],
    lifeOf: () => 4, enemyOf: (a, b) => sides[a] !== sides[b],
    dist: (a, b) => Math.max(Math.abs(tiles[a].q - tiles[b].q), Math.abs(tiles[a].r - tiles[b].r), Math.abs((tiles[a].q + tiles[a].r) - (tiles[b].q + tiles[b].r))),
    tileOf: id => tiles[id], isFree: (q, r) => !Object.values(tiles).some(t => t.q === q && t.r === r),
    neighbours: (q, r) => [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]].map(([dq, dr]) => ({ q: q + dq, r: r + dr })),
    hasPerm: () => false, shieldedAgainst: () => false, disabledElems: () => new Set(), invisible: () => false,
    peers: () => Object.keys(tiles).sort(), sha, actionIndex: 3, threatElem: () => 'elem_fire', castElemOf: () => 'elem_fire',
  };
}
{
  const net = makeNet();
  const A = net.add('A'), B = net.add('B'), C = net.add('C');
  A.sync.adopt(FROST_LANCE, REF, libsBy(['std']));
  await B.sync.ensure(REF, { from: 'A' });
  const wire = { effect_id: 'effect_frost_lance', elements: ['elem_water', 'elem_air'], step: 1, of: 1, ref: compactRef(REF) };
  const mkReveals = () => [{ actor: 'A', action: 'P', effect: { ...wire } }, { actor: 'B', action: 'A', effect: null }, { actor: 'C', action: 'EP', effect: null }];
  const tapeWith = (missingBy) => [
    { type: 'evt_action_reveal', turn: 1, round: 0, actor_peer_id: 'A', payload: { effects: [wire] } },
    { type: 'evt_action_reveal', turn: 1, round: 0, actor_peer_id: 'B', payload: { effects: [] } },
    { type: 'evt_action_reveal', turn: 1, round: 0, actor_peer_id: 'C', payload: { effects: [], ...(missingBy === 'C' ? { fx_missing: [REF.sha256] } : {}) } },
  ];
  // (a) C reported missing in its reveal → every peer postpones, the holders included.
  const runs = [A, B, C].map(n => { const rv = mkReveals(); const g = gateReveals(rv, missingUnion(rv, tapeWith('C'), 1, 0), (r) => n.store.status(r)); return { tags: [...g.tags], abstain: g.abstain, eff: rv[0].effect, postponed: g.postponed }; });
  eq('missing → postponed on A, B and C alike', runs.map(r => JSON.stringify(r)), runs.map(() => JSON.stringify(runs[0])));
  eq('postponed cast leaves the resolver input', runs[0].eff, null);
  eq('postponed tag', runs[0].tags[0][1].split(':')[0], 'postponed');
  eq('nobody abstains when postponed', runs.map(r => r.abstain), [false, false, false]);
  // (b) nobody reported missing: holders resolve the pinned def; a lacking peer drops + abstains (never guesses).
  const rA = mkReveals(), rB = mkReveals(), rC = mkReveals();
  const gA = gateReveals(rA, missingUnion(rA, tapeWith(null), 1, 0), r => A.store.status(r));
  const gB = gateReveals(rB, missingUnion(rB, tapeWith(null), 1, 0), r => B.store.status(r));
  const gC = gateReveals(rC, missingUnion(rC, tapeWith(null), 1, 0), r => C.store.status(r));
  eq('holders tag fx:<key16> identically', [gA.tags.get('A'), gB.tags.get('A')], [`fx:${fxKey(REF).slice(0, 16)}`, `fx:${fxKey(REF).slice(0, 16)}`]);
  eq('lacking peer abstains', [gA.abstain, gB.abstain, gC.abstain], [false, false, true]);
  eq('lacking peer dropped the cast', rC[0].effect, null);
  // Both holders run the same bytes → identical outcomes; the registered run is what effects.mjs dispatches to.
  const stats = { A: { vitality: 10, world: 10, matter: 18, will: 10 }, B: { vitality: 10, world: 10, matter: 8, will: 10 }, C: { vitality: 10, world: 10, matter: 8, will: 10 } };
  const tiles = { A: { q: 0, r: 0 }, B: { q: 1, r: 0 }, C: { q: 5, r: 5 } }, sides = { A: 'npc_b', B: 'player', C: 'player' };
  const castOf = (r) => ({ actor: r.actor, effect_id: r.effect.effect_id, elements: r.effect.elements, salt: 's1', target: { kind: 'character', ref: 'B' }, is_instant: false, every: false, aura: false, step: 1, of: 1, kept: null, ...(r.effect.fx ? { fx: r.effect.fx } : {}) });
  const ocA = A.store.prepared(fxKey(REF)).run(world(stats, tiles, sides), castOf(rA[0]));
  const ocB = B.store.prepared(fxKey(REF)).run(world(stats, tiles, sides), castOf(rB[0]));
  eq('holders compute byte-identical outcomes', canonicalJson(ocA), canonicalJson(ocB));
  eq('Frost Lance hits B for (18−8)×2 = 20 → 2', ocA.hits.map(h => [h.victim, h.legs.map(l => Math.round(l.sum / 10))]), [['B', [2]]]);
  // effects.mjs dispatch: register via a store onReady, then resolveEffect(ctx, cast with fx).
  const reg = await createFxPeer({ selfId: 'peer:T', dimId: 'dim-e4unit', log: () => {} });
  const tmp = `${process.env.TMPDIR || '/tmp'}/_e4_fl_${process.pid}.json`;
  fs.writeFileSync(tmp, JSON.stringify(FROST_LANCE));
  const card = reg.forcedCard(tmp);
  fs.unlinkSync(tmp);
  yes('forced card is a foreign effect card', card?.fx?.sha256 === REF.sha256 && card.kind === 'effect' && card.scope === 'target');
  yes('foreign id registered (flags) but not built-in', isForeignEffectId('effect_frost_lance') && EFFECT_RULES.effect_frost_lance?.damage === 'delta');
  const viaEffects = resolveEffect(world(stats, tiles, sides), castOf(rA[0]));
  eq('effects.mjs#resolveEffect runs the pinned def', canonicalJson(viaEffects), canonicalJson(ocA));
  const noRef = resolveEffect(world(stats, tiles, sides), { ...castOf(rA[0]), fx: undefined });
  eq('foreign id without a ref = "no rules" (same as a peer that never learned it)', canonicalJson(noRef), canonicalJson(resolveEffectJs(world(stats, tiles, sides), { ...castOf(rA[0]), effect_id: 'effect_never_heard_of' })));
  eq('built-in casts are untouched', canonicalJson(resolveEffect(world(stats, tiles, sides), { ...castOf(rA[0]), effect_id: 'effect_lightning', elements: ['elem_fire', 'elem_air'], fx: undefined })),
    canonicalJson(resolveEffectJs(world(stats, tiles, sides), { ...castOf(rA[0]), effect_id: 'effect_lightning', elements: ['elem_fire', 'elem_air'], fx: undefined })));
  eq('snapshot announces it', reg.snapshotFields(), { fx_have: `effect_frost_lance@${prefixOf(REF.sha256)}` });
  // prepareResolution: my own postponed cast + the give-up counter.
  const myReveal = { effectFx: card.fx, effectCardId: card.card_id, effectId: card.effect_id, fxMissing: null };
  const tape = [{ type: 'evt_action_reveal', turn: 2, round: 1, actor_peer_id: 'peer:U', payload: { effects: [], fx_missing: [REF.sha256] } }];
  const rv = [{ actor: 'peer:T', action: 'P', effect: { effect_id: card.effect_id, elements: card.element_cost } }, { actor: 'peer:U', action: 'EP', effect: null }];
  const pr = await reg.prepareResolution(rv, tape, { turn: 2, round: 1, self: 'peer:T', myReveal });
  eq('my cast postponed when a revealer lacks it', [pr.mine, pr.giveUp, rv[0].effect], ['postponed', false, null]);
  const rv2 = [{ actor: 'peer:T', action: 'P', effect: { effect_id: card.effect_id, elements: card.element_cost } }];
  const pr2 = await reg.prepareResolution(rv2, [], { turn: 2, round: 2, self: 'peer:T', myReveal });
  eq('…and runs once nobody lacks it', [pr2.mine, !!rv2[0].effect?.fx, pr2.abstain], [null, true, false]);
  eq('no foreign ref → no tags', (await reg.prepareResolution([{ actor: 'x', effect: { effect_id: 'effect_lightning' } }], [], { turn: 0, round: 0, self: 'peer:T', myReveal: null })).tags.size, 0);
}

// ---------------------------------------------------------------- 7. FXG: foreign death-card gifts / profile cards {kind, id, ref}
{
  const net = makeNet();
  const A = net.add('A'), B = net.add('B'), C = net.add('C');
  const R = net.add('R', { validate: () => ({ verdict: 'reject', reasons: ['too strong'] }) });
  A.sync.adopt(FROST_LANCE, REF, libsBy(['std']));
  await B.sync.ensure(REF, { from: 'A' });
  const tool = await createFxPeer({ selfId: 'peer:G', dimId: 'dim-fxg', log: () => {} });
  const cardFor = tool.cardFor;
  const gift = { kind: 'effect', id: 'effect_frost_lance', ref: compactRef(REF) };
  // (a) in store: B already holds it → the card at once, no fetch.
  const before = B.sync.stats().fetched;
  const ra = await foreignCardFromRef(gift, { store: B.store, sync: B.sync, cardFor, from: 'A' });
  eq('gift in store → ready, held (src = where it came from)', [ra.status, ra.held, ra.src], ['ready', true, 'A']);
  eq('gift in store → no fetch', B.sync.stats().fetched, before);
  yes('gift card is the foreign effect card (fx ref, sha pinned)', ra.card?.kind === 'effect' && ra.card.effect_id === 'effect_frost_lance' && ra.card.fx?.sha256 === REF.sha256 && ra.card.tags.includes('foreign'));
  // (b) needs fetch: C lacks it → fetched from the giver A, learned, announced.
  const rb = await foreignCardFromRef(gift, { store: C.store, sync: C.sync, cardFor, from: 'A' });
  eq('gift needs fetch → ready from the giver', [rb.status, rb.src], ['ready', 'A']);
  eq('C learned from A', C.learned, ['A']);
  eq('C now announces it', C.sync.haveCsv(), `effect_frost_lance@${prefixOf(REF.sha256)}`);
  // (c) refused: R's validator rejects → no card (the card is lost).
  const rc = await foreignCardFromRef(gift, { store: R.store, sync: R.sync, cardFor, from: 'A' });
  eq('gift refused by the validator → rejected, no card', [rc.status, !!rc.card], ['rejected', false]);
  eq('…and refused again at once (cached verdict)', (await foreignCardFromRef(gift, { store: R.store, sync: R.sync, cardFor, from: 'A' })).status, 'rejected');
  // (d) not obtainable: the giver is unreachable, no holder → missing.
  const D = net.add('D'); net.blocked.add('D>A');
  eq('gift from an unreachable giver → missing', (await foreignCardFromRef(gift, { store: D.store, sync: D.sync, cardFor, from: 'A' })).status, 'missing');
  // …a holder named in the gift (holders) is asked too.
  eq('…a second holder serves it', (await foreignCardFromRef(gift, { store: D.store, sync: D.sync, cardFor, from: 'A', holders: ['B'] })).src, 'B');
  // (e) bad: a ref for another id / no ref at all.
  eq('ref id ≠ card id → bad', (await foreignCardFromRef({ ...gift, id: 'effect_fireball' }, { store: C.store, sync: C.sync, cardFor })).status, 'bad');
  eq('no ref → bad', (await foreignCardFromRef({ kind: 'effect', id: 'effect_frost_lance' }, { store: C.store, sync: C.sync, cardFor })).status, 'bad');
  // (f) cache first (profile load next session): the content cache holds def → ready with no transport at all.
  const cache = createMemoryCache(); cache.put(FROST_LANCE);
  const st = createFxStore({ bundled });
  const sy = createFxSync({ selfId: 'P', store: st, cache, request: null });
  const rf = await foreignCardFromRef(gift, { store: st, sync: sy, cardFor, timeoutMs: 500 });
  eq('profile card from the cache (no transport) → ready, src cache', [rf.status, rf.src], ['ready', 'cache']);
  // (g) the peer adapter: held (forced) → ready; a refused gift posts a `missing` effect_source notice.
  const uiSeen = [];
  // FX_VALIDATOR=0 here: a second adapter in one process sees Frost Lance already registered in EFFECT_RULES by
  // section 6, which skews the E5 audit; live peers are one process each (the validator gate is covered in (c)).
  const vSave = process.env.FX_VALIDATOR; process.env.FX_VALIDATOR = '0';
  const pe = await createFxPeer({ selfId: 'peer:H', dimId: 'dim-fxg', log: () => {}, ui: (m) => uiSeen.push(m) });
  if (vSave === undefined) delete process.env.FX_VALIDATOR; else process.env.FX_VALIDATOR = vSave;
  const tmp = `${process.env.TMPDIR || '/tmp'}/_fxg_fl_${process.pid}.json`;
  fs.writeFileSync(tmp, JSON.stringify(FROST_LANCE)); pe.forcedCard(tmp); fs.unlinkSync(tmp);
  eq('adapter: held gift → ready', (await pe.cardFromRef(gift, { from: 'peer:X' })).status, 'ready');
  const odd = { ...gift, id: 'effect_nope', ref: { ...gift.ref, id: 'effect_nope', sha256: 'e'.repeat(64) } };
  eq('adapter: unobtainable gift → missing', (await pe.cardFromRef(odd, { from: 'peer:X', timeoutMs: 300 })).status, 'missing');
  eq('adapter: missing → UI notice', uiSeen.map(m => [m.kind, m.event, m.ref?.id]), [['effect_source', 'missing', 'effect_nope']]);
  // (h) profile: a won foreign card keeps its ref; a built-in one is byte-identical to before (no ref / source keys).
  const pf = `${process.env.TMPDIR || '/tmp'}/_fxg_profile_${process.pid}.json`;
  fs.writeFileSync(pf, JSON.stringify({ version: 1, team_name: '', team_order: ['pc_t'], characters: [{ id: 'pc_t', name: 'T', cards: [], actions: { A: 4, B: 4, M: 4, P: 4 } }] }));
  const xf = addArchivedCard(pf, 'pc_t', { kind: 'effect', id: 'effect_frost_lance', ref: rb.card.fx }, 'Foe');
  const xb = addArchivedCard(pf, 'pc_t', { kind: 'effect', id: 'effect_lightning' }, 'Foe');
  eq('profile: foreign card keeps its ref', foreignRefOf(xf), compactRef({ ...REF, verdict: rb.card.fx.verdict }));
  eq('profile: built-in card has no ref / source', Object.keys(xb).sort(), ['from', 'id', 'kind', 'new', 'taken_at', 'uid', 'where']);
  const saved = loadProfile(pf).characters[0].cards.find(x => x.id === 'effect_frost_lance');
  eq('profile: ref survives save / load', saved.ref.sha256, REF.sha256);
  const rl = await foreignCardFromRef(saved, { store: st, sync: sy, cardFor });
  eq('profile: saved card rebuilds (cache-first)', [rl.status, rl.card?.effect_id], ['ready', 'effect_frost_lance']);
  // A death drop of the foreign profile card hands {kind, id, ref} on.
  const p2 = loadProfile(pf); for (const x of p2.characters[0].cards) x.where = x.id === 'effect_frost_lance' ? 'deck' : 'archive';
  fs.writeFileSync(pf, JSON.stringify(p2));
  const dropped = dropRandomDeckCard(pf, 'pc_t');
  eq('profile: death drop of a foreign card carries its ref', [dropped.kind, dropped.id, dropped.ref?.sha256], ['effect', 'effect_frost_lance', REF.sha256]);
  const cat = { skills: {}, effects: { effect_lightning: {} }, classes: {}, units: [], characters: {} };
  const ve = validateCharacter({ cards: [{ uid: 'u1', kind: 'effect', id: 'effect_frost_lance', where: 'deck', ref: compactRef(REF) }, { uid: 'u2', kind: 'effect', id: 'effect_unknown', where: 'deck' }] }, cat).filter(e => e.startsWith('card '));
  eq('profile validation: foreign card accepted, unknown built-in still refused', ve, ['card u2: unknown effect effect_unknown']);
  fs.unlinkSync(pf);
}

// ---------------------------------------------------------------- LR. libs from the repo commit of the ref
{
  const { buildEffectsManifest, httpdEffectLibFetcher, effectLibHash } = await import('../effects-repo.mjs');
  // the repo index's libs are exactly the set-id libs (libs stay in the set id; nothing new to add)
  eq('LR: index.json libs == bundled set libs', buildEffectsManifest([], null, [...bundled.libs.values()]).libs, bundled.set.libs);
  const myLib = { schema: 'chaosd6.effect-lib/1', id: 'lrlib', version: '1.0.0', subs: { zap: { params: [], body: { put: ['status', 'fizzled'] } } } };
  const myLib2 = { ...myLib, version: '2.0.0' };
  const def = { ...FROST_LANCE, id: 'effect_lr_probe', uses: ['lrlib'], logic: { call: ['zap'] } };
  const COMMIT = 'c'.repeat(40), RID = 'rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ';
  const ref = makeFxRef(def, [myLib], { repo: RID, branch: 'players/x/lr', commit: COMMIT });
  const defF = async (r) => (r.sha256 === ref.sha256 ? def : null);
  const seen = [];
  const libF = (lib) => async (r) => { seen.push([r.id, r.commit, r.repo]); return lib; };
  const mk = (libFallbackFetchers) => createFxSync({ selfId: 'Z', store: createFxStore({ bundled }), cache: createMemoryCache(), request: null, fallbackFetchers: [defF], libFallbackFetchers });
  eq('LR: no lib fallback (pre-LR) → a lib nobody serves stays missing', await mk([]).ensure(ref), 'missing');
  eq('LR: lib fetched from the repo at the ref commit → ready', await mk([libF(myLib)]).ensure(ref), 'ready');
  eq('LR: lib fetcher asked for lib id @ the effect ref\'s commit + repo', seen[0], ['lrlib', COMMIT, RID]);
  eq('LR: the repo commit holding another lib version → refused by hash (missing)', await mk([libF(myLib2)]).ensure(ref), 'missing');
  let url = '';
  const hl = httpdEffectLibFetcher({ seedHost: 'seed.example', fetchImpl: async (u) => { url = u; return { ok: true, status: 200, json: async () => ({ content: JSON.stringify(myLib) }) }; } });
  eq('LR: httpd lib fallback → ready', await mk([hl]).ensure(ref), 'ready');
  eq('LR: httpd lib URL', url, `https://${'seed.example'}/api/v1/repos/${RID}/blob/${COMMIT}/lib/lrlib.json`);
  yes('LR: another lib version is another fxKey', fxKey(makeFxRef(def, [myLib2])) !== fxKey(makeFxRef(def, [myLib])) && effectLibHash(myLib2) !== ref.libs.lrlib);
}

console.log(fails ? `${fails} handshake check(s) FAILED` : 'all handshake checks passed');
process.exit(fails ? 1 : 0);
