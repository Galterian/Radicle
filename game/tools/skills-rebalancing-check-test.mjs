#!/usr/bin/env node
// Tests for tools/skills-rebalancing-check.mjs (S5). `node tools/skills-rebalancing-check-test.mjs` → ends "all skills rebalancing checks passed".
//  1. the 14 built-ins: calibrated, curve verdict = calibration, ok or a listed known outlier; as itself (baseline) ok;
//     BUILTIN_FLAGS agree with data/skills.json and game/skills.mjs SKILL_RULES
//  2. logic audit: every built-in's flags reproduce game/skills.mjs exactly on the seeded duels; a branch whose flags
//     under-declare its parent's hooks → reject; a logic program (no program engine yet) → reject
//  3. synthetic skills: overpowered → reject, strong → nerf (+ a weaker in-band change), weak → boost; malformed → reject
//  4. determinism: 3 runs, a fresh process, and a digest compared across platforms (Windows node ↔ WSL node)
//  5. tolerance knob, baseline mode, pin / verifyPin, the effects validator untouched, rebalancing-core parity
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkSkill, loadCalibration, loadBuiltinDefs, computePin, verifyPin, canonicalJson, auditLogic, normalizeDef, BUILTIN_FLAGS, VALIDATOR_VERSION, DEFAULT_TOLERANCE, PIN_FORMAT } from './skills-rebalancing-check.mjs';
import * as core from './rebalancing-core.mjs';
import * as fxv from './rebalancing-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
let fails = 0, passes = 0;
const ok = (label, cond, extra = '') => { if (cond) passes++; else { fails++; console.log(`FAIL ${label}${extra ? ` — ${extra}` : ''}`); } };
const cal = loadCalibration();
ok('calibration has a fit', !!cal.fit && Number.isFinite(cal.fit.a) && Number.isFinite(cal.fit.b));
const outliers = new Set((cal.known_outliers || []).map(o => o.id));
let SK = null;
try { SK = await import('../skills.mjs'); } catch { SK = null; }

// 1. built-ins
const { defs: builtins } = await loadBuiltinDefs();
ok('14 built-in skills', builtins.length === 14, String(builtins.length));
const data = JSON.parse(fs.readFileSync(path.join(GAME, '..', 'data', 'skills.json'), 'utf8'));
const tally = {};
for (const d of builtins) {
  const curve = checkSkill(d, { baseline: null });
  const snap = cal.builtins[d.id];
  tally[curve.verdict] = (tally[curve.verdict] || 0) + 1;
  ok(`${d.id} calibrated`, !!snap);
  ok(`${d.id} curve verdict = calibration`, snap && curve.verdict === snap.curve_verdict, `${curve.verdict} vs ${snap?.curve_verdict}`);
  ok(`${d.id} ok or known outlier`, curve.verdict === 'ok' || outliers.has(d.id), `${curve.verdict} ${curve.judged_ratio}`);
  const self = checkSkill(d);
  ok(`${d.id} as itself → ok (baseline)`, self.verdict === 'ok' && self.mode === 'baseline' && self.judged_ratio === 1, `${self.verdict} ${self.mode} ${self.judged_ratio}`);
  const e = data.entries.find(x => x.id === d.id);
  const v = e.versions.filter(x => !['rejected', 'superseded'].includes(x.status)).sort((a, b) => b.weight - a.weight)[0];
  ok(`${d.id} matches data/skills.json`, v.data.action_type === d.action_type && !!v.data.is_permanent === d.is_permanent && (v.data.point_buy_stat ?? null) === d.point_buy_stat && (v.data.fixed_power ?? null) === (d.fixed_power ?? null));
  if (SK?.SKILL_RULES) {
    const r = SK.SKILL_RULES[d.id];
    ok(`${d.id} matches skills.mjs SKILL_RULES`, r && r.action === d.action_type && r.permanent === d.is_permanent && (r.pointBuyStat ?? null) === (d.point_buy_stat ? d.point_buy_stat.replace(/^stat_/, '') : null), JSON.stringify(r));
  }
}
ok('BUILTIN_FLAGS covers exactly the built-ins', Object.keys(BUILTIN_FLAGS).sort().join() === builtins.map(d => d.id).sort().join());
console.log(`built-ins: ${builtins.length} (curve verdicts ${JSON.stringify(tally)}; known outliers ${outliers.size}: ${[...outliers].join(', ')})`);

