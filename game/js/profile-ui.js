// Profile panel + character / team editors (user ruling 2026-11-13).
//
// The launcher shows a "Your profile" panel under the Launch button, four rows (user ruling 2026-11-13):
//   Test my character <character> | Test Random character
//   Edit a character profile <character> | Create New character
//   Test my team <count> <tier> | Edit order
//   Create Dimension <name> | Load old Dimension <saved>
//   Open rules editor [New skill | New effect | New class] | sign-in status (GET /rules/api/editor/session)
// then a Dimensions list (user ruling 2026-11-15): per dimension "⚑ New Door · Join top character" / "⚑ Join my
// team" (30–50 hexes from a Door — a stale one in a quiet dimension), one chip per Door with its exact map share
// (⬡ % of the dimension's known hexes, "mine %" of my saved copy), and the alive units the Doors know
// (Allies / Enemies / Monsters): click a name → my top character joins next to it as its ally. The phone's menu
// server serves the same page with ?mobile=1&menu=1 — there only this panel is shown.
// All data comes from the profile API (game/profile.mjs handleProfileApi):
//   GET /api/profile · GET /api/profile/catalog · POST /api/profile/draft
//   POST /api/profile/characters {character} · PUT /api/profile/characters/<id> {actions, cards}
//   PUT /api/profile/team {team_name, order}
//   GET /api/dimensions · GET /api/dimensions/local · POST /api/dimensions/delete {dimensionName, dimId} (✕, local copy only)
// and launches go through POST /api/launch {mode: test-character | test-random | test-team | host | restore |
// join | join-team}.
//
// The top of this file is pure (no DOM) so a node script can import and check the helpers.
import { ACTION_HELP } from './rules_text.js';
import { effectSource, makeSourceBadge } from './effect_source.js';

// Mirrors profile.mjs LIMITS; the server's copy (GET /api/profile → limits) wins when present.
export const DEFAULT_LIMITS = {
  STAT_KEYS: ['vitality', 'world', 'matter', 'will'], STAT_SUM: 40, STAT_MIN: 1, STAT_MAX: 30,
  DECK_MIN: 15, ACTION_MAX: 30, ACTION_CODES: ['A', 'B', 'M', 'P'], SKILL_COUNT: 4, EFFECT_COUNT: 10,
};
const _params = typeof location !== 'undefined' ? new URL(location.href).searchParams : new URLSearchParams();
// ?menu=1 — the phone's menu server (only /api/profile/* + the test launch modes exist there).
export const IS_MENU = _params.get('menu') === '1';
export const IS_MOBILE = _params.get('mobile') === '1';

// ---------------------------------------------------------------------------------------------
// Pure helpers
export const statSum = (stats, keys = DEFAULT_LIMITS.STAT_KEYS) => keys.reduce((a, k) => a + (Number(stats?.[k]) | 0), 0);
// Deck = Σ action cards + skill / effect cards placed in the deck (profile.mjs deckSize).
export const deckCount = (c, codes = DEFAULT_LIMITS.ACTION_CODES) =>
  codes.reduce((a, k) => a + (Number(c?.actions?.[k]) | 0), 0) + (c?.cards || []).filter(x => x.where === 'deck').length;
// +/- one stat inside STAT_MIN..STAT_MAX (the Σ is shown, not forced — Save waits for Σ = STAT_SUM).
export function bumpStat(stats, key, delta, L = DEFAULT_LIMITS) {
  const v = (Number(stats?.[key]) | 0) + delta;
  return v < L.STAT_MIN || v > L.STAT_MAX ? stats : { ...stats, [key]: v };
}
export function bumpAction(actions, code, delta, L = DEFAULT_LIMITS) {
  const v = (Number(actions?.[code]) | 0) + delta;
  return v < 0 || v > L.ACTION_MAX ? actions : { ...actions, [code]: v };
}
// Why Save is disabled (empty → savable). `create` also checks the parts that lock afterwards.
export function draftProblems(c, L = DEFAULT_LIMITS, { create = false } = {}) {
  const out = [];
  if (create) {
    if (!String(c?.name || '').trim()) out.push('a name is needed');
    const bad = L.STAT_KEYS.some(k => { const v = c?.stats?.[k]; return !Number.isInteger(v) || v < L.STAT_MIN || v > L.STAT_MAX; });
    if (bad) out.push(`each stat ${L.STAT_MIN}–${L.STAT_MAX}`);
    const s = statSum(c?.stats, L.STAT_KEYS);
    if (s !== L.STAT_SUM) out.push(`stats Σ ${s} — must be ${L.STAT_SUM}`);
  }
  const d = deckCount(c, L.ACTION_CODES);
  if (d < L.DECK_MIN) out.push(`deck ${d} — needs at least ${L.DECK_MIN}`);
  return out;
}
export function moveItem(list, i, delta) {
  const a = [...list], j = i + delta;
  if (i < 0 || i >= a.length || j < 0 || j >= a.length) return a;
  [a[i], a[j]] = [a[j], a[i]];
  return a;
}
// The team order with every character once (top first), like profile.mjs loadProfile keeps it.
export function orderedCharacters(profile) {
  const chars = profile?.characters || [];
  const byId = new Map(chars.map(c => [c.id, c]));
  const out = (profile?.team_order || []).map(id => byId.get(id)).filter(Boolean);
  for (const c of chars) if (!out.includes(c)) out.push(c);
  return out;
}
export const teamMemberLabel = (name, team) => `${name} — ${team ? `${team} team member` : 'team member (no team name yet)'}`;
export const joinTeamLabel = (team) => team ? `Join my ${team} team` : 'Join my team';
export const teamCountOptions = (n) => n >= 2 ? Array.from({ length: n - 1 }, (_, i) => i + 2) : [];
// Keeps ?mobile=1 across the post-launch reload (the phone WebView needs the phone layout).
export const peerSearch = (port, mobile = IS_MOBILE) => `?peer=${port}${mobile ? '&mobile=1' : ''}`;
export const launchBody = {
  testCharacter: (profileCharId) => ({ mode: 'test-character', profileCharId }),
  testRandom: () => ({ mode: 'test-random' }),
  testTeam: (count, tier) => ({ mode: 'test-team', count: Number(count), tier: tier === 'strong' ? 'strong' : 'reachable' }),
  // count > 1: the top character opens the gate, the next count−1 arrive beside it on the tier ring.
  joinTeam: (dimensionName, doorId, count = null, tier = null) => ({
    mode: 'join-team', dimensionName, doorId,
    ...(Number(count) > 1 ? { count: Number(count), tier: tier === 'strong' ? 'strong' : 'reachable' } : {}),
  }),
  // Create Dimension: the top profile character is the hero when there is one (the server falls back to random).
  host: (dimensionName) => ({ mode: 'host', dimensionName: String(dimensionName || '').trim().slice(0, 40) || 'Ashfall-Micro', characterId: 'profile:top' }),
  restore: (tmjPath) => ({ mode: 'restore', tmjPath }),
  // "↻ Restore <name> here": that profile character comes back where its alive record stands (servers: restoreHere).
  restoreHere: (dimensionName, profileCharId) => ({ mode: 'restore-here', dimensionName, profileCharId }),
  // "⇱ Dimension Out" (rule_dimension_out): restore-here / take over that character there and start the 10-round
  // Dimension Out at once (DIM_OUT_ON_START) — the game opens so the countdown shows, then back to this menu.
  dimOut: (dimensionName, profileCharId) => ({ mode: 'dim-out', dimensionName, profileCharId }),
  // Join next to a node (Door) / unit (unitJoinBody adds nearTile).
  join: (dimensionName, doorId, side, { characterId = null, creatureId = null } = {}) => ({
    mode: 'join', dimensionName, doorId, placement: 'nearby', side, characterId, creatureId,
  }),
};

// Ally / Enemy of a Door's unit (user ruling 2026-11-13). Ally = the Door's own side (an npc_a helper is
// joined as a player); Enemy = the opposing human side (player ↔ 3rd team); a monster's Door: Ally = another
// monster, Enemy = a player.
export const allySideOf = (a) => (a === 'player_c' || a === 'npc_c') ? 'player_c' : (a === 'player_d' || a === 'npc_d') ? 'player_d'
  : a === 'npc_b' ? 'npc_b' : 'player';
