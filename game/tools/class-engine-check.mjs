// Class engine check (chaosD6-Classes C2): the JsonLogic class definitions (game/classes-data) give the same outcomes as
// the built-in JS hooks of game/classes.mjs.
//   node tools/class-engine-check.mjs        → ends with "all class-engine checks passed"   (CLASS_ENGINE_CHECK_N, default 600)
// 1. files    — 33 definitions + lib classes_std load and validate; ids = CLASSES_IMPLEMENTED; name / version / data =
//               data/classes.json (active version); flags = CLASS_RULES; JS markers only on the peer-resolved abilities.
// 2. identity — every class × every hook it answers (std + its own), N seeded worlds (tools/class-fixtures.mjs, with
//               mutated class data): classHook (JS) and resolveClassProgram (data) JSON-identical, args never mutated.
// 3. limits   — bad / runaway / denied programs: rejected by validation, or the neutral value at run time (+ error tally).
// 4. foreign  — registerForeignClass: a player-branch class answers through its programs only.
// 5. engines  — tools/classes-check.mjs under CLASS_ENGINE=shadow (strict) and CLASS_ENGINE=data.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as CL from '../classes.mjs';
import * as CE from '../class-engine.mjs';
import { CLASSES, genWorld, argsFor } from './class-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.env.CLASS_ENGINE_CHECK_N || 600);
let fails = 0, oks = 0;
const J = (x) => JSON.stringify(x);
const eq = (label, got, want) => {
  const ok = J(got) === J(want);
  if (ok) oks++; else fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n     got  ${String(J(got)).slice(0, 400)}\n     want ${String(J(want)).slice(0, 400)}`}`);
  return ok;
};
const throws = (label, fn, re) => { try { fn(); return eq(`${label} (throws)`, 'no throw', 'throws'); } catch (e) { return eq(`${label}: ${e.message.slice(0, 120)}`, re.test(e.message), true); } };

// ---- 1. files ----------------------------------------------------------------------------------------------------
console.log('-- 1. files');
const B = CL.classBundle();
eq('lib classes_std loads (1 lib)', B.libs.map(l => l.id), ['classes_std']);
eq('std defaults cover every std hook', Object.keys(B.std).sort(), [...CE.STD_HOOKS].sort());
eq('33 definitions, ids = CLASSES_IMPLEMENTED', [...B.defs.keys()].sort(), [...CL.CLASSES_IMPLEMENTED].sort());
eq('CLASSES_IMPLEMENTED = data/classes.json', [...CL.CLASSES_IMPLEMENTED].sort(), Object.keys(CLASSES).sort());
{
  const meta = [], flags = [], hooks = [], markers = [], keys = [];
  for (const [id, d] of B.defs) {
    const C = CLASSES[id];
    if (d.name !== C.name || d.version !== C.version || J(d.data) !== J(C.data) || d.source?.version !== C.version) meta.push(id);
    if (J(d.flags) !== J(CL.CLASS_RULES[id])) flags.push(id);
    const want = CL.CLASS_RULES[id].hooks.filter(h => !h.startsWith('peer:')).sort();
    const own = Object.keys(d.hooks).filter(h => !CE.HOOK_SPECS[h].std || want.includes(h)).sort();
    if (J(own) !== J(want)) hooks.push(`${id}: ${own} vs ${want}`);
    for (const [h, p] of Object.entries(d.hooks)) if (CE.isJsMarker(p)) markers.push(`${id}.${h}`);   // phase 3: none left
    const k = Object.keys(d).sort().join(',');
    // phase 5: a /2 definition may carry `ui`
    if (k !== 'data,flags,hooks,id,name,schema,source,uses,version' && !(d.schema === CE.CLASS_SCHEMA_ID && k === 'data,flags,hooks,id,name,schema,source,ui,uses,version')) keys.push(`${id}: ${k}`);
  }
  eq('name / version / data = the active data/classes.json version', meta, []);
  eq('flags = classes.mjs CLASS_RULES', flags, []);
  eq('hooks = the class\'s CLASS_RULES hooks (peer: sites excluded)', hooks, []);
  eq('no JS markers (phase 3: the map-bound abilities are engine requests)', markers, []);
  eq('definition keys', keys, []);
  eq('every built-in validates (as built-in)', [...B.defs.values()].flatMap(d => CL.validateClassDef(d)), []);
  eq('every built-in also validates as a foreign class (pure data)', [...B.defs.values()].flatMap(d => CE.validateClassDef(d, { builtin: false }).map(e => `${d.id}: ${e}`)), []);
}
// Phase 5 (2026-11-20): schema chaosd6.class/2 = /1 + `ui`; /1 stays loadable (user ruling 4).
{
  const strip = (d) => JSON.parse(JSON.stringify(d));
  const an = strip(B.defs.get('class_animator')), v1 = { ...an, schema: 'chaosd6.class/1' }; delete v1.ui;
  eq('ui: the 4 definitions with a ui block are /2', [...B.defs.values()].filter(d => d.ui).map(d => `${d.id}:${d.schema}`).sort(),
    ['class_animator:chaosd6.class/2', 'class_priest:chaosd6.class/2', 'class_prophet:chaosd6.class/2', 'class_seeker:chaosd6.class/2']);
  eq('ui: a /1 definition (no ui) still validates', CE.validateClassDef(v1, { builtin: false }), []);
  eq('ui: a /1 definition still loads (loadClassDefs)', [...CE.loadClassDefs({ classes: [v1] }).defs.keys()], ['class_animator']);
  eq('ui: /1 with a ui block is refused', CE.validateClassDef({ ...v1, ui: { icon: '★' } }, { builtin: false }), ['ui needs schema chaosd6.class/2']);
  eq('ui: an unknown key / an empty or long value is refused', CE.validateClassDef({ ...an, ui: { colour: 'red', needs_hint: '', icon: '★★★★★' } }, { builtin: false }),
    ['ui.colour: unknown key (needs_hint, ability_label, icon, notice)', 'ui.needs_hint must be a non-empty string (≤ 400 chars)', 'ui.icon must be a non-empty string (≤ 4 chars)']);
  eq('ui: an unknown schema is refused', CE.validateClassDef({ ...v1, schema: 'chaosd6.class/3' }, { builtin: false }), ['schema must be chaosd6.class/1 or chaosd6.class/2']);
  eq('classUi: the block / {} for none', [CE.classUi(an), CE.classUi(v1)], [an.ui, {}]);
  eq('classUiOf: prophet notice, necromancer reanim (data.destroy_reanimated), reaver nothing',
    [CL.classUiOf('class_prophet').notice?.slice(0, 11), CL.classUiOf('class_necromancer'), CL.classUiOf('class_reaver'), CL.classUiOf('class_nope')],
    ['automatic —', { reanim: { elements: ['elem_harmony', 'elem_concentration'], die: 6 } }, {}, {}]);
  // the generic bot planner (tools/swarm-test.mjs classProfile) reads these
  eq('abilityRecordsOf: the record each clickable built-in can give',
    Object.fromEntries([...B.defs].map(([id, d]) => [id.replace('class_', ''), CE.abilityRecordsOf(d).join(',')]).filter(([, r]) => r)),
    { alchemist: 'traps', animator: 'copy_building', avenger: 'lures', cleric: 'disable_traps', druid: 'tokens', healer: 'heals', illusionist: 'illusion', necromancer: 'revives', overlord: 'armor', priest: 'build', ranger: 'traps', seeker: 'far_trap', warrior: 'step', witch: 'discards' });
}

