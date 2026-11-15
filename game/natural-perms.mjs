// Monster natural permanents (user rulings 2026-11-15, data/rules.json rule_monster_natural_permanents).
// A monster's innate effect (creatures.json data.innate_effect) is a Permanent card: every wild monster with
// one STARTS with `copies` (2) of it already cast, power `power` (6) each (Rule 24), held in play, none in its
// deck. Pure helpers only — peer.mjs owns the state and calls these with plain values, so effects-check can
// test every semantic with the worked examples and every peer judges the same way.
//
// Two copies — design (least invasive for the Set-by-id permanents): the id stays ONCE in entity.permanents /
// permanents_csv / perm_power_json (power 6 = each copy's power); the number of copies still standing lives
// next to it in entity.permCopies { id: n } → snapshot `perm_copies_json`. Every existing reader
// (Rule 24 candidatesOf / permStats via element_cost, hasPerm, Delay-Time-style readers of another peer's
// permanents_csv, the perms strip) keeps working unchanged; Rule 24 destroying the perm = one copy
// (dropPermanent decrements, releases ONE held card, and only the last copy really drops the permanent).

export const NATURAL_DEFAULTS = { copies: 2, power: 6, applies_to: 'wild_creatures' };
export const naturalConfig = (d) => ({ ...NATURAL_DEFAULTS, ...(d || {}) });

// What each natural permanent does while it stands (the semantics the user accepted 2026-11-15).
export const NATURAL_KINDS = {
  effect_earthquake: 'turn_tick',      // end of every engine turn: Earthquake's delta damage to every enemy in contact
  effect_creation: 'ward',             // enemies with Matter < mine cannot enter my adjacent hexes
  effect_spirit_link: 'link',          // linked to the nearest allied creature (alone: nothing)
  effect_love: 'spare_holder',         // an enemy that came in contact cannot damage me until it visits its tower
  effect_awe: 'spare_holder',
  effect_fear: 'no_damage',            // … cannot damage anyone until it visits its tower
  effect_anger: 'only_holder',         // … in contact with me may only attack / damage me (forced target)
  effect_domination: 'lose_action',    // an enemy in contact loses one action per turn (Delay Time model)
  effect_petrify: 'stone',             // an enemy in contact is locked for the rest of the turn, each turn
  effect_mists: 'no_attack',           // adjacent enemies cannot Attack while in contact
};
// Natural permanents that leave a contact affliction on the enemy (lifted at its tower or when the perms fall).
export const CONTACT_AFFLICTIONS = ['effect_love', 'effect_awe', 'effect_fear', 'effect_anger'];

// The innate effect a creature starts with as natural permanents, or null (15 creatures have none).
export function naturalPermFor(creatureData, effectsById, cfg = NATURAL_DEFAULTS) {
  const id = creatureData?.innate_effect || null;
  if (!id || !effectsById?.[id] || !(cfg.copies > 0)) return null;
  return { id, copies: cfg.copies, power: cfg.power };
}

// perm_copies_json → { id: n } (n ≥ 1 only).
export function parseCopies(s) {
  let v = null;
  try { v = typeof s === 'string' ? JSON.parse(s || '{}') : s; } catch { v = null; }
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, n] of Object.entries(v)) if (Number.isInteger(n) && n > 0) out[k] = n;
  return out;
}

// One copy falls (Rule 24, Phylactery …): → { copies (new map), left, last } — `last` = the permanent itself goes.
export function dropOneCopy(copies, id) {
  const c = { ...(copies || {}) };
  const n = c[id] || 0;
  if (n > 1) { c[id] = n - 1; return { copies: c, left: n - 1, last: false }; }
  delete c[id];
  return { copies: c, left: 0, last: true };
}