export const enemySideOf = (a) => (a === 'player' || a === 'npc_a') ? 'player_c' : 'player';
// role: 'ally' | 'enemy' | 'monster'. Characters join as the top profile character ('profile:top' — the
// server / phone menu falls back to a random character); monsters as the type the Doors know (user ruling
// 2026-11-15 "the same type of monster should be joined and the computer should control it": the Door's own
// creature, else 'known' = join-plan.mjs knownMonsterType on the server / phone; random only if none is known).
export function joinRoleBody(dimensionName, door, role) {
  const side = role === 'monster' ? 'npc_b' : role === 'enemy' ? enemySideOf(door?.alliance) : allySideOf(door?.alliance);
  return side === 'npc_b'
    ? launchBody.join(dimensionName, door?.peer_id, side, { creatureId: (door?.alliance === 'npc_b' && door?.creature_id) || 'known' })
    : launchBody.join(dimensionName, door?.peer_id, side, { characterId: 'profile:top' });
}
// A dimension's Door for "New Door · Join top character" / "Join my team": a live, alive player Door first,
// then a 3rd-team, an npc_a, any live alive Door; a quiet dimension (user ruling 2026-11-15) falls back to its
// newest alive Door, then its newest Door — the joiner then starts the dimension from the saved Doors.
// null only for legacy dimensions / no Doors.
export const doorJoinable = (d, p) => !d?.legacy && !!p?.live && (p.life ?? 1) > 0;
export function teamJoinDoor(d) {
  if (d?.legacy) return null;
  const doors = [...(d?.doors || [])].sort((a, b) => (a.age_sec ?? 1e12) - (b.age_sec ?? 1e12));
  const alive = doors.filter(p => (p.life ?? 1) > 0);
  for (const pool of [alive.filter(p => p.live), alive, doors]) {
    for (const a of ['player', 'player_c', 'npc_a']) { const p = pool.find(x => x.alliance === a); if (p) return p; }
    if (pool.length) return pool[0];
  }
  return null;
}
export const QUIET_HINT = "quiet — you'll start it from its saved Doors";
// Alive units of a dimension (server: join-plan.mjs dimensionUnits) — groups from my top character's default
// side (player): Allies = player / npc_a, Enemies = player_c / npc_c, Monsters = npc_b.
export const UNIT_GROUPS = [['ally', 'Allies'], ['enemy', 'Enemies'], ['monster', 'Monsters']];
export const unitGroupOf = (a) => (a === 'player' || a === 'npc_a') ? 'ally' : a === 'npc_b' ? 'monster' : 'enemy';
// Click a unit's name (user ruling 2026-11-15): my top character joins next to it (nearTile) through the Door
// that reported it, ALWAYS as its ally (allySideOf: a player / ally bot → player, a 3rd-team unit → player_c, a
// 4th-team unit → player_d, a monster → npc_b — "it will make you an ally even to a monster"; the server makes that hero human, HUMAN=1).
export function unitJoinBody(dimensionName, unit) {
  const side = allySideOf(unit?.alliance);
  const t = unit?.tile;
  return { ...launchBody.join(dimensionName, unit?.via || unit?.peer_id, side, { characterId: 'profile:top' }),
    ...(t && Number.isInteger(t.q) && Number.isInteger(t.r) ? { nearTile: { q: t.q, r: t.r } } : {}),
    // The ally-join link (rule_unattended_character): the joiner publishes ally_of = this unit — a player joining an
    // unattended character (or a unit of its link group) becomes the group's master.
    ...(unit?.peer_id && unit?.group !== 'monster' ? { nearPeer: String(unit.peer_id) } : {}) };
}
// A unit's unattended-character / combo tags in the Dimensions list (user 2026-11-16): "unattended", "follows
// <leader>", "leads N", and its combo (M·B·P).
export function unitTags(u) {
  const tags = [];
  if (u?.unattended) tags.push({ cls: 'pp-unit-unatt', text: 'unattended', title: "its player closed the game — the computer plays it; its player takes it back by joining again" });
  if (u?.led_by) tags.push({ cls: 'pp-unit-follow', text: `follows ${u.led_by_name || String(u.led_by).replace(/^peer:/, '')}`, title: 'it follows its master like a summon' });
  if (Number(u?.leads) > 0) tags.push({ cls: 'pp-unit-leads', text: `⚑ leads ${u.leads}`, title: `${u.leads} unattended character${u.leads === 1 ? '' : 's'} follow${u.leads === 1 ? 's' : ''} it` });
  if (Array.isArray(u?.combo) && u.combo.length) tags.push({ cls: 'pp-unit-combo', text: u.combo.join('·'), title: `combo ${u.combo.join(' → ')}` });
  return tags;
}
// "⚑ New Door · Join top character" / "⚑ Join my team" join as a NEW team (user rulings 2026-11-15: "Fourth team
// is joining at 4th side on a door that is distant to them") — mirrors join-plan.mjs newTeamSide: the first side
// of A (player), C (player_c), D (player_d) with nobody alive; null = all three taken → both buttons refuse.
// `sides` = units_sides { A, B, C, D } (alive counts).
export const NO_FREE_SIDE = 'all three player sides (A player, C 3rd team, D 4th team) have units alive in this dimension — no free side for a new team';
export function newTeamSideOf(sides = {}) {
  for (const [k, a] of [['A', 'player'], ['C', 'player_c'], ['D', 'player_d']]) if (!(Number(sides?.[k]) > 0)) return a;
  return null;
}
// The server's pick (new_team_side; null = none free) when it sent one, else from units_sides.
export const dimNewSide = (d) => d && 'new_team_side' in d ? d.new_team_side : d?.units_sides ? newTeamSideOf(d.units_sides) : 'player_c';
// No cloning (user ruling 2026-11-15) — mirrors join-plan.mjs recordIsCharacter: a Door record is my profile
// character by its profile id (newer Doors), else by base character + name.
export const ALREADY_ALIVE = 'you are already alive in this dimension — rejoin/restore instead';
export const recordIsCharacter = (m, c) => !!(m && c) && (m.profile_char_id ? m.profile_char_id === c.id
  : (!m.creature_id && !!c.base_character && m.character_id === c.base_character && m.name === c.name));
// One dimension at a time (user ruling 2026-11-15): charId → the first dimension of `items` where it is alive.
export function aliveWhere(items, chars) {
  const out = new Map();
  for (const d of items || []) for (const c of aliveMine(d, chars)) if (!out.has(c.id)) out.set(c.id, d.dimension_name);
  return out;
}
export const aliveWhereText = (list, where) => list.map(c => `${c.name} alive in ${where.get(c.id)}`).join(', ') + (list.length ? ' — rejoin/restore there' : '');
// Which of `chars` are alive in dimension `d` (describeDimension alive_chars, else its character units).
// Only LIVE records (`live`, set by join-plan.mjs isLiveRecord: fresh sighting or a live shadow — user 2026-11-16)
// unless `anyAge` (the dimension a join targets: there any alive record still means "rejoin/restore instead").
export function aliveMine(d, chars, { anyAge = false } = {}) {
  const recs = (d?.alive_chars || (d?.units || []).filter(u => u.kind !== 'creature')).filter(m => anyAge || m.live === true);
  return (chars || []).filter(c => recs.some(m => recordIsCharacter(m, c)));
}
// "You are here" (user 2026-11-16: "I don't know on which old dimension I am alive. I should see it in the list below
// as a restore one"): my profile characters (any, team members too) with an ALIVE record in `d`, live or stale —
// the newest per character → [{ character, rec }]. Dead records give nothing (no Restore button).
const _seenMs = (m) => Date.parse(m?.seen_at || 0) || 0;
export function myAliveRecords(d, chars) {
  const out = [];
  for (const c of chars || []) {
    const mine = (d?.alive_chars || []).filter(m => recordIsCharacter(m, c) && (Number(m.life ?? 1) || 0) > 0).sort((a, b) => _seenMs(b) - _seenMs(a));
    if (mine.length) out.push({ character: c, rec: mine[0] });
  }
  return out;
}
// "⇱ Dimension Out" (rule_dimension_out, user 2026-11-16): for my character alive in a dimension (live or unattended
// record, any age, life > 0) — takes it over there and starts the Dimension Out; the dimension is in the tooltip.
export const dimOutTitle = (dimName, c, m) => `Dimension Out of ${dimName}: ${c.name} comes back there${m?.shadow_of ? ' (taking over its unattended copy)' : ''} and channels 10 rounds — you watch the countdown in the game, then you are back here, free to join another dimension. Moving, attacking or casting interrupts it; you can still be hit.`;
function dimOutButton(dimName, c, m, block = '') {
  return h('button', { type: 'button', class: 'pp-btn pp-dimout', text: '⇱ Dimension Out', disabled: !!block || !!S.busy, title: block || dimOutTitle(dimName, c, m),
    onclick: () => launchProfile(launchBody.dimOut(dimName, c.id), `${dimName}: ${c.name} leaves the dimension (Dimension Out)`) });
}
// Every dimension my characters are in (the start screen's "⇱ Dimension Out" list): [{ character, dimension_name, rec }].
export function myPresence(items, chars) {
  const out = [];
  for (const d of items || []) for (const x of myAliveRecords(d, chars)) out.push({ ...x, dimension_name: d.dimension_name });
  return out;
}
export const hereAgeSec = (m, now = Date.now()) => m?.seen_at ? Math.max(0, Math.round((now - _seenMs(m)) / 1000)) : (m?.age_sec ?? null);
export const hereLineText = (c, m, now = Date.now()) => `${c.name} alive here${m.shadow_of ? ' (as its shadow)' : ''} · hp ${m.life ?? '?'}${m.life_max ? `/${m.life_max}` : ''}`
  + ` · last seen ${agoText(hereAgeSec(m, now))}${m.tile ? ` at (${m.tile.q},${m.tile.r})` : ''}`;
// The dimensions where I am alive first (stable: the usual order inside each group).
export const sortDimsMineFirst = (items, chars) => {
  const mine = new Set((items || []).filter(d => myAliveRecords(d, chars).length).map(d => d.dimension_name));
  return [...(items || [])].sort((a, b) => (mine.has(b.dimension_name) ? 1 : 0) - (mine.has(a.dimension_name) ? 1 : 0));
};
// Map shares (exact, from the Doors' blocks): "⬡ 62%" = that Door holds 62 % of the dimension's known hexes;
// "mine 40%" = it holds 40 % of my saved copy. The dimension summary shows the MEDIAN Door (user ruling 2026-11-15).
export const pctText = (x) => x == null || !Number.isFinite(Number(x)) ? null : `${Math.round(Number(x) * 100)}%`;
export const doorShareText = (p) => p?.map_share == null ? null : `⬡ ${pctText(p.map_share)}${p.mine_share != null ? ` · mine ${pctText(p.mine_share)}` : ''}`;
export const dimShareText = (d) => [d?.map_share_median != null ? `median Door ⬡ ${pctText(d.map_share_median)}` : null,
  d?.mine_cover != null ? `my copy ${pctText(d.mine_cover)}` : null].filter(Boolean).join(' · ') || null;
export const sideLabel = (a) => ({ player: 'player', player_c: '3rd team', player_d: '4th team', npc_a: 'ally bot', npc_b: 'monster', npc_c: '3rd-team bot', npc_d: '4th-team bot' }[a] || String(a || '?'));
export const sideClass = (a) => (a === 'player' || a === 'npc_a' || a === 'npc_b') ? a : (a === 'player_c' || a === 'npc_c') ? 'team-c'
  : (a === 'player_d' || a === 'npc_d') ? 'team-d' : 'npc_b';
