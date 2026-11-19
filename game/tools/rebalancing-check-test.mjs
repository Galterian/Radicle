#!/usr/bin/env node
// Tests for tools/rebalancing-check.mjs (E5). `node tools/rebalancing-check-test.mjs` → ends "all rebalancing checks passed".
//  1. every built-in: its curve verdict matches the calibration and is ok or a listed known outlier; checked as itself
//     (auto-baseline = its own snapshot) it is ok
//  2. every E1 definition present (game/effects-data/effects): ok, and the logic audit runs and matches its flags exactly
//  3. synthetic effects: overpowered → reject, strong → nerf (+ in-band suggestion), weak → boost; malformed → reject
//  4. a program that does more than its flags declare → reject (logic audit)
//  5. determinism: same result over 3 runs, and in a fresh process
//  6. tolerance knob, baseline mode, pin / verifyPin
//  7. ref-pinned libs (1.1.0): a stronger lib changes the verdict, bundled path unchanged, stamp.libs, pin mismatch refused, CLI --libs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkEffect, loadCalibration, loadBuiltinDefs, computePin, verifyPin, canonicalJson, VALIDATOR_VERSION, DEFAULT_TOLERANCE } from './rebalancing-check.mjs';

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
// weak (×0.82) is inside the ±30 % default band (ruling 2026-11-18), so its boost path is tested at the old ±10 %.
const rd = checkEffect(doom), rs = checkEffect(strong), rw = checkEffect(weak, { tolerance: 0.10 });
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
ok('default tolerance is 0.30 (band [0.7, 1.3])', rs.tolerance === 0.3 && rs.band.low === 0.7 && rs.band.high === 1.3 && cal.policy.tolerance === 0.3 && DEFAULT_TOLERANCE === 0.3, `${rs.tolerance} [${rs.band.low}, ${rs.band.high}]`);
ok('tolerance 0.10 → nerf', checkEffect(strong, { tolerance: 0.10 }).verdict === 'nerf');
ok('tolerance 0.15 → nerf', checkEffect(strong, { tolerance: 0.15 }).verdict === 'nerf');
{ // an effect between 1.10 and 1.30: ok at the default 0.30, nerf at the old 0.10
  const mid = builtins.map(d => checkEffect(d, { baseline: null })).find(r => r.judged_ratio > 1.1 && r.judged_ratio <= 1.3);
  if (mid) ok(`${mid.effect_id} ×${mid.judged_ratio}: ok at 0.30, nerf at 0.10`, mid.verdict === 'ok' && checkEffect(builtins.find(d => d.id === mid.effect_id), { baseline: null, tolerance: 0.10 }).verdict === 'nerf');
}
ok('tolerance 0.6 → ok', checkEffect(strong, { tolerance: 0.6 }).verdict === 'ok');
const fb = builtins.find(d => d.id === 'effect_fireball');
const fbCurve = checkEffect(fb, { baseline: null });
ok('tolerance 0 → off-curve built-in leaves the band', checkEffect(fb, { baseline: null, tolerance: 0 }).verdict === (fbCurve.power.ratio > 1 ? 'nerf' : 'boost'));
ok('tolerance widens monotonically', [0, 0.05, 0.1, 0.15, 0.3, 0.6, 1].map(t => checkEffect(strong, { tolerance: t }).verdict === 'ok').every((v, i, a) => i === 0 || !a[i - 1] || v));
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
ok('validator version 1.1.0 (ref-pinned libs)', VALIDATOR_VERSION === '1.1.0' && pin.validator_version === '1.1.0');

