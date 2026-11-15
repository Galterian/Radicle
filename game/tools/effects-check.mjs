// Effect engine check against the worked examples from the pc rule overrides.
//   node tools/effects-check.mjs
import { createHash } from 'node:crypto';
import { manipulatorConfig, pickAltAction, combatHit, pickManipTarget, applyManipSwap } from '../class-manipulator.mjs';
import { diceCount, pointBuy, resolveEffect, roundHalfUp10, trapDamageSum, invisibilityBreaks } from '../effects.mjs';
import { pickBySalt, pickHandDiscards } from '../effects.mjs';
import { rogueConfig, clericConfig, chargesLeft, trapsInRange, clericRoute, disabledCardMoves } from '../class-traps.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
let fails = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

// Dice count: 6n nearest the stat, ties → more dice.
eq('dice 15', diceCount(15), 3); eq('dice 8', diceCount(8), 1); eq('dice 9', diceCount(9), 2); eq('dice 20', diceCount(20), 3); eq('dice 3', diceCount(3), 1);
// Point-buy: sum ≤ stat keeps the highest die, otherwise it fails (retry).
{ let fail = 0, okv = 0; for (let i = 0; i < 200; i++) { const r = pointBuy(15, `s${i}`, sha); if (r.fail) fail++; else { okv++; if (r.value < 1 || r.value > 6 || r.dice.reduce((a, b) => a + b, 0) > 15) fails++; } } console.log(`ok   point-buy(15) over 200 seeds: ${okv} kept, ${fail} failed (sum > 15)`); }
eq('point-buy stat 0', pointBuy(0, 'x', sha), { fail: false, dice: [], value: 0 });

// A tiny world: caster C, enemy E, enemy F, ally A.
const ELEM_TO_STAT = { elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' };
function world(stats, tiles, sides, opts = {}) {
  const pen = opts.pen || {};          // id → { elem: amount }
  const perms = opts.perms || {};
  return {
    me: 'C',
    elemStat: el => ELEM_TO_STAT[el],
    statFor: (id, el) => Math.max(0, stats[id][ELEM_TO_STAT[el]] - (pen[id]?.[el] || 0)),
    baseStat: (id, sk) => stats[id][sk],
    lifeOf: id => opts.life?.[id] ?? 4,
    enemyOf: (a, b) => sides[a] !== sides[b],
    dist: (a, b) => Math.max(Math.abs(tiles[a].q - tiles[b].q), Math.abs(tiles[a].r - tiles[b].r), Math.abs((tiles[a].q + tiles[a].r) - (tiles[b].q + tiles[b].r))),
    tileOf: id => tiles[id],
    isFree: (q, r) => !Object.values(tiles).some(t => t.q === q && t.r === r),
    neighbours: (q, r) => [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]].map(([dq, dr]) => ({ q: q + dq, r: r + dr })),
    hasPerm: (id, p) => !!perms[id]?.includes(p),
    shieldedAgainst: (id, el) => !!opts.shield?.[id]?.includes(el),
    disabledElems: id => new Set(opts.disabled?.[id] || []),
    invisible: id => !!perms[id]?.includes('effect_invisibility'),
    peers: () => Object.keys(tiles).sort(),
    sha, actionIndex: 7,
    threatElem: () => 'elem_fire',
    castElemOf: () => 'elem_fire',
  };
}
const M = (v, w, m, wi) => ({ vitality: v, world: w, matter: m, will: wi });
const tiles = { C: { q: 0, r: 0 }, E: { q: 1, r: 0 }, F: { q: 0, r: 1 }, A: { q: -1, r: 0 } };
const sides = { C: 'player', E: 'npc_b', F: 'npc_b', A: 'player' };
const dmgTo = (oc, id) => { const h = oc.hits.find(h => h.victim === id); return h ? h.legs.map(l => roundHalfUp10(l.sum)) : null; };

