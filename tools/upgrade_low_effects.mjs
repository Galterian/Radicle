#!/usr/bin/env node
// Upgrade the 8 of 9 low-confidence effect sprite mappings in data/effects.json
// to better semantic fits from WBC3 Effects1. Also updates mapping_effects.json
// so the low_confidence array stops listing those we upgraded, and refreshes
// the corresponding .entries row. One leaves at low (effect_traps_mastery EPA5
// has no better alternative in the WBC3 sheet).
//
//   node tools/upgrade_low_effects.mjs [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaPath } from '../game/asset-root.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const dryRun = process.argv.includes('--dry-run');

// Each upgrade keeps the entry's own `match_reason` honest, bumps confidence
// to medium, and swaps path/wbc3_name/wbc3_code. `source` and `wbc3_race` stay.
const UPGRADES = {
  effect_sleep:        { name: 'Spell effect purplewhite glowing orbs', code: 'EZ05', dir: 'Spell effect purplewhite glowing orbs', reason: 'dreamy floating purple-white orbs hover over the sleeping target', confidence: 'medium' },
  effect_aging:        { name: 'Grey smoke wisps',                      code: 'EZ38', dir: 'Grey smoke wisps',                       reason: 'grey wisps = withering, time-stripping aura', confidence: 'medium' },
  effect_invisibility: { name: 'Spell effect white smoke rings',        code: 'EZ10', dir: 'Spell effect white smoke rings',         reason: 'target fades into expanding smoke rings', confidence: 'medium' },
  effect_golems_water: { name: 'Cyan ice shards',                       code: 'EZ56', dir: 'Cyan ice shards',                        reason: 'no water golem in WBC3; cyan shards stand in for a water elemental summoning marker', confidence: 'medium' },
  effect_golems_air:   { name: 'Spell effect white smoke cloud ring (large)', code: 'EZ13', dir: 'Spell effect white smoke cloud ring (large)', reason: 'no air golem in WBC3; large white cloud ring stands in for the air elemental summoning marker', confidence: 'medium' },
  effect_awake:        { name: 'Spell effect orange glowing ring eye',  code: 'EZ06', dir: 'Spell effect orange glowing ring eye',   reason: 'glowing-eye marker = perception / awakened terrain', confidence: 'medium' },
  effect_metaphysics:  { name: 'Spell effect starburst (large)',        code: 'EZ19', dir: 'Spell effect starburst (large)',         reason: 'large starburst = dramatic mass-change event', confidence: 'medium' },
  effect_confusion:    { name: 'Spell effect yellow sparkle cloud (very wide sheet)', code: 'EZ01', dir: 'Spell effect yellow sparkle cloud (very wide sheet)', reason: 'wide swirling spark cloud = scrambled perception', confidence: 'medium' },
};

const effP = path.join(REPO, 'data', 'effects.json');
const effects = JSON.parse(fs.readFileSync(effP, 'utf8'));
let bumped = 0;
for (const e of (effects.entries || [])) {
  const u = UPGRADES[e.id];
  if (!u) continue;
  const spritePath = `assets/Sprites/Effects/Effects1/${u.dir}/${u.dir} - idle [${u.code}].png`;
  // Sanity: path exists on disk
  const abs = mediaPath(spritePath);   // sprites may live in chaosD6-Resources
  if (!fs.existsSync(abs)) { console.log(`${e.id}: MISSING on disk — ${spritePath}  (skipping)`); continue; }
  const was = `${e.resources?.wbc3_code || '?'} ${e.resources?.wbc3_name || '?'} (${e.resources?.confidence || '?'})`;
  const sprites = e.resources?.sprites || {};
  sprites.effect = { path: spritePath, usage: 'effect animation strip (cols = frames; grid in assets/frames.json), play once at the target hex' };
  e.resources = {
    ...e.resources,
    wbc3_name: u.name,
    wbc3_code: u.code,
    wbc3_race: 'Effects1',
    match_reason: u.reason,
    confidence: u.confidence,
    sprites,
  };
  console.log(`${e.id}: was [${was}] -> ${u.code} ${u.name} (${u.confidence})`);
  bumped++;
}
if (!dryRun && bumped > 0) fs.writeFileSync(effP, JSON.stringify(effects, null, 2) + '\n');

// Keep assets/mapping_effects.json in sync: entries row + low_confidence list.
const mapP = path.join(REPO, 'assets', 'mapping_effects.json');
if (fs.existsSync(mapP)) {
  const map = JSON.parse(fs.readFileSync(mapP, 'utf8'));
  for (const id of Object.keys(UPGRADES)) {
    const u = UPGRADES[id];
    if (map.entries && map.entries[id]) {
      map.entries[id] = {
        ...map.entries[id],
        asset: `assets/Sprites/Effects/Effects1/${u.dir}/${u.dir} - idle [${u.code}].png`,
        wbc3_name: u.name,
        reason: u.reason,
        confidence: u.confidence,
      };
    }
  }
  // Prune upgraded ids from low_confidence
  if (Array.isArray(map.low_confidence)) {
    const upgraded = new Set(Object.keys(UPGRADES));
    map.low_confidence = map.low_confidence.filter(id => !upgraded.has(id));
  }
  if (!dryRun) fs.writeFileSync(mapP, JSON.stringify(map, null, 2) + '\n');
}

console.log(`\n${bumped} effects upgraded${dryRun ? ' (dry run)' : ''}; effect_traps_mastery left at low (EPA5 is already the best WBC3 fit).`);