// 2. logic audit
if (SK?.skillHook) {
  let nAud = 0;
  for (const d of builtins) {
    const a = auditLogic(d, normalizeDef(d));
    ok(`${d.id} audit ran`, a.ran, a.why);
    ok(`${d.id} flags == skills.mjs hooks on every seeded duel`, a.identical === true && a.exceeds.length === 0, JSON.stringify(a.diffs?.[0] || a.exceeds));
    if (a.ran) nAud += a.N;
  }
  const bluff = builtins.find(d => d.id === 'skill_bluff');
  const liar = { ...bluff, id: 'skill_test_bluff_liar', extends: 'skill_bluff', flags: { negate: { codes: ['A'], who: 'target', mode: 'ep' } } };
  const rl = checkSkill(liar);
  ok('branch under-declaring its parent hooks → reject (logic audit)', rl.verdict === 'reject' && rl.reasons.some(x => x.includes('logic exceeds')), `${rl.verdict} ${rl.reasons.join('; ')}`);
  const honest = { ...builtins.find(d => d.id === 'skill_grapple'), id: 'skill_test_grapple_copy', extends: 'skill_grapple' };
  const rh = checkSkill(honest);
  ok('renamed honest branch audits clean and is ok vs its parent', rh.audit?.ran && rh.audit.identical && rh.verdict === 'ok' && rh.mode === 'baseline', JSON.stringify(rh.audit) + rh.verdict);
  const prog = { id: 'skill_test_program', action_type: 'A', is_permanent: false, flags: { negate: { codes: ['P'], who: 'target', mode: 'ep' } }, logic: { effects: [] } };
  const rp = checkSkill(prog);
  ok('foreign bare logic block (no hook programs) → reject', rp.verdict === 'reject' && /nothing executes it/.test(rp.reasons.join(' ')), rp.reasons.join('; '));
  // 2026-11-16 rebalance: every new behaviour is held to its flag
  const liars = {
    'Ranged Weapon without reach': [{ ...builtins.find(d => d.id === 'skill_ranged_weapon'), id: 'skill_test_rw_liar', extends: 'skill_ranged_weapon', flags: { trapImmune: true } }, /dealt/],
    'Overrun without swap': [{ ...builtins.find(d => d.id === 'skill_overrun'), id: 'skill_test_ov_liar', extends: 'skill_overrun', flags: { negate: { codes: ['M', 'EM'], who: 'target', mode: 'no_move' } } }, /swapped/],
    'a lock the engine does not apply': [{ ...builtins.find(d => d.id === 'skill_dodge'), id: 'skill_test_dodge_lock', extends: 'skill_dodge', flags: { damageOff: 1, selfLock: { codes: ['A'], until: 'end_of_round' } } }, /plan_lock/],
    'Disruption without voiding': [{ ...builtins.find(d => d.id === 'skill_disruption_move'), id: 'skill_test_dm_liar', extends: 'skill_disruption_move', flags: { negate: { codes: ['P'], who: 'target', mode: 'em' } } }, /voided/],
    'Taunt without the Block clause': [{ ...builtins.find(d => d.id === 'skill_taunt'), id: 'skill_test_tt_liar', extends: 'skill_taunt', flags: { tauntGuard: true } }, /dealt|taken/],
    'Sanctuary only on EP': [{ ...builtins.find(d => d.id === 'skill_sanctuary'), id: 'skill_test_sa_liar', extends: 'skill_sanctuary', flags: { invincibleWhile: ['EP'] } }, null],
  };
  for (const [k, [d, dim]] of Object.entries(liars)) {
    const r = checkSkill(d);
    ok(`${k} → reject (logic exceeds)`, r.verdict === 'reject' && r.reasons.some(x => x.includes('logic exceeds') && (!dim || dim.test(x))), `${r.verdict} ${r.reasons.join('; ')}`);
  }
  const paKeep = checkSkill({ ...builtins.find(d => d.id === 'skill_powerful_attack'), id: 'skill_test_pa_copy', extends: 'skill_powerful_attack' });
  ok('Powerful Attack branch keeping its lock audits clean', paKeep.audit?.ran && paKeep.audit.identical && paKeep.verdict === 'ok', JSON.stringify(paKeep.audit));
  // S2 programs (game/skills-data/skills/<id>.json) under the validator's flags: run by resolveSkillProgram
  const s2dir = path.join(GAME, 'skills-data', 'skills');
  const META = ['action', 'permanent', 'pointBuyStat', 'negating', 'hooks', 'range', 'negates', 'keepsTarget', 'attackBonus', 'damageOff', 'trance'];
  let s2n = 0; const s2missing = [];
  if (SK?.resolveSkillProgram && fs.existsSync(s2dir)) for (const d of builtins) {
    const file = path.join(s2dir, `${d.id}.json`);
    if (!fs.existsSync(file)) continue;
    const s2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    const meta = Object.fromEntries(Object.entries(s2.flags || {}).filter(([k]) => META.includes(k)));
    const def2 = { ...s2, flags: { ...meta, ...BUILTIN_FLAGS[d.id] } };
    if (d.fixed_power != null && s2.fixed_power == null && s2.data?.fixed_power == null) { def2.fixed_power = d.fixed_power; s2missing.push(`${d.id}.fixed_power`); }
    const r = checkSkill(def2);
    ok(`S2 ${d.id}: programs audited (resolveSkillProgram), identical, ok as itself`, r.verdict === 'ok' && r.audit?.ran && /resolveSkillProgram/.test(r.audit.engine) && r.audit.identical, `${r.verdict} ${r.reasons.join('; ')} ${JSON.stringify(r.audit)}`);
    s2n++;
  }
  // a FOREIGN skill with programs: a renamed copy of Ranged Weapon's S2 definition
  const rwFile = path.join(s2dir, 'skill_ranged_weapon.json');
  if (SK?.resolveSkillProgram && fs.existsSync(rwFile)) {
    const rw = JSON.parse(fs.readFileSync(rwFile, 'utf8'));
    const meta = Object.fromEntries(Object.entries(rw.flags || {}).filter(([k]) => META.includes(k)));
    const bow = { ...rw, id: 'skill_test_longbow', flags: { ...meta, reach: 2, trapImmune: true } };
    const rb = checkSkill(bow);
    ok('foreign program (renamed Ranged Weapon) audited on its own programs, identical', rb.audit?.ran && /resolveSkillProgram/.test(rb.audit.engine) && rb.audit.identical && rb.valid, `${rb.verdict} ${JSON.stringify(rb.audit)}`);
    const bowLiar = { ...bow, id: 'skill_test_longbow_liar', flags: { ...meta, trapImmune: true } };
    const rbl = checkSkill(bowLiar);
    ok('foreign program doing more than its flags → reject', rbl.verdict === 'reject' && rbl.reasons.some(x => x.includes('logic exceeds')), `${rbl.verdict} ${rbl.reasons.join('; ')}`);
  }
  console.log(`S2 programs audited: ${s2n}/14${s2missing.length ? ` (S2 files lack ${s2missing.join(', ')} — supplied from data/skills.json for the test)` : ''}`);
  const docLogic = checkSkill({ ...builtins.find(d => d.id === 'skill_grapple'), logic: { description: 'S2 data definition' } });
  ok('built-in with a (documentary) logic block → audited on its hooks, ok', docLogic.verdict === 'ok' && docLogic.audit?.ran === true, `${docLogic.verdict} ${JSON.stringify(docLogic.audit)}`);
  const s2shape = checkSkill({ id: 'skill_dodge', data: { action_type: 'M', is_permanent: false, point_buy_stat: null }, flags: { damageOff: 1 }, logic: {} });
  ok('S2 shape {id, data, flags, logic} of a built-in → ok in baseline mode', s2shape.verdict === 'ok' && s2shape.mode === 'baseline' && s2shape.judged_ratio === 1, `${s2shape.verdict} ${s2shape.judged_ratio}`);
  const foreign = { id: 'skill_test_foreign', action_type: 'M', is_permanent: false, flags: { damageOff: 1 } };
  const rf = checkSkill(foreign);
  ok('flags-only foreign skill: audit not run, still priced', rf.audit?.ran === false && /no executable behaviour/.test(rf.audit.why) && rf.valid, JSON.stringify(rf.audit));
  console.log(`audit: 14 built-ins identical to skills.mjs over ${nAud} seeded duels; liar → ${rl.verdict} (${rl.reasons[0]}); program → ${rp.verdict}`);
} else console.log('audit: skipped (game/skills.mjs missing)');

