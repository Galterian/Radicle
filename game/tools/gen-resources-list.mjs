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
// the strip grid of a sprite (assets/frames.json: cols = frames) → the editor animates the preview
let frames = {};
try { frames = JSON.parse(fs.readFileSync(path.join(GAME, '..', 'assets', 'frames.json'), 'utf8')); } catch {}
const gridOf = (p) => { const f = frames[p]; return f ? { cols: f.cols, rows: f.rows, w: f.cell_w, h: f.cell_h, fps: f.fps || 10 } : null; };
// the paths the rules editor / skill engine accept (skill-engine.mjs RESOURCE_PATH_RE)
const OK = /^assets\/(Sprites\/[A-Za-z0-9_ ()[\]./-]+\.png|Sounds\/[A-Za-z0-9_ ()[\]./-]+\.wav)$/i;
const nameOf = (p) => path.basename(p).replace(/\.(png|wav)$/i, '').replace(/ - idle/, '').replace(/\s+\[[A-Z0-9]+\]$/, '').trim();
const sprites = [], sounds = [], units = new Map();
for (const e of man.entries || []) {
  const p = e.path;
  if (p.includes('..') || p.includes('\\')) continue;
  // unit voices (a class takes a unit's whole set): assets/Sounds/Units/<race>/<unit>/<unit> - <kind> - <line>.wav
  const u = /^assets\/Sounds\/Units\/([^/]+)\/([^/]+)\/([^/]+)\.wav$/i.exec(p);
  if (u) {
    const k = `${u[1]}/${u[2]}`;
    if (!units.has(k)) units.set(k, { race: u[1], unit: u[2], sounds: [] });
    const m = /^.+? - (.+?)(?: - (.+))?$/.exec(u[3]);
    units.get(k).sounds.push({ path: p, kind: m ? m[1] : '', line: m?.[2] || '', in_pack: pack.has(p) });
    continue;
  }
  if (!OK.test(p)) continue;
  if (/^assets\/Sprites\/(Effects|Misc)\/[^/]+\/.+\.png$/i.test(p)) sprites.push({ path: p, name: nameOf(p), in_pack: pack.has(p), grid: gridOf(p) });
  else if (/^assets\/Sounds\/SoundFX\/[^/]+\.wav$/i.test(p)) sounds.push({ path: p, name: nameOf(p), in_pack: pack.has(p) });
}
const by = (a, b) => a.name.localeCompare(b.name);
const unitList = [...units.values()].map(x => ({ ...x, sounds: x.sounds.sort((a, b) => a.kind.localeCompare(b.kind, undefined, { numeric: true })) }))
  .sort((a, b) => a.race.localeCompare(b.race) || a.unit.localeCompare(b.unit));
const out = { format: 2, source: 'chaosD6-Resources manifest.json', generated_at: new Date().toISOString(), sprites: sprites.sort(by), sounds: sounds.sort(by), units: unitList };
const file = path.join(GAME, 'gen-resources.json');
fs.writeFileSync(file, JSON.stringify(out) + '\n');
console.log(`${path.relative(GAME, file)}: ${sprites.length} sprites (${sprites.filter(s => !s.in_pack).length} not in the APK pack, ${sprites.filter(s => s.grid).length} with a frame grid), ${sounds.length} sounds (${sounds.filter(s => !s.in_pack).length} not in the pack), ${unitList.length} units (${unitList.reduce((n, x) => n + x.sounds.length, 0)} voice lines)`);