// Lightning (fire+air), enemy caster Matter 16 vs my Matter 8 → (16−8)+(16−8) = 16 → 2.
// With my Counter Spell on fire: (16−8−8) + (16−8) = 8 → 1.
{
  const stats = { C: M(10, 10, 16, 10), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 10, 8, 10) };
  const cast = { actor: 'C', effect_id: 'effect_lightning', elements: ['elem_fire', 'elem_air'], salt: 'abc', target: { kind: 'character', ref: 'E' }, is_instant: false };
  eq('lightning 16 vs 8', dmgTo(resolveEffect(world(stats, tiles, sides), cast), 'E'), [2]);
  eq('lightning countered on fire', dmgTo(resolveEffect(world(stats, tiles, sides, { pen: { C: { elem_fire: 8 } } }), cast), 'E'), [1]);
  eq('lightning locks 1 action', resolveEffect(world(stats, tiles, sides), cast).locks, [{ on: 'E', n: 1, by: 'C', effect_id: 'effect_lightning' }]);
  eq('double-cast lightning locks 2 actions', resolveEffect(world(stats, tiles, sides), { ...cast, every: true }).locks.map(l => l.n), [2]);
  // Meteor Shower hits every unit within 10 hexes — me, my ally, both enemies (F out at 6).
  const far = { ...tiles, F: { q: 6, r: 0 } };
  const ms = { ...cast, effect_id: 'effect_meteor_shower', elements: ['elem_fire', 'elem_fire', 'elem_fire'], of: 3, step: 3, kept: [3, 4, 5] };
  const mstats = { ...stats, C: M(10, 10, 30, 10) };
  eq('meteor shower hits everyone within 10 hexes, caster included', resolveEffect(world(mstats, far, sides), { ...ms, target: null }).hits.map(h => h.victim), ['A', 'C', 'E', 'F']);
  // Mutate on an enemy: big die as a penalty on their best stat, small die as a bonus on their weakest.
  const mu = resolveEffect(world({ ...stats, C: M(30, 10, 16, 10) }, tiles, sides), { ...cast, effect_id: 'effect_mutate', elements: ['elem_vitality'] });   // Vitality 30: five dice never overshoot
  // E is 10/10/8/10: biggest (tie → matter? no: matter is 8, the smallest) → biggest tie among 10s resolves to 'will' (order V, W, Wi, M).
  eq('mutate vs enemy: big die penalty on their biggest, small die bonus on their smallest', mu.statTokens.map(t => [t.stat, Math.sign(t.value)]), [['will', -1], ['matter', 1]]);
  const muSelf = resolveEffect(world({ ...stats, C: M(30, 10, 10, 10) }, { ...tiles, E: { q: 5, r: 0 }, F: { q: 5, r: 1 } }, sides), { ...cast, effect_id: 'effect_mutate', elements: ['elem_vitality'], target: null });
  eq('mutate on myself: big die bonus on my smallest (tie → world), small die penalty on my biggest', muSelf.statTokens.map(t => [t.stat, Math.sign(t.value)]), [['world', 1], ['vitality', -1]]);
}
// Fireball (fire+fire) Matter 15 vs 7: main (15−7)×2 = 16 → 2, plus a point-buy token leg.
// Countered (−7 on fire): (15−7−7)×2 = 2 → 0; token point-buy on 8.
{
  const stats = { C: M(10, 10, 15, 10), E: M(10, 10, 7, 10), F: M(10, 10, 7, 10), A: M(10, 10, 7, 10) };
  const cast = { actor: 'C', effect_id: 'effect_fireball', elements: ['elem_fire', 'elem_fire'], salt: 'abc', target: { kind: 'character', ref: 'E' }, is_instant: false };
  const oc = resolveEffect(world(stats, tiles, sides), cast);
  const legs = dmgTo(oc, 'E');
  eq('fireball main leg', legs?.[0], 2);
  console.log(`ok   fireball token leg: ${oc.status === 'retry' ? 'point-buy failed → retry' : `die ${oc.hits[0].legs[1].sum} → ${legs[1]} dmg`}`);
  const oc2 = resolveEffect(world(stats, tiles, sides, { pen: { C: { elem_fire: 7 } } }), cast);
  if (oc2.status === 'done') eq('fireball countered main leg', dmgTo(oc2, 'E')[0], 0); else console.log('ok   fireball countered: point-buy failed → retry');
  // Elementalist (class, user ruling 2026-10-30): the extra point-buy die rides on the main leg before rounding: 16 + 5 = 21 → 2; 16 + 9 = 25 → 3.
  const ocB = resolveEffect(world(stats, tiles, sides), { ...cast, boost: 9 });
  if (ocB.status === 'done') eq('fireball with an Elementalist boost of 9 on the main leg (16 + 9 = 25 → 3)', dmgTo(ocB, 'E')[0], 3); else console.log('ok   fireball boost: point-buy failed → retry');
}
// Rule 15 target choice: no declared target → the enemy my cast hurts most, lowest life next.
{
  const stats = { C: M(10, 10, 15, 10), E: M(10, 10, 14, 10), F: M(10, 10, 5, 10), A: M(10, 10, 7, 10) };
  const cast = { actor: 'C', effect_id: 'effect_throw', elements: ['elem_air'], salt: 'abc', target: null, is_instant: false };
  eq('auto-target picks the softer enemy', resolveEffect(world(stats, tiles, sides), cast).hits.map(h => h.victim), ['F']);
}
// Shield: an element I am shielded against adds nothing. Invisible enemies cannot be targeted.
{
  const stats = { C: M(10, 10, 16, 10), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 10, 8, 10) };
  const cast = { actor: 'C', effect_id: 'effect_lightning', elements: ['elem_fire', 'elem_air'], salt: 'abc', target: { kind: 'character', ref: 'E' }, is_instant: false };
  eq('shielded against fire', dmgTo(resolveEffect(world(stats, tiles, sides, { shield: { E: ['elem_fire'] } }), cast), 'E'), [1]);
  eq('invisible target skipped → other enemy', resolveEffect(world(stats, tiles, sides, { perms: { E: ['effect_invisibility'] } }), cast).hits.map(h => h.victim), ['F']);
  eq('emotions bombard blocks my cast', resolveEffect(world(stats, tiles, sides, { perms: { E: ['effect_emotions_bombard'] } }), cast).status, 'blocked');
  eq('disabled element blocks my cast', resolveEffect(world(stats, tiles, sides, { disabled: { C: ['elem_air'] } }), cast).status, 'blocked');
}
// Invisibility (user ruling 2026-11-14): hidden from enemies only, seen by another invisible unit, Meteor Shower
// still hits it; the permanent breaks on Attack / Block / a cast (not on its own cast, a Move or an Empty action).
{
  const stats = { C: M(10, 10, 16, 10), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 10, 8, 10) };
  const lt = { actor: 'C', effect_id: 'effect_lightning', elements: ['elem_fire', 'elem_air'], salt: 'abc', target: { kind: 'character', ref: 'E' }, is_instant: false };
  eq('invisibility: declared invisible enemy not hit, none other in reach', resolveEffect(world(stats, tiles, sides, { perms: { E: ['effect_invisibility'], F: ['effect_invisibility'] } }), lt).hits.map(h => h.victim), []);
  eq('invisibility: an invisible caster sees an invisible enemy', resolveEffect(world(stats, tiles, sides, { perms: { C: ['effect_invisibility'], E: ['effect_invisibility'] } }), lt).hits.map(h => h.victim), ['E']);
  const eq1 = { actor: 'C', effect_id: 'effect_earthquake', elements: ['elem_earth'], salt: 'abc', target: null, is_instant: false };
  eq('invisibility: earthquake skips the invisible adjacent enemy', resolveEffect(world(stats, tiles, sides, { perms: { E: ['effect_invisibility'] } }), eq1).hits.map(h => h.victim), ['F']);
  const ms = { actor: 'C', effect_id: 'effect_meteor_shower', elements: ['elem_fire', 'elem_fire', 'elem_fire'], salt: 'abc', target: null, is_instant: false, of: 3, step: 3, kept: [3, 4, 5] };
  eq('invisibility: meteor shower (untargeted area) still hits the invisible', resolveEffect(world(stats, tiles, sides, { perms: { E: ['effect_invisibility'], A: ['effect_invisibility'] } }), ms).hits.map(h => h.victim), ['A', 'C', 'E', 'F']);
  const inv = { actor: 'C', effect_id: 'effect_invisibility', elements: ['elem_fire', 'elem_space'], salt: 'abc', target: null, is_instant: false, of: 2, step: 2 };
  eq('invisibility: the cast lands a permanent on me', resolveEffect(world(stats, tiles, sides), inv).permanents, [{ on: 'C', id: 'effect_invisibility' }]);
  const brk = (rv, o) => invisibilityBreaks(rv, o);
  eq('invisibility breaks on Attack', brk({ action: 'A' }), true);
  eq('invisibility breaks on Block', brk({ action: 'B' }), true);
  eq('invisibility breaks on a Battle Trance with an A/B option', brk({ action: 'BT', trance: ['M', 'B'] }), true);
  eq('invisibility breaks when a cast emits (Posture + Fireball)', brk({ action: 'P', effect: { effect_id: 'effect_fireball' } }), true);
  eq('invisibility breaks on an instant / bonus plan effect', brk({ action: 'EP', effect_id: 'effect_counter_spell' }), true);
  eq('invisibility holds through its own cast', brk({ action: 'P', effect: { effect_id: 'effect_invisibility' } }), false);
  eq('invisibility holds on Move / EM / EP / bare Posture', ['M', 'EM', 'EP', 'P'].map(a => brk({ action: a })), [false, false, false, false]);
  eq('invisibility: a Reaver EP / EM fights as Attack → breaks', [brk({ action: 'EP' }, { reaver: true }), brk({ action: 'EM' }, { reaver: true }), brk({ action: 'M' }, { reaver: true })], [true, true, false]);
  eq('invisibility: no reveal (idle) holds', brk(null), false);
}
// Aura turns a single-target cast into a mass one; Earthquake hits every adjacent enemy.
{
  const stats = { C: M(10, 10, 16, 10), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 10, 8, 10) };
  const cast = { actor: 'C', effect_id: 'effect_throw', elements: ['elem_air'], salt: 'abc', target: { kind: 'character', ref: 'E' }, is_instant: false };
  eq('aura → mass', resolveEffect(world(stats, tiles, sides, { perms: { C: ['effect_aura'] } }), cast).hits.map(h => h.victim), ['E', 'F']);
  eq('earthquake all adjacent enemies', resolveEffect(world(stats, tiles, sides), { ...cast, effect_id: 'effect_earthquake', elements: ['elem_earth'] }).hits.map(h => h.victim), ['E', 'F']);
}
// Drain (Vitality + Harmony) point-buys one element per emission: step 1 banks the
// Vitality die, step 2 buys Harmony and resolves on the banked pair. A failed roll
// comes back as 'retry' for that element alone, with the bank intact.
{
  const stats = { C: M(30, 10, 10, 30), E: M(8, 10, 10, 10), F: M(8, 10, 10, 10), A: M(8, 10, 10, 10) };
  const base = { actor: 'C', effect_id: 'effect_drain', elements: ['elem_vitality', 'elem_harmony'], salt: 'abc', target: { kind: 'character', ref: 'E' }, is_instant: false, of: 2 };
  const s1 = resolveEffect(world(stats, tiles, sides), { ...base, step: 1, kept: null });
  eq('drain step 1 banks the Vitality die, nothing lands', [s1.status, s1.hits.length, s1.kept[0] > 0, s1.kept[1]], ['casting', 0, true, null]);
  const s2 = resolveEffect(world(stats, tiles, sides), { ...base, step: 2, kept: s1.kept });
  eq('drain step 2 buys Harmony and resolves on both dice', [s2.status, s2.hits[0].legs[0].sum === s1.kept[0] + s2.kept[1]], ['done', true]);
  // Will 1: a Harmony roll overshoots on any die above 1 → only Harmony is retried, the Vitality die stays banked.
  const weak = { ...stats, C: M(30, 10, 10, 1) };
  let s2f = null;
  for (let i = 0; i < 40 && s2f?.status !== 'retry'; i++) s2f = resolveEffect(world(weak, tiles, sides), { ...base, salt: `r${i}`, step: 2, kept: s1.kept });
  eq('drain step 2 failed roll retries Harmony only', [s2f.status, s2f.kept[0], s2f.kept[1]], ['retry', s1.kept[0], null]);
}
// Super Force pushes the target one tile away; Teleportation moves me to a free tile target.
{
  const stats = { C: M(16, 10, 10, 10), E: M(8, 10, 10, 10), F: M(8, 10, 10, 10), A: M(8, 10, 10, 10) };
  const cast = { actor: 'C', effect_id: 'effect_super_force', elements: ['elem_vitality', 'elem_vitality'], salt: 'abc', target: { kind: 'character', ref: 'E' }, is_instant: false };
  eq('super force pushes E away', resolveEffect(world(stats, tiles, sides), cast).moves, [{ who: 'E', q: 2, r: 0, reason: 'pushed' }]);
  eq('teleport self', resolveEffect(world(stats, tiles, sides), { actor: 'C', effect_id: 'effect_teleportation', elements: ['elem_space'], salt: 'x', target: { kind: 'tile', ref: { q: 3, r: 3 } } }).moves, [{ who: 'C', q: 3, r: 3, reason: 'teleported' }]);
}
// Turn Life with nobody in reach heals me for round(Vitality / 10).
{
  const stats = { C: M(15, 10, 10, 10), E: M(8, 10, 10, 10), F: M(8, 10, 10, 10), A: M(8, 10, 10, 10) };
  const far = { C: { q: 0, r: 0 }, E: { q: 5, r: 0 }, F: { q: 0, r: 5 }, A: { q: -1, r: 0 } };
  eq('turn life heals when alone', resolveEffect(world(stats, far, sides), { actor: 'C', effect_id: 'effect_turn_life', elements: ['elem_vitality', 'elem_harmony'], salt: 'x', target: null, is_instant: true }).heals, [{ on: 'C', amount: 2 }]);
}
// Summoning (user spec): stat buy — each Souls emission banks my World stat (12); a creature of Σ30
// needs 3 emissions: casting, casting, done with the permanent (power fixed at 6 on the peer side).
{
  const stats = { C: M(10, 12, 10, 10), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 10, 8, 10) };
  const cast = { actor: 'C', effect_id: 'effect_summoning', elements: ['elem_souls'], salt: 's', target: null, is_instant: false, of: 3, summon: { creature_id: 'mon_x', name: 'X', need: 30 } };
  const s1 = resolveEffect(world(stats, tiles, sides), { ...cast, step: 1, kept: null });
  eq('summoning step 1: casting, bank 12', [s1.status, s1.kept], ['casting', [12]]);
  const s2 = resolveEffect(world(stats, tiles, sides), { ...cast, step: 2, kept: s1.kept });
  eq('summoning step 2: casting, bank 24', [s2.status, s2.kept], ['casting', [12, 12]]);
  const s3 = resolveEffect(world(stats, tiles, sides), { ...cast, step: 3, kept: s2.kept });
  eq('summoning step 3: paid → permanent + summon', [s3.status, s3.permanents, s3.summon.creature_id, s3.summon.need], ['done', [{ on: 'C', id: 'effect_summoning' }], 'mon_x', 30]);
  // Still short at the estimated last emission → keeps casting (the peer grows the cast by one).
  const short = resolveEffect(world(stats, tiles, sides), { ...cast, step: 3, kept: [8, 8] });
  eq('summoning short at the last emission keeps casting', [short.status, short.kept], ['casting', [8, 8, 12]]);
  // ∀: binds the creature in view; gone → fizzles.
  const bind = resolveEffect(world(stats, tiles, sides), { ...cast, step: 3, kept: [12, 12], every: true, summon: { ...cast.summon, bind: 'E' } });
  eq('summoning ∀ binds the creature in view', [bind.status, bind.summon.bind], ['done', 'E']);
  const gone = resolveEffect(world(stats, tiles, sides, { life: { E: 0 } }), { ...cast, step: 3, kept: [12, 12], every: true, summon: { ...cast.summon, bind: 'E' } });
  eq('summoning ∀ with the creature dead fizzles', gone.status, 'fizzled');
}

