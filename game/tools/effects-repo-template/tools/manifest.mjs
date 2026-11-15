#!/usr/bin/env node
// chaosD6-Effects manifest generator: index.json = { format, hash, effects: { <id>: sha256 } }.
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

export function manifestFor(root) {
  const dir = path.join(root, 'effects');
  const effects = {}; const problems = [];
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort() : [];
  for (const n of names) {
    let def;
    try { def = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (e) { problems.push(`${n}: ${e.message}`); continue; }
    if (`${def?.id}.json` !== n) { problems.push(`${n}: id ${JSON.stringify(def?.id)} does not match the file name`); continue; }
    effects[def.id] = effectHash(def);
  }
  return { manifest: { format: 1, hash: 'sha256(canonical-json)', effects }, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { manifest, problems } = manifestFor(root);
  for (const p of problems) console.error(`!! ${p}`);
  const txt = JSON.stringify(manifest, null, 2) + '\n';
  const file = path.join(root, 'index.json');
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur !== txt || problems.length) { console.error('index.json is stale — run: node tools/manifest.mjs'); process.exit(1); }
    console.log(`index.json ok (${Object.keys(manifest.effects).length} effects)`);
  } else {
    fs.writeFileSync(file, txt);
    console.log(`index.json: ${Object.keys(manifest.effects).length} effects${problems.length ? `, ${problems.length} problem(s)` : ''}`);
    if (problems.length) process.exit(1);
  }
}
