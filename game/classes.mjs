// game/classes.mjs — PURE class rules (chaosD6-Classes milestone C1, user request 2026-11-16: "Now do the same
// split for the CLASSES as well. Make a new repo chaosD6-Classes and extract there the skills as jsonlogic and the
// tools and validator").
//
// The 33 classes of data/classes.json live inline in peer.mjs (class setup ~l.1015, planning ~l.2850, simulate()
// pre-pass / Rule 24 / post-pass / trap steps, doResolution application, endRound) plus the pure helper modules
// class-traps.mjs, class-manipulator.mjs, class-chase.mjs, class-world.mjs. This module holds their RULE logic as a
// `CLASS_RULES` table (the flags peer.mjs / bots / UI read, like skills.mjs#SKILL_RULES) plus hook functions
// dispatched by `classHook(hookName, classId, ctx, args)`. No peer globals: every hook works on what the caller
// passes in (snapshots, reveals, ids, numbers) and returns a value / a record of what to apply — peer.mjs keeps the
// plumbing (entity writes, card moves, UI notices). Hook inventory, inputs / outputs, call sites: classes-data/HOOKS.md.
// C2 (same file): the hooks as JsonLogic data (classes-data/classes/<id>.json, engine class-engine.mjs, schema
// classes-data/SCHEMA.md); CLASS_ENGINE=data (default) | js | shadow picks who answers classHook (bottom of file).
//
// P1 status (2026-11-16): this module is NOT wired into peer.mjs yet (P2, `C1`-tagged hunks). tools/classes-check.mjs
// proves every hook against a verbatim copy of the inline peer.mjs code; tools/class-engine-check.mjs proves the
// JsonLogic definitions against these hooks.
//
// Resolver ctx (`clCtx`) — fields a hook may read (all optional unless the hook needs them):
//   self, label                          my peer id, PEER_LABEL
//   view(id), viewIds(), viewValues()    snapshot of one unit / [...view.keys()] / [...view.values()] (view order)
//   lifeOf(id), dist(a, b)               life as the resolver sees it; hex distance of the snapshot tiles (Infinity if unknown)
//   enemyOf(a, b), hasPerm(id, p)        hostility; permanents (snapshot / entity)
//   statOf(id, stat)                     effective stat (tokens / penalties folded in)
//   sideOf(alliance)                     'A' | 'B' | 'C' | …
//   classData(id)                        the active data/classes.json version's `data` (or undefined)
//   skillAction(skillId)                 data/skills.json action_type of a skill (Bard)
//   library()                            [{effect_id, elements}] — the Library (Alchemist)
//   turn, action                         hg.turn, hg.action
//   sha(s)                               sha256 hex (peer.mjs sha256Hex)
import * as CE from './class-engine.mjs';   // C2 data hooks (pure; loads classes-data/ only when used)
import { pointBuy } from './effect-engine.mjs';   // byte-identical to effects.mjs#pointBuy (tools/effect-engine-check.mjs)
import { rogueConfig, clericConfig, rogueShared } from './class-traps.mjs';
import { manipulatorConfig, combatHit, attackHit, pickManipTarget } from './class-manipulator.mjs';
import { avengerConfig, prophetConfig, isWildMonster, lureTargets, chaseBonusStep, prophetPick } from './class-chase.mjs';
import { animatorConfig, priestConfig, seekerConfig } from './class-world.mjs';
import { unionOf } from './class-state.mjs';   // phase 2: the generic class-state blob (snapshot class_state_json)

