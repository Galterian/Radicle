// Serves the browser UI (index.html + /js + /css + /data) on :7357.
// The browser connects via WebSocket to its player peer at ws://127.0.0.1:<peer>.
//
// When LAUNCHER_MODE=1 (set by start-all.mjs), this server also:
//   • exposes /api/dimensions   — every dimension anyone has published a Door into on Radicle
//   • exposes /api/live/:dimId  — listen on the public bus for a few seconds, report who is there
//   • exposes /api/launch       — start-or-join; spawns peer processes on demand
// so the choice lives in the browser instead of the terminal.
//
// There is no host. "Start a dimension" just spawns the first peers (your
// character plus the NPCs); from then on every peer — yours, theirs, the NPCs —
// is equal: each publishes its own Door (its piece of the dimension) to its own
// Radicle namespace once a minute and exchanges rounds over the public Nostr bus.
//
// Peer processes spawned from here inherit this server's env, so RADICLE_PUSH_SEC,
// PEER_PUBLIC_IP, NOSTR_RELAYS etc. flow through from start-all.mjs.

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RADICLE_BARE, radicleEnv, listPublishedDimensions } from './radicle-adapter.mjs';
import { createNostrBus, DEFAULT_RELAYS } from './nostr-bus.mjs';
import { fancyLabel } from './js/names.js';
import { listSavedDimensions as listLocalTmjSaves, DIMENSIONS_DIR } from './tools/autosave.mjs';
import { DOOR_LIVE_MS, dimIdOf, unionMembers, mapFromDoors, placeFromDoors } from './join-plan.mjs';

const pexec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
// Curated WBC3 art/sound collection (chaosD6/assets) — sprite sheets, hex
// terrain tiles, portraits and voice lines referenced by data/*.json `resources`.
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const LAUNCHER_MODE = process.env.LAUNCHER_MODE === '1';

const MIME = { '.html':'text/html;charset=utf-8', '.js':'application/javascript;charset=utf-8', '.css':'text/css;charset=utf-8', '.json':'application/json;charset=utf-8',
               '.png':'image/png', '.bmp':'image/bmp', '.jpg':'image/jpeg', '.gif':'image/gif', '.wav':'audio/wav', '.ogg':'audio/ogg', '.mp3':'audio/mpeg' };
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// ---------- launch orchestration ----------
const children = [];
let startedDimension = null;   // { peerPort, dimensionName } once this launcher has spawned a roster
let launching = false;

// Keep per-peer log files in game/logs/<dimension-slug>/<label>.log — one
// subdirectory per dimension so logs are naturally partitioned by game.
// When the user reports a bug and says "it happened in dimension <name>",
// I only have to read the files under that one subdir instead of untangling
// a shared log stream. Each subdir also gets an `_index.txt` with the
// human-readable dimension name so I can confirm which slug maps to which.
// The console still mirrors everything so a live tail is also an option.
const LOG_DIR = path.resolve(__dirname, 'logs');
try { fsSync.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
console.log(`[launcher] per-peer logs root: ${LOG_DIR}`);
const _logStreams = new Map();   // key: "<dim>/<name>" -> WriteStream
const _dimIndexWritten = new Set();
function logStreamFor(name, env) {
  const dimName = (env && env.DIM_NAME) || 'unknown-dimension';
  const dimSlug = slug(dimName) || 'unknown-dimension';
  const dimDir = path.join(LOG_DIR, dimSlug);
  const key = `${dimSlug}/${name}`;
  let s = _logStreams.get(key);
  if (s) return s;
  try { fsSync.mkdirSync(dimDir, { recursive: true }); } catch {}
  if (!_dimIndexWritten.has(dimSlug)) {
    try { fsSync.writeFileSync(path.join(dimDir, '_index.txt'), `dimension_name=${dimName}\ndimension_slug=${dimSlug}\n`); } catch {}
    _dimIndexWritten.add(dimSlug);
  }
  const safe = String(name).replace(/[^a-z0-9._-]+/gi, '_');
  const file = path.join(dimDir, `${safe}.log`);
  s = fsSync.createWriteStream(file, { flags: 'a' });
  s.on('error', (e) => console.warn(`[launcher] log stream for ${key} failed: ${e.message}`));
  s.write(`\n===== ${new Date().toISOString()} — session start for ${name} in dimension "${dimName}" =====\n`);
  _logStreams.set(key, s);
  console.log(`[launcher] log → ${path.relative(__dirname, file)}`);
  return s;
}
function spawnChild(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child._name = name;
  child._http = Number(env?.PEER_PORT_HTTP) || null;
  child._dim = env?.DIM_NAME || null;
  const logFile = logStreamFor(name, env);
  child.stdout.on('data', (b) => { process.stdout.write(`${b}`); logFile.write(b); });
  child.stderr.on('data', (b) => { process.stderr.write(`${b}`); logFile.write(b); });
  child.on('exit', (code, signal) => {
    const msg = `[launcher] ${name} exited (code=${code}, signal=${signal})`;
    console.log(msg);
    logFile.write(`\n${msg}\n`);
  });
  children.push(child);
  return child;
}

// A port is free only if nothing answers on loopback AND we can bind it on the
// wildcard. Binding alone is not enough: Node listen sockets set SO_REUSEADDR,
// so on Linux a wildcard bind succeeds while a sibling peer already listens on
// 127.0.0.1:<port> — that handed two joiners the same UI port.
async function portIsFree(p) {
  const answering = await new Promise(res => {
    const c = net.connect({ port: p, host: '127.0.0.1' });
    c.once('connect', () => { c.destroy(); res(true); });
    c.once('error', () => res(false));
    c.setTimeout(300, () => { c.destroy(); res(false); });
  });
  if (answering) return false;
  return new Promise(res => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen(p, '0.0.0.0', () => s.close(() => res(true)));
  });
}
// Ports handed out by this launcher process; a probe can't see a port whose
// peer is still booting.
const handedOut = new Set();
async function freePort(start) {
  for (let p = start; p < start + 200; p++) {
    if (handedOut.has(p)) continue;
    if (await portIsFree(p)) { handedOut.add(p); return p; }
  }
  throw new Error('no free port');
}

