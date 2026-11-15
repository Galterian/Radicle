// Local footprint of a dimension and the launcher's "✕ delete old dimension" (user ruling 2026-11-15) —
// shared by the desktop launcher (ui-server.mjs) and the phone's menu (mobile-menu.mjs).
//
//   "old"    = nothing happened for OLD_AFTER_MS (72 h): newest of its Doors' pushed_at, the local save's
//              saved_at / file mtime, the tape (sessions/<Name>/) mtime and, on the desktop, the local bare
//              branch's commit date.
//   delete   = ONLY local data: data/dimensions/<dim_id>/ (TMJ saves), game/sessions/<Name>/ (tape + map-blocks
//              cache) and — desktop, done by the caller through radicle-adapter forgetLocalDimension — the local
//              bare / work-tree branch ActiveDimensions/<Name>. The Radicle branch stays on the network; a
//              tombstone (<profile dir>/hidden-dimensions.json { name: hidden_at }) hides the dimension until a
//              Door (or a save) newer than hidden_at shows up.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileDir } from './profile.mjs';
import { DIMENSIONS_DIR } from './tools/autosave.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// CHAOSD6_SESSIONS_DIR: test launchers only. peer.mjs writes the tape to game/sessions/<DIM_NAME>/.
export const SESSIONS_DIR = process.env.CHAOSD6_SESSIONS_DIR || path.join(__dirname, 'sessions');
export const OLD_AFTER_MS = Number(process.env.DIMS_OLD_AFTER_MS) || 72 * 3600 * 1000;
export const DIM_ID_RE = /^dim-[a-z0-9-]+$/;
export const LOCAL_ONLY_NOTE = 'deletes your local copy only — the Radicle branch stays on the network';

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const dimIdForName = (name) => `dim-${slug(name)}`;
// A dimension name usable as ONE path component (sessions/<Name>): no separators, no control chars, not . / ..
export const safeDimName = (name) => typeof name === 'string' && name.length > 0 && name.length <= 200
  && !/[\x00-\x1f\x7f/\\]/.test(name) && name !== '.' && name !== '..' && !name.includes('..');
// `base/<child>` when child is a single component that stays inside base, else null.
export function childPath(base, child) {
  if (!base || typeof child !== 'string' || !child) return null;
  const b = path.resolve(base), p = path.resolve(b, child);
  const rel = path.relative(b, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || rel.includes('/')) return null;
  return p;
}

// { bytes, mtime(ms) } of a file or a directory tree (symlinks are not followed).
export async function pathStats(p) {
  let st;
  try { st = await fs.lstat(p); } catch { return { bytes: 0, mtime: 0, exists: false }; }
  if (st.isFile()) return { bytes: st.size, mtime: st.mtimeMs, exists: true };
  if (!st.isDirectory()) return { bytes: 0, mtime: 0, exists: true };
  let bytes = 0, mtime = st.mtimeMs;
  let ents = [];
  try { ents = await fs.readdir(p, { withFileTypes: true }); } catch {}
  for (const e of ents) {
    const s = await pathStats(path.join(p, e.name));
    bytes += s.bytes; if (s.mtime > mtime) mtime = s.mtime;
  }
  return { bytes, mtime, exists: true };
}

