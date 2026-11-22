// Standing-permanent check (effect isolation F2, 2026-11-21): the definitions' `standing` programs answer exactly like the
// JS reference (effect-standing.mjs STANDING_JS = the behaviour peer.mjs had keyed on the effect ids), and the plumbing
// around them holds.
//   node tools/effect-standing-check.mjs     → ends with "all effect-standing checks passed"   (EFFECT_STANDING_CHECK_N, default 400)
// 1. files     — the built-ins with a `standing` block are /2, their hooks = the reference's, the F2 flags are where they were.
// 2. identity  — every built-in × standing hook, N seeded argument sets: data program = JS reference (JSON, key order too).
// 3. limits    — /1 + standing, unknown hook, a denied op, a bad result, a runaway program → refused / the neutral value.
// 4. validator — a player effect reusing a calibrated standing program is priced; a new one is refused.
// 5. gate      — peer.mjs names none of the effects F2 made data (code lines; comments stripped).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as FX from '../effects.mjs';
import * as DE from '../effect-engine.mjs';
import * as STM from '../effect-standing.mjs';
import { STANDING_JS } from '../effects-data/oracle/standing-js.mjs';   // F9e: the JS reference moved to the oracle
const ST = { ...STM, STANDING_JS };
import * as RB from './rebalancing-check.mjs';
import * as NPM from '../natural-perms.mjs';
import { NATURAL_KINDS } from '../effects-data/oracle/natural-kinds-js.mjs';   // F9e: the JS reference moved to the oracle
const NP = { ...NPM, NATURAL_KINDS };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.env.EFFECT_STANDING_CHECK_N || 400);
let fails = 0, oks = 0;
const J = (x) => JSON.stringify(x);
const eq = (label, got, want) => {
  const ok = J(got) === J(want);
  if (ok) oks++; else fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n     got  ${String(J(got)).slice(0, 400)}\n     want ${String(J(want)).slice(0, 400)}`}`);
  return ok;
};
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- 1. files -----------------------------------------------------------------------------------------------------
console.log('-- 1. files');
const defs = DE.loadEffectDefs();
const withStanding = [...defs.values()].filter(d => d.standing);
eq('built-ins with a standing block = the JS reference\'s effects', withStanding.map(d => d.id).sort(), Object.keys(ST.STANDING_JS).sort());
eq('they are schema chaosd6.effect/2', withStanding.filter(d => d.schema !== 'chaosd6.effect/2').map(d => d.id), []);
eq('their hooks = the reference\'s hooks', Object.fromEntries(withStanding.map(d => [d.id, Object.keys(d.standing).sort()]).sort()), Object.fromEntries(Object.entries(ST.STANDING_JS).map(([id, h]) => [id, Object.keys(h).sort()]).sort()));
eq('STANDING_HOOKS = effect-engine STANDING_HOOK_NAMES', Object.keys(ST.STANDING_HOOKS), [...DE.STANDING_HOOK_NAMES]);
const flagged = (k) => Object.keys(FX.EFFECT_RULES).filter(id => FX.EFFECT_RULES[id][k] !== undefined).sort();
eq('everyInstant = the old EVERY_INSTANT set', flagged('everyInstant'), ['effect_emotions_bombard', 'effect_light_darkness', 'effect_teleportation', 'effect_the_void']);
eq('permTurns = the old PERM_TURNS table', Object.fromEntries(flagged('permTurns').map(id => [id, FX.EFFECT_RULES[id].permTurns])), { effect_balefire: 1, effect_oblivion: 1 });
eq('lockWhileStanding / everyPermanent / keepsCastOnDestroy / everyWidens / sensesTraps / hides', ['lockWhileStanding', 'everyPermanent', 'keepsCastOnDestroy', 'everyWidens', 'sensesTraps', 'hides'].map(flagged),
  [['effect_oblivion'], ['effect_shield'], ['effect_aura'], ['effect_aura'], ['effect_super_sense'], ['effect_invisibility']]);