// Default name for "Create Dimension" (a fresh name, so a new dimension doesn't land in someone's Ashfall-Micro).
const DIM_A = ['Ashen', 'Hollow', 'Gilded', 'Sunken', 'Shattered', 'Ember', 'Frozen', 'Verdant', 'Howling', 'Crimson', 'Silent', 'Drowned'];
const DIM_B = ['Reach', 'Marches', 'Spire', 'Wilds', 'Vale', 'Barrows', 'Expanse', 'Deep', 'Crown', 'Fen', 'Wastes', 'Hollows'];
export const fancyDimName = (rnd = Math.random) => `${DIM_A[Math.floor(rnd() * DIM_A.length)]}-${DIM_B[Math.floor(rnd() * DIM_B.length)]}`;
export const agoText = (sec) => sec == null ? '—' : sec < 90 ? `${sec}s ago` : sec < 5400 ? `${Math.round(sec / 60)} min ago` : sec < 172800 ? `${Math.round(sec / 3600)} h ago` : `${Math.round(sec / 86400)} d ago`;
export const sortDims = (items) => [...(items || [])].sort((a, b) => (b.live_doors - a.live_doors) || ((a.age_sec ?? 1e12) - (b.age_sec ?? 1e12)));
// Old dimensions (user ruling 2026-11-15): one row per dimension from GET /api/dimensions (Radicle) and
// GET /api/dimensions/local (saves on this device), matched by dimension id, then by name. A row is old when
// every source says so (server: nothing pushed / saved for 72 h); stats are the max over the sources.
export const LOCAL_ONLY_NOTE = 'deletes your local copy only — the Radicle branch stays on the network';
const _maxIso = (a, b) => (Date.parse(a || 0) || 0) >= (Date.parse(b || 0) || 0) ? (a || b || null) : b;
export function mergeDims(dims, local, now = Date.now()) {
  const rows = [], byId = new Map(), byName = new Map();
  for (const d of dims || []) {
    const r = { ...d, on_radicle: true, saves: [], old: d.old === true };
    rows.push(r);
    if (d.dimension_id) byId.set(d.dimension_id, r);
    byName.set(d.dimension_name, r);
  }
  for (const s of local || []) {
    if (s.private) continue;   // a private test game's save: Load old Dimension only ("test"), never a Dimensions row
    let r = (s.dim_id && byId.get(s.dim_id)) || byName.get(s.dim_name);
    if (!r) {
      r = { dimension_name: s.dim_name || s.dim_id, dimension_id: s.dim_id, doors: [], live_doors: 0, on_radicle: false, local_only: true, saves: [],
        turn_max: 0, hexes: 0, local_bytes: 0, last_active: null, old: true };
      rows.push(r);
      if (s.dim_id) byId.set(s.dim_id, r);
      byName.set(r.dimension_name, r);
    }
    r.saves.push(s);
    r.saved_locally = true;
    r.turn_max = Math.max(Number(r.turn_max) || 0, Number(s.turn) || 0);
    r.hexes = Math.max(Number(r.hexes) || 0, Number(s.hexes) || 0);
    r.local_bytes = Math.max(Number(r.local_bytes) || 0, Number(s.local_bytes) || 0);
    r.last_active = _maxIso(r.last_active, s.last_active || s.saved_at);
    r.old = r.old && s.old === true;
  }
  for (const r of rows) if (r.local_only) r.age_sec = r.last_active ? Math.max(0, Math.round((now - Date.parse(r.last_active)) / 1000)) : null;
  return rows;
}
export const bytesText = (n) => !(Number(n) > 0) ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  : n < 1073741824 ? `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB` : `${(n / 1073741824).toFixed(1)} GB`;
export const dimSourceText = (r) => r.on_radicle && r.saved_locally ? 'Radicle + saved' : r.on_radicle ? 'Radicle' : 'saved here';
// "turn 12 · 1,419 hexes · 2.3 MB" (— = nothing stored on this device).
export const dimStatsText = (r) => `turn ${Number(r.turn_max ?? r.turn) || 0} · ${(Number(r.hexes) || 0).toLocaleString('en-US')} hexes · ${bytesText(r.local_bytes)}`;
export const deleteBody = (r) => ({ dimensionName: r.dimension_name, ...(r.dimension_id && /^dim-[a-z0-9-]+$/.test(r.dimension_id) ? { dimId: r.dimension_id } : {}) });
export const shortText = (t, n = 140) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};
export const prettyId = (id) => String(id || '').replace(/^(class|skill|effect|elem|char|mon)_/, '').replace(/_/g, ' ');
// Repo-relative asset path (assets/…) → URL the server answers (/assets/…); same as sprites.js assetUrl.
export const assetUrl = (p) => p ? `/${String(p).replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}` : null;

// ---------------------------------------------------------------------------------------------
// DOM
const S = { profile: null, limits: DEFAULT_LIMITS, catalog: null, error: null, busy: false, body: null, sync: null,
  // Dimensions section: GET /api/dimensions items (null = loading), its error, "show more"; saved dims (GET /api/dimensions/local).
  dims: null, dimsError: null, dimsAll: false, dimsLoading: false, local: [], dimName: null, teamCount: null, teamTier: 'strong',
  editor: undefined };   // GET /rules/api/editor/session (undefined = checking, null = unavailable)
const DIMS_SHOWN = 10, DOORS_SHOWN = 8, UNITS_SHOWN = 10;

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const sel = (options, value, props = {}) => {
  const s = h('select', props);
  for (const o of options) s.append(h('option', { value: o.value, text: o.text, disabled: !!o.disabled }));
  if (value != null) s.value = String(value);
  return s;
};

async function api(method, url, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(url, init);
  let out = {};
  try { out = await r.json(); } catch { /* empty / not json */ }
  if (!r.ok || out?.ok === false) throw new Error(out?.error || `${method} ${url} → HTTP ${r.status}`);
  return out;
}

async function reloadProfile() {
  const out = await api('GET', '/api/profile');
  S.profile = out.profile || { team_name: '', team_order: [], characters: [] };
  S.limits = { ...DEFAULT_LIMITS, ...(out.limits || {}) };
  S.error = null;
  return S.profile;
}
async function getCatalog() {
  if (!S.catalog) S.catalog = await api('GET', '/api/profile/catalog');
  return S.catalog;
}

// The launcher's "entering dimension" overlay (launcher.js owns it; poked directly to avoid an import cycle).
function showEntering(sub, mainText) {
  const ov = document.getElementById('entering-overlay');
  if (!ov) return;
  if (mainText) document.getElementById('entering-text').textContent = mainText;
  if (sub) document.getElementById('entering-sub').textContent = sub;
  ov.hidden = false;
}
const hideEntering = () => { const ov = document.getElementById('entering-overlay'); if (ov) ov.hidden = true; };

function setMsg(text, bad = false) {
  const m = document.getElementById('pp-msg');
  if (!m) return;
  m.textContent = text || '';
  m.classList.toggle('bad', !!bad);
}
function setBusy(on) {
  S.busy = on;
  for (const b of document.querySelectorAll('#profile-panel button, .join-team-btn')) {
    if (on) { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true; }
    else if (b.dataset.wasDisabled !== undefined) { b.disabled = b.dataset.wasDisabled === '1'; delete b.dataset.wasDisabled; }
  }
}

