// The JS reference hooks of the 14 built-in skills — TEST ORACLE (skill isolation, chaosd6-8a 2026-11-22).
// The game never imports this file: every hook runs its skill's definition program (SKILL_ENGINE=data, the default).
// SKILL_ENGINE=js | shadow (swarms, checks) load it explicitly — peer.mjs and the checks call
// skills.mjs#installSkillOracle(await import('./skills-data/oracle/skills-js.mjs')); shadow compares both answers.
// Moved verbatim from game/skills.mjs (HOOKS, the per-hook functions, sanctuaryBreaks, PLAN_LOCKS) + the REF tables
// the checks compare the data-derived tables against (SKILL_RULES_REF = the old skills.mjs SKILL_RULES, frozen).
// Lives in chaosD6-Skills (skills-repo-sync copies skills-data/oracle/). Node-18 compatible.
import { SKILL_RULES, NEGATING_SKILLS, ridesOn, ridesFor, oracleSupport } from '../../skills.mjs';
const { sdOf } = oracleSupport;

export const TRANCE = 'skill_battle_trance';
const roundHalfUp10 = (sum) => Math.round(sum / 10);   // = effects.mjs#roundHalfUp10
const statRaw = (v, sk) => Math.max(0, v?.[`stat_${sk}`] ?? 0);   // = peer.mjs simulate()#statRaw

// ---- REF tables (frozen copies of what skills.mjs / skill-engine.mjs / building-bonus.js hard-coded before the
// skill isolation; the game derives them from the definitions now — tools/skills-check.mjs + skill-engine-check.mjs
// compare). Key order of SKILL_RULES_REF = the old deal order.
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };
export const SKILL_RULES_REF = deepFreeze({
  skill_powerful_attack: { action: 'A', permanent: false, negating: false, hooks: ['attack_out', 'plan_lock'], attackBonus: 1 },
  skill_overrun:         { action: 'A', permanent: false, negating: true, hooks: ['negate_kind', 'move'], range: 1, negates: ['M', 'EM'] },
  skill_grapple:         { action: 'A', permanent: false, negating: true, hooks: ['negate_kind'], negates: ['P'] },
  skill_ranged_weapon:   { action: 'A', permanent: true, pointBuyStat: 'matter', negating: false, hooks: ['block_in', 'block_cost', 'attack_range', 'perm_landing', 'perm_stats'], range: 2 },
  skill_taunt:           { action: 'B', permanent: true, pointBuyStat: 'vitality', negating: false, hooks: ['block_in', 'attack_target', 'attack_vs_block', 'perm_landing', 'perm_stats'], range: 1 },
  skill_barricade:       { action: 'B', permanent: true, pointBuyStat: 'vitality', negating: false, hooks: ['defend_in', 'perm_landing', 'perm_stats'], negates: ['A', 'B'] },
  skill_sanctuary:       { action: 'B', permanent: true, pointBuyStat: 'any', negating: false, hooks: ['defend_in', 'end_round', 'perm_landing', 'perm_stats'] },
  skill_dodge:           { action: 'M', permanent: false, negating: true, hooks: ['damage_in'], damageOff: 1 },
  skill_bluff:           { action: 'M', permanent: false, negating: true, hooks: ['negate_action'], range: 1 },
  skill_intimidation:    { action: 'P', permanent: false, negating: true, hooks: ['negate_action'], range: 1, negates: ['A'] },
  skill_disruption_move: { action: 'M', permanent: false, negating: true, hooks: ['negate_kind'], negates: ['P', 'EP'] },
  skill_battle_trance:   { action: 'P', permanent: false, negating: false, trance: true, hooks: ['plan', 'trance_assign'] },
  skill_force_shield:    { action: 'B', permanent: true, pointBuyStat: 'vitality', negating: false, hooks: ['effect_in', 'effect_leg', 'end_round', 'perm_landing', 'perm_stats'] },
  skill_counter_spell:   { action: 'P', permanent: false, negating: true, keepsTarget: true, hooks: ['plan_target', 'counter_pre'], range: 1 },
});
export const DEAL_ORDER_REF = Object.freeze(Object.keys(SKILL_RULES_REF));
// skill-engine.mjs HOOK_SPECS pass `order` arrays before the isolation.
export const PASS_ORDER_REF = deepFreeze({
  counter_pre: ['skill_counter_spell'],
  negate_action: ['skill_bluff', 'skill_intimidation'],
  negate_kind: ['skill_grapple', 'skill_disruption_move', 'skill_overrun'],
  trance_assign: ['skill_battle_trance'],
});
// The S5 validator's priced flags of the built-ins (tools/skills-rebalancing-check.mjs BUILTIN_FLAGS, the 2026-11-16
// literal before it was derived from the definitions).
export const VALIDATOR_FLAGS_REF = deepFreeze({
  skill_powerful_attack: { attackBonus: 1, selfLock: { codes: ['A'], until: 'end_of_round' } },
  skill_overrun: { negate: { codes: ['M', 'EM'], who: 'target', mode: 'no_move' }, swap: true },
  skill_grapple: { negate: { codes: ['P'], who: 'target', mode: 'ep' } },
  skill_ranged_weapon: { reach: 2, trapImmune: true },
  skill_taunt: { tauntGuard: true, blockDenied: true },
  skill_force_shield: { effectShield: true },
  skill_barricade: { immuneTo: ['A', 'B'] },
  skill_sanctuary: { invincibleWhile: ['M', 'EM', 'EP'] },
  skill_disruption_move: { negate: { codes: ['P'], who: 'target', mode: 'em' }, voidEmission: true },
  skill_dodge: { damageOff: 1 },
  skill_bluff: { negate: { codes: ['A', 'M', 'B', 'P', 'EM'], who: 'target', mode: 'ep' } },
  skill_intimidation: { negate: { codes: ['A'], who: 'adjacent', mode: 'ep' }, altCounterSkill: true },
  skill_battle_trance: { trance: true },
  skill_counter_spell: { counterSkill: true, counterElement: true },
});
// js/building-bonus.js BUILDING_SKILLS before the isolation (part of the (seed, q, r) contract: order matters).
export const BUILDING_SKILLS_REF = Object.freeze(['skill_dodge', 'skill_powerful_attack', 'skill_intimidation', 'skill_grapple', 'skill_disruption_move', 'skill_bluff', 'skill_counter_spell']);