async function waitForPort(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise(res => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); res(true); });
      s.once('error', () => res(false));
    });
    if (up) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Addresses peers on the same network could dial this box at, for the optional
// direct libp2p link. Tailscale (100.64/10) first, then LAN, loopback last.
// Across the internet nobody dials anybody — the Nostr bus carries the rounds.
const isTailscale = ip => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
function candidateIps() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ address: a.address, iface: name, kind: isTailscale(a.address) ? 'tailscale' : 'lan' });
    }
  }
  out.sort((a, b) => (a.kind === 'tailscale' ? 0 : 1) - (b.kind === 'tailscale' ? 0 : 1));
  out.push({ address: '127.0.0.1', iface: 'lo', kind: 'loopback' });
  return out;
}
function defaultPublicIp() {
  return process.env.PEER_PUBLIC_IP || candidateIps()[0].address;
}
const isLoopback = ip => !ip || ip === '127.0.0.1' || ip === 'localhost';

// DOOR_LIVE_MS, unionMembers, mapFromDoors, placeFromDoors live in join-plan.mjs
// (shared with the Android entry).
const ageSec = iso => Math.max(0, Math.round((Date.now() - Date.parse(iso || 0)) / 1000));

// Shape a dimension for the launcher page.
function describeDimension(d) {
  const doors = (d.doors || []).map(p => ({
    peer_id: p.peer_id, name: p.name, alliance: p.alliance, character_id: p.character_id, creature_id: p.creature_id,
    tile: p.tile, life: p.life, life_max: p.life_max, clock: p.clock, pushed_at: p.pushed_at, age_sec: ageSec(p.pushed_at),
    live: Date.now() - Date.parse(p.pushed_at || 0) < DOOR_LIVE_MS, nid: p.nid, commit: p.commit,
    known_members: (p.known_members || []).length, known_tiles: (p.known_tiles || []).length,
    map_tiles: p.map?.tiles_known ?? null, map_blocks: (p.map?.blocks || []).length,
  }));
  const newest = doors[0]?.pushed_at || d.legacy_doors?.[0]?.last_push?.at || null;
  return {
    dimension_name: d.dimension_name, dimension_id: dimIdOf(d), namespaces: d.namespaces,
    doors, members: unionMembers(d.doors || []),
    live_doors: doors.filter(p => p.live).length,
    legacy: !doors.length && (d.legacy_doors || []).length > 0,
    newest_push: newest, age_sec: newest ? ageSec(newest) : null,
    turn: Math.max(0, ...doors.filter(p => p.live).map(p => p.clock?.turn ?? 0)),
  };
}

// Listen on the public bus for a few seconds and report which peers announce
// themselves on this dimension's tag — ground truth for "is anyone there".
async function probeLive(dimId, ms = 7000, relays = DEFAULT_RELAYS) {
  const heard = new Map();
  const bus = createNostrBus({ relays, dimId, label: 'probe', log: () => {}, warn: () => {}, onEvent(type, payload) {
    if (type === 'state' && payload?.peer_id) heard.set(payload.peer_id, { peer_id: payload.peer_id, name: payload.name, alliance: payload.alliance, life: payload.life, turn: payload.turn, action: payload.action });
    else if (type === 'env' && payload?.actor_peer_id && !heard.has(payload.actor_peer_id)) heard.set(payload.actor_peer_id, { peer_id: payload.actor_peer_id });
  } });
  await new Promise(r => setTimeout(r, ms));
  const stats = bus.stats();
  bus.close();
  return { peers: [...heard.values()], relays_open: stats.open, listened_ms: ms };
}

