// Deterministic scatter (small decorative overlays — grass tufts, boulders,
// flowers, dead trees, snow pines, pebbles). Mirror of
// godot/scripts/Scatter.gd — same (dim_seed, q, r, biome) must yield the same
// scatter in both runtimes.
//
// Scatter differs from features: it's dense (20–45% of walkable hexes), has
// no spacing constraint, and never crowds a hex with more than one overlay.
// The goal is to break up uniform biome regions visually.
//
// Pipeline per hex (lifted from Scatter.gd):
//   1. biomeAt(q, r) resolves the biome string.
//   2. _roll01("d", q, r) < density[biome] → "passes density"; else skip.
//   3. From the pool of items whose `biomes` list contains the biome, pick
//      the one with the highest `_roll01("p<global_index>", q, r)` score.
//
// Salt scheme ("%s:s:%s:%d:%d" % [seed, salt, q, r]) adds a leading ":s"
// between seed and salt that features.js's scheme does not — matches
// Scatter.gd exactly so output is bit-for-bit identical.
import { hash32 } from './map.js';
import { biomeFor } from './biome.js';

let catalog = null;         // { items[], density{}, perBiome: biome -> int[] }
let loading = null;
const listeners = new Set();
export function onScatterChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }

export function loadScatter() {
  if (!loading) {
    loading = fetch('/assets/terrain_scatter/scatter_table.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(j => {
        if (!j || typeof j !== 'object') { catalog = null; notify(); return null; }
        const items = Array.isArray(j.items) ? j.items : [];
        const perBiome = {};
        for (let i = 0; i < items.length; i++) {
          const biomes = Array.isArray(items[i]?.biomes) ? items[i].biomes : [];
          for (const b of biomes) {
            if (!perBiome[b]) perBiome[b] = [];
            perBiome[b].push(i);
          }
        }
        catalog = { items, density: j.density || {}, perBiome };
        notify();
        return catalog;
      });
  }
  return loading;
}

// FNV-1a roll in [0, 1). Note the leading ":s" between seed and salt — matches
// Scatter.gd's `"%s:s:%s:%d:%d" % [seed_hex, salt, q, r]` layout.
function roll01(seed, q, r, salt) {
  return hash32(`${seed}:s:${salt}:${q}:${r}`) / 4294967296;
}

// Returns {path, label, id, family, biome, kind: 'scatter'} or null.
export function scatterAt(seedHex, q, r, biomeAt = null) {
  if (!catalog) return null;
  const bAt = biomeAt || biomeFor(seedHex).biomeAt;
  const bt = bAt(q, r);
  const d = +(catalog.density[bt] || 0);
  if (d <= 0) return null;
  if (roll01(seedHex, q, r, 'd') >= d) return null;
  const pool = catalog.perBiome[bt];
  if (!pool || !pool.length) return null;
  // Max-hash across pool indices. The salt uses the *global* item index into
  // catalog.items, not the pool position — Scatter.gd iterates `for i in pool`
  // where `i` is already the global index.
  let bestIdx = pool[0];
  let bestScore = -1;
  for (const i of pool) {
    const s = roll01(seedHex, q, r, 'p' + i);
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  }
  const it = catalog.items[bestIdx];
  return {
    path: it.path,
    label: it.label || '',
    id: it.id || '',
    family: it.family || '',
    biome: bt,
    kind: 'scatter',
  };
}

// ---------------------------------------------------------------------------
// Image cache for scatter PNGs. Same shape as features.featureImage.
const _imgs = new Map();
export function scatterImage(path) {
  if (!path) return null;
  let t = _imgs.get(path);
  if (!t) {
    t = { img: new Image(), ready: false, failed: false };
    t.img.onload = () => { t.ready = true; notify(); };
    t.img.onerror = () => { t.failed = true; };
    t.img.src = '/' + String(path).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    _imgs.set(path, t);
  }
  return t.ready ? t : null;
}

export function scatterReady() { return catalog != null; }
