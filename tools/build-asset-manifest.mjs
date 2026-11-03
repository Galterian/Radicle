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
//   { generated, total_bytes, count, entries: [{path, size}] }
//
// Run:  node tools/build-asset-manifest.mjs
//       (regenerate before each mobile release)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

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

const scanTargets = [...dataJsons, ...ASSET_CONFIG_JSONS];
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
  return fs.existsSync(path.join(repoRoot, pngTwin)) ? pngTwin : p;
});
all = [...new Set(all)].sort();

const entries = [];
let totalBytes = 0;
let missing = 0;
for (const rel of all) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) {
    missing++;
    entries.push({ path: rel, size: 0, missing: true });
    continue;
  }
  const sz = fs.statSync(abs).size;
  totalBytes += sz;
  entries.push({ path: rel, size: sz });
}

const manifest = {
  generated: new Date().toISOString(),
  total_bytes: totalBytes,
  count: entries.length,
  missing,
  entries,
};

const outPath = path.join(repoRoot, 'godot', 'assets_manifest.json');
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));

console.log(`wrote ${path.relative(repoRoot, outPath)}`);
console.log(`  files:  ${entries.length}`);
console.log(`  total:  ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
if (missing) console.log(`  missing: ${missing} (listed in manifest with missing:true)`);