// ---- 2. identity -------------------------------------------------------------------------------------------------
console.log(`-- 2. identity: JS hooks vs JsonLogic definitions (${N} worlds per class and hook)`);
{
  let cases = 0;
  const bad = {};
  for (const [id, def] of B.defs) {
    const hooks = [...CE.STD_HOOKS, ...CL.CLASS_RULES[id].hooks.filter(h => !h.startsWith('peer:') && !CE.HOOK_SPECS[h].std)];
    // + one hook the class does not answer (the neutral value on both sides)
    const other = CE.HOOK_NAMES.find(h => !hooks.includes(h) && h !== 'local');
    for (const h of [...hooks, other].filter(Boolean)) for (let s = 0; s < N; s++) {
      const W = genWorld(s * 131 + id.length * 7 + h.length);
      const { args, ctx = W.ctx } = argsFor(h, id, W, W.R);
      const pre = J(args);
      let js, da;
      try { js = J(CL.classHook(h, id, ctx, structuredClone(args))); } catch (e) { js = `THROW ${e.message}`; }
      try { da = J(CL.resolveClassProgram(def, h, ctx, args)); } catch (e) { da = `THROW ${e.message}`; }
      cases++;
      if (J(args) !== pre) da = 'MUTATED ARGS';
      if (js !== da) { const k = `${id} ${h}`; if (!bad[k]) console.log(`FAIL ${k} seed ${s}\n     args ${pre.slice(0, 400)}\n     js   ${String(js).slice(0, 500)}\n     data ${String(da).slice(0, 500)}`); bad[k] = (bad[k] || 0) + 1; }
    }
  }
  eq(`${cases} cases, mismatching class hooks`, bad, {});
  eq('no data hook error on the way', CL.classShadowStats.errors, 0);
}