// Reserve a run of consecutive free ports so one launcher's peers don't collide
// with another launcher's on the same box. The probe is best-effort (another
// process could grab a port between probe and listen); peers fail loudly if so.
async function freePortRun(start, count) {
  for (let base = start; base < start + 400; base++) {
    let ok = true;
    for (let i = 0; i < count && ok; i++) ok = !handedOut.has(base + i) && await portIsFree(base + i);
    if (ok) { for (let i = 0; i < count; i++) handedOut.add(base + i); return base; }
  }
  throw new Error(`no run of ${count} free ports near ${start}`);
}

// Env shared by every peer this launcher spawns. DISCOVERY_URL is only passed
// through if start-all was told to run the optional LAN mirror.
function commonPeerEnv() {
  return {
    // Only forward the two push-cadence env vars if they're set — otherwise
    // let peer.mjs use its own defaults (600s interval, 60s initial delay).
    // Hard-coding '60' here used to pin every spawned peer to 1-minute pushes
    // regardless of the peer-side default; dropping that so the new 10-min
    // cadence actually takes effect for ui-launched meshes.
    ...(process.env.RADICLE_PUSH_SEC       ? { RADICLE_PUSH_SEC:       process.env.RADICLE_PUSH_SEC       } : {}),
    ...(process.env.RADICLE_PUSH_FIRST_SEC ? { RADICLE_PUSH_FIRST_SEC: process.env.RADICLE_PUSH_FIRST_SEC } : {}),
    UI_PORT: String(process.env.UI_PORT || 7357),
    ...(process.env.DISCOVERY_URL ? { DISCOVERY_URL: process.env.DISCOVERY_URL } : {}),
    ...(process.env.NOSTR_RELAYS ? { NOSTR_RELAYS: process.env.NOSTR_RELAYS } : {}),
  };
}

async function startDimension({ dimensionName, publicIp }) {
  if (startedDimension) return { ...startedDimension, status: 'already-running' };
  const DIM_NAME = (dimensionName || 'Ashfall-Micro').trim();
  const DIM_ID   = `dim-${slug(DIM_NAME)}`;
  const DOOR_ID  = 'door-primary';
  const ip = (publicIp || '').trim() || defaultPublicIp();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`"${ip}" is not an IPv4 address`);
  const netEnv = { PEER_PUBLIC_IP: ip, BIND_HOST: isLoopback(ip) ? '127.0.0.1' : '0.0.0.0' };
  const roster = [
    { label: 'player-1', alliance: 'player', character: 'char_exuberant_firestroker', creature: '',                      name: 'You (Firestroker)',    tile: { q: 1, r: 2 } },
    { label: 'ally-1',   alliance: 'npc_a',  character: 'char_pride_guardian',          creature: '',                      name: 'Ally — Pride Guardian', tile: { q: 0, r: 3 } },
    { label: 'foe-1',    alliance: 'npc_b',  character: '',                              creature: 'mon_ruinous_minotaur',  name: 'Ruinous Minotaur',     tile: { q: 3, r: 1 } },
    { label: 'foe-2',    alliance: 'npc_b',  character: '',                              creature: 'mon_ridge_runnet_3a',   name: 'Ridge Runnet 3A',      tile: { q: 3, r: 3 } },
  ];
  // http and gun live in different base ranges (7401, 7501) and don't collide,
  // so probe them in parallel. libp2p (7410) sits inside http's search region,
  // so it has to wait for httpBase and start past it — this is the fix for the
  // old bug where both pools independently picked :7422 (EADDRINUSE).
  const [httpBase, gunBase] = await Promise.all([
    freePortRun(7401, roster.length),
    freePortRun(7501, roster.length),
  ]);
  const libp2pBase = await freePortRun(Math.max(7410, httpBase + roster.length), roster.length);
  const peers = roster.map((p, i) => ({ ...p, http: httpBase + i, libp2p: libp2pBase + i, gun: gunBase + i }));
  startedDimension = { peerPort: peers[0].http, dimensionName: DIM_NAME };
  console.log(`[launcher] starting dimension ${DIM_NAME}  (dim_id=${DIM_ID}; direct links via ${ip}; ports http ${httpBase}+, libp2p ${libp2pBase}+, gun ${gunBase}+; bus relays ${DEFAULT_RELAYS.join(', ')})`);
  const allGunUrls = peers.map(p => `http://${ip}:${p.gun}/gun`);
  // libp2p ids are minted at boot, so each peer learns the addresses of the
  // ones already up (via their /status) and dials them straight away. Without
  // this the first rounds ran before the roster had found itself on the bus.
  const bootstrap = [];
  for (const p of peers) {
    const others = allGunUrls.filter(u => !u.includes(`:${p.gun}/`));
    spawnChild(`peer:${p.label}`, [path.join(__dirname, 'peer.mjs')], {
      BOOTSTRAP:         bootstrap.join(','),
      PEER_LABEL:        p.label,
      ALLIANCE:          p.alliance,
      ENTITY_NAME:       p.name,
      CHARACTER_ID:      p.character,
      CREATURE_ID:       p.creature,
      START_TILE:        JSON.stringify(p.tile),
      PEER_PORT_LIBP2P:  String(p.libp2p),
      PEER_PORT_HTTP:    String(p.http),
      PEER_PORT_GUN:     String(p.gun),
      DIM_NAME, DIM_ID, DOOR_ID,
      PEER_GUN_URLS:     others.join(','),
      // The first peer has nobody to sync with; don't make it wait.
      JOIN_SYNC_WAIT_MS: p === peers[0] ? '500' : '8000',
      ...commonPeerEnv(),
      ...netEnv,
    });
    if (!(await waitForPort(p.http))) throw new Error(`peer-${p.label} did not come up on :${p.http}`);
    try {
      const st = await fetch(`http://127.0.0.1:${p.http}/status`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
      for (const a of (st.multiaddrs || [])) bootstrap.push(a);
    } catch (e) { console.warn(`[launcher] could not read ${p.label} addresses: ${e.message}`); }
  }
  const ok = await waitForPort(peers[0].http);
  if (!ok) throw new Error(`peer-player-1 did not come up on :${peers[0].http}`);
  return { peerPort: peers[0].http, status: 'started', dimension: DIM_NAME, publicIp: ip };
}

