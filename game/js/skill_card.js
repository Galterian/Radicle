// Shared "SkillCard" / skill-icon UI component.
//
// Three callers:
//   • renderDeck()      — a skill card in the deck slot (icon sprite + text).
//   • renderRoster()    — permanents under each entity row (stack of mini cards).
//   • renderRevealOverlay()
//                       — floating cards above a unit while its reveal badge
//                         is live (same clock as `state.ui.revealBadges`).
//
// A SkillCard is a pure DOM function — no globals, no mutation of state. All
// three callers pass the id (skill_* / effect_*) and a size variant; the module
// resolves the icon + name + text from /data/skills.json and /data/effects.json
// and returns an HTMLElement. If the catalog hasn't loaded yet (or an id is
// unknown) we fall back to the unicode glyph table that mirrors renderer.js's
// SKILL_ICON — the user still sees SOMETHING sensible on first paint, and the
// component auto-updates when the fetch lands (every mount subscribes to
// `onCatalogChanged`, which fires once the data is in).
//
// Icon sprite resolution order:
//   1) entry.resources.sprites.icon.path   (preferred — single-frame PNG)
//      • cols / frame from the icon record itself (default cols=1, frame=0)
//   2) entry.resources.sprites.effect.path (fallback — effect strip)
//      • cols from the icon record, else frames.json for that path, else
//        round(naturalWidth / naturalHeight). Frame 0 is cropped out.
// The crop is painted into a <canvas> that scales to the requested size. If
// the sheet hasn't loaded yet the element shows the unicode glyph until the
// image arrives — the mount re-paints on both image onload AND catalog ready
// so the fallback and the final sprite are both reachable without caller help.

import { assetUrl } from './sprites.js';
import { effectSource, setEffectSource, makeSourceBadge, sourceTitle } from './effect_source.js';

// Unicode fallbacks mirror renderer.js's skill icons — same glyphs so the three
// surfaces (canvas floating icon, deck slot, roster permanent, hover card) all
// agree on how a given skill reads before (and after) sprites arrive.
// Skill isolation (2026-11-22): the per-skill glyph / colour is the definition's `ui` block (ui.card_glyph /
// ui.card_color when the card differs from the canvas icon, else ui.glyph / ui.color), handed in at runtime by
// setSkillUi(hello.skill_ui) (main.js). Until then (or for an unknown id) the default spark + violet.
export const SKILL_GLYPHS = {
  default:               { glyph: '✦',  color: '#c9b8ff' },
};
let _skillUi = {};            // id -> skills.mjs SKILL_UI entry { tag, glyph, color, card_glyph?, card_color?, trance, … }
export function setSkillUi(map) {
  _skillUi = map instanceof Map ? Object.fromEntries(map) : (map && typeof map === 'object' ? { ...map } : {});
  for (const k of Object.keys(SKILL_GLYPHS)) if (k !== 'default') delete SKILL_GLYPHS[k];
  for (const [id, u] of Object.entries(_skillUi)) {
    const glyph = u?.card_glyph || u?.glyph, color = u?.card_color || u?.color;
    if (glyph && color) SKILL_GLYPHS[id] = { glyph, color };
  }
  for (const info of _entries.values()) info.isTrance = !!_skillUi[info.id]?.trance;
  // (no _notify(): the catalog listeners are one-shot "catalog landed" waiters — firing them here would drop them early)
}

