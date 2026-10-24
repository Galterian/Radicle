// Thin browser client — connects to peer:player-1 over WebSocket and renders
// the state the peer gossips. All simulation (libp2p mesh, Gun graph,
// hashgraph envelopes, resolver, radicle lottery) runs in the peer processes.

import { createRenderer } from './renderer.js';
import { hexDistance, stepToward, findPath } from './hex.js';
import { createKnownMap, initialBlock } from './map.js';
import { createSoundBank, resourcesFor, loadResources, assetUrl, onAssetsChanged } from './sprites.js';

// Unit voice lines / fx from the curated WBC3 collection. `M` toggles mute.
const sounds = createSoundBank();
try { sounds.set(localStorage.getItem('chaosd6.muted') === '1'); } catch { /* no storage */ }
let rendererRef = null;   // set in wireInput(); the ws handler needs it for attack triggers
const sourceIdOf = (p) => p?.source_id || p?.sourceId || p?.character_id || p?.creature_id || null;
const resOf = (p) => resourcesFor(sourceIdOf(p));

// Direct DOM poke rather than importing from launcher.js — launcher.js is the
// one that imports *us*, so pulling a symbol back creates a cycle that in a
// top-level-await module graph can leave the function binding unresolved and
// the overlay stuck up. One line of DOM manipulation is cheaper than that.
function hideEntering() {
  const ov = document.getElementById('entering-overlay');
  if (ov) ov.hidden = true;
}

// Click within this many world pixels of an entity's drawn centre counts as a
// hit on that entity. The body circle is r=16; 24 gives a little slack without
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
  ui: { hoverTile: null, selectedTarget: null, destinationTile: null, pathPlan: null, logFilterPeerId: null, floatingDmgs: [], floatingIcons: [], coldSyncUntil: 0, showCoords: false, hoverPeerId: null },
  // The dimension as this peer knows it: initial block + every revealed disc.
  // Replaced wholesale from the peer's `hello` / `map` messages; `mapVersion`
  // bumps so the renderer can rebuild its tile/frontier caches lazily.
  map: createKnownMap('0x0', [initialBlock()]),
  mapVersion: 0,
};

const knownHex = (q, r) => state.map.has(q, r);

function applyMap(m) {
  if (!m || !Array.isArray(m.blocks)) return;
  const reseeded = m.seed !== state.map.seed;
  if (reseeded) state.map = createKnownMap(m.seed, [initialBlock()]);
  const added = state.map.addBlocks(m.blocks);
  if (added || reseeded) {
    state.mapVersion++;
    const b = state.map.bounds();
    logUI(`map: ${state.map.size()} hexes known (q ${b.min_q}…${b.max_q}, r ${b.min_r}…${b.max_r})`, 'phase');
  }
}

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
  // If the clicked destination is occupied by another living entity, the
  // pathfinder's "closest free neighbour" fallback can only ever stop us one
  // hex short — `me.tile === dest.tile` never becomes true, so the journey
  // loops forever. If the occupant moves, resumeJourney recomputes and the
  // hero appears to walk *around* them, aimed at tiles the player never
  // clicked. Treat "adjacent to the blocked destination" as arrival and
  // hand control back to the next planning phase (Attack can engage from
  // the step we're standing on).
  const occupant = state.entities.find(p =>
    p.peer_id !== state.myPeerId && (p.life ?? 0) > 0
    && p.tile_q === dest.q && p.tile_r === dest.r);
  if (occupant && hexDistance({ tile_q: me.tile_q, tile_r: me.tile_r }, occupant) <= 1) {
    state.ui.pathPlan = null;
    state.ui.destinationTile = null;
    logUI(`journey ended — adjacent to ${occupant.name} at (${dest.q},${dest.r})`, 'phase');
    return false;
  }
  const blocked = blockedTilesExcluding(state.myPeerId);
  const path = findPath({ q: me.tile_q, r: me.tile_r }, dest, blocked, knownHex);
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
    const tier = e.tier && e.tier !== 'self' ? ` · ${e.tier === 'strong' ? 'in contact' : e.tier}` : '';
    const res = resOf(e);
    const thumb = res?.portrait?.path ? `<img class="thumb" src="${assetUrl(res.portrait.path)}" alt="">`
      : res?.sprites?.info?.path ? `<img class="thumb info" src="${assetUrl(res.sprites.info.path)}" alt="">` : '';
    row.innerHTML = `${thumb}<span class="txt"><span class="nm">${e.name}</span>
      <span class="st">${srcTag} · hp ${e.life}/${e.life_max || e.lifeMax} · (${e.tile_q ?? e.tile?.q},${e.tile_r ?? e.tile?.r})${tier}</span></span>`;
    // Clicking a roster row toggles the log filter on that peer.
    row.addEventListener('click', () => setLogFilter(activeFilter === e.peer_id ? null : e.peer_id));
    el.appendChild(row);
  }
}

