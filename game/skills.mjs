// game/skills.mjs — the skill-oblivious skill DISPATCHER (chaosD6-Skills S1 → skill isolation, chaosd6-8a 2026-11-22).
//
// The 14 skills of data/skills.json used to live inline in peer.mjs (S1 moved them here as JS hooks, S2 added the same
// hooks as JsonLogic data). Since the skill isolation the bundled definitions (skills-data/skills/*.json, schema
// chaosd6.skill/2 — the chaosD6-Skills content) are the only source: `SKILL_RULES` (their flags), the deal order
// (`deal_order`), the cards (`card`, builtinSkillEntries), the UI facts (`ui`, skillUiOf), the building skills
// (flags.buildingSkill), the pass order (flags.passOrder, skill-engine.mjs HOOK_SPECS) and every hook answer through
// skill-engine.mjs (SKILL_ENGINE=data, the default). A new skill needs changes only in skills-data/. No skill id appears
// here as code (tools/skill-engine-check.mjs grep gate). The JS reference hooks are a TEST ORACLE in
// skills-data/oracle/skills-js.mjs — SKILL_ENGINE=js | shadow need installSkillOracle() first.
// Node-18 compatible. Hook inventory, inputs / outputs, call sites, ordering: skills-data/HOOKS.md.
//
// Resolver ctx (`skCtx`, built once per simulate() in peer.mjs) — fields a hook may read:
//   self, label, log(...)                 my peer id, PEER_LABEL, quiet-aware logger
//   reveals, byActorPre                   the action's reveals (live array) and actor → reveal Map
//   effAction, tranceOpts, noMove,        resolver registers (Map id → code, Map id → [codes], Set id,
//   counterPen, skillFx                   Map id → {elem: amount}, [fx records])
//   noEmit, swaps (optional)              Set id (Disruption voids the emission), [{by, on}] (Overrun swap) — 2026-11-16
//   codeIs(id, c), replace(id, from, to)  the resolver's trance-aware code test / rewrite
//   enemyOf, hiddenFrom, dist, lifeOf     queries (dist = hex distance of the snapshot tiles)
//   view(id), viewValues()                snapshot of one peer / all snapshots (iteration order = view order)
//   elemStat(el)                          ELEM_TO_STAT
//   hasPerm(id, perm), permPower(id)      permanents (snapshot / entity) and their powers ({id: die})
//   castsDamage(o), effectDmgNoShield(o, def)   effect queries (effectDmgNoShield reads counterPen)
//   skillData(id)                         the active data/skills.json version's `data` (or undefined)
//   edgeDmg(atk, def)                     the damage matrix

import * as SE from './skill-engine.mjs';   // data hooks (pure; loads skills-data/)

const clone = (x) => JSON.parse(JSON.stringify(x));
// The bundled skill set: every definition is a built-in (JS markers allowed). Lenient: an invalid file is left out and
// its reasons go to skillBundleErrors() (a staged chaosD6-Skills tree is judged file by file by its validator).
const BUNDLE = SE.loadSkillDefs(undefined, { lenient: true });
export const skillBundleErrors = () => [...BUNDLE.errors];
// The bundled definitions: { defs: Map(id → def), libs, std (the skills_std default programs), errors }.
export const skillBundle = () => BUNDLE;
// The dealt built-ins = the definitions with a deal_order, in that order (it decides which 4 a player gets).
const DEALT = [...BUNDLE.defs.values()].filter(d => Number.isInteger(d.deal_order)).sort((a, b) => a.deal_order - b.deal_order || (a.id < b.id ? -1 : 1));
SE.setBuiltinPassOrders(DEALT);   // HOOK_SPECS pass `order` = the built-ins' flags.passOrder