eq('F7 naturalKind flags = oracle natural-kinds-js.mjs NATURAL_KINDS (the JS reference)', Object.fromEntries(flagged('naturalKind').map(id => [id, FX.EFFECT_RULES[id].naturalKind])), Object.fromEntries(Object.entries(NP.NATURAL_KINDS).sort()));
eq('F7 natural kinds are the primitives, contact kinds among them', [flagged('naturalKind').every(id => NP.NATURAL_KIND_NAMES.includes(FX.EFFECT_RULES[id].naturalKind)), NP.CONTACT_KINDS.every(k => NP.NATURAL_KIND_NAMES.includes(k))], [true, true]);
eq('F7 everyOutlastsChannel / ignoresZones', ['everyOutlastsChannel', 'ignoresZones'].map(flagged), [['effect_awake'], ['effect_blizzard']]);
eq('F4 bonus flags', [flagged('bonusPlans').map(id => [id, FX.EFFECT_RULES[id].bonusPlans]), ...['bonusOncePerTurn', 'bonusOneEmission', 'everyHandSize'].map(flagged)], [[['effect_balefire', 9], ['effect_haste', 1]], ['effect_haste'], ['effect_balefire'], ['effect_haste']]);
eq('F5 summon flags', Object.fromEntries(flagged('summon').map(id => [id, FX.EFFECT_RULES[id].summon.kind])), { effect_elementals_air: 'elemental', effect_elementals_earth: 'elemental', effect_elementals_water: 'elemental', effect_golems_air: 'golem', effect_golems_earth: 'golem', effect_golems_water: 'golem', effect_resurrect_death_ward: 'resurrect', effect_summoning: 'library' });
eq('F7 naturalKind() reads the definitions (installed by effects.mjs)', [NP.naturalKind('effect_mists'), NP.naturalKind('effect_fireball'), NP.isContactNatural('effect_love'), NP.isContactNatural('effect_petrify')], ['no_attack', null, true, false]);
eq('answers(): data engine sees the same hooks as the reference', Object.keys(ST.STANDING_JS).flatMap(id => ST.STANDING_HOOK_NAMES.filter(h => ST.answers(id, h)).map(h => `${id}.${h}`)).sort(),
  Object.entries(ST.STANDING_JS).flatMap(([id, hs]) => Object.keys(hs).map(h => `${id}.${h}`)).sort());
eq('holding(): code-unit id order, unanswered dropped', ST.holding(['effect_fireball', 'effect_super_sense', 'effect_inner_fire', 'effect_super_sense'], 'damage_in'), ['effect_super_sense']);

