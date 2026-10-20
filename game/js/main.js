// Thin browser client — connects to peer:player-1 over WebSocket and renders the
// state the peer gossips. All simulation (libp2p mesh, GunDB graph, hashgraph
// envelopes, resolver, radicle lottery) runs in the peer processes.

import { createRenderer } from './renderer.js';
import { pixelToHex, hexDistance } from './hex.js';

const PEER_URL = `ws://127.0.0.1:${new URL(location.href).searchParams.get('peer') || '7401'}/`;

const state = {
  dimension: 'Ashfall-Micro',
  phase: 'connecting…',
  seconds: 0,
  heartbeat: false,
  turn: 0,
  myPeerId: null,
  entities: [],      // from peer `peers` message
  player: null,      // our entity (never replaced wholesale after hello — mutate .life)
  hand: [],
  queued: [],        // one of: [] | [slotIndex] | ['EP'] | ['EM']
  willDiscard: new Set(),
  target: null,      // peer_id string | {q,r} tile object | null
  locked: false,
  events: [],
  ui: { hoverTile: null, selectedTarget: null },
};

// Globally suppress the browser context menu — the whole UI uses right-click as
// a game input (discard toggle on hand slots). Without this, right-clicking the
// hex map pops the "Save image…" menu because the stage is a canvas.
document.addEventListener('contextmenu', (e) => e.preventDefault());

function logUI(text, kind = 'evt') {
  const li = document.createElement('li');
  li.textContent = text;
  li.className = kind;
  const log = document.getElementById('log');
  log.prepend(li);
  while (log.children.length > 80) log.lastChild.remove();
}

function queuedLabel() {
  const q = state.queued[0];
  if (q === 'EP') return 'EP';
  if (q === 'EM') return 'EM';
  if (typeof q === 'number' && state.hand[q]) return state.hand[q].code;
  return null;
}

function renderDeck() {
  const slots = document.querySelectorAll('#slots .slot');
  slots.forEach(slot => {
    const key = slot.dataset.slot;
    const cardDiv = slot.querySelector('.card');
    if (key === 'EP' || key === 'EM') {
      // Preserve the static label; just toggle queued styling.
      slot.classList.toggle('queued', state.queued[0] === key);
      slot.classList.toggle('locked', state.locked && state.queued[0] === key);
      return;
    }
    const i = Number(key);
    const card = state.hand[i];
    cardDiv.innerHTML = card
      ? `<div class="nm">[${card.code}] ${card.action_name}</div><div class="cd">${card.card_id.slice(-6)}</div>`
      : `<div class="nm" style="opacity:.5">— empty slot —</div>`;
    slot.classList.toggle('queued', state.queued[0] === i);
    slot.classList.toggle('discard', state.willDiscard.has(i));
    slot.classList.toggle('locked', state.locked && state.queued[0] === i);
  });
}

function renderRoster() {
  const el = document.getElementById('roster');
  el.innerHTML = '';
  for (const e of state.entities) {
    const row = document.createElement('div');
    row.className = `ros ${e.alliance === 'player' || e.alliance === 'npc_a' ? 'ally' : 'enemy'} ${e.life > 0 ? '' : 'dead'}`;
    const srcTag = (e.source_id || e.sourceId || '').split('_').slice(1, 3).join(' ');
    row.innerHTML = `<span class="nm">${e.name}</span>
      <span class="st">${srcTag} · hp ${e.life}/${e.life_max || e.lifeMax} · (${e.tile_q ?? e.tile?.q},${e.tile_r ?? e.tile?.r})</span>`;
    el.appendChild(row);
  }
}

function setPhase(name, seconds, heartbeat) {
  state.phase = name; state.seconds = seconds; state.heartbeat = heartbeat;
  document.getElementById('phase').textContent = name;
  document.getElementById('heartbeat').textContent = `tier: ${heartbeat ? 'strong (6s heartbeat)' : (name === 'planning' ? 'reachable' : 'strong')}`;
  logUI(`→ ${name} (${seconds}s)`, 'phase');
  if (name === 'planning') {
    // New turn — start fresh.
    state.locked = false;
    state.willDiscard.clear();
  }
}