// ---- hook: plan ---------------------------------------------------------------------------------------
// A Posture keeps a character target when a skill needs one (Counter Spell).
const planTarget = (skillIds) => skillIds.some(id => !!SKILL_RULES[id]?.keepsTarget);

// ---- resolver helpers shared by the passes -----------------------------------------------------------
function helpers(ctx) {
  const { byActorPre, effAction, skillFx } = ctx;
  const has = (id, skill) => (byActorPre.get(id)?.skills || []).includes(skill);
  const nonPerm = (id) => id !== TRANCE && !sdOf(ctx, id)?.is_permanent;
  const fromBuilding = (by, skill) => byActorPre.get(by)?.buildingSkill === skill;
  // Skill bookkeeping (user ruling 2026-11-12): what each instant actually did. A skill that served its
  // purpose is discarded; a negated action's card — and the instants riding on it, which never execute —
  // goes back to its owner's hand; a countered instant is discarded. Read by the card disposition.
  const negate = (by, skill, o, what) => {
    const ridden = (o.skills || []).filter(nonPerm);
    o.skills = (o.skills || []).filter(id => !nonPerm(id));
    skillFx.push({ by, skill, on: o.actor, what, negated: true, ridden, building: fromBuilding(by, skill) });
  };
  const counterSkills = (by, skill, o) => {
    const countered = (o.skills || []).filter(nonPerm);
    o.skills = (o.skills || []).filter(id => !nonPerm(id));
    skillFx.push({ by, skill, on: o.actor, what: 'skills', countered, building: fromBuilding(by, skill) });
  };
  const adjacentFoes = (id) => ctx.reveals.filter(o => o.actor !== id && ctx.enemyOf(id, o.actor) && !ctx.hiddenFrom(id, o.actor) && ctx.dist(id, o.actor) <= 1).map(o => o.actor);
  // A targeted skill without a right-clicked enemy picks the adjacent one: attackers first, then lowest id.
  const foeFor = (r) => {
    const t = r.target?.kind === 'character' ? r.target.ref : null;
    if (t && effAction.has(t) && !ctx.hiddenFrom(r.actor, t)) return t;
    return adjacentFoes(r.actor).sort((a, b) => (Number(ctx.codeIs(b, 'A')) - Number(ctx.codeIs(a, 'A'))) || a.localeCompare(b))[0] || null;
  };
  return { has, nonPerm, fromBuilding, negate, counterSkills, adjacentFoes, foeFor };
}

