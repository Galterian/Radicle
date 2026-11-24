#!/usr/bin/env node
// Check the chaosD6-GameModels repo's definitions and compile them into assets/gamemodels/catalog.json (the map,
// renderer and peers read that one file). `--check`: fail when the catalog on disk is stale instead of writing it.
// The repo is found by gamemodels.mjs resolveGameModelsDir (env CHAOSD6_GAMEMODELS_REPO or a sibling checkout).
//   node tools/gamemodels-build.mjs [--check] [--dir /path/to/chaosd6-gamemodels-repo]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGameModels, checkGameModels, compileCatalog, knownIds, GAMEMODELS_DIR, CATALOG_REL } from '../gamemodels.mjs';
import { assetFile } from '../asset-root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DIR = opt('--dir', GAMEMODELS_DIR);
if (!DIR) { console.error(`gamemodels: no chaosD6-GameModels checkout found — clone it next to chaosD6 or set CHAOSD6_GAMEMODELS_REPO`); process.exit(1); }
const OUT = path.resolve(GAME, '..', 'assets', CATALOG_REL);

const m = loadGameModels(path.resolve(DIR));
const errors = checkGameModels(m, { known: knownIds(), assetFile });
if (errors.length) { console.error(`gamemodels: ${errors.length} problem(s)\n  ${errors.join('\n  ')}`); process.exit(1); }
const text = JSON.stringify(compileCatalog(m)) + '\n';
const counts = ['race', 'building', 'npc', 'monster', 'village', 'quest'].map(k => `${Object.keys(m[k]).length} ${k}s`).join(', ');
if (argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== text) { console.error(`gamemodels: ${path.relative(process.cwd(), OUT)} is stale — run node tools/gamemodels-build.mjs`); process.exit(1); }
  console.log(`gamemodels catalog up to date (${counts})`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`gamemodels: ${counts} → ${OUT} (${text.length} bytes)`);
}
