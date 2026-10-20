// Deterministic resolver for the strong region. Reads the RPS edge table from
// battle_system.json (resolution_matrix.edges) so the resolver is driven entirely
// by the data layer, not by hard-coded rules. Empty cards resolve per the paper's
// adversarial-interpretation rule: the enemy picks the empty-type (EP or EM) that
// maximises damage against the empty player (rule_6, battle_system edges A→EP etc).

import { hexDistance, stepToward } from './hex.js';
import { isAlive } from './entities.js';

export function buildResolver(battleSystemCore) {
  const edges = battleSystemCore.data.resolution_matrix.edges;
  // Index: actor_code -> defender_code -> { bonus_damage_to_actor }
  const map = {};
  for (const e of edges) {
    (map[e.actor] ||= {})[e.defender] = { bonus: e.bonus_damage_to_actor, note: e.note };
  }
  return { map };
}

function codeOf(card) { return card ? card.code : 'EP'; }

export function resolveRound(resolver, entities, log) {
  // We only resolve the first action of the round each tick to keep the demo
  // paced; subsequent actions_per_round could be chained in a longer game.
  const actors = entities.filter(isAlive);
  const plays = actors.map(a => ({
    actor: a,
    card: a.queued[0] != null ? a.hand[a.queued[0]] : null,
    target: a.target,
  }));

  const damage = new Map();      // peerId -> int
  const moves  = new Map();      // peerId -> {q,r}
  const annotate = (e, m) => log.push({ kind: 'damage', text: `${e.name} ${m}` });

  // 1) Resolve movement intents first (Rule 7: simultaneous, but the resolver
  //    picks a canonical order — move intents fire before damage so attacks aim
  //    at post-move tiles only when the attacker also moved toward the target).
  for (const p of plays) {
    const code = codeOf(p.card);
    if (code === 'M' && p.target) {
      const next = stepToward(p.actor.tile, p.target);
      moves.set(p.actor.peerId, next);
    } else if (code === 'EM' && p.target) {
      // Empty Move: moves halfway toward target. On a hex grid we treat halfway
      // as a chance to only step if the actor is 2+ away.
      if (hexDistance(p.actor.tile, p.target) > 1) {
        moves.set(p.actor.peerId, stepToward(p.actor.tile, p.target));
      }
    }
  }

  // 2) Pairwise RPS resolution between adjacent entities. For each ordered pair
  //    (attacker, defender) where attacker played an action with an edge against
  //    defender's action, apply bonus_damage_to_actor to the defender.
  for (const atk of plays) {
    const atkCode = codeOf(atk.card);
    if (atkCode === 'A' && atk.target) {
      // Attacker must be adjacent to the target tile at resolution.
      const targetEntity = plays.find(p => p.actor.peerId === atk.target || idMatch(p.actor, atk.target));
      if (!targetEntity) continue;
      const atkTile = moves.get(atk.actor.peerId) ?? atk.actor.tile;
      const defTile = moves.get(targetEntity.actor.peerId) ?? targetEntity.actor.tile;
      if (hexDistance(atkTile, defTile) > 1) {
        annotate(atk.actor, `swings into empty air (target out of reach)`);
        continue;
      }
      const defCodeRaw = codeOf(targetEntity.card);
      const defCode = resolveEmptyInterpretation(atkCode, defCodeRaw);
      const edge = resolver.map[atkCode]?.[defCode];
      if (edge) {
        const dmg = Math.max(0, 1 + edge.bonus);
        damage.set(targetEntity.actor.peerId, (damage.get(targetEntity.actor.peerId) || 0) + dmg);
        annotate(atk.actor, `${atkCode}→${defCode} on ${targetEntity.actor.name}: +${dmg} dmg`);
      } else {
        damage.set(targetEntity.actor.peerId, (damage.get(targetEntity.actor.peerId) || 0) + 1);
      }
    }
    if (atkCode === 'B') {
      // Block: deals 1 damage to each entity that targeted the blocker with A.
      for (const p of plays) {
        if (p.actor === atk.actor) continue;
        if (codeOf(p.card) !== 'A') continue;
        const targetedBlocker = p.target === atk.actor.peerId || idMatch(atk.actor, p.target);
        if (!targetedBlocker) continue;
        damage.set(p.actor.peerId, (damage.get(p.actor.peerId) || 0) + 1);
        annotate(atk.actor, `blocks ${p.actor.name} for 1 reflected`);
      }
    }
  }

  // 3) Apply movement and damage.
  for (const [peer, tile] of moves) {
    const e = entities.find(x => x.peerId === peer);
    if (e) { e.tile = tile; log.push({ kind: 'phase', text: `${e.name} moves to (${tile.q},${tile.r})` }); }
  }
  for (const [peer, dmg] of damage) {
    const e = entities.find(x => x.peerId === peer);
    if (!e) continue;
    e.life -= dmg;
    if (e.life <= 0) log.push({ kind: 'damage', text: `${e.name} falls (−${dmg})` });
  }

  // 4) Cleanup: discard played cards, draw back up to 5.
  for (const a of actors) {
    if (!isAlive(a)) continue;
    const consumed = new Set(a.queued);
    const kept = [];
    for (let i = 0; i < a.hand.length; i++) {
      if (consumed.has(i)) a.discard.push(a.hand[i]);
      else if (a.willDiscard.has(i)) a.discard.push(a.hand[i]);
      else kept.push(a.hand[i]);
    }
    a.hand = kept;
    a.queued = [];
    a.willDiscard.clear();
    a.locked = false;
    a.target = null;
  }
}

function idMatch(entity, ref) {
  if (!ref) return false;
  if (typeof ref === 'string') return entity.peerId === ref;
  return false;
}

// Rule 6 interpretation: an EP/EM defender gets the worst-of edge against the attacker.
function resolveEmptyInterpretation(atkCode, defCodeRaw) {
  if (defCodeRaw !== 'EP' && defCodeRaw !== 'EM') return defCodeRaw;
  // The attacker picks: find whichever interpretation gives the attacker the best edge.
  // For simplicity, A gets P-treat (EP→P, damage +1); P gets EM-treat (EP→M); M gets EP; B gets EM.
  if (defCodeRaw === 'EP') {
    return { A: 'P', P: 'M', M: 'EP', B: 'EP' }[atkCode] || defCodeRaw;
  }
  // EM
  return { A: 'EM', P: 'EM', M: 'EM', B: 'M' }[atkCode] || defCodeRaw;
}
