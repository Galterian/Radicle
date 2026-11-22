// Data-driven skill hooks (milestone S2 of the chaosD6-Skills program).
//
// A skill is a JSON definition (game/skills-data/skills/<id>.json, schema chaosd6.skill/2 for the built-ins —
// deal_order, card, ui — or chaosd6.skill/1 for a foreign skill; game/skills-data/SCHEMA.md + skill.schema.json)
// whose `hooks` map a hook name of skills.mjs#skillHook to a program in the effects' JsonLogic dialect
// (effect-engine.mjs — same evaluator, op budget, depth limit; see effects-data/SCHEMA.md). A hook program gets the
// hook's arguments as root registers and its VALUE is the hook result. Hooks whose rules edit the resolver's registers
// in place (counter_pre, negate_action, negate_kind, trance_assign — the "pass" hooks) return ordered EDIT RECORDS
// instead (PASS_OPS, MV 2026-11-17); skills.mjs applies them between program runs, in the order of the built-ins'
// flags.passOrder. A built-in may still mark a hook `{"engine": "js", "impl": "skills.mjs#…"}` (the JS oracle's hook
// answers when it is installed) or `"peer.mjs#…"` (neutral: peer.mjs does it). No skill id appears here as code.
//
// This module is pure: no peer globals. skills.mjs (the dispatcher, SKILL_ENGINE=js|data|shadow) wraps the
// resolver ctx as W = { c: ctx, sd(id), flag(id, key) } before calling runHookProgram.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProgram, validateLogic, SPECIAL_OPS, PURE_OP_NAMES, EffectEngineLimit, EffectProgramError } from './effect-engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DATA_DIR = path.join(here, 'skills-data');
export const SKILL_SCHEMA_ID = 'chaosd6.skill/1';     // a foreign skill (registerForeignSkill) — not dealt
export const SKILL_SCHEMA_ID_2 = 'chaosd6.skill/2';   // built-ins since the skill isolation: + deal_order, card, ui
export const SKILL_SCHEMA_IDS = Object.freeze([SKILL_SCHEMA_ID, SKILL_SCHEMA_ID_2]);
export const SKILL_LIB_SCHEMA_ID = 'chaosd6.skill-lib/1';
export const STD_LIB_ID = 'skills_std';
// A hook runs once per strike / leg / skill: a far smaller budget than an effect's.
export const SKILL_LIMITS = Object.freeze({ maxOps: 20000, maxDepth: 64, maxRange: 256 });
export { EffectEngineLimit, EffectProgramError };

