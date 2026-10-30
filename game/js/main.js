// Thin browser client — connects to peer:player-1 over WebSocket and renders
// the state the peer gossips. All simulation (libp2p mesh, Gun graph,
// hashgraph envelopes, resolver, radicle lottery) runs in the peer processes.

import { createRenderer } from './renderer.js';
import { hexDistance, stepToward, findPath } from './hex.js';
import { createKnownMap, initialBlock, featureAt } from './map.js';

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
  archive: [],        // my archive (side deck) as the peer reports it
  willArchive: new Set(),  // card_ids marked to go to the archive at this resolution
  archiveMode: false, // the archive pile was clicked: the next hand card picked is marked for it
  deckMin: 15,        // the circulating deck never drops below this
  circulating: 0,     // draw pile + discard + hand
  queued: [],         // [] | [slotIndex] | ['EMPTY']
  queuedSkills: [],   // hand indices of skill cards riding on the queued action
  queuedExtra: null,  // Battle Trance: hand index of the second action card (null → Empty Posture)
  queuedEffect: null, // hand index of the effect card cast on this action (Posture / Empty; instants on any action)
  queuedEffect2: null, // a second copy of that effect, cast together with it (Rule 23 ∀ double cast)
  queuedChain: [],    // further effects chained onto it (Rule 22: first element = previous last; shared one emitted once)
  withAura: false,    // cast the plan through my Aura ∀ — everyone within 10 hexes, Aura consumed
  bonusMode: false,   // picking bonus rounds (Haste: one; Balefire: nine) before the normal action
  queuedAttach: null, // hand index of the effect card riding on the queued cast (Traps Mastery / Space Bending trap, Blessing)
  queuedLink: null,   // { peer_id, stat } — Spirit Link: the ally stat clicked in the roster
  queuedElem: null,   // element id — the token element clicked for Artifice
  queuedPhylactery: null, // { peer_id, perm } — the enemy permanent the Phylactery shatters this action
  channels: [],       // the peer's channels (Harm…, and what Blessing holds)
  sensedTraps: [],    // Super Sense: traps on the tiles around me
  blessMode: false,   // Blessing clicked: the next effect card replaces what it holds
  phylacteryMode: false, // Possess clicked: the next enemy perm pill is the one to shatter
  bonusPlans: [],     // plans committed so far this action, as sent: { slots, skills, effect, target }
  bonus: { max: 0, balefire: 0, plans: [] },   // the peer's echo: allowance and plans with card_ids
  queuedIsAuto: true, // false once the player has deliberately picked a slot this planning phase
  casting: null,      // { effect_id, name, step, of } — a multi-Posture cast in progress (Rule 19)
  destroy: null,      // { stat } — Rule 24: emitting that stat against an enemy token this action
  lostActions: 0,     // actions I must sit out (Lightning, Oblivion, …)
  willDiscard: new Set(),  // card_ids flagged to drop at turn end — survives the hand shrinking within a turn
  target: null,       // peer_id | {q,r} | null
  locked: false,
  // destinationTile is the hex the player right-clicked; pathPlan is the full
  // list of hexes (step 1 … destination) the auto-walker will follow across
  // rounds. Both survive planning→reveal→resolution so the next round can
  // pick up where this one left off.
  ui: { hoverTile: null, selectedTarget: null, destinationTile: null, pathPlan: null, logFilterPeerId: null, floatingDmgs: [], floatingIcons: [], coldSyncUntil: 0 },
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
  sendQueue();
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
    const act = `${actionLabel(env.payload)}${skillNames(env.payload)}`;
    b.title = `revealed: ${act} → ${fmtTarget(env.payload.target)}`;
    li.querySelector('.hs-action').textContent = ` ${act}→${fmtTarget(env.payload.target)}`;
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
  if (tranceActive()) return 'BT';
  if (q === 'EMPTY') {
    const hasTileTarget = state.target && typeof state.target === 'object' && 'q' in state.target;
    return hasTileTarget ? 'EM' : 'EP';
  }
  if (typeof q === 'number' && state.hand[q]) return state.hand[q].code;
  return null;
}

// Short, UI-only action names so narrow cards still read. Codes are canonical.
const ACTION_SHORT = { A: 'Attack', B: 'Block', M: 'Move', P: 'Posture' };

