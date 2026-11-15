// Effect provenance (program "chaosD6-Effects", E6 UI — 2026-11-15).
//
// Effects live in the Radicle repo chaosD6-Effects. Built-in effects come from its `main`
// branch and show NOTHING (no clutter). A player-made effect lives on `players/<who>/<slug>`;
// wherever such a card is shown the HUD paints a small source badge:
//     ⎇ players/ana/fire-whip · ana · ✓        (tooltip: repo, commit, sha256 — both short)
//
// THE `source` CONTRACT (all fields optional except `branch`):
//   source = {
//     repo:    'chaosD6-Effects',      // Radicle repo name (or rad:… id)
//     branch:  'players/ana/fire-whip',// absent / 'main' / 'master' ⇒ built-in ⇒ no badge
//     commit:  'abc123…',              // full or short git commit the effect was loaded from
//     sha256:  'e3b0c4…',              // sha256 of the effect file at that commit
//     author:  'ana',                  // defaults to the <who> part of players/<who>/<slug>
//     verdict: 'ok' | 'nerf' | 'boost' | 'reject'   // validator (rebalance check) verdict;
//              also accepts 'nerfed' / 'boosted' / 'rejected' or { verdict: '…' }
//     id:      'effect_fire_whip',     // the effect id the ref resolves to
//     name:    'Fire Whip',            // optional display name (notices use it)
//   }
// Where it is read from, first hit wins (see effectSource()):
//   1. a hand / peek card's own `card.source` (E4 may put the ref on the wire card),
//   2. the runtime registry — setEffectSource(id, src): learned effects (WS `effect_source`
//      notices, main.js) and the effect catalog ingest (skill_card.js: entry.source, else the
//      active version's data.source),
//   3. the dev fixture (?fxsrc=demo | ?fxsrc=all) — test data until E3/E4 deliver real refs.
//
// Pure module: no DOM at import (profile-ui / node scripts can import it). Badges render as
// HTML strings (callers that diff markup — setCardHtml, lastPermsHtml — then rebuild only when
// the badge actually changes) or via makeSourceBadge() for DOM-built cards.

const BUILTIN_REPO = 'chaosD6-Effects';
const BUILTIN_BRANCHES = new Set(['', 'main', 'master']);
export const VERDICTS = {
  ok:     { glyph: '✓', label: 'ok',       cls: 'v-ok' },
  nerf:   { glyph: '↓', label: 'nerfed',   cls: 'v-nerf' },
  boost:  { glyph: '↑', label: 'boosted',  cls: 'v-boost' },
  reject: { glyph: '✕', label: 'rejected', cls: 'v-reject' },
};
const VERDICT_ALIAS = { ok: 'ok', pass: 'ok', nerf: 'nerf', nerfed: 'nerf', boost: 'boost', boosted: 'boost', buff: 'boost', reject: 'reject', rejected: 'reject' };

const _reg = new Map();   // effect id -> normalized source (non-built-in only)
let _epoch = 0;           // bumps whenever the registry changes — callers fold it into their render signature
export const sourceEpoch = () => _epoch;

const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const _short = (s, n) => (s ? String(s).slice(0, n) : '');

export function normalizeVerdict(v) {
  const raw = typeof v === 'object' && v ? (v.verdict ?? v.kind ?? v.result) : v;
  return VERDICT_ALIAS[String(raw || '').toLowerCase()] || null;
}

// A source object → its normalized form, or null when it is the built-in main branch.
export function normalizeSource(s) {
  if (!s || typeof s !== 'object') return null;
  const branch = String(s.branch || '').trim();
  const repo = String(s.repo || BUILTIN_REPO).trim();
  if (BUILTIN_BRANCHES.has(branch) && (repo === BUILTIN_REPO || !s.repo)) return null;
  const who = /^players\/([^/]+)\//.exec(branch)?.[1] || null;
  return {
    repo, branch: branch || 'main',
    commit: s.commit ? String(s.commit) : null,
    sha256: s.sha256 ? String(s.sha256) : null,
    author: s.author ? String(s.author) : who,
    verdict: normalizeVerdict(s.verdict),
    id: s.id ? String(s.id) : null,
    name: s.name ? String(s.name) : null,
  };
}

// Register / clear the provenance of an effect id. Returns true when something changed.
export function setEffectSource(id, src) {
  if (!id) return false;
  const n = normalizeSource(src);
  const was = _reg.get(id);
  if (JSON.stringify(was || null) === JSON.stringify(n)) return false;
  if (n) _reg.set(id, n); else _reg.delete(id);
  _epoch++;
  return true;
}

