// Joining a dimension through its Doors — shared by the desktop launcher
// (ui-server.mjs, Doors read from local Radicle storage) and the Android entry
// (mobile-entry.mjs, Doors read from radicle-httpd on the OCI seed). Pure apart
// from fetchDimensionFromHttpd.
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexDistance } from './js/hex.js';
import { createKnownMap, initialBlock, seedForDimension, hash32 } from './js/map.js';
import { biomeFor } from './js/biome.js';
import { isLabyrinthWallAt, setFeatureCatalog, featuresReady } from './js/features.js';
import { setBigFeatureCatalog, bigFeaturesReady } from './js/bigfeature.js';
import { fortressAt } from './js/building-bonus.js';
import { fancyLabel } from './js/names.js';
import { DEFAULT_RELAYS } from './nostr-bus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const dimIdOf = d => d.dimension_id || d.dimension?.dimension_id || `dim-${slug(d.dimension_name)}`;

// Every live peer re-publishes its Door once a minute, so a dimension whose
// newest Door is older than this has nobody in it right now.
export const DOOR_LIVE_MS = Number(process.env.DOOR_LIVE_MS || 3 * 60 * 1000);
export const isLiveDoor = p => Date.now() - Date.parse(p.pushed_at || 0) < DOOR_LIVE_MS;

// Union the members every Door knows about into one roster: newest sighting
// of each peer wins, stale ones (nobody has seen them in a while) drop out.
export function unionMembers(doors, maxAgeMs = DOOR_LIVE_MS) {
  const byId = new Map();
  const consider = (m, at) => {
    if (!m?.peer_id) return;
    const seen = Date.parse(m.last_seen || at || 0);
    const prev = byId.get(m.peer_id);
    if (!prev || seen > prev._seen) byId.set(m.peer_id, { ...m, _seen: seen });
  };
  for (const p of doors) {
    consider({ peer_id: p.peer_id, name: p.name, alliance: p.alliance, character_id: p.character_id, creature_id: p.creature_id, tile: p.tile, life: p.life, life_max: p.life_max, last_seen: p.pushed_at }, p.pushed_at);
    for (const m of p.known_members || []) consider(m, p.pushed_at);
  }
  const cutoff = Date.now() - maxAgeMs;
  return [...byId.values()].filter(m => m._seen > cutoff).map(({ _seen, ...m }) => m);
}

// The dimension's known map as the union of every Door's blocks. Each Door
// carries the map as its holder saw it; blocks are idempotent so the union is
// exactly what a peer that had heard everyone would hold.
export function mapFromDoors(dim) {
  const seed = dim.doors.find(p => p.map?.seed)?.map.seed || seedForDimension(dimIdOf(dim));
  const km = createKnownMap(seed, [initialBlock()]);
  for (const p of dim.doors) km.addBlocks(p.map?.blocks || []);
  return km;
}

// The building catalogues decide where fortresses stand. The peer loads them at
// boot (peer.mjs, same lookup order); a launcher that judges hexes off the known
// map loads them once, lazily, so importing this file stays side-effect free.
function ensureBuildingCatalogs() {
  for (const [rel, ready, set] of [['features/feature_table.json', featuresReady, setFeatureCatalog], ['terrain_bigfeatures/bigfeature_table.json', bigFeaturesReady, setBigFeatureCatalog]]) {
    if (ready()) continue;
    const tries = [path.resolve(__dirname, 'js', 'catalog', path.basename(rel)), path.resolve(__dirname, '..', 'assets', rel), ...(process.env.CHAOSD6_ASSETS_DIR ? [path.resolve(process.env.CHAOSD6_ASSETS_DIR, rel)] : [])];
    const hit = tries.find(f => fsSync.existsSync(f));
    if (hit) { try { set(JSON.parse(fsSync.readFileSync(hit, 'utf8'))); } catch {} }
  }
}

// Can a unit stand on (q, r) of the dimension with map seed `seed`? Pure
// (seed, q, r) — works on hexes nobody has revealed yet. Mirrors the peer's
// static blockers (labyrinth walls, unbroken fortresses — peer.mjs
// labyrinthBlocks) and refuses unwalkable biomes (water, lava, mountains,
// cliffs — biome.js isWalkable) on top, so a joiner never starts in a lake.
export function hexWalkableAt(seed, q, r) {
  ensureBuildingCatalogs();
  if (!biomeFor(seed).isWalkable(q, r)) return false;
  if (isLabyrinthWallAt(seed, q, r)) return false;
  return !fortressAt(seed, q, r);
}

