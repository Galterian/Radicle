// Data effect engine check (chaosD6-Effects E1).
//   node tools/effect-engine-check.mjs [--n 600] [--seed 1] [--verbose]
// For every effect with a data definition (game/effects-data/effects/*.json):
//   1. its `flags` equal EFFECT_RULES[id] (peer.mjs still reads those flags),
//   2. the effects-check fixture worlds × cast variants give JSON-identical outcomes on both engines,
//   3. N seeded random contexts give JSON-identical outcomes (or the same exception),
// plus dice primitives identical, engine limits deterministic, bad programs rejected, and
// tools/effects-check.mjs re-run with EFFECT_ENGINE=shadow EFFECT_SHADOW_STRICT=1 (0 mismatches).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as FXM from '../effects.mjs';
import * as ORC from '../effects-data/oracle/effects-js.mjs';   // F9e: the JS reference moved to the oracle
const JS = { ...FXM, EFFECT_RULES_JS: ORC.EFFECT_RULES_JS, resolveEffectJs: ORC.resolveEffectJs };
import * as DE from '../effect-engine.mjs';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(argOf('--n', 600));
const SEED = Number(argOf('--seed', 1));
const VERBOSE = args.includes('--verbose');
const here = path.dirname(fileURLToPath(import.meta.url));

