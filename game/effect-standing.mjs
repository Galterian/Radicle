// game/effect-standing.mjs — what a PERMANENT does while it stands (effect isolation F2, 2026-11-21).
//
// The cast of an effect is its `logic` (effect-engine.mjs). What the card does afterwards, while it stands in front of
// its holder's deck, used to be code keyed on the effect id in peer.mjs (Inner Fire, Super Sense, Disable, Delay Time,
// Empower, Sleep, Confusion). Since F2 it is the definition's `standing` block (schema chaosd6.effect/2): hook name →
// program. peer.mjs asks the hook at a fixed point of the round for every permanent a unit holds that answers it, and
// applies the (shape-checked) result with generic code — no effect id appears there.
//
// Hooks (the holder is the unit whose permanent answers; `every` = the permanent was cast doubled, Rule 23 ∀):
//   combat_out     {holder, code, dmg, every}                 → number: the holder's combat damage of one strike
//   damage_in      {holder, attacker, amount, source, every}  → {amount, spend}: damage about to land on the holder;
//                  asked once per action per holder and permanent, on the first damage > 0; spend = the permanent is
//                  used up (dropped by its holder after the run)
//   cast_in        {holder, caster, effect_id, last_elem, every} → null | {bar: caster|all, elem, spend}: an enemy cast
//                  about to hurt the holder; a result stops it (status blocked) and bars `elem` to the caster (all:
//                  to everyone) for the turn; once per action per holder
//   adjacent_lost  {holder, victim, every}                    → integer: actions the planning victim, an adjacent enemy,
//                  loses from the end of its turn (summed over the holders, judged by the victim when it plans)
//   plan_emit      {holder, step, of, every}                  → {extra, spend}: the holder's own cast plan — `extra` more
//                  elements go out this action (step < of)
//   harm_in        {holder, caster, effect_id, every}        → null | {negate, spend}: an enemy effect is about to touch
//                  the holder (damage, lock, penalty, forced move, possession, hand peek) — negate: the part that
//                  touches the holder is dropped; spend: 'every' = the ∀ copy is used up, 'perm' = the permanent; once
//                  per action per holder (F3)
//   breaks         {holder, self, plays, dealt_damage, every, extra_codes} → bool: the permanent falls because of what its
//                  holder played this action (plays: [{action, trance, effect_id}]; dealt_damage only after the run;
//                  extra_codes = class codes that also count, e.g. a Reaver's EP / EM). While a permanent with flag
//                  `hides` stands and does not break, its holder is hidden from enemies (F3)
//   afflicted      {holder, victim, in_contact, every}        → {no_cast, only}: an affliction this effect laid on the
//                  victim (a sprung perm trap) — no casting / only this action code (EP) while it holds
// Programs see the args as root registers and the read-only queries below; their VALUE is the result. A program that
// fails (op budget, depth, a program error, a bad shape) answers the neutral value and is tallied (standingStats).
//
// Engine switch: EFFECT_STANDING_ENGINE=data (default) | js | shadow, else EFFECT_ENGINE's value. js = STANDING_JS of
// effects-data/oracle/standing-js.mjs, the reference the built-in programs were checked against (test oracle, F9e).
import { runProgram, EffectEngineLimit, EffectProgramError, STANDING_HOOK_NAMES, STANDING_CTX_OPS, STANDING_DENY } from './effect-engine.mjs';
export { STANDING_HOOK_NAMES, STANDING_CTX_OPS, STANDING_DENY };

export const STANDING_LIMITS = Object.freeze({ maxOps: 20000, maxDepth: 48, maxRange: 64 });
const isInt = (x) => Number.isInteger(x);
const bool = (x) => typeof x === 'boolean';
export const STANDING_HOOKS = Object.freeze({
  combat_out:    { args: ['holder', 'code', 'dmg', 'every'], ok: (v) => isInt(v) && v >= 0 && v <= 20, neutral: (a) => a.dmg },
  damage_in:     { args: ['holder', 'attacker', 'amount', 'source', 'every'], ok: (v) => !!v && isInt(v.amount) && v.amount >= 0 && bool(v.spend), neutral: (a) => ({ amount: a.amount, spend: false }) },
  cast_in:       { args: ['holder', 'caster', 'effect_id', 'last_elem', 'every'], ok: (v) => v === null || (!!v && ['caster', 'all'].includes(v.bar) && typeof v.elem === 'string' && bool(v.spend)), neutral: () => null },
  adjacent_lost: { args: ['holder', 'victim', 'every'], ok: (v) => isInt(v) && v >= 0 && v <= 3, neutral: () => 0 },
  plan_emit:     { args: ['holder', 'step', 'of', 'every'], ok: (v) => !!v && isInt(v.extra) && v.extra >= 0 && v.extra <= 3 && bool(v.spend), neutral: () => ({ extra: 0, spend: false }) },
  afflicted:     { args: ['holder', 'victim', 'in_contact', 'every'], ok: (v) => !!v && bool(v.no_cast) && (v.only === null || v.only === 'EP'), neutral: () => ({ no_cast: false, only: null }) },
  harm_in:       { args: ['holder', 'caster', 'effect_id', 'every'], ok: (v) => v === null || (!!v && v.negate === true && [null, 'every', 'perm'].includes(v.spend)), neutral: () => null },
  breaks:        { args: ['holder', 'self', 'plays', 'dealt_damage', 'every', 'extra_codes'], ok: bool, neutral: () => false },
});
if (JSON.stringify(Object.keys(STANDING_HOOKS)) !== JSON.stringify(STANDING_HOOK_NAMES)) throw new Error('effect-standing.mjs: STANDING_HOOKS ≠ effect-engine.mjs STANDING_HOOK_NAMES');