const _entries = new Map();   // id -> parsed info
// name index for inline-icon decoration: `lowercased name` -> id. Longer names
// come first so "Super sense" wins over "Sense".
const _nameIndex = [];        // [{ nameLower, id, pattern }]
let _frames = null;           // frames.json cache (path -> {cols, rows, cell_w, cell_h})
let _loading = null;
const _listeners = new Set();
let _catalogDone = false;     // the one catalog fetch has settled (loaded or failed)
function _notify() { for (const fn of _listeners) { try { fn(); } catch { /* ignore */ } } }
export function onCatalogChanged(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
// Per-mount "re-try once the catalog lands". The catalog loads ONCE, so after it
// settled an id it doesn't know (class_* cards, which are not in skills/effects)
// never resolves — subscribing then leaked the closure and with it the whole card
// (its <canvas> included) for the life of the page. renderRoster rebuilds the
// roster every frame, so a class permanent leaked ~60 cards/s and the phone's
// WebView renderer grew ~110 MB/min until it was OOM-killed (2026-11-14).
// One-shot: the listener drops itself on the first notification.
function _onceCatalog(fn) {
  if (_catalogDone) return;
  const off = onCatalogChanged(() => { off(); fn(); });
}

function _activeVersion(entry) {
  const vs = Array.isArray(entry?.versions) ? entry.versions : [];
  let best = null;
  for (const v of vs) {
    if (v && v.status === 'rejected') continue;
    if (!best || (v.weight ?? 0) > (best.weight ?? 0)) best = v;
  }
  return best;
}

function _ingest(entry, isPermanentDefault) {
  if (!entry || !entry.id) return;
  const ver = _activeVersion(entry);
  const data = ver?.data || {};
  const res = entry.resources || data.resources || {};
  const sprites = res.sprites || {};
  const icon = sprites.icon;
  const effect = sprites.effect;
  const info = {
    id: entry.id,
    name: entry.name || entry.id,
    text: typeof data.text === 'string' ? data.text : (typeof entry.text === 'string' ? entry.text : ''),
    tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
    isPermanent: !!(data.is_permanent ?? data.permanent ?? isPermanentDefault),
    iconPath: icon?.path || null,          // preferred — true icon
    iconCols: Number.isFinite(icon?.cols) ? icon.cols : null,
    iconFrame: Number.isFinite(icon?.frame) ? icon.frame : 0,
    effectPath: effect?.path || null,      // fallback — effect strip
    requires: data.action_type || data.requires || null,
    elementCost: Array.isArray(data.element_cost) ? data.element_cost.slice() : [],
    pointBuyStat: typeof data.point_buy_stat === 'string' ? data.point_buy_stat : null,
    isTrance: !!_skillUi[entry.id]?.trance,   // skill isolation: SKILL_UI trance (setSkillUi), not an id literal
  };
  _entries.set(entry.id, info);
  // Provenance (chaosD6-Effects, E6): a player-branch effect carries `source` on the catalog
  // entry (else on its active version's data). Built-in (main) ones carry none. Only ever SET
  // from here, so a source learned over the wire before the catalog landed is not wiped.
  const src = entry.source || data.source || null;
  // Skills (chaosD6-Skills, S6) the same way: skill_* ids resolve against that repo's main.
  if (src && /^(effect|skill)_/.test(String(entry.id))) setEffectSource(entry.id, src);
}

export function loadCatalog() {
  if (_loading) return _loading;
  const one = (url) => fetch(url).then(r => r.ok ? r.json() : null).catch(() => null);
  _loading = Promise.all([
    one('/data/skills.json'),
    one('/data/effects.json'),
    one('/assets/frames.json'),
  ]).then(([skills, effects, frames]) => {
    for (const e of skills?.entries || []) _ingest(e, false);
    // Effects now ride the same card component — same shape as skills, just a
    // different source. Resolution is symmetric: resources.sprites.icon →
    // effect strip frame 0 → unicode glyph.
    for (const e of effects?.entries || []) _ingest(e, (e.tags || []).includes('permanent'));
    _frames = frames || {};
    _rebuildNameIndex();
    _catalogDone = true;
    _notify();
  }).catch(() => { _frames = {}; _catalogDone = true; });
  return _loading;
}

// Build the "effect name" → id index used by decorateEffectRefs(). Only
// effect_* ids (so a description "the Fear aura" picks up Fear + Aura, not
// another skill with the same filler word). Skip names shorter than four
// characters to avoid false-positives on common words ("Awe" was dropped).
function _rebuildNameIndex() {
  _nameIndex.length = 0;
  for (const info of _entries.values()) {
    if (!String(info.id).startsWith('effect_')) continue;
    const nm = String(info.name || '').trim();
    if (nm.length < 4) continue;
    // Strip anything in parens: "Elementals — Water" and "Fiery Beam / Balefire"
    // keep their primary; sub-tokens are added as separate aliases.
    const aliases = new Set();
    aliases.add(nm);
    for (const part of nm.split(/\s*[\/——]\s*/)) {
      const p = part.trim();
      if (p.length >= 4) aliases.add(p);
    }
    for (const a of aliases) {
      // Escape regex specials, enforce word boundary.
      const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      _nameIndex.push({ nameLower: a.toLowerCase(), id: info.id, pattern: new RegExp(`\\b${esc}\\b`, 'gi') });
    }
  }
  // Longer first so "Super sense" wins over "Sense".
  _nameIndex.sort((a, b) => b.nameLower.length - a.nameLower.length);
}

// Fire-and-forget — any caller that imports this module gets the fetch started.
loadCatalog();

export function skillInfo(id) {
  if (!id) return null;
  return _entries.get(id) || null;
}

// Resolve the display glyph + color for an id, catalog-aware (an effect entry
// still gets the default spark + violet). renderer.js owns the canvas version
// of this map; we duplicate so the DOM side can stand alone.
export function skillGlyph(id) {
  return SKILL_GLYPHS[id] || SKILL_GLYPHS.default;
}

const ELEM_TO_STAT = { elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' };
const ELEM_GLYPH = {
  elem_vitality: '♥', elem_souls: '☽', elem_time: '⌛', elem_space: '✧',
  elem_air: '≋', elem_water: '~', elem_earth: '▲', elem_fire: '🔥',
  elem_concentration: '◎', elem_harmony: '♪',
};
export const elemGlyphsOf = (els) => (els || []).map(e => ELEM_GLYPH[e] || '?').join('');

// Mirror of permStats() in game/peer.mjs doResolution: the stat set a
// permanent can be destroyed by. Effects derive from element_cost →
// ELEM_TO_STAT. Skills take point_buy_stat (strip 'stat_'; 'any' means all
// four). An unknown id falls back to vitality so a click still has a target.
export function permStats(id) {
  if (!id) return [];
  const info = _entries.get(id);
  if (String(id).startsWith('skill_')) {
    const pb = info?.pointBuyStat || '';
    if (pb === 'any') return ['vitality', 'world', 'matter', 'will'];
    return pb ? [pb.replace(/^stat_/, '')] : ['vitality'];
  }
  const stats = new Set();
  for (const el of info?.elementCost || []) if (ELEM_TO_STAT[el]) stats.add(ELEM_TO_STAT[el]);
  return [...stats];
}

// ---------------------------------------------------------------------------
// Image / icon painting
//
// Icon-cache ordering rule (same as features.js): drop the entry in the map
// BEFORE assigning .src, otherwise a browser-cache hit that fires onload
// synchronously can re-enter this function and start a second Image().

const _imgs = new Map();   // url -> { img, ready, failed, listeners:Set<fn> }

function _loadImg(url, onReady) {
  if (!url) return null;
  let t = _imgs.get(url);
  if (!t) {
    t = { img: new Image(), ready: false, failed: false, listeners: new Set() };
    _imgs.set(url, t);                                       // ← BEFORE src
    // Waiters are one-shot: clear them once fired, or every canvas mounted while
    // the sheet was in flight stays reachable from this cache forever.
    t.img.onload = () => { t.ready = true; for (const fn of t.listeners) { try { fn(t); } catch { /* ignore */ } } t.listeners.clear(); };
    t.img.onerror = () => { t.failed = true; console.warn('[skill_card] image failed to load:', url); for (const fn of t.listeners) { try { fn(t); } catch { /* ignore */ } } t.listeners.clear(); };
    t.img.src = url;
  }
  if (onReady) {
    if (t.ready || t.failed) onReady(t);
    else t.listeners.add(onReady);
  }
  return t;
}

// Paint a cropped icon frame into a canvas, resolving the sheet lazily. Also
// flips `.sprite-loaded` on the containing .skill-icon wrap so the glyph
// fallback hides only AFTER the real sprite has actually painted (not on the
// best-effort mount — otherwise an in-flight sheet would leave a blank square).
function _paintIcon(canvas, info, size) {
  if (!canvas || !info) return;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);

  const path = info.iconPath || info.effectPath;
  if (!path) return;
  const url = assetUrl(path);
  const paintNow = (img) => {
    _draw(img, info, path, canvas, size);
    const wrap = canvas.parentElement;
    if (wrap && wrap.classList.contains('skill-icon')) wrap.classList.add('sprite-loaded');
  };
  const t = _loadImg(url, (loaded) => {
    if (loaded.failed || !loaded.img.naturalWidth) return;
    paintNow(loaded.img);
  });
  if (t && t.ready && !t.failed) paintNow(t.img);
}

function _draw(img, info, path, canvas, size) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (!nw || !nh) return;
  // Preferred: icon.cols from the catalog entry; else frames.json; else infer.
  let cols = info.iconCols;
  const framesEntry = _frames ? _frames[path] : null;
  if (!cols && framesEntry?.cols) cols = framesEntry.cols;
  if (!cols) cols = Math.max(1, Math.round(nw / Math.max(1, nh)));
  const rows = framesEntry?.rows || 1;
  const frame = Math.max(0, Math.min(cols - 1, info.iconFrame | 0));
  const cw = nw / cols;
  const ch = nh / rows;   // top row for multi-row strips
  // Center-fit crop into the square canvas (cells are usually ~1.1 aspect; we
  // squish uniformly rather than letterboxing).
  const dw = size, dh = size;
  ctx.drawImage(img, frame * cw, 0, cw, ch, 0, 0, dw, dh);
}

