// Serves the browser UI (index.html + /js + /css + /data) on :7357.
// The browser connects via WebSocket to its player peer at ws://127.0.0.1:<peer>.
//
// When LAUNCHER_MODE=1 (set by start-all.mjs), this server also:
//   • exposes /api/dimensions   — list what's published on Radicle
//   • exposes /api/launch       — host-or-join; spawns peer processes on demand
// so the choice lives in the browser instead of the terminal.
//
// Peer processes spawned from here inherit this server's env, so RADICLE_PUSH_SEC,
// PEER_PUBLIC_IP, BIND_HOST etc. flow through from start-all.mjs.

import http from 'node:http';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RADICLE_BARE, radicleEnv, listPublishedDimensions } from './radicle-adapter.mjs';
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
let hostLaunched = false;
let hostPlayerPort = null;
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

async function waitForPort(port, timeoutMs = 20000) {
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

// A published door is only joinable while its host's discovery answers. The
// Radicle snapshot outlives the host process, so probe before trusting it.
async function probeDoor(door, dimId) {
  const url = door.network?.discovery_url;
  if (!url) return null;
  try {
    const r = await fetch(`${url}/peers/${dimId}`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    const peers = (j.peers || []).filter(p => p.state);
    // A discovery on a reused port may answer for a dimension it never saw.
    if (!peers.length) return null;
    return { peers: peers.length, turn: Math.max(0, ...peers.map(p => p.state.turn ?? 0)) };
  } catch { return null; }
}
const ageMin = iso => Math.max(0, Math.round((Date.now() - Date.parse(iso || 0)) / 60000));

// Reserve a run of consecutive free ports so one host's peers don't collide
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

async function hostDimension({ dimensionName }) {
  if (hostLaunched) return { peerPort: hostPlayerPort, status: 'already-running' };
  hostLaunched = true;
  const DIM_NAME = dimensionName || 'Ashfall-Micro';
  const DIM_ID   = `dim-${slug(DIM_NAME)}`;
  const DOOR_ID  = 'door-primary';
  const roster = [
    { label: 'player-1', alliance: 'player', character: 'char_exuberant_firestroker', creature: '',                      name: 'You (Firestroker)',    tile: { q: 1, r: 2 } },
    { label: 'ally-1',   alliance: 'npc_a',  character: 'char_pride_guardian',          creature: '',                      name: 'Ally — Pride Guardian', tile: { q: 0, r: 3 } },
    { label: 'foe-1',    alliance: 'npc_b',  character: '',                              creature: 'mon_ruinous_minotaur',  name: 'Ruinous Minotaur',     tile: { q: 3, r: 1 } },
    { label: 'foe-2',    alliance: 'npc_b',  character: '',                              creature: 'mon_ridge_runnet_3a',   name: 'Ridge Runnet 3A',      tile: { q: 3, r: 3 } },
  ];
  const [httpBase, libp2pBase, gunBase] = await Promise.all([freePortRun(7401, roster.length), freePortRun(7410, roster.length), freePortRun(7501, roster.length)]);
  const peers = roster.map((p, i) => ({ ...p, http: httpBase + i, libp2p: libp2pBase + i, gun: gunBase + i }));
  hostPlayerPort = peers[0].http;
  console.log(`[launcher] hosting new dimension: ${DIM_NAME}  (dim_id=${DIM_ID}, door_id=${DOOR_ID}; ports http ${httpBase}+, libp2p ${libp2pBase}+, gun ${gunBase}+)`);
  const allGunUrls = peers.map(p => `http://127.0.0.1:${p.gun}/gun`);
  for (const p of peers) {
    const others = allGunUrls.filter(u => !u.includes(`:${p.gun}/`));
    spawnChild(`peer:${p.label}`, [path.join(__dirname, 'peer.mjs')], {
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
      RADICLE_PUSH_SEC:  '60',
    });
    await new Promise(r => setTimeout(r, 800));
  }
  const ok = await waitForPort(hostPlayerPort);
  if (!ok) throw new Error(`peer-player-1 did not come up on :${hostPlayerPort}`);
  return { peerPort: hostPlayerPort, status: 'hosting' };
}

function placeOnDoor({ door, side, placement }) {
  const sideOf = a => (a === 'player' || a === 'npc_a') ? 'A' : a === 'npc_b' ? 'B' : a;
  const size = door.region?.size || 5;
  const strongRadius = door.region?.strong_radius_tiles ?? 2;
  const center = door.region?.center ? { q: door.region.center.q ?? 2, r: door.region.center.r ?? 2 } : { q: 2, r: 2 };
  const alive = (door.members || [])
    .map(m => ({ q: m.tile?.q, r: m.tile?.r, alliance: m.clan, life: m.life ?? 1 }))
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
  const friends = alive.filter(m => sideOf(m.alliance) === sideOf(side));
  const anchors = friends.length ? friends : alive.length ? alive : [center];
  const adjacent = free.filter(t => anchors.some(a => hexDistance(t, a) === 1));
  if (adjacent.length) return rand(adjacent);
  free.sort((a, b) => minDist(a, anchors) - minDist(b, anchors));
  return free[0];
}

async function joinDimension({ dimensionName, doorId, placement, side, characterId, creatureId, label, entityName }) {
  if (!radicleEnv.enabled) throw new Error(`radicle disabled: ${radicleEnv.reason}`);
  const items = await listPublishedDimensions();
  const dim = items.find(d => d.dimension_name === dimensionName);
  if (!dim) throw new Error(`dimension "${dimensionName}" not published`);
  const door = doorId ? dim.doors.find(d => d.door_id === doorId) : dim.doors[0];
  if (!door) throw new Error(`door "${doorId || '(first)'}" not found on ${dimensionName}`);
  if (!door.network?.bootstrap?.length) throw new Error('door has no bootstrap multiaddrs; the host must be running a newer peer.mjs');
  const live = await probeDoor(door, dim.dimension?.dimension_id || `dim-${slug(dim.dimension_name)}`);
  if (!live) throw new Error(`${dimensionName} / ${door.door_id} is offline — its host isn't answering at ${door.network.discovery_url} (last push ${ageMin(door.last_push?.at)} min ago). Start that host again, or create a new Dimension.`);

  const startTile = placeOnDoor({ door, side, placement });
  if (!inBounds(startTile.q, startTile.r, door.region?.size || 5)) throw new Error('placement failed');

  const bootstrap = door.network.bootstrap;
  const gunRelays = door.network.gun_relays || [];
  const discoveryUrl = door.network.discovery_url;
  const hostIsLoopback = bootstrap.every(a => a.includes('/ip4/127.0.0.1/'));
  const publicIp = process.env.PEER_PUBLIC_IP || (hostIsLoopback ? '127.0.0.1' : '127.0.0.1');

  const portLibp2p = await freePort(7420);
  const portHttp   = await freePort(7430);
  const portGun    = await freePort(7520);

  const taken = new Set((door.members || []).map(m => String(m.peer_id || '').replace(/^peer:/, '')));
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
    DIM_ID:            dim.dimension?.dimension_id || `dim-${slug(dim.dimension_name)}`,
    DOOR_ID:           door.door_id,
    DISCOVERY_URL:     discoveryUrl,
    PUBLIC_DISCOVERY_URL: discoveryUrl,
    BOOTSTRAP:         bootstrap.join(','),
    PEER_GUN_URLS:     gunRelays.join(','),
    PEER_PUBLIC_IP:    publicIp,
    BIND_HOST:         publicIp === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
    RADICLE_PUSH_SEC:  '60',
    UI_PORT:           String(process.env.UI_PORT || 7357),
  });
  const ok = await waitForPort(portHttp);
  if (!ok) throw new Error(`peer did not come up on :${portHttp}`);
  return { peerPort: portHttp, status: 'joined', dimension: dim.dimension_name, door: door.door_id, placement, startTile };
}

