// Class-state store check (class isolation phase 2): game/class-state.mjs — canonical snapshot bytes, pruning,
// charges = class-traps.mjs#chargesLeft over the old (turn, n) fields, parse cache, union order independence.
//   node tools/class-state-check.mjs   → "all class-state checks passed (N ok)"
import * as CS from '../class-state.mjs';
import { chargesLeft } from '../world-prims.mjs';   // class isolation phase 6 (were class-*.mjs)
import { canonicalJson } from '../defs-repo.mjs';

let okN = 0, bad = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { okN++; return true; }
  bad++; console.log(`FAIL ${label}\n     got  ${g}\n     want ${w}`); return false;
};

// ---- 1. snapshot bytes
eq('empty store → ""', CS.classStateJson({}), '');
eq('only empty values → ""', CS.classStateJson({ class_a: { chasers: [], x: {} }, class_b: {} }), '');
eq('0 / false are kept', CS.classStateJson({ class_a: { bonus: 0, on: false } }), '{"class_a":{"bonus":0,"on":false}}');
const a = { class_z: { b: 1, a: [3, 1] }, class_a: { charges: { trap: { turn: 4, n: 1 } } } };
const b = { class_a: { charges: { trap: { n: 1, turn: 4 } } }, class_z: { a: [3, 1], b: 1 } };
eq('key order does not change the bytes', CS.classStateJson(a), CS.classStateJson(b));
eq('= defs-repo canonicalJson', CS.classStateJson(a), canonicalJson(a));
eq('array order is kept', CS.classStateJson({ c: { l: ['b', 'a'] } }), '{"c":{"l":["b","a"]}}');

// ---- 2. parse
eq('"" / bad / non-object → {}', ['', 'nope', '[1]', '3', null, undefined].map(x => CS.parseClassState(x)), [{}, {}, {}, {}, {}, {}]);
const s = CS.classStateJson(a);
eq('round trip', CS.classStateJson(CS.parseClassState(s)), s);
eq('cached and frozen', [CS.parseClassState(s) === CS.parseClassState(s), Object.isFrozen(CS.parseClassState(s).class_z.a)], [true, true]);
const local = { class_a: {} };
eq('a local store is its own state', CS.parseClassState(local) === local, true);

// ---- 3. charges = chargesLeft(perTurn, usedTurn, usedN, turn) over the old fields
let same = true;
for (const per of [0, 1, 2, 3]) for (const ut of [-1, 0, 3, 4]) for (const un of [0, 1, 2, 5]) for (const turn of [0, 3, 4]) {
  const st = ut < 0 ? {} : { class_rogue: { charges: { trap: { turn: ut, n: un } } } };
  if (CS.chargeLeft(st, 'class_rogue', 'trap', per, turn) !== chargesLeft(per, ut, un, turn)) { same = false; console.log('  differs', { per, ut, un, turn }); }
}
eq('chargeLeft = chargesLeft for every (perTurn, turn, n, now)', same, true);
const st = {};
eq('spend in turn 3 ×2', [CS.spendCharge(st, 'class_rogue', 'trap', 3), CS.spendCharge(st, 'class_rogue', 'trap', 3)], [1, 2]);
eq('a new turn starts over', CS.spendCharge(st, 'class_rogue', 'trap', 5, 2), 2);
eq('chargeTurn / used', [CS.chargeTurn(st, 'class_rogue', 'trap'), CS.chargeUsed(st, 'class_rogue', 'trap', 5), CS.chargeUsed(st, 'class_rogue', 'trap', 4)], [5, 2, 0]);
eq('chargeTurn of a never-used charge = -1 (old stealth_turn default)', CS.chargeTurn({}, 'class_rogue', 'threat'), -1);
eq('anyChargeUsed over every class', [CS.anyChargeUsed(st, 'trap', 5), CS.anyChargeUsed(st, 'trap', 4), CS.anyChargeUsed(st, 'threat', 5)], [true, false, false]);

// ---- 4. keyed values, union
const kv = {};
CS.stateSet(kv, 'class_necromancer', 'raised', ['peer:b', 'peer:a']);
eq('stateGet / default', [CS.stateGet(kv, 'class_necromancer', 'raised', []), CS.stateGet(kv, 'class_x', 'raised', 'd')], [['peer:b', 'peer:a'], 'd']);
const u1 = CS.unionOf([CS.classStateJson(kv), '', CS.classStateJson({ class_q: { raised: ['peer:c', 'peer:a'] } })], 'raised');
const u2 = CS.unionOf([CS.classStateJson({ class_q: { raised: ['peer:a', 'peer:c'] } }), CS.classStateJson(kv)], 'raised');
eq('union = every listed id, whatever the unit / class order', [...u1].sort(), [...u2].sort());
eq('union content', [...u1].sort(), ['peer:a', 'peer:b', 'peer:c']);

console.log(bad ? `${bad} class-state check(s) FAILED (${okN} ok)` : `all class-state checks passed (${okN} ok)`);
process.exit(bad ? 1 : 0);
