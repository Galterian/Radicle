// Oracles for the monster deck effects (user rulings 2026-11-15, data/rules.json rule_monster_deck_effects):
// per-creature thematic picks (data/creatures.json deck_effects), per-instance random picks, and the npcPlan
// cast choice (game/monster-deck.mjs npcCastChoice) in stub situations.
//   node tools/monster-deck-check.mjs   → ends "all monster deck checks passed"
import fs from 'node:fs';
import { EFFECT_RULES, playableEffects, builtinEffectEntries } from '../effects.mjs';
import { LogicEngine } from '../logic-engine.mjs';
import { readCollection } from '../defs-collection.mjs';
import { fileURLToPath } from 'node:url';
import { monsterDeckConfig, pickThematicEffects, pickRandomEffects, monsterDeckSeed, npcCastChoice, npcCastable, affordable, affordableFor, effectKind, npcStuckCard } from '../monster-deck.mjs';

let fails = 0, n = 0;
const eq = (label, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fails++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } };
const rd = (f) => readCollection(fileURLToPath(new URL('../../data', import.meta.url)), f);   // split A: creatures = the GameModels catalog's
const live = (v) => v.status !== 'rejected' && v.status !== 'superseded';
const act = (e) => [...e.versions.filter(live)].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0] ?? e.versions[0];
const effects = builtinEffectEntries();   // F9: the cards = the definitions' card blocks
const playable = playableEffects(effects);
const ruleE = rd('rules').entries.find(e => e.id === 'rule_monster_deck_effects');
eq('rules.json has rule_monster_deck_effects', !!ruleE, true);
const cfg = monsterDeckConfig(act(ruleE).data.monster_deck);
eq('config: 4 thematic + 2 random', [cfg.thematic, cfg.random], [4, 2]);
eq('monster deck: 11 actions + 4 skills + effects ≥ DECK_MIN 15', 11 + 4 + cfg.thematic + cfg.random >= 15, true);

// ---- 1. per creature: recorded thematic picks
const creatures = rd('creatures').entries;
eq('29 creatures', creatures.length, 29);
for (const e of creatures) {
  const v = act(e), st = v.data.stats, de = v.data.deck_effects;
  eq(`${e.id}: deck_effects is ${cfg.thematic} ids`, Array.isArray(de) && de.length, cfg.thematic);
  if (!Array.isArray(de)) continue;
  eq(`${e.id}: distinct`, new Set(de).size, de.length);
  eq(`${e.id}: all playable`, de.filter(id => !playable.includes(id)), []);
  eq(`${e.id}: all AI-castable`, de.filter(id => !npcCastable(id, EFFECT_RULES, cfg)), []);
  eq(`${e.id}: all affordable`, de.filter(id => !affordable(st, effects[id].data.element_cost, EFFECT_RULES[id], cfg)), []);
  eq(`${e.id}: ≥1 damage`, de.some(id => effectKind(id, EFFECT_RULES) === 'damage'), true);
  eq(`${e.id}: recorded = algorithm`, de, pickThematicEffects({ id: e.id, name: e.name, tags: e.tags, data: v.data }, effects, playable, EFFECT_RULES, cfg));
}
// a defensive card wherever one is affordable
for (const e of creatures) {
  const v = act(e), de = v.data.deck_effects || [];
  const canDef = playable.some(id => effectKind(id, EFFECT_RULES) === 'defence' && npcCastable(id, EFFECT_RULES, cfg) && affordable(v.data.stats, effects[id].data.element_cost, EFFECT_RULES[id], cfg));
  if (canDef) eq(`${e.id}: one defensive`, de.some(id => effectKind(id, EFFECT_RULES) === 'defence'), true);
}

