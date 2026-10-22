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

import Gun from 'gun';
import 'gun/sea.js';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

import { pushDimension, radicleEnv } from './radicle-adapter.mjs';
import { createNostrBus, DEFAULT_RELAYS } from './nostr-bus.mjs';
import { createKnownMap, initialBlock, discBlock, isBlock, seedForDimension, DEFAULT_REVEAL_RADIUS, INITIAL_SIZE } from './js/map.js';
import { stepToward as hexStepToward } from './js/hex.js';

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
  return { id: entry.id, name: entry.name, data: v.data };
}

const data = {};
for (const n of ['battle_system', 'actions', 'characters', 'creatures']) {
  const f = await loadJson(`${n}.json`);
  data[n] = Object.fromEntries(f.entries.map(e => [e.id, pickActive(e)]));
}

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
const gun = Gun({
  web: gunHttp,
  peers: PEER_GUN_URLS,              // mesh with the other peers' relays
  file: GUN_DIR,
  localStorage: false,
  axe: false,
  multicast: false,
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
const dialled = new Set();
const dialFailed = new Map();   // peerId string -> failures, to keep the log quiet
async function dialPeerAddrs(peerId, addrs) {
  for (const addr of addrs) {
    const theirPid = addr.split('/p2p/').at(-1);
    if (!theirPid || theirPid === libp2p.peerId.toString() || dialled.has(theirPid)) continue;
    try {
      await libp2p.dial(multiaddr(addr));
      dialled.add(theirPid);
      console.log(`[${PEER_LABEL}] libp2p mesh ↔ ${peerId} (${theirPid.slice(0, 14)}…)`);
    } catch (e) {
      const n = (dialFailed.get(theirPid) || 0) + 1;
      dialFailed.set(theirPid, n);
      if (n === 1) console.log(`[${PEER_LABEL}] no direct link to ${peerId} (${e.message.split('\n')[0].slice(0, 80)}) — using the bus`);
    }
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
  };
} else {
  const d = data.creatures[CREATURE_ID].data;
  const sum = d.stats.vitality + d.stats.world + d.stats.matter + d.stats.will;
  entity = {
    kind: 'creature', peerId: PEER_ID_STRING, name: ENTITY_NAME, alliance: ALLIANCE,
    tile: { ...START_TILE }, sourceId: CREATURE_ID, sourceName: data.creatures[CREATURE_ID].name,
    stats: { ...d.stats }, lifeMax: d.life, life: d.life, actionsPerRound: d.actions_per_round,
    innateEffect: d.innate_effect, dicePattern: d.dice_pattern, onActionRider: d.on_action_rider,
  };
}

// Deck + hand.
const basics = ['action_attack', 'action_block', 'action_move', 'action_posture'];
const deck = [];
if (entity.kind === 'character') {
  const combo = new Set(entity.combo || []);
  const codes = { action_attack: 'A', action_block: 'B', action_move: 'M', action_posture: 'P' };
  const counts = { A: 5, B: 5, M: 5, P: 5 };
  for (const c of combo) counts[c] = Math.min(7, counts[c] + 2);
  for (const b of basics) for (let i = 0; i < counts[codes[b]]; i++)
    deck.push({ card_id: `${b}#${randomBytes(3).toString('hex')}`, action_id: b, code: codes[b], action_name: data.actions[b].name });
} else {
  const push = (b, k) => deck.push({ card_id: `${b}#${randomBytes(3).toString('hex')}`, action_id: b, code: k, action_name: data.actions[b].name });
  if (entity.dicePattern) {
    const map = { A: 'action_attack', B: 'action_block', M: 'action_move', P: 'action_posture' };
    for (let i = 0; i < 20; i++) push(map[entity.dicePattern[i % entity.dicePattern.length]], entity.dicePattern[i % entity.dicePattern.length]);
  } else {
    for (let i = 0; i < 10; i++) push('action_attack', 'A');
    for (let i = 0; i < 6; i++)  push('action_move',   'M');
    for (let i = 0; i < 3; i++)  push('action_posture','P');
    for (let i = 0; i < 1; i++)  push('action_block',  'B');
  }
}
// Shuffle.
for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
const hand = []; while (hand.length < HAND_SIZE && deck.length) hand.push(deck.shift());
const discard = [];
let queued = [];           // one element: slot index (int) | 'EP' | 'EM'
let target = null;         // peer_id string | { q, r } tile object | null
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

async function emitEnvelope({ type, payload, actionIndex = hg.round }) {
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
    state: currentStateSnapshot(),
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
  if (type === 'evt_action_commit' || type === 'evt_action_reveal' || type === 'evt_map_extend') bus?.publish('env', env);

  // 2) Mirror onto the GunDB graph (CRDT; eventual-consistency across peers).
  //    Gun's nested put balks on arrays, so store the envelope as a JSON blob plus
  //    flat index fields (type / actor / turn / head) for cheap lookups.
  dimRoot.get('doors').get(DOOR_ID).get('hashgraph').get(env._hash).put({
    hash: env._hash,
    type: env.type,
    actor: env.actor_peer_id,
    turn: env.turn,
    envelope_json: JSON.stringify(env),
  });

  // 3) Append to the on-disk tape under the Radicle work dir — pushed on the hourly lottery.
  const line = JSON.stringify(env);
  const abs = path.join(__dirname, 'sessions', DIM_NAME, 'hashgraph.jsonl');
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, line + '\n');

  // 4) Mirror to the UI.
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
  if (env.state && mergePeerState(env.state)) broadcastUI({ kind: 'peers', peers: livePeers() });
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
    console.log(`[${PEER_LABEL}] gossip state: topics=${topics.length} totalPeers=${peers.length} subscribersOnStrong=${subs.length} rxCount=${pubsubRxCount}`);
  } catch (e) { console.warn(`[${PEER_LABEL}] gossip state err: ${e.message}`); }
}, 15_000);