// Golems (user spec): Souls, Harmony in turn — emission 1 banks World (12), emission 2 Will (6),
// emission 3 World again … until the bank covers 24: 12, 18, 30 → done at the third.
{
  const stats = { C: M(10, 12, 10, 6), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 10, 8, 10) };
  const cast = { actor: 'C', effect_id: 'effect_golems_earth', elements: ['elem_souls', 'elem_harmony'], salt: 's', target: null, is_instant: false, of: 3, summon: { creature_id: 'mon_golem_living', name: 'Living Golem', need: 24 } };
  const g1 = resolveEffect(world(stats, tiles, sides), { ...cast, step: 1, kept: null });
  eq('golems step 1 banks World', [g1.status, g1.kept], ['casting', [12]]);
  const g2 = resolveEffect(world(stats, tiles, sides), { ...cast, step: 2, kept: g1.kept });
  eq('golems step 2 banks Will', [g2.status, g2.kept], ['casting', [12, 6]]);
  const g3 = resolveEffect(world(stats, tiles, sides), { ...cast, step: 3, kept: g2.kept });
  eq('golems step 3 (World again) pays 24 → permanent + golem', [g3.status, g3.kept, g3.permanents, g3.summon.creature_id], ['done', [12, 6, 12], [{ on: 'C', id: 'effect_golems_earth' }], 'mon_golem_living']);
  // Elementals: Harmony (Will 6), Concentration (Will 6) … need 30 → five emissions.
  const e = { ...cast, effect_id: 'effect_elementals_air', elements: ['elem_harmony', 'elem_concentration'], of: 5, summon: { creature_id: 'mon_elemental_world', name: 'World Elemental', need: 30 } };
  const e4 = resolveEffect(world(stats, tiles, sides), { ...e, step: 4, kept: [6, 6, 6] });
  eq('elementals short at 24/30 keeps casting', [e4.status, e4.kept], ['casting', [6, 6, 6, 6]]);
  const e5 = resolveEffect(world(stats, tiles, sides), { ...e, step: 5, kept: e4.kept });
  eq('elementals paid at 30 → permanent + elemental', [e5.status, e5.summon.creature_id, e5.permanents], ['done', 'mon_elemental_world', [{ on: 'C', id: 'effect_elementals_air' }]]);
}
// Resurrect / Death Ward (user spec): Vitality stat buy next to a fallen unit; the raised one
// comes back (a player at full life, a creature as my ally). Ward: an ally next to me, no bank.
{
  const stats = { C: M(10, 12, 10, 6), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 10, 8, 10) };
  const cast = { actor: 'C', effect_id: 'effect_resurrect_death_ward', elements: ['elem_vitality'], salt: 's', target: null, is_instant: false, of: 2, summon: { revive: 'E', creature_id: 'mon_x', name: 'X', need: 20 } };
  const r1 = resolveEffect(world(stats, tiles, sides, { life: { E: 0 } }), { ...cast, step: 1, kept: null });
  eq('resurrect step 1 banks Vitality 10/20', [r1.status, r1.kept], ['casting', [10]]);
  const r2 = resolveEffect(world(stats, tiles, sides, { life: { E: 0 } }), { ...cast, step: 2, kept: r1.kept });
  eq('resurrect paid → raise E', [r2.status, r2.summon.revive, r2.permanents], ['done', 'E', [{ on: 'C', id: 'effect_resurrect_death_ward' }]]);
  const up = resolveEffect(world(stats, tiles, sides), { ...cast, step: 2, kept: [10] });
  eq('resurrect with the unit alive again fizzles', up.status, 'fizzled');
  const far = resolveEffect(world(stats, { ...tiles, E: { q: 3, r: 0 } }, sides, { life: { E: 0 } }), { ...cast, step: 2, kept: [10] });
  eq('resurrect with the corpse out of reach fizzles', far.status, 'fizzled');
  const ward = resolveEffect(world(stats, tiles, sides), { ...cast, of: 1, step: 1, kept: null, summon: { ward: 'A', name: 'A', need: 0 } });
  eq('death ward on the ally next to me: permanent at once', [ward.status, ward.summon.ward, ward.permanents], ['done', 'A', [{ on: 'C', id: 'effect_resurrect_death_ward' }]]);
  const foe = resolveEffect(world(stats, tiles, sides), { ...cast, of: 1, step: 1, kept: null, summon: { ward: 'E', name: 'E', need: 0 } });
  eq('death ward on an enemy fizzles', foe.status, 'fizzled');
  const none = resolveEffect(world(stats, tiles, sides), { ...cast, of: 1, step: 1, kept: null, summon: { pending: true, need: 0 } });
  eq('resurrect with nothing to aim at fizzles', none.status, 'fizzled');
}

