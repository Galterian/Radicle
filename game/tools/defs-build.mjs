#!/usr/bin/env node
// Build the game's copies of the definitions FROM their repos (user 2026-11-28: one source of truth, as GameModels →
// assets/gamemodels/catalog.json). chaosD6-Effects / -Skills / -Classes are the source; game/effects-data,
// game/skills-data and game/classes-data are GENERATED here — never edit them by hand. They stay committed in the game
// repo because every peer must run byte-identical built-ins offline (state hash), the APK ships them and CI checks out
// the game repo only. game/defs-pins.json records the repo commit each copy was built from.
//
//   node tools/defs-build.mjs [effects|skills|classes|all] [--check] [--prune] [--repo-effects DIR] [--repo-skills DIR] [--repo-classes DIR]
//
// Copied: every repo file except the repo's own tooling (.git*, README.md, index.json, package*.json, node_modules,
// tools/, validator/, data/) — definitions, hooks, lib, oracle/*.mjs, SCHEMA / HOOKS / HANDSHAKE docs, *.schema.json —
// byte-identical (LF). A game file with no repo counterpart stops the build (move it into the repo first) unless --prune.
// Repo: --repo-<kind> | $CHAOSD6_<KIND>_REPO | ../../chaosd6-<kind>-repo | ../../../chaosd6-<kind>-repo.
// --check: the game copy must equal its pin (edited by hand → FAIL) and, when the repo is here, the repo (stale → FAIL);
// built from uncommitted repo changes → WARN (commit + publish in the repo, then rebuild). Works without the repos (CI).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const PINS = path.join(GAME, 'defs-pins.json');
export const DEF_KINDS = {
  effects: { dir: 'effects-data', repo: 'chaosd6-effects-repo', name: 'chaosD6-Effects', env: 'CHAOSD6_EFFECTS_REPO', marker: 'effects' },
  skills: { dir: 'skills-data', repo: 'chaosd6-skills-repo', name: 'chaosD6-Skills', env: 'CHAOSD6_SKILLS_REPO', marker: 'skills' },
  classes: { dir: 'classes-data', repo: 'chaosd6-classes-repo', name: 'chaosD6-Classes', env: 'CHAOSD6_CLASSES_REPO', marker: 'classes' },
};
const REPO_ONLY = new Set(['.git', '.gitattributes', '.gitignore', 'README.md', 'index.json', 'package.json', 'package-lock.json', 'node_modules', 'tools', 'validator', 'data']);

