// Thin browser client — connects to peer:player-1 over WebSocket and renders
// the state the peer gossips. All simulation (libp2p mesh, Gun graph,
// hashgraph envelopes, resolver, radicle lottery) runs in the peer processes.

import { createRenderer } from './renderer.js';
import { pixelToHex, hexDistance, stepToward, findPath, HEX_SIZE } from './hex.js';

// Direct DOM poke rather than importing from launcher.js — launcher.js is the
// one that imports *us*, so pulling a symbol back creates a cycle that in a
// top-level-await module graph can leave the function binding unresolved and
// the overlay stuck up. One line of DOM manipulation is cheaper than that.
function hideEntering() {
  const ov = document.getElementById('entering-overlay');
  if (ov) ov.hidden = true;
}

// Click within this many pixels of an entity's drawn centre counts as a hit on
// that entity. The body circle is r=16; 24 gives a little slack without
// swallowing clicks meant for the neighbouring tile (hex centres are ~80px apart).
const ENTITY_HIT_PX = 24;
const HEX_SIZE_SQ_HIT = ENTITY_HIT_PX * ENTITY_HIT_PX;

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
  deckCount: 0,       // cards still in the draw pile — rendered as the stacked pile on the right
  discardCount: 0,    // cards in the discard pile
  queued: [],         // [] | [slotIndex] | ['EMPTY']
  queuedIsAuto: true, // false once the player has deliberately picked a slot this planning phase
  willDiscard: new Set(),  // card_ids flagged to drop at turn end — survives the hand shrinking within a turn
  target: null,       // peer_id | {q,r} | null
  locked: false,
  // destinationTile is the hex the player right-clicked; pathPlan is the full
  // list of hexes (step 1 … destination) the auto-walker will follow across
  // rounds. Both survive planning→reveal→resolution so the next round can
  // pick up where this one left off.
  ui: { hoverTile: null, selectedTarget: null, destinationTile: null, pathPlan: null, logFilterPeerId: null, floatingDmgs: [] },
};

// Build the "blocked" set the pathfinder uses: every alive entity other than
// me stands on an impassable tile.
function blockedTilesExcluding(myPeerId) {
  const blocked = new Set();
  for (const p of state.entities) {
    if (!p || p.life <= 0 || p.peer_id === myPeerId) continue;
    if (!Number.isInteger(p.tile_q) || !Number.isInteger(p.tile_r)) continue;
    blocked.add(`${p.tile_q},${p.tile_r}`);
  }
  return blocked;
}

// Cancel an in-progress multi-round journey. Called from any manual action the
// user takes that doesn't fit the "keep walking to the destination" story
// (slot pick, Space commit of something else, left-click a different tile).
function cancelPathJourney(reason) {
  if (!state.ui.destinationTile && !state.ui.pathPlan) return;
  state.ui.destinationTile = null;
  state.ui.pathPlan = null;
  if (reason) logUI(`journey cancelled (${reason})`, 'phase');
}

// Called at the start of each planning phase. If a journey is in progress and
// still reachable, (re)compute the path from the player's current tile and
// auto-stage an Empty Move toward the next step. Returns true when a journey
// is being resumed, false when the caller should fall back to the normal
// first-hand-card autoselect.
function resumeJourney() {
  // A journey only exists when a right-click computed a full A* path and
  // stored it in `pathPlan`. A plain destinationTile from an Attack-step or
  // a blocked single-step fallback is just a visual cue — don't auto-walk.
  if (!state.ui.pathPlan) return false;
  const dest = state.ui.destinationTile;
  if (!dest) return false;
  const me = state.entities.find(p => p.peer_id === state.myPeerId);
  if (!me || !Number.isInteger(me.tile_q)) return false;
  if (me.tile_q === dest.q && me.tile_r === dest.r) {
    // Arrived — tear down the journey rather than looping on a zero-length
    // path.
    state.ui.pathPlan = null;
    state.ui.destinationTile = null;
    logUI(`journey complete at (${dest.q},${dest.r})`, 'phase');
    return false;
  }
  const blocked = blockedTilesExcluding(state.myPeerId);
  const path = findPath({ q: me.tile_q, r: me.tile_r }, dest, blocked);
  if (!path.length) {
    cancelPathJourney('blocked');
    return false;
  }
  state.ui.pathPlan = path;
  const step = path[0];
  state.queued = ['EMPTY'];
  state.queuedIsAuto = true;
  send({ kind: 'queue', slots: state.queued });
  state.target = { q: step.q, r: step.r };
  state.ui.selectedTarget = step;
  send({ kind: 'target', target: state.target });
  logUI(`journey → (${step.q},${step.r}) toward (${dest.q},${dest.r}) [EM, auto]`, 'phase');
  return true;
}

