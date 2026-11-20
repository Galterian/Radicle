// Data-driven class hooks (milestone C2 of the chaosD6-Classes program, user request 2026-11-16).
//
// A class is a JSON definition (game/classes-data/classes/<id>.json, schema chaosd6.class/1 in
// game/classes-data/SCHEMA.md + class.schema.json) whose `hooks` map a hook name of classes.mjs#classHook to a
// program in the effects' JsonLogic dialect (effect-engine.mjs — the same evaluator, op budget and depth limit,
// reached through its runProgram/env API; effect-engine.mjs itself is NOT modified, so the effects and skills
// validator pins do not move). A hook program gets the hook's arguments as root registers and its VALUE is the hook
// result. Abilities that resolve in peer.mjs (map geometry, occupancy, the move register) are marked
// `{"engine": "js", "impl": "peer.mjs#…"}`.
//
// This module is pure: no peer globals. classes.mjs (the dispatcher, CLASS_ENGINE=js|data|shadow) wraps the resolver
// ctx as W = { c: ctx, cd(id), flag(id, key), sha(s), elemStat(el) } before calling runHookProgram.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProgram, validateLogic, SPECIAL_OPS, PURE_OP_NAMES, EffectEngineLimit, EffectProgramError } from './effect-engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLASSES_DATA_DIR = path.join(here, 'classes-data');
export const CLASS_SCHEMA_ID = 'chaosd6.class/1';
export const CLASS_LIB_SCHEMA_ID = 'chaosd6.class-lib/1';
export const STD_LIB_ID = 'classes_std';
// A hook runs once per unit / reveal / outcome: a small budget (an ability over ~10 units ≈ 3k ops).
export const CLASS_LIMITS = Object.freeze({ maxOps: 50000, maxDepth: 64, maxRange: 256 });
export { EffectEngineLimit, EffectProgramError };

// ------------------------------------------------------------ vocabulary
// The cast-bound forms of the effects make no sense in a hook (no cast, no outcome object). The salted dice forms
// that take an explicit seed (hash_int, point_buy_seed) ARE allowed: W.sha is the resolver's sha256.
export const DENIED_OPS = Object.freeze(['emit', 'put', 'out', 'note', 'return', 'return_empty', 'seed', 'rng', 'point_buy']);
const DENY = new Set(DENIED_OPS);
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ELEMS = ['elem_vitality', 'elem_souls', 'elem_time', 'elem_space', 'elem_air', 'elem_water', 'elem_earth', 'elem_fire', 'elem_concentration', 'elem_harmony'];
// ctx queries over the resolver ctx (classes.mjs header / HOOKS.md) + a few pure helpers the JS hooks use
// (Number(), Number.isInteger, JSON.parse of a snapshot list, CSV split, {...o, k: v}). Read-only.
export const CLASS_CTX_OPS = {
  view: (W, [id]) => W.c.view(id) ?? null,
  view_ids: (W) => [...W.c.viewIds()],
  views: (W) => [...W.c.viewValues()],
  life_of: (W, [id]) => W.c.lifeOf(id),
  dist: (W, [a, b]) => W.c.dist(a, b),
  enemy_of: (W, [a, b]) => !!W.c.enemyOf(a, b),
  has_perm: (W, [id, p]) => !!W.c.hasPerm(id, p),
  stat_of: (W, [id, st]) => W.c.statOf(id, st),
  side_of: (W, [al]) => W.c.sideOf(al),
  class_data: (W, [id]) => W.cd(id) ?? null,             // the class's data/classes.json `data` (or the definition's `data`)
  class_flag: (W, [id, k]) => W.flag(id, k),              // a key of the class's `flags`
  skill_action: (W, [sk]) => W.c.skillAction(sk) ?? null,
  library: (W) => [...W.c.library()],
  ctx_self: (W) => W.c?.self ?? null,
  ctx_label: (W) => W.c?.label ?? null,
  ctx_turn: (W) => W.c.turn,
  ctx_action: (W) => W.c.action,
  elem_stat: (W, [el]) => W.elemStat(el) ?? null,
  elems_of_stat: (W, [st]) => ELEMS.filter(el => W.elemStat(el) === st),
  sha_hex: (W, [s]) => W.sha(String(s)),
  // pure helpers
  num: (_W, [x]) => Number(x),
  is_int: (_W, [x]) => Number.isInteger(x),
  json_list: (_W, [s, d]) => { try { const v = JSON.parse(s || ''); return Array.isArray(v) ? v : d; } catch { return d; } },
  csv: (_W, [s]) => String(s || '').split(',').filter(Boolean),
  with_key: (_W, [o, k, v]) => { if (BAD_KEYS.has(String(k))) throw new EffectProgramError(`with_key: key ${k} not allowed`); return { ...(o && typeof o === 'object' && !Array.isArray(o) ? o : {}), [k]: v }; },
  type_of: (_W, [x]) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x),
  keys: (_W, [o]) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : []),
  has_key: (_W, [o, k]) => !!o && typeof o === 'object' && !Array.isArray(o) && !BAD_KEYS.has(String(k)) && Object.prototype.hasOwnProperty.call(o, k),
};
export const CLASS_OPS = Object.freeze([...SPECIAL_OPS.filter(o => !DENY.has(o)), ...PURE_OP_NAMES, ...Object.keys(CLASS_CTX_OPS)].sort());
const KNOWN = new Set(CLASS_OPS);

