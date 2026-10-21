// Thin browser client — connects to peer:player-1 over WebSocket and renders
// the state the peer gossips. All simulation (libp2p mesh, Gun graph,
// hashgraph envelopes, resolver, radicle lottery) runs in the peer processes.

import { createRenderer } from './renderer.js';
import { pixelToHex, hexDistance } from './hex.js';

const PEER_URL = `ws://127.0.0.1:${new URL(location.href).searchParams.get('peer') || '7401'}/`;

const state = {
  dimension: 'Ashfall-Micro',
  phase: 'connecting…',
  seconds: 0,
  heartbeat: false,
  turn: 0,
  round: 0,
  roundsPerTurn: 3,
  myPeerId: null,
  entities: [],
  hand: [],
  queued: [],         // [] | [slotIndex] | ['EMPTY']
  queuedIsAuto: true, // false once the player has deliberately picked a slot this planning phase
  willDiscard: new Set(),  // card_ids flagged to drop at turn end — survives the hand shrinking within a turn
  target: null,       // peer_id | {q,r} | null
  locked: false,
  ui: { hoverTile: null, selectedTarget: null },
};

// Globally suppress the browser context menu — the UI uses right-click as a
// game input (discard toggle). Without this, right-clicking the hex map pops
// "Save image…" because the stage is a canvas.
document.addEventListener('contextmenu', (e) => e.preventDefault());

function logUI(text, kind = 'evt', opts = null) {
  const li = document.createElement('li');
  li.className = kind;
  if (opts?.link) {
    // Build the row from a prefix + a clickable <a>. textContent-based
    // construction keeps the user-supplied strings out of innerHTML and avoids
    // injection even though both inputs here are server-generated.
    li.appendChild(document.createTextNode(opts.prefix || ''));
    const a = document.createElement('a');
    a.href = opts.link;
    a.textContent = opts.linkText || opts.link;
    a.target = '_blank';
    a.rel = 'noopener';
    li.appendChild(a);
    if (opts.suffix) li.appendChild(document.createTextNode(opts.suffix));
  } else {
    li.textContent = text;
  }
  const log = document.getElementById('log');
  log.prepend(li);
  while (log.children.length > 80) log.lastChild.remove();
}

// Translate the queued pick into the action code the server will commit as.
// Rule 6: the single "Empty" slot plays as EM when the player has pre-declared
// a tile target (declared-first requirement), otherwise EP.
function effectiveQueuedCode() {
  const q = state.queued[0];
  if (q === 'EMPTY') {
    const hasTileTarget = state.target && typeof state.target === 'object' && 'q' in state.target;
    return hasTileTarget ? 'EM' : 'EP';
  }
  if (typeof q === 'number' && state.hand[q]) return state.hand[q].code;
  return null;
}

