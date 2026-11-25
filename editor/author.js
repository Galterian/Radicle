// editor/author.js — node-mode authoring for the rules editor (EDITOR_SPEC.md, agent A).
// app.js imports this only when session.mode === 'node' and calls initAuthoring(ctx) (ctx: see the spec,
// "app.js ↔ author.js interface"). Not logged in → one header action "How to sign in" (reason + Re-check).
// Logged in → "Propose a change" on data-collection entries (ruling 3), "Fork as new <kind>" on definition entries,
// header "New skill / effect / class" (#/new/<kind>) and "My team's definitions" (#/mine) (ruling 2).
// Nothing here touches `document` at import time (the module is imported by node checks without a DOM).

const KINDS = ['skill', 'effect', 'class'];
// Fields only the built-ins carry; a fork drops them unless the server's template has the key too.
const BUILTIN_ONLY = ['deal_order', 'card', 'ui', 'source'];
// Fallback when the template endpoint fails — the server's template schema wins.
const FOREIGN_SCHEMA = { skill: 'chaosd6.skill/1', effect: 'chaosd6.effect/1', class: 'chaosd6.class/1' };
const KIND_LABEL = { skill: 'skill', effect: 'effect', class: 'class' };

export const AU_CSS = `
.au-form{display:flex;flex-direction:column;gap:12px;min-width:0}
.au-row{display:grid;grid-template-columns:minmax(120px,200px) 1fr;gap:6px 12px;align-items:start}
.au-row>label,.au-lbl{font-weight:600;padding-top:9px;word-break:break-word}
.au-form input,.au-form select,.au-form textarea,.au-btn{min-height:40px;box-sizing:border-box;font:inherit;
  border-radius:6px;border:1px solid var(--border,rgba(127,127,127,.45));background:var(--input-bg,transparent);
  color:inherit;padding:6px 10px;width:100%;min-width:0}
.au-form textarea.au-prose{resize:vertical;min-height:80px;line-height:1.4}
.au-btn{width:auto;cursor:pointer;background:var(--btn-bg,rgba(127,127,127,.14));font-weight:600;padding:6px 14px}
.au-btn.au-primary{background:var(--accent,#3d7be0);border-color:var(--accent,#3d7be0);color:#fff}
.au-btn:disabled{opacity:.45;cursor:default}
.au-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.au-bar .au-grow{flex:1 1 auto}
.au-hint{font-size:.9em;opacity:.75;line-height:1.4}
.au-sec{font-weight:700;margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.au-je{position:relative;border:1px solid var(--border,rgba(127,127,127,.45));border-radius:6px;overflow:hidden;
  background:var(--code-bg,rgba(127,127,127,.06))}
.au-je.au-bad{border-color:#d9534f}
.au-form textarea.au-je-ta{display:block;width:100%;border:0;border-radius:0;margin:0;background:transparent;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:13px;line-height:20px;
  padding:8px 10px;white-space:pre;overflow:auto;overflow-wrap:normal;tab-size:2;resize:vertical;position:relative;z-index:1}
.au-je-hl{position:absolute;left:0;right:0;height:20px;background:rgba(217,83,79,.25);pointer-events:none;z-index:2;display:none}
.au-je-err{font-size:12.5px;color:#d9534f;padding:6px 10px;border-top:1px solid rgba(217,83,79,.4);display:none}
.au-je-err code{display:block;white-space:pre;overflow-x:auto;margin-top:4px;background:rgba(217,83,79,.12);
  padding:2px 6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
.au-diff{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.45;max-height:260px;overflow:auto;
  border:1px solid var(--border,rgba(127,127,127,.3));border-radius:6px;padding:6px 10px}
.au-diff div{white-space:pre-wrap;word-break:break-word;padding:1px 0}
.au-diff .au-path{font-weight:700}
.au-diff .au-old{color:#d9534f;text-decoration:line-through}
.au-diff .au-new{color:#3c9a5f}
.au-pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.85em;font-weight:700;
  background:rgba(127,127,127,.2)}
.au-pill.au-ok,.au-pill.au-published,.au-pill.au-accept{background:#3c9a5f;color:#fff}
.au-pill.au-nerf,.au-pill.au-boost,.au-pill.au-pending,.au-pill.au-acceptwithcounters,.au-pill.au-needsrework{background:#d39e00;color:#111}
.au-pill.au-reject,.au-pill.au-error,.au-pill.au-blocked{background:#d9534f;color:#fff}
.au-counters{margin:4px 0 0 0;padding-left:20px;word-break:break-word}
.au-errs{margin:4px 0 0 0;padding-left:20px;color:#d9534f;word-break:break-word}
.au-box{border:1px solid var(--border,rgba(127,127,127,.3));border-radius:6px;padding:8px 12px;display:flex;
  flex-direction:column;gap:6px;min-width:0}
.au-box pre{white-space:pre;overflow:auto;max-height:240px;margin:0;font-size:12.5px}
.au-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;word-break:break-all}
.au-list{display:flex;flex-direction:column;gap:8px}
.au-item{display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:center;
  border:1px solid var(--border,rgba(127,127,127,.3));border-radius:6px;padding:8px 10px}
.au-item .au-meta{grid-column:1/-1;font-size:.88em;opacity:.8}
.au-field-err{color:#d9534f;font-size:.88em;grid-column:2}
.au-kinds{display:flex;flex-direction:column;gap:10px}
@media (max-width:760px){
  .au-row{grid-template-columns:1fr}
  .au-row>label,.au-lbl{padding-top:0}
  .au-field-err{grid-column:1}
  .au-bar .au-btn{flex:1 1 auto}
  .au-item{grid-template-columns:1fr auto}
}
`;

// ---------------------------------------------------------------- small helpers (DOM only inside functions)

