// Effect isolation F9: a data collection whose data/index.json entry names `definitions` (a repo-relative directory of
// definition files, e.g. game/effects-data/effects) is read from their `card` blocks — one canonical version per
// definition {version, data, rebalance_links, logic}, plus the entry's name / tags / resources — instead of its data
// file, which stays as a frozen record. No dependencies (peer.mjs, ui-server.mjs, mobile-menu.mjs, logic-engine.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const definitionsDirOf = (index, id) => (index?.collections || []).find(c => c.id === id)?.definitions || null;

// The definitions directory, from the repo layout (data/ beside game/) or a staged game/ copy (mobile bundle).
export function resolveDefinitionsDir(dataDir, def) {
  const tries = [path.resolve(dataDir, '..', def), path.resolve(HERE, '..', def), path.resolve(HERE, def.replace(/^game\//, ''))];
  return tries.find(d => fs.existsSync(d)) || null;
}

export function definitionsCollection(id, dir, source = dir) {
  const entries = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '')))
    .filter(d => d.card).sort((a, b) => a.id.localeCompare(b.id))
    .map(d => ({ id: d.id, name: d.card.name, tags: d.card.tags || [], ...(d.card.resources ? { resources: d.card.resources } : {}),
      versions: [{ version: d.version, status: 'canonical', weight: 1, data: d.card.data, ...(d.card.rebalance_links ? { rebalance_links: d.card.rebalance_links } : {}), ...(d.card.logic ? { logic: d.card.logic } : {}) }] }));
  return { collection: id, source, entries };
}

// HTTP helper: `/data/<file>` of a definitions collection → its JSON text (built from the definitions), else null
// (serve the file as usual). Rebuilt per request — definitions are small and the UI asks once per load.
export function definitionsCollectionText(dataDir, rel) {
  try {
    const file = String(rel || '').replace(/^\/+/, '');
    const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
    const c = (index.collections || []).find(x => x.file === file && x.definitions);
    const dir = c && resolveDefinitionsDir(dataDir, c.definitions);
    return dir ? JSON.stringify(definitionsCollection(c.id, dir, c.definitions)) : null;
  } catch { return null; }
}