// One WebSocket handshake attempt: true when a peer answers on the port (the menu server does not upgrade).
function probePeer(port, ms = 2500) {
  return new Promise((resolve) => {
    let ws = null, settled = false;
    const done = (ok) => { if (settled) return; settled = true; clearTimeout(t); try { ws?.close(); } catch { /* closing */ } resolve(ok); };
    const t = setTimeout(() => done(false), ms);
    try { ws = new WebSocket(`ws://127.0.0.1:${port}/`); ws.onopen = () => done(true); ws.onerror = () => done(false); ws.onclose = () => done(false); }
    catch { done(false); }
  });
}
async function waitForPeer(port, onTick, limitMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    if (await probePeer(port)) return true;
    onTick?.(`waiting for the game on :${port} — ${Math.round((Date.now() - t0) / 1000)} s`);
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// POST /api/launch, then the usual reload to ?peer=<port> (menu mode: wait for the peer, then /?peer=…&mobile=1).
export async function launchProfile(body, what) {
  if (S.busy) return;
  setBusy(true);
  setMsg(`launching — ${what}…`);
  showEntering(what, 'entering dimension…');
  try {
    const out = await api('POST', '/api/launch', body);
    const port = out.peerPort || (IS_MENU ? 7401 : null);
    if (!port) throw new Error('the launcher did not say which peer came up');
    if (IS_MENU) {
      const up = await waitForPeer(port, (sub) => showEntering(sub));
      if (!up) showEntering('the game is slow to start — opening it anyway');
      location.href = `/?peer=${port}&mobile=1`;
      return;
    }
    setMsg(`up on peer :${port} — reloading…`);
    location.search = peerSearch(port);
  } catch (e) {
    setMsg(`failed: ${e.message}`, true);
    hideEntering();
    setBusy(false);
  }
}
export const launchJoinTeam = (dimensionName, doorId, count = null, tier = null) =>
  launchProfile(launchBody.joinTeam(dimensionName, doorId, count, tier), Number(count) > 1
    ? `${joinTeamLabel(S.profile?.team_name)} — ${count} characters arriving 30–50 hexes from the Door`
    : `${orderedCharacters(S.profile)[0]?.name || 'my top character'} — arriving 30–50 hexes from the Door`);

// "Join my <team> team" button for a live Door (explorer chips, next to #pick-door). Hidden without characters.
export function joinTeamButton(dimensionName, doorId) {
  const b = h('button', {
    type: 'button', class: 'join-team-btn', text: joinTeamLabel(S.profile?.team_name),
    title: `join ${dimensionName} with your top character, 30–50 hexes away from this Door; your team there gets a notice and sees the new gate until the end of the next turn`,
    onclick: (ev) => { ev.stopPropagation(); launchJoinTeam(dimensionName, doorId); },
  });
  b.hidden = !(S.profile?.characters?.length);
  return b;
}
// One dimension at a time (user ruling 2026-11-15): Test my character / Test my team / Create Dimension are greyed
// while that character (any of the top `count`) is alive in a listed dimension; Load old Dimension while the save's
// hero is alive in ANOTHER dimension (its own one is the way back). Tooltip: "<name> alive in <Dim> — rejoin/restore
// there". The servers refuse the same launches with 409.
export function oneDimWhy(items, chars, list, except = null) {
  const where = aliveWhere((items || []).filter(d => d.dimension_name !== except), chars);
  const hit = (list || []).filter(c => c && where.has(c.id));
  return hit.length ? aliveWhereText(hit, where) : '';
}
export const savedHeroChar = (it, chars) => (it?.hero && (chars || []).find(c => c.base_character === it.hero.character_id && c.name === it.hero.name)) || null;
export function refreshOneDim() {
  const o = S.od;
  if (!o) return;
  const chars = orderedCharacters(S.profile), local = S.local || [];
  const items = sortDims(mergeDims(S.dims || [], local));
  const set = (b, base, why) => {
    if (!b) return;
    if (b.dataset.baseTitle == null) b.dataset.baseTitle = b.title || '';
    b.disabled = !!base || !!why; b.title = why || b.dataset.baseTitle;
  };
  // Test games are local and private (user 2026-11-16): they never count for one dimension at a time — no greying.
  set(o.test, !chars.length, '');
  set(o.team, o.countSel?.disabled, '');
  set(o.create, false, oneDimWhy(items, chars, [chars[0]]));
  const it = local.find(x => x.path === o.loadSel?.value);
  set(o.load, !local.length, it && !it.private ? oneDimWhy(items, chars, [savedHeroChar(it, chars)], it.dim_name) : '');
}
export function refreshJoinTeamButtons() {
  const has = !!S.profile?.characters?.length;
  for (const b of document.querySelectorAll('.join-team-btn')) {
    b.hidden = !has;
    b.textContent = joinTeamLabel(S.profile?.team_name);
  }
}

// Cards taken from kills that the player hasn't looked at yet (profile.mjs addArchivedCard → new:true).
export const newCards = (c) => (c?.cards || []).filter(x => x.new).length;
const charOptionText = (c) => `${c.name} — ${prettyId(c.class_id)}${c.deaths ? ` · ☠${c.deaths}` : ''}${c.kills ? ` · 🏆${c.kills}` : ''}${newCards(c) ? ` · ✨${newCards(c)} new` : ''}`;
// The same chips the in-game hand shows (main.js renderHand) plus the skill's action type.
const ACTION_TYPE_LABEL = { A: '⚔ with Attack', B: '🛡 with Block', M: '👣 with Move', P: '🤺 with Posture', '*': '✦ any action' };
export function cardFlags(kind, info) {
  if (!info) return [];
  const f = [];
  if (kind === 'skill') {
    if (info.action_type) f.push(ACTION_TYPE_LABEL[info.action_type] || info.action_type);
    if (info.permanent) f.push('perm');
    if (info.negating) f.push('negates');
    if (info.point_buy_stat) f.push(`buy ${prettyId(info.point_buy_stat)}`);
  } else {
    if (info.permanent) f.push('perm');
    if (info.damage) f.push('dmg');
    if (info.point_buy) f.push('buy');
    if (info.channel) f.push('channel');
    if (info.instant && !info.permanent) f.push('instant');
    if (info.tile_target) f.push('⌖ tile');
  }
  return f;
}

function renderPanel() {
  const root = S.body;
  if (!root) return;
  root.innerHTML = '';
  if (S.error) {
    root.append(h('div', { class: 'pp-status bad', text: `profiles are not available here (${S.error})` }));
  }
  const chars = orderedCharacters(S.profile);
  const has = chars.length > 0;
  const team = S.profile?.team_name || '';
  const top = chars[0];
  if (!S.error) {
    root.append(h('div', { class: 'pp-status', text: has
      ? `${team ? `${team} team` : 'No team name yet'} · ${chars.length} character${chars.length === 1 ? '' : 's'} · top: ${top.name} (joins on links)`
      : 'No characters yet — create one to play as yourself.' }));
    // Cards won from kills, until the player opens them in the editor.
    const fresh = chars.filter(c => newCards(c));
    if (fresh.length) root.append(h('div', { class: 'pp-new' },
      `✨ new cards in the archive: ${fresh.map(c => `${c.name} ${newCards(c)}`).join(' · ')} — `,
      ...fresh.map(c => h('button', { type: 'button', class: 'pp-new-open', text: `open ${c.name}`, onclick: () => openCharacterEditor('edit', c.id) }))));
  }
  root.append(h('div', { id: 'pp-sync', class: 'pp-sync' }));
  renderSync();
  const charOpts = chars.map(c => ({ value: c.id, text: charOptionText(c) }));
  // Four rows (user ruling 2026-11-13): primary button + its pickers | secondary button. One grid, so the
  // columns line up across rows.
  const grid = h('div', { class: 'pp-grid' });
  const row = (main, ctl, side) => grid.append(h('div', { class: 'pp-row' }, main, h('div', { class: 'pp-ctl' }, ...ctl), h('div', { class: 'pp-side' }, side)));
  const btn = (text, onclick, props = {}) => h('button', { type: 'button', class: 'pp-btn', text, onclick, ...props });

  // 1. Test my character <character> | Test Random character
  const testSel = sel(charOpts.length ? charOpts : [{ value: '', text: 'no characters yet' }], top?.id, { class: 'pp-select', disabled: !has, title: 'which character to test' });
  const od = S.od = { testSel };   // one dimension at a time: refreshOneDim greys these launch buttons
  row(od.test = btn('Test my character', () => launchProfile(launchBody.testCharacter(testSel.value), `test game as ${chars.find(c => c.id === testSel.value)?.name || 'my character'}`), { disabled: !has }),
    [testSel],
    btn('Test Random character', () => launchProfile(launchBody.testRandom(), 'test game with a random character'), { class: 'pp-btn pp-alt' }));
  // 2. Edit a character profile <character> | Create New character
  const editSel = sel(charOpts.length ? charOpts : [{ value: '', text: 'no characters yet' }], top?.id, { class: 'pp-select', disabled: !has, title: 'which character to edit' });
  row(btn('Edit a character profile', () => openCharacterEditor('edit', editSel.value), { disabled: !has }),
    [editSel],
    btn('Create New character', () => openCharacterEditor('create'), { disabled: !!S.error, class: 'pp-btn pp-alt' }));
  // 3. Test my team <count> <tier> | Edit order. The count + tier also drive "⚑ Join my team" in the Dimensions list.
  const counts = teamCountOptions(chars.length);
  if (!counts.includes(Number(S.teamCount))) S.teamCount = counts.length ? counts[counts.length - 1] : null;
  const countSel = sel(counts.length ? counts.map(n => ({ value: n, text: `${n} characters` })) : [{ value: '', text: 'needs 2+ characters' }],
    S.teamCount ?? '', { id: 'pp-team-count', class: 'pp-select pp-small', disabled: !counts.length, title: 'how many of my characters (top first) — also used by "Join my team" below',
      onchange: (ev) => { S.teamCount = Number(ev.target.value) || null; } });
  const tierSel = sel([
    { value: 'strong', text: 'Strong (2–6 hexes)' },
    { value: 'reachable', text: 'Reachable (9–10 hexes)' },
  ], S.teamTier, { id: 'pp-team-tier', class: 'pp-select pp-small', title: 'how close the allies start: Strong contact (2–6 hexes) or Reachable (9–10)',
    onchange: (ev) => { S.teamTier = ev.target.value; } });
  od.countSel = countSel;
  row(od.team = btn('Test my team', () => launchProfile(launchBody.testTeam(countSel.value, tierSel.value), `test game with ${countSel.value} of my team`), { disabled: !counts.length }),
    [countSel, tierSel],
    btn('Edit order', openTeamEditor, { disabled: !has, class: 'pp-btn pp-alt', title: 'team name + priority order (the top character joins on links)' }));
  // 4. Create Dimension <name> | Load old Dimension <saved>
  if (S.dimName == null) S.dimName = fancyDimName();
  const nameIn = h('input', { type: 'text', class: 'pp-input', maxLength: 40, value: S.dimName, placeholder: 'dimension name', title: 'name of the new dimension (max 40)',
    oninput: () => { S.dimName = nameIn.value; } });
  const create = () => {
    const name = nameIn.value.trim();
    if (!name) { setMsg('the new dimension needs a name', true); return; }
    launchProfile(launchBody.host(name), `new dimension ${name}${has ? ` as ${top.name}` : ' with a random character'}`);
  };
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  const saved = S.local || [];
  const loadSel = sel(saved.length
    ? saved.map(it => ({ value: it.path, text: `${it.dim_name || it.dim_id}${it.private ? ' [test]' : ''} (${it.kind}, ${agoText(it.saved_at ? Math.max(0, Math.round((Date.now() - Date.parse(it.saved_at)) / 1000)) : null)})` }))
    : [{ value: '', text: 'no saved dimensions' }], saved[0]?.path ?? '', { class: 'pp-select pp-load', disabled: !saved.length, title: 'a dimension saved on this device (autosave / hard save)' });
  od.loadSel = loadSel;
  for (const s of [testSel, countSel, loadSel]) s.addEventListener('change', refreshOneDim);
  row(od.create = btn('Create Dimension', create, { title: has ? `open a new dimension as ${top.name}` : 'open a new dimension (random character)' }),
    [nameIn],
    h('span', { class: 'pp-pair' },
      od.load = btn('Load old Dimension', () => {
        const it = saved.find(x => x.path === loadSel.value);
        if (!it) { setMsg('no saved dimension picked', true); return; }
        launchProfile(launchBody.restore(it.path), `loading ${it.dim_name || it.dim_id}`);
      }, { disabled: !saved.length, class: 'pp-btn pp-alt', title: saved.length ? 'continue a dimension saved on this device' : 'no saved dimensions on this device yet' }),
      loadSel));
  // 5. Open rules editor [New skill | effect | class] | sign-in status — the node's own /rules/ (EDITOR_SPEC ruling 1).
  row(btn('Open rules editor', () => openRulesEditor(), { title: 'browse the rules, skills, effects and classes; editable with your team identity' }),
    [h('div', { id: 'pp-ed-ctl', class: 'pp-seg' })],
    h('span', { id: 'pp-ed-side', class: 'pp-ed-side' }));
  root.append(grid);
  root.append(h('div', { id: 'pp-msg', class: 'pp-msg' }));
  root.append(h('div', { id: 'pp-dims', class: 'pp-dims' }));
  renderDims();
  renderEditorRow();
  refreshJoinTeamButtons();
}

// ---------------------------------------------------------------------------------------------
// Dimensions (desktop: the launcher's GET /api/dimensions; phone: the menu server's, read from radicle-httpd).
async function loadDims(sync = false) {
  if (S.dimsLoading) return;
  S.dimsLoading = true;
  renderDims();
  try {
    // sync=0: what the launcher's Radicle storage (desktop) / the menu's 30 s cache (phone) knows; ↻ asks the seeds.
    const out = await fetch(`/api/dimensions?sync=${sync ? 1 : 0}`).then(r => r.json());
    S.dims = out.items || [];
    S.dimsError = out.ok === false || out.enabled === false ? (out.reason || out.error || 'not reachable') : null;
  } catch (e) {
    S.dims = S.dims || [];
    S.dimsError = e.message;
  } finally { S.dimsLoading = false; }
  renderDims();
}
async function loadLocal() {
  try { S.local = (await api('GET', '/api/dimensions/local')).items || []; } catch { S.local = []; }
}
// ✕ of an old dimension. Two taps (no confirm(): the phone's WebView may not show dialogs): the first turns the
// ✕ into "Delete? ✓" for 4 s, the second deletes the local copy (POST /api/dimensions/delete).
async function deleteDim(d, btn) {
  if (btn && btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.classList.add('is-armed');
    btn.textContent = 'Delete? ✓';
    setTimeout(() => { if (btn.isConnected && !btn.disabled) { btn.dataset.armed = ''; btn.classList.remove('is-armed'); btn.textContent = '✕'; } }, 4000);
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'deleting…'; }
  let msg, bad = false;
  try {
    const out = await api('POST', '/api/dimensions/delete', deleteBody(d));
    msg = `deleted the local copy of ${d.dimension_name}${out.freed_bytes ? ` (${bytesText(out.freed_bytes)} freed)` : ''}${out.hidden ? ' — hidden here; the Radicle branch stays on the network' : ''}`;
  } catch (e) { msg = e.message; bad = true; }
  await loadLocal();
  renderPanel();
  setMsg(msg, bad);
  loadDims(false);
}

function renderDims() {
  const box = document.getElementById('pp-dims');
  if (!box) return;
  refreshOneDim();
  box.innerHTML = '';
  const chars = orderedCharacters(S.profile);
  const has = chars.length > 0;
  // One row per dimension: published on Radicle, saved on this device, or both.
  // Where I am alive goes first ("You are here", user 2026-11-16).
  const items = sortDimsMineFirst(sortDims(mergeDims(S.dims || [], S.local || [])), chars);
  const status = S.dims == null ? `loading…${items.length ? ` (${items.length} saved here)` : ''}`
    : S.dimsError ? `${items.length ? `${items.length} known · ` : ''}Radicle not reachable (${shortText(S.dimsError, 80)})`
    : !items.length ? 'nothing published yet — create one above'
    : `${items.filter(d => d.live_doors > 0).length} live / ${items.length}`;
  box.append(h('div', { class: 'pp-dims-head' },
    h('b', { text: 'Dimensions' }),
    h('span', { class: `pp-hint${S.dimsError ? ' bad' : ''}`, text: status }),
    h('button', { type: 'button', class: 'pp-btn pp-small', text: S.dimsLoading ? '…' : '↻', disabled: S.dimsLoading, title: 'check the seeds for fresh Doors', onclick: () => loadDims(true) })));
  // My characters out there (rule_dimension_out): each one alive in a dimension, with "⇱ Dimension Out" (desktop + phone).
  const presence = has ? myPresence(items, chars) : [];
  if (presence.length) box.append(h('div', { class: 'pp-presence' }, h('b', { class: 'pp-here-head', text: 'My characters in dimensions' }),
    ...presence.map(({ character: c, rec: m, dimension_name: dn }) => h('div', { class: 'pp-here-row' },
      h('span', { class: 'pp-here-line', text: `${c.name} in ${dn}${m.shadow_of ? ' (unattended)' : ''} · hp ${m.life ?? '?'}${m.life_max ? `/${m.life_max}` : ''} · ${m.live ? 'live' : `last seen ${agoText(hereAgeSec(m))}`}` }),
      dimOutButton(dn, c, m)))));
  const shown = S.dimsAll ? items : items.slice(0, DIMS_SHOWN);
  const count = Number(document.getElementById('pp-team-count')?.value) || 0;
  // One dimension at a time: where each of my characters is alive (any listed dimension).
  const aliveAt = has ? aliveWhere(items, chars) : new Map();
  for (const d of shown) {
    const stats = h('span', { class: 'pp-dim-stats', text: `${dimSourceText(d)} · ${dimStatsText(d)}`,
      title: `turn so far ${Number(d.turn_max ?? d.turn) || 0} · ${(Number(d.hexes) || 0).toLocaleString('en-US')} hexes revealed · stored on this device: ${bytesText(d.local_bytes)}${d.local_parts ? ` (saves ${bytesText(d.local_parts.saves)}, tape ${bytesText(d.local_parts.tape)}, local branch ${bytesText(d.local_parts.branch)})` : ''}\nlast used ${d.last_active ? agoText(Math.max(0, Math.round((Date.now() - Date.parse(d.last_active)) / 1000))) : '—'}` });
    // ✕ only on old dimensions (nothing pushed or saved for 72 h); the server re-checks.
    const del = d.old ? h('button', { type: 'button', class: 'pp-dim-del', text: '✕',
      title: `delete ${d.dimension_name} from this device — ${LOCAL_ONLY_NOTE}. Tap twice.`, onclick: (ev) => deleteDim(d, ev.currentTarget) }) : null;
    if (d.local_only) {
      box.append(h('div', { class: 'pp-dim is-local' }, h('div', { class: 'pp-dim-head' },
        h('span', { class: 'pp-dim-name', text: d.dimension_name }),
        h('span', { class: 'pp-badge', text: 'saved', title: 'saved on this device, not seen on Radicle — continue it with "Load old Dimension"' }),
        h('span', { class: 'pp-hint', text: agoText(d.age_sec) }),
        stats, del)));
      continue;
    }
    const door = teamJoinDoor(d);
    const quiet = !d.legacy && !(d.live_doors > 0);
    const quietNote = quiet && door ? `\n${QUIET_HINT}` : '';
    const doorWho = door ? (door.name || String(door.peer_id || '').replace(/^peer:/, '')) : '';
    // No cloning, one dimension at a time: my top character (unit clicks + New Door) / any of the top `count`
    // (Join my team) alive in ANY dimension → disabled, the tooltip names where.
    // Live presence anywhere (aliveAt), plus any alive record of THIS dimension (no second copy of me in it).
    const here = has ? new Map([...aliveMine(d, chars, { anyAge: true }).map(c => [c.id, d.dimension_name]), ...aliveAt]) : aliveAt;
    const topAlive = has ? [chars[0]].filter(c => here.has(c.id)) : [];
    const teamAlive = has ? chars.slice(0, Math.max(1, count)).filter(c => here.has(c.id)) : [];
    const aliveWhy = (list) => list.length ? aliveWhereText(list, here) : '';
    const why = !has ? 'create a character first' : !door ? (d.legacy ? 'older format — cannot join' : 'no Door in this dimension') : aliveWhy(topAlive);
    const teamWhy = (!has || !door ? why : '') || (count < 2 ? 'needs 2+ characters (see Test my team)' : '') || aliveWhy(teamAlive);
    const third = dimNewSide(d);
    const noSide = !d.legacy && !third ? NO_FREE_SIDE : '';
    const thirdText = `as a new team (${sideLabel(third)}${third === 'player' ? ' side' : ''}) — not allied with the units there`;
    const share = dimShareText(d);
    const head = h('div', { class: 'pp-dim-head' },
      h('span', { class: 'pp-dim-name', text: d.dimension_name }),
      h('span', { class: `pp-badge${d.live_doors > 0 ? ' is-live' : ''}`, text: d.legacy ? 'legacy' : d.live_doors > 0 ? `LIVE · turn ${d.turn ?? 0}` : 'quiet',
        title: quiet ? QUIET_HINT : undefined }),
      h('span', { class: 'pp-hint', text: `${d.live_doors}/${(d.doors || []).length} door${(d.doors || []).length === 1 ? '' : 's'} · ${agoText(d.age_sec)}` }),
      stats,
      share ? h('span', { class: 'pp-share', text: share,
        title: `exact, from the Doors' map blocks:${d.map_share_median != null ? `\nthe median Door holds ${pctText(d.map_share_median)} of the ${(Number(d.hexes) || 0).toLocaleString('en-US')} known hexes` : ''}${d.mine_cover != null ? `\nmy saved copy (${(Number(d.mine_hexes) || 0).toLocaleString('en-US')} hexes) covers ${pctText(d.mine_cover)} of them` : ''}` }) : null,
      del);
    // Exactly two Door options per dimension (user ruling 2026-11-15); quiet dimensions too (from a stale Door).
    const acts = h('div', { class: 'pp-dim-acts' },
      h('button', { type: 'button', class: 'pp-btn pp-join-top', text: '⚑ New Door · Join top character', disabled: !!(why || noSide),
        title: why || noSide || `${chars[0].name} opens a new Door 30–50 hexes from ${doorWho}'s Door ${thirdText}; your team there sees the new gate${quietNote}`,
        onclick: () => launchJoinTeam(d.dimension_name, door.peer_id) }),
      h('button', { type: 'button', class: 'pp-btn pp-join-team', text: '⚑ Join my team', disabled: !!(teamWhy || noSide),
        title: teamWhy || noSide || `the top ${count} of your team (count + tier from "Test my team") arrive 30–50 hexes from ${doorWho}'s Door ${thirdText}${quietNote}`,
        onclick: () => {
          const n = Number(document.getElementById('pp-team-count')?.value) || 0;
          const tier = document.getElementById('pp-team-tier')?.value || 'strong';
          launchJoinTeam(d.dimension_name, door.peer_id, n, tier);
        } }),
      quiet && door ? h('span', { class: 'pp-hint pp-quiet', text: QUIET_HINT }) : null);
    // One chip per Door (live first): who holds it, side, hp, and its exact map share.
    const doorsBox = h('div', { class: 'pp-doors' });
    const ordered = [...(d.doors || [])].sort((a, b) => (b.live - a.live) || ((a.age_sec ?? 1e12) - (b.age_sec ?? 1e12)));
    for (const p of ordered.slice(0, DOORS_SHOWN)) {
      const who = p.name || String(p.peer_id || '').replace(/^peer:/, '');
      const sh = doorShareText(p);
      doorsBox.append(h('span', { class: `pp-door side-${sideClass(p.alliance)}${p.live ? '' : ' is-stale'}${(p.life ?? 1) <= 0 ? ' is-dead' : ''}`,
        title: `${who}'s Door\nside: ${p.alliance}\ndoor: ${p.peer_id}${p.tile ? `\ntile: (${p.tile.q},${p.tile.r})` : ''}\npushed: ${agoText(p.age_sec)}${p.live ? '' : ' (stale)'}`
          + (p.map_share != null ? `\nmap: ${(Number(p.map_hexes) || 0).toLocaleString('en-US')} hexes = ${pctText(p.map_share)} of this dimension's known hexes` : '\nmap: no blocks in this Door (older build)')
          + (p.mine_share != null ? `\nshared with my copy: ${pctText(p.mine_share)} of my saved hexes` : '') },
        h('span', { class: 'pp-dot' }),
        h('span', { class: 'pp-door-name', text: who }),
        h('span', { class: 'pp-door-side', text: sideLabel(p.alliance) }),
        p.life != null && p.life_max != null ? h('span', { class: 'pp-door-hp', text: `${p.life}/${p.life_max}` }) : null,
        sh ? h('span', { class: 'pp-door-share', text: sh }) : null,
        p.live ? null : h('span', { class: 'pp-door-age', text: agoText(p.age_sec) })));
    }
    if (ordered.length > DOORS_SHOWN) doorsBox.append(h('span', { class: 'pp-hint', text: `+${ordered.length - DOORS_SHOWN} more Doors` }));
    // Alive units the Doors know, by group; click a name → my top character joins next to it as its ally.
    const unitsBox = h('div', { class: 'pp-units' });
    const units = d.units || [];
    const asWho = has ? chars[0].name : 'a random character';
    for (const [g, label] of UNIT_GROUPS) {
      const list = units.filter(u => (u.group || unitGroupOf(u.alliance)) === g);
      const total = Math.max(list.length, Number(d.units_alive?.[g]) || 0);
      if (!total) continue;
      const row = h('div', { class: `pp-unit-group grp-${g}` }, h('span', { class: 'pp-unit-label', text: `${label} ${total}` }));
      for (const u of list.slice(0, UNITS_SHOWN)) {
        const body = unitJoinBody(d.dimension_name, u);
        const where = body.nearTile ? ` at (${body.nearTile.q},${body.nearTile.r})` : '';
        const tip = topAlive.length ? aliveWhy(topAlive) : g === 'monster'
          ? `join next to ${u.name}${where} as ${asWho}, its ally — you play on the monsters' side (npc_b): they leave you alone, the players are your foes`
          : `join next to ${u.name}${where} as ${asWho}, its ally (${sideLabel(body.side)})`;
        row.append(h('button', { type: 'button', class: `pp-unit grp-${g}${u.via_live ? '' : ' is-stale'}`, disabled: !!d.legacy || topAlive.length > 0,
          title: `${tip}\n${u.name}: ${sideLabel(u.alliance)}${u.life != null ? `, hp ${u.life}${u.life_max != null ? `/${u.life_max}` : ''}` : ''}, last seen ${agoText(u.age_sec)} (via ${u.via})${u.via_live ? '' : `\n${QUIET_HINT}`}`,
          onclick: () => launchProfile(body, `${d.dimension_name}: next to ${u.name} as ${body.side === 'npc_b' ? 'an ally of the monsters' : sideLabel(body.side)}${u.via_live ? '' : ' (quiet — starting it from its Doors)'}`) },
          h('span', { class: 'pp-unit-name', text: u.name }),
          u.life != null ? h('span', { class: 'pp-door-hp', text: u.life_max != null ? `${u.life}/${u.life_max}` : String(u.life) }) : null,
          ...unitTags(u).map(t => h('span', { class: `pp-unit-tag ${t.cls}`, text: t.text, title: t.title })),
          (u.age_sec ?? 0) >= 90 ? h('span', { class: 'pp-door-age', text: agoText(u.age_sec) }) : null));
      }
      if (total > Math.min(list.length, UNITS_SHOWN)) row.append(h('span', { class: 'pp-hint', text: `+${total - Math.min(list.length, UNITS_SHOWN)} more` }));
      unitsBox.append(row);
    }
    if (!unitsBox.childNodes.length && ordered.length) unitsBox.append(h('span', { class: 'pp-hint', text: `no alive units known${d.units_dead ? ` (${d.units_dead} dead)` : ''}` }));
    // "You are here": each of my characters alive in this dimension (live or stale record) + "↻ Restore <name> here"
    // — it comes back at its last tile with its last life (a live shadow of it is taken over) and the dimension's
    // Door is pushed at once, so other nodes list it LIVE. Greyed while it is LIVE in another dimension.
    const hereRecs = has ? myAliveRecords(d, chars) : [];
    const hereBox = hereRecs.length ? h('div', { class: 'pp-here' }, h('b', { class: 'pp-here-head', text: 'You are here' }),
      ...hereRecs.map(({ character: c, rec: m }) => {
        const elsewhere = aliveWhere((items || []).filter(x => x.dimension_name !== d.dimension_name), [c]);
        const block = elsewhere.has(c.id) ? aliveWhereText([c], elsewhere) : '';
        return h('div', { class: 'pp-here-row' },
          h('span', { class: 'pp-here-line', text: hereLineText(c, m) }),
          h('button', { type: 'button', class: 'pp-btn pp-restore-here', text: `↻ Restore ${c.name} here`, disabled: !!block || !!S.busy,
            title: block || `${c.name} comes back here under its own id at its last tile with ${m.life ?? 'its'} life${m.shadow_of ? ', taking over its shadow' : ''}; the dimension's Door is published at once, so the other nodes see it LIVE${m.live && !m.shadow_of ? '\nits record is fresh — if another device plays it, that copy is replaced' : ''}`,
            onclick: () => launchProfile(launchBody.restoreHere(d.dimension_name, c.id), `${d.dimension_name}: restoring ${c.name} at its last tile`) }),
          dimOutButton(d.dimension_name, c, m, block));
      })) : null;
    box.append(h('div', { class: `pp-dim${d.live_doors > 0 ? ' is-live' : ''}${d.legacy ? ' is-legacy' : ''}${quiet ? ' is-quiet' : ''}${hereRecs.length ? ' is-mine' : ''}` }, head, hereBox, acts, ordered.length ? doorsBox : null, ordered.length ? unitsBox : null));
  }
  if (items.length > DIMS_SHOWN) {
    box.append(h('button', { type: 'button', class: 'pp-btn pp-small pp-more', text: S.dimsAll ? 'show fewer' : `show ${items.length - DIMS_SHOWN} more`,
      onclick: () => { S.dimsAll = !S.dimsAll; renderDims(); } }));
  }
}

// Radicle sync (profile-radicle.mjs): the team branch teams/<Team> on chaosD6-Profiles.
const SYNC_ICON = { synced: '✅', offline: '📴', 'awaiting-approval': '⏳', 'no-team': '✏️', 'not-configured': '⚙️', error: '⚠️', starting: '…', off: '—' };
export const syncLine = (st) => `${SYNC_ICON[st?.state] || '•'} Radicle: ${st?.message || st?.state || 'unknown'}`;
export const shortDeviceId = (id) => (id ? `${id.slice(0, 8)}…${id.slice(-4)}` : '');
function renderSync() {
  const box = document.getElementById('pp-sync');
  if (!box) return;
  const st = S.sync;
  box.innerHTML = '';
  if (!st) { box.append(h('div', { class: 'pp-sync-line', text: '… Radicle sync: checking' })); return; }
  box.classList.toggle('bad', ['error', 'awaiting-approval', 'offline'].includes(st.state));
  box.append(h('div', { class: 'pp-sync-line', text: syncLine(st) }));
  if (st.id) {
    const idEl = h('code', { class: 'pp-devid', text: shortDeviceId(st.id), title: `this device's key: ${st.id} (tap to show it all)` });
    idEl.addEventListener('click', () => { idEl.textContent = idEl.textContent === st.id ? shortDeviceId(st.id) : st.id; });
    box.append(h('div', { class: 'pp-sync-meta' }, 'this device ', idEl,
      st.ref ? ` · branch ${st.ref.replace(/^refs\/heads\//, '')}` : '',
      st.owners?.length ? ` · ${st.owners.length} device${st.owners.length === 1 ? '' : 's'}` : '',
      ' ', h('button', { type: 'button', class: 'pp-btn pp-small', text: '↻ Sync now', onclick: syncNow })));
  }
  // No team yet (or the name is taken by other keys): name it here; the first sync claims teams/<slug>.
  if (st.state === 'no-team' || st.state === 'awaiting-approval') {
    const preview = h('span', { class: 'pp-hint' });
    const nameIn = h('input', { type: 'text', id: 'pp-team-in', class: 'pp-team-in', maxLength: 30, placeholder: 'team name', value: S.profile?.team_name || '' });
    const upd = () => { const s = teamSlugUI(nameIn.value); preview.textContent = s ? `→ branch teams/${s}` : 'letters or digits needed'; claim.disabled = !s; };
    const claim = h('button', { type: 'button', class: 'pp-btn pp-small', text: st.state === 'no-team' ? 'Save team name' : 'Use this name',
      title: 'saves the team name; the first device to sync it owns the branch (it cannot be deleted)', onclick: () => saveTeamName(nameIn.value) });
    nameIn.addEventListener('input', upd);
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !claim.disabled) saveTeamName(nameIn.value); });
    upd();
    box.append(h('div', { class: 'pp-sync-team' }, 'Team ', nameIn, ' ', claim, ' ', preview));
  }
  for (const r of st.requests || []) {
    box.append(h('div', { class: 'pp-sync-req' },
      `📱 ${r.label || 'a device'} asks to join ${st.team}: `, h('code', { class: 'pp-devid', text: shortDeviceId(r.id), title: r.id }), ' ',
      h('button', { type: 'button', class: 'pp-btn pp-small', text: 'Approve', title: `add ${r.id} to the owners of ${st.ref}`, onclick: (ev) => approveDevice(r, ev.currentTarget) })));
  }
}
// Same slug rule as profile-auth.mjs teamSlug (the branch name).
export const teamSlugUI = (team) => String(team || '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').trim()
  .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40);
