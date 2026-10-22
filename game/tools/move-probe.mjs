// Dev probe: drive a peer's hero through its UI socket — stage an Empty Move
// toward (q,r) on each planning phase for a while — and print every `map`
// update the peer sends. Proves "move → reveal → map grows".
//
//   node tools/move-probe.mjs [peerPort=7401] [q=-3] [r=2] [seconds=40]
const port = Number(process.argv[2] || 7401);
const q = Number(process.argv[3] ?? -3), r = Number(process.argv[4] ?? 2);
const seconds = Number(process.argv[5] || 40);
const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
const send = o => ws.send(JSON.stringify(o));
let me = null, tile = null;
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.kind === 'hello') { me = m.peer_id; tile = m.entity?.tile; console.log(`hello ${me} at (${tile?.q},${tile?.r}) map ${m.map?.tiles} hexes / ${m.map?.blocks?.length} blocks`); }
  if (m.kind === 'map') console.log(`MAP ${m.map.tiles} hexes / ${m.map.blocks.length} blocks bounds ${JSON.stringify(m.map.bounds)}`);
  if (m.kind === 'peers') { const p = (m.peers || []).find(p => p.peer_id === me); if (p && (p.tile_q !== tile?.q || p.tile_r !== tile?.r)) { tile = { q: p.tile_q, r: p.tile_r }; console.log(`moved → (${tile.q},${tile.r})`); } }
  if (m.kind === 'phase' && m.name === 'planning') {
    if (tile && tile.q === q && tile.r === r) return console.log('arrived');
    send({ kind: 'queue', slots: ['EMPTY'] });
    send({ kind: 'target', target: { q, r } });
    send({ kind: 'lock' });
    console.log(`T${m.turn}.${m.round}: EM → (${q},${r})`);
  }
};
setTimeout(() => process.exit(0), seconds * 1000);