// ---- 3. bad programs, limits, denied ops -------------------------------------------------------------------------
console.log('-- 3. bad programs, limits, denied ops');
{
  const witch = B.defs.get('class_witch');
  const mk = (hooks, extra = {}) => ({ ...JSON.parse(J(witch)), id: 'class_test_x', name: 'Test', hooks, ...extra });
  const W = genWorld(5);
  for (const op of CE.DENIED_OPS) eq(`denied op ${op} rejected`, CE.validateClassDef(mk({ ability: { [op]: [1] } })).some(e => e.includes(op)), true);
  eq('unknown op rejected', CE.validateClassDef(mk({ ability: { frobnicate: [1] } })).length > 0, true);
  eq('unknown hook rejected', CE.validateClassDef(mk({ fly: true })).some(e => /unknown hook/.test(e)), true);
  eq('unknown lib rejected', CE.validateClassDef(mk({}, { uses: ['nope'] })).some(e => /unknown lib/.test(e)), true);
  eq('bad ability_kind rejected', CE.validateClassDef(mk({}, { data: { ...witch.data, ability_kind: 'sometimes' } })).some(e => /ability_kind/.test(e)), true);
  eq('duplicate colour rejected', CE.validateClassDef(mk({}, { data: { ...witch.data, colors: ['elem_fire', 'elem_fire'] } })).some(e => /colors/.test(e)), true);
  eq('bad id rejected', CE.validateClassDef(mk({}, { id: 'witch2' })).some(e => /id must/.test(e)), true);
  eq('JS marker rejected on a foreign class', CE.validateClassDef(mk({ ability: { engine: 'js', impl: 'peer.mjs#x' } }), { builtin: false }).some(e => /built-in classes only/.test(e)), true);
  const e0 = CL.classShadowStats.errors;
  const runaway = mk({ end_turn: { reduce: [{ range: [0, 200] }, { '+': [{ var: 'accumulator' }, { reduce: [{ range: [0, 200] }, { '+': [{ var: 'accumulator' }, 1] }, 0] }] }, 0] } });
  eq('runaway program (op budget) → neutral 0', CL.resolveClassProgram(runaway, 'end_turn', W.ctx, { held: true, moved: false, life: 1, lifeMax: 3 }), 0);
  let deep = 1; for (let i = 0; i < 80; i++) deep = { '+': [deep, 0] };
  eq('too deep program (depth limit) → neutral 0', CL.resolveClassProgram(mk({ end_turn: deep }), 'end_turn', W.ctx, { held: true, moved: false, life: 1, lifeMax: 3 }), 0);
  eq('bad result shape → neutral (the attacker\'s damage)', CL.resolveClassProgram(mk({ attack_out: 'lots' }), 'attack_out', W.ctx, { attacker: 'p', dmg: 2, scored: [] }), 2);
  eq('bad result shape → neutral (trap springs)', CL.resolveClassProgram(mk({ dungeon_step: 'teleport' }), 'dungeon_step', W.ctx, { trap: true, trapLeft: 0 }), 'spring');
  eq('with_key refuses __proto__ → neutral config {}', CL.resolveClassProgram(mk({ config: { with_key: [{ quote: {} }, '__proto__', 1] } }), 'config', W.ctx, {}), {});
  eq('pairs result drops bad keys', CL.resolveClassProgram(mk({ colours: [['matter', ['elem_fire']], ['__proto__', ['x']]] }), 'colours', W.ctx, {}), { matter: ['elem_fire'] });
  eq('the failures above were tallied as data hook errors', CL.classShadowStats.errors - e0 >= 3, true);
  eq('a hook the definition lacks → the std default (colours from data.colors)', CL.resolveClassProgram(mk({}), 'colours', { ...W.ctx, classData: undefined }, {}), { vitality: ['elem_vitality'], matter: ['elem_air', 'elem_water'] });
}