// ------------------------------------------------------------ hooks
// std   — every class has the hook: lib classes_std `defaults` gives the program of a class without its own.
// args  — the root registers (Map → [[key, value]…] pairs, Set → array). Every program also sees `class` (its id).
// result — shape check of a program's value (resultOk); `pairs` results are turned into an object (unmarshal).
export const HOOK_SPECS = Object.freeze({
  colours:         { std: true, args: [], result: 'pairs' },
  kind:            { std: true, args: [], result: 'string' },
  ready:           { std: true, args: ['cs', 'held', 'turn'], result: 'bool' },
  config:          { std: true, args: [], result: 'object' },
  strike:          { std: true, args: ['cs', 'cols', 'stat', 'elem', 'enemy', 'pb'], result: 'strike' },
  restore:         { std: true, args: ['cs', 'cols', 'stat', 'kind'], result: 'bool' },
  reanimated_strike: { args: ['down', 'stat', 'elem', 'enemy', 'pb'], result: 'reanim' },   // Necromancer, ruling 2026-11-16
  progress:        { std: true, args: ['state', 'cols', 'co'], result: 'progress' },
  life_points:     { std: true, args: ['dmg', 'illusion', 'armor', 'chaseBonus'], result: 'life_points' },
  stance:          { args: ['code'], result: 'code' },
  stance_target:   { args: ['cands'], result: 'id' },
  emits:           { args: ['code', 'site'], result: 'bool' },
  plan_emits:      { args: ['held', 'archived', 'usedTurn', 'turn', 'options', 'code', 'queued'], result: 'bool' },
  attack_out:      { args: ['attacker', 'dmg', 'scored', 'defender'], result: 'number' },   // CR: + defender (Assassin vs an enemy below full life)
  lifesteal:       { args: ['attacker', 'amount', 'source', 'why'], result: 'number' },   // CR: + source / why (Noble: only its own Attack)
  lifesteal_apply: { args: ['amount', 'life', 'lifeMax', 'held'], result: 'number' },
  pre_cast:        { args: ['actor', 'elements', 'salt'], result: 'pre_cast' },
  ability:         { args: ['actor', 'ab', 'salt'], result: 'ability' },
  transmute:       { args: ['id', 'outcomes'], result: 'transmute' },
  destroy_result:  { args: ['d'], result: 'string' },
  end_turn:        { args: ['held', 'moved', 'life', 'lifeMax', 'movedRounds'], result: 'number' },   // CR: + movedRounds (Guardian: still on the 2nd and 3rd action)
  step:            { args: ['threatReady', 'ring', 'trap', 'wtrap', 'building', 'trapLeft'], result: 'step' },
  dungeon_step:    { args: ['trap', 'trapLeft'], result: 'trap' },
  combat_in:       { args: ['list'], result: 'bool' },
  pick_target:     { args: ['seed', 'cands'], result: 'id' },
  chase_step:      { args: ['state', 'chasing'], result: 'chase' },
  contact:         { args: ['foes'], result: 'id' },
  local:           { args: [], result: 'local' },
  share_skills:    { args: ['actor', 'skills', 'adj'], result: 'share' },
});
export const HOOK_NAMES = Object.freeze(Object.keys(HOOK_SPECS));
export const STD_HOOKS = Object.freeze(HOOK_NAMES.filter(h => HOOK_SPECS[h].std));
const TRAP_OUTCOMES = ['none', 'dodge', 'disable', 'spring'];
const ABILITY_OUT = ['heals', 'armor', 'illusion', 'discards', 'lures', 'revives', 'traps', 'tokens'];

