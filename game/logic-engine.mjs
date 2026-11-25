// Logic engine for the Dimensions data layer.
//
// One JsonLogic vocabulary for all the game logic: every entry in data/*.json
// carries a `logic` block (prerequisites / effects / validation) next to its
// `data`, and anything shared between entries lives once in
// data/logic_rules.json as a named rule. This module
//   • loads the data layer and the named rules,
//   • registers the custom operations the vocabulary needs on json-logic-js,
//   • expands {"rule": [id, params]} references (macro expansion with
//     {"param": name} substitution) and {"entry": [id, path]} catalog lookups,
//   • evaluates logic against a context,
//   • validates a proposal (a new version of an entry, or a new entry) —
//     collection-level rules, the canonical version's invariants, the
//     proposal's own self-consistency — and reports every failure,
//   • scores entries with the governance power-score formulas (also JsonLogic).
//
// Pure data in, verdicts out. tools/rebalance.mjs and tools/logic-check.mjs
// sit on top of it; peer.mjs may import `checkPrerequisites` to gate casts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsonLogic from 'json-logic-js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.CHAOS_DATA_DIR || path.resolve(here, '..', 'data');

// Element → stat column (elements.json); mirrors ELEM_TO_STAT in peer.mjs.
export const ELEM_TO_STAT = {
  elem_vitality: 'vitality',
  elem_souls: 'world', elem_time: 'world', elem_space: 'world',
  elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter',
  elem_concentration: 'will', elem_harmony: 'will',
};

// ---------------------------------------------------------------- custom ops
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : Number(x) || 0);
const arr = (x) => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);
export function diceCount(stat) {
  const s = Math.max(0, num(stat));
  let best = 1, bestGap = Infinity;
  for (let n = 1; n <= 10; n++) { const gap = Math.abs(6 * n - s); if (gap < bestGap || (gap === bestGap && n > best)) { best = n; bestGap = gap; } }
  return best;
}
const hexDistance = (a, b) => {
  if (!a || !b) return Infinity;
  const aq = num(a.q ?? a.tile_q), ar = num(a.r ?? a.tile_r), bq = num(b.q ?? b.tile_q), br = num(b.r ?? b.tile_r);
  return Math.max(Math.abs(aq - bq), Math.abs(ar - br), Math.abs((aq + ar) - (bq + br)));
};
const semverParts = (v) => String(v || '0').replace(/^v/, '').split(/[.-]/).map(p => (/^\d+$/.test(p) ? Number(p) : p));
const semverGt = (a, b) => {
  const pa = semverParts(a), pb = semverParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y;
    return String(x) > String(y);
  }
  return false;
};
const typeOf = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);

// Is this value a JsonLogic expression (one key, a known operation) or a literal?
const BUILTIN_OPS = new Set(['==', '===', '!=', '!==', '>', '>=', '<', '<=', '!!', '!', '%', 'log', 'in', 'cat', 'substr', '+', '*', '-', '/', 'min', 'max', 'merge', 'var', 'missing', 'missing_some', 'if', '?:', 'and', 'or', 'filter', 'map', 'reduce', 'all', 'none', 'some']);
const CUSTOM_OPS = new Set(['round_half_up', 'round_div10', 'max0', 'abs', 'floor', 'ceil', 'sum', 'count', 'len', 'includes', 'subset_of', 'distinct', 'keys', 'values', 'stat_sum', 'stat_of', 'dice_count', 'hex_distance', 'semver_gt', 'matches', 'typeof', 'entry', 'rule', 'param', 'root', 'max_of', 'min_of']);
export const isLogic = (v) => {
  if (Array.isArray(v)) return v.some(isLogic);
  if (!v || typeof v !== 'object') return false;
  const k = Object.keys(v);
  return k.length === 1 && (BUILTIN_OPS.has(k[0]) || CUSTOM_OPS.has(k[0]));
};

