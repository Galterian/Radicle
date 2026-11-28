#!/usr/bin/env node
// Mirror the skill definitions, their libraries AND the tools needed to check them offline into
// the local chaosD6-Skills git repo, and commit there (program S3). LOCAL ONLY: never pushes,
// never touches Radicle (publishing is game/tools/oci/skills-rad-init.sh, run by the user).
//
//   node tools/skills-repo-sync.mjs [--repo /home/galt/chaosd6-skills-repo] [--src game/skills-data]
//        [--engine a.mjs,b.mjs] [--validator path.mjs|none] [--validator-extra a.json,b.mjs]
//        [--branch main] [--no-commit] [--dry-run] [--keep-extra] [-m "message"] [--game-root game/]
//
// From --src (default game/skills-data):  skills/*.json → skills/, lib/*.json → lib/,
//   SCHEMA.md (else the template placeholder), HOOKS.md / skill.schema.json / skill-lib.schema.json when present,
//   oracle/*.mjs (skill isolation 2026-11-22: the JS reference hooks + REF tables, test oracles — not in tools/engine).
// From the template (tools/skills-repo-template): README.md, .gitattributes, tools/manifest.mjs,
//   tools/check.mjs, tools/README.md.
// Tools are copied BYTE-IDENTICAL (LF) — never rewritten — because the validator pins its own
// sha256 and resolves the engine relative to itself (game/tools/.. = game/). Each file records its
// chaosD6 `source` path; tools/check.mjs rebuilds that layout in a temp dir and runs it there.
//   tools/engine/     the engine entries (default game/effect-engine.mjs + game/skills.mjs when it
//                     exists) + the transitive closure of their relative imports (game-relative paths;
//                     peer.mjs / main.js are never pulled in → pins.unresolved)
//   tools/validator/  the skills validator (default $CHAOSD6_SKILLS_VALIDATOR or the first of
//                     game/tools/{skills-rebalancing-check,skills-validator,skill-validator}.mjs), its
//                     calibration (<base>-calibration.json / <base minus -check>-calibration.json) and
//                     every file of its import closure that lives in its directory (rebalancing-core.mjs);
//                     the rest of its closure goes to tools/engine/
//   tools/pins.json   sha256 (UTF-8, CRLF→LF) + source of every tool file, npm packages imported,
//                     tools_sha256 = sha256(canonical { self, engine, validator })
//   validator/pin.json  the validator's own pin (its exported computePin()) when it has one, else a
//                     placeholder (only if missing)
// index.json: { skills, lib } id → sha256. Stale files in skills/, lib/, tools/engine/,
//   tools/validator/ are removed unless --keep-extra. Runs `git init -b main` if needed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSkillsManifest, assertSkillId } from '../skills-repo.mjs';
import { canonicalJson, sha256Hex } from '../defs-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, 'skills-repo-template');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const list = (s) => (s ? String(s).split(',').map(x => x.trim()).filter(Boolean).map(x => path.resolve(x)) : []);
// --game-root: the chaosD6 game/ dir the engine/validator paths are relative to (tests use a fake one)
const GAME = path.resolve(opt('--game-root', path.resolve(HERE, '..')));
const CHAOS_ROOT = path.dirname(GAME);
const TOOLS_DIR = path.join(GAME, 'tools');
const REPO = path.resolve(opt('--repo', process.env.CHAOSD6_SKILLS_REPO || '/home/galt/chaosd6-skills-repo'));
// Since the defs flip (2026-11-28) the REPO is the source of the definitions and game/skills-data is built from it
// (tools/defs-build.mjs): by default this tool reads the repo itself (only the tooling, pins + index.json change);
// the game copy is the source only when seeding a repo that has no skills/ yet.
const SRC = path.resolve(opt('--src', fs.existsSync(path.join(REPO, 'skills')) ? REPO : path.join(GAME, 'skills-data')));
const BRANCH = opt('--branch', 'main');
const DRY = flag('--dry-run');
const COMMIT = !flag('--no-commit') && !DRY;
const MSG = opt('-m', null);
const KEEP = flag('--keep-extra');

