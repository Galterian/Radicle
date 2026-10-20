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
//   • Firebase-stub discovery (:7350) advertises peer multiaddrs.
//   • Local bare git repo plays the Radicle role for the hourly push lottery.
//
// Each peer also hosts a tiny HTTP + WebSocket server for its local browser UI so
// the user can watch (and command) their peer. Only the "player" peer is driven
// by human input; the others plan via the weighted-priority AI.

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';

import Gun from 'gun';
import 'gun/sea.js';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

import { pushDimension, fetchDimension, electPusher } from './radicle-adapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -------- config via env --------
const PEER_LABEL        = process.env.PEER_LABEL        || 'player-1';          // human-readable
const PEER_PORT_LIBP2P  = Number(process.env.PEER_PORT_LIBP2P  || 7400);
const PEER_PORT_HTTP    = Number(process.env.PEER_PORT_HTTP    || 7401);        // UI WebSocket + API
const PEER_PORT_GUN     = Number(process.env.PEER_PORT_GUN     || 7501);        // GunDB relay WebSocket
const DIM_NAME          = process.env.DIM_NAME         || 'Ashfall-Micro';
const DIM_ID            = process.env.DIM_ID           || 'dim-ashfall-micro';
const DOOR_ID           = process.env.DOOR_ID          || 'door-primary';
const DISCOVERY_URL     = process.env.DISCOVERY_URL    || 'http://127.0.0.1:7350';
const CHARACTER_ID      = process.env.CHARACTER_ID     || '';
const CREATURE_ID       = process.env.CREATURE_ID      || '';
const ENTITY_NAME       = process.env.ENTITY_NAME      || PEER_LABEL;
const ALLIANCE          = process.env.ALLIANCE         || 'player';              // player | npc_a | npc_b
const START_TILE        = JSON.parse(process.env.START_TILE || '{"q":1,"r":2}');
const PEER_GUN_URLS     = (process.env.PEER_GUN_URLS   || '').split(',').filter(Boolean); // relays of other peers
const BOOTSTRAP_MADDRS  = (process.env.BOOTSTRAP || '').split(',').filter(Boolean);        // libp2p peers
const RADICLE_PUSH_SEC  = Number(process.env.RADICLE_PUSH_SEC || 60);            // demo: 60s instead of 3600s

const PEER_ID_STRING    = `peer:${PEER_LABEL}`;

// Hoisted so publishPublicState's broadcastUI calls can safely fire before the
// WebSocket server comes up later in the file. Client set populates lazily.
const uiClients = new Set();
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
  addresses: { listen: [`/ip4/127.0.0.1/tcp/${PEER_PORT_LIBP2P}`] },
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

const myMaddrs = libp2p.getMultiaddrs().map(a => a.toString());
console.log(`[${PEER_LABEL}] libp2p peer id = ${libp2p.peerId.toString()}`);
console.log(`[${PEER_LABEL}] listening on: ${myMaddrs.join(', ')}`);

// Dial bootstrap peers.
for (const addr of BOOTSTRAP_MADDRS) {
  try { await libp2p.dial(addr); console.log(`[${PEER_LABEL}] dialed ${addr}`); }
  catch (e) { console.warn(`[${PEER_LABEL}] dial ${addr} failed: ${e.message}`); }
}

// -------- GunDB relay (per peer) --------
const gunHttp = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('gun relay'); });
gunHttp.listen(PEER_PORT_GUN, '127.0.0.1');
const gunDir = path.join(__dirname, 'gun-data', PEER_LABEL);
await fs.mkdir(gunDir, { recursive: true });
const gun = Gun({
  web: gunHttp,
  peers: PEER_GUN_URLS,              // mesh with the other peers' relays
  file: path.join(gunDir, 'graph'),
  axe: false,
  multicast: false,
});
console.log(`[${PEER_LABEL}] gun relay on ws://127.0.0.1:${PEER_PORT_GUN}/gun; peers = ${PEER_GUN_URLS.join(', ') || '(none yet)'}`);

const dimRoot = gun.get('chaosd6').get('dimensions').get(DIM_ID);
const myNode  = dimRoot.get('doors').get(DOOR_ID).get('members').get(PEER_ID_STRING);

