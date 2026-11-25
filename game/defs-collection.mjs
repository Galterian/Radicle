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
      versions: [{ version: d.card.version || d.version, status: 'canonical', weight: 1, data: d.card.data, ...(d.card.rebalance_links ? { rebalance_links: d.card.rebalance_links } : {}), ...(d.card.logic ? { logic: d.card.logic } : {}) }] }));
  return { collection: id, source, entries };
}

// Split A (2026-11-25): a collection whose index entry names `catalog` (creatures: "gamemodels/catalog.json",
// catalog_key "creatures") is read from the compiled chaosD6-GameModels catalog (tools/gamemodels-build.mjs) — the
// monster/2 cards; its data file stays as a frozen record. The catalog file is the one the peers read (peer.mjs
// GAMEMODELS): env GAMEMODELS_CATALOG_FILE (a test game's own) first, then assets/ beside data/, beside game/, the
// CHAOSD6_ASSETS_DIR (phone). A catalog without that key → null (the caller falls back to the data file).
export const catalogSourceOf = (index, id) => { const c = (index?.collections || []).find(x => x.id === id); return c?.catalog ? { file: c.catalog, key: c.catalog_key || id } : null; };
// Where a collection is authored when not in its data file (definitions dir | "catalog#key"), else null: logic-apply
// skips it, rebalance / editor-api proposals refuse it.
export const authoredElsewhere = (index, id) => definitionsDirOf(index, id) || ((s) => s && `${s.file}#${s.key}`)(catalogSourceOf(index, id));
export function resolveCatalogFile(dataDir, rel, env = process.env) {
  const tries = [...(env.GAMEMODELS_CATALOG_FILE ? [env.GAMEMODELS_CATALOG_FILE] : []), path.resolve(dataDir, '..', 'assets', rel), path.resolve(HERE, '..', 'assets', rel),
    ...(env.CHAOSD6_ASSETS_DIR ? [path.resolve(env.CHAOSD6_ASSETS_DIR, rel)] : [])];
  return tries.find(f => fs.existsSync(f)) || null;
}
export function catalogCollection(id, file, key) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'))?.[key];
  return c && Array.isArray(c.entries) ? { ...c, collection: id } : null;
}
// Any collection as its JSON: definitions | catalog | its data file (also the fallback when the source is missing).
export function readCollection(dataDir, id, index = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'))) {
  const def = definitionsDirOf(index, id), dir = def && resolveDefinitionsDir(dataDir, def);
  if (dir) return definitionsCollection(id, dir, def);
  const cs = catalogSourceOf(index, id), cf = cs && resolveCatalogFile(dataDir, cs.file);
  const fromCat = cf && catalogCollection(id, cf, cs.key);
  if (fromCat) return fromCat;
  const file = (index.collections || []).find(x => x.id === id)?.file || `${id}.json`;
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
}

// HTTP helper: `/data/<file>` of a definitions / catalog collection → its JSON text (built from the definitions or
// read from the catalog), else null (serve the file as usual). Rebuilt per request — the UI asks once per load.
export function definitionsCollectionText(dataDir, rel) {
  try {
    const file = String(rel || '').replace(/^\/+/, '');
    const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
    const c = (index.collections || []).find(x => x.file === file && (x.definitions || x.catalog));
    if (!c) return null;
    if (c.definitions) { const dir = resolveDefinitionsDir(dataDir, c.definitions); return dir ? JSON.stringify(definitionsCollection(c.id, dir, c.definitions)) : null; }
    const cf = resolveCatalogFile(dataDir, c.catalog), cc = cf && catalogCollection(c.id, cf, c.catalog_key || c.id);
    return cc ? JSON.stringify(cc) : null;
  } catch { return null; }
}