// ------------------------------------------------------------ vocabulary
// Outcome / dice forms of the effects make no sense in a hook (a hook returns a value, rolls nothing).
export const DENIED_OPS = Object.freeze(['emit', 'put', 'out', 'note', 'return', 'return_empty', 'seed', 'hash_int', 'rng', 'point_buy', 'point_buy_seed']);
const DENY = new Set(DENIED_OPS);
// ctx queries over the resolver ctx (skills.mjs header / HOOKS.md). Read-only; Maps / Sets come back as arrays.
// W.c may be null for hooks peer.mjs calls without a ctx (rides, plan_target, effect_leg, end_round): a query
// there throws exactly as the JS hook would.
export const SKILL_CTX_OPS = {
  has_skill: (W, [id, s]) => (W.c.byActorPre.get(id)?.skills || []).includes(s),     // the reveal of `id` carries skill s
  from_building: (W, [by, s]) => W.c.byActorPre.get(by)?.buildingSkill === s,
  reveal_of: (W, [id]) => W.c.byActorPre.get(id) ?? null,
  reveals: (W) => [...W.c.reveals],
  code_is: (W, [id, code]) => !!W.c.codeIs(id, code),
  has_perm: (W, [id, p]) => W.c.hasPerm(id, p),
  perm_power: (W, [id]) => W.c.permPower(id),
  enemy_of: (W, [a, b]) => !!W.c.enemyOf(a, b),
  hidden_from: (W, [viewer, id]) => !!W.c.hiddenFrom(viewer, id),
  dist: (W, [a, b]) => W.c.dist(a, b),
  life_of: (W, [id]) => W.c.lifeOf(id),
  view: (W, [id]) => W.c.view(id) ?? null,
  views: (W) => [...W.c.viewValues()],
  elem_stat: (W, [el]) => W.c.elemStat(el),
  edge_dmg: (W, [a, d]) => W.c.edgeDmg(a, d),
  casts_damage: (W, [o]) => !!W.c.castsDamage(o),
  effect_dmg: (W, [o, def]) => W.c.effectDmgNoShield(o, def),
  skill_data: (W, [id]) => W.sd(id) ?? null,              // the skill's data/skills.json `data` (or the def's metadata)
  skill_flag: (W, [id, k]) => W.flag(id, k),              // a key of the skill's `flags`
  ctx_self: (W) => W.c?.self ?? null,
  ctx_has: (W, [name]) => !!W.c && typeof W.c[name] === 'function',
  // MV (pass hooks as data, 2026-11-17): the registers the pass programs read (copies), the Counter Spell probe, and the
  // Battle Trance args (W.a = the hook's args: byActor, codeVs, attacksOn).
  ctx_label: (W) => W.c?.label ?? null,
  eff_has: (W, [id]) => W.c.effAction.has(id),
  eff_action: (W, [id]) => W.c.effAction.get(id),
  trance_has: (W, [id]) => W.c.tranceOpts.has(id),
  trance_opts: (W, [id]) => (W.c.tranceOpts.has(id) ? [...W.c.tranceOpts.get(id)] : null),
  has_register: (W, [name]) => !!W.c && !!W.c[name] && typeof W.c[name] !== 'function',   // JS truthiness (an empty swaps list counts)
  swaps: (W) => (W.c.swaps || []).map(s => ({ ...s })),
  // effect_dmg with `amount` more Counter Spell penalty on `el` for o's caster — set, read, restored (exactly the JS
  // bestElem probe; counterPen is unchanged afterwards).
  effect_dmg_pen: (W, [o, def, el, amount]) => {
    const pen = W.c.counterPen, prev = pen.get(o.actor);
    pen.set(o.actor, { ...(prev || {}), [el]: (prev?.[el] || 0) + amount });
    try { return W.c.effectDmgNoShield(o, def); } finally { if (prev) pen.set(o.actor, prev); else pen.delete(o.actor); }
  },
  by_actor: (W, [id]) => W.a?.byActor?.get(id) ?? null,
  by_actor_has: (W, [id]) => !!W.a?.byActor?.has(id),
  code_vs: (W, [id, other]) => W.a.codeVs(id, other),
  attacks_on: (W, [er, victim]) => W.a.attacksOn(er ?? undefined, victim),
};
export const SKILL_OPS = Object.freeze([...SPECIAL_OPS.filter(o => !DENY.has(o)), ...PURE_OP_NAMES, ...Object.keys(SKILL_CTX_OPS)].sort());
const KNOWN = new Set(SKILL_OPS);

// ------------------------------------------------------------ hooks
// kind — how skills.mjs combines the participants of one call (built-in(s) first, then foreign skills by id):
//   single  one program (the named skill's, else the std default)       each   per id of args.skillIds (perm_landing)
//   chain   the value threads through args[chain]                       or     first truthy result
//   max     largest result                                              first  first truthy result (die)
//   edit    returns {edits, fx}; the dispatcher applies them in order    pass   per (reveal, skill): [edit records] (PASS_OPS)
// args — the root registers (Map → [[key, value]…] pairs, Set → array). Every program also sees `skill` (its id).
// order (pass hooks) — the built-ins taking part, in order: derived from their flags.passOrder ({hook: n}, sorted by n,
// then id) — set by skills.mjs from its bundle (setBuiltinPassOrders), else from the default definitions dir on first use.
const PASS_ORDERS = { map: null };
const passSpec = (hook, reveals) => Object.defineProperty({ engine: 'data', kind: 'pass', reveals, args: ['r', 'actor', 'phase', 'carry'], result: 'records' },
  'order', { enumerable: true, get: () => [...passOrdersNow()[hook]] });