// ---- engine ------------------------------------------------------------------------------------------------------
const ENV = (typeof process !== 'undefined' && process.env) || {};
const pick = (x) => (['js', 'data', 'shadow'].includes(x) ? x : null);
export const STANDING_ENGINE = pick(ENV.EFFECT_STANDING_ENGINE) || pick(ENV.EFFECT_ENGINE) || 'data';
// F9e: the JS reference (test oracle) — loaded only when a JS engine is asked for.
const STANDING_JS = STANDING_ENGINE === 'data' ? {} : (await import('./effects-data/oracle/standing-js.mjs')).STANDING_JS;
export const standingStats = { calls: 0, compared: 0, mismatches: 0, errors: 0, byHook: {} };
let noted = 0;
const note = (msg) => { standingStats.errors++; if (noted++ < 20) console.error(`[effect-standing] ${msg}`); };

// A source of standing programs: (effectId) → definition | null, and (effectId) → is it a foreign (player-branch) effect.
// effects.mjs installs both (built-ins + registered foreign effects). A foreign effect always runs as data (no reference).
let defOf = () => null, isForeign = () => false;
export function installStandingSource(fn, foreign = () => false) { defOf = typeof fn === 'function' ? fn : () => null; isForeign = typeof foreign === 'function' ? foreign : () => false; }
// answers(effectId, hook) → does this effect's permanent act at that hook (data: its definition; js: the reference)
export function answers(effectId, hook) {
  if (STANDING_ENGINE === 'js' && !isForeign(effectId)) return !!STANDING_JS[effectId]?.[hook];
  return !!defOf(effectId)?.standing?.[hook];
}
function dataAnswer(hook, effectId, ctx, args) {
  const def = defOf(effectId), prog = def?.standing?.[hook];
  const spec = STANDING_HOOKS[hook];
  if (!prog) return spec.neutral(args);
  try {
    const v = runProgram(prog, def.$subs, ctx || {}, { ...args }, { ctxOps: STANDING_CTX_OPS, deny: STANDING_DENY, limits: STANDING_LIMITS });
    if (spec.ok(v)) return v;
    note(`${effectId} ${hook}: bad result ${JSON.stringify(v)?.slice(0, 200)}`);
  } catch (e) {
    if (!(e instanceof EffectEngineLimit || e instanceof EffectProgramError)) throw e;   // a ctx query threw: propagate
    note(`${effectId} ${hook}: ${e.message}`);
  }
  return spec.neutral(args);
}
const jsAnswer = (hook, effectId, ctx, args) => { const f = STANDING_JS[effectId]?.[hook]; return f ? f(args, ctx) : STANDING_HOOKS[hook].neutral(args); };
// standing(hook, effectId, ctx, args) → the hook result for one permanent (neutral if it does not answer).
export function standing(hook, effectId, ctx, args) {
  if (!STANDING_HOOKS[hook]) throw new Error(`effect-standing.mjs: unknown hook ${hook}`);
  standingStats.calls++;
  if (STANDING_ENGINE === 'data' || isForeign(effectId)) return dataAnswer(hook, effectId, ctx, args);
  if (STANDING_ENGINE === 'js') return jsAnswer(hook, effectId, ctx, args);
  const want = jsAnswer(hook, effectId, ctx, args);
  let got;
  try { got = JSON.stringify(dataAnswer(hook, effectId, ctx, args)); } catch (e) { got = `throws ${e?.message}`; }
  standingStats.compared++;
  standingStats.byHook[hook] = (standingStats.byHook[hook] || 0) + 1;
  if (got !== JSON.stringify(want)) {
    standingStats.mismatches++;
    console.error(`[effect-standing] SHADOW MISMATCH ${effectId} ${hook}\n  js:   ${JSON.stringify(want)}\n  data: ${got}`);
    if (ENV.EFFECT_SHADOW_STRICT === '1' || ENV.EFFECT_STANDING_SHADOW_STRICT === '1') throw new Error(`effect-standing shadow mismatch in ${effectId} ${hook}`);
  }
  return want;
}
// holding(permIds, hook) → the held permanents that answer `hook`, in code-unit id order (every peer the same).
export const holding = (permIds, hook) => [...new Set(permIds || [])].filter(id => answers(id, hook)).sort();
if (STANDING_ENGINE !== 'data' && (ENV.EFFECT_SHADOW_REPORT === '1' || ENV.EFFECT_STANDING_SHADOW_REPORT === '1')) {
  process.on('exit', () => console.log(`[effect-standing] ${STANDING_ENGINE}: calls ${standingStats.calls}, compared ${standingStats.compared}, mismatches ${standingStats.mismatches}, errors ${standingStats.errors} ${JSON.stringify(standingStats.byHook)}`));
}
