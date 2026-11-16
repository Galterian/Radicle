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
//     kind:    'effect' | 'skill',     // optional; else inferred from the id prefix / the repo
//   }
//
// SKILLS (program "chaosD6-Skills", S6 — 2026-11-16): the same contract for every catalog id.
// skill_* ids live in the Radicle repo chaosD6-Skills (players/<who>/<slug> as for effects);
// effect_* ids in chaosD6-Effects. "Built-in" = main/master of the MATCHING repo (or no repo
// given) ⇒ no badge; a skill ref naming chaosD6-Effects main (or vice versa) is NOT built-in.
// A skill ref's id may be 'skill_dodge' or, with kind:'skill', just 'dodge'. All exports keep
// their old names (effectSource / setEffectSource / effectSourceBadge …) and take any id;
// cardSource / setCardSource / cardSourceBadge are kind-neutral aliases.
// Where it is read from, first hit wins (see effectSource()):
//   1. a hand / peek card's own `card.source` (E4 may put the ref on the wire card),
//   2. the runtime registry — setEffectSource(id, src): learned effects (WS `effect_source`
//      notices, main.js) and the effect catalog ingest (skill_card.js: entry.source, else the
//      active version's data.source),
//   3. the dev fixture (?fxsrc=demo | ?fxsrc=all; ?sksrc= is an alias) — test data until
//      E3/E4 (S3/S4 for skills) deliver real refs.
//
// Pure module: no DOM at import (profile-ui / node scripts can import it). Badges render as
// HTML strings (callers that diff markup — setCardHtml, lastPermsHtml — then rebuild only when
// the badge actually changes) or via makeSourceBadge() for DOM-built cards.

const BUILTIN_REPO = 'chaosD6-Effects';
export const REPOS = { effect: BUILTIN_REPO, skill: 'chaosD6-Skills', class: 'chaosD6-Classes' };
const BUILTIN_BRANCHES = new Set(['', 'main', 'master']);
// 'effect' | 'skill' | 'class' | null from a catalog id.
export const kindOfId = id => /^effect_/.test(id || '') ? 'effect' : /^skill_/.test(id || '') ? 'skill' : /^class_/.test(id || '') ? 'class' : null;
const _kindOfRepo = r => r === REPOS.skill ? 'skill' : r === REPOS.class ? 'class' : r === REPOS.effect ? 'effect' : null;
const KINDS = new Set(['effect', 'skill', 'class']);
// The catalog id a ref / source names ('skill_dodge' for { kind: 'skill', id: 'dodge' }).
export function refId(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const raw = ref.id || ref.effect_id || ref.skill_id || ref.class_id || null;
  if (!raw) return null;
  const id = String(raw);
  if (kindOfId(id)) return id;
  const k = KINDS.has(ref.kind) ? ref.kind : (ref.skill_id ? 'skill' : ref.class_id ? 'class' : _kindOfRepo(ref.repo));
  return k ? `${k}_${id}` : id;
}
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

// A source object → its normalized form, or null when it is the built-in main branch of the
// matching repo. `kind` ('effect' | 'skill') comes from the caller (the id it is registered
// under), else s.kind, else the id prefix, else the repo name; unknown ⇒ effect.
export function normalizeSource(s, kind = null) {
  if (!s || typeof s !== 'object') return null;
  const id = refId(s);
  const k = kind || (KINDS.has(s.kind) ? s.kind : null) || kindOfId(id) || _kindOfRepo(s.repo) || 'effect';
  const home = REPOS[k];
  const branch = String(s.branch || '').trim();
  const repo = String(s.repo || home).trim();
  if (BUILTIN_BRANCHES.has(branch) && (repo === home || !s.repo)) return null;
  const who = /^players\/([^/]+)\//.exec(branch)?.[1] || null;
  return {
    repo, branch: branch || 'main',
    commit: s.commit ? String(s.commit) : null,
    sha256: s.sha256 ? String(s.sha256) : null,
    author: s.author ? String(s.author) : who,
    verdict: normalizeVerdict(s.verdict),
    id,
    name: s.name ? String(s.name) : null,
    kind: k,
  };
}

// Register / clear the provenance of a catalog id (effect_* or skill_*). Returns true when something changed.
export function setEffectSource(id, src) {
  if (!id) return false;
  const n = normalizeSource(src, kindOfId(id));
  const was = _reg.get(id);
  if (JSON.stringify(was || null) === JSON.stringify(n)) return false;
  if (n) _reg.set(id, n); else _reg.delete(id);
  _epoch++;
  return true;
}

