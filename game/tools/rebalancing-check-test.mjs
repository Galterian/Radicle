#!/usr/bin/env node
// Tests for tools/rebalancing-check.mjs (E5). `node tools/rebalancing-check-test.mjs` → ends "all rebalancing checks passed".
//  1. every built-in: its curve verdict matches the calibration and is ok or a listed known outlier; checked as itself
//     (auto-baseline = its own snapshot) it is ok
//  2. every E1 definition present (game/effects-data/effects): ok, and the logic audit runs and matches its flags exactly
//  3. synthetic effects: overpowered → reject, strong → nerf (+ in-band suggestion), weak → boost; malformed → reject
//  4. a program that does more than its flags declare → reject (logic audit)
//  5. determinism: same result over 3 runs, and in a fresh process
//  6. tolerance knob, baseline mode, pin / verifyPin
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkEffect, loadCalibration, loadBuiltinDefs, computePin, verifyPin, canonicalJson, VALIDATOR_VERSION } from './rebalancing-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fails = 0, passes = 0;
const ok = (label, cond, extra = '') => { if (cond) passes++; else { fails++; console.log(`FAIL ${label}${extra ? ` — ${extra}` : ''}`); } };
const cal = loadCalibration();
ok('calibration has a fit', !!cal.fit && Number.isFinite(cal.fit.a) && Number.isFinite(cal.fit.b));
const outliers = new Set((cal.known_outliers || []).map(o => o.id));

// 1. built-ins
const { defs: builtins } = await loadBuiltinDefs();
const tally = {}, unpriced = [];
for (const d of builtins) {
  const curve = checkEffect(d, { baseline: null });
  const snap = cal.builtins[d.id];
  tally[curve.verdict] = (tally[curve.verdict] || 0) + 1;
  ok(`${d.id} calibrated`, !!snap);
  if (snap?.curve_verdict === 'unpriced') {
    // peer-hook-only permanent: outside the fit, but usable as a baseline for a branch that extends it
    unpriced.push(d.id);
    ok(`${d.id} unpriced: not in the fit`, (cal.fit.unpriced || []).includes(d.id) && !outliers.has(d.id));
    const br = checkEffect({ ...d, id: `${d.id}_branch_test`, extends: d.id, ...(d.element_cost ? { element_cost: [...d.element_cost, d.element_cost[d.element_cost.length - 1]] } : { elements: [...d.elements, d.elements[d.elements.length - 1]] }) });
    ok(`${d.id} usable as a baseline`, br.mode === 'baseline' && br.baseline?.id === d.id && br.valid, `${br.mode} ${br.errors?.join('; ')}`);
  } else {
    ok(`${d.id} curve verdict = calibration`, snap && curve.verdict === snap.curve_verdict, `${curve.verdict} vs ${snap?.curve_verdict}`);
    ok(`${d.id} ok or known outlier`, curve.verdict === 'ok' || outliers.has(d.id), `${curve.verdict} ${curve.judged_ratio}`);
  }
  const self = checkEffect(d);
  ok(`${d.id} as itself → ok`, self.verdict === 'ok' && self.mode === 'baseline', `${self.verdict} ${self.mode}`);
}
console.log(`built-ins: ${builtins.length} (curve verdicts ${JSON.stringify(tally)}; known outliers ${outliers.size}; unpriced ${unpriced.length}: ${unpriced.join(', ')})`);

// 2. E1 definitions
const e1Dir = path.join(HERE, '..', 'effects-data', 'effects');
const { defs: preferE1 } = await loadBuiltinDefs({ prefer: 'e1' });
const e1Ids = fs.existsSync(e1Dir) ? fs.readdirSync(e1Dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)) : [];
let e1Audited = 0;
for (const d of preferE1.filter(x => e1Ids.includes(x.id))) {
  const r = checkEffect(d);
  ok(`E1 ${d.id} → ok`, r.verdict === 'ok', `${r.verdict} ${r.reasons.join('; ')}`);
  ok(`E1 ${d.id} audit ran`, r.audit?.ran === true, r.audit?.why);
  ok(`E1 ${d.id} program == flags`, r.audit?.identical === true);
  if (r.audit?.ran) e1Audited++;
}
console.log(`E1 definitions audited: ${e1Audited}/${e1Ids.length}`);

