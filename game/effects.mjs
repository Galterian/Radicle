import { installStandingSource } from './effect-standing.mjs';
import { installNaturalKinds } from './natural-perms.mjs';
import { pickTileTokenElem } from './effect-prims.mjs';
// Effect engine front (Rules 18–21 + the pc overrides). Pure: everything it needs comes in through `ctx`, everything it
// decides goes out as an outcome the resolver applies — re-runnable for the Rule 8 counterfactuals, checkable from
// tools/effects-check.mjs with the worked examples. Effect isolation F9e: the primitives live in effect-prims.mjs
// (re-exported here), the JS reference engine in effects-data/oracle/effects-js.mjs (a test oracle, loaded only by
// EFFECT_ENGINE=js | shadow); this module names no effect.
export { diceCount, rollDice, pointBuy, pointBuyPermanent, pointBuyPermanentMin, roundHalfUp10, TRAP_POWER, FEATURES, ALL_ELEMS, trapDamageSum,
  pickBySalt, pickHandDiscards, placeStatBonusToken, RULE24_KIND_RANK, rule24Order, pickTileTokenElem } from './effect-prims.mjs';

// Effects a character deck may hold: everything with rules, minus creature-innate ones.
export function playableEffects(dataEffects) {
  return Object.keys(EFFECT_RULES).filter(id => dataEffects[id] && dataEffects[id].data?.in_player_deck !== false);
}