// --- event-log filter: click an entity to narrow the log to its events ---
function applyLogFilterRow(li) {
  const f = state.ui.logFilterPeerId;
  if (!f) { li.hidden = false; return; }
  // Keep rows that are either scoped to the filtered peer, or truly global
  // (phase / connection notices without a peer id).
  li.hidden = li.dataset.peerId ? li.dataset.peerId !== f : true;
}
function applyLogFilter() {
  const log = document.getElementById('log');
  for (const li of log.children) applyLogFilterRow(li);
  const chip = document.getElementById('log-filter-chip');
  if (chip) {
    if (state.ui.logFilterPeerId) {
      chip.hidden = false;
      chip.querySelector('.name').textContent = peerShort(state.ui.logFilterPeerId);
    } else chip.hidden = true;
  }
}
function setLogFilter(peerId) {
  state.ui.logFilterPeerId = peerId || null;
  applyLogFilter();
}

// Globally suppress the browser context menu — the UI uses right-click as a
// game input (discard toggle). Without this, right-clicking the hex map pops
// "Save image…" because the stage is a canvas.
document.addEventListener('contextmenu', (e) => e.preventDefault());

function logUI(text, kind = 'evt', opts = null) {
  const li = document.createElement('li');
  li.className = kind;
  if (opts?.peerId) li.dataset.peerId = opts.peerId;
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
  while (log.children.length > 120) log.lastChild.remove();
  applyLogFilterRow(li);
}

// Fold the per-round envelopes into one row keyed by (actor, turn, round). As
// commit → reveal → state_hash → push arrive, each badge lights up in place.
// This keeps the log at ~1 line per actor-round instead of 4-5.
const EVT_ROWS = new Map();  // key: "<peer>:T<turn>R<round>" → <li>
const EVT_KEY_ORDER = [];     // insertion order; capped so the map doesn't grow

function peerShort(peerId) {
  const e = state.entities.find(p => p.peer_id === peerId);
  if (!e) return peerId ? peerId.slice(0, 10) : '—';
  const hp = Number.isFinite(e.life) ? ` - ${e.life}❤️` : '';
  return `${e.name}${hp}`;
}

function evtRow(env) {
  const key = `${env.actor_peer_id}:T${env.turn}R${env.round}`;
  let li = EVT_ROWS.get(key);
  if (li) return li;
  li = document.createElement('li');
  li.className = 'evt handshake';
  li.dataset.peerId = env.actor_peer_id;
  li.dataset.turn = String(env.turn);
  li.dataset.round = String(env.round);
  li.innerHTML = `
    <span class="hs-prefix">T${env.turn}.${env.round + 1}</span>
    <span class="hs-actor">${peerShort(env.actor_peer_id)}</span>
    <span class="hs-badge commit"  title="committed (hidden)">⚑</span>
    <span class="hs-badge reveal"  title="reveal pending">⚐<span class="hs-action"></span></span>
    <span class="hs-badge state"   title="state hash">✓</span>
    <span class="hs-badge push"    title="radicle push">⇡<span class="hs-push"></span></span>
  `;
  const log = document.getElementById('log');
  log.prepend(li);
  EVT_ROWS.set(key, li);
  EVT_KEY_ORDER.push(key);
  // Cap total handshake rows + total log rows.
  while (EVT_KEY_ORDER.length > 60) {
    const drop = EVT_KEY_ORDER.shift();
    const el = EVT_ROWS.get(drop);
    EVT_ROWS.delete(drop);
    if (el && el.parentNode === log) el.remove();
  }
  while (log.children.length > 120) log.lastChild.remove();
  applyLogFilterRow(li);
  return li;
}