export const HOOK_SPECS = Object.freeze({
  rides:         { engine: 'data', kind: 'single', std: true, args: ['codes', 'req'], result: 'any' },
  plan_target:   { engine: 'data', kind: 'single', std: true, args: ['skillIds'], result: 'any' },
  // MV 2026-11-17: the pass hooks run as data — one program run per (reveal, skill) in `order` × reveal order
  // (`reveals`: 'sorted' by actor or the 'live' array), returning ordered edit records the dispatcher applies before
  // the next run (PASS_OPS below; {op:'continue', carry} re-runs the same program with phase + 1 after its edits).
  counter_pre:   passSpec('counter_pre', 'sorted'),
  negate_action: passSpec('negate_action', 'live'),
  negate_kind:   passSpec('negate_kind', 'live'),
  trance_assign: passSpec('trance_assign', 'live'),
  block_in:      { engine: 'data', kind: 'or', args: ['defender', 'blocker'], result: 'any' },
  block_cost:    { engine: 'data', kind: 'max', args: ['attacker', 'defender'], result: 'number' },
  attack_range:  { engine: 'data', kind: 'max', args: ['attacker', 'code'], result: 'number' },
  attack_out:    { engine: 'data', kind: 'chain', chain: 'dmg', args: ['attacker', 'dmg'], result: 'number' },
  attack_target: { engine: 'data', kind: 'or', args: ['attacker', 'defender'], result: 'any' },
  attack_vs_block: { engine: 'data', kind: 'or', args: ['attacker', 'defender'], result: 'any' },
  defend_in:     { engine: 'data', kind: 'chain', chain: 'dmg', args: ['code', 'defender', 'dmg', 'byActor'], result: 'number' },
  damage_in:     { engine: 'data', kind: 'edit', args: ['damage'], result: 'edit' },
  effect_in:     { engine: 'data', kind: 'first', args: ['defender'], result: 'number' },
  effect_leg:    { engine: 'data', kind: 'single', args: ['shield', 'sum'], result: 'leg' },
  end_round:     { engine: 'data', kind: 'single', args: ['reveal'], result: 'any' },
  perm_landing:  { engine: 'data', kind: 'each', std: true, args: ['skillIds', 'playedCodes', 'stats'], result: 'landing' },
  perm_stats:    { engine: 'data', kind: 'single', std: true, args: [], result: 'stats' },
  disposition:   { engine: 'data', kind: 'single', std: true, args: ['fx', 'self'], result: 'disposition' },
  plan_lock:     { engine: 'data', kind: 'single', args: ['paid'], result: 'codes' },
});
export const HOOK_NAMES = Object.freeze(Object.keys(HOOK_SPECS));
export const DATA_HOOKS = Object.freeze(HOOK_NAMES.filter(h => HOOK_SPECS[h].engine === 'data'));
export const JS_HOOKS = Object.freeze(HOOK_NAMES.filter(h => HOOK_SPECS[h].engine === 'js'));
export const PASS_HOOKS = Object.freeze(HOOK_NAMES.filter(h => HOOK_SPECS[h].kind === 'pass'));
// derivePassOrders(defs) → {passHook: [id…]} — the definitions with flags.passOrder[hook], sorted by n then id.
export function derivePassOrders(defs) {
  const out = Object.fromEntries(PASS_HOOKS.map(h => [h, []]));
  for (const d of defs || []) for (const [h, n] of Object.entries(d?.flags?.passOrder || {})) if (out[h] && Number.isInteger(n)) out[h].push([n, d.id]);
  for (const h of PASS_HOOKS) out[h] = out[h].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(x => x[1]);
  return out;
}
// setBuiltinPassOrders(defs) — the built-ins whose flags.passOrder give HOOK_SPECS[pass].order (skills.mjs: its dealt bundle).
export function setBuiltinPassOrders(defs) { PASS_ORDERS.map = derivePassOrders(defs); }
function passOrdersNow() {
  return (PASS_ORDERS.map ||= derivePassOrders([...loadSkillDefs(undefined, { lenient: true }).defs.values()].filter(d => Number.isInteger(d.deal_order))));
}
const STATS = ['vitality', 'world', 'matter', 'will'];
const DISPOSITIONS = ['permanent', 'negated', 'countered', 'spent', 'unused', 'judge'];
const CODES = ['A', 'B', 'M', 'P', 'EM', 'EP'];