// ---- 2. per instance: random picks
const thematic = act(creatures[0]).data.deck_effects;
const seed = monsterDeckSeed('0xabc', 'lurker_3_m2', creatures[0].id);
const r1 = pickRandomEffects(seed, playable, thematic, cfg.random), r2 = pickRandomEffects(seed, playable, thematic, cfg.random);
eq('random: deterministic (restart rebuilds the same deck)', r1, r2);
eq('random: 2 picks', r1.length, cfg.random);
eq('random: distinct', new Set(r1).size, r1.length);
eq('random: not thematic', r1.filter(id => thematic.includes(id)), []);
eq('random: playable', r1.filter(id => !playable.includes(id)), []);
const spread = new Set(Array.from({ length: 12 }, (_, k) => pickRandomEffects(monsterDeckSeed('0xabc', `monster-${k}`, creatures[0].id), playable, thematic, 2).join(',')));
eq('random: differs between instances', spread.size > 6, true);

// ---- 3. npcPlan cast choice
const card = (id) => ({ kind: 'effect', effect_id: id, element_cost: [...effects[id].data.element_cost] });
const act0 = { kind: 'action', code: 'A' };
const meM = { stats: { vitality: 15, world: 10, matter: 20, will: 15 }, life: 5, lifeMax: 6, permanents: [] };
const foe = (dist, extra = {}) => ({ peer_id: `peer:foe-${dist}`, dist, life: 3, stats: { vitality: 12, world: 12, matter: 12, will: 12 }, ...extra });
const yes = () => 0, no = () => 0.999;
eq('fireball at an adjacent foe', npcCastChoice({ hand: [act0, card('effect_fireball')], me: meM, foes: [foe(1)], rules: EFFECT_RULES, cfg, rand: yes }), { index: 1, effect_id: 'effect_fireball', kind: 'damage', target: 'peer:foe-1' });
eq('fireball: foe 3 hexes away → no cast', npcCastChoice({ hand: [act0, card('effect_fireball')], me: meM, foes: [foe(3)], rules: EFFECT_RULES, cfg, rand: yes }), null);
eq('fireball: delta 0 against Matter 20 → no cast', npcCastChoice({ hand: [card('effect_fireball')], me: meM, foes: [foe(1, { stats: { vitality: 12, world: 12, matter: 20, will: 12 } })], rules: EFFECT_RULES, cfg, rand: yes }), null);
eq('chance roll fails → no cast', npcCastChoice({ hand: [card('effect_fireball')], me: meM, foes: [foe(1)], rules: EFFECT_RULES, cfg, rand: no }), null);
eq('sound wave reaches 2', npcCastChoice({ hand: [card('effect_sound_wave')], me: { ...meM, stats: { vitality: 20, world: 20, matter: 20, will: 20 } }, foes: [foe(2)], rules: EFFECT_RULES, cfg, rand: yes })?.target, 'peer:foe-2');
eq('lowest-life foe in reach is the target', npcCastChoice({ hand: [card('effect_fireball')], me: meM, foes: [foe(1), { ...foe(1), peer_id: 'peer:weak', life: 1 }], rules: EFFECT_RULES, cfg, rand: yes })?.target, 'peer:weak');
eq('shield with a foe 2 hexes away (self, no target)', npcCastChoice({ hand: [card('effect_shield')], me: meM, foes: [foe(2)], rules: EFFECT_RULES, cfg, rand: yes }), { index: 0, effect_id: 'effect_shield', kind: 'defence', target: null });
eq('shield with nobody near → no cast', npcCastChoice({ hand: [card('effect_shield')], me: meM, foes: [foe(5)], rules: EFFECT_RULES, cfg, rand: yes }), null);
eq('damage before defence', npcCastChoice({ hand: [card('effect_shield'), card('effect_fireball')], me: meM, foes: [foe(1)], rules: EFFECT_RULES, cfg, rand: yes })?.effect_id, 'effect_fireball');
eq('a standing permanent is not cast again', npcCastChoice({ hand: [card('effect_harm')], me: { ...meM, permanents: ['effect_harm'] }, foes: [foe(1)], rules: EFFECT_RULES, cfg, rand: yes }), null);
eq('harm (point-buy) at an adjacent foe', npcCastChoice({ hand: [card('effect_harm')], me: meM, foes: [foe(1)], rules: EFFECT_RULES, cfg, rand: yes })?.effect_id, 'effect_harm');
const weak = { stats: { vitality: 10, world: 10, matter: 15, will: 5 }, life: 4, lifeMax: 4, permanents: [] };
eq('unaffordable (Meteor Shower, Will 5) → no cast', npcCastChoice({ hand: [card('effect_meteor_shower')], me: weak, foes: [foe(1), foe(2)], rules: EFFECT_RULES, cfg, rand: yes }), null);
eq('unaffordable card is stuck', npcStuckCard(card('effect_meteor_shower'), weak.stats, EFFECT_RULES, cfg), true);
eq('AI-uncastable card is stuck (Teleportation)', npcStuckCard(card('effect_teleportation'), meM.stats, EFFECT_RULES, cfg), true);
eq('castable card is not stuck', npcStuckCard(card('effect_fireball'), meM.stats, EFFECT_RULES, cfg), false);
eq('AI never casts a tile / summon effect', npcCastChoice({ hand: [card('effect_teleportation'), card('effect_summoning')], me: meM, foes: [foe(1)], rules: EFFECT_RULES, cfg, rand: yes }), null);
const big = { stats: { vitality: 20, world: 20, matter: 20, will: 20 }, life: 8, lifeMax: 8, permanents: [] };
eq('meteor shower: more foes than allies within 10', npcCastChoice({ hand: [card('effect_meteor_shower')], me: big, foes: [foe(4), foe(6)], friends: [], rules: EFFECT_RULES, cfg, rand: yes })?.effect_id, 'effect_meteor_shower');
eq('meteor shower: as many allies as foes → no cast', npcCastChoice({ hand: [card('effect_meteor_shower')], me: big, foes: [foe(4), foe(6)], friends: [{ peer_id: 'a', dist: 1, life: 3 }, { peer_id: 'b', dist: 2, life: 3 }], rules: EFFECT_RULES, cfg, rand: yes }), null);
eq('turn life heals me with nobody in reach', npcCastChoice({ hand: [card('effect_turn_life')], me: { ...big, life: 5 }, foes: [foe(4)], rules: EFFECT_RULES, cfg, rand: yes }), { index: 0, effect_id: 'effect_turn_life', kind: 'damage', target: null });
eq('turn life at full life with nobody in reach → no cast', npcCastChoice({ hand: [card('effect_turn_life')], me: big, foes: [foe(4)], rules: EFFECT_RULES, cfg, rand: yes }), null);
eq('fossilization (control lock) needs contact', npcCastChoice({ hand: [card('effect_fossilization')], me: big, foes: [foe(2)], rules: EFFECT_RULES, cfg, rand: yes }), null);
eq('fossilization on an adjacent foe', npcCastChoice({ hand: [card('effect_fossilization')], me: big, foes: [foe(1)], rules: EFFECT_RULES, cfg, rand: yes })?.target, 'peer:foe-1');
eq('nothing in hand → no cast', npcCastChoice({ hand: [act0], me: meM, foes: [foe(1)], rules: EFFECT_RULES, cfg, rand: yes }), null);

