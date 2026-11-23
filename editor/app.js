// Rules editor — boot, mode detection, on-demand loading, navigation, entry list / detail, tabs.
// The same page runs on the public site (static files: read-only "visitor") and on a node's local server
// (/rules/api/editor/* answers ⇒ "node"; author.js adds the editing UI through the ctx below — EDITOR_SPEC.md).
// Every URL is relative: data/index.json, data/<file>, defs/<kind>/<id>.json, api/editor/<path>.
import { el, activeVersion, diffJson, download, prettyId, debounce } from './util.js';
import { RENDERERS, genericBody, moreFields, namedRuleBody, prose, pillTag, pillLink, statusPill, pillRow } from './renderers.js';

/* ------------------------------------------------------------------ jsonfmt (agent J) with a plain fallback */
const FALLBACK_JSONFMT = {
  formatCompact: (v, { indent = 2 } = {}) => JSON.stringify(v, null, indent),
  renderJson: (v) => el('pre', { class: 'jf' }, JSON.stringify(v, null, 2)),
  parseJsonText: (t) => { try { return { ok: true, value: JSON.parse(t) }; } catch (e) { return { ok: false, error: e.message, line: 0, col: 0 }; } },
};
let jsonfmt = FALLBACK_JSONFMT;
try { jsonfmt = await import('./jsonfmt.js'); } catch (e) { console.warn('editor: jsonfmt.js not loadable, plain JSON view', e); }
if (jsonfmt.JF_CSS && !document.getElementById('jf-css')) document.head.prepend(Object.assign(document.createElement('style'), { id: 'jf-css', textContent: jsonfmt.JF_CSS }));

/* ------------------------------------------------------------------ state */
const S = {
  index: null, session: null,
  cache: new Map(),       // file → Promise<json>
  loaded: new Map(),      // file → json (resolved)
  texts: new Map(),       // file → raw text (Download JSON keeps the file as served)
  defs: new Map(),        // 'kind/id' → Promise<json>
  defsIndex: null,        // Promise<{skill:[], effect:[], class:[]}> | null
  listFor: null, listLimit: 50, filters: {}, global: '',
  headerActions: [], entryActions: [], routes: [],
  prevHash: '', curHash: '', seq: 0,
};
const $ = (s) => document.querySelector(s);
const KIND_OF = { effects: 'effect', skills: 'skill', classes: 'class' };
const ID_PREFIX = [[/^elem_/, 'elements'], [/^rule_/, 'rules'], [/^effect_/, 'effects'], [/^skill_/, 'skills'], [/^class_/, 'classes'],
  [/^mon_/, 'creatures'], [/^char_/, 'characters'], [/^action_/, 'actions'], [/^stat_/, 'stats'], [/^contra_/, 'contradictions'],
  [/^mode_/, 'game_modes'], [/^evt_/, 'hashgraph_events'], [/^sync_/, 'sync_protocol'], [/^governance_/, 'governance'],
  [/^session_/, 'dimension_session'], [/^(item|mine|tower|crystal)_/, 'terrain_items']];
const isMobile = () => matchMedia('(max-width: 760px)').matches;

