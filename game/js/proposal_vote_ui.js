// Proposal votes — desktop HUD (user rulings 2026-11-17): every foreign card (an effect / skill / class from a
// player branch players/<who>/<slug>, i.e. effectSource(card) !== null) met in a game is "received for
// testing" and takes a vote −6…+6; a minus vote needs a comment. The peer stores it in the profile
// (game/proposal-votes.mjs, <profile dir>/proposal_votes.json) — never in game state — and publishes it in the
// background (votes/<voter> → OCI seed only).
//
// WS (peer.mjs, PV hunks of tools/out/_pv_hunks.py):
//   → { kind: 'proposal_vote', ref, value, comment, tags }
//   ← { kind: 'proposal_vote_saved', ok, key, mine?, error?, code? }
//   ← { kind: 'proposal_votes', mine, me, collections, limits, publish, tags: [{id,label}] }   (on hello, and again after each publish run)
// User answers 2026-11-28: every vote may carry TAGS (toggle chips; any kind); ⚑ review now means NEEDS REWORK — that
// version is not playable until its author pushes a new one (0 votes again); ✓ PUBLISHABLE = n ≥ 10 and > 60 % positive.
//
// Surfaces:
//   * a floating "🗳 Test votes" button (count of foreign defs not yet voted, pulses while > 0) opening a panel with
//     one vote control per foreign def seen this session;
//   * a POPUP (ruling 2) the first time a player-made card version is seen: slider + comment + Vote + Later. Once per
//     def version per session (sessionStorage), never after a vote / "Later"; several new cards queue (one at a time,
//     "+N more"). It never takes focus by itself, so the planning hotkeys keep working until the player clicks into it;
//     keys typed inside it never reach the game (stopPropagation), Escape = Later.
//   * my OWN cards (ruling 1: I am the publisher namespace / the branch's <who>) get no vote control at all.
//   * per vote: 💾 saved · ✓ published · ⏳ pending (ruling 3); ⚑ needs rework — not playable when the collection has
//     n ≥ 10 and mean ≤ −3 (ruling 4/7); ✓ publishable (n, % positive) when n ≥ 10 and > 60 % positive (ruling 8);
//     the 3 most frequent tags with their counts.
// No style.css edits: the module injects its own <style>.
import { effectSource, normalizeSource, sourceBadgeHtml, setEffectSource } from './effect_source.js';

export const VALUE_MIN = -6, VALUE_MAX = 6, COMMENT_MAX = 500;   // mirror of game/proposal-votes.mjs (the peer re-validates)
export const REVIEW_MIN_VOTES = 10, REVIEW_MEAN_MAX = -3;
export const PUBLISH_MIN_VOTES = 10, PUBLISH_POSITIVE_SHARE = 0.6;
// Fallback copy of proposal-votes.mjs TAGS / TAG_LABELS (the hello's `tags` wins when present).
export const TAGS = Object.freeze(['overpowered', 'weak', 'too_simple', 'out_of_theme', 'duplicate', 'confusing', 'buggy', 'fun', 'well_themed', 'creative']);
export const TAG_LABELS = Object.freeze({ overpowered: 'Overpowered', weak: 'Weak', too_simple: 'Too simple', out_of_theme: 'Too out of theme',
  duplicate: 'Duplicating another', confusing: 'Confusing', buggy: 'Buggy / does not work', fun: 'Fun', well_themed: 'Fits the theme', creative: 'Creative' });
const SHA_RE = /^[0-9a-f]{64}$/, COMMIT_RE = /^[0-9a-f]{40}$/;
const HELLO_WAIT_MS = 3000;   // the popup waits for my votes (hello) so it does not ask about a card I already voted on

