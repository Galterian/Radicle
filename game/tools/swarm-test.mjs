// Swarm test: host a fresh dimension through a launcher, join extra players and
// monsters until there are 5 players + 4 monsters (+ the roster ally), drive
// every player with an autonomous agent for a while, and audit consistency:
// does every peer agree on where everyone is, how much life they have, and
// how big the map is — and did any peer log a STATE DIVERGENCE?
//
//   node tools/swarm-test.mjs [launcherUrl=http://127.0.0.1:7357] [minutes=4] [dimension=Swarm-<hhmm>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnownMap, initialBlock } from '../js/map.js';
import { hexDistance } from '../js/hex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = process.argv[2] || 'http://127.0.0.1:7357';
// Optional second launcher (identity B, separate clone — tools/start-b.sh). One
// player joins through it, which exercises Doors read across namespaces and
// the joiner map seeding from another clone.
const launcherC = process.env.LAUNCHER_C || '';
const minutes = Number(process.argv[3] || 4);
const now = new Date();
const DIM = process.argv[4] || `Swarm-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(route, body, base = launcher) {
  const r = await fetch(`${base}${route}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return r.json();
}
async function status(port) {
  try { return await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()); } catch { return null; }
}

// ---- 3. agents ----
// Agents start the moment their peer is up (a player left idle for two minutes
// while the others join just gets eaten by the monsters at spawn).
const agents = [];
function startAgent(peerId, port, attempt = 0) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const a = { peerId, port, ws, map: createKnownMap('0x0', [initialBlock()]), peers: new Map(), me: null, hand: [], rounds: 0, attacks: 0, moves: 0, dest: null };
  const send = o => { try { ws.send(JSON.stringify(o)); } catch {} };
  ws.onclose = () => { if (!a.me && attempt < 10) setTimeout(() => startAgent(peerId, port, attempt + 1), 2000); };
  const plan = (turn, round) => {
    const me = a.peers.get(peerId);
    if (!me || (me.life ?? 1) <= 0) return;
    const enemies = [...a.peers.values()].filter(p => p.peer_id !== peerId && p.alliance === 'npc_b' && p.life > 0 && Number.isInteger(p.tile_q));
    const dist = p => hexDistance({ q: me.tile_q, r: me.tile_r }, { q: p.tile_q, r: p.tile_r });
    enemies.sort((x, y) => dist(x) - dist(y));
    const near = enemies[0];
    const slotOf = code => a.hand.findIndex(c => c && c.code === code);
    if (near && dist(near) <= 1 && Math.random() < 0.75) {
      const s = slotOf('A') >= 0 ? slotOf('A') : slotOf('B');
      if (s >= 0) { send({ kind: 'queue', slots: [s] }); send({ kind: 'target', target: near.peer_id }); send({ kind: 'lock' }); a.attacks++; return; }
    }
    // Otherwise wander: keep a destination for a few rounds, pick a new known
    // tile 3–9 hexes away when we arrive or have none (far ones force reveals).
    if (!a.dest || (a.dest.q === me.tile_q && a.dest.r === me.tile_r) || Math.random() < 0.15) {
      const cands = [...a.map.tiles()].filter(t => { const d = hexDistance({ q: me.tile_q, r: me.tile_r }, t); return d >= 3 && d <= 9; });
      a.dest = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
    }
    if (near && dist(near) <= 4 && Math.random() < 0.5) a.dest = { q: near.tile_q, r: near.tile_r };
    if (!a.dest) return;
    send({ kind: 'queue', slots: ['EMPTY'] });
    send({ kind: 'target', target: { q: a.dest.q, r: a.dest.r } });
    send({ kind: 'lock' });
    a.moves++;
  };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.kind === 'hello') { a.me = m.peer_id; a.hand = m.hand || []; if (m.map) { a.map = createKnownMap(m.map.seed, [initialBlock()]); a.map.addBlocks(m.map.blocks); } for (const p of m.peers || []) a.peers.set(p.peer_id, p); log(`  ${peerId} hello: map ${a.map.size()} hexes / ${a.map.blockCount()} blocks`); }
    if (m.kind === 'map') { if (m.map.seed !== a.map.seed) a.map = createKnownMap(m.map.seed, [initialBlock()]); a.map.addBlocks(m.map.blocks); }
    if (m.kind === 'hand') a.hand = m.hand || a.hand;
    if (m.kind === 'peers') for (const p of m.peers || []) a.peers.set(p.peer_id, { ...(a.peers.get(p.peer_id) || {}), ...p });
    if (m.kind === 'phase' && m.name === 'planning') { a.rounds++; setTimeout(() => plan(m.turn, m.round), 300 + Math.random() * 1500); }
  };
  ws.onerror = () => {};
  const idx = agents.findIndex(x => x.peerId === peerId);
  if (idx >= 0) agents[idx] = a; else agents.push(a);
}

// ---- 1. host ----
const host = await api('/api/launch', { mode: 'host', dimensionName: DIM });
if (!host.ok) { console.error('host failed', host); process.exit(1); }
log(`hosted ${DIM}: player-1 on :${host.peerPort}`);
const ports = new Map([['peer:player-1', host.peerPort], ['peer:ally-1', host.peerPort + 1], ['peer:foe-1', host.peerPort + 2], ['peer:foe-2', host.peerPort + 3]]);
await sleep(3000);
startAgent('peer:player-1', host.peerPort);

