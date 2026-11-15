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
// Prophet (passive, once per turn): the first resolution of a turn that ends with an enemy (hero or
//   monster, not invisible) in CONTACT — adjacent, `contact` hexes (1), the same "in contact" as the Sleep
//   trap and the in_contact named rule — shows the Prophet that enemy's whole hand (popup).

export const AVENGER_DEFAULTS = { lure_range: 10, chase_bonus: { life: 1, max: 1 } };
export const PROPHET_DEFAULTS = { contact: 1 };

const num = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);

export function avengerConfig(data = {}) {
  const cb = data.chase_bonus || {};
  return {
    range: num(data.lure_range, AVENGER_DEFAULTS.lure_range),
    per: num(cb.life, AVENGER_DEFAULTS.chase_bonus.life),
    max: num(cb.max, AVENGER_DEFAULTS.chase_bonus.max),
  };
}
export function prophetConfig(data = {}) {
  return { contact: num(data.contact, PROPHET_DEFAULTS.contact) };
}

// A wild monster as seen in a snapshot: a creature that sleeps or is awake (monster_state) and has no owner.
export function isWildMonster(s) {
  return !!s && (s.monster_state === 'sleeping' || s.monster_state === 'awake') && !s.owner_peer_id;
}

// Monsters the Avenger lures: `cands` = [{ id, wild, enemy, alive, d }] (d = hex distance to the Avenger);
// living wild enemy monsters within range, sorted by id (deterministic on every peer).
export function lureTargets(cands, range) {
  return cands.filter(c => c && c.wild && c.enemy && c.alive && Number.isInteger(c.d) && c.d <= range).map(c => c.id).sort();
}

// One step of the Avenger's chase bonus. `state` = { chasers: [ids], bonus: 0..max } (what I had),
// `chasingNow` = ids of the monsters chasing me this action. Returns the new state plus what changed:
//   fresh  — the monsters that started chasing me now (not in the previous chaser list)
//   grant  — life points to add (to life max AND life): only when someone fresh came and room is left
//   fade   — the bonus is dropped (nobody chases me any more)
export function chaseBonusStep(state, chasingNow, cfg = avengerConfig()) {
  const prev = new Set(state?.chasers || []);
  const now = [...new Set(chasingNow || [])].sort();
  const fresh = now.filter(id => !prev.has(id));
  let bonus = Math.max(0, Number(state?.bonus) || 0);
  let grant = 0, fade = false;
  if (!now.length && bonus > 0) { fade = true; bonus = 0; }
  else if (fresh.length && bonus < cfg.max) { grant = Math.min(cfg.per * fresh.length, cfg.max - bonus); bonus += grant; }
  return { chasers: now, bonus, fresh, grant, fade };
}

// Prophet: whom to look at among the enemies in contact. `foes` = [{ id, fought }] (fought = we targeted each
// other this action); one I fought first, then the smallest id.
export function prophetPick(foes) {
  const s = [...(foes || [])].filter(Boolean).sort((a, b) => (Number(!!b.fought) - Number(!!a.fought)) || String(a.id).localeCompare(String(b.id)));
  return s[0]?.id || null;
}
