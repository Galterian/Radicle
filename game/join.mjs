// Join a running Dimension from a Radicle clone of this repo.
//
//   node game/join.mjs                  interactive: list dimensions → doors → pick a spot
//   node game/join.mjs --list           only print what's published
//   node game/join.mjs --dimension Ashfall-Micro --door door-primary \
//        --as player-2 --character char_oran_rief --side player --placement nearby
//
// Dimension/door state comes from the delegates' ActiveDimensions/* branches
// (pushed every minute by the lottery winner). Each door carries the mesh's
// bootstrap multiaddrs, Gun relays and discovery URL; we dial those, adopt the
// live turn clock, and spawn a regular peer.mjs for the chosen entity.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { ensureBare, listPublishedDimensions, radicleEnv } from './radicle-adapter.mjs';
import { hexDistance, neighbours, inBounds } from './js/hex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

// -------- args --------
const args = Object.create(null);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  args[k] = v;
}
if (args.help) {
  console.log(`usage: node game/join.mjs [--list] [--dimension NAME] [--door ID] [--as LABEL]
       [--character ID | --creature ID] [--side player|npc_a|npc_b]
       [--placement nearby|random] [--public-ip IP] [--ui-port 7357]`);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
async function pick(title, items, render, { defaultIndex = 0 } = {}) {
  if (items.length === 1) return items[0];
  console.log(`\n${title}`);
  items.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2)}) ${render(it)}`));
  for (;;) {
    const ans = (await rl.question(`choose [${defaultIndex + 1}]: `)).trim();
    if (!ans) return items[defaultIndex];
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
  }
}
async function ask(q, dflt) {
  const ans = (await rl.question(`${q}${dflt !== undefined ? ` [${dflt}]` : ''}: `)).trim();
  return ans || dflt;
}

// -------- 1. what's published --------
if (!radicleEnv.enabled) {
  console.error(`This checkout isn't a Radicle clone (${radicleEnv.reason}). Run: rad clone rad:<RID>`);
  process.exit(1);
}
console.log(`[join] repo rad:${radicleEnv.rid} — fetching published dimensions from delegate namespaces…`);
await ensureBare();
const published = await listPublishedDimensions();
if (!published.length) { console.error('[join] no ActiveDimensions/* branches found. Is the host running and has the lottery pushed yet?'); process.exit(1); }

