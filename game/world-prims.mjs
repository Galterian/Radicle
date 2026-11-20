// Generic world primitives of the class engine (class isolation phase 6, 2026-11-20): hex geometry, where a created
// building rises, the world-edit payloads of a copy / a new building, per-turn charges, traps in range and where a
// disabled trap's card goes. Class-oblivious: the class programs (game/classes-data) choose the numbers, peer.mjs
// resolves the ability requests with these (classes-data/HOOKS.md "Ability requests"). Pure, deterministic in the
// arguments (salt hash, sorted candidates). Moved verbatim from class-world.mjs / class-traps.mjs; the class configs
// that lived beside them are test oracles now (classes-data/oracle/class-configs.mjs).
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
// byName: the builder's class name in the description (phase 3: any class's `build` request; default Priest).
export function shrineMade(cfg, sprite, by, byName = 'Priest') {
  const heal = Number.isInteger(cfg.heal) && cfg.heal > 1 ? cfg.heal : 1;
  return { label: cfg.label, path: sprite?.path || '', desc: `A ${cfg.label} raised by a ${byName}: stand here at the end of a turn — +${heal} life (never above your maximum).`, theme: cfg.power,
    bonus: { power: heal > 1 ? { kind: cfg.power, n: heal } : { kind: cfg.power } }, made_by: by };
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