const sha = s => createHash('sha256').update(s).digest('hex');
let fails = 0;
const ok = (label, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ` ${extra}` : ''}`); };

// ---- run both engines, compare JSON
const run = (f) => { try { return { v: JSON.stringify(f()) }; } catch (e) { return { e: String(e?.message || e) }; } };
const stats = {};
let firstDiff = null;
function compare(def, ctx, cast, label) {
  const a = run(() => JS.resolveEffectJs(ctx, cast));
  const b = run(() => DE.resolveEffectData(def, ctx, cast));
  const s = (stats[def.id] ||= { n: 0, same: 0, threw: 0, statuses: {} });
  s.n++;
  const same = a.v !== undefined ? a.v === b.v : a.e === b.e;
  if (same) { s.same++; if (a.e) s.threw++; else { const st = JSON.parse(a.v).status; s.statuses[st] = (s.statuses[st] || 0) + 1; } }
  else if (!firstDiff || VERBOSE) {
    firstDiff ||= label;
    console.log(`DIFF ${def.id} ${label}\n  cast: ${JSON.stringify(cast)}\n  js:   ${a.v ?? `throws ${a.e}`}\n  data: ${b.v ?? `throws ${b.e}`}`);
  }
  return same;
}

// ---- the effects-check world helper (same shape as tools/effects-check.mjs)
const ELEM_TO_STAT = { elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' };
function world(st, tiles, sides, opts = {}) {
  const pen = opts.pen || {}, perms = opts.perms || {};
  const w = {
    me: 'C',
    elemStat: el => ELEM_TO_STAT[el],
    statFor: (id, el) => Math.max(0, st[id][ELEM_TO_STAT[el]] - (pen[id]?.[el] || 0)),
    baseStat: (id, sk) => st[id][sk],
    lifeOf: id => opts.life?.[id] ?? 4,
    enemyOf: (a, b) => sides[a] !== sides[b],
    dist: (a, b) => Math.max(Math.abs(tiles[a].q - tiles[b].q), Math.abs(tiles[a].r - tiles[b].r), Math.abs((tiles[a].q + tiles[a].r) - (tiles[b].q + tiles[b].r))),
    tileOf: id => tiles[id],
    isFree: (q, r) => !Object.values(tiles).some(t => t && t.q === q && t.r === r),
    neighbours: (q, r) => [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]].map(([dq, dr]) => ({ q: q + dq, r: r + dr })),
    hasPerm: (id, p) => !!perms[id]?.includes(p),
    shieldedAgainst: (id, el) => !!opts.shield?.[id]?.includes(el),
    disabledElems: id => new Set(opts.disabled?.[id] || []),
    invisible: id => !!perms[id]?.includes('effect_invisibility'),
    peers: () => Object.keys(tiles).sort(),
    sha, actionIndex: opts.actionIndex ?? 7,
    castElemOf: () => 'elem_fire',
  };
  if (opts.threat !== null) w.threatElem = () => opts.threat ?? 'elem_fire';
  return w;
}
const M = (v, w, m, wi) => ({ vitality: v, world: w, matter: m, will: wi });

const defs = DE.loadEffectDefs();
console.log(`data effects: ${[...defs.keys()].join(', ')}`);

// 1. flags = EFFECT_RULES_JS (the JS oracle); EFFECT_RULES (what the game reads) = the definitions' flags (F1)
for (const def of defs.values()) ok(`${def.id}: flags equal EFFECT_RULES_JS`, JSON.stringify(def.flags) === JSON.stringify(JS.EFFECT_RULES_JS[def.id]));
ok('EFFECT_RULES = the definitions (ids, flags)', JSON.stringify(Object.keys(JS.EFFECT_RULES)) === JSON.stringify([...defs.keys()].sort())
  && [...defs.values()].every(d => JSON.stringify(d.flags) === JSON.stringify(JS.EFFECT_RULES[d.id])));
ok('EFFECT_RULES_JS has no effect without a definition', Object.keys(JS.EFFECT_RULES_JS).every(id => defs.has(id)));
ok(`default EFFECT_ENGINE = data (got ${JS.EFFECT_ENGINE})`, process.env.EFFECT_ENGINE ? true : JS.EFFECT_ENGINE === 'data');
ok('noRulesOutcome = resolveEffectJs of an unknown effect (key order too)', JSON.stringify(JS.noRulesOutcome()) === JSON.stringify(JS.resolveEffectJs({}, { effect_id: '', actor: 'A', elements: [] })));

// 2. dice primitives identical
{
  let same = true;
  for (let s = -2; s <= 40 && same; s++) {
    if (JS.diceCount(s) !== DE.diceCount(s)) same = false;
    for (let i = 0; i < 60; i++) if (JSON.stringify(JS.pointBuy(s, `p${s}:${i}`, sha)) !== JSON.stringify(DE.pointBuy(s, `p${s}:${i}`, sha))) { same = false; break; }
  }
  ok('dice primitives (diceCount, pointBuy) identical over stats −2..40 × 60 seeds', same);
}

// 3. effects-check fixtures × cast variants
const tiles = { C: { q: 0, r: 0 }, E: { q: 1, r: 0 }, F: { q: 0, r: 1 }, A: { q: -1, r: 0 } };
const sides = { C: 'player', E: 'npc_b', F: 'npc_b', A: 'player' };
const far = { C: { q: 0, r: 0 }, E: { q: 5, r: 0 }, F: { q: 0, r: 5 }, A: { q: -1, r: 0 } };
const farF = { ...tiles, F: { q: 6, r: 0 } };
const base = { C: M(10, 10, 16, 10), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 10, 8, 10) };
const fixtures = [
  ['plain', world(base, tiles, sides)],
  ['counter-spelled fire', world(base, tiles, sides, { pen: { C: { elem_fire: 8 } } })],
  ['meteor caster', world({ ...base, C: M(10, 10, 30, 10) }, farF, sides)],
  ['mutate caster', world({ ...base, C: M(30, 10, 16, 10) }, tiles, sides)],
  ['fireball stats', world({ C: M(10, 10, 15, 10), E: M(10, 10, 7, 10), F: M(10, 10, 7, 10), A: M(10, 10, 7, 10) }, tiles, sides)],
  ['rule 15', world({ C: M(10, 10, 15, 10), E: M(10, 10, 14, 10), F: M(10, 10, 5, 10), A: M(10, 10, 7, 10) }, tiles, sides)],
  ['shield on E', world(base, tiles, sides, { shield: { E: ['elem_fire', 'elem_earth'] } })],
  ['invisible E', world(base, tiles, sides, { perms: { E: ['effect_invisibility'] } })],
  ['invisible E+F', world(base, tiles, sides, { perms: { E: ['effect_invisibility'], F: ['effect_invisibility'] } })],
  ['invisible caster + E', world(base, tiles, sides, { perms: { C: ['effect_invisibility'], E: ['effect_invisibility'] } })],
  ['emotions bombard', world(base, tiles, sides, { perms: { E: ['effect_emotions_bombard'] } })],
  ['disabled air', world(base, tiles, sides, { disabled: { C: ['elem_air'] } })],
  ['disabled earth', world(base, tiles, sides, { disabled: { C: ['elem_earth'] } })],
  ['aura', world(base, tiles, sides, { perms: { C: ['effect_aura'] } })],
  ['alone', world({ ...base, C: M(15, 10, 10, 10) }, far, sides)],
  ['E dead', world(base, tiles, sides, { life: { E: 0 } })],
  ['weak will', world({ ...base, C: M(30, 10, 10, 1) }, tiles, sides)],
  ['strong', world({ ...base, C: M(12, 14, 30, 12) }, tiles, sides)],
  ['no threatElem', world(base, tiles, sides, { threat: null })],
  ['life spread', world(base, tiles, sides, { life: { C: 4, A: 2, E: 1, F: 3 } })],
];
const castVariants = (def) => {
  const el = def.elements;
  const b = { actor: 'C', effect_id: def.id, elements: el, salt: 'abc', target: { kind: 'character', ref: 'E' }, is_instant: false };
  return [
    ['target E', b], ['target F', { ...b, target: { kind: 'character', ref: 'F' } }], ['target A (ally)', { ...b, target: { kind: 'character', ref: 'A' } }],
    ['target self', { ...b, target: { kind: 'character', ref: 'C' } }], ['no target', { ...b, target: null }],
    ['tile adjacent', { ...b, target: { kind: 'tile', ref: { q: 0, r: -1 } }, elem: 'elem_fire' }], ['tile far', { ...b, target: { kind: 'tile', ref: { q: 3, r: 3 } } }],
    ['∀', { ...b, every: true }], ['aura ∀', { ...b, aura: true }], ['instant', { ...b, is_instant: true }], ['boost 9', { ...b, boost: 9 }],
    ['step 1/3', { ...b, of: 3, step: 1, kept: null }], ['step 3/3 kept', { ...b, elements: [el[0], el[0], el[0]], of: 3, step: 3, kept: [3, 4, 5] }],
    ['step 2/2 partial kept', { ...b, of: 2, step: 2, kept: [4, null].slice(0, el.length) }], ['channel tick', { ...b, _channel_tick: true }],
    ['salt r7', { ...b, salt: 'r7' }], ['other elements', { ...b, elements: ['elem_vitality', 'elem_harmony'] }], ['no elements', { ...b, elements: [] }],
  ];
};
for (const def of defs.values()) {
  let n = 0, same = 0;
  for (const [wl, w] of fixtures) for (const [cl, c] of castVariants(def)) { n++; if (compare(def, w, c, `fixture ${wl} / ${cl}`)) same++; }
  ok(`${def.id}: effects-check fixtures × cast variants identical`, same === n, `(${same}/${n})`);
}

// 4. seeded random contexts
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const POOL = ['C', 'E', 'F', 'A', 'g', 'b', 'B', 'peer:z', 'peer:Ab', 'x-1', 'Ω'];
const PERMS = ['effect_aura', 'effect_invisibility', 'effect_haste', 'effect_emotions_bombard'];
const SIDES = ['player', 'npc_a', 'npc_b'];
function randomCase(rnd, def) {
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (l) => l[Math.floor(rnd() * l.length)];
  const chance = (p) => rnd() < p;
  const n = ri(1, 7);
  const ids = [...POOL].sort(() => rnd() - 0.5).slice(0, n);
  const me = ids[0];
  const tiles = {}, st = {}, sd = {}, life = {}, perms = {}, shield = {}, pen = {};
  for (const id of ids) {
    tiles[id] = chance(0.15) ? { q: ri(4, 12), r: ri(-3, 3) } : { q: ri(-2, 2), r: ri(-2, 2) };
    st[id] = M(ri(0, 32), ri(0, 32), ri(0, 32), ri(0, 32));
    sd[id] = pick(SIDES);
    life[id] = chance(0.15) ? 0 : ri(1, 6);
    perms[id] = PERMS.filter(p => chance(p === 'effect_emotions_bombard' ? 0.04 : 0.15));
    if (chance(0.2)) shield[id] = JS.ALL_ELEMS.filter(() => chance(0.25));
  }
  if (chance(0.3)) pen[me] = { [pick(JS.ALL_ELEMS)]: ri(1, 10) };
  const opts = { pen, perms, shield, life, actionIndex: ri(0, 40), threat: chance(0.15) ? null : chance(0.1) ? undefined : pick(JS.ALL_ELEMS) };
  if (chance(0.05)) opts.disabled = { [me]: [pick(def.elements)] };
  const w = world(st, tiles, sd, opts);
  if (chance(0.04)) { const t0 = w.tileOf; w.tileOf = id => (id === me ? undefined : t0(id)); }
  const elems = chance(0.7) ? [...def.elements] : chance(0.8) ? Array.from({ length: ri(1, 3) }, () => pick(JS.ALL_ELEMS)) : chance(0.5) ? [] : [...def.elements, pick(JS.ALL_ELEMS)];
  const myT = tiles[me];
  const tk = rnd();
  const target = tk < 0.5 ? { kind: 'character', ref: pick(ids) } : tk < 0.75 ? { kind: 'tile', ref: { q: myT.q + ri(-2, 2), r: myT.r + ri(-2, 2) } } : null;
  const of = chance(0.6) ? ri(1, 4) : undefined;
  const cast = {
    actor: me, effect_id: def.id, elements: elems, salt: chance(0.05) ? undefined : `s${ri(0, 1e6)}`, target,
    is_instant: chance(0.2), every: chance(0.25), aura: chance(0.1),
    ...(of !== undefined ? { of } : {}), ...(chance(0.6) ? { step: ri(1, 5) } : {}),
    kept: chance(0.4) ? null : chance(0.7) ? elems.map(() => (chance(0.4) ? null : ri(1, 6))) : [ri(1, 6)],
    ...(chance(0.15) ? { boost: ri(1, 9) } : {}), ...(chance(0.3) ? { elem: chance(0.8) ? pick(JS.ALL_ELEMS) : 'bogus' } : {}),
    ...(chance(0.05) ? { _channel_tick: true } : {}),
  };
  return { w, cast };
}
for (const def of defs.values()) {
  const rnd = mulberry32(SEED * 7919 + [...def.id].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 0));
  let same = 0;
  for (let i = 0; i < N; i++) { const { w, cast } = randomCase(rnd, def); if (compare(def, w, cast, `random #${i}`)) same++; }
  const s = stats[def.id];
  ok(`${def.id}: ${N} random contexts identical`, same === N, `(${same}/${N}; all cases ${s.same}/${s.n}, outcomes ${JSON.stringify(s.statuses)}${s.threw ? `, ${s.threw} threw identically` : ''})`);
}