// Same key as proposal-votes.mjs voteKey(): repo|branch|id|sha256-or-commit; null when the version is unknown.
export function pvKey(src) {
  if (!src || !/^players\/[^/]+\/./.test(src.branch || '')) return null;
  const ver = SHA_RE.test(src.sha256 || '') ? src.sha256 : COMMIT_RE.test(src.commit || '') ? src.commit : null;
  return ver && src.id ? `${src.repo}|${src.branch}|${src.id}|${ver}` : null;
}
export const commentNeeded = (value, comment) => value < 0 && !String(comment || '').trim();
const fmtVal = v => (v > 0 ? `+${v}` : String(v));
// Mirror of proposal-votes.mjs handleSlug / authorConflict (the peer refuses anyway; this only hides the control).
export const handleSlug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export function pvIsMine(src, me) {
  if (!src || !me) return false;
  const ids = new Set([me.voter, me.nid].filter(Boolean));
  if (src.ns && ids.has(src.ns)) return true;
  const hs = new Set((me.handles || []).map(handleSlug).filter(Boolean));
  const who = /^players\/([^/]+)\//.exec(String(src.branch || ''))?.[1] || null;
  return [who, src.author].some(a => a && (ids.has(a) || hs.has(handleSlug(a))));
}
export const reviewFlag = (c) => !!c && (c.n | 0) >= REVIEW_MIN_VOTES && typeof c.mean === 'number' && c.mean <= REVIEW_MEAN_MAX;
export const needsRework = reviewFlag;
export const publishableFlag = (c) => !!c && (c.n | 0) >= PUBLISH_MIN_VOTES && Number.isFinite(c.positive) && c.positive / c.n > PUBLISH_POSITIVE_SHARE && !reviewFlag(c);
export const REWORK_TEXT = '⚑ needs rework — not playable';
export const PUBLISHABLE_TEXT = '✓ publishable';
let _tagList = TAGS.map(id => ({ id, label: TAG_LABELS[id] }));   // replaced by the hello's `tags`
const _tagIds = () => _tagList.map(t => t.id);
const _tagLabel = (id) => _tagList.find(t => t.id === id)?.label || TAG_LABELS[id] || id;
/** The `n` most frequent tags of a collection: [[tag, count], …] (count desc, then tag order). */
export const topTags = (tags, n = 3) => Object.entries(tags || {}).filter(([, c]) => c > 0)
  .sort((a, b) => b[1] - a[1] || _tagIds().indexOf(a[0]) - _tagIds().indexOf(b[0])).slice(0, n);
/** Mirror of proposal-votes.mjs normalizeTags, against the current tag list. */
export const normalizeTags = (x) => [...new Set((Array.isArray(x) ? x : []).map(s => String(s || '').trim().toLowerCase()).filter(s => _tagIds().includes(s)))].sort();
const PUB_TEXT = { saved: '💾 saved — publishing in the background', published: '✓ published (OCI seed)', pending: '⏳ pending — kept on this device, will retry' };

let _send = null, _cards = () => [];
const _seen = new Map();      // key → { src, name, first_at }
let _mine = {};               // key → { value, comment, tags, at, pub, pub_error? }
let _me = null;               // { voter, nid, handles } from hello
let _collections = {};        // key → { n, mean, positive, review, publishable, tags: {tag: count} }
let _helloAt = 0, _initAt = 0;
const _own = new Set();       // keys the peer refused as my own (code 'author')
const _status = new Map();    // key → { ok, text }
let _btn = null, _panel = null, _pop = null, _popKey = null, _sig = '';

// Shown-popup memory: this session only (a reload of the HUD is the same session; a new game window is not).
const _shown = new Set((() => { try { return JSON.parse(globalThis.sessionStorage?.getItem('pv-shown') || '[]'); } catch { return []; } })());
const _remember = (k) => { _shown.add(k); try { globalThis.sessionStorage?.setItem('pv-shown', JSON.stringify([..._shown].slice(-500))); } catch {} };