// -------- Firebase-stub registration --------
async function registerWithDiscovery() {
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
  try {
    await fetch(`${DISCOVERY_URL}/heartbeat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer_id: PEER_ID_STRING, dimension_id: DIM_ID }),
    });
  } catch {}
}
await registerWithDiscovery();
setInterval(heartbeat, 15_000);

// Poll discovery for peer multiaddrs and dial any newcomers. We track dialled peer
// ids as strings so we don't thrash the same connection every 5 seconds.
const dialled = new Set();
let discoveryPollCount = 0;
async function discoveryPoll() {
  discoveryPollCount++;
  try {
    const r = await fetch(`${DISCOVERY_URL}/peers/${DIM_ID}`);
    const j = await r.json();
    const peers = (j.peers || []).filter(p => p.peer_id !== PEER_ID_STRING);
    if (discoveryPollCount === 1 || discoveryPollCount % 10 === 0) {
      console.log(`[${PEER_LABEL}] discovery poll #${discoveryPollCount}: ${peers.length} other peers (dialled ${dialled.size})`);
    }
    for (const p of peers) {
      for (const addr of p.multiaddrs || []) {
        const theirPid = addr.split('/p2p/').at(-1);
        if (dialled.has(theirPid)) continue;
        try {
          await libp2p.dial(multiaddr(addr));
          dialled.add(theirPid);
          console.log(`[${PEER_LABEL}] libp2p mesh ↔ ${p.peer_id} (${theirPid.slice(0, 14)}…)`);
        } catch (e) {
          if (discoveryPollCount <= 3) console.warn(`[${PEER_LABEL}] dial ${p.peer_id} failed: ${e.message}`);
        }
      }
    }
  } catch (e) { console.warn(`[${PEER_LABEL}] discoveryPoll error: ${e.message}`); }
}
setInterval(discoveryPoll, 5_000);
setTimeout(discoveryPoll, 1_500);

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
const hand = []; while (hand.length < 5 && deck.length) hand.push(deck.shift());
const discard = [];
let queued = [];           // one element: slot index (int) | 'EP' | 'EM'
let target = null;         // peer_id string | { q, r } tile object | null
let locked = false;

// -------- hashgraph state --------
const hg = {
  selfParent: null,
  otherParent: null,
  head: null,
  tape: [],
  turn: 0,
  round: 0,
};

function sha256Hex(s) { return createHash('sha256').update(s).digest('hex'); }
function digestObj(o) { return sha256Hex(JSON.stringify(o)); }

async function emitEnvelope({ type, payload, actionIndex = 0 }) {
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
  };
  env._hash = digestObj(env);
  hg.selfParent = env._hash;
  hg.head = env._hash;
  hg.tape.push(env);

  // 1) Broadcast via libp2p gossipsub to the strong-region mesh.
  try { await libp2p.services.pubsub.publish(TOPIC_STRONG, new TextEncoder().encode(JSON.stringify(env))); }
  catch (e) { console.warn(`[${PEER_LABEL}] pubsub publish failed: ${e.message}`); }

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

// Receive envelopes from mesh peers.
let pubsubRxCount = 0;
libp2p.services.pubsub.addEventListener('message', (ev) => {
  if (ev.detail.topic !== TOPIC_STRONG) return;
  try {
    const env = JSON.parse(new TextDecoder().decode(ev.detail.data));
    if (env.actor_peer_id === PEER_ID_STRING) return;
    pubsubRxCount++;
    if (pubsubRxCount <= 5 || pubsubRxCount % 10 === 0) {
      console.log(`[${PEER_LABEL}] pubsub rx #${pubsubRxCount}: ${env.type} from ${env.actor_peer_id}`);
    }
    hg.otherParent = env._hash;
    hg.tape.push(env);
    inboxApply(env);
    broadcastUI({ kind: 'evt', env, from_peer: true });
  } catch (e) { console.warn(`[${PEER_LABEL}] bad pubsub frame: ${e.message}`); }
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
  };
}

// Known-peers map seeded with self so the resolver always has an actor entry
// even if nothing has sync'd yet.
const peersPublic = new Map();
peersPublic.set(PEER_ID_STRING, currentStateSnapshot());

async function postJson(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } catch (e) { /* best-effort; log at caller */ return null; }
}

async function publishPublicState() {
  const snap = currentStateSnapshot();
  myNode.put(snap);
  peersPublic.set(PEER_ID_STRING, snap);
  await postJson(`${DISCOVERY_URL}/state`, { dimension_id: DIM_ID, peer_id: PEER_ID_STRING, state: snap });
  broadcastUI({ kind: 'peers', peers: [...peersPublic.values()] });
}
await publishPublicState();

