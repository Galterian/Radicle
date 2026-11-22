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
import { RADICLE_BARE, radicleEnv as radicleEnvReal, listPublishedDimensions as listRadicleDimensions, localDimensionBranches, localBranchBytes, forgetLocalDimension } from './radicle-adapter.mjs';
import { assetFile } from './asset-root.mjs';
// CHAOSD6_DIMS_FIXTURE: test launchers only — a JSON file of dimensions (listPublishedDimensions shape) read instead
// of the Radicle storage, so join / clone / regeneration paths run without touching ~/.radicle.
const DIMS_FIXTURE = process.env.CHAOSD6_DIMS_FIXTURE || '';
const radicleEnv = DIMS_FIXTURE ? { ...radicleEnvReal, enabled: true, reason: null } : radicleEnvReal;
const listPublishedDimensions = async (opts) => DIMS_FIXTURE ? JSON.parse(await fs.readFile(DIMS_FIXTURE, 'utf8')) : listRadicleDimensions(opts);
import { enrichDimensions, planDelete, removeLocalDirs, loadHidden, hideDimension, mineMapsOf, OLD_AFTER_MS, LOCAL_ONLY_NOTE } from './dims-local.mjs';
import { createNostrBus, DEFAULT_RELAYS } from './nostr-bus.mjs';
import { fancyLabel } from './js/names.js';
import { listSavedDimensions as listLocalTmjSaves, DIMENSIONS_DIR, readPrivateMark } from './tools/autosave.mjs';
import { isTestMode, PRIVATE_TEST_ENV, privateDimId } from './join-plan.mjs';
import { lastKnownClock, doorClockCands, saveClockCand } from './merge-order.mjs';   // start clock of a join (user 2026-11-17)
import { DOOR_LIVE_MS, dimIdOf, unionMembers, mapFromDoors, placeFromDoors, tileInRing, describeDimension, doorMapSummaries, validTile,
  dimensionUnits, newTeamSide, NO_FREE_SIDE, teamBotSide, aliveInDimensions, aliveWhereText, knownMonsterType, quietMonsters, nearestMonsters, asMembers, REGEN_MAX, probeDimensionLive, networkFromDoors, restoreHereTarget, heroShadowIn } from './join-plan.mjs';
import { seedForDimension } from './js/map.js';
import { randomBytes } from 'node:crypto';
import { definitionsCollectionText } from './defs-collection.mjs';   // F9: /data/effects.json = the definitions' cards
import { handleEditorRequest } from './editor-api.mjs';   // rules editor /rules/* (+ its node API), launcher only
import { handleProfileApi, attachProfileSync, profilePath, loadProfile, characterOf, topCharacter, teamCharacters, profileEnv } from './profile.mjs';

const pexec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
// No player profiles yet (TBD): a new game starts as a random character, desktop and phone alike
// (user ruling 2026-11-12). A resumed save keeps the hero it saved.
function randomCharacter() {
  try {
    const doc = JSON.parse(fsSync.readFileSync(path.join(DATA_DIR, 'characters.json'), 'utf8'));
    const list = (doc.entries || []).filter(e => e?.id && (e.versions || []).some(v => !['rejected', 'superseded'].includes(v.status)));
    const e = list[Math.floor(Math.random() * list.length)];
    if (e) { console.log(`[launcher] random character: ${e.id} (of ${list.length})`); return { id: e.id, name: e.name || e.id }; }
  } catch (err) { console.warn(`[launcher] characters.json unreadable (${err.message}) — Firestroker it is`); }
  return { id: 'char_exuberant_firestroker', name: 'Exuberant Firestroker' };
}
// "Monster" joins (creatureId 'random'): any creature that isn't rejected / superseded.
function randomCreature() {
  try {
    const doc = JSON.parse(fsSync.readFileSync(path.join(DATA_DIR, 'creatures.json'), 'utf8'));
    const list = (doc.entries || []).filter(e => e?.id && (e.versions || []).some(v => !['rejected', 'superseded'].includes(v.status)));
    const e = list[Math.floor(Math.random() * list.length)];
    if (e) { console.log(`[launcher] random creature: ${e.id} (of ${list.length})`); return { id: e.id, name: e.name || e.id }; }
  } catch (err) { console.warn(`[launcher] creatures.json unreadable (${err.message}) — Ruinous Minotaur it is`); }
  return { id: 'mon_ruinous_minotaur', name: 'Ruinous Minotaur' };
}
// A creature id's display name from creatures.json (the id itself when unknown).
function creatureName(id) {
  try {
    const doc = JSON.parse(fsSync.readFileSync(path.join(DATA_DIR, 'creatures.json'), 'utf8'));
    return (doc.entries || []).find(e => e?.id === id)?.name || id;
  } catch { return id; }
}
// Curated WBC3 art/sound collection (chaosD6/assets) — sprite sheets, hex
// terrain tiles, portraits and voice lines referenced by data/*.json `resources`.
// Served through assetFile(): catalogues from ../assets, media from MEDIA_ROOT (may be chaosD6-Resources).
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
  child._profileCharId = env?.PROFILE_CHAR_ID || null;   // no-cloning check (aliveHere)
  child._private = env?.DIM_PRIVATE === '1';              // a private test game: never counts for one-dimension
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

// describeDimension (the launcher page's shape of a dimension) lives in join-plan.mjs, shared with the phone's menu.

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

// Test-team allies stand this far from player-1 (user ruling 2026-11-13):
// 'strong' inside STRONG_RADIUS, 'reachable' just past it, inside REACH_RADIUS.
const TEAM_TIER_RING = { strong: { min: 2, max: 6 }, reachable: { min: 9, max: 10 } };
// AI skirmish roster size (startDimension): rival heroes (npc_c) and NPC builders (npc_a).
const AI_RIVALS = Math.max(0, Number(process.env.AI_RIVALS ?? 2));
const AI_BUILDERS = Math.max(0, Number(process.env.AI_BUILDERS ?? 2));

