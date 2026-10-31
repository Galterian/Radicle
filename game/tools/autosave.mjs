// Local TMJ (Tiled JSON) autosave of the current dimension state.
//
// Goal: if every player goes offline the dimension is not lost — the last
// known tileset + obstacles + entities live in `data/dimensions/<dim_id>/`
// on this machine, re-loadable from the launcher.
//
// Pipeline:
//   [ gameplay / tile mutation ] → `markDirty()`
//   every `intervalMs` (default 60 s): if dirty, snapshot + write async
//   on quit / hardSave(): rename `map_autosave.tmj` → `map_hard.tmj`
//
// Optimisations (user spec, 2026-10-31):
//   • dirty flag: single boolean, serializer is a no-op if false
//   • async: fs.promises.writeFile + rename, no sync fs on the hot path
//   • flat properties: Tiled rejects nested objects in `properties[].value`,
//     so non-scalar payloads (tokens / traps / bounds) are JSON strings
//     under the top-level `properties[]`
//   • autosave vs hard save: distinct filenames; hard save survives relaunch
//
// Future delta hook (OUT OF SCOPE here, but prepared): the dirty flag is a
// boolean today. The controller already buckets revealed hexes into 16×16
// chunks keyed by `(q >> 4, r >> 4)` when it builds the TMJ. Replace
// `_dirty` with a `Set<string>` of dirty chunk keys and have mutators tag
// the right chunk — the writer can then emit only those chunks (and leave
// unchanged chunks referenced from the previous file). The TMJ chunk array
// is already addressable by `(x, y)` so a delta writer just rebuilds the
// touched chunks and merges with the on-disk file. See `_chunkKey` below.
//
// Only node built-ins are used. No new npm deps.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { biomeFor, BIOMES } from '../js/biome.js';
import { blockTiles } from '../js/map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const DIMENSIONS_DIR = path.join(REPO_ROOT, 'data', 'dimensions');

export const SCHEMA_VERSION = 'chaosd6-tmj-1';
export const CHUNK = 16;

// Hex meta — matches assets/terrain/terrain_tiles.json (pointy-top).
const HEX_TILE_W = 159;
const HEX_TILE_H = 132;
const HEX_SIDE   = 46;

const _chunkKey = (q, r) => `${q >> 4},${r >> 4}`;

function flatProps(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) { out.push({ name: k, type: 'string', value: '' }); continue; }
    let type, value;
    if (typeof v === 'boolean')       { type = 'bool';  value = v; }
    else if (typeof v === 'number')   { type = Number.isInteger(v) ? 'int' : 'float'; value = v; }
    else if (typeof v === 'string')   { type = 'string'; value = v; }
    else                              { type = 'string'; value = JSON.stringify(v); }   // never a nested object
    out.push({ name: k, type, value });
  }
  return out;
}
const propsOf = (o) => Object.fromEntries(((o && o.properties) || []).map(p => [p.name, p.value]));

