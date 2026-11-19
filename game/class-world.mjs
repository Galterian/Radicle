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

export const hexDist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
// Every hex within R of c (c included), sorted by (q, r).
export function discAround(c, R) {
  const out = [];
  for (let dq = -R; dq <= R; dq++) for (let dr = Math.max(-R, -dq - R); dr <= Math.min(R, -dq + R); dr++) out.push({ q: c.q + dq, r: c.r + dr });
  return out.sort((a, b) => a.q - b.q || a.r - b.r);
}
// The building an Animator copies: the nearest of `cands` ([{ q, r, ... }], buildings standing on the map)
// within `near` of `here` — distance, then q, then r. → the candidate | null.
export function nearestBuilding(cands, here, near) {
  return cands.filter(b => Number.isInteger(b.q) && Number.isInteger(b.r) && hexDist(here, b) <= near)
    .sort((a, b) => hexDist(here, a) - hexDist(here, b) || a.q - b.q || a.r - b.r)[0] || null;
}
// Where a created building rises (Animator / Priest): the picked hex when it lies 1..range from `here` and
// okTile(hex, true) lets it through, else a random hex 1..range away that okTile(hex, false) lets through
// (index = first 8 hex digits of sha(salt) over the (q, r)-sorted candidates). Never my own hex.
// → { dest, random } | null when nothing is free.
export function buildSite({ here, range, picked, okTile, salt, sha }) {
  const fits = (t, isPick) => !!t && Number.isInteger(t.q) && Number.isInteger(t.r) && hexDist(here, t) >= 1 && hexDist(here, t) <= range && okTile(t, isPick);
  if (fits(picked, true)) return { dest: { q: picked.q, r: picked.r }, random: false };
  const cands = discAround(here, range).filter(t => fits(t, false));
  if (!cands.length) return null;
  return { dest: cands[parseInt(sha(salt).slice(0, 8), 16) % cands.length], random: true };
}
// The world-edit payload (`made`) of a copy of feature `f` that stood on (q, r): same look, same bonus (rolled
// on the source hex — a copy of a copy points at the first source).
export function copyMade(f, q, r, by) {
  // A building with a fixed bonus (a Priest's Shrine) is copied with that bonus — re-rolling it on the Shrine's
  // hex would give the copy a stat bonus the Shrine never had (and the copy, like the Shrine, hides no trap).
  // CP 2026-11-19 (user pick 5 a): only the Priest's OWN Shrine heals more than 1 — a copy mends 1 (power.n dropped).
  const bonus = f.bonus && typeof f.bonus === 'object' ? JSON.parse(JSON.stringify(f.bonus)) : null;
  if (bonus?.power && typeof bonus.power === 'object' && bonus.power.kind === 'mend') delete bonus.power.n;
  return { label: f.label || 'Building', path: f.path || '', desc: f.desc || '', biome: f.biome || '', ...(f.theme ? { theme: f.theme } : {}),
    copy_of: f.copy_of && Number.isInteger(f.copy_of.q) ? { q: f.copy_of.q, r: f.copy_of.r } : { q, r },
    ...(bonus ? { bonus } : {}), made_by: by };
}
// The world-edit payload of a Priest's Shrine: the catalogue sprite (when found), only its power (no stat bonus).
// CP 2026-11-19: cfg.heal > 1 → power {kind, n: heal} (peer.mjs turn-end mend heals n); 1 → the old {kind} payload.
export function shrineMade(cfg, sprite, by) {
  const heal = Number.isInteger(cfg.heal) && cfg.heal > 1 ? cfg.heal : 1;
  return { label: cfg.label, path: sprite?.path || '', desc: `A ${cfg.label} raised by a Priest: stand here at the end of a turn — +${heal} life (never above your maximum).`, theme: cfg.power,
    bonus: { power: heal > 1 ? { kind: cfg.power, n: heal } : { kind: cfg.power } }, made_by: by };
}