// `override` (profile launches, user ruling 2026-11-13) replaces the hero and/or
// the default ally: { hero: profile character | null (random), allies: [profile
// characters] (bots, alliance npc_a) | null (the Pride Guardian), tier }.
async function startDimension({ dimensionName, publicIp, mode, ai: aiFlag }, override = null) {
  if (startedDimension) return { ...startedDimension, status: 'already-running' };
  // Test my character / Test my team / Test Random character are LOCAL and PRIVATE (user 2026-11-16): no Door, no
  // Nostr bus, loopback only, an unguessable DIM_ID, never unattended — and so never "one dimension at a time"
  // (supersedes the 2026-11-15 refusal for tests). Create Dimension (named) stays public and still refuses (409)
  // when the hero is alive in another dimension.
  const test = isTestMode(mode);
  if (override?.hero && !test) await refuseAliveHere(null, [override.hero, ...(override.allies || [])]);
  const DIM_NAME = (dimensionName || 'Ashfall-Micro').trim();
  const DIM_ID   = test ? privateDimId(DIM_NAME) : `dim-${slug(DIM_NAME)}`;
  const DOOR_ID  = 'door-primary';
  const ip = test ? '127.0.0.1' : ((publicIp || '').trim() || defaultPublicIp());
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`"${ip}" is not an IPv4 address`);
  const netEnv = test ? { ...PRIVATE_TEST_ENV, TEST_MODE: mode } : { PEER_PUBLIC_IP: ip, BIND_HOST: isLoopback(ip) ? '127.0.0.1' : '0.0.0.0' };
  // (The peers' autosave writes private.json beside the saves — TEST_MODE — so Load old Dimension tags it "test".)
  const pc = override?.hero || null;
  const hero = pc ? { id: pc.base_character, name: pc.name } : randomCharacter();
  const file = profilePath();
  // AI skirmish (2026-11-22, game/llm-brain.mjs): Create Dimension (any non-test launch; body.ai false / AI_SKIRMISH=0
  // turns it off, body.ai true turns it on for a test) adds a rival team (npc_c, hostile to everyone) and NPC builders
  // (npc_a, raise Barricades) and gives every bot an AI_ROLE for the local llama-server (LLM_URL, default
  // http://127.0.0.1:8095). Without a reachable server the same units are played by the rules (npcPlan).
  const ai = typeof aiFlag === 'boolean' ? aiFlag : (!test && process.env.AI_SKIRMISH !== '0');
  const roster = [
    { label: 'player-1', alliance: 'player', character: hero.id, creature: '',                                          name: pc ? pc.name : `You (${hero.name})`, tile: { q: 1, r: 2 }, profile: pc },
    { label: 'ally-1',   alliance: 'npc_a',  character: 'char_pride_guardian',          creature: '',                      name: 'Ally — Pride Guardian', tile: { q: 0, r: 3 }, aiRole: 'team' },
    { label: 'foe-1',    alliance: 'npc_b',  character: '',                              creature: 'mon_ruinous_minotaur',  name: 'Ruinous Minotaur',     tile: { q: 3, r: 1 }, aiRole: 'monster' },
    { label: 'foe-2',    alliance: 'npc_b',  character: '',                              creature: 'mon_ridge_runnet_3a',   name: 'Ridge Runnet 3A',      tile: { q: 3, r: 3 }, aiRole: 'monster' },
  ];
  if (override?.allies?.length) {
    // "Test my team": the next characters of the team order replace the Pride
    // Guardian, each on a walkable hex at the tier's distance from player-1.
    const ring = TEAM_TIER_RING[override.tier] || TEAM_TIER_RING.reachable;
    const seed = seedForDimension(DIM_ID);
    roster.splice(1, 1);
    const occupied = new Set(roster.map(p => `${p.tile.q},${p.tile.r}`));
    override.allies.forEach((c, i) => {
      const tile = tileInRing(roster[0].tile, { ...ring, seed, salt: c.id, occupied });
      if (!tile) throw new Error(`no walkable hex ${ring.min}–${ring.max} hexes from player-1 for ${c.name}`);
      occupied.add(`${tile.q},${tile.r}`);
      roster.splice(1 + i, 0, { label: `ally-${i + 1}`, alliance: 'npc_a', character: c.base_character, creature: '', name: c.name, tile, profile: c, aiRole: 'team' });
    });
  }
  if (ai) {
    // The rival team walks in from 7–9 hexes; the builders start 2–3 hexes from the hero.
    const seed = seedForDimension(DIM_ID);
    const occupied = new Set(roster.map(p => `${p.tile.q},${p.tile.r}`));
    const place = (salt, ring) => {
      const tile = tileInRing(roster[0].tile, { ...ring, seed, salt, occupied });
      if (!tile) throw new Error(`AI skirmish: no walkable hex ${ring.min}–${ring.max} hexes from player-1 for ${salt}`);
      occupied.add(`${tile.q},${tile.r}`);
      return tile;
    };
    for (let i = 1; i <= AI_RIVALS; i++) {
      const c = randomCharacter();
      roster.push({ label: `rival-${i}`, alliance: 'npc_c', character: c.id, creature: '', name: `Rival — ${c.name}`, tile: place(`rival-${i}`, { min: 7, max: 9 }), aiRole: 'rival' });
    }
    for (let i = 1; i <= AI_BUILDERS; i++) {
      const c = randomCharacter();
      roster.push({ label: `builder-${i}`, alliance: 'npc_a', character: c.id, creature: '', name: `Builder — ${c.name}`, tile: place(`builder-${i}`, { min: 2, max: 3 }), aiRole: 'builder' });
    }
    console.log(`[launcher] AI skirmish: ${roster.filter(p => p.aiRole).map(p => `${p.label}=${p.aiRole}`).join(', ')} — llama-server ${process.env.LLM_URL || 'http://127.0.0.1:8095'}`);
  }
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
  startedDimension = { peerPort: peers[0].http, dimensionName: DIM_NAME, ...(test ? { private: true, dimensionId: DIM_ID } : {}) };
  console.log(`[launcher] starting dimension ${DIM_NAME}  (dim_id=${DIM_ID}; direct links via ${ip}; ports http ${httpBase}+, libp2p ${libp2pBase}+, gun ${gunBase}+; ${test ? `PRIVATE test game (${mode}): no Door, no bus, loopback` : `bus relays ${DEFAULT_RELAYS.join(', ')}`})`);
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
      ...(p.profile ? profileEnv(file, p.profile) : {}),
      AI_ROLE:           ai && p.aiRole ? p.aiRole : '',
      // llm-route.mjs: my team's bots may also ask my teammates' nodes (signed with this device's key) — team role only.
      ...(ai && p.aiRole === 'team' ? { LLM_PROFILE_FILE: file } : {}),
    });
    if (!(await waitForPort(p.http))) throw new Error(`peer-${p.label} did not come up on :${p.http}`);
    try {
      const st = await fetch(`http://127.0.0.1:${p.http}/status`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
      for (const a of (st.multiaddrs || [])) bootstrap.push(a);
    } catch (e) { console.warn(`[launcher] could not read ${p.label} addresses: ${e.message}`); }
  }
  const ok = await waitForPort(peers[0].http);
  if (!ok) throw new Error(`peer-player-1 did not come up on :${peers[0].http}`);
  return { peerPort: peers[0].http, status: 'started', dimension: DIM_NAME, publicIp: ip, ...(test ? { private: true, dimension_id: DIM_ID } : {}) };
}