// Probe each door's discovery URL so we can tell live doors from stale pushes.
async function probeDiscovery(url, dimId) {
  try {
    const r = await fetch(`${url}/peers/${dimId}`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    return j.peers || [];
  } catch { return null; }
}
const ageMin = iso => Math.max(0, Math.round((Date.now() - Date.parse(iso || 0)) / 60000));

const doors = [];
for (const d of published) {
  for (const door of d.doors) {
    const live = door.network?.discovery_url ? await probeDiscovery(door.network.discovery_url, d.dimension.dimension_id) : null;
    doors.push({ dim: d, door, live });
  }
}

const describe = ({ dim, door, live }) => {
  const liveTag = live ? `LIVE ${live.length} peers, turn ${Math.max(0, ...live.map(p => p.state?.turn ?? 0))}` : `offline (push ${ageMin(door.last_push?.at)} min ago)`;
  return `${dim.dimension_name} / ${door.door_id}  [${liveTag}]  members: ${door.members?.map(m => `${m.name || m.peer_id}@(${m.tile?.q},${m.tile?.r})`).join(', ') || '—'}`;
};

if (args.list) {
  console.log('\nPublished dimensions & doors:');
  for (const d of doors) console.log('  ' + describe(d));
  process.exit(0);
}

// -------- 2. choose a door --------
let candidates = doors;
if (args.dimension) candidates = candidates.filter(x => x.dim.dimension_name === args.dimension);
if (args.door)      candidates = candidates.filter(x => x.door.door_id === args.door);
if (!candidates.length) { console.error('[join] no door matches the given --dimension/--door'); process.exit(1); }
const liveFirst = candidates.findIndex(x => x.live);
const chosen = await pick('Doors', candidates, describe, { defaultIndex: liveFirst >= 0 ? liveFirst : 0 });
const { dim, door } = chosen;
if (!chosen.live) {
  console.warn(`[join] warning: ${door.door_id} did not answer at ${door.network?.discovery_url}. Joining will start a fresh mesh at turn 0.`);
}
if (!door.network?.bootstrap?.length) { console.error('[join] door has no bootstrap multiaddrs; the host must be running a newer peer.mjs'); process.exit(1); }

// -------- 3. who am I --------
async function loadNames(file) {
  const j = JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
  return j.entries.map(e => ({ id: e.id, name: e.name }));
}
const characters = await loadNames('characters.json');
const creatures  = await loadNames('creatures.json');

let characterId = args.character || '';
let creatureId  = args.creature  || '';
if (!characterId && !creatureId) {
  const kind = await pick('Play as', ['character', 'creature'], s => s);
  if (kind === 'character') characterId = (await pick('Characters', characters, c => `${c.name}  (${c.id})`)).id;
  else                      creatureId  = (await pick('Creatures',  creatures,  c => `${c.name}  (${c.id})`)).id;
}
const sourceName = (characters.find(c => c.id === characterId) || creatures.find(c => c.id === creatureId))?.name;
if (!sourceName) { console.error(`[join] unknown character/creature id`); process.exit(1); }

const side  = args.side || await pick('Side', ['player', 'npc_a', 'npc_b'], s => ({ player: 'player  (fights with npc_a)', npc_a: 'npc_a   (allies of player)', npc_b: 'npc_b   (opposition)' }[s]));
const label = args.as || await ask('Peer label', `${side}-${os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)}-${Math.random().toString(36).slice(2, 5)}`);
const entityName = args.name || `${sourceName} (${label})`;

// -------- 4. where do I appear --------
const sideOf = a => (a === 'player' || a === 'npc_a') ? 'A' : a === 'npc_b' ? 'B' : a;
const size = door.region?.size || 5;
const strongRadius = door.region?.strong_radius_tiles ?? 2;
const center = door.region?.center ? { q: door.region.center.q ?? 2, r: door.region.center.r ?? 2 } : { q: 2, r: 2 };

// Prefer live positions; fall back to the last pushed snapshot.
const members = chosen.live?.length
  ? chosen.live.filter(p => p.state).map(p => ({ q: p.state.tile_q, r: p.state.tile_r, alliance: p.state.alliance, life: p.state.life }))
  : (door.members || []).map(m => ({ q: m.tile?.q, r: m.tile?.r, alliance: m.clan, life: m.life ?? 1 }));
const alive = members.filter(m => Number.isInteger(m.q) && Number.isInteger(m.r) && (m.life ?? 1) > 0);
const occupied = new Set(alive.map(m => `${m.q},${m.r}`));
const allTiles = [];
for (let q = 0; q < size; q++) for (let r = 0; r < size; r++) allTiles.push({ q, r });
const free = allTiles.filter(t => !occupied.has(`${t.q},${t.r}`));
const minDist = (t, set) => set.length ? Math.min(...set.map(m => hexDistance(t, m))) : Infinity;
const rand = arr => arr[Math.floor(Math.random() * arr.length)];

function placeNearby() {
  const friends = alive.filter(m => sideOf(m.alliance) === sideOf(side));
  const anchors = friends.length ? friends : alive.length ? alive : [center];
  const adjacent = free.filter(t => anchors.some(a => hexDistance(t, a) === 1));
  if (adjacent.length) return rand(adjacent);
  free.sort((a, b) => minDist(a, anchors) - minDist(b, anchors));
  return free[0];
}
function placeRandomUnrevealed() {
  // "Revealed" = inside any member's strong radius. Prefer tiles nobody can
  // see yet; otherwise the tiles farthest from everyone.
  const hidden = free.filter(t => minDist(t, alive) > strongRadius);
  if (hidden.length) return rand(hidden);
  const far = Math.max(...free.map(t => minDist(t, alive)));
  return rand(free.filter(t => minDist(t, alive) === far));
}
if (!free.length) { console.error('[join] the grid is full'); process.exit(1); }
const placement = args.placement || await pick('Placement', ['nearby', 'random'], s => s === 'nearby' ? 'nearby   — adjacent to your side' : 'random   — an unrevealed tile away from everyone');
const startTile = placement === 'random' ? placeRandomUnrevealed() : placeNearby();
if (!inBounds(startTile.q, startTile.r, size)) { console.error('[join] placement failed'); process.exit(1); }

// -------- 5. network --------
const bootstrap = door.network.bootstrap;
const gunRelays = door.network.gun_relays || [];
const discoveryUrl = door.network.discovery_url;
const hostIsLoopback = bootstrap.every(a => a.includes('/ip4/127.0.0.1/'));

function detectPublicIp() {
  if (args['public-ip']) return args['public-ip'];
  if (process.env.PEER_PUBLIC_IP) return process.env.PEER_PUBLIC_IP;
  if (hostIsLoopback) return '127.0.0.1';
  const addrs = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal);
  // Tailscale hands out 100.64.0.0/10; prefer it since that's the usual way to reach a host behind NAT.
  const ts = addrs.find(a => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address));
  return (ts || addrs[0])?.address || '127.0.0.1';
}
const publicIp = detectPublicIp();