const _isOwn = (key, src) => _own.has(key) || pvIsMine(src, _me);
/** Keys that still deserve the first-time popup, oldest first. */
export function pvPopupCandidates() {
  return [..._seen.entries()].filter(([k, it]) => !_mine[k] && !_shown.has(k) && !_isOwn(k, it.src))
    .sort((a, b) => a[1].first_at - b[1].first_at).map(([k]) => k);
}
/** "Later" (or a vote) for the popup of `key`: it is not shown again this session; the 🗳 button keeps pulsing. */
export function pvPopupDismiss(key) { if (key) _remember(key); if (_popKey === key) _closePopup(); }

function _injectStyle() {
  if (document.getElementById('pv-style')) return;
  const s = document.createElement('style');
  s.id = 'pv-style';
  s.textContent = `
#pv-btn{position:fixed;left:10px;bottom:10px;z-index:60;padding:4px 10px;border-radius:12px;border:1px solid #6a5acd;background:#1d1b2e;color:#e8e4ff;font:12px sans-serif;cursor:pointer}
#pv-btn.pending{animation:pv-pulse 1.6s ease-in-out infinite}
@keyframes pv-pulse{0%,100%{box-shadow:0 0 0 0 #8a7cff00}50%{box-shadow:0 0 8px 3px #8a7cffaa}}
#pv-panel{position:fixed;left:10px;bottom:42px;z-index:61;width:340px;max-height:60vh;overflow:auto;padding:8px;border-radius:8px;border:1px solid #6a5acd;background:#14131fee;color:#e8e4ff;font:12px sans-serif}
#pv-pop{position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:62;width:360px;padding:10px;border-radius:10px;border:1px solid #8a7cff;background:#14131ff2;color:#e8e4ff;font:12px sans-serif;box-shadow:0 6px 24px #000a}
#pv-pop .pv-item{border-top:none;padding-top:2px}
#pv-panel h4,#pv-pop h4{margin:0 0 6px;font-size:13px}
.pv-more{font-size:11px;opacity:.75;margin-left:6px;font-weight:normal}
.pv-item{border-top:1px solid #333;padding:6px 0}
.pv-name{font-weight:bold;margin-right:4px}
.pv-row{display:flex;align-items:center;gap:6px;margin-top:4px}
.pv-row input[type=range]{flex:1}
.pv-val{min-width:24px;text-align:right;font-weight:bold}
.pv-val.neg{color:#ff7b7b}.pv-val.pos{color:#7bff9b}
.pv-item textarea{width:100%;box-sizing:border-box;margin-top:4px;min-height:34px;background:#0e0d16;color:#e8e4ff;border:1px solid #444;font:12px sans-serif}
.pv-item textarea.need{border-color:#ff7b7b}
.pv-msg{font-size:11px;opacity:.8;margin-top:2px}.pv-msg.err{color:#ff7b7b;opacity:1}
.pv-mine{font-size:11px;color:#bdb5ff}
.pv-pub-pending{color:#ffc46b}.pv-pub-published{color:#7bff9b}
.pv-review{color:#ff9b5b;font-weight:bold;margin-left:4px}
.pv-publishable{color:#7bff9b;font-weight:bold;margin-left:4px}
.pv-toptags{display:block;font-size:11px;opacity:.85;margin-top:2px}
.pv-tags{display:flex;flex-wrap:wrap;gap:3px;margin-top:4px}
.pv-tag{padding:1px 7px;border-radius:10px;border:1px solid #555;background:#1d1b2e;color:#cfc8ff;font:11px sans-serif;cursor:pointer}
.pv-tag.on{border-color:#8a7cff;background:#3a3270;color:#fff}
.pv-later{margin-left:auto}`;
  document.head.appendChild(s);
}