// Doors lag reality by up to a Door push: a hero who joined seconds ago is not
// in any Door yet, so two quick joiners could be placed on the same hex. Every
// peer this launcher runs in the dimension knows the live roster — ask them and
// merge their view (peers + self) into the Door members before placing.
async function liveMembersFromLocalPeers(dimName) {
  const out = [];
  const mine = children.filter(c => c._dim === dimName && !c._private && c._http && c.exitCode === null && !c.killed);
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

// `dim` (already listed), `startTile` (fixed, skips the placement — team allies on the tier ring) and
// `extraBootstrap` / `extraGunUrls` (peers of this launcher already in there) serve "Join my team".
// `nearTile` {q,r} (launcher unit list: "join next to this unit") places the joiner on a free walkable
// hex beside it. Stale Doors are accepted: with no live Door the joiner starts the dimension from the Doors.
// `regen` (user ruling 2026-11-15): in a quiet dimension (no live Door, nothing of it running here, nobody heard on
// its bus) the Door-known monsters come back — their tiles are taken for my placement and the REGEN_MAX nearest to
// my start tile are returned as `regen` (startRegenMonsters spawns them). `human`: HUMAN=1 (I play it on any side).
// `extraMembers`: more taken tiles (placement members).
async function joinDimension({ dimensionName, doorId, placement, side, characterId, creatureId, label, entityName, preferredTile = null, nearTile = null, extraEnv = {}, dim: givenDim = null, startTile: fixedTile = null, extraBootstrap = [], extraGunUrls = [],
  regen = false, human = false, extraMembers = [] }) {
  if (nearTile != null && !validTile(nearTile)) throw Object.assign(new Error('nearTile must be {q, r} integers'), { status: 400 });
  if (!radicleEnv.enabled) throw new Error(`radicle disabled: ${radicleEnv.reason}`);
  // Nobody to play: a random character ('random' creature = the Monster join, picked here too).
  if (creatureId === 'random') { const m = randomCreature(); creatureId = m.id; entityName ||= m.name; characterId = ''; }
  if (!characterId && !creatureId) characterId = randomCharacter().id;
  const dim = givenDim || (await listPublishedDimensions()).find(d => d.dimension_name === dimensionName);
  if (!dim) throw new Error(`dimension "${dimensionName}" is not published on Radicle`);
  if (!dim.doors.length) throw new Error(`${dimensionName} was published by an older version (a single host door) — no player holds a Door into it`);
  const anchorDoor = doorId ? dim.doors.find(p => p.peer_id === doorId || p.door_id === doorId) : dim.doors[0];
  if (doorId && !anchorDoor) throw new Error(`no Door from ${doorId} on ${dimensionName}`);
  const liveDoors = dim.doors.filter(p => Date.now() - Date.parse(p.pushed_at || 0) < DOOR_LIVE_MS);
  // Quiet = no live Door (DOOR_LIVE_MS = 2 push intervals + 5 min), nothing of it running here, and nobody on its
  // bus (the probe below).
  const regenAll = regen && !liveDoors.length && !dimensionRunning(dim.dimension_name) ? quietMonsters(dim.doors) : [];
  // Doors are pushed every ~10 min but live for 3: listen on the bus meanwhile (my own peers are filtered out).
  const probe = regenAll.length ? probeDimensionLive({ dimId: dimIdOf(dim), relays: networkFromDoors(dim.doors).relays }).catch(() => ({ peers: [] })) : null;
  const members = mergeMembers(mergeMembers(unionMembers(dim.doors), [...asMembers(regenAll), ...extraMembers]), await liveMembersFromLocalPeers(dim.dimension_name));
  if (!liveDoors.length) console.log(`[launcher] ${dimensionName}: no Door newer than ${DOOR_LIVE_MS / 60000} min — quiet: starting it from its ${dim.doors.length} saved Door(s); you will be alone until someone else arrives`);

  const knownMap = mapFromDoors(dim);
  // 'far' ("Join my team") lands 30–50 hexes out, past the known map, on a hex
  // the deterministic map says is walkable; every other placement stays on it.
  const startTile = fixedTile || placeFromDoors({ members, anchorPeerId: anchorDoor?.peer_id, side, placement, knownMap, preferredTile, salt: randomBytes(4).toString('hex'),
    anchorTile: anchorDoor?.tile, nearTile: placement === 'nearby' ? nearTile : null });
  if (!fixedTile && placement !== 'far' && !knownMap.has(startTile.q, startTile.r)) throw new Error('placement failed');
  console.log(`[launcher] ${dimensionName}: map from ${dim.doors.length} Doors = ${knownMap.size()} hexes in ${knownMap.blockCount()} blocks (seed ${knownMap.seed})`);
  // Hundreds of blocks don't fit comfortably in an environment variable; hand
  // the joiner a file instead.
  const mapBlocksFile = path.join(__dirname, 'sessions', dim.dimension_name, `map-blocks.${Date.now()}.json`);
  await fs.mkdir(path.dirname(mapBlocksFile), { recursive: true });
  await fs.writeFile(mapBlocksFile, JSON.stringify(knownMap.blocks()));
  // Per-Door map share inputs for the joiner's HUD telemetry (nodes known only via their Door).
  const doorMapsFile = mapBlocksFile.replace(/map-blocks\./, 'door-maps.');
  await fs.writeFile(doorMapsFile, JSON.stringify(doorMapSummaries(dim, knownMap)));

  // Network hints from every Door: bus relays (required), plus direct-link
  // addresses that may or may not be reachable from here.
  const relays = new Set(DEFAULT_RELAYS); const bootstrap = new Set(extraBootstrap); const gunRelays = new Set(extraGunUrls);
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
  const clockEnv = await startClockEnv(dim);
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
    DOOR_MAPS_FILE:    doorMapsFile,
    BOOTSTRAP:         [...bootstrap].join(','),
    PEER_GUN_URLS:     [...gunRelays].join(','),
    PEER_PUBLIC_IP:    publicIp,
    BIND_HOST:         publicIp === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
    JOIN_SYNC_WAIT_MS: liveDoors.length ? '8000' : '500',
    ...clockEnv,
    ...commonPeerEnv(),
    NOSTR_RELAYS:      [...relays].join(','),
    HUMAN:             human ? '1' : '',
    ...extraEnv,
  });
  const ok = await waitForPort(portHttp);
  if (!ok) throw new Error(`peer did not come up on :${portHttp}`);
  let regenOut = [];
  if (probe) {
    const mine = new Set(children.filter(c => c._dim === dim.dimension_name).map(c => c._name));
    const heard = ((await probe).peers || []).filter(id => !mine.has(id));
    if (heard.length) console.log(`[launcher] ${dim.dimension_name}: ${heard.length} peer(s) answer on the bus (${heard.slice(0, 3).join(', ')}) — it is live, no monster regenerated`);
    else regenOut = nearestMonsters(regenAll, startTile, REGEN_MAX);
  }
  return { peerPort: portHttp, status: 'joined', dimension: dim.dimension_name, door: anchorDoor?.peer_id || null, placement, startTile, live_doors: liveDoors.length, label: peerLabel, side,
    ...(regen ? { regen: regenOut, regen_known: regenAll.length } : {}) };
}

// The last known clock of `dim` (user 2026-11-17: "start at the last known game state, round and turn"): the most
// advanced of its Door clocks and this box's TMJ saves of it (merge-order.mjs lastKnownClock) → START_ACTION for
// every peer a join starts (the hero, its allies, the regenerated monsters: one clock for all). peer.mjs uses it
// only when no live node other than wild monsters answers its join sync. Memoised on the dim record.
async function startClockEnv(dim) {
  if (dim._startClockEnv && Date.now() - dim._startClockAt < 60_000) return dim._startClockEnv;   // one join's peers; a cached dim record never freezes it
  dim._startClockAt = Date.now();
  const id = dimIdOf(dim);
  const saves = (await listLocalTmjSaves(DIMENSIONS_DIR).catch(() => [])).filter(s => !s.private && (s.dim_id === id || s.dim_name === dim.dimension_name));
  const k = lastKnownClock([...doorClockCands(dim.doors), ...saves.map(s => saveClockCand(s))]);
  if (k) console.log(`[launcher] ${dim.dimension_name}: last known clock turn ${k.turn} round ${k.round} (action ${k.action}, ${k.source})`);
  return (dim._startClockEnv = k ? { START_ACTION: String(k.action), START_CLOCK_SRC: `${k.source} T${k.turn}.R${k.round}` } : {});
}

