#!/usr/bin/env node
// Apply JsonLogic blocks to data/<collection>.json.
//
//   node tools/logic-apply.mjs tools/logic/effects.logic.json [--dry-run] [--replace]
//
// The mapping file:
//   { "collection": "effects",
//     "entries": { "<entry id>": { "description": "...", "prerequisites": [...], "effects": [...], "validation": [...] }, ... } }
//
// For every entry id the block lands as `logic` on the entry's ACTIVE version
// (highest weight, non-rejected), placed right after `data` so the file reads
// data → logic. Existing blocks are kept unless --replace. Every block is
// expanded through the engine first: an unknown named rule or parameter aborts
// the whole run, so a half-applied file never happens. Prints what changed and
// re-serialises with 2-space indentation like the rest of data/.
import fs from 'node:fs';
import path from 'node:path';
import { LogicEngine, DATA_DIR, activeVersion, writeDataFile, authoredElsewhere } from '../logic-engine.mjs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: node tools/logic-apply.mjs <mapping.json> [--dry-run] [--replace]'); process.exit(2); }
const dryRun = args.includes('--dry-run'), replace = args.includes('--replace');

const map = JSON.parse(fs.readFileSync(file, 'utf8'));
const collection = map.collection;
if (!collection || !map.entries) { console.error('mapping needs { collection, entries }'); process.exit(2); }
const eng = new LogicEngine();
// Effect isolation F9: a collection read from definitions (index.json `definitions`) has no data file to write — its
// logic blocks live in the definitions' card blocks (authored in their own repo). Skipped, not an error (apply-all.sh).
if (authoredElsewhere(eng.index, collection)) { console.log(`${collection}: skipped — read from ${authoredElsewhere(eng.index, collection)} (card.logic); edit the definitions instead`); process.exit(0); }
const dataPath = path.join(DATA_DIR, `${collection}.json`);
const json = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const byId = new Map((json.entries || []).map(e => [e.id, e]));

// 1. validate every block before touching anything
let problems = 0;
for (const [id, block] of Object.entries(map.entries)) {
  if (!byId.has(id)) { console.log(`  ?? ${id}: no such entry in ${collection}`); problems++; continue; }
  if (!block || typeof block !== 'object') { console.log(`  ?? ${id}: block is not an object`); problems++; continue; }
  for (const k of Object.keys(block)) if (!['description', 'prerequisites', 'effects', 'validation', 'references', 'notes'].includes(k)) { console.log(`  ?? ${id}: unknown logic key ${k}`); problems++; }
  for (const k of ['prerequisites', 'effects', 'validation']) {
    for (const item of block[k] || []) {
      const body = item.when ?? item.value ?? item.assert;
      if (!item.id) { console.log(`  ?? ${id}.${k}: item without id`); problems++; }
      if (body === undefined) { console.log(`  ?? ${id}.${k}[${item.id}]: no when/value/assert`); problems++; continue; }
      try { eng.expand(body); } catch (e) { console.log(`  ?? ${id}.${k}[${item.id}]: ${e.message}`); problems++; }
    }
  }
}
if (problems) { console.error(`${problems} problem(s) — nothing written`); process.exit(1); }

// 2. apply
// 2026-11-14: a block identical to what is already there counts as `unchanged`, and a run that changes nothing
// does not rewrite the file — so `--replace` over every mapping is a byte-for-byte no-op on data in sync
// (tools/logic/*.logic.json is the single source of truth for every `logic` key; see tools/logic/README.md).
let added = 0, replaced = 0, kept = 0, unchanged = 0;
for (const [id, block] of Object.entries(map.entries)) {
  const entry = byId.get(id);
  const v = activeVersion(entry);
  if (!v) continue;
  if (v.logic && !replace) { kept++; continue; }
  // references: the named rules the block uses (for lint / docs)
  const refs = new Set();
  for (const k of ['prerequisites', 'effects', 'validation']) for (const item of block[k] || []) eng.references(item.when ?? item.value ?? item.assert, refs);
  const logic = { ...block, references: [...refs].sort() };
  const keys = Object.keys(v), at = keys.indexOf('logic');
  if (v.logic && JSON.stringify(v.logic) === JSON.stringify(logic) && at === keys.indexOf('data') + 1) { unchanged++; continue; }
  if (v.logic) { replaced++; console.log(`  ~ ${id}@${v.version}`); } else { added++; console.log(`  + ${id}@${v.version}`); }
  // rebuild the version so `logic` follows `data`
  const out = {};
  for (const k of Object.keys(v)) { if (k === 'logic') continue; out[k] = v[k]; if (k === 'data') out.logic = logic; }
  if (!('logic' in out)) out.logic = logic;
  entry.versions[entry.versions.indexOf(v)] = out;
}
console.log(`${collection}: ${added} added, ${replaced} replaced, ${unchanged} unchanged, ${kept} kept (use --replace to overwrite)${dryRun ? ' [dry-run]' : ''}`);
// Compact writer (2026-10-30): one JsonLogic rule per line, opening brackets on the key's line (logic-engine compactJson).
if (!dryRun && (added || replaced)) writeDataFile(dataPath, json);