let opsRegistered = false;
function registerOps(engine) {
  if (opsRegistered) return;
  opsRegistered = true;
  jsonLogic.add_operation('round_half_up', (x) => Math.round(num(x)));
  jsonLogic.add_operation('round_div10', (x) => Math.round(num(x) / 10));
  jsonLogic.add_operation('max0', (x) => Math.max(0, num(x)));
  jsonLogic.add_operation('abs', (x) => Math.abs(num(x)));
  jsonLogic.add_operation('floor', (x) => Math.floor(num(x)));
  jsonLogic.add_operation('ceil', (x) => Math.ceil(num(x)));
  jsonLogic.add_operation('sum', (a) => arr(a).reduce((s, v) => s + num(v), 0));
  jsonLogic.add_operation('count', (a) => (Array.isArray(a) ? a.length : 0));
  jsonLogic.add_operation('len', (x) => (Array.isArray(x) || typeof x === 'string' ? x.length : 0));
  jsonLogic.add_operation('includes', (a, v) => arr(a).includes(v));
  jsonLogic.add_operation('subset_of', (a, allowed) => Array.isArray(a) && a.every(v => arr(allowed).includes(v)));
  jsonLogic.add_operation('distinct', (a) => new Set(arr(a)).size === arr(a).length);
  jsonLogic.add_operation('keys', (o) => (o && typeof o === 'object' ? Object.keys(o) : []));
  jsonLogic.add_operation('values', (o) => (o && typeof o === 'object' ? Object.values(o) : []));
  jsonLogic.add_operation('stat_sum', (st) => num(st?.vitality) + num(st?.world) + num(st?.matter) + num(st?.will));
  jsonLogic.add_operation('stat_of', (unit, el) => { const k = ELEM_TO_STAT[el]; const st = unit?.stats || unit || {}; return k ? num(st[k] ?? unit?.[`stat_${k}`]) : 0; });
  jsonLogic.add_operation('dice_count', diceCount);
  jsonLogic.add_operation('hex_distance', hexDistance);
  jsonLogic.add_operation('semver_gt', semverGt);
  jsonLogic.add_operation('matches', (s, re) => { try { return new RegExp(re).test(String(s ?? '')); } catch { return false; } });
  jsonLogic.add_operation('typeof', typeOf);
  jsonLogic.add_operation('max_of', (a) => (arr(a).length ? Math.max(...arr(a).map(num)) : null));
  jsonLogic.add_operation('min_of', (a) => (arr(a).length ? Math.min(...arr(a).map(num)) : null));
  // {"root": "path"} — read from the ROOT context even inside map/filter/all/none/some,
  // whose bodies only see the current item. Bound per evaluation (Engine#evaluate).
  jsonLogic.add_operation('root', (p) => getPath(engine._ctx, p));
  // Catalog lookup — bound to the engine instance that registered last; the
  // engine re-binds it before every evaluation (see Engine#evaluate).
  jsonLogic.add_operation('entry', (id, p) => engine._catalogLookup(id, p));
  // `rule` never reaches json-logic-js (expanded first); if one slips through, fail loudly.
  jsonLogic.add_operation('rule', (id) => { throw new Error(`unexpanded rule reference: ${id}`); });
}

