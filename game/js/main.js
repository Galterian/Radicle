// Thin browser client — connects to peer:player-1 over WebSocket and renders the
// state the peer gossips. All simulation (libp2p mesh, GunDB graph, hashgraph
// envelopes, resolver, radicle lottery) runs in the peer processes.

import { createRenderer } from './renderer.js';
import { pixelToHex } from './hex.js';

const PEER_URL = `ws://127.0.0.1:${new URL(location.href).searchParams.get('peer') || '7401'}/`;

const state = {
  dimension: 'Ashfall-Micro',
  phase: 'connecting…',
  seconds: 0,
  heartbeat: false,
  turn: 0,
  entities: [],      // from peer `peers` message
  player: null,      // our entity + hand
  hand: [],
  queued: [],
  willDiscard: new Set(),
  target: null,
  locked: false,
  events: [],
  ui: { hoverTile: null, selectedTarget: null },
};

function logUI(text, kind = 'evt') {
  const li = document.createElement('li');
  li.textContent = text;
  li.className = kind;
  const log = document.getElementById('log');
  log.prepend(li);
  while (log.children.length > 80) log.lastChild.remove();
}

function renderDeck() {
  const slots = document.querySelectorAll('#slots .slot');
  slots.forEach((slot, i) => {
    const card = state.hand[i];
    const cardDiv = slot.querySelector('.card');
    cardDiv.innerHTML = card
      ? `<div class="nm">[${card.code}] ${card.action_name}</div><div class="cd">${card.card_id.slice(-6)}</div>`
      : `<div class="nm" style="opacity:.5">— empty slot —</div>`;
    slot.classList.toggle('queued', state.queued.includes(i));
    slot.classList.toggle('discard', state.willDiscard.has(i));
    slot.classList.toggle('locked', state.locked && state.queued.includes(i));
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
        state.hand = m.hand || [];
        state.entities = m.peers || [];
        document.getElementById('dim-name').textContent = `dimension: Ashfall-Micro`;
        document.getElementById('door').textContent = `peer: ${m.peer_id}`;
        logUI(`peer hello — alliance ${m.alliance}, hand ${state.hand.length}`, 'phase');
      }
      if (m.kind === 'phase')  setPhase(m.name, m.seconds || 0, !!m.heartbeat);
      if (m.kind === 'hand')   { state.hand = m.hand || state.hand; state.queued = m.queued || state.queued; }
      if (m.kind === 'peers')  state.entities = m.peers || [];
      if (m.kind === 'evt')    logUI(`${m.env.type} by ${m.env.actor_peer_id}${m.from_peer ? ' (mesh)' : ''}`, 'evt');
      if (m.kind === 'radicle') logUI(`radicle push → ${m.commit.slice(0,10)} on ${m.branch}`, 'phase');
    } catch (e) { console.error(e); }
  };
}
connect();

function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function queueSlot(i) {
  if (state.locked) return;
  const pos = state.queued.indexOf(i);
  if (pos >= 0) state.queued.splice(pos, 1);
  else {
    if (state.queued.length >= 3) state.queued.shift();
    state.queued.push(i);
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
    const idx = Number(slotEl.dataset.slot);
    slotEl.addEventListener('click', () => queueSlot(idx));
    slotEl.addEventListener('contextmenu', (e) => { e.preventDefault(); toggleDiscard(idx); });
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key >= '1' && ev.key <= '5') queueSlot(Number(ev.key) - 1);
    else if (ev.key === '8') { state.queued = []; send({ kind: 'emptyPosture' }); renderDeck(); logUI('queued Empty Posture', 'phase'); }
    else if (ev.code === 'Space') { ev.preventDefault(); state.locked = true; send({ kind: 'lock' }); logUI('commit locked', 'phase'); renderDeck(); }
  });
  const canvas = document.getElementById('stage');
  const renderer = createRenderer(canvas, {
    get entities() {
      return state.entities.map(p => ({
        peerId: p.peer_id, alliance: p.alliance, name: p.name,
        tile: { q: p.tile_q, r: p.tile_r }, life: p.life, lifeMax: p.life_max,
        queued: [], hand: [], locked: false,
      }));
    },
    ui: state.ui,
    player: null,
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
    state.target = occupant ? occupant.peer_id : null;
    send({ kind: 'target', target: state.target });
    logUI(`target → ${occupant ? occupant.name : `tile (${t.q},${t.r})`}`, 'phase');
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
