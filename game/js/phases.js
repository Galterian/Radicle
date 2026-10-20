// Phase FSM.
//   planning  (10s or 6s combat-heartbeat) — player picks + locks cards
//   reveal    (5s)                         — face-up, verify commitments
//   resolution(5s)                         — resolver applies damage/moves
//   cleanup   (short)                       — discard, draw, next turn
// Pacing matches mode_time_management (round_total_s 15..50) and the libp2p+GunDB
// extension in chaosD6_request_phase1_extract_jsons_2.txt (6s active-session loop
// whenever two entities share a contact zone).

import { hexDistance } from './hex.js';
import { emit, stateHashOfRegion } from './hashgraph.js';
import { randSaltHex, sha256Hex } from './sha.js';
import { planForNPC } from './ai.js';
import { resolveRound } from './combat.js';
import { drawHandUpTo } from './deck.js';
import { isAlive } from './entities.js';
import { writeArtefact, sessionPaths } from './radicle.js';

export const PHASES = {
  PLANNING_SLOW: { name: 'planning',   seconds: 10, tier: 'reachable' },
  PLANNING_HEARTBEAT: { name: 'planning', seconds: 6, tier: 'strong (6s heartbeat)' },
  REVEAL: { name: 'reveal', seconds: 5, tier: 'strong' },
  RESOLUTION: { name: 'resolution', seconds: 5, tier: 'strong' },
  CLEANUP: { name: 'cleanup', seconds: 2, tier: 'strong' },
};

function anyAdjacentOpponents(entities) {
  for (const a of entities) {
    if (!isAlive(a)) continue;
    for (const b of entities) {
      if (!isAlive(b)) continue;
      if (a === b || a.alliance === b.alliance) continue;
      if (hexDistance(a.tile, b.tile) <= 1) return true;
    }
  }
  return false;
}