// The value a hook has when no program applies (or a program fails): what the JS hook returns for a class that does
// not act in it.
export function neutralOf(hookName, args = {}) {
  switch (hookName) {
    case 'colours': case 'config': return {};
    case 'kind': return 'static';
    case 'ready': case 'restore': case 'emits': case 'plan_emits': case 'combat_in': return false;
    case 'strike': case 'reanimated_strike': case 'stance': case 'stance_target': case 'pick_target': case 'contact': case 'local': return null;
    case 'attack_out': return args.dmg;
    case 'lifesteal': case 'end_turn': return 0;
    case 'lifesteal_apply': return args.life;
    case 'destroy_result': return args.d?.result;
    case 'progress': return { state: args.state, event: null };
    case 'life_points': return { illusion: args.illusion, armor: args.armor, chaseBonus: args.chaseBonus, absorbed: 0 };
    case 'pre_cast': return null;
    case 'ability': return { used: false, note: null, log: [], mine: [], out: {} };
    case 'transmute': return { edits: [], log: [] };
    case 'step': return { stealth: false, trap: args.trap ? 'spring' : 'none' };
    case 'dungeon_step': return args.trap ? 'spring' : 'none';
    case 'chase_step': return { chasers: [...new Set(args.chasing || [])].sort(), bonus: Number(args.state?.bonus) || 0, fresh: [], grant: 0, fade: false };
    case 'share_skills': return { adds: [], log: [] };
    default: return undefined;
  }
}
const isNum = (x) => typeof x === 'number' && !Number.isNaN(x);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string';
const strList = (x) => Array.isArray(x) && x.every(isStr);
// `pairs` → object (a program cannot build an object with computed keys; it returns [[key, value]…]).
export function unmarshal(hookName, v) {
  if (HOOK_SPECS[hookName]?.result === 'pairs' && Array.isArray(v)) {
    const o = {};
    for (const p of v) if (Array.isArray(p) && isStr(p[0]) && !BAD_KEYS.has(p[0])) o[p[0]] = p[1];
    return o;
  }
  return v;
}
// Shape check of a (unmarshalled) program value — a foreign program may return anything; built-ins always pass.
export function resultOk(hookName, v) {
  switch (HOOK_SPECS[hookName]?.result) {
    case 'pairs': return isObj(v) && Object.values(v).every(strList);
    case 'string': return isStr(v) || (hookName === 'destroy_result' && v === undefined);
    case 'bool': return typeof v === 'boolean';
    case 'object': return isObj(v);
    case 'number': return isNum(v);
    case 'code': return v === null || ['A', 'B', 'M', 'P', 'EM', 'EP'].includes(v);
    case 'id': return v === null || isStr(v);
    case 'trap': return TRAP_OUTCOMES.includes(v);
    case 'step': return isObj(v) && typeof v.stealth === 'boolean' && TRAP_OUTCOMES.includes(v.trap);
    case 'strike': return v === null || (isObj(v) && ['retry', 'destroyed', 'too weak'].includes(v.result) && typeof v.ok === 'boolean' && typeof v.last === 'boolean');
    case 'reanim': return v === null || (isObj(v) && ['retry', 'destroyed', 'too weak'].includes(v.result) && typeof v.ok === 'boolean' && typeof v.last === 'boolean' && isStr(v.elem));
    case 'progress': return isObj(v) && isObj(v.state) && strList(v.state.down) && typeof v.state.archived === 'boolean' && typeof v.state.tapped === 'boolean';
    case 'life_points': return isObj(v) && ['illusion', 'armor', 'chaseBonus', 'absorbed'].every(k => isNum(v[k]));
    case 'pre_cast': return v === null || (isObj(v) && isStr(v.stat) && typeof v.fail === 'boolean' && Array.isArray(v.dice) && isNum(v.value));
    case 'ability': return v === null || (isObj(v) && typeof v.used === 'boolean' && (v.note === null || isStr(v.note)) && strList(v.log) && strList(v.mine)
      && isObj(v.out) && Object.entries(v.out).every(([k, l]) => ABILITY_OUT.includes(k) && Array.isArray(l) && l.every(isObj)));
    case 'transmute': return isObj(v) && Array.isArray(v.edits) && strList(v.log) && v.edits.every(e => isObj(e) && Number.isInteger(e.i) && e.i >= 0 && Array.isArray(e.statTokens) && Array.isArray(e.heals));
    case 'chase': return isObj(v) && strList(v.chasers) && strList(v.fresh) && isNum(v.bonus) && isNum(v.grant) && typeof v.fade === 'boolean';
    case 'local': return v === null || (isObj(v) && ['recover', 'draw', 'grant'].includes(v.op));
    case 'share': return isObj(v) && Array.isArray(v.adds) && v.adds.every(a => isObj(a) && isStr(a.on) && isStr(a.skill)) && strList(v.log);
    default: return true;
  }
}

