#!/usr/bin/env node
// editor-jsonfmt-check.mjs — checks for editor/jsonfmt.js (the editor's compact JsonLogic printer).
//   node tools/editor-jsonfmt-check.mjs            run the checks
//   node tools/editor-jsonfmt-check.mjs --show     also print before/after samples
// Round-trips every data/*.json file, every logic block / hook program, every skill / effect / class
// definition and every data/logic_rules.json entry; checks the width limit, the user's golden example,
// parseJsonText error positions and renderJson (via a tiny DOM shim) against formatCompact.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const { formatCompact, parseJsonText, renderJson, reformatJsonText, layoutJson } = await import(path.join(ROOT, 'editor', 'jsonfmt.js').replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, 'file:///'));
const SHOW = process.argv.includes('--show');

let ok = 0;
const fails = [];
const check = (cond, what) => { if (cond) ok++; else { fails.push(what); if (fails.length <= 25) console.log('FAIL', what); } };

// ------------------------------------------------------------------ corpus
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const files = [];
const dataDir = path.join(ROOT, 'data');
for (const f of fs.readdirSync(dataDir)) if (f.endsWith('.json')) files.push(path.join(dataDir, f));
for (const d of ['game/skills-data/skills', 'game/effects-data/effects', 'game/classes-data/classes']) {
  const dir = path.join(ROOT, d);
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) files.push(path.join(dir, f));
}
// logic blocks: every value under a `logic` key, every hook program under `hooks`, every logic_rules entry logic
const blocks = [];
const collect = (v, where) => {
  if (!v || typeof v !== 'object') return;
  if (Array.isArray(v)) { v.forEach((c, i) => collect(c, `${where}[${i}]`)); return; }
  for (const [k, c] of Object.entries(v)) {
    if (k === 'logic' && c && typeof c === 'object') blocks.push({ where: `${where}.logic`, v: c });
    else if (k === 'hooks' && c && typeof c === 'object' && !Array.isArray(c)) for (const [h, p] of Object.entries(c)) if (p && typeof p === 'object') blocks.push({ where: `${where}.hooks.${h}`, v: p });
    collect(c, `${where}.${k}`);
  }
};
const docs = files.map(f => ({ f: path.relative(ROOT, f), v: readJson(f) }));
for (const d of docs) collect(d.v, d.f);
for (const e of readJson(path.join(dataDir, 'logic_rules.json')).entries || []) blocks.push({ where: `logic_rules:${e.id}`, v: e });

// ------------------------------------------------------------------ width rule
// A line may exceed the width only because of unsplittable strings (blank them → it fits) or because the
// nesting is deeper than the width allows (indent ≥ 60% of the width: the leaf and its hugging closers
// cannot move left). Deep lines are counted and reported, not failed.
let deepLines = 0;
const overWidth = (text, width) => text.split('\n').filter(l => {
  if (l.length <= width) return false;
  const blank = l.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (blank.length <= width) return false;
  // the run of hugging closers of a deep node (`… ] } ] } ] },`) or a deep indent
  if (blank.replace(/[\s\]},]+$/, '').length <= width || l.length - l.trimStart().length >= 0.6 * width) { deepLines++; return false; }
  return true;
});

// ------------------------------------------------------------------ round trips
let overflowLines = 0;
for (const width of [80, 60, 120]) {
  for (const d of docs) {
    const t = formatCompact(d.v, { width });
    check(isDeepStrictEqual(JSON.parse(t), d.v), `round-trip ${d.f} @${width}`);
    const bad = overWidth(t, width);
    check(bad.length === 0, `width ${d.f} @${width}: ${bad[0]}`);
    if (width === 80) overflowLines += t.split('\n').filter(l => l.length > width).length;
    check(!/[ \t]+$/m.test(t), `no trailing spaces ${d.f} @${width}`);
  }
  for (const b of blocks) {
    const t = formatCompact(b.v, { width });
    check(isDeepStrictEqual(JSON.parse(t), b.v), `round-trip ${b.where} @${width}`);
    check(overWidth(t, width).length === 0, `width ${b.where} @${width}`);
  }
}
check(formatCompact({ a: 1 }, { indent: 4 }) === '{"a": 1}', 'indent option, short');
for (const v of [null, 0, -1.5, 'x', true, [], {}, [[]], [{}], { a: [] }, ' "\\', [1, [2, [3, [4, [5, [6]]]]]]])
  check(isDeepStrictEqual(JSON.parse(formatCompact(v, { width: 10 })), v), `round-trip edge ${JSON.stringify(v)}`);

