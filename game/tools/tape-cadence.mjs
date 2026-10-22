// Dev helper: round cadence from a dimension's hashgraph tape. For each action
// (turn*ROUNDS_PER_TURN+round) print when each peer committed, relative to the
// first commit of that action, and who never committed — shows drift, who
// lags, and how far the clock races.
//   node tools/tape-cadence.mjs <DimName> [fromAction] [toAction] [roundsPerTurn=3]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const [dim, fromA = '0', toA = '9999', rpt = '3'] = process.argv.slice(2);
if (!dim) { console.error('usage: node tools/tape-cadence.mjs <DimName> [from] [to]'); process.exit(2); }
const lines = fs.readFileSync(path.join(here, '..', 'sessions', dim, 'hashgraph.jsonl'), 'utf8').split('\n').filter(Boolean);
const byAction = new Map();
const peers = new Set();
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  if (e.type !== 'evt_action_commit' && e.type !== 'evt_action_reveal' && e.type !== 'evt_state_hash') continue;
  const a = e.turn * Number(rpt) + e.round;
  if (a < Number(fromA) || a > Number(toA)) continue;
  peers.add(e.actor_peer_id);
  if (!byAction.has(a)) byAction.set(a, new Map());
  const m = byAction.get(a);
  const k = e.actor_peer_id;
  const rec = m.get(k) || {};
  const t = Date.parse(e.timestamp);
  if (e.type === 'evt_action_commit' && !rec.commit) rec.commit = t;
  if (e.type === 'evt_action_reveal' && !rec.reveal) rec.reveal = t;
  if (e.type === 'evt_state_hash' && !rec.hash) rec.hash = e.payload?.state_hash?.slice(0, 8);
  m.set(k, rec);
}
const ids = [...peers].sort();
let prevFirst = null;
console.log('action  Δprev  ' + ids.map(i => i.replace('peer:', '').padEnd(10)).join(' ') + '  hashes');
for (const a of [...byAction.keys()].sort((x, y) => x - y)) {
  const m = byAction.get(a);
  const first = Math.min(...[...m.values()].map(r => r.commit ?? Infinity));
  const cells = ids.map(i => { const r = m.get(i); if (!r || !r.commit) return (r?.reveal ? 'rev-only' : '   —    ').padEnd(10); return (`+${((r.commit - first) / 1000).toFixed(1)}s`).padEnd(10); });
  const hashes = [...new Set([...m.values()].map(r => r.hash).filter(Boolean))];
  console.log(`${String(a).padStart(6)}  ${prevFirst && Number.isFinite(first) ? ((first - prevFirst) / 1000).toFixed(1).padStart(4) + 's' : '     '}  ${cells.join(' ')}  ${hashes.length > 1 ? 'SPLIT ' : ''}${hashes.join('|')}`);
  if (Number.isFinite(first)) prevFirst = first;
}
