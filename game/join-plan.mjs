// Joining a dimension through its Doors — shared by the desktop launcher
// (ui-server.mjs, Doors read from local Radicle storage) and the Android entry
// (mobile-entry.mjs, Doors read from radicle-httpd on the OCI seed). Pure apart
// from fetchDimensionFromHttpd / listDimensionsFromHttpd.
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

// A Door counts as live while its last push is within two push intervals plus a 5-min margin (user ruling
// 2026-11-15: the live window matches the Door cadence — it was 3 min while peers push every RADICLE_PUSH_SEC =
// 600 s, so live dimensions looked quiet; 2 × 600 s + 300 s = 25 min). Same env + default as peer.mjs.
// A dimension whose newest Door is older is quiet; before regenerating its monsters the caller still asks its bus.
export const DOOR_PUSH_SEC = Number(process.env.RADICLE_PUSH_SEC || 600);
export const DOOR_LIVE_MS = Number(process.env.DOOR_LIVE_MS || (2 * DOOR_PUSH_SEC + 300) * 1000);
// The engine's sides (peer.mjs sideOf): A = player + npc_a, B = npc_b (monsters), C = player_c + npc_c,
// D = player_d + npc_d (the fourth team, user ruling 2026-11-15). Unknown strings are sides of their own.
export const sideOfAlliance = a => (a === 'player' || a === 'npc_a') ? 'A' : a === 'npc_b' ? 'B' : (a === 'player_c' || a === 'npc_c') ? 'C' : (a === 'player_d' || a === 'npc_d') ? 'D' : a;
// The human side of each player team, in the order a new team takes them.
export const TEAM_SIDES = [['A', 'player'], ['C', 'player_c'], ['D', 'player_d']];
export const isLiveDoor = p => Date.now() - Date.parse(p.pushed_at || 0) < DOOR_LIVE_MS;

// Test games are LOCAL and PRIVATE (user 2026-11-16: "test games to be (a) local and private"): Test my character /
// Test my team / Test Random character never publish a Door (peer.mjs DIM_PRIVATE), never announce on the Nostr bus or
// a discovery server, bind loopback only, never leave unattended characters, and run under an unguessable dimension
// id (their libp2p / Gun topics are private). They never count for "one dimension at a time" (nobody else sees them,
// and the launchers skip their peers). Create Dimension (named) stays public.
export const TEST_MODES = ['test-character', 'test-team', 'test-random'];
export const isTestMode = mode => TEST_MODES.includes(mode);
// (DIM_PRIVATE alone stops the Door push and the unattended spawner in peer.mjs; RADICLE_SEED=localhost skips
// radicle-adapter's boot-time `rad node connect` to the OCI seed — a private game has nothing to gossip.)
export const PRIVATE_TEST_ENV = Object.freeze({ DIM_PRIVATE: '1', NOSTR_ENABLED: '0', DISCOVERY_URL: '', PEER_PUBLIC_IP: '127.0.0.1', BIND_HOST: '127.0.0.1', RADICLE_SEED: 'localhost' });
// dim-<slug>-t<8 hex>: a fresh private id per test game (random, so nobody can guess its topic).
export const privateDimId = (name, rnd = Math.random) => `dim-${slug(String(name || 'test'))}-t${Array.from({ length: 8 }, () => Math.floor(rnd() * 16).toString(16)).join('')}`;

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
    consider({ peer_id: p.peer_id, name: p.name, alliance: p.alliance, character_id: p.character_id, creature_id: p.creature_id, tile: p.tile, life: p.life, life_max: p.life_max, last_seen: p.pushed_at, ...(p.out ? { out: true } : {}) }, p.pushed_at);
    for (const m of p.known_members || []) consider(m, p.pushed_at);
  }
  const cutoff = Date.now() - maxAgeMs;
  // `out` (rule_unattended_character / Dimension Out): it left the dimension — not a member any more.
  return [...byId.values()].filter(m => m._seen > cutoff && !m.out).map(({ _seen, ...m }) => m);
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