// Also pull every other peer's public state live from Gun (slow-tier CRDT).
dimRoot.get('doors').get(DOOR_ID).get('members').map().on((m, k) => {
  if (!m || typeof m !== 'object' || !m.peer_id) return;
  // Merge rather than replace so a partial Gun echo (which sometimes drops
  // fields) doesn't wipe tile/life.
  const prev = peersPublic.get(m.peer_id) || {};
  peersPublic.set(m.peer_id, { ...prev, ...m });
  broadcastUI({ kind: 'peers', peers: [...peersPublic.values()] });
});

// Discovery is the reliable fallback: pull everyone's registered state and
// merge into peersPublic. Runs on the same cadence as peer-dial polling.
async function pullDiscoveryState() {
  try {
    const r = await fetch(`${DISCOVERY_URL}/peers/${DIM_ID}`);
    const j = await r.json();
    let changed = false;
    for (const p of j.peers || []) {
      if (!p.state) continue;
      const prev = peersPublic.get(p.peer_id) || {};
      // Prefer any field we already have from Gun/local if the discovery copy
      // doesn't carry it, so faster sources don't get clobbered.
      const merged = { ...prev, ...p.state };
      peersPublic.set(p.peer_id, merged);
      changed = true;
    }
    if (changed) broadcastUI({ kind: 'peers', peers: [...peersPublic.values()] });
  } catch {}
}
setInterval(pullDiscoveryState, 2500);
// Seed quickly after startup so the first planning phase already sees peers.
setTimeout(pullDiscoveryState, 1200);

// -------- phase FSM --------
// planning (10s normal / 6s combat heartbeat) → reveal (5s) → resolution (5s) → cleanup
const PHASES = ['planning', 'reveal', 'resolution', 'cleanup'];
let currentPhase = 'planning';
let phaseEndsAt = Date.now() + 10_000;
let myLastSalt = null;
let myLastReveal = null;

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
function stepToward(from, to) {
  const DIRS = [[+1, 0], [+1, -1], [0, -1], [-1, 0], [-1, +1], [0, +1]];
  let best = null, bestD = Infinity;
  for (const [dq, dr] of DIRS) {
    const nq = from.q + dq, nr = from.r + dr;
    if (nq < 0 || nq > 4 || nr < 0 || nr > 4) continue;
    const d = hexDistance({ tile_q: nq, tile_r: nr }, to);
    if (d < bestD) { bestD = d; best = { q: nq, r: nr }; }
  }
  return best || from;
}

async function enterPhase(name) {
  currentPhase = name;
  const heartbeat = anyAdjacentOpponents();
  const secs = name === 'planning' ? (heartbeat ? 6 : 10) : name === 'reveal' ? 5 : name === 'resolution' ? 5 : 2;
  phaseEndsAt = Date.now() + secs * 1000;
  broadcastUI({ kind: 'phase', name, seconds: secs, heartbeat });
  if (name === 'reveal')      await doReveal();
  if (name === 'resolution')  await doResolution();
  if (name === 'cleanup')     await doCleanup();
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
  const normTarget = stripTargetFor(code, target);

  myLastSalt = randomBytes(12).toString('hex');
  const commitHash = sha256Hex(`${code}::${targetTag(normTarget)}::${myLastSalt}`);
  myLastReveal = { code, target: normTarget, salt: myLastSalt, cardId: card ? card.card_id : null };
  await emitEnvelope({
    type: 'evt_action_commit',
    payload: { commitment: commitHash, empty_move_announced: code === 'EM' },
  });
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
  // Mirror to discovery so other peers' resolvers can pick it up even if
  // gossipsub hasn't propagated the subscription yet.
  await postJson(`${DISCOVERY_URL}/reveal`, {
    dimension_id: DIM_ID, peer_id: PEER_ID_STRING, turn: hg.turn,
    action: myLastReveal.code, target: targetObj,
  });
}

