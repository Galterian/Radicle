#!/usr/bin/env node
// Build the public, read-only rules site (EDITOR_SPEC ruling 1, 2026-11-22) — https://92-5-138-121.sslip.io/rules/
// is static files only (no api/ → the editor knows it is a visitor). Same layout the node serves (game/editor-api.mjs):
//   rules.html, editor.html        the shell (repo-root editor.html)
//   editor/*                       the editor modules + css (copied as they are)
//   data/*.json                    data/ copied byte for byte (CRLF untouched); the definitions collections of
//                                  data/index.json (effects, skills) PREBUILT from the definitions' card blocks
//                                  (defs-collection.mjs definitionsCollection), as the node serves them live
//   defs/index.json                { skill: [ids], effect: [ids], class: [ids] }
//   defs/<kind>/<id>.json          the built-in definition files (game/skills-data/skills, effects-data/effects, classes-data/classes)
//
//   node tools/rules-site-build.mjs --out <dir>        (the dir is emptied first; refuses / and the repo itself)
// Deploying is separate (game/tools/out/_ed_deploy_rules.sh: tar → scp → swap /var/www/rules on the seed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definitionsCollection, definitionsDirOf, resolveDefinitionsDir } from '../defs-collection.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const REPO = path.resolve(GAME, '..');
const DEF_DIRS = { skill: 'skills-data/skills', effect: 'effects-data/effects', class: 'classes-data/classes' };

export function buildRulesSite(out, { repoRoot = REPO, gameDir = GAME, dataDir = path.join(repoRoot, 'data') } = {}) {
  const abs = path.resolve(out);
  if (abs === path.parse(abs).root || abs === repoRoot || repoRoot.startsWith(abs + path.sep) || abs === dataDir) throw new Error(`refusing to build into ${abs}`);
  fs.rmSync(abs, { recursive: true, force: true });
  fs.mkdirSync(path.join(abs, 'data'), { recursive: true });
  const sum = { shell: 0, editor: 0, data: 0, prebuilt: [], defs: {} };
  const shell = fs.readFileSync(path.join(repoRoot, 'editor.html'));
  for (const f of ['rules.html', 'editor.html']) { fs.writeFileSync(path.join(abs, f), shell); sum.shell++; }
  const ed = path.join(repoRoot, 'editor');
  if (fs.existsSync(ed)) {
    fs.cpSync(ed, path.join(abs, 'editor'), { recursive: true, filter: (src) => !path.basename(src).startsWith('.') });
    const count = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
    sum.editor = count(path.join(abs, 'editor'));
  }
  for (const f of fs.readdirSync(dataDir).filter(f => f.endsWith('.json')).sort()) { fs.copyFileSync(path.join(dataDir, f), path.join(abs, 'data', f)); sum.data++; }
  const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
  for (const c of index.collections || []) {
    const def = definitionsDirOf(index, c.id);
    if (!def) continue;
    const dir = resolveDefinitionsDir(dataDir, def);
    if (!dir) throw new Error(`collection ${c.id}: definitions directory ${def} not found`);
    const coll = definitionsCollection(c.id, dir, def);
    fs.writeFileSync(path.join(abs, 'data', c.file || `${c.id}.json`), JSON.stringify(coll));   // as definitionsCollectionText serves it
    sum.prebuilt.push(`${c.file || c.id} (${coll.entries.length} entries)`);
  }
  const ids = {};
  for (const [kind, rel] of Object.entries(DEF_DIRS)) {
    const src = path.join(gameDir, rel);
    const files = fs.existsSync(src) ? fs.readdirSync(src).filter(f => f.endsWith('.json')).sort() : [];
    fs.mkdirSync(path.join(abs, 'defs', kind), { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(src, f), path.join(abs, 'defs', kind, f));
    ids[kind] = files.map(f => f.slice(0, -5));
    sum.defs[kind] = files.length;
  }
  fs.writeFileSync(path.join(abs, 'defs', 'index.json'), JSON.stringify(ids));
  return { out: abs, ...sum };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  if (i < 0 || !argv[i + 1]) { console.error('usage: node tools/rules-site-build.mjs --out <dir>'); process.exit(2); }
  const s = buildRulesSite(argv[i + 1]);
  console.log(`rules site → ${s.out}`);
  console.log(`  shell: rules.html + editor.html; editor/: ${s.editor} file(s)`);
  console.log(`  data/: ${s.data} file(s) copied; prebuilt: ${s.prebuilt.join(', ') || 'none'}`);
  console.log(`  defs/: ${Object.entries(s.defs).map(([k, n]) => `${n} ${k}`).join(', ')} (+ defs/index.json); no api/ (read-only)`);
}