// A quiet join's Door-known monsters (user ruling 2026-11-15): each its own npc_b bot peer on its last tile with its
// life, under its old peer id (the Doors' record of it is superseded, not doubled), bootstrapping off the peers this
// join already started. Failures are reported per monster.
async function startRegenMonsters({ dim, hero, monsters, extraBootstrap = [], extraGunUrls = [] }) {
  const bootstrap = [...extraBootstrap], gunUrls = [...extraGunUrls], out = [];
  for (const port of [hero.peerPort, ...(hero.allies || []).map(a => a.peerPort).filter(Boolean)]) {
    try {
      const st = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
      for (const a of st.multiaddrs || []) bootstrap.push(a);
      if (st.gun_url) gunUrls.push(st.gun_url);
    } catch (e) { console.warn(`[launcher] could not read :${port} addresses: ${e.message}`); }
  }
  for (const m of monsters) {
    try {
      const r = await joinDimension({ dimensionName: dim.dimension_name, doorId: null, placement: 'far', side: 'npc_b', dim, startTile: m.tile,
        characterId: '', creatureId: m.creature_id, label: m.label, entityName: m.name, extraBootstrap: bootstrap, extraGunUrls: gunUrls,
        extraEnv: { START_LIFE: m.life ? String(m.life) : '', PROFILE_FILE: '', PROFILE_CHAR_ID: '', PROFILE_TEAM: '' } });
      console.log(`[launcher] ${dim.dimension_name}: ${m.name} (${m.creature_id}) comes back as ${r.label} at its last tile (${m.tile.q},${m.tile.r})${m.life ? ` with ${m.life} life` : ''}`);
      out.push({ name: m.name, label: r.label, peerPort: r.peerPort, tile: m.tile, life: m.life });
      try { const st = await fetch(`http://127.0.0.1:${r.peerPort}/status`, { signal: AbortSignal.timeout(2000) }).then(x => x.json()); bootstrap.push(...(st.multiaddrs || [])); if (st.gun_url) gunUrls.push(st.gun_url); } catch {}
    } catch (e) {
      console.error(`[launcher] ${dim.dimension_name}: monster ${m.name} failed: ${e.message}`);
      out.push({ name: m.name, error: e.message });
    }
  }
  return out;
}

// No cloning, one dimension at a time (user rulings 2026-11-15): which of `chars` (profile characters) are alive in
// ANY dimension — by the Doors of every published dimension (profile_char_id, else base character + name;
// join-plan.mjs aliveInDimensions; `dim` first, as just read) or as a running peer of this launcher anywhere
// (PROFILE_CHAR_ID, alive by /status — an unanswering one counts as alive). Throws 409 naming the dimension.
// `dim` = null for Create Dimension / Test launches (no target yet); `except` = the dimension a Restore goes back
// to — alive THERE is the allowed way back (user ruling 2026-11-15), only the others refuse.
async function refuseAliveHere(dim, chars, { except = null } = {}) {
  chars = chars.filter(Boolean);
  if (!chars.length) return;
  let all = [];
  try { all = await listPublishedDimensions({ sync: false }); } catch (e) { console.warn(`[launcher] one-dimension check: cannot list dimensions (${e.message}) — checking ${dim?.dimension_name || 'the running peers'} only`); }
  // Only LIVE presence counts in other dimensions (user 2026-11-16: a record left alive in a quiet dimension never
  // blocks joining elsewhere; a live shadow does); in the join target `dim` any-age records still refuse (no clone).
  const hits = aliveInDimensions([dim, ...all].filter(d => d && d.dimension_name !== except), chars, { anyAgeIn: dim?.dimension_name ?? null });
  for (const c of chars) {
    if (hits.some(h => h.character.id === c.id)) continue;
    const run = children.filter(x => x._profileCharId === c.id && !x._private && x.exitCode === null && x.signalCode === null && (except == null || x._dim !== except));
    for (const x of run) {
      const st = x._http ? await fetch(`http://127.0.0.1:${x._http}/status`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => null) : null;
      const life = st?.entity?.life;
      if (life == null || life > 0) { hits.push({ character: c, dimension_name: x._dim || '?', unit: { peer_id: x._name, life: life ?? '?' } }); break; }
    }
  }
  if (hits.length) throw Object.assign(new Error(aliveWhereText(hits)), { status: 409 });
}