// ---- 3b. allied bots (user ruling 2026-11-15: "allied npc_a heroes and summons also cast their effect cards → yes")
eq('config: allied bots cast (ally_cast)', cfg.ally_cast, true);
const hero = { stats: { vitality: 18, world: 10, matter: 15, will: 14 }, life: 6, lifeMax: 6, permanents: [] };
const fr = (dist, life, lifeMax = 6, id = `peer:friend-${dist}`) => ({ peer_id: id, dist, life, lifeMax });
const tl = (o) => npcCastChoice({ hand: [act0, card('effect_turn_life')], rules: EFFECT_RULES, cfg, rand: yes, ally: true, ...o });
eq('ally: fireball at an adjacent foe (same choice as a monster)', npcCastChoice({ hand: [act0, card('effect_fireball')], me: meM, foes: [foe(1)], friends: [fr(1, 6)], rules: EFFECT_RULES, cfg, rand: yes, ally: true }), { index: 1, effect_id: 'effect_fireball', kind: 'damage', target: 'peer:foe-1' });
eq('ally: lowest-life foe in reach first', npcCastChoice({ hand: [card('effect_fireball')], me: meM, foes: [foe(1), { ...foe(1), peer_id: 'peer:weak', life: 1 }], rules: EFFECT_RULES, cfg, rand: yes, ally: true })?.target, 'peer:weak');
eq('ally turn life: friend in contact at half life is healed even with a foe in reach', tl({ me: hero, foes: [foe(1)], friends: [fr(1, 3)] })?.target, 'peer:friend-1');
eq('ally turn life: friend lightly hurt, foe in reach → the foe', tl({ me: hero, foes: [foe(1)], friends: [fr(1, 5)] })?.target, 'peer:foe-1');
eq('ally turn life: nobody in reach, friend hurt → the friend', tl({ me: hero, foes: [foe(4)], friends: [fr(1, 5)] })?.target, 'peer:friend-1');
eq('ally turn life: the most hurt friend in contact', tl({ me: hero, foes: [], friends: [fr(1, 5, 6, 'peer:a'), fr(1, 2, 6, 'peer:b'), fr(1, 1, 2, 'peer:c')] })?.target, 'peer:b');
eq('ally turn life: friend 2 hexes away is out of reach (effects.mjs heals a declared ally within 1)', tl({ me: hero, foes: [], friends: [fr(2, 1)] }), null);
eq('ally turn life: I am worse off, nobody in reach → heals me (no target)', tl({ me: { ...hero, life: 2 }, foes: [foe(4)], friends: [fr(1, 5)] }), { index: 1, effect_id: 'effect_turn_life', kind: 'damage', target: null });
eq('monster turn life ignores a hurt friend → the foe', npcCastChoice({ hand: [card('effect_turn_life')], me: hero, foes: [foe(1)], friends: [fr(1, 1)], rules: EFFECT_RULES, cfg, rand: yes })?.target, 'peer:foe-1');
eq('friend without life_max is never healed', tl({ me: hero, foes: [], friends: [{ peer_id: 'x', dist: 1, life: 1 }] }), null);
const ms = (o) => npcCastChoice({ hand: [card('effect_meteor_shower')], me: big, rules: EFFECT_RULES, cfg, rand: yes, ...o })?.effect_id || null;
eq('meteor shower, monster: 2 foes vs 1 friend → cast', ms({ foes: [foe(4), foe(6)], friends: [fr(3, 3)] }), 'effect_meteor_shower');
eq('meteor shower, ally: 2 foes vs owner + me → no cast', ms({ foes: [foe(4), foe(6)], friends: [fr(3, 3)], ally: true }), null);
eq('meteor shower, ally: 3 foes vs owner + me → cast', ms({ foes: [foe(4), foe(6), foe(7)], friends: [fr(3, 3)], ally: true }), 'effect_meteor_shower');
eq('meteor shower, ally: 1 foe alone with me → no cast', ms({ foes: [foe(4)], friends: [], ally: true }), null);
eq('ally shield with a foe 2 hexes away', npcCastChoice({ hand: [card('effect_shield')], me: hero, foes: [foe(2)], friends: [fr(1, 6)], rules: EFFECT_RULES, cfg, rand: yes, ally: true }), { index: 0, effect_id: 'effect_shield', kind: 'defence', target: null });
// Potion Brew on an ally (user ruling 2026-11-15): the friend in contact it helps more than me.
const pb = (o) => npcCastChoice({ hand: [card('effect_potion_brew')], me: hero, rules: EFFECT_RULES, cfg, rand: yes, ally: true, ...o });
eq('ally potion brew: hurt friend in contact → the friend', pb({ foes: [foe(2)], friends: [fr(1, 2)] }), { index: 0, effect_id: 'effect_potion_brew', kind: 'defence', target: 'peer:friend-1' });
eq('ally potion brew: hurt friend, no foe near → still the friend', pb({ foes: [], friends: [fr(1, 2)] })?.target, 'peer:friend-1');
eq('ally potion brew: weaker friend (same share, smaller life max) → the friend', pb({ foes: [foe(2)], friends: [fr(1, 4, 4)] })?.target, 'peer:friend-1');
eq('ally potion brew: I am more hurt → on me', pb({ me: { ...hero, life: 1 }, foes: [foe(2)], friends: [fr(1, 5)] })?.target ?? null, null);
eq('ally potion brew: friend 2 hexes away → on me', pb({ foes: [foe(2)], friends: [fr(2, 1)] })?.target ?? null, null);
eq('monster potion brew stays on me', npcCastChoice({ hand: [card('effect_potion_brew')], me: hero, foes: [foe(2)], friends: [fr(1, 1)], rules: EFFECT_RULES, cfg, rand: yes })?.target ?? null, null);
// Looser thresholds, ally mode only (ally_min_stat / ally_min_stat_delta / heal_ignores_delta).
eq('config: ally_min_stat 8, ally_min_stat_delta 12, heal_ignores_delta', [cfg.ally_min_stat, cfg.ally_min_stat_delta, cfg.heal_ignores_delta], [8, 12, true]);
const h1611 = { stats: { vitality: 16, world: 10, matter: 15, will: 11 }, life: 4, lifeMax: 5, permanents: [] };
eq('Vit 16 / Will 11 hero: Turn Life not affordable for a monster (delta mean 13.5 < 15)', affordable(h1611.stats, effects.effect_turn_life.data.element_cost, EFFECT_RULES.effect_turn_life, cfg), false);
eq('Vit 16 / Will 11 ally: Turn Life affordable (heal judged on Vitality)', affordableFor(h1611.stats, effects.effect_turn_life.data.element_cost, EFFECT_RULES.effect_turn_life, cfg, true), true);
eq('Vit 16 / Will 11 ally: heals itself with nobody in reach', npcCastChoice({ hand: [card('effect_turn_life')], me: h1611, foes: [foe(4)], rules: EFFECT_RULES, cfg, rand: yes, ally: true })?.effect_id, 'effect_turn_life');
eq('Vit 16 / Will 11 monster: no Turn Life', npcCastChoice({ hand: [card('effect_turn_life')], me: h1611, foes: [foe(4)], rules: EFFECT_RULES, cfg, rand: yes }), null);
eq('ally: Turn Life still needs Will ≥ 8', affordableFor({ ...h1611.stats, will: 7 }, effects.effect_turn_life.data.element_cost, EFFECT_RULES.effect_turn_life, cfg, true), false);
eq('ally: delta damage needs mean ≥ 12 (Fireball, Matter 12 ok / 11 not)', [12, 11].map(m => affordableFor({ vitality: 5, world: 5, matter: m, will: 5 }, effects.effect_fireball.data.element_cost, EFFECT_RULES.effect_fireball, cfg, true)), [true, false]);
eq('ally: an affordable-for-ally card is not stuck, the same for a monster is', [true, false].map(a => npcStuckCard(card('effect_turn_life'), h1611.stats, EFFECT_RULES, cfg, a)), [false, true]);
eq('ally: a profile card the AI cannot drive is stuck too (Summoning)', npcStuckCard(card('effect_summoning'), hero.stats, EFFECT_RULES, cfg), true);