// Each character's / creature's catalogue combo (data/characters.json, creatures.json versions[].data.combo), for
// the unit list of Doors that don't publish one. Loaded once, lazily; empty when the data dir isn't found.
let _combos = null;
export function comboCatalog() {
  if (_combos) return _combos;
  _combos = new Map();
  const dirs = [process.env.CHAOSD6_DATA_DIR, path.resolve(__dirname, '..', 'data'), path.resolve(__dirname, 'data')].filter(Boolean);
  for (const file of ['characters.json', 'creatures.json']) {
    const hit = dirs.map(d => path.join(d, file)).find(f => fsSync.existsSync(f));
    if (!hit) continue;
    try {
      for (const e of JSON.parse(fsSync.readFileSync(hit, 'utf8')).entries || []) {
        const vs = e.versions || [];   // peer.mjs pickActive: the heaviest version not rejected / superseded
        const v = vs.filter(x => x.status !== 'rejected' && x.status !== 'superseded').sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0] ?? vs[0];
        if (Array.isArray(v?.data?.combo) && v.data.combo.length) _combos.set(e.id, v.data.combo.slice(0, 3));
      }
    } catch {}
  }
  return _combos;
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
// `anchorTile` = the anchor Door's own tile (its unit may be missing from `members` when the Door is stale);
// `nearTile` = "join next to this unit" (launcher unit list): a free, walkable known hex adjacent to it
// (else the closest one), never the unit's own hex.
export const validTile = t => (t && Number.isInteger(t.q) && Number.isInteger(t.r)) ? { q: t.q, r: t.r } : null;
export function placeFromDoors({ members, anchorPeerId, side, placement, knownMap, strongRadius = 2, preferredTile = null, salt = '', anchorTile = null, nearTile = null, farFrom = null }) {
  const sideOf = sideOfAlliance;
  const alive = members
    .map(m => ({ peer_id: m.peer_id, q: m.tile?.q, r: m.tile?.r, alliance: m.alliance ?? m.clan, life: m.life ?? 1 }))
    .filter(m => Number.isInteger(m.q) && Number.isInteger(m.r) && (m.life ?? 1) > 0);
  const occupied = new Set(alive.map(m => `${m.q},${m.r}`));
  anchorTile = validTile(anchorTile); nearTile = validTile(nearTile);
  if (placement === 'far') {
    const own = members.find(m => m.peer_id === anchorPeerId && Number.isInteger(m.tile?.q) && Number.isInteger(m.tile?.r));
    const friend = alive.find(m => sideOf(m.alliance) === sideOf(side));
    const at = own ? { q: own.tile.q, r: own.tile.r } : anchorTile || (friend ? { q: friend.q, r: friend.r } : { q: 2, r: 2 });
    // A new team's Door is distant to them (user ruling 2026-11-15): at least FAR_MIN from every alive unit of
    // another side too, when such a hex exists in the ring; else just FAR_MIN–FAR_MAX from the anchor. `farFrom` =
    // every alive record whatever its age (a quiet dimension's units are still there when it wakes up).
    // Other TEAMS only (user ruling 2026-11-15): wild monsters (npc_b, no owner) don't count; a summon counts with
    // its owner's side (unknown owner → skipped).
    const src = farFrom || members.filter(m => (m.life ?? 1) > 0);
    const allianceOf = new Map(src.map(m => [m.peer_id, m.alliance ?? m.clan]));
    const teamSideOf = (m) => {
      const a = m.alliance ?? m.clan;
      if (a !== 'npc_b') return sideOf(a);
      const oa = m.owner_peer_id ? allianceOf.get(m.owner_peer_id) : null;
      return oa && oa !== 'npc_b' ? sideOf(oa) : null;
    };
    const others = src.map(m => ({ s: teamSideOf(m), q: m.q ?? m.tile?.q, r: m.r ?? m.tile?.r }))
      .filter(m => m.s && Number.isInteger(m.q) && Number.isInteger(m.r) && m.s !== sideOf(side));
    const distant = others.length ? farTileFrom(at, { seed: knownMap.seed, salt, occupied,
      isBlocked: (q, r) => !hexWalkableAt(knownMap.seed, q, r) || others.some(m => hexDistance({ q, r }, m) < FAR_MIN) }) : null;
    const t = distant || farTileFrom(at, { seed: knownMap.seed, salt, occupied });
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
  if (nearTile) {
    const nk = `${nearTile.q},${nearTile.r}`;
    const cand = free.filter(t => `${t.q},${t.r}` !== nk).map(t => ({ t, d: hexDistance(t, nearTile) })).sort((a, b) => a.d - b.d);
    if (!cand.length) throw new Error('the grid is full');
    // Closest walkable ring first (labyrinth walls, fortresses, water… refused); all blocked → closest free hex.
    let best = null;
    for (const c of cand) {
      if (best != null && c.d > best) break;
      if (hexWalkableAt(knownMap.seed, c.t.q, c.t.r)) { best = c.d; }
    }
    const ring = best == null ? cand.filter(c => c.d === cand[0].d) : cand.filter(c => c.d === best && hexWalkableAt(knownMap.seed, c.t.q, c.t.r));
    return rand(ring.map(c => c.t));
  }
  const anchor = anchorPeerId ? alive.filter(m => m.peer_id === anchorPeerId) : [];
  const friends = alive.filter(m => sideOf(m.alliance) === sideOf(side));
  const anchors = anchor.length ? anchor : anchorTile ? [anchorTile] : friends.length ? friends : alive.length ? alive : [{ q: 2, r: 2 }];
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

// ---- radicle-httpd (REST) reads: the phone's view of chaosD6-Dimensions ----
// GET <seed>/api/v1/repos/<rid>/remotes lists every namespace with its heads;
// blob/<sha>/<path> and tree/<sha>/<path> read files at a commit. Node 18
// compatible (global fetch + AbortSignal.timeout). `fetchImpl` is injectable for
// offline tests. Every request goes through one limiter (`concurrency` at once).
const DEFAULT_SEED_HOST = '92-5-138-121.sslip.io';
const DEFAULT_DIMS_RID = 'rad:z2xbfJfwT3kukR73m8LXmmuvchEwr';
const DIM_PREFIX = 'ActiveDimensions/';

function limiter(max) {
  let active = 0; const queue = [];
  const next = () => { if (active < max && queue.length) { active++; queue.shift()(); } };
  return fn => new Promise((resolve, reject) => {
    queue.push(() => Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); }));
    next();
  });
}

function httpdClient({ seedHost = DEFAULT_SEED_HOST, rid = DEFAULT_DIMS_RID, timeoutMs = 8000, concurrency = 6, fetchImpl = fetch } = {}) {
  const origin = (/^https?:\/\//.test(seedHost) ? seedHost : `https://${seedHost}`).replace(/\/+$/, '');   // bare host = HTTPS seed
  const base = `${origin}/api/v1/repos/${rid.startsWith('rad:') ? rid : `rad:${rid}`}`;
  const limit = limiter(Math.max(1, concurrency));
  const fetchJson = tail => limit(async () => {
    const r = await fetchImpl(`${base}/${tail}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${tail}`);
    return r.json();
  });
  // Per-client memo: the listing reads each doors/ tree twice (rank, then read)
  // and the same Door blob (same oid) often sits in several namespaces.
  const memo = new Map();
  const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
  const get = tail => once(`get:${tail}`, () => fetchJson(tail));
  const blob = async (sha, rel, oid = null) => JSON.parse((await (oid ? once(`oid:${oid}`, () => fetchJson(`blob/${sha}/${rel}`)) : get(`blob/${sha}/${rel}`))).content);
  return { get, blob };
}

// One dimension from the namespaces that carry its branch (`heads` = [{ nid, sha }]
// in /remotes order). Same shape as one listPublishedDimensions() item:
//   { dimension_name, dimension_id, dimension, doors: [{...door, nid, ref, commit}], namespaces, legacy_doors }
// dimension.json comes from the first namespace with a readable copy; several
// namespaces can carry the same peer's Door — the newest one is kept.
async function readDimensionAt(client, dimensionName, heads) {
  if (!heads.length) return null;
  const branch = `${DIM_PREFIX}${dimensionName}`;
  const dim = { dimension_name: dimensionName, dimension_id: null, dimension: null, doors: [], namespaces: [], legacy_doors: [] };
  const perNs = await Promise.all(heads.map(async ({ nid, sha }) => {
    const ref = `refs/namespaces/${nid}/refs/heads/${branch}`;
    let entries = [];
    try { entries = (await client.get(`tree/${sha}/${branch}/doors`)).entries || []; } catch {}
    const docs = await Promise.all(entries.filter(e => String(e.name).endsWith('.json')).map(async e => {
      try { return { ...(await client.blob(sha, `${branch}/doors/${e.name}`, e.oid || null)), nid, ref, commit: sha }; } catch { return null; }
    }));
    return docs.filter(Boolean);
  }));
  for (const { sha } of heads) {
    try { dim.dimension = await client.blob(sha, `${branch}/dimension.json`); dim.dimension_id = dim.dimension.dimension_id || null; break; } catch {}
  }
  heads.forEach(({ nid }, i) => {
    dim.namespaces.push(nid);
    for (const doc of perNs[i]) {
      if (!(doc.door_version >= 2 && doc.peer_id)) { dim.legacy_doors.push(doc); continue; }
      const prev = dim.doors.findIndex(d => d.peer_id === doc.peer_id);
      if (prev >= 0 && Date.parse(dim.doors[prev].pushed_at || 0) >= Date.parse(doc.pushed_at || 0)) continue;
      if (prev >= 0) dim.doors.splice(prev, 1);
      dim.doors.push(doc);
    }
  });
  dim.doors.sort((a, b) => Date.parse(b.pushed_at || 0) - Date.parse(a.pushed_at || 0));
  return dim;
}

// Group /remotes heads: Map<dimensionName, [{ nid, sha }]> (remotes order).
function headsByDimension(remotes) {
  const byName = new Map();
  for (const remote of Array.isArray(remotes) ? remotes : []) {
    if (!remote?.id) continue;
    for (const [head, sha] of Object.entries(remote.heads || {})) {
      if (!head.startsWith(DIM_PREFIX) || !sha) continue;
      const name = head.slice(DIM_PREFIX.length);
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ nid: remote.id, sha });
    }
  }
  return byName;
}

