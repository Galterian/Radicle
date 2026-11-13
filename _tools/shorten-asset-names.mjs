#!/usr/bin/env node
// One-shot renamer: targets only the asset files that are long enough to break
// Git worktree checkout on Windows (full path from repo root > 140 chars).
// Builds a short "talking" name keyed by WBC3 code + a sanitized stem,
// renames folder + file on disk, and rewrites every JSON reference.
//
// Dry-run with --dry. Idempotent: re-running after success is a no-op.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const THRESH = 140;
const JSON_FILES = [
  'godot/assets_manifest.json',
  'data/actions.json',
  'data/effects.json',
  'assets/frames_used.json',
  'assets/frames.json',
  'assets/mapping_effects.json',
  'assets/asset_index.json',
  '_effect_paths.json',
  '_test/effects/index.json',
];
const SCAN_DIRS = ['assets/Sprites/Effects/Effects1', 'assets/Sprites/Misc/Effects1'];

// A hand-written stem catalog is far safer than regex surgery against auto-generated
// WBC3 catalog names. These were taken from the 40 names that Git rejected during
// worktree creation; everything else stays untouched.
const STEMS = [
  { match: /^Acidpoison dragon breath/i,                 stem: 'AcidBreath' },
  { match: /^Ice dragon breath/i,                        stem: 'IceBreath' },
  { match: /^Lightning dragon breath/i,                  stem: 'LightningBreath' },
  { match: /^Violetblue dragon breath/i,                 stem: 'CelestBreath' },
  { match: /^Greencyan-green dragon breath/i,            stem: 'LichBreath' },
  { match: /^Elliptical area overlay size 1 \(/i,        stem: 'AreaOverlay1' },
  { match: /^Minimapresource icons/i,                    stem: 'MineIcons' },
  { match: /^Spell effect tall whiteblue flame columns/i,stem: 'SummonPillar' },
  { match: /^Hero victory banner picture/i,              stem: 'HeroVictory' },
  { match: /^UI horizontal bars with skullclaw/i,        stem: 'UIBars' },
  { match: /^UI item slot grid panel/i,                  stem: 'UISlots' },
];

function pickStem(folderName) {
  for (const s of STEMS) if (s.match.test(folderName)) return s.stem;
  return null;
}

function dirMarker(folderName) {
  const m = folderName.match(/direction\s+(\d)/i);
  return m ? `dir${m[1]}` : '';
}

// Extract WBC3 code from a filename ending in `[XXXX].ext` or `[XX….ext` (ellipsis-truncated).
function extractCode(filename) {
  const base = filename.replace(/\.[A-Za-z0-9]+$/, '');
  const m = base.match(/\[([A-Za-z0-9]{2,4})(?:[….]+)?\]?\s*$/);
  return m ? m[1] : null;
}

// Extract the kind suffix ( - idle | walk | attack | death | info | fidget | cast ) from a filename stem.
function extractKind(filename) {
  const base = filename.replace(/\.[A-Za-z0-9]+$/, '');
  // Strip bracketed code first
  const noCode = base.replace(/\s*\[[^\]]*\]?\s*$/, '').trim();
  const m = noCode.match(/-\s*(idle|walk|attack|death|info|fidget|cast)\s*$/i);
  return m ? m[1].toLowerCase() : 'idle';
}

// Infer code from the FOLDER by probing the files inside (folders don't carry codes).
function folderCode(folderAbs) {
  const files = fs.readdirSync(folderAbs);
  for (const f of files) {
    const c = extractCode(f);
    if (c) return c;
  }
  return '';
}

function buildFolderName(stem, dir, code) {
  const parts = [stem];
  if (dir) parts.push(dir);
  if (code) parts.push(`[${code}]`);
  return parts.join(' ');
}

function buildFileName(stem, dir, kind, code, ext) {
  const parts = [stem];
  if (dir) parts.push(dir);
  if (kind) parts.push(`- ${kind}`);
  if (code) parts.push(`[${code}]`);
  return parts.join(' ') + ext;
}