// Channel tokens (user ruling 2026-10-29): Harm / Combustion / The Void / Light-Darkness are
// permanent-until-round-end channels. The cast fires its own leg once and registers the channel;
// each subsequent action peer.mjs re-fires the (non-permanent, non-emission) leg via
// resolveEffect({..._channel_tick: true}). Stop condition: adjacency for Harm/Combustion,
// round-end for The Void/Light-Darkness.
{
  const stats = { C: M(10, 10, 16, 12), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 10, 8, 10) };
  // Harm: cast with Vitality element. Permanent + channel registered + Vitality shield token on caster's tile.
  const harm = { actor: 'C', effect_id: 'effect_harm', elements: ['elem_vitality'], salt: 'h', target: { kind: 'character', ref: 'E' }, is_instant: false, of: 1, step: 1, kept: null };
  const oc = resolveEffect(world(stats, tiles, sides), harm);
  eq('harm cast lands permanent on caster', oc.permanents, [{ on: 'C', id: 'effect_harm' }]);
  eq('harm cast registers a break-stop channel on target E', oc.channels, [{ on: 'C', effect_id: 'effect_harm', target: 'E', elements: ['elem_vitality'], salt: 'h', stop: 'break' }]);
  // The shield token's die value comes from a point-buy against Vitality (same seed on every peer).
  const vitTokens = oc.tokens.filter(t => t.kind === 'shield' && t.elem === 'elem_vitality' && t.q === 0 && t.r === 0);
  eq('harm cast puts a Vitality shield token on the caster', vitTokens.length, 1);
  // Tick mode: no new permanent, no new channel, damage fresh-rolls on caster's current Vitality.
  const tick = resolveEffect(world(stats, tiles, sides), { ...harm, is_instant: true, _channel_tick: true, kept: [0] });
  eq('harm tick does not re-land the permanent', tick.permanents, []);
  eq('harm tick does not re-register the channel', tick.channels, []);
  eq('harm tick still hurts the target', (tick.hits.find(h => h.victim === 'E')?.legs?.length || 0) > 0, true);
  // Combustion tick: statPenalty on Harmony, no permanent re-landing.
  const comb = { actor: 'C', effect_id: 'effect_combustion', elements: ['elem_harmony'], salt: 'c', target: { kind: 'character', ref: 'E' }, is_instant: false, of: 1, step: 1, kept: null };
  const cb = resolveEffect(world(stats, tiles, sides), comb);
  eq('combustion cast registers a channel + permanent', [cb.permanents, cb.channels[0]?.stop], [[{ on: 'C', id: 'effect_combustion' }], 'break']);
  const cbTick = resolveEffect(world(stats, tiles, sides), { ...comb, is_instant: true, _channel_tick: true });
  eq('combustion tick stacks another Harmony penalty on target', cbTick.statTokens.some(t => t.on === 'E' && t.elem === 'elem_harmony' && t.value < 0) && cbTick.permanents.length === 0 && cbTick.channels.length === 0, true);
  // The Void: round-end channel, voids this action + Concentration bonus on caster's tile.
  const voidC = { actor: 'C', effect_id: 'effect_the_void', elements: ['elem_concentration'], salt: 'v', target: null, is_instant: true, of: 1, step: 1, kept: null };
  const voc = resolveEffect(world(stats, tiles, sides), voidC);
  eq('the void voids damage this action and banks a Concentration token', [voc.voidFor, voc.tokens.filter(t => t.kind === 'bonus' && t.elem === 'elem_concentration').length], [['C'], 1]);
  eq('the void registers a break-stop channel + permanent', [voc.channels[0]?.stop, voc.permanents], ['break', [{ on: 'C', id: 'effect_the_void' }]]);
  const vocTick = resolveEffect(world(stats, tiles, sides), { ...voidC, _channel_tick: true });
  eq('the void tick keeps voiding damage but does not re-register', [vocTick.voidFor, vocTick.channels], [['C'], []]);
  // Light / Darkness: zone over self + 6 neighbours, Fire bonus token on caster, round-end channel.
  const ld = { actor: 'C', effect_id: 'effect_light_darkness', elements: ['elem_fire'], salt: 'l', target: null, is_instant: true, of: 1, step: 1, kept: null };
  const ldOc = resolveEffect(world(stats, tiles, sides), ld);
  eq('light/darkness puts no-damage zone on self + 6 neighbours', ldOc.zones.length, 7);
  eq('light/darkness registers a break-stop channel + permanent', [ldOc.channels[0]?.stop, ldOc.permanents], ['break', [{ on: 'C', id: 'effect_light_darkness' }]]);
  const ldTick = resolveEffect(world(stats, tiles, sides), { ...ld, _channel_tick: true });
  eq('light/darkness tick re-fires zones but not channel', [ldTick.zones.length, ldTick.channels], [7, []]);
}

// Traps (Rule 2/4, user spec 2026-10-29): Poison damages AND leaves itself under me as a 'targeted' trap;
// Sleep / Confusion are 'enter' traps that become the owner's perm on the victim; Traps Mastery lays the
// attached card; Space Bending with nobody in reach lays the attached card on a random free tile within 10.
{
  const stats = { C: M(10, 10, 16, 12), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 10, 8, 10) };
  const w = world(stats, tiles, sides);
  w.freeTilesWithin = (q, r, d) => [{ q: 3, r: 0 }, { q: 4, r: 0 }, { q: 5, r: -1 }];
  const poison = { actor: 'C', effect_id: 'effect_poison', elements: ['elem_water', 'elem_vitality'], salt: 'p', target: { kind: 'character', ref: 'E' }, is_instant: false, card_id: 'card-p1' };
  const po = resolveEffect(w, poison);
  eq('poison hits E and leaves a targeted trap under C', [po.status, po.hits.map(h => h.victim), po.traps.map(t => [t.q, t.r, t.trigger, t.mode, t.power, t.card_id])], ['done', ['E'], [[0, 0, 'targeted', 'damage', 20, 'card-p1']]]);
  const alone = { C: { q: 0, r: 0 }, E: { q: 5, r: 0 }, F: { q: 6, r: 0 }, A: { q: -1, r: 0 } };
  const wa = world(stats, alone, sides); wa.freeTilesWithin = w.freeTilesWithin;
  const poAlone = resolveEffect(wa, poison);
  eq('poison with nobody in reach still sets the trap (not fizzled)', [poAlone.status, poAlone.hits.length, poAlone.traps.length], ['done', 0, 1]);
  const sleep = resolveEffect(w, { actor: 'C', effect_id: 'effect_sleep', elements: ['elem_souls', 'elem_concentration'], salt: 's', target: null, is_instant: false, card_id: 'card-s1' });
  eq('sleep: enter trap in perm mode under C, no permanent yet', [sleep.status, sleep.traps[0]?.trigger, sleep.traps[0]?.mode, sleep.permanents], ['done', 'enter', 'perm', []]);
  const tm = { actor: 'C', effect_id: 'effect_traps_mastery', elements: ['elem_space'], salt: 't', target: null, is_instant: false, attach: { effect_id: 'effect_fireball', elements: ['elem_fire', 'elem_fire'], card_id: 'card-fb' } };
  const tmo = resolveEffect(w, tm);
  eq('traps mastery: permanent + attached fireball as a targeted trap held by it', [tmo.permanents, tmo.traps.map(t => [t.effect_id, t.trigger, t.holder, t.card_id])], [[{ on: 'C', id: 'effect_traps_mastery' }], [['effect_fireball', 'targeted', 'effect_traps_mastery', 'card-fb']]]);
  eq('traps mastery without an attachment fizzles', resolveEffect(w, { ...tm, attach: null }).status, 'fizzled');
  const sb = { actor: 'C', effect_id: 'effect_space_bending', elements: ['elem_space'], salt: 'b', target: null, is_instant: false, attach: { effect_id: 'effect_lightning', elements: ['elem_fire', 'elem_air'], card_id: 'card-l' } };
  const sbo = resolveEffect(wa, sb);
  eq('space bending alone lays the attached card as an enter trap on a free tile within 10', [sbo.status, sbo.traps.length, sbo.traps[0]?.trigger, [3, 4, 5].includes(sbo.traps[0]?.q)], ['done', 1, 'enter', true]);
  eq('space bending with an enemy in reach damages + locks, no trap', [resolveEffect(w, { ...sb, target: { kind: 'character', ref: 'E' } }).traps.length, resolveEffect(w, { ...sb, target: { kind: 'character', ref: 'E' } }).locks.length], [0, 1]);
  // User ruling 2026-10-30: with a Library the alt trap is a RANDOM library card (library: true, no card_id), not the attached one.
  const wl = world(stats, alone, sides); wl.freeTilesWithin = w.freeTilesWithin; wl.library = () => [{ effect_id: 'effect_fireball', elements: ['elem_fire', 'elem_fire'] }, { effect_id: 'effect_drain', elements: ['elem_souls', 'elem_harmony'] }];
  const sbl = resolveEffect(wl, sb);
  eq('space bending alone with a Library lays a random library card (library: true, no card id)', [sbl.status, sbl.traps.length, sbl.traps[0]?.library, sbl.traps[0]?.card_id, ['effect_fireball', 'effect_drain'].includes(sbl.traps[0]?.effect_id)], ['done', 1, true, null, true]);
  // Trap damage: power 20 per element vs the victim's stat, /10. Water+Vitality vs Matter 8 / Vitality 10 → 12 + 10 = 22 → 2.
  eq('trap damage 20/20 vs 8/10 → 22', trapDamageSum(['elem_water', 'elem_vitality'], el => ({ elem_water: 8, elem_vitality: 10 })[el]), 22);
}