const ENGINE_ENTRIES = opt('--engine', null) ? list(opt('--engine'))
  : [path.join(GAME, 'effect-engine.mjs'), path.join(GAME, 'skills.mjs')].filter(f => fs.existsSync(f));
const VALIDATOR = (() => {
  const v = opt('--validator', process.env.CHAOSD6_SKILLS_VALIDATOR || null);
  if (v === 'none') return null;
  if (v) return path.resolve(v);
  return ['skills-rebalancing-check.mjs', 'skills-validator.mjs', 'skill-validator.mjs'].map(n => path.join(TOOLS_DIR, n)).find(f => fs.existsSync(f)) || null;
})();
const VALIDATOR_EXTRA = (() => {
  if (opt('--validator-extra', null) !== null) return list(opt('--validator-extra'));
  if (!VALIDATOR) return [];
  const base = path.basename(VALIDATOR, '.mjs');
  return [...new Set([`${base}-calibration.json`, `${base.replace(/-check$/, '')}-calibration.json`])]
    .map(n => path.join(path.dirname(VALIDATOR), n)).filter(f => fs.existsSync(f)).slice(0, 1);
})();
// never mirrored: the resolver and UI (they are the game, not the skill engine)
const DENY = new Set(['peer.mjs', 'main.js', 'js/main.js'].map(n => path.join(GAME, n)));

const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const lf = (s) => s.replace(/\r\n/g, '\n');
const readText = (f) => lf(fs.readFileSync(f, 'utf8'));
const posix = (p) => p.split(path.sep).join('/');
const changes = [];
const written = new Set();
function write(rel, content) {
  written.add(rel);
  const f = path.join(REPO, rel);
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  if (cur === content) return;
  changes.push(`${cur === null ? 'A' : 'M'} ${rel}`);
  if (DRY) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}
function prune(relDir, keepFn) {
  const d = path.join(REPO, relDir);
  if (KEEP || !fs.existsSync(d)) return;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name); const rel = posix(path.relative(REPO, p));
      if (e.isDirectory()) { walk(p); if (!DRY && !fs.readdirSync(p).length) fs.rmdirSync(p); }
      else if (!keepFn(rel)) { changes.push(`D ${rel}`); if (!DRY) fs.unlinkSync(p); }
    }
  };
  walk(d);
}

// 1. sources: definitions + libraries
function readDefs(dir, what) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    const def = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8').replace(/^﻿/, ''));
    assertSkillId(def?.id);
    if (`${def.id}.json` !== n) throw new Error(`${what} ${n}: id ${def.id} does not match the file name`);
    out.push(def);
  }
  return out;
}
if (!fs.existsSync(SRC)) console.warn(`(no source dir ${SRC} yet — repo skeleton + tools only)`);
const skills = readDefs(path.join(SRC, 'skills'), 'skill');
const libs = readDefs(path.join(SRC, 'lib'), 'lib');