// ---- 2. wait until the Doors are on Radicle, then join the rest ----
for (let i = 0; i < 40; i++) {
  const d = await api('/api/dimensions');
  const mine = (d.items || []).find(x => x.dimension_name === DIM);
  if (mine && mine.doors?.length >= 1) { log(`Doors published (${mine.doors.length})`); break; }
  await sleep(5000);
}
const joins = [
  { label: 'P-Agent2', side: 'player', characterId: 'char_oran_rief' },
  { label: 'P-Agent3', side: 'player', characterId: 'char_cynder_pyromancer' },
  { label: 'P-Agent4', side: 'player', characterId: 'char_rhox_bodyguard' },
  { label: 'P-Agent5', side: 'player', characterId: 'char_godtracker_jund' },
  { label: 'M-Foe3',   side: 'npc_b',  creatureId: 'mon_hellkite_hatchling' },
  { label: 'M-Foe4',   side: 'npc_b',  creatureId: 'mon_tangle_spider_2b' },
];
for (const j of joins) {
  let base = launcher;
  if (launcherC && j.label === 'P-Agent5') {
    // The other identity only sees the dimension once the seeds have replicated our Doors.
    for (let i = 0; i < 24; i++) {
      const d = await api('/api/dimensions', null, launcherC).catch(() => ({}));
      if ((d.items || []).some(x => x.dimension_name === DIM && x.doors?.length)) { base = launcherC; break; }
      await sleep(5000);
    }
    log(base === launcherC ? `launcher C sees ${DIM} — joining ${j.label} through it` : `launcher C never saw ${DIM}; joining ${j.label} through A`);
  }
  const out = await api('/api/launch', { mode: 'join', dimensionName: DIM, doorId: null, placement: j.side === 'npc_b' ? 'random' : 'nearby', ...j, entityName: j.label }, base);
  if (!out.ok) { console.error('join failed', j.label, out.error); continue; }
  ports.set(`peer:${j.label}`, out.peerPort);
  log(`joined ${j.label} (${j.side}) at (${out.startTile.q},${out.startTile.r}) on :${out.peerPort}${base === launcherC ? ' via launcher C' : ''}`);
  await sleep(1500);
  if (j.side === 'player') startAgent(`peer:${j.label}`, out.peerPort);
}
log(`agents driving: ${agents.map(a => a.peerId).join(', ')}`);

// ---- 4. audit ----
async function audit(label) {
  const snaps = new Map();
  for (const [id, port] of ports) { const s = await status(port); if (s) snaps.set(id, s); }
  let mismatches = [], mapSizes = new Map(), alive = 0, regions = [];
  for (const [id, s] of snaps) {
    mapSizes.set(id, s.map?.tiles);
    regions.push(s.region?.strong?.length ?? '?');
    if (s.entity.life > 0) alive++;
    for (const [oid, os] of snaps) {
      if (oid === id) continue;
      const v = (os.peers || []).find(p => p.peer_id === id);
      if (!v) { mismatches.push(`${oid} has no entry for ${id}`); continue; }
      if (v.tile_q !== s.entity.tile.q || v.tile_r !== s.entity.tile.r || v.life !== s.entity.life)
        mismatches.push(`${oid} sees ${id} at (${v.tile_q},${v.tile_r}) hp${v.life}, truth (${s.entity.tile.q},${s.entity.tile.r}) hp${s.entity.life}`);
    }
  }
  const turns = [...snaps.values()].map(s => `${s.turn}.${s.round}`);
  const sizes = [...new Set(mapSizes.values())];
  log(`[${label}] peers up ${snaps.size}/${ports.size}, alive ${alive}, clocks ${[...new Set(turns)].join('|')}, map sizes ${sizes.join('|')}, strong-region sizes ${regions.join(',')}, view mismatches ${mismatches.length}`);
  for (const m of mismatches.slice(0, 6)) log('   ', m);
  return { mismatches, sizes };
}

const endAt = Date.now() + minutes * 60_000;
while (Date.now() < endAt) { await sleep(30_000); await audit('live'); }
for (const a of agents) { try { a.ws.onclose = null; a.ws.close(); } catch {} }
log(`agents stopped: ${agents.map(a => `${a.peerId.replace('peer:', '')} rounds ${a.rounds} moves ${a.moves} attacks ${a.attacks}`).join('; ')}`);
await sleep(20_000);
const fin = await audit('settled');

// ---- 5. log scan ----
const dirs = [path.join(here, '..', 'logs', slug(DIM))];
if (process.env.LOGS_C) dirs.push(path.join(process.env.LOGS_C, slug(DIM)));
const counts = {};
for (const dir of dirs) for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  if (!f.endsWith('.log') || f.endsWith('.ui.log')) continue;
  const txt = fs.readFileSync(path.join(dir, f), 'utf8');
  const c = k => (txt.match(k) || []).length;
  counts[f] = { divergence: c(/STATE DIVERGENCE/g), heal: c(/mesh heal:/g), relink: c(/closed — will re-dial/g), catchup: c(/clock catch-up/g), uncaught: c(/UNCAUGHT|UNHANDLED/g), died: c(/DIED at/g), mapBlocks: c(/map \+/g), mapSync: c(/map sync/g) };
  const gs = [...txt.matchAll(/gossip state: topics=\d+ totalPeers=(\d+) subscribersOnStrong=(\d+)/g)].at(-1);
  counts[f].lastPubsubPeers = gs ? `${gs[2]}/${gs[1]}` : '?';
  const bus = [...txt.matchAll(/bus: (\d+)\/(\d+) relays, sent (\d+), received (\d+)/g)].at(-1);
  counts[f].bus = bus ? `sent ${bus[3]} rx ${bus[4]} (${bus[1]}/${bus[2]} relays)` : '?';
}
console.table(counts);
const divergences = Object.values(counts).reduce((s, c) => s + c.divergence, 0);
log(`RESULT: ${fin.mismatches.length} settled view mismatches, ${fin.sizes.length === 1 ? 'map consistent' : 'MAP SIZES DIFFER ' + fin.sizes.join('|')}, ${divergences} state divergences logged`);
process.exit(0);