/** h('div', { class, text, onclick, ...attrs }, ...children) — local so nothing depends on ctx.el's exact attrs. */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (['value', 'disabled', 'hidden', 'checked', 'rows', 'type', 'placeholder', 'title'].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  add(e, kids);
  return e;
}
function add(e, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    e.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
  }
  return e;
}
function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isPlain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const errText = (e) => (e && (e.error || e.message)) || String(e);
const short = (s, n = 8) => (s ? String(s).slice(0, n) : '—');
const clip = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const show = (v) => (v === undefined ? '∅' : clip(JSON.stringify(v)));
let uid = 0;
const nextId = (p) => `au-${p}-${++uid}`;

/** Team name → the id infix: teamSlug (profile-auth) lowered, '-' → '_' ("Gold-Team" → "gold_team"). */
export function idSlug(team) {
  return String(team || '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'team';
}
/** Same ID rule as the server: ^(skill|effect|class)_[a-z0-9_]+$ with the prefix of the edited kind. */
export function idError(kind, id) {
  if (!new RegExp(`^${kind}_[a-z0-9_]+$`).test(id || '')) return `id must look like ${kind}_<team>_<name> (a–z, 0–9, _)`;
  return null;
}
/** Built-in id → fork id `<kind>_<team-slug>_<name>`. */
export function forkId(kind, srcId, team) {
  const name = String(srcId || '').replace(new RegExp(`^${kind}_`), '');
  const slug = idSlug(team);
  return `${kind}_${slug}_${name.startsWith(slug + '_') ? name.slice(slug.length + 1) : name}`;
}
/** Copy a built-in definition as a foreign one: drop built-in-only keys the template lacks, foreign schema, 1.0.0. */
export function forkDefinition(kind, src, tplDef, newId) {
  const keys = isPlain(tplDef) ? new Set(Object.keys(tplDef)) : null;
  const rest = {};
  for (const [k, v] of Object.entries(clone(src) || {})) {
    if (BUILTIN_ONLY.includes(k) && !(keys && keys.has(k))) continue;
    rest[k] = v;
  }
  const out = { schema: (tplDef && tplDef.schema) || FOREIGN_SCHEMA[kind], id: newId, name: rest.name, version: '1.0.0' };
  for (const [k, v] of Object.entries(rest)) if (!(k in out)) out[k] = v;
  if (out.name === undefined) delete out.name;
  if (isPlain(out.flags)) for (const f of ['passOrder', 'buildingSkill', 'planLock']) delete out.flags[f];   // they order the built-ins only
  return out;
}
/** Deep diff → [{ path, old, new }] (arrays of different length are replaced as a whole). */
export function diffPaths(a, b, path = '', out = [], max = 200) {
  if (out.length >= max) return out;
  if (isPlain(a) && isPlain(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffPaths(a[k], b[k], path ? `${path}.${k}` : k, out, max);
    }
  } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => diffPaths(x, b[i], `${path}[${i}]`, out, max));
  } else if (!same(a, b)) out.push({ path: path || '(root)', old: a, new: b });
  return out;
}
const isScalar = (x) => ['number', 'string', 'boolean'].includes(typeof x);
/** A flat object of scalars. */
export function isFlat(v) {
  return isPlain(v) && Object.keys(v).length > 0 && Object.keys(v).length <= 40 && Object.values(v).every(isScalar);
}
/** Form-editable: an object (≤ 40 keys) with at least one scalar; its non-scalar keys get a small JSON field. */
export function isFormable(v) {
  return isPlain(v) && Object.keys(v).length > 0 && Object.keys(v).length <= 40 && Object.values(v).some(isScalar);
}
/** Fallback for jsonfmt.parseJsonText when J's module lacks it: JSON.parse + line/col from the engine message. */
function fallbackParse(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) {
    const msg = String(e.message || e);
    let line = 1, col = 1;
    const lc = /line (\d+) column (\d+)/.exec(msg);
    const pos = /position (\d+)/.exec(msg);
    if (lc) { line = +lc[1]; col = +lc[2]; } else if (pos) {
      const before = text.slice(0, +pos[1]).split('\n'); line = before.length; col = before[before.length - 1].length + 1;
    }
    return { ok: false, error: msg, line, col };
  }
}

// ---------------------------------------------------------------- module state

let C = null;                       // ctx
const registered = new Set();       // header/entry action ids already registered
const sheets = new Map();           // route key → root element of the open sheet (no double open)
const tplCache = new Map();         // kind → Promise<{ def, hints }>
let builtinIds = null;              // Promise<{ skill:[...], ... }> from defs/index.json

const fmt = (v, width = 72) => {
  try { if (C.jsonfmt && C.jsonfmt.formatCompact) return C.jsonfmt.formatCompact(v, { width }); } catch { /* fall back */ }
  return JSON.stringify(v, null, 2);
};
const parse = (t) => {
  if (C.jsonfmt && C.jsonfmt.parseJsonText) {
    try { return C.jsonfmt.parseJsonText(t); } catch { /* fall back */ }
  }
  return fallbackParse(t);
};
const loggedIn = () => !!(C.session && C.session.logged_in);
const team = () => (C.session && C.session.team) || {};
const teamName = () => team().name || 'my team';

/** Run an async request with `btns` disabled; API errors → toast with the server text. Returns undefined on error,
 *  except a 4xx refusal that carries a JSON `{ ok: false, errors }` body: that body is returned so the caller lists the errors. */
async function busy(btns, fn) {
  const list = [].concat(btns).filter(Boolean);
  const prev = list.map((b) => b.disabled);
  list.forEach((b) => { b.disabled = true; b.setAttribute('aria-busy', 'true'); });
  try { return await fn(); } catch (e) {
    if (e && e.body && typeof e.body === 'object' && e.body.ok === false) return e.body;
    C.toast(errText(e), 'error'); return undefined;
  } finally {
    list.forEach((b, i) => { b.disabled = prev[i]; b.removeAttribute('aria-busy'); });
  }
}