// The value a hook has when no program applies (or a program fails): what the JS hook returns for a skill
// that is not in play.
export function neutralOf(hookName, args = {}) {
  switch (hookName) {
    case 'block_in': case 'attack_target': case 'attack_vs_block': case 'end_round': case 'rides': case 'plan_target': return false;
    case 'block_cost': case 'effect_in': return 0;
    case 'attack_range': return 1;
    case 'plan_lock': return null;
    case 'attack_out': case 'defend_in': return args.dmg;
    case 'effect_leg': return { shield: args.shield, sum: args.sum, spent: 0 };
    case 'perm_stats': return ['vitality'];
    case 'disposition': return 'judge';
    case 'perm_landing': return null;
    default: return undefined;
  }
}
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// Shape check of a program's value (a foreign program may return anything; built-ins always pass).
export function resultOk(hookName, v) {
  switch (HOOK_SPECS[hookName]?.result) {
    case 'number': return isNum(v);
    case 'leg': return isObj(v) && isNum(v.shield) && isNum(v.sum) && isNum(v.spent);
    case 'landing': return v === null || v === undefined || (isObj(v) && typeof v.id === 'string' && STATS.includes(v.stat) && (v.power === undefined || (Number.isInteger(v.power) && v.power >= 1 && v.power <= 6)));
    case 'stats': return Array.isArray(v) && v.length > 0 && v.every(s => STATS.includes(s));
    case 'disposition': return DISPOSITIONS.includes(v);
    case 'codes': return v === null || (Array.isArray(v) && v.length > 0 && v.every(c => CODES.includes(c)));
    case 'records': return Array.isArray(v) && v.every(passRecordOk);
    case 'edit': return isObj(v) && Array.isArray(v.edits) && Array.isArray(v.fx)
      && v.edits.every(e => isObj(e) && typeof e.victim === 'string' && Number.isInteger(e.i) && e.i >= 0 && isNum(e.amount))
      && v.fx.every(f => isObj(f) && typeof f.by === 'string' && typeof f.skill === 'string' && typeof f.what === 'string');
    default: return true;
  }
}

// MV 2026-11-17 — the edit records of the pass hooks (applied in order by skills.mjs#applyPassRecord):
//   set_code {id, code}         effAction.set            drop_trance {id}          tranceOpts.delete
//   replace {id, from, to}      ctx.replace (trance-aware) skills {id, skills}     the reveal's skills list := skills
//   fx {fx}                     skillFx.push(fx)         no_move {id} / no_emit {id}   noMove / noEmit .add
//   swap {by, on}               swaps.push               trance_collapse {id, code}  effAction := code, trance dropped
//   pen {id, elem, amount}      counterPen[id][elem] += amount                       log {text}   ctx.log(text)
//   trance {vs: [[enemy, i]…], played: [i…]}  the current reveal's r.vs (Map) / r.played (Set)
//   continue {carry}            stop here; run the same program again with phase + 1 and this carry
export const PASS_OPS = Object.freeze(['set_code', 'drop_trance', 'replace', 'skills', 'fx', 'no_move', 'no_emit', 'swap', 'trance_collapse', 'pen', 'log', 'trance', 'continue']);
const isId = (x) => typeof x === 'string';
function passRecordOk(r) {
  if (!isObj(r) || !PASS_OPS.includes(r.op)) return false;
  switch (r.op) {
    case 'set_code': case 'trance_collapse': return isId(r.id) && (r.code === undefined || CODES.includes(r.code));
    case 'drop_trance': case 'no_move': case 'no_emit': return isId(r.id);
    case 'replace': return isId(r.id) && CODES.includes(r.from) && CODES.includes(r.to);
    case 'skills': return isId(r.id) && Array.isArray(r.skills) && r.skills.every(isId);
    case 'fx': return isObj(r.fx) && isId(r.fx.by) && isId(r.fx.skill) && isId(r.fx.what);
    case 'swap': return isId(r.by) && isId(r.on);
    case 'pen': return isId(r.id) && isId(r.elem) && isNum(r.amount);
    case 'log': return typeof r.text === 'string';
    case 'trance': return Array.isArray(r.vs) && r.vs.every(p => Array.isArray(p) && p.length === 2 && isId(p[0]) && Number.isInteger(p[1])) && Array.isArray(r.played) && r.played.every(Number.isInteger);
    default: return true;   // continue
  }
}