// Pure: snapshot → Tiled v1.10 compatible JSON object.
export function tmjFromSnapshot(snap) {
  const seed = String(snap.seed ?? '');
  const blocks = Array.isArray(snap.blocks) ? snap.blocks : [];
  const meta = snap.meta || {};
  const biome = biomeFor(seed);

  // Bucket revealed hexes into 16×16 chunks addressed by (cq, cr).
  const buckets = new Map();   // "cq,cr" -> number[CHUNK*CHUNK]
  for (const b of blocks) {
    for (const t of blockTiles(b)) {
      const cq = Math.floor(t.q / CHUNK), cr = Math.floor(t.r / CHUNK);
      const key = `${cq},${cr}`;
      let data = buckets.get(key);
      if (!data) { data = new Array(CHUNK * CHUNK).fill(0); buckets.set(key, data); }
      const lx = t.q - cq * CHUNK;
      const ly = t.r - cr * CHUNK;
      const biomeName = biome.biomeAt(t.q, t.r);
      const biomeIdx = BIOMES.indexOf(biomeName);
      // GID 0 = unknown. GID 1..N = biome index into the tileset.
      data[ly * CHUNK + lx] = biomeIdx >= 0 ? biomeIdx + 1 : 0;
    }
  }
  const chunks = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, data]) => {
      const [cq, cr] = k.split(',').map(Number);
      return { x: cq * CHUNK, y: cr * CHUNK, width: CHUNK, height: CHUNK, data };
    });

  // Object layers — one id namespace across both.
  const obstacles = (snap.obstacles || []).map((o, i) => ({
    id: i + 1, type: 'obstacle', name: String(o.id ?? `obs${i}`),
    x: Number(o.q || 0) * HEX_SIDE, y: Number(o.r || 0) * HEX_SIDE,
    width: HEX_SIDE, height: HEX_SIDE, visible: true, rotation: 0,
    properties: flatProps({ q: Number(o.q || 0), r: Number(o.r || 0), hp: Number(o.hp || 0), elem: String(o.elem || ''), owner: String(o.owner || '') }),
  }));
  const nextId = obstacles.length + 1;
  const entities = (snap.entities || []).map((e, i) => ({
    id: nextId + i, type: 'entity', name: String(e.name || e.peer_id || `ent${i}`),
    x: Number(e.tile_q || 0) * HEX_SIDE, y: Number(e.tile_r || 0) * HEX_SIDE,
    width: HEX_SIDE, height: HEX_SIDE, visible: true, rotation: 0,
    properties: flatProps({
      peer_id:   String(e.peer_id   || ''),
      source_id: String(e.source_id || ''),
      alliance:  String(e.alliance  || ''),
      hp:        Number(e.hp     ?? 0),
      hp_max:    Number(e.hp_max ?? 0),
      tile_q:    Number(e.tile_q ?? 0),
      tile_r:    Number(e.tile_r ?? 0),
      class_id:  String(e.class_id || ''),
    }),
  }));

  const topProps = flatProps({
    schema_version: SCHEMA_VERSION,
    seed,
    dim_id:     String(meta.dim_id     || ''),
    dim_name:   String(meta.dim_name   || ''),
    peer_id:    String(meta.peer_id    || ''),
    peer_label: String(meta.peer_label || ''),
    turn:       Number(meta.turn  ?? 0),
    round:      Number(meta.round ?? 0),
    saved_at:   new Date().toISOString(),
    tokens_json: JSON.stringify(snap.tokens || []),
    traps_json:  JSON.stringify(snap.traps  || []),
    bounds_json: JSON.stringify(snap.bounds || null),
  });

  return {
    type: 'map',
    version: '1.10',
    tiledversion: '1.10.2',
    orientation: 'hexagonal',
    renderorder: 'right-down',
    infinite: true,
    staggeraxis: 'y',       // pointy-top: y staggers
    staggerindex: 'odd',
    hexsidelength: HEX_SIDE,
    width: 0, height: 0,    // infinite map — Tiled ignores these but keeps them for schema
    tilewidth: HEX_TILE_W,
    tileheight: HEX_TILE_H,
    nextlayerid: 4,
    nextobjectid: nextId + entities.length + 1,
    properties: topProps,
    tilesets: [{
      firstgid: 1,
      name: 'biomes',
      tilecount: BIOMES.length,
      columns: 1,
      tilewidth: HEX_TILE_W,
      tileheight: HEX_TILE_H,
      tiles: BIOMES.map((n, i) => ({ id: i, properties: [{ name: 'biome', type: 'string', value: n }] })),
    }],
    layers: [
      { id: 1, name: 'terrain', type: 'tilelayer', visible: true, opacity: 1, startx: 0, starty: 0, width: CHUNK, height: CHUNK, chunks },
      { id: 2, name: 'obstacles', type: 'objectgroup', visible: true, opacity: 1, draworder: 'topdown', objects: obstacles },
      { id: 3, name: 'entities',  type: 'objectgroup', visible: true, opacity: 1, draworder: 'topdown', objects: entities },
    ],
  };
}

// Reverse of tmjFromSnapshot. Throws for a wrong schema_version.
export async function loadTmj(filepath) {
  const raw = await fs.readFile(filepath, 'utf8');
  const map = JSON.parse(raw);
  const props = propsOf(map);
  const sv = String(props.schema_version || '');
  if (!sv.startsWith('chaosd6-tmj-')) throw new Error(`not a chaosD6 TMJ (schema_version=${JSON.stringify(sv)}): ${filepath}`);

  const biomeTiles = (map.tilesets?.[0]?.tiles) || [];
  const biomeByGid = new Map(biomeTiles.map(t => [t.id + 1, (t.properties || []).find(p => p.name === 'biome')?.value || null]));

  const terrainLayer = (map.layers || []).find(l => l.name === 'terrain') || {};
  const tiles = [];
  const dirtyChunks = new Set();
  for (const ch of terrainLayer.chunks || []) {
    const data = ch.data || [];
    for (let i = 0; i < data.length; i++) {
      const gid = data[i];
      if (!gid) continue;
      const lx = i % ch.width;
      const ly = Math.floor(i / ch.width);
      const q = ch.x + lx, r = ch.y + ly;
      tiles.push({ q, r, biome: biomeByGid.get(gid) || null });
      dirtyChunks.add(_chunkKey(q, r));
    }
  }

  const obstaclesLayer = (map.layers || []).find(l => l.name === 'obstacles') || { objects: [] };
  const entitiesLayer  = (map.layers || []).find(l => l.name === 'entities')  || { objects: [] };
  const obstacles = (obstaclesLayer.objects || []).map(o => {
    const p = propsOf(o);
    return { id: o.name, q: Number(p.q || 0), r: Number(p.r || 0), hp: Number(p.hp || 0), elem: String(p.elem || ''), owner: String(p.owner || '') };
  });
  const entities = (entitiesLayer.objects || []).map(o => {
    const p = propsOf(o);
    return {
      peer_id: String(p.peer_id || ''), source_id: String(p.source_id || ''), alliance: String(p.alliance || ''),
      name: o.name, hp: Number(p.hp || 0), hp_max: Number(p.hp_max || 0),
      tile_q: Number(p.tile_q || 0), tile_r: Number(p.tile_r || 0), class_id: String(p.class_id || ''),
    };
  });
  const safeParse = (s, dflt) => { try { return JSON.parse(s); } catch { return dflt; } };
  return {
    seed: String(props.seed || ''),
    bounds: safeParse(props.bounds_json, null),
    tiles,
    chunks: [...dirtyChunks],
    obstacles,
    tokens: safeParse(props.tokens_json, []),
    traps:  safeParse(props.traps_json, []),
    entities,
    meta: {
      schema_version: sv,
      dim_id:     String(props.dim_id     || ''),
      dim_name:   String(props.dim_name   || ''),
      peer_id:    String(props.peer_id    || ''),
      peer_label: String(props.peer_label || ''),
      turn:       Number(props.turn  || 0),
      round:      Number(props.round || 0),
      saved_at:   String(props.saved_at || ''),
    },
  };
}

