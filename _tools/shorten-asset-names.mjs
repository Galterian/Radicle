#!/usr/bin/env node
// One-shot renamer: finds asset files under assets/Sprites/{Effects,Misc}/Effects1/
// whose repo-relative path exceeds a threshold (so Windows path limits don't
// break Git worktrees), builds a short "talking" name keyed by the WBC3 code
// in [brackets] + a sanitized stem, renames folder + file on disk, and
// rewrites every JSON file that references the old paths.
//
// Idempotent: if the short name already exists, skips. Dry-run with --dry.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const DRY = process.argv.includes('--dry');
const THRESH = 100;   // path-length threshold (full relative path chars)
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

// Build a short folder/file stem from the original folder name.
// Preserve: WBC3 code in [XXXX], the ` - direction N ` marker, the ` - idle | walk | attack | death | info | fidget | cast ` kind.
function shorten(name) {
  // Peel code at end: [XXXX] or [X….] — we tolerate the ellipsis character.
  const codeMatch = name.match(/\[([^\]]{1,8})\]\s*$/);
  const code = codeMatch ? codeMatch[1].replace(/…/g, '') : '';
  let base = codeMatch ? name.slice(0, codeMatch.index).trim() : name.trim();
  // Preserve `direction N` and the kind suffix (idle/walk/attack/death/info/fidget/cast),
  // dropping everything else to a short keyword.
  const dirMatch = base.match(/direction\s+(\d)/i);
  const dir = dirMatch ? `dir${dirMatch[1]}` : '';
  const kindMatch = base.match(/-\s*(idle|walk|attack|death|info|fidget|cast)\s*$/i);
  const kind = kindMatch ? kindMatch[1].toLowerCase() : '';
  if (kindMatch) base = base.slice(0, kindMatch.index).trim();
  if (dirMatch) base = base.replace(/-\s*direction\s+\d/i, '').trim();
  // Drop parenthetical asides and "possibly ..." fluff; keep the first 2-3 words.
  base = base.replace(/\([^)]*\)/g, '').replace(/\s*-\s*possibly.*$/i, '').replace(/\s*-\s*swamp dragon.*$/i, '').replace(/\s*-\s*frost dragon.*$/i, '').replace(/\s*-\s*storm dragon.*$/i, '').replace(/\s{2,}/g, ' ').trim();
  // Compress multi-word head to a short "talking" stem.
  const words = base.split(/\s+/).filter(Boolean).slice(0, 3);
  let stem = words.join('_').replace(/[^A-Za-z0-9_]/g, '');
  if (stem.length > 24) stem = stem.slice(0, 24);
  // Final: "<stem> [dirN] [CODE]" with sensible spacing
  const parts = [stem];
  if (dir) parts.push(dir);
  if (code) parts.push(`[${code}]`);
  return { stem, dir, kind, code, folder: parts.join(' '), fileKind: kind };
}

function walkOne(scanDir, actions) {
  const abs = path.join(ROOT, scanDir);
  if (!fs.existsSync(abs)) return;
  for (const name of fs.readdirSync(abs)) {
    const folderAbs = path.join(abs, name);
    const stat = fs.statSync(folderAbs);
    if (!stat.isDirectory()) continue;
    // Check this folder+any files inside it that are long.
    let longHere = (scanDir + '/' + name).length > THRESH;
    if (!longHere) {
      for (const f of fs.readdirSync(folderAbs)) {
        if ((scanDir + '/' + name + '/' + f).length > THRESH) { longHere = true; break; }
      }
    }
    if (!longHere) continue;
    const shortParts = shorten(name);
    if (!shortParts.code && !shortParts.stem) { console.warn('skip (no code or stem):', scanDir + '/' + name); continue; }
    const newFolder = shortParts.folder;
    if (newFolder === name) continue;
    const newFolderAbs = path.join(abs, newFolder);
    if (fs.existsSync(newFolderAbs)) { console.warn('target exists, skip:', scanDir + '/' + newFolder); continue; }
    actions.push({ type: 'mv-folder', from: scanDir + '/' + name, to: scanDir + '/' + newFolder, oldFolder: folderAbs, newFolder: newFolderAbs, shortParts });
  }
}

const actions = [];
for (const d of SCAN_DIRS) walkOne(d, actions);

// For each folder rename, also figure out which files inside need renaming
// (same stem + kind + code pattern, so the file matches the folder).
for (const a of actions) {
  const files = fs.readdirSync(a.oldFolder);
  for (const f of files) {
    // Short name for the file: "<stem> [dirN] - <kind> [CODE].ext"
    const extIdx = f.lastIndexOf('.');
    const ext = extIdx > 0 ? f.slice(extIdx) : '';
    const base = extIdx > 0 ? f.slice(0, extIdx) : f;
    const sh = shorten(base);
    const parts = [sh.stem || a.shortParts.stem];
    if (sh.dir || a.shortParts.dir) parts.push(sh.dir || a.shortParts.dir);
    if (sh.fileKind) parts.push('- ' + sh.fileKind);
    if (sh.code || a.shortParts.code) parts.push(`[${sh.code || a.shortParts.code}]`);
    const newFile = parts.join(' ') + ext;
    if (newFile === f) continue;
    a.files = a.files || [];
    a.files.push({ from: f, to: newFile });
  }
}

// Print plan.
console.log(`\n=== plan (${actions.length} folders) ===`);
for (const a of actions) {
  console.log(`DIR  ${a.from}`);
  console.log(`  -> ${a.to}`);
  for (const f of (a.files || [])) {
    console.log(`  FILE  ${f.from}`);
    console.log(`    ->  ${f.to}`);
  }
}
if (DRY) { console.log('\n(dry run, no changes)'); process.exit(0); }

// Apply filesystem renames.
const mapping = []; // {oldRel, newRel} for every file that moved
for (const a of actions) {
  // Rename folder first; then rename files inside.
  const scanDir = a.from.slice(0, a.from.lastIndexOf('/'));
  // We need the OLD files-inside paths before folder rename.
  const oldFolder = a.oldFolder;
  const oldFiles = fs.readdirSync(oldFolder).map(f => ({ old: path.join(oldFolder, f), relOld: `${a.from}/${f}` }));
  fs.renameSync(a.oldFolder, a.newFolder);
  for (const of_ of oldFiles) {
    const basename = path.basename(of_.old);
    const match = (a.files || []).find(x => x.from === basename);
    if (match) {
      const newAbs = path.join(a.newFolder, match.to);
      fs.renameSync(path.join(a.newFolder, basename), newAbs);
      mapping.push({ oldRel: `${a.from}/${basename}`, newRel: `${a.to}/${match.to}` });
    } else {
      mapping.push({ oldRel: `${a.from}/${basename}`, newRel: `${a.to}/${basename}` });
    }
  }
  mapping.push({ oldRel: a.from + '/', newRel: a.to + '/' });   // folder prefix
  mapping.push({ oldRel: a.from,       newRel: a.to });         // bare folder
}

console.log(`\nrenamed ${actions.length} folders; building JSON mapping with ${mapping.length} entries`);

// Rewrite each JSON file that references anything that moved.
mapping.sort((a, b) => b.oldRel.length - a.oldRel.length);   // longest first so substrings don't collide
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
console.log(`\n${touched} JSON files updated. Done.`);
