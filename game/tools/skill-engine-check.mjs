// Skill data-engine check (chaosD6-Skills S2): game/skills-data/skills/*.json (+ lib/skills_std.json) run on
// game/skill-engine.mjs must give exactly what the JS hooks of game/skills.mjs give.
//   node tools/skill-engine-check.mjs            → ends with "all skill-engine checks passed"
// 1. files: the 14 definitions + lib validate; metadata = data/skills.json; flags = SKILL_RULES (+ the S5 validator's
//    BUILTIN_FLAGS); hooks = SKILL_RULES hooks; pass hooks marked {"engine":"js"}.
// 2. identity: for every data hook and every skill that has a program for it (std hooks: every skill), ≥ 600 seeded
//    random cases (SKILL_ENGINE_CHECK_N, default 700) — the JS hook vs resolveSkillProgram(def, …), JSON-identical,
//    on the random worlds of tools/skills-check.mjs (same generator); programs never mutate the ctx.
// 3. bad programs rejected at load; op budget / depth limit → the hook's neutral value; denied ops.
// 4. foreign skills (S4 API): registerForeignSkill / isForeignSkillId, folding after the built-ins.
// 5. tools/skills-check.mjs under SKILL_ENGINE=shadow (strict) and SKILL_ENGINE=data.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as SK from '../skills.mjs';
import * as SE from '../skill-engine.mjs';
import { BUILTIN_FLAGS, FLAG_KEYS } from './skills-rebalancing-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(here, '..');
let fails = 0, oks = 0;
const ok = (label, cond, extra = '') => { if (cond) { oks++; console.log(`ok   ${label}`); } else { fails++; console.log(`FAIL ${label}${extra ? ` — ${String(extra).slice(0, 600)}` : ''}`); } };
const J = (x) => JSON.stringify(x);
const { SKILL_RULES, SKILLS_IMPLEMENTED, TRANCE, skillHook, resolveSkillProgram } = SK;
if (SK.SKILL_ENGINE !== 'js') console.log(`note: SKILL_ENGINE=${SK.SKILL_ENGINE} — the "JS" side below is the ${SK.SKILL_ENGINE} dispatcher`);

// ---- data -------------------------------------------------------------------------------------------------
const skillsJson = JSON.parse(fs.readFileSync(path.join(GAME, '..', 'data', 'skills.json'), 'utf8'));
const pickActive = (e) => (e.versions || []).filter(v => v.status !== 'rejected' && v.status !== 'superseded').sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0] || null;
const DATA = {};
for (const e of skillsJson.entries) { const v = pickActive(e); if (v) DATA[e.id] = { name: e.name, version: v.version, data: v.data }; }
const skillData = (id) => DATA[id]?.data;

