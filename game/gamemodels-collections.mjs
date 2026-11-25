// The chaosD6-GameModels definitions as read-only editor collections (b9 2026-11-25, user: "chaosD6 should process the
// GameModels races, monsters, npcs, … in a generic way"). One collection per KINDS entry of gamemodels.mjs — whatever
// kinds the repo grows, they show up — each definition as a VersionedEntry with one canonical version whose `data` is
// the whole definition. Source: the GameModels checkout when this node has one (the full definitions), else the
// compiled catalog (the phone: the compiled subset). The editor changes them only through #/gen/ drafts (gen.js).
//   GET /rules/gamemodels/index.json      → { available, source, collections: [{ id, label, kind, file, url, entries, purpose, catalog }] }
//   GET /rules/gamemodels/<folder>.json   → { collection, source, entries }
import fs from 'node:fs';
import path from 'node:path';
import { GAMEMODELS_DIR, KINDS, CATALOG_REL, loadGameModels } from './gamemodels.mjs';
import { resolveCatalogFile } from './defs-collection.mjs';

const LABELS = { race: 'Races', building: 'Buildings', npc: 'NPCs', monster: 'Monsters', village: 'Villages', quest: 'Quests', lib: 'Agenda library' };
const PURPOSE = 'chaosD6-GameModels; ';

// { kind: { id: def } } + where it came from, or null when this node has neither the repo nor the catalog.
function source(dataDir, { dir = GAMEMODELS_DIR } = {}) {
  if (dir) { try { return { from: 'repo', where: dir, defs: loadGameModels(dir) }; } catch { /* fall through to the catalog */ } }
  const f = resolveCatalogFile(dataDir, CATALOG_REL);
  if (!f) return null;
  const cat = JSON.parse(fs.readFileSync(f, 'utf8'));
  const defs = Object.fromEntries(Object.entries(KINDS).map(([kind, [sub]]) => [kind, Object.fromEntries(Object.entries(cat[sub] && typeof cat[sub] === 'object' && !Array.isArray(cat[sub].entries) ? cat[sub] : {})
    .filter(([, v]) => v && typeof v === 'object').map(([id, v]) => [id, { id, ...v }]))]));
  return { from: 'catalog', where: f, defs };
}

// A village template has no name of its own (its team is "{name} Village", the name rolled per map): the editor calls
// it after its race — vil_barbarians "Barbarian Village", vil_barbarians_hamlet "Barbarian Hamlet" (user 2026-11-25).
const singular = (name) => String(name).replace(/ves$/, 'f').replace(/s$/, '');
export function villageName(def, races = {}) {
  const race = races[def.race];
  const who = singular(race?.name || String(def.race || def.id).replace(/^(race|vil)_/, '').replace(/_hamlet$/, '').split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' '));
  return `${who} ${def.size === 'hamlet' ? 'Hamlet' : 'Village'}`;
}

const entryOf = (def, kind, defs) => {
  const res = def.card?.resources || def.resources || null;
  const tags = [...new Set([def.race, def.role, def.size, ...(def.card?.tags || def.tags || [])].filter(t => typeof t === 'string' && t))];
  const name = def.name || def.card?.name || (kind === 'village' ? villageName(def, defs?.race) : def.id);
  return { id: def.id, name, tags, ...(res ? { resources: res } : {}),
    versions: [{ version: def.version || def.card?.version || '1.0.0', status: 'canonical', weight: 1, data: def }] };
};

export function gameModelsIndex(dataDir, o = {}) {
  const s = source(dataDir, o);
  if (!s) return { available: false, source: null, collections: [] };
  const collections = Object.entries(KINDS).map(([kind, [sub]]) => ({
    id: `gm_${sub}`, label: LABELS[kind] || sub, kind, file: `gamemodels/${sub}.json`, url: `gamemodels/${sub}.json`,
    entries: Object.keys(s.defs[kind] || {}).length, catalog: `chaosD6-GameModels ${sub}/`,
    purpose: `${PURPOSE}${sub}/<id>.json (${s.from === 'repo' ? 'the GameModels checkout' : 'the compiled catalog'}) — change one with ✦ Drafts`,
  })).filter(c => c.entries);
  return { available: true, source: s.from, collections };
}

export function gameModelsCollection(dataDir, folder, o = {}) {
  const kind = Object.keys(KINDS).find(k => KINDS[k][0] === folder);
  const s = kind && source(dataDir, o);
  if (!s) return null;
  const entries = Object.values(s.defs[kind] || {}).filter(d => d?.id).sort((a, b) => a.id.localeCompare(b.id)).map(d => entryOf(d, kind, s.defs));
  return { collection: `gm_${folder}`, source: `chaosD6-GameModels ${folder}/ (${s.from === 'repo' ? path.basename(s.where) : 'compiled catalog'})`, entries };
}