async function freePort(start) {
  for (let p = start; p < start + 200; p++) {
    const ok = await new Promise(res => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, '0.0.0.0', () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error('no free port');
}
const portLibp2p = await freePort(7420);
const portHttp   = await freePort(7430);
const portGun    = await freePort(7520);
const uiPort     = Number(args['ui-port'] || process.env.UI_PORT || 7357);
const uiAlreadyUp = await new Promise(res => {
  const s = net.connect(uiPort, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
});

rl.close();

// -------- 6. go --------
console.log(`
[join] ${entityName} → ${dim.dimension_name}/${door.door_id} at tile (${startTile.q},${startTile.r}) [${placement}]
[join] side=${side}  label=peer:${label}
[join] bootstrap: ${bootstrap.join(', ')}
[join] gun relays: ${gunRelays.join(', ') || '(none)'}
[join] discovery: ${discoveryUrl}
[join] advertising myself at ${publicIp} (libp2p :${portLibp2p}, gun :${portGun})
`);

const children = [];
function run(name, file, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, file)], {
    cwd: __dirname,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', b => process.stdout.write(`${b}`));
  child.stderr.on('data', b => process.stderr.write(`${b}`));
  child.on('exit', code => console.log(`[join] ${name} exited (${code})`));
  children.push(child);
}

if (!uiAlreadyUp) run('ui', 'ui-server.mjs', { UI_PORT: String(uiPort) });

run(`peer:${label}`, 'peer.mjs', {
  PEER_LABEL:        label,
  ALLIANCE:          side,
  ENTITY_NAME:       entityName,
  CHARACTER_ID:      characterId,
  CREATURE_ID:       creatureId,
  START_TILE:        JSON.stringify(startTile),
  PEER_PORT_LIBP2P:  String(portLibp2p),
  PEER_PORT_HTTP:    String(portHttp),
  PEER_PORT_GUN:     String(portGun),
  DIM_NAME:          dim.dimension_name,
  DIM_ID:            dim.dimension_id,
  DOOR_ID:           door.door_id,
  DISCOVERY_URL:     discoveryUrl,
  PUBLIC_DISCOVERY_URL: discoveryUrl,
  BOOTSTRAP:         bootstrap.join(','),
  PEER_GUN_URLS:     gunRelays.join(','),
  PEER_PUBLIC_IP:    publicIp,
  BIND_HOST:         publicIp === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
  RADICLE_PUSH_SEC:  '60',
  UI_PORT:           String(uiPort),
});

console.log(`[join] open  http://127.0.0.1:${uiPort}/?peer=${portHttp}  to play as ${entityName}`);
process.on('SIGINT', () => { for (const c of children) try { c.kill('SIGINT'); } catch {} process.exit(0); });
