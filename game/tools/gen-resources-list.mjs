#!/usr/bin/env node
// The resource catalogue of the editor's "Generate from a description…" form (2026-11-23): every effect sprite strip and
// sound fx of chaosD6-Resources — also the ones the APK's asset pack does not carry (in_pack: false; the phone fetches
// them later) — so a player can pick the card's picture and sound. Read from the local Resources checkout's manifest.json
// (no network); written to game/gen-resources.json, which the phone bundle carries like any game file.
//   node tools/gen-resources-list.mjs [<manifest.json>]   (default: $CHAOSD6_RESOURCES_REPO or ~/chaosd6-resources-repo)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const repo = process.env.CHAOSD6_RESOURCES_REPO || path.join(os.homedir(), 'chaosd6-resources-repo');
const src = process.argv[2] || path.join(repo, 'manifest.json');
const man = JSON.parse(fs.readFileSync(src, 'utf8'));
let pack = new Set();
try { pack = new Set(JSON.parse(fs.readFileSync(path.join(GAME, '..', 'godot', 'assets_manifest.json'), 'utf8')).entries.map(e => e.path)); } catch {}
// the paths the rules editor / skill engine accept (skill-engine.mjs RESOURCE_PATH_RE)
const OK = /^assets\/(Sprites\/[A-Za-z0-9_ ()[\]./-]+\.png|Sounds\/[A-Za-z0-9_ ()[\]./-]+\.wav)$/i;
const nameOf = (p) => path.basename(p).replace(/\.(png|wav)$/i, '').replace(/ - idle/, '').replace(/\s+\[[A-Z0-9]+\]$/, '').trim();
const sprites = [], sounds = [];
for (const e of man.entries || []) {
  const p = e.path;
  if (!OK.test(p) || p.includes('..')) continue;
  if (/^assets\/Sprites\/(Effects|Misc)\/[^/]+\/.+\.png$/i.test(p)) sprites.push({ path: p, name: nameOf(p), in_pack: pack.has(p) });
  else if (/^assets\/Sounds\/SoundFX\/[^/]+\.wav$/i.test(p)) sounds.push({ path: p, name: nameOf(p), in_pack: pack.has(p) });
}
const by = (a, b) => a.name.localeCompare(b.name);
const out = { format: 1, source: 'chaosD6-Resources manifest.json', generated_at: new Date().toISOString(), sprites: sprites.sort(by), sounds: sounds.sort(by) };
const file = path.join(GAME, 'gen-resources.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`${path.relative(GAME, file)}: ${sprites.length} sprites (${sprites.filter(s => !s.in_pack).length} not in the APK pack), ${sounds.length} sounds (${sounds.filter(s => !s.in_pack).length} not in the pack)`);