const newestOf = d => Date.parse(d.doors[0]?.pushed_at || d.legacy_doors[0]?.last_push?.at || 0) || 0;

// Read a dimension the way listPublishedDimensions() does, but over
// radicle-httpd: every namespace that holds ActiveDimensions/<name> contributes
// its Doors. Returns { dimension_name, dimension_id, dimension, doors, namespaces, legacy_doors }
// with the newest Door first, or null if no namespace has the branch.
export async function fetchDimensionFromHttpd({ seedHost, rid, dimensionName, timeoutMs = 8000, concurrency = 6, fetchImpl = fetch }) {
  const client = httpdClient({ seedHost, rid, timeoutMs, concurrency, fetchImpl });
  const heads = headsByDimension(await client.get('remotes')).get(dimensionName) || [];
  return readDimensionAt(client, dimensionName, heads);
}

// Every ActiveDimensions/* branch in every namespace, grouped by dimension name,
// in the listPublishedDimensions() shape: dimensions with the freshest Door
// first, at most `limit`. Only /remotes failing is fatal; a dimension that can't
// be read (or has no readable dimension.json anywhere) is skipped.
// Two phases, because Door blobs are ~100 KB and the seed answers ~1 s each:
// first one cheap tree/<sha>/…/doors per (dimension, namespace) — its
// lastCommit.committer.time ranks the dimensions — then the blobs of only the
// `limit` freshest are read (backfilling from the rank order if one is
// unreadable). `maxScan` bounds the phase-1 fan-out.
// `include` = dimension names read even when they are not among the `limit` newest (the phone: the ones it has
// saves of — an old quiet dimension where my character is still alive must show up as "You are here").
export async function listDimensionsFromHttpd({ seedHost = DEFAULT_SEED_HOST, rid = DEFAULT_DIMS_RID, limit = 30, timeoutMs = 8000, concurrency = 6, maxScan = 200, fetchImpl = fetch, include = [] } = {}) {
  const client = httpdClient({ seedHost, rid, timeoutMs, concurrency, fetchImpl });
  const byName = headsByDimension(await client.get('remotes'));
  const ranked = await Promise.all([...byName.keys()].slice(0, maxScan).map(async name => {
    const times = await Promise.all(byName.get(name).map(({ sha }) =>
      client.get(`tree/${sha}/${DIM_PREFIX}${name}/doors`).then(t => Number(t?.lastCommit?.committer?.time) || 0, () => 0)));
    return { name, at: Math.max(0, ...times) };
  }));
  ranked.sort((a, b) => b.at - a.at);
  const out = [];
  for (let i = 0; i < ranked.length && out.length < limit;) {
    const batch = ranked.slice(i, i + (limit - out.length)); i += batch.length;
    const dims = await Promise.all(batch.map(({ name }) => readDimensionAt(client, name, byName.get(name)).catch(() => null)));
    out.push(...dims.filter(d => d && d.dimension));
  }
  const extra = [...new Set(include || [])].filter(n => byName.has(n) && !out.some(d => d.dimension_name === n)).slice(0, limit);
  if (extra.length) out.push(...(await Promise.all(extra.map(n => readDimensionAt(client, n, byName.get(n)).catch(() => null)))).filter(d => d && d.dimension));
  out.sort((a, b) => newestOf(b) - newestOf(a));
  return out;
}

// Shape a dimension (a listPublishedDimensions / listDimensionsFromHttpd item)
// for the launcher page — moved from ui-server.mjs so both servers share it.
const ageSecAt = (iso, now) => Math.max(0, Math.round((now - Date.parse(iso || 0)) / 1000));

