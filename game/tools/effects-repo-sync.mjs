#!/usr/bin/env node
// Mirror game/effects-data/effects/*.json (E1/E2 definitions) into the local chaosD6-Effects git
// repo and commit there. LOCAL ONLY: never pushes, never touches Radicle (publishing is
// game/tools/out/effects-rad-init.sh / `git push rad`, run by the user).
//
//   node tools/effects-repo-sync.mjs [--repo /home/galt/chaosd6-effects-repo] [--src game/effects-data/effects]
//        [--branch main] [--no-commit] [--dry-run] [--keep-extra] [-m "message"]
//
// Writes: effects/<id>.json (pretty JSON, LF, key order as in the source), SCHEMA.md (from
// game/effects-data/SCHEMA.md, else the template placeholder), README.md, validator/pin.json
// (template, only if missing — E5 owns it afterwards), tools/manifest.mjs, .gitattributes, index.json.
// Files in effects/ with no source are removed unless --keep-extra. Runs `git init -b main` if needed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManifest, assertEffectId } from '../effects-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const TEMPLATE = path.join(HERE, 'effects-repo-template');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const REPO = path.resolve(opt('--repo', process.env.CHAOSD6_EFFECTS_REPO || '/home/galt/chaosd6-effects-repo'));
const SRC = path.resolve(opt('--src', path.join(GAME, 'effects-data', 'effects')));
const SCHEMA_SRC = path.join(path.dirname(SRC), 'SCHEMA.md');
const BRANCH = opt('--branch', 'main');
const DRY = flag('--dry-run');
const COMMIT = !flag('--no-commit') && !DRY;
const MSG = opt('-m', null);

const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const lf = (s) => s.replace(/\r\n/g, '\n');
const changes = [];
function write(rel, content) {
  const f = path.join(REPO, rel);
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  if (cur === content) return;
  changes.push(`${cur === null ? 'A' : 'M'} ${rel}`);
  if (DRY) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

// 1. sources
const defs = [];
const srcNames = fs.existsSync(SRC) ? fs.readdirSync(SRC).filter(n => n.endsWith('.json')).sort() : [];
if (!fs.existsSync(SRC)) console.warn(`(no source dir ${SRC} yet — repo skeleton only)`);
for (const n of srcNames) {
  const def = JSON.parse(fs.readFileSync(path.join(SRC, n), 'utf8'));
  assertEffectId(def?.id);
  if (`${def.id}.json` !== n) throw new Error(`${n}: id ${def.id} does not match the file name`);
  defs.push(def);
}

// 2. repo
if (!DRY && !fs.existsSync(path.join(REPO, '.git'))) {
  fs.mkdirSync(REPO, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', BRANCH, REPO]);
  console.log(`git init ${REPO} (branch ${BRANCH})`);
}
if (!DRY && fs.existsSync(path.join(REPO, '.git'))) {
  let cur = '';
  try { cur = git('symbolic-ref', '--short', 'HEAD'); } catch {}
  if (cur && cur !== BRANCH) throw new Error(`${REPO} is on ${cur}, not ${BRANCH} — switch first (refusing to mirror onto another branch)`);
}

// 3. files
const tpl = (rel) => lf(fs.readFileSync(path.join(TEMPLATE, rel), 'utf8'));
write('README.md', tpl('README.md'));
write('.gitattributes', tpl('.gitattributes'));
write('tools/manifest.mjs', tpl('tools/manifest.mjs'));
if (!fs.existsSync(path.join(REPO, 'validator', 'pin.json'))) write('validator/pin.json', tpl('validator/pin.json'));
write('SCHEMA.md', fs.existsSync(SCHEMA_SRC) ? lf(fs.readFileSync(SCHEMA_SRC, 'utf8')) : tpl('SCHEMA.md'));
for (const d of defs) write(`effects/${d.id}.json`, JSON.stringify(d, null, 2) + '\n');
const keep = new Set(defs.map(d => `${d.id}.json`));
const effDir = path.join(REPO, 'effects');
if (!flag('--keep-extra') && fs.existsSync(effDir)) {
  for (const n of fs.readdirSync(effDir)) {
    if (n.endsWith('.json') && !keep.has(n)) { changes.push(`D effects/${n}`); if (!DRY) fs.unlinkSync(path.join(effDir, n)); }
  }
}
if (!defs.length) write('effects/.gitkeep', '');
else if (fs.existsSync(path.join(effDir, '.gitkeep'))) { changes.push('D effects/.gitkeep'); if (!DRY) fs.unlinkSync(path.join(effDir, '.gitkeep')); }

// 4. manifest — over what is in the repo's effects/ now (== sources unless --keep-extra)
let all = defs;
if (flag('--keep-extra') && fs.existsSync(effDir)) {
  all = fs.readdirSync(effDir).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(effDir, n), 'utf8')));
}
const manifest = buildManifest(all);
write('index.json', JSON.stringify(manifest, null, 2) + '\n');

console.log(`${defs.length} effect(s) from ${SRC}`);
for (const c of changes) console.log(`  ${c}`);
if (!changes.length) console.log('  (no changes)');

// 5. commit
if (COMMIT) {
  git('add', '-A');
  const staged = git('diff', '--cached', '--name-only');
  if (!staged) { console.log('nothing to commit'); }
  else {
    const n = Object.keys(manifest.effects).length;
    const msg = MSG || `Sync ${n} effect(s) from chaosD6 game/effects-data`;
    execFileSync('git', ['-C', REPO, '-c', 'user.name=chaosd6-sync', '-c', 'user.email=sync@chaosd6', 'commit', '-q', '-m', msg]);
    console.log(`committed ${git('rev-parse', 'HEAD')} on ${BRANCH}`);
  }
}
if (DRY) console.log('(dry run: nothing written)');