// HUD hero card (own portrait) + hover card for whichever unit the cursor is
// over. Both read the entity's `resources` block; nothing is shown when the
// mapping has no art for it.
let heroCardKey = null;
function renderHeroCard() {
  const card = document.getElementById('hero-card');
  if (!card) return;
  const me = state.entities.find(p => p.peer_id === state.myPeerId);
  const res = me ? resOf(me) : null;
  const key = me ? `${me.peer_id}|${res ? 1 : 0}|${me.life}|${sounds.muted ? 1 : 0}` : null;
  if (key === heroCardKey) return;
  heroCardKey = key;
  if (!me || !res) { card.hidden = true; return; }
  card.hidden = false;
  const img = card.querySelector('img');
  const src = res.portrait?.path ? assetUrl(res.portrait.path) : res.sprites?.info?.path ? assetUrl(res.sprites.info.path) : '';
  if (img.getAttribute('src') !== src) img.src = src;
  img.classList.toggle('info', !res.portrait?.path);
  card.querySelector('.hero-name').textContent = me.name;
  card.querySelector('.hero-sub').textContent = `${res._entryName || ''} · as ${res.wbc3_name || '?'}${res.wbc3_race ? ` (${res.wbc3_race})` : ''}`;
  card.querySelector('.hero-hp').textContent = `hp ${me.life}/${me.life_max}`;
  card.querySelector('.hero-mute').textContent = sounds.muted ? '🔇 muted (M)' : '🔊 sound on (M)';
}
function renderHoverCard(clientX, clientY) {
  const card = document.getElementById('hover-card');
  if (!card) return;
  const pid = state.ui.hoverPeerId;
  const p = pid ? state.entities.find(e => e.peer_id === pid) : null;
  const res = p ? resOf(p) : null;
  if (!p) { card.hidden = true; return; }
  card.hidden = false;
  const img = card.querySelector('img');
  const src = res?.sprites?.info?.path ? assetUrl(res.sprites.info.path) : res?.portrait?.path ? assetUrl(res.portrait.path) : '';
  if (img.getAttribute('src') !== src) img.src = src;
  img.hidden = !src;
  card.querySelector('.hc-name').textContent = p.name;
  card.querySelector('.hc-sub').textContent = res ? `${res._entryName || ''} · ${res.wbc3_name || ''}` : (p.source_id || '');
  card.querySelector('.hc-hp').textContent = `hp ${p.life}/${p.life_max} · ${p.alliance}${p.life <= 0 ? ' · dead' : ''}`;
  if (Number.isFinite(clientX)) {
    const w = card.offsetWidth || 180, h = card.offsetHeight || 120;
    card.style.left = `${Math.min(window.innerWidth - w - 8, clientX + 16)}px`;
    card.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, clientY - h / 2))}px`;
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
        // Tell the renderer to snap any entity updates for the next 1.5 s
        // instead of sliding — this is a (re)connect, so initial positions
        // should land where they are, not animate from wherever the renderer
        // last had them.
        state.ui.coldSyncUntil = performance.now() + 1500;
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
        applyMap(m.map);
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
      if (m.kind === 'map') applyMap(m.map);
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
            // Voice: the attacker gloats when the hit is lethal. Victims'
            // life may already be updated by the `peers` broadcast, so treat
            // "≤0 now" or "this hit covers what was left" as a kill.
            if (atk && tgt && ((tgt.life ?? 1) <= 0 || (d.lethal === true) || (Number.isFinite(d.life_after) && d.life_after <= 0))) {
              sounds.play(resOf(atk), 'deathblow', { volume: 0.7 });
            }
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
          // Rule 8 journey outcomes. One line per actor per round; de-dup by
          // (turn, round, actor) since every peer's state_hash echoes them.
          state._loggedJourney ||= new Set();
          for (const j of env.payload.journey_results || []) {
            const jk = `${env.turn}:${env.round}:${j.actor}`;
            if (state._loggedJourney.has(jk)) continue;
            state._loggedJourney.add(jk);
            const who = peerShort(j.actor);
            if (j.outcome === 'complete') logUI(`  ${who} journey complete at (${j.q},${j.r}) [${j.action}]`, 'phase', { peerId: j.actor });
            else                           logUI(`  ${who} journey cancelled (blocked) → (${j.q},${j.r}) [${j.action}]`, 'phase', { peerId: j.actor });
            // If MY journey was blocked, tear down the local multi-round path
            // plan — otherwise next planning phase would auto-stage EM toward
            // the same contested tile and lose again.
            if (j.actor === state.myPeerId && j.outcome === 'blocked') cancelPathJourney('blocked by Rule 8');
          }
          if (state._loggedJourney.size > 500) state._loggedJourney = new Set([...state._loggedJourney].slice(-100));
          // Per-actor action icons. Only the player's own hero shows an action
          // icon — bots stay silent so the map isn't flooded. The ➙ "nobody
          // scored" arrow between adjacent enemies is handled below in the
          // `contact` branch, not here. De-dup by (turn, round) since there
          // is exactly one of my own icons per round and every peer's echoed
          // state_hash carries the same payload.
          state._loggedAction ||= new Set();
          state._animAction ||= new Set();
          for (const a of env.payload.actions || []) {
            // Sprite swing for every revealed Attack (all peers, de-duped per
            // turn/round/actor) — the attack sheet plays once then returns to
            // idle.
            const animKey = `${env.turn}:${env.round}:${a.actor}`;
            if (!state._animAction.has(animKey)) {
              state._animAction.add(animKey);
              if (a.action === 'A') rendererRef?.trigger(a.actor, 'attack');
              if (state._animAction.size > 500) state._animAction = new Set([...state._animAction].slice(-100));
            }
            if (a.actor !== state.myPeerId) continue;
            const ak = `${env.turn}:${env.round}:${a.actor}`;
            if (state._loggedAction.has(ak)) continue;
            state._loggedAction.add(ak);
            const fromQ = Number.isInteger(a.from_q) ? a.from_q : null;
            const fromR = Number.isInteger(a.from_r) ? a.from_r : null;
            if (fromQ === null) continue;
            const hasAim = Number.isInteger(a.target_q) && Number.isInteger(a.target_r);
            state.ui.floatingIcons.push({
              action: a.action,
              fromQ, fromR,
              toQ: hasAim ? a.target_q : fromQ,
              toR: hasAim ? a.target_r : fromR,
              upOnly: !hasAim,
              startAt: performance.now(),
              duration: 2200,
            });
          }
          if (state._loggedAction.size > 500) state._loggedAction = new Set([...state._loggedAction].slice(-100));
        }
      }
      if (m.kind === 'contact') {
        // "A×B" pairs for every adjacent cross-side revealer. Shows what
        // actually opposed what after both sides have revealed — the user
        // asked for this specifically so they can read the resolution.
        state._loggedStandoff ||= new Set();
        for (const c of m.contacts) {
          const veto = c.a.vetoed || c.b.vetoed
            ? `  (vetoed: ${c.a.vetoed ? c.a.name + ' ' + c.a.vetoed : ''}${c.a.vetoed && c.b.vetoed ? '; ' : ''}${c.b.vetoed ? c.b.name + ' ' + c.b.vetoed : ''})`
            : '';
          logUI(`contact d=${c.distance}: ${c.a.name}[${c.a.action}] × ${c.b.name}[${c.b.action}]${veto}`, 'phase');
          // No-damage clinch between adjacent enemies: float a ➙ from each
          // of them toward the other so the stalemate is visible on the map.
          // Every peer rebroadcasts the same contact set, so de-dup by
          // (turn, round, sorted-pair).
          if (c.damage_exchanged) continue;
          const [p1, p2] = [c.a.peer_id, c.b.peer_id].sort();
          const key = `${m.turn}:${m.round}:${p1}:${p2}`;
          if (state._loggedStandoff.has(key)) continue;
          state._loggedStandoff.add(key);
          const aT = Number.isInteger(c.a.tile_q) && Number.isInteger(c.a.tile_r);
          const bT = Number.isInteger(c.b.tile_q) && Number.isInteger(c.b.tile_r);
          if (!aT || !bT) continue;
          const now = performance.now();
          state.ui.floatingIcons.push({
            action: 'STANDOFF', fromQ: c.a.tile_q, fromR: c.a.tile_r,
            toQ: c.b.tile_q, toR: c.b.tile_r, upOnly: false,
            startAt: now, duration: 2200,
          });
          state.ui.floatingIcons.push({
            action: 'STANDOFF', fromQ: c.b.tile_q, fromR: c.b.tile_r,
            toQ: c.a.tile_q, toR: c.a.tile_r, upOnly: false,
            startAt: now, duration: 2200,
          });
        }
        if (state._loggedStandoff.size > 500) state._loggedStandoff = new Set([...state._loggedStandoff].slice(-100));
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

// Forward every meaningful user input to the peer process so it lands in the
// per-dimension log file alongside the server-side envelopes. This gives us a
// unified timeline when diagnosing "the hero moved on its own" or "my commit
// was ignored" — we can see whether a click actually arrived, what phase the
// client thought it was in, and whether locked/journey state matched.
function uilog(event, extra = {}) {
  send({
    kind: 'uilog',
    event,
    phase: state.phase,
    locked: state.locked,
    ...extra,
  });
}

function queueSlot(key) {
  uilog('queueSlot', { detail: `key=${key}` });
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
    uilog('keydown', { key: ev.key || ev.code });
    if (ev.key >= '1' && ev.key <= '5') queueSlot(Number(ev.key) - 1);
    else if (ev.key === '8') queueSlot('EMPTY');
    else if (ev.code === 'Space') { ev.preventDefault(); if (state.queued.length) { state.locked = true; send({ kind: 'lock' }); logUI('commit locked (early)', 'phase'); renderDeck(); } }
    else if (ev.key === 'c' || ev.key === 'C') renderer.recentre();
    else if (ev.key === 'm' || ev.key === 'M') {
      const muted = sounds.toggle();
      try { localStorage.setItem('chaosd6.muted', muted ? '1' : '0'); } catch { /* no storage */ }
      logUI(muted ? 'sound muted' : 'sound on', 'phase');
    }
    else if (ev.key === 'g' || ev.key === 'G') state.ui.showCoords = !state.ui.showCoords;
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
          sourceId: sourceIdOf(p),
          queuedCode: isMe ? effectiveQueuedCode() : null,
          locked: isMe ? state.locked : false,
        };
      });
    },
    ui: state.ui,
    get map() { return state.map; },
    get mapVersion() { return state.mapVersion; },
    get myPeerId() { return state.myPeerId; },
  });
  rendererRef = renderer;
  // "Ready" line once, when our own hero first shows up with art.
  let readyPlayed = false;
  onAssetsChanged(() => { heroCardKey = null; });
  canvas.addEventListener('mousemove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    state.ui.hoverTile = renderer.pickHex(px, py, knownHex);
    const over = entityAtPixel(px, py, true);
    state.ui.hoverPeerId = over ? over.peer_id : null;
    canvas.classList.toggle('over-unit', !!over);
    renderHoverCard(ev.clientX, ev.clientY);
  });
  canvas.addEventListener('mouseleave', () => { state.ui.hoverPeerId = null; renderHoverCard(); });
  // Pick the entity closest to the click if it's within one hex radius. The
  // comparison runs in world pixels (camera-independent). Using pixel distance
  // (not tile-equality) is more forgiving than requiring a bull's-eye on the
  // tile center, and handles the case where the entity sprite overlaps the edge.
  function entityAtPixel(px, py, includeDead = false) {
    const w = renderer.toWorld(px, py);
    let best = null, bestD2 = HEX_SIZE_SQ_HIT;
    for (const p of state.entities) {
      if (!p || (!includeDead && p.life <= 0)) continue;
      if (!Number.isInteger(p.tile_q) || !Number.isInteger(p.tile_r)) continue;
      const pos = renderer.tilePx(p.tile_q, p.tile_r);
      const dx = w.x - pos.x;
      // The sprite stands ~74 px tall above the tile centre; measure the
      // distance to the nearest point of that body column so a click on the
      // head counts as well as one on the feet.
      const dyBody = w.y < pos.y - 68 ? w.y - (pos.y - 68) : w.y > pos.y + 6 ? w.y - (pos.y + 6) : 0;
      const d2 = dx * dx + dyBody * dyBody;
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    return best;
  }

  canvas.addEventListener('click', (ev) => {
    if (renderer.wasDrag()) return;   // the button-up that ended a map pan is not a click
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const t = renderer.pickHex(px, py, knownHex);
    uilog('click', { tile: t, detail: `button=${ev.button}` });
    if (!t) return;
    const occupant = entityAtPixel(px, py);
    // Left-click never stages a movement or journey — that's exclusively a
    // right-click gesture now. All left-click does is:
    //   - narrow the event log to the clicked entity (or clear the filter)
    //   - set the target to a clicked enemy so an Attack already queued (via
    //     1-5 keys) lands on them. Enemies are a target binding, not a move.
    // Clicks on empty ground only move the visual cursor cross-hair.
    if (state.locked) {
      setLogFilter(occupant ? occupant.peer_id : null);
      return;
    }
    state.ui.selectedTarget = t;
    setLogFilter(occupant ? occupant.peer_id : null);
    if (occupant && occupant.peer_id === state.myPeerId) sounds.play(resOf(occupant), 'select');
    if (occupant && occupant.peer_id !== state.myPeerId) {
      state.target = occupant.peer_id;
      logUI(`target → ${occupant.name} (Attack binding — use right-click to move)`, 'phase', { peerId: occupant.peer_id });
      send({ kind: 'target', target: state.target });
    }
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
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const t = renderer.pickHex(px, py, knownHex);
    uilog('rightclick', { tile: t });
    if (!t) return;
    const me = state.entities.find(p => p.peer_id === state.myPeerId);
    if (!me || typeof me.tile_q !== 'number') return;

    // If we're past the planning window (reveal / resolution) or already
    // committed this round, we can't change *this* round's action — but we
    // CAN still override the pending journey so the next round picks up
    // toward the new destination instead of the old one. This is what kills
    // "dangling" moves: a journey retargeted mid-handshake takes effect at
    // the very next planning phase.
    // Clicked a tile currently occupied by another living entity that we're
    // already adjacent to? Then there is no multi-round journey to start —
    // we're already in range. Setting pathPlan here would route the hero to
    // some *other* free neighbour of the clicked tile, which looks exactly
    // like "the hero circles around the target toward a tile I never
    // clicked". Suppress pathPlan in that case so the right-click is just a
    // target binding.
    const occAtT = state.entities.find(p =>
      p.peer_id !== state.myPeerId && (p.life ?? 0) > 0
      && p.tile_q === t.q && p.tile_r === t.r);
    const alreadyAdjacentToOccupant = !!occAtT
      && hexDistance({ tile_q: me.tile_q, tile_r: me.tile_r }, occAtT) <= 1;

    if (state.phase !== 'planning' || state.locked) {
      if (me.tile_q === t.q && me.tile_r === t.r) {
        // Right-click on self = cancel the pending journey outright.
        state.ui.destinationTile = null;
        state.ui.pathPlan = null;
        state.ui.selectedTarget = null;
        logUI('journey override — next round will not auto-walk', 'phase');
      } else if (occAtT) {
        // Clicked tile is held by a living entity. A* can only route us to
        // a *free neighbour* of that tile and resumeJourney would then pace
        // the hero round after round. Just bind the target for the UI —
        // next round's autoselect / keyboard pick decides what action to
        // actually take against them.
        state.ui.destinationTile = { q: t.q, r: t.r };
        state.ui.pathPlan = null;
        state.ui.selectedTarget = { q: t.q, r: t.r };
        logUI(`journey override — target ${occAtT.name} bound, no walk queued`, 'phase');
      } else {
        const blocked = blockedTilesExcluding(state.myPeerId);
        const path = findPath({ q: me.tile_q, r: me.tile_r }, t, blocked, knownHex);
        state.ui.destinationTile = { q: t.q, r: t.r };
        state.ui.pathPlan = path.length ? path : null;
        state.ui.selectedTarget = path.length ? path[0] : { q: t.q, r: t.r };
        logUI(`journey override → (${t.q},${t.r}) — takes effect next round`, 'phase');
      }
      renderDeck();
      return;
    }

    const occupant = entityAtPixel(px, py);
    const isEnemy = occupant && occupant.peer_id !== state.myPeerId
      && (occupant.alliance === 'npc_b') !== (me.alliance === 'npc_b');
    const atTile = me.tile_q === t.q && me.tile_r === t.r;

    // Pick the action for this gesture. User rule: a right-click on an enemy
    // only triggers an action against them when A or M is actually in the
    // queue; otherwise the gesture is just a target binding. This stops the
    // handler from (a) auto-swapping the queue to EM/EP every time, and (b)
    // starting a path-based journey the pathfinder can only route *around*
    // (the enemy's tile is blocked, so A* falls back to a free neighbour and
    // the hero paces).
    const q0 = state.queued[0];
    const queuedCode = typeof q0 === 'number' ? state.hand[q0]?.code : null;
    const moveExplicit = queuedCode === 'M' && !state.queuedIsAuto;
    const attackIdx = state.hand.findIndex(c => c && c.code === 'A' && !state.willDiscard.has(c.card_id));
    // Only auto-stage Attack when A is already queued OR the click is on an
    // empty hex (user is gesturing somewhere to walk/attack-step). Clicking
    // an enemy with a non-A, non-M queue respects the queued action.
    const useAttack = !moveExplicit && attackIdx >= 0 && (queuedCode === 'A' || !isEnemy);
    let label;
    // Enemy right-clicked AND the queue is something that isn't A or M:
    // bind the target for the next-round attack-pick but keep the current
    // action and don't start a journey.
    if (isEnemy && !useAttack && !moveExplicit) {
      state.target = occupant.peer_id;
      state.ui.selectedTarget = { q: occupant.tile_q, r: occupant.tile_r };
      state.ui.destinationTile = { q: occupant.tile_q, r: occupant.tile_r };
      state.ui.pathPlan = null;
      label = `target → ${occupant.name} (keeping ${queuedCode || 'EP'})`;
      send({ kind: 'target', target: state.target });
      sounds.play(resOf(me), 'order');
      const now = Date.now();
      const isDouble = now - lastRightClickAt < 500;
      lastRightClickAt = isDouble ? 0 : now;
      if (isDouble) {
        state.locked = true;
        send({ kind: 'lock' });
        logUI(`committed: ${label}`, 'phase', { peerId: occupant.peer_id });
      } else {
        logUI(`staged: ${label} — right-click again to commit`, 'phase', { peerId: occupant.peer_id });
      }
      renderDeck();
      return;
    }
    if (useAttack) {
      if (state.queued[0] !== attackIdx) {
        state.queued = [attackIdx];
        state.queuedIsAuto = false;
        send({ kind: 'queue', slots: state.queued });
      }
      // Attack is single-round; any lingering pathPlan from an earlier
      // right-click would otherwise re-trigger resumeJourney next phase.
      state.ui.pathPlan = null;
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
        const step = stepToward({ q: me.tile_q, r: me.tile_r }, t, knownHex);
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
      } else if (alreadyAdjacentToOccupant) {
        // Same guard as the locked-override branch: don't start a multi-
        // round journey when the clicked target is a living entity we're
        // already touching. Stage a single-step aim at the clicked tile so
        // the committed EM/Move resolves as "step toward them" (which the
        // resolver treats as a blocked no-op) instead of pacing around.
        state.target = { q: t.q, r: t.r };
        state.ui.selectedTarget = { q: t.q, r: t.r };
        state.ui.destinationTile = { q: t.q, r: t.r };
        state.ui.pathPlan = null;
        label = `${codeTag} → (${t.q},${t.r}) (already in contact)`;
      } else {
        const blocked = blockedTilesExcluding(state.myPeerId);
        const path = findPath({ q: me.tile_q, r: me.tile_r }, t, blocked, knownHex);
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
          const step = stepToward({ q: me.tile_q, r: me.tile_r }, t, knownHex);
          state.target = { q: step.q, r: step.r };
          state.ui.selectedTarget = step;
          state.ui.destinationTile = { q: t.q, r: t.r };
          state.ui.pathPlan = null;
          label = `${codeTag} → (${step.q},${step.r}) (no clear route)`;
        }
      }
    }
    send({ kind: 'target', target: state.target });
    sounds.play(resOf(me), 'order');

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

  // Left-double-click = commit shortcut. It no longer stages a new move;
  // that's a right-click gesture only. If something is already queued (a
  // card, EMPTY with a right-click destination, etc.) a double-click just
  // locks it in. On an empty queue it's a no-op.
  canvas.addEventListener('dblclick', (ev) => {
    uilog('dblclick');
    if (state.phase !== 'planning' || state.locked) return;
    if (!state.queued.length) return;
    state.locked = true;
    send({ kind: 'lock' });
    logUI(`commit locked (double-click)`, 'phase');
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
    renderHeroCard();
    if (!readyPlayed && state.myPeerId) {
      const me = state.entities.find(p => p.peer_id === state.myPeerId);
      const res = me ? resOf(me) : null;
      if (res) { readyPlayed = true; sounds.play(res, 'ready', { volume: 0.7 }); }
    }
    renderer.render();
    requestAnimationFrame(raf);
  }
  raf();
}

wireInput();
