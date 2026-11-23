// NPC builders' ring wall (AI skirmish, user 2026-11-23): "they should make a wall that should wrap over some square,
// circle at size 20 hexes radius at least" — instead of Barricades around themselves, the builders walk out to a hex
// ring of BUILDER_RING_RADIUS (default 20) around the dimension's start (0,0) and raise it one Barricade a turn, each
// builder on its own arc (it starts at a home index hashed from its label and works clockwise). Six one-hex gates (the
// middle of each ring side) stay open so the ring never seals anybody in or out.
// PURE (planning only): which hex to build next and where to step. The resolver still checks every Barricade like
// before (adjacent, walkable, free — peer.mjs doResolution "NPC builders"), so nothing here touches the state hash.

const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export const hexDist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;

// The ring of radius R around c, in walking order: [{q, r, i, gate}]; R < 1 → [].
export function ringHexes(c, R) {
  if (!(R >= 1)) return [];
  const out = [];
  let q = c.q + DIRS[4][0] * R, r = c.r + DIRS[4][1] * R;
  for (let side = 0; side < 6; side++) {
    for (let j = 0; j < R; j++) {
      out.push({ q, r, i: out.length, gate: j === Math.floor(R / 2) });
      q += DIRS[side][0]; r += DIRS[side][1];
    }
  }
  return out;
}

export function homeIndex(label, n) {
  let h = 2166136261;
  for (const ch of String(label)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return n ? h % n : 0;
}

// The next wall hex for this builder: the first ring hex from its home index on (clockwise) that is not a gate, not
// already built (built(q, r)) and not unbuildable (blocked(q, r): water, a building, a labyrinth wall …), skipping
// those in `skip` (a site it got stuck on). null when the whole ring stands.
export function nextWallHex({ ring, home = 0, built, blocked, skip = new Set() }) {
  const n = ring.length;
  for (let k = 0; k < n; k++) {
    const h = ring[(home + k) % n];
    if (h.gate || skip.has(`${h.q},${h.r}`) || built(h.q, h.r) || blocked(h.q, h.r)) continue;
    return h;
  }
  return null;
}

// What the builder does this action toward `site`: { build: true } when it stands next to it, else { stepTo } — the
// first hex of a shortest path (breadth-first over the `free` hexes, at most `maxNodes` visited; neighbour order
// fixed, so the same map gives the same step) to any free hex next to the site. A builder standing ON the site steps
// off it first. null when no path is found (walled in, water all around …).
export function ringStep({ me, site, free, maxNodes = 4000 }) {
  const d = hexDist(me, site);
  if (d === 1) return { build: true };
  const key = (t) => `${t.q},${t.r}`;
  const goal = (t) => hexDist(t, site) === 1;
  const prev = new Map([[key(me), null]]);
  const queue = [me];
  while (queue.length && prev.size < maxNodes) {
    const cur = queue.shift();
    for (const [dq, dr] of DIRS) {
      const n = { q: cur.q + dq, r: cur.r + dr };
      const k = key(n);
      if (prev.has(k) || (n.q === site.q && n.r === site.r) || !free(n.q, n.r)) continue;
      prev.set(k, cur);
      if (goal(n)) {
        let step = n;
        while (prev.get(key(step)) && key(prev.get(key(step))) !== key(me)) step = prev.get(key(step));
        return { stepTo: { q: step.q, r: step.r } };
      }
      queue.push(n);
    }
  }
  return null;
}
