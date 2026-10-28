#!/usr/bin/env node
// Port `resources` blocks from the Phase-2 Windows checkout into this repo's
// data/*.json files, matched by entry id. Does not touch `versions` or any
// other field — only inserts `resources` between `tags` and `versions` if the
// local entry doesn't already have one.
//
//   node tools/port_resources.mjs [--dry-run]
//
// Reports a per-file summary. Pretty-prints with 2 spaces to match the repo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SRC  = '/mnt/c/Users/grozdevg/Downloads/XCR Explorer/XCR Explorer/chaos_mapper/chaosD6';
const FILES = ['actions', 'characters', 'classes', 'creatures', 'effects', 'elements', 'terrain_items'];
const dryRun = process.argv.includes('--dry-run');

// Rebuild the entry object so `resources` lands between `tags` and `versions`.
function withResources(entry, resources) {
  const out = {};
  for (const k of Object.keys(entry)) {
    if (k === 'versions') out.resources = resources;
    out[k] = entry[k];
  }
  if (!('versions' in entry)) out.resources = resources;   // defensive
  return out;
}

for (const name of FILES) {
  const mineP = path.join(REPO, 'data', `${name}.json`);
  const srcP  = path.join(SRC,  'data', `${name}.json`);
  const mine  = JSON.parse(fs.readFileSync(mineP, 'utf8'));
  const src   = JSON.parse(fs.readFileSync(srcP,  'utf8'));
  const srcById = new Map((src.entries || []).map(e => [e.id, e]));
  let added = 0, skipped = 0, missing = 0, kept = 0;
  const newEntries = (mine.entries || []).map(e => {
    if (e.resources) { kept++; return e; }
    const s = srcById.get(e.id);
    if (!s || !s.resources) { missing++; return e; }
    added++;
    return withResources(e, s.resources);
  });
  console.log(`${name.padEnd(16)}  added=${added}  kept=${kept}  no-source=${missing}  total=${newEntries.length}`);
  if (!dryRun && added > 0) {
    mine.entries = newEntries;
    fs.writeFileSync(mineP, JSON.stringify(mine, null, 2) + '\n');
  }
}