// 3. synthetic skills
const doom = { id: 'skill_test_doom', action_type: 'P', is_permanent: false, flags: { negate: { codes: ['A', 'M', 'B', 'P', 'EM'], who: 'adjacent', mode: 'ep' }, altCounterSkill: true } };
const wall = { id: 'skill_test_wall', action_type: 'B', is_permanent: true, point_buy_stat: 'any', flags: { immuneTo: ['A', 'B', 'M', 'P'] } };
const strong = { id: 'skill_test_strong', action_type: 'B', is_permanent: true, point_buy_stat: 'stat_vitality', flags: { immuneTo: ['A', 'B', 'P'] } };
const weak = { id: 'skill_test_weak', action_type: 'A', is_permanent: false, flags: { negate: { codes: ['EM'], who: 'target', mode: 'no_move' } } };
const mixUniform = Object.values(cal.mix.foe).every(v => v === 1 / 6) && Object.values(cal.mix.self).every(v => v === 1 / 6) && Object.keys(cal.mix.foe).length === 6;
const feeble = { id: 'skill_test_feeble', action_type: 'A', is_permanent: true, point_buy_stat: 'stat_will', flags: { trapImmune: true } };
const rd = checkSkill(doom), rwall = checkSkill(wall), rs = checkSkill(strong), rw = checkSkill(weak, { tolerance: 0.10 }), rfe = checkSkill(feeble);
ok('overpowered instant → reject (hard cap)', rd.verdict === 'reject' && rd.valid && rd.judged_ratio > cal.policy.hard_cap_ratio, `${rd.verdict} ${rd.judged_ratio}`);
ok('overpowered permanent → reject (hard cap)', rwall.verdict === 'reject' && rwall.valid, `${rwall.verdict} ${rwall.judged_ratio}`);
ok('strong → nerf', rs.verdict === 'nerf', `${rs.verdict} ${rs.judged_ratio}`);
ok('nerf offers a change', rs.suggestions.some(s => s.patch), JSON.stringify(rs.suggestions));
ok('nerf never suggests doing more', rs.suggestions.filter(s => s.patch).every(s => !/too$|every adjacent|also |alternative|no self-lock/.test(s.change)), JSON.stringify(rs.suggestions.map(s => s.change)));
ok('weak → boost (at the old ±10 %: it is inside the ±30 % band)', rw.verdict === 'boost', `${rw.verdict} ${rw.judged_ratio}`);
ok('boost offers a change', rw.suggestions.some(s => s.patch), JSON.stringify(rw.suggestions));
ok('next to nothing → reject (floor)', rfe.verdict === 'reject' && rfe.valid && rfe.judged_ratio < cal.policy.hard_floor_ratio, `${rfe.verdict} ${rfe.judged_ratio}`);
console.log(`synthetic: doom ${rd.verdict} ×${rd.judged_ratio}, wall ${rwall.verdict} ×${rwall.judged_ratio}, strong ${rs.verdict} ×${rs.judged_ratio} (→ ${rs.suggestions[0]?.change}), weak ${rw.verdict} ×${rw.judged_ratio} (→ ${rw.suggestions[0]?.change}), feeble ${rfe.verdict} ×${rfe.judged_ratio}`);
const pa2 = { ...builtins.find(d => d.id === 'skill_powerful_attack'), id: 'skill_test_pa_branch', extends: 'skill_powerful_attack', flags: { ...BUILTIN_FLAGS.skill_powerful_attack, attackBonus: 2 } };
const rpa = checkSkill(pa2);
ok('Powerful Attack branch +2 → judged vs its parent → nerf/reject, suggests +1', rpa.mode === 'baseline' && ['nerf', 'reject'].includes(rpa.verdict) && rpa.suggestions.some(s => s.change === 'attackBonus 2 → 1' && s.in_band), `${rpa.verdict} ${rpa.judged_ratio} ${JSON.stringify(rpa.suggestions.map(s => s.change))}`);
const bad = {
  'unknown flag': { ...weak, flags: { nuke: true } },
  'empty flags': { ...weak, flags: {} },
  'no flags': { id: 'skill_test_noflags', action_type: 'A', is_permanent: false },
  'bad id': { ...weak, id: 'Skill X' },
  'bad action': { ...weak, action_type: 'Z' },
  'attackBonus out of bounds': { ...weak, action_type: 'A', flags: { attackBonus: 5 } },
  'attackBonus not on A': { ...weak, action_type: 'P', flags: { attackBonus: 1 } },
  'perm flag on an instant': { ...weak, flags: { immuneTo: ['A'] } },
  'instant flag on a permanent': { ...wall, flags: { damageOff: 1 } },
  'permanent without stat': { ...wall, point_buy_stat: null },
  'negate EP into EP': { ...weak, flags: { negate: { codes: ['EP'], who: 'target', mode: 'ep' } } },
  'negate too many codes': { ...weak, flags: { negate: { codes: ['A', 'M', 'B', 'P', 'EM', 'EP'], who: 'target', mode: 'ep' } } },
  'altCounterSkill alone': { ...weak, flags: { altCounterSkill: true } },
  'extends unknown': { ...weak, extends: 'skill_nope' },
};
for (const [k, d] of Object.entries(bad)) { const r = checkSkill(d); ok(`malformed (${k}) → reject`, r.verdict === 'reject' && r.valid === false, `${r.verdict} ${r.errors?.join('; ')}`); }