// ---- 4. logic layer: the creature validations bite
const eng = new LogicEngine();
const nac = creatures.find(e => e.id === 'mon_nacatl_hunt_pride'), nv = act(nac);
const vp = (deck) => eng.validateProposal('creatures', nac.id, { version: '9.9.9', origin: 'rebalance_script', parent_version: nv.version, data: { ...nv.data, deck_effects: deck } });
eq('logic: the recorded deck passes', vp(nv.data.deck_effects).ok, true);
eq('logic: Meteor Shower (Will 5) fails deck_effects_affordable', vp(['effect_throw', 'effect_fireball', 'effect_nature_embrace', 'effect_meteor_shower']).failures.map(f => f.id), ['deck_effects_affordable']);
eq('logic: 3 effects fail deck_effects_valid', vp(['effect_throw', 'effect_fireball', 'effect_nature_embrace']).failures.map(f => f.id), ['deck_effects_valid']);
eq('logic: a duplicate fails deck_effects_valid', vp(['effect_throw', 'effect_throw', 'effect_nature_embrace', 'effect_fireball']).failures.map(f => f.id), ['deck_effects_valid']);

console.log(fails ? `${fails} of ${n} monster deck checks FAILED` : `${n} checks — all monster deck checks passed`);
process.exit(fails ? 1 : 0);