const revealedByPeer = new Map();
async function doResolution() {
  // Wait briefly for other peers' reveals (we received them via pubsub earlier).
  await new Promise(r => setTimeout(r, 500));

  // Deterministic resolver over all revealed actions this turn.
  const edges = data.battle_system.battle_system_core.data.resolution_matrix.edges;
  const edgeMap = {};
  for (const e of edges) (edgeMap[e.actor] ||= {})[e.defender] = e.bonus_damage_to_actor;

  const revealsThisTurn = [];
  for (const env of hg.tape) {
    if (env.type !== 'evt_action_reveal' || env.turn !== hg.turn) continue;
    revealsThisTurn.push({ actor: env.actor_peer_id, action: env.payload.action, target: env.payload.target || null });
  }
  // Include our own reveal in case we didn't receive it from pubsub self-echo.
  if (myLastReveal && !revealsThisTurn.find(r => r.actor === PEER_ID_STRING)) {
    revealsThisTurn.push({ actor: PEER_ID_STRING, action: myLastReveal.code, target: wrapTarget(myLastReveal.target) });
  }
  // Pull any reveals the discovery server has for this turn and merge in — this
  // is the gossipsub-didn't-propagate fallback. Peers' resolvers all converge
  // on the same input set this way.
  try {
    const r = await fetch(`${DISCOVERY_URL}/reveals/${DIM_ID}/${hg.turn}`);
    const j = await r.json();
    for (const d of j.reveals || []) {
      if (revealsThisTurn.find(x => x.actor === d.peer_id)) continue;
      revealsThisTurn.push({ actor: d.peer_id, action: d.action, target: d.target || null });
    }
  } catch {}

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

  // Movement intents. Move/Empty-Move step one tile toward the target tile.
  // Supports both character targets (step toward the peer) and tile targets.
  // Attack with a tile target (empty hex) also generates a step toward that
  // tile — swinging into empty space advances you — but produces no damage
  // (the damage pass below bails when there is no defender).
  const movesByActor = new Map();
  for (const r of revealsThisTurn) {
    const isMove = r.action === 'M' || r.action === 'EM';
    const isAttackIntoEmpty = r.action === 'A' && r.target?.kind === 'tile';
    if (!isMove && !isAttackIntoEmpty) continue;
    const actor = peersPublic.get(r.actor);
    if (!actor) continue;
    const tgtT = tileOf(r.target);
    if (!tgtT) continue;
    const next = stepToward({ q: actor.tile_q, r: actor.tile_r }, { tile_q: tgtT.q, tile_r: tgtT.r });
    movesByActor.set(r.actor, next);
  }
  // Collision veto: a Mover may not step onto a hex another living entity
  // currently occupies — that's the "forbidden thing": Move toward an enemy
  // engages them in opposition on your current tiles, it does not walk onto
  // their hex. Also veto two Movers claiming the same destination (lower
  // peer_id wins deterministically so every peer agrees).
  const occupiedNow = new Map();
  for (const p of peersPublic.values()) {
    if (!p || p.life <= 0) continue;
    occupiedNow.set(`${p.tile_q},${p.tile_r}`, p.peer_id);
  }
  const claimedBy = new Map();
  const nextTiles = new Map();
  const vetoed = new Map();   // actor -> reason string
  const sortedMovers = [...movesByActor.keys()].sort();
  for (const actor of sortedMovers) {
    const dest = movesByActor.get(actor);
    const key = `${dest.q},${dest.r}`;
    const occupant = occupiedNow.get(key);
    if (occupant && occupant !== actor) { vetoed.set(actor, `tile occupied by ${occupant}`); continue; }
    if (claimedBy.has(key)) { vetoed.set(actor, `tile also claimed by ${claimedBy.get(key)}`); continue; }
    claimedBy.set(key, actor);
    nextTiles.set(actor, dest);
  }

  // Contact log: broadcast every pair of adjacent cross-side revealers so the
  // UI can show exactly what opposed what, after both commits are revealed.
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
      contacts.push({
        a: { peer_id: a.actor, name: pa.name, action: a.action, vetoed: vetoed.get(a.actor) || null },
        b: { peer_id: b.actor, name: pb.name, action: b.action, vetoed: vetoed.get(b.actor) || null },
        distance: d,
      });
    }
  }
  if (contacts.length) broadcastUI({ kind: 'contact', contacts, turn: hg.turn });

  // Damage pass. Attack still requires a character target so there's a
  // defender to score damage against; tile-target Attacks produce no damage
  // (they're handled as a move intent above).
  const damage = new Map();
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
      damage.set(defId, (damage.get(defId) || 0) + dmg);
    }
    if (r.action === 'B') {
      for (const q of revealsThisTurn) {
        if (q.action === 'A' && q.target?.kind === 'character' && q.target.ref === r.actor) {
          damage.set(q.actor, (damage.get(q.actor) || 0) + 1);
        }
      }
    }
  }

  // Apply changes only to my own entity in the authoritative sense.
  const myMove = nextTiles.get(PEER_ID_STRING);
  if (myMove) entity.tile = myMove;
  const myDmg = damage.get(PEER_ID_STRING) || 0;
  if (myDmg) entity.life = Math.max(0, entity.life - myDmg);
  // Publish immediately so the browser UI sees damage / movement at reveal
  // time, not only after cleanup fires a few seconds later.
  if (myMove || myDmg) await publishPublicState();

  // Deterministic state hash over the whole region (every peer must compute the same).
  const regionState = [...peersPublic.values()]
    .map(p => ({ id: p.peer_id, tile: [p.tile_q, p.tile_r], life: (p.peer_id === PEER_ID_STRING ? entity.life : p.life) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const stateHash = digestObj(regionState);
  await emitEnvelope({ type: 'evt_state_hash', payload: { state_hash: stateHash, damage_applied: [...damage.entries()].map(([t, a]) => ({ target: t, amount: a, source: 'action' })), tokens_changed: [] } });
}

async function doCleanup() {
  // Discard played + will_discard; draw back to 5.
  const consumed = new Set(queued);
  const kept = [];
  for (let i = 0; i < hand.length; i++) {
    if (consumed.has(i)) discard.push(hand[i]);
    else kept.push(hand[i]);
  }
  hand.length = 0; for (const c of kept) hand.push(c);
  while (hand.length < 5 && deck.length) hand.push(deck.shift());
  if (!deck.length && discard.length) { for (const c of discard.splice(0)) deck.push(c); for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; } }

  queued = []; target = null; locked = false;
  hg.turn += 1; hg.round += 1;
  entity.tile = entity.tile; // keep
  await publishPublicState();

  // evt_turn_commit on the Gun layer — slow-tier gossip.
  await emitEnvelope({
    type: 'evt_turn_commit',
    payload: {
      turn: hg.turn,
      region_state_hash: hg.tape.filter(e => e.type === 'evt_state_hash').at(-1)?.payload.state_hash || '',
      positions: Object.fromEntries([...peersPublic.values()].map(p => [p.peer_id, { q: p.tile_q, r: p.tile_r }])),
      hashgraph_head: hg.head,
      draws: [{ peer_id: PEER_ID_STRING, cards_drawn: 5 - hand.length }],
    },
  });

  broadcastUI({ kind: 'hand', hand });
}

async function npcPlan() {
  const enemies = [...peersPublic.values()].filter(p => p && p.peer_id !== PEER_ID_STRING && sideOf(p.alliance) !== MY_SIDE && p.life > 0);
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
  if (env.type === 'evt_action_reveal') revealedByPeer.set(env.actor_peer_id, env);
}

// -------- phase ticker --------
async function tick() {
  if (Date.now() < phaseEndsAt) return;
  if (currentPhase === 'planning') {
    await doPlanningEnd();
    await enterPhase('reveal');
  } else if (currentPhase === 'reveal')      await enterPhase('resolution');
  else if (currentPhase === 'resolution')    await enterPhase('cleanup');
  else if (currentPhase === 'cleanup') {
    // Check win: look at Gun state.
    const alive = [...peersPublic.values()].filter(p => p && p.life > 0);
    const alliances = new Set(alive.map(a => a.alliance));
    if (alliances.size <= 1) { broadcastUI({ kind: 'phase', name: 'game over', winner: [...alliances][0] }); return; }
    await enterPhase('planning');
  }
}
setInterval(() => tick().catch(e => console.error(`[${PEER_LABEL}]`, e)), 250);

// -------- Radicle lottery (hourly in prod; demo accelerates) --------
let lotteryCount = 0;
async function radicleLottery() {
  lotteryCount++;
  const peers = [...peersPublic.keys()].sort();
  if (peers.length === 0) { console.log(`[${PEER_LABEL}] lottery #${lotteryCount}: no peers in Gun yet; skip`); return; }
  const intervalIndex = Math.floor(Date.now() / (RADICLE_PUSH_SEC * 1000));
  const winner = electPusher(peers, hg.head || '', intervalIndex);
  console.log(`[${PEER_LABEL}] lottery #${lotteryCount}: ${peers.length} peers, winner=${winner}, me=${PEER_ID_STRING}`);
  if (winner !== PEER_ID_STRING) return;
  try {
    const dimensionDoc = {
      dimension_id: DIM_ID, dimension_name: DIM_NAME, radicle_repo: 'rad:local-bare',
      game_mode: 'mode_mmorpg', created_at: new Date().toISOString(), owners: ['peer:player-1'],
      tileset: { initial_size: '5x5', bounds: { min_x: 0, min_y: 0, max_x: 4, max_y: 4 }, map_seed: '0xdeadbeef', extended_blocks: [] },
      turn: { max_seen: hg.turn, updated_at: new Date().toISOString() },
      doors: [DOOR_ID], description: 'Micro-dimension sandbox', last_push: { peer_id: PEER_ID_STRING, at: new Date().toISOString(), commit: 'pending' },
    };
    const doorDoc = {
      door_id: DOOR_ID, magnet_id: `magnet:?xt=urn:dim:${DIM_NAME}&xs=${hg.head || ''}&tr=rad:local-bare&pe=${PEER_ID_STRING}`,
      label: 'primary strong-region', status: 'active', hashgraph_head: hg.head || '',
      turn: hg.turn, members: [...peersPublic.values()].map(p => ({ peer_id: p.peer_id, character_id: p.character_id, creature_id: p.creature_id, tile: { x: p.tile_q, y: p.tile_r }, clan: p.alliance })),
      region: { center: { x: 2, y: 2 }, strong_radius_tiles: 2, reach_tiles: 4 },
      last_push: { interval_index: intervalIndex, peer_id: PEER_ID_STRING, at: new Date().toISOString(), commit: 'pending' },
    };
    const r = await pushDimension(PEER_ID_STRING, DIM_NAME, {
      [`ActiveDimensions/${DIM_NAME}/dimension.json`]: dimensionDoc,
      [`ActiveDimensions/${DIM_NAME}/doors/${DOOR_ID}.json`]: doorDoc,
      [`ActiveDimensions/${DIM_NAME}/rules_snapshot_commit`]: 'local-rules-snapshot',
    });
    if (r.pushed) { console.log(`[${PEER_LABEL}] radicle push → ${r.commit} on ${r.branch}`); broadcastUI({ kind: 'radicle', commit: r.commit, branch: r.branch }); await emitEnvelope({ type: 'evt_radicle_push', payload: { interval_index: intervalIndex, commit: r.commit, head_pushed: hg.head || '' } }); }
  } catch (e) { console.warn(`[${PEER_LABEL}] radicle push failed: ${e.message}`); }
}
setInterval(() => radicleLottery().catch(() => {}), RADICLE_PUSH_SEC * 1000);

// -------- browser UI socket --------
const uiHttp = http.createServer(async (req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      peer_id: PEER_ID_STRING, dimension: DIM_NAME, phase: currentPhase, phaseEndsIn: Math.max(0, phaseEndsAt - Date.now()),
      entity, hand, queued, target, locked, turn: hg.turn, head: hg.head,
      peers: [...peersPublic.values()],
      alliance: ALLIANCE,
    }));
    return;
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: uiHttp });
wss.on('connection', (ws) => {
  uiClients.add(ws);
  ws.send(JSON.stringify({ kind: 'hello', peer_id: PEER_ID_STRING, alliance: ALLIANCE, entity, hand, turn: hg.turn, peers: [...peersPublic.values()] }));
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
        broadcastUI({ kind: 'hand', hand, queued });
      }
      if (m.kind === 'target') {
        const t = m.target;
        if (typeof t === 'string') target = t;
        else if (t && typeof t === 'object' && typeof t.q === 'number' && typeof t.r === 'number') target = { q: t.q, r: t.r };
        else target = null;
      }
      if (m.kind === 'lock') { locked = true; }
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
  payload: { dimension_id: DIM_ID, dimension_name: DIM_NAME, rules_snapshot_commit: 'local', tileset_size: '5x5', map_seed: '0xdeadbeef', owners: ['peer:player-1'] },
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
await enterPhase('planning');

// Clean shutdown.
process.on('SIGINT', async () => { console.log(`[${PEER_LABEL}] shutting down`); try { await libp2p.stop(); } catch {} process.exit(0); });
