// A single ChaosD6 peer. One of these runs per entity (hero, ally, foe1, foe2) and
// forms a strong-region mesh with the others. The mesh is REAL:
//
//   • libp2p (TCP transport + Noise + Yamux + Gossipsub) broadcasts
//     per-action hashgraph envelopes on topic  /chaos/<dim_id>/strong
//     — matches sync_handshake_per_action (evt_action_commit, _reveal, _state_hash).
//   • GunDB holds the shared, offline-first CRDT map state
//     (positions, HP, hands committed, map_delta) — one Gun instance per peer, with
//     a WebSocket relay between peers so the graph syncs across processes. Matches
//     sync_turn_commit and the long-tail state the spec describes.
//   • A public Nostr bus (nostr-bus.mjs) carries the same envelopes between
//     machines that cannot dial each other — there is no host anywhere.
//   • Every peer publishes its own Door (its piece of the dimension) to its
//     own Radicle namespace once a minute; Radicle is the public directory.
//   • discovery.mjs is an optional same-LAN mirror, off by default.
//
// Each peer also hosts a tiny HTTP + WebSocket server for its local browser UI so
// the user can watch (and command) their peer. Only the "player" peer is driven
// by human input; the others plan via the weighted-priority AI.

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
// @libp2p/gossipsub (not the old @chainsafe/* package — that one targets
// libp2p 2.x and bundles its own @libp2p/interface, so with libp2p 3 the two
// never exchanged a single subscription).
import { gossipsub } from '@libp2p/gossipsub';
import { identify } from '@libp2p/identify';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';

// No `gun/sea.js`: nothing here uses SEA, and its message hook runs a
// permissive JSON pre-parser over every incoming string value that crashes
// the process on plain CSV strings (yson.js "Cannot set properties of
// undefined") as soon as relays actually exchange data.
import Gun from 'gun';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import fs from 'node:fs/promises';
import { EFFECT_RULES, playableEffects, resolveEffect, roundHalfUp10, pointBuy, pointBuyPermanent, pointBuyPermanentMin, trapDamageSum, TRAP_POWER } from './effects.mjs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';

import { pushDimension, radicleEnv } from './radicle-adapter.mjs';
import { createNostrBus, DEFAULT_RELAYS } from './nostr-bus.mjs';
import { createKnownMap, initialBlock, discBlock, isBlock, seedForDimension, DEFAULT_REVEAL_RADIUS, INITIAL_SIZE, featureAt } from './js/map.js';
import { stepToward as hexStepToward, neighbours as hexNeighbours } from './js/hex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -------- config via env --------
const PEER_LABEL        = process.env.PEER_LABEL        || 'player-1';          // human-readable

// Loud crash handlers so a peer death leaves a trail in the file log rather
// than vanishing silently from the console. Especially important for monster
// peers — if their process dies, their marker fades from everyone's map after
// 90s stale and the only clue was in whatever scrolled off the terminal.
process.on('uncaughtException',  (e) => { console.error(`[${PEER_LABEL}] UNCAUGHT`, e?.stack || e); setTimeout(() => process.exit(1), 50); });
process.on('unhandledRejection', (e) => { console.error(`[${PEER_LABEL}] UNHANDLED REJECTION`, e?.stack || e); });

// Dedicated UI-input log file, kept SEPARATE from the regular peer log so
// a stream of mouse-moves/clicks can never drown out gameplay events. One
// append-only file per (dimension, peer). Written to directly from the peer
// so these never touch stdout, the console, or the browser's event log.
const _slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown-dimension';
const _dirForUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'logs', _slug(process.env.DIM_NAME));
try { fsSync.mkdirSync(_dirForUi, { recursive: true }); } catch {}
const _uiLogPath = path.join(_dirForUi, `peer_${String(PEER_LABEL).replace(/[^a-z0-9._-]+/gi, '_')}.ui.log`);
const _uiLogStream = fsSync.createWriteStream(_uiLogPath, { flags: 'a' });
_uiLogStream.on('error', () => {});
_uiLogStream.write(`\n===== ${new Date().toISOString()} — ui session start for ${PEER_LABEL} =====\n`);
function writeUiLog(line) { try { _uiLogStream.write(`${line}\n`); } catch {} }
const PEER_PORT_LIBP2P  = Number(process.env.PEER_PORT_LIBP2P  || 7400);
const PEER_PORT_HTTP    = Number(process.env.PEER_PORT_HTTP    || 7401);        // UI WebSocket + API
const PEER_PORT_GUN     = Number(process.env.PEER_PORT_GUN     || 7501);        // GunDB relay WebSocket
const DIM_NAME          = process.env.DIM_NAME         || 'Ashfall-Micro';
const DIM_ID            = process.env.DIM_ID           || 'dim-ashfall-micro';
const DOOR_ID           = process.env.DOOR_ID          || 'door-primary';
// Optional LAN accelerator. There is no host in a dimension: every peer is
// equal and the public Nostr bus (below) carries the handshake between
// machines. If a discovery.mjs URL is given we also mirror through it, but
// nothing depends on it any more.
const DISCOVERY_URL     = process.env.DISCOVERY_URL    || '';
// Networking for direct (LAN) links. BIND_HOST is the interface libp2p + the
// Gun relay listen on; PEER_PUBLIC_IP is the address peers on the same network
// can dial us at. Across the internet nobody dials anybody — the bus does it.
// The browser-UI socket always stays on loopback — it can command this peer,
// so it must never be reachable from the network.
const BIND_HOST         = process.env.BIND_HOST        || (process.env.PEER_PUBLIC_IP ? '0.0.0.0' : '127.0.0.1');
const PEER_PUBLIC_IP    = process.env.PEER_PUBLIC_IP   || '127.0.0.1';
const NOSTR_ENABLED     = (process.env.NOSTR_ENABLED || '1') !== '0';
const CHARACTER_ID      = process.env.CHARACTER_ID     || '';
const CREATURE_ID       = process.env.CREATURE_ID      || '';
const ENTITY_NAME       = process.env.ENTITY_NAME      || PEER_LABEL;
const ALLIANCE          = process.env.ALLIANCE         || 'player';              // player | npc_a | npc_b
// Summoning: a companion process is spawned by its summoner with OWNER_PEER_ID
// set; it follows that peer and vanishes when their Summoning permanent falls.
// A ∀ Summoning binds an existing creature instead — it learns its owner at
// bind time and goes back to its own side when the permanent falls.
let ownerPeerId = process.env.OWNER_PEER_ID || null;
const IS_COMPANION = !!process.env.OWNER_PEER_ID;
const IS_PHANTOM = IS_COMPANION && process.env.PHANTOM === '1';   // a Phantom mirror: falls at the first point of damage
const START_TILE        = JSON.parse(process.env.START_TILE || '{"q":1,"r":2}');
// The known map of this dimension: the initial block plus every disc a player
// has revealed. MAP_SEED defaults to a value derived from DIM_ID so every peer
// in the dimension agrees without anything being passed around; MAP_BLOCKS is
// what the launcher read from the Doors on Radicle so a joiner starts with the
// map everyone else already holds instead of waiting for Gun to catch up.
const MAP_SEED          = process.env.MAP_SEED          || seedForDimension(process.env.DIM_ID || 'dim-ashfall-micro');
const REVEAL_RADIUS     = Number(process.env.REVEAL_RADIUS || DEFAULT_REVEAL_RADIUS);
let seedBlocks = [];
try {
  seedBlocks = process.env.MAP_BLOCKS_FILE
    ? JSON.parse(fsSync.readFileSync(process.env.MAP_BLOCKS_FILE, 'utf8'))
    : JSON.parse(process.env.MAP_BLOCKS || '[]');
  if (process.env.MAP_BLOCKS_FILE) fsSync.rm(process.env.MAP_BLOCKS_FILE, { force: true }, () => {});
} catch (e) { console.warn(`[${PEER_LABEL}] could not read seed map blocks: ${e.message}`); seedBlocks = []; }
if (!Array.isArray(seedBlocks)) seedBlocks = [];
let dimMap = null;   // created once Gun is up (see "the dimension map" below)
const PEER_GUN_URLS     = (process.env.PEER_GUN_URLS   || '').split(',').filter(Boolean); // relays of other peers
const BOOTSTRAP_MADDRS  = (process.env.BOOTSTRAP || '').split(',').filter(Boolean);        // libp2p peers
const RADICLE_PUSH_SEC  = Number(process.env.RADICLE_PUSH_SEC || 60);            // demo: 60s instead of 3600s
// Round/turn clock. A round is one simultaneous action (declare → commit →
// reveal → resolve); ROUNDS_PER_TURN rounds make a turn, and only at turn end
// do characters discard leftovers and draw back to 5 (rule 7 / rule 10;
// battle_system_core.turn_structure.actions_per_round_pc = 3). The commit and
// reveal handshakes are event-driven — they complete as soon as every strong-
// region member has answered — with short caps so a silent peer can't stall
// the mesh (sync_region_tiers.failure_mode → treated as Empty Posture).
const ROUND_SEC         = Number(process.env.ROUND_SEC        || 6);
const ROUNDS_PER_TURN   = Number(process.env.ROUNDS_PER_TURN  || 3);
const COMMIT_WAIT_MS    = Number(process.env.COMMIT_WAIT_MS   || 800);
const REVEAL_WAIT_MS    = Number(process.env.REVEAL_WAIT_MS   || 1500);
const HAND_SIZE         = 5;
// Region tiers (sync_region_tiers). Movement per round is bounded so the
// strong region can be a fixed radius: an Empty Move covers at most
// EM_MAX_STEPS hexes, a Move one, so two entities can only contest a hex or
// strike each other this round if they start within 2*EM_MAX_STEPS+1 of each
// other. The handshake waits for — and the resolver/state hash cover — only the
// members inside STRONG_RADIUS; everyone further out is "reachable"/"far": we
// hear their state, we never wait for them.
const EM_MAX_STEPS      = Math.max(1, Number(process.env.EM_MAX_STEPS || 3));
const STRONG_RADIUS     = Number(process.env.STRONG_RADIUS || (2 * EM_MAX_STEPS + 2));
const REACH_RADIUS      = STRONG_RADIUS + Number(process.env.REVEAL_RADIUS || DEFAULT_REVEAL_RADIUS);

const PEER_ID_STRING    = `peer:${PEER_LABEL}`;

// Hoisted so publishPublicState's broadcastUI calls can safely fire before the
// WebSocket server comes up later in the file. Client set populates lazily.
const uiClients = new Set();
// Public Nostr bus handle; created once the peer-state machinery below exists.
// Declared up here so emitEnvelope/publishPublicState can reference it safely.
let bus = null;
function broadcastUI(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of uiClients) { try { ws.send(payload); } catch {} }
}

// -------- data layer (loaded directly from the shared folder) --------
const DATA_DIR = path.resolve(__dirname, '..', 'data');
async function loadJson(name) {
  return JSON.parse(await fs.readFile(path.join(DATA_DIR, name), 'utf8'));
}
function pickActive(entry) {
  const live = entry.versions.filter(v => v.status !== 'rejected' && v.status !== 'superseded');
  live.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const v = live[0] ?? entry.versions[0];
  return { id: entry.id, name: entry.name, tags: entry.tags || [], data: v.data };
}

const data = {};
for (const n of ['battle_system', 'actions', 'characters', 'creatures', 'skills', 'classes', 'effects', 'elements']) {
  const f = await loadJson(`${n}.json`);
  data[n] = Object.fromEntries(f.entries.map(e => [e.id, pickActive(e)]));
}
// elem_* → character stat key the element maps to (per elements.json data.stat).
// Used by the effect-damage math to look up the right stat for Σ(me - enemy).
// Golems and elementals (user spec): fixed stat blocks, summoned by their own
// effects. They live in the creature table like any monster (so a companion
// process can be one), but Summoning's random library skips them.
const BUILT_IN_CREATURES = {
  mon_golem_worldlives:   { name: 'WorldLives Golem',   stats: { vitality: 10, world: 9,  matter: 5,  will: 0 }, life: 2, actions: 2, kind: 'golem' },
  mon_golem_lifematters:  { name: 'LifeMatters Golem',  stats: { vitality: 10, world: 5,  matter: 9,  will: 0 }, life: 2, actions: 2, kind: 'golem' },
  mon_golem_worldmatters: { name: 'WorldMatters Golem', stats: { vitality: 5,  world: 10, matter: 9,  will: 0 }, life: 2, actions: 2, kind: 'golem' },
  mon_golem_living:       { name: 'Living Golem',       stats: { vitality: 20, world: 2,  matter: 2,  will: 0 }, life: 2, actions: 2, kind: 'golem' },
  mon_elemental_world:    { name: 'World Elemental',    stats: { vitality: 5,  world: 20, matter: 5,  will: 0 }, life: 3, actions: 1, kind: 'elemental' },
  mon_elemental_vital:    { name: 'Vital Elemental',    stats: { vitality: 20, world: 5,  matter: 5,  will: 0 }, life: 3, actions: 1, kind: 'elemental' },
  mon_elemental_matter:   { name: 'Matter Elemental',   stats: { vitality: 5,  world: 5,  matter: 20, will: 0 }, life: 3, actions: 1, kind: 'elemental' },
};
for (const [id, b] of Object.entries(BUILT_IN_CREATURES)) {
  data.creatures[id] = { id, name: b.name, tags: ['summon_only', b.kind], data: { stats: { ...b.stats }, life: b.life, actions_per_round: b.actions, dice_pattern: null, innate_effect: null, innate_effect_text: '', on_action_rider: null, built_in: b.kind } };
}
const ELEM_TO_STAT = {};
for (const [id, e] of Object.entries(data.elements)) ELEM_TO_STAT[id] = (e.data?.stat || '').replace(/^stat_/, '');

// -------- libp2p node --------
const privateKey = await generateKeyPair('Ed25519');
const libp2p = await createLibp2p({
  privateKey,
  addresses: {
    listen: [`/ip4/${BIND_HOST}/tcp/${PEER_PORT_LIBP2P}`],
    announce: [`/ip4/${PEER_PUBLIC_IP}/tcp/${PEER_PORT_LIBP2P}`],
  },
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: {
    identify: identify({ agentVersion: `chaosd6-dimensions/0.1.0 (${PEER_LABEL})` }),
    pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false }),
  },
});
await libp2p.start();

const TOPIC_STRONG = `/chaos/${DIM_ID}/strong`;
await libp2p.services.pubsub.subscribe(TOPIC_STRONG);

// Advertise the announce address explicitly so remote peers get the dialable
// public form, regardless of how libp2p chooses to render its own listen set.
const myMaddrs = [`/ip4/${PEER_PUBLIC_IP}/tcp/${PEER_PORT_LIBP2P}/p2p/${libp2p.peerId.toString()}`];
const myGunUrl = `http://${PEER_PUBLIC_IP}:${PEER_PORT_GUN}/gun`;
console.log(`[${PEER_LABEL}] libp2p peer id = ${libp2p.peerId.toString()}`);
console.log(`[${PEER_LABEL}] bound ${BIND_HOST}:${PEER_PORT_LIBP2P}; advertising ${myMaddrs.join(', ')}`);

// Dial bootstrap peers.
for (const addr of BOOTSTRAP_MADDRS) {
  try { await libp2p.dial(multiaddr(addr)); console.log(`[${PEER_LABEL}] dialed ${addr}`); }
  catch (e) { console.warn(`[${PEER_LABEL}] dial ${addr} failed: ${e.message}`); }
}

// -------- GunDB relay (per peer) --------
const gunHttp = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('gun relay'); });
gunHttp.listen(PEER_PORT_GUN, BIND_HOST);
// Gun needs its storage adapter to answer `get`s coming from OTHER relays —
// with `radisk: false` a put stays readable locally but every remote read is
// silently unanswered (tools/gun-selftest.mjs demonstrates it), which made
// the whole Gun tier a dead channel. Persisting to a shared folder, on the
// other hand, resurrected every previous run's members on restart (ghost
// peers in the roster). So: radisk on, but into a throw-away directory that
// is unique to this process, wiped at boot and again on exit.
const GUN_LABEL = String(PEER_LABEL).replace(/[^a-z0-9._-]+/gi, '_');
const GUN_DIR = path.join(os.tmpdir(), 'chaosd6-gun', _slug(DIM_NAME), `${GUN_LABEL}-${process.pid}`);
// Only our own label's leftovers: sibling peers of this dimension may be live.
try { for (const d of fsSync.readdirSync(path.dirname(GUN_DIR))) if (d.startsWith(`${GUN_LABEL}-`)) fsSync.rmSync(path.join(path.dirname(GUN_DIR), d), { recursive: true, force: true }); } catch {}
try { fsSync.mkdirSync(GUN_DIR, { recursive: true }); } catch {}
// Gun's Node build always loads SEA, and lib/server.js defaults `opt.faith`
// to true, which routes data coming back from the store through
// SEA.opt.pack → a permissive JSON pre-parser that throws on some plain
// string values ("Cannot set properties of undefined" in yson.js) and took
// three peers down in one swarm run. `faith: false` keeps incoming data on
// the ordinary path; the wrapper below is the belt to that brace — if pack is
// ever reached and throws, log the value once and pass the data through.
if (Gun.SEA?.opt?.pack) {
  const origPack = Gun.SEA.opt.pack;
  let packWarned = 0;
  Gun.SEA.opt.pack = function (d, cb, ...rest) {
    try { return origPack.call(this, d, cb, ...rest); }
    catch (e) {
      if (packWarned++ < 3) console.warn(`[${PEER_LABEL}] gun/SEA pack failed on ${JSON.stringify(d).slice(0, 200)}: ${e.message}`);
      return cb(d);
    }
  };
}
const gun = Gun({
  web: gunHttp,
  peers: PEER_GUN_URLS,              // mesh with the other peers' relays
  file: GUN_DIR,
  localStorage: false,
  axe: false,
  multicast: false,
  faith: false,
});
const wipeGunDir = () => { try { fsSync.rmSync(GUN_DIR, { recursive: true, force: true }); } catch {} };
process.on('exit', wipeGunDir);
console.log(`[${PEER_LABEL}] gun relay on ${myGunUrl}; peers = ${PEER_GUN_URLS.join(', ') || '(none yet)'}`);

const dimRoot = gun.get('chaosd6').get('dimensions').get(DIM_ID);
const myNode  = dimRoot.get('doors').get(DOOR_ID).get('members').get(PEER_ID_STRING);

// -------- direct-link dialing --------
// Try to open a libp2p connection to a peer we learned about (from the bus, the
// Gun graph or the optional discovery mirror). Across the internet these
// addresses are usually private and the dial fails — that's fine, the bus
// carries the traffic; a successful dial just makes the exchange faster.
// `dialled` is a cool-down, not a tombstone: a peer is skipped for DIAL_RETRY_MS
// after an attempt (success or failure) and then eligible again, so a link
// that dropped later is re-established by the next state message or by
// healMesh() below. The old "dial once, never again" left the gossipsub
// router empty (`totalPeers=0`) for the rest of the session whenever a
// connection closed — e.g. one of two simultaneous cross-dials being pruned.
const DIAL_RETRY_MS = 30_000;
const dialled = new Map();      // libp2p peer id string -> last attempt (ms)
const dialFailed = new Map();   // peerId string -> failures, to keep the log quiet
const addrsOf = new Map();      // libp2p peer id string -> { peerId (label), addr }
async function dialPeerAddrs(peerId, addrs, force = false) {
  for (const addr of addrs) {
    const theirPid = addr.split('/p2p/').at(-1);
    if (!theirPid || theirPid === libp2p.peerId.toString()) continue;
    addrsOf.set(theirPid, { peerId, addr });
    const last = dialled.get(theirPid) || 0;
    if (!force && Date.now() - last < DIAL_RETRY_MS) continue;
    if (!force && libp2p.getConnections().some(c => c.remotePeer.toString() === theirPid && c.status === 'open')) continue;
    dialled.set(theirPid, Date.now());
    try {
      await libp2p.dial(multiaddr(addr));
      console.log(`[${PEER_LABEL}] libp2p mesh ↔ ${peerId} (${theirPid.slice(0, 14)}…)`);
    } catch (e) {
      const n = (dialFailed.get(theirPid) || 0) + 1;
      dialFailed.set(theirPid, n);
      if (n === 1) console.log(`[${PEER_LABEL}] no direct link to ${peerId} (${e.message.split('\n')[0].slice(0, 80)}) — using the bus`);
    }
  }
}
libp2p.addEventListener('peer:disconnect', (ev) => {
  const pid = ev.detail.toString();
  dialled.delete(pid);
  const who = addrsOf.get(pid)?.peerId || pid.slice(0, 14) + '…';
  console.log(`[${PEER_LABEL}] libp2p link to ${who} closed — will re-dial`);
});

// Mesh self-heal. A transport connection can be up while gossipsub has
// forgotten the peer (it removes a peer on ANY connection close, even when
// another connection to the same peer stays open), and then nothing we
// publish reaches them directly. Every tick: for each known member that is
// connected but not a pubsub peer, hang up and re-dial so the fresh connection
// runs identify → pubsub topology → subscription exchange again. Only the side
// with the smaller libp2p id heals a given pair, so both ends don't tear the
// link down at the same moment. Members we are not connected to at all are
// simply re-dialled (the cool-down above governs how often).
const healedAt = new Map();
async function healMesh() {
  const pubsubPeers = new Set(libp2p.services.pubsub.getPeers().map(p => p.toString()));
  const myPid = libp2p.peerId.toString();
  for (const [pid, { peerId, addr }] of addrsOf) {
    if (pubsubPeers.has(pid)) continue;
    const member = peersPublic.get(peerId);
    if (!member || Date.parse(member.last_seen || 0) < Date.now() - 60_000) continue;  // gone, not broken
    const conns = libp2p.getConnections().filter(c => c.remotePeer.toString() === pid && c.status === 'open');
    if (!conns.length) { await dialPeerAddrs(peerId, [addr]); continue; }
    if (myPid > pid) continue;
    if (Date.now() - (healedAt.get(pid) || 0) < DIAL_RETRY_MS) continue;
    healedAt.set(pid, Date.now());
    console.log(`[${PEER_LABEL}] mesh heal: ${peerId} connected but not in pubsub — re-dialling`);
    try { await libp2p.hangUp(conns[0].remotePeer); } catch {}
    await dialPeerAddrs(peerId, [addr], true);
  }
}

// -------- optional discovery mirror (LAN accelerator) --------
async function registerWithDiscovery() {
  if (!DISCOVERY_URL) return;
  try {
    const r = await fetch(`${DISCOVERY_URL}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dimension_id: DIM_ID, dimension_name: DIM_NAME, door_id: DOOR_ID,
        peer_id: PEER_ID_STRING, multiaddrs: myMaddrs,
        character_id: CHARACTER_ID || null, creature_id: CREATURE_ID || null,
      }),
    });
    if (!r.ok) throw new Error(await r.text());
  } catch (e) { console.warn(`[${PEER_LABEL}] discovery register failed: ${e.message}`); }
}
async function heartbeat() {
  if (!DISCOVERY_URL) return;
  try {
    await fetch(`${DISCOVERY_URL}/heartbeat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer_id: PEER_ID_STRING, dimension_id: DIM_ID }),
    });
  } catch {}
}
await registerWithDiscovery();
setInterval(heartbeat, 15_000);

let discoveryPollCount = 0;
async function discoveryPoll() {
  if (!DISCOVERY_URL) return;
  discoveryPollCount++;
  try {
    const r = await fetch(`${DISCOVERY_URL}/peers/${DIM_ID}`);
    const j = await r.json();
    const peers = (j.peers || []).filter(p => p.peer_id !== PEER_ID_STRING);
    if (discoveryPollCount === 1 || discoveryPollCount % 10 === 0) {
      console.log(`[${PEER_LABEL}] discovery poll #${discoveryPollCount}: ${peers.length} other peers (dialled ${dialled.size})`);
    }
    for (const p of peers) await dialPeerAddrs(p.peer_id, p.multiaddrs || []);
  } catch (e) { if (discoveryPollCount <= 3) console.warn(`[${PEER_LABEL}] discoveryPoll error: ${e.message}`); }
}
if (DISCOVERY_URL) { setInterval(discoveryPoll, 5_000); setTimeout(discoveryPoll, 1_500); }

// -------- entity shape / local state --------
let entity;
if (CHARACTER_ID) {
  const d = data.characters[CHARACTER_ID].data;
  const sum = d.stats.vitality + d.stats.world + d.stats.matter + d.stats.will;
  entity = {
    kind: 'character', peerId: PEER_ID_STRING, name: ENTITY_NAME, alliance: ALLIANCE,
    tile: { ...START_TILE }, sourceId: CHARACTER_ID, sourceName: data.characters[CHARACTER_ID].name,
    stats: { ...d.stats }, lifeMax: Math.max(1, Math.round(sum / 10)), life: Math.max(1, Math.round(sum / 10)),
    actionsPerRound: d.actions_per_round, combo: d.combo || [],
    permanents: new Set(),
  };
} else {
  const d = data.creatures[CREATURE_ID].data;
  const sum = d.stats.vitality + d.stats.world + d.stats.matter + d.stats.will;
  entity = {
    kind: 'creature', peerId: PEER_ID_STRING, name: ENTITY_NAME, alliance: ALLIANCE,
    tile: { ...START_TILE }, sourceId: CREATURE_ID, sourceName: data.creatures[CREATURE_ID].name,
    stats: { ...d.stats }, lifeMax: d.life, life: d.life, actionsPerRound: d.actions_per_round,
    innateEffect: d.innate_effect, dicePattern: d.dice_pattern, onActionRider: d.on_action_rider,
    permanents: new Set(),
  };
}
entity.lifeMaxBase = entity.lifeMax;   // before token / tile bonuses (general_ux_hitpoints_calculations)
const parseJsonArr = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const permanentsCsv = () => [...entity.permanents].sort().join(',');
// Effect-system state I am authoritative for (Rule 12 tokens, locks, round-
// scoped element rules). Published in every snapshot so the shared resolver
// reads the same values on every peer.
entity.statTokens = [];     // { stat, elem, value(±), effect_id }  — dice over / under a stat
entity.tileTokens = [];     // { id, kind: 'bonus'|'shield', elem, value, q, r } — dice I placed on tiles
entity.lostActions = 0;     // actions I must sit out (Lightning, Oblivion, …) — the sum over lockList
entity.lockList = [];       // { effect_id, by, n } — who locked me with what; an Oblivion lock lifts when its permanent falls
const syncLost = () => { entity.lockList = entity.lockList.filter(l => l.n > 0); entity.lostActions = entity.lockList.reduce((s, l) => s + l.n, 0); };
entity.elemPen = [];        // { elem, amount, until_turn } — Counter Spell took this off my stat for that element, for the turn
entity.shieldElems = [];    // { elem, until_turn, permanent? } — Shield: invulnerable to that element until the turn ends (∀: for good)
entity.disables = [];       // { elem, on, until_turn } — my Disable fired: `on` may not emit `elem` for the turn ('*' = nobody may, ∀)
entity.permPower = {};      // permanent id → its point-buy die (Rule 12/24: how strong it is; Force Shield spends it)
entity.permUntil = {};      // permanent id → last turn it stands (Disable lasts the turn, then the card is discarded)
entity.everyPerms = new Set(); // permanents cast doubled (Rule 23 ∀): Invisibility holds until I deal damage, Haste draws one more
entity.channels = [];       // { effect_id, target, elements, salt, stop, startedTurn, startedAction } — channel-tokens that re-fire the effect's leg every subsequent action until the stop condition
entity.traps = [];          // { id, q, r, effect_id, elements, card_id, power, trigger, mode, holder } — cards of mine lying as traps (Rule 2/4)
entity.afflictions = [];    // { effect_id, by } — a fired perm-trap (Sleep, Confusion) of `by` sits on me while they hold the permanent
entity.obstacles = [];      // { id, q, r, hp, elem } — Earth obstacles I created; enemies cannot pass, they wear them down with Matter
entity.links = [];          // { from, stat, value } — Spirit Link: that ally's stat is added to mine while the permanent stands
const statTokensJson = () => JSON.stringify(entity.statTokens);
const permPowerJson = () => JSON.stringify(entity.permPower);
const disablesJson = () => JSON.stringify(entity.disables);
const channelsJson = () => JSON.stringify(entity.channels);
const trapsJson = () => JSON.stringify(entity.traps);
const afflictionsJson = () => JSON.stringify(entity.afflictions);
const obstaclesJson = () => JSON.stringify(entity.obstacles);
const linksJson = () => JSON.stringify(entity.links);
// Rule 23: two copies of one effect cast together (Rule 22 chain: the shared
// elements go out once, so the cast takes one more emission than a single).
// Some ∀ bonuses turn the doubled effect into an instant instead.
const EVERY_INSTANT = new Set(['effect_the_void', 'effect_light_darkness', 'effect_teleportation', 'effect_emotions_bombard']);
const castInstant = (c, every) => every ? EVERY_INSTANT.has(c.effect_id) : !!c.is_instant;
const statSumOf = (st) => (st?.vitality || 0) + (st?.world || 0) + (st?.matter || 0) + (st?.will || 0);
// Stat buy (Summoning, Golems, Elementals, Resurrect): every emission banks my
// stat for the element going out — the card's elements in turn — until the
// bank covers `need`. The card shows how many emissions that takes at my stats.
const myStatNow = (el) => Math.max(0, (entity.stats[ELEM_TO_STAT[el]] ?? 0) + entity.statTokens.filter(t => t.stat === ELEM_TO_STAT[el]).reduce((a, t) => a + t.value, 0));
const summonLength = (c) => {
  const need = c.summon?.need ?? 30;
  if (need <= 0 || !c.element_cost.length) return 1;
  let bank = 0, n = 0;
  while (bank < need && n < 40) { bank += Math.max(1, myStatNow(c.element_cost[n % c.element_cost.length])); n++; }
  return Math.max(1, n);
};
const castLength = (c, every) => castInstant(c, every) ? 1 : (c.summon !== undefined && c.summon !== null ? summonLength(c) : Math.max(1, c.element_cost.length)) + (every ? 1 : 0);
// A creature as a card (the archive holds these; Summoning / Resurrect play them).
const creatureCard = (creatureId) => { const e = data.creatures[creatureId]; return e ? { card_id: `${creatureId}#${randomBytes(3).toString('hex')}`, kind: 'creature', creature_id: creatureId, name: e.name, stat_sum: statSumOf(e.data?.stats), text: e.data?.innate_effect_text || '' } : null; };
// Which permanents hold a creature (and what they are called in the log).
const SUMMON_PERMS = { effect_summoning: 'Summoning', effect_golems_earth: 'Golems', effect_golems_water: 'Golems', effect_golems_air: 'Golems', effect_elementals_air: 'Elementals', effect_elementals_water: 'Elementals', effect_elementals_earth: 'Elementals', effect_resurrect_death_ward: 'Resurrect' };
const RESURRECT = 'effect_resurrect_death_ward';
// Permanents with a fixed life: how many turns past the one they were placed in.
const PERM_TURNS = { effect_oblivion: 1, effect_balefire: 1 };   // Balefire(6) vanishes with the end of my next turn
const dropPermanent = (id) => {
  const had = entity.permanents.has(id);
  entity.permanents.delete(id); delete entity.permPower[id]; delete entity.permUntil[id]; entity.everyPerms.delete(id);
  if (id === 'effect_shield') entity.shieldElems = entity.shieldElems.filter(x => !x.permanent);
  // The effect under a falling Blessing goes to the discard pile with it.
  for (const ch of entity.channels.filter(c => c.holder === id)) releaseHeldCard(ch.card_id);
  entity.channels = entity.channels.filter(c => c.effect_id !== id && c.holder !== id);
  // A trap held by this permanent (Traps Mastery) is sprung for nothing: its card is discarded too.
  for (const tp of entity.traps.filter(t => t.holder === id)) releaseHeldCard(tp.card_id);
  entity.traps = entity.traps.filter(t => t.holder !== id);
  if (id === 'effect_spirit_link') entity.links = [];
  if (id === 'effect_possess_phylactery' && entity.possessedBy) { console.log(`[${PEER_LABEL}] the Possess permanent in my holding is gone — I am my own again`); entity.possessedBy = null; }
  if (had && id in SUMMON_PERMS) onSummonEnd(id);
  if (had && id === RESURRECT) entity.wards = [];
  // The card that made this permanent leaves the holding for the discard pile.
  if (had) releaseHeld(id);
};
// Permanent cards (user spec): a card whose permanent landed is not discarded —
// it sits in my permanents holding until the permanent falls, then it is discarded.
const heldCards = [];
const holdCard = (cid) => { for (let i = hand.length - 1; i >= 0; i--) if (hand[i].card_id === cid) { heldCards.push(...hand.splice(i, 1)); console.log(`[${PEER_LABEL}] ${heldCards[heldCards.length - 1].name} goes to my permanents holding (${heldCards.length} held)`); } };
const releaseHeld = (permId) => { for (let i = heldCards.length - 1; i >= 0; i--) { const c = heldCards[i]; if (c.effect_id === permId || c.skill_id === permId) { discard.push(...heldCards.splice(i, 1)); console.log(`[${PEER_LABEL}] ${c.name} leaves the holding for the discard pile`); } } };
// A trap card lies in the holding (face down on its tile) until it fires, then it is discarded.
// Possess (user ruling 2026-10-30): `entity.possessing = { peer_id, card_id }` while my Possess stands in
// another unit's holding; `entity.possessedBy` while someone's Possess stands in mine (published as possessed_by).
const possessedUnit = () => {
  if (!entity.possessing) return null;
  const v = peersPublic.get(entity.possessing.peer_id);
  return v && (v.life ?? 0) > 0 && String(v.permanents_csv || '').split(',').includes('effect_possess_phylactery') && v.possessed_by === PEER_ID_STRING ? v : null;
};
const releaseHeldCard = (cid, toDiscard = true) => { if (!cid) return; for (let i = heldCards.length - 1; i >= 0; i--) if (heldCards[i].card_id === cid) { const c = heldCards.splice(i, 1)[0]; if (toDiscard) discard.push(c); console.log(`[${PEER_LABEL}] ${c.name} is spent — ${toDiscard ? 'to the discard pile' : 'the card leaves my deck'}`); } };
entity.summons = [];        // [{ peer_id, creature_id, name, bound, perm, mode }] — creatures my permanents hold
entity.wards = [];          // peer ids under my Death Ward
const companions = [];      // processes I spawned: { peer_id, label, proc, port, perm }
let summonSeq = 0;
const vanishedThisAction = [];   // { peer_id, name, q, r, bound } — for the UI (💨), rides out with the state hash
const freePort = () => new Promise((res, rej) => { const sv = net.createServer(); sv.on('error', rej); sv.listen(0, '127.0.0.1', () => { const prt = sv.address().port; sv.close(() => res(prt)); }); });
// A stat buy is paid: spawn the creature next to me, or note the one bound /
// raised for me, or set a Death Ward on an ally.
async function onSummoned(permId, sm) {
  const label = SUMMON_PERMS[permId] || permId;
  if (sm.archive_card_id) { const i = archive.findIndex(c => c.card_id === sm.archive_card_id); if (i >= 0) archive.splice(i, 1); }
  if (sm.ward) {
    if (!entity.wards.includes(sm.ward)) entity.wards.push(sm.ward);
    console.log(`[${PEER_LABEL}] Death Ward on ${sm.name || sm.ward.slice(0, 12)}: when they would die they stand at 1 hp on their entry hex`);
    return;
  }
  if (sm.revive) {
    if (sm.is_player) {
      // A player is back at full life — the permanent did its work and is spent.
      console.log(`[${PEER_LABEL}] ${label} paid (${sm.need}): ${sm.name} is back among the living — the permanent is spent`);
      dropPermanent(permId);
      return;
    }
    entity.summons.push({ peer_id: sm.revive, creature_id: sm.creature_id, name: sm.name, bound: true, perm: permId, mode: 'revive' });
    console.log(`[${PEER_LABEL}] ${label} paid (${sm.need}): ${sm.name} rises again as my ally`);
    return;
  }
  // One creature per permanent: a new cast on the same permanent releases the old one.
  if (entity.summons.some(x => x.perm === permId)) { console.log(`[${PEER_LABEL}] a new ${label} — the creature it held is released`); onSummonEnd(permId); }
  if (sm.bind) {
    entity.summons.push({ peer_id: sm.bind, creature_id: sm.creature_id, name: sm.name, bound: true, perm: permId, mode: 'bind' });
    console.log(`[${PEER_LABEL}] ${label} ∀: ${sm.name} (${sm.bind.slice(0, 12)}) is bound to me`);
    return;
  }
  const cre = data.creatures[sm.creature_id];
  if (!cre) return;
  const tag = await spawnCompanion(permId, { creature_id: sm.creature_id, name: cre.name, env: { CHARACTER_ID: '', CREATURE_ID: sm.creature_id, ENTITY_NAME: `${cre.name} (${PEER_LABEL}'s)` } });
  if (tag) console.log(`[${PEER_LABEL}] ${label} paid (${sm.need}): ${cre.name} enters as ${tag}`);
}
// Phantom (user spec 2026-10-29): a copy of me — same character, stats and deck — fights for me
// next to me while the permanent stands; it falls at the first point of damage (PHANTOM=1 in the child).
async function spawnPhantom(permId) {
  if (entity.kind !== 'character') { console.log(`[${PEER_LABEL}] phantom: only a character can mirror itself`); return; }
  if (entity.summons.some(x => x.perm === permId)) onSummonEnd(permId);
  const tag = await spawnCompanion(permId, { creature_id: null, name: `${entity.name} (phantom)`, env: { CHARACTER_ID, CREATURE_ID: '', ENTITY_NAME: `${entity.name} (phantom)`, PHANTOM: '1', FORCE_CLASS: entity.classId || '' } });
  if (tag) console.log(`[${PEER_LABEL}] phantom: my mirror enters as ${tag}`);
}
// A companion process on the free tile next to me (nearest free one within two hexes if all six are taken).
async function spawnCompanion(permId, { creature_id, name, env: extraEnv }) {
  const occ = new Set(livePeers().filter(p => p && p.life > 0).map(p => `${p.tile_q},${p.tile_r}`)); occ.add(`${entity.tile.q},${entity.tile.r}`);
  const ring1 = hexNeighbours(entity.tile.q, entity.tile.r);
  const ring2 = [...new Set(ring1.flatMap(t => hexNeighbours(t.q, t.r)).map(t => `${t.q},${t.r}`))].map(k => k.split(',').map(Number)).map(([q, r]) => ({ q, r }));
  const tile = [...ring1, ...ring2].find(t => dimMap.has(t.q, t.r) && !occ.has(`${t.q},${t.r}`));
  if (!tile) { console.log(`[${PEER_LABEL}] ${permId}: no free tile around me — ${name} cannot enter`); return null; }
  const tag = `${PEER_LABEL}-sum${++summonSeq}`;
  const [pL, pH, pG] = await Promise.all([freePort(), freePort(), freePort()]);
  const blocksFile = path.join(os.tmpdir(), `chaos-summon-${tag.replace(/[^a-z0-9._-]+/gi, '_')}-${Date.now()}.json`);
  fsSync.writeFileSync(blocksFile, JSON.stringify(dimMap.blocks()));
  const env = {
    ...process.env,
    PEER_LABEL: tag, ALLIANCE: MY_SIDE === 'A' ? 'npc_a' : 'npc_b', START_TILE: JSON.stringify(tile),
    PEER_PORT_LIBP2P: String(pL), PEER_PORT_HTTP: String(pH), PEER_PORT_GUN: String(pG),
    MAP_SEED, MAP_BLOCKS_FILE: blocksFile, BOOTSTRAP: [...myMaddrs, ...BOOTSTRAP_MADDRS].join(','), PEER_GUN_URLS: [myGunUrl, ...PEER_GUN_URLS].join(','),
    JOIN_SYNC_WAIT_MS: '4000', OWNER_PEER_ID: PEER_ID_STRING, FORCE_EFFECTS: '', FORCE_SKILLS: '', FORCE_OPENING: '', FORCE_CLASS: '',
    ...extraEnv,
  };
  delete env.MAP_BLOCKS;
  const proc = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', b => process.stdout.write(b));
  proc.stderr.on('data', b => process.stderr.write(b));
  proc.on('exit', (c) => { console.log(`[${PEER_LABEL}] summoned ${tag} left (${c ?? 'signal'})`); const i = companions.findIndex(x => x.proc === proc); if (i >= 0) companions.splice(i, 1); });
  companions.push({ peer_id: `peer:${tag}`, label: tag, proc, port: pH, perm: permId });
  entity.summons.push({ peer_id: `peer:${tag}`, creature_id, name, bound: false, perm: permId, mode: 'spawn' });
  console.log(`[${PEER_LABEL}] ${name} enters at (${tile.q},${tile.r}) as ${tag}`);
  return tag;
}
// A creature-holding permanent is gone: its creature vanishes (companion: told
// directly; bound: it watches my snapshot); its card goes to my archive.
function onSummonEnd(permId) {
  const label = SUMMON_PERMS[permId] || permId;
  for (let i = entity.summons.length - 1; i >= 0; i--) {
    const sm = entity.summons[i];
    if (sm.perm !== permId) continue;
    entity.summons.splice(i, 1);
    const where = peersPublic.get(sm.peer_id);
    vanishedThisAction.push({ peer_id: sm.peer_id, name: sm.name, q: where?.tile_q ?? null, r: where?.tile_r ?? null, bound: sm.mode === 'bind' });
    const card = creatureCard(sm.creature_id);
    if (card) archiveCard(card);
    console.log(`[${PEER_LABEL}] the ${label} falls — ${sm.name} ${sm.mode === 'bind' ? 'is released' : sm.mode === 'revive' ? 'falls again' : 'vanishes'}; its card goes to my archive (${archive.length})`);
  }
  for (let i = companions.length - 1; i >= 0; i--) {
    const c = companions[i];
    if (c.perm !== permId) continue;
    // Tell it directly (it is my child on this machine), then make sure it is gone.
    fetch(`http://127.0.0.1:${c.port}/summon-release`, { signal: AbortSignal.timeout(1500) }).catch(() => {});
    setTimeout(() => { try { c.proc.kill(); } catch {} }, 10_000);
    companions.splice(i, 1);
  }
}
// Owner → companion heartbeat: while I hold its permanent, my creature hears it from me directly.
setInterval(() => {
  for (const c of companions) if (entity.permanents.has(c.perm)) fetch(`http://127.0.0.1:${c.port}/summon-hold`, { signal: AbortSignal.timeout(1500) }).catch(() => {});
}, 2000);
// Bound to `owner` (∀ Summoning took me, or Resurrect raised me): I fight on
// their side and follow them until the permanent that holds me falls.
let boundOriginalAlliance = null, boundMode = null, boundPerm = null;
function becomeBound(owner, permId, mode) {
  if (IS_COMPANION) return;
  const o = peersPublic.get(owner);
  const side = o ? sideOf(o.alliance) : 'A';
  if (boundOriginalAlliance === null) boundOriginalAlliance = entity.alliance;
  entity.alliance = side === 'A' ? 'npc_a' : 'npc_b'; MY_SIDE = side;
  ownerPeerId = owner; ownerSeenHolding = true; boundMode = mode; boundPerm = permId;
  console.log(`[${PEER_LABEL}] ${mode === 'revive' ? 'raised' : 'bound'} by ${owner.slice(0, 12)}'s ${SUMMON_PERMS[permId] || permId} — I fight for side ${side} now`);
  publishPublicState().catch(() => {});
}
// Resurrect reached me: back at full life (a creature also becomes the raiser's ally).
function onRevived(owner, permId) {
  entity.life = entity.lifeMax; entity.lockList = []; syncLost();
  console.log(`[${PEER_LABEL}] raised by ${owner.slice(0, 12)} — back at ${entity.life} hp`);
  if (entity.kind === 'creature') becomeBound(owner, permId, 'revive');
  else publishPublicState().catch(() => {});
}
// Companion / bound creature: when the permanent that holds me is gone (or the
// owner fell), vanish (companion), fall again (raised) or go back (bound).
let ownerSeenHolding = false, vanishing = false;
let ownerHoldAt = Date.now();   // companion: when my owner last told me they still hold the permanent
function vanish(why) {
  if (vanishing) return;
  vanishing = true; entity.life = 0;
  console.log(`[${PEER_LABEL}] ${why} — I vanish`);
  // Say it twice so the mesh holds my corpse before the process is gone.
  publishPublicState().catch(() => {}).finally(() => setTimeout(() => publishPublicState().catch(() => {}).finally(() => setTimeout(() => process.exit(0), 2500)), 1500));
}
setInterval(() => {
  if (!ownerPeerId || vanishing) return;
  if (IS_COMPANION) {
    // My summoner pings /summon-hold every 2 s and calls /summon-release when the permanent falls.
    if (Date.now() - ownerHoldAt > 30_000) vanish('my summoner fell silent');
    return;
  }
  const o = peersPublic.get(ownerPeerId);
  const holds = !!o && String(o.permanents_csv || '').split(',').includes(boundPerm) && (o.life ?? 1) > 0;
  if (holds) { ownerSeenHolding = true; return; }
  if (!o || !ownerSeenHolding) return;   // no word from the owner yet — not a release
  if (boundMode === 'revive') {
    console.log(`[${PEER_LABEL}] the ${SUMMON_PERMS[boundPerm] || 'permanent'} that raised me is gone — I fall again`);
    entity.life = 0;
  } else {
    console.log(`[${PEER_LABEL}] the ${SUMMON_PERMS[boundPerm] || 'permanent'} that bound me is gone — back to my own side`);
    entity.alliance = boundOriginalAlliance || ALLIANCE; MY_SIDE = sideOf(entity.alliance);
  }
  boundOriginalAlliance = null; boundMode = null; boundPerm = null; ownerPeerId = null; ownerSeenHolding = false;
  publishPublicState().catch(() => {});
}, 1500);
const tileTokensJson = () => JSON.stringify(entity.tileTokens);
const elemPenJson = () => JSON.stringify(entity.elemPen);
const elemsCsv = (list) => list.map(t => t.elem).sort().join(',');
// No-damage zones (Blizzard, Light/Darkness) every peer derives from the same
// reveals. Paper "round" = one turn here (3 actions): they expire with it.
let activeZones = [];        // { q, r, until_turn }
// A multi-Posture cast in progress (Rule 19): which card, how many elements
// are already out. Interrupting it with another action drops it.
// Rule 19/22/23: a cast plan is a chain of entries — each one effect (maybe
// doubled, ∀). Chained effects share one element with the entry before them, so
// the chain needs one emission less per link. `emitted` counts emissions so far.
let casting = null;          // { entries: [{ cardId, cardId2, effectId, every, len, kept }], emitted, aura } — kept: banked point-buy dice per element
const chainEnds = (entries) => { const ends = []; let s = 0; entries.forEach((e, k) => { s += e.len - (k > 0 ? 1 : 0); ends.push(s); }); return ends; };
// Which entry is being emitted at global step `step` (1-based), and where it stands.
const chainAt = (entries, step) => {
  const ends = chainEnds(entries);
  const k = ends.findIndex(e => e >= step);
  if (k < 0) return null;
  const start = k > 0 ? ends[k - 1] : 0;
  return { k, entry: entries[k], of: entries[k].len, step: step - start + (k > 0 ? 1 : 0), end: ends[k], total: ends[ends.length - 1] };
};
// Rule 22: one element per emission, so effect B joins A's cast when the
// element A emits at its last step is B's first — that emission counts for both.
const chainsOnto = (prev, next) => !!prev && !!next && prev.effect_id !== next.effect_id && next.element_cost[0] === prev.element_cost[prev.element_cost.length - 1];
// Can a card join the cast in progress right now? Only onto the tail entry, at its last emission.
const joinableNow = () => {
  if (!casting) return null;
  const at = chainAt(casting.entries, casting.emitted + 1);
  if (!at || at.k !== casting.entries.length - 1 || at.step < at.of) return null;
  const tail = hand.find(c => c.card_id === at.entry.cardId);
  return tail ? { tail, elem: tail.element_cost[tail.element_cost.length - 1] } : null;
};

// -------- class card --------
// Rule 9: character enters the dimension with their class as a permanent
// (tokens of value 6 per listed color). Only a subset of class abilities
// is wired to the resolver — the rest get the permanent and the UI label but
// no behavior yet. The implemented set is intentionally narrow; expand as the
// surrounding systems (traps, library, archives) land.
// 2026-10-30 (user ruling): EVERY unit — character or monster — enters with its class on the board.
// Statics are judged in the resolver; tap abilities are clicked in the permanents strip and go out
// in the reveal as `classAbility`; once-per-action abilities likewise. A class is destroyed colour
// by colour (one colour = one stat group of its listed elements; an adjacent enemy emits one of those
// elements and needs a die of 6) and then goes to its owner's ARCHIVE; the owner recasts it by emitting
// every colour with any successful roll (power 1), and untaps a tapped ability the same way.
const CLASSES_IMPLEMENTED = new Set(Object.keys(data.classes));
// Colours of a class = its elements grouped by the stat they belong to: { vitality: [...], matter: [...] }.
const classColours = (classId) => { const cols = {}; for (const el of data.classes[classId]?.data?.colors || []) { const st = ELEM_TO_STAT[el]; if (st) (cols[st] ||= []).push(el); } return cols; };
const classKindOf = (classId) => data.classes[classId]?.data?.ability_kind || 'static';
{
  const forced = (process.env.FORCE_CLASS || '').trim();
  const pool = Object.keys(data.classes).sort();
  let cls = forced && data.classes[forced] ? forced : null;
  // A monster's class follows from its creature id (every peer derives the same one); a character draws one.
  if (!cls && entity.kind === 'creature') cls = pool[parseInt(sha256Hex(`class:${CREATURE_ID}`).slice(0, 8), 16) % pool.length];
  if (!cls) cls = pool[Math.floor(Math.random() * pool.length)];
  entity.classId = cls;
  entity.className = data.classes[cls]?.name || cls;
  entity.permanents.add(cls);
  // Per-round combat flags set & cleared by the resolver so static abilities
  // can be stateful without leaking across rounds (Guardian: has moved?,
  // Assassin: already dealt damage?). Fresh on peer start.
  entity.classFlags = { movedThisRound: false, dealtDamageThisRound: false };
  entity.classDown = [];          // colours (stats) an enemy has already struck down
  entity.classArchived = false;   // the class card lies in my archive (every colour fell)
  entity.classTapped = false;     // a tap ability was used and not yet untapped
  entity.classProgress = null;    // { mode: 'recast'|'untap', done: [stats] }
  entity.classUsedAction = -1;    // hg.action a once-per-action ability was last used
  entity.armor = 0;               // Overlord's armor life token (0/1)
  entity.worldEdits = [];         // what I did to world-generated features: { id, gone, at } | { id, q, r, at }
  console.log(`[${PEER_LABEL}] class ${cls} (${classKindOf(cls)}; colours ${Object.keys(classColours(cls)).join('/')})${forced ? ' (forced)' : ''}`);
}
const classCard = () => ({ card_id: `${entity.classId}#class`, kind: 'class', class_id: entity.classId, name: entity.className, text: data.classes[entity.classId]?.data?.text || '' });
let queuedClassAbility = false;   // the class card was clicked for this action (WS `class_ability`)
// What a class ability needs picked before it goes out: an enemy / ally / tile target, or a hand card (queuedAttach).
const CLASS_NEEDS = {
  class_animator: 'tile', class_alchemist: 'tile', class_warrior: 'tile',
  class_healer: 'ally_or_self', class_overlord: 'ally_or_self',
  class_priest: 'enemy', class_prophet: 'enemy', class_witch: 'enemy', class_manipulator: 'enemy',
  class_ranger: 'attach_effect', class_seeker: 'attach_nonaction',
};
// Abilities settled on this peer alone (hand / deck / discard are private). Return a note when it fired.
const CLASS_LOCAL = {
  class_paladin: () => recoverFromDiscard(c => c.kind === 'action', 'an action card'),
  class_shaman: () => recoverFromDiscard(c => c.kind === 'effect', 'an effect card'),
  class_kensei: () => recoverFromDiscard(c => c.kind === 'skill', 'a skill card'),
  class_weapon_master: () => { reshuffleIfEmpty(); if (!deck.length) return null; hand.push(deck.shift()); return `an extra card drawn (${hand.length} in hand)`; },
  class_summoner: () => { if (!data.effects.effect_summoning) return null; const c = makeEffectCard('effect_summoning'); c.from_class = 'class_summoner'; hand.push(c); return 'a Summoning rides into my hand — cast it (stat buy) to call a Library creature'; },
};
function recoverFromDiscard(pred, what) {
  for (let i = discard.length - 1; i >= 0; i--) if (pred(discard[i])) { const c = discard.splice(i, 1)[0]; hand.push(c); return `${what} (${c.name || c.action_name}) returns from the discard pile to my hand`; }
  return null;
}
// World-generated features as a view of peers sees them: map.js featureAt(MAP_SEED, q, r) corrected by every
// peer's world_edits_json — `{id, gone}` (pulled / destroyed) or `{id, q, r}` (relocated). Same on every peer.
function worldLens(view) {
  const edits = new Map();
  for (const v of view.values()) for (const e of parseJsonArr(v?.world_edits_json)) { const cur = edits.get(e.id); if (!cur || e.gone || (!cur.gone && (e.at ?? 0) >= (cur.at ?? 0))) edits.set(e.id, e); }
  const movedIn = new Map();
  for (const e of edits.values()) if (!e.gone && Number.isInteger(e.q)) { const m = /^world:(-?\d+),(-?\d+)$/.exec(e.id); const f = m ? featureAt(MAP_SEED, Number(m[1]), Number(m[2])) : null; if (f) movedIn.set(`${e.q},${e.r}`, { ...f, q: e.q, r: e.r }); }
  const tokensAt = (q, r) => {
    const out = [];
    const f = featureAt(MAP_SEED, q, r);
    if (f && !edits.has(f.id)) out.push({ ...f, owner: 'world' });
    const moved = movedIn.get(`${q},${r}`);
    if (moved) out.push({ ...moved, owner: 'world' });
    return out;
  };
  return { tokensAt, edits };
}
const worldFeatureValueAt = (view, q, r) => worldLens(view).tokensAt(q, r).reduce((a, t) => a + t.value, 0);
const classProgressJson = () => JSON.stringify(entity.classProgress || null);

// Deck + hand.
const SKILLS_IMPLEMENTED = [
  'skill_powerful_attack', 'skill_overrun', 'skill_grapple', 'skill_ranged_weapon',
  'skill_taunt', 'skill_barricade', 'skill_sanctuary',
  'skill_dodge', 'skill_bluff', 'skill_intimidation', 'skill_disruption_move',
  'skill_battle_trance', 'skill_force_shield', 'skill_counter_spell',
];
const TRANCE = 'skill_battle_trance';
// Reaver (Rule 9 + Rule 20 pc override): Empty Posture / Empty Move count as
// an Attack, and non-instant effects may ride on the Attack itself.
const isReaver = () => entity.permanents.has('class_reaver');
// Monk: casting continues while moving (Move / Empty Move carry the emission).
const isMonk = () => entity.permanents.has('class_monk');
// Effects dealt into character decks: everything effects.mjs has rules for.
const EFFECTS_IMPLEMENTED = playableEffects(data.effects);
// The Dimension Library the resolver draws random cards from (deterministic index over this sorted list).
const LIBRARY_EFFECTS = [...EFFECTS_IMPLEMENTED].filter(id => (data.effects[id]?.data?.element_cost || []).length).sort().map(id => ({ effect_id: id, elements: [...data.effects[id].data.element_cost] }));
const ACTION_BY_CODE = { A: 'action_attack', B: 'action_block', M: 'action_move', P: 'action_posture' };
// 15-card deck for everyone: 11 basics + 4 skills (Rule 0).
const deck = [];
const pushAction = (code) => { const b = ACTION_BY_CODE[code]; deck.push({ card_id: `${b}#${randomBytes(3).toString('hex')}`, kind: 'action', action_id: b, code, action_name: data.actions[b].name }); };
if (entity.kind === 'character') {
  for (const c of 'ABMP') for (let i = 0; i < 2; i++) pushAction(c);
  const extra = (entity.combo || []).length ? entity.combo.slice(0, 3) : ['A', 'B', 'M'];
  for (const c of extra) pushAction(c);
  while (deck.length < 11) pushAction('P');
} else if (entity.dicePattern) {
  for (let i = 0; i < 11; i++) pushAction(entity.dicePattern[i % entity.dicePattern.length]);
} else {
  for (let i = 0; i < 6; i++) pushAction('A');
  for (let i = 0; i < 3; i++) pushAction('M');
  pushAction('P'); pushAction('B');
}
{
  // FORCE_SKILLS=skill_a,skill_b (dev/test only) pins those skills into the 4 dealt.
  const forced = (process.env.FORCE_SKILLS || '').split(',').filter(id => SKILLS_IMPLEMENTED.includes(id) && data.skills[id]);
  const pool = SKILLS_IMPLEMENTED.filter(id => data.skills[id] && !forced.includes(id));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  for (const id of [...forced, ...pool].slice(0, 4)) {
    const s = data.skills[id];
    const trance = id === TRANCE;
    deck.push({ card_id: `${id}#${randomBytes(3).toString('hex')}`, kind: 'skill', skill_id: id, name: s.name, requires: trance ? '*' : s.data.action_type, is_trance: trance, text: s.data.text, tags: s.tags, is_permanent: !!s.data.is_permanent });
  }
}
if (entity.kind === 'character') {
  // Deal 3 effect cards. Each carries its element_cost sequence so the client
  // can display the required glyphs and the resolver can walk the chain as
  // contiguous Postures emit elements (Rule 19). FORCE_EFFECTS pins them.
  const forcedE = (process.env.FORCE_EFFECTS || '').split(',').map(s => s.trim()).filter(id => EFFECTS_IMPLEMENTED.includes(id) && data.effects[id]);
  const poolE = EFFECTS_IMPLEMENTED.filter(id => data.effects[id] && !forcedE.includes(id));
  for (let i = poolE.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [poolE[i], poolE[j]] = [poolE[j], poolE[i]]; }
  for (const id of [...forcedE, ...poolE].slice(0, 3)) deck.push(makeEffectCard(id));
}
// An effect card of the given effect (dealt at start; generated when a library trap is dealt with —
// Space Bending / Alchemist traps put their card into the discard pile of whoever sprang them).
function makeEffectCard(id) {
  {
    const e = data.effects[id];
    const d = e.data || {};
    const types = Array.isArray(d.effect_types) ? d.effect_types : [];
    const rule = EFFECT_RULES[id] || {};
    return ({
      card_id: `${id}#${randomBytes(3).toString('hex')}`,
      kind: 'effect',
      effect_id: id,
      name: e.name,
      element_cost: Array.isArray(d.element_cost) ? [...d.element_cost] : [],
      effect_types: types,
      is_permanent: !!rule.permanent,
      is_damage: !!rule.damage,
      is_point_buy: rule.damage === 'pointbuy',
      is_instant: types.includes('instant'),
      scope: rule.scope || (rule.teleportSelf ? 'tile' : 'self'),
      // UI hints (2026-10-29): a left-clicked tile is the cast's target; a second effect card from the
      // hand rides along (Traps Mastery / Space Bending trap, Blessing); the Spirit Link ally stat; the
      // token element (Artifice).
      tile_target: !!rule.tileTarget, takes_attach: !!(rule.trapAttach || rule.blessAttach), takes_link: !!rule.spiritLink, takes_elem: !!rule.altTileToken,
      text: d.text,
      tags: e.tags || [],
      // Stat-buy summons: the creature rides along from the deal. Summoning: a random
      // library creature ("Library's top"); Golems / Elementals: a random one of their
      // kind, fixed need 24 / 30; Resurrect decides at queue time (what lies next to me).
      summon: (() => {
        const kind = id === 'effect_summoning' ? null : id.startsWith('effect_golems') ? 'golem' : id.startsWith('effect_elementals') ? 'elemental' : id === 'effect_resurrect_death_ward' ? 'resurrect' : undefined;
        if (kind === undefined) return null;
        if (kind === 'resurrect') return { pending: true, need: 0 };
        const ids = Object.keys(data.creatures).filter(cid => (data.creatures[cid].data?.built_in || null) === kind);
        const cid = ids[Math.floor(Math.random() * ids.length)];
        return { creature_id: cid, name: data.creatures[cid].name, need: kind ? (d.stat_buy_total || (kind === 'golem' ? 24 : 30)) : statSumOf(data.creatures[cid].data?.stats) };
      })(),
    });
  }
}
// Shuffle.
for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
// FORCE_OPENING=skill_sanctuary,B,A (dev/test only): move one card per entry
// to the top of the deck so the opening hand is predictable. Only characters —
// monsters keep their shuffle so a pinned hero test is not mirrored by the foe.
if (process.env.FORCE_OPENING && entity.kind === 'character') {
  const top = [];
  for (const want of process.env.FORCE_OPENING.split(',').map(s => s.trim()).filter(Boolean)) {
    const i = deck.findIndex(c => c.skill_id === want || c.effect_id === want || c.code === want);
    if (i >= 0) top.push(...deck.splice(i, 1));
  }
  deck.unshift(...top);
}
const hand = []; while (hand.length < HAND_SIZE && deck.length) hand.push(deck.shift());
const discard = [];
// Archive (user spec): a side deck of my own. A hand card I mark goes to the
// archive at this action's resolution instead of the discard pile — played or
// not; from the archive a card may be put back onto the discard pile. Creature
// cards (a destroyed Summoning's creature) live here too and are never shuffled
// into the deck. The circulating deck — draw pile + discard + hand — may never
// drop below DECK_MIN cards.
const archive = [];
const willArchive = new Set();   // card_ids marked for the archive this action
const DECK_MIN = 15;
const circulating = () => deck.length + discard.length + hand.length + heldCards.length;
const archiveRoom = () => circulating() - willArchive.size - DECK_MIN;   // how many more cards may leave the deck
const archiveCard = (c) => { if (c) archive.push(c); };
let queued = [];           // one element: slot index (int) | 'EP' | 'EM'
let queuedSkills = [];     // hand indices of skill cards attached to the queued action
let queuedExtra = null;    // second option card index when Battle Trance is attached
let queuedEffect = null;   // hand index of an effect card riding on this action (Posture / EP for most; any action for instants)
let queuedEffect2 = null;  // hand index of a second copy of the queued effect — cast together (Rule 23 ∀)
let queuedChain = [];      // hand indices of further effects chained onto it (Rule 22, shared element emitted once)
let queuedAura = false;    // cast the plan through my Aura ∀: everyone within 10 hexes, Aura consumed
let queuedDestroy = null;  // { stat } — Rule 24: emit that stat's element against an enemy token instead of casting
let queuedAttach = null;   // hand index of a second effect card the queued effect works on (Traps Mastery lays it as its trap; Space Bending alt)
let queuedLink = null;     // { peer_id, stat } — Spirit Link: the ally stat clicked in the unit list
let queuedElem = null;     // element id — general_ux_tokens: the element a token-making cast should create (Artifice tile token)
let queuedPhylactery = null; // { peer_id, perm } — Possess/Phylactery holder: the enemy permanent to shatter this action
// Bonus rounds only I act in, committed before the normal action and resolved
// first, in order, each against everyone's Empty Posture. Haste grants one per
// action. Balefire (user spec 2026-10-29): the cast that completes lands a
// Balefire(6) permanent until the end of my next turn and draws five cards;
// while it stands every card of mine is an instant — as many bonus plans as I
// have cards — but still one element emission per action.
// Card ids, so a plan survives hand changes within the planning phase. A
// non-instant effect may run across consecutive bonus plans (its steps).
let queuedBonus = [];      // [{ actionCardId|null (Empty), extraCardId|null (Battle Trance 2nd option), skillCardIds: [], effectCardId|null, target, destroy|null }]
const BALEFIRE_PLANS = 9;  // bonus plans a Balefire(6) holder may commit per action (the hand is the real cap)
const bonusAllowance = () => (entity.permanents.has('effect_haste') ? 1 : 0) + (entity.permanents.has('effect_balefire') ? BALEFIRE_PLANS : 0);
// The bonus rounds as they travel in the reveal (card ids stay local).
const bonusWire = (list) => Array.isArray(list) && list.length ? list.map(b => ({ action: b.action, trance: b.trance || null, target: wrapTarget(b.target), skills: b.skillIds, skill_names: b.skillNames, effect: b.effect, destroy: b.destroy || null })) : null;
const bonusForUI = () => ({
  max: bonusAllowance(), balefire: entity.permanents.has('effect_balefire') ? BALEFIRE_PLANS : 0,
  plans: queuedBonus.map(b => {
    const a = b.actionCardId ? hand.find(c => c.card_id === b.actionCardId) : null;
    return { action: a ? a.code : (b.target && typeof b.target === 'object' ? 'EM' : 'EP'), skills: b.skillCardIds.map(id => hand.find(c => c.card_id === id)?.name).filter(Boolean), effect: hand.find(c => c.card_id === b.effectCardId)?.name || null, destroy: b.destroy || null, card_ids: [b.actionCardId, b.extraCardId, ...b.skillCardIds, b.effectCardId].filter(Boolean) };
  }),
});
let target = null;         // peer_id string | { q, r } tile object | null
// Summoning: decide the creature when the card is queued (the cast is fixed once
// it starts). My archived creature comes first; otherwise the one dealt with the
// card. ∀ (two copies): the nearest visible enemy creature within 10 hexes is
// bound to me instead of summoning a new one.
function prepareSummon(card, every) {
  if (!card || !(card.effect_id in SUMMON_PERMS)) return;
  if (card.effect_id === RESURRECT) {
    // Resurrect: the dead unit next to me (the one I right-clicked first), else an
    // archived creature to spawn, else Death Ward on the ally next to me.
    const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
    const adj = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && Number.isInteger(p.tile_q) && hexDistance(here, p) <= 1);
    const dead = adj.filter(p => (p.life ?? 1) <= 0);
    const pick = (typeof target === 'string' && dead.find(p => p.peer_id === target)) || dead.sort((a, b) => a.peer_id.localeCompare(b.peer_id))[0];
    if (pick) { card.summon = { revive: pick.peer_id, creature_id: pick.creature_id || null, is_player: !pick.creature_id, name: pick.name, need: (pick.stat_vitality || 0) + (pick.stat_world || 0) + (pick.stat_matter || 0) + (pick.stat_will || 0) }; return; }
    const arch = archive.find(c => c.kind === 'creature');
    if (arch) { card.summon = { creature_id: arch.creature_id, name: arch.name, need: arch.stat_sum, archive_card_id: arch.card_id }; return; }
    const allies = adj.filter(p => p.life > 0 && sideOf(p.alliance) === MY_SIDE);
    const ally = (typeof target === 'string' && allies.find(p => p.peer_id === target)) || allies.sort((a, b) => a.peer_id.localeCompare(b.peer_id))[0];
    card.summon = ally ? { ward: ally.peer_id, name: ally.name, need: 0 } : { pending: true, need: 0 };
    return;
  }
  if (card.effect_id !== 'effect_summoning') return;   // golems / elementals keep the creature they were dealt with
  if (every) {
    const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
    const c = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && p.creature_id && sideOf(p.alliance) !== MY_SIDE && p.life > 0 && hexDistance(here, p) <= 10)
      .sort((a, b) => hexDistance(here, a) - hexDistance(here, b) || a.peer_id.localeCompare(b.peer_id))[0];
    if (c) { card.summon = { bind: c.peer_id, creature_id: c.creature_id, name: c.name, need: (c.stat_vitality || 0) + (c.stat_world || 0) + (c.stat_matter || 0) + (c.stat_will || 0) }; return; }
  }
  const arch = archive.find(c => c.kind === 'creature');
  if (arch) card.summon = { creature_id: arch.creature_id, name: arch.name, need: arch.stat_sum, archive_card_id: arch.card_id };
  else if (card.summon?.bind || card.summon?.archive_card_id) { const cid = card.summon.creature_id; card.summon = { creature_id: cid, name: data.creatures[cid]?.name || cid, need: statSumOf(data.creatures[cid]?.data?.stats) }; }
}
// `queued`/`queued_skills` ride only on the echo to a queue message — a hand
// refresh at round/turn boundaries must not wipe the browser's fresh autoselect.
const castingForUI = () => {
  if (!casting) return null;
  const at = chainAt(casting.entries, casting.emitted + 1) || chainAt(casting.entries, casting.emitted);
  const c = at && hand.find(x => x.card_id === at.entry.cardId);
  if (!c) return null;
  const ends = chainEnds(casting.entries);
  const jn = joinableNow();
  return {
    effect_id: at.entry.effectId, name: c.name, every: !!at.entry.every, aura: !!casting.aura,
    step: casting.emitted, of: at.total,
    card_ids: casting.entries.flatMap((e, k) => ends[k] > casting.emitted ? [e.cardId, e.cardId2].filter(Boolean) : []),
    join_elem: jn ? jn.elem : null, join_tail: jn ? jn.tail.card_id : null,
  };
};
// What everyone's public snapshot says lies on a tile — the unit, traps (face-down for everyone but
// the owner; Vision / Super Sense name them), obstacles, tile tokens. Text for peeks and logs.
const describeTile = (q, r) => {
  const bits = [];
  for (const p of livePeers()) {
    if (p.tile_q === q && p.tile_r === r && (p.life ?? 0) > 0) bits.push(`${p.name || p.peer_id} stands here`);
    for (const t of parseJsonArr(p.traps_json)) if (t.q === q && t.r === r) bits.push(`trap ${data.effects[t.effect_id]?.name || t.effect_id} (${(t.elements || []).map(e => e.replace('elem_', '')).join('+')}, ${t.trigger === 'enter' ? 'springs on entering' : 'springs when its owner is targeted'}) laid by ${p.name || p.peer_id}`);
    for (const o of parseJsonArr(p.obstacles_json)) if (o.q === q && o.r === r) bits.push(`${o.label || 'obstacle'} (${o.hp} hp)`);
    for (const t of parseJsonArr(p.tile_tokens_json)) if (t.q === q && t.r === r) bits.push(`${t.item || `${t.kind} token`} ${t.elem.replace('elem_', '')} ${t.value}`);
  }
  if (entity.tile.q === q && entity.tile.r === r) bits.unshift('you stand here');
  for (const t of entity.traps) if (t.q === q && t.r === r) bits.push(`your trap ${data.effects[t.effect_id]?.name || t.effect_id}`);
  return bits.join('; ');
};
// Super Sense (user spec 2026-10-29): while I hold it, the traps on the six tiles around me are known to me
// without springing them (the UI shows them; the cards stay where they are).
const sensedTraps = () => {
  if (!entity.permanents.has('effect_super_sense')) return [];
  const ring = new Set(hexNeighbours(entity.tile.q, entity.tile.r).map(t => `${t.q},${t.r}`));
  return livePeers().filter(p => p.peer_id !== PEER_ID_STRING).flatMap(p => parseJsonArr(p.traps_json).filter(t => ring.has(`${t.q},${t.r}`)).map(t => ({ q: t.q, r: t.r, effect_id: t.effect_id, name: data.effects[t.effect_id]?.name || t.effect_id, elements: t.elements || [], trigger: t.trigger, by: p.peer_id, by_name: p.name || p.peer_id })));
};
const handMsg = (extra = {}) => ({ kind: 'hand', hand, deck_count: deck.length, discard_count: discard.length, archive, archive_count: archive.length, will_archive: [...willArchive], held: heldCards.map(c => ({ card_id: c.card_id, name: c.name, perm: c.effect_id || c.skill_id })), deck_min: DECK_MIN, circulating: circulating(), turn: hg.turn, round: hg.round, casting: castingForUI(), lost_actions: entity.lostActions, destroy: queuedDestroy, queued_chain: queuedChain, aura: queuedAura, bonus: bonusForUI(), sensed_traps: sensedTraps(), channels: entity.channels.map(ch => ({ effect_id: ch.effect_id, name: data.effects[ch.effect_id]?.name || ch.effect_id, holder: ch.holder || null, stop: ch.stop })), queued_attach: queuedAttach, queued_link: queuedLink, queued_elem: queuedElem, queued_phylactery: queuedPhylactery, queued_class_ability: queuedClassAbility, class_state: classStateForUI(), possessing: entity.possessing?.peer_id || null, ...extra });
// My class as the UI shows it: colours (stat → elements) with the ones struck down, tapped / archived flags and recast / untap progress.
const classStateForUI = () => ({ class_id: entity.classId || null, name: entity.className || null, kind: classKindOf(entity.classId), colours: classColours(entity.classId), down: [...(entity.classDown || [])], archived: !!entity.classArchived, tapped: !!entity.classTapped, progress: entity.classProgress || null, used_action: entity.classUsedAction ?? -1, needs: CLASS_NEEDS[entity.classId] || null, local: !!CLASS_LOCAL[entity.classId], text: data.classes[entity.classId]?.data?.text || '' });
let locked = false;
const willDiscard = new Set();   // card_ids the player marked to drop at turn end (rule 7: characters MAY discard leftovers)

// -------- hashgraph state --------
// turn/round are the envelope fields; `action` is the global round counter
// (turn * ROUNDS_PER_TURN + round) used wherever we need a single monotonic key
// (discovery reveal buckets, handshake bookkeeping, join sync).
const hg = {
  selfParent: null,
  otherParent: null,
  head: null,
  tape: [],
  turn: 0,
  round: 0,
  action: 0,
};
const actionKey = (turn, round) => turn * ROUNDS_PER_TURN + round;

// Phase clock lives up here because the public-state snapshot (published
// before the FSM section) reports it to joining peers.
let currentPhase = 'planning';
let phaseEndsAt = Date.now() + ROUND_SEC * 1000;

function sha256Hex(s) { return createHash('sha256').update(s).digest('hex'); }
function digestObj(o) { return sha256Hex(JSON.stringify(o)); }

let lastEnvelopeAt = 0;
async function emitEnvelope({ type, payload, actionIndex = hg.round, viaBus = null }) {
  const env = {
    type,
    dimension_id: DIM_ID,
    door_id: DOOR_ID,
    turn: hg.turn, round: hg.round, action_index: actionIndex,
    actor_peer_id: PEER_ID_STRING,
    self_parent: hg.selfParent,
    other_parent: hg.otherParent,
    payload,
    timestamp: new Date().toISOString(),
    signature: `sig:${PEER_ID_STRING}:stub`,
    // Piggyback our public snapshot so receivers always resolve against fresh
    // tile/life and the bus doesn't need a separate state event every round
    // (public relays rate-limit chatty senders).
    state: currentStateSnapshot(true),
  };
  env._hash = digestObj(env);
  hg.selfParent = env._hash;
  hg.head = env._hash;
  hg.tape.push(env);

  // 1) Broadcast via libp2p gossipsub to the strong-region mesh (direct links)
  //    and over the public Nostr bus (peers on other machines). Receivers
  //    dedupe by _hash, so getting the same envelope twice is harmless.
  try { await libp2p.services.pubsub.publish(TOPIC_STRONG, new TextEncoder().encode(JSON.stringify(env))); }
  catch (e) { console.warn(`[${PEER_LABEL}] pubsub publish failed: ${e.message}`); }
  // Only the handshake needs to cross the internet; the per-round state-hash
  // and push notes are bookkeeping and would double the relay load.
  if (viaBus ?? (type === 'evt_action_commit' || type === 'evt_action_reveal' || type === 'evt_map_extend')) bus?.publish('env', env);
  lastEnvelopeAt = Date.now();

  // 2) Append to the on-disk tape under the Radicle work dir — pushed on the hourly lottery.
  const line = JSON.stringify(env);
  const abs = path.join(__dirname, 'sessions', DIM_NAME, 'hashgraph.jsonl');
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, line + '\n');

  // 3) Mirror to the UI.
  broadcastUI({ kind: 'evt', env });
  return env;
}

// Receive envelopes from other peers — same handling whichever transport
// delivered them. An envelope can arrive over libp2p *and* the bus, so dedupe
// on its hash: a duplicate reveal in the tape would resolve twice.
let pubsubRxCount = 0;
let busRxCount = 0;
const envSeen = new Set();
const envSeenOrder = [];
function receiveEnvelope(env, via) {
  if (!env || env.actor_peer_id === PEER_ID_STRING || env.dimension_id !== DIM_ID) return;
  if (!env._hash || envSeen.has(env._hash)) return;
  envSeen.add(env._hash); envSeenOrder.push(env._hash);
  if (envSeenOrder.length > 4000) for (const h of envSeenOrder.splice(0, 2000)) envSeen.delete(h);
  if (via === 'libp2p') pubsubRxCount++; else busRxCount++;
  const n = via === 'libp2p' ? pubsubRxCount : busRxCount;
  if (n <= 3 || n % 50 === 0) console.log(`[${PEER_LABEL}] ${via} rx #${n}: ${env.type} from ${env.actor_peer_id}`);
  hg.otherParent = env._hash;
  hg.tape.push(env);
  if (env.state && mergePeerState(env.state)) broadcastUI({ kind: 'peers', peers: peersForUI() });
  inboxApply(env);
  broadcastUI({ kind: 'evt', env, from_peer: true });
}
libp2p.services.pubsub.addEventListener('message', (ev) => {
  if (ev.detail.topic !== TOPIC_STRONG) return;
  try { receiveEnvelope(JSON.parse(new TextDecoder().decode(ev.detail.data)), 'libp2p'); }
  catch (e) { console.warn(`[${PEER_LABEL}] bad pubsub frame: ${e.message}`); }
});
libp2p.services.pubsub.addEventListener('subscription-change', (ev) => {
  const subs = ev.detail.subscriptions.map(s => `${s.topic}:${s.subscribe ? '+' : '-'}`).join(',');
  console.log(`[${PEER_LABEL}] pubsub sub-change from ${ev.detail.peerId.toString().slice(0, 14)}…: ${subs}`);
});
// Periodic snapshot of gossipsub mesh state.
setInterval(() => {
  try {
    const subs = libp2p.services.pubsub.getSubscribers(TOPIC_STRONG);
    const peers = libp2p.services.pubsub.getPeers();
    const topics = libp2p.services.pubsub.getTopics();
    console.log(`[${PEER_LABEL}] gossip state: topics=${topics.length} totalPeers=${peers.length} subscribersOnStrong=${subs.length} rxCount=${pubsubRxCount} links=${libp2p.getConnections().length}`);
  } catch (e) { console.warn(`[${PEER_LABEL}] gossip state err: ${e.message}`); }
  healMesh().catch(e => console.warn(`[${PEER_LABEL}] mesh heal err: ${e.message}`));
}, 15_000);

// Shared state via Gun: positions / HP are published on each cleanup.
// Also mirrored to the discovery server so peers can see each other even when
// the Gun CRDT or the gossipsub mesh hasn't converged yet (common on localhost
// during the first few turns, which previously caused resolver no-ops and the
// "ally marker disappears" flicker in the UI).
// `slim` is what rides on every envelope (twice a round, to everyone): the
// game-relevant fields only. The network hints (addresses, relays) are static
// and ~600 bytes, so they travel on the heartbeat / Gun / Door paths instead;
// mergePeerState merges rather than replaces, so a slim update never erases
// hints learned earlier. `map_blocks` lets a peer notice it is behind on the
// map and lets the one ahead push its blocks (see mergePeerState).
function currentStateSnapshot(slim = false) {
  const s = {
    peer_id: PEER_ID_STRING, character_id: CHARACTER_ID || null, creature_id: CREATURE_ID || null,
    tile_q: entity.tile.q, tile_r: entity.tile.r, life: entity.life, life_max: entity.lifeMax,
    alliance: entity.alliance, name: entity.name, source_id: entity.sourceId, last_seen: new Date().toISOString(),
    owner_peer_id: ownerPeerId || '', summoned_csv: entity.summons.map(x => x.peer_id).join(','), wards_csv: entity.wards.join(','), entry_q: START_TILE.q, entry_r: START_TILE.r,
    turn: hg.turn, round: hg.round, action: hg.action, phase: currentPhase, phase_ends_at: phaseEndsAt,
    map_blocks: dimMap ? dimMap.blockCount() : 0,
    stat_vitality: entity.stats.vitality, stat_world: entity.stats.world, stat_matter: entity.stats.matter, stat_will: entity.stats.will,
    permanents_csv: permanentsCsv(),
    stat_tokens_json: statTokensJson(), tile_tokens_json: tileTokensJson(), lost_actions: entity.lostActions,
    elem_pen_json: elemPenJson(), perm_power_json: permPowerJson(),
    shield_elems_csv: elemsCsv(entity.shieldElems), disables_json: disablesJson(), every_csv: [...entity.everyPerms].sort().join(','),
    channels_json: channelsJson(), traps_json: trapsJson(), afflictions_json: afflictionsJson(),
    obstacles_json: obstaclesJson(), links_json: linksJson(),
    possessed_by: entity.possessedBy || null,
    class_id: entity.classId || null, class_down_csv: (entity.classDown || []).join(','), class_archived: entity.classArchived ? 1 : 0, class_tapped: entity.classTapped ? 1 : 0,
    class_progress_json: classProgressJson(), class_used_action: entity.classUsedAction ?? -1, armor: entity.armor || 0,
    world_edits_json: JSON.stringify(entity.worldEdits || []),
  };
  if (slim) return s;
  // Live clock + network hints so a joining peer can align its turn counter
  // and dial the mesh. Gun rejects arrays in nested puts, hence the CSV.
  s.gun_url = myGunUrl; s.multiaddrs_csv = myMaddrs.join(',');
  s.nostr_pubkey = bus?.pubkey || null; s.nostr_relays_csv = (bus?.relays || []).join(',');
  return s;
}

// Known-peers map seeded with self so the resolver always has an actor entry
// even if nothing has sync'd yet.
const peersPublic = new Map();
peersPublic.set(PEER_ID_STRING, currentStateSnapshot());

// `last_seen` is kept as a liveness hint, but we no longer drop peers from
// `peersPublic` just because their state updates went silent. In practice
// cross-machine Gun sync + the 15s nostr-bus heartbeat occasionally lose a
// window of updates, and the previous 90s stale-prune was deleting live
// monsters mid-fight — the UI then rendered no tombstone (entity gone) and
// `checkStandoff` saw only the player side alive and fired the "only player
// remains" banner, even though the monsters were still there on their own
// peers. Dead peers stay in `peersPublic` with `life <= 0` so the renderer
// can draw a persistent tombstone; truly ancient entries (process gone for
// over an hour) get swept so the map doesn't leak forever.
const PEER_STALE_MS = 90_000;
const PEER_SWEEP_MS = 60 * 60_000;
const isFresh = p => p && p.peer_id === PEER_ID_STRING || (p && Date.parse(p.last_seen || 0) > Date.now() - PEER_STALE_MS);
// livePeers now returns every peer we've ever confirmed — the handshake,
// standoff and roster logic all tolerate stale snapshots because a stale
// snapshot is still the *last authoritative statement* about that peer.
function livePeers() { return [...peersPublic.values()]; }
// What the browser gets: every snapshot plus the region tier relative to us.
function peersForUI() { return livePeers().map(p => ({ ...p, tier: tierOf(p) })); }
setInterval(() => {
  let swept = 0;
  const cutoff = Date.now() - PEER_SWEEP_MS;
  for (const [id, p] of peersPublic) {
    if (id === PEER_ID_STRING) continue;
    const ls = Date.parse(p?.last_seen || 0);
    if (!Number.isFinite(ls) || ls < cutoff) { peersPublic.delete(id); swept++; }
  }
  if (swept) broadcastUI({ kind: 'peers', peers: peersForUI(), dropped: true });
}, 60_000);

async function postJson(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } catch (e) { /* best-effort; log at caller */ return null; }
}

// Merge another peer's public snapshot, whichever transport brought it, and
// opportunistically try a direct link to it.
const knownTiles = new Map();   // "q,r" -> last time we saw someone there (part of our Door)
function noteTile(q, r) { if (typeof q === 'number' && typeof r === 'number') knownTiles.set(`${q},${r}`, Date.now()); }
function mergePeerState(p) {
  if (!p || typeof p !== 'object' || !p.peer_id || p.peer_id === PEER_ID_STRING) return false;
  if (!isFresh(p)) return false;
  const prev = peersPublic.get(p.peer_id) || {};
  peersPublic.set(p.peer_id, { ...prev, ...p });
  noteTile(p.tile_q, p.tile_r);
  if (p.multiaddrs_csv) dialPeerAddrs(p.peer_id, p.multiaddrs_csv.split(',').filter(Boolean)).catch(() => {});
  if (typeof p.map_blocks === 'number') offerMapSync(p.peer_id, p.map_blocks);
  return true;
}

// -------- the dimension map --------
// Grow-only set of revealed hexes (see js/map.js). Every player reveals a disc
// of REVEAL_RADIUS around itself whenever it stands closer than that to the
// edge of the known world — at spawn and after each move. A disc is a tiny,
// idempotent block, so it travels on every channel we have: the Gun graph of
// this dimension (slow, but survives everyone's reconnects), an
// evt_map_extend envelope over gossipsub + the Nostr bus (fast), and the Door
// on Radicle (what joiners seed from). Receiving the same block twice is a
// no-op, so the order and the transport never matter.
dimMap = createKnownMap(MAP_SEED, [initialBlock(INITIAL_SIZE), ...seedBlocks]);
const gunMap = dimRoot.get('map').get('blocks');
const knownHex = (q, r) => dimMap.has(q, r);
const blockAddedAt = [];   // when each block arrived here (ms), oldest first — see offerMapSync
function mapSummary() { return { seed: MAP_SEED, reveal_radius: REVEAL_RADIUS, blocks: dimMap.blocks(), tiles: dimMap.size(), bounds: dimMap.bounds() }; }
function addMapBlock(b, via) {
  if (!isBlock(b) || !dimMap.addBlock(b)) return false;
  blockAddedAt.push(Date.now());
  console.log(`[${PEER_LABEL}] map +${b.id} via ${via} by ${b.by || '?'} → ${dimMap.size()} hexes in ${dimMap.blockCount()} blocks`);
  broadcastUI({ kind: 'map', map: mapSummary() });
  return true;
}
gunMap.map().on((b) => { if (b && typeof b === 'object') addMapBlock(b, 'gun'); });
// Re-put everything we hold once a minute: Gun relays that came up after a
// block was first written (or that dropped it) converge on the next pass.
function syncMapToGun() { for (const b of dimMap.blocks()) gunMap.get(b.id).put(b); }
syncMapToGun();
setInterval(syncMapToGun, 60_000);
// Positive convergence guarantee on the fast path. Every state snapshot says
// how many blocks its sender holds; when a peer reports fewer than we hold,
// we publish our whole block list as one evt_map_sync (gossipsub + bus),
// rate-limited per lagging peer. Blocks are idempotent, so over-sending is
// harmless, and a joiner that came in through stale Doors (or a clone running
// older code's Doors) catches up within a round instead of waiting on Gun.
// A snapshot's count is as old as the snapshot, and blocks are added every few
// seconds while people explore, so "fewer than we hold right now" is almost
// always just a block still in flight. We only act on a deficit against the
// blocks we have held for MAP_SYNC_RECENT_MS, and only when it either persists
// for MAP_SYNC_LAG_MS (the extend envelope really was missed) or is large
// (a joiner seeded from stale Doors).
const MAP_SYNC_MIN_MS = 30_000, MAP_SYNC_LAG_MS = 20_000, MAP_SYNC_RECENT_MS = 10_000, MAP_SYNC_BIG = 5;
const mapSyncOfferedAt = new Map();   // peer_id -> last offer (ms)
const mapLagSince = new Map();        // peer_id -> first time we saw it behind (ms)
let mapSyncInFlight = false;
function settledBlockCount() {
  const cutoff = Date.now() - MAP_SYNC_RECENT_MS;
  while (blockAddedAt.length && blockAddedAt[0] < cutoff) blockAddedAt.shift();
  return dimMap.blockCount() - blockAddedAt.length;
}
function offerMapSync(peerId, theirBlocks) {
  if (!dimMap) return;
  const settled = settledBlockCount();
  if (theirBlocks >= settled) { mapLagSince.delete(peerId); return; }
  if (!mapLagSince.has(peerId)) mapLagSince.set(peerId, Date.now());
  const persistent = Date.now() - mapLagSince.get(peerId) >= MAP_SYNC_LAG_MS;
  if (!persistent && settled - theirBlocks < MAP_SYNC_BIG) return;
  if (mapSyncInFlight) return;
  const last = mapSyncOfferedAt.get(peerId) || 0;
  if (Date.now() - last < MAP_SYNC_MIN_MS) return;
  mapSyncOfferedAt.set(peerId, Date.now());
  mapSyncInFlight = true;
  console.log(`[${PEER_LABEL}] map sync → ${peerId} holds ${theirBlocks} blocks, we hold ${dimMap.blockCount()} (${settled} settled); publishing full block list`);
  const blocks = dimMap.blocks();
  // Public relays reject large events; past ~40 KB the sync rides gossipsub only.
  const viaBus = JSON.stringify(blocks).length < 40_000;
  emitEnvelope({ type: 'evt_map_sync', payload: { for_peer: peerId, seed: MAP_SEED, blocks }, viaBus })
    .catch(e => console.warn(`[${PEER_LABEL}] map sync failed: ${e.message}`))
    .finally(() => { mapSyncInFlight = false; });
}
async function revealAround(q, r) {
  if (ALLIANCE !== 'player') return;
  if (!dimMap.needsReveal(q, r, REVEAL_RADIUS)) return;
  const b = discBlock(q, r, REVEAL_RADIUS, PEER_ID_STRING);
  if (!addMapBlock(b, 'self')) return;
  gunMap.get(b.id).put(b);
  await emitEnvelope({
    type: 'evt_map_extend',
    payload: {
      block: b,
      block_origin: { x: q, y: r }, block_size: `disc r=${REVEAL_RADIUS}`,
      block_seed: MAP_SEED, new_door_id: PEER_ID_STRING, rooted_at_head: hg.head || '',
      tiles_known: dimMap.size(), bounds: dimMap.bounds(),
    },
  });
}

// `viaBus` is for the heartbeat/startup/join paths; the per-round calls skip
// it because every envelope already carries the snapshot.
async function publishPublicState(viaBus = false) {
  const snap = currentStateSnapshot();
  myNode.put(snap);
  peersPublic.set(PEER_ID_STRING, snap);
  noteTile(snap.tile_q, snap.tile_r);
  if (viaBus) bus?.publish('state', snap);
  if (DISCOVERY_URL) await postJson(`${DISCOVERY_URL}/state`, { dimension_id: DIM_ID, peer_id: PEER_ID_STRING, state: snap });
  broadcastUI({ kind: 'peers', peers: peersForUI() });
}

// -------- public Nostr bus --------
if (NOSTR_ENABLED) {
  bus = createNostrBus({
    relays: DEFAULT_RELAYS, dimId: DIM_ID, label: PEER_LABEL,
    onEvent(type, payload) {
      if (type === 'env') receiveEnvelope(payload, 'bus');
      else if (type === 'state') { if (mergePeerState(payload)) broadcastUI({ kind: 'peers', peers: peersForUI() }); }
    },
  });
  setInterval(() => {
    const s = bus.stats();
    console.log(`[${PEER_LABEL}] bus: ${s.open}/${bus.relays.length} relays, sent ${s.sent}, received ${s.received}${s.dropped ? `, rejected ${s.dropped}` : ''}`);
  }, 60_000);
} else {
  console.log(`[${PEER_LABEL}] nostr bus disabled (NOSTR_ENABLED=0) — only direct links will carry traffic`);
}
await publishPublicState(true);
// Liveness heartbeat independent of the round loop. Every commit/reveal we
// publish already carries our snapshot (and the bus relays those), so the
// heartbeat only goes to the relays when we have been silent — once a side has
// won and the loop stops, or while spectating dead. Otherwise it is a local
// refresh only (Gun + UI). Keeps ~4 relay events/min/pubkey off the public
// relays that rate-limit us.
const HEARTBEAT_MS = 15_000;
setInterval(() => {
  const idle = Date.now() - lastEnvelopeAt > HEARTBEAT_MS - 1000;
  publishPublicState(idle).catch(() => {});
}, HEARTBEAT_MS);

// Also pull every other peer's public state live from Gun (slow-tier CRDT).
// Relay graphs can still carry entries from peers that died; mergePeerState
// only accepts entries that look current, and merges rather than replaces so a
// partial Gun echo (which sometimes drops fields) doesn't wipe tile/life.
dimRoot.get('doors').get(DOOR_ID).get('members').map().on((m) => {
  if (mergePeerState(m)) broadcastUI({ kind: 'peers', peers: peersForUI() });
});

// Optional discovery mirror: pull everyone's registered state and merge.
async function pullDiscoveryState() {
  if (!DISCOVERY_URL) return;
  try {
    const r = await fetch(`${DISCOVERY_URL}/peers/${DIM_ID}`);
    const j = await r.json();
    let changed = false;
    for (const p of j.peers || []) if (p.state && mergePeerState(p.state)) changed = true;
    if (changed) broadcastUI({ kind: 'peers', peers: peersForUI() });
  } catch {}
}
if (DISCOVERY_URL) { setInterval(pullDiscoveryState, 2500); setTimeout(pullDiscoveryState, 1200); }

// -------- phase FSM --------
// planning (10s normal / 6s combat heartbeat) → reveal (5s) → resolution (5s) → cleanup
const PHASES = ['planning', 'reveal', 'resolution', 'cleanup'];
let myLastSalt = null;
let myLastReveal = null;
let myPlayedCardIds = null;   // option cards the resolver actually played this round
let lastAttackTarget = null;  // peer_id of the enemy we last swung at — the no-target Attack fallback

// Alliances in the Ashfall-Micro demo collapse into two sides: the player and
// their npc_a ally fight together, npc_b creatures are the opposition. Treat
// anything we don't recognise as its own side so additional factions could
// be added without breaking existing checks.
function sideOf(alliance) {
  if (alliance === 'player' || alliance === 'npc_a') return 'A';
  if (alliance === 'npc_b') return 'B';
  return alliance;
}
let MY_SIDE = sideOf(ALLIANCE);

function anyAdjacentOpponents() {
  const me = peersPublic.get(PEER_ID_STRING) || { tile_q: entity.tile.q, tile_r: entity.tile.r, alliance: entity.alliance };
  for (const p of peersPublic.values()) {
    if (!p || p.peer_id === PEER_ID_STRING || sideOf(p.alliance) === MY_SIDE) continue;
    if (hexDistance(me, p) <= 1) return true;
  }
  return false;
}
function hexDistance(a, b) {
  const dq = Math.abs(a.tile_q - b.tile_q);
  const dr = Math.abs(a.tile_r - b.tile_r);
  const ds = Math.abs(a.tile_q + a.tile_r - b.tile_q - b.tile_r);
  return (dq + dr + ds) / 2;
}
// Resolver step. Deliberately NOT limited to the known map: the resolver must
// give the same answer on every peer, and peers can hold different revealed
// sets for a few seconds while a block propagates. A mover only ever aims at
// hexes it knows (UI and planner both filter on the known map), and a player
// reveals around itself after landing, so the world always exists wherever
// someone actually stands.
function stepToward(from, to) {
  return hexStepToward({ q: from.q, r: from.r }, { q: to.tile_q, r: to.tile_r });
}

// Rounds end on a fixed ROUND_SEC cadence: each declaration deadline is the
// previous one + ROUND_SEC, so the commit/reveal handshake eats into the next
// window instead of stretching the round. Reveal / resolution are gated on the
// other members' envelopes and only use their ms budget as a cap.
let roundDeadline = phaseEndsAt;
function enterPhase(name) {
  currentPhase = name;
  let ms;
  if (name === 'planning') {
    // Keep at least a 2s declaration window if a handshake ran long.
    roundDeadline = Math.max(roundDeadline + ROUND_SEC * 1000, Date.now() + 2000);
    // Trail the slowest live peer that's at our action and still planning:
    // without this the faster peer tears off to the next handshake while the
    // slower one is still planning, and the drift one-way-ratchets back on
    // the next round. Capped at one extra ROUND_SEC so one hung peer can't
    // freeze the dimension indefinitely.
    const maxLag = Date.now() + ROUND_SEC * 2000;
    let laggingBehind = false;
    for (const p of livePeers()) {
      if (p.peer_id === PEER_ID_STRING || typeof p.action !== 'number') continue;
      // Peer one action behind us is still finishing *their* previous handshake.
      // If we tear off into a new planning window they'll never catch up through
      // their own doResolution — they'll jump via catchUpClock and skip the
      // local entity.tile update, which produces the "dancing hero" drift.
      if (p.action === hg.action - 1) { laggingBehind = true; continue; }
      if (p.action !== hg.action) continue;
      if (p.phase !== 'planning' || typeof p.phase_ends_at !== 'number') continue;
      if (p.phase_ends_at > roundDeadline && p.phase_ends_at < maxLag) roundDeadline = p.phase_ends_at;
    }
    if (laggingBehind) roundDeadline = Math.max(roundDeadline, Math.min(maxLag, Date.now() + ROUND_SEC * 1000));
    phaseEndsAt = roundDeadline;
    ms = phaseEndsAt - Date.now();
  } else {
    ms = name === 'reveal' ? COMMIT_WAIT_MS : REVEAL_WAIT_MS;
    phaseEndsAt = Date.now() + ms;
  }
  broadcastUI({ kind: 'phase', name, seconds: Math.round(ms / 100) / 10, heartbeat: anyAdjacentOpponents(), turn: hg.turn, round: hg.round, rounds_per_turn: ROUNDS_PER_TURN });
}

// Handshake bookkeeping: which strong-region members have committed / revealed
// for a given action. Fed by the pubsub inbox and (for reveals) by discovery.
const commitsSeen = new Map();   // actionKey -> Set(peer_id)
const revealsSeen = new Map();   // actionKey -> Set(peer_id)
function noteSeen(map, env) {
  const k = actionKey(env.turn, env.round);
  if (!map.has(k)) map.set(k, new Set());
  map.get(k).add(env.actor_peer_id);
  if (map.size > 16) for (const key of [...map.keys()].sort((a, b) => a - b).slice(0, map.size - 16)) map.delete(key);
}
// Strong region: the live members within STRONG_RADIUS of us. This is who we
// wait for in the handshake and who our resolver/state hash cover; everyone
// else is heard (positions, map blocks, clock) but never waited on, so a slow
// or silent peer on the far side of the map cannot stall or forfeit us. The
// set is frozen when we commit (`roundMembers`) so a position update arriving
// mid-handshake can't change who we are waiting for.
function computeStrongMembers() {
  const cutoff = Date.now() - 20_000;
  const me = { tile_q: entity.tile.q, tile_r: entity.tile.r };
  return [...peersPublic.values()].filter(p =>
    p && p.peer_id !== PEER_ID_STRING && p.life > 0 && Date.parse(p.last_seen || 0) > cutoff
    && Number.isInteger(p.tile_q) && Number.isInteger(p.tile_r)
    && hexDistance(me, p) <= STRONG_RADIUS
  ).map(p => p.peer_id);
}
let roundMembers = { action: -1, ids: [] };
function freezeRoundMembers() { roundMembers = { action: hg.action, ids: computeStrongMembers() }; return roundMembers.ids; }
// Who we wait for. Commits: the strong region. Reveals: the strong region plus
// EVERY peer whose commit for this action we have seen — a committer is alive,
// at our action and about to reveal, and its reveal may well affect an entity
// inside our region (an attacker 9 hexes away hitting a monster 8 hexes away
// is exactly how Swarm-0936 diverged). Waiting those extra ~100 ms costs
// nothing; dropping their reveal costs a divergence.
function expectedMembers(phase = 'planning') {
  const base = roundMembers.action === hg.action ? roundMembers.ids : computeStrongMembers();
  if (phase !== 'reveal') return base;
  const committed = commitsSeen.get(hg.action);
  if (!committed || !committed.size) return base;
  return [...new Set([...base, ...committed])].filter(id => id !== PEER_ID_STRING);
}
// Reachable tier: anyone who could walk into our strong region within about a
// minute — surfaced to the UI so the roster can show who is "near".
function tierOf(p) {
  if (!p || p.peer_id === PEER_ID_STRING) return 'self';
  if (!Number.isInteger(p.tile_q)) return 'far';
  const d = hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, p);
  return d <= STRONG_RADIUS ? 'strong' : d <= REACH_RADIUS ? 'reachable' : 'far';
}
function allIn(map) {
  const seen = map.get(hg.action) || new Set();
  return expectedMembers(map === revealsSeen ? 'reveal' : 'planning').every(id => seen.has(id));
}
// A member we are still waiting on is "legitimately busy" when its last
// published state says it is at OUR action, in the phase that produces the
// envelope we lack, with a deadline that has not passed yet. The handshake caps
// (COMMIT_WAIT_MS / REVEAL_WAIT_MS) only ever apply to members that are silent
// or overdue — never to one that is simply still inside its planning window.
// Without this, the first peer to finish a round forfeits everyone whose
// window ends a second later; they jump to catch up, finish THEIR round early
// for the same reason, and the dimension splits into cohorts that leapfrog
// each other at twice the designed pace (seen as 3.5 s rounds in the tape).
const HANDSHAKE_HARD_CAP_MS = ROUND_SEC * 2000;
function waitingOnBusyMember(map, phaseWanted) {
  if (Date.now() > phaseEndsAt + HANDSHAKE_HARD_CAP_MS) return false;
  const seen = map.get(hg.action) || new Set();
  const grace = 400;
  for (const id of expectedMembers(phaseWanted)) {
    if (seen.has(id)) continue;
    const p = peersPublic.get(id);
    if (!p || p.action !== hg.action || p.phase !== phaseWanted) continue;
    if (typeof p.phase_ends_at === 'number' && p.phase_ends_at + grace > Date.now()) return true;
  }
  return false;
}
async function pullFromDiscovery(kind, map) {
  if (!DISCOVERY_URL) return;
  try {
    const r = await fetch(`${DISCOVERY_URL}/${kind}/${DIM_ID}/${hg.action}`);
    const j = await r.json();
    for (const d of j[kind] || []) noteSeen(map, { turn: hg.turn, round: hg.round, actor_peer_id: d.peer_id });
  } catch {}
}

function targetTag(t) {
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object' && 'q' in t && 'r' in t) return `tile:${t.q},${t.r}`;
  return '';
}

function wrapTarget(t) {
  if (typeof t === 'string') return { kind: 'character', ref: t };
  if (t && typeof t === 'object' && 'q' in t && 'r' in t) return { kind: 'tile', ref: { q: t.q, r: t.r } };
  return null;
}

// Which actions actually consume a target. actions.json has
// targets_enemy/targets_tile per card; this stays in sync with that data for
// the four basics + the Empty variants.
function stripTargetFor(code, target) {
  switch (code) {
    case 'A':  return target || null;                             // Attack: enemy peer, or an empty tile (interpreted as a move intent)
    case 'M':  return target || null;                             // Move accepts either enemy or tile
    case 'EM': return target && typeof target === 'object' ? target : null; // Empty-Move needs a tile
    // Block, Posture, Empty Posture — no target.
    default:   return null;
  }
}

async function doPlanningEnd() {
  // Dead entities spectate: no commit, no reveal, nothing to resolve. The
  // round loop keeps running so the clock stays aligned with the live mesh
  // (joiners sync against us) and the standoff check can lift when someone new
  // arrives — but a corpse must not keep swinging.
  // A corpse still freezes its member set like everyone else — otherwise a peer
  // that joins mid-action (a freshly summoned creature) is in the dead peer's
  // resolution but in nobody else's, and the two sides disagree on a hit.
  freezeRoundMembers();
  if (entity.life <= 0) { myLastReveal = null; return; }
  // If this is an NPC (not the player tab's peer), auto-plan via weighted AI.
  if (ALLIANCE !== 'player') await npcPlan();

  // Decode the single queued pick. The queue can hold either a hand slot index
  // or one of the Empty-type markers. 'EMPTY' is the combined slot — rule 6
  // says Empty Move must be "declared first", which we interpret as: EM when a
  // tile target was selected before commit, else EP. Nothing picked → EP.
  const q0 = queued[0];
  let card = null;
  let code = 'EP';
  if (q0 === 'EMPTY') {
    const hasTileTarget = target && typeof target === 'object' && 'q' in target && 'r' in target;
    code = hasTileTarget ? 'EM' : 'EP';
  } else if (q0 === 'EP') code = 'EP';
  else if (q0 === 'EM') code = 'EM';
  else if (typeof q0 === 'number' && hand[q0]?.kind === 'action') { card = hand[q0]; code = card.code; }
  // Lost actions (Lightning, Space-bending, Oblivion, Fossilization): this
  // action is sat out as a bare Empty Posture — no card, no skills, no cast.
  // An Oblivion lock holds only while its caster still has the permanent (Rule 24 lets me destroy it).
  entity.lockList = entity.lockList.filter(l => {
    if (l.effect_id !== 'effect_oblivion' || l.by === PEER_ID_STRING) return true;
    const pv = peersPublic.get(l.by);
    return !pv || String(pv.permanents_csv || '').split(',').includes('effect_oblivion');
  });
  syncLost();
  // A Sleep / Confusion affliction lifts once its holder no longer has the permanent (Rule 24 lets my allies destroy it).
  entity.afflictions = entity.afflictions.filter(a => { if (typeof a.until_action === 'number' && a.until_action < hg.action) return false; const pv = peersPublic.get(a.by); return !pv || String(pv.permanents_csv || '').split(',').includes(a.effect_id); });
  // Manipulator (class, user ruling 2026-10-30): a random Action card of my hand is my play this action — I act "as a monster".
  const manipulated = entity.afflictions.find(a => a.effect_id === 'class_manipulator' && a.until_action === hg.action);
  if (manipulated && entity.lostActions <= 0) {
    const slots = hand.map((c, i) => c.kind === 'action' ? i : -1).filter(i => i >= 0);
    if (slots.length) {
      const i = slots[Math.floor(Math.random() * slots.length)];
      card = hand[i]; code = card.code; queued = [i]; queuedSkills = []; queuedExtra = null; queuedEffect = null; queuedEffect2 = null; queuedChain = []; queuedAura = false; casting = null; queuedBonus = [];
      console.log(`[${PEER_LABEL}] manipulated by ${manipulated.by.slice(0, 8)}: ${card.name || card.action_name} (${code}) is forced on me this action`);
      broadcastUI({ kind: 'peek', what: 'forced', text: `Manipulator: ${card.name || card.action_name} is forced on you this action.` });
    }
  }
  // Delay Time (user spec 2026-10-29): each adjacent enemy holding it costs me my last action of the
  // turn — two holders leave me only the first action. Judged now, so the holder's first contact
  // still lets me finish the action I am in.
  const delayHolders = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && p.life > 0 && sideOf(p.alliance) !== MY_SIDE
    && hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, p) <= 1 && String(p.permanents_csv || '').split(',').includes('effect_delay_time')).length;
  const delayed = delayHolders > 0 && hg.round >= Math.max(1, ROUNDS_PER_TURN - delayHolders);
  if (delayed) console.log(`[${PEER_LABEL}] delay time: ${delayHolders} holder(s) adjacent — action ${hg.round + 1}/${ROUNDS_PER_TURN} is lost`);
  const skipping = entity.lostActions > 0 || delayed;
  if (skipping) queuedBonus = [];
  queuedBonus = queuedBonus.slice(0, bonusAllowance());
  const bonusIds = new Set(queuedBonus.flatMap(b => [b.actionCardId, b.extraCardId, ...b.skillCardIds, b.effectCardId]).filter(Boolean));
  if (bonusIds.size) {
    if (card && bonusIds.has(card.card_id)) { card = null; code = code === 'M' ? 'EM' : 'EP'; }
    queuedSkills = queuedSkills.filter(i => !bonusIds.has(hand[i]?.card_id));
    if (typeof queuedEffect === 'number' && bonusIds.has(hand[queuedEffect]?.card_id)) { queuedEffect = null; queuedEffect2 = null; queuedChain = []; }
  }
  if (skipping) { card = null; code = 'EP'; queued = []; queuedSkills = []; queuedExtra = null; queuedEffect = null; queuedEffect2 = null; queuedChain = []; queuedAura = false; casting = null; }
  // Possess (user spec 2026-10-29): while my permanent holds an enemy, my own hero only Empty-Moves /
  // Empty-Postures — the possessed one fights for me. (The Phylactery leg below is the exception.)
  // (user ruling 2026-10-30: the Possess permanent sits in the POSSESSED unit's holding; while it stands I
  // play that unit — my picked action card and target go to it as `proxy`, my own hero holds — and the
  // enemy's first job is to destroy it. The Phylactery trigger is my hero's own move and stays mine.)
  const possessedNow = possessedUnit();
  if (entity.possessing && !possessedNow) {
    console.log(`[${PEER_LABEL}] possess: ${entity.possessing.peer_id.slice(0, 14)} is free again — the Possess card goes to my discard pile`);
    releaseHeldCard(entity.possessing.card_id); entity.possessing = null; publishPublicState().catch(() => {});
  }
  let proxy = null;
  if (possessedNow && !skipping && !queuedPhylactery) {
    proxy = { for: possessedNow.peer_id, action: ['A', 'B', 'M', 'P'].includes(code) ? code : (code === 'EM' ? 'EM' : 'EP'), target };
    console.log(`[${PEER_LABEL}] possess: ${possessedNow.name} plays ${proxy.action} for me; my hero holds`);
    card = null; code = 'EP'; queued = []; queuedSkills = []; queuedExtra = null; queuedEffect = null; queuedEffect2 = null; queuedChain = []; queuedAura = false; casting = null; queuedBonus = [];
  }
  const phylactery = (!skipping && (entity.permanents.has('effect_possess_phylactery') || possessedNow) && queuedPhylactery?.peer_id && queuedPhylactery.perm) ? { ...queuedPhylactery } : null;

  // Battle Trance: two options [c1, c2]; the resolver picks per enemy which one
  // is actually played (Rule 17 instant on top of the whole action).
  const isAction = c => c && c.kind === 'action';
  const tranceCard = queuedSkills.map(i => hand[i]).find(c => c?.is_trance) || null;
  const trance = tranceCard && hand.some(isAction) ? tranceCard : null;
  let extraCard = null;
  let options = null;
  if (trance) {
    if (typeof queuedExtra === 'number' && queuedExtra !== q0 && isAction(hand[queuedExtra])) extraCard = hand[queuedExtra];
    if (code === 'EP' && !extraCard) { card = hand.find(isAction); code = card.code; }
    options = [code, extraCard ? extraCard.code : 'EP'];
  }
  const optionCodes = options || [code];
  const wants = c => optionCodes.includes(c);
  // A skill rides on its action, or — for Move / Posture skills — on an Empty option.
  const ridesOn = req => wants(req) || ((req === 'M' || req === 'P') && (wants('EP') || wants('EM')));

  // Normalise target against the action's actual needs. Block / Posture / EP
  // never target; Attack keeps either an enemy peer or a tile (a tile target
  // turns the Attack into a step toward that hex at resolution time);
  // Empty Move only accepts a tile. This stops a stale selection from one
  // turn leaking into a Block commit as a bogus target.
  // Effect ride: single-Posture cast this pass. Validated action is P / EP, or
  // an instant on any non-trance. Multi-Posture contiguous emit (Rule 19) is
  // not yet modeled. Decided before target normalisation because a targeted
  // effect is the one thing that lets a Posture keep a character target.
  let effectCard = null;
  let effectCard2 = null;   // Rule 23 ∀: the second copy cast together with effectCard
  // What emits an element: Posture / Empty Posture; a Reaver's Attack; a Monk's Move. Moving otherwise interrupts a cast (Rule 19).
  // Enchanter (class, once per action): a non-Posture action (A / B / M) emits once — the queued cast goes on.
  const enchanterNow = entity.permanents.has('class_enchanter') && !entity.classArchived && entity.classUsedAction !== hg.action && !options && ['A', 'B', 'M'].includes(code) && (typeof queuedEffect === 'number' || !!casting);
  const emitsLong = wants('P') || wants('EP') || (!options && code === 'EP') || (isReaver() && wants('A')) || (isMonk() && (wants('M') || wants('EM'))) || enchanterNow;
  const emits = (c, every) => castInstant(c, every) || emitsLong;
  if (enchanterNow) { entity.classUsedAction = hg.action; console.log(`[${PEER_LABEL}] enchanter: this ${code} emits an element too (once per action)`); }
  const auraEvery = entity.permanents.has('effect_aura') && entity.everyPerms.has('effect_aura');
  // The plan being emitted this action: the cast in progress, else what is queued.
  let plan = null, chainStep = 1;
  if (casting) {
    // Rule 19: a cast in progress continues on any emitting action as long as
    // the player did not switch to another effect; anything else interrupts it.
    const at = chainAt(casting.entries, casting.emitted + 1);
    const c0 = at && hand.find(c => c.card_id === at.entry.cardId);
    const allHeld = casting.entries.every(e => hand.some(c => c.card_id === e.cardId) && (!e.every || hand.some(c => c.card_id === e.cardId2)));
    const qc = typeof queuedEffect === 'number' ? hand[queuedEffect] : null;
    const switched = qc?.kind === 'effect' && !casting.entries.some(e => e.cardId === qc.card_id || e.cardId2 === qc.card_id);
    if (c0 && allHeld && !trance && !switched && (casting.entries.length === 1 ? emits(c0, at.entry.every) : emitsLong)) {
      plan = casting; chainStep = casting.emitted + 1;
      // Cards joining the cast now: the element going out is their first one.
      const jn = joinableNow();
      if (jn) for (const i of queuedChain) {
        const c = hand[i];
        if (c?.kind !== 'effect' || casting.entries.some(e => e.cardId === c.card_id || e.cardId2 === c.card_id) || !chainsOnto(jn.tail, c)) break;
        casting.entries.push({ cardId: c.card_id, cardId2: null, effectId: c.effect_id, every: false, len: castLength(c, false), kept: null });
        jn.tail = c; jn.elem = c.element_cost[c.element_cost.length - 1];
        console.log(`[${PEER_LABEL}] ${c.effect_id} joins the cast on ${c.element_cost[0]}`);
      }
      queuedChain = [];
    }
    else { console.log(`[${PEER_LABEL}] cast of ${casting.entries.map(e => e.effectId).join('→')} interrupted after ${casting.emitted} element(s)`); casting = null; }
  }
  if (!plan && !trance && typeof queuedEffect === 'number' && hand[queuedEffect]?.kind === 'effect') {
    const ec = hand[queuedEffect];
    const c2 = typeof queuedEffect2 === 'number' ? hand[queuedEffect2] : null;
    const pair = c2?.kind === 'effect' && c2.effect_id === ec.effect_id && c2.card_id !== ec.card_id ? c2 : null;
    const entries = [{ cardId: ec.card_id, cardId2: pair?.card_id || null, effectId: ec.effect_id, every: !!pair, len: castLength(ec, !!pair), kept: null }];
    let tail = ec;
    for (const i of queuedChain) {
      const c = hand[i];
      if (c?.kind !== 'effect' || entries.some(e => e.cardId === c.card_id || e.cardId2 === c.card_id) || !chainsOnto(tail, c)) break;
      entries.push({ cardId: c.card_id, cardId2: null, effectId: c.effect_id, every: false, len: castLength(c, false), kept: null });
      tail = c;
    }
    const ok = entries.length === 1 ? emits(ec, !!pair) : emitsLong;
    if (ok) plan = { entries, emitted: 0, aura: queuedAura && auraEvery };
  }
  // Rule 24: emitting against a token replaces casting (unless Aura lets you do both).
  let destroy = null;
  if (queuedDestroy && !trance && (wants('P') || wants('EP') || (isReaver() && wants('A')) || (isMonk() && wants('M')))) {
    destroy = { stat: queuedDestroy.stat, ...(queuedDestroy.class ? { class: queuedDestroy.class, elem: queuedDestroy.elem || null } : {}), ...(queuedDestroy.recast ? { recast: true } : {}), ...(queuedDestroy.untap ? { untap: true } : {}) };
    if (!entity.permanents.has('effect_aura')) {
      if (casting) console.log(`[${PEER_LABEL}] cast of ${casting.entries.map(e => e.effectId).join('→')} dropped to emit against a token`);
      plan = null; casting = null;
    }
  }
  let effectStep = 1, effectOf = 0, chainTotal = 0, chainEnd = 0, every = false, effectKept = null;
  // Empower (user spec 2026-10-29): the permanent is spent to put two elements of this cast out in one action.
  let empowered = false;
  if (plan && entity.permanents.has('effect_empower')) {
    const at0 = chainAt(plan.entries, chainStep);
    if (at0 && at0.step < at0.of) { chainStep += 1; empowered = true; console.log(`[${PEER_LABEL}] empower: ${at0.entry.effectId} emits two elements this action`); }
  }
  if (plan) {
    const at = chainAt(plan.entries, chainStep);
    effectCard = hand.find(c => c.card_id === at.entry.cardId) || null;
    effectCard2 = at.entry.every ? hand.find(c => c.card_id === at.entry.cardId2) || null : null;
    every = !!at.entry.every; effectStep = at.step; effectOf = at.of; chainTotal = at.total; chainEnd = at.end;
    effectKept = Array.isArray(at.entry.kept) ? [...at.entry.kept] : null;
  }
  // Attached card: Traps Mastery lays an effect from my hand as its trap (the one with most
  // elements = most trap power unless the player picked one); Space Bending's alt leg lays a
  // random one when nobody is in reach. The card only leaves my hand if the trap actually lands.
  let attachCard = null;
  if (effectCard && (EFFECT_RULES[effectCard.effect_id]?.trapAttach || EFFECT_RULES[effectCard.effect_id]?.altTrap || EFFECT_RULES[effectCard.effect_id]?.blessAttach)) {
    const inPlan = new Set((plan?.entries || []).flatMap(e => [e.cardId, e.cardId2]).filter(Boolean));
    const others = hand.filter(c => c.kind === 'effect' && !inPlan.has(c.card_id) && !bonusIds.has(c.card_id) && c.card_id !== effectCard.card_id && c.card_id !== effectCard2?.card_id);
    attachCard = (typeof queuedAttach === 'number' && others.find(c => c.card_id === hand[queuedAttach]?.card_id)) || null;
    if (!attachCard && others.length) {
      attachCard = EFFECT_RULES[effectCard.effect_id]?.altTrap
        ? others[Math.floor(Math.random() * others.length)]
        : [...others].sort((a, b) => (b.element_cost.length - a.element_cost.length) || a.effect_id.localeCompare(b.effect_id))[0];
    }
  }
  // Spirit Link: the ally stat the player clicked, else the biggest stat among my living allies.
  let effectLink = null;
  if (effectCard && EFFECT_RULES[effectCard.effect_id]?.spiritLink) {
    const allies = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && p.life > 0 && sideOf(p.alliance) === MY_SIDE);
    const chosen = queuedLink && allies.find(p => p.peer_id === queuedLink.peer_id) ? queuedLink : null;
    if (chosen) effectLink = { peer_id: chosen.peer_id, stat: chosen.stat };
    else {
      let best = null;
      for (const p of allies) for (const sk of ['vitality', 'world', 'matter', 'will']) { const v = p[`stat_${sk}`] ?? 0; if (!best || v > best.value) best = { peer_id: p.peer_id, stat: sk, value: v }; }
      if (best) effectLink = { peer_id: best.peer_id, stat: best.stat };
    }
  }
  // Class ability (user ruling 2026-10-30): the class card clicked in the permanents strip. Local ones
  // (card recovery, Summoner's card, Weapon Master's draw) happen here; the rest travel in the reveal as
  // `classAbility` and are judged by every peer in the resolver. Tap / once-per-action bookkeeping is
  // settled when the outcome says the ability really fired (resolver ones) or right here (local ones).
  let classAbility = null;
  if (queuedClassAbility && entity.classId && !entity.classArchived && entity.permanents.has(entity.classId) && !skipping) {
    const cid = entity.classId, kind = classKindOf(cid);
    const ready = kind === 'tap' ? !entity.classTapped : entity.classUsedAction !== hg.action;
    const spend = () => { if (kind === 'tap') entity.classTapped = true; else entity.classUsedAction = hg.action; };
    const local = CLASS_LOCAL[cid];
    if (!ready) console.log(`[${PEER_LABEL}] class ${entity.className}: ability not ready (${kind === 'tap' ? 'tapped — emit every colour to untap' : 'already used this action'})`);
    else if (local) { const note = local(); if (note) { spend(); console.log(`[${PEER_LABEL}] class ${entity.className}: ${note}`); } else console.log(`[${PEER_LABEL}] class ${entity.className}: nothing to do`); }
    else {
      const need = CLASS_NEEDS[cid] || null;
      const attachCardC = (need === 'attach_effect' || need === 'attach_nonaction') && typeof queuedAttach === 'number' ? hand[queuedAttach] : null;
      const attachOk = need === 'attach_effect' ? attachCardC?.kind === 'effect' : need === 'attach_nonaction' ? !!attachCardC && attachCardC.kind !== 'action' : true;
      if (!attachOk) console.log(`[${PEER_LABEL}] class ${entity.className}: click the card in hand it works on first`);
      else classAbility = {
        id: cid, target,
        attach: attachCardC ? { card_id: attachCardC.card_id, kind: attachCardC.kind, name: attachCardC.name, effect_id: attachCardC.effect_id || null, skill_id: attachCardC.skill_id || null, elements: attachCardC.element_cost ? [...attachCardC.element_cost] : [] } : null,
        stat: queuedDestroy?.stat || ['vitality', 'world', 'matter', 'will'].sort((a, b) => (entity.stats[b] || 0) - (entity.stats[a] || 0))[0],
      };
    }
  }
  const mySkills = queuedSkills.map(i => hand[i]).filter(c => c?.kind === 'skill' && (c.is_trance ? !!trance : ridesOn(c.requires)));
  mySkills.sort((a, b) => a.skill_id.localeCompare(b.skill_id));
  const skillIds = mySkills.map(c => c.skill_id);
  // A targeted effect, or Counter Spell, is what lets a Posture keep a character target.
  const effectNeedsTarget = (!!effectCard && effectCard.scope === 'target') || skillIds.includes('skill_counter_spell');

  let normTarget = options
    ? (wants('A') || wants('M') ? stripTargetFor('A', target) : wants('EM') ? stripTargetFor('EM', target) : null)
    : stripTargetFor(code, target);
  // Posture / EP strip the target, but a targeted effect riding on them needs
  // the enemy the player pointed at (right-click). Only a character target
  // counts — a tile means nothing to an effect.
  if (effectNeedsTarget && !normTarget && typeof target === 'string') normTarget = target;
  // A tile-working effect (Teleport, …) keeps the tile the player picked (general_ux_range_cast_target).
  const effectTakesTile = !!effectCard && !!EFFECT_RULES[effectCard.effect_id]?.tileTarget;
  if (effectTakesTile && !normTarget && target && typeof target === 'object' && 'q' in target) normTarget = { q: target.q, r: target.r };

  // Attack — or a targeted effect — with no target would resolve into nothing.
  // Fall back to the enemy we last attacked (if still alive), else the nearest
  // living enemy — random among ties. Resolved here, before commit, so the
  // reveal carries a concrete target and every peer resolves the same thing.
  // Effects only autofocus enemies in contact (Rule 14 C): far away there is
  // nothing to hit, so the cast simply fizzles with no target.
  if ((wants('A') || effectNeedsTarget) && !normTarget) {
    const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
    let enemies = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && sideOf(p.alliance) !== MY_SIDE && p.life > 0);
    if (!wants('A')) enemies = enemies.filter(p => hexDistance(here, p) <= 1);
    let pick = enemies.find(p => p.peer_id === lastAttackTarget) || null;
    if (!pick && enemies.length) {
      const dmin = Math.min(...enemies.map(p => hexDistance(here, p)));
      const nearest = enemies.filter(p => hexDistance(here, p) === dmin);
      pick = nearest[Math.floor(Math.random() * nearest.length)];
    }
    if (pick) normTarget = pick.peer_id;
  }
  if ((wants('A') || effectNeedsTarget) && typeof normTarget === 'string') lastAttackTarget = normTarget;
  // Bonus rounds (Haste / Balefire): each one action card (or Empty), its
  // matching skills, and an effect — an instant, or a cast whose elements go
  // out over consecutive bonus plans (step k of n). Attacks and targeted
  // effects autotarget like the main action. Cards used once stay used.
  const bonus = [];
  // Balefire(6): every card is an instant, but still ONE element emission per action — the main
  // plan's cast / destroy counts, then at most one emitting bonus plan keeps its effect.
  const balefire = entity.permanents.has('effect_balefire');
  let emissions = (plan ? 1 : 0) + (destroy ? 1 : 0);
  if (queuedBonus.length && !trance) {
    const used = new Set();
    for (let k = 0; k < queuedBonus.length; k++) {
      const q = { ...queuedBonus[k] };
      if (balefire && (q.effectCardId || q.destroy)) {
        if (emissions >= 1) { q.effectCardId = null; q.destroy = null; }
        else emissions++;
      }
      const bCard = q.actionCardId && !used.has(q.actionCardId) ? hand.find(c => c.card_id === q.actionCardId && c.kind === 'action') : null;
      if (bCard) used.add(bCard.card_id);
      const bTileTarget = q.target && typeof q.target === 'object' && 'q' in q.target;
      const bCode = bCard ? bCard.code : (bTileTarget ? 'EM' : 'EP');
      // Battle Trance in a bonus plan: two options, the second card (or EP) is the other.
      const bTranceCard = q.skillCardIds.map(id => hand.find(c => c.card_id === id)).find(c => c?.kind === 'skill' && c.is_trance && !used.has(c.card_id)) || null;
      const bExtra = bTranceCard && q.extraCardId && !used.has(q.extraCardId) ? hand.find(c => c.card_id === q.extraCardId && c.kind === 'action' && c.code !== bCode) || null : null;
      const bOptions = bTranceCard ? [bCode, bExtra ? bExtra.code : 'EP'] : null;
      if (bTranceCard) used.add(bTranceCard.card_id);
      if (bExtra) used.add(bExtra.card_id);
      const ridesCode = (req, code) => req === code || (code === 'EP' && req === 'P') || (code === 'EM' && req === 'M');
      const rides = (req) => bOptions ? bOptions.some(c => ridesCode(req, c)) : ridesCode(req, bCode);
      const bSkills = q.skillCardIds.filter(id => !used.has(id)).map(id => hand.find(c => c.card_id === id)).filter(c => c?.kind === 'skill' && !c.is_trance && rides(c.requires)).sort((a, b) => a.skill_id.localeCompare(b.skill_id));
      for (const c of bSkills) used.add(c.card_id);
      if (bTranceCard) bSkills.unshift(bTranceCard);
      const bEff = !bTranceCard && q.effectCardId ? hand.find(c => c.card_id === q.effectCardId && c.kind === 'effect') || null : null;
      const bEmits = !bTranceCard && (bCode === 'P' || bCode === 'EP' || (isReaver() && bCode === 'A') || (isMonk() && bCode === 'M'));
      const bDestroy = q.destroy && bEmits ? { stat: q.destroy } : null;
      // A cast continues across plans: step = how many plans in a row already carried this card, +1.
      let step = 1;
      for (let j = k - 1; j >= 0 && queuedBonus[j].effectCardId === q.effectCardId; j--) step++;
      const of = bEff ? castLength(bEff, false) : 0;
      const effOK = bEff && !(bEff.is_instant ? false : !(bCode === 'P' || bCode === 'EP' || (isReaver() && bCode === 'A') || (isMonk() && (bCode === 'M' || bCode === 'EM'))));
      let bTarget = stripTargetFor(bCode, q.target);
      if (effOK && bEff.scope === 'target' && !bTarget && typeof q.target === 'string') bTarget = q.target;
      if ((bCode === 'A' || (effOK && bEff.scope === 'target')) && !bTarget) {
        const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
        let enemies = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && sideOf(p.alliance) !== MY_SIDE && p.life > 0);
        if (bCode !== 'A') enemies = enemies.filter(p => hexDistance(here, p) <= 1);
        if (enemies.length) { const dmin = Math.min(...enemies.map(p => hexDistance(here, p))); bTarget = enemies.filter(p => hexDistance(here, p) === dmin).sort((a, b) => a.life - b.life || a.peer_id.localeCompare(b.peer_id))[0].peer_id; }
      }
      bonus.push({
        action: bOptions ? 'BT' : bCode, trance: bOptions, cardId: bCard?.card_id || null, extraCardId: bExtra?.card_id || null, target: bTarget, destroy: bDestroy,
        skillIds: bSkills.map(c => c.skill_id), skillNames: bSkills.map(c => c.name), skillCardIds: bSkills.map(c => c.card_id),
        effectCardId: effOK ? bEff.card_id : null,
        effect: effOK ? { effect_id: bEff.effect_id, name: bEff.name, elements: [...bEff.element_cost], types: bEff.effect_types || [], is_permanent: !!bEff.is_permanent, is_damage: !!bEff.is_damage, is_point_buy: !!bEff.is_point_buy, scope: bEff.scope || null, is_instant: !!bEff.is_instant, every: false, aura: false, step: Math.min(step, of), of, summon: bEff.summon || null } : null,
      });
    }
  }
  const revealCode = trance ? 'BT' : code;
  myLastSalt = randomBytes(12).toString('hex');
  const effectTag = effectCard ? `${effectCard.effect_id}${every ? '∀' : ''}:${effectCard.element_cost.join('+')}:${effectStep}/${effectOf}:${(effectKept || []).map(v => v ?? '-').join(',')}` : '';
  const bonusTag = bonus.map(b => `${b.action}${b.trance ? `[${b.trance.join('+')}]` : ''}:${targetTag(b.target)}:${b.skillIds.join(',')}:${b.effect ? `${b.effect.effect_id}${b.effect.step}/${b.effect.of}` : ''}:${b.destroy ? b.destroy.stat : ''}`).join('|');
  const commitHash = sha256Hex(`${revealCode}::${targetTag(normTarget)}::${skillIds.join(',')}::${trance ? options.join('+') : ''}::${effectTag}::${destroy ? destroy.stat : ''}::${bonusTag}::${myLastSalt}`);
  myLastReveal = {
    code: revealCode, trance: options, target: normTarget, salt: myLastSalt, cardId: card ? card.card_id : null,
    optionCardIds: [card ? card.card_id : null, extraCard ? extraCard.card_id : null],
    skillIds, skillNames: mySkills.map(c => c.name), skillCardIds: mySkills.map(c => c.card_id),
    effectId: effectCard?.effect_id || null,
    effectCardId: effectCard?.card_id || null,
    effectCardId2: effectCard2?.card_id || null,
    effectEvery: every,
    effectAura: !!plan?.aura,
    effectKept,
    chain: plan ? { entries: plan.entries, step: chainStep, total: chainTotal, end: chainEnd, aura: !!plan.aura } : null,
    effectName: effectCard?.name || null,
    effectElements: effectCard ? [...effectCard.element_cost] : null,
    effectTypes: effectCard?.effect_types || null,
    effectPermanent: !!effectCard?.is_permanent || (every && effectCard?.effect_id === 'effect_shield'),
    effectDamage: !!effectCard?.is_damage,
    effectPointBuy: !!effectCard?.is_point_buy,
    effectScope: effectCard?.scope || null,
    effectInstant: effectCard ? castInstant(effectCard, every) : false,
    effectSummon: effectCard?.summon || null,
    effectAttach: attachCard ? { effect_id: attachCard.effect_id, name: attachCard.name, elements: [...attachCard.element_cost], card_id: attachCard.card_id } : null,
    effectLink, empowered,
    effectElem: effectCard && EFFECT_RULES[effectCard.effect_id]?.altTileToken ? (queuedElem || null) : null,
    effectStep, effectOf,
    skipping, destroy, phylactery, proxy, classAbility,
    bonus,
  };
  await emitEnvelope({
    type: 'evt_action_commit',
    payload: { commitment: commitHash, empty_move_announced: code === 'EM' },
  });
  if (DISCOVERY_URL) await postJson(`${DISCOVERY_URL}/commit`, { dimension_id: DIM_ID, peer_id: PEER_ID_STRING, turn: hg.action, commitment: commitHash });
}

async function doReveal() {
  if (!myLastReveal) return;
  const targetObj = wrapTarget(myLastReveal.target);
  await emitEnvelope({
    type: 'evt_action_reveal',
    payload: {
      action: myLastReveal.code,
      trance: myLastReveal.trance || null,
      effects: myLastReveal.effectId ? [{
        effect_id: myLastReveal.effectId,
        name: myLastReveal.effectName,
        elements: myLastReveal.effectElements || [],
        types: myLastReveal.effectTypes || [],
        is_permanent: myLastReveal.effectPermanent,
        is_damage: myLastReveal.effectDamage,
        is_point_buy: myLastReveal.effectPointBuy,
        scope: myLastReveal.effectScope,
        is_instant: myLastReveal.effectInstant, every: myLastReveal.effectEvery, aura: myLastReveal.effectAura,
        step: myLastReveal.effectStep, of: myLastReveal.effectOf, kept: myLastReveal.effectKept, summon: myLastReveal.effectSummon || null,
        attach: myLastReveal.effectAttach || null, card_id: myLastReveal.effectCardId || null, link: myLastReveal.effectLink || null, elem: myLastReveal.effectElem || null,
      }] : [],
      skills: myLastReveal.skillIds, skill_names: myLastReveal.skillNames, class_ability_tapped: false,
      destroy: myLastReveal.destroy || null,
      phylactery: myLastReveal.phylactery || null,
      proxy: myLastReveal.proxy ? { for: myLastReveal.proxy.for, action: myLastReveal.proxy.action, target: wrapTarget(myLastReveal.proxy.target) } : null,
      class_ability: myLastReveal.classAbility ? { id: myLastReveal.classAbility.id, target: wrapTarget(myLastReveal.classAbility.target), attach: myLastReveal.classAbility.attach || null, stat: myLastReveal.classAbility.stat || null } : null,
      bonus: bonusWire(myLastReveal.bonus),
      target: targetObj,
      combo_step: null,
      salt: myLastReveal.salt,
    },
  });
  // Optional discovery mirror (buckets reveals by the global action index).
  if (DISCOVERY_URL) await postJson(`${DISCOVERY_URL}/reveal`, {
    dimension_id: DIM_ID, peer_id: PEER_ID_STRING, turn: hg.action,
    action: myLastReveal.code, target: targetObj,
  });
}

async function doResolution() {
  // Deterministic resolver over all revealed actions this round.
  const edges = data.battle_system.battle_system_core.data.resolution_matrix.edges;
  const edgeMap = {};
  for (const e of edges) (edgeMap[e.actor] ||= {})[e.defender] = e.bonus_damage_to_actor;

  // The resolver's view of the world. Every reveal envelope carries its actor's
  // snapshot (tile, life) taken when the reveal was sent — the same bytes on
  // every peer that received it. Resolving against THAT, rather than against
  // our live `peersPublic` (which a late state message can mutate between two
  // peers' resolution ticks), is what makes two peers compute the same
  // outcome for the same reveals. Members who did not reveal this round fall
  // back to the last snapshot we hold; they do not move, so that only matters
  // for occupancy and targeting.
  // Every reveal we hold is applied, whatever tier its actor is in: the
  // resolver's effects are local (attacks are adjacent, moves are bounded and
  // only contend for occupancy), so a far actor only ever changes far
  // entities, and the state hash compares entities both peers resolved. The
  // region tiers decide whom we WAIT for, never whose reveal we use.
  const view = new Map(peersPublic);
  const revealsThisTurn = [];
  for (const env of hg.tape) {
    if (env.type !== 'evt_action_reveal' || env.turn !== hg.turn || env.round !== hg.round) continue;
    if (revealsThisTurn.some(r => r.actor === env.actor_peer_id)) continue;
    const effArr = Array.isArray(env.payload.effects) ? env.payload.effects : [];
    const eff0 = effArr[0] || null;
    revealsThisTurn.push({ actor: env.actor_peer_id, action: env.payload.action, target: env.payload.target || null, skills: Array.isArray(env.payload.skills) ? env.payload.skills : [], trance: Array.isArray(env.payload.trance) && env.payload.trance.length === 2 ? [...env.payload.trance] : null, effect: eff0, salt: env.payload.salt || '', destroy: env.payload.destroy || null, phylactery: env.payload.phylactery || null, proxy: env.payload.proxy || null, classAbility: env.payload.class_ability || null, bonus: env.payload.bonus || null });
    const s = env.state;
    if (s && s.peer_id === env.actor_peer_id && Number.isInteger(s.tile_q) && Number.isInteger(s.tile_r)) {
      view.set(env.actor_peer_id, { ...(view.get(env.actor_peer_id) || {}), ...s });
    }
  }
  // Our own entity is authoritative for ourselves.
  view.set(PEER_ID_STRING, { ...(view.get(PEER_ID_STRING) || {}), ...currentStateSnapshot() });
  // Include our own reveal in case we didn't receive it from pubsub self-echo.
  if (myLastReveal && !revealsThisTurn.find(r => r.actor === PEER_ID_STRING)) {
    revealsThisTurn.push({ actor: PEER_ID_STRING, action: myLastReveal.code, target: wrapTarget(myLastReveal.target), skills: myLastReveal.skillIds || [], trance: myLastReveal.trance ? [...myLastReveal.trance] : null, salt: myLastReveal.salt, destroy: myLastReveal.destroy || null, phylactery: myLastReveal.phylactery || null, proxy: myLastReveal.proxy ? { for: myLastReveal.proxy.for, action: myLastReveal.proxy.action, target: wrapTarget(myLastReveal.proxy.target) } : null, classAbility: myLastReveal.classAbility ? { id: myLastReveal.classAbility.id, target: wrapTarget(myLastReveal.classAbility.target), attach: myLastReveal.classAbility.attach || null, stat: myLastReveal.classAbility.stat || null } : null, bonus: bonusWire(myLastReveal.bonus), effect: myLastReveal.effectId ? {
      effect_id: myLastReveal.effectId, name: myLastReveal.effectName, elements: myLastReveal.effectElements || [], types: myLastReveal.effectTypes || [],
      is_permanent: myLastReveal.effectPermanent, is_damage: myLastReveal.effectDamage, is_point_buy: myLastReveal.effectPointBuy, scope: myLastReveal.effectScope,
      is_instant: myLastReveal.effectInstant, every: myLastReveal.effectEvery, aura: myLastReveal.effectAura, step: myLastReveal.effectStep, of: myLastReveal.effectOf, kept: myLastReveal.effectKept, summon: myLastReveal.effectSummon || null,
      attach: myLastReveal.effectAttach || null, card_id: myLastReveal.effectCardId || null, link: myLastReveal.effectLink || null, elem: myLastReveal.effectElem || null,
    } : null });
  }
  // Optional discovery mirror: merge any reveals it has for this action.
  if (DISCOVERY_URL) try {
    const r = await fetch(`${DISCOVERY_URL}/reveals/${DIM_ID}/${hg.action}`);
    const j = await r.json();
    for (const d of j.reveals || []) {
      if (revealsThisTurn.find(x => x.actor === d.peer_id)) continue;
      revealsThisTurn.push({ actor: d.peer_id, action: d.action, target: d.target || null, skills: [], trance: null, effect: null });
    }
  } catch {}
  // Reveals from entities at 0 hp are ignored everywhere (stale discovery
  // mirrors, late gossip, a peer that died mid-handshake) so no resolver ever
  // lets a corpse deal damage or claim a tile. Life is public state, so every
  // peer filters the same set.
  let bonusDmgToMe = 0;   // Haste bonus rounds land before the normal action; my entity.life is only written once, below
  const lifeOf = (id) => id === PEER_ID_STRING ? entity.life - bonusDmgToMe : (view.get(id)?.life ?? 0);
  for (let i = revealsThisTurn.length - 1; i >= 0; i--) if (lifeOf(revealsThisTurn[i].actor) <= 0) revealsThisTurn.splice(i, 1);
  revealsThisTurn.sort((a, b) => a.actor.localeCompare(b.actor));

  // Resolve a target object into the tile the target occupies / points at. A
  // character target reads the peer's current public tile; a tile target is
  // just a {q, r}.
  const tileOf = (targ) => {
    if (!targ) return null;
    if (targ.kind === 'tile' && targ.ref) return { q: targ.ref.q, r: targ.ref.r };
    if (targ.kind === 'character' && targ.ref) {
      const p = view.get(targ.ref);
      return p ? { q: p.tile_q, r: p.tile_r } : null;
    }
    return null;
  };

  // The core (skills → stances → trance → movement → damage → effects) is a
  // pure function of the reveals so it can be re-run: once for real, then once
  // per instant I played with that instant removed, to learn whether it earned
  // its keep (Rule 8 pc override — an instant that neither saved me a point of
  // damage nor added one goes back to my hand). Counterfactual runs are quiet
  // and touch nothing outside their own return value.
  const pristineReveals = structuredClone(revealsThisTurn);
  const simulate = (reveals, quiet, opts = {}) => {
  const bonusRound = !!opts.bonus;   // bonus rounds: everyone else is idle — only the action's base damage lands
  const revealsThisTurn = reveals;
  const log = quiet ? () => {} : (...a) => console.log(...a);
  // Skills (Rule 17 instants, Rule 8 "prohibitions apply as a replacement").
  // `effAction` is what each actor effectively does after every skill in play
  // has had its say; everything below resolves against it, never `r.action`.
  // Read live off the reveal (not a frozen copy): the Counter Spell pre-pass
  // strips skills from a reveal and everything after must see them gone.
  const byActorPre = new Map(revealsThisTurn.map(r => [r.actor, r]));
  const has = (id, skill) => (byActorPre.get(id)?.skills || []).includes(skill);
  const permsOfRaw = (id) => id === PEER_ID_STRING
    ? [...entity.permanents]
    : String(view.get(id)?.permanents_csv || '').split(',').filter(Boolean);
  // A lock (Lightning, Oblivion, …) only stops you acting: permanents and tokens
  // stay attached and working until destroyed (user ruling).
  const permsOf = (id) => permsOfRaw(id);
  const hasPerm = (id, skill) => permsOf(id).includes(skill);
  // Class state as the snapshot tells it (mine from the entity): id, colours down, archived, tapped, progress.
  const classStateOf = (id) => {
    if (id === PEER_ID_STRING) return { class_id: entity.classId || null, down: [...(entity.classDown || [])], archived: !!entity.classArchived, tapped: !!entity.classTapped, progress: entity.classProgress || null, usedAction: entity.classUsedAction ?? -1 };
    const v = view.get(id) || {};
    return { class_id: v.class_id || permsOfRaw(id).find(p => p.startsWith('class_')) || null, down: String(v.class_down_csv || '').split(',').filter(Boolean), archived: !!v.class_archived, tapped: !!v.class_tapped, progress: parseJson(v.class_progress_json, null), usedAction: typeof v.class_used_action === 'number' ? v.class_used_action : -1 };
  };
  // A class ability may be used when the class stands on the board and (tap) is not tapped / (once per action) not yet used this action.
  const classReady = (id, classId) => { const cs = classStateOf(id); return cs.class_id === classId && !cs.archived && hasPerm(id, classId) && (classKindOf(classId) === 'tap' ? !cs.tapped : cs.usedAction !== hg.action); };
  const distBetween = (a, b) => {
    const pa = view.get(a), pb = view.get(b);
    return pa && pb ? hexDistance({ tile_q: pa.tile_q, tile_r: pa.tile_r }, { tile_q: pb.tile_q, tile_r: pb.tile_r }) : Infinity;
  };
  // Possess (user ruling 2026-10-30): the possessed unit keeps its alliance but fights on its possessor's
  // side — and is driven by them — while the Possess permanent stands in ITS holding and the possessor lives.
  const possessorOf = (id) => {
    const v = view.get(id);
    const by = v?.possessed_by || null;
    return by && by !== id && permsOfRaw(id).includes('effect_possess_phylactery') && (view.get(by)?.life ?? 0) > 0 ? by : null;
  };
  const sideOfId = (id) => { const by = possessorOf(id); const v = view.get(by || id); return v ? sideOf(v.alliance) : null; };
  const enemyOf = (a, b) => {
    const sa = sideOfId(a), sb = sideOfId(b);
    return sa !== null && sb !== null && sa !== sb;
  };
  // The possessor's reveal carries `proxy: { for, action, target }` — that is what the possessed unit does
  // this action (its own reveal, if any, is overruled); the possessor's own hero only holds (EP).
  for (const r of revealsThisTurn) {
    const px = r.proxy;
    if (!px?.for || possessorOf(px.for) !== r.actor) continue;
    const act = ['A', 'B', 'M', 'P', 'EM', 'EP'].includes(px.action) ? px.action : 'EP';
    const own = revealsThisTurn.find(o => o.actor === px.for);
    if (own) { own.action = act; own.target = px.target || null; own.skills = []; own.trance = null; own.effect = null; own.bonus = null; own.destroy = null; own.proxied = true; }
    else { const nr = { actor: px.for, action: act, target: px.target || null, skills: [], trance: null, effect: null, salt: `${r.salt || ''}:proxy`, destroy: null, bonus: null, proxied: true }; revealsThisTurn.push(nr); byActorPre.set(px.for, nr); }
    if (r.actor === PEER_ID_STRING || px.for === PEER_ID_STRING) log(`[${PEER_LABEL}] possess: ${r.actor.slice(0, 8)} drives ${px.for.slice(0, 8)} → ${act}`);
  }
  const effAction = new Map(revealsThisTurn.map(r => [r.actor, r.action]));
  // Battle Trance actors carry two options; prohibitions edit the options, a
  // Bluff negates the whole trance.
  const tranceOpts = new Map(revealsThisTurn.filter(r => r.action === 'BT' && r.trance).map(r => [r.actor, [...r.trance]]));
  for (const r of revealsThisTurn) if (r.action === 'BT' && !r.trance) effAction.set(r.actor, 'EP');
  const codeIs = (id, c) => tranceOpts.has(id) ? tranceOpts.get(id).includes(c) : effAction.get(id) === c;
  const replace = (id, from, to) => {
    const o = tranceOpts.get(id);
    if (o) { for (let i = 0; i < o.length; i++) if (o[i] === from) o[i] = to; }
    else if (effAction.get(id) === from) effAction.set(id, to);
  };
  const noMove = new Set();
  const ridesFor = (r) => {
    const codes = r.trance || [r.action];
    return c => codes.includes(c) || ((c === 'M' || c === 'P') && (codes.includes('EP') || codes.includes('EM')));
  };
  // Effect engine context (effects.mjs). Stats are read off the resolver's
  // view: base stat + Rule 12 stat tokens on the entity + bonus tile tokens on
  // the tile it stands on − what Counter Spell took off that caster for one
  // element type (`counterPen`: target → { elem_id: amount }).
  const counterPen = new Map();
  const statRaw = (v, sk) => Math.max(0, v?.[`stat_${sk}`] ?? 0);
  const parseJson = (s, dflt) => { try { const v = JSON.parse(s || ''); return Array.isArray(v) ? v : dflt; } catch { return dflt; } };
  const statTokensOfRaw = (id) => parseJson(view.get(id)?.stat_tokens_json, []);
  const statTokensOf = (id) => statTokensOfRaw(id);
  const allTileTokens = [...view.values()].flatMap(v => parseJson(v?.tile_tokens_json, []).map(t => ({ ...t, owner: v.peer_id })));
  const allTraps = [...view.values()].flatMap(v => parseJson(v?.traps_json, []).map(t => ({ ...t, owner: v.peer_id }))).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  // World-generated features (map.js featureAt — the same on every peer) count as bonus tile tokens owned by
  // 'world'. What players did to them travels in every peer's world_edits_json: `{id, gone}` (pulled /
  // destroyed) or `{id, q, r}` (relocated by Metaphysics / Disruption / Mind Blast).
  const worldTokensAt = worldLens(view).tokensAt;
  const tileTokensAt = (q, r) => [...allTileTokens.filter(t => t.q === q && t.r === r), ...worldTokensAt(q, r)];
  const elemPenOf = (id, el) => parseJson(view.get(id)?.elem_pen_json, []).filter(t => t.elem === el).reduce((a, t) => a + t.amount, 0);
  // Counter effects (Shield, Disable, The Void, zones) apply within the very
  // resolution they are cast in, and then last until the turn ends.
  const csvSet = (x) => new Set(String(x || '').split(',').filter(Boolean));
  const roundShield = new Map();      // id → Set(elem) cast this action
  const roundDisabled = new Map();    // id → Set(elem) cast this action
  const roundGlobalDisabled = new Set(); // ∀ Disable cast this action: nobody emits these
  // Spirit Link: the linked ally's CURRENT base stat rides on mine while I hold the permanent.
  const linkedStat = (id, sk) => parseJson(view.get(id)?.links_json, []).filter(l => l.stat === sk && hasPerm(id, 'effect_spirit_link')).reduce((a, l) => a + statRaw(view.get(l.from), sk), 0);
  const statOf = (id, sk) => {
    const v = view.get(id);
    if (!v) return 0;
    let s = statRaw(v, sk) + linkedStat(id, sk);
    for (const t of statTokensOf(id)) if (t.stat === sk) s += t.value;
    for (const t of tileTokensAt(v.tile_q, v.tile_r)) if (t.kind === 'bonus' && ELEM_TO_STAT[t.elem] === sk) s += t.value;
    return Math.max(0, s);
  };
  // Earth obstacles (Creation): every peer's `obstacles_json`; impassable for the creator's enemies.
  const allObstacles = [...view.values()].flatMap(v => parseJson(v?.obstacles_json, []).map(o => ({ ...o, owner: v.peer_id }))).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const obstacleAt = (q, r) => allObstacles.find(o => o.q === q && o.r === r) || null;
  const obstacleBlocks = (who, q, r) => { const o = obstacleAt(q, r); return !!o && o.owner !== who && enemyOf(o.owner, who); };
  const casterStat = (id, el) => Math.max(0, statOf(id, ELEM_TO_STAT[el]) - (counterPen.get(id)?.[el] || 0) - elemPenOf(id, el));
  const castComplete = (o) => !!o.effect && Array.isArray(o.effect.elements) && o.effect.elements.length > 0 && (o.effect.is_instant || (o.effect.step ?? 1) >= (o.effect.of ?? 1));
  const castsDamage = (o) => castComplete(o) && !!EFFECT_RULES[o.effect.effect_id]?.damage;
  // Aura ∀ widens a cast to everyone within 10 hexes — only while the caster really holds a doubled Aura.
  const auraEveryOf = (id) => hasPerm(id, 'effect_aura') && csvSet(view.get(id)?.every_csv).has('effect_aura');
  const castBoost = new Map();          // Elementalist: extra die riding on the actor's cast this action (set in the class pre-pass)
  const castOf = (o) => ({ actor: o.actor, effect_id: o.effect.effect_id, elements: o.effect.elements, salt: o.salt || '', target: o.target, is_instant: !!o.effect.is_instant, every: !!o.effect.every, aura: !!o.effect.aura && auraEveryOf(o.actor), step: o.effect.step ?? 1, of: o.effect.of ?? 1, kept: Array.isArray(o.effect.kept) ? o.effect.kept : null, summon: o.effect.summon || null, attach: o.effect.attach || null, card_id: o.effect.card_id || null, link: o.effect.link || null, elem: o.effect.elem || null, boost: castBoost.get(o.actor) || 0 });
  const buysPerEmission = (o) => EFFECT_RULES[o.effect?.effect_id]?.damage === 'pointbuy' || !!EFFECT_RULES[o.effect?.effect_id]?.statBuy;
  const effCtx = {
    me: PEER_ID_STRING,
    elemStat: (el) => ELEM_TO_STAT[el],
    statFor: (id, el) => casterStat(id, el),
    baseStat: (id, sk) => statOf(id, sk),
    lifeOf, enemyOf,
    dist: distBetween,
    tileOf: (id) => { const v = view.get(id); return v && Number.isInteger(v.tile_q) ? { q: v.tile_q, r: v.tile_r } : null; },
    isFree: (q, r) => dimMap.has(q, r) && !obstacleAt(q, r) && ![...view.values()].some(v => v && v.life > 0 && v.tile_q === q && v.tile_r === r),
    // Known free tiles within d hexes of (q,r), sorted — the same list on every peer.
    freeTilesWithin: (q, r, d) => {
      const seen = new Set([`${q},${r}`]); let ring = [{ q, r }]; const out = [];
      for (let k = 0; k < d; k++) {
        const next = [];
        for (const t of ring) for (const n of hexNeighbours(t.q, t.r)) { const key = `${n.q},${n.r}`; if (seen.has(key)) continue; seen.add(key); next.push(n); if (effCtx.isFree(n.q, n.r)) out.push(n); }
        ring = next;
      }
      return out.sort((a, b) => a.q - b.q || a.r - b.r);
    },
    neighbours: hexNeighbours,
    tileTokensAt,
    trapsAt: (q, r) => allTraps.filter(t => t.q === q && t.r === r),
    obstacleAt,
    hasPerm,
    shieldedAgainst: (id, el) => !!roundShield.get(id)?.has(el) || csvSet(view.get(id)?.shield_elems_csv).has(el),
    // Elements barred by a Disable that fired this turn (published by the holder who spent it).
    disabledElems: (id) => {
      const out = new Set([...(roundDisabled.get(id) || []), ...roundGlobalDisabled]);
      for (const v of view.values()) {
        if (!v?.peer_id) continue;
        for (const d of parseJson(v.disables_json, [])) if (d.on === id || d.on === '*') out.add(d.elem);
      }
      return out;
    },
    invisible: (id) => hasPerm(id, 'effect_invisibility'),
    peers: () => [...view.keys()].filter(id => Number.isInteger(view.get(id)?.tile_q)).sort(),
    sha: sha256Hex,
    actionIndex: hg.action,
    // Shield picks the element that would hurt its caster most this round; Disable
    // the element its target is emitting right now.
    threatElem: (me) => {
      let best = null, bestDelta = 0;
      for (const o of revealsThisTurn) {
        if (o.actor === me || !castsDamage(o) || !enemyOf(o.actor, me) || distBetween(o.actor, me) > 2) continue;
        for (const el of new Set(o.effect.elements)) {
          const d = Math.max(0, casterStat(o.actor, el) - statOf(me, ELEM_TO_STAT[el]));
          if (d > bestDelta || (d === bestDelta && best && el < best)) { best = el; bestDelta = d; }
        }
      }
      if (best) return best;
      const v = view.get(me);
      const weakest = ['vitality', 'world', 'matter', 'will'].sort((a, b) => statRaw(v, a) - statRaw(v, b))[0];
      return Object.keys(ELEM_TO_STAT).find(el => ELEM_TO_STAT[el] === weakest) || 'elem_fire';
    },
    castElemOf: (id) => byActorPre.get(id)?.effect?.elements?.[0] || null,
    // The Dimension Library as the resolver may draw from it (Space Bending alt, Alchemist): every
    // dealt effect with its cost, sorted — identical on every peer.
    library: () => LIBRARY_EFFECTS,
  };
  // What a complete cast would do to one defender this round, before shields: Σ of its rounded legs.
  const effectDmgNoShield = (o, defId) => {
    if (!castComplete(o)) return 0;
    const hit = resolveEffect(effCtx, castOf(o)).hits.find(h => h.victim === defId);
    return hit ? hit.legs.reduce((s, l) => s + roundHalfUp10(l.sum), 0) : 0;
  };

  // Counter Spell pre-pass (Rule 8: no stack, but a counter is a prohibition
  // and prohibitions apply "finally as a replacement" — so it runs before any
  // other skill resolves). Target (Rule 15 pc override: Posture has no target,
  // so the adjacent enemy that benefits me most): the right-clicked enemy if
  // they are adjacent and casting, else the adjacent caster whose effect I
  // blunt the most, lowest life breaking ties; with nobody casting, the
  // right-clicked enemy. The target loses every non-permanent skill they
  // played this action (a countered Battle Trance collapses to its first card).
  // Then I emit one element against their cast: of the element types in it,
  // the one that saves me the most; my stat for that element comes off their
  // stat for every instance of it in the cast (Lightning = fire+air, Matter 16
  // vs my 8, counter fire → (16−8−8) + (16−8) = 8 → 1). Caster-side only.
  // Two Counter Spells aimed at each other cancel in actor order — the
  // lexically first actor's counter lands first and strips the other's.
  for (const r of [...revealsThisTurn].sort((a, b) => a.actor.localeCompare(b.actor))) {
    if (!(r.skills || []).includes('skill_counter_spell')) continue;
    if (!ridesFor(r)('P')) continue;
    const casterV = view.get(r.actor);
    if (!casterV) continue;
    const declared = r.target?.kind === 'character' ? r.target.ref : null;
    const cands = revealsThisTurn.filter(o => o.actor !== r.actor && enemyOf(r.actor, o.actor) && distBetween(r.actor, o.actor) <= 1);
    if (!cands.length) continue;
    // Best element against one caster: how much of their damage to me it removes.
    const bestElem = (o) => {
      if (!castsDamage(o)) return null;
      const before = effectDmgNoShield(o, r.actor);
      const prev = counterPen.get(o.actor);
      let best = null;
      for (const el of [...new Set(o.effect.elements)].sort()) {
        const amount = statRaw(casterV, ELEM_TO_STAT[el]);
        if (!amount) continue;
        counterPen.set(o.actor, { ...(prev || {}), [el]: (prev?.[el] || 0) + amount });
        const saved = before - effectDmgNoShield(o, r.actor);
        if (!best || saved > best.saved) best = { el, amount, saved };
      }
      if (prev) counterPen.set(o.actor, prev); else counterPen.delete(o.actor);
      return best;
    };
    const casters = cands.filter(castsDamage);
    let o = cands.find(c => c.actor === declared && castsDamage(c)) || null;
    if (!o && casters.length) {
      o = casters.map(c => ({ c, b: bestElem(c) }))
        .sort((x, y) => (y.b?.saved ?? -1) - (x.b?.saved ?? -1) || lifeOf(x.c.actor) - lifeOf(y.c.actor) || x.c.actor.localeCompare(y.c.actor))[0].c;
    }
    if (!o) o = cands.find(c => c.actor === declared) || null;
    if (!o) continue;
    const tgt = o.actor;
    const kept = (o.skills || []).filter(id => !!data.skills[id]?.data?.is_permanent);
    const stripped = (o.skills || []).filter(id => !kept.includes(id));
    o.skills = kept;
    if (stripped.includes(TRANCE) && o.trance) { effAction.set(tgt, o.trance[0]); tranceOpts.delete(tgt); o.trance = null; }
    const b = bestElem(o);
    if (b) {
      const pen = counterPen.get(tgt) || {};
      pen[b.el] = (pen[b.el] || 0) + b.amount;
      counterPen.set(tgt, pen);
    }
    if (r.actor === PEER_ID_STRING || tgt === PEER_ID_STRING) log(`[${PEER_LABEL}] counter spell ${r.actor.slice(0, 8)} → ${tgt.slice(0, 8)}: stripped [${stripped.join(',')}]${b ? `, −${b.amount} on ${b.el} (saves ${b.saved})` : ', nothing to counter'}`);
  }
  for (const r of revealsThisTurn) {
    const sk = r.skills || [];
    if (!sk.length) continue;
    const tgt = r.target?.kind === 'character' ? r.target.ref : null;
    const tgtKnown = tgt && effAction.has(tgt);
    // Move / Posture skills also ride on Empty Move / Empty Posture.
    const rides = ridesFor(r);
    if (rides('M') && tgtKnown && has(r.actor, 'skill_bluff') && distBetween(r.actor, tgt) <= 1) { effAction.set(tgt, 'EP'); tranceOpts.delete(tgt); }
    if (rides('P') && has(r.actor, 'skill_intimidation')) {
      for (const o of revealsThisTurn) {
        if (o.actor !== r.actor && enemyOf(r.actor, o.actor) && distBetween(r.actor, o.actor) <= 1 && codeIs(o.actor, 'A')) replace(o.actor, 'A', 'EP');
      }
    }
    if (rides('A') && tgtKnown && has(r.actor, 'skill_grapple') && codeIs(tgt, 'P')) replace(tgt, 'P', 'EP');
    if (rides('M') && tgtKnown && has(r.actor, 'skill_disruption_move') && codeIs(tgt, 'P')) replace(tgt, 'P', 'EP');
    if (rides('A') && tgtKnown && has(r.actor, 'skill_overrun') && distBetween(r.actor, tgt) <= 1) noMove.add(tgt);
  }
  // Afflictions from sprung perm-traps hold while the holder keeps the permanent.
  const afflictedBy = (id, effectId) => parseJson(view.get(id)?.afflictions_json, []).filter(a => a.effect_id === effectId && a.by !== id && hasPerm(a.by, effectId)).map(a => a.by);
  // Confusion: the victim can only Empty Posture (a trance collapses to it too).
  for (const r of revealsThisTurn) {
    if (!afflictedBy(r.actor, 'effect_confusion').length) continue;
    tranceOpts.delete(r.actor); effAction.set(r.actor, 'EP'); r.target = null; noMove.add(r.actor);
    if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] confused — only an Empty Posture this action`);
  }
  // Sleep: no casting while in contact with the holder.
  const asleepFor = (id) => afflictedBy(id, 'effect_sleep').some(by => distBetween(id, by) <= 1);
  // Combat damage straight off the resolution matrix: Attack has a base of 1,
  // every other action 0, plus the edge for (actor, defender). Empty actions
  // are read as the action they lose to (data note on the EP/EM rows): an
  // Attack sees EP as Posture, a Posture sees EP and EM as Move, a Block sees
  // EM as Move. So A→P 2, A→B 0, P→M/EM/EP 1, M→B 1, B→A 1, everything else 0.
  const mapDef = (atk, def) => def === 'EP' ? ({ A: 'P', P: 'M', M: 'EP', B: 'EP' }[atk] || def) : def === 'EM' ? ({ A: 'EM', P: 'M', M: 'EM', B: 'M' }[atk] || def) : def;
  const edgeDmg = (atk, def) => Math.max(0, (atk === 'A' ? 1 : 0) + (edgeMap[atk]?.[mapDef(atk, def)] ?? 0));
  const hitDmg = (def) => edgeDmg('A', def);

  // Rule 9 / class static abilities: EP combat-type reassignment. Applied
  // after skills (so Intimidation first forces an attacker to EP, then the
  // class rule may lift that EP back to A/B/M as the stance). A Reaver's EP→A
  // needs a defender to strike: with no character target it takes the
  // adjacent enemy revealer by Rule 15 priority — the one that costs me the
  // least (not a blocker), then the one my hit lands on, then lowest life.
  const classOf = (id) => {
    const perms = permsOf(id);
    for (const p of perms) if (p.startsWith('class_') && CLASSES_IMPLEMENTED.has(p)) return p;
    return null;
  };
  // `r.declared` keeps what the player actually put down (after skill
  // prohibitions); `r.action` is the code combat is judged on. They only differ
  // for a class stance on EP — Sanctuary, the reveal chip and the hand
  // bookkeeping must see the EP, the damage pass the stance.
  for (const r of revealsThisTurn) {
    r.declared = effAction.get(r.actor);
    if (r.declared === 'BT' && !tranceOpts.get(r.actor)) r.declared = 'EP';
  }
  const codeNow = (id) => { const o = tranceOpts.get(id); return o ? o[0] : (effAction.get(id) || 'EP'); };
  for (const r of revealsThisTurn) {
    const cur = effAction.get(r.actor);
    const c = classOf(r.actor);
    if (c === 'class_reaver' && (cur === 'EP' || cur === 'EM')) {
      // Both empty actions fight as an Attack. An Empty Move with nobody adjacent
      // still walks its half journey (`moveAs`), it just defends as an Attack.
      effAction.set(r.actor, 'A');
      if (r.target?.kind !== 'character') {
        const pick = revealsThisTurn
          .filter(o => o.actor !== r.actor && enemyOf(r.actor, o.actor) && distBetween(r.actor, o.actor) <= 1)
          .map(o => ({ id: o.actor, cost: codeIs(o.actor, 'B') && !hasPerm(r.actor, 'skill_ranged_weapon') ? 1 : 0, lands: hitDmg(codeNow(o.actor)) > 0 ? 0 : 1, life: lifeOf(o.actor) }))
          .sort((a, b) => a.cost - b.cost || a.lands - b.lands || a.life - b.life || a.id.localeCompare(b.id))[0];
        if (pick) r.target = { kind: 'character', ref: pick.id };
        else if (cur === 'EM') r.moveAs = 'EM';
        if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] reaver ${cur} fights as Attack${pick ? ` → ${pick.id.slice(0, 8)}` : ' (nobody adjacent)'}`);
      }
    }
    else if (cur !== 'EP') continue;
    else if (c === 'class_barbarian') effAction.set(r.actor, 'B');
    else if (c === 'class_monk') effAction.set(r.actor, 'M');
  }
  for (const r of revealsThisTurn) {
    r.action = effAction.get(r.actor);
    r.trance = r.action === 'BT' ? tranceOpts.get(r.actor) || null : null;
    if (r.action === 'BT' && !r.trance) r.action = 'EP';
  }

  // Trance assignment: for each adjacent enemy pick the option that benefits
  // the trance actor most (dealt − taken). Each Attack option hits at most one
  // enemy; the declared target gets first choice. With nobody adjacent both
  // options are played.
  const byActor = new Map(revealsThisTurn.map(r => [r.actor, r]));
  const codeVs = (id, other) => {
    const r = byActor.get(id);
    if (!r) return 'EP';
    if (!r.trance) return r.action;
    const idx = r.vs?.get(other) ?? (r.played ? [...r.played][0] : 0);
    return r.trance[idx] ?? 'EP';
  };
  const attacksOn = (r, victim) => {
    if (!r) return false;
    const declared = r.target?.kind === 'character' && r.target.ref === victim;
    if (!r.trance) return r.action === 'A' && declared;
    const idx = r.vs?.get(victim);
    if (idx !== undefined) return r.trance[idx] === 'A';
    return !r.vs && declared && r.trance.includes('A');
  };
  for (const r of revealsThisTurn) {
    if (!r.trance) continue;
    const me = view.get(r.actor);
    if (!me) { r.vs = new Map(); r.played = new Set([0, 1]); continue; }
    const declared = r.target?.kind === 'character' ? r.target.ref : null;
    // Revealers only — their snapshots ride in the reveal, so every peer sees the same set.
    const adj = [...view.values()]
      .filter(p => p && p.peer_id !== r.actor && byActor.has(p.peer_id) && p.life > 0 && enemyOf(r.actor, p.peer_id) && distBetween(r.actor, p.peer_id) <= 1)
      .map(p => p.peer_id)
      .sort((a, b) => (a === declared ? -1 : b === declared ? 1 : a.localeCompare(b)));
    r.vs = new Map();
    r.played = new Set();
    const usedA = new Set();
    for (const e of adj) {
      const er = byActor.get(e);
      const eCode = er ? codeVs(e, r.actor) : 'EP';
      const eHits = attacksOn(er, r.actor);
      // The enemy's Attack / Move only hurt me if aimed at me; Posture / Block hit anyone adjacent.
      const eAims = eCode === 'A' ? eHits : eCode === 'M' ? er?.target?.kind === 'character' && er.target.ref === r.actor : true;
      let best = -1, bestScore = -Infinity;
      r.trance.forEach((opt, i) => {
        if (opt === 'A' && usedA.has(i)) return;
        const taken = eAims ? edgeDmg(eCode, opt) : 0;
        const dealt = opt === 'B' && !eHits ? 0 : edgeDmg(opt, eCode);
        const score = dealt - taken;
        if (score > bestScore) { bestScore = score; best = i; }
      });
      if (best < 0) continue;
      r.vs.set(e, best);
      r.played.add(best);
      if (r.trance[best] === 'A') usedA.add(best);
    }
    if (!adj.length) r.played = new Set([0, 1]);
  }

  // Movement intents. Rule 8:
  //  - EM ("Empty journey") moves halfway toward the target tile — round(d/2)
  //    steps along the shortest hex path, min 1 step if the target isn't the
  //    actor's own tile.
  //  - M steps one tile toward the target.
  //  - A with a tile target (swinging into empty space) also generates a
  //    one-tile step — no damage (handled below), it's a movement intent.
  //  Priority at a shared destination: A (3) > M (2) > EM (1). The strictly-
  //  highest-priority claimant wins the tile ("journey complete"); every
  //  lower-priority claimant AND every same-priority tied claimant is
  //  blocked ("journey cancelled (blocked)"). EM is declared first in the
  //  evaluation ordering only in the sense that it's the weakest tier.
  //  Occupied hexes are walked around, not into: a step takes the first free
  //  neighbour that closes distance (there are up to two). When every closer
  //  hex is held the mover aims straight anyway and is vetoed below with
  //  "tile occupied by …" — no sidestepping at equal distance, which only
  //  made movers ping-pong around a crowded melee. Without the detour a hero
  //  behind a teammate was blocked round after round.
  //  Deterministic: `view` is the same on every peer (it already drives the
  //  occupancy veto) and the neighbour order is fixed.
  const occupiedBefore = new Map();
  for (const p of view.values()) if (p && p.life > 0) occupiedBefore.set(`${p.tile_q},${p.tile_r}`, p.peer_id);
  const stepsAlong = (actorId, from, to, n) => {
    let cur = { q: from.q, r: from.r };
    for (let i = 0; i < n; i++) {
      const dNow = hexDistance({ tile_q: cur.q, tile_r: cur.r }, { tile_q: to.q, tile_r: to.r });
      if (dNow === 0) break;
      const opts = hexNeighbours(cur.q, cur.r).map(n => ({ ...n, d: hexDistance({ tile_q: n.q, tile_r: n.r }, { tile_q: to.q, tile_r: to.r }) }));
      const free = n => { const o = occupiedBefore.get(`${n.q},${n.r}`); return (!o || o === actorId) && !obstacleBlocks(actorId, n.q, n.r); };
      const straight = opts.slice().sort((a, b) => a.d - b.d)[0];
      const next = opts.find(n => n.d < dNow && free(n)) || straight;
      cur = { q: next.q, r: next.r };
    }
    return cur;
  };
  const priorityOf = (act) => act === 'A' ? 3 : act === 'M' ? 2 : act === 'EM' ? 1 : 0;
  const vetoed = new Map();          // actor -> reason string
  const moveIntents = [];
  const movesWith = (code, r) => code === 'M' || code === 'EM' || (code === 'A' && r.target?.kind === 'tile');
  // The option a trance actor moves with: the first played M / EM / tile-Attack.
  const moveCodeOf = (r) => r.moveAs || (r.trance
    ? ([...r.played].sort().map(i => r.trance[i]).find(c => movesWith(c, r)) || null)
    : (movesWith(r.action, r) ? r.action : null));
  for (const r of revealsThisTurn) {
    const mv = moveCodeOf(r);
    if (!mv) continue;
    if (noMove.has(r.actor)) { vetoed.set(r.actor, 'move negated by Overrun'); continue; }
    const actor = view.get(r.actor);
    if (!actor) continue;
    const tgtT = tileOf(r.target);
    if (!tgtT) continue;
    const here = { q: actor.tile_q, r: actor.tile_r };
    const d = hexDistance({ tile_q: here.q, tile_r: here.r }, { tile_q: tgtT.q, tile_r: tgtT.r });
    const steps = mv === 'EM' ? Math.min(EM_MAX_STEPS, Math.max(1, Math.round(d / 2))) : 1;
    const dest = stepsAlong(r.actor, here, tgtT, steps);
    moveIntents.push({ actor: r.actor, action: mv, dest, prio: priorityOf(mv), target: tgtT });
  }
  // Deterministic iteration across peers — the gossip layer delivers reveals
  // in whatever order the mesh happened to carry them, so peer A's
  // revealsThisTurn can be [X,Y,Z] while peer B's is [Y,X,Z]. Without an
  // explicit sort, byDest's insertion order (and thus any ordering-dependent
  // bookkeeping) could diverge, and so could the state_hash.
  moveIntents.sort((a, b) => a.actor.localeCompare(b.actor));
  // Collision veto with Rule 8 priority. A Mover may not step onto a hex
  // another living entity currently occupies (no chaining — "Move toward an
  // enemy engages them, it does not walk onto their hex"). At a contested
  // tile, strictly-highest priority wins; everyone else loses with a journey-
  // cancelled outcome.
  const occupiedNow = new Map();
  for (const p of view.values()) {
    if (!p || p.life <= 0) continue;
    occupiedNow.set(`${p.tile_q},${p.tile_r}`, p.peer_id);
  }
  const nextTiles = new Map();
  const journeyResults = new Map();  // actor -> { outcome: 'complete'|'blocked', q, r, action }
  const byDest = new Map();
  for (const it of moveIntents) {
    const key = `${it.dest.q},${it.dest.r}`;
    if (!byDest.has(key)) byDest.set(key, []);
    byDest.get(key).push(it);
  }
  // Creation: an enemy that moves (or aims an Attack / Empty Move) into an Earth obstacle is held
  // there and wears it down by round(Matter/10) — Matter under 5 scratches nothing.
  const obstacleHits = [];              // { owner, id, by, amount }
  for (const [key, list] of byDest) {
    const [oq, or] = key.split(',').map(Number);
    const ob = obstacleAt(oq, or);
    if (!ob) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (!obstacleBlocks(it.actor, oq, or)) continue;
      list.splice(i, 1);
      const amount = roundHalfUp10(statOf(it.actor, 'matter'));
      if (amount > 0) obstacleHits.push({ owner: ob.owner, id: ob.id, by: it.actor, amount });
      vetoed.set(it.actor, `held by an Earth obstacle (${amount} off it)`);
      journeyResults.set(it.actor, { outcome: 'blocked', q: oq, r: or, action: it.action });
      if (it.actor === PEER_ID_STRING || ob.owner === PEER_ID_STRING) log(`[${PEER_LABEL}] ${it.actor.slice(0, 8)} hits ${ob.owner.slice(0, 8)}'s obstacle at (${oq},${or}): −${amount} (hp ${ob.hp})`);
    }
    if (!list.length) byDest.delete(key);
  }
  for (const [key, list] of byDest) {
    const occupant = occupiedNow.get(key);
    const outsideOccupant = occupant && !list.some(x => x.actor === occupant);
    if (outsideOccupant) {
      for (const it of list) {
        vetoed.set(it.actor, `tile occupied by ${occupant}`);
        journeyResults.set(it.actor, { outcome: 'blocked', q: it.dest.q, r: it.dest.r, action: it.action });
      }
      continue;
    }
    const maxP = Math.max(...list.map(x => x.prio));
    const top = list.filter(x => x.prio === maxP);
    const losers = list.filter(x => x.prio !== maxP);
    if (top.length === 1) {
      const winner = top[0];
      nextTiles.set(winner.actor, winner.dest);
      journeyResults.set(winner.actor, { outcome: 'complete', q: winner.dest.q, r: winner.dest.r, action: winner.action });
      for (const l of losers) {
        vetoed.set(l.actor, `tile claimed by ${winner.actor}`);
        journeyResults.set(l.actor, { outcome: 'blocked', q: l.dest.q, r: l.dest.r, action: l.action });
      }
    } else {
      // Same-tier tie — Rule 8 says both (all) lose.
      for (const it of list) {
        vetoed.set(it.actor, `tile contested by equal-priority movers`);
        journeyResults.set(it.actor, { outcome: 'blocked', q: it.dest.q, r: it.dest.r, action: it.action });
      }
    }
  }

  // Effect outcomes first (Rule 8 order: effects are declared before skills
  // and their prohibitions shape the rest). Only complete casts resolve — a
  // cast still emitting elements does nothing yet. Relocations land in
  // nextTiles so combat adjacency sees them; damage is applied after the
  // combat pass below with Force Shield / shield tokens / rounding.
  const effectOutcomes = [];            // { actor, eff, oc }
  const pulledTokens = [];              // Force Pull: { by, token_id, owner, elem, value, item, q, r }
  const relocations = [];               // map surgery: { kind: 'token'|'trap'|'obstacle', owner, id, q, r } — applied by the owner
  const disableTriggers = [];           // { holder, caster, elem, global } — Disable permanents spent this action
  const disableUsed = new Set();
  const voidFor = new Set();            // take no damage this action (The Void)
  const roundZones = [];                // no-damage hexes created this action, {q, r}
  const inZone = (q, r) => activeZones.some(z => z.q === q && z.r === r) || roundZones.some(z => z.q === q && z.r === r);
  const isCounter = (r) => { const k = EFFECT_RULES[r.effect?.effect_id] || {}; return !!(k.shieldElem || k.disableElem || k.voidThisAction || k.zone); };
  // ---- class abilities, part 1 (user ruling 2026-10-30): what must be known before casts and damage ----
  // `r.classAbility = { id, target, attach, stat }` is the clicked class card; statics need no click.
  const classAbilityOut = { used: [], heals: [], discards: [], peeks: [], traps: [], tokens: [], armor: [], revives: [], moves: [], stealth: [] };
  const abilityOf = (r) => (r.classAbility && typeof r.classAbility.id === 'string' && classReady(r.actor, r.classAbility.id) && lifeOf(r.actor) > 0) ? r.classAbility : null;
  const abilityTile = (ab) => ab?.target?.kind === 'tile' ? ab.target.ref : null;
  const abilityPeer = (ab) => ab?.target?.kind === 'character' ? ab.target.ref : null;
  const adjacentOf = (id, pred) => [...view.keys()].filter(o => o !== id && lifeOf(o) > 0 && distBetween(id, o) <= 1 && pred(o)).sort();
  const useAbility = (r, note) => { classAbilityOut.used.push({ actor: r.actor, class_id: r.classAbility.id }); if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] class ${r.classAbility.id}: ${note}`); };
  const illusionFor = new Set();        // Illusionist: units whose first point of damage is ignored this action
  const rogueMove = new Set();          // Rogue: movers that trigger no trap / reveal nothing this action
  for (const r of revealsThisTurn) {
    const ab = abilityOf(r);
    if (ab?.id === 'class_elementalist' && r.effect?.elements?.length) {
      const el = r.effect.elements[Math.min(Math.max(1, r.effect.step ?? 1), r.effect.elements.length) - 1];
      const pb = pointBuy(statOf(r.actor, ELEM_TO_STAT[el] || 'matter'), `${r.salt || ''}:elementalist:${hg.action}`, sha256Hex);
      if (!pb.fail) { castBoost.set(r.actor, pb.value); useAbility(r, `a ${pb.value} rides on the ${el} emission as extra point-buy damage`); }
      else if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] class elementalist: the extra die failed [${pb.dice.join(',')}] — nothing added, the ability stays ready`);
    }
    if (ab?.id === 'class_illusionist') { illusionFor.add(r.actor); for (const o of adjacentOf(r.actor, o => !enemyOf(r.actor, o))) illusionFor.add(o); useAbility(r, `one point of damage to me and ${illusionFor.size - 1} neighbour(s) is ignored this action`); }
    if (ab?.id === 'class_rogue') { rogueMove.add(r.actor); classAbilityOut.stealth.push(r.actor); useAbility(r, 'my step triggers no trap and reveals nothing this action'); }
  }
  // Bard (static): every player in contact with a Bard who plays a skill plays it too, when their action allows.
  for (const r of revealsThisTurn) {
    if (!hasPerm(r.actor, 'class_bard') || !(r.skills || []).length) continue;
    for (const o of adjacentOf(r.actor, o => !enemyOf(r.actor, o) && !!byActorPre.get(o))) {
      const rev = byActorPre.get(o);
      for (const sk of r.skills) {
        const req = data.skills[sk]?.data?.action_type; if (!req || sk === TRANCE || rev.skills.includes(sk)) continue;
        const codes = rev.trance || [rev.action];
        if (codes.includes(req) || ((req === 'M' || req === 'P') && (codes.includes('EP') || codes.includes('EM')))) { rev.skills = [...rev.skills, sk]; if (o === PEER_ID_STRING || r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] bard ${r.actor.slice(0, 8)}: ${o.slice(0, 8)} plays ${sk} too`); }
      }
    }
  }
  const casts = revealsThisTurn.filter(r => r.effect && Array.isArray(r.effect.elements) && r.effect.elements.length && view.get(r.actor));
  // Blessing / Curse ∀ (user ruling 2026-10-30): a holder of TWO Blessings loses the second one the moment
  // an enemy effect is about to touch them — damage, a lock, a penalty token, a forced move, an
  // affliction, a possession — and that part of the effect is negated. One negation per holder per action.
  const blessFired = [];                // { holder, caster, effect_id } — the ∀ copy is spent (holder applies after the run)
  const blessUsed = new Set();
  const blessedEvery = (id) => hasPerm(id, 'effect_blessing_curse') && csvSet(view.get(id)?.every_csv).has('effect_blessing_curse') && !blessUsed.has(id);
  const blessNegate = (oc, caster, effectId) => {
    const hurt = new Set([...oc.hits.map(h => h.victim), ...oc.locks.map(l => l.on), ...oc.statTokens.filter(t => t.value < 0).map(t => t.on), ...oc.moves.filter(m => m.who !== caster).map(m => m.who), ...(oc.possess?.bind ? [oc.possess.bind] : []), ...(oc.peeks || []).filter(p => p.kind === 'hand').map(p => p.of)]);
    for (const v of [...hurt].sort()) {
      if (v === caster || !enemyOf(caster, v) || !blessedEvery(v)) continue;
      blessUsed.add(v); blessFired.push({ holder: v, caster, effect_id: effectId });
      oc.hits = oc.hits.filter(h => h.victim !== v); oc.locks = oc.locks.filter(l => l.on !== v);
      oc.statTokens = oc.statTokens.filter(t => !(t.on === v && t.value < 0)); oc.moves = oc.moves.filter(m => m.who !== v);
      if (oc.possess?.bind === v) oc.possess = null;
      oc.peeks = (oc.peeks || []).filter(p => !(p.kind === 'hand' && p.of === v));
      oc.notes.push(`${v.slice(0, 8)}'s Blessing ∀ negates it`);
      if (v === PEER_ID_STRING || caster === PEER_ID_STRING) log(`[${PEER_LABEL}] Blessing ∀ of ${v.slice(0, 8)} negates ${caster.slice(0, 8)}'s ${effectId} — the second Blessing is spent`);
    }
  };
  // Counter-type instants first (Rule 8: prohibitions apply as a replacement), so
  // the casts they shield against / disable see them in the same action.
  for (const r of [...casts.filter(isCounter), ...casts.filter(r => !isCounter(r))]) {
    const eff = r.effect;
    if (asleepFor(r.actor)) {
      effectOutcomes.push({ actor: r.actor, eff, oc: { status: 'blocked', hits: [], tokens: [], statTokens: [], locks: [], zones: [], heals: [], permanents: [], moves: [], shieldElem: null, disableElem: null, voidFor: [], draw: 0, every: false, kept: null, summon: null, channels: [], traps: [], notes: ['asleep in contact with the trap holder'] } });
      if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] cast ${eff.effect_id} blocked: asleep in contact`);
      continue;
    }
    if (!castComplete(r)) {
      // A point-buy cast buys the element it emits right now: bank the die or re-emit it.
      if (buysPerEmission(r)) {
        const oc = resolveEffect(effCtx, castOf(r));
        effectOutcomes.push({ actor: r.actor, eff, oc });
        if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] casting ${eff.effect_id}: element ${eff.step}/${eff.of} out${oc.status === 'retry' ? ` — ${oc.notes.join('; ')}` : ` (${EFFECT_RULES[eff.effect_id]?.statBuy ? 'bank' : 'dice'} ${(oc.kept || []).map(v => v ?? '·').join(',')})`}`);
      } else if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] casting ${eff.effect_id}: element ${eff.step}/${eff.of} out`);
      continue;
    }
    const oc = resolveEffect(effCtx, castOf(r));
    effectOutcomes.push({ actor: r.actor, eff, oc });
    // Disable (a permanent on the would-be victim) fires by itself: the enemy's
    // cast is discarded and its last element is barred to that enemy for the
    // turn (∀: to everyone). One Disable stops one cast.
    if (oc.status === 'done') {
      const hurt = new Set([...oc.hits.map(h => h.victim), ...oc.locks.map(l => l.on), ...oc.statTokens.filter(t => t.value < 0).map(t => t.on), ...oc.moves.filter(m => m.who !== r.actor).map(m => m.who)]);
      const holder = [...hurt].filter(v => v !== r.actor && enemyOf(r.actor, v) && hasPerm(v, 'effect_disable') && !disableUsed.has(v)).sort()[0];
      if (holder) {
        disableUsed.add(holder);
        const elem = eff.elements[eff.elements.length - 1];
        const global = csvSet(view.get(holder)?.every_csv).has('effect_disable');
        disableTriggers.push({ holder, caster: r.actor, elem, global });
        if (global) roundGlobalDisabled.add(elem); else { if (!roundDisabled.has(r.actor)) roundDisabled.set(r.actor, new Set()); roundDisabled.get(r.actor).add(elem); }
        Object.assign(oc, { status: 'blocked', hits: [], tokens: [], statTokens: [], locks: [], zones: [], heals: [], permanents: [], moves: [], shieldElem: null, disableElem: null, voidFor: [] });
        oc.notes.push(`${holder.slice(0, 8)}'s Disable bars ${elem}`);
        if (holder === PEER_ID_STRING || r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] Disable of ${holder.slice(0, 8)} stops ${r.actor.slice(0, 8)}'s ${eff.effect_id}: ${elem} barred ${global ? 'for everyone' : 'to them'} this turn`);
      }
    }
    if (oc.status !== 'done') { if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] cast ${eff.effect_id} ${oc.status}: ${oc.notes.join('; ')}`); continue; }
    blessNegate(oc, r.actor, eff.effect_id);
    for (const id of oc.voidFor) voidFor.add(id);
    roundZones.push(...oc.zones);
    // Force Pull: the token leaves its owner's tile (the puller re-creates it on theirs when applying).
    for (const p of oc.pulls || []) pulledTokens.push(p);
    if (oc.shieldElem) { if (!roundShield.has(oc.shieldElem.on)) roundShield.set(oc.shieldElem.on, new Set()); roundShield.get(oc.shieldElem.on).add(oc.shieldElem.elem); }
    if (oc.disableElem?.on === '*') roundGlobalDisabled.add(oc.disableElem.elem);
    else if (oc.disableElem) { if (!roundDisabled.has(oc.disableElem.on)) roundDisabled.set(oc.disableElem.on, new Set()); roundDisabled.get(oc.disableElem.on).add(oc.disableElem.elem); }
    for (const mv of oc.moves) {
      const key = `${mv.q},${mv.r}`;
      // A switch (Mind Blast) trades two tiles — its second mover lands where the first stood.
      if (mv.reason !== 'switched' && [...nextTiles.values()].some(t => `${t.q},${t.r}` === key)) continue;
      nextTiles.set(mv.who, { q: mv.q, r: mv.r });
      journeyResults.set(mv.who, { outcome: 'complete', q: mv.q, r: mv.r, action: mv.reason });
    }
    for (const rl of oc.relocations || []) relocations.push(rl);
  }

  // Channel-token ticks (Harm, Combustion, The Void, Light/Darkness). general_ux_channeling:
  // the cast registers a channel permanent in `entity.channels`; every subsequent action every
  // peer re-fires the channel's non-permanent, non-emission leg via resolveEffect({..._channel_tick}).
  // The channel ends the moment the caster breaks concentration — plays A, B, M or EM, or emits
  // an element other than the channel's cost element. Zones/voidFor from a tick must land
  // before the damage pass below.
  const parseChannels = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const CHANNEL_BREAK = new Set(['A', 'B', 'M', 'EM']);
  const channelsBroken = [];            // { owner, effect_id } — concentration lost this action (applied by the owner after the run)
  const channelBreaksFor = (ownerId, costElem) => {
    const rev = byActorPre.get(ownerId);
    if (!rev) return false;
    // What the player put down (a class stance turning EP into B/A/M is not the player moving).
    const act = rev.trance ? rev.trance.find(c => CHANNEL_BREAK.has(c)) || rev.trance[0] : (rev.declared ?? rev.action);
    if (CHANNEL_BREAK.has(act)) return true;
    if (rev.effect && Array.isArray(rev.effect.elements) && rev.effect.elements.length) {
      const step = Math.max(1, rev.effect.step ?? 1);
      const emitted = rev.effect.elements[Math.min(step, rev.effect.elements.length) - 1];
      if (emitted && costElem && emitted !== costElem) return true;
    }
    return false;
  };
  for (const id of [...view.keys()].sort()) {
    const v = view.get(id);
    if (!v || !Number.isInteger(v.tile_q) || lifeOf(id) <= 0) continue;
    for (const ch of parseChannels(v.channels_json)) {
      // Cadence: the cast action itself does not tick (the cast's own leg already fired).
      const sameAction = (ch.startedTurn === hg.turn && ch.startedAction === hg.action);
      const cost = ch.elements?.[0] || null;
      // A blessed channel never breaks; it lives and dies with its Blessing.
      if (ch.stop === 'never') { if (!hasPerm(id, ch.holder || 'effect_blessing_curse')) continue; }
      else if (channelBreaksFor(id, cost)) { channelsBroken.push({ owner: id, effect_id: ch.effect_id }); continue; }
      if (sameAction) continue;
      const tickCast = {
        actor: id, effect_id: ch.effect_id, elements: ch.elements, salt: `${ch.salt || ''}:tick:${hg.turn}:${hg.round}`,
        target: ch.target ? { kind: 'character', ref: ch.target } : null,
        is_instant: true, every: false, aura: false,
        step: ch.elements.length, of: ch.elements.length, kept: null, summon: null,
        _channel_tick: true,
      };
      const oc = resolveEffect(effCtx, tickCast);
      if (oc.status !== 'done') continue;
      blessNegate(oc, id, ch.effect_id);
      effectOutcomes.push({ actor: id, eff: { effect_id: ch.effect_id, elements: ch.elements }, oc, channel: true });
      for (const vId of oc.voidFor) voidFor.add(vId);
      roundZones.push(...oc.zones);
      if (id === PEER_ID_STRING || ch.target === PEER_ID_STRING) log(`[${PEER_LABEL}] ${ch.effect_id} channel tick by ${id.slice(0, 8)}${oc.hits.length ? ` → ${oc.hits.map(h => h.victim.slice(0, 8)).join(',')}` : ''}`);
    }
  }

  // Rule 24 — emit against a token. The closest adjacent enemy's permanents
  // first, then the dice over their stats, then the tokens on their tile; only
  // tokens whose element belongs to the emitted stat can be matched. One
  // point-buy of that stat: highest die ≥ the token's power destroys it; a
  // failed roll may be retried next action. Class cards are out of reach.
  const destroyOutcomes = [];           // { actor, owner, kind: 'perm'|'stat'|'tile', id, power, die, result }
  const permPowerOf = (id) => { try { const v = JSON.parse(view.get(id)?.perm_power_json || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
  const permStats = (permId) => {
    if (permId.startsWith('skill_')) { const st = data.skills[permId]?.data?.point_buy_stat; return st === 'any' ? ['vitality', 'world', 'matter', 'will'] : st ? [st.replace(/^stat_/, '')] : ['vitality']; }
    if (permId.startsWith('effect_')) return [...new Set((data.effects[permId]?.data?.element_cost || []).map(el => ELEM_TO_STAT[el]).filter(Boolean))];
    return [];
  };
  // Class cards (user ruling 2026-10-30): `destroy: { stat, class: <peer>, elem }` aims the emission at an
  // adjacent enemy's class — its colour behind `stat` falls to a die of 6 (one colour per action, in any
  // order); once every colour is down the class leaves the board for its owner's archive. The owner
  // recasts it from the archive (`destroy: { stat, recast: true }`) and untaps a tapped ability
  // (`destroy: { stat, untap: true }`) by emitting each colour with ANY successful point-buy (power 1).
  const classOutcomes = [];             // { actor, owner, class_id, kind: 'colour'|'class_destroyed'|'recast'|'untap', stat, ok, die }
  for (const r of revealsThisTurn) {
    const stat = r.destroy?.stat;
    if (!stat || !['vitality', 'world', 'matter', 'will'].includes(stat) || !view.get(r.actor)) continue;
    const emitsNow = ['P', 'EP'].includes(r.declared) || (r.action === 'A' && classOf(r.actor) === 'class_reaver') || (r.action === 'M' && classOf(r.actor) === 'class_monk');
    if (!emitsNow) continue;
    const pb = pointBuy(statOf(r.actor, stat), `${r.salt || ''}:destroy:${hg.action}:${stat}`, sha256Hex);
    // --- my own class: recast from the archive / untap the ability (power 1 = any successful roll) ---
    if (r.destroy.recast || r.destroy.untap) {
      const cs = classStateOf(r.actor);
      const kind = r.destroy.recast ? 'recast' : 'untap';
      const cols = cs.class_id ? classColours(cs.class_id) : {};
      const valid = !!cs.class_id && stat in cols && (kind === 'recast' ? cs.archived : (cs.tapped && !cs.archived)) && !(cs.progress?.mode === kind && (cs.progress.done || []).includes(stat));
      if (!valid) { if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] class ${kind}: ${stat} is not a colour still owed`); continue; }
      const ok = !pb.fail;
      classOutcomes.push({ actor: r.actor, owner: r.actor, class_id: cs.class_id, kind, stat, ok, die: pb.value, dice: pb.dice });
      if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] class ${kind}: ${stat} emitted, dice [${pb.dice.join(',')}] → ${ok ? 'colour prepared' : 'failed roll, again next action'}`);
      continue;
    }
    const enemies = [...view.keys()].filter(id => id !== r.actor && lifeOf(id) > 0 && enemyOf(r.actor, id) && distBetween(r.actor, id) <= 1);
    // --- an enemy's class colour (die of 6) ---
    if (r.destroy.class) {
      const e = r.destroy.class;
      const cs = classStateOf(e);
      const cols = cs.class_id ? classColours(cs.class_id) : {};
      const okTarget = enemies.includes(e) && cs.class_id && !cs.archived && stat in cols && !cs.down.includes(stat) && (!r.destroy.elem || cols[stat].includes(r.destroy.elem));
      if (!okTarget) { if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] class strike: ${e.slice(0, 8)} has no standing ${stat} colour in reach`); continue; }
      const result = pb.fail ? 'retry' : pb.value >= 6 ? 'destroyed' : 'too weak';
      const last = result === 'destroyed' && Object.keys(cols).every(s => s === stat || cs.down.includes(s));
      classOutcomes.push({ actor: r.actor, owner: e, class_id: cs.class_id, kind: last ? 'class_destroyed' : 'colour', stat, ok: result === 'destroyed', die: pb.value, dice: pb.dice, result });
      if (r.actor === PEER_ID_STRING || e === PEER_ID_STRING) log(`[${PEER_LABEL}] ${r.actor.slice(0, 8)} emits ${stat} against ${e.slice(0, 8)}'s ${cs.class_id} colour: dice [${pb.dice.join(',')}] → ${result}${last ? ' — the class leaves the board' : ''}`);
      continue;
    }
    // --- Rule 24 tokens: a Possess permanent in an adjacent ALLY's holding comes first (its possessor is my enemy) ---
    const candidatesOf = (e) => {
      const out = [];
      const pw = permPowerOf(e);
      for (const pid of permsOfRaw(e)) if (!pid.startsWith('class_') && permStats(pid).includes(stat)) out.push({ owner: e, kind: 'perm', id: pid, power: pw[pid] || 1 });
      for (const t of statTokensOfRaw(e)) if (t.value > 0 && ELEM_TO_STAT[t.elem] === stat) out.push({ owner: e, kind: 'stat', id: t.id, power: t.value, tok: t });
      const ev = view.get(e);
      for (const t of tileTokensAt(ev.tile_q, ev.tile_r)) if (ELEM_TO_STAT[t.elem] === stat) out.push({ owner: t.owner, kind: 'tile', id: t.id, power: t.value, tok: t });
      return out;
    };
    const possessedAllies = [...view.keys()].filter(id => id !== r.actor && lifeOf(id) > 0 && distBetween(r.actor, id) <= 1 && possessorOf(id) && enemyOf(r.actor, possessorOf(id))
      && sideOf(view.get(id).alliance) === sideOf(view.get(r.actor).alliance) && permStats('effect_possess_phylactery').includes(stat)).sort();
    const pick = possessedAllies.length
      ? { e: possessedAllies[0], c: [{ owner: possessedAllies[0], kind: 'perm', id: 'effect_possess_phylactery', power: permPowerOf(possessedAllies[0]).effect_possess_phylactery || 6 }] }
      : enemies.map(e => ({ e, c: candidatesOf(e) })).filter(x => x.c.length).sort((a, b) => a.e.localeCompare(b.e))[0];
    if (!pick) { if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] emit ${stat} against a token: nothing of that colour on an adjacent enemy`); continue; }
    const tgt = pick.c[0];
    const result = pb.fail ? 'retry' : pb.value >= tgt.power ? 'destroyed' : 'too weak';
    destroyOutcomes.push({ actor: r.actor, ...tgt, die: pb.value, dice: pb.dice, result });
    if (r.actor === PEER_ID_STRING || tgt.owner === PEER_ID_STRING) log(`[${PEER_LABEL}] ${r.actor.slice(0, 8)} emits ${stat} against ${tgt.owner.slice(0, 8)}'s ${tgt.kind} ${tgt.id} (power ${tgt.power}): dice [${pb.dice.join(',')}] → ${result}`);
  }
  // Phylactery (user spec 2026-10-29): a Possess/Phylactery holder may, any action, shatter one enemy
  // permanent outright (no roll, class cards excepted) — the Possess permanent is spent for it at the
  // end of the action. Declared in the reveal as `phylactery: { peer_id, perm }`.
  for (const r of revealsThisTurn) {
    const ph = r.phylactery;
    // The holder is whoever's Possess stands somewhere: in a possessed unit's holding (normal) or their own.
    const possessed = [...view.keys()].filter(id => possessorOf(id) === r.actor).sort()[0] || null;
    if (!ph?.peer_id || !ph.perm || !view.get(r.actor) || !(possessed || hasPerm(r.actor, 'effect_possess_phylactery'))) continue;
    if (String(ph.perm).startsWith('class_') || lifeOf(ph.peer_id) <= 0 || !enemyOf(r.actor, ph.peer_id) || !permsOfRaw(ph.peer_id).includes(ph.perm)) {
      if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] phylactery: ${ph.peer_id.slice(0, 8)} holds no ${ph.perm} I may shatter`);
      continue;
    }
    const power = permPowerOf(ph.peer_id)[ph.perm] || 1;
    destroyOutcomes.push({ actor: r.actor, owner: ph.peer_id, kind: 'perm', id: ph.perm, power, die: power, dice: [], result: 'destroyed', phylactery: true });
    // The Possess permanent is spent for it, wherever it stands.
    if (possessed) destroyOutcomes.push({ actor: r.actor, owner: possessed, kind: 'perm', id: 'effect_possess_phylactery', power: 6, die: 6, dice: [], result: 'destroyed', phylactery: true });
    else channelsBroken.push({ owner: r.actor, effect_id: 'effect_possess_phylactery', why: 'phylactery spent' });
    if (r.actor === PEER_ID_STRING || ph.peer_id === PEER_ID_STRING) log(`[${PEER_LABEL}] ${r.actor.slice(0, 8)}'s phylactery shatters ${ph.peer_id.slice(0, 8)}'s ${ph.perm}`);
  }

  // Damage pass over the resolution matrix (`edgeDmg`). Attack and Move are
  // target actions: they strike only the character they aim at (a tile-target
  // Attack is a step, handled above, and deals nothing). Posture and Block
  // have no target and meet every adjacent enemy revealer — Block only ever
  // scores against an Attack, so it still hits exactly the attackers aiming
  // at the blocker. The per-victim value is a list of {attacker, amount} so
  // the UI can animate "-N❤" from dealer to victim.
  const damage = new Map();
  // Noble lifesteal: amount healed per attacker this round, applied to the
  // caster's own `entity.life` only (we are authoritative over us) after the
  // damage pass runs. Assassin: +1 damage once the attacker has already dealt
  // damage this round — we flip the flag on the first scoring hit.
  const lifestealForMe = { amount: 0 };
  const assassinScored = new Set();
  const senseFired = new Set();          // Super Sense holders who already evaded their one point this action
  const addDmg = (victim, attacker, amount, source = 'action') => {
    const list = damage.get(victim) || [];
    // Super Sense (user spec 2026-10-29): the holder evades one point of the first damage that lands;
    // the permanent is spent for it (dropped by the owner after the run).
    if (amount > 0 && hasPerm(victim, 'effect_super_sense') && !senseFired.has(victim)) {
      senseFired.add(victim); amount -= 1;
      channelsBroken.push({ owner: victim, effect_id: 'effect_super_sense', why: 'one point of damage evaded' });
      if (victim === PEER_ID_STRING || attacker === PEER_ID_STRING) log(`[${PEER_LABEL}] super sense: ${victim.slice(0, 8)} evades one point of ${attacker.slice(0, 8)}'s ${source} damage`);
    }
    // Illusionist (class, tapped this action): one point of damage to the holder and each neighbour is ignored.
    if (amount > 0 && illusionFor.has(victim)) { illusionFor.delete(victim); amount -= 1; if (victim === PEER_ID_STRING || attacker === PEER_ID_STRING) log(`[${PEER_LABEL}] illusion: ${victim.slice(0, 8)} ignores one point of ${attacker.slice(0, 8)}'s ${source} damage`); }
    list.push({ attacker, amount, source });
    damage.set(victim, list);
    if (amount > 0 && hasPerm(attacker, 'class_noble') && attacker === PEER_ID_STRING) lifestealForMe.amount += amount;
    if (amount > 0) assassinScored.add(attacker);
  };
  const postTile = (id) => nextTiles.get(id) ? { tile_q: nextTiles.get(id).q, tile_r: nextTiles.get(id).r } : view.get(id);
  // Defence (shield) tokens on the tile you stand on absorb one hit — any
  // kind — and are destroyed by it. Smallest die first, ids break ties.
  const tokensSpent = [];               // { owner, id } tokens destroyed / used up this round
  const spentIds = new Set();
  for (const p of pulledTokens) { spentIds.add(p.token_id); tokensSpent.push({ owner: p.owner, id: p.token_id, by: p.by }); }
  const absorbedByShieldToken = (defId) => {
    const t = postTile(defId);
    if (!t) return false;
    const tok = tileTokensAt(t.tile_q, t.tile_r).filter(x => x.kind === 'shield' && !spentIds.has(x.id)).sort((a, b) => a.value - b.value || a.id.localeCompare(b.id))[0];
    if (!tok) return false;
    spentIds.add(tok.id); tokensSpent.push({ owner: tok.owner, id: tok.id });
    return true;
  };
  const restingInSanctuary = (id) => hasPerm(id, 'skill_sanctuary') && (byActor.get(id)?.declared ?? 'EP') === 'EP';
  // Blanket protections shared by combat and effect damage: The Void, a
  // no-damage zone on either tile, an invisible defender.
  const untouchable = (victim, attacker) => {
    if (voidFor.has(victim)) return true;
    if (hasPerm(victim, 'effect_invisibility')) return true;
    const a = postTile(attacker), v = postTile(victim);
    return !!(a && v && (inZone(a.tile_q, a.tile_r) || inZone(v.tile_q, v.tile_r)));
  };
  // One strike of `code` by r.actor on defId; the defender's code is whatever
  // they play against this actor (a trance picks per enemy).
  const strike = (r, code, defId) => {
    const atk = view.get(r.actor), def = view.get(defId);
    if (!atk || !def || !enemyOf(r.actor, defId)) return;
    if (hexDistance(postTile(r.actor), postTile(defId)) > 1) return;
    const defCode = codeVs(defId, r.actor);
    if (code === 'B') {
      // Block scores against Attacks aimed at the blocker; a ranged attacker is out of reach.
      if (defCode !== 'A' || !attacksOn(byActor.get(defId), r.actor)) return;
      if (hasPerm(defId, 'skill_ranged_weapon')) return;
    }
    let dmg = bonusRound ? (code === 'A' ? 1 : 0) : edgeDmg(code, defCode);
    if (code === 'A') {
      if (dmg >= 1 && has(r.actor, 'skill_powerful_attack')) dmg += 1;
      // Assassin: +1 if the attacker has already connected this round. The flag
      // is set when a previous addDmg(..., attacker, >0) landed — so same-round
      // "first hit then rider" scales up for them. Resolver-local; no state leak.
      if (dmg >= 1 && hasPerm(r.actor, 'class_assassin') && assassinScored.has(r.actor)) dmg += 1;
      // Taunt: a nearby taunter is the only legal Attack target. Only revealers
      // count — their snapshots ride in the reveal, so every peer sees the same set.
      const taunter = revealsThisTurn.some(t => t.actor !== defId && t.actor !== r.actor
        && enemyOf(r.actor, t.actor) && hasPerm(t.actor, 'skill_taunt') && distBetween(r.actor, t.actor) <= 1);
      if (taunter) dmg = 0;
    }
    // Inner Fire: one point of non-effect damage becomes two.
    if (dmg === 1 && hasPerm(r.actor, 'effect_inner_fire')) dmg = 2;
    if ((code === 'A' || code === 'B') && hasPerm(defId, 'skill_barricade')) dmg = 0;
    if (restingInSanctuary(defId)) dmg = 0;
    if (untouchable(defId, r.actor)) dmg = 0;
    if (dmg > 0 && absorbedByShieldToken(defId)) dmg = 0;
    addDmg(defId, r.actor, dmg);
  };
  const targetOf = (r) => r.target?.kind === 'character' ? r.target.ref : null;
  const enemyRevealers = (r) => revealsThisTurn.filter(o => o.actor !== r.actor && enemyOf(r.actor, o.actor)).map(o => o.actor);
  const strikeWith = (r, code, victimOfTargeted) => {
    if (code === 'A' || code === 'M') { if (victimOfTargeted) strike(r, code, victimOfTargeted); }
    else if (code === 'P' || code === 'B') for (const e of enemyRevealers(r)) strike(r, code, e);
  };
  for (const r of revealsThisTurn) {
    if (r.trance) {
      for (const [e, idx] of [...r.vs].sort((x, y) => x[0].localeCompare(y[0]))) strike(r, r.trance[idx], e);
      continue;
    }
    strikeWith(r, r.action, targetOf(r));
  }
  // Dodge: "one less damage done to you this action" — one point off the
  // combat damage I take this round, not one per attacker.
  for (const [victim, list] of damage) {
    if (!has(victim, 'skill_dodge')) continue;
    const hit = list.find(d => d.source === 'action' && d.amount > 0);
    if (hit) hit.amount -= 1;
  }

  // Effect damage (Rule 21): each leg rounded half-up / 10 on its own. Before
  // rounding, Force Shield's die comes off the first leg that would otherwise
  // land and is spent by that. A shield token on the defender's tile (Rule 20
  // / Rule 21 "defender has tokens to destroy") absorbs one landing hit
  // instead — the defender loses their lowest token. Nothing here touches
  // state: tokens to drop, heals, locks, … ride out in `effectOutcomes`.
  let brokenShield = false;
  const permanentsToAdd = [];
  // Fire tokens left on tiles earlier: whoever steps onto one this action takes
  // its point-buy damage (Rule 20) and the token vanishes.
  for (const [who, t] of [...nextTiles.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const tok of tileTokensAt(t.q, t.r).filter(x => x.kind === 'fire' && !spentIds.has(x.id)).sort((a, b) => a.id.localeCompare(b.id))) {
      spentIds.add(tok.id); tokensSpent.push({ owner: tok.owner, id: tok.id });
      let d = untouchable(who, tok.owner) ? 0 : roundHalfUp10(tok.value);
      if (d > 0 && absorbedByShieldToken(who)) d = 0;
      if (d > 0) addDmg(who, tok.owner, d, 'effect');
      if (who === PEER_ID_STRING || tok.owner === PEER_ID_STRING) log(`[${PEER_LABEL}] ${who.slice(0, 8)} steps onto a fire token (${tok.value}) → ${d} dmg`);
    }
  }
  // Traps (Rule 2/4, user spec 2026-10-29). Every trap lies in its owner's snapshot
  // (`traps_json`); it fires once, on the first enemy that (a) steps onto its tile
  // ('enter': Sleep, Confusion, Space Bending's random trap) or (b) declares the owner
  // as target while the owner stands on it ('targeted': Poison, Traps Mastery). Damage
  // mode: Σ max(0, 20 − victim stat) per element, /10, same protections as a cast.
  // Perm mode: the owner gains the card as a permanent that afflicts the victim.
  const trapsSpent = [];                // { owner, id, victim, effect_id, mode, holder, card_id }
  const afflictionsOut = [];            // { on, effect_id, by }
  const springTrap = (tp, victim) => {
    if (spentIds.has(`trap:${tp.id}`)) return;
    spentIds.add(`trap:${tp.id}`); trapsSpent.push({ owner: tp.owner, id: tp.id, victim, effect_id: tp.effect_id, mode: tp.mode, trigger: tp.trigger, holder: tp.holder || null, card_id: tp.card_id || null });
    let d = 0;
    if (blessedEvery(victim)) {
      blessUsed.add(victim); blessFired.push({ holder: victim, caster: tp.owner, effect_id: tp.effect_id });
      if (victim === PEER_ID_STRING || tp.owner === PEER_ID_STRING) log(`[${PEER_LABEL}] Blessing ∀ of ${victim.slice(0, 8)} negates the ${tp.effect_id} trap — the second Blessing is spent`);
    } else if (tp.mode === 'damage') {
      const sum = trapDamageSum(tp.elements || [], el => statOf(victim, ELEM_TO_STAT[el]), el => effCtx.shieldedAgainst(victim, el));
      d = untouchable(victim, tp.owner) ? 0 : roundHalfUp10(sum);
      if (d > 0 && absorbedByShieldToken(victim)) d = 0;
      if (d > 0) addDmg(victim, tp.owner, d, 'effect');
    } else {
      afflictionsOut.push({ on: victim, effect_id: tp.effect_id, by: tp.owner });
      if (tp.owner === PEER_ID_STRING) permanentsToAdd.push(tp.effect_id);
    }
    if (victim === PEER_ID_STRING || tp.owner === PEER_ID_STRING) log(`[${PEER_LABEL}] trap ${tp.effect_id} of ${tp.owner.slice(0, 8)} springs on ${victim.slice(0, 8)}${tp.mode === 'damage' ? ` → ${d} dmg` : ' → afflicted'}`);
  };
  // ---- class abilities, part 2 (user ruling 2026-10-30): what lands as an outcome — heals, armor, discards,
  // peeks, traps lifted / moved / laid, tokens, revivals, a step — judged identically on every peer and
  // applied by whoever owns the piece of state. Deterministic: reveals are sorted by actor, picks by id.
  const trapGone = new Set();           // traps lifted / moved this action — they spring nowhere
  const occupantAt = (q, r) => [...view.keys()].filter(id => lifeOf(id) > 0 && (() => { const t = postTile(id); return !!t && t.tile_q === q && t.tile_r === r; })()).sort()[0] || null;
  const tileNear = (id, t) => { const v = view.get(id); return !!v && !!t && Number.isInteger(t.q) && Number.isInteger(t.r) && hexDistance({ tile_q: v.tile_q, tile_r: v.tile_r }, { tile_q: t.q, tile_r: t.r }) <= 1; };
  const trapsNear = (id, pred = () => true) => allTraps.filter(tp => !trapGone.has(tp.id) && tileNear(id, tp) && pred(tp));
  const elemsOfStat = (st) => Object.keys(ELEM_TO_STAT).filter(el => ELEM_TO_STAT[el] === st);
  const libraryCardFor = (salt) => { const lib = effCtx.library(); return lib.length ? lib[parseInt(sha256Hex(salt).slice(0, 8), 16) % lib.length] : null; };
  for (const r of revealsThisTurn) {
    const ab = abilityOf(r);
    if (!ab || ['class_elementalist', 'class_illusionist', 'class_rogue'].includes(ab.id)) continue;
    const me = r.actor, v = view.get(me);
    const tile = abilityTile(ab), peer = abilityPeer(ab);
    const nearAlly = peer && peer !== me && lifeOf(peer) > 0 && distBetween(me, peer) <= 1 && !enemyOf(me, peer) ? peer : null;
    const nearEnemy = peer && peer !== me && lifeOf(peer) > 0 && distBetween(me, peer) <= 1 && enemyOf(me, peer) ? peer : null;
    const stat = ['vitality', 'world', 'matter', 'will'].includes(ab.stat) ? ab.stat : 'vitality';
    const here = { q: v.tile_q, r: v.tile_r };
    const spot = tile && tileNear(me, tile) ? { q: tile.q, r: tile.r } : here;
    switch (ab.id) {
      case 'class_healer': { const who = nearAlly || me; classAbilityOut.heals.push({ on: who, amount: 1, by: me }); useAbility(r, `one life token restored to ${who === me ? 'me' : who.slice(0, 8)}`); break; }
      case 'class_overlord': { const who = nearAlly || me; classAbilityOut.armor.push({ on: who, by: me }); useAbility(r, `${who === me ? 'I wear' : `${who.slice(0, 8)} wears`} an armor life token`); break; }
      case 'class_druid': {
        const pb = pointBuy(statOf(me, stat), `${r.salt || ''}:druid:${hg.action}`, sha256Hex);
        if (pb.fail) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class druid: the point-buy failed [${pb.dice.join(',')}] — no token, the ability stays ready`); break; }
        classAbilityOut.tokens.push({ by: me, kind: 'shield', elem: elemsOfStat(stat)[0] || 'elem_vitality', value: pb.value, q: here.q, r: here.r });
        useAbility(r, `a defence token of ${pb.value} (${stat}) lies on my tile`); break;
      }
      case 'class_priest': { if (!nearEnemy) break; classAbilityOut.discards.push({ on: nearEnemy, by: me, n: 1, prefer: 'skill' }); useAbility(r, `${nearEnemy.slice(0, 8)} discards a card of my choosing (an instant first)`); break; }
      case 'class_witch': { if (!nearEnemy) break; classAbilityOut.discards.push({ on: nearEnemy, by: me, n: 3, stat }); useAbility(r, `${nearEnemy.slice(0, 8)} discards up to three ${stat} cards`); break; }
      case 'class_prophet': { if (!nearEnemy) break; classAbilityOut.peeks.push({ kind: 'deck', by: me, of: nearEnemy, n: 5 }); useAbility(r, `${nearEnemy.slice(0, 8)} shows me the top five cards of their deck`); break; }
      case 'class_manipulator': { if (!nearEnemy) break; afflictionsOut.push({ on: nearEnemy, effect_id: 'class_manipulator', by: me, until_action: hg.action + 1 }); useAbility(r, `${nearEnemy.slice(0, 8)} plays a random Action card next action`); break; }
      case 'class_animator': {
        const tp = trapsNear(me)[0];
        if (!tp) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class animator: no trap within reach`); break; }
        if (tp.q === spot.q && tp.r === spot.r) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class animator: the trap already lies there`); break; }
        trapGone.add(tp.id); relocations.push({ kind: 'trap', owner: tp.owner, id: tp.id, q: spot.q, r: spot.r, by: me, label: tp.effect_id });
        useAbility(r, `${tp.owner.slice(0, 8)}'s ${tp.effect_id} trap moves to (${spot.q},${spot.r})`); break;
      }
      case 'class_cleric': {
        const tp = trapsNear(me, tp => tp.owner !== me)[0];
        if (!tp) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class cleric: no trap within reach`); break; }
        trapGone.add(tp.id); spentIds.add(`trap:${tp.id}`);
        const to = occupantAt(tp.q, tp.r);
        trapsSpent.push({ owner: tp.owner, id: tp.id, victim: to || me, effect_id: tp.effect_id, mode: tp.mode, trigger: tp.trigger, holder: tp.holder || null, card_id: tp.card_id || null, disabled: true, to });
        useAbility(r, `${tp.owner.slice(0, 8)}'s ${tp.effect_id} trap is disabled — its card goes to ${to ? `${to.slice(0, 8)}'s` : "its owner's"} discard pile`); break;
      }
      case 'class_alchemist': {
        const card = libraryCardFor(`${r.salt || ''}:alchemist:${hg.action}`);
        if (!card) break;
        classAbilityOut.traps.push({ by: me, q: spot.q, r: spot.r, effect_id: card.effect_id, elements: [...card.elements], card_id: null, library: true, power: TRAP_POWER, trigger: 'enter', mode: 'damage', holder: null });
        useAbility(r, `a ${card.effect_id} from the Library lies as a trap at (${spot.q},${spot.r})`); break;
      }
      case 'class_ranger': {
        if (!ab.attach?.effect_id || !Array.isArray(ab.attach.elements) || !ab.attach.elements.length) break;
        classAbilityOut.traps.push({ by: me, q: here.q, r: here.r, effect_id: ab.attach.effect_id, elements: [...ab.attach.elements], card_id: ab.attach.card_id || null, library: false, power: TRAP_POWER, trigger: 'targeted', mode: 'damage', holder: null });
        useAbility(r, `${ab.attach.name || ab.attach.effect_id} lies as a trap under me`); break;
      }
      case 'class_seeker': {
        const key = ab.attach?.effect_id || ab.attach?.skill_id || null;
        if (!key) break;
        const where = allTraps.filter(tp => !trapGone.has(tp.id) && tp.effect_id === key).map(tp => ({ q: tp.q, r: tp.r }));
        if (where.length) { classAbilityOut.peeks.push({ kind: 'locate', by: me, of: key, tiles: where }); useAbility(r, `${ab.attach.name || key} lies at ${where.map(t => `(${t.q},${t.r})`).join(' ')}`); break; }
        const inLib = ab.attach.effect_id && effCtx.library().some(c => c.effect_id === ab.attach.effect_id) ? effCtx.library().find(c => c.effect_id === ab.attach.effect_id) : null;
        const free = inLib ? effCtx.freeTilesWithin(here.q, here.r, 10).filter(t => !(t.q === here.q && t.r === here.r)) : [];
        if (!free.length) { classAbilityOut.peeks.push({ kind: 'locate', by: me, of: key, tiles: [] }); useAbility(r, `${ab.attach.name || key} lies nowhere in this Dimension`); break; }
        const pick = free[parseInt(sha256Hex(`${r.salt || ''}:seeker:${hg.action}`).slice(0, 8), 16) % free.length];
        classAbilityOut.traps.push({ by: me, q: pick.q, r: pick.r, effect_id: inLib.effect_id, elements: [...inLib.elements], card_id: null, library: true, power: TRAP_POWER, trigger: 'enter', mode: 'damage', holder: null });
        classAbilityOut.peeks.push({ kind: 'locate', by: me, of: key, tiles: [pick] });
        useAbility(r, `${ab.attach.name || key} is in the Library — a copy lies as a trap at (${pick.q},${pick.r})`); break;
      }
      case 'class_warrior': {
        const who = nearAlly || me;
        if (!tile || nextTiles.has(who)) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class warrior: ${who === me ? 'I' : who.slice(0, 8)} already moved / no tile picked`); break; }
        const wv = view.get(who);
        const dest = stepsAlong(who, { q: wv.tile_q, r: wv.tile_r }, { q: tile.q, r: tile.r }, 1);
        const takenBy = [...view.values()].some(o => o?.peer_id && o.peer_id !== who && lifeOf(o.peer_id) > 0 && (() => { const t = postTile(o.peer_id); return t.tile_q === dest.q && t.tile_r === dest.r; })()) || [...nextTiles.values()].some(t => t.q === dest.q && t.r === dest.r);
        if ((dest.q === wv.tile_q && dest.r === wv.tile_r) || takenBy || obstacleBlocks(who, dest.q, dest.r)) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class warrior: no free step toward (${tile.q},${tile.r})`); break; }
        nextTiles.set(who, dest); journeyResults.set(who, { outcome: 'complete', q: dest.q, r: dest.r, action: 'warrior' });
        classAbilityOut.moves.push({ who, by: me, q: dest.q, r: dest.r });
        useAbility(r, `${who === me ? 'I step' : `${who.slice(0, 8)} steps`} to (${dest.q},${dest.r})`); break;
      }
      case 'class_necromancer': {
        const fallen = [...view.keys()].filter(id => id !== me && lifeOf(id) <= 0 && view.get(id)?.creature_id && distBetween(me, id) <= 1 && sideOf(view.get(id).alliance) === sideOf(v.alliance)).sort()[0] || null;
        if (fallen) { classAbilityOut.revives.push({ by: me, who: fallen, creature_id: view.get(fallen).creature_id, name: view.get(fallen).name }); useAbility(r, `${view.get(fallen).name || fallen.slice(0, 8)} rises again`); break; }
        // No corpse in reach: my archived creature (the owner alone knows the archive — judged when applying).
        classAbilityOut.revives.push({ by: me, who: null }); useAbility(r, 'no fallen ally in reach — an archived creature of mine enters if I have one'); break;
      }
      default: break;
    }
  }
  // Transmuter (static): a nearby ally's completed cast of stat tokens / heals works on the Transmuter too.
  for (const id of [...view.keys()].sort()) {
    if (lifeOf(id) <= 0 || classOf(id) !== 'class_transmuter') continue;
    for (const { actor, oc } of effectOutcomes) {
      if (actor === id || oc.status !== 'done' || enemyOf(id, actor) || distBetween(id, actor) > 1) continue;
      const dup = oc.statTokens.filter(t => t.on === actor && t.value > 0).map(t => ({ ...t, on: id }));
      const heals = oc.heals.filter(h => h.on === actor).map(h => ({ ...h, on: id }));
      if (dup.length || heals.length) { oc.statTokens.push(...dup); oc.heals.push(...heals); if (id === PEER_ID_STRING || actor === PEER_ID_STRING) log(`[${PEER_LABEL}] transmuter ${id.slice(0, 8)} shares ${actor.slice(0, 8)}'s cast (${dup.length} token(s), ${heals.length} heal(s))`); }
    }
  }
  // Restaurateur (static): a token destroyed by a Restaurateur is taken instead (same tile / into their holding).
  for (const d of destroyOutcomes) if (d.result === 'destroyed' && !d.phylactery && d.tok && classOf(d.actor) === 'class_restaurateur') { d.result = 'taken'; if (d.actor === PEER_ID_STRING || d.owner === PEER_ID_STRING) log(`[${PEER_LABEL}] restaurateur ${d.actor.slice(0, 8)} takes the ${d.kind} token instead of destroying it`); }
  // Avenger (static, once per action): every adjacent enemy character shows two cards of their hand.
  for (const id of [...view.keys()].sort()) {
    if (lifeOf(id) <= 0 || classOf(id) !== 'class_avenger' || classStateOf(id).usedAction === hg.action) continue;
    const foes = [...view.keys()].filter(o => o !== id && lifeOf(o) > 0 && enemyOf(id, o) && distBetween(id, o) <= 1 && view.get(o)?.character_id).sort();
    if (!foes.length) continue;
    for (const o of foes) classAbilityOut.peeks.push({ kind: 'hand2', by: id, of: o, n: 2 });
    classAbilityOut.used.push({ actor: id, class_id: 'class_avenger' });
    if (id === PEER_ID_STRING) log(`[${PEER_LABEL}] class avenger: ${foes.map(f => f.slice(0, 8)).join(', ')} show me two cards`);
  }
  for (const [who, t] of [...nextTiles.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const before = view.get(who);
    if (!before || lifeOf(who) <= 0 || (before.tile_q === t.q && before.tile_r === t.r)) continue;
    if (rogueMove.has(who)) continue;   // Rogue: this step springs nothing
    for (const tp of allTraps) if (tp.trigger === 'enter' && tp.q === t.q && tp.r === t.r && tp.owner !== who && enemyOf(tp.owner, who) && !trapGone.has(tp.id)) springTrap(tp, who);
  }
  for (const r of revealsThisTurn) {
    const tgt = targetOf(r);
    if (!tgt || tgt === r.actor || lifeOf(r.actor) <= 0 || !enemyOf(r.actor, tgt)) continue;
    const ov = view.get(tgt);
    if (!ov) continue;
    for (const tp of allTraps) if (tp.trigger === 'targeted' && tp.owner === tgt && tp.q === ov.tile_q && tp.r === ov.tile_r && !trapGone.has(tp.id)) springTrap(tp, r.actor);
  }
  for (const { actor, eff, oc } of effectOutcomes) {
    if (oc.status !== 'done') continue;
    for (const pm of oc.permanents) if (pm.on === PEER_ID_STRING) permanentsToAdd.push(pm.id);
    // The holdings below are MY state: only the real run writes them (a quiet counterfactual replay must not lay a second trap).
    for (const ch of oc.channels || []) if (ch.on === PEER_ID_STRING && !quiet) {
      // A new Blessing replaces the effect under the old one (its card goes to the discard pile).
      if (ch.holder) for (const old of entity.channels.filter(c => c.holder === ch.holder)) releaseHeldCard(old.card_id);
      entity.channels = entity.channels.filter(c => c.effect_id !== ch.effect_id && !(ch.holder && c.holder === ch.holder));
      entity.channels.push({ effect_id: ch.effect_id, target: ch.target, elements: ch.elements, salt: ch.salt, stop: ch.stop, holder: ch.holder || null, card_id: ch.card_id || null, startedTurn: hg.turn, startedAction: hg.action });
      if (ch.card_id) { holdCard(ch.card_id); console.log(`[${PEER_LABEL}] ${ch.effect_id} is blessed — it fires every action while the Blessing stands`); }
    }
    // A trap of mine is laid: the card leaves my hand for the holding (face down on the tile).
    for (const tp of oc.traps || []) if (tp.by === PEER_ID_STRING && !quiet) {
      const id = `${PEER_ID_STRING.slice(-8)}#${hg.action}#trap${entity.traps.length}`;
      entity.traps.push({ id, q: tp.q, r: tp.r, effect_id: tp.effect_id, elements: tp.elements, card_id: tp.card_id, power: tp.power, trigger: tp.trigger, mode: tp.mode, holder: tp.holder, ...(tp.library ? { library: true } : {}) });
      if (tp.card_id) holdCard(tp.card_id);
      console.log(`[${PEER_LABEL}] trap ${tp.effect_id} laid at (${tp.q},${tp.r}) [${tp.trigger}/${tp.mode}]`);
    }
    for (const ob of oc.obstacles || []) if (ob.by === PEER_ID_STRING && !quiet) {
      entity.obstacles.push({ id: `${PEER_ID_STRING.slice(-8)}#${hg.action}#ob${entity.obstacles.length}`, q: ob.q, r: ob.r, hp: ob.hp, elem: ob.elem });
      console.log(`[${PEER_LABEL}] creation: Earth obstacle (${ob.hp} hp) at (${ob.q},${ob.r})`);
    }
    for (const lk of oc.links || []) if (lk.on === PEER_ID_STRING && !quiet) {
      entity.links = entity.links.filter(l => l.stat !== lk.stat);
      entity.links.push({ from: lk.from, stat: lk.stat, value: lk.value });
      console.log(`[${PEER_LABEL}] spirit link: ${lk.from.slice(0, 8)}'s ${lk.stat} (${lk.value}) joins mine`);
    }
    for (const hit of oc.hits) {
      const defId = hit.victim;
      const defV = view.get(defId);
      if (!defV) continue;
      let shield = hasPerm(defId, 'skill_force_shield') ? (permPowerOf(defId).skill_force_shield || 0) : 0;
      let spent = 0;
      const legs = hit.legs.map(l => ({ ...l }));
      let dmg = 0;
      const zoned = eff.effect_id !== 'effect_blizzard' && untouchable(defId, actor);
      // The token lands where the target stood; a target that moved off this
      // action is not burned — the token stays on that tile instead.
      const after = postTile(defId);
      const movedOff = after.tile_q !== defV.tile_q || after.tile_r !== defV.tile_r;
      for (const tk of oc.tokens) if (tk.kind === 'fire' && tk.q === defV.tile_q && tk.r === defV.tile_r) tk.consumed = !movedOff;
      for (const leg of legs) {
        if (leg.kind === 'token' && movedOff) { leg.dealt = 0; continue; }
        let sum = leg.sum;
        if (shield && roundHalfUp10(sum) > 0) { spent = shield; sum = Math.max(0, sum - shield); shield = 0; }
        let d = roundHalfUp10(sum);
        if (d > 0 && zoned) d = 0;
        if (d > 0 && absorbedByShieldToken(defId)) d = 0;
        leg.dealt = d;
        dmg += d;
      }
      if (dmg > 0) addDmg(defId, actor, dmg, 'effect');
      if (dmg > 0 && hit.selfDamageEqual) addDmg(actor, actor, dmg, 'effect');
      if (dmg > 0 && hit.healDealt) oc.heals.push({ on: actor, amount: dmg });
      if (spent && defId === PEER_ID_STRING) brokenShield = true;
      if (actor === PEER_ID_STRING || defId === PEER_ID_STRING) log(`[${PEER_LABEL}] cast ${eff.effect_id} [${eff.elements.join('+')}] ${actor.slice(0, 8)} → ${defId.slice(0, 8)}: ${legs.map(l => `${l.kind} Σ${l.sum}`).join(' + ')}${spent ? ` (shield −${spent})` : ''}${zoned ? ' (no-damage zone)' : ''} → ${dmg} dmg`);
    }
  }
  // Death Ward: a warded unit that would die this action keeps 1 hp and is moved
  // out to its entry hex (if free); the ward is spent. Every peer derives it from
  // the warder's snapshot (wards_csv) and the victim's entry_q/entry_r.
  const wardFired = [];
  for (const [victim, list] of [...damage.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = list.reduce((a, d) => a + d.amount, 0);
    const life = lifeOf(victim);
    if (life <= 0 || total < life) continue;
    const warder = [...view.values()].filter(v => v?.peer_id && v.peer_id !== victim && (v.life ?? 0) > 0 && hasPerm(v.peer_id, 'effect_resurrect_death_ward') && csvSet(v.wards_csv).has(victim)).map(v => v.peer_id).sort()[0];
    if (!warder) continue;
    let over = total - (life - 1);
    for (let i = list.length - 1; i >= 0 && over > 0; i--) { const cut = Math.min(list[i].amount, over); list[i].amount -= cut; over -= cut; }
    damage.set(victim, list.filter(d => d.amount > 0));
    const v = view.get(victim);
    const entry = v && Number.isInteger(v.entry_q) && Number.isInteger(v.entry_r) ? { q: v.entry_q, r: v.entry_r } : null;
    const taken = (q, r) => [...view.values()].some(o => o?.peer_id && o.peer_id !== victim && (o.life ?? 0) > 0 && (() => { const t = nextTiles.get(o.peer_id) || { q: o.tile_q, r: o.tile_r }; return t.q === q && t.r === r; })());
    if (entry && !taken(entry.q, entry.r)) nextTiles.set(victim, entry);
    wardFired.push({ victim, warder, moved: !!entry && nextTiles.get(victim) === entry });
    if (victim === PEER_ID_STRING || warder === PEER_ID_STRING) log(`[${PEER_LABEL}] death ward: ${victim.slice(0, 8)} would fall — stands at 1 hp${entry ? ` back at (${entry.q},${entry.r})` : ''}`);
  }
  return { damage, nextTiles, journeyResults, vetoed, brokenShield, permanentsToAdd, lifestealForMe, byActor, codeVs, effectOutcomes, tokensSpent, counterPen, roundZones, destroyOutcomes, disableTriggers, wardFired, trapsSpent, afflictionsOut, obstacleHits, channelsBroken, relocations, blessFired, classOutcomes, classAbilityOut };
  };

  const sumDmg = list => (list || []).reduce((s, d) => s + d.amount, 0);
  // Haste bonus rounds (user spec): each Haste holder's bonus action resolves
  // first, alone — everyone else stands in Empty Posture — and its damage and
  // moves are on the board before the normal actions oppose each other.
  // Actor order is sorted so every peer runs the same sequence.
  // The whole round — Balefire pre-round, bonus rounds, normal action — is one
  // re-runnable function so the Rule 8 counterfactuals can replay it without a
  // single instant, wherever that instant was played (main or bonus plan).
  // `view` carries landed tiles/life between the sub-rounds; every run starts
  // from the same snapshot and the real run's board is put back afterwards.
  const viewSnap = () => new Map([...view].map(([id, v]) => [id, { tile_q: v.tile_q, tile_r: v.tile_r, life: v.life, shield_elems_csv: v.shield_elems_csv || '' }]));
  const viewApply = (snap, dmgToMe) => { for (const [id, st] of snap) { const v = view.get(id); if (v) Object.assign(v, st); } bonusDmgToMe = dmgToMe; };
  const viewBefore = viewSnap();
  const runRound = (reveals, quiet) => {
  viewApply(viewBefore, 0);
  const revealsThisTurn = reveals;
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const bonusRuns = [];
  const landRun = (br) => {
    for (const [id, t] of br.nextTiles) { const v = view.get(id); if (v) { v.tile_q = t.q; v.tile_r = t.r; } }
    for (const [id, list2] of br.damage) {
      const d = sumDmg(list2);
      if (id === PEER_ID_STRING) bonusDmgToMe += d;
      const v = view.get(id); if (v) v.life = Math.max(0, v.life - d);
    }
    // A Shield raised in this bonus round stands for the rest of the action.
    for (const { oc } of br.effectOutcomes) {
      if (oc.status !== 'done' || !oc.shieldElem) continue;
      const v = view.get(oc.shieldElem.on);
      if (v) v.shield_elems_csv = [...new Set([...String(v.shield_elems_csv || '').split(',').filter(Boolean), oc.shieldElem.elem])].sort().join(',');
    }
  };
  const asEP = (x) => ({ actor: x.actor, action: 'EP', target: null, skills: [], trance: null, effect: null, destroy: null, salt: x.salt || '' });
  // Bonus plans: Haste grants one; a standing Balefire(6) turns every card into an instant (user spec 2026-10-29).
  const allowanceOf = (id) => { const perms = id === PEER_ID_STRING ? [...entity.permanents] : String(view.get(id)?.permanents_csv || '').split(','); return (perms.includes('effect_haste') ? 1 : 0) + (perms.includes('effect_balefire') ? BALEFIRE_PLANS : 0); };
  for (const r of [...revealsThisTurn].filter(r => Array.isArray(r.bonus) && r.bonus.length).sort((a, b) => a.actor.localeCompare(b.actor))) {
    const list = r.bonus.filter(b => b && b.action).slice(0, allowanceOf(r.actor));
    if (!quiet && r.actor === PEER_ID_STRING && myLastReveal) myLastReveal.bonusUsed = list.length;
    for (let k = 0; k < list.length; k++) {
      if (lifeOf(r.actor) <= 0) break;
      const b = list[k];
      const bReveals = revealsThisTurn.filter(x => lifeOf(x.actor) > 0).map(x => x.actor === r.actor
        ? { actor: x.actor, action: b.action, target: b.target || null, skills: Array.isArray(b.skills) ? [...b.skills] : [], trance: Array.isArray(b.trance) && b.trance.length === 2 ? [...b.trance] : null, effect: b.effect || null, destroy: b.destroy || null, salt: `${x.salt || ''}:bonus${k}` }
        : asEP(x));
      log(`[${PEER_LABEL}] bonus round ${k + 1}/${list.length}: ${r.actor.slice(0, 8)} plays ${b.action}${(b.skills || []).length ? ` + ${b.skills.join(',')}` : ''}${b.effect ? ` + ${b.effect.effect_id} ${b.effect.step}/${b.effect.of}` : ''}`);
      const br = simulate(bReveals, quiet, { bonus: true });
      bonusRuns.push({ actor: r.actor, seq: bonusRuns.length, k, bonus: b, res: br });
      landRun(br);
    }
  }
  if (bonusRuns.length) for (let i = revealsThisTurn.length - 1; i >= 0; i--) if (lifeOf(revealsThisTurn[i].actor) <= 0) revealsThisTurn.splice(i, 1);
  const real = simulate(revealsThisTurn, quiet);
  // Fold the bonus rounds in: their damage counts (flagged), their moves stand
  // unless the normal action moved again, their effects apply like any other.
  for (const b of bonusRuns.reverse()) {
    for (const [id, list] of b.res.damage) real.damage.set(id, [...list.map(d => ({ ...d, bonus: true })), ...(real.damage.get(id) || [])]);
    for (const [id, t] of b.res.nextTiles) if (!real.nextTiles.has(id)) real.nextTiles.set(id, t);
    for (const [id, j] of b.res.journeyResults) if (!real.journeyResults.has(id)) real.journeyResults.set(id, j);
    real.effectOutcomes.unshift(...b.res.effectOutcomes.map(o => ({ ...o, bonus: true })));
    real.tokensSpent.push(...b.res.tokensSpent); real.destroyOutcomes.push(...b.res.destroyOutcomes);
    real.permanentsToAdd.push(...b.res.permanentsToAdd); real.roundZones.push(...b.res.roundZones);
    for (const [id, pen] of b.res.counterPen) real.counterPen.set(id, { ...pen, ...(real.counterPen.get(id) || {}) });
    real.brokenShield = real.brokenShield || b.res.brokenShield;
    real.lifestealForMe.amount += b.res.lifestealForMe.amount;
    real.disableTriggers.unshift(...b.res.disableTriggers);
    real.wardFired.unshift(...b.res.wardFired);
    real.trapsSpent.unshift(...b.res.trapsSpent); real.afflictionsOut.unshift(...b.res.afflictionsOut); real.obstacleHits.unshift(...b.res.obstacleHits); real.channelsBroken.unshift(...b.res.channelsBroken); real.relocations.unshift(...b.res.relocations); real.blessFired.unshift(...b.res.blessFired); real.classOutcomes.unshift(...b.res.classOutcomes); for (const k of Object.keys(real.classAbilityOut)) real.classAbilityOut[k].unshift(...(b.res.classAbilityOut[k] || []));
  }
  bonusRuns.reverse();
  real.bonusRuns = bonusRuns;
  return real;
  };
  const real = runRound(revealsThisTurn, false);
  const viewReal = viewSnap(), bonusDmgReal = bonusDmgToMe;
  const { damage, nextTiles, journeyResults, vetoed, brokenShield, permanentsToAdd, lifestealForMe, byActor, codeVs, effectOutcomes, tokensSpent, counterPen, roundZones, destroyOutcomes, disableTriggers, bonusRuns, wardFired, trapsSpent, afflictionsOut, obstacleHits, channelsBroken, relocations, blessFired, classOutcomes, classAbilityOut } = real;
  // Map surgery moved something of mine: the token / trap / obstacle takes its new tile.
  for (const rl of relocations) {
    // A world-generated feature: the mover records where it went (world_edits_json).
    if (rl.owner === 'world') { if (rl.by === PEER_ID_STRING) { entity.worldEdits = entity.worldEdits.filter(e => e.id !== rl.id); entity.worldEdits.push({ id: rl.id, q: rl.q, r: rl.r, at: hg.action }); console.log(`[${PEER_LABEL}] ${rl.label || rl.id} moved to (${rl.q},${rl.r})`); } continue; }
    if (rl.owner !== PEER_ID_STRING) continue;
    const list = rl.kind === 'token' ? entity.tileTokens : rl.kind === 'trap' ? entity.traps : entity.obstacles;
    const x = list.find(o => o.id === rl.id);
    if (x) { x.q = rl.q; x.r = rl.r; console.log(`[${PEER_LABEL}] my ${rl.kind} ${rl.label || rl.id} moved to (${rl.q},${rl.r})`); }
  }
  // A channel of mine broke (I moved / attacked / emitted another element): the permanent falls.
  for (const cb of channelsBroken) if (cb.owner === PEER_ID_STRING && entity.permanents.has(cb.effect_id)) { dropPermanent(cb.effect_id); console.log(`[${PEER_LABEL}] ${cb.effect_id} ${cb.why ? `dropped (${cb.why})` : 'channel broken (concentration lost)'}`); }
  // My Earth obstacles wear down under enemy Matter; at 0 hp they are gone.
  for (const h of obstacleHits) {
    if (h.owner !== PEER_ID_STRING) continue;
    const ob = entity.obstacles.find(o => o.id === h.id);
    if (!ob) continue;
    ob.hp -= h.amount;
    if (ob.hp <= 0) { entity.obstacles = entity.obstacles.filter(o => o.id !== h.id); console.log(`[${PEER_LABEL}] my obstacle at (${ob.q},${ob.r}) crumbles under ${h.by.slice(0, 8)}`); }
  }
  // Traps of mine that sprang: gone from the tile, their card to the discard pile. A fired
  // perm-trap (Sleep, Confusion) comes up as my permanent instead (permanentsToAdd below).
  // User ruling 2026-10-30: a trap under its owner goes back to the OWNER's discard pile; a trap on an
  // open tile (enter trigger — nobody of mine stood there) goes to the discard pile of the unit that
  // dealt with it (sprang it). Library-generated traps (Space Bending, Alchemist) only ever exist as
  // that card for the one who dealt with them.
  // A Cleric's disabled trap (`disabled`, `to`): the card goes to the unit standing on the tile, else back to its owner.
  for (const ts of trapsSpent) {
    const cardToVictim = ts.disabled ? (!!ts.to && ts.to !== ts.owner) : (ts.trigger === 'enter' && ts.mode === 'damage');
    if (ts.owner === PEER_ID_STRING) {
      entity.traps = entity.traps.filter(t => t.id !== ts.id);
      if (ts.mode === 'damage' || ts.disabled) releaseHeldCard(ts.card_id, !cardToVictim);
      if (ts.holder) dropPermanent(ts.holder);
      console.log(`[${PEER_LABEL}] my trap ${ts.effect_id} ${ts.disabled ? 'is disabled' : `sprang on ${ts.victim.slice(0, 8)}`}${cardToVictim ? ' — its card is theirs now' : ''}`);
    }
    const receiver = ts.disabled ? ts.to : ts.victim;
    if (cardToVictim && receiver === PEER_ID_STRING && receiver !== ts.owner && data.effects[ts.effect_id]) {
      const c = makeEffectCard(ts.effect_id);
      discard.push(c);
      console.log(`[${PEER_LABEL}] I dealt with the ${c.name} trap — its card goes to my discard pile`);
    }
  }
  // Class cards (user ruling 2026-10-30) — what happened to MY class this action.
  for (const co of classOutcomes) {
    if (co.owner !== PEER_ID_STRING || !co.ok) continue;
    const cols = Object.keys(classColours(entity.classId));
    if (co.kind === 'colour') { if (!entity.classDown.includes(co.stat)) entity.classDown.push(co.stat); console.log(`[${PEER_LABEL}] my class ${entity.className} lost its ${co.stat} colour to ${co.actor.slice(0, 8)} (${entity.classDown.length}/${cols.length} down)`); }
    if (co.kind === 'class_destroyed') {
      entity.classDown = [...cols]; entity.permanents.delete(entity.classId); delete entity.permPower[entity.classId];
      entity.classArchived = true; entity.classTapped = false; entity.classProgress = null;
      if (!archive.some(c => c.kind === 'class')) archive.push(classCard());
      console.log(`[${PEER_LABEL}] my class ${entity.className} is destroyed by ${co.actor.slice(0, 8)} — the card goes to my archive; emit every colour (any successful roll) to recast it`);
    }
    if (co.kind === 'recast' || co.kind === 'untap') {
      if (!entity.classProgress || entity.classProgress.mode !== co.kind) entity.classProgress = { mode: co.kind, done: [] };
      if (!entity.classProgress.done.includes(co.stat)) entity.classProgress.done.push(co.stat);
      const complete = cols.every(s => entity.classProgress.done.includes(s));
      if (complete && co.kind === 'recast') {
        entity.classArchived = false; entity.classDown = []; entity.permanents.add(entity.classId); entity.classProgress = null;
        for (let i = archive.length - 1; i >= 0; i--) if (archive[i].kind === 'class') archive.splice(i, 1);
        console.log(`[${PEER_LABEL}] my class ${entity.className} is back on the board (every colour recast)`);
      } else if (complete) { entity.classTapped = false; entity.classProgress = null; console.log(`[${PEER_LABEL}] my class ${entity.className} is untapped — the ability is ready again`); }
      else console.log(`[${PEER_LABEL}] class ${co.kind}: ${entity.classProgress.done.length}/${cols.length} colours (${co.stat} done)`);
    }
  }
  // Class abilities that fired this action (user ruling 2026-10-30) — each peer applies what is theirs.
  for (const u of classAbilityOut.used) {
    if (u.actor !== PEER_ID_STRING || u.class_id !== entity.classId) continue;
    if (classKindOf(u.class_id) === 'tap') { entity.classTapped = true; console.log(`[${PEER_LABEL}] class ${entity.className} is tapped — emit every colour (any successful roll) to untap it`); }
    else entity.classUsedAction = hg.action;
  }
  for (const a of classAbilityOut.armor) if (a.on === PEER_ID_STRING && entity.life > 0 && !entity.armor) { entity.armor = 1; console.log(`[${PEER_LABEL}] overlord ${a.by.slice(0, 8)}: I wear an armor life token`); }
  // Priest / Witch: cards leave MY hand (the hand is private — the pick is mine, deterministic by card id).
  for (const dc of classAbilityOut.discards) {
    if (dc.on !== PEER_ID_STRING) continue;
    const pool = hand.map((c, i) => ({ c, i })).filter(x => dc.stat ? (x.c.element_cost || []).some(el => ELEM_TO_STAT[el] === dc.stat) || (x.c.kind === 'skill' && (data.skills[x.c.skill_id]?.data?.point_buy_stat || '').replace(/^stat_/, '') === dc.stat) : true);
    pool.sort((a, b) => (dc.prefer === 'skill' ? (a.c.kind === 'skill' ? 0 : 1) - (b.c.kind === 'skill' ? 0 : 1) : 0) || String(a.c.card_id).localeCompare(String(b.c.card_id)));
    const gone = pool.slice(0, dc.n).map(x => x.c);
    for (const c of gone) { hand.splice(hand.indexOf(c), 1); discard.push(c); }
    console.log(`[${PEER_LABEL}] ${dc.by.slice(0, 8)}'s ${dc.prefer === 'skill' ? 'priest' : 'witch'}: ${gone.length ? gone.map(c => c.name || c.action_name).join(', ') : 'nothing'} discarded from my hand`);
    if (gone.length) broadcastUI({ kind: 'peek', what: 'discard', text: `${dc.prefer === 'skill' ? 'Priest' : 'Witch'}: ${gone.map(c => c.name || c.action_name).join(', ')} left your hand for the discard pile.` });
  }
  // Prophet (deck top five), Avenger (two hand cards): the one looked at publishes; Seeker: where a card lies.
  for (const pk of classAbilityOut.peeks) {
    if (pk.kind === 'deck' && pk.of === PEER_ID_STRING) publishPeek(pk.by, { what: 'deck', n: pk.n || 5 }).catch(() => {});
    if (pk.kind === 'hand2' && pk.of === PEER_ID_STRING) publishPeek(pk.by, { what: 'hand', n: pk.n || 2 }).catch(() => {});
    if (pk.kind === 'locate' && pk.by === PEER_ID_STRING) broadcastUI({ kind: 'peek', what: 'locate', tiles: pk.tiles, text: `Seeker: ${pk.of} ${pk.tiles.length ? `lies at ${pk.tiles.map(t => `(${t.q},${t.r})`).join(' ')}` : 'lies nowhere in this Dimension'}.` });
  }
  // Alchemist / Seeker (Library copies) / Ranger (a card of mine): traps laid by my class.
  for (const tp of classAbilityOut.traps) if (tp.by === PEER_ID_STRING) {
    const id = `${PEER_ID_STRING.slice(-8)}#${hg.action}#ctrap${entity.traps.length}`;
    entity.traps.push({ id, q: tp.q, r: tp.r, effect_id: tp.effect_id, elements: tp.elements, card_id: tp.card_id, power: tp.power, trigger: tp.trigger, mode: tp.mode, holder: tp.holder, ...(tp.library ? { library: true } : {}) });
    if (tp.card_id) holdCard(tp.card_id);
    console.log(`[${PEER_LABEL}] class trap ${tp.effect_id} laid at (${tp.q},${tp.r}) [${tp.trigger}/${tp.mode}${tp.library ? '/library' : ''}]`);
  }
  // Druid: my defence token on my tile.
  for (const tk of classAbilityOut.tokens) if (tk.by === PEER_ID_STRING) {
    const same = entity.tileTokens.find(x => x.kind === tk.kind && x.elem === tk.elem && x.q === tk.q && x.r === tk.r);
    if (same && same.value >= tk.value) continue;
    if (same) entity.tileTokens = entity.tileTokens.filter(x => x !== same);
    entity.tileTokens.push({ id: `${PEER_ID_STRING.slice(-8)}#${hg.action}#c${entity.tileTokens.length}`, kind: tk.kind, elem: tk.elem, value: tk.value, q: tk.q, r: tk.r });
  }
  // Necromancer: a fallen ally creature rises (held by the class), or an archived creature of mine enters.
  for (const rv of classAbilityOut.revives) {
    if (rv.who && rv.who === PEER_ID_STRING) onRevived(rv.by, 'class_necromancer');
    if (rv.by !== PEER_ID_STRING) continue;
    if (rv.who) { entity.summons.push({ peer_id: rv.who, creature_id: rv.creature_id, name: rv.name, bound: true, perm: 'class_necromancer', mode: 'revive' }); continue; }
    const i = archive.findIndex(c => c.kind === 'creature' && data.creatures[c.creature_id]);
    if (i < 0) { console.log(`[${PEER_LABEL}] class necromancer: no creature in my archive — nothing rises`); continue; }
    const c = archive.splice(i, 1)[0];
    if (entity.summons.some(x => x.perm === 'class_necromancer')) onSummonEnd('class_necromancer');
    spawnCompanion('class_necromancer', { creature_id: c.creature_id, name: c.name, env: { CHARACTER_ID: '', CREATURE_ID: c.creature_id, ENTITY_NAME: `${c.name} (${PEER_LABEL}'s)` } })
      .then(tag => { if (tag) console.log(`[${PEER_LABEL}] class necromancer: ${c.name} rises from my archive as ${tag}`); }).catch(e => console.warn(`[${PEER_LABEL}] necromancer failed: ${e.message}`));
  }
  // Restaurateur: a token I would have destroyed is mine instead (its owner drops it below as 'taken').
  for (const d of destroyOutcomes) {
    if (d.result !== 'taken' || d.actor !== PEER_ID_STRING || !d.tok) continue;
    if (d.kind === 'stat') entity.statTokens.push({ id: `${PEER_ID_STRING.slice(-8)}#${hg.action}#r${entity.statTokens.length}`, stat: d.tok.stat || ELEM_TO_STAT[d.tok.elem], elem: d.tok.elem, value: d.tok.value, effect_id: d.tok.effect_id || null });
    else if (d.kind === 'tile') entity.tileTokens.push({ id: `${PEER_ID_STRING.slice(-8)}#${hg.action}#r${entity.tileTokens.length}`, kind: d.tok.kind || 'bonus', elem: d.tok.elem, value: d.tok.value, q: d.tok.q, r: d.tok.r, ...(d.tok.item ? { item: d.tok.item } : {}) });
    console.log(`[${PEER_LABEL}] restaurateur: ${d.owner === 'world' ? 'the world\'s' : `${d.owner.slice(0, 8)}'s`} ${d.kind} token (${d.tok.elem} ${d.tok.value}) is under my control now`);
  }
  // My Blessing ∀ negated an enemy effect: the second Blessing card goes to the discard pile, the first stands.
  for (const bf of blessFired) {
    if (bf.holder !== PEER_ID_STRING) continue;
    entity.everyPerms.delete('effect_blessing_curse');
    const second = heldCards.find(c => c.effect_id === 'effect_blessing_curse');
    if (second) releaseHeldCard(second.card_id);
    console.log(`[${PEER_LABEL}] my Blessing ∀ negated ${bf.caster.slice(0, 8)}'s ${bf.effect_id} — one Blessing remains`);
  }
  // Afflictions on me (Sleep: no casting in contact with the holder; Confusion: Empty Posture only) hold while the holder keeps the permanent.
  for (const a of afflictionsOut) if (a.on === PEER_ID_STRING && !entity.afflictions.some(x => x.effect_id === a.effect_id && x.by === a.by)) entity.afflictions.push({ effect_id: a.effect_id, by: a.by, ...(a.until_action !== undefined ? { until_action: a.until_action } : {}) });
  // My Death Ward fired: the permanent is spent (its card goes to the discard pile).
  for (const w of wardFired) {
    if (w.warder !== PEER_ID_STRING) continue;
    entity.wards = entity.wards.filter(x => x !== w.victim);
    dropPermanent(RESURRECT);
    console.log(`[${PEER_LABEL}] my Death Ward saved ${w.victim.slice(0, 8)} — the permanent is spent`);
  }
  // My Disable fired: the permanent is spent, the bar stands for the turn.
  for (const t of disableTriggers) {
    if (t.holder !== PEER_ID_STRING) continue;
    dropPermanent('effect_disable');
    entity.disables.push({ elem: t.elem, on: t.global ? '*' : t.caster, until_turn: hg.turn });
    console.log(`[${PEER_LABEL}] my Disable spent: ${t.elem} barred ${t.global ? 'for everyone' : `to ${t.caster.slice(0, 8)}`} this turn`);
  }
  // Effect permanents carry a point-buy die of their first element's stat (Rule 12).
  for (const id of permanentsToAdd) {
    entity.permanents.add(id);
    const el = data.effects[id]?.data?.element_cost?.[0];
    const seed = `${myLastReveal?.salt || ''}:perm:${id}:${hg.action}`;
    // Channel permanents (general_ux_channeling) stand on their SMALLEST die; others on the highest.
    entity.permPower[id] = EFFECT_RULES[id]?.fixedPower
      ?? (EFFECT_RULES[id]?.channel ? pointBuyPermanentMin : pointBuyPermanent)(entity.stats[ELEM_TO_STAT[el]] ?? 0, seed, sha256Hex);
    if (id in PERM_TURNS) entity.permUntil[id] = hg.turn + PERM_TURNS[id];
    if (myLastReveal?.effectId === id && myLastReveal.effectEvery) entity.everyPerms.add(id);
    console.log(`[${PEER_LABEL}] permanent ${id} up: die ${entity.permPower[id]}${myLastReveal?.effectEvery ? ' (∀ doubled)' : ''}`);
  }
  // Rule 24: what was destroyed of mine goes now (the destroyer's die beat its power).
  for (const d of destroyOutcomes) {
    if ((d.result !== 'destroyed' && d.result !== 'taken') || d.owner !== PEER_ID_STRING) continue;
    if (d.kind === 'perm') dropPermanent(d.id);
    else if (d.kind === 'stat') entity.statTokens = entity.statTokens.filter(t => t.id !== d.id);
    else if (d.kind === 'tile') entity.tileTokens = entity.tileTokens.filter(t => t.id !== d.id);
    console.log(`[${PEER_LABEL}] my ${d.kind} ${d.id} ${d.result} by ${d.actor.slice(0, 8)} (die ${d.die} ≥ ${d.power})`);
  }
  for (const z of roundZones) activeZones.push({ q: z.q, r: z.r, until_turn: hg.turn });
  // Effect outcomes that concern me (I am authoritative for my own entity and
  // for the tokens I placed). A Counter Spell aimed at me lowers my stat for
  // that element for the rest of the turn.
  for (const [el, amount] of Object.entries(counterPen.get(PEER_ID_STRING) || {})) entity.elemPen.push({ elem: el, amount, until_turn: hg.turn });
  for (const t of tokensSpent) if (t.owner === PEER_ID_STRING) entity.tileTokens = entity.tileTokens.filter(x => x.id !== t.id);
  // World features I pulled / used up / destroyed: recorded as gone (every peer reads my world_edits_json).
  const worldGone = (id, why) => { if (!entity.worldEdits.some(e => e.id === id && e.gone)) { entity.worldEdits = entity.worldEdits.filter(e => e.id !== id); entity.worldEdits.push({ id, gone: true, at: hg.action }); console.log(`[${PEER_LABEL}] world feature ${id} is gone (${why})`); } };
  for (const t of tokensSpent) if (t.owner === 'world' && t.by === PEER_ID_STRING) worldGone(t.id, 'pulled');
  for (const d of destroyOutcomes) if ((d.result === 'destroyed' || d.result === 'taken') && d.owner === 'world' && d.actor === PEER_ID_STRING) worldGone(d.id, d.result);
  let healForMe = 0, drawForMe = 0;
  for (const h of classAbilityOut.heals) if (h.on === PEER_ID_STRING) { healForMe += h.amount; console.log(`[${PEER_LABEL}] healer ${h.by.slice(0, 8)}: +${h.amount} life`); }
  for (const { actor, eff, oc, bonus: fromBonus, channel: fromChannel } of effectOutcomes) {
    // The main cast's status only — a bonus-plan instant or a channel tick must not mark a cast in progress as done.
    if (actor === PEER_ID_STRING && myLastReveal && !fromBonus && !fromChannel) { myLastReveal.castStatus = oc.status; if (oc.kept) myLastReveal.castKept = oc.kept; }
    if (oc.status !== 'done') continue;
    // general_ux_tokens: one token per element per tile (and per element in my holding for bonuses) —
    // a new one only replaces a smaller one of mine.
    const placeTile = (tk) => {
      const same = entity.tileTokens.find(x => x.kind === tk.kind && x.elem === tk.elem && x.q === tk.q && x.r === tk.r);
      if (same) { if (same.value >= tk.value) return; entity.tileTokens = entity.tileTokens.filter(x => x !== same); }
      entity.tileTokens.push({ id: `${PEER_ID_STRING.slice(-8)}#${hg.action}#${entity.tileTokens.length}`, kind: tk.kind, elem: tk.elem, value: tk.value, q: tk.q, r: tk.r, ...(tk.item ? { item: tk.item } : {}) });
    };
    if (actor === PEER_ID_STRING) for (const tk of oc.tokens) { if (!tk.consumed) placeTile(tk); }
    for (const p of oc.pulls || []) if (p.by === PEER_ID_STRING) { placeTile({ kind: 'bonus', elem: p.elem, value: p.value, q: p.q, r: p.r, item: p.item }); console.log(`[${PEER_LABEL}] force pull: ${p.item || p.elem} (${p.value}) is mine now`); }
    for (const st of oc.statTokens) if (st.on === PEER_ID_STRING) {
      if (st.value > 0) {
        const same = entity.statTokens.find(x => x.value > 0 && x.elem === st.elem);
        if (same) { if (same.value >= st.value) continue; entity.statTokens = entity.statTokens.filter(x => x !== same); }
      }
      entity.statTokens.push({ id: `${PEER_ID_STRING.slice(-8)}#${hg.action}#${entity.statTokens.length}`, stat: st.stat, elem: st.elem, value: st.value, effect_id: st.effect_id });
    }
    // "Rest of the round" = the actions left in this turn after this one.
    for (const lk of oc.locks) if (lk.on === PEER_ID_STRING) {
      const n = lk.n ?? ((ROUNDS_PER_TURN - 1 - hg.round) + (lk.nextTurn ? ROUNDS_PER_TURN : 0));
      if (n > 0) entity.lockList.push({ effect_id: eff.effect_id, by: actor, n });
      syncLost();
    }
    for (const h of oc.heals) if (h.on === PEER_ID_STRING) healForMe += h.amount;
    if (oc.shieldElem?.on === PEER_ID_STRING) entity.shieldElems.push({ elem: oc.shieldElem.elem, until_turn: hg.turn, permanent: !!oc.every });
    if (oc.disableElem && actor === PEER_ID_STRING) entity.disables.push({ elem: oc.disableElem.elem, on: oc.disableElem.on, until_turn: hg.turn });
    if (actor === PEER_ID_STRING) drawForMe += oc.draw || 0;
    if (oc.summon) {
      if (actor === PEER_ID_STRING) onSummoned(eff.effect_id, oc.summon).catch(e => console.warn(`[${PEER_LABEL}] summoning failed: ${e.message}`));
      if (oc.summon.bind === PEER_ID_STRING) becomeBound(actor, eff.effect_id, 'bind');
      if (oc.summon.revive) console.log(`[${PEER_LABEL}] resurrect: ${actor.slice(0, 14)} raises ${oc.summon.revive.slice(0, 14)} (${oc.notes.join('; ')})`);
      if (oc.summon.revive === PEER_ID_STRING) onRevived(actor, eff.effect_id);
    }
    // Phantom: my mirror steps in next to me, held by the permanent.
    if (oc.phantom && actor === PEER_ID_STRING) spawnPhantom(eff.effect_id).catch(e => console.warn(`[${PEER_LABEL}] phantom failed: ${e.message}`));
    // Possess (user ruling 2026-10-30): the permanent lands in the beaten unit's holding (generic
    // permanentsToAdd above); it fights on my side and I drive it (proxy) until that permanent falls.
    if (oc.possess?.bind) {
      if (actor === PEER_ID_STRING) {
        if (entity.possessing) releaseHeldCard(entity.possessing.card_id);
        entity.possessing = { peer_id: oc.possess.bind, card_id: myLastReveal?.effectCardId || null };
        console.log(`[${PEER_LABEL}] possess: I play ${oc.possess.bind.slice(0, 14)} now — my hero holds until its Possess permanent falls`);
      }
      if (oc.possess.bind === PEER_ID_STRING) { entity.possessedBy = actor; console.log(`[${PEER_LABEL}] possessed by ${actor.slice(0, 14)} — they play me until my allies destroy the Possess permanent in my holding`); }
    }
    // Vision: a tile peek reveals the map around it for me; a hand peek asks the target to show their hand to me.
    for (const pk of oc.peeks || []) {
      if (pk.kind === 'tile' && pk.by === PEER_ID_STRING) {
        const before = dimMap.size();
        revealAround(pk.q, pk.r).then(() => {
          const there = describeTile(pk.q, pk.r);
          console.log(`[${PEER_LABEL}] vision: tile (${pk.q},${pk.r}) looked at (+${dimMap.size() - before} hexes)${there ? ` — ${there}` : ''}`);
          broadcastUI({ kind: 'peek', what: 'tile', q: pk.q, r: pk.r, text: `Vision: the land around (${pk.q},${pk.r}) is known to you now${there ? ` — ${there}` : ''}.` });
        }).catch(() => {});
      }
      if (pk.kind === 'hand' && pk.of === PEER_ID_STRING) publishPeek(pk.by).catch(() => {});
      if (pk.kind === 'hand' && pk.by === PEER_ID_STRING) console.log(`[${PEER_LABEL}] vision: ${pk.of.slice(0, 14)} must show me their hand`);
    }
    if (actor === PEER_ID_STRING || oc.locks.some(l => l.on === PEER_ID_STRING) || oc.statTokens.some(t => t.on === PEER_ID_STRING)) {
      console.log(`[${PEER_LABEL}] effect ${eff.effect_id} by ${actor.slice(0, 8)}: ${oc.tokens.length} token(s), ${oc.statTokens.length} stat token(s), ${oc.locks.length} lock(s), ${oc.zones.length} zone hexes${oc.notes.length ? ` — ${oc.notes.join('; ')}` : ''}`);
    }
  }
  for (let i = 0; i < drawForMe; i++) { reshuffleIfEmpty(); if (deck.length) hand.push(deck.shift()); }
  if (myLastReveal) myLastReveal.dealtDamage = [...damage.values()].flat().some(d => d.attacker === PEER_ID_STRING && d.amount > 0);
  if (myLastReveal) {
    const mine = byActor.get(PEER_ID_STRING);
    myPlayedCardIds = mine?.trance
      ? (myLastReveal.optionCardIds || []).filter((id, i) => id && mine.played.has(i))
      : (myLastReveal.cardId ? [myLastReveal.cardId] : []);
  }
  // Rule 8 pc override: an instant (non-permanent skill) that neither saved me
  // a point of damage nor added one to what I dealt goes back to my hand. Each
  // is judged alone against a run without it; counterfactuals never leave this
  // peer, so they cannot diverge the shared state.
  if (myLastReveal) {
    const takenBy = (res, id) => sumDmg(res.damage.get(id));
    const dealtBy = (res, id) => [...res.damage.values()].flat().filter(d => d.attacker === id).reduce((s, d) => s + d.amount, 0);
    const healedTo = (res, id) => res.effectOutcomes.filter(o => o.oc.status === 'done').flatMap(o => o.oc.heals).filter(h => h.on === id).reduce((s, h) => s + h.amount, 0);
    // Benefit = I took less, dealt more, or was healed more than in the round without it.
    const paysOff = (without) => takenBy(real, PEER_ID_STRING) < takenBy(without, PEER_ID_STRING) || dealtBy(real, PEER_ID_STRING) > dealtBy(without, PEER_ID_STRING) || healedTo(real, PEER_ID_STRING) > healedTo(without, PEER_ID_STRING);
    const roundWithout = (edit) => { const alt = structuredClone(pristineReveals); const mine = alt.find(r => r.actor === PEER_ID_STRING); if (!mine) return null; edit(mine); return runRound(alt, true); };
    const stripSkill = (w, id) => { w.skills = (w.skills || []).filter(s => s !== id); if (id === TRANCE && w.trance) { w.action = w.trance[0]; w.trance = null; } };
    const returned = [];
    myLastReveal.returnedCardIds = [];
    for (const id of myLastReveal.skillIds || []) {
      if (data.skills[id]?.data?.is_permanent) continue;
      const without = roundWithout(mine => stripSkill(mine, id));
      if (!without) break;
      if (!paysOff(without)) { returned.push(id); myLastReveal.returnedCardIds.push(myLastReveal.skillCardIds[myLastReveal.skillIds.indexOf(id)]); }
    }
    // Instant effects are instants too. Damage/heal count as benefit; a
    // defensive instant (Shield, The Void) earns its keep by lowering what I take.
    if (myLastReveal.effectId && myLastReveal.effectInstant && !myLastReveal.effectPermanent && myLastReveal.castStatus === 'done') {
      const without = roundWithout(mine => { mine.effect = null; });
      if (without && !paysOff(without)) { returned.push(myLastReveal.effectId); myLastReveal.returnedCardIds.push(myLastReveal.effectCardId); }
    }
    // Instants inside my bonus plans (Haste / Balefire) were played this action
    // as well, so they return on the same terms (user ruling) — each judged
    // against the whole round replayed without it.
    const usedBonus = (myLastReveal.bonus || []).slice(0, myLastReveal.bonusUsed ?? 0);
    for (let k = 0; k < usedBonus.length; k++) {
      const b = usedBonus[k];
      const run = bonusRuns.find(x => x.actor === PEER_ID_STRING && !x.pre && x.k === k);
      if (!run) continue;
      for (const id of b.skillIds || []) {
        if (data.skills[id]?.data?.is_permanent) continue;
        const without = roundWithout(mine => { if (mine.bonus?.[k]) stripSkill(mine.bonus[k], id); });
        if (!without) break;
        if (!paysOff(without)) { returned.push(`${id} (bonus ${k + 1})`); myLastReveal.returnedCardIds.push(b.skillCardIds[b.skillIds.indexOf(id)]); }
      }
      const castStatus = run.res.effectOutcomes.find(o => o.actor === PEER_ID_STRING)?.oc.status;
      if (b.effect?.is_instant && !b.effect.is_permanent && castStatus === 'done') {
        const without = roundWithout(mine => { if (mine.bonus?.[k]) mine.bonus[k].effect = null; });
        if (without && !paysOff(without)) { returned.push(`${b.effect.effect_id} (bonus ${k + 1})`); myLastReveal.returnedCardIds.push(b.effectCardId); }
      }
    }
    myLastReveal.returnedCardIds = myLastReveal.returnedCardIds.filter(Boolean);
    if (returned.length) console.log(`[${PEER_LABEL}] instants without benefit return to hand: ${returned.join(', ')}`);
  }
  // The counterfactual replays moved the board; the real round stands.
  viewApply(viewReal, bonusDmgReal);

  // Contact log: broadcast every pair of adjacent cross-side revealers so the
  // UI can show exactly what opposed what. Now that the damage pass has run,
  // each pair carries `damage_exchanged` — the UI only floats the ➙ "nobody
  // scored" arrow on pairs where it is false, and keeps the ⚔️/🛡 damage
  // animation for the ones where it is true.
  const dmgBetween = (x, y) => (damage.get(y) || []).some(d => d.attacker === x);
  const contacts = [];
  for (let i = 0; i < revealsThisTurn.length; i++) {
    for (let j = i + 1; j < revealsThisTurn.length; j++) {
      const a = revealsThisTurn[i], b = revealsThisTurn[j];
      const pa = view.get(a.actor);
      const pb = view.get(b.actor);
      if (!pa || !pb) continue;
      if (sideOf(pa.alliance) === sideOf(pb.alliance)) continue;
      const d = hexDistance({ tile_q: pa.tile_q, tile_r: pa.tile_r }, { tile_q: pb.tile_q, tile_r: pb.tile_r });
      if (d > 1) continue;
      const dmg = dmgBetween(a.actor, b.actor) || dmgBetween(b.actor, a.actor);
      const label = (r, other) => r.trance ? `BT[${r.trance.join('|')}]→${codeVs(r.actor, other)}` : r.action;
      contacts.push({
        a: { peer_id: a.actor, name: pa.name, action: label(a, b.actor), tile_q: pa.tile_q, tile_r: pa.tile_r, vetoed: vetoed.get(a.actor) || null },
        b: { peer_id: b.actor, name: pb.name, action: label(b, a.actor), tile_q: pb.tile_q, tile_r: pb.tile_r, vetoed: vetoed.get(b.actor) || null },
        distance: d,
        damage_exchanged: dmg,
      });
    }
  }
  if (contacts.length) broadcastUI({ kind: 'contact', contacts, turn: hg.turn, round: hg.round });

  // Apply changes only to my own entity in the authoritative sense.
  const myMove = nextTiles.get(PEER_ID_STRING);
  if (myMove) {
    entity.tile = myMove;
    // Rogue: the stealthy step reveals no new hexes (and so wakes no monster behind the fog).
    if (classAbilityOut.stealth.includes(PEER_ID_STRING)) console.log(`[${PEER_LABEL}] rogue: my step reveals nothing`);
    else revealAround(myMove.q, myMove.r).catch(e => console.warn(`[${PEER_LABEL}] reveal failed: ${e.message}`));
  }
  if (entity.classFlags && myMove) entity.classFlags.movedThisRound = true;
  const myDmg = sumDmg(damage.get(PEER_ID_STRING));
  const wasAlive = entity.life > 0;
  if (myDmg) entity.life = Math.max(0, entity.life - myDmg);
  // A Phantom is undone by the first point of damage (user spec 2026-10-29).
  if (myDmg > 0 && IS_PHANTOM && entity.life > 0) { console.log(`[${PEER_LABEL}] phantom: struck for ${myDmg} — the mirror shatters`); entity.life = 0; }
  // Overlord's armor token is the first life lost (the HP recalculation below drops the maximum with it).
  if (myDmg > 0 && entity.armor) { entity.armor = 0; console.log(`[${PEER_LABEL}] the armor token is gone`); }
  // Noble lifesteal: the per-attacker amount I dealt this resolve, now applied
  // as healing after my own damage lands (so a lethal attack that finishes an
  // enemy also carries the heal). Cap at my life maximum.
  if (lifestealForMe.amount > 0 && entity.life > 0 && entity.permanents.has('class_noble')) {
    entity.life = Math.min(entity.lifeMax, entity.life + lifestealForMe.amount);
  }
  // Effect heals (Drain, Turn Life) land the same way: after my damage, capped, never on a corpse.
  if (healForMe > 0 && entity.life > 0) entity.life = Math.min(entity.lifeMax, entity.life + healForMe);
  // general_ux_hitpoints_calculations: stat tokens and the bonus tile tokens under me shift
  // my life maximum by round((Σstats + Σtokens)/10) − round(Σstats/10); life follows the shift.
  if (entity.life > 0) {
    const base = Object.values(entity.stats).reduce((a, v) => a + (v || 0), 0);
    const extra = entity.statTokens.reduce((a, t) => a + t.value, 0)
      + [...view.values()].flatMap(v => parseJsonArr(v?.tile_tokens_json)).filter(t => t.kind === 'bonus' && t.q === entity.tile.q && t.r === entity.tile.r).reduce((a, t) => a + t.value, 0)
      + worldFeatureValueAt(view, entity.tile.q, entity.tile.r)
      + (entity.permanents.has('effect_spirit_link') ? entity.links.reduce((a, l) => a + Math.max(0, view.get(l.from)?.[`stat_${l.stat}`] ?? 0), 0) : 0);
    const newMax = Math.max(1, entity.lifeMaxBase + roundHalfUp10(base + extra) - roundHalfUp10(base) + (entity.armor || 0));
    if (newMax !== entity.lifeMax) {
      const delta = newMax - entity.lifeMax;
      entity.life = Math.max(1, Math.min(newMax, entity.life + delta));
      console.log(`[${PEER_LABEL}] life max ${entity.lifeMax} → ${newMax} (tokens ${extra >= 0 ? '+' : ''}${extra}), life ${entity.life}`);
      entity.lifeMax = newMax;
    }
  }
  if (wasAlive && entity.life <= 0) {
    console.log(`[${PEER_LABEL}] DIED at (${entity.tile.q},${entity.tile.r}) after -${myDmg} on T${hg.turn}.R${hg.round + 1} (life_max=${entity.lifeMax})`);
  }
  // Permanents land in the NEXT round's snapshot, so they take effect from
  // then on — the reveal that placed them embedded the pre-placement state.
  const permsBefore = permanentsCsv();
  const myR = byActor.get(PEER_ID_STRING);
  // Sanctuary lasts while I rest: declaring anything but the plain Empty
  // Posture — another action, a trance, or a skill riding on the EP — ends it
  // from the next round (damage this round was already judged on the EP).
  const leftSanctuary = myR && ((myR.declared ?? myR.action) !== 'EP' || (myR.skills || []).length > 0 || !!myR.effect);
  if (leftSanctuary) entity.permanents.delete('skill_sanctuary');
  if (brokenShield) { entity.permanents.delete('skill_force_shield'); delete entity.permPower.skill_force_shield; console.log(`[${PEER_LABEL}] force shield spent`); }
  const playedCodes = myR?.trance ? new Set([...myR.played].map(i => myR.trance[i])) : null;
  for (const id of myLastReveal?.skillIds || []) {
    const sd = data.skills[id]?.data;
    if (sd?.is_permanent && (!playedCodes || playedCodes.has(sd.action_type))) {
      entity.permanents.add(id);
      // Rule 12: a permanent is placed with a point-buy of its stat; the highest
      // die is its power (what Rule 24 must beat; what Force Shield spends).
      const st = sd.point_buy_stat === 'any'
        ? ['vitality', 'world', 'matter', 'will'].sort((a, b) => entity.stats[b] - entity.stats[a])[0]
        : (sd.point_buy_stat || 'stat_vitality').replace(/^stat_/, '');
      entity.permPower[id] = pointBuyPermanent(entity.stats[st] ?? 0, `${myLastReveal.salt}:perm:${id}:${hg.action}`, sha256Hex);
      console.log(`[${PEER_LABEL}] permanent ${id} up: die ${entity.permPower[id]} (${st} ${entity.stats[st]})`);
    }
  }
  // Publish immediately so the browser UI sees damage / movement at reveal
  // time, not only after cleanup fires a few seconds later.
  const effectStateChanged = healForMe > 0 || effectOutcomes.length > 0 || tokensSpent.length > 0 || counterPen.has(PEER_ID_STRING) || destroyOutcomes.length > 0 || classOutcomes.length > 0 || blessFired.length > 0 || Object.values(classAbilityOut).some(l => l.length > 0);
  if (myMove || myDmg || permsBefore !== permanentsCsv() || effectStateChanged) await publishPublicState();

  // Deterministic state hash over the revealers' post-resolution state: the
  // view's tiles with this round's moves applied and this round's damage
  // taken off. Every peer that saw the same reveals computes the same bytes,
  // so a mismatch between two peers' hashes for the same action means their
  // inputs differed — and `region` lets the receiver say for which entity.
  const regionState = revealsThisTurn
    .map(r => view.get(r.actor))
    .filter(Boolean)
    .map(p => {
      const t = nextTiles.get(p.peer_id) || { q: p.tile_q, r: p.tile_r };
      return { id: p.peer_id, tile: [t.q, t.r], life: Math.max(0, (p.life ?? 0) - sumDmg(damage.get(p.peer_id))) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const stateHash = digestObj(regionState);
  lastStateHashes.set(hg.action, { hash: stateHash, region: regionState });
  if (lastStateHashes.size > 8) lastStateHashes.delete(Math.min(...lastStateHashes.keys()));
  // Per-actor action summary so the UI can float an action icon (⚔️ / 🛡 / 🤺
  // / 👁 / ➙) for every revealer this round, mirroring the damage-float path.
  // target_q/target_r are where the action aimed (tile target or defender's
  // tile) so the floater can lerp from actor → aim like damage does; omitted
  // for self-only actions (Block, Posture, Empty Posture).
  const actionSummary = [];
  // Which element (if any) the action pushes out this tick. The UI uses this
  // for the vanishing emit-badge overlay. Postures emit their effect's current
  // step; a Rule-24 destroy emits the primary element of the chosen stat; an
  // Attack/Move that emits (Reaver, Monk) falls back to the actor's adept
  // element. Everything else returns null and no badge is drawn.
  const emittedElementFor = (actorId, source) => {
    const eff = source?.effect;
    if (eff && Array.isArray(eff.elements) && eff.elements.length) {
      const step = Math.max(1, eff.step ?? 1);
      return eff.elements[Math.min(step, eff.elements.length) - 1] || null;
    }
    const d = source?.destroy;
    if (d && d.stat) {
      const statEntry = data.stats?.[`stat_${d.stat}`] || data.stats?.[d.stat];
      const list = statEntry?.data?.elements || statEntry?.elements;
      if (Array.isArray(list) && list.length) return list[0];
    }
    const act = source?.action;
    const trance = Array.isArray(source?.trance) ? source.trance : null;
    const anyEmit = (trance ? trance : [act]).some(c => c === 'P' || c === 'EP' || c === 'A' || c === 'M');
    if (!anyEmit) return null;
    const a = view.get(actorId);
    const srcId = a?.source_id || a?.character_id || a?.creature_id;
    const entry = srcId ? (data.characters?.[srcId] || data.creatures?.[srcId]) : null;
    return entry?.data?.adept_element || null;
  };
  for (const b of bonusRuns) {
    const actor = view.get(b.actor);
    if (!actor) continue;
    const bb = b.bonus;
    const aims = bb.action === 'A' || bb.action === 'M' || bb.action === 'EM' || !!(bb.effect && (bb.effect.is_damage || bb.effect.is_point_buy));
    const aim = aims ? tileOf(bb.target) : null;
    actionSummary.push({
      actor: b.actor, action: bb.action, declared: bb.action, skills: bb.skills || [], bonus: true, bonus_k: b.seq, pre: !!b.pre,
      effects: bb.effect ? [{ effect_id: bb.effect.effect_id, name: bb.effect.name, elements: bb.effect.elements || [] }] : [],
      emitted_element: emittedElementFor(b.actor, bb),
      trance: bb.trance || null, played: b.res.byActor.get(b.actor)?.played ? [...b.res.byActor.get(b.actor).played].sort() : null,
      from_q: actor.tile_q, from_r: actor.tile_r, target_q: aim?.q, target_r: aim?.r,
    });
  }
  for (const r of revealsThisTurn) {
    const actor = view.get(r.actor);
    if (!actor) continue;
    // A damaging effect aims at its target too, so the ✺ glyph flies there.
    const effAims = !!(r.effect && (r.effect.is_damage || r.effect.is_point_buy));
    const aims = effAims || (r.trance ? r.trance.some(c => c === 'A' || c === 'M' || c === 'EM') : (r.action === 'A' || r.action === 'M' || r.action === 'EM'));
    const aim = aims ? tileOf(r.target) : null;
    actionSummary.push({
      actor: r.actor, action: r.action, declared: r.declared ?? r.action, skills: r.skills || [],
      effects: r.effect ? [{ effect_id: r.effect.effect_id, name: r.effect.name, elements: r.effect.elements || [] }] : [],
      emitted_element: emittedElementFor(r.actor, r),
      trance: r.trance || null, played: r.trance ? [...r.played].sort() : null,
      from_q: actor.tile_q, from_r: actor.tile_r,
      target_q: aim?.q, target_r: aim?.r,
    });
  }
  await emitEnvelope({ type: 'evt_state_hash', payload: {
    state_hash: stateHash,
    region: regionState,
    damage_applied: [...damage.entries()].flatMap(([t, list]) => list.map(d => ({ target: t, amount: d.amount, attacker: d.attacker, source: d.source || 'action', bonus: !!d.bonus }))),
    bonus_rounds: bonusRuns.length,
    vanished: vanishedThisAction.splice(0),
    journey_results: [...journeyResults.entries()].map(([actor, j]) => ({ actor, ...j })),
    actions: actionSummary,
    tokens_changed: [],
  } });
}

function reshuffleIfEmpty() {
  if (deck.length || !discard.length) return;
  for (const c of discard.splice(0)) deck.push(c);
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
}

// End of one action: the played card leaves the hand (no draw yet — rule 10
// refills only at turn end), buffers reset, counters advance. Instants the
// resolver judged useless (`returnedCardIds`) stay in hand (Rule 8 pc override).
async function endRound() {
  const returned = new Set(myLastReveal?.returnedCardIds || []);
  const playedIds = new Set((myLastReveal?.skillCardIds || []).filter(id => !returned.has(id)));
  // Haste bonus round: its action card, skills and instant are spent too.
  for (const b of (myLastReveal?.bonus || []).slice(0, myLastReveal?.bonusUsed ?? 0)) for (const id of [b.cardId, b.extraCardId, ...b.skillCardIds, b.effectCardId]) if (id && !returned.has(id)) playedIds.add(id);
  for (const id of myPlayedCardIds || (myLastReveal?.cardId ? [myLastReveal.cardId] : [])) playedIds.add(id);
  // Archive marks: those cards go to the archive now — played or not — instead
  // of the discard pile. A card still mid-cast stays until the cast is over.
  if (willArchive.size) {
    const inCast = new Set(casting ? casting.entries.flatMap(e => [e.cardId, e.cardId2]).filter(Boolean) : []);
    const gone = [];
    for (let i = hand.length - 1; i >= 0; i--) {
      const c = hand[i];
      if (!willArchive.has(c.card_id) || inCast.has(c.card_id) || circulating() - 1 < DECK_MIN) continue;
      archiveCard(...hand.splice(i, 1)); willArchive.delete(c.card_id); gone.push(c.name || c.action_name || c.code);
    }
    if (gone.length) console.log(`[${PEER_LABEL}] archived: ${gone.join(', ')} (${archive.length} in the archive, ${circulating()} circulating)`);
    for (const id of willArchive) if (!inCast.has(id)) willArchive.delete(id);
  }
  for (let i = hand.length - 1; i >= 0; i--) {
    if (!playedIds.has(hand[i].card_id)) continue;
    const c = hand[i];
    // A permanent skill that took hold sits in the holding until it falls.
    if (c.kind === 'skill' && c.is_permanent && entity.permanents.has(c.skill_id)) heldCards.push(...hand.splice(i, 1));
    else discard.push(...hand.splice(i, 1));
  }
  // Effect cards (Rule 19/20): a complete cast leaves the hand whether it
  // landed, found nobody or was blocked — the elements are spent (permanents
  // already took hold via entity.permanents). One still emitting elements, or
  // one whose point-buy failed, carries on next action: the card stays and is
  // re-queued below. Only a no-benefit instant comes back (Rule 8 override).
  let carryOn = null;
  const dropCard = (cid) => { for (let i = hand.length - 1; i >= 0; i--) if (hand[i].card_id === cid) discard.push(...hand.splice(i, 1)); };
  if (myLastReveal?.effectCardId && myLastReveal.chain) {
    const r = myLastReveal, ch = r.chain;
    const retry = r.castStatus === 'retry';
    // A stat buy (Summoning) is paid when the bank covers the need — maybe before
    // the estimated last emission ('done' early), maybe after (still 'casting'
    // at the last one: the cast grows by an emission).
    const stillCasting = r.castStatus === 'casting';
    if (stillCasting && r.effectStep >= r.effectOf) { const at = chainAt(ch.entries, ch.step); if (at) { at.entry.len += 1; ch.total += 1; } }
    const complete = r.castStatus === 'done' || (r.effectStep >= r.effectOf && !stillCasting);
    // A completed entry leaves the hand (unless Rule 8 sent it back); a failed
    // point-buy re-emits the same element next action.
    if (complete && !retry && !returned.has(r.effectCardId)) {
      // A permanent that took hold keeps its card(s) in the holding; anything else is discarded.
      const held = r.castStatus === 'done' && (r.effectPermanent || !!EFFECT_RULES[r.effectId]?.permanent)
        && (entity.permanents.has(r.effectId) || (r.effectId === 'effect_possess_phylactery' && entity.possessing?.card_id === r.effectCardId));   // Possess stands in the possessed unit's holding; its card stays mine
      const leave = held ? holdCard : dropCard;
      leave(r.effectCardId); if (r.effectCardId2) leave(r.effectCardId2);
    }
    const emitted = retry ? ch.step - 1 : ch.step;
    if (r.castKept) { const at = chainAt(ch.entries, ch.step); if (at) at.entry.kept = r.castKept; }
    if ((emitted >= ch.total || (complete && ch.entries.length === 1)) && !retry) {
      casting = null;
      if (ch.aura) { dropPermanent('effect_aura'); console.log(`[${PEER_LABEL}] aura ∀ spent on ${ch.entries.map(e => e.effectId).join('→')}`); }
    } else {
      casting = { entries: ch.entries, emitted, aura: ch.aura };
      carryOn = true;
    }
  } else if (casting && !myLastReveal?.skipping) {
    // Rule 19: an interrupted cast fails and the remaining card(s) are discarded.
    console.log(`[${PEER_LABEL}] cast of ${casting.entries.map(e => e.effectId).join('→')} failed — card(s) discarded`);
    const ends = chainEnds(casting.entries);
    casting.entries.forEach((e, k) => { if (ends[k] > casting.emitted) { dropCard(e.cardId); if (e.cardId2) dropCard(e.cardId2); } });
    casting = null;
  }
  if (myLastReveal?.skipping && entity.lockList.length) { entity.lockList[0].n -= 1; syncLost(); }
  // Empower is spent by the double emission it paid for.
  if (myLastReveal?.empowered && entity.permanents.has('effect_empower')) { dropPermanent('effect_empower'); console.log(`[${PEER_LABEL}] empower spent`); }
  // Invisibility ends the moment I attack or emit; doubled (∀) it holds until I actually deal damage.
  if (entity.permanents.has('effect_invisibility') && myLastReveal) {
    const ends = entity.everyPerms.has('effect_invisibility') ? myLastReveal.dealtDamage : (myLastReveal.code === 'A' || myLastReveal.effectCardId);
    if (ends) dropPermanent('effect_invisibility');
  }
  queued = []; queuedSkills = []; queuedExtra = null; queuedEffect = null; queuedEffect2 = null; queuedChain = []; queuedAura = false; queuedDestroy = null; queuedAttach = null; queuedLink = null; queuedElem = null; queuedPhylactery = null; queuedBonus = []; queuedClassAbility = false; target = null; locked = false; myLastReveal = null; myPlayedCardIds = null;
  if (carryOn && casting) {
    // Re-queue the rest of the plan: the active entry first, the chain after it.
    const at = chainAt(casting.entries, casting.emitted + 1);
    const idx = (cid) => hand.findIndex(c => c.card_id === cid);
    const ei = at ? idx(at.entry.cardId) : -1;
    const ei2 = at?.entry.cardId2 ? idx(at.entry.cardId2) : -1;
    const pi = hand.findIndex(c => c.kind === 'action' && c.code === 'P');
    if (ei >= 0 && (!at.entry.every || ei2 >= 0)) {
      queuedEffect = ei; queuedEffect2 = ei2 >= 0 ? ei2 : null; queuedAura = !!casting.aura;
      queuedChain = casting.entries.slice(at.k + 1).map(e => idx(e.cardId)).filter(i => i >= 0);
      queued = [pi >= 0 ? pi : 'EMPTY'];
    } else casting = null;
  }

  hg.round += 1; hg.action += 1;
  if (hg.round >= ROUNDS_PER_TURN) await endTurn();
  else {
    broadcastUI(handMsg());
    // Push the new action to the mesh immediately — otherwise other peers
    // only hear about our advance at turn boundaries (every 3 rounds) or on
    // the 15s heartbeat, and the catch-up logic can't fire until it sees
    // the leader's updated `action`.
    publishPublicState().catch(() => {});
  }
}

// End of a turn (ROUNDS_PER_TURN actions): characters may discard the cards
// they flagged, everyone draws back to HAND_SIZE, and the slow-tier TurnCommit
// goes out. Monsters never discard leftovers (rule 7).
async function endTurn() {
  if (entity.kind === 'character' && willDiscard.size) {
    for (let i = hand.length - 1; i >= 0; i--) if (willDiscard.has(hand[i].card_id)) discard.push(...hand.splice(i, 1));
  }
  willDiscard.clear();
  const before = hand.length;
  // Haste ∀: one more card each turn.
  const handCap = HAND_SIZE + (entity.everyPerms.has('effect_haste') ? 1 : 0);
  while (hand.length < handCap) { reshuffleIfEmpty(); if (!deck.length) break; hand.push(deck.shift()); }

  // Guardian: static ability — "when you stay on one tile for a whole round
  // (= one turn here) restore one life token" (paper Rule 9 + class_guardian).
  // movedThisRound is set true by the resolver whenever my own tile changed;
  // reset after the check so the next turn's bookkeeping is clean. Dead
  // characters do not regen.
  if (entity.classFlags && entity.permanents.has('class_guardian') && !entity.classFlags.movedThisRound && entity.life > 0) {
    entity.life = Math.min(entity.lifeMax, entity.life + 1);
  }
  if (entity.classFlags) entity.classFlags.movedThisRound = false;

  hg.round = 0; hg.turn += 1;
  // Turn-scoped effect state (paper "until end of round") expires now.
  entity.elemPen = entity.elemPen.filter(x => x.until_turn >= hg.turn);
  entity.shieldElems = entity.shieldElems.filter(x => x.permanent || x.until_turn >= hg.turn);
  for (const [id, until] of Object.entries(entity.permUntil)) if (until < hg.turn) { dropPermanent(id); console.log(`[${PEER_LABEL}] permanent ${id} expires with the turn`); }
  entity.disables = entity.disables.filter(d => d.until_turn >= hg.turn);
  activeZones = activeZones.filter(z => z.until_turn >= hg.turn);
  await publishPublicState();
  await emitEnvelope({
    type: 'evt_turn_commit',
    payload: {
      turn: hg.turn,
      region_state_hash: hg.tape.filter(e => e.type === 'evt_state_hash').at(-1)?.payload.state_hash || '',
      positions: Object.fromEntries([...peersPublic.values()].map(p => [p.peer_id, { q: p.tile_q, r: p.tile_r }])),
      hashgraph_head: hg.head,
      draws: [{ peer_id: PEER_ID_STRING, cards_drawn: hand.length - before }],
    },
  });
  broadcastUI(handMsg({ turn_end: true }));
}

async function npcPlan() {
  const enemies = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && sideOf(p.alliance) !== MY_SIDE && p.life > 0);
  // Summoned / bound: follow the owner — close the gap first, fight only what is in reach.
  const owner = ownerPeerId ? peersPublic.get(ownerPeerId) : null;
  if (owner && Number.isInteger(owner.tile_q) && (owner.life ?? 1) > 0) {
    const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
    const dOwner = hexDistance(here, owner);
    const near = enemies.filter(p => hexDistance(here, p) <= 1);
    if (dOwner > 1 && !near.length) {
      const occ = new Set(livePeers().filter(p => p && p.life > 0 && p.peer_id !== PEER_ID_STRING).map(p => `${p.tile_q},${p.tile_r}`));
      const spot = hexNeighbours(owner.tile_q, owner.tile_r).filter(t => dimMap.has(t.q, t.r) && !occ.has(`${t.q},${t.r}`)).sort((a, b) => hexDistance(here, { tile_q: a.q, tile_r: a.r }) - hexDistance(here, { tile_q: b.q, tile_r: b.r }))[0];
      const mi = hand.findIndex(c => c.code === 'M');
      queued = mi >= 0 && hexDistance(here, { tile_q: spot?.q ?? owner.tile_q, tile_r: spot?.r ?? owner.tile_r }) <= 1 ? [mi] : ['EMPTY'];
      queuedSkills = []; queuedExtra = null;
      target = spot ? { q: spot.q, r: spot.r } : { q: owner.tile_q, r: owner.tile_r };
      return;
    }
    if (!near.length) { const pi = hand.findIndex(c => c.code === 'P' || c.code === 'B'); queued = pi >= 0 ? [pi] : ['EMPTY']; queuedSkills = []; queuedExtra = null; target = null; return; }
  }
  if (!enemies.length) { queued = []; queuedSkills = []; queuedExtra = null; target = null; return; }
  enemies.sort((a, b) => hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, a) - hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, b));
  const nearest = enemies[0];
  const d = hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, nearest);
  const WEIGHTS = (entity.life <= 1 && entity.lifeMax > 1) ? { B: 0.6, M: 0.3, A: 0.1 } : d <= 1 ? { A: 0.5, P: 0.3, M: 0.2 } : { M: 0.7, P: 0.3, A: 0.0 };
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  let r = Math.random() * total, pick = 'A';
  for (const [k, w] of Object.entries(WEIGHTS)) { r -= w; if (r <= 0) { pick = k; break; } }
  const slot = hand.findIndex(c => c.code === pick);
  queued = slot >= 0 ? [slot] : ['EMPTY'];
  // No card for the pick → the Empty slot, which still carries Move / Posture
  // skills. Wanted to move but hold no M card → Empty Move toward the enemy's
  // hex (a character target would make the Empty slot a Posture and the
  // monster would stand still for the whole fight).
  const emptyMove = slot < 0 && pick === 'M' && d > 1;
  const ridesPick = c => slot >= 0 ? c.requires === pick : (c.requires === 'M' || c.requires === 'P');
  queuedSkills = hand.map((c, i) => c.kind === 'skill' && !c.is_trance && ridesPick(c) ? i : -1).filter(i => i >= 0);
  queuedExtra = null;
  const tranceIdx = hand.findIndex(c => c.is_trance);
  const others = hand.map((c, i) => c.kind === 'action' && i !== slot ? i : -1).filter(i => i >= 0);
  if (slot >= 0 && tranceIdx >= 0 && others.length && Math.random() < 0.35) {
    queuedSkills.push(tranceIdx);
    const diff = others.find(i => hand[i].code !== pick);
    queuedExtra = diff ?? null;
  }
  target = emptyMove ? { q: nearest.tile_q, r: nearest.tile_r } : nearest.peer_id;
}

// Our own state hash per action, kept briefly so an incoming evt_state_hash
// for the same action can be compared and a divergence named entity by entity.
const lastStateHashes = new Map();   // action -> { hash, region }
let divergenceCount = 0;
function checkStateHash(env) {
  const k = actionKey(env.turn, env.round);
  const mine = lastStateHashes.get(k);
  if (!mine || !env.payload?.state_hash || mine.hash === env.payload.state_hash) return;
  const theirs = new Map((env.payload.region || []).map(e => [e.id, e]));
  const diffs = [];
  // Regions differ legitimately (their strong set is centred on them), so a
  // different hash only counts as divergence when an entity BOTH of us
  // resolved came out differently.
  for (const e of mine.region) {
    const t = theirs.get(e.id);
    if (!t) continue;
    if (t.tile[0] !== e.tile[0] || t.tile[1] !== e.tile[1] || t.life !== e.life) diffs.push(`${e.id}: ours (${e.tile}) hp${e.life} vs theirs (${t.tile}) hp${t.life}`);
  }
  if (!diffs.length) return;
  divergenceCount++;
  console.warn(`[${PEER_LABEL}] STATE DIVERGENCE #${divergenceCount} T${env.turn}.R${env.round + 1} vs ${env.actor_peer_id}: ${diffs.join('; ')}`);
}

function inboxApply(env) {
  if (env.type === 'evt_state_hash') checkStateHash(env);
  if (env.type === 'evt_map_extend' && env.payload?.block) addMapBlock(env.payload.block, 'envelope');
  if (env.type === 'evt_map_sync' && Array.isArray(env.payload?.blocks) && env.payload.seed === MAP_SEED) {
    let n = 0; for (const b of env.payload.blocks) if (addMapBlock(b, `sync from ${env.actor_peer_id}`)) n++;
    if (n) console.log(`[${PEER_LABEL}] map sync from ${env.actor_peer_id}: +${n} blocks → ${dimMap.size()} hexes`);
  }
  if (env.type === 'evt_action_commit') noteSeen(commitsSeen, env);
  if (env.type === 'evt_action_reveal') noteSeen(revealsSeen, env);
  // Vision (hand): the enemy I looked at shows me their cards — a popup for my UI only.
  if (env.type === 'evt_peek' && env.payload?.for_peer === PEER_ID_STRING && Array.isArray(env.payload.cards)) {
    const what = env.payload.what === 'deck' ? 'deck' : 'hand', who = env.payload.name || env.actor_peer_id;
    const list = env.payload.cards.map(c => c.name).join(', ') || 'nothing';
    const label = what === 'deck' ? `Prophet: the top ${env.payload.cards.length} of ${who}'s deck — ${list}.` : env.payload.partial ? `Avenger: ${who} shows ${list}.` : `Vision: ${who} holds ${list}.`;
    console.log(`[${PEER_LABEL}] peek: ${env.actor_peer_id.slice(0, 14)}'s ${what}${env.payload.partial ? ' (part)' : ''} — ${list}`);
    broadcastUI({ kind: 'peek', what, of: env.actor_peer_id, of_name: who, cards: env.payload.cards, text: label });
  }
}
// A look reached me: publish my whole hand (Vision), `n` random hand cards (Avenger) or the top `n` of my
// deck (Prophet) for the looker — names only, enough to read the next action.
async function publishPeek(to, { what = 'hand', n = null } = {}) {
  const wire = c => ({ name: c.name || c.action_name || c.card_id, kind: c.kind, code: c.code || null, effect_id: c.effect_id || null, skill_id: c.skill_id || null });
  let cards;
  if (what === 'deck') { reshuffleIfEmpty(); cards = deck.slice(0, n || 5).map(wire); }
  else if (n && n < hand.length) { const pool = [...hand]; cards = []; while (cards.length < n && pool.length) cards.push(wire(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])); }
  else cards = hand.map(wire);
  console.log(`[${PEER_LABEL}] peek: I show ${what === 'deck' ? `the top ${cards.length} of my deck` : `${cards.length} card(s) of my hand`} to ${to.slice(0, 14)}`);
  await emitEnvelope({ type: 'evt_peek', payload: { for_peer: to, name: entity.name, cards, what, partial: what === 'hand' && cards.length < hand.length }, viaBus: true });
}

// -------- join sync --------
// Reveals are matched by turn number, so a peer that boots into a running
// Dimension must adopt the mesh's clock or it will never see anyone's reveal
// for "its" turn. Take the most-advanced live peer as the reference.
// Peer snapshots arrive over the bus (every peer republishes within 15s, the
// relay replays the last two minutes on subscribe), Gun and the optional
// discovery mirror — all land in peersPublic. Wait briefly for the first one.
const JOIN_SYNC_WAIT_MS = Number(process.env.JOIN_SYNC_WAIT_MS || 6000);
const JOIN_SYNC_SETTLE_MS = Number(process.env.JOIN_SYNC_SETTLE_MS || 1500);
async function syncClockFromMesh() {
  const t0 = Date.now();
  const actOf = s => typeof s.action === 'number' ? s.action : actionKey(s.turn, s.round || 0);
  // Keep listening until the roster stops growing (quiet for JOIN_SYNC_SETTLE_MS):
  // resolving the first round with half the entities in view puts movers on
  // hexes everyone else considers occupied → a one-round state divergence.
  let others = [], lastGrowth = t0;
  while (Date.now() - t0 < JOIN_SYNC_WAIT_MS) {
    const now = livePeers().filter(p => p.peer_id !== PEER_ID_STRING && typeof p.turn === 'number');
    if (now.length > others.length) lastGrowth = Date.now();
    others = now;
    if (others.length && Date.now() - lastGrowth >= JOIN_SYNC_SETTLE_MS) break;
    await new Promise(r => setTimeout(r, 250));
  }
  if (!others.length) { console.log(`[${PEER_LABEL}] join sync: no live peers heard in ${JOIN_SYNC_WAIT_MS}ms, starting fresh at turn 0`); return; }
  others.sort((a, b) => (actOf(b) - actOf(a)) || ((b.phase_ends_at || 0) - (a.phase_ends_at || 0)));
  const ref = others[0];
  hg.action = actOf(ref);
  hg.turn = Math.floor(hg.action / ROUNDS_PER_TURN);
  hg.round = hg.action % ROUNDS_PER_TURN;
  // Only planning is safe to drop into: the handshake phases assume we
  // committed. Joining mid-handshake means we sit this action out (rule 6).
  currentPhase = ref.phase === 'planning' ? 'planning' : 'resolution';
  phaseEndsAt = (typeof ref.phase_ends_at === 'number' && ref.phase_ends_at > Date.now()) ? ref.phase_ends_at : Date.now();
  roundDeadline = currentPhase === 'planning' ? phaseEndsAt : Date.now();
  console.log(`[${PEER_LABEL}] join sync: adopted turn ${hg.turn} round ${hg.round} / ${currentPhase} from ${ref.peer_id} (${others.length} live peers heard after ${Date.now() - t0}ms)`);
  await publishPublicState(true);
}
await syncClockFromMesh();

// -------- phase ticker --------
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // Continuous drift correction. If any peer is already past our action,
    // forfeit this one and drop into planning for the leader's action — then
    // let the next tick run the handshake with them in step. Without this
    // check the lagged peer only noticed at the end of its own resolution,
    // which meant a stable "one round behind forever" state once drift
    // slipped past a single phase.
    if (catchUpClock()) {
      currentPhase = 'planning';
      phaseEndsAt = roundDeadline;
      broadcastUI({ kind: 'phase', name: 'planning', seconds: Math.max(0, Math.round((phaseEndsAt - Date.now()) / 100) / 10), heartbeat: anyAdjacentOpponents(), turn: hg.turn, round: hg.round, rounds_per_turn: ROUNDS_PER_TURN });
      broadcastUI(handMsg());
      await publishPublicState();
      return;
    }
    const expired = Date.now() >= phaseEndsAt;
    if (currentPhase === 'planning') {
      if (!expired) return;
      await doPlanningEnd();
      enterPhase('reveal');
    } else if (currentPhase === 'reveal') {
      // Reveal once everyone has committed (so nobody adapts to an early
      // reveal), or when the cap expires and stragglers are treated as EP.
      if (!allIn(commitsSeen)) await pullFromDiscovery('commits', commitsSeen);
      if (!allIn(commitsSeen) && (!expired || waitingOnBusyMember(commitsSeen, 'planning'))) return;
      await doReveal();
      enterPhase('resolution');
    } else if (currentPhase === 'resolution') {
      if (!allIn(revealsSeen)) await pullFromDiscovery('reveals', revealsSeen);
      if (!allIn(revealsSeen) && (!expired || waitingOnBusyMember(revealsSeen, 'reveal'))) return;
      await doResolution();
      await endRound();
      checkStandoff();
      catchUpClock();
      enterPhase('planning');
      // Publish AFTER entering planning so everyone sees our real phase and
      // deadline for the new action (endRound's publish still says
      // 'resolution'); waitingOnBusyMember on the other peers depends on it.
      await publishPublicState();
    }
  } finally { ticking = false; }
}
setInterval(() => tick().catch(e => console.error(`[${PEER_LABEL}]`, e)), 100);

// "Game over" is a state of the Dimension, not the end of the process. When
// one side is wiped out we tell the UI, but rounds keep ticking (NPCs with no
// enemies just play Empty Posture) so that a player joining later on the
// losing side finds the survivors on the live clock and the fight resumes.
let standoff = null;   // winning alliance while only one side is alive, else null
function checkStandoff() {
  const alive = livePeers().filter(p => p && p.life > 0);
  const sides = new Set(alive.map(a => sideOf(a.alliance)));
  const now = sides.size <= 1 ? (alive[0]?.alliance || 'nobody') : null;
  if (now === standoff) return;
  standoff = now;
  if (now) { console.log(`[${PEER_LABEL}] standoff: only ${now} remains — waiting for challengers`); broadcastUI({ kind: 'standoff', winner: now }); }
  else      { console.log(`[${PEER_LABEL}] standoff over — a challenger has arrived, fight resumes`); broadcastUI({ kind: 'standoff', winner: null }); }
}

// Dimension-wide clock rule (sync_turn_commit.turn_counter_rule): the turn is
// the max seen; a peer that is behind jumps forward, forfeiting the skipped
// actions as Empty Posture. Called from the tick loop every 100ms so drift
// never accumulates past a single tick — a single catchUp at round end only
// fired at the slowest point in the cycle (resolution → planning) and let
// drift up to a full round build up between runs.
function catchUpClock() {
  let ref = null;
  for (const p of livePeers()) {
    if (p.peer_id === PEER_ID_STRING || typeof p.action !== 'number') continue;
    if (p.action > hg.action && (!ref || p.action > ref.action)) ref = p;
  }
  if (!ref) return false;
  const skipped = ref.action - hg.action;
  // Ratchet guard: if we're only one action behind and already mid-handshake
  // (reveal or resolution) for our current action, DON'T jump. The handshake
  // is seconds away from completing; letting it finish runs doResolution,
  // which is the only place `entity.tile` and `entity.life` update locally.
  // Jumping instead forfeits the current pick and leaves our own entity state
  // frozen, so other peers see us stuck while our browser renders mid-slide —
  // the "hero dancing / stuck in place" symptom. endRound at the natural
  // tail of this handshake will land us at ref.action with no drift.
  if (skipped === 1 && (currentPhase === 'reveal' || currentPhase === 'resolution')) return false;
  // One behind while planning: only a member of OUR strong region counts as
  // evidence that we are late. Such a member waits for our commit, so if it
  // is already planning the next action it resolved this one without us —
  // we are a full round behind and every reveal we send lands in a round the
  // others have closed (Swarm-0958: a joiner stayed one action behind for six
  // rounds, forfeited every round, split the hashes, and held the others at
  // 8.4 s rounds while their caps waited on it). A far peer one ahead is not
  // evidence of anything — a lone explorer with an empty region closes its
  // rounds the instant its deadline passes and must not pace the dimension.
  if (skipped === 1) {
    const strong = new Set(expectedMembers());
    const ahead = livePeers().find(p => p.peer_id !== PEER_ID_STRING && p.action === hg.action + 1 && strong.has(p.peer_id));
    if (!ahead) return false;
    ref = ahead;
  }
  const oldTurn = hg.turn;
  hg.action = ref.action;
  hg.turn = Math.floor(hg.action / ROUNDS_PER_TURN);
  hg.round = hg.action % ROUNDS_PER_TURN;
  // Forfeit any in-flight pick for the old action. The handshake buffers
  // (commitsSeen / revealsSeen) are keyed by action so they'll just be
  // ignored once we move past them.
  queued = []; target = null; locked = false; myLastReveal = null;
  // Crossed a turn boundary (ROUNDS_PER_TURN actions)? Refill the hand up to
  // HAND_SIZE and clear the discard-flag set so the player isn't stuck with a
  // depleted hand after a jump. Monsters never discard leftovers, so skip the
  // willDiscard clear for them (willDiscard is only populated for characters).
  if (hg.turn > oldTurn) {
    willDiscard.clear();
    while (hand.length < HAND_SIZE) { reshuffleIfEmpty(); if (!deck.length) break; hand.push(deck.shift()); }
  }
  // Align the new planning deadline with the reference peer's. If ref is
  // still in planning, use their deadline so the handshakes overlap. If ref
  // is already past planning for this action, give ourselves a short 1s
  // declaration window so the next tick we fall into the handshake with
  // them rather than being granted a full 6s and immediately drifting again.
  // Align with the LATEST planning deadline anyone holds for this action, so
  // we land in the same window as the whole cohort rather than just the ref;
  // nobody ahead of us is still planning → short window, they are waiting.
  let latest = 0;
  for (const p of livePeers()) {
    if (p.peer_id === PEER_ID_STRING || p.action !== hg.action || p.phase !== 'planning') continue;
    if (typeof p.phase_ends_at === 'number' && p.phase_ends_at > latest) latest = p.phase_ends_at;
  }
  roundDeadline = Math.max(latest, Date.now() + 2000);
  console.log(`[${PEER_LABEL}] clock catch-up: +${skipped} action(s) to turn ${hg.turn} round ${hg.round} (from ${ref.peer_id}, ref.phase=${ref.phase})`);
  return true;
}

// -------- Radicle: publish my Door into the dimension --------
// There is no host and no lottery. Every peer periodically commits *its own
// Door* — its piece of the dimension puzzle: what it knows from where it
// stands (its entity, the live clock, the members and tiles it has seen) and
// how to reach it — under ActiveDimensions/<dim>/doors/<peer>.json in its own
// Radicle namespace (rad://<RID>/<my NID>). Peers that met on the hex map have
// seen the same things, so their Doors overlap and agree; a newcomer lists
// every namespace on the seed and unions the Doors to see the whole picture,
// then walks in through whichever Door it picks. dimension.json is written
// with deterministic content so every Door carries an identical copy.
const DOOR_FILE = PEER_LABEL.replace(/[^A-Za-z0-9_.-]/g, '-');
let doorCount = 0;
function buildDoor(now) {
  const radRepo = radicleEnv.enabled ? `rad:${radicleEnv.rid}` : 'rad:local-bare';
  const members = livePeers().filter(p => p && p.peer_id);
  const bootstrap = new Set(); const gunRelays = new Set(); const relays = new Set(DEFAULT_RELAYS);
  for (const p of members) {
    for (const a of (p.multiaddrs_csv || '').split(',').filter(Boolean)) bootstrap.add(a);
    if (p.gun_url) gunRelays.add(p.gun_url);
    for (const r of (p.nostr_relays_csv || '').split(',').filter(Boolean)) relays.add(r);
  }
  const tiles = [...knownTiles.entries()].map(([k, t]) => { const [q, r] = k.split(',').map(Number); return { q, r, seen_at: new Date(t).toISOString() }; });
  const mapBounds = dimMap.bounds();
  const dimensionDoc = {
    dimension_id: DIM_ID, dimension_name: DIM_NAME, radicle_repo: radRepo,
    radicle_branch: `ActiveDimensions/${DIM_NAME}`,
    game_mode: 'mode_mmorpg', description: 'Micro-dimension sandbox',
    tileset: {
      initial_size: `${INITIAL_SIZE}x${INITIAL_SIZE}`, coordinates: 'axial q,r (x=q, y=r)',
      bounds: { min_x: mapBounds.min_q, min_y: mapBounds.min_r, max_x: mapBounds.max_q, max_y: mapBounds.max_r },
      map_seed: MAP_SEED, reveal_radius: REVEAL_RADIUS, tiles_known: dimMap.size(),
      extended_blocks: dimMap.blocks().filter(b => b.kind !== 'rect').map(b => ({ door_id: b.by || null, origin: { x: b.q, y: b.r }, size: `disc r=${b.radius}`, seed: MAP_SEED, at: b.at || null })),
    },
    clock: { rounds_per_turn: ROUNDS_PER_TURN, round_seconds: ROUND_SEC },
    layout: { doors: 'doors/<peer>.json — one Door per player (their piece of the puzzle), each in the player\'s own Radicle namespace; union them for the full picture' },
    join: { command: 'node game/join.mjs', placements: ['nearby', 'random'], note: 'Reads doors/*.json across all namespaces, joins the Nostr bus for the dimension id, and dials any Door\'s libp2p address that happens to be reachable.' },
  };
  const door = {
    door_version: 2, door_id: PEER_ID_STRING,
    dimension_id: DIM_ID, dimension_name: DIM_NAME,
    peer_id: PEER_ID_STRING, name: entity.name, alliance: entity.alliance,
    character_id: CHARACTER_ID || null, creature_id: CREATURE_ID || null,
    tile: { q: entity.tile.q, r: entity.tile.r }, life: entity.life, life_max: entity.lifeMax,
    hashgraph_head: hg.head || '',
    clock: { turn: hg.turn, round: hg.round, action: hg.action, rounds_per_turn: ROUNDS_PER_TURN, round_seconds: ROUND_SEC, phase: currentPhase, phase_ends_at: phaseEndsAt, at: now },
    known_members: members.map(p => ({ peer_id: p.peer_id, name: p.name, alliance: p.alliance, character_id: p.character_id, creature_id: p.creature_id, tile: { q: p.tile_q, r: p.tile_r }, life: p.life, life_max: p.life_max, last_seen: p.last_seen })),
    known_tiles: tiles,
    // The map as this peer holds it: joiners union every Door's blocks and
    // start with the whole revealed world instead of just the initial block.
    map: { seed: MAP_SEED, reveal_radius: REVEAL_RADIUS, tiles_known: dimMap.size(), bounds: mapBounds, blocks: dimMap.blocks() },
    network: {
      nostr: { relays: [...relays], pubkey: bus?.pubkey || null, kind: 29517, tag: `chaosd6:${DIM_ID}` },
      libp2p: { multiaddrs: myMaddrs, topic: TOPIC_STRONG, bootstrap: [...bootstrap] },
      gun: { url: myGunUrl, relays: [...gunRelays] },
    },
    radicle: { repo: radRepo, namespace: radicleEnv.enabled ? radicleEnv.nid : null, branch: `ActiveDimensions/${DIM_NAME}` },
    pushed_at: now,
  };
  return { dimensionDoc, door };
}
async function publishDoor() {
  doorCount++;
  try {
    const now = new Date().toISOString();
    const { dimensionDoc, door } = buildDoor(now);
    const r = await pushDimension(PEER_ID_STRING, DIM_NAME, {
      [`ActiveDimensions/${DIM_NAME}/dimension.json`]: dimensionDoc,
      [`ActiveDimensions/${DIM_NAME}/doors/${DOOR_FILE}.json`]: door,
    }, [
      // Leftovers from the host-era layout (single door written by the lottery winner).
      `ActiveDimensions/${DIM_NAME}/doors/door-primary.json`,
      `ActiveDimensions/${DIM_NAME}/rules_snapshot_commit`,
    ]);
    if (r.pushed) {
      const uiPort = process.env.UI_PORT || 7357;
      const localUrl = `http://127.0.0.1:${uiPort}/commit/${r.commit}`;
      const explorerUrl = r.explorerUrl || null;
      const treeUrl = r.treeUrl || null;
      const remoteNote = r.remote?.published ? '' : ` (remote: ${r.remote?.reason || 'skipped'})`;
      console.log(`[${PEER_LABEL}] door #${doorCount} → ${r.commit.slice(0, 10)} on ${r.branch}${remoteNote}`);
      console.log(`[${PEER_LABEL}]   commit: ${explorerUrl || localUrl}`);
      if (treeUrl) console.log(`[${PEER_LABEL}]   tree:   ${treeUrl}`);
      broadcastUI({ kind: 'radicle', commit: r.commit, branch: r.branch, url: explorerUrl || localUrl, localUrl, explorerUrl, treeUrl, published: !!explorerUrl });
      await emitEnvelope({ type: 'evt_radicle_push', payload: { door: DOOR_FILE, commit: r.commit, head_pushed: hg.head || '', explorer_url: explorerUrl, tree_url: treeUrl } });
    }
  } catch (e) { console.warn(`[${PEER_LABEL}] door push failed: ${e.message.split('\n')[0]}`); }
}
// Stagger so several peers in one clone don't all hit the bare repo at once
// (pushDimension retries on a lost race anyway).
setTimeout(() => { publishDoor().catch(() => {}); setInterval(() => publishDoor().catch(() => {}), RADICLE_PUSH_SEC * 1000); }, 5_000 + Math.floor(Math.random() * 10_000));

// -------- browser UI socket --------
const uiHttp = http.createServer(async (req, res) => {
  if (IS_COMPANION && req.url === '/summon-hold') { ownerHoldAt = Date.now(); res.writeHead(204); return res.end(); }
  if (IS_COMPANION && req.url === '/summon-release') { res.writeHead(204); res.end(); vanish('the permanent that held me is gone'); return; }
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      peer_id: PEER_ID_STRING, dimension: DIM_NAME, phase: currentPhase, phaseEndsIn: Math.max(0, phaseEndsAt - Date.now()),
      entity, permanents_csv: permanentsCsv(), hand, queued, queued_skills: queuedSkills, queued_extra: queuedExtra, queued_effect: queuedEffect, queued_effect2: queuedEffect2, queued_chain: queuedChain, aura: queuedAura, target, locked, turn: hg.turn, round: hg.round, action: hg.action, head: hg.head,
      peers: peersForUI(),
      alliance: entity.alliance,
      map: { seed: MAP_SEED, reveal_radius: REVEAL_RADIUS, tiles: dimMap.size(), blocks: dimMap.blockCount(), bounds: dimMap.bounds() },
      region: { strong_radius: STRONG_RADIUS, reach_radius: REACH_RADIUS, em_max_steps: EM_MAX_STEPS, strong: expectedMembers() },
      multiaddrs: myMaddrs, gun_url: myGunUrl, nostr_pubkey: bus?.pubkey || null, bus: bus ? bus.stats() : null,
    }));
    return;
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: uiHttp });
wss.on('connection', (ws) => {
  uiClients.add(ws);
  ws.send(JSON.stringify({ kind: 'hello', peer_id: PEER_ID_STRING, alliance: entity.alliance, entity, hand, deck_count: deck.length, discard_count: discard.length, archive, archive_count: archive.length, will_archive: [...willArchive], held: heldCards.map(c => ({ card_id: c.card_id, name: c.name, perm: c.effect_id || c.skill_id })), deck_min: DECK_MIN, circulating: circulating(), dimension: DIM_NAME, door: DOOR_ID, turn: hg.turn, round: hg.round, rounds_per_turn: ROUNDS_PER_TURN, phase: currentPhase, phase_ends_in: Math.max(0, phaseEndsAt - Date.now()), peers: peersForUI(), map: mapSummary(), class_colours: Object.fromEntries(Object.keys(data.classes).map(id => [id, classColours(id)])), class_state: classStateForUI(), queued_class_ability: queuedClassAbility }));
  ws.on('message', (buf) => {
    try {
      const m = JSON.parse(buf.toString());
      if (m.kind === 'queue') {
        if (locked) return;
        // Rule 1 + Rule 7: one action card per turn. Accept at most one slot;
        // either a valid hand index or the Empty-type marker. 'EMPTY' is the
        // combined slot that resolves to EM when a tile target is set, EP
        // otherwise (rule 6: Empty Move is declared first). Historic 'EP' and
        // 'EM' are still accepted so older clients keep working.
        const picks = (m.slots || []).slice(0, 1).filter(s =>
          s === 'EMPTY' || s === 'EP' || s === 'EM' ||
          (typeof s === 'number' && s >= 0 && s < hand.length && hand[s].kind === 'action')
        );
        queued = picks;
        const isAct = c => c && c.kind === 'action';
        const primary = typeof picks[0] === 'number' ? picks[0] : null;
        const skillIdx = [...new Set((m.skills || []).filter(i => typeof i === 'number' && hand[i]?.kind === 'skill'))];
        const tranceOn = skillIdx.some(i => hand[i].is_trance) && hand.some(isAct);
        queuedExtra = tranceOn && typeof m.extra === 'number' && m.extra !== primary && isAct(hand[m.extra]) ? m.extra : null;
        const codes = new Set();
        if (primary !== null) codes.add(hand[primary].code);
        // Move / Posture skills may ride on the Empty slot (Empty Move / Empty Posture).
        else if (picks.length) { codes.add('M'); codes.add('P'); }
        if (tranceOn) {
          if (queuedExtra !== null) codes.add(hand[queuedExtra].code);
          if (primary === null && queuedExtra === null) codes.add(hand.find(isAct).code);
          // No second card → the second option is EP, which carries Move / Posture skills.
          if (queuedExtra === null) { codes.add('M'); codes.add('P'); }
        }
        queuedSkills = skillIdx.filter(i => hand[i].is_trance ? tranceOn : (codes.size > 0 && codes.has(hand[i].requires)));
        // Rule 24 emission needs an emitting action; picking anything else drops the intent.
        if (queuedDestroy && (tranceOn || !(codes.has('P') || (isReaver() && codes.has('A')) || (isMonk() && codes.has('M'))))) queuedDestroy = null;
        // Rule 19: effects ride on a Posture / Empty-Posture. Instants may ride
        // on any action. Trance stays out of this pass — the resolver would
        // need per-trance-option emit tracking we don't yet have.
        const effectIdx = typeof m.effect === 'number' ? m.effect : -1;
        const eCard = hand[effectIdx];
        const effect2Idx = typeof m.effect2 === 'number' ? m.effect2 : -1;
        const e2 = hand[effect2Idx];
        const pair = !!(eCard && e2 && effect2Idx !== effectIdx && e2.kind === 'effect' && e2.effect_id === eCard.effect_id && e2.card_id !== eCard.card_id);
        const emitting = codes.has('P') || codes.has('EP') || (isReaver() && codes.has('A')) || (isMonk() && codes.has('M'));
        const allowed = (every) => eCard && eCard.kind === 'effect' && !tranceOn && (castInstant(eCard, every) || emitting);
        // Rule 23 ∀: two copies cast together; if the pair cannot ride this action, fall back to the single.
        queuedEffect2 = pair && allowed(true) ? effect2Idx : null;
        queuedEffect = allowed(queuedEffect2 !== null) ? effectIdx : null;
        // Rule 22: further effects chain on while each one's first element is the previous one's last.
        queuedChain = [];
        if (queuedEffect !== null && emitting && Array.isArray(m.chain)) {
          let tail = eCard;
          for (const i of m.chain) {
            const c = typeof i === 'number' ? hand[i] : null;
            if (!c || c.kind !== 'effect' || i === effectIdx || i === queuedEffect2 || queuedChain.includes(i) || !chainsOnto(tail, c)) break;
            queuedChain.push(i); tail = c;
          }
        }
        // A cast in progress keeps its active card as the queued effect; a pick
        // of another effect only counts as a joiner (same element going out).
        if (casting) {
          const at = chainAt(casting.entries, casting.emitted + 1);
          const activeIdx = at ? hand.findIndex(c => c.card_id === at.entry.cardId) : -1;
          if (activeIdx >= 0 && queuedEffect !== activeIdx) {
            const jn = joinableNow();
            const picked = queuedEffect !== null ? hand[queuedEffect] : null;
            queuedChain = jn && picked && chainsOnto(jn.tail, picked) ? [queuedEffect, ...queuedChain] : queuedChain;
            queuedEffect = activeIdx; queuedEffect2 = at.entry.cardId2 ? hand.findIndex(c => c.card_id === at.entry.cardId2) : null;
            if (queuedEffect2 === -1) queuedEffect2 = null;
          }
        }
        queuedAura = !!m.aura && queuedEffect !== null && entity.permanents.has('effect_aura') && entity.everyPerms.has('effect_aura');
        if (queuedEffect !== null && !casting) prepareSummon(hand[queuedEffect], queuedEffect2 !== null);

        broadcastUI(handMsg({ queued, queued_skills: queuedSkills, queued_extra: queuedExtra, queued_effect: queuedEffect, queued_effect2: queuedEffect2 }));
      }
      if (m.kind === 'target') {
        const t = m.target;
        if (typeof t === 'string') target = t;
        else if (t && typeof t === 'object' && typeof t.q === 'number' && typeof t.r === 'number') target = { q: t.q, r: t.r };
        else target = null;
        if (queuedEffect !== null && !casting && hand[queuedEffect]?.effect_id === RESURRECT) { prepareSummon(hand[queuedEffect], false); broadcastUI(handMsg()); }
      }
      if (m.kind === 'lock') { locked = true; }
      if (m.kind === 'bonus') {
        if (locked) return;
        const plans = Array.isArray(m.plans) ? m.plans.slice(0, bonusAllowance()) : [];
        queuedBonus = [];
        for (const pl of plans) {
          if (!pl) continue;
          const aIdx = Array.isArray(pl.slots) && typeof pl.slots[0] === 'number' ? pl.slots[0] : null;
          const aCard = aIdx !== null && hand[aIdx]?.kind === 'action' ? hand[aIdx] : null;
          const code = aCard ? aCard.code : 'EP';
          const picked = (Array.isArray(pl.skills) ? pl.skills : []).map(i => hand[i]).filter(c => c?.kind === 'skill');
          const tranceOn = picked.some(c => c.is_trance);
          const xCard = tranceOn && typeof pl.extra === 'number' && hand[pl.extra]?.kind === 'action' && pl.extra !== aIdx ? hand[pl.extra] : null;
          const codes = new Set([code, ...(tranceOn ? [xCard ? xCard.code : 'EP'] : [])]);
          const rides = (req) => [...codes].some(c => req === c || (c === 'EP' && req === 'P') || (c === 'EM' && req === 'M')) || (!aCard && (req === 'P' || req === 'M'));
          const skillIds = picked.filter(c => c.is_trance ? tranceOn : rides(c.requires)).map(c => c.card_id);
          const eCard = !tranceOn && typeof pl.effect === 'number' && hand[pl.effect]?.kind === 'effect' ? hand[pl.effect] : null;
          const tgt = typeof pl.target === 'string' || (pl.target && typeof pl.target === 'object' && Number.isInteger(pl.target.q) && Number.isInteger(pl.target.r)) ? pl.target : null;
          const destroy = ['vitality', 'world', 'matter', 'will'].includes(pl.destroy) ? pl.destroy : null;
          queuedBonus.push({ actionCardId: aCard?.card_id || null, extraCardId: xCard?.card_id || null, skillCardIds: skillIds, effectCardId: eCard?.card_id || null, target: tgt, destroy });
          if (destroy) queuedDestroy = null;   // the emission went into the bonus plan; the normal pick starts clean
        }
        if (queuedBonus.length) console.log(`[${PEER_LABEL}] bonus round(s) planned: ${queuedBonus.map(b => hand.find(c => c.card_id === b.actionCardId)?.code || 'EP').join(' → ')}`);
        broadcastUI(handMsg({ queued, queued_skills: queuedSkills, queued_extra: queuedExtra, queued_effect: queuedEffect, queued_effect2: queuedEffect2 }));
      }
      if (m.kind === 'destroy') {
        if (locked) return;
        const stat = ['vitality', 'world', 'matter', 'will'].includes(m.stat) ? m.stat : null;
        // Class strikes (m.class = enemy peer id, m.elem one of its colours' elements), recast / untap of my own
        // class (m.recast / m.untap) ride on the same emission (user ruling 2026-10-30).
        const cls = typeof m.class === 'string' && m.class !== PEER_ID_STRING ? m.class : null;
        const sameAs = (q) => !!q && q.stat === stat && (q.class || null) === cls && !!q.recast === !!m.recast && !!q.untap === !!m.untap;
        if (!stat || sameAs(queuedDestroy)) queuedDestroy = null;
        else {
          queuedDestroy = { stat, ...(cls ? { class: cls, elem: typeof m.elem === 'string' ? m.elem : null } : {}), ...(m.recast && entity.classArchived ? { recast: true } : {}), ...(m.untap && entity.classTapped && !entity.classArchived ? { untap: true } : {}) };
          const pi = hand.findIndex(c => c.kind === 'action' && c.code === 'P');
          queued = [pi >= 0 ? pi : 'EMPTY'];
          queuedSkills = queuedSkills.filter(i => hand[i]?.kind === 'skill' && !hand[i].is_trance && (hand[i].requires === 'P' || hand[i].requires === 'M'));
          queuedExtra = null;
          if (!entity.permanents.has('effect_aura')) { queuedEffect = null; queuedEffect2 = null; queuedChain = []; queuedAura = false; }
        }
        broadcastUI(handMsg({ queued, queued_skills: queuedSkills, queued_extra: queuedExtra, queued_effect: queuedEffect, queued_effect2: queuedEffect2 }));
      }
      if (m.kind === 'link') {
        // Spirit Link: the ally stat clicked in the unit list. Toggle.
        const ok = typeof m.peer_id === 'string' && ['vitality', 'world', 'matter', 'will'].includes(m.stat);
        queuedLink = ok && !(queuedLink && queuedLink.peer_id === m.peer_id && queuedLink.stat === m.stat) ? { peer_id: m.peer_id, stat: m.stat } : null;
        broadcastUI(handMsg({ queued_link: queuedLink }));
      }
      if (m.kind === 'elem') {
        // general_ux_tokens: the player clicked a stat / element for the token the queued cast will create. Toggle.
        const ok = typeof m.elem === 'string' && ELEM_TO_STAT[m.elem];
        queuedElem = ok && queuedElem !== m.elem ? m.elem : null;
        broadcastUI(handMsg({ queued_elem: queuedElem }));
      }
      if (m.kind === 'rebless') {
        // Blessing/Curse held: the effect card clicked replaces the one under it (old card to the discard pile,
        // user spec 2026-10-29). My own holding — published in channels_json, so every peer ticks the new one.
        const c = typeof m.slot === 'number' ? hand[m.slot] : null;
        const old = entity.channels.find(ch => ch.holder === 'effect_blessing_curse');
        if (!locked && c?.kind === 'effect' && entity.permanents.has('effect_blessing_curse') && old && EFFECT_RULES[c.effect_id] && !EFFECT_RULES[c.effect_id].blessAttach) {
          releaseHeldCard(old.card_id);
          entity.channels = entity.channels.filter(ch => ch !== old);
          entity.channels.push({ ...old, effect_id: c.effect_id, elements: [...c.element_cost], card_id: c.card_id, startedTurn: hg.turn, startedAction: hg.action });
          holdCard(c.card_id);
          console.log(`[${PEER_LABEL}] blessing now holds ${c.name} (the old card is discarded)`);
          publishPublicState().catch(() => {});
          broadcastUI(handMsg());
        }
      }
      if (m.kind === 'phylactery') {
        // Possess/Phylactery holder: the enemy permanent clicked in the unit list shatters at this action's end
        // (the Possess permanent is spent for it). Toggle.
        const ok = entity.permanents.has('effect_possess_phylactery') && typeof m.peer_id === 'string' && typeof m.perm === 'string' && !m.perm.startsWith('class_');
        queuedPhylactery = ok && !(queuedPhylactery && queuedPhylactery.peer_id === m.peer_id && queuedPhylactery.perm === m.perm) ? { peer_id: m.peer_id, perm: m.perm } : null;
        broadcastUI(handMsg({ queued_phylactery: queuedPhylactery }));
      }
      if (m.kind === 'class_ability') {
        // The class card clicked in the permanents strip: use its ability this action (user ruling 2026-10-30). Toggle.
        if (locked) return;
        queuedClassAbility = !queuedClassAbility && !!entity.classId && !entity.classArchived;
        broadcastUI(handMsg());
      }
      if (m.kind === 'attach') {
        // The effect card the queued effect works on (Traps Mastery's trap, Space Bending's alt trap). Toggle.
        const i = typeof m.slot === 'number' && hand[m.slot]?.kind === 'effect' ? m.slot : null;
        queuedAttach = (i === null || queuedAttach === i) ? null : i;
        broadcastUI(handMsg({ queued_attach: queuedAttach }));
      }
      if (m.kind === 'discard') {
        // Slot indices → card ids, so the marks survive the hand shrinking as
        // cards are played during the turn. Monsters never discard leftovers.
        willDiscard.clear();
        if (entity.kind === 'character') for (const i of m.slots || []) if (hand[i]) willDiscard.add(hand[i].card_id);
      }
      if (m.kind === 'archive') {
        // Toggle the archive mark on one hand card (characters only).
        const c = typeof m.slot === 'number' ? hand[m.slot] : null;
        let notice = null;
        if (!c || entity.kind !== 'character') notice = null;
        else if (willArchive.has(c.card_id)) willArchive.delete(c.card_id);
        else if (archiveRoom() <= 0) notice = `the deck may not drop below ${DECK_MIN} cards (${circulating() - willArchive.size} circulating)`;
        else { willArchive.add(c.card_id); notice = `${c.name || c.action_name || c.code} goes to the archive at this resolution`; }
        broadcastUI(handMsg(notice ? { notice } : {}));
      }
      if (m.kind === 'unarchive') {
        // An archived card goes back onto the discard pile (creature cards stay: they are summoned, not drawn).
        const i = archive.findIndex(c => c.card_id === m.card_id);
        let notice = null;
        if (i >= 0 && archive[i].kind !== 'creature') { const [c] = archive.splice(i, 1); discard.push(c); notice = `${c.name || c.action_name || c.code} returns from the archive to the discard pile`; console.log(`[${PEER_LABEL}] unarchived ${c.card_id}`); }
        broadcastUI(handMsg(notice ? { notice } : {}));
      }
      if (m.kind === 'uilog') {
        // Browser-side user input echo. Goes ONLY to the per-peer UI log
        // file (never to stdout / the console / the browser's event log) so
        // it doesn't drown out gameplay chatter. The pair lives next to the
        // regular peer log so you can `tail` both to reconstruct a timeline.
        const t = m.event || '?';
        const parts = [new Date().toISOString(), t];
        if (m.key) parts.push(`key=${m.key}`);
        if (m.button !== undefined) parts.push(`btn=${m.button}`);
        if (m.tile) parts.push(`tile=(${m.tile.q},${m.tile.r})`);
        if (m.phase) parts.push(`phase=${m.phase}`);
        if (m.locked !== undefined) parts.push(`locked=${m.locked}`);
        if (m.detail) parts.push(m.detail);
        writeUiLog(parts.join(' '));
      }
    } catch {}
  });
  ws.on('close', () => uiClients.delete(ws));
});
uiHttp.listen(PEER_PORT_HTTP, '127.0.0.1', () => {
  console.log(`[${PEER_LABEL}] UI socket on ws://127.0.0.1:${PEER_PORT_HTTP}/`);
});

// -------- fire evt_genesis & evt_join once on startup --------
await emitEnvelope({
  type: 'evt_genesis',
  payload: { dimension_id: DIM_ID, dimension_name: DIM_NAME, rules_snapshot_commit: 'local', tileset_size: `${INITIAL_SIZE}x${INITIAL_SIZE}`, map_seed: MAP_SEED, reveal_radius: REVEAL_RADIUS, owners: ['peer:player-1'] },
});
await emitEnvelope({
  type: 'evt_join',
  payload: {
    door_id: DOOR_ID, flow: ALLIANCE === 'player' ? 'open_dimension' : 'join_near_friend',
    character_id: CHARACTER_ID || null, creature_id: CREATURE_ID || null, class_id: null,
    deck_commitment: digestObj(deck.map(c => c.card_id)),
    entry_tile: entity.tile, adopted_head: null,
  },
});
await revealAround(entity.tile.q, entity.tile.r);
console.log(`[${PEER_LABEL}] map: seed ${MAP_SEED}, ${dimMap.size()} hexes in ${dimMap.blockCount()} blocks (reveal radius ${REVEAL_RADIUS})`);
await enterPhase('planning');

// Clean shutdown.
process.on('SIGINT', async () => { console.log(`[${PEER_LABEL}] shutting down`); for (const c of companions) { try { c.proc.kill(); } catch {} } try { await libp2p.stop(); } catch {} process.exit(0); });
