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

const TERRAIN = [
  { type: 'ash',    fill: '#141a24', alt: '#101620' },
  { type: 'cinder', fill: '#1b1a22', alt: '#17161e' },
  { type: 'basalt', fill: '#111a1e', alt: '#0e161a' },
  { type: 'ember',  fill: '#201913', alt: '#1b150f' },
];

export function terrainAt(seed, q, r) {
  const h = hash32(`${seed}:${q}:${r}`);
  const t = TERRAIN[h % TERRAIN.length];
  return { type: t.type, fill: ((q + r) & 1) ? t.alt : t.fill };
}

// ---- world-generated features (user spec general_ux_token_generated, 2026-10-30) ----
// Every hex derives from (seed, q, r) whether it carries a terrain region token or a building /
// artefact — the same on every peer and in the UI, with nothing to sync. Features are bonus tile
// tokens (`kind: 'bonus'`, an element, a value, an `item` label) the resolver counts like any
// token lying on the tile (stat bonus while standing there, life maximum, Force Pull, Rule 24,
// Metaphysics / Disruption relocation). Density ≈ one feature per 5 hexes: terrain regions are
// low-frequency element patches (hash over a 4-hex cell) with a token on about one hex in three of
// the patch; buildings / artefacts land on about one hex in fourteen outside the start area.
const ELEMS = ['elem_vitality', 'elem_souls', 'elem_time', 'elem_space', 'elem_air', 'elem_water', 'elem_earth', 'elem_fire', 'elem_concentration', 'elem_harmony'];
export const WORLD_BUILDINGS = [
  { item: 'Shrine', elem: 'elem_souls', value: 4, kind_id: 'tower_souls' },
  { item: 'Sphere of Fire', elem: 'elem_fire', value: 5, kind_id: 'tower_fire' },
  { item: 'Healing Spring', elem: 'elem_vitality', value: 4, kind_id: 'tower_vitality' },
  { item: 'School', elem: 'elem_concentration', value: 4, kind_id: 'tower_concentration' },
  { item: 'Academy', elem: 'elem_harmony', value: 5, kind_id: 'tower_harmony' },
  { item: 'Sacred Land', elem: 'elem_souls', value: 6, kind_id: 'item_element_bonus_terrain' },
  { item: 'Obelisk of Time', elem: 'elem_time', value: 4, kind_id: 'tower_time' },
  { item: 'Rift', elem: 'elem_space', value: 4, kind_id: 'tower_space' },
  { item: 'Windmill', elem: 'elem_air', value: 3, kind_id: 'tower_air' },
  { item: 'Well', elem: 'elem_water', value: 3, kind_id: 'tower_water' },
  { item: 'Standing Stones', elem: 'elem_earth', value: 4, kind_id: 'tower_earth' },
  { item: 'Crystal of Vitality', elem: 'elem_vitality', value: 6, kind_id: 'crystal_vitality' },
  { item: 'Crystal of Matter', elem: 'elem_earth', value: 6, kind_id: 'crystal_matter' },
  { item: 'Crystal of Will', elem: 'elem_harmony', value: 6, kind_id: 'crystal_will' },
  { item: 'Crystal of World', elem: 'elem_time', value: 6, kind_id: 'crystal_world' },
  { item: 'Artifact', elem: 'elem_space', value: 5, kind_id: 'item_artifact' },
];
const REGION_NAMES = { elem_vitality: 'Grove', elem_souls: 'Graveyard', elem_time: 'Ruins', elem_space: 'Void Scar', elem_air: 'Highland', elem_water: 'Marsh', elem_earth: 'Rockfield', elem_fire: 'Ashfield', elem_concentration: 'Monastery Grounds', elem_harmony: 'Meadow' };
// The element patch a hex belongs to (4-hex cells so a region spans several hexes), or null for 3 cells in 5.
export function regionAt(seed, q, r) {
  const cq = Math.floor(q / 4), cr = Math.floor(r / 4);
  const h = hash32(`${seed}:region:${cq}:${cr}`);
  if (h % 5 < 3) return null;
  return ELEMS[(h >>> 3) % ELEMS.length];
}
// The world feature on a hex, or null. The start disc (within 2 of the origin) stays clear.
export function featureAt(seed, q, r) {
  if (Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r)) <= 2) return null;
  const h = hash32(`${seed}:feature:${q}:${r}`);
  if (h % 14 === 0) {
    const b = WORLD_BUILDINGS[(h >>> 4) % WORLD_BUILDINGS.length];
    return { id: `world:${q},${r}`, kind: 'bonus', elem: b.elem, value: b.value, item: b.item, kind_id: b.kind_id, q, r, world: true };
  }
  const reg = regionAt(seed, q, r);
  if (reg && (h >>> 8) % 3 === 0) return { id: `world:${q},${r}`, kind: 'bonus', elem: reg, value: 1 + ((h >>> 12) % 4), item: REGION_NAMES[reg], kind_id: 'item_element_bonus_terrain', q, r, world: true };
  return null;
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