// 4b. effect-specific fixtures: every tools/effect-engine-fixtures/*.mjs default-exports
//     (h) => void and gets the helpers below (branches the random worlds do not reach:
//     channel ticks, traps, declared allies, map queries …). Files load in name order.
{
  const fxDir = path.join(here, 'effect-engine-fixtures');
  const { readdirSync, existsSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const files = existsSync(fxDir) ? readdirSync(fxDir).filter(f => f.endsWith('.mjs')).sort() : [];
  const h = { defs, world, M, compare, ok, sha, JS, DE, mulberry32, randomCase, stats, N, SEED, tiles, sides, base };
  for (const f of files) await (await import(pathToFileURL(path.join(fxDir, f)).href)).default(h);
}

// 5. limits, determinism, rejection
{
  const def = defs.get('effect_meteor_shower');
  const w = world({ ...base, C: M(10, 10, 30, 10) }, farF, sides);
  const c = { actor: 'C', effect_id: def.id, elements: ['elem_fire', 'elem_fire', 'elem_fire'], salt: 'abc', target: null, of: 3, step: 3, kept: [3, 4, 5] };
  const a = DE.resolveEffectData(def, w, c, { limits: { maxOps: 200 } }), b = DE.resolveEffectData(def, w, c, { limits: { maxOps: 200 } });
  ok('op budget exhausted → deterministic error outcome', a.status === 'error' && JSON.stringify(a) === JSON.stringify(b) && a.hits.length === 0, a.notes[0]);
  const loop = { schema: DE.EFFECT_SCHEMA_ID, id: 'effect_loop_test', name: 'Loop', version: '0.0.1', elements: ['elem_fire'], cost: 1, kind: 'damage', duration: 'instant', flags: {}, uses: ['std'], logic: { call: ['loop_forever'] } };
  const lib = { schema: DE.LIB_SCHEMA_ID, id: 'std', version: '0', subs: { loop_forever: { params: [], body: { call: ['loop_forever'] } } } };
  const ld = DE.loadEffectDefs({ effects: [loop], libs: [lib] }).get('effect_loop_test');
  const r = DE.resolveEffectData(ld, w, { ...c, effect_id: 'effect_loop_test' });
  ok('unbounded recursion → depth-limit error outcome', r.status === 'error', r.notes[0]);
  const wide = { ...loop, id: 'effect_wide_test', logic: { map: [{ range: [0, 1000] }, { map: [{ range: [0, 1000] }, { '+': [1, 1] }] }] } };
  const rw = DE.resolveEffectData(DE.loadEffectDefs({ effects: [wide], libs: [lib] }).get('effect_wide_test'), w, { ...c, effect_id: 'effect_wide_test' });
  ok('1000×1000 loop → op-budget error outcome', rw.status === 'error', rw.notes[0]);
  let rejected = null;
  try { DE.loadEffectDefs({ effects: [{ ...loop, id: 'effect_bad_test', logic: { eval: ['process.exit()'] } }], libs: [lib] }); } catch (e) { rejected = e.message; }
  ok('unknown operation rejected at load', !!rejected && /unknown operation eval/.test(rejected), rejected || '');
  rejected = null;
  try { DE.loadEffectDefs({ effects: [{ ...loop, id: 'effect_bad2_test', logic: { emit: ['hits', { victim: 'x' }] } }], libs: [lib] }); } catch (e) { rejected = e.message; }
  ok('bare object literal (not an op) rejected at load', !!rejected, rejected || '');
  // The comparison itself can fail: a Lightning whose ∀ multiplier is 3 instead of 2 must differ.
  const lt = defs.get('effect_lightning');
  const bad = { ...JSON.parse(JSON.stringify(lt)), logic: JSON.parse(JSON.stringify(lt.logic).replace('{"if":[{"var":"cast.every"},2,1]}', '{"if":[{"var":"cast.every"},3,1]}')) };   // the program only (F9: card.logic comes first)
  const badDef = DE.loadEffectDefs({ effects: [bad], libs: [JSON.parse(JSON.stringify(Object.fromEntries([['schema', DE.LIB_SCHEMA_ID], ['id', 'std'], ['version', '1'], ['subs', Object.fromEntries(lt.$subs)]])))] }).get('effect_lightning');
  const lc = { actor: 'C', effect_id: 'effect_lightning', elements: ['elem_fire', 'elem_air'], salt: 'abc', target: { kind: 'character', ref: 'E' }, every: true };
  const saved = stats.effect_lightning ? { ...stats.effect_lightning } : null;
  const v0 = VERBOSE; firstDiff = 'self-test';
  ok('self-test: a tampered definition (∀ lock ×3) is caught', compare(badDef, world(base, tiles, sides), lc, 'self-test') === false && compare(lt, world(base, tiles, sides), lc, 'self-test') === true);
  if (saved) stats.effect_lightning = saved; firstDiff = null; void v0;
  // Speed: data engine vs JS on a Fireball fixture.
  const fb = defs.get('effect_fireball'), fw = world(base, tiles, sides), fc = { actor: 'C', effect_id: 'effect_fireball', elements: ['elem_fire', 'elem_fire'], salt: 'abc', target: { kind: 'character', ref: 'E' } };
  let t = process.hrtime.bigint(); for (let i = 0; i < 2000; i++) JS.resolveEffectJs(fw, { ...fc, salt: `t${i}` }); const tj = Number(process.hrtime.bigint() - t) / 2e6;
  t = process.hrtime.bigint(); for (let i = 0; i < 2000; i++) DE.resolveEffectData(fb, fw, { ...fc, salt: `t${i}` }); const td = Number(process.hrtime.bigint() - t) / 2e6;
  console.log(`info speed per Fireball resolve: js ${tj.toFixed(1)} µs, data ${td.toFixed(1)} µs`);
  const proto = { ...loop, id: 'effect_proto_test', logic: { var: 'cast.__proto__.constructor' } };
  ok('prototype paths read as undefined', DE.resolveEffectData(DE.loadEffectDefs({ effects: [proto], libs: [lib] }).get('effect_proto_test'), w, c).status === 'done');
}

// 6. effects-check under the shadow engine (strict)
{
  const r = spawnSync(process.execPath, [path.join(here, 'effects-check.mjs')], { cwd: path.join(here, '..'), env: { ...process.env, EFFECT_ENGINE: 'shadow', EFFECT_SHADOW_STRICT: '1', EFFECT_SHADOW_REPORT: '1' }, encoding: 'utf8' });
  const tally = (r.stdout.match(/\[effects\] shadow:.*$/m) || [''])[0];
  ok('effects-check with EFFECT_ENGINE=shadow (strict) passes, 0 mismatches', r.status === 0 && /all checks passed/.test(r.stdout) && /mismatches 0 /.test(tally), tally || (r.stderr || r.stdout).slice(-400));
}

const total = Object.values(stats).reduce((a, s) => a + s.n, 0), same = Object.values(stats).reduce((a, s) => a + s.same, 0);
console.log(`\ncompared ${total} outcomes across ${defs.size} effects: ${same} identical`);
console.log(fails ? `${fails} FAILED` : 'all effect-engine checks passed');
process.exit(fails ? 1 : 0);