/** ctx.openSheet + our own Close button + an optional unsaved-changes guard. */
function sheet(key, title, body, { wide = false, dirty = null } = {}) {
  const old = key && sheets.get(key);
  if (old && old.isConnected) return null;
  let handle = null, closed = false;
  const guard = async () => (!dirty || !dirty()) || C.confirm('Discard unsaved changes?',
    'This sheet has changes that were not published or submitted. Close it anyway?');
  const cleanup = () => {
    closed = true;
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', onUnload);
    if (key && sheets.get(key) === root) sheets.delete(key);
  };
  const close = async (force) => {
    if (closed) return;
    if (!force && !(await guard())) return;
    cleanup();
    if (handle && handle.close) handle.close();
  };
  const onUnload = (ev) => {
    if (!root.isConnected) { window.removeEventListener('beforeunload', onUnload); return; }
    if (dirty && dirty()) { ev.preventDefault(); ev.returnValue = ''; }
  };
  const root = h('div', { class: 'au-form' }, body);
  // onClose: app.js closed it (×, ←, backdrop). beforeClose: if app.js adopts it, it awaits the unsaved-changes guard
  // before closing from its own controls (false = keep open); until then only our Close button asks.
  handle = C.openSheet(title, root, { wide, onClose: cleanup, beforeClose: () => guard() });
  if (key) sheets.set(key, root);
  if (dirty && typeof window !== 'undefined') window.addEventListener('beforeunload', onUnload);
  return { root, close };
}

function closeButton(getSheet) {
  return h('button', { class: 'au-btn', type: 'button', text: 'Close', onclick: () => { const s = getSheet(); if (s) s.close(); } });
}

function template(kind) {
  if (!tplCache.has(kind)) {
    const p = C.api(`templates?kind=${encodeURIComponent(kind)}`).then((r) => {
      const def = isPlain(r && r.def) ? r.def : isPlain(r && r.template) ? r.template : (() => {
        const d = { ...(r || {}) }; delete d.hints; delete d.ok; return d;
      })();
      return { def, hints: r && r.hints };
    });
    p.catch(() => tplCache.delete(kind));
    tplCache.set(kind, p);
  }
  return tplCache.get(kind);
}
function knownIds() {
  if (!builtinIds) builtinIds = fetch('defs/index.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return builtinIds;
}

// ---------------------------------------------------------------- JSON text editor

/** Textarea JSON editor: monospace, no wrap, live parse errors with line/col + highlighted line. */
function jsonEditor(value, { rows = 14, onChange } = {}) {
  const ta = h('textarea', { class: 'au-je-ta', rows, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off',
    autocorrect: 'off', wrap: 'off' });
  ta.value = typeof value === 'string' ? value : fmt(value);
  const hl = h('div', { class: 'au-je-hl' });
  const errBox = h('div', { class: 'au-je-err', role: 'status' });
  const box = h('div', { class: 'au-je' }, ta, hl, errBox);
  let last = null, timer = null;
  const place = () => {
    if (!last || last.ok) { hl.style.display = 'none'; return; }
    const top = 8 + (Math.max(1, last.line || 1) - 1) * 20 - ta.scrollTop;
    hl.style.top = `${top}px`;
    hl.style.display = top < -20 || top > (ta.clientHeight || 1e6) ? 'none' : 'block';
  };
  const gotoErr = () => {
    if (!last || last.ok) return;
    const lines = ta.value.split('\n');
    let off = 0;
    for (let i = 0; i < Math.min((last.line || 1) - 1, lines.length); i++) off += lines[i].length + 1;
    off += Math.max(0, (last.col || 1) - 1);
    ta.focus();
    if (ta.setSelectionRange) ta.setSelectionRange(off, off + 1);
  };
  const check = () => {
    last = parse(ta.value);
    box.classList.toggle('au-bad', !last.ok);
    clear(errBox);
    if (!last.ok) {
      const line = ta.value.split('\n')[(last.line || 1) - 1] || '';
      add(errBox, [
        h('span', { text: `Line ${last.line || '?'}, col ${last.col || '?'}: ${last.error || 'invalid JSON'} ` }),
        h('button', { class: 'au-btn', type: 'button', text: 'Go to error', onclick: gotoErr }),
        h('code', { text: `${line}\n${' '.repeat(Math.max(0, (last.col || 1) - 1))}^` }),
      ]);
      errBox.style.display = 'block';
    } else errBox.style.display = 'none';
    place();
    return last;
  };
  ta.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { check(); if (onChange) onChange(); }, 150);
  });
  ta.addEventListener('scroll', place);
  check();
  return {
    el: box, ta,
    text: () => ta.value,
    setText(t) { ta.value = t; check(); if (onChange) onChange(); },
    read: () => check(),
    flush() { clearTimeout(timer); return check(); },
  };
}

/** `data` editor: a form (one input per scalar key, a small JSON field per array/object key) with a Raw JSON
 *  toggle, for objects with scalars; anything else → the JSON editor. */