/* ------------------------------------------------------------------ loaders */
const collOf = (x) => (S.index?.collections || []).find(c => c.id === x || c.file === x) || null;
const fileOf = (x) => collOf(x)?.file || (String(x).endsWith('.json') ? String(x) : `${x}.json`);
function getCollection(x) {
  const file = fileOf(x);
  if (!S.cache.has(file)) {
    const p = fetch('data/' + encodeURIComponent(file), { cache: 'no-cache' }).then(async (r) => {
      if (!r.ok) throw new Error(`data/${file}: HTTP ${r.status}`);
      const text = await r.text();
      const json = JSON.parse(text.replace(/^﻿/, ''));
      S.texts.set(file, text); S.loaded.set(file, json);
      renderNav();
      return json;
    });
    p.catch(() => { S.cache.delete(file); });
    S.cache.set(file, p);
  }
  return S.cache.get(file);
}
function getDefinition(kind, id) {
  const key = `${kind}/${id}`;
  if (!S.defs.has(key)) {
    const p = fetch(`defs/${encodeURIComponent(kind)}/${encodeURIComponent(id)}.json`, { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error(`defs/${key}.json: HTTP ${r.status}`); return r.json(); });
    p.catch(() => { S.defs.delete(key); });
    S.defs.set(key, p);
  }
  return S.defs.get(key);
}
function getDefsIndex() {
  if (!S.defsIndex) S.defsIndex = fetch('defs/index.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  return S.defsIndex;
}
const isDefinitions = (cid) => !!collOf(cid)?.definitions;
const kindOfCollection = (cid) => KIND_OF[collOf(cid)?.id || cid] || null;
function invalidate(x) {
  const file = fileOf(x);
  S.cache.delete(file); S.loaded.delete(file); S.texts.delete(file);
  if (collOf(file)?.id === S.listFor) S.listFor = null;
  renderNav(); route();
}

/* ------------------------------------------------------------------ api + session */
async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (S.session?.token) headers['X-Editor-Token'] = S.session.token; }
  let r;
  try {
    r = await fetch('api/editor/' + path, { method, headers, cache: 'no-store', credentials: 'same-origin',
      body: method === 'GET' ? undefined : JSON.stringify(body === undefined ? {} : body) });
  } catch (e) { throw { status: 0, error: e?.message || 'network error' }; }
  let json = null;
  try { json = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw { status: r.status, error: json?.error || r.statusText || `HTTP ${r.status}`, body: json };
  return json;
}
async function detectSession() {
  try {
    const r = await fetch('api/editor/session', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const s = await r.json();
    return s && s.mode === 'node' ? s : null;
  } catch { return null; }   // 404, network error, an HTML fallback page … ⇒ visitor
}
const loggedIn = () => !!S.session?.logged_in;
async function refreshSession() {
  try { S.session = await api('login', { method: 'POST', body: {} }); }
  catch (e) { toast('Sign-in check failed: ' + (e.error || e), 'error'); }
  ctx.session = S.session;
  renderMode(); renderHeaderActions();
  if (!onRegisteredRoute()) route();   // an author pane (#/new/…, #/mine) keeps its form state
  return S.session;
}
function renderMode() {
  const b = $('#mode-badge'), banner = $('#banner');
  const s = S.session;
  let text = 'Read-only', cls = 'badge ro', tip = 'Public copy of the rules — read-only. Open the editor from your node to propose changes.';
  if (s && !s.logged_in) { text = 'Read-only — ' + (s.reason || 'not signed in'); tip = 'This node is not signed in with a team identity.'; }
  if (s?.logged_in) {
    const id = s.identity?.id || '';
    text = `${s.team?.name || s.identity?.label || 'Node'} · ${id.length > 10 ? id.slice(0, 4) + '…' + id.slice(-4) : id}`;
    cls = 'badge ok'; tip = `Signed in as ${s.team?.name || '?'} (${id})`;
  }
  b.className = cls; b.textContent = text; b.title = tip;
  document.body.classList.toggle('can-edit', loggedIn());
  banner.replaceChildren();
  banner.hidden = !(s && !s.logged_in);
  if (!banner.hidden) banner.append(el('span', null, el('strong', null, 'Read-only — ' + (s.reason || 'not signed in') + '. '),
    'Sign in from the startup menu: set your team, then '), el('button', { class: 'btn small', onclick: refreshSession }, 'check again'));
}

/* ------------------------------------------------------------------ toast / sheet / confirm */
function toast(msg, kind = 'info') {
  const t = el('div', { class: `toast ${kind === 'error' ? 'err' : kind}`, role: kind === 'error' ? 'alert' : 'status' }, String(msg));
  $('#toasts').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 3200);
}
const sheets = [];
// Modal on desktop, full-screen sheet on mobile. `onClose` runs however it closes (button, backdrop, Esc, close()).
// `beforeClose` (may be async) is asked before a USER close (×, ←, backdrop, Esc); a falsy answer keeps it open.
function openSheet(title, contentEl, { wide = false, onClose, beforeClose } = {}) {
  let closed = false;
  const userClose = async () => {
    if (beforeClose) { let ok = true; try { ok = await beforeClose(); } catch (e) { console.error(e); } if (!ok) return; }
    close();
  };
  const close = () => {
    if (closed) return; closed = true;
    back.remove(); sheets.splice(sheets.indexOf(handle), 1);
    if (!sheets.length) document.body.classList.remove('sheet-open');
    try { onClose?.(); } catch (e) { console.error(e); }
  };
  const back = el('div', { class: 'sheet-backdrop', onclick: (ev) => { if (ev.target === back) userClose(); } },
    el('div', { class: 'sheet' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('div', { class: 'sheet-head' }, el('button', { class: 'icon-btn sheet-back', 'aria-label': 'Close', onclick: userClose }, '←'),
        el('h3', null, title), el('button', { class: 'icon-btn sheet-x', 'aria-label': 'Close', onclick: userClose }, '×')),
      el('div', { class: 'sheet-body' }, contentEl)));
  const handle = { close, userClose, el: back };
  sheets.push(handle);
  document.body.appendChild(back); document.body.classList.add('sheet-open');
  return { close, el: back };
}
function confirmDialog(title, body) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); s.close(); };
    const content = el('div', { class: 'confirm' }, typeof body === 'string' ? el('p', null, body) : body,
      el('div', { class: 'sheet-actions' }, el('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: () => finish(true) }, 'OK')));
    // closing by backdrop / × / Esc counts as Cancel
    const s = openSheet(title, content, { onClose: () => finish(false) });
    s.el.querySelector('.btn.primary').focus();
  });
}

