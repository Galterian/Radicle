#!/usr/bin/env node
// Rebalance script — governance_rebalance_script made executable.
//
//   node tools/rebalance.mjs report [collection]           power scores of every active version
//   node tools/rebalance.mjs check <proposal.json>         validate + score a proposal, draft counter-proposals
//   node tools/rebalance.mjs check <proposal.json> --apply append the proposal (+ counters) to data/ as new versions
//   node tools/rebalance.mjs selfcheck                      same as tools/logic-check.mjs (regression)
//
// A proposal file:
//   { "collection": "effects", "entry_id": "effect_fireball",
//     "version": { "version": "1.1.0", "origin": "player_vote", "author_peer_id": "...", "parent_version": "1.0.0",
//                  "notes": "...", "data": { ... }, "logic": { ... optional ... } } }
// or a brand-new entry:
//   { "collection": "effects", "entry": { "id": "effect_x", "name": "X", "tags": [...] }, "version": { ... } }
//
// Pipeline (governance_rebalance_script.counter_proposal_algorithm):
//   1. the logic engine validates the proposal (collection rules, the entry's own
//      invariants, the proposal's logic block) — any failure blocks it;
//   2. power_score(current) and power_score(proposal) via the JsonLogic formulas
//      in data/logic_rules.json; delta = proposal − current;
//   3. |delta| ≤ 15 % of current → accept as-is;
//   4. otherwise walk rebalance_links breadth-first (depth ≤ 2) and distribute
//      −delta proportionally to each linked entry's score, drafting one
//      counter-proposal version per linked entry (origin rebalance_script,
//      parent_version = their canonical); a nerf first tries a compensating
//      property on the same entry (an every_bonus / one element less);
//   5. write the report to tools/out/rebalance-<ts>.json; with --apply append
//      the new version objects (status proposal, weight 0) — never in place.
//
// Library use (the node's rules editor, game/editor-api.mjs): `checkProposal(proposal, { eng, apply })` runs the
// same pipeline (steps 1–4) silently on any LogicEngine (e.g. one on a temp data dir) and returns the report object
// plus { ok, errors:[str], counters:[compact] }; nothing is written unless apply. The CLI runs only when this file
// is the entry point.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LogicEngine, activeVersion, writeDataFile, definitionsDirOf, authoredElsewhere } from '../logic-engine.mjs';
import { catalogSourceOf } from '../defs-collection.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const r3 = (x) => Math.round(x * 1000) / 1000;
function bumpVersion(v) { const p = String(v || '1.0.0').split('.').map(Number); p[1] = (p[1] || 0) + 1; p[2] = 0; return p.join('.'); }

// Per-engine kit: the governance tolerances and the scored collections of that engine's data.
let DEFAULT_ENG = null;
const defaultEngine = () => (DEFAULT_ENG ||= new LogicEngine());
const KITS = new WeakMap();
function kitOf(eng) {
  let k = KITS.get(eng);
  if (k) return k;
  const gov = eng.activeOf('governance_rebalance_script')?.data || {};
  const SCORED = Object.keys(eng.library.power_score || {}).filter(k => !['description', 'tolerance_rule'].includes(k));
  k = { eng, SCORED, TOL: Number(gov.tolerance?.per_entry_relative) || 0.15, MEAN_TOL: Number(gov.tolerance?.per_collection_mean_drift) || 0.05,
    scoreOf: (collection, data) => SCORED.includes(collection) ? eng.powerScore(collection, data) : null };
  KITS.set(eng, k);
  return k;
}