// Repaint on catalog arrival so iconCols / effectPath can resolve post-mount.
let _repaintQueue = [];
onCatalogChanged(() => {
  for (const { canvas, info, size } of _repaintQueue.slice()) _paintIcon(canvas, info, size);
  _repaintQueue = [];
});
function _trackRepaint(canvas, info, size) {
  if (_catalogDone) return;   // the catalog only lands once — nothing left to repaint for, don't pin the canvas
  _repaintQueue.push({ canvas, info, size });
  if (_repaintQueue.length > 500) _repaintQueue = _repaintQueue.slice(-200);
}

// ---------------------------------------------------------------------------
// DOM factories

const _escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A square icon element — <canvas> on top of a glyph fallback <span>. The
// glyph sits behind the canvas and shows through until the paint lands (or
// permanently, if neither the icon nor the effect strip resolved).
export function makeSkillIcon(id, { size = 32, title = null, srcMark = true } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'skill-icon';
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  const glyph = skillGlyph(id);
  wrap.style.setProperty('--sk-color', glyph.color);
  wrap.dataset.id = id || '';
  if (title) wrap.title = title;

  const fallback = document.createElement('span');
  fallback.className = 'skill-icon-glyph';
  fallback.textContent = glyph.glyph;
  fallback.style.fontSize = `${Math.round(size * 0.7)}px`;
  wrap.appendChild(fallback);

  const canvas = document.createElement('canvas');
  canvas.className = 'skill-icon-canvas';
  canvas.width = size;
  canvas.height = size;
  wrap.appendChild(canvas);
  // Player-branch effect / skill (chaosD6-Effects / -Skills): a tiny ⎇ in the corner; the full badge lives on cards.
  const src = srcMark ? effectSource(id) : null;
  if (src) {
    const mk = document.createElement('span');
    mk.className = `skill-icon-src${src.verdict ? ' v-' + src.verdict : ''}`;
    mk.textContent = '⎇';
    mk.title = sourceTitle(src);
    wrap.appendChild(mk);
  }

  // _paintIcon flips `.sprite-loaded` on us once the sprite's actually drawn.
  const _mount = (i) => {
    if (!i || !(i.iconPath || i.effectPath)) return;
    _paintIcon(canvas, i, size);
    _trackRepaint(canvas, i, size);
  };
  const info = skillInfo(id);
  if (info) _mount(info);
  else {
    // Catalog not here yet — subscribe once, then re-attempt. Keeps the
    // caller DOM-static (no reparenting).
    _onceCatalog(() => {
      const i2 = skillInfo(id);
      if (i2) _mount(i2);
    });
  }
  return wrap;
}

