#!/usr/bin/env node
// Top up the five skills that shipped audio-only (sprites:{}) by taking the
// richer `resources` block from commit fb95b64a80 (the WSL "Skill resource
// mapping done" merge). Pure data patch, no code changes.
//
//   node tools/topup_skills.mjs [--dry-run]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SRC_REV = 'fb95b64a80';
const TARGETS = ['skill_grapple', 'skill_disruption_move', 'skill_dodge', 'skill_bluff', 'skill_intimidation'];
const dryRun = process.argv.includes('--dry-run');

const srcText = execSync(`git -C ${REPO} show ${SRC_REV}:data/skills.json`, { encoding: 'utf8' });
const src = JSON.parse(srcText);
const srcById = new Map((src.entries || []).map(e => [e.id, e]));

const mineP = path.join(REPO, 'data', 'skills.json');
const mine = JSON.parse(fs.readFileSync(mineP, 'utf8'));
let patched = 0;
for (const e of (mine.entries || [])) {
  if (!TARGETS.includes(e.id)) continue;
  const s = srcById.get(e.id);
  if (!s || !s.resources) { console.log(`${e.id}: no source — SKIP`); continue; }
  const before = JSON.stringify(e.resources?.sprites || {});
  const after  = JSON.stringify(s.resources?.sprites || {});
  if (before === after && JSON.stringify(e.resources) === JSON.stringify(s.resources)) {
    console.log(`${e.id}: identical — SKIP`); continue;
  }
  const sprEmpty = !e.resources?.sprites || Object.keys(e.resources.sprites).length === 0;
  console.log(`${e.id}: was-empty-sprites=${sprEmpty}  wbc3=${s.resources.wbc3_code}  conf=${s.resources.confidence}`);
  e.resources = s.resources;
  patched++;
}
if (!dryRun && patched > 0) fs.writeFileSync(mineP, JSON.stringify(mine, null, 2) + '\n');
console.log(`\n${patched} skills patched${dryRun ? ' (dry run)' : ''}.`);