async function saveTeamName(name) {
  try {
    const out = await api('PUT', '/api/profile/team', { team_name: String(name).trim() });
    S.profile = out.profile || S.profile;
    renderPanel();
    await syncNow();
    editorLogin();
  } catch (e) { setMsg(e.message, true); }
}
async function applySync(st) {
  const moved = S.sync && st && st.oid && st.oid !== S.sync.oid;
  const same = JSON.stringify(st) === JSON.stringify(S.sync);
  // Team / owners changed (name saved, this device approved, a device added) → the rules editor signs in again.
  const edKey = (x) => `${x?.state}|${x?.team}|${(x?.owners || []).join(',')}`;
  const relogin = S.sync && edKey(S.sync) !== edKey(st);
  S.sync = st;
  if (relogin) editorLogin();
  if (same) return;
  if (moved && !document.getElementById('pe-overlay')) { await reloadProfile().catch(() => {}); renderPanel(); } else renderSync();
}
async function syncNow() {
  try { await applySync(await api('POST', '/api/profile/sync')); } catch (e) { setMsg(e.message, true); }
}
// Two taps (no confirm(): the phone's WebView may not show dialogs).
async function approveDevice(r, btn) {
  if (btn && btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Tap again: same rights as this device';
    setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; btn.textContent = 'Approve'; } }, 6000);
    return;
  }
  try { await applySync(await api('POST', '/api/profile/sync/approve', { id: r.id })); setMsg(`approved ${shortDeviceId(r.id)}`); } catch (e) { setMsg(e.message, true); }
}

