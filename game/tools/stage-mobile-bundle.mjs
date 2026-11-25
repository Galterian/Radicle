#!/usr/bin/env node
// Stage the phone's Node bundle: copy the CURRENT game sources into the nodejs-mobile plugin's assets/nodejs-project,
// which is what every APK ships. Run before each APK build (_tools/build_and_deploy.sh does it).
// Why (2026-11-19): APKs 0.79–0.83 were rebuilt around a bundle staged on 11-16, so the phone missed three days of
// game code (join clock fix, Possess, Awake, …) while the version number looked current.
//
// What is copied:
//   - every top-level *.mjs, js/*.js, css/*.css, index.html
//   - the import closure of those files (static `from './x'` and `import('./x')`), e.g. tools/autosave.mjs and the
//     tools/*rebalancing-check.mjs validators the handshakes load at runtime, plus JSON files they read beside them
//   - effects-data/, skills-data/, classes-data/ (data programs, hooks, libs), replaced wholesale
//   - the building catalogues (js/catalog/) and the rulebook data/*.json (NOT data/dimensions — the bundle's own)
//   - the rules editor: repo-root editor.html + editor/*.js|css → the bundle root (served at /rules/ by the menu)
// Then it checks that every relative import inside the staged bundle resolves, and that each copy is byte-identical.
//
//   node tools/stage-mobile-bundle.mjs            # stage
//   node tools/stage-mobile-bundle.mjs --check    # only report what is stale / missing, change nothing
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const GAME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(GAME, '..');
const DEST = path.join(ROOT, 'godot/android/plugins/nodejs_mobile/src/main/assets/nodejs-project');
const CHECK_ONLY = process.argv.includes('--check');
const DATA_DIRS = ['effects-data', 'skills-data', 'classes-data'];