// ---- exact map shares from the Doors' blocks (user ruling 2026-11-15) ----
// A Door lists its holder's map as blocks (rects / discs), so its hex set is exact: blockTiles() over them,
// as createKnownMap does. Sets are memoised per Door copy (seed + peer + commit + pushed_at + block count) and
// the union per dimension (its Doors' keys), so a launcher re-listing every few seconds recomputes nothing.
const MEMO_MAX = 256;
const _doorKeys = new Map(), _unionKeys = new Map();
const memoPut = (m, k, v) => { if (m.size >= MEMO_MAX) m.delete(m.keys().next().value); m.set(k, v); return v; };
export const seedOfDim = d => (d.doors || []).find(p => p.map?.seed)?.map.seed || seedForDimension(dimIdOf(d));
const doorMemoKey = (seed, p) => `${seed}|${p.peer_id}|${p.commit || ''}|${p.pushed_at || ''}|${(p.map?.blocks || []).length}`;
// Set of "q,r" a Door holds, or null when the Door carries no (valid) blocks.
export function doorTileKeys(seed, p) {
  const blocks = p?.map?.blocks || [];
  if (!blocks.length) return null;
  const k = doorMemoKey(seed, p);
  if (_doorKeys.has(k)) return _doorKeys.get(k);
  const set = new Set();
  for (const t of createKnownMap(seed, blocks).tiles()) set.add(t.key);
  return memoPut(_doorKeys, k, set.size ? set : null);
}
const interSize = (a, b) => { const [s, l] = a.size <= b.size ? [a, b] : [b, a]; let n = 0; for (const k of s) if (l.has(k)) n++; return n; };
const ratio = (n, of) => of > 0 ? Math.round((n / of) * 1000) / 1000 : null;
// → { union_hexes, best, median, mine_hexes, mine_cover, doors: Map<peer_id, { hexes, share, mine_share }> }
//   median = the median Door's share (user ruling 2026-11-15: the summary shows the median Door, not the best)
//   share      = |door| / |union of every Door (+ the genesis block, like mapFromDoors)|
//   mine_share = |door ∩ my save| / |my save|      mine_cover = |my save ∩ union| / |union|
// `mine` = Set of "q,r" of my local save of this dimension (dims-local.mjs saveTileKeys) or null.
export function dimensionMapShares(d, { mine = null } = {}) {
  const seed = seedOfDim(d);
  const doors = (d.doors || []).filter(p => p?.peer_id);
  const sets = doors.map(p => doorTileKeys(seed, p));
  const out = { union_hexes: 0, best: null, median: null, mine_hexes: mine?.size || 0, mine_cover: null, doors: new Map() };
  if (!sets.some(Boolean)) return out;
  const uk = `${seed}#${doors.map(p => doorMemoKey(seed, p)).sort().join('#')}`;
  let union = _unionKeys.get(uk);
  if (!union) {
    union = new Set();
    for (const t of blockTilesOfGenesis()) union.add(t);
    for (const s of sets) if (s) for (const k of s) union.add(k);
    memoPut(_unionKeys, uk, union);
  }
  out.union_hexes = union.size;
  doors.forEach((p, i) => {
    const s = sets[i];
    if (!s) return;
    const share = ratio(s.size, union.size);
    out.doors.set(p.peer_id, { hexes: s.size, share, mine_share: mine?.size ? ratio(interSize(s, mine), mine.size) : null });
    if (share != null && (out.best == null || share > out.best)) out.best = share;
  });
  out.median = medianOf([...out.doors.values()].map(x => x.share).filter(x => x != null));
  if (mine?.size) out.mine_cover = ratio(interSize(mine, union), union.size);
  return out;
}
// Median of the Doors' shares (even count → mean of the two middle ones), 3 decimals; null without any.
export function medianOf(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 1000) / 1000;
}
let _genesis = null;
function blockTilesOfGenesis() {
  if (!_genesis) _genesis = [...createKnownMap('genesis', [initialBlock()]).tiles()].map(t => t.key);
  return _genesis;
}

// ---- alive units a dimension knows (user ruling 2026-11-15) ----
// Every Door's owner plus its known_members, one record per peer_id (newest sighting wins; on a tie the
// unit's own Door). Alive = life > 0 in that newest record. Grouped from the side my top character joins
// as by default (player): ally = player / npc_a, enemy = player_c / npc_c (3rd team), monster = npc_b.
// `via` = the Door that reported the record (the anchor for "join next to it"); no age cut-off, so quiet
// dimensions list their last known units too.
export const unitGroupOf = a => (a === 'player' || a === 'npc_a') ? 'ally' : a === 'npc_b' ? 'monster' : 'enemy';
const GROUP_ORDER = { ally: 0, enemy: 1, monster: 2 };
// Every unit the Doors know, one record per peer_id: the newest sighting wins (on a tie the unit's own Door),
// `_seen` = that sighting's time, `_via` = the Door that reported it. No age cut-off.
export function doorRecords(doors) {
  const byId = new Map();
  const consider = (m, via, at, own) => {
    if (!m?.peer_id) return;
    const seen = Date.parse(m.last_seen || at || 0) || 0;
    const prev = byId.get(m.peer_id);
    if (prev && (seen < prev._seen || (seen === prev._seen && !own))) return;
    byId.set(m.peer_id, { ...m, _seen: seen, _via: via });
  };
  for (const p of doors || []) {
    if (!p?.peer_id) continue;
    consider({ peer_id: p.peer_id, name: p.name, alliance: p.alliance, character_id: p.character_id, creature_id: p.creature_id, tile: p.tile, life: p.life, life_max: p.life_max,
      profile_char_id: p.profile_char_id || '', team_name: p.team_name || '', shadow_of: p.shadow_of || '', ...(p.shadow_death ? { shadow_death: p.shadow_death } : {}), last_seen: p.pushed_at,
      ...unitFieldsOf(p) }, p, p.pushed_at, true);
    for (const m of p.known_members || []) if (m?.peer_id !== p.peer_id) consider(m, p, p.pushed_at, false);   // the Door's own fields describe its owner
  }
  // `out` (rule_unattended_character vanish / Dimension Out): the unit left the dimension — after the hero ↔
  // unattended pairing (an out stand-in, newer, also retires its hero's older record), it is simply not there.
  return resolveShadows([...byId.values()]).filter(m => !m.out);
}
// The unattended-character fields of a Door (peer.mjs doorUnitFields) — only the set ones.
const unitFieldsOf = p => ({ ...(p.ally_of ? { ally_of: p.ally_of } : {}), ...(p.led_by ? { led_by: p.led_by } : {}), ...(Number(p.leader) > 0 ? { leader: Number(p.leader) } : {}),
  ...(p.human ? { human: 1 } : {}), ...(p.joined_at ? { joined_at: p.joined_at } : {}), ...(Array.isArray(p.combo) && p.combo.length ? { combo: p.combo } : {}), ...(p.out ? { out: true } : {}) });
