// game/effect-hooks.mjs — peer-side effect rules as data (MV milestone, 2026-11-17).
//
// effects.mjs#resolveEffect answers "what does this cast do"; the rules that act ACROSS actions — channels (which break,
// which tick), traps (which spring on a step / a declared target, what a sprung trap does, how a laid trap is
// recorded, where a spent trap card goes), the holdings a falling permanent takes with it, and the summon family
// (which creature a stat-buy card will raise, what a paid stat buy does) — used to be inline in peer.mjs. They are
// hooks here: `effectHook(name, ctx, args) → [edit records]` (or a value for summon_plan), each with a JS reference
// (verbatim the old inline logic; since F9e the test oracle effects-data/oracle/hooks-js.mjs) and a JsonLogic program in game/effects-data/hooks/<family>.json (schema
// chaosd6.effect-hooks/1, built by tools/out/_mv_build_hooks.mjs; ops below), run on effect-engine.mjs#runProgram. peer.mjs keeps the plumbing:
// it builds the read-only ctx (queries below), calls the hook, and APPLIES the records it gets back in order (card
// moves, entity writes, logs, autosave, resolveEffect of a channel tick, damage through the generic protections).
//
// Engine switch: EFFECT_HOOKS_ENGINE=js|data|shadow, else EFFECT_ENGINE's value (js|data|shadow), default data (effect isolation F1, 2026-11-21; js = the JS reference hooks, a test oracle).
//   shadow — both run; the results must be JSON-identical (stderr `[effect-hooks] SHADOW MISMATCH`, EFFECT_HOOKS_SHADOW_STRICT=1
//   throws); the JS result is used. A data program error / limit → the hook's neutral value ([] / null) and a stderr line.
// Pure module: no peer globals; Node-18 compatible.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProgram, validateLogic, SPECIAL_OPS, PURE_OP_NAMES, EffectEngineLimit, EffectProgramError } from './effect-engine.mjs';
import { disabledCardMoves } from './world-prims.mjs';   // class isolation phase 6 (was class-traps.mjs); the ctx op disabled_moves
import { TRAP_POWER } from './effect-prims.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EFFECT_HOOKS_DIR = path.join(here, 'effects-data', 'hooks');
export const EFFECT_HOOKS_SCHEMA_ID = 'chaosd6.effect-hooks/1';
export const EFFECT_HOOKS_LIMITS = Object.freeze({ maxOps: 100000, maxDepth: 64, maxRange: 256 });
export { TRAP_POWER };   // effect-prims.mjs; the data programs read tables.trap_power (held equal by tools/effect-hooks-check.mjs)

// family file of each hook, its neutral value (a failing data program) and the shape of its result.
export const EFFECT_HOOK_SPECS = Object.freeze({
  channel_pass:  { family: 'channel', result: 'records', ops: ['kept', 'break', 'contact', 'tick'] },
  channel_land:  { family: 'channel', result: 'records', ops: ['release_card', 'channels', 'hold_card'] },
  trap_enter:    { family: 'trap', result: 'list' },
  trap_targeted: { family: 'trap', result: 'records', ops: ['spring'] },
  trap_spring:   { family: 'trap', result: 'records', ops: ['bless', 'damage', 'afflict', 'perm_add'] },
  trap_lay:      { family: 'trap', result: 'records', ops: ['add_trap'] },
  trap_spent:    { family: 'trap', result: 'records', ops: ['trap_remove', 'release_card', 'discard_new', 'drop_perm', 'mine_done', 'world_edit', 'card_to_me'] },
  perm_falls:    { family: 'holdings', result: 'records', ops: ['release_card', 'channels', 'traps'] },
  summon_plan:   { family: 'summon', result: 'plan' },
  summon_paid:   { family: 'summon', result: 'records', ops: ['archive_take', 'ward', 'revive_player', 'summon_add', 'summon_end', 'release_held', 'ward_clear', 'drop_perm', 'spawn'] },
});
export const EFFECT_HOOK_NAMES = Object.freeze(Object.keys(EFFECT_HOOK_SPECS));
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const neutralOfHook = (name) => (EFFECT_HOOK_SPECS[name]?.result === 'plan' ? { op: 'keep' } : []);
export function hookResultOk(name, v) {
  const sp = EFFECT_HOOK_SPECS[name];
  if (!sp) return false;
  if (sp.result === 'plan') return isObj(v) && (v.op === 'keep' || (v.op === 'set' && isObj(v.summon)));
  if (!Array.isArray(v)) return false;
  if (sp.result === 'list') return v.every(isObj);
  return v.every(r => isObj(r) && sp.ops.includes(r.op));
}