// ---- 2. identity --------------------------------------------------------------------------------------------------
console.log(`-- 2. identity: data programs vs the JS reference (${N} argument sets per effect and hook)`);
{
  const R = mulberry32(20261121);
  const pick = (l) => l[Math.floor(R() * l.length)];
  const ids = ['peer:a', 'peer:b', 'peer:c'];
  const argsFor = (h) => ({
    combat_out: () => ({ holder: pick(ids), code: pick(['A', 'B', 'EP', 'M']), dmg: pick([0, 1, 1, 2, 3]), every: R() < 0.3 }),
    damage_in: () => ({ holder: pick(ids), attacker: pick(ids), amount: pick([0, 1, 2, 5]), source: pick(['action', 'effect', 'trap']), every: R() < 0.3 }),
    cast_in: () => ({ holder: pick(ids), caster: pick(ids), effect_id: pick(['effect_fireball', 'effect_lightning']), last_elem: pick(['elem_fire', 'elem_air', 'elem_time']), every: R() < 0.5 }),
    adjacent_lost: () => ({ holder: pick(ids), victim: pick(ids), every: R() < 0.3 }),
    plan_emit: () => { const of = 1 + Math.floor(R() * 4); return { holder: pick(ids), step: 1 + Math.floor(R() * of), of, every: R() < 0.3 }; },
    afflicted: () => ({ holder: pick(ids), victim: pick(ids), in_contact: R() < 0.5, every: R() < 0.3 }),
    harm_in: () => ({ holder: pick(ids), caster: pick(ids), effect_id: pick(['effect_fireball', 'effect_lightning', null]), every: R() < 0.5 }),
    breaks: () => {
      const play = () => ({ action: pick(['A', 'B', 'M', 'P', 'EP', 'EM', 'BT']), trance: R() < 0.2 ? pick([['A'], ['B', 'P'], ['EP'], []]) : null, effect_id: pick([null, null, 'effect_fireball', 'effect_invisibility']) });
      return { holder: pick(ids), self: 'effect_invisibility', plays: Array.from({ length: Math.floor(R() * 3) }, play), dealt_damage: R() < 0.4, every: R() < 0.3, extra_codes: pick([[], [], ['EP', 'EM']]) };
    },
  })[h]();
  const bad = {};
  let cases = 0;
  for (const [id, hooks] of Object.entries(ST.STANDING_JS)) for (const h of Object.keys(hooks)) for (let i = 0; i < N; i++) {
    const a = argsFor(h);
    const js = J(hooks[h](a)), pre = J(a);
    const da = J(ST.standing(h, id, null, a));   // default engine = data
    cases++;
    if (J(a) !== pre) bad[`${id} ${h}`] = 'MUTATED ARGS';
    else if (js !== da) { if (!bad[`${id} ${h}`]) console.log(`DIFF ${id} ${h} ${pre}\n  js   ${js}\n  data ${da}`); bad[`${id} ${h}`] = (bad[`${id} ${h}`] | 0) + 1; }
  }
  eq(`${cases} cases (engine ${ST.STANDING_ENGINE}), mismatching effect hooks`, bad, {});
  eq('no standing program error on the way', ST.standingStats.errors, 0);
  const brk = (plays, extra) => ST.standing('breaks', 'effect_invisibility', null, { holder: 'peer:a', self: 'effect_invisibility', plays, dealt_damage: false, every: false, extra_codes: extra });
  const ep = [{ action: 'EP', trance: null, effect_id: null }];
  eq('breaks: a Reaver EP breaks Invisibility with extra_codes [EP, EM], not with []', [brk(ep, ['EP', 'EM']), brk(ep, [])], [true, false]);
  eq('breaks: casting Invisibility itself does not break it, another cast does', [brk([{ action: 'P', trance: null, effect_id: 'effect_invisibility' }], []), brk([{ action: 'P', trance: null, effect_id: 'effect_fireball' }], [])], [false, true]);
  eq('harm_in: Blessing negates only doubled (spends the ∀ copy)', [ST.standing('harm_in', 'effect_blessing_curse', null, { holder: 'peer:a', caster: 'peer:b', effect_id: 'effect_fireball', every: true }), ST.standing('harm_in', 'effect_blessing_curse', null, { holder: 'peer:a', caster: 'peer:b', effect_id: 'effect_fireball', every: false })], [{ negate: true, spend: 'every' }, null]);
  eq('an effect without a standing program answers the neutral value', [ST.standing('combat_out', 'effect_fireball', null, { dmg: 3 }), ST.standing('cast_in', 'effect_fireball', null, {}), ST.standing('damage_in', 'effect_nope', null, { amount: 2 })], [3, null, { amount: 2, spend: false }]);
}

// ---- 3. limits ----------------------------------------------------------------------------------------------------
console.log('-- 3. schema, bad programs, limits');
{
  const base = JSON.parse(J(defs.get('effect_inner_fire')));
  const subs = defs.get('effect_inner_fire').$subs;
  const v = (d) => DE.validateEffectDef(d, subs);
  eq('the bundled Inner Fire validates', v(base), []);
  eq('a /1 definition without standing still validates', v({ ...base, schema: 'chaosd6.effect/1', standing: undefined, bot: undefined, card: undefined }), []);
  eq('/1 with a standing block is refused', v({ ...base, schema: 'chaosd6.effect/1', bot: undefined, card: undefined }), ['standing needs schema chaosd6.effect/2']);
  eq('an unknown standing hook is refused', v({ ...base, standing: { fly: 1 } }).some(e => /standing\.fly: unknown hook/.test(e)), true);
  for (const op of ['emit', 'put', 'rng', 'point_buy', 'note']) eq(`denied op ${op} refused in a standing program`, v({ ...base, standing: { combat_out: { [op]: ['hits', 1] } } }).some(e => e.includes(op)), true);
  eq('an effect ctx query (stat_of) is not in the standing vocabulary', v({ ...base, standing: { combat_out: { stat_of: ['a', 'elem_fire'] } } }).some(e => /unknown operation stat_of/.test(e)), true);
  const reg = (id, standing) => { const d = DE.loadEffectDefs({ effects: [{ ...base, id, standing }] }).get(id); FX.registerForeignEffect(`test:${id}`, id, d.flags, () => FX.noRulesOutcome(), d); };
  const e0 = ST.standingStats.errors;
  reg('effect_test_bad_shape', { combat_out: 'lots' });
  eq('a bad result shape → the neutral value (dmg unchanged)', ST.standing('combat_out', 'effect_test_bad_shape', null, { dmg: 1 }), 1);
  const loop = (body) => ({ reduce: [{ range: [0, 60] }, { '+': [{ var: 'accumulator' }, body] }, 0] });
  reg('effect_test_runaway', { damage_in: loop(loop(loop(1))) });
  eq('a runaway program (op budget) → the neutral value', ST.standing('damage_in', 'effect_test_runaway', null, { amount: 2 }), { amount: 2, spend: false });
  reg('effect_test_ep', { afflicted: { obj: { no_cast: false, only: 'M' } } });
  eq('afflicted may only force an Empty Posture (a Move is refused → neutral)', ST.standing('afflicted', 'effect_test_ep', null, {}), { no_cast: false, only: null });
  eq('the failures above were tallied', ST.standingStats.errors - e0, 3);
  reg('effect_test_double_fire', { combat_out: { '*': [{ var: 'dmg' }, 2] } });
  eq('a foreign effect\'s standing program runs (registered definition)', [ST.answers('effect_test_double_fire', 'combat_out'), ST.standing('combat_out', 'effect_test_double_fire', null, { dmg: 3 })], [true, 6]);
}

