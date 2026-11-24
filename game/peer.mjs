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
// NOGUN=1 (P2P rework M6 step 1): Gun is not even loaded — no relay, no client, no puts / reads.
const Gun = process.env.NOGUN === '1' ? null : (await import('gun')).default;
import http from 'node:http';
import { WebSocketServer } from 'ws';
import fs from 'node:fs/promises';
import { EFFECT_RULES, EFFECT_UI, builtinEffectEntries, playableEffects, resolveEffect, roundHalfUp10, pointBuy, pointBuyPermanent, pointBuyPermanentMin, trapDamageSum, TRAP_POWER, pickBySalt, pickHandDiscards } from './effects.mjs';
import { pickAltAction, pickManipTarget, applyManipSwap, isWildMonster, prophetPick } from './contact-prims.mjs';   // phase 6: generic primitives (were class-manipulator / class-chase)
import * as CS from './class-state.mjs';   // class isolation phase 2: the generic class-state store (snapshot class_state_json)
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';

import { pushDimension, radicleEnv, dimsEnv, dimsIdentity } from './radicle-adapter.mjs';
import { createNostrBus, DEFAULT_RELAYS } from './nostr-bus.mjs';
import { netStat, netAttachGun, netSnapshot, netStart } from './net-stats.mjs';   // telemetry only (P2P rework M1)
import { createDigest, createMapSync, createBusRpc, encodeFrame, createFrameDecoder, MAX_FRAME_BYTES } from './map-sync.mjs';   // map compare-then-pull (P2P rework M3)
import { createFxPeer } from './effects-handshake.mjs';   // foreign (player-branch) effects by ref (chaosD6-Effects E4)
import { createSkPeer } from './skills-handshake.mjs';   // S4: foreign (player-branch) skills by ref (chaosD6-Skills)
import { createClPeer, clRefOf } from './classes-handshake.mjs';   // CH: foreign (player-branch) classes by ref (chaosD6-Classes)
import { isClassSuspended, foreignClassDef } from './classes.mjs';   // CH: a dormant foreign class (classes-handshake.mjs gate); a foreign class's data
import { SKILLS_IMPLEMENTED, SKILL_RULES, NEGATING_SKILLS, skillHook, ridesOn as skillRidesOn, builtinSkillEntries, skillBundleErrors, skillUiOf, BUILDING_SKILLS as SK_BUILDING_SKILLS, SKILL_ENGINE, installSkillOracle } from './skills.mjs';   // S1: pure skill rules (skills-data/HOOKS.md)
import { CLASS_RULES, CLASS_NEEDS as CL_NEEDS, PASSIVE_TURN_CLASSES as CL_PASSIVE, classHook, builtinClassEntries, classBundleErrors, ABILITY_REQUESTS, classUiOf, CLASS_ENGINE, installClassOracle } from './classes.mjs';   // C1: pure class rules (classes-data/HOOKS.md); phase 5: classUiOf (the UI's class_ui)
import { channelBreaks } from './channel-rule.mjs';   // CR: the channel break rule (oracle in tools/classes-check.mjs)
import { effectHook, applyHookRecords } from './effect-hooks.mjs';   // MV: import — channels / traps / holdings / summons as hook records
import { standing, holding } from './effect-standing.mjs';   // F2: what a permanent does while it stands (definition `standing`)
import { slimMemberRecord, gunMemberPatch, pickGunMember, gunMergeable, recordBytes, GUN_MEMBER_CAP, GUN_MEMBER_CORE } from './gun-member.mjs';
import { orderedMerge, pickClockRef, cohortDeadline, meshZones, resolverPeers, clockFrame, notePrior, resolverBase, pickStartClock, lastKnownClock, saveClockCand } from './merge-order.mjs';   // snapshot ordering + join / phase clock (Swarm-0407)
import { createKnownMap, initialBlock, discBlock, isBlock, blockTiles, hash32, seedForDimension, DEFAULT_REVEAL_RADIUS, INITIAL_SIZE, featureAt, MONSTER_SIGHT_RADIUS, HERO_SIGHT_RADIUS } from './js/map.js';
import { stepToward as hexStepToward, neighbours as hexNeighbours } from './js/hex.js';
import { isLabyrinthWallAt, setFeatureCatalog, featureAt as buildingFeatureAt, isBuildingFeature, placedBuildingsFrom, setPlacedBuildings, catalogSpriteFor, LAB_WALL_PATHS } from './js/features.js';
import { setBigFeatureCatalog } from './js/bigfeature.js';
import { setBuildingSkills, configureFortress, FORTRESS, fortressBankStep, fortressBonusDice, fortressBonusOf, FORTRESS_TOKEN_EFFECT, fortressTokenElem } from './js/building-bonus.js';
import { tileInRing, hexWalkableAt } from './join-plan.mjs';
import { rollDice, placeStatBonusToken, rule24Order, TILE_TOKEN_CHOICE, tokenRetryOwed } from './effects.mjs';
import { effectResultsOf, plannedLossResults, naturalResults } from './effect-results.mjs';
import { monsterDeckConfig, pickThematicEffects, pickRandomEffects, monsterDeckSeed, npcCastChoice, npcStuckCard } from './monster-deck.mjs';
import { llmConfig, aiRoleFor, systemPrompt, userPrompt, echoesOption, askThisAction, askBanter, fixSelfAddress, BANTER_MAX_UNITS } from './llm-brain.mjs';
import { ringHexes, homeIndex, nextWallHex, ringStep } from './builder-ring.mjs';   // NPC builders' ring wall (planning only)
import { LLM_PROTO, loadTeamAuth, remoteConfig, attachLlmRpc, createLlmRouter } from './llm-route.mjs';   // local → own team → OCI
import { naturalConfig, naturalPermFor, parseCopies, dropOneCopy, naturalDamageBlock, onlyHolderAffliction, contactAfflictions, liftAtTower, creationBars, lostToHolders, nearestAlliedCreature, naturalLinkStats, naturalKind, naturalOfKind, isContactNatural } from './natural-perms.mjs';
import { trapsInRange, clericRoute, nearestBuilding, buildSite, copyMade, shrineMade, hexDist, discAround } from './world-prims.mjs';   // phase 6: generic primitives (were class-world / class-traps)
// Class isolation phase 6: the JS reference hooks are a test oracle in classes-data/oracle (chaosD6-Classes) — loaded
// only when CLASS_ENGINE=js | shadow asks for them (default data: never imported).
if (CLASS_ENGINE !== 'data') installClassOracle(await import('./classes-data/oracle/classes-js.mjs'));
// Skill isolation (2026-11-22): the same for the skills' JS reference hooks (skills-data/oracle, SKILL_ENGINE=js | shadow).
if (SKILL_ENGINE !== 'data') installSkillOracle(await import('./skills-data/oracle/skills-js.mjs'));
import { awakePlan, AWAKE_CONFIG } from './awake.mjs';
import { mergeLedger, ledgerUnits, ledgerFor } from './js/world-ledger.js';
const awakeLast = new Map();   // caster → the Awake plan of its last real (non-quiet) resolution (∀ lend)
import { buildingBonusAt, bonusText, fortressAt, teleportTargets, wallArc, exploreTarget, dungeonAt, dungeonExplored, LEARN_REARM_TURNS } from './js/building-bonus.js';
import { start as autosaveStart, loadTmj as autosaveLoadTmj } from './tools/autosave.mjs';
import { loadProfile, characterOf, dropRandomDeckCard, addArchivedCard, profilePath } from './profile.mjs';
import { pvHandle, pvHello } from './proposal-votes.mjs';   // PV: proposal votes on foreign defs (profile side store, never the state hash)
import { definitionsCollectionText } from './defs-collection.mjs';   // F9: /data/effects.json = the definitions' cards
import { phylacteryConfig, possessArchivePick, phylacteryPick, releasedCompanions } from './possess.mjs';   // Possess / Phylactery (user ruling 2026-11-17)
import { boundReleaseOf, boundReleases, releasedBoundView } from './bound-release.mjs';   // bound-creature release judged on the frozen view (2026-11-19)

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -------- config via env --------
const PEER_LABEL        = process.env.PEER_LABEL        || 'player-1';          // human-readable
// When this peer is hosted inside the Android APK (nodejs-mobile), the Kotlin
// side sets CHAOSD6_MOBILE=1. That flag disables operations that require a
// POSIX subprocess fork (companion summons via spawn()) or a desktop toolchain
// (git / rad / ssh-agent via radicle-adapter). A desktop peer in the swarm
// absorbs the dropped responsibilities (companion spawn, dim push). Keep this
// list tight — the goal is "mobile is a full libp2p writer peer", not a
// stripped-down observer.
const IS_MOBILE         = process.env.CHAOSD6_MOBILE === '1';

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
const ALLIANCE          = process.env.ALLIANCE         || 'player';              // player | npc_a | npc_b | player_c | npc_c | player_d | npc_d
// Profile character (user ruling 2026-11-13): the launcher passes the profile file + character id; the
// character's stats / class / combo / deck replace the data entry's. CHARACTER_ID stays its base_character.
const PROFILE_FILE      = process.env.PROFILE_FILE     || '';
const PROFILE_CHAR_ID   = process.env.PROFILE_CHAR_ID  || '';
const PROFILE_TEAM      = process.env.PROFILE_TEAM     || '';
const TEAM_GATE         = process.env.TEAM_GATE === '1';                      // launched by "Join my team"
const TEAM_GATE_DOOR    = process.env.TEAM_GATE_DOOR   || '';
// Human hands: the player of side A and the player of the third team (C).
// Everything else is played by npcPlan().
const isHumanAlliance = (a) => a === 'player' || a === 'player_c' || a === 'player_d';   // D: the 4th team (user ruling 2026-11-15)
// HUMAN=1 (user ruling 2026-11-15, "you are always an ally of the one you click"): a human hand on a bot
// side — my profile hero joined next to a monster plays as npc_b (friend of the monsters, foe of the players).
// Local only: hostility stays sideOf(alliance) on every peer; only who plans my cards (me, not npcPlan) and
// what I am not (no sleeping monster_state, no monster deck, never isWildMonster) change.
// Unattended character (rule_unattended_character, user ruling 2026-11-16): the computer-operated stand-in for a
// hero whose game fell silent — SHADOW_OF = that hero's peer id. Never a human hand (npcPlan plays it as an allied
// bot that follows its master, unattendedLeader), on the hero's side.
const SHADOW_OF = process.env.SHADOW_OF || '';
const IS_HUMAN = !SHADOW_OF && (isHumanAlliance(ALLIANCE) || (process.env.HUMAN === '1' && !process.env.OWNER_PEER_ID));
// The ally-join link (user ruling 2026-11-16): the peer id of the unit I joined next to as its ally (launcher unit
// list → ALLY_OF), published as ally_of — unattended characters linked this way form one group under one master.
// A returning owner that takes its unattended character over leaves the group (heroShadowSeen clears it).
let allyOfNow = String(process.env.ALLY_OF || '').startsWith('peer:') ? String(process.env.ALLY_OF) : '';
const JOINED_AT = new Date().toISOString();   // published joined_at: the earliest join of a group is its master
const INSTANCE_ID = randomBytes(6).toString('hex');   // this process (snapshot `instance`): breaks a joined_at tie between two copies of one peer id
// A private test game (user 2026-11-16, "test games to be local and private"): no Door push (publishDoor), no
// unattended characters; the launcher also turns the Nostr bus off, binds loopback and picks an unguessable DIM_ID.
const DIM_PRIVATE = process.env.DIM_PRIVATE === '1';
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
// HUD telemetry only: the Doors this joiner was planned from (join-plan.mjs doorMapSummaries) — map share
// of nodes known only through their Door. Never read by the resolver.
let doorMaps = [];
try {
  if (process.env.DOOR_MAPS_FILE) {
    doorMaps = JSON.parse(fsSync.readFileSync(process.env.DOOR_MAPS_FILE, 'utf8'));
    fsSync.rm(process.env.DOOR_MAPS_FILE, { force: true }, () => {});
  }
} catch (e) { console.warn(`[${PEER_LABEL}] could not read door maps: ${e.message}`); }
if (!Array.isArray(doorMaps)) doorMaps = [];
// Local TMJ restore (set by the launcher when the user picks "Load a saved
// dimension"): hydrate blocks / obstacles / tokens / traps before the resolver
// state is built so the first revealAround on top sees a populated dimMap.
// A broken file falls back to a normal boot (don't crash the peer).
let _restoredTmj = null;
if (process.env.RESTORE_FROM_TMJ) {
  try {
    _restoredTmj = await autosaveLoadTmj(process.env.RESTORE_FROM_TMJ);
    // One block per contiguous row run (rect w×1, w ≤ 64), not one disc r=0 per tile: a save of 1,419 tiles
    // was 1,399 blocks, and every peer re-put each block into Gun each minute — the phone's Node heap went
    // to 2 GB in 1–10 minutes and aborted (OOM, 2026-11-14). The same tiles fit in ~60 rects.
    const restoreAt = new Date().toISOString(), rows = new Map();
    for (const t of _restoredTmj.tiles || []) { if (!rows.has(t.r)) rows.set(t.r, []); rows.get(t.r).push(t.q); }
    for (const [r, qs] of rows) {
      qs.sort((a, b) => a - b);
      for (let i = 0; i < qs.length;) {
        let w = 1;
        while (i + w < qs.length && qs[i + w] === qs[i] + w && w < 64) w++;
        seedBlocks.push({ id: `rect:${qs[i]},${r},${w}x1`, kind: 'rect', q: qs[i], r, w, h: 1, by: 'restore', at: restoreAt });
        i += w;
      }
    }
    console.log(`[${PEER_LABEL}] restore: ${process.env.RESTORE_FROM_TMJ} → ${_restoredTmj.tiles?.length || 0} tiles, ${_restoredTmj.obstacles?.length || 0} obstacles (schema ${_restoredTmj.meta?.schema_version})`);
  } catch (e) { console.warn(`[${PEER_LABEL}] RESTORE_FROM_TMJ failed (${e.message}) — booting normally`); _restoredTmj = null; }
}
let dimMap = null;   // created once Gun is up (see "the dimension map" below)
let mapSync = null;  // compare-then-pull map sync (map-sync.mjs), created next to dimMap
// MAP_SYNC_LEGACY=1 makes this peer behave like a pre-M3 build (test only): no `map_root`, no pull
// protocol, map blocks put into Gun. MAP_SYNC_FORCE_BUS=1 sends every pull over the bus (test only).
const MAP_SYNC_LEGACY = process.env.MAP_SYNC_LEGACY === '1';
const MAP_SYNC_FORCE_BUS = process.env.MAP_SYNC_FORCE_BUS === '1';
// HUD telemetry (pure display, never read by the resolver / state hash): a bottom-K sketch of the
// hexes this peer holds — the K smallest 32-bit tile hashes, ascending. It rides on the full public
// snapshot (`map_sketch`, ~0.9 KB) so every node can estimate which share of its own hexes another
// node also holds without anyone re-sending whole maps. See mapShareOf() / the `telemetry` message.
const MAP_SKETCH_K = 128;
let mapSketch = [];
let mapSketchCsvCache = null;
function tileHash(key) {   // FNV-1a + murmur3 finaliser: well spread even for "q,r" strings
  let h = hash32(key);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
function mapSketchAdd(key) {
  const h = tileHash(key), n = mapSketch.length;
  if (n >= MAP_SKETCH_K && h >= mapSketch[n - 1]) return;
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (mapSketch[m] < h) lo = m + 1; else hi = m; }
  if (mapSketch[lo] === h) return;
  mapSketch.splice(lo, 0, h);
  if (mapSketch.length > MAP_SKETCH_K) mapSketch.pop();
  mapSketchCsvCache = null;
}
function mapSketchCsv() { return mapSketchCsvCache ??= mapSketch.map(h => h.toString(36)).join(','); }
let _autosave = null;   // local TMJ autosave controller (see game/tools/autosave.mjs); _autosave?.markDirty() is a safe no-op before start()
// NOGUN=1: run without Gun (M6 step 1). The clock rides libp2p / bus `clock` frames, the directory the
// Door + bus `who` / replay — Gun's two jobs. Default stays Gun ON until a swarm confirms.
const NOGUN = !Gun;
const PEER_GUN_URLS     = NOGUN ? [] : (process.env.PEER_GUN_URLS   || '').split(',').filter(Boolean); // relays of other peers
const BOOTSTRAP_MADDRS  = (process.env.BOOTSTRAP || '').split(',').filter(Boolean);        // libp2p peers
const RADICLE_PUSH_SEC  = Number(process.env.RADICLE_PUSH_SEC || 600);           // first push at t=60s (end of turn 2 round 3 at 6s/round), then every 10 min
const RADICLE_PUSH_FIRST_SEC = Number(process.env.RADICLE_PUSH_FIRST_SEC || 60); // initial delay before the first door push — paper rule: 2nd turn, 3rd round = 60s
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
// Extra wait for a reveal whose commit we already hold (a phone over the Nostr bus is seconds slower).
const REVEAL_GRACE_MS   = Number(process.env.REVEAL_GRACE_MS  || 4000);
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
// Death-card gifts / team gates already handled, and the gate vision my UI still shows (user ruling
// 2026-11-13). Hoisted for the same reason: an envelope may arrive while the file is still booting.
const giftsSeen = new Set(), gatesSeen = new Set();
const visionGrants = [];   // { kind:'vision-grant', q, r, until_turn, from_name, reason } still running
// Public Nostr bus handle; created once the peer-state machinery below exists.
// Declared up here so emitEnvelope/publishPublicState can reference it safely.
let bus = null;
function broadcastUI(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of uiClients) { try { ws.send(payload); } catch {} }
}
// Foreign effects (chaosD6-Effects E4, effects-handshake.mjs): refs on commit / reveal, fetch + serve over
// /chaos/<dim>/effects/1 (bus `fx` fallback), `fx_have` on the slim snapshot. Inert with no foreign effect.
const fxPeer = await createFxPeer({ selfId: PEER_ID_STRING, label: PEER_LABEL, dimId: DIM_ID, ui: (m) => broadcastUI(m), nameOf: (pid) => { try { return peersPublic.get(pid)?.name || null; } catch { return null; } } });
// S4 foreign skills (skills-handshake.mjs, skills-data/HANDSHAKE.md): sk_ref on commit / reveal, sk_missing, sk_have;
// /chaos/<dim>/skills/1 + bus `sk`. Inert with no foreign skill.
const skPeer = await createSkPeer({ selfId: PEER_ID_STRING, label: PEER_LABEL, dimId: DIM_ID, ui: (m) => broadcastUI(m), nameOf: (pid) => { try { return peersPublic.get(pid)?.name || null; } catch { return null; } },
  onReady: (p) => { try { broadcastUI({ kind: 'skill_catalog', skill_ui: { [p.ref.id]: skillUiOf(p.ref.id) } }); } catch {} } });   // skill isolation: a ready foreign skill's UI facts (main.js skill_ui)
// CH foreign classes (classes-handshake.mjs): cl_ref on commit / reveal + the holder's snapshot (cl_ref_json) and Door,
// cl_missing, cl_have; /chaos/<dim>/classes/1 + bus `cl`. A ready foreign class joins CLASSES_IMPLEMENTED (classOf).
const clPeer = await createClPeer({ selfId: PEER_ID_STRING, label: PEER_LABEL, dimId: DIM_ID, ui: (m) => broadcastUI(m), nameOf: (pid) => { try { return peersPublic.get(pid)?.name || null; } catch { return null; } },
  onReady: (p) => { try { CLASSES_IMPLEMENTED.add(p.ref.id); broadcastUI({ kind: 'class_catalog', class_colours: { [p.ref.id]: classColours(p.ref.id) }, class_texts: { [p.ref.id]: p.shape.text }, class_ui: { [p.ref.id]: classUiOf(p.ref.id) } }); } catch {} } });

// -------- data layer (loaded directly from the shared folder) --------
const DATA_DIR = path.resolve(__dirname, '..', 'data');
// Building catalogues (what each map building / landmark is and does): the
// copy bundled next to the peer (mobile build), else the repo's assets/, else
// CHAOSD6_ASSETS_DIR. Every peer must read the same file or the building
// bonuses diverge — the short hash in the log line lets you compare peers.
for (const [rel, set] of [['features/feature_table.json', setFeatureCatalog], ['terrain_bigfeatures/bigfeature_table.json', setBigFeatureCatalog]]) {
  const tries = [path.resolve(__dirname, 'js', 'catalog', path.basename(rel)), path.resolve(__dirname, '..', 'assets', rel), ...(process.env.CHAOSD6_ASSETS_DIR ? [path.resolve(process.env.CHAOSD6_ASSETS_DIR, rel)] : [])];
  const hit = tries.find(f => fsSync.existsSync(f));
  if (!hit) { console.warn(`[catalog] ${rel} NOT FOUND (${tries.join(' | ')}) — building bonuses off on this peer; it will diverge from peers that have it`); continue; }
  const txt = fsSync.readFileSync(hit, 'utf8');
  set(JSON.parse(txt));
  console.log(`[catalog] ${path.basename(rel)} ${createHash('sha256').update(txt).digest('hex').slice(0, 10)} from ${hit}`);
}
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
for (const n of ['battle_system', 'actions', 'characters', 'creatures', 'classes', 'elements']) {
  const f = await loadJson(`${n}.json`);
  data[n] = Object.fromEntries(f.entries.map(e => [e.id, pickActive(e)]));
}
// Class isolation phase 1: the classes are the bundled definitions (game/classes-data), not data/classes.json.
// A broken definition would silently drop a class on this peer only: refuse to start instead.
if (classBundleErrors().length) { console.error(`[classes] invalid class definitions:\n  ${classBundleErrors().join('\n  ')}`); process.exit(1); }
data.classes = builtinClassEntries();
// Effect isolation F9: the effect cards are the definitions' card blocks (game/effects-data), not data/effects.json.
data.effects = builtinEffectEntries();
// Skill isolation: the skill cards are the definitions' card blocks (game/skills-data), not data/skills.json; a broken
// definition refuses to start (like the classes). The building skill list comes from their flags.buildingSkill.
if (skillBundleErrors().length) { console.error(`[skills] invalid skill definitions:\n  ${skillBundleErrors().join('\n  ')}`); process.exit(1); }
data.skills = builtinSkillEntries();
setBuildingSkills(SK_BUILDING_SKILLS, (id) => data.skills[id]?.name);
// Fortress stat buy (user ruling 2026-11-14): data/rules.json rule_building_fortress → js/building-bonus.js FORTRESS.
try { const fe = (await loadJson('rules.json')).entries.find(e => e.id === 'rule_building_fortress'); if (fe) configureFortress(pickActive(fe).data?.fortress); } catch (e) { console.warn(`fortress rule not loaded (${e.message}) — building-bonus.js defaults`); }
// Monster deck effects (user rulings 2026-11-15): data/rules.json rule_monster_deck_effects → game/monster-deck.mjs config.
let MONSTER_DECK_CFG = monsterDeckConfig(null);
try { const me = (await loadJson('rules.json')).entries.find(e => e.id === 'rule_monster_deck_effects'); if (me) MONSTER_DECK_CFG = monsterDeckConfig(pickActive(me).data?.monster_deck); } catch (e) { console.warn(`monster deck rule not loaded (${e.message}) — monster-deck.mjs defaults`); }
// Monster natural permanents (user rulings 2026-11-15): data/rules.json rule_monster_natural_permanents → game/natural-perms.mjs config.
let NATURAL_CFG = naturalConfig(null);
try { const ne = (await loadJson('rules.json')).entries.find(e => e.id === 'rule_monster_natural_permanents'); if (ne) NATURAL_CFG = naturalConfig(pickActive(ne).data?.natural_permanents); } catch (e) { console.warn(`natural permanents rule not loaded (${e.message}) — natural-perms.mjs defaults`); }
// Unattended characters (user ruling 2026-11-16, revised): data/rules.json rule_unattended_character → silence before
// a silent hero becomes unattended (120 s, the monster Shadows' GHOST_MS), how long it may stand alone (nobody within
// vanish_radius) before it leaves the dimension. Env SHADOW_MS / UNATTENDED_VANISH_MS override them (tests).
let SHADOW_CFG = { silence_ms: 120_000, vanish_after_ms: 3_600_000, vanish_radius: 10 };
try { const he = (await loadJson('rules.json')).entries.find(e => e.id === 'rule_unattended_character'); const hs = he && pickActive(he).data?.unattended; if (hs) SHADOW_CFG = { ...SHADOW_CFG, ...hs }; } catch (e) { console.warn(`unattended character rule not loaded (${e.message}) — defaults`); }
const SHADOW_MS = Number(process.env.SHADOW_MS) > 0 ? Number(process.env.SHADOW_MS) : Number(SHADOW_CFG.silence_ms) || 120_000;
const VANISH_MS = Number(process.env.UNATTENDED_VANISH_MS) > 0 ? Number(process.env.UNATTENDED_VANISH_MS) : Number(SHADOW_CFG.vanish_after_ms) || 3_600_000;
const VANISH_RADIUS = Number(SHADOW_CFG.vanish_radius) || 10;
// Dimension Out (user 2026-11-16): data/rules.json rule_dimension_out → how many paper rounds (engine turns) the
// channel takes and what interrupts it. Env DIM_OUT_ROUNDS shortens it (tests only). See dimOutStart.
let DIM_OUT_CFG = { rounds: 10, interrupted_by: ['move', 'attack', 'cast'] };
try { const de = (await loadJson('rules.json')).entries.find(e => e.id === 'rule_dimension_out'); const dd = de && pickActive(de).data?.dimension_out; if (dd) DIM_OUT_CFG = { ...DIM_OUT_CFG, ...dd }; } catch (e) { console.warn(`dimension out rule not loaded (${e.message}) — defaults`); }
const DIM_OUT_ROUNDS = Math.max(1, Number(process.env.DIM_OUT_ROUNDS) || Number(DIM_OUT_CFG.rounds) || 10);
// Combos (user ruling 2026-11-05): each character carries its own 3-slot
// `combo` array directly in data/characters.json versions[].data.combo (see
// char_oran_rief [M,B,P], char_pride_guardian [A,P,M], etc). `entity.combo`
// is set from that in the character entity init below; no separate catalog.
// elem_* → character stat key the element maps to (per elements.json data.stat).
// Used by the effect-damage math to look up the right stat for Σ(me - enemy).
// Golems and elementals (user spec): fixed stat blocks, summoned by their own
// effects. They live in the creature table like any monster (so a companion
// process can be one), but Summoning's random library skips them.
// Each creature carries a WBC3-asset sprite/sound block so the renderer can
// draw real art for golems/elementals instead of a glyph. Golems: Dark Dwarves
// (Iron / Bronze / Stone). Elementals: Temples (Air / Water / Earth). The
// mapping is thematic, not strict — Bronze doubles up because there are 4
// built-in golems but only 3 Golem sprite units. Sprite paths are relative
// to assets/ (served under /assets/* by ui-server). Sounds are WAV filenames
// under assets/Sounds/.
const CREATURE_ASSETS = {
  Stone:  { sprite: { idle: 'Sprites/Units/Dark Dwarves/Stone Golem/Stone Golem - idle [AAIX].png',
                      walk: 'Sprites/Units/Dark Dwarves/Stone Golem/Stone Golem - walk [AAIXw].png',
                      attack: 'Sprites/Units/Dark Dwarves/Stone Golem/Stone Golem - attack [AAIXa].png',
                      death: 'Sprites/Units/Dark Dwarves/Stone Golem/Stone Golem - death [AAIXd].png',
                      info:  'Sprites/Units/Dark Dwarves/Stone Golem/Stone Golem - info [AAIXi].png' },
            sound: { spawn: 'Sounds/SoundFX/Build.wav', attack: 'Sounds/SoundFX/Attack10.wav', death: 'Sounds/SoundFX/Assassination.wav' } },
  Bronze: { sprite: { idle: 'Sprites/Units/Dark Dwarves/Bronze Golem/Bronze Golem - idle [AAGX].png',
                      walk: 'Sprites/Units/Dark Dwarves/Bronze Golem/Bronze Golem - walk [AAGXw].png',
                      attack: 'Sprites/Units/Dark Dwarves/Bronze Golem/Bronze Golem - attack [AAGXa].png',
                      death: 'Sprites/Units/Dark Dwarves/Bronze Golem/Bronze Golem - death [AAGXd].png',
                      info:  'Sprites/Units/Dark Dwarves/Bronze Golem/Bronze Golem - info [AAGXi].png' },
            sound: { spawn: 'Sounds/SoundFX/Splash.wav', attack: 'Sounds/SoundFX/Attack10.wav', death: 'Sounds/SoundFX/Assassination.wav' } },
  Iron:   { sprite: { idle: 'Sprites/Units/Dark Dwarves/Iron Golem/Iron Golem - idle [AAJX].png',
                      walk: 'Sprites/Units/Dark Dwarves/Iron Golem/Iron Golem - walk [AAJXw].png',
                      attack: 'Sprites/Units/Dark Dwarves/Iron Golem/Iron Golem - attack [AAJXa].png',
                      death: 'Sprites/Units/Dark Dwarves/Iron Golem/Iron Golem - death [AAJXd].png',
                      info:  'Sprites/Units/Dark Dwarves/Iron Golem/Iron Golem - info [AAJXi].png' },
            sound: { spawn: 'Sounds/SoundFX/LongWhoosh.wav', attack: 'Sounds/SoundFX/Attack10.wav', death: 'Sounds/SoundFX/Assassination.wav' } },
  Air:    { sprite: { idle: 'Sprites/Units/Temples/Air Elemental/Air Elemental - idle [AAEA].png',
                      walk: 'Sprites/Units/Temples/Air Elemental/Air Elemental - walk [AAEAw].png',
                      attack: 'Sprites/Units/Temples/Air Elemental/Air Elemental - attack [AAEAa].png',
                      death: 'Sprites/Units/Temples/Air Elemental/Air Elemental - death [AAEAd].png',
                      info:  'Sprites/Units/Temples/Air Elemental/Air Elemental - info [AAEAi].png' },
            sound: { spawn: 'Sounds/SoundFX/LongWhoosh.wav', attack: 'Sounds/SoundFX/Attack10.wav', death: 'Sounds/SoundFX/Assassination.wav' } },
  Water:  { sprite: { idle: 'Sprites/Units/Temples/Water Elemental/Water Elemental - idle [AAEW].png',
                      walk: 'Sprites/Units/Temples/Water Elemental/Water Elemental - walk [AAEWw].png',
                      death: 'Sprites/Units/Temples/Water Elemental/Water Elemental - death [AAEWd].png',
                      info:  'Sprites/Units/Temples/Water Elemental/Water Elemental - info [AAEWi].png' },
            sound: { spawn: 'Sounds/SoundFX/Splash.wav', attack: 'Sounds/SoundFX/Attack10.wav', death: 'Sounds/SoundFX/Assassination.wav' } },
  Earth:  { sprite: { idle: 'Sprites/Units/Temples/Earth Elemental/Earth Elemental - idle [AAEE].png',
                      walk: 'Sprites/Units/Temples/Earth Elemental/Earth Elemental - walk [AAEEw].png',
                      attack: 'Sprites/Units/Temples/Earth Elemental/Earth Elemental - attack [AAEEa].png',
                      death: 'Sprites/Units/Temples/Earth Elemental/Earth Elemental - death [AAEEd].png',
                      info:  'Sprites/Units/Temples/Earth Elemental/Earth Elemental - info [AAEEi].png' },
            sound: { spawn: 'Sounds/SoundFX/Build.wav', attack: 'Sounds/SoundFX/Attack10.wav', death: 'Sounds/SoundFX/Assassination.wav' } },
};
const BUILT_IN_CREATURES = {
  mon_golem_worldlives:   { name: 'WorldLives Golem',   stats: { vitality: 10, world: 9,  matter: 5,  will: 0 }, life: 2, actions: 2, kind: 'golem',     assetKey: 'Bronze' },
  mon_golem_lifematters:  { name: 'LifeMatters Golem',  stats: { vitality: 10, world: 5,  matter: 9,  will: 0 }, life: 2, actions: 2, kind: 'golem',     assetKey: 'Bronze' },
  mon_golem_worldmatters: { name: 'WorldMatters Golem', stats: { vitality: 5,  world: 10, matter: 9,  will: 0 }, life: 2, actions: 2, kind: 'golem',     assetKey: 'Iron'   },
  mon_golem_living:       { name: 'Living Golem',       stats: { vitality: 20, world: 2,  matter: 2,  will: 0 }, life: 2, actions: 2, kind: 'golem',     assetKey: 'Stone'  },
  mon_elemental_world:    { name: 'World Elemental',    stats: { vitality: 5,  world: 20, matter: 5,  will: 0 }, life: 3, actions: 1, kind: 'elemental', assetKey: 'Air'    },
  mon_elemental_vital:    { name: 'Vital Elemental',    stats: { vitality: 20, world: 5,  matter: 5,  will: 0 }, life: 3, actions: 1, kind: 'elemental', assetKey: 'Water'  },
  mon_elemental_matter:   { name: 'Matter Elemental',   stats: { vitality: 5,  world: 5,  matter: 20, will: 0 }, life: 3, actions: 1, kind: 'elemental', assetKey: 'Earth'  },
};
for (const [id, b] of Object.entries(BUILT_IN_CREATURES)) {
  const resources = CREATURE_ASSETS[b.assetKey] ? { sprites: CREATURE_ASSETS[b.assetKey].sprite, sounds: CREATURE_ASSETS[b.assetKey].sound } : null;
  data.creatures[id] = { id, name: b.name, tags: ['summon_only', b.kind], data: { stats: { ...b.stats }, life: b.life, actions_per_round: b.actions, dice_pattern: null, innate_effect: null, innate_effect_text: '', on_action_rider: null, built_in: b.kind, resources } };
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
const myGunUrl = NOGUN ? '' : `http://${PEER_PUBLIC_IP}:${PEER_PORT_GUN}/gun`;   // '' = no relay (NOGUN): snapshots / Doors advertise none
console.log(`[${PEER_LABEL}] libp2p peer id = ${libp2p.peerId.toString()}`);
console.log(`[${PEER_LABEL}] bound ${BIND_HOST}:${PEER_PORT_LIBP2P}; advertising ${myMaddrs.join(', ')}`);

// Dial bootstrap peers.
for (const addr of BOOTSTRAP_MADDRS) {
  try { await libp2p.dial(multiaddr(addr)); console.log(`[${PEER_LABEL}] dialed ${addr}`); }
  catch (e) { console.warn(`[${PEER_LABEL}] dial ${addr} failed: ${e.message}`); }
}

// -------- GunDB relay (per peer) --------
const gunHttp = NOGUN ? null : http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('gun relay'); });
gunHttp?.listen(PEER_PORT_GUN, BIND_HOST);
// Gun needs its storage adapter to answer `get`s coming from OTHER relays —
// with `radisk: false` a put stays readable locally but every remote read is
// silently unanswered (tools/gun-selftest.mjs demonstrates it), which made
// the whole Gun tier a dead channel. Persisting to a shared folder, on the
// other hand, resurrected every previous run's members on restart (ghost
// peers in the roster). So: radisk on, but into a throw-away directory that
// is unique to this process, wiped at boot and again on exit.
const GUN_LABEL = String(PEER_LABEL).replace(/[^a-z0-9._-]+/gi, '_');
const GUN_DIR = path.join(os.tmpdir(), 'chaosd6-gun', _slug(DIM_NAME), `${GUN_LABEL}-${process.pid}`);
// Only our own label's leftovers: sibling peers of this dimension may be live — and so may another process with our
// label (a duplicate lurker that has not noticed us yet; swarm-2346 wiped the live copy's folder and it crashed): a
// folder whose pid still runs is left alone, and only `<label>-<pid>` is ours (not a `<label>-r1-<pid>` replacement).
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
try { for (const d of fsSync.readdirSync(path.dirname(GUN_DIR))) if (d.startsWith(`${GUN_LABEL}-`)) { const rest = d.slice(GUN_LABEL.length + 1), pid = Number(rest); if (/^\d+$/.test(rest) && (pid === process.pid || !pidAlive(pid))) fsSync.rmSync(path.join(path.dirname(GUN_DIR), d), { recursive: true, force: true }); } } catch {}
if (!NOGUN) try { fsSync.mkdirSync(GUN_DIR, { recursive: true }); } catch {}
// Gun's Node build always loads SEA, and lib/server.js defaults `opt.faith`
// to true, which routes data coming back from the store through
// SEA.opt.pack → a permissive JSON pre-parser that throws on some plain
// string values ("Cannot set properties of undefined" in yson.js) and took
// three peers down in one swarm run. `faith: false` keeps incoming data on
// the ordinary path; the wrapper below is the belt to that brace — if pack is
// ever reached and throws, log the value once and pass the data through.
if (Gun?.SEA?.opt?.pack) {
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
// NOGUN: an inert chain (get/map return itself, put/on do nothing) so the Gun call sites below stay as they are.
const nullGun = () => { const c = { get: () => c, map: () => c, on: () => c, once: () => c, off: () => c, put: () => c }; return c; };
const gun = NOGUN ? nullGun() : Gun({
  web: gunHttp,
  peers: PEER_GUN_URLS,              // mesh with the other peers' relays
  file: GUN_DIR,
  localStorage: false,
  axe: false,
  multicast: false,
  faith: false,
});
if (!NOGUN) netAttachGun(gun);
netStart({ label: PEER_LABEL });
const wipeGunDir = () => { try { fsSync.rmSync(GUN_DIR, { recursive: true, force: true }); } catch {} };
process.on('exit', wipeGunDir);
console.log(NOGUN ? `[${PEER_LABEL}] NOGUN=1 — Gun off: no relay, no client, no puts / reads` : `[${PEER_LABEL}] gun relay on ${myGunUrl}; peers = ${PEER_GUN_URLS.join(', ') || '(none yet)'}`);

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
// LIBP2P_DIAL=0: test only (tools/out/_gun_live.sh partition check) — never dial anyone, so with an
// unreachable PEER_PUBLIC_IP and NOSTR_ENABLED=0 this peer hears the others through Gun alone.
const LIBP2P_DIAL_OFF = process.env.LIBP2P_DIAL === '0';
async function dialPeerAddrs(peerId, addrs, force = false) {
  if (LIBP2P_DIAL_OFF) return;
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
  netStat('discovery', 'out', 'heartbeat', 80);
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
    netStat('discovery', 'in', 'peers', Number(r.headers.get('content-length')) || 0);
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
// The profile character this peer plays (read once at startup), or null.
const profileChar = (() => {
  if (!PROFILE_FILE || !PROFILE_CHAR_ID || !CHARACTER_ID) return null;
  try {
    const c = characterOf(loadProfile(PROFILE_FILE), PROFILE_CHAR_ID);
    if (!c) console.warn(`[${PEER_LABEL}] profile: no character ${PROFILE_CHAR_ID} in ${PROFILE_FILE} — playing ${CHARACTER_ID} as is`);
    return c;
  } catch (e) { console.warn(`[${PEER_LABEL}] profile: ${PROFILE_FILE} unreadable (${e.message}) — playing ${CHARACTER_ID} as is`); return null; }
})();
if (CHARACTER_ID) {
  const d = data.characters[CHARACTER_ID].data;
  const st = profileChar?.stats || d.stats;
  const sum = st.vitality + st.world + st.matter + st.will;
  entity = {
    kind: 'character', peerId: PEER_ID_STRING, name: ENTITY_NAME, alliance: ALLIANCE,
    tile: { ...START_TILE }, sourceId: CHARACTER_ID, sourceName: data.characters[CHARACTER_ID].name,
    stats: { ...st }, lifeMax: Math.max(1, Math.round(sum / 10)), life: Math.max(1, Math.round(sum / 10)),
    actionsPerRound: d.actions_per_round, combo: profileChar ? [...(profileChar.combo || [])] : (d.combo || []),
    permanents: new Set(),
  };
  if (profileChar) console.log(`[${PEER_LABEL}] profile: ${profileChar.name} (${profileChar.id}) — stats ${['vitality', 'world', 'matter', 'will'].map(k => st[k]).join('/')}, combo ${entity.combo.join('')}, class ${profileChar.class_id}`);
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
// A hero shadow fights with its hero's stats (a profile character's, as its last snapshot told them).
if (SHADOW_OF && entity.kind === 'character' && process.env.SHADOW_STATS_JSON) {
  try {
    const ss = JSON.parse(process.env.SHADOW_STATS_JSON);
    if (['vitality', 'world', 'matter', 'will'].every(k => Number.isInteger(ss[k]))) {
      entity.stats = { vitality: ss.vitality, world: ss.world, matter: ss.matter, will: ss.will };
      entity.lifeMax = entity.lifeMaxBase = Math.max(1, Math.round((ss.vitality + ss.world + ss.matter + ss.will) / 10));
      entity.life = entity.lifeMax;
    }
  } catch (e) { console.warn(`[${PEER_LABEL}] shadow: bad SHADOW_STATS_JSON (${e.message})`); }
}
// Fortress stat buy (user ruling 2026-11-14): my running bank against one fortress. The break bonus is a
// plain stat bonus token in entity.statTokens (effect_id FORTRESS_TOKEN_EFFECT), the same kind Artifice makes.
entity.fortressBank = null;     // { id: 'bld:q,r', stat, value, bank, turn, action }
// Rejoin from a save / replacing a running copy of me: keep the life I had
// (the launcher passes it), never more than my max, never a free corpse.
if (Number(process.env.START_LIFE) > 0) entity.life = Math.min(entity.lifeMax, Math.round(Number(process.env.START_LIFE)));
// Wild monster: a creature that isn't a companion and plays on the enemy side
// of the player. Spawns `sleeping` (does nothing) and flips to `awake` once any
// player sits within 2 hexes of us (user ruling 2026-11-05). Companions and
// summons never sleep. Characters are never monsters.
entity.monsterState = (entity.kind === 'creature' && !IS_COMPANION && !IS_HUMAN) ? 'sleeping' : null;
// Combo tracker (user ruling 2026-11-05): a character can declare an active
// combo via UI hotkey C; the resolver walks `entity.combo` one slot per
// revealed action (M-slot: M/EM/EP/P all match). Wrong card resets. Three
// correct slots fires a 1 dmg hit on an adjacent enemy (Rule 15) and resets.
// `slot` is the next-to-match index. Starts inert. Characters without a combo
// published in their data entry can't arm.
entity.comboState = { active: false, slot: 0 };
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
entity.permCopies = {};     // natural permanents (monster, rule_monster_natural_permanents): id → copies still standing (each of power permPower[id]); the id is in permanents ONCE
entity.petrifiedTurn = -1;  // natural Petrify: the turn an adjacent holder locked me for the rest of it
const statTokensJson = () => JSON.stringify(entity.statTokens);
const permPowerJson = () => JSON.stringify(entity.permPower);
const disablesJson = () => JSON.stringify(entity.disables);
const channelsJson = () => JSON.stringify(entity.channels);
const trapsJson = () => JSON.stringify(entity.traps);
const afflictionsJson = () => JSON.stringify(entity.afflictions);
const obstaclesJson = () => JSON.stringify(entity.obstacles);
const linksJson = () => JSON.stringify(entity.links);
const permCopiesJson = () => JSON.stringify(entity.permCopies);
// Rule 23: two copies of one effect cast together (Rule 22 chain: the shared
// elements go out once, so the cast takes one more emission than a single).
// Some ∀ bonuses turn the doubled effect into an instant instead (definition flag everyInstant, F2).
const castInstant = (c, every) => every ? !!EFFECT_RULES[c.effect_id]?.everyInstant : !!c.is_instant;
// F2 (definition flags): the permanent I hold doubled that my next cast goes out through (everyWidens: Aura ∀ — spent by
// it), and whether a permanent of mine keeps a cast going across a Rule 24 emission (keepsCastOnDestroy: Aura).
const everyWidener = () => [...entity.permanents].filter(id => EFFECT_RULES[id]?.everyWidens && entity.everyPerms.has(id)).sort()[0] || null;
const keepsCastOnDestroy = () => [...entity.permanents].some(id => EFFECT_RULES[id]?.keepsCastOnDestroy);
let planEmitSpends = null;   // F2: the permanent whose plan_emit (Empower) paid for this action's extra emission — spent after it
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
// F5: a stat-buy permanent that holds a creature says so in its flags — summon {kind: library | golem | elemental |
// resurrect, label (log name), need (fixed stat-buy total)}; Resurrect also carries flag resurrect (Death Ward).
const isSummonPerm = (id) => !!EFFECT_RULES[id]?.summon;
const summonLabel = (id) => EFFECT_RULES[id]?.summon?.label || null;
// F6: Possess / Phylactery is a game primitive (possess.mjs); the effect that uses it carries flag possess.
const isPossessPerm = (id) => !!EFFECT_RULES[id]?.possess;
const possessPermOf = (perms) => [...(perms || [])].filter(isPossessPerm).sort()[0] || null;
const phylReachOf = (id) => phylacteryConfig(data.effects[id]?.data?.phylactery).reach;
// F7: a Spirit Link permanent — cast (flag spiritLink) or a monster's natural link (naturalKind 'link').
const isLinkPerm = (id) => !!EFFECT_RULES[id]?.spiritLink || naturalKind(id) === 'link';
// F7: an Awake permanent (map surgery 'awake', game/awake.mjs) and one whose ∀ copy outlasts its broken channel.
const isAwakePerm = (id) => EFFECT_RULES[id]?.surgery === 'awake';
// F8: what the browser UI needs to know about an effect id (main.js names none) — flags + the definition's `ui` block.
const effectUiOf = (id) => {
  const r = EFFECT_RULES[id] || {}, u = EFFECT_UI[id] || {}, o = {};
  if (r.everyInstant) o.every_instant = true;
  if (r.hides) o.hides = true;
  if (isLinkPerm(id)) o.link = true;
  if (r.everyWidens) o.perm_action = 'aura'; else if (r.bonusPlans) o.perm_action = 'bonus'; else if (r.blessAttach) o.perm_action = 'bless';
  if (u.target_hint) o.target_hint = u.target_hint;
  if (u.perm_help) o.perm_help = u.perm_help;
  if (r.summon) o.summon = true;
  if (r.possess) o.possess = true;
  return o;
};
const effectUiMap = () => Object.fromEntries(Object.keys(EFFECT_RULES).sort().map(id => [id, effectUiOf(id)]).filter(([, o]) => Object.keys(o).length));
// Skill isolation: the same for the skills (skills.mjs skillUiOf: the definition's `ui` block + the resolver facts the UI needs).
const skillUiMap = () => Object.fromEntries(SKILLS_IMPLEMENTED.map(id => [id, skillUiOf(id)]).filter(([, o]) => o && Object.keys(o).length));
const everyOutlasts = (id) => !!EFFECT_RULES[id]?.everyOutlastsChannel && entity.everyPerms.has(id);
// Permanents with a fixed life (definition flag permTurns, F2): how many turns past the one they were placed in
// (Oblivion, Balefire(6): it vanishes with the end of my next turn).
const dropPermanent = (id) => {
  // A natural permanent stands in copies (rule_monster_natural_permanents): one falls at a time — its held card goes
  // to my ARCHIVE (user ruling 2026-11-15: out of circulation) — and only the last copy takes the permanent itself.
  const archiveNatural = () => { const c = heldCards.find(x => x.effect_id === id && x.natural); if (c) { releaseHeldCard(c.card_id, false); archive.push(c); console.log(`[${PEER_LABEL}] natural ${id}: the destroyed copy goes to my archive (${archive.length} archived, ${circulating()} circulating)`); } };
  if (entity.permanents.has(id) && (entity.permCopies[id] || 0) > 1) {
    const d = dropOneCopy(entity.permCopies, id);
    entity.permCopies = d.copies;
    archiveNatural();
    if (d.left < 2) entity.everyPerms.delete(id);   // natural Spirit Link: one copy left = a single link (Vitality)
    console.log(`[${PEER_LABEL}] natural ${id}: one copy destroyed — ${d.left} left`);
    return;
  }
  if (id in entity.permCopies) { entity.permCopies = dropOneCopy(entity.permCopies, id).copies; archiveNatural(); console.log(`[${PEER_LABEL}] natural ${id}: the last copy is destroyed — the permanent falls`); }
  const had = entity.permanents.has(id);
  entity.permanents.delete(id); delete entity.permPower[id]; delete entity.permUntil[id]; entity.everyPerms.delete(id);
  entity.shieldElems = entity.shieldElems.filter(x => !(x.permanent && x.perm === id));   // F2: a ∀ shield element (everyPermanent) goes with its permanent
  // MV: perm_falls — the effect under a falling Blessing and a trap it holds (Traps Mastery) go with it, cards → discard.
  applyHookRecords(effectHook('perm_falls', {}, { id, channels: entity.channels, traps: entity.traps }), {
    release_card: (x) => releaseHeldCard(x.card_id, x.to_discard ?? true),
    channels: (x) => { entity.channels = x.list; },
    traps: (x) => { entity.traps = x.list; },
  });
  if (isLinkPerm(id)) entity.links = [];
  if (isAwakePerm(id)) entity.awakeLend = null;   // Awake ∀: the lent stat goes with the permanent
  if (isPossessPerm(id) && entity.possessedBy) { console.log(`[${PEER_LABEL}] the Possess permanent in my holding is gone — I am my own again`); entity.possessedBy = null; }
  // Possess (2026-11-17): my Possess / Phylactery falls — the creature I play leaves (its card back to my archive
  // via onSummonEnd, unless it died: then possessEnd already dropped its summon entry).
  if (had && isPossessPerm(id)) { const was = entity.possessMode; entity.possessMode = null; if (entity.possessing) { console.log(`[${PEER_LABEL}] possess: my ${was === 'phylactery' ? 'Phylactery' : 'Possess'} permanent falls — I play my own hero again`); entity.possessing = null; } onSummonEnd(id); }
  if (had && isSummonPerm(id)) onSummonEnd(id);
  if (had && entity.wards.some(v => entity.wardBy[v] === id)) { entity.wards = entity.wards.filter(v => entity.wardBy[v] !== id); for (const v of Object.keys(entity.wardBy)) if (entity.wardBy[v] === id) delete entity.wardBy[v]; }   // F3: the wards this permanent placed
  // The card that made this permanent leaves the holding for the discard pile.
  if (had) releaseHeld(id);
};
// Permanent cards (user spec): a card whose permanent landed is not discarded —
// it sits in my permanents holding until the permanent falls, then it is discarded.
const heldCards = [];
const holdCard = (cid) => { for (let i = hand.length - 1; i >= 0; i--) if (hand[i].card_id === cid) { heldCards.push(...hand.splice(i, 1)); console.log(`[${PEER_LABEL}] ${heldCards[heldCards.length - 1].name} goes to my permanents holding (${heldCards.length} held)`); } };
const releaseHeld = (permId) => { for (let i = heldCards.length - 1; i >= 0; i--) { const c = heldCards[i]; if (c.effect_id === permId || c.skill_id === permId) { discard.push(...heldCards.splice(i, 1)); console.log(`[${PEER_LABEL}] ${c.name} leaves the holding for the discard pile`); } } };
// A trap card lies in the holding (face down on its tile) until it fires, then it is discarded.
// Possess (user ruling 2026-11-17, supersedes 2026-10-30): `entity.possessing = { peer_id, card_id, creature_id,
// name, at }` while my Possess permanent (in MY holding, entity.possessMode 'possess') holds the archive creature
// I play — a companion spawned with POSSESSED_BY = me, published as possessed_by. `entity.possessMode` =
// 'possess' | 'phylactery' | null (snapshot possess_mode). `entity.possessedBy`: I am that possessed creature.
entity.possessMode = null;
entity.possessedBy = process.env.POSSESSED_BY && process.env.OWNER_PEER_ID ? process.env.POSSESSED_BY : null;
const possessedUnit = () => {
  if (!entity.possessing || entity.possessMode !== 'possess' || !possessPermOf(entity.permanents)) return null;
  const v = peersPublic.get(entity.possessing.peer_id);
  return v && (v.life ?? 0) > 0 && v.possessed_by === PEER_ID_STRING ? v : null;
};
const releaseHeldCard = (cid, toDiscard = true) => { if (!cid) return; for (let i = heldCards.length - 1; i >= 0; i--) if (heldCards[i].card_id === cid) { const c = heldCards.splice(i, 1)[0]; if (toDiscard) discard.push(c); console.log(`[${PEER_LABEL}] ${c.name} is spent — ${toDiscard ? 'to the discard pile' : 'the card leaves my deck'}`); } };
entity.summons = [];        // [{ peer_id, creature_id, name, bound, perm, mode }] — creatures my permanents hold
entity.wards = [];          // peer ids under my Death Ward
entity.wardBy = {};         // ward peer id → the permanent that placed it (F3: dropped with it)
const companions = [];      // processes I spawned: { peer_id, label, proc, port, perm }
let summonSeq = 0;
const vanishedThisAction = [];   // { peer_id, name, q, r, bound } — for the UI (💨), rides out with the state hash
const releasedLogged = new Set();   // released companions the resolver already left out (logged once — possess.mjs releasedCompanions)
const freePort = () => new Promise((res, rej) => { const sv = net.createServer(); sv.on('error', rej); sv.listen(0, '127.0.0.1', () => { const prt = sv.address().port; sv.close(() => res(prt)); }); });
// A stat buy is paid: spawn the creature next to me, or note the one bound /
// raised for me, or set a Death Ward on an ally.
async function onSummoned(permId, sm) {
  const label = summonLabel(permId) || permId;
  // MV: summon_paid — effects-data/hooks/summon.json: archive_take → ward | revive_player | summon_add (revive / bind) |
  // summon_end (one creature per permanent) + drop_perm (one Elementals / one Golems, ruling 2026-11-12) + spawn — in order.
  let spawning = null;
  // DW: summon_paid_args — wards: my Death Wards, cleared by a Resurrect recast (ruling 2026-11-19)
  applyHookRecords(effectHook('summon_paid', {}, { perm_id: permId, sm, summons: entity.summons, permanents: [...entity.permanents], held: heldCards.map(c => c.effect_id || c.skill_id), wards: [...entity.wards] }), {
    release_held: (x) => releaseHeld(x.perm),   // a same-type recast (Golems / Elementals / Summoning / Resurrect): the old card → discard (ruling 2026-11-19); the new one is still in hand
    ward_clear: (x) => {   // DW: ward_clear — a Resurrect recast: the Death Ward the earlier cast placed is gone (ruling 2026-11-19; wards_csv in my next snapshot)
      entity.wards = entity.wards.filter(id => !x.peers.includes(id)); for (const id of x.peers) delete entity.wardBy[id];
      console.log(`[${PEER_LABEL}] a new Resurrect — my earlier Death Ward on ${x.peers.map(id => id.slice(0, 12)).join(', ')} is gone`);
    },
    archive_take: (x) => { const i = archive.findIndex(c => c.card_id === x.card_id); if (i >= 0) archive.splice(i, 1); },
    ward: (x) => {
      if (!entity.wards.includes(x.peer_id)) entity.wards.push(x.peer_id);
      entity.wardBy[x.peer_id] = permId;
      console.log(`[${PEER_LABEL}] Death Ward on ${sm.name || x.peer_id.slice(0, 12)}: when they would die they stand at 1 hp on their entry hex`);
    },
    revive_player: () => { console.log(`[${PEER_LABEL}] ${label} paid (${sm.need}): ${sm.name} is back among the living — the permanent is spent`); dropPermanent(permId); },
    summon_add: (x) => {
      entity.summons.push(x.summon);
      if (x.summon.mode === 'revive') console.log(`[${PEER_LABEL}] ${label} paid (${sm.need}): ${sm.name} rises again as my ally`);
      else console.log(`[${PEER_LABEL}] ${label} ∀: ${sm.name} (${x.summon.peer_id.slice(0, 12)}) is bound to me`);
    },
    summon_end: (x) => { console.log(`[${PEER_LABEL}] a new ${label} — the creature it held is released`); onSummonEnd(x.perm); },
    drop_perm: (x) => { console.log(`[${PEER_LABEL}] the new ${label} replaces my ${summonLabel(x.id) || x.id}`); dropPermanent(x.id); },
    spawn: (x) => {   // always the last record
      const cre = data.creatures[x.creature_id];
      if (!cre) return;
      spawning = spawnCompanion(permId, { creature_id: x.creature_id, name: cre.name, env: { CHARACTER_ID: '', CREATURE_ID: x.creature_id, ENTITY_NAME: `${cre.name} (${PEER_LABEL}'s)` } })
        .then(tag => { if (tag) console.log(`[${PEER_LABEL}] ${label} paid (${sm.need}): ${cre.name} enters as ${tag}`); });
    },
  });
  if (spawning) await spawning;
}
// Phantom (user spec 2026-10-29): a copy of me — same character, stats and deck — fights for me
// next to me while the permanent stands; it falls at the first point of damage (PHANTOM=1 in the child).
async function spawnPhantom(permId) {
  // A Phantom recast while my Phantom stands: the old card leaves the holding for the discard pile at once (ruling
  // 2026-11-19, as summon_paid release_held); the new card is still in hand and is held at the end of the action.
  if (heldCards.some(c => c.effect_id === permId)) releaseHeld(permId);
  if (entity.kind !== 'character') { console.log(`[${PEER_LABEL}] phantom: only a character can mirror itself`); return; }
  if (entity.summons.some(x => x.perm === permId)) onSummonEnd(permId);
  const tag = await spawnCompanion(permId, { creature_id: null, name: `${entity.name} (phantom)`, env: { CHARACTER_ID, CREATURE_ID: '', ENTITY_NAME: `${entity.name} (phantom)`, PHANTOM: '1', FORCE_CLASS: entity.classId || '', ...(clPeer.mine ? { FOREIGN_CLASS_REF_JSON: JSON.stringify(clPeer.mine.ref) } : {}) } });   // CH: a foreign class rides by ref
  if (tag) console.log(`[${PEER_LABEL}] phantom: my mirror enters as ${tag}`);
}
// A companion process on the free tile next to me (nearest free one within two hexes if all six are taken).
// `at`: enter on that hex (or next to it); `ringOnly`: next to it only; `wild`: an unowned monster
// (a lurker by a building trap, or the replacement of a vanished one) — no owner, no permanent holds it.
async function spawnCompanion(permId, { creature_id, name, env: extraEnv, at = null, ringOnly = false, wild = false, label = null, ignore = null }) {
  const occ = new Set(livePeers().filter(p => p && p.life > 0 && p.peer_id !== ignore).map(p => `${p.tile_q},${p.tile_r}`)); occ.add(`${entity.tile.q},${entity.tile.r}`);
  // A companion that is still booting has no snapshot yet: its entry tile counts as taken (two summons
  // cast close together used to land on the same hex).
  for (const c of companions) { const p = peersPublic.get(c.peer_id); const t = p && Number.isInteger(p.tile_q) && (p.life ?? 1) > 0 ? { q: p.tile_q, r: p.tile_r } : c.tile; if (t) occ.add(`${t.q},${t.r}`); }
  const base = at || entity.tile;
  const ring1 = hexNeighbours(base.q, base.r);
  const ring2 = [...new Set(ring1.flatMap(t => hexNeighbours(t.q, t.r)).map(t => `${t.q},${t.r}`))].map(k => k.split(',').map(Number)).map(([q, r]) => ({ q, r }));
  const tile = [...(at && !ringOnly ? [at] : []), ...ring1, ...ring2].find(t => dimMap.has(t.q, t.r) && !occ.has(`${t.q},${t.r}`) && !isLabyrinthWallAt(MAP_SEED, t.q, t.r));
  if (!tile) { console.log(`[${PEER_LABEL}] ${permId || 'spawn'}: no free tile around (${base.q},${base.r}) — ${name} cannot enter`); return null; }
  const tag = label || `${PEER_LABEL}-sum${++summonSeq}`;
  const [pL, pH, pG] = await Promise.all([freePort(), freePort(), freePort()]);
  const blocksFile = path.join(os.tmpdir(), `chaos-summon-${tag.replace(/[^a-z0-9._-]+/gi, '_')}-${Date.now()}.json`);
  fsSync.writeFileSync(blocksFile, JSON.stringify(dimMap.blocks()));
  const env = {
    ...process.env,
    PEER_LABEL: tag, ALLIANCE: wild ? 'npc_b' : npcAllianceOf(MY_SIDE), START_TILE: JSON.stringify(tile),
    PEER_PORT_LIBP2P: String(pL), PEER_PORT_HTTP: String(pH), PEER_PORT_GUN: String(pG),
    MAP_SEED, MAP_BLOCKS_FILE: blocksFile, BOOTSTRAP: [...myMaddrs, ...BOOTSTRAP_MADDRS].join(','), PEER_GUN_URLS: [myGunUrl, ...PEER_GUN_URLS].join(','),
    JOIN_SYNC_WAIT_MS: '4000', OWNER_PEER_ID: wild ? '' : PEER_ID_STRING, FORCE_EFFECTS: '', FORCE_SKILLS: '', FORCE_OPENING: '', FORCE_ARCHIVE: '', FORCE_CLASS: wild && process.env.FORCE_CLASS_MONSTERS === '1' ? (process.env.FORCE_CLASS || '') : '', REPLACES_PEER_ID: '', START_LIFE: '', START_ACTION: String(hg.action), START_CLOCK_SRC: `spawner ${PEER_LABEL}`, START_TURN: '', START_ROUND: '',
    PROFILE_FILE: '', PROFILE_CHAR_ID: '', PROFILE_TEAM: '', TEAM_GATE: '', TEAM_GATE_DOOR: '', HUMAN: '',
    SHADOW_OF: '', SHADOW_STATS_JSON: '', SHADOW_DEATH_CARD: '', SHADOW_PROFILE_CHAR_ID: '', ALLY_OF: '', DIM_OUT_ON_START: '',
    RAISED_BY: String(permId || '').startsWith('class_') ? permId : '',   // C1 ruling 2026-11-16: a class-raised companion (Necromancer)
    FORCE_FOREIGN_CLASS: '', FOREIGN_CLASS_REF_JSON: '',   // CH: a companion does not inherit my foreign class (the phantom passes it below)
    ...(process.env.TEST_PRIORITY === '1' ? { FORCE_FOREIGN_SKILL: '', FORCE_FOREIGN_EFFECT: '', FOREIGN_CARD_REFS_JSON: '', TEST_PRIORITY: '' } : {}),   // nor my Test Random drafts (test-priority.mjs)
    POSSESSED_BY: '',   // Possess 2026-11-17: only the creature my Possess brings in gets it (extraEnv)
    ...extraEnv,
  };
  delete env.MAP_BLOCKS;
  const proc = IS_MOBILE ? await spawnCompanionWorker(env) : spawn(process.execPath, [fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', b => process.stdout.write(b));
  proc.stderr.on('data', b => process.stderr.write(b));
  proc.on('exit', (c) => { console.log(`[${PEER_LABEL}] summoned ${tag} left (${c ?? 'signal'})`); const i = companions.findIndex(x => x.proc === proc); if (i >= 0) companions.splice(i, 1); });
  companions.push({ peer_id: `peer:${tag}`, label: tag, proc, port: pH, perm: permId, tile, wild });
  if (!wild) entity.summons.push({ peer_id: `peer:${tag}`, creature_id, name, bound: false, perm: permId, mode: 'spawn' });
  console.log(`[${PEER_LABEL}] ${name} enters at (${tile.q},${tile.r}) as ${tag}`);
  return tag;
}
// Android: nodejs-mobile runs one Node per app and the sandbox won't exec a
// second `node`, so the companion is a worker thread instead — its own module
// instance of peer.mjs (via mobile-entry.mjs for the Node 18 polyfills), own
// ports, same env contract. Returned with the child-process surface the
// callers use (stdout/stderr/on('exit')/kill). Its "UI socket on ws://…" line
// is reworded so the plugin's node_ready match (an unanchored
// `(?:peer listening on|UI socket on ws://)127.0.0.1:N`) never repoints the
// HUD at it — a prefix alone still matched, and summoning a Golem turned the
// phone into the Golem. Line-buffered so the phrase can't straddle chunks.
async function spawnCompanionWorker(env) {
  const { Worker } = await import('node:worker_threads');
  const { Transform } = await import('node:stream');
  delete env.JOIN_URI;
  const w = new Worker(new URL('./mobile-entry.mjs', import.meta.url), { env, stdout: true, stderr: true });
  (globalThis.__chaosWorkers ||= []).push(w);   // the phone's Dimension Out stops them with me (mobile-entry.mjs)
  const reword = (s) => s.replace(/UI socket on ws:\/\//g, 'companion UI socket at ').replace(/peer listening on/g, 'companion listening at');
  const relabel = () => {
    let tail = '';
    return new Transform({
      transform(chunk, _enc, cb) { const lines = (tail + chunk).split('\n'); tail = lines.pop(); cb(null, lines.length ? reword(lines.join('\n') + '\n') : ''); },
      flush(cb) { cb(null, tail ? reword(tail) : ''); },
    });
  };
  const stdout = w.stdout.pipe(relabel()), stderr = w.stderr.pipe(relabel());
  return { stdout, stderr, on: (ev, fn) => w.on(ev, fn), kill: () => { w.terminate().catch(() => {}); } };
}
// A creature-holding permanent is gone: its creature vanishes (companion: told
// directly; bound: it watches my snapshot); its card goes to my archive.
function onSummonEnd(permId) {
  const label = summonLabel(permId) || permId;
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
  for (const c of companions) if (entity.permanents.has(c.perm)) fetch(`http://127.0.0.1:${c.port}/summon-hold?q=${entity.tile.q}&r=${entity.tile.r}&life=${entity.life}`, { signal: AbortSignal.timeout(1500) }).catch(() => {});
}, 2000);
// Bound to `owner` (∀ Summoning took me, or Resurrect raised me): I fight on
// their side and follow them until the permanent that holds me falls.
let boundOriginalAlliance = null, boundMode = null, boundPerm = null, boundAt = null;   // boundAt: the action whose resolution bound me (snapshot bound_at)
// C1 ruling 2026-11-16 (Necromancer destroy reanimated): a unit a CLASS raised says so in its snapshot (raised_by = the
// class id) — a companion that class spawned (env RAISED_BY) or a corpse it raised in place (bound revive by a class_
// perm). Absent otherwise (other snapshots unchanged). The elements already struck on it live in its class_state_json
// (<raised_by>.down; phase 5 dropped the reanim_down_csv copy — js/main.js reads the class state).
// Class state (phase 2): mine (csGet / csSet) and another unit's, as its snapshot carries it (csOf).
const csGet = (cls, key, dflt) => CS.stateGet(entity.classStore, cls, key, dflt);
const csSet = (cls, key, v) => CS.stateSet(entity.classStore, cls, key, v);
const csOf = (snap) => CS.parseClassState(snap?.class_state_json);
const RAISED_BY = /^class_[a-z0-9_]+$/.test(process.env.RAISED_BY || '') ? process.env.RAISED_BY : '';
const raisedBy = () => RAISED_BY || (boundMode === 'revive' && String(boundPerm || '').startsWith('class_') ? boundPerm : '');
const reanimFields = () => { const by = raisedBy(); return by ? { raised_by: by } : {}; };
// Class isolation phase 5: one structured line per class event that took effect — tools/swarm-test.mjs counts them per
// class + kind (no regex per class). Log text only, never hashed; printed beside the human line it shadows (log() in
// the resolver, so quiet re-runs stay silent). kinds: ability (a click that took effect, the clicker), trap_charge /
// threat_charge (the mover), disable_active / disable_passive (the disabler), swap (every peer), contact (the holder).
const classEventLine = (cls, kind) => `[${PEER_LABEL}] [class-event] ${JSON.stringify({ class: cls, kind })}`;
function becomeBound(owner, permId, mode) {
  if (IS_COMPANION) return;
  const o = peersPublic.get(owner);
  const side = o ? sideOf(o.alliance) : 'A';
  if (boundOriginalAlliance === null) boundOriginalAlliance = entity.alliance;
  entity.alliance = npcAllianceOf(side); MY_SIDE = side;
  ownerPeerId = owner; ownerSeenHolding = true; boundMode = mode; boundPerm = permId; boundAt = hg.action;
  console.log(`[${PEER_LABEL}] ${mode === 'revive' ? 'raised' : 'bound'} by ${owner.slice(0, 12)}'s ${summonLabel(permId) || permId} — I fight for side ${side} now`);
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
let ownerSeenHolding = false, vanishing = false, boundSeenListed = false;   // boundSeenListed: my owner's summoned_csv has named me
let ownerHoldAt = Date.now();   // companion: when my owner last told me they still hold the permanent
let ownerHint = null;            // companion: { tile_q, tile_r, life, at } off that heartbeat — follow it even when gossip lags
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
  // Bound (2026-11-19): the release is the RESOLVER's — every peer judges it at the same action from the frozen view
  // (bound-release.mjs: my bound_* marker vs my owner's life / permanents_csv / summoned_csv / resolved_action), and
  // doResolution applies it to me via applyBoundRelease. This timer only follows: the same rule on live gossip, noted
  // once; it never flips my state (flipping on gossip let peers learn the release at different actions).
  const rel = boundReleaseOf(PEER_ID_STRING, boundSnapshotFields(), peersPublic.get(ownerPeerId));
  if (rel && boundPendingNoted !== `${rel.perm}@${rel.at}`) { boundPendingNoted = `${rel.perm}@${rel.at}`; console.log(`[${PEER_LABEL}] bound: my owner's gossip shows ${rel.why} — my release lands at the next resolution`); }
}, 1500);
let boundPendingNoted = '', boundWasReleased = false;
// My bound marker (snapshot): whose permanent holds me, which, how, since which action, and my alliance before.
// Once released: bound_to '' (receivers MERGE snapshots — mergePeerState — so an absent field would keep the old marker).
function boundSnapshotFields() {
  if (!IS_COMPANION && ownerPeerId && boundMode && boundPerm) return { bound_to: ownerPeerId, bound_perm: boundPerm, bound_mode: boundMode, bound_at: boundAt ?? -1, bound_alliance: boundOriginalAlliance || ALLIANCE };
  return boundWasReleased ? { bound_to: '' } : {};
}
// The resolver judged my release (bound-release.mjs boundReleases on its view): apply it — idempotent (only the bind it
// names; a second call, or a stale record after a re-bind, does nothing). → true when it changed my state.
function applyBoundRelease(rel) {
  if (IS_COMPANION || !ownerPeerId || !rel || rel.owner !== ownerPeerId || rel.perm !== boundPerm || rel.at !== boundAt) return false;
  if (boundMode === 'revive') {
    console.log(`[${PEER_LABEL}] the ${summonLabel(boundPerm) || 'permanent'} that raised me is gone — I fall again (${rel.why})`);
    entity.life = 0;
  } else {
    console.log(`[${PEER_LABEL}] the ${summonLabel(boundPerm) || 'permanent'} that bound me is gone — back to my own side (${rel.why})`);
    entity.alliance = rel.alliance || boundOriginalAlliance || ALLIANCE; MY_SIDE = sideOf(entity.alliance);
  }
  boundOriginalAlliance = null; boundMode = null; boundPerm = null; boundAt = null; ownerPeerId = null; ownerSeenHolding = false; boundSeenListed = false; boundWasReleased = true;
  return true;   // no publish here (mid-resolution): endRound publishes the resolved state
}
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
// C1: the class rules are classes.mjs hooks; CL_BASE is the ctx of the hooks that only read class data.
const CL_BASE = { classData: (id) => data.classes[id]?.data, elemStat: (el) => ELEM_TO_STAT[el], sha: (s) => sha256Hex(s) };
const clWith = (h) => Object.keys(CLASS_RULES).filter(id => (CLASS_RULES[id].hooks || []).includes(h));   // C1: the classes answering hook h
const classColours = (classId) => classHook('colours', classId, CL_BASE);   // C1 colours
// Elementalist and Rogue are passive (user ruling 2026-11-12): they fire by themselves, once per turn.
const PASSIVE_TURN_CLASSES = CL_PASSIVE;   // C1 (CLASS_RULES passiveTurn: Elementalist, Rogue, Manipulator)
// Hand classes (user rework 2026-11-14), read from the class data with these fallbacks:
//   hand_reveal  {n: 3|'all'}                    Prophet: the whole hand of the first enemy in contact (passive, once per turn, a popup)
//   (Avenger, user rework #2 2026-11-14: lure_range / chase_bonus — class-chase.mjs, no hand look any more)
//   hand_discard {n, every?: 'action'|'turn'}    Witch 3 random cards (tap)   (Priest raises a Shrine since the 2026-11-14 rework)
//   range        "nearby" in hexes (default 3); passive: true → fires by itself (no click)
const classDataOf = (classId) => data.classes[classId]?.data || (isClassSuspended(classId) ? null : foreignClassDef(classId)?.data) || {};   // CH: a foreign class reads its definition
// C1: CLASS_RULES handDefaults (Prophet: hand_reveal all + passive; Witch: hand_discard 3).
const HAND_CLASS_DEFAULTS = Object.fromEntries(Object.entries(CLASS_RULES).filter(([, r]) => r.handDefaults).map(([id, r]) => [id, r.handDefaults]));
const classRangeOf = (classId) => Number.isInteger(classDataOf(classId).range) ? classDataOf(classId).range : 3;
const handRevealOf = (classId) => classDataOf(classId).hand_reveal || HAND_CLASS_DEFAULTS[classId]?.hand_reveal || null;
const handDiscardOf = (classId) => classDataOf(classId).hand_discard || HAND_CLASS_DEFAULTS[classId]?.hand_discard || null;
const classPassive = (classId) => PASSIVE_TURN_CLASSES.has(classId) || !!(classDataOf(classId).passive ?? HAND_CLASS_DEFAULTS[classId]?.passive);
const classKindOf = (classId) => classHook('kind', classId, CL_BASE);   // C1 kind (= classPassive ? 'passive' : ability_kind || 'static')
// CH: a foreign (player-branch) class — FORCE_FOREIGN_CLASS=<def.json> (dev / test), a hero shadow's
// FOREIGN_CLASS_REF_JSON, or my profile character's class_ref (cache first, then git / httpd). null = built-in path.
const foreignBootClass = await clPeer.boot(process.env.FORCE_FOREIGN_CLASS ? { file: process.env.FORCE_FOREIGN_CLASS }
  : { ref: process.env.FOREIGN_CLASS_REF_JSON || (profileChar?.class_ref && profileChar.class_ref.id === profileChar.class_id ? profileChar.class_ref : null) });
{
  // FORCE_CLASS may list several (test runs): a peer named in FORCE_CLASS_LABELS (swarm-run.sh: every hero
  // label in order) takes the list round-robin by its position there, so each listed class is held; any other
  // peer takes one by its label's hash. Env plumbing only — no rule reads this.
  const forcedList = (process.env.FORCE_CLASS || '').split(',').map(s => s.trim()).filter(Boolean);
  const forcedAt = (process.env.FORCE_CLASS_LABELS || '').split(',').map(s => s.trim()).filter(Boolean).indexOf(PEER_LABEL);
  const forced = forcedList.length > 1 ? forcedList[forcedAt >= 0 ? forcedAt % forcedList.length : parseInt(sha256Hex(`fclass:${PEER_LABEL}`).slice(0, 8), 16) % forcedList.length] : (forcedList[0] || '');
  const pool = Object.keys(data.classes).sort();
  // A profile character keeps the class it was created with (user ruling 2026-11-13).
  let cls = foreignBootClass ? foreignBootClass.id   // CH: a foreign class I booted with
    : profileChar && data.classes[profileChar.class_id] ? profileChar.class_id : forced && data.classes[forced] ? forced : null;
  // A monster's class follows from its creature id (every peer derives the same one); a character draws one.
  if (!cls && entity.kind === 'creature') cls = pool[parseInt(sha256Hex(`class:${CREATURE_ID}`).slice(0, 8), 16) % pool.length];
  if (!cls) cls = pool[Math.floor(Math.random() * pool.length)];
  entity.classId = cls;
  entity.className = data.classes[cls]?.name || clPeer.info(cls)?.name || cls;   // CH: a foreign class's own name
  entity.permanents.add(cls);
  // Per-round combat flags set & cleared by the resolver so static abilities
  // can be stateful without leaking across rounds (Guardian: has moved?,
  // Assassin: already dealt damage?). Fresh on peer start.
  entity.classFlags = { movedThisRound: false, dealtDamageThisRound: false };
  entity.classDown = [];          // colours (stats) an enemy has already struck down
  entity.classArchived = false;   // the class card lies in my archive (every colour fell)
  entity.classTapped = false;     // a tap ability was used and not yet untapped
  entity.classProgress = null;    // { mode: 'recast'|'untap', done: [stats] }
  entity.classUsedTurn = -1;      // hg.turn a once-per-turn ability was last used (R2, 2026-10-30)
  entity.armor = 0;               // Overlord's armor life point (0/1) — folded into life / lifeMax, the first one lost
  entity.illusion = 0;            // Illusionist's illusion life point (0/1) — same, lost first, fades after the turn's 3rd action
  entity.illusionTurn = -1;
  entity.luredBy = null;          // wild monster: { id, turn } — the Avenger that lured me; I chase it until it dies / leaves
  entity.chaseTarget = '';        // wild monster: the enemy my last npcPlan went after (snapshot chase_target)
  // Class isolation phase 2 (class-state.mjs): my class state, one store namespaced by class id → snapshot class_state_json.
  //   class_rogue.charges.threat / .trap {turn, n}  Rogue charges (threat: monsters neither wake nor chase me that turn;
  //                                                 trap: uses per turn, class data trap_dodges_per_turn)
  //   class_avenger.bonus / .chasers                temporary life point from a NEW chasing monster (0/1, folded into
  //                                                 life / lifeMax, lost after illusion / armor) / the wild monsters chasing
  //                                                 me at my last resolution (sorted ids)
  //   class_necromancer.raised                      corpses I raised (no second raise of the same one)
  //   <raised_by>.down                              a reanimated unit: the elements already struck on it
  entity.classStore = {};
  entity.worldEdits = [];         // what I did to world-generated features: { id, gone, at } | { id, q, r, at }
  entity.worldLedger = [];        // every OTHER author's world edits I have seen ({ ...edit, by }) — dimension state (js/world-ledger.js)
  entity.awakeLend = null;        // Awake ∀: { stats: { will: n } | building stat bonus, from } while the permanent stands
  console.log(`[${PEER_LABEL}] class ${cls} (${classKindOf(cls)}; colours ${Object.keys(classColours(cls)).join('/')})${foreignBootClass ? ` (foreign ${foreignBootClass.ref.sha256.slice(0, 16)}, ${foreignBootClass.ref.branch || 'no branch'})` : profileChar ? ' (profile)' : forced ? ' (forced)' : ''}`);
}
const classCard = () => ({ card_id: `${entity.classId}#class`, kind: 'class', class_id: entity.classId, name: entity.className, text: data.classes[entity.classId]?.data?.text || clPeer.info(entity.classId)?.text || '',
  ...(clPeer.mine && clPeer.mine.ref.id === entity.classId ? { tags: ['foreign'], source: { ...clPeer.mine.ref, kind: 'class' } } : {}) });   // CH: a foreign class card carries its source (badge)
let queuedClassAbility = false;   // the class card was clicked for this action (WS `class_ability`)
// What a class ability needs picked before it goes out: an enemy / ally / tile target, or a hand card (queuedAttach).
// C1: CLASS_RULES needs — tile (Animator, Priest, Alchemist, Warrior), ally_or_self (Healer, Overlord),
// enemy_near (Witch: the right-clicked enemy within range, else the nearest), monster_near (Avenger: nothing to
// pick), attach_effect (Ranger, Seeker). Manipulator and Prophet are passive.
// A foreign class's flags join CLASS_RULES at registration (classes.mjs CL_NEEDS is built from the built-ins at import):
// read needs from CLASS_RULES so a player-branch class asks for its target too (gen classes, 2026-11-23).
const classNeeds = (id) => CLASS_RULES[id]?.needs || CL_NEEDS[id] || null;
// Abilities settled on this peer alone (hand / deck / discard are private). Return a note when it fired.
// C1: the `local` hook gives the descriptor ({op: recover|draw|grant}); applying it stays here (private hand).
const CLASS_LOCAL = Object.fromEntries(Object.keys(CLASS_RULES).filter(id => CLASS_RULES[id].phase === 'local').map(id => [id, () => {
  const d = classHook('local', id, CL_BASE);
  if (d?.op === 'recover') return recoverFromDiscard(c => c.kind === d.kind, d.what);
  if (d?.op === 'draw' && Number.isInteger(d.max_hand) && hand.length > d.max_hand) return null;   // CR: weapon_master — inactive above 3 cards in hand (2026-11-17)
  if (d?.op === 'draw') {   // CP: wm_draw_n — local.n cards (Weapon master 2, pick 2026-11-19 #1 a)
    const want = Number.isInteger(d.n) && d.n > 0 ? d.n : 1;
    let got = 0;
    for (let i = 0; i < want; i++) { reshuffleIfEmpty(); if (!deck.length) break; hand.push(deck.shift()); got++; }
    if (!got) return null;
    return `${got === 1 ? 'an extra card' : `${got} extra cards`} drawn (${hand.length} in hand)`;
  }
  if (d?.op === 'grant') { if (!data.effects[d.effect_id]) return null; const c = makeEffectCard(d.effect_id); c.from_class = id; hand.push(c); return 'a Summoning rides into my hand — cast it (stat buy) to call a Library creature'; }
  return null;
}]));
// Class isolation phase 4 (2026-11-20): what a class does is read from its definition (hooks, flags, config), never
// from its id. hasHook: the class answers hook h (flags.hooks); clShort / clName: its id without class_ / its name.
const hasHook = (cls, h) => !!cls && (CLASS_RULES[cls]?.hooks || []).includes(h);
const clShort = (cls) => String(cls || '').replace(/^class_/, '');
const clName = (cls) => data.classes[cls]?.name || clShort(cls);
// The step charges a class's config names (Rogue: trapPerTurn / threatPerTurn / threatRadius; data shared_charge → one
// charge for both). A class without them has none (0). Kept in the class's own class-state namespace.
const chargeCfgOf = (cls) => {
  const c = (cls && classHook('config', cls, CL_BASE)) || {}, n = (v) => (typeof v === 'number' && v >= 0 ? v : 0);
  return { trapPerTurn: n(c.trapPerTurn), threatPerTurn: n(c.threatPerTurn), threatRadius: n(c.threatRadius), shared: data.classes[cls]?.data?.shared_charge === true };
};
// Invisibility: the extra action codes that break it for a unit holding these permanents (class flag invisBreaks;
// the Reaver's EP / EM fight as an Attack).
const invisCodesOf = (perms) => [...perms].flatMap(p => CLASS_RULES[p]?.invisBreaks || []);
// F3: the permanent that hides its holder (definition flag `hides`: Invisibility), and whether it breaks on the holder's
// plays this action (its `breaks` program; dealt = the holder dealt damage — known only after the run; extra = invisCodesOf).
const hidingPerm = (perms) => [...perms].filter(p => p && EFFECT_RULES[p]?.hides).sort()[0] || null;
const hideBreaks = (pid, holder, plays, dealt, every, extra) => standing('breaks', pid, null, { holder, self: pid,
  plays: plays.filter(Boolean).map(rv => ({ action: rv.action ?? null, trance: rv.trance ?? null, effect_id: rv.effect_id ?? rv.effect?.effect_id ?? null })),
  dealt_damage: !!dealt, every: !!every, extra_codes: [...extra] });
// The chase bonus (Avenger) over every class with a chase_step hook — a store holds only its unit's classes.
const CL_CHASERS = clWith('chase_step');
const chaseBonusNow = () => CL_CHASERS.reduce((a, c) => a + (csGet(c, 'bonus', 0) || 0), 0);
// Trap charge (Rogue, user ruling 2026-11-14): `n` uses landed this action, in my class's namespace.
function applyRogueTrapCharge(n) {
  if (!n) return;
  const cls = entity.classId;
  const used = CS.spendCharge(entity.classStore, cls, 'trap', hg.turn, n);
  console.log(`[${PEER_LABEL}] ${clShort(cls)}: trap charge spent (${used}/${chargeCfgOf(cls).trapPerTurn} this turn ${hg.turn})`);
}
// What the perms strip shows for a two-charge passive class (Rogue): uses left this turn per charge.
function rogueChargesForUI() {
  const cls = entity.classId, cfg = chargeCfgOf(cls);
  if (!cls || !(cfg.trapPerTurn || cfg.threatPerTurn)) return null;
  const trapLeft = CS.chargeLeft(entity.classStore, cls, 'trap', cfg.trapPerTurn, hg.turn), threatLeft = CS.chargeTurn(entity.classStore, cls, 'threat') === hg.turn ? 0 : cfg.threatPerTurn;
  // CR: rogue_ui — one shared charge per turn (2026-11-17): once either charge is used, both read 0
  if (cfg.shared && (trapLeft < cfg.trapPerTurn || threatLeft < cfg.threatPerTurn)) return { trap_left: 0, threat_left: 0, trap_per_turn: cfg.trapPerTurn, threat_per_turn: cfg.threatPerTurn, shared: true };
  return { trap_left: trapLeft, threat_left: threatLeft, trap_per_turn: cfg.trapPerTurn, threat_per_turn: cfg.threatPerTurn };
}
function recoverFromDiscard(pred, what) {
  for (let i = discard.length - 1; i >= 0; i--) if (pred(discard[i])) { const c = discard.splice(i, 1)[0]; hand.push(c); return `${what} (${c.name || c.action_name}) returns from the discard pile to my hand`; }
  return null;
}
// Buildings created during play (user rulings 2026-11-14: Animator copy, Priest Shrine) — world edits
// `{ id: 'made:q,r', q, r, made, at }` in their creator's world_edits_json → the features.js overlay.
// Since 2026-11-18 world edits are dimension state (js/world-ledger.js): an author who left still counts through
// every unit's world_ledger_json, and this peer keeps (entity.worldLedger, published + autosaved) what it has seen.
// NPC builders (AI skirmish 2026-11-22): the world-edit payload of a Barricade — an impassable wall (features.js
// overlay: blocks moves like a labyrinth wall; Awake may move it). A builder keeps BUILDER_MAX_STANDING standing.
const BUILDER_MAX_STANDING = Number(process.env.BUILDER_MAX_STANDING) > 0 ? Number(process.env.BUILDER_MAX_STANDING) : 150;   // the ring wall (6R = 120 hexes at R 20)
function barricadeMade() {
  return { label: 'Barricade', path: LAB_WALL_PATHS[0], desc: 'A barricade raised by an NPC builder: nobody passes.', biome: '', kind: 'wall', blocking: true, made_by: 'npc_builder' };
}
function syncPlacedBuildings(view) {
  const units = [...view.entries()].map(([id, v]) => ({ peer_id: id, world_edits_json: id === PEER_ID_STRING ? JSON.stringify(entity.worldEdits || []) : v?.world_edits_json, world_ledger_json: v?.world_ledger_json }));
  if (!units.some(u => u.peer_id === PEER_ID_STRING)) units.push({ peer_id: PEER_ID_STRING, world_edits_json: JSON.stringify(entity.worldEdits || []) });
  foldWorldLedger(units);
  const list = placedBuildingsFrom(ledgerUnits(units));
  if (setPlacedBuildings(list)) {
    _worldTraps.clear();
    const up = list.filter(b => !b.vacated), gone = list.filter(b => b.vacated);   // vacated = hexes Awake moved a building away from
    console.log(`[${PEER_LABEL}] placed buildings: ${up.length} on the map${up.length ? ` (first ${up[up.length - 1].label}@${up[up.length - 1].q},${up[up.length - 1].r})` : ''}${gone.length ? `, ${gone.length} hex(es) vacated (${gone.map(b => `${b.q},${b.r}`).join(' ')})` : ''}`);
  }
}
// World-generated features as a view of peers sees them: map.js featureAt(MAP_SEED, q, r) corrected by every
// peer's world_edits_json — `{id, gone}` (pulled / destroyed) or `{id, q, r}` (relocated). Same on every peer.
// Local ledger fold (not read by the resolver — it reads snapshots only): every author's edits seen so far but
// mine, plus my own edits that only others still remembered (a rejoin without a save) taken back into worldEdits.
function foldWorldLedger(units) {
  const all = [...units, { peer_id: PEER_ID_STRING, world_edits_json: JSON.stringify(entity.worldEdits || []), world_ledger_json: JSON.stringify(entity.worldLedger || []) }];
  const mine = mergeLedger(all).get(PEER_ID_STRING);
  if (mine) {
    const have = new Map((entity.worldEdits || []).map(e => [e.id, e]));
    const back = [...mine.values()].filter(e => { const h = have.get(e.id); return !h || (e.at ?? 0) > (h.at ?? 0); });
    if (back.length) { entity.worldEdits = [...(entity.worldEdits || []).filter(e => !back.some(b => b.id === e.id)), ...back.map(({ by: _b, ...e }) => e)]; console.log(`[${PEER_LABEL}] world ledger: ${back.length} edit(s) of mine taken back from the dimension`); }
  }
  const next = ledgerFor(all, PEER_ID_STRING);
  if (JSON.stringify(next) !== JSON.stringify(entity.worldLedger || [])) { entity.worldLedger = next; _autosave?.markDirty(); }
}
function worldLens(view) {
  const edits = new Map();
  for (const u of ledgerUnits([...view.entries()].map(([id, v]) => ({ peer_id: id, world_edits_json: v?.world_edits_json, world_ledger_json: v?.world_ledger_json })))) for (const e of parseJsonArr(u.world_edits_json)) { const cur = edits.get(e.id); if (!cur || e.gone || (!cur.gone && (e.at ?? 0) >= (cur.at ?? 0))) edits.set(e.id, e); }
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
// S1: SKILLS_IMPLEMENTED (deal order), TRANCE and NEGATING_SKILLS come from skills.mjs (SKILL_RULES).
// C1 ruling 2026-11-16: does my action `code` emit through a class I hold (Reaver A, Barbarian B, Monk M / EM)? The
// emits hook over my class permanents — every planning-time site (casts, Rule 24 intent, bonus plans, bots, UI).
const clEmits = (code, site = 'plan') => clWith('emits').some(id => entity.permanents.has(id) && classHook('emits', id, CL_BASE, { code, site }));
// Effects dealt into character decks: everything effects.mjs has rules for.
const EFFECTS_IMPLEMENTED = playableEffects(data.effects);
// Building traps (user ruling 2026-11-12): many catalogue buildings hide an unknown trap card. It springs on
// the first hero who steps onto the building (damage like a laid trap), its card goes to that hero's discard
// pile and it is gone (world_edits_json `wtrap:q,r`). Deterministic from the map seed: every peer finds the
// same trap. Monsters and summons pass over them.
const WORLD_TRAP_RATE = 0.35, WORLD_TRAP_MONSTER_RATE = 0.3;
const WORLD_TRAP_EFFECTS = EFFECTS_IMPLEMENTED.filter(id => EFFECT_RULES[id]?.damage && (data.effects[id]?.data?.element_cost || []).length).sort();
// The power of the catalogue building on (q, r) (js/building-bonus.js), or null.
const buildingPowerAt = (q, r) => { const b = Number.isInteger(q) ? buildingBonusAt(MAP_SEED, q, r) : null; return b?.kind === 'building' ? b.bonus.power || null : null; };
// The trap an unexplored dungeon holds: one damage effect, re-rolled each time the dungeon re-arms (`since` =
// the turn it was last explored, or 'first').
function dungeonTrap(dg, since) {
  if (!WORLD_TRAP_EFFECTS.length) return null;
  // An Animator copy of a dungeon (user ruling 2026-11-15) is a dungeon of its own (`dng:<copy hex>`, unexplored
  // when it rises) holding the trap its source would hold — rolled on the source hex.
  const cf = buildingFeatureAt(MAP_SEED, dg.q, dg.r);
  const at = cf?.placed && !cf.bonus && Number.isInteger(cf.copy_of?.q) && Number.isInteger(cf.copy_of?.r) ? cf.copy_of : dg;
  const h = sha256Hex(`${MAP_SEED}:dng:${at.q},${at.r}:${since}`);
  const effect_id = WORLD_TRAP_EFFECTS[parseInt(h.slice(0, 8), 16) % WORLD_TRAP_EFFECTS.length];
  return { id: dg.id, q: dg.q, r: dg.r, effect_id, elements: [...data.effects[effect_id].data.element_cost], trigger: 'enter', mode: 'damage', power: TRAP_POWER, library: true, building: dg.source, dungeon: true };
}
const _worldTraps = new Map();
function worldTrapAt(q, r) {
  const key = `${q},${r}`;
  if (_worldTraps.has(key)) return _worldTraps.get(key);
  let out = null;
  const f = WORLD_TRAP_EFFECTS.length ? buildingFeatureAt(MAP_SEED, q, r) : null;
  // An Animator copy carries its source's trap (user ruling 2026-11-15, "They are carrying traps"): it hides the
  // trap the SOURCE building would hide — the same roll on the source hex (copy_of) — armed fresh on the copy's
  // own hex (id `wtrap:<copy hex>`), whether or not the source's has sprung or been disabled. A building with a
  // fixed bonus (Priest's Shrine, a copy of one) hides none.
  const src = !f ? null : !f.placed ? { q, r } : (!f.bonus && f.copy_of && Number.isInteger(f.copy_of.q) && Number.isInteger(f.copy_of.r)) ? f.copy_of : null;
  const sf = src && f.placed ? buildingFeatureAt(MAP_SEED, src.q, src.r) : f;
  if (src && sf && !sf.placed && sf.kind !== 'wall' && !sf.blocking && buildingPowerAt(src.q, src.r)?.kind !== 'fortress' && !dungeonAt(MAP_SEED, src.q, src.r)) {
    const h = sha256Hex(`${MAP_SEED}:wtrap:${src.q},${src.r}`);
    if (parseInt(h.slice(0, 8), 16) / 0x100000000 < WORLD_TRAP_RATE) {
      const effect_id = WORLD_TRAP_EFFECTS[parseInt(h.slice(8, 16), 16) % WORLD_TRAP_EFFECTS.length];
      out = { id: `wtrap:${key}`, q, r, effect_id, elements: [...data.effects[effect_id].data.element_cost], trigger: 'enter', mode: 'damage', power: TRAP_POWER, library: true, building: f.label || 'building', ...(f.placed ? { copy_of: { q: src.q, r: src.r } } : {}) };
    }
  }
  // The building catalogue may still be loading at boot — only remember a definite answer (created buildings
  // come and go with their creator's world edits: never cached).
  if ((out || f) && !f?.placed) _worldTraps.set(key, out);
  return out;
}
// The Dimension Library the resolver draws random cards from (deterministic index over this sorted list).
const LIBRARY_EFFECTS = [...EFFECTS_IMPLEMENTED].filter(id => (data.effects[id]?.data?.element_cost || []).length).sort().map(id => ({ effect_id: id, elements: [...data.effects[id].data.element_cost] }));
const ACTION_BY_CODE = { A: 'action_attack', B: 'action_block', M: 'action_move', P: 'action_posture' };
// 15-card deck for everyone: 11 basics + 4 skills (Rule 0).
const deck = [];
const pushAction = (code) => { const b = ACTION_BY_CODE[code]; deck.push({ card_id: `${b}#${randomBytes(3).toString('hex')}`, kind: 'action', action_id: b, code, action_name: data.actions[b].name }); };
// A skill card of the given skill (dealt at start, or from a profile deck / a kill's gift).
function makeSkillCard(id) {
  const s = data.skills[id];
  const trance = !!SKILL_RULES[id]?.trance;
  return { card_id: `${id}#${randomBytes(3).toString('hex')}`, kind: 'skill', skill_id: id, name: s.name, requires: trance ? '*' : s.data.action_type, is_trance: trance, text: s.data.text, tags: s.tags, is_permanent: !!s.data.is_permanent };
}
// A {kind, id} profile / gift card as an in-game card, or null when this build doesn't know it.
// FXG: a {kind, id, ref} card is FOREIGN (player branch) — never built by name; foreignCardFromRef below.
const cardFromRef = (x) => x?.ref ? null : x?.kind === 'skill' && data.skills[x.id] ? makeSkillCard(x.id) : x?.kind === 'effect' && data.effects[x.id] ? makeEffectCard(x.id) : null;
// FXG: in-game card → {kind, id} (+ ref when foreign: card.fx / card.sk, the handshake ref cardFor puts on it).
const cardRefOf = (c) => c.kind === 'skill' ? { kind: 'skill', id: c.skill_id, ...(c.sk ? { ref: c.sk } : {}) } : { kind: 'effect', id: c.effect_id, ...(c.fx ? { ref: c.fx } : {}) };
// FXG: a foreign {kind, id, ref} → { status, card } through the effects / skills handshake (held → at once; else cache
// first, then a fetch from `from` / holders, validator gate). Private deck state: never the resolver, never the hash.
const foreignCardFromRef = (x, o = {}) => (x?.kind === 'skill' ? skPeer : x?.kind === 'effect' ? fxPeer : x?.kind === 'class' ? clPeer /* CH */ : null)?.cardFromRef(x, o) ?? Promise.resolve({ status: 'bad', reason: `kind ${x?.kind}` });
const profileForeignPending = [];   // FXG: foreign profile cards not in the cache at boot — retried once the transports are up
// Profile deck (user ruling 2026-11-13): the character's action cards + the cards it keeps in the deck;
// its archive cards start in the in-game archive. Topped up with Postures to DECK_MIN if short.
const profileArchived = [];
if (profileChar) {
  for (const code of ['A', 'B', 'M', 'P']) for (let i = 0; i < (profileChar.actions?.[code] | 0); i++) pushAction(code);
  for (const x of profileChar.cards || []) {
    let c = cardFromRef(x);
    if (!c && x.ref) {   // FXG: a foreign card won earlier — rebuilt from the content cache (no transport yet)
      const fr = await foreignCardFromRef(x, { timeoutMs: 2000, why: 'profile', quiet: true });
      if (fr.status === 'ready') { c = fr.card; console.log(`[${PEER_LABEL}] profile: foreign ${x.kind} ${x.id} rebuilt (${fr.src})`); }
      else if (fr.status === 'missing') { profileForeignPending.push(x); console.log(`[${PEER_LABEL}] profile: foreign ${x.kind} ${x.id} not cached — fetching once connected`); continue; }
      else { console.warn(`[${PEER_LABEL}] profile: foreign ${x.kind} ${x.id} ${fr.status} (${fr.reason || ''}) skipped`); continue; }
    }
    if (!c) { console.warn(`[${PEER_LABEL}] profile: unknown ${x.kind} ${x.id} skipped`); continue; }
    if (x.from) c.from = x.from;
    (x.where === 'archive' ? profileArchived : deck).push(c);
  }
  const short = 15 - deck.length;   // DECK_MIN (declared further down)
  for (let i = 0; i < short; i++) pushAction('P');
  console.log(`[${PEER_LABEL}] profile deck: ${deck.length} cards (${deck.filter(c => c.kind === 'action').length} actions, ${deck.filter(c => c.kind === 'skill').length} skills, ${deck.filter(c => c.kind === 'effect').length} effects), ${profileArchived.length} in the archive${short > 0 ? ` — ${short} Posture card(s) added to reach 15` : ''}`);
} else if (entity.kind === 'character') {
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
if (!profileChar) {
  // FORCE_SKILLS=skill_a,skill_b (dev/test only) pins those skills into the 4 dealt.
  const forced = (process.env.FORCE_SKILLS || '').split(',').filter(id => SKILLS_IMPLEMENTED.includes(id) && data.skills[id]);
  const pool = SKILLS_IMPLEMENTED.filter(id => data.skills[id] && !forced.includes(id));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  for (const id of [...forced, ...pool].slice(0, 4)) deck.push(makeSkillCard(id));
}
if (entity.kind === 'character' && !profileChar) {
  // Deal 3 effect cards. Each carries its element_cost sequence so the client
  // can display the required glyphs and the resolver can walk the chain as
  // contiguous Postures emit elements (Rule 19). FORCE_EFFECTS pins them.
  const forcedE = (process.env.FORCE_EFFECTS || '').split(',').map(s => s.trim()).filter(id => EFFECTS_IMPLEMENTED.includes(id) && data.effects[id]);
  const poolE = EFFECTS_IMPLEMENTED.filter(id => data.effects[id] && !forcedE.includes(id));
  for (let i = poolE.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [poolE[i], poolE[j]] = [poolE[j], poolE[i]]; }
  for (const id of [...forcedE, ...poolE].slice(0, 3)) deck.push(makeEffectCard(id));
}
// Monster effect cards (user rulings 2026-11-15, rule_monster_deck_effects): a wild creature (not a companion /
// summon) holds its creature card's deck_effects (thematic, data/creatures.json) + MONSTER_DECK_CFG.random random
// playable effects fixed per instance (seed: map seed, peer label, creature id — a restart rebuilds the same deck).
const IS_MONSTER = entity.kind === 'creature' && !IS_COMPANION && !IS_HUMAN;
// AI skirmish (2026-11-22, llm-brain.mjs): the role this bot plays for the local llama-server — '' = rules only.
const AI_ROLE = aiRoleFor({ role: process.env.AI_ROLE || '', isHuman: IS_HUMAN });
const LLM = llmConfig(process.env);
// Routing (llm-route.mjs): my team's device key + owners (team AI bots: LLM_PROFILE_FILE; my hero: PROFILE_FILE), the
// OCI route (LLM_REMOTE_URL/KEY or <profile dir>/llm.json). The hero serves my team's bots from its llama-server.
const LLM_SERVE = IS_HUMAN && process.env.LLM_SERVE !== '0';
const LLM_AUTH = AI_ROLE || LLM_SERVE ? loadTeamAuth(process.env.LLM_PROFILE_FILE || PROFILE_FILE) : null;
let llmRouter = null;   // created once libp2p is up (below fxPeer.attach)
// A monster's innate effect is never a deck card: it stands as natural permanents (below), no further copies.
const INNATE_ID = IS_MONSTER ? (data.creatures[CREATURE_ID]?.data?.innate_effect || null) : null;
if (IS_MONSTER && !profileChar && data.creatures[CREATURE_ID]) {
  const known = (id) => EFFECTS_IMPLEMENTED.includes(id) && !!data.effects[id] && id !== INNATE_ID;
  const rec = (data.creatures[CREATURE_ID].data?.deck_effects || []).filter(known);
  const thematic = [...new Set(rec.length ? rec : pickThematicEffects(data.creatures[CREATURE_ID], data.effects, EFFECTS_IMPLEMENTED.filter(known), EFFECT_RULES, MONSTER_DECK_CFG))].slice(0, MONSTER_DECK_CFG.thematic);
  const random = pickRandomEffects(monsterDeckSeed(MAP_SEED, PEER_LABEL, CREATURE_ID), EFFECTS_IMPLEMENTED.filter(known), thematic, MONSTER_DECK_CFG.random);
  for (const id of [...thematic, ...random]) deck.push(makeEffectCard(id));
  console.log(`[${PEER_LABEL}] monster deck: ${CREATURE_ID} thematic [${thematic.join(',')}]${rec.length ? '' : ' (computed — no deck_effects in data)'} + random [${random.join(',')}] — ${deck.length} cards`);
}
// Natural permanents (user rulings 2026-11-15, data/rules.json rule_monster_natural_permanents): a monster with an
// innate effect starts with NATURAL_CFG.copies of it already cast — one permanent id (power NATURAL_CFG.power, Rule 24)
// with entity.permCopies[id] = copies, and that many cards in the permanents holding (they count toward DECK_MIN).
// Wild monsters only (IS_MONSTER: no companion / summon / human or npc_b hero). Set, never added to: a restart /
// rejoin / ghost replacement (START_LIFE) boots a fresh process with exactly these, so nothing doubles.
const NATURAL = IS_MONSTER && !profileChar && data.creatures[CREATURE_ID] ? naturalPermFor(data.creatures[CREATURE_ID].data, data.effects, NATURAL_CFG) : null;
if (NATURAL) {
  entity.permanents.add(NATURAL.id);
  entity.permPower[NATURAL.id] = NATURAL.power;
  entity.permCopies = { [NATURAL.id]: NATURAL.copies };
  for (const c of heldCards.filter(x => x.effect_id === NATURAL.id)) heldCards.splice(heldCards.indexOf(c), 1);
  for (let i = 0; i < NATURAL.copies; i++) heldCards.push({ ...makeEffectCard(NATURAL.id), is_permanent: true, natural: true });
  // A destroyed copy goes to the archive (dropPermanent), so the card never circulates and npcCastChoice never sees it.
  console.log(`[${PEER_LABEL}] natural permanents: ${data.effects[NATURAL.id]?.name || NATURAL.id} ×${NATURAL.copies} (power ${NATURAL.power} each) stand from the start`);
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
      tile_target: !!rule.tileTarget, takes_attach: !!(rule.trapAttach || rule.blessAttach), takes_link: !!rule.spiritLink, takes_possess: !!rule.possess, takes_elem: !!rule.altTileToken || !!TILE_TOKEN_CHOICE[id], ...(TILE_TOKEN_CHOICE[id] ? { elem_choice: TILE_TOKEN_CHOICE[id] } : {}),
      text: d.text,
      tags: e.tags || [],
      // Stat-buy summons: the creature rides along from the deal. Summoning: a random
      // library creature ("Library's top"); Golems / Elementals: a random one of their
      // kind, fixed need 24 / 30; Resurrect decides at queue time (what lies next to me).
      summon: (() => {
        const sk = rule.summon?.kind;   // F5: flag summon.kind
        if (!sk) return null;
        if (sk === 'resurrect') return { pending: true, need: 0 };
        const kind = sk === 'library' ? null : sk;
        const ids = Object.keys(data.creatures).filter(cid => (data.creatures[cid].data?.built_in || null) === kind);
        const cid = ids[Math.floor(Math.random() * ids.length)];
        return { creature_id: cid, name: data.creatures[cid].name, need: kind ? (d.stat_buy_total || rule.summon.need || 24) : statSumOf(data.creatures[cid].data?.stats) };
      })(),
    });
  }
}
// FOREIGN_CARD_REFS_JSON=[{kind, id, ref}] (Test Random character, test-priority.mjs): my team's published custom
// skills / effects in my deck — from the content cache, else fetched once connected (profileForeignPending).
if (process.env.FOREIGN_CARD_REFS_JSON && !profileChar) {
  let refs = [];
  try { refs = JSON.parse(process.env.FOREIGN_CARD_REFS_JSON); } catch (e) { console.warn(`[${PEER_LABEL}] FOREIGN_CARD_REFS_JSON: ${e.message}`); }
  for (const x of (Array.isArray(refs) ? refs : []).filter(x => ['skill', 'effect'].includes(x?.kind) && x.ref).slice(0, 7)) {
    const fr = await foreignCardFromRef(x, { timeoutMs: 2000, why: 'test priority', quiet: true });
    if (fr.status === 'ready') { deck.push(fr.card); console.log(`[${PEER_LABEL}] test priority: my team's ${x.kind} ${x.id} in my deck (${fr.src})`); }
    else if (fr.status === 'missing') { profileForeignPending.push(x); console.log(`[${PEER_LABEL}] test priority: my team's ${x.kind} ${x.id} not cached — fetching once connected`); }
    else console.warn(`[${PEER_LABEL}] test priority: my team's ${x.kind} ${x.id} ${fr.status} (${fr.reason || ''}) skipped`);
  }
}
// Shuffle.
for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
// FORCE_FOREIGN_EFFECT=<def.json>[,<def.json>…] (dev/test; Test Random: my drafts): player-branch effects on top of my deck (E4 handshake).
// FORCE_FOREIGN_COPIES=n (1–4, tools/effect-gen-test.mjs): n copies, the first on top, the others every 4th card after it.
const forcedFiles = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
for (const file of forcedFiles(process.env.FORCE_FOREIGN_EFFECT).reverse()) {
  const fc = fxPeer.forcedCard(file);
  if (fc) {
    deck.unshift(fc);
    const n = Math.max(1, Math.min(4, Number(process.env.FORCE_FOREIGN_COPIES) || 1));
    for (let i = 1; i < n; i++) deck.splice(Math.min(deck.length, 4 * i), 0, { ...fc, card_id: `${fc.card_id}${i}` });
  }
}
// FORCE_FOREIGN_SKILL=<def.json>[,…] (dev/test; Test Random: my drafts): player-branch skills on top of my deck (S4 handshake).
// FORCE_FOREIGN_SKILL_COPIES=n (1–4, tools/effect-gen-test.mjs): n copies, placed like FORCE_FOREIGN_COPIES.
for (const file of forcedFiles(process.env.FORCE_FOREIGN_SKILL).reverse()) {
  const sc = skPeer.forcedCard(file);
  if (sc) {
    deck.unshift(sc);
    const n = Math.max(1, Math.min(4, Number(process.env.FORCE_FOREIGN_SKILL_COPIES) || 1));
    for (let i = 1; i < n; i++) deck.splice(Math.min(deck.length, 4 * i), 0, { ...sc, card_id: `${sc.card_id}${i}` });
  }
}
// TEST_PRIORITY=1 (Test Random character, user 2026-11-23): my drafts, then my team's published cards TAKE the dealt
// slots (4 skills, 3 effects) — the built-ins only fill what is left; the foreign cards are spread every 3rd card from
// the top (the opening hand holds some, with action cards to play them). Private deck state: never hashed.
if (process.env.TEST_PRIORITY === '1' && !profileChar && entity.kind === 'character') {
  const isForeign = (c) => !!(c.fx || c.sk);
  for (const [kind, slots] of [['skill', 4], ['effect', 3]]) {
    let over = deck.filter(c => c.kind === kind).length - slots;
    for (let i = deck.length - 1; i >= 0 && over > 0; i--) if (deck[i].kind === kind && !isForeign(deck[i])) { deck.splice(i, 1); over--; }
  }
  const mine = deck.filter(isForeign);
  for (const c of mine) deck.splice(deck.indexOf(c), 1);
  mine.forEach((c, i) => deck.splice(Math.min(deck.length, 3 * i), 0, c));
  const short = 15 - deck.length;   // DECK_MIN
  for (let i = 0; i < short; i++) pushAction('P');
  console.log(`[${PEER_LABEL}] test priority: ${mine.length ? mine.map(c => `${c.kind} ${c.effect_id || c.skill_id}`).join(', ') : 'none of mine'} first; then built-ins — ${deck.filter(c => c.kind === 'skill').length} skills, ${deck.filter(c => c.kind === 'effect').length} effects, ${deck.length} cards`);
}
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
const archive = [...profileArchived];   // a profile character's archive cards start here (user ruling 2026-11-13)
// Test hook (live tests, like FORCE_EFFECTS): FORCE_ARCHIVE=<creature id>,… starts those creature cards in my archive.
for (const cid of String(process.env.FORCE_ARCHIVE || '').split(',').map(s => s.trim()).filter(Boolean)) { const c = creatureCard(cid); if (c) archive.push(c); }
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
let queuedBuild = null;    // { q, r } (null q/r = any free hex) — NPC builder: raise a Barricade with this Posture (AI skirmish)
let queuedElem = null;     // element id — general_ux_tokens: the element a token-making cast should create (Artifice tile token)
let queuedPhylactery = null; // { auto: true } (2026-11-17: the resolver picks the nearest enemy's best permanent) — Phylactery holder: shatter this action
let queuedPossessPick = null; // card_id of the archive creature my next Possess plays (UI pick; none → the strongest, possessArchivePick)
// The Possess payload of my reveal: the archive creature the cast plays (null → the cast becomes the Phylactery).
// Phylactery ranking (possess.mjs phylacteryPick): a permanent that holds a unit; one that hurts or hinders its enemies.
const phylHoldsCreature = (p) => isSummonPerm(p) || isPossessPerm(p) || !!EFFECT_RULES[p]?.phantom;
const phylHostile = (p) => { const r = EFFECT_RULES[p] || {}; return !!(r.damage || r.lock || r.lockRestOfTurn || r.statPenalty || r.channel || r.trap || r.trapAttach || r.banish) || /^effect_(love|awe|fear|anger|domination|petrify|mists|earthquake)$/.test(p); };
// UI hint (local, from the snapshots I hold — the resolver judges again from its view): what a click would shatter.
const phylacteryHint = () => {
  const pp = possessPermOf(entity.permanents);
  if (!pp || entity.possessMode !== 'phylactery' || entity.life <= 0) return null;
  const me = { tile_q: entity.tile.q, tile_r: entity.tile.r };
  const pv = (id) => (id === PEER_ID_STRING ? me : peersPublic.get(id));
  const pick = phylacteryPick({ me: PEER_ID_STRING, ids: [...peersPublic.keys()].filter(id => id !== PEER_ID_STRING), alive: (id) => (peersPublic.get(id)?.life ?? 0) > 0,
    enemy: (a, b) => { const v = peersPublic.get(b); return !!v && sideOf(v.alliance) !== MY_SIDE; },
    dist: (a, b) => { const x = pv(a), y = pv(b); return x && y && Number.isInteger(y.tile_q) ? hexDistance({ tile_q: x.tile_q, tile_r: x.tile_r }, { tile_q: y.tile_q, tile_r: y.tile_r }) : Infinity; },
    perms: (id) => String(peersPublic.get(id)?.permanents_csv || '').split(',').filter(Boolean),
    power: (id, p) => { try { return JSON.parse(peersPublic.get(id)?.perm_power_json || '{}')[p] || 1; } catch { return 1; } },
    holdsCreature: phylHoldsCreature, hostile: phylHostile }, phylReachOf(pp));
  return pick ? { ...pick, name: peersPublic.get(pick.peer_id)?.name || pick.peer_id } : null;
};
const possessPayload = () => { const c = possessArchivePick(archive, queuedPossessPick, (cid) => !!data.creatures[cid]); return c ? { creature_id: c.creature_id, card_id: c.card_id, name: c.name } : null; };
// Bonus rounds only I act in, committed before the normal action and resolved
// first, in order, each against everyone's Empty Posture. Haste grants one per
// action. Balefire (user spec 2026-10-29): the cast that completes lands a
// Balefire(6) permanent until the end of my next turn and draws five cards;
// while it stands every card of mine is an instant — as many bonus plans as I
// have cards — but still one element emission per action.
// Card ids, so a plan survives hand changes within the planning phase. A
// non-instant effect may run across consecutive bonus plans (its steps).
let queuedBonus = [];      // [{ actionCardId|null (Empty), extraCardId|null (Battle Trance 2nd option), skillCardIds: [], effectCardId|null, target, destroy|null }]
// F4: a permanent that grants bonus plans says so in its flags — bonusPlans (per action), bonusOncePerTurn (Haste:
// spent the action a reveal carries it, grey until the next turn), bonusOneEmission (Balefire(6): every card an instant,
// but still one element emission per action across main + bonus plans).
const bonusPerms = (perms) => [...new Set(perms || [])].filter(p => p && EFFECT_RULES[p]?.bonusPlans > 0).sort();
const planSum = (ids) => ids.reduce((s, p) => s + EFFECT_RULES[p].bonusPlans, 0);
const oncePerTurnBonus = () => bonusPerms(entity.permanents).filter(p => EFFECT_RULES[p].bonusOncePerTurn);
const oneEmissionBonus = () => bonusPerms(entity.permanents).filter(p => EFFECT_RULES[p].bonusOneEmission);
// Haste (user ruling 2026-11-12): its bonus round is once per TURN — spent the
// action a reveal carries it, grey until the next turn starts.
entity.hasteUsedTurn = -1;
const hasteLeft = () => oncePerTurnBonus().length && entity.hasteUsedTurn !== hg.turn ? planSum(oncePerTurnBonus()) : 0;
const bonusAllowance = () => hasteLeft() + planSum(bonusPerms(entity.permanents).filter(p => !EFFECT_RULES[p].bonusOncePerTurn));
// The bonus rounds as they travel in the reveal (card ids stay local).
const bonusWire = (list) => Array.isArray(list) && list.length ? list.map(b => ({ action: b.action, trance: b.trance || null, target: wrapTarget(b.target), skills: b.skillIds, skill_names: b.skillNames, effect: b.effect, destroy: b.destroy || null })) : null;
const bonusForUI = () => ({
  max: bonusAllowance(), balefire: planSum(oneEmissionBonus()),
  haste_spent: oncePerTurnBonus().length > 0 && !hasteLeft(),
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
  if (!card || !isSummonPerm(card.effect_id)) return;
  // MV: summon_plan — effects-data/hooks/summon.json: Resurrect (dead neighbour, right-clicked first → archived creature →
  // Death Ward on an adjacent ally → pending), Summoning (∀: bind the nearest enemy creature within 10 → archived → the
  // dealt one), Golems / Elementals keep the creature they were dealt with ({op:'keep'}).
  const arch = archive.find(c => c.kind === 'creature');
  const plan = effectHook('summon_plan', {
    sideOf, hexDistance, creature: (cid) => (data.creatures[cid] ? { name: data.creatures[cid].name, stat_sum: statSumOf(data.creatures[cid].data?.stats) } : null),
  }, { effect_id: card.effect_id, every: !!every, self: PEER_ID_STRING, here: { q: entity.tile.q, r: entity.tile.r }, target, side: MY_SIDE, peers: livePeers(),
    archived: arch ? { creature_id: arch.creature_id, name: arch.name, stat_sum: arch.stat_sum, card_id: arch.card_id } : null, dealt: card.summon ?? null });
  if (plan.op === 'set') card.summon = plan.summon;
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
  if (![...entity.permanents].some(id => EFFECT_RULES[id]?.sensesTraps)) return [];   // F2: definition flag sensesTraps
  const ring = new Set(hexNeighbours(entity.tile.q, entity.tile.r).map(t => `${t.q},${t.r}`));
  return livePeers().filter(p => p.peer_id !== PEER_ID_STRING).flatMap(p => parseJsonArr(p.traps_json).filter(t => ring.has(`${t.q},${t.r}`)).map(t => ({ q: t.q, r: t.r, effect_id: t.effect_id, name: data.effects[t.effect_id]?.name || t.effect_id, elements: t.elements || [], trigger: t.trigger, by: p.peer_id, by_name: p.name || p.peer_id })));
};
const handMsg = (extra = {}) => ({ kind: 'hand', hand, deck_count: deck.length, discard_count: discard.length, archive, archive_count: archive.length, will_archive: [...willArchive], held: heldCards.map(c => ({ card_id: c.card_id, name: c.name, perm: c.effect_id || c.skill_id })), deck_min: DECK_MIN, circulating: circulating(), turn: hg.turn, round: hg.round, casting: castingForUI(), lost_actions: entity.lostActions, destroy: queuedDestroy, queued_chain: queuedChain, aura: queuedAura, bonus: bonusForUI(), sensed_traps: sensedTraps(), channels: entity.channels.map(ch => ({ effect_id: ch.effect_id, name: data.effects[ch.effect_id]?.name || ch.effect_id, holder: ch.holder || null, stop: ch.stop })), queued_attach: queuedAttach, queued_link: queuedLink, queued_elem: queuedElem, queued_phylactery: queuedPhylactery, queued_class_ability: queuedClassAbility, class_state: classStateForUI(), possessing: entity.possessing?.peer_id || null, possess_pick: queuedPossessPick, possess_mode: entity.possessMode || null, phylactery_target: phylacteryHint(),fortresses: fortressesNearForUI(), ...extra });
// My class as the UI shows it: colours (stat → elements) with the ones struck down, tapped / archived flags and recast / untap progress.
const reanimatedAll = (peers) => CS.unionOf(peers.map(p => p?.class_state_json), 'raised');   // phase 2: every unit any class raised
// Phase 4: a class with a `blocked` hook (Necromancer) says why its card cannot be clicked now (null = it can).
const classBlocked = () => {
  const cls = entity.classId;
  if (!hasHook(cls, 'blocked')) return null;
  const done = reanimatedAll(livePeers()), here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
  const fallen_near = livePeers().some(p => p && p.peer_id !== PEER_ID_STRING && (p.life ?? 1) <= 0 && p.creature_id && sideOf(p.alliance) === MY_SIDE && !done.has(p.peer_id) && Number.isInteger(p.tile_q) && hexDistance(here, p) <= 1);
  const archive_creature = archive.some(c => c.kind === 'creature' && data.creatures[c.creature_id]);
  return classHook('blocked', cls, CL_BASE, { fallen_near, archive_creature });
};
const classStateForUI = () => ({ blocked: classBlocked(), class_id: entity.classId || null, name: entity.className || null, kind: classKindOf(entity.classId), colours: classColours(entity.classId), down: [...(entity.classDown || [])], archived: !!entity.classArchived, tapped: !!entity.classTapped, progress: entity.classProgress || null, used_turn: entity.classUsedTurn ?? -1, needs: classNeeds(entity.classId), local: !!CLASS_LOCAL[entity.classId], text: data.classes[entity.classId]?.data?.text || clPeer.info(entity.classId)?.text || '', ...(clPeer.mine?.ref.id === entity.classId ? { source: { ...clPeer.mine.ref, kind: 'class' } } : {}), charges: rogueChargesForUI(),   /* CH: a foreign class's text + source */ emits: ['A', 'B', 'M', 'EM'].filter(c => clEmits(c)) /* C1 ruling 2026-11-16 */ });
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
  lastStateHash: '',   // payload.state_hash of the newest evt_state_hash pushed (own or received)
  turn: 0,
  round: 0,
  action: 0,
};
const actionKey = (turn, round) => turn * ROUNDS_PER_TURN + round;

// Bounded tape (2026-11-15, save-size + M5 soak). Every reader of hg.tape only looks at the current
// turn/round (reveals, fx refs) or the newest state hash, so the in-memory tape keeps the envelopes of
// the last two turns (+ any without a turn). It used to grow with every own AND received envelope for
// the whole session. The on-disk tape (game/sessions/<dim>/hashgraph.jsonl, diagnostics only — restore
// reads the TMJ) rotates to hashgraph.1.jsonl past TAPE_MAX_BYTES, so a dimension's local footprint stays
// ≤ 2 × cap: default 512 KB on the phone (it was 1.8 MB after 32 turns), 16 MB on desktop; 0 = unbounded.
const TAPE_MAX_BYTES = Number(process.env.TAPE_MAX_BYTES ?? (IS_MOBILE ? 512 * 1024 : 16 * 1024 * 1024));
let tapePruneAt = 2000;
function tapePush(env) {
  hg.tape.push(env);
  if (env.type === 'evt_state_hash' && env.payload?.state_hash) hg.lastStateHash = env.payload.state_hash;
  if (hg.tape.length <= tapePruneAt) return;
  const keepFrom = hg.turn - 1;
  hg.tape = hg.tape.filter(e => !Number.isInteger(e.turn) || e.turn >= keepFrom);
  tapePruneAt = Math.max(2000, hg.tape.length * 2);
}
let tapeDirReady = false, tapeAppends = 0;
async function tapeAppend(line) {
  const abs = path.join(__dirname, 'sessions', DIM_NAME, 'hashgraph.jsonl');
  if (!tapeDirReady) { await fs.mkdir(path.dirname(abs), { recursive: true }); tapeDirReady = true; }
  await fs.appendFile(abs, line + '\n');
  if (TAPE_MAX_BYTES > 0 && ++tapeAppends % 16 === 0) {
    const st = await fs.stat(abs).catch(() => null);
    if (st && st.size > TAPE_MAX_BYTES) await fs.rename(abs, abs.replace(/\.jsonl$/, '.1.jsonl')).catch(() => {});
  }
}

// Phase clock lives up here because the public-state snapshot (published
// before the FSM section) reports it to joining peers.
let currentPhase = 'planning';
let phaseEndsAt = Date.now() + ROUND_SEC * 1000;

function sha256Hex(s) { return createHash('sha256').update(s).digest('hex'); }
function digestObj(o) { return sha256Hex(JSON.stringify(o)); }

let lastEnvelopeAt = 0;
let lastBusAt = 0;                 // last envelope / snapshot that went out on the Nostr bus
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
  tapePush(env);

  // 1) Broadcast via libp2p gossipsub to the strong-region mesh (direct links)
  //    and over the public Nostr bus (peers on other machines). Receivers
  //    dedupe by _hash, so getting the same envelope twice is harmless.
  const line = JSON.stringify(env);   // serialized once: gossipsub frame, tape line and net-stats bytes
  netStat('libp2p', 'out', type, line.length);
  try { await libp2p.services.pubsub.publish(TOPIC_STRONG, new TextEncoder().encode(line)); }
  catch (e) { console.warn(`[${PEER_LABEL}] pubsub publish failed: ${e.message}`); }
  // Only the handshake needs to cross the internet; the per-round state-hash
  // and push notes are bookkeeping and would double the relay load.
  if (viaBus ?? (type === 'evt_action_commit' || type === 'evt_action_reveal' || type === 'evt_map_extend')) { bus?.publish('env', env); lastBusAt = Date.now(); }
  lastEnvelopeAt = Date.now();

  // 2) Append to the on-disk tape (bounded, see tapeAppend).
  await tapeAppend(line);

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
  tapePush(env);
  if (env.state && mergePeerState(env.state)) broadcastUI({ kind: 'peers', peers: peersForUI() });
  inboxApply(env);
  broadcastUI({ kind: 'evt', env, from_peer: true });
}
libp2p.services.pubsub.addEventListener('message', (ev) => {
  if (ev.detail.topic !== TOPIC_STRONG) return;
  try {
    const env = JSON.parse(new TextDecoder().decode(ev.detail.data)); netStat('libp2p', 'in', env?.type || env?.kind, ev.detail.data.length);
    // Full public snapshot frame (not an envelope: no tape, no hash — older builds drop it on dimension_id).
    // `clock` (M6 step 1): the slim core record sent on every clock change (publishClock) — merged the same way.
    if ((env?.kind === 'state' || env?.kind === 'clock') && env.dim === DIM_ID) { if (mergePeerState(env.state)) broadcastUI({ kind: 'peers', peers: peersForUI() }); return; }
    receiveEnvelope(env, 'libp2p');
  }
  catch (e) { console.warn(`[${PEER_LABEL}] bad pubsub frame: ${e.message}`); }
});
libp2p.services.pubsub.addEventListener('subscription-change', (ev) => {
  const subs = ev.detail.subscriptions.map(s => `${s.topic}:${s.subscribe ? '+' : '-'}`).join(',');
  console.log(`[${PEER_LABEL}] pubsub sub-change from ${ev.detail.peerId.toString().slice(0, 14)}…: ${subs}`);
  // A new neighbour on our topic gets our full state right away (the libp2p half of the Gun-free directory).
  if (ev.detail.subscriptions.some(s => s.topic === TOPIC_STRONG && s.subscribe)) { try { whoReply('libp2p'); } catch { /* still booting */ } }
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
// A replacement for a vanished monster / summon names the one it replaces; receivers drop that ghost.
const REPLACES_PEER_ID = process.env.REPLACES_PEER_ID || '';
// Whom my snapshots say I replace: REPLACES_PEER_ID at boot; a hero that is heard again after a shadow of it stood
// in takes that shadow's place back (heroShadowSeen) — receivers then drop the shadow, never two copies.
let replacesNow = REPLACES_PEER_ID;
const supersededBy = new Map();   // peer id → the peer id that took its place (hero ↔ shadow swaps; mergePeerState)
let _shadowLeaving = false;       // a shadow stepping down (shadowStepDown)
// Hero shadows (rule_hero_shadow): the card a hero would lose on death, published so its shadow can hand exactly
// that card to its killer (the shadow cannot see the player's deck); the player's device then removes it from the
// profile (game/shadow-settle.mjs). One random non-action card, kept while it is still mine. Display / gift only,
// outside the state hash.
let _deathCard = null;
function deathCardRef() {
  if (SHADOW_OF) { try { return process.env.SHADOW_DEATH_CARD ? JSON.parse(process.env.SHADOW_DEATH_CARD) : null; } catch { return null; } }
  if (entity?.kind !== 'character' || ownerPeerId) return null;
  try {
    if (profileChar) {
      if (_deathCard) return _deathCard;
      const inDeck = (profileChar.cards || []).filter(x => x.where === 'deck' && (x.kind === 'skill' || x.kind === 'effect'));
      const x = inDeck.length ? inDeck[Math.floor(Math.random() * inDeck.length)] : null;
      return (_deathCard = x ? { kind: x.kind, id: x.id, ...(x.ref ? { ref: x.ref } : {}) } : null);   // FXG: a foreign card keeps its ref
    }
    const pool = [...deck, ...discard, ...hand].filter(c => c.kind === 'skill' || c.kind === 'effect').map(cardRefOf);   // FXG: + ref for a foreign card
    if (_deathCard && pool.some(c => c.kind === _deathCard.kind && c.id === _deathCard.id)) return _deathCard;
    return (_deathCard = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null);
  } catch { return null; }   // deck / hand not dealt yet (the very first snapshot)
}
let shadowDeath = null;   // a shadow's death: { killer, killer_name, card, gift_id, at } (snapshot shadow_death_json, Doors)
// Unattended characters (rule_unattended_character): my master (I am unattended — unattendedLeader), and `out` once I
// left the dimension (alone for VANISH_MS, or Dimension Out) — receivers drop me, the Doors stop counting me alive.
let ledBy = '';
let outNow = false;
let dimOut = null;   // Dimension Out in progress: { start_turn, until_turn } (dimOutStart; snapshot dim_out_until_turn)
const outPeers = new Map();   // peer id → its last (out) record: ignored from now on, kept as a tombstone in my Door
// How many unattended characters follow me (my snapshot's `leader`; the map / roster flag).
const followersOf = (id) => livePeers().filter(p => p && p.shadow_of && p.led_by === id && (p.life ?? 0) > 0).length;
// The last action whose resolution my entity already shows (snapshot `resolved_action`; merge-order.mjs resolverBase).
let resolvedAction = -1;
function currentStateSnapshot(slim = false) {
  const s = {
    peer_id: PEER_ID_STRING, character_id: CHARACTER_ID || null, creature_id: CREATURE_ID || null,
    tile_q: entity.tile.q, tile_r: entity.tile.r, life: entity.life, life_max: entity.lifeMax,
    alliance: entity.alliance, name: entity.name, source_id: entity.sourceId, last_seen: new Date().toISOString(),
    owner_peer_id: ownerPeerId || '', summoned_csv: entity.summons.map(x => x.peer_id).join(','), wards_csv: entity.wards.join(','), entry_q: START_TILE.q, entry_r: START_TILE.r,
    turn: hg.turn, round: hg.round, action: hg.action, phase: currentPhase, phase_ends_at: phaseEndsAt, resolved_action: resolvedAction,
    map_blocks: dimMap ? dimMap.blockCount() : 0,
    ...(mapSync ? { map_root: mapSync.myRoot() } : {}),   // map-sync.mjs digest root (~12 B); absent = pre-M3 build / legacy sim
    ...fxPeer.snapshotFields(),   // E4: fx_have "id@sha16,…" — foreign effects I hold and serve; absent without any
    fx_set: fxPeer.setId.slice(0, 16),   // E4: my bundled effect set (effects + libs + hooks) — F9: the version gate reads it, so it rides on the slim envelope snapshot too
    ...skPeer.snapshotFields(),   // S4: sk_have "id@sha16,…" — foreign skills I hold and serve; absent without any
    sk_set: skPeer.setId.slice(0, 16),   // SV: my bundled skill set — the version gate reads it, so it rides on the slim envelope snapshot too
    ...clPeer.snapshotFields(entity.classId),   // CH: cl_ref_json (my foreign class) + cl_have "id@sha16,…"; phase 6: cl_key = the pin of my built-in class
    stat_vitality: entity.stats.vitality, stat_world: entity.stats.world, stat_matter: entity.stats.matter, stat_will: entity.stats.will,
    permanents_csv: permanentsCsv(),
    stat_tokens_json: statTokensJson(), tile_tokens_json: tileTokensJson(), lost_actions: entity.lostActions,
    elem_pen_json: elemPenJson(), perm_power_json: permPowerJson(),
    shield_elems_csv: elemsCsv(entity.shieldElems), disables_json: disablesJson(), every_csv: [...entity.everyPerms].sort().join(','),
    channels_json: channelsJson(), traps_json: trapsJson(), afflictions_json: afflictionsJson(),
    obstacles_json: obstaclesJson(), links_json: linksJson(), perm_copies_json: permCopiesJson(),
    // Turn-scoped no-damage zones every resolver holds (not my entity): a mid-turn joiner adopts them (adoptMeshZones).
    zones_json: JSON.stringify([...activeZones].sort((a, b) => a.q - b.q || a.r - b.r)),
    possessed_by: entity.possessedBy || null,
    ...(IS_COMPANION && ownerPeerId ? { companion_of: ownerPeerId } : {}),   // 2026-11-18: I leave the map when released (bound creatures: absent) — possess.mjs releasedCompanions
    ...boundSnapshotFields(),   // 2026-11-19: bound_to / bound_perm / bound_mode / bound_at / bound_alliance while bound (absent otherwise) — bound-release.mjs
    ...(entity.possessMode ? { possess_mode: entity.possessMode } : {}),   // Possess 2026-11-17: 'possess' | 'phylactery' while my Possess permanent stands
    class_id: entity.classId || null, class_down_csv: (entity.classDown || []).join(','), class_archived: entity.classArchived ? 1 : 0, class_tapped: entity.classTapped ? 1 : 0,
    class_progress_json: classProgressJson(), class_used_turn: entity.classUsedTurn ?? -1, armor: entity.armor || 0,
    illusion: entity.illusion || 0, class_state_json: CS.classStateJson(entity.classStore),   // phase 2: the generic class state (phase 4: the per-class fields are gone; phase 5: reanim_down_csv too)
    ...reanimFields(), replaces: replacesNow,
    // Hero shadows (rule_hero_shadow): whose shadow I am, my death card, and (dead shadow) who killed it.
    shadow_of: SHADOW_OF, death_card_json: JSON.stringify(deathCardRef()), shadow_death_json: shadowDeath ? JSON.stringify(shadowDeath) : '',
    // Unattended characters (rule_unattended_character): a human hand?, my ally-join link and join time (the group's
    // master is its earliest human join), my master (unattended), how many follow me, and `out` (left the dimension).
    human: IS_HUMAN ? 1 : 0, ally_of: allyOfNow, joined_at: JOINED_AT, instance: INSTANCE_ID, led_by: ledBy, leader: SHADOW_OF ? 0 : followersOf(PEER_ID_STRING), out: outNow ? 1 : 0,
    // Dimension Out (rule_dimension_out): the turn I leave at (-1 = none) — every UI counts it down on my unit.
    dim_out_until_turn: dimOut ? dimOut.until_turn : -1, dim_out_start_turn: dimOut ? dimOut.start_turn : -1,
    ai_role: AI_ROLE,   // AI skirmish: 'builder' lets every resolver raise my Barricades (reveal `build`)
    world_edits_json: JSON.stringify(entity.worldEdits || []),
    world_ledger_json: JSON.stringify(entity.worldLedger || []),
    awake_lend_json: JSON.stringify(entity.awakeLend || null),
    fortress_bank_json: JSON.stringify(entity.fortressBank || null),
    monster_state: entity.monsterState || null,
    chase_target: entity.chaseTarget || '', lured_by: entity.luredBy?.id || '',
    combo_active: entity.comboState?.active ? 1 : 0,
    combo_slot: entity.comboState?.slot || 0,
    combo_seq_csv: Array.isArray(entity.combo) ? entity.combo.join(',') : '',
    // Profile (user ruling 2026-11-13) — display only, outside the per-action state hash (id / tile / life).
    team_name: PROFILE_TEAM, profile_char_id: profileChar ? PROFILE_CHAR_ID : (process.env.SHADOW_PROFILE_CHAR_ID || ''), resources_id: profileChar?.resources?.id || '',
    llm_srv: llmRouter?.serving() ? 1 : 0,   // AI skirmish: my llama-server answers my team's bots (llm-route.mjs, signed)
  };
  if (slim) return s;
  // Live clock + network hints so a joining peer can align its turn counter
  // and dial the mesh. Gun rejects arrays in nested puts, hence the CSV.
  s.gun_url = myGunUrl; s.multiaddrs_csv = myMaddrs.join(',');
  s.nostr_pubkey = bus?.pubkey || null; s.nostr_relays_csv = (bus?.relays || []).join(',');
  // HUD telemetry only (hexes held + their sketch, see mapSketchAdd) — the resolver never reads these.
  // map_sketch travels on the bus `state` event, the discovery mirror and the Door — not Gun (gun-member.mjs).
  s.map_tiles = dimMap ? dimMap.size() : 0; s.map_sketch = dimMap ? mapSketchCsv() : '';
  s.cl_set = clPeer.setId.slice(0, 16);   // CH: my built-in class set — a mismatch is logged, never resolved on
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
// The peers whose clock may pace ours (enterPhase cohort / trail, catchUpClock): self + wire-heard peers.
// A Gun-only member can't take part in our handshake, yet its clock made the whole live cohort jump
// (GunLive85 M6 run: "clock catch-up +2 from peer:gX" on every peer, 57 phase offsets vs 0 with Gun off).
function clockPeers() { return livePeers().filter(p => p.peer_id === PEER_ID_STRING || wireHeard.has(p.peer_id)); }
// Invisibility as a peer snapshot tells it (bots / NPC planning only; the resolver uses invisibleNow).
const snapInvisible = (p) => !!hidingPerm(String(p?.permanents_csv || '').split(','));
// What the browser gets: every snapshot plus the region tier relative to us.
// (`map_sketch` stays here: the peer sends the share it computes from it in `telemetry`.)
function peersForUI() { return livePeers().map(({ map_sketch, ...p }) => ({ ...p, tier: tierOf(p) })); }
setInterval(() => {
  let swept = 0;
  const cutoff = Date.now() - PEER_SWEEP_MS;
  for (const [id, p] of peersPublic) {
    if (id === PEER_ID_STRING) continue;
    const ls = Date.parse(p?.last_seen || 0);
    if (!Number.isFinite(ls) || ls < cutoff) { peersPublic.delete(id); wireHeard.delete(id); mapSync?.forget(id); swept++; }
  }
  if (swept) broadcastUI({ kind: 'peers', peers: peersForUI(), dropped: true });
}, 60_000);

async function postJson(url, body) {
  try {
    const raw = JSON.stringify(body); netStat('discovery', 'out', url.split('/')[3] || 'post', raw.length);
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } catch (e) { /* best-effort; log at caller */ return null; }
}

// Merge another peer's public snapshot, whichever transport brought it, and
// opportunistically try a direct link to it.
const knownTiles = new Map();   // "q,r" -> last time we saw someone there (part of our Door)
function noteTile(q, r) { if (typeof q === 'number' && typeof r === 'number') knownTiles.set(`${q},${r}`, Date.now()); }
// Peers we have heard on a WIRE transport (an envelope, a libp2p state / clock frame, the bus, the
// discovery mirror) — not only through Gun. The resolver's view and the strong region take only these
// (GunLive85 run 3, T8.R3: gX, cut from libp2p + bus and visible only via Gun, sat on (15,-16) in some
// resolvers' views and not in others', so gA's move there was vetoed on gA / gD only → divergence).
const wireHeard = new Set();
// Per peer: its held snapshot from before the merge that moved its resolved_action forward (merge-order.mjs notePrior).
const snapPrior = new Map();
// Never two copies of one monster: a non-hero peer that hears a fresh, living process publishing ITS peer id with an
// earlier joined_at (tie: lower `instance`) is the duplicate (a lurker spawned twice in a race) and leaves; the earlier copy
// plays on.
function dupSelfSeen(p) {
  if (IS_HUMAN || entity.kind === 'character' || dupSelfSeen.done) return;
  if (!p.joined_at || p.instance === INSTANCE_ID || !(Date.parse(p.last_seen || 0) > Date.now() - PEER_STALE_MS) || (p.life ?? 1) <= 0) return;
  if (!p.instance && p.joined_at === JOINED_AT) return;   // my own statement echoed back (a peer without `instance`)
  const theirs = Date.parse(p.joined_at), mine = Date.parse(JOINED_AT);
  if (!(theirs < mine || (theirs === mine && p.instance && String(p.instance) < INSTANCE_ID))) return;   // the earlier copy (tie: lower instance) stays
  dupSelfSeen.done = true;
  console.log(`[${PEER_LABEL}] duplicate: another process already plays ${PEER_ID_STRING} (joined ${p.joined_at}, I joined ${JOINED_AT}) — this copy exits`);
  setTimeout(() => process.exit(0), 200);
}
function mergePeerState(p, via = 'wire') {
  if (p && typeof p === 'object' && p.peer_id === PEER_ID_STRING) dupSelfSeen(p);
  if (!p || typeof p !== 'object' || !p.peer_id || p.peer_id === PEER_ID_STRING) return false;
  if (!isFresh(p)) return false;
  if (via !== 'gun') wireHeard.add(p.peer_id);
  const prev = peersPublic.get(p.peer_id) || {};
  // One ordering rule for every transport (merge-order.mjs): an older statement only fills gaps —
  // a replayed pre-death envelope must not bring a dead monster back (Swarm-0407 T2.R3).
  const take = orderedMerge(prev, p);
  if (take !== p && (('life' in p && p.life !== prev.life) || ('action' in p && p.action !== prev.action))) {
    const n = (mergePeerState.stale = (mergePeerState.stale || 0) + 1);
    if (n <= 3 || n % 50 === 0) console.log(`[${PEER_LABEL}] stale snapshot #${n} of ${p.peer_id} ignored (hp${p.life} a${p.action} @${p.last_seen} older than held hp${prev.life} a${prev.action} @${prev.last_seen})`);
  }
  if (!take) return false;
  p = take;
  // Hero shadows (rule_hero_shadow): one side of a hero ↔ shadow swap stays out once the other took its place —
  // unless it takes that place back (its snapshot names the one that replaced it). Never two copies.
  if (supersededBy.has(p.peer_id) && p.replaces !== supersededBy.get(p.peer_id)) return false;
  if (SHADOW_OF && p.replaces === PEER_ID_STRING) { shadowStepDown(p); return false; }
  // Left the dimension (`out`: an unattended character alone too long, a Dimension Out): dropped, no corpse, and
  // ignored from then on — unless the same peer id joins again (a fresh joined_at, not out).
  const tomb = outPeers.get(p.peer_id);
  if (tomb && (p.out || !p.joined_at || p.joined_at === tomb.joined_at)) return false;
  if (tomb) outPeers.delete(p.peer_id);
  if (p.out) {
    outPeers.set(p.peer_id, { ...prev, ...p });
    if (peersPublic.delete(p.peer_id)) {
      console.log(`[${PEER_LABEL}] out: ${p.name || p.peer_id} (${p.peer_id}) left the dimension`);
      setTimeout(() => broadcastUI({ kind: 'peers', peers: peersForUI(), dropped: true }), 0);
    }
    return false;
  }
  if (p.shadow_of === PEER_ID_STRING && p.peer_id !== replacesNow && !SHADOW_OF) heroShadowSeen(p);
  const merged = { ...prev, ...p };
  notePrior(snapPrior, prev, merged);   // Swarm-0559: the statement from before its owner resolved its newest action
  peersPublic.set(p.peer_id, merged);
  if (p.replaces && p.replaces !== p.peer_id && peersPublic.has(p.replaces)) {
    if (p.shadow_of || peersPublic.get(p.replaces)?.shadow_of) { supersededBy.set(p.replaces, p.peer_id); supersededBy.delete(p.peer_id); }
    peersPublic.delete(p.replaces);
    console.log(`[${PEER_LABEL}] ${p.name || p.peer_id} takes the place of ${p.replaces}`);
    setTimeout(() => broadcastUI({ kind: 'peers', peers: peersForUI(), dropped: true }), 0);
  }
  noteTile(p.tile_q, p.tile_r);
  if (p.multiaddrs_csv) dialPeerAddrs(p.peer_id, p.multiaddrs_csv.split(',').filter(Boolean)).catch(() => {});
  // M3: a peer that advertises a digest root is pulled from when the roots differ (map-sync.mjs);
  // a pre-M3 peer (no map_root) still gets the old push of our whole block list when it is behind.
  // Judged on the MERGED record: a slim Gun echo (gun-member.mjs) carries map_blocks but no map_root.
  const seenRoot = typeof peersPublic.get(p.peer_id)?.map_root === 'string';
  if (seenRoot && mapSync) { if (typeof p.map_root === 'string') mapSync.noteRemote(p.peer_id, p.map_root); }
  else if (typeof p.map_blocks === 'number') offerMapSync(p.peer_id, p.map_blocks);   // pre-M3 peer (or we are the legacy sim)
  if (p.sk_have || p.sk_set) skPeer.onPeerState(p);   // S4: who serves which foreign skill (prefetch what I lack)
  if (p.fx_have || p.fx_set) fxPeer.onPeerState(p);   // E4: who serves which foreign effect (prefetch what I lack) — E4-fix: after the map if/else, not inside it
  if (p.cl_have || p.cl_set || p.cl_ref_json) clPeer.onPeerState(p);   // CH: a holder's foreign class ref + who serves which (after the map if/else, not inside it)
  return true;
}

// -------- the dimension map --------
// Grow-only set of revealed hexes (see js/map.js). Every player reveals a disc
// of REVEAL_RADIUS around itself whenever it stands closer than that to the
// edge of the known world — at spawn and after each move. A disc is a tiny,
// idempotent block, so it travels on every channel we have: compare-then-pull
// between peers (map-sync below — replaced the Gun graph as carrier in M3), an
// evt_map_extend envelope over gossipsub + the Nostr bus (fast), and the Door
// on Radicle (what joiners seed from). Receiving the same block twice is a
// no-op, so the order and the transport never matter.
dimMap = createKnownMap(MAP_SEED, [initialBlock(INITIAL_SIZE), ...seedBlocks]);
for (const t of dimMap.tiles()) mapSketchAdd(t.key);
// Digest of our block ids (map-sync.mjs): 64 buckets {count, xor, sum}; its root rides on every snapshot.
const mapDigest = createDigest();
for (const b of dimMap.blocks()) mapDigest.add(b.id);
const gunMap = dimRoot.get('map').get('blocks');
const knownHex = (q, r) => dimMap.has(q, r);
const blockAddedAt = [];   // when each block arrived here (ms), oldest first — see offerMapSync
function mapSummary() { return { seed: MAP_SEED, reveal_radius: REVEAL_RADIUS, blocks: dimMap.blocks(), tiles: dimMap.size(), bounds: dimMap.bounds() }; }
function addMapBlock(b, via) {
  if (!isBlock(b) || !dimMap.addBlock(b)) return false;
  for (const t of blockTiles(b)) mapSketchAdd(`${t.q},${t.r}`);
  blockAddedAt.push(Date.now());
  mapDigest?.add(b.id);
  // A pull can bring hundreds of blocks at once: one summary line per pull (map-sync log) instead.
  if (!String(via).startsWith('pull')) console.log(`[${PEER_LABEL}] map +${b.id} via ${via} by ${b.by || '?'} → ${dimMap.size()} hexes in ${dimMap.blockCount()} blocks`);
  // Delta: just the new block (every consumer — main.js applyMap, swarm-test, move-probe — merges
  // additively; the full list still goes out in `hello`). The whole summary was ~150 KB per block
  // on a 1,400-block map, stringified and parsed for every arriving disc.
  broadcastUI({ kind: 'map', map: { seed: MAP_SEED, reveal_radius: REVEAL_RADIUS, blocks: [b], tiles: dimMap.size(), bounds: dimMap.bounds(), delta: true } });
  _autosave?.markDirty();   // the known tileset grew — a tick from now this reaches disk
  return true;
}
// COMPAT (P2P rework M3): new builds no longer PUT map blocks into Gun; we still READ them so blocks
// written by pre-M3 builds reach us. Remove this reader (and the MAP_SYNC_LEGACY puts below) in M6.
gunMap.map().on((b) => { if (b && typeof b === 'object') { netStat('gun', 'in', 'map', String(b.id || '').length + 90); addMapBlock(b, 'gun'); } });
// -------- map sync: compare-then-pull (map-sync.mjs, P2P rework M3) --------
// Every slim snapshot carries `map_root` (our digest root). When a peer's root differs from ours and
// the difference has settled, we pull: send our 64-bucket summary, get back their ids in the buckets
// that differ, then fetch just the blocks we lack. Direct libp2p stream protocol MAP_PROTO (one
// stream per request, frames = 4-byte length + JSON, ≤ 32 KB) when we hold an open connection to the
// peer; otherwise `map` events on the Nostr bus, addressed {to, from, rid, seq, last}, ≤ 24 KB each.
// The fast path for a fresh disc is unchanged (evt_map_extend envelope); this is the repair path
// (joiners, missed envelopes, restored saves) that Gun and the full-list evt_map_sync used to be.
const MAP_PROTO = `/chaos/${DIM_ID}/map/1`;
const MAP_RPC_TIMEOUT_MS = 10_000;
const mapFrameBytes = (m) => Buffer.byteLength(JSON.stringify(m), 'utf8') + 4;
function openConnTo(peerId) {
  const csvPids = String(peersPublic.get(peerId)?.multiaddrs_csv || '').split(',').map(a => a.split('/p2p/').at(-1)).filter(Boolean);
  const pids = new Set(csvPids);
  for (const [pid, v] of addrsOf) if (v.peerId === peerId) pids.add(pid);
  return libp2p.getConnections().find(c => c.status === 'open' && pids.has(c.remotePeer.toString())) || null;
}
async function mapRequestLibp2p(conn, msg) {
  const req = encodeFrame(msg);
  const stream = await conn.newStream(MAP_PROTO, { signal: AbortSignal.timeout(MAP_RPC_TIMEOUT_MS) });
  const timer = setTimeout(() => stream.abort(new Error('map rpc timeout')), MAP_RPC_TIMEOUT_MS);
  try {
    netStat('libp2p', 'out', 'map_sync', req.length);
    if (!stream.send(req)) await stream.onDrain();
    await stream.close();   // half-close: the request is complete, the reply follows
    const dec = createFrameDecoder(), msgs = [];
    let bytesIn = 0;
    for await (const chunk of stream) {
      const u = chunk instanceof Uint8Array ? chunk : chunk.subarray();
      bytesIn += u.length;
      for (const m of dec.push(u)) { msgs.push(m); netStat('libp2p', 'in', 'map_sync', mapFrameBytes(m)); }
    }
    return { msgs, via: 'libp2p', bytesOut: req.length, bytesIn };
  } finally { clearTimeout(timer); }
}
let busRpc = null;
const MAP_BUS_WAIT_MS = 8_000, MAP_BUS_GAP_MS = 3_000;
let mapBusLastAt = 0;
async function mapRequest(peerId, msg) {
  const conn = MAP_SYNC_FORCE_BUS ? null : openConnTo(peerId);
  if (conn) {
    try { return await mapRequestLibp2p(conn, msg); }
    catch (e) { if (!bus?.stats().open) throw e; console.log(`[${PEER_LABEL}] map rpc to ${peerId} over libp2p failed (${e.message}) — trying the bus`); }
  }
  const noRoute = (why) => Object.assign(new Error(why), { code: 'NO_ROUTE' });
  if (!busRpc || !bus?.stats().open) throw noRoute('no direct link and no bus');
  // The bus is shared with the commit/reveal handshake and public relays rate-limit chatty senders:
  // give a fresh peer's libp2p dial MAP_BUS_WAIT_MS to come up, and space bus pulls MAP_BUS_GAP_MS apart
  // (the follow-up `get` of a pull already in progress is exempt).
  const rem = mapSync?.remote(peerId);
  if (!MAP_SYNC_FORCE_BUS && rem && Date.now() - rem.firstAt < MAP_BUS_WAIT_MS) throw noRoute('waiting for a direct link');
  if (msg.t === 'diff' && Date.now() - mapBusLastAt < MAP_BUS_GAP_MS) throw noRoute('bus pull spacing');
  mapBusLastAt = Date.now();
  return busRpc.request(peerId, msg);
}
if (!MAP_SYNC_LEGACY) {
  mapSync = createMapSync({
    selfId: PEER_ID_STRING,
    store: { digest: mapDigest, has: id => mapDigest.has(id), get: id => dimMap.getBlock(id), add: (b, via) => addMapBlock(b, via) },
    request: mapRequest,
    log: (line) => console.log(`[${PEER_LABEL}] ${line}`),
    yieldFn: () => new Promise(r => setImmediate(r)),
  });
  busRpc = createBusRpc({
    selfId: PEER_ID_STRING,
    publish(ev) { return bus ? bus.publish('map', ev) > 0 : false; },   // metered by nostr-bus.mjs itself (kind `map`)
    handle: (m, o) => mapSync.handle(m, o),
  });
  await libp2p.handle(MAP_PROTO, async (stream) => {
    const timer = setTimeout(() => stream.abort(new Error('map rpc timeout')), MAP_RPC_TIMEOUT_MS);
    try {
      const dec = createFrameDecoder(64 * 1024);
      let req = null;
      for await (const chunk of stream) { for (const m of dec.push(chunk instanceof Uint8Array ? chunk : chunk.subarray())) req ??= m; }
      if (!req) throw new Error('empty map request');
      netStat('libp2p', 'in', 'map_sync', mapFrameBytes(req));
      for (const m of mapSync.handle(req, { maxBytes: MAX_FRAME_BYTES })) {
        const f = encodeFrame(m);
        netStat('libp2p', 'out', 'map_sync', f.length);
        if (!stream.send(f)) await stream.onDrain();
      }
      await stream.close();
    } catch (e) { try { stream.abort(e); } catch {} }
    finally { clearTimeout(timer); }
  }, { maxInboundStreams: 8 });
  setInterval(() => mapSync.tick(), 3_000).unref?.();
  setInterval(() => {
    const s = mapSync.stats();
    if (s.pulls || s.served) console.log(`[${PEER_LABEL}] map-sync: root ${mapSync.myRoot()}, pulls ${s.pulls_ok}/${s.pulls} ok (+${s.gained} blocks, ${s.msgs_out}↑ ${s.msgs_in}↓ msgs, ${s.bytes_out}↑ ${s.bytes_in}↓ B), served ${s.served}, busy ${s.busy}`);
  }, 60_000).unref?.();
} else {
  console.log(`[${PEER_LABEL}] MAP_SYNC_LEGACY=1 — behaving like a pre-M3 build (map blocks via Gun + evt_map_sync, no map_root)`);
}
// E4: foreign-effect fetch/serve — libp2p /chaos/<dim>/effects/1 (same framing as map sync), bus `fx` fallback.
await fxPeer.attach({ libp2p, openConnTo, getBus: () => bus, netStat, forceBus: process.env.FX_FORCE_BUS === '1' });
// S4: foreign-skill fetch/serve — libp2p /chaos/<dim>/skills/1 (same framing), bus `sk` fallback.
await skPeer.attach({ libp2p, openConnTo, getBus: () => bus, netStat, forceBus: process.env.SK_FORCE_BUS === '1' });
// CH: foreign-class fetch/serve — libp2p /chaos/<dim>/classes/1 (same framing), bus `cl` fallback.
await clPeer.attach({ libp2p, openConnTo, getBus: () => bus, netStat, forceBus: process.env.CL_FORCE_BUS === '1' });
// AI skirmish routing (llm-route.mjs): /chaos/<dim>/llm/1 — direct libp2p ONLY (prompts hold a hand: never the public
// relay bus); a teammate's node serves only after its device key signs as one of my team profile's owners.
if (AI_ROLE || LLM_SERVE) {
  let handle = null;
  const request = await attachLlmRpc({ libp2p, proto: LLM_PROTO(DIM_ID), openConnTo, handle: LLM_SERVE ? (m) => (handle ? handle(m) : { op: 'denied', why: 'starting' }) : null });
  llmRouter = createLlmRouter({ cfg: LLM, remote: remoteConfig(process.env, process.env.LLM_PROFILE_FILE || PROFILE_FILE), auth: LLM_AUTH, selfId: PEER_ID_STRING,
    request: LLM_AUTH ? request : null, serve: LLM_SERVE, serveSlots: Math.max(1, Number(process.env.LLM_SERVE_SLOTS) || 2), log: (t) => console.log(`[${PEER_LABEL}] llm: ${t}`),
    candidates: () => livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && p.llm_srv && p.human && LLM_AUTH?.team && p.team_name === LLM_AUTH.team && sideOf(p.alliance) === MY_SIDE).map(p => p.peer_id) });
  handle = llmRouter.handle;
  setTimeout(() => llmRouter.refreshTeam().catch(() => {}), 3_000).unref?.();
  setInterval(() => llmRouter.refreshTeam().catch(() => {}), 15_000).unref?.();
}
// FXG: foreign profile cards that were not in the content cache at boot — fetched from the peers that announce
// them (fx_have / sk_have) or git / httpd; a card that arrives joins my deck (random spot) or archive. Private state.
if (profileForeignPending.length) for (const ms of [8_000, 30_000, 90_000]) setTimeout(async () => {
  for (const x of [...profileForeignPending]) {
    const fr = await foreignCardFromRef(x, { why: 'profile', quiet: ms < 90_000 }).catch(e => ({ status: 'missing', reason: e.message }));
    if (fr.status === 'missing' && ms < 90_000) continue;
    profileForeignPending.splice(profileForeignPending.indexOf(x), 1);
    if (fr.status !== 'ready') { console.warn(`[${PEER_LABEL}] profile: foreign ${x.kind} ${x.id} ${fr.status} (${fr.reason || ''}) — not in this game`); continue; }
    if (x.from) fr.card.from = x.from;
    if (x.where === 'archive') archive.push(fr.card); else deck.splice(Math.floor(Math.random() * (deck.length + 1)), 0, fr.card);
    console.log(`[${PEER_LABEL}] profile: foreign ${x.kind} ${x.id} learned (${fr.src}) → my ${x.where === 'archive' ? 'archive' : 'deck'}`);
  }
}, ms).unref?.();
// LEGACY ONLY (MAP_SYNC_LEGACY=1 simulates a pre-M3 build; remove in M6). Pre-M3 builds re-put their newest
// blocks into Gun once a minute — that is what drove the phone's Node heap to OOM (below).
// Re-put once a minute: Gun relays that came up after a block was first
// written (or that dropped it) converge on the next pass. Only blocks I
// revealed myself, and only the newest GUN_MAP_REPUT: Gun does not survive a
// burst of a few hundred puts (each relay re-put every block it held — joined /
// restored / companion seed blocks included — and on the phone, where the
// companions' relays are in-process workers meshed with mine, the Node heap
// hit 2 GB and aborted, 2026-11-14; a bench of 5 meshed relays re-putting
// 150 blocks each held 1–2 GB, 1,400 blocks → OOM in 110 s, a single writer
// of ≤ 61 blocks stays < 130 MB). Older blocks still converge through
// evt_map_sync (offerMapSync below) and the Door's map.
const GUN_MAP_REPUT = 24;
function syncMapToGun() { for (const b of dimMap.blocks().filter(x => x.by === PEER_ID_STRING).slice(-GUN_MAP_REPUT)) { netStat('gun', 'out', 'map', JSON.stringify(b).length); gunMap.get(b.id).put(b); } }
if (MAP_SYNC_LEGACY) { syncMapToGun(); setInterval(syncMapToGun, 60_000); }
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
// M3: this full-list push now serves pre-M3 peers only (no `map_root`). A new peer's first record may
// come as a slim Gun echo without its root, so wait MAP_SYNC_LEGACY_WAIT_MS after first sight before
// deciding it is old (its envelopes/heartbeat show the root by then). Remove with the Gun reader in M6.
const MAP_SYNC_LEGACY_WAIT_MS = 15_000;
const mapLegacyFirstSeen = new Map();   // peer_id -> first offerMapSync call (ms)
function offerMapSync(peerId, theirBlocks) {
  if (!dimMap) return;
  if (!mapLegacyFirstSeen.has(peerId)) mapLegacyFirstSeen.set(peerId, Date.now());
  if (mapSync && Date.now() - mapLegacyFirstSeen.get(peerId) < MAP_SYNC_LEGACY_WAIT_MS) return;
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
// -------- HUD telemetry (display only) --------
// Which share of MY hexes another node also holds, from its advertised bottom-K sketch: below the
// threshold τ = min(my K-th hash, its K-th hash) both sketches list every hash of their full sets, so
// the fraction of my sampled hashes ≤ τ that also appear in its sketch estimates |mine ∩ theirs| / |mine|
// (exact while either side holds fewer than K hexes; otherwise ± ~sqrt(p(1-p)/n), n ≤ 128).
const parsedSketches = new Map();   // peer_id -> { csv, set, max, full }
function mapShareOf(peerId, csv) {
  let ps = parsedSketches.get(peerId);
  if (!ps || ps.csv !== csv) {
    const hs = csv.split(',').filter(Boolean).map(x => parseInt(x, 36)).filter(Number.isFinite).sort((a, b) => a - b);
    ps = { csv, set: new Set(hs), max: hs.at(-1) ?? -1, full: hs.length >= MAP_SKETCH_K };
    parsedSketches.set(peerId, ps);
  }
  if (!ps.set.size || !mapSketch.length) return null;
  const tau = Math.min(mapSketch.length >= MAP_SKETCH_K ? mapSketch.at(-1) : Infinity, ps.full ? ps.max : Infinity);
  let n = 0, hit = 0;
  for (const h of mapSketch) { if (h > tau) break; n++; if (ps.set.has(h)) hit++; }
  return n ? { pct: hit / n, n, exact: !ps.full || mapSketch.length < MAP_SKETCH_K } : null;
}
function telemetryMsg() {
  const mu = process.memoryUsage();
  const shares = [];
  for (const p of livePeers()) {
    if (!p || !p.peer_id || p.peer_id === PEER_ID_STRING) continue;
    const role = p.owner_peer_id ? 'companion' : p.character_id ? 'player' : 'monster';
    const s = typeof p.map_sketch === 'string' && p.map_sketch ? mapShareOf(p.peer_id, p.map_sketch) : null;
    if (!s && role !== 'player') continue;   // players without a sketch (older build) still get listed as "?"
    shares.push({ peer_id: p.peer_id, name: p.name || p.peer_id, role, pct: s ? Math.round(s.pct * 1000) / 10 : null, n: s?.n || 0, exact: !!s?.exact,
      tiles: typeof p.map_tiles === 'number' ? p.map_tiles : null, alive: (p.life ?? 1) > 0, fresh: isFresh(p), source: 'live' });
  }
  // Nodes known only through their Door (as of when this peer joined): exact from the Door's blocks
  // (join-plan doorMapSummaries `held` — my map started as the union of the Doors and only grows),
  // else the Door's sketch, else "?". A node that showed up live since is listed above instead.
  for (const d of doorMaps) {
    if (!d?.peer_id || d.peer_id === PEER_ID_STRING || peersPublic.has(d.peer_id)) continue;
    const role = d.character_id ? 'player' : 'monster';
    const mine = dimMap ? dimMap.size() : 0;
    let s = null;
    if (typeof d.held === 'number' && mine) s = { pct: Math.min(1, d.held / mine), n: mine, exact: true };
    else if (typeof d.map_sketch === 'string' && d.map_sketch) s = mapShareOf(`door:${d.peer_id}`, d.map_sketch);
    if (!s && role !== 'player') continue;
    shares.push({ peer_id: d.peer_id, name: d.name || d.peer_id, role, pct: s ? Math.round(s.pct * 1000) / 10 : null, n: s?.n || 0, exact: !!s?.exact,
      tiles: typeof d.map_tiles === 'number' ? d.map_tiles : null, alive: (d.life ?? 1) > 0, fresh: false, source: 'door', pushed_at: d.pushed_at || null });
  }
  for (const id of parsedSketches.keys()) if (!id.startsWith('door:') && !peersPublic.has(id)) parsedSketches.delete(id);
  return { kind: 'telemetry', at: Date.now(), mobile: IS_MOBILE, companion: IS_COMPANION,
    mem: { rss: mu.rss, heap_used: mu.heapUsed, heap_total: mu.heapTotal, external: mu.external },
    map: { tiles: dimMap ? dimMap.size() : 0, blocks: dimMap ? dimMap.blockCount() : 0 }, shares, net: netSnapshot() };
}
const TELEMETRY_MS = 5_000;
setInterval(() => { if (uiClients.size) broadcastUI(telemetryMsg()); }, TELEMETRY_MS).unref?.();
// Discovering the Dimension (user ruling 2026-11-12): each building trap a hero's new disc uncovers has a
// 30% chance (rolled on its hex) of an enemy monster lurking next to it. It enters asleep and wakes when a
// hero comes within 2 hexes. Its label comes from the trap's hex: nobody spawns the same lurker twice.
const MAX_WILD_CHILDREN = IS_MOBILE ? 2 : 3;
const WILD_MONSTERS = Object.keys(data.creatures).filter(id => id.startsWith('mon_') && !data.creatures[id].data?.built_in && !(data.creatures[id].tags || []).includes('summon_only')).sort();
const lurkersChecked = new Set();
function discoverTrapMonsters(cq, cr) {
  if (IS_COMPANION || entity.kind !== 'character' || !WILD_MONSTERS.length || process.env.WILD_LURKERS === '0') return;
  const R = REVEAL_RADIUS;
  for (let dq = -R; dq <= R; dq++) for (let dr = Math.max(-R, -dq - R); dr <= Math.min(R, -dq + R); dr++) {
    const q = cq + dq, r = cr + dr, key = `${q},${r}`;
    if (lurkersChecked.has(key)) continue;
    const dg = dungeonAt(MAP_SEED, q, r);
    const w = worldTrapAt(q, r) || (dg ? { building: dg.source } : null);
    if (w === null && !_worldTraps.has(key) && !dg) continue;   // catalogue not loaded yet — look again next time
    lurkersChecked.add(key);
    if (!w) continue;
    // Discovered at a distance: never right on top of the hero who uncovers it (nor at the spawn disc).
    if (hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, { tile_q: q, tile_r: r }) < 4) continue;
    const h = sha256Hex(`${MAP_SEED}:lurker:${key}`);
    if (parseInt(h.slice(0, 8), 16) / 0x100000000 >= WORLD_TRAP_MONSTER_RATE) continue;
    const label = `lurker_${q}_${r}`.replace(/-/g, 'm');
    if (peersPublic.has(`peer:${label}`) || companions.some(c => c.label === label)) continue;
    // One spawner (swarm-2227: three heroes uncovered the hex within the gossip delay and each started the lurker under
    // the same peer id): the live, fresh, unowned HUMAN hero (only they scan, IS_HUMAN) with the smallest peer id among those that could have uncovered it
    // at a distance (4 ≤ d ≤ REVEAL_RADIUS, snapshot tiles). The others look again later, in case it never does.
    const at = { tile_q: q, tile_r: r };
    const spawners = livePeers().filter(p => p && p.character_id && !p.owner_peer_id && !p.shadow_of && (p.life ?? 0) > 0 && (p.peer_id === PEER_ID_STRING || (p.human && isFresh(p))))
      .filter(p => { const t = p.peer_id === PEER_ID_STRING ? { tile_q: entity.tile.q, tile_r: entity.tile.r } : p; const d = Number.isInteger(t.tile_q) ? hexDistance(t, at) : Infinity; return d >= 4 && d <= R; })
      .map(p => p.peer_id).sort();
    if (spawners.length && spawners[0] !== PEER_ID_STRING) { lurkersChecked.delete(key); continue; }
    if (companions.filter(c => c.wild).length >= MAX_WILD_CHILDREN) { lurkersChecked.delete(key); continue; }
    const cid = WILD_MONSTERS[parseInt(h.slice(8, 16), 16) % WILD_MONSTERS.length];
    const name = data.creatures[cid].name;
    spawnCompanion(null, { creature_id: cid, name, at: { q, r }, ringOnly: true, wild: true, label, env: { CHARACTER_ID: '', CREATURE_ID: cid, ENTITY_NAME: name } })
      .then(tag => { if (tag) console.log(`[${PEER_LABEL}] a ${name} lurks by the ${w.building} at (${q},${r}) — it wakes when a hero comes near`); }).catch(e => console.warn(`[${PEER_LABEL}] lurker failed: ${e.message}`));
  }
}
// Shadows (user ruling 2026-11-12): a wild monster whose peer has been silent for two minutes is replaced by
// a fresh one of the same creature, same life, on the same tile — by the live hero with the smallest peer
// id, so only one of us does it. Summoned creatures are never replaced (follow-up ruling, same day).
const GHOST_MS = 120_000;
// Was it ME who went quiet? (2026-11-23, New-Silent-Wilds: the box swapped, both builders froze for ~2 min, woke up to
// find every snapshot 127 s old and EACH spawned stand-ins for the hero — who had left cleanly — and fresh monsters.)
// A 1 s tick that comes > 5 s late means my own event loop stalled; then nobody is judged silent until a full silence
// window has passed with me awake, so the snapshots that were only stale on my side get refreshed first.
const SELF_STALL_MS = 5_000;
let selfTickAt = Date.now(), selfStallUntil = 0;
setInterval(() => {
  const now = Date.now();
  if (now - selfTickAt > SELF_STALL_MS) {
    if (now >= selfStallUntil) console.log(`[${PEER_LABEL}] stall: my event loop was frozen ${Math.round((now - selfTickAt) / 1000)}s — nobody is judged silent for ${Math.round(Math.max(GHOST_MS, SHADOW_MS) / 1000)}s`);
    selfStallUntil = now + Math.max(GHOST_MS, SHADOW_MS);
  }
  selfTickAt = now;
}, 1_000).unref?.();
const selfStalled = (now = Date.now()) => now < selfStallUntil || now - selfTickAt > SELF_STALL_MS;
const replacedGhosts = new Set();
setInterval(() => {
  if (IS_COMPANION || SHADOW_OF || entity.kind !== 'character' || entity.life <= 0 || !dimMap) return;
  const now = Date.now();
  if (selfStalled(now)) return;
  const heroes = livePeers().filter(p => p && p.character_id && !p.owner_peer_id && !p.shadow_of && (p.life ?? 0) > 0 && (p.peer_id === PEER_ID_STRING || isFresh(p))).map(p => p.peer_id).sort();
  const summonedByAnyone = new Set(livePeers().flatMap(p => String(p?.summoned_csv || '').split(',').filter(Boolean)));
  for (const p of livePeers()) {
    if (!p || p.peer_id === PEER_ID_STRING || replacedGhosts.has(p.peer_id) || !p.creature_id || (p.life ?? 0) <= 0 || !Number.isInteger(p.tile_q)) continue;
    if (now - Date.parse(p.last_seen || 0) < GHOST_MS) continue;
    // Monsters only: a summoned / bound / summon-only creature is left as it is.
    if (p.owner_peer_id || data.creatures[p.creature_id]?.data?.built_in || summonedByAnyone.has(p.peer_id)) continue;
    if (heroes[0] !== PEER_ID_STRING || companions.filter(c => c.wild).length >= MAX_WILD_CHILDREN) continue;
    replacedGhosts.add(p.peer_id);
    const label = `${String(p.peer_id).replace(/^peer:/, '').replace(/-r\d+$/, '')}-r${++summonSeq}`;
    const name = String(p.name || data.creatures[p.creature_id]?.name || p.creature_id);
    peersPublic.delete(p.peer_id);
    broadcastUI({ kind: 'peers', peers: peersForUI(), dropped: true });
    console.log(`[${PEER_LABEL}] ${name} (${p.peer_id}) has been silent ${Math.round((now - Date.parse(p.last_seen || 0)) / 1000)}s — a fresh one takes its place at (${p.tile_q},${p.tile_r})`);
    spawnCompanion(null, { creature_id: p.creature_id, name, at: { q: p.tile_q, r: p.tile_r }, wild: true, label, ignore: p.peer_id, env: { CHARACTER_ID: '', CREATURE_ID: p.creature_id, ENTITY_NAME: name, REPLACES_PEER_ID: p.peer_id, START_LIFE: String(p.life) } })
      .catch(e => console.warn(`[${PEER_LABEL}] replacement failed: ${e.message}`));
  }
}, 20_000);
// Unattended characters (rule_unattended_character, user ruling 2026-11-16, revised): "after 2 minutes the character
// should be PC operated" — a hero (a character with no owner: a player's hero, a HUMAN profile hero, a team ally
// whose device vanished; never a summon) silent for SHADOW_MS (120 s, the same as GHOST_MS; always, not only in
// combat) becomes unattended: the live hero with the smallest peer id (never an unattended one) starts an ordinary
// peer with the same character, name, side, class, stats, tile, current life and ally-join link (SHADOW_OF = the
// hero, REPLACES_PEER_ID = the silent peer, ALLY_OF). npcPlan plays it as an allied bot that follows its master
// (unattendedLeader); it can be killed like the hero — its death hands the hero's published death card to the killer
// (dropDeathCard). The returning player takes it over (REPLACES_PEER_ID = it, its life — ui-server / mobile-menu
// restore-here / rejoin / unit-list join) or, if its game was only cut off, takes the place back when it hears it
// (heroShadowSeen). Never two copies. Keyed by peer id + joined_at: a hero that came back and closes again is
// left unattended again.
const shadowedHeroes = new Set();
setInterval(() => {
  if (DIM_PRIVATE || IS_COMPANION || SHADOW_OF || entity.kind !== 'character' || entity.life <= 0 || !dimMap) return;
  const now = Date.now();
  if (selfStalled(now)) return;   // I was the frozen one (see SELF_STALL_MS)
  const heard = p => p.peer_id === PEER_ID_STRING || now - Date.parse(p.last_seen || 0) < Math.min(PEER_STALE_MS, SHADOW_MS);
  const spawners = livePeers().filter(p => p && p.character_id && !p.owner_peer_id && !p.shadow_of && (p.life ?? 0) > 0 && heard(p)).map(p => p.peer_id).sort();
  if (spawners[0] !== PEER_ID_STRING) return;
  for (const p of livePeers()) {
    const key = `${p?.peer_id}|${p?.joined_at || ''}`;
    if (!p || p.peer_id === PEER_ID_STRING || p.out || shadowedHeroes.has(key) || supersededBy.has(p.peer_id)) continue;
    if (!p.character_id || p.creature_id || p.owner_peer_id || (p.life ?? 0) <= 0 || !Number.isInteger(p.tile_q)) continue;
    const silent = now - Date.parse(p.last_seen || 0);
    if (silent < SHADOW_MS) continue;
    shadowedHeroes.add(key);
    const hero = p.shadow_of || p.peer_id;   // a shadow whose host vanished gets a shadow of the same hero
    const label = `${String(hero).replace(/^peer:/, '')}-sh${Date.now().toString(36).slice(-5)}`;
    supersededBy.set(p.peer_id, `peer:${label}`);
    peersPublic.delete(p.peer_id);
    broadcastUI({ kind: 'peers', peers: peersForUI(), dropped: true });
    console.log(`[${PEER_LABEL}] shadow: ${p.name || hero} (${p.peer_id}) silent ${Math.round(silent / 1000)}s — it stands unattended at (${p.tile_q},${p.tile_r}) hp ${p.life}, computer-operated${p.ally_of ? ` (ally-join link ${p.ally_of})` : ''}`);
    const stats = { vitality: p.stat_vitality, world: p.stat_world, matter: p.stat_matter, will: p.stat_will };
    spawnCompanion(null, { creature_id: null, name: `${p.name || hero} (unattended)`, at: { q: p.tile_q, r: p.tile_r }, wild: true, label, ignore: p.peer_id,
      env: { CHARACTER_ID: p.character_id, CREATURE_ID: '', ENTITY_NAME: String(p.name || hero), ALLIANCE: String(p.alliance || 'player'), SHADOW_OF: hero, REPLACES_PEER_ID: p.peer_id, ALLY_OF: p.ally_of || '',
        START_LIFE: String(p.life), FORCE_CLASS: p.class_id || '', SHADOW_STATS_JSON: JSON.stringify(stats), SHADOW_DEATH_CARD: p.death_card_json && p.death_card_json !== 'null' ? p.death_card_json : '',
        SHADOW_PROFILE_CHAR_ID: p.profile_char_id || '', PROFILE_TEAM: p.team_name || '', FOREIGN_CLASS_REF_JSON: p.cl_ref_json || '' } })   // CH: the hero's foreign class by ref
      .catch(e => console.warn(`[${PEER_LABEL}] shadow of ${p.peer_id} failed: ${e.message}`));
  }
}, Math.min(20_000, Math.max(5_000, Math.round(SHADOW_MS / 4))));
// I am a shadow and something took my place (my hero came back, or a newer shadow of it): I step down.
function shadowStepDown(p) {
  if (_shadowLeaving) return;
  _shadowLeaving = true;
  console.log(`[${PEER_LABEL}] shadow: ${p.name || p.peer_id} (${p.peer_id}) takes my place${p.peer_id === SHADOW_OF ? ' — my hero is back' : ''} (hp ${p.life}); the shadow steps down`);
  setTimeout(() => process.exit(0), 300);
}
// I am a hero and I hear a shadow of me (my game was cut off long enough for one to stand in): I take its place
// back — its life when lower (it may have been hurt), dead if it was killed (its killer already has my death card;
// my profile loses it here). Never two copies: my snapshots now name it in `replaces`.
function heroShadowSeen(s) {
  replacesNow = s.peer_id;
  const before = entity.life;
  if ((s.life ?? 0) <= 0) entity.life = 0;
  else if (Number.isFinite(s.life) && s.life < entity.life) entity.life = s.life;
  allyOfNow = '';   // back in my own hands: I leave my master's group
  console.log(`[${PEER_LABEL}] shadow: my shadow ${s.peer_id} stood in for me (hp ${s.life}) — I take its place back (hp ${before} → ${entity.life})`);
  if (entity.life <= 0 && profileChar && s.shadow_death_json) {
    import('./shadow-settle.mjs').then(m => m.settleShadowDeaths(PROFILE_FILE, [{ ...s, profile_char_id: PROFILE_CHAR_ID }])).then(r => r?.length && console.log(`[${PEER_LABEL}] shadow: ${r.map(x => x.text).join('; ')}`)).catch(e => console.warn(`[${PEER_LABEL}] shadow settle failed: ${e.message}`));
  }
  publishPublicState().catch(() => {});
}
// Unattended characters — the master (user ruling 2026-11-16): "any player who joins him will become his master,
// deriving all other characters (whose players close the game) that join one of those players by its link … Once an
// alive player is leading those unattended characters the new player join should not gain the leadership of them."
// My LINK GROUP = the characters of my side connected to me through ally-join links (ally_of, either direction; a
// link naming a hero also reaches its unattended copy). Its master: the one a group mate (or I) already follows
// while it is alive and live (sticky — the earliest of those if two were claimed at once), else the live, alive
// human character of the group with the earliest joined_at (tie: peer id). null = leaderless (I hold my ground).
// Decided by each unattended character for itself from the shared snapshots and published as led_by.
const liveSnap = (p, now) => !!p && (p.life ?? 0) > 0 && !p.out && now - Date.parse(p.last_seen || 0) < Math.min(PEER_STALE_MS, SHADOW_MS);
function unattendedLeader(now = Date.now()) {
  if (!SHADOW_OF) return null;
  const me = { peer_id: PEER_ID_STRING, shadow_of: SHADOW_OF, ally_of: allyOfNow, led_by: ledBy };
  const nodes = [me, ...livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && p.character_id && !p.creature_id && !p.owner_peer_id && !p.out && sideOf(p.alliance) === MY_SIDE)];
  const keys = n => [n.peer_id, n.shadow_of].filter(Boolean);
  const group = new Set([me]); const queue = [me];
  while (queue.length) {
    const n = queue.shift(), kn = keys(n);
    for (const o of nodes) if (!group.has(o) && ((n.ally_of && keys(o).includes(n.ally_of)) || (o.ally_of && kn.includes(o.ally_of)))) { group.add(o); queue.push(o); }
  }
  const canLead = p => !!p && !!p.human && !p.shadow_of && sideOf(p.alliance) === MY_SIDE && liveSnap(p, now);
  const rank = (a, b) => ((Date.parse(a.joined_at || 0) || 0) - (Date.parse(b.joined_at || 0) || 0)) || String(a.peer_id).localeCompare(String(b.peer_id));
  const claimed = [...new Set([...group].filter(n => n.shadow_of && n.led_by).map(n => n.led_by))].map(id => peersPublic.get(id)).filter(canLead).sort(rank);
  if (claimed.length) return claimed[0];
  return [...group].filter(canLead).sort(rank)[0] || null;
}
// Leaving the dimension cleanly (an unattended character alone for VANISH_MS; Dimension Out): no death, no card —
// my snapshots say `out` (receivers drop me, mergePeerState) and so does my Door (join-plan.mjs: not alive here),
// then the process ends.
function leaveDimension(why) {
  if (outNow) return;
  outNow = true;
  console.log(`[${PEER_LABEL}] out: ${why} — I leave the dimension (no death, no card)`);
  dropDimensionCards('I leave the dimension');
  broadcastUI({ kind: 'dim_out_done', why, dimension: DIM_NAME });   // the UI goes back to the menu
  // The phone (nodejs-mobile starts Node once per app process): never exit — mobile-entry.mjs stops this peer
  // (__chaosPeerStop) and serves the start menu again. Desktop / worker peers: the process ends.
  const inProcess = IS_MOBILE && typeof globalThis.__chaosMobileLeave === 'function';   // (a worker has its own globalThis: it exits)
  const exitSoon = () => setTimeout(() => { if (inProcess) globalThis.__chaosMobileLeave({ why, dimension: DIM_NAME }); else process.exit(0); }, 1500);
  publishPublicState().catch(() => {}).finally(() => setTimeout(() => publishPublicState().catch(() => {}).finally(() => Promise.resolve().then(() => publishDoor()).catch(() => {}).finally(exitSoon)), 1500));
}
// Dimension Out (rule_dimension_out, user 2026-11-16): my own character leaves the dimension cleanly through a
// pseudo-cast of DIM_OUT_ROUNDS paper rounds (= engine turns, 3 actions each), counted down on my unit for everyone
// (snapshot dim_out_until_turn). Moving, attacking or casting another effect cancels it (Rule 19, like a cast;
// doPlanningEnd); damage does not, and I can be killed meanwhile (dead → it ends, nothing else). Done → out
// (leaveDimension): no death, no card, no unattended copy, free for another dimension. Started by the HUD button
// (UI 'dim_out'), DIM_OUT_ON_START=1 (the start screen's "⇱ Dimension Out": restore-here + this), never by bots
// unless SWARM_DIMOUT=1. (DIM_OUT_CFG / DIM_OUT_ROUNDS load with the other rules; `dimOut` sits by `outNow`.)
function dimOutStart(why) {
  if (dimOut || outNow || entity.life <= 0 || entity.kind !== 'character' || ownerPeerId) return false;
  dimOut = { start_turn: hg.turn, until_turn: hg.turn + DIM_OUT_ROUNDS };
  console.log(`[${PEER_LABEL}] dimension out: started by ${why} at T${hg.turn} — I leave at T${dimOut.until_turn} (${DIM_OUT_ROUNDS} rounds) unless I move, attack or cast`);
  broadcastUI({ kind: 'dim_out', active: true, until_turn: dimOut.until_turn, turn: hg.turn });
  publishPublicState().catch(() => {});
  return true;
}
function dimOutCancel(why) {
  if (!dimOut) return;
  console.log(`[${PEER_LABEL}] dimension out: interrupted (${why}) at T${hg.turn} — ${Math.max(0, dimOut.until_turn - hg.turn)} rounds were left`);
  dimOut = null;
  broadcastUI({ kind: 'dim_out', active: false, why });
  publishPublicState().catch(() => {});
}
// Encounter cleared (user 2026-11-23): "once the Encounter is cleared you may leave the Dimension immediately" — the
// UI's banner decides the encounter is won (main.js checkEncounter); here I only refuse while a live enemy is still
// within my sight radius, so the shortcut can't be used to run from a fight. Not part of the resolver / state hash.
function dimOutNow() {
  if (outNow || entity.life <= 0 || entity.kind !== 'character' || ownerPeerId) return false;
  const me = { tile_q: entity.tile.q, tile_r: entity.tile.r };
  const now = Date.now();
  const foe = livePeers().find(p => p && p.peer_id !== PEER_ID_STRING && sideOf(p.alliance) !== MY_SIDE && liveSnap(p, now) && hexDistance(me, p) <= REVEAL_RADIUS);
  if (foe) {
    console.log(`[${PEER_LABEL}] dimension out now: refused — ${foe.name || foe.peer_id} is still in sight`);
    broadcastUI({ kind: 'dim_out', active: false, refused: true, why: `${foe.name || 'an enemy'} is still in sight — use ⇱ Dimension Out` });
    return false;
  }
  dimOut = null;
  leaveDimension(`encounter cleared — left at once (T${hg.turn})`);
  return true;
}
setInterval(() => {
  if (outNow) return;
  if (!dimOut && process.env.DIM_OUT_ON_START === '1' && !dimOutCancel.started && hg.turn > 0 && entity.life > 0 && currentPhase === 'planning') {
    dimOutCancel.started = true;   // once per process
    dimOutStart('the start screen (DIM_OUT_ON_START)');
  }
  // Swarm bot heroes are player-alliance peers (IS_HUMAN), so SWARM_DIMOUT must not exclude them (Swarm combo run 2: 0 casts).
  // …but never the hero SWARM_SHADOW kills (swarm-0710: P-Agent4 dimensioned out before its kill → no shadow to test).
  if (!dimOut && process.env.SWARM_DIMOUT === '1' && !SHADOW_OF && !IS_COMPANION
    && !(process.env.SWARM_SHADOW === '1' && PEER_LABEL === (process.env.SWARM_SHADOW_LABEL || 'P-Agent4')) && entity.kind === 'character' && entity.life > 0 && hg.turn >= 3
    && currentPhase === 'planning' && dimOutCancel.botTurn !== hg.turn) { dimOutCancel.botTurn = hg.turn; if (Math.random() < 0.15) dimOutStart('the swarm bot (SWARM_DIMOUT)'); }
  if (!dimOut) return;
  if (entity.life <= 0) { console.log(`[${PEER_LABEL}] dimension out: I fell before it was done`); dimOut = null; return; }
  if (hg.turn >= dimOut.until_turn) leaveDimension(`Dimension Out complete (${DIM_OUT_ROUNDS} rounds, T${dimOut.start_turn}→T${hg.turn})`);
}, 1000);
// Unattended: follow / hold, and vanish — "If there is no close character to your unattended character he vanishes
// from the dimension after 1 hour": no living attended character (other unattended ones don't count; my master
// does) within VANISH_RADIUS (rule data, 10 = the reveal radius) for VANISH_MS → leaveDimension.
let aloneSince = Date.now(), wasClose = null;
setInterval(() => {
  if (!SHADOW_OF || _shadowLeaving || outNow || entity.life <= 0 || !dimMap) return;
  const now = Date.now();
  const L = unattendedLeader(now);
  const id = L?.peer_id || '';
  if (id !== ledBy) {
    console.log(`[${PEER_LABEL}] unattended: ${id ? `I follow ${L.name || id} (${id}) — my master` : `my master ${ledBy} is gone — I hold my ground`}`);
    ledBy = id;
    publishPublicState().catch(() => {});
  }
  const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
  // (my own silent hero's last record — the one I replaced — never counts; nor anybody silent itself)
  const near = livePeers().find(p => p && p.peer_id !== PEER_ID_STRING && p.peer_id !== SHADOW_OF && p.peer_id !== REPLACES_PEER_ID && !supersededBy.has(p.peer_id) && liveSnap(p, now)
    && Number.isInteger(p.tile_q) && ((p.character_id && !p.creature_id && !p.shadow_of) || p.peer_id === ledBy) && hexDistance(here, p) <= VANISH_RADIUS);
  const close = !!near;
  if (close !== wasClose) {
    console.log(`[${PEER_LABEL}] unattended: ${close ? `${near.name || near.peer_id} (${near.peer_id}) is close — no vanish` : `nobody within ${VANISH_RADIUS} hexes — I leave the dimension in ${Math.round(VANISH_MS / 1000)}s unless somebody comes`}`);
    wasClose = close;
  }
  if (close) aloneSince = now;
  else if (now - aloneSince >= VANISH_MS) leaveDimension(`unattended and alone (nobody within ${VANISH_RADIUS} hexes) for ${Math.round((now - aloneSince) / 1000)}s`);
}, 3000);
// `boot`: a bot that enters OFF the known map (a "Join my team" gate 30–50 hexes out, a test-team ally
// 9–10 hexes from player-1) reveals the disc around its entry like a human does (user ruling 2026-11-13).
// Profile bots only (monsters keep today's fog). The block is shared like any other, so every peer resolves
// against the same map. Bots never wake lurkers.
async function revealAround(q, r, { boot = false } = {}) {
  if (!IS_HUMAN && !(boot && (profileChar || TEAM_GATE) && !dimMap.has(q, r))) return;
  if (!dimMap.needsReveal(q, r, REVEAL_RADIUS)) return;
  const b = discBlock(q, r, REVEAL_RADIUS, PEER_ID_STRING);
  if (!addMapBlock(b, 'self')) return;
  if (IS_HUMAN) try { discoverTrapMonsters(q, r); } catch (e) { console.warn(`[${PEER_LABEL}] lurker scan failed: ${e.message}`); }
  // M3: no Gun put (pre-M3 builds still get the disc via evt_map_extend + evt_map_sync); legacy sim only — remove in M6.
  if (MAP_SYNC_LEGACY) { netStat('gun', 'out', 'map', JSON.stringify(b).length); gunMap.get(b.id).put(b); }
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

// Gun gets the slim member record only (gun-member.mjs: ≤ 2 KB, changed fields only, at most one put
// per GUN_MIN_PUT_MS, keep-alive each minute). The full snapshot — map_sketch included — goes on the
// bus `state` event, the discovery mirror and the Door instead.
let gunLastRec = null, gunLastPutAt = 0, gunDropWarned = '';
const gunPutStats = { puts: 0, bytes: 0, last: 0, max: 0, skipped: 0 };
function putGunMember(snap) {
  if (NOGUN) return;
  const { rec, bytes, dropped, over } = slimMemberRecord(snap);
  const sig = dropped.join(',') + (over ? ' OVER' : '');
  if (sig !== gunDropWarned) { gunDropWarned = sig; if (sig) console.warn(`[${PEER_LABEL}] gun member record ${bytes} B > cap ${GUN_MEMBER_CAP} B — dropped ${sig}`); }
  const patch = gunMemberPatch(gunLastRec, rec, { lastPutAt: gunLastPutAt });
  if (!patch) { gunPutStats.skipped++; return; }
  myNode.put(patch);
  gunLastRec = rec; gunLastPutAt = Date.now();
  const b = recordBytes(patch);
  netStat('gun', 'out', 'members', b);
  gunPutStats.puts++; gunPutStats.bytes += b; gunPutStats.last = b; gunPutStats.max = Math.max(gunPutStats.max, b);
}
setInterval(() => {
  const s = gunPutStats;
  if (s.puts) console.log(`[${PEER_LABEL}] gun members: ${s.puts} puts, avg ${Math.round(s.bytes / s.puts)} B, max ${s.max} B, last ${s.last} B, record ${gunLastRec ? recordBytes(gunLastRec) : 0} B (full snapshot ${recordBytes(currentStateSnapshot())} B), ${s.skipped} deduped`);
}, 60_000).unref?.();
// The fields only the full snapshot carries (fingerprint + dialing hints): when they changed, the
// heartbeat sends the full snapshot over the bus at most once a FULL_STATE_BUS_MS even while busy.
const FULL_STATE_BUS_MS = 60_000;
let lastFullBusAt = 0, lastFullBusSig = '';
const fullOnlySig = (s) => `${s.map_tiles}|${s.map_sketch}|${s.multiaddrs_csv}|${s.nostr_relays_csv}|${s.gun_url}`;
function fullStateDue() { return Date.now() - lastFullBusAt >= FULL_STATE_BUS_MS && fullOnlySig(currentStateSnapshot()) !== lastFullBusSig; }
// M6 step 1 — the live clock on the wire (Gun's GUN_URGENT job, the Swarm-0226 fix): between a peer's
// state hash and its next commit nothing else says "I am planning action N until T", and enterPhase
// (cohort / trail the slowest), waitingOnBusyMember and catchUpClock read exactly that. Every clock change
// goes out at once as a small `clock` frame (the slim core record, ~300 B): on libp2p always, on the bus
// when it opens a planning window (≈1 relay event per action — the handshake envelopes already carry the
// reveal / resolution phases). Deduped on action|phase|deadline; receivers merge it like any snapshot.
const CLOCK_KEYS = GUN_MEMBER_CORE.filter(k => k !== 'gun_v');
let lastClockSig = '', lastClockBusSig = '';
function publishClock(snap) {
  const { sig, rec } = clockFrame(snap, CLOCK_KEYS);
  if (sig === lastClockSig) return;
  lastClockSig = sig;
  const raw = JSON.stringify({ kind: 'clock', dim: DIM_ID, state: rec });
  netStat('libp2p', 'out', 'clock', raw.length);
  libp2p.services.pubsub.publish(TOPIC_STRONG, new TextEncoder().encode(raw)).catch(() => {});
  if (bus && snap.phase === 'planning' && sig !== lastClockBusSig) { lastClockBusSig = sig; bus.publish('clock', rec); }
}
// `viaBus` is for the heartbeat/startup/join paths; the per-round calls skip
// it because every envelope already carries the snapshot.
async function publishPublicState(viaBus = false) {
  const snap = currentStateSnapshot();
  putGunMember(snap);
  publishClock(snap);
  peersPublic.set(PEER_ID_STRING, snap);
  noteTile(snap.tile_q, snap.tile_r);
  if (viaBus) {
    // The full snapshot (map_sketch, dialing hints) to everyone: the bus, and the gossipsub mesh as a
    // non-envelope `state` frame so local meshes without the bus get it too.
    bus?.publish('state', snap); lastBusAt = lastFullBusAt = Date.now(); lastFullBusSig = fullOnlySig(snap);
    const frame = new TextEncoder().encode(JSON.stringify({ kind: 'state', dim: DIM_ID, state: snap }));
    netStat('libp2p', 'out', 'state', frame.length);
    libp2p.services.pubsub.publish(TOPIC_STRONG, frame).catch(() => {});
  }
  if (DISCOVERY_URL) await postJson(`${DISCOVERY_URL}/state`, { dimension_id: DIM_ID, peer_id: PEER_ID_STRING, state: snap });
  broadcastUI({ kind: 'peers', peers: peersForUI() });
}

// Answer a newcomer (bus `who`, or a new libp2p subscriber to our topic) with our full state, after a
// short jitter so a crowd does not answer in the same instant; at most once per WHO_REPLY_MS per transport.
let busWhoAt = 0;
const WHO_REPLY_MS = 5_000;
const whoReplyAt = { bus: 0, libp2p: 0 };
function whoReply(via) {
  if (Date.now() - whoReplyAt[via] < WHO_REPLY_MS) return;
  whoReplyAt[via] = Date.now();
  setTimeout(() => {
    if (via === 'bus') { publishPublicState(true).catch(() => {}); return; }
    const raw = JSON.stringify({ kind: 'state', dim: DIM_ID, state: currentStateSnapshot() });
    netStat('libp2p', 'out', 'state', raw.length);
    libp2p.services.pubsub.publish(TOPIC_STRONG, new TextEncoder().encode(raw)).catch(() => {});
  }, 150 + Math.floor(Math.random() * 750));
}
// -------- public Nostr bus --------
if (NOSTR_ENABLED) {
  bus = createNostrBus({
    relays: DEFAULT_RELAYS, dimId: DIM_ID, label: PEER_LABEL,
    meter: (dir, t, et, bytes) => netStat('bus', dir, t === 'env' ? (et || 'env') : t, bytes),
    // Directory without Gun (M6 step 1): on the first open relay (and on a reconnect, ≥ 10 s apart) ask
    // `who` is here and send our full state — public relays never store the ephemeral kind, so there is
    // no replay to lean on; every peer that hears a `who` answers with its full state (whoReply).
    onOpen() {
      if (Date.now() - (busWhoAt || 0) < 10_000) return;
      busWhoAt = Date.now();
      bus.publish('who', { peer_id: PEER_ID_STRING });
      publishPublicState(true).catch(() => {});
    },
    onEvent(type, payload) {
      if (type === 'env') receiveEnvelope(payload, 'bus');
      else if (type === 'state' || type === 'clock') { if (mergePeerState(payload)) broadcastUI({ kind: 'peers', peers: peersForUI() }); }
      else if (type === 'who' && payload?.peer_id && payload.peer_id !== PEER_ID_STRING) whoReply('bus');
      else if (type === 'map' && busRpc && payload?.to === PEER_ID_STRING) busRpc.deliver(payload);   // map-sync request/response addressed to us (M3; metered by the bus as kind `map`)
      else if (type === 'fx' && payload?.to === PEER_ID_STRING) fxPeer.onBus(payload);   // E4 foreign-effect fetch addressed to us
      else if (type === 'sk' && payload?.to === PEER_ID_STRING) skPeer.onBus(payload);   // S4 foreign-skill fetch addressed to us
      else if (type === 'cl' && payload?.to === PEER_ID_STRING) clPeer.onBus(payload);   // CH foreign-class fetch addressed to us
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
  const idle = Date.now() - lastBusAt > HEARTBEAT_MS - 1000;
  publishPublicState(idle || fullStateDue()).catch(() => {});
}, HEARTBEAT_MS);

// Also pull every other peer's public state live from Gun (slow-tier CRDT).
// Relay graphs can still carry entries from peers that died; mergePeerState
// only accepts entries that look current, and merges rather than replaces so a
// partial Gun echo (which sometimes drops fields) doesn't wipe tile/life.
// Only the slim member fields are taken (pickGunMember), and an echo older than what a faster
// transport already told us only fills gaps (gunMergeable).
dimRoot.get('doors').get(DOOR_ID).get('members').map().on((m) => {
  netStat('gun', 'in', 'members', m && typeof m === 'object' ? Object.keys(m).length * 24 : 0);   // ≈ bytes without a stringify
  const rec = pickGunMember(m);
  const p = rec && rec.peer_id !== PEER_ID_STRING ? gunMergeable(peersPublic.get(rec.peer_id), rec) : null;
  if (p && mergePeerState(p, 'gun')) broadcastUI({ kind: 'peers', peers: peersForUI() });
});

// Optional discovery mirror: pull everyone's registered state and merge.
async function pullDiscoveryState() {
  if (!DISCOVERY_URL) return;
  try {
    const r = await fetch(`${DISCOVERY_URL}/peers/${DIM_ID}`);
    netStat('discovery', 'in', 'state', Number(r.headers.get('content-length')) || 0);
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
  if (alliance === 'player_c' || alliance === 'npc_c') return 'C';   // third team: hostile to A and B
  if (alliance === 'player_d' || alliance === 'npc_d') return 'D';   // fourth team (user ruling 2026-11-15): hostile to A, B and C
  return alliance;
}
// The alliance a summon / bound creature takes on a side.
function npcAllianceOf(side) { return side === 'A' ? 'npc_a' : side === 'C' ? 'npc_c' : side === 'D' ? 'npc_d' : 'npc_b'; }
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
    // Sub-action offset correction (Swarm-0407): when every fresh peer already planning this action
    // closes its window well before ours, our cadence slid behind the cohort's — we would commit after
    // they closed the action and our reveal would land "late" everywhere, action after action, while
    // our own resolver applied it. Pull in to the cohort's (latest) deadline, keeping the 2 s floor.
    const cohortEnd = cohortDeadline(clockPeers().filter(p => p.peer_id !== PEER_ID_STRING), hg.action);
    if (cohortEnd !== null && roundDeadline > cohortEnd + 1000) {
      const was = roundDeadline;
      roundDeadline = Math.max(cohortEnd, Date.now() + 2000);
      if (was - roundDeadline > 250) console.log(`[${PEER_LABEL}] phase offset: planning deadline for T${hg.turn}.R${hg.round + 1} pulled in ${was - roundDeadline}ms to the cohort's`);
    }
    // Trail the slowest live peer that's at our action and still planning:
    // without this the faster peer tears off to the next handshake while the
    // slower one is still planning, and the drift one-way-ratchets back on
    // the next round. Capped at one extra ROUND_SEC so one hung peer can't
    // freeze the dimension indefinitely.
    const maxLag = Date.now() + ROUND_SEC * 2000;
    let laggingBehind = false;
    for (const p of clockPeers()) {
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
  // M6 step 1: a new planning window / deadline on the wire at once (deduped). Reveal / resolution are
  // announced by the commit / reveal envelopes themselves — no extra frame (keeps it ≈ 2 frames per action).
  if (name === 'planning') publishClock(currentStateSnapshot(true));
  if (name === 'planning' && AI_ROLE && llmRouter?.available() && !IS_HUMAN) llmKick();
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
    && wireHeard.has(p.peer_id)   // a Gun-only member can't send us a commit / reveal: never waited on
    && Number.isInteger(p.tile_q) && Number.isInteger(p.tile_r)
    && hexDistance(me, p) <= STRONG_RADIUS
  ).map(p => p.peer_id);
}
let roundMembers = { action: -1, ids: [] };
// The held snapshots as of planning end (Swarm-0559): doResolution reads non-revealers from these, not from a
// peersPublic that their owners' post-resolution frames reach on some peers before they resolve and not on others.
let roundBase = { action: -1, peers: null };
function freezeRoundMembers() { roundMembers = { action: hg.action, ids: computeStrongMembers() }; roundBase = { action: hg.action, peers: new Map(peersPublic) }; return roundMembers.ids; }
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
// A member whose commit for this action we hold is alive, at our action and about to reveal — over the
// public bus (phone ↔ desktop) that reveal can land seconds after ours. Closing the action without it
// means its attack never touches us here while its own resolver applies it (rejoined hero "back to 4 HP").
function waitingOnCommitter() {
  if (Date.now() > phaseEndsAt + REVEAL_GRACE_MS) return false;
  const committed = commitsSeen.get(hg.action), seen = revealsSeen.get(hg.action) || new Set();
  return !!committed && expectedMembers('reveal').some(id => committed.has(id) && !seen.has(id));
}
// Reveals that still arrive after we closed their action — each one is an action our resolver missed.
let lateReveals = 0;
function noteLateReveal(env) {
  const k = actionKey(env.turn, env.round);
  if (k >= hg.action) return;
  lateReveals++;
  // Always the first one per action (triage needs to see a peer that is late action after action), else capped.
  const firstForAction = k !== noteLateReveal.lastAction; noteLateReveal.lastAction = k;
  if (lateReveals <= 5 || firstForAction || lateReveals % 20 === 0) console.warn(`[${PEER_LABEL}] late reveal #${lateReveals}: ${env.actor_peer_id} T${env.turn}.R${env.round + 1} arrived at action ${hg.action} (${currentPhase}) — not resolved here`);
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
  if (!IS_HUMAN) await npcPlan();

  // Decode the single queued pick. The queue can hold either a hand slot index
  // or one of the Empty-type markers. 'EMPTY' is the combined slot — rule 6
  // says Empty Move must be "declared first", which we interpret as: EM when a
  // tile target was selected before commit, else EP. Nothing picked → EP.
  const q0 = queued[0];
  let card = null;
  let code = 'EP';
  if (q0 === 'EMPTY') {
    const hasTileTarget = target && typeof target === 'object' && 'q' in target && 'r' in target;
    // ... except when a tile-taking cast (Awake, Teleport, Creation, Vision …) is queued: then the tile is the
    // cast's target and the Empty slot is the Empty Posture that emits it (2026-11-17 Awake bug: the click turned
    // the slot into an Empty Move, which emits nothing, so the cast never went out).
    const tileCast = queuedEffect !== null && hand[queuedEffect]?.kind === 'effect' && !hand[queuedEffect].is_instant && !!EFFECT_RULES[hand[queuedEffect].effect_id]?.tileTarget;
    code = hasTileTarget && !tileCast ? 'EM' : 'EP';
  } else if (q0 === 'EP') code = 'EP';
  else if (q0 === 'EM') code = 'EM';
  else if (typeof q0 === 'number' && hand[q0]?.kind === 'action') { card = hand[q0]; code = card.code; }
  // Lost actions (Lightning, Space-bending, Oblivion, Fossilization): this
  // action is sat out as a bare Empty Posture — no card, no skills, no cast.
  // A lock of a lockWhileStanding effect (Oblivion) holds only while its caster still has the permanent (Rule 24 lets me destroy it).
  entity.lockList = entity.lockList.filter(l => {
    if (!EFFECT_RULES[l.effect_id]?.lockWhileStanding || l.by === PEER_ID_STRING) return true;
    const pv = peersPublic.get(l.by);
    return !pv || String(pv.permanents_csv || '').split(',').includes(l.effect_id);
  });
  syncLost();
  // A Sleep / Confusion affliction lifts once its holder no longer has the permanent (Rule 24 lets my allies destroy it).
  entity.afflictions = entity.afflictions.filter(a => { if (typeof a.until_action === 'number' && a.until_action < hg.action) return false; const pv = peersPublic.get(a.by); return !pv || String(pv.permanents_csv || '').split(',').includes(a.effect_id); });
  // Natural Love / Awe / Fear / Anger afflictions lift when I visit my tower (my entry hex) — or with the holder's last copy (above).
  { const onTower = entity.tile.q === START_TILE.q && entity.tile.r === START_TILE.r, before = entity.afflictions.length;
    entity.afflictions = liftAtTower(entity.afflictions, onTower);
    if (entity.afflictions.length < before) console.log(`[${PEER_LABEL}] natural afflictions lifted: I visit my tower (${START_TILE.q},${START_TILE.r})`); }
  // (Manipulator 1.0 forced a random card here through an affliction; since 2026-11-14 it is a passive swap
  // judged in the resolver against the committed `manip_alt` — see class-manipulator.mjs.)
  // Delay Time (user spec 2026-10-29): each adjacent enemy holding it costs me my last action of the
  // turn — two holders leave me only the first action. Judged now, so the holder's first contact
  // still lets me finish the action I am in.
  // Natural Domination (rule_monster_natural_permanents) works the same way: each adjacent enemy holder costs one action.
  const adjacentFoeSnaps = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && p.life > 0 && sideOf(p.alliance) !== MY_SIDE
    && hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, p) <= 1);
  const natHolds = (p, eff) => String(p.permanents_csv || '').split(',').includes(eff) && (parseCopies(p.perm_copies_json)[eff] || 0) > 0;
  const natKindHeld = (p, kind) => naturalOfKind(String(p.permanents_csv || '').split(','), kind).some(e => natHolds(p, e));   // F7: by naturalKind
  // F2: every standing permanent with an adjacent_lost program (Delay Time) of each adjacent enemy holder counts.
  const standingLost = (p) => { const perms = String(p.permanents_csv || '').split(',').filter(Boolean), ev = new Set(String(p.every_csv || '').split(',').filter(Boolean));
    return holding(perms, 'adjacent_lost').reduce((s, pid) => s + standing('adjacent_lost', pid, null, { holder: p.peer_id, victim: PEER_ID_STRING, every: ev.has(pid) }), 0); };
  const delayHolders = adjacentFoeSnaps.reduce((s, p) => s + standingLost(p), 0)
    + adjacentFoeSnaps.filter(p => natKindHeld(p, 'lose_action')).length;
  const delayed = lostToHolders(delayHolders, ROUNDS_PER_TURN, hg.round);
  if (delayed) console.log(`[${PEER_LABEL}] delay time / natural domination: ${delayHolders} holder(s) adjacent — action ${hg.round + 1}/${ROUNDS_PER_TURN} is lost`);
  // Natural Petrify: an enemy holder in contact locks me for the rest of the turn (every turn it finds me in contact).
  const petrifier = adjacentFoeSnaps.filter(p => natKindHeld(p, 'stone')).map(p => p.peer_id).sort()[0];
  if (petrifier && entity.petrifiedTurn !== hg.turn) { entity.petrifiedTurn = hg.turn; console.log(`[${PEER_LABEL}] natural petrify: ${petrifier.slice(0, 14)} in contact — I am stone for the rest of turn ${hg.turn}`); }
  const petrified = entity.petrifiedTurn === hg.turn;
  if (petrified) console.log(`[${PEER_LABEL}] natural petrify: action ${hg.round + 1}/${ROUNDS_PER_TURN} is lost`);
  const skipping = entity.lostActions > 0 || delayed || petrified;
  if (skipping) queuedBonus = [];
  queuedBonus = queuedBonus.slice(0, bonusAllowance());
  const bonusIds = new Set(queuedBonus.flatMap(b => [b.actionCardId, b.extraCardId, ...b.skillCardIds, b.effectCardId]).filter(Boolean));
  if (bonusIds.size) {
    if (card && bonusIds.has(card.card_id)) { card = null; code = code === 'M' ? 'EM' : 'EP'; }
    queuedSkills = queuedSkills.filter(i => !bonusIds.has(hand[i]?.card_id));
    if (typeof queuedEffect === 'number' && bonusIds.has(hand[queuedEffect]?.card_id)) { queuedEffect = null; queuedEffect2 = null; queuedChain = []; }
  }
  if (skipping) { card = null; code = 'EP'; queued = []; queuedSkills = []; queuedExtra = null; queuedEffect = null; queuedEffect2 = null; queuedChain = []; queuedAura = false; casting = null; }
  // SKR-11 Powerful Attack (paper text, ruling 2026-11-16): after it paid off only Attack until the end of the round. Any
  // other plan is a bare Empty Posture (no card, no skill, no cast, no destroy); an Attack keeps its skills but no Battle
  // Trance second option; bonus plans must be Attacks too.
  if (entity.planOnly && entity.planOnly.turn !== hg.turn) entity.planOnly = null;
  if (entity.planOnly && !skipping) {
    const allowed = entity.planOnly.codes;
    if (!allowed.includes(code)) {
      console.log(`[${PEER_LABEL}] ${entity.planOnly.by}: only ${allowed.join('/')} this round — my ${code} is played as an Empty Posture`);
      card = null; code = 'EP'; queued = []; queuedSkills = []; queuedExtra = null; queuedEffect = null; queuedEffect2 = null; queuedChain = []; queuedAura = false; casting = null; queuedBonus = []; queuedDestroy = null;
    } else {
      queuedExtra = null; queuedSkills = queuedSkills.filter(i => !hand[i]?.is_trance);
      queuedBonus = queuedBonus.filter(b => allowed.includes(hand.find(c => c.card_id === b.actionCardId)?.code));
    }
  }
  // Dimension Out (rule_dimension_out, interrupted_by move / attack / cast): playing a move off my hex, an attack or
  // an effect cast ends the channel, like any cast (Rule 19). Postures, Blocks and Empty Postures keep it going.
  if (dimOut) {
    const moved = code === 'M' || (code === 'EM' && target && typeof target === 'object' && (target.q !== entity.tile.q || target.r !== entity.tile.r));
    const cast = typeof queuedEffect === 'number';
    const by = DIM_OUT_CFG.interrupted_by || [];
    if (code === 'A' && by.includes('attack')) dimOutCancel('I attacked');
    else if (moved && by.includes('move')) dimOutCancel('I moved');
    else if (cast && by.includes('cast')) dimOutCancel('I cast an effect');
  }
  // Possess (user spec 2026-10-29): while my permanent holds an enemy, my own hero only Empty-Moves /
  // Empty-Postures — the possessed one fights for me. (The Phylactery leg below is the exception.)
  // (user ruling 2026-10-30: the Possess permanent sits in the POSSESSED unit's holding; while it stands I
  // play that unit — my picked action card and target go to it as `proxy`, my own hero holds — and the
  // enemy's first job is to destroy it. The Phylactery trigger is my hero's own move and stays mine.)
  // (user ruling 2026-11-17, supersedes the above: the Possess permanent is MINE and the unit I play is the archive
  // creature it brought in. It dies → the permanent falls with it — the card is gone, its killer got a creature card.)
  let possessedNow = possessedUnit();
  if (entity.possessing && entity.possessMode === 'possess' && !possessedNow) {
    const v = peersPublic.get(entity.possessing.peer_id);
    const booting = !v && Date.now() - (entity.possessing.at || 0) < 30_000 && companions.some(c => c.peer_id === entity.possessing.peer_id);
    if (!booting) {
      console.log(`[${PEER_LABEL}] possess: ${entity.possessing.name || entity.possessing.peer_id.slice(0, 14)} ${v && (v.life ?? 0) <= 0 ? 'is dead' : 'is gone'} — my Possess permanent falls, I play my own hero again`);
      for (let i = entity.summons.length - 1; i >= 0; i--) if (isPossessPerm(entity.summons[i].perm)) entity.summons.splice(i, 1);   // died: no card back
      dropPermanent(possessPermOf(entity.permanents) || possessPermOf(Object.keys(EFFECT_RULES))); publishPublicState().catch(() => {});
    }
  }
  if (entity.possessing && !possessPermOf(entity.permanents)) entity.possessing = null;
  possessedNow = possessedUnit();
  let proxy = null;
  if (possessedNow && !skipping && !queuedPhylactery) {
    proxy = { for: possessedNow.peer_id, action: ['A', 'B', 'M', 'P'].includes(code) ? code : (code === 'EM' ? 'EM' : 'EP'), target };
    console.log(`[${PEER_LABEL}] possess: ${possessedNow.name} plays ${proxy.action} for me; my hero holds`);
    card = null; code = 'EP'; queued = []; queuedSkills = []; queuedExtra = null; queuedEffect = null; queuedEffect2 = null; queuedChain = []; queuedAura = false; casting = null; queuedBonus = [];
  }
  // Phylactery (2026-11-17): one click → `{auto: true}`; the resolver picks the target on every peer alike.
  const phylactery = (!skipping && possessPermOf(entity.permanents) && entity.possessMode === 'phylactery' && queuedPhylactery) ? { auto: true } : null;

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
  const ridesOn = req => skillRidesOn(optionCodes, req);   // S1 rides

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
  // Enchanter (class, once per turn — R2, 2026-10-30): a non-Posture action (A / B / M) emits once — the queued cast goes on.
  // C1 plan_emits (Enchanter) / emits site plan (Reaver A, Monk M / EM), over the class permanents I hold.
  const clHeld = (h) => Object.keys(CLASS_RULES).filter(id => (CLASS_RULES[id].hooks || []).includes(h) && entity.permanents.has(id));
  const enchanterNow = clHeld('plan_emits').some(c => classHook('plan_emits', c, CL_BASE, { held: true, archived: entity.classArchived, usedTurn: entity.classUsedTurn, turn: hg.turn, options: !!options, code, queued: typeof queuedEffect === 'number' || !!casting }));
  const emitsLong = wants('P') || wants('EP') || (!options && code === 'EP') || clHeld('emits').some(c => ['A', 'B', 'M', 'EM'].some(x => wants(x) && classHook('emits', c, CL_BASE, { code: x, site: 'plan' }))) || enchanterNow;
  const emits = (c, every) => castInstant(c, every) || emitsLong;
  if (enchanterNow) { entity.classUsedTurn = hg.turn; console.log(`[${PEER_LABEL}] enchanter: this ${code} emits an element too (once per turn)`); console.log(classEventLine(clHeld('plan_emits')[0], 'plan_emit')); }
  // Log only (user 2026-11-23: a class rule that writes no line cannot be tested): a class that makes A / B / M / EM emit
  // while a cast is going on — the holder's line + [class-event] emit. Planning is local; nothing here is hashed.
  if (!enchanterNow && (typeof queuedEffect === 'number' || !!casting) && !(wants('P') || wants('EP') || (!options && code === 'EP'))) {
    const ce = clHeld('emits').find(c => ['A', 'B', 'M', 'EM'].some(x => wants(x) && classHook('emits', c, CL_BASE, { code: x, site: 'plan' })));
    if (ce) { console.log(`[${PEER_LABEL}] class ${ce.replace(/^class_/, '')}: this ${code} emits an element (the class rule)`); console.log(classEventLine(ce, 'emit')); }
  }
  const auraEvery = !!everyWidener();
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
  if (queuedDestroy && !trance && (wants('P') || wants('EP') || optionCodes.some(x => clEmits(x)))) {   // C1 ruling 2026-11-16: Reaver A, Barbarian B, Monk M / EM
    destroy = { stat: queuedDestroy.stat, ...(queuedDestroy.building ? { building: queuedDestroy.building } : {}), ...(queuedDestroy.class ? { class: queuedDestroy.class, elem: queuedDestroy.elem || null } : {}), ...(queuedDestroy.reanimated ? { reanimated: queuedDestroy.reanimated, elem: queuedDestroy.elem || null } : {}), ...(queuedDestroy.recast ? { recast: true } : {}), ...(queuedDestroy.untap ? { untap: true } : {}) };   // C1 reanimated: ruling 2026-11-16
    if (!keepsCastOnDestroy()) {
      if (casting) console.log(`[${PEER_LABEL}] cast of ${casting.entries.map(e => e.effectId).join('→')} dropped to emit against a token`);
      plan = null; casting = null;
    }
  }
  let effectStep = 1, effectOf = 0, chainTotal = 0, chainEnd = 0, every = false, effectKept = null;
  // Empower (user spec 2026-10-29): the permanent is spent to put two elements of this cast out in one action.
  // F2: any permanent of mine with a plan_emit program (definition `standing`); the first that answers pays.
  let empowered = false;
  planEmitSpends = null;
  if (plan) for (const pid of holding(entity.permanents, 'plan_emit')) {
    const at0 = chainAt(plan.entries, chainStep);
    if (!at0) break;
    const pe = standing('plan_emit', pid, null, { holder: PEER_ID_STRING, step: at0.step, of: at0.of, every: entity.everyPerms.has(pid) });
    const extra = Math.min(pe.extra, at0.of - at0.step);
    if (extra > 0) { chainStep += extra; empowered = true; planEmitSpends = pe.spend ? pid : null; console.log(`[${PEER_LABEL}] ${pid}: ${at0.entry.effectId} emits ${extra + 1} elements this action`); break; }
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
    const ready = kind === 'tap' ? !entity.classTapped : entity.classUsedTurn !== hg.turn;
    const spend = () => { if (kind === 'tap') entity.classTapped = true; else entity.classUsedTurn = hg.turn; };
    const local = CLASS_LOCAL[cid];
    if (!ready) console.log(`[${PEER_LABEL}] class ${entity.className}: ability not ready (${kind === 'tap' ? 'tapped — emit every colour to untap' : 'already used this turn'})`);
    else if (local) { const note = local(); if (note) { spend(); console.log(`[${PEER_LABEL}] class ${entity.className}: ${note}`); } else console.log(`[${PEER_LABEL}] class ${entity.className}: nothing to do`); }
    else {
      const need = classNeeds(cid);
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
  const effectNeedsTarget = (!!effectCard && effectCard.scope === 'target') || skillHook('plan_target', null, null, { skillIds });   // S1 plan_target

  let normTarget = options
    ? (wants('A') || wants('M') ? stripTargetFor('A', target) : wants('EM') ? stripTargetFor('EM', target) : null)
    : stripTargetFor(code, target);
  // Posture / EP strip the target, but a targeted effect riding on them needs
  // the enemy the player pointed at (right-click). Only a character target
  // counts — a tile means nothing to an effect.
  if (effectNeedsTarget && !normTarget && typeof target === 'string') normTarget = target;
  // A self_or_ally / self_or_enemy effect (Potion Brew, Mutate) keeps the unit I pointed at too (user ruling
  // 2026-11-15: Potion Brew on an ally) — effects.mjs falls back to me when it is not a valid one (side, contact).
  // No autofocus for these: without a pointed unit the cast is on me.
  const effectTakesUnit = !!effectCard && (effectCard.scope === 'self_or_ally' || effectCard.scope === 'self_or_enemy');
  if (effectTakesUnit && !normTarget && typeof target === 'string' && target !== PEER_ID_STRING) normTarget = target;
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
  const balefire = oneEmissionBonus().length > 0;
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
      const bSkills = q.skillCardIds.filter(id => !used.has(id)).map(id => hand.find(c => c.card_id === id)).filter(c => c?.kind === 'skill' && !c.is_trance && !c.sk /* S4: foreign skills ride the main plan only */ && rides(c.requires)).sort((a, b) => a.skill_id.localeCompare(b.skill_id));
      for (const c of bSkills) used.add(c.card_id);
      if (bTranceCard) bSkills.unshift(bTranceCard);
      const bEff = !bTranceCard && q.effectCardId ? hand.find(c => c.card_id === q.effectCardId && c.kind === 'effect' && !c.fx) || null : null;   // E4: foreign effects ride the main plan only (bonus wire carries no ref)
      const bEmits = !bTranceCard && (bCode === 'P' || bCode === 'EP' || clEmits(bCode));   // C1 ruling 2026-11-16
      const bDestroy = q.destroy && bEmits ? { stat: q.destroy } : null;
      // A cast continues across plans: step = how many plans in a row already carried this card, +1.
      let step = 1;
      for (let j = k - 1; j >= 0 && queuedBonus[j].effectCardId === q.effectCardId; j--) step++;
      const of = bEff ? castLength(bEff, false) : 0;
      const effOK = bEff && !(bEff.is_instant ? false : !(bCode === 'P' || bCode === 'EP' || clEmits(bCode)));   // C1 ruling 2026-11-16
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
  if (bonus.length && oncePerTurnBonus().length && !balefire) { entity.hasteUsedTurn = hg.turn; console.log(`[${PEER_LABEL}] haste: bonus round spent for turn ${hg.turn}`); }
  // Manipulator (passive, user ruling 2026-11-14): near an enemy Manipulator I commit a fallback Action — one
  // random OTHER Action card of my hand (EP if none). If its ability fires on me this action, every peer
  // replaces my action by it (class-manipulator.mjs). Committed in the hash, so it is fixed before the reveal.
  let manipAlt = null;
  {
    const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
    const near = !skipping && !proxy && !phylactery && livePeers().some(p => p && p.peer_id !== PEER_ID_STRING && p.life > 0 && sideOf(p.alliance) !== MY_SIDE
      && hasHook(p.class_id, 'combat_in') && !p.class_archived && hexDistance(here, p) <= classHook('config', p.class_id, CL_BASE).publishRange);   // phase 4: any combat_in class
    if (near) {
      const alt = pickAltAction(hand, [card?.card_id, extraCard?.card_id, ...bonus.map(b => b.cardId), ...bonus.map(b => b.extraCardId)]);
      let at = null;
      if (alt.code === 'A' || alt.code === 'M') {
        at = normTarget || target || null;
        if (!at) {
          const foes = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && p.life > 0 && sideOf(p.alliance) !== MY_SIDE).sort((a, b) => hexDistance(here, a) - hexDistance(here, b) || a.peer_id.localeCompare(b.peer_id));
          at = foes[0]?.peer_id || null;
        }
      } else if (alt.code === 'EM') at = stripTargetFor('EM', target);
      manipAlt = { code: alt.code, cardId: alt.card_id, target: at };
    }
  }
  // NPC builders (AI skirmish 2026-11-22): a Barricade intent rides on a plain Posture / Empty Posture (no cast,
  // no trance, not a lost action) — committed in the hash like the rest of the plan.
  const build = AI_ROLE === 'builder' && queuedBuild && !skipping && !proxy && !phylactery && !effectCard && !trance && (code === 'P' || code === 'EP')
    ? { q: Number.isInteger(queuedBuild.q) ? queuedBuild.q : null, r: Number.isInteger(queuedBuild.r) ? queuedBuild.r : null } : null;
  if (queuedBuild && !build) console.log(`[${PEER_LABEL}] npc builder: no Barricade this action — ${skipping ? 'a lost action' : proxy ? 'a proxy action' : phylactery ? 'phylactery' : effectCard ? `casting ${effectCard.effect_id}` : trance ? 'Battle Trance' : `played ${code}, not a Posture`}`);
  queuedBuild = null;
  const revealCode = trance ? 'BT' : code;
  myLastSalt = randomBytes(12).toString('hex');
  const effectTag = effectCard ? `${effectCard.effect_id}${every ? '∀' : ''}:${effectCard.element_cost.join('+')}:${effectStep}/${effectOf}:${(effectKept || []).map(v => v ?? '-').join(',')}` : '';
  const bonusTag = bonus.map(b => `${b.action}${b.trance ? `[${b.trance.join('+')}]` : ''}:${targetTag(b.target)}:${b.skillIds.join(',')}:${b.effect ? `${b.effect.effect_id}${b.effect.step}/${b.effect.of}` : ''}:${b.destroy ? b.destroy.stat : ''}`).join('|');
  const commitHash = sha256Hex(`${revealCode}::${targetTag(normTarget)}::${skillIds.join(',')}::${trance ? options.join('+') : ''}::${effectTag}::${destroy ? destroy.stat : ''}::${bonusTag}${manipAlt ? `::manip:${manipAlt.code}:${targetTag(manipAlt.target)}` : ''}${build ? `::build:${build.q},${build.r}` : ''}::${myLastSalt}`);
  myLastReveal = {
    code: revealCode, trance: options, target: normTarget, salt: myLastSalt, cardId: card ? card.card_id : null,
    optionCardIds: [card ? card.card_id : null, extraCard ? extraCard.card_id : null],
    skillIds, skillNames: mySkills.map(c => c.name), skillCardIds: mySkills.map(c => c.card_id),
    skillRefs: mySkills.filter(c => c.sk).map(c => c.sk),   // S4: refs of my foreign (player-branch) skill cards; [] with built-ins only
    clRef: clPeer.myRef(),   // CH: the ref of my foreign (player-branch) class; null with a built-in class
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
    effectPermanent: !!effectCard?.is_permanent || (every && !!EFFECT_RULES[effectCard?.effect_id]?.everyPermanent),
    effectDamage: !!effectCard?.is_damage,
    effectPointBuy: !!effectCard?.is_point_buy,
    effectScope: effectCard?.scope || null,
    effectInstant: effectCard ? castInstant(effectCard, every) : false,
    effectSummon: effectCard?.summon || null,
    effectFx: effectCard?.fx || null,   // E4: ref of a foreign (player-branch) effect card; null for every built-in
    effectAttach: attachCard ? { effect_id: attachCard.effect_id, name: attachCard.name, elements: [...attachCard.element_cost], card_id: attachCard.card_id } : null,
    effectLink, empowered,
    effectPossess: isPossessPerm(effectCard?.effect_id) ? possessPayload() : null,   // Possess 2026-11-17: the archive creature it plays
    effectElem: effectCard && (EFFECT_RULES[effectCard.effect_id]?.altTileToken || TILE_TOKEN_CHOICE[effectCard.effect_id]) ? (queuedElem || null) : null,
    effectStep, effectOf,
    skipping, destroy, phylactery, proxy, classAbility, manipAlt,
    build, say: takeSay(),   // AI skirmish: Barricade intent; the unit's line (shown with the reveal, never the commit)
    bonus,
  };
  await emitEnvelope({
    type: 'evt_action_commit',
    payload: { commitment: commitHash, empty_move_announced: code === 'EM', ...(myLastReveal.effectFx ? { fx_ref: myLastReveal.effectFx } : {}), ...(myLastReveal.skillRefs?.length ? { sk_ref: myLastReveal.skillRefs } : {}), ...(myLastReveal.clRef ? { cl_ref: myLastReveal.clRef } : {}) },   // S4 sk_ref; CH cl_ref
  });
  if (DISCOVERY_URL) await postJson(`${DISCOVERY_URL}/commit`, { dimension_id: DIM_ID, peer_id: PEER_ID_STRING, turn: hg.action, commitment: commitHash });
}

async function doReveal() {
  if (!myLastReveal) return;
  const targetObj = wrapTarget(myLastReveal.target);
  // E4: foreign effects committed this action that I cannot run (not fetched / refused) — every peer then
  // postpones those casts (effects-handshake.mjs gateReveals). Empty, and absent from the wire, in built-in play.
  const fxMissing = fxPeer.active ? await fxPeer.missingForReveal(hg.tape, hg.turn, hg.round) : [];
  if (!myLastReveal) return;
  myLastReveal.fxMissing = fxMissing;
  // S4: foreign skills committed this action that I cannot run — every peer strips them (skills-handshake.mjs gateSkills).
  const skMissing = skPeer.active ? await skPeer.missingForReveal(hg.tape, hg.turn, hg.round) : [];
  if (!myLastReveal) return;
  myLastReveal.skMissing = skMissing;
  // CH: foreign classes in play (commits' cl_ref + the snapshot refs of the units I see) that I cannot run — every
  // peer resolves them dormant (classes-handshake.mjs gateClasses).
  const clMissing = clPeer.active ? await clPeer.missingForReveal(hg.tape, hg.turn, hg.round, [...peersPublic.values()].filter(p => p?.cl_ref_json && p.peer_id !== PEER_ID_STRING).map(p => ({ id: p.peer_id, ref: p.cl_ref_json }))) : [];
  if (!myLastReveal) return;
  myLastReveal.clMissing = clMissing;
  await emitEnvelope({
    type: 'evt_action_reveal',
    payload: {
      ...(fxMissing.length ? { fx_missing: fxMissing } : {}),
      ...(skMissing.length ? { sk_missing: skMissing } : {}), ...(myLastReveal.skillRefs?.length ? { sk_ref: myLastReveal.skillRefs } : {}),   // S4: a foreign skill resolves from sk_ref only
      ...(clMissing.length ? { cl_missing: clMissing } : {}), ...(myLastReveal.clRef ? { cl_ref: myLastReveal.clRef } : {}),   // CH: a revealer's foreign class resolves from cl_ref
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
        attach: myLastReveal.effectAttach || null, card_id: myLastReveal.effectCardId || null, link: myLastReveal.effectLink || null, elem: myLastReveal.effectElem || null, ...(myLastReveal.effectPossess ? { possess: myLastReveal.effectPossess } : {}),
        ...(myLastReveal.effectFx ? { ref: myLastReveal.effectFx } : {}),   // E4: a foreign effect resolves from this ref only
      }] : [],
      skills: myLastReveal.skillIds, skill_names: myLastReveal.skillNames, class_ability_tapped: false,
      destroy: myLastReveal.destroy || null,
      phylactery: myLastReveal.phylactery || null,
      proxy: myLastReveal.proxy ? { for: myLastReveal.proxy.for, action: myLastReveal.proxy.action, target: wrapTarget(myLastReveal.proxy.target) } : null,
      class_ability: myLastReveal.classAbility ? { id: myLastReveal.classAbility.id, target: wrapTarget(myLastReveal.classAbility.target), attach: myLastReveal.classAbility.attach || null, stat: myLastReveal.classAbility.stat || null } : null,
      bonus: bonusWire(myLastReveal.bonus),
      manip_alt: myLastReveal.manipAlt ? { code: myLastReveal.manipAlt.code, target: wrapTarget(myLastReveal.manipAlt.target) } : null,
      target: targetObj,
      combo_step: null,
      salt: myLastReveal.salt,
      ...(myLastReveal.build ? { build: myLastReveal.build } : {}),
      ...(myLastReveal.say ? { say: myLastReveal.say } : {}),   // AI skirmish: UI speech balloon (llm-brain.mjs cleanSay on every side)
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
  // Only peers heard on a wire transport (wireHeard): a member known solely through a side channel
  // (Gun) is not in every resolver's view, so it must not block moves, be targeted or count anywhere
  // (GunLive85 T8.R3). The reveal loop below re-adds any revealer from its envelope's own snapshot.
  // Non-revealers (a corpse, an abstaining joiner): the planning-end copy, and never a statement that already
  // shows this action's resolution (merge-order.mjs resolverBase — Swarm-0559 T4.R1, a dead ally's shield token).
  const view = resolverPeers(resolverBase(roundBase.action === hg.action ? roundBase.peers : peersPublic, snapPrior, hg.action), PEER_ID_STRING, wireHeard);
  const revealsThisTurn = [];
  for (const env of hg.tape) {
    if (env.type !== 'evt_action_reveal' || env.turn !== hg.turn || env.round !== hg.round) continue;
    if (revealsThisTurn.some(r => r.actor === env.actor_peer_id)) continue;
    const effArr = Array.isArray(env.payload.effects) ? env.payload.effects : [];
    const eff0 = effArr[0] || null;
    noteRecentAct(env.actor_peer_id, env.payload.action);
    revealsThisTurn.push({ actor: env.actor_peer_id, action: env.payload.action, target: env.payload.target || null, skills: Array.isArray(env.payload.skills) ? env.payload.skills : [], trance: Array.isArray(env.payload.trance) && env.payload.trance.length === 2 ? [...env.payload.trance] : null, effect: eff0, salt: env.payload.salt || '', destroy: env.payload.destroy || null, phylactery: env.payload.phylactery || null, proxy: env.payload.proxy || null, classAbility: env.payload.class_ability || null, bonus: env.payload.bonus || null, manipAlt: env.payload.manip_alt || null, build: env.payload.build || null });
    const s = env.state;
    if (s && s.peer_id === env.actor_peer_id && Number.isInteger(s.tile_q) && Number.isInteger(s.tile_r)) {
      view.set(env.actor_peer_id, { ...(view.get(env.actor_peer_id) || {}), ...s });
    }
  }
  // Our own entity is authoritative for ourselves.
  view.set(PEER_ID_STRING, { ...(view.get(PEER_ID_STRING) || {}), ...currentStateSnapshot() });
  // Released companions (Swarm-1536 T16.R2 Possess; 2026-11-18 every companion: Summoning, Golems, phantom …): a
  // unit marked companion_of X that X (in the view) no longer lists in summoned_csv is gone — judged from X's state,
  // not from whether the companion's own life-0 snapshot reached me (possess.mjs releasedCompanions). Bound: untouched.
  for (const id of releasedCompanions(view, PEER_ID_STRING)) {
    const rc = view.get(id);
    if (!releasedLogged.has(id)) { releasedLogged.add(id); console.log(`[${PEER_LABEL}] released companion ${id} of ${rc?.companion_of || rc?.possessed_by} leaves my view at T${hg.turn}.R${hg.round + 1} (its own last snapshot: life ${rc?.life} at (${rc?.tile_q},${rc?.tile_r})${(rc?.life ?? 0) > 0 ? ' — stale, its life-0 word never reached me' : ''})`); }
    view.delete(id);
    for (let i = revealsThisTurn.length - 1; i >= 0; i--) if (revealsThisTurn[i].actor === id) revealsThisTurn.splice(i, 1);
  }
  // Released BOUND creatures (2026-11-19; ∀ Summoning bind, Resurrect / Necromancer revive): judged here, on the frozen
  // view, at the same action on every peer (bound-release.mjs) — the creature's bound_* marker vs its owner's snapshot.
  // From this action on a released revive creature is dead (life 0: its reveal drops out below), a released bind
  // creature fights for its own alliance. The creature itself applies the same record to its entity (applyBoundRelease).
  for (const rel of boundReleases(view)) {
    const key = `${rel.id}@${rel.perm}@${rel.at}`;
    if (!releasedLogged.has(key)) { releasedLogged.add(key); console.log(`[${PEER_LABEL}] bound release: ${rel.id} (${rel.mode}) at T${hg.turn}.R${hg.round + 1} — ${rel.why} (owner ${rel.owner}, ${rel.perm}, bound at action ${rel.at})`); }
    if (rel.id === PEER_ID_STRING) { applyBoundRelease(rel); view.set(rel.id, { ...releasedBoundView(view.get(rel.id), rel), ...currentStateSnapshot() }); }
    else view.set(rel.id, releasedBoundView(view.get(rel.id), rel));
  }
  // Buildings created during play (Animator / Priest, 2026-11-14): every peer folds the same view's world edits
  // into the features.js overlay before it resolves — featureAt / buildingBonusAt then see them everywhere.
  syncPlacedBuildings(view);
  // Include our own reveal in case we didn't receive it from pubsub self-echo.
  if (myLastReveal && !revealsThisTurn.find(r => r.actor === PEER_ID_STRING)) {
    revealsThisTurn.push({ actor: PEER_ID_STRING, action: myLastReveal.code, target: wrapTarget(myLastReveal.target), skills: myLastReveal.skillIds || [], trance: myLastReveal.trance ? [...myLastReveal.trance] : null, salt: myLastReveal.salt, destroy: myLastReveal.destroy || null, phylactery: myLastReveal.phylactery || null, proxy: myLastReveal.proxy ? { for: myLastReveal.proxy.for, action: myLastReveal.proxy.action, target: wrapTarget(myLastReveal.proxy.target) } : null, classAbility: myLastReveal.classAbility ? { id: myLastReveal.classAbility.id, target: wrapTarget(myLastReveal.classAbility.target), attach: myLastReveal.classAbility.attach || null, stat: myLastReveal.classAbility.stat || null } : null, bonus: bonusWire(myLastReveal.bonus), manipAlt: myLastReveal.manipAlt ? { code: myLastReveal.manipAlt.code, target: wrapTarget(myLastReveal.manipAlt.target) } : null, build: myLastReveal.build || null, effect: myLastReveal.effectId ? {
      effect_id: myLastReveal.effectId, name: myLastReveal.effectName, elements: myLastReveal.effectElements || [], types: myLastReveal.effectTypes || [],
      is_permanent: myLastReveal.effectPermanent, is_damage: myLastReveal.effectDamage, is_point_buy: myLastReveal.effectPointBuy, scope: myLastReveal.effectScope,
      is_instant: myLastReveal.effectInstant, every: myLastReveal.effectEvery, aura: myLastReveal.effectAura, step: myLastReveal.effectStep, of: myLastReveal.effectOf, kept: myLastReveal.effectKept, summon: myLastReveal.effectSummon || null,
      attach: myLastReveal.effectAttach || null, card_id: myLastReveal.effectCardId || null, link: myLastReveal.effectLink || null, elem: myLastReveal.effectElem || null, ...(myLastReveal.effectPossess ? { possess: myLastReveal.effectPossess } : {}),
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
  // E4 foreign effects (effects-handshake.mjs, HANDSHAKE.md): a reveal ref whose sha any revealer listed in
  // fx_missing is POSTPONED on every peer (its effect leaves the resolver input; my own re-emits next action);
  // a held one gets effect.fx = {key} (castOf → effects.mjs runs the pinned def); one I still lack after a short
  // wait is dropped and I publish no state hash for this action. Skipped entirely while no foreign ref exists.
  const fxRes = fxPeer.active ? await fxPeer.prepareResolution(revealsThisTurn, hg.tape, { turn: hg.turn, round: hg.round, self: PEER_ID_STRING, myReveal: myLastReveal }) : null;
  if (fxRes?.mine && myLastReveal) { myLastReveal.castStatus = fxRes.giveUp ? 'fizzled' : 'retry'; if (fxRes.giveUp) myLastReveal.effectStep = myLastReveal.effectOf; }   // give up = the cast ends, card spent
  // S4 foreign skills (skills-handshake.mjs, skills-data/HANDSHAKE.md): a foreign skill whose sha any revealer listed in
  // sk_missing is STRIPPED from its reveal on every peer (the action resolves bare; my card returns to my hand); a held
  // one rides; one I still lack after a short wait is stripped and I publish no state hash. Skipped while nothing foreign.
  const skRes = skPeer.needsGate(revealsThisTurn, hg.tape, { turn: hg.turn, round: hg.round, myReveal: myLastReveal }) ? await skPeer.prepareResolution(revealsThisTurn, hg.tape, { turn: hg.turn, round: hg.round, self: PEER_ID_STRING, myReveal: myLastReveal }) : null;
  if (myLastReveal) myLastReveal.skStripped = skRes?.mine || [];
  // CH foreign classes (classes-handshake.mjs): a foreign class whose sha any revealer listed in cl_missing is DORMANT
  // on every peer for this resolution (suspended around simulate below); one in play that I still lack after a short
  // wait is resolved dormant here and I publish no state hash. Skipped while no unit holds a foreign class.
  const clUnits = [...view.keys()].map(id => ({ id, class_id: id === PEER_ID_STRING ? (entity.classId || null) : (view.get(id)?.class_id || null), ref: id === PEER_ID_STRING ? clPeer.myRef() : (view.get(id)?.cl_ref_json || null) }));
  const clRes = clPeer.needsGate(clUnits, hg.tape, { turn: hg.turn, round: hg.round, myReveal: myLastReveal }) ? await clPeer.prepareResolution(revealsThisTurn, hg.tape, { turn: hg.turn, round: hg.round, self: PEER_ID_STRING, myReveal: myLastReveal, units: clUnits }) : null;
  // Phase 6 (user ruling 3): built-ins by reference with a hard version gate — a unit whose built-in class pin
  // (snapshot cl_key) differs from my bundled one, or is absent, makes me withhold this action's state hash.
  const clVer = clPeer.gateBuiltins(clUnits.map(u => ({ ...u, cl_key: u.id === PEER_ID_STRING ? clPeer.builtinKey(entity.classId) : (view.get(u.id)?.cl_key || null) })), { turn: hg.turn, round: hg.round });
  // Effect isolation F9: built-in effects by reference, the same hard gate — a unit whose bundled effect set pin
  // (snapshot fx_set) differs from mine, or is absent from a full snapshot, makes me withhold this action's state hash;
  // a peer I only know from its Gun slim record (no permanents_csv) is skipped until its full snapshot arrives.
  const fxVer = fxPeer.gateBuiltins([...view.keys()].filter(id => id !== PEER_ID_STRING).map(id => ({ id, fx_set: view.get(id)?.fx_set || null, full: view.get(id)?.permanents_csv !== undefined })), { turn: hg.turn, round: hg.round });
  const skVer = skPeer.gateBuiltins([...view.keys()].filter(id => id !== PEER_ID_STRING).map(id => ({ id, sk_set: view.get(id)?.sk_set || null, full: view.get(id)?.permanents_csv !== undefined })), { turn: hg.turn, round: hg.round });
  // A building's skill rides free on the action of whoever stands there (user ruling 2026-11-12); the
  // skill pass below only uses it when the action fits (ridesFor), like a card from the hand.
  for (const r of revealsThisTurn) {
    const v = view.get(r.actor);
    const pw = v ? buildingPowerAt(v.tile_q, v.tile_r) : null;
    if (pw?.kind === 'skill' && !(r.skills || []).includes(pw.skill)) { r.skills = [...(r.skills || []), pw.skill]; r.buildingSkill = pw.skill; }
  }

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
  // Invisibility outside simulate (combo victim pick): the same test as simulate's invisibleNow, on the reveals as played.
  const invisibleAtReveal = (id) => {
    const perms = new Set(id === PEER_ID_STRING ? [...entity.permanents] : String(view.get(id)?.permanents_csv || '').split(','));
    const pid = hidingPerm(perms);
    if (!pid) return false;
    const every = id === PEER_ID_STRING ? entity.everyPerms.has(pid) : String(view.get(id)?.every_csv || '').split(',').includes(pid);
    return !hideBreaks(pid, id, [pristineReveals.find(o => o.actor === id)], false, every, invisCodesOf(perms));
  };
  const natFx = [];   // effect-results toasts (2026-11-18): natural Mists / Anger / Love / Awe / Fear acting this action (non-quiet runs only; UI only)
  const simulate = (reveals, quiet, opts = {}) => {
  const bonusRound = !!opts.bonus;   // bonus rounds: everyone else is idle — only the action's base damage lands
  const revealsThisTurn = reveals;
  const log = quiet ? () => {} : (...a) => console.log(...a);
  // Skills (Rule 17 instants, Rule 8 "prohibitions apply as a replacement").
  // `effAction` is what each actor effectively does after every skill in play
  // has had its say; everything below resolves against it, never `r.action`.
  // Read live off the reveal (not a frozen copy): the Counter Spell pre-pass
  // strips skills from a reveal and everything after must see them gone.
  const byActorPre = new Map(revealsThisTurn.map(r => [r.actor, r]));   // S1: skills.mjs reads r.skills live through it
  const permsOfRaw = (id) => id === PEER_ID_STRING
    ? [...entity.permanents]
    : String(view.get(id)?.permanents_csv || '').split(',').filter(Boolean);
  // A lock (Lightning, Oblivion, …) only stops you acting: permanents and tokens
  // stay attached and working until destroyed (user ruling).
  const permsOf = (id) => permsOfRaw(id);
  const hasPerm = (id, skill) => permsOf(id).includes(skill);
  // Class state as the snapshot tells it (mine from the entity): id, colours down, archived, tapped, progress.
  const classStateOf = (id) => {
    if (id === PEER_ID_STRING) return { class_id: entity.classId || null, down: [...(entity.classDown || [])], archived: !!entity.classArchived, tapped: !!entity.classTapped, progress: entity.classProgress || null, usedTurn: entity.classUsedTurn ?? -1 };
    const v = view.get(id) || {};
    return { class_id: v.class_id || permsOfRaw(id).find(p => p.startsWith('class_')) || null, down: String(v.class_down_csv || '').split(',').filter(Boolean), archived: !!v.class_archived, tapped: !!v.class_tapped, progress: parseJson(v.class_progress_json, null), usedTurn: typeof v.class_used_turn === 'number' ? v.class_used_turn : -1 };
  };
  // A class ability may be used when the class stands on the board and (tap) is not tapped / (once per action) not yet used this action.
  const classReady = (id, classId) => classHook('ready', classId, CL_BASE, { cs: classStateOf(id), held: hasPerm(id, classId), turn: hg.turn });   // C1 ready
  const distBetween = (a, b) => {
    const pa = view.get(a), pb = view.get(b);
    return pa && pb ? hexDistance({ tile_q: pa.tile_q, tile_r: pa.tile_r }, { tile_q: pb.tile_q, tile_r: pb.tile_r }) : Infinity;
  };
  // Possess (user ruling 2026-10-30): the possessed unit keeps its alliance but fights on its possessor's
  // side — and is driven by them — while the Possess permanent stands in ITS holding and the possessor lives.
  const possessorOf = (id) => {
    const v = view.get(id);
    const by = v?.possessed_by || null;
    // 2026-11-17: the Possess permanent stands in the POSSESSOR's holding (possess_mode 'possess') and the unit is
    // its companion (owner_peer_id); the 2026-10-30 form (permanent in the unit's own holding) is still read.
    const held = permsOfRaw(id).some(isPossessPerm) || (v?.owner_peer_id === by && permsOfRaw(by).some(isPossessPerm) && view.get(by)?.possess_mode === 'possess');
    return by && by !== id && held && (view.get(by)?.life ?? 0) > 0 ? by : null;
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
    if (r.actor === PEER_ID_STRING || px.for === PEER_ID_STRING) log(`[${PEER_LABEL}] possess: ${r.actor} drives ${px.for} → ${act}`);
  }
  // Invisibility (user ruling 2026-11-14): judged on the reveals as played (before skills / stances
  // rewrite r.action), so every peer agrees. A unit whose reveal breaks it (Attack / Block / a cast) is
  // already seen this action; ∀ (every_csv) keeps it hidden until it deals damage.
  // F3: the hiding permanent (flag `hides`) and its `breaks` program; ∀ is judged after the run (dealt damage), not here.
  const hidingOf = (id) => hidingPerm(permsOfRaw(id));
  const invisBreakers = new Set(revealsThisTurn.filter(r => { const pid = hidingOf(r.actor); return !!pid && hideBreaks(pid, r.actor, [r], false, false, invisCodesOf(permsOfRaw(r.actor))); }).map(r => r.actor));
  const invisEvery = (id) => { const pid = hidingOf(id); return !!pid && (id === PEER_ID_STRING ? entity.everyPerms.has(pid) : String(view.get(id)?.every_csv || '').split(',').includes(pid)); };
  const invisibleNow = (id) => !!hidingOf(id) && (invisEvery(id) || !invisBreakers.has(id));
  // `viewer` cannot see `id`: an enemy that is invisible now, unless the viewer is invisible too (paper text).
  const hiddenFrom = (viewer, id) => viewer !== id && invisibleNow(id) && enemyOf(viewer, id) && !invisibleNow(viewer);
  for (const id of [...invisBreakers].sort()) if (hidingOf(id) && !invisEvery(id)) log(`[${PEER_LABEL}] invisibility: ${id.slice(0, 8)} shows itself (Attack / Block / cast) — its permanent falls`);
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
  const noMove = new Set();   // S1: Overrun (skills.mjs negate_kind) and Confusion
  const noEmit = new Set(), swaps = [];   // SKR-01 (skill rulings 2026-11-16): Disruption voids an emission, Overrun swaps hexes (skills.mjs negate_kind)
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
  const worldEditsNow = worldLens(view).edits;
  const tileTokensAt = (q, r) => [...allTileTokens.filter(t => t.q === q && t.r === r), ...worldTokensAt(q, r)];
  const elemPenOf = (id, el) => parseJson(view.get(id)?.elem_pen_json, []).filter(t => t.elem === el).reduce((a, t) => a + t.amount, 0);
  // Counter effects (Shield, Disable, The Void, zones) apply within the very
  // resolution they are cast in, and then last until the turn ends.
  const csvSet = (x) => new Set(String(x || '').split(',').filter(Boolean));
  const roundShield = new Map();      // id → Set(elem) cast this action
  const roundDisabled = new Map();    // id → Set(elem) cast this action
  const roundGlobalDisabled = new Set(); // ∀ Disable cast this action: nobody emits these
  // Spirit Link: the linked ally's CURRENT base stat rides on mine while I hold the permanent.
  const linkedStat = (id, sk) => parseJson(view.get(id)?.links_json, []).filter(l => l.stat === sk && permsOf(id).some(isLinkPerm)).reduce((a, l) => a + statRaw(view.get(l.from), sk), 0);
  // Fortress stat buy (user ruling 2026-11-14): the unit's running bank. (Its break bonus is a stat token in
  // stat_tokens_json; a legacy fortress_bonus_json from an older peer is ignored.)
  const fortressBankIn = (id) => { try { const o = JSON.parse(view.get(id)?.fortress_bank_json || 'null'); return o && typeof o === 'object' ? o : null; } catch { return null; } };
  const statOf = (id, sk) => {
    const v = view.get(id);
    if (!v) return 0;
    let s = statRaw(v, sk) + linkedStat(id, sk);
    // Awake ∀ (2026-11-18): the stat the permanent lends while it stands.
    // (awake_lend_json is null unless the permanent stands — dropPermanent clears it.)
    if (v.awake_lend_json && v.awake_lend_json !== 'null') { try { s += Number(JSON.parse(v.awake_lend_json)?.stats?.[sk]) || 0; } catch {} }
    for (const t of statTokensOf(id)) if (t.stat === sk) s += t.value;
    for (const t of tileTokensAt(v.tile_q, v.tile_r)) if (t.kind === 'bonus' && ELEM_TO_STAT[t.elem] === sk) s += t.value;
    // A building / landmark under the unit (user ruling 2026-11-12): its stat bonus while it stands there.
    if (Number.isInteger(v.tile_q)) s += buildingBonusAt(MAP_SEED, v.tile_q, v.tile_r)?.bonus?.stat?.[sk] || 0;
    return Math.max(0, s);
  };
  // Earth obstacles (Creation): every peer's `obstacles_json`; impassable for the creator's enemies.
  const allObstacles = [...view.values()].flatMap(v => parseJson(v?.obstacles_json, []).map(o => ({ ...o, owner: v.peer_id }))).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const obstacleAt = (q, r) => allObstacles.find(o => o.q === q && o.r === r) || null;
  // A wall raised by a building (`wall: true`) stops everyone, its raiser included.
  const obstacleBlocks = (who, q, r) => { const o = obstacleAt(q, r); return !!o && (o.wall || (o.owner !== who && enemyOf(o.owner, who))); };
  // Labyrinth walls (features.js#labyrinthWallAt) are static scenery owned by
  // nobody — impassable to everyone, deterministic from (MAP_SEED, q, r).
  // A fortress building stands in the way the same until someone breaks it (world edit `bld:q,r` gone).
  const labyrinthBlocks = (q, r) => isLabyrinthWallAt(MAP_SEED, q, r) || !!fortressAt(MAP_SEED, q, r, worldEditsNow);
  const casterStat = (id, el) => Math.max(0, statOf(id, ELEM_TO_STAT[el]) - (counterPen.get(id)?.[el] || 0) - elemPenOf(id, el));
  const castComplete = (o) => !!o.effect && Array.isArray(o.effect.elements) && o.effect.elements.length > 0 && (o.effect.is_instant || (o.effect.step ?? 1) >= (o.effect.of ?? 1));
  const castsDamage = (o) => castComplete(o) && !!EFFECT_RULES[o.effect.effect_id]?.damage;
  // Aura ∀ widens a cast to everyone within 10 hexes — only while the caster really holds a doubled Aura.
  const auraEveryOf = (id) => { const ev = csvSet(view.get(id)?.every_csv); return permsOf(id).some(p => EFFECT_RULES[p]?.everyWidens && ev.has(p)); };   // F2: everyWidens
  const castBoost = new Map();          // Elementalist: extra die riding on the actor's cast this action (set in the class pre-pass)
  const castOf = (o) => ({ actor: o.actor, effect_id: o.effect.effect_id, elements: o.effect.elements, salt: o.salt || '', target: o.target, is_instant: !!o.effect.is_instant, every: !!o.effect.every, aura: !!o.effect.aura && auraEveryOf(o.actor), step: o.effect.step ?? 1, of: o.effect.of ?? 1, kept: Array.isArray(o.effect.kept) ? o.effect.kept : null, summon: o.effect.summon || null, attach: o.effect.attach || null, card_id: o.effect.card_id || null, link: o.effect.link || null, elem: o.effect.elem || null, ...(o.effect.possess ? { possess: o.effect.possess } : {}), boost: castBoost.get(o.actor) || 0, ...(o.effect.fx ? { fx: o.effect.fx } : {}), ...awakeOf(o) });
  // Awake (user request 2026-11-17): what moves where — game/awake.mjs judges it from this view on every peer (the
  // clicked tile, me, my allies in contact, the buildings within 2 of me, the enemies I see) → cast.awake, which
  // effects.mjs turns into a move (unit) or a building relocation. Memo per simulate() run (same view throughout).
  const awakeMemo = new Map();
  function awakeOf(o) {
    if (!isAwakePerm(o.effect?.effect_id)) return {};
    const v = view.get(o.actor);
    if (!v || !Number.isInteger(v.tile_q)) return {};
    const picked = o.target?.kind === 'tile' && Number.isInteger(o.target.ref?.q) && Number.isInteger(o.target.ref?.r) ? o.target.ref : null;
    const key = `${o.actor}|${picked ? `${picked.q},${picked.r}` : '-'}`;
    if (!awakeMemo.has(key)) {
      const me = { id: o.actor, q: v.tile_q, r: v.tile_r };
      const units = [...view.keys()].sort().filter(id => lifeOf(id) > 0 && Number.isInteger(view.get(id)?.tile_q) && (id === o.actor || !hiddenFrom(o.actor, id)))
        .map(id => { const u = view.get(id); return { id, q: u.tile_q, r: u.tile_r, life: lifeOf(id), lifeMax: Number(u.life_max) || 0, side: id === o.actor ? 'me' : enemyOf(o.actor, id) ? 'enemy' : 'ally' }; });
      const standing = (q, r) => { const f = buildingFeatureAt(MAP_SEED, q, r); return isBuildingFeature(f) && !fortressAt(MAP_SEED, q, r); };
      const buildings = discAround(me, AWAKE_CONFIG.buildingNear).filter(h => standing(h.q, h.r)).map(h => ({ q: h.q, r: h.r, label: buildingFeatureAt(MAP_SEED, h.q, h.r)?.label || 'Building' }));
      const clear = (q, r) => effCtx.isFree(q, r) && hexWalkableAt(MAP_SEED, q, r) && !labyrinthBlocks(q, r) && !allTraps.some(t => t.q === q && t.r === r) && !tileTokensAt(q, r).some(t => t.kind === 'bonus');
      // Wall tokens (user ruling 2026-11-18): obstacles (Creation, a building's wall arc — moved by their owner) and
      // labyrinth walls (moved as world edits) within 2 of me.
      const walls = [
        ...allObstacles.filter(ob => hexDist(me, ob) <= AWAKE_CONFIG.wallNear).map(ob => ({ q: ob.q, r: ob.r, owner: ob.owner, id: ob.id, label: ob.wall ? 'wall' : 'obstacle' })),
        ...discAround(me, AWAKE_CONFIG.wallNear).filter(h => isLabyrinthWallAt(MAP_SEED, h.q, h.r) && !obstacleAt(h.q, h.r)).map(h => ({ q: h.q, r: h.r, lab: true, label: 'Impassable Wall' })),
      ];
      awakeMemo.set(key, awakePlan({ me, units, buildings, walls, picked, unitFree: clear, siteFree: (q, r) => clear(q, r) && !buildingFeatureAt(MAP_SEED, q, r), hasBuilding: standing }));
    }
    if (!quiet) awakeLast.set(o.actor, awakeMemo.get(key));   // what this caster's Awake did (∀ lend, applied by the caster)
    return { awake: awakeMemo.get(key) };
  }
  const buysPerEmission = (o) => EFFECT_RULES[o.effect?.effect_id]?.damage === 'pointbuy' || !!EFFECT_RULES[o.effect?.effect_id]?.statBuy;
  const effCtx = {
    me: PEER_ID_STRING,
    elemStat: (el) => ELEM_TO_STAT[el],
    statFor: (id, el) => casterStat(id, el),
    baseStat: (id, sk) => statOf(id, sk),
    lifeOf, enemyOf,
    dist: distBetween,
    tileOf: (id) => { const v = view.get(id); return v && Number.isInteger(v.tile_q) ? { q: v.tile_q, r: v.tile_r } : null; },
    isFree: (q, r) => dimMap.has(q, r) && !obstacleAt(q, r) && !isLabyrinthWallAt(MAP_SEED, q, r) && ![...view.values()].some(v => v && v.life > 0 && v.tile_q === q && v.tile_r === r),
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
    invisible: (id) => invisibleNow(id),
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

  // Skill bookkeeping (user ruling 2026-11-12): what each instant actually did. A skill that served its
  // purpose is discarded; a negated action's card — and the instants riding on it, which never execute —
  // goes back to its owner's hand; a countered instant is discarded. Read by the card disposition below.
  const skillFx = [];
  const fromBuilding = (by, skill) => byActorPre.get(by)?.buildingSkill === skill;
  // S1: the skill rules live in skills.mjs; this is everything they may read / write this action (HOOKS.md).
  const skCtx = {
    self: PEER_ID_STRING, label: PEER_LABEL, log, reveals: revealsThisTurn, byActorPre,
    effAction, tranceOpts, noMove, counterPen, skillFx, codeIs, replace, noEmit, swaps,   // SKR-02
    enemyOf, hiddenFrom, dist: distBetween, lifeOf,
    view: (id) => view.get(id), viewValues: () => view.values(),
    elemStat: (el) => ELEM_TO_STAT[el], hasPerm, permPower: (id) => permPowerOf(id),
    castsDamage, effectDmgNoShield, skillData: (id) => data.skills[id]?.data, edgeDmg: (a, d) => edgeDmg(a, d),
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
  skillHook('counter_pre', null, skCtx);   // S1 counter_pre
  // Pass 1 — prohibitions on a whole action (they go first: an Attack Intimidation negates never gets to
  // Grapple). Move / Posture skills also ride on Empty Move / Empty Posture.
  skillHook('negate_action', null, skCtx);   // S1 negate_action (Bluff, Intimidation)
  // Pass 2 — prohibitions on one kind of action.
  skillHook('negate_kind', null, skCtx);   // S1 negate_kind (Grapple, Disruption Move, Overrun)
  // SKR-03 Disruption Move (paper text, ruling 2026-11-16): the target plays an Empty Move that emits nothing — its non-instant
  // effect is voided on every peer (instants still go out); the target's own peer interrupts its cast after the run (doResolution).
  for (const r of revealsThisTurn) {
    if (!noEmit.has(r.actor) || !r.effect || r.effect.is_instant) continue;
    if (r.actor === PEER_ID_STRING || skillFx.some(f => f.on === r.actor && f.by === PEER_ID_STRING)) log(`[${PEER_LABEL}] disruption: ${r.actor.slice(0, 8)}'s ${r.effect.effect_id} emits nothing (Empty Move)`);
    r.effect = null; r.noEmit = true;
  }
  // Afflictions from sprung perm-traps hold while the holder keeps the permanent.
  // F2: what each such affliction does is its effect's `afflicted` program (definition `standing`): Sleep — no casting
  // while in contact with the holder; Confusion — only an Empty Posture (a trance collapses to it too).
  const afflictRule = (id) => {
    let no_cast = false, only = null;
    for (const a of parseJson(view.get(id)?.afflictions_json, [])) {
      if (a.by === id || !hasPerm(a.by, a.effect_id) || !holding([a.effect_id], 'afflicted').length) continue;
      const v = standing('afflicted', a.effect_id, null, { holder: a.by, victim: id, in_contact: distBetween(id, a.by) <= 1, every: csvSet(view.get(a.by)?.every_csv).has(a.effect_id) });
      no_cast = no_cast || v.no_cast; only = only ?? v.only;
    }
    return { no_cast, only };
  };
  for (const r of revealsThisTurn) {
    const only = afflictRule(r.actor).only;
    if (!only) continue;
    tranceOpts.delete(r.actor); effAction.set(r.actor, only); r.target = null; noMove.add(r.actor);
    if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] afflicted — only ${only} this action`);
  }
  const asleepFor = (id) => afflictRule(id).no_cast;
  // Monster natural permanents (user rulings 2026-11-15, rule_monster_natural_permanents; maths in natural-perms.mjs):
  // a living holder of the permanent with copies standing (perm_copies_json). Contact afflictions (Love / Awe / Fear /
  // Anger) sit in the VICTIM's afflictions_json ({effect_id, by, natural}) — added by the victim after the action it
  // came in contact, lifted at its tower (entry hex) or when the holder's last copy falls.
  const copiesOf = (id) => id === PEER_ID_STRING ? entity.permCopies : parseCopies(view.get(id)?.perm_copies_json);
  const naturalHas = (id, eff) => lifeOf(id) > 0 && hasPerm(id, eff) && (copiesOf(id)[eff] || 0) > 0;
  const naturalAffl = (id) => parseJson(view.get(id)?.afflictions_json, []);
  const naturalOf = (id, kind) => naturalOfKind(permsOf(id), kind).filter(e => naturalHas(id, e));   // F7: held natural perms of a kind
  const natBlockLogged = new Set();
  const natName = (id) => String(id).replace(/^peer:/, '');
  const natBlocked = (attacker, victim) => {
    const a = naturalDamageBlock({ attacker, victim, afflictions: naturalAffl(attacker), holds: naturalHas, dist: distBetween });
    if (a && !quiet) natFx.push({ effect_id: a.effect_id, on: attacker, by: a.by, kind: 'block' });
    if (a && (attacker === PEER_ID_STRING || victim === PEER_ID_STRING || a.by === PEER_ID_STRING) && !natBlockLogged.has(`${attacker}>${victim}`)) {
      natBlockLogged.add(`${attacker}>${victim}`);
      log(`[${PEER_LABEL}] natural ${a.effect_id}: ${natName(attacker)} cannot damage ${natName(victim)} (afflicted by ${natName(a.by)})`);
    }
    return !!a;
  };
  // Anger: an afflicted enemy in contact with the holder may only aim at it (Rule 15 autotarget override) — its
  // character target (Attack / Move / cast) becomes the holder; a tile target (a step) is left alone.
  for (const r of revealsThisTurn) {
    const fa = onlyHolderAffliction({ actor: r.actor, afflictions: naturalAffl(r.actor), holds: naturalHas, dist: distBetween }), by = fa?.by || null;
    if (!by || r.target?.kind === 'tile') continue;
    const aimed = r.target?.kind === 'character' ? r.target.ref : null;
    if (aimed === by || !(aimed || codeIs(r.actor, 'A') || r.effect)) continue;
    r.target = { kind: 'character', ref: by };
    if (!quiet) natFx.push({ effect_id: fa.effect_id, on: r.actor, by, kind: 'aim' });
    if (r.actor === PEER_ID_STRING || by === PEER_ID_STRING) log(`[${PEER_LABEL}] natural anger: ${natName(r.actor)} may only aim at ${natName(by)}${aimed ? ` (not ${natName(aimed)})` : ''}`);
  }
  // Combat damage straight off the resolution matrix: Attack has a base of 1,
  // every other action 0, plus the edge for (actor, defender). Empty actions
  // are read as the action they lose to (data note on the EP/EM rows): an
  // Attack sees EP as Posture, a Posture sees EP and EM as Move, a Block sees
  // EM as Move. So A→P 2, A→B 0, P→M/EM/EP 1, M→B 1, B→A 1, everything else 0.
  const mapDef = (atk, def) => def === 'EP' ? ({ A: 'P', P: 'M', M: 'EP', B: 'EP' }[atk] || def) : def === 'EM' ? ({ A: 'EM', P: 'M', M: 'EM', B: 'M' }[atk] || def) : def;
  // User ruling 2026-11-05: Attack deals base 1 against every non-Block action
  // — Posture, Empty Posture, Empty Move, Move, Attack all take 1. (Was 2 vs
  // P/EP under paper rules.) Block remains 0 + 1 back. The cycle A>P>M>B>A
  // still holds for every edge *except* the Attack→Posture one which now
  // flattens; Posture still outputs its own emission damage.
  const edgeDmg = (atk, def) => {
    if (atk === 'A' && (def === 'EP' || def === 'EM' || def === 'P')) return 1;
    return Math.max(0, (atk === 'A' ? 1 : 0) + (edgeMap[atk]?.[mapDef(atk, def)] ?? 0));
  };
  const hitDmg = (def) => edgeDmg('A', def);

  // Rule 9 / class static abilities: EP combat-type reassignment. Applied
  // after skills (so Intimidation first forces an attacker to EP, then the
  // class rule may lift that EP back to A/B/M as the stance). A Reaver's EP→A
  // needs a defender to strike: with no character target it takes the
  // adjacent enemy revealer by Rule 15 priority — the one that costs me the
  // least (not a blocker), then the one my hit lands on, then lowest life.
  const classOf = (id) => {
    const perms = permsOf(id);
    for (const p of perms) if (p.startsWith('class_') && CLASSES_IMPLEMENTED.has(p) && !isClassSuspended(p)) return p;   // CH: a dormant foreign class is no class
    return null;
  };
  // C1: what the class hooks (classes.mjs#classHook) see of this resolution — read-only queries.
  const clCtx = {
    self: PEER_ID_STRING, label: PEER_LABEL,
    view: (id) => view.get(id), viewIds: () => [...view.keys()], viewValues: () => [...view.values()],
    lifeOf, dist: distBetween, enemyOf, hasPerm, statOf, sideOf,
    classData: (id) => data.classes[id]?.data, skillAction: (sk) => data.skills[sk]?.data?.action_type, skillIsTrance: (sk) => !!SKILL_RULES[sk]?.trance,   // skill isolation: Bard (classes oracle) asks, never names the trance skill
    library: () => effCtx.library(), elemStat: (el) => ELEM_TO_STAT[el],
    get turn() { return hg.turn; }, get action() { return hg.action; }, sha: (s) => sha256Hex(s),
  };
  const CL_LIFESTEAL = clWith('lifesteal'), CL_ATTACK_OUT = clWith('attack_out');   // Noble; Assassin
  const CL_STEPPERS = clWith('step'), CL_TRANSMUTERS = clWith('transmute');   // Cleric, Rogue; Transmuter
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
    // C1 stance: Reaver EP / EM → A, Barbarian EP / EM → B (null: no stance). An EM stance still moves (moveAs).
    const stance = classHook('stance', c, clCtx, { code: cur });
    if (!stance) continue;
    effAction.set(r.actor, stance);
    if ((CLASS_RULES[c]?.hooks || []).includes('stance_target')) {
      // Reaver: both empty actions fight as an Attack. An Empty Move with nobody adjacent
      // still walks its half journey (`moveAs`), it just defends as an Attack.
      if (r.target?.kind !== 'character') {
        const cands = revealsThisTurn
          .filter(o => o.actor !== r.actor && enemyOf(r.actor, o.actor) && !hiddenFrom(r.actor, o.actor) && distBetween(r.actor, o.actor) <= 1)
          .map(o => ({ id: o.actor, cost: skillHook('block_cost', null, skCtx, { attacker: r.actor, defender: o.actor }),   /* S1 block_cost */ lands: hitDmg(codeNow(o.actor)) > 0 ? 0 : 1, life: lifeOf(o.actor) }));
        const pick = classHook('stance_target', c, clCtx, { cands });   // C1 stance_target (cost, lands, life, id)
        if (pick) r.target = { kind: 'character', ref: pick };
        else if (cur === 'EM') r.moveAs = 'EM';
        if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] reaver ${cur} fights as Attack${pick ? ` → ${pick.slice(0, 8)}` : ' (nobody adjacent)'}`);
      }
    } else if (cur === 'EM' && r.target?.kind !== 'character') {
      // User ruling 2026-11-19: a Barbarian's Empty Move fights as a Block AND still walks its half journey, like the
      // Reaver's EM above. It stays an Empty Move for emission / channel (r.declared EM: no emit, the channel breaks).
      r.moveAs = 'EM';
      if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] ${c} EM fights as ${stance} and still moves`);
    }
  }
  // Stance buildings (user ruling 2026-11-12): an Empty Posture played there is the building's action
  // ("always on Posture once in there") — after the class stances, which keep their own.
  for (const r of revealsThisTurn) {
    if (effAction.get(r.actor) !== 'EP') continue;
    const v = view.get(r.actor);
    const pw = v ? buildingPowerAt(v.tile_q, v.tile_r) : null;
    if (pw?.kind !== 'stance') continue;
    effAction.set(r.actor, pw.code);
    if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] building stance: my Empty Posture fights as ${pw.code}`);
  }
  // Natural Mists: an enemy in contact with a holder cannot Attack — the Attack (a trance option too) is an Empty
  // Posture. After the class / building stances, so a Reaver's or a stance building's Attack is caught as well.
  for (const r of revealsThisTurn) {
    if (!codeIs(r.actor, 'A')) continue;
    const by = [...view.keys()].filter(id => id !== r.actor && enemyOf(id, r.actor) && naturalOf(id, 'no_attack').length && distBetween(id, r.actor) <= 1).sort()[0];
    if (!by) continue;
    replace(r.actor, 'A', 'EP');
    if (!quiet) natFx.push({ effect_id: naturalOf(by, 'no_attack')[0], on: r.actor, by, kind: 'ban' });
    if (r.actor === PEER_ID_STRING || by === PEER_ID_STRING) log(`[${PEER_LABEL}] natural mists of ${natName(by)}: ${natName(r.actor)} cannot Attack in contact — Empty Posture`);
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
  skillHook('trance_assign', null, skCtx, { byActor, codeVs, attacksOn });   // S1 trance_assign (Battle Trance)

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
      const free = n => { const o = occupiedBefore.get(`${n.q},${n.r}`); return (!o || o === actorId) && !obstacleBlocks(actorId, n.q, n.r) && !labyrinthBlocks(n.q, n.r); };
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
  // Labyrinth walls: static impassable scenery. stepsAlong avoids them via the
  // `free` predicate, but the "straight" fallback can still choose a wall when
  // every closer-free option is taken — catch that at the dest and veto the
  // move. Unlike Creation obstacles, walls have no owner and take no damage.
  for (const [key, list] of byDest) {
    const [wq, wr] = key.split(',').map(Number);
    if (!labyrinthBlocks(wq, wr)) continue;
    for (const it of list) {
      vetoed.set(it.actor, `labyrinth wall blocks the way`);
      journeyResults.set(it.actor, { outcome: 'blocked', q: wq, r: wr, action: it.action });
    }
    byDest.delete(key);
  }
  // Natural Creation: an enemy whose Matter is below the holder's cannot enter the holder's adjacent hexes (no hp —
  // it falls with the permanent). Judged on the destination against the holders' tiles before this action's moves.
  const creationHolders = [...view.keys()].filter(id => naturalOf(id, 'ward').length).sort()
    .map(id => { const v = view.get(id); return { id, q: v.tile_q, r: v.tile_r, matter: statOf(id, 'matter') }; });
  if (creationHolders.length) for (const [key, list] of [...byDest]) {
    const [cq, cr] = key.split(',').map(Number);
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      const av = view.get(it.actor);
      const bar = creationBars({ dest: { q: cq, r: cr }, from: av ? { q: av.tile_q, r: av.tile_r } : null, moverMatter: statOf(it.actor, 'matter'),
        holders: creationHolders.filter(h => h.id !== it.actor && enemyOf(h.id, it.actor)), hexDist: (x, y) => hexDistance({ tile_q: x.q, tile_r: x.r }, { tile_q: y.q, tile_r: y.r }) });
      if (!bar) continue;
      list.splice(i, 1);
      vetoed.set(it.actor, `natural Creation of ${bar.id}: Matter below ${bar.matter} cannot come next to it`);
      journeyResults.set(it.actor, { outcome: 'blocked', q: cq, r: cr, action: it.action });
      if (it.actor === PEER_ID_STRING || bar.id === PEER_ID_STRING) log(`[${PEER_LABEL}] natural creation of ${natName(bar.id)}: ${natName(it.actor)} (Matter ${statOf(it.actor, 'matter')} < ${bar.matter}) cannot enter (${cq},${cr})`);
    }
    if (!list.length) byDest.delete(key);
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

  // SKR-04 Overrun swap (paper text, ruling 2026-11-16): the attacker and its adjacent target trade hexes after the moves —
  // both alive and neither moved this action (the target's own move is negated by noMove). Effect moves below see them.
  for (const sw of [...swaps].sort((a, b) => a.by.localeCompare(b.by) || a.on.localeCompare(b.on))) {
    const va = view.get(sw.by), vb = view.get(sw.on);
    if (!va || !vb || va.life <= 0 || vb.life <= 0 || nextTiles.has(sw.by) || nextTiles.has(sw.on)) continue;
    nextTiles.set(sw.by, { q: vb.tile_q, r: vb.tile_r }); nextTiles.set(sw.on, { q: va.tile_q, r: va.tile_r });
    journeyResults.set(sw.by, { outcome: 'complete', q: vb.tile_q, r: vb.tile_r, action: 'overrun' });
    journeyResults.set(sw.on, { outcome: 'complete', q: va.tile_q, r: va.tile_r, action: 'overrun' });
    if (sw.by === PEER_ID_STRING || sw.on === PEER_ID_STRING) log(`[${PEER_LABEL}] overrun: ${sw.by.slice(0, 8)} and ${sw.on.slice(0, 8)} swap places`);
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
  const classAbilityOut = { used: [], heals: [], discards: [], peeks: [], traps: [], tokens: [], armor: [], illusion: [], revives: [], moves: [], stealth: [], rogueTrap: [], lures: [], builds: [] };
  const elementalistPending = [];       // { actor, value, stat } — counted as used once the damage cast lands
  const abilityOf = (r) => (r.classAbility && typeof r.classAbility.id === 'string' && classReady(r.actor, r.classAbility.id) && lifeOf(r.actor) > 0) ? r.classAbility : null;
  const abilityTile = (ab) => ab?.target?.kind === 'tile' ? ab.target.ref : null;
  const abilityPeer = (ab) => ab?.target?.kind === 'character' ? ab.target.ref : null;
  const adjacentOf = (id, pred) => [...view.keys()].filter(o => o !== id && lifeOf(o) > 0 && distBetween(id, o) <= 1 && pred(o)).sort();
  // Hand classes (2026-11-14): living, visible (no Invisibility) enemies within `range` hexes, sorted by id.
  const foesNearby = (id, range) => [...view.keys()].filter(o => o !== id && lifeOf(o) > 0 && enemyOf(id, o) && distBetween(id, o) <= range && !hidingPerm(permsOf(o))).sort();
  const useAbility = (r, note) => { classAbilityOut.used.push({ actor: r.actor, class_id: r.classAbility.id }); if (r.actor === PEER_ID_STRING) { log(`[${PEER_LABEL}] class ${r.classAbility.id}: ${note}`); log(classEventLine(r.classAbility.id, 'ability')); } };
  // C1 ability: the hook's {used, note, log, mine, out} → classAbilityOut + log (null = resolved here in peer.mjs).
  // Phase 3: `requests` (the post pass's ABILITY_REQUEST_FNS) resolves the engine requests of `out` — each request
  // decides the use itself; a pre-pass ability may not ask for one (logged, dropped).
  const classAbility = (r, ab, requests = null) => {
    const res = classHook('ability', ab.id, clCtx, { actor: r.actor, ab, salt: r.salt, moved: !!moveCodeOf(r) });   // CP: healer_moved — Healer unmoved_only (pick 2026-11-19 #4 a)
    if (!res) return false;
    const reqs = Object.keys(res.out).filter(k => ABILITY_REQUESTS.includes(k)).sort();
    for (const [k, l] of Object.entries(res.out)) if (!ABILITY_REQUESTS.includes(k)) classAbilityOut[k].push(...(k === 'revives' ? l.map(x => ({ ...x, cls: ab.id })) : l));   // phase 4: a revive names its class
    for (const s of res.log) log(s);
    if (r.actor === PEER_ID_STRING) for (const s of res.mine) log(s);
    if (reqs.length) {
      if (!requests) { if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] class ${ab.id}: requests ${reqs.join(', ')} only resolve in the post pass — dropped`); return true; }
      for (const k of reqs) for (const rq of res.out[k]) requests[k](r, ab, rq);
      return true;
    }
    if (res.used) useAbility(r, res.note);
    return true;
  };
  const rogueMove = new Set();          // Rogue: movers that trigger no trap / reveal nothing this action
  for (const r of revealsThisTurn) {
    const ab = abilityOf(r);
    // Elementalist (passive, user ruling 2026-11-12): once per turn, by itself — the emission that completes
    // a damage cast carries an extra point-buy die of the cast's best element (my highest stat among them).
    const ec = classOf(r.actor);
    if ((CLASS_RULES[ec]?.hooks || []).includes('pre_cast') && classReady(r.actor, ec) && lifeOf(r.actor) > 0 && castsDamage(r)) {
      const pb = classHook('pre_cast', ec, clCtx, { actor: r.actor, elements: r.effect.elements, salt: r.salt });   // C1 pre_cast: point-buy of my best stat among the cast's elements
      const best = pb.stat;
      if (!pb.fail) {
        castBoost.set(r.actor, pb.value); elementalistPending.push({ actor: r.actor, cls: ec, value: pb.value, stat: best, dice: pb.dice });
        if (r.actor === PEER_ID_STRING) { log(`[${PEER_LABEL}] class ${clShort(ec)}: the extra ${best} die [${pb.dice.join(',')}] adds ${pb.value} to my cast`); log(classEventLine(ec, 'reroll')); }   // log only (user 2026-11-23)
      }
      else if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] class ${clShort(ec)}: the extra ${best} die failed [${pb.dice.join(',')}] — nothing added, it stays ready this turn`);
    }
    // Illusionist (user ruling 2026-11-12): me and every ally within ILLUSION_RANGE get one illusion life
    // point (lost first, like the Overlord's armor); it fades after the turn's 3rd action.
    if (ab && CLASS_RULES[ab.id]?.phase === 'pre') classAbility(r, ab);   // C1 ability (phase pre: Illusionist, allies within 10)
  }
  // Bard (static): every player in contact with a Bard who plays a skill plays it too, when their action allows.
  const CL_SHARERS = Object.keys(CLASS_RULES).filter(id => (CLASS_RULES[id].hooks || []).includes('share_skills'));   // C1: Bard
  for (const r of revealsThisTurn) {
    const sharer = CL_SHARERS.find(c => hasPerm(r.actor, c));
    if (!sharer || !(r.skills || []).length) continue;
    const adj = adjacentOf(r.actor, o => !enemyOf(r.actor, o) && !!byActorPre.get(o)).map(o => { const rev = byActorPre.get(o); return { id: o, codes: rev.trance || [rev.action], skills: rev.skills }; });
    const sh = classHook('share_skills', sharer, clCtx, { actor: r.actor, skills: r.skills, adj });   // C1 share_skills (S1 rides inside)
    for (const a of sh.adds) { const rev = byActorPre.get(a.on); rev.skills = [...rev.skills, a.skill]; }
    for (const s of sh.log) log(s);
    if (sh.adds.length && r.actor === PEER_ID_STRING) log(classEventLine(sharer, 'share_skills'));   // log only (user 2026-11-23)
  }
  const casts = revealsThisTurn.filter(r => r.effect && Array.isArray(r.effect.elements) && r.effect.elements.length && view.get(r.actor));
  // Blessing / Curse ∀ (user ruling 2026-10-30): a holder of TWO Blessings loses the second one the moment
  // an enemy effect is about to touch them — damage, a lock, a penalty token, a forced move, an
  // affliction, a possession — and that part of the effect is negated. One negation per holder per action.
  // F3: the guarding permanent's `harm_in` program decides (Blessing: only ∀); blessAnswer → {perm, negate, spend} | null.
  const blessFired = [];                // { holder, caster, effect_id, perm, spend } — spent by the holder after the run
  const blessUsed = new Set();
  const blessAnswer = (id, caster = null, effectId = null) => {
    if (blessUsed.has(id)) return null;
    const every = csvSet(view.get(id)?.every_csv);
    for (const pid of holding(permsOf(id), 'harm_in')) { const r = standing('harm_in', pid, null, { holder: id, caster, effect_id: effectId, every: every.has(pid) }); if (r) return { perm: pid, ...r }; }
    return null;
  };
  const blessedEvery = (id) => !!blessAnswer(id);
  const blessNegate = (oc, caster, effectId) => {
    const hurt = new Set([...oc.hits.map(h => h.victim), ...oc.locks.map(l => l.on), ...oc.statTokens.filter(t => t.value < 0).map(t => t.on), ...oc.moves.filter(m => m.who !== caster).map(m => m.who), ...(oc.possess?.bind ? [oc.possess.bind] : []), ...(oc.peeks || []).filter(p => p.kind === 'hand').map(p => p.of)]);
    for (const v of [...hurt].sort()) {
      const ans = v === caster || !enemyOf(caster, v) ? null : blessAnswer(v, caster, effectId);
      if (!ans) continue;
      blessUsed.add(v); blessFired.push({ holder: v, caster, effect_id: effectId, perm: ans.perm, spend: ans.spend });
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
    // F2: any permanent of a would-be victim with a cast_in program (definition `standing`) — the first victim in id
    // order whose first such permanent answers stops the cast.
    if (oc.status === 'done') {
      const hurt = new Set([...oc.hits.map(h => h.victim), ...oc.locks.map(l => l.on), ...oc.statTokens.filter(t => t.value < 0).map(t => t.on), ...oc.moves.filter(m => m.who !== r.actor).map(m => m.who)]);
      let holder = null, fired = null;
      for (const v of [...hurt].filter(v => v !== r.actor && enemyOf(r.actor, v) && !disableUsed.has(v)).sort()) {
        const ev = csvSet(view.get(v)?.every_csv);
        for (const pid of holding(permsOf(v), 'cast_in')) {
          const ci = standing('cast_in', pid, null, { holder: v, caster: r.actor, effect_id: eff.effect_id, last_elem: eff.elements[eff.elements.length - 1], every: ev.has(pid) });
          if (ci) { fired = { ...ci, perm: pid }; break; }
        }
        if (fired) { holder = v; break; }
      }
      if (holder) {
        disableUsed.add(holder);
        const elem = fired.elem;
        const global = fired.bar === 'all';
        disableTriggers.push({ holder, caster: r.actor, elem, global, perm: fired.perm, spend: fired.spend });
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
      if (mv.reason !== 'switched' && [...nextTiles.values()].some(t => `${t.q},${t.r}` === key)) { if (mv.reason === 'awakened') log(`[${PEER_LABEL}] awake: ${r.actor.slice(0, 14)}'s move of ${mv.who.slice(0, 14)} to (${key}) dropped — the hex is taken this action`); continue; }
      if (mv.reason === 'awakened') log(`[${PEER_LABEL}] awake: ${r.actor.slice(0, 14)} moves ${mv.who === r.actor ? 'itself' : mv.who.slice(0, 14)} to (${key}) — ${oc.notes.find(n => n.startsWith('awake moves')) || ''}`);
      nextTiles.set(mv.who, { q: mv.q, r: mv.r });
      journeyResults.set(mv.who, { outcome: 'complete', q: mv.q, r: mv.r, action: mv.reason });
    }
    for (const rl of oc.relocations || []) relocations.push(rl.kind === 'building' || rl.kind === 'wall' ? { ...rl, via: eff.effect_id } : rl);
  }

  // Channel-token ticks (Harm, Combustion, The Void, Light/Darkness). general_ux_channeling:
  // the cast registers a channel permanent in `entity.channels`; every subsequent action every
  // peer re-fires the channel's non-permanent, non-emission leg via resolveEffect({..._channel_tick}).
  // The channel ends the moment the caster breaks concentration — plays A, B, M or EM, or emits
  // an element other than the channel's cost element. Zones/voidFor from a tick must land
  // before the damage pass below.
  const parseChannels = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const channelsBroken = [];            // { owner, effect_id } — concentration lost this action (applied by the owner after the run)
  // CR: channel-rule.mjs (user ruling 2026-11-17: a Reaver's A / a Barbarian's B keep the holder's channel). The
  // "channel kept" line is logged on every peer (deterministic) so the live test can match it across peers.
  // MV: channel_pass — effect-hooks.mjs / effects-data/hooks/channel.json decide, per living unit (sorted) and channel,
  // break | kept (class exception, channel-rule.mjs) | contact (Awake / stop 'contact', 2026-11-18: a living enemy next to
  // the holder ends it — after the break, before the cast-action skip) | tick (the cast to re-fire; the cast action itself
  // does not tick, a blessed channel lives and dies with its Blessing). Applied here in record order.
  const chHookCtx = {
    ids: () => [...view.keys()].sort(), view: (id) => view.get(id), lifeOf, hasPerm,
    channelsOf: (id) => parseChannels(view.get(id)?.channels_json), reveal: (id) => byActorPre.get(id),
    classEmits: (id, code) => { const c = classOf(id); return !!c && !!classHook('emits', c, clCtx, { code, site: 'plan' }); },
    enemyOf, distBetween,
  };
  applyHookRecords(effectHook('channel_pass', chHookCtx, { turn: hg.turn, action: hg.action, round: hg.round }), {
    kept: (x) => log(`[${PEER_LABEL}] channel kept: ${x.owner.slice(0, 14)} ${classOf(x.owner)} plays ${byActorPre.get(x.owner)?.declared ?? byActorPre.get(x.owner)?.action} — ${x.effect_id || 'channel'} goes on (t${hg.turn} a${hg.action})`),
    break: (x) => { channelsBroken.push({ owner: x.owner, effect_id: x.effect_id }); },
    contact: (x) => {
      channelsBroken.push({ owner: x.owner, effect_id: x.effect_id, why: 'contact with an enemy' });
      log(`[${PEER_LABEL}] awake: ${x.owner.slice(0, 14)}'s ${x.effect_id} channel ends — contact with an enemy`);
    },
    tick: (x) => {
      const oc = resolveEffect(effCtx, x.cast);
      if (oc.status !== 'done') return;
      blessNegate(oc, x.owner, x.effect_id);
      effectOutcomes.push({ actor: x.owner, eff: { effect_id: x.effect_id, elements: x.cast.elements }, oc, channel: true });
      for (const vId of oc.voidFor) voidFor.add(vId);
      roundZones.push(...oc.zones);
      if (x.owner === PEER_ID_STRING || x.target === PEER_ID_STRING) log(`[${PEER_LABEL}] ${x.effect_id} channel tick by ${x.owner.slice(0, 8)}${oc.hits.length ? ` → ${oc.hits.map(h => h.victim.slice(0, 8)).join(',')}` : ''}`);
    },
  });

  // Natural Earthquake: while the monster's copies stand, every enemy in contact takes Earthquake's delta damage
  // (Earth→Matter, the effect's own rule) at the end of each engine turn — its last action — like a channel tick.
  if (!bonusRound && hg.round === ROUNDS_PER_TURN - 1) for (const id of [...view.keys()].sort()) {
    for (const tick of naturalOf(id, 'turn_tick')) {   // F7: naturalKind turn_tick (Earthquake) — the effect ticks itself
    const elements = data.effects[tick]?.data?.element_cost || ['elem_earth'];
    const oc = resolveEffect(effCtx, { actor: id, effect_id: tick, elements, salt: `natural:${id}:${hg.turn}`, target: null, is_instant: true, every: false, aura: false, step: elements.length, of: elements.length, kept: null, summon: null, _channel_tick: true });
    if (oc.status !== 'done') continue;
    blessNegate(oc, id, tick);
    effectOutcomes.push({ actor: id, eff: { effect_id: tick, elements }, oc, channel: true });
    if (id === PEER_ID_STRING || oc.hits.some(h => h.victim === PEER_ID_STRING)) log(`[${PEER_LABEL}] natural ${tick.replace(/^effect_/, '')} tick by ${natName(id)} (T${hg.turn} end)${oc.hits.length ? ` → ${oc.hits.map(h => natName(h.victim)).join(',')}` : ' — nobody in contact'}`);
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
    if (permId.startsWith('skill_')) return skillHook('perm_stats', permId, skCtx);   // S1 perm_stats
    if (permId.startsWith('effect_')) return [...new Set((data.effects[permId]?.data?.element_cost || []).map(el => ELEM_TO_STAT[el]).filter(Boolean))];
    return [];
  };
  // Class cards (user ruling 2026-10-30): `destroy: { stat, class: <peer>, elem }` aims the emission at an
  // adjacent enemy's class — its colour behind `stat` falls to a die of 6 (one colour per action, in any
  // order); once every colour is down the class leaves the board for its owner's archive. The owner
  // recasts it from the archive (`destroy: { stat, recast: true }`) and untaps a tapped ability
  // (`destroy: { stat, untap: true }`) by emitting each colour with ANY successful point-buy (power 1).
  const classOutcomes = [];             // { actor, owner, class_id, kind: 'colour'|'class_destroyed'|'recast'|'untap', stat, ok, die }
  // Fortress stat buy (user ruling 2026-11-14, data/rules.json rule_building_fortress): a unit within FORTRESS.near
  // of a standing fortress emits its stat (Posture / Empty Posture, `destroy: { stat, building: 'q,r' }`) — once per
  // FORTRESS.per it banks its current stat (no roll, like Summoning's stat buy). Bank ≥ the fortress value → the
  // fortress breaks (world edit `bld:q,r` gone, applied by the breaker) and the breaker point-buys
  // round(value / 10) dice from the reveal salt: the highest die (data.fortress.bonus 'max') is a stat bonus token on
  // that stat, like Artifice's. The bank lives in the actor's snapshot (`fortress_bank_json`), the token in
  // `stat_tokens_json` — both applied by the actor in doResolution (applyFortressOutcomes).
  const fortressStatBuy = (r, stat) => {
    const [bq, br] = String(r.destroy.building).split(',').map(Number);
    const fz = fortressAt(MAP_SEED, bq, br, worldEditsNow);
    const av = view.get(r.actor);
    if (!fz || fz.stat !== stat || hexDistance({ tile_q: av.tile_q, tile_r: av.tile_r }, { tile_q: bq, tile_r: br }) > FORTRESS.near) { if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] fortress: no standing ${stat} fortress within ${FORTRESS.near} of me at (${bq},${br})`); return; }
    const mine = statOf(r.actor, stat);
    const step = fortressBankStep(fortressBankIn(r.actor), fz, mine, hg.turn, hg.action);
    if (!step.ok) { if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] fortress ${fz.id}: ${step.why}`); return; }
    const out = { actor: r.actor, owner: 'world', kind: 'building', id: fz.id, label: fz.source, stat, power: fz.value, bank: step.bank, add: mine, die: 0, dice: [], result: step.broken ? 'destroyed' : 'banked' };
    if (step.broken) { out.dice = rollDice(`${r.salt || ''}:fortress:${fz.id}:${hg.action}`, fortressBonusDice(fz.value), sha256Hex); out.bonus = fortressBonusOf(out.dice); out.die = out.bonus; }
    destroyOutcomes.push(out);
    log(`[${PEER_LABEL}] fortress: ${r.actor.slice(0, 8)} stat-buys the ${fz.source} at (${bq},${br}) with ${stat} ${mine}: bank ${step.bank}/${fz.value}${step.broken ? ` → broken; point-buy ${out.dice.length} dice [${out.dice.join(',')}] = ${stat} +${out.bonus}` : ''}`);
  };
  for (const r of revealsThisTurn) {
    const stat = r.destroy?.stat;
    if (!stat || !['vitality', 'world', 'matter', 'will'].includes(stat) || !view.get(r.actor)) continue;
    const emitsNow = ['P', 'EP'].includes(r.declared) || classHook('emits', classOf(r.actor), clCtx, { code: r.action, site: 'destroy' });   // C1 emits (Reaver A, Monk M)
    if (!emitsNow) continue;
    const pb = pointBuy(statOf(r.actor, stat), `${r.salt || ''}:destroy:${hg.action}:${stat}`, sha256Hex);
    // --- my own class: recast from the archive / untap the ability (power 1 = any successful roll) ---
    if (r.destroy.recast || r.destroy.untap) {
      const cs = classStateOf(r.actor);
      const kind = r.destroy.recast ? 'recast' : 'untap';
      const cols = cs.class_id ? classColours(cs.class_id) : {};
      const valid = classHook('restore', cs.class_id, clCtx, { cs, cols, stat, kind });   // C1 restore (a colour still owed)
      if (!valid) { if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] class ${kind}: ${stat} is not a colour still owed`); continue; }
      const ok = !pb.fail;
      classOutcomes.push({ actor: r.actor, owner: r.actor, class_id: cs.class_id, kind, stat, ok, die: pb.value, dice: pb.dice });
      if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] class ${kind}: ${stat} emitted, dice [${pb.dice.join(',')}] → ${ok ? 'colour prepared' : 'failed roll, again next action'}`);
      continue;
    }
    // --- a fortress building: stat buy (user ruling 2026-11-14) ---
    if (r.destroy.building) { fortressStatBuy(r, stat); continue; }
    const enemies = [...view.keys()].filter(id => id !== r.actor && lifeOf(id) > 0 && enemyOf(r.actor, id) && !hiddenFrom(r.actor, id) && distBetween(r.actor, id) <= 1);
    // --- C1 ruling 2026-11-16, Necromancer "destroy reanimated": `destroy: { stat, reanimated: <peer>, elem }` aims at
    // an adjacent enemy unit a class raised (snapshot raised_by) — its raiser class's reanimated_strike hook says which
    // element falls (die of 6, Harmony + Concentration, one per emission, any order); both down → the unit is destroyed
    // (applied by the unit itself: Rule 24 loop in doResolution, kind 'reanimated').
    if (r.destroy.reanimated) {
      const e = r.destroy.reanimated, ev = view.get(e);
      const rs = ev?.raised_by ? classHook('reanimated_strike', ev.raised_by, clCtx, { down: [...CS.stateGet(csOf(ev), ev.raised_by, 'down', [])], stat, elem: r.destroy.elem || null, enemy: enemies.includes(e), pb }) : null;
      if (!rs) { if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] reanimated strike: ${String(e).slice(0, 8)} is no reanimated enemy in reach with an open ${stat} element`); continue; }
      destroyOutcomes.push({ actor: r.actor, owner: e, kind: 'reanimated', id: rs.elem, power: pb.value, die: pb.value, dice: pb.dice, result: rs.result, last: rs.last, label: ev.name || '' });
      if (r.actor === PEER_ID_STRING || e === PEER_ID_STRING) log(`[${PEER_LABEL}] ${r.actor.slice(0, 8)} emits ${stat} against reanimated ${e.slice(0, 8)}'s ${rs.elem}: dice [${pb.dice.join(',')}] → ${rs.result}${rs.last ? ' — the reanimated unit is destroyed' : ''}`);
      continue;
    }
    // --- an enemy's class colour (die of 6) ---
    if (r.destroy.class) {
      const e = r.destroy.class;
      const cs = classStateOf(e);
      const cols = cs.class_id ? classColours(cs.class_id) : {};
      const strike = classHook('strike', cs.class_id, clCtx, { cs, cols, stat, elem: r.destroy.elem, enemy: enemies.includes(e), pb });   // C1 strike (die of 6)
      if (!strike) { if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] class strike: ${e.slice(0, 8)} has no standing ${stat} colour in reach`); continue; }
      const { result, last } = strike;
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
      // Destroy order (user ruling 2026-11-14): permanents → character stat bonus tokens (Artifice, Fortress) → tile tokens.
      return rule24Order(out);
    };
    // F6: the Possess permanent that holds a possessed unit — in its own holding (2026-10-30 form) or its possessor's.
    const possessPermFor = (id) => possessPermOf(permsOfRaw(id)) || possessPermOf(permsOfRaw(possessorOf(id)));
    const possessedAllies = [...view.keys()].filter(id => id !== r.actor && lifeOf(id) > 0 && distBetween(r.actor, id) <= 1 && possessorOf(id) && enemyOf(r.actor, possessorOf(id))
      && sideOf(view.get(id).alliance) === sideOf(view.get(r.actor).alliance) && permStats(possessPermFor(id)).includes(stat)).sort();
    const pa = possessedAllies[0], pap = pa ? possessPermFor(pa) : null;
    const pick = possessedAllies.length
      ? { e: pa, c: [{ owner: pa, kind: 'perm', id: pap, power: permPowerOf(pa)[pap] || 6 }] }
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
  // User ruling 2026-11-17: the Phylactery is the Possess permanent cast with no creature in the archive
  // (possess_mode 'phylactery'); one click = `phylactery: {auto: true}` and the target is judged HERE, from the
  // view, alike on every peer (possess.mjs phylacteryPick: nearest visible enemy within reach holding a
  // non-class permanent → its highest-power one, creature holders / hostile ones on ties). Nothing in reach →
  // nothing happens and the Phylactery stays.
  for (const r of revealsThisTurn) {
    if (!r.phylactery?.auto || !view.get(r.actor) || lifeOf(r.actor) <= 0 || !possessPermOf(permsOf(r.actor)) || view.get(r.actor)?.possess_mode !== 'phylactery') continue;
    const phylReach = phylReachOf(possessPermOf(permsOf(r.actor)));
    const pick = phylacteryPick({ me: r.actor, ids: [...view.keys()], alive: (id) => lifeOf(id) > 0 && !(invisibleNow(id) && !invisibleNow(r.actor)),
      enemy: enemyOf, dist: distBetween, perms: permsOfRaw, power: (id, p) => permPowerOf(id)[p] || 1, holdsCreature: phylHoldsCreature, hostile: phylHostile }, phylReach);
    if (!pick) { if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] phylactery: no enemy permanent within ${phylReach} — nothing to shatter`); continue; }
    r.phylactery = { peer_id: pick.peer_id, perm: pick.perm, auto: true };
    if (r.actor === PEER_ID_STRING || pick.peer_id === PEER_ID_STRING) log(`[${PEER_LABEL}] phylactery: ${r.actor.slice(0, 8)} aims at ${pick.peer_id.slice(0, 8)}'s ${pick.perm} — ${pick.why}`);
  }
  for (const r of revealsThisTurn) {
    const ph = r.phylactery;
    // The holder is whoever's Possess stands somewhere: in a possessed unit's holding (normal) or their own.
    const possessed = [...view.keys()].filter(id => possessorOf(id) === r.actor && permsOfRaw(id).some(isPossessPerm)).sort()[0] || null;
    if (!ph?.peer_id || !ph.perm || !view.get(r.actor) || !(possessed || (possessPermOf(permsOf(r.actor)) && view.get(r.actor)?.possess_mode === 'phylactery'))) continue;
    if (String(ph.perm).startsWith('class_') || lifeOf(ph.peer_id) <= 0 || !enemyOf(r.actor, ph.peer_id) || !permsOfRaw(ph.peer_id).includes(ph.perm)) {
      if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] phylactery: ${ph.peer_id.slice(0, 8)} holds no ${ph.perm} I may shatter`);
      continue;
    }
    const power = permPowerOf(ph.peer_id)[ph.perm] || 1;
    destroyOutcomes.push({ actor: r.actor, owner: ph.peer_id, kind: 'perm', id: ph.perm, power, die: power, dice: [], result: 'destroyed', phylactery: true });
    // The Possess permanent is spent for it, wherever it stands.
    if (possessed) destroyOutcomes.push({ actor: r.actor, owner: possessed, kind: 'perm', id: possessPermOf(permsOfRaw(possessed)), power: 6, die: 6, dice: [], result: 'destroyed', phylactery: true });
    else channelsBroken.push({ owner: r.actor, effect_id: possessPermOf(permsOf(r.actor)), why: 'phylactery spent' });
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
  // `why` (display only — the death banner names it; never hashed): 'Attack', 'fire token', 'trap Fireball'…
  const addDmg = (victim, attacker, amount, source = 'action', why = '') => {
    // Natural Love / Awe / Fear / Anger: an afflicted attacker's damage does not land (no point taken, nothing spent).
    if (amount > 0 && natBlocked(attacker, victim)) return;
    const list = damage.get(victim) || [];
    // Super Sense (user spec 2026-10-29): the holder evades one point of the first damage that lands;
    // the permanent is spent for it (dropped by the owner after the run).
    // F2: every permanent of the victim with a damage_in program (definition `standing`), asked once per action.
    if (amount > 0) for (const pid of holding(permsOf(victim), 'damage_in')) {
      const k = `${victim}|${pid}`;
      if (amount <= 0 || senseFired.has(k)) continue;
      senseFired.add(k);
      const was = amount;
      const di = standing('damage_in', pid, null, { holder: victim, attacker, amount, source, every: csvSet(view.get(victim)?.every_csv).has(pid) });
      amount = di.amount;
      if (di.spend) channelsBroken.push({ owner: victim, effect_id: pid, why: `${was - amount} point(s) of damage evaded` });
      if ((victim === PEER_ID_STRING || attacker === PEER_ID_STRING) && amount !== was) log(`[${PEER_LABEL}] ${pid}: ${victim.slice(0, 8)} evades ${was - amount} point(s) of ${attacker.slice(0, 8)}'s ${source} damage`);
    }
    list.push({ attacker, amount, source, ...(why ? { why } : {}) });
    damage.set(victim, list);
    for (const c of CL_LIFESTEAL) lifestealForMe.amount += classHook('lifesteal', c, clCtx, { attacker, amount, source, why });   // C1 lifesteal (Noble, mine only) // CR: noble — from my Attack only (2026-11-17)
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
  // Buildings / landmarks where a unit stands after the moves (user ruling 2026-11-12).
  const buildingOf = (id) => { const t = postTile(id); return t && Number.isInteger(t.tile_q) ? buildingBonusAt(MAP_SEED, t.tile_q, t.tile_r) : null; };
  const guardUsed = new Map();   // victim → combat damage its stronghold already turned aside this action
  // Blanket protections shared by combat and effect damage: The Void, a
  // no-damage zone on either tile, an invisible defender.
  const untouchable = (victim, attacker, area = false) => {
    if (voidFor.has(victim)) return true;
    // Invisibility: nothing aimed reaches the hidden unit (another invisible unit sees it); an untargeted
    // area (Meteor Shower, `area`) still does (ruling 2026-11-14).
    if (!area && invisibleNow(victim) && !(attacker && attacker !== victim && invisibleNow(attacker))) return true;
    const a = postTile(attacker), v = postTile(victim);
    return !!(a && v && (inZone(a.tile_q, a.tile_r) || inZone(v.tile_q, v.tile_r)));
  };
  // One strike of `code` by r.actor on defId; the defender's code is whatever
  // they play against this actor (a trance picks per enemy).
  const strike = (r, code, defId) => {
    const atk = view.get(r.actor), def = view.get(defId);
    if (!atk || !def || !enemyOf(r.actor, defId)) return;
    // SKR-05 Ranged Weapon "+1 range" (ruling 2026-11-16): the holder's Attack reaches 2 hexes; every other strike needs contact.
    if (hexDistance(postTile(r.actor), postTile(defId)) > skillHook('attack_range', null, skCtx, { attacker: r.actor, code })) return;
    let defCode = codeVs(defId, r.actor);
    if (code === 'B') {
      // Block scores against Attacks aimed at the blocker — not on a Ranged Weapon holder from beyond contact, nor on a taunter.
      if (defCode !== 'A' || !attacksOn(byActor.get(defId), r.actor)) return;
      if (skillHook('block_in', null, skCtx, { defender: defId, blocker: r.actor })) return;   // S1 block_in (SKR: Ranged Weapon, Taunt)
    }
    // Taunt "nearby enemies cannot use Block against you": the taunter's Attack meets that Block as an Empty action.
    if (code === 'A' && defCode === 'B' && skillHook('attack_vs_block', null, skCtx, { attacker: r.actor, defender: defId })) defCode = 'EP';
    let dmg = bonusRound ? (code === 'A' ? 1 : 0) : edgeDmg(code, defCode);
    if (code === 'A') {
      dmg = skillHook('attack_out', null, skCtx, { attacker: r.actor, dmg });   // S1 attack_out
      // Assassin: +1 if the attacker has already connected this round. The flag
      // is set when a previous addDmg(..., attacker, >0) landed — so same-round
      // "first hit then rider" scales up for them. Resolver-local; no state leak.
      for (const c of CL_ATTACK_OUT) {
        const was = dmg;
        dmg = classHook('attack_out', c, clCtx, { attacker: r.actor, dmg, scored: [...assassinScored], defender: defId });   // C1 attack_out (Assassin +1) // CR: assassin — vs a hurt enemy only (2026-11-17)
        // log only (user 2026-11-23): the holder's line when its class changed the blow
        if (dmg !== was && r.actor === PEER_ID_STRING) { log(`[${PEER_LABEL}] class ${c.replace(/^class_/, '')}: my attack ${was} → ${dmg} damage (the class rule)`); log(classEventLine(c, 'attack_out')); }
      }
      // Taunt: a nearby taunter is the only legal Attack target. Only revealers
      // count — their snapshots ride in the reveal, so every peer sees the same set.
      if (skillHook('attack_target', null, skCtx, { attacker: r.actor, defender: defId })) dmg = 0;   // S1 attack_target
    }
    // Inner Fire: one point of non-effect damage becomes two. F2: every combat_out program the attacker holds (definition `standing`).
    for (const pid of holding(permsOf(r.actor), 'combat_out')) dmg = standing('combat_out', pid, null, { holder: r.actor, code, dmg, every: csvSet(view.get(r.actor)?.every_csv).has(pid) });
    // Buildings: an Attack from a war shrine hits harder; cover softens a Block;
    // a sanctuary takes no combat damage; a stronghold turns aside the first point(s).
    {
      const ab = buildingOf(r.actor), db = buildingOf(defId);
      const was = dmg;
      if (code === 'A' && dmg >= 1 && ab?.bonus?.sword) dmg += ab.bonus.sword;
      if (dmg > 0 && db?.bonus?.cover && defCode === 'B') dmg = Math.max(0, dmg - db.bonus.cover);
      if (dmg > 0 && db?.bonus?.sanctuary) dmg = 0;
      if (dmg > 0 && db?.bonus?.guard) { const used = guardUsed.get(defId) || 0; const g = Math.min(dmg, db.bonus.guard - used); if (g > 0) { dmg -= g; guardUsed.set(defId, used + g); } }
      if (dmg !== was && (defId === PEER_ID_STRING || r.actor === PEER_ID_STRING)) log(`[${PEER_LABEL}] building: ${r.actor.slice(0, 8)} ${code} → ${defId.slice(0, 8)} ${was} → ${dmg} (${dmg > was ? ab.source : db.source})`);
    }
    dmg = skillHook('defend_in', null, skCtx, { code, defender: defId, dmg, byActor });   // S1 defend_in (Barricade, Sanctuary)
    if (untouchable(defId, r.actor)) dmg = 0;
    if (dmg > 0 && absorbedByShieldToken(defId)) dmg = 0;
    addDmg(defId, r.actor, dmg, 'action', code === 'A' ? 'Attack' : code === 'B' ? 'Block' : code);
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
  skillHook('damage_in', null, skCtx, { damage });   // S1 damage_in

  // Effect damage (Rule 21): each leg rounded half-up / 10 on its own. Before
  // rounding, Force Shield's die comes off the first leg that would otherwise
  // land and is spent by that. A shield token on the defender's tile (Rule 20
  // / Rule 21 "defender has tokens to destroy") absorbs one landing hit
  // instead — the defender loses their lowest token. Nothing here touches
  // state: tokens to drop, heals, locks, … ride out in `effectOutcomes`.
  const brokenShield = [];   // ids of my effect shields spent this action
  const permanentsToAdd = [];
  // Fire tokens left on tiles earlier: whoever steps onto one this action takes
  // its point-buy damage (Rule 20) and the token vanishes.
  for (const [who, t] of [...nextTiles.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const tok of tileTokensAt(t.q, t.r).filter(x => x.kind === 'fire' && !spentIds.has(x.id)).sort((a, b) => a.id.localeCompare(b.id))) {
      spentIds.add(tok.id); tokensSpent.push({ owner: tok.owner, id: tok.id });
      let d = untouchable(who, tok.owner) ? 0 : roundHalfUp10(tok.value);
      if (d > 0 && absorbedByShieldToken(who)) d = 0;
      if (d > 0) addDmg(who, tok.owner, d, 'effect', 'fire token');
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
  // MV: trap_spring / trap_enter / trap_targeted — the trap rules are hooks (effects-data/hooks/trap.json); this ctx is
  // what they may read. A sprung trap's records: bless | damage {amount} (a shield token may still absorb it) | afflict + perm_add.
  const trapHookCtx = {
    self: PEER_ID_STRING, blessedEvery, statOf, elemStat: (el) => ELEM_TO_STAT[el], shielded: (id, el) => effCtx.shieldedAgainst(id, el),
    untouchable: (victim, attacker) => untouchable(victim, attacker), traps: () => allTraps, trapGone: (id) => trapGone.has(id),
    trapSpent: (id) => spentIds.has(`trap:${id}`), enemyOf, reveals: () => revealsThisTurn, lifeOf, view: (id) => view.get(id),
  };
  const springTrap = (tp, victim) => {
    if (spentIds.has(`trap:${tp.id}`)) return;
    spentIds.add(`trap:${tp.id}`); trapsSpent.push({ owner: tp.owner, id: tp.id, victim, effect_id: tp.effect_id, mode: tp.mode, trigger: tp.trigger, holder: tp.holder || null, card_id: tp.card_id || null });
    let d = 0;
    applyHookRecords(effectHook('trap_spring', trapHookCtx, { trap: tp, victim }), {
      bless: () => {
        const ans = blessAnswer(victim, tp.owner, tp.effect_id);
        blessUsed.add(victim); blessFired.push({ holder: victim, caster: tp.owner, effect_id: tp.effect_id, perm: ans?.perm ?? null, spend: ans ? ans.spend : null });
        if (victim === PEER_ID_STRING || tp.owner === PEER_ID_STRING) log(`[${PEER_LABEL}] Blessing ∀ of ${victim.slice(0, 8)} negates the ${tp.effect_id} trap — the second Blessing is spent`);
      },
      damage: (x) => {
        d = x.amount;
        if (d > 0 && absorbedByShieldToken(victim)) d = 0;
        if (d > 0) addDmg(victim, tp.owner, d, 'effect', `${tp.owner === 'world' ? (tp.dungeon ? 'dungeon trap' : `hidden trap in ${tp.building || 'a building'}`) : 'trap'} ${data.effects[tp.effect_id]?.name || tp.effect_id}`);
      },
      afflict: (x) => { afflictionsOut.push({ on: x.on, effect_id: x.effect_id, by: x.by }); },
      perm_add: (x) => { permanentsToAdd.push(x.id); },
    });
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
  // ---- Buildings created by a class (user rulings 2026-11-14) — one helper for the Animator and the Priest ----
  // A site is free when it is walkable and holds no feature of its own (building, dungeon, tree, labyrinth wall —
  // created ones included), no obstacle, no standing fortress, no living unit after this action's moves and no
  // other building raised this action. createBuilding() → classAbilityOut.builds; the creator applies it as
  // the world edit `made:q,r` (world_edits_json) and every peer folds it in from the next resolution on
  // (syncPlacedBuildings → features.js overlay → featureAt / buildingBonusAt / renderer).
  const buildClaimed = new Set();
  const buildSiteFree = (t) => hexWalkableAt(MAP_SEED, t.q, t.r) && !buildingFeatureAt(MAP_SEED, t.q, t.r) && !obstacleAt(t.q, t.r) && !labyrinthBlocks(t.q, t.r)
    && !occupantAt(t.q, t.r) && !buildClaimed.has(`${t.q},${t.r}`);
  const createBuilding = (r, me, { made, range, picked, why, max_standing = null }) => {
    const v = view.get(me), here = { q: v.tile_q, r: v.tile_r };
    const site = buildSite({ here, range, picked, okTile: (t) => buildSiteFree(t), salt: `${r.salt || ''}:${why}:${hg.action}`, sha: sha256Hex });
    if (!site) return null;
    buildClaimed.add(`${site.dest.q},${site.dest.r}`);
    classAbilityOut.builds.push({ by: me, q: site.dest.q, r: site.dest.r, made, why, random: site.random, ...(max_standing ? { max_standing } : {}) });
    return site;
  };
  const libraryCardFor = (salt) => { const lib = effCtx.library(); return lib.length ? lib[parseInt(sha256Hex(salt).slice(0, 8), 16) % lib.length] : null; };
  // ---- Rogue / Cleric trap helpers (user rulings 2026-11-14; pure parts in class-traps.mjs) ----
  const classStanding = (id, cls) => { const cs = classStateOf(id); return lifeOf(id) > 0 && cs.class_id === cls && !cs.archived && hasPerm(id, cls); };
  const hexD = (a, b) => hexDistance({ tile_q: a.q, tile_r: a.r }, { tile_q: b.q, tile_r: b.r });
  const hexesWithin = (c, R) => { const out = []; for (let dq = -R; dq <= R; dq++) for (let dr = Math.max(-R, -dq - R); dr <= Math.min(R, -dq + R); dr++) out.push({ q: c.q + dq, r: c.r + dr }); return out; };
  // World traps still armed on (q, r) — a building's hidden one, an unexplored dungeon's — as records owned by 'world'.
  const worldTrapsOn = (q, r) => {
    const out = [];
    const wt = worldTrapAt(q, r);
    if (wt && !worldEditsNow.has(wt.id) && !spentIds.has(`trap:${wt.id}`)) out.push({ ...wt, owner: 'world' });
    const dg = dungeonAt(MAP_SEED, q, r);
    if (dg && !spentIds.has(`trap:${dg.id}`)) {
      const ed = worldEditsNow.get(dg.id);
      const tp = dungeonExplored(ed, hg.turn) ? null : dungeonTrap(dg, Number.isInteger(ed?.explored) ? ed.explored : 'first');
      if (tp) out.push({ ...tp, owner: 'world' });
    }
    return out;
  };
  const buildingTileAt = (q, r) => { const f = buildingFeatureAt(MAP_SEED, q, r); return !!dungeonAt(MAP_SEED, q, r) || (!!f && f.kind !== 'wall' && !f.blocking); };
  // A Cleric disables a trap: it springs nowhere; `mode` 'active' → card to the owner's discard (world: gone),
  // 'passive' → card to the Cleric's discard (applied in doResolution's trapsSpent loop).
  const disableTrap = (tp, cleric, mode) => {
    const route = clericRoute(tp, cleric, mode);
    trapGone.add(tp.id); spentIds.add(`trap:${tp.id}`);
    trapsSpent.push({ owner: tp.owner, id: tp.id, victim: route.victim, effect_id: tp.effect_id, mode: tp.mode, trigger: tp.trigger, holder: tp.holder || null, card_id: tp.card_id || null, library: !!tp.library, disabled: true, cleric_mode: mode, by: cleric, to: route.to });
    if (cleric === PEER_ID_STRING || tp.owner === PEER_ID_STRING) log(`[${PEER_LABEL}] cleric ${cleric.slice(0, 8)} ${mode}: ${tp.owner === 'world' ? (tp.dungeon ? 'dungeon' : 'building') : tp.owner.slice(0, 8)} trap ${tp.effect_id} at (${tp.q},${tp.r}) disabled → ${route.to ? `${route.to.slice(0, 8)}'s discard pile` : 'gone'}`);
    if (cleric === PEER_ID_STRING && entity.classId) log(classEventLine(entity.classId, `disable_${mode}`));
    return `${tp.effect_id}@${tp.q},${tp.r}`;
  };
  const disableTrapsNear = (me, here, R) => {
    const laid = trapsInRange(allTraps.filter(tp => tp.owner !== me && !trapGone.has(tp.id) && !spentIds.has(`trap:${tp.id}`)), here, R, hexD);
    const world = trapsInRange(hexesWithin(here, R).flatMap(h => worldTrapsOn(h.q, h.r)), here, R, hexD);
    return [...laid, ...world].map(tp => disableTrap(tp, me, 'active'));
  };
  // ---- Engine-resolved ability requests (class isolation phase 3, 2026-11-20; user ruling #1: a class chooses from a
  // fixed set of engine placement / ability results). A class program returns one in its ability `out` (class-engine.mjs
  // ABILITY_REQUESTS) and gives only the numbers (its data); the engine does the geometry, occupancy and the move
  // register exactly as the class code these replace (Animator / Priest / Seeker / Cleric / Warrior, user rulings
  // 2026-11-14). A request that finds nothing leaves the ability ready (no use) — except far_trap finding no hex.
  //   copy_building {near, place}  the building nearest to me within `near` (distance, q, r; a broken fortress no longer
  //                    counts) is copied — same look, same bonus — onto the hex I picked within `place`, else a random
  //                    free one (salt hash). Nothing near / no free hex → stays ready.
  //   build {label, power, heal, place, max_standing}  a building of that power (mend: +heal life at the end of the
  //                    turn's 3rd action, never above the maximum; no stat bonus) on the picked / a random free hex within
  //                    `place`; at most max_standing of mine stand (the oldest go). No free hex → stays ready.
  //   far_trap {min, max, radius, turns, max_standing}  the effect card I attached becomes a trap building on a random
  //                    walkable hex min..max away (pure map functions, so unrevealed land counts; no unit, obstacle,
  //                    labyrinth wall, fortress or other trap there), hashed from the reveal salt; it springs on whoever
  //                    steps there ('enter', damage); I see `radius` around it until the end of turn + turns. No card →
  //                    stays ready; no hex → the use is spent, nothing laid.
  //   disable_traps {radius}  every trap within radius that is not mine is disabled ('active': a laid trap's card to its
  //                    owner's discard pile, a building's / dungeon's trap simply gone). None → stays ready.
  //   step {n}         the adjacent ally I pointed at (else me) steps n hexes toward the picked tile, when that unit has
  //                    not moved this action and the hex is free (no unit, obstacle, labyrinth wall). Otherwise no use.
  const clsShort = (id) => String(id).replace(/^class_/, '');
  const clsName = (id) => data.classes[id]?.name || clsShort(id);
  const reqInt = (v, d, lo = 1) => (Number.isInteger(v) && v >= lo ? v : d);
  const mineLog = (me, cls, s) => { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class ${clsShort(cls)}: ${s}`); };
  const ABILITY_REQUEST_FNS = {
    copy_building: (r, ab, rq) => {
      const me = r.actor, cls = ab.id, near = reqInt(rq.near, 2), place = reqInt(rq.place, 1);
      const v = view.get(me), here = { q: v.tile_q, r: v.tile_r };
      const cands = discAround(here, near).map(h => ({ ...h, f: buildingFeatureAt(MAP_SEED, h.q, h.r) }))
        .filter(h => isBuildingFeature(h.f) && !(fortressAt(MAP_SEED, h.q, h.r) && !fortressAt(MAP_SEED, h.q, h.r, worldEditsNow)));
      const src = nearestBuilding(cands, here, near);
      if (!src) return mineLog(me, cls, `no building within ${near} hexes — nothing to copy, the ability stays ready`);
      const site = createBuilding(r, me, { made: copyMade(src.f, src.q, src.r, cls), range: place, picked: abilityTile(ab), why: clsShort(cls) });
      if (!site) return mineLog(me, cls, `no free hex within ${place} of me for the copy of the ${src.f.label} — the ability stays ready`);
      useAbility(r, `a copy of the ${src.f.label} at (${src.q},${src.r}) rises at (${site.dest.q},${site.dest.r})${site.random ? ' — a random free hex next to me' : ''}`);
    },
    build: (r, ab, rq) => {
      const me = r.actor, cls = ab.id;
      const cfg = { label: typeof rq.label === 'string' && rq.label ? rq.label : 'Shrine', power: typeof rq.power === 'string' && rq.power ? rq.power : 'mend', heal: reqInt(rq.heal, 1), place: reqInt(rq.place, 2) };
      const sprite = catalogSpriteFor(new RegExp(`^${cfg.label.replace(/[^\w ]/g, '.')}$`, 'i')) || catalogSpriteFor(/shrine/i);
      const site = createBuilding(r, me, { made: shrineMade(cfg, sprite, cls, clsName(cls)), range: cfg.place, picked: abilityTile(ab), why: clsShort(cls), max_standing: reqInt(rq.max_standing, null) });
      if (!site) return mineLog(me, cls, `no free hex within ${cfg.place} of me for a ${cfg.label} — the ability stays ready`);
      useAbility(r, `a ${cfg.label} rises at (${site.dest.q},${site.dest.r})${site.random ? ' — a random free hex near me' : ''}`);
    },
    far_trap: (r, ab, rq) => {
      const me = r.actor, cls = ab.id, v = view.get(me), here = { q: v.tile_q, r: v.tile_r };
      const pair = Number.isInteger(rq.min) && Number.isInteger(rq.max) && rq.min >= 1 && rq.min <= rq.max;
      const dmin = pair ? rq.min : 20, dmax = pair ? rq.max : 30, vr = reqInt(rq.radius, 5, 0), vturns = reqInt(rq.turns, 1, 0);
      if (!ab.attach?.effect_id || !Array.isArray(ab.attach.elements) || !ab.attach.elements.length) return mineLog(me, cls, 'pick an effect card from my hand first');
      const key = ab.attach.effect_id;
      const occupied = new Set([...view.keys()].filter(id => lifeOf(id) > 0).map(id => { const t = postTile(id); return t ? `${t.tile_q},${t.tile_r}` : ''; }));
      const pick = tileInRing(here, { min: dmin, max: dmax, seed: MAP_SEED, salt: `${r.salt || ''}:${clsShort(cls)}:${hg.action}`, occupied,
        isBlocked: (q, rr) => !hexWalkableAt(MAP_SEED, q, rr) || !!obstacleAt(q, rr) || labyrinthBlocks(q, rr) || allTraps.some(t => t.q === q && t.r === rr) || classAbilityOut.traps.some(t => t.q === q && t.r === rr) });
      if (!pick) { useAbility(r, `${ab.attach.name || key} finds no walkable hex ${dmin}–${dmax} hexes away`); return; }
      const ms = reqInt(rq.max_standing, null);
      classAbilityOut.traps.push({ by: me, q: pick.q, r: pick.r, effect_id: key, elements: [...ab.attach.elements], card_id: ab.attach.card_id || null, library: true, power: TRAP_POWER, trigger: 'enter', mode: 'damage', holder: null, vision: { radius: vr, until_turn: hg.turn + vturns }, made_by: cls, ...(ms ? { max_standing: ms } : {}) });
      useAbility(r, `${ab.attach.name || key} lies as a trap building at (${pick.q},${pick.r}), ${hexDist(here, pick)} hexes away — in my sight (radius ${vr}) until the end of turn ${hg.turn + vturns}`);
    },
    disable_traps: (r, ab, rq) => {
      const me = r.actor, cls = ab.id, v = view.get(me), here = { q: v.tile_q, r: v.tile_r }, R = reqInt(rq.radius, 3, 0);
      const got = disableTrapsNear(me, here, R);
      if (!got.length) return mineLog(me, cls, `no trap within ${R} hexes — the ability stays ready`);
      useAbility(r, `${got.length} trap(s) disabled: ${got.join(', ')}`);
    },
    step: (r, ab, rq) => {
      const me = r.actor, cls = ab.id, tile = abilityTile(ab), peer = abilityPeer(ab), n = reqInt(rq.n, 1);
      const nearAlly = peer && peer !== me && lifeOf(peer) > 0 && distBetween(me, peer) <= 1 && !enemyOf(me, peer) ? peer : null;
      const who = nearAlly || me;
      if (!tile || nextTiles.has(who)) return mineLog(me, cls, `${who === me ? 'I' : who.slice(0, 8)} already moved / no tile picked`);
      const wv = view.get(who);
      const dest = stepsAlong(who, { q: wv.tile_q, r: wv.tile_r }, { q: tile.q, r: tile.r }, n);
      const takenBy = [...view.values()].some(o => o?.peer_id && o.peer_id !== who && lifeOf(o.peer_id) > 0 && (() => { const t = postTile(o.peer_id); return t.tile_q === dest.q && t.tile_r === dest.r; })()) || [...nextTiles.values()].some(t => t.q === dest.q && t.r === dest.r);
      if ((dest.q === wv.tile_q && dest.r === wv.tile_r) || takenBy || obstacleBlocks(who, dest.q, dest.r) || labyrinthBlocks(dest.q, dest.r)) return mineLog(me, cls, `no free step toward (${tile.q},${tile.r})`);
      nextTiles.set(who, dest); journeyResults.set(who, { outcome: 'complete', q: dest.q, r: dest.r, action: clsShort(cls) });
      classAbilityOut.moves.push({ who, by: me, q: dest.q, r: dest.r });
      useAbility(r, `${who === me ? 'I step' : `${who.slice(0, 8)} steps`} to (${dest.q},${dest.r})`);
    },
  };
  // Post pass (phase 'post' abilities, sorted reveals): every one through its class's ability hook (C1); the
  // map-bound ones answer with the requests above.
  for (const r of revealsThisTurn) {
    const ab = abilityOf(r);
    if (ab && CLASS_RULES[ab.id]?.phase === 'post') classAbility(r, ab, ABILITY_REQUEST_FNS);
  }
  // NPC builders (AI skirmish 2026-11-22): a live unit whose snapshot says ai_role 'builder' and that played a plain
  // Posture / Empty Posture with a `build` intent raises a Barricade (an impassable wall) on the hex it named next to
  // it — else on a random free hex next to it (reveal salt), nothing if none is free. Same createBuilding pipeline as
  // the Animator / Priest: the builder records `made:q,r`, every peer folds it in from the next resolution on.
  for (const r of revealsThisTurn) {
    if (!r.build || r.proxied || (r.action !== 'P' && r.action !== 'EP') || r.effect) continue;
    const me = r.actor;
    if (view.get(me)?.ai_role !== 'builder' || lifeOf(me) <= 0) continue;
    const picked = Number.isInteger(r.build.q) && Number.isInteger(r.build.r) ? { q: r.build.q, r: r.build.r } : null;
    const site = createBuilding(r, me, { made: barricadeMade(), range: 1, picked, why: 'builder' });
    if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] npc builder: ${site ? `a Barricade rises at (${site.dest.q},${site.dest.r})${site.random ? ' — a random free hex next to me' : ''}` : 'no free hex next to me — nothing built'}`);
  }
  for (const e of elementalistPending) {
    if (!effectOutcomes.some(x => x.actor === e.actor && !x.bonus && !x.channel && x.oc.status === 'done' && (x.oc.hits || []).length)) continue;
    // CR: elementalist — once per ACTION (2026-11-17): a perAction class is never marked used for the turn
    const elemPerAction = !!CLASS_RULES[e.cls]?.perAction;
    if (!elemPerAction) classAbilityOut.used.push({ actor: e.actor, class_id: e.cls });
    if (e.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] class ${clShort(e.cls)}: an extra ${e.stat} die ${e.value} [${e.dice.join(',')}] rides on the damage cast — once this ${elemPerAction ? 'action' : 'turn'}`);
  }
  // Transmuter (static): a nearby ally's completed cast of stat tokens / heals works on the Transmuter too.
  for (const id of [...view.keys()].sort()) {
    const tc = classOf(id);
    if (lifeOf(id) <= 0 || !CL_TRANSMUTERS.includes(tc)) continue;
    // C1 transmute: edits by outcome index (the hook never mutates; the copies are pushed here).
    const tr = classHook('transmute', tc, clCtx, { id, outcomes: effectOutcomes.map(({ actor, oc }) => ({ actor, status: oc.status, statTokens: oc.statTokens, heals: oc.heals })) });
    for (const e of tr.edits) { const { oc } = effectOutcomes[e.i]; oc.statTokens.push(...e.statTokens); oc.heals.push(...e.heals); }
    for (const s of tr.log) log(s);
    if (tr.edits.length && id === PEER_ID_STRING) log(classEventLine(tc, 'transmute'));   // log only (user 2026-11-23)
  }
  // Restaurateur (static): a token destroyed by a Restaurateur is taken instead (same tile / into their holding).
  for (const d of destroyOutcomes) {
    const res = classHook('destroy_result', classOf(d.actor), clCtx, { d });   // C1 destroy_result (Restaurateur: destroyed → taken)
    if (res === d.result) continue;
    d.result = res; if (d.actor === PEER_ID_STRING || d.owner === PEER_ID_STRING) log(`[${PEER_LABEL}] restaurateur ${d.actor.slice(0, 8)} takes the ${d.kind} token instead of destroying it`);
    if (d.actor === PEER_ID_STRING) log(classEventLine(classOf(d.actor), 'take_tokens'));   // log only (user 2026-11-23)
  }
  // Prophet (user rework #2 2026-11-14) is a look, not an outcome: requestHand() at its first contact of the turn,
  // on the Prophet's peer after the resolution (doResolution), outside the state hash. Avenger: the lure case above.
  // Priest (user rework 2026-11-14 #2): a Shrine — the `build` ability request above (phase 3).
  // Rogue (passive, user ruling 2026-11-14 — supersedes 2026-11-12's single charge): two separate charges per
  // turn (class data trap_dodges_per_turn / threat_dodges_per_turn, 1 each).
  //  - trap charge: a step that would spring a trap (a laid enter-trap, a building's hidden one; an unexplored
  //    dungeon at the turn's 3rd action, below) springs nothing — the trap stays armed where it is.
  //  - threat charge: the first step that ends inside an enemy's threat ring (threat_radius, 2) is unseen —
  //    monsters / NPC enemies neither wake nor chase ("chain") the Rogue for the rest of the turn (stealth_turn).
  // Cleric (passive, user ruling 2026-11-14): a step onto a building tile with trap(s) springs none of them —
  // no damage, no effect — and every one of those trap cards joins the Cleric's discard pile.
  // Phase 4: the charges are the stepping class's (chargeCfgOf: its config), kept in that class's namespace.
  const stepCfgMemo = new Map();
  const stepCfg = (cls) => { if (!stepCfgMemo.has(cls)) stepCfgMemo.set(cls, chargeCfgOf(cls)); return stepCfgMemo.get(cls); };
  const rogueTrapUses = new Map();      // trap-charge uses per Rogue in this simulate (on top of the snapshot's count)
  // CR: rogue_shared — one shared charge per turn (2026-11-17): a used threat charge empties the trap charge and back
  const csWho = (who) => (who === PEER_ID_STRING ? entity.classStore : csOf(view.get(who)));   // phase 2: class state of a revealer
  const rogueThreatUsed = (who, cls) => CS.chargeTurn(csWho(who), cls, 'threat') === hg.turn || classAbilityOut.stealth.includes(who);
  const rogueTrapRaw = (who, cls) => {
    return CS.chargeLeft(csWho(who), cls, 'trap', stepCfg(cls).trapPerTurn, hg.turn);
  };
  const rogueTrapLeft = (who, cls) => {
    if (stepCfg(cls).shared && rogueThreatUsed(who, cls)) return 0;
    const left = rogueTrapRaw(who, cls);
    return left - (rogueTrapUses.get(who) || 0);
  };
  const rogueSpendTrap = (who, cls, what, q, r) => {
    rogueTrapUses.set(who, (rogueTrapUses.get(who) || 0) + 1); classAbilityOut.rogueTrap.push(who);
    if (who === PEER_ID_STRING) { log(`[${PEER_LABEL}] class ${clShort(cls)}: trap charge — ${what} at (${q},${r}) stays shut (${rogueTrapLeft(who, cls)} left this turn)`); log(classEventLine(cls, 'trap_charge')); }
  };
  const rogueThreatReady = (who, cls) => stepCfg(cls).threatPerTurn > 0 && CS.chargeTurn(csWho(who), cls, 'threat') !== hg.turn && !classAbilityOut.stealth.includes(who)
    && !(stepCfg(cls).shared && (rogueTrapRaw(who, cls) < stepCfg(cls).trapPerTurn || (rogueTrapUses.get(who) || 0) > 0));   // CR: rogue_threat — not after the shared charge went on a trap
  const foesInRing = (who, t, cls) => [...view.keys()].filter(o => o !== who && lifeOf(o) > 0 && enemyOf(who, o) && (() => { const pt = postTile(o); return !!pt && hexDistance({ tile_q: t.q, tile_r: t.r }, pt) <= stepCfg(cls).threatRadius; })()).sort();
  for (const [who, t] of [...nextTiles.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const before = view.get(who);
    if (!before || lifeOf(who) <= 0 || (before.tile_q === t.q && before.tile_r === t.r)) continue;
    const laid = effectHook('trap_enter', trapHookCtx, { who, q: t.q, r: t.r });   // MV: trap_enter — enemy 'enter' traps here, not lifted / spent
    const wt = before.character_id ? worldTrapAt(t.q, t.r) : null;
    const wtrap = wt && !worldEditsNow.has(wt.id) && !spentIds.has(`trap:${wt.id}`) ? wt : null;
    // C1 step: the mover's standing class (Rogue: threat + trap charges; Cleric: building traps disabled).
    const sc = CL_STEPPERS.find(c => classStanding(who, c)) || null;
    const ring = sc ? foesInRing(who, t, sc) : [];
    const st = classHook('step', sc, clCtx, { threatReady: !!sc && rogueThreatReady(who, sc), ring, trap: laid.length > 0 || !!wtrap, wtrap: !!wtrap, building: !!buildingTileAt(t.q, t.r), trapLeft: sc ? rogueTrapLeft(who, sc) : 0 });
    if (st.stealth) { classAbilityOut.stealth.push(who); if (who === PEER_ID_STRING) log(`[${PEER_LABEL}] class ${clShort(sc)}: threat charge — unseen inside the threat ring of ${ring.map(o => o.slice(0, 8)).join(', ')} at (${t.q},${t.r}); no monster wakes or chases me this turn`); if (who === PEER_ID_STRING) log(classEventLine(sc, 'threat_charge')); }
    if (st.trap === 'none') continue;
    if (st.trap === 'dodge') { rogueSpendTrap(who, sc, wtrap ? `the hidden trap in ${wtrap.building || 'the building'}` : `${laid.length} trap(s)`, t.q, t.r); continue; }
    if (st.trap === 'disable') {
      for (const tp of [...laid, ...(wtrap ? [{ ...wtrap, owner: 'world' }] : [])]) disableTrap(tp, who, 'passive');
      continue;
    }
    for (const tp of laid) springTrap(tp, who);
    if (wtrap) springTrap({ ...wtrap, owner: 'world' }, who);
  }
  // Dungeons (user ruling 2026-11-12): the hero who ends the turn's 3rd action in an unexplored one explores
  // it — its trap springs on them (one hero per dungeon: the lowest peer id), the dungeon stays explored
  // for 5 turns (world edit `dng:q,r` { explored }), then re-arms with a new trap.
  if (hg.round === ROUNDS_PER_TURN - 1) {
    const done = new Set();
    for (const id of [...view.keys()].sort()) {
      const t = postTile(id);
      if (!view.get(id)?.character_id || lifeOf(id) <= 0 || !t) continue;
      const dg = dungeonAt(MAP_SEED, t.tile_q, t.tile_r);
      if (!dg || done.has(dg.id)) continue;
      const ed = worldEditsNow.get(dg.id);
      if (dungeonExplored(ed, hg.turn) || spentIds.has(`trap:${dg.id}`)) continue;
      const tp = dungeonTrap(dg, Number.isInteger(ed?.explored) ? ed.explored : 'first');
      // Rogue trap charge: the dungeon's trap stays shut (the dungeon stays unexplored; the next hero there still springs it).
      const dc = CL_STEPPERS.find(c => classStanding(id, c)) || null;   // C1 dungeon_step (Rogue dodge / Cleric disable)
      const how = classHook('dungeon_step', dc, clCtx, { trap: !!tp, trapLeft: dc ? rogueTrapLeft(id, dc) : 0 });
      if (how === 'dodge') { rogueSpendTrap(id, dc, `the ${dg.source || 'dungeon'}'s trap`, dg.q, dg.r); continue; }
      done.add(dg.id);
      // Cleric passive: the dungeon is explored without the trap springing — its card joins the Cleric's discard pile.
      if (how === 'disable') { disableTrap({ ...tp, owner: 'world' }, id, 'passive'); continue; }
      if (tp) springTrap({ ...tp, owner: 'world' }, id);
    }
  }
  // Teleport buildings (user ruling 2026-11-12): a hero whose step ends on one is sent on to the first free
  // hex of the building's fixed target list (no unit, wall, obstacle or fortress there after the moves).
  {
    const taken = new Set([...view.keys()].filter(id => lifeOf(id) > 0).map(id => { const t = postTile(id); return t ? `${t.tile_q},${t.tile_r}` : ''; }));
    for (const [who, t] of [...nextTiles.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const before = view.get(who);
      if (!before?.character_id || lifeOf(who) <= 0 || (before.tile_q === t.q && before.tile_r === t.r) || buildingPowerAt(t.q, t.r)?.kind !== 'teleport') continue;
      const dest = teleportTargets(MAP_SEED, t.q, t.r).find(x => !taken.has(`${x.q},${x.r}`) && !labyrinthBlocks(x.q, x.r) && !obstacleAt(x.q, x.r));
      if (!dest) continue;
      taken.delete(`${t.q},${t.r}`); taken.add(`${dest.q},${dest.r}`);
      nextTiles.set(who, { q: dest.q, r: dest.r });
      log(`[${PEER_LABEL}] ${who.slice(0, 8)} steps into the teleport at (${t.q},${t.r}) and comes out at (${dest.q},${dest.r})`);
    }
  }
  // MV: trap_targeted — an enemy declaring a trap's owner (standing on it) as target springs it.
  applyHookRecords(effectHook('trap_targeted', trapHookCtx, {}), { spring: (x) => springTrap(x.trap, x.victim) });
  for (const { actor, eff, oc } of effectOutcomes) {
    if (oc.status !== 'done') continue;
    for (const pm of oc.permanents) if (pm.on === PEER_ID_STRING) permanentsToAdd.push(pm.id);
    // The holdings below are MY state: only the real run writes them (a quiet counterfactual replay must not lay a second trap).
    // MV: channel_land / trap_lay — the channels my cast registers (a new Blessing replaces the effect under the old one,
    // its card → discard) and the traps it lays (card → holding, face down), as records on MY holdings.
    if (!quiet) {
      applyHookRecords(effectHook('channel_land', {}, { channels: oc.channels || [], mine: entity.channels, self: PEER_ID_STRING, turn: hg.turn, action: hg.action }), {
        release_card: (x) => releaseHeldCard(x.card_id),
        channels: (x) => { entity.channels = x.list; },
        hold_card: (x) => { holdCard(x.card_id); console.log(`[${PEER_LABEL}] ${x.effect_id} is blessed — it fires every action while the Blessing stands`); },
      });
      applyHookRecords(effectHook('trap_lay', {}, { traps: oc.traps || [], self: PEER_ID_STRING, action: hg.action, count: entity.traps.length }), {
        add_trap: ({ trap: tp }) => {
          entity.traps.push(tp);
          if (tp.card_id) holdCard(tp.card_id);
          console.log(`[${PEER_LABEL}] trap ${tp.effect_id} laid at (${tp.q},${tp.r}) [${tp.trigger}/${tp.mode}]`);
          _autosave?.markDirty();
        },
      });
    }
    for (const ob of oc.obstacles || []) if (ob.by === PEER_ID_STRING && !quiet) {
      entity.obstacles.push({ id: `${PEER_ID_STRING.slice(-8)}#${hg.action}#ob${entity.obstacles.length}`, q: ob.q, r: ob.r, hp: ob.hp, elem: ob.elem });
      console.log(`[${PEER_LABEL}] creation: Earth obstacle (${ob.hp} hp) at (${ob.q},${ob.r})`);
      _autosave?.markDirty();
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
      const shieldSkill = permsOf(defId).find(p => SKILL_RULES[p]?.effectShield) || null;   // skill isolation: the defender's effect shield (flags.effectShield)
      let shield = skillHook('effect_in', shieldSkill, skCtx, { defender: defId });   // S1 effect_in
      let spent = 0;
      const legs = hit.legs.map(l => ({ ...l }));
      let dmg = 0;
      const zoned = !EFFECT_RULES[eff.effect_id]?.ignoresZones && untouchable(defId, actor, EFFECT_RULES[eff.effect_id]?.scope === 'everyone');
      if (!quiet && defId !== actor && hidingPerm(permsOf(defId)) && EFFECT_RULES[eff.effect_id]?.scope === 'everyone') log(`[${PEER_LABEL}] invisibility: ${defId.slice(0, 8)} is caught in ${actor.slice(0, 8)}'s ${eff.effect_id} (area hits the invisible)`);
      // The token lands where the target stood; a target that moved off this
      // action is not burned — the token stays on that tile instead.
      const after = postTile(defId);
      const movedOff = after.tile_q !== defV.tile_q || after.tile_r !== defV.tile_r;
      for (const tk of oc.tokens) if (tk.kind === 'fire' && tk.q === defV.tile_q && tk.r === defV.tile_r) tk.consumed = !movedOff;
      for (const leg of legs) {
        if (leg.kind === 'token' && movedOff) { leg.dealt = 0; continue; }
        let sum = leg.sum;
        if (shield) { const fs = skillHook('effect_leg', shieldSkill, skCtx, { shield, sum }); if (fs.spent) spent = fs.spent; shield = fs.shield; sum = fs.sum; }   // S1 effect_leg
        let d = roundHalfUp10(sum);
        if (d > 0 && zoned) d = 0;
        if (d > 0 && absorbedByShieldToken(defId)) d = 0;
        leg.dealt = d;
        dmg += d;
      }
      const effName = data.effects[eff.effect_id]?.name || eff.effect_id;
      if (dmg > 0 && natBlocked(actor, defId)) dmg = 0;
      if (dmg > 0) dmg = skillHook('defend_in', null, skCtx, { code: 'effect', defender: defId, dmg, byActor });   // SKR-06 Sanctuary: no effect damage either
      if (dmg > 0) addDmg(defId, actor, dmg, 'effect', effName);
      if (dmg > 0 && hit.selfDamageEqual) addDmg(actor, actor, dmg, 'effect', `${effName} (it hurts its caster too)`);
      if (dmg > 0 && hit.healDealt) oc.heals.push({ on: actor, amount: dmg });
      if (spent && defId === PEER_ID_STRING && shieldSkill && !brokenShield.includes(shieldSkill)) brokenShield.push(shieldSkill);   // the spent shield's id(s)
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
    const warder = [...view.values()].filter(v => v?.peer_id && v.peer_id !== victim && (v.life ?? 0) > 0 && permsOf(v.peer_id).some(p => EFFECT_RULES[p]?.resurrect) && csvSet(v.wards_csv).has(victim)).map(v => v.peer_id).sort()[0];
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
  return { damage, nextTiles, journeyResults, vetoed, brokenShield, permanentsToAdd, lifestealForMe, byActor, codeVs, effectOutcomes, tokensSpent, counterPen, roundZones, destroyOutcomes, disableTriggers, wardFired, trapsSpent, afflictionsOut, obstacleHits, channelsBroken, relocations, blessFired, classOutcomes, classAbilityOut, skillFx };
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
  const allowanceOf = (id) => { const perms = id === PEER_ID_STRING ? [...entity.permanents] : String(view.get(id)?.permanents_csv || '').split(','); return planSum(bonusPerms(perms)); };
  if (clRes) clPeer.suspend(clRes);   // CH: the dormant foreign classes sit out the bonus runs and the action (resumed right after)
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
  const real = (() => { try { return simulate(revealsThisTurn, quiet); } finally { if (clRes) clPeer.resume(); } })();   // CH: resume the dormant classes
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
    for (const id of b.res.brokenShield) if (!real.brokenShield.includes(id)) real.brokenShield.push(id);
    real.lifestealForMe.amount += b.res.lifestealForMe.amount;
    real.disableTriggers.unshift(...b.res.disableTriggers);
    real.wardFired.unshift(...b.res.wardFired);
    real.trapsSpent.unshift(...b.res.trapsSpent); real.afflictionsOut.unshift(...b.res.afflictionsOut); real.obstacleHits.unshift(...b.res.obstacleHits); real.channelsBroken.unshift(...b.res.channelsBroken); real.relocations.unshift(...b.res.relocations); real.blessFired.unshift(...b.res.blessFired); real.classOutcomes.unshift(...b.res.classOutcomes); for (const k of Object.keys(real.classAbilityOut)) real.classAbilityOut[k].unshift(...(b.res.classAbilityOut[k] || []));
  }
  bonusRuns.reverse();
  real.bonusRuns = bonusRuns;
  return real;
  };
  // Manipulator (passive, once per turn — user ruling 2026-11-14, class-manipulator.mjs): a quiet probe of the
  // round shows who is about to take combat damage; a ready Manipulator among them forces a random enemy
  // within range that committed a `manip_alt` to swap its action for it, and the round is resolved again.
  // Inputs are reveals + reveal-carried snapshots only, actors in sorted order → the same swap on every peer.
  const manipSwaps = [];
  {
    const permsCsv = (id) => id === PEER_ID_STRING ? [...entity.permanents] : String(view.get(id)?.permanents_csv || '').split(',').filter(Boolean);
    // Phase 4: the ready class of `id` that answers combat_in (Manipulator), else null.
    const manipClassOf = (id) => {
      if (id === PEER_ID_STRING) return hasHook(entity.classId, 'combat_in') && !entity.classArchived && entity.permanents.has(entity.classId) && entity.classUsedTurn !== hg.turn ? entity.classId : null;
      const v = view.get(id) || {};
      return hasHook(v.class_id, 'combat_in') && !v.class_archived && permsCsv(id).includes(v.class_id) && (typeof v.class_used_turn === 'number' ? v.class_used_turn : -1) !== hg.turn ? v.class_id : null;
    };
    const manipReady = (id) => !!manipClassOf(id);
    const sideId = (id) => { const v = view.get(id); return v ? sideOf(v.alliance) : null; };
    const distId = (a, b) => { const pa = view.get(a), pb = view.get(b); return pa && pb ? hexDistance({ tile_q: pa.tile_q, tile_r: pa.tile_r }, { tile_q: pb.tile_q, tile_r: pb.tile_r }) : Infinity; };
    const CL_EMITTERS = clWith('emits');   // C1 emits site manip: Reaver A, Monk M / EM (held permanents)
    const emitsFor = (id) => (c) => c === 'P' || c === 'EP' || CL_EMITTERS.some(k => permsCsv(id).includes(k) && classHook('emits', k, CL_BASE, { code: c, site: 'manip' }));
    const proxied = new Set(revealsThisTurn.map(r => r.proxy?.for).filter(Boolean));
    const manips = revealsThisTurn.filter(r => manipReady(r.actor) && lifeOf(r.actor) > 0).map(r => r.actor).sort();
    if (manips.length && revealsThisTurn.some(r => r.manipAlt)) {
      for (const m of manips) {
        const mc = manipClassOf(m), mcfg = classHook('config', mc, CL_BASE);
        const probe = runRound(structuredClone(revealsThisTurn), true);
        if (!classHook('combat_in', mc, CL_BASE, { list: probe.damage.get(m) })) continue;   // C1 combat_in
        const cands = revealsThisTurn.filter(r => r.manipAlt && r.actor !== m && !r.manipulated && !r.proxy && !proxied.has(r.actor)
          && sideId(r.actor) !== null && sideId(m) !== null && sideId(r.actor) !== sideId(m) && distId(m, r.actor) <= mcfg.range).map(r => r.actor);
        const mSalt = revealsThisTurn.find(r => r.actor === m)?.salt || '';
        const on = classHook('pick_target', mc, CL_BASE, { seed: `${mSalt}:${clShort(mc)}:${hg.turn}.${hg.round}`, cands });   // C1 pick_target
        if (!on) continue;
        let sw = null;
        for (const list of [revealsThisTurn, pristineReveals]) { const r = list.find(x => x.actor === on); if (r) { const s = applyManipSwap(r, r.manipAlt, emitsFor(on)); if (list === revealsThisTurn) sw = s; } }
        manipSwaps.push({ by: m, on, old: sw.old, new: sw.new });
        console.log(`[${PEER_LABEL}] ${clShort(mc)}: ${m.replace('peer:', '').slice(0, 12)} forces ${on.replace('peer:', '').slice(0, 12)} to swap ${sw.old}→${sw.new}`);
        console.log(classEventLine(mc, 'swap'));
      }
    }
  }
  const real = runRound(revealsThisTurn, false);
  const viewReal = viewSnap(), bonusDmgReal = bonusDmgToMe;
  // SKR-07 Disruption Move: my emission was voided (I played an Empty Move) — nothing went out; my cast is interrupted
  // (Rule 19, as when the Manipulator swaps a cast away below).
  {
    const mine = revealsThisTurn.find(r => r.actor === PEER_ID_STRING);
    if (myLastReveal?.effectCardId && mine?.noEmit && !mine.effect) {
      console.log(`[${PEER_LABEL}] disrupted: my ${myLastReveal.effectId} emitted nothing — the cast is interrupted`);
      myLastReveal.effectId = null; myLastReveal.effectCardId = null; myLastReveal.effectCardId2 = null; myLastReveal.chain = null;
    }
  }
  // Manipulator bookkeeping on the two peers concerned: mine is spent for the turn; a swapped action of mine
  // goes back to my hand (with its riding skills) and the alt card is the one played.
  for (const ms of manipSwaps) {
    if (ms.by === PEER_ID_STRING && hasHook(entity.classId, 'combat_in')) { entity.classUsedTurn = hg.turn; broadcastUI({ kind: 'peek', what: 'forced', text: `${clName(entity.classId)}: ${view.get(ms.on)?.name || ms.on.slice(0, 12)} had to swap ${ms.old} for ${ms.new} (used for this turn).` }); }
    if (ms.on === PEER_ID_STRING && myLastReveal) {
      const alt = myLastReveal.manipAlt || { code: 'EP', cardId: null };
      myLastReveal.manipulated = { by: ms.by, old: ms.old, new: ms.new, oldCardId: myLastReveal.cardId };
      myLastReveal.code = ms.new; myLastReveal.trance = null; myLastReveal.cardId = alt.cardId || null; myLastReveal.optionCardIds = [alt.cardId || null, null];
      myLastReveal.skillIds = []; myLastReveal.skillNames = []; myLastReveal.skillCardIds = [];
      const mine = revealsThisTurn.find(r => r.actor === PEER_ID_STRING);
      if (myLastReveal.effectCardId && !mine?.effect) { myLastReveal.effectId = null; myLastReveal.effectCardId = null; myLastReveal.effectCardId2 = null; myLastReveal.chain = null; }
      if (!mine?.destroy) myLastReveal.destroy = null;
      broadcastUI({ kind: 'peek', what: 'forced', text: `Manipulator: your ${ms.old} returns to your hand — you play ${ms.new} from your hand instead.` });
    }
  }
  const { damage, nextTiles, journeyResults, vetoed, brokenShield, permanentsToAdd, lifestealForMe, byActor, codeVs, effectOutcomes, tokensSpent, counterPen, roundZones, destroyOutcomes, disableTriggers, bonusRuns, wardFired, trapsSpent, afflictionsOut, obstacleHits, channelsBroken, relocations, blessFired, classOutcomes, classAbilityOut } = real;
  resolvedAction = hg.action;   // from here my entity shows this action — every snapshot I publish says so (resolverBase)
  // Combo damage emission (user ruling 2026-11-05): for every actor whose
  // pre-reveal snapshot shows an active combo on its FINAL slot AND whose
  // revealed action matches the required slot code (M-slot accepts M/EM/EP/P),
  // credit 1 dmg to one adjacent live enemy (Rule 15 — lowest peer_id among
  // the nearest at hex-distance 1). The decision + victim pick are pure
  // functions of (view snapshots, this round's reveals, data/combos.json),
  // so every peer computes the same addition. Adds to the shared `damage`
  // map before the state hash is computed below, so a divergent combo call
  // would show up as a state_hash mismatch like any other damage.
  const comboDone = new Map();   // actor → combo sequence completed this action (UI icon only)
  const comboStep = new Map();   // actor → { k, of, seq } — slot k of the armed combo matched this action (UI only)
  for (const r of revealsThisTurn) {
    const actor = view.get(r.actor);
    if (!actor || !actor.combo_active) continue;
    const seq = String(actor.combo_seq_csv || '').split(',').filter(Boolean);
    if (!seq.length) continue;
    const slot = actor.combo_slot | 0;
    {
      const n = String(seq[slot] || '').toUpperCase(), pl = String(r.action || '').toUpperCase();
      const ok = n === pl || (n === 'M' && (pl === 'EM' || pl === 'EP')) || (n === 'P' && (pl === 'EM' || pl === 'EP'));
      if (ok) comboStep.set(r.actor, { k: slot + 1, of: seq.length, seq: seq.join('') });
    }
    if (slot + 1 < seq.length) continue;   // not the completion action
    const need = String(seq[slot] || '').toUpperCase();
    const played = String(r.action || '').toUpperCase();
    // User ruling 2026-11-05: EM/EP are the two faces of the Empty slot and
    // substitute for either M or P. M and P never substitute for each other.
    // A- and B-slots are strict (only their own card).
    const matches = (need === played)
      || (need === 'M' && (played === 'M' || played === 'EM' || played === 'EP'))
      || (need === 'P' && (played === 'P' || played === 'EM' || played === 'EP'));
    if (!matches) continue;
    comboDone.set(r.actor, seq.join(''));
    const here = { tile_q: actor.tile_q, tile_r: actor.tile_r };
    const actorSide = sideOf(actor.alliance);
    const victim = [...view.values()]
      .filter(v => v && v.peer_id && v.peer_id !== r.actor && (v.life ?? 0) > 0 && Number.isInteger(v.tile_q) && sideOf(v.alliance) !== actorSide && hexDistance(here, v) === 1 && !(invisibleAtReveal(v.peer_id) && !invisibleAtReveal(r.actor)))
      .sort((a, b) => a.peer_id.localeCompare(b.peer_id))[0];
    if (!victim) continue;
    const list = damage.get(victim.peer_id) || [];
    list.push({ amount: 1, attacker: r.actor, source: `combo:${seq.join('')}`, why: `combo ${seq.join('')}` });
    damage.set(victim.peer_id, list);
    console.log(`[${PEER_LABEL}] combo ${seq.join('')} by ${r.actor.slice(0, 8)} — 1 dmg → ${victim.peer_id.slice(0, 8)}`);
  }
  // Awake moved a building (user request 2026-11-17): every peer logs it; its mover records the hex it left
  // (`moved:q,r`, vacated) and the building where it went (`made:q,r` — copyMade: same look, same bonus, the source's
  // hidden trap), and every peer folds both in from the next resolution on (syncPlacedBuildings → features.js overlay).
  // One building per hex per action: a second move from / onto a hex already used this action is dropped (same order on every peer).
  const awakeHexes = new Set();
  const awakeBuildingMove = (rl) => {
    const from = `${rl.from?.q},${rl.from?.r}`, to = `${rl.q},${rl.r}`;
    const f = rl.from ? buildingFeatureAt(MAP_SEED, rl.from.q, rl.from.r) : null;
    // A labyrinth wall (kind 'wall', 2026-11-18) moves the same way: featureAt answers the wall on its hex.
    const isWall = rl.kind === 'wall', ok = isWall ? f?.kind === 'wall' : isBuildingFeature(f);
    if (!ok || awakeHexes.has(from) || awakeHexes.has(to)) { console.log(`[${PEER_LABEL}] awake: ${String(rl.by).slice(0, 14)}'s ${isWall ? 'wall' : 'building'} move (${from}) → (${to}) dropped — ${ok ? 'hex already used this action' : `no ${isWall ? 'wall' : 'building'} there`}`); return; }
    awakeHexes.add(from); awakeHexes.add(to);
    console.log(`[${PEER_LABEL}] awake: ${String(rl.by).slice(0, 14)} moves the ${f.label} (${from}) → (${to})`);
    if (rl.by !== PEER_ID_STRING) return;
    entity.worldEdits = entity.worldEdits.filter(e => e.id !== `moved:${from}` && e.id !== `made:${to}`);
    entity.worldEdits.push({ id: `moved:${from}`, q: rl.from.q, r: rl.from.r, vacated: true, at: hg.action });
    entity.worldEdits.push({ id: `made:${to}`, q: rl.q, r: rl.r, made: isWall ? { label: f.label || 'Impassable Wall', path: f.path || '', desc: f.desc || '', biome: f.biome || '', kind: 'wall', blocking: true, copy_of: { q: rl.from.q, r: rl.from.r }, made_by: rl.via } : copyMade(f, rl.from.q, rl.from.r, rl.via), at: hg.action });
    _autosave?.markDirty();
  };
  // Map surgery moved something of mine: the token / trap / obstacle takes its new tile.
  for (const rl of relocations) {
    if (rl.kind === 'building' || rl.kind === 'wall') { awakeBuildingMove(rl); continue; }
    if (rl.kind === 'obstacle' && rl.label === 'wall' || rl.kind === 'obstacle' && rl.label === 'obstacle' && rl.by) console.log(`[${PEER_LABEL}] awake/surgery: ${String(rl.by).slice(0, 14)} moves ${String(rl.owner).slice(0, 14)}'s ${rl.label} ${rl.id} → (${rl.q},${rl.r})`);
    // A world-generated feature: the mover records where it went (world_edits_json).
    if (rl.owner === 'world') { if (rl.by === PEER_ID_STRING) { entity.worldEdits = entity.worldEdits.filter(e => e.id !== rl.id); entity.worldEdits.push({ id: rl.id, q: rl.q, r: rl.r, at: hg.action }); console.log(`[${PEER_LABEL}] ${rl.label || rl.id} moved to (${rl.q},${rl.r})`); } continue; }
    if (rl.owner !== PEER_ID_STRING) continue;
    const list = rl.kind === 'token' ? entity.tileTokens : rl.kind === 'trap' ? entity.traps : entity.obstacles;
    const x = list.find(o => o.id === rl.id);
    if (x) { x.q = rl.q; x.r = rl.r; console.log(`[${PEER_LABEL}] my ${rl.kind} ${rl.label || rl.id} moved to (${rl.q},${rl.r})`); }
  }
  // A channel of mine broke (I moved / attacked / emitted another element): the permanent falls.
  // Awake ∀ (paper "Permanent — combine both Awakes into one permanent"): only the Harmony channel ends; the permanent stays.
  for (const cb of channelsBroken) if (cb.owner === PEER_ID_STRING && everyOutlasts(cb.effect_id)) { entity.channels = entity.channels.filter(c => c.effect_id !== cb.effect_id); console.log(`[${PEER_LABEL}] ${cb.effect_id} channel ends (${cb.why || 'concentration lost'}) — the ∀ permanent stays${entity.awakeLend ? ` (+${JSON.stringify(entity.awakeLend.stats)})` : ''}`); }
  for (const cb of channelsBroken) if (cb.owner === PEER_ID_STRING && entity.permanents.has(cb.effect_id) && !everyOutlasts(cb.effect_id)) { dropPermanent(cb.effect_id); console.log(`[${PEER_LABEL}] ${cb.effect_id} ${cb.why ? `dropped (${cb.why})` : 'channel broken (concentration lost)'}`); }
  // My Earth obstacles wear down under enemy Matter; at 0 hp they are gone.
  for (const h of obstacleHits) {
    if (h.owner !== PEER_ID_STRING) continue;
    const ob = entity.obstacles.find(o => o.id === h.id);
    if (!ob) continue;
    ob.hp -= h.amount;
    if (ob.hp <= 0) { entity.obstacles = entity.obstacles.filter(o => o.id !== h.id); console.log(`[${PEER_LABEL}] my obstacle at (${ob.q},${ob.r}) crumbles under ${h.by.slice(0, 8)}`); _autosave?.markDirty(); }
  }
  // Traps of mine that sprang: gone from the tile, their card to the discard pile. A fired
  // perm-trap (Sleep, Confusion) comes up as my permanent instead (permanentsToAdd below).
  // User ruling 2026-10-30: a trap under its owner goes back to the OWNER's discard pile; a trap on an
  // open tile (enter trigger — nobody of mine stood there) goes to the discard pile of the unit that
  // dealt with it (sprang it). Library-generated traps (Space Bending, Alchemist) only ever exist as
  // that card for the one who dealt with them.
  // A Cleric's disabled trap (`disabled`, `to`, user ruling 2026-11-14): active tap → the card goes to its
  // OWNER's discard pile (a world trap is just gone); passive step on a trapped building → the Cleric's discard.
  // MV: trap_spent — routing (ruling 2026-10-30, Cleric 2026-11-14) and my holdings as records, one spent trap at a time
  // (worldEditGone reads my world edits live: an earlier record of this loop counts).
  const spentHookCtx = { effectKnown: (id) => !!data.effects[id], worldEditGone: (id) => entity.worldEdits.some(e => e.id === id && e.gone) };
  for (const ts of trapsSpent) {
    const isDungeon = String(ts.id).startsWith('dng:');
    applyHookRecords(effectHook('trap_spent', spentHookCtx, { ts, self: PEER_ID_STRING, turn: hg.turn, action: hg.action }), {
      trap_remove: (x) => { entity.traps = entity.traps.filter(t => t.id !== x.id); },
      release_card: (x) => releaseHeldCard(x.card_id, x.to_discard),
      discard_new: (x) => { discard.push(makeEffectCard(x.effect_id)); console.log(`[${PEER_LABEL}] cleric ${String(x.by).slice(0, 8)} disabled my Library trap ${x.effect_id} — the card joins my discard pile`); },
      drop_perm: (x) => dropPermanent(x.id),
      mine_done: (x) => { console.log(`[${PEER_LABEL}] my trap ${ts.effect_id} ${ts.disabled ? 'is disabled' : `sprang on ${ts.victim.slice(0, 8)}`}${x.card_to_victim ? ' — its card is theirs now' : ''}`); _autosave?.markDirty(); },
      world_edit: (x) => {
        if (!x.replace) { entity.worldEdits.push(x.edit); return; }
        entity.worldEdits = entity.worldEdits.filter(e => e.id !== x.edit.id); entity.worldEdits.push(x.edit);
        console.log(`[${PEER_LABEL}] dungeon ${x.edit.id} explored on turn ${x.edit.explored} — it re-arms on turn ${x.edit.explored + 5}`);
      },
      card_to_me: (x) => {
        const c = makeEffectCard(x.effect_id);
        discard.push(c);
        console.log(`[${PEER_LABEL}] I dealt with the ${c.name} trap — its card goes to my discard pile${ts.disabled ? ' (cleric: disabled, no damage)' : ''}`);
        if (x.notice === 'cleric') broadcastUI(handMsg({ notice: `⚜ ${clName(entity.classId)}: the ${c.name} trap ${isDungeon ? 'of the dungeon' : ts.owner === 'world' ? 'hidden in the building' : 'here'} is disabled before it springs — no damage; its card joins your discard pile` }));
        else if (x.notice === 'dungeon' || x.notice === 'building') broadcastUI(handMsg({ notice: isDungeon ? `⚠ You explore the dungeon — its trap springs: ${c.name}. Its card joins your discard pile; the dungeon re-arms in 5 turns` : `⚠ A hidden trap in the building springs: ${c.name} — its card goes to your discard pile` }));
      },
    });
  }
  // Class cards (user ruling 2026-10-30) — what happened to MY class this action.
  for (const co of classOutcomes) {
    if (co.owner !== PEER_ID_STRING || !co.ok) continue;
    const cols = Object.keys(classColours(entity.classId));
    // C1 progress: the class card's next state + what happened (colour | destroyed | recast | untap | step).
    const pr = classHook('progress', entity.classId, CL_BASE, { state: { down: entity.classDown, archived: entity.classArchived, tapped: entity.classTapped, progress: entity.classProgress }, cols, co });
    if (!pr.event) continue;
    entity.classDown = pr.state.down; entity.classArchived = pr.state.archived; entity.classTapped = pr.state.tapped; entity.classProgress = pr.state.progress;
    if (pr.event === 'colour') console.log(`[${PEER_LABEL}] my class ${entity.className} lost its ${co.stat} colour to ${co.actor.slice(0, 8)} (${entity.classDown.length}/${cols.length} down)`);
    if (pr.event === 'destroyed') {
      entity.permanents.delete(entity.classId); delete entity.permPower[entity.classId];
      if (!archive.some(c => c.kind === 'class')) archive.push(classCard());
      console.log(`[${PEER_LABEL}] my class ${entity.className} is destroyed by ${co.actor.slice(0, 8)} — the card goes to my archive; emit every colour (any successful roll) to recast it`);
    }
    if (pr.event === 'recast') {
      entity.permanents.add(entity.classId);
      for (let i = archive.length - 1; i >= 0; i--) if (archive[i].kind === 'class') archive.splice(i, 1);
      console.log(`[${PEER_LABEL}] my class ${entity.className} is back on the board (every colour recast)`);
    }
    if (pr.event === 'untap') console.log(`[${PEER_LABEL}] my class ${entity.className} is untapped — the ability is ready again`);
    if (pr.event === 'step') console.log(`[${PEER_LABEL}] class ${co.kind}: ${Number.isInteger(entity.classProgress.n) ? `${entity.classProgress.n}/${classDataOf(entity.classId).untap_emissions} emissions` : `${entity.classProgress.done.length}/${cols.length} colours`} (${co.stat} done)`);   // CP2: healer_untap_log — Healer untap_emissions (answer 2026-11-19 #4)
  }
  // Class abilities that fired this turn (user rulings 2026-10-30, R1–R3) — each peer applies what is theirs.
  for (const u of classAbilityOut.used) {
    if (u.actor !== PEER_ID_STRING || u.class_id !== entity.classId) continue;
    if (classKindOf(u.class_id) === 'tap') { entity.classTapped = true; console.log(`[${PEER_LABEL}] class ${entity.className} is tapped — emit every colour (any successful roll) to untap it`); }
    else entity.classUsedTurn = hg.turn;
  }
  // Shield life points (user ruling 2026-11-12): +1 life and +1 maximum at once; the first damage takes them.
  for (const a of classAbilityOut.armor) if (a.on === PEER_ID_STRING && entity.life > 0 && !entity.armor) { entity.armor = 1; entity.lifeMax += 1; entity.life += 1; console.log(`[${PEER_LABEL}] overlord ${a.by.slice(0, 8)}: I wear an armor life point`); }
  for (const a of classAbilityOut.illusion) if (a.on === PEER_ID_STRING && entity.life > 0 && !entity.illusion) { entity.illusion = 1; entity.illusionTurn = hg.turn; entity.lifeMax += 1; entity.life += 1; console.log(`[${PEER_LABEL}] illusionist ${a.by.slice(0, 8)}: an illusion life point until the turn's 3rd action`); }
  // Avenger lure (user rework #2 2026-11-14): a monster lured this action wakes and chases the Avenger.
  for (const l of classAbilityOut.lures) if (l.on === PEER_ID_STRING && entity.life > 0 && entity.monsterState) {
    if (entity.monsterState === 'sleeping') entity.monsterState = 'awake';
    entity.luredBy = { id: l.by, turn: hg.turn };
    console.log(`[${PEER_LABEL}] avenger lure: ${l.by.slice(0, 14)} lures me — I chase it`);
  }
  // CP: avenger_decl — max-only chase bonus (data chase_bonus.max_only, pick 2026-11-19 #9 a): the life points the
  // life-max recompute below must not take back (a max-only point lost or faded this resolution was never added to life).
  const cbMaxOnly = (c) => !!classHook('config', c, CL_BASE).maxOnly;   // phase 4: per chase_step class
  let cpCbFreed = 0;
  // Avenger chase bonus: every NEW wild monster chasing me (lured now, or chase_target = me in its snapshot)
  // → +1 life max and +1 life, never more than 1 in total; fades when nobody chases me any more.
  for (const cc of CL_CHASERS) {
    if (!(entity.classId === cc || csGet(cc, 'bonus', 0) || csGet(cc, 'chasers', []).length)) continue;
    const onBoard = entity.classId === cc && !entity.classArchived && entity.permanents.has(cc) && entity.life > 0;
    const chasing = !onBoard ? [] : [...new Set([
      ...classAbilityOut.lures.filter(l => l.by === PEER_ID_STRING).map(l => l.on),
      ...[...view.keys()].filter(o => o !== PEER_ID_STRING && isWildMonster(view.get(o)) && (view.get(o)?.life ?? 0) > 0 && view.get(o)?.chase_target === PEER_ID_STRING),
    ])];
    const st = classHook('chase_step', cc, CL_BASE, { state: { chasers: [...csGet(cc, 'chasers', [])], bonus: csGet(cc, 'bonus', 0) }, chasing });   // C1 chase_step
    if (st.fresh.length) console.log(`[${PEER_LABEL}] ${clShort(cc)}: ${st.fresh.length} new monster(s) chasing me (${st.fresh.map(o => o.slice(0, 14)).join(', ')}) — ${st.chasers.length} in all`);
    if (st.fresh.length || st.grant > 0) console.log(classEventLine(cc, 'chase'));   // log only (user 2026-11-23)
    if (st.grant > 0) { const heal = Number.isInteger(st.heal) ? st.heal : st.grant; csSet(cc, 'bonus', st.bonus); entity.lifeMax += st.grant; entity.life += heal; console.log(`[${PEER_LABEL}] ${clShort(cc)}: +${st.grant} temporary life max${heal ? '' : ' (max only)'} (chase bonus ${st.bonus}) — life ${entity.life}/${entity.lifeMax}`); broadcastUI(handMsg({ notice: `${clName(cc)}: a new monster chases you — +1 temporary life ${heal ? '' : 'max '}(${entity.life}/${entity.lifeMax})` })); }   // CP: avenger_grant — life += st.heal (0 when max only)
    if (st.fade) { if (cbMaxOnly(cc)) cpCbFreed += csGet(cc, 'bonus', 0) || 0; csSet(cc, 'bonus', 0); console.log(`[${PEER_LABEL}] ${clShort(cc)}: no monster chases me any more — the chase bonus fades`); }   // CP: avenger_fade
    csSet(cc, 'chasers', [...st.chasers]);
  }
  // Prophet (user rework #2 2026-11-14, passive, once per turn): the first resolution of the turn that ends
  // with an enemy in CONTACT (adjacent after this action's moves, not invisible) shows me its whole hand.
  if (hasHook(entity.classId, 'contact') && !entity.classArchived && entity.permanents.has(entity.classId) && entity.life > 0 && entity.classUsedTurn !== hg.turn) {
    const pc = entity.classId, C = classHook('config', pc, CL_BASE).contact;   // phase 4: any contact class
    const at = (id) => { const t = nextTiles.get(id); const v = view.get(id); return t ? { tile_q: t.q, tile_r: t.r } : v && Number.isInteger(v.tile_q) ? { tile_q: v.tile_q, tile_r: v.tile_r } : null; };
    const me = at(PEER_ID_STRING), mine = revealsThisTurn.find(r => r.actor === PEER_ID_STRING);
    const foes = !me ? [] : [...view.keys()].filter(o => o !== PEER_ID_STRING).map(o => ({ o, v: view.get(o), t: at(o) }))
      .filter(x => x.v && x.t && (x.v.life ?? 0) > 0 && sideOf(x.v.alliance) !== MY_SIDE && !snapInvisible(x.v) && hexDistance(me, x.t) <= C)
      .map(x => ({ id: x.o, fought: mine?.target?.ref === x.o || revealsThisTurn.some(r => r.actor === x.o && r.target?.ref === PEER_ID_STRING) }));
    const foe = classHook('contact', pc, CL_BASE, { foes });   // C1 contact (prophetPick)
    if (foe) {
      entity.classUsedTurn = hg.turn;
      const nm = view.get(foe)?.name || foe.slice(0, 12);
      console.log(`[${PEER_LABEL}] ${clShort(pc)}: first contact this turn with ${nm} (${foe.slice(0, 14)}) — I see the whole hand`);
      console.log(classEventLine(pc, 'contact'));
      requestHand(foe, { n: null, why: pc });
      broadcastUI(handMsg({ notice: `${clName(pc)}: first contact with ${nm} — their hand opens (once this turn)` }));
    }
  }
  // Witch (user rework 2026-11-14; any forced hand discard): cards leave MY hand (private) — random by the seed every peer derived,
  // over my hand's card ids (pickHandDiscards). Never a card in play this action (cast, played, riding on it,
  // attached); with fewer cards, what is there. They stay in circulation (discard pile), so DECK_MIN is untouched.
  for (const dc of classAbilityOut.discards) {
    if (dc.on !== PEER_ID_STRING) continue;
    const inPlay = cardsInPlayNow();
    const ids = pickHandDiscards(dc.seed || `${dc.by}:${hg.action}`, hand.filter(c => !inPlay.has(c.card_id)).map(c => c.card_id), dc.n, sha256Hex);
    const gone = ids.map(id => hand.find(c => String(c.card_id) === id)).filter(Boolean);
    for (const c of gone) { hand.splice(hand.indexOf(c), 1); discard.push(c); willDiscard.delete(c.card_id); willArchive.delete(c.card_id); }
    const why = dc.why || 'discard', Why = why[0].toUpperCase() + why.slice(1), who = peersPublic.get(dc.by)?.name || dc.by.slice(0, 8);
    console.log(`[${PEER_LABEL}] ${why}: ${dc.by.slice(0, 14)} makes me discard ${gone.length}/${dc.n} (${gone.map(c => `${c.card_id} ${c.name || c.action_name || c.code}`).join(', ') || 'nothing — no spare card in hand'})`);
    if (gone.length) {
      broadcastUI({ kind: 'peek', what: 'discard', cards: gone.map(peekWire), text: `${Why}: ${who} made you discard ${gone.map(c => c.name || c.action_name || c.code).join(', ')} — to your discard pile.` });
      _autosave?.markDirty();
    }
  }
  // Deck / hand peeks (legacy Prophet / Avenger 1.0.x kinds, nothing emits them since the 2026-11-14 reworks): the one
  // looked at publishes; Seeker: where a card lies.
  for (const pk of classAbilityOut.peeks) {
    if (pk.kind === 'deck' && pk.of === PEER_ID_STRING) publishPeek(pk.by, { what: 'deck', n: pk.n || 5 }).catch(() => {});
    if (pk.kind === 'hand2' && pk.of === PEER_ID_STRING) publishPeek(pk.by, { what: 'hand', n: pk.n || 2 }).catch(() => {});
    if (pk.kind === 'locate' && pk.by === PEER_ID_STRING) broadcastUI({ kind: 'peek', what: 'locate', tiles: pk.tiles, text: `Seeker: ${pk.of} ${pk.tiles.length ? `lies at ${pk.tiles.map(t => `(${t.q},${t.r})`).join(' ')}` : 'lies nowhere in this Dimension'}.` });
  }
  // Alchemist / Seeker (Library copies) / Ranger (a card of mine): traps laid by my class.
  for (const tp of classAbilityOut.traps) if (tp.by === PEER_ID_STRING) {
    // CR: seeker — at most max_standing (1) planted Seeker trap stands (2026-11-17): the oldest go, their cards to my discard.
    // Phase 3: the limit rides on the record (far_trap max_standing), counted per class (made_by).
    const seekMax = Number.isInteger(tp.max_standing) && tp.max_standing >= 1 && tp.made_by ? tp.max_standing : null;
    if (seekMax) {
      const mine = entity.traps.filter(t => t.made_by === tp.made_by);
      for (const old of mine.slice(0, Math.max(0, mine.length - (seekMax - 1)))) {
        entity.traps = entity.traps.filter(t => t !== old);
        if (old.card_id) releaseHeldCard(old.card_id, true);
        console.log(`[${PEER_LABEL}] class ${String(tp.made_by).replace(/^class_/, '')}: my older trap ${old.effect_id} at (${old.q},${old.r}) is lifted — ${seekMax === 1 ? 'one' : seekMax} ${data.classes[tp.made_by]?.name || tp.made_by} trap${seekMax === 1 ? '' : 's'} at a time`);
      }
    }
    const id = `${PEER_ID_STRING.slice(-8)}#${hg.action}#ctrap${entity.traps.length}`;
    entity.traps.push({ id, q: tp.q, r: tp.r, effect_id: tp.effect_id, elements: tp.elements, card_id: tp.card_id, power: tp.power, trigger: tp.trigger, mode: tp.mode, holder: tp.holder, ...(tp.library ? { library: true } : {}), ...(seekMax ? { made_by: tp.made_by } : {}) });
    if (tp.card_id) holdCard(tp.card_id);
    console.log(`[${PEER_LABEL}] class trap ${tp.effect_id} laid at (${tp.q},${tp.r}) [${tp.trigger}/${tp.mode}${tp.library ? '/library' : ''}]`);
    _autosave?.markDirty();
  }
  // Seeker: the far trap building I laid stays in my sight until the end of my next turn.
  for (const tp of classAbilityOut.traps) if (tp.by === PEER_ID_STRING && tp.vision) grantSeekerVision(tp);
  // Animator copy / Priest Shrine (user rulings 2026-11-14): every peer logs it, the creator records the new
  // building as the world edit `made:q,r` — in its snapshot (world_edits_json) for the HUD, late joiners and
  // every resolver from the next action on (syncPlacedBuildings).
  for (const b of classAbilityOut.builds) {
    const id = `made:${b.q},${b.r}`;
    if (b.by === PEER_ID_STRING && entity.worldEdits.some(e => e.id === id)) continue;
    console.log(`[${PEER_LABEL}] building made: ${b.made.label} at (${b.q},${b.r}) by ${b.by.slice(0, 14)} (${b.why}${b.made.copy_of ? `, copy of (${b.made.copy_of.q},${b.made.copy_of.r})` : ''}${b.random ? ', random hex' : ', picked hex'})`);
    if (b.by !== PEER_ID_STRING) continue;
    // CR: priest — one Shrine per Priest at a time (2026-11-17): my older Shrines become tombstones.
    // Phase 3: the limit rides on the record (build max_standing), counted per class (made.made_by).
    const shrineMax = Number.isInteger(b.max_standing) && b.max_standing >= 1 ? b.max_standing : null;
    if (shrineMax) {
      const mine = entity.worldEdits.filter(e => !e.gone && e.made?.made_by === b.made.made_by && e.id !== id);
      for (const old of mine.slice(0, Math.max(0, mine.length - (shrineMax - 1)))) {
        entity.worldEdits = entity.worldEdits.filter(e => e !== old);
        entity.worldEdits.push({ id: old.id, q: old.q, r: old.r, gone: true, at: hg.action });
        console.log(`[${PEER_LABEL}] class ${b.why}: my older ${old.made?.label || 'Shrine'} at (${old.q},${old.r}) is gone — ${shrineMax === 1 ? `one ${b.made.label}` : `${shrineMax} of them`} at a time`);
      }
    }
    if (b.why === 'builder') {
      const mine = entity.worldEdits.filter(e => !e.gone && e.made?.made_by === 'npc_builder' && e.id !== id);
      for (const old of mine.slice(0, Math.max(0, mine.length - (BUILDER_MAX_STANDING - 1)))) {
        entity.worldEdits = entity.worldEdits.filter(e => e !== old);
        entity.worldEdits.push({ id: old.id, q: old.q, r: old.r, gone: true, at: hg.action });
        console.log(`[${PEER_LABEL}] npc builder: my oldest Barricade at (${old.q},${old.r}) comes down — ${BUILDER_MAX_STANDING} standing at most`);
      }
      builderBuiltTurn = hg.turn;
    }
    entity.worldEdits.push({ id, q: b.q, r: b.r, made: b.made, at: hg.action });
    _autosave?.markDirty();
  }
  // Druid: my defence token on my tile.
  for (const tk of classAbilityOut.tokens) if (tk.by === PEER_ID_STRING) {
    const same = entity.tileTokens.find(x => x.kind === tk.kind && x.elem === tk.elem && x.q === tk.q && x.r === tk.r);
    if (same && same.value >= tk.value) continue;
    if (same) entity.tileTokens = entity.tileTokens.filter(x => x !== same);
    entity.tileTokens.push({ id: `${PEER_ID_STRING.slice(-8)}#${hg.action}#c${entity.tileTokens.length}`, kind: tk.kind, elem: tk.elem, value: tk.value, q: tk.q, r: tk.r, ...(tk.druid ? { druid: true } : {}) });
    _autosave?.markDirty();
  }
  // Necromancer: a fallen ally creature rises (held by the class), or an archived creature of mine enters.
  // Phase 4: the class is the revive record's (rv.cls), its namespace holds `raised`.
  for (const rv of classAbilityOut.revives) {
    const rc = rv.cls, rcs = clShort(rc);
    if (rv.who && rv.who === PEER_ID_STRING) onRevived(rv.by, rc);
    if (rv.by !== PEER_ID_STRING) continue;
    if (rv.who) {
      csSet(rc, 'raised', [...csGet(rc, 'raised', []), rv.who]);
      const corpse = peersPublic.get(rv.who);
      if (corpse?.owner_peer_id) {
        // A summoned creature's process vanished with it: a fresh one of the same creature rises on its tile.
        if (entity.summons.some(x => x.perm === rc)) onSummonEnd(rc);
        spawnCompanion(rc, { creature_id: rv.creature_id, name: rv.name, at: { q: corpse.tile_q, r: corpse.tile_r }, ignore: rv.who, env: { CHARACTER_ID: '', CREATURE_ID: rv.creature_id, ENTITY_NAME: `${data.creatures[rv.creature_id]?.name || rv.name} (${PEER_LABEL}'s)` } })
          .then(tag => { if (tag) console.log(`[${PEER_LABEL}] class ${rcs}: ${rv.name} rises again as ${tag}`); }).catch(e => console.warn(`[${PEER_LABEL}] ${rcs} failed: ${e.message}`));
      } else entity.summons.push({ peer_id: rv.who, creature_id: rv.creature_id, name: rv.name, bound: true, perm: rc, mode: 'revive' });
      continue;
    }
    const i = archive.findIndex(c => c.kind === 'creature' && data.creatures[c.creature_id]);
    if (i < 0) { console.log(`[${PEER_LABEL}] class ${rcs}: no creature in my archive — nothing rises`); continue; }
    const c = archive.splice(i, 1)[0];
    if (entity.summons.some(x => x.perm === rc)) onSummonEnd(rc);
    spawnCompanion(rc, { creature_id: c.creature_id, name: c.name, env: { CHARACTER_ID: '', CREATURE_ID: c.creature_id, ENTITY_NAME: `${c.name} (${PEER_LABEL}'s)` } })
      .then(tag => { if (tag) console.log(`[${PEER_LABEL}] class ${rcs}: ${c.name} rises from my archive as ${tag}`); }).catch(e => console.warn(`[${PEER_LABEL}] ${rcs} failed: ${e.message}`));
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
    if (bf.holder !== PEER_ID_STRING || !bf.perm) continue;
    if (bf.spend === 'every') {
      entity.everyPerms.delete(bf.perm);
      const second = heldCards.find(c => c.effect_id === bf.perm);
      if (second) releaseHeldCard(second.card_id);
      console.log(`[${PEER_LABEL}] my Blessing ∀ negated ${bf.caster.slice(0, 8)}'s ${bf.effect_id} — one Blessing remains`);
    } else if (bf.spend === 'perm') { dropPermanent(bf.perm); console.log(`[${PEER_LABEL}] my ${bf.perm} negated ${bf.caster.slice(0, 8)}'s ${bf.effect_id} — the permanent is spent`); }
  }
  // Afflictions on me (Sleep: no casting in contact with the holder; Confusion: Empty Posture only) hold while the holder keeps the permanent.
  for (const a of afflictionsOut) if (a.on === PEER_ID_STRING && !entity.afflictions.some(x => x.effect_id === a.effect_id && x.by === a.by)) entity.afflictions.push({ effect_id: a.effect_id, by: a.by, ...(a.until_action !== undefined ? { until_action: a.until_action } : {}) });
  // My Death Ward fired: the permanent is spent (its card goes to the discard pile).
  for (const w of wardFired) {
    if (w.warder !== PEER_ID_STRING) continue;
    const wp = entity.wardBy[w.victim] || [...entity.permanents].filter(p => EFFECT_RULES[p]?.resurrect).sort()[0];
    entity.wards = entity.wards.filter(x => x !== w.victim); delete entity.wardBy[w.victim];
    dropPermanent(wp);
    console.log(`[${PEER_LABEL}] my Death Ward saved ${w.victim.slice(0, 8)} — the permanent is spent`);
  }
  // My Disable fired: the permanent is spent, the bar stands for the turn.
  for (const t of disableTriggers) {
    if (t.holder !== PEER_ID_STRING) continue;
    if (t.spend) dropPermanent(t.perm);   // F2: the cast_in permanent that fired (Disable)
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
    if (EFFECT_RULES[id]?.permTurns) entity.permUntil[id] = hg.turn + EFFECT_RULES[id].permTurns;
    if (myLastReveal?.effectId === id && myLastReveal.effectEvery) entity.everyPerms.add(id);
    console.log(`[${PEER_LABEL}] permanent ${id} up: die ${entity.permPower[id]}${myLastReveal?.effectEvery ? ' (∀ doubled)' : ''}`);
    // Awake ∀ (paper "add the target's Stat to your Stat", 2026-11-18): while the permanent stands I get the awakened
    // ally's Will (Harmony's stat) or the moved building's stat bonus; me / a wall lend nothing. Read by every
    // resolver from my snapshot (awake_lend_json).
    if (isAwakePerm(id)) {
      const pl = awakeLast.get(PEER_ID_STRING);
      const st = ELEM_TO_STAT.elem_harmony || 'will';
      let stats = null;
      if (entity.everyPerms.has(id) && pl?.kind === 'unit' && pl.who && pl.who !== PEER_ID_STRING) { const v = Number(peersPublic.get(pl.who)?.[`stat_${st}`]) || 0; if (v > 0) stats = { [st]: v }; }
      if (entity.everyPerms.has(id) && pl?.kind === 'building' && pl.from) { const b = buildingBonusAt(MAP_SEED, pl.from.q, pl.from.r)?.bonus?.stat; if (b && Object.values(b).some(x => x > 0)) stats = { ...b }; }
      entity.awakeLend = stats ? { stats, from: pl.kind === 'unit' ? pl.who : `${pl.label}@${pl.q},${pl.r}` } : null;
      if (entity.awakeLend) console.log(`[${PEER_LABEL}] awake ∀: the permanent lends ${JSON.stringify(stats)} from ${entity.awakeLend.from}`);
    }
  }
  // Rule 24: what was destroyed of mine goes now (the destroyer's die beat its power).
  let reanimDestroyedBy = null;   // C1 ruling 2026-11-16: I am a reanimated unit and my last element fell (life 0 below)
  for (const d of destroyOutcomes) {
    if ((d.result !== 'destroyed' && d.result !== 'taken') || d.owner !== PEER_ID_STRING) continue;
    if (d.kind === 'reanimated') {
      const rb = raisedBy() || d.raised_by;   // phase 2: the elements down live in the raising class's namespace
      if (!csGet(rb, 'down', []).includes(d.id)) csSet(rb, 'down', [...csGet(rb, 'down', []), d.id]);
      const down = csGet(rb, 'down', []);
      // d.last is judged on the elements down BEFORE this action; two enemies striking the two elements in the same
      // action (ruling 2026-11-17: the strikes may come from different enemies) both see last=false — count what is down now.
      const els = classDataOf(d.raised_by || raisedBy())?.destroy_reanimated?.elements || ['elem_harmony', 'elem_concentration'];
      if (d.last || els.every(x => down.includes(x))) reanimDestroyedBy ||= d.actor;
      console.log(`[${PEER_LABEL}] reanimated: my ${d.id} is struck by ${d.actor.slice(0, 8)} (die ${d.die}) — ${down.length} down${reanimDestroyedBy ? ', I am destroyed' : ''}`);
      continue;
    }
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
  applyFortressOutcomes(destroyOutcomes);
  let healForMe = 0, drawForMe = 0;
  for (const h of classAbilityOut.heals) if (h.on === PEER_ID_STRING) { healForMe += h.amount; console.log(`[${PEER_LABEL}] healer ${h.by.slice(0, 8)}: +${h.amount} life`); }
  for (const { actor, eff, oc, bonus: fromBonus, channel: fromChannel } of effectOutcomes) {
    // The main cast's status only — a bonus-plan instant or a channel tick must not mark a cast in progress as done.
    // Fossilization token retry (user ruling 2026-11-18): the lock + bought tokens landed ('done'), an owed token re-emits
    // next action — endRound keeps the card casting ('retry') and the reveal carries `kept` (the token slots).
    if (actor === PEER_ID_STRING && myLastReveal && !fromBonus && !fromChannel) { myLastReveal.castStatus = tokenRetryOwed(eff.effect_id, oc) ? 'retry' : oc.status; if (oc.kept) myLastReveal.castKept = oc.kept; }
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
      entity.statTokens = placeStatBonusToken(entity.statTokens, { id: `${PEER_ID_STRING.slice(-8)}#${hg.action}#${entity.statTokens.length}`, stat: st.stat, elem: st.elem, value: st.value, effect_id: st.effect_id }).tokens;
    }
    // "Rest of the round" = the actions left in this turn after this one.
    for (const lk of oc.locks) if (lk.on === PEER_ID_STRING) {
      const n = lk.n ?? ((ROUNDS_PER_TURN - 1 - hg.round) + (lk.nextTurn ? ROUNDS_PER_TURN : 0));
      if (n > 0) entity.lockList.push({ effect_id: eff.effect_id, by: actor, n });
      syncLost();
    }
    for (const h of oc.heals) if (h.on === PEER_ID_STRING) healForMe += h.amount;
    for (const h of oc.heals) if (h.on === PEER_ID_STRING || actor === PEER_ID_STRING) console.log(`[${PEER_LABEL}] heal: ${eff.effect_id} by ${actor.slice(0, 14)} → ${h.on.slice(0, 14)} +${h.amount} life`);
    if (oc.shieldElem?.on === PEER_ID_STRING) entity.shieldElems.push({ elem: oc.shieldElem.elem, until_turn: hg.turn, ...(oc.every && EFFECT_RULES[eff.effect_id]?.everyPermanent ? { permanent: true, perm: eff.effect_id } : { permanent: false }) });
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
    // Possess (user ruling 2026-11-17): the permanent is in my holding (permanentsToAdd above). With a creature
    // picked from my archive it enters next to me as my companion (POSSESSED_BY = me) and I play it; with none
    // the permanent is the Phylactery. Every peer logs it; only the caster spawns.
    if (oc.possess?.creature || oc.possess?.phylactery) {
      const pc = oc.possess.creature;
      console.log(`[${PEER_LABEL}] possess: ${actor} ${pc ? `plays ${pc.name || pc.creature_id} from its archive` : 'gets the Phylactery (no creature in its archive)'}`);
      if (actor === PEER_ID_STRING) {
        { const old = entity.summons.find(x => isPossessPerm(x.perm)); if (old) { console.log(`[${PEER_LABEL}] possess: a new Possess — the creature I played goes back to my archive`); onSummonEnd(old.perm); } }
        entity.possessing = null;
        const ai = pc ? archive.findIndex(c => c.kind === 'creature' && (pc.card_id ? c.card_id === pc.card_id : c.creature_id === pc.creature_id)) : -1;
        const cre = pc && ai >= 0 ? data.creatures[pc.creature_id] : null;
        if (cre) {
          archive.splice(ai, 1);
          if (pc.card_id === queuedPossessPick) queuedPossessPick = null;
          entity.possessMode = 'possess';
          const cardId = myLastReveal?.effectCardId || null;
          spawnCompanion(eff.effect_id, { creature_id: pc.creature_id, name: cre.name, env: { CHARACTER_ID: '', CREATURE_ID: pc.creature_id, ENTITY_NAME: `${cre.name} (${PEER_LABEL}'s possessed)`, POSSESSED_BY: PEER_ID_STRING } })
            .then(tag => {
              if (!tag) { console.log(`[${PEER_LABEL}] possess: ${cre.name} cannot enter — the card goes back to my archive, the permanent is the Phylactery`); archive.push(creatureCard(pc.creature_id)); entity.possessMode = 'phylactery'; return; }
              entity.possessing = { peer_id: `peer:${tag}`, card_id: cardId, creature_id: pc.creature_id, name: cre.name, at: Date.now() };
              console.log(`[${PEER_LABEL}] possess: I play ${cre.name} (${tag}) now — my hero holds (Empty Posture) until my Possess permanent falls or it dies`);
              broadcastUI(handMsg({ notice: `👁 Possess: you play ${cre.name} now — your action and target drive it, your hero holds` }));
              publishPublicState().catch(() => {});
            }).catch(e => console.warn(`[${PEER_LABEL}] possess spawn failed: ${e.message}`));
        } else {
          entity.possessMode = 'phylactery';
          console.log(`[${PEER_LABEL}] possess: ${pc ? `${pc.creature_id} is no longer in my archive` : 'no creature in my archive'} — my permanent is the Phylactery (click it: the nearest enemy's best permanent shatters)`);
          broadcastUI(handMsg({ notice: '💀 Phylactery: click it in your permanents — it shatters the best permanent of the nearest enemy' }));
        }
      }
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
  // Effect result toasts (user request 2026-11-17): '<effect> success' / '<effect> failed' over the unit an enemy
  // penalty landed on / missed. Built here from this peer's own resolved outcome (identical on every peer) and
  // sent to the local UI only — no wire field, no state-hash input. effect-results.mjs.
  try {
    const fxTag = `${hg.turn}:${hg.round}`;
    const prettyFx = (id) => String(id || '').replace(/^effect_/, '').split('_').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
    const fxNames = new Map(effectOutcomes.filter(o => o.eff?.name).map(o => [o.eff.effect_id, o.eff.name]));
    const nameOf = (id) => fxNames.get(id) || prettyFx(id);
    const sideIdOf = (id) => { const v = view.get(id); return v ? sideOf(v.alliance) : null; };
    const foes = (a, b) => { const sa = sideIdOf(a), sb = sideIdOf(b); return sa !== null && sb !== null && sa !== sb; };
    const tileNow = (id) => { const v = view.get(id); return v && Number.isInteger(v.tile_q) ? { q: v.tile_q, r: v.tile_r } : null; };
    const at0 = (id) => { const s = viewBefore.get(id); return s && Number.isInteger(s.tile_q) ? { tile_q: s.tile_q, tile_r: s.tile_r } : null; };
    const near = (a, b, d) => { const pa = at0(a), pb = at0(b); return !!(pa && pb) && hexDistance(pa, pb) <= d; };
    const targetOf = (actor) => { const t = byActor.get(actor)?.target; return t?.kind === 'character' ? t.ref : null; };
    const autoTarget = (actor, range) => [...view.keys()].filter(id => id !== actor && (view.get(id)?.life ?? 0) > 0 && foes(actor, id) && near(actor, id, range))
      .sort((a, b) => (view.get(a)?.life ?? 0) - (view.get(b)?.life ?? 0) || a.localeCompare(b))[0] || null;
    const items = effectResultsOf(effectOutcomes, { rules: EFFECT_RULES, ui: EFFECT_UI, nameOf, enemyOf: foes, targetOf, autoTarget, tileOf: tileNow, disableTriggers, blessFired, afflictionsOut, tag: fxTag });
    // Delay Time / natural Domination / natural Petrify cost the revealer this action (judged at its planning).
    const permsIn = (id) => id === PEER_ID_STRING ? [...entity.permanents] : String(view.get(id)?.permanents_csv || '').split(',');
    const natIn = (id, eff) => permsIn(id).includes(eff) && ((id === PEER_ID_STRING ? entity.permCopies : parseCopies(view.get(id)?.perm_copies_json))?.[eff] || 0) > 0;
    const units = revealsThisTurn.map(r => r.actor).filter((id, i, a) => a.indexOf(id) === i && (view.get(id)?.life ?? 0) > 0).map(id => ({ id,
      foes: [...view.keys()].filter(o => o !== id && (view.get(o)?.life ?? 0) > 0 && foes(o, id) && near(o, id, 1))
        .map(o => ({ id: o, delay: holding(permsIn(o).filter(Boolean), 'adjacent_lost')[0] || null, domination: naturalOfKind(permsIn(o), 'lose_action').find(e => natIn(o, e)) || null, petrify: naturalOfKind(permsIn(o), 'stone').find(e => natIn(o, e)) || null })) }))
      .filter(u => u.foes.some(f => f.delay || f.domination || f.petrify));
    items.push(...plannedLossResults(units, { roundsPerTurn: ROUNDS_PER_TURN, round: hg.round, lostToHolders, nameOf, tileOf: tileNow, tag: fxTag }));
    // Natural Love / Awe / Fear / Anger: a NEW contact affliction after this action's moves, judged for every unit as its
    // own peer does below (contactAfflictions), from the snapshots — UI only.
    const afterOf = (id) => { const t = nextTiles.get(id); const v = view.get(id); return t ? { tile_q: t.q, tile_r: t.r } : v ? { tile_q: v.tile_q, tile_r: v.tile_r } : null; };
    for (const id of [...view.keys()].sort()) {
      const v = view.get(id); const at = afterOf(id);
      if (!v || (v.life ?? 0) <= 0 || !at) continue;
      const holders = [...view.keys()].filter(o => o !== id && foes(o, id) && (view.get(o)?.life ?? 0) > 0).flatMap(o => permsIn(o).filter(e => isContactNatural(e) && natIn(o, e)).sort()
        .map(e => { const ao = afterOf(o); return { id: o, effect_id: e, dist: ao ? hexDistance(at, ao) : Infinity }; }));
      if (!holders.length) continue;
      let mine = []; try { mine = id === PEER_ID_STRING ? entity.afflictions : JSON.parse(v.afflictions_json || '[]'); } catch {}
      const tower = id === PEER_ID_STRING ? START_TILE : (Number.isInteger(v.entry_q) ? { q: v.entry_q, r: v.entry_r } : null);
      for (const a of contactAfflictions({ mine, holders, onTower: !!tower && tower.q === at.tile_q && tower.r === at.tile_r })) natFx.push({ effect_id: a.effect_id, on: id, by: a.by, kind: 'afflict' });
    }
    items.push(...naturalResults(natFx, { nameOf, tileOf: tileNow, tag: fxTag }));
    if (items.length) {
      broadcastUI({ kind: 'effect_result', turn: hg.turn, round: hg.round, bonus_rounds: bonusRuns.length, items });
      for (const it of items) if (it.on === PEER_ID_STRING || it.by === PEER_ID_STRING) console.log(`[${PEER_LABEL}] effect result: ${it.name} ${it.ok ? 'success' : 'failed'} on ${String(it.on).slice(0, 14)}${it.why ? ` (${it.why})` : ''}`);
    }
  } catch (e) { console.warn(`[${PEER_LABEL}] effect results: ${e.message}`); }
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
    // Life my own casts restored to someone else (Turn Life on an ally in contact) — healing is a benefit too.
    const healedOthers = (res, id) => res.effectOutcomes.filter(o => o.actor === id && o.oc.status === 'done').flatMap(o => o.oc.heals).filter(h => h.on !== id).reduce((s, h) => s + h.amount, 0);
    // Benefit = I took less, dealt more, or was healed more (or healed an ally more) than in the round without it.
    const paysOff = (without) => takenBy(real, PEER_ID_STRING) < takenBy(without, PEER_ID_STRING) || dealtBy(real, PEER_ID_STRING) > dealtBy(without, PEER_ID_STRING) || healedTo(real, PEER_ID_STRING) > healedTo(without, PEER_ID_STRING) || healedOthers(real, PEER_ID_STRING) > healedOthers(without, PEER_ID_STRING);
    const roundWithout = (edit) => { const alt = structuredClone(pristineReveals); const mine = alt.find(r => r.actor === PEER_ID_STRING); if (!mine) return null; edit(mine); return runRound(alt, true); };
    const stripSkill = (w, id) => { w.skills = (w.skills || []).filter(s => s !== id); if (!!SKILL_RULES[id]?.trance && w.trance) { w.action = w.trance[0]; w.trance = null; } };
    const returned = [];
    myLastReveal.returnedCardIds = [];
    const fx = real.skillFx || [];
    const onMe = fx.filter(f => f.on === PEER_ID_STRING);
    myLastReveal.actionNegated = onMe.some(f => f.negated);
    for (const id of myLastReveal.skillIds || []) {
      if (myLastReveal.skStripped?.includes(id)) { returned.push(`${id} (a peer lacks it)`); myLastReveal.returnedCardIds.push(myLastReveal.skillCardIds[myLastReveal.skillIds.indexOf(id)]); continue; }   // S4: stripped, never executed → back to my hand
      const disp = skillHook('disposition', id, { skillData: (s) => data.skills[s]?.data }, { fx, self: PEER_ID_STRING });   // S1 disposition
      if (disp === 'permanent') continue;
      const cid = myLastReveal.skillCardIds[myLastReveal.skillIds.indexOf(id)];
      // Riding on an action that was negated: it never executed — back to my hand with the action card.
      if (disp === 'negated') { returned.push(`${id} (its action was negated)`); myLastReveal.returnedCardIds.push(cid); continue; }
      // Countered: discarded. A negating instant that did its job: discarded; found nothing to do: back to hand.
      if (disp === 'countered' || disp === 'spent') continue;
      if (disp === 'unused') { returned.push(id); myLastReveal.returnedCardIds.push(cid); continue; }
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
    // SKR-08 plan_lock (Powerful Attack, ruling 2026-11-16): a skill that paid off (not back in my hand, not countered /
    // negated) may limit what I play for the rest of the round — applied in doPlanningEnd.
    for (const id of myLastReveal.skillIds || []) {
      const cid = myLastReveal.skillCardIds[myLastReveal.skillIds.indexOf(id)];
      if (myLastReveal.skStripped?.includes(id) || myLastReveal.returnedCardIds.includes(cid)) continue;
      const disp = skillHook('disposition', id, { skillData: (s) => data.skills[s]?.data }, { fx, self: PEER_ID_STRING });
      const only = skillHook('plan_lock', id, { skillData: (s) => data.skills[s]?.data }, { paid: disp === 'judge' || disp === 'spent' });
      if (!only) continue;
      entity.planOnly = { codes: only, turn: hg.turn, by: id };
      console.log(`[${PEER_LABEL}] ${id}: only ${only.join('/')} until the end of turn ${hg.turn}`);
      broadcastUI(handMsg({ notice: `${data.skills[id]?.name || id}: you can only Attack until the end of the round` }));
    }
    if (returned.length) console.log(`[${PEER_LABEL}] instants without benefit return to hand: ${returned.join(', ')}`);
    // Tell the UI what my instants did (it burns the spent cards) and what was done to me.
    const nm = (id) => id === PEER_ID_STRING ? 'you' : (view.get(id)?.name || id.slice(5, 13));
    // "World Elemental (P-Agent4's)" → "P-Agent4's World Elemental's", never "…(P-Agent4's)'s".
    const poss = (id) => { const n = nm(id); const m = /^(.*) \((.*)'s\)$/.exec(n); return `${m ? `${m[2]}'s ${m[1]}` : n}'s`; };
    const skName = (id) => data.skills[id]?.name || id.replace(/^skill_/, '').replace(/_/g, ' ');
    const actName = (c) => String(c || '').split('+').map(x => ({ A: 'Attack', M: 'Move', B: 'Block', P: 'Posture', EM: 'Empty Move', EP: 'Empty Posture' }[x] || x)).join(' + ');
    const events = [], notices = [];
    for (const f of fx) {
      if (f.by !== PEER_ID_STRING && f.on !== PEER_ID_STRING) continue;
      const who = f.building ? `the building's ${skName(f.skill)}` : f.by === PEER_ID_STRING ? `your ${skName(f.skill)}` : `${poss(f.by)} ${skName(f.skill)}`;
      const extra = (f.ridden || []).length ? ` (and ${f.ridden.map(skName).join(', ')} riding on it)` : '';
      const line = f.what === 'damage' ? `✦ ${who}: one less combat damage to ${nm(f.by)}`   // any Dodge-like damage_in skill (foreign Quick Dodge too)
        : f.what === 'swap' ? `✦ ${who}: swapped places with ${nm(f.on)}`   // SKR-09 (Overrun)
        : (!f.negated && f.what === 'EP') ? `✦ ${who} turned ${f.on === PEER_ID_STRING ? 'your' : poss(f.on)} Empty Posture into an Empty Move — no element goes out`
        : f.negated ? `✦ ${who} negated ${f.on === PEER_ID_STRING ? 'your' : poss(f.on)} ${actName(f.what)}${extra} — ${f.on === PEER_ID_STRING ? 'the card returns to your hand' : 'their card returns to their hand'}`
        : `✦ ${who} countered ${f.on === PEER_ID_STRING ? 'your' : poss(f.on)} ${(f.countered || []).map(skName).join(', ') || 'cast'}${(f.countered || []).length ? ' — discarded' : ''}`;
      notices.push(line);
      console.log(`[${PEER_LABEL}] skill fx: ${line}`);
      if (f.by === PEER_ID_STRING && !f.building) { const k = (myLastReveal.skillIds || []).indexOf(f.skill); if (k >= 0) events.push({ card_id: myLastReveal.skillCardIds[k], name: myLastReveal.skillNames[k], outcome: 'spent' }); }
      for (const id of f.on === PEER_ID_STRING ? (f.countered || []) : []) { const k = (myLastReveal.skillIds || []).indexOf(id); if (k >= 0) events.push({ card_id: myLastReveal.skillCardIds[k], name: myLastReveal.skillNames[k], outcome: 'countered' }); }
      if (f.on === PEER_ID_STRING && f.negated) events.push({ card_id: myLastReveal.cardId, outcome: 'returned' });
    }
    if (events.length || notices.length) broadcastUI({ kind: 'skill-fx', events: events.filter((e, i) => e.card_id && events.findIndex(x => x.card_id === e.card_id) === i), notices });
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
    // Rogue: after a stealthy step, monsters neither wake nor chase me for the rest of the turn.
    if (classAbilityOut.stealth.includes(PEER_ID_STRING)) { CS.spendCharge(entity.classStore, entity.classId, 'threat', hg.turn, 1); console.log(`[${PEER_LABEL}] ${clShort(entity.classId)}: threat charge spent — unseen by monsters for the rest of turn ${hg.turn}`); }
    revealAround(myMove.q, myMove.r).catch(e => console.warn(`[${PEER_LABEL}] reveal failed: ${e.message}`));
  }
  applyRogueTrapCharge(classAbilityOut.rogueTrap.filter(id => id === PEER_ID_STRING).length);
  // Monster natural permanents (rule_monster_natural_permanents) — my own state, read by everyone from my snapshot.
  {
    const tileAfter = (v) => nextTiles.get(v.peer_id) || { q: v.tile_q, r: v.tile_r };
    const others = [...view.values()].filter(v => v?.peer_id && v.peer_id !== PEER_ID_STRING && Number.isInteger(v.tile_q)).sort((a, b) => a.peer_id.localeCompare(b.peer_id));
    const natHolds = (v, eff) => (v.life ?? 0) > 0 && String(v.permanents_csv || '').split(',').includes(eff) && (parseCopies(v.perm_copies_json)[eff] || 0) > 0;
    // Love / Awe / Fear / Anger: an enemy holder in contact after this action afflicts me (not while I stand on my tower).
    if (entity.life > 0) {
      const holders = others.filter(v => sideOf(v.alliance) !== MY_SIDE).flatMap(v => String(v.permanents_csv || '').split(',').filter(e => isContactNatural(e) && natHolds(v, e)).sort()
        .map(e => ({ id: v.peer_id, effect_id: e, dist: hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, { tile_q: tileAfter(v).q, tile_r: tileAfter(v).r }) })));
      const add = contactAfflictions({ mine: entity.afflictions, holders, onTower: entity.tile.q === START_TILE.q && entity.tile.r === START_TILE.r });
      for (const a of add) { entity.afflictions.push(a); console.log(`[${PEER_LABEL}] natural ${a.effect_id}: in contact with ${a.by.slice(0, 14)} — afflicted until I visit my tower (${START_TILE.q},${START_TILE.r}) or its permanents fall`); }
    }
    // Spirit Link: my natural link follows the nearest allied creature; alone, no link. Two copies standing = the ∀
    // double cast (user ruling 2026-11-15): all four stats linked (every_csv carries it); one copy = Vitality only.
    const slPerm = naturalOfKind(entity.permanents, 'link')[0] || null;   // F7: naturalKind 'link'
    const slCopies = slPerm ? entity.permCopies[slPerm] || 0 : 0;
    if (entity.life > 0 && slPerm && slCopies > 0) {
      if (slCopies >= 2) entity.everyPerms.add(slPerm); else entity.everyPerms.delete(slPerm);
      const ally = nearestAlliedCreature({ peer_id: PEER_ID_STRING, tile_q: entity.tile.q, tile_r: entity.tile.r, side: MY_SIDE },
        others.map(v => ({ ...v, tile_q: tileAfter(v).q, tile_r: tileAfter(v).r, side: sideOf(v.alliance) })), hexDistance);
      const want = ally ? naturalLinkStats(slCopies).map(st => ({ from: ally.peer_id, stat: st, value: ally[`stat_${st}`] ?? 0 })) : [];
      const sig = (l) => JSON.stringify(l.map(x => [x.from, x.stat]));
      if (sig(want) !== sig(entity.links)) {
        entity.links = want;
        console.log(`[${PEER_LABEL}] natural spirit link (${slCopies} cop${slCopies > 1 ? 'ies — ∀' : 'y'}): ${ally ? `linked to ${ally.name || ally.peer_id} — ${want.map(l => `${l.stat} ${l.value}`).join(', ')}` : 'no allied creature — no link'}`);
      }
    }
  }
  if (entity.classFlags && myMove) entity.classFlags.movedThisRound = true;
  if (entity.classFlags && myMove) entity.classFlags.movedRounds = [...new Set([...(entity.classFlags.movedRounds || []), hg.round])];   // CR: guardian_move — which actions I moved on (2026-11-17)
  const myDmg = sumDmg(damage.get(PEER_ID_STRING));
  const wasAlive = entity.life > 0;
  if (myDmg) entity.life = Math.max(0, entity.life - myDmg);
  // A Phantom is undone by the first point of damage (user spec 2026-10-29).
  if (myDmg > 0 && IS_PHANTOM && entity.life > 0) { console.log(`[${PEER_LABEL}] phantom: struck for ${myDmg} — the mirror shatters`); entity.life = 0; }
  // C1 ruling 2026-11-16, Necromancer destroy reanimated: both elements struck → I fall for good (no second raise).
  if (reanimDestroyedBy && entity.life > 0) { console.log(`[${PEER_LABEL}] reanimated: ${reanimDestroyedBy.slice(0, 8)} struck my last element — I am destroyed`); entity.life = 0; }
  // Shield life points are the first life lost — the illusion, then the armor. They sit on top of life and
  // maximum, so the recalculation below drops the maximum back and refunds the life it would take twice.
  // C1 life_points: illusion → armor → chase bonus, one point each.
  const lp = classHook('life_points', entity.classId, CL_BASE, { dmg: myDmg, illusion: entity.illusion, armor: entity.armor, chaseBonus: chaseBonusNow() });
  let shieldHit = lp.absorbed;
  if (entity.illusion && !lp.illusion) { entity.illusion = lp.illusion; console.log(`[${PEER_LABEL}] the illusion takes the first point of damage`); }
  if (entity.armor && !lp.armor) { entity.armor = lp.armor; console.log(`[${PEER_LABEL}] the armor point is gone`); }
  if (chaseBonusNow() && !lp.chaseBonus) { for (const cc of CL_CHASERS) { const b = csGet(cc, 'bonus', 0) || 0; if (!b) continue; if (cbMaxOnly(cc)) cpCbFreed += b; csSet(cc, 'bonus', lp.chaseBonus); } console.log(`[${PEER_LABEL}] ${CL_CHASERS.map(clShort).join('/')}: the chase bonus point is lost (a new chasing monster grants it again)`); }   // CP: avenger_loss
  // The illusion fades after the turn's 3rd action (or if it is somehow left over from an earlier turn).
  if (entity.illusion && (hg.round === ROUNDS_PER_TURN - 1 || entity.illusionTurn !== hg.turn)) { entity.illusion = 0; console.log(`[${PEER_LABEL}] the illusion fades`); }
  // Noble lifesteal: the per-attacker amount I dealt this resolve, now applied
  // as healing after my own damage lands (so a lethal attack that finishes an
  // enemy also carries the heal). Cap at my life maximum.
  for (const c of clWith('lifesteal_apply')) {
    const was = entity.life;
    entity.life = classHook('lifesteal_apply', c, CL_BASE, { amount: lifestealForMe.amount, life: entity.life, lifeMax: entity.lifeMax, held: entity.permanents.has(c) });   // C1 lifesteal_apply
    // log only (user 2026-11-23): the holder's line when the class healed it
    if (entity.life > was) { console.log(`[${PEER_LABEL}] class ${c.replace(/^class_/, '')}: I steal ${entity.life - was} life (${entity.life}/${entity.lifeMax}, the class rule)`); console.log(classEventLine(c, 'lifesteal')); }
  }
  // Effect heals (Drain, Turn Life) land the same way: after my damage, capped, never on a corpse.
  // Resting on a healing building (user ruling 2026-11-12): an Empty Posture with
  // no skill, effect or bonus round, unhurt this action, heals once per turn.
  {
    const here = buildingBonusAt(MAP_SEED, entity.tile.q, entity.tile.r);
    const rested = myLastReveal && myLastReveal.code === 'EP' && !(myLastReveal.skillIds || []).length && !myLastReveal.effectId && !(myLastReveal.bonusUsed > 0) && !myDmg;
    if (here?.bonus?.rest && rested && entity.life > 0 && entity.life + healForMe < entity.lifeMax && entity.restHealTurn !== hg.turn) {
      const room = entity.lifeMax - entity.life - healForMe;
      const gain = here.bonus.rest === 'all' ? room : Math.min(here.bonus.rest, room);
      healForMe += gain; entity.restHealTurn = hg.turn;
      console.log(`[${PEER_LABEL}] rested at ${here.source} (${entity.tile.q},${entity.tile.r}): +${gain} life`);
      broadcastUI(handMsg({ notice: `⌂ ${here.source}: you rest and recover ${gain} life — once per turn` }));
    }
  }
  if (healForMe > 0 && entity.life > 0) entity.life = Math.min(entity.lifeMax, entity.life + healForMe);
  // general_ux_hitpoints_calculations: stat tokens and the bonus tile tokens under me shift
  // my life maximum by round((Σstats + Σtokens)/10) − round(Σstats/10); life follows the shift.
  if (entity.life > 0) {
    const base = Object.values(entity.stats).reduce((a, v) => a + (v || 0), 0);
    const extra = entity.statTokens.reduce((a, t) => a + t.value, 0)
      + [...view.values()].flatMap(v => parseJsonArr(v?.tile_tokens_json)).filter(t => t.kind === 'bonus' && t.q === entity.tile.q && t.r === entity.tile.r).reduce((a, t) => a + t.value, 0)
      + worldFeatureValueAt(view, entity.tile.q, entity.tile.r)
      + Object.values(buildingBonusAt(MAP_SEED, entity.tile.q, entity.tile.r)?.bonus?.stat || {}).reduce((a, n) => a + n, 0)
      + ([...entity.permanents].some(isLinkPerm) ? entity.links.reduce((a, l) => a + Math.max(0, view.get(l.from)?.[`stat_${l.stat}`] ?? 0), 0) : 0);
    const newMax = Math.max(1, entity.lifeMaxBase + roundHalfUp10(base + extra) - roundHalfUp10(base) + (entity.armor || 0) + (entity.illusion || 0) + chaseBonusNow());
    if (newMax !== entity.lifeMax || shieldHit) {
      const delta = newMax - entity.lifeMax;
      entity.life = Math.max(1, Math.min(newMax, entity.life + delta + shieldHit + cpCbFreed));   // CP: avenger_refund — a max-only chase point never took a life point
      if (newMax !== entity.lifeMax) console.log(`[${PEER_LABEL}] life max ${entity.lifeMax} → ${newMax} (tokens ${extra >= 0 ? '+' : ''}${extra}${entity.armor ? ', armor' : ''}${entity.illusion ? ', illusion' : ''}), life ${entity.life}`);
      entity.lifeMax = newMax;
    }
  }
  // Building turn-end powers (user ruling 2026-11-12): whoever stands on the building when the turn's
  // 3rd action resolves. My own state only — the walls travel in my obstacles_json, the map in map blocks.
  if (entity.life > 0 && hg.round === ROUNDS_PER_TURN - 1) {
    const bb = buildingBonusAt(MAP_SEED, entity.tile.q, entity.tile.r);
    const pw = bb?.kind === 'building' ? bb.bonus.power : null;
    const at = `${bb?.source} (${entity.tile.q},${entity.tile.r})`;
    const tell = (t) => { console.log(`[${PEER_LABEL}] building ${at}: ${t}`); broadcastUI(handMsg({ notice: `⌂ ${bb.source}: ${t}` })); };
    if (pw?.kind === 'mend' && entity.life < entity.lifeMax) { const g = Math.min(Number.isInteger(pw.n) && pw.n > 0 ? pw.n : 1, entity.lifeMax - entity.life); entity.life += g; tell(`+${g} life at the end of the turn`); }   // CP: shrine_heal_n — the Priest's Shrine heals 2 (pick 2026-11-19 #5 a)
    if (pw?.kind === 'hurt') { entity.life = Math.max(0, entity.life - 1); tell('a curse takes 1 life at the end of the turn'); }
    if (entity.kind === 'character' && pw?.kind === 'draw') { entity.buildingDraw = 1; tell('you draw one more card for the next turn'); }
    // Schools teach once, then stay explored for LEARN_REARM_TURNS (world edit `lrn:q,r` { explored }).
    const lrnId = `lrn:${entity.tile.q},${entity.tile.r}`;
    const lrnEd = pw?.kind === 'learn' ? [...worldLens(view).edits.values(), ...entity.worldEdits].filter(e => e.id === lrnId && Number.isInteger(e.explored)).sort((a, b) => b.explored - a.explored)[0] : null;
    if (entity.kind === 'character' && pw?.kind === 'learn' && EFFECTS_IMPLEMENTED.length && !dungeonExplored(lrnEd, hg.turn, LEARN_REARM_TURNS)) {
      const h = sha256Hex(`${MAP_SEED}:${lrnId}:${hg.turn}`);
      const c = makeEffectCard(EFFECTS_IMPLEMENTED[parseInt(h.slice(0, 8), 16) % EFFECTS_IMPLEMENTED.length]);
      discard.push(c);
      entity.worldEdits = entity.worldEdits.filter(e => e.id !== lrnId);
      entity.worldEdits.push({ id: lrnId, explored: hg.turn, at: hg.action });
      tell(`you learn ${c.name} — the card joins your discard pile (${deck.length + discard.length + hand.length} cards); the ${bb.source} is explored until turn ${hg.turn + LEARN_REARM_TURNS}`);
    }
    if (entity.kind === 'character' && pw?.kind === 'explore') {
      const far = exploreTarget(MAP_SEED, entity.tile.q, entity.tile.r, hg.turn);
      revealAround(far.q, far.r).catch(e => console.warn(`[${PEER_LABEL}] explore failed: ${e.message}`));
      tell(`a far place is explored around (${far.q},${far.r})`);
    }
    if (entity.kind === 'character' && pw?.kind === 'walls') {
      const tag = `bw:${entity.tile.q},${entity.tile.r}:`;
      const occ = new Set([...livePeers()].filter(p => p && p.life > 0).map(p => `${p.tile_q},${p.tile_r}`));
      occ.add(`${entity.tile.q},${entity.tile.r}`);
      // Each turn adds an arc (they pile up — every arc lasts three turns); hexes already walled are skipped.
      for (const p of livePeers()) { try { for (const o of JSON.parse(p?.obstacles_json || '[]')) occ.add(`${o.q},${o.r}`); } catch {} }
      for (const o of entity.obstacles) occ.add(`${o.q},${o.r}`);
      const arc = wallArc(MAP_SEED, entity.tile.q, entity.tile.r, hg.turn).filter(h => !occ.has(`${h.q},${h.r}`) && !isLabyrinthWallAt(MAP_SEED, h.q, h.r) && !buildingPowerAt(h.q, h.r));
      arc.forEach((h, i) => entity.obstacles.push({ id: `${tag}${hg.turn}#${i}`, q: h.q, r: h.r, hp: 6, elem: 'elem_earth', wall: true, until_turn: hg.turn + 3, label: `${bb.source} wall` }));
      if (arc.length) tell(`${arc.length} wall hexes rise 5 hexes away (for 3 turns)`);
    }
  }
  if (wasAlive && entity.life <= 0) {
    console.log(`[${PEER_LABEL}] DIED at (${entity.tile.q},${entity.tile.r}) after -${myDmg} on T${hg.turn}.R${hg.round + 1} (life_max=${entity.lifeMax})`);
    // Tell the relays at once: peers on other machines would otherwise keep me alive as a stale shadow.
    setTimeout(() => publishPublicState(true).catch(() => {}), 0);
    try { dropDeathCard(damage.get(PEER_ID_STRING)); } catch (e) { console.warn(`[${PEER_LABEL}] death card failed: ${e.message}`); }
    // Possess (2026-11-17): nobody plays the possessed creature any more — my Possess / Phylactery falls with me (the
    // creature leaves the board, its card back to my archive).
    { const pp = possessPermOf(entity.permanents); if (pp) { console.log(`[${PEER_LABEL}] possess: I died — my ${entity.possessMode === 'phylactery' ? 'Phylactery' : 'Possess'} permanent falls with me`); dropPermanent(pp); } }
    // A Fortress token lasts until Rule 24 destroys it or I die (2026-11-15) — a Resurrect does not bring it back.
    const fzLost = entity.statTokens.filter(t => t.effect_id === FORTRESS_TOKEN_EFFECT);
    if (fzLost.length) { entity.statTokens = entity.statTokens.filter(t => t.effect_id !== FORTRESS_TOKEN_EFFECT); console.log(`[${PEER_LABEL}] death: my Fortress token(s) ${fzLost.map(t => `${t.stat} +${t.value}`).join(', ')} are gone`); }
  }
  // Permanents land in the NEXT round's snapshot, so they take effect from
  // then on — the reveal that placed them embedded the pre-placement state.
  const permsBefore = permanentsCsv();
  const myR = byActor.get(PEER_ID_STRING);
  // Sanctuary lasts while I rest: declaring anything but the plain Empty
  // Posture — another action, a trance, or a skill riding on the EP — ends it
  // from the next round (damage this round was already judged on the EP).
  // Skill isolation: every held "invincible while" skill (flags.invincibleWhile) asks its end_round; the effect
  // shields spent this action (resolveAction's brokenShield ids) drop with their power.
  for (const p of [...entity.permanents]) if (SKILL_RULES[p]?.invincibleWhile && skillHook('end_round', p, null, { reveal: myR })) entity.permanents.delete(p);   // S1 end_round
  for (const p of brokenShield) { entity.permanents.delete(p); delete entity.permPower[p]; console.log(`[${PEER_LABEL}] ${(data.skills[p]?.name || p).toLowerCase()} spent`); }
  const playedCodes = myR?.trance ? new Set([...myR.played].map(i => myR.trance[i])) : null;
  for (const { id, stat: st, power /* SKR-10 fixed power */ } of skillHook('perm_landing', null, { skillData: (s) => data.skills[s]?.data }, { skillIds: (myLastReveal?.skillIds || []).filter(id => !myLastReveal.skStripped?.includes(id)) /* S4 */, playedCodes, stats: entity.stats })) {   // S1 perm_landing
    {
      entity.permanents.add(id);
      // Rule 12: a permanent is placed with a point-buy of its stat; the highest
      // die is its power (what Rule 24 must beat; what Force Shield spends).
      // SKR-13 Force Shield "always power 6" (ruling 2026-11-16): a fixed landing power, no roll.
      entity.permPower[id] = Number.isInteger(power) ? power : pointBuyPermanent(entity.stats[st] ?? 0, `${myLastReveal.salt}:perm:${id}:${hg.action}`, sha256Hex);
      console.log(`[${PEER_LABEL}] permanent ${id} up: die ${entity.permPower[id]} (${Number.isInteger(power) ? 'fixed power' : `${st} ${entity.stats[st]}`})`);
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
      return { id: p.peer_id, tile: [t.q, t.r], life: Math.max(0, (p.life ?? 0) - sumDmg(damage.get(p.peer_id))), ...(fxRes?.tags.get(p.peer_id) ? { fx: fxRes.tags.get(p.peer_id) } : {}), ...(skRes?.tags.get(p.peer_id) ? { sk: skRes.tags.get(p.peer_id) } : {}), ...(clRes?.tags.get(p.peer_id) ? { cl: clRes.tags.get(p.peer_id) } : {}) };   /* S4: foreign skills only; CH: foreign classes only */   // E4: foreign casts only
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const stateHash = digestObj(regionState);
  if (!fxRes?.abstain && !skRes?.abstain /* S4 */ && !clRes?.abstain /* CH */ && !clVer.abstain /* phase 6 */ && !fxVer.abstain /* F9 */ && !skVer.abstain /* SV */) lastStateHashes.set(hg.action, { hash: stateHash, region: regionState });   // E4: abstain = a foreign def I could not load
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
      const el = Object.keys(ELEM_TO_STAT).find(x => ELEM_TO_STAT[x] === d.stat);
      if (el) return d.elem && ELEM_TO_STAT[d.elem] === d.stat ? d.elem : el;
    }
    // No cast and no destroy: only a Reaver's Attack or a Monk's Move pushes
    // the adept element (same test as the resolver's emitsNow). A bare
    // Posture / Attack / Move by anyone else emits nothing — before, every
    // action badged the adept element (Oran Rief's Vitality on every unit).
    const act = source?.action;
    const trance = Array.isArray(source?.trance) ? source.trance : null;
    // (classOf() lives in the per-action closure, not here — read the class off
    // the same permanents it does: mine from the entity, others' from the view.)
    const perms = actorId === PEER_ID_STRING ? [...entity.permanents] : String(view.get(actorId)?.permanents_csv || '').split(',');
    const cls = perms.find(p => p.startsWith('class_') && CLASSES_IMPLEMENTED.has(p)) || null;
    const anyEmit = (trance ? trance : [act]).some(c => classHook('emits', cls, CL_BASE, { code: c, site: 'badge' }));   // C1 emits site badge (Reaver A, Monk M)
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
  // What this action did to the actor's cast, for the over-unit icons everyone
  // sees: 'retry' (point-buy failed — the element re-emits next action, the
  // count stands), 'casting' (element out, more to come), 'done', 'blocked';
  // a channel whose stat no longer holds reports 'channel_broken'.
  const castOutcome = (actorId, eff) => {
    if (!eff) return null;
    const o = effectOutcomes.find(x => x.actor === actorId && !x.bonus && !x.channel && x.eff?.effect_id === eff.effect_id);
    return { effect_id: eff.effect_id, name: eff.name, step: eff.step ?? 1, of: eff.of ?? 1, status: o?.oc?.status || 'casting', rolls: o?.oc?.rolls || [] };
  };
  const brokenChannels = (actorId) => channelsBroken.filter(cb => cb.owner === actorId && !cb.why).map(cb => cb.effect_id);
  // What my Rule 24 emission broke this action (perm / token / class colour) — a vanishing "break" pill.
  const brokeBy = (actorId) => [...destroyOutcomes.filter(d => d.actor === actorId && (d.result === 'destroyed' || d.result === 'taken')).map(d => ({ kind: d.kind, id: d.id, owner: d.owner, result: d.result, ...(d.label ? { label: d.label } : {}) })),
    ...classOutcomes.filter(c => c.actor === actorId && c.ok && c.owner !== actorId).map(c => ({ kind: 'class', id: c.class_id, owner: c.owner, stat: c.stat, result: c.kind }))];
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
      cast: castOutcome(r.actor, r.effect), channel_broken: brokenChannels(r.actor), broke: brokeBy(r.actor), combo: comboDone.get(r.actor) || null, combo_step: comboStep.get(r.actor) || null,
      trance: r.trance || null, played: r.trance ? [...r.played].sort() : null,
      from_q: actor.tile_q, from_r: actor.tile_r,
      target_q: aim?.q, target_r: aim?.r,
    });
  }
  await emitEnvelope({ type: 'evt_state_hash', payload: {
    state_hash: fxRes?.abstain || skRes?.abstain || clRes?.abstain || clVer.abstain /* phase 6: class version gate */ || fxVer.abstain /* F9: effect version gate */ || skVer.abstain /* SV: skill version gate */ ? '' : stateHash,   // S4: abstain also = a foreign skill I could not load; CH: … or a foreign class
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
  // Autosave: an action has resolved — regardless of whether traps / tokens /
  // obstacles changed in this one, mark the state dirty so a quiet turn still
  // rolls to disk. The resolver's push / filter sites above also mark dirty
  // for the specific mutation, so this call is a safety net.
  _autosave?.markDirty();
  // Combo tracker (user ruling 2026-11-05): if I activated a combo and this
  // round's reveal was mine, advance / reset / fire. M-slot accepts M/EM/EP/P.
  // The 1 dmg to adjacent enemy on completion is applied inside doResolution()
  // so it feeds the shared damage map + state hash; here we just advance the
  // local counter so the next snapshot shows the right slot.
  if (entity.comboState?.active && myLastReveal) {
    const seq = Array.isArray(entity.combo) ? entity.combo : [];
    if (!seq.length) { entity.comboState = { active: false, slot: 0 }; }
    else {
      // myLastReveal keeps the played code as `code` (doReveal); `.action` never
      // existed there, so every combo used to reset after its first action.
      const played = String(myLastReveal.code || myLastReveal.action || '').toUpperCase();
      const slot = entity.comboState.slot | 0;
      const need = String(seq[slot] || '').toUpperCase();
      // User ruling 2026-11-05: EM/EP are the Empty slot's two faces and
      // substitute for either M or P. M and P never substitute for each
      // other. A- and B-slots are strict.
      const matches = (need === played)
        || (need === 'M' && (played === 'M' || played === 'EM' || played === 'EP'))
        || (need === 'P' && (played === 'P' || played === 'EM' || played === 'EP'));
      if (!matches) {
        console.log(`[${PEER_LABEL}] combo ${seq.join('')}: slot ${slot + 1} needed ${need}, got ${played} — reset`);
        entity.comboState = { active: false, slot: 0 };
      } else if (slot + 1 >= seq.length) {
        console.log(`[${PEER_LABEL}] combo ${seq.join('')} COMPLETE`);
        entity.comboState = { active: false, slot: 0 };
      } else {
        console.log(`[${PEER_LABEL}] combo ${seq.join('')}: slot ${slot + 1}/${seq.length} ✓ (${played})`);
        entity.comboState = { active: true, slot: slot + 1 };
      }
    }
  }
  const returned = new Set(myLastReveal?.returnedCardIds || []);
  const playedIds = new Set((myLastReveal?.skillCardIds || []).filter(id => !returned.has(id)));
  // Haste bonus round: its action card, skills and instant are spent too.
  for (const b of (myLastReveal?.bonus || []).slice(0, myLastReveal?.bonusUsed ?? 0)) for (const id of [b.cardId, b.extraCardId, ...b.skillCardIds, b.effectCardId]) if (id && !returned.has(id)) playedIds.add(id);
  // A negated action (Intimidation, Bluff, Grapple, …) never happened: its card stays in my hand.
  if (!myLastReveal?.actionNegated) for (const id of myPlayedCardIds || (myLastReveal?.cardId ? [myLastReveal.cardId] : [])) playedIds.add(id);
  else console.log(`[${PEER_LABEL}] my ${myLastReveal.code} was negated — its card returns to my hand`);
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
        && (entity.permanents.has(r.effectId) || (isPossessPerm(r.effectId) && entity.possessing?.card_id === r.effectCardId));   // Possess stands in the possessed unit's holding; its card stays mine
      const leave = held ? holdCard : dropCard;
      leave(r.effectCardId); if (r.effectCardId2) leave(r.effectCardId2);
    }
    const emitted = retry ? ch.step - 1 : ch.step;
    if (r.castKept) { const at = chainAt(ch.entries, ch.step); if (at) at.entry.kept = r.castKept; }
    if ((emitted >= ch.total || (complete && ch.entries.length === 1)) && !retry) {
      casting = null;
      if (ch.aura) { const w = everyWidener(); if (w) { dropPermanent(w); console.log(`[${PEER_LABEL}] ${w} ∀ spent on ${ch.entries.map(e => e.effectId).join('→')}`); } }
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
  if (myLastReveal?.empowered && planEmitSpends && entity.permanents.has(planEmitSpends)) { dropPermanent(planEmitSpends); console.log(`[${PEER_LABEL}] ${planEmitSpends} spent`); }
  planEmitSpends = null;
  // Invisibility (user ruling 2026-11-14) is destroyed once I use Attack or Block or start casting a spell
  // (its `breaks` program — the same test the resolver used to unhide me this action, bonus plans included);
  // doubled (∀) it holds until I actually deal damage.
  const hp = hidingPerm(entity.permanents);
  if (hp && myLastReveal) {
    const plays = [{ action: myLastReveal.code, trance: myLastReveal.code === 'BT' ? myLastReveal.trance : null, effect_id: myLastReveal.effectId },
      ...(myLastReveal.bonus || []).slice(0, myLastReveal.bonusUsed ?? 0)];
    const every = entity.everyPerms.has(hp);
    const why = !hideBreaks(hp, PEER_ID_STRING, plays, myLastReveal.dealtDamage, every, invisCodesOf(entity.permanents)) ? null
      : every ? 'dealt damage (∀)' : (myLastReveal.effectId && myLastReveal.effectId !== hp ? `cast ${myLastReveal.effectId}` : `played ${myLastReveal.code}`);
    if (why) { dropPermanent(hp); console.log(`[${PEER_LABEL}] invisibility broken: ${why} — the permanent is destroyed`); }
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
    // Carry the fresh action's queued state through to the UI so an auto-
    // requeued cast (Rule 19 continuation of a multi-element effect) shows
    // the same effect card re-queued with a Posture, instead of leaving the
    // player a blank hand to re-pick manually.
    broadcastUI(handMsg({ queued, queued_skills: queuedSkills, queued_extra: queuedExtra, queued_effect: queuedEffect, queued_effect2: queuedEffect2 }));
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
  const handCap = HAND_SIZE + [...entity.everyPerms].reduce((s, p) => s + (EFFECT_RULES[p]?.everyHandSize || 0), 0) + (entity.buildingDraw || 0);
  entity.buildingDraw = 0;
  while (hand.length < handCap) { reshuffleIfEmpty(); if (!deck.length) break; hand.push(deck.shift()); }

  // Guardian: static ability — "when you stay on one tile for a whole round
  // (= one turn here) restore one life token" (paper Rule 9 + class_guardian).
  // movedThisRound is set true by the resolver whenever my own tile changed;
  // reset after the check so the next turn's bookkeeping is clean. Dead
  // characters do not regen.
  // C1 end_turn: +1 life for a held Guardian that never moved this turn.
  for (const gc of Object.keys(CLASS_RULES).filter(id => (CLASS_RULES[id].hooks || []).includes('end_turn'))) if (entity.classFlags) {
    // Once per TURN, at its end (user ruling 2026-11-12, classes.json 1.1.0) — never at an action's end.
    const heal = classHook('end_turn', gc, CL_BASE, { held: entity.permanents.has(gc), moved: !!entity.classFlags.movedThisRound, life: entity.life, lifeMax: entity.lifeMax, movedRounds: [...(entity.classFlags.movedRounds || [])] });   // CR: guardian_heal — still on the 2nd and 3rd action
    if (heal > 0) {
      entity.life += heal;
      console.log(`[${PEER_LABEL}] guardian: stayed on my tile through the 2nd and 3rd action — +1 life (${entity.life}/${entity.lifeMax})`);
      broadcastUI(handMsg({ notice: `🛡 Guardian: you stayed on your tile through the 2nd and 3rd action — +1 life (${entity.life}/${entity.lifeMax})` }));
    }
  }
  if (entity.classFlags) entity.classFlags.movedThisRound = false;
  if (entity.classFlags) entity.classFlags.movedRounds = [];   // CR: guardian_reset

  hg.round = 0; hg.turn += 1;
  // Building walls stand for three turns.
  entity.obstacles = entity.obstacles.filter(o => !o.until_turn || o.until_turn >= hg.turn);
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
      region_state_hash: hg.lastStateHash || '',
      positions: Object.fromEntries([...peersPublic.values()].map(p => [p.peer_id, { q: p.tile_q, r: p.tile_r }])),
      hashgraph_head: hg.head,
      draws: [{ peer_id: PEER_ID_STRING, cards_drawn: hand.length - before }],
    },
  });
  broadcastUI(handMsg({ turn_end: true, queued, queued_skills: queuedSkills, queued_extra: queuedExtra, queued_effect: queuedEffect, queued_effect2: queuedEffect2 }));
}

// NPC-side mirror of permStats() inside doResolution: the stat set a
// permanent can be destroyed by. Effects derive from element_cost →
// ELEM_TO_STAT; skills take point_buy_stat (strip 'stat_'; 'any' means all
// four). Used only for the opportunistic Rule-24 pick below.
const _ELEM_TO_STAT = { elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' };
function _npcPermStats(permId) {
  if (!permId) return [];
  if (permId.startsWith('skill_')) return skillHook('perm_stats', permId, { skillData: (s) => data.skills[s]?.data });   // S1 perm_stats
  const out = new Set();
  for (const el of data.effects[permId]?.data?.element_cost || []) if (_ELEM_TO_STAT[el]) out.add(_ELEM_TO_STAT[el]);
  return [...out];
}
// Among the enemies that will see my emission this action, pick the best
// (stat, permanent) pair — my stat ≥ perm.power so a successful roll can beat
// it, and the biggest gain over the power. Returns null if nothing matches.
function _npcPickDestroy(enemies) {
  let best = null;
  for (const e of enemies) {
    let pp = {};
    try { pp = JSON.parse(e.perm_power_json || '{}') || {}; } catch {}
    const ids = String(e.permanents_csv || '').split(',').filter(Boolean);
    for (const pid of ids) {
      if (pid.startsWith('class_')) continue;
      for (const st of _npcPermStats(pid)) {
        const myS = entity.stats[st] || 0;
        const pow = pp[pid] || 1;
        if (myS < pow) continue;
        const gain = myS - pow;
        if (!best || gain > best.gain) best = { stat: st, gain, pid };
      }
    }
  }
  return best;
}

const IS_GOLEM = !!CREATURE_ID && data.creatures[CREATURE_ID]?.data?.built_in === 'golem';
// Bot casting (user rulings 2026-11-15, rule_monster_deck_effects; choice logic in game/monster-deck.mjs).
// Wild monsters cast their monster deck; since the ruling "allied npc_a heroes and summons also cast their effect
// cards → yes" every other bot-driven unit (npc_a / npc_c heroes, companions, summons, bound creatures) casts the
// effect cards of its own deck too (ally mode: it also heals / brews for its side, Meteor Shower spares its side).
// Human hands (IS_HUMAN, incl. HUMAN=1 profile heroes on a bot side) never reach npcPlan.
// Returns true when this action's plan is a cast (started or carried on): Posture card or Empty Posture, never
// a move (Rule 19), the effect card queued, aimed at an enemy (or, ally mode, a friend) for target effects.
// Hand-only bookkeeping, so the randomness (cast chance) is the unit's own — the plan is committed / revealed like any other.
const NPC_CASTS = !IS_HUMAN && (IS_MONSTER || MONSTER_DECK_CFG.ally_cast !== false);
const NPC_CAST_TAG = IS_MONSTER ? 'monster cast' : 'npc cast';
let npcCastAim = null;   // the unit my running cast is aimed at
function npcCast(enemies, nearest) {
  const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
  const pIdx = hand.findIndex(c => c.kind === 'action' && c.code === 'P');
  const plan = (idx, aim) => { queued = [pIdx >= 0 ? pIdx : 'EMPTY']; queuedSkills = []; queuedExtra = null; queuedDestroy = null; queuedEffect = idx; queuedEffect2 = null; queuedChain = []; queuedAura = false; target = aim; npcCastAim = aim; };
  const friendSnaps = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && (p.life ?? 0) > 0 && sideOf(p.alliance) === MY_SIDE && Number.isInteger(p.tile_q));
  // A cast in progress goes on (endRound re-queued its card) — still at the unit I aimed at while it stands.
  if (casting && typeof queuedEffect === 'number' && hand[queuedEffect]?.kind === 'effect') {
    const c = hand[queuedEffect];
    const still = npcCastAim && (enemies.some(p => p.peer_id === npcCastAim) || friendSnaps.some(p => p.peer_id === npcCastAim)) ? npcCastAim : null;
    const aim = still || (c.scope === 'target' ? nearest?.peer_id || null : null);
    plan(queuedEffect, aim);
    console.log(`[${PEER_LABEL}] ${NPC_CAST_TAG}: ${c.effect_id} goes on (${casting.emitted} emitted)${aim ? ` at ${aim.slice(0, 14)}` : ''}`);
    return true;
  }
  npcCastAim = null;
  // A card I can never use, with no action card left in hand, goes back to my discard pile (it circulates on).
  // Monsters (user ruling 2026-11-15: "players have that option too, so it is fair") and allied bots alike:
  // a bot hero / summon whose hand holds only cards its AI never casts would stand still the same way.
  if (!hand.some(c => c.kind === 'action')) {
    const i = hand.findIndex(c => npcStuckCard(c, entity.stats, EFFECT_RULES, MONSTER_DECK_CFG, !IS_MONSTER));
    if (i >= 0) { const [c] = hand.splice(i, 1); discard.push(c); console.log(`[${PEER_LABEL}] ${IS_MONSTER ? 'monster' : 'npc'} deck: ${c.effect_id} unusable for me — back to my discard pile`); }
  }
  if (!hand.some(c => c.kind === 'effect')) return false;
  const statsOf = (p) => ({ vitality: p.stat_vitality ?? 0, world: p.stat_world ?? 0, matter: p.stat_matter ?? 0, will: p.stat_will ?? 0 });
  const foes = enemies.map(p => ({ peer_id: p.peer_id, dist: hexDistance(here, p), life: p.life ?? 0, stats: statsOf(p) }));
  const friends = friendSnaps.map(p => ({ peer_id: p.peer_id, dist: hexDistance(here, p), life: p.life, lifeMax: p.life_max ?? null }));
  const ch = npcCastChoice({ hand, me: { stats: entity.stats, life: entity.life, lifeMax: entity.lifeMax, permanents: entity.permanents }, foes, friends, rules: EFFECT_RULES, cfg: MONSTER_DECK_CFG, ally: !IS_MONSTER });
  if (!ch) return false;
  const c = hand[ch.index];
  plan(ch.index, ch.target);
  const onFriend = ch.target && friends.some(p => p.peer_id === ch.target);
  console.log(`[${PEER_LABEL}] ${NPC_CAST_TAG}: start ${c.effect_id} (${ch.kind}, ${c.element_cost.join('+')}) ${ch.target ? `${onFriend ? 'on ally' : 'at'} ${ch.target.slice(0, 14)}` : 'on myself / around me'} — ${pIdx >= 0 ? 'Posture' : 'Empty Posture'}`);
  return true;
}
// ---- AI skirmish (2026-11-22): the llama-server pick (llm-brain.mjs) ----
// llmKick() when the planning window opens: the options that are legal for this action (built from the same view the
// rules use) go to the model. npcPlan() at the deadline runs the rules, then llmApply() replaces their pick by the
// model's option when the answer is in, still legal and the rules left the pick free (awake, no owner to follow, no
// cast running — Rule 19). No answer in time → the rules' plan stands. Private plan only: no resolver change.
let npcFree = false;         // npcPlanRules reached the free pick (weighted A/M/P/B, cast start, idle heal)
let llmTurn = null;          // { action, options, answer, read }
let llmDownUntil = 0;        // server unreachable: rules only until then
let llmLastSay = -99;        // hg.action of my last line
let pendingSay = null;       // { action, text } — goes out with this action's reveal
let builderBuiltTurn = -1;   // the engine turn my last Barricade rose in (one per turn)
const llmStats = { asked: 0, used: 0, late: 0, failed: 0 };
const recentActs = new Map();   // peer_id -> its last revealed action codes (≤ 3, newest last): habits the model reads
const recentSeen = new Set();
function noteRecentAct(id, code) {
  if (!id || typeof code !== 'string' || id === PEER_ID_STRING) return;
  const k = `${hg.action}:${id}`;
  if (recentSeen.has(k)) return;
  recentSeen.add(k); if (recentSeen.size > 500) recentSeen.clear();
  const a = recentActs.get(id) || []; a.push(code); if (a.length > 3) a.shift(); recentActs.set(id, a);
}
function takeSay() {
  const s = pendingSay && pendingSay.action === hg.action ? pendingSay.text : '';
  pendingSay = null;
  return s;
}
// The units the rules treat as enemies (seen, alive, other side; Rogue stealth hides beyond contact).
function npcEnemies() {   // merge 2026-11-22: HEAD's filter (F3 flag `hides`, class isolation 'threat' charge)
  const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
  return livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && sideOf(p.alliance) !== MY_SIDE && p.life > 0
    && !(snapInvisible(p) && !hidingPerm(entity.permanents))   // Invisibility: monsters / companions neither see nor chase it
    && !(CS.anyChargeUsed(csOf(p), 'threat', hg.turn) && hexDistance(here, p) > 1));
}
const _nameOf = (p) => p?.name || String(p?.peer_id || '?').slice(0, 12);
// The numbered options for this action: { label (what the model reads), plan }. null = the rules decide alone.
function llmOptions() {
  if (entity.life <= 0 || casting || entity.monsterState === 'sleeping' || IS_COMPANION || SHADOW_OF || entity.lostActions > 0) return null;
  const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
  const dist = (p) => hexDistance(here, p);
  const enemies = npcEnemies().sort((a, b) => dist(a) - dist(b) || a.peer_id.localeCompare(b.peer_id));
  const lurer = entity.luredBy ? enemies.find(p => p.peer_id === entity.luredBy.id) : null;   // Avenger lure: my only prey
  const has = (code) => hand.some(c => c.kind === 'action' && c.code === code);
  const occ = new Set(livePeers().filter(p => p && p.life > 0 && p.peer_id !== PEER_ID_STRING).map(p => `${p.tile_q},${p.tile_r}`));
  const freeNear = hexNeighbours(entity.tile.q, entity.tile.r).filter(t => dimMap.has(t.q, t.r) && !occ.has(`${t.q},${t.r}`) && !isLabyrinthWallAt(MAP_SEED, t.q, t.r) && !buildingFeatureAt(MAP_SEED, t.q, t.r));
  const opts = [];
  for (const e of (lurer ? [lurer] : enemies).slice(0, 4)) {
    const d = dist(e);
    if (d <= 1 && has('A')) opts.push({ label: `Attack ${_nameOf(e)}`, plan: { code: 'A', target: e.peer_id } });
    else if (d > 1 && !IS_GOLEM && AI_ROLE !== 'builder') opts.push({ label: `Move toward ${_nameOf(e)}`, plan: has('M') ? { code: 'M', target: e.peer_id } : { code: 'EM', target: { q: e.tile_q, r: e.tile_r } } });
  }
  // Hurt with an enemy in contact: one step away from the nearest one (a Move card, else an Empty Move).
  const near = enemies[0];
  if (near && dist(near) <= 1 && !IS_GOLEM && entity.life * 2 <= entity.lifeMax && AI_ROLE !== 'monster') {
    const away = freeNear.map(t => ({ t, d: hexDistance({ tile_q: t.q, tile_r: t.r }, near) })).sort((a, b) => b.d - a.d || a.t.q - b.t.q || a.t.r - b.t.r)[0];
    if (away && away.d > 1) opts.push({ label: `Step back away from ${_nameOf(near)}`, plan: { code: has('M') ? 'M' : 'EM', target: { q: away.t.q, r: away.t.r } } });
  }
  if (has('B')) opts.push({ label: 'Block', plan: { code: 'B' } });
  opts.push(has('P') ? { label: 'Posture (gather an element)', plan: { code: 'P' } } : { label: 'Empty Posture (gather an element)', plan: { code: 'EP' } });
  // The cast the monster-deck chooser finds sensible now (its chance roll skipped: the model decides).
  if (NPC_CASTS && hand.some(c => c.kind === 'effect')) {
    const statsOf = (p) => ({ vitality: p.stat_vitality ?? 0, world: p.stat_world ?? 0, matter: p.stat_matter ?? 0, will: p.stat_will ?? 0 });
    const friendSnaps = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && (p.life ?? 0) > 0 && sideOf(p.alliance) === MY_SIDE && Number.isInteger(p.tile_q));
    const ch = npcCastChoice({ hand, me: { stats: entity.stats, life: entity.life, lifeMax: entity.lifeMax, permanents: entity.permanents },
      foes: enemies.map(p => ({ peer_id: p.peer_id, dist: dist(p), life: p.life ?? 0, stats: statsOf(p) })),
      friends: friendSnaps.map(p => ({ peer_id: p.peer_id, dist: dist(p), life: p.life, lifeMax: p.life_max ?? null })),
      rules: EFFECT_RULES, cfg: MONSTER_DECK_CFG, ally: !IS_MONSTER, rand: () => 0 });
    if (ch) {
      const c = hand[ch.index];
      const at = ch.target ? livePeers().find(p => p?.peer_id === ch.target) : null;
      opts.push({ label: `Cast ${c.name || c.effect_id}${at ? ` at ${_nameOf(at)}` : ''} (${c.element_cost.length} action${c.element_cost.length === 1 ? '' : 's'})`, plan: { cast: ch.index, cardId: c.card_id, aim: ch.target || null } });
    }
  }
  // Builder: the ring wall (builderRingPlan) first; once it stands (or can't be reached), one Barricade a turn next to
  // me, never with an enemy in contact — the hex nearest the nearest enemy first.
  const ringOpt = AI_ROLE === 'builder' && !(near && dist(near) <= 1) ? builderRingPlan() : null;
  if (ringOpt) opts.unshift(ringOpt);
  // No Barricades around myself while ring work is left (user 2026-11-23: "they are building a wall around themselves").
  else if (AI_ROLE === 'builder' && ringFinished() && builderBuiltTurn !== hg.turn && !(near && dist(near) <= 1)) {
    const code = has('P') ? 'P' : 'EP';
    const spots = near ? [...freeNear].sort((a, b) => hexDistance({ tile_q: a.q, tile_r: a.r }, near) - hexDistance({ tile_q: b.q, tile_r: b.r }, near) || a.q - b.q || a.r - b.r) : freeNear;
    spots.slice(0, 3).forEach((t, i) => opts.push({ label: `Build a barricade ${i === 0 && near ? `between you and ${_nameOf(near)}` : `on free hex ${i + 1} next to you`}`, plan: { code, build: { q: t.q, r: t.r } } }));
  }
  return opts.slice(0, 9);
}
// Banter (user 2026-11-23, llm-brain.mjs askBanter): my UI asks for a short funny scene between the units it sees
// ({kind:'banter', ids}); ONE bulk request writes every line, the answer goes back to my UI only ({kind:'banter',
// lines:[{peer_id, text}]}) and is shown as speech balloons. Cosmetic: not in any plan, reveal or the state hash.
// Local llama-server first, then the OCI route (LLM_REMOTE_URL / <profile dir>/llm.json) — e.g. on a phone.
let banterBusy = false, banterAt = 0;
async function banterFor(ids) {
  if (banterBusy || Date.now() - banterAt < 15_000 || !Array.isArray(ids)) return;
  const bare = (n) => String(n || '').replace(/^(Builder|Rival|Ally) — /, '');
  const me = peersPublic.get(PEER_ID_STRING) || { peer_id: PEER_ID_STRING, name: ENTITY_NAME, alliance: entity.alliance, human: IS_HUMAN ? 1 : 0, class_id: entity.classId, life: entity.life };
  const picked = [...new Set([PEER_ID_STRING, ...ids.map(String)])].map(id => id === PEER_ID_STRING ? me : peersPublic.get(id))
    .filter(p => p && (p.life ?? 0) > 0 && !p.out).slice(0, BANTER_MAX_UNITS);
  if (picked.length < 2) return;
  const units = picked.map(p => ({
    name: bare(p.name) || String(p.peer_id).slice(0, 12),
    what: data.classes[p.class_id]?.name || data.creatures[p.creature_id]?.name || '',
    role: p.ai_role || (p.peer_id === PEER_ID_STRING ? 'hero' : p.human ? (sideOf(p.alliance) === MY_SIDE ? 'team' : 'rival') : p.creature_id && sideOf(p.alliance) !== MY_SIDE ? 'monster' : 'team'),
    friend: sideOf(p.alliance) === MY_SIDE,
  }));
  banterBusy = true; banterAt = Date.now();
  try {
    const place = DIM_NAME.replace(/^(Real|GenTest)-/, '').replace(/-/g, ' ');
    let ans = await askBanter(LLM, { units, place });
    // a random hero has no PROFILE_FILE: the device's own llm.json (profile dir) still holds the OCI route (2026-11-23)
    const remote = remoteConfig(process.env, process.env.LLM_PROFILE_FILE || PROFILE_FILE || profilePath());
    if ((!ans || ans.error) && remote?.url) ans = await askBanter({ ...LLM, url: String(remote.url).replace(/\/+$/, ''), key: remote.key || '', signer: remote.signer }, { units, place });
    if (!ans || ans.error) { console.log(`[${PEER_LABEL}] banter: no answer (${ans?.error || 'model off'}, ${ans?.ms ?? '?'} ms)`); return; }
    console.log(`[${PEER_LABEL}] banter: ${ans.lines.length} lines for ${units.length} units in ${ans.ms} ms`);
    const fixed = fixSelfAddress(ans.lines, units.map(u => u.name));
    broadcastUI({ kind: 'banter', ms: ans.ms, lines: fixed.map(l => ({ peer_id: picked[l.who].peer_id, text: l.line })) });
  } finally { banterBusy = false; banterAt = Date.now(); }
}
let _llmSystem = null;
function llmKick() {
  llmTurn = null;
  if (Date.now() < llmDownUntil || !askThisAction(hg.action, PEER_ID_STRING, LLM.every)) return;
  const options = llmOptions();
  if (!options || options.length < 2) return;
  const budget = Math.min(LLM.timeoutMs, phaseEndsAt - Date.now() - 400);
  if (budget < 300) return;
  const action = hg.action;
  const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
  const unit = (p) => ({ name: _nameOf(p), life: p.life ?? 0, lifeMax: p.life_max ?? null, dist: hexDistance(here, p), recent: recentActs.get(p.peer_id) || [] });
  const foes = npcEnemies().map(unit).sort((a, b) => a.dist - b.dist);
  const friends = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && (p.life ?? 0) > 0 && sideOf(p.alliance) === MY_SIDE && Number.isInteger(p.tile_q) && !snapInvisible(p)).map(unit).sort((a, b) => a.dist - b.dist);
  const handTxt = hand.map(c => c.kind === 'action' ? c.code : c.kind === 'effect' ? (c.name || c.effect_id) : null).filter(Boolean).join(', ');
  _llmSystem ||= systemPrompt({ role: AI_ROLE, name: ENTITY_NAME });
  const user = userPrompt({ turn: hg.turn, round: hg.round, roundsPerTurn: ROUNDS_PER_TURN, me: { life: entity.life, lifeMax: entity.lifeMax, hand: handTxt }, foes, friends, options });
  const t = { action, options, answer: null, read: false };
  llmTurn = t;
  llmStats.asked++;
  llmRouter.ask({ system: _llmSystem, user, n: options.length, timeoutMs: budget }).then((ans) => {
    if (!ans || ans.error) {
      llmStats.failed++;
      if (ans?.down) { llmDownUntil = Date.now() + 30_000; console.log(`[${PEER_LABEL}] llm: no model reachable (${ans.error}) — rules only for 30 s`); }
      else if (llmStats.failed <= 3 || llmStats.failed % 20 === 0) console.log(`[${PEER_LABEL}] llm: no answer (${ans?.error || 'none'}, ${ans?.ms ?? '?'} ms) — the rules' plan stands`);
      return;
    }
    if (t.read || llmTurn !== t) { llmStats.late++; return; }
    t.answer = ans;
  });
  if (llmStats.asked % 30 === 0) { const r = llmRouter.stats; console.log(`[${PEER_LABEL}] llm stats (${AI_ROLE}): asked ${llmStats.asked}, used ${llmStats.used}, late ${llmStats.late}, failed ${llmStats.failed}; via local ${r.local}, team ${r.team}, remote ${r.remote}`); }
}
// The model's option replaces the rules' free pick. true when applied.
function llmApply() {
  const t = llmTurn;
  if (!t || t.action !== hg.action) return false;
  t.read = true;
  const ans = t.answer;
  if (!ans || !npcFree || casting) return false;
  const opt = t.options[ans.choice - 1];
  const p = opt?.plan;
  if (!p) return false;
  if (p.cast != null) {
    const c = hand[p.cast];
    if (!c || c.card_id !== p.cardId) return false;
    if (p.aim && !livePeers().some(x => x?.peer_id === p.aim && (x.life ?? 0) > 0)) return false;
    const pIdx = hand.findIndex(x => x.kind === 'action' && x.code === 'P');
    queued = [pIdx >= 0 ? pIdx : 'EMPTY']; queuedSkills = []; queuedExtra = null; queuedDestroy = null;
    queuedEffect = p.cast; queuedEffect2 = null; queuedChain = []; queuedAura = false; target = p.aim; npcCastAim = p.aim;
  } else {
    if (typeof p.target === 'string' && !livePeers().some(x => x?.peer_id === p.target && (x.life ?? 0) > 0)) return false;
    const empty = p.code === 'EP' || p.code === 'EM';
    const slot = empty ? -1 : hand.findIndex(c => c.kind === 'action' && c.code === p.code);
    if (!empty && slot < 0) return false;
    queuedEffect = null; queuedEffect2 = null; queuedChain = []; queuedAura = false; npcCastAim = null;
    queued = slot >= 0 ? [slot] : [p.code];
    const rides = slot >= 0 ? p.code : p.code === 'EM' ? 'M' : 'P';
    queuedSkills = hand.map((c, i) => c.kind === 'skill' && !c.is_trance && c.requires === rides ? i : -1).filter(i => i >= 0);
    queuedExtra = null;
    target = p.target ?? null;
    if (!(p.code === 'P' || p.code === 'EP' || clEmits(p.code))) queuedDestroy = null;
    queuedBuild = p.build || null;
    opt.onApply?.();   // builder ring wall: remember the site I am building
  }
  llmStats.used++;
  const say = ans.say && hg.action - llmLastSay >= LLM.sayEvery && !echoesOption(ans.say, opt.label) ? ans.say : '';
  if (say) { pendingSay = { action: hg.action, text: say }; llmLastSay = hg.action; }
  console.log(`[${PEER_LABEL}] llm (${AI_ROLE}): option ${ans.choice}/${t.options.length} "${opt.label}" in ${ans.ms} ms${ans.via && ans.via !== 'local' ? ` via ${ans.via}` : ''}${say ? ` — says "${say}"` : ''}`);
  return true;
}
// Builder ring wall (builder-ring.mjs, user 2026-11-23): walk out to the BUILDER_RING_RADIUS ring around (0,0) and
// raise it one Barricade a turn on my own arc. Planning only — the resolver checks each Barricade as before.
const BUILDER_RING = AI_ROLE === 'builder' ? ringHexes({ q: 0, r: 0 }, Number(process.env.BUILDER_RING_RADIUS ?? 20)) : [];
const BUILDER_HOME = homeIndex(PEER_LABEL, BUILDER_RING.length);
const ringSkip = new Set();   // sites I could not reach (walled off): the next one along
let ringWalk = { site: '', at: '', still: 0, action: -1 };
// Built = a Barricade on the map, or one of mine raised this turn (my world edit is there before the overlay syncs) or
// planned in the last 3 actions (the resolver would put a second one on a random hex next to me).
const ringPlanned = new Map();   // "q,r" -> hg.action I planned to build it
const isBarricadeAt = (q, r) => buildingFeatureAt(MAP_SEED, q, r)?.made_by === 'npc_builder' || (entity.worldEdits || []).some(e => !e.gone && e.id === `made:${q},${r}`)
  || hg.action - (ringPlanned.get(`${q},${r}`) ?? -99) <= 3;
function builderRingPlan() {
  if (!BUILDER_RING.length || entity.life <= 0) return null;
  const occ = new Set(livePeers().filter(p => p && p.life > 0 && p.peer_id !== PEER_ID_STRING).map(p => `${p.tile_q},${p.tile_r}`));
  const obs = new Set(livePeers().flatMap(p => { try { return JSON.parse(p?.obstacles_json || '[]').map(o => `${o.q},${o.r}`); } catch { return []; } }));
  const obstacleAtTile = (q, r) => obs.has(`${q},${r}`);
  const blocksStep = (q, r) => { const f = buildingFeatureAt(MAP_SEED, q, r); return !hexWalkableAt(MAP_SEED, q, r) || isLabyrinthWallAt(MAP_SEED, q, r) || !!(f && (f.kind === 'wall' || f.blocking)); };
  // Two builders never race for one site: a hex clearly nearer another live builder (by 2+) is its job, not mine.
  const meT = { tile_q: entity.tile.q, tile_r: entity.tile.r };
  const mates = livePeers().filter(p => p && p.peer_id !== PEER_ID_STRING && p.ai_role === 'builder' && (p.life ?? 0) > 0 && !p.out && Number.isInteger(p.tile_q));
  const theirs = (q, r) => { const t = { tile_q: q, tile_r: r }, mine = hexDistance(meT, t); return mates.some(b => hexDistance(b, t) + 2 <= mine); };
  const site = nextWallHex({ ring: BUILDER_RING, home: BUILDER_HOME, skip: ringSkip, built: isBarricadeAt,
    blocked: (q, r) => (!isBarricadeAt(q, r) && !!buildingFeatureAt(MAP_SEED, q, r)) || blocksStep(q, r) || obstacleAtTile(q, r) || occ.has(`${q},${r}`) || theirs(q, r) });
  // Done = the whole ring stands (or every site left is out of reach) — not merely "the rest is another builder's".
  if (!site) { builderRingPlan.done = !nextWallHex({ ring: BUILDER_RING, home: BUILDER_HOME, skip: ringSkip, built: isBarricadeAt,
    blocked: (q, r) => (!isBarricadeAt(q, r) && !!buildingFeatureAt(MAP_SEED, q, r)) || blocksStep(q, r) || obstacleAtTile(q, r) }); return null; }
  builderRingPlan.done = false;
  const me = { q: entity.tile.q, r: entity.tile.r }, key = `${site.q},${site.r}`, at = `${me.q},${me.r}`;
  if (builderRingPlan.site !== key) { builderRingPlan.site = key; console.log(`[${PEER_LABEL}] npc builder: next ring wall site (${key}) — I am at (${at}), ${Math.round(hexDistance({ tile_q: me.q, tile_r: me.r }, { tile_q: site.q, tile_r: site.r }))} hexes away`); }
  const step = ringStep({ me, site, free: (q, r) => !blocksStep(q, r) && !occ.has(`${q},${r}`) && !obstacleAtTile(q, r) });
  const has = (code) => hand.some(c => c.kind === 'action' && c.code === code);
  if (!step?.build) {
    // Walking but not getting anywhere for 6 actions (water, a wall line, a crowd): give this site up, take the next.
    if (!(ringWalk.site === key && ringWalk.at === at)) ringWalk = { site: key, at, still: 0, action: hg.action };
    else if (ringWalk.action !== hg.action) ringWalk = { ...ringWalk, still: ringWalk.still + 1, action: hg.action };   // once per action (asked at kick + deadline)
    if (ringWalk.still >= 6) { ringSkip.add(key); console.log(`[${PEER_LABEL}] npc builder: cannot reach the ring wall at (${key}) — the next site along`); return null; }
  }
  if (step?.build) {
    if (occ.has(key)) return null;   // somebody stands on the site: wait (the rules play)
    const code = has('P') ? 'P' : 'EP';
    return builderBuiltTurn === hg.turn ? { label: 'Rest by the ring wall', plan: { code } }
      : { label: `Raise the ring wall at (${key})`, plan: { code, build: { q: site.q, r: site.r } }, onApply: () => ringPlanned.set(key, hg.action) };
  }
  if (step?.stepTo) return { label: 'Walk to the ring wall site', plan: { code: has('M') ? 'M' : 'EM', target: step.stepTo } };
  return null;
}

// Builder without (or before) an answer — or with no enemy within 2 (the ring wall comes first): the ring plan; when the
// ring stands or can't be reached, Posture / Empty Posture and a Barricade on a free hex next to me once a turn (the
// resolver picks the hex from the reveal salt). In contact the rules' pick stands.
function builderFallback() {
  const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
  if (npcEnemies().some(p => hexDistance(here, p) <= 1)) return;
  queuedExtra = null; queuedEffect = null; queuedEffect2 = null; queuedChain = []; queuedAura = false; npcCastAim = null; target = null;
  const ring = builderRingPlan();
  if (ring) {
    const p = ring.plan, empty = p.code === 'EP' || p.code === 'EM';
    const slot = empty ? -1 : hand.findIndex(c => c.kind === 'action' && c.code === p.code);
    queued = slot >= 0 ? [slot] : [p.code];
    const rides = slot >= 0 ? p.code : p.code === 'EM' ? 'M' : 'P';
    queuedSkills = hand.map((c, i) => c.kind === 'skill' && !c.is_trance && c.requires === rides ? i : -1).filter(i => i >= 0);
    target = p.target ?? null;
    queuedBuild = p.build || null;
    ring.onApply?.();
    return;
  }
  const pi = hand.findIndex(c => c.kind === 'action' && c.code === 'P');
  queued = pi >= 0 ? [pi] : ['EP'];
  queuedSkills = hand.map((c, i) => c.kind === 'skill' && !c.is_trance && c.requires === 'P' ? i : -1).filter(i => i >= 0);
  if (builderBuiltTurn !== hg.turn && ringFinished()) queuedBuild = { q: null, r: null };   // a random hex next to me only once the ring is done
}
function ringFinished() { return !BUILDER_RING.length || builderRingPlan.done === true; }
async function npcPlan() {
  npcFree = false; queuedBuild = null;
  await npcPlanRules();
  const used = AI_ROLE ? llmApply() : false;
  const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
  const calm = !npcEnemies().some(p => hexDistance(here, p) <= 2);
  if (AI_ROLE === 'builder' && npcFree && (!used || calm)) builderFallback();   // the model's line (say) stays either way
}
async function npcPlanRules() {
  queuedDestroy = null;
  // Monster awakening (user ruling 2026-11-05): a wild monster — a non-companion
  // non-player creature — enters as `sleeping` and does nothing. The first time
  // any live player sits within 2 hexes of us we flip to `awake` and stay there.
  // Deterministic from the shared peer snapshot of positions, so every observer
  // sees the same transition on the following broadcast.
  if (entity.monsterState === 'sleeping') {
    const hereH = { tile_q: entity.tile.q, tile_r: entity.tile.r };
    const trigger = livePeers().some(p => p && isHumanAlliance(p.alliance) && (p.life ?? 0) > 0 && Number.isInteger(p.tile_q) && hexDistance(hereH, p) <= 2 && !CS.anyChargeUsed(csOf(p), 'threat', hg.turn) && !snapInvisible(p));
    if (trigger) entity.monsterState = 'awake';
    else { queued = ['EMPTY']; queuedSkills = []; queuedExtra = null; target = null; return; }
  }
  const enemies = npcEnemies();
  // Summoned / bound: follow the owner — close the gap first, fight only what is in reach.
  // Unattended (rule_unattended_character, follow 'summon'): my master is my owner here — "they will gather next to
  // you even if they are far away" — by walking (the Empty Move / Move below), never a teleport.
  const ownerSnap = SHADOW_OF ? (ledBy && liveSnap(peersPublic.get(ledBy), Date.now()) ? peersPublic.get(ledBy) : null) : ownerPeerId ? peersPublic.get(ownerPeerId) : null;
  const owner = !SHADOW_OF && ownerHint && Date.now() - ownerHint.at < 10_000 ? { ...(ownerSnap || {}), ...ownerHint } : ownerSnap;
  // Unattended with no master: hold my ground — fight what is in contact, cast at what is in reach, never roam.
  if (SHADOW_OF && !(owner && Number.isInteger(owner.tile_q))) {
    const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
    const near = enemies.filter(p => hexDistance(here, p) <= 1);
    if (!near.length) {
      const nearestE = [...enemies].sort((a, b) => hexDistance(here, a) - hexDistance(here, b))[0] || null;
      if (NPC_CASTS && npcCast(enemies, nearestE)) return;
      const pi = hand.findIndex(c => c.code === 'P' || c.code === 'B');
      queued = pi >= 0 ? [pi] : ['EMPTY']; queuedSkills = []; queuedExtra = null; target = null;
      return;
    }
  }
  if (owner && Number.isInteger(owner.tile_q) && (owner.life ?? 1) > 0) {
    const here = { tile_q: entity.tile.q, tile_r: entity.tile.r };
    const dOwner = hexDistance(here, owner);
    const near = enemies.filter(p => hexDistance(here, p) <= 1);
    // Effect cards (user ruling 2026-11-15, allied summons cast too): a running cast goes on — I do not move
    // while casting (Rule 19), even if my owner walks off; standing by my owner with nobody in contact I may
    // start one (ranged damage, a heal / brew for my side, a defence with an enemy close).
    const nearestE = [...enemies].sort((a, b) => hexDistance(here, a) - hexDistance(here, b))[0] || null;
    if (NPC_CASTS && !near.length && casting && typeof queuedEffect === 'number' && npcCast(enemies, nearestE)) return;
    if (NPC_CASTS && !near.length && (dOwner <= 1 || IS_GOLEM) && npcCast(enemies, nearestE)) return;
    if (dOwner > 1 && !near.length && !IS_GOLEM) {
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
  // Avenger lure (user rework #2 2026-11-14): the lurer stays my prey until it dies or leaves the map;
  // while it is unseen (Invisibility / Rogue stealth) I go after whoever else is nearest.
  if (entity.luredBy) { const lp = peersPublic.get(entity.luredBy.id); if (!lp || (lp.life ?? 0) <= 0) { console.log(`[${PEER_LABEL}] avenger lure: ${entity.luredBy.id.slice(0, 14)} is gone — the chase ends`); entity.luredBy = null; } }
  npcFree = true;   // from here on the pick is free: the model's option may replace it (llmApply)
  // No enemy in sight: an allied bot may still heal itself / a hurt friend in contact (Turn Life, Potion Brew …).
  if (!enemies.length && NPC_CASTS && !IS_MONSTER && npcCast([], null)) { entity.chaseTarget = ''; return; }
  if (!enemies.length) { entity.chaseTarget = ''; queued = []; queuedSkills = []; queuedExtra = null; target = null; return; }
  enemies.sort((a, b) => hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, a) - hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, b));
  const lurer = entity.luredBy ? enemies.find(p => p.peer_id === entity.luredBy.id) : null;
  if (lurer) enemies.unshift(...enemies.splice(enemies.indexOf(lurer), 1));
  const nearest = enemies[0];
  // A wild monster publishes whom it chases (snapshot chase_target): the Avenger's chase bonus counts it.
  if (entity.monsterState) { if (entity.chaseTarget !== nearest.peer_id) console.log(`[${PEER_LABEL}] chase: I go after ${nearest.name || nearest.peer_id.slice(0, 14)} (${nearest.peer_id.slice(0, 14)})${lurer ? ' — lured' : ''}`); entity.chaseTarget = nearest.peer_id; }
  const d = hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, nearest);
  // Effect cards (user rulings 2026-11-15, monsters and allied bots): carry on / start a cast before the weighted A/M/P/B pick.
  if (NPC_CASTS && npcCast(enemies, nearest)) return;
  // A golem never moves (user ruling 2026-11-12): it fights what stands next to it, else it holds.
  const WEIGHTS = IS_GOLEM ? (d <= 1 ? { A: 0.7, P: 0.2, B: 0.1 } : { P: 0.5, B: 0.5 })
    : (entity.life <= 1 && entity.lifeMax > 1) ? { B: 0.6, M: 0.3, A: 0.1 } : d <= 1 ? { A: 0.5, P: 0.3, M: 0.2 } : { M: 0.7, P: 0.3, A: 0.0 };
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
  // Rule 24: if this action puts an element out — Posture, Empty Posture,
  // Reaver Attack, Monk Move — and an in-reach enemy has a permanent my best
  // stat can roll against, point the emission at it instead of a bonus token.
  const emitsNow = pick === 'P' || slot < 0 || clEmits(pick);   // C1 ruling 2026-11-16 (Reaver A, Barbarian B, Monk M)
  if (emitsNow) {
    const reach = enemies.filter(p => hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, p) <= STRONG_RADIUS);
    // C1 ruling 2026-11-16: an adjacent reanimated enemy (Necromancer) first — Will at its Harmony / Concentration.
    const rean = reach.filter(p => p.raised_by && (p.life ?? 0) > 0 && hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, p) <= 1).sort((a, b) => a.peer_id.localeCompare(b.peer_id))[0];
    const opp = rean ? null : _npcPickDestroy(reach);
    if (rean) queuedDestroy = { stat: 'will', reanimated: rean.peer_id };
    else if (opp) queuedDestroy = { stat: opp.stat };
  }
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
    else if ((t.fx || e.fx) && t.fx !== e.fx) diffs.push(`${e.id}: foreign effect ours ${e.fx || 'none'} vs theirs ${t.fx || 'none'}`);   // E4
    else if ((t.sk || e.sk) && t.sk !== e.sk) diffs.push(`${e.id}: foreign skill ours ${e.sk || 'none'} vs theirs ${t.sk || 'none'}`);   // S4
    else if ((t.cl || e.cl) && t.cl !== e.cl) diffs.push(`${e.id}: foreign class ours ${e.cl || 'none'} vs theirs ${t.cl || 'none'}`);   // CH
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
  if (env.type === 'evt_action_reveal') { noteSeen(revealsSeen, env); noteLateReveal(env); }
  if (env.payload?.fx_ref || env.payload?.effects?.[0]?.ref) fxPeer.onEnvelope(env);   // E4: start loading a foreign effect the moment it is committed
  if (env.payload?.sk_ref) skPeer.onEnvelope(env);   // S4: start loading a foreign skill the moment it is committed
  if (env.payload?.cl_ref) clPeer.onEnvelope(env);   // CH: start loading a revealer's foreign class the moment it is committed
  if (env.type === 'evt_card_gift') receiveCardGift(env.payload, env.actor_peer_id);   // FXG: the sender = first fetch source of a foreign card
  if (env.type === 'evt_team_gate') receiveTeamGate(env);
  // Vision (hand): the enemy I looked at shows me their cards — a popup for my UI only.
  if (env.type === 'evt_peek' && env.payload?.for_peer === PEER_ID_STRING && Array.isArray(env.payload.cards)) {
    const what = env.payload.what === 'deck' ? 'deck' : 'hand', who = env.payload.name || env.actor_peer_id;
    const list = env.payload.cards.map(c => c.name).join(', ') || 'nothing';
    const why = String(env.payload.why || ''), whyName = why.startsWith('class_') ? (data.classes[why]?.name || why.replace('class_', '')) : null;
    const label = whyName ? `${whyName}: ${who} ${env.payload.partial ? `shows ${env.payload.cards.length} of ${env.payload.hand_count ?? '?'} hand cards` : `holds ${env.payload.cards.length} card(s)`} — ${list}.`
      : what === 'deck' ? `Prophet: the top ${env.payload.cards.length} of ${who}'s deck — ${list}.` : env.payload.partial ? `Avenger: ${who} shows ${list}.` : `Vision: ${who} holds ${list}.`;
    console.log(`[${PEER_LABEL}] peek: ${env.actor_peer_id.slice(0, 14)}'s ${what}${env.payload.partial ? ' (part)' : ''}${why ? ` [${why}]` : ''} — ${list}`);
    broadcastUI({ kind: 'peek', what, of: env.actor_peer_id, of_name: who, cards: env.payload.cards, text: label, why: why || null });
    const pending = env.payload.req_id ? handRequestsMap().get(env.payload.req_id) : null;
    if (pending) { clearTimeout(pending.timer); handRequestsMap().delete(env.payload.req_id); pending.resolve({ peer_id: env.actor_peer_id, name: who, cards: env.payload.cards, hand_count: env.payload.hand_count ?? null }); }
  }
  if (env.type === 'evt_hand_request' && env.payload?.for_peer === PEER_ID_STRING) answerHandRequest(env);
}
// -------- hand queries (user rework 2026-11-14: Prophet's first-contact look; reusable — e.g. Manipulator) --------
// requestHand(peerId, {n, why}) asks another peer to show me its hand — `n` random cards, or all (n null).
// Channel: an `evt_hand_request` envelope (libp2p strong mesh + Nostr bus, like evt_peek); the target answers
// with `evt_peek` {for_peer, req_id, cards, hand_count} that only the requester's UI shows (popup). Nothing
// here enters the resolver or the state hash. Resolves with {peer_id, name, cards, hand_count} or null (timeout).
// req_id → { resolve, timer }; a hoisted accessor so an envelope arriving during startup never meets a TDZ const.
function handRequestsMap() { return (globalThis.__chaosHandRequests ||= new Map()); }
function requestHand(peerId, { n = null, why = 'peek', timeoutMs = 8000 } = {}) {
  const req_id = `${PEER_ID_STRING.slice(-8)}:${hg.action}:${randomBytes(4).toString('hex')}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { handRequestsMap().delete(req_id); console.log(`[${PEER_LABEL}] hand request to ${peerId.slice(0, 14)} [${why}] got no answer`); resolve(null); }, timeoutMs);
    handRequestsMap().set(req_id, { resolve, timer });
    emitEnvelope({ type: 'evt_hand_request', payload: { for_peer: peerId, req_id, n: Number.isInteger(n) && n > 0 ? n : null, why }, viaBus: true })
      .catch((e) => { clearTimeout(timer); handRequestsMap().delete(req_id); console.warn(`[${PEER_LABEL}] hand request failed: ${e.message}`); resolve(null); });
  });
}
// Someone asks to see my hand. A class look must come from a living enemy within that class's range (+1 for a
// step the snapshots have not caught up with); anything else (why without a class) is left to the caller's rules.
function answerHandRequest(env) {
  const p = env.payload, from = env.actor_peer_id, asker = peersPublic.get(from) || env.state || null;
  const why = String(p.why || 'peek');
  if (entity.life <= 0) return;
  if (why.startsWith('class_')) {
    const ok = asker && (asker.life ?? 0) > 0 && sideOf(asker.alliance) !== MY_SIDE && Number.isInteger(asker.tile_q)
      && hexDistance({ tile_q: entity.tile.q, tile_r: entity.tile.r }, asker) <= classRangeOf(why) + (hasHook(why, 'contact') ? 2 : 1);   // a contact class (Prophet): contact after both stepped
    if (!ok) { console.log(`[${PEER_LABEL}] hand request from ${from.slice(0, 14)} [${why}] refused (not a nearby enemy)`); return; }
  }
  publishPeek(from, { what: 'hand', n: Number.isInteger(p.n) && p.n > 0 ? p.n : null, why, req_id: p.req_id || null }).catch(() => {});
}
// Card faces for peeks / forced discards: enough to draw a small card (name, kind, code, cost, ids).
function peekWire(c) { return { name: c.name || c.action_name || c.card_id, kind: c.kind, code: c.code || null, effect_id: c.effect_id || null, skill_id: c.skill_id || null, element_cost: Array.isArray(c.element_cost) ? [...c.element_cost] : null }; }
// The cards I have in play this action (forced discards — Witch — never take them): action / option cards, skills, the
// effect (∀ copy, chain, attachment), bonus plans, the running cast.
function cardsInPlayNow() {
  const r = myLastReveal || {}, ids = new Set(), add = (x) => { if (x) ids.add(x); };
  [r.cardId, ...(r.optionCardIds || []), ...(r.skillCardIds || []), r.effectCardId, r.effectCardId2, r.effectAttach?.card_id, r.classAbility?.attach?.card_id].forEach(add);
  for (const e of r.chain?.entries || []) { add(e.cardId); add(e.cardId2); }
  for (const e of casting?.entries || []) { add(e.cardId); add(e.cardId2); }
  for (const b of r.bonus || []) [b.cardId, b.extraCardId, ...(b.skillCardIds || []), b.effectCardId].forEach(add);
  for (const id of myPlayedCardIds || []) add(id);
  return ids;
}
// A look reached me: publish my whole hand (Vision), `n` random hand cards (Avenger) or the top `n` of my
// deck (Prophet) for the looker — names only, enough to read the next action.
async function publishPeek(to, { what = 'hand', n = null, why = null, req_id = null } = {}) {
  const wire = peekWire;
  let cards;
  if (what === 'deck') { reshuffleIfEmpty(); cards = deck.slice(0, n || 5).map(wire); }
  else if (n && n < hand.length) { const pool = [...hand]; cards = []; while (cards.length < n && pool.length) cards.push(wire(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])); }
  else cards = hand.map(wire);
  console.log(`[${PEER_LABEL}] peek: I show ${what === 'deck' ? `the top ${cards.length} of my deck` : `${cards.length} card(s) of my hand`} to ${to.slice(0, 14)}${why ? ` [${why}]` : ''}`);
  await emitEnvelope({ type: 'evt_peek', payload: { for_peer: to, name: entity.name, cards, what, partial: what === 'hand' && cards.length < hand.length, hand_count: hand.length, ...(why ? { why } : {}), ...(req_id ? { req_id } : {}) }, viaBus: true });
}

// -------- death cards (user ruling 2026-11-13) --------
// Whoever dies drops one random non-action card from its deck: a profile character from the PROFILE (future
// games lose it), everyone else (monsters, summons, plain heroes) from the in-game deck + discard + hand.
// The card goes to the killer's archive — the peer that dealt me the most damage this action (ties → the
// lexically smallest id; the world, traps and myself don't count). Local bookkeeping only: the resolver never
// sees it, and the gift travels as evt_card_gift on the bus (deduped by gift id).
const cardRefName = (x) => (x?.kind === 'skill' ? data.skills[x.id]?.name : data.effects[x?.id]?.name) || x?.ref?.name /* FXG */ || x?.id || 'a card';
function dropDeathCard(myDamage) {
  const by = new Map();
  for (const d of myDamage || []) {
    if (!(d.amount > 0) || !d.attacker || d.attacker === PEER_ID_STRING || !peersPublic.has(d.attacker)) continue;
    by.set(d.attacker, (by.get(d.attacker) || 0) + d.amount);
  }
  const killer = [...by].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0]?.[0] || null;
  const killerName = killer ? (peersPublic.get(killer)?.name || killer) : null;
  // Kill → creature card (user 2026-11-17, "units killed by me land in my archive" — Possess plays them): a
  // creature unit (monster, summon, possessed creature) also hands its OWN creature card to the same killer.
  if (killer && CREATURE_ID && data.creatures[CREATURE_ID] && !IS_PHANTOM) {
    const kg = { gift_id: `${PEER_ID_STRING}:${hg.turn}:${hg.action}:creature`, for_peer: killer, card: { kind: 'creature', id: CREATURE_ID }, from_name: entity.name };
    console.log(`[${PEER_LABEL}] kill card: my creature card ${CREATURE_ID} goes to my killer ${killerName} (${killer})`);
    const sendK = () => emitEnvelope({ type: 'evt_card_gift', payload: kg, viaBus: true }).catch(e => console.warn(`[${PEER_LABEL}] kill card failed: ${e.message}`));
    setTimeout(sendK, 0); setTimeout(sendK, 4000);
  }
  // A hero shadow (rule_hero_shadow) holds no real deck: its killer gets the hero's PUBLISHED death card
  // (SHADOW_DEATH_CARD), and the death is published (shadow_death_json → snapshots, Doors) so the player's own
  // device removes that card from the profile character (game/shadow-settle.mjs, once per gift id).
  if (SHADOW_OF) {
    const sc = deathCardRef();
    const gid = `${SHADOW_OF}:shadow:${PEER_ID_STRING}:${hg.turn}:${hg.action}`;
    shadowDeath = { killer: killer || '', killer_name: killerName || '', card: sc, gift_id: gid, at: new Date().toISOString(), dim: DIM_NAME };
    console.log(`[${PEER_LABEL}] shadow: the shadow of ${SHADOW_OF} falls${killer ? ` — killer ${killerName} (${killer})` : ' — no killer'}; death card ${sc ? `${sc.kind} ${sc.id}` : 'none'}${sc && killer ? ' goes to the killer' : ''} (the player's profile loses it when its device next sees this)`);
    if (sc && killer) {
      const gift = { gift_id: gid, for_peer: killer, card: sc, from_name: `${entity.name} (shadow)`, ...(sc.ref ? { from_peer: SHADOW_OF } : {}) };   // FXG: the hero (not its shadow) holds a foreign def
      const send = () => emitEnvelope({ type: 'evt_card_gift', payload: gift, viaBus: true }).catch(e => console.warn(`[${PEER_LABEL}] card gift failed: ${e.message}`));
      setTimeout(send, 0); setTimeout(send, 4000);
    }
    publishPublicState().catch(() => {});
    setTimeout(() => publishDoor().catch(() => {}), 2000);   // the death reaches Radicle now, not in 10 min
    return;
  }
  let card = null;
  if (profileChar) card = dropRandomDeckCard(PROFILE_FILE, PROFILE_CHAR_ID);
  else {
    const pool = [...deck.map(c => [deck, c]), ...discard.map(c => [discard, c]), ...hand.map(c => [hand, c])].filter(([, c]) => c.kind === 'skill' || c.kind === 'effect');
    if (pool.length) {
      const [pile, c] = pool[Math.floor(Math.random() * pool.length)];
      pile.splice(pile.indexOf(c), 1);
      card = cardRefOf(c);   // FXG: {kind, id} (+ ref when the card is foreign)
    }
  }
  const nm = card ? cardRefName(card) : null;
  // What hit me this action, e.g. "2 from a hidden trap in Watchtower Fireball · 1 from Nacatl Hunt-Pride's Attack".
  const causes = new Map();
  for (const d of myDamage || []) {
    if (!(d.amount > 0)) continue;
    const who = d.attacker === PEER_ID_STRING ? 'yourself' : d.attacker === 'world' ? '' : (peersPublic.get(d.attacker)?.name || String(d.attacker || '').slice(0, 8));
    const what = d.why || (String(d.source || '').startsWith('combo') ? 'combo' : d.source === 'effect' ? 'an effect' : 'attack');
    const k = d.attacker === 'world' ? `a ${what}` : who === 'yourself' ? `your own ${what}` : `${who}'s ${what}`;
    causes.set(k, (causes.get(k) || 0) + d.amount);
  }
  const cause = [...causes].map(([k, n]) => `${n} from ${k}`).join(' · ');
  console.log(`[${PEER_LABEL}] death cause: ${cause || 'unknown'}`);
  console.log(`[${PEER_LABEL}] death card: ${card ? `${card.kind} ${card.id} leaves my ${profileChar ? 'profile ' : ''}deck` : 'no non-action card to drop'}${killer ? ` — killer ${killerName} (${killer})` : ' — no killer'}`);
  const byTxt = cause ? ` (${cause})` : '';
  broadcastUI(handMsg({ notice: card ? (killer ? `☠ You died${byTxt} — ${nm} leaves your deck for ${killerName}'s archive` : `☠ You died${byTxt} — ${nm} leaves your deck`) : `☠ You died${byTxt}` }));
  if (!card || !killer) return;
  const gift = { gift_id: `${PEER_ID_STRING}:${hg.turn}:${hg.action}`, for_peer: killer, card, from_name: entity.name, ...(card.ref ? { from_peer: PEER_ID_STRING } : {}) };   // FXG: from_peer = who holds the foreign def (fetch source)
  // Twice, a few seconds apart: the bus may drop one; the receiver dedupes on gift_id.
  const send = () => emitEnvelope({ type: 'evt_card_gift', payload: gift, viaBus: true }).catch(e => console.warn(`[${PEER_LABEL}] card gift failed: ${e.message}`));
  setTimeout(send, 0); setTimeout(send, 4000);
}
// Kill cards (user 2026-11-18): a creature card won by a kill is mine only while I stay in this dimension — never
// written to the profile, and dropped from every pile when I leave (Dimension Out / vanish). A process end loses
// them anyway (piles are in memory only).
function dropDimensionCards(why) {
  let n = 0;
  for (const pile of [archive, deck, discard, hand]) for (let i = pile.length - 1; i >= 0; i--) if (pile[i]?.kind === 'creature' && pile[i].killed) { pile.splice(i, 1); n++; }
  if (n) console.log(`[${PEER_LABEL}] kill cards: ${n} creature card(s) won in ${DIM_NAME} dropped — ${why}`);
  return n;
}
function receiveCardGift(g, sender = null) {
  if (!g?.gift_id || g.for_peer !== PEER_ID_STRING || giftsSeen.has(g.gift_id)) return;
  giftsSeen.add(g.gift_id);
  // A summon's kill belongs to its owner.
  if (IS_COMPANION && ownerPeerId) {
    console.log(`[${PEER_LABEL}] card gift ${g.card?.kind} ${g.card?.id} from ${g.from_name} → my owner ${ownerPeerId}`);
    const fwd = { ...g, for_peer: ownerPeerId };
    emitEnvelope({ type: 'evt_card_gift', payload: fwd, viaBus: true }).catch(() => {});
    setTimeout(() => emitEnvelope({ type: 'evt_card_gift', payload: fwd, viaBus: true }).catch(() => {}), 4000);
    return;
  }
  if (g.card?.ref) { receiveForeignGift(g, sender); return; }   // FXG: a player-branch card — loaded through the handshake
  // A creature I killed (2026-11-17): its creature card joins my in-game archive (Possess / Summoning / Necromancer
  // play it). In-game only — profile decks hold skills and effects.
  if (g.card?.kind === 'creature') {
    const cc = creatureCard(g.card.id);
    if (!cc) { console.warn(`[${PEER_LABEL}] kill card: unknown creature ${g.card.id} from ${g.from_name}`); return; }
    cc.from = String(g.from_name || '').slice(0, 60); cc.killed = true;
    archive.push(cc);
    console.log(`[${PEER_LABEL}] kill card: creature ${g.card.id} (${cc.name}) from ${g.from_name} → my archive (${archive.filter(x => x.kind === 'creature').length} creature(s))`);
    broadcastUI(handMsg({ notice: `🏆 You killed ${g.from_name || cc.name} — its creature card ${cc.name} is in your archive while you stay in this dimension (Possess can play it)` }));
    return;
  }
  const c = cardFromRef(g.card);
  if (!c) { console.warn(`[${PEER_LABEL}] card gift: unknown ${g.card?.kind} ${g.card?.id} from ${g.from_name}`); return; }
  c.from = String(g.from_name || '').slice(0, 60);
  archive.push(c);
  if (profileChar) { try { addArchivedCard(PROFILE_FILE, PROFILE_CHAR_ID, g.card, g.from_name || ''); } catch (e) { console.warn(`[${PEER_LABEL}] profile archive write failed: ${e.message}`); } }
  console.log(`[${PEER_LABEL}] card gift: ${g.card.kind} ${g.card.id} from ${g.from_name} → my archive${profileChar ? ' (profile too)' : ''}`);
  broadcastUI(handMsg({ notice: `🏆 You took ${c.name} from ${g.from_name || 'your victim'} — it is in your archive` }));
}
// FXG: a foreign gift {kind, id, ref}: held → at once; else cache, then the giver (from_peer, else the envelope's
// sender), announced holders, git / httpd; validator gate. Refused / not obtained → log + `missing` notice, the card
// is lost (as an unknown card always was). Async arrival is fine: the archive is private, outside the state hash.
async function receiveForeignGift(g, sender) {
  const from = typeof g.from_peer === 'string' && g.from_peer ? g.from_peer : sender;
  const fr = await foreignCardFromRef(g.card, { from, holders: [sender].filter(p => p && p !== from), timeoutMs: 30_000, why: 'card gift' }).catch(e => ({ status: 'missing', reason: e.message }));
  if (fr.status !== 'ready') {
    console.warn(`[${PEER_LABEL}] card gift: foreign ${g.card.kind} ${g.card.id} from ${g.from_name} ${fr.status}${fr.reason ? ` (${fr.reason})` : ''} — the card is lost`);
    broadcastUI(handMsg({ notice: `⚠ ${g.from_name || 'Your victim'}'s ${g.card.ref?.name || g.card.id} could not be loaded (${fr.status}) — the card is lost` }));
    return;
  }
  const c = fr.card;
  c.from = String(g.from_name || '').slice(0, 60);
  archive.push(c);
  const kept = cardRefOf(c);   // the ref I verified (my verdict) — what the profile keeps
  if (profileChar) { try { addArchivedCard(PROFILE_FILE, PROFILE_CHAR_ID, kept, g.from_name || ''); } catch (e) { console.warn(`[${PEER_LABEL}] profile archive write failed: ${e.message}`); } }
  console.log(`[${PEER_LABEL}] card gift: foreign ${g.card.id} learned from ${fr.src}${fr.held ? ' (already held)' : ''} — ${g.card.kind} from ${g.from_name} → my archive${profileChar ? ' (profile too)' : ''}`);
  broadcastUI(handMsg({ notice: `🏆 You took ${c.name} from ${g.from_name || 'your victim'} — it is in your archive` }));
}

// -------- Seeker vision (user ruling 2026-11-14) --------
// The hex of my far trap building and `radius` around it are in my sight until the end of my next turn: the land
// there becomes known (revealAround) and the UI gets a `vision-grant` (same path as a team gate) with that radius.
// Vision only — nothing the resolver reads.
function grantSeekerVision(tp) {
  revealAround(tp.q, tp.r).catch(e => console.warn(`[${PEER_LABEL}] seeker reveal failed: ${e.message}`));
  const grant = { kind: 'vision-grant', q: tp.q, r: tp.r, radius: tp.vision.radius, until_turn: tp.vision.until_turn, from_name: data.classes[tp.made_by]?.name || 'Seeker', reason: `your ${data.effects[tp.effect_id]?.name || tp.effect_id} trap` };
  visionGrants.push(grant);
  broadcastUI(grant);
  console.log(`[${PEER_LABEL}] seeker vision: (${tp.q},${tp.r}) radius ${grant.radius} until the end of turn ${grant.until_turn}`);
}

// -------- fortress stat buy (user ruling 2026-11-14) --------
// World edits as every peer publishes them (mine included) — which fortresses still stand.
function liveWorldEdits() { return worldLens(new Map([...peersPublic, [PEER_ID_STRING, { world_edits_json: JSON.stringify(entity.worldEdits || []) }]])).edits; }
// doResolution: my fortress stat-buy outcomes of this action (resolver `fortressStatBuy`) → my bank / my bonus.
function applyFortressOutcomes(outcomes) {
  let done = false;
  for (const d of outcomes) {
    if (d.kind !== 'building' || d.actor !== PEER_ID_STRING || done) continue;
    done = true;   // one stat buy per action (a bonus-round copy of the same emission is ignored)
    if (d.result === 'banked') {
      entity.fortressBank = { id: d.id, stat: d.stat, value: d.power, bank: d.bank, turn: hg.turn, action: hg.action };
      console.log(`[${PEER_LABEL}] fortress ${d.id}: banked ${d.stat} ${d.add} → ${d.bank}/${d.power}`);
    } else if (d.result === 'destroyed') {
      // The bonus is a character stat bonus token, the same kind Artifice makes (user ruling 2026-11-14 #2):
      // one per element (fortressTokenElem), replaces an earlier one only if higher, Rule 24 destroys it.
      entity.fortressBank = null;
      const elem = fortressTokenElem(d.stat, ELEM_TO_STAT);
      const pl = elem && d.bonus > 0 ? placeStatBonusToken(entity.statTokens, { id: `${PEER_ID_STRING.slice(-8)}#${hg.action}#fz${entity.statTokens.length}`, stat: d.stat, elem, value: d.bonus, effect_id: FORTRESS_TOKEN_EFFECT }) : null;
      if (pl) entity.statTokens = pl.tokens;
      console.log(`[${PEER_LABEL}] fortress ${d.id} broken (bank ${d.bank}/${d.power}) — consumed; point-buy [${(d.dice || []).join(',')}] → ${d.stat} bonus token +${d.bonus} (${elem})${!pl ? ' — no token' : !pl.placed ? ` (kept my earlier +${pl.kept.value} ${pl.kept.effect_id || ''} token)` : pl.replaced ? ` (replaces +${pl.replaced.value})` : ''}`);
      // Tell the player what the dice did (2026-11-15: the break used to be silent on the HUD).
      const sn = d.stat[0].toUpperCase() + d.stat.slice(1);
      broadcastUI(handMsg({ notice: `🛡 ${d.label || 'Fortress'} broken — point-buy ${(d.dice || []).length} dice [${(d.dice || []).join(', ')}]: highest ${d.bonus} → ${pl?.placed ? `a permanent ${sn} +${d.bonus} token on you` : pl?.kept ? `you keep your ${sn} +${pl.kept.value} token (higher)` : 'no token'}` }));
    }
    _autosave?.markDirty();
  }
  // Someone else broke the fortress I was banking against: the bank is void.
  if (entity.fortressBank) { const [q, r] = entity.fortressBank.id.slice(4).split(',').map(Number); if (!fortressAt(MAP_SEED, q, r, liveWorldEdits())) { console.log(`[${PEER_LABEL}] fortress ${entity.fortressBank.id} is gone — my bank ${entity.fortressBank.bank} is void`); entity.fortressBank = null; } }
}
// Hand-message hint (UI + bots): standing fortresses within `radius` of me, nearest first, with my bank.
function fortressesNearForUI(radius = 12) {
  const out = [], q0 = entity.tile.q, r0 = entity.tile.r, gone = liveWorldEdits();
  if (!Number.isInteger(q0)) return out;
  for (let dq = -radius; dq <= radius; dq++) for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
    const fz = fortressAt(MAP_SEED, q0 + dq, r0 + dr, gone);
    if (!fz) continue;
    const dist = hexDistance({ tile_q: q0, tile_r: r0 }, { tile_q: fz.q, tile_r: fz.r });
    out.push({ building: `${fz.q},${fz.r}`, q: fz.q, r: fz.r, stat: fz.stat, value: fz.value, dist, near: dist <= FORTRESS.near, bank: entity.fortressBank?.id === fz.id ? entity.fortressBank.bank : 0 });
  }
  return out.sort((a, b) => a.dist - b.dist || a.q - b.q || a.r - b.r).slice(0, 6);
}

// -------- team gate (user ruling 2026-11-13) --------
// "Join my team": the new peer tells its team (and the Door it came through) where it entered; they see that
// spot until the end of the next turn. Vision only — nothing the resolver reads.
function announceTeamGate() {
  const payload = { team: PROFILE_TEAM, door: TEAM_GATE_DOOR, q: entity.tile.q, r: entity.tile.r, until_turn: hg.turn + 1, from_name: entity.name, gate_id: `${PEER_ID_STRING}:gate` };
  console.log(`[${PEER_LABEL}] team gate: ${PROFILE_TEAM || '(no team)'} / door ${TEAM_GATE_DOOR || '-'} at (${payload.q},${payload.r}) until turn ${payload.until_turn}`);
  for (const ms of [0, 5000, 10_000, 20_000]) setTimeout(() => emitEnvelope({ type: 'evt_team_gate', payload, viaBus: true }).catch(e => console.warn(`[${PEER_LABEL}] team gate failed: ${e.message}`)), ms);
}
function receiveTeamGate(env) {
  const g = env.payload || {};
  if (env.actor_peer_id === PEER_ID_STRING || !Number.isInteger(g.q) || !Number.isInteger(g.r)) return;
  if (!((PROFILE_TEAM && g.team === PROFILE_TEAM) || (g.door && g.door === PEER_ID_STRING))) return;
  const key = g.gate_id || `${env.actor_peer_id}:gate`;
  if (gatesSeen.has(key)) return;
  gatesSeen.add(key);
  revealAround(g.q, g.r).catch(e => console.warn(`[${PEER_LABEL}] gate reveal failed: ${e.message}`));
  const grant = { kind: 'vision-grant', q: g.q, r: g.r, until_turn: Number(g.until_turn) || hg.turn + 1, from_name: g.from_name || env.actor_peer_id, reason: 'team-gate' };
  visionGrants.push(grant);
  console.log(`[${PEER_LABEL}] team gate from ${grant.from_name} at (${g.q},${g.r}) — vision until turn ${grant.until_turn}`);
  broadcastUI(grant);
  const who = PROFILE_TEAM && g.team === PROFILE_TEAM ? `${grant.from_name} of your ${PROFILE_TEAM} team` : `${grant.from_name}${g.team ? ` (${g.team} team)` : ''}, who came through your Door,`;
  broadcastUI(handMsg({ notice: `⚑ ${who} opened a gate at (${g.q},${g.r}) — you see it until the end of the next turn` }));
}
const activeVisionGrants = () => { for (let i = visionGrants.length - 1; i >= 0; i--) if (hg.turn > visionGrants[i].until_turn) visionGrants.splice(i, 1); return visionGrants; };

// -------- join sync --------
// Reveals are matched by turn number, so a peer that boots into a running
// Dimension must adopt the mesh's clock or it will never see anyone's reveal
// for "its" turn. Take the most-advanced live peer as the reference.
// Peer snapshots arrive over the bus (every peer republishes within 15s, the
// relay replays the last two minutes on subscribe), Gun and the optional
// discovery mirror — all land in peersPublic. Wait briefly for the first one.
const JOIN_SYNC_WAIT_MS = Number(process.env.JOIN_SYNC_WAIT_MS || 6000);
const JOIN_SYNC_SETTLE_MS = Number(process.env.JOIN_SYNC_SETTLE_MS || 1500);
// The last known clock the launcher hands me (merge-order.mjs lastKnownClock of the newest Door clocks + the local
// TMJ save; spawnCompanion passes the spawner's own action): START_ACTION, or START_TURN (+ START_ROUND).
const START_CLOCK_ENV = (process.env.START_ACTION ?? '') !== '' ? { action: Number(process.env.START_ACTION), source: process.env.START_CLOCK_SRC || 'START_ACTION' }
  : (process.env.START_TURN ?? '') !== '' ? { turn: Number(process.env.START_TURN), round: Number(process.env.START_ROUND || 0), source: process.env.START_CLOCK_SRC || 'START_TURN' } : null;
let joinedClock = false;        // join sync adopted the mesh clock → the startup enterPhase must not shift it again
let joinAbstainAction = -1;     // the action we joined in the middle of (reveal / resolution): not resolved here
// The no-damage zones laid earlier this turn by actions we did not resolve (Swarm-0544 T4.R3) — from the
// zones_json of the peers already at our action (merge-order.mjs meshZones).
function adoptMeshZones(why) {
  const got = meshZones(livePeers().filter(p => p.peer_id !== PEER_ID_STRING), hg.action, hg.turn, { roundsPerTurn: ROUNDS_PER_TURN });
  const have = new Set(activeZones.map(z => `${z.q},${z.r}`));
  const add = got.filter(z => !have.has(`${z.q},${z.r}`));
  if (!add.length) return;
  activeZones.push(...add);
  console.log(`[${PEER_LABEL}] join sync: adopted ${add.length} no-damage zone hex(es) of turn ${hg.turn} (${why})`);
}
async function syncClockFromMesh() {
  const t0 = Date.now();
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
  // Start clock (merge-order.mjs pickStartClock, user 2026-11-17 "I should start at the last known game state,
  // round and turn"): a fresh live node that is not a wild monster → its clock (below). Nobody, or only monsters
  // / stale snapshots → the last known state (START_ACTION from the launcher = newest Door clock / local save;
  // the RESTORE_FROM_TMJ save's meta) or the live monsters' action, whichever is further, entered in planning.
  const known = lastKnownClock([START_CLOCK_ENV, saveClockCand(_restoredTmj?.meta, process.env.RESTORE_FROM_TMJ)], { roundsPerTurn: ROUNDS_PER_TURN });
  const pick = pickStartClock(others, known, { roundsPerTurn: ROUNDS_PER_TURN });
  if (pick.source !== 'live') {
    const why = others.length ? `only ${others.length} monster / stale peer(s) heard, none further` : `no live peers heard in ${JOIN_SYNC_WAIT_MS}ms`;
    if (pick.source === 'fresh') { console.log(`[${PEER_LABEL}] join sync: ${why}, no last known state — starting fresh at turn 0`); return; }
    hg.action = pick.action; hg.turn = pick.turn; hg.round = pick.round;
    // joinedClock stays false: the startup enterPhase('planning') opens a full window at this action.
    console.log(`[${PEER_LABEL}] join sync: ${why} — start clock = last known state turn ${hg.turn} round ${hg.round} (action ${hg.action}, from ${pick.from})`);
    return;
  }
  // Reference (merge-order.mjs pickClockRef via pickStartClock): most advanced action among FRESH peers, the
  // phase most of that cohort is in, the MEDIAN deadline — never the latest, which belongs to whoever is itself
  // lagging (Swarm-0407: M-Foe3 copied joiner P-Agent5's shifted deadline and stayed a phase behind for 80 actions).
  const ref = pick.ref;
  hg.action = pick.action;
  hg.turn = Math.floor(hg.action / ROUNDS_PER_TURN);
  hg.round = hg.action % ROUNDS_PER_TURN;
  // Only planning is safe to drop into: the handshake phases assume we
  // committed. Joining mid-handshake means we sit this action out (rule 6):
  // no doResolution and no state hash for it (tick → joinAbstainAction).
  currentPhase = pick.phase === 'planning' ? 'planning' : 'resolution';
  phaseEndsAt = (typeof pick.phase_ends_at === 'number' && pick.phase_ends_at > Date.now()) ? pick.phase_ends_at : Date.now();
  roundDeadline = currentPhase === 'planning' ? phaseEndsAt : Date.now();
  // Abstaining: wait for the cohort to leave this action (tick), capped like any handshake.
  if (currentPhase !== 'planning') { joinAbstainAction = hg.action; phaseEndsAt = Date.now() + HANDSHAKE_HARD_CAP_MS; }
  joinedClock = true;
  console.log(`[${PEER_LABEL}] join sync: adopted turn ${hg.turn} round ${hg.round} / ${currentPhase} from ${ref.peer_id} (${others.length} live peers heard after ${Date.now() - t0}ms; cohort ${pick.cohort} at that action)`);
  if (currentPhase === 'planning') adoptMeshZones('joined in planning');
  await publishPublicState(true);
}
await syncClockFromMesh();
if (TEAM_GATE) announceTeamGate();

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
      if (joinAbstainAction === hg.action) {
        // Joined in the middle of this action's handshake (Swarm-0407 T2.R3): we hold neither a commit
        // of our own nor a guaranteed-complete view of what it resolves, so it is not resolved here and
        // we publish no state hash for it (like fxRes.abstain). Let the cohort finish it, then plan the next.
        const busy = livePeers().some(p => p.peer_id !== PEER_ID_STRING && p.action === hg.action && p.phase !== 'planning' && Date.parse(p.last_seen || 0) > Date.now() - 20_000);
        // endRound publishes the NEXT action still labelled 'resolution' (and only Gun hears the planning
        // update after it): if the cohort turns out to be planning this action, join its window instead.
        const planEnd = busy ? null : cohortDeadline(livePeers().filter(p => p.peer_id !== PEER_ID_STRING), hg.action);
        if (planEnd !== null && planEnd > Date.now() + 1000) {
          joinAbstainAction = -1; currentPhase = 'planning'; phaseEndsAt = roundDeadline = planEnd;
          console.log(`[${PEER_LABEL}] join sync: the cohort is still planning T${hg.turn}.R${hg.round + 1} — joining its window (${planEnd - Date.now()}ms left)`);
          adoptMeshZones('joined the planning window');
          broadcastUI({ kind: 'phase', name: 'planning', seconds: Math.round((phaseEndsAt - Date.now()) / 100) / 10, heartbeat: anyAdjacentOpponents(), turn: hg.turn, round: hg.round, rounds_per_turn: ROUNDS_PER_TURN });
          await publishPublicState();
          return;
        }
        if (busy && !expired) return;
        joinAbstainAction = -1;
        console.log(`[${PEER_LABEL}] join sync: abstained from T${hg.turn}.R${hg.round + 1} (joined mid-handshake) — not resolved here, no state hash`);
        await endRound();
        checkStandoff();
        catchUpClock();
        adoptMeshZones('after the abstained action');
        enterPhase('planning');
        await publishPublicState();
        return;
      }
      if (!allIn(revealsSeen)) await pullFromDiscovery('reveals', revealsSeen);
      if (!allIn(revealsSeen) && (!expired || waitingOnBusyMember(revealsSeen, 'reveal') || waitingOnCommitter())) return;
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
  for (const p of clockPeers()) {
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
// A unit's unattended-character fields as the Doors carry them (only the set ones): ally_of, led_by, leader (how many
// follow it), human, joined_at, combo ("M,B,P" → ['M','B','P']), out.
function doorUnitFields(p) {
  const combo = String(p?.combo_seq_csv || '').split(',').filter(Boolean);
  return { ...(p?.ally_of ? { ally_of: p.ally_of } : {}), ...(p?.led_by ? { led_by: p.led_by } : {}), ...(Number(p?.leader) > 0 ? { leader: Number(p.leader) } : {}),
    ...(p?.human ? { human: 1 } : {}), ...(p?.joined_at ? { joined_at: p.joined_at } : {}), ...(combo.length ? { combo } : {}), ...(p?.out ? { out: true } : {}) };
}
function buildDoor(now) {
  // The dim branch (ActiveDimensions/<Name>) is pushed to the dims repo, so
  // that's the RID we advertise to joiners. On a legacy single-RID setup
  // dimsEnv transparently inherits codeEnv, so this still prints the main
  // chaosD6 RID — no behaviour change for callers that haven't opted in.
  // On a phone whose in-app Radicle node can publish, dimsIdentity() gives the
  // dims RID + the node's NID instead of local-bare/null.
  const { repo: radRepo, namespace: radNamespace } = dimsIdentity();
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
    // profile_char_id (+ team) let a launcher refuse to clone a profile character that is still alive here;
    // owner_peer_id keeps summons out of a quiet join's regenerated monsters (user rulings 2026-11-15).
    profile_char_id: profileChar ? PROFILE_CHAR_ID : (process.env.SHADOW_PROFILE_CHAR_ID || ''), team_name: PROFILE_TEAM,
    // Hero shadows (rule_hero_shadow): a shadow's hero and, once it fell, who killed it with which card — the
    // player's device settles its profile from these (join-plan.mjs resolveShadows, game/shadow-settle.mjs).
    shadow_of: SHADOW_OF, ...(shadowDeath ? { shadow_death: shadowDeath } : {}),
    // Unattended characters (rule_unattended_character): link, master, followers, combo (the launcher's unit list)
    // and `out` (I left the dimension — not alive here any more).
    ...doorUnitFields({ ally_of: allyOfNow, led_by: ledBy, leader: SHADOW_OF ? 0 : followersOf(PEER_ID_STRING), human: IS_HUMAN ? 1 : 0, joined_at: JOINED_AT,
      combo_seq_csv: Array.isArray(entity.combo) ? entity.combo.join(',') : '', out: outNow ? 1 : 0 }),
    ...clPeer.doorRef(),   // CH: cl_ref — my foreign class (a joiner learns it before it plays); absent with a built-in class
    // Members I saw leave (`out`) stay listed as such, so an older Door's "alive" sighting of them is outdated.
    known_members: [...members, ...[...outPeers.values()].filter(t => !peersPublic.has(t.peer_id))].map(p => ({ peer_id: p.peer_id, name: p.name, alliance: p.alliance, character_id: p.character_id, creature_id: p.creature_id, tile: { q: p.tile_q, r: p.tile_r }, life: p.life, life_max: p.life_max, last_seen: p.last_seen,
      profile_char_id: p.profile_char_id || '', team_name: p.team_name || '', owner_peer_id: p.owner_peer_id || '',
      ...(p.shadow_of ? { shadow_of: p.shadow_of } : {}), ...(p.shadow_death_json ? { shadow_death: (() => { try { return JSON.parse(p.shadow_death_json); } catch { return null; } })() } : {}),
      ...doorUnitFields(p), ...clPeer.doorRef(p.peer_id) })),   // CH: cl_ref of a member's foreign class
    known_tiles: tiles,
    // The map as this peer holds it: joiners union every Door's blocks and
    // start with the whole revealed world instead of just the initial block.
    map: { seed: MAP_SEED, reveal_radius: REVEAL_RADIUS, tiles_known: dimMap.size(), bounds: mapBounds, blocks: dimMap.blocks() },
    // The map fingerprint (HUD telemetry, same as the full snapshot's): a reader without the blocks can
    // still estimate which share of its hexes this Door's holder had (bottom-K sketch, see mapShareOf).
    map_tiles: dimMap.size(), map_sketch: mapSketchCsv(), map_sketch_k: MAP_SKETCH_K,
    network: {
      nostr: { relays: [...relays], pubkey: bus?.pubkey || null, kind: 29517, tag: `chaosd6:${DIM_ID}` },
      libp2p: { multiaddrs: myMaddrs, topic: TOPIC_STRONG, bootstrap: [...bootstrap] },
      gun: { url: myGunUrl, relays: [...gunRelays] },
    },
    radicle: { repo: radRepo, namespace: radNamespace, branch: `ActiveDimensions/${DIM_NAME}` },
    pushed_at: now,
  };
  return { dimensionDoc, door };
}
async function publishDoor() {
  // Test games are local and private (user 2026-11-16): no Door ever leaves this box (DIM_PRIVATE, set by the
  // launcher / phone menu for Test my character / team / random).
  if (DIM_PRIVATE) return;
  doorCount++;
  try {
    const now = new Date().toISOString();
    const { dimensionDoc, door } = buildDoor(now);
    netStat('door', 'out', 'push', JSON.stringify(dimensionDoc).length + JSON.stringify(door).length);   // every ~10 min
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
    } else if (IS_MOBILE && r.reason && r.reason !== 'mobile-peer-no-radicle' && r.reason !== 'no-changes') {
      // Phone with a publish-capable bridge whose publish failed; no bridge = silent.
      console.warn(`[${PEER_LABEL}] door #${doorCount} not published: ${r.reason}`);
    }
  } catch (e) { console.warn(`[${PEER_LABEL}] door push failed: ${e.message.split('\n')[0]}`); }
}
// First push happens at t = RADICLE_PUSH_FIRST_SEC (default 60s — paper's "2nd
// turn, 3rd round" at 6s/round), then every RADICLE_PUSH_SEC seconds (default
// 600s = 10 min). A 10s random jitter on top avoids a thundering herd when
// several peers share one clone; pushDimension retries on lost races anyway.
setTimeout(() => {
  publishDoor().catch(() => {});
  setInterval(() => publishDoor().catch(() => {}), RADICLE_PUSH_SEC * 1000);
}, RADICLE_PUSH_FIRST_SEC * 1000 + Math.floor(Math.random() * 10_000));

// -------- browser UI socket --------
const uiHttp = http.createServer(async (req, res) => {
  if (IS_COMPANION && req.url.startsWith('/summon-hold')) {
    ownerHoldAt = Date.now();
    const u = new URL(req.url, 'http://x'), q = Number(u.searchParams.get('q')), r = Number(u.searchParams.get('r'));
    if (Number.isInteger(q) && Number.isInteger(r)) ownerHint = { tile_q: q, tile_r: r, life: Number(u.searchParams.get('life')), at: Date.now() };
    res.writeHead(204); return res.end();
  }
  if (IS_COMPANION && req.url === '/summon-release') { res.writeHead(204); res.end(); vanish('the permanent that held me is gone'); return; }
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      peer_id: PEER_ID_STRING, dimension: DIM_NAME, phase: currentPhase, phaseEndsIn: Math.max(0, phaseEndsAt - Date.now()),
      entity, permanents_csv: permanentsCsv(), hand, archive, deck_count: deck.length, discard_count: discard.length, queued, queued_skills: queuedSkills, queued_extra: queuedExtra, queued_effect: queuedEffect, queued_effect2: queuedEffect2, queued_chain: queuedChain, aura: queuedAura, target, locked, turn: hg.turn, round: hg.round, action: hg.action, head: hg.head,
      peers: peersForUI(),
      alliance: entity.alliance,
      map: { seed: MAP_SEED, reveal_radius: REVEAL_RADIUS, tiles: dimMap.size(), blocks: dimMap.blockCount(), bounds: dimMap.bounds(), root: mapSync?.myRoot() || null, sync: mapSync?.stats() || null },
      region: { strong_radius: STRONG_RADIUS, reach_radius: REACH_RADIUS, em_max_steps: EM_MAX_STEPS, strong: expectedMembers() },
      multiaddrs: myMaddrs, gun_url: myGunUrl, nostr_pubkey: bus?.pubkey || null, bus: bus ? bus.stats() : null,
    }));
    return;
  }
  // Mobile only: serve the browser UI (same files the desktop UI serves from
  // ui-server.mjs) so an Android WebView can render it at
  // http://127.0.0.1:<PEER_PORT_HTTP>/.
  //   • / and /css/* and /js/*           → the staged peer bundle (next to peer.mjs)
  //   • /assets/*                        → user://assets/ (CHAOSD6_ASSETS_DIR),
  //                                        the WBC3 sprite tree AssetBootstrap
  //                                        downloads on first launch
  //   • /user-data/*                     → user://data/ for future overrides
  // Desktop goes through ui-server.mjs on :7357 instead; this block is gated
  // on IS_MOBILE so no desktop code path changes.
  if (IS_MOBILE) {
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.css':  'text/css; charset=utf-8',
      '.js':   'application/javascript; charset=utf-8',
      '.mjs':  'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg':  'image/svg+xml',
      '.png':  'image/png',
      '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
      '.ico':  'image/x-icon', '.bmp': 'image/bmp',   // hero portraits are .bmp
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
      '.wav':  'audio/wav', '.ogg':  'audio/ogg', '.mp3': 'audio/mpeg',
    };
    const serve = async (root, rel) => {
      if (!root || rel.includes('..')) return false;
      const abs = path.resolve(root, '.' + rel);
      if (!abs.startsWith(root + path.sep) && abs !== root) return false;
      const mime = MIME[path.extname(abs).toLowerCase()];
      if (!mime) return false;
      try {
        const data = await fs.readFile(abs);
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
        res.end(data);
        return true;
      } catch { return false; }
    };
    // Decode before touching disk: sprite / sound / portrait names carry spaces
    // and [CODES], which arrive as %20 / %5B and never matched the files.
    let u;
    try { u = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
    const ASSETS_DIR = process.env.CHAOSD6_ASSETS_DIR || '';
    const USER_DATA_DIR = process.env.CHAOSD6_USER_DATA_DIR || '';
    if (u.startsWith('/assets/') && ASSETS_DIR) {
      const rel = u.slice('/assets'.length);
      if (await serve(ASSETS_DIR, rel)) return;
      // Not downloaded (yet): pull it from the OCI asset pack, keep it, serve it.
      if (await fetchPackAsset(ASSETS_DIR, rel) && await serve(ASSETS_DIR, rel)) return;
      // data/*.json names portraits as .bmp; the pack ships them as .png.
      if (/\.bmp$/i.test(rel)) {
        const png = rel.replace(/\.bmp$/i, '.png');
        if (await serve(ASSETS_DIR, png)) return;
        if (await fetchPackAsset(ASSETS_DIR, png) && await serve(ASSETS_DIR, png)) return;
      }
    } else if (u.startsWith('/user-data/') && USER_DATA_DIR) {
      if (await serve(USER_DATA_DIR, u.slice('/user-data'.length))) return;
    } else if (u.startsWith('/data/')) {
      // The UI's rulebook + sprite/sound/portrait `resources` — the same files
      // the resolver loaded (DATA_DIR), falling back to a bundled copy. F9: a definitions collection (effects) is built
      // from its definitions, like data.effects.
      const dc = definitionsCollectionText(DATA_DIR, u.slice('/data'.length));
      if (dc) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); res.end(dc); return; }
      if (await serve(DATA_DIR, u.slice('/data'.length))) return;
      if (await serve(__dirname, u)) return;
    } else {
      const rel = (u === '/' || u === '') ? '/index.html' : u;
      if (await serve(__dirname, rel)) return;
    }
  }
  res.writeHead(404); res.end();
});
// Mobile only: lazy fill of user://assets from the same static pack
// AssetBootstrap.gd downloads from. One fetch per file (concurrent requests
// share it); misses are remembered so a file the pack lacks isn't re-asked.
const PACK_BASE = process.env.CHAOSD6_PACK_BASE || 'https://92-5-138-121.sslip.io/pack';
const packInFlight = new Map();
const packMisses = new Set();
function fetchPackAsset(root, rel) {
  if (!IS_MOBILE || packMisses.has(rel) || rel.includes('..')) return Promise.resolve(false);
  if (packInFlight.has(rel)) return packInFlight.get(rel);
  const p = (async () => {
    const abs = path.resolve(root, '.' + rel);
    if (!abs.startsWith(root + path.sep)) return false;
    try {
      const url = `${PACK_BASE}/assets${rel.split('/').map(encodeURIComponent).join('/')}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) { packMisses.add(rel); return false; }
      const buf = Buffer.from(await r.arrayBuffer());
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(`${abs}.part`, buf);
      await fs.rename(`${abs}.part`, abs);
      return true;
    } catch { return false; }
    finally { packInFlight.delete(rel); }
  })();
  packInFlight.set(rel, p);
  return p;
}
const wss = new WebSocketServer({ server: uiHttp });
// The phone's way back to the start menu after a Dimension Out (leaveDimension; nodejs-mobile can't restart Node):
// close everything this peer listens on / dials so mobile-entry.mjs can clear my timers and run the menu again on
// the same port. Desktop never calls it (the process exits).
globalThis.__chaosPeerStop = async () => {
  try { for (const c of wss.clients) c.terminate(); wss.close(); } catch {}
  try { uiHttp.closeAllConnections?.(); await new Promise(r => uiHttp.close(() => r())); } catch {}
  try { gunHttp?.closeAllConnections?.(); gunHttp?.close(); } catch {}
  try { bus?.close?.(); } catch {}
  try { await _autosave?.stop?.(); } catch {}
  try { await libp2p.stop(); } catch {}
  console.log(`[${PEER_LABEL}] stopped in-process (Dimension Out) — the menu takes the port back`);
};
wss.on('connection', (ws) => {
  uiClients.add(ws);
  ws.send(JSON.stringify({ kind: 'hello', peer_id: PEER_ID_STRING, alliance: entity.alliance, entity, hand, deck_count: deck.length, discard_count: discard.length, archive, archive_count: archive.length, will_archive: [...willArchive], held: heldCards.map(c => ({ card_id: c.card_id, name: c.name, perm: c.effect_id || c.skill_id })), deck_min: DECK_MIN, circulating: circulating(), dimension: DIM_NAME, door: DOOR_ID, turn: hg.turn, round: hg.round, rounds_per_turn: ROUNDS_PER_TURN, phase: currentPhase, phase_ends_in: Math.max(0, phaseEndsAt - Date.now()), peers: peersForUI(), map: mapSummary(), class_texts: Object.fromEntries([...Object.keys(data.classes).map(id => [id, data.classes[id]?.data?.text || '']), ...clPeer.store.ready().map(p => [p.ref.id, p.shape.text])]), class_colours: Object.fromEntries([...Object.keys(data.classes), ...clPeer.store.ready().map(p => p.ref.id)].map(id => [id, classColours(id)])), class_ui: Object.fromEntries([...Object.keys(data.classes), ...clPeer.store.ready().map(p => p.ref.id)].map(id => [id, classUiOf(id)])), class_state: classStateForUI(), queued_class_ability: queuedClassAbility, effect_ui: effectUiMap(), skill_ui: skillUiMap(), building_skills: [...SK_BUILDING_SKILLS] }));
  // Gate vision still running (team gate, user ruling 2026-11-13) — a reconnecting UI gets it again.
  for (const g of activeVisionGrants()) ws.send(JSON.stringify(g));
  try { ws.send(JSON.stringify(pvHello({ profileFile: PROFILE_FILE, name: ENTITY_NAME, team: PROFILE_TEAM, peerId: PEER_ID_STRING, notify: broadcastUI }))); } catch {}   // PV: my votes + who I am (author check) + collections for the HUD; retries an owed publish
  try { ws.send(JSON.stringify(telemetryMsg())); } catch {}
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
        if (queuedDestroy && (tranceOn || !(codes.has('P') || [...codes].some(x => clEmits(x))))) queuedDestroy = null;   // C1 ruling 2026-11-16
        // Rule 19: effects ride on a Posture / Empty-Posture. Instants may ride
        // on any action. Trance stays out of this pass — the resolver would
        // need per-trance-option emit tracking we don't yet have.
        const effectIdx = typeof m.effect === 'number' ? m.effect : -1;
        const eCard = hand[effectIdx];
        const effect2Idx = typeof m.effect2 === 'number' ? m.effect2 : -1;
        const e2 = hand[effect2Idx];
        const pair = !!(eCard && e2 && effect2Idx !== effectIdx && e2.kind === 'effect' && e2.effect_id === eCard.effect_id && e2.card_id !== eCard.card_id);
        const emitting = codes.has('P') || codes.has('EP') || [...codes].some(x => clEmits(x));   // C1 ruling 2026-11-16
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
        // An action that cannot carry it (Rule 19: the cast is let go) pins nothing.
        if (casting && (emitting || tranceOn)) {
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
        queuedAura = !!m.aura && queuedEffect !== null && !!everyWidener();
        if (queuedEffect !== null && !casting) prepareSummon(hand[queuedEffect], queuedEffect2 !== null);

        broadcastUI(handMsg({ queued, queued_skills: queuedSkills, queued_extra: queuedExtra, queued_effect: queuedEffect, queued_effect2: queuedEffect2 }));
      }
      if (m.kind === 'target') {
        const t = m.target;
        if (typeof t === 'string') target = t;
        else if (t && typeof t === 'object' && typeof t.q === 'number' && typeof t.r === 'number') target = { q: t.q, r: t.r };
        else target = null;
        if (queuedEffect !== null && !casting && EFFECT_RULES[hand[queuedEffect]?.effect_id]?.resurrect) { prepareSummon(hand[queuedEffect], false); broadcastUI(handMsg()); }
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
        // A fortress building next to me (m.building = "q,r").
        const bld = typeof m.building === 'string' && /^-?\d+,-?\d+$/.test(m.building) ? m.building : null;
        // C1 ruling 2026-11-16: a reanimated enemy unit (m.reanimated = its peer id, m.elem Harmony / Concentration).
        const rean = !cls && typeof m.reanimated === 'string' && m.reanimated !== PEER_ID_STRING ? m.reanimated : null;
        const sameAs = (q) => !!q && q.stat === stat && (q.class || null) === cls && (q.reanimated || null) === rean && (q.building || null) === bld && !!q.recast === !!m.recast && !!q.untap === !!m.untap;
        if (!stat || sameAs(queuedDestroy)) queuedDestroy = null;
        else {
          queuedDestroy = { stat, ...(bld ? { building: bld } : {}), ...(cls ? { class: cls, elem: typeof m.elem === 'string' ? m.elem : null } : {}), ...(rean ? { reanimated: rean, elem: typeof m.elem === 'string' ? m.elem : null } : {}), ...(m.recast && entity.classArchived ? { recast: true } : {}), ...(m.untap && entity.classTapped && !entity.classArchived ? { untap: true } : {}) };
          const pi = hand.findIndex(c => c.kind === 'action' && c.code === 'P');
          queued = [pi >= 0 ? pi : 'EMPTY'];
          queuedSkills = queuedSkills.filter(i => hand[i]?.kind === 'skill' && !hand[i].is_trance && (hand[i].requires === 'P' || hand[i].requires === 'M'));
          queuedExtra = null;
          if (!keepsCastOnDestroy()) { queuedEffect = null; queuedEffect2 = null; queuedChain = []; queuedAura = false; }
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
        const blessPerms = [...entity.permanents].filter(p => EFFECT_RULES[p]?.blessAttach);
        const old = entity.channels.find(ch => blessPerms.includes(ch.holder));
        if (!locked && c?.kind === 'effect' && old && EFFECT_RULES[c.effect_id] && !EFFECT_RULES[c.effect_id].blessAttach) {
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
        // Phylactery (user ruling 2026-11-17): one click on the permanent — the resolver shatters the best permanent
        // of the nearest enemy at this action's end, then the Phylactery is spent. Toggle; inactive (no-op) with
        // nothing to shatter in reach.
        const hint = phylacteryHint();
        let notice = null;
        if (queuedPhylactery) queuedPhylactery = null;
        else if (!possessPermOf(entity.permanents) || entity.possessMode !== 'phylactery') notice = 'no Phylactery in your permanents';
        else if (!hint) notice = `💀 Phylactery inactive — no enemy with a permanent within ${phylReachOf(possessPermOf(entity.permanents))} hexes`;
        else { queuedPhylactery = { auto: true }; notice = `💀 Phylactery: ${hint.name}'s ${hint.perm} shatters at the end of this action`; }
        broadcastUI(handMsg({ queued_phylactery: queuedPhylactery, ...(notice ? { notice } : {}) }));
      }
      if (m.kind === 'possess_pick') {
        // Possess (user ruling 2026-11-17): the archive creature my next Possess plays. Toggle; none → the strongest.
        const c = archive.find(x => x.kind === 'creature' && x.card_id === m.card_id && data.creatures[x.creature_id]);
        queuedPossessPick = c && queuedPossessPick !== c.card_id ? c.card_id : null;
        broadcastUI(handMsg({ notice: queuedPossessPick ? `👁 Possess will play ${c.name}` : '👁 Possess pick cleared — it plays your strongest archived creature' }));
      }
      if (m.kind === 'class_ability') {
        // The class card clicked in the permanents strip: use its ability this action (user ruling 2026-10-30). Toggle.
        // Prophet (user rework #2 2026-11-14) is passive — its look fires by itself at the first contact of a turn.
        // Avenger is an ordinary once-per-turn click (the lure rides in the reveal as class_ability).
        if (hasHook(entity.classId, 'contact')) { broadcastUI(handMsg({ notice: `${clName(entity.classId)}: ${classUiOf(entity.classId).notice || 'automatic — it fires by itself'}` })); return; }
        if (locked) return;
        queuedClassAbility = !queuedClassAbility && !!entity.classId && !entity.classArchived && !classPassive(entity.classId) && !classBlocked();
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
        // An archived card goes back onto the discard pile. User override
        // (2026-11-04): creature + class cards may unarchive too so a player
        // can bulk-recycle the archive via the popup's "All → discard" button
        // (and manual single-card clicks on any kind).
        const i = archive.findIndex(c => c.card_id === m.card_id);
        let notice = null;
        if (i >= 0) { const [c] = archive.splice(i, 1); discard.push(c); notice = `${c.name || c.action_name || c.code} returns from the archive to the discard pile`; console.log(`[${PEER_LABEL}] unarchived ${c.card_id} (kind=${c.kind})`); }
        broadcastUI(handMsg(notice ? { notice } : {}));
      }
      if (m.kind === 'combo') {
        // UI hotkey C: toggles entity.comboState.active. Only arms if this
        // character has a combo published in data (characters.json carries a
        // 3-element `combo` array per entry). endRound() does the per-reveal
        // advance; doResolution() applies the completion damage so the hit
        // participates in the shared state hash.
        const seq = Array.isArray(entity.combo) ? entity.combo : [];
        if (m.active && seq.length) {
          entity.comboState = { active: true, slot: 0 };
          console.log(`[${PEER_LABEL}] combo armed: ${seq.join(' → ')}`);
        } else {
          entity.comboState = { active: false, slot: 0 };
          console.log(`[${PEER_LABEL}] combo disarmed`);
        }
      }
      // Dimension Out (rule_dimension_out): the HUD button starts the 10-turn channel, a second click cancels it.
      // `now: true` = the "Encounter defeated" banner (user 2026-11-23): leave at once, no channel (dimOutNow checks).
      if (m.kind === 'banter') banterFor(m.ids).catch(e => console.log(`[${PEER_LABEL}] banter: ${e.message}`));
      if (m.kind === 'dim_out' && m.now === true) dimOutNow();
      else if (m.kind === 'dim_out') {
        if (m.active === false || dimOut) dimOutCancel('cancelled by its player');
        else dimOutStart('the Dimension Out button');
      }
      if (m.kind === 'proposal_vote') ws.send(JSON.stringify(pvHandle(m, { profileFile: PROFILE_FILE, name: ENTITY_NAME, team: PROFILE_TEAM, dimension: DIM_NAME, door: DOOR_ID, peerId: PEER_ID_STRING, notify: broadcastUI })));   // PV: vote → <profile dir>/proposal_votes.json, author refused, background publish (OCI seed only)
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
    door_id: DOOR_ID, flow: IS_HUMAN ? 'open_dimension' : 'join_near_friend',
    character_id: CHARACTER_ID || null, creature_id: CREATURE_ID || null, class_id: null,
    deck_commitment: digestObj(deck.map(c => c.card_id)),
    entry_tile: entity.tile, adopted_head: null,
  },
});
await revealAround(entity.tile.q, entity.tile.r, { boot: true });
console.log(`[${PEER_LABEL}] map: seed ${MAP_SEED}, ${dimMap.size()} hexes in ${dimMap.blockCount()} blocks (reveal radius ${REVEAL_RADIUS})`);

// Hydrate obstacles / tokens / traps from a restored TMJ (map blocks were
// already seeded via `seedBlocks` above). Only my own obstacles / tokens /
// traps go onto `entity.*` — those belong to this peer. Other peers'
// obstacles come back through gossip once they rejoin.
if (_restoredTmj) {
  const mine = (o) => !o?.owner || o.owner === PEER_ID_STRING;
  for (const o of _restoredTmj.obstacles || []) if (mine(o)) entity.obstacles.push({ id: String(o.id || `restored-ob${entity.obstacles.length}`), q: o.q, r: o.r, hp: o.hp, elem: o.elem });
  for (const tk of _restoredTmj.tokens || []) if (!tk.owner || tk.owner === PEER_ID_STRING) entity.tileTokens.push({ id: String(tk.id || `restored-tk${entity.tileTokens.length}`), kind: tk.kind || 'bonus', elem: tk.elem, value: tk.value, q: tk.q, r: tk.r, ...(tk.item ? { item: tk.item } : {}) });
  for (const tp of _restoredTmj.traps || []) if (!tp.owner || tp.owner === PEER_ID_STRING) entity.traps.push({ id: String(tp.id || `restored-tp${entity.traps.length}`), q: tp.q, r: tp.r, effect_id: tp.effect_id, elements: tp.elements || [], card_id: tp.card_id, power: tp.power, trigger: tp.trigger, mode: tp.mode, holder: tp.holder });
  console.log(`[${PEER_LABEL}] restore: hydrated ${entity.obstacles.length} obstacles, ${entity.tileTokens.length} tokens, ${entity.traps.length} traps`);
  // World-edit ledger (user ruling 2026-11-18): the dimension's map edits as last saved — mine back into worldEdits,
  // every other author's into my ledger (published at once, so a solo rejoin still sees moved / made buildings).
  const wl = Array.isArray(_restoredTmj.worldLedger) ? _restoredTmj.worldLedger : [];
  if (wl.length) {
    entity.worldEdits = wl.filter(e => e?.by === PEER_ID_STRING).map(({ by: _b, ...e }) => e);
    entity.worldLedger = ledgerFor([{ peer_id: '', world_ledger_json: JSON.stringify(wl) }], PEER_ID_STRING);
    console.log(`[${PEER_LABEL}] restore: world ledger ${wl.length} edit(s) — ${entity.worldEdits.length} mine, ${entity.worldLedger.length} by others`);
  }
}

// Local TMJ autosave (game/tools/autosave.mjs). Takes a snapshot of the
// grow-only known map, my obstacles / tokens / traps and the live roster;
// writes `data/dimensions/<dim_id>/map_autosave.tmj` every AUTOSAVE_INTERVAL_MS
// (default 60 s) when the state is dirty. On shutdown it renames the
// autosave file to `map_hard.tmj` so the launcher's restore list can show it.
const AUTOSAVE_INTERVAL_MS = Number(process.env.AUTOSAVE_INTERVAL_MS || 60_000);
const getSnapshot = () => ({
  seed: MAP_SEED,
  bounds: dimMap.bounds(),
  blocks: dimMap.blocks(),
  obstacles: entity.obstacles,
  tokens: entity.tileTokens,
  traps: entity.traps,
  // World-edit ledger (2026-11-18): every author's map edits I know, mine included, each with `by`.
  world_ledger: [...(entity.worldEdits || []).map(e => ({ ...e, by: PEER_ID_STRING })), ...(entity.worldLedger || [])],
  entities: livePeers().map(p => ({
    peer_id: p.peer_id,
    source_id: p.character_id || p.creature_id || '',
    alliance: p.alliance || '',
    name: p.name || p.peer_id,
    hp: p.life ?? 0,
    hp_max: p.life_max ?? 0,
    tile_q: p.tile_q ?? 0,
    tile_r: p.tile_r ?? 0,
    class_id: p.class_id || (p.peer_id === PEER_ID_STRING ? entity.classId : '') || '',
  })),
  meta: { dim_id: DIM_ID, dim_name: DIM_NAME, peer_id: PEER_ID_STRING, peer_label: PEER_LABEL, turn: hg.turn, round: hg.round },
});
// Only a human hero writes it: every peer on this box shares the one file, and
// the launcher's "Load a saved dimension" rejoins as the save's author — a
// summon or a monster writing last made "me" a creature.
if (IS_HUMAN && !IS_COMPANION) try {
  _autosave = autosaveStart({ dimensionId: DIM_ID, dimensionName: DIM_NAME, mapSeed: MAP_SEED, intervalMs: AUTOSAVE_INTERVAL_MS, getSnapshot,
    privateGame: DIM_PRIVATE ? { mode: process.env.TEST_MODE || 'test' } : null });   // private.json: "test" in Load old Dimension
  console.log(`[${PEER_LABEL}] autosave: every ${AUTOSAVE_INTERVAL_MS}ms → ${_autosave.path}`);
} catch (e) { console.warn(`[${PEER_LABEL}] autosave disabled: ${e.message}`); }

// A joiner already runs on the adopted mesh clock (the tick may even be past it): entering planning
// again here added a whole ROUND_SEC to the adopted deadline (or reset a mid-handshake join to
// planning) — every joiner then committed a phase after its cohort, action after action (Swarm-0407:
// M-Foe3 adopted 22.56 s, committed at 28.59 s; lurker_m14_10 37.46 → 43.49). Only tell the UI.
if (!joinedClock) await enterPhase('planning');
else broadcastUI({ kind: 'phase', name: currentPhase, seconds: Math.max(0, Math.round((phaseEndsAt - Date.now()) / 100) / 10), heartbeat: anyAdjacentOpponents(), turn: hg.turn, round: hg.round, rounds_per_turn: ROUNDS_PER_TURN });

// Clean shutdown. Flush the autosave to its hard-save name before killing
// companions / libp2p so the file is coherent on disk.
async function _gracefulShutdown(sig) {
  console.log(`[${PEER_LABEL}] shutting down (${sig})`);
  try { await _autosave?.stop(); } catch {}
  for (const c of companions) { try { c.proc.kill(); } catch {} }
  try { await libp2p.stop(); } catch {}
  process.exit(0);
}
process.on('SIGINT',  () => { _gracefulShutdown('SIGINT').catch(() => process.exit(1)); });
process.on('SIGTERM', () => { _gracefulShutdown('SIGTERM').catch(() => process.exit(1)); });
process.on('beforeExit', () => { try { _autosave?.hardSave(); } catch {} });
