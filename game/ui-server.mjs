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
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RADICLE_BARE, radicleEnv, listPublishedDimensions } from './radicle-adapter.mjs';
import { createNostrBus, DEFAULT_RELAYS } from './nostr-bus.mjs';
import { hexDistance, inBounds } from './js/hex.js';
import { fancyLabel } from './js/names.js';

const pexec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const LAUNCHER_MODE = process.env.LAUNCHER_MODE === '1';

const MIME = { '.html':'text/html;charset=utf-8', '.js':'application/javascript;charset=utf-8', '.css':'text/css;charset=utf-8', '.json':'application/json;charset=utf-8' };
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// ---------- launch orchestration ----------
const children = [];
let startedDimension = null;   // { peerPort, dimensionName } once this launcher has spawned a roster
let launching = false;

function spawnChild(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child._name = name;
  child.stdout.on('data', (b) => process.stdout.write(`${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`${b}`));
  child.on('exit', (code) => console.log(`[launcher] ${name} exited (${code})`));
  children.push(child);
  return child;
}

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
const dimIdOf = d => d.dimension_id || d.dimension?.dimension_id || `dim-${slug(d.dimension_name)}`;

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

// Every live peer re-publishes its Door once a minute, so a dimension whose
// newest Door is older than this has nobody in it right now.
const DOOR_LIVE_MS = Number(process.env.DOOR_LIVE_MS || 3 * 60 * 1000);
const ageSec = iso => Math.max(0, Math.round((Date.now() - Date.parse(iso || 0)) / 1000));

// Union the members every Door knows about into one roster: newest sighting
// of each peer wins, stale ones (nobody has seen them in a while) drop out.
function unionMembers(doors, maxAgeMs = DOOR_LIVE_MS) {
  const byId = new Map();
  const consider = (m, at) => {
    if (!m?.peer_id) return;
    const seen = Date.parse(m.last_seen || at || 0);
    const prev = byId.get(m.peer_id);
    if (!prev || seen > prev._seen) byId.set(m.peer_id, { ...m, _seen: seen });
  };
  for (const p of doors) {
    consider({ peer_id: p.peer_id, name: p.name, alliance: p.alliance, character_id: p.character_id, creature_id: p.creature_id, tile: p.tile, life: p.life, life_max: p.life_max, last_seen: p.pushed_at }, p.pushed_at);
    for (const m of p.known_members || []) consider(m, p.pushed_at);
  }
  const cutoff = Date.now() - maxAgeMs;
  return [...byId.values()].filter(m => m._seen > cutoff).map(({ _seen, ...m }) => m);
}

// Shape a dimension for the launcher page.
function describeDimension(d) {
  const doors = (d.doors || []).map(p => ({
    peer_id: p.peer_id, name: p.name, alliance: p.alliance, character_id: p.character_id, creature_id: p.creature_id,
    tile: p.tile, life: p.life, life_max: p.life_max, clock: p.clock, pushed_at: p.pushed_at, age_sec: ageSec(p.pushed_at),
    live: Date.now() - Date.parse(p.pushed_at || 0) < DOOR_LIVE_MS, nid: p.nid, commit: p.commit,
    known_members: (p.known_members || []).length, known_tiles: (p.known_tiles || []).length,
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
    for (let i = 0; i < count && ok; i++) {
      ok = await new Promise(res => {
        const s = net.createServer();
        s.once('error', () => res(false));
        s.listen(base + i, '0.0.0.0', () => s.close(() => res(true)));
      });
    }
    if (ok) return base;
  }
  throw new Error(`no run of ${count} free ports near ${start}`);
}

// Env shared by every peer this launcher spawns. DISCOVERY_URL is only passed
// through if start-all was told to run the optional LAN mirror.
function commonPeerEnv() {
  return {
    RADICLE_PUSH_SEC: process.env.RADICLE_PUSH_SEC || '60',
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

// Pick a start tile from what the Doors know. 'nearby' = adjacent to a friend
// (or to the chosen player's Door); 'random' = outside everyone's strong radius.
function placeFromDoors({ members, anchorPeerId, side, placement, size = 5, strongRadius = 2 }) {
  const sideOf = a => (a === 'player' || a === 'npc_a') ? 'A' : a === 'npc_b' ? 'B' : a;
  const alive = members
    .map(m => ({ peer_id: m.peer_id, q: m.tile?.q, r: m.tile?.r, alliance: m.alliance ?? m.clan, life: m.life ?? 1 }))
    .filter(m => Number.isInteger(m.q) && Number.isInteger(m.r) && (m.life ?? 1) > 0);
  const occupied = new Set(alive.map(m => `${m.q},${m.r}`));
  const all = []; for (let q = 0; q < size; q++) for (let r = 0; r < size; r++) all.push({ q, r });
  const free = all.filter(t => !occupied.has(`${t.q},${t.r}`));
  if (!free.length) throw new Error('the grid is full');
  const minDist = (t, set) => set.length ? Math.min(...set.map(m => hexDistance(t, m))) : Infinity;
  const rand = arr => arr[Math.floor(Math.random() * arr.length)];
  if (placement === 'random') {
    const hidden = free.filter(t => minDist(t, alive) > strongRadius);
    if (hidden.length) return rand(hidden);
    const far = Math.max(...free.map(t => minDist(t, alive)));
    return rand(free.filter(t => minDist(t, alive) === far));
  }
  const anchor = anchorPeerId ? alive.filter(m => m.peer_id === anchorPeerId) : [];
  const friends = alive.filter(m => sideOf(m.alliance) === sideOf(side));
  const anchors = anchor.length ? anchor : friends.length ? friends : alive.length ? alive : [{ q: 2, r: 2 }];
  const adjacent = free.filter(t => anchors.some(a => hexDistance(t, a) === 1));
  if (adjacent.length) return rand(adjacent);
  free.sort((a, b) => minDist(a, anchors) - minDist(b, anchors));
  return free[0];
}

async function joinDimension({ dimensionName, doorId, placement, side, characterId, creatureId, label, entityName }) {
  if (!radicleEnv.enabled) throw new Error(`radicle disabled: ${radicleEnv.reason}`);
  const items = await listPublishedDimensions();
  const dim = items.find(d => d.dimension_name === dimensionName);
  if (!dim) throw new Error(`dimension "${dimensionName}" is not published on Radicle`);
  if (!dim.doors.length) throw new Error(`${dimensionName} was published by an older version (a single host door) — no player holds a Door into it`);
  const anchorDoor = doorId ? dim.doors.find(p => p.peer_id === doorId || p.door_id === doorId) : dim.doors[0];
  if (doorId && !anchorDoor) throw new Error(`no Door from ${doorId} on ${dimensionName}`);
  const members = unionMembers(dim.doors);
  const liveDoors = dim.doors.filter(p => Date.now() - Date.parse(p.pushed_at || 0) < DOOR_LIVE_MS);
  if (!liveDoors.length) console.log(`[launcher] ${dimensionName}: no Door newer than ${DOOR_LIVE_MS / 60000} min — joining an empty dimension; you will be alone until someone else arrives`);

  const startTile = placeFromDoors({ members, anchorPeerId: anchorDoor?.peer_id, side, placement });
  if (!inBounds(startTile.q, startTile.r, 5)) throw new Error('placement failed');

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
  if (req.method === 'GET' && p === '/api/dimensions') {
    try {
      const items = radicleEnv.enabled ? (await listPublishedDimensions()).map(describeDimension) : [];
      return json(200, { ok: true, enabled: radicleEnv.enabled, reason: radicleEnv.enabled ? null : radicleEnv.reason, door_live_ms: DOOR_LIVE_MS, items });
    } catch (e) {
      return json(200, { ok: false, enabled: radicleEnv.enabled, reason: e.message, items: [] });
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
  const serve = async (abs) => {
    try { const b = await fs.readFile(abs); res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(b); }
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
  const rel = p === '/' ? '/index.html' : p;
  const abs = path.join(__dirname, rel.replace(/\.\./g, ''));
  if (!abs.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
  await serve(abs);
});
const PORT = Number(process.env.UI_PORT || 7357);
server.listen(PORT, '127.0.0.1', () => console.log(`[ui-server] http://127.0.0.1:${PORT}${LAUNCHER_MODE ? ' (launcher mode)' : ''}`));

process.on('SIGINT', () => { for (const c of children) try { c.kill('SIGINT'); } catch {}; process.exit(0); });