// ---- 4. validator -------------------------------------------------------------------------------------------------
console.log('-- 4. validator: standing programs are priced only when calibrated');
{
  const ifire = JSON.parse(J(defs.get('effect_inner_fire')));
  const variant = { ...ifire, id: 'effect_ember_heart', name: 'Ember Heart', version: '0.1.0', elements: ['elem_fire', 'elem_fire'], card: undefined };   // F9: a player variant needs no card
  const r1 = RB.checkEffect(variant);
  const named = JSON.parse(fs.readFileSync(path.join(HERE, 'rebalancing-calibration.json'), 'utf8')).weights.named.effect_inner_fire;
  eq('a variant reusing Inner Fire\'s combat_out is valid, priced at Inner Fire\'s named weight', [r1.valid, r1.verdict, r1.power?.components?.standing], [true, 'ok', named]);
  const r2 = RB.checkEffect({ ...variant, id: 'effect_ember_heart_x', standing: { combat_out: { '*': [{ var: 'dmg' }, 3] } } });
  eq('a new combat_out program is refused (not calibrated)', [r2.verdict, (r2.errors || []).some(e => /not a calibrated standing program/.test(e))], ['reject', true]);
  eq('every built-in with standing still validates', withStanding.map(d => RB.checkEffect(d)).filter(r => r.valid === false).map(r => `${r.effect_id}: ${(r.errors || []).join('; ')}`), []);
}

// ---- 5. gate ------------------------------------------------------------------------------------------------------
console.log('-- 5. gate: peer.mjs does not name the effects F2 / F3 / F7 made data');
{
  const F2 = ['effect_inner_fire', 'effect_super_sense', 'effect_disable', 'effect_delay_time', 'effect_empower', 'effect_sleep', 'effect_confusion', 'effect_aura', 'effect_shield',
    'effect_oblivion', 'effect_the_void', 'effect_light_darkness', 'effect_teleportation', 'effect_emotions_bombard', 'effect_invisibility', 'effect_blessing_curse', 'effect_haste', 'effect_balefire', 'effect_summoning', 'effect_golems_earth', 'effect_golems_water', 'effect_golems_air', 'effect_elementals_air', 'effect_elementals_water', 'effect_elementals_earth', 'effect_resurrect_death_ward',
    'effect_awake', 'effect_blizzard', 'effect_phantom', 'effect_earthquake', 'effect_creation', 'effect_spirit_link', 'effect_love', 'effect_awe', 'effect_fear', 'effect_anger', 'effect_domination', 'effect_petrify', 'effect_mists'];
  const code = fs.readFileSync(path.join(HERE, '..', 'peer.mjs'), 'utf8').split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  eq('no F2 / F3 / F7 effect id literal in peer.mjs code', F2.filter(id => new RegExp(`\\b${id}\\b`).test(code)), []);
  eq('the EVERY_INSTANT / PERM_TURNS tables and the invisibilityBreaks import are gone', ['EVERY_INSTANT', 'PERM_TURNS', 'invisibilityBreaks'].filter(n => new RegExp(`\\b${n}\\b`).test(code)), []);
}

