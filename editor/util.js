// Small shared helpers of the rules editor: DOM builder, version pick (same rule as game/logic-engine.mjs
// activeVersion), a structural diff for the Versions tab, and downloads. No dependencies.

// el('div', { class: 'x', onclick: fn, style: {..} | 'a:b', dataset: {..}, title: '…' }, child, 'text', [more], null)
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class' || k === 'className') node.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  append(node, children);
  return node;
}
function append(node, kids) {
  for (const c of kids) {
    if (c === undefined || c === null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : Number(x) || 0);
const semverParts = (v) => String(v || '0').replace(/^v/, '').split(/[.-]/).map(p => (/^\d+$/.test(p) ? Number(p) : p));
export const semverGt = (a, b) => {
  const pa = semverParts(a), pb = semverParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y;
    return String(x) > String(y);
  }
  return false;
};
// The active version: highest weight among the live ones (not rejected, not superseded); ties → canonical first,
// then latest. Mirrors logic-engine.mjs activeVersion — keep the two in step.
export function activeVersion(entry) {
  let vs = (entry?.versions || []).filter(v => v && v.status !== 'rejected' && v.status !== 'superseded');
  if (!vs.length) vs = (entry?.versions || []).filter(v => v && v.status !== 'rejected');
  if (!vs.length) return entry?.versions?.[0] || null;
  return [...vs].sort((a, b) => (num(b.weight) - num(a.weight)) || ((b.status === 'canonical') - (a.status === 'canonical')) || (semverGt(a.version, b.version) ? -1 : 1))[0];
}

// Structural diff a → b as [{ path, kind: 'added'|'removed'|'changed', before, after }], capped at `limit` rows.
export function diffJson(a, b, limit = 200) {
  const out = [];
  const isObj = (x) => x && typeof x === 'object';
  const walk = (x, y, path) => {
    if (out.length >= limit) return;
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (isObj(x) && isObj(y) && Array.isArray(x) === Array.isArray(y)) {
      const keys = Array.isArray(x) ? [...Array(Math.max(x.length, y.length)).keys()] : [...new Set([...Object.keys(x), ...Object.keys(y)])];
      // Arrays of scalars read better as one change than as per-index noise.
      if (Array.isArray(x) && ![...x, ...y].some(isObj)) { out.push({ path, kind: 'changed', before: x, after: y }); return; }
      for (const k of keys) {
        const p = Array.isArray(x) ? `${path}[${k}]` : (path ? `${path}.${k}` : String(k));
        if (!(k in x)) out.push({ path: p, kind: 'added', after: y[k] });
        else if (!(k in y)) out.push({ path: p, kind: 'removed', before: x[k] });
        else walk(x[k], y[k], p);
        if (out.length >= limit) return;
      }
      return;
    }
    out.push({ path: path || '(value)', kind: x === undefined ? 'added' : y === undefined ? 'removed' : 'changed', before: x, after: y });
  };
  walk(a, b, '');
  return out;
}

export function download(filename, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = el('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const prettyId = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
export const shortId = (id) => (id && id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-4) : id || '');
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