// ctx: { me, elemStat(el)→stat key, statFor(id, el), baseStat(id, statKey), lifeOf(id), enemyOf(a,b),
//        dist(a,b), tileOf(id)→{q,r}|null, isFree(q,r), neighbours(q,r), hasPerm(id, perm),
//        shieldedAgainst(id, el), disabledElems(id)→Set, invisible(id), peers()→[ids], sha(seed), actionIndex }
// cast: { actor, effect_id, elements, salt, target: {kind, ref}|null, is_instant, every (∀ double cast), aura (through an Aura ∀),
//         step, of, kept: [die|null per element] } — point-buy damage rolls one element per emission (Rule 20 pc override):
//         the element emitted this step is bought now; a failed roll re-emits that element next action ('retry'), good dice
//         stay banked in `kept`; a cast still emitting returns status 'casting' with the updated bank.
//
// Engine switch (chaosD6-Effects E1; default data since effect isolation F1, 2026-11-21): EFFECT_ENGINE=data | js | shadow.
//   data   → an effect with a definition in game/effects-data/effects/<id>.json (or EFFECT_DEFS_DIR) runs on
//            effect-engine.mjs#resolveEffectData; an effect without one has no rules (fizzles).
//   js     → the JS reference engine (effects-data/oracle/effects-js.mjs resolveEffectJs + EFFECT_RULES_JS) — test oracle.
//   shadow → both engines run; any outcome difference (JSON-identical comparison) is logged, thrown with
//            EFFECT_SHADOW_STRICT=1; the JS outcome is returned. EFFECT_SHADOW_REPORT=1 prints a tally at exit.
const ENGINE_ENV = (typeof process !== 'undefined' && process.env) || {};
export const EFFECT_ENGINE = ['js', 'shadow'].includes(ENGINE_ENV.EFFECT_ENGINE) ? ENGINE_ENV.EFFECT_ENGINE : 'data';
// F9e: the JS reference engine (test oracle) — loaded only when a JS engine is asked for.
const ORACLE = EFFECT_ENGINE === 'data' ? null : await import('./effects-data/oracle/effects-js.mjs');
const resolveEffectJs = (ctx, cast) => ORACLE.resolveEffectJs(ctx, cast);
const dataEngine = await import('./effect-engine.mjs').then(m => ({ m, defs: m.loadEffectDefs() }));
// The flags the resolver, UI and bots read = the definitions' `flags`, keyed in id order (+ registered foreign ids).
export const EFFECT_RULES = Object.fromEntries([...dataEngine.defs.keys()].sort().map(id => [id, JSON.parse(JSON.stringify(dataEngine.defs.get(id).flags || {}))]));
// = resolveEffectJs's outcome for an effect without rules (key order included: the outcome is hashed downstream).
// F8: the definitions' `bot` (monster deck themes, npc casting hints) and `ui` blocks — id → block (built-ins only).
export const EFFECT_BOT = Object.freeze(Object.fromEntries([...dataEngine.defs.keys()].sort().filter(id => dataEngine.defs.get(id).bot).map(id => [id, Object.freeze(JSON.parse(JSON.stringify(dataEngine.defs.get(id).bot)))])));
export const EFFECT_UI = Object.freeze(Object.fromEntries([...dataEngine.defs.keys()].sort().filter(id => dataEngine.defs.get(id).ui).map(id => [id, Object.freeze(JSON.parse(JSON.stringify(dataEngine.defs.get(id).ui)))])));
// Flags read by the peer that used to be effect-id tables (F9e): tileTokenChoice (Fossilization's Earth OR Vitality
// bonus token — the cast's elem picks it) and tokenRetryKeeps (user ruling 2026-11-18: a failed tile / shield token
// roll keeps the lock and the tokens bought; the peer re-emits the last element next action for the owed ones).
export const TILE_TOKEN_CHOICE = new Proxy({}, { get: (_, id) => (typeof id === 'string' ? EFFECT_RULES[id]?.tileTokenChoice : undefined) });
export const tokenRetryOwed = (effectId, oc) => !!EFFECT_RULES[effectId]?.tokenRetryKeeps && oc?.status === 'done' && Array.isArray(oc.kept) && oc.kept.some(v => v == null);
export const tileTokenElem = (cast, el, myStat) => pickTileTokenElem(EFFECT_RULES[cast?.effect_id]?.tileTokenChoice, cast, el, myStat);
// F9: the cards = the definitions' `card` blocks (data/effects.json is retired for effects). builtinEffectEntries() →
// { id: {id, name, tags, data} } in id order — the shape peer.mjs pickActive gave data.effects; builtinEffectCatalog()
// → a data/effects.json-shaped collection (one canonical version per effect, + resources) for the browser / Godot.
const cardIds = () => [...dataEngine.defs.keys()].sort().filter(id => dataEngine.defs.get(id).card);
export const builtinEffectEntries = () => Object.fromEntries(cardIds().map(id => { const c = dataEngine.defs.get(id).card; return [id, { id, name: c.name, tags: [...(c.tags || [])], data: JSON.parse(JSON.stringify(c.data)) }]; }));
export const builtinEffectCatalog = () => ({ collection: 'effects', source: 'game/effects-data/effects (card blocks)', entries: cardIds().map(id => {
  const d = dataEngine.defs.get(id), c = d.card;
  return { id, name: c.name, tags: [...(c.tags || [])], ...(c.resources ? { resources: JSON.parse(JSON.stringify(c.resources)) } : {}), versions: [{ version: d.version, status: 'canonical', weight: 1, data: JSON.parse(JSON.stringify(c.data)) }] };
}) });
export function noRulesOutcome() {
  return { status: 'fizzled', hits: [], tokens: [], statTokens: [], locks: [], zones: [], heals: [], permanents: [], moves: [], shieldElem: null, disableElem: null, voidFor: [], draw: 0, every: false, kept: null, summon: null, channels: [], traps: [], obstacles: [], links: [], pulls: [], relocations: [], peeks: [], possess: null, phantom: false, notes: ['no rules for this effect'], rolls: [] };
}
export const shadowStats = { compared: 0, mismatches: 0, byEffect: {} };
if (dataEngine && ENGINE_ENV.EFFECT_SHADOW_REPORT === '1') process.on('exit', () => console.log(`[effects] ${EFFECT_ENGINE}: ${dataEngine.defs.size} data effects; shadow compared ${shadowStats.compared}, mismatches ${shadowStats.mismatches} ${JSON.stringify(shadowStats.byEffect)}`));
// Foreign (player-branch) effects, E4 (effects-handshake.mjs): a cast whose reveal carried a ref runs the
// pinned definition (`cast.fx.key` = fxKey: effect sha + lib shas) on every peer, whatever EFFECT_ENGINE says.
// A foreign id is added to EFFECT_RULES (flags only, never over a built-in) so peer.mjs / bots read its
// metadata; it is never in playableEffects (data.effects lacks it), so dealing / library picks are unchanged.
// A foreign id cast WITHOUT a ref (bonus plan, channel tick) resolves as "no rules" — the same outcome a peer
// that never learned it computes.
const foreignRuns = new Map();          // fxKey -> (ctx, cast) => outcome
const foreignIds = new Set();           // ids registered by registerForeignEffect (not built-in)
const foreignDefs = new Map();          // foreign id -> its bound definition (standing programs, F2)
export function registerForeignEffect(key, id, flags, run, def = null) {
  foreignRuns.set(key, run);
  if (!EFFECT_RULES[id]) { EFFECT_RULES[id] = { ...(flags || {}) }; foreignIds.add(id); if (def) foreignDefs.set(id, def); }
}
// F2: the standing programs (what a permanent does while it stands) come from the same definitions.
installStandingSource((id) => dataEngine.defs.get(id) || foreignDefs.get(id) || null, (id) => foreignIds.has(id));
// F7: a monster's natural permanent acts by its definition's flag naturalKind (natural-perms.mjs primitives).
installNaturalKinds((id) => EFFECT_RULES[id]?.naturalKind || null);
export const isForeignEffectId = (id) => foreignIds.has(id);
export function resolveEffect(ctx, cast) {
  if (cast?.fx || foreignIds.has(cast?.effect_id)) {
    const run = cast?.fx ? foreignRuns.get(cast.fx.key) : null;
    return run ? run(ctx, cast) : noRulesOutcome();
  }
  if (EFFECT_ENGINE === 'js') return resolveEffectJs(ctx, cast);
  const def = dataEngine.defs.get(cast?.effect_id);
  if (!def) return noRulesOutcome();
  if (EFFECT_ENGINE === 'data') return dataEngine.m.resolveEffectData(def, ctx, cast);
  const js = resolveEffectJs(ctx, cast);
  let got;
  try { got = JSON.stringify(dataEngine.m.resolveEffectData(def, ctx, cast)); } catch (e) { got = `throws ${e?.message}`; }
  const want = JSON.stringify(js);
  shadowStats.compared++;
  shadowStats.byEffect[cast.effect_id] = (shadowStats.byEffect[cast.effect_id] || 0) + 1;
  if (got !== want) {
    shadowStats.mismatches++;
    console.error(`[effects] SHADOW MISMATCH ${cast.effect_id}\n  js:   ${want}\n  data: ${got}`);
    if (ENGINE_ENV.EFFECT_SHADOW_STRICT === '1') throw new Error(`shadow mismatch on ${cast.effect_id}`);
  }
  return js;
}