// ---- 6. bot / ui blocks (F8) ----------------------------------------------------------------------------------------
console.log('-- 6. bot / ui blocks (F8): validated, read by monster-deck / effect-results / main.js / swarm-test without ids');
{
  const base = JSON.parse(J(defs.get('effect_shield')));
  const subs = defs.get('effect_shield').$subs;
  const v = (d) => DE.validateEffectDef(d, subs);
  eq('the bundled Shield (bot block) validates', v(base), []);
  eq('bot on /1 is refused', v({ ...base, schema: 'chaosd6.effect/1', card: undefined }), ['bot needs schema chaosd6.effect/2']);
  eq('unknown bot / ui keys and bad values are refused', [v({ ...base, bot: { fly: true } }), v({ ...base, bot: { names: ['(('] } }), v({ ...base, bot: { ai: true } }), v({ ...base, ui: { colour: 'red' } })].map(e => e.length > 0), [true, true, true, true]);
  eq('EFFECT_BOT / EFFECT_UI = the definitions', [Object.keys(FX.EFFECT_BOT).length, Object.keys(FX.EFFECT_UI).length], [[...defs.values()].filter(d => d.bot).length, [...defs.values()].filter(d => d.ui).length]);
  eq('ai: false on the effects bots cannot drive', Object.keys(FX.EFFECT_BOT).filter(id => FX.EFFECT_BOT[id].ai === false).sort(), ['effect_aura', 'effect_emotions_bombard', 'effect_invisibility']);
  const strip = (f) => fs.readFileSync(path.join(HERE, '..', f), 'utf8').split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  const ids = (f) => [...new Set(strip(f).match(/\beffect_[a-z0-9_]+\b/g) || [])].filter(x => !/^effect_(id|ids|types|source|result|results|cost|in|leg|ui|rules|kind|name|names|card|cards|meta|of|elements|every|hint|catalog|toasts|outcomes|engine|defs|data|bot|key|keys|ref|refs|fx|pick|q|r)$/.test(x)).sort();
  eq('monster-deck.mjs names no effect', ids('monster-deck.mjs'), []);
  eq('effect-results.mjs names no effect', ids('effect-results.mjs'), []);
  // F6: Possess was the last — no file the game runs names an effect (main.js: two made-up ids in the effect-source notice demo).
  eq('js/main.js names no effect', ids('js/main.js').filter(x => !/^effect_(fire_whip|frost_lance)$/.test(x)), []);
  eq('tools/swarm-test.mjs names no effect', ids('tools/swarm-test.mjs'), []);
  eq('peer.mjs / possess.mjs name no effect', [...ids('peer.mjs'), ...ids('possess.mjs')], []);
  // F9e: the JS references moved to effects-data/oracle — the engine modules the game runs name no effect either.
  const engineFiles = ['effects.mjs', 'effect-prims.mjs', 'effect-standing.mjs', 'natural-perms.mjs', 'effect-hooks.mjs', 'effect-engine.mjs', 'effects-handshake.mjs', 'defs-collection.mjs'];
  eq('effects / effect-prims / effect-standing / natural-perms / effect-hooks / effect-engine / handshake / defs-collection name no effect', engineFiles.flatMap(f => ids(f).filter(x => x !== 'effect_known').map(x => `${f}: ${x}`)), []);   // effect_known: a hook ctx query
  eq('the game does not import the oracle statically', engineFiles.filter(f => /^import [^\n]*effects-data\/oracle/m.test(strip(f))), []);
}