// Every fallen hero shadow these Doors report (rule_hero_shadow): [{ peer_id, name, character_id, profile_char_id,
// shadow_of, shadow_death: { killer, killer_name, card, gift_id, at } }], one per gift id — the player's device
// settles its profile from them (game/shadow-settle.mjs).
export function shadowDeathsOf(doors) {
  const out = new Map();
  const consider = (m) => { const sd = m?.shadow_death; if (!m?.shadow_of || !sd?.gift_id || out.has(sd.gift_id)) return;
    out.set(sd.gift_id, { peer_id: m.peer_id, name: m.name || null, character_id: m.character_id || null, profile_char_id: m.profile_char_id || null, shadow_of: m.shadow_of, shadow_death: sd }); };
  for (const p of doors || []) { consider(p); for (const m of p.known_members || []) consider(m); }
  return [...out.values()];
}
// The newest shadow record of hero `heroPeerId` in these Doors, if it is newer than `sinceMs` (e.g. the save):
// { peer_id, life, tile, dead, killer_name, rec } — a Restore takes it over (alive) or must not revive the hero
// (dead: "its shadow was killed there"). null = no shadow of it stood in since.
export function heroShadowIn(doors, heroPeerId, sinceMs = 0) {
  const raw = new Map();
  const consider = (m, at) => { if (m?.shadow_of !== heroPeerId) return; const seen = Date.parse(m.last_seen || at || 0) || 0; if (seen > sinceMs && (!raw.has(m.peer_id) || raw.get(m.peer_id)._seen < seen)) raw.set(m.peer_id, { ...m, _seen: seen }); };
  for (const p of doors || []) { consider({ ...p, last_seen: p.pushed_at }, p.pushed_at); for (const m of p.known_members || []) consider(m, p.pushed_at); }
  const s = [...raw.values()].sort((a, b) => b._seen - a._seen)[0];
  if (!s || s.out) return null;   // out: the unattended character left the dimension (not dead, not there)
  const own = doorRecords(doors).find(m => m.peer_id === heroPeerId);   // the hero heard after its shadow → it took over
  if (own && (own._seen ?? 0) > s._seen) return null;
  return { peer_id: s.peer_id, life: Number(s.life) || 0, tile: validTile(s.tile), dead: !((Number(s.life) || 0) > 0), killer_name: s.shadow_death?.killer_name || null, seen_ms: s._seen, rec: s };
}
// Hero shadows (rule_hero_shadow, user ruling 2026-11-16): a shadow record S (shadow_of = P) and the record of its
// original P describe ONE character — the newer sighting wins: S newer → P's record is superseded (S alive = the
// character is alive there as its shadow; S dead = the character died there); P newer → the player came back and
// took the shadow over, S drops. Never two alive copies of one character in the list.
export function resolveShadows(recs) {
  const byId = new Map(recs.map(m => [m.peer_id, m]));
  const drop = new Set();
  for (const s of recs) {
    if (!s.shadow_of) continue;
    const p = byId.get(s.shadow_of);
    if (!p) continue;
    if ((s._seen ?? 0) >= (p._seen ?? 0)) drop.add(p.peer_id); else drop.add(s.peer_id);
  }
  return drop.size ? recs.filter(m => !drop.has(m.peer_id)) : recs;
}
const isAliveRec = m => (Number(m.life ?? 1) || 0) > 0;
// LIVE presence (user 2026-11-16: "I cannot join another dimension from my phone, while I am not alive anywhere"):
// a record only says "this character is in that dimension NOW" while its sighting is fresh — the unit's own Door /
// a known_members last_seen within DOOR_LIVE_MS. A player who closed the game without dying leaves an alive
// record behind in a dimension that goes quiet; that record must not block joining elsewhere. While the player is
// away its SHADOW (rule_hero_shadow) is a live record of the same character there, so it still counts.
// Raw records carry `_seen` (ms); launcher items (describeDimension alive_chars) carry `seen_at` (ISO) and `live`
// (as of the describe) — `seen_at` is re-judged against `now`, an item without either is stale.
export function isLiveRecord(m, now = Date.now()) {
  if (!m) return false;
  const seen = m._seen != null ? Number(m._seen) : m.seen_at ? Date.parse(m.seen_at) : NaN;
  if (Number.isFinite(seen) && seen > 0) return now - seen < DOOR_LIVE_MS;
  return m.live === true;
}
export function dimensionUnits(doors, now = Date.now(), { max = 36 } = {}) {
  const all = doorRecords(doors);
  const alive = all.filter(isAliveRec);
  const byId = new Map(alive.map(m => [m.peer_id, m]));
  const combos = comboCatalog();
  const count = { ally: 0, enemy: 0, monster: 0 };
  const sides = { A: 0, B: 0, C: 0, D: 0 };   // alive units per engine side (newTeamSide)
  const units = alive.map(m => {
    const group = unitGroupOf(m.alliance);
    count[group]++;
    const sd = sideOfAlliance(m.alliance); if (sd in sides) sides[sd]++;
    return {
      peer_id: m.peer_id, name: m.name || String(m.peer_id).replace(/^peer:/, ''), alliance: m.alliance ?? null, group,
      kind: m.creature_id ? 'creature' : 'character', life: m.life ?? null, life_max: m.life_max ?? null,
      character_id: m.character_id || null, creature_id: m.creature_id || null, profile_char_id: m.profile_char_id || null,
      tile: validTile(m.tile), age_sec: m._seen ? ageSecAt(new Date(m._seen).toISOString(), now) : null,
      via: m._via.peer_id, via_live: now - Date.parse(m._via.pushed_at || 0) < DOOR_LIVE_MS,
      live: isLiveRecord(m, now), shadow_of: m.shadow_of || null,
      // Unattended characters (rule_unattended_character): unattended = a computer-operated stand-in for its silent
      // player; led_by / led_by_name = the master it follows; leads = how many unattended characters follow this unit.
      // combo (user 2026-11-16 "On the list we should see the combo of each unit"): its published combo, else the
      // character's catalogue combo (data/characters.json); null for units without one.
      unattended: !!m.shadow_of, led_by: m.led_by || null, led_by_name: m.led_by ? (byId.get(m.led_by)?.name || String(m.led_by).replace(/^peer:/, '')) : null,
      leads: alive.filter(o => o.shadow_of && o.led_by === m.peer_id).length,
      combo: (Array.isArray(m.combo) && m.combo.length ? m.combo : combos.get(m.character_id || m.creature_id)) || null,
    };
  }).sort((a, b) => (GROUP_ORDER[a.group] - GROUP_ORDER[b.group]) || ((a.age_sec ?? 1e12) - (b.age_sec ?? 1e12)) || String(a.name).localeCompare(String(b.name)));
  return { units: units.slice(0, max), alive: count, sides, dead: all.length - alive.length };
}

