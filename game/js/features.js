// Deterministic feature (building / permanent) placer — mirror of
// godot/scripts/Features.gd. Same (dim_seed, q, r, biome) must yield the same
// feature in both runtimes so a dimension renders identically whichever
// client drew it.
//
// Pipeline per hex, lifted straight from Features.gd:
//   1. biomeAt(q, r) resolves the biome string.
//   2. If no catalog entries exist for that biome → no feature.
//   3. _roll01("f", q, r) < density[biome] → "passes density"; else skip.
//   4. Nearest-wins Poisson spacing: among all hexes within `min_separation`
//      that also pass the density check, the lowest "f" hash wins; ties
//      broken on (q, r). Loses → no feature.
//   5. Choose the catalog entry by max of `_roll01("p<i>", q, r) * weight` —
//      produces much better spatial variety than hash%N.
//
// The catalog comes from /assets/features/feature_table.json (loaded over
// fetch, cached once). Until the fetch resolves `featureAt` returns null and
// listeners are notified when the catalog arrives so the renderer can repaint.
import { hash32 } from './map.js';
import { biomeFor } from './biome.js';

// ---------------------------------------------------------------------------
// Labyrinth walls (user ruling 2026-10-30; long connected runs 2026-11-12).
// A sparse pass stamps "wall seed hexes" on open ground; from each seed a wall
// WALKS 6–12 hexes, bending at most one direction per step (never doubling
// back), and half of them grow a 2–3 hex side branch — L / T shaped ramparts
// that pathfinding has to route around. A run stops (it never skips a hex, so
// every wall stays connected) at ground that isn't open, or near the spawn
// disc around (0, 0). PURE function of (seed, q, r): every wall hex of every
// seed whose anchor lies in a 16×16 chunk is computed once per seed and cached,
// so node (resolver) and browser agree hex for hex. Features.gd mirrors it.
//
// Hex 6-neighbour order 0=E, 1=NE, 2=NW, 3=W, 4=SW, 5=SE (flat-top, hex.js DIRS).
const LAB_SEED_RATE = 1 / 350;
const LAB_MIN_LEN = 6, LAB_MAX_LEN = 12;
const LAB_BRANCH_RATE = 0.5;
const LAB_CHUNK = 16;                       // > the furthest a wall reaches from its anchor
const LAB_SPAWN_CLEAR = 2;                  // hexes around (0, 0) never walled
const LAB_BIOMES = new Set(['grass', 'high_grass', 'dirt', 'high_dirt']);
const LAB_DIRS = [[+1, 0], [+1, -1], [0, -1], [-1, 0], [-1, +1], [0, +1]];
const LAB_TURNS = [-1, 0, 0, +1];
// WBC3 wall sprites reused verbatim from feature_table.json (`kind: "wall"`).
// Picked deterministically per wall hex so the run isn't a repeating texture.
const LAB_WALL_PATHS = [
  'assets/Sprites/Buildings/Shared/Walls (neutral, 2x2 joint)/Walls (neutral, 2x2 joint) - base [BWN0].png',
  'assets/Sprites/Buildings/Shared/Walls (neutral, 2x1 horizontal)/Walls (neutral, 2x1 horizontal) - base [BWN1].png',
  'assets/Sprites/Buildings/Shared/Walls (neutral, 1x2 vertical)/Walls (neutral, 1x2 vertical) - base [BWN2].png',
];
const LAB_DESC = 'Impassable wall — the fallen rampart of a long-abandoned keep. Units must path around it.';
const labDist0 = (q, r) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;