// Rules editor (EDITOR_SPEC: game/editor-api.mjs). The team identity IS the device key: signed in = the profile has
// a team name and this device is one of its owners. Desktop opens /rules/ in a new tab; the phone's menu WebView
// has no tabs, so it navigates in place (its menu server mounts /rules/ too).
export const rulesEditorUrl = (kind = null) => `/rules/${kind ? `#/new/${kind}` : ''}`;
export function editorStatus(ses) {
  if (!ses) return { text: 'editor unavailable', bad: true };
  if (ses.logged_in) return { text: `Signed in as ${ses.team?.name || '?'} · ${shortDeviceId(ses.identity?.id)}`, note: 'you can add skills, effects and classes' };
  if (ses.reason === 'no team') return { text: 'Read-only — set a team name below to sign in', action: 'team' };
  if (ses.reason === 'not an owner') return { text: "Read-only — waiting for the team owner's approval" };
  return { text: `Read-only — ${ses.reason || 'not signed in'}` };
}
function openRulesEditor(kind = null) {
  const url = rulesEditorUrl(kind);
  if (IS_MENU || IS_MOBILE) { location.href = url; return; }
  if (!window.open(url, '_blank')) location.href = url;   // popup blocked → same tab
}
async function editorSession() {
  try { S.editor = await api('GET', '/rules/api/editor/session'); } catch { S.editor = null; }
  renderEditorRow();
}
async function editorLogin() {
  if (!S.editor?.token) return editorSession();
  try {
    const r = await fetch('/rules/api/editor/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Editor-Token': S.editor.token }, body: '{}' });
    const out = await r.json();
    if (!r.ok || out?.ok === false) throw new Error(out?.error || `HTTP ${r.status}`);
    S.editor = out;
    renderEditorRow();
  } catch { await editorSession(); }   // token from an older server start → fetch a fresh session
}
const focusTeamInput = () => {
  const el = document.getElementById('pp-team-in') || document.getElementById('pp-sync');
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (el?.tagName === 'INPUT') el.focus();
};
function renderEditorRow() {
  const ctl = document.getElementById('pp-ed-ctl'), side = document.getElementById('pp-ed-side');
  if (!ctl || !side) return;
  ctl.innerHTML = ''; side.innerHTML = '';
  if (S.editor === undefined) { side.append(h('span', { class: 'pp-hint', text: 'editor: checking…' })); return; }
  const st = editorStatus(S.editor);
  if (S.editor?.logged_in) {
    for (const k of S.editor.kinds || ['skill', 'effect', 'class']) {
      ctl.append(h('button', { type: 'button', class: 'pp-btn pp-small pp-alt', text: `New ${k}`, title: `author a new ${k} on your team branch (validated + rebalancing check)`, onclick: () => openRulesEditor(k) }));
    }
  }
  side.append(h('span', { class: `pp-hint${st.bad ? ' bad' : ''}`, text: st.text, title: S.editor?.identity?.id || undefined }));
  if (st.note) side.append(h('span', { class: 'pp-hint', text: st.note }));
  if (st.action === 'team') side.append(h('button', { type: 'button', class: 'pp-btn pp-small', text: 'Set team name', onclick: focusTeamInput }));
}

