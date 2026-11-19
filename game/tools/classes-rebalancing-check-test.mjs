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
// 1.3.0 (CP 2026-11-19, "do not refit the fair line"): with policy.fit_locked the accepted line is kept and the OLS
// refit is only reported; without the lock the fit is fitCurve over (k, V) as before.
{
  const ols = fitCurve(defs.map(d => { const p = V.powerOf(V.normalizeDef(d), cal); return { C: p.k, V: p.value }; }), { drop: cal.policy.fit_drop, minKeep: 5 });
  if (cal.policy.fit_locked) {
    eq('1.3.0: the fair line is locked at the accepted 5.521349 − 0.495541·k', [cal.fit.a, cal.fit.b], [5.521349, -0.495541]);
    eq('1.3.0: calibrate() keeps a locked line and reports the refit (not written)', [V.calibrate(cal).fit, J(V.calibrate(cal).refit), Object.keys(V.calibrate(cal)).includes('refit')], [cal.fit, J(ols), false]);
    const unl = V.calibrate({ ...cal, policy: { ...cal.policy, fit_locked: undefined } });
    eq('…and an unlocked calibration refits (fitCurve over (k, V))', unl.fit, ols);
  } else eq('fit = rebalancing-core fitCurve over (k, V)', cal.fit, ols);
}
eq('no built-in is beyond the hard cap / floor on the curve', V.report(cal).filter(r => r.curve_verdict === 'reject').map(r => r.id), []);

console.log('-- model');
{
  const n = V.normalizeDef(byId.class_healer);
  const a = V.powerOf(n, cal), b = V.powerOf(n, cal);
  eq('powerOf is deterministic', J(a), J(b));
  eq('a tap class: more colours → fewer uses', V.powerOf({ ...n, k: 5 }, cal).uses < a.uses, true);
  eq('lifetime grows with colours', V.powerOf({ ...n, k: 1 }, cal).lifetime <= V.powerOf({ ...n, k: 6 }, cal).lifetime, true);
  eq('once_per_round = one use per turn', V.powerOf(V.normalizeDef(byId.class_priest), cal).uses, cal.game.turns);
  eq('doubling the heal doubles its component (to the r6 rounding)', Math.abs(V.powerOf({ ...n, power: { heal: { n: 2, ally: 2, unmoved: true, ally_required: true } } }, cal).components.heal.value - a.components.heal.value * 2) < 3e-6, true);
}