// Doors lag reality by up to a Door push: a hero who joined seconds ago is not
// in any Door yet, so two quick joiners could be placed on the same hex. Every
// peer this launcher runs in the dimension knows the live roster — ask them and
// merge their view (peers + self) into the Door members before placing.
async function liveMembersFromLocalPeers(dimName) {
  const out = [];
  const mine = children.filter(c => c._dim === dimName && c._http && c.exitCode === null && !c.killed);
  await Promise.all(mine.map(async c => {
    try {
      const st = await fetch(`http://127.0.0.1:${c._http}/status`, { signal: AbortSignal.timeout(1500) }).then(r => r.json());
      if (st.entity?.tile) out.push({ peer_id: st.peer_id, tile: { q: st.entity.tile.q, r: st.entity.tile.r }, alliance: st.alliance, life: st.entity.life });
      for (const p of st.peers || []) if (Number.isInteger(p.tile_q)) out.push({ peer_id: p.peer_id, tile: { q: p.tile_q, r: p.tile_r }, alliance: p.alliance, life: p.life });
    } catch {}
  }));
  return out;
}
function mergeMembers(doorMembers, live) {
  const byId = new Map(doorMembers.map(m => [m.peer_id, m]));
  for (const m of live) byId.set(m.peer_id, { ...(byId.get(m.peer_id) || {}), ...m });   // live view wins
  return [...byId.values()];
}