// ---- hook: counter_pre (Counter Spell pre-pass) -------------------------------------------------------
// Rule 8: no stack, but a counter is a prohibition and prohibitions apply "finally as a replacement" — so
// it runs before any other skill resolves. Target (Rule 15 pc override: Posture has no target, so the
// adjacent enemy that benefits me most): the right-clicked enemy if they are adjacent and casting, else the
// adjacent caster whose effect I blunt the most, lowest life breaking ties; with nobody casting, the
// right-clicked enemy. The target loses every non-permanent skill they played this action (a countered
// Battle Trance collapses to its first card). Then I emit one element against their cast: of the element
// types in it, the one that saves me the most; my stat for that element comes off their stat for every
// instance of it in the cast (Lightning = fire+air, Matter 16 vs my 8, counter fire → (16−8−8) + (16−8) = 8
// → 1). Caster-side only. Two Counter Spells aimed at each other cancel in actor order — the lexically
// first actor's counter lands first and strips the other's.
function counterPre(ctx) {
  const { effAction, tranceOpts, counterPen, skillFx } = ctx;
  const { fromBuilding } = helpers(ctx);
  const log = ctx.log, self = ctx.self, label = ctx.label;
  for (const r of [...ctx.reveals].sort((a, b) => a.actor.localeCompare(b.actor))) {
    if (!(r.skills || []).includes('skill_counter_spell')) continue;
    if (!ridesFor(r)('P')) continue;
    const casterV = ctx.view(r.actor);
    if (!casterV) continue;
    const declared = r.target?.kind === 'character' ? r.target.ref : null;
    const cands = ctx.reveals.filter(o => o.actor !== r.actor && ctx.enemyOf(r.actor, o.actor) && !ctx.hiddenFrom(r.actor, o.actor) && ctx.dist(r.actor, o.actor) <= 1);
    if (!cands.length) continue;
    // Best element against one caster: how much of their damage to me it removes.
    const bestElem = (o) => {
      if (!ctx.castsDamage(o)) return null;
      const before = ctx.effectDmgNoShield(o, r.actor);
      const prev = counterPen.get(o.actor);
      let best = null;
      for (const el of [...new Set(o.effect.elements)].sort()) {
        const amount = statRaw(casterV, ctx.elemStat(el));
        if (!amount) continue;
        counterPen.set(o.actor, { ...(prev || {}), [el]: (prev?.[el] || 0) + amount });
        const saved = before - ctx.effectDmgNoShield(o, r.actor);
        if (!best || saved > best.saved) best = { el, amount, saved };
      }
      if (prev) counterPen.set(o.actor, prev); else counterPen.delete(o.actor);
      return best;
    };
    const casters = cands.filter(ctx.castsDamage);
    let o = cands.find(c => c.actor === declared && ctx.castsDamage(c)) || null;
    if (!o && casters.length) {
      o = casters.map(c => ({ c, b: bestElem(c) }))
        .sort((x, y) => (y.b?.saved ?? -1) - (x.b?.saved ?? -1) || ctx.lifeOf(x.c.actor) - ctx.lifeOf(y.c.actor) || x.c.actor.localeCompare(y.c.actor))[0].c;
    }
    if (!o) o = cands.find(c => c.actor === declared) || null;
    if (!o) continue;
    const tgt = o.actor;
    const kept = (o.skills || []).filter(id => !!sdOf(ctx, id)?.is_permanent);
    const stripped = (o.skills || []).filter(id => !kept.includes(id));
    o.skills = kept;
    const bCs = bestElem(o);
    if (stripped.length || bCs) skillFx.push({ by: r.actor, skill: 'skill_counter_spell', on: tgt, what: 'skills', countered: stripped.filter(id => id !== TRANCE), building: fromBuilding(r.actor, 'skill_counter_spell') });
    if (stripped.includes(TRANCE) && o.trance) { effAction.set(tgt, o.trance[0]); tranceOpts.delete(tgt); o.trance = null; }
    const b = bestElem(o);
    if (b) {
      const pen = counterPen.get(tgt) || {};
      pen[b.el] = (pen[b.el] || 0) + b.amount;
      counterPen.set(tgt, pen);
    }
    if (r.actor === self || tgt === self) log(`[${label}] counter spell ${r.actor.slice(0, 8)} → ${tgt.slice(0, 8)}: stripped [${stripped.join(',')}]${b ? `, −${b.amount} on ${b.el} (saves ${b.saved})` : ', nothing to counter'}`);
  }
}