// Globs `baseDir/*/map_{autosave,hard}.tmj`, reads just the properties
// block of each (fast — no need to parse the whole chunk array for a summary).
export async function listSavedDimensions(baseDir = DIMENSIONS_DIR) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(baseDir, { withFileTypes: true }); }
  catch { return out; }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    for (const kind of ['autosave', 'hard']) {
      const fp = path.join(baseDir, d.name, `map_${kind}.tmj`);
      let raw; try { raw = await fs.readFile(fp, 'utf8'); } catch { continue; }
      let map;  try { map = JSON.parse(raw); } catch { continue; }
      const p = propsOf(map);
      if (!String(p.schema_version || '').startsWith('chaosd6-tmj-')) continue;
      out.push({
        dim_id:   String(p.dim_id   || d.name),
        dim_name: String(p.dim_name || d.name),
        path: fp, kind,
        saved_at: String(p.saved_at || ''),
        seed:     String(p.seed || ''),
      });
    }
  }
  // Freshest first.
  out.sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
  return out;
}

// Tiny controller: owns the dirty flag, the timer and the write lock.
export function start({ dimensionId, dimensionName, mapSeed, intervalMs = 60_000, getSnapshot, baseDir }) {
  if (!dimensionId) throw new Error('autosave.start: dimensionId required');
  if (typeof getSnapshot !== 'function') throw new Error('autosave.start: getSnapshot callback required');
  const dir = path.join(baseDir || DIMENSIONS_DIR, dimensionId);
  const autosavePath = path.join(dir, 'map_autosave.tmj');
  const hardPath     = path.join(dir, 'map_hard.tmj');

  // Design: a boolean today. Future delta pass turns this into a Set<string>
  // of chunk keys (see _chunkKey) and lets mutators tag the chunk they
  // touched; the serializer then rewrites only those chunks of the TMJ.
  let _dirty = false;
  let _writing = false;
  let _stopped = false;
  let _ensured = false;

  async function ensureDir() {
    if (_ensured) return;
    await fs.mkdir(dir, { recursive: true });
    _ensured = true;
  }
  async function writeAtomic(target, obj) {
    await ensureDir();
    const tmp = target + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(obj));
    await fs.rename(tmp, target);
  }

  async function flush() {
    if (_writing || !_dirty) return false;
    _writing = true;
    const snap = getSnapshot();
    try {
      const tmj = tmjFromSnapshot(snap);
      await writeAtomic(autosavePath, tmj);
      _dirty = false;      // only clear after the rename lands
      return true;
    } catch (e) {
      console.warn(`[autosave] flush failed (${autosavePath}): ${e.message} — will retry next tick`);
      return false;
    } finally {
      _writing = false;
    }
  }

  const _timer = setInterval(() => { flush().catch(() => {}); }, Math.max(1_000, Number(intervalMs) || 60_000));
  // Don't keep the Node event loop alive just for the autosave timer.
  if (typeof _timer.unref === 'function') _timer.unref();

  async function hardSave() {
    _dirty = true;
    await flush();
    try { await fs.rename(autosavePath, hardPath); }
    catch (e) {
      if (e.code === 'ENOENT') return;   // nothing was ever flushed
      console.warn(`[autosave] hardSave rename failed: ${e.message}`);
    }
  }
  async function stop() {
    if (_stopped) return;
    _stopped = true;
    clearInterval(_timer);
    try { await hardSave(); } catch {}
  }

  function markDirty(/* chunkKey optional for future delta */) { _dirty = true; }
  // Mark the flag immediately so a shutdown within the first interval
  // still persists.
  markDirty();

  return {
    markDirty,
    flush,
    hardSave,
    stop,
    path: autosavePath,
    hardPath,
    dir,
    get dirty() { return _dirty; },
  };
}
