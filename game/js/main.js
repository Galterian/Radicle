// Thin browser client — connects to peer:player-1 over WebSocket and renders
// the state the peer gossips. All simulation (libp2p mesh, Gun graph,
// hashgraph envelopes, resolver, radicle lottery) runs in the peer processes.

import { createRenderer } from './renderer.js';
import { hexDistance, stepToward, findPath } from './hex.js';
import { createKnownMap, initialBlock } from './map.js';
import { createSoundBank, resourcesFor, loadResources, assetUrl, onAssetsChanged } from './sprites.js';
import { featureAt } from './features.js';
import { scatterAt } from './scatter.js';
import { ACTION_HELP, KIND_DESC, abbreviate } from './rules_text.js';
import { makeSkillIcon, fillSkillCardStack } from './skill_card.js';

// Large multi-hex landmarks live in bigfeature.js, which another workstream is
// still landing. Pull it in defensively: when the module (or its export) is
// missing the object lookup simply skips that layer.
let bigFeatureAt = null;
import('./bigfeature.js').then(m => { if (typeof m?.bigFeatureAt === 'function') bigFeatureAt = m.bigFeatureAt; }).catch(() => { /* not landed yet */ });

// Per-entry purpose text from the feature catalog (`desc` is being added to
// assets/features/feature_table.json). featureAt() does not pass it through,
// so read the table once more here and key it by entry id; until the catalog
// carries descriptions KIND_DESC supplies a generic line per kind.
const featureDescById = new Map();
for (const url of ['/assets/features/feature_table.json', '/assets/terrain_bigfeatures/bigfeature_table.json', '/assets/terrain_scatter/scatter_table.json']) {
  fetch(url).then(r => r.ok ? r.json() : null).then(j => {
    const lists = [...Object.values(j?.by_biome || {}), j?.items].filter(Array.isArray);
    for (const list of lists) for (const c of list) {
      if (c && typeof c.desc === 'string' && c.desc.trim()) featureDescById.set(c.id || c.label, c.desc.trim());
    }
  }).catch(() => { /* table missing — generic kind text only */ });
}

// Skill rule text by skill id, straight from data/skills.json
// (entries[].versions[0].data.text). Hand cards normally carry `text` already;
// this is the fallback for peers that predate that field.
const skillTextById = new Map();
fetch('/data/skills.json').then(r => r.ok ? r.json() : null).then(j => {
  for (const e of j?.entries || []) {
    const t = e?.versions?.[0]?.data?.text;
    if (e?.id && typeof t === 'string') skillTextById.set(e.id, t);
  }
}).catch(() => { /* no skills catalog */ });