// ------------------------------------------------------------------ golden: the user's example
const example = { sequence: [
  { cat: [{ var: 'body-xhtml' }] },
  { 'regex-replace': [{ var: '' }, '&(?!(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#x[0-9A-Fa-f]+);)', '&amp;', []] },
  { 'regex-replace': [{ var: '' }, '<(?![A-Za-z/!?])', '&lt;', []] }] };
const golden = [
  '"rule": { "sequence": [ {"cat": [{"var": "body-xhtml"}]},',
  '    { "regex-replace": [ {"var": ""},',
  '        "&(?!(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#x[0-9A-Fa-f]+);)",',
  '        "&amp;",',
  '        [] ] },',
  '    {"regex-replace": [{"var": ""}, "<(?![A-Za-z/!?])", "&lt;", []]} ] }'].join('\n');
const got = formatCompact(example, { key: 'rule' });
check(got === golden, 'golden: user example (width 80, key "rule")');
if (got !== golden || SHOW) console.log(`--- golden (got)\n${got}\n---`);
check(isDeepStrictEqual(JSON.parse(formatCompact(example)), example), 'golden value round-trips');
// small things stay on one line, scalar arrays pack
check(formatCompact({ var: 'x' }) === '{"var": "x"}', 'one-line var');
check(formatCompact({ '+': [1, { var: 'a' }] }) === '{"+": [1, {"var": "a"}]}', 'one-line op');
const packed = formatCompact(Array.from({ length: 40 }, (_, i) => `tag_${i}`), { width: 60 });
check(packed.split('\n').length < 12 && packed.split('\n').every(l => l.length <= 60), 'scalar array packs per line');
// too complex for one line even when it fits
const deep = { and: [{ '>': [{ var: 'a' }, 1] }, { '<': [{ var: 'b' }, 2] }, { '==': [{ var: 'c' }, 3] }] };
check(formatCompact(deep, { width: 200 }).includes('\n'), 'complex node breaks although it fits');

// ------------------------------------------------------------------ line counts
let before = 0, after = 0;
for (const b of blocks) { before += JSON.stringify(b.v, null, 2).split('\n').length; after += formatCompact(b.v).split('\n').length; }
const rules = (readJson(path.join(dataDir, 'logic_rules.json')).entries || []).filter(e => e.logic).slice(0, 4);
const ruleCounts = rules.map(e => `${e.id} ${JSON.stringify(e.logic, null, 2).split('\n').length}→${formatCompact(e.logic).split('\n').length}`);
check(after < before, 'compact has fewer lines than pretty-print');

// ------------------------------------------------------------------ parseJsonText
const perr = (text, line, col, what) => {
  const r = parseJsonText(text);
  check(!r.ok && r.line === line && r.col === col, `parse error ${what}: want ${line}:${col}, got ${r.ok ? 'ok' : `${r.line}:${r.col} (${r.error})`}`);
};
check(parseJsonText('{"a": [1, 2]}').ok && parseJsonText(' [1] ').value[0] === 1, 'parse ok');
perr('{"a": 1,}', 1, 9, 'trailing comma');
perr('{\n  "a": 1\n  "b": 2\n}', 3, 3, 'missing comma');
perr('[1, 2', 1, 6, 'unexpected end');
perr('{"a": tru}', 1, 7, 'bad literal');
// the engine-independent scanner (Safari path): patch JSON.parse to throw a position-less message
{
  const real = JSON.parse;
  JSON.parse = (s) => { try { return real(s); } catch { throw new SyntaxError('JSON Parse error: Unexpected identifier'); } };
  try {
    perr('{"a": 1,}', 1, 9, 'scan: trailing comma');
    perr('{\n  "a": 1\n  "b": 2\n}', 3, 3, 'scan: missing comma');
    perr('[1, 2', 1, 6, 'scan: unexpected end');
    perr('{"a": tru}', 1, 7, 'scan: bad literal');
    perr('["x\ny"]', 1, 4, 'scan: raw newline in string');
  } finally { JSON.parse = real; }
}
{
  const r = reformatJsonText('{"var":"x"}');
  check(r.ok && r.text === '{"var": "x"}', 'reformatJsonText');
}