// ---- 1. files ---------------------------------------------------------------------------------------------
console.log('-- 1. definition files');
const bundle = SE.loadSkillDefs(undefined, { builtinIds: new Set(SKILLS_IMPLEMENTED) });
ok('14 definitions load (validateSkillDef) + lib skills_std', bundle.defs.size === 14 && bundle.libs.some(l => l.id === 'skills_std'), [...bundle.defs.keys()].join());
ok('definition ids = SKILLS_IMPLEMENTED', J([...bundle.defs.keys()].sort()) === J([...SKILLS_IMPLEMENTED].sort()));
const schema = JSON.parse(fs.readFileSync(path.join(GAME, 'skills-data', 'skill.schema.json'), 'utf8'));
const req = schema.$defs.skill.required, allowed = Object.keys(schema.$defs.skill.properties);
const libReq = schema.$defs.lib.required, libAllowed = Object.keys(schema.$defs.lib.properties);
for (const l of bundle.libs) ok(`lib ${l.id}: schema required / known keys`, libReq.every(k => k in l) && Object.keys(l).every(k => libAllowed.includes(k)), Object.keys(l).join());
const HOOK_SET = new Set(SK.HOOK_NAMES);
ok('skill-engine HOOK_SPECS = skills.mjs HOOK_NAMES (same order)', J(SE.HOOK_NAMES) === J(SK.HOOK_NAMES));
ok('the denied (outcome / dice) ops are not in the skill vocabulary', SE.DENIED_OPS.every(o => !SE.SKILL_OPS.includes(o)));
for (const [id, def] of bundle.defs) {
  const d = DATA[id], r = SKILL_RULES[id];
  const sub = Object.fromEntries(Object.keys(r).map(k => [k, def.flags[k]]));
  const vk = Object.fromEntries(Object.keys(def.flags).filter(k => FLAG_KEYS[k]).map(k => [k, def.flags[k]]));
  const wantHooks = r.hooks.filter(h => HOOK_SET.has(h));
  const marks = Object.entries(def.hooks).filter(([, h]) => SE.isJsMarker(h)).map(([n]) => n);
  ok(`${id}: schema keys, metadata = data/skills.json, flags = SKILL_RULES + BUILTIN_FLAGS, hooks = SKILL_RULES hooks, pass hooks JS`,
    req.every(k => k in def) && Object.keys(def).every(k => allowed.includes(k))
    && def.name === DATA[id].name && def.version === d.version && def.action_type === d.data.action_type && def.is_permanent === !!d.data.is_permanent
    && def.point_buy_stat === (d.data.point_buy_stat ?? null) && def.text === d.data.text
    && J(sub) === J(r) && J(vk) === J(BUILTIN_FLAGS[id]) && Object.keys(def.flags).every(k => k in r || FLAG_KEYS[k])
    && J(Object.keys(def.hooks)) === J(wantHooks)
    && marks.every(n => SE.HOOK_SPECS[n].engine === 'js' || (id === 'skill_force_shield' && n === 'end_round'))
    && Object.keys(def.hooks).every(n => SE.HOOK_SPECS[n].engine === 'data' || marks.includes(n))
    && J(SK.validateSkillDef(def)) === '[]',
    J({ sub, r, vk, b: BUILTIN_FLAGS[id], hooks: Object.keys(def.hooks), wantHooks, errs: SK.validateSkillDef(def) }));
}

