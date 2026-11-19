// Tests of tools/classes-rebalancing-check.mjs (chaosD6-Classes C5).   node tools/classes-rebalancing-check-test.mjs
// → ends with "all classes-rebalancing tests passed".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as V from './classes-rebalancing-check.mjs';
import { fitCurve, canonicalJson } from './rebalancing-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fails = 0, oks = 0;
const J = (x) => JSON.stringify(x);
const eq = (label, got, want) => { const ok = J(got) === J(want); if (ok) oks++; else fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n     got  ${J(got)?.slice(0, 400)}\n     want ${J(want)?.slice(0, 400)}`}`); };
const cal = V.loadCalibration();
const defs = V.loadBuiltinDefs();
const byId = Object.fromEntries(defs.map(d => [d.id, d]));
const copy = (id, over = {}) => ({ ...JSON.parse(J(byId[id])), ...over });

console.log('-- calibration');
eq('tolerance ±30 % (user ruling 2026-11-18, was ±10 %)', cal.policy.tolerance, 0.3);
eq('DEFAULT_TOLERANCE 0.30', V.DEFAULT_TOLERANCE, 0.3);
eq('every built-in has a BUILTIN_POWER entry', defs.filter(d => !V.BUILTIN_POWER[d.id]).map(d => d.id), []);
eq('BUILTIN_POWER has no stray ids', Object.keys(V.BUILTIN_POWER).filter(id => !byId[id]), []);
eq('every BUILTIN_POWER entry validates', defs.flatMap(d => V.validateNorm(V.normalizeDef(d))), []);
eq('calibrate() reproduces the committed calibration (fit + builtins)', canonicalJson(V.calibrate(cal)), canonicalJson(cal));
eq('fit = rebalancing-core fitCurve over (k, V)', cal.fit, fitCurve(defs.map(d => { const p = V.powerOf(V.normalizeDef(d), cal); return { C: p.k, V: p.value }; }), { drop: cal.policy.fit_drop, minKeep: 5 }));
eq('no built-in is beyond the hard cap / floor on the curve', V.report(cal).filter(r => r.curve_verdict === 'reject').map(r => r.id), []);

console.log('-- model');
{
  const n = V.normalizeDef(byId.class_healer);
  const a = V.powerOf(n, cal), b = V.powerOf(n, cal);
  eq('powerOf is deterministic', J(a), J(b));
  eq('a tap class: more colours → fewer uses', V.powerOf({ ...n, k: 5 }, cal).uses < a.uses, true);
  eq('lifetime grows with colours', V.powerOf({ ...n, k: 1 }, cal).lifetime <= V.powerOf({ ...n, k: 6 }, cal).lifetime, true);
  eq('once_per_round = one use per turn', V.powerOf(V.normalizeDef(byId.class_priest), cal).uses, cal.game.turns);
  eq('doubling the heal doubles its component (to the r6 rounding)', Math.abs(V.powerOf({ ...n, power: { heal: 2 } }, cal).components.heal.value - a.components.heal.value * 2) < 3e-6, true);
}

console.log('-- checkClass');
eq('every built-in is ok in baseline mode (judged 1)', defs.map(d => V.checkClass(d)).filter(r => r.verdict !== 'ok' || r.judged_ratio !== 1).map(r => r.class_id), []);
// 1.1.0 foreign limits (user ruling 2026-11-17): the Witch is a HAND class (discard / hand_discard) → no foreign copy;
// the copies below use the Healer (a tap class whose ability runs as data).
const healN = (n) => JSON.parse(J(byId.class_healer).replace('"amount":1', `"amount":${n}`));
eq('an `extends` copy of the Healer is ok', V.checkClass(copy('class_healer', { id: 'class_mender', extends: 'class_healer' })).verdict, 'ok');
eq('a foreign class without power is rejected', V.checkClass(copy('class_healer', { id: 'class_mender' })).verdict, 'reject');
eq('unknown power key rejected', V.checkClass(copy('class_healer', { id: 'class_mender', power: { heal: 1, teleport: true } })).errors.some(e => /teleport/.test(e)), true);
eq('bad colours rejected', V.checkClass(copy('class_healer', { id: 'class_mender', power: { heal: 1 }, data: { ...byId.class_healer.data, colors: ['elem_fire', 'elem_fire'] } })).verdict, 'reject');
eq('a foreign hand class (Witch copy) is rejected', V.checkClass(copy('class_witch', { id: 'class_hexer', extends: 'class_witch' })).errors.some(e => /hand class/.test(e)), true);
eq('a foreign hand class (Prophet copy, reveal) is rejected', V.checkClass(copy('class_prophet', { id: 'class_seer', extends: 'class_prophet' })).errors.some(e => /hand class/.test(e)), true);
eq('a foreign PASSIVE class is allowed (Rogue copy: flags.passiveTurn)', (() => { const r = V.checkClass(copy('class_rogue', { id: 'class_sneak', extends: 'class_rogue' })); return [r.errors, r.verdict]; })(), [[], 'ok']);
eq('a foreign PASSIVE class is allowed (Elementalist copy)', V.checkClass(copy('class_elementalist', { id: 'class_sparker', extends: 'class_elementalist' })).verdict, 'ok');
{
  // heal 2 (not the Healer's 1): out of band on the curve whatever the fit
  const r = V.checkClass({ ...healN(2), id: 'class_mender', power: { heal: 2 } });
  eq('a Healer copy with its own power is judged on the curve', [r.mode, r.verdict], ['curve', 'nerf']);
  eq('…and gets a scale hint', r.suggestions.some(s => /scale the power/.test(s.change)), true);
  const r2 = V.checkClass(copy('class_healer', { id: 'class_mender', power: { heal: 1 } }), { baseline: 'class_healer' });
  eq('…the same against the Healer baseline is ok', [r2.mode, r2.verdict, r2.judged_ratio], ['baseline', 'ok', 1]);
  const r3 = V.checkClass({ ...healN(2), id: 'class_mender', power: { heal: 2 } }, { baseline: 'class_healer' });
  eq('a Healer healing 2 vs the Healer → nerf', r3.verdict, 'nerf');
  eq('baseline as a definition object = baseline by id', V.checkClass(copy('class_healer', { id: 'class_mender', power: { heal: 1 } }), { baseline: byId.class_healer }).judged_ratio, 1);
  eq('stamp carries pin, def sha, verdict', Object.keys(r.stamp).sort(), ['class_id', 'def_sha256', 'pin_id', 'ratio', 'tolerance', 'verdict']);
}
{
  // 1.1.0 model answers
  const p = (id) => V.powerOf(V.normalizeDef(byId[id]), cal);
  const c0 = { ...cal, game: { ...cal.game, p_recharge_emit: 0 } };
  eq('tap recharge-by-emission raises the uses of every tap class', defs.filter(d => d.data.ability_kind === 'tap' && V.normalizeDef(d).kind === 'tap').filter(d => !(p(d.id).uses > V.powerOf(V.normalizeDef(d), c0).uses)).map(d => d.id), []);
  eq('W.recover = 0.7 (weight answer 2)', cal.weights.recover, 0.7);
  eq('every swarm placeholder is a game param of the same value', Object.entries(cal.swarm_placeholders).filter(([k, v]) => cal.game[k] !== v.value || !/needs a swarm measurement/.test(v.status)).map(([k]) => k), []);
  eq('Witch: the range gate is in the uses, not in the value per use', [p('class_witch').components.discard.per, p('class_witch').components.discard.times < p('class_healer').uses], [Math.round(cal.weights.card * 3 * 1e6) / 1e6, true]);
  eq('Summoner grant = W.card × V(effect_summoning) / mean V', p('class_summoner').components.grant.per, Math.round(cal.weights.card * cal.grants.effects.effect_summoning / cal.grants.mean_value * 1e6) / 1e6);
}

