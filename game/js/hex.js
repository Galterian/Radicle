// Flat-top hex grid math with axial coordinates. The grid is unbounded; which
// hexes exist is decided by the dimension's known map (see map.js), passed in
// as a `known(q, r)` predicate wherever it matters.
// Isometric look is implemented by squashing y and shifting rows.

export const HEX_SIZE = 46;   // tile radius (px)
export const H_SQUASH = 0.72; // vertical squash to get iso feel

const ANY = () => true;

export function hexToPixel(q, r, size = HEX_SIZE) {
  const w = Math.sqrt(3) * size;
  const h = 1.5 * size;
  const x = w * (q + r / 2);
  const y = h * r * H_SQUASH;
  return { x, y };
}

export function hexCorners(cx, cy, size = HEX_SIZE) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    out.push({ x: cx + size * Math.cos(a), y: cy + size * Math.sin(a) * H_SQUASH });
  }
  return out;
}

// 6-neighbour axial directions (we use hex geometry; the paper's 8-neighbour square
// grid becomes 6-neighbour on hex — flagged in contradictions for later governance).
const DIRS = [[+1, 0], [+1, -1], [0, -1], [-1, 0], [-1, +1], [0, +1]];

export function neighbours(q, r) {
  return DIRS.map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
}

export function hexDistance(a, b) {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

// Inverse of hexToPixel: world pixel → nearest axial hex (cube rounding).
export function pixelToHexRaw(px, py, size = HEX_SIZE) {
  const w = Math.sqrt(3) * size;
  const h = 1.5 * size;
  const rf = py / (h * H_SQUASH);
  const qf = px / w - rf / 2;
  const sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf), s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

// World pixel → hex, or null when that hex is not part of the known map.
export function pixelToHex(px, py, origin = { x: 0, y: 0 }, known = ANY, size = HEX_SIZE) {
  const h = pixelToHexRaw(px - origin.x, py - origin.y, size);
  return known(h.q, h.r) ? h : null;
}

// Step one tile along the shortest line from `from` toward `to`.
export function stepToward(from, to, known = ANY) {
  const opts = neighbours(from.q, from.r)
    .filter(n => known(n.q, n.r))
    .map(n => ({ q: n.q, r: n.r, _d: hexDistance(n, to) }));
  opts.sort((a, b) => a._d - b._d);
  const best = opts[0];
  return best ? { q: best.q, r: best.r } : from;
}

export function stepAway(from, to, known = ANY) {
  const opts = neighbours(from.q, from.r)
    .filter(n => known(n.q, n.r))
    .map(n => ({ q: n.q, r: n.r, _d: hexDistance(n, to) }));
  opts.sort((a, b) => b._d - a._d);
  const best = opts[0];
  return best ? { q: best.q, r: best.r } : from;
}

// A* pathfinding over the known hexes, avoiding `blocked` tiles ("q,r" strings).
// Returns the ordered list of hexes AFTER `from` up to and including the
// reached tile, or an empty array if no reachable tile exists at all.
//
// Blocked destinations get a fallback: if `to` itself is blocked (an enemy
// is standing on it) we path to the closest reachable hex ADJACENT to `to`
// instead — same spirit of "get me as near as possible to that cell". With
// this, right-clicking a tile that happens to be occupied no longer collapses
// to the single-step heuristic; the pathfinder still routes you around the
// obstacle and parks you one hex short.
export function findPath(from, to, blocked = new Set(), known = ANY) {
  if (from.q === to.q && from.r === to.r) return [];
  if (!known(to.q, to.r)) return [];
  const key = h => `${h.q},${h.r}`;
  const goalKey = key(to);
  // Hard cap so a huge known map with an unreachable goal can't spin for long.
  const MAX_EXPAND = 20000;
  // `blocked` can be a Set("q,r") OR a predicate (q, r) => bool. The predicate
  // form lets callers add deterministic world-scenery blockers (labyrinth
  // walls) without having to pre-enumerate every known hex into a Set.
  const isBlocked = typeof blocked === 'function'
    ? (q, r) => !!blocked(q, r)
    : (q, r) => blocked.has(`${q},${r}`);

  const runAStar = (goalQ, goalR, allowBlockedGoal) => {
    const startKey = key(from);
    const gk = `${goalQ},${goalR}`;
    const open = [{ q: from.q, r: from.r, g: 0, f: hexDistance(from, { q: goalQ, r: goalR }) }];
    const parents = new Map();
    const gScore = new Map([[startKey, 0]]);
    const closed = new Set();
    while (open.length && closed.size < MAX_EXPAND) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0];
      const ck = key(cur);
      if (closed.has(ck)) continue;
      closed.add(ck);
      if (ck === gk) {
        const path = [];
        let k = ck;
        while (parents.has(k)) {
          const [q, r] = k.split(',').map(Number);
          path.unshift({ q, r });
          k = parents.get(k);
        }
        return path;
      }
      for (const n of neighbours(cur.q, cur.r)) {
        if (!known(n.q, n.r)) continue;
        const nk = key(n);
        if (closed.has(nk)) continue;
        if (isBlocked(n.q, n.r) && !(allowBlockedGoal && nk === gk)) continue;
        const g = cur.g + 1;
        if (g < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, g);
          parents.set(nk, ck);
          open.push({ q: n.q, r: n.r, g, f: g + hexDistance(n, { q: goalQ, r: goalR }) });
        }
      }
    }
    return [];
  };

  // 1) Try the direct path to `to`, assuming `to` must itself be reachable
  //    (unblocked). The pathfinder routes around any intermediate blockers.
  const direct = isBlocked(to.q, to.r) ? [] : runAStar(to.q, to.r, false);
  if (direct.length) return direct;

  // 2) Either `to` is blocked or every route to it is cut off. Fall back to
  //    the closest reachable free neighbour of `to`, so the journey still
  //    makes progress toward the clicked cell rather than giving up.
  const candidates = [];
  for (const n of neighbours(to.q, to.r)) {
    if (!known(n.q, n.r)) continue;
    if (isBlocked(n.q, n.r)) continue;
    const p = runAStar(n.q, n.r, false);
    if (p.length) candidates.push(p);
  }
  if (!candidates.length) return [];
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}
