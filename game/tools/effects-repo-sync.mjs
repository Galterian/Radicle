#!/usr/bin/env node
// Mirror game/effects-data/effects/*.json (E1/E2 definitions) into the local chaosD6-Effects git
// repo and commit there. LOCAL ONLY: never pushes, never touches Radicle (publishing is
// game/tools/out/effects-rad-init.sh / `git push rad`, run by the user).
//
//   node tools/effects-repo-sync.mjs [--repo /home/galt/chaosd6-effects-repo] [--src game/effects-data/effects]
//        [--hooks-src game/effects-data/hooks|none] [--libs-src game/effects-data/lib|none] [--branch main] [--no-commit] [--dry-run] [--keep-extra] [-m "message"]
//
// HR (2026-11-18): also mirrors the effect hook programs <src>/../hooks/*.json (game/effect-hooks.mjs, schema
// chaosd6.effect-hooks/1) to hooks/<family>.json, each validated with effect-hooks.mjs#validateHookFile, and lists
// them in index.json under `hooks`. --hooks-src none skips them (index.json then has no `hooks` key).
// LR (2026-11-18): also mirrors the effect libraries <src>/../lib/*.json (schema chaosd6.effect-lib/1) to
// lib/<id>.json, each validated with effect-engine.mjs#validateLib, and every synced effect's `uses` must name a
// synced lib; listed in index.json under `libs`. --libs-src none skips them (index.json then has no `libs` key).
//
// Writes: effects/<id>.json (pretty JSON, LF, key order as in the source), SCHEMA.md (from
// game/effects-data/SCHEMA.md, else the template placeholder), README.md, validator/pin.json
// (template, only if missing — E5 owns it afterwards), tools/manifest.mjs, .gitattributes, index.json.
// Files in effects/ with no source are removed unless --keep-extra. Runs `git init -b main` if needed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildEffectsManifest, assertEffectId, assertEffectHooksId, assertEffectLibId } from '../effects-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const TEMPLATE = path.join(HERE, 'effects-repo-template');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const REPO = path.resolve(opt('--repo', process.env.CHAOSD6_EFFECTS_REPO || '/home/galt/chaosd6-effects-repo'));
const SRC = path.resolve(opt('--src', path.join(GAME, 'effects-data', 'effects')));
const SCHEMA_SRC = path.join(path.dirname(SRC), 'SCHEMA.md');
const HOOKS_OPT = opt('--hooks-src', path.join(path.dirname(SRC), 'hooks'));
const HOOKS_SRC = HOOKS_OPT === 'none' ? null : path.resolve(HOOKS_OPT);
const LIBS_OPT = opt('--libs-src', path.join(path.dirname(SRC), 'lib'));
const LIBS_SRC = LIBS_OPT === 'none' ? null : path.resolve(LIBS_OPT);
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

// 1b. hook programs (HR) — validated by the game's own hook validator before anything is written
const hooks = [];
const hookNames = HOOKS_SRC && fs.existsSync(HOOKS_SRC) ? fs.readdirSync(HOOKS_SRC).filter(n => n.endsWith('.json')).sort() : [];
if (hookNames.length) {
  const { validateHookFile } = await import('../effect-hooks.mjs');
  for (const n of hookNames) {
    const f = JSON.parse(fs.readFileSync(path.join(HOOKS_SRC, n), 'utf8').replace(/^﻿/, ''));
    assertEffectHooksId(f?.id);
    if (`${f.id}.json` !== n) throw new Error(`hooks/${n}: id ${f.id} does not match the file name`);
    const errs = validateHookFile(f);
    if (errs.length) throw new Error(`hooks/${n}: ${errs.join('; ')}`);
    hooks.push(f);
  }
}