const ls = (dir, re) => fs.existsSync(path.join(GAME, dir))
  ? fs.readdirSync(path.join(GAME, dir)).filter(f => re.test(f)).map(f => path.posix.join(dir, f)) : [];
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const JSON_NEAR_RE = /['"`]([A-Za-z0-9_.-]+\.json)['"`]/g;
// Usage examples in header comments ("import … from './tools/x.mjs'") are not imports.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([;{}),])\s*\/\/.*$/gm, '$1');

// The roots, then their relative-import closure (JSON names a tools/ module mentions are taken when they sit beside it).
const roots = [...ls('.', /\.mjs$/), ...ls('js', /\.js$/), ...ls('css', /\.css$/), 'index.html'].map(f => f.replace(/^\.\//, ''));
const files = new Set();
const missing = [];
const queue = [...roots];
while (queue.length) {
  const rel = queue.shift();
  if (files.has(rel)) continue;
  if (!fs.existsSync(path.join(GAME, rel))) { missing.push(rel); continue; }
  files.add(rel);
  if (!/\.(mjs|js)$/.test(rel)) continue;
  const src = stripComments(fs.readFileSync(path.join(GAME, rel), 'utf8'));
  for (const m of src.matchAll(IMPORT_RE)) {
    const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
    if (!dep.startsWith('..') && !dep.startsWith('node_modules/') && !dep.startsWith('tools/out/')) queue.push(dep);
  }
  if (rel.startsWith('tools/')) for (const m of src.matchAll(JSON_NEAR_RE)) {
    const j = path.posix.join('tools', m[1]);
    if (fs.existsSync(path.join(GAME, j))) files.add(j);
  }
}
if (missing.length) { console.error(`[stage] imports that do not exist in game/: ${missing.join(', ')}`); process.exit(1); }

const copies = [...files].map(rel => [path.join(GAME, rel), path.join(DEST, rel)]);
for (const d of DATA_DIRS) {
  const walk = (dir) => fs.readdirSync(path.join(GAME, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.posix.join(dir, e.name)) : [path.posix.join(dir, e.name)]);
  for (const rel of walk(d)) copies.push([path.join(GAME, rel), path.join(DEST, rel)]);
}
copies.push([path.join(ROOT, 'assets/features/feature_table.json'), path.join(DEST, 'js/catalog/feature_table.json')]);
copies.push([path.join(ROOT, 'assets/terrain_bigfeatures/bigfeature_table.json'), path.join(DEST, 'js/catalog/bigfeature_table.json')]);
for (const f of fs.readdirSync(path.join(ROOT, 'data')).filter(f => f.endsWith('.json'))) copies.push([path.join(ROOT, 'data', f), path.join(DEST, 'data', f)]);
// The compiled GameModels catalog (monsters / NPCs / buildings / villages; data/creatures.json is gone since 2026-11-25):
// at assets/ beside the bundle's data/, where defs-collection resolveCatalogFile looks first.
copies.push([path.join(ROOT, 'assets/gamemodels/catalog.json'), path.join(DEST, 'assets/gamemodels/catalog.json')]);
// Rules editor (2026-11-22): mobile-menu.mjs serves /rules/ from the repo-root editor.html + editor/ — on the phone
// editor-api.mjs finds them beside the game code, so they land at the bundle root.
if (fs.existsSync(path.join(ROOT, 'editor.html'))) {
  copies.push([path.join(ROOT, 'editor.html'), path.join(DEST, 'editor.html')]);
  for (const f of fs.readdirSync(path.join(ROOT, 'editor')).filter(f => /\.(js|css)$/.test(f))) copies.push([path.join(ROOT, 'editor', f), path.join(DEST, 'editor', f)]);
}

const same = (a, b) => fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
const stale = copies.filter(([a, b]) => !same(a, b));
if (CHECK_ONLY) {
  console.log(`[stage] ${stale.length} of ${copies.length} bundle files are stale or missing`);
  for (const [, b] of stale.slice(0, 20)) console.log(`  ${path.relative(DEST, b)}`);
  process.exit(stale.length ? 1 : 0);
}

for (const d of [...DATA_DIRS, 'editor']) fs.rmSync(path.join(DEST, d), { recursive: true, force: true });   // drop deleted defs / editor modules too
for (const [a, b] of copies) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b); }

// Verify: byte-identical copies, and every relative import inside the staged bundle resolves.
const bad = copies.filter(([a, b]) => !same(a, b)).map(([, b]) => path.relative(DEST, b));
const unresolved = [];
// npm packages, in Node modules only (browser js/*.js has UI strings like `from ' + x`).
const BARE_RE = /(?:^\s*import\s[^'"]*?\bfrom\s*|\bimport\s*\(\s*)['"]((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)(?:\/[a-z0-9._/-]*)?['"]/gm;
for (const rel of files) {
  if (!/\.(mjs|js)$/.test(rel)) continue;
  const src = stripComments(fs.readFileSync(path.join(DEST, rel), 'utf8'));
  for (const m of src.matchAll(IMPORT_RE)) {
    const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
    if (!dep.startsWith('..') && !fs.existsSync(path.join(DEST, dep))) unresolved.push(`${rel} → ${m[1]}`);
  }
  // npm deps come from the bundle's own node_modules (installed separately) — a new package needs an npm install there.
  if (rel.endsWith('.mjs')) for (const m of src.matchAll(BARE_RE)) {
    if (!m[1].startsWith('node:') && !builtinModules.includes(m[1]) && !fs.existsSync(path.join(DEST, 'node_modules', m[1]))) unresolved.push(`${rel} → npm '${m[1]}' (not in the bundle's node_modules)`);
  }
}
if (bad.length || unresolved.length) {
  if (bad.length) console.error(`[stage] copy mismatch: ${bad.join(', ')}`);
  if (unresolved.length) console.error(`[stage] unresolved imports in the bundle:\n  ${unresolved.join('\n  ')}`);
  process.exit(1);
}
console.log(`[stage] staged ${files.size} game files, ${copies.length - files.size} data/catalogue files (${stale.length} changed) → ${path.relative(ROOT, DEST)}`);