// ---- "Join my top character / my team" = a NEW team on a free side (user rulings 2026-11-15) ----
// "The only way to join as a third team is … the two buttons"; "Fourth team is joining at 4th side on a door
// that is distant to them." The new team takes the first side among A (player), C (player_c), D (player_d) with
// nobody alive on it (`sides` = dimensionUnits().sides / describeDimension units_sides); never B (the monsters).
// All three taken → null: the join is refused (never merged into a side that has units).
export function newTeamSide(sides = {}) {
  for (const [s, alliance] of TEAM_SIDES) if (!(Number(sides[s]) > 0)) return alliance;
  return null;
}
export const thirdTeamSide = newTeamSide;   // older name
export const NO_FREE_SIDE = 'all three player sides (A player, C 3rd team, D 4th team) have units alive in this dimension — no free side for a new team';
// The bot side of a team's characters ("Join my team" / "Test my team" allies): player → npc_a, player_c → npc_c,
// player_d → npc_d.
export const teamBotSide = side => side === 'player_c' ? 'npc_c' : side === 'player_d' ? 'npc_d' : side === 'npc_b' ? 'npc_b' : 'npc_a';

// ---- no cloning (user ruling 2026-11-15) ----
// Is this Door record my profile character `c`? The profile id when the Door carries one (newer builds), else
// base character + name (older Doors).
export const recordIsCharacter = (m, c) => !!(m && c) && (m.profile_char_id ? m.profile_char_id === c.id
  : (!m.creature_id && !!c.base_character && m.character_id === c.base_character && m.name === c.name));
// My profile characters still alive in this dimension, as the Doors know it: [{ character, unit }].
export function aliveProfileUnits(doors, chars) {
  const alive = doorRecords(doors).filter(isAliveRec);
  const out = [];
  for (const c of chars || []) { const u = alive.find(m => recordIsCharacter(m, c)); if (u) out.push({ character: c, unit: { peer_id: u.peer_id, name: u.name, alliance: u.alliance, life: u.life, tile: validTile(u.tile) } }); }
  return out;
}
export const ALREADY_ALIVE = 'you are already alive in this dimension — rejoin/restore instead';
export const aliveText = (hits) => `${hits.map(h => `${h.character.name} (as ${String(h.unit.peer_id).replace(/^peer:/, '')}, hp ${h.unit.life ?? '?'})`).join(', ')}: ${ALREADY_ALIVE}`;
// One dimension at a time (user ruling 2026-11-15): where my characters are alive over EVERY known dimension.
// `dims` = raw dimensions ({ dimension_name, doors }) or launcher items ({ dimension_name, alive_chars }); the first
// item of a name wins (pass the freshly read target dimension first). → [{ character, dimension_name, unit }]
// Only LIVE presence counts (isLiveRecord, user 2026-11-16): a fresh record of the character or of its shadow
// (same profile id / base character + name). Alive-but-stale records of a quiet dimension never block joining
// ELSEWHERE. `anyAgeIn` = the join target's name: there a record of any age still counts (no cloning, ruling
// 2026-11-15 — rejoin / restore that dimension instead of a second copy of me in it).
export function aliveInDimensions(dims, chars, { now = Date.now(), anyAgeIn = null } = {}) {
  const out = [], seen = new Set();
  for (const d of dims || []) {
    if (!d?.dimension_name || seen.has(d.dimension_name)) continue;
    seen.add(d.dimension_name);
    const recs = Array.isArray(d.alive_chars) ? d.alive_chars : doorRecords(d.doors || []).filter(isAliveRec);
    const anyAge = anyAgeIn != null && d.dimension_name === anyAgeIn;
    for (const c of chars || []) {
      const mine = recs.filter(m => isAliveRec(m) && recordIsCharacter(m, c));
      const u = mine.find(m => isLiveRecord(m, now)) || (anyAge ? mine[0] : null);
      if (u) out.push({ character: c, dimension_name: d.dimension_name, unit: { peer_id: u.peer_id, name: u.name, life: u.life ?? null, shadow_of: u.shadow_of || null,
        stale: !isLiveRecord(u, now) } });
    }
  }
  return out;
}
// "↻ Restore <name> here" (user 2026-11-16: "I don't know on which old dimension I am alive. I should see it in the
// list as a restore one, so I announce to the other nodes that I activated it again"): profile character `c`'s
// newest ALIVE record in raw dimension `dim` (any age; shadows resolved by doorRecords), as the env of its return:
// its own peer label (the original's when the record is its shadow — the player takes the shadow over:
// `replaces` = the shadow's peer id, life = the shadow's), last tile, life, side. null = dead / never there.
export function restoreHereTarget(dim, c, now = Date.now()) {
  const recs = doorRecords(dim?.doors || []).filter(m => !m.creature_id && recordIsCharacter(m, c)).sort((a, b) => (b._seen ?? 0) - (a._seen ?? 0));
  const u = recs.find(isAliveRec);
  if (!u) return null;
  const own = u.shadow_of || u.peer_id;
  return { label: String(own).replace(/^peer:/, ''), peer_id: own, replaces: u.shadow_of ? u.peer_id : '', life: Number(u.life) || null, life_max: Number(u.life_max) || null,
    tile: validTile(u.tile), alliance: u.alliance || 'player', live: isLiveRecord(u, now), seen_at: u._seen ? new Date(u._seen).toISOString() : null,
    doorId: u._via?.peer_id || null, unit: { peer_id: u.peer_id, name: u.name, life: u.life ?? null, shadow_of: u.shadow_of || null } };
}
export const aliveWhereText = (hits) => hits.map(h => `${h.character.name} (as ${String(h.unit.peer_id || '?').replace(/^peer:/, '')}${h.unit.shadow_of ? ', its shadow' : ''}, hp ${h.unit.life ?? '?'}) is ${h.unit.stale ? 'still alive (not seen lately)' : 'alive'} in ${h.dimension_name} — rejoin/restore there`).join('; ');

