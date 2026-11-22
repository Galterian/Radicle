// Card renderers of the rules editor — one per collection (ported from the old monolithic editor.html, read-only),
// plus the prose formatter and the pills. A renderer gets the active version's `data` and a helper `r`; it marks the
// data keys it showed with r.use(...) so the card can list the remaining keys once, generically, below it.
import { el, prettyId } from './util.js';

/* ------------------------------------------------------------------ prose */
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Plain-text rule body → HTML: blank lines = paragraphs; "- " / "* " lines = bullets; a leading "Tileset." /
// "Part A — …." = sub-heading; a paragraph of 2+ sentences = a bullet per sentence; "Term = …" / "Term: …" = term.
export function formatProse(text) {
  if (!text) return '';
  const out = [];
  for (const p of String(text).split(/\n\s*\n+/).map(x => x.trim()).filter(Boolean)) {
    let body = p;
    const sub = body.match(/^((?:Part|Phase)\s+[A-Z]\s*[—–-]\s*[^.\n]+?\.|[A-Z][A-Za-z &/'-]{1,40}\.)\s+/);
    if (sub && body.length > sub[0].length + 10) {
      out.push('<h4 class="subhead">' + escapeHtml(sub[1].replace(/\.$/, '')) + '</h4>');
      body = body.slice(sub[0].length);
    }
    let bullets = [];
    const flush = () => { if (bullets.length) { out.push('<ul>' + bullets.map(l => '<li>' + inlineProse(l) + '</li>').join('') + '</ul>'); bullets = []; } };
    for (const l of body.split(/\n/).map(x => x.trim()).filter(Boolean)) {
      if (/^[-*•]\s+/.test(l)) { bullets.push(l.replace(/^[-*•]\s+/, '')); continue; }
      const sentences = splitSentences(l);
      if (sentences.length >= 2) bullets.push(...sentences);
      else { flush(); out.push('<p>' + inlineProse(l) + '</p>'); }
    }
    flush();
  }
  return out.join('');
}
function splitSentences(text) {
  const PROTECT = '\u0002', SPLIT = '\u0001';
  let s = text.trim().replace(/\b(e\.g|i\.e|etc|cf|vs|Mr|Mrs|Dr|Fig|No|Rule \d+|Σ)\./g, '$1' + PROTECT);
  s = s.replace(/([.!?])\s+(?=[A-ZΣ"'(—–])/g, '$1' + SPLIT).replace(new RegExp(PROTECT, 'g'), '.');
  return s.split(SPLIT).map(x => x.trim()).filter(Boolean);
}
function inlineProse(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+?)`/g, '<code class="inline">$1</code>')
    .replace(/^([A-Z][A-Za-z0-9 /'’-]{2,40})\s*=\s*/, '<strong class="term">$1</strong> = ')
    .replace(/^([A-Z][A-Za-z0-9 /'’-]{2,40}):\s+(?=\S{5,})/, '<strong class="term">$1</strong>: ')
    .replace(/^(Example|Note|NOTE)\s*[:.]\s+/, '<em class="aside">$1:</em> ');
}
export const prose = (text) => el('div', { class: 'prose', html: formatProse(text) });

/* ------------------------------------------------------------------ pills */
const elementSlug = (id) => String(id || '').replace(/^elem_/, '');
export const pillEl = (id) => el('span', { class: `pill el el-${elementSlug(id)}` }, elementSlug(id));
export const pillTag = (text, cls = '') => el('span', { class: `pill tag ${cls}` }, String(text));
export const pillLink = (id) => el('a', { class: 'pill link', href: '#/id/' + encodeURIComponent(id) }, id);
const STATUS = ['canonical', 'proposal', 'superseded', 'resolved', 'rejected'];
export const statusPill = (status) => el('span', { class: `pill status status-${STATUS.includes(status) ? status : 'other'}` }, status || '—');
const ACTION_NAMES = { A: 'Attack', B: 'Block', M: 'Move', P: 'Posture', EP: 'Empty Posture', EM: 'Empty Move' };
export const pillAction = (code) => el('span', { class: `pill act act-${code}`, title: `${code} — ${ACTION_NAMES[code] || 'action'}` }, ACTION_NAMES[code] || code);
const comboBadge = (codes) => el('span', { class: 'combo' }, (codes || []).map((c, i) => [i ? el('span', { class: 'combo-arrow' }, '→') : null, pillAction(c)]));
export const pillRow = (label, ...pills) => el('div', { class: 'pill-row' }, label ? el('span', { class: 'lbl' }, label) : null, ...pills);
const comboRow = (label, codes) => pillRow(label, comboBadge(codes));
// "BAAPM" → ['B','A','A','P','M'] with EP / EM as one token.
function splitActionCodes(s) {
  const out = [];
  for (let i = 0; i < s.length;) {
    if (s[i] === 'E' && (s[i + 1] === 'P' || s[i + 1] === 'M')) { out.push(s.slice(i, i + 2)); i += 2; } else out.push(s[i++]);
  }
  return out;
}

const STAT_NAMES = { vitality: 'Vitality', world: 'World', matter: 'Matter', will: 'Will' };
export const statsRow = (stats) => el('div', { class: 'stats-row' },
  Object.keys(STAT_NAMES).map(k => el('div', { class: `stat-cell ${k}` }, el('div', { class: 'stat-label' }, STAT_NAMES[k]), el('div', { class: 'stat-val' }, stats?.[k] ?? 0))));

/* ------------------------------------------------------------------ RPS grid */
export function rpsGrid(matrix) {
  const codes = ['A', 'B', 'M', 'P', 'EP'];
  const N = { A: 'Attack', B: 'Block', M: 'Move', P: 'Posture', EP: 'Empty Posture' };
  const legend = el('div', { class: 'rps-legend', html: `
    <p><strong>How to read.</strong> Column = what the <em>actor</em> plays, row = what the <em>defender</em> plays. Cell =
    <span class="rps-swatch win">defender takes N</span> (actor wins), <span class="rps-swatch lose">actor takes N</span>
    (defender wins) or <span class="rps-swatch zero">neutral</span>. The diagonal is a mirror match.</p>` });
  if (matrix.cycle) legend.appendChild(el('p', null, el('strong', null, 'Cycle: '), matrix.cycle));
  const head = el('tr', null, el('th', { class: 'corner' }), codes.map(c => el('th', { class: 'col-name' }, N[c])));
  const rows = codes.map(def => el('tr', null, el('th', { class: 'row-name' }, N[def]), codes.map(act => {
    let cls = 'zero', label = 'neutral', note = `${N[act]} vs ${N[def]}: neutral.`;
    if (act === def) { cls = 'diag'; label = 'mirror'; note = `Both play ${N[act]}: mirror match.`; }
    else {
      const edge = (matrix.edges || []).find(e => e.actor === act && e.defender === def);
      const bonus = edge ? edge.bonus_damage_to_actor : 0;
      if (bonus > 0) { cls = 'win'; label = `defender takes ${bonus}`; note = `${N[act]} beats ${N[def]} — defender takes ${bonus} damage.`; }
      else if (bonus < 0) { cls = 'lose'; label = `actor takes ${-bonus}`; note = `${N[def]} beats ${N[act]} — actor takes ${-bonus} damage.`; }
    }
    // The sentence is shown under the table on tap (no hover-only info).
    return el('td', { class: cls, title: note, onclick: (ev) => { const n = ev.currentTarget.closest('.rps-container').querySelector('.rps-note'); n.textContent = note; } }, label);
  })));
  return el('div', { class: 'rps-container' }, legend,
    el('div', { class: 'rps-scroll' }, el('div', { class: 'rps-axis-top' }, 'Actor plays →'),
      el('div', { class: 'rps-flex' }, el('div', { class: 'rps-row-axis' }, 'Defender plays ↓'), el('table', { class: 'rps-table' }, el('thead', null, head), el('tbody', null, rows)))),
    el('div', { class: 'rps-note muted' }, 'Tap a cell for the full sentence.'),
    matrix.empty_resolution_rule ? prose(matrix.empty_resolution_rule) : null);
}

/* ------------------------------------------------------------------ per-collection bodies */
// Each returns an array of nodes; r.use(keys…) marks what it showed, r.json(value) renders compact JSON.
const textOf = (d, k, r) => (d[k] !== undefined && d[k] !== null && d[k] !== '' ? (r.use(k), prose(d[k])) : null);
const listOf = (d, k, r, label, pill = pillTag) => ((d[k] || []).length ? (r.use(k), pillRow(label, ...d[k].map(x => pill(x)))) : null);

export const RENDERERS = {
  concept: (d, r) => [textOf(d, 'premise', r), listOf(d, 'pillars', r, 'pillars')],
  stats: (d, r) => {
    r.use('code', 'pillar_role', 'zero_in');
    return [el('div', { class: 'kv-inline' },
      d.code ? pillTag('code ' + d.code) : null, d.pillar_role ? pillTag('role: ' + d.pillar_role) : null,
      (d.zero_in || []).length ? pillTag('zero in: ' + d.zero_in.join(', ')) : null),
    listOf(d, 'elements', r, 'elements', pillEl)];
  },
  elements: (d, r, entry) => [el('div', { class: 'pill-row big' }, pillEl(entry.id), d.stat ? (r.use('stat'), pillTag('stat: ' + d.stat)) : null), textOf(d, 'text', r)],
  rules: (d, r) => [textOf(d, 'text', r), listOf(d, 'cross_refs', r, 'cross refs', pillLink)],
  battle_system: (d, r) => (d.resolution_matrix ? (r.use('resolution_matrix'), [rpsGrid(d.resolution_matrix)]) : []),
  actions: (d, r) => {
    r.use('rps_wins_against', 'rps_loses_against');
    return [textOf(d, 'text', r), pillRow(null,
      (d.rps_wins_against || []).length ? pillTag('beats ' + d.rps_wins_against.join(', '), 'good') : null,
      (d.rps_loses_against || []).length ? pillTag('loses to ' + d.rps_loses_against.join(', '), 'bad') : null)];
  },
  effects: (d, r) => [listOf(d, 'element_cost', r, 'cost', pillEl), listOf(d, 'effect_types', r, 'types'), textOf(d, 'text', r),
    d.every_bonus ? [pillRow('∀ bonus'), textOf(d, 'every_bonus', r)] : null],
  skills: (d, r) => {
    r.use('action_type', 'is_permanent', 'point_buy_stat');
    return [pillRow(null, d.action_type ? pillAction(d.action_type) : pillTag('action: —'), d.is_permanent ? pillTag('permanent') : null,
      d.point_buy_stat ? pillTag('point-buy: ' + String(d.point_buy_stat).replace(/^stat_/, '')) : null), textOf(d, 'text', r)];
  },
  classes: (d, r) => [listOf(d, 'colors', r, 'colors', pillEl), d.ability_kind ? (r.use('ability_kind'), pillRow(null, pillTag('ability: ' + d.ability_kind))) : null, textOf(d, 'text', r)],
  characters: (d, r) => {
    r.use('stats', 'combo', 'adept_element', 'life', 'actions_per_round');
    return [d.stats ? statsRow(d.stats) : null, (d.combo || []).length ? comboRow('combo', d.combo) : null,
      pillRow(null, d.adept_element ? [el('span', { class: 'lbl' }, 'adept'), pillEl(d.adept_element)] : null,
        pillTag('life ' + (d.life ?? '?')), pillTag((d.actions_per_round ?? '?') + ' actions'))];
  },
  creatures: (d, r) => {
    r.use('stats', 'combo', 'dice_pattern', 'life', 'actions_per_round', 'innate_effect', 'on_action_rider');
    const src = d.combo || d.dice_pattern;
    const patterns = src ? (Array.isArray(src) ? [src] : String(src).split('|')).filter(Boolean) : [];
    const rider = d.on_action_rider;
    return [d.stats ? statsRow(d.stats) : null,
      ...patterns.map((p, i) => comboRow(patterns.length > 1 ? `combo ${i + 1}` : 'combo', Array.isArray(p) ? p : splitActionCodes(String(p)))),
      pillRow(null, pillTag('life ' + (d.life ?? '?')), pillTag((d.actions_per_round ?? '?') + ' actions'),
        d.innate_effect ? [el('span', { class: 'lbl' }, 'innate'), pillLink(d.innate_effect)] : null,
        rider ? el('span', { class: 'pill tag' }, `+${rider.bonus_damage} on `, pillAction(rider.action)) : null),
      textOf(d, 'behavior', r)];
  },
  terrain_items: (d, r) => [d.kind ? (r.use('kind'), pillRow('kind', pillTag(d.kind))) : null, textOf(d, 'text', r), textOf(d, 'description', r)],
  contradictions: (d, r) => {
    r.use('evidence');
    const ev = d.evidence || [];
    return [textOf(d, 'description', r), listOf(d, 'source_entries', r, 'sources', pillLink),
      ev.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'evidence' },
        el('tr', null, ['entry', 'stats', 'sum', 'formula', 'printed'].map(h => el('th', null, h))),
        ev.map(x => el('tr', null, el('td', null, x.entry), el('td', null, typeof x.stats === 'object' ? JSON.stringify(x.stats) : x.stats),
          el('td', { class: 'num' }, x.sum), el('td', { class: 'num' }, x.formula_life),
          el('td', { class: 'num' + (x.formula_life !== x.printed_hits ? ' err' : '') }, x.printed_hits))))) : null];
  },
};
// Any collection: a text-like field first, if there is one.
const GENERIC_TEXT = ['text', 'description', 'summary', 'premise', 'behavior', 'purpose'];
export function genericBody(d, r) { const k = GENERIC_TEXT.find(x => typeof d[x] === 'string'); return k ? [textOf(d, k, r)] : []; }

// The remaining data keys, once: scalars inline, scalar lists as pills, long strings as prose, the rest compact JSON.
export function moreFields(d, used, r) {
  const keys = Object.keys(d || {}).filter(k => !used.has(k) && !k.startsWith('_'));
  if (!keys.length) return null;
  return el('dl', { class: 'fields' }, keys.map(k => {
    const v = d[k];
    let val;
    if (v === null || typeof v !== 'object') val = typeof v === 'string' && v.length > 90 ? prose(v) : el('span', { class: 'scalar ' + (v === null ? 'null' : typeof v) }, v === null ? 'null' : String(v));
    else if (Array.isArray(v) && v.every(x => x === null || typeof x !== 'object') && v.join('').length < 400) val = v.length ? pillRow(null, ...v.map(x => (/^(elem_)/.test(x) ? pillEl(x) : pillTag(x)))) : el('span', { class: 'muted' }, '[ ]');
    else val = r.json(v);
    return [el('dt', null, prettyId(k)), el('dd', null, val)];
  }));
}

// logic_rules.json is not a VersionedEntry collection: an entry is { id, name, description, tags, params, logic, examples }.
export function namedRuleBody(entry, r) {
  const params = Object.entries(entry.params || {});
  const ex = entry.examples || [];
  return [entry.description ? prose(entry.description) : null,
    params.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'evidence' }, el('tr', null, el('th', null, 'param'), el('th', null, 'type'), el('th', null, 'default'), el('th', null, 'description')),
      params.map(([k, p]) => el('tr', null, el('td', { class: 'mono' }, k), el('td', null, p?.type ?? ''), el('td', { class: 'mono' }, p?.default === undefined ? '' : JSON.stringify(p.default)), el('td', null, p?.description ?? ''))))) : null,
    ex.length ? [el('h4', { class: 'section-h' }, `Examples (${ex.length})`), el('div', { class: 'examples' }, ex.map(x => el('div', { class: 'example' }, r.json(x.args, 'args'), el('span', { class: 'arrow' }, '⇒'), r.json(x.expect, 'expect'))))] : null];
}