/** One vote control (DOM) for a normalized foreign source. `extra`: buttons appended to the slider row (popup: Later). */
export function voteControl(src, { name = '', extra = [] } = {}) {
  const key = pvKey(src);
  const box = document.createElement('div');
  box.className = 'pv-item';
  box.dataset.key = key || '';
  const mine = key ? _mine[key] : null;
  const head = document.createElement('div');
  const nm = document.createElement('span'); nm.className = 'pv-name'; nm.textContent = name || src.name || src.id;
  head.append(nm);
  head.insertAdjacentHTML('beforeend', sourceBadgeHtml(src, { compact: true }));   // escaped in effect_source.js
  const col = key ? _collections[key] : null;
  if (col && col.n) {
    const c = document.createElement('span'); c.className = 'pv-mine'; c.textContent = ` · players ${col.mean > 0 ? '+' : ''}${col.mean} (${col.n})`;
    head.append(c);
    if (needsRework(col)) {
      const r = document.createElement('span'); r.className = 'pv-review'; r.textContent = REWORK_TEXT;
      r.title = `${col.n} test votes, mean ${col.mean} (≤ ${REVIEW_MEAN_MAX}): this version needs rework and is not played until its author pushes a new version (which starts at 0 votes)`;
      head.append(r);
    } else if (publishableFlag(col)) {
      const pct = Math.round((col.positive / col.n) * 100);
      const r = document.createElement('span'); r.className = 'pv-publishable'; r.textContent = `${PUBLISHABLE_TEXT} (${col.n} votes, ${pct} % positive)`;
      r.title = `${col.positive} of ${col.n} test votes positive (> ${Math.round(PUBLISH_POSITIVE_SHARE * 100)} %): the author may merge it to main (or open a patch)`;
      head.append(r);
    }
    const top = topTags(col.tags);
    if (top.length) { const t = document.createElement('span'); t.className = 'pv-toptags'; t.textContent = `tags: ${top.map(([g, c]) => `${_tagLabel(g)} ×${c}`).join(' · ')}`; head.append(t); }
  }
  box.append(head);
  if (!key) { const m = document.createElement('div'); m.className = 'pv-msg'; m.textContent = 'version unknown (no sha256 / commit) — cannot vote yet'; box.append(m); return box; }
  const row = document.createElement('div'); row.className = 'pv-row';
  const range = document.createElement('input');
  Object.assign(range, { type: 'range', min: VALUE_MIN, max: VALUE_MAX, step: 1, value: mine ? mine.value : 0 });
  range.title = `${VALUE_MIN} … +${VALUE_MAX}`;
  const val = document.createElement('span'); val.className = 'pv-val';
  const save = document.createElement('button'); save.type = 'button'; save.textContent = mine ? 'Change vote' : 'Vote';
  row.append(document.createTextNode(String(VALUE_MIN)), range, document.createTextNode(`+${VALUE_MAX}`), val, save, ...extra);
  const ta = document.createElement('textarea');
  ta.maxLength = COMMENT_MAX; ta.value = mine?.comment || '';
  // tags (ruling 6): toggle chips, my saved tags pre-selected
  const picked = new Set(normalizeTags(mine?.tags));
  const tagRow = document.createElement('div'); tagRow.className = 'pv-tags';
  for (const t of _tagList) {
    const b = document.createElement('button'); b.type = 'button'; b.className = `pv-tag${picked.has(t.id) ? ' on' : ''}`; b.textContent = t.label || t.id;
    b.dataset.tag = t.id; b.setAttribute('aria-pressed', String(picked.has(t.id)));
    b.onclick = () => { if (picked.has(t.id)) picked.delete(t.id); else picked.add(t.id); b.classList.toggle('on', picked.has(t.id)); b.setAttribute('aria-pressed', String(picked.has(t.id))); };
    tagRow.append(b);
  }
  const msg = document.createElement('div'); msg.className = 'pv-msg';
  const refresh = () => {
    const v = Number(range.value);
    val.textContent = fmtVal(v); val.className = `pv-val${v < 0 ? ' neg' : v > 0 ? ' pos' : ''}`;
    const need = commentNeeded(v, ta.value);
    ta.placeholder = v < 0 ? 'Required for a minus vote: what is wrong with it?' : 'Comment (optional)';
    ta.classList.toggle('need', need);
    save.disabled = need;
    const st = _status.get(key);
    msg.className = `pv-msg${st && !st.ok ? ' err' : ''}`;
    msg.textContent = need ? 'A minus vote needs a comment.' : (st?.text || '');
  };
  range.oninput = refresh; ta.oninput = refresh;
  save.onclick = () => {
    const v = Number(range.value);
    if (commentNeeded(v, ta.value)) return refresh();
    _status.set(key, { ok: true, text: 'saving…' });
    _send?.({ kind: 'proposal_vote', ref: src, value: v, comment: ta.value.trim().slice(0, COMMENT_MAX), tags: normalizeTags([...picked]) });
    refresh();
  };
  box.append(row, tagRow, ta, msg);
  if (mine) {
    const m = document.createElement('div'); m.className = 'pv-mine';
    const myTags = normalizeTags(mine.tags);
    m.textContent = `your vote ${fmtVal(mine.value)}${myTags.length ? ` [${myTags.map(_tagLabel).join(', ')}]` : ''} · ${new Date(mine.at).toLocaleString()} · `;
    const p = document.createElement('span'); p.className = `pv-pub-${mine.pub || 'saved'}`;
    p.textContent = PUB_TEXT[mine.pub] || PUB_TEXT.saved;
    if (mine.pub_error) p.title = mine.pub_error;
    m.append(p); box.append(m);
  }
  refresh();
  return box;
}

