// Pure rules for the trap / threat classes (Rogue, Cleric) — user rulings 2026-11-14.
// No I/O, no peer state: peer.mjs feeds snapshot values in, tools/effects-check.mjs checks the oracles.
//
// Rogue (passive, two separate charges, each N per turn from class data):
//   - trap charge: a step that would spring a trap (laid enter-trap, a building's hidden trap, an unexplored
//     dungeon at the turn's 3rd action) springs nothing; the trap stays where it is.
//   - threat charge: a step that ends inside an enemy's threat ring (2 hexes) is unseen — monsters / NPC
//     enemies neither wake nor chase ("chain") the Rogue for the rest of the turn (stealth_turn).
// Cleric:
//   - active (tap): every trap within `disable_range` hexes that is not mine is disabled; a laid trap's card
//     goes to its OWNER's discard pile, a world trap (building / dungeon) is simply gone.
//   - passive: stepping onto a building tile with trap(s) springs none of them — no damage, no effect — and
//     every one of those trap cards joins the Cleric's discard pile.

export const ROGUE_DEFAULTS = { trap_dodges_per_turn: 1, threat_dodges_per_turn: 1, threat_radius: 2 };
export const CLERIC_DEFAULTS = { disable_range: 3 };

const num = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);

// Rogue knobs from the class's active data version (missing → defaults).
export function rogueConfig(data = {}) {
  return {
    trapPerTurn: num(data.trap_dodges_per_turn, ROGUE_DEFAULTS.trap_dodges_per_turn),
    threatPerTurn: num(data.threat_dodges_per_turn, ROGUE_DEFAULTS.threat_dodges_per_turn),
    threatRadius: num(data.threat_radius, ROGUE_DEFAULTS.threat_radius),
  };
}
export function clericConfig(data = {}) {
  return { range: num(data.disable_range, CLERIC_DEFAULTS.disable_range) };
}

// How many uses of a per-turn charge are left: `usedTurn` / `usedN` are the snapshot's record of the last
// turn it was used and how often in that turn.
export function chargesLeft(perTurn, usedTurn, usedN, turn) {
  const used = usedTurn === turn ? Math.max(0, Number(usedN) || 0) : 0;
  return Math.max(0, perTurn - used);
}

// Traps within `range` of `here`, sorted by id (deterministic pick order across peers).
export function trapsInRange(traps, here, range, dist) {
  return traps.filter(tp => Number.isInteger(tp.q) && Number.isInteger(tp.r) && dist(here, tp) <= range)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// Where a disabled trap's card goes. `mode` = 'active' (Cleric's tap: owner's discard; world traps vanish)
// or 'passive' (the Cleric stepped onto a trapped building: the Cleric's discard pile).
// Returns the trapsSpent fields: `victim` = who records the world edit (the Cleric), `to` = whose discard
// pile gets the card (null = nobody). peer.mjs: card moves to `to` when `to` is set and is not the owner;
// `to === owner` = the owner's held card goes back to the owner's own discard pile.
export function clericRoute(trap, cleric, mode) {
  if (mode === 'passive') return { victim: cleric, to: cleric };
  return { victim: cleric, to: trap.owner === 'world' ? null : trap.owner };
}
// Does the card of a disabled trap change hands? (the owner's held card leaves their deck)
export const disabledCardMoves = (ts) => !!ts.to && ts.to !== ts.owner;
