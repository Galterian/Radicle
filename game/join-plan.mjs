// Joining a dimension through its Doors — shared by the desktop launcher
// (ui-server.mjs, Doors read from local Radicle storage) and the Android entry
// (mobile-entry.mjs, Doors read from radicle-httpd on the OCI seed). Pure apart
// from fetchDimensionFromHttpd.
import { hexDistance } from './js/hex.js';
import { createKnownMap, initialBlock, seedForDimension } from './js/map.js';
import { fancyLabel } from './js/names.js';
import { DEFAULT_RELAYS } from './nostr-bus.mjs';

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

// Pick a start tile from what the Doors know. 'nearby' = adjacent to a friend
// (or to the chosen player's Door); 'random' = a known hex outside everyone's
// strong radius. Only hexes somebody has revealed are candidates.
export function placeFromDoors({ members, anchorPeerId, side, placement, knownMap, strongRadius = 2, preferredTile = null }) {
  const sideOf = a => (a === 'player' || a === 'npc_a') ? 'A' : a === 'npc_b' ? 'B' : (a === 'player_c' || a === 'npc_c') ? 'C' : a;
  const alive = members
    .map(m => ({ peer_id: m.peer_id, q: m.tile?.q, r: m.tile?.r, alliance: m.alliance ?? m.clan, life: m.life ?? 1 }))
    .filter(m => Number.isInteger(m.q) && Number.isInteger(m.r) && (m.life ?? 1) > 0);
  const occupied = new Set(alive.map(m => `${m.q},${m.r}`));
  const all = [...knownMap.tiles()].map(t => ({ q: t.q, r: t.r }));
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
  if (!knownMap.has(startTile.q, startTile.r)) throw new Error('placement failed');
  const taken = new Set(members.map(m => String(m.peer_id || '').replace(/^peer:/, '')));
  const peerLabel = (label || '').trim() || fancyLabel(taken);
  return { anchorDoor, members, liveDoors, knownMap, startTile, peerLabel, network: networkFromDoors(dim.doors) };
}