// 3. synthetic effects
const doom = { id: 'effect_test_doom', element_cost: ['elem_fire'], effect_types: ['damage', 'instant'], rule: { damage: 'pointbuy', scope: 'all_seen', lock: 3, draw: 5 } };
const strong = { id: 'effect_test_strong', element_cost: ['elem_fire', 'elem_fire'], effect_types: ['damage'], rule: { damage: 'delta', scope: 'all_enemies', lock: 1 } };
const weak = { id: 'effect_test_weak', element_cost: ['elem_fire', 'elem_fire', 'elem_air', 'elem_air'], effect_types: ['damage'], rule: { damage: 'delta', scope: 'target' } };
const rd = checkEffect(doom), rs = checkEffect(strong), rw = checkEffect(weak);
ok('overpowered → reject (hard cap)', rd.verdict === 'reject' && rd.valid === true, `${rd.verdict} ${rd.judged_ratio}`);
ok('strong → nerf', rs.verdict === 'nerf', `${rs.verdict} ${rs.judged_ratio}`);
ok('nerf offers an in-band change', rs.suggestions.some(s => s.in_band), JSON.stringify(rs.suggestions));
ok('weak → boost', rw.verdict === 'boost', `${rw.verdict} ${rw.judged_ratio}`);
ok('boost offers a change', rw.suggestions.some(s => s.patch), JSON.stringify(rw.suggestions));
console.log(`synthetic: doom ${rd.verdict} ×${rd.judged_ratio}, strong ${rs.verdict} ×${rs.judged_ratio} (→ ${rs.suggestions[0]?.change}), weak ${rw.verdict} ×${rw.judged_ratio} (→ ${rw.suggestions[0]?.change})`);
const bad = {
  'unknown key': { ...weak, rule: { ...weak.rule, nuke: true } },
  'lock out of bounds': { ...weak, rule: { ...weak.rule, lock: 9 } },
  'unbreakable channel': { ...weak, rule: { ...weak.rule, permanent: true, channel: { stop: 'never' } } },
  'unknown element': { ...weak, element_cost: ['elem_plasma'] },
  'no rule': { id: 'effect_test_norule', element_cost: ['elem_fire'] },
  'bad id': { ...weak, id: 'Fireball!' },
  'too long': { ...weak, element_cost: new Array(9).fill('elem_fire') },
  'op list': { ...weak, rule: [{ op: 'damage' }] },
};
for (const [k, d] of Object.entries(bad)) { const r = checkEffect(d); ok(`malformed (${k}) → reject`, r.verdict === 'reject' && r.valid === false, `${r.verdict} ${r.errors?.join('; ')}`); }

// 4. logic audit: a program that lays a fire token while its flags claim none
const fbE1 = preferE1.find(x => x.id === 'effect_fireball' && x.logic !== undefined);
if (fbE1) {
  const liar = JSON.parse(JSON.stringify(fbE1));
  liar.id = 'effect_test_fireball_liar';
  delete liar.flags.tileToken;
  const r = checkEffect(liar);
  ok('program > flags → reject', r.verdict === 'reject' && r.reasons.some(x => x.includes('logic exceeds')), `${r.verdict} ${r.reasons.join('; ')}`);
  const honest = JSON.parse(JSON.stringify(fbE1)); honest.id = 'effect_test_fireball_copy';
  const rh = checkEffect(honest);
  ok('renamed honest program audits clean', rh.audit?.ran && rh.audit.identical && rh.verdict !== 'reject', JSON.stringify(rh.audit));
  console.log(`audit: liar → ${r.verdict} (${r.reasons[0]})`);
} else console.log('audit: skipped (no E1 fireball definition yet)');