// ---- hook: negate_action (pass 1 — prohibitions on a whole action: Bluff, Intimidation) ---------------
// They go first: an Attack Intimidation negates never gets to Grapple. Move / Posture skills also ride on
// Empty Move / Empty Posture.
function negateAction(ctx) {
  const { effAction, tranceOpts, byActorPre } = ctx;
  const { has, nonPerm, negate, counterSkills, adjacentFoes, foeFor } = helpers(ctx);
  for (const r of ctx.reveals) {
    if (!(r.skills || []).length) continue;
    const me = r.actor, rides = ridesFor(r);
    // Bluff: the enemy's action is negated and played as Empty Posture.
    if (rides('M') && has(me, 'skill_bluff')) {
      const t = foeFor(r), o = t && byActorPre.get(t);
      if (o && ctx.dist(me, t) <= 1 && (tranceOpts.has(t) || effAction.get(t) !== 'EP')) {
        const what = tranceOpts.has(t) ? tranceOpts.get(t).join('+') : effAction.get(t);
        effAction.set(t, 'EP'); tranceOpts.delete(t); negate(me, 'skill_bluff', o, what);
      }
    }
    // Intimidation: an adjacent enemy's Attack is negated (no combat damage, the card back to their hand);
    // with nobody attacking, it counters a non-permanent skill of an adjacent enemy instead.
    if (rides('P') && has(me, 'skill_intimidation')) {
      const atk = adjacentFoes(me).filter(id => ctx.codeIs(id, 'A'));
      for (const id of atk) { ctx.replace(id, 'A', 'EP'); negate(me, 'skill_intimidation', byActorPre.get(id), 'A'); }
      if (!atk.length) {
        const o = [foeFor(r), ...adjacentFoes(me)].filter(Boolean).map(id => byActorPre.get(id))
          .find(x => x && ctx.dist(me, x.actor) <= 1 && (x.skills || []).some(nonPerm));
        if (o) counterSkills(me, 'skill_intimidation', o);
      }
    }
  }
}

// ---- hook: negate_kind (pass 2 — prohibitions on one kind of action: Grapple, Disruption Move, Overrun) --
// Optional registers (the resolver passes them once its call sites know them — `SKR` hunks in peer.mjs; without
// them the two paper clauses below stay off, everything else is unchanged):
//   ctx.noEmit  Set id    Disruption: this actor's non-instant effect emits nothing this action (resolver voids it)
//   ctx.swaps   [{by, on}] Overrun: the attacker and its adjacent target trade hexes (resolver, after the moves)
function negateKind(ctx) {
  const { byActorPre, noMove, skillFx } = ctx;
  const { has, negate, foeFor, fromBuilding } = helpers(ctx);
  for (const r of ctx.reveals) {
    if (!(r.skills || []).length) continue;
    const me = r.actor, rides = ridesFor(r);
    if (rides('A') && has(me, 'skill_grapple')) { const t = foeFor(r); if (t && ctx.codeIs(t, 'P')) { ctx.replace(t, 'P', 'EP'); negate(me, 'skill_grapple', byActorPre.get(t), 'P'); } }
    // Disruption Move (paper text, user ruling 2026-11-16): "the enemy cannot use Posture; any Empty Posture is always
    // played as Empty Move (enemy cannot emit non-instant effects)". The enemy's Posture is negated (card + riders back
    // to their hand) and played as an Empty Move; an Empty Posture becomes an Empty Move too. That Empty Move goes
    // nowhere (noMove — a Posture keeps no tile) and emits nothing: a non-instant effect riding on it is voided
    // (noEmit), so a cast in progress is interrupted (Rule 19). An Empty Posture turned only counts as the skill's job
    // when it stopped such an emission.
    if (rides('M') && has(me, 'skill_disruption_move')) {
      const t = foeFor(r);
      if (t && ctx.enemyOf(me, t) && (ctx.codeIs(t, 'P') || ctx.codeIs(t, 'EP'))) {
        const o = byActorPre.get(t), wasP = ctx.codeIs(t, 'P');
        const voids = !!ctx.noEmit && !!o?.effect && !o.effect.is_instant;
        ctx.replace(t, 'P', 'EM'); ctx.replace(t, 'EP', 'EM');
        if (!ctx.tranceOpts.has(t)) noMove.add(t);
        if (voids) ctx.noEmit.add(t);
        if (wasP) negate(me, 'skill_disruption_move', o, 'P');
        else if (voids) skillFx.push({ by: me, skill: 'skill_disruption_move', on: t, what: 'EP', building: fromBuilding(me, 'skill_disruption_move') });
      }
    }
    // Overrun: the adjacent target cannot move (its Move is negated); paper text (ruling 2026-11-16): "swap places with
    // the enemy (walk over them and go behind)" — the attacker of a character-targeted Attack trades hexes with that
    // enemy (ctx.swaps, applied by the resolver after the moves). One swap per unit and action, actor order.
    if (rides('A') && has(me, 'skill_overrun')) {
      const t = foeFor(r);
      if (t && ctx.dist(me, t) <= 1) {
        const mv = ctx.codeIs(t, 'M') ? 'M' : ctx.codeIs(t, 'EM') ? 'EM' : null; noMove.add(t); if (mv) negate(me, 'skill_overrun', byActorPre.get(t), mv);
        if (ctx.swaps && ctx.enemyOf(me, t) && r.target?.kind !== 'tile' && !ctx.swaps.some(s => [s.by, s.on].includes(me) || [s.by, s.on].includes(t))) {
          ctx.swaps.push({ by: me, on: t });
          if (!mv) skillFx.push({ by: me, skill: 'skill_overrun', on: t, what: 'swap', building: fromBuilding(me, 'skill_overrun') });
        }
      }
    }
  }
}