// Running copies of one peer of a dimension on this box: this launcher's own
// children, plus (Linux) any other node peer.mjs whose env says the same
// DIM_NAME + PEER_LABEL - e.g. one started by an earlier launcher run.
function localPeerProcs(dimName, label) {
  const out = children.filter(c => c._dim === dimName && !c._private && c._name === `peer:${label}` && c.exitCode === null && !c.killed)
    .map(c => ({ pid: c.pid, http: c._http }));
  if (process.platform === 'linux') {
    let pids = [];
    try { pids = fsSync.readdirSync('/proc').filter(d => /^\d+$/.test(d)); } catch {}
    for (const pid of pids) {
      if (out.some(o => String(o.pid) === pid)) continue;
      try {
        if (!fsSync.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('peer.mjs')) continue;
        const env = Object.fromEntries(fsSync.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
          .map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
        if (env.DIM_NAME === dimName && env.PEER_LABEL === label) out.push({ pid: Number(pid), http: Number(env.PEER_PORT_HTTP) || null });
      } catch {}
    }
  }
  return out;
}
// Stop them (SIGTERM, then SIGKILL after 5 s) and wait until they are gone, so
// the replacement can take the same peer id without two of "me" in the mesh.
async function stopPeerProcs(procs) {
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const p of procs) { try { process.kill(p.pid, 'SIGTERM'); } catch {} }
  for (let i = 0; i < 50 && procs.some(p => alive(p.pid)); i++) await new Promise(r => setTimeout(r, 100));
  for (const p of procs) if (alive(p.pid)) { try { process.kill(p.pid, 'SIGKILL'); } catch {} }
  for (let i = 0; i < 20 && procs.some(p => alive(p.pid)); i++) await new Promise(r => setTimeout(r, 100));
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
  const ents = (entitiesLayer.objects || []).map(o => ({ p: entProps(o), name: o.name }));
  // "Me" is the hero that wrote the save (props.peer_id); saves written by a
  // summon or monster (before only heroes saved) and older saves without the
  // field fall back to the first human hero in the roster.
  const isHero = e => ['player', 'player_c', 'player_d'].includes(String(e.p.alliance || '')) && String(e.p.source_id || '').startsWith('char_');
  const myId = String(props.peer_id || (props.peer_label ? `peer:${props.peer_label}` : ''));
  // The author on any side: only human hands write saves (a human npc_b hero too, user ruling 2026-11-15).
  const playerEnt = (myId && ents.find(e => e.p.peer_id === myId && String(e.p.source_id || '').startsWith('char_'))) || ents.find(isHero);
  const myLabel = String(playerEnt?.p.peer_id || '').replace(/^peer:/, '');
  // One dimension at a time (user ruling 2026-11-15): the saved hero as a profile character (base character + name,
  // as the phone matches it) must not be alive in ANOTHER dimension; alive in this one = the allowed way back.
  const savedPc = playerEnt && loadProfile(profilePath()).characters
    .find(c => c.base_character === String(playerEnt.p.source_id || '') && c.name === playerEnt.name);
  // A private test game's save (private.json beside it) comes back private: no one-dimension check, no Radicle
  // rejoin, the private env again (user 2026-11-16).
  const priv = await readPrivateMark(path.dirname(absPath));
  if (savedPc && !priv) await refuseAliveHere(null, [savedPc], { except: DIM_NAME });
  const savedTile = playerEnt && Number.isInteger(playerEnt.p.tile_q) && Number.isInteger(playerEnt.p.tile_r)
    ? { q: playerEnt.p.tile_q, r: playerEnt.p.tile_r } : null;
  // Still published on Radicle (any Door / commit, live or not)? Then join that
  // dimension as me rather than cold-respawning a private copy of it:
  //   - a copy of me still running on this box -> read its tile / life / class,
  //     stop it, and take its place under the same peer id;
  //   - else my own Door (same peer id) -> its tile if it is newer than the save;
  //   - else the saved tile. Only a dimension Radicle doesn't know is respawned.
  if (radicleEnv.enabled && playerEnt && !priv) {
    let dim = null;
    try {
      dim = (await listPublishedDimensions()).find(d => d.dimension_name === DIM_NAME);
    } catch (e) {
      console.warn(`[launcher] Radicle lookup failed (${e.message}); falling back to cold respawn`);
    }
    {
      // Published: join it or fail — a cold respawn here would put a second,
      // private copy of the whole mesh into a dimension others are still in.
      if (dim?.doors?.length && !dim.legacy) {
        const wantLabel = (label || '').trim() || myLabel || null;
        const myDoor = wantLabel ? dim.doors.find(d => d.peer_id === `peer:${wantLabel}`) : null;
        let tile = savedTile, life = Number(playerEnt.p.hp) || 0, classId = playerEnt.p.class_id || '', how = 'saved tile';
        if (myDoor?.tile && Date.parse(myDoor.pushed_at || 0) > Date.parse(props.saved_at || 0) && (myDoor.life ?? 1) > 0) {
          tile = { q: myDoor.tile.q, r: myDoor.tile.r }; life = Number(myDoor.life) || life; how = 'my newest Door';
        }
        // Hero shadows (rule_hero_shadow): a shadow of me stood in after the save → I take it over (its tile, its
        // life, REPLACES_PEER_ID); killed → I died there, the restore must not bring me back alive.
        const sh = wantLabel ? heroShadowIn(dim.doors, `peer:${wantLabel}`, Date.parse(props.saved_at || 0) || 0) : null;
        if (sh?.dead) throw Object.assign(new Error(`${playerEnt.name || wantLabel} died in ${DIM_NAME} as its shadow${sh.killer_name ? ` (killed by ${sh.killer_name})` : ''} — it cannot come back there`), { status: 409 });
        if (sh) { tile = sh.tile || tile; life = sh.life; how = `my shadow ${sh.peer_id}`; }
        const running = wantLabel ? localPeerProcs(DIM_NAME, wantLabel) : [];
        let replaced = false;
        if (running.length) {
          const st = running[0].http ? await fetch(`http://127.0.0.1:${running[0].http}/status`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()).catch(() => null) : null;
          if (st?.entity?.tile && (st.entity.life ?? 0) > 0) {
            tile = { q: st.entity.tile.q, r: st.entity.tile.r }; life = st.entity.life; classId = st.entity.classId || classId; how = 'my running peer';
          }
          console.log(`[launcher] ${DIM_NAME}: ${wantLabel} is already in the dimension (pid ${running.map(r => r.pid).join(',')}) — replacing it`);
          await stopPeerProcs(running);
          replaced = true;
        } else if (myDoor && Date.now() - Date.parse(myDoor.pushed_at || 0) < DOOR_LIVE_MS && (myDoor.life ?? 0) > 0) {
          console.warn(`[launcher] ${DIM_NAME}: ${wantLabel}'s Door is live but no copy runs on this box — it may be playing elsewhere; taking the id over anyway`);
        }
        console.log(`[launcher] ${DIM_NAME} is on Radicle (${dim.doors.length} Door${dim.doors.length === 1 ? '' : 's'}) — joining as ${wantLabel || 'a new peer'} at ${how} (${tile?.q},${tile?.r})`);
        const out = await joinDimension({
          dimensionName: DIM_NAME, doorId: myDoor ? myDoor.peer_id : null, placement: 'nearby',
          side: ['player', 'player_c', 'player_d', 'npc_b'].includes(playerEnt.p.alliance) ? playerEnt.p.alliance : 'player', human: true,
          characterId: String(playerEnt.p.source_id || '') || randomCharacter().id,
          creatureId: '', label: wantLabel,
          entityName: playerEnt.name || 'You',
          preferredTile: tile, ...(sh?.tile ? { startTile: sh.tile } : {}),   // the shadow's own hex: it steps down for me
          extraEnv: { ...(life > 0 ? { START_LIFE: String(life) } : {}), ...(classId ? { FORCE_CLASS: classId } : {}), ...(sh ? { REPLACES_PEER_ID: sh.peer_id } : {}) },
        });
        return { ...out, status: replaced ? 'replaced' : 'rejoined', tmj: absPath, savedTile, tile, from: how, ...(sh ? { took_over: sh.peer_id } : {}) };
      }
      if (dim) console.log(`[launcher] ${DIM_NAME} has no joinable Doors on Radicle — cold-respawning the whole mesh from TMJ`);
      else console.log(`[launcher] ${DIM_NAME} is not on Radicle — cold-respawning the whole mesh from TMJ`);
    }
  }

  if (startedDimension) return { ...startedDimension, status: 'already-running' };
  const ip = priv ? '127.0.0.1' : defaultPublicIp();
  const netEnv = priv ? { ...PRIVATE_TEST_ENV, TEST_MODE: String(priv.mode || 'test') } : { PEER_PUBLIC_IP: ip, BIND_HOST: isLoopback(ip) ? '127.0.0.1' : '0.0.0.0' };
  // Restore the SAME roster shape startDimension uses, so the ally and foes
  // are present (otherwise the launcher's "my ally died before my dimension
  // loaded" happens — there is simply no ally spawned). Only player-1 reads
  // the TMJ (hydrating map / obstacles / tokens / traps); the others catch
  // up via the hashgraph's evt_map_sync.
  const savedHero = String(playerEnt?.p.source_id || '');
  const hero = savedHero ? { id: savedHero, name: String(playerEnt?.p.name || savedHero) } : randomCharacter();
  const roster = [
    { label: (label || '').trim() || 'player-1', alliance: 'player', character: hero.id, creature: '',                  name: savedHero ? hero.name : `You (${hero.name})`, tile: { q: 1, r: 2 }, restore: true },
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
  startedDimension = { peerPort: peers[0].http, dimensionName: DIM_NAME, ...(priv ? { private: true, dimensionId: DIM_ID } : {}) };
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
      // The whole respawned roster starts at the save's clock (user 2026-11-17), not T0.
      START_TURN: String(Number(props.turn) || 0), START_ROUND: String(Number(props.round) || 0), START_CLOCK_SRC: `save ${path.basename(path.dirname(absPath))}`,
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

// A dimension this launcher has peers running in (its roster or any live child of it).
function dimensionRunning(name) {
  if (!name) return false;
  if (startedDimension?.dimensionName === name && !startedDimension.private) return true;
  return children.some(c => c._dim === name && !c._private && c.exitCode === null && c.signalCode === null);
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
    // Each save carries turn / hexes / local_bytes / last_active / old (dims-local.mjs enrichDimensions).
    try {
      const { saves } = await enrichDimensions({ saves: await listLocalTmjSaves(DIMENSIONS_DIR), hidden: await loadHidden(), branches: await localDimensionBranches(),
        branchBytes: localBranchBytes, running: dimensionRunning });
      return json(200, { ok: true, baseDir: DIMENSIONS_DIR, old_after_ms: OLD_AFTER_MS, items: saves });
    }
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
      // My saves first: each Door's "% shared with my copy" needs the hexes of my save of that dimension.
      const saves = await listLocalTmjSaves(DIMENSIONS_DIR).catch(() => []);
      const mines = await mineMapsOf(saves).catch(() => new Map());
      const now = Date.now();
      const raw = radicleEnv.enabled ? (await listPublishedDimensions({ sync: doSync })).map(d => describeDimension(d, now, { mine: mines.get(dimIdOf(d)) || null })) : [];
      // + on_radicle / saved_locally / local_bytes / last_active / old / hexes / turn_max; tombstoned ones dropped.
      const { radicle: items } = await enrichDimensions({ radicle: raw, saves, hidden: await loadHidden(),
        branches: await localDimensionBranches(), branchBytes: localBranchBytes, running: dimensionRunning });
      // Hero shadows (rule_hero_shadow): a fallen shadow of one of my profile characters → its death card leaves
      // the profile now (game/shadow-settle.mjs, once per gift id); the killer already has it.
      const settled = await import('./shadow-settle.mjs').then(m => m.settleFromDimensions(profilePath(), raw)).catch(e => { console.warn(`[launcher] shadow settle failed: ${e.message}`); return []; });
      for (const s of settled) console.log(`[launcher] shadow: ${s.text}`);
      return json(200, { ok: true, enabled: radicleEnv.enabled, reason: radicleEnv.enabled ? null : radicleEnv.reason, door_live_ms: DOOR_LIVE_MS, old_after_ms: OLD_AFTER_MS, synced: doSync, items,
        ...(settled.length ? { shadow_settled: settled } : {}) });
    } catch (e) {
      return json(200, { ok: false, enabled: radicleEnv.enabled, reason: e.message, synced: doSync, items: [] });
    }
  }
  if (req.method === 'POST' && p === '/api/dimensions/delete') {
    // ✕ on an old dimension (user ruling 2026-11-15): local copy only — the save dir, the tape dir, the local
    // bare / work-tree branch; a Radicle-listed one is tombstoned in the profile dir. Never a push, never `rad`.
    try {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(400, { ok: false, error: 'bad JSON' }); }
      let radicle = [];
      if (radicleEnv.enabled) { try { radicle = (await listPublishedDimensions({ sync: false })).map(d => describeDimension(d, Date.now())); } catch { radicle = []; } }
      const saves = await listLocalTmjSaves(DIMENSIONS_DIR);
      const branches = await localDimensionBranches();
      const plan = await planDelete(body, { radicle, saves, branches, running: dimensionRunning });
      const out = await removeLocalDirs(plan);
      const git = plan.name ? await forgetLocalDimension(plan.name) : { bare: false, work_trees: 0, skipped: [] };
      if (plan.onRadicle) await hideDimension(plan.name);
      console.log(`[launcher] deleted local copy of ${plan.name || plan.dimId}: ${out.removed.length} dir(s), bare branch ${git.bare ? 'dropped' : 'absent'}, ${git.work_trees} work tree(s)${plan.onRadicle ? ', hidden (still on Radicle)' : ''}`);
      return json(200, { ok: true, dimension_name: plan.name, dim_id: plan.dimId, removed: out.removed, freed_bytes: out.freed_bytes,
        bare_branch: git.bare, work_trees: git.work_trees, work_trees_skipped: git.skipped, hidden: plan.onRadicle, note: LOCAL_ONLY_NOTE });
    } catch (e) {
      return json(e.status || 500, { ok: false, error: e.message });
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
      // Create Dimension (profile panel): the top profile character is the hero (random without one).
      if (body.mode === 'host' && body.characterId === 'profile:top') out = await startDimension(body, { hero: topCharacter(loadProfile(profilePath())), allies: null });
      else if (body.mode === 'host' || body.mode === 'start' || body.mode === 'test-random') out = await startDimension(body);
      else if (body.mode === 'test-character' || body.mode === 'test-team' || body.mode === 'join-team') out = await launchProfile(body);
      else if (body.mode === 'join') out = await joinFromList(body);
      else if (body.mode === 'restore') out = await restoreDimension(body);
      else if (body.mode === 'restore-here') out = await restoreHere(body);
      // "⇱ Dimension Out" from the start screen (rule_dimension_out): restore-here + the 10-round channel at once.
      else if (body.mode === 'dim-out') out = await restoreHere(body, { dimOut: true });
      else throw new Error(`unknown mode "${body.mode}"`);
      return json(200, { ok: true, ...out });
    } catch (e) {
      console.error(`[launcher] /api/launch failed: ${e.message}`);
      return json(e.status || 500, { ok: false, error: e.message });
    } finally { launching = false; }
  }
  if (await handleProfileApi(req, res, p, { file: profilePath(), dataDir: DATA_DIR })) return;
  res.writeHead(404); res.end('not found');
}