function valueEditor(value, { onChange } = {}) {
  const raw = jsonEditor(value, { rows: 12, onChange });
  const wrap = h('div', { class: 'au-form' });
  const formBox = h('div', { class: 'au-form' });
  let mode = isFormable(value) ? 'form' : 'raw';
  let fields = [];
  const buildForm = (obj) => {
    clear(formBox);
    fields = Object.entries(obj).map(([k, v]) => {
      const id = nextId('f');
      let input, kind = isScalar(v) ? typeof v : 'json';
      if (kind === 'json') {
        const je = jsonEditor(v, { rows: Math.min(8, fmt(v).split('\n').length), onChange });
        je.ta.id = id;
        formBox.appendChild(h('div', { class: 'au-row' }, h('label', { for: id, text: k }), je.el));
        return { k, kind, je };
      }
      if (kind === 'boolean') {
        input = h('select', { id }, h('option', { value: 'true', text: 'true' }), h('option', { value: 'false', text: 'false' }));
        input.value = String(v);
      } else if (kind === 'string' && (v.length > 60 || v.includes('\n'))) {
        input = h('textarea', { id, class: 'au-prose', rows: Math.min(10, 2 + Math.ceil(v.length / 70)) });
        input.value = v;
      } else {
        input = h('input', { id, type: 'text', autocomplete: 'off' });
        input.value = String(v);
      }
      const err = h('div', { class: 'au-field-err', hidden: true });
      input.addEventListener('input', () => onChange && onChange());
      input.addEventListener('change', () => onChange && onChange());
      formBox.appendChild(h('div', { class: 'au-row' }, h('label', { for: id, text: k }), input, err));
      return { k, kind, input, err };
    });
  };
  const readForm = () => {
    const out = {};
    let bad = null;
    for (const f of fields) {
      if (f.kind === 'json') {
        const r = f.je.read();
        if (!r.ok) bad = bad || `${f.k}: line ${r.line}, col ${r.col}: ${r.error}`;
        out[f.k] = r.value;
        continue;
      }
      const s = f.input.value;
      f.err.hidden = true;
      if (f.kind === 'number') {
        const n = s.trim() === '' ? NaN : Number(s);
        if (!Number.isFinite(n)) { f.err.textContent = 'not a number'; f.err.hidden = false; bad = bad || `${f.k}: not a number`; }
        out[f.k] = n;
      } else if (f.kind === 'boolean') out[f.k] = s === 'true';
      else out[f.k] = s;
    }
    return bad ? { ok: false, error: bad } : { ok: true, value: out };
  };
  const toggle = h('button', { class: 'au-btn', type: 'button' });
  const render = () => {
    clear(wrap);
    toggle.textContent = mode === 'form' ? 'Raw JSON' : 'Form';
    toggle.hidden = !(mode === 'form' || isFormable(raw.read().value));
    wrap.appendChild(mode === 'form' ? formBox : raw.el);
  };
  toggle.addEventListener('click', () => {
    if (mode === 'form') {
      const r = readForm();
      if (!r.ok) { C.toast(r.error, 'error'); return; }
      raw.setText(fmt(r.value)); mode = 'raw';
    } else {
      const r = raw.read();
      if (!r.ok) { C.toast('Fix the JSON first', 'error'); return; }
      if (!isFormable(r.value)) { C.toast('Not an object with plain fields — stays raw JSON', 'error'); return; }
      buildForm(r.value); mode = 'form';
    }
    render();
    if (onChange) onChange();
  });
  if (mode === 'form') buildForm(value);
  render();
  return { el: wrap, toggle, read: () => (mode === 'form' ? readForm() : raw.read()), mode: () => mode };
}

function errList(errors) {
  const list = [].concat(errors || []).filter((x) => x != null && x !== '');
  return list.length ? h('ul', { class: 'au-errs' }, list.map((e) => h('li', { text: typeof e === 'string' ? e : JSON.stringify(e) }))) : null;
}
function pill(state, label) {
  return h('span', { class: `au-pill au-${String(state || 'none').replace(/[^a-z]/gi, '')}`, text: label || String(state) });
}

// ---------------------------------------------------------------- sign-in help

const REASONS = {
  'no team': 'This node has no team yet. Open the startup menu → Team: set your team name, then press Re-check.',
  'not an owner': 'This device is not an owner of its team. Ask the team owner to approve this device '
    + '(startup menu → Team on the owner\'s device), then press Re-check.',
  'no identity': 'This node has no device identity yet. Start the node from the startup menu once so it creates its '
    + 'key, then press Re-check.',
};

function openSignIn() {
  const msg = h('p', { class: 'au-hint' });
  const who = h('p', { class: 'au-mono' });
  const render = () => {
    const s = C.session || {};
    if (s.logged_in) msg.textContent = `Signed in as ${teamName()} — you can propose changes and author definitions.`;
    else msg.textContent = REASONS[s.reason] || `Not signed in${s.reason ? ` (${s.reason})` : ''}. Set your team in the startup menu, then press Re-check.`;
    who.textContent = s.identity ? `Device: ${s.identity.label || ''} ${s.identity.id || ''}`.trim() : '';
  };
  const recheck = h('button', { class: 'au-btn au-primary', type: 'button', text: 'Re-check' });
  let sh = null;
  recheck.addEventListener('click', () => busy(recheck, async () => {
    await C.refreshSession();
    render();
    if (loggedIn()) { C.toast(`Signed in as ${teamName()}`, 'ok'); installAuthoring(); }
    else C.toast('Still read-only', 'info');
  }));
  render();
  sh = sheet('signin', 'How to sign in', [
    h('p', { text: 'Editing on this node needs your TEAM identity: the team name set in the startup menu, and this device listed as one of the team\'s owners. There is no password — the device key is the proof.' }),
    msg, who, h('div', { class: 'au-bar' }, recheck, closeButton(() => sh)),
  ]);
}

// ---------------------------------------------------------------- proposals (ruling 3)

function collectionFile(c) {
  const col = ((C.index && C.index.collections) || []).find((x) => x.id === c);
  return (col && col.file) || `${c}.json`;
}
const isProposable = (c, entry) => loggedIn() && !C.isDefinitions(c) && !C.isCatalog?.(c) && c !== 'effects' && c !== 'skills'
  && !!entry && Array.isArray(entry.versions) && entry.versions.length > 0;