// ---- dev fixture: ?fxsrc=demo (four fixed effects) | ?fxsrc=all (every effect_*) -------------
const _params = typeof location !== 'undefined' ? new URL(location.href).searchParams : new URLSearchParams();
export const DEV_FIXTURE = _params.get('fxsrc') || '';
const FIXTURE_AUTHORS = ['ana', 'p-larkin', 'moonguard', 'oran'];
const FIXTURE_VERDICTS = ['ok', 'nerf', 'boost', 'reject'];
function _fixtureFor(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const slug = id.replace(/^effect_/, '').replace(/_/g, '-');
  const who = FIXTURE_AUTHORS[h % FIXTURE_AUTHORS.length];
  const hex = (h.toString(16) + 'c0ffee1234567890abcdef').padEnd(40, '0');
  return normalizeSource({ repo: BUILTIN_REPO, branch: `players/${who}/${slug}`, commit: hex.slice(0, 40), sha256: (hex + hex).slice(0, 64), author: who, verdict: FIXTURE_VERDICTS[(h >>> 3) % 4], id });
}
if (DEV_FIXTURE === 'demo') {
  const demo = { effect_fireball: 'ok', effect_shield: 'nerf', effect_lightning: 'boost', effect_haste: 'reject' };
  for (const [id, verdict] of Object.entries(demo)) setEffectSource(id, { ..._fixtureFor(id), verdict });
}

// The provenance of an effect: accepts an effect id, a wire card ({effect_id, source}), a
// catalog info ({id, source}) or a source/ref object itself. null ⇒ built-in ⇒ show nothing.
export function effectSource(x) {
  if (!x) return null;
  if (typeof x === 'object') {
    if (x.branch !== undefined && x.effect_id === undefined) return normalizeSource(x);   // a ref / source itself
    if (x.source) { const n = normalizeSource(x.source); if (n) return n; }
    x = x.effect_id || x.id || null;
    if (!x) return null;
  }
  const id = String(x);
  if (!id.startsWith('effect_')) return null;
  return _reg.get(id) || (DEV_FIXTURE === 'all' ? _fixtureFor(id) : null);
}

// Compact surfaces (hand slot, perms strip) drop the `players/` prefix: "⎇ ana/fire-whip".
export const sourceLabel = (src, compact = false) => `⎇ ${compact ? src.branch.replace(/^players\//, '') : src.branch}`;

export function sourceTitle(src) {
  const v = src.verdict ? VERDICTS[src.verdict] : null;
  return [
    `Player effect — from ${src.repo} branch ${src.branch}`,
    src.author ? `author: ${src.author}` : '',
    `validator: ${v ? `${v.glyph} ${v.label}` : 'not checked'}`,
    src.commit ? `commit ${_short(src.commit, 7)}` : '',
    src.sha256 ? `sha256 ${_short(src.sha256, 12)}` : '',
  ].filter(Boolean).join('\n');
}

// The badge as HTML. `compact` (hand slots, perms strip) drops the author text (still in the tooltip).
export function sourceBadgeHtml(src, { compact = false } = {}) {
  if (!src) return '';
  const v = src.verdict ? VERDICTS[src.verdict] : null;
  return `<span class="fx-src${v ? ' ' + v.cls : ''}${compact ? ' compact' : ''}" title="${_esc(sourceTitle(src))}">`
    + `<span class="fx-src-br">${_esc(sourceLabel(src, compact))}</span>`
    + (!compact && src.author ? `<span class="fx-src-au">${_esc(src.author)}</span>` : '')
    + (v ? `<span class="fx-src-v" aria-label="${_esc(v.label)}">${v.glyph}</span>` : '')
    + '</span>';
}
// Convenience: badge HTML for anything effectSource() takes ('' when built-in).
export const effectSourceBadge = (x, opts) => sourceBadgeHtml(effectSource(x), opts);

// DOM version for DOM-built cards (skill_card.js, profile-ui.js). Browser only.
export function makeSourceBadge(src, opts) {
  if (!src || typeof document === 'undefined') return null;
  const t = document.createElement('template');
  t.innerHTML = sourceBadgeHtml(src, opts);
  return t.content.firstElementChild;
}

// One line for notices: "players/ana/fire-whip (commit abc1234)".
export function refText(ref) {
  const n = normalizeSource(ref);
  const branch = n?.branch || ref?.branch || 'main';
  const commit = ref?.commit ? ` (commit ${_short(ref.commit, 7)})` : '';
  return `${branch}${commit}`;
}