// ---- 7. card blocks (F9) ---------------------------------------------------------------------------------------------
console.log('-- 7. card blocks (F9): the cards the game deals = the frozen data/effects.json, read from the definitions');
{
  const j = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'data', 'effects.json'), 'utf8'));
  const act = (e) => { const l = e.versions.filter(v => v.status !== 'rejected' && v.status !== 'superseded'); l.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)); return l[0] ?? e.versions[0]; };
  // User ruling 2026-11-22: the definition names win — these cards were renamed after data/effects.json froze.
  const RULED_NAMES = { effect_elementals_air: 'Air Elemental', effect_elementals_earth: 'Earth Elemental', effect_elementals_water: 'Water Elemental',
    effect_golems_air: 'Air Golem', effect_golems_earth: 'Earth Golem', effect_golems_water: 'Water Golem', effect_meteor_shower: 'Meteor Shower',
    effect_space_bending: 'Space Bending', effect_spirit_link: 'Spirit Link', effect_super_force: 'Super Force', effect_traps_mastery: 'Traps Mastery' };
  const nameOf = (e) => RULED_NAMES[e.id] ?? e.name;
  eq('ruled names: card name = definition name, and the frozen file still has the old one', Object.keys(RULED_NAMES).filter(id => defs.get(id)?.card?.name !== RULED_NAMES[id] || defs.get(id)?.name !== RULED_NAMES[id] || j.entries.find(e => e.id === id)?.name === RULED_NAMES[id]), []);
  eq('every card name = its definition name', [...defs.values()].filter(d => d.card && d.card.name !== d.name).map(d => d.id), []);
  const old = Object.fromEntries(j.entries.map(e => [e.id, { id: e.id, name: nameOf(e), tags: e.tags || [], data: act(e).data }]));
  const now = FX.builtinEffectEntries();
  eq('builtinEffectEntries = data/effects.json active versions (ids, name, tags, data; key order too)', Object.keys(now).sort().map(id => J(now[id]) === J(old[id]) ? id : `${id} DIFFERS`), Object.keys(old).sort());
  const cat = FX.builtinEffectCatalog();
  eq('builtinEffectCatalog keeps every entry\'s resources', cat.entries.filter(e => J(e.resources) !== J(j.entries.find(x => x.id === e.id)?.resources)).map(e => e.id), []);
  eq('every built-in has a card, every card one canonical version = the definition\'s', cat.entries.map(e => [e.id, e.versions.length, e.versions[0].version === defs.get(e.id).version]).filter(x => x[1] !== 1 || !x[2]), []);
  const base = JSON.parse(J(defs.get('effect_fireball')));
  const v = (d) => DE.validateEffectDef(d, defs.get('effect_fireball').$subs);
  eq('the bundled Fireball (card block) validates', v(base), []);
  eq('card on /1 is refused', v({ ...base, schema: 'chaosd6.effect/1', bot: undefined }), ['card needs schema chaosd6.effect/2']);
  eq('bad cards are refused (element_cost ≠ elements, unknown data key, no text, no name, unknown card key)', [
    v({ ...base, card: { ...base.card, data: { ...base.card.data, element_cost: ['elem_fire'] } } }),
    v({ ...base, card: { ...base.card, data: { ...base.card.data, damage: 9 } } }),
    v({ ...base, card: { ...base.card, data: { ...base.card.data, text: undefined } } }),
    v({ ...base, card: { ...base.card, name: '' } }),
    v({ ...base, card: { ...base.card, power: 3 } }),
  ].map(e => e.length > 0), [true, true, true, true, true]);
  eq('card.logic / card.rebalance_links = data/effects.json active versions (F9b, the logic layer)', j.entries.filter(e => { const c = defs.get(e.id)?.card || {}, v = act(e); return J(c.logic) !== J(v.logic) || J(c.rebalance_links || []) !== J(v.rebalance_links || []); }).map(e => e.id), []);
  const LE = await import('../logic-engine.mjs');
  const eng = new LE.LogicEngine();
  eq('the logic engine reads effects from the definitions (index.json `definitions`), same active data', [LE.definitionsDirOf(eng.index, 'effects'), j.entries.filter(e => J(eng.activeOf(e.id)?.data) !== J(act(e).data)).map(e => e.id)], ['game/effects-data/effects', []]);
  const DC = await import('../defs-collection.mjs');
  const served = JSON.parse(DC.definitionsCollectionText(path.join(HERE, '..', '..', 'data'), '/effects.json') || 'null');
  const ent = (e) => J({ id: e.id, name: nameOf(e), tags: e.tags || [], resources: e.resources, data: act(e).data, logic: act(e).logic });
  eq('/data/effects.json served from the definitions = the frozen file entry by entry (F9c: browser / Godot UI)', [served?.entries?.length, (served?.entries || []).filter(e => ent(e) !== ent(j.entries.find(x => x.id === e.id) || { versions: [{}] })).map(e => e.id)], [j.entries.length, []]);
  eq('only the top-level file of a definitions collection is rewritten (nested paths, a plain collection → the file as is)', [DC.definitionsCollectionText(path.join(HERE, '..', '..', 'data'), '/x/effects.json'), DC.definitionsCollectionText(path.join(HERE, '..', '..', 'data'), '/rules.json')], [null, null]);
  const peer = fs.readFileSync(path.join(HERE, '..', 'peer.mjs'), 'utf8');
  eq('peer.mjs no longer loads data/effects.json (collection list) and takes data.effects from the definitions', [/'classes', 'effects', 'elements'/.test(peer), /data\.effects = builtinEffectEntries\(\)/.test(peer)], [false, true]);
}

console.log(fails ? `${fails} effect-standing check(s) FAILED (${oks} ok)` : `all effect-standing checks passed (${oks} ok)`);
process.exit(fails ? 1 : 0);