// A walkable hex min..max hexes from `anchor`, deterministic in (seed, salt,
// anchor): every hex of the ring band is ranked by a hash and the first one
// `isBlocked` lets through wins. `occupied` = Set of "q,r" to avoid as well.
// Returns null when the whole band is blocked.
export function tileInRing(anchor, { min, max, seed, salt = '', isBlocked = null, occupied = null }) {
  const blocked = isBlocked || ((q, r) => !hexWalkableAt(seed, q, r));
  const cand = [];
  for (let dq = -max; dq <= max; dq++) {
    for (let dr = Math.max(-max, -dq - max); dr <= Math.min(max, -dq + max); dr++) {
      const t = { q: anchor.q + dq, r: anchor.r + dr };
      const d = hexDistance(t, anchor);
      if (d < min || d > max) continue;
      cand.push({ ...t, h: hash32(`${seed}:ring:${salt}:${anchor.q},${anchor.r}:${t.q},${t.r}`) });
    }
  }
  cand.sort((a, b) => a.h - b.h || a.q - b.q || a.r - b.r);
  for (const t of cand) {
    if (occupied?.has(`${t.q},${t.r}`)) continue;
    if (!blocked(t.q, t.r)) return { q: t.q, r: t.r };
  }
  return null;
}

// "Join my team" (user ruling 2026-11-13): the gate opens 30–50 hexes from the
// anchor Door's hex — usually past the known map, so walkability comes from
// the deterministic map functions, not from what anybody has revealed.
export const FAR_MIN = 30, FAR_MAX = 50;
export function farTileFrom(anchor, { min = FAR_MIN, max = FAR_MAX, seed, salt = '', isBlocked = null, occupied = null } = {}) {
  return tileInRing(anchor, { min, max, seed, salt, isBlocked, occupied });
}

// Pick a start tile from what the Doors know. 'nearby' = adjacent to a friend
// (or to the chosen player's Door); 'random' = a known hex outside everyone's
// strong radius. Only hexes somebody has revealed are candidates — except
// 'far' (farTileFrom: 30–50 hexes from the anchor Door, off the known map).
export function placeFromDoors({ members, anchorPeerId, side, placement, knownMap, strongRadius = 2, preferredTile = null, salt = '' }) {
  const sideOf = a => (a === 'player' || a === 'npc_a') ? 'A' : a === 'npc_b' ? 'B' : (a === 'player_c' || a === 'npc_c') ? 'C' : a;
  const alive = members
    .map(m => ({ peer_id: m.peer_id, q: m.tile?.q, r: m.tile?.r, alliance: m.alliance ?? m.clan, life: m.life ?? 1 }))
    .filter(m => Number.isInteger(m.q) && Number.isInteger(m.r) && (m.life ?? 1) > 0);
  const occupied = new Set(alive.map(m => `${m.q},${m.r}`));
  if (placement === 'far') {
    const own = members.find(m => m.peer_id === anchorPeerId && Number.isInteger(m.tile?.q) && Number.isInteger(m.tile?.r));
    const friend = alive.find(m => sideOf(m.alliance) === sideOf(side));
    const at = own ? { q: own.tile.q, r: own.tile.r } : friend ? { q: friend.q, r: friend.r } : { q: 2, r: 2 };
    const t = farTileFrom(at, { seed: knownMap.seed, salt, occupied });
    if (!t) throw new Error(`no walkable hex ${FAR_MIN}–${FAR_MAX} hexes from (${at.q},${at.r})`);
    return t;
  }
  const all =[...knownMap.tiles()].map(t => ({ q: t.q, r: t.r }));
  const free = all.filter(t => !occupied.has(`${t.q},${t.r}`));
  if (!free.length) throw new Error('the grid is full');
  const minDist = (t, set) => set.length ? Math.min(...set.map(m => hexDistance(t, m))) : Infinity;
  const rand = arr => arr[Math.floor(Math.random() * arr.length)];
  // Rejoin-at-saved-tile path: prefer the exact tile; if occupied, pick the
  // closest free hex (ties → random). Falls back silently to the regular
  // placement rules only if the preferred tile isn't on the known map at all.
  if (preferredTile && Number.isInteger(preferredTile.q) && Number.isInteger(preferredTile.r)
      && knownMap.has(preferredTile.q, preferredTile.r)) {
    const key = `${preferredTile.q},${preferredTile.r}`;
    if (!occupied.has(key)) return { q: preferredTile.q, r: preferredTile.r };
    const scored = free.map(t => ({ t, d: hexDistance(t, preferredTile) }));
    scored.sort((a, b) => a.d - b.d);
    const best = scored[0].d;
    return rand(scored.filter(s => s.d === best).map(s => s.t));
  }
  if (placement === 'random') {
    const hidden = free.filter(t => minDist(t, alive) > strongRadius);
    if (hidden.length) return rand(hidden);
    const far = Math.max(...free.map(t => minDist(t, alive)));
    return rand(free.filter(t => minDist(t, alive) === far));
  }
  const anchor = anchorPeerId ? alive.filter(m => m.peer_id === anchorPeerId) : [];
  const friends = alive.filter(m => sideOf(m.alliance) === sideOf(side));
  const anchors = anchor.length ? anchor : friends.length ? friends : alive.length ? alive : [{ q: 2, r: 2 }];
  const adjacent = free.filter(t => anchors.some(a => hexDistance(t, a) === 1));
  if (adjacent.length) return rand(adjacent);
  free.sort((a, b) => minDist(a, anchors) - minDist(b, anchors));
  return free[0];
}