// A full mini card: icon on the left, name + rule text on the right.
//   variant: 'strip'     — nutrition-label row (default — roster permanent)
//            'reveal'    — larger pop above the unit on reveal
//            'tooltip'   — narrow format in the hover card
export function makeSkillCard(id, { variant = 'strip', nameOverride = null, textOverride = null, badge = null, keyBadge = null, powerBadge = null, iconSize = null } = {}) {
  const el = document.createElement('div');
  el.className = `skill-card skill-card-${variant}`;
  el.dataset.id = id || '';
  // Corner key badge (B1): a one-character shortcut (9 / 0 / - / =) painted in
  // the top-right. Pinned via absolute position so it doesn't push the body
  // text around. Caller passes `keyBadge: '9'` from permShortcutsForIds(…).
  if (keyBadge) {
    const kb = document.createElement('span');
    kb.className = 'skill-card-key';
    kb.textContent = keyBadge;
    el.appendChild(kb);
  }
  // Power badge (Rule 12/24): the point-buy die the perm was placed with —
  // an enemy's emission has to beat it to destroy the perm. Pinned top-left.
  if (powerBadge != null && powerBadge !== '') {
    const pb = document.createElement('span');
    pb.className = 'skill-card-power';
    pb.textContent = String(powerBadge);
    pb.title = `power ${powerBadge} — the die an enemy's emission has to beat (Rule 24)`;
    el.appendChild(pb);
  }
  const info = skillInfo(id);
  const title = nameOverride || info?.name || (id ? String(id).replace(/^skill_/, '').replace(/_/g, ' ') : '—');
  const text = textOverride || info?.text || '';
  const px = iconSize || (variant === 'reveal' ? 36 : variant === 'tooltip' ? 24 : 28);

  el.appendChild(makeSkillIcon(id, { size: px, title, srcMark: false }));

  const body = document.createElement('div');
  body.className = 'skill-card-body';

  const nm = document.createElement('div');
  nm.className = 'skill-card-name';
  nm.textContent = title;
  if (badge) {
    const b = document.createElement('span');
    b.className = 'skill-card-badge';
    b.textContent = badge;
    nm.appendChild(b);
  }
  body.appendChild(nm);
  // Source badge (chaosD6-Effects / chaosD6-Skills): only for cards NOT from their repo's built-in main branch.
  const srcBadge = makeSourceBadge(effectSource(id), { compact: variant === 'strip' });
  if (srcBadge) body.appendChild(srcBadge);

  // Effect cards: one line listing the elements this card emits (its
  // element_cost). Lets a reader see at a glance what colours a cast puts out
  // and therefore which stat an enemy would use to destroy the resulting
  // permanent (Rule 24, see permStats()).
  if (info?.elementCost?.length && String(id).startsWith('effect_')) {
    const em = document.createElement('div');
    em.className = 'skill-card-emit';
    em.textContent = `emits ${elemGlyphsOf(info.elementCost)}`;
    em.title = `emission: ${info.elementCost.map(e => e.replace(/^elem_/, '')).join(', ')}`;
    body.appendChild(em);
  }

  if (text) {
    const ds = document.createElement('div');
    ds.className = 'skill-card-text';
    ds.textContent = text;
    body.appendChild(ds);
    // Inline mini-icon next to every effect-name mention. Runs after mount
    // so the text node already carries the string. Re-runs on catalog arrival
    // because the name index is empty before that lands.
    const _decorate = () => decorateEffectRefs(ds, { selfId: id, iconSize: 14 });
    _decorate();
    if (!_nameIndex.length) _onceCatalog(_decorate);
  }

  el.appendChild(body);
  // Catalog-arrived refresh for the name/text fallback case.
  if (!info) {
    _onceCatalog(() => {
      const i2 = skillInfo(id);
      if (!i2) return;
      if (!nameOverride) nm.firstChild && (nm.firstChild.nodeValue = i2.name);
      if (!textOverride && i2.text) {
        let ds = body.querySelector('.skill-card-text');
        if (!ds) { ds = document.createElement('div'); ds.className = 'skill-card-text'; body.appendChild(ds); }
        ds.textContent = i2.text;
        // Fresh text node → re-run decoration from scratch.
        delete ds.dataset.fxDecorated;
        decorateEffectRefs(ds, { selfId: id, iconSize: 14 });
      }
      // Elements emitted (Task 14): add once the catalog is here, if we didn't
      // already render it on first paint.
      if (i2.elementCost?.length && String(id).startsWith('effect_') && !body.querySelector('.skill-card-emit')) {
        const em = document.createElement('div');
        em.className = 'skill-card-emit';
        em.textContent = `emits ${elemGlyphsOf(i2.elementCost)}`;
        em.title = `emission: ${i2.elementCost.map(e => e.replace(/^elem_/, '')).join(', ')}`;
        body.insertBefore(em, body.querySelector('.skill-card-text'));
      }
    });
  }
  return el;
}