// 1c. libraries (LR) — validated by the engine's own lib validator; every effect's `uses` must be synced too
const libs = [];
const libNames = LIBS_SRC && fs.existsSync(LIBS_SRC) ? fs.readdirSync(LIBS_SRC).filter(n => n.endsWith('.json')).sort() : [];
if (libNames.length) {
  const { validateLib } = await import('../effect-engine.mjs');
  for (const n of libNames) {
    const l = JSON.parse(fs.readFileSync(path.join(LIBS_SRC, n), 'utf8').replace(/^﻿/, ''));
    assertEffectLibId(l?.id);
    if (`${l.id}.json` !== n) throw new Error(`lib/${n}: id ${l.id} does not match the file name`);
    const errs = validateLib(l);
    if (errs.length) throw new Error(`lib/${n}: ${errs.join('; ')}`);
    libs.push(l);
  }
  const have = new Set(libs.map(l => l.id));
  for (const d of defs) for (const u of d.uses || []) if (!have.has(u)) throw new Error(`effects/${d.id}.json uses lib ${u}, not in ${LIBS_SRC}`);
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

const hooksDir = path.join(REPO, 'hooks');
for (const h of hooks) write(`hooks/${h.id}.json`, JSON.stringify(h, null, 2) + '\n');
const keepH = new Set(hooks.map(h => `${h.id}.json`));
if (!flag('--keep-extra') && fs.existsSync(hooksDir)) {
  for (const n of fs.readdirSync(hooksDir)) {
    if (n.endsWith('.json') && !keepH.has(n)) { changes.push(`D hooks/${n}`); if (!DRY) fs.unlinkSync(path.join(hooksDir, n)); }
  }
}

const libDir = path.join(REPO, 'lib');
for (const l of libs) write(`lib/${l.id}.json`, JSON.stringify(l, null, 2) + '\n');
const keepL = new Set(libs.map(l => `${l.id}.json`));
if (!flag('--keep-extra') && fs.existsSync(libDir)) {
  for (const n of fs.readdirSync(libDir)) {
    if (n.endsWith('.json') && !keepL.has(n)) { changes.push(`D lib/${n}`); if (!DRY) fs.unlinkSync(path.join(libDir, n)); }
  }
}

// F9e (2026-11-22): the JS references of the built-ins = TEST ORACLES (<src>/../oracle/*.mjs; effects-js, standing-js,
// natural-kinds-js, hooks-js), byte-identical (LF) to oracle/. They import the game's primitives (../../effect-prims.mjs
// etc.), so they run from a chaosD6 tree, not from this repo alone (as classes-data/oracle in chaosD6-Classes).
const ORACLE_SRC = path.join(path.dirname(SRC), 'oracle'), oracleDir = path.join(REPO, 'oracle');
const oracles = fs.existsSync(ORACLE_SRC) ? fs.readdirSync(ORACLE_SRC).filter(n => n.endsWith('.mjs')).sort() : [];
for (const n of oracles) write(`oracle/${n}`, lf(fs.readFileSync(path.join(ORACLE_SRC, n), 'utf8')));
if (!flag('--keep-extra') && fs.existsSync(oracleDir)) {
  for (const n of fs.readdirSync(oracleDir)) {
    if (n.endsWith('.mjs') && !oracles.includes(n)) { changes.push(`D oracle/${n}`); if (!DRY) fs.unlinkSync(path.join(oracleDir, n)); }
  }
}

// 4. manifest — over what is in the repo's effects/ now (== sources unless --keep-extra)
let all = defs;
if (flag('--keep-extra') && fs.existsSync(effDir)) {
  all = fs.readdirSync(effDir).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(effDir, n), 'utf8')));
}
let allHooks = hooks;
if (flag('--keep-extra') && fs.existsSync(hooksDir)) {
  allHooks = fs.readdirSync(hooksDir).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(hooksDir, n), 'utf8')));
}
let allLibs = libs;
if (flag('--keep-extra') && fs.existsSync(libDir)) {
  allLibs = fs.readdirSync(libDir).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(libDir, n), 'utf8')));
}
const manifest = buildEffectsManifest(all, allHooks, allLibs);
write('index.json', JSON.stringify(manifest, null, 2) + '\n');

console.log(`${defs.length} effect(s) from ${SRC}; ${hooks.length} hook file(s) from ${HOOKS_SRC || '(none)'}; ${libs.length} lib(s) from ${LIBS_SRC || '(none)'}`);
for (const c of changes) console.log(`  ${c}`);
if (!changes.length) console.log('  (no changes)');

// 5. commit
if (COMMIT) {
  git('add', '-A');
  const staged = git('diff', '--cached', '--name-only');
  if (!staged) { console.log('nothing to commit'); }
  else {
    const n = Object.keys(manifest.effects).length;
    const nh = Object.keys(manifest.hooks || {}).length, nl = Object.keys(manifest.libs || {}).length;
    const msg = MSG || `Sync ${n} effect(s)${nh ? ` + ${nh} hook file(s)` : ''}${nl ? ` + ${nl} lib(s)` : ''} from chaosD6 game/effects-data`;
    execFileSync('git', ['-C', REPO, '-c', 'user.name=chaosd6-sync', '-c', 'user.email=sync@chaosd6', 'commit', '-q', '-m', msg]);
    console.log(`committed ${git('rev-parse', 'HEAD')} on ${BRANCH}`);
  }
}
if (DRY) console.log('(dry run: nothing written)');