// Teleportation (user spec 2026-10-29): the chosen tile within 10 takes me, or the adjacent ally with
// less life (tie → me); no tile chosen → a random free tile within 10.
{
  const stats = { C: M(10, 10, 16, 12), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 10, 8, 10) };
  const w = world(stats, tiles, sides, { life: { C: 4, A: 2 } });
  w.freeTilesWithin = () => [{ q: 3, r: 0 }, { q: 4, r: 0 }];
  const tp = { actor: 'C', effect_id: 'effect_teleportation', elements: ['elem_space'], salt: 'tp', target: { kind: 'tile', ref: { q: 2, r: 2 } }, is_instant: false };
  eq('teleport sends the weaker adjacent ally to the chosen tile', resolveEffect(w, tp).moves, [{ who: 'A', q: 2, r: 2, reason: 'teleported' }]);
  const we = world(stats, tiles, sides, { life: { C: 4, A: 4 } }); we.freeTilesWithin = w.freeTilesWithin;
  eq('teleport on equal life sends me', resolveEffect(we, tp).moves[0].who, 'C');
  const noT = resolveEffect(we, { ...tp, target: null });
  eq('teleport without a tile picks a random free tile within 10', [noT.status, [3, 4].includes(noT.moves[0]?.q)], ['done', true]);
  eq('teleport to a tile beyond 10 falls back to a random tile', resolveEffect(we, { ...tp, target: { kind: 'tile', ref: { q: 30, r: 0 } } }).moves[0].q <= 4, true);
}

// Banish / Creation / Spirit Link (user spec 2026-10-29).
{
  const stats = { C: M(10, 14, 16, 12), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 12, 8, 10) };
  const w = world(stats, tiles, sides);
  w.freeTilesWithin = (q, r, d) => [{ q: 2, r: 0 }, { q: 20, r: 0 }, { q: 21, r: -1 }];
  const bn = { actor: 'C', effect_id: 'effect_banish', elements: ['elem_space', 'elem_souls'], salt: 'bn', target: { kind: 'character', ref: 'E' }, is_instant: false };
  const bo = resolveEffect(w, bn);
  eq('banish: World 14 beats 10 → E lands ≥18 hexes away', [bo.status, bo.moves[0]?.who, bo.moves[0]?.q >= 20], ['done', 'E', true]);
  const wk = world({ ...stats, C: M(10, 8, 16, 12) }, tiles, sides); wk.freeTilesWithin = w.freeTilesWithin;
  eq('banish fizzles when my World does not beat the target', resolveEffect(wk, bn).status, 'fizzled');
  const cr = { actor: 'C', effect_id: 'effect_creation', elements: ['elem_earth'], salt: 'cr', target: { kind: 'tile', ref: { q: 0, r: -1 } }, is_instant: false };
  eq('creation puts a 5 hp Earth obstacle on the chosen free neighbour', resolveEffect(w, cr).obstacles, [{ by: 'C', q: 0, r: -1, hp: 5, elem: 'elem_earth' }]);
  const auto = resolveEffect(w, { ...cr, target: null }).obstacles[0];
  eq('creation without a tile picks the free neighbour nearest the closest enemy', [auto.hp, Math.max(Math.abs(auto.q - 1), Math.abs(auto.r), Math.abs(auto.q + auto.r - 1)) <= 1], [5, true]);
  eq('creation onto an occupied neighbour falls back to an automatic one', resolveEffect(w, { ...cr, target: { kind: 'tile', ref: { q: 1, r: 0 } } }).obstacles.length, 1);
  const sl = { actor: 'C', effect_id: 'effect_spirit_link', elements: ['elem_souls'], salt: 'sl', target: null, is_instant: false, link: { peer_id: 'A', stat: 'world' } };
  eq('spirit link adds the ally\'s World 12 to mine + permanent', [resolveEffect(w, sl).links, resolveEffect(w, sl).permanents], [[{ on: 'C', from: 'A', stat: 'world', value: 12 }], [{ on: 'C', id: 'effect_spirit_link' }]]);
  eq('spirit link ∀ links all four stats', resolveEffect(w, { ...sl, every: true }).links.map(l => l.stat), ['vitality', 'world', 'will', 'matter']);
  eq('spirit link on an enemy fizzles', resolveEffect(w, { ...sl, link: { peer_id: 'E', stat: 'world' } }).status, 'fizzled');
}

// Balefire rework (user spec 2026-10-29): the completed cast deals its delta damage, lands Balefire(6) and draws 5;
// it completes even with nobody in reach (Rule 18 — the elements went out).
{
  const stats = { C: M(10, 14, 16, 12), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 12, 8, 10) };
  const bf = { actor: 'C', effect_id: 'effect_balefire', elements: ['elem_fire', 'elem_harmony', 'elem_time'], salt: 'bf', target: { kind: 'character', ref: 'E' }, is_instant: false, step: 3, of: 3 };
  const o = resolveEffect(world(stats, tiles, sides), bf);
  eq('balefire: damage + Balefire(6) permanent + 5 cards', [o.status, o.hits.map(h => h.victim), o.permanents, o.draw], ['done', ['E'], [{ on: 'C', id: 'effect_balefire' }], 5]);
  const alone = resolveEffect(world(stats, { ...tiles, E: { q: 5, r: 0 }, F: { q: 6, r: 0 } }, sides), bf);
  eq('balefire with nobody in reach still lands the permanent', [alone.status, alone.hits.length, alone.permanents.length, alone.draw], ['done', 0, 1, 5]);
}

// Force Pull / Artifice tile token / Ageing feature (user spec 2026-10-29).
{
  const stats = { C: M(10, 14, 30, 12), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 12, 8, 10) };
  const w = world(stats, tiles, sides);
  // A Fire(3) bonus token lies under enemy E (adjacent); nothing under ally A.
  w.tileTokensAt = (q, r) => (q === 1 && r === 0) ? [{ id: 'tk1', kind: 'bonus', elem: 'elem_fire', value: 3, owner: 'E', item: 'Sphere of Fire' }] : [];
  const th = { actor: 'C', effect_id: 'effect_throw', elements: ['elem_air'], salt: 'th', target: { kind: 'character', ref: 'E' }, is_instant: false };
  const po = resolveEffect(w, th);
  eq('force pull: Matter 30 pulls the Fire(3) token under E onto my tile, no damage', [po.status, po.hits.length, po.pulls.map(p => [p.token_id, p.owner, p.q, p.r])], ['done', 0, [['tk1', 'E', 0, 0]]]);
  w.tileTokensAt = (q, r) => (q === -1 && r === 0) ? [{ id: 'tk2', kind: 'bonus', elem: 'elem_fire', value: 3, owner: 'A' }] : [];
  eq('force pull ignores a token under an ally → Smash damage instead', [resolveEffect(w, th).pulls.length, resolveEffect(w, th).hits.length], [0, 1]);
  const ar = { actor: 'C', effect_id: 'effect_artifice', elements: ['elem_earth'], salt: 'ar', target: { kind: 'tile', ref: { q: 0, r: -1 } }, is_instant: false, elem: 'elem_fire' };
  const ao = resolveEffect(w, ar);
  eq('artifice with a neighbour tile puts a Fire bonus token there and no holding token', [ao.tokens.map(t => [t.kind, t.elem, t.q, t.r]), ao.statTokens.length], [[['bonus', 'elem_fire', 0, -1]], 0]);
  eq('artifice without a tile keeps the Earth holding token', resolveEffect(w, { ...ar, target: null }).statTokens.map(t => [t.on, t.elem]), [['C', 'elem_earth']]);
  const far = { C: { q: 0, r: 0 }, E: { q: 6, r: 0 }, F: { q: 7, r: 0 }, A: { q: -1, r: 0 } };
  const wa = world(stats, far, sides); wa.freeTilesWithin = () => [{ q: 1, r: 0 }, { q: 0, r: 1 }];
  const ag = resolveEffect(wa, { actor: 'C', effect_id: 'effect_aging', elements: ['elem_time', 'elem_souls'], salt: 'ag', target: null, is_instant: false });
  eq('ageing with nobody in reach raises a feature on a free tile within 2', [ag.status, ag.tokens.length, !!ag.tokens[0]?.item, ag.tokens[0]?.kind], ['done', 1, true, 'bonus']);
  eq('ageing with an enemy in reach keeps its penalties', resolveEffect(w, { actor: 'C', effect_id: 'effect_aging', elements: ['elem_time', 'elem_souls'], salt: 'ag', target: { kind: 'character', ref: 'E' }, is_instant: false }).statTokens.length, 2);
}