// Fill an existing container with a stack of SkillCards. Pure function — the
// caller owns the container (so repeated renderRoster calls can clear + refill
// without this module hanging onto per-row state).
//
// `items` accepts either plain string ids OR objects `{id, key}` where `key`
// drives the per-card corner shortcut badge (B1). Existing callers that pass
// an array of strings keep working — the per-item branch only kicks in when
// the entry is an object.
export function fillSkillCardStack(container, items, opts = {}) {
  if (!container) return;
  container.innerHTML = '';
  for (const item of items || []) {
    if (!item) continue;
    const id = typeof item === 'string' ? item : item.id;
    if (!id) continue;
    const perItem = typeof item === 'string'
      ? null
      : { keyBadge: item.key || item.keyBadge || null, powerBadge: item.powerBadge ?? null };
    container.appendChild(makeSkillCard(id, perItem ? { ...opts, ...perItem } : opts));
  }
}

// Walk the text node inside a `.skill-card-text` (or any element) and insert
// a small effect icon next to every mention of a known effect's name. Called
// once by makeSkillCard after setting text; also re-callable from outside
// when a caller wants to decorate custom text (e.g. a tooltip body).
// Only decorates once per element: a marker on the host guards re-entry.
export function decorateEffectRefs(host, { selfId = null, iconSize = 14 } = {}) {
  if (!host || host.dataset?.fxDecorated) return;
  if (host.dataset) host.dataset.fxDecorated = '1';
  if (!_nameIndex.length) return;   // catalog not here yet; subscriber below retries
  // Walk only direct text nodes — don't descend into previously-wrapped spans.
  const text = host.textContent || '';
  if (!text) return;
  const matches = [];
  for (const row of _nameIndex) {
    if (selfId && row.id === selfId) continue;   // don't annotate a card with its own name
    row.pattern.lastIndex = 0;
    let m;
    while ((m = row.pattern.exec(text)) !== null) {
      // Skip overlaps already consumed by a longer earlier match.
      const start = m.index, end = m.index + m[0].length;
      if (matches.some(x => start < x.end && end > x.start)) continue;
      matches.push({ start, end, id: row.id, label: m[0] });
    }
  }
  if (!matches.length) return;
  matches.sort((a, b) => a.start - b.start);
  host.textContent = '';
  let cur = 0;
  for (const m of matches) {
    if (m.start > cur) host.appendChild(document.createTextNode(text.slice(cur, m.start)));
    const span = document.createElement('span');
    span.className = 'inline-fx';
    span.appendChild(makeSkillIcon(m.id, { size: iconSize, title: skillInfo(m.id)?.name || m.label, srcMark: false }));
    span.appendChild(document.createTextNode(m.label));
    host.appendChild(span);
    cur = m.end;
  }
  if (cur < text.length) host.appendChild(document.createTextNode(text.slice(cur)));
}