export function openProposal(c, entry) {
  const v = C.activeVersion(entry) || entry.versions[entry.versions.length - 1];
  if (!v) { C.toast('This entry has no version to start from', 'error'); return; }
  const file = collectionFile(c);
  const hasLogic = v.logic !== undefined;
  const notesId = nextId('notes');
  const notes = h('textarea', { id: notesId, class: 'au-prose', rows: 3,
    placeholder: 'Why this change? (required — shown in the Versions tab and to voters)' });
  const diffBox = h('div', { class: 'au-diff' });
  const submit = h('button', { class: 'au-btn au-primary', type: 'button', text: 'Submit proposal' });
  const result = h('div', { class: 'au-box', hidden: true });
  let timer = null;
  const changed = () => { clearTimeout(timer); timer = setTimeout(update, 120); };
  const dataEd = valueEditor(clone(v.data), { onChange: changed });
  const logicEd = hasLogic ? jsonEditor(clone(v.logic), { rows: 14, onChange: changed }) : null;
  let changes = [];
  let saved = false;        // appended, the verdict / counter-proposals are on show: no second submit
  function readAll() {
    const d = dataEd.read();
    const l = logicEd ? logicEd.read() : { ok: true, value: undefined };
    return { ok: d.ok && l.ok, data: d.value, logic: l.value };
  }
  function update() {
    const r = readAll();
    clear(diffBox);
    if (!r.ok) { diffBox.appendChild(h('div', { text: 'Fix the JSON errors to see the diff.' })); changes = []; }
    else {
      changes = diffPaths({ data: v.data, ...(hasLogic ? { logic: v.logic } : {}) },
        { data: r.data, ...(hasLogic ? { logic: r.logic } : {}) });
      if (!changes.length) diffBox.appendChild(h('div', { text: `No changes vs v${v.version} yet.` }));
      for (const ch of changes) {
        diffBox.appendChild(h('div', {}, h('span', { class: 'au-path', text: ch.path }), ': ',
          h('span', { class: 'au-old', text: show(ch.old) }), ' → ', h('span', { class: 'au-new', text: show(ch.new) })));
      }
    }
    submit.disabled = saved || !r.ok || !changes.length || !notes.value.trim();
    submit.title = !notes.value.trim() ? 'Notes are required' : !changes.length ? 'Nothing changed' : '';
  }
  notes.addEventListener('input', changed);
  submit.addEventListener('click', () => busy(submit, async () => {
    const r = readAll();
    if (!r.ok || !notes.value.trim()) return;
    const body = { collection: c, entry_id: entry.id, data: r.data, notes: notes.value.trim() };
    if (hasLogic) body.logic = r.logic;
    const res = await C.api('proposals', { method: 'POST', body })
      .catch((e) => { if (e && e.body && typeof e.body === 'object' && e.body.ok === false) return e.body; throw e; });   // 400 → list its errors
    if (!res || res.ok === false) {
      clear(result); result.hidden = false;
      add(result, [res && res.verdict ? h('div', {}, pill(res.verdict, `verdict: ${res.verdict}`)) : null,
        h('div', { text: (res && res.error) || 'The proposal was refused.' }), errList(res && res.errors)]);
      C.toast((res && res.error) || 'The proposal was refused', 'error');
      return;
    }
    const errs = [].concat(res.errors || []);
    C.toast(`Proposal v${res.version} saved${res.verdict ? ` — verdict ${res.verdict}` : ''}${errs.length ? ` — ${errs.length} warning(s): ${clip(String(errs[0]), 80)}` : ''}`,
      errs.length || res.verdict === 'reject' ? 'error' : 'ok');
    C.invalidate(file);
    const counters = [].concat(res.counters || []);
    const goVersions = async () => { if (sh) await sh.close(true); C.navigate(`#/${c}/${encodeURIComponent(entry.id)}/versions`); };
    if (!counters.length && res.verdict !== 'needs_rework') return goVersions();
    // rebalance.mjs verdict + its counter-proposal drafts (not written — for the voters / a follow-up proposal)
    saved = true; submit.disabled = true; submit.textContent = `Saved as v${res.version}`;
    clear(result); result.hidden = false;
    const sc = res.scores && res.scores.proposal != null ? `score ${res.scores.current} → ${res.scores.proposal}` : null;
    add(result, [
      h('div', {}, pill(res.verdict, `verdict: ${res.verdict}`), sc ? h('span', { class: 'au-hint', text: ` ${sc}` }) : null),
      h('div', { class: 'au-hint', text: res.verdict === 'needs_rework'
        ? 'Outside the ±15% tolerance and the counter-proposals do not bring the linked entries back in line — saved for the vote, but consider reworking it.'
        : 'Outside the ±15% tolerance: the rebalance script drafted these counter-proposals on linked entries (not saved).' }),
      counters.length ? h('ul', { class: 'au-counters' }, counters.map((x) => h('li', {},
        h('span', { class: 'au-path', text: x.entry_id }), `: ${x.change} (score ${x.score_before} → ${x.score_after})`,
        x.within ? h('span', { class: 'au-hint', text: ' within ±15%' }) : null,
        x.valid === false ? h('span', { class: 'au-hint', text: ' (fails validation)' }) : null))) : null,
      h('div', { class: 'au-bar' }, h('button', { class: 'au-btn', type: 'button', text: 'View versions', onclick: goVersions })),
    ]);
  }).then(() => { if (saved) submit.disabled = true; }));
  let sh = null;
  const dataHead = h('div', { class: 'au-sec' }, h('span', { class: 'au-grow', text: 'data' }), dataEd.toggle);
  sh = sheet(`prop:${c}/${entry.id}`, `Propose a change — ${entry.name || entry.id}`, [
    h('div', { class: 'au-hint', text: `Starts from the active version v${v.version} (${v.status || 'active'}). Submitting appends a NEW version (status proposal, weight 0, origin player_vote) — nothing is changed in place.` }),
    h('div', { class: 'au-row' }, h('label', { for: notesId, text: 'Notes' }), notes),
    dataHead, dataEd.el,
    hasLogic ? [h('div', { class: 'au-sec', text: 'logic' }), logicEd.el] : null,
    h('div', { class: 'au-sec', text: 'Changes' }), diffBox, result,
    h('div', { class: 'au-bar' }, submit, closeButton(() => sh)),
  ], { wide: true, dirty: () => !saved && (!!notes.value.trim() || changes.length > 0) });
  update();
}

// ---------------------------------------------------------------- definitions (ruling 2)