// 4. determinism
const sample = [doom, wall, strong, weak, feeble, pa2, ...builtins];
const runs = [0, 1, 2].map(() => sample.map(d => canonicalJson(checkSkill(d, { baseline: null }))));
ok('same results over 3 runs', runs[1].join('\n') === runs[0].join('\n') && runs[2].join('\n') === runs[0].join('\n'));
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
const tmp = path.join(HERE, 'out', '_s5_test_strong.json');
fs.writeFileSync(tmp, JSON.stringify(strong));
const fresh = JSON.parse(execFileSync(process.execPath, [path.join(HERE, 'skills-rebalancing-check.mjs'), 'check', tmp, '--json', '--no-baseline'], { encoding: 'utf8' }));
ok('fresh process: same stamp', canonicalJson(fresh.stamp) === canonicalJson(rs.stamp), `${canonicalJson(fresh.stamp)} vs ${canonicalJson(rs.stamp)}`);
ok('fresh process: same power', canonicalJson(fresh.power) === canonicalJson(rs.power));
// Cross-platform: a digest of every result, written per platform; any other platform's digest made under the same
// pin must be identical (run the test once under Windows node and once under WSL node).
const pin = computePin();
const digest = core.sha256(runs[0].join('\n'));
const me = `${process.platform}-${process.version}`;
const dFile = path.join(HERE, 'out', `_s5_digest-${me}.json`);
fs.writeFileSync(dFile, JSON.stringify({ platform: me, pin_id: pin.pin_id, digest }) + '\n');
const others = fs.readdirSync(path.join(HERE, 'out')).filter(f => f.startsWith('_s5_digest-') && f !== path.basename(dFile)).map(f => JSON.parse(fs.readFileSync(path.join(HERE, 'out', f), 'utf8'))).filter(o => o.pin_id === pin.pin_id);
for (const o of others) ok(`digest ${me} == ${o.platform}`, o.digest === digest, `${digest.slice(0, 12)} vs ${o.digest.slice(0, 12)}`);
console.log(`determinism: digest ${digest.slice(0, 12)} on ${me}; compared with ${others.length ? others.map(o => o.platform).join(', ') : 'no other platform yet (run under the other node)'}; stamp ${rs.stamp.def_sha256.slice(0, 12)} ${rs.stamp.verdict} ×${rs.stamp.ratio}`);

