// Radicle-shim: writes session artefacts to the Node dev server, which persists
// them under game/sessions/<DimensionName>/ matching dimension_session.json shapes.
// In the real engine, these writes become Radicle branch commits on
// ActiveDimensions/<DimensionName>/.

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

export function writeArtefact(relPath, obj) {
  const content = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return post('/api/session/write', { path: relPath, content });
}

export function appendLine(relPath, obj) {
  const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return post('/api/session/append', { path: relPath, line });
}

export const sessionPaths = {
  dimension: (name) => `${name}/dimension.json`,
  door: (name, doorId) => `${name}/doors/${doorId}.json`,
  rulesSnapshot: (name) => `${name}/rules_snapshot_commit`,
  hashgraph: (name) => `${name}/hashgraph.jsonl`,
};