let ws;
function connect() {
  ws = new WebSocket(PEER_URL);
  ws.onopen = () => { document.getElementById('phase').textContent = 'linked to peer'; logUI(`WebSocket link to ${PEER_URL}`, 'phase'); };
  ws.onclose = () => { document.getElementById('phase').textContent = 'disconnected'; setTimeout(connect, 1000); };
  ws.onerror = () => { document.getElementById('phase').textContent = 'ws error'; };
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.kind === 'hello') {
        state.player = m.entity;
        state.myPeerId = m.peer_id;
        state.hand = m.hand || [];
        state.entities = m.peers || [];
        document.getElementById('dim-name').textContent = `dimension: Ashfall-Micro`;
        document.getElementById('door').textContent = `peer: ${m.peer_id}`;
        logUI(`peer hello — alliance ${m.alliance}, hand ${state.hand.length}`, 'phase');
      }
      if (m.kind === 'phase') {
        setPhase(m.name, m.seconds || 0, !!m.heartbeat);
        if (m.name === 'planning') {
          // Server advanced turn — clear queue so stale selections don't leak.
          state.queued = [];
          state.target = null;
          state.ui.selectedTarget = null;
        }
      }
      if (m.kind === 'hand') {
        state.hand = m.hand || state.hand;
        if (Array.isArray(m.queued)) state.queued = m.queued;
      }
      if (m.kind === 'peers') state.entities = m.peers || [];
      if (m.kind === 'evt') {
        const env = m.env;
        logUI(`${env.type} by ${env.actor_peer_id}${m.from_peer ? ' (mesh)' : ''}`, 'evt');
        if (env.type === 'evt_action_reveal') {
          const t = env.payload.target;
          const tLabel = t ? (t.kind === 'tile' ? `tile (${t.ref.q},${t.ref.r})` : t.ref) : 'self';
          logUI(`  reveal: ${env.payload.action} → ${tLabel}`, 'evt');
        }
        if (env.type === 'evt_state_hash') {
          const dmg = env.payload.damage_applied || [];
          for (const d of dmg) {
            const tgt = state.entities.find(e => e.peer_id === d.target);
            logUI(`  DMG ${d.amount} → ${tgt?.name || d.target}`, 'damage');
          }
          if (dmg.length === 0) logUI(`  resolved: no damage dealt`, 'evt');
        }
      }
      if (m.kind === 'radicle') logUI(`radicle push → ${m.commit.slice(0,10)} on ${m.branch}`, 'phase');
    } catch (e) { console.error(e); }
  };
}
connect();

function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

// Rule 1 + Rule 7: one action card per turn. The second slot click replaces the
// first; clicking the same slot unqueues it. The Posture + effect pathway isn't
// in the deck yet (effects aren't dealt), so for now this is strict single.
function queueSlot(key) {
  if (state.locked) return;
  if (state.queued[0] === key) {
    state.queued = [];
  } else {
    state.queued = [key];
  }
  send({ kind: 'queue', slots: state.queued });
  renderDeck();
}

function toggleDiscard(i) {
  if (state.willDiscard.has(i)) state.willDiscard.delete(i);
  else state.willDiscard.add(i);
  renderDeck();
}

function wireInput() {
  document.querySelectorAll('#slots .slot').forEach(slotEl => {
    const key = slotEl.dataset.slot;
    const isEmpty = (key === 'EP' || key === 'EM');
    const slotKey = isEmpty ? key : Number(key);
    slotEl.addEventListener('click', () => queueSlot(slotKey));
    if (!isEmpty) {
      slotEl.addEventListener('contextmenu', (e) => { e.preventDefault(); toggleDiscard(slotKey); });
    }
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key >= '1' && ev.key <= '5') queueSlot(Number(ev.key) - 1);
    else if (ev.key === '8') queueSlot('EP');
    else if (ev.key === '9') queueSlot('EM');
    else if (ev.code === 'Space') { ev.preventDefault(); if (state.queued.length) { state.locked = true; send({ kind: 'lock' }); logUI('commit locked', 'phase'); renderDeck(); } }
  });

  const canvas = document.getElementById('stage');
  // Belt-and-suspenders: canvas-level contextmenu suppression in case anything
  // else later stops propagation above document.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const renderer = createRenderer(canvas, {
    get entities() {
      return state.entities.map(p => {
        const isMe = p.peer_id === state.myPeerId;
        return {
          peerId: p.peer_id, alliance: p.alliance, name: p.name,
          tile: { q: p.tile_q, r: p.tile_r }, life: p.life, lifeMax: p.life_max,
          isSelf: isMe,
          queuedCode: isMe ? queuedLabel() : null,
          locked: isMe ? state.locked : false,
        };
      });
    },
    ui: state.ui,
  });
  canvas.addEventListener('mousemove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    state.ui.hoverTile = pixelToHex(ev.clientX - rect.left, ev.clientY - rect.top, renderer.origin());
  });
  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const t = pixelToHex(ev.clientX - rect.left, ev.clientY - rect.top, renderer.origin());
    if (!t) return;
    const occupant = state.entities.find(p => p.life > 0 && p.tile_q === t.q && p.tile_r === t.r);
    state.ui.selectedTarget = t;
    // If a live entity is on the tile, target the entity by peer_id (needed for
    // Attack). Otherwise send a bare tile target — Move supports that.
    if (occupant && occupant.peer_id !== state.myPeerId) {
      state.target = occupant.peer_id;
      logUI(`target → ${occupant.name}`, 'phase');
    } else {
      state.target = { q: t.q, r: t.r };
      logUI(`target → tile (${t.q},${t.r})`, 'phase');
    }
    send({ kind: 'target', target: state.target });
  });

  // Phase timer tick (visual only — peers own real timing).
  setInterval(() => {
    state.seconds = Math.max(0, state.seconds - 0.25);
    document.getElementById('timer').textContent = `${state.seconds.toFixed(0)}s`;
    document.getElementById('turn').textContent = `turn ${state.turn}`;
  }, 250);
  function raf() {
    renderRoster();
    renderDeck();
    renderer.render();
    requestAnimationFrame(raf);
  }
  raf();
}

wireInput();
