// Deterministic placer for "big feature" landmarks — forest clumps, boulder
// piles, snow pines, palm stands, ruins — that visually span ~2 hex widths.
// Mirror of godot/scripts/BigFeature.gd: the same (dim_seed, q, r, biome) must
// yield the same landmark in both runtimes.
//
// Pipeline per hex (lifted from BigFeature.gd):
//   1. biomeAt(q, r) resolves the biome string; no catalog pool → nothing.
//   2. _roll01("f") < density[biome] * groveMult(q, r) → "passes density".
//      groveMult is a coarse value-noise field so trees gather into clumps.
//   3. Nearest-wins Poisson spacing within min_separation (per-biome override
//      in `min_separation_by_biome`; forests use 1 so canopies overlap).
//   4. Pick the pool entry with the highest _roll01("p<i>") * weight.
//
// Salt scheme is "%s:B:%s:%d:%d" % [seed, salt, q, r] — note the ":B" — so the
// rolls never collide with Features.gd (":") or Scatter.gd (":s").
import { hash32 } from './map.js';
import { biomeFor, valueNoise } from './biome.js';

export const GROVE_SCALE = 0.22;
export const GROVE_MIN = 0.15;
export const GROVE_MAX = 1.8;
export const GROVE_GAIN = 3.0;
export const GROVE_BIAS = 0.35;

let catalog = null;   // { by_biome, density, min_separation, min_separation_by_biome }
let loading = null;
const listeners = new Set();
export function onBigFeaturesChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }

export function loadBigFeatures() {
  if (!loading) {
    loading = fetch('/assets/terrain_bigfeatures/bigfeature_table.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(j => {
        catalog = j && typeof j === 'object' ? {
          by_biome: j.by_biome || {},
          density: j.density || {},
          min_separation: Number.isInteger(j.min_separation) ? j.min_separation : 6,
          min_separation_by_biome: j.min_separation_by_biome || {},
        } : null;
        notify();
        return catalog;
      });
  }
  return loading;
}

// Allow Node tests to inject the catalog without fetch().
export function setBigFeatureCatalog(j) {
  catalog = j ? {
    by_biome: j.by_biome || {},
    density: j.density || {},
    min_separation: Number.isInteger(j.min_separation) ? j.min_separation : 6,
    min_separation_by_biome: j.min_separation_by_biome || {},
  } : null;
  notify();
}

function roll01(seed, q, r, salt) {
  return hash32(`${seed}:B:${salt}:${q}:${r}`) / 4294967296;
}

function sepFor(bt) {
  const v = catalog.min_separation_by_biome[bt];
  return Number.isInteger(v) ? v : catalog.min_separation | 0;
}

function groveMult(seed, q, r) {
  const g = valueNoise(seed, q * GROVE_SCALE, r * GROVE_SCALE, 'g');
  return Math.min(GROVE_MAX, Math.max(GROVE_MIN, (g - GROVE_BIAS) * GROVE_GAIN));
}

function passesDensity(seed, q, r, bt) {
  const d = +(catalog.density[bt] || 0);
  if (d <= 0) return false;
  return roll01(seed, q, r, 'f') < d * groveMult(seed, q, r);
}

function isCandidate(seed, q, r, biomeAt) {
  const bt = biomeAt(q, r);
  const pool = catalog.by_biome[bt];
  if (!pool || !pool.length) return false;
  if (!passesDensity(seed, q, r, bt)) return false;
  const my = roll01(seed, q, r, 'f');
  const R = sepFor(bt);
  for (let dq = -R; dq <= R; dq++) {
    const lo = Math.max(-R, -dq - R);
    const hi = Math.min(R, -dq + R);
    for (let dr = lo; dr <= hi; dr++) {
      if (dq === 0 && dr === 0) continue;
      const nq = q + dq, nr = r + dr;
      const nbt = biomeAt(nq, nr);
      const nPool = catalog.by_biome[nbt];
      if (!nPool || !nPool.length) continue;
      if (!passesDensity(seed, nq, nr, nbt)) continue;
      const nh = roll01(seed, nq, nr, 'f');
      if (nh < my || (nh === my && (nr < r || (nr === r && nq < q)))) return false;
    }
  }
  return true;
}

// Returns {path, label, kind: 'big_feature', biome, id, native_w, native_h} or null.
export function bigFeatureAt(seedHex, q, r, biomeAt = null) {
  if (!catalog) return null;
  const bAt = biomeAt || biomeFor(seedHex).biomeAt;
  if (!isCandidate(seedHex, q, r, bAt)) return null;
  const bt = bAt(q, r);
  const pool = catalog.by_biome[bt];
  if (!pool || !pool.length) return null;
  let bestIdx = -1;
  let bestScore = -1;
  for (let i = 0; i < pool.length; i++) {
    const w = +(pool[i].weight ?? 1);
    const s = roll01(seedHex, q, r, 'p' + i) * w;
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  }
  if (bestIdx < 0) return null;
  const c = pool[bestIdx];
  return {
    path: c.path,
    label: c.label,
    kind: 'big_feature',
    biome: bt,
    id: c.id || c.label,
    native_w: c.native_w | 0,
    native_h: c.native_h | 0,
  };
}

// ---------------------------------------------------------------------------
// Image cache, same shape as features.featureImage / scatter.scatterImage.
const _imgs = new Map();
export function bigFeatureImage(path) {
  if (!path) return null;
  let t = _imgs.get(path);
  if (!t) {
    t = { img: new Image(), ready: false, failed: false };
    _imgs.set(path, t);
    const url = '/' + String(path).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    t.img.onload = () => { t.ready = true; notify(); };
    t.img.onerror = () => { t.failed = true; console.warn('[bigfeature] image failed to load:', url); };
    t.img.src = url;
  }
  return t.ready ? t : null;
}

export function bigFeaturesReady() { return catalog != null; }