// ---- 4. foreign classes ------------------------------------------------------------------------------------------
console.log('-- 4. foreign classes');
{
  const healer = JSON.parse(J(B.defs.get('class_healer')));
  const mender = { ...healer, id: 'class_mender', name: 'Mender', version: '0.1.0', source: { collection: 'classes', version: '0.1.0', branch: 'players/test' } };
  throws('a built-in id cannot be registered', () => CL.registerForeignClass('k0', healer), /built-in/);
  // Phase 3: no built-in carries a JS marker any more — the refused one is made up here.
  { const pr = JSON.parse(J(B.defs.get('class_priest'))); pr.hooks.ability = { engine: 'js', impl: 'peer.mjs#priestShrine' };
    throws('a foreign class with a JS marker is refused', () => CL.registerForeignClass('k1', { ...pr, id: 'class_shrine_keeper' }), /built-in classes only/); }
  const def = CL.registerForeignClass('players/test:class_mender', mender);
  eq('registered: isForeignClassId / foreignClassDef by key and id', [CL.isForeignClassId('class_mender'), CL.foreignClassDef('players/test:class_mender') === def, CL.foreignClassDef('class_mender') === def], [true, true, true]);
  eq('its flags join CLASS_RULES, not CLASSES_IMPLEMENTED', [J(CL.CLASS_RULES.class_mender) === J(healer.flags), CL.CLASSES_IMPLEMENTED.includes('class_mender')], [true, false]);
  let same = 0, n = 0;
  for (let s = 0; s < 200; s++) {
    const W = genWorld(9000 + s);
    const { args, ctx = W.ctx } = argsFor('ability', 'class_mender', W, W.R);
    const ctxM = { ...ctx, classData: (id) => (id === 'class_mender' ? mender.data : ctx.classData(id)) };
    const a = CL.classHook('ability', 'class_mender', ctxM, args);
    const b = CL.classHook('ability', 'class_healer', { ...ctx, classData: (id) => (id === 'class_healer' ? healer.data : ctx.classData(id)) }, { ...args, ab: { ...args.ab, id: 'class_healer' } });
    n++; if (J(a) === J(b)) same++;
  }
  eq('the Mender (a Healer copy) heals exactly like the Healer (200 worlds)', `${same}/${n}`, `${n}/${n}`);
  eq('a foreign class answers through data even under CLASS_ENGINE=js', CL.classHook('kind', 'class_mender', { classData: () => mender.data }), 'tap');
  CL.clearForeignClasses();
  eq('clearForeignClasses removes it', [CL.isForeignClassId('class_mender'), 'class_mender' in CL.CLASS_RULES], [false, false]);
}

// ---- 5. engines --------------------------------------------------------------------------------------------------
console.log('-- 5. tools/classes-check.mjs under CLASS_ENGINE=shadow (strict) and data');
for (const env of [{ CLASS_ENGINE: 'shadow', CLASS_SHADOW_STRICT: '1', CLASS_SHADOW_REPORT: '1' }, { CLASS_ENGINE: 'data' }]) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'classes-check.mjs')], { env: { ...process.env, CLASSES_CHECK_N: process.env.CLASSES_CHECK_N || '150', ...env }, encoding: 'utf8', maxBuffer: 64 << 20 });
  const out = `${r.stdout}${r.stderr}`;
  const last = out.trim().split('\n').filter(l => /class checks|\[classes\]/.test(l)).slice(-2).join(' | ');
  eq(`CLASS_ENGINE=${env.CLASS_ENGINE}: ${last}`, r.status === 0 && /all class checks passed/.test(out) && !/SHADOW MISMATCH|data hook:/.test(out), true);
}

// ---- 6. grep gate (class isolation phase 6, 2026-11-20) ---------------------------------------------------------
// The game is class-oblivious: no built-in class id as CODE (line comments are stripped) in the resolver, the UI, the
// bots, the engine and its primitives; the class-*.mjs config modules are gone; the JS oracle (classes-data/oracle)
// is only loaded dynamically, for CLASS_ENGINE=js | shadow.
console.log('-- 6. grep gate: no class ids in the game');
{
  const GAME = path.join(HERE, '..');
  const ids = [...B.defs.keys()];
  const idRe = new RegExp(`\\b(${ids.join('|')})\\b`, 'g');
  const code = (f) => fs.readFileSync(path.join(GAME, f), 'utf8').split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  const GATED = ['peer.mjs', 'js/main.js', 'tools/swarm-test.mjs', 'classes.mjs', 'class-engine.mjs', 'class-state.mjs', 'world-prims.mjs',
    'contact-prims.mjs', 'classes-handshake.mjs', 'effect-hooks.mjs', 'effects.mjs', 'awake.mjs'];
  const hits = GATED.flatMap(f => [...new Set(code(f).match(idRe) || [])].map(id => `${f}: ${id}`));
  eq(`no class_<id> literal in ${GATED.length} game files`, hits, []);
  eq('the class-*.mjs config modules are gone (oracles in classes-data/oracle)', ['class-world.mjs', 'class-traps.mjs', 'class-chase.mjs', 'class-manipulator.mjs'].filter(f => fs.existsSync(path.join(GAME, f))), []);
  const staticOracle = GATED.filter(f => /^\s*import\s[^;]*from\s*['"][^'"]*classes-data\/oracle\//m.test(code(f)));
  eq('no game file imports the oracle statically', staticOracle, []);
  eq('the oracle exports HOOKS for every hook of the engine', Object.keys((await import('../classes-data/oracle/classes-js.mjs')).HOOKS).sort(), [...CE.HOOK_NAMES].sort());
}

console.log(fails ? `${fails} class-engine check(s) FAILED (${oks} ok)` : `all class-engine checks passed (${oks} ok)`);
process.exit(fails ? 1 : 0);