// Map surgery (user spec 2026-10-29): Metaphysics unites (nearby feature/trap → chosen free tile), Disruption splits
// (any trap in view → chosen free tile), Mind Blast switches my tile with the chosen one, Awake moves an adjacent ally / me.
{
  const stats = { C: M(10, 14, 16, 12), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 12, 8, 10) };
  const far = { C: { q: 0, r: 0 }, E: { q: 5, r: 0 }, F: { q: 6, r: 0 }, A: { q: -1, r: 0 } };
  const mk = (tl) => {
    const w = world(stats, tl, sides);
    w.tileTokensAt = (q, r) => (q === 0 && r === -1) ? [{ id: 'f1', kind: 'bonus', elem: 'elem_souls', value: 6, owner: 'A', item: 'Sacred Land' }] : [];
    w.trapsAt = (q, r) => (q === 5 && r === 0) ? [{ id: 't9', owner: 'E', effect_id: 'effect_poison' }] : [];
    w.obstacleAt = () => null;
    w.freeTilesWithin = () => [{ q: 2, r: 2 }, { q: 3, r: 0 }, { q: 1, r: 1 }];
    return w;
  };
  const meta = { actor: 'C', effect_id: 'effect_metaphysics', elements: ['elem_space', 'elem_earth'], salt: 'mp', target: { kind: 'tile', ref: { q: 2, r: 2 } }, is_instant: false };
  const mo = resolveEffect(mk(far), meta);
  eq('metaphysics (no enemy adjacent) moves the Sacred Land next to me onto the chosen tile', [mo.status, mo.relocations, mo.hits.length], ['done', [{ kind: 'token', owner: 'A', id: 'f1', label: 'Sacred Land', by: 'C', q: 2, r: 2 }], 0]);
  eq('metaphysics with an enemy adjacent deals damage, no surgery', [resolveEffect(mk(tiles), { ...meta, target: { kind: 'character', ref: 'E' } }).hits.length, resolveEffect(mk(tiles), meta).relocations.length], [1, 0]);
  const dis = { ...meta, effect_id: 'effect_disruption', elements: ['elem_souls', 'elem_harmony'] };
  eq('disruption moves the trap under the far enemy onto the chosen tile', resolveEffect(mk(far), dis).relocations, [{ kind: 'trap', owner: 'E', id: 't9', label: 'effect_poison', q: 2, r: 2 }]);
  const mb = { actor: 'C', effect_id: 'effect_mind_blast', elements: ['elem_concentration'], salt: 'mb', target: { kind: 'tile', ref: { q: 5, r: 0 } }, is_instant: false, step: 1, of: 1, kept: [4] };
  const mbo = resolveEffect(mk(far), mb);
  eq('mind blast switches me with the enemy on the chosen tile and carries its trap over', [mbo.moves.map(m => [m.who, m.q, m.r]), mbo.relocations.map(r => [r.kind, r.q, r.r]), mbo.hits.length], [[['C', 5, 0], ['E', 0, 0]], [['trap', 0, 0]], 0]);
  eq('mind blast on an enemy target keeps its point-buy damage leg', resolveEffect(mk(tiles), { ...mb, target: { kind: 'character', ref: 'E' } }).hits.length, 1);
  const aw = { actor: 'C', effect_id: 'effect_awake', elements: ['elem_harmony'], salt: 'aw', target: { kind: 'tile', ref: { q: 3, r: 0 } }, is_instant: false };
  eq('awake moves the adjacent ally first', resolveEffect(mk(far), aw).moves, [{ who: 'A', q: 3, r: 0, reason: 'awakened' }]);
  eq('awake without an adjacent ally moves me', resolveEffect(mk({ ...far, A: { q: -4, r: 0 } }), aw).moves[0].who, 'C');
  eq('awake without a tile fizzles', resolveEffect(mk(far), { ...aw, target: null }).status, 'fizzled');
}

// Blessing / Phantom / Possess / Vision (user spec 2026-10-29).
{
  const stats = { C: M(12, 14, 16, 12), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 12, 8, 10) };
  const w = world(stats, tiles, sides, { perms: { E: ['effect_haste'] } });
  const bl = { actor: 'C', effect_id: 'effect_blessing_curse', elements: ['elem_time'], salt: 'bl', target: { kind: 'character', ref: 'E' }, is_instant: false, attach: { effect_id: 'effect_fireball', elements: ['elem_fire', 'elem_fire'], card_id: 'card-fb' } };
  const bo = resolveEffect(w, bl);
  eq('blessing: permanent + the attached fireball as an unbreakable channel held by it', [bo.permanents, bo.channels.map(c => [c.effect_id, c.stop, c.holder, c.card_id])], [[{ on: 'C', id: 'effect_blessing_curse' }], [['effect_fireball', 'never', 'effect_blessing_curse', 'card-fb']]]);
  eq('blessing without an attachment fizzles', resolveEffect(w, { ...bl, attach: null }).status, 'fizzled');
  eq('phantom flags the spawn + permanent', [resolveEffect(w, { actor: 'C', effect_id: 'effect_phantom', elements: ['elem_vitality', 'elem_souls', 'elem_space'], salt: 'ph', target: null, is_instant: false }).phantom, resolveEffect(w, { actor: 'C', effect_id: 'effect_phantom', elements: ['elem_vitality', 'elem_souls', 'elem_space'], salt: 'ph', target: null, is_instant: false }).permanents.length], [true, 1]);
  const ps = { actor: 'C', effect_id: 'effect_possess_phylactery', elements: ['elem_vitality'], salt: 'ps', target: { kind: 'character', ref: 'E' }, is_instant: false };
  eq('possess: Σ54 beats Σ38 → E is bound to me', [resolveEffect(w, ps).possess, resolveEffect(w, ps).permanents.length], [{ bind: 'E' }, 1]);
  eq('possess: the permanent lands in the POSSESSED unit\'s holding, marked by the possessor (user ruling 2026-10-30)', resolveEffect(w, ps).permanents, [{ on: 'E', id: 'effect_possess_phylactery', by: 'C' }]);
  eq('possess against a stronger Σ fizzles', resolveEffect(world({ ...stats, E: M(20, 20, 20, 20) }, tiles, sides), ps).status, 'fizzled');
  eq('phylactery shatters the named enemy permanent', resolveEffect(w, { ...ps, phylactery: { peer_id: 'E', perm: 'effect_haste' } }).possess, { phylactery: { peer_id: 'E', perm: 'effect_haste' } });
  eq('phylactery on a permanent the enemy does not hold fizzles', resolveEffect(w, { ...ps, phylactery: { peer_id: 'E', perm: 'effect_aura' } }).status, 'fizzled');
  const vi = { actor: 'C', effect_id: 'effect_vision', elements: ['elem_time'], salt: 'vi', target: { kind: 'character', ref: 'E' }, is_instant: false };
  eq('vision: World 14 beats 10 → peek at E\'s hand', resolveEffect(w, vi).peeks, [{ by: 'C', kind: 'hand', of: 'E' }]);
  eq('vision on a tile reveals the map there', resolveEffect(w, { ...vi, target: { kind: 'tile', ref: { q: 4, r: 4 } } }).peeks, [{ by: 'C', kind: 'tile', q: 4, r: 4 }]);
  eq('vision against a higher World fizzles', resolveEffect(world({ ...stats, C: M(12, 8, 16, 12) }, tiles, sides), vi).status, 'fizzled');
}