// ---- random worlds (the generator + bind of tools/skills-check.mjs, verbatim) --------------------------------
const ELEM_TO_STAT = { elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' };
const ELEMS = Object.keys(ELEM_TO_STAT);
const CODES = ['A', 'B', 'M', 'P', 'EM', 'EP'];
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function rngOf(seed) { const f = mulberry32(seed * 2654435761 >>> 0); return { f, int: (n) => Math.floor(f() * n), pick: (a) => a[Math.floor(f() * a.length)], p: (x) => f() < x }; }
const hexDistance = (a, b) => (Math.abs(a.tile_q - b.tile_q) + Math.abs(a.tile_r - b.tile_r) + Math.abs((a.tile_q + a.tile_r) - (b.tile_q + b.tile_r))) / 2;
const statRaw = (v, sk) => Math.max(0, v?.[`stat_${sk}`] ?? 0);
const roundHalfUp10 = (sum) => Math.round(sum / 10);
function genWorld(seed) {
  const R = rngOf(seed);
  const n = 2 + R.int(5);
  const ids = Array.from({ length: n }, (_, i) => `peer:${'abcdefgh'[i]}${R.int(90) + 10}`);
  const view = {};
  for (const id of ids) {
    if (R.p(0.05)) continue;
    const v = { peer_id: id, life: R.p(0.1) ? 0 : 1 + R.int(4), tile_q: R.int(3) - 1, tile_r: R.int(3) - 1, alliance: R.pick(['player', 'npc_a', 'npc_b', 'player_c']) };
    for (const s of ['vitality', 'world', 'matter', 'will']) if (!R.p(0.05)) v[`stat_${s}`] = R.int(21);
    view[id] = v;
  }
  const perms = {}, power = {}, invis = [];
  for (const id of ids) {
    perms[id] = ['skill_taunt', 'skill_ranged_weapon', 'skill_barricade', 'skill_sanctuary', 'skill_force_shield', 'class_x'].filter(() => R.p(0.2));
    power[id] = {}; for (const p of perms[id]) if (R.p(0.85)) power[id][p] = 1 + R.int(6);
    if (R.p(0.12)) invis.push(id);
  }
  const reveals = [];
  for (const id of ids) {
    if (R.p(0.1)) continue;
    const action = R.p(0.15) ? 'BT' : R.pick(CODES);
    const r = { actor: id, action, target: null, skills: [], trance: null, effect: null, salt: `s${seed}` };
    if (action === 'BT' && R.p(0.85)) r.trance = [R.pick(CODES), R.pick(CODES)];
    const k = R.int(4);
    for (let i = 0; i < k; i++) { const s = R.pick(SKILLS_IMPLEMENTED); if (!r.skills.includes(s)) r.skills.push(s); }
    if (r.skills.length && R.p(0.15)) r.buildingSkill = R.pick(r.skills);
    const t = R.f();
    if (t < 0.55) r.target = { kind: 'character', ref: R.pick(ids) }; else if (t < 0.7) r.target = { kind: 'tile', ref: { q: R.int(3) - 1, r: R.int(3) - 1 } };
    if (R.p(0.45)) r.effect = { effect_id: 'effect_t', elements: Array.from({ length: 1 + R.int(3) }, () => R.pick(ELEMS)), dmg: R.p(0.8) };
    reveals.push(r);
  }
  reveals.sort((a, b) => a.actor.localeCompare(b.actor));
  return { ids, view, perms, power, invis, reveals, self: R.pick(ids) };
}
function bind(w) {
  const view = new Map(Object.entries(w.view));
  const revealsThisTurn = w.reveals;
  const logs = [];
  const log = (...a) => logs.push(a.join(' '));
  const byActorPre = new Map(revealsThisTurn.map(r => [r.actor, r]));
  const hasPerm = (id, p) => (w.perms[id] || []).includes(p);
  const permPowerOf = (id) => w.power[id] || {};
  const distBetween = (a, b) => { const pa = view.get(a), pb = view.get(b); return pa && pb ? hexDistance(pa, pb) : Infinity; };
  const sideOfId = (id) => view.get(id)?.alliance ?? null;
  const enemyOf = (a, b) => { const sa = sideOfId(a), sb = sideOfId(b); return sa !== null && sb !== null && sa !== sb; };
  const invisibleNow = (id) => w.invis.includes(id);
  const hiddenFrom = (viewer, id) => viewer !== id && invisibleNow(id) && enemyOf(viewer, id) && !invisibleNow(viewer);
  const lifeOf = (id) => view.get(id)?.life ?? 0;
  const effAction = new Map(revealsThisTurn.map(r => [r.actor, r.action]));
  const noEmit = new Set(), swaps = [];   // 2026-11-16: Disruption / Overrun registers (peer.mjs SKR hunks)
  const tranceOpts = new Map(revealsThisTurn.filter(r => r.action === 'BT' && r.trance).map(r => [r.actor, [...r.trance]]));
  for (const r of revealsThisTurn) if (r.action === 'BT' && !r.trance) effAction.set(r.actor, 'EP');
  const codeIs = (id, c) => tranceOpts.has(id) ? tranceOpts.get(id).includes(c) : effAction.get(id) === c;
  const replace = (id, from, to) => {
    const o = tranceOpts.get(id);
    if (o) { for (let i = 0; i < o.length; i++) if (o[i] === from) o[i] = to; }
    else if (effAction.get(id) === from) effAction.set(id, to);
  };
  const noMove = new Set();
  const counterPen = new Map();
  const castsDamage = (o) => !!o.effect && Array.isArray(o.effect.elements) && o.effect.elements.length > 0 && !!o.effect.dmg;
  const effectDmgNoShield = (o, defId) => {
    if (!castsDamage(o)) return 0;
    const cv = view.get(o.actor), dv = view.get(defId);
    if (!cv || !dv) return 0;
    let s = 0;
    for (const el of o.effect.elements) s += Math.max(0, Math.max(0, statRaw(cv, ELEM_TO_STAT[el]) - (counterPen.get(o.actor)?.[el] || 0)) - statRaw(dv, ELEM_TO_STAT[el]));
    return roundHalfUp10(s);
  };
  const edgeMap = { A: { M: 0, B: -1, A: 0 }, P: { M: 1, A: 0, B: 0 }, M: { B: 1, EP: 0 }, B: { A: 1 } };
  const edgeDmg = (atk, def) => { if (atk === 'A' && (def === 'EP' || def === 'EM' || def === 'P')) return 1; return Math.max(0, (atk === 'A' ? 1 : 0) + (edgeMap[atk]?.[def] ?? 0)); };
  const skillFx = [];
  const skCtx = {
    self: w.self, label: 'T', log, reveals: revealsThisTurn, byActorPre,
    effAction, tranceOpts, noMove, counterPen, skillFx, codeIs, replace, noEmit, swaps,
    enemyOf, hiddenFrom, dist: distBetween, lifeOf,
    view: (id) => view.get(id), viewValues: () => view.values(),
    elemStat: (el) => ELEM_TO_STAT[el], hasPerm, permPower: permPowerOf,
    castsDamage, effectDmgNoShield, skillData, edgeDmg,
  };
  return { skCtx, effAction, tranceOpts, noMove, counterPen, skillFx, revealsThisTurn, logs, noEmit, swaps };
}
const snap = (B) => J({ e: [...B.effAction], t: [...B.tranceOpts], n: [...B.noMove], c: [...B.counterPen], fx: B.skillFx, l: B.logs, r: B.revealsThisTurn, ne: [...B.noEmit], sw: B.swaps });

// ---- 2. identity -------------------------------------------------------------------------------------------
console.log('-- 2. identity: JS hook vs the definition\'s program (seeded random cases)');
const N = Math.max(600, Number(process.env.SKILL_ENGINE_CHECK_N || 700));
const tally = new Map();   // `${hook} ${skill}` → {n, bad, acted}
const count = (hook, id, same, acted, show) => {
  const k = `${hook} ${id}`; const t = tally.get(k) || { n: 0, bad: 0, acted: 0 }; t.n++; if (!same) { t.bad++; if (t.bad <= 2) console.log(`FAIL ${k}: ${show}`); } if (acted) t.acted++; tally.set(k, t);
};
const owners = (hook) => [...bundle.defs.values()].filter(d => SE.HOOK_SPECS[hook].std || (d.hooks[hook] !== undefined && !SE.isJsMarker(d.hooks[hook])));
const cmp = (hook, def, js, data, neutral) => count(hook, def.id, J(js) === J(data), J(js) !== J(neutral), `js ${J(js)} data ${J(data)}`);
let mutated = 0;
for (let s = 1; s <= N; s++) {
  const w = genWorld(s);
  const B = bind(structuredClone(w));
  skillHook('counter_pre', 'skill_counter_spell', B.skCtx); skillHook('negate_action', null, B.skCtx); skillHook('negate_kind', null, B.skCtx);
  const R = rngOf(s + 424242);
  const ids = w.ids, ctx = B.skCtx;
  const before = snap(B);
  for (let k = 0; k < 2; k++) {
    const atk = R.pick(ids), dfd = R.pick(ids), code = R.pick(['A', 'B', 'P', 'M']), dmg = R.int(4);
    const byActor = new Map(B.revealsThisTurn.map(r => [r.actor, { ...r, declared: R.p(0.5) ? 'EP' : R.pick([...CODES, 'BT']), ...(R.p(0.15) ? { destroy: { stat: 'vitality' } } : {}), ...(R.p(0.3) ? { skills: [] } : {}) }]));
    if (R.p(0.2)) byActor.delete(dfd);
    // block_in: the blocker is the attacker id here (old call sites pass no blocker: covered too)
    const bArgs = R.p(0.15) ? { defender: dfd } : { defender: dfd, blocker: atk };
    for (const def of owners('block_in')) cmp('block_in', def, skillHook('block_in', def.id, ctx, bArgs), resolveSkillProgram(def, 'block_in', ctx, bArgs), false);
    for (const def of owners('block_cost')) cmp('block_cost', def, skillHook('block_cost', def.id, ctx, { attacker: atk, defender: dfd }), resolveSkillProgram(def, 'block_cost', ctx, { attacker: atk, defender: dfd }), 0);
    const aCode = R.p(0.6) ? 'A' : R.pick(CODES);
    for (const def of owners('attack_range')) cmp('attack_range', def, skillHook('attack_range', def.id, ctx, { attacker: atk, code: aCode }), resolveSkillProgram(def, 'attack_range', ctx, { attacker: atk, code: aCode }), 1);
    for (const def of owners('attack_out')) cmp('attack_out', def, skillHook('attack_out', def.id, ctx, { attacker: atk, dmg }), resolveSkillProgram(def, 'attack_out', ctx, { attacker: atk, dmg }), dmg);
    for (const def of owners('attack_target')) cmp('attack_target', def, skillHook('attack_target', def.id, ctx, { attacker: atk, defender: dfd }), resolveSkillProgram(def, 'attack_target', ctx, { attacker: atk, defender: dfd }), false);
    for (const def of owners('attack_vs_block')) cmp('attack_vs_block', def, skillHook('attack_vs_block', def.id, ctx, { attacker: atk, defender: dfd }), resolveSkillProgram(def, 'attack_vs_block', ctx, { attacker: atk, defender: dfd }), false);
    for (const def of owners('defend_in')) { const a = { code, defender: dfd, dmg, byActor }; cmp('defend_in', def, skillHook('defend_in', def.id, ctx, a), resolveSkillProgram(def, 'defend_in', ctx, a), dmg); }
    for (const def of owners('effect_in')) cmp('effect_in', def, skillHook('effect_in', def.id, ctx, { defender: dfd }), resolveSkillProgram(def, 'effect_in', ctx, { defender: dfd }), 0);
    for (const def of owners('effect_leg')) { const a = { shield: R.p(0.2) ? 0 : 1 + R.int(6), sum: R.int(40) }; cmp('effect_leg', def, skillHook('effect_leg', def.id, null, a), resolveSkillProgram(def, 'effect_leg', null, a), { ...a, spent: 0 }); }
  }
  // damage_in (edits): JS and data each on their own copy of the damage map + skillFx
  {
    const R2 = rngOf(s + 7);
    const mk = () => { const m = new Map(); for (const id of ids) if (R2.p(0.7)) m.set(id, Array.from({ length: R2.int(4) }, () => ({ source: R2.pick(['action', 'effect', 'trap']), amount: R2.int(3), attacker: R2.pick(ids) }))); return m; };
    const base = mk();
    for (const def of owners('damage_in')) {
      const dA = structuredClone(base), dB = structuredClone(base);
      const cA = { ...ctx, skillFx: [] }, cB = { ...ctx, skillFx: [] };
      skillHook('damage_in', def.id, cA, { damage: dA });
      resolveSkillProgram(def, 'damage_in', cB, { damage: dB });
      count('damage_in', def.id, J([[...dA], cA.skillFx]) === J([[...dB], cB.skillFx]), cA.skillFx.length > 0, `js ${J([[...dA], cA.skillFx])} data ${J([[...dB], cB.skillFx])}`);
    }
  }
  // end_round / std hooks
  {
    const myR = R.p(0.1) ? (R.p(0.5) ? undefined : null) : { declared: R.p(0.3) ? undefined : R.pick([...CODES, 'BT']), action: R.pick(CODES), trance: R.p(0.3) ? [R.pick(CODES), R.pick(CODES)] : R.p(0.5) ? null : undefined, skills: R.p(0.5) ? [] : R.p(0.1) ? undefined : [R.pick(SKILLS_IMPLEMENTED)], buildingSkill: R.p(0.3) ? R.pick(SKILLS_IMPLEMENTED) : undefined, effect: R.p(0.3) ? {} : null, ...(R.p(0.15) ? { destroy: { stat: 'will' } } : {}) };
    for (const def of owners('end_round')) cmp('end_round', def, skillHook('end_round', def.id, null, { reveal: myR }), resolveSkillProgram(def, 'end_round', null, { reveal: myR }), false);
    const codes = R.p(0.3) ? [R.pick(CODES), R.pick(CODES)] : [R.pick(CODES)], rq = R.pick(CODES);
    for (const def of owners('rides')) cmp('rides', def, skillHook('rides', def.id, null, { codes, req: rq }), resolveSkillProgram(def, 'rides', null, { codes, req: rq }), false);
    const pool = [...SKILLS_IMPLEMENTED, 'skill_unknown'];
    for (const def of owners('plan_target')) { const sk = Array.from({ length: R.int(4) }, () => R.pick(pool)); if (R.p(0.3)) sk.push(def.id); cmp('plan_target', def, skillHook('plan_target', null, null, { skillIds: sk }), resolveSkillProgram(def, 'plan_target', null, { skillIds: sk }), false); }
    for (const def of owners('perm_landing')) {
      const skillIds = Array.from({ length: R.int(4) }, () => R.pick(pool)); if (R.p(0.7)) skillIds.splice(R.int(skillIds.length + 1), 0, def.id);
      const playedCodes = R.p(0.4) ? null : new Set(Array.from({ length: R.int(3) }, () => R.pick(CODES)));
      const stats = {}; for (const k of ['vitality', 'world', 'matter', 'will']) if (!R.p(0.05)) stats[k] = R.int(6) * 3;
      const c = R.p(0.5) ? { skillData } : ctx;
      cmp('perm_landing', def, skillHook('perm_landing', null, c, { skillIds, playedCodes, stats }), resolveSkillProgram(def, 'perm_landing', c, { skillIds, playedCodes, stats }), []);
    }
    for (const def of owners('perm_stats')) { const c = R.p(0.5) ? { skillData } : ctx; cmp('perm_stats', def, skillHook('perm_stats', def.id, c), resolveSkillProgram(def, 'perm_stats', c), ['vitality']); }
    const fx = Array.from({ length: R.int(5) }, () => ({ by: R.pick(ids), skill: R.pick(SKILLS_IMPLEMENTED), on: R.pick(ids), ...(R.p(0.5) ? { ridden: [R.pick(SKILLS_IMPLEMENTED)] } : R.p(0.8) ? { countered: [R.pick(SKILLS_IMPLEMENTED)] } : {}), building: R.p(0.2) }));
    const self = R.pick(ids);
    for (const def of owners('disposition')) {
      if (R.p(0.3)) fx.push({ by: self, skill: def.id, on: R.pick(ids), what: 'x', building: R.p(0.3) });
      cmp('disposition', def, skillHook('disposition', def.id, { skillData }, { fx, self }), resolveSkillProgram(def, 'disposition', { skillData }, { fx, self }), 'judge');
    }
    const paid = R.p(0.1) ? undefined : R.p(0.5);
    for (const def of owners('plan_lock')) cmp('plan_lock', def, skillHook('plan_lock', def.id, { skillData }, { paid }), resolveSkillProgram(def, 'plan_lock', { skillData }, { paid }), null);
  }
  if (snap(B) !== before) mutated++;
}
ok('programs never mutate the resolver registers / reveals (non-edit hooks)', mutated === 0, `${mutated} worlds changed`);
const rows = [...tally.entries()].sort();
let cases = 0;
for (const [k, t] of rows) { cases += t.n; const good = t.bad === 0 && t.n >= 600; ok(`${k.padEnd(38)} ${t.n} cases, ${t.acted} where it acted, ${t.bad} differ`, good); }
const covered = new Set(rows.map(([k]) => k.split(' ')[0]));
ok(`every data hook covered (${SE.DATA_HOOKS.length}): ${SE.DATA_HOOKS.join(', ')}`, SE.DATA_HOOKS.every(h => covered.has(h)), SE.DATA_HOOKS.filter(h => !covered.has(h)).join());
ok('every data hook acted in some case', SE.DATA_HOOKS.every(h => rows.some(([k, t]) => k.startsWith(h + ' ') && t.acted > 0)));
console.log(`     ${cases} cases over ${rows.length} (hook, skill) pairs`);
// pass hooks through resolveSkillProgram = the JS hook of the built-in
{
  const w = genWorld(77), A = bind(structuredClone(w)), Bw = bind(structuredClone(w));
  skillHook('counter_pre', 'skill_counter_spell', A.skCtx);
  resolveSkillProgram(bundle.defs.get('skill_counter_spell'), 'counter_pre', Bw.skCtx);
  ok('resolveSkillProgram on a JS-marked pass hook runs the built-in JS hook', snap(A) === snap(Bw));
}

// ---- 3. bad programs, limits -----------------------------------------------------------------------------
console.log('-- 3. rejection + limits');
const base = (hooks, extra = {}) => ({ schema: 'chaosd6.skill/1', id: 'skill_test_x', name: 'X', version: '1.0.0', action_type: 'A', is_permanent: false, point_buy_stat: null, flags: { action: 'A' }, uses: ['skills_std'], hooks, ...extra });
const rejects = (label, def, re) => { const e = SK.validateSkillDef(def); ok(`rejected: ${label}`, e.length > 0 && (!re || e.some(x => re.test(x))), J(e)); };
rejects('unknown operation', base({ attack_out: { eval: ['x'] } }), /unknown operation eval/);
rejects('bare object literal', base({ attack_out: { a: 1, b: 2 } }), /not an operation/);
rejects('denied outcome op (emit)', base({ attack_out: { emit: ['hits', 1] } }), /unknown operation emit/);
rejects('denied dice op (rng)', base({ attack_out: { rng: ['t', 6] } }), /unknown operation rng/);
rejects('call to an unknown sub', base({ attack_out: { call: ['nope'] } }), /unknown subroutine nope/);
rejects('unknown hook', base({ on_fire: { var: 'dmg' } }), /unknown hook/);
rejects('a data program on a JS pass hook', base({ negate_kind: { var: 'x' } }), /no data engine yet/);
rejects('{"engine":"js"} on a foreign skill', base({ attack_out: { engine: 'js', impl: 'skills.mjs#attackOut' } }), /built-in skills only/);
rejects('bad schema / id / action', base({}, { schema: 'x', id: 'Skill X', action_type: 'Q' }), /schema/);
rejects('permanent without point_buy_stat', base({}, { is_permanent: true }), /point_buy_stat/);
rejects('unknown lib', base({}, { uses: ['nope'] }), /unknown lib/);
ok('a valid foreign definition passes', J(SK.validateSkillDef(base({ attack_out: { '+': [{ var: 'dmg' }, 1] } }))) === '[]');
ok('resolveSkillProgram throws on an invalid definition', (() => { try { resolveSkillProgram(base({ attack_out: { eval: 1 } }), 'attack_out', null, { dmg: 1 }); return false; } catch { return true; } })());
const e0 = SK.skillShadowStats.errors;
const wide = base({ attack_out: { len: { map: [{ range: [0, 250] }, { map: [{ range: [0, 250] }, { '+': [{ var: 'i' }, 1] }] }] } } });   // 62 500 bodies
ok('op budget exceeded → neutral value (dmg unchanged), error counted', resolveSkillProgram(wide, 'attack_out', null, { attacker: 'a', dmg: 3 }) === 3 && SK.skillShadowStats.errors === e0 + 1);
let deep = { var: 'dmg' }; for (let i = 0; i < 80; i++) deep = { '+': [deep, 0] };
ok('depth limit exceeded → neutral value', resolveSkillProgram(base({ attack_out: deep }), 'attack_out', null, { attacker: 'a', dmg: 2 }) === 2 && SK.skillShadowStats.errors === e0 + 2);
ok('bad result shape (string for a number hook) → neutral value', resolveSkillProgram(base({ attack_out: 'lots' }), 'attack_out', null, { attacker: 'a', dmg: 2 }) === 2);
ok('engine limits: skill budget 20000 ops / depth 64 / range 256', J(SE.SKILL_LIMITS) === J({ maxOps: 20000, maxDepth: 64, maxRange: 256 }));
const loopSubs = new Map([['loop', { params: [], body: { call: ['loop'] } }]]);
ok('unbounded recursion throws EffectEngineLimit in the engine', (() => { try { SE.runHookProgram({ logic: { call: ['loop'] }, subs: loopSubs }, 'attack_out', 'x', { c: null }, {}); return false; } catch (e) { return e instanceof SE.EffectEngineLimit; } })());
ok('a denied op slipped past validation is refused at run time', (() => { try { SE.runHookProgram({ logic: { emit: ['hits', 1] }, subs: new Map() }, 'attack_out', 'x', { c: null }, {}); return false; } catch (e) { return e instanceof SE.EffectProgramError; } })());
ok('prototype paths read as undefined', SE.runHookProgram({ logic: { var: 'reveal.__proto__.x' }, subs: new Map() }, 'end_round', 'x', { c: null }, { reveal: {} }) === undefined);

// ---- 4. foreign skills (S4 API) -----------------------------------------------------------------------------
console.log('-- 4. foreign skills');
{
  const w = genWorld(5), B = bind(structuredClone(w));
  const atk = B.revealsThisTurn[0]?.actor || w.ids[0];
  const before = skillHook('attack_out', 'skill_powerful_attack', B.skCtx, { attacker: atk, dmg: 2 });
  ok('built-in id cannot be registered as foreign', (() => { try { SK.registerForeignSkill('k0', 'skill_dodge', { action: 'M' }, {}); return false; } catch { return true; } })());
  ok('a JS marker in a foreign skill is refused', (() => { try { SK.registerForeignSkill('k0', 'skill_test_js', { action: 'A' }, { attack_out: { engine: 'js', impl: 'skills.mjs#x' } }); return false; } catch { return true; } })());
  SK.registerForeignSkill('key:fury@1', 'skill_test_fury', { action: 'A', permanent: false, negating: true, hooks: ['attack_out'] }, { attack_out: { '*': [{ var: 'dmg' }, 2] } });
  SK.registerForeignSkill('key:wall@1', 'skill_test_wall', { action: 'B', permanent: true, pointBuyStat: 'will', hooks: ['defend_in'] }, { defend_in: { if: [{ bool: { has_perm: [{ var: 'defender' }, { var: 'skill' }] } }, 0, { var: 'dmg' }] } });
  ok('isForeignSkillId / foreignSkillDef', SK.isForeignSkillId('skill_test_fury') && !SK.isForeignSkillId('skill_dodge') && SK.foreignSkillDef('key:fury@1')?.id === 'skill_test_fury');
  ok('foreign flags join SKILL_RULES / NEGATING_SKILLS, not the deal order', SKILL_RULES.skill_test_fury?.action === 'A' && SK.NEGATING_SKILLS.has('skill_test_fury') && !SKILLS_IMPLEMENTED.includes('skill_test_fury'));
  ok('attack_out: a foreign program folds after the built-in (×2)', skillHook('attack_out', 'skill_powerful_attack', B.skCtx, { attacker: atk, dmg: 2 }) === before * 2, `${before}`);
  ok('perm_stats of a foreign permanent = std default on its metadata (will)', J(skillHook('perm_stats', 'skill_test_wall', { skillData })) === '["will"]');
  ok('disposition of a foreign negating instant (did nothing) = unused', skillHook('disposition', 'skill_test_fury', { skillData }, { fx: [], self: 'peer:x' }) === 'unused');
  const holder = w.ids[1] || w.ids[0];
  const ctx2 = { ...B.skCtx, hasPerm: (id, p) => p === 'skill_test_wall' && id === holder };
  ok('defend_in: a foreign permanent stops damage', skillHook('defend_in', null, ctx2, { code: 'P', defender: holder, dmg: 3, byActor: new Map() }) === 0);
  SK.clearForeignSkills();
  ok('clearForeignSkills restores the built-in result', skillHook('attack_out', 'skill_powerful_attack', B.skCtx, { attacker: atk, dmg: 2 }) === before && !SKILL_RULES.skill_test_fury);
}

// ---- 5. skills-check under the data engines -----------------------------------------------------------------
console.log('-- 5. tools/skills-check.mjs under SKILL_ENGINE=shadow (strict) / data');
for (const [mode, extra] of [['shadow', { SKILL_SHADOW_STRICT: '1', SKILL_SHADOW_REPORT: '1' }], ['data', {}]]) {
  const r = spawnSync(process.execPath, [path.join(here, 'skills-check.mjs')], { cwd: GAME, env: { ...process.env, SKILL_ENGINE: mode, SKILLS_CHECK_N: process.env.SKILLS_CHECK_N || '600', ...extra }, encoding: 'utf8', maxBuffer: 64 << 20 });
  const tallyLine = (r.stdout.match(/\[skills\] shadow:.*$/m) || [''])[0];
  ok(`skills-check SKILL_ENGINE=${mode}${mode === 'shadow' ? ' (strict), 0 mismatches' : ''} passes`, r.status === 0 && /all skill checks passed/.test(r.stdout) && (mode !== 'shadow' || /mismatches 0,/.test(tallyLine)) && !/data hook:/.test(r.stderr), (tallyLine || '') + (r.stderr || r.stdout).slice(-500));
  if (tallyLine) console.log(`     ${tallyLine}`);
}

console.log(fails ? `${fails} skill-engine check(s) FAILED (${oks} ok)` : `all skill-engine checks passed (${oks} ok)`);
process.exit(fails ? 1 : 0);