console.log('-- logic audit');
const hl = byId.class_healer;
eq('a std override (life_points absorbs everything) → reject', V.checkClass(copy('class_healer', { id: 'class_tank', power: { heal: 1 }, hooks: { ...hl.hooks, life_points: { obj: { illusion: 0, armor: 0, chaseBonus: 0, absorbed: { var: 'dmg' } } } } })).reasons.some(r => /std hook life_points/.test(r)), true);
eq('a std override that equals the rule is fine', V.checkClass(copy('class_healer', { id: 'class_mender', extends: 'class_healer', hooks: { ...hl.hooks, kind: { call: ['kind'] } } })).verdict, 'ok');
eq('an unpriced hook → reject', V.checkClass(copy('class_healer', { id: 'class_brute', power: { heal: 1 }, hooks: { ...hl.hooks, attack_out: { '+': [{ var: 'dmg' }, 2] } } })).reasons.some(r => /not priced/.test(r)), true);
eq('more than the declared attack bonus → reject', V.checkClass(copy('class_healer', { id: 'class_brute', power: { heal: 1, attack_bonus: 1 }, hooks: { ...hl.hooks, attack_out: { '+': [{ var: 'dmg' }, 2] } } })).reasons.some(r => /attack_out \+2 > power.attack_bonus 1/.test(r)), true);
eq('an ability output with no power key → reject', V.checkClass(copy('class_healer', { id: 'class_brute', power: { armor: 1 } })).reasons.some(r => /heals 1 > power.heal 0/.test(r)), true);
eq('a peer-resolved (js) ability on a foreign class is refused by the engine', V.checkClass(copy('class_priest', { id: 'class_shrine', extends: 'class_priest' })).verdict, 'reject');
eq('every built-in audits clean', defs.map(d => [d.id, V.auditLogic(d, V.normalizeDef(d), cal).exceeds]).filter(([, e]) => e.length), []);

console.log('-- pin');
{
  const p = V.computePin(cal);
  eq('pin format / validator', [p.format, p.validator, p.validator_version], ['chaosd6-classes-validator-pin/1', 'classes-rebalancing-check', V.VALIDATOR_VERSION]);
  eq('pin hashes the engines (classes.mjs, class-engine.mjs, effect-engine.mjs, class-*.mjs, lib)', Object.keys(p.engines).sort(), ['game/class-chase.mjs', 'game/class-engine.mjs', 'game/class-manipulator.mjs', 'game/class-traps.mjs', 'game/class-world.mjs', 'game/classes-data/lib/classes_std.json', 'game/classes.mjs', 'game/effect-engine.mjs']);
  eq('verifyPin(own pin) ok', V.verifyPin(p, cal).ok, true);
  eq('verifyPin(tampered) fails on pin_id', V.verifyPin({ ...p, pin_id: 'x' }, cal).diffs, ['pin_id']);
  const cal2 = JSON.parse(J(cal)); cal2.weights.life = 1.01;
  eq('a different calibration → a different pin', V.computePin(cal2).pin_id !== p.pin_id, true);
  eq('pin does not read data/*.json (self-contained source)', /data\/classes\.json|'data', 'classes/.test(fs.readFileSync(path.join(HERE, 'classes-rebalancing-check.mjs'), 'utf8')), false);
}

console.log(fails ? `${fails} classes-rebalancing test(s) FAILED (${oks} ok)` : `all classes-rebalancing tests passed (${oks} ok)`);
process.exit(fails ? 1 : 0);