// 2. tools: import closure of the engine entries and the validator
const IMPORT_RES = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  /\bimport\s+(['"])([^'"]+)\1/g,
];
/** Relative/bare specifiers of static + literal dynamic imports, ignoring whole-line comments. */
function specifiers(text) {
  const code = text.split('\n').map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n');
  const out = new Set();
  for (const re of IMPORT_RES) for (const m of code.matchAll(re)) out.add(m[2]);
  return [...out];
}
const packages = new Set(); const unresolved = [];
const closure = new Map();   // abs → true (in visit order)
function add(abs, from) {
  if (closure.has(abs)) return;
  if (DENY.has(abs)) { unresolved.push({ from, import: posix(path.relative(CHAOS_ROOT, abs)), reason: 'resolver/UI file, not mirrored' }); return; }
  if (!fs.existsSync(abs)) { unresolved.push({ from, import: posix(path.relative(CHAOS_ROOT, abs)), reason: 'missing' }); return; }
  closure.set(abs, true);
  if (!/\.m?js$/.test(abs)) return;
  for (const spec of specifiers(readText(abs))) {
    if (spec.startsWith('node:')) continue;
    if (!spec.startsWith('.') && !spec.startsWith('/')) { packages.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')); continue; }
    add(path.resolve(path.dirname(abs), spec), posix(path.relative(CHAOS_ROOT, abs)));
  }
}
for (const e of ENGINE_ENTRIES) add(e, '(engine entry)');
if (VALIDATOR) for (const f of [VALIDATOR, ...VALIDATOR_EXTRA]) {
  if (!fs.existsSync(f)) throw new Error(`validator file not found: ${f}`);
  add(f, '(validator)');
}
const VDIR = VALIDATOR ? path.dirname(VALIDATOR) : null;
const engineFiles = new Map(); const validatorFiles = new Map();   // abs → rel inside tools/engine | tools/validator
for (const abs of closure.keys()) {
  const src = posix(path.relative(CHAOS_ROOT, abs));
  if (src.startsWith('..')) throw new Error(`tool file outside the chaosD6 tree: ${abs}`);
  if (VDIR && path.dirname(abs) === VDIR) validatorFiles.set(abs, path.basename(abs));
  else engineFiles.set(abs, posix(path.relative(GAME, abs)).replace(/^(\.\.\/)+/, ''));
}

// 3. repo
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

// 4. files
const tpl = (rel) => readText(path.join(TEMPLATE, rel));
write('README.md', tpl('README.md'));
write('.gitattributes', tpl('.gitattributes'));
const self = {};
for (const rel of ['manifest.mjs', 'check.mjs', 'README.md']) {
  const t = tpl(`tools/${rel}`); write(`tools/${rel}`, t);
  self[rel] = { sha256: sha256Hex(t), source: posix(path.relative(CHAOS_ROOT, path.join(TEMPLATE, 'tools', rel))) };
}
const schemaSrc = path.join(SRC, 'SCHEMA.md');
write('SCHEMA.md', fs.existsSync(schemaSrc) ? readText(schemaSrc) : tpl('SCHEMA.md'));
for (const extra of ['HOOKS.md', 'skill.schema.json', 'skill-lib.schema.json']) {
  const f = path.join(SRC, extra);
  if (fs.existsSync(f)) write(extra, readText(f));
}
// skill isolation (2026-11-22): the JS reference hooks = TEST ORACLES (<src>/oracle/*.mjs), byte-identical (LF). Never
// part of the engine closure: skills.mjs only receives the oracle through installSkillOracle().
const ORACLE_DIR = path.join(SRC, 'oracle');
for (const n of fs.existsSync(ORACLE_DIR) ? fs.readdirSync(ORACLE_DIR).filter(n => n.endsWith('.mjs')).sort() : []) write(`oracle/${n}`, readText(path.join(ORACLE_DIR, n)));
for (const d of skills) write(`skills/${d.id}.json`, JSON.stringify(d, null, 2) + '\n');
for (const d of libs) write(`lib/${d.id}.json`, JSON.stringify(d, null, 2) + '\n');
for (const [sub, defs] of [['skills', skills], ['lib', libs]]) {
  if (!defs.length) write(`${sub}/.gitkeep`, '');
  else if (fs.existsSync(path.join(REPO, sub, '.gitkeep'))) { changes.push(`D ${sub}/.gitkeep`); if (!DRY) fs.unlinkSync(path.join(REPO, sub, '.gitkeep')); }
}
const mirror = (files, area) => {
  const recs = {};
  for (const [abs, rel] of [...files].sort((a, b) => (a[1] < b[1] ? -1 : 1))) {
    const t = readText(abs); write(`tools/${area}/${rel}`, t);
    recs[rel] = { sha256: sha256Hex(t), source: posix(path.relative(CHAOS_ROOT, abs)) };
  }
  return recs;
};
const engine = mirror(engineFiles, 'engine');
const validator = mirror(validatorFiles, 'validator');
const entryOf = (abs) => (engineFiles.has(abs) ? engineFiles.get(abs) : null);

// the validator's own pin (S5: computePin() over its source, core, calibration and engines)
let vpin = null;
if (VALIDATOR) {
  try { const m = await import(pathToFileURL(VALIDATOR).href); if (typeof m.computePin === 'function') vpin = await m.computePin(); }
  catch (e) { console.warn(`  (validator pin not computed: ${e.message})`); }
}
if (vpin) write('validator/pin.json', JSON.stringify(vpin, null, 2) + '\n');
else if (!fs.existsSync(path.join(REPO, 'validator', 'pin.json'))) write('validator/pin.json', tpl('validator/pin.json'));

const pins = {
  format: 'chaosd6-skills-tools/1',
  hash: 'sha256 of the UTF-8 file with CRLF -> LF',
  game_dir: posix(path.relative(CHAOS_ROOT, GAME)),
  layout: '`source` is the path in the chaosD6 tree; tools/check.mjs rebuilds that tree (plus lib/ → <game_dir>/skills-data/lib, skills/ → <game_dir>/skills-data/skills) in a temp dir',
  self: { files: self },
  engine: { entry: { effect_engine: entryOf(path.join(GAME, 'effect-engine.mjs')), skills: entryOf(path.join(GAME, 'skills.mjs')) }, files: engine },
  validator: { entry: VALIDATOR ? path.basename(VALIDATOR) : null, pin_id: vpin?.pin_id ?? null, files: validator },
  packages: [...packages].sort(),
  unresolved,
};
const shaMap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.sha256]));
pins.tools_sha256 = sha256Hex(canonicalJson({ self: shaMap(self), engine: shaMap(engine), validator: shaMap(validator) }));
write('tools/pins.json', JSON.stringify(pins, null, 2) + '\n');