// A hook entry is a program, or a JS marker {engine: 'js', impl, note?} (built-ins only).
export const isJsMarker = (h) => isObj(h) && Object.prototype.hasOwnProperty.call(h, 'engine');

// ------------------------------------------------------------ validation
export function validateClassLib(lib) {
  const errors = [];
  if (lib?.schema !== CLASS_LIB_SCHEMA_ID) errors.push(`schema must be ${CLASS_LIB_SCHEMA_ID}`);
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
      if (!HOOK_SPECS[h]?.std) errors.push(`defaults.${h}: not a hook with a std default (${STD_HOOKS.join(', ')})`);
      if (!subs.has(s)) errors.push(`defaults.${h}: unknown sub ${s}`);
    }
  }
  return errors;
}
const KINDS = ['tap', 'once_per_round', 'static', 'passive'];
// validateClassDef(def, {libs | libMap, builtin}) → [errors]. `builtin` (a bundled chaosD6 class) may mark hooks
// {engine: 'js'}; a foreign definition must give a program for every hook it declares.
export function validateClassDef(def, opts = {}) {
  const errors = [];
  if (!isObj(def)) return ['definition is not an object'];
  if (def.schema !== CLASS_SCHEMA_ID) errors.push(`schema must be ${CLASS_SCHEMA_ID}`);
  if (typeof def.id !== 'string' || !/^class_[a-z0-9_]+$/.test(def.id)) errors.push('id must match class_[a-z0-9_]+');
  if (typeof def.name !== 'string' || !def.name) errors.push('name required');
  if (typeof def.version !== 'string' || !/^\d+\.\d+\.\d+/.test(def.version)) errors.push('version must be semver');
  if (!isObj(def.data)) errors.push('data required (the class data: ability_kind, colors, text, knobs)');
  else {
    if (!KINDS.includes(def.data.ability_kind)) errors.push(`data.ability_kind must be ${KINDS.join('|')}`);
    if (!Array.isArray(def.data.colors) || !def.data.colors.length || !def.data.colors.every(e => ELEMS.includes(e)) || new Set(def.data.colors).size !== def.data.colors.length) errors.push('data.colors must be a non-empty list of distinct elements');
    if (typeof def.data.text !== 'string') errors.push('data.text must be a string');
  }
  if (!isObj(def.flags)) errors.push('flags required');
  else if (def.flags.hooks !== undefined && !strList(def.flags.hooks)) errors.push('flags.hooks must be a list of hook names');
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
      else if (!opts.builtin) errors.push(`hooks.${h}: {"engine": "js"} is for built-in classes only — a foreign class needs a program`);
      continue;
    }
    errors.push(...validateLogic(prog, subs, KNOWN).map(e => `hooks.${h}: ${e}`));
  }
  return errors;
}