// ---- hook: trance_assign (Battle Trance) ---------------------------------------------------------------
// For each adjacent enemy pick the option that benefits the trance actor most (dealt − taken). Each Attack
// option hits at most one enemy; the declared target gets first choice. With nobody adjacent both options
// are played. Writes r.vs (Map enemy → option index) and r.played (Set of indices) on every trance reveal.
// args: { byActor, codeVs(id, other), attacksOn(r, victim) }.
function tranceAssign(ctx, { byActor, codeVs, attacksOn }) {
  for (const r of ctx.reveals) {
    if (!r.trance) continue;
    const me = ctx.view(r.actor);
    if (!me) { r.vs = new Map(); r.played = new Set([0, 1]); continue; }
    const declared = r.target?.kind === 'character' ? r.target.ref : null;
    // Revealers only — their snapshots ride in the reveal, so every peer sees the same set.
    const adj = [...ctx.viewValues()]
      .filter(p => p && p.peer_id !== r.actor && byActor.has(p.peer_id) && p.life > 0 && ctx.enemyOf(r.actor, p.peer_id) && !ctx.hiddenFrom(r.actor, p.peer_id) && ctx.dist(r.actor, p.peer_id) <= 1)
      .map(p => p.peer_id)
      .sort((a, b) => (a === declared ? -1 : b === declared ? 1 : a.localeCompare(b)));
    r.vs = new Map();
    r.played = new Set();
    const usedA = new Set();
    for (const e of adj) {
      const er = byActor.get(e);
      const eCode = er ? codeVs(e, r.actor) : 'EP';
      const eHits = attacksOn(er, r.actor);
      // The enemy's Attack / Move only hurt me if aimed at me; Posture / Block hit anyone adjacent.
      const eAims = eCode === 'A' ? eHits : eCode === 'M' ? er?.target?.kind === 'character' && er.target.ref === r.actor : true;
      let best = -1, bestScore = -Infinity;
      r.trance.forEach((opt, i) => {
        if (opt === 'A' && usedA.has(i)) return;
        const taken = eAims ? ctx.edgeDmg(eCode, opt) : 0;
        const dealt = opt === 'B' && !eHits ? 0 : ctx.edgeDmg(opt, eCode);
        const score = dealt - taken;
        if (score > bestScore) { bestScore = score; best = i; }
      });
      if (best < 0) continue;
      r.vs.set(e, best);
      r.played.add(best);
      if (r.trance[best] === 'A') usedA.add(best);
    }
    if (!adj.length) r.played = new Set([0, 1]);
  }
}