// A hook entry is a program, or a JS marker {engine: 'js', impl, note?} (built-ins only).
export const isJsMarker = (h) => isObj(h) && Object.prototype.hasOwnProperty.call(h, 'engine');

// ------------------------------------------------------------ validation
export function validateSkillLib(lib) {
  const errors = [];
  if (lib?.schema !== SKILL_LIB_SCHEMA_ID) errors.push(`schema must be ${SKILL_LIB_SCHEMA_ID}`);
  if (typeof lib?.id !== 'string' || !/^[a-z0-9_]+$/.test(lib.id)) errors.push('id must match [a-z0-9_]+');
  if (typeof lib?.version !== 'string' || !/^\d+\.\d+\.\d+/.test(lib.version)) errors.push('version must be semver');
  const subs = new Map(Object.entries(isObj(lib?.subs) ? lib.subs : {}));
  if (!isObj(lib?.subs)) errors.push('subs must be an object');
  for (const [name, s] of subs) {
    if (!Array.isArray(s?.params) || !s.params.every(p => typeof p === 'string')) errors.push(`${name}: params must be an array of names`);
    errors.push(...validateLogic(s?.body, subs, KNOWN).map(e => `${name}: ${e}`));
  }
  if (lib?.defaults !== undefined) {
    if (!isObj(lib.defaults)) errors.push('defaults must be {hook: sub}');
    else for (const [h, s] of Object.entries(lib.defaults)) {
      if (!HOOK_SPECS[h]?.std) errors.push(`defaults.${h}: not a hook with a std default (${HOOK_NAMES.filter(x => HOOK_SPECS[x].std).join(', ')})`);
      if (!subs.has(s)) errors.push(`defaults.${h}: unknown sub ${s}`);
    }
  }
  return errors;
}
const PBS = ['stat_vitality', 'stat_world', 'stat_matter', 'stat_will', 'any'];
const strs = (v) => Array.isArray(v) && v.every(s => typeof s === 'string');
// The card block (chaosd6.skill/2) = the data/skills.json entry of the skill (name / tags / resources) and its active
// version (data / rebalance_links / logic) — same shape as an effect's card (effect-engine.mjs validateCard).
// card.data carries the card metadata; every key must equal the definition's top-level field.
export const CARD_KEYS = Object.freeze(['name', 'tags', 'resources', 'data', 'rebalance_links', 'logic']);
export const CARD_DATA_KEYS = Object.freeze(['action_type', 'is_permanent', 'point_buy_stat', 'text', 'element', 'fixed_power']);
const CARD_DATA_REQUIRED = ['action_type', 'is_permanent', 'point_buy_stat', 'text'];
export function validateCard(card, def) {
  if (card === undefined) return [];
  if (!isObj(card)) return ['card must be an object'];
  const errs = Object.keys(card).filter(k => !CARD_KEYS.includes(k)).map(k => `card.${k}: unknown key`);
  if (typeof card.name !== 'string' || !card.name || card.name.length > 80) errs.push('card.name required');
  if (card.tags !== undefined && !strs(card.tags)) errs.push('card.tags must be strings');
  if (card.resources !== undefined && !isObj(card.resources)) errs.push('card.resources must be an object');
  if (card.logic !== undefined && !isObj(card.logic)) errs.push('card.logic must be an object');
  if (card.rebalance_links !== undefined && !(strs(card.rebalance_links) && card.rebalance_links.every(t => /^[a-z]+_[a-z0-9_]+$/.test(t)))) errs.push('card.rebalance_links must be entry ids');
  if (!isObj(card.data)) return [...errs, 'card.data must be an object'];
  for (const k of Object.keys(card.data)) if (!CARD_DATA_KEYS.includes(k)) errs.push(`card.data.${k}: unknown key`);
  for (const k of CARD_DATA_REQUIRED) if (card.data[k] === undefined) errs.push(`card.data.${k} required`);
  for (const k of CARD_DATA_KEYS) if (card.data[k] !== undefined && JSON.stringify(card.data[k]) !== JSON.stringify(def?.[k])) errs.push(`card.data.${k} must equal ${k}`);
  for (const k of ['element', 'fixed_power']) if (card.data[k] === undefined && def?.[k] !== undefined) errs.push(`card.data.${k} must equal ${k}`);
  return errs;
}
// The ui block (chaosd6.skill/2): what the UI shows (js/main.js SKILL_TAG, renderer.js SKILL_ICON, skill_card.js
// SKILL_GLYPHS when it differs, the rest slot hint). skills.mjs#skillUiOf adds the resolver facts.
export const UI_KEYS = Object.freeze(['tag', 'glyph', 'color', 'card_glyph', 'card_color', 'rest_hint']);
export function validateUi(ui) {
  if (ui === undefined) return [];
  if (!isObj(ui)) return ['ui must be an object'];
  const errs = Object.keys(ui).filter(k => !UI_KEYS.includes(k)).map(k => `ui.${k}: unknown key`);
  for (const k of ['tag', 'glyph', 'color']) if (typeof ui[k] !== 'string' || !ui[k]) errs.push(`ui.${k} required (a string)`);
  for (const k of ['card_glyph', 'card_color', 'rest_hint']) if (ui[k] !== undefined && (typeof ui[k] !== 'string' || !ui[k] || ui[k].length > 400)) errs.push(`ui.${k} must be a string`);
  return errs;
}
// validateSkillDef(def, {libs | libMap, builtin}) → [errors]. `builtin` (a bundled chaosD6 skill) may mark hooks
// {engine: 'js'}; a foreign definition must give a program for every hook it declares. A /2 built-in needs deal_order,
// card and ui, and a flags.passOrder entry for every pass hook it has a program for.
export function validateSkillDef(def, opts = {}) {
  const errors = [];
  if (!isObj(def)) return ['definition is not an object'];
  if (!SKILL_SCHEMA_IDS.includes(def.schema)) errors.push(`schema must be ${SKILL_SCHEMA_IDS.join(' or ')}`);
  const v2 = def.schema === SKILL_SCHEMA_ID_2;
  for (const b of ['deal_order', 'card', 'ui']) {
    if (def[b] !== undefined && !v2) errors.push(`${b} needs schema ${SKILL_SCHEMA_ID_2}`);
    else if (def[b] === undefined && v2 && opts.builtin) errors.push(`${b} required (a ${SKILL_SCHEMA_ID_2} built-in)`);
  }
  if (def.deal_order !== undefined && !(Number.isInteger(def.deal_order) && def.deal_order >= 1)) errors.push('deal_order must be an integer ≥ 1');
  errors.push(...validateCard(def.card, def), ...validateUi(def.ui));
  if (def.fixed_power !== undefined && !(Number.isInteger(def.fixed_power) && def.fixed_power >= 1 && def.fixed_power <= 6 && def.is_permanent === true)) errors.push('fixed_power: an integer 1..6 of a permanent');
  if (def.element !== undefined && typeof def.element !== 'string') errors.push('element must be a string');
  if (typeof def.id !== 'string' || !/^skill_[a-z0-9_]+$/.test(def.id)) errors.push('id must match skill_[a-z0-9_]+');
  if (typeof def.name !== 'string' || !def.name) errors.push('name required');
  if (typeof def.version !== 'string' || !/^\d+\.\d+\.\d+/.test(def.version)) errors.push('version must be semver');
  if (!['A', 'M', 'B', 'P'].includes(def.action_type)) errors.push('action_type must be A|M|B|P');
  if (typeof def.is_permanent !== 'boolean') errors.push('is_permanent must be a boolean');
  else if (def.is_permanent && !PBS.includes(def.point_buy_stat)) errors.push(`a permanent needs point_buy_stat ${PBS.join('|')}`);
  else if (!def.is_permanent && def.point_buy_stat != null) errors.push('point_buy_stat only applies to a permanent');
  if (def.text !== undefined && typeof def.text !== 'string') errors.push('text must be a string');
  if (!isObj(def.flags)) errors.push('flags required');
  else {
    const f = def.flags;
    if (f.action !== undefined && f.action !== def.action_type) errors.push('flags.action must equal action_type');
    if (f.permanent !== undefined && f.permanent !== def.is_permanent) errors.push('flags.permanent must equal is_permanent');
    if (f.hooks !== undefined && !(Array.isArray(f.hooks) && f.hooks.every(h => typeof h === 'string'))) errors.push('flags.hooks must be a list of hook names');
    // skill isolation: the pass order ({passHook: n ≥ 1}), the building-skill slot (index ≥ 0), the plan lock (codes)
    if (f.passOrder !== undefined) {
      if (!isObj(f.passOrder)) errors.push('flags.passOrder must be {passHook: n}');
      else for (const [h, n] of Object.entries(f.passOrder)) {
        if (HOOK_SPECS[h]?.kind !== 'pass') errors.push(`flags.passOrder.${h}: not a pass hook (${PASS_HOOKS.join(', ')})`);
        else if (!(Number.isInteger(n) && n >= 1)) errors.push(`flags.passOrder.${h} must be an integer ≥ 1`);
      }
    }
    if (f.buildingSkill !== undefined && !(Number.isInteger(f.buildingSkill) && f.buildingSkill >= 0)) errors.push('flags.buildingSkill must be an integer ≥ 0');
    if (f.planLock !== undefined && !(Array.isArray(f.planLock) && f.planLock.length > 0 && f.planLock.every(c => CODES.includes(c)))) errors.push(`flags.planLock must be a non-empty list of ${CODES.join('|')}`);
    if (v2 && opts.builtin && isObj(def.hooks)) for (const h of PASS_HOOKS) if (def.hooks[h] !== undefined && !isJsMarker(def.hooks[h]) && !Number.isInteger(f.passOrder?.[h])) errors.push(`hooks.${h}: a built-in pass program needs flags.passOrder.${h}`);
  }
  const libMap = opts.libMap ? new Map(Object.entries(opts.libMap)) : new Map((opts.libs || defaultLibs()).map(l => [l.id, l]));
  const subs = new Map();
  if (def.uses !== undefined && !Array.isArray(def.uses)) errors.push('uses must be a list of lib ids');
  for (const u of def.uses || []) {
    const l = libMap.get(u);
    if (!l) { errors.push(`uses unknown lib ${u}`); continue; }
    for (const [n, s] of Object.entries(l.subs || {})) if (!subs.has(n)) subs.set(n, s);
  }
  if (!isObj(def.hooks)) errors.push('hooks required ({hook: program})');
  else for (const [h, prog] of Object.entries(def.hooks)) {
    if (!HOOK_SPECS[h]) { errors.push(`hooks.${h}: unknown hook (${HOOK_NAMES.join(', ')})`); continue; }
    if (isJsMarker(prog)) {
      if (prog.engine !== 'js' || typeof prog.impl !== 'string') errors.push(`hooks.${h}: a marker is {"engine": "js", "impl": "…"}`);
      else if (!opts.builtin) errors.push(`hooks.${h}: {"engine": "js"} is for built-in skills only — a foreign skill needs a program`);
      continue;
    }
    if (HOOK_SPECS[h].engine === 'js') { errors.push(`hooks.${h}: this hook has no data engine yet (in-place pass) — mark it {"engine": "js"}`); continue; }
    errors.push(...validateLogic(prog, subs, KNOWN).map(e => `hooks.${h}: ${e}`));
  }
  return errors;
}

