// World-edit ledger (user ruling 2026-11-18): what players did to the map — Awake building / wall moves
// (`made:` + `moved:` vacated), Animator copies and Priest Shrines (`made:`), dungeon / school / building-trap
// state (`dng:`, `lrn:`, `wtrap:` …), pulled / relocated world features — is DIMENSION state, not the author's.
// "Since the action is done, if the Mover (or Animator) leaves, the synced nodes should preserve the new state;
// if no other node is available, when he rejoins he loads the state from his local saved dimension."
//
// Every unit publishes its own edits (`world_edits_json`, author = the unit) and a copy of every OTHER author's
// edits it has seen (`world_ledger_json`, each edit carries `by`). Readers merge all of it with ledgerUnits():
// one edit per (author, id), last writer wins by the edit's action clock `at`, then by its JSON text — the same
// bytes from the same snapshots on every peer. The result is the old per-author shape
// ([{ peer_id, world_edits_json }]), so every consumer (features.js placedBuildingsFrom, peer.mjs worldLens) keeps
// its own per-hex rule (placed buildings: replay by clock, then author id). An author who left is still there.
// Pure; shared by peer.mjs (resolution view, local ledger, autosave) and the browser (roster).

const parse = (s) => { if (Array.isArray(s)) return s; try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const newer = (a, b) => (a.at ?? 0) !== (b.at ?? 0) ? (a.at ?? 0) > (b.at ?? 0) : JSON.stringify(a) > JSON.stringify(b);

// units: [{ peer_id, world_edits_json?, world_ledger_json? }] → Map author → Map id → edit (with `by`).
export function mergeLedger(units) {
  const byAuthor = new Map();
  const put = (by, e) => {
    if (!by || !e || typeof e !== 'object' || typeof e.id !== 'string') return;
    const x = e.by === by ? e : { ...e, by };
    if (!byAuthor.has(by)) byAuthor.set(by, new Map());
    const m = byAuthor.get(by), cur = m.get(x.id);
    if (!cur || newer(x, cur)) m.set(x.id, x);
  };
  for (const u of units || []) {
    const pid = String(u?.peer_id || '');
    for (const e of parse(u?.world_edits_json)) put(pid, e);
    for (const e of parse(u?.world_ledger_json)) put(typeof e?.by === 'string' ? e.by : '', e);
  }
  return byAuthor;
}
const sortedEdits = (m) => [...m.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
// → [{ peer_id, world_edits_json }] per author (authors sorted), edits without `by` — the shape the readers take.
export function ledgerUnits(units) {
  const byAuthor = mergeLedger(units);
  return [...byAuthor.keys()].sort().map(by => ({ peer_id: by, world_edits_json: JSON.stringify(sortedEdits(byAuthor.get(by)).map(({ by: _b, ...e }) => e)) }));
}
// My ledger to publish / save: every author's edits but mine (mine travel in world_edits_json), each with `by`.
export function ledgerFor(units, me) {
  const byAuthor = mergeLedger(units);
  return [...byAuthor.keys()].sort().filter(by => by !== me).flatMap(by => sortedEdits(byAuthor.get(by)));
}
