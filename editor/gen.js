// editor/gen.js — "Generate from a description…" (b9, 2026-11-23): describe a new effect, skill or class (+ the tags it
// must have — coloured labels, an element may repeat —, a picture / sound from chaosD6-Resources with an animated preview
// and ▶, or for a class the whole voice of one unit) → the node's big model writes it → preview → a private background test
// game → retry with changes → publish on the team's branch (custom). The draft page shows the rebalance validator's
// report and the whole conversation (description, retries, the model's answers, the validator, the test reviews).
// app.js imports this next to author.js and calls initGeneration(ctx); same plug-in style (registerHeaderAction,
// registerRoute, openSheet, toast, navigate, jsonfmt). Server: /rules/api/gen/* (game/gen-api.mjs) — POST needs
// the session token and a signed-in team owner; GET drafts/<id> is the status poll (every 10 s while a job runs).
// Routes: #/gen/ (drafts + the description form), #/gen/<kind> (the form for that kind), #/gen/d/<draft_id> (one draft),
// #/gen/proposals (other teams' GameModels proposals: try + vote).
// Nothing here touches `document` at import time.

const KINDS = ['effect', 'skill', 'class', 'npc', 'building', 'monster'];
const POLL_MS = 10_000;
let C = null;

export const GEN_CSS = `
.gen-status{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.45;
  padding:8px 10px;border-radius:6px;background:var(--code-bg,rgba(127,127,127,.08));white-space:pre-wrap;word-break:break-word}
.gen-status:empty{display:none}
.gen-state{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:700;font-size:.85em;background:rgba(127,127,127,.18)}
.gen-state.s-ok{background:rgba(46,160,67,.22)}.gen-state.s-bad{background:rgba(217,83,79,.25)}.gen-state.s-run{background:rgba(61,123,224,.25)}
.gen-custom{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.78em;font-weight:700;letter-spacing:.03em;
  background:linear-gradient(90deg,#b36bff,#3d7be0);color:#fff;text-transform:uppercase}
.gen-list{display:flex;flex-direction:column;gap:8px}
.gen-item{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:8px 10px;border-radius:6px;
  border:1px solid var(--border,rgba(127,127,127,.35));cursor:pointer}
.gen-item .gen-idea{flex:1 1 220px;min-width:0;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gen-sugg{display:flex;flex-direction:column;gap:6px}
.gen-sugg button{text-align:left;white-space:normal}
.gen-sugg button.on{outline:2px solid var(--accent,#3d7be0)}
.gen-card{border:1px solid var(--border,rgba(127,127,127,.35));border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.gen-card .gen-elems{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em;opacity:.85}
.gen-bar .au-btn:disabled{opacity:.4;filter:grayscale(.7);cursor:default}
.gen-log{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;max-height:240px;overflow:auto}
.gen-tags{display:flex;flex-direction:column;gap:6px}
.gen-tag-group{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}
.gen-tag-group>summary{cursor:pointer;font-size:.9em;opacity:.85}
.gen-tag-label{font-size:.85em;opacity:.75;min-width:7em}
.gen-chips{display:flex;flex-wrap:wrap;gap:4px}
.gen-chip{--c:#8a8f99;font:inherit;font-size:.82em;padding:2px 9px;border-radius:999px;cursor:pointer;color:inherit;
  border:1px solid color-mix(in srgb,var(--c) 55%,transparent);background:color-mix(in srgb,var(--c) 8%,transparent);transition:background .12s,transform .08s}
.gen-chip:hover{background:color-mix(in srgb,var(--c) 22%,transparent)}.gen-chip:active{transform:scale(.95)}
.gen-chip.on{background:color-mix(in srgb,var(--c) 32%,transparent);border-color:var(--c);font-weight:600}
.gen-chip .gen-n{font-weight:700;margin-left:3px}.gen-chip .gen-n:empty{display:none}
.gen-tagedit{display:flex;flex-direction:column;gap:8px}
.gen-picked{display:flex;flex-wrap:wrap;gap:5px;align-items:center;min-height:28px;padding:5px 6px;border-radius:8px;
  border:1px dashed var(--border,rgba(127,127,127,.4))}
.gen-pill{--c:#8a8f99;display:inline-flex;align-items:center;gap:5px;padding:2px 4px 2px 10px;border-radius:999px;font-size:.86em;font-weight:600;
  border:1px solid var(--c);background:color-mix(in srgb,var(--c) 26%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--c) 15%,transparent) inset}
.gen-pill:not(:has(.gen-pill-x)){padding-right:10px}
.gen-pill-k{font-size:.78em;font-weight:500;opacity:.7;text-transform:uppercase;letter-spacing:.03em}
.gen-pill-x{font:inherit;line-height:1;width:20px;height:20px;border-radius:50%;border:0;padding:0;cursor:pointer;color:inherit;
  background:color-mix(in srgb,var(--c) 30%,transparent)}.gen-pill-x:hover{background:#d9534f;color:#fff}
.gen-pill.ok{border-style:solid}.gen-pill.bad{border-color:#d9534f;background:repeating-linear-gradient(135deg,rgba(217,83,79,.28) 0 6px,rgba(217,83,79,.14) 6px 12px)}
.gen-res{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.gen-res input{flex:1 1 200px;min-width:0}.gen-res .au-hint{flex-basis:100%}
.gen-res input.gen-bad{outline:2px solid #d9534f}
.gen-media{display:flex;flex-direction:column;gap:8px}
.gen-media-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.gen-media-fields{flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:6px}
.gen-prev{flex:0 0 auto}
.gen-sprite{width:104px;height:104px;display:flex;align-items:center;justify-content:center;border-radius:10px;overflow:hidden;
  background:radial-gradient(circle at 50% 45%,rgba(255,255,255,.10),rgba(0,0,0,.35)),#14161c;border:1px solid var(--border,rgba(127,127,127,.35))}
.gen-media-show .gen-sprite{width:80px;height:80px}
.gen-sprite .au-hint{font-size:.75em;text-align:center;padding:4px;color:#aab}
.gen-sprite-cell{background-repeat:no-repeat;image-rendering:auto}
.gen-play{min-width:38px;font-size:1em}.gen-play.playing{background:rgba(46,160,67,.3);border-color:#2ea043}
.gen-x{min-width:32px;padding-left:6px;padding-right:6px}
.gen-sound-name{font-size:.9em;opacity:.85}
.gen-gallery-box>summary{cursor:pointer;font-size:.9em;opacity:.85}
.gen-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:6px;max-height:300px;overflow:auto;padding:6px 2px}
.gen-thumb{font:inherit;display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px;border-radius:8px;cursor:pointer;color:inherit;
  border:1px solid var(--border,rgba(127,127,127,.3));background:#14161c}
.gen-thumb.on{outline:2px solid var(--accent,#3d7be0);background:rgba(61,123,224,.25)}.gen-thumb.far{opacity:.75}
.gen-thumb-box{width:56px;height:56px;display:flex;align-items:center;justify-content:center}
.gen-thumb-img{background-repeat:no-repeat;background-position:0 0}
.gen-thumb-name{font-size:.68em;line-height:1.15;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccd}
.gen-draft-facts{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.gen-fact{display:flex;flex-direction:column;gap:5px;padding:8px 10px;border-radius:8px;border:1px solid var(--border,rgba(127,127,127,.3))}
.gen-fact-k{font-size:.78em;font-weight:700;text-transform:uppercase;letter-spacing:.04em;opacity:.7}
.gen-media-line{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.gen-media-edit{padding-top:6px;border-top:1px dashed var(--border,rgba(127,127,127,.3))}
.gen-tag-why{font-size:.84em;color:#e88;display:flex;flex-direction:column;gap:2px}.gen-tag-why:empty{display:none}
.gen-voice{display:flex;flex-direction:column;gap:6px}.gen-race,.gen-unit-sel{flex:1 1 160px;min-width:0}
.gen-voice-box>summary{cursor:pointer;font-size:.88em;opacity:.85}
.gen-voice-list{margin:4px 0 0;padding-left:22px;max-height:220px;overflow:auto;font-size:.88em;display:flex;flex-direction:column;gap:2px}
.gen-voice-list li{cursor:pointer;padding:1px 4px;border-radius:4px}.gen-voice-list li:hover{background:rgba(127,127,127,.15)}.gen-voice-list li.on{background:rgba(46,160,67,.22);font-weight:600}
.gen-retry-more>summary{cursor:pointer;font-weight:600;font-size:.92em;margin:4px 0}
.gen-talk{display:flex;flex-direction:column;gap:6px}
.gen-talk-round{font-weight:700;font-size:.85em;opacity:.7;text-transform:uppercase;letter-spacing:.04em;margin-top:6px}
.gen-talk-msg{border-left:3px solid rgba(127,127,127,.4);padding:2px 8px}
.gen-talk-msg pre{margin:2px 0 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
.gen-talk-msg.r-player{border-color:#3d7be0}.gen-talk-msg.r-model{border-color:#b36bff}.gen-talk-msg.r-validator{border-color:#e0a03d}.gen-talk-msg.r-test{border-color:#2ea043}
.gen-talk-who{font-size:.8em;font-weight:700;opacity:.8}
.gm-proposal{display:flex;flex-direction:column;gap:8px;padding:10px 0 16px;border-bottom:1px solid var(--border,rgba(127,127,127,.35))}
.gm-vote{display:flex;flex-direction:column;gap:6px;max-width:520px}
.gm-vote input[type=range]{flex:1}
.gm-vote-v{min-width:2.5em;text-align:right;font-variant-numeric:tabular-nums}
.gm-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-radius:12px;border:1px solid var(--border,rgba(127,127,127,.35));
  background:linear-gradient(180deg,rgba(224,160,61,.07),transparent 120px)}
.gm-head{display:flex;gap:14px;align-items:flex-start}
.gm-portrait{flex:0 0 auto;border-radius:10px;border:1px solid rgba(224,160,61,.55);background:#14161c no-repeat top center/100% auto;
  display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.35)}
.gm-portrait.gm-bld{background-size:contain;background-position:center}.gm-portrait .au-hint{font-size:.7em;text-align:center;padding:3px;color:#aab}
.gm-id{display:flex;flex-direction:column;gap:5px;min-width:0}
.gm-name{font-size:1.25em;font-weight:700;letter-spacing:.01em}
.gm-pills{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.gm-pill{font-size:.78em;font-weight:600;padding:1px 9px;border-radius:999px;background:rgba(61,123,224,.2);border:1px solid rgba(61,123,224,.45)}
.gm-pill.r{background:rgba(224,160,61,.2);border-color:rgba(224,160,61,.5)}.gm-pill.e{background:rgba(46,160,67,.18);border-color:rgba(46,160,67,.5)}
.gm-persona{font-style:italic;opacity:.9}
.gm-sec{display:flex;flex-direction:column;gap:6px}
.gm-sec-k{font-size:.78em;font-weight:700;text-transform:uppercase;letter-spacing:.05em;opacity:.65}
.gm-bubbles{display:flex;flex-direction:column;gap:6px}
.gm-bubble{position:relative;align-self:flex-start;max-width:min(560px,92%);padding:6px 12px;border-radius:14px 14px 14px 4px;
  background:rgba(127,127,127,.13);border:1px solid rgba(127,127,127,.25);line-height:1.35}
.gm-bubble-k{display:block;font-size:.72em;font-weight:700;text-transform:uppercase;letter-spacing:.04em;opacity:.6;margin-bottom:1px}
.gm-bubble.k-quest{border-color:rgba(224,160,61,.55)}.gm-bubble.k-thanks{border-color:rgba(46,160,67,.5)}.gm-bubble.k-warn{border-color:rgba(217,83,79,.55)}
.gm-bubble.k-lore,.gm-bubble.k-talk{border-color:rgba(179,107,255,.5)}
.gm-ask{border-left:3px solid rgba(61,123,224,.6);padding:2px 0 2px 10px}.gm-ask>summary{cursor:pointer;font-weight:600;margin-bottom:4px}
.gm-ask .gm-bubble{margin:3px 0}
.gm-quest{padding:8px 10px;border-radius:8px;border:1px solid rgba(224,160,61,.45);background:rgba(224,160,61,.06);display:flex;flex-direction:column;gap:4px}
.gm-quest.barter{border-color:rgba(46,160,160,.5);background:rgba(46,160,160,.06)}
.gm-quest-name{font-weight:700}
.gm-rewards{display:flex;flex-wrap:wrap;gap:5px}
.gm-reward{font-size:.8em;padding:1px 8px;border-radius:999px;background:rgba(46,160,67,.16);border:1px solid rgba(46,160,67,.4)}
.gm-stats{display:flex;flex-direction:column;gap:3px;max-width:420px}
.gm-stat{display:grid;grid-template-columns:5.5em 1fr 2em;gap:8px;align-items:center;font-size:.85em}
.gm-stat i{display:block;height:7px;border-radius:4px;background:linear-gradient(90deg,#3d7be0,#b36bff)}.gm-stat b{text-align:right}
.gm-facts{display:flex;flex-direction:column;gap:4px}
@media (max-width:640px){.gm-head{flex-direction:column;align-items:center;text-align:center}.gm-pills{justify-content:center}.gm-bubble{max-width:100%}}
@media (max-width:640px){.gen-draft-facts{grid-template-columns:1fr}.gen-item .gen-idea{flex-basis:100%;white-space:normal}.au-bar .au-btn{flex:1 1 auto}.gen-tag-label{min-width:0;flex-basis:100%}}
`;

