// The class configs of the built-in classes — JS TEST ORACLES (class isolation phase 6, 2026-11-20). The resolver never
// imports this file: every class's knobs come from its definition's `config` program (lib classes_std cfg_*). The JS
// reference hooks (./classes-js.mjs) and the checks (classes-check, effects-check, chase-check, fortress-check) compare
// the programs against these. Moved verbatim from game/class-{world,traps,chase,manipulator}.mjs (their generic
// primitives went to game/world-prims.mjs / game/contact-prims.mjs). Lives in chaosD6-Classes (classes-repo-sync).

// ---- from class-world.mjs (Animator, Priest, Seeker)
// Pure helpers for the map-placing classes reworked by user rulings 2026-11-14 — Animator (a copy of the
// building nearest to me rises on a hex next to me), Priest (a Shrine rises on a hex near me) and Seeker (an
// effect card as a trap building 20–30 hexes away, with vision there until the end of my next turn). Shared by
// peer.mjs (resolver) and tools/fortress-check.mjs (oracles). Everything is deterministic in its arguments
// (salt hash, sorted candidates).
export const ANIMATOR_DEFAULTS = { near: 2, place_range: 1 };
export const PRIEST_DEFAULTS = { place_range: 2, building: { label: 'Shrine', power: 'mend' } };
export const SEEKER_DEFAULTS = { distance: [20, 30], vision_radius: 5, vision_turns: 1 };

const posInt = (v, lo = 0) => Number.isInteger(v) && v >= lo;
// classes.json class_animator data → { near (building search radius), place (how far the copy may rise) }.
export function animatorConfig(d = {}) {
  return { near: posInt(d?.near, 1) ? d.near : ANIMATOR_DEFAULTS.near, place: posInt(d?.place_range, 1) ? d.place_range : ANIMATOR_DEFAULTS.place_range };
}
// classes.json class_priest data → { place, label, power, heal } (the Shrine it raises; power 'mend' = +heal life at
// the end of the turn's 3rd action, js/building-bonus.js). CP 2026-11-19 (user pick 5 a): building.heal (the Priest's
// Shrine heals 2); default 1.
export function priestConfig(d = {}) {
  const b = d?.building && typeof d.building === 'object' ? d.building : {};
  return {
    place: posInt(d?.place_range, 1) ? d.place_range : PRIEST_DEFAULTS.place_range,
    label: typeof b.label === 'string' && b.label ? b.label : PRIEST_DEFAULTS.building.label,
    power: typeof b.power === 'string' && b.power ? b.power : PRIEST_DEFAULTS.building.power,
    heal: posInt(b.heal, 1) ? b.heal : 1,
  };
}
// CR (user class rulings 2026-11-17): how many of the class's own placements may stand at once — Priest "one Shrine per
// Priest at a time, a new one replaces the old", Seeker "at most one planted trap standing (a new one replaces the
// old)". data.max_standing (an integer ≥ 1) → that number; absent → null (no limit, the 2026-11-14 rules).
export const maxStanding = (d = {}) => (posInt(d?.max_standing, 1) ? d.max_standing : null);
// classes.json class_seeker data → { min, max, radius, turns } (turns: vision lasts until the end of turn + turns).
export function seekerConfig(d = {}) {
  const ok = Array.isArray(d?.distance) && d.distance.length === 2 && d.distance.every(x => posInt(x, 1)) && d.distance[0] <= d.distance[1];
  const [min, max] = ok ? d.distance : SEEKER_DEFAULTS.distance;
  return { min, max, radius: posInt(d?.vision?.radius) ? d.vision.radius : SEEKER_DEFAULTS.vision_radius, turns: SEEKER_DEFAULTS.vision_turns };
}

// ---- from class-traps.mjs (Rogue, Cleric)
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
// CR (user class ruling 2026-11-17, Rogue): "one shared charge per turn (trap dodge OR unseen step)" — data
// shared_charge: true → spending either charge spends both for the turn (a trap dodge wins when one step needs both).
export const rogueShared = (data = {}) => data?.shared_charge === true;
export function clericConfig(data = {}) {
  return { range: num(data.disable_range, CLERIC_DEFAULTS.disable_range) };
}

// ---- from class-chase.mjs (Avenger, Prophet)
// Pure rules for the chase / contact classes (Avenger, Prophet) — user rulings 2026-11-14.
// No I/O, no peer state: peer.mjs feeds snapshot values in, tools/chase-check.mjs checks the oracles.
//
// Avenger (active, once per turn — the class card clicked):
//   - lure: every living wild monster (an enemy creature with a monster_state, no owner) within
//     `lure_range` (10) hexes of the Avenger wakes and starts chasing the Avenger (snapshot lured_by /
//     chase_target on the monster). The monster keeps chasing until the Avenger dies or leaves the map.
//   - chase bonus: each time a NEW monster starts chasing the Avenger (lured, or a wild monster that picks
//     the Avenger as its prey by itself) the Avenger gets a temporary +1 life max (and +1 life), never more
//     than `chase_bonus.max` (1) in total. The point is lost first on damage (after illusion / armor) and
//     fades when no monster chases the Avenger any more; a new chaser grants it again.
//     CP 2026-11-19 (user pick 9 a, data chase_bonus.max_only): +1 life MAX only, no +1 life with it — the point
//     then absorbs no damage (it is still the first one lost) and losing it never costs a life point.
// Prophet (passive, once per turn): the first resolution of a turn that ends with an enemy (hero or
//   monster, not invisible) in CONTACT — adjacent, `contact` hexes (1), the same "in contact" as the Sleep
//   trap and the in_contact named rule — shows the Prophet that enemy's whole hand (popup).

export const AVENGER_DEFAULTS = { lure_range: 10, chase_bonus: { life: 1, max: 1 } };
export const PROPHET_DEFAULTS = { contact: 1 };


export function avengerConfig(data = {}) {
  const cb = data.chase_bonus || {};
  return {
    range: num(data.lure_range, AVENGER_DEFAULTS.lure_range),
    per: num(cb.life, AVENGER_DEFAULTS.chase_bonus.life),
    max: num(cb.max, AVENGER_DEFAULTS.chase_bonus.max),
    maxOnly: cb.max_only === true,   // CP 2026-11-19 (pick 9 a): the bonus is +life MAX only — no +life with it
  };
}
export function prophetConfig(data = {}) {
  return { contact: num(data.contact, PROPHET_DEFAULTS.contact) };
}

// ---- from class-manipulator.mjs (Manipulator)
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

export function manipulatorConfig(data = {}) {
  return { range: num(data.range, MANIPULATOR_DEFAULTS.range), publishRange: num(data.publish_range, MANIPULATOR_DEFAULTS.publish_range) };
}