// ---------------------------------------------------------------- report
function report(k, onlyCollection) {
  const { eng, SCORED, TOL, MEAN_TOL, scoreOf } = k;
  const rows = [];
  for (const [id, { collection, entry }] of eng.catalog) {
    if (onlyCollection && collection !== onlyCollection) continue;
    if (!SCORED.includes(collection)) continue;
    const v = activeVersion(entry);
    rows.push({ collection, id, version: v.version, score: scoreOf(collection, v.data), links: (v.rebalance_links || []).length });
  }
  rows.sort((a, b) => a.collection.localeCompare(b.collection) || b.score - a.score);
  let cur = null;
  for (const r of rows) {
    if (r.collection !== cur) {
      cur = r.collection;
      const all = rows.filter(x => x.collection === cur).map(x => x.score);
      const mean = all.reduce((a, b) => a + b, 0) / all.length;
      console.log(`\n== ${cur}: ${all.length} entries, mean ${r3(mean)}, min ${Math.min(...all)}, max ${Math.max(...all)}`);
    }
    console.log(`  ${String(r.score).padStart(7)}  ${r.id.padEnd(36)} v${r.version}  links ${r.links}`);
  }
  console.log(`\n(formulas: data/logic_rules.json power_score_*; tolerance ±${TOL * 100}% per entry, ±${MEAN_TOL * 100}% collection mean)`);
}

// ---------------------------------------------------------------- check
// Steps 1–4 on a parsed proposal (mutates prop.version: the default fields); `log` gets the CLI lines.
function runCheck(k, prop, log, file) {
  const { eng, SCORED, TOL, MEAN_TOL, scoreOf } = k;
  const collection = prop.collection;
  const entryId = prop.entry_id || prop.entry?.id || null;
  const version = prop.version;
  if (!collection || !version) throw new Error('proposal needs { collection, version, entry_id | entry }');
  // Effect isolation F9: effects are definitions (chaosD6-Effects) — balanced by tools/rebalancing-check.mjs, not here.
  if (catalogSourceOf(eng.index, collection)) throw new Error(`${collection} is read from ${authoredElsewhere(eng.index, collection)}: a chaosD6-GameModels definition (monsters/<id>.json card), changed there (node tools/gamemodels-build.mjs checks it) - no proposals on data/${collection}.json`);
  if (authoredElsewhere(eng.index, collection)) throw new Error(`${collection} is read from ${authoredElsewhere(eng.index, collection)}: author it in its repo and run tools/${collection === 'skills' ? 'skills-' : ''}rebalancing-check.mjs — no proposals on data/${collection}.json`);
  const existing = prop.entry_id ? eng.entryOf(prop.entry_id) : null;
  if (prop.entry_id && !existing) throw new Error(`no entry ${prop.entry_id}`);
  const canonical = existing ? activeVersion(existing) : null;
  version.status ||= 'proposal'; version.weight ??= 0; version.vote_log ||= []; version.rebalance_links ||= canonical?.rebalance_links || [];
  version.parent_version ??= canonical?.version || null; version.created_at ||= new Date().toISOString().slice(0, 10);
  version.origin ||= 'player_vote'; version.author_peer_id ??= '';

  const out = { file, collection, entry_id: entryId, new_entry: !existing, proposal_version: version.version, created_at: new Date().toISOString() };
  // 1. validation
  const val = eng.validateProposal(collection, existing ? entryId : null, version, { newEntry: existing ? null : prop.entry });
  out.validation = val;
  log(`validation: ${val.ok ? 'OK' : `${val.failures.length} failure(s)`}`);
  for (const f of val.failures) log(`  ✗ [${f.scope}:${f.id}] ${f.description}${f.error ? ` — ${f.error}` : ''}`);
  // 2. scores
  const current = canonical ? scoreOf(collection, canonical.data) : 0;
  const proposed = scoreOf(collection, version.data);
  out.scores = { current, proposal: proposed };
  if (proposed === null) {
    log(`power score: collection ${collection} has no power-score formula — governance by vote only`);
    out.verdict = val.ok ? 'validate_only' : 'blocked';
  } else {
    const delta = r3(proposed - (current ?? 0));
    out.scores.delta = delta;
    const within = existing ? eng.withinTolerance(current, proposed) : true;
    log(`power score: current ${current} → proposal ${proposed} (Δ ${delta >= 0 ? '+' : ''}${delta}; tolerance ±${r3(TOL * Math.abs(current || 0))}) ${within ? 'WITHIN tolerance' : 'OUTSIDE tolerance'}`);
    out.within_tolerance = within;
    // 3./4. counter-proposals
    out.counter_proposals = [];
    if (!within && existing) {
      const alt = compensateOnSameEntry(k, collection, canonical, version, current);
      if (alt) { out.compensation = alt; log(`compensation on the same entry possible: ${alt.description} → score ${alt.score}`); }
      const linked = linkedClosure(k, entryId, 2);
      const scored = linked.map(id => ({ id, collection: eng.collectionOf(id), v: eng.activeOf(id) })).filter(x => SCORED.includes(x.collection) && !authoredElsewhere(eng.index, x.collection)).map(x => ({ ...x, score: scoreOf(x.collection, x.v.data) }));
      const total = scored.reduce((a, x) => a + Math.max(0.001, x.score), 0);
      for (const x of scored) {
        const share = -delta * (Math.max(0.001, x.score) / total);
        const cp = draftCounter(k, x, share);
        if (cp) out.counter_proposals.push(cp);
      }
      log(`counter-proposals drafted on ${out.counter_proposals.length} linked entr${out.counter_proposals.length === 1 ? 'y' : 'ies'} (closure depth ≤ 2: ${linked.length})`);
      for (const cp of out.counter_proposals) log(`  • ${cp.entry_id}: ${cp.change} (score ${cp.score_before} → ${cp.score_after}, wanted ${r3(cp.wanted_delta)})`);
      // mean drift of the closure after counters
      const before = scored.map(x => x.score), after = scored.map(x => out.counter_proposals.find(c => c.entry_id === x.id)?.score_after ?? x.score);
      const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
      const drift = r3((mean([...after, proposed]) - mean([...before, current])) / Math.max(0.001, mean([...before, current])));
      out.closure_mean_drift = drift;
      log(`closure mean drift after counters: ${drift >= 0 ? '+' : ''}${Math.round(drift * 1000) / 10}% (limit ±${MEAN_TOL * 100}%)`);
      out.verdict = !val.ok ? 'blocked' : Math.abs(drift) <= MEAN_TOL ? 'accept_with_counters' : 'needs_rework';
    } else out.verdict = !val.ok ? 'blocked' : 'accept';
  }
  log(`\nVERDICT: ${out.verdict}`);
  return { out, existing, version };
}

