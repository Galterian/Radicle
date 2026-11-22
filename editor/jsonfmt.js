// jsonfmt.js — compact ("squeezed", not minified) JSON / JsonLogic printer for the rules editor.
//
// User request (2026-11-22): small sub-expressions stay on one line ({"var": "x"}, short operator
// calls); a bigger node opens on its key's line (`{ "regex-replace": [ {"var": ""},`) and puts each
// further argument on its own deeper-indented line; closing brackets hug the last argument (`[] ] },`).
//
// One layout, two outputs: layoutJson() builds a small document (tokens, line breaks, foldable
// groups); formatCompact() flattens it to text, renderJson() turns it into a highlighted <pre>.
// No DOM access at import time — node imports this module for game/tools/editor-jsonfmt-check.mjs.
//
// Layout rules
// - A composite prints on one line when its one-line form (`{"k": v}`, `[a, b]`) fits the remaining
//   width — counting the closers/comma that will follow it on that line — AND it is simple: at most
//   MAX_INNER composite descendants and no object with more than MAX_KEYS keys inside.
// - Single-key object (a JsonLogic operation): `{ "op": <value> }`, the value opens on the key's line.
// - Array: `[ first,` (first item on the opening line when it fits on one line, or when it is the only
//   item), every further item on its own line at the array's child indent; `last ]` hugs.
//   Arrays of scalars pack as many items per line as fit.
// - Multi-key object: `{ "k1": v1,` then each further key on its own line aligned under k1; `vN }`.
// - Child indent = indent per nesting level of the line the node opens on, so `"rule": { "sequence": [`
//   at column 0 puts its arguments at column 4. Strings are never split (JSON can't), so a line
//   overflows only when it carries one unsplittable long string.

const MAX_INNER = 4;   // composite descendants allowed in a one-line node
const MAX_KEYS = 3;    // keys allowed in an object that is printed on one line

const isObj = (v) => v !== null && typeof v === 'object';
const isScalar = (v) => !isObj(v);
const emptyComposite = (v) => isObj(v) && (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);