// ---- dev fixture: ?fxsrc=demo (four fixed effects + two skills) | ?fxsrc=all (every effect_* and
// skill_*). ?sksrc=demo|all is an alias (same fixture) -------------------------------------------
const _params = typeof location !== 'undefined' ? new URL(location.href).searchParams : new URLSearchParams();
export const DEV_FIXTURE = _params.get('fxsrc') || _params.get('sksrc') || '';
const FIXTURE_AUTHORS = ['ana', 'p-larkin', 'moonguard', 'oran'];
const FIXTURE_VERDICTS = ['ok', 'nerf', 'boost', 'reject'];
function _fixtureFor(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const kind = kindOfId(id) || 'effect';
  const slug = id.replace(/^(effect|skill)_/, '').replace(/_/g, '-');
  const who = FIXTURE_AUTHORS[h % FIXTURE_AUTHORS.length];
  const hex = (h.toString(16) + 'c0ffee1234567890abcdef').padEnd(40, '0');
  return normalizeSource({ repo: REPOS[kind], branch: `players/${who}/${slug}`, commit: hex.slice(0, 40), sha256: (hex + hex).slice(0, 64), author: who, verdict: FIXTURE_VERDICTS[(h >>> 3) % 4], id }, kind);
}
const _fixtureCache = new Map();   // ?fxsrc=all: one object per id (stable identity, no per-frame hashing)
if (DEV_FIXTURE === 'demo') {
  const demo = { effect_fireball: 'ok', effect_shield: 'nerf', effect_lightning: 'boost', effect_haste: 'reject' };
  for (const [id, verdict] of Object.entries(demo)) setEffectSource(id, { ..._fixtureFor(id), verdict });
  // Skills (S6): Dodge from players/ana/quick-dodge (ok), Powerful Attack from players/p-larkin/heavy-swing (nerfed).
  const skillDemo = {
    skill_dodge: { branch: 'players/ana/quick-dodge', author: 'ana', verdict: 'ok' },
    skill_powerful_attack: { branch: 'players/p-larkin/heavy-swing', author: 'p-larkin', verdict: 'nerf' },
  };
  for (const [id, s] of Object.entries(skillDemo)) setEffectSource(id, { ..._fixtureFor(id), ...s });
}

// The provenance of a catalog card: accepts an effect / skill id, a wire card ({effect_id |
// skill_id, source}), a catalog info ({id, source}) or a source/ref object itself.
// null ⇒ built-in (main branch of its repo) ⇒ show nothing.
export function effectSource(x) {
  if (!x) return null;
  if (typeof x === 'object') {
    if (x.branch !== undefined && x.effect_id === undefined && x.skill_id === undefined && x.class_id === undefined) return normalizeSource(x);   // a ref / source itself
    const id = x.effect_id || x.skill_id || x.class_id || x.id || null;
    if (x.source) { const n = normalizeSource(x.source, kindOfId(id)); if (n) return n; }
    x = id;
    if (!x) return null;
  }
  const id = String(x);
  if (!kindOfId(id)) return null;
  const hit = _reg.get(id);
  if (hit || DEV_FIXTURE !== 'all') return hit || null;
  if (!_fixtureCache.has(id)) _fixtureCache.set(id, _fixtureFor(id));
  return _fixtureCache.get(id);
}
// Kind-neutral aliases (same functions).
export { effectSource as cardSource, setEffectSource as setCardSource };

// Compact surfaces (hand slot, perms strip) drop the `players/` prefix: "⎇ ana/fire-whip".
export const sourceLabel = (src, compact = false) => `⎇ ${compact ? src.branch.replace(/^players\//, '') : src.branch}`;

export function sourceTitle(src) {
  const v = src.verdict ? VERDICTS[src.verdict] : null;
  return [
    `Player ${KINDS.has(src.kind) ? src.kind : 'effect'} — from ${src.repo} branch ${src.branch}`,
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
export const cardSourceBadge = effectSourceBadge;
// Plain-text mark for text-only surfaces (the `[EM + A + ✦BT + ✦Po⎇]` chip, canvas labels): '⎇' or ''.
export const sourceMark = x => (effectSource(x) ? '⎇' : '');

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