// Network hints from every Door: bus relays (required), plus direct-link
// addresses (live Doors only) that may or may not be reachable from here.
export function networkFromDoors(doors) {
  const relays = new Set(DEFAULT_RELAYS); const bootstrap = new Set(); const gunRelays = new Set();
  for (const p of doors) {
    for (const r of p.network?.nostr?.relays || []) relays.add(r);
    if (isLiveDoor(p)) {
      for (const a of p.network?.libp2p?.multiaddrs || []) bootstrap.add(a);
      for (const a of p.network?.libp2p?.bootstrap || []) bootstrap.add(a);
      if (p.network?.gun?.url) gunRelays.add(p.network.gun.url);
      for (const g of p.network?.gun?.relays || []) gunRelays.add(g);
    }
  }
  return { relays: [...relays], bootstrap: [...bootstrap], gunRelays: [...gunRelays] };
}

// Read a dimension the way listPublishedDimensions() does, but over
// radicle-httpd: every namespace that holds ActiveDimensions/<name> contributes
// its Doors. Returns { dimension_name, dimension_id, dimension, doors, namespaces }
// with the newest Door first, or null if no namespace has the branch.
export async function fetchDimensionFromHttpd({ seedHost, rid, dimensionName, timeoutMs = 8000 }) {
  const origin = /^https?:\/\//.test(seedHost) ? seedHost : `https://${seedHost}`;   // bare host = HTTPS seed
  const base = `${origin}/api/v1/repos/${rid.startsWith('rad:') ? rid : `rad:${rid}`}`;
  const get = async tail => {
    const r = await fetch(`${base}/${tail}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${tail}`);
    return r.json();
  };
  const blob = async (sha, rel) => JSON.parse((await get(`blob/${sha}/${rel}`)).content);
  const branch = `ActiveDimensions/${dimensionName}`;
  const remotes = await get('remotes');
  const dim = { dimension_name: dimensionName, dimension_id: null, dimension: null, doors: [], namespaces: [] };
  for (const remote of remotes) {
    const sha = remote?.heads?.[branch];
    if (!sha) continue;
    dim.namespaces.push(remote.id);
    if (!dim.dimension) {
      try { dim.dimension = await blob(sha, `${branch}/dimension.json`); dim.dimension_id = dim.dimension.dimension_id || null; } catch {}
    }
    let entries = [];
    try { entries = (await get(`tree/${sha}/${branch}/doors`)).entries || []; } catch {}
    for (const e of entries) {
      if (!String(e.name).endsWith('.json')) continue;
      try {
        const doc = { ...(await blob(sha, `${branch}/doors/${e.name}`)), nid: remote.id, commit: sha };
        if (!(doc.door_version >= 2 && doc.peer_id)) continue;
        // Several namespaces can carry the same peer's Door; keep the newest.
        const prev = dim.doors.findIndex(d => d.peer_id === doc.peer_id);
        if (prev >= 0 && Date.parse(dim.doors[prev].pushed_at || 0) >= Date.parse(doc.pushed_at || 0)) continue;
        if (prev >= 0) dim.doors.splice(prev, 1);
        dim.doors.push(doc);
      } catch {}
    }
  }
  if (!dim.namespaces.length) return null;
  dim.doors.sort((a, b) => Date.parse(b.pushed_at || 0) - Date.parse(a.pushed_at || 0));
  return dim;
}

// Everything a joining peer needs, as peer.mjs env vars (minus ports and the
// map-blocks file, which depend on where the caller runs). `doorId` is the
// anchor unit's peer_id (or door_id); `side` the joiner's alliance.
export function planJoin(dim, { doorId = null, side = 'player', placement = 'nearby', label = '', extraMembers = [], preferredTile = null } = {}) {
  if (!dim.doors.length) throw new Error(`${dim.dimension_name} has no Doors`);
  const anchorDoor = doorId ? dim.doors.find(p => p.peer_id === doorId || p.door_id === doorId) : dim.doors[0];
  if (doorId && !anchorDoor) throw new Error(`no Door from ${doorId} on ${dim.dimension_name}`);
  const byId = new Map(unionMembers(dim.doors).map(m => [m.peer_id, m]));
  for (const m of extraMembers) byId.set(m.peer_id, { ...(byId.get(m.peer_id) || {}), ...m });   // live view wins
  const members = [...byId.values()];
  const liveDoors = dim.doors.filter(isLiveDoor);
  const knownMap = mapFromDoors(dim);
  const startTile = placeFromDoors({ members, anchorPeerId: anchorDoor?.peer_id, side, placement, knownMap, preferredTile });
  if (placement !== 'far' && !knownMap.has(startTile.q, startTile.r)) throw new Error('placement failed');
  const taken = new Set(members.map(m => String(m.peer_id || '').replace(/^peer:/, '')));
  const peerLabel = (label || '').trim() || fancyLabel(taken);
  return { anchorDoor, members, liveDoors, knownMap, startTile, peerLabel, network: networkFromDoors(dim.doors) };
}
