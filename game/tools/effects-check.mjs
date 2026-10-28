// Effect engine check against the worked examples from the pc rule overrides.
//   node tools/effects-check.mjs
import { createHash } from 'node:crypto';
import { diceCount, pointBuy, resolveEffect, roundHalfUp10 } from '../effects.mjs';

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

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