// Love / Awe / Fear / Anger damage gate. `afflictions` = the ATTACKER's afflictions ([{effect_id, by, natural}]);
// holds(by, effect_id) = that monster still holds the natural permanent and lives; dist(a, b) hex distance.
// → the affliction that blocks this damage, or null. Self-damage is never blocked.
export function naturalDamageBlock({ attacker, victim, afflictions, holds, dist }) {
  if (!attacker || !victim || attacker === victim) return null;
  const list = (afflictions || []).filter(a => a && a.natural && CONTACT_AFFLICTIONS.includes(a.effect_id) && a.by && a.by !== attacker && holds(a.by, a.effect_id))
    .sort((a, b) => a.effect_id.localeCompare(b.effect_id) || String(a.by).localeCompare(String(b.by)));
  for (const a of list) {
    if (a.effect_id === 'effect_fear') return a;
    if ((a.effect_id === 'effect_love' || a.effect_id === 'effect_awe') && victim === a.by) return a;
    if (a.effect_id === 'effect_anger' && victim !== a.by && dist(attacker, a.by) <= 1) return a;
  }
  return null;
}

// Anger: the holder an afflicted actor in contact must aim at (the first by id), or null.
export function angerForcedTarget({ actor, afflictions, holds, dist }) {
  return (afflictions || []).filter(a => a && a.natural && a.effect_id === 'effect_anger' && a.by && a.by !== actor && holds(a.by, 'effect_anger') && dist(actor, a.by) <= 1)
    .map(a => a.by).sort()[0] || null;
}

// The contact afflictions a unit picks up after an action: holders = [{ id, effect_id, dist }] of living ENEMY
// natural holders (dist from my post-move tile). None while I stand on my tower (it lifts them).
export function contactAfflictions({ mine, holders, onTower }) {
  if (onTower) return [];
  const have = (e, by) => (mine || []).some(a => a.effect_id === e && a.by === by);
  return (holders || []).filter(h => CONTACT_AFFLICTIONS.includes(h.effect_id) && h.dist <= 1 && !have(h.effect_id, h.id))
    .sort((a, b) => a.id.localeCompare(b.id) || a.effect_id.localeCompare(b.effect_id))
    .map(h => ({ effect_id: h.effect_id, by: h.id, natural: 1 }));
}
// Visiting one's tower (the unit's entry hex) lifts every natural contact affliction.
export const liftAtTower = (afflictions, onTower) => onTower ? (afflictions || []).filter(a => !(a.natural && CONTACT_AFFLICTIONS.includes(a.effect_id))) : (afflictions || []);

// Creation: may `mover` (Matter m) enter `dest`? holders = [{ id, q, r, matter }] enemy natural Creation holders.
// → the holder that bars the hex, or null. A hex the mover already stands on is not "entered".
export function creationBars({ dest, from, moverMatter, holders, hexDist }) {
  if (from && dest && from.q === dest.q && from.r === dest.r) return null;
  return (holders || []).filter(h => moverMatter < h.matter && hexDist(dest, h) <= 1).sort((a, b) => a.id.localeCompare(b.id))[0] || null;
}

// Domination + Delay Time: how many actions an enemy loses at the end of its turn (one per holder in contact).
export const lostToHolders = (n, roundsPerTurn, round) => n > 0 && round >= Math.max(1, roundsPerTurn - n);

// Spirit Link (natural): the nearest living allied creature (distance, then id) — or null when I am alone.
export function nearestAlliedCreature(me, others, hexDist) {
  return (others || []).filter(p => p && p.peer_id !== me.peer_id && (p.life ?? 0) > 0 && p.creature_id && p.side === me.side)
    .map(p => ({ p, d: hexDist(me, p) })).sort((a, b) => a.d - b.d || String(a.p.peer_id).localeCompare(String(b.p.peer_id)))[0]?.p || null;
}
// Natural Spirit Link stats (user ruling 2026-11-15): 2+ copies standing = the ∀ double cast → all four stats
// (the order of the cast ∀ path in effects.mjs); one copy = a single link, Vitality.
export const naturalLinkStats = (copies) => copies >= 2 ? ['vitality', 'world', 'will', 'matter'] : copies === 1 ? ['vitality'] : [];