console.log('-- checkClass');
eq('every built-in is ok in baseline mode (judged 1)', defs.map(d => V.checkClass(d)).filter(r => r.verdict !== 'ok' || r.judged_ratio !== 1).map(r => r.class_id), []);
// 1.1.0 foreign limits (user ruling 2026-11-17): the Witch is a HAND class (discard / hand_discard) → no foreign copy;
// the copies below use the Healer (a tap class whose ability runs as data).
// CR 2026-11-17: the Healer heals me AND an adjacent ally — power.heal {n: 1, ally: 1}; healN rewrites both heals.
const healN = (n) => JSON.parse(J(byId.class_healer).replaceAll('"amount":1', `"amount":${n}`));
const HEAL1 = { n: 1, ally: 1, unmoved: true, ally_required: true }, HEAL2 = { n: 2, ally: 2, unmoved: true, ally_required: true };   // + CP 2026-11-19 gates
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
  const r = V.checkClass({ ...healN(2), id: 'class_mender', power: { heal: HEAL2 } });
  eq('a Healer copy with its own power is judged on the curve', [r.mode, r.verdict], ['curve', 'nerf']);
  eq('…and gets a scale hint', r.suggestions.some(s => /scale the power/.test(s.change)), true);
  const r2 = V.checkClass(copy('class_healer', { id: 'class_mender', power: { heal: HEAL1 } }), { baseline: 'class_healer' });
  eq('…the same against the Healer baseline is ok', [r2.mode, r2.verdict, r2.judged_ratio], ['baseline', 'ok', 1]);
  const r3 = V.checkClass({ ...healN(2), id: 'class_mender', power: { heal: HEAL2 } }, { baseline: 'class_healer' });
  eq('a Healer healing 2 vs the Healer → nerf', r3.verdict, 'nerf');
  eq('baseline as a definition object = baseline by id', V.checkClass(copy('class_healer', { id: 'class_mender', power: { heal: HEAL1 } }), { baseline: byId.class_healer }).judged_ratio, 1);
  eq('stamp carries pin, def sha, verdict', Object.keys(r.stamp).sort(), ['class_id', 'def_sha256', 'pin_id', 'ratio', 'tolerance', 'verdict']);
}
{
  // 1.1.0 model answers
  const p = (id) => V.powerOf(V.normalizeDef(byId[id]), cal);
  const c0 = { ...cal, game: { ...cal.game, p_recharge_emit: 0 } };
  eq('tap recharge-by-emission raises the uses of every tap class', defs.filter(d => d.data.ability_kind === 'tap' && V.normalizeDef(d).kind === 'tap').filter(d => !(p(d.id).uses > V.powerOf(V.normalizeDef(d), c0).uses)).map(d => d.id), []);
  eq('W.recover = 0.7 (weight answer 2)', cal.weights.recover, 0.7);
  // 1.2.0 (CR 2026-11-17/18) model answers
  eq('1.2.0: the bare 1.1.0 shapes keep their value (heal 1 = {n: 1}, draw 1 = {n: 1})', [V.keyValue('heal', 1, cal.game, cal.weights), V.keyValue('draw', 1, cal.game, cal.weights)], [V.keyValue('heal', { n: 1 }, cal.game, cal.weights), V.keyValue('draw', { n: 1 }, cal.game, cal.weights)]);
  eq('1.2.0: heal {n: 1, ally: 1} = own heal + an adjacent ally × allies(1)', Math.round(V.keyValue('heal', { n: 1, ally: 1 }, cal.game, cal.weights) * 1e6) / 1e6, Math.round((1 + cal.game.allies_max / (1 + cal.game.allies_half)) * cal.weights.life * cal.game.p_hurt * 1e6) / 1e6);
  eq('1.2.0: Elementalist reroll is per action (36 times)', [p('class_elementalist').components.reroll.trigger, p('class_elementalist').components.reroll.times], ['action', cal.game.turns * cal.game.actions_per_turn]);
  eq('1.2.0: Druid two stones = twice one stone', Math.abs(V.keyValue('stone', { n: 2 }, cal.game, cal.weights) - 2 * V.keyValue('stone', true, cal.game, cal.weights)) < 1e-9, true);
  eq('1.2.0: Witch range 1 gates on p_contact', p('class_witch').components.discard.gate, cal.game.p_contact);
  eq('1.2.0: Rogue one shared charge < the two separate charges', V.keyValue('dodge', 1, cal.game, cal.weights) < V.keyValue('trap_dodge', 1, cal.game, cal.weights) + V.keyValue('threat_dodge', 1, cal.game, cal.weights), true);
  eq('1.2.0: one Shrine standing caps the Priest below two', p('class_priest').components.build.value < V.powerOf({ ...V.normalizeDef(byId.class_priest), power: { build: { max: 2, heal: 2 } } }, cal).components.build.value, true);
  eq('1.2.0: bad object shapes are refused', [V.validateNorm({ ...V.normalizeDef(byId.class_healer), id: 'class_x', power: { heal: { ally: 1 } } }).length > 0, V.validateNorm({ ...V.normalizeDef(byId.class_healer), id: 'class_x', power: { regen: { n: 1, still: [4] } } }).length > 0, V.validateNorm({ ...V.normalizeDef(byId.class_healer), id: 'class_x', power: { heal: { n: 1, bogus: 1 } } }).length > 0], [true, true, true]);
  eq('every swarm placeholder is a game param of the same value', Object.entries(cal.swarm_placeholders).filter(([k, v]) => cal.game[k] !== v.value || !/needs a swarm measurement/.test(v.status)).map(([k]) => k), []);
  eq('Witch: the range gate is in the uses, not in the value per use (3 cards, − 1 of her own: CP 2026-11-19)', [p('class_witch').components.discard.per, p('class_witch').components.discard.times < p('class_witch').uses], [Math.round(cal.weights.card * (3 - 1) * 1e6) / 1e6, true]);
  // 1.3.0 (CP 2026-11-19, the user's picks of "Proposals 2026-11-19") model answers
  const kv = (k, v) => V.keyValue(k, v, cal.game, cal.weights);
  const pb = (await import('./rebalancing-core.mjs')).pointBuyStats(cal.game.stat_mean);
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  eq('1.3.0 Weapon master (pick 1 a): draw 2 while hand ≤ 3 = twice draw 1 (both × p_hand_small)', [J(V.BUILTIN_POWER.class_weapon_master), close(kv('draw', { n: 2, hand_max: 3 }), 2 * kv('draw', { n: 1, hand_max: 3 }))], [J({ draw: { n: 2, hand_max: 3 } }), true]);
  eq('1.3.0 Druid (pick 2 b): a chained 2nd stone = (1 + p) stones, p = point-buy success at stat_mean', [close(kv('stone', { n: 2, chain: true }), (1 + pb.p) * kv('stone', true)), kv('stone', { n: 2, chain: true }) < kv('stone', { n: 2 })], [true, true]);
  eq('1.3.0 Healer (pick 4 a): gate = p_unmoved_action × p_ally_adjacent; the ally heal is certain', [p('class_healer').components.heal.gate, p('class_healer').components.heal.per], [Math.round(cal.game.p_unmoved_action * cal.game.p_ally_adjacent * 1e6) / 1e6, Math.round(2 * cal.weights.life * cal.game.p_hurt * 1e6) / 1e6]);
  // 1.3.0 CP2 (the user's answers 2026-11-19): data untap_emissions N — the untap takes max(k, N) emissions
  {
    const hn = V.normalizeDef(byId.class_healer), G = cal.game;
    const untapOf = (em) => em / (G.p_restore + (G.p_recharge_emit || 0) * V.rechargeShare(hn.colours));
    const A = G.turns * G.actions_per_turn, gate = p('class_healer').components.heal.gate;
    const usesOf = (em) => 1 + (A - 1) / (1 + untapOf(em) + (1 - gate) / gate);
    const withN = (N) => V.powerOf({ ...hn, data: { ...hn.data, untap_emissions: N } }, cal);
    eq('1.3.0 CP2 Healer: data untap_emissions 4 over 3 colours; the gated uses = 1 + (A − 1)/(1 + 4/rate + wait)', [hn.data.untap_emissions, hn.k, close(p('class_healer').components.heal.times, Math.round(usesOf(4) * 1e6) / 1e6) || Math.abs(p('class_healer').components.heal.times - usesOf(4)) < 1e-5], [4, 3, true]);
    eq('1.3.0 CP2: untap_emissions ≤ k changes nothing; longer is weaker', [J(withN(3)), J(withN(2)) === J(withN(undefined)), withN(5).value < withN(4).value, withN(4).value < withN(undefined).value], [J(withN(undefined)), true, true, true]);
    eq('1.3.0 CP2: a bad untap_emissions is refused', ['5', 0, 1.5, 21].map(N => V.validateNorm({ ...hn, id: 'class_x', data: { ...hn.data, untap_emissions: N } }).some(e => /untap_emissions/.test(e))), [true, true, true, true]);
    eq('1.3.0 CP2 Druid: data fail_spends needs no new term (stone {chain} already prices a failed roll as a spent use)', [byId.class_druid.data.fail_spends, J(V.BUILTIN_POWER.class_druid)], [true, J({ stone: { n: 2, chain: true, unmoved: true } })]);
    const dn = V.normalizeDef(byId.class_druid), dg = V.powerOf(dn, cal), du = V.powerOf({ ...dn, power: { stone: { n: 2, chain: true } } }, cal);
    eq('1.3.0 CPD Druid (option C): stone {unmoved} gates the tap at p_unmoved_action; the value per use is unchanged, the uses fewer', [byId.class_druid.data.unmoved_only, dg.components.stone.gate, dg.components.stone.per === du.components.stone.per, dg.components.stone.times < du.components.stone.times], [true, cal.game.p_unmoved_action, true, true]);
    eq('1.3.0 CPD: a bad stone.unmoved is refused', V.validateNorm({ ...dn, id: 'class_x', power: { stone: { n: 2, unmoved: 'yes' } } }).length > 0, true);
  }
  eq('1.3.0 Healer: a gated use is fewer than an ungated one', p('class_healer').components.heal.times < V.powerOf({ ...V.normalizeDef(byId.class_healer), power: { heal: { n: 1, ally: 1 } } }, cal).components.heal.times, true);
  eq('1.3.0 Priest (pick 5 a): the Shrine heals 2 = twice the build value (one Shrine standing)', Math.abs(p('class_priest').components.build.value - 2 * V.powerOf({ ...V.normalizeDef(byId.class_priest), power: { build: { max: 1 } } }, cal).components.build.value) < 3e-6, true);
  eq('1.3.0 Witch (pick 8 a): discard {n: 3, self: 1} = (3 − 1) × W.card', close(kv('discard', { n: 3, range: 1, self: 1 }), 2 * cal.weights.card), true);
  eq('1.3.0 Avenger (pick 9 a): a max-only chase bonus = × p_hurt', close(kv('chase_bonus', { life: 1, max: 1, max_only: true }), kv('chase_bonus', { life: 1, max: 1 }) * cal.game.p_hurt), true);
  eq('1.3.0: bad new fields are refused', [{ stone: { n: 2, chain: 1 } }, { heal: { n: 1, unmoved: 'yes' } }, { discard: { n: 3, self: 0 } }, { build: { max: 1, heal: 0 } }, { chase_bonus: { life: 1, max: 1, max_only: 1 } }, { chase_bonus: { life: 1, bogus: true } }].map(power => V.validateNorm({ ...V.normalizeDef(byId.class_healer), id: 'class_x', power }).length > 0), [true, true, true, true, true, true]);
  eq('Summoner grant = W.card × V(effect_summoning) / mean V', p('class_summoner').components.grant.per, Math.round(cal.weights.card * cal.grants.effects.effect_summoning / cal.grants.mean_value * 1e6) / 1e6);
}