const isSkill = (c) => !!c && c.kind === 'skill';
const isEffect = (c) => !!c && c.kind === 'effect';
const isAction = (c) => !!c && c.kind !== 'skill' && c.kind !== 'effect';
// Rule 19: an effect is cast on a Posture (or Empty Posture); instants ride on
// any action. Never on a Battle Trance in this pass. A Reaver also emits on
// the Attack (and on an Empty Move, which fights as an Attack for them).
const EVERY_INSTANT = new Set(['effect_the_void', 'effect_light_darkness', 'effect_teleportation', 'effect_emotions_bombard']);
const castInstant = (card, every) => every ? EVERY_INSTANT.has(card.effect_id) : !!card.is_instant;
// Stat buy (Summoning, Golems, Elementals, Resurrect): emissions bank my stat for the
// card's elements in turn until the bank covers the need.
const ELEM_STAT = { elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' };
const myStatFor = (el) => { const me = state.entities.find(p => p.peer_id === state.myPeerId); const k = ELEM_STAT[el] || 'world'; return Math.max(1, Number(me?.[`stat_${k}`] ?? me?.stats?.[k]) || 10); };
const summonLength = (card) => { const need = card.summon?.need ?? 30; if (need <= 0 || !card.element_cost.length) return 1; let bank = 0, n = 0; while (bank < need && n < 40) { bank += myStatFor(card.element_cost[n % card.element_cost.length]); n++; } return Math.max(1, n); };
const castLength = (card, every) => castInstant(card, every) ? 1 : (card.summon ? summonLength(card) : Math.max(1, card.element_cost.length)) + (every ? 1 : 0);
const summonLabel = (sm) => !sm ? '' : sm.pending ? ' · ✝ nothing to raise — stand by a fallen unit or an ally' : sm.ward ? ` · ✝ ward ${sm.name}` : sm.revive ? ` · ✝ raise ${sm.name} Σ${sm.need}` : ` · 🐾 ${sm.bind ? 'bind ' : ''}${sm.name} Σ${sm.need}`;
const effectDoubled = () => state.queuedEffect !== null && state.queuedEffect2 !== null;
// Rule 22: effect B chains onto A when B's first element is A's last one.
const chainsOnto = (prev, next) => !!prev && !!next && prev.effect_id !== next.effect_id && next.element_cost[0] === prev.element_cost[prev.element_cost.length - 1];
const chainTail = () => { const i = state.queuedChain.length ? state.queuedChain[state.queuedChain.length - 1] : state.queuedEffect; return i === null ? null : state.hand[i]; };
// A card chains when its first element is the one going out at the tail's last emission —
// of the queued plan, or of the cast in progress (join_elem from the peer).
const chainable = (card) => {
  if (!isEffect(card)) return false;
  if (state.casting?.card_ids && !state.queuedChain.length) {
    if (state.casting.card_ids.includes(card.card_id)) return false;
    return !!state.casting.join_elem && card.element_cost[0] === state.casting.join_elem;
  }
  return state.queuedEffect !== null && chainsOnto(chainTail(), card);
};
// The whole plan is one long cast unless it is a single, un-doubled instant.
const planIsLong = () => effectDoubled() || state.queuedChain.length > 0;
function effectMatchesQueue(card, every = false, long = false) {
  if (!isEffect(card) || tranceActive()) return false;
  if (!long && castInstant(card, every)) return state.queued.length > 0;
  const code = effectiveQueuedCode();
  return code === 'P' || code === 'EP' || (isReaver() && code === 'A') || (isMonk() && (code === 'M' || code === 'EM'));
}
const isReaver = () => myPermanents().includes('class_reaver');
const isMonk = () => myPermanents().includes('class_monk');
// Rule 20 pc override: once a non-instant effect is picked, only the actions
// that can carry it (Posture, Empty; Attack for a Reaver) stay selectable.
function castLocksOut(card) {
  if (!isAction(card)) return false;
  if (state.lostActions > 0) return true;
  const eff = state.queuedEffect !== null ? state.hand[state.queuedEffect] : null;
  if (!(eff && (planIsLong() || !castInstant(eff, false))) && !state.casting) return false;
  return !(card.code === 'P' || (isReaver() && card.code === 'A') || (isMonk() && card.code === 'M'));
}
// Always castable: the Empty slot is a Posture, and instants ride on anything.
const effectUsable = (card) => isEffect(card);
// Rule 20/22: once an effect is picked (or a cast is running) the other effect
// cards stay live only if they can join it — a twin (∀) or a chain link.
function effectLockedOut(card, i) {
  if (state.queuedChain.includes(i)) return false;
  if (state.casting?.card_ids) return !state.casting.card_ids.includes(card.card_id) && !chainable(card);
  if (state.queuedEffect === null) return false;
  if (state.queuedEffect === i || state.queuedEffect2 === i) return false;
  const first = state.hand[state.queuedEffect];
  const twinOK = first && card.effect_id === first.effect_id && state.queuedEffect2 === null && state.queuedChain.length === 0;
  // One element per emission: an instant rides a Posture that is already casting only by joining it.
  return !twinOK && !chainable(card);
}
const ELEM_GLYPH = {
  elem_vitality: '♥', elem_souls: '☽', elem_time: '⌛', elem_space: '✧',
  elem_air: '≋', elem_water: '~', elem_earth: '▲', elem_fire: '🔥',
  elem_concentration: '◎', elem_harmony: '♪',
};
const elemGlyphs = (els) => (els || []).map(e => ELEM_GLYPH[e] || '?').join('');

const isTrance = (c) => isSkill(c) && (c.is_trance || c.requires === '*');

// '*' (Battle Trance) matches any action card.
function firstActionIdx(code) {
  return state.hand.findIndex(c => isAction(c) && (code === '*' || c.code === code) && !state.willDiscard.has(c.card_id));
}
function tranceActive() {
  return state.queuedSkills.some(i => isTrance(state.hand[i]));
}
function queuedActionCode() {
  const q = state.queued[0];
  return typeof q === 'number' && isAction(state.hand[q]) ? state.hand[q].code : null;
}
function extraActionCode() {
  const e = state.queuedExtra;
  return typeof e === 'number' && isAction(state.hand[e]) ? state.hand[e].code : null;
}
// Move and Posture skills may also ride on the Empty slot (Empty Move / Empty Posture).
const ridesOnEmpty = (card) => card.requires === 'M' || card.requires === 'P';
// A non-trance skill rides on the primary, or on the trance's second action.
function skillMatchesQueue(card) {
  if (state.queued[0] === 'EMPTY' && ridesOnEmpty(card)) return true;
  if (card.requires === queuedActionCode()) return true;
  if (!tranceActive()) return false;
  // Trance's second option: the extra card, or the implicit EP (Move / Posture skills ride on it).
  return state.queuedExtra === null ? ridesOnEmpty(card) : card.requires === extraActionCode();
}
function skillUsable(card) {
  return isSkill(card) && (ridesOnEmpty(card) || firstActionIdx(card.requires) >= 0);
}
// Drop attached skills that no longer ride on a queued action.
function pruneQueuedSkills() {
  const trance = tranceActive();
  if (!trance || typeof state.queued[0] !== 'number' || !isAction(state.hand[state.queued[0]])) state.queuedExtra = null;
  if (typeof state.queuedExtra === 'number' && (!isAction(state.hand[state.queuedExtra]) || state.queuedExtra === state.queued[0])) state.queuedExtra = null;
  state.queuedSkills = state.queuedSkills.filter(i => isSkill(state.hand[i]) && (isTrance(state.hand[i]) ? trance && queuedActionCode() : skillMatchesQueue(state.hand[i])));
  if (state.queuedEffect2 !== null && (state.queuedEffect === null || !effectMatchesQueue(state.hand[state.queuedEffect], true))) state.queuedEffect2 = null;
  if (state.queuedChain.length && (state.queuedEffect === null || !effectMatchesQueue(state.hand[state.queuedEffect], false, true))) state.queuedChain = [];
  if (state.queuedEffect !== null && !effectMatchesQueue(state.hand[state.queuedEffect])) { state.queuedEffect = null; state.queuedEffect2 = null; state.queuedChain = []; }
  if (state.queuedEffect === null) state.withAura = false;
}
function sendQueue() {
  pruneQueuedSkills();
  send({ kind: 'queue', slots: state.queued, skills: state.queuedSkills, extra: state.queuedExtra, effect: state.queuedEffect, effect2: state.queuedEffect2, chain: state.queuedChain, aura: state.withAura });
}
function skillNames(payload) {
  const names = Array.isArray(payload.skill_names) && payload.skill_names.length
    ? payload.skill_names
    : (payload.skills || []).map(id => String(id).replace(/^skill_/, ''));
  return names.length ? '+' + names.join('+') : '';
}
function actionLabel(payload) {
  if (payload.action === 'BT' && Array.isArray(payload.trance)) return `BT[${payload.trance.join('|')}]`;
  return payload.action;
}

// Two-letter tags for the over-unit chip: `[EM + A + ✦BT + ✦Po]` reads as
// "Battle Trance over Empty Move and Attack, Powerful attack on the Attack".
// ✦ is the same mark the hand uses for skill cards. Unknown skills fall back
// to the first two letters of their id.
const SKILL_TAG = {
  skill_battle_trance: 'BT', skill_powerful_attack: 'Po', skill_overrun: 'Ov', skill_bluff: 'Bl',
  skill_intimidation: 'In', skill_grapple: 'Gr', skill_disruption_move: 'Di', skill_dodge: 'Do',
  skill_barricade: 'Ba', skill_taunt: 'Ta', skill_sanctuary: 'Sa', skill_ranged_weapon: 'Ra',
  skill_force_shield: 'Fs', skill_counter_spell: 'Cs',
};
const skillTag = id => SKILL_TAG[id] || String(id).replace(/^skill_/, '').slice(0, 2).replace(/^./, c => c.toUpperCase());
// Compose the chip text from an action summary / queue: trance options first
// (an option the resolver did not play is parenthesised), then ✦BT, then the
// other skills in hand order.
function composeLabel({ action, declared, trance, played, skills, effects }) {
  const parts = [];
  if (Array.isArray(trance) && trance.length) trance.forEach((c, i) => parts.push(!Array.isArray(played) || played.includes(i) ? c : `(${c})`));
  // A class stance (Reaver / Barbarian / Monk) judges an Empty Posture as
  // A / B / M — show both so the reader knows the EP was the play.
  else if (action && declared && declared !== action) parts.push(`${declared}⚜${action}`);
  else if (action) parts.push(action);
  const ids = (skills || []).map(String);
  const rest = ids.filter(id => id !== 'skill_battle_trance');
  if (Array.isArray(trance) && trance.length) parts.push('✦BT');
  for (const id of rest) parts.push(`✦${skillTag(id)}`);
  for (const e of effects || []) parts.push(`✺${elemGlyphs(e.elements || e.element_cost)}`);
  return parts.join(' + ');
}
// The chip over my own head while planning: what the commit will carry.
function queuedLabel() {
  const code = effectiveQueuedCode();
  if (code === null) return null;
  const skills = state.queuedSkills.map(i => state.hand[i]).filter(isSkill).map(c => c.skill_id);
  const trance = tranceActive() ? [queuedActionCode() || 'EP', extraActionCode() || 'EP'] : null;
  const effects = state.queuedEffect !== null && isEffect(state.hand[state.queuedEffect]) ? [state.hand[state.queuedEffect]] : [];
  return composeLabel({ action: code, trance, played: null, skills, effects });
}

function renderDeck() {
  document.getElementById('slots')?.classList.toggle('haste-mode', state.bonusMode);
  document.getElementById('slots')?.classList.toggle('archive-mode', state.archiveMode);
  const slots = document.querySelectorAll('#slots .slot');
  const trance = tranceActive();
  slots.forEach(slot => {
    const key = slot.dataset.slot;
    const cardDiv = slot.querySelector('.card');
    if (key === 'EMPTY') {
      // The Empty slot always labels itself EP/EM — never inherit the hand's
      // code (that bled a `B` into the slot whenever Block was queued).
      // EM when a tile target is set (Rule 6 declared-first), else EP.
      const hasTileTarget = state.target && typeof state.target === 'object' && 'q' in state.target;
      const code = hasTileTarget ? 'EM' : 'EP';
      const emptyIsSecond = trance && state.queuedExtra === null;
      slot.dataset.code = code;
      cardDiv.dataset.code = code;
      const n = state.queued[0] === 'EMPTY' ? state.queuedSkills.length : 0;
      const sanct = code === 'EP' && !emptyIsSecond && inSanctuary();
      cardDiv.innerHTML = `<div class="nm">Empty</div><div class="cd">${emptyIsSecond ? '2nd · EP' : code === 'EM' ? 'move' : sanct ? '⛩ sanctuary' : 'posture'}${n ? ` +${n}✦` : ''}</div>`;
      slot.title = sanct ? 'Sanctuary: you take no damage while you rest in Empty Posture; any other action or skill ends it' : '';
      slot.classList.toggle('queued', state.queued[0] === 'EMPTY');
      slot.classList.toggle('queued-extra', emptyIsSecond);
      slot.classList.toggle('locked', state.locked && (state.queued[0] === 'EMPTY' || emptyIsSecond));
      return;
    }
    const i = Number(key);
    const card = state.hand[i];
    const skill = isSkill(card);
    const effect = isEffect(card);
    const skillQueued = skill && state.queuedSkills.includes(i);
    const effectQueued = effect && (state.queuedEffect === i || state.queuedEffect2 === i || state.queuedChain.includes(i));
    // Hand slots beyond the dealt five only show up when a card sits there (Haste ∀, Balefire's five).
    if (i >= 5) slot.hidden = !card;
    const isExtra = trance && state.queuedExtra === i;
    if (effect) {
      slot.dataset.code = 'P';
      cardDiv.dataset.code = 'P';
      const kindTag = card.is_permanent ? 'perm' : card.is_damage ? 'dmg' : card.is_point_buy ? 'buy' : 'effect';
      const inCast = !!state.casting?.card_ids?.includes(card.card_id);
      const prog = inCast ? ` · ${state.casting.step}/${state.casting.of} cast` : '';
      const dbl = effectQueued && effectDoubled() && (state.queuedEffect === i || state.queuedEffect2 === i);
      const link = state.queuedChain.indexOf(i);
      const len = castLength(card, dbl);
      const twin = !effectQueued && state.hand.some((c, j) => j !== i && isEffect(c) && c.effect_id === card.effect_id);
      const canChain = !effectQueued && chainable(card);
      const attached = state.queuedAttach === i;
      const tag = attached ? '📎 rides along' : link >= 0 ? `⛓ ${link + 2}nd` : dbl ? 'double' : kindTag;
      const sm = summonLabel(card.summon);
      // The 2026-10-29 picks that ride on the queued cast, shown on the card that takes them.
      const picks = effectQueued && state.queuedEffect === i ? [
        card.takes_attach ? (state.queuedAttach !== null ? ` · 📎 ${state.hand[state.queuedAttach]?.name || ''}` : ' · 📎 click an effect') : '',
        card.takes_link ? (state.queuedLink ? ` · 🔗 ${state.entities.find(p => p.peer_id === state.queuedLink.peer_id)?.name || ''} ${state.queuedLink.stat}` : ' · 🔗 click an ally stat') : '',
        card.takes_elem ? (state.queuedElem ? ` · ${elemGlyphs([state.queuedElem])} token` : ' · ◇ random element') : '',
        card.tile_target ? (state.target && typeof state.target === 'object' ? ` · ⌖ (${state.target.q},${state.target.r})` : ' · ⌖ click a tile') : '',
      ].join('') : '';
      cardDiv.innerHTML = `<div class="nm">${dbl ? '∀ ' : ''}${state.withAura && effectQueued ? '◎ ' : ''}${attached ? '📎 ' : ''}✺ ${card.name}</div><div class="cd">${elemGlyphs(card.element_cost)} · ${castInstant(card, dbl) ? 'instant' : len > 1 ? `${len} postures` : 'posture'} · ${tag}${prog}${sm}${picks}</div>`;
      const hints = [
        card.tile_target ? 'Left-click a tile for its target (general_ux_range_cast_target).' : '',
        card.takes_attach ? 'Click a second effect card in hand — it rides on this cast.' : '',
        card.takes_link ? 'Click an ally stat in the unit list to link it.' : '',
        card.takes_elem ? 'Pick the token element by clicking one of your stat pills… or let the engine choose.' : '',
      ].filter(Boolean).join('\n');
      if (twin) slot.title = `${card.text || card.name}\n\nYou hold two: pick both to cast them together (Rule 23 ∀)`;
      else if (canChain) slot.title = `${card.text || card.name}\n\nChains onto ${chainTail().name}: its ${elemGlyphs(card.element_cost.slice(0, 1))} is emitted once for both (Rule 22)`;
      else slot.title = (card.text || card.name) + (hints ? `\n\n${hints}` : '');
    } else if (skill) {
      const band = isTrance(card) ? 'P' : card.requires;
      slot.dataset.code = band;
      cardDiv.dataset.code = band;
      const needs = isTrance(card) ? 'any action' : ridesOnEmpty(card) ? `${ACTION_SHORT[card.requires]} / Empty` : (ACTION_SHORT[card.requires] || card.requires);
      cardDiv.innerHTML = `<div class="nm">✦ ${card.name}</div><div class="cd">needs ${needs}${card.is_permanent ? ' · perm' : ''}${isTrance(card) && skillQueued ? ' · ×2' : ''}</div>`;
      slot.title = card.text || card.name;
    } else if (card) {
      const code = card.code;
      slot.dataset.code = code;
      cardDiv.dataset.code = code;
      const short = ACTION_SHORT[code] || card.action_name || code;
      const n = state.queued[0] === i ? state.queuedSkills.length : 0;
      cardDiv.innerHTML = `<div class="nm">${short}</div><div class="cd">${isExtra ? '2nd · ' : ''}${card.card_id.slice(-5)}${n ? ` +${n}✦` : ''}</div>`;
      slot.title = '';
    } else {
      delete slot.dataset.code;
      delete cardDiv.dataset.code;
      cardDiv.innerHTML = `<div class="nm" style="opacity:.4">—</div>`;
      slot.title = '';
    }
    slot.classList.toggle('skill', skill);
    slot.classList.toggle('effect', effect);
    slot.classList.toggle('disabled', (skill && !skillUsable(card)) || castLocksOut(card) || (effect && effectLockedOut(card, i)) || inBonusPlan(card));
    slot.classList.toggle('haste-held', inBonusPlan(card));
    slot.classList.toggle('queued', !skill && !effect && state.queued[0] === i);
    slot.classList.toggle('queued-extra', isExtra);
    slot.classList.toggle('queued-skill', skillQueued || effectQueued);
    slot.classList.toggle('discard', !!card && state.willDiscard.has(card.card_id));
    slot.classList.toggle('archive', !!card && state.willArchive.has(card.card_id));
    slot.classList.toggle('locked', state.locked && (state.queued[0] === i || skillQueued || effectQueued || isExtra));
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
  const ac = document.getElementById('archive-count');
  if (ac) {
    const n = state.archive.length;
    ac.textContent = String(n);
    ac.parentElement.classList.toggle('empty', n === 0);
    ac.parentElement.classList.toggle('armed', state.archiveMode);
    ac.parentElement.title = `Archive: ${n} card${n === 1 ? '' : 's'} · deck ${state.circulating}/${state.deckMin} min — click, then a hand card: it is archived at this resolution instead of discarded · double-click opens the archive`;
  }
  if (!document.getElementById('archive-popup')?.hidden) renderArchivePopup();
}

// The archive popup: every archived card; a click puts it back onto the discard pile.
function renderArchivePopup() {
  const list = document.getElementById('ap-list');
  const sub = document.getElementById('ap-sub');
  if (!list) return;
  if (sub) sub.textContent = `${state.archive.length} archived · ${state.circulating} circulating (min ${state.deckMin})`;
  if (!state.archive.length) { list.innerHTML = '<div class="empty">nothing archived yet — click the pile, then a hand card</div>'; return; }
  list.innerHTML = state.archive.map(c => {
    const creature = c.kind === 'creature', klass = c.kind === 'class';
    const nm = creature ? `🐾 ${c.name}` : klass ? `⚜ ${c.name}` : isEffect(c) ? `✺ ${c.name}` : isSkill(c) ? `✦ ${c.name}` : (ACTION_SHORT[c.code] || c.action_name || c.name || c.code);
    const cd = creature ? `creature · Σ${c.stat_sum ?? ''} · summonable` : klass ? 'class · destroyed — emit every colour (any successful roll) to recast it' : isEffect(c) ? elemGlyphs(c.element_cost) : isSkill(c) ? `needs ${isTrance(c) ? 'any' : ACTION_SHORT[c.requires] || c.requires}` : c.card_id.slice(-5);
    return `<div class="ac${creature ? ' creature' : ''}${klass ? ' creature klass' : ''}" data-id="${c.card_id}" title="${(c.text || c.name || '').replace(/"/g, '&quot;')}"><div class="nm">${nm}</div><div class="cd">${cd}</div></div>`;
  }).join('');
  list.querySelectorAll('.ac:not(.creature)').forEach(d => d.addEventListener('click', () => { send({ kind: 'unarchive', card_id: d.dataset.id }); uilog('unarchive', { detail: d.dataset.id }); }));
}
function openArchive(open) {
  const el = document.getElementById('archive-popup');
  if (!el) return;
  el.hidden = !open;
  if (open) { state.archiveMode = false; renderArchivePopup(); }
  renderDeck();
}
// Peek popup (Vision, Super Sense): what was seen, in the archive popup's clothes. Click anywhere / Esc closes.
function showPeek(text, cards = null) {
  let el = document.getElementById('peek-popup');
  if (!el) {
    el = document.createElement('div');
    el.id = 'peek-popup';
    el.style.cssText = 'position:fixed;inset:0;z-index:60;background:#0008;display:flex;align-items:center;justify-content:center;';
    el.addEventListener('click', () => { el.hidden = true; });
    document.body.appendChild(el);
  }
  const cardsHtml = cards ? `<div style="display:flex;flex-wrap:wrap;gap:8px;padding:0 14px 12px">${cards.map(c => `<div style="width:96px;min-height:50px;padding:8px 6px;border-radius:6px;border:1px solid #26303f;background:linear-gradient(180deg,#1a2230,#10151e);color:#d2dae7;font-size:11px;text-align:center">${c.name}<div style="margin-top:4px;font-size:9px;color:#8aa0bf">${c.kind}${c.code ? ` · ${c.code}` : ''}</div></div>`).join('')}</div>` : '';
  el.innerHTML = `<div style="background:#0f131b;border:1px solid #2f3f55;border-radius:8px;width:min(560px,92vw);max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 50px -10px #000c;color:#e8ecf1">
    <header style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #1a2130;font-weight:600"><span>👁 Peek</span><span style="flex:1"></span><button style="background:transparent;border:1px solid #2f3f55;color:#c8d4e3;border-radius:4px;cursor:pointer;padding:2px 7px">✕</button></header>
    <div style="padding:12px 14px;font-size:12px;line-height:1.5">${text}</div>${cardsHtml}</div>`;
  el.hidden = false;
  logUI(`👁 ${text}`, 'phase');
}
let archiveClickTimer = null;
function wireArchive() {
  const pile = document.querySelector('#archive-pile .pile');
  if (!pile) return;
  // A double-click also fires two clicks: hold the single-click for a beat.
  pile.addEventListener('click', () => {
    if (archiveClickTimer) { clearTimeout(archiveClickTimer); archiveClickTimer = null; return; }
    archiveClickTimer = setTimeout(() => {
      archiveClickTimer = null;
      if (state.locked) return;
      state.archiveMode = !state.archiveMode;
      uilog('archive', { detail: state.archiveMode ? 'arm' : 'disarm' });
      logUI(state.archiveMode ? 'archive: pick a hand card — it goes to the archive at this resolution (click a marked card to unmark it)' : 'archive pick cancelled', 'phase');
      renderDeck();
    }, 230);
  });
  pile.addEventListener('dblclick', () => { if (archiveClickTimer) { clearTimeout(archiveClickTimer); archiveClickTimer = null; } openArchive(true); });
  document.getElementById('ap-close')?.addEventListener('click', () => openArchive(false));
  document.getElementById('archive-popup')?.addEventListener('click', (e) => { if (e.target.id === 'archive-popup') openArchive(false); });
}

// World-generated features (user spec general_ux_token_generated, 2026-10-30): terrain regions, Shrines, Schools,
// Crystals … derived from the dimension seed for every known hex (map.js featureAt), corrected by what players
// did to them (every peer's world_edits_json: gone / moved). Cached per map version + edits.
let worldCache = { key: '', list: [] };
function worldFeatures() {
  const edits = new Map();
  let editsKey = '';
  for (const p of state.entities) {
    let list = []; try { list = JSON.parse(p.world_edits_json || '[]'); } catch {}
    for (const e of list) { const cur = edits.get(e.id); if (!cur || e.gone || (!cur.gone && (e.at ?? 0) >= (cur.at ?? 0))) edits.set(e.id, e); }
    editsKey += p.world_edits_json || '';
  }
  const key = `${state.map.seed}|${state.mapVersion}|${editsKey}`;
  if (key === worldCache.key) return worldCache.list;
  const list = [];
  for (const t of state.map.tiles()) {
    const f = featureAt(state.map.seed, t.q, t.r);
    if (!f) continue;
    const ed = edits.get(f.id);
    if (ed?.gone) continue;
    list.push(ed && Number.isInteger(ed.q) ? { ...f, q: ed.q, r: ed.r, owner: 'world' } : { ...f, owner: 'world' });
  }
  worldCache = { key, list };
  return list;
}
// Hex distance from my unit to another roster entry (Infinity when either tile is unknown).
function hexDistanceTo(e) {
  const me = state.entities.find(p => p.peer_id === state.myPeerId);
  const q = e.tile_q ?? e.tile?.q, r = e.tile_r ?? e.tile?.r;
  if (!me || !Number.isInteger(me.tile_q) || !Number.isInteger(q)) return Infinity;
  return hexDistance({ tile_q: me.tile_q, tile_r: me.tile_r }, { tile_q: q, tile_r: r });
}
function renderRoster() {
  const el = document.getElementById('roster');
  el.innerHTML = '';
  const activeFilter = state.ui.logFilterPeerId;
  const head = document.createElement('div');
  head.className = 'ros-head';
  head.innerHTML = '<span>Unit</span><span class="team">Ally</span>';
  el.appendChild(head);
  for (const e of state.entities) {
    const row = document.createElement('div');
    row.className = `ros ${e.alliance === 'player' || e.alliance === 'npc_a' ? 'ally' : 'enemy'} ${e.life > 0 ? '' : 'dead'} ${activeFilter === e.peer_id ? 'filter-active' : ''}`;
    row.dataset.peerId = e.peer_id;
    const srcTag = (e.source_id || e.sourceId || '').split('_').slice(1, 3).join(' ');
    const tier = e.tier && e.tier !== 'self' ? ` · ${e.tier === 'strong' ? 'in contact' : e.tier}` : '';
    let statTokens = [];
    try { statTokens = JSON.parse(e.stat_tokens_json || '[]'); } catch {}
    // Rule 12 dice over / under a stat show as the modifier next to the base value.
    const stat = (flat, key) => {
      const v = e[flat] ?? e.stats?.[key];
      if (!Number.isFinite(v)) return '—';
      const mod = statTokens.filter(t => t.stat === key).reduce((a, t) => a + t.value, 0);
      return mod ? `${v}${mod > 0 ? '+' : '−'}${Math.abs(mod)}` : v;
    };
    const lost = e.lost_actions > 0 ? `<span class="pill perm" title="lost actions">⏳ ${e.lost_actions}</span>` : '';
    let pens = [];
    try { pens = JSON.parse(e.elem_pen_json || '[]'); } catch {}
    const countered = pens.map(t => `${t.elem.replace(/^elem_/, '')} −${t.amount}`);
    const allPerms = (e.permanents_csv || '').split(',').filter(Boolean);
    const cls = allPerms.find(s => s.startsWith('class_'));
    let permPower = {};
    try { permPower = JSON.parse(e.perm_power_json || '{}') || {}; } catch {}
    // Every permanent shows the die it was placed with — what an enemy's emission has to beat (Rule 24).
    const mine = e.peer_id === state.myPeerId;
    const isAllyRow = !mine && (e.alliance === 'player' || e.alliance === 'npc_a') && e.life > 0;
    const isEnemyRow = !mine && !(e.alliance === 'player' || e.alliance === 'npc_a') && e.life > 0;
    // Phylactery pick: an enemy's permanents become clickable (class cards excepted).
    const permPills = isEnemyRow && state.phylacteryMode;
    const permLabel = s => `${s.replace(/^(skill|effect)_/, '').replace(/_/g, ' ')}${permPower[s] ? ` ⚄${permPower[s]}` : ''}`;
    const perms = allPerms.filter(s => !s.startsWith('class_')).map(s => permPills
      ? `<span class="pill perm clickable${state.queuedPhylactery?.peer_id === e.peer_id && state.queuedPhylactery?.perm === s ? ' active' : ''}" data-perm="${s}" title="Phylactery — shatter ${permLabel(s)} at the end of this action">💀 ${permLabel(s)}</span>`
      : permLabel(s));
    // Spirit Link: the queued Spirit Link takes the ally stat clicked here.
    const linkPick = isAllyRow && state.queuedEffect !== null && !!state.hand[state.queuedEffect]?.takes_link;
    const pill = (cls, key, label, flat) => {
      const on = (mine && state.destroy?.stat === key) || (linkPick && state.queuedLink?.peer_id === e.peer_id && state.queuedLink?.stat === key);
      const title = mine ? `${label} — click to emit ${label} against the closest enemy's ${label} tokens (Rule 24)` : linkPick ? `${label} — click to link this stat to yours (Spirit Link)` : label;
      return `<span class="pill ${cls}${mine || linkPick ? ' clickable' : ''}${on ? ' active' : ''}" data-stat="${key}" title="${title}">${on ? (mine ? '⚒ ' : '🔗 ') : ''}${label[0] === 'W' && label.length > 5 ? 'Wi' : label[0]} ${stat(flat, key)}</span>`;
    };
    // Spirit links held, afflictions suffered (Sleep / Confusion), traps laid (count only — face down).
    let links = [], afflictions = [], traps = [];
    try { links = JSON.parse(e.links_json || '[]'); } catch {}
    try { afflictions = JSON.parse(e.afflictions_json || '[]'); } catch {}
    try { traps = JSON.parse(e.traps_json || '[]'); } catch {}
    const nameOf = id => state.entities.find(p => p.peer_id === id)?.name || peerShort(id);
    const extraPills = [
      links.length && allPerms.includes('effect_spirit_link') ? `<span class="pill perm" title="Spirit Link">🔗 ${links.map(l => `${nameOf(l.from)} ${l.stat}`).join(', ')}</span>` : '',
      afflictions.length ? `<span class="pill perm" title="afflicted">😵 ${afflictions.map(a => `${a.effect_id.replace(/^effect_/, '')} by ${nameOf(a.by)}`).join(', ')}</span>` : '',
      traps.length ? `<span class="pill perm" title="${mine ? traps.map(t => `${t.effect_id.replace(/^effect_/, '')} at (${t.q},${t.r})`).join(', ') : 'traps laid (face down)'}">🪤 ${traps.length}</span>` : '',
    ].join('');
    // Class card (user ruling 2026-10-30): every unit shows its class with one chip per colour (the stat group of
    // its elements); a colour an enemy struck down is en-gray; an archived class is all gray. An adjacent enemy's
    // chip is clicked twice to aim this action's emission at that colour (needs a die of 6).
    const classId = e.class_id || cls || null;
    const classPill = (() => {
      if (!classId) return '';
      const colours = state.classColours?.[classId] || {};
      const down = new Set(String(e.class_down_csv || '').split(',').filter(Boolean));
      const archived = !!Number(e.class_archived);
      const tapped = !!Number(e.class_tapped);
      const canStrike = isEnemyRow && !archived && hexDistanceTo(e) <= 1;
      const chips = Object.keys(colours).map(st => {
        const isDown = archived || down.has(st);
        const armed = state.classStrike?.peer_id === e.peer_id && state.classStrike?.stat === st;
        const queued = state.destroy?.class === e.peer_id && state.destroy?.stat === st;
        const label = st === 'will' ? 'Wi' : st[0].toUpperCase();
        const title = isDown ? `${st} colour struck down` : canStrike ? `${st} colour (${colours[st].map(x => x.replace('elem_', '')).join('/')}) — click twice to emit against it (needs a 6)` : `${st} colour: ${colours[st].map(x => x.replace('elem_', '')).join('/')}`;
        return `<span class="chip ${st}${isDown ? ' down' : ''}${canStrike && !isDown ? ' clickable' : ''}${armed ? ' armed' : ''}${queued ? ' active' : ''}" data-class-stat="${st}" title="${title}">${queued ? '⚒' : ''}${label}</span>`;
      }).join('');
      const nm = classId.replace(/^class_/, '').replace(/_/g, ' ');
      const state_ = archived ? ' · archived' : tapped ? ' · tapped' : '';
      return `<span class="pill cls${archived ? ' archived' : ''}" data-class="${classId}" title="class${state_}${archived ? ' — the owner recasts it by emitting every colour' : ''}">⚜ ${nm}${tapped && !archived ? ' ⟳' : ''} ${chips}</span>`;
    })();
    const team = teamLabel(e);
    row.innerHTML = `<span class="nm">${e.name}<span class="team ${/Team|You/.test(team) ? 'team-own' : team === 'Monster' || team === 'Enemy' ? 'team-foe' : 'team-ally'}" title="ally">${team}</span></span>
      <span class="st">${srcTag} · hp ${e.life}/${e.life_max || e.lifeMax} · (${e.tile_q ?? e.tile?.q},${e.tile_r ?? e.tile?.r})${tier}</span>
      <span class="stats">
        ${pill('v', 'vitality', 'Vitality', 'stat_vitality')}
        ${pill('w', 'world', 'World', 'stat_world')}
        ${pill('m', 'matter', 'Matter', 'stat_matter')}
        ${pill('wi', 'will', 'Will', 'stat_will')}
        ${classPill}
        ${perms.length ? `<span class="pill perm" title="permanents">✦ ${perms.join(', ')}</span>` : ''}
        ${lost}${countered.length ? `<span class="pill perm" title="countered this turn">✨ ${countered.join(', ')}</span>` : ''}${extraPills}
      </span>`;
    // Clicking a roster row toggles the log filter on that peer; clicking one
    // of MY stat pills queues a Rule 24 emission with that stat instead; an
    // ally stat pill links it (Spirit Link); an enemy perm pill names it (Phylactery).
    row.addEventListener('click', (ev) => {
      // An enemy class colour chip: first click arms it, the second sends the strike (destroy with class + elem).
      const chipEl = ev.target.closest('.chip.clickable');
      if (chipEl && isEnemyRow && chipEl.dataset.classStat) {
        ev.stopPropagation();
        if (state.locked) return;
        const st = chipEl.dataset.classStat;
        if (state.classStrike?.peer_id === e.peer_id && state.classStrike?.stat === st) {
          const elem = (state.classColours?.[classId]?.[st] || [])[0] || null;
          state.classStrike = null;
          uilog('class-strike', { detail: `${e.peer_id} ${st}` });
          send({ kind: 'destroy', stat: st, class: e.peer_id, elem });
          cancelPathJourney('manual pick');
          logUI(`⚒ emit ${st} against ${e.name}'s class colour — a die of 6 strikes it down`, 'phase');
        } else {
          state.classStrike = { peer_id: e.peer_id, stat: st };
          logUI(`click ${e.name}'s ${st} chip once more to aim this action's emission at it`, 'phase');
          renderRoster();
        }
        return;
      }
      const pillEl = ev.target.closest('.pill.clickable');
      if (pillEl && mine && pillEl.dataset.stat && state.queuedEffect !== null && state.hand[state.queuedEffect]?.takes_elem) {
        // general_ux_tokens: the token element for the queued cast (Artifice) — cycle the clicked stat's elements.
        ev.stopPropagation();
        if (state.locked) return;
        const elems = Object.keys(ELEM_STAT).filter(el => ELEM_STAT[el] === pillEl.dataset.stat);
        const cur = elems.indexOf(state.queuedElem);
        const next = cur >= 0 && cur < elems.length - 1 ? elems[cur + 1] : cur === elems.length - 1 ? state.queuedElem : elems[0];   // last one again → cleared (peer toggles)
        uilog('elem', { detail: next });
        send({ kind: 'elem', elem: next });
        return;
      }
      if (pillEl && mine) {
        ev.stopPropagation();
        if (state.locked) return;
        uilog('destroy', { detail: pillEl.dataset.stat });
        send({ kind: 'destroy', stat: pillEl.dataset.stat });
        cancelPathJourney('manual pick');
        return;
      }
      if (pillEl && pillEl.dataset.stat && linkPick) {
        ev.stopPropagation();
        if (state.locked) return;
        uilog('link', { detail: `${e.peer_id} ${pillEl.dataset.stat}` });
        send({ kind: 'link', peer_id: e.peer_id, stat: pillEl.dataset.stat });
        logUI(`Spirit Link → ${e.name}'s ${pillEl.dataset.stat}`, 'phase');
        return;
      }
      if (pillEl && pillEl.dataset.perm && permPills) {
        ev.stopPropagation();
        if (state.locked) return;
        uilog('phylactery', { detail: `${e.peer_id} ${pillEl.dataset.perm}` });
        send({ kind: 'phylactery', peer_id: e.peer_id, perm: pillEl.dataset.perm });
        state.phylacteryMode = false;
        logUI(`💀 Phylactery → ${e.name}'s ${pillEl.dataset.perm.replace(/^(skill|effect)_/, '')} shatters at the end of this action`, 'phase');
        return;
      }
      setLogFilter(activeFilter === e.peer_id ? null : e.peer_id);
    });
    el.appendChild(row);
  }
}

// My permanents (Sanctuary, Barricade, …) as the peer broadcasts them.
function myPermanents() {
  const me = state.entities.find(p => p.peer_id === state.myPeerId);
  return String(me?.permanents_csv || '').split(',').filter(Boolean);
}
// The permanents strip right of the deck: every non-class permanent as a small
// card with its die; the first two answer to keys 9 and 0. An Aura ∀ is a
// button — it routes the queued cast to everyone within 10 hexes and is spent.
function myPermCards() {
  const me = state.entities.find(p => p.peer_id === state.myPeerId);
  let power = {}; try { power = JSON.parse(me?.perm_power_json || '{}') || {}; } catch {}
  const every = new Set(String(me?.every_csv || '').split(',').filter(Boolean));
  return myPermanents().filter(id => !id.startsWith('class_')).map(id => ({
    id, name: id.replace(/^(skill|effect)_/, '').replace(/_/g, ' '), die: power[id] || 0, every: every.has(id),
    action: id === 'effect_aura' && every.has(id) ? 'aura' : (id === 'effect_haste' || id === 'effect_balefire') ? 'bonus'
      : id === 'effect_blessing_curse' ? 'bless' : id === 'effect_possess_phylactery' ? 'phylactery' : null,
  }));
}
// What the permanents of the 2026-10-29 batch do, for the strip's tooltips.
const PERM_HELP = {
  effect_balefire: 'Balefire (6) — until the end of your next turn every card in hand is an instant: queue up to 9 bonus plans per action (one element emission per action still); falls to a Fire/Harmony/Time die of 6',
  effect_traps_mastery: 'Traps Mastery (6) — the effect card under you is a trap (power 20 per element): it springs on the first enemy that targets you while you stand on it',
  effect_sleep: 'Sleep (6) — the enemy who stepped onto your trap cannot cast effects while in contact with you',
  effect_confusion: 'Confusion (6) — the enemy who stepped onto your trap may only Empty-Posture',
  effect_delay_time: 'Delay Time — each adjacent enemy loses the last action of every turn per holder next to them',
  effect_empower: 'Empower — your next cast puts two elements out in one action; spent then',
  effect_spirit_link: 'Spirit Link — the linked ally stat is added to yours (not a token); your life maximum follows',
  effect_blessing_curse: 'Blessing / Curse — the effect card under it fires every action for free; click it, then an effect card in hand, to replace what it holds (old card discarded)',
  effect_phantom: 'Phantom — a mirror of you fights next to you; it shatters at the first point of damage',
  effect_possess_phylactery: 'Possess / Phylactery (6) — the possessed enemy fights for you (your hero only Empty-Moves / Empty-Postures); click it, then an enemy permanent in the unit list, to shatter that permanent at this action\'s end (spends Possess)',
  effect_super_sense: 'Super Sense — the traps on the six tiles around you are shown to you; the first point of damage that would land on you is evaded and the permanent spent',
  effect_harm: 'Harm (channel) — re-fires every action while you keep the Posture and emit nothing else; Attack / Block / Move / Empty Move break it',
  effect_combustion: 'Combustion (channel) — a Harmony penalty token on the target every action while you keep the channel',
  effect_the_void: 'The Void (channel) — you take no damage while you keep the channel',
  effect_light_darkness: 'Light / Darkness (channel) — the no-damage zone around you is renewed every action while you keep the channel',
};
let lastPermsHtml = '';
function renderPerms() {
  const el = document.getElementById('perms');
  if (!el) return;
  const perms = myPermCards();
  const KEYS = ['9', '0', '-', '='];
  let ki = 0;   // keys go to permanents with an ability only (a Summoning has none)
  // My class card first (user ruling 2026-10-30): click it to use the ability this action (key 8); a tapped or
  // archived class shows its colours — click one to emit it (any successful roll) toward the untap / recast.
  const cs = state.classState;
  const classHtml = cs?.class_id ? (() => {
    const cols = Object.keys(cs.colours || {});
    const mode = cs.archived ? 'recast' : cs.tapped ? 'untap' : null;
    const done = new Set(cs.progress?.mode === mode ? cs.progress.done || [] : []);
    const chips = cols.map(st => {
      const isDone = done.has(st);
      const queued = state.destroy?.[mode] && state.destroy?.stat === st;
      const label = st === 'will' ? 'Wi' : st[0].toUpperCase();
      return `<span class="chip ${st}${mode ? (isDone ? ' done' : ' clickable') : (cs.down || []).includes(st) ? ' down' : ''}${queued ? ' active' : ''}" data-class-stat="${st}" title="${mode ? (isDone ? `${st} already emitted` : `emit ${st} to ${mode} (any successful roll)`) : `${st} colour: ${(cs.colours[st] || []).map(x => x.replace('elem_', '')).join('/')}`}">${queued ? '⚒' : ''}${label}</span>`;
    }).join('');
    const ready = !mode && (cs.kind === 'tap' ? !cs.tapped : true);
    const need = cs.needs === 'enemy' ? 'an adjacent enemy (right-click it)' : cs.needs === 'ally_or_self' ? 'an adjacent ally (right-click it) or nobody for yourself' : cs.needs === 'tile' ? 'a tile within one hex (click it)' : cs.needs === 'attach_effect' ? 'an effect card in hand (click it as the attached card)' : cs.needs === 'attach_nonaction' ? 'a non-action card in hand (click it as the attached card)' : null;
    const title = `${cs.name} (${cs.kind === 'tap' ? 'tap' : 'once per action'}) — ${cs.text}${need ? ` Needs ${need}.` : ''}${mode === 'recast' ? ' ARCHIVED: emit every colour (any successful roll) to recast it.' : mode === 'untap' ? ' TAPPED: emit every colour (any successful roll) to untap it.' : ''} (key Q)`;
    const cd = mode ? `${mode} ${done.size}/${cols.length}` : state.queuedClassAbility ? '⚜ this action' : ready ? 'ready' : 'used this action';
    return `<div class="perm class-card${ready && !mode ? ' clickable' : ''}${state.queuedClassAbility ? ' active' : ''}${mode ? ' ' + mode : ''}" data-class="${cs.class_id}" title="${title.replace(/"/g, '&quot;')}"><div class="k">Q</div><div class="nm">⚜ ${cs.name}</div><div class="cd">${cd}</div><div class="chips">${chips}</div></div>`;
  })() : '';
  const html = classHtml + perms.map((p, k) => {
    const plans = state.bonus?.plans || [];
    const key = p.action ? KEYS[ki++] : null;
    const blessed = (state.channels || []).find(ch => ch.holder === 'effect_blessing_curse');
    const active = (p.action === 'aura' && state.withAura) || (p.action === 'bonus' && (state.bonusMode || plans.length > 0)) || (p.action === 'bless' && state.blessMode) || (p.action === 'phylactery' && (state.phylacteryMode || state.queuedPhylactery));
    const title = p.action === 'aura' ? `Aura ∀ — cast the queued effect on everyone within 10 hexes; the Aura is spent (key ${key || '·'})`
      : p.action === 'bonus' ? `Bonus rounds (${state.bonus?.max || 0}) — pick an action, skills and an effect, Space commits each; they resolve first, alone, against everyone's Empty Posture; then pick your normal action (key ${key || '·'})`
      : SUMMON_PERM_IDS.has(p.id) ? `${p.name} (6) — holds ${mySummoned().map(x => x.name).join(', ') || 'your creature / ward'}; an enemy needs a 6 to destroy it, then the creature vanishes and its card goes to your archive`
      : p.id === 'effect_blessing_curse' ? `${PERM_HELP[p.id]} — holds ${blessed?.name || 'nothing'} (key ${key || '·'})`
      : PERM_HELP[p.id] ? `${PERM_HELP[p.id]}${key ? ` (key ${key})` : ''}` : p.name;
    const cd = p.action === 'bonus' && plans.length ? `⚡ ${plans.map(b => b.action).join('▸')}` : p.action === 'bonus' && state.bonusMode ? `⚡ pick ${plans.length + 1}/${state.bonus?.max || 1}`
      : p.action === 'bless' ? (state.blessMode ? '📎 pick a card' : blessed ? `📎 ${blessed.name}` : 'empty')
      : p.action === 'phylactery' ? (state.queuedPhylactery ? `💀 ${state.queuedPhylactery.perm.replace(/^(skill|effect)_/, '').replace(/_/g, ' ')}` : state.phylacteryMode ? '💀 pick a perm' : `⚄${p.die || 6}`)
      : p.die ? `⚄${p.die}` : 'perm';
    return `<div class="perm${p.action ? ' clickable' : ''}${active ? ' active' : ''}" data-k="${k}" title="${title}">${key ? `<div class="k">${key}</div>` : ''}<div class="nm">${p.every ? '∀ ' : ''}${SUMMON_PERM_IDS.has(p.id) ? '🐾 ' : ''}${p.name}</div><div class="cd">${cd}</div></div>`;
  }).join('');
  if (html === lastPermsHtml) return;
  lastPermsHtml = html;
  el.innerHTML = html;
  el.hidden = perms.length === 0 && !classHtml;
  el.querySelectorAll('.perm.clickable:not(.class-card)').forEach(d => d.addEventListener('click', () => clickPermanent(Number(d.dataset.k))));
  const cc = el.querySelector('.perm.class-card');
  if (cc) cc.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (chip?.dataset.classStat && (cs.archived || cs.tapped)) { clickClassColour(chip.dataset.classStat); return; }
    if (cc.classList.contains('clickable')) clickClassCard();
  });
}
// My class card clicked: the ability goes out with this action (toggle). Card-attach classes need the hand card first.
function clickClassCard() {
  const cs = state.classState;
  if (!cs?.class_id || state.locked) return;
  if ((cs.needs === 'attach_effect' || cs.needs === 'attach_nonaction') && state.queuedAttach === null && !state.queuedClassAbility) {
    logUI(`${cs.name}: click the card in hand it works on first (it becomes the attached card), then the class card`, 'phase');
    return;
  }
  uilog('class-ability', { detail: cs.class_id });
  send({ kind: 'class_ability' });
  logUI(state.queuedClassAbility ? `${cs.name}: ability withdrawn` : `⚜ ${cs.name}: ${cs.text}`, 'phase');
}
// A colour of my tapped / archived class: emit it this action toward the untap / recast (any successful roll).
function clickClassColour(stat) {
  const cs = state.classState;
  if (!cs?.class_id || state.locked) return;
  const mode = cs.archived ? 'recast' : cs.tapped ? 'untap' : null;
  if (!mode) return;
  uilog('class-' + mode, { detail: stat });
  send({ kind: 'destroy', stat, [mode]: true });
  cancelPathJourney('manual pick');
  logUI(`⚒ emit ${stat} to ${mode} ${cs.name}`, 'phase');
}
const SUMMON_PERM_IDS = new Set(['effect_summoning', 'effect_golems_earth', 'effect_golems_water', 'effect_golems_air', 'effect_elementals_air', 'effect_elementals_water', 'effect_elementals_earth', 'effect_resurrect_death_ward']);
// The creatures my permanents hold, as the roster knows them.
function mySummoned() {
  const me = state.entities.find(p => p.peer_id === state.myPeerId);
  return String(me?.summoned_csv || '').split(',').filter(Boolean).map(id => state.entities.find(p => p.peer_id === id) || { name: id });
}
// Team label (user spec): a creature belongs to "<Owner> Team" when summoned, bound or
// raised, else it is a "Monster"; characters read You / <name> Team / Ally / Enemy.
function teamLabel(e) {
  const owner = e.owner_peer_id ? state.entities.find(p => p.peer_id === e.owner_peer_id) : null;
  if (e.owner_peer_id) return `${owner?.peer_id === state.myPeerId ? 'Your' : (owner?.name || peerShort(e.owner_peer_id))} Team`;
  if (e.creature_id || e.source_id?.startsWith('mon_')) return e.alliance === 'npc_b' ? 'Monster' : 'Ally';
  if (e.peer_id === state.myPeerId) return 'You';
  if (e.alliance === 'player') return `${e.name} Team`;
  return e.alliance === 'npc_a' ? 'Ally' : 'Enemy';
}
// Keys 9 0 - = address the n-th permanent WITH an ability.
function clickPermanentKey(n) {
  const all = myPermCards();
  const k = all.findIndex((p, i) => p.action && all.slice(0, i).filter(x => x.action).length === n);
  if (k >= 0) clickPermanent(k);
}
function clickPermanent(k) {
  const p = myPermCards()[k];
  if (!p || state.locked) return;
  uilog('permanent', { detail: p.id });
  if (p.action === 'aura') {
    if (state.queuedEffect === null) { logUI('pick an effect first — the Aura ∀ carries it to everyone within 10 hexes', 'phase'); return; }
    state.withAura = !state.withAura;
    sendQueue(); renderDeck();
  }
  if (p.action === 'bonus') {
    if (state.bonus?.plans?.length) { state.bonusPlans = []; send({ kind: 'bonus', plans: [] }); logUI('bonus rounds cleared', 'phase'); clearQueuePick(); return; }
    state.bonusMode = !state.bonusMode;
    // Entering the pick starts from a clean queue; leaving it without committing drops the pick.
    clearQueuePick();
    logUI(state.bonusMode ? `⚡ bonus round 1/${state.bonus?.max || 1}: pick action, skills, effect — Space commits it` : 'bonus pick cancelled', 'phase');
    renderDeck();
  }
  if (p.action === 'bless') {
    // Blessing held: the next effect card clicked in hand replaces the one under it.
    state.blessMode = !state.blessMode;
    logUI(state.blessMode ? '📎 Blessing: click an effect card in hand — it replaces the one under the Blessing (old card discarded)' : 'blessing pick cancelled', 'phase');
    renderDeck(); renderPerms();
  }
  if (p.action === 'phylactery') {
    if (state.queuedPhylactery) { send({ kind: 'phylactery', peer_id: state.queuedPhylactery.peer_id, perm: state.queuedPhylactery.perm }); state.phylacteryMode = false; logUI('phylactery pick cleared', 'phase'); renderPerms(); return; }
    state.phylacteryMode = !state.phylacteryMode;
    logUI(state.phylacteryMode ? '💀 Phylactery: click an enemy permanent in the unit list — it shatters at the end of this action (spends Possess)' : 'phylactery pick cancelled', 'phase');
    renderRoster(); renderPerms();
  }
}
function clearQueuePick() {
  state.queued = []; state.queuedSkills = []; state.queuedExtra = null; state.queuedEffect = null; state.queuedEffect2 = null; state.queuedChain = []; state.withAura = false; state.queuedIsAuto = false;
  sendQueue();
}
// Space in bonus mode commits one bonus plan; after the last one (or when the
// allowance is used up) the queue goes back to the normal action.
function commitBonus() {
  if (!state.queued.length) { logUI('bonus round: pick an action first', 'phase'); return; }
  const plan = { slots: state.queued, skills: state.queuedSkills, extra: state.queuedExtra, effect: state.queuedEffect, destroy: state.destroy?.stat || null, target: state.target && typeof state.target === 'object' ? { q: state.target.q, r: state.target.r } : state.target };
  state.bonusPlans = [...state.bonusPlans, plan];
  send({ kind: 'bonus', plans: state.bonusPlans });
  const max = state.bonus?.max || 1;
  // A cast still emitting elements rides on into the next bonus plan.
  const eff = state.queuedEffect !== null ? state.hand[state.queuedEffect] : null;
  const carried = eff && !eff.is_instant ? state.queuedEffect : null;
  const stepsSoFar = carried !== null ? state.bonusPlans.filter(b => b.effect === carried).length : 0;
  const carryOn = carried !== null && stepsSoFar < castLength(eff, false) && state.bonusPlans.length < max;
  clearQueuePick();
  if (state.bonusPlans.length >= max) {
    state.bonusMode = false;
    logUI(`⚡ ${state.bonusPlans.length} bonus round(s) committed — now pick your normal action`, 'phase');
  } else {
    if (carryOn) { const pi = firstActionIdx('P'); state.queued = [pi >= 0 ? pi : 'EMPTY']; state.queuedEffect = carried; sendQueue(); }
    logUI(`⚡ bonus round ${state.bonusPlans.length + 1}/${max}: pick the next (Space commits; click the ⚡ card to stop)`, 'phase');
  }
  renderDeck();
}
// Cards already committed to a bonus plan are spent — except an effect still being cast there.
const inBonusPlan = (card) => {
  if (!card) return false;
  const plans = state.bonus?.plans || [];
  if (!plans.some(b => b.card_ids?.includes(card.card_id))) return false;
  if (isEffect(card) && !card.is_instant) {
    const steps = plans.filter(b => b.card_ids?.includes(card.card_id)).length;
    if (steps < castLength(card, false) && state.bonusMode) return false;
  }
  return true;
};
const inSanctuary = () => myPermanents().includes('skill_sanctuary');

function autoselectFirstHandCard() {
  // Rule-of-thumb UX: default the queue to the first hand card so the auto-
  // commit at timer-0 picks something sensible when the player doesn't act.
  // Falls back to the EMPTY slot if the hand is empty for some reason.
  // In Sanctuary the default is the Empty Posture instead: the hero cannot be
  // hurt while resting there, and any other action or skill ends the refuge —
  // so leaving it has to be the player's deliberate pick.
  const firstIdx = state.hand.findIndex(c => isAction(c));
  if (inSanctuary()) {
    state.queued = ['EMPTY']; state.target = null;
    logUI('Sanctuary: resting in Empty Posture — nothing can hurt you; picking any action or skill leaves it', 'phase');
  }
  else if (firstIdx >= 0) state.queued = [firstIdx];
  else state.queued = ['EMPTY'];
  state.queuedSkills = [];
  state.queuedExtra = null;
  state.queuedEffect = null;
  state.queuedEffect2 = null;
  state.queuedChain = [];
  state.withAura = false;
  state.queuedIsAuto = true;
  sendQueue();
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
    state.queuedSkills = [];
    state.queuedExtra = null;
    state.queuedEffect = null;
    state.queuedEffect2 = null;
    state.queuedChain = [];
    state.withAura = false;
    state.bonusMode = false;
    state.bonusPlans = [];
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
        if (Array.isArray(m.archive)) state.archive = m.archive;
        if (Array.isArray(m.will_archive)) state.willArchive = new Set(m.will_archive);
        if (typeof m.deck_min === 'number') state.deckMin = m.deck_min;
        if (typeof m.circulating === 'number') state.circulating = m.circulating;
        if (typeof m.turn === 'number') state.turn = m.turn;
        if (typeof m.round === 'number') state.round = m.round;
        if (typeof m.rounds_per_turn === 'number') state.roundsPerTurn = m.rounds_per_turn;
        // Merge rather than overwrite — the peer's initial hello may lag Gun's
        // own peer catalog.
        mergeEntities(m.peers || []);
        if (m.entity?.stats) mergeEntities([{ peer_id: m.peer_id, stats: m.entity.stats }]);
        if (m.class_colours) state.classColours = m.class_colours;
        if (m.class_state) state.classState = m.class_state;
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
        if (Array.isArray(m.archive)) state.archive = m.archive;
        if (Array.isArray(m.will_archive)) state.willArchive = new Set(m.will_archive);
        if (typeof m.deck_min === 'number') state.deckMin = m.deck_min;
        if (typeof m.circulating === 'number') state.circulating = m.circulating;
        if (m.notice) logUI(m.notice, 'phase');
        if (Array.isArray(m.queued)) state.queued = m.queued;
        if (Array.isArray(m.queued_skills)) state.queuedSkills = m.queued_skills;
        if (m.queued_extra !== undefined) state.queuedExtra = typeof m.queued_extra === 'number' ? m.queued_extra : null;
        if (m.queued_effect !== undefined) state.queuedEffect = typeof m.queued_effect === 'number' ? m.queued_effect : null;
        if (m.queued_effect2 !== undefined) state.queuedEffect2 = typeof m.queued_effect2 === 'number' ? m.queued_effect2 : null;
        if (Array.isArray(m.queued_chain)) state.queuedChain = m.queued_chain.filter(i => typeof i === 'number');
        if (m.aura !== undefined) state.withAura = !!m.aura;
        if (m.bonus !== undefined) state.bonus = m.bonus || { max: 0, balefire: 0, plans: [] };
        if (typeof m.turn === 'number') state.turn = m.turn;
        if (typeof m.round === 'number') state.round = m.round;
        if (m.casting !== undefined) state.casting = m.casting || null;
        if (m.destroy !== undefined) state.destroy = m.destroy || null;
        if (typeof m.lost_actions === 'number') { if (m.lost_actions > state.lostActions) logUI(`you lose ${m.lost_actions} action${m.lost_actions > 1 ? 's' : ''} — Empty Posture until it passes`, 'phase'); state.lostActions = m.lost_actions; }
        if (m.turn_end) { state.willDiscard.clear(); logUI(`turn end — hand refilled to ${state.hand.length}`, 'phase'); }
        // 2026-10-29 batch: what rides on the queued cast and what my permanents hold.
        if (m.queued_attach !== undefined) state.queuedAttach = typeof m.queued_attach === 'number' ? m.queued_attach : null;
        if (m.queued_link !== undefined) state.queuedLink = m.queued_link || null;
        if (m.queued_elem !== undefined) state.queuedElem = m.queued_elem || null;
        if (m.queued_phylactery !== undefined) state.queuedPhylactery = m.queued_phylactery || null;
        // Classes (user ruling 2026-10-30): my class card's state and whether its ability is queued this action.
        if (m.class_state !== undefined) state.classState = m.class_state || null;
        if (m.queued_class_ability !== undefined) state.queuedClassAbility = !!m.queued_class_ability;
        // Possess (user ruling 2026-10-30): while it stands I play the possessed unit — my picks drive it, my hero holds.
        if (m.possessing !== undefined && (m.possessing || null) !== (state.possessing || null)) {
          state.possessing = m.possessing || null;
          const who = state.entities.find(p => p.peer_id === state.possessing);
          logUI(state.possessing ? `👁 you play ${who?.name || peerShort(state.possessing)} now — your action and target drive it, your hero holds, until its Possess permanent is destroyed` : 'possession over — you play your own hero again', 'phase');
        }
        if (Array.isArray(m.channels)) state.channels = m.channels;
        if (Array.isArray(m.sensed_traps)) {
          const seen = new Set(state.sensedTraps.map(t => `${t.by}:${t.q},${t.r}:${t.effect_id}`));
          for (const t of m.sensed_traps) if (!seen.has(`${t.by}:${t.q},${t.r}:${t.effect_id}`)) showPeek(`Super Sense: a ${t.name} trap (${t.elements.map(e => e.replace('elem_', '')).join('+')}) lies at (${t.q},${t.r}), laid by ${t.by_name} — it ${t.trigger === 'enter' ? 'springs on whoever steps in' : 'springs when its owner is targeted'}.`);
          state.sensedTraps = m.sensed_traps;
        }
        if (state.queuedEffect === null) { state.blessMode = false; }
        renderPerms(); renderRoster();
      }
      // Vision / Super Sense: a popup with what was seen (a tile, an enemy's hand).
      if (m.kind === 'peek') showPeek(m.text || (m.what === 'hand' ? `${m.of_name}: ${(m.cards || []).map(c => c.name).join(', ')}` : `tile (${m.q},${m.r})`), m.cards || null);
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
          const seqDelay = (env.payload.bonus_rounds || 0) * 1400;   // bonus rounds play first, in order; the normal action after
          for (const d of dmg) {
            const key = `${env.turn}:${env.round}:${d.target}:${d.amount}:${d.attacker || d.source || ''}:${d.bonus ? 'h' : ''}`;
            const dmgDelay = d.bonus ? 0 : seqDelay;
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
                startAt: performance.now() + dmgDelay,
                duration: 2200,
              });
            }
          }
          if (state._loggedDmg.size > 500) state._loggedDmg = new Set([...state._loggedDmg].slice(-100));
          // A Summoning fell: its creature vanishes (💨 where it stood).
          state._loggedVanish ||= new Set();
          for (const v of env.payload.vanished || []) {
            const vk = `${env.turn}:${env.round}:${v.peer_id}`;
            if (state._loggedVanish.has(vk)) continue;
            state._loggedVanish.add(vk);
            logUI(`  💨 ${v.name || peerShort(v.peer_id)} ${v.bound ? 'is released from' : 'vanishes with'} ${peerShort(env.actor_peer_id)}'s Summoning`, 'damage', { peerId: v.peer_id });
            const at = Number.isInteger(v.q) ? v : state.entities.find(e => e.peer_id === v.peer_id);
            if (at && Number.isInteger(at.q ?? at.tile_q)) state.ui.floatingIcons.push({ effect: 'vanish', glyph: '💨', fromQ: at.q ?? at.tile_q, fromR: at.r ?? at.tile_r, toQ: at.q ?? at.tile_q, toR: at.r ?? at.tile_r, upOnly: true, startAt: performance.now() + seqDelay, duration: 2600 });
          }
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
          // Per-actor action icons for every revealer — heroes, allies and
          // monsters alike (the user wants to read the monsters' plays on the
          // map too). The ➙ "nobody scored" arrow between adjacent enemies is
          // handled below in the `contact` branch, not here. De-dup by
          // (turn, round, actor) since every peer's echoed state_hash carries
          // the same payload.
          state._loggedAction ||= new Set();
          state.ui.revealBadges ||= {};
          for (const a of env.payload.actions || []) {
            const ak = `${env.turn}:${env.round}:${a.actor}${a.bonus ? `:bonus${a.bonus_k || 0}` : ''}`;
            if (state._loggedAction.has(ak)) continue;
            state._loggedAction.add(ak);
            const at0 = performance.now() + (a.bonus ? (a.bonus_k || 0) * 1400 : seqDelay);
            // Every revealer (heroes and monsters) gets the composed chip over
            // its head — `[EM + A + ✦BT + ✦Po]` — fading on the icon's clock.
            // A bonus round shows as `⚡ A ▸ P` once the normal action follows it.
            const prevBadge = state.ui.revealBadges[a.actor];
            const chained = !a.bonus && prevBadge?.bonusKey === `${env.turn}:${env.round}`;
            const chainedBonus = a.bonus && prevBadge?.bonusKey === `${env.turn}:${env.round}`;
            state.ui.revealBadges[a.actor] = { text: chained || chainedBonus ? `${prevBadge.text} ▸ ${composeLabel(a)}` : `${a.bonus ? '⚡ ' : ''}${composeLabel(a)}`, startAt: performance.now(), duration: 2200 + (a.bonus ? (a.bonus_k || 0) * 1400 : seqDelay), bonusKey: a.bonus ? `${env.turn}:${env.round}` : null };
            if (a.bonus) logUI(`  ⚡ ${peerShort(a.actor)} ${a.pre ? 'balefire first' : `bonus round ${(a.bonus_k || 0) + 1}`}: ${composeLabel(a)}`, 'phase', { peerId: a.actor });
            const fromQ = Number.isInteger(a.from_q) ? a.from_q : null;
            const fromR = Number.isInteger(a.from_r) ? a.from_r : null;
            if (fromQ === null) continue;
            const hasAim = Number.isInteger(a.target_q) && Number.isInteger(a.target_r);
            // One row of icons: the action (for a trance: each played option,
            // then 🌀), followed by a glyph per skill that rode on it. They
            // travel and fade together — the skill vanishes with its action.
            const icons = [];
            if (Array.isArray(a.trance) && a.trance.length) {
              a.trance.forEach((c, i) => { if (!Array.isArray(a.played) || a.played.includes(i)) icons.push({ action: c }); });
              icons.push({ action: 'BT' });
            } else icons.push({ action: a.action });
            for (const id of a.skills || []) if (id !== 'skill_battle_trance') icons.push({ skill: id });
            for (const e of a.effects || []) icons.push({ effect: e.effect_id, glyph: `✺${elemGlyphs(e.elements)}` });
            const startAt = at0;
            icons.forEach((ic, i) => state.ui.floatingIcons.push({
              ...ic,
              dx: (i - (icons.length - 1) / 2) * 22,
              fromQ, fromR,
              toQ: hasAim ? a.target_q : fromQ,
              toR: hasAim ? a.target_r : fromR,
              upOnly: !hasAim,
              startAt,
              duration: 2200,
            }));
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
  const card = typeof key === 'number' ? state.hand[key] : null;
  if (typeof key === 'number' && !card) return;
  // Archive pick: the card is marked (or unmarked) for the archive, nothing is queued.
  if (state.archiveMode) {
    state.archiveMode = false;
    if (card) { send({ kind: 'archive', slot: key }); uilog('archive-mark', { detail: card.card_id }); }
    renderDeck();
    return;
  }
  if (inBonusPlan(card)) { logUI('that card is already committed to a bonus round', 'phase'); return; }
  if (isEffect(card)) {
    const first = state.queuedEffect !== null ? state.hand[state.queuedEffect] : null;
    // Blessing held and clicked: this card goes under it (replaces the old one).
    if (state.blessMode) {
      state.blessMode = false;
      if (card.takes_attach) { logUI('a Blessing cannot hold another Blessing / trap layer', 'phase'); renderDeck(); return; }
      send({ kind: 'rebless', slot: key }); uilog('rebless', { detail: card.card_id });
      logUI(`📎 ${card.name} goes under the Blessing`, 'phase');
      renderDeck(); return;
    }
    // The queued cast takes a second effect card (Traps Mastery / Space Bending lay it as the trap,
    // Blessing keeps it): a different effect clicked rides along instead of replacing the pick.
    if (first && first.takes_attach && key !== state.queuedEffect && first.effect_id !== card.effect_id && !chainable(card)) {
      send({ kind: 'attach', slot: key }); uilog('attach', { detail: card.card_id });
      logUI(state.queuedAttach === key ? `${card.name} detached` : `📎 ${card.name} rides on ${first.name}`, 'phase');
      renderDeck(); return;
    }
    // Rule 19: an effect is cast on a Posture. Toggle it; when it does not fit
    // the current pick, pull a Posture card (or the Empty slot) into the queue.
    if (state.casting?.card_ids && !state.casting.card_ids.includes(card.card_id) && !chainable(card) && !state.queuedChain.includes(key)) { logUI('finish the cast first — only an effect sharing the element going out can join it', 'phase'); return; }
    if (state.queuedEffect === key) { state.queuedEffect = state.queuedEffect2; state.queuedEffect2 = null; state.queuedChain = []; }
    else if (state.queuedEffect2 === key) state.queuedEffect2 = null;
    else if (state.queuedChain.includes(key)) state.queuedChain = state.queuedChain.slice(0, state.queuedChain.indexOf(key));   // drop this link and what follows
    else {
      // Rule 23 ∀: a second copy of the queued effect joins it as a double cast.
      // Rule 22: an effect whose first element is the tail's last one chains on.
      const doubling = !!first && first.effect_id === card.effect_id && state.queuedChain.length === 0 && !state.casting;
      const linking = !doubling && chainable(card);
      if (tranceActive()) { state.queuedSkills = state.queuedSkills.filter(i => !isTrance(state.hand[i])); state.queuedExtra = null; }
      if (!effectMatchesQueue(card, doubling, linking)) {
        const idx = firstActionIdx('P');
        state.queued = [idx >= 0 ? idx : 'EMPTY'];
        state.queuedSkills = [];
        state.queuedExtra = null;
      }
      if (doubling) state.queuedEffect2 = key;
      else if (linking) state.queuedChain.push(key);
      else { state.queuedEffect = key; state.queuedEffect2 = null; state.queuedChain = []; }
    }
    state.queuedIsAuto = false;
    cancelPathJourney('manual pick');
    sendQueue();
    renderDeck();
    return;
  }
  if (isSkill(card)) {
    // Rule 17: a skill rides on a matching action card. Toggle it on/off and
    // pull the first matching action into the queue when needed.
    if (!skillUsable(card)) {
      logUI(`${card.name} needs ${isTrance(card) ? 'an action' : ACTION_SHORT[card.requires] || card.requires} card in hand`, 'phase');
      return;
    }
    if (state.queuedSkills.includes(key)) {
      state.queuedSkills = state.queuedSkills.filter(i => i !== key);
      if (isTrance(card)) state.queuedExtra = null;
    } else if (isTrance(card)) {
      if (queuedActionCode() === null) { state.queued = [firstActionIdx('*')]; state.queuedSkills = []; }
      state.queuedSkills.push(key);
    } else {
      if (!skillMatchesQueue(card)) {
        const idx = firstActionIdx(card.requires);
        state.queued = [idx >= 0 ? idx : 'EMPTY'];
        state.queuedSkills = [];
        state.queuedExtra = null;
      }
      state.queuedSkills.push(key);
    }
    state.queuedIsAuto = false;
    cancelPathJourney('manual pick');
    sendQueue();
    renderDeck();
    return;
  }
  if (tranceActive()) {
    // Battle Trance: the primary stays put; other action cards toggle as the
    // second option, Empty means "second option is EP".
    if (key === 'EMPTY') state.queuedExtra = null;
    else if (state.queuedExtra === key) state.queuedExtra = null;
    else if (state.queued[0] === key) {
      if (state.queuedExtra !== null) { state.queued = [state.queuedExtra]; state.queuedExtra = null; }
      else { state.queued = []; state.queuedSkills = []; state.queuedExtra = null; }
    } else state.queuedExtra = key;
    state.queuedIsAuto = false;
    cancelPathJourney('manual pick');
    sendQueue();
    renderDeck();
    return;
  }
  if (castLocksOut(card)) {
    const eff = state.queuedEffect !== null ? state.hand[state.queuedEffect] : null;
    logUI(state.lostActions > 0 ? `you sit this action out (${state.lostActions} left)` : `${(eff || state.casting)?.name || 'the effect'} is being cast — only Posture${isReaver() ? ', Attack' : ''}${isMonk() ? ', Move' : ''} or Empty Posture until it lands (moving interrupts it)`, 'phase');
    return;
  }
  // Single-action-per-turn (Rule 1 + Rule 7). Clicking the already-queued slot
  // unqueues it (so you can commit nothing → defaults to EP server-side);
  // clicking a different slot replaces the pick.
  if (state.queued[0] === key) {
    state.queued = [];
    state.queuedSkills = [];
  } else {
    // Switching to Empty keeps Move/Posture skills riding along (pruneQueuedSkills drops the rest).
    state.queued = [key];
  }
  state.queuedIsAuto = false;
  // Picking any slot by hand means the player is taking the wheel — stop the
  // auto-walker so a right-clicked destination doesn't fight the pick.
  cancelPathJourney('manual pick');
  sendQueue();
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
  wireArchive();
  window.addEventListener('keydown', (ev) => {
    uilog('keydown', { key: ev.key || ev.code });
    if (ev.key === 'Escape') {
      const peek = document.getElementById('peek-popup');
      if (peek && !peek.hidden) { peek.hidden = true; return; }
      if (state.blessMode || state.phylacteryMode) { state.blessMode = false; state.phylacteryMode = false; renderPerms(); renderRoster(); return; }
      if (!document.getElementById('archive-popup')?.hidden) openArchive(false); else if (state.archiveMode) { state.archiveMode = false; renderDeck(); }
      return;
    }
    if (ev.key >= '1' && ev.key <= '7') queueSlot(Number(ev.key) - 1);
    else if (ev.key === '8') queueSlot('EMPTY');
    else if (ev.key === '9' || ev.key === '0') clickPermanentKey(ev.key === '9' ? 0 : 1);
    else if (ev.code === 'Space') { ev.preventDefault(); if (state.bonusMode) commitBonus(); else if (state.queued.length) { state.locked = true; send({ kind: 'lock' }); logUI('commit locked (early)', 'phase'); renderDeck(); } }
    else if (ev.key === '-' || ev.key === '=') clickPermanentKey(ev.key === '-' ? 2 : 3);
    else if (ev.key === 'c' || ev.key === 'C') renderer.recentre();
    else if (ev.key === 'q' || ev.key === 'Q') clickClassCard();   // my class ability (user ruling 2026-10-30)
  });

  const canvas = document.getElementById('stage');
  // Test hook (tools/ui-check.mjs): the canvas chip text is not in the DOM.
  window.__chaosDebug = () => ({ queuedLabel: queuedLabel(), badges: { ...(state.ui.revealBadges || {}) }, icons: state.ui.floatingIcons.map(f => f.skill || f.action) });

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
          revealBadge: state.ui.revealBadges?.[p.peer_id] || null,
          lostActions: p.lost_actions || 0,
        };
      });
    },
    ui: state.ui,
    get tileTokens() {
      const out = [];
      for (const p of state.entities) { try { for (const t of JSON.parse(p.tile_tokens_json || '[]')) out.push({ ...t, owner: p.peer_id, alliance: p.alliance }); } catch {} }
      out.push(...worldFeatures());
      return out;
    },
    // Obstacles (Creation walls) from everyone's snapshot; traps only as I may know them:
    // my own, and the ones Super Sense shows me around my tile.
    get obstacles() {
      const out = [];
      for (const p of state.entities) { try { for (const o of JSON.parse(p.obstacles_json || '[]')) out.push({ ...o, owner: p.peer_id, alliance: p.alliance }); } catch {} }
      return out;
    },
    get traps() {
      const me = state.entities.find(p => p.peer_id === state.myPeerId);
      const out = [];
      try { for (const t of JSON.parse(me?.traps_json || '[]')) out.push({ ...t, mine: true }); } catch {}
      for (const t of state.sensedTraps || []) out.push({ ...t, mine: false });
      return out;
    },
    get map() { return state.map; },
    get mapVersion() { return state.mapVersion; },
    get myPeerId() { return state.myPeerId; },
  });
  canvas.addEventListener('mousemove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    state.ui.hoverTile = renderer.pickHex(ev.clientX - rect.left, ev.clientY - rect.top, knownHex);
  });
  // Pick the entity closest to the click if it's within one hex radius. The
  // comparison runs in world pixels (camera-independent). Using pixel distance
  // (not tile-equality) is more forgiving than requiring a bull's-eye on the
  // tile center, and handles the case where the entity sprite overlaps the edge.
  function entityAtPixel(px, py) {
    const w = renderer.toWorld(px, py);
    let best = null, bestD2 = HEX_SIZE_SQ_HIT;
    for (const p of state.entities) {
      if (!p || p.life <= 0) continue;
      if (!Number.isInteger(p.tile_q) || !Number.isInteger(p.tile_r)) continue;
      const pos = renderer.tilePx(p.tile_q, p.tile_r);
      const dx = w.x - pos.x;
      const dy = w.y - (pos.y - 6);  // renderer draws the body offset -6
      const d2 = dx * dx + dy * dy;
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
    // general_ux_range_cast_target: with a tile-taking effect queued (Teleport, Creation, Awake, Vision,
    // Artifice, Metaphysics, Disruption, Mind Blast) the left-clicked tile is the cast's target.
    const qe = state.queuedEffect !== null ? state.hand[state.queuedEffect] : null;
    const me = state.entities.find(p => p.peer_id === state.myPeerId);
    const enemyClicked = !!occupant && occupant.peer_id !== state.myPeerId && !!me && (occupant.alliance === 'npc_b') !== (me.alliance === 'npc_b');
    if (qe?.tile_target && !(enemyClicked && qe.scope === 'target')) {
      state.target = { q: t.q, r: t.r };
      logUI(`${qe.name} → tile (${t.q},${t.r})`, 'phase');
      send({ kind: 'target', target: state.target });
      renderDeck();
      return;
    }
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
      const eff = state.queuedEffect !== null ? state.hand[state.queuedEffect] : null;
      const counter = state.queuedSkills.some(i => state.hand[i]?.skill_id === 'skill_counter_spell');
      label = eff || counter
        ? `${eff ? eff.name : 'Counter spell'} → ${occupant.name} (on ${queuedCode || 'EP'})`
        : `target → ${occupant.name} (keeping ${queuedCode || 'EP'})`;
      send({ kind: 'target', target: state.target });
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
        sendQueue();
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
        sendQueue();
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
    renderPerms();
    renderDeck();
    renderer.render();
    requestAnimationFrame(raf);
  }
  raf();
}

wireInput();
