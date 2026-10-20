// Loads the chaosD6 /data layer and resolves the active version of each entry
// (highest-weight non-rejected VersionedEntry; schema.json entry_contract).

const COLLECTIONS = [
  'stats', 'elements', 'battle_system', 'actions', 'effects', 'skills',
  'characters', 'creatures', 'game_modes',
  'sync_protocol', 'hashgraph_events', 'dimension_session'
];

async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`fetch ${path} ${r.status}`);
  return r.json();
}

function pickActive(entry) {
  const live = entry.versions.filter(v => v.status !== 'rejected' && v.status !== 'superseded');
  live.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const v = live[0] ?? entry.versions[0];
  return { id: entry.id, name: entry.name, tags: entry.tags ?? [], version: v.version, weight: v.weight, data: v.data };
}

function indexByFlat(flatList) {
  const out = {};
  for (const e of flatList) out[e.id] = e;
  return out;
}

export async function loadDataLayer() {
  const index = await fetchJson('/data/index.json');
  const out = { index, raw: {}, active: {}, byId: {} };
  for (const name of COLLECTIONS) {
    const file = await fetchJson(`/data/${name}.json`);
    out.raw[name] = file;
    out.active[name] = file.entries.map(pickActive);
    out.byId[name] = indexByFlat(out.active[name]);
  }
  return out;
}
