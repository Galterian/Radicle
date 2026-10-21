// Flat-top hex grid math with axial coordinates. 5x5 means q in [0,4], r in [0,4].
// Isometric look is implemented by squashing y and shifting rows.

export const HEX_SIZE = 46;   // tile radius (px)
export const H_SQUASH = 0.72; // vertical squash to get iso feel

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

export function inBounds(q, r, size = 5) {
  return q >= 0 && q < size && r >= 0 && r < size;
}

// Pick the hex nearest to (px, py) given a hex grid origin + 5x5 range.
export function pixelToHex(px, py, origin, size = HEX_SIZE) {
  let best = null, bestD = Infinity;
  for (let r = 0; r < 5; r++) for (let q = 0; q < 5; q++) {
    const p = hexToPixel(q, r, size);
    const dx = px - (origin.x + p.x);
    const dy = py - (origin.y + p.y);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = { q, r }; }
  }
  return best;
}

// Step one tile along the shortest line from `from` toward `to`.
export function stepToward(from, to) {
  const opts = neighbours(from.q, from.r)
    .filter(n => inBounds(n.q, n.r))
    .map(n => ({ q: n.q, r: n.r, _d: hexDistance(n, to) }));
  opts.sort((a, b) => a._d - b._d);
  const best = opts[0];
  return best ? { q: best.q, r: best.r } : from;
}

export function stepAway(from, to) {
  const opts = neighbours(from.q, from.r)
    .filter(n => inBounds(n.q, n.r))
    .map(n => ({ q: n.q, r: n.r, _d: hexDistance(n, to) }));
  opts.sort((a, b) => b._d - a._d);
  const best = opts[0];
  return best ? { q: best.q, r: best.r } : from;
}

// A* pathfinding over the hex grid, avoiding `blocked` tiles ("q,r" strings).
// Returns the ordered list of hexes AFTER `from` up to and including `to`, or
// an empty array if no path exists (or from===to). The destination itself may
// or may not be `blocked`; we treat it the same as any other tile, so pathing
// to an occupied hex returns [] (the UI then just stays put).
export function findPath(from, to, blocked = new Set(), size = 5) {
  if (from.q === to.q && from.r === to.r) return [];
  if (!inBounds(to.q, to.r, size)) return [];
  const key = h => `${h.q},${h.r}`;
  const startKey = key(from);
  const goalKey  = key(to);
  if (blocked.has(goalKey)) return [];
  const open = [{ q: from.q, r: from.r, g: 0, f: hexDistance(from, to) }];
  const parents = new Map();
  const gScore  = new Map([[startKey, 0]]);
  const closed  = new Set();
  while (open.length) {
    // Linear-scan min — the grid is tiny (5x5 = 25 cells) so a heap would be
    // overkill; keep the implementation small and allocation-free.
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = key(cur);
    if (closed.has(ck)) continue;
    closed.add(ck);
    if (ck === goalKey) {
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
      if (!inBounds(n.q, n.r, size)) continue;
      const nk = key(n);
      if (closed.has(nk)) continue;
      if (blocked.has(nk) && nk !== goalKey) continue;
      const g = cur.g + 1;
      if (g < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, g);
        parents.set(nk, ck);
        open.push({ q: n.q, r: n.r, g, f: g + hexDistance(n, to) });
      }
    }
  }
  return [];
}