const actions = [];
for (const scanDir of SCAN_DIRS) {
  const abs = path.join(ROOT, scanDir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs)) {
    const folderAbs = path.join(abs, name);
    const st = fs.statSync(folderAbs);
    if (!st.isDirectory()) continue;
    // Only touch things where SOME inside-file path exceeds the threshold.
    let longInside = false;
    const files = fs.readdirSync(folderAbs);
    for (const f of files) {
      if ((scanDir + '/' + name + '/' + f).length > THRESH) { longInside = true; break; }
    }
    if (!longInside) continue;
    const stem = pickStem(name);
    if (!stem) { console.warn('no stem rule for:', name); continue; }
    const dir  = dirMarker(name);
    const code = folderCode(folderAbs);
    const newFolder = buildFolderName(stem, dir, code);
    const newFolderAbs = path.join(abs, newFolder);
    const fileRenames = [];
    for (const f of files) {
      const ext  = path.extname(f);
      const kind = extractKind(f);
      const fcode = extractCode(f) || code;
      const newFile = buildFileName(stem, dir, kind, fcode, ext);
      fileRenames.push({ from: f, to: newFile });
    }
    actions.push({ scanDir, name, newFolder, folderAbs, newFolderAbs, fileRenames });
  }
}

console.log(`\n=== plan (${actions.length} folders) ===\n`);
for (const a of actions) {
  console.log(`DIR  ${a.scanDir}/${a.name}`);
  console.log(`  -> ${a.scanDir}/${a.newFolder}`);
  for (const f of a.fileRenames) {
    if (f.from === f.to) continue;
    console.log(`  FILE ${f.from}`);
    console.log(`    -> ${f.to}`);
  }
}
if (DRY) { console.log('\n(dry run)'); process.exit(0); }

// Apply filesystem renames.
const mapping = []; // {oldRel, newRel}
for (const a of actions) {
  if (fs.existsSync(a.newFolderAbs) && a.newFolderAbs !== a.folderAbs) {
    console.warn(`SKIP (target exists): ${a.scanDir}/${a.newFolder}`);
    continue;
  }
  // Collect old → new paths before the folder itself is moved.
  for (const f of a.fileRenames) {
    mapping.push({ oldRel: `${a.scanDir}/${a.name}/${f.from}`, newRel: `${a.scanDir}/${a.newFolder}/${f.to}` });
  }
  // Also record the folder itself (for JSON refs that end at the folder).
  mapping.push({ oldRel: `${a.scanDir}/${a.name}/`, newRel: `${a.scanDir}/${a.newFolder}/` });
  mapping.push({ oldRel: `${a.scanDir}/${a.name}`,  newRel: `${a.scanDir}/${a.newFolder}` });
  // Rename folder first, then rename each file inside.
  fs.renameSync(a.folderAbs, a.newFolderAbs);
  for (const f of a.fileRenames) {
    if (f.from === f.to) continue;
    fs.renameSync(path.join(a.newFolderAbs, f.from), path.join(a.newFolderAbs, f.to));
  }
}

console.log(`\nrenamed ${actions.length} folders`);

// Rewrite JSON refs. Longest keys first so a short prefix doesn't match before
// a specific file path.
mapping.sort((a, b) => b.oldRel.length - a.oldRel.length);
let touched = 0;
for (const jf of JSON_FILES) {
  const abs = path.join(ROOT, jf);
  if (!fs.existsSync(abs)) continue;
  const before = fs.readFileSync(abs, 'utf8');
  let after = before;
  for (const m of mapping) {
    if (!after.includes(m.oldRel)) continue;
    after = after.split(m.oldRel).join(m.newRel);
  }
  if (after !== before) {
    fs.writeFileSync(abs, after);
    touched++;
    console.log(`  rewrote ${jf}`);
  }
}
console.log(`\n${touched} JSON files updated.`);