// ------------------------------------------------------------ data side
// ctx queries of the hook programs (read-only). W = { c: the peer's ctx }.
export const HOOK_CTX_OPS = {
  ids: (W) => [...W.c.ids()],
  view: (W, [id]) => W.c.view(id) ?? null,
  life_of: (W, [id]) => W.c.lifeOf(id),
  channels_of: (W, [id]) => [...W.c.channelsOf(id)],
  reveal_of: (W, [id]) => W.c.reveal(id) ?? null,
  has_perm: (W, [id, p]) => !!W.c.hasPerm(id, p),
  class_emits: (W, [id, code]) => !!W.c.classEmits(id, code),
  traps: (W) => [...W.c.traps()],
  trap_gone: (W, [id]) => !!W.c.trapGone(id),
  trap_spent: (W, [id]) => !!W.c.trapSpent(id),
  enemy_of: (W, [a, b]) => !!W.c.enemyOf(a, b),
  dist_between: (W, [a, b]) => W.c.distBetween(a, b),
  reveals: (W) => [...W.c.reveals()],
  blessed_every: (W, [id]) => !!W.c.blessedEvery(id),
  stat_of: (W, [id, stat]) => W.c.statOf(id, stat),
  elem_stat: (W, [el]) => W.c.elemStat(el),
  shielded: (W, [id, el]) => !!W.c.shielded(id, el),
  untouchable: (W, [victim, attacker]) => !!W.c.untouchable(victim, attacker),
  ctx_self: (W) => W.c?.self ?? null,
  effect_known: (W, [id]) => !!W.c.effectKnown(id),
  world_edit_gone: (W, [id]) => !!W.c.worldEditGone(id),
  disabled_card_moves: (_W, [ts]) => disabledCardMoves(ts),     // world-prims.mjs (a disabled trap's card routing)
  side_of: (W, [a]) => W.c.sideOf(a),
  hex_distance: (W, [a, b]) => W.c.hexDistance(a, b),
  creature: (W, [cid]) => W.c.creature(cid) ?? null,
  is_string: (_W, [x]) => typeof x === 'string',
  int_q: (_W, [x]) => Number.isInteger(x),
};
export const DENIED_OPS = Object.freeze(['emit', 'put', 'out', 'note', 'return', 'return_empty', 'seed', 'hash_int', 'rng', 'point_buy', 'point_buy_seed']);
const DENY = new Set(DENIED_OPS);
export const HOOK_OPS = Object.freeze([...SPECIAL_OPS.filter(o => !DENY.has(o)), ...PURE_OP_NAMES, ...Object.keys(HOOK_CTX_OPS)].sort());
const KNOWN = new Set(HOOK_OPS);