// Flags per skill = the `flags` of its definition, keyed in deal order (+ registered foreign ids). The resolver keys:
//   action      the action code it rides on ('M' / 'P' also ride on EM / EP; Battle Trance rides on anything)
//   permanent   lands as a permanent (Rule 12 point-buy of pointBuyStat; 'any' = my best stat)
//   negating    judged by whether it did its job, not by the damage counterfactual (user ruling 2026-11-12)
//   hooks       the hook points it acts in (see HOOKS.md)
//   trance, keepsTarget, range, reach, negates, invincibleWhile, selfLock / planLock, passOrder, buildingSkill, …
//   (SCHEMA.md; + the S5 validator's priced flags)
export const SKILL_RULES = Object.fromEntries(DEALT.map(d => [d.id, clone(d.flags || {})]));
export const SKILLS_IMPLEMENTED = DEALT.map(d => d.id);
// Instants judged by what they did, not by the damage counterfactual (user ruling 2026-11-12).
export const NEGATING_SKILLS = new Set(SKILLS_IMPLEMENTED.filter(id => SKILL_RULES[id].negating));
// The skill that plays two actions (flags.trance) — Battle Trance.
export const TRANCE = SKILLS_IMPLEMENTED.find(id => SKILL_RULES[id].trance) ?? null;
// The free skills a building can grant (js/building-bonus.js; part of the (seed, q, r) contract): flags.buildingSkill order.
export const BUILDING_SKILLS = Object.freeze(SKILLS_IMPLEMENTED.filter(id => Number.isInteger(SKILL_RULES[id].buildingSkill)).sort((a, b) => SKILL_RULES[a].buildingSkill - SKILL_RULES[b].buildingSkill));
// plan_lock: the codes a skill that paid off still allows this round (flags.planLock, else flags.selfLock.codes).
const lockOf = (f) => (Array.isArray(f?.planLock) ? f.planLock : Array.isArray(f?.selfLock?.codes) ? f.selfLock.codes : null);
export const PLAN_LOCKS = Object.freeze(Object.fromEntries(SKILLS_IMPLEMENTED.filter(id => lockOf(SKILL_RULES[id])).map(id => [id, Object.freeze([...lockOf(SKILL_RULES[id])])])));
export const STATS = ['vitality', 'world', 'matter', 'will'];

// The cards = the definitions' `card` blocks (data/skills.json is a frozen record since the isolation).
// builtinSkillEntries() → { id: {id, name, tags, data} } in deal order — the shape peer.mjs pickActive gave data.skills;
// builtinSkillCatalog() → a data/skills.json-shaped collection (one canonical version per skill, + resources).
const carded = () => DEALT.filter(d => d.card);
export const builtinSkillEntries = () => Object.fromEntries(carded().map(d => { const c = d.card; return [d.id, { id: d.id, name: c.name, tags: [...(c.tags || [])], data: clone(c.data) }]; }));
export const builtinSkillCatalog = () => ({ collection: 'skills', source: 'game/skills-data/skills (card blocks)', entries: carded().map(d => {
  const c = d.card;
  return { id: d.id, name: c.name, tags: [...(c.tags || [])], ...(c.resources ? { resources: clone(c.resources) } : {}), versions: [{ version: d.version, status: 'canonical', weight: 1, data: clone(c.data) }] };
}) });

// What the UI shows of a skill (built-in or foreign): the `ui` block ({tag, glyph, color[, card_glyph, card_color,
// rest_hint]}) + the resolver facts the UI needs — trance (plays two actions), keeps_target (a Posture keeps a character
// target), attack_reach (hexes its holder's Attack reaches; 1 = contact), rest_keeps (codes that keep it standing, or null).
const uiOf = (d) => {
  const f = d.flags || {};
  return { ...clone(d.ui || {}), trance: !!f.trance, keeps_target: !!f.keepsTarget, attack_reach: Number.isInteger(f.reach) ? f.reach : 1, rest_keeps: Array.isArray(f.invincibleWhile) ? [...f.invincibleWhile] : null };
};
const freezeUi = (u) => { if (u.rest_keeps) Object.freeze(u.rest_keeps); return Object.freeze(u); };
export const SKILL_UI = Object.freeze(Object.fromEntries(DEALT.map(d => [d.id, freezeUi(uiOf(d))])));
// skillUiOf(id) → a copy of the skill's UI facts (a registered foreign skill: from its definition), or null.
export const skillUiOf = (id) => (foreignById.has(id) ? uiOf(foreignById.get(id)) : SKILL_UI[id] ? clone(SKILL_UI[id]) : null);

// The data of a skill: the caller's data/skills.json view, else the table (a foreign skill — S2 — always the table).
const sdOf = (ctx, id) => (ctx && ctx.skillData && !foreignIds.has(id)) ? ctx.skillData(id) : (SKILL_RULES[id] ? { action_type: SKILL_RULES[id].action, is_permanent: SKILL_RULES[id].permanent, point_buy_stat: SKILL_RULES[id].pointBuyStat ? (SKILL_RULES[id].pointBuyStat === 'any' ? 'any' : `stat_${SKILL_RULES[id].pointBuyStat}`) : null } : undefined);