const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  bonusMode: false,   // picking bonus rounds (Haste: one; Balefire: three) before the normal action
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
  ui: { hoverTile: null, selectedTarget: null, destinationTile: null, pathPlan: null, logFilterPeerId: null, floatingDmgs: [], floatingIcons: [], coldSyncUntil: 0, showCoords: false, hoverPeerId: null, objectCard: null },
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
const myWorldStat = () => { const me = state.entities.find(p => p.peer_id === state.myPeerId); return Math.max(1, Number(me?.stat_world ?? me?.stats?.world) || 10); };
const summonLength = (card) => Math.max(1, Math.ceil((card.summon?.need || 30) / myWorldStat()));
const castLength = (card, every) => castInstant(card, every) ? 1 : (card.summon ? summonLength(card) : Math.max(1, card.element_cost.length)) + (every ? 1 : 0);
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
      const help = ACTION_HELP[emptyIsSecond ? 'EP' : code];
      cardDiv.innerHTML = `<div class="nm">Empty${code === 'EM' ? ' Move' : ' Posture'}</div><div class="ds">${escHtml(help?.card || '')}</div><div class="cd">${emptyIsSecond ? '2nd · EP' : code === 'EM' ? 'move' : sanct ? '⛩ sanctuary' : 'posture'}${n ? ` +${n}✦` : ''}</div>`;
      slot.title = (sanct ? 'Sanctuary: you take no damage while you rest in Empty Posture; any other action or skill ends it\n\n' : '') + (help?.full || '');
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
      const tag = link >= 0 ? `⛓ ${link + 2}nd` : dbl ? 'double' : kindTag;
      const sm = card.summon ? ` · 🐾 ${card.summon.bind ? 'bind ' : ''}${card.summon.name} Σ${card.summon.need}` : '';
      cardDiv.innerHTML = `<div class="nm">${dbl ? '∀ ' : ''}${state.withAura && effectQueued ? '◎ ' : ''}✺ ${card.name}</div><div class="cd">${elemGlyphs(card.element_cost)} · ${castInstant(card, dbl) ? 'instant' : len > 1 ? `${len} postures` : 'posture'} · ${tag}${prog}${sm}</div>`;
      if (twin) slot.title = `${card.text || card.name}\n\nYou hold two: pick both to cast them together (Rule 23 ∀)`;
      else if (canChain) slot.title = `${card.text || card.name}\n\nChains onto ${chainTail().name}: its ${elemGlyphs(card.element_cost.slice(0, 1))} is emitted once for both (Rule 22)`;
      else slot.title = card.text || card.name;
    } else if (skill) {
      const band = isTrance(card) ? 'P' : card.requires;
      slot.dataset.code = band;
      cardDiv.dataset.code = band;
      const needs = isTrance(card) ? 'any action' : ridesOnEmpty(card) ? `${ACTION_SHORT[card.requires]} / Empty` : (ACTION_SHORT[card.requires] || card.requires);
      // Rule text on the card itself (data/skills.json text, ≤70 chars); the
      // full sentence stays in the tooltip.
      const text = card.text || skillTextById.get(card.skill_id) || (isTrance(card) ? ACTION_HELP.BT.full : '');
      // Build the card as DOM so the icon canvas can live inside it — the
      // skill-card icon shows the real effect sprite (frame 0) when a skill's
      // resources.sprites.icon or .effect is mapped, otherwise the unicode
      // glyph. slot .ds carries the short rule; the full line stays in title.
      cardDiv.innerHTML = `
        <div class="nm" title="${escHtml(card.name)}">✦ ${escHtml(card.name)}</div>
        <div class="skill-slot-icon"></div>
        <div class="ds">${escHtml(abbreviate(text, 70))}</div>
        <div class="cd">needs ${escHtml(needs)}${card.is_permanent ? ' · perm' : ''}${isTrance(card) && skillQueued ? ' · ×2' : ''}</div>`;
      const iconMount = cardDiv.querySelector('.skill-slot-icon');
      if (iconMount) iconMount.appendChild(makeSkillIcon(card.skill_id, { size: 28, title: card.name }));
      slot.title = text || card.name;
    } else if (card) {
      const code = card.code;
      slot.dataset.code = code;
      cardDiv.dataset.code = code;
      const short = ACTION_SHORT[code] || card.action_name || code;
      const n = state.queued[0] === i ? state.queuedSkills.length : 0;
      const help = ACTION_HELP[code];
      cardDiv.innerHTML = `<div class="nm">${escHtml(short)}</div><div class="ds">${escHtml(help?.card || '')}</div><div class="cd">${isExtra ? '2nd · ' : ''}${card.card_id.slice(-5)}${n ? ` +${n}✦` : ''}</div>`;
      slot.title = help?.full || '';
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
    const creature = c.kind === 'creature';
    const nm = creature ? `🐾 ${c.name}` : isEffect(c) ? `✺ ${c.name}` : isSkill(c) ? `✦ ${c.name}` : (ACTION_SHORT[c.code] || c.action_name || c.name || c.code);
    const cd = creature ? `creature · Σ${c.stat_sum ?? ''} · summonable` : isEffect(c) ? elemGlyphs(c.element_cost) : isSkill(c) ? `needs ${isTrance(c) ? 'any' : ACTION_SHORT[c.requires] || c.requires}` : c.card_id.slice(-5);
    return `<div class="ac${creature ? ' creature' : ''}" data-id="${c.card_id}" title="${(c.text || c.name || '').replace(/"/g, '&quot;')}"><div class="nm">${nm}</div><div class="cd">${cd}</div></div>`;
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
    const perms = allPerms.filter(s => !s.startsWith('class_')).map(s => `${s.replace(/^(skill|effect)_/, '').replace(/_/g, ' ')}${permPower[s] ? ` ⚄${permPower[s]}` : ''}`);
    const mine = e.peer_id === state.myPeerId;
    const pill = (cls, key, label, flat) => {
      const on = mine && state.destroy?.stat === key;
      const title = mine ? `${label} — click to emit ${label} against the closest enemy's ${label} tokens (Rule 24)` : label;
      return `<span class="pill ${cls}${mine ? ' clickable' : ''}${on ? ' active' : ''}" data-stat="${key}" title="${title}">${on ? '⚒ ' : ''}${label[0] === 'W' && label.length > 5 ? 'Wi' : label[0]} ${stat(flat, key)}</span>`;
    };
    const permIds = (e.permanents_csv || '').split(',').filter(Boolean);
    const headQR = `(${e.tile_q ?? e.tile?.q},${e.tile_r ?? e.tile?.r})`;
    row.innerHTML = `${thumb}<span class="txt"><span class="nm">${escHtml(e.name)}</span>
      <span class="st">${escHtml(srcTag)} · hp ${e.life}/${e.life_max || e.lifeMax} · ${headQR}${escHtml(tier)}</span>
      <span class="stats">
        ${pill('v', 'vitality', 'Vitality', 'stat_vitality')}
        ${pill('w', 'world', 'World', 'stat_world')}
        ${pill('m', 'matter', 'Matter', 'stat_matter')}
        ${pill('wi', 'will', 'Will', 'stat_will')}
        ${cls ? `<span class="pill cls" title="class">⚜ ${cls.replace(/^class_/, '').replace(/_/g, ' ')}</span>` : ''}
        ${lost}${countered.length ? `<span class="pill perm" title="countered this turn">✨ ${countered.join(', ')}</span>` : ''}
      </span>
      ${permIds.length ? '<div class="perm-cards" data-count="' + permIds.length + '"></div>' : ''}
      </span>`;
    // Build the permanents stack as real SkillCard DOM, not innerHTML strings
    // — the icon canvas has to be a live node so the sprite paints into it.
    if (permIds.length) {
      const stack = row.querySelector('.perm-cards');
      // Over three permanents: default-collapse into a chevron that expands
      // in place. Keeps the roster scannable while still a click away from
      // the full stack.
      const collapsed = permIds.length > 3;
      if (collapsed) stack.classList.add('collapsed');
      fillSkillCardStack(stack, permIds, { variant: 'strip', badge: 'perm' });
      if (collapsed) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'perm-toggle';
        toggle.textContent = `+${permIds.length - 2} more…`;
        toggle.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const isOpen = stack.classList.toggle('open');
          toggle.textContent = isOpen ? 'collapse' : `+${permIds.length - 2} more…`;
        });
        stack.appendChild(toggle);
      }
    }
    // Clicking a roster row toggles the log filter on that peer; clicking one
    // of MY stat pills queues a Rule 24 emission with that stat instead.
    row.addEventListener('click', (ev) => {
      // Skill cards inside this row shouldn't toggle the log filter when the
      // user is reading one — only the empty region / name counts.
      if (ev.target.closest('.skill-card') || ev.target.closest('.perm-toggle')) return;
      const pillEl = ev.target.closest('.pill.clickable');
      if (pillEl && mine) {
        ev.stopPropagation();
        if (state.locked) return;
        uilog('destroy', { detail: pillEl.dataset.stat });
        send({ kind: 'destroy', stat: pillEl.dataset.stat });
        cancelPathJourney('manual pick');
        return;
      }
      setLogFilter(activeFilter === e.peer_id ? null : e.peer_id);
    });
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
// Shared stat line builder — same shape as the roster row so the two surfaces
// render identical pills.
function statPillsHtml(e) {
  const stat = (flat, key) => {
    const v = e[flat] ?? e.stats?.[key];
    return Number.isFinite(v) ? v : '—';
  };
  return `
    <span class="pill v"  title="Vitality">V ${stat('stat_vitality', 'vitality')}</span>
    <span class="pill w"  title="World">W ${stat('stat_world', 'world')}</span>
    <span class="pill m"  title="Matter">M ${stat('stat_matter', 'matter')}</span>
    <span class="pill wi" title="Will">Wi ${stat('stat_will', 'will')}</span>`;
}