// ---- tombstones -------------------------------------------------------------------------------
export const hiddenFile = () => path.join(profileDir(), 'hidden-dimensions.json');
export async function loadHidden(file = hiddenFile()) {
  try { const j = JSON.parse(await fs.readFile(file, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; }
  catch { return {}; }
}
export async function hideDimension(name, at = new Date().toISOString(), file = hiddenFile()) {
  const h = await loadHidden(file);
  h[name] = at;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(h, null, 2));
  await fs.rename(`${file}.tmp`, file);
  return h;
}
// Hidden while nothing newer than the tombstone was seen.
export const isHidden = (hidden, name, lastActiveIso) =>
  !!hidden?.[name] && !(Date.parse(lastActiveIso || 0) > Date.parse(hidden[name]));

// ---- stats ------------------------------------------------------------------------------------
const maxIso = (...xs) => {
  const t = Math.max(0, ...xs.map(x => (typeof x === 'number' ? x : Date.parse(x || 0)) || 0));
  return t ? new Date(t).toISOString() : null;
};

// Local data of one dimension: its save dirs (from the save items), its tape dir, and `branch` = { bytes, at }
// for the desktop's local bare branch. → { bytes, parts, last_local_at, paths }
export async function localFootprint({ name, saves = [], branch = null, dimensionsDir = DIMENSIONS_DIR, sessionsDir = SESSIONS_DIR }) {
  const parts = { saves: 0, tape: 0, branch: Number(branch?.bytes) || 0 };
  const paths = [];
  let last = Date.parse(branch?.at || 0) || 0;
  for (const dir of new Set(saves.map(s => s.dir || path.basename(path.dirname(s.path || ''))))) {
    const p = DIM_ID_RE.test(dir) ? childPath(dimensionsDir, dir) : null;
    if (!p) continue;
    const st = await pathStats(p);
    if (!st.exists) continue;
    parts.saves += st.bytes; last = Math.max(last, st.mtime); paths.push(p);
  }
  for (const s of saves) last = Math.max(last, Date.parse(s.saved_at || 0) || 0);
  const tape = safeDimName(name) ? childPath(sessionsDir, name) : null;
  if (tape) {
    const st = await pathStats(tape);
    if (st.exists) { parts.tape = st.bytes; last = Math.max(last, st.mtime); paths.push(tape); }
  }
  return { bytes: parts.saves + parts.tape + parts.branch, parts, last_local_at: last ? new Date(last).toISOString() : null, paths };
}

const keyOf = (id, name) => id || dimIdForName(name || '');

// ---- my copy's hexes (for the Doors' "% shared with my copy", join-plan.mjs dimensionMapShares) ----------
// Set of "q,r" of a TMJ save (non-zero GIDs of its terrain chunks, autosave.mjs loadTmj's rule), memoised per
// file + mtime + size; null when unreadable / empty.
const _saveKeys = new Map();
export async function saveTileKeys(file) {
  let st;
  try { st = await fs.stat(file); } catch { return null; }
  const k = `${file}|${st.mtimeMs}|${st.size}`;
  if (_saveKeys.has(k)) return _saveKeys.get(k);
  let set = null;
  try {
    const map = JSON.parse(await fs.readFile(file, 'utf8'));
    set = new Set();
    for (const ch of ((map.layers || []).find(l => l.name === 'terrain')?.chunks || [])) {
      const data = ch.data || [], w = ch.width || 16;
      for (let i = 0; i < data.length; i++) if (data[i]) set.add(`${ch.x + (i % w)},${ch.y + Math.floor(i / w)}`);
    }
    if (!set.size) set = null;
  } catch { set = null; }
  if (_saveKeys.size >= 64) _saveKeys.delete(_saveKeys.keys().next().value);
  _saveKeys.set(k, set);
  return set;
}
// Map<dimension key (dim id), Set "q,r"> from the freshest save of each dimension (`saves` = listSavedDimensions, freshest first).
export async function mineMapsOf(saves = []) {
  const out = new Map(), tried = new Set();
  for (const s of saves) {
    const key = keyOf(s.dim_id, s.dim_name);
    if (tried.has(key) || !s.path) continue;
    tried.add(key);
    const set = await saveTileKeys(s.path);
    if (set) { out.set(key, set); if (s.dim_name && !out.has(dimIdForName(s.dim_name))) out.set(dimIdForName(s.dim_name), set); }
  }
  return out;
}

// Adds the launcher fields to both lists and drops tombstoned dimensions:
//   radicle item (describeDimension) + { on_radicle, saved_locally, local_bytes, local_parts, last_active, old, hexes, turn_max }
//   save item (listSavedDimensions)  + { on_radicle, local_bytes, local_parts, last_active, old }
// `radicle` = null when the Radicle list is unknown here (then on_radicle is null for saves).
// `branches` = Map<name, { sha, at }> (desktop bare), `branchBytes(name, sha)` → bytes.
export async function enrichDimensions({ radicle = null, saves = [], hidden = {}, branches = null, branchBytes = null,
  dimensionsDir = DIMENSIONS_DIR, sessionsDir = SESSIONS_DIR, running = () => false, now = Date.now() } = {}) {
  const savesByKey = new Map();
  for (const s of saves) { const k = keyOf(s.dim_id, s.dim_name); if (!savesByKey.has(k)) savesByKey.set(k, []); savesByKey.get(k).push(s); }
  const radByKey = new Map((radicle || []).map(d => [keyOf(d.dimension_id, d.dimension_name), d]));
  const memo = new Map();
  const footprint = (key, name) => {
    if (!memo.has(key)) memo.set(key, (async () => {
      const b = branches?.get(name) || null;
      const branch = b ? { at: b.at, bytes: branchBytes ? await branchBytes(name, b.sha) : 0 } : null;
      return localFootprint({ name, saves: savesByKey.get(key) || [], branch, dimensionsDir, sessionsDir });
    })());
    return memo.get(key);
  };
  const oldAt = (iso) => !iso || now - Date.parse(iso) > OLD_AFTER_MS;
  const outRad = [];
  for (const d of radicle || []) {
    const key = keyOf(d.dimension_id, d.dimension_name);
    const fp = await footprint(key, d.dimension_name);
    const mine = savesByKey.get(key) || [];
    const last = maxIso(d.newest_push, fp.last_local_at);
    if (isHidden(hidden, d.dimension_name, last)) continue;
    outRad.push({ ...d, on_radicle: true, saved_locally: mine.length > 0, local_bytes: fp.bytes, local_parts: fp.parts, last_active: last,
      old: oldAt(last) && !running(d.dimension_name), hexes: Math.max(Number(d.hexes) || 0, ...mine.map(s => s.hexes || 0)),
      turn_max: Math.max(Number(d.turn_max ?? d.turn) || 0, ...mine.map(s => s.turn || 0)) });
  }
  const outSaves = [];
  for (const s of saves) {
    const key = keyOf(s.dim_id, s.dim_name);
    const fp = await footprint(key, s.dim_name);
    const rad = radByKey.get(key);
    const last = maxIso(fp.last_local_at, s.saved_at, rad?.newest_push);
    if (isHidden(hidden, s.dim_name, last)) continue;
    outSaves.push({ ...s, on_radicle: radicle ? !!rad : null, local_bytes: fp.bytes, local_parts: fp.parts, last_active: last,
      old: oldAt(last) && !running(s.dim_name) });
  }
  return { radicle: radicle ? outRad : null, saves: outSaves };
}

// ---- delete -----------------------------------------------------------------------------------
const httpError = (status, message) => Object.assign(new Error(message), { status });

// Validates a POST /api/dimensions/delete body and decides what may go. Throws { status } errors:
// 400 bad name / id, 404 unknown here, 409 running or used within OLD_AFTER_MS.
// → { name, dimId, saveDirs: [abs], tapeDir: abs|null, onRadicle, lastActive }
export async function planDelete(body, { radicle = [], saves = [], branches = null, dimensionsDir = DIMENSIONS_DIR, sessionsDir = SESSIONS_DIR,
  running = () => false, now = Date.now() } = {}) {
  const givenId = body?.dimId != null ? String(body.dimId) : '';
  const givenName = body?.dimensionName != null ? String(body.dimensionName) : '';
  if (!givenId && !givenName) throw httpError(400, 'dimensionName or dimId is required');
  if (givenId && !DIM_ID_RE.test(givenId)) throw httpError(400, `bad dimension id ${JSON.stringify(givenId.slice(0, 60))}`);
  if (givenName && !safeDimName(givenName)) throw httpError(400, `bad dimension name ${JSON.stringify(givenName.slice(0, 60))}`);
  const rad = (radicle || []).find(d => (givenName && d.dimension_name === givenName) || (givenId && d.dimension_id === givenId)) || null;
  const name = givenName || rad?.dimension_name || saves.find(s => s.dim_id === givenId)?.dim_name || '';
  const dimId = givenId || rad?.dimension_id || saves.find(s => s.dim_name === name)?.dim_id || dimIdForName(name);
  const mine = saves.filter(s => (dimId && s.dim_id === dimId) || (name && s.dim_name === name));
  const branch = name ? branches?.get(name) || null : null;
  const tapeDir = safeDimName(name) ? childPath(sessionsDir, name) : null;
  const tape = tapeDir ? await pathStats(tapeDir) : { exists: false };
  if (!rad && !mine.length && !branch && !tape.exists) throw httpError(404, `no dimension ${JSON.stringify(name || dimId)} on this device`);
  const saveDirs = [];
  for (const s of mine) {
    const dir = s.dir || path.basename(path.dirname(s.path || ''));
    const p = DIM_ID_RE.test(dir) ? childPath(dimensionsDir, dir) : null;
    if (!p) throw httpError(400, `save ${JSON.stringify(dir)} is not inside ${dimensionsDir}`);
    if (!saveDirs.includes(p)) saveDirs.push(p);
  }
  if (name && running(name)) throw httpError(409, `${name} is running on this device — stop it first`);
  const fp = await localFootprint({ name, saves: mine, branch, dimensionsDir, sessionsDir });
  const lastActive = maxIso(rad?.newest_push, fp.last_local_at);
  if (lastActive && now - Date.parse(lastActive) <= OLD_AFTER_MS) {
    const h = Math.max(0, Math.floor((now - Date.parse(lastActive)) / 3600_000));
    throw httpError(409, `${name || dimId} was used ${h} h ago — only dimensions unused for ${Math.round(OLD_AFTER_MS / 3600_000)} h can be deleted`);
  }
  return { name, dimId, saveDirs, tapeDir: tape.exists ? tapeDir : null, onRadicle: !!rad, lastActive, bytes: fp.bytes };
}

// Removes the planned local dirs (re-checked to be inside their bases). → { removed: [abs], freed_bytes }
export async function removeLocalDirs(plan, { dimensionsDir = DIMENSIONS_DIR, sessionsDir = SESSIONS_DIR } = {}) {
  const removed = []; let freed = 0;
  const targets = [...plan.saveDirs.map(p => [dimensionsDir, p]), ...(plan.tapeDir ? [[sessionsDir, plan.tapeDir]] : [])];
  for (const [base, p] of targets) {
    if (childPath(base, path.basename(p)) !== path.resolve(p)) continue;
    const st = await pathStats(p);
    if (!st.exists) continue;
    await fs.rm(p, { recursive: true, force: true });
    removed.push(p); freed += st.bytes;
  }
  return { removed, freed_bytes: freed };
}