// ------------------------------------------------------------------ catalog
export function loadCollection(file) {
  const p = path.join(DATA_DIR, file.endsWith('.json') ? file : `${file}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
// The active version: highest weight among the live ones (not rejected, not
// superseded — the same pick as peer.mjs pickActive); ties → canonical first, then latest.
export function activeVersion(entry) {
  let vs = (entry?.versions || []).filter(v => v && v.status !== 'rejected' && v.status !== 'superseded');
  if (!vs.length) vs = (entry?.versions || []).filter(v => v && v.status !== 'rejected');
  if (!vs.length) return entry?.versions?.[0] || null;
  return [...vs].sort((a, b) => (num(b.weight) - num(a.weight)) || ((b.status === 'canonical') - (a.status === 'canonical')) || (semverGt(a.version, b.version) ? -1 : 1))[0];
}
// Serialise like the repo does: 2-space JSON, integer weights as x.0, and the
// file's own line ending (the data files are committed with CRLF).
// JsonLogic is "pseudo-minimised" (user request 2026-10-30): every rule block
// (`{id, description, when|assert|value…}`), every named rule `logic`, every
// `examples` row, `references` / `tags` / `colors` lists and any object under
// a `when` / `assert` / `value` / `logic` key is written on ONE line, so a
// block reads as one rule per line; the surrounding structure keeps the
// 2-space layout and no opening bracket ever sits alone on a line.
const ONE_LINE_KEYS = new Set(['when', 'assert', 'value', 'logic', 'params', 'args', 'rebalance_links', 'vote_log', 'tags', 'colors', 'references', 'element_cost', 'effect_types', 'combo', 'stats', 'requires_permanents', 'dice', 'yields', 'requirement', 'resources']);
const isRuleBlock = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.id === 'string' && ('when' in v || 'assert' in v || 'value' in v || 'expect' in v);
const isExample = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'args' in v && 'expect' in v;
export function compactJson(value, indent = 0, key = null) {
  const pad = ' '.repeat(indent);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (key !== null && ONE_LINE_KEYS.has(key) && key !== 'logic') return oneLine(value);
  if (key === 'logic' && !('description' in value && ('prerequisites' in value || 'effects' in value || 'validation' in value))) return oneLine(value);
  if (isRuleBlock(value) || isExample(value)) return oneLine(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every(v => v === null || typeof v !== 'object')) return oneLine(value);
    return `[\n${value.map(v => `${pad}  ${compactJson(v, indent + 2, null)}`).join(',\n')}\n${pad}]`;
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  return `{\n${keys.map(k => `${pad}  ${JSON.stringify(k)}: ${compactJson(value[k], indent + 2, k)}`).join(',\n')}\n${pad}}`;
}
// One line with a space after `:` and `,` so a long rule still scans (a real
// serialiser, not a regex over the JSON text — descriptions may contain `,{`).
const oneLine = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(oneLine).join(', ')}]`;
  return `{${Object.keys(v).map(k => `${JSON.stringify(k)}: ${oneLine(v[k])}`).join(', ')}}`;
};
export function writeDataFile(file, json) {
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let text = compactJson(json).replace(/("weight(?:_contribution)?": )(-?\d+)(,?)$/gm, '$1$2.0$3') + '\n';
  if (prev.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(file, text);
}
export const getPath = (obj, p) => (p === undefined || p === null || p === '' ? obj : String(p).split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj));

// Effect isolation F9: a collection whose index.json entry names `definitions` is read from the definitions' card
// blocks (defs-collection.mjs), not its data file. Such a collection is authored in its own repo (chaosD6-Effects);
// logic-apply skips it, rebalance check refuses proposals on it.
// Split A (2026-11-25): a collection whose entry names `catalog` (creatures) is read from the compiled GameModels
// catalog (defs-collection.mjs catalogCollection) — authored in chaosD6-GameModels, likewise skipped / refused.
export { definitionsCollection, definitionsDirOf, authoredElsewhere } from './defs-collection.mjs';

import { definitionsCollection, definitionsDirOf, resolveDefinitionsDir, catalogSourceOf, resolveCatalogFile, catalogCollection } from './defs-collection.mjs';

export class LogicEngine {
  constructor({ dataDir = DATA_DIR, collections = null } = {}) {
    this.dataDir = dataDir;
    this.rules = new Map();          // named rules by id
    this.catalog = new Map();        // entry id → { collection, entry }
    this.collections = new Map();    // collection id → file json
    this.index = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
    this.library = JSON.parse(fs.readFileSync(path.join(dataDir, 'logic_rules.json'), 'utf8'));
    for (const r of this.library.entries || []) this.rules.set(r.id, r);
    // logic_rules.json is the vocabulary itself, not a VersionedEntry collection
    const files = (collections || this.index.collections.map(c => c.id)).filter(id => id !== 'logic_rules');
    for (const id of files) {
      const def = definitionsDirOf(this.index, id);
      const dir = def && resolveDefinitionsDir(dataDir, def);
      if (def && !dir) throw new Error(`collection ${id}: definitions directory ${def} not found`);
      const cs = !def && catalogSourceOf(this.index, id), cf = cs && resolveCatalogFile(dataDir, cs.file);
      if (cs && !cf) throw new Error(`collection ${id}: catalog ${cs.file} not found (node tools/gamemodels-build.mjs)`);
      const json = def ? definitionsCollection(id, dir) : cs ? catalogCollection(id, cf, cs.key) : JSON.parse(fs.readFileSync(path.join(dataDir, `${id}.json`), 'utf8'));
      if (!json) throw new Error(`collection ${id}: ${cf} has no "${cs.key}" (rebuild it: node tools/gamemodels-build.mjs)`);
      this.collections.set(id, json);
      for (const e of json.entries || []) this.catalog.set(e.id, { collection: id, entry: e });
    }
    registerOps(this);
  }

  // ---- lookups
  entryOf(id) { return this.catalog.get(id)?.entry || null; }
  collectionOf(id) { return this.catalog.get(id)?.collection || null; }
  activeOf(id) { return activeVersion(this.entryOf(id)); }
  _catalogLookup(id, p) { const v = this.activeOf(id); return v ? getPath(v.data, p) : undefined; }
  // The `entry` context object for an entry (its active version).
  entryContext(id) {
    const rec = this.catalog.get(id);
    if (!rec) return null;
    const v = activeVersion(rec.entry);
    return { id, collection: rec.collection, name: rec.entry.name, tags: rec.entry.tags || [], version: v?.version || null, data: v?.data || {}, logic: v?.logic || null };
  }

  // ---- expansion: {"rule": [id, params]} → the named rule's logic with {"param": x} replaced
  expand(logic, params = {}, depth = 0) {
    if (depth > 32) throw new Error('rule expansion too deep (cycle?)');
    if (Array.isArray(logic)) return logic.map(x => this.expand(x, params, depth));
    if (!logic || typeof logic !== 'object') return logic;
    const keys = Object.keys(logic);
    if (keys.length === 1 && keys[0] === 'param') {
      const name = logic.param;
      if (name in params) return params[name];
      throw new Error(`missing param ${name}`);
    }
    if (keys.length === 1 && keys[0] === 'rule') {
      const [id, args = {}] = Array.isArray(logic.rule) ? logic.rule : [logic.rule, {}];
      const rule = this.rules.get(id);
      if (!rule) throw new Error(`unknown named rule ${id}`);
      const bound = {};
      for (const [pname, spec] of Object.entries(rule.params || {})) {
        if (pname in args) bound[pname] = this.expand(args[pname], params, depth + 1);
        else if (spec && 'default' in spec) bound[pname] = spec.default;
        else throw new Error(`rule ${id}: missing argument ${pname}`);
      }
      for (const pname of Object.keys(args)) if (!(pname in (rule.params || {}))) throw new Error(`rule ${id}: unknown argument ${pname}`);
      return this.expand(rule.logic, bound, depth + 1);
    }
    const out = {};
    for (const k of keys) out[k] = this.expand(logic[k], params, depth);
    return out;
  }

  // ---- evaluation
  evaluate(logic, context = {}) {
    registerOps(this);
    jsonLogic.add_operation('entry', (id, p) => this._catalogLookup(id, p));
    jsonLogic.add_operation('root', (p) => getPath(this._ctx, p));
    this._ctx = context;
    return jsonLogic.apply(this.expand(logic), context);
  }
  // Evaluate a named rule directly with arguments (literals or logic over `context`).
  // json-logic-js reads every object as an operation, so literal objects / arrays
  // of objects go into the context (ctx.__args) and are referenced with `var`.
  rule(id, args = {}, context = {}) {
    const ctx = { ...context, __args: { ...(context.__args || {}) } };
    const wired = {};
    for (const [k, v] of Object.entries(args)) {
      if (isLogic(v)) wired[k] = v;
      else { ctx.__args[k] = v; wired[k] = { root: `__args.${k}` }; }
    }
    return this.evaluate({ rule: [id, wired] }, ctx);
  }
  // Which named rules a logic block references (transitively).
  references(logic, acc = new Set()) {
    if (Array.isArray(logic)) { logic.forEach(x => this.references(x, acc)); return acc; }
    if (!logic || typeof logic !== 'object') return acc;
    if (Object.keys(logic).length === 1 && 'rule' in logic) {
      const [id, args = {}] = Array.isArray(logic.rule) ? logic.rule : [logic.rule, {}];
      if (!acc.has(id)) { acc.add(id); const r = this.rules.get(id); if (r) this.references(r.logic, acc); }
      Object.values(args).forEach(x => this.references(x, acc));
      return acc;
    }
    Object.values(logic).forEach(x => this.references(x, acc));
    return acc;
  }

  // ---- battle-side helpers
  // All prerequisites of an entry hold in this context? → { ok, failed: [{id, description}] }
  checkPrerequisites(entryId, context) {
    const ctx = this.entryContext(entryId);
    const list = ctx?.logic?.prerequisites || [];
    const failed = [];
    for (const p of list) {
      let ok = false;
      try { ok = !!this.evaluate(p.when, { ...context, entry: ctx }); } catch (e) { failed.push({ id: p.id, description: `${p.description || ''} [error: ${e.message}]` }); continue; }
      if (!ok) failed.push({ id: p.id, description: p.description || '' });
    }
    return { ok: failed.length === 0, failed };
  }
  // Compute the entry's outcome values in this context → { [effect id]: value }
  computeEffects(entryId, context) {
    const ctx = this.entryContext(entryId);
    const out = {};
    for (const ef of ctx?.logic?.effects || []) {
      try { out[ef.id] = this.evaluate(ef.value, { ...context, entry: ctx }); } catch (e) { out[ef.id] = { error: e.message }; }
    }
    return out;
  }

  // ---- validation of a proposal
  // proposal: a version object { version, weight?, status?, origin, parent_version, data, logic? }
  // entryId: existing entry (new version) or null with `newEntry` = { id, name, tags } for a new entry.
  validateProposal(collection, entryId, proposal, { newEntry = null } = {}) {
    const failures = [];
    const push = (scope, id, description, error) => failures.push({ scope, id, description, ...(error ? { error } : {}) });
    const entryCtx = entryId ? this.entryContext(entryId) : null;
    if (entryId && !entryCtx) push('catalog', 'unknown_entry', `no entry ${entryId} in ${collection}`);
    if (entryCtx && entryCtx.collection !== collection) push('catalog', 'wrong_collection', `${entryId} lives in ${entryCtx.collection}, not ${collection}`);
    if (!entryId && !newEntry?.id) push('catalog', 'missing_id', 'a new entry needs an id');
    if (newEntry?.id && this.catalog.has(newEntry.id)) push('catalog', 'id_taken', `id ${newEntry.id} already exists (ids are never reused)`);
    if (entryCtx && (entryCtx.entry?.versions || []).some(v => v.version === proposal?.version)) push('governance', 'version_exists', `version ${proposal.version} already exists on ${entryId}`);
    const context = { entry: entryCtx, proposal, collection, new_entry: newEntry };
    // 1. collection-level rules
    const cv = this.library.collection_validation || {};
    for (const rid of [...(cv._all || []), ...(cv[collection] || [])]) {
      const r = this.rules.get(rid);
      if (!r) { push('library', rid, 'collection_validation names an unknown rule'); continue; }
      try { if (!this.evaluate(r.logic, context)) push('collection', rid, r.description || r.name); } catch (e) { push('collection', rid, r.description || r.name, e.message); }
    }
    // 2. the canonical version's invariants (what every new version must keep)
    for (const v of entryCtx?.logic?.validation || []) {
      try { if (!this.evaluate(v.assert, context)) push('entry', v.id, v.description || ''); } catch (e) { push('entry', v.id, v.description || '', e.message); }
    }
    // 3. the proposal's own logic block: must expand, and its validation must hold for itself
    if (proposal?.logic) {
      for (const k of ['prerequisites', 'effects', 'validation']) {
        const list = proposal.logic[k];
        if (!Array.isArray(list)) continue;   // `references` is a plain id list, not items
        for (const item of list) {
          const body = item.when ?? item.value ?? item.assert;
          if (body === undefined) { push('proposal_logic', `${k}:${item.id}`, 'no when/value/assert'); continue; }
          try { this.expand(body); } catch (e) { push('proposal_logic', `${k}:${item.id}`, 'does not expand', e.message); }
        }
      }
      for (const v of proposal.logic.validation || []) {
        try { if (!this.evaluate(v.assert, { ...context, entry: { ...(entryCtx || {}), data: proposal.data, logic: proposal.logic } })) push('proposal_self', v.id, v.description || ''); } catch (e) { push('proposal_self', v.id, v.description || '', e.message); }
      }
    }
    return { ok: failures.length === 0, failures };
  }

  // Every active version passes its own validation + the collection rules (regression over the whole data layer).
  selfCheck() {
    const report = [];
    for (const [id, { collection, entry }] of this.catalog) {
      const v = activeVersion(entry);
      if (!v) continue;
      const proposal = { ...v, version: `${v.version}-selfcheck`, parent_version: v.version, origin: v.origin || 'paper_rules', status: 'proposal' };
      const res = this.validateProposal(collection, id, proposal);
      const failures = res.failures.filter(f => f.id !== 'version_exists');
      if (failures.length) report.push({ id, collection, failures });
    }
    return report;
  }
  // Named-rule examples: each must evaluate to `expect`.
  checkLibrary() {
    const bad = [];
    for (const r of this.rules.values()) {
      for (const ex of r.examples || []) {
        try {
          const got = ex.args ? this.rule(r.id, ex.args, ex.data || {}) : this.evaluate(r.logic, ex.data || {});
          if (JSON.stringify(got) !== JSON.stringify(ex.expect) && !(typeof got === 'number' && typeof ex.expect === 'number' && Math.abs(got - ex.expect) < 1e-9)) bad.push({ rule: r.id, example: ex, got });
        } catch (e) { bad.push({ rule: r.id, example: ex, error: e.message }); }
      }
    }
    return bad;
  }

  // ---- power scores (governance_rebalance_script)
  powerScore(collection, data) {
    const rid = this.library.power_score?.[collection];
    if (!rid) return null;
    const r = this.rules.get(rid);
    if (!r) throw new Error(`power score rule ${rid} missing`);
    const v = this.evaluate(r.logic, { data, collection });
    return typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
  }
  withinTolerance(current, proposal) { return !!this.rule('within_tolerance', { current, proposal }); }
}

let shared = null;
export function engine(opts) { if (!shared || opts) shared = new LogicEngine(opts); return shared; }
export default LogicEngine;