let _syncTimer = null;
function pollSync() {
  clearInterval(_syncTimer);
  const tick = () => api('GET', '/api/profile/sync').then(applySync).catch(() => {});
  tick();
  _syncTimer = setInterval(() => { if (!document.getElementById('pp-sync')) return; tick(); }, 5000);
}

// Builds the panel inside `root` (#profile-panel). Resolves once the profile is loaded (or failed).
export async function initProfilePanel(root) {
  if (!root) return;
  S.body = root.querySelector('.pp-body') || root;
  S.body.textContent = 'loading your profile…';
  await Promise.all([
    reloadProfile().catch((e) => { S.error = e.message; S.profile = null; }),
    loadLocal(),
  ]);
  renderPanel();
  if (!S.error) pollSync();
  editorSession();
  loadDims(false);
}

// ---------------------------------------------------------------------------------------------
// Modal
let _escHandler = null;
function closeModal() {
  document.getElementById('pe-overlay')?.remove();
  if (_escHandler) { document.removeEventListener('keydown', _escHandler); _escHandler = null; }
}
function openModal(title, cls) {
  closeModal();
  const body = h('div', { class: 'pe-body' });
  const foot = h('div', { class: 'pe-foot' });
  const card = h('div', { class: `pe-modal ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'pe-head' }, h('span', { class: 'pe-title', text: title }), h('button', { type: 'button', class: 'pe-x', title: 'close without saving (Esc)', text: '✕', onclick: closeModal })),
    body, foot);
  // No close on a backdrop tap: a stray touch must not throw away a half-made character.
  document.body.append(h('div', { id: 'pe-overlay', class: 'pe-overlay' }, card));
  _escHandler = (ev) => { if (ev.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', _escHandler);
  return { body, foot };
}
const section = (title, ...kids) => h('div', { class: 'pe-sec' }, h('div', { class: 'pe-sec-title' }, title), ...kids);
const lockTag = () => h('span', { class: 'pe-lock', title: 'fixed once the character was created', text: '🔒 locked' });
const STAT_LABEL = { vitality: 'Vitality', world: 'World', matter: 'Matter', will: 'Will' };

// Create (POST draft → editable template) or Edit (deck only) a character.
async function openCharacterEditor(mode, charId) {
  const create = mode === 'create';
  setMsg(create ? 'rolling a new character…' : 'opening the editor…');
  let cat, c;
  try {
    cat = await getCatalog();
    if (create) c = (await api('POST', '/api/profile/draft')).character;
    else {
      await reloadProfile();
      const x = (S.profile.characters || []).find(y => y.id === charId);
      if (!x) throw new Error('no such character');
      c = structuredClone(x);
    }
  } catch (e) { setMsg(`failed: ${e.message}`, true); return; }
  setMsg('');
  const L = { ...DEFAULT_LIMITS, ...(cat.limits || {}), ...S.limits };
  const skills = new Map((cat.skills || []).map(x => [x.id, x]));
  const effects = new Map((cat.effects || []).map(x => [x.id, x]));
  const classes = new Map((cat.classes || []).map(x => [x.id, x]));
  const units = cat.units || [];
  const unitKey = (u) => `${u.kind}:${u.id}`;
  c.stats ||= {}; c.actions ||= {}; c.cards ||= [];

  const { body, foot } = openModal(create ? 'Create a new character' : `Edit ${c.name} — deck only`, 'pe-char');
  const left = h('div', { class: 'pe-col pe-ident' });
  const right = h('div', { class: 'pe-col pe-deck' });
  body.append(left, right);

  // Name
  const nameIn = h('input', { type: 'text', class: 'pe-name', maxLength: 40, value: c.name || '', disabled: !create,
    oninput: () => { c.name = nameIn.value; refresh(); } });
  left.append(section(['Name ', !create && lockTag()], nameIn));

  // Stats (Σ must be STAT_SUM)
  const statsBox = h('div', { class: 'pe-stats' });
  const sumEl = h('span', { class: 'pe-sum' });
  function renderStats() {
    statsBox.innerHTML = '';
    for (const k of L.STAT_KEYS) {
      const v = c.stats[k] | 0;
      const step = (d, label) => h('button', { type: 'button', class: 'pe-step', text: label, disabled: d < 0 ? v <= L.STAT_MIN : v >= L.STAT_MAX,
        title: `${d < 0 ? 'lower' : 'raise'} ${STAT_LABEL[k] || k}`, onclick: () => { c.stats = bumpStat(c.stats, k, d, L); renderStats(); refresh(); } });
      statsBox.append(h('div', { class: `pe-stat st-${k}` },
        h('span', { class: 'pe-stat-name', text: STAT_LABEL[k] || k }),
        create ? step(-1, '−') : null,
        h('span', { class: 'pe-stat-val', text: String(v) }),
        create ? step(+1, '+') : null));
    }
    const s = statSum(c.stats, L.STAT_KEYS);
    sumEl.textContent = s === L.STAT_SUM ? `Σ ${s}` : `Σ ${s} / ${L.STAT_SUM}`;
    sumEl.classList.toggle('bad', s !== L.STAT_SUM);
    sumEl.title = `the four stats must sum to ${L.STAT_SUM}, each ${L.STAT_MIN}–${L.STAT_MAX}`;
  }
  renderStats();
  left.append(section(['Stats ', sumEl, ' ', !create && lockTag()], statsBox));

  // Class
  const classText = h('div', { class: 'pe-class-text' });
  const showClass = () => { const k = classes.get(c.class_id); classText.textContent = k ? (k.text || '—') : `unknown class ${c.class_id}`; };
  const classCtl = create
    ? sel([...classes.values()].map(k => ({ value: k.id, text: k.name })), c.class_id, { class: 'pe-select', onchange: (ev) => { c.class_id = ev.target.value; showClass(); refresh(); } })
    : h('div', { class: 'pe-fixed', text: classes.get(c.class_id)?.name || prettyId(c.class_id) });
  showClass();
  left.append(section(['Class ', !create && lockTag()], classCtl, classText));

  // Unit resources (Warlords III Battlecry unit: portrait, sprites, sounds)
  const portrait = h('img', { class: 'pe-portrait', alt: '' });
  const unitName = h('div', { class: 'pe-unit-name' });
  let audio = null;
  const curUnit = () => units.find(u => u.kind === c.resources?.kind && u.id === c.resources?.id) || null;
  const playBtn = h('button', { type: 'button', class: 'pe-play', text: '▶', title: "play the unit's voice", onclick: () => {
    const u = curUnit();
    if (!u?.sound) return;
    try { audio?.pause(); audio = new Audio(assetUrl(u.sound)); audio.play().catch(() => {}); } catch { /* no audio */ }
  } });
  function showUnit() {
    const u = curUnit();
    const src = assetUrl(u?.portrait);
    portrait.hidden = !src;
    if (src) portrait.src = src;
    unitName.textContent = u ? `${u.unit}${u.race ? ` (${u.race})` : ''}` : 'unknown unit';
    playBtn.disabled = !u?.sound;
  }
  const unitCtl = create
    ? sel(units.map(u => ({ value: unitKey(u), text: `${u.name} — ${u.unit}${u.race ? ` (${u.race})` : ''}` })), c.resources ? `${c.resources.kind}:${c.resources.id}` : null, {
      class: 'pe-select', onchange: (ev) => {
        const u = units.find(x => unitKey(x) === ev.target.value);
        if (!u) return;
        c.resources = { kind: u.kind, id: u.id };
        // Same rule as profile.mjs newDraft: a character unit is also the base character the peer reads.
        if (u.kind === 'character' && (cat.base_characters || []).some(b => b.id === u.id)) c.base_character = u.id;
        showUnit(); refresh();
      } })
    : null;
  showUnit();
  left.append(section(['Unit ', !create && lockTag()], unitCtl, h('div', { class: 'pe-unit' }, portrait, h('div', { class: 'pe-unit-meta' }, unitName, playBtn))));

  // Combo (random, never editable)
  left.append(section(['Combo ', h('span', { class: 'pe-lock', text: '🎲 random, fixed' })],
    h('div', { class: 'pe-combo' }, (c.combo || []).map(k => h('span', { class: `pe-combo-k act-${k}`, title: ACTION_HELP[k]?.name || k, text: `${ACTION_HELP[k]?.icon || ''} ${k}` })))));

  // Action cards A/B/M/P
  const actBox = h('div', { class: 'pe-actions' });
  function renderActions() {
    actBox.innerHTML = '';
    for (const k of L.ACTION_CODES) {
      const v = c.actions[k] | 0;
      actBox.append(h('div', { class: `pe-act act-${k}`, title: ACTION_HELP[k]?.full || k },
        h('span', { class: 'pe-act-name', text: `${ACTION_HELP[k]?.icon || ''} ${k} ${ACTION_HELP[k]?.name || ''}` }),
        h('button', { type: 'button', class: 'pe-step', text: '−', disabled: v <= 0, onclick: () => { c.actions = bumpAction(c.actions, k, -1, L); renderActions(); refresh(); } }),
        h('span', { class: 'pe-stat-val', text: String(v) }),
        h('button', { type: 'button', class: 'pe-step', text: '+', disabled: v >= L.ACTION_MAX, onclick: () => { c.actions = bumpAction(c.actions, k, +1, L); renderActions(); refresh(); } })));
    }
  }
  renderActions();
  const deckEl = h('span', { class: 'pe-deckcount' });
  right.append(section(['Deck ', deckEl], actBox));

  // Skills + effects: each in the deck or the archive
  const cardsBox = h('div', { class: 'pe-cards' });
  // Cards that were new when the editor opened stay on top for the whole session (tapping one must not
  // make it jump away into the archive list).
  const wonNow = new Set(c.cards.filter(x => x.new).map(x => x.uid));
  let dirty = false;
  function renderCards() {
    cardsBox.innerHTML = '';
    // New cards (taken from kills) first, then skills, then effects.
    const rank = (x) => (wonNow.has(x.uid) ? 0 : 2) + (x.kind === 'skill' ? 0 : 1);
    const sorted = [...c.cards].sort((a, b) => rank(a) - rank(b));
    for (const x of sorted) {
      const info = (x.kind === 'skill' ? skills : effects).get(x.id);
      const inDeck = x.where === 'deck';
      const elems = (info?.elements || []).map(e => prettyId(e)).join(' ');
      const flags = cardFlags(x.kind, info);
      // Player-branch effect / skill (chaosD6-Effects / -Skills): source badge; built-in (main) ones show nothing.
      const src = effectSource(x.source ? x : null) || effectSource(info?.source ? info : null) || effectSource(x.id);
      cardsBox.append(h('button', {
        type: 'button', class: `pe-card kind-${x.kind}${inDeck ? ' in-deck' : ' in-archive'}${x.new ? ' is-new' : ''}`,
        title: `${info?.name || x.ref?.name || prettyId(x.id)} — ${info?.text || ''}${x.from ? `\n(taken from ${x.from})` : ''}\n\ntap: move to the ${inDeck ? 'archive' : 'deck'}`,
        onclick: () => {
          // The first tap on a new card acknowledges it (stops the glow, saved at once) and takes it from
          // the archive into the deck; further taps move it between the deck and the archive.
          if (x.new) {
            x.new = false;
            if (!create) api('PUT', `/api/profile/characters/${encodeURIComponent(c.id)}`, { seen: [x.uid] })
              .then(out => { if (out.profile) { S.profile = out.profile; renderPanel(); } }).catch(() => {});
            if (!inDeck) { x.where = 'deck'; dirty = true; }
          } else { x.where = inDeck ? 'archive' : 'deck'; dirty = true; }
          renderCards(); refresh();
        },
      },
      h('span', { class: 'pe-card-head' },
        x.new ? h('span', { class: 'pe-card-new', text: '✨ new' }) : null,
        h('span', { class: 'pe-card-kind', text: x.kind === 'skill' ? 'skill' : 'effect' }),
        h('b', { class: 'pe-card-name', text: info?.name || x.ref?.name || prettyId(x.id) }),
        elems ? h('span', { class: 'pe-card-elems', text: elems }) : null),
      flags.length ? h('span', { class: 'pe-card-flags' }, ...flags.map(t => h('span', { class: `pe-flag${t === 'perm' ? ' perm' : ''}`, text: t }))) : null,
      h('span', { class: 'pe-card-text', text: shortText(info?.text, 120) }),
      src ? makeSourceBadge(src) : null,
      x.from ? h('span', { class: 'pe-card-from', text: `🏆 from ${x.from}` }) : null,
      h('span', { class: 'pe-where', text: inDeck ? '▣ Deck' : '▢ Archive' })));
    }
  }
  renderCards();
  right.append(section(['Skills & effects ', h('span', { class: 'pe-lock', text: 'tap a card: Deck ⇄ Archive' })], cardsBox));

  // Footer: problems / server error, Cancel, Save
  const errEl = h('div', { class: 'pe-err' });
  const saveBtn = h('button', { type: 'button', class: 'pe-save', text: create ? 'Create character' : 'Save deck' });
  foot.append(errEl, h('button', { type: 'button', class: 'pe-cancel', text: 'Cancel', onclick: closeModal }), saveBtn);
  function refresh() {
    const d = deckCount(c, L.ACTION_CODES);
    const arch = c.cards.filter(x => x.where !== 'deck').length;
    deckEl.textContent = `${d} card${d === 1 ? '' : 's'} (min ${L.DECK_MIN}) · archive ${arch}`;
    deckEl.classList.toggle('bad', d < L.DECK_MIN);
    const probs = draftProblems(c, L, { create });
    saveBtn.disabled = probs.length > 0;
    errEl.classList.remove('bad');
    errEl.textContent = probs.length ? `to save: ${probs.join(' · ')}` : create ? 'stats, class, unit and name lock once created' : dirty ? 'deck changed — tap Save deck to keep it' : '';
  }
  refresh();
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    errEl.textContent = 'saving…';
    try {
      const out = create
        ? await api('POST', '/api/profile/characters', { character: c })
        : await api('PUT', `/api/profile/characters/${encodeURIComponent(c.id)}`, { actions: c.actions, cards: c.cards.map(({ uid, where }) => ({ uid, where })) });
      if (out.profile) S.profile = out.profile; else await reloadProfile();
      closeModal();
      renderPanel();
      setMsg(create ? `${c.name} created — stats, class and unit are now locked` : `${c.name}'s deck saved`);
    } catch (e) {
      refresh();
      errEl.textContent = `not saved: ${e.message}`;
      errEl.classList.add('bad');
    }
  });
}

