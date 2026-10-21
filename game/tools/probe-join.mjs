// Dev probe: join a running dimension through a launcher's /api/launch, then
// tap the new peer's UI WebSocket and print contacts / damage / phase changes.
// Proves a joiner is actually engaged by the hosted peers.
//
//   node tools/probe-join.mjs [launcherUrl=http://127.0.0.1:7358] [seconds=40] [label=P-Probe]

const launcher = process.argv[2] || 'http://127.0.0.1:7358';
const seconds  = Number(process.argv[3] || 40);
const label    = process.argv[4] || 'P-Probe';

const r = await fetch(`${launcher}/api/launch`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'join', dimensionName: 'Ashfall-Micro', doorId: null, placement: 'nearby', side: 'player', characterId: 'char_oran_rief', label }),
});
const out = await r.json();
console.log('launch →', JSON.stringify(out));
if (!out.ok) process.exit(1);
await new Promise(res => setTimeout(res, 4000));

const ws = new WebSocket(`ws://127.0.0.1:${out.peerPort}/`);
const seen = {};
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  seen[m.kind] = (seen[m.kind] || 0) + 1;
  if (m.kind === 'contact') for (const c of m.contacts) console.log(`CONTACT d=${c.distance}: ${c.a.name}[${c.a.action}] × ${c.b.name}[${c.b.action}]`);
  if (m.kind === 'evt' && m.env.type === 'evt_state_hash') for (const d of (m.env.payload.damage_applied || [])) console.log(`DMG ${d.amount} → ${d.target} (from ${d.source || '?'})`);
  if (m.kind === 'phase' && m.name === 'planning') console.log(`planning turn ${m.turn} round ${m.round}`);
  if (m.kind === 'standoff') console.log('STANDOFF', m.winner);
};
setTimeout(async () => {
  console.log('message kinds:', JSON.stringify(seen));
  const s = await fetch(`http://127.0.0.1:${out.peerPort}/status`).then(r => r.json());
  console.log(`me: ${s.entity.name} hp ${s.entity.life}/${s.entity.lifeMax} tile (${s.entity.tile.q},${s.entity.tile.r}) action ${s.action}`);
  for (const p of s.peers) console.log(`  ${p.peer_id.padEnd(16)} hp ${p.life} tile (${p.tile_q},${p.tile_r}) action ${p.action}`);
  process.exit(0);
}, seconds * 1000);