// Floating skill-card overlay above revealing units. Mirrors the canvas-side
// floating-icon strip but as full DOM cards — same clock, same actors. Pure
// view: it reads state.ui.revealBadges / state.entities and renders into a
// fixed overlay layer; it never mutates game state.
let _revealEls = new Map();   // peerId -> HTMLElement
function renderRevealOverlay() {
  const layer = document.getElementById('skill-reveal-layer');
  const canvas = document.getElementById('stage');
  if (!layer || !canvas || !rendererRef) return;
  const now = performance.now();
  const badges = state.ui.revealBadges || {};
  const rect = canvas.getBoundingClientRect();
  const z = rendererRef.zoom();
  const origin = rendererRef.toWorld(0, 0);

  const liveIds = new Set();
  for (const [pid, badge] of Object.entries(badges)) {
    if (!badge) continue;
    const t = (now - badge.startAt) / badge.duration;
    if (t >= 1) continue;
    const e = state.entities.find(x => x.peer_id === pid);
    if (!e || !Number.isInteger(e.tile_q) || !Number.isInteger(e.tile_r)) continue;
    liveIds.add(pid);

    // Build only once per reveal; animate opacity + rise via CSS variable.
    let el = _revealEls.get(pid);
    if (!el || el.dataset.startAt !== String(badge.startAt)) {
      if (el) el.remove();
      el = document.createElement('div');
      el.className = 'reveal-overlay';
      el.dataset.peerId = pid;
      el.dataset.startAt = String(badge.startAt);
      // Chip row at the top: "[EM + A + ✦BT + ✦Po]" — matches the canvas text.
      const chip = document.createElement('div');
      chip.className = 'reveal-chip';
      chip.classList.toggle('self', pid === state.myPeerId);
      chip.classList.toggle('enemy', e.alliance === 'npc_b');
      chip.textContent = `[${badge.text}]`;
      el.appendChild(chip);
      if (Array.isArray(badge.skills) && badge.skills.length) {
        const stack = document.createElement('div');
        stack.className = 'reveal-skill-stack';
        fillSkillCardStack(stack, badge.skills, { variant: 'reveal' });
        el.appendChild(stack);
      }
      layer.appendChild(el);
      _revealEls.set(pid, el);
    }

    // Fade + rise on the badge's own clock. Only drive opacity + translate —
    // the DOM contents don't change frame to frame.
    const alpha = t < 0.75 ? 1 : Math.max(0, 1 - (t - 0.75) / 0.25);
    const rise = 10 * t;
    const w = rendererRef.tilePx(e.tile_q, e.tile_r);
    const cx = (w.x - origin.x) * z + rect.left;
    const cy = (w.y - origin.y) * z + rect.top;
    el.style.opacity = String(alpha);
    el.style.transform = `translate(-50%, calc(-100% - ${rise}px))`;
    el.style.left = `${cx}px`;
    el.style.top = `${cy - 72}px`;
  }
  // Drop overlays whose badge has expired or whose entity vanished.
  for (const [pid, el] of _revealEls) {
    if (!liveIds.has(pid)) { el.remove(); _revealEls.delete(pid); }
  }
}