// ---- hooks on one strike (combat damage) ---------------------------------------------------------------
const RW = 'skill_ranged_weapon', TAUNT = 'skill_taunt';
const rangeOf = (id) => SKILL_RULES[id]?.range ?? 1;
// block_in (Ranged Weapon, Taunt): a Block scores against Attacks aimed at the blocker. Returns true when the Block
// does NOT score.  args: { defender (the unit whose Attack the Block meets), blocker }.
//   Ranged Weapon (ruling 2026-11-16): an enemy Block opposed to the holder's Attack from 2 hexes away deals the
//     holder nothing; an adjacent Block deals its regular 1 ("no bonuses on a nearby enemy").
//   Taunt (paper text, ruling 2026-11-16): a nearby enemy cannot use Block against the taunter.
// skillId names the one skill asked (peer.mjs before the SKR hunks asks Ranged Weapon only); null = both, deal order.
const rangedBlockIn = (ctx, { defender, blocker }) => !!(ctx.hasPerm(defender, RW) && ctx.dist(blocker, defender) > 1);
const tauntBlockIn = (ctx, { defender, blocker }) => !!(ctx.hasPerm(defender, TAUNT) && ctx.enemyOf(blocker, defender) && ctx.dist(blocker, defender) <= rangeOf(TAUNT));
const blockIn = (ctx, args, id) => id === RW ? rangedBlockIn(ctx, args) : id === TAUNT ? tauntBlockIn(ctx, args) : (rangedBlockIn(ctx, args) || tauntBlockIn(ctx, args));
// block_cost (Ranged Weapon, Reaver auto-target): 1 when the candidate Blocks — unless I am ranged and it stands
// beyond contact (an adjacent Block costs a ranged attacker like anyone, ruling 2026-11-16).
const blockCost = (ctx, { attacker, defender }) => ctx.codeIs(defender, 'B') && !(ctx.hasPerm(attacker, RW) && ctx.dist(attacker, defender) > 1) ? 1 : 0;
// attack_range (Ranged Weapon, ruling 2026-11-16: "+1 range"): how far a strike of `code` by `attacker` reaches —
// the holder's Attack 2 hexes (flag range), everything else 1 (contact).  args: { attacker, code } → hexes.
const attackRange = (ctx, { attacker, code }) => (code === 'A' && ctx.hasPerm(attacker, RW)) ? rangeOf(RW) : 1;
// attack_out (Powerful Attack): +1 on an Attack that connects.  args: { attacker, dmg } → dmg.
const attackOut = (ctx, { attacker, dmg }) => (dmg >= 1 && helpers(ctx).has(attacker, 'skill_powerful_attack')) ? dmg + 1 : dmg;
// attack_target (Taunt): a nearby taunter is the only legal Attack target — every enemy next to the taunter, every ally
// it attacks is protected. Only revealers count — their snapshots ride in the reveal, so every peer sees the same set.
// args: { attacker, defender } → true = 0 dmg.
const attackTarget = (ctx, { attacker, defender }) => ctx.reveals.some(t => t.actor !== defender && t.actor !== attacker
  && ctx.enemyOf(attacker, t.actor) && ctx.hasPerm(t.actor, 'skill_taunt') && ctx.dist(attacker, t.actor) <= 1);
// attack_vs_block (Taunt, paper text "nearby enemies cannot use Block against you"): the defender's Block does not
// count against the taunter's Attack — it lands as against an Empty action (matrix A vs EP = 1, not A vs B = 0).
// args: { attacker, defender } → true = ignore the Block.
const attackVsBlock = (ctx, { attacker, defender }) => !!(ctx.hasPerm(attacker, TAUNT) && ctx.enemyOf(attacker, defender) && ctx.dist(attacker, defender) <= rangeOf(TAUNT));
// defend_in (Barricade, then Sanctuary): Barricade stops Attack / Block damage; a Sanctuary holder takes none while
// its action does not end the Sanctuary (below).  args: { code, defender, dmg, byActor } → dmg. code 'effect' = effect
// damage (only Sanctuary acts on it).
const barricade = (ctx, { code, defender, dmg }) => ((code === 'A' || code === 'B') && ctx.hasPerm(defender, 'skill_barricade')) ? 0 : dmg;
// Sanctuary (user ruling 2026-11-16: "you should be able to move around and prepare your hand in the next turns being
// invincible"; paper: "invincible until you emit or perform any action"): it holds while the holder only moves or
// rests — Move, Empty Move, Empty Posture — with no skill (a building's free skill excepted), no effect and no
// Rule 24 destroy emission. Anything else (Attack, Block, Posture, a Battle Trance option among them, a skill, an
// emission) ends it, and in that action the holder is already unprotected. A unit without a reveal rests.
const SANCTUARY_KEEPS = ['M', 'EM', 'EP'];
export function sanctuaryBreaks(r) {
  if (!r) return false;
  const d = r.declared ?? r.action;
  const codes = d === 'BT' ? (r.trance || []) : [d];
  return codes.some(c => !SANCTUARY_KEEPS.includes(c)) || (r.skills || []).filter(id => id !== r.buildingSkill).length > 0 || !!r.effect || !!r.destroy;
}
const sanctuary = (ctx, { defender, dmg, byActor }) => (ctx.hasPerm(defender, 'skill_sanctuary') && !sanctuaryBreaks(byActor.get(defender))) ? 0 : dmg;
const defendIn = (ctx, args) => sanctuary(ctx, { ...args, dmg: barricade(ctx, args) });