// ---- rides (generic, no skill rules) ------------------------------------------------------------------------
// A skill rides on its action, or — for Move / Posture skills — on an Empty option (EM / EP).
export const ridesOn = (codes, req) => codes.includes(req) || ((req === 'M' || req === 'P') && (codes.includes('EP') || codes.includes('EM')));
export const ridesFor = (r) => { const codes = r.trance || [r.action]; return c => ridesOn(codes, c); };
// Does a reveal end a "rest" permanent (Sanctuary: invincible while the holder only moves or rests — ruling
// 2026-11-16)? Anything but the `keeps` codes (default: the built-ins' flags.invincibleWhile), a skill (a building's
// free skill excepted), an effect or a Rule 24 destroy emission ends it. A unit without a reveal rests.
const REST_KEEPS = Object.freeze([...(DEALT.find(d => Array.isArray(d.flags?.invincibleWhile))?.flags.invincibleWhile || [])]);
export function sanctuaryBreaks(r, keeps = REST_KEEPS) {
  if (!r) return false;
  const d = r.declared ?? r.action;
  const codes = d === 'BT' ? (r.trance || []) : [d];
  return codes.some(c => !keeps.includes(c)) || (r.skills || []).filter(id => id !== r.buildingSkill).length > 0 || !!r.effect || !!r.destroy;
}

// ---- the JS reference hooks (skill isolation, 2026-11-22) --------------------------------------------------------
// They moved to skills-data/oracle/skills-js.mjs (a TEST ORACLE in chaosD6-Skills): the game runs the definitions
// only. SKILL_ENGINE=js | shadow need the oracle installed first: installSkillOracle(<the skills-js.mjs module>).
// oracleSupport = the skill-data helper the oracle shares with the data path (never used by peer.mjs).
export const oracleSupport = Object.freeze({ sdOf });
let ORACLE = null;
export function installSkillOracle(o) {
  if (!o || typeof o.jsHook !== 'function' || !o.HOOKS) throw new Error('installSkillOracle: not the skills-js.mjs oracle');
  ORACLE = o;
}
export const skillOracle = () => ORACLE;
const needOracle = () => { if (!ORACLE) throw new Error(`SKILL_ENGINE=${SKILL_ENGINE} needs the JS oracle: call installSkillOracle() with the module skills-data/oracle/skills-js.mjs first`); return ORACLE; };   // (no dynamic-import text here: skills-repo-sync's closure scan would copy the oracle into tools/engine)
const jsHookOf = (hookName) => needOracle().HOOKS[hookName];

// ---- dispatcher -----------------------------------------------------------------------------------------
// skillHook(hookName, skillId, ctx, args) → result. `skillId` names the skill for single-skill hooks; the pass hooks
// (counter_pre, negate_action, negate_kind, trance_assign) run every built-in of the hook in the pass order
// (flags.passOrder), the folds with a null id (defend_in, block_in, …) every built-in with a program in deal order.
export const HOOK_NAMES = [...SE.HOOK_NAMES];
export function skillHook(hookName, skillId, ctx, args = {}) {
  const spec = SE.HOOK_SPECS[hookName];
  if (!spec) throw new Error(`skills.mjs: unknown hook ${hookName}`);
  // S2: a foreign skill's own program for a per-skill hook; else JS / data / shadow, then foreign skills join in.
  if (foreignIds.has(skillId) && (spec.kind === 'single') && foreignById.get(skillId).hooks[hookName] !== undefined) return dataHook(hookName, skillId, ctx, args);
  let res;
  if (SKILL_ENGINE === 'js' || spec.engine === 'js') res = jsHookOf(hookName)(skillId, ctx, args);
  else if (SKILL_ENGINE === 'data') res = dataHook(hookName, skillId, ctx, args);
  else res = shadowHook(jsHookOf(hookName), hookName, skillId, ctx, args);
  // MV: foreign pass programs run after the built-ins' pass (a second sweep over the reveals, foreign ids in order).
  if (spec.kind === 'pass') { if (foreignIds.size) dataPass(hookName, ctx, args, null, true); return res; }
  return foreignIds.size && FOLDED.has(spec.kind) ? foldForeign(spec, hookName, ctx, args, res) : res;
}

