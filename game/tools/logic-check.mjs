#!/usr/bin/env node
// Regression over the JsonLogic data layer:
//   1. every named rule's examples in data/logic_rules.json evaluate as expected,
//   2. every entry's `logic` block expands (no unknown rules / params),
//   3. every active version passes the collection rules and its own validation,
//   4. a coverage table: entries with / without a logic block per collection.
//
//   node tools/logic-check.mjs            # exit 1 on any failure
//   node tools/logic-check.mjs --verbose  # list every entry without logic
import { LogicEngine, activeVersion } from '../logic-engine.mjs';

const verbose = process.argv.includes('--verbose');
const eng = new LogicEngine();
let fails = 0;

const bad = eng.checkLibrary();
console.log(`named rules: ${eng.rules.size}, examples failing: ${bad.length}`);
for (const b of bad) { fails++; console.log(`  FAIL ${b.rule}: ${JSON.stringify(b.example.args ?? b.example.data)} → ${b.error || JSON.stringify(b.got)} (expected ${JSON.stringify(b.example.expect)})`); }

const cover = new Map();
const missing = [];
for (const [id, { collection, entry }] of eng.catalog) {
  const v = activeVersion(entry);
  const c = cover.get(collection) || { with: 0, without: 0 };
  if (v?.logic && typeof v.logic === 'object') {
    c.with++;
    for (const k of ['prerequisites', 'effects', 'validation']) {
      const list = v.logic[k];
      if (!Array.isArray(list)) continue;   // `references` is a plain id list, not items
      for (const item of list) {
        const body = item.when ?? item.value ?? item.assert;
        if (body === undefined) { fails++; console.log(`  FAIL ${id} logic.${k}[${item.id}]: no when/value/assert`); continue; }
        try { eng.expand(body); } catch (e) { fails++; console.log(`  FAIL ${id} logic.${k}[${item.id}]: ${e.message}`); }
      }
    }
  } else { c.without++; missing.push(`${collection}/${id}`); }
  cover.set(collection, c);
}
console.log('\nlogic coverage (active versions):');
for (const [c, n] of [...cover].sort()) console.log(`  ${c.padEnd(18)} with ${String(n.with).padStart(3)}  without ${String(n.without).padStart(3)}`);
if (verbose && missing.length) console.log(`\nwithout logic:\n  ${missing.join('\n  ')}`);

// Existing paper data that breaks its own rules is a data CONTRADICTION to fix
// by proposal (reported, not fatal); an evaluation error is a bug (fatal).
const report = eng.selfCheck();
let warns = 0;
console.log(`\nself-check (active versions re-validated as proposals): ${report.length} entries flagged`);
for (const r of report) for (const f of r.failures) {
  if (f.error) { fails++; console.log(`  FAIL ${r.collection}/${r.id} [${f.scope}:${f.id}] ${f.description} — ${f.error}`); }
  else { warns++; console.log(`  WARN ${r.collection}/${r.id} [${f.scope}:${f.id}] ${f.description}`); }
}
if (warns) console.log(`  (${warns} data contradictions — the paper data disagrees with its own rules; fix by proposal)`);

console.log(fails ? `\n${fails} FAILED` : '\nall logic checks passed');
process.exit(fails ? 1 : 0);