function fmtTarget(t) {
  if (!t) return '—';
  if (t.kind === 'tile') return `(${t.ref.q},${t.ref.r})`;
  return peerShort(t.ref);
}

function onEnvelopeFold(env, viaMesh) {
  const li = evtRow(env);
  if (viaMesh) li.classList.add('from-mesh');
  if (env.type === 'evt_action_commit') {
    li.querySelector('.hs-badge.commit').classList.add('done');
  }
  if (env.type === 'evt_action_reveal') {
    const b = li.querySelector('.hs-badge.reveal');
    b.classList.add('done');
    b.title = `revealed: ${env.payload.action} → ${fmtTarget(env.payload.target)}`;
    li.querySelector('.hs-action').textContent = ` ${env.payload.action}→${fmtTarget(env.payload.target)}`;
  }
  if (env.type === 'evt_state_hash') {
    li.querySelector('.hs-badge.state').classList.add('done');
  }
  if (env.type === 'evt_radicle_push') {
    const b = li.querySelector('.hs-badge.push');
    b.classList.add('done');
    const sha = (env.payload.commit || '').slice(0, 10);
    const url = env.payload.explorer_url || (sha ? `/commit/${sha}` : null);
    const span = li.querySelector('.hs-push');
    span.textContent = '';
    if (url && sha) {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = ' ' + sha;
      span.appendChild(a);
    }
    b.title = sha ? `radicle push ${sha}` : 'radicle push';
  }
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

// Short, UI-only action names so narrow cards still read. Codes are canonical.
const ACTION_SHORT = { A: 'Attack', B: 'Block', M: 'Move', P: 'Posture' };

function renderDeck() {
  const slots = document.querySelectorAll('#slots .slot');
  slots.forEach(slot => {
    const key = slot.dataset.slot;
    const cardDiv = slot.querySelector('.card');
    if (key === 'EMPTY') {
      // The Empty slot always labels itself EP/EM — never inherit the hand's
      // code (that bled a `B` into the slot whenever Block was queued).
      // EM when a tile target is set (Rule 6 declared-first), else EP.
      const hasTileTarget = state.target && typeof state.target === 'object' && 'q' in state.target;
      const code = hasTileTarget ? 'EM' : 'EP';
      slot.dataset.code = code;
      cardDiv.dataset.code = code;
      cardDiv.innerHTML = `<div class="nm">Empty</div><div class="cd">${code === 'EM' ? 'move' : 'posture'}</div>`;
      slot.classList.toggle('queued', state.queued[0] === 'EMPTY');
      slot.classList.toggle('locked', state.locked && state.queued[0] === 'EMPTY');
      return;
    }
    const i = Number(key);
    const card = state.hand[i];
    if (card) {
      const code = card.code;
      slot.dataset.code = code;
      cardDiv.dataset.code = code;
      const short = ACTION_SHORT[code] || card.action_name || code;
      cardDiv.innerHTML = `<div class="nm">${short}</div><div class="cd">${card.card_id.slice(-5)}</div>`;
    } else {
      delete slot.dataset.code;
      delete cardDiv.dataset.code;
      cardDiv.innerHTML = `<div class="nm" style="opacity:.4">—</div>`;
    }
    slot.classList.toggle('queued', state.queued[0] === i);
    slot.classList.toggle('discard', !!card && state.willDiscard.has(card.card_id));
    slot.classList.toggle('locked', state.locked && state.queued[0] === i);
  });

  // Deck + discard pile counts, straight from the peer's latest hand broadcast.
  const dc = document.getElementById('deck-count');
  const xc = document.getElementById('discard-count');
  if (dc) {
    const n = state.deckCount ?? 0;
    dc.textContent = String(n);
    dc.parentElement.classList.toggle('empty', n === 0);
  }
  if (xc) {
    const n = state.discardCount ?? 0;
    xc.textContent = String(n);
    xc.parentElement.classList.toggle('empty', n === 0);
  }
}

function renderRoster() {
  const el = document.getElementById('roster');
  el.innerHTML = '';
  const activeFilter = state.ui.logFilterPeerId;
  for (const e of state.entities) {
    const row = document.createElement('div');
    row.className = `ros ${e.alliance === 'player' || e.alliance === 'npc_a' ? 'ally' : 'enemy'} ${e.life > 0 ? '' : 'dead'} ${activeFilter === e.peer_id ? 'filter-active' : ''}`;
    row.dataset.peerId = e.peer_id;
    const srcTag = (e.source_id || e.sourceId || '').split('_').slice(1, 3).join(' ');
    row.innerHTML = `<span class="nm">${e.name}</span>
      <span class="st">${srcTag} · hp ${e.life}/${e.life_max || e.lifeMax} · (${e.tile_q ?? e.tile?.q},${e.tile_r ?? e.tile?.r})</span>`;
    // Clicking a roster row toggles the log filter on that peer.
    row.addEventListener('click', () => setLogFilter(activeFilter === e.peer_id ? null : e.peer_id));
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
    // Keep destinationTile across rounds — a right-click sets up a multi-round
    // journey, so each new planning phase should pick up along the path rather
    // than forget it. The auto-stage below replaces the usual first-card pick.
    if (!resumeJourney()) {
      state.ui.destinationTile = null;
      state.ui.pathPlan = null;
      autoselectFirstHandCard();
    }
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
        if (typeof m.deck_count    === 'number') state.deckCount    = m.deck_count;
        if (typeof m.discard_count === 'number') state.discardCount = m.discard_count;
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
        hideEntering();
        // Hello arrives after our first setPhase() has already attempted to
        // auto-select from an empty hand. Re-run now that we have cards.
        if (state.phase === 'planning' || state.phase === 'connecting…' || state.phase === 'linked to peer') {
          autoselectFirstHandCard();
        }
      }
      if (m.kind === 'phase') setPhase(m.name, m.seconds || 0, !!m.heartbeat, m);
      if (m.kind === 'hand')  {
        state.hand = m.hand || state.hand;
        if (typeof m.deck_count    === 'number') state.deckCount    = m.deck_count;
        if (typeof m.discard_count === 'number') state.discardCount = m.discard_count;
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
        // Fold commit/reveal/state_hash/push into one row per (actor, turn, round).
        if (env.type === 'evt_action_commit' || env.type === 'evt_action_reveal' || env.type === 'evt_state_hash' || env.type === 'evt_radicle_push') {
          onEnvelopeFold(env, !!m.from_peer);
        } else {
          // Anything we don't fold still shows up as its own line (debug clarity).
          logUI(`${env.type} by ${peerShort(env.actor_peer_id)}${m.from_peer ? ' (mesh)' : ''}`, 'evt', { peerId: env.actor_peer_id });
        }
        if (env.type === 'evt_state_hash') {
          // Every peer independently emits an evt_state_hash for the turn, so
          // we'd log the same DMG line N× without a dedupe. Key by (turn,
          // target, amount, source).
          state._loggedDmg ||= new Set();
          const dmg = env.payload.damage_applied || [];
          for (const d of dmg) {
            const key = `${env.turn}:${d.target}:${d.amount}:${d.attacker || d.source || ''}`;
            if (state._loggedDmg.has(key)) continue;
            state._loggedDmg.add(key);
            logUI(`  DMG ${d.amount} → ${peerShort(d.target)}`, 'damage', { peerId: d.target });
            // Floating "-N❤️" over the map, lerping dealer→victim.
            const atk = d.attacker ? state.entities.find(e => e.peer_id === d.attacker) : null;
            const tgt = state.entities.find(e => e.peer_id === d.target);
            if (tgt && Number.isInteger(tgt.tile_q) && Number.isInteger(tgt.tile_r)) {
              state.ui.floatingDmgs.push({
                fromQ: atk?.tile_q ?? tgt.tile_q,
                fromR: atk?.tile_r ?? tgt.tile_r,
                toQ: tgt.tile_q,
                toR: tgt.tile_r,
                amount: d.amount,
                startAt: performance.now(),
                duration: 2200,
              });
            }
          }
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
        // My own push. Fold into the current (turn, round) row for me so the
        // handshake summary carries the push link too; emit a small secondary
        // line only if we don't have an active row for this turn/round yet.
        const url = m.explorerUrl || m.localUrl || m.url || (m.commit ? `/commit/${m.commit}` : null);
        if (state.myPeerId && typeof state.turn === 'number' && typeof state.round === 'number') {
          onEnvelopeFold({
            type: 'evt_radicle_push',
            actor_peer_id: state.myPeerId,
            turn: state.turn, round: state.round,
            payload: { commit: m.commit, explorer_url: url },
          }, false);
        }
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
  // Picking any slot by hand means the player is taking the wheel — stop the
  // auto-walker so a right-clicked destination doesn't fight the pick.
  cancelPathJourney('manual pick');
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
  const chipBtn = document.querySelector('#log-filter-chip button');
  if (chipBtn) chipBtn.addEventListener('click', () => setLogFilter(null));
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
  // Pick the entity closest to the click pixel if it's within one hex radius.
  // Using pixel distance (not tile-equality) is more forgiving than requiring a
  // bull's-eye on the tile center, and handles the case where the entity sprite
  // overlaps the tile edge.
  function entityAtPixel(px, py) {
    let best = null, bestD2 = HEX_SIZE_SQ_HIT;
    for (const p of state.entities) {
      if (!p || p.life <= 0) continue;
      if (!Number.isInteger(p.tile_q) || !Number.isInteger(p.tile_r)) continue;
      const pos = renderer.tilePx(p.tile_q, p.tile_r);
      const dx = px - pos.x;
      const dy = py - (pos.y - 6);  // renderer draws the body offset -6
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    return best;
  }

  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const t = pixelToHex(px, py, renderer.origin());
    if (!t) return;
    const occupant = entityAtPixel(px, py);
    // Once committed, clicks only narrow the event log — they must not drag
    // the target/marker around (otherwise a stray click overrides the just-
    // committed destination).
    if (state.locked) {
      setLogFilter(occupant ? occupant.peer_id : null);
      return;
    }
    state.ui.selectedTarget = t;
    // Clicking an entity narrows the event log to that peer's events;
    // clicking far from any entity clears the filter.
    setLogFilter(occupant ? occupant.peer_id : null);

    if (occupant && occupant.peer_id !== state.myPeerId) {
      // Clicked on an enemy — set as target, keep whatever action is queued
      // (so an Attack queued ahead of time can land on them). A direct enemy
      // pick clearly overrides any walking plan.
      cancelPathJourney('new target');
      state.target = occupant.peer_id;
      logUI(`target → ${occupant.name}`, 'phase', { peerId: occupant.peer_id });
    } else if (state.phase === 'planning' && !state.locked) {
      // Clicked on open ground — pre-select the Empty slot and target the
      // first step toward that tile. The Empty slot renders as EM (because a
      // tile target is set) or EP (if you clicked your own hex). Double-click
      // commits; a plain single-click just stages the pick.
      const me = state.entities.find(p => p.peer_id === state.myPeerId);
      if (me && Number.isInteger(me.tile_q)) {
        const atTile = me.tile_q === t.q && me.tile_r === t.r;
        const step = atTile ? { q: me.tile_q, r: me.tile_r } : stepToward({ q: me.tile_q, r: me.tile_r }, t);
        // Clicking ground means "go that way". Only an explicitly chosen Move
        // card survives (it moves too, just with the card); anything else —
        // auto-pick, Attack, Block, Posture — is unselected in favour of Empty.
        const q0 = state.queued[0];
        const queuedCode = typeof q0 === 'number' ? state.hand[q0]?.code : null;
        const keepMove = queuedCode === 'M' && !state.queuedIsAuto;
        if (!keepMove && q0 !== 'EMPTY') {
          state.queued = ['EMPTY'];
          state.queuedIsAuto = false;  // treat as a deliberate pick now
          send({ kind: 'queue', slots: state.queued });
        }
        // Left-click targets a specific hex for this round only — it doesn't
        // set up a multi-round journey (that's what right-click is for), so
        // cancel any in-progress walker before staging the new one-off pick.
        cancelPathJourney('new target');
        state.target = { q: step.q, r: step.r };
        state.ui.selectedTarget = step;
        const code = keepMove ? `Move → (${step.q},${step.r})` : atTile ? 'EP (stay)' : `EM → (${step.q},${step.r})`;
        logUI(`staged: ${code} — double-click to commit`, 'phase');
      } else {
        state.target = { q: t.q, r: t.r };
        logUI(`target → tile (${t.q},${t.r})`, 'phase');
      }
    } else {
      state.target = { q: t.q, r: t.r };
      logUI(`target → tile (${t.q},${t.r})`, 'phase');
    }
    send({ kind: 'target', target: state.target });
    renderDeck();
  });

  // Right-click any tile:
  //   • first click  — set the destination marker, stage EMPTY (unless a Move
  //                    was explicitly picked), target the first-step hex. The
  //                    deck UI changes immediately so you can see your pick.
  //   • second click within 500ms — commit (lock), just like a left-double-click.
  // Browsers don't fire `dblclick` for the right button, so we time it manually.
  // Right-click = the Attack counterpart of left-click:
  //   • on an enemy      → Attack him, hold position
  //   • on an empty hex  → Attack-step toward it (no damage; lets you back off
  //                        from a neighbour while still playing Attack)
  //   • on your own hex  → Attack with no target; the peer aims at the enemy
  //                        you last hit, else the nearest one
  //   • second right-click within 500ms → commit (lock)
  // Browsers don't fire `dblclick` for the right button, so we time it manually.
  let lastRightClickAt = 0;
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (state.phase !== 'planning' || state.locked) return;
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const t = pixelToHex(px, py, renderer.origin());
    if (!t) return;
    const me = state.entities.find(p => p.peer_id === state.myPeerId);
    if (!me || typeof me.tile_q !== 'number') return;

    const occupant = entityAtPixel(px, py);
    const isEnemy = occupant && occupant.peer_id !== state.myPeerId
      && (occupant.alliance === 'npc_b') !== (me.alliance === 'npc_b');
    const atTile = me.tile_q === t.q && me.tile_r === t.r;

    // Pick the action for this gesture. An *explicit* Move always wins — the
    // user already committed to Move, so right-click must stage/commit Move
    // toward the destination, not override it with Attack. Otherwise prefer
    // Attack when a card is in hand; else fall back to Empty.
    const q0 = state.queued[0];
    const queuedCode = typeof q0 === 'number' ? state.hand[q0]?.code : null;
    const moveExplicit = queuedCode === 'M' && !state.queuedIsAuto;
    const attackIdx = state.hand.findIndex(c => c && c.code === 'A' && !state.willDiscard.has(c.card_id));
    const useAttack = !moveExplicit && attackIdx >= 0;
    let label;
    if (useAttack) {
      if (state.queued[0] !== attackIdx) {
        state.queued = [attackIdx];
        state.queuedIsAuto = false;
        send({ kind: 'queue', slots: state.queued });
      }
      if (isEnemy) {
        state.target = occupant.peer_id;
        state.ui.selectedTarget = { q: occupant.tile_q, r: occupant.tile_r };
        state.ui.destinationTile = { q: occupant.tile_q, r: occupant.tile_r };
        label = `Attack → ${occupant.name}`;
      } else if (atTile) {
        state.target = null;
        state.ui.selectedTarget = t;
        state.ui.destinationTile = null;
        label = 'Attack → last/nearest enemy';
      } else {
        const step = stepToward({ q: me.tile_q, r: me.tile_r }, t);
        state.target = { q: step.q, r: step.r };
        state.ui.selectedTarget = step;
        state.ui.destinationTile = { q: t.q, r: t.r };
        label = `Attack-step → (${step.q},${step.r})`;
      }
    } else {
      // Path-based move. When Move is explicitly selected we KEEP that slot
      // queued (just route through it); otherwise stage Empty.
      if (!moveExplicit && state.queued[0] !== 'EMPTY') {
        state.queued = ['EMPTY'];
        state.queuedIsAuto = false;
        send({ kind: 'queue', slots: state.queued });
      }
      const codeTag = moveExplicit ? 'Move' : 'EM';
      if (atTile) {
        state.target = { q: me.tile_q, r: me.tile_r };
        state.ui.selectedTarget = { q: me.tile_q, r: me.tile_r };
        state.ui.destinationTile = null;
        state.ui.pathPlan = null;
        label = moveExplicit ? 'Move (stay)' : 'EP (stay)';
      } else {
        const blocked = blockedTilesExcluding(state.myPeerId);
        const path = findPath({ q: me.tile_q, r: me.tile_r }, t, blocked);
        if (path.length) {
          const step = path[0];
          state.ui.destinationTile = { q: t.q, r: t.r };
          state.ui.pathPlan = path;
          state.target = { q: step.q, r: step.r };
          state.ui.selectedTarget = step;
          label = path.length === 1
            ? `${codeTag} → (${step.q},${step.r})`
            : `${codeTag} → (${step.q},${step.r}) along ${path.length}-step route to (${t.q},${t.r})`;
        } else {
          // No reachable path (blocked). Fall back to the single-step heuristic
          // so the gesture still does something useful this round.
          const step = stepToward({ q: me.tile_q, r: me.tile_r }, t);
          state.target = { q: step.q, r: step.r };
          state.ui.selectedTarget = step;
          state.ui.destinationTile = { q: t.q, r: t.r };
          state.ui.pathPlan = null;
          label = `${codeTag} → (${step.q},${step.r}) (no clear route)`;
        }
      }
    }
    send({ kind: 'target', target: state.target });

    const now = Date.now();
    const isDouble = now - lastRightClickAt < 500;
    lastRightClickAt = isDouble ? 0 : now;  // reset so a third click starts fresh
    if (isDouble) {
      state.locked = true;
      send({ kind: 'lock' });
      logUI(`committed: ${label}`, 'phase', isEnemy ? { peerId: occupant.peer_id } : null);
    } else {
      logUI(`staged: ${label} — right-click again to commit`, 'phase', isEnemy ? { peerId: occupant.peer_id } : null);
    }
    renderDeck();
  });

  // Double-click anywhere = commit toward the destination (or toward the
  // double-clicked tile, if no destination set). Keeps Move if that's what
  // you've chosen; otherwise swaps to the Empty slot (EM when the step tile is
  // a different hex than you're on, EP otherwise).
  canvas.addEventListener('dblclick', (ev) => {
    if (state.phase !== 'planning' || state.locked) return;
    const rect = canvas.getBoundingClientRect();
    const t = pixelToHex(ev.clientX - rect.left, ev.clientY - rect.top, renderer.origin());
    if (!t) return;
    const me = state.entities.find(p => p.peer_id === state.myPeerId);
    if (!me || typeof me.tile_q !== 'number') return;
    // The double-clicked tile is the direction; the right-click marker is only
    // a preview and is replaced by the committed direction.
    const dest = t;
    state.ui.destinationTile = { q: t.q, r: t.r };
    // Walk one hex toward the destination. If we're already there, treat it
    // as EP (empty posture) at our own tile.
    const atDest = me.tile_q === dest.q && me.tile_r === dest.r;
    const step = atDest ? { q: me.tile_q, r: me.tile_r } : stepToward({ q: me.tile_q, r: me.tile_r }, dest);
    const q0 = state.queued[0];
    const queuedCode = typeof q0 === 'number' ? state.hand[q0]?.code : (q0 === 'EMPTY' ? 'EM' : null);
    // Only honour an explicit Move; if the UI's auto-pick happened to be Move,
    // treat the double-click as a request to swap to EMPTY (EP/EM).
    const moveQueued = queuedCode === 'M' && !state.queuedIsAuto;
    if (!moveQueued) {
      state.queued = ['EMPTY'];
      state.queuedIsAuto = false;
      send({ kind: 'queue', slots: state.queued });
    }
    state.target = { q: step.q, r: step.r };
    state.ui.selectedTarget = step;
    send({ kind: 'target', target: state.target });
    // Lock in so the auto-commit at round end just goes with this.
    state.locked = true;
    send({ kind: 'lock' });
    const label = moveQueued ? `Move → (${step.q},${step.r})` : (atDest ? `EP (stay)` : `EM → (${step.q},${step.r})`);
    logUI(`committed: ${label}`, 'phase');
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