// ---- S2: engine switch, data hooks, foreign skills ------------------------------------------------------
// SKILL_ENGINE=data (default since the skill isolation): every hook marked "data" in skill-engine.mjs#HOOK_SPECS runs
// the program of the skill's definition (game/skills-data/skills/<id>.json, or SKILL_DEFS_DIR); the pass hooks
// (counter_pre, negate_action, negate_kind, trance_assign) run as edit-record programs (MV 2026-11-17, dataPass); a hook
// marked {"engine":"js","impl":"skills.mjs#…"} runs the oracle's JS hook when the oracle is installed, else its neutral
// value ("peer.mjs#…" markers: always neutral — peer.mjs does it). js: the JS reference hooks (oracle, installSkillOracle).
// shadow: both run, results (for damage_in the edited damage map + fx; for a pass every register, the reveals'
// skills / trance / vs / played and the logs) must be JSON-identical; a mismatch goes to stderr, SKILL_SHADOW_STRICT=1
// throws; the JS result is returned. SKILL_SHADOW_REPORT=1 prints a tally at exit.
const ENGINE_ENV = (typeof process !== 'undefined' && process.env) || {};
export const SKILL_ENGINE = ['js', 'shadow'].includes(ENGINE_ENV.SKILL_ENGINE) ? ENGINE_ENV.SKILL_ENGINE : 'data';
export const skillShadowStats = { compared: 0, mismatches: 0, errors: 0, byHook: {} };
const BUILTIN_IDS = new Set(SKILLS_IMPLEMENTED);
const FOLDED = new Set(['chain', 'or', 'max', 'first', 'edit']);
const oracleHook = (hookName) => (ORACLE ? ORACLE.HOOKS[hookName] : null);
// Foreign (player-branch) skills, for S4's handshake: registered by key (the ref's content key), dispatched by id
// (the last registration of an id wins). Never over a built-in. Their flags join SKILL_RULES (not SKILLS_IMPLEMENTED:
// dealing is unchanged); a foreign skill takes part in every data hook it has a program for, after the built-ins,
// foreign ids in code-unit order — so every peer that registered the same set computes the same result.
const foreignByKey = new Map(), foreignById = new Map(), foreignIds = new Set();
const defOf = (id) => foreignById.get(id) || (BUILTIN_IDS.has(id) ? BUNDLE.defs.get(id) : undefined);
const metaOf = (d) => ({ action_type: d.action_type, is_permanent: d.is_permanent, point_buy_stat: d.point_buy_stat ?? null });
// The ctx the programs' queries see (skill-engine.mjs SKILL_CTX_OPS). `own` = a definition being run directly;
// `a` = the hook's args (pass hooks: trance_assign's byActor / codeVs / attacksOn).
const wrap = (ctx, own, a = null) => ({
  c: ctx, a,
  sd: (id) => (own && id === own.id && !(ctx && ctx.skillData)) ? metaOf(own) : sdOf(ctx, id),
  flag: (id, k) => { const d = own && id === own.id ? own : defOf(id); return d ? d.flags?.[k] : SKILL_RULES[id]?.[k]; },
});
let noted = 0;
const note = (msg) => { skillShadowStats.errors++; if (noted++ < 20) console.error(`[skills] data hook: ${msg}`); };
function runOne(prog, hookName, id, ctx, args, own) {
  if (!prog) return SE.neutralOf(hookName, args);
  if (prog.js) return prog.js.impl.startsWith('skills.mjs') && oracleHook(hookName) ? oracleHook(hookName)(id, ctx, args) : SE.neutralOf(hookName, args);
  try {
    const v = SE.runHookProgram(prog, hookName, id, wrap(ctx, own), args);
    if (SE.resultOk(hookName, v)) return v;
    note(`${id} ${hookName}: bad result ${JSON.stringify(v)}`);
  } catch (e) {
    if (!(e instanceof SE.EffectEngineLimit || e instanceof SE.EffectProgramError)) throw e;   // a ctx query threw: as JS
    note(`${id} ${hookName}: ${e.message}`);
  }
  return SE.neutralOf(hookName, args);
}
const truthyJs = (v) => !!v;
function applyEdits(r, args, ctx) {
  if (!r) return;
  for (const e of r.edits) { const hit = args.damage?.get(e.victim)?.[e.i]; if (hit) hit.amount = e.amount; }
  for (const f of r.fx) ctx.skillFx.push(f);
}
function fold(spec, hookName, ids, ctx, args, acc, progFor, own) {
  for (const id of ids) {
    if (acc !== undefined && (spec.kind === 'or' || spec.kind === 'first') && truthyJs(acc)) break;
    const a = spec.kind === 'chain' && acc !== undefined ? { ...args, [spec.chain]: acc } : args;
    const r = runOne(progFor(id), hookName, id, ctx, a, own);
    acc = acc === undefined || spec.kind !== 'max' ? r : Math.max(acc, r);
  }
  return acc === undefined ? SE.neutralOf(hookName, args) : acc;
}
const hasProgram = (d, hookName) => d?.hooks?.[hookName] !== undefined && !SE.isJsMarker(d.hooks[hookName]);
function dataHook(hookName, skillId, ctx, args, own = null) {
  const spec = SE.HOOK_SPECS[hookName];
  const std = skillBundle().std;
  const progFor = (id) => SE.programOf(own && id === own.id ? own : defOf(id), hookName, std);
  if (spec.kind === 'single') return runOne(progFor(skillId), hookName, skillId, ctx, args, own);
  if (spec.kind === 'each') {
    const out = [];
    for (const id of args.skillIds || []) { const r = runOne(progFor(id), hookName, id, ctx, args, own); if (r != null) out.push(r); }
    return out;
  }
  // skillId null: every built-in with a program for the hook, in deal order (defend_in: Barricade → Sanctuary).
  if (spec.kind === 'pass') return dataPass(hookName, ctx, args, own);
  const ids = skillId != null ? [skillId] : own ? [own.id] : SKILLS_IMPLEMENTED.filter(id => hasProgram(defOf(id), hookName));
  if (spec.kind === 'edit') { for (const id of ids) applyEdits(runOne(progFor(id), hookName, id, ctx, args, own), args, ctx); return undefined; }
  return fold(spec, hookName, ids, ctx, args, undefined, progFor, own);
}
function foldForeign(spec, hookName, ctx, args, res) {
  const ids = [...foreignIds].filter(id => hasProgram(foreignById.get(id), hookName)).sort();
  if (!ids.length) return res;
  const std = skillBundle().std;
  const progFor = (id) => SE.programOf(foreignById.get(id), hookName, std);
  if (spec.kind === 'edit') { for (const id of ids) applyEdits(runOne(progFor(id), hookName, id, ctx, args, null), args, ctx); return res; }
  return fold(spec, hookName, ids, ctx, args, res, progFor, null);
}
// ---- MV 2026-11-17: pass hooks as data (ordered edit records) --------------------------------------------------
// The pass hooks (counter_pre, negate_action, negate_kind, trance_assign) edit the resolver's registers in place and a
// later skill reads the edits of an earlier one. As data: for each reveal (spec.reveals: sorted by actor | the live
// array), for each participating skill (spec.order: the JS order), the skill's program runs with root registers
// {skill, r (the live reveal), actor, phase, carry} and returns edit records (skill-engine.mjs PASS_OPS); they are
// applied in order before the next program runs, so code_is / reveal_of / foe picks see them. {op:'continue', carry}
// applies what came before it and runs the same program again (phase + 1) — Counter Spell reads its own strip / trance
// collapse back before it picks the element. A program error / limit / bad shape stops that (reveal, skill) run with
// the edits already applied (deterministic on every peer) and is counted like any data-hook error.
const MAX_PASS_PHASES = 8;
function applyPassRecord(ctx, r, rec) {
  switch (rec.op) {
    case 'set_code': ctx.effAction.set(rec.id, rec.code); break;
    case 'drop_trance': ctx.tranceOpts.delete(rec.id); break;
    case 'replace': ctx.replace(rec.id, rec.from, rec.to); break;
    case 'skills': { const o = ctx.byActorPre.get(rec.id); if (o) o.skills = [...rec.skills]; break; }
    case 'fx': ctx.skillFx.push(rec.fx); break;
    case 'no_move': ctx.noMove.add(rec.id); break;
    case 'no_emit': if (ctx.noEmit) ctx.noEmit.add(rec.id); break;
    case 'swap': if (ctx.swaps) ctx.swaps.push({ by: rec.by, on: rec.on }); break;
    case 'trance_collapse': { ctx.effAction.set(rec.id, rec.code); ctx.tranceOpts.delete(rec.id); const o = ctx.byActorPre.get(rec.id); if (o) o.trance = null; break; }
    case 'pen': { const pen = ctx.counterPen.get(rec.id) || {}; pen[rec.elem] = (pen[rec.elem] || 0) + rec.amount; ctx.counterPen.set(rec.id, pen); break; }
    case 'log': ctx.log(rec.text); break;
    case 'trance': r.vs = new Map(rec.vs); r.played = new Set(rec.played); break;
    default: break;
  }
}
function runPassProgram(prog, hookName, id, ctx, args, r, own) {
  let carry = null;
  for (let phase = 0; phase < MAX_PASS_PHASES; phase++) {
    let recs;
    try { recs = SE.runHookProgram(prog, hookName, id, wrap(ctx, own, args), { r, actor: r.actor, phase, carry }); } catch (e) {
      if (!(e instanceof SE.EffectEngineLimit || e instanceof SE.EffectProgramError)) throw e;   // a ctx query threw: as JS
      note(`${id} ${hookName}: ${e.message}`); return;
    }
    if (!SE.resultOk(hookName, recs)) { note(`${id} ${hookName}: bad result ${JSON.stringify(recs)?.slice(0, 200)}`); return; }
    let next = null;
    for (const rec of recs) { if (rec.op === 'continue') { next = rec; break; } applyPassRecord(ctx, r, rec); }
    if (!next) return;
    carry = next.carry ?? null;
  }
  note(`${id} ${hookName}: more than ${MAX_PASS_PHASES} phases`);
}
// dataPass(hook, ctx, args[, own][, foreignOnly]) — the built-ins of spec.order (flags.passOrder) with a program (a
// built-in still marked {"engine":"js"} makes the whole pass the oracle's JS hook when the oracle is installed; without
// it the marked skill sits the pass out), or one definition (`own`), or the registered foreign skills.
function dataPass(hookName, ctx, args = {}, own = null, foreignOnly = false) {
  const spec = SE.HOOK_SPECS[hookName];
  const std = skillBundle().std;
  let ids;
  if (own) ids = [own.id];
  else if (foreignOnly) ids = [...foreignIds].filter(id => hasProgram(foreignById.get(id), hookName)).sort();
  else {
    if (oracleHook(hookName) && spec.order.some(id => SE.isJsMarker(defOf(id)?.hooks?.[hookName]))) return oracleHook(hookName)(null, ctx, args);
    ids = spec.order.filter(id => hasProgram(defOf(id), hookName));
  }
  if (!ids.length) return undefined;
  const progs = ids.map(id => [id, SE.programOf(own && id === own.id ? own : (foreignOnly ? foreignById.get(id) : defOf(id)), hookName, std)]);
  const revs = spec.reveals === 'sorted' ? [...ctx.reveals].sort((a, b) => a.actor.localeCompare(b.actor)) : ctx.reveals;
  for (const r of revs) for (const [id, prog] of progs) if (prog && !prog.js) runPassProgram(prog, hookName, id, ctx, args, r, own);
  return undefined;
}
// passHookData(hook, ctx, args) — the built-ins' data pass alone (checks: tools/skill-engine-check.mjs section 2b).
export const passHookData = (hookName, ctx, args = {}) => dataPass(hookName, ctx, args);
// Shadow of a pass: data first on the real registers (logs held back), snapshot, restore the registers in place, then the
// JS hook on them — the JS edits are what stays. Compared: every register + the reveals' skills / trance / vs / played + logs.
function passSnap(ctx) {
  return {
    e: [...ctx.effAction], t: [...ctx.tranceOpts].map(([k, v]) => [k, [...v]]), n: [...ctx.noMove], ne: ctx.noEmit ? [...ctx.noEmit] : null,
    sw: ctx.swaps ? ctx.swaps.map(s => ({ ...s })) : null, c: [...ctx.counterPen].map(([k, v]) => [k, { ...v }]), fx: ctx.skillFx.length,
    r: ctx.reveals.map(r => ['skills', 'trance', 'vs', 'played'].map(k => [k, Object.prototype.hasOwnProperty.call(r, k), r[k]])),
  };
}
function passRestore(ctx, s) {
  ctx.effAction.clear(); for (const [k, v] of s.e) ctx.effAction.set(k, v);
  ctx.tranceOpts.clear(); for (const [k, v] of s.t) ctx.tranceOpts.set(k, [...v]);
  ctx.noMove.clear(); for (const k of s.n) ctx.noMove.add(k);
  if (ctx.noEmit) { ctx.noEmit.clear(); for (const k of s.ne || []) ctx.noEmit.add(k); }
  if (ctx.swaps) { ctx.swaps.length = 0; for (const x of s.sw || []) ctx.swaps.push({ ...x }); }
  ctx.counterPen.clear(); for (const [k, v] of s.c) ctx.counterPen.set(k, { ...v });
  ctx.skillFx.length = s.fx;
  ctx.reveals.forEach((r, i) => { for (const [k, had, v] of s.r[i]) { if (had) r[k] = v; else delete r[k]; } });
}
const passKey = (ctx, n0, logs) => JSON.stringify([[...ctx.effAction], [...ctx.tranceOpts], [...ctx.noMove], ctx.noEmit ? [...ctx.noEmit] : null, ctx.swaps || null,
  [...ctx.counterPen], ctx.skillFx.slice(n0), ctx.reveals.map(r => [r.actor, r.skills ?? null, r.trance ?? null, r.vs ? [...r.vs] : null, r.played ? [...r.played] : null]), logs]);