// CLI: check <proposal.json> [--apply] — report to tools/out/rebalance-<ts>.json; --apply refuses only `blocked`.
function check(k, file, flags) {
  const prop = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { out, existing, version } = runCheck(k, prop, console.log, file);
  fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
  const outPath = path.join(HERE, 'out', `rebalance-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`report: ${outPath}`);
  if (flags.has('--apply')) {
    if (out.verdict === 'blocked') { console.log('not applied: validation failed'); process.exit(1); }
    apply(k, out.collection, existing ? out.entry_id : null, prop.entry, version, out.counter_proposals || []);
  }
  return out;
}

/**
 * The `check` pipeline as a library call (no console output, no report file).
 * @param proposal  { collection, entry_id | entry, version:{ version, data, logic?, … } } — prop.version gets the
 *                  default fields (status proposal, weight 0, parent_version, …) filled in place.
 * @param opts.eng  a LogicEngine (default: one on DATA_DIR); opts.apply → append like `check --apply` (refused when
 *                  blocked; needs_rework IS appended, valid counters too) to eng.dataDir; opts.log → CLI lines.
 * @returns the CLI report object { collection, entry_id, new_entry, proposal_version, validation, scores,
 *          within_tolerance?, counter_proposals?, compensation?, closure_mean_drift?,
 *          verdict: accept|accept_with_counters|needs_rework|blocked|validate_only } plus { ok (verdict ≠ blocked),
 *          errors:[str], counters:[{ entry_id, collection, change, version, score_before, score_after, wanted_delta,
 *          within, valid, same_entry? }], applied:[collections] | null }. Throws like the CLI (definitions
 *          collections, unknown entry, malformed proposal).
 */
export function checkProposal(proposal, { eng = defaultEngine(), apply: doApply = false, log = () => {} } = {}) {
  const k = kitOf(eng);
  const { out, existing, version } = runCheck(k, proposal, log);
  const errors = out.validation.failures.map(f => `[${f.scope}:${f.id}] ${f.description}${f.error ? ` — ${f.error}` : ''}`);
  const counters = [
    ...(out.compensation ? [{ entry_id: out.entry_id, collection: out.collection, same_entry: true, change: out.compensation.description, version: null,
      score_before: out.scores.current, score_after: out.compensation.score, wanted_delta: null, within: true, valid: true }] : []),
    ...(out.counter_proposals || []).map(cp => ({ entry_id: cp.entry_id, collection: cp.collection, change: cp.change, version: cp.version.version,
      score_before: cp.score_before, score_after: cp.score_after, wanted_delta: r3(cp.wanted_delta),
      within: eng.withinTolerance(cp.score_before, cp.score_after), valid: cp.valid })),
  ];
  const applied = doApply && out.verdict !== 'blocked'
    ? apply(k, out.collection, existing ? out.entry_id : null, proposal.entry, version, out.counter_proposals || [], log) : null;
  return { ...out, ok: out.verdict !== 'blocked', errors, counters, applied };
}

function linkedClosure(k, rootId, depth) {
  const { eng } = k;
  const seen = new Set([rootId]); let frontier = [rootId];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const id of frontier) for (const l of eng.activeOf(id)?.rebalance_links || []) if (eng.catalog.has(l) && !seen.has(l)) { seen.add(l); next.push(l); }
    frontier = next;
  }
  seen.delete(rootId);
  return [...seen].sort();
}

// A nerf (delta < 0) may be offset on the same entry: add an every_bonus or drop one element.
function compensateOnSameEntry(k, collection, canonical, version, current) {
  const { eng, scoreOf } = k;
  if (collection !== 'effects') return null;
  const delta = scoreOf(collection, version.data) - current;
  if (delta >= 0) return null;
  const tries = [];
  if (!version.data.every_bonus) tries.push({ description: 'add an every_bonus (∀ doubled-cast text)', data: { ...version.data, every_bonus: 'TODO: describe the ∀ bonus' } });
  if ((version.data.element_cost || []).length > 1) tries.push({ description: 'drop one element from the cost', data: { ...version.data, element_cost: version.data.element_cost.slice(0, -1) } });
  for (const t of tries) { const s = scoreOf(collection, t.data); if (eng.withinTolerance(current, s)) return { ...t, score: s }; }
  return null;
}

// One counter-proposal version on a linked entry moving its score by ~wanted:
// every plausible single-property change is scored and the one whose score
// delta has the wanted sign and the nearest magnitude is drafted.
function candidates(collection, data) {
  const out = [];
  const add = (change, mut) => { const d = JSON.parse(JSON.stringify(data)); mut(d); out.push({ change, data: d }); };
  if (collection === 'effects') {
    add('+1 element on the cost', d => { d.element_cost = [...d.element_cost, d.element_cost[d.element_cost.length - 1]]; });
    if (data.element_cost.length > 1) add('one element less on the cost', d => { d.element_cost = d.element_cost.slice(0, -1); });
    if (!data.every_bonus) add('gains an every_bonus (∀ text to be written)', d => { d.every_bonus = 'TODO: ∀ bonus to be written'; });
    else add('loses its every_bonus', d => { delete d.every_bonus; });
    if (!data.effect_types.includes('instant')) add('becomes an instant', d => { d.effect_types = [...d.effect_types, 'instant']; });
    else add('no longer an instant', d => { d.effect_types = d.effect_types.filter(t => t !== 'instant'); });
  } else if (collection === 'skills') {
    const bd = Number(data.bonus_damage) || 0;
    add('bonus_damage +1', d => { d.bonus_damage = bd + 1; });
    if (bd > 0) add('bonus_damage −1', d => { d.bonus_damage = bd - 1; });
    if (data.is_permanent) add('no longer permanent', d => { d.is_permanent = false; }); else add('becomes permanent', d => { d.is_permanent = true; });
  } else if (collection === 'classes') {
    const ap = typeof data.ability_power === 'number' ? data.ability_power : (data.ability_kind === 'once_per_round' ? 2 : data.ability_kind === 'tap' ? 1.5 : 1);
    if (ap < 3) add(`ability_power ${ap} → ${r3(ap + 0.5)}`, d => { d.ability_power = r3(ap + 0.5); });
    if (ap > 0) add(`ability_power ${ap} → ${r3(ap - 0.5)}`, d => { d.ability_power = r3(ap - 0.5); });
  } else if (collection === 'creatures') {
    add('life +1', d => { d.life += 1; });
    if (data.life > 1) add('life −1', d => { d.life -= 1; });
    if (data.actions_per_round < 4) add('actions_per_round +1', d => { d.actions_per_round += 1; });
    if (data.actions_per_round > 1) add('actions_per_round −1', d => { d.actions_per_round -= 1; });
  } else if (collection === 'characters') {
    const hi = Object.entries(data.stats).sort((a, b) => b[1] - a[1])[0][0], lo = Object.entries(data.stats).sort((a, b) => a[1] - b[1])[0][0];
    const relife = d => { if (typeof d.life === 'number') d.life = Math.round(Object.values(d.stats).reduce((a, b) => a + b, 0) / 10); };
    add(`${lo} +5`, d => { d.stats[lo] += 5; relife(d); });
    if (data.stats[hi] >= 5) add(`${hi} −5`, d => { d.stats[hi] -= 5; relife(d); });
  }
  return out;
}
function draftCounter(k, x, wanted) {
  const { eng, scoreOf } = k;
  const { id, collection, v } = x;
  const scoredC = candidates(collection, v.data).map(c => ({ ...c, after: scoreOf(collection, c.data) })).map(c => ({ ...c, d: c.after - x.score }));
  const right = scoredC.filter(c => Math.sign(c.d) === Math.sign(wanted) && c.d !== 0);
  if (!right.length) return null;
  const best = right.sort((a, b) => Math.abs(a.d - wanted) - Math.abs(b.d - wanted))[0];
  const version = { version: bumpVersion(v.version), weight: 0, status: 'proposal', origin: 'rebalance_script', author_peer_id: 'rebalance_script', created_at: new Date().toISOString().slice(0, 10), parent_version: v.version, rebalance_links: v.rebalance_links || [], vote_log: [], notes: `counter-proposal: ${best.change} (wanted Δ ${r3(wanted)}, got ${r3(best.d)})`, data: best.data };
  const val = eng.validateProposal(collection, id, version);
  return { entry_id: id, collection, change: best.change, wanted_delta: wanted, score_before: x.score, score_after: best.after, valid: val.ok, failures: val.failures, version };
}

function apply(k, collection, entryId, newEntry, version, counters, log = console.log) {
  const DATA_DIR = k.eng.dataDir;
  const touch = new Map();
  const load = (c) => { if (!touch.has(c)) touch.set(c, JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${c}.json`), 'utf8'))); return touch.get(c); };
  const json = load(collection);
  if (entryId) { const e = json.entries.find(x => x.id === entryId); e.versions.push(version); }
  else json.entries.push({ id: newEntry.id, name: newEntry.name || newEntry.id, tags: newEntry.tags || [], ...(newEntry.resources ? { resources: newEntry.resources } : {}), versions: [version] });
  for (const cp of counters) { if (!cp.valid) { log(`  skipped counter on ${cp.entry_id}: ${cp.failures.map(f => f.id).join(', ')}`); continue; } const j = load(cp.collection); j.entries.find(x => x.id === cp.entry_id).versions.push(cp.version); }
  for (const [c, j] of touch) writeDataFile(path.join(DATA_DIR, `${c}.json`), j);   // compact writer: one rule per line
  log(`applied: ${[...touch.keys()].join(', ')} (new version objects appended; proposals/<entry>-<ts> branch is yours to open)`);
  return [...touch.keys()];
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; }
  catch { return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href; }
}

if (isEntryPoint()) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter(a => a.startsWith('--')));
  const args = rest.filter(a => !a.startsWith('--'));
  const k = kitOf(defaultEngine());
  if (cmd === 'report') report(k, args[0]);
  else if (cmd === 'check') check(k, args[0], flags);
  else if (cmd === 'selfcheck') { const r = k.eng.selfCheck(); console.log(JSON.stringify(r, null, 2)); process.exit(r.some(x => x.failures.some(f => f.error)) ? 1 : 0); }
  else { console.log('usage: node tools/rebalance.mjs report [collection] | check <proposal.json> [--apply] | selfcheck'); process.exit(2); }
}