// ------------------------------------------------------------------ renderJson with a DOM shim
class Node_ { constructor() { this.childNodes = []; this.parentNode = null; } appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(s) { this.childNodes = [new Text_(s)]; } }
class Text_ extends Node_ { constructor(s) { super(); this.data = s; } get textContent() { return this.data; } }
class El_ extends Node_ {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.className = ''; this.attrs = {}; this.listeners = {}; }
  get classList() { const el = this; const list = () => el.className.split(/\s+/).filter(Boolean);
    return { contains: (c) => list().includes(c), toggle(c, force) { const has = list().includes(c); const want = force === undefined ? !has : force;
      el.className = want ? [...list().filter(x => x !== c), c].join(' ') : list().filter(x => x !== c).join(' '); return want; } }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  querySelectorAll(sel) { const cls = sel.replace(/^\./, ''); const out = []; const walk = (n) => { for (const c of n.childNodes) if (c instanceof El_) { if (c.classList.contains(cls)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
globalThis.document = { createElement: (t) => new El_(t), createTextNode: (s) => new Text_(s) };
let renders = 0;
for (const b of blocks.filter((_, i) => i % 7 === 0)) {
  const pre = renderJson(b.v, { width: 80 });
  check(pre.className === 'jf' && pre.tagName === 'PRE' && pre.textContent === formatCompact(b.v), `render textContent ${b.where}`);
  renders++;
}
{
  const pre = renderJson(example, { width: 80 });
  const kinds = new Set(); const walk = (n) => { for (const c of n.childNodes) if (c instanceof El_) { kinds.add(c.className.split(' ')[0]); walk(c); } }; walk(pre);
  for (const k of ['jf-op', 'jf-str', 'jf-punc', 'jf-n', 'jf-tog', 'jf-sum', 'jf-body']) check(kinds.has(k), `render has ${k}`);
  const n = pre.querySelectorAll('.jf-n');
  check(n.length === 2 && n[0].childNodes[1].getAttribute('data-sum') === '{ "sequence": … }', 'fold groups + summary');
  const tog = n[1].childNodes[0];
  pre.listeners.click[0]({ target: tog });
  check(n[1].classList.contains('jf-folded') && pre.textContent === formatCompact(example), 'click folds, text keeps all data');
  pre.listeners.click[0]({ target: tog });
  check(!n[1].classList.contains('jf-folded'), 'click unfolds');
  const folded = renderJson(example, { collapsedDepth: 0 });
  check(folded.querySelectorAll('.jf-folded').length === 2, 'collapsedDepth 0 folds all');
  check(!/document/.test(String(layoutJson)), 'layout has no DOM dependency');
}
delete globalThis.document;

// ------------------------------------------------------------------ report
if (SHOW) {
  const pick = (re) => blocks.find(b => re.test(b.where));
  for (const re of [/skill_bluff\.json\.hooks\.negate_action/, /effect_summoning\.json\.logic$/, /class_prophet\.json\.hooks\.contact/]) {
    const b = pick(re); if (!b) continue;
    console.log(`--- ${b.where}  (${JSON.stringify(b.v, null, 2).split('\n').length} pretty lines → ${formatCompact(b.v).split('\n').length})\n${formatCompact(b.v)}`);
  }
}
console.log(`corpus: ${docs.length} files, ${blocks.length} logic blocks; renders checked: ${renders}; lines over 80 in files: ${overflowLines} (long strings; ${deepLines} lines over all widths are deep nesting)`);
console.log(`logic blocks: ${before} pretty-printed lines → ${after} compact lines (${Math.round(100 - 100 * after / before)}% fewer)`);
console.log(`logic_rules samples: ${ruleCounts.join(', ')}`);
if (fails.length) { console.log(`${fails.length} jsonfmt check(s) FAILED (${ok} ok)`); process.exit(1); }
console.log(`all jsonfmt checks passed (${ok} ok)`);