console.log('-- logic audit');
const hl = byId.class_healer;
eq('a std override (life_points absorbs everything) → reject', V.checkClass(copy('class_healer', { id: 'class_tank', power: { heal: 1 }, hooks: { ...hl.hooks, life_points: { obj: { illusion: 0, armor: 0, chaseBonus: 0, absorbed: { var: 'dmg' } } } } })).reasons.some(r => /std hook life_points/.test(r)), true);
eq('a std override that equals the rule is fine', V.checkClass(copy('class_healer', { id: 'class_mender', extends: 'class_healer', hooks: { ...hl.hooks, kind: { call: ['kind'] } } })).verdict, 'ok');
eq('an unpriced hook → reject', V.checkClass(copy('class_healer', { id: 'class_brute', power: { heal: 1 }, hooks: { ...hl.hooks, attack_out: { '+': [{ var: 'dmg' }, 2] } } })).reasons.some(r => /not priced/.test(r)), true);
eq('more than the declared attack bonus → reject', V.checkClass(copy('class_healer', { id: 'class_brute', power: { heal: 1, attack_bonus: 1 }, hooks: { ...hl.hooks, attack_out: { '+': [{ var: 'dmg' }, 2] } } })).reasons.some(r => /attack_out \+2 > power.attack_bonus 1/.test(r)), true);
eq('an ability output with no power key → reject', V.checkClass(copy('class_healer', { id: 'class_brute', power: { armor: 1 } })).reasons.some(r => /heals \d > power.heal 0/.test(r)), true);
eq('1.3.0: a Witch copy discarding 2 of her own beyond power.discard.self 1 → reject (the audit bounds own discards)', (() => { const w2 = JSON.parse(J(byId.class_witch).replace('"self_discard":1', '"self_discard":2')); return V.auditLogic(w2, V.normalizeDef(w2), cal); })().exceeds.some(x => /own\) > power.discard/.test(x)), true);
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