// validateHookFile(file) → [errors]. A file: {schema, id (= family), version, description?, subs: {name: {params, body}}, tables?, hooks: {name: program}}.
export function validateHookFile(f) {
  const errors = [];
  if (!isObj(f)) return ['file is not an object'];
  if (f.schema !== EFFECT_HOOKS_SCHEMA_ID) errors.push(`schema must be ${EFFECT_HOOKS_SCHEMA_ID}`);
  if (typeof f.id !== 'string' || !/^[a-z0-9_]+$/.test(f.id)) errors.push('id must match [a-z0-9_]+');
  if (typeof f.version !== 'string' || !/^\d+\.\d+\.\d+/.test(f.version)) errors.push('version must be semver');
  const subs = new Map(Object.entries(isObj(f.subs) ? f.subs : {}));
  if (f.subs !== undefined && !isObj(f.subs)) errors.push('subs must be an object');
  for (const [n, s] of subs) {
    if (!Array.isArray(s?.params)) errors.push(`${n}: params must be an array`);
    errors.push(...validateLogic(s?.body, subs, KNOWN).map(e => `${n}: ${e}`));
  }
  if (!isObj(f.hooks)) errors.push('hooks required');
  else for (const [h, prog] of Object.entries(f.hooks)) {
    if (!EFFECT_HOOK_SPECS[h]) { errors.push(`hooks.${h}: unknown hook (${EFFECT_HOOK_NAMES.join(', ')})`); continue; }
    if (EFFECT_HOOK_SPECS[h].family !== f.id) errors.push(`hooks.${h}: belongs to family ${EFFECT_HOOK_SPECS[h].family}`);
    errors.push(...validateLogic(prog, subs, KNOWN).map(e => `hooks.${h}: ${e}`));
  }
  return errors;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
// loadHookFiles(dir | [files]) → Map(hook → {logic, subs, tables, family, version}). Invalid files throw.
export function loadHookFiles(src = process.env.EFFECT_HOOKS_DIR || EFFECT_HOOKS_DIR) {
  const files = Array.isArray(src) ? src : (fs.existsSync(src) ? fs.readdirSync(src).filter(n => n.endsWith('.json')).sort().map(n => readJson(path.join(src, n))) : []);
  const out = new Map();
  for (const f of files) {
    const e = validateHookFile(f);
    if (e.length) throw new Error(`effect hooks ${f?.id}: ${e.join('; ')}`);
    const subs = new Map(Object.entries(f.subs || {}));
    for (const [h, logic] of Object.entries(f.hooks)) {
      if (out.has(h)) throw new Error(`effect hook ${h} defined twice`);
      out.set(h, { logic, subs, tables: f.tables || {}, family: f.id, version: f.version });
    }
  }
  return out;
}
let bundle = null;
export const hookBundle = () => (bundle ||= loadHookFiles());
// runHookData(name, ctx, args[, prog]) → the program's value (throws EffectEngineLimit / EffectProgramError / a ctx query's error).
export function runHookData(name, ctx, args = {}, prog = hookBundle().get(name)) {
  if (!prog) throw new EffectProgramError(`no data program for ${name}`);
  return runProgram(prog.logic, prog.subs, { c: ctx }, { ...args, tables: prog.tables }, { ctxOps: HOOK_CTX_OPS, deny: DENY, limits: EFFECT_HOOKS_LIMITS });
}
// F9e: the JS reference hooks (test oracle effects-data/oracle/hooks-js.mjs) — loaded only when a JS engine is asked
// for; a check installs them to run effectHook(…, 'js' | 'shadow') under the data default.
let JS_HOOKS = null;
export function installJsHooks(table) { JS_HOOKS = table && typeof table === 'object' ? table : null; }
const jsHook = (name) => { if (!JS_HOOKS) throw new Error('effect-hooks.mjs: the JS reference hooks are not loaded (EFFECT_HOOKS_ENGINE=data)'); return JS_HOOKS[name]; };
export const effectHookJs = (name, ctx, args = {}) => jsHook(name)(ctx, args);

// ------------------------------------------------------------ dispatcher
const ENV = (typeof process !== 'undefined' && process.env) || {};
const pickMode = (x) => (['js', 'data', 'shadow'].includes(x) ? x : null);
export const EFFECT_HOOKS_ENGINE = pickMode(ENV.EFFECT_HOOKS_ENGINE) || pickMode(ENV.EFFECT_ENGINE) || 'data';
if (EFFECT_HOOKS_ENGINE !== 'data') installJsHooks((await import('./effects-data/oracle/hooks-js.mjs')).JS_HOOKS);
export const effectHookStats = { compared: 0, mismatches: 0, errors: 0, unhandled: 0, byHook: {} };
let noted = 0;
const note = (msg) => { effectHookStats.errors++; if (noted++ < 20) console.error(`[effect-hooks] data hook: ${msg}`); };
function dataResult(name, ctx, args) {
  try {
    const v = runHookData(name, ctx, args);
    if (hookResultOk(name, v)) return v;
    note(`${name}: bad result ${JSON.stringify(v)?.slice(0, 200)}`);
  } catch (e) {
    if (!(e instanceof EffectEngineLimit || e instanceof EffectProgramError)) throw e;   // a ctx query threw: as JS
    note(`${name}: ${e.message}`);
  }
  return neutralOfHook(name);
}
// applyHookRecords(records, handlers) — the generic plumbing peer.mjs (and the fixtures of tools/effect-hooks-check.mjs)
// use: each record, in order, goes to handlers[record.op](record); a record without a handler is skipped (counted).
export function applyHookRecords(records, handlers) {
  for (const rec of records || []) {
    const h = handlers[rec?.op];
    if (h) h(rec); else effectHookStats.unhandled++;
  }
}
// effectHook(name, ctx, args) → the hook's records (or summon_plan's {op}); see the header for the engine switch.
export function effectHook(name, ctx, args = {}, mode = EFFECT_HOOKS_ENGINE) {
  if (!EFFECT_HOOK_SPECS[name]) throw new Error(`effect-hooks.mjs: unknown hook ${name}`);
  if (mode === 'data') return dataResult(name, ctx, args);
  const js = jsHook(name);
  if (mode === 'js') return js(ctx, args);
  const want = js(ctx, args);
  let got;
  try { got = JSON.stringify(dataResult(name, ctx, args)); } catch (e) { got = `throws ${e?.message}`; }
  effectHookStats.compared++;
  effectHookStats.byHook[name] = (effectHookStats.byHook[name] || 0) + 1;
  const w = JSON.stringify(want);
  if (got !== w) {
    effectHookStats.mismatches++;
    console.error(`[effect-hooks] SHADOW MISMATCH ${name}\n  js:   ${w?.slice(0, 600)}\n  data: ${got?.slice(0, 600)}`);
    if (ENV.EFFECT_HOOKS_SHADOW_STRICT === '1') throw new Error(`effect-hooks shadow mismatch in ${name}`);
  }
  return want;
}
if (EFFECT_HOOKS_ENGINE !== 'js') {
  hookBundle();   // fail fast on a bad file
  if (ENV.EFFECT_HOOKS_SHADOW_REPORT === '1' || ENV.EFFECT_SHADOW_REPORT === '1') process.on('exit', () => console.log(`[effect-hooks] ${EFFECT_HOOKS_ENGINE}: shadow compared ${effectHookStats.compared}, mismatches ${effectHookStats.mismatches}, errors ${effectHookStats.errors} ${JSON.stringify(effectHookStats.byHook)}`));
}