// ------------------------------------------------------------ loading
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const jsonFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f)) : []);
let _defaultLibs = null;
export function defaultLibs() { return (_defaultLibs ||= jsonFiles(path.join(CLASSES_DATA_DIR, 'lib')).map(readJson)); }

// bindClassDef(def, libs) → def with a non-enumerable $subs (Map name → {params, body}).
export function bindClassDef(def, libs = defaultLibs()) {
  if (def.$subs) return def;
  const byId = new Map(libs.map(l => [l.id, l]));
  const subs = new Map();
  for (const u of def.uses || []) { const l = byId.get(u); if (l) for (const [n, s] of Object.entries(l.subs)) if (!subs.has(n)) subs.set(n, s); }
  Object.defineProperty(def, '$subs', { value: subs, enumerable: false });
  return def;
}
// The std defaults (lib classes_std `defaults`): {hook: {logic: {call: [sub]}, subs}}.
export function stdDefaults(libs = defaultLibs()) {
  const std = libs.find(l => l.id === STD_LIB_ID);
  const out = {};
  if (std?.defaults) { const subs = new Map(Object.entries(std.subs)); for (const [h, s] of Object.entries(std.defaults)) out[h] = { logic: { call: [s] }, subs }; }
  return out;
}
// loadClassDefs(dir | {classes, libs}, {builtinIds, lenient}) → { defs: Map(id → def), libs: [lib], std, errors }. Invalid
// files throw; lenient: an invalid class is left out and its reasons go to `errors` ([`<id>: <reasons>`]).
export function loadClassDefs(src = process.env.CLASS_DEFS_DIR || CLASSES_DATA_DIR, { builtinIds = null, lenient = false } = {}) {
  let classes = [], libs = [];
  if (typeof src === 'string') {
    const cDir = fs.existsSync(path.join(src, 'classes')) ? path.join(src, 'classes') : src;
    const lDir = fs.existsSync(path.join(src, 'lib')) ? path.join(src, 'lib') : path.join(cDir, '..', 'lib');
    classes = jsonFiles(cDir).map(readJson);
    libs = jsonFiles(lDir).map(readJson);
  } else { classes = src.classes || []; libs = src.libs || defaultLibs(); }
  for (const l of libs) { const e = validateClassLib(l); if (e.length) throw new Error(`class lib ${l?.id}: ${e.join('; ')}`); }
  const defs = new Map(), errors = [];
  for (const d of classes) {
    const e = validateClassDef(d, { libs, builtin: !builtinIds || builtinIds.has(d?.id) });
    if (!e.length && defs.has(d.id)) e.push('defined twice');
    if (e.length) {
      if (!lenient) throw new Error(`class ${d?.id}: ${e.join('; ')}`);
      errors.push(`${d?.id}: ${e.join('; ')}`); continue;
    }
    defs.set(d.id, bindClassDef(d, libs));
  }
  return { defs, libs, std: stdDefaults(libs), errors };
}

// ------------------------------------------------------------ running
// programOf(def, hook, std) → {logic, subs} | {js: marker} | null (no program: the hook's neutral value).
export function programOf(def, hookName, std = {}) {
  const h = def?.hooks?.[hookName];
  if (h !== undefined) return isJsMarker(h) ? { js: h } : { logic: h, subs: def.$subs || new Map() };
  return HOOK_SPECS[hookName]?.std ? (std[hookName] || null) : null;
}
const marshal = (v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v);
// runHookProgram(prog, hookName, classId, W, args) → the program's raw value. Throws EffectEngineLimit /
// EffectProgramError (program) or whatever a ctx query throws.
export function runHookProgram(prog, hookName, classId, W, args = {}, limits = CLASS_LIMITS) {
  const root = { class: classId ?? null };
  for (const [k, v] of Object.entries(args || {})) if (k !== 'class') root[k] = marshal(v);
  return runProgram(prog.logic, prog.subs, W, root, { ctxOps: CLASS_CTX_OPS, deny: DENY, limits });
}