// Manipulator (passive, once per turn — user ruling 2026-11-14): committed alt, combat-hit trigger, salted pick, swap.
{
  eq('manipulator config defaults', manipulatorConfig({}), { range: 3, publishRange: 6 });
  eq('manipulator config from data', manipulatorConfig({ range: 2, publish_range: 5 }), { range: 2, publishRange: 5 });
  const hand = [{ kind: 'action', code: 'A', card_id: 'a1' }, { kind: 'effect', card_id: 'e1' }, { kind: 'action', code: 'A', card_id: 'a2' }, { kind: 'action', code: 'B', card_id: 'b1' }];
  eq('alt: never the played card, may be the same kind', pickAltAction(hand, ['a1'], () => 0), { code: 'A', card_id: 'a2' });
  eq('alt: last pool card', pickAltAction(hand, ['a1'], () => 0.99), { code: 'B', card_id: 'b1' });
  eq('alt: no other Action card → Empty Posture', pickAltAction(hand, ['a1', 'a2', 'b1']), { code: 'EP', card_id: null });
  eq('combat hit: a matrix strike counts', combatHit([{ source: 'action', amount: 1 }]), true);
  eq('combat hit: spells, traps, bonus rounds and 0-damage strikes do not', combatHit([{ source: 'effect', amount: 3 }, { source: 'action', amount: 1, bonus: true }, { source: 'action', amount: 0 }]), false);
  const ids = ['peer:z', 'peer:b', 'peer:m'];
  const t1 = pickManipTarget('salt1:manipulator:4.1', ids, sha);
  eq('pick: order of the candidate list does not matter', pickManipTarget('salt1:manipulator:4.1', [...ids].reverse(), sha), t1);
  eq('pick: index = sha(seed) mod n over sorted ids', t1, ['peer:b', 'peer:m', 'peer:z'][parseInt(sha('salt1:manipulator:4.1').slice(0, 8), 16) % 3]);
  eq('pick: nobody near → nothing', pickManipTarget('x', [], sha), null);
  const atk = { actor: 'E', action: 'A', target: { kind: 'character', ref: 'C' }, skills: ['skill_powerful_attack', 'skill_sanctuary_b'], buildingSkill: 'skill_sanctuary_b', trance: null, effect: { effect_id: 'effect_fireball', is_instant: false }, destroy: { stat: 'world' } };
  const s1 = applyManipSwap(atk, { code: 'B', target: null });
  eq('swap A→B: action replaced, riding skills back to hand, building skill kept, cast and destroy dropped (B does not emit)', [s1, atk.action, atk.target, atk.skills, atk.effect, atk.destroy], [{ old: 'A', new: 'B' }, 'B', null, ['skill_sanctuary_b'], null, null]);
  const po = { actor: 'E', action: 'P', target: null, skills: [], trance: null, effect: { effect_id: 'effect_fireball', is_instant: false }, destroy: null };
  eq('swap P→EP keeps the cast (EP emits)', [applyManipSwap(po, { code: 'EP', target: null }), po.effect?.effect_id], [{ old: 'P', new: 'EP' }, 'effect_fireball']);
  const bt = { actor: 'E', action: 'BT', target: null, skills: ['skill_battle_trance'], trance: ['A', 'B'], effect: { effect_id: 'effect_haste', is_instant: true }, destroy: null };
  eq('swap a Battle Trance → A on the Manipulator; an instant effect still rides', [applyManipSwap(bt, { code: 'A', target: { kind: 'character', ref: 'C' } }), bt.trance, bt.skills, bt.target.ref, bt.effect.effect_id], [{ old: 'BT', new: 'A' }, null, [], 'C', 'effect_haste']);
}

// Rogue / Cleric trap rules (user rulings 2026-11-14, game/class-traps.mjs).
{
  const hd = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
  eq('rogue defaults: 1 trap + 1 threat charge per turn, ring 2', rogueConfig({}), { trapPerTurn: 1, threatPerTurn: 1, threatRadius: 2 });
  eq('rogue config is data-driven', rogueConfig({ trap_dodges_per_turn: 2, threat_dodges_per_turn: 0, threat_radius: 3 }), { trapPerTurn: 2, threatPerTurn: 0, threatRadius: 3 });
  eq('rogue trap charge fresh this turn', chargesLeft(1, 4, 1, 5), 1);
  eq('rogue trap charge spent this turn', chargesLeft(1, 5, 1, 5), 0);
  eq('rogue 2-per-turn charge after one use', chargesLeft(2, 5, 1, 5), 1);
  eq('rogue never-used (-1) charge', chargesLeft(1, -1, 0, 0), 1);
  eq('cleric default disable range 3', clericConfig({}), { range: 3 });
  const traps = [{ id: 'b', q: 3, r: 0 }, { id: 'a', q: 1, r: 1 }, { id: 'c', q: 4, r: 0 }, { id: 'x' }];
  eq('cleric reach: traps within 3, sorted by id', trapsInRange(traps, { q: 0, r: 0 }, 3, hd).map(t => t.id), ['a', 'b']);
  const laid = { owner: 'E', id: 't1' }, wt = { owner: 'world', id: 'wtrap:1,1' };
  eq('cleric active: laid trap card → its owner\'s discard', clericRoute(laid, 'C', 'active'), { victim: 'C', to: 'E' });
  eq('cleric active: owner keeps the card (it does not change hands)', disabledCardMoves({ ...laid, ...clericRoute(laid, 'C', 'active') }), false);
  eq('cleric active: a world trap is just gone', clericRoute(wt, 'C', 'active'), { victim: 'C', to: null });
  eq('cleric passive: building trap card → the Cleric\'s discard', clericRoute(wt, 'C', 'passive'), { victim: 'C', to: 'C' });
  eq('cleric passive: an enemy\'s laid trap on the building changes hands', disabledCardMoves({ ...laid, ...clericRoute(laid, 'C', 'passive') }), true);
}

// Hand classes (user rework 2026-11-14): a victim and the Witch's cards are picked from the reveal salt
// (the Priest's forced discard is gone — it raises a Shrine since rework #2, oracles in tools/fortress-check.mjs).
{
  eq('victim among the enemies in range, by the salt', pickBySalt('salt1:priest:7:P:who', ['E', 'F', 'G'], sha), 'E');
  eq('pick with nobody in range → null', pickBySalt('s', [], sha), null);
  eq('witch: 3 of 5 hand cards, by the salt', pickHandDiscards('salt1:witch:7:W', ['c5', 'c1', 'c3', 'c2', 'c4'], 3, sha), ['c2', 'c5', 'c4']);
  eq('witch: hand order does not matter (ids sorted first)', pickHandDiscards('salt1:witch:7:W', ['c4', 'c2', 'c3', 'c1', 'c5'], 3, sha), ['c2', 'c5', 'c4']);
  eq('witch: fewer cards than 3 → all of them, no repeats', pickHandDiscards('x', ['a', 'b'], 3, sha).sort(), ['a', 'b']);
  eq('empty hand → nothing', pickHandDiscards('x', [], 3, sha), []);
  { let ok = true; for (let i = 0; i < 100; i++) { const got = pickHandDiscards(`s${i}`, ['a', 'b', 'c', 'd', 'e', 'f'], 3, sha); if (new Set(got).size !== 3) ok = false; } eq('witch: 3 distinct cards over 100 seeds', ok, true); }
}