/* ------------------------------------------------------------------ extension points for author.js */
function registerHeaderAction(a) {
  S.headerActions = S.headerActions.filter(x => x.id !== a.id).concat(a);
  // a.before = <id>: shown in front of that action (gen.js "Drafts" before author.js "New skill / effect / class")
  if (a.before) { const i = S.headerActions.findIndex(x => x.id === a.before); if (i >= 0) S.headerActions.splice(i, 0, S.headerActions.pop()); }
  renderHeaderActions();
}
function renderHeaderActions() {
  // Edit affordances only when signed in; `always: true` actions (e.g. "How to sign in") show on any node.
  const list = S.session ? S.headerActions.filter(a => loggedIn() || a.always) : [];
  $('#header-actions').replaceChildren(...list.map(a => el('button', { class: 'btn', onclick: () => { document.body.classList.remove('menu-open'); a.onClick(); } },
    a.icon ? el('span', { class: 'ico' }, a.icon) : null, a.label)));
  $('#menu-toggle').hidden = !list.length;
}
// Re-render an open entry so a late registration (after refreshSession signs in) shows in its toolbar.
const onRegisteredRoute = () => S.routes.some(r => (location.hash || '').startsWith(r.prefix));
const rerenderEntry = debounce(() => { if (currentEntryId() && !sheets.length && !onRegisteredRoute()) route(); }, 50);
function registerEntryAction(a) { S.entryActions = S.entryActions.filter(x => x.id !== a.id).concat(a); if (S.index) rerenderEntry(); }
function registerRoute(prefix, handler) {
  const p = prefix.startsWith('#') ? prefix : '#' + (prefix.startsWith('/') ? '' : '/') + prefix;
  S.routes = S.routes.filter(r => r.prefix !== p).concat({ prefix: p, handler });
}
function navigate(hash) {
  const h = hash.startsWith('#') ? hash : '#' + hash;
  if (location.hash === h) route(); else location.hash = h;
}

/* ------------------------------------------------------------------ JSON view helper */
function jsonWidth() {
  const w = ($('#detail')?.clientWidth || window.innerWidth) - 56;
  return Math.max(34, Math.min(120, Math.floor(w / 7.4)));
}
function jsonView(value, label) {
  let view;
  try { view = jsonfmt.renderJson(value, { width: jsonWidth() }); } catch (e) { view = FALLBACK_JSONFMT.renderJson(value); }
  return el('div', { class: 'code' }, label ? el('div', { class: 'code-label' }, label) : null, view);
}
const R_HELP = { json: jsonView };