const lf = (b) => b.toString('utf8').replace(/\r\n/g, '\n');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
/** Files of a definitions tree, posix-relative, sorted; `top` filters the repo's own tooling at the top level. */
function listFiles(root, top = false) {
  const out = [];
  const walk = (rel) => {
    for (const n of fs.readdirSync(path.join(root, rel)).sort()) {
      if (!rel && top && REPO_ONLY.has(n)) continue;
      if (n === '.git' || n === 'node_modules') continue;
      const r = rel ? `${rel}/${n}` : n;
      if (fs.statSync(path.join(root, r)).isDirectory()) walk(r); else out.push(r);
    }
  };
  if (fs.existsSync(root)) walk('');
  return out;
}
/** sha256 over [file, sha256(LF text)] of the tree — the identity the pin and --check compare. */
export function treeHash(root, files) {
  return sha(JSON.stringify(files.map(f => [f, sha(lf(fs.readFileSync(path.join(root, f))))])));
}
export function resolveDefsRepo(kind, argv = [], env = process.env) {
  const k = DEF_KINDS[kind];
  const i = argv.indexOf(`--repo-${kind}`);
  const cands = [i >= 0 ? argv[i + 1] : null, env[k.env], path.resolve(GAME, '..', '..', k.repo), path.resolve(GAME, '..', '..', '..', k.repo)].filter(Boolean);
  return cands.map(c => path.resolve(c)).find(c => fs.existsSync(path.join(c, k.marker))) || null;
}
const git = (repo, ...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const readPins = () => { try { return JSON.parse(fs.readFileSync(PINS, 'utf8')); } catch { return { format: 'chaosd6-defs-pins/1' }; } };

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const CHECK = argv.includes('--check'), PRUNE = argv.includes('--prune');
  const which = argv.find(a => DEF_KINDS[a]) || 'all';
  const kinds = which === 'all' ? Object.keys(DEF_KINDS) : [which];
  const pins = readPins();
  let fails = 0, warns = 0;
  for (const kind of kinds) {
    const k = DEF_KINDS[kind], gameDir = path.join(GAME, k.dir);
    const repo = resolveDefsRepo(kind, argv);
    const gameFiles = listFiles(gameDir);
    if (CHECK) {
      const pin = pins[kind];
      const gHash = treeHash(gameDir, gameFiles);
      if (!pin) { console.log(`FAIL ${kind}: no pin in defs-pins.json — run node tools/defs-build.mjs ${kind}`); fails++; continue; }
      if (gHash !== pin.tree_sha256) { console.log(`FAIL ${kind}: game/${k.dir} was edited by hand (≠ its pin) — edit in ${k.name}, then node tools/defs-build.mjs ${kind}`); fails++; continue; }
      if (repo) {
        const rf = listFiles(repo, true);
        if (treeHash(repo, rf) !== gHash) { console.log(`FAIL ${kind}: game/${k.dir} is stale against ${repo} — run node tools/defs-build.mjs ${kind}`); fails++; continue; }
      }
      if (pin.dirty) { console.log(`WARN ${kind}: built from uncommitted ${k.name} changes — commit + publish them in the repo, then rebuild`); warns++; }
      console.log(`ok   ${kind}: ${gameFiles.length} files = pin ${pin.commit ? pin.commit.slice(0, 7) : '?'}${pin.dirty ? '+dirty' : ''}${repo ? ' = repo' : ' (repo not here — pin only)'}`);
      continue;
    }
    if (!repo) { console.log(`FAIL ${kind}: no ${k.name} checkout (--repo-${kind} / $${k.env} / ${k.repo} next to chaosD6)`); fails++; continue; }
    const files = listFiles(repo, true);
    const extra = gameFiles.filter(f => !files.includes(f));
    if (extra.length && !PRUNE) { console.log(`FAIL ${kind}: game/${k.dir} has files ${repo} lacks — move them into the repo first (or --prune):\n  ${extra.join('\n  ')}`); fails++; continue; }
    let wrote = 0;
    for (const f of files) {
      const src = lf(fs.readFileSync(path.join(repo, f))), dst = path.join(gameDir, f);
      if (fs.existsSync(dst) && fs.readFileSync(dst, 'utf8') === src) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, src);
      wrote++;
    }
    for (const f of extra) fs.unlinkSync(path.join(gameDir, f));
    const commit = git(repo, 'rev-parse', 'HEAD');
    const dirty = !!git(repo, 'status', '--porcelain', '--', ...files.map(f => f.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i));
    const rid = (git(repo, 'remote', 'get-url', 'rad').match(/rad:\/\/(z[1-9A-HJ-NP-Za-km-z]+)/) || [])[1] || null;
    pins[kind] = { repo: k.name, rid, commit: commit || null, dirty, files: files.length, tree_sha256: treeHash(gameDir, files) };
    console.log(`${kind}: ${files.length} files from ${repo} @ ${commit.slice(0, 7)}${dirty ? ' (+ uncommitted changes)' : ''} — ${wrote} written, ${extra.length} removed`);
  }
  if (!CHECK && !fails) fs.writeFileSync(PINS, JSON.stringify({ format: 'chaosd6-defs-pins/1', note: 'written by tools/defs-build.mjs — the repo commit each game/*-data copy was built from', ...Object.fromEntries(Object.keys(DEF_KINDS).filter(k => pins[k]).map(k => [k, pins[k]])) }, null, 2) + '\n');
  if (CHECK) console.log(fails ? `${fails} defs check(s) FAILED` : `all defs checks passed${warns ? ` (${warns} warning(s))` : ''}`);
  process.exit(fails ? 1 : 0);
}