// Monster natural permanents (user rulings 2026-11-15, game/natural-perms.mjs; peer.mjs hooks call these).
{
  const N = await import('../natural-perms.mjs');
  const hd = (a, b) => { const q1 = a.q ?? a.tile_q, r1 = a.r ?? a.tile_r, q2 = b.q ?? b.tile_q, r2 = b.r ?? b.tile_r; return Math.max(Math.abs(q1 - q2), Math.abs(r1 - r2), Math.abs(q1 + r1 - q2 - r2)); };
  const cfg = N.naturalConfig({ copies: 2, power: 6 });
  eq('natural: Minotaur starts with 2 Earthquakes, power 6', N.naturalPermFor({ innate_effect: 'effect_earthquake' }, { effect_earthquake: {} }, cfg), { id: 'effect_earthquake', copies: 2, power: 6 });
  eq('natural: a creature without innate effect gets none', N.naturalPermFor({ innate_effect: null }, { effect_earthquake: {} }, cfg), null);
  eq('natural: copies 0 in the rule → none', N.naturalPermFor({ innate_effect: 'effect_love' }, { effect_love: {} }, N.naturalConfig({ copies: 0 })), null);
  // Rule 24 takes the two copies one at a time; the permanent itself only goes with the last.
  const one = N.dropOneCopy({ effect_earthquake: 2 }, 'effect_earthquake');
  eq('rule 24: first copy destroyed → 1 left, the permanent stands', [one.left, one.last, one.copies], [1, false, { effect_earthquake: 1 }]);
  const two = N.dropOneCopy(one.copies, 'effect_earthquake');
  eq('rule 24: second copy destroyed → the permanent falls', [two.left, two.last, two.copies], [0, true, {}]);
  eq('rule 24: a non-natural permanent (no count) falls at once', N.dropOneCopy({}, 'effect_shield').last, true);
  eq('perm_copies_json parse drops junk', N.parseCopies('{"effect_love":2,"x":0,"y":"a"}'), { effect_love: 2 });
  // Earthquake tick: the existing rule (delta Earth→Matter, all enemies in contact). Minotaur Matter 15 vs E 10, F 12.
  const stats = { C: M(17, 10, 15, 13), E: M(10, 10, 10, 10), F: M(10, 10, 12, 10), A: M(10, 10, 8, 10) };
  const tick = { actor: 'C', effect_id: 'effect_earthquake', elements: ['elem_earth'], salt: 'natural:C:4', target: null, is_instant: true, step: 1, of: 1, _channel_tick: true };
  const oc = resolveEffect(world(stats, tiles, sides), tick);
  eq('earthquake tick hits E and F (enemies in contact), not the ally', oc.hits.map(h => h.victim), ['E', 'F']);
  eq('earthquake tick: 15−10 = 5 → 1 dmg, 15−12 = 3 → 0', [dmgTo(oc, 'E'), dmgTo(oc, 'F')], [[1], [0]]);
  eq('earthquake tick lands no new permanent', oc.permanents, []);
  // The 7 rule-less effects: never cast, but a rule exists (permanent, fixed power 6) so the card is a real Permanent.
  for (const id of ['effect_love', 'effect_awe', 'effect_fear', 'effect_anger', 'effect_domination', 'effect_petrify', 'effect_mists']) {
    const o = resolveEffect(world(stats, tiles, sides), { actor: 'C', effect_id: id, elements: ['elem_harmony'], salt: 's', target: null, is_instant: false });
    eq(`${id}: a permanent on the caster`, [o.status, o.permanents], ['done', [{ on: 'C', id }]]);
  }
  // Damage gates. X = the monster, E = the afflicted hero, F = another unit (its ally or a third monster).
  const pos = { X: { q: 0, r: 0 }, E: { q: 1, r: 0 }, F: { q: 3, r: 0 }, G: { q: 0, r: 1 } };
  const dist = (a, b) => hd(pos[a], pos[b]);
  const holdsAll = () => true;
  const aff = (e) => [{ effect_id: e, by: 'X', natural: 1 }];
  eq('love: E cannot damage X', !!N.naturalDamageBlock({ attacker: 'E', victim: 'X', afflictions: aff('effect_love'), holds: holdsAll, dist }), true);
  eq('love: E may damage F', N.naturalDamageBlock({ attacker: 'E', victim: 'F', afflictions: aff('effect_love'), holds: holdsAll, dist }), null);
  eq('awe: same as love', !!N.naturalDamageBlock({ attacker: 'E', victim: 'X', afflictions: aff('effect_awe'), holds: holdsAll, dist }), true);
  eq('fear: E cannot damage F either', !!N.naturalDamageBlock({ attacker: 'E', victim: 'F', afflictions: aff('effect_fear'), holds: holdsAll, dist }), true);
  eq('fear: self-damage (Mind Blast) is not blocked', N.naturalDamageBlock({ attacker: 'E', victim: 'E', afflictions: aff('effect_fear'), holds: holdsAll, dist }), null);
  eq('anger in contact: E may damage X', N.naturalDamageBlock({ attacker: 'E', victim: 'X', afflictions: aff('effect_anger'), holds: holdsAll, dist }), null);
  eq('anger in contact: E cannot damage G', !!N.naturalDamageBlock({ attacker: 'E', victim: 'G', afflictions: aff('effect_anger'), holds: holdsAll, dist }), true);
  eq('anger out of contact: no restriction', N.naturalDamageBlock({ attacker: 'F', victim: 'G', afflictions: aff('effect_anger'), holds: holdsAll, dist }), null);
  eq('anger forced target in contact → X', N.angerForcedTarget({ actor: 'E', afflictions: aff('effect_anger'), holds: holdsAll, dist }), 'X');
  eq('anger forced target out of contact → none', N.angerForcedTarget({ actor: 'F', afflictions: aff('effect_anger'), holds: holdsAll, dist }), null);
  eq('perms fallen (holds false) → no block', N.naturalDamageBlock({ attacker: 'E', victim: 'X', afflictions: aff('effect_fear'), holds: () => false, dist }), null);
  eq('a trap affliction (not natural) is ignored', N.naturalDamageBlock({ attacker: 'E', victim: 'X', afflictions: [{ effect_id: 'effect_fear', by: 'X' }], holds: holdsAll, dist }), null);
  // Contact afflictions and the tower.
  eq('contact: an adjacent Fear holder afflicts me', N.contactAfflictions({ mine: [], holders: [{ id: 'X', effect_id: 'effect_fear', dist: 1 }, { id: 'Y', effect_id: 'effect_love', dist: 2 }], onTower: false }), [{ effect_id: 'effect_fear', by: 'X', natural: 1 }]);
  eq('contact: already afflicted → nothing new', N.contactAfflictions({ mine: aff('effect_fear'), holders: [{ id: 'X', effect_id: 'effect_fear', dist: 1 }], onTower: false }), []);
  eq('contact: on my tower → nothing', N.contactAfflictions({ mine: [], holders: [{ id: 'X', effect_id: 'effect_fear', dist: 1 }], onTower: true }), []);
  eq('contact: Domination / Petrify leave no affliction', N.contactAfflictions({ mine: [], holders: [{ id: 'X', effect_id: 'effect_petrify', dist: 1 }], onTower: false }), []);
  eq('tower lifts natural afflictions, keeps a Sleep trap', N.liftAtTower([...aff('effect_love'), { effect_id: 'effect_sleep', by: 'Z' }], true), [{ effect_id: 'effect_sleep', by: 'Z' }]);
  eq('away from the tower nothing lifts', N.liftAtTower(aff('effect_love'), false), aff('effect_love'));
  // Creation ward: Matter < the holder's Matter may not enter its adjacent hexes.
  const spider = [{ id: 'X', q: 0, r: 0, matter: 10 }];
  eq('creation: Matter 8 cannot step next to the spider', N.creationBars({ dest: { q: 1, r: 0 }, from: { q: 2, r: 0 }, moverMatter: 8, holders: spider, hexDist: hd })?.id, 'X');
  eq('creation: Matter 10 (not below) may', N.creationBars({ dest: { q: 1, r: 0 }, from: { q: 2, r: 0 }, moverMatter: 10, holders: spider, hexDist: hd }), null);
  eq('creation: a hex 2 away is free', N.creationBars({ dest: { q: 2, r: 0 }, from: { q: 3, r: 0 }, moverMatter: 8, holders: spider, hexDist: hd }), null);
  // Domination: one holder in contact → the 3rd action of the turn is lost; two → the 2nd and 3rd.
  eq('domination 1 holder: actions 1,2,3 → lost?', [0, 1, 2].map(r => N.lostToHolders(1, 3, r)), [false, false, true]);
  eq('domination 2 holders: actions 1,2,3 → lost?', [0, 1, 2].map(r => N.lostToHolders(2, 3, r)), [false, true, true]);
  // Spirit Link: the nearest allied creature, none when alone.
  const me = { peer_id: 'X', tile_q: 0, tile_r: 0, side: 'b' };
  const others = [{ peer_id: 'H', tile_q: 1, tile_r: 0, life: 3, character_id: 'c', side: 'a' }, { peer_id: 'Y', tile_q: 3, tile_r: 0, life: 3, creature_id: 'm', side: 'b' }, { peer_id: 'W', tile_q: 2, tile_r: 0, life: 0, creature_id: 'm', side: 'b' }];
  eq('spirit link: nearest living allied creature', N.nearestAlliedCreature(me, others, hd)?.peer_id, 'Y');
  eq('spirit link: alone → nothing', N.nearestAlliedCreature(me, others.slice(0, 1), hd), null);
  eq('spirit link: 2 copies = ∀ → all four stats', N.naturalLinkStats(2), ['vitality', 'world', 'will', 'matter']);
  eq('spirit link: 1 copy left → Vitality only', N.naturalLinkStats(1), ['vitality']);
  eq('spirit link: no copy → no link', N.naturalLinkStats(0), []);
}

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