export const STATS = ['vitality', 'world', 'matter', 'will'];
export const TRAP_POWER = 20;          // = effects.mjs TRAP_POWER (tools/classes-check.mjs asserts it)
export const STRIKE_DIE = 6;           // a class colour falls to a die of 6 (user ruling 2026-10-30)
export const ILLUSION_RANGE = 10;      // Illusionist: allies within 10 hexes (user ruling 2026-11-12)
export const TRANCE = 'skill_battle_trance';
// = peer.mjs ELEM_TO_STAT (data/elements.json stat of each element) — used when the ctx has no elemStat.
export const ELEM_TO_STAT = Object.freeze({ elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' });

// Flags per class = the `flags` of its definition (class isolation phase 1, 2026-11-20: the definitions in
// game/classes-data/classes/*.json — or CLASS_DEFS_DIR — are the only source; a new class needs no edit here).
// Key order = sorted class id (every iteration over CLASS_RULES is per held class or commutative).
//   phase       where its clicked ability resolves: 'pre' (simulate pre-pass, before casts), 'post' (post-pass
//               switch), 'local' (planning, this peer only — CLASS_LOCAL), null (no click: static / passive)
//   needs       what the click must carry (peer.mjs CLASS_NEEDS): tile | ally_or_self | enemy_near | monster_near | attach_effect
//   local       planning-time deck operation (CLASS_LOCAL): {op: recover, kind, what} | {op: draw, n} | {op: grant, effect_id}
//   passiveTurn fires by itself once per turn (peer.mjs PASSIVE_TURN_CLASSES)
//   perAction   CR 2026-11-17 (Elementalist): the passive fires at most once per ACTION — the use never spends the turn
//   handDefaults  fallbacks for hand classes (peer.mjs HAND_CLASS_DEFAULTS)
//   stance      code → code the action fights as (Reaver EP/EM → A, Barbarian EP/EM → B — CR 2026-11-18 (a); the Monk's
//               EP-as-Move stance was dropped, CR 2026-11-17)
//   emits       action codes that emit an element: true = every site, [sites] = only there (user rulings 2026-11-16:
//               Barbarian B and Monk M / EM emit at every site — planning, Rule 24, Manipulator, element badge;
//               CR 2026-11-18 (b): the Enchanter's A / B / M at every site, static)
//   planEmits   (legacy, no built-in uses it since CR 2026-11-18) these codes emit once per turn while a cast is queued
//   hooks       the hook points it acts in (HOOKS.md); 'peer:<name>' = behaviour that stays in peer.mjs
// The bundled class set: every definition is a built-in class (JS markers allowed, travels by name for now).
// Lenient: an invalid file is left out (a staged chaosD6-Classes tree is judged file by file by its validator);
// peer.mjs refuses to start while classBundleErrors() is not empty.
const BUNDLE = CE.loadClassDefs(undefined, { lenient: true });
export const classBundleErrors = () => [...BUNDLE.errors];
export const CLASS_RULES = Object.fromEntries([...BUNDLE.defs.keys()].sort().map(id => [id, JSON.parse(JSON.stringify(BUNDLE.defs.get(id).flags || {}))]));
export const CLASSES_IMPLEMENTED = Object.keys(CLASS_RULES);
// Abilities that resolve in peer.mjs itself (map geometry, occupancy, the move register): their definitions mark
// the `ability` hook {"engine": "js", "impl": "peer.mjs#…"} and classHook('ability', …) returns null for them.
export const PEER_ABILITIES = Object.freeze({ class_animator: 'animatorCopy', class_priest: 'priestShrine', class_cleric: 'clericDisableNearby', class_seeker: 'seekerPlant', class_warrior: 'warriorStep' });
export const CLASS_NEEDS = Object.fromEntries(CLASSES_IMPLEMENTED.filter(id => CLASS_RULES[id].needs).map(id => [id, CLASS_RULES[id].needs]));
export const PASSIVE_TURN_CLASSES = new Set(CLASSES_IMPLEMENTED.filter(id => CLASS_RULES[id].passiveTurn));

// ---- small shared helpers (= the peer.mjs closures they replace) ---------------------------------------------
const elemStatOf = (ctx) => (el) => (ctx && typeof ctx.elemStat === 'function' ? ctx.elemStat(el) : ELEM_TO_STAT[el]);
const pickBySalt = (seed, list, sha) => list.length ? list[parseInt(sha(seed).slice(0, 8), 16) % list.length] : null;   // = effects.mjs#pickBySalt
const parseJsonList = (s, dflt) => { try { const v = JSON.parse(s || ''); return Array.isArray(v) ? v : dflt; } catch { return dflt; } };   // = simulate()#parseJson
// The data of a class: the caller's data/classes.json view, else the bundled definition (a foreign class — always its definition).
const cdOf = (ctx, id) => {
  if (suspended.has(id)) return {};   // CH: a dormant foreign class has no data this resolution
  if (ctx && typeof ctx.classData === 'function' && !foreignIds.has(id)) return ctx.classData(id) || {};
  return defOf(id)?.data || {};
};
const rulesOf = (id) => CLASS_RULES[id] || {};

// ---- std hooks (every class; programs in lib classes_std) -----------------------------------------------------
// colours: elements grouped by the stat they belong to — { vitality: [...], matter: [...] } (peer.mjs classColours).
function colours(ctx, id) {
  const es = elemStatOf(ctx);
  const cols = {};
  for (const el of cdOf(ctx, id).colors || []) { const st = es(el); if (st) (cols[st] ||= []).push(el); }
  return cols;
}
// kind: 'passive' | ability_kind | 'static' (peer.mjs classKindOf / classPassive).
function kindOf(ctx, id) {
  const cd = cdOf(ctx, id);
  const passive = !!rulesOf(id).passiveTurn || !!(cd.passive ?? rulesOf(id).handDefaults?.passive);
  return passive ? 'passive' : (cd.ability_kind || 'static');
}
// ready: the class stands on the board and (tap) is not tapped / (else) not yet used this turn (simulate()#classReady).
// args { cs: {class_id, archived, tapped, usedTurn}, held (the class is in the unit's permanents), turn }.
const ready = (ctx, id, { cs, held, turn }) => cs?.class_id === id && !cs.archived && !!held && (kindOf(ctx, id) === 'tap' ? !cs.tapped : cs.usedTurn !== turn);
// config: the class knobs from its data version with defaults (class-*.mjs configs, classRangeOf, hand fallbacks).
function config(ctx, id) {
  const cd = cdOf(ctx, id);
  const range = Number.isInteger(cd.range) ? cd.range : 3;
  switch (id) {
    case 'class_rogue': return rogueConfig(cd);
    case 'class_cleric': return clericConfig(cd);
    case 'class_manipulator': return manipulatorConfig(cd);
    case 'class_avenger': return avengerConfig(cd);
    case 'class_prophet': return { ...prophetConfig(cd), range, hand_reveal: cd.hand_reveal || rulesOf(id).handDefaults?.hand_reveal || null };
    case 'class_animator': return animatorConfig(cd);
    case 'class_priest': return priestConfig(cd);
    case 'class_seeker': return seekerConfig(cd);
    case 'class_witch': return { range, hand_discard: cd.hand_discard || rulesOf(id).handDefaults?.hand_discard || null };
    default: return { range };
  }
}
// strike (Rule 24 on a class): an adjacent enemy's emission of `stat` against a colour of `cs`.
// args { cs: {class_id, archived, down}, cols ({stat: [elems]}), stat, elem, enemy (bool: in reach), pb {fail, value} }
// → null (no standing colour in reach) | { result: 'retry' | 'destroyed' | 'too weak', ok, last }
function strike(_ctx, _id, { cs, cols, stat, elem, enemy, pb }) {
  const okTarget = !!enemy && !!cs?.class_id && !cs.archived && stat in cols && !(cs.down || []).includes(stat) && (!elem || cols[stat].includes(elem));
  if (!okTarget) return null;
  const result = pb.fail ? 'retry' : pb.value >= STRIKE_DIE ? 'destroyed' : 'too weak';
  const last = result === 'destroyed' && Object.keys(cols).every(s => s === stat || (cs.down || []).includes(s));
  return { result, ok: result === 'destroyed', last };
}
// reanimated_strike (Necromancer "Destroy reanimated: point-buy non-contiguously Harmony and Concentration with 6",
// user ruling 2026-11-16 "Implement them"): a unit my class raised is destroyed once an adjacent enemy has struck each
// of its elements (data destroy_reanimated.elements, default Harmony + Concentration) with a point-buy die of
// destroy_reanimated.die (6) — one element per emission, in any order, the emissions need not be contiguous.
// args { down: [elements already struck on that unit], stat, elem (null = the first open one of `stat`), enemy (in
// reach), pb {fail, value} } → null (no open element of that stat) | { result: retry|destroyed|too weak, ok, last, elem }
export const REANIMATED_ELEMS = Object.freeze(['elem_harmony', 'elem_concentration']);
function reanimatedCfg(cd) {
  const d = cd?.destroy_reanimated || {};
  return { elements: Array.isArray(d.elements) && d.elements.length ? d.elements : [...REANIMATED_ELEMS], die: Number.isInteger(d.die) ? d.die : STRIKE_DIE };
}
function reanimatedStrike(ctx, id, { down, stat, elem, enemy, pb }) {
  const cfg = reanimatedCfg(cdOf(ctx, id));
  const es = elemStatOf(ctx);
  const dn = down || [];
  const open = cfg.elements.filter(el => !dn.includes(el) && es(el) === stat);
  const t = elem ? (open.includes(elem) ? elem : null) : (open[0] ?? null);
  if (!enemy || !t) return null;
  const result = pb.fail ? 'retry' : pb.value >= cfg.die ? 'destroyed' : 'too weak';
  const last = result === 'destroyed' && cfg.elements.every(el => el === t || dn.includes(el));
  return { result, ok: result === 'destroyed', last, elem: t };
}
// restore: may `stat` be emitted to recast (from the archive) / untap my class?  args { cs, cols, stat, kind }
const restore = (_ctx, _id, { cs, cols, stat, kind }) => !!cs?.class_id && stat in cols && (kind === 'recast' ? !!cs.archived : (!!cs.tapped && !cs.archived)) && !(cs.progress?.mode === kind && (cs.progress.done || []).includes(stat));
// CP2 2026-11-19: data untap_emissions when an integer above the class's colour (stat) count, else 0 (= the colour count).
const untapEmissions = (ctx, id, cols) => { const N = cdOf(ctx, id).untap_emissions; return Number.isInteger(N) && N > cols.length ? N : 0; };
// progress: what one landed class outcome does to MY class state (doResolution's class-card loop).
// args { state: {down, archived, tapped, progress}, cols: [stats], co: {kind, stat} } → { state, event }
//   event: colour | destroyed | recast | untap | step
function progress(_ctx, _id, { state, cols, co }) {
  const s = { down: [...(state.down || [])], archived: !!state.archived, tapped: !!state.tapped, progress: state.progress ? { mode: state.progress.mode, done: [...(state.progress.done || [])], ...('n' in state.progress ? { n: state.progress.n } : {}) } : null };   // CP2: n (the untap emission count) carries over
  if (co.kind === 'colour') { if (!s.down.includes(co.stat)) s.down.push(co.stat); return { state: s, event: 'colour' }; }
  if (co.kind === 'class_destroyed') { s.down = [...cols]; s.archived = true; s.tapped = false; s.progress = null; return { state: s, event: 'destroyed' }; }
  if (co.kind === 'recast' || co.kind === 'untap') {
    if (!s.progress || s.progress.mode !== co.kind) s.progress = { mode: co.kind, done: [] };
    const fresh = !s.progress.done.includes(co.stat);
    if (fresh) s.progress.done.push(co.stat);
    const complete = cols.every(x => s.progress.done.includes(x));
    // CP2 2026-11-19 (Healer, "a longer untap"): data untap_emissions N (an integer above the colour count) → the untap
    // takes N successful emissions. Within a round each colour once (restore); a round with every colour done starts
    // again (done → []); progress.n counts the emissions. Without the knob nothing changes (no n field).
    const N = untapEmissions(_ctx, _id, cols);
    if (co.kind === 'untap' && N) {
      const prev = state.progress && state.progress.mode === 'untap' ? state.progress : null;
      const n = (prev && Number.isInteger(prev.n) && prev.n >= 0 ? prev.n : 0) + (fresh ? 1 : 0);
      if (n >= N) { s.tapped = false; s.progress = null; return { state: s, event: 'untap' }; }
      s.progress = { mode: 'untap', done: complete ? [] : s.progress.done, n };
      return { state: s, event: 'step' };
    }
    if (complete && co.kind === 'recast') { s.archived = false; s.down = []; s.progress = null; return { state: s, event: 'recast' }; }
    if (complete) { s.tapped = false; s.progress = null; return { state: s, event: 'untap' }; }
    return { state: s, event: 'step' };
  }
  return { state: s, event: null };
}
// life_points: the shield life points are the first life lost — illusion, then armor, then the Avenger's chase bonus.
// args { dmg, illusion, armor, chaseBonus } → { illusion, armor, chaseBonus, absorbed }
// CP 2026-11-19 (user pick 9 a, data chase_bonus.max_only): a max-only chase bonus is still lost first, but absorbs nothing.
function lifePoints(ctx, id, { dmg, illusion, armor, chaseBonus }) {
  let hit = 0, il = illusion, ar = armor, cb = chaseBonus;
  if (dmg > 0 && il) { il = 0; hit++; }
  if (dmg > hit && ar) { ar = 0; hit++; }
  if (dmg > hit && cb) { cb = 0; if (cdOf(ctx, id).chase_bonus?.max_only !== true) hit++; }
  return { illusion: il, armor: ar, chaseBonus: cb, absorbed: hit };
}

// ---- per-class hooks ---------------------------------------------------------------------------------------------
// stance (Reaver / Barbarian / Monk): the code an empty action fights as. args { code } → code | null
const stance = (_ctx, id, { code }) => rulesOf(id).stance?.[code] ?? null;
// stance_target (Reaver EP/EM → A with no character target): Rule 15 priority over the adjacent enemy revealers —
// cheapest (not a blocker), then the one my hit lands on, then lowest life, then id.  args { cands: [{id, cost, lands, life}] }
const stanceTarget = (_ctx, _id, { cands }) => [...(cands || [])].sort((a, b) => a.cost - b.cost || a.lands - b.lands || a.life - b.life || a.id.localeCompare(b.id))[0]?.id ?? null;
// emits (Reaver A, Monk M / EM): does this action code emit an element?  args { code, site: plan | destroy | manip | badge }
const emits = (_ctx, id, { code, site }) => { const e = rulesOf(id).emits?.[code]; return e === true || (Array.isArray(e) && e.includes(site)); };
// plan_emits (Enchanter, once per turn): a non-Posture action emits while a cast is queued / running.
// args { held, archived, usedTurn, turn, options (a Battle Trance pair), code, queued }
const planEmits = (_ctx, id, a) => !!a.held && !a.archived && a.usedTurn !== a.turn && !a.options && (rulesOf(id).planEmits || []).includes(a.code) && !!a.queued;
// attack_out (Assassin): +1 on an Attack that connects once I already dealt combat damage this action.
// CR 2026-11-17: with data vs_hurt_only, only against an enemy below full life (its snapshot life < life_max).
// args { attacker, dmg, scored: [ids that already landed damage], defender } → dmg
const hurtNow = (ctx, id) => !!id && ctx.lifeOf(id) < Number(ctx.view(id)?.life_max);
const attackOut = (ctx, id, { attacker, dmg, scored, defender }) => (dmg >= 1 && ctx.hasPerm(attacker, id) && (scored || []).includes(attacker) && (cdOf(ctx, id).vs_hurt_only !== true || hurtNow(ctx, defender))) ? dmg + (rulesOf(id).attackBonus || 1) : dmg;
// lifesteal (Noble): combat damage I deal is banked for my own heal.  args { attacker, amount, source, why } → amount banked
// CR 2026-11-17: data lifesteal.from "attack" → only the damage of my own Attack strike (addDmg source 'action', why 'Attack').
const lifestealCfg = (ctx, id) => { const l = cdOf(ctx, id).lifesteal; return l && typeof l === 'object' && !Array.isArray(l) ? l : {}; };
const lifesteal = (ctx, id, { attacker, amount, source, why }) => (amount > 0 && ctx.hasPerm(attacker, id) && attacker === ctx.self && (lifestealCfg(ctx, id).from !== 'attack' || (source === 'action' && why === 'Attack'))) ? amount : 0;
// lifesteal_apply: the bank heals me after my damage lands, capped at my maximum.  args { amount, life, lifeMax, held } → life
// CR 2026-11-17: data lifesteal.max_per_action caps the heal of one action (the bank of one resolution).
const lifestealApply = (ctx, id, { amount, life, lifeMax, held }) => { const cap = lifestealCfg(ctx, id).max_per_action; return (amount > 0 && life > 0 && held) ? Math.min(lifeMax, life + (Number.isInteger(cap) && cap >= 0 ? Math.min(amount, cap) : amount)) : life; };
// pre_cast (Elementalist, passive once per turn): the emission completing a damage cast rolls a point-buy on my
// highest stat among the cast's elements (ties by name; no stat → matter).  args { actor, elements, salt }
// → { stat, fail, dice, value }  (the caller adds `value` to the cast when !fail)
function preCast(ctx, _id, { actor, elements, salt }) {
  const es = elemStatOf(ctx);
  const best = [...new Set((elements || []).map(el => es(el)).filter(Boolean))].sort((a, b) => ctx.statOf(actor, b) - ctx.statOf(actor, a) || a.localeCompare(b))[0] || 'matter';
  const pb = pointBuy(ctx.statOf(actor, best), `${salt || ''}:elementalist:${ctx.action}`, ctx.sha);
  return { stat: best, fail: pb.fail, dice: pb.dice, value: pb.value };
}
// transmute (Transmuter, static): a nearby ally's completed cast of positive stat tokens / heals works on me too.
// args { id (the Transmuter), outcomes: [{actor, status, statTokens, heals}] } → { edits: [{i, statTokens, heals}], log }
function transmute(ctx, _cid, { id, outcomes }) {
  const edits = [], log = [];
  (outcomes || []).forEach((o, i) => {
    if (o.actor === id || o.status !== 'done' || ctx.enemyOf(id, o.actor) || ctx.dist(id, o.actor) > 1) return;
    const dup = (o.statTokens || []).filter(t => t.on === o.actor && t.value > 0).map(t => ({ ...t, on: id }));
    const heals = (o.heals || []).filter(h => h.on === o.actor).map(h => ({ ...h, on: id }));
    if (dup.length || heals.length) {
      edits.push({ i, statTokens: dup, heals });
      if (id === ctx.self || o.actor === ctx.self) log.push(`[${ctx.label}] transmuter ${id.slice(0, 8)} shares ${o.actor.slice(0, 8)}'s cast (${dup.length} token(s), ${heals.length} heal(s))`);
    }
  });
  return { edits, log };
}
// destroy_result (Restaurateur, static): a token I destroy is taken instead.  args { d } → result
const destroyResult = (_ctx, _id, { d }) => (d.result === 'destroyed' && !d.phylactery && d.tok) ? 'taken' : d.result;
// end_turn (Guardian): +1 life at the end of a turn I never moved in (user ruling 2026-11-12).  args { held, moved, life, lifeMax, movedRounds } → heal
// CR 2026-11-17: "heal if you stand still on the 2nd AND 3rd action of the turn" — data still_actions [2, 3] (1-based
// actions of the turn that must see no move; default all three); movedRounds = the hg.round indices (0..2) I moved in
// (absent → the old `moved` flag).
const stillActions = (cd) => (Array.isArray(cd.still_actions) ? cd.still_actions : [1, 2, 3]);
const endTurn = (ctx, id, { held, moved, life, lifeMax, movedRounds }) => {
  const still = stillActions(cdOf(ctx, id));
  const mv = Array.isArray(movedRounds) ? movedRounds.some(r => still.includes(r + 1)) : !!moved;
  return (held && !mv && life > 0 && life < lifeMax) ? 1 : 0;
};
// step (Rogue / Cleric passives on a move that ends on a new hex). The caller asks the mover's STANDING class.
// args { threatReady, ring: [enemy ids within the threat radius], trap (a laid enter-trap or building trap there),
//        wtrap (a building's hidden trap), building (a building tile), trapLeft } → { stealth, trap: none|dodge|disable|spring }
// CR 2026-11-17 (Rogue, data shared_charge): one charge per turn for both — a step that needs both spends it on the trap.
function step(ctx, id, a) {
  const stealth = id === 'class_rogue' && !!a.threatReady && (a.ring || []).length > 0;
  if (!a.trap) return { stealth, trap: 'none' };
  if (id === 'class_rogue' && a.trapLeft > 0) return { stealth: stealth && !rogueShared(cdOf(ctx, id)), trap: 'dodge' };
  if (id === 'class_cleric' && (a.wtrap || a.building)) return { stealth, trap: 'disable' };
  return { stealth, trap: 'spring' };
}
// dungeon_step: a hero ending the turn's 3rd action in an unexplored dungeon.  args { trap, trapLeft } → none|dodge|disable|spring
const dungeonStep = (_ctx, id, { trap, trapLeft }) => !trap ? 'none' : (id === 'class_rogue' && trapLeft > 0) ? 'dodge' : id === 'class_cleric' ? 'disable' : 'spring';
// combat_in (Manipulator): about to take combat damage this action?  args { list } (my damage entries)
// CR 2026-11-17: data trigger "attack" → only an incoming Attack strike (class-manipulator.mjs attackHit).
const combatIn = (ctx, id, { list }) => (cdOf(ctx, id).trigger === 'attack' ? attackHit(list) : combatHit(list));
// pick_target (Manipulator): the random nearby enemy that must swap.  args { seed, cands } → id | null
const pickTarget = (ctx, _id, { seed, cands }) => pickManipTarget(seed, cands || [], ctx.sha);
// chase_step (Avenger): one step of the chase bonus.  args { state: {chasers, bonus}, chasing: [ids] } → chaseBonusStep(...)
const chaseStep = (ctx, id, { state, chasing }) => chaseBonusStep(state, chasing, avengerConfig(cdOf(ctx, id)));
// contact (Prophet): whom to look at among the enemies in contact.  args { foes: [{id, fought}] } → id | null
const contact = (_ctx, _id, { foes }) => prophetPick(foes);
// local (Paladin / Shaman / Kensei / Weapon Master / Summoner): the planning-time deck operation peer.mjs runs.
const local = (_ctx, id) => rulesOf(id).local ? JSON.parse(JSON.stringify(rulesOf(id).local)) : null;
// share_skills (Bard, static): every ally in contact plays my skills too when their action allows (rides).
// args { actor, skills: [my skills], adj: [{id, codes, skills}] (allies in contact with a reveal, sorted) } → { adds: [{on, skill}], log }
function shareSkills(ctx, _id, { actor, skills, adj }) {
  const adds = [], log = [];
  const rides = (codes, req) => codes.includes(req) || ((req === 'M' || req === 'P') && (codes.includes('EP') || codes.includes('EM')));   // = skills.mjs#ridesOn
  for (const o of adj || []) {
    let have = [...(o.skills || [])];
    for (const sk of skills || []) {
      const req = ctx.skillAction(sk); if (!req || sk === TRANCE || have.includes(sk)) continue;
      if (rides(o.codes, req)) { have = [...have, sk]; adds.push({ on: o.id, skill: sk }); if (o.id === ctx.self || actor === ctx.self) log.push(`[${ctx.label}] bard ${actor.slice(0, 8)}: ${o.id.slice(0, 8)} plays ${sk} too`); }
    }
  }
  return { adds, log };
}

// ---- ability (the clicked class card; simulate() pre-pass / post-pass switch) ----------------------------------
// args { actor, ab: {id, target, attach, stat}, salt } → { used, note, log, mine, out } | null (resolved in peer.mjs)
//   used  the ability fired (peer: classAbilityOut.used + useAbility(r, note) → tap / once-per-turn bookkeeping)
//   log   lines every peer logs; mine: lines logged only on the actor's own peer (the old `me === PEER_ID_STRING` logs)
//   out   { heals | armor | illusion | discards | lures | revives | traps | tokens: [records] } → classAbilityOut
const done = (note, out, log = []) => ({ used: true, note, log, mine: [], out });
const notDone = (mine = [], log = []) => ({ used: false, note: null, log, mine, out: {} });
function abilityEnv(ctx, actor, ab) {
  const ids = ctx.viewIds();
  const peer = ab?.target?.kind === 'character' ? ab.target.ref : null;
  const tile = ab?.target?.kind === 'tile' ? ab.target.ref : null;
  const nearAlly = peer && peer !== actor && ctx.lifeOf(peer) > 0 && ctx.dist(actor, peer) <= 1 && !ctx.enemyOf(actor, peer) ? peer : null;
  const adjacentOf = (id, pred) => ids.filter(o => o !== id && ctx.lifeOf(o) > 0 && ctx.dist(id, o) <= 1 && pred(o)).sort();
  const foesNearby = (id, range) => ids.filter(o => o !== id && ctx.lifeOf(o) > 0 && ctx.enemyOf(id, o) && ctx.dist(id, o) <= range && !ctx.hasPerm(o, 'effect_invisibility')).sort();
  const v = ctx.view(actor) || {};
  const here = { q: v.tile_q, r: v.tile_r };
  const stat = STATS.includes(ab?.stat) ? ab.stat : 'vitality';
  return { ids, peer, tile, nearAlly, adjacentOf, foesNearby, v, here, stat };
}
const ABILITIES = {
  // Illusionist (pre-pass, user ruling 2026-11-12): me and every ally within 10 hexes get one illusion life point.
  class_illusionist: (ctx, me, ab, E) => {
    const R = rulesOf('class_illusionist').illusionRange ?? ILLUSION_RANGE;
    const allies = E.ids.filter(o => o !== me && ctx.lifeOf(o) > 0 && !ctx.enemyOf(me, o) && ctx.dist(me, o) <= R).sort();
    return done(`an illusion life point for me and ${allies.length} all${allies.length === 1 ? 'y' : 'ies'} until the turn's 3rd action`, { illusion: [me, ...allies].map(o => ({ on: o, by: me })) });
  },
  // Healer (CR 2026-11-17, "heals you AND an adjacent ally"): one life to me and one to the adjacent ally I pointed at,
  // else to the first adjacent living ally (id order); with no ally next to me, only to me.
  // CP 2026-11-19 (user pick 4 a): data unmoved_only → no use on an action I move in (args moved); data ally_required →
  // no use without an adjacent living ally. Either way the card stays untapped.
  class_healer: (ctx, me, ab, E) => {
    const cd = cdOf(ctx, 'class_healer');
    if (cd.unmoved_only === true && ab.moved === true) return notDone([`[${ctx.label}] class healer: I move this action — the card stays untapped`]);
    const ally = E.nearAlly || E.adjacentOf(me, o => !ctx.enemyOf(me, o))[0] || null;
    if (cd.ally_required === true && !ally) return notDone([`[${ctx.label}] class healer: no ally next to me — the card stays untapped`]);
    return done(`one life token restored to me${ally ? ` and to ${ally.slice(0, 8)}` : ''}`, { heals: [{ on: me, amount: 1, by: me }, ...(ally ? [{ on: ally, amount: 1, by: me }] : [])] });
  },
  // Overlord (user ruling 2026-11-12): one armor life point, never two on a unit — mine, else the ally picked / the first bare adjacent ally.
  class_overlord: (ctx, me, _ab, E) => {
    const bare = (id) => !Number(ctx.view(id)?.armor);
    const who = bare(me) ? me : E.nearAlly && bare(E.nearAlly) ? E.nearAlly : E.adjacentOf(me, o => !ctx.enemyOf(me, o) && bare(o))[0] || null;
    if (!who) return notDone([`[${ctx.label}] class overlord: I and every ally next to me already wear an armor point`]);
    return done(`${who === me ? 'I wear' : `${who.slice(0, 8)} wears`} an armor life point`, { armor: [{ on: who, by: me }] });
  },
  // Druid (user ruling 2026-11-12): a stone (tile bonus) of the stat I am best at with no stone here yet; all four → beat the lowest.
  // CR 2026-11-17 ("each use raises 2 stones: best stat + next best"): the stats picked in order — my stats with no
  // stone here yet, best first (ties by name), then the stood stones lowest first — and the first TWO are rolled, each
  // with its own point-buy (salt …:druid:<action> and …:druid:<action>:2). A failed roll raises nothing; a roll on a
  // stood stat must beat that stone. Both rolls failed → nothing, the ability stays ready.
  class_druid: (ctx, me, ab, E) => {
    // CPD 2026-11-19 (user option C, data unmoved_only = the Healer's gate): no use on an action I move in — the card stays untapped.
    if (cdOf(ctx, 'class_druid').unmoved_only === true && ab.moved === true) return notDone([`[${ctx.label}] class druid: I move this action — the card stays untapped`]);
    const es = elemStatOf(ctx);
    const stones = parseJsonList(E.v.tile_tokens_json, []).filter(t => t.kind === 'bonus' && t.druid && t.q === E.here.q && t.r === E.here.r);
    const have = new Map(stones.map(t => [es(t.elem), t]));
    const order = [...[...STATS].sort((a, b) => ctx.statOf(me, b) - ctx.statOf(me, a) || a.localeCompare(b)).filter(x => !have.has(x)),
      ...[...have.values()].sort((a, b) => a.value - b.value || String(a.id).localeCompare(String(b.id))).map(t => es(t.elem))];
    const picks = (order.length ? order : [E.stat]).slice(0, 2);
    const tokens = [], notes = [], fails = [];
    // CP 2026-11-19 (user pick 2 b, data chain_stones): the 2nd point-buy rolls only if the 1st succeeded.
    const chain = cdOf(ctx, 'class_druid').chain_stones === true;
    let rolled = 0;
    picks.forEach((st, i) => {
      if (chain && i > 0 && fails.length) return;
      rolled++;
      const elem = (colours(ctx, 'class_druid')[st] || [])[0] || Object.keys(ELEM_TO_STAT).filter(el => es(el) === st)[0] || 'elem_vitality';
      const pb = pointBuy(ctx.statOf(me, st), `${ab.salt || ''}:druid:${ctx.action}${i ? `:${i + 1}` : ''}`, ctx.sha);
      if (pb.fail) { fails.push(`[${ctx.label}] class druid: the ${st} point-buy failed [${pb.dice.join(',')}] — no ${st} stone`); return; }
      if (have.has(st) && have.get(st).value >= pb.value) { notes.push(`the ${pb.value} does not beat the ${st} stone ${have.get(st).value}`); return; }
      tokens.push({ by: me, kind: 'bonus', druid: true, elem, value: pb.value, q: E.here.q, r: E.here.r });
      notes.push(`a Druid stone of ${st} +${pb.value} rises on my tile`);
    });
    // CP2 2026-11-19 (user answer 3, data fail_spends): a failed roll SPENDS the tap (the card taps, no stone).
    if (fails.length === rolled && cdOf(ctx, 'class_druid').fail_spends === true) return { used: true, note: 'no stone — the point-buy failed, the tap is spent', log: [], mine: fails, out: {} };
    if (fails.length === rolled) return notDone([...fails, `[${ctx.label}] class druid: no stone — the ability stays ready`]);
    return { ...done(notes.join('; '), tokens.length ? { tokens } : {}), mine: fails };
  },
  // Witch (user rework 2026-11-14, tap): the enemy picked within range, else one there by the reveal salt, discards N random hand cards.
  class_witch: (ctx, me, ab, E) => {
    const cfg = config(ctx, 'class_witch');
    const foes = E.foesNearby(me, cfg.range);
    const seed = `${ab.salt || ''}:witch:${ctx.action}:${me}`;
    const on = foes.includes(E.peer) ? E.peer : pickBySalt(`${seed}:who`, foes, ctx.sha);
    if (!on) return notDone([`[${ctx.label}] class witch: no enemy within ${cfg.range} hexes — the card stays untapped`]);
    const n = Number(cfg.hand_discard?.n) || 3;
    // CP 2026-11-19 (user pick 8 a, data self_discard): the Witch also puts that many random cards of her OWN hand onto
    // her discard pile (peer.mjs: the forced-discard loop, seed …:self).
    const own = Number.isInteger(cdOf(ctx, 'class_witch').self_discard) && cdOf(ctx, 'class_witch').self_discard > 0 ? cdOf(ctx, 'class_witch').self_discard : 0;
    return done(`${on.slice(0, 8)} puts ${n} random hand cards onto its discard pile${own ? ` — and I discard ${own} of mine` : ''}`, { discards: [{ on, by: me, n, seed, why: 'witch' }, ...(own ? [{ on: me, by: me, n: own, seed: `${seed}:self`, why: 'witch', self: true }] : [])] },
      [`[${ctx.label}] witch: ${me.slice(0, 14)} makes ${on.slice(0, 14)} discard ${n}${own ? ` and discards ${own} of its own` : ''} (seed ${ctx.sha(seed).slice(0, 8)})`]);
  },
  // Avenger (user rework #2 2026-11-14, once per turn): every living wild monster within lure_range wakes and chases me.
  class_avenger: (ctx, me, _ab, E) => {
    const R = avengerConfig(cdOf(ctx, 'class_avenger')).range;
    const lured = lureTargets(E.ids.filter(o => o !== me).map(o => ({ id: o, wild: isWildMonster(ctx.view(o)), enemy: ctx.enemyOf(me, o), alive: ctx.lifeOf(o) > 0, d: ctx.dist(me, o) })), R);
    if (!lured.length) return notDone([`[${ctx.label}] class avenger: no wild monster within ${R} hexes — the ability stays ready`]);
    return done(`${lured.length} monster(s) within ${R} hexes start chasing me`, { lures: lured.map(on => ({ on, by: me })) },
      [`[${ctx.label}] avenger: ${me.slice(0, 14)} lures ${lured.length} monster(s) within ${R} hexes: ${lured.map(o => o.slice(0, 14)).join(', ')}`]);
  },
  // Alchemist: a Library effect (by the reveal salt) lies as a trap on the picked hex next to me, else on mine.
  class_alchemist: (ctx, me, ab, E) => {
    const lib = ctx.library();
    const card = lib.length ? lib[parseInt(ctx.sha(`${ab.salt || ''}:alchemist:${ctx.action}`).slice(0, 8), 16) % lib.length] : null;
    if (!card) return notDone();
    const t = E.tile;
    const near = !!t && Number.isInteger(t.q) && Number.isInteger(t.r) && (Math.abs(E.v.tile_q - t.q) + Math.abs(E.v.tile_r - t.r) + Math.abs(E.v.tile_q + E.v.tile_r - t.q - t.r)) / 2 <= 1;
    const spot = near ? { q: t.q, r: t.r } : E.here;
    return done(`a ${card.effect_id} from the Library lies as a trap at (${spot.q},${spot.r})`, { traps: [{ by: me, q: spot.q, r: spot.r, effect_id: card.effect_id, elements: [...card.elements], card_id: null, library: true, power: TRAP_POWER, trigger: 'enter', mode: 'damage', holder: null }] });
  },
  // Ranger: the effect card picked from my hand lies as a 'targeted' trap under me.
  class_ranger: (_ctx, me, ab, E) => {
    if (!ab.attach?.effect_id || !Array.isArray(ab.attach.elements) || !ab.attach.elements.length) return notDone();
    return done(`${ab.attach.name || ab.attach.effect_id} lies as a trap under me`, { traps: [{ by: me, q: E.here.q, r: E.here.r, effect_id: ab.attach.effect_id, elements: [...ab.attach.elements], card_id: ab.attach.card_id || null, library: false, power: TRAP_POWER, trigger: 'targeted', mode: 'damage', holder: null }] });
  },
  // Necromancer: a fallen ally creature next to me (not raised before) rises; none → an archived creature of mine (owner-judged).
  // A corpse that was itself a reanimated unit (snapshot raised_by, ruling 2026-11-16 "destroy reanimated") stays down.
  class_necromancer: (ctx, me, _ab, E) => {
    const raised = unionOf(ctx.viewValues().map(p => p?.class_state_json), 'raised');   // phase 2: every unit any class raised
    const fallen = E.ids.filter(id => id !== me && ctx.lifeOf(id) <= 0 && ctx.view(id)?.creature_id && !raised.has(id) && !ctx.view(id)?.raised_by && ctx.dist(me, id) <= 1 && ctx.sideOf(ctx.view(id).alliance) === ctx.sideOf(E.v.alliance)).sort()[0] || null;
    if (fallen) return done(`${ctx.view(fallen).name || fallen.slice(0, 8)} rises again`, { revives: [{ by: me, who: fallen, creature_id: ctx.view(fallen).creature_id, name: ctx.view(fallen).name }] });
    return done('no fallen ally in reach — an archived creature of mine enters if I have one', { revives: [{ by: me, who: null }] });
  },
};
// CP 2026-11-19: args.moved = the actor moves in this action (peer.mjs moveCodeOf) — the Healer's unmoved_only gate.
function ability(ctx, id, { actor, ab, salt, moved }) {
  if (PEER_ABILITIES[id]) return null;
  const f = ABILITIES[id];
  if (!f) return notDone();
  return f(ctx, actor, { ...(ab || {}), salt, moved: moved === true }, abilityEnv(ctx, actor, ab));
}

// ---- dispatcher -------------------------------------------------------------------------------------------------
// classHook(hookName, classId, ctx, args) → result. Every hook is per class (the named class's program, else the
// std default from lib classes_std, else the hook's neutral value).
const HOOKS = {
  colours: (id, ctx) => colours(ctx, id),
  kind: (id, ctx) => kindOf(ctx, id),
  ready: (id, ctx, a) => ready(ctx, id, a),
  config: (id, ctx) => config(ctx, id),
  strike: (id, ctx, a) => strike(ctx, id, a),
  reanimated_strike: (id, ctx, a) => reanimatedStrike(ctx, id, a),
  restore: (id, ctx, a) => restore(ctx, id, a),
  progress: (id, ctx, a) => progress(ctx, id, a),
  life_points: (id, ctx, a) => lifePoints(ctx, id, a),
  stance: (id, ctx, a) => stance(ctx, id, a),
  stance_target: (id, ctx, a) => stanceTarget(ctx, id, a),
  emits: (id, ctx, a) => emits(ctx, id, a),
  plan_emits: (id, ctx, a) => planEmits(ctx, id, a),
  attack_out: (id, ctx, a) => attackOut(ctx, id, a),
  lifesteal: (id, ctx, a) => lifesteal(ctx, id, a),
  lifesteal_apply: (id, ctx, a) => lifestealApply(ctx, id, a),
  pre_cast: (id, ctx, a) => preCast(ctx, id, a),
  ability: (id, ctx, a) => ability(ctx, id, a),
  transmute: (id, ctx, a) => transmute(ctx, id, a),
  destroy_result: (id, ctx, a) => destroyResult(ctx, id, a),
  end_turn: (id, ctx, a) => endTurn(ctx, id, a),
  step: (id, ctx, a) => step(ctx, id, a),
  dungeon_step: (id, ctx, a) => dungeonStep(ctx, id, a),
  combat_in: (id, ctx, a) => combatIn(ctx, id, a),
  pick_target: (id, ctx, a) => pickTarget(ctx, id, a),
  chase_step: (id, ctx, a) => chaseStep(ctx, id, a),
  contact: (id, ctx, a) => contact(ctx, id, a),
  local: (id, ctx) => local(ctx, id),
  share_skills: (id, ctx, a) => shareSkills(ctx, id, a),
};
export const HOOK_NAMES = Object.keys(HOOKS);
// The JS answer of a hook for a class that does not act in it (= class-engine.mjs neutralOf for every hook but the std ones).
function jsHook(hookName, id, ctx, args) {
  const std = CE.HOOK_SPECS[hookName]?.std;
  if (!std && !(rulesOf(id).hooks || []).includes(hookName)) return CE.neutralOf(hookName, args);
  return HOOKS[hookName](id, ctx, args);
}
export function classHook(hookName, classId, ctx, args = {}) {
  if (!HOOKS[hookName]) throw new Error(`classes.mjs: unknown hook ${hookName}`);
  if (foreignIds.has(classId)) return suspended.has(classId) ? jsHook(hookName, classId, ctx, args) : dataHook(hookName, classId, ctx, args);   // CH: dormant → as an unknown class
  if (CLASS_ENGINE === 'js') return jsHook(hookName, classId, ctx, args);
  if (CLASS_ENGINE === 'data') return dataHook(hookName, classId, ctx, args);
  return shadowHook(hookName, classId, ctx, args);
}
// Convenience wrappers peer.mjs uses where the old code called a closure.
export const classColours = (ctx, id) => classHook('colours', id, ctx);
export const classKindOf = (ctx, id) => classHook('kind', id, ctx);
// builtinClassEntries() → { id: {id, name, tags, data} } of the bundled definitions, sorted by id — what peer.mjs
// reads as data.classes (class isolation phase 1: one class-data source; tools/class-engine-check.mjs keeps
// data/classes.json, still the rebalance / proposals collection, equal to it).
export const builtinClassEntries = () => Object.fromEntries([...BUNDLE.defs.keys()].sort().map(id => { const d = BUNDLE.defs.get(id); return [id, { id, name: d.name, tags: [], data: JSON.parse(JSON.stringify(d.data || {})) }]; }));

// ---- C2: engine switch, data hooks, foreign classes --------------------------------------------------------------
// CLASS_ENGINE=data (default since class isolation phase 1): every hook runs the program of the class's definition
// (game/classes-data/classes/<id>.json, or CLASS_DEFS_DIR; std hooks fall back to lib classes_std); an ability marked
// {"engine":"js","impl":"peer.mjs#…"} returns null (peer.mjs resolves it). shadow: both run, results must be
// JSON-identical; a mismatch goes to stderr, CLASS_SHADOW_STRICT=1 throws; the JS result is returned.
// js: the JS reference hooks above (test oracles until they move to chaosD6-Classes, phase 6).
// CLASS_SHADOW_REPORT=1 prints a tally at exit.
const ENGINE_ENV = (typeof process !== 'undefined' && process.env) || {};
export const CLASS_ENGINE = ['js', 'shadow'].includes(ENGINE_ENV.CLASS_ENGINE) ? ENGINE_ENV.CLASS_ENGINE : 'data';
export const classShadowStats = { compared: 0, mismatches: 0, errors: 0, byHook: {} };
const BUILTIN_IDS = new Set(CLASSES_IMPLEMENTED);
export const classBundle = () => BUNDLE;
const foreignByKey = new Map(), foreignById = new Map(), foreignIds = new Set();
const suspended = new Map();   // CH: foreign id → its CLASS_RULES entry while the class is dormant (suspendForeignClasses)
function defOf(id) {
  if (suspended.has(id)) return undefined;
  if (foreignById.has(id)) return foreignById.get(id);
  if (!BUILTIN_IDS.has(id)) return undefined;
  try { return classBundle().defs.get(id); } catch { return undefined; }
}
// The W the programs' queries see (class-engine.mjs CLASS_CTX_OPS). `own` = a definition being run directly.
const wrap = (ctx, own) => ({
  c: ctx,
  cd: (id) => (own && id === own.id && !(ctx && typeof ctx.classData === 'function')) ? (own.data || {}) : cdOf(ctx, id),
  flag: (id, k) => { const d = own && id === own.id ? own : defOf(id); return d ? d.flags?.[k] : CLASS_RULES[id]?.[k]; },
  sha: (s) => ctx.sha(s),
  elemStat: elemStatOf(ctx),
});
let noted = 0;
const note = (msg) => { classShadowStats.errors++; if (noted++ < 20) console.error(`[classes] data hook: ${msg}`); };
function dataHook(hookName, classId, ctx, args, own = null) {
  const d = own && classId === own.id ? own : defOf(classId);
  const prog = CE.programOf(d, hookName, classBundle().std);
  if (!prog) return CE.neutralOf(hookName, args);
  if (prog.js) return prog.js.impl.startsWith('classes.mjs') && d && BUILTIN_IDS.has(d.id) ? HOOKS[hookName](classId, ctx, args) : null;
  try {
    const v = CE.runHookProgram(prog, hookName, classId, wrap(ctx, own), args);
    const out = CE.unmarshal(hookName, v);
    if (CE.resultOk(hookName, out)) return out;
    note(`${classId} ${hookName}: bad result ${JSON.stringify(v)}`);
  } catch (e) {
    if (!(e instanceof CE.EffectEngineLimit || e instanceof CE.EffectProgramError)) throw e;   // a ctx query threw: as JS
    note(`${classId} ${hookName}: ${e.message}`);
  }
  return CE.neutralOf(hookName, args);
}
function shadowHook(hookName, classId, ctx, args) {
  const js = jsHook(hookName, classId, ctx, args);
  const want = JSON.stringify(js);
  let got;
  try { got = JSON.stringify(dataHook(hookName, classId, ctx, args)); } catch (e) { got = `throws ${e?.message}`; }
  // A peer-resolved ability is null on both sides by construction.
  classShadowStats.compared++;
  classShadowStats.byHook[hookName] = (classShadowStats.byHook[hookName] || 0) + 1;
  if (got !== want) {
    classShadowStats.mismatches++;
    console.error(`[classes] SHADOW MISMATCH ${hookName} ${classId}\n  js:   ${want}\n  data: ${got}`);
    if (ENGINE_ENV.CLASS_SHADOW_STRICT === '1') throw new Error(`classes shadow mismatch in ${hookName} (${classId})`);
  }
  return js;
}
{
  if (ENGINE_ENV.CLASS_SHADOW_REPORT === '1') process.on('exit', () => console.log(`[classes] ${CLASS_ENGINE}: ${BUNDLE.defs.size} data classes; shadow compared ${classShadowStats.compared}, mismatches ${classShadowStats.mismatches}, errors ${classShadowStats.errors} ${JSON.stringify(classShadowStats.byHook)}`));
}

// validateClassDef(def, {libs, libMap}) → [errors] — a definition file (chaosd6.class/1). JS markers only for built-ins.
export function validateClassDef(def, opts = {}) {
  return CE.validateClassDef(def, { ...opts, builtin: BUILTIN_IDS.has(def?.id) && !foreignIds.has(def?.id) });
}
const prepared = new WeakMap();
// resolveClassProgram(def, hookName, ctx, args) → what classHook(hookName, def.id, ctx, args) returns with only this
// definition answering (its program, else the std default, else the neutral value). An invalid definition throws.
export function resolveClassProgram(def, hookName, ctx, args = {}) {
  if (!CE.HOOK_SPECS[hookName]) throw new Error(`classes.mjs: unknown hook ${hookName}`);
  let own = def.$subs ? def : prepared.get(def);
  if (!own) {
    const errs = validateClassDef(def);
    if (errs.length) throw new Error(`class ${def?.id}: ${errs.join('; ')}`);
    own = CE.bindClassDef(JSON.parse(JSON.stringify(def)));
    prepared.set(def, own);
  }
  return dataHook(hookName, own.id, ctx, args, own);
}
// registerForeignClass(key, def) → the bound definition (a player-branch class, for the C4 handshake). Its flags join
// CLASS_RULES (not CLASSES_IMPLEMENTED: the class pool a peer draws from is unchanged). Throws on a built-in id or
// an invalid definition (a foreign class needs a program for every hook it declares — no JS markers).
export function registerForeignClass(key, def0, opts = {}) {
  const def = JSON.parse(JSON.stringify(def0));
  if (BUILTIN_IDS.has(def?.id)) throw new Error(`registerForeignClass: ${def?.id} is a built-in class`);
  const libs = opts.libs || CE.defaultLibs();
  const errs = CE.validateClassDef(def, { libs, builtin: false });
  if (errs.length) throw new Error(`registerForeignClass ${def?.id}: ${errs.join('; ')}`);
  CE.bindClassDef(def, libs);
  if (foreignById.has(def.id)) throw new Error(`registerForeignClass: another ${def.id} is already registered (one definition per id)`);
  foreignByKey.set(key, def); foreignById.set(def.id, def); foreignIds.add(def.id);
  CLASS_RULES[def.id] = JSON.parse(JSON.stringify(def.flags || {}));
  sortForeignRules();
  return def;
}
// CH: the foreign entries of CLASS_RULES always follow the built-ins in code-unit id order, whatever order a peer
// learned them in (clWith(h) iterates CLASS_RULES — every peer must see the same order).
function sortForeignRules() {
  const ids = [...foreignIds].filter(id => Object.prototype.hasOwnProperty.call(CLASS_RULES, id)).sort();
  const saved = ids.map(id => [id, CLASS_RULES[id]]);
  for (const [id] of saved) delete CLASS_RULES[id];
  for (const [id, r] of saved) CLASS_RULES[id] = r;
}
export const isForeignClassId = (id) => foreignIds.has(id);
export const foreignClassDef = (keyOrId) => foreignByKey.get(keyOrId) || foreignById.get(keyOrId) || null;
export function clearForeignClasses() {
  suspended.clear();
  for (const id of foreignIds) delete CLASS_RULES[id];
  foreignByKey.clear(); foreignById.clear(); foreignIds.clear();
}
// CH (classes-handshake.mjs): a foreign class some revealer could not load is DORMANT for that resolution on every
// peer — no flags (out of CLASS_RULES), no data, every hook answers as for an unknown class (= what a peer lacking
// it computes). suspendForeignClasses(ids) first resumes any earlier suspension; resumeForeignClasses() undoes it.
export function suspendForeignClasses(ids = []) {
  resumeForeignClasses();
  for (const id of ids) if (foreignIds.has(id) && !suspended.has(id)) { suspended.set(id, CLASS_RULES[id]); delete CLASS_RULES[id]; }
  return [...suspended.keys()].sort();
}
export function resumeForeignClasses() {
  if (!suspended.size) return;
  for (const [id, r] of suspended) CLASS_RULES[id] = r;
  suspended.clear();
  sortForeignRules();
}
export const isClassSuspended = (id) => suspended.has(id);