async function joinDimension({ dimensionName, doorId, placement, side, characterId, creatureId, label, entityName, preferredTile = null }) {
  if (!radicleEnv.enabled) throw new Error(`radicle disabled: ${radicleEnv.reason}`);
  const items = await listPublishedDimensions();
  const dim = items.find(d => d.dimension_name === dimensionName);
  if (!dim) throw new Error(`dimension "${dimensionName}" is not published on Radicle`);
  if (!dim.doors.length) throw new Error(`${dimensionName} was published by an older version (a single host door) — no player holds a Door into it`);
  const anchorDoor = doorId ? dim.doors.find(p => p.peer_id === doorId || p.door_id === doorId) : dim.doors[0];
  if (doorId && !anchorDoor) throw new Error(`no Door from ${doorId} on ${dimensionName}`);
  const members = mergeMembers(unionMembers(dim.doors), await liveMembersFromLocalPeers(dim.dimension_name));
  const liveDoors = dim.doors.filter(p => Date.now() - Date.parse(p.pushed_at || 0) < DOOR_LIVE_MS);
  if (!liveDoors.length) console.log(`[launcher] ${dimensionName}: no Door newer than ${DOOR_LIVE_MS / 60000} min — joining an empty dimension; you will be alone until someone else arrives`);

  const knownMap = mapFromDoors(dim);
  const startTile = placeFromDoors({ members, anchorPeerId: anchorDoor?.peer_id, side, placement, knownMap, preferredTile });
  if (!knownMap.has(startTile.q, startTile.r)) throw new Error('placement failed');
  console.log(`[launcher] ${dimensionName}: map from ${dim.doors.length} Doors = ${knownMap.size()} hexes in ${knownMap.blockCount()} blocks (seed ${knownMap.seed})`);
  // Hundreds of blocks don't fit comfortably in an environment variable; hand
  // the joiner a file instead.
  const mapBlocksFile = path.join(__dirname, 'sessions', dim.dimension_name, `map-blocks.${Date.now()}.json`);
  await fs.mkdir(path.dirname(mapBlocksFile), { recursive: true });
  await fs.writeFile(mapBlocksFile, JSON.stringify(knownMap.blocks()));

  // Network hints from every Door: bus relays (required), plus direct-link
  // addresses that may or may not be reachable from here.
  const relays = new Set(DEFAULT_RELAYS); const bootstrap = new Set(); const gunRelays = new Set();
  for (const p of dim.doors) {
    for (const r of p.network?.nostr?.relays || []) relays.add(r);
    if (Date.now() - Date.parse(p.pushed_at || 0) < DOOR_LIVE_MS) {
      for (const a of p.network?.libp2p?.multiaddrs || []) bootstrap.add(a);
      for (const a of p.network?.libp2p?.bootstrap || []) bootstrap.add(a);
      if (p.network?.gun?.url) gunRelays.add(p.network.gun.url);
      for (const g of p.network?.gun?.relays || []) gunRelays.add(g);
    }
  }
  const allLoopback = [...bootstrap].length > 0 && [...bootstrap].every(a => a.includes('/ip4/127.0.0.1/'));
  const publicIp = allLoopback ? '127.0.0.1' : defaultPublicIp();

  const portLibp2p = await freePort(7420);
  const portHttp   = await freePort(7430);
  const portGun    = await freePort(7520);

  const taken = new Set(members.map(m => String(m.peer_id || '').replace(/^peer:/, '')));
  const peerLabel = (label || '').trim() || fancyLabel(taken);
  spawnChild(`peer:${peerLabel}`, [path.join(__dirname, 'peer.mjs')], {
    PEER_LABEL:        peerLabel,
    ALLIANCE:          side,
    ENTITY_NAME:       entityName || peerLabel,
    CHARACTER_ID:      characterId || '',
    CREATURE_ID:       creatureId || '',
    START_TILE:        JSON.stringify(startTile),
    PEER_PORT_LIBP2P:  String(portLibp2p),
    PEER_PORT_HTTP:    String(portHttp),
    PEER_PORT_GUN:     String(portGun),
    DIM_NAME:          dim.dimension_name,
    DIM_ID:            dimIdOf(dim),
    DOOR_ID:           'door-primary',
    MAP_SEED:          knownMap.seed,
    MAP_BLOCKS_FILE:   mapBlocksFile,
    BOOTSTRAP:         [...bootstrap].join(','),
    PEER_GUN_URLS:     [...gunRelays].join(','),
    PEER_PUBLIC_IP:    publicIp,
    BIND_HOST:         publicIp === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
    JOIN_SYNC_WAIT_MS: liveDoors.length ? '8000' : '500',
    ...commonPeerEnv(),
    NOSTR_RELAYS:      [...relays].join(','),
  });
  const ok = await waitForPort(portHttp);
  if (!ok) throw new Error(`peer did not come up on :${portHttp}`);
  return { peerPort: portHttp, status: 'joined', dimension: dim.dimension_name, door: anchorDoor?.peer_id || null, placement, startTile, live_doors: liveDoors.length };
}

