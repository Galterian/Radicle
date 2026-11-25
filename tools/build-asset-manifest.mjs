#!/usr/bin/env node
// Build godot/assets_manifest.json — the list of files the Android client
// downloads from Radicle on first launch.
//
// Strategy: start from the small "entry" JSONs the client needs no matter
// what (data/*.json + a handful of asset-config JSONs under assets/). Scan
// each one for literal "assets/..." path strings (png/bmp/wav/json). Union
// those with the entry files themselves. One-level, no recursion into the
// matched JSONs — asset_index.json and frames.json are huge indexes and if
// we recursed into them we'd pull the whole 810 MB tree.
//
// Output: godot/assets_manifest.json
//   { generated, total_bytes, count, entries: [{path, size, src}] }
//   src = "resources" for media (png/bmp/wav/...; they may live in chaosD6-Resources), "code" for the JSONs.
//   AssetBootstrap.gd (radicle mode) fetches "resources" entries from RESOURCES_RID, the rest from PROJECT_RID.
//
// Run:  node tools/build-asset-manifest.mjs                      # media from game/asset-root.mjs (env / default)
//       node tools/build-asset-manifest.mjs --resources <repo>   # media from <repo>/assets (chaosD6-Resources)
//       ... --out <file>                                         # write somewhere else (compare before replacing)
//       (regenerate before each mobile release)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_ROOT, isMedia } from '../game/asset-root.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const resArg = process.argv.indexOf('--resources');
const mediaRoot = resArg > 0 ? path.resolve(process.argv[resArg + 1] || '.', 'assets') : MEDIA_ROOT;
if (!fs.existsSync(mediaRoot)) { console.error(`media root not found: ${mediaRoot}`); process.exit(1); }
// Repo-relative manifest path -> file on disk: media under the media root, everything else in this repo.
const srcOf = (rel) => (rel.startsWith('assets/') && isMedia(rel) ? 'resources' : 'code');
const fileOf = (rel) => (srcOf(rel) === 'resources' ? path.join(mediaRoot, rel.slice('assets/'.length)) : path.join(repoRoot, rel));

const ASSET_CONFIG_JSONS = [
  'assets/terrain/terrain_tiles.json',
  'assets/terrain/terrain_transitions.json',
  'assets/terrain_bigfeatures/bigfeature_table.json',
  'assets/terrain_scatter/scatter_table.json',
  'assets/features/feature_table.json',
];

// Big index files SheetAnimator consults at runtime. Bundle them, don't scan.
const BIG_INDEXES = [
  'assets/frames.json',
  'assets/asset_index.json',
];

const dataDir = path.join(repoRoot, 'data');
const dataJsons = fs.readdirSync(dataDir)
  .filter(f => f.endsWith('.json'))
  .map(f => `data/${f}`);

// Effect isolation F9 (2026-11-22): a collection whose data/index.json entry names `definitions` (effects, skills) has
// no data file — DataLoader.gd builds it from those definition files' card blocks, so ship them (and scan their sprites).
const dataIndex = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
const defJsons = (dataIndex.collections || []).filter(c => c.definitions).flatMap(c => {
  const dir = path.join(repoRoot, c.definitions);
  if (!fs.existsSync(dir)) { console.warn(`[warn] missing definitions dir: ${c.definitions}`); return []; }
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => `${c.definitions}/${f}`);
});

// Split A (2026-11-25): a collection whose entry names `catalog` (creatures) has no data file either — it is the compiled
// chaosD6-GameModels catalog (monsters, NPCs, buildings, villages …): ship it and scan the sprites / sounds of every kind.
const catalogJsons = [...new Set((dataIndex.collections || []).filter(c => c.catalog).map(c => `assets/${c.catalog}`))];

const scanTargets = [...dataJsons, ...defJsons, ...catalogJsons, ...ASSET_CONFIG_JSONS];
const alwaysInclude = new Set([...scanTargets, ...BIG_INDEXES]);

const PATH_RE = /"(assets\/[^"\n\r]+?\.(?:png|bmp|wav|json|ogg|mp3))"/g;

const referenced = new Set();
for (const rel of scanTargets) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) {
    console.warn(`[warn] missing scan target: ${rel}`);
    continue;
  }
  const txt = fs.readFileSync(abs, 'utf8');
  for (const m of txt.matchAll(PATH_RE)) {
    referenced.add(m[1]);
  }
}

let all = [...new Set([...alwaysInclude, ...referenced])];

// Where a .bmp is referenced but a .png twin exists on disk, substitute png.
// The data JSONs reference portraits as .bmp but every portrait has a png
// twin that is ~10x smaller.
all = all.map(p => {
  if (!p.endsWith('.bmp')) return p;
  const pngTwin = p.slice(0, -4) + '.png';
  return fs.existsSync(fileOf(pngTwin)) ? pngTwin : p;
});
all = [...new Set(all)].sort();

const entries = [];
let totalBytes = 0;
let missing = 0;
for (const rel of all) {
  const abs = fileOf(rel);
  if (!fs.existsSync(abs)) {
    missing++;
    entries.push({ path: rel, size: 0, src: srcOf(rel), missing: true });
    continue;
  }
  const sz = fs.statSync(abs).size;
  totalBytes += sz;
  entries.push({ path: rel, size: sz, src: srcOf(rel) });
}

const manifest = {
  generated: new Date().toISOString(),
  total_bytes: totalBytes,
  count: entries.length,
  missing,
  entries,
};

const outArg = process.argv.indexOf('--out');   // --out <file>: write elsewhere (dry comparison)
const outPath = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(repoRoot, 'godot', 'assets_manifest.json');
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));

console.log(`wrote ${path.relative(repoRoot, outPath)}`);
console.log(`  media:  ${mediaRoot}`);
console.log(`  files:  ${entries.length}`);
console.log(`  total:  ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
if (missing) console.log(`  missing: ${missing} (listed in manifest with missing:true)`);