function renderHints(hints) {
  if (hints == null || hints === '' || (isPlain(hints) && !Object.keys(hints).length)) return null;
  let body;
  if (typeof hints === 'string') body = h('pre', { text: hints });
  else if (Array.isArray(hints)) body = h('ul', {}, hints.map((x) => h('li', { text: typeof x === 'string' ? x : JSON.stringify(x) })));
  else body = h('div', {}, Object.entries(hints).map(([k, x]) => h('div', {}, h('b', { text: `${k}: ` }),
    typeof x === 'string' ? x : JSON.stringify(x))));
  return h('details', { class: 'au-box' }, h('summary', { text: 'Field help' }), body);
}

/** The definition editor: id + name (synced into the JSON), JSON, Validate, Publish to <Team>'s branch. */
export function openDefEditor({ kind, def, title, hints, key }) {
  const idIn = h('input', { id: nextId('id'), type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const nameIn = h('input', { id: nextId('name'), type: 'text', autocomplete: 'off' });
  const msgIn = h('input', { id: nextId('msg'), type: 'text', autocomplete: 'off', placeholder: 'optional' });
  const idErr = h('div', { class: 'au-field-err', hidden: true });
  idIn.value = def.id || '';
  nameIn.value = def.name || '';
  const validateBtn = h('button', { class: 'au-btn', type: 'button', text: 'Validate' });
  const publishBtn = h('button', { class: 'au-btn au-primary', type: 'button', text: `Publish to ${teamName()}'s branch`, disabled: true });
  const verdictBox = h('div', { class: 'au-box', hidden: true });
  const pubBox = h('div', { class: 'au-box', hidden: true });
  let validated = null;     // { text, ok, verdict }
  let savedText = null;     // text of the last successful publish
  let inFlight = false;
  const ed = jsonEditor(def, { rows: 24, onChange: () => { fromJson(); refresh(); } });
  const initialText = ed.text();

  const refresh = () => {
    const okNow = !!validated && validated.text === ed.text() && validated.ok && validated.verdict !== 'reject';
    publishBtn.disabled = inFlight || !okNow;
    publishBtn.title = okNow ? '' : 'Validate the current text first (must be ok and not rejected)';
    validateBtn.disabled = inFlight;
    const e = idError(kind, idIn.value);
    idErr.textContent = e || ''; idErr.hidden = !e;
    knownIds().then((ids) => {
      if (!e && ids && [].concat(ids[kind] || []).includes(idIn.value)) {
        idErr.textContent = `${idIn.value} is a built-in id — pick a new one`; idErr.hidden = false;
      }
    });
  };
  // JSON → fields (when the JSON parses and the user is not typing in that field)
  const fromJson = () => {
    const r = ed.read();
    if (!r.ok || !isPlain(r.value)) return;
    if (typeof document !== 'undefined' && document.activeElement !== idIn && typeof r.value.id === 'string') idIn.value = r.value.id;
    if (typeof document !== 'undefined' && document.activeElement !== nameIn && typeof r.value.name === 'string') nameIn.value = r.value.name;
  };
  // field → JSON: replace the top-level value textually (keeps the formatting), else re-format.
  const toJson = (field, value) => {
    const r = ed.read();
    if (!r.ok || !isPlain(r.value)) { C.toast(`Fix the JSON first — ${field} was not written into it`, 'error'); return; }
    if (r.value[field] === value) return;
    const next = { ...r.value, [field]: value };
    let text = null;
    if (typeof r.value[field] === 'string') {
      const lit = JSON.stringify(r.value[field]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`("${field}"\\s*:\\s*)${lit}`);
      const t = ed.text().replace(re, (_, p) => p + JSON.stringify(value));
      const p = parse(t);
      if (p.ok && same(p.value, next)) text = t;
    }
    ed.setText(text != null ? text : fmt(next, 100));
  };
  idIn.addEventListener('input', () => { toJson('id', idIn.value.trim()); refresh(); });
  nameIn.addEventListener('input', () => toJson('name', nameIn.value));

  const readDef = () => {
    const r = ed.flush();
    if (!r.ok) { C.toast(`JSON error line ${r.line}, col ${r.col}: ${r.error}`, 'error'); return null; }
    if (!isPlain(r.value)) { C.toast('The definition must be a JSON object', 'error'); return null; }
    return r.value;
  };
  const renderVerdict = (res) => {
    clear(verdictBox); verdictBox.hidden = false;
    const v = res.verdict;
    const head = h('div', { class: 'au-bar' }, pill(res.ok ? 'ok' : 'error', res.ok ? 'schema ok' : 'invalid'),
      v ? pill(v, `verdict: ${v}`) : null, res.score != null ? h('span', { class: 'au-hint', text: `score ${res.score}` }) : null);
    let summary = null, details = null;
    const rep = res.report;
    if (typeof rep === 'string') summary = h('div', { class: 'au-hint', text: rep });
    else if (rep != null) {
      const s = rep.summary || rep.text || rep.message;
      if (s) summary = h('div', { class: 'au-hint', text: typeof s === 'string' ? s : JSON.stringify(s) });
      details = h('details', {}, h('summary', { text: 'Full report' }), h('pre', { text: fmt(rep, 72) }));
    }
    const why = v === 'reject' ? h('div', { text: 'A rejected definition cannot be published — rebalance it first.' })
      : v === 'nerf' || v === 'boost' ? h('div', { class: 'au-hint', text: `The rebalancing check says this ${kind} needs a ${v}; it can still be published.` }) : null;
    add(verdictBox, [head, summary, why, errList(res.errors), details]);
  };
  const renderPublish = (res, d) => {
    clear(pubBox); pubBox.hidden = false;
    const ref = res.ref || {};
    const pub = res.publish || {};
    const retry = h('button', { class: 'au-btn', type: 'button', text: 'Retry publish' });
    retry.addEventListener('click', () => busy(retry, async () => {
      const r = await C.api('definitions/retry', { method: 'POST', body: { kind, id: ref.id || d.id } });
      renderPublish({ ...res, ...(r || {}), ref: (r && r.ref) || ref, publish: (r && r.publish) || r || {} }, d);
      C.toast(r && r.publish && r.publish.state === 'published' ? 'Published' : `Still pending${r && r.publish && r.publish.error ? `: ${r.publish.error}` : ''}`,
        r && r.publish && r.publish.state === 'published' ? 'ok' : 'error');
    }));
    add(pubBox, [
      h('div', { class: 'au-bar' }, h('b', { text: 'Committed' }), pill(pub.state || 'unknown', pub.state || 'unknown')),
      h('div', { class: 'au-mono', text: `${ref.repo || '?'}  ${ref.branch || '?'}  @${short(ref.commit)}` }),
      pub.state === 'pending' ? [
        h('div', { text: `The commit is saved on ${teamName()}'s branch, but it could not be announced to the seed yet${pub.error ? ` (${pub.error})` : ''}. Other nodes will not see it until it is published — retry when the node is online.` }),
        h('div', { class: 'au-bar' }, retry)] : null,
    ]);
  };

  validateBtn.addEventListener('click', async () => {
    const d = readDef(); if (!d) return;
    const text = ed.text();
    inFlight = true; refresh();
    const res = await busy([validateBtn, publishBtn], () => C.api('validate', { method: 'POST', body: { kind, def: d } }));
    inFlight = false;
    if (res) { validated = { text, ok: !!res.ok, verdict: res.verdict }; renderVerdict(res); }
    refresh();
  });
  publishBtn.addEventListener('click', async () => {
    const d = readDef(); if (!d) return;
    const text = ed.text();
    inFlight = true; refresh();
    const body = { kind, def: d };
    if (msgIn.value.trim()) body.message = msgIn.value.trim();
    const res = await busy([validateBtn, publishBtn], () => C.api('definitions', { method: 'POST', body }));
    inFlight = false;
    if (res && res.ok !== false) {
      savedText = text;
      renderPublish(res, d);
      C.toast(`${d.id} committed on ${(res.ref && res.ref.branch) || 'the team branch'} — ${(res.publish && res.publish.state) || 'unknown'}`,
        res.publish && res.publish.state === 'published' ? 'ok' : 'info');
    } else if (res) {
      C.toast(res.error || 'Publishing was refused', 'error');
      if (res.errors) renderVerdict({ ok: false, errors: res.errors, verdict: res.verdict });
    }
    refresh();
  });

  const pub = (C.session && C.session.publish) || {};
  let sh = null;
  sh = sheet(key || `def:${kind}:${def.id}`, title || `New ${KIND_LABEL[kind]}`, [
    h('div', { class: 'au-hint', text: `A new ${kind} is validated (schema + rebalancing), then committed on ${teamName()}'s branch players/${team().slug || '<team>'}/<name> of the ${kind}s repo and announced to the seed. It never touches main.` }),
    pub.ready === false ? h('div', { class: 'au-hint', text: `Publishing is not ready on this node${pub.why ? `: ${pub.why}` : ''} — the commit will stay pending until it is.` }) : null,
    h('div', { class: 'au-row' }, h('label', { for: idIn.id, text: 'id' }), idIn, idErr),
    h('div', { class: 'au-row' }, h('label', { for: nameIn.id, text: 'Name' }), nameIn),
    h('div', { class: 'au-sec', text: 'Definition JSON' }), ed.el,
    renderHints(hints),
    h('div', { class: 'au-row' }, h('label', { for: msgIn.id, text: 'Commit message' }), msgIn),
    h('div', { class: 'au-bar' }, validateBtn, publishBtn, h('span', { class: 'au-grow' }), closeButton(() => sh)),
    verdictBox, pubBox,
  ], { wide: true, dirty: () => ed.text() !== (savedText != null ? savedText : initialText) });
  refresh();
  return sh;
}

async function openNew(kind) {
  if (!loggedIn()) { openSignIn(); return; }
  const key = `new:${kind}`;
  if (sheets.get(key) && sheets.get(key).isConnected) return;
  let t;
  try { t = await template(kind); } catch (e) { C.toast(errText(e), 'error'); return; }
  const def = clone(t.def);
  const id = `${kind}_${idSlug(teamName())}_new_${kind}`;
  const ordered = { schema: def.schema || FOREIGN_SCHEMA[kind], id, ...def };
  ordered.id = id;
  openDefEditor({ kind, def: ordered, hints: t.hints, title: `New ${kind}`, key });
}

/** Detail-pane node for a route (app.js shows a returned Node with its data-title). */
function pane(title, kids) { return h('div', { class: 'au-form', 'data-title': title }, kids); }

function signInPane() {
  openSignIn();
  return pane('Sign in to author', [h('p', { text: 'Authoring needs your team identity — see "How to sign in".' }),
    h('div', { class: 'au-bar' }, h('button', { class: 'au-btn', type: 'button', text: 'How to sign in', onclick: openSignIn }))]);
}

/** #/new/[<kind>] — no kind: the chooser; a kind: open the editor sheet + a pane to reopen it. */
function routeNew(rest) {
  if (!loggedIn()) return signInPane();
  const kind = String(rest || '').replace(/^\/+|\/+$/g, '');
  if (KINDS.includes(kind)) {
    openNew(kind);
    return pane(`New ${kind}`, [
      h('p', { class: 'au-hint', text: `The ${kind} editor is open in a sheet. Closed it? Open it again here — unsaved text is not kept.` }),
      h('div', { class: 'au-bar' },
        h('button', { class: 'au-btn au-primary', type: 'button', text: `Open the ${kind} editor`, onclick: () => openNew(kind) }),
        h('button', { class: 'au-btn', type: 'button', text: 'My team\'s definitions', onclick: () => C.navigate('#/mine') })),
    ]);
  }
  const kinds = [].concat((C.session && C.session.kinds) || KINDS).filter((k) => KINDS.includes(k));
  return pane('New skill / effect / class', [
    h('p', { class: 'au-hint', text: 'Start from the minimal valid template of a kind, or open a built-in skill / effect / class and use "Fork as new …".' }),
    h('div', { class: 'au-kinds' }, kinds.map((k) => h('button', { class: 'au-btn', type: 'button', text: `New ${k}`,
      onclick: () => C.navigate(`#/new/${k}`) }))),
    h('div', { class: 'au-bar' }, h('button', { class: 'au-btn', type: 'button', text: 'Generate from a description…', onclick: () => C.navigate('#/gen/effect') })),
  ]);
}

async function openFork(c, entry) {
  const kind = C.kindOfCollection(c);
  if (!kind) return;
  let src, t = null;
  try {
    [src, t] = await Promise.all([C.getDefinition(kind, entry.id), template(kind).catch(() => null)]);
  } catch (e) { C.toast(errText(e), 'error'); return; }
  if (!isPlain(src)) { C.toast(`No definition file for ${entry.id}`, 'error'); return; }
  const def = forkDefinition(kind, src, t && t.def, forkId(kind, entry.id, teamName()));
  openDefEditor({ kind, def, hints: t && t.hints, title: `Fork ${entry.id} as new ${kind}`, key: `fork:${kind}:${entry.id}` });
}

// ---------------------------------------------------------------- my team's definitions

/** #/mine — rendered into the detail pane (returned Node). */
async function openMine() {
  if (!loggedIn()) return signInPane();
  const list = h('div', { class: 'au-list' });
  const reload = h('button', { class: 'au-btn', type: 'button', text: 'Reload' });
  const load = () => busy(reload, async () => {
    const r = await C.api('definitions/mine');
    const items = Array.isArray(r) ? r : [].concat((r && (r.definitions || r.items || r.mine)) || []);
    clear(list);
    if (!items.length) list.appendChild(h('div', { class: 'au-hint', text: `${teamName()} has not published any definitions yet.` }));
    for (const it of items) list.appendChild(mineItem(it));
  });
  const mineItem = (it) => {
    const p = it.publish || {};
    const state = typeof p === 'string' ? p : p.state || 'unknown';
    const meta = h('div', { class: 'au-meta au-mono', text: `${it.branch || '?'} @${short(it.commit)}${p.error ? ` — ${p.error}` : ''}` });
    const retry = h('button', { class: 'au-btn', type: 'button', text: 'Retry' });
    retry.addEventListener('click', () => busy(retry, async () => {
      const r = await C.api('definitions/retry', { method: 'POST', body: { kind: it.kind, id: it.id } });
      const np = (r && r.publish) || {};
      C.toast(np.state === 'published' ? `${it.id} published` : `Still pending${np.error ? `: ${np.error}` : ''}`, np.state === 'published' ? 'ok' : 'error');
      await load();
    }));
    const open = h('button', { class: 'au-btn', type: 'button', text: 'Open' });
    open.addEventListener('click', async () => {
      const d = isPlain(it.def) ? it.def : isPlain(it.definition) ? it.definition : null;
      if (!d) { C.toast(`The node did not return the definition; it is at ${it.repo || it.kind + 's repo'} ${it.branch || ''} @${short(it.commit)}`, 'info'); return; }
      let t = null; try { t = await template(it.kind); } catch { /* hints only */ }
      openDefEditor({ kind: it.kind, def: clone(d), hints: t && t.hints, title: `Edit ${it.id}`, key: `def:${it.kind}:${it.id}` });
    });
    return h('div', { class: 'au-item' }, h('b', { text: it.kind || '?' }), h('span', { class: 'au-mono', text: it.id || '?' }),
      pill(state, state), meta, h('div', { class: 'au-bar', style: 'grid-column:1/-1' }, open, state === 'pending' ? retry : null));
  };
  reload.addEventListener('click', load);
  await load();
  return pane(`${teamName()}'s definitions`, [
    h('p', { class: 'au-hint', text: `Skills, effects and classes ${teamName()} committed on its players/${team().slug || '<team>'}/… branches.` }),
    list, h('div', { class: 'au-bar' }, reload,
      h('button', { class: 'au-btn', type: 'button', text: 'New skill / effect / class', onclick: () => C.navigate('#/new/') })),
  ]);
}

// ---------------------------------------------------------------- registration

function once(id, fn) { if (!registered.has(id)) { registered.add(id); fn(); } }

function installAuthoring() {
  once('au-new', () => C.registerHeaderAction({ id: 'au-new', label: 'New skill / effect / class', icon: '+',
    onClick: () => C.navigate('#/new/') }));
  once('au-mine', () => C.registerHeaderAction({ id: 'au-mine', label: 'My team\'s definitions', icon: '☰',
    onClick: () => C.navigate('#/mine') }));
}

export function initAuthoring(ctx) {
  C = ctx;
  if (typeof document !== 'undefined' && !document.getElementById('au-css')) {
    const st = document.createElement('style');
    st.id = 'au-css';
    st.textContent = AU_CSS;
    document.head.appendChild(st);
  }
  // Entry actions + routes always; `when` / handlers check the live session (a Re-check can log in later).
  once('au-propose', () => C.registerEntryAction({ id: 'au-propose', label: 'Propose a change',
    when: (c, entry) => isProposable(c, entry), onClick: (c, entry) => openProposal(c, entry) }));
  for (const k of KINDS) {
    once(`au-fork-${k}`, () => C.registerEntryAction({ id: `au-fork-${k}`, label: `Fork as new ${k}`,
      when: (c, entry) => loggedIn() && C.kindOfCollection(c) === k && !!entry && !!entry.id,
      onClick: (c, entry) => openFork(c, entry) }));
  }
  C.registerRoute('#/new/', routeNew);
  C.registerRoute('#/new', routeNew);
  C.registerRoute('#/mine', () => openMine());
  if (loggedIn()) installAuthoring();
  else once('au-signin', () => C.registerHeaderAction({ id: 'au-signin', label: 'How to sign in', icon: '?', always: true,
    onClick: openSignIn }));
}