// Rebuilding the hover card innerHTML every mousemove would thrash the DOM;
// instead, re-render on identity + state changes only, and let the mouse move
// just reposition. The key is `pid|objKey|life|perms|hand`.
let _hoverCardKey = null;
function renderHoverCard(clientX, clientY) {
  const card = document.getElementById('hover-card');
  if (!card) return;
  const pid = state.ui.hoverPeerId;
  const p = pid ? state.entities.find(e => e.peer_id === pid) : null;
  const res = p ? resOf(p) : null;
  // No unit under the cursor: fall back to a one-line card for whatever map
  // object sits on the hovered hex (building / landmark / scatter).
  const obj = !p && state.ui.hoverTile ? objectAt(state.ui.hoverTile.q, state.ui.hoverTile.r) : null;
  // The detail card already shows this object — no one-liner on top of it.
  const detailOpen = obj && state.ui.objectCard && state.ui.objectCard.q === obj.q && state.ui.objectCard.r === obj.r;
  if ((!p && !obj) || detailOpen) { card.hidden = true; _hoverCardKey = null; return; }
  card.hidden = false;
  card.classList.toggle('object', !!obj);
  card.classList.toggle('unit', !!p);
  // Rebuild innerHTML on identity change so the detail section fits whatever
  // caller is active (unit vs. object). The hover card re-mounts on every
  // mousemove; keeping it DOM-light avoids layout churn — plus the key below
  // skips the rebuild when nothing material has changed.
  const key = p
    ? `U:${p.peer_id}|${p.life}/${p.life_max}|${p.permanents_csv || ''}|${p.peer_id === state.myPeerId ? state.hand.filter(c=>isSkill(c)).map(c=>c.card_id).join(',') : ''}`
    : `O:${obj.q},${obj.r}|${obj.id || obj.label || obj.kind}`;
  const dirty = key !== _hoverCardKey;
  _hoverCardKey = key;
  if (dirty && p) {
    const sub = res ? `${res._entryName || ''}${res.wbc3_name ? ' · ' + res.wbc3_name : ''}${res.wbc3_race ? ' (' + res.wbc3_race + ')' : ''}` : (p.source_id || '');
    const srcPath = res?.sprites?.info?.path || res?.portrait?.path || '';
    const src = srcPath ? assetUrl(srcPath) : '';
    const tier = p.tier && p.tier !== 'self' ? (p.tier === 'strong' ? 'in contact' : p.tier) : '';
    const permIds = String(p.permanents_csv || '').split(',').filter(Boolean);
    // Only our own hand is public; show held skills for the self card only.
    const isSelf = p.peer_id === state.myPeerId;
    const heldSkillIds = isSelf ? state.hand.filter(c => isSkill(c)).map(c => c.skill_id) : [];
    card.innerHTML = `
      <div class="hc-head">
        ${src ? `<img class="hc-thumb" src="${escHtml(src)}" alt="">` : ''}
        <div class="hc-meta">
          <div class="hc-name">${escHtml(p.name)}</div>
          <div class="hc-sub">${escHtml(sub)}</div>
          <div class="hc-hp">hp ${p.life}/${p.life_max} · ${escHtml(p.alliance || '')}${p.life <= 0 ? ' · dead' : ''}${tier ? ' · ' + escHtml(tier) : ''}</div>
          <div class="hc-coords">(${p.tile_q ?? '—'}, ${p.tile_r ?? '—'})</div>
        </div>
      </div>
      <div class="hc-stats">${statPillsHtml(p)}</div>
      ${permIds.length ? `<div class="hc-section-head">permanents</div><div class="hc-perms"></div>` : ''}
      ${heldSkillIds.length ? `<div class="hc-section-head">skills in hand</div><div class="hc-skills"></div>` : ''}
    `;
    const permWrap = card.querySelector('.hc-perms');
    if (permWrap) fillSkillCardStack(permWrap, permIds, { variant: 'tooltip', badge: 'perm' });
    const skillWrap = card.querySelector('.hc-skills');
    if (skillWrap) fillSkillCardStack(skillWrap, heldSkillIds, { variant: 'tooltip' });
  } else if (dirty && obj) {
    const src = obj ? assetUrl(obj.path) : '';
    card.innerHTML = `
      <div class="hc-head">
        ${src ? `<img class="hc-thumb hc-thumb-obj" src="${escHtml(src)}" alt="">` : ''}
        <div class="hc-meta">
          <div class="hc-name">${escHtml(obj.label || obj.kind)}</div>
          <div class="hc-sub">${escHtml(obj.kind)}${obj.biome ? ' · ' + escHtml(obj.biome) : ''} · (${obj.q},${obj.r})</div>
          <div class="hc-hp">${escHtml(abbreviate(obj.desc, 160))}</div>
          <div class="hc-coords">click for details</div>
        </div>
      </div>`;
  }
  if (Number.isFinite(clientX)) {
    // Fit the card alongside the cursor, flipping to the other side if the
    // natural placement would clip the viewport.
    const w = card.offsetWidth || 240, h = card.offsetHeight || 140;
    const preferRight = clientX + 24 + w <= window.innerWidth - 8;
    const left = preferRight ? clientX + 16 : clientX - 16 - w;
    const top = Math.max(8, Math.min(window.innerHeight - h - 8, clientY - h / 2));
    card.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, left))}px`;
    card.style.top = `${top}px`;
  }
}

// --- map objects: what is on a hex and what it is for ---------------------
// Layers in priority order: big landmark → building/permanent → scatter. Each
// placer is a pure function of (dim seed, q, r); the catalogs load lazily, so
// a hex can briefly report "nothing" right after connect. Returns
// {label, kind, path, id, biome, desc, q, r} or null.
function objectAt(q, r) {
  if (!Number.isInteger(q) || !Number.isInteger(r) || !state.map.has(q, r)) return null;
  const seed = state.map.seed;
  let o = null;
  if (bigFeatureAt) { try { o = bigFeatureAt(seed, q, r); } catch { o = null; } if (o && !o.kind) o = { ...o, kind: 'bigfeature' }; }
  if (!o) o = featureAt(seed, q, r);
  if (!o) o = scatterAt(seed, q, r);
  if (!o) return null;
  const kind = o.kind || 'building';
  const desc = (typeof o.desc === 'string' && o.desc.trim()) || featureDescById.get(o.id) || featureDescById.get(o.label)
    || KIND_DESC[kind] || KIND_DESC.building;
  return { ...o, kind, desc, q, r };
}

function showObjectCard(obj, clientX, clientY) {
  const card = document.getElementById('object-card');
  if (!card || !obj) return;
  const img = card.querySelector('img');
  const src = assetUrl(obj.path) || '';
  if (img.getAttribute('src') !== src) img.src = src;
  img.hidden = !src;
  img.alt = obj.label || obj.kind;
  card.querySelector('.oc-name').textContent = obj.label || obj.kind;
  card.querySelector('.oc-kind').textContent = `${obj.kind}${obj.family ? ` · ${obj.family}` : ''}${obj.biome ? ` · ${obj.biome}` : ''}`;
  card.querySelector('.oc-desc').textContent = obj.desc;
  card.querySelector('.oc-coords').textContent = `hex (${obj.q}, ${obj.r})${obj.id && obj.id !== obj.label ? ` · ${obj.id}` : ''}`;
  card.hidden = false;
  state.ui.objectCard = { q: obj.q, r: obj.r };
  // Place beside the click, clamped to the viewport.
  const w = card.offsetWidth || 300, h = card.offsetHeight || 140;
  const x = Number.isFinite(clientX) ? clientX + 18 : window.innerWidth / 2 - w / 2;
  const y = Number.isFinite(clientY) ? clientY - 24 : window.innerHeight / 2 - h / 2;
  card.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x))}px`;
  card.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, y))}px`;
  // The hover one-liner would sit on top of the detail card — drop it.
  const hc = document.getElementById('hover-card');
  if (hc) hc.hidden = true;
}
function hideObjectCard() {
  const card = document.getElementById('object-card');
  if (card && !card.hidden) card.hidden = true;
  state.ui.objectCard = null;
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
    action: id === 'effect_aura' && every.has(id) ? 'aura' : id === 'effect_haste' ? 'bonus' : null,
  })).concat(state.bonus?.balefire ? [{ id: 'balefire_charge', name: 'balefire ×3', die: 0, every: false, action: 'bonus', virtual: true }] : []);
}
let lastPermsHtml = '';
function renderPerms() {
  const el = document.getElementById('perms');
  if (!el) return;
  const perms = myPermCards();
  const KEYS = ['9', '0', '-', '='];
  let ki = 0;   // keys go to permanents with an ability only (a Summoning has none)
  const html = perms.map((p, k) => {
    const plans = state.bonus?.plans || [];
    const key = p.action ? KEYS[ki++] : null;
    const active = (p.action === 'aura' && state.withAura) || (p.action === 'bonus' && (state.bonusMode || plans.length > 0));
    const title = p.action === 'aura' ? `Aura ∀ — cast the queued effect on everyone within 10 hexes; the Aura is spent (key ${key || '·'})`
      : p.action === 'bonus' ? `Bonus rounds (${state.bonus?.max || 0}) — pick an action, skills and an effect, Space commits each; they resolve first, alone, against everyone's Empty Posture; then pick your normal action (key ${key || '·'})`
      : p.id === 'effect_summoning' ? `Summoning (6) — holds ${mySummoned()?.name || 'your creature'}; an enemy needs a 6 to destroy it, then the creature vanishes and its card goes to your archive`
      : p.name;
    const cd = p.action === 'bonus' && plans.length ? `⚡ ${plans.map(b => b.action).join('▸')}` : p.action === 'bonus' && state.bonusMode ? `⚡ pick ${plans.length + 1}/${state.bonus?.max || 1}` : p.die ? `⚄${p.die}` : 'perm';
    return `<div class="perm${p.action ? ' clickable' : ''}${active ? ' active' : ''}" data-k="${k}" title="${title}">${key ? `<div class="k">${key}</div>` : ''}<div class="nm">${p.every ? '∀ ' : ''}${p.id === 'effect_summoning' ? '🐾 ' : ''}${p.name}</div><div class="cd">${cd}</div></div>`;
  }).join('');
  if (html === lastPermsHtml) return;
  lastPermsHtml = html;
  el.innerHTML = html;
  el.hidden = perms.length === 0;
  el.querySelectorAll('.perm.clickable').forEach(d => d.addEventListener('click', () => clickPermanent(Number(d.dataset.k))));
}
// The creature my Summoning holds, as the roster knows it.
function mySummoned() {
  const me = state.entities.find(p => p.peer_id === state.myPeerId);
  return me?.summoned_peer_id ? state.entities.find(p => p.peer_id === me.summoned_peer_id) || { name: me.summoned_peer_id } : null;
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
          state._animAction ||= new Set();
          state.ui.revealBadges ||= {};
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
            const ak = `${env.turn}:${env.round}:${a.actor}${a.bonus ? `:bonus${a.bonus_k || 0}` : ''}`;
            if (state._loggedAction.has(ak)) continue;
            state._loggedAction.add(ak);
            const at0 = performance.now() + (a.bonus ? (a.bonus_k || 0) * 1400 : seqDelay);
            // Every revealer (heroes and monsters) gets the composed chip over
            // its head — `[EM + A + ✦BT + ✦Po]` — fading on the icon's clock.
            // A bonus round shows as `⚡ A ▸ P` once the normal action follows it.
            // The payload also carries the raw skill ids so the DOM reveal
            // overlay can pop a SkillCard per skill (icon + full description).
            const prevBadge = state.ui.revealBadges[a.actor];
            const chained = !a.bonus && prevBadge?.bonusKey === `${env.turn}:${env.round}`;
            const chainedBonus = a.bonus && prevBadge?.bonusKey === `${env.turn}:${env.round}`;
            state.ui.revealBadges[a.actor] = {
              text: chained || chainedBonus ? `${prevBadge.text} ▸ ${composeLabel(a)}` : `${a.bonus ? '⚡ ' : ''}${composeLabel(a)}`,
              skills: (a.skills || []).filter(id => id && id !== 'skill_battle_trance'),
              trance: Array.isArray(a.trance) ? a.trance.slice() : null,
              action: a.action,
              startAt: performance.now(),
              duration: 2200 + (a.bonus ? (a.bonus_k || 0) * 1400 : seqDelay),
              bonusKey: a.bonus ? `${env.turn}:${env.round}` : null,
            };
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
            // Each revealed skill plays its mapped WBC3 fx sound (data/skills.json
            // resources.sounds.fx) — one shot per skill, the bank throttles repeats.
            for (const id of a.skills || []) sounds.play(resourcesFor(id), 'fx', { volume: 0.55 });
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
    // Rule 19: an effect is cast on a Posture. Toggle it; when it does not fit
    // the current pick, pull a Posture card (or the Empty slot) into the queue.
    const first = state.queuedEffect !== null ? state.hand[state.queuedEffect] : null;
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
  // Object info card: ✕ button, Esc, or any click outside it (the canvas
  // click handler below decides for itself — it re-opens on another object).
  const objectCardEl = document.getElementById('object-card');
  objectCardEl?.querySelector('.oc-close')?.addEventListener('click', hideObjectCard);
  document.addEventListener('click', (ev) => {
    if (!objectCardEl || objectCardEl.hidden) return;
    if (objectCardEl.contains(ev.target) || ev.target === canvas) return;
    hideObjectCard();
  });
  wireArchive();
  window.addEventListener('keydown', (ev) => {
    uilog('keydown', { key: ev.key || ev.code });
    if (ev.key === 'Escape') {
      hideObjectCard();
      if (!document.getElementById('archive-popup')?.hidden) openArchive(false);
      else if (state.archiveMode) { state.archiveMode = false; renderDeck(); }
      return;
    }
    if (ev.key >= '1' && ev.key <= '7') queueSlot(Number(ev.key) - 1);
    else if (ev.key === '8') queueSlot('EMPTY');
    else if (ev.key === '9' || ev.key === '0') clickPermanentKey(ev.key === '9' ? 0 : 1);
    else if (ev.code === 'Space') { ev.preventDefault(); if (state.bonusMode) commitBonus(); else if (state.queued.length) { state.locked = true; send({ kind: 'lock' }); logUI('commit locked (early)', 'phase'); renderDeck(); } }
    else if (ev.key === '-' || ev.key === '=') clickPermanentKey(ev.key === '-' ? 2 : 3);
    else if (ev.key === 'c' || ev.key === 'C') renderer.recentre();
    else if (ev.key === 'm' || ev.key === 'M') {
      const muted = sounds.toggle();
      try { localStorage.setItem('chaosd6.muted', muted ? '1' : '0'); } catch { /* no storage */ }
      logUI(muted ? 'sound muted' : 'sound on', 'phase');
    }
    else if (ev.key === 'g' || ev.key === 'G') state.ui.showCoords = !state.ui.showCoords;
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
          sourceId: sourceIdOf(p),
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
      return out;
    },
    get map() { return state.map; },
    get mapVersion() { return state.mapVersion; },
    get myPeerId() { return state.myPeerId; },
  });
  rendererRef = renderer;
  // Test hook (tools/ui-check.mjs): every known hex that carries a map object,
  // with its current canvas-pixel position so a script can click it.
  window.__chaosObjects = () => {
    const o0 = renderer.toWorld(0, 0), z = renderer.zoom();
    const out = [];
    for (const t of state.map.tiles()) {
      const obj = objectAt(t.q, t.r);
      if (!obj) continue;
      const w = renderer.tilePx(t.q, t.r);
      const unit = state.entities.some(p => p.tile_q === t.q && p.tile_r === t.r && (p.life ?? 0) > 0);
      out.push({ q: t.q, r: t.r, label: obj.label, kind: obj.kind, biome: obj.biome, unit, x: (w.x - o0.x) * z, y: (w.y - o0.y) * z });
    }
    return out;
  };
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
    canvas.classList.toggle('over-object', !over && !!state.ui.hoverTile && !!objectAt(state.ui.hoverTile.q, state.ui.hoverTile.r));
    renderHoverCard(ev.clientX, ev.clientY);
  });
  canvas.addEventListener('mouseleave', () => { state.ui.hoverPeerId = null; state.ui.hoverTile = null; canvas.classList.remove('over-object'); renderHoverCard(); });
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
    if (!t) { hideObjectCard(); return; }
    const occupant = entityAtPixel(px, py);
    // A hex holding a map object and no unit opens the object info card
    // (units keep their hover/hero cards). Any other click closes it.
    const obj = occupant ? null : objectAt(t.q, t.r);
    if (obj) showObjectCard(obj, ev.clientX, ev.clientY); else hideObjectCard();
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
      const eff = state.queuedEffect !== null ? state.hand[state.queuedEffect] : null;
      const counter = state.queuedSkills.some(i => state.hand[i]?.skill_id === 'skill_counter_spell');
      label = eff || counter
        ? `${eff ? eff.name : 'Counter spell'} → ${occupant.name} (on ${queuedCode || 'EP'})`
        : `target → ${occupant.name} (keeping ${queuedCode || 'EP'})`;
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
    renderPerms();
    renderDeck();
    renderHeroCard();
    if (!readyPlayed && state.myPeerId) {
      const me = state.entities.find(p => p.peer_id === state.myPeerId);
      const res = me ? resOf(me) : null;
      if (res) { readyPlayed = true; sounds.play(res, 'ready', { volume: 0.7 }); }
    }
    renderer.render();
    // Floating SkillCard DOM over revealing units — pinned to the canvas each
    // frame so it tracks the camera / zoom (positions read renderer.toWorld
    // and renderer.tilePx, same bridge used by __chaosObjects).
    renderRevealOverlay();
    requestAnimationFrame(raf);
  }
  raf();
}

wireInput();