// ---- hook: damage_in (Dodge) ---------------------------------------------------------------------------
// "One less damage done to you this action" — one point off the combat damage I take this round, not one
// per attacker.  args: { damage } (Map victim → [{source, amount, attacker}], edited in place).
function damageIn(ctx, { damage }) {
  const { has, fromBuilding } = helpers(ctx);
  for (const [victim, list] of damage) {
    if (!has(victim, 'skill_dodge')) continue;
    const hit = list.find(d => d.source === 'action' && d.amount > 0);
    if (hit) { hit.amount -= 1; ctx.skillFx.push({ by: victim, skill: 'skill_dodge', on: hit.attacker, what: 'damage', building: fromBuilding(victim, 'skill_dodge') }); }
  }
}

// ---- hooks: effect_in / effect_leg (Force Shield) -----------------------------------------------------
// Effect damage (Rule 21) is rounded per leg; before rounding, the Force Shield die comes off the first leg
// that would otherwise land, and is spent by that (user ruling: die absorbs before rounding).
const effectIn = (ctx, { defender }) => ctx.hasPerm(defender, 'skill_force_shield') ? (ctx.permPower(defender).skill_force_shield || 0) : 0;
// args: { shield, sum } → { shield, sum, spent } (spent = the die when it absorbed this leg, else 0).
const effectLeg = (_ctx, { shield, sum }) => (shield && roundHalfUp10(sum) > 0) ? { shield: 0, sum: Math.max(0, sum - shield), spent: shield } : { shield, sum, spent: 0 };

// ---- hooks after the action (end_round, perm_landing) --------------------------------------------------
// end_round (Sanctuary): it holds while I only move or rest (sanctuaryBreaks above — ruling 2026-11-16); an action
// that breaks it ends it from the next action.  args: { reveal } (my reveal after resolution) → true = it falls.
const leftSanctuary = (_ctx, { reveal: myR }) => sanctuaryBreaks(myR);
// perm_landing: the permanent skills I played that take hold (a trance only lands those whose action
// code was played), each with the stat its Rule 12 point-buy uses ('any' = my best stat, first on ties) and,
// when the skill's data has `fixed_power` (Force Shield: "always power 6", ruling 2026-11-16), that power — no roll.
// args: { skillIds, playedCodes (Set|null), stats ({vitality, …}) } → [{ id, stat[, power] }] in skillIds order.
function permLanding(ctx, { skillIds, playedCodes, stats }) {
  const out = [];
  for (const id of skillIds || []) {
    const sd = sdOf(ctx, id);
    if (sd?.is_permanent && (!playedCodes || playedCodes.has(sd.action_type))) {
      const st = sd.point_buy_stat === 'any'
        ? ['vitality', 'world', 'matter', 'will'].sort((a, b) => stats[b] - stats[a])[0]
        : (sd.point_buy_stat || 'stat_vitality').replace(/^stat_/, '');
      out.push(Number.isInteger(sd.fixed_power) ? { id, stat: st, power: sd.fixed_power } : { id, stat: st });
    }
  }
  return out;
}
// plan_lock (Powerful Attack, paper text, ruling 2026-11-16: "cannot perform any other action except Attack until end
// of round"): the action codes I may still play this round after the skill paid off (its card did not return to my
// hand), else null.  args: { paid } → ['A'] | null. Applied at planning by peer.mjs (SKR hunk).
export const PLAN_LOCKS = Object.freeze({ skill_powerful_attack: Object.freeze(['A']) });
const planLock = (id, { paid }) => (paid && PLAN_LOCKS[id]) ? [...PLAN_LOCKS[id]] : null;
// perm_stats (Rule 24): the stats a permanent skill can be destroyed by (point_buy_stat; 'any' = all four;
// none → vitality).
const permStats = (ctx, id) => { const st = sdOf(ctx, id)?.point_buy_stat; return st === 'any' ? ['vitality', 'world', 'matter', 'will'] : st ? [st.replace(/^stat_/, '')] : ['vitality']; };

