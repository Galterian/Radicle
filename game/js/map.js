// Per-dimension known map. Shared by the peer process (Node) and the browser.
//
// The map is a grow-only set of revealed hexes. It is never stored hex by hex:
// the unit of storage and sync is a *block* — either the initial rectangle or
// a disc of REVEAL radius around a position a player has reached. Blocks are
// idempotent (same id → same hexes) and the set only grows, so merging what
// another peer sends is a plain union whichever transport brought it (Gun,
// gossipsub, the Nostr bus, or a Door on Radicle). Hex content is derived from
// (dimension seed, q, r) so every peer that materialises a hex gets the same.
import { hexDistance } from './hex.js';
import { biomeFor, BIOME_FILL } from './biome.js';

export const INITIAL_SIZE = 5;
export const DEFAULT_REVEAL_RADIUS = 10;

export const tileKey = (q, r) => `${q},${r}`;

// FNV-1a over a string → 32-bit unsigned. Same result in Node and browsers,
// synchronous, and plenty for seeding terrain.
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// Every peer in a dimension derives the same seed from the dimension id, so
// nothing has to be passed around for the maps to agree.
export function seedForDimension(dimId) {
  return '0x' + hash32(`chaosd6:${dimId}`).toString(16).padStart(8, '0');
}

export function initialBlock(size = INITIAL_SIZE) {
  return { id: `rect:0,0,${size}x${size}`, kind: 'rect', q: 0, r: 0, w: size, h: size, by: 'genesis' };
}

export function discBlock(q, r, radius, by, at = new Date().toISOString()) {
  return { id: `disc:${q},${r},${radius}`, kind: 'disc', q, r, radius, by: by || null, at };
}

export function isBlock(b) {
  if (!b || typeof b !== 'object' || typeof b.id !== 'string') return false;
  if (b.kind === 'rect') return Number.isInteger(b.q) && Number.isInteger(b.r) && Number.isInteger(b.w) && Number.isInteger(b.h) && b.w > 0 && b.h > 0 && b.w <= 64 && b.h <= 64;
  if (b.kind === 'disc') return Number.isInteger(b.q) && Number.isInteger(b.r) && Number.isInteger(b.radius) && b.radius >= 0 && b.radius <= 32;
  return false;
}

export function* blockTiles(b) {
  if (b.kind === 'rect') {
    for (let r = b.r; r < b.r + b.h; r++) for (let q = b.q; q < b.q + b.w; q++) yield { q, r };
  } else if (b.kind === 'disc') {
    const R = b.radius;
    for (let dq = -R; dq <= R; dq++) {
      const lo = Math.max(-R, -dq - R), hi = Math.min(R, -dq + R);
      for (let dr = lo; dr <= hi; dr++) yield { q: b.q + dq, r: b.r + dr };
    }
  }
}

// Terrain type for a hex is "which biome does Biome.gd / biome.js pick here" —
// a pure function of (seed, q, r). The renderer uses `type` to look up a PNG
// from assets/terrain/terrain_tiles.json and `fill` as a fallback flat-poly
// colour until the PNG resolves. Both runtimes (Godot + browser) must agree
// bit-for-bit so a dimension renders the same whichever client drew it.
export function terrainAt(seed, q, r) {
  const type = biomeFor(seed).biomeAt(q, r);
  return { type, fill: BIOME_FILL[type] || '#1a1f2a' };
}

export function createKnownMap(seed, blocks = []) {
  const byId = new Map();
  const tiles = new Set();
  let bounds = null;

  function addBlock(b) {
    if (!isBlock(b) || byId.has(b.id)) return false;
    const copy = { id: b.id, kind: b.kind, q: b.q, r: b.r, by: b.by ?? null, at: b.at ?? null };
    if (b.kind === 'rect') { copy.w = b.w; copy.h = b.h; } else copy.radius = b.radius;
    byId.set(copy.id, copy);
    for (const t of blockTiles(copy)) {
      tiles.add(tileKey(t.q, t.r));
      if (!bounds) bounds = { min_q: t.q, max_q: t.q, min_r: t.r, max_r: t.r };
      else {
        if (t.q < bounds.min_q) bounds.min_q = t.q; if (t.q > bounds.max_q) bounds.max_q = t.q;
        if (t.r < bounds.min_r) bounds.min_r = t.r; if (t.r > bounds.max_r) bounds.max_r = t.r;
      }
    }
    return true;
  }

  const api = {
    seed,
    has: (q, r) => tiles.has(tileKey(q, r)),
    hasKey: k => tiles.has(k),
    size: () => tiles.size,
    blockCount: () => byId.size,
    blocks: () => [...byId.values()],
    bounds: () => (bounds ? { ...bounds } : { min_q: 0, max_q: 0, min_r: 0, max_r: 0 }),
    addBlock,
    addBlocks(list) { let n = 0; for (const b of list || []) if (addBlock(b)) n++; return n; },
    // True when some hex within `radius` of (q,r) is still unknown — i.e. the
    // position is closer than `radius` to the edge of the known world.
    needsReveal(q, r, radius) {
      for (const t of blockTiles({ kind: 'disc', q, r, radius })) if (!tiles.has(tileKey(t.q, t.r))) return true;
      return false;
    },
    *tiles() {
      for (const k of tiles) { const [q, r] = k.split(',').map(Number); yield { q, r, key: k }; }
    },
    // Unknown hexes adjacent to a known one — the fog line the renderer draws.
    frontier() {
      const out = new Map();
      for (const k of tiles) {
        const [q, r] = k.split(',').map(Number);
        for (const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
          const nk = tileKey(q + dq, r + dr);
          if (!tiles.has(nk) && !out.has(nk)) out.set(nk, { q: q + dq, r: r + dr });
        }
      }
      return [...out.values()];
    },
    terrain: (q, r) => terrainAt(seed, q, r),
    distance: hexDistance,
  };
  api.addBlocks(blocks);
  return api;
}