// ---------- profile launches (user ruling 2026-11-13) ----------
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

// test-character / test-team / join-team: the profile's characters play.
async function launchProfile(body) {
  const prof = loadProfile(profilePath());
  if (!prof.characters.length) throw badRequest('Create a character first');
  if (body.mode === 'test-character') {
    const c = characterOf(prof, body.profileCharId);
    if (!c) throw badRequest(`no profile character "${body.profileCharId}"`);
    return startDimension(body, { hero: c, allies: null });
  }
  if (body.mode === 'test-team') {
    const count = Number(body.count);
    const team = teamCharacters(prof);
    if (body.tier != null && !['strong', 'reachable'].includes(body.tier)) throw badRequest('tier must be "reachable" or "strong"');
    if (!Number.isInteger(count) || count < 2 || count > team.length) {
      throw badRequest(team.length < 2
        ? `Test my team needs at least 2 characters (the profile has ${team.length})`
        : `count must be a whole number from 2 to ${team.length} (your characters)`);
    }
    return startDimension(body, { hero: team[0], allies: team.slice(1, count), tier: body.tier === 'strong' ? 'strong' : 'reachable' });
  }
  // join-team: the top character opens a gate 30–50 hexes from that Door; with count > 1 the next count−1
  // characters of the team order join beside it as npc_a ally bots on the tier ring (like Test my team).
  if (!body.dimensionName) throw badRequest('dimensionName is required');
  if (!body.doorId) throw badRequest('doorId is required');
  const team = teamCharacters(prof);
  const c = team[0] || topCharacter(prof);
  const count = body.count == null ? 1 : Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > Math.max(1, team.length)) throw badRequest(`count must be a whole number from 1 to ${Math.max(1, team.length)} (your characters)`);
  if (body.tier != null && !['strong', 'reachable'].includes(body.tier)) throw badRequest('tier must be "reachable" or "strong"');
  if (!radicleEnv.enabled) throw new Error(`radicle disabled: ${radicleEnv.reason}`);
  const dim = (await listPublishedDimensions()).find(d => d.dimension_name === body.dimensionName);
  if (!dim) throw new Error(`dimension "${body.dimensionName}" is not published on Radicle`);
  const allies = team.slice(1, count);
  // No cloning, one dimension at a time: every member must be dead / absent in EVERY dimension (else the whole join
  // is refused, naming who and where).
  await refuseAliveHere(dim, [c, ...allies]);
  // A NEW team (user rulings 2026-11-15), not allied with the units there, on the first FREE side among A / C / D
  // ("Fourth team is joining at 4th side on a door that is distant to them"); none free → refused.
  const side = newTeamSide(dimensionUnits(dim.doors).sides);
  if (!side) throw Object.assign(new Error(`${dim.dimension_name}: ${NO_FREE_SIDE}`), { status: 409 });
  const hero = await joinDimension({
    dimensionName: body.dimensionName, doorId: body.doorId, placement: 'far', side, dim, regen: true, human: true,
    characterId: c.base_character, creatureId: '', label: body.label || '', entityName: c.name,
    extraEnv: { ...profileEnv(profilePath(), c), TEAM_GATE: '1', TEAM_GATE_DOOR: String(body.doorId) },
  });
  console.log(`[launcher] ${dim.dimension_name}: ${c.name} opens a new Door as a new team (${side}${allies.length ? `, allies ${teamBotSide(side)}` : ''})`);
  const out = { ...hero };
  if (allies.length) out.allies = await joinTeamAllies({ dim, hero, allies, tier: body.tier === 'strong' ? 'strong' : 'reachable', side: teamBotSide(side), occupied: (hero.regen || []).map(m => `${m.tile.q},${m.tile.r}`) });
  if (hero.regen?.length) out.monsters = await startRegenMonsters({ dim, hero: out, monsters: hero.regen });
  return out;
}

