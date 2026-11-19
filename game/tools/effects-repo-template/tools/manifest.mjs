#!/usr/bin/env node
// chaosD6-Effects manifest generator: index.json = { format, hash, effects: { <id>: sha256 }[, hooks: { <family>: sha256 }][, libs: { <id>: sha256 }] }.
// `hooks` (the peer-side effect hook programs, hooks/<family>.json) appears only when hooks/ holds a .json file;
// `libs` (the libraries effects `use`, lib/<id>.json) only when lib/ holds a .json file.
// sha256 is taken over the CANONICAL JSON of each definition (keys sorted, no whitespace), so
// formatting and key order in effects/<id>.json never change an effect's identity.
// Standalone on purpose (no chaosD6 game code needed); must stay byte-identical in behaviour to
// canonicalJson/effectHash in chaosD6 game/effects-repo.mjs (effects-repo-check.mjs asserts it).
//
//   node tools/manifest.mjs            write index.json
//   node tools/manifest.mjs --check    exit 1 if index.json is stale (CI / before proposing)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function canonicalJson(value) {
  const out = (v, where) => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string': return JSON.stringify(v);
      case 'boolean': return v ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError(`non-finite number at ${where}`);
        return JSON.stringify(v);
      case 'object': {
        if (Array.isArray(v)) return `[${v.map((x, i) => out(x, `${where}[${i}]`)).join(',')}]`;
        const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${out(v[k], `${where}.${k}`)}`).join(',')}}`;
      }
      default: throw new TypeError(`unsupported ${typeof v} at ${where}`);
    }
  };
  return out(value, '$');
}
export const effectHash = (def) => createHash('sha256').update(canonicalJson(def), 'utf8').digest('hex');

function hashDir(dir, sub, problems) {
  const map = {};
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort() : [];
  for (const n of names) {
    let def;
    try { def = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (e) { problems.push(`${sub}/${n}: ${e.message}`); continue; }
    if (`${def?.id}.json` !== n) { problems.push(`${sub}/${n}: id ${JSON.stringify(def?.id)} does not match the file name`); continue; }
    map[def.id] = effectHash(def);
  }
  return { map, n: names.length };
}
export function manifestFor(root) {
  const problems = [];
  const effects = hashDir(path.join(root, 'effects'), 'effects', problems).map;
  const hooks = hashDir(path.join(root, 'hooks'), 'hooks', problems);
  const manifest = { format: 1, hash: 'sha256(canonical-json)', effects };
  if (hooks.n) manifest.hooks = hooks.map;
  const libs = hashDir(path.join(root, 'lib'), 'lib', problems);
  if (libs.n) manifest.libs = libs.map;
  // every effect's `uses` must name a lib of this commit (when the commit has lib/)
  if (libs.n) for (const n of Object.keys(effects)) {
    let def; try { def = JSON.parse(fs.readFileSync(path.join(root, 'effects', `${n}.json`), 'utf8')); } catch { continue; }
    for (const u of def.uses || []) if (!libs.map[u]) problems.push(`effects/${n}.json: uses lib ${u}, not in lib/`);
  }
  return { manifest, problems };
}
const counts = (m) => `${Object.keys(m.effects).length} effects${m.hooks ? `, ${Object.keys(m.hooks).length} hook files` : ''}${m.libs ? `, ${Object.keys(m.libs).length} libs` : ''}`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { manifest, problems } = manifestFor(root);
  for (const p of problems) console.error(`!! ${p}`);
  const txt = JSON.stringify(manifest, null, 2) + '\n';
  const file = path.join(root, 'index.json');
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur !== txt || problems.length) { console.error('index.json is stale — run: node tools/manifest.mjs'); process.exit(1); }
    console.log(`index.json ok (${counts(manifest)})`);
  } else {
    fs.writeFileSync(file, txt);
    console.log(`index.json: ${counts(manifest)}${problems.length ? `, ${problems.length} problem(s)` : ''}`);
    if (problems.length) process.exit(1);
  }
}