// ---- hook: disposition (Rule 8 card bookkeeping, user ruling 2026-11-12) -----------------------------
// What happens to one skill card I played this action. args: { fx (skillFx of the real run), self }.
//   'permanent'  stays in play (landing is perm_landing's business)
//   'negated'    rode on my action that an enemy negated → back to my hand with the action card
//   'countered'  an enemy countered it → discarded
//   'spent'      a negating skill that did its job → discarded
//   'unused'     a negating skill that found nothing to do → back to my hand
//   'judge'      any other instant → judged by the Rule 8 damage counterfactual (peer.mjs roundWithout)
function disposition(ctx, id, { fx, self }) {
  if (sdOf(ctx, id)?.is_permanent) return 'permanent';
  const onMe = fx.filter(f => f.on === self);
  if (onMe.some(f => (f.ridden || []).includes(id))) return 'negated';
  if (onMe.some(f => (f.countered || []).includes(id))) return 'countered';
  if (NEGATING_SKILLS.has(id)) return fx.some(f => f.by === self && f.skill === id && !f.building) ? 'spent' : 'unused';
  return 'judge';
}

// ---- dispatcher -----------------------------------------------------------------------------------------
// skillHook(hookName, skillId, ctx, args) → result. `skillId` names the skill for single-skill hooks; pass
// hooks (counter_pre, negate_action, negate_kind, defend_in with null) run every skill of that hook in the
// fixed order of the old inline code.
export const HOOKS = {
  rides: (_id, _ctx, { codes, req }) => ridesOn(codes, req),
  plan_target: (_id, _ctx, { skillIds }) => planTarget(skillIds),
  counter_pre: (_id, ctx) => counterPre(ctx),
  negate_action: (_id, ctx) => negateAction(ctx),
  negate_kind: (_id, ctx) => negateKind(ctx),
  trance_assign: (_id, ctx, args) => tranceAssign(ctx, args),
  block_in: (id, ctx, args) => blockIn(ctx, args, id),
  block_cost: (_id, ctx, args) => blockCost(ctx, args),
  attack_range: (_id, ctx, args) => attackRange(ctx, args),
  attack_out: (_id, ctx, args) => attackOut(ctx, args),
  attack_target: (_id, ctx, args) => attackTarget(ctx, args),
  attack_vs_block: (_id, ctx, args) => attackVsBlock(ctx, args),
  defend_in: (id, ctx, args) => id === 'skill_barricade' ? barricade(ctx, args) : id === 'skill_sanctuary' ? sanctuary(ctx, args) : defendIn(ctx, args),
  damage_in: (_id, ctx, args) => damageIn(ctx, args),
  effect_in: (_id, ctx, args) => effectIn(ctx, args),
  effect_leg: (_id, ctx, args) => effectLeg(ctx, args),
  end_round: (_id, ctx, args) => leftSanctuary(ctx, args),
  perm_landing: (_id, ctx, args) => permLanding(ctx, args),
  perm_stats: (id, ctx) => permStats(ctx, id),
  disposition: (id, ctx, args) => disposition(ctx, id, args),
  plan_lock: (id, _ctx, args) => planLock(id, args),
};
export const HOOK_NAMES = Object.keys(HOOKS);
// jsHook(hookName, skillId, ctx, args) — what skills.mjs#skillHook returned under SKILL_ENGINE=js before the isolation
// (the built-ins' JS hook; foreign skills fold in on the dispatcher's side).
export function jsHook(hookName, skillId, ctx, args = {}) {
  const h = HOOKS[hookName];
  if (!h) throw new Error(`skills-js.mjs: unknown hook ${hookName}`);
  return h(skillId, ctx, args);
}