// One-line form (the same spacing the data layer's compactJson uses: `": "` and `", "`).
function oneLine(v) {
  if (!isObj(v)) return v === undefined ? 'null' : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(oneLine).join(', ')}]`;
  return `{${Object.keys(v).map(k => `${JSON.stringify(k)}: ${oneLine(v[k])}`).join(', ')}}`;
}

// Simple = small enough to read on one line regardless of width.
function isSimple(v) {
  let inner = 0;
  const walk = (x, top) => {
    if (!isObj(x)) return true;
    if (!top && ++inner > MAX_INNER) return false;
    if (Array.isArray(x)) return x.every(c => walk(c, false));
    const ks = Object.keys(x);
    if (ks.length > MAX_KEYS) return false;
    return ks.every(k => walk(x[k], false));
  };
  return walk(v, true);
}

const scalarType = (v) => v === null || v === undefined ? 'null' : typeof v === 'string' ? 'str' : typeof v === 'number' ? 'num' : 'bool';

// ------------------------------------------------------------------ layout
// Document pieces:  {t:'key'|'op'|'str'|'num'|'bool'|'null'|'punc'|'ws', s}  |  {nl: indent}
//                   {g: [pieces], sum: '…' , depth}   (a node printed over several lines; foldable)
export function layoutJson(value, { width = 80, indent = 2, key } = {}) {
  const root = [];
  let out = root;
  let col = 0;
  let lineIndent = 0;
  let onLine = [];   // groups opened on the current physical line and still open: { multi, op }
  const tok = (t, s) => { out.push({ t, s }); col += s.length; };
  const nl = (n) => { out.push({ nl: n }); col = lineIndent = n; onLine = []; };
  const keyTok = (k, op) => tok(op ? 'op' : 'key', JSON.stringify(k));

  // Inline (one-line) emission with token types, mirrors oneLine().
  const inline = (v) => {
    if (!isObj(v)) return tok(scalarType(v), v === undefined ? 'null' : JSON.stringify(v));
    if (Array.isArray(v)) {
      tok('punc', '[');
      v.forEach((c, i) => { if (i) tok('punc', ', '); inline(c); });
      return tok('punc', ']');
    }
    const ks = Object.keys(v);
    tok('punc', '{');
    ks.forEach((k, i) => { if (i) tok('punc', ', '); keyTok(k, ks.length === 1); tok('punc', ': '); inline(v[k]); });
    tok('punc', '}');
  };
  const fitsInline = (v, tail) => isSimple(v) && col + oneLine(v).length + tail <= width;

  // tail = chars that will follow this node on its last line (closers, comma).
  // Child indent comes from the physical line the node opens on: line indent + one level per
  // multi-child node opened on that line (this one included) + one more right under an operator
  // key on that line — `"rule": { "sequence": [` at column 0 → arguments at 4. Single-child nodes
  // never break lines of their own, so chains like `{ "!": [ { "and": [` cost one step, not four.
  const lay = (v, tail, depth) => {
    if (!isObj(v) || emptyComposite(v) || fitsInline(v, tail)) return inline(v);
    const isArr = Array.isArray(v);
    const n = isArr ? v.length : Object.keys(v).length;
    const firstOnLine = col === lineIndent;
    const col0 = col;
    const me = { multi: n > 1, op: !isArr && n === 1 };
    const under = onLine.length ? onLine[onLine.length - 1] : null;
    onLine.push(me);
    const child = lineIndent + indent * (onLine.filter(x => x.multi).length + (under && under.op ? 1 : 0));
    const parent = out;
    const g = { g: [], sum: summary(v), depth };
    parent.push(g);
    out = g.g;
    if (isArr) {
      tok('punc', '[');
      const last = n - 1;
      if (v.every(isScalar)) {
        // pack scalars: as many per line as fit
        v.forEach((c, i) => {
          const s = JSON.stringify(c === undefined ? null : c);
          const need = s.length + (i === last ? 2 + tail : 1);
          if (i === 0 || col + 1 + need <= width) tok('ws', ' ');
          else nl(child);
          tok(scalarType(c), s);
          if (i !== last) tok('punc', ',');
        });
      } else {
        v.forEach((c, i) => {
          const t = i === last ? 2 + tail : 1;
          // the first item shares the opening line when it fits there, when it is the only item,
          // or when the `[` starts its line (never leave a bracket alone on a line)
          if (i === 0 && (n === 1 || firstOnLine || fitsInline(c, t + 1))) tok('ws', ' ');
          else nl(child);
          lay(c, t, depth + 1);
          if (i !== last) tok('punc', ',');
        });
      }
      tok('punc', ' ]');
    } else {
      const ks = Object.keys(v);
      tok('punc', '{ ');
      const last = n - 1;
      ks.forEach((k, i) => {
        if (i) { tok('punc', ','); nl(child); }
        keyTok(k, n === 1);
        tok('punc', ': ');
        lay(v[k], i === last ? 2 + tail : 1, depth + 1);
      });
      // `{ "op": [ … ] }` folds as one node: the operator's argument list gets no toggle of its own
      const lastPiece = out[out.length - 1];
      if (n === 1 && lastPiece && lastPiece.g) out.splice(out.length - 1, 1, ...lastPiece.g);
      tok('punc', ' }');
    }
    const at = onLine.indexOf(me);
    if (at >= 0) onLine.splice(at);
    out = parent;
    // breaking gained no line (a chain of single-child nodes too deep or too long to fit):
    // keep the shorter one-line form; it is not foldable
    if (!g.g.some(hasNl)) { parent.pop(); col = col0; inline(v); }
    return undefined;
  };

  if (key !== undefined) { keyTok(key, false); tok('punc', ': '); }
  lay(value, 0, 0);
  return root;
}
const hasNl = (p) => p.nl !== undefined || (p.g && p.g.some(hasNl));

// Folded form of a node: `{ "op": … }`, `{ "id": …, +3 }`, `[ … 5 ]`.
function summary(v) {
  if (Array.isArray(v)) return `[ … ${v.length} ]`;
  const ks = Object.keys(v);
  if (ks.length === 1) return `{ ${JSON.stringify(ks[0])}: … }`;
  return `{ ${JSON.stringify(ks[0])}: …, +${ks.length - 1} }`;
}

function flatten(pieces, acc = []) {
  for (const p of pieces) {
    if (p.nl !== undefined) acc.push('\n', ' '.repeat(p.nl));
    else if (p.g) flatten(p.g, acc);
    else acc.push(p.s);
  }
  return acc;
}

// ------------------------------------------------------------------ text
export function formatCompact(value, { width = 80, indent = 2, key } = {}) {
  return flatten(layoutJson(value, { width, indent, key })).join('');
}
export function formatCompactLines(value, opts) { return formatCompact(value, opts).split('\n'); }

// Re-format JSON text (textarea "Format" button): → { ok, text } | parse error as parseJsonText.
export function reformatJsonText(text, opts) {
  const r = parseJsonText(text);
  return r.ok ? { ok: true, text: formatCompact(r.value, opts), value: r.value } : r;
}

// ------------------------------------------------------------------ parse with position
export function parseJsonText(text) {
  const src = String(text ?? '');
  try { return { ok: true, value: JSON.parse(src) }; } catch (e) {
    const msg = String(e?.message || e);
    let line, col, m;
    if ((m = /line (\d+) column (\d+)/i.exec(msg))) { line = +m[1]; col = +m[2]; }               // Firefox, new V8
    else if ((m = /position (\d+)/i.exec(msg))) ({ line, col } = lineCol(src, +m[1]));           // V8
    else ({ line, col } = lineCol(src, scanError(src)));                                          // Safari & co.
    return { ok: false, error: msg.replace(/^JSON\.parse: /, ''), line, col };
  }
}
function lineCol(src, pos) {
  pos = Math.max(0, Math.min(pos, src.length));
  let line = 1, start = 0;
  for (let i = 0; i < pos; i++) if (src.charCodeAt(i) === 10) { line++; start = i + 1; }
  return { line, col: pos - start + 1 };
}
// Offset of the first syntax error (a minimal JSON recogniser; only used when the engine gives no position).
function scanError(s) {
  let i = 0;
  const ws = () => { while (i < s.length && ' \t\n\r'.includes(s[i])) i++; };
  const fail = () => { throw i; };
  const lit = (w) => { if (s.startsWith(w, i)) i += w.length; else fail(); };
  const str = () => {
    if (s[i] !== '"') fail();
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s.charCodeAt(i) < 32) fail();
      if (s[i] === '\\') {
        i++;
        if (s[i] === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) fail(); i += 5; continue; }
        if (!'"\\/bfnrt'.includes(s[i]) || i >= s.length) fail();
      }
      i++;
    }
    if (i >= s.length) fail();
    i++;
  };
  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m) fail();
    i += m[0].length;
  };
  const val = () => {
    ws();
    const c = s[i];
    if (c === '{') {
      i++; ws();
      if (s[i] === '}') { i++; return; }
      for (;;) { ws(); str(); ws(); if (s[i] !== ':') fail(); i++; val(); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === '}') { i++; return; } fail(); }
    }
    if (c === '[') {
      i++; ws();
      if (s[i] === ']') { i++; return; }
      for (;;) { val(); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === ']') { i++; return; } fail(); }
    }
    if (c === '"') return str();
    if (c === 't') return lit('true');
    if (c === 'f') return lit('false');
    if (c === 'n') return lit('null');
    return num();
  };
  try { val(); ws(); if (i < s.length) fail(); return s.length; } catch (pos) { return typeof pos === 'number' ? pos : 0; }
}

// ------------------------------------------------------------------ highlighted view
export const JF_CSS = `
.jf{position:relative;margin:0;padding:.5em .75em .5em 1.4em;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;color:var(--jf-fg,inherit);background:var(--jf-bg,transparent)}
.jf .jf-key{color:var(--jf-key,#7cc4ff)}
.jf .jf-op{color:var(--jf-op,#ffb86c);font-weight:600}
.jf .jf-str{color:var(--jf-str,#a6e3a1)}
.jf .jf-num{color:var(--jf-num,#f5a97f)}
.jf .jf-bool{color:var(--jf-bool,#c6a0f6)}
.jf .jf-null{color:var(--jf-null,#8aadf4);font-style:italic}
.jf .jf-punc{color:var(--jf-punc,#939ab7)}
.jf .jf-tog{position:absolute;width:1.2ch;margin-left:-1.2ch;cursor:pointer;user-select:none;-webkit-user-select:none;
  color:var(--jf-punc,#939ab7);text-align:center}
.jf .jf-tog::before{content:"\\25BE"}
.jf .jf-n.jf-folded>.jf-tog::before{content:"\\25B8"}
.jf .jf-sum{display:none;user-select:none;-webkit-user-select:none;color:var(--jf-punc,#939ab7);cursor:pointer}
.jf .jf-sum::before{content:attr(data-sum)}
.jf .jf-n.jf-folded>.jf-sum{display:inline}
.jf .jf-n.jf-folded>.jf-body{display:none}
@media (pointer:coarse){.jf .jf-tog{width:2ch;margin-left:-2ch}}
`;

// <pre class="jf"> from the same layout as formatCompact. Toggle glyphs and fold summaries are CSS-generated
// content, so pre.textContent === formatCompact(value) and copying never picks them up; copying a folded
// view copies the hidden text too (copy handler below). collapsedDepth: nodes at that depth or deeper
// start folded (0 = everything folded, undefined = all open).
export function renderJson(value, { width = 80, indent = 2, collapsedDepth, key } = {}) {
  const doc = document;
  const pre = doc.createElement('pre');
  pre.className = 'jf';
  const build = (pieces, parent) => {
    let text = '';
    const flush = () => { if (text) { parent.appendChild(doc.createTextNode(text)); text = ''; } };
    for (const p of pieces) {
      if (p.nl !== undefined) text += '\n' + ' '.repeat(p.nl);
      else if (p.g) {
        flush();
        const n = doc.createElement('span');
        n.className = 'jf-n' + (collapsedDepth !== undefined && p.depth >= collapsedDepth ? ' jf-folded' : '');
        const tog = doc.createElement('span');
        tog.className = 'jf-tog';
        tog.setAttribute('aria-hidden', 'true');
        const sum = doc.createElement('span');
        sum.className = 'jf-sum';
        sum.setAttribute('data-sum', p.sum);
        const body = doc.createElement('span');
        body.className = 'jf-body';
        build(p.g, body);
        n.appendChild(tog); n.appendChild(sum); n.appendChild(body);
        parent.appendChild(n);
      } else if (p.t === 'ws' || (p.t === 'punc' && /^\s*$/.test(p.s))) text += p.s;
      else {
        flush();
        const s = doc.createElement('span');
        s.className = 'jf-' + p.t;
        s.textContent = p.s;
        parent.appendChild(s);
      }
    }
    flush();
  };
  build(layoutJson(value, { width, indent, key }), pre);
  pre.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.classList || !(t.classList.contains('jf-tog') || t.classList.contains('jf-sum'))) return;
    t.parentNode.classList.toggle('jf-folded');
  });
  pre.addEventListener('copy', (ev) => {
    const sel = doc.getSelection && doc.getSelection();
    if (!sel || !sel.rangeCount || !pre.querySelector('.jf-folded')) return;   // nothing hidden → native copy
    const range = sel.getRangeAt(0);
    if (!pre.contains(range.commonAncestorContainer)) return;
    ev.clipboardData.setData('text/plain', range.cloneContents().textContent);  // hidden bodies included
    ev.preventDefault();
  });
  return pre;
}

// Fold / unfold everything in a rendered view (toolbar buttons).
export function setFolded(pre, folded, minDepth = 0) {
  const nodes = pre.querySelectorAll('.jf-n');
  for (const n of nodes) {
    let d = 0;
    for (let p = n.parentNode; p && p !== pre; p = p.parentNode) if (p.classList && p.classList.contains('jf-n')) d++;
    if (d >= minDepth) n.classList.toggle('jf-folded', folded);
  }
}