// Restore a dimension from a local TMJ autosave / hard save on this box.
// The TMJ already carries dim_id / dim_name / seed; we hand them to the peer
// via env + RESTORE_FROM_TMJ, which hydrates `dimMap`, `entity.obstacles`,
// `entity.tileTokens` and `entity.traps` before the first round.
async function restoreDimension({ tmjPath, label }) {
  if (!tmjPath) throw new Error('restoreDimension: tmjPath required');
  const absPath = path.resolve(tmjPath);
  const raw = await fs.readFile(absPath, 'utf8');
  const map = JSON.parse(raw);
  const props = Object.fromEntries((map.properties || []).map(p => [p.name, p.value]));
  if (!String(props.schema_version || '').startsWith('chaosd6-tmj-')) throw new Error(`not a chaosD6 TMJ: ${absPath}`);
  const DIM_NAME = String(props.dim_name || 'Restored-Dimension');
  const DIM_ID   = String(props.dim_id   || `dim-${slug(DIM_NAME)}`);
  const DOOR_ID  = 'door-primary';
  const MAP_SEED = String(props.seed || '');
  // Rejoin path: if the dim named here is still live on Radicle (a recent Door
  // exists), bring the dead player back as a fresh peer at their saved tile
  // (or the nearest free hex if someone else now stands on it) instead of
  // doing a cold respawn of the whole 4-peer mesh. The entities layer of the
  // TMJ carries each entity's tile; the player tile is the one with
  // alliance='player'. If no player entity is in the TMJ (shouldn't happen,
  // but legacy saves exist) we fall through to the cold-respawn code below.
  // IMPORTANT: this runs BEFORE the `startedDimension` guard so a launcher
  // that already hosts the (still-live) dim can still spawn one more peer to
  // bring the dead player back — rejoin only adds one peer, it never touches
  // the roster already in flight.
  const entitiesLayer = (map.layers || []).find(l => l.name === 'entities') || { objects: [] };
  const entProps = o => Object.fromEntries((o.properties || []).map(p => [p.name, p.value]));
  const playerEnt = (entitiesLayer.objects || [])
    .map(o => ({ p: entProps(o), name: o.name }))
    .find(e => String(e.p.alliance || '') === 'player');
  const savedTile = playerEnt && Number.isInteger(playerEnt.p.tile_q) && Number.isInteger(playerEnt.p.tile_r)
    ? { q: playerEnt.p.tile_q, r: playerEnt.p.tile_r } : null;
  if (radicleEnv.enabled && savedTile) {
    try {
      const items = await listPublishedDimensions();
      const dim = items.find(d => d.dimension_name === DIM_NAME);
      const liveDoors = dim ? dim.doors.filter(p => Date.now() - Date.parse(p.pushed_at || 0) < DOOR_LIVE_MS) : [];
      if (liveDoors.length) {
        console.log(`[launcher] ${DIM_NAME} is still live (${liveDoors.length} recent Door${liveDoors.length === 1 ? '' : 's'}) — rejoining at saved tile (${savedTile.q},${savedTile.r})`);
        const out = await joinDimension({
          dimensionName: DIM_NAME, doorId: null, placement: 'nearby', side: 'player',
          characterId: String(playerEnt.p.source_id || '') || 'char_exuberant_firestroker',
          creatureId: '', label: (label || '').trim() || null,
          entityName: playerEnt.name || 'You',
          preferredTile: savedTile,
        });
        return { ...out, status: 'rejoined', tmj: absPath, savedTile };
      }
      console.log(`[launcher] ${DIM_NAME} has no recent Doors — cold-respawning the whole mesh from TMJ`);
    } catch (e) {
      console.warn(`[launcher] rejoin check failed (${e.message}); falling back to cold respawn`);
    }
  }

  if (startedDimension) return { ...startedDimension, status: 'already-running' };
  const ip = defaultPublicIp();
  const netEnv = { PEER_PUBLIC_IP: ip, BIND_HOST: isLoopback(ip) ? '127.0.0.1' : '0.0.0.0' };
  // Restore the SAME roster shape startDimension uses, so the ally and foes
  // are present (otherwise the launcher's "my ally died before my dimension
  // loaded" happens — there is simply no ally spawned). Only player-1 reads
  // the TMJ (hydrating map / obstacles / tokens / traps); the others catch
  // up via the hashgraph's evt_map_sync.
  const roster = [
    { label: (label || '').trim() || 'player-1', alliance: 'player', character: 'char_exuberant_firestroker', creature: '',                      name: 'You (Firestroker)',    tile: { q: 1, r: 2 }, restore: true },
    { label: 'ally-1',                            alliance: 'npc_a',  character: 'char_pride_guardian',          creature: '',                      name: 'Ally — Pride Guardian', tile: { q: 0, r: 3 }, restore: false },
    { label: 'foe-1',                             alliance: 'npc_b',  character: '',                              creature: 'mon_ruinous_minotaur',  name: 'Ruinous Minotaur',     tile: { q: 3, r: 1 }, restore: false },
    { label: 'foe-2',                             alliance: 'npc_b',  character: '',                              creature: 'mon_ridge_runnet_3a',   name: 'Ridge Runnet 3A',      tile: { q: 3, r: 3 }, restore: false },
  ];
  const [httpBase, gunBase] = await Promise.all([
    freePortRun(7401, roster.length),
    freePortRun(7501, roster.length),
  ]);
  const libp2pBase = await freePortRun(Math.max(7410, httpBase + roster.length), roster.length);
  const peers = roster.map((p, i) => ({ ...p, http: httpBase + i, libp2p: libp2pBase + i, gun: gunBase + i }));
  startedDimension = { peerPort: peers[0].http, dimensionName: DIM_NAME };
  console.log(`[launcher] restoring ${DIM_NAME} from ${absPath}  (dim_id=${DIM_ID}, seed=${MAP_SEED}; ports http ${httpBase}+, libp2p ${libp2pBase}+, gun ${gunBase}+)`);
  const allGunUrls = peers.map(p => `http://${ip}:${p.gun}/gun`);
  const bootstrap = [];
  for (const p of peers) {
    const others = allGunUrls.filter(u => !u.includes(`:${p.gun}/`));
    spawnChild(`peer:${p.label}`, [path.join(__dirname, 'peer.mjs')], {
      BOOTSTRAP:         bootstrap.join(','),
      PEER_LABEL:        p.label,
      ALLIANCE:          p.alliance,
      ENTITY_NAME:       p.name,
      CHARACTER_ID:      p.character,
      CREATURE_ID:       p.creature,
      START_TILE:        JSON.stringify(p.tile),
      PEER_PORT_LIBP2P:  String(p.libp2p),
      PEER_PORT_HTTP:    String(p.http),
      PEER_PORT_GUN:     String(p.gun),
      DIM_NAME, DIM_ID, DOOR_ID,
      MAP_SEED,
      ...(p.restore ? { RESTORE_FROM_TMJ: absPath } : {}),
      PEER_GUN_URLS:     others.join(','),
      JOIN_SYNC_WAIT_MS: p === peers[0] ? '500' : '8000',
      ...commonPeerEnv(),
      ...netEnv,
    });
    if (!(await waitForPort(p.http))) throw new Error(`peer-${p.label} did not come up on :${p.http}`);
    try {
      const st = await fetch(`http://127.0.0.1:${p.http}/status`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
      for (const a of (st.multiaddrs || [])) bootstrap.push(a);
    } catch (e) { console.warn(`[launcher] could not read ${p.label} addresses: ${e.message}`); }
  }
  return { peerPort: peers[0].http, status: 'restored', dimension: DIM_NAME, tmj: absPath };
}

async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { chunks.push(c); n += c.length; if (n > 65536) throw new Error('body too large'); }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleApi(req, res, p) {
  if (!LAUNCHER_MODE) { res.writeHead(404); return res.end('launcher mode disabled'); }
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && p === '/api/network') {
    return json(200, { ok: true, candidates: candidateIps(), default: defaultPublicIp(), relays: DEFAULT_RELAYS, radicle: radicleEnv.enabled ? { rid: radicleEnv.rid, nid: radicleEnv.nid } : null });
  }
  if (req.method === 'GET' && (p === '/dimensions/local' || p === '/api/dimensions/local')) {
    // Local TMJ autosaves / hard saves on this box — picked by the launcher's
    // "restore" mode so the user can keep playing a dimension that went
    // offline. The route is intentionally shallow; the TMJ file names (dim_id)
    // are the stable identity.
    try { const items = await listLocalTmjSaves(DIMENSIONS_DIR); return json(200, { ok: true, baseDir: DIMENSIONS_DIR, items }); }
    catch (e) { return json(200, { ok: false, error: e.message, baseDir: DIMENSIONS_DIR, items: [] }); }
  }
  if (req.method === 'GET' && p === '/api/dimensions') {
    // ?sync=0 skips the seed fetch entirely. The launcher page load uses that
    // so hosting a new dimension (or picking "restore") never waits for a
    // seed that may be slow or down. The join-mode radios fire a follow-up
    // call with ?sync=1 when the user actually needs fresh door info.
    const want = new URL(req.url, 'http://x').searchParams.get('sync');
    const doSync = want === null ? true : want !== '0' && want !== 'false';
    try {
      const items = radicleEnv.enabled ? (await listPublishedDimensions({ sync: doSync })).map(describeDimension) : [];
      return json(200, { ok: true, enabled: radicleEnv.enabled, reason: radicleEnv.enabled ? null : radicleEnv.reason, door_live_ms: DOOR_LIVE_MS, synced: doSync, items });
    } catch (e) {
      return json(200, { ok: false, enabled: radicleEnv.enabled, reason: e.message, synced: doSync, items: [] });
    }
  }
  const liveMatch = p.match(/^\/api\/live\/([A-Za-z0-9_.-]+)$/);
  if (req.method === 'GET' && liveMatch) {
    try { return json(200, { ok: true, dimension_id: liveMatch[1], ...(await probeLive(liveMatch[1])) }); }
    catch (e) { return json(200, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && p === '/api/launch') {
    if (launching) return json(409, { ok: false, error: 'another launch is in progress' });
    launching = true;
    try {
      const body = JSON.parse(await readBody(req));
      let out;
      if (body.mode === 'host' || body.mode === 'start') out = await startDimension(body);
      else if (body.mode === 'join') out = await joinDimension(body);
      else if (body.mode === 'restore') out = await restoreDimension(body);
      else throw new Error(`unknown mode "${body.mode}"`);
      return json(200, { ok: true, ...out });
    } catch (e) {
      console.error(`[launcher] /api/launch failed: ${e.message}`);
      return json(500, { ok: false, error: e.message });
    } finally { launching = false; }
  }
  res.writeHead(404); res.end('not found');
}

// ---------- original UI handlers (unchanged below) ----------
async function renderCommit(sha) {
  const run = async (args) => (await pexec('git', ['--git-dir', RADICLE_BARE, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const [meta, body, stat, diff] = await Promise.all([
    run(['show', '-s', '--format=%H%n%an <%ae>%n%aI%n%d%n%s', sha]),
    run(['show', '-s', '--format=%b', sha]),
    run(['show', '--stat', '--format=', sha]),
    run(['show', '--format=', sha]),
  ]);
  const [full, author, date, refs, subject] = meta.split('\n');
  return `<!doctype html><meta charset="utf-8"><title>${esc(full.slice(0,10))} — ${esc(subject)}</title>
<style>
  body{font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#0f1115;color:#d8dee9;margin:0;padding:24px;max-width:1100px}
  h1{font-size:16px;margin:0 0 4px}
  .meta{color:#8b95a7;margin-bottom:16px}
  .meta b{color:#d8dee9;font-weight:600}
  pre{background:#161a22;border:1px solid #222a37;border-radius:6px;padding:12px;overflow:auto;white-space:pre}
  .add{color:#8ec07c}.rem{color:#fb4934}.hdr{color:#83a598}.file{color:#d3869b}
  a{color:#83a598}
</style>
<h1>${esc(subject)}${esc(refs)}</h1>
<div class="meta">
  <div><b>${esc(full)}</b></div>
  <div>${esc(author)} · ${esc(date)}</div>
  <div><a href="/">← back to game</a></div>
</div>
${body.trim() ? `<pre>${esc(body)}</pre>` : ''}
<pre>${esc(stat)}</pre>
<pre>${esc(diff).replace(/^(diff --git .*|index .*|--- .*|\+\+\+ .*)$/gm, '<span class="file">$1</span>').replace(/^@@.*$/gm, '<span class="hdr">$&</span>').replace(/^\+(?!\+\+).*$/gm, '<span class="add">$&</span>').replace(/^-(?!--).*$/gm, '<span class="rem">$&</span>')}</pre>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  const serve = async (abs, cache = 'no-store') => {
    try { const b = await fs.readFile(abs); res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache }); res.end(b); }
    catch { res.writeHead(404); res.end('not found'); }
  };
  if (p.startsWith('/api/')) return handleApi(req, res, p);
  const rMatch = p.match(/^\/r\/([^/]+)\/(commits|tree)\/([^/]+)(\/.*)?$/);
  if (rMatch) {
    if (!radicleEnv.enabled) { res.writeHead(503); return res.end('radicle remote push disabled'); }
    const [, alias, kind, sha, rest] = rMatch;
    if (radicleEnv.alias && alias !== radicleEnv.alias) {
      res.writeHead(404); return res.end(`unknown alias "${alias}" (configured: "${radicleEnv.alias}")`);
    }
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) { res.writeHead(400); return res.end('bad sha'); }
    const target = kind === 'commits'
      ? radicleEnv.rawCommitUrl(sha)
      : radicleEnv.rawTreeUrl(sha, rest ? rest.slice(1) : '');
    res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (p.startsWith('/commit/')) {
    const sha = p.slice('/commit/'.length);
    if (!SHA_RE.test(sha)) { res.writeHead(400); return res.end('bad sha'); }
    try {
      const html = await renderCommit(sha);
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(`commit ${sha} not found in ${RADICLE_BARE}\n${e.message}`);
    }
  }
  if (p.startsWith('/data/')) return serve(path.join(DATA_DIR, p.slice('/data/'.length).replace(/\.\./g, '')));
  // Resources quoted in data/*.json (sprites + sounds, mapping files, schema).
  // Binary files resolve through symlinks into ../../warlords_battlecry_resources;
  // readFile follows them, and the path-traversal check happens before.
  if (p.startsWith('/assets/')) {
    const abs = path.resolve(ASSETS_DIR, '.' + p.slice('/assets'.length).replace(/\.\./g, ''));
    if (!abs.startsWith(ASSETS_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    return serve(abs);
  }
  const rel = p === '/' ? '/index.html' : p;
  const abs = path.join(__dirname, rel.replace(/\.\./g, ''));
  if (!abs.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
  await serve(abs);
});
const PORT = Number(process.env.UI_PORT || 7357);
server.listen(PORT, '127.0.0.1', () => console.log(`[ui-server] http://127.0.0.1:${PORT}${LAUNCHER_MODE ? ' (launcher mode)' : ''}`));

process.on('SIGINT', () => { for (const c of children) try { c.kill('SIGINT'); } catch {}; process.exit(0); });