// The hexes one seed's wall covers, in walk order (index 0 = the seed).
function labWallRun(seed, sq, sr, bAt) {
  const open = (q, r) => LAB_BIOMES.has(bAt(q, r)) && labDist0(q, r) > LAB_SPAWN_CLEAR;
  if (!open(sq, sr)) return [];
  const len = LAB_MIN_LEN + Math.floor(roll01(seed, sq, sr, 'lw:len') * (LAB_MAX_LEN - LAB_MIN_LEN + 1));
  let d = Math.floor(roll01(seed, sq, sr, 'lw:orient') * 6) % 6;
  const run = [[sq, sr]];
  const seen = new Set([`${sq},${sr}`]);
  let q = sq, r = sr;
  for (let k = 1; k < len; k++) {
    d = (d + LAB_TURNS[Math.floor(roll01(seed, sq, sr, `lw:turn${k}`) * 4) % 4] + 6) % 6;
    const nq = q + LAB_DIRS[d][0], nr = r + LAB_DIRS[d][1];
    if (!open(nq, nr) || seen.has(`${nq},${nr}`)) break;
    run.push([nq, nr]); seen.add(`${nq},${nr}`); q = nq; r = nr;
  }
  // Side branch off the middle of the run, square to the way it was heading.
  if (run.length >= 4 && roll01(seed, sq, sr, 'lw:branch') < LAB_BRANCH_RATE) {
    const [mq, mr] = run[Math.floor(run.length / 2)];
    const bd = (d + (roll01(seed, sq, sr, 'lw:bside') < 0.5 ? 2 : 4)) % 6;
    const blen = 2 + Math.floor(roll01(seed, sq, sr, 'lw:blen') * 2);
    let bq = mq, br = mr;
    for (let k = 0; k < blen; k++) {
      const nq = bq + LAB_DIRS[bd][0], nr = br + LAB_DIRS[bd][1];
      if (!open(nq, nr) || seen.has(`${nq},${nr}`)) break;
      run.push([nq, nr]); seen.add(`${nq},${nr}`); bq = nq; br = nr;
    }
  }
  return run;
}

// seed → { chunks: Set("cq,cr"), walls: Map("q,r" → {sq, sr, k}) }. Two runs
// crossing the same hex: the seed with the smaller (sr, sq) owns it, so the
// sprite / id never depend on which chunk happened to be computed first.
const _labCache = new Map();
function labChunk(seed, cq, cr, bAt) {
  let c = _labCache.get(seed);
  if (!c) { c = { chunks: new Set(), walls: new Map() }; _labCache.set(seed, c); if (_labCache.size > 8) _labCache.delete(_labCache.keys().next().value); }
  const ck = `${cq},${cr}`;
  if (c.chunks.has(ck)) return c;
  c.chunks.add(ck);
  for (let sq = cq * LAB_CHUNK; sq < (cq + 1) * LAB_CHUNK; sq++) {
    for (let sr = cr * LAB_CHUNK; sr < (cr + 1) * LAB_CHUNK; sr++) {
      if (roll01(seed, sq, sr, 'lw:seed') >= LAB_SEED_RATE) continue;
      const run = labWallRun(seed, sq, sr, bAt);
      run.forEach(([q, r], k) => {
        const key = `${q},${r}`;
        const cur = c.walls.get(key);
        if (!cur || sr < cur.sr || (sr === cur.sr && sq < cur.sq)) c.walls.set(key, { sq, sr, k });
      });
    }
  }
  return c;
}

// Returns {path, label, kind:"wall", desc, blocking:true, id, biome} if (q, r)
// is a labyrinth-wall hex for the given seed, else null. Pure.
export function labyrinthWallAt(seed, q, r, biomeAt = null) {
  const bAt = biomeAt || biomeFor(seed).biomeAt;
  // Anchors whose run can reach (q, r) lie within LAB_MAX_LEN + 3 < LAB_CHUNK
  // hexes, so the 3×3 chunks around (q, r)'s own chunk hold all of them.
  const cq = Math.floor(q / LAB_CHUNK), cr = Math.floor(r / LAB_CHUNK);
  let c = null;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) c = labChunk(seed, cq + i, cr + j, bAt);
  const w = c.walls.get(`${q},${r}`);
  return w ? _labWallFeature(seed, w.sq, w.sr, w.k, bAt(q, r)) : null;
}

function _labWallFeature(seed, sq, sr, k, biomeType) {
  const idx = hash32(`${seed}:lw:sprite:${sq}:${sr}:${k}`) % LAB_WALL_PATHS.length;
  return {
    path: LAB_WALL_PATHS[idx],
    label: 'Impassable Wall',
    kind: 'wall',
    desc: LAB_DESC,
    blocking: true,
    id: `labyrinth_wall/${sq},${sr}:${k}`,
    biome: biomeType,
  };
}

// Boolean predicate variant for pathfinding call sites that only need yes/no.
export function isLabyrinthWallAt(seed, q, r, biomeAt = null) {
  return !!labyrinthWallAt(seed, q, r, biomeAt);
}

let catalog = null;        // { by_biome, density, min_separation }
let loading = null;
const listeners = new Set();
export function onFeaturesChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }

// Client-local "stepped on, picked up" bookkeeping. featureAt early-returns
// null for a hex marked consumed so the renderer stops drawing the sprite and
// no further object cards surface for it. Deterministic parity with Godot is
// unaffected — the resolver never sees this set.
const _consumed = new Set();   // "q,r"
export function markFeatureConsumed(q, r) {
  _consumed.add(`${q},${r}`);
  notify();
}
export function isFeatureConsumed(q, r) { return _consumed.has(`${q},${r}`); }
export function clearConsumedFeatures() { _consumed.clear(); notify(); }

// Node (the resolver reads the catalogue from disk) and tests: inject it without fetch().
export function setFeatureCatalog(j) {
  catalog = j && typeof j === 'object' ? {
    by_biome: j.by_biome || {},
    density: j.density || {},
    min_separation: Number.isInteger(j.min_separation) ? j.min_separation : 2,
  } : null;
  _families = null;
  loading = Promise.resolve(catalog);
  notify();
}

export function loadFeatures() {
  if (!loading) {
    loading = fetch('/assets/features/feature_table.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(j => {
        catalog = j && typeof j === 'object' ? {
          by_biome: j.by_biome || {},
          density: j.density || {},
          min_separation: Number.isInteger(j.min_separation) ? j.min_separation : 2,
        } : null;
        _families = null;
        notify();
        return catalog;
      });
  }
  return loading;
}

// FNV-1a roll in [0, 1). Must match Features.gd's _roll01 — same salt order
// ("%s:%s:%d:%d" % [seed, salt, q, r]) and same divisor (2^32).
function roll01(seed, q, r, salt) {
  return hash32(`${seed}:${salt}:${q}:${r}`) / 4294967296;
}

function passesDensity(seed, q, r, biomeType) {
  const d = +(catalog.density[biomeType] || 0);
  if (d <= 0) return false;
  return roll01(seed, q, r, 'f') < d;
}

// Nearest-wins Poisson. Returns true if this hex's "f" hash is strictly the
// lowest among all candidate hexes within min_separation (tie-break on q, r).
function isCandidate(seed, q, r, biomeAt) {
  const bt = biomeAt(q, r);
  const choices = catalog.by_biome[bt];
  if (!choices || !choices.length) return false;
  if (!passesDensity(seed, q, r, bt)) return false;
  const my = roll01(seed, q, r, 'f');
  const R = catalog.min_separation | 0;
  for (let dq = -R; dq <= R; dq++) {
    const lo = Math.max(-R, -dq - R);
    const hi = Math.min(R, -dq + R);
    for (let dr = lo; dr <= hi; dr++) {
      if (dq === 0 && dr === 0) continue;
      const nq = q + dq, nr = r + dr;
      const nbt = biomeAt(nq, nr);
      const nChoices = catalog.by_biome[nbt];
      if (!nChoices || !nChoices.length) continue;
      if (!passesDensity(seed, nq, nr, nbt)) continue;
      const nh = roll01(seed, nq, nr, 'f');
      if (nh < my || (nh === my && (nr < r || (nr === r && nq < q)))) return false;
    }
  }
  return true;
}

