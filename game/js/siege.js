// Siege engines (user 2026-11-25: an Engineer builds a Catapult / Ballista / Battering Ram that follows the hero).
// PURE: the flight of a siege engine's ammunition, shared by the resolver (peer.mjs) and the map (main.js) so both
// put the stone / bolt on the same hex at the same action. A shot is a record in its engine's snapshot
// (siege_shots_json), never a unit: { id, kind, from {q,r}, to {q,r}, at (launch action), speed, hexes [{q,r,k}] } —
// `hexes` are where it strikes, k = hexes from the engine; it strikes hex k at action at + ceil(k / speed).
//   catapult — one hex, the target (k = its distance, ≥ 2): "a flying self-destruct ammunition unit"
//   ballista — the line from the engine through the target, hexes 1..max, each as the bolt passes
// A unit tagged `flying` (a dragon) passes over walls: flyerHop below.

const cube = (h) => ({ x: h.q, z: h.r, y: -h.q - h.r });
export const hexDist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
function cubeRound(x, y, z) {
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
  return { q: rx, r: rz };
}
// The hexes of the straight line a → b (a excluded), `n` steps long (default: their distance). The nudge keeps
// a line along a hex edge on one side, the same on every peer.
export function hexLine(a, b, n = hexDist(a, b)) {
  const d = hexDist(a, b);
  if (!d || n < 1) return [];
  const A = cube(a), B = cube(b), out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / d;
    out.push(cubeRound(A.x + (B.x - A.x) * t + 1e-6, A.y + (B.y - A.y) * t + 2e-6, A.z + (B.z - A.z) * t - 3e-6));
  }
  return out;
}
// The shot an engine of `siege` ({ kind, min, max, speed }) fires from `from` at `to` on action `at` — or null when
// `to` is out of its reach (a catapult cannot hit the hex next to it).
export function makeShot(siege, from, to, at, id) {
  const d = hexDist(from, to);
  if (!siege || !(d >= siege.min && d <= siege.max)) return null;
  const speed = siege.speed || 2;
  const hexes = siege.kind === 'ballista' ? hexLine(from, to, siege.max).map((h, i) => ({ ...h, k: i + 1 }))
    : siege.kind === 'catapult' ? [{ q: to.q, r: to.r, k: d }] : [];
  if (!hexes.length) return null;
  return { id, kind: siege.kind, from: { q: from.q, r: from.r }, to: { q: to.q, r: to.r }, at, speed, hexes };
}
export const strikeAt = (shot, h) => shot.at + Math.max(1, Math.ceil(h.k / (shot.speed || 2)));
// The hexes `shot` strikes on `action`.
export const shotStrikes = (shot, action) => (shot?.hexes || []).filter(h => strikeAt(shot, h) === action);
// The last action it strikes on (after it the ammunition is gone).
export const shotEnds = (shot) => Math.max(...(shot?.hexes || [{ k: 0 }]).map(h => strikeAt(shot, h)));
// Where the ammunition flies at `frac` actions after its launch (fractional hex, for the map), null once it is gone.
export function shotPosAt(shot, frac) {
  const far = Math.max(...shot.hexes.map(h => h.k)), end = shot.hexes.find(h => h.k === far);
  const k = Math.min(far, frac * (shot.speed || 2));
  if (frac > shotEnds(shot) - shot.at + 0.25) return null;
  const t = far ? k / far : 1;
  return { q: shot.from.q + (end.q - shot.from.q) * t, r: shot.from.r + (end.r - shot.from.r) * t, arc: shot.kind === 'catapult' ? Math.sin(Math.PI * Math.min(1, t)) : 0 };
}
// A flyer's step from `cur` toward `to` when the hex in front of it is blocked: over it, onto the open hex beyond
// (null when that one is blocked too). `blocked(q, r)` = a wall / scenery / obstacle on the hex.
export function flyerHop(cur, to, blocked) {
  const line = hexLine(cur, to, Math.min(2, hexDist(cur, to)));
  if (line.length < 2 || !blocked(line[0].q, line[0].r) || blocked(line[1].q, line[1].r)) return null;
  return line[1];
}