// Team name + priority order (top joins on links; the order also drives "Test my team").
function openTeamEditor() {
  const chars = orderedCharacters(S.profile);
  const byId = new Map(chars.map(c => [c.id, c]));
  let order = chars.map(c => c.id);
  const { body, foot } = openModal('Edit my team', 'pe-team');
  const nameIn = h('input', { type: 'text', class: 'pe-name', maxLength: 30, value: S.profile?.team_name || '', placeholder: 'team name', oninput: () => renderList() });
  body.append(section('Team name', nameIn));
  const list = h('ol', { class: 'pe-team-list' });
  body.append(section(['Priority ', h('span', { class: 'pe-lock', text: 'top joins on links · Test my team takes them in this order' })], list));
  let dragFrom = -1;
  function renderList() {
    list.innerHTML = '';
    const team = nameIn.value.trim();
    order.forEach((id, i) => {
      const c = byId.get(id);
      const li = h('li', { class: `pe-member${i === 0 ? ' is-top' : ''}`, draggable: true },
        h('span', { class: 'pe-rank', text: `#${i + 1}` }),
        h('span', { class: 'pe-member-name', text: teamMemberLabel(c.name, team) }),
        i === 0 ? h('span', { class: 'pe-top', text: '★ joins on links' }) : null,
        h('span', { class: 'pe-member-moves' },
          h('button', { type: 'button', class: 'pe-step', text: '↑', title: 'move up', disabled: i === 0, onclick: () => { order = moveItem(order, i, -1); renderList(); } }),
          h('button', { type: 'button', class: 'pe-step', text: '↓', title: 'move down', disabled: i === order.length - 1, onclick: () => { order = moveItem(order, i, +1); renderList(); } })));
      // Mouse drag (desktop) as a shortcut for the arrows.
      li.addEventListener('dragstart', () => { dragFrom = i; li.classList.add('dragging'); });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', (ev) => ev.preventDefault());
      li.addEventListener('drop', (ev) => {
        ev.preventDefault();
        if (dragFrom < 0 || dragFrom === i) return;
        const a = [...order]; const [m] = a.splice(dragFrom, 1); a.splice(i, 0, m);
        order = a; dragFrom = -1; renderList();
      });
      list.append(li);
    });
  }
  renderList();
  const errEl = h('div', { class: 'pe-err' });
  const saveBtn = h('button', { type: 'button', class: 'pe-save', text: 'Save team' });
  foot.append(errEl, h('button', { type: 'button', class: 'pe-cancel', text: 'Cancel', onclick: closeModal }), saveBtn);
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    errEl.textContent = 'saving…';
    try {
      const out = await api('PUT', '/api/profile/team', { team_name: nameIn.value.trim(), order });
      if (out.profile) S.profile = out.profile; else await reloadProfile();
      closeModal();
      renderPanel();
      setMsg('team saved');
    } catch (e) {
      saveBtn.disabled = false;
      errEl.textContent = `not saved: ${e.message}`;
      errEl.classList.add('bad');
    }
  });
}