// ------------------------------------------------------------ loading
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const jsonFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f)) : []);
let _defaultLibs = null;
export function defaultLibs() { return (_defaultLibs ||= jsonFiles(path.join(SKILLS_DATA_DIR, 'lib')).map(readJson)); }

// bindSkillDef(def, libs) → def with non-enumerable $subs (Map) and $std ({hook: {logic, subs}} defaults).
export function bindSkillDef(def, libs = defaultLibs()) {
  if (def.$subs) return def;
  const byId = new Map(libs.map(l => [l.id, l]));
  const subs = new Map();
  for (const u of def.uses || []) { const l = byId.get(u); if (l) for (const [n, s] of Object.entries(l.subs)) if (!subs.has(n)) subs.set(n, s); }
  Object.defineProperty(def, '$subs', { value: subs, enumerable: false });
  return def;
}
// The std defaults (lib skills_std `defaults`): {hook: {logic: {call: [sub]}, subs}}.
export function stdDefaults(libs = defaultLibs()) {
  const std = libs.find(l => l.id === STD_LIB_ID);
  const out = {};
  if (std?.defaults) { const subs = new Map(Object.entries(std.subs)); for (const [h, s] of Object.entries(std.defaults)) out[h] = { logic: { call: [s] }, subs }; }
  return out;
}
// loadSkillDefs(dir | {skills, libs}, {builtinIds, lenient}) → { defs: Map(id → def), libs: [lib], std: defaults, errors }.
// Invalid files throw (they must never reach a resolver); lenient: an invalid skill is left out and its reasons go to
// `errors` ([`<id>: <reasons>`]; a bad lib still throws). Across the built-ins: deal_order, each (pass hook, n) of
// flags.passOrder and flags.buildingSkill are unique (the later file in id order is the invalid one).
export function loadSkillDefs(src = process.env.SKILL_DEFS_DIR || SKILLS_DATA_DIR, { builtinIds = null, lenient = false } = {}) {
  let skills = [], libs = [];
  if (typeof src === 'string') {
    const sDir = fs.existsSync(path.join(src, 'skills')) ? path.join(src, 'skills') : src;
    const lDir = fs.existsSync(path.join(src, 'lib')) ? path.join(src, 'lib') : path.join(sDir, '..', 'lib');
    skills = jsonFiles(sDir).map(readJson);
    libs = jsonFiles(lDir).map(readJson);
  } else { skills = src.skills || []; libs = src.libs || defaultLibs(); }
  for (const l of libs) { const e = validateSkillLib(l); if (e.length) throw new Error(`skill lib ${l?.id}: ${e.join('; ')}`); }
  const defs = new Map(), errors = [];
  const taken = new Map();   // `deal_order n` | `passOrder hook n` | `buildingSkill n` → id
  for (const d of skills) {
    const builtin = !builtinIds || builtinIds.has(d?.id);
    const e = validateSkillDef(d, { libs, builtin });
    if (!e.length && defs.has(d.id)) e.push('defined twice');
    const slots = [];
    if (!e.length && builtin) {
      if (d.deal_order !== undefined) slots.push([`deal_order ${d.deal_order}`, 'deal_order']);
      for (const [h, n] of Object.entries(d.flags?.passOrder || {})) slots.push([`passOrder ${h} ${n}`, `flags.passOrder.${h}`]);
      if (d.flags?.buildingSkill !== undefined) slots.push([`buildingSkill ${d.flags.buildingSkill}`, 'flags.buildingSkill']);
      for (const [k, what] of slots) if (taken.has(k)) e.push(`${what} ${k.split(' ').pop()} already used by ${taken.get(k)}`);
    }
    if (e.length) {
      if (!lenient) throw new Error(`skill ${d?.id}: ${e.join('; ')}`);
      errors.push(`${d?.id}: ${e.join('; ')}`); continue;
    }
    for (const [k] of slots) taken.set(k, d.id);
    defs.set(d.id, bindSkillDef(d, libs));
  }
  return { defs, libs, std: stdDefaults(libs), errors };
}

// ------------------------------------------------------------ running
// programOf(def, hook, std) → {logic, subs} | {js: marker} | null (no program: the hook's neutral value).
export function programOf(def, hookName, std = {}) {
  const h = def?.hooks?.[hookName];
  if (h !== undefined) return isJsMarker(h) ? { js: h } : { logic: h, subs: def.$subs || new Map() };
  return std[hookName] || null;
}
const marshal = (v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v);
// runHookProgram(prog, hookName, skillId, W, args) → the program's value. Throws EffectEngineLimit /
// EffectProgramError (program) or whatever a ctx query throws.
export function runHookProgram(prog, hookName, skillId, W, args = {}, limits = SKILL_LIMITS) {
  const root = { skill: skillId ?? null };
  for (const [k, v] of Object.entries(args || {})) if (k !== 'skill') root[k] = marshal(v);
  return runProgram(prog.logic, prog.subs, W, root, { ctxOps: SKILL_CTX_OPS, deny: DENY, limits });
}