async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { chunks.push(c); n += c.length; if (n > 65536) throw new Error('body too large'); }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleApi(req, res, p) {
  if (!LAUNCHER_MODE) { res.writeHead(404); return res.end('launcher mode disabled'); }
  if (req.method === 'GET' && p === '/api/dimensions') {
    try {
      const items = radicleEnv.enabled ? await listPublishedDimensions() : [];
      // Annotate every door with its live state so the launcher can grey out
      // doors whose host has gone away.
      await Promise.all(items.flatMap(d => d.doors.map(async door => {
        door.live = await probeDoor(door, d.dimension?.dimension_id || `dim-${slug(d.dimension_name)}`);
      })));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, enabled: radicleEnv.enabled, reason: radicleEnv.enabled ? null : radicleEnv.reason, items }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, enabled: radicleEnv.enabled, reason: e.message, items: [] }));
    }
  }
  if (req.method === 'POST' && p === '/api/launch') {
    if (launching) { res.writeHead(409); return res.end(JSON.stringify({ ok: false, error: 'another launch is in progress' })); }
    launching = true;
    try {
      const body = JSON.parse(await readBody(req));
      let out;
      if (body.mode === 'host') out = await hostDimension({ dimensionName: body.dimensionName });
      else if (body.mode === 'join') out = await joinDimension(body);
      else throw new Error(`unknown mode "${body.mode}"`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...out }));
    } catch (e) {
      console.error(`[launcher] /api/launch failed: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
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