const h = (...a) => C.el(...a);
const loggedIn = () => !!(C.session && C.session.logged_in);
const RUNNING = ['generating', 'testing', 'publishing'];
const stateClass = (s) => (/success|published/.test(s) ? 's-ok' : /failed|no draft/.test(s) ? 's-bad' : RUNNING.includes(s) ? 's-run' : '');
const statePill = (s) => h('span', { class: `gen-state ${stateClass(s)}` }, s || '?');
const customBadge = () => h('span', { class: 'gen-custom', title: 'Made by a player (custom)' }, 'custom');
const errText = (e) => String((e && (e.error || e.message)) || e);

async function genApi(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (C.session?.token) headers['X-Editor-Token'] = C.session.token; }
  let r;
  try {
    r = await fetch('api/gen/' + path, { method, headers, cache: 'no-store', credentials: 'same-origin', body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  } catch (e) { throw { status: 0, error: e?.message || 'network error' }; }
  let json = null;
  try { json = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw { status: r.status, error: json?.error || r.statusText || `HTTP ${r.status}`, body: json };
  return json;
}
async function act(btn, fn) {
  const was = btn.disabled; btn.disabled = true;
  try { return await fn(); } catch (e) { C.toast(errText(e), 'error'); return null; } finally { btn.disabled = was; }
}
function pane(title, kids) { return h('div', { class: 'au-form', 'data-title': title }, ...kids.flat().filter(Boolean)); }
function signInPane() {
  return pane('Generate from a description', [h('p', { class: 'au-hint' }, 'Generating needs your team identity: sign in from the startup menu (set your team), then reload.')]);
}

// ---------------------------------------------------------------- tags + media components
// The element colours of the map (game/js/renderer.js ELEM_COLOR); the other groups get a hue of their own.
const ELEM_COLOR = { vitality: '#ff6b6b', souls: '#b48cff', time: '#d9c36a', space: '#8fa3ff', air: '#dfe3e8', water: '#6ad9ff',
  earth: '#c49a6c', fire: '#ff9a3c', concentration: '#6ad99f', harmony: '#ffb6e6' };
const GROUP_COLOR = { kind: '#3d7be0', duration: '#e0a03d', damage: '#d9534f', scope: '#2ea0a0', type: '#b36bff', tag: '#8a8f99',
  action: '#3d7be0', lasts: '#e0a03d', stat: '#2ea043', does: '#b36bff', ability: '#3d7be0', power: '#b36bff', needs: '#2ea0a0' };
const tagColor = (t) => { const [k, v = ''] = String(t).split(':'); return k === 'element' || k === 'color' ? ELEM_COLOR[v.replace(/^elem_/, '')] || '#ccc' : GROUP_COLOR[k] || '#8a8f99'; };
const tagText = (t) => { const [k, ...v] = String(t).split(':'); const s = v.join(':').replace(/^elem_/, ''); return k === 'stat' ? s.replace(/^stat_/, '') : s; };
// a coloured label: tinted fill + border in the group's colour
const tagPill = (t, extra = {}, ...kids) => h('span', { class: `gen-pill${extra.cls ? ` ${extra.cls}` : ''}`, style: `--c:${tagColor(t)}`, title: extra.title || t }, ...kids);

const vocabCache = new Map();
async function loadVocab(kind) {
  if (!vocabCache.has(kind)) { try { vocabCache.set(kind, await genApi(`vocab?kind=${encodeURIComponent(kind)}`)); } catch (e) { C.toast(errText(e), 'error'); return { groups: [] }; } }
  return vocabCache.get(kind);
}

/** The tag editor (user 2026-11-23): the picked tags as coloured labels with × (in order; an element may repeat —
 *  water, fire, water = two water in the cost, ≤ max), and the groups' chips below to add one. 'one' groups replace,
 *  'set' groups toggle, 'count' groups add another copy. → { el, value(), set(tags), setKind(kind) } */
function tagEditor(kind, initial = []) {
  let groups = [], tags = [...initial];
  const picked = h('div', { class: 'gen-picked', 'aria-live': 'polite' });
  const add = h('div', { class: 'gen-tags' });
  const gOf = (t) => groups.find(g => g.id === String(t).split(':')[0]);
  const addTag = (g, val) => {
    const t = `${g.id}:${val}`;
    if (g.mode === 'one') tags = [...tags.filter(x => !x.startsWith(`${g.id}:`)), t];
    else if (g.mode === 'count') { if (tags.filter(x => x.startsWith(`${g.id}:`)).length >= (g.max || 4)) { C.toast(`At most ${g.max || 4} ${g.label} tags`, 'info'); return; } tags.push(t); }
    else if (tags.includes(t)) tags = tags.filter(x => x !== t); else tags.push(t);
    if (tags.length > 16) tags = tags.slice(0, 16);
    draw();
  };
  const draw = () => {
    picked.replaceChildren(...(tags.length ? tags.map((t, i) => tagPill(t, { title: `${gOf(t)?.label || ''}: ${tagText(t)} — click × to remove` },
      h('span', { class: 'gen-pill-k' }, gOf(t)?.label || t.split(':')[0]), tagText(t),
      h('button', { type: 'button', class: 'gen-pill-x', 'aria-label': `remove ${t}`, onclick: () => { tags.splice(i, 1); draw(); } }, '×')))
      : [h('span', { class: 'au-hint' }, 'No tags yet — click the chips below to add.')]));
    for (const b of add.querySelectorAll('[data-tag]')) {
      const n = tags.filter(x => x === b.dataset.tag).length;
      b.classList.toggle('on', n > 0);
      b.setAttribute('aria-pressed', String(n > 0));
      b.querySelector('.gen-n').textContent = n > 1 ? `×${n}` : '';
    }
  };
  const build = () => {
    add.replaceChildren(...groups.map(g => {
      const chips = g.values.map(val => h('button', { class: 'gen-chip', type: 'button', style: `--c:${tagColor(`${g.id}:${val}`)}`, dataset: { tag: `${g.id}:${val}` }, 'aria-pressed': 'false',
        title: `${g.label}: ${val}${g.mode === 'count' ? ' (click again to add another)' : g.mode === 'one' ? ' (one of the group)' : ''}`, onclick: () => addTag(g, val) },
        g.mode === 'count' ? '+ ' : '', tagText(`${g.id}:${val}`), h('span', { class: 'gen-n' })));
      const label = `${g.label}${g.mode === 'count' ? ` (repeatable, ≤ ${g.max || 4})` : g.mode === 'one' ? ' (one)' : ''}`;
      return g.values.length > 12
        ? h('details', { class: 'gen-tag-group' }, h('summary', null, `${label} · ${g.values.length}`), h('div', { class: 'gen-chips' }, ...chips))
        : h('div', { class: 'gen-tag-group' }, h('span', { class: 'gen-tag-label' }, label), h('div', { class: 'gen-chips' }, ...chips));
    }));
    draw();
  };
  const setKind = async (k) => { kind = k; groups = (await loadVocab(k)).groups || []; tags = tags.filter(t => gOf(t)); build(); };
  const el = h('div', { class: 'gen-tagedit' }, picked, add);
  setKind(kind);
  return { el, value: () => [...tags], set: (t) => { tags = [...(t || [])]; draw(); }, setKind: (k) => { tags = []; return setKind(k); } };
}

/** The picked tags on the draft page: coloured labels, ✓ met / ✗ missed (a hard requirement), neutral before a draft. */
function tagStatus(d) {
  const missed = d.tag_problems || [];
  return (d.tags || []).map(t => {
    const miss = missed.find(p => p.startsWith(`tag ${t} `));
    if (!d.def) return tagPill(t, { title: 'checked once there is a draft' }, tagText(t));
    return tagPill(t, { cls: miss ? 'bad' : 'ok', title: miss || 'met' }, miss ? '✗ ' : '✓ ', tagText(t));
  });
}

// Media: '/assets/<path>' (absolute — the editor lives at /rules/; ui-server and the mobile menu serve /assets/*, the
// menu fills a missing file from the OCI pack), each segment encoded (names hold spaces, brackets, parentheses).
const mediaUrl = (p) => '/' + String(p).split('/').map(encodeURIComponent).join('/');
let resCache = null;
async function loadResources() {
  if (!resCache) { try { resCache = await genApi('resources'); } catch { resCache = { sprites: [], sounds: [], units: [] }; } }
  return resCache;
}
let audioNow = null;
/** Plays a sound file; false (+ toast) when this node cannot fetch it ("not on this phone yet"). */
async function playSound(p, btn) {
  try { audioNow?.pause(); } catch {}
  const a = new Audio(mediaUrl(p));
  audioNow = a;
  btn?.classList.add('playing');
  a.addEventListener('ended', () => btn?.classList.remove('playing'));
  try { await a.play(); return true; } catch { btn?.classList.remove('playing'); C.toast('That sound is not on this node yet (it is fetched when the game first needs it)', 'info'); return false; }
}
/** An animated preview of a sprite strip (the catalogue's grid: cols × rows cells of w × h at fps), ≤ size px. */
function spritePreview(sprite, size = 96) {
  const box = h('div', { class: 'gen-sprite' });
  if (!sprite) { box.append(h('span', { class: 'au-hint' }, 'no picture')); return box; }
  const g = sprite.grid, url = mediaUrl(sprite.path);
  const probe = new Image();
  probe.onerror = () => box.replaceChildren(h('span', { class: 'au-hint' }, 'not on this node yet'));
  probe.onload = () => {
    const cols = g?.cols || 1, rows = g?.rows || 1;
    const w = g?.w || probe.naturalWidth / cols, hh = g?.h || probe.naturalHeight / rows;
    const s = Math.min(size / w, size / hh, 3);
    const cell = h('div', { class: 'gen-sprite-cell', style: { width: `${Math.round(w * s)}px`, height: `${Math.round(hh * s)}px`, backgroundImage: `url("${url}")`, backgroundSize: `${Math.round(cols * w * s)}px ${Math.round(rows * hh * s)}px` } });
    box.replaceChildren(cell);
    const n = cols * rows;
    if (n < 2) return;
    let i = 0, seen = false;
    const timer = setInterval(() => {
      if (box.isConnected) seen = true; else if (seen) { clearInterval(timer); return; } else return;
      i = (i + 1) % n;
      cell.style.backgroundPosition = `${-Math.round((i % cols) * w * s)}px ${-Math.round(Math.floor(i / cols) * hh * s)}px`;
    }, 1000 / Math.max(2, Math.min(30, g?.fps || 10)));
  };
  probe.src = url;
  return box;
}

/** The picture + sound picker: a search field each (every effect sprite / sound fx of chaosD6-Resources, also the ones
 *  the phone has not downloaded), the animated preview, ▶ to hear the sound, a gallery to browse. → { el, value(), set(pick) } */
async function mediaPicker(initial = null, { onChange } = {}) {
  const cat = await loadResources();
  const sprites = cat.sprites || [], sounds = cat.sounds || [];
  let pick = { sprite: initial?.sprite || null, sound: initial?.sound || null };
  const uid = Math.random().toString(36).slice(2, 8);
  const find = (list, v) => { v = String(v || '').trim(); return v ? list.find(x => x.name === v) || list.find(x => x.path === v) || null : null; };
  const nameOf = (list, p) => list.find(x => x.path === p)?.name || (p ? p.replace(/^assets\//, '') : '');
  const field = (id, list, ph) => {
    const dl = h('datalist', { id: `${id}-${uid}` }, ...list.map(x => h('option', { value: x.name, label: `${x.in_pack ? '' : 'not on the phone yet · '}${x.path.replace(/^assets\/(Sprites|Sounds)\//, '')}` })));
    const input = h('input', { type: 'search', list: `${id}-${uid}`, placeholder: ph, autocomplete: 'off', spellcheck: 'false' });
    return { dl, input };
  };
  const sp = field('gen-sprite', sprites, `search ${sprites.length} pictures`), so = field('gen-sound', sounds, `search ${sounds.length} sounds`);
  const prev = h('div', { class: 'gen-prev' });
  const play = h('button', { class: 'au-btn gen-play', type: 'button', title: 'Play the sound' }, '▶');
  const soundName = h('span', { class: 'gen-sound-name' });
  const gallery = h('div', { class: 'gen-gallery' });
  const galleryBox = h('details', { class: 'gen-gallery-box' }, h('summary', null, `Browse the pictures (${sprites.length})`), gallery);
  const draw = () => {
    const s = sprites.find(x => x.path === pick.sprite) || (pick.sprite ? { path: pick.sprite } : null);
    prev.replaceChildren(spritePreview(s, 96));
    sp.input.value = pick.sprite ? nameOf(sprites, pick.sprite) : '';
    so.input.value = pick.sound ? nameOf(sounds, pick.sound) : '';
    play.disabled = !pick.sound;
    soundName.textContent = pick.sound ? nameOf(sounds, pick.sound) : 'no sound';
    for (const t of gallery.querySelectorAll('[data-path]')) t.classList.toggle('on', t.dataset.path === pick.sprite);
  };
  const changed = () => { draw(); onChange?.(value()); };
  sp.input.addEventListener('change', () => { const v = sp.input.value.trim(); const x = find(sprites, v); sp.input.classList.toggle('gen-bad', !!v && !x); if (x || !v) { pick.sprite = x?.path || null; changed(); } });
  so.input.addEventListener('change', () => { const v = so.input.value.trim(); const x = find(sounds, v); so.input.classList.toggle('gen-bad', !!v && !x); if (x || !v) { pick.sound = x?.path || null; changed(); if (x) playSound(x.path, play); } });
  play.addEventListener('click', () => pick.sound && playSound(pick.sound, play));
  galleryBox.addEventListener('toggle', () => {
    if (!galleryBox.open || gallery.childElementCount) return;
    // first frame of each strip, lazily (the phone fetches what it lacks)
    gallery.replaceChildren(...sprites.map(x => {
      const g = x.grid, s = g ? Math.min(56 / g.w, 56 / g.h, 2) : 0;   // the first cell, its own aspect
      const t = h('button', { type: 'button', class: `gen-thumb${x.in_pack ? '' : ' far'}`, dataset: { path: x.path }, title: `${x.name}${x.in_pack ? '' : ' (not on the phone yet)'}`,
        onclick: () => { pick.sprite = x.path; changed(); } },
        h('span', { class: 'gen-thumb-box' }, h('span', { class: 'gen-thumb-img', style: g
          ? { backgroundImage: `url("${mediaUrl(x.path)}")`, width: `${Math.round(g.w * s)}px`, height: `${Math.round(g.h * s)}px`, backgroundSize: `${Math.round(g.cols * g.w * s)}px ${Math.round(g.rows * g.h * s)}px` }
          : { backgroundImage: `url("${mediaUrl(x.path)}")`, width: '56px', height: '56px', backgroundSize: 'contain', backgroundPosition: 'center' } })),
        h('span', { class: 'gen-thumb-name' }, x.name));
      return t;
    }));
    draw();
  });
  const clear = (k) => h('button', { class: 'au-btn gen-x', type: 'button', title: `No ${k}`, onclick: () => { pick[k] = null; changed(); } }, '✕');
  const value = () => (pick.sprite || pick.sound ? { sprite: pick.sprite, sound: pick.sound } : null);
  const el = h('div', { class: 'gen-media' },
    h('div', { class: 'gen-media-row' }, prev, h('div', { class: 'gen-media-fields' },
      h('div', { class: 'gen-res' }, sp.input, sp.dl, clear('sprite')),
      h('div', { class: 'gen-res' }, so.input, so.dl, play, clear('sound')))),
    galleryBox,
    h('div', { class: 'au-hint' }, cat.source ? `From ${cat.source}${cat.generated_at ? ` (${String(cat.generated_at).slice(0, 10)})` : ''}; optional — not priced, so changing it never needs a new test.` : 'The resource catalogue is missing (node tools/gen-resources-list.mjs).'));
  draw();
  return { el, value, set: (p) => { pick = { sprite: p?.sprite || null, sound: p?.sound || null }; draw(); } };
}

/** The draft's picture + sound, read-only: the animated preview and ▶. */
function mediaShow(pick) {
  if (!pick || !(pick.sprite || pick.sound)) return [h('span', { class: 'au-hint' }, 'none picked')];
  const cat = resCache || { sprites: [], sounds: [] };
  const s = (cat.sprites || []).find(x => x.path === pick.sprite) || (pick.sprite ? { path: pick.sprite } : null);
  const name = (list, p) => (list || []).find(x => x.path === p)?.name || String(p).replace(/^assets\//, '');
  const play = h('button', { class: 'au-btn gen-play', type: 'button', title: 'Play the sound', disabled: !pick.sound, onclick: () => playSound(pick.sound, play) }, '▶');
  return [h('div', { class: 'gen-media-row' }, h('div', { class: 'gen-prev' }, spritePreview(s, 72)),
    h('div', { class: 'gen-media-fields' }, h('div', null, pick.sprite ? name(cat.sprites, pick.sprite) : 'no picture'),
      h('div', { class: 'gen-res' }, play, h('span', { class: 'gen-sound-name' }, pick.sound ? name(cat.sounds, pick.sound) : 'no sound'))))];
}

/** A class's voice (user 2026-11-23): the WHOLE sound set of one chaosD6-Resources unit. Pick the unit, then ▶ plays
 *  its sounds one after another — click again and again to hear them all. → [el] (the ▶ + "n/N kind — line") */
function voiceCycler(sounds) {
  let i = 0;
  const label = h('span', { class: 'gen-sound-name' });
  const play = h('button', { class: 'au-btn gen-play', type: 'button', title: 'Play the next sound of this unit (click again and again)' }, '▶');
  const list = h('ol', { class: 'gen-voice-list' });
  const draw = () => {
    const s = sounds[i];
    label.textContent = s ? `${i + 1}/${sounds.length} · ${s.kind}${s.line ? ` — “${s.line}”` : ''}` : 'no sounds';
    play.disabled = !sounds.length;
    list.replaceChildren(...sounds.map((x, k) => h('li', { class: k === i ? 'on' : '', title: x.path, onclick: () => { i = k; draw(); playSound(x.path, play); } },
      `${x.kind}${x.line ? ` — “${x.line}”` : ''}${x.in_pack === false ? ' · not on the phone yet' : ''}`)));
  };
  play.addEventListener('click', async () => { const s = sounds[i]; if (!s) return; draw(); await playSound(s.path, play); i = (i + 1) % sounds.length; label.textContent = `${i + 1}/${sounds.length} next · ${sounds[i].kind}${sounds[i].line ? ` — “${sounds[i].line}”` : ''}`; });
  draw();
  return [h('div', { class: 'gen-res' }, play, label), h('details', { class: 'gen-voice-box' }, h('summary', null, `All ${sounds.length} sounds`), list)];
}
const unitKey = (u) => (u ? `${u.race}/${u.unit}` : '');

/** The class media picker: a searchable unit field (179 units of chaosD6-Resources, by race) + the voice cycler. → { el, value(), set(pick) } */
async function unitPicker(initial = null) {
  const cat = await loadResources();
  const units = cat.units || [];
  let cur = null;
  const uid = Math.random().toString(36).slice(2, 8);
  const dl = h('datalist', { id: `gen-unit-${uid}` }, ...units.map(u => h('option', { value: unitKey(u), label: `${u.unit} (${u.race}) · ${u.sounds.length} sounds${u.sounds.some(s => s.in_pack === false) ? ' · some not on the phone yet' : ''}` })));
  const input = h('input', { type: 'search', list: `gen-unit-${uid}`, placeholder: `search ${units.length} units (race/unit)`, autocomplete: 'off', spellcheck: 'false' });
  const race = h('select', { class: 'gen-race', title: 'Filter by race' }, h('option', { value: '' }, 'any race'), ...[...new Set(units.map(u => u.race))].map(r => h('option', { value: r }, r)));
  const unitSel = h('select', { class: 'gen-unit-sel' });
  const voice = h('div', { class: 'gen-voice' });
  const fillUnits = () => {
    const list = units.filter(u => !race.value || u.race === race.value);
    unitSel.replaceChildren(h('option', { value: '' }, `— a unit (${list.length}) —`), ...list.map(u => h('option', { value: unitKey(u), selected: unitKey(u) === unitKey(cur) }, `${u.unit}${race.value ? '' : ` (${u.race})`} · ${u.sounds.length}`)));
  };
  const draw = () => {
    input.value = cur ? unitKey(cur) : '';
    voice.replaceChildren(...(cur ? voiceCycler(cur.sounds) : [h('span', { class: 'au-hint' }, 'no unit — the class has no voice')]));
    fillUnits();
  };
  const pick = (k) => { cur = units.find(u => unitKey(u) === k) || null; if (cur && race.value && race.value !== cur.race) race.value = cur.race; draw(); };
  input.addEventListener('change', () => { const v = input.value.trim(); const ok = !v || units.some(u => unitKey(u) === v); input.classList.toggle('gen-bad', !ok); if (ok) pick(v); });
  race.addEventListener('change', fillUnits);
  unitSel.addEventListener('change', () => pick(unitSel.value));
  const clear = h('button', { class: 'au-btn gen-x', type: 'button', title: 'No voice', onclick: () => pick('') }, '✕');
  const set = (p) => { cur = units.find(u => unitKey(u) === (typeof p?.unit === 'string' ? p.unit : unitKey(p?.unit))) || null; draw(); };
  set(initial);
  const el = h('div', { class: 'gen-media' },
    h('div', { class: 'gen-res' }, race, unitSel), h('div', { class: 'gen-res' }, input, dl, clear), voice,
    h('div', { class: 'au-hint' }, 'The class speaks with the whole sound set of the unit you pick. Press ▶ again and again to hear every one. It is not priced, so changing it never needs a new test.'));
  return { el, value: () => (cur ? { unit: unitKey(cur) } : null), set };
}
/** The draft's unit voice, read-only: the unit + the cycler. */
function unitShow(pick) {
  const u = pick?.unit;
  if (!u) return [h('span', { class: 'au-hint' }, 'no unit picked')];
  const full = (resCache?.units || []).find(x => unitKey(x) === unitKey(u));
  return [h('div', { class: 'gen-media-fields' }, h('div', null, h('b', null, u.unit), ` · ${u.race}`), ...voiceCycler(full?.sounds || u.sounds || []))];
}
// ---------------------------------------------------------------- GameModels (npc, building, monster; game/gm-gen.mjs)
// A GameModels draft borrows the art of an existing NPC / building ("looks like"), and is shown as a card that reads
// like the game: portrait, persona, what it says (speech bubbles), the questions a hero can ask, its quests.
const GM_KINDS = ['npc', 'building', 'monster'];
const isGm = (k) => GM_KINDS.includes(k);
let gmCache = null;
async function loadGm() {
  if (!gmCache) { try { gmCache = await genApi('gm'); } catch { gmCache = { available: false, edit: [], looks: { npc: [], building: [], monster: [] }, races: [], villages: [] }; } }
  return gmCache;
}
const raceName = (id) => gmCache?.races?.find(r => r.id === id)?.name || String(id || '').replace(/^race_/, '').replace(/_/g, ' ');
const roleName = (r) => String(r || '').replace(/_/g, ' ');
/** A portrait: the top of the unit's info picture (the WBC3 info panel: portrait on top), or a building's base picture. */
function gmPortrait(p, { size = 72, building = false } = {}) {
  const box = h('div', { class: `gm-portrait${building ? ' gm-bld' : ''}`, style: { width: `${size}px`, height: `${size}px` } });
  if (!p) { box.append(h('span', { class: 'au-hint' }, '?')); return box; }
  const url = mediaUrl(p);
  const probe = new Image();
  probe.onload = () => { box.style.backgroundImage = `url("${url}")`; };
  probe.onerror = () => box.replaceChildren(h('span', { class: 'au-hint' }, 'not on this node yet'));
  probe.src = url;
  return box;
}
function lookOf(kind, id) { return (gmCache?.looks?.[kind] || []).find(x => x.id === id) || null; }
async function gmLookPicker(kind, initial = null) {
  const gm = await loadGm();
  const k = kind;
  let cur = initial?.[k] || '';
  const looks = gm.looks?.[k] || [];
  const race = h('select', { class: 'gen-race' }, h('option', { value: '' }, 'every race'), ...(gm.races || []).map(r => h('option', { value: r.id }, r.name)));
  const grid = h('div', { class: 'gen-gallery' });
  const label = h('div', { class: 'au-hint' });
  const draw = () => {
    label.textContent = cur ? `Looks like: ${lookOf(k, cur)?.name || cur}${lookOf(k, cur)?.wbc3 ? ` (${lookOf(k, cur).wbc3})` : ''}` : `Looks like: picked for you (${k === 'monster' ? 'a monster of the same race and tags' : `a${k === 'npc' ? 'n NPC' : ' building'} of the same race and role`})`;
    grid.replaceChildren(...looks.filter(x => !race.value || x.race === race.value).map(x => {
      const b = h('button', { class: `gen-thumb${x.id === cur ? ' on' : ''}`, type: 'button', title: `${x.name} — ${raceName(x.race)}, ${roleName(x.role)}` },
        h('div', { class: 'gen-thumb-box' }, gmPortrait(k === 'building' ? x.base : x.info, { size: 56, building: k === 'building' })), h('span', { class: 'gen-thumb-name' }, x.name));
      b.addEventListener('click', () => { cur = cur === x.id ? '' : x.id; draw(); });
      return b;
    }));
  };
  race.addEventListener('change', draw);
  draw();
  const el = h('div', { class: 'gen-voice' }, h('div', { class: 'gen-res' }, race, label), h('details', { class: 'gen-gallery-box', open: true }, h('summary', null, 'Pick a look'), grid));
  return { el, value: () => (cur ? { [k]: cur } : null), set: (p) => { cur = p?.[k] || ''; draw(); } };
}
function gmLookShow(kind, pick) {
  const k = kind;
  const x = pick?.[k] ? lookOf(k, pick[k]) : null;
  return [h('div', { class: 'gen-media-row' }, gmPortrait(x ? (k === 'building' ? x.base : x.info) : null, { size: 64, building: k === 'building' }),
    h('span', { class: 'au-hint' }, x ? `${x.name} — ${raceName(x.race)}` : (k === 'monster' ? 'picked for you (same race and tags)' : 'picked for you (same race and role)')))];
}
const LINE_LABEL = { greet: 'greets you', quest: 'asks for help', thanks: 'thanks you', lore: 'tells you', warn: 'warns you' };
const REWARD_TEXT = (r) => (r.kind === 'reputation' ? `+${r.value}% reputation` : r.kind === 'allies' ? `${r.count || 1} ${r.count > 1 ? 'allies' : 'ally'} join you (${(r.units || []).map(u => String(u).replace(/^npc_[a-z]+_(?:elves_)?/, '').replace(/_/g, ' ')).join(', ')})`
  : r.kind === 'effect' ? `the ${String(r.id).replace(/^effect_/, '').replace(/_/g, ' ')} card` : r.kind === 'skill' ? `the ${String(r.id).replace(/^skill_/, '').replace(/_/g, ' ')} skill` : r.kind === 'enter' ? 'the gate opens' : r.kind);
const fill = (s, n) => String(s).replace(/\{name\}/g, n.name).replace(/\{village\}/g, 'the village').replace(/\{need\}/g, '…').replace(/\{reward\}/g, '').replace(/\{lore\}/g, '(news of the Dimension)').replace(/\{village_dir\}|\{lore_dir\}/g, 'north').replace(/\{village_dist\}/g, 'a day');
/** The card of an NPC bundle (or a building one): reads like the game. */
function gmCard(d, { compact = false } = {}) {
  const b = d.def || {};
  if (b.monster) {
    const x = b.monster, dd = x.card?.data || {}, st = dd.stats || {};
    const fx = (e) => String(e || '').replace(/^effect_/, '').replace(/_/g, ' ');
    const sum = ['vitality', 'world', 'matter', 'will'].reduce((a, k) => a + (st[k] || 0), 0);
    const power = d.check?.power ?? null;
    return h('div', { class: 'gm-card' },
      h('div', { class: 'gm-head' }, gmPortrait(x.card?.resources?.sprites?.info?.path, { size: 96 }),
        h('div', { class: 'gm-id' }, h('div', { class: 'gm-name' }, x.name || x.id),
          h('div', { class: 'gm-pills' }, h('span', { class: 'gm-pill' }, x.race || '?'), ...(x.card?.tags || []).map(t => h('span', { class: 'gm-pill r' }, t)), customBadge(), d.base ? h('span', { class: 'gm-pill e' }, `changes ${d.base}`) : null),
          h('div', { class: 'gm-persona' }, x.temper || ''), h('div', { class: 'au-hint' }, `hunts as ${String(x.agenda?.uses || '?').replace(/^monster_/, '')}${x.card?.resources?.wbc3_name ? ` · looks like a ${x.card.resources.wbc3_name}` : ''}`))),
      h('div', { class: 'gm-sec' }, h('div', { class: 'gm-sec-k' }, 'Creature card'),
        h('div', { class: 'gm-stats' }, ...['vitality', 'world', 'matter', 'will'].map(k => h('div', { class: 'gm-stat' }, h('span', null, k), h('i', { style: { width: `${Math.min(100, (st[k] || 0) * 3.3)}%` } }), h('b', null, String(st[k] ?? '?'))))),
        h('div', { class: 'gm-facts' },
          h('span', null, h('b', null, 'Life '), `${dd.life ?? '?'} (Σ ${sum} / 10)`),
          h('span', null, h('b', null, 'Actions '), `${dd.actions_per_round ?? '?'} a round`),
          dd.innate_effect ? h('span', null, h('b', null, 'Innate '), fx(dd.innate_effect)) : null,
          dd.on_action_rider ? h('span', null, h('b', null, 'Rider '), `+${dd.on_action_rider.bonus_damage} damage on ${dd.on_action_rider.action}`) : null,
          power !== null ? h('span', null, h('b', null, 'Power '), `${power}${d.check?.base_power != null ? ` (was ${d.check.base_power}, ±15 % allowed)` : d.check?.range ? ` (monsters: ${d.check.range[0]}–${d.check.range[1]})` : ''}`) : null)),
      h('div', { class: 'gm-sec' }, h('div', { class: 'gm-sec-k' }, 'Its deck'), h('div', { class: 'gm-rewards' }, ...(dd.deck_effects || []).map(e => h('span', { class: 'gm-reward k-effect' }, fx(e))))));
  }
  if (b.building) {
    const x = b.building;
    return h('div', { class: 'gm-card' },
      h('div', { class: 'gm-head' }, gmPortrait(x.card?.resources?.sprites?.base, { size: 96, building: true }),
        h('div', { class: 'gm-id' }, h('div', { class: 'gm-name' }, x.name || x.id), h('div', { class: 'gm-pills' }, h('span', { class: 'gm-pill' }, raceName(x.race)), h('span', { class: 'gm-pill r' }, roleName(x.role)), customBadge()),
          h('div', { class: 'gm-persona' }, x.text || ''))),
      h('div', { class: 'gm-facts' },
        h('span', null, h('b', null, 'Stands until '), `a hero banks ${x.bank?.value ?? '?'} ${x.bank?.stat || ''} next to it`),
        x.produces ? h('span', null, h('b', null, 'Trains '), `${String(x.produces.npc).replace(/^npc_/, '').replace(/_/g, ' ')} every ${x.produces.every_turns} turns`) : null,
        b.place?.village ? h('span', null, h('b', null, 'In '), `${b.place.village}${b.place.at ? ` at (${b.place.at.join(',')})` : ''}`) : null));
  }
  const n = b.npc;
  if (!n) return h('div', { class: 'au-hint' }, 'No definition yet.');
  const bubbles = Object.entries(n.lines || {}).flatMap(([k, ls]) => (ls || []).slice(0, compact ? 1 : 6).map(l => h('div', { class: `gm-bubble k-${k}` }, h('span', { class: 'gm-bubble-k' }, LINE_LABEL[k] || k), fill(l, n))));
  const talk = (n.talk || []).map(t => h('details', { class: 'gm-ask' }, h('summary', null, `“${t.ask}”`), ...(t.say || []).map(s => h('div', { class: 'gm-bubble k-talk' }, fill(s, n)))));
  const quests = (b.quests || []).map(q => h('div', { class: `gm-quest${q.consume ? ' barter' : ''}` },
    h('div', { class: 'gm-quest-name' }, q.consume ? '⇄ ' : '❖ ', q.name, q.repeatable ? h('span', { class: 'au-hint' }, ' · repeatable') : null),
    h('div', null, h('b', null, q.consume ? 'Trade: ' : 'Bring: '), q.need_text || '?'),
    h('div', { class: 'gm-rewards' }, ...(q.rewards || []).map(r => h('span', { class: `gm-reward k-${r.kind}` }, REWARD_TEXT(r))))));
  const st = n.unit?.stats || {};
  const stats = h('div', { class: 'gm-stats' }, ...['vitality', 'world', 'matter', 'will'].map(k => h('div', { class: 'gm-stat' }, h('span', null, k), h('i', { style: { width: `${Math.min(100, (st[k] || 0) * 5)}%` } }), h('b', null, String(st[k] ?? '?')))),
    h('div', { class: 'au-hint' }, `life ${n.unit?.life ?? '?'} · ${n.unit?.actions_per_round ?? '?'} action(s) a round · casts ${(n.unit?.deck_effects || []).map(e => String(e).replace(/^effect_/, '').replace(/_/g, ' ')).join(', ') || '—'}`),
    // the village dragon / a siege engine (2026-11-25): Breath Attack, flying, the engine's class
    n.unit?.breath || (n.unit?.tags || []).includes('flying') ? h('div', { class: 'au-hint' }, [n.unit.breath ? `Breath Attack: each Attack hits every enemy within ${n.unit.breath.range}` : '', (n.unit.tags || []).includes('flying') ? 'flies over walls and scenery' : ''].filter(Boolean).join(' · ')) : null,
    n.siege ? h('div', { class: 'au-hint' }, `${n.siege.class}: ${n.siege.kind === 'ram' ? `next to a wall for ${n.siege.rounds} actions in a row breaks it` : `shoots ${n.siege.min}–${n.siege.max} hexes once a turn, the ammunition flies ${n.siege.speed} hexes an action${n.siege.kind === 'ballista' ? ' and hurts every foe on its line' : ''}`} · only Empty Posture / Empty Move`) : null);
  const where = b.place?.village ? `${b.place.post === 'wanderer' ? 'Wanders 50–100 hexes around' : b.place.post === 'outside' ? 'Waits outside the wall of' : 'Lives in'} ${b.place.village}${b.place.at ? ` (${b.place.at.join(',')})` : ''}` : 'Not placed in a village';
  return h('div', { class: 'gm-card' },
    h('div', { class: 'gm-head' }, gmPortrait(n.card?.resources?.sprites?.info?.path, { size: 96 }),
      h('div', { class: 'gm-id' }, h('div', { class: 'gm-name' }, n.name || n.id), h('div', { class: 'gm-pills' }, h('span', { class: 'gm-pill' }, raceName(n.race)), h('span', { class: 'gm-pill r' }, roleName(n.role)), n.unit?.breath ? h('span', { class: 'gm-pill e' }, `🔥 breath ${n.unit.breath.range}`) : null, (n.unit?.tags || []).includes('flying') ? h('span', { class: 'gm-pill' }, 'flying') : null, n.siege ? h('span', { class: 'gm-pill e' }, `⚙ ${n.siege.class}`) : null, customBadge(), d.base ? h('span', { class: 'gm-pill e' }, `changes ${d.base}`) : null),
        h('div', { class: 'gm-persona' }, n.persona || ''), h('div', { class: 'au-hint' }, where))),
    bubbles.length ? h('div', { class: 'gm-sec' }, h('div', { class: 'gm-sec-k' }, 'What it says'), h('div', { class: 'gm-bubbles' }, ...bubbles)) : null,
    talk.length ? h('div', { class: 'gm-sec' }, h('div', { class: 'gm-sec-k' }, `Ask ${n.name}`), ...talk) : null,
    quests.length ? h('div', { class: 'gm-sec' }, h('div', { class: 'gm-sec-k' }, 'Quests'), ...quests) : null,
    compact ? null : h('div', { class: 'gm-sec' }, h('div', { class: 'gm-sec-k' }, 'As a unit'), stats));
}
// "Start from" + the quick asks (user 2026-11-25: "more quest options dialogs or more story teller options")
const GM_ASKS = {
  npc: [
    ['＋ Quest dialog', 'Add two new questions a hero can ask (talk topics) about the quests: why it needs it, where to look, what happens after — each with 2–3 answers in its own voice.'],
    ['＋ Storyteller tales', 'Add three storyteller talk topics (a legend, a rumour of a nearby danger, a story about another village), each with 2–3 vivid answers, and two more lore lines.'],
    ['＋ A quest', 'Add one new quest it gives: a clear thing to bring (an effect or skill card), a fitting reward, and quest / thanks lines that mention it.'],
    ['＋ More lines', 'Add two more lines of each kind it already has, in the same voice, without repeating the old ones.'],
  ],
  building: [['＋ Better text', 'Rewrite its text to be vivid and in-world (1–2 sentences), keeping what it does.']],
  monster: [
    ['＋ Vivid temper', 'Rewrite its temper: 1–2 vivid sentences — what it looks like, how it hunts, what the villages say about it.'],
    ['＋ Fiercer', 'Make it hit harder in its own style (its stats, rider or deck), staying within the balance limits.'],
    ['＋ Trickier', 'Give it a cleverer deck: one control or defence effect that fits its temper, keeping its power.'],
  ],
};
const pickerFor = (kind, init) => (isGm(kind) ? gmLookPicker(kind, init) : kind === 'class' ? unitPicker(init) : mediaPicker(init));
const showFor = (kind, pick) => (isGm(kind) ? gmLookShow(kind, pick) : kind === 'class' ? unitShow(pick) : mediaShow(pick));
const mediaLabelOf = (kind) => (isGm(kind) ? 'Looks like' : kind === 'class' ? 'Voice (a unit)' : 'Picture & sound');

// ---------------------------------------------------------------- #/gen/ and #/gen/<kind>
async function routeList(rest) {
  if (!loggedIn()) return signInPane();
  // #/gen/<kind> or #/gen/<kind>/<id> (a GameModels entry's "Change with the big model": start from that one)
  const [want = '', wantBase = ''] = String(rest || '').replace(/^\/+|\/+$/g, '').split('/').map(x => { try { return decodeURIComponent(x); } catch { return x; } });
  let info = { drafts: [], kinds: ['effect'], model: {} };
  try { info = await genApi('drafts'); } catch (e) { C.toast(errText(e), 'error'); }
  const kinds = info.kinds || ['effect'];
  const kind = kinds.includes(want) ? want : 'effect';
  const KIND_LABEL = { npc: 'village NPC (quests, dialog, stories)', building: 'village building', monster: 'wild monster (creature card, deck, temper)' };
  const kindSel = h('select', { id: 'gen-kind' }, ...KINDS.map(k => h('option', { value: k, disabled: !kinds.includes(k), selected: k === kind }, kinds.includes(k) ? (KIND_LABEL[k] || k) : `${k} (coming)`)));
  const idea = h('textarea', { id: 'gen-idea', class: 'au-prose', rows: 4, maxlength: 1000 });
  const placeholder = { effect: 'e.g. "Frost Nova: every adjacent enemy takes water damage and loses one action."',
    skill: 'e.g. "Quick Step: riding on a Move, the first blow that hits me this action does one less damage."',
    class: 'e.g. "Field Medic: tap to restore one life token to me or an adjacent ally; colours vitality, water, harmony."',
    npc: 'e.g. "An old High Elf ferryman who waits outside the wall, tells sad legends of the drowned city and asks for a Water Shield to cross the river."',
    building: 'e.g. "An Empire windmill: tough to break (matter), it trains a peasant every 25 turns."',
    monster: 'e.g. "A salt-crusted tusker of the Orc hills that charges anything smelling of iron; tough, slow, three blows a round."' };
  // Tags (user 2026-11-23): the well-known tags of the built-ins, a hard requirement — the draft is checked against them.
  const tags = tagEditor(kind);
  idea.placeholder = placeholder[kind] || '';
  // Resources (user 2026-11-23): any picture / sound of chaosD6-Resources, also the ones the phone has not downloaded;
  // a class: the whole voice of one unit; an NPC / building: the look of an existing one
  let res = await pickerFor(kind);
  const resRow = h('div', { class: 'au-row' }, h('label', null, mediaLabelOf(kind)), res.el);
  // GameModels: start from an existing NPC / building ("add more quest dialog / storyteller options") or a new one
  const gm = await loadGm();
  const base = h('select', { id: 'gen-base' });
  const asks = h('div', { class: 'gen-chips' });
  const baseRow = h('div', { class: 'au-row' }, h('label', { for: 'gen-base' }, 'Start from'), h('div', null, base, h('div', { class: 'au-hint' }, 'A new one, or change an existing one — then say what to add. Quick asks:'), asks));
  const gmNote = h('div', { class: 'au-hint' });
  const drawGm = (k) => {
    baseRow.hidden = !isGm(k);
    gmNote.textContent = isGm(k) && !gm.available ? 'No chaosD6-GameModels checkout on this node: NPCs, buildings and monsters are generated on a desktop for now.' : '';
    if (!isGm(k)) return;
    const list = (gm.edit || []).filter(x => x.kind === k);
    const byRace = [...new Set(list.map(x => x.race))];
    base.replaceChildren(h('option', { value: '' }, `— a new ${k} —`),
      ...byRace.map(r => h('optgroup', { label: raceName(r) }, ...list.filter(x => x.race === r).map(x => h('option', { value: x.id }, `${x.name} (${roleName(x.role)})`)))));
    asks.replaceChildren(...(GM_ASKS[k] || []).map(([label, text]) => h('button', { class: 'gen-chip', type: 'button', title: text, onclick: () => { idea.value = idea.value.trim() ? `${idea.value.trim()}\n${text}` : text; idea.focus(); } }, label)));
  };
  drawGm(kind);
  if (wantBase && isGm(kind)) {
    if ([...base.options].some(o => o.value === wantBase)) base.value = wantBase;
    else C.toast(`${wantBase} cannot be changed here (hand-made: builders, dragons, engineers, siege engines)`, 'error');
  }
  kindSel.addEventListener('change', async () => {
    const k = kindSel.value;
    idea.placeholder = placeholder[k] || ''; tags.setKind(k);
    res = await pickerFor(k);
    resRow.replaceChildren(h('label', null, mediaLabelOf(k)), res.el);
    drawGm(k);
  });
  const go = h('button', { class: 'au-btn au-primary', type: 'button' }, 'Create preview');
  go.addEventListener('click', () => act(go, async () => {
    const k = kindSel.value;
    const r = await genApi('create', { method: 'POST', body: { kind: k, idea: idea.value, tags: tags.value(), resources: res.value(), ...(isGm(k) && base.value ? { base: base.value } : {}) } });
    C.toast('Generating — this takes a few minutes on the big model', 'ok');
    C.navigate(`#/gen/d/${r.draft.draft_id}`);
  }));
  const busy = info.busy ? h('div', { class: 'au-hint' }, `Busy: ${info.busy.what === 'test' ? 'a test game' : 'a generation'} is running (one at a time). `,
    h('a', { href: `#/gen/d/${info.busy.draft_id}` }, 'Open it')) : null;
  const keyBtn = h('button', { class: 'au-btn', type: 'button', onclick: () => openKeySheet(info) }, info.model?.key_set ? 'Change model key…' : 'Model key…');
  const where = info.test?.where === 'oci' ? `test games run on ${info.test.host || 'OCI'}` : 'test games run on this node';
  const model = info.model?.configured
    ? h('div', { class: 'au-bar' }, h('span', { class: 'au-hint' }, `Model: ${info.model.name} at ${info.model.host}${info.model.fallback ? `, else OCI ${info.model.fallback}` : ""}${info.model.key_set ? '' : info.model.device ? ' (signed by this device)' : ' (no key)'} · ${where}`), info.model.mobile || (!info.model.key_set && !info.model.device) ? keyBtn : null)
    : h('div', { class: 'au-bar' }, h('span', { class: 'au-hint' }, info.model?.mobile ? 'Enter the OCI model key to generate from this phone.' : 'No big model on this node: run "node tools/effect-gen.mjs --save-key" (OCI) or install the desktop 8B — or enter the OCI key here.'), keyBtn);
  const list = h('div', { class: 'gen-list' });
  for (const d of info.drafts || []) {
    list.appendChild(h('div', { class: 'gen-item', role: 'link', tabindex: '0', onclick: () => C.navigate(`#/gen/d/${d.draft_id}`) },
      h('b', null, d.name || '(no name yet)'), customBadge(), statePill(d.state), h('span', { class: 'gen-idea' }, d.idea)));
  }
  // The header's "Drafts" lands here: the drafts first, then the form for a new one (#/gen/<kind> puts the form first).
  const drafts = [
    h('div', { class: 'au-sec' }, 'Your drafts'),
    h('div', { class: 'au-hint' }, "Other teams' NPCs, buildings and monsters: ", h('a', { href: '#/gen/proposals' }, 'Team proposals — try them and vote')),
    (info.drafts || []).length ? list : h('div', { class: 'au-hint' }, 'No drafts yet — describe one below.'),
  ];
  const form = [
    h('div', { class: 'au-sec' }, 'New from a description'),
    h('p', { class: 'au-hint' }, 'Describe a new card in words. The model writes it, the validator prices it, a private test game plays it, and you publish it on your team\'s branch, marked custom.'),
    model, busy,
    h('div', { class: 'au-row' }, h('label', { for: 'gen-kind' }, 'Kind'), kindSel), gmNote,
    baseRow,
    h('div', { class: 'au-row' }, h('label', { for: 'gen-idea' }, 'Description'), idea),
    h('div', { class: 'au-row' }, h('label', null, 'Tags'), h('div', null, h('div', { class: 'au-hint' }, 'Pick the tags it must have — the draft is checked against every one. An element can be added more than once (water, fire, water = two water in the cost).'), tags.el)),
    resRow,
    h('div', { class: 'au-bar' }, go),
  ];
  return pane(want ? 'Generate from a description' : 'Drafts', want ? [form, drafts] : [drafts, form]);
}

// The OCI model URL + key (the phone has no local model); stored by the node in <profile dir>/llm.json, never shown again.
function openKeySheet(info) {
  const url = h('input', { type: 'url', id: 'gen-key-url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: `https://${info.model?.fallback || (info.model?.host && !/^127\.|^localhost/.test(info.model.host) ? info.model.host : '92-5-138-121.sslip.io')}/llm-big` });
  const key = h('input', { type: 'password', id: 'gen-key', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'the OCI LLM key' });
  const save = h('button', { class: 'au-btn au-primary', type: 'button' }, 'Save');
  let sh = null;
  save.addEventListener('click', () => act(save, async () => {
    await genApi('key', { method: 'POST', body: { url: url.value.trim(), key: key.value.trim() } });
    key.value = '';
    C.toast('Model key saved on this node', 'ok');
    sh?.close(); C.navigate('#/gen/');
  }));
  sh = C.openSheet('Model key', h('div', { class: 'au-form' },
    h('p', { class: 'au-hint' }, 'The big model on OCI (Qwen3-8B) writes the drafts; its test service plays them. The key stays on this node (llm.json, readable only by the game) and is never shown again.'),
    h('div', { class: 'au-row' }, h('label', { for: 'gen-key-url' }, 'Model URL'), url),
    h('div', { class: 'au-row' }, h('label', { for: 'gen-key' }, 'Key'), key),
    h('div', { class: 'au-bar' }, save)));
  setTimeout(() => key.focus(), 50);
}

// ---------------------------------------------------------------- #/gen/d/<draft_id>
function previewSheet(d) {
  if (isGm(d.kind)) {
    let json;
    try { json = C.jsonfmt ? C.jsonfmt.renderJson(d.def || {}, { width: 96 }) : null; } catch { json = null; }
    C.openSheet(`Preview — ${d.def?.name || d.def?.id || ''}`, h('div', { class: 'au-form' },
      h('p', { class: 'au-hint' }, 'Read-only: what the test game and the publish use. To change it, use Retry and say what to change.'),
      gmCard(d), (d.problems || []).length ? h('ul', null, ...d.problems.map(p => h('li', null, p))) : null,
      h('details', null, h('summary', null, 'Definitions JSON (the NPC / building, its quests, the village and race it changes)'), json ? h('div', { class: 'code' }, json) : h('pre', { class: 'gen-log' }, JSON.stringify(d.def, null, 2)))), { wide: true });
    return;
  }
  const def = d.def || {};
  const f = def.flags || {};
  let json;
  try { json = C.jsonfmt ? C.jsonfmt.renderJson(def, { width: 96 }) : null; } catch { json = null; }
  const facts = d.kind === 'class'
    ? `${def.data?.ability_kind || '?'} · colours ${(def.data?.colors || []).map(e => String(e).replace(/^elem_/, '')).join(', ') || '?'} · power ${Object.entries(def.power || {}).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ') || '—'} · hooks ${Object.keys(def.hooks || {}).join(', ') || '—'}${f.needs ? ` · targets ${f.needs}` : ''}`
    : d.kind === 'skill'
    ? `rides on ${def.action_type || '?'} · ${def.is_permanent ? `permanent (${String(def.point_buy_stat || '?').replace(/^stat_/, '')}${def.fixed_power ? `, power ${def.fixed_power}` : ''})` : 'instant'} · hooks ${(f.hooks || []).join(', ') || '—'}`
    : `${(def.elements || []).map(e => String(e).replace(/^elem_/, '')).join(' + ')} · ${def.kind || '?'} · ${def.duration || '?'} · scope ${f.scope || '?'}${f.lock ? ` · lock ${f.lock}` : ''}${f.range ? ` · range ${f.range}` : ''}`;
  const media = def.card?.resources || def.resources;
  const card = h('div', { class: 'gen-card' },
    h('div', { class: 'au-bar' }, h('b', null, def.name || def.id), customBadge(), statePill('preview'), d.verdict ? h('span', { class: 'au-hint' }, `validator: ${d.verdict}${d.check?.ratio != null ? ` (ratio ${d.check.ratio})` : ''}`) : null),
    h('div', { class: 'gen-elems' }, facts),
    d.kind === 'class' ? (def.resources?.unit ? h('div', null, ...unitShow({ unit: { ...def.resources.unit, sounds: def.resources.sounds?.voice || [] } })) : null)
      : media ? h('div', null, ...mediaShow({ sprite: media.sprites?.effect?.path || null, sound: media.sounds?.fx?.[0]?.path || null })) : null,
    (d.tags || []).length ? h('div', { class: 'gen-picked' }, ...tagStatus(d)) : null,
    h('div', null, def.text || ''),
    (d.problems || []).length ? h('ul', null, ...d.problems.map(p => h('li', null, p))) : null);
  C.openSheet(`Preview — ${def.name || def.id}`, h('div', { class: 'au-form' },
    h('p', { class: 'au-hint' }, 'Read-only: this is what the test game and the publish use. To change it, use Retry with a description of the change.'),
    card, h('div', { class: 'au-sec' }, 'Definition JSON'),
    json ? h('div', { class: 'code' }, json) : h('pre', { class: 'gen-log' }, JSON.stringify(def, null, 2))), { wide: true });
}

async function routeDraft(rest) {
  if (!loggedIn()) return signInPane();
  const id = String(rest || '').replace(/^\/+|\/+$/g, '');
  let d;
  try { d = (await genApi(`drafts/${encodeURIComponent(id)}`)).draft; } catch (e) { C.toast(errText(e), 'error'); return pane('Draft', [h('p', null, 'No such draft.')]); }
  const title = h('b'), stateEl = h('span'), status = h('div', { class: 'gen-status', 'aria-live': 'polite' });
  const idea = h('div', { class: 'au-hint' });
  const testBox = h('div', { class: 'au-box' });
  const retryBox = h('div', { class: 'au-form', hidden: true });
  const logBox = h('pre', { class: 'gen-log' });
  const tagsEl = h('div', { class: 'gen-picked' });
  const tagWhy = h('div', { class: 'gen-tag-why' });
  // the picture + sound: shown with the animated preview and ▶; "Change…" saves another pick (POST media — not priced,
  // the verdict and the test stand)
  await loadResources();
  if (isGm(d.kind)) await loadGm();
  const gmBox = h('div', { hidden: !isGm(d.kind) });   // the NPC / building card, inline (the "pretty" view of the draft)
  const mediaEl = h('div', { class: 'gen-media-show' });
  const bMedia = h('button', { class: 'au-btn', type: 'button' }, 'Change…');
  const mediaEdit = h('div', { class: 'gen-media-edit', hidden: true });
  const mediaNow = await pickerFor(d.kind, d.resources);
  const mediaLabel = mediaLabelOf(d.kind);
  const bMediaSave = h('button', { class: 'au-btn au-primary', type: 'button' }, isGm(d.kind) ? 'Save the look' : d.kind === 'class' ? 'Save the voice' : 'Save picture & sound');
  mediaEdit.append(mediaNow.el, h('div', { class: 'au-bar' }, bMediaSave));
  // the retry box: the tags (editable, prefilled) and the media as well
  const retryTags = tagEditor(d.kind || 'effect', d.tags || []);
  const retryMedia = await pickerFor(d.kind, d.resources);
  const reportBox = h('pre', { class: 'gen-log' });
  const talkBox = h('div', { class: 'gen-talk' });
  const bShow = h('button', { class: 'au-btn', type: 'button' }, 'Show preview');
  const bTest = h('button', { class: 'au-btn', type: 'button' }, 'Test preview');
  const bRetry = h('button', { class: 'au-btn', type: 'button' }, 'Retry…');
  const bPub = h('button', { class: 'au-btn au-primary', type: 'button' }, 'Publish the preview');
  const bDel = h('button', { class: 'au-btn', type: 'button' }, 'Delete');
  const pubHint = h('div', { class: 'au-hint', hidden: true });
  const extra = h('textarea', { class: 'au-prose', rows: 3, maxlength: 1000, placeholder: 'What should change? (added to the description)' });
  const sugg = h('div', { class: 'gen-sugg' });
  const picked = new Set();
  const bRetryGo = h('button', { class: 'au-btn au-primary', type: 'button' }, 'Retry with these changes');
  retryBox.append(h('div', { class: 'au-sec' }, 'Retry'), extra, sugg,
    h('details', { class: 'gen-retry-more', open: true }, h('summary', null, 'Tags it must have'), retryTags.el),
    h('details', { class: 'gen-retry-more' }, h('summary', null, mediaLabel), retryMedia.el),
    h('div', { class: 'au-bar' }, bRetryGo));

  const render = () => {
    title.replaceChildren(d.def?.name || '(no definition yet)');
    if (isGm(d.kind)) gmBox.replaceChildren(d.def ? gmCard(d) : h('div', { class: 'au-hint' }, RUNNING.includes(d.state) ? 'The model is writing it…' : 'No definition yet.'));
    stateEl.replaceChildren(statePill(d.state));
    idea.replaceChildren(`"${d.idea}"${(d.extras || []).length ? ` + ${d.extras.length} change(s)` : ''}`);
    status.textContent = RUNNING.includes(d.state) ? (d.status || '…') : '';
    const failed = /^testing failed \d+$/.test(d.state);
    bShow.disabled = !d.def;
    const missed = d.tag_problems || [];
    bTest.disabled = !d.def || d.verdict !== 'ok' || missed.length > 0 || !(d.state === 'preview' || failed || d.state === 'testing success');
    bTest.title = d.def && d.verdict !== 'ok' ? `The validator rates it "${d.verdict}" — retry first` : missed.length ? `It misses tags you picked — retry first: ${missed.join('; ')}` : '';
    // the picked tags: ✓ met / ✗ missed (a hard requirement)
    tagsEl.replaceChildren(...((d.tags || []).length ? tagStatus(d) : [h('span', { class: 'au-hint' }, 'none picked — Retry… to add some')]));
    tagWhy.replaceChildren(...(d.def ? missed : []).map(p => h('div', null, `✗ ${p.replace(/^tag [^:\s]+:(\S+) /, '$1 ').replace(/elem_/g, '')}`)));
    mediaEl.replaceChildren(...showFor(d.kind, d.resources));
    bMedia.disabled = RUNNING.includes(d.state) || d.state === 'published';
    if (bMedia.disabled) mediaEdit.hidden = true;
    reportBox.textContent = (d.report || []).join('\n') || 'No validator report yet.';
    talkBox.replaceChildren(...(d.talk || []).map(t => t.role === 'round'
      ? h('div', { class: 'gen-talk-round' }, t.text)
      : h('div', { class: `gen-talk-msg r-${t.role}` }, h('span', { class: 'gen-talk-who' }, { player: 'You', model: `Model${t.attempt ? ` · attempt ${t.attempt}` : ''}`, validator: `Validator${t.verdict ? ` · ${t.verdict}` : ''}`, test: 'Test game' }[t.role] || t.role), h('pre', null, t.text))));
    bRetry.disabled = RUNNING.includes(d.state) || d.state === 'published';
    bPub.disabled = d.state !== 'testing success';
    bPub.hidden = d.state === 'published';
    const pub = C.session?.publish || {};
    pubHint.hidden = !(d.state === 'testing success' && pub.ready === false);
    pubHint.textContent = `Publishing is not ready on this node${pub.why ? `: ${pub.why}` : ''} — the commit stays pending until it is (retry it under "My team's definitions").`;
    bPub.title = d.state === 'testing success' ? '' : 'Only after "testing success"';
    bDel.disabled = RUNNING.includes(d.state);
    const t = d.test;
    testBox.hidden = !t;
    if (t) {
      testBox.replaceChildren(...[
        h('div', { class: 'au-bar' }, h('b', null, t.pass ? 'Test passed' : 'Test failed'), h('span', { class: 'au-hint' }, `${d.kind === 'npc' ? `${t.spawned ? 'spawned' : 'never spawned'} · answered ${t.talks ?? 0} question(s) · ${t.agenda ?? 0} agenda step(s) · ${t.quests ?? 0} quest(s) handed in`
          : d.kind === 'building' ? `village ${t.village ? 'came up' : 'never came up'} · ${t.in_layout ? 'in its layout' : 'not in its layout'}`
          : d.kind === 'monster' ? `${t.booted ? 'in the game' : 'never in the game'} · chases ${t.chases ?? 0} · casts ${t.casts ?? 0} · hits ${t.hits ?? 0} · kills ${t.kills ?? 0}${t.monster_died ? ' · died' : ''}`
          : `${{ skill: 'played', class: 'used' }[d.kind] || 'cast'} ${t.casts ?? '?'}× · ${{ skill: 'paid off', class: 'did something' }[d.kind] || 'landed'} ${t.lands ?? '?'}×`} · engine errors ${t.errors ?? '?'} · divergences ${t.divergences ?? '?'}`)),
        (t.notes || []).length ? h('div', { class: 'au-hint' }, t.notes.join(' · ')) : null,
        d.kind === 'npc' && (t.talk || []).length ? h('details', null, h('summary', null, `The conversation in the test (${t.talk.length})`), ...t.talk.map(c => h('div', { class: 'gm-bubble k-talk' }, h('b', null, `“${c.ask}” `), c.answer))) : null,
        (t.why || []).length ? h('ul', null, ...t.why.map(w => h('li', null, w))) : null,
        t.review?.summary ? h('div', null, h('b', null, 'Review: '), t.review.summary) : t.review?.error ? h('div', { class: 'au-hint' }, `Review: ${t.review.error}`) : null,
        (t.lines || []).length ? h('details', null, h('summary', null, `Game log lines (${t.lines.length})`), h('pre', { class: 'gen-log' }, t.lines.join('\n'))) : null].filter(Boolean));   // replaceChildren would print "null"
    }
    sugg.replaceChildren(...(d.suggestions || []).map(s => {
      const b = h('button', { class: `au-btn${picked.has(s) ? ' on' : ''}`, type: 'button', title: 'Add this suggestion to the retry' }, `${picked.has(s) ? '✓ ' : '+ '}${s}`);
      b.addEventListener('click', () => { if (picked.has(s)) picked.delete(s); else picked.add(s); render(); });
      return b;
    }));
    if ((d.suggestions || []).length) sugg.prepend(h('div', { class: 'au-hint' }, 'Suggestions from the test review — click to include:'));
    if (d.published) testBox.append(h('div', { class: 'au-bar' }, h('b', null, 'Published'), h('span', { class: 'au-mono' }, `${d.published.branch || ''} @${String(d.published.commit || '').slice(0, 8)}`),
      h('span', { class: 'au-hint' }, isGm(d.kind) ? 'on your team\'s branch of chaosD6-GameModels — it enters the game when the vote merges it' : d.kind === 'class' ? 'a class: no archive card (its ref is kept on this draft)' : `${d.published.granted ?? 0} team character(s) got the card (archive, new)`)));
    logBox.textContent = (d.log || []).join('\n');
  };
  const reload = async () => { try { d = (await genApi(`drafts/${encodeURIComponent(id)}`)).draft; render(); } catch (e) { if (e.status === 404) stop(); } };
  let timer = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const startPoll = () => {
    stop();
    timer = setInterval(() => { if (!root.isConnected) { stop(); return; } if (RUNNING.includes(d.state)) reload(); }, POLL_MS);
  };
  const post = async (route, body, ok) => { const r = await genApi(route, { method: 'POST', body: { draft_id: id, ...body } }); if (r?.draft) d = r.draft; render(); if (ok) C.toast(ok, 'ok'); setTimeout(reload, 2000); return r; };   // the first status line, then every 10 s

  bShow.addEventListener('click', () => previewSheet(d));
  bTest.addEventListener('click', () => act(bTest, () => post('test', {}, 'Test game started (private, ~4 min)')));
  bRetry.addEventListener('click', () => {
    retryBox.hidden = !retryBox.hidden;
    if (!retryBox.hidden) { retryTags.set(d.tags || []); retryMedia.set(d.resources); extra.focus(); }
  });
  bMedia.addEventListener('click', () => { mediaEdit.hidden = !mediaEdit.hidden; if (!mediaEdit.hidden) mediaNow.set(d.resources); });
  bMediaSave.addEventListener('click', () => act(bMediaSave, async () => {
    await post('media', { resources: mediaNow.value() }, d.kind === 'class' ? 'Voice saved' : 'Picture & sound saved');
    mediaEdit.hidden = true;
  }));
  bRetryGo.addEventListener('click', () => act(bRetryGo, async () => {
    await post('retry', { extra: extra.value, suggestions: [...picked], tags: retryTags.value(), resources: retryMedia.value() }, 'Generating again with your changes');
    extra.value = ''; picked.clear(); retryBox.hidden = true; render();
  }));
  bPub.addEventListener('click', () => act(bPub, async () => {
    const team = C.session?.team?.name || 'your team';
    const gmFiles = isGm(d.kind) ? [d.def?.npc || d.def?.building || d.def?.monster, ...(d.def?.quests || []), d.def?.touches?.village, d.def?.touches?.race].filter(Boolean).map(x => x.id).join(', ') : '';
    if (!(await C.confirm('Publish the preview?', isGm(d.kind)
      ? `"${d.def?.name}" goes on ${team}'s branch of chaosD6-GameModels (one commit: ${gmFiles}), open to the players' votes. It enters the game when the vote merges it into main.`
      : `"${d.def?.name}" goes on ${team}'s branch of chaosD6-${{ skill: 'Skills', class: 'Classes' }[d.kind] || 'Effects'}, marked custom, open to the players' votes${d.kind === 'class' ? ' (a class is not a card: no archive card is given)' : `, and every ${team} character gets the card in its archive`}.`))) return;
    const r = await post('publish', {});
    if (r) C.toast(`Published on ${r.ref?.branch || 'the team branch'} — ${r.publish?.state || '?'}${d.kind === 'class' || isGm(d.kind) ? '' : `; ${r.granted?.length || 0} character(s) got the card`}`, r.publish?.state === 'published' ? 'ok' : 'info');
  }));
  bDel.addEventListener('click', () => act(bDel, async () => {
    if (!(await C.confirm('Delete this draft?', 'The draft and its test result are removed from this node.'))) return;
    await genApi('delete', { method: 'POST', body: { draft_id: id } });
    stop(); C.navigate('#/gen/');
  }));

  const root = pane('Generated draft', [
    h('div', { class: 'au-bar' }, title, customBadge(), h('span', { class: 'au-hint' }, d.kind || 'effect'), stateEl), idea,
    h('div', { class: 'gen-draft-facts' },
      h('div', { class: 'gen-fact' }, h('span', { class: 'gen-fact-k' }, 'Tags'), tagsEl, tagWhy),
      h('div', { class: 'gen-fact' }, h('span', { class: 'gen-fact-k' }, mediaLabel), h('div', { class: 'gen-media-line' }, mediaEl, bMedia), mediaEdit)),
    gmBox,
    status,
    h('div', { class: 'au-bar gen-bar' }, bShow, bTest, bRetry, bPub, h('span', { class: 'au-grow' }), bDel), pubHint,
    retryBox, testBox,
    h('details', { open: true }, h('summary', null, 'Validator report (the rebalance script)'), reportBox),
    h('details', null, h('summary', null, 'Conversation (your description, retries, the model, the validator, the tests)'), talkBox),
    h('details', null, h('summary', null, 'Job log'), logBox),
    h('div', { class: 'au-bar' }, h('button', { class: 'au-btn', type: 'button', onclick: () => C.navigate('#/gen/') }, 'All drafts')),
  ]);
  render();
  startPoll();
  return root;
}

// ---------------------------------------------------------------- #/gen/proposals — other teams' GameModels proposals
// (user 2026-11-25: "Team first, then vote" — here AND in Test Random games). Listed from this node's Radicle storage
// (GET proposals; "Fetch from the seed" = the OCI seed only), each as its card; "Try it" = the private test game on a
// draft copy; the vote is −6..+6, a comment on a minus vote, never on your own team's.
async function routeProposals() {
  if (!loggedIn()) return signInPane();
  let L = { available: false, proposals: [], limits: { min: -6, max: 6, comment_max: 500 } };
  const body = h('div');
  const load = async () => {
    try { L = await genApi('proposals'); } catch (e) { C.toast(errText(e), 'error'); }
    await loadGm();
    draw();
  };
  const refresh = h('button', { class: 'au-btn', type: 'button' }, 'Fetch from the seed');
  refresh.addEventListener('click', () => act(refresh, async () => {
    const r = await genApi('proposals/refresh', { method: 'POST', body: {} });
    C.toast(r.ok ? 'Fetched from the OCI seed' : r.error, r.ok ? 'ok' : 'error');
    await load();
  }));
  const voteBox = (p) => {
    const lim = L.limits || { min: -6, max: 6, comment_max: 500 };
    const val = h('input', { type: 'range', min: lim.min, max: lim.max, step: 1, value: p.mine?.value ?? 0 });
    const shown = h('b', { class: 'gm-vote-v' }, String(p.mine?.value ?? 0));
    const comment = h('textarea', { class: 'au-prose', rows: 2, maxlength: lim.comment_max, placeholder: 'A comment (needed for a minus vote: say what is wrong with it)' }, p.mine?.comment || '');
    val.addEventListener('input', () => { shown.textContent = `${Number(val.value) > 0 ? '+' : ''}${val.value}`; });
    const send = h('button', { class: 'au-btn au-primary', type: 'button' }, p.mine ? 'Change my vote' : 'Vote');
    send.addEventListener('click', () => act(send, async () => {
      if (Number(val.value) < 0 && !comment.value.trim()) { C.toast('A minus vote needs a comment', 'error'); comment.focus(); return; }
      const r = await genApi('proposals/vote', { method: 'POST', body: { branch: p.branch, commit: p.commit, value: Number(val.value), comment: comment.value } });
      C.toast(`Vote saved${r.publish === 'desktop' || r.publish === 'phone' ? ' — publishing to the seed' : ''}`, 'ok');
      await load();
    }));
    return h('div', { class: 'gm-vote' }, h('div', { class: 'au-bar' }, h('span', null, `${lim.min}`), val, h('span', null, `+${lim.max}`), shown), comment, h('div', { class: 'au-bar' }, send));
  };
  const draw = () => {
    if (!L.available) { body.replaceChildren(h('div', { class: 'au-hint' }, L.why || 'No GameModels storage on this node.')); return; }
    if (!L.proposals.length) { body.replaceChildren(h('div', { class: 'au-hint' }, 'No proposals in this node\'s storage yet — fetch from the seed.')); return; }
    body.replaceChildren(...L.proposals.map(p => {
      const tryBtn = h('button', { class: 'au-btn', type: 'button', title: 'A private test game with it (the same test as your own drafts)' }, 'Try it');
      tryBtn.addEventListener('click', () => act(tryBtn, async () => {
        const r = await genApi('proposals/try', { method: 'POST', body: { branch: p.branch, commit: p.commit } });
        C.navigate(`#/gen/d/${r.draft.draft_id}`);
      }));
      const v = p.votes || {};
      return h('div', { class: 'gm-proposal' },
        h('div', { class: 'au-bar' }, h('b', null, p.name || p.id), h('span', { class: 'gm-pill' }, p.kind), h('span', { class: 'gm-pill r' }, `team ${p.team}`),
          p.signature_ok ? h('span', { class: 'gm-pill' }, '✓ signed') : h('span', { class: 'gm-pill e', title: 'the signature does not verify' }, '⚠ unsigned'),
          h('span', { class: 'au-hint' }, `${v.n | 0} vote(s)${v.n ? `, mean ${Number(v.mean).toFixed(1)}` : ''}${v.review ? ' · ⚑ review' : ''} · ${String(p.at || '').slice(0, 10)}`)),
        h('div', { class: 'au-hint au-mono' }, `${p.branch} @${String(p.commit).slice(0, 8)} · ${p.files.join(', ')}`),
        gmCard({ def: p.bundle, kind: p.kind }, { compact: true }),
        h('div', { class: 'au-bar' }, tryBtn),
        p.own ? h('div', { class: 'au-hint' }, 'Your team\'s own proposal — authors do not vote on it.') : voteBox(p));
    }));
  };
  await load();
  return pane('Team proposals', [
    h('p', { class: 'au-hint' }, 'NPCs, buildings and monsters other teams published on their branches of chaosD6-GameModels. Try one in a private test game, then vote: −6 … +6 (a minus vote needs a comment). Votes are signed and sent to the OCI seed.'),
    h('div', { class: 'au-bar' }, refresh, h('button', { class: 'au-btn', type: 'button', onclick: () => C.navigate('#/gen/') }, 'Your drafts')),
    body,
  ]);
}

// ---------------------------------------------------------------- registration
export function initGeneration(ctx) {
  C = ctx;
  if (typeof document !== 'undefined' && !document.getElementById('gen-css')) {
    const st = document.createElement('style');
    st.id = 'gen-css';
    st.textContent = GEN_CSS;
    document.head.appendChild(st);
  }
  C.registerRoute('#/gen/d/', routeDraft);
  C.registerRoute('#/gen/proposals', routeProposals);
  C.registerRoute('#/gen/', routeList);
  C.registerRoute('#/gen', routeList);
  // Entry points: header "Drafts" (before author.js's "New skill / effect / class", user 2026-11-23) and author.js's
  // "Generate from a description…" button on the New page (8a). Signed-in only, like the other edit actions.
  C.registerHeaderAction({ id: 'gen-drafts', label: 'Drafts', icon: '✦', before: 'au-new', onClick: () => C.navigate('#/gen/') });
  // A GameModels entry (the GameModels collections of app.js): change it with the big model → the draft form, started
  // from that entry (#/gen/<kind>/<id>)
  C.registerEntryAction({ id: 'gen-gm-change', label: '✦ Change with the big model',
    when: (c, entry) => loggedIn() && !!entry?.id && isGm(C.index?.collections?.find(x => x.id === c)?.kind),
    onClick: (c, entry) => C.navigate(`#/gen/${C.index.collections.find(x => x.id === c).kind}/${encodeURIComponent(entry.id)}`) });
}