// 7. libs bound from the ref / commit (1.1.0): a foreign effect is priced against ITS libs, not the bundled ones
{
  const libDir = path.join(HERE, '..', 'effects-data', 'lib');
  const bundledLibs = fs.readdirSync(libDir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(libDir, f), 'utf8').replace(/^﻿/, '')));
  const std = bundledLibs.find(l => l.id === 'std');
  const shaOf = (l) => crypto.createHash('sha256').update(canonicalJson(l)).digest('hex');
  ok('stamp carries the libs map (flags-only def → {})', canonicalJson(rs.stamp.libs) === '{}' && rs.libs.source === 'bundled');
  if (fbE1 && std) {
    const copy = JSON.parse(JSON.stringify(fbE1)); copy.id = 'effect_test_fireball_libs';
    const rb = checkEffect(copy);
    ok('bundled: stamp.libs = sha256 of the bundled std', rb.libs.source === 'bundled' && canonicalJson(rb.stamp.libs) === canonicalJson({ std: shaOf(std) }), canonicalJson(rb.stamp.libs));
    const rg = checkEffect(copy, { libs: bundledLibs, libShas: { std: shaOf(std) } });
    ok('given = the bundled libs → same verdict / power / stamp', rg.libs.source === 'given' && rg.verdict === rb.verdict && canonicalJson(rg.power) === canonicalJson(rb.power) && canonicalJson(rg.stamp) === canonicalJson(rb.stamp));
    // a player's std where main_delta deals double: the effect's flags (what is priced) are unchanged
    const strongStd = JSON.parse(JSON.stringify(std)); strongStd.version = '9.9.9';
    strongStd.subs.main_delta.body = { '*': [strongStd.subs.main_delta.body, 2] };
    const rx = checkEffect(copy, { libs: [strongStd], libShas: { std: shaOf(strongStd) } });
    ok('stronger lib bound → verdict changes (reject: logic exceeds its flags)', rb.verdict !== 'reject' && rx.verdict === 'reject' && rx.reasons.some(x => x.includes('logic exceeds') && x.includes('damage')), `${rb.verdict} → ${rx.verdict} ${rx.reasons.join('; ')}`);
    ok('stronger lib: stamp.libs records the bound lib', rx.stamp.libs.std === shaOf(strongStd) && rx.stamp.libs.std !== rb.stamp.libs.std);
    ok('no libs given → still the bundled verdict (unchanged path)', checkEffect(copy).verdict === rb.verdict && canonicalJson(checkEffect(copy).stamp) === canonicalJson(rb.stamp));
    const rm = checkEffect(copy, { libs: [strongStd], libShas: { std: shaOf(std) } });
    ok('lib hash ≠ the ref pin → reject', rm.verdict === 'reject' && rm.valid === false && rm.errors.some(e => e.includes('≠ pinned')), rm.errors?.join('; '));
    const rp = checkEffect(copy, { libs: bundledLibs, libShas: { std: shaOf(std), e2a: shaOf(bundledLibs.find(l => l.id === 'e2a')) } });
    ok('ref pinning a lib the def does not use → reject', rp.verdict === 'reject' && rp.errors.some(e => e.includes('ref pins libs')), rp.errors?.join('; '));
    const rn = checkEffect(copy, { libs: [] });
    ok('used lib not provided → reject', rn.verdict === 'reject' && rn.errors.some(e => e.includes('not provided')), rn.errors?.join('; '));
    const rbad = checkEffect(copy, { libs: [{ ...std, schema: 'nope' }] });
    ok('invalid given lib → reject', rbad.verdict === 'reject' && rbad.errors.some(e => e.startsWith('lib std:')), rbad.errors?.join('; '));
    // CLI --libs <dir>: the same verdict as the API with the same libs
    const ld = path.join(HERE, 'out', '_rbc_test_libs'); fs.mkdirSync(ld, { recursive: true });
    for (const l of [strongStd]) fs.writeFileSync(path.join(ld, `${l.id}.json`), JSON.stringify(l));
    const tmpF = path.join(HERE, 'out', '_rbc_test_fb_libs.json'); fs.writeFileSync(tmpF, JSON.stringify(copy));
    let cli;
    try { cli = JSON.parse(execFileSync(process.execPath, [path.join(HERE, 'rebalancing-check.mjs'), 'check', tmpF, '--json', '--libs', ld], { encoding: 'utf8' })); }
    catch (e) { cli = JSON.parse(e.stdout); }   // reject → exit 1
    ok('CLI --libs <dir> binds them (same stamp as the API)', canonicalJson(cli.stamp) === canonicalJson(rx.stamp), canonicalJson(cli.stamp));
    const cliB = JSON.parse(execFileSync(process.execPath, [path.join(HERE, 'rebalancing-check.mjs'), 'check', tmpF, '--json'], { encoding: 'utf8' }));
    ok('CLI without --libs = bundled', canonicalJson(cliB.stamp) === canonicalJson(rb.stamp));
    // CLI --ref <commit> --repo <dir>: lib/ of a (scratch) chaosD6-Effects commit
    let repo = null, c1 = null;
    try {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-libs-repo-'));
      const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      g('init', '-q', '-b', 'main');
      fs.mkdirSync(path.join(repo, 'lib'));
      for (const l of bundledLibs) fs.writeFileSync(path.join(repo, 'lib', `${l.id}.json`), JSON.stringify(l.id === 'std' ? strongStd : l, null, 2) + '\n');
      g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'strong std');
      c1 = g('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(repo, 'lib', 'std.json'), JSON.stringify(std, null, 2) + '\n');
      g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'bundled std');
    } catch (e) { console.log(`libs: CLI --ref skipped (no git: ${String(e.message).split('\n')[0]})`); c1 = null; }
    if (c1) {
      const run = (c) => { try { return JSON.parse(execFileSync(process.execPath, [path.join(HERE, 'rebalancing-check.mjs'), 'check', tmpF, '--json', '--ref', c, '--repo', repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch (e) { try { return JSON.parse(e.stdout); } catch { return { verdict: `error: ${String(e.stderr || e.message).split('\n')[0]}` }; } } };
      const r1 = run(c1), r2 = run('HEAD');
      ok('CLI --ref <commit with a stronger std> → priced (reject, its std in the stamp)', r1.verdict === 'reject' && canonicalJson(r1.stamp) === canonicalJson(rx.stamp), `${r1.verdict} ${canonicalJson(r1.stamp)}`);
      ok('CLI --ref <commit with the bundled std> → the bundled verdict', r2.verdict === rb.verdict && canonicalJson(r2.stamp) === canonicalJson(rb.stamp), `${r2.verdict}`);
    }
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
    console.log(`libs: bundled ${rb.verdict} (std@${rb.stamp.libs.std.slice(0, 8)}), doubled main_delta → ${rx.verdict} (std@${rx.stamp.libs.std.slice(0, 8)}), mismatched pin → ${rm.verdict}`);
  } else console.log('libs: skipped (no E1 fireball / std lib)');
}

console.log(fails ? `${fails} FAILED, ${passes} passed` : `all rebalancing checks passed (${passes})`);
process.exit(fails ? 1 : 0);