// A unit's name in the Dimensions list (or the older explorer's join): the top profile character by default
// (withProfileJoiner), refused if it is alive in that dimension; a quiet dimension brings its monsters back.
async function joinFromList(body) {
  if (body.nearTile != null && !validTile(body.nearTile)) throw Object.assign(new Error('nearTile must be {q, r} integers'), { status: 400 });
  if (!radicleEnv.enabled) throw new Error(`radicle disabled: ${radicleEnv.reason}`);
  const b = withProfileJoiner(body);
  const dim = (await listPublishedDimensions()).find(d => d.dimension_name === b.dimensionName);
  if (!dim) throw new Error(`dimension "${b.dimensionName}" is not published on Radicle`);
  // The owner comes back (rule_unattended_character, user 2026-11-16: "Once the unattended character owning player
  // joins back he automatically gains control of its character back"): my profile character standing unattended
  // there → this join is its restore-here takeover (its life, its tile). Its own record (live, or left alive while
  // the dimension was quiet) still refuses below — "rejoin/restore there" (no clone).
  const back = b._profileChar ? restoreHereTarget(dim, b._profileChar) : null;
  if (back?.replaces) {
    console.log(`[launcher] ${dim.dimension_name}: ${b._profileChar.name} is unattended there (${back.replaces}) — the join takes it back`);
    return restoreHere({ dimensionName: dim.dimension_name, profileCharId: b._profileChar.id });
  }
  if (b._profileChar) await refuseAliveHere(dim, [b._profileChar]);
  // The ally-join link (rule_unattended_character): a unit-list join next to `nearPeer` as its ally — the joiner
  // publishes ally_of, the link the master of unattended characters is chosen through.
  const nearPeer = typeof body.nearPeer === 'string' && /^peer:[A-Za-z0-9_.:-]{1,80}$/.test(body.nearPeer) ? body.nearPeer : '';
  if (nearPeer && !b.creatureId) b.extraEnv = { ...(b.extraEnv || {}), ALLY_OF: nearPeer };
  // "Monster" join (user ruling 2026-11-15: "We know its type, so the same type of monster should be joined and the
  // computer should control it"): the type the Doors know (knownMonsterType) — a bot, no HUMAN. Random only when the
  // Doors know no monster.
  if (b.creatureId === 'random' || b.creatureId === 'known') {
    const t = knownMonsterType(dim, { doorId: b.doorId, nearTile: b.nearTile });
    if (t) { b.creatureId = t; b.entityName ||= creatureName(t); console.log(`[launcher] ${dim.dimension_name}: monster join as the known type ${t}`); }
    else b.creatureId = 'random';
  }
  // I play what I join (user ruling 2026-11-15): a character next to a monster is a human npc_b (HUMAN=1).
  const out = await joinDimension({ ...b, dim, regen: true, human: !b.creatureId });
  if (out.regen?.length) out.monsters = await startRegenMonsters({ dim, hero: out, monsters: out.regen });
  return out;
}

// "↻ Restore <name> here" (user 2026-11-16: "I don't know on which old dimension I am alive. I should see it in the
// list below as a restore one, so I announce to the other nodes that I activated it again"). Body
// { mode: 'restore-here', dimensionName, profileCharId }. The character comes back under its own peer id at its
// last tile with its last life (join-plan.mjs restoreHereTarget; a live shadow is taken over: REPLACES_PEER_ID =
// the shadow, its life), from the Doors' map — a quiet dimension gets its Door-known monsters back as on any quiet
// join. Its first Door is pushed at once (RADICLE_PUSH_FIRST_SEC) — that push + the bus presence is the
// announcement that makes other nodes list the dimension LIVE. One dimension at a time: LIVE presence in another
// dimension refuses (stale records elsewhere don't). A copy of it still running on this box is replaced.
async function restoreHere(body, { dimOut = false } = {}) {
  const prof = loadProfile(profilePath());
  const c = characterOf(prof, String(body.profileCharId || ''));
  if (!c) throw badRequest(`no profile character ${body.profileCharId || '(none given)'}`);
  const name = String(body.dimensionName || '').trim();
  if (!name) throw badRequest('dimensionName is required');
  if (!radicleEnv.enabled) throw new Error(`radicle disabled: ${radicleEnv.reason}`);
  const dim = (await listPublishedDimensions()).find(d => d.dimension_name === name);
  if (!dim?.doors?.length) throw Object.assign(new Error(`${name} is not published on Radicle with Doors — use "Load old Dimension"`), { status: 404 });
  const t = restoreHereTarget(dim, c);
  if (!t) throw Object.assign(new Error(`${c.name} is not alive in ${name} (dead there, or never there)`), { status: 409 });
  await refuseAliveHere(null, [c], { except: name });
  const running = localPeerProcs(name, t.label);
  if (running.length) { console.log(`[launcher] ${name}: ${t.label} still runs here (pid ${running.map(r => r.pid).join(',')}) — replacing it`); await stopPeerProcs(running); }
  const side = ['player', 'player_c', 'player_d', 'npc_b'].includes(t.alliance) ? t.alliance : 'player';
  // My last tile, unless another live unit (not me, not my shadow) stands on it now → the nearest free hex.
  const taken = t.tile && unionMembers(dim.doors).some(m => m.peer_id !== t.peer_id && m.peer_id !== t.replaces && (m.life ?? 1) > 0 && m.tile?.q === t.tile.q && m.tile?.r === t.tile.r);
  console.log(`[launcher] ${name}: restoring ${c.name} as ${t.label} at (${t.tile?.q},${t.tile?.r}) hp ${t.life ?? '?'}${t.replaces ? ` — taking over its shadow ${t.replaces}` : ''}${t.live ? '' : ' (quiet dimension: it wakes up)'}`);
  const out = await joinDimension({
    dimensionName: name, dim, doorId: t.doorId, placement: 'nearby', side, human: true, regen: true,
    characterId: c.base_character, creatureId: '', label: t.label, entityName: c.name,
    ...(t.tile && !taken ? { startTile: t.tile } : { preferredTile: t.tile }),
    extraEnv: { ...profileEnv(profilePath(), c), ...(t.life > 0 ? { START_LIFE: String(t.life) } : {}), ...(t.replaces ? { REPLACES_PEER_ID: t.replaces } : {}),
      RADICLE_PUSH_FIRST_SEC: process.env.RESTORE_PUSH_FIRST_SEC || '1', ALLY_OF: '', DIM_OUT_ON_START: dimOut ? '1' : '' },
  });
  if (out.regen?.length) out.monsters = await startRegenMonsters({ dim, hero: out, monsters: out.regen });
  if (dimOut) console.log(`[launcher] ${name}: ${c.name} starts its Dimension Out at once`);
  return { ...out, status: dimOut ? 'dim-out' : 'restored-here', character: c.name, took_over: t.replaces || null, dim_out: dimOut };
}