// The 'Monster' join (user ruling 2026-11-15: "We know its type, so the same type of monster should be joined and
// the computer should control it"): the creature type of the Door / unit it joins next to when that is a monster,
// else the dimension's commonest alive wild monster type, else null (the caller falls back to a random creature).
export function knownMonsterType(dim, { doorId = null, nearTile = null } = {}) {
  const recs = doorRecords(dim?.doors || []).filter(m => isAliveRec(m) && m.creature_id && m.alliance === 'npc_b');
  const nt = validTile(nearTile);
  const at = nt && recs.find(m => validTile(m.tile) && m.tile.q === nt.q && m.tile.r === nt.r);
  if (at) return at.creature_id;
  const door = doorId ? (dim?.doors || []).find(p => p.peer_id === doorId || p.door_id === doorId) : null;
  if (door?.creature_id && door.alliance === 'npc_b') return door.creature_id;
  const n = new Map();
  for (const m of recs) if (!m.owner_peer_id) n.set(m.creature_id, (n.get(m.creature_id) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
}

// ---- quiet joins regenerate the Door-known monsters (user ruling 2026-11-15) ----
// "yes they shall be regenerated in their last known place": every alive npc_b creature of the newest records
// (no owner — summons stay with their summoner) on its last tile, with its life. Heroes / allies of other players
// are never regenerated. The joiner starts at most `max` of them, the nearest to its start tile.
export const REGEN_MAX = Number(process.env.REGEN_MAX || 6);
export function quietMonsters(doors) {
  return doorRecords(doors)
    .filter(m => isAliveRec(m) && m.alliance === 'npc_b' && m.creature_id && !m.owner_peer_id && validTile(m.tile))
    .map(m => ({ peer_id: m.peer_id, label: String(m.peer_id).replace(/^peer:/, ''), name: m.name || m.creature_id, creature_id: m.creature_id,
      tile: validTile(m.tile), life: Number(m.life) || null, life_max: Number(m.life_max) || null }));
}
export function nearestMonsters(list, at, max = REGEN_MAX) {
  if (!at) return list.slice(0, max);
  return [...list].sort((a, b) => hexDistance(a.tile, at) - hexDistance(b.tile, at) || String(a.peer_id).localeCompare(String(b.peer_id))).slice(0, Math.max(0, max));
}
// Doors are pushed every ~10 min but count as live for 3: a dimension can look quiet while its peers still run.
// Before regenerating, listen on the dimension's bus for `ms`: anybody heard → it is live, nothing is regenerated
// (two copies of one monster peer id would fight over its state).
export async function probeDimensionLive({ dimId, relays = DEFAULT_RELAYS, ms = Number(process.env.REGEN_PROBE_MS || 4000) }) {
  const { createNostrBus } = await import('./nostr-bus.mjs');
  const heard = new Set();
  const bus = createNostrBus({ relays, dimId, label: 'regen-probe', log: () => {}, warn: () => {}, onEvent(type, payload) {
    const id = type === 'state' ? payload?.peer_id : type === 'env' ? payload?.actor_peer_id : null;
    if (id) heard.add(id);
  } });
  await new Promise(r => setTimeout(r, ms));
  try { bus.close(); } catch {}
  return { peers: [...heard] };
}
// As placement members (their tiles are taken before they are up).
export const asMembers = (mons) => mons.map(m => ({ peer_id: m.peer_id, name: m.name, alliance: 'npc_b', creature_id: m.creature_id, tile: m.tile, life: m.life ?? 1 }));

// `mine` = Set of "q,r" of my local save of this dimension (for the "% shared with my copy" fields) or null.
// `sketch: false` drops the Doors' map_sketch strings (~0.9 KB each; the phone's list — exact shares replace them).
export function describeDimension(d, now = Date.now(), { mine = null, sketch = true } = {}) {
  let shares;
  try { shares = dimensionMapShares(d, { mine }); } catch { shares = { union_hexes: 0, best: null, median: null, mine_hexes: 0, mine_cover: null, doors: new Map() }; }
  const doors = (d.doors || []).map(p => ({
    peer_id: p.peer_id, name: p.name, alliance: p.alliance, character_id: p.character_id, creature_id: p.creature_id,
    tile: p.tile, life: p.life, life_max: p.life_max, clock: p.clock, pushed_at: p.pushed_at, age_sec: ageSecAt(p.pushed_at, now),
    live: now - Date.parse(p.pushed_at || 0) < DOOR_LIVE_MS, nid: p.nid, commit: p.commit,
    known_members: (p.known_members || []).length, known_tiles: (p.known_tiles || []).length,
    map_tiles: p.map_tiles ?? p.map?.tiles_known ?? null, map_blocks: (p.map?.blocks || []).length,
    map_sketch: sketch && typeof p.map_sketch === 'string' ? p.map_sketch : null,   // bottom-K map fingerprint (newer Doors only)
    // Exact, from the Door's blocks (null without blocks): its hexes, its share of the dimension, of my copy.
    map_hexes: shares.doors.get(p.peer_id)?.hexes ?? null, map_share: shares.doors.get(p.peer_id)?.share ?? null,
    mine_share: shares.doors.get(p.peer_id)?.mine_share ?? null,
  }));
  const newest = doors[0]?.pushed_at || d.legacy_doors?.[0]?.last_push?.at || null;
  const u = dimensionUnits(d.doors || [], now);
  return {
    dimension_name: d.dimension_name, dimension_id: dimIdOf(d), namespaces: d.namespaces,
    doors, members: unionMembers(d.doors || []),
    live_doors: doors.filter(p => p.live).length,
    legacy: !doors.length && (d.legacy_doors || []).length > 0,
    newest_push: newest, age_sec: newest ? ageSecAt(newest, now) : null,
    turn: Math.max(0, ...doors.filter(p => p.live).map(p => p.clock?.turn ?? 0)),
    // Launcher stats (user ruling 2026-11-15): turn so far over every Door, live or not, and the hexes revealed
    // (the union of the Doors' map blocks; the biggest single Door's count if the blocks can't be read).
    turn_max: Math.max(0, ...doors.map(p => Number(p.clock?.turn) || 0)),
    hexes: Math.max(shares.union_hexes, ...doors.map(p => Math.max(Number(p.map_tiles) || 0, Number(p.known_tiles) || 0)), 0),
    // Map shares: the median Door's share of the dimension (user ruling 2026-11-15, was the best Door's);
    // my save's hexes and how much of the dimension it covers.
    map_share_median: shares.median, mine_hexes: shares.mine_hexes, mine_cover: shares.mine_cover,
    // Alive units it knows (any age): [{ peer_id, name, alliance, group, kind, life, life_max, character_id, creature_id,
    // profile_char_id, tile, age_sec, via, via_live }].
    units: u.units, units_alive: u.alive, units_dead: u.dead,
    // The side "Join my top character / my team" takes (newTeamSide; null = no free side), the alive units per
    // engine side, and every alive character the Doors know (not capped like `units`) so the launcher can grey
    // out joins of a profile character that is alive (here or in another dimension).
    new_team_side: newTeamSide(u.sides), units_sides: u.sides,
    // `live` / `seen_at` (user 2026-11-16): only a live record (fresh sighting, or a live shadow) means "alive
    // there now" — aliveInDimensions re-judges `seen_at`, the UI tooltip uses `live`.
    alive_chars: doorRecords(d.doors || []).filter(m => isAliveRec(m) && !m.creature_id)
      .map(m => ({ peer_id: m.peer_id, name: m.name || null, character_id: m.character_id || null, profile_char_id: m.profile_char_id || null, life: m.life ?? null,
        life_max: m.life_max ?? null, alliance: m.alliance ?? null, tile: validTile(m.tile),
        seen_at: m._seen ? new Date(m._seen).toISOString() : null, age_sec: m._seen ? ageSecAt(new Date(m._seen).toISOString(), now) : null,
        live: isLiveRecord(m, now), shadow_of: m.shadow_of || null })),
    // Fallen hero shadows (rule_hero_shadow): the player's device takes their death card out of its profile.
    shadow_deaths: shadowDeathsOf(d.doors || []),
  };
}

// Everything a joining peer needs, as peer.mjs env vars (minus ports and the
// map-blocks file, which depend on where the caller runs). `doorId` is the
// anchor unit's peer_id (or door_id); `side` the joiner's alliance.
// Stale Doors are fine (user ruling 2026-11-15): with no live Door the joiner starts the dimension from the
// Doors' map and nobody else is there until someone arrives. `nearTile` = next to that unit (unit list).
// `regen` (quiet dimensions only — no live Door): the Door-known monsters come back (quietMonsters) — their tiles
// count as taken for my placement, and the `regenMax` nearest to my start tile are returned as `regen`. The caller
// adds its vetoes (nobody answers on the bus — probeDimensionLive —, no local peers in it) before starting them.
export function planJoin(dim, { doorId = null, side = 'player', placement = 'nearby', label = '', extraMembers = [], preferredTile = null, nearTile = null, regen = false, regenMax = REGEN_MAX } = {}) {
  if (!dim.doors.length) throw new Error(`${dim.dimension_name} has no Doors`);
  const anchorDoor = doorId ? dim.doors.find(p => p.peer_id === doorId || p.door_id === doorId) : dim.doors[0];
  if (doorId && !anchorDoor) throw new Error(`no Door from ${doorId} on ${dim.dimension_name}`);
  const liveDoors = dim.doors.filter(isLiveDoor);
  const regenAll = regen && !liveDoors.length ? quietMonsters(dim.doors) : [];
  const byId = new Map(unionMembers(dim.doors).map(m => [m.peer_id, m]));
  for (const m of [...asMembers(regenAll), ...extraMembers]) byId.set(m.peer_id, { ...(byId.get(m.peer_id) || {}), ...m });   // live view wins
  const members = [...byId.values()];
  const knownMap = mapFromDoors(dim);
  const startTile = placeFromDoors({ members, anchorPeerId: anchorDoor?.peer_id, side, placement, knownMap, preferredTile,
    anchorTile: anchorDoor?.tile, nearTile: placement === 'nearby' ? nearTile : null,
    farFrom: placement === 'far' ? [...doorRecords(dim.doors).filter(isAliveRec), ...members.filter(m => (m.life ?? 1) > 0)] : null });
  if (placement !== 'far' && !knownMap.has(startTile.q, startTile.r)) throw new Error('placement failed');
  const taken = new Set(members.map(m => String(m.peer_id || '').replace(/^peer:/, '')));
  const peerLabel = (label || '').trim() || fancyLabel(taken);
  return { anchorDoor, members, liveDoors, knownMap, startTile, peerLabel, network: networkFromDoors(dim.doors), doorMaps: doorMapSummaries(dim, knownMap),
    regen: nearestMonsters(regenAll, startTile, regenMax), regenKnown: regenAll.length };
}

// What a joiner's HUD needs about each Door's map (telemetry shares[] with source 'door', for nodes it
// knows only through their Door). `held` = hexes of the Door's blocks the joiner starts with: the joiner
// seeds its map from `knownMap` (the union of all Doors' blocks) and its map only grows, so `held` stays
// exactly |theirs ∩ mine| and held / (my hexes) is the exact share. A Door without blocks keeps only its
// `map_sketch` (the peer estimates from it) or nothing (older builds). Written to DOOR_MAPS_FILE.
export function doorMapSummaries(dim, knownMap = mapFromDoors(dim)) {
  return (dim.doors || []).filter(p => p?.peer_id).map(p => {
    let held = null;
    const blocks = p.map?.blocks || [];
    if (blocks.length) {
      const own = createKnownMap(knownMap.seed, blocks);
      held = 0;
      for (const t of own.tiles()) if (knownMap.hasKey(t.key)) held++;
    }
    return {
      peer_id: p.peer_id, name: p.name || p.peer_id, alliance: p.alliance ?? null,
      character_id: p.character_id || null, creature_id: p.creature_id || null,
      tile: p.tile || null, life: p.life ?? null, life_max: p.life_max ?? null, pushed_at: p.pushed_at || null,
      map_tiles: p.map_tiles ?? p.map?.tiles_known ?? null, map_sketch: typeof p.map_sketch === 'string' ? p.map_sketch : '',
      held, held_of: knownMap.size(),
    };
  });
}