export function createPhaseController(state, hg, resolver, hud) {
  let currentPhase = null;
  let endsAt = 0;
  let interval = null;

  async function enter(phase) {
    currentPhase = phase;
    endsAt = performance.now() + phase.seconds * 1000;
    hud.setPhase(phase.name, phase.tier);
    state.events.push({ kind: 'phase', text: `→ ${phase.name} (${phase.seconds}s · tier: ${phase.tier})` });

    if (phase === PHASES.REVEAL)      await doReveal();
    if (phase === PHASES.RESOLUTION)  await doResolve();
    if (phase === PHASES.CLEANUP)     await doCleanup();
  }

  async function doReveal() {
    for (const e of state.entities) {
      if (!isAlive(e)) continue;
      if (e.alliance !== 'player') {
        const plan = planForNPC(e, state.entities);
        e.queued = plan.queuedSlots;
        e.target = plan.target;
        e._emptyMoveAway = plan.emptyMoveAway;
      }
    }
    // Emit evt_action_reveal with the plaintext selections and salts.
    for (const e of state.entities) {
      if (!isAlive(e)) continue;
      const card = e.queued[0] != null ? e.hand[e.queued[0]] : null;
      const code = card ? card.code : (e._emptyMoveAway ? 'EM' : 'EP');
      await emit(hg, {
        type: 'evt_action_reveal',
        actor: e.peerId,
        doorId: state.dimension.doors[0],
        payload: {
          action: code,
          effects: [],
          skills: [],
          class_ability_tapped: false,
          target: e.target ? { kind: 'character', ref: e.target } : null,
          combo_step: e.combo ? ((e.combo.indexOf(code) >= 0) ? e.combo.indexOf(code) : null) : null,
          salt: e._lastSalt,
        },
      });
    }
  }

  async function doResolve() {
    resolveRound(resolver, state.entities, state.events);

    // Deterministic region state hash for consensus (evt_state_hash).
    const regionState = state.entities.map(e => ({
      id: e.peerId, tile: e.tile, life: e.life, hand: e.hand.length, discard: e.discard.length,
    }));
    const sh = await stateHashOfRegion(regionState);
    for (const e of state.entities) {
      if (!isAlive(e)) continue;
      await emit(hg, {
        type: 'evt_state_hash',
        actor: e.peerId,
        doorId: state.dimension.doors[0],
        payload: { state_hash: sh, damage_applied: [], tokens_changed: [] },
      });
    }
  }

  async function doCleanup() {
    for (const e of state.entities) {
      if (!isAlive(e)) continue;
      drawHandUpTo(e, 5);
    }
    hg.turn += 1;
    hg.round += 1;

    // evt_turn_commit — gossip to the whole Dimension.
    await emit(hg, {
      type: 'evt_turn_commit',
      actor: state.player.peerId,
      doorId: state.dimension.doors[0],
      payload: {
        turn: hg.turn,
        region_state_hash: hg.events.at(-1)?.payload?.state_hash || '',
        map_delta: [],
        positions: Object.fromEntries(state.entities.map(e => [e.peerId, e.tile])),
        hashgraph_head: hg.head,
        draws: state.entities.filter(isAlive).map(e => ({ peer_id: e.peerId, cards_drawn: 5 - e.hand.length })),
      },
    });

    // Update the DoorID.json snapshot (dimension_session.session_door shape).
    await writeArtefact(
      sessionPaths.door(state.dimension.dimension_name, state.dimension.doors[0]),
      state.doorDocument(hg)
    );
  }

  async function tick() {
    const remaining = Math.max(0, Math.ceil((endsAt - performance.now()) / 1000));
    hud.setTimer(remaining);
    if (performance.now() < endsAt) return;

    if (currentPhase === PHASES.PLANNING_SLOW || currentPhase === PHASES.PLANNING_HEARTBEAT) {
      // Lock any unlocked player selections (fallback = Empty Posture).
      await commitAll();
      await enter(PHASES.REVEAL);
    } else if (currentPhase === PHASES.REVEAL) {
      await enter(PHASES.RESOLUTION);
    } else if (currentPhase === PHASES.RESOLUTION) {
      await enter(PHASES.CLEANUP);
    } else if (currentPhase === PHASES.CLEANUP) {
      if (checkWin()) { stop(); return; }
      await enter(anyAdjacentOpponents(state.entities) ? PHASES.PLANNING_HEARTBEAT : PHASES.PLANNING_SLOW);
    }
  }

  async function commitAll() {
    for (const e of state.entities) {
      if (!isAlive(e)) continue;
      const salt = randSaltHex(12);
      e._lastSalt = salt;
      let card = e.queued[0] != null ? e.hand[e.queued[0]] : null;
      let code = card ? card.code : (e.alliance === 'player' ? 'EP' : 'EP');
      if (e.alliance !== 'player') {
        // NPC commits happen here too — their actual code was already stored on e in doReveal
        // precursor (plan runs in reveal). To keep ordering deterministic we commit with
        // the hand card they chose during reveal when they re-plan. Here we commit a
        // placeholder; the real reveal happens with the up-to-date plan.
      }
      const commitHash = await sha256Hex(`${code}::${e.target || ''}::${salt}`);
      await emit(hg, {
        type: 'evt_action_commit',
        actor: e.peerId,
        doorId: state.dimension.doors[0],
        payload: { commitment: commitHash, empty_move_announced: code === 'EM' },
      });
    }
  }

  function checkWin() {
    const alive = state.entities.filter(isAlive);
    const alliances = new Set(alive.map(e => e.alliance));
    if (alliances.size <= 1) {
      const winner = alliances.values().next().value || 'nobody';
      state.events.push({ kind: 'phase', text: `GAME OVER — ${winner} alliance holds the dimension.` });
      hud.setPhase('game over', winner);
      return true;
    }
    return false;
  }

  async function start() {
    await enter(PHASES.PLANNING_SLOW);
    interval = setInterval(() => tick().catch(e => console.error(e)), 200);
  }
  function stop() { if (interval) { clearInterval(interval); interval = null; } }

  return { start, stop, currentPhase: () => currentPhase };
}
