#!/usr/bin/env node
// Push the offline tools that check the GameModels into the local chaosD6-GameModels git repo (default: the checkout
// gamemodels.mjs resolves, else /home/galt/chaosd6-gamemodels-repo) and refresh its index.json. The DEFINITIONS live
// only in that repo (user 2026-11-24) — edit them there; this tool never copies definitions. LOCAL ONLY: never pushes,
// never touches Radicle (publishing is game/tools/oci/gamemodels-rad-init.sh, run by the user). Commits only with --commit.
//
//   node tools/gamemodels-repo-sync.mjs [--repo DIR] [--commit [-m "message"]] [--dry-run]
//
// Copies from tools/gamemodels-repo-template: README.md, .gitattributes, .gitignore, package.json, tools/check.mjs,
// tools/manifest.mjs. tools/engine/{gamemodels,agenda}.mjs are BYTE-IDENTICAL copies of game/{gamemodels,agenda}.mjs
// (tools/pins.json records their sha256 + source), so the repo checks a definition exactly like the game does.
// index.json = { format, hash, races: {id: sha256}, buildings: …, … } over the repo's own definitions.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadGameModels, checkGameModels, buildIndex, knownIds, GAMEMODELS_DIR } from '../gamemodels.mjs';
import { assetFile } from '../asset-root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const TEMPLATE = path.join(HERE, 'gamemodels-repo-template');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const REPO = path.resolve(opt('--repo', GAMEMODELS_DIR || '/home/galt/chaosd6-gamemodels-repo'));
const DRY = flag('--dry-run'), COMMIT = flag('--commit') && !DRY;
const MSG = opt('-m', null);

if (!fs.existsSync(path.join(REPO, '.git'))) { console.error(`${REPO} is not a git checkout of chaosD6-GameModels`); process.exit(1); }
// the repo's own definitions must check before its tooling / index move
const m = loadGameModels(REPO);
const errors = checkGameModels(m, { known: knownIds(), assetFile });
if (errors.length) { console.error(`refusing to sync: ${errors.length} problem(s) in ${REPO}\n  ${errors.join('\n  ')}`); process.exit(1); }

const sha = (buf) => createHash('sha256').update(String(buf).replace(/\r\n/g, '\n')).digest('hex');
const writes = [];
const put = (rel, content) => {
  const f = path.join(REPO, rel);
  const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  if (old === content) return;
  writes.push(`${old === null ? 'add   ' : 'update'} ${rel}`);
  if (!DRY) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); }
};
for (const rel of ['README.md', '.gitattributes', '.gitignore', 'package.json', 'tools/check.mjs', 'tools/manifest.mjs']) put(rel, fs.readFileSync(path.join(TEMPLATE, rel), 'utf8'));
// the engine, byte-identical, and its pins
const pins = { format: 'chaosd6-gamemodels-pins/1', files: {} };
for (const name of ['gamemodels.mjs', 'agenda.mjs']) {
  const txt = fs.readFileSync(path.join(GAME, name), 'utf8');
  put(`tools/engine/${name}`, txt);
  pins.files[`tools/engine/${name}`] = { source: `game/${name}`, sha256: sha(txt) };
}
for (const rel of ['tools/check.mjs', 'tools/manifest.mjs']) pins.files[rel] = { source: `game/tools/gamemodels-repo-template/${rel}`, sha256: sha(fs.readFileSync(path.join(TEMPLATE, rel), 'utf8')) };
pins.npm = { 'json-logic-js': JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'package.json'), 'utf8')).dependencies['json-logic-js'] };
put('tools/pins.json', JSON.stringify(pins, null, 2) + '\n');
put('index.json', JSON.stringify(buildIndex(m), null, 2) + '\n');

console.log(writes.length ? writes.join('\n') : 'nothing to change');
console.log(`${DRY ? '[dry-run] ' : ''}${REPO}: ${m.files} definitions`);
if (COMMIT && writes.length) {
  const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();
  git('add', '-A');
  git('commit', '-q', '-m', MSG || `tools: sync the checker from chaosD6 (${m.files} definitions)`);
  console.log(`committed ${git('rev-parse', '--short', 'HEAD')}`);
} else if (!DRY) console.log('not committed (pass --commit to commit)');
