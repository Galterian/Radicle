// The JS reference hooks of the 33 built-in classes — TEST ORACLE (class isolation phase 6, 2026-11-20).
// The game never imports this file: every hook runs its class's definition program (CLASS_ENGINE=data, the default).
// CLASS_ENGINE=js | shadow (swarms, checks) load it explicitly — peer.mjs and the checks call
// classes.mjs#installClassOracle(await import('./classes-data/oracle/classes-js.mjs')); shadow compares both answers.
// Moved verbatim from game/classes.mjs (HOOKS, the per-hook functions, jsHook). Lives in chaosD6-Classes
// (classes-repo-sync copies classes-data/oracle/).
import { pointBuy } from '../../effect-engine.mjs';
import { unionOf } from '../../class-state.mjs';
import * as CE from '../../class-engine.mjs';
import { STATS, TRAP_POWER, STRIKE_DIE, ILLUSION_RANGE, TRANCE, ELEM_TO_STAT, REANIMATED_ELEMS, classHook, classColours, classKindOf, oracleSupport } from '../../classes.mjs';
import { rogueConfig, clericConfig, rogueShared, manipulatorConfig, avengerConfig, prophetConfig, animatorConfig, priestConfig, seekerConfig, maxStanding } from './class-configs.mjs';
import { combatHit, attackHit, pickManipTarget, isWildMonster, lureTargets, chaseBonusStep, prophetPick } from '../../contact-prims.mjs';
const { elemStatOf, pickBySalt, parseJsonList, cdOf, rulesOf } = oracleSupport;

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
// blocked (Necromancer, phase 4): nothing to raise — no fallen ally creature next to me and none in my archive.
const blocked = (_ctx, _id, { fallen_near, archive_creature }) => (fallen_near || archive_creature ? null : 'no fallen ally creature next to me and none in my archive');
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
  // Phase 3 (2026-11-20): the map-bound abilities ask the engine (peer.mjs simulate() 'ability requests'); the
  // note is the engine's. Animator: a copy of the nearest building; Priest: a Shrine (one standing per data
  // max_standing); Seeker: the attached card as a far trap with vision; Cleric: disable traps; Warrior: a step.
  class_animator: (ctx) => done('', { copy_building: [animatorConfig(cdOf(ctx, 'class_animator'))] }),
  class_priest: (ctx) => done('', { build: [{ ...priestConfig(cdOf(ctx, 'class_priest')), max_standing: maxStanding(cdOf(ctx, 'class_priest')) }] }),
  class_seeker: (ctx) => done('', { far_trap: [{ ...seekerConfig(cdOf(ctx, 'class_seeker')), max_standing: maxStanding(cdOf(ctx, 'class_seeker')) }] }),
  class_cleric: (ctx) => done('', { disable_traps: [{ radius: clericConfig(cdOf(ctx, 'class_cleric')).range }] }),
  class_warrior: () => done('', { step: [{ n: 1 }] }),
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
  const f = ABILITIES[id];
  if (!f) return notDone();
  return f(ctx, actor, { ...(ab || {}), salt, moved: moved === true }, abilityEnv(ctx, actor, ab));
}

// ---- dispatcher -------------------------------------------------------------------------------------------------
// classHook(hookName, classId, ctx, args) → result. Every hook is per class (the named class's program, else the
// std default from lib classes_std, else the hook's neutral value).
export const HOOKS = {
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
  blocked: (id, ctx, a) => blocked(ctx, id, a),
};
export const HOOK_NAMES = Object.keys(HOOKS);
// The JS answer of a hook for a class that does not act in it (= class-engine.mjs neutralOf for every hook but the std ones).
export function jsHook(hookName, id, ctx, args) {
  const std = CE.HOOK_SPECS[hookName]?.std;
  if (!std && !(rulesOf(id).hooks || []).includes(hookName)) return CE.neutralOf(hookName, args);
  return HOOKS[hookName](id, ctx, args);
}