function shadowPass(h, hookName, skillId, ctx, args) {
  const s0 = passSnap(ctx), logsD = [], logsJ = [];
  let got;
  try { dataHook(hookName, skillId, { ...ctx, log: (...a) => logsD.push(a.join(' ')) }, args); got = passKey(ctx, s0.fx, logsD); } catch (e) { got = `throws ${e?.message}`; }
  passRestore(ctx, s0);
  const js = h(skillId, { ...ctx, log: (...a) => { logsJ.push(a.join(' ')); ctx.log(...a); } }, args);
  return { js, want: passKey(ctx, s0.fx, logsJ), got };
}
function shadowHook(h, hookName, skillId, ctx, args) {
  let want, got, js;
  if (SE.HOOK_SPECS[hookName].kind === 'pass') ({ js, want, got } = shadowPass(h, hookName, skillId, ctx, args));
  else if (SE.HOOK_SPECS[hookName].kind === 'edit') {
    // data first, on copies of the damage map and skillFx (it edits them); then JS on the real ones
    const pre = JSON.stringify([...(args.damage || [])]), n0 = ctx.skillFx.length;
    const dmg = new Map(JSON.parse(pre)), cCopy = { ...ctx, skillFx: [] };
    try { dataHook(hookName, skillId, cCopy, { ...args, damage: dmg }); got = JSON.stringify([[...dmg], cCopy.skillFx]); } catch (e) { got = `throws ${e?.message}`; }
    js = h(skillId, ctx, args);
    want = JSON.stringify([[...args.damage], ctx.skillFx.slice(n0)]);
  } else {
    js = h(skillId, ctx, args);
    want = JSON.stringify(js);
    try { got = JSON.stringify(dataHook(hookName, skillId, ctx, args)); } catch (e) { got = `throws ${e?.message}`; }
  }
  skillShadowStats.compared++;
  skillShadowStats.byHook[hookName] = (skillShadowStats.byHook[hookName] || 0) + 1;
  if (got !== want) {
    skillShadowStats.mismatches++;
    console.error(`[skills] SHADOW MISMATCH ${hookName} ${skillId}\n  js:   ${want}\n  data: ${got}`);
    if (ENGINE_ENV.SKILL_SHADOW_STRICT === '1') throw new Error(`skills shadow mismatch in ${hookName} (${skillId})`);
  }
  return js;
}
if (SKILL_ENGINE !== 'js' && ENGINE_ENV.SKILL_SHADOW_REPORT === '1') process.on('exit', () => console.log(`[skills] ${SKILL_ENGINE}: ${BUNDLE.defs.size} data skills; shadow compared ${skillShadowStats.compared}, mismatches ${skillShadowStats.mismatches}, errors ${skillShadowStats.errors} ${JSON.stringify(skillShadowStats.byHook)}`));

