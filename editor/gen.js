// editor/gen.js — "Generate from a description…" (b9, 2026-11-23): describe a new effect or skill (+ the tags it must
// have, a picture / sound from chaosD6-Resources) → the node's big model writes it → preview → a private background test
// game → retry with changes → publish on the team's branch (custom). The draft page shows the rebalance validator's
// report and the whole conversation (description, retries, the model's answers, the validator, the test reviews).
// app.js imports this next to author.js and calls initGeneration(ctx); same plug-in style (registerHeaderAction,
// registerRoute, openSheet, toast, navigate, jsonfmt). Server: /rules/api/gen/* (game/gen-api.mjs) — POST needs
// the session token and a signed-in team owner; GET drafts/<id> is the status poll (every 10 s while a job runs).
// Routes: #/gen/ (drafts + the description form), #/gen/<kind> (the form for that kind), #/gen/d/<draft_id> (one draft).
// Nothing here touches `document` at import time.

const KINDS = ['effect', 'skill', 'class'];
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
.gen-chip{font:inherit;font-size:.82em;padding:1px 8px;border-radius:999px;border:1px solid var(--border,rgba(127,127,127,.45));background:transparent;color:inherit;cursor:pointer}
.gen-chip.on{background:rgba(61,123,224,.25);border-color:var(--accent,#3d7be0)}
.gen-chip.bad{background:rgba(217,83,79,.22);border-color:#d9534f}
span.gen-chip{cursor:default}
.gen-res{display:flex;flex-wrap:wrap;gap:6px}.gen-res input{flex:1 1 220px;min-width:0}.gen-res .au-hint{flex-basis:100%}
.gen-res input.gen-bad{outline:2px solid #d9534f}
.gen-talk{display:flex;flex-direction:column;gap:6px}
.gen-talk-round{font-weight:700;font-size:.85em;opacity:.7;text-transform:uppercase;letter-spacing:.04em;margin-top:6px}
.gen-talk-msg{border-left:3px solid rgba(127,127,127,.4);padding:2px 8px}
.gen-talk-msg pre{margin:2px 0 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
.gen-talk-msg.r-player{border-color:#3d7be0}.gen-talk-msg.r-model{border-color:#b36bff}.gen-talk-msg.r-validator{border-color:#e0a03d}.gen-talk-msg.r-test{border-color:#2ea043}
.gen-talk-who{font-size:.8em;font-weight:700;opacity:.8}
@media (max-width:640px){.gen-item .gen-idea{flex-basis:100%;white-space:normal}.au-bar .au-btn{flex:1 1 auto}.gen-tag-label{min-width:0;flex-basis:100%}}
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

// ---------------------------------------------------------------- #/gen/ and #/gen/<kind>
async function routeList(rest) {
  if (!loggedIn()) return signInPane();
  const want = String(rest || '').replace(/^\/+|\/+$/g, '');
  let info = { drafts: [], kinds: ['effect'], model: {} };
  try { info = await genApi('drafts'); } catch (e) { C.toast(errText(e), 'error'); }
  const kinds = info.kinds || ['effect'];
  const kind = kinds.includes(want) ? want : 'effect';
  const kindSel = h('select', { id: 'gen-kind' }, ...KINDS.map(k => h('option', { value: k, disabled: !kinds.includes(k), selected: k === kind }, kinds.includes(k) ? k : `${k} (coming)`)));
  const idea = h('textarea', { id: 'gen-idea', class: 'au-prose', rows: 4, maxlength: 1000 });
  const placeholder = { effect: 'e.g. "Frost Nova: every adjacent enemy takes water damage and loses one action."',
    skill: 'e.g. "Quick Step: riding on a Move, the first blow that hits me this action does one less damage."' };
  // Tags (user 2026-11-23): the well-known tags of the built-ins, a hard requirement — the draft is checked against them.
  const tags = new Set();
  const tagBox = h('div', { class: 'gen-tags' });
  const loadTags = async () => {
    tags.clear();
    idea.placeholder = placeholder[kindSel.value] || '';
    let v = { groups: [] };
    try { v = await genApi(`vocab?kind=${encodeURIComponent(kindSel.value)}`); } catch (e) { C.toast(errText(e), 'error'); }
    tagBox.replaceChildren(...(v.groups || []).map(g => {
      const chips = g.values.map(val => {
        const t = `${g.id}:${val}`;
        const b = h('button', { class: 'gen-chip', type: 'button', 'aria-pressed': 'false', title: `${g.label}: ${val}` }, val.replace(/^elem_/, ''));
        b.addEventListener('click', () => { if (tags.has(t)) tags.delete(t); else tags.add(t); b.classList.toggle('on', tags.has(t)); b.setAttribute('aria-pressed', String(tags.has(t))); });
        return b;
      });
      return g.values.length > 12
        ? h('details', { class: 'gen-tag-group' }, h('summary', null, `${g.label} (${g.values.length})`), h('div', { class: 'gen-chips' }, ...chips))
        : h('div', { class: 'gen-tag-group' }, h('span', { class: 'gen-tag-label' }, g.label), h('div', { class: 'gen-chips' }, ...chips));
    }));
  };
  kindSel.addEventListener('change', loadTags);
  // Resources (user 2026-11-23): any picture / sound of chaosD6-Resources, also the ones the phone has not downloaded.
  const res = await resourcePicker();
  const go = h('button', { class: 'au-btn au-primary', type: 'button' }, 'Create preview');
  go.addEventListener('click', () => act(go, async () => {
    const r = await genApi('create', { method: 'POST', body: { kind: kindSel.value, idea: idea.value, tags: [...tags], resources: res.value() } });
    C.toast('Generating — this takes a few minutes on the big model', 'ok');
    C.navigate(`#/gen/d/${r.draft.draft_id}`);
  }));
  const busy = info.busy ? h('div', { class: 'au-hint' }, `Busy: ${info.busy.what === 'test' ? 'a test game' : 'a generation'} is running (one at a time). `,
    h('a', { href: `#/gen/d/${info.busy.draft_id}` }, 'Open it')) : null;
  const keyBtn = h('button', { class: 'au-btn', type: 'button', onclick: () => openKeySheet(info) }, info.model?.key_set ? 'Change model key…' : 'Model key…');
  const where = info.test?.where === 'oci' ? `test games run on ${info.test.host || 'OCI'}` : 'test games run on this node';
  const model = info.model?.configured
    ? h('div', { class: 'au-bar' }, h('span', { class: 'au-hint' }, `Model: ${info.model.name} at ${info.model.host}${info.model.key_set ? '' : ' (no key)'} · ${where}`), info.model.mobile || !info.model.key_set ? keyBtn : null)
    : h('div', { class: 'au-bar' }, h('span', { class: 'au-hint' }, info.model?.mobile ? 'Enter the OCI model key to generate from this phone.' : 'No big model on this node: run "node tools/effect-gen.mjs --save-key" (OCI) or install the desktop 8B — or enter the OCI key here.'), keyBtn);
  const list = h('div', { class: 'gen-list' });
  for (const d of info.drafts || []) {
    list.appendChild(h('div', { class: 'gen-item', role: 'link', tabindex: '0', onclick: () => C.navigate(`#/gen/d/${d.draft_id}`) },
      h('b', null, d.name || '(no name yet)'), customBadge(), statePill(d.state), h('span', { class: 'gen-idea' }, d.idea)));
  }
  // The header's "Drafts" lands here: the drafts first, then the form for a new one (#/gen/<kind> puts the form first).
  const drafts = [
    h('div', { class: 'au-sec' }, 'Your drafts'),
    (info.drafts || []).length ? list : h('div', { class: 'au-hint' }, 'No drafts yet — describe one below.'),
  ];
  const form = [
    h('div', { class: 'au-sec' }, 'New from a description'),
    h('p', { class: 'au-hint' }, 'Describe a new card in words. The model writes it, the validator prices it, a private test game plays it, and you publish it on your team\'s branch, marked custom.'),
    model, busy,
    h('div', { class: 'au-row' }, h('label', { for: 'gen-kind' }, 'Kind'), kindSel),
    h('div', { class: 'au-row' }, h('label', { for: 'gen-idea' }, 'Description'), idea),
    h('div', { class: 'au-row' }, h('label', null, 'Tags'), h('div', null, h('div', { class: 'au-hint' }, 'Pick the tags it must have — the draft is checked against every one.'), tagBox)),
    h('div', { class: 'au-row' }, h('label', null, 'Picture & sound'), res.el),
    h('div', { class: 'au-bar' }, go),
  ];
  loadTags();
  return pane(want ? 'Generate from a description' : 'Drafts', want ? [form, drafts] : [drafts, form]);
}

// Two searchable fields over GET resources (game/gen-resources.json — every effect sprite strip and sound fx of
// chaosD6-Resources); "not on this phone yet" marks the ones the APK's asset pack lacks. → { el, value() }
let resCache = null;
async function resourcePicker() {
  if (!resCache) { try { resCache = await genApi('resources'); } catch { resCache = { sprites: [], sounds: [] }; } }
  const mk = (id, list, ph) => {
    const dl = h('datalist', { id: `${id}-list` }, ...list.map(x => h('option', { value: x.name, label: x.in_pack ? x.path.replace(/^assets\//, '') : `not on this phone yet · ${x.path.replace(/^assets\//, '')}` })));
    const input = h('input', { type: 'search', id, list: `${id}-list`, placeholder: ph, autocomplete: 'off', spellcheck: 'false' });
    const pathOf = () => { const v = input.value.trim(); return v ? (list.find(x => x.name === v) || list.find(x => x.path === v))?.path || null : null; };
    input.addEventListener('change', () => { input.classList.toggle('gen-bad', !!input.value.trim() && !pathOf()); });
    return { input, dl, pathOf };
  };
  const sp = mk('gen-sprite', resCache.sprites || [], `picture (${(resCache.sprites || []).length})`), so = mk('gen-sound', resCache.sounds || [], `sound (${(resCache.sounds || []).length})`);
  const el = h('div', { class: 'gen-res' }, sp.input, sp.dl, so.input, so.dl,
    h('div', { class: 'au-hint' }, resCache.source ? `From ${resCache.source}${resCache.generated_at ? ` (${String(resCache.generated_at).slice(0, 10)})` : ''}; optional.` : 'The resource catalogue is missing (node tools/gen-resources-list.mjs).'));
  return { el, value: () => { const s = sp.pathOf(), o = so.pathOf(); return s || o ? { sprite: s, sound: o } : null; } };
}

// The OCI model URL + key (the phone has no local model); stored by the node in <profile dir>/llm.json, never shown again.
function openKeySheet(info) {
  const url = h('input', { type: 'url', id: 'gen-key-url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: `https://${info.model?.host && !/^127\.|^localhost/.test(info.model.host) ? info.model.host : '92-5-138-121.sslip.io'}/llm-big` });
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
  const def = d.def || {};
  const f = def.flags || {};
  let json;
  try { json = C.jsonfmt ? C.jsonfmt.renderJson(def, { width: 96 }) : null; } catch { json = null; }
  const facts = d.kind === 'skill'
    ? `rides on ${def.action_type || '?'} · ${def.is_permanent ? `permanent (${String(def.point_buy_stat || '?').replace(/^stat_/, '')}${def.fixed_power ? `, power ${def.fixed_power}` : ''})` : 'instant'} · hooks ${(f.hooks || []).join(', ') || '—'}`
    : `${(def.elements || []).map(e => String(e).replace(/^elem_/, '')).join(' + ')} · ${def.kind || '?'} · ${def.duration || '?'} · scope ${f.scope || '?'}${f.lock ? ` · lock ${f.lock}` : ''}${f.range ? ` · range ${f.range}` : ''}`;
  const media = def.card?.resources || def.resources;
  const card = h('div', { class: 'gen-card' },
    h('div', { class: 'au-bar' }, h('b', null, def.name || def.id), customBadge(), statePill('preview'), d.verdict ? h('span', { class: 'au-hint' }, `validator: ${d.verdict}${d.check?.ratio != null ? ` (ratio ${d.check.ratio})` : ''}`) : null),
    h('div', { class: 'gen-elems' }, facts),
    media ? h('div', { class: 'au-hint' }, [media.sprites?.effect?.path, ...(media.sounds?.fx || []).map(s => s.path)].filter(Boolean).map(p => p.replace(/^assets\//, '')).join(' · ')) : null,
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
  const tagsEl = h('div', { class: 'gen-chips' });
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
  retryBox.append(h('div', { class: 'au-sec' }, 'Retry'), extra, sugg, h('div', { class: 'au-bar' }, bRetryGo));

  const render = () => {
    title.replaceChildren(d.def?.name || '(no definition yet)');
    stateEl.replaceChildren(statePill(d.state));
    idea.replaceChildren(`"${d.idea}"${(d.extras || []).length ? ` + ${d.extras.length} change(s)` : ''}`);
    status.textContent = RUNNING.includes(d.state) ? (d.status || '…') : '';
    const failed = /^testing failed \d+$/.test(d.state);
    bShow.disabled = !d.def;
    const missed = d.tag_problems || [];
    bTest.disabled = !d.def || d.verdict !== 'ok' || missed.length > 0 || !(d.state === 'preview' || failed || d.state === 'testing success');
    bTest.title = d.def && d.verdict !== 'ok' ? `The validator rates it "${d.verdict}" — retry first` : missed.length ? `It misses tags you picked — retry first: ${missed.join('; ')}` : '';
    // the picked tags: ✓ met / ✗ missed (a hard requirement)
    tagsEl.replaceChildren(...(d.tags || []).map(t => {
      const v = t.split(':')[1].replace(/^elem_/, '');
      if (!d.def) return h('span', { class: 'gen-chip', title: 'checked once there is a draft' }, v);
      const bad = missed.some(p => p.startsWith(`tag ${t} `));
      return h('span', { class: `gen-chip ${bad ? 'bad' : 'on'}`, title: bad ? missed.find(p => p.startsWith(`tag ${t} `)) : 'met' }, `${bad ? '✗' : '✓'} ${v}`);
    }));
    tagsEl.parentElement && (tagsEl.parentElement.hidden = !(d.tags || []).length);
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
        h('div', { class: 'au-bar' }, h('b', null, t.pass ? 'Test passed' : 'Test failed'), h('span', { class: 'au-hint' }, `${d.kind === 'skill' ? 'played' : 'cast'} ${t.casts ?? '?'}× · ${d.kind === 'skill' ? 'paid off' : 'landed'} ${t.lands ?? '?'}× · engine errors ${t.errors ?? '?'} · divergences ${t.divergences ?? '?'}`)),
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
      h('span', { class: 'au-hint' }, `${d.published.granted ?? 0} team character(s) got the card (archive, new)`)));
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
  bRetry.addEventListener('click', () => { retryBox.hidden = !retryBox.hidden; if (!retryBox.hidden) extra.focus(); });
  bRetryGo.addEventListener('click', () => act(bRetryGo, async () => {
    await post('retry', { extra: extra.value, suggestions: [...picked] }, 'Generating again with your changes');
    extra.value = ''; picked.clear(); retryBox.hidden = true; render();
  }));
  bPub.addEventListener('click', () => act(bPub, async () => {
    const team = C.session?.team?.name || 'your team';
    if (!(await C.confirm('Publish the preview?', `"${d.def?.name}" goes on ${team}'s branch of chaosD6-${d.kind === 'skill' ? 'Skills' : 'Effects'}, marked custom, open to the players' votes, and every ${team} character gets the card in its archive.`))) return;
    const r = await post('publish', {});
    if (r) C.toast(`Published on ${r.ref?.branch || 'the team branch'} — ${r.publish?.state || '?'}; ${r.granted?.length || 0} character(s) got the card`, r.publish?.state === 'published' ? 'ok' : 'info');
  }));
  bDel.addEventListener('click', () => act(bDel, async () => {
    if (!(await C.confirm('Delete this draft?', 'The draft and its test result are removed from this node.'))) return;
    await genApi('delete', { method: 'POST', body: { draft_id: id } });
    stop(); C.navigate('#/gen/');
  }));

  const root = pane('Generated draft', [
    h('div', { class: 'au-bar' }, title, customBadge(), h('span', { class: 'au-hint' }, d.kind || 'effect'), stateEl), idea,
    h('div', { class: 'au-bar' }, h('span', { class: 'au-hint' }, 'Tags:'), tagsEl), status,
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
  C.registerRoute('#/gen/', routeList);
  C.registerRoute('#/gen', routeList);
  // Entry points: header "Drafts" (before author.js's "New skill / effect / class", user 2026-11-23) and author.js's
  // "Generate from a description…" button on the New page (8a). Signed-in only, like the other edit actions.
  C.registerHeaderAction({ id: 'gen-drafts', label: 'Drafts', icon: '✦', before: 'au-new', onClick: () => C.navigate('#/gen/') });
}
