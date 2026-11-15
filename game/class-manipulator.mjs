// Pure rules for the Manipulator class — user ruling 2026-11-14 ("Fix Manipulator").
// No I/O, no peer state: peer.mjs feeds reveals / snapshot values in, tools/effects-check.mjs checks the oracles.
//
// Passive, once per TURN (hg.turn = 3 actions): the first time in a turn the Manipulator is about to take
// COMBAT damage (Attack / Block / Posture strike via the damage matrix, main action only — not bonus rounds,
// traps, tokens, spells or combos), the ability fires by itself and is spent for the turn. A random enemy
// within `range` hexes (pre-action tiles) returns the Action it revealed to its hand and plays another Action
// card from its hand instead — possibly the same kind ("so bad for you") — and the action is resolved again.
//
// Determinism (hands are private): every unit standing within `publish_range` of an enemy Manipulator commits a
// fallback `manip_alt` with its reveal — the code (+ target) of one random OTHER Action card of its hand, or EP
// when it holds none. It is part of the commit hash, so the replacement is fixed before anyone sees the action;
// every peer swaps the same reveal to the same alt in the same action. Leak: one random action code per action,
// only while near an enemy Manipulator.

export const MANIPULATOR_DEFAULTS = { range: 3, publish_range: 6 };

const num = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
export function manipulatorConfig(data = {}) {
  return { range: num(data.range, MANIPULATOR_DEFAULTS.range), publishRange: num(data.publish_range, MANIPULATOR_DEFAULTS.publish_range) };
}

// The fallback the target commits: one random Action card of the hand other than the played one (and other than
// cards already spent by bonus plans / Battle Trance). `rnd` is the target's own randomness (private choice).
export function pickAltAction(hand, excludeIds, rnd = Math.random) {
  const ex = new Set((excludeIds || []).filter(Boolean));
  const pool = (hand || []).filter(c => c && c.kind === 'action' && !ex.has(c.card_id));
  if (!pool.length) return { code: 'EP', card_id: null };
  const c = pool[Math.floor(rnd() * pool.length) % pool.length];
  return { code: c.code, card_id: c.card_id };
}

// "About to get combat damage": a positive matrix strike of the main action in the damage list.
export const combatHit = (list) => (list || []).some(d => d && d.source === 'action' && !d.bonus && d.amount > 0);

// The random nearby enemy: candidates sorted by id, index from the Manipulator's reveal salt.
export function pickManipTarget(seed, candidateIds, sha256Hex) {
  const ids = [...candidateIds].sort();
  return ids.length ? ids[parseInt(sha256Hex(seed).slice(0, 8), 16) % ids.length] : null;
}

// Swap the target's reveal in place: its action (and any skill riding on it, Battle Trance included) goes back to
// its hand, the committed alt is played bare. A building's free skill keeps riding. A non-instant cast survives
// only if the new action still emits (`emits(code)`), a Rule 24 emission likewise. Returns { old, new }.
export function applyManipSwap(r, alt, emits = (c) => c === 'P' || c === 'EP') {
  const old = r.trance ? 'BT' : r.action;
  const code = ['A', 'B', 'M', 'P', 'EM', 'EP'].includes(alt?.code) ? alt.code : 'EP';
  r.action = code;
  r.target = alt?.target || null;
  r.trance = null;
  r.skills = r.buildingSkill ? [r.buildingSkill] : [];
  if (r.effect && !r.effect.is_instant && !emits(code)) r.effect = null;
  if (r.destroy && !emits(code)) r.destroy = null;
  r.manipulated = { old, new: code };
  return { old, new: code };
}