// validateSkillDef(def, {libs, libMap}) → [errors] — a definition file (chaosd6.skill/1 | /2). JS markers, and the
// /2 built-in requirements (deal_order, card, ui, flags.passOrder for a pass program), only for built-ins.
export function validateSkillDef(def, opts = {}) {
  return SE.validateSkillDef(def, { ...opts, builtin: BUILTIN_IDS.has(def?.id) && !foreignIds.has(def?.id) });
}
const prepared = new WeakMap();
// resolveSkillProgram(def, hookName, ctx, args) → what skillHook(hookName, def.id, ctx, args) returns when only
// this definition plays the hook (no other built-in, no foreign skill): its program, else the std default, else
// the hook's neutral value. Pass hooks: a built-in's JS hook ({engine: 'js'} marker, oracle installed), else undefined. damage_in
// edits args.damage / ctx.skillFx in place like the JS hook. An invalid definition throws.
export function resolveSkillProgram(def, hookName, ctx, args = {}) {
  const spec = SE.HOOK_SPECS[hookName];
  if (!spec) throw new Error(`skills.mjs: unknown hook ${hookName}`);
  let own = def.$subs ? def : prepared.get(def);
  if (!own) {
    const errs = validateSkillDef(def);
    if (errs.length) throw new Error(`skill ${def?.id}: ${errs.join('; ')}`);
    own = SE.bindSkillDef(JSON.parse(JSON.stringify(def)));
    prepared.set(def, own);
  }
  if (spec.kind === 'pass') {
    const m = own.hooks?.[hookName];
    if (SE.isJsMarker(m)) return BUILTIN_IDS.has(own.id) && m.impl.startsWith('skills.mjs') && oracleHook(hookName) ? oracleHook(hookName)(own.id, ctx, args) : undefined;
    return m !== undefined ? dataPass(hookName, ctx, args, own) : undefined;   // MV: its pass program alone (edit records)
  }
  return dataHook(hookName, spec.kind === 'each' ? null : own.id, ctx, args, own);
}
// registerForeignSkill(key, id, flags, hooks[, {meta, uses, libs, name, version}]) → the bound definition.
// flags: SKILL_RULES-style (action, permanent, pointBuyStat, negating, keepsTarget, …) and/or validator keys;
// hooks: {hookName: program} — data hooks only; a pass program (edit records) runs after the built-ins' pass (MV).
// Throws on a built-in id or an invalid definition.
export function registerForeignSkill(key, id, flags, hooks, opts = {}) {
  if (BUILTIN_IDS.has(id)) throw new Error(`registerForeignSkill: ${id} is a built-in skill`);
  const f = { ...(flags || {}) }, meta = opts.meta || {};
  const pbs = f.pointBuyStat ? (f.pointBuyStat === 'any' ? 'any' : `stat_${String(f.pointBuyStat).replace(/^stat_/, '')}`) : null;
  const def = {
    schema: SE.SKILL_SCHEMA_ID, id, name: opts.name || id, version: opts.version || '0.0.0',
    action_type: meta.action_type ?? f.action, is_permanent: meta.is_permanent ?? !!f.permanent,
    point_buy_stat: meta.point_buy_stat !== undefined ? meta.point_buy_stat : pbs,
    flags: f, uses: opts.uses || [SE.STD_LIB_ID], hooks: JSON.parse(JSON.stringify(hooks || {})),
  };
  const libs = opts.libs || SE.defaultLibs();
  const errs = SE.validateSkillDef(def, { libs, builtin: false });
  if (errs.length) throw new Error(`registerForeignSkill ${id}: ${errs.join('; ')}`);
  SE.bindSkillDef(def, libs);
  foreignByKey.set(key, def); foreignById.set(id, def); foreignIds.add(id);
  SKILL_RULES[id] = { action: def.action_type, permanent: def.is_permanent, ...(def.is_permanent ? { pointBuyStat: def.point_buy_stat === 'any' ? 'any' : def.point_buy_stat.replace(/^stat_/, '') } : {}), ...f };
  if (SKILL_RULES[id].negating) NEGATING_SKILLS.add(id); else NEGATING_SKILLS.delete(id);
  return def;
}
export const isForeignSkillId = (id) => foreignIds.has(id);
export const foreignSkillDef = (keyOrId) => foreignByKey.get(keyOrId) || foreignById.get(keyOrId) || null;
// Tests only: forget every foreign skill.
export function clearForeignSkills() {
  for (const id of foreignIds) { delete SKILL_RULES[id]; NEGATING_SKILLS.delete(id); }
  foreignByKey.clear(); foreignById.clear(); foreignIds.clear();
}