// Ally tiles for "Join my team": a walkable hex of the tier ring around the hero's start tile per ally
// (deterministic in seed + character id), never two on one hex. null = the whole ring is blocked.
function teamAllyTiles(home, allies, { tier = 'strong', seed, occupied = [] } = {}) {
  const ring = TEAM_TIER_RING[tier] || TEAM_TIER_RING.strong;
  const taken = new Set([...occupied, `${home.q},${home.r}`]);
  return allies.map(c => {
    const t = tileInRing(home, { ...ring, seed, salt: c.id, occupied: taken });
    if (t) taken.add(`${t.q},${t.r}`);
    return t;
  });
}
// The hero's team mates: each its own peer (alliance npc_a, profileEnv) on its ring tile, same DIM env and
// map blocks as the hero, bootstrapping off the peers already up. Failures are reported per ally; the
// hero stays in.
// `side`: the team's bot side (npc_a, npc_c for a third-team hero); `occupied`: "q,r" already taken (regenerated monsters).
async function joinTeamAllies({ dim, hero, allies, tier, side = 'npc_a', occupied = [] }) {
  const seed = mapFromDoors(dim).seed;
  const tiles = teamAllyTiles(hero.startTile, allies, { tier, seed, occupied });
  const bootstrap = [], gunUrls = [];
  const addPeer = async (port) => {
    try {
      const st = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
      for (const a of st.multiaddrs || []) bootstrap.push(a);
      if (st.gun_url) gunUrls.push(st.gun_url);
    } catch (e) { console.warn(`[launcher] could not read :${port} addresses: ${e.message}`); }
  };
  await addPeer(hero.peerPort);
  const out = [];
  for (const [i, c] of allies.entries()) {
    const tile = tiles[i];
    if (!tile) { out.push({ name: c.name, error: `no walkable hex ${TEAM_TIER_RING[tier].min}–${TEAM_TIER_RING[tier].max} hexes from the hero` }); continue; }
    try {
      const r = await joinDimension({
        dimensionName: dim.dimension_name, doorId: null, placement: 'far', side, dim, startTile: tile,
        characterId: c.base_character, creatureId: '', label: `${hero.label}-ally${i + 1}`, entityName: c.name,
        extraBootstrap: bootstrap, extraGunUrls: gunUrls, extraEnv: profileEnv(profilePath(), c),
      });
      console.log(`[launcher] ${dim.dimension_name}: ${c.name} joins ${hero.label}'s team as ${r.label} at (${tile.q},${tile.r}) (${tier})`);
      out.push({ name: c.name, label: r.label, peerPort: r.peerPort, startTile: tile });
      await addPeer(r.peerPort);
    } catch (e) {
      console.error(`[launcher] ${dim.dimension_name}: ally ${c.name} failed: ${e.message}`);
      out.push({ name: c.name, error: e.message });
    }
  }
  return out;
}

// A plain join with no explicit character (or characterId 'profile:top') joins
// as the top profile character when the profile has one.
function withProfileJoiner(body) {
  const wantsTop = body.characterId === 'profile:top' || (!body.characterId && !body.creatureId);
  if (!wantsTop) return body;
  const c = topCharacter(loadProfile(profilePath()));
  if (!c) return body.characterId === 'profile:top' ? { ...body, characterId: '' } : body;
  return {
    ...body, characterId: c.base_character, creatureId: '', entityName: c.name, _profileChar: c,
    extraEnv: { ...(body.extraEnv || {}), ...profileEnv(profilePath(), c) },
  };
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
  if (LAUNCHER_MODE && await handleEditorRequest(req, res, url, { repoRoot: path.resolve(__dirname, '..'), dataDir: DATA_DIR, gameDir: __dirname, profileFile: profilePath(), port: PORT })) return;
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
  if (p.startsWith('/data/')) {
    const dc = definitionsCollectionText(DATA_DIR, p.slice('/data'.length));
    if (dc) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(dc); }
    return serve(path.join(DATA_DIR, p.slice('/data/'.length).replace(/\.\./g, '')));
  }
  // Resources quoted in data/*.json (sprites + sounds, mapping files, schema).
  // Binary files resolve through symlinks into ../../warlords_battlecry_resources;
  // readFile follows them, and the path-traversal check happens before.
  // Catalogue JSONs come from this repo's assets/, media from the resolved media root (asset-root.mjs).
  if (p.startsWith('/assets/')) {
    const abs = assetFile(p.slice('/assets/'.length).replace(/\.\./g, ''));
    if (!abs) { res.writeHead(404); return res.end('not found'); }
    return serve(abs);
  }
  const rel = p === '/' ? '/index.html' : p;
  const abs = path.join(__dirname, rel.replace(/\.\./g, ''));
  if (!abs.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
  await serve(abs);
});
const PORT = Number(process.env.UI_PORT || 7357);
server.listen(PORT, '127.0.0.1', () => console.log(`[ui-server] http://127.0.0.1:${PORT}${LAUNCHER_MODE ? ' (launcher mode)' : ''}`));

// Profile ⇄ chaosD6-Profiles on Radicle (teams/<Team> branch; profile-radicle.mjs). Keeps running while games
// write deaths / kills into profile.json. PROFILE_SYNC=0 turns it off.
if (process.env.PROFILE_SYNC !== '0') {
  import('./profile-radicle.mjs').then(({ startProfileSync }) => attachProfileSync(startProfileSync({ file: profilePath() })))
    .catch(e => console.error(`[profile-sync] not started: ${e.message}`));
}

process.on('SIGINT', () => { for (const c of children) try { c.kill('SIGINT'); } catch {}; process.exit(0); });