prune('skills', (rel) => written.has(rel));
prune('lib', (rel) => written.has(rel));
prune('tools/engine', (rel) => written.has(rel));
prune('tools/validator', (rel) => written.has(rel));
prune('oracle', (rel) => written.has(rel));

// 5. manifest — over what is in the repo now (== sources unless --keep-extra)
const repoDefs = (sub, fallback) => (KEEP && fs.existsSync(path.join(REPO, sub))
  ? fs.readdirSync(path.join(REPO, sub)).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(REPO, sub, n), 'utf8')))
  : fallback);
const manifest = buildSkillsManifest(repoDefs('skills', skills), repoDefs('lib', libs));
write('index.json', JSON.stringify(manifest, null, 2) + '\n');

console.log(`${skills.length} skill(s), ${libs.length} lib(s) from ${SRC}`);
console.log(`tools: engine ${Object.keys(engine).join(', ') || '(none)'}; validator ${Object.keys(validator).join(', ') || '(none yet)'}${vpin ? ` (pin ${String(vpin.pin_id).slice(0, 12)})` : ''}; tools_sha256 ${pins.tools_sha256.slice(0, 12)}`);
if (pins.packages.length) console.log(`  npm packages imported by tools: ${pins.packages.join(', ')}`);
for (const u of unresolved) console.log(`  !! not mirrored: ${u.import} (from ${u.from}: ${u.reason})`);
for (const c of changes) console.log(`  ${c}`);
if (!changes.length) console.log('  (no changes)');

// 6. commit
if (COMMIT) {
  git('add', '-A');
  const staged = git('diff', '--cached', '--name-only');
  if (!staged) { console.log('nothing to commit'); }
  else {
    const msg = MSG || `Sync ${Object.keys(manifest.skills).length} skill(s), ${Object.keys(manifest.lib).length} lib(s), tools ${pins.tools_sha256.slice(0, 12)} from chaosD6`;
    execFileSync('git', ['-C', REPO, '-c', 'user.name=chaosd6-sync', '-c', 'user.email=sync@chaosd6', 'commit', '-q', '-m', msg]);
    console.log(`committed ${git('rev-parse', 'HEAD')} on ${BRANCH}`);
  }
}
if (DRY) console.log('(dry run: nothing written)');
