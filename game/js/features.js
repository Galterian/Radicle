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

// Returns {path, label, kind, biome, id} or null. `seedHex` is the dim seed
// used by biome.js (`state.map.seed`). If a biome function isn't passed, we
// derive it from biomeFor(seedHex).
export function featureAt(seedHex, q, r, biomeAt = null) {
  if (!catalog) return null;
  if (_consumed.has(`${q},${r}`)) return null;
  const bAt = biomeAt || biomeFor(seedHex).biomeAt;
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
  return { path: c.path, label: c.label, kind: c.kind || 'building', biome: bt, id: c.id || c.label };
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
