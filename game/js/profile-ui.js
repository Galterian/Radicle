// Profile panel + character / team editors (user ruling 2026-11-13).
//
// The launcher shows a "Your profile" panel under the Launch button: test one of my characters, test a
// random one, create / edit a character, edit my team, test my team, join my team next to a Door. The
// phone's menu server serves the same page with ?mobile=1&menu=1 — there only this panel is shown.
// All data comes from the profile API (game/profile.mjs handleProfileApi):
//   GET /api/profile · GET /api/profile/catalog · POST /api/profile/draft
//   POST /api/profile/characters {character} · PUT /api/profile/characters/<id> {actions, cards}
//   PUT /api/profile/team {team_name, order}
// and launches go through POST /api/launch {mode: test-character | test-random | test-team | join-team}.
//
// The top of this file is pure (no DOM) so a node script can import and check the helpers.
import { ACTION_HELP } from './rules_text.js';

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
  joinTeam: (dimensionName, doorId) => ({ mode: 'join-team', dimensionName, doorId }),
};
export const shortText = (t, n = 140) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};
export const prettyId = (id) => String(id || '').replace(/^(class|skill|effect|elem|char|mon)_/, '').replace(/_/g, ' ');
// Repo-relative asset path (assets/…) → URL the server answers (/assets/…); same as sprites.js assetUrl.
export const assetUrl = (p) => p ? `/${String(p).replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}` : null;

// ---------------------------------------------------------------------------------------------
// DOM
const S = { profile: null, limits: DEFAULT_LIMITS, catalog: null, error: null, busy: false, body: null, sync: null };

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
export const launchJoinTeam = (dimensionName, doorId) =>
  launchProfile(launchBody.joinTeam(dimensionName, doorId), `${joinTeamLabel(S.profile?.team_name)} — arriving 30–50 hexes from the Door`);

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
  const row = (...kids) => h('div', { class: 'pp-row' }, ...kids);
  const btn = (text, onclick, props = {}) => h('button', { type: 'button', class: 'pp-btn', text, onclick, ...props });

  // Test my character <select>
  const testSel = sel(charOpts, top?.id, { class: 'pp-select', disabled: !has, title: 'which character to test' });
  root.append(row(btn('Test my character', () => launchProfile(launchBody.testCharacter(testSel.value), `test game as ${chars.find(c => c.id === testSel.value)?.name || 'my character'}`), { disabled: !has }), testSel));
  // Test a random character
  root.append(row(btn('Test a random character', () => launchProfile(launchBody.testRandom(), 'test game with a random character'))));
  // Create a new character
  root.append(row(btn('Create a new character', () => openCharacterEditor('create'), { disabled: !!S.error })));
  // Edit a character profile <select>
  const editSel = sel(charOpts, top?.id, { class: 'pp-select', disabled: !has, title: 'which character to edit' });
  root.append(row(btn('Edit a character profile', () => openCharacterEditor('edit', editSel.value), { disabled: !has }), editSel));
  // Edit my team
  root.append(row(btn('Edit my team', openTeamEditor, { disabled: !has })));
  // Test my team <count> <tier>
  const counts = teamCountOptions(chars.length);
  const countSel = sel(counts.length ? counts.map(n => ({ value: n, text: `${n} characters` })) : [{ value: '', text: 'needs 2+ characters' }],
    counts.length ? counts[counts.length - 1] : '', { class: 'pp-select pp-small', disabled: !counts.length, title: 'how many of my characters (top first)' });
  const tierSel = sel([
    { value: 'reachable', text: 'Reachable (9–10 hexes)' },
    { value: 'strong', text: 'Strong (2–6 hexes)' },
  ], 'reachable', { class: 'pp-select pp-small', disabled: !counts.length, title: 'how close the allies start: Reachable (default) or Strong contact' });
  root.append(row(btn('Test my team', () => launchProfile(launchBody.testTeam(countSel.value, tierSel.value), `test game with ${countSel.value} of my team`), { disabled: !counts.length }), countSel, tierSel));
  // Join my team — desktop: the Door picked in #pick-door (or the button on each live Door chip); phone: needs a link.
  if (IS_MENU) {
    root.append(row(btn(joinTeamLabel(team), null, { disabled: true }), h('span', { class: 'pp-hint', text: 'open a team link to join' })));
  } else {
    const joinPicked = () => {
      const pick = document.getElementById('pick-door');
      const opt = pick?.selectedOptions?.[0];
      if (!opt || opt.disabled || !opt.value) { setMsg('no live Door picked — pick one in "Join through a player\'s Door" or use the buttons on the Doors below', true); return; }
      const [dim, doorId] = opt.value.split('|');
      launchJoinTeam(dim, doorId);
    };
    root.append(row(btn(joinTeamLabel(team), joinPicked, { disabled: !has, class: 'pp-btn join-team-main' }),
      h('span', { class: 'pp-hint', text: 'joins the Door picked above — or use the button on any live Door below' })));
  }
  root.append(h('div', { id: 'pp-msg', class: 'pp-msg' }));
  refreshJoinTeamButtons();
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
    const nameIn = h('input', { type: 'text', class: 'pp-team-in', maxLength: 30, placeholder: 'team name', value: S.profile?.team_name || '' });
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
  } catch (e) { setMsg(e.message, true); }
}
async function applySync(st) {
  const moved = S.sync && st && st.oid && st.oid !== S.sync.oid;
  const same = JSON.stringify(st) === JSON.stringify(S.sync);
  S.sync = st;
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
  try { await reloadProfile(); } catch (e) { S.error = e.message; S.profile = null; }
  renderPanel();
  if (!S.error) pollSync();
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
      cardsBox.append(h('button', {
        type: 'button', class: `pe-card kind-${x.kind}${inDeck ? ' in-deck' : ' in-archive'}${x.new ? ' is-new' : ''}`,
        title: `${info?.name || prettyId(x.id)} — ${info?.text || ''}${x.from ? `\n(taken from ${x.from})` : ''}\n\ntap: move to the ${inDeck ? 'archive' : 'deck'}`,
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
        h('b', { class: 'pe-card-name', text: info?.name || prettyId(x.id) }),
        elems ? h('span', { class: 'pe-card-elems', text: elems }) : null),
      flags.length ? h('span', { class: 'pe-card-flags' }, ...flags.map(t => h('span', { class: `pe-flag${t === 'perm' ? ' perm' : ''}`, text: t }))) : null,
      h('span', { class: 'pe-card-text', text: shortText(info?.text, 120) }),
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