function renderDeck() {
  const slots = document.querySelectorAll('#slots .slot');
  slots.forEach(slot => {
    const key = slot.dataset.slot;
    const cardDiv = slot.querySelector('.card');
    if (key === 'EMPTY') {
      const code = effectiveQueuedCode();
      const liveLabel = state.queued[0] === 'EMPTY' ? ` → ${code || 'EP'}` : '';
      cardDiv.innerHTML = `<div class="nm">[EP/EM] Empty${liveLabel}</div><div class="cd">EM if a tile is targeted · else EP</div>`;
      slot.classList.toggle('queued', state.queued[0] === 'EMPTY');
      slot.classList.toggle('locked', state.locked && state.queued[0] === 'EMPTY');
      return;
    }
    const i = Number(key);
    const card = state.hand[i];
    cardDiv.innerHTML = card
      ? `<div class="nm">[${card.code}] ${card.action_name}</div><div class="cd">${card.card_id.slice(-6)}</div>`
      : `<div class="nm" style="opacity:.5">— empty slot —</div>`;
    slot.classList.toggle('queued', state.queued[0] === i);
    slot.classList.toggle('discard', !!card && state.willDiscard.has(card.card_id));
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

function autoselectFirstHandCard() {
  // Rule-of-thumb UX: default the queue to the first hand card so the auto-
  // commit at timer-0 picks something sensible when the player doesn't act.
  // Falls back to the EMPTY slot if the hand is empty for some reason.
  const firstIdx = state.hand.findIndex(c => !!c);
  if (firstIdx >= 0) state.queued = [firstIdx];
  else state.queued = ['EMPTY'];
  state.queuedIsAuto = true;
  send({ kind: 'queue', slots: state.queued });
}

function setPhase(name, seconds, heartbeat, m = {}) {
  state.phase = name; state.seconds = seconds; state.heartbeat = heartbeat;
  if (typeof m.turn === 'number') state.turn = m.turn;
  if (typeof m.round === 'number') state.round = m.round;
  if (typeof m.rounds_per_turn === 'number') state.roundsPerTurn = m.rounds_per_turn;
  document.getElementById('phase').textContent = name;
  document.getElementById('heartbeat').textContent = `tier: ${heartbeat ? 'strong (contact)' : 'reachable'}`;
  // Only the declaration window is worth a log line; the handshake phases
  // flash by in well under a second when the mesh is healthy.
  if (name === 'planning') logUI(`→ turn ${state.turn} · round ${state.round + 1}/${state.roundsPerTurn} (${seconds}s)`, 'phase');
  else if (name === 'game over') logUI(`→ game over${m.winner ? ` — ${m.winner}` : ''}`, 'phase');
  if (name === 'planning') {
    // New action — unlock, drop the stale target, auto-select a card. Discard
    // marks persist across the turn's rounds; the peer clears them at turn end.
    state.locked = false;
    state.target = null;
    state.ui.selectedTarget = null;
    autoselectFirstHandCard();
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
        state.myPeerId = m.peer_id;
        state.hand = m.hand || [];
        if (typeof m.turn === 'number') state.turn = m.turn;
        if (typeof m.round === 'number') state.round = m.round;
        if (typeof m.rounds_per_turn === 'number') state.roundsPerTurn = m.rounds_per_turn;
        // Merge rather than overwrite — the peer's initial hello may lag Gun's
        // own peer catalog.
        mergeEntities(m.peers || []);
        state.dimension = m.dimension || state.dimension;
        document.title = `ChaosD6 — ${state.dimension}`;
        document.getElementById('dim-name').textContent = `dimension: ${state.dimension}`;
        document.getElementById('door').textContent = `${m.door ? `door: ${m.door} · ` : ''}peer: ${m.peer_id}`;
        logUI(`peer hello — alliance ${m.alliance}, hand ${state.hand.length}`, 'phase');
        // Hello arrives after our first setPhase() has already attempted to
        // auto-select from an empty hand. Re-run now that we have cards.
        if (state.phase === 'planning' || state.phase === 'connecting…' || state.phase === 'linked to peer') {
          autoselectFirstHandCard();
        }
      }
      if (m.kind === 'phase') setPhase(m.name, m.seconds || 0, !!m.heartbeat, m);
      if (m.kind === 'hand')  {
        state.hand = m.hand || state.hand;
        if (Array.isArray(m.queued)) state.queued = m.queued;
        if (typeof m.turn === 'number') state.turn = m.turn;
        if (typeof m.round === 'number') state.round = m.round;
        if (m.turn_end) { state.willDiscard.clear(); logUI(`turn end — hand refilled to ${state.hand.length}`, 'phase'); }
      }
      // Merge peer updates so a transient broadcast missing an entity doesn't
      // flicker it off the map / roster. The server never *removes* a peer
      // from its view, so we don't need an opposing delete path here.
      if (m.kind === 'peers') {
        mergeEntities(m.peers || []);
        // The peer prunes stale members and flags the broadcast; mirror the
        // removal so ghosts from dead processes leave the roster and map.
        if (m.dropped) { const keep = new Set((m.peers || []).map(p => p.peer_id)); state.entities = state.entities.filter(e => keep.has(e.peer_id)); }
      }
      if (m.kind === 'evt') {
        const env = m.env;
        logUI(`${env.type} by ${env.actor_peer_id}${m.from_peer ? ' (mesh)' : ''}`, 'evt');
        if (env.type === 'evt_action_reveal') {
          const t = env.payload.target;
          const tLabel = t ? (t.kind === 'tile' ? `tile (${t.ref.q},${t.ref.r})` : t.ref) : '—';
          logUI(`  reveal: ${env.payload.action} → ${tLabel}`, 'evt');
        }
        if (env.type === 'evt_state_hash') {
          // Every peer independently emits an evt_state_hash for the turn, so
          // we'd log the same DMG line 4× without a dedupe. Key by (turn,
          // target, amount, source).
          state._loggedDmg ||= new Set();
          const dmg = env.payload.damage_applied || [];
          for (const d of dmg) {
            const key = `${env.turn}:${d.target}:${d.amount}:${d.source || ''}`;
            if (state._loggedDmg.has(key)) continue;
            state._loggedDmg.add(key);
            const tgt = state.entities.find(e => e.peer_id === d.target);
            logUI(`  DMG ${d.amount} → ${tgt?.name || d.target}`, 'damage');
          }
          // Prune older turns periodically so the set doesn't grow forever.
          if (state._loggedDmg.size > 500) state._loggedDmg = new Set([...state._loggedDmg].slice(-100));
        }
      }
      if (m.kind === 'contact') {
        // "A×B" pairs for every adjacent cross-side revealer. Shows what
        // actually opposed what after both sides have revealed — the user
        // asked for this specifically so they can read the resolution.
        for (const c of m.contacts) {
          const veto = c.a.vetoed || c.b.vetoed
            ? `  (vetoed: ${c.a.vetoed ? c.a.name + ' ' + c.a.vetoed : ''}${c.a.vetoed && c.b.vetoed ? '; ' : ''}${c.b.vetoed ? c.b.name + ' ' + c.b.vetoed : ''})`
            : '';
          logUI(`contact d=${c.distance}: ${c.a.name}[${c.a.action}] × ${c.b.name}[${c.b.action}]${veto}`, 'phase');
        }
      }
      if (m.kind === 'standoff') {
        logUI(m.winner ? `standoff — only ${m.winner} remains; rounds continue until a challenger joins` : 'a challenger has arrived — the fight resumes', 'damage');
      }
      if (m.kind === 'radicle') {
        const primary = m.explorerUrl || m.url || `/commit/${m.commit}`;
        const li = document.createElement('li');
        li.className = 'phase';
        li.appendChild(document.createTextNode('radicle push → '));
        const a = document.createElement('a');
        a.href = primary; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = m.commit.slice(0,10);
        li.appendChild(a);
        li.appendChild(document.createTextNode(` on ${m.branch}`));
        if (m.explorerUrl && m.localUrl) {
          li.appendChild(document.createTextNode(' · '));
          const b = document.createElement('a');
          b.href = m.localUrl; b.target = '_blank'; b.rel = 'noopener';
          b.textContent = 'local view';
          li.appendChild(b);
        } else if (!m.published) {
          li.appendChild(document.createTextNode(' (local only)'));
        }
        const log = document.getElementById('log');
        log.prepend(li);
        while (log.children.length > 80) log.lastChild.remove();
      }
    } catch (e) { console.error(e); }
  };
}

function mergeEntities(incoming) {
  const byId = new Map(state.entities.map(e => [e.peer_id, e]));
  for (const p of incoming) {
    if (!p || !p.peer_id) continue;
    byId.set(p.peer_id, { ...(byId.get(p.peer_id) || {}), ...p });
  }
  state.entities = [...byId.values()];
}

connect();

function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function queueSlot(key) {
  if (state.locked) return;
  // Single-action-per-turn (Rule 1 + Rule 7). Clicking the already-queued slot
  // unqueues it (so you can commit nothing → defaults to EP server-side);
  // clicking a different slot replaces the pick.
  if (state.queued[0] === key) {
    state.queued = [];
  } else {
    state.queued = [key];
  }
  state.queuedIsAuto = false;
  send({ kind: 'queue', slots: state.queued });
  renderDeck();
}

function toggleDiscard(i) {
  const card = state.hand[i];
  if (!card) return;
  if (state.willDiscard.has(card.card_id)) state.willDiscard.delete(card.card_id);
  else state.willDiscard.add(card.card_id);
  send({ kind: 'discard', slots: state.hand.map((c, idx) => c && state.willDiscard.has(c.card_id) ? idx : -1).filter(idx => idx >= 0) });
  renderDeck();
}

function wireInput() {
  document.querySelectorAll('#slots .slot').forEach(slotEl => {
    const key = slotEl.dataset.slot;
    const slotKey = key === 'EMPTY' ? 'EMPTY' : Number(key);
    slotEl.addEventListener('click', () => queueSlot(slotKey));
    if (key !== 'EMPTY') {
      slotEl.addEventListener('contextmenu', (e) => { e.preventDefault(); toggleDiscard(slotKey); });
    }
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key >= '1' && ev.key <= '5') queueSlot(Number(ev.key) - 1);
    else if (ev.key === '8') queueSlot('EMPTY');
    else if (ev.code === 'Space') { ev.preventDefault(); if (state.queued.length) { state.locked = true; send({ kind: 'lock' }); logUI('commit locked (early)', 'phase'); renderDeck(); } }
  });

  const canvas = document.getElementById('stage');

  const renderer = createRenderer(canvas, {
    get entities() {
      return state.entities.map(p => {
        const isMe = p.peer_id === state.myPeerId;
        return {
          peerId: p.peer_id, alliance: p.alliance, name: p.name,
          tile: { q: p.tile_q, r: p.tile_r }, life: p.life, lifeMax: p.life_max,
          isSelf: isMe,
          queuedCode: isMe ? effectiveQueuedCode() : null,
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
    if (occupant && occupant.peer_id !== state.myPeerId) {
      state.target = occupant.peer_id;
      logUI(`target → ${occupant.name}`, 'phase');
    } else {
      state.target = { q: t.q, r: t.r };
      logUI(`target → tile (${t.q},${t.r})`, 'phase');
    }
    send({ kind: 'target', target: state.target });
  });

  // Right-click on an adjacent empty tile = "just walk there." Overrides the
  // queued pick only when it's unsafe-to-override absent: either the player
  // left the auto-selected default alone, or they picked Attack but the tile
  // is empty (so Attack would resolve into empty space anyway). Non-Attack
  // deliberate picks (Block, Posture, Move onto a peer, etc.) are preserved.
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (state.phase !== 'planning' || state.locked) return;
    const rect = canvas.getBoundingClientRect();
    const t = pixelToHex(ev.clientX - rect.left, ev.clientY - rect.top, renderer.origin());
    if (!t) return;
    const me = state.entities.find(p => p.peer_id === state.myPeerId);
    if (!me || typeof me.tile_q !== 'number') return;
    if (hexDistance({ q: me.tile_q, r: me.tile_r }, t) !== 1) return;
    const occupied = state.entities.some(p => p.life > 0 && p.tile_q === t.q && p.tile_r === t.r);
    if (occupied) return;
    const q0 = state.queued[0];
    const queuedCode = typeof q0 === 'number' ? state.hand[q0]?.code : (q0 === 'EMPTY' ? 'EM' : null);
    const isAttackQueued = queuedCode === 'A';
    if (!isAttackQueued && !state.queuedIsAuto) return;
    state.queued = ['EMPTY'];
    state.queuedIsAuto = false;
    state.target = { q: t.q, r: t.r };
    state.ui.selectedTarget = t;
    send({ kind: 'queue', slots: state.queued });
    send({ kind: 'target', target: state.target });
    logUI(`quick-walk → tile (${t.q},${t.r}) [EM]`, 'phase');
    renderDeck();
  });

  // Phase timer tick (visual only — peers own real timing).
  setInterval(() => {
    state.seconds = Math.max(0, state.seconds - 0.25);
    document.getElementById('timer').textContent = `${state.seconds.toFixed(0)}s`;
    document.getElementById('turn').textContent = `turn ${state.turn} · round ${state.round + 1}/${state.roundsPerTurn}`;
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