// Building themes (user ruling 2026-11-12): a building's look follows what it does, so a map is not a row of
// White Towers. The hex rolls a power first (weights below), then a sprite of that family from the whole
// catalogue (any biome — the current biome's entries count double). Natural features (trees, groves,
// thorns, gravestones) keep their own pick. building-bonus.js reads `theme` as the power.
// NOTE: Features.gd (native Godot map) does not theme yet — the mobile app draws the map with this file.
export const BUILDING_THEMES = [
  ['skill',    16, /shrine|magic well|magic pool|totem|dragonstone|altar/i],
  ['mend',     12, /temple|cathedral|healer|healing orb|sacred pool|ziggurat/i],
  ['stance',   10, /^tower \(|goblin tower|dark tower|camp$/i],
  ['teleport',  9, /portal|archway|henge/i],
  ['explore',   9, /lookout|scout tower|watcher|scrying pool|white tower|forest tower/i],
  ['fortress',  9, /citadel|fortress|keep/i],
  ['walls',     8, /quarry|mine\b|mine \(|foundry|furnace/i],
  ['draw',      8, /shop|trader|supply depot|mill|barn|hovel|hatchery/i],
  ['dungeon',   8, /lair|cave/i],
  ['learn',     7, /library|guild/i],
  ['hurt',      4, /hall of plague|gallows|graveyard|tomb|barrow|^pit$/i],
];
const NATURAL = /\btree\b|tree of|grove|thorns|gravestone|faerie ring/i;
let _families = null;   // theme → [{ c, biome }], built once per catalogue
function familyOf(theme) {
  if (!_families) {
    _families = new Map(BUILDING_THEMES.map(([t]) => [t, []]));
    const seen = new Set();
    for (const [biome, list] of Object.entries(catalog.by_biome)) for (const c of list) {
      if ((c.kind || 'building') !== 'building' || c.blocking || NATURAL.test(c.label || '')) continue;
      const t = BUILDING_THEMES.find(([, , re]) => re.test(c.label || ''));
      if (!t) continue;
      const k = `${c.path}|${biome}`;
      if (seen.has(k)) continue;
      seen.add(k);
      _families.get(t[0]).push({ c, biome });
    }
  }
  return _families.get(theme) || [];
}
function themedBuilding(seedHex, q, r, bt) {
  const total = BUILDING_THEMES.reduce((a, [, w]) => a + w, 0);
  let u = mix32(hash32(`${seedHex}:theme:${q}:${r}`)) / 4294967296 * total;
  let theme = BUILDING_THEMES[0][0];
  for (const [t, w] of BUILDING_THEMES) { u -= w; if (u < 0) { theme = t; break; } }
  const fam = familyOf(theme);
  if (!fam.length) return null;
  const weights = fam.map(x => x.biome === bt ? 2 : 1);
  let v = mix32(hash32(`${seedHex}:look:${q}:${r}`)) / 4294967296 * weights.reduce((a, b) => a + b, 0);
  let pick = fam[fam.length - 1];
  for (let i = 0; i < fam.length; i++) { v -= weights[i]; if (v < 0) { pick = fam[i]; break; } }
  const c = pick.c;
  return { path: c.path, label: c.label, kind: 'building', biome: bt, id: c.id || c.label, desc: c.desc || '', theme };
}
const mix32 = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };

// Returns {path, label, kind, biome, id} or null. `seedHex` is the dim seed
// used by biome.js (`state.map.seed`). If a biome function isn't passed, we
// derive it from biomeFor(seedHex).
export function featureAt(seedHex, q, r, biomeAt = null) {
  // Buildings stay where they are (user ruling 2026-11-12): stepping on one
  // gives its bonus while you stand there, it is never picked up / consumed.
  const bAt = biomeAt || biomeFor(seedHex).biomeAt;
  // Labyrinth walls win over vanilla features — they're the user-visible
  // "unpassable scenery" pass and must stay on the hex even when a Poisson
  // feature candidate would also fire. Doesn't need the fetched catalog.
  const lw = labyrinthWallAt(seedHex, q, r, bAt);
  if (lw) return lw;
  if (!catalog) return null;
  if (!isCandidate(seedHex, q, r, bAt)) return null;
  const bt = bAt(q, r);
  const choices = catalog.by_biome[bt];
  if (!choices || !choices.length) return null;
  // Max-score picker: each entry gets its own hash scaled by weight. Matches
  // Features.gd exactly so Godot and browser pick identical entries.
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < choices.length; i++) {
    const w = +(choices[i].weight ?? 1);
    const s = roll01(seedHex, q, r, 'p' + i) * w;
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  }
  const c = choices[bestIdx];
  if ((c.kind || 'building') === 'building' && !c.blocking && !NATURAL.test(c.label || '')) {
    const t = themedBuilding(seedHex, q, r, bt);
    if (t) return t;
  }
  return { path: c.path, label: c.label, kind: c.kind || 'building', biome: bt, id: c.id || c.label, desc: c.desc || '' };
}

// ---------------------------------------------------------------------------
// Image cache for feature PNGs — same shape as sprites.js terrainTile(). The
// renderer calls featureImage(path) and gets {img, ready} back, or null while
// the browser is still fetching.
const _imgs = new Map();
export function featureImage(path) {
  if (!path) return null;
  let t = _imgs.get(path);
  if (!t) {
    t = { img: new Image(), ready: false, failed: false };
    // Store in the cache BEFORE assigning src: if the browser serves the PNG
    // from disk cache the onload handler can fire before this call returns,
    // and notify() → listener → featureImage(path) would otherwise re-enter
    // and build a second Image, orphaning the one that actually loaded.
    _imgs.set(path, t);
    const url = '/' + String(path).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    t.img.onload = () => { t.ready = true; notify(); };
    t.img.onerror = () => { t.failed = true; console.warn('[features] image failed to load:', url); };
    t.img.src = url;
  }
  return t.ready ? t : null;
}

export function featuresReady() { return catalog != null; }