function _closePopup() { if (_pop) { _pop.hidden = true; _pop.replaceChildren(); } _popKey = null; }
function _popupTick() {
  if (!_pop) return;
  if (_popKey && (_mine[_popKey] || _isOwn(_popKey, _seen.get(_popKey)?.src))) { _remember(_popKey); _closePopup(); }
  if (_popKey) return;
  if (!_helloAt && Date.now() - _initAt < HELLO_WAIT_MS) return;   // wait for my votes first
  const q = pvPopupCandidates();
  if (!q.length) return;
  const key = q[0], it = _seen.get(key);
  _popKey = key;
  const h = document.createElement('h4');
  h.textContent = `New player-made ${it.src.kind || 'card'} in testing — your vote −6 … +6`;
  if (q.length > 1) { const more = document.createElement('span'); more.className = 'pv-more'; more.textContent = `+${q.length - 1} more`; h.append(more); }
  const later = document.createElement('button'); later.type = 'button'; later.className = 'pv-later'; later.textContent = 'Later';
  later.title = 'Vote later from the 🗳 Test votes button';
  later.onclick = () => { pvPopupDismiss(key); _render(true); _popupTick(); };
  _pop.replaceChildren(h, voteControl(it.src, { name: it.name, extra: [later] }));
  _pop.hidden = false;   // NOT focused: planning hotkeys stay with the game until the player clicks in
}

function _render(force = false) {
  if (!_btn) return;
  const keys = [..._seen.entries()].filter(([k, it]) => !_isOwn(k, it.src)).map(([k]) => k);
  const pending = keys.filter(k => !_mine[k]).length;
  _btn.hidden = keys.length === 0;
  _btn.textContent = `🗳 Test votes${pending ? ` (${pending})` : ''}`;
  _btn.classList.toggle('pending', pending > 0);
  _btn.title = pending ? `${pending} player-made card(s) you are testing still need your vote` : 'player-made cards you tested — your votes';
  if (_panel.hidden) return;
  // Rebuild only when the list / my votes / statuses change (keeps slider + comment edits alive).
  const sig = JSON.stringify([keys, _mine, [..._status], _collections]);
  if (!force && sig === _sig) return;
  if (!force && _panel.contains(document.activeElement)) return;   // do not yank a control the player is using
  _sig = sig;
  _panel.replaceChildren();
  const h = document.createElement('h4'); h.textContent = 'Player-made cards in testing — vote −6 … +6'; _panel.append(h);
  const items = keys.map(k => [k, _seen.get(k)]).sort((a, b) => (!!_mine[a[0]] - !!_mine[b[0]]) || a[1].first_at - b[1].first_at);
  for (const [, it] of items) _panel.append(voteControl(it.src, { name: it.name }));
}