// Shared state via Gun: positions / HP are published on each cleanup.
// Also mirrored to the discovery server so peers can see each other even when
// the Gun CRDT or the gossipsub mesh hasn't converged yet (common on localhost
// during the first few turns, which previously caused resolver no-ops and the
// "ally marker disappears" flicker in the UI).
function currentStateSnapshot() {
  return {
    peer_id: PEER_ID_STRING, character_id: CHARACTER_ID || null, creature_id: CREATURE_ID || null,
    tile_q: entity.tile.q, tile_r: entity.tile.r, life: entity.life, life_max: entity.lifeMax,
    alliance: ALLIANCE, name: entity.name, source_id: entity.sourceId, last_seen: new Date().toISOString(),
    // Live clock + network hints so a joining peer can align its turn counter
    // and dial the mesh. Gun rejects arrays in nested puts, hence the CSV.
    turn: hg.turn, round: hg.round, action: hg.action, phase: currentPhase, phase_ends_at: phaseEndsAt,
    gun_url: myGunUrl, multiaddrs_csv: myMaddrs.join(','),
    nostr_pubkey: bus?.pubkey || null, nostr_relays_csv: (bus?.relays || []).join(','),
  };
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
setInterval(() => {
  let swept = 0;
  const cutoff = Date.now() - PEER_SWEEP_MS;
  for (const [id, p] of peersPublic) {
    if (id === PEER_ID_STRING) continue;
    const ls = Date.parse(p?.last_seen || 0);
    if (!Number.isFinite(ls) || ls < cutoff) { peersPublic.delete(id); swept++; }
  }
  if (swept) broadcastUI({ kind: 'peers', peers: livePeers(), dropped: true });
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
const dimMap = createKnownMap(MAP_SEED, [initialBlock(INITIAL_SIZE), ...seedBlocks]);
const gunMap = dimRoot.get('map').get('blocks');
const knownHex = (q, r) => dimMap.has(q, r);
function mapSummary() { return { seed: MAP_SEED, reveal_radius: REVEAL_RADIUS, blocks: dimMap.blocks(), tiles: dimMap.size(), bounds: dimMap.bounds() }; }
function addMapBlock(b, via) {
  if (!isBlock(b) || !dimMap.addBlock(b)) return false;
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
  broadcastUI({ kind: 'peers', peers: livePeers() });
}

// -------- public Nostr bus --------
if (NOSTR_ENABLED) {
  bus = createNostrBus({
    relays: DEFAULT_RELAYS, dimId: DIM_ID, label: PEER_LABEL,
    onEvent(type, payload) {
      if (type === 'env') receiveEnvelope(payload, 'bus');
      else if (type === 'state') { if (mergePeerState(payload)) broadcastUI({ kind: 'peers', peers: livePeers() }); }
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
// Liveness heartbeat independent of the round loop. Rounds republish state
// anyway, but once a side has won the loop stops — without this the survivors
// (and the fallen) would age out of everyone's roster as stale peers.
setInterval(() => publishPublicState(true).catch(() => {}), 15_000);

// Also pull every other peer's public state live from Gun (slow-tier CRDT).
// Relay graphs can still carry entries from peers that died; mergePeerState
// only accepts entries that look current, and merges rather than replaces so a
// partial Gun echo (which sometimes drops fields) doesn't wipe tile/life.
dimRoot.get('doors').get(DOOR_ID).get('members').map().on((m) => {
  if (mergePeerState(m)) broadcastUI({ kind: 'peers', peers: livePeers() });
});

// Optional discovery mirror: pull everyone's registered state and merge.
async function pullDiscoveryState() {
  if (!DISCOVERY_URL) return;
  try {
    const r = await fetch(`${DISCOVERY_URL}/peers/${DIM_ID}`);
    const j = await r.json();
    let changed = false;
    for (const p of j.peers || []) if (p.state && mergePeerState(p.state)) changed = true;
    if (changed) broadcastUI({ kind: 'peers', peers: livePeers() });
  } catch {}
}
if (DISCOVERY_URL) { setInterval(pullDiscoveryState, 2500); setTimeout(pullDiscoveryState, 1200); }

// -------- phase FSM --------
// planning (10s normal / 6s combat heartbeat) → reveal (5s) → resolution (5s) → cleanup
const PHASES = ['planning', 'reveal', 'resolution', 'cleanup'];
let myLastSalt = null;
let myLastReveal = null;
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
const MY_SIDE = sideOf(ALLIANCE);

function anyAdjacentOpponents() {
  const me = peersPublic.get(PEER_ID_STRING) || { tile_q: entity.tile.q, tile_r: entity.tile.r, alliance: ALLIANCE };
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
    // Keep at least a 1s declaration window if a handshake ran long.
    roundDeadline = Math.max(roundDeadline + ROUND_SEC * 1000, Date.now() + 1000);
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
function expectedMembers() {
  const cutoff = Date.now() - 20_000;
  return [...peersPublic.values()].filter(p =>
    p && p.peer_id !== PEER_ID_STRING && p.life > 0 && Date.parse(p.last_seen || 0) > cutoff
  ).map(p => p.peer_id);
}
function allIn(map) {
  const seen = map.get(hg.action) || new Set();
  return expectedMembers().every(id => seen.has(id));
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
  else if (typeof q0 === 'number' && hand[q0]) { card = hand[q0]; code = card.code; }

  // Normalise target against the action's actual needs. Block / Posture / EP
  // never target; Attack keeps either an enemy peer or a tile (a tile target
  // turns the Attack into a step toward that hex at resolution time);
  // Empty Move only accepts a tile. This stops a stale selection from one
  // turn leaking into a Block commit as a bogus target.
  let normTarget = stripTargetFor(code, target);

  // Attack with no target would resolve into nothing. Fall back to the enemy
  // we last attacked (if still alive), else the nearest living enemy — random
  // among ties. Resolved here, before commit, so the reveal carries a concrete
  // target and every peer resolves the same thing.
  if (code === 'A' && !normTarget) {
    const enemies = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && sideOf(p.alliance) !== MY_SIDE && p.life > 0);
    let pick = enemies.find(p => p.peer_id === lastAttackTarget) || null;
    if (!pick && enemies.length) {
      const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
      const dmin = Math.min(...enemies.map(p => hexDistance(here, p)));
      const nearest = enemies.filter(p => hexDistance(here, p) === dmin);
      pick = nearest[Math.floor(Math.random() * nearest.length)];
    }
    if (pick) normTarget = pick.peer_id;
  }
  if (code === 'A' && typeof normTarget === 'string') lastAttackTarget = normTarget;

  myLastSalt = randomBytes(12).toString('hex');
  const commitHash = sha256Hex(`${code}::${targetTag(normTarget)}::${myLastSalt}`);
  myLastReveal = { code, target: normTarget, salt: myLastSalt, cardId: card ? card.card_id : null };
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
      effects: [], skills: [], class_ability_tapped: false,
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

  const revealsThisTurn = [];
  for (const env of hg.tape) {
    if (env.type !== 'evt_action_reveal' || env.turn !== hg.turn || env.round !== hg.round) continue;
    revealsThisTurn.push({ actor: env.actor_peer_id, action: env.payload.action, target: env.payload.target || null });
  }
  // Include our own reveal in case we didn't receive it from pubsub self-echo.
  if (myLastReveal && !revealsThisTurn.find(r => r.actor === PEER_ID_STRING)) {
    revealsThisTurn.push({ actor: PEER_ID_STRING, action: myLastReveal.code, target: wrapTarget(myLastReveal.target) });
  }
  // Optional discovery mirror: merge any reveals it has for this action.
  if (DISCOVERY_URL) try {
    const r = await fetch(`${DISCOVERY_URL}/reveals/${DIM_ID}/${hg.action}`);
    const j = await r.json();
    for (const d of j.reveals || []) {
      if (revealsThisTurn.find(x => x.actor === d.peer_id)) continue;
      revealsThisTurn.push({ actor: d.peer_id, action: d.action, target: d.target || null });
    }
  } catch {}
  // Reveals from entities at 0 hp are ignored everywhere (stale discovery
  // mirrors, late gossip, a peer that died mid-handshake) so no resolver ever
  // lets a corpse deal damage or claim a tile. Life is public state, so every
  // peer filters the same set.
  const lifeOf = (id) => id === PEER_ID_STRING ? entity.life : (peersPublic.get(id)?.life ?? 0);
  for (let i = revealsThisTurn.length - 1; i >= 0; i--) if (lifeOf(revealsThisTurn[i].actor) <= 0) revealsThisTurn.splice(i, 1);

  // Resolve a target object into the tile the target occupies / points at. A
  // character target reads the peer's current public tile; a tile target is
  // just a {q, r}.
  const tileOf = (targ) => {
    if (!targ) return null;
    if (targ.kind === 'tile' && targ.ref) return { q: targ.ref.q, r: targ.ref.r };
    if (targ.kind === 'character' && targ.ref) {
      const p = peersPublic.get(targ.ref);
      return p ? { q: p.tile_q, r: p.tile_r } : null;
    }
    return null;
  };

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
  const stepsAlong = (from, to, n) => {
    let cur = { q: from.q, r: from.r };
    for (let i = 0; i < n; i++) cur = stepToward(cur, { tile_q: to.q, tile_r: to.r });
    return cur;
  };
  const priorityOf = (act) => act === 'A' ? 3 : act === 'M' ? 2 : act === 'EM' ? 1 : 0;
  const moveIntents = [];
  for (const r of revealsThisTurn) {
    const isMove = r.action === 'M' || r.action === 'EM';
    const isAttackIntoEmpty = r.action === 'A' && r.target?.kind === 'tile';
    if (!isMove && !isAttackIntoEmpty) continue;
    const actor = peersPublic.get(r.actor);
    if (!actor) continue;
    const tgtT = tileOf(r.target);
    if (!tgtT) continue;
    const here = { q: actor.tile_q, r: actor.tile_r };
    const d = hexDistance({ tile_q: here.q, tile_r: here.r }, { tile_q: tgtT.q, tile_r: tgtT.r });
    const steps = r.action === 'EM' ? Math.max(1, Math.round(d / 2)) : 1;
    const dest = stepsAlong(here, tgtT, steps);
    moveIntents.push({ actor: r.actor, action: r.action, dest, prio: priorityOf(r.action), target: tgtT });
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
  for (const p of peersPublic.values()) {
    if (!p || p.life <= 0) continue;
    occupiedNow.set(`${p.tile_q},${p.tile_r}`, p.peer_id);
  }
  const nextTiles = new Map();
  const vetoed = new Map();          // actor -> reason string
  const journeyResults = new Map();  // actor -> { outcome: 'complete'|'blocked', q, r, action }
  const byDest = new Map();
  for (const it of moveIntents) {
    const key = `${it.dest.q},${it.dest.r}`;
    if (!byDest.has(key)) byDest.set(key, []);
    byDest.get(key).push(it);
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

  // Damage pass. Attack still requires a character target so there's a
  // defender to score damage against; tile-target Attacks produce no damage
  // (they're handled as a move intent above). The per-victim value is a list
  // of {attacker, amount} so the UI can animate "-N❤" from dealer to victim.
  const damage = new Map();
  const addDmg = (victim, attacker, amount) => {
    const list = damage.get(victim) || [];
    list.push({ attacker, amount });
    damage.set(victim, list);
  };
  for (const r of revealsThisTurn) {
    if (r.action === 'A') {
      const defId = r.target?.kind === 'character' ? r.target.ref : null;
      if (!defId) continue;
      const atk = peersPublic.get(r.actor), def = peersPublic.get(defId);
      if (!atk || !def) continue;
      const atkPost = nextTiles.get(r.actor) ? { tile_q: nextTiles.get(r.actor).q, tile_r: nextTiles.get(r.actor).r } : atk;
      const defPost = nextTiles.get(defId)  ? { tile_q: nextTiles.get(defId).q,  tile_r: nextTiles.get(defId).r  } : def;
      if (hexDistance(atkPost, defPost) > 1) continue;
      const defReveal = revealsThisTurn.find(x => x.actor === defId);
      let defCode = defReveal?.action || 'EP';
      if (defCode === 'EP') defCode = { A: 'P',  P: 'M',  M: 'EP', B: 'EP' }[r.action] || defCode;
      if (defCode === 'EM') defCode = { A: 'EM', P: 'EM', M: 'EM', B: 'M'  }[r.action] || defCode;
      const bonus = edgeMap[r.action]?.[defCode] ?? 0;
      const dmg = Math.max(0, 1 + bonus);
      addDmg(defId, r.actor, dmg);
    }
    if (r.action === 'B') {
      for (const q of revealsThisTurn) {
        if (q.action === 'A' && q.target?.kind === 'character' && q.target.ref === r.actor) {
          addDmg(q.actor, r.actor, 1);
        }
      }
    }
  }
  const sumDmg = list => (list || []).reduce((s, d) => s + d.amount, 0);

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
      const pa = peersPublic.get(a.actor);
      const pb = peersPublic.get(b.actor);
      if (!pa || !pb) continue;
      if (sideOf(pa.alliance) === sideOf(pb.alliance)) continue;
      const d = hexDistance({ tile_q: pa.tile_q, tile_r: pa.tile_r }, { tile_q: pb.tile_q, tile_r: pb.tile_r });
      if (d > 1) continue;
      const dmg = dmgBetween(a.actor, b.actor) || dmgBetween(b.actor, a.actor);
      contacts.push({
        a: { peer_id: a.actor, name: pa.name, action: a.action, tile_q: pa.tile_q, tile_r: pa.tile_r, vetoed: vetoed.get(a.actor) || null },
        b: { peer_id: b.actor, name: pb.name, action: b.action, tile_q: pb.tile_q, tile_r: pb.tile_r, vetoed: vetoed.get(b.actor) || null },
        distance: d,
        damage_exchanged: dmg,
      });
    }
  }
  if (contacts.length) broadcastUI({ kind: 'contact', contacts, turn: hg.turn, round: hg.round });

  // Apply changes only to my own entity in the authoritative sense.
  const myMove = nextTiles.get(PEER_ID_STRING);
  if (myMove) { entity.tile = myMove; revealAround(myMove.q, myMove.r).catch(e => console.warn(`[${PEER_LABEL}] reveal failed: ${e.message}`)); }
  const myDmg = sumDmg(damage.get(PEER_ID_STRING));
  const wasAlive = entity.life > 0;
  if (myDmg) entity.life = Math.max(0, entity.life - myDmg);
  if (wasAlive && entity.life <= 0) {
    console.log(`[${PEER_LABEL}] DIED at (${entity.tile.q},${entity.tile.r}) after -${myDmg} on T${hg.turn}.R${hg.round + 1} (life_max=${entity.lifeMax})`);
  }
  // Publish immediately so the browser UI sees damage / movement at reveal
  // time, not only after cleanup fires a few seconds later.
  if (myMove || myDmg) await publishPublicState();

  // Deterministic state hash over the whole region (every peer must compute the same).
  const regionState = [...peersPublic.values()]
    .map(p => ({ id: p.peer_id, tile: [p.tile_q, p.tile_r], life: (p.peer_id === PEER_ID_STRING ? entity.life : p.life) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const stateHash = digestObj(regionState);
  // Per-actor action summary so the UI can float an action icon (⚔️ / 🛡 / 🤺
  // / 👁 / ➙) for every revealer this round, mirroring the damage-float path.
  // target_q/target_r are where the action aimed (tile target or defender's
  // tile) so the floater can lerp from actor → aim like damage does; omitted
  // for self-only actions (Block, Posture, Empty Posture).
  const actionSummary = [];
  for (const r of revealsThisTurn) {
    const actor = peersPublic.get(r.actor);
    if (!actor) continue;
    const aim = (r.action === 'A' || r.action === 'M' || r.action === 'EM') ? tileOf(r.target) : null;
    actionSummary.push({
      actor: r.actor, action: r.action,
      from_q: actor.tile_q, from_r: actor.tile_r,
      target_q: aim?.q, target_r: aim?.r,
    });
  }
  await emitEnvelope({ type: 'evt_state_hash', payload: {
    state_hash: stateHash,
    damage_applied: [...damage.entries()].flatMap(([t, list]) => list.map(d => ({ target: t, amount: d.amount, attacker: d.attacker, source: 'action' }))),
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
// refills only at turn end), buffers reset, counters advance.
async function endRound() {
  const played = typeof queued[0] === 'number' ? hand[queued[0]] : null;
  if (played) { discard.push(played); hand.splice(queued[0], 1); }
  queued = []; target = null; locked = false; myLastReveal = null;
  hg.round += 1; hg.action += 1;
  if (hg.round >= ROUNDS_PER_TURN) await endTurn();
  else {
    broadcastUI({ kind: 'hand', hand, deck_count: deck.length, discard_count: discard.length, turn: hg.turn, round: hg.round });
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
  while (hand.length < HAND_SIZE) { reshuffleIfEmpty(); if (!deck.length) break; hand.push(deck.shift()); }

  hg.round = 0; hg.turn += 1;
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
  broadcastUI({ kind: 'hand', hand, deck_count: deck.length, discard_count: discard.length, turn: hg.turn, round: hg.round, turn_end: true });
}

async function npcPlan() {
  const enemies = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && sideOf(p.alliance) !== MY_SIDE && p.life > 0);
  if (!enemies.length) { queued = []; target = null; return; }
  enemies.sort((a, b) => hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, a) - hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, b));
  const nearest = enemies[0];
  const d = hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, nearest);
  const WEIGHTS = (entity.life <= 1 && entity.lifeMax > 1) ? { B: 0.6, M: 0.3, A: 0.1 } : d <= 1 ? { A: 0.5, P: 0.3, M: 0.2 } : { M: 0.7, P: 0.3, A: 0.0 };
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  let r = Math.random() * total, pick = 'A';
  for (const [k, w] of Object.entries(WEIGHTS)) { r -= w; if (r <= 0) { pick = k; break; } }
  const slot = hand.findIndex(c => c.code === pick);
  queued = slot >= 0 ? [slot] : [];
  target = nearest.peer_id;
}

function inboxApply(env) {
  if (env.type === 'evt_map_extend' && env.payload?.block) addMapBlock(env.payload.block, 'envelope');
  if (env.type === 'evt_action_commit') noteSeen(commitsSeen, env);
  if (env.type === 'evt_action_reveal') noteSeen(revealsSeen, env);
}

// -------- join sync --------
// Reveals are matched by turn number, so a peer that boots into a running
// Dimension must adopt the mesh's clock or it will never see anyone's reveal
// for "its" turn. Take the most-advanced live peer as the reference.
// Peer snapshots arrive over the bus (every peer republishes within 15s, the
// relay replays the last two minutes on subscribe), Gun and the optional
// discovery mirror — all land in peersPublic. Wait briefly for the first one.
const JOIN_SYNC_WAIT_MS = Number(process.env.JOIN_SYNC_WAIT_MS || 6000);
async function syncClockFromMesh() {
  const t0 = Date.now();
  const actOf = s => typeof s.action === 'number' ? s.action : actionKey(s.turn, s.round || 0);
  let others = [];
  while (Date.now() - t0 < JOIN_SYNC_WAIT_MS) {
    others = livePeers().filter(p => p.peer_id !== PEER_ID_STRING && typeof p.turn === 'number');
    if (others.length) break;
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
      broadcastUI({ kind: 'hand', hand, deck_count: deck.length, discard_count: discard.length, turn: hg.turn, round: hg.round });
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
      if (!allIn(commitsSeen) && !expired) return;
      await doReveal();
      enterPhase('resolution');
    } else if (currentPhase === 'resolution') {
      if (!allIn(revealsSeen)) await pullFromDiscovery('reveals', revealsSeen);
      if (!allIn(revealsSeen) && !expired) return;
      await doResolution();
      await endRound();
      checkStandoff();
      catchUpClock();
      enterPhase('planning');
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
  if (ref.phase === 'planning' && typeof ref.phase_ends_at === 'number' && ref.phase_ends_at > Date.now()) {
    roundDeadline = ref.phase_ends_at;
  } else {
    roundDeadline = Date.now() + 1000;
  }
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
    peer_id: PEER_ID_STRING, name: entity.name, alliance: ALLIANCE,
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
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      peer_id: PEER_ID_STRING, dimension: DIM_NAME, phase: currentPhase, phaseEndsIn: Math.max(0, phaseEndsAt - Date.now()),
      entity, hand, queued, target, locked, turn: hg.turn, round: hg.round, action: hg.action, head: hg.head,
      peers: livePeers(),
      alliance: ALLIANCE,
      map: { seed: MAP_SEED, reveal_radius: REVEAL_RADIUS, tiles: dimMap.size(), blocks: dimMap.blockCount(), bounds: dimMap.bounds() },
      multiaddrs: myMaddrs, gun_url: myGunUrl, nostr_pubkey: bus?.pubkey || null, bus: bus ? bus.stats() : null,
    }));
    return;
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: uiHttp });
wss.on('connection', (ws) => {
  uiClients.add(ws);
  ws.send(JSON.stringify({ kind: 'hello', peer_id: PEER_ID_STRING, alliance: ALLIANCE, entity, hand, deck_count: deck.length, discard_count: discard.length, dimension: DIM_NAME, door: DOOR_ID, turn: hg.turn, round: hg.round, rounds_per_turn: ROUNDS_PER_TURN, phase: currentPhase, phase_ends_in: Math.max(0, phaseEndsAt - Date.now()), peers: livePeers(), map: mapSummary() }));
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
          (typeof s === 'number' && s >= 0 && s < hand.length)
        );
        queued = picks;
        broadcastUI({ kind: 'hand', hand, deck_count: deck.length, discard_count: discard.length, queued });
      }
      if (m.kind === 'target') {
        const t = m.target;
        if (typeof t === 'string') target = t;
        else if (t && typeof t === 'object' && typeof t.q === 'number' && typeof t.r === 'number') target = { q: t.q, r: t.r };
        else target = null;
      }
      if (m.kind === 'lock') { locked = true; }
      if (m.kind === 'discard') {
        // Slot indices → card ids, so the marks survive the hand shrinking as
        // cards are played during the turn. Monsters never discard leftovers.
        willDiscard.clear();
        if (entity.kind === 'character') for (const i of m.slots || []) if (hand[i]) willDiscard.add(hand[i].card_id);
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
process.on('SIGINT', async () => { console.log(`[${PEER_LABEL}] shutting down`); try { await libp2p.stop(); } catch {} process.exit(0); });