// 5. determinism
const sample = [doom, strong, weak, builtins.find(d => d.id === 'effect_meteor_shower'), builtins.find(d => d.id === 'effect_summoning'), ...(fbE1 ? [fbE1] : [])].filter(Boolean);
const runs = [0, 1, 2].map(() => sample.map(d => canonicalJson(checkEffect(d, { baseline: null }))));
ok('same results over 3 runs', runs[1].join('\n') === runs[0].join('\n') && runs[2].join('\n') === runs[0].join('\n'));
const tmp = path.join(HERE, 'out', '_rbc_test_strong.json');
fs.mkdirSync(path.dirname(tmp), { recursive: true });
fs.writeFileSync(tmp, JSON.stringify(strong));
const fresh = JSON.parse(execFileSync(process.execPath, [path.join(HERE, 'rebalancing-check.mjs'), 'check', tmp, '--json', '--no-baseline'], { encoding: 'utf8' }));
ok('fresh process: same stamp', canonicalJson(fresh.stamp) === canonicalJson(rs.stamp), `${canonicalJson(fresh.stamp)} vs ${canonicalJson(rs.stamp)}`);
ok('fresh process: same power', canonicalJson(fresh.power) === canonicalJson(rs.power));
console.log(`determinism: stamp ${rs.stamp.def_sha256.slice(0, 12)} verdict ${rs.stamp.verdict} ratio ${rs.stamp.ratio} pin ${rs.stamp.pin_id.slice(0, 12)} (node ${process.version})`);

// 6. tolerance, baseline, pin
ok('tolerance 0.15 → nerf', checkEffect(strong, { tolerance: 0.15 }).verdict === 'nerf');
ok('tolerance 0.6 → ok', checkEffect(strong, { tolerance: 0.6 }).verdict === 'ok');
const fb = builtins.find(d => d.id === 'effect_fireball');
const fbCurve = checkEffect(fb, { baseline: null });
ok('tolerance 0 → off-curve built-in leaves the band', checkEffect(fb, { baseline: null, tolerance: 0 }).verdict === (fbCurve.power.ratio > 1 ? 'nerf' : 'boost'));
ok('tolerance widens monotonically', [0, 0.05, 0.15, 0.3, 0.6, 1].map(t => checkEffect(strong, { tolerance: t }).verdict === 'ok').every((v, i, a) => i === 0 || !a[i - 1] || v));
const fbAoe = { ...fb, rule: { ...fb.rule, scope: 'all_seen' } };
const rAoe = checkEffect(fbAoe);
ok('fireball branch hitting everyone in view → judged against its parent → nerf/reject', rAoe.mode === 'baseline' && rAoe.baseline.id === 'effect_fireball' && ['nerf', 'reject'].includes(rAoe.verdict), `${rAoe.verdict} ${rAoe.judged_ratio}`);
const fbCheap = { ...fb, element_cost: ['elem_fire'] };
const rCheap = checkEffect(fbCheap);
ok('fireball branch with one element less → judged against its parent', rCheap.mode === 'baseline', `${rCheap.verdict} ${rCheap.judged_ratio}`);
const ext = { ...weak, id: 'effect_test_haste_variant', extends: 'effect_haste', element_cost: ['elem_time', 'elem_time', 'elem_time'], effect_types: ['permanent'], rule: { permanent: true, draw: 1 } };
const rExt = checkEffect(ext);
ok('extends a built-in → baseline mode on it', rExt.mode === 'baseline' && rExt.baseline.id === 'effect_haste', `${rExt.mode}`);
console.log(`baseline: fireball→all_seen ${rAoe.verdict} ×${rAoe.judged_ratio}; fireball 1 element ${rCheap.verdict} ×${rCheap.judged_ratio}; haste variant (3 Time) ${rExt.verdict} ×${rExt.judged_ratio}`);
const pin = computePin();
ok('pin stable', canonicalJson(pin) === canonicalJson(computePin()));
ok('pin format/version', pin.format === 'chaosd6-effects-validator-pin/1' && pin.validator_version === VALIDATOR_VERSION && /^[0-9a-f]{64}$/.test(pin.pin_id));
ok('verifyPin(own) ok', verifyPin(pin).ok);
const tampered = JSON.parse(JSON.stringify(cal)); tampered.weights.damage += 0.01;
ok('calibration change → new pin', computePin(tampered).pin_id !== pin.pin_id);
ok('verifyPin(foreign pin) reports the diff', !verifyPin({ ...pin, source_sha256: '0'.repeat(64), pin_id: 'x' }).ok);
ok('stamp carries the pin', rs.stamp.pin_id === pin.pin_id);

console.log(fails ? `${fails} FAILED, ${passes} passed` : `all rebalancing checks passed (${passes})`);
process.exit(fails ? 1 : 0);