/** A foreign def became visible (a card, a learned/shared notice). Built-ins are ignored. */
export function pvSeen(x, name = '') {
  const src = x && x.branch !== undefined && !x.effect_id && !x.skill_id && !x.class_id ? normalizeSource(x) : effectSource(x);
  const key = pvKey(src);
  if (!key || _seen.has(key)) return false;
  _seen.set(key, { src, name: name || x?.name || src.name || src.id, first_at: Date.now() });
  _render();
  _popupTick();
  return true;
}

function _applyReview() {
  for (const [k, it] of _seen) {
    if (!reviewFlag(_collections[k]) || it.src.review) continue;
    it.src = { ...it.src, review: true };
    try { setEffectSource(it.src.id, it.src); } catch {}   // the source badge of that card shows ⚑
  }
}

/** WS messages from the peer: proposal_votes (hello / after a publish run) / proposal_vote_saved. */
export function pvOnMessage(m) {
  if (!m) return;
  if (m.kind === 'proposal_votes') {
    _mine = m.mine || {}; _me = m.me || _me; _collections = m.collections || _collections; _helloAt = Date.now();
    if (Array.isArray(m.tags) && m.tags.length) {
      const tl = m.tags.map(t => (typeof t === 'string' ? { id: t } : t)).filter(t => t && /^[a-z0-9_]{1,40}$/.test(String(t.id || '')))
        .map(t => ({ id: String(t.id), label: String(t.label || TAG_LABELS[t.id] || t.id).slice(0, 60) }));
      if (tl.length) _tagList = tl;
    }
    _applyReview(); _render(true); _popupTick();
  }
  if (m.kind === 'proposal_vote_saved') {
    if (m.ok) {
      _mine = m.mine || _mine;
      const p = _mine[m.key]?.pub;
      _status.set(m.key, { ok: true, text: `vote saved to your profile${p === 'published' ? ' · published' : ' · publishing…'}` });
      if (m.key) pvPopupDismiss(m.key);
    } else if (m.key) {
      if (m.code === 'author') { _own.add(m.key); pvPopupDismiss(m.key); }
      _status.set(m.key, { ok: false, text: m.error || 'vote not saved' });
    }
    _render(true); _popupTick();
  }
}

/** Call once (main.js): send(obj) → peer WS; cards() → every card-like object on screen (hand, archive, class state). */
export function pvInit({ send, cards } = {}) {
  _send = send || null;
  if (typeof cards === 'function') _cards = cards;
  if (typeof document === 'undefined' || _btn) return;
  _initAt = Date.now();
  _injectStyle();
  _btn = document.createElement('button');
  _btn.id = 'pv-btn'; _btn.type = 'button'; _btn.hidden = true;
  _panel = document.createElement('div');
  _panel.id = 'pv-panel'; _panel.hidden = true;
  _pop = document.createElement('div');
  _pop.id = 'pv-pop'; _pop.hidden = true;
  for (const el of [_panel, _pop]) for (const t of ['keydown', 'keyup', 'keypress']) el.addEventListener(t, e => e.stopPropagation());
  _pop.addEventListener('keydown', e => { if (e.key === 'Escape' && _popKey) { const k = _popKey; pvPopupDismiss(k); e.target?.blur?.(); _render(true); _popupTick(); } });
  _btn.onclick = () => { _panel.hidden = !_panel.hidden; _render(true); };
  document.body.append(_btn, _panel, _pop);
  setInterval(() => { try { for (const c of _cards() || []) if (c) pvSeen(c, c.name || ''); } catch {} _popupTick(); }, 1500);
  _render();
}