/* ------------------------------------------------------------------ nav (collections) */
function renderNav() {
  if (!S.index) return;
  const active = S.listFor;
  const groups = new Map();
  for (const c of S.index.collections || []) {
    const g = String(c.purpose || 'other').split(/[;(]/)[0].trim() || 'other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const items = [];
  for (const [g, cs] of groups) {
    items.push(el('div', { class: 'nav-group' }, g));
    for (const c of cs) {
      const json = S.loaded.get(c.file);
      const n = json ? (json.entries || []).length : c.entries;
      items.push(el('a', { class: 'nav-item' + (c.id === active ? ' active' : ''), href: '#/' + c.id, title: c.purpose || '' },
        el('span', { class: 'nav-name' }, prettyId(c.id)),
        c.definitions ? el('span', { class: 'badge-defs', title: 'Cards built from the definitions in ' + c.definitions }, 'defs') : null,
        el('span', { class: 'nav-count' + (json ? ' loaded' : '') }, n ?? '')));
    }
  }
  $('#nav-list').replaceChildren(...items);
}
const closeDrawer = () => document.body.classList.remove('nav-open', 'menu-open');

/* ------------------------------------------------------------------ list */
const hay = new WeakMap();
function haystack(e) {
  if (!hay.has(e)) hay.set(e, `${e.id || ''} ${e.name || ''} ${(e.tags || []).join(' ')}`.toLowerCase());
  return hay.get(e);
}
const matches = (e, q) => !q || q.toLowerCase().split(/\s+/).filter(Boolean).every(t => haystack(e).includes(t));
function listItem(cid, e, showColl) {
  const v = activeVersion(e);
  const nv = (e.versions || []).length;
  const d = v?.data || {};
  const sub = d.kind || (e.tags || []).slice(0, 3).join(' · ');
  return el('a', { class: 'item', href: `#/${cid}/${encodeURIComponent(e.id)}`, dataset: { id: e.id } },
    el('div', { class: 'item-top' }, el('span', { class: 'item-name' }, e.name || e.id),
      v ? statusPill(v.status) : null, nv > 1 ? el('span', { class: 'vcount', title: nv + ' versions' }, nv + 'v') : null),
    el('div', { class: 'item-sub' }, showColl ? el('span', { class: 'item-coll' }, prettyId(cid)) : null, el('span', { class: 'mono' }, e.id), sub ? el('span', { class: 'muted' }, sub) : null));
}
// Chunked list: 50 items, more as the sentinel scrolls into view (creatures and terrain are large).
function chunkedList(rows, build) {
  const box = el('div', { class: 'items' });
  let shown = 0;
  const more = el('button', { class: 'btn more' }, 'Show more');
  const step = () => {
    const next = rows.slice(shown, shown + S.listLimit);
    box.append(...next.map(build)); shown += next.length;
    more.hidden = shown >= rows.length;
    more.textContent = `Show more (${rows.length - shown} left)`;
  };
  more.onclick = step;
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((xs) => { if (xs.some(x => x.isIntersecting) && shown < rows.length) step(); }, { rootMargin: '300px' }) : null;
  step();
  io?.observe(more);
  return el('div', null, box, more);
}
function markActiveItem(id) {
  for (const a of document.querySelectorAll('#list .item')) a.classList.toggle('active', a.dataset.id === id);
}
async function renderList(coll) {
  const list = $('#list');
  S.rendered = true;
  if (S.listFor === coll.id && !S.global) return;
  S.listFor = coll.id; renderNav();
  list.replaceChildren(el('div', { class: 'pane-loading' }, 'Loading ' + coll.file + '…'));
  let json;
  try { json = await getCollection(coll.file); }
  catch (e) { list.replaceChildren(el('div', { class: 'empty err' }, String(e.message || e))); S.listFor = null; return; }
  if (S.listFor !== coll.id || S.global) return;
  const entries = json.entries || [];
  const body = el('div', { class: 'list-body' });
  const filter = el('input', { type: 'search', class: 'filter', placeholder: `Filter ${entries.length} entries by id, name, tag…`, value: S.filters[coll.id] || '', 'aria-label': 'Filter entries' });
  const paint = () => {
    const q = filter.value.trim(); S.filters[coll.id] = q;
    const rows = entries.filter(e => matches(e, q));
    body.replaceChildren(rows.length ? chunkedList(rows, e => listItem(coll.id, e)) : el('div', { class: 'empty' }, 'No entry matches.'));
    markActiveItem(currentEntryId());
  };
  filter.addEventListener('input', debounce(paint, 120));
  list.replaceChildren(el('div', { class: 'list-head' },
    el('div', { class: 'list-title' }, el('h2', null, prettyId(coll.id)), el('span', { class: 'muted' }, `${entries.length} entries`),
      coll.definitions ? el('span', { class: 'badge-defs' }, 'definitions') : null),
    filter), body);
  paint();
}
function currentEntryId() { return decodeURIComponent((location.hash.replace(/^#\/?/, '').split('/')[1]) || ''); }

/* ------------------------------------------------------------------ global search */
function renderSearch() {
  const q = S.global;
  const list = $('#list');
  S.listFor = null; renderNav();
  const notLoaded = (S.index.collections || []).filter(c => !S.loaded.has(c.file));
  const rows = [];
  for (const c of S.index.collections || []) {
    const json = S.loaded.get(c.file);
    for (const e of json?.entries || []) if (matches(e, q)) rows.push([c.id, e]);
  }
  list.replaceChildren(el('div', { class: 'list-head' },
    el('div', { class: 'list-title' }, el('h2', null, 'Search'), el('span', { class: 'muted' }, `${rows.length} match${rows.length === 1 ? '' : 'es'} for “${q}”`)),
    notLoaded.length ? el('div', { class: 'search-note' }, el('span', { class: 'muted' }, `${S.loaded.size} of ${(S.index.collections || []).length} collections loaded.`),
      el('button', { class: 'btn small', onclick: loadAllForSearch }, `Load all for search (${notLoaded.length})`)) : null),
  rows.length ? chunkedList(rows, ([cid, e]) => listItem(cid, e, true)) : el('div', { class: 'empty' }, 'Nothing found in the loaded collections.'));
  markActiveItem(currentEntryId());
}
async function loadAllForSearch(ev) {
  if (ev?.currentTarget) { ev.currentTarget.disabled = true; ev.currentTarget.textContent = 'Loading…'; }
  const res = await Promise.allSettled((S.index.collections || []).map(c => getCollection(c.file)));
  const bad = res.filter(r => r.status === 'rejected').length;
  if (bad) toast(`${bad} collection(s) could not be loaded`, 'error');
  if (S.global) renderSearch();
}

/* ------------------------------------------------------------------ detail */
const detail = () => $('#detail');
function setDetail(...nodes) { detail().replaceChildren(...nodes); detail().scrollTop = 0; }
function goBack(cid) {
  const parent = cid ? '#/' + cid : '#/';
  // Back in history only when we came from the list (or the search results) — a shared deep link goes to the list.
  if (S.prevHash && (S.prevHash === parent || S.global)) history.back();
  else location.hash = parent;
}
function backButton(cid) { return el('button', { class: 'icon-btn back', 'aria-label': 'Back to the list', onclick: () => goBack(cid) }, '←'); }

function renderHome() {
  S.rendered = true;
  document.body.classList.remove('has-detail');
  S.listFor = null; renderNav();
  const cs = S.index.collections || [];
  $('#list').replaceChildren(el('div', { class: 'list-head' }, el('div', { class: 'list-title' }, el('h2', null, 'Collections'), el('span', { class: 'muted' }, cs.length + ' collections'))),
    el('div', { class: 'items' }, cs.map(c => el('a', { class: 'item', href: '#/' + c.id },
      el('div', { class: 'item-top' }, el('span', { class: 'item-name' }, prettyId(c.id)), c.definitions ? el('span', { class: 'badge-defs' }, 'defs') : null, el('span', { class: 'vcount' }, String(c.entries ?? ''))),
      el('div', { class: 'item-sub' }, el('span', { class: 'muted clamp' }, c.purpose || ''))))));
  const s = S.session;
  setDetail(el('div', { class: 'welcome card' },
    el('h2', null, S.index.name || 'Dimensions — living rulebook'),
    el('p', null, 'Browse the data layer of Dimensions: rules, effects, skills, classes, creatures, terrain and the P2P contract. ' +
      'Pick a collection; every entry shows its card, its JsonLogic, its version history and — for skills, effects and classes — the definition file.'),
    el('p', { class: 'muted' }, !s ? 'This copy is read-only. Changes are proposed from a node: open the editor from the game’s startup menu.'
      : s.logged_in ? `Signed in as ${s.team?.name}. Use “Propose a change” on an entry, or the header buttons to author a new definition.`
        : 'This node is not signed in, so the editor is read-only. Set your team in the startup menu.'),
    (S.index.notes || []).length ? el('details', { class: 'notes' }, el('summary', null, 'About the data layer'), el('ul', null, S.index.notes.map(n => el('li', null, n)))) : null));
}

async function renderCollectionOverview(coll) {
  document.body.classList.remove('has-detail');
  setDetail(el('div', { class: 'pane-loading' }, 'Loading…'));
  let json;
  try { json = await getCollection(coll.file); } catch (e) { setDetail(el('div', { class: 'empty err' }, String(e.message || e))); return; }
  const entries = json.entries || [];
  const tally = {};
  for (const e of entries) { const v = activeVersion(e); if (v) tally[v.status] = (tally[v.status] || 0) + 1; }
  const top = Object.fromEntries(Object.entries(json).filter(([k]) => !['entries', 'collection', 'notes'].includes(k)));
  setDetail(el('div', { class: 'card overview' },
    el('div', { class: 'detail-title' }, el('h2', null, prettyId(coll.id)), el('span', { class: 'mono muted' }, coll.file)),
    pillRow(null, pillTag(entries.length + ' entries'), coll.writes ? pillTag('writes: ' + coll.writes) : null, coll.definitions ? pillTag('definitions: ' + coll.definitions) : null,
      ...Object.entries(tally).map(([st, n]) => el('span', { class: 'pill-pair' }, statusPill(st), ' ' + n))),
    coll.purpose ? prose(coll.purpose) : null,
    typeof json.notes === 'string' ? [el('h4', { class: 'section-h' }, 'Notes'), prose(json.notes)] : null,
    Object.keys(top).length ? moreFields(top, new Set(), R_HELP) : null,
    el('div', { class: 'toolbar' }, el('button', { class: 'btn', onclick: () => download(coll.file, S.texts.get(coll.file) ?? json) }, '⤓ Download JSON'))));
}

const TABS = [['card', 'Card'], ['logic', 'Logic'], ['versions', 'Versions'], ['definition', 'Definition']];
async function renderEntry(coll, eid, tab, seq) {
  document.body.classList.add('has-detail');
  let json;
  try { json = await getCollection(coll.file); } catch (e) { setDetail(el('div', { class: 'empty err' }, String(e.message || e))); return; }
  if (seq !== S.seq) return;
  const entry = (json.entries || []).find(e => e.id === eid);
  if (!entry) { setDetail(el('div', { class: 'detail-head' }, backButton(coll.id)), el('div', { class: 'empty err' }, `No entry “${eid}” in ${coll.file}.`)); return; }
  markActiveItem(eid);
  const versioned = Array.isArray(entry.versions);
  const v = versioned ? activeVersion(entry) : null;
  const kind = kindOfCollection(coll.id);
  let hasDef = isDefinitions(coll.id);
  if (!hasDef && kind) hasDef = ((await getDefsIndex())[kind] || []).includes(eid);
  if (seq !== S.seq) return;
  const logic = versioned ? v?.logic : entry.logic;
  const avail = { card: true, logic: logic !== undefined && logic !== null, versions: versioned, definition: hasDef };
  if (!avail[tab]) tab = 'card';
  const base = `#/${coll.id}/${encodeURIComponent(eid)}`;
  const tabs = el('nav', { class: 'tabs', role: 'tablist' }, TABS.filter(([k]) => avail[k]).map(([k, label]) =>
    el('a', { class: 'tab' + (k === tab ? ' active' : ''), role: 'tab', 'aria-selected': String(k === tab), href: k === 'card' ? base : `${base}/${k}`,
      onclick: (ev) => { ev.preventDefault(); location.replace(ev.currentTarget.href); } },
    label, k === 'versions' && entry.versions.length > 1 ? el('span', { class: 'tab-n' }, entry.versions.length) : null)));
  const actions = loggedIn() ? S.entryActions.filter(a => { try { return a.when ? a.when(coll.id, entry) : true; } catch { return false; } }) : [];
  const toolbar = el('div', { class: 'toolbar' },
    actions.map(a => el('button', { class: 'btn primary', onclick: () => a.onClick(coll.id, entry) }, a.label)),
    el('button', { class: 'btn', onclick: () => download(`${eid}.json`, entry), title: 'Download this entry as JSON' }, '⤓ Download JSON'));
  const head = el('div', { class: 'detail-head' }, backButton(coll.id),
    el('div', { class: 'detail-title' }, el('h2', null, entry.name || entry.id),
      el('div', { class: 'detail-meta' }, el('span', { class: 'mono muted' }, entry.id),
        v ? statusPill(v.status) : null, v?.version ? el('span', { class: 'pill tag mono' }, 'v' + v.version) : null,
        (entry.tags || []).map(t => pillTag(t)))));
  const body = el('div', { class: 'tab-body' }, el('div', { class: 'pane-loading' }, '…'));
  setDetail(head, el('div', { class: 'detail-bar' }, tabs, toolbar), body);
  try {
    const content = tab === 'logic' ? logicTab(logic)
      : tab === 'versions' ? versionsTab(entry, v)
        : tab === 'definition' ? await definitionTab(kind || KIND_OF[coll.id], eid)
          : cardTab(coll, entry, v);
    if (seq === S.seq) body.replaceChildren(content);
  } catch (e) { body.replaceChildren(el('div', { class: 'empty err' }, String(e.message || e))); }
}

function cardTab(coll, entry, v) {
  const used = new Set();
  const r = { ...R_HELP, use: (...ks) => ks.forEach(k => used.add(k)) };
  if (!v) {   // a named rule of logic_rules.json (not versioned)
    ['id', 'name', 'tags', 'description', 'params', 'examples', 'logic'].forEach(k => used.add(k));
    return el('div', { class: 'card' }, namedRuleBody(entry, r), moreFields(entry, used, r),
      entry.logic !== undefined ? el('p', { class: 'muted small' }, 'The rule itself is on the ', el('a', { href: `#/${coll.id}/${encodeURIComponent(entry.id)}/logic` }, 'Logic'), ' tab.') : null);
  }
  const d = v.data || {};
  const fn = RENDERERS[coll.id] || genericBody;
  const nodes = fn(d, r, entry);
  const extras = Object.keys(entry).filter(k => !['id', 'name', 'tags', 'versions'].includes(k) && !k.startsWith('_'));
  const meta = el('dl', { class: 'meta-grid' },
    [['version', v.version], ['status', statusPill(v.status)], ['weight', weightBar(v)], ['origin', v.origin], ['parent', v.parent_version || '(root)'],
      ['created', v.created_at], ['author', v.author_peer_id], ['votes', (v.vote_log || []).length ? `${v.vote_log.length} vote(s)` : null]]
      .filter(([, x]) => x !== undefined && x !== null && x !== '')
      .map(([k, x]) => [el('dt', null, k), el('dd', null, x)]),
    v.notes ? [el('dt', null, 'notes'), el('dd', null, prose(v.notes))] : null,
    (v.rebalance_links || []).length ? [el('dt', null, 'links'), el('dd', null, pillRow(null, ...v.rebalance_links.map(pillLink)))] : null);
  return el('div', { class: 'card-stack' },
    el('div', { class: 'card body-card' }, nodes, moreFields(d, used, r)),
    el('div', { class: 'card meta-card' }, el('h4', { class: 'section-h' }, 'Version'), meta),
    extras.map(k => lazyDetails(prettyId(k), () => jsonView(entry[k]))));
}
function lazyDetails(title, build) {
  const det = el('details', { class: 'card extra' }, el('summary', null, title));
  det.addEventListener('toggle', () => { if (det.open && det.children.length === 1) det.appendChild(build()); });
  return det;
}
function weightBar(v) {
  const w = Number(v.weight) || 0;
  return el('span', { class: `weight-bar ${v.status || ''}` }, el('span', { class: 'bar' }, el('span', { style: { width: Math.max(0, Math.min(1, w)) * 100 + '%' } })), el('span', { class: 'num' }, w.toFixed(2)));
}

const LOGIC_LISTS = [['prerequisites', 'when'], ['effects', 'value'], ['validation', 'assert']];
function logicTab(logic) {
  if (logic === null || typeof logic !== 'object' || Array.isArray(logic) || !('description' in logic || LOGIC_LISTS.some(([k]) => k in logic) || 'references' in logic))
    return el('div', { class: 'card logic' }, el('h4', { class: 'section-h' }, 'Rule'), jsonView(logic));
  const box = el('div', { class: 'card logic' });
  if (logic.description) box.append(prose(logic.description));
  for (const [sec, key] of LOGIC_LISTS) {
    const items = Array.isArray(logic[sec]) ? logic[sec] : [];
    if (!items.length) continue;
    box.append(el('h4', { class: 'section-h' }, `${sec} (${items.length})`));
    for (const it of items) {
      const rest = it && typeof it === 'object' ? Object.fromEntries(Object.entries(it).filter(([k]) => !['id', 'description', 'target', 'unit'].includes(k))) : it;
      const only = rest && typeof rest === 'object' && Object.keys(rest).length === 1 && key in rest;
      box.append(el('div', { class: 'logic-item' },
        el('div', { class: 'l-head' }, el('span', { class: 'l-id mono' }, it?.id || '(no id)'),
          it?.target ? pillTag('→ ' + it.target) : null, it?.unit ? pillTag(it.unit) : null),
        it?.description ? el('div', { class: 'l-desc' }, it.description) : null,
        jsonView(only ? rest[key] : rest, only ? key : null)));
    }
  }
  const refs = Array.isArray(logic.references) ? logic.references : [];
  if (refs.length) {
    const row = el('div', { class: 'pill-row' }, refs.map(ref => el('a', { class: 'pill ref mono', href: '#/logic_rules/' + encodeURIComponent(ref), dataset: { ref } }, ref)));
    box.append(el('h4', { class: 'section-h' }, `references (${refs.length})`), row);
    // Flag dangling ids once the vocabulary is loaded (fetched on demand, 150 kB).
    getCollection('logic_rules.json').then(lib => {
      const ids = new Set((lib.entries || []).map(e => e.id));
      for (const a of row.querySelectorAll('.ref')) if (!ids.has(a.dataset.ref)) { a.classList.add('dangling'); a.title = 'not defined in logic_rules.json'; }
    }).catch(() => {});
  }
  const other = Object.keys(logic).filter(k => !['description', 'references', ...LOGIC_LISTS.map(([k2]) => k2)].includes(k));
  for (const k of other) box.append(el('h4', { class: 'section-h' }, k), jsonView(logic[k]));
  if (!box.childElementCount) box.append(el('div', { class: 'empty' }, 'Empty logic block.'));
  return box;
}

function versionsTab(entry, active) {
  const vs = [...entry.versions].reverse();   // newest first (files append)
  const oneLine = (x) => {
    if (x === undefined) return '—';
    let s; try { s = jsonfmt.formatCompact(x, { width: 10000 }); } catch { s = JSON.stringify(x); }
    s = String(s).replace(/\s*\n\s*/g, ' ');
    return s.length > 220 ? s.slice(0, 220) + '…' : s;
  };
  return el('div', { class: 'versions' }, vs.map(v => {
    const parent = v.parent_version ? entry.versions.find(p => p.version === v.parent_version) : null;
    const rows = parent ? diffJson({ data: parent.data, logic: parent.logic }, { data: v.data, logic: v.logic }) : [];
    return el('div', { class: 'card version' + (v === active ? ' is-active' : '') },
      el('div', { class: 'version-head' }, el('span', { class: 'vlabel mono' }, 'v' + (v.version ?? '?')), statusPill(v.status),
        v === active ? el('span', { class: 'pill active-pill' }, 'active') : null, weightBar(v),
        el('span', { class: 'muted small' }, [v.origin, v.created_at].filter(Boolean).join(' · '))),
      v.notes ? prose(v.notes) : null,
      !v.parent_version ? el('div', { class: 'muted small' }, 'root version')
        : !parent ? el('div', { class: 'muted small' }, `parent v${v.parent_version} not in this file`)
          : !rows.length ? el('div', { class: 'muted small' }, `no change in data / logic vs v${parent.version}`)
            : el('details', { class: 'diff', open: entry.versions.length <= 4 }, el('summary', null, `${rows.length}${rows.length >= 200 ? '+' : ''} change(s) vs v${parent.version}`),
              el('div', { class: 'diff-rows' }, rows.map(d => el('div', { class: 'diff-row ' + d.kind },
                el('div', { class: 'diff-path mono' }, d.kind === 'added' ? '+ ' : d.kind === 'removed' ? '− ' : '~ ', d.path),
                d.kind !== 'added' ? el('div', { class: 'diff-before mono' }, oneLine(d.before)) : null,
                d.kind !== 'removed' ? el('div', { class: 'diff-after mono' }, oneLine(d.after)) : null)))));
  }));
}

async function definitionTab(kind, id) {
  const def = await getDefinition(kind, id);
  const view = jsonView(def);
  const fold = (folded) => () => { const pre = view.querySelector('.jf'); if (pre && jsonfmt.setFolded) jsonfmt.setFolded(pre, folded, 1); };
  return el('div', { class: 'card definition' },
    el('div', { class: 'toolbar' }, el('span', { class: 'mono muted' }, `defs/${kind}/${id}.json`), el('span', { class: 'grow' }),
      def.schema ? pillTag(def.schema) : null, def.version ? pillTag('v' + def.version) : null,
      jsonfmt.setFolded ? [el('button', { class: 'btn small', onclick: fold(true) }, 'Fold all'), el('button', { class: 'btn small', onclick: fold(false) }, 'Unfold all')] : null,
      el('button', { class: 'btn small', onclick: () => download(`${id}.json`, def) }, '⤓ Download')),
    view);
}

/* ------------------------------------------------------------------ routing */
async function findById(id) {
  const guess = ID_PREFIX.find(([re]) => re.test(id))?.[1];
  const order = [guess, 'logic_rules', ...(S.index.collections || []).map(c => c.id)].filter((x, i, a) => x && collOf(x) && a.indexOf(x) === i);
  for (const cid of order) {
    try {
      const json = await getCollection(collOf(cid).file);
      if ((json.entries || []).some(e => e.id === id)) { location.replace(`#/${cid}/${encodeURIComponent(id)}`); return; }
    } catch { /* try the next one */ }
  }
  toast(`No entry “${id}” in any collection`, 'error');
  if (S.prevHash) history.back();
}
async function route() {
  const hash = location.hash || '#/';
  const seq = ++S.seq;
  closeDrawer();
  const reg = S.routes.filter(r => hash.startsWith(r.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (reg) {
    // A handler may open a sheet itself (returns nothing) or return an element for the detail pane.
    if (!S.rendered) renderHome();
    try {
      const out = await reg.handler(decodeURIComponent(hash.slice(reg.prefix.length)));
      if (seq === S.seq && out instanceof Node) document.body.classList.add('has-detail'), setDetail(el('div', { class: 'detail-head' }, backButton(S.listFor), el('div', { class: 'detail-title' }, el('h2', null, out.dataset?.title || ''))), out);
    } catch (e) { toast(String(e?.error || e?.message || e), 'error'); }
    return;
  }
  const [cid, eid, tab] = hash.replace(/^#\/?/, '').split('/').map(x => { try { return decodeURIComponent(x); } catch { return x; } });
  if (cid === 'id' && eid) return findById(eid);
  if (S.global) renderSearch();
  if (!cid) { if (!S.global) renderHome(); else { document.body.classList.remove('has-detail'); setDetail(); } return; }
  const coll = collOf(cid);
  if (!coll) { setDetail(el('div', { class: 'empty err' }, `Unknown collection “${cid}”.`)); return; }
  if (!S.global) renderList(coll);   // not awaited: the detail loads the same promise
  if (eid) await renderEntry(coll, eid, tab || 'card', seq);
  else await renderCollectionOverview(coll);
  document.title = (eid ? `${eid} · ` : '') + prettyId(cid) + ' — Dimensions rules';
}

/* ------------------------------------------------------------------ ctx for author.js (EDITOR_SPEC.md) */
const ctx = {
  session: null, api, refreshSession, index: null, getCollection, getDefinition, isDefinitions, kindOfCollection, activeVersion,
  toast, openSheet, confirm: confirmDialog, registerHeaderAction, registerEntryAction, registerRoute, navigate, invalidate, jsonfmt, el,
};

/* ------------------------------------------------------------------ boot */
function wireChrome() {
  $('#nav-toggle').onclick = () => document.body.classList.toggle('nav-open');
  $('#nav-scrim').onclick = closeDrawer;
  $('#menu-toggle').onclick = () => document.body.classList.toggle('menu-open');
  const gs = $('#global-search');
  gs.addEventListener('input', debounce(() => {
    S.global = gs.value.trim();
    if (S.global) { renderSearch(); if (!S.loaded.size) toast('Searching loaded collections only — “Load all for search” to search everything'); }
    else { S.listFor = null; route(); }
  }, 150));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { if (sheets.length) sheets[sheets.length - 1].userClose(); else closeDrawer(); }
    else if (ev.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') && !document.activeElement?.isContentEditable) { ev.preventDefault(); gs.focus(); }
  });
  // A tab switch (same #/<collection>/<entry>) keeps the previous page, so "back" still returns to the list.
  const base = (h) => String(h || '').split('/').slice(0, 3).join('/');
  window.addEventListener('hashchange', () => { if (base(location.hash) !== base(S.curHash)) S.prevHash = S.curHash; S.curHash = location.hash; route(); });
}

async function boot() {
  wireChrome();
  S.curHash = location.hash;
  const [index, session] = await Promise.all([
    fetch('data/index.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('data/index.json: HTTP ' + r.status); return r.json(); }),
    detectSession(),
  ]).catch(e => { $('#list').replaceChildren(el('div', { class: 'empty err' }, 'Cannot load the rules index: ' + (e.message || e))); return [null, null]; });
  if (!index) return;
  S.index = ctx.index = index;
  S.session = ctx.session = session;
  renderMode(); renderNav(); renderHeaderActions();
  if (session) {
    try {
      const m = await import('./author.js');
      await m.initAuthoring(ctx);
    } catch (e) {
      console.error('editor: author.js', e);
      toast('Editing tools failed to load — read-only (' + (e?.message || e) + ')', 'error');
    }
    try { (await import('./gen.js')).initGeneration(ctx); } catch (e) { console.error('editor: gen.js', e); }   // b9: #/gen/ (generate from a description)
    renderHeaderActions();
  }
  await route();
}
boot();