// 5. tolerance, baseline, pin, effects validator, core parity
ok('default tolerance is 0.30 (band [0.7, 1.3], user ruling 2026-11-18)', rs.tolerance === 0.3 && rs.band.low === 0.7 && rs.band.high === 1.3 && cal.policy.tolerance === 0.3 && DEFAULT_TOLERANCE === 0.3, `${rs.tolerance} [${rs.band.low}, ${rs.band.high}]`);
ok('weak → ok at the default ±30 %', checkSkill(weak).verdict === 'ok', `${checkSkill(weak).verdict}`);
ok('tolerance widens monotonically', [0, 0.05, 0.1, 0.15, 0.3, 0.6, 0.9, 1].map(t => checkSkill(strong, { tolerance: t }).verdict === 'ok').every((v, i, a) => i === 0 || !a[i - 1] || v));
ok('tolerance 0.9 → strong ok', checkSkill(strong, { tolerance: 0.9 }).verdict === 'ok');
{
  const mid = builtins.map(d => checkSkill(d, { baseline: null })).find(r => r.judged_ratio > 1.1 && r.judged_ratio <= 1.3);
  if (mid) ok(`${mid.skill_id} ×${mid.judged_ratio}: ok at 0.30, nerf at 0.10`, mid.verdict === 'ok' && checkSkill(builtins.find(d => d.id === mid.skill_id), { baseline: null, tolerance: 0.10 }).verdict === 'nerf');
  else console.log('tolerance: no built-in between 1.10 and 1.30');
}
const pa = builtins.find(d => d.id === 'skill_powerful_attack');
const paCurve = checkSkill(pa, { baseline: null });
ok('tolerance 0 → an off-curve built-in leaves the band', checkSkill(pa, { baseline: null, tolerance: 0 }).verdict === (paCurve.power.ratio > 1 ? 'nerf' : 'boost'));
const dodge = builtins.find(d => d.id === 'skill_dodge');
const ex = checkSkill({ ...dodge, id: 'skill_test_dodge_on_p', extends: 'skill_dodge', action_type: 'P' });
ok('extends a built-in → baseline mode on it', ex.mode === 'baseline' && ex.baseline.id === 'skill_dodge', `${ex.mode}`);
const exObj = checkSkill(strong, { baseline: weak });
ok('explicit object baseline', exObj.mode === 'baseline' && exObj.baseline.id === weak.id && exObj.judged_ratio > 1);
ok('bad baseline id → reject', checkSkill(strong, { baseline: 'skill_nope' }).verdict === 'reject');
ok('pin stable', canonicalJson(pin) === canonicalJson(computePin()));
ok('pin format/version', pin.format === PIN_FORMAT && PIN_FORMAT === 'chaosd6-skills-validator-pin/1' && pin.validator_version === VALIDATOR_VERSION && /^[0-9a-f]{64}$/.test(pin.pin_id));
ok('pin carries source, core, calibration, engines', [pin.source_sha256, pin.core_sha256, pin.calibration_sha256, pin.engines_sha256].every(h => /^[0-9a-f]{64}$/.test(h)) && 'game/skills.mjs' in pin.engines && 'game/skill-engine.mjs' in pin.engines && 'game/effect-engine.mjs' in pin.engines);
ok('equal weights over the six basic actions (ruling 2026-11-16)', mixUniform);
ok('Force Shield fixed power 6 is priced as die 6 (no roll)', builtins.find(d => d.id === 'skill_force_shield').fixed_power === 6 && checkSkill(builtins.find(d => d.id === 'skill_force_shield'), { baseline: null }).power.cost.retries === 0);
ok('Powerful Attack pays for its Attack lock', checkSkill(builtins.find(d => d.id === 'skill_powerful_attack'), { baseline: null }).power.cost.self_lock > 0);
ok('engines: skills.mjs hashed when present', !SK || /^[0-9a-f]{64}$/.test(pin.engines['game/skills.mjs'] || ''));
ok('verifyPin(own) ok', verifyPin(pin).ok);
const tampered = JSON.parse(JSON.stringify(cal)); tampered.weights.negated_action += 0.01;
ok('calibration change → new pin', computePin(tampered).pin_id !== pin.pin_id);
const noAudit = JSON.parse(JSON.stringify(cal)); noAudit.policy.audit = false;
ok('audit off → engines out of the pin', canonicalJson(computePin(noAudit).engines) === '{}' && computePin(noAudit).pin_id !== pin.pin_id);
ok('verifyPin(foreign) reports the diff', !verifyPin({ ...pin, core_sha256: '0'.repeat(64), pin_id: 'x' }).ok && verifyPin({ ...pin, core_sha256: '0'.repeat(64) }).diffs.includes('core_sha256'));
ok('stamp carries the pin', rs.stamp.pin_id === pin.pin_id);
// The effects validator is untouched by S5: same source bytes, does not import the core, pin id as of 2026-11-16.
// Source sha refreshed 2026-11-18: the effects tolerance ruling (DEFAULT_TOLERANCE 0.30) changed its bytes (was 82ffc898fd83).
// Refreshed again 2026-11-18: effects validator 1.1.0 binds the ref-pinned libs (was 6e0b08de5c3a).
const fxPin = fxv.computePin();
const fxSrc = fs.readFileSync(path.join(HERE, 'rebalancing-check.mjs'), 'utf8');
ok('effects validator source unchanged', fxPin.source_sha256 === 'f1834ad7a8080d7faa4f71db92e59663d9f563f35cee6c59c1f01ff9f289c166', fxPin.source_sha256);
ok('effects validator does not import rebalancing-core', !fxSrc.includes('rebalancing-core'));
if (fxPin.engines_sha256 === '3d66fc7429b93dc618eba71b3666fc422ac25e4d7276131b36e0340565321727') ok('effects pin id unchanged', fxPin.pin_id === '5f8ddbb4640e0842606e6ddfab91c1d50bea0695bf814b8e7cfd6f5c3114d7a0', fxPin.pin_id);
else console.log(`note: effects engines changed since 2026-11-16 (effects.mjs / effect-engine.mjs / libs) → effects pin ${fxPin.pin_id.slice(0, 12)}; not caused by S5`);
// rebalancing-core == the effects validator's copies
let parity = true;
for (let s = 0; s <= 40; s++) {
  if (core.diceCount(s) !== fxv.diceCount(s)) parity = false;
  if (canonicalJson(core.pointBuyStats(s)) !== canonicalJson(fxv.pointBuyStats(s))) parity = false;
}
ok('core diceCount / pointBuyStats == effects validator (stats 0..40)', parity);
const obj = { b: [1, { z: 2, a: null }], a: 'x', u: undefined };
ok('core canonicalJson == effects validator', core.canonicalJson(obj) === fxv.canonicalJson(obj) && core.canonicalJson(cal) === fxv.canonicalJson(cal));
const pts = Object.values(fxv.loadCalibration().builtins).map(b => ({ V: b.value, C: b.actions }));
ok('core fitCurve == effects validator fitCurve', canonicalJson(core.fitCurve(pts)) === canonicalJson(fxv.fitCurve(pts)));

console.log(fails ? `${fails} FAILED, ${passes} passed` : `all skills rebalancing checks passed (${passes})`);
process.exit(fails ? 1 : 0);
