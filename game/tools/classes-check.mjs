// Class rules check (chaosD6-Classes C1): game/classes.mjs against the inline class code of peer.mjs.
//   node tools/classes-check.mjs            → ends with "all class checks passed"   (CLASSES_CHECK_N=… cases per hook, default 400)
// 1. table: CLASS_RULES covers data/classes.json; CLASS_NEEDS / PASSIVE_TURN_CLASSES / HAND defaults / local
//    descriptors = the peer.mjs tables; TRAP_POWER / pickBySalt / pointBuy = effects.mjs.
// 2. worked examples from the user's rulings (strike die 6, recast / untap, Guardian, Overlord, Avenger, Rogue, Cleric).
// 3. identity: ≥ 300 seeded random worlds per hook and class — the REF_* functions below are the peer.mjs code as it
//    is on 2026-11-16 (copied verbatim, only the closure names bound to the test world; grep the quoted anchors in
//    peer.mjs), compared JSON-for-JSON with classHook(...) on a deep copy of the same world.
// Under CLASS_ENGINE=shadow|data (tools/class-engine-check.mjs runs it that way) the classHook side is the data engine.
import { CLASS_RULES, CLASSES_IMPLEMENTED, CLASS_NEEDS, PASSIVE_TURN_CLASSES, ABILITY_REQUESTS, TRAP_POWER as CL_TRAP_POWER, ELEM_TO_STAT as CL_E2S, HOOK_NAMES, classHook, CLASS_ENGINE, classBundleErrors, installClassOracle } from '../classes.mjs';
import { TRAP_POWER, pickBySalt, pointBuy } from '../effects.mjs';
import { pointBuy as enginePointBuy } from '../effect-engine.mjs';
import { rogueConfig, clericConfig, manipulatorConfig, avengerConfig, prophetConfig, animatorConfig, priestConfig, seekerConfig, maxStanding } from '../classes-data/oracle/class-configs.mjs';
import { combatHit, attackHit, pickManipTarget, isWildMonster, lureTargets, chaseBonusStep, prophetPick } from '../contact-prims.mjs';
import { shrineMade, copyMade } from '../world-prims.mjs';   // class isolation phase 6 (were class-*.mjs)
import { CLASSES, SKILLS, ELEM_TO_STAT, STATS, genWorld, argsFor, sha256Hex, hexDistance, sideOf as fxSide } from './class-fixtures.mjs';
import { channelBreaks } from '../channel-rule.mjs';
import * as CS from '../class-state.mjs';
// phase 6: the JS reference hooks are the oracle in classes-data/oracle — needed for CLASS_ENGINE=js | shadow
if (CLASS_ENGINE !== 'data') installClassOracle(await import('../classes-data/oracle/classes-js.mjs'));

let fails = 0, oks = 0;
const J = (x) => JSON.stringify(x);
const eq = (label, got, want, quietOk = false) => {
  const g = J(got), w = J(want), ok = g === w;
  if (ok) oks++; else fails++;
  if (!ok || !quietOk) console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${String(g).length > 300 ? String(g).slice(0, 300) + '…' : g}${ok ? '' : `\n     want ${String(w).length > 300 ? String(w).slice(0, 300) + '…' : w}`}`);
  return ok;
};
const N = Number(process.env.CLASSES_CHECK_N || 400);
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
if (CLASS_ENGINE !== 'js') console.log(`note: CLASS_ENGINE=${CLASS_ENGINE} — classHook answers through the ${CLASS_ENGINE} engine`);

// ---- 1. table -------------------------------------------------------------------------------------------------
console.log('-- 1. table');
// Class isolation phase 1: CLASS_RULES = the bundled definitions, sorted by id.
eq('every bundled definition loads', classBundleErrors(), []);
eq('CLASS_RULES ids = data/classes.json ids (sorted)', CLASSES_IMPLEMENTED, Object.keys(CLASSES).sort());
// peer.mjs "const CLASS_NEEDS = {" (verbatim)
const OLD_NEEDS = {
  class_animator: 'tile', class_priest: 'tile', class_alchemist: 'tile', class_warrior: 'tile',
  class_healer: 'ally_or_self', class_overlord: 'ally_or_self',
  class_witch: 'enemy_near', class_avenger: 'monster_near',
  class_ranger: 'attach_effect', class_seeker: 'attach_effect',
};
eq('CLASS_NEEDS = peer.mjs CLASS_NEEDS', Object.fromEntries(Object.entries(CLASS_NEEDS).sort()), Object.fromEntries(Object.entries(OLD_NEEDS).sort()));
// peer.mjs "const PASSIVE_TURN_CLASSES = new Set([" (verbatim)
const OLD_PASSIVE = new Set(['class_elementalist', 'class_rogue', 'class_manipulator']);
eq('PASSIVE_TURN_CLASSES = peer.mjs set', [...PASSIVE_TURN_CLASSES].sort(), [...OLD_PASSIVE].sort());
// peer.mjs "const HAND_CLASS_DEFAULTS = {" (verbatim)
const HAND_CLASS_DEFAULTS = {
  class_prophet: { hand_reveal: { n: 'all' }, passive: true },
  class_witch: { hand_discard: { n: 3 } },
};
eq('handDefaults = peer.mjs HAND_CLASS_DEFAULTS', Object.fromEntries(CLASSES_IMPLEMENTED.filter(id => CLASS_RULES[id].handDefaults).map(id => [id, CLASS_RULES[id].handDefaults])), HAND_CLASS_DEFAULTS);
// peer.mjs "const CLASS_LOCAL = {": Paladin / Shaman / Kensei recover an action / effect / skill card, Weapon Master draws one, Summoner gets a Summoning.
eq('local descriptors = peer.mjs CLASS_LOCAL', Object.fromEntries(CLASSES_IMPLEMENTED.filter(id => CLASS_RULES[id].phase === 'local').map(id => [id, classHook('local', id, null)])), sortKeys({
  class_weapon_master: { op: 'draw', n: 2, max_hand: 3 } /* CR 2026-11-17; CP 2026-11-19 (pick 1 a): draw 2 */, class_summoner: { op: 'grant', effect_id: 'effect_summoning' },
  class_paladin: { op: 'recover', kind: 'action', what: 'an action card' }, class_shaman: { op: 'recover', kind: 'effect', what: 'an effect card' }, class_kensei: { op: 'recover', kind: 'skill', what: 'a skill card' } }));
// peer.mjs post-pass: "if (!ab || ['class_elementalist', 'class_illusionist', 'class_rogue'].includes(ab.id)) continue;" + its switch cases
const POST_CASES = ['class_healer', 'class_overlord', 'class_druid', 'class_witch', 'class_avenger', 'class_animator', 'class_priest', 'class_cleric', 'class_alchemist', 'class_ranger', 'class_seeker', 'class_warrior', 'class_necromancer'];
eq('phase post = the post-pass switch cases', CLASSES_IMPLEMENTED.filter(id => CLASS_RULES[id].phase === 'post').sort(), [...POST_CASES].sort());
eq('phase pre = Illusionist', CLASSES_IMPLEMENTED.filter(id => CLASS_RULES[id].phase === 'pre'), ['class_illusionist']);
// Phase 3: the map-bound abilities ask the engine (simulate() 'ability requests'); each request = the old config.
const REQ = {
  class_animator: (cd) => ({ copy_building: [animatorConfig(cd)] }),
  class_priest: (cd) => ({ build: [{ ...priestConfig(cd), max_standing: maxStanding(cd) }] }),
  class_seeker: (cd) => ({ far_trap: [{ ...seekerConfig(cd), max_standing: maxStanding(cd) }] }),
  class_cleric: (cd) => ({ disable_traps: [{ radius: clericConfig(cd).range }] }),
  class_warrior: () => ({ step: [{ n: 1 }] }),
};
eq('engine requests = copy_building / build / far_trap / disable_traps / step', [...ABILITY_REQUESTS].sort(), ['build', 'copy_building', 'disable_traps', 'far_trap', 'step']);
eq('every listed hook exists', CLASSES_IMPLEMENTED.flatMap(id => CLASS_RULES[id].hooks.filter(h => !h.startsWith('peer:') && !HOOK_NAMES.includes(h)).map(h => `${id}:${h}`)), []);
eq('TRAP_POWER = effects.mjs TRAP_POWER', CL_TRAP_POWER, TRAP_POWER);
eq('ELEM_TO_STAT = data/elements.json stats', CL_E2S, ELEM_TO_STAT);
{
  let same = true;
  for (let s = 0; s < 3000 && same; s++) { const stat = s % 26; const a = pointBuy(stat, `x${s}`, sha256Hex), b = enginePointBuy(stat, `x${s}`, sha256Hex); same = J(a) === J(b); }
  eq('effect-engine pointBuy = effects.mjs pointBuy (3000 seeds)', same, true);
}

// ---- REF: the peer.mjs code, verbatim, bound to a fixture world ------------------------------------------------
function refWorld(W, ctx) {
  const PEER_ID_STRING = ctx.self, PEER_LABEL = ctx.label;
  const view = W.view;
  const data = { classes: Object.fromEntries(Object.keys(CLASSES).map(id => [id, { name: CLASSES[id].name, data: ctx.classData(id) }])), skills: Object.fromEntries(Object.keys(SKILLS).map(id => [id, { data: SKILLS[id].data }])) };
  const hg = { turn: ctx.turn, action: ctx.action };
  const lifeOf = ctx.lifeOf, distBetween = ctx.dist, enemyOf = ctx.enemyOf, hasPerm = ctx.hasPerm, statOf = ctx.statOf, sideOf = ctx.sideOf;
  const parseJson = (s, dflt) => { try { const v = JSON.parse(s || ''); return Array.isArray(v) ? v : dflt; } catch { return dflt; } };
  const effCtx = { library: () => ctx.library() };
  // "const classColours = (classId) =>" … "const classKindOf = (classId) =>"
  const classColours = (classId) => { const cols = {}; for (const el of data.classes[classId]?.data?.colors || []) { const st = ELEM_TO_STAT[el]; if (st) (cols[st] ||= []).push(el); } return cols; };
  const classDataOf = (classId) => data.classes[classId]?.data || {};
  const classRangeOf = (classId) => Number.isInteger(classDataOf(classId).range) ? classDataOf(classId).range : 3;
  const handRevealOf = (classId) => classDataOf(classId).hand_reveal || HAND_CLASS_DEFAULTS[classId]?.hand_reveal || null;
  const handDiscardOf = (classId) => classDataOf(classId).hand_discard || HAND_CLASS_DEFAULTS[classId]?.hand_discard || null;
  const classPassive = (classId) => OLD_PASSIVE.has(classId) || !!(classDataOf(classId).passive ?? HAND_CLASS_DEFAULTS[classId]?.passive);
  const classKindOf = (classId) => classPassive(classId) ? 'passive' : (data.classes[classId]?.data?.ability_kind || 'static');
  const elemsOfStat = (st) => Object.keys(ELEM_TO_STAT).filter(el => ELEM_TO_STAT[el] === st);
  const reanimatedAll = (peers) => CS.unionOf(peers.map(p => p?.class_state_json), 'raised');   // phase 2 (= peer.mjs)
  const tileNear = (id, t) => { const v = view.get(id); return !!v && !!t && Number.isInteger(t.q) && Number.isInteger(t.r) && ((Math.abs(v.tile_q - t.q) + Math.abs(v.tile_r - t.r) + Math.abs(v.tile_q + v.tile_r - t.q - t.r)) / 2) <= 1; };
  const libraryCardFor = (salt) => { const lib = effCtx.library(); return lib.length ? lib[parseInt(sha256Hex(salt).slice(0, 8), 16) % lib.length] : null; };
  return { PEER_ID_STRING, PEER_LABEL, view, data, hg, lifeOf, distBetween, enemyOf, hasPerm, statOf, sideOf, parseJson, effCtx, classColours, classDataOf, classRangeOf, handRevealOf, handDiscardOf, classKindOf, elemsOfStat, reanimatedAll, tileNear, libraryCardFor };
}

// The abilities of simulate(): the pre-pass Illusionist and the post-pass switch, verbatim.
function REF_ability(W, ctx, classId, { actor, ab: ab0, salt, moved }) {   // CP 2026-11-19: + moved (peer hunk cp healer_moved: !!moveCodeOf(r))
  const { PEER_ID_STRING, PEER_LABEL, view, data, hg, lifeOf, distBetween, enemyOf, hasPerm, statOf, sideOf, parseJson, classColours, classRangeOf, handDiscardOf, elemsOfStat, reanimatedAll, tileNear, libraryCardFor } = refWorld(W, ctx);
  const logs = [];
  const log = (s) => logs.push(s);
  const r = { actor, salt, classAbility: ab0 };
  const classAbilityOut = { used: [], heals: [], discards: [], peeks: [], traps: [], tokens: [], armor: [], illusion: [], revives: [], moves: [], stealth: [], rogueTrap: [], lures: [], builds: [] };
  const abilityTile = (ab) => ab?.target?.kind === 'tile' ? ab.target.ref : null;
  const abilityPeer = (ab) => ab?.target?.kind === 'character' ? ab.target.ref : null;
  const adjacentOf = (id, pred) => [...view.keys()].filter(o => o !== id && lifeOf(o) > 0 && distBetween(id, o) <= 1 && pred(o)).sort();
  const foesNearby = (id, range) => [...view.keys()].filter(o => o !== id && lifeOf(o) > 0 && enemyOf(id, o) && distBetween(id, o) <= range && !hasPerm(o, 'effect_invisibility')).sort();
  const useAbility = (r, note) => { classAbilityOut.used.push({ actor: r.actor, class_id: r.classAbility.id }); if (r.actor === PEER_ID_STRING) log(`[${PEER_LABEL}] class ${r.classAbility.id}: ${note}`); };
  const ILLUSION_RANGE = 10;
  const ab = r.classAbility;
  if (ab?.id === 'class_illusionist') {
    const allies = [...view.keys()].filter(o => o !== r.actor && lifeOf(o) > 0 && !enemyOf(r.actor, o) && distBetween(r.actor, o) <= ILLUSION_RANGE).sort();
    for (const o of [r.actor, ...allies]) classAbilityOut.illusion.push({ on: o, by: r.actor });
    useAbility(r, `an illusion life point for me and ${allies.length} all${allies.length === 1 ? 'y' : 'ies'} until the turn's 3rd action`);
    return { classAbilityOut, logs };
  }
  {
    const me = r.actor, v = view.get(me) || {};   // (the resolver only reaches here for a revealer, whose snapshot exists)
    const tile = abilityTile(ab), peer = abilityPeer(ab);
    const nearAlly = peer && peer !== me && lifeOf(peer) > 0 && distBetween(me, peer) <= 1 && !enemyOf(me, peer) ? peer : null;
    const stat = ['vitality', 'world', 'matter', 'will'].includes(ab.stat) ? ab.stat : 'vitality';
    const here = { q: v.tile_q, r: v.tile_r };
    const spot = tile && tileNear(me, tile) ? { q: tile.q, r: tile.r } : here;
    switch (ab.id) {
      // CR 2026-11-17: me AND the adjacent ally (pointed at, else the first adjacent living ally by id)
      // CP 2026-11-19 (pick 4 a): data unmoved_only / ally_required — no use (the card stays untapped)
      case 'class_healer': { const hd = data.classes.class_healer?.data || {};
        if (hd.unmoved_only === true && moved === true) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class healer: I move this action — the card stays untapped`); break; }
        const ally = nearAlly || adjacentOf(me, o => !enemyOf(me, o))[0] || null;
        if (hd.ally_required === true && !ally) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class healer: no ally next to me — the card stays untapped`); break; }
        classAbilityOut.heals.push({ on: me, amount: 1, by: me }); if (ally) classAbilityOut.heals.push({ on: ally, amount: 1, by: me }); useAbility(r, `one life token restored to me${ally ? ` and to ${ally.slice(0, 8)}` : ''}`); break; }
      case 'class_overlord': {
        const bare = (id) => !Number(view.get(id)?.armor);
        const who = bare(me) ? me : nearAlly && bare(nearAlly) ? nearAlly : adjacentOf(me, o => !enemyOf(me, o) && bare(o))[0] || null;
        if (!who) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class overlord: I and every ally next to me already wear an armor point`); break; }
        classAbilityOut.armor.push({ on: who, by: me }); useAbility(r, `${who === me ? 'I wear' : `${who.slice(0, 8)} wears`} an armor life point`); break;
      }
      case 'class_druid': {
        // CPD 2026-11-19 (option C): data unmoved_only — no use on an action I move in (the card stays untapped)
        if (data.classes.class_druid?.data?.unmoved_only === true && moved === true) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class druid: I move this action — the card stays untapped`); break; }
        // CR 2026-11-17: two picks (free stats best first, then stood stones lowest first), one point-buy each
        const stones = parseJson(v.tile_tokens_json, []).filter(t => t.kind === 'bonus' && t.druid && t.q === here.q && t.r === here.r);
        const have = new Map(stones.map(t => [ELEM_TO_STAT[t.elem], t]));
        const STATS4 = ['vitality', 'world', 'matter', 'will'];
        const order = [...STATS4].sort((a, b) => statOf(me, b) - statOf(me, a) || a.localeCompare(b)).filter(x => !have.has(x))
          .concat([...have.values()].sort((a, b) => a.value - b.value || String(a.id).localeCompare(String(b.id))).map(t => ELEM_TO_STAT[t.elem]));
        const picks = (order.length ? order : [stat]).slice(0, 2);
        const fails = [], notes = [], toks = [];
        const chain = data.classes.class_druid?.data?.chain_stones === true;   // CP 2026-11-19 (pick 2 b): the 2nd only after the 1st succeeded
        let rolled = 0;
        for (let i = 0; i < picks.length; i++) {
          if (chain && i > 0 && fails.length) break;
          rolled++;
          const st = picks[i];
          const elem = (classColours('class_druid')[st] || [])[0] || elemsOfStat(st)[0] || 'elem_vitality';
          const pb = pointBuy(statOf(me, st), `${r.salt || ''}:druid:${hg.action}${i ? ':2' : ''}`, sha256Hex);
          if (pb.fail) { fails.push(`[${PEER_LABEL}] class druid: the ${st} point-buy failed [${pb.dice.join(',')}] — no ${st} stone`); continue; }
          if (have.has(st) && have.get(st).value >= pb.value) { notes.push(`the ${pb.value} does not beat the ${st} stone ${have.get(st).value}`); continue; }
          toks.push({ by: me, kind: 'bonus', druid: true, elem, value: pb.value, q: here.q, r: here.r });
          notes.push(`a Druid stone of ${st} +${pb.value} rises on my tile`);
        }
        if (me === PEER_ID_STRING) for (const f of fails) log(f);
        if (fails.length === rolled && data.classes.class_druid?.data?.fail_spends === true) { useAbility(r, 'no stone — the point-buy failed, the tap is spent'); break; }   // CP2: a fail spends the tap
        if (fails.length === rolled) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class druid: no stone — the ability stays ready`); break; }
        classAbilityOut.tokens.push(...toks);
        useAbility(r, notes.join('; ')); break;
      }
      case 'class_witch': {
        const foes = foesNearby(me, classRangeOf('class_witch'));
        const seed = `${r.salt || ''}:witch:${hg.action}:${me}`;
        const on = foes.includes(peer) ? peer : pickBySalt(`${seed}:who`, foes, sha256Hex);
        if (!on) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class witch: no enemy within ${classRangeOf('class_witch')} hexes — the card stays untapped`); break; }
        const n = Number(handDiscardOf('class_witch')?.n) || 3;
        const sd = data.classes.class_witch?.data?.self_discard, own = Number.isInteger(sd) && sd > 0 ? sd : 0;   // CP 2026-11-19 (pick 8 a): + her own
        classAbilityOut.discards.push({ on, by: me, n, seed, why: 'witch' });
        if (own) classAbilityOut.discards.push({ on: me, by: me, n: own, seed: `${seed}:self`, why: 'witch', self: true });
        log(`[${PEER_LABEL}] witch: ${me.slice(0, 14)} makes ${on.slice(0, 14)} discard ${n}${own ? ` and discards ${own} of its own` : ''} (seed ${sha256Hex(seed).slice(0, 8)})`);
        useAbility(r, `${on.slice(0, 8)} puts ${n} random hand cards onto its discard pile${own ? ` — and I discard ${own} of mine` : ''}`); break;
      }
      case 'class_avenger': {
        const R = avengerConfig(data.classes.class_avenger?.data).range;
        const lured = lureTargets([...view.keys()].filter(o => o !== me).map(o => ({ id: o, wild: isWildMonster(view.get(o)), enemy: enemyOf(me, o), alive: lifeOf(o) > 0, d: distBetween(me, o) })), R);
        if (!lured.length) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class avenger: no wild monster within ${R} hexes — the ability stays ready`); break; }
        for (const on of lured) classAbilityOut.lures.push({ on, by: me });
        log(`[${PEER_LABEL}] avenger: ${me.slice(0, 14)} lures ${lured.length} monster(s) within ${R} hexes: ${lured.map(o => o.slice(0, 14)).join(', ')}`);
        useAbility(r, `${lured.length} monster(s) within ${R} hexes start chasing me`); break;
      }
      case 'class_alchemist': {
        const card = libraryCardFor(`${r.salt || ''}:alchemist:${hg.action}`);
        if (!card) break;
        classAbilityOut.traps.push({ by: me, q: spot.q, r: spot.r, effect_id: card.effect_id, elements: [...card.elements], card_id: null, library: true, power: TRAP_POWER, trigger: 'enter', mode: 'damage', holder: null });
        useAbility(r, `a ${card.effect_id} from the Library lies as a trap at (${spot.q},${spot.r})`); break;
      }
      case 'class_ranger': {
        if (!ab.attach?.effect_id || !Array.isArray(ab.attach.elements) || !ab.attach.elements.length) break;
        classAbilityOut.traps.push({ by: me, q: here.q, r: here.r, effect_id: ab.attach.effect_id, elements: [...ab.attach.elements], card_id: ab.attach.card_id || null, library: false, power: TRAP_POWER, trigger: 'targeted', mode: 'damage', holder: null });
        useAbility(r, `${ab.attach.name || ab.attach.effect_id} lies as a trap under me`); break;
      }
      case 'class_necromancer': {
        const raised = reanimatedAll([...view.values()]);
        const fallen = [...view.keys()].filter(id => id !== me && lifeOf(id) <= 0 && view.get(id)?.creature_id && !raised.has(id) && !view.get(id)?.raised_by /* ruling 2026-11-16 */ && distBetween(me, id) <= 1 && sideOf(view.get(id).alliance) === sideOf(v.alliance)).sort()[0] || null;
        if (fallen) { classAbilityOut.revives.push({ by: me, who: fallen, creature_id: view.get(fallen).creature_id, name: view.get(fallen).name }); useAbility(r, `${view.get(fallen).name || fallen.slice(0, 8)} rises again`); break; }
        classAbilityOut.revives.push({ by: me, who: null }); useAbility(r, 'no fallen ally in reach — an archived creature of mine enters if I have one'); break;
      }
      default: break;
    }
  }
  return { classAbilityOut, logs };
}
// What the old code would have observed, from a hook result (P2's call site: out → classAbilityOut, log, useAbility, mine).
function observedFromHook(res, ctx, classId, actor) {
  const classAbilityOut = { used: [], heals: [], discards: [], peeks: [], traps: [], tokens: [], armor: [], illusion: [], revives: [], moves: [], stealth: [], rogueTrap: [], lures: [], builds: [] };
  const logs = [];
  if (res) {
    for (const [k, l] of Object.entries(res.out)) classAbilityOut[k].push(...l);
    logs.push(...res.log);
    if (actor === ctx.self) logs.push(...res.mine);
    if (res.used) { classAbilityOut.used.push({ actor, class_id: classId }); if (actor === ctx.self) logs.push(`[${ctx.label}] class ${classId}: ${res.note}`); }
  }
  return { classAbilityOut, logs };
}

// Everything else: one REF per hook (verbatim expressions of the peer.mjs sites, see HOOKS.md for the anchors).
const REF = {
  colours: (W, ctx, id) => refWorld(W, ctx).classColours(id),
  kind: (W, ctx, id) => refWorld(W, ctx).classKindOf(id),
  // "const classReady = (id, classId) =>" with classStateOf(id) = args.cs and hasPerm(id, classId) = args.held
  ready: (W, ctx, classId, { cs, held, turn }) => { const { classKindOf } = refWorld(W, ctx); return cs.class_id === classId && !cs.archived && held && (classKindOf(classId) === 'tap' ? !cs.tapped : cs.usedTurn !== turn); },
  config: (W, ctx, id) => {
    const { data, classDataOf, classRangeOf, handRevealOf, handDiscardOf } = refWorld(W, ctx);
    switch (id) {
      case 'class_rogue': return rogueConfig(data.classes.class_rogue?.data);
      case 'class_cleric': return clericConfig(data.classes.class_cleric?.data);
      case 'class_manipulator': return manipulatorConfig(classDataOf('class_manipulator'));
      case 'class_avenger': return avengerConfig(data.classes.class_avenger?.data);
      case 'class_prophet': return { ...prophetConfig(data.classes.class_prophet?.data), range: classRangeOf(id), hand_reveal: handRevealOf(id) };
      case 'class_animator': return animatorConfig(data.classes.class_animator?.data);
      case 'class_priest': return priestConfig(data.classes.class_priest?.data);
      case 'class_seeker': return seekerConfig(data.classes.class_seeker?.data);
      case 'class_witch': return { range: classRangeOf(id), hand_discard: handDiscardOf(id) };
      default: return { range: classRangeOf(id) };
    }
  },
  // Rule 24 block: "// --- an enemy's class colour (die of 6) ---"
  strike: (_W, _ctx, _id, { cs, cols, stat, elem, enemy, pb }) => {
    const enemies = enemy ? ['e'] : [], e = 'e', r = { destroy: { elem } };
    cs = { ...cs, down: cs.down || [] };
    const okTarget = enemies.includes(e) && cs.class_id && !cs.archived && stat in cols && !cs.down.includes(stat) && (!r.destroy.elem || cols[stat].includes(r.destroy.elem));
    if (!okTarget) return null;
    const result = pb.fail ? 'retry' : pb.value >= 6 ? 'destroyed' : 'too weak';
    const last = result === 'destroyed' && Object.keys(cols).every(s => s === stat || cs.down.includes(s));
    return { result, ok: result === 'destroyed', last };
  },
  // "// --- my own class: recast from the archive / untap the ability"
  restore: (_W, _ctx, _id, { cs, cols, stat, kind }) => !!cs.class_id && stat in cols && (kind === 'recast' ? cs.archived : (cs.tapped && !cs.archived)) && !(cs.progress?.mode === kind && (cs.progress.done || []).includes(stat)),
  // doResolution "// Class cards (user ruling 2026-10-30) — what happened to MY class this action." on a fake entity
  progress: (_W, _ctx, _id, { state, cols, co }) => {
    const entity = { classDown: [...(state.down || [])], classArchived: !!state.archived, classTapped: !!state.tapped, classProgress: state.progress ? JSON.parse(J(state.progress)) : null };
    let event = null;
    if (co.kind === 'colour') { if (!entity.classDown.includes(co.stat)) entity.classDown.push(co.stat); event = 'colour'; }
    if (co.kind === 'class_destroyed') { entity.classDown = [...cols]; entity.classArchived = true; entity.classTapped = false; entity.classProgress = null; event = 'destroyed'; }
    if (co.kind === 'recast' || co.kind === 'untap') {
      if (!entity.classProgress || entity.classProgress.mode !== co.kind) entity.classProgress = { mode: co.kind, done: [] };
      const fresh = !entity.classProgress.done.includes(co.stat);
      if (fresh) entity.classProgress.done.push(co.stat);
      const complete = cols.every(s => entity.classProgress.done.includes(s));
      // CP2 2026-11-19 (Healer): data untap_emissions N > colours → N emissions in rounds (every colour once a round)
      const ue = (_ctx?.classData?.(_id) || {}).untap_emissions, N = co.kind === 'untap' && Number.isInteger(ue) && ue > cols.length ? ue : 0;
      const n0 = state.progress?.mode === 'untap' && Number.isInteger(state.progress.n) && state.progress.n >= 0 ? state.progress.n : 0;
      if (N) {
        const n = n0 + (fresh ? 1 : 0);
        if (n >= N) { entity.classTapped = false; entity.classProgress = null; event = 'untap'; }
        else { entity.classProgress = { mode: 'untap', done: complete ? [] : entity.classProgress.done, n }; event = 'step'; }
      } else if (complete && co.kind === 'recast') { entity.classArchived = false; entity.classDown = []; entity.classProgress = null; event = 'recast'; }
      else if (complete) { entity.classTapped = false; entity.classProgress = null; event = 'untap'; }
      else event = 'step';
    }
    return { state: { down: entity.classDown, archived: entity.classArchived, tapped: entity.classTapped, progress: entity.classProgress }, event };
  },
  // "// Shield life points are the first life lost — the illusion, then the armor." (+ the chase bonus line)
  // CP 2026-11-19 (pick 9 a): a max-only chase bonus (data chase_bonus.max_only) is lost first and absorbs nothing
  life_points: (_W, ctx, id, { dmg, illusion, armor, chaseBonus }) => {
    const myDmg = dmg, entity = { illusion, armor, chaseBonus };
    let shieldHit = 0;
    if (myDmg > 0 && entity.illusion) { entity.illusion = 0; shieldHit++; }
    if (myDmg > shieldHit && entity.armor) { entity.armor = 0; shieldHit++; }
    if (myDmg > shieldHit && entity.chaseBonus) { entity.chaseBonus = 0; if (ctx?.classData?.(id)?.chase_bonus?.max_only !== true) shieldHit++; }
    return { illusion: entity.illusion, armor: entity.armor, chaseBonus: entity.chaseBonus, absorbed: shieldHit };
  },
  // class stances: "if (c === 'class_reaver' && (cur === 'EP' || cur === 'EM')) {" … "else if (c === 'class_monk') effAction.set(r.actor, 'M');"
  // CR 2026-11-18 (a): the Barbarian's EM is a Block too; CR 2026-11-17: the Monk's EP-as-Move stance is gone
  stance: (_W, _ctx, c, { code: cur }) => {
    let out = null;
    if (c === 'class_reaver' && (cur === 'EP' || cur === 'EM')) out = 'A';
    else if (c === 'class_barbarian' && (cur === 'EP' || cur === 'EM')) out = 'B';
    return out;
  },
  // Reaver auto-target: ".sort((a, b) => a.cost - b.cost || a.lands - b.lands || a.life - b.life || a.id.localeCompare(b.id))[0]"
  stance_target: (_W, _ctx, c, { cands }) => { if (c !== 'class_reaver') return null; const pick = [...cands].sort((a, b) => a.cost - b.cost || a.lands - b.lands || a.life - b.life || a.id.localeCompare(b.id))[0]; return pick ? pick.id : null; },
  // the four emission sites: planning emitsLong, Rule 24 emitsNow, manipulator emitsFor, element badge anyEmit
  // User rulings 2026-11-16 ("Implement them"): Barbarian "may emit during Block" and Monk Empty Move emit at EVERY
  // site (before: Monk EM only at plan / manip, Barbarian never) — the same answer at all four sites now.
  emits: (_W, _ctx, cls, { code: c }) => {
    // CR 2026-11-18 (b): the Enchanter's A / B / M emit at every site (static)
    return (cls === 'class_reaver' && c === 'A') || (cls === 'class_barbarian' && c === 'B') || (cls === 'class_monk' && (c === 'M' || c === 'EM')) || (cls === 'class_enchanter' && ['A', 'B', 'M'].includes(c));
  },
  // Necromancer "Destroy reanimated: point-buy non-contiguously Harmony and Concentration with 6" (ruling 2026-11-16):
  // the Rule 24 branch on a unit the class raised — each element falls to a die of 6, one per emission, any order.
  reanimated_strike: (_W, ctx, cls, { down, stat, elem, enemy, pb }) => {
    if (cls !== 'class_necromancer') return null;
    const dr = ctx.classData(cls)?.destroy_reanimated;
    const els = dr && Array.isArray(dr.elements) && dr.elements.length > 0 ? dr.elements : ['elem_harmony', 'elem_concentration'];
    const need = dr && Number.isInteger(dr.die) ? dr.die : 6;
    const struck = new Set(down || []);
    let target = null;
    for (const el of els) if (!struck.has(el) && CL_E2S[el] === stat && (elem ? el === elem : true)) { target = el; break; }
    if (!enemy || target === null) return null;
    const result = pb.fail ? 'retry' : pb.value >= need ? 'destroyed' : 'too weak';
    return { result, ok: result === 'destroyed', last: result === 'destroyed' && els.filter(el => el !== target).every(el => struck.has(el)), elem: target };
  },
  // "const enchanterNow = entity.permanents.has('class_enchanter') && …"
  // CR 2026-11-18 (b): the Enchanter is a static emitter now — no built-in class plans a once-per-turn emission
  plan_emits: () => false,
  // "if (dmg >= 1 && hasPerm(r.actor, 'class_assassin') && assassinScored.has(r.actor)) dmg += 1;"
  // CR 2026-11-17: data vs_hurt_only → only vs a defender below full life (snapshot life < life_max)
  attack_out: (_W, ctx, cls, { attacker, dmg, scored, defender }) => { if (cls !== 'class_assassin') return dmg; const assassinScored = new Set(scored); const hurt = !!defender && ctx.lifeOf(defender) < Number(ctx.view(defender)?.life_max); if (dmg >= 1 && ctx.hasPerm(attacker, 'class_assassin') && assassinScored.has(attacker) && (ctx.classData(cls)?.vs_hurt_only !== true || hurt)) dmg += 1; return dmg; },
  // "if (amount > 0 && hasPerm(attacker, 'class_noble') && attacker === PEER_ID_STRING) lifestealForMe.amount += amount;"
  // CR 2026-11-17: data lifesteal {from: 'attack', max_per_action}
  lifesteal: (_W, ctx, cls, { attacker, amount, source, why }) => { const ls = ctx.classData(cls)?.lifesteal; const cfg = ls && typeof ls === 'object' && !Array.isArray(ls) ? ls : {}; const lifestealForMe = { amount: 0 }; if (cls === 'class_noble' && amount > 0 && ctx.hasPerm(attacker, 'class_noble') && attacker === ctx.self && (cfg.from !== 'attack' || (source === 'action' && why === 'Attack'))) lifestealForMe.amount += amount; return lifestealForMe.amount; },
  // "if (lifestealForMe.amount > 0 && entity.life > 0 && entity.permanents.has('class_noble')) {"
  lifesteal_apply: (_W, ctx, cls, { amount, life, lifeMax, held }) => { const ls = ctx?.classData?.(cls)?.lifesteal; const cap = ls && typeof ls === 'object' && !Array.isArray(ls) && Number.isInteger(ls.max_per_action) && ls.max_per_action >= 0 ? ls.max_per_action : Infinity; const entity = { life, lifeMax }; if (cls === 'class_noble' && amount > 0 && entity.life > 0 && held) entity.life = Math.min(entity.lifeMax, entity.life + Math.min(amount, cap)); return entity.life; },
  // Elementalist pre-pass: "const best = [...new Set(r.effect.elements.map(el => ELEM_TO_STAT[el]).filter(Boolean))]…"
  pre_cast: (W, ctx, cls, { actor, elements, salt }) => {
    if (cls !== 'class_elementalist') return null;
    const { statOf, hg } = refWorld(W, ctx); const r = { actor, salt, effect: { elements } };
    const best = [...new Set(r.effect.elements.map(el => ELEM_TO_STAT[el]).filter(Boolean))].sort((a, b) => statOf(r.actor, b) - statOf(r.actor, a) || a.localeCompare(b))[0] || 'matter';
    const pb = pointBuy(statOf(r.actor, best), `${r.salt || ''}:elementalist:${hg.action}`, sha256Hex);
    return { stat: best, fail: pb.fail, dice: pb.dice, value: pb.value };
  },
  // "// Transmuter (static): a nearby ally's completed cast of stat tokens / heals works on the Transmuter too."
  transmute: (W, ctx, cls, { id, outcomes }) => {
    if (cls !== 'class_transmuter') return { edits: [], log: [] };
    const { PEER_ID_STRING, PEER_LABEL, enemyOf, distBetween } = refWorld(W, ctx);
    const log = [], effectOutcomes = outcomes.map(o => ({ actor: o.actor, oc: { status: o.status, statTokens: [...o.statTokens], heals: [...o.heals] } }));
    for (const { actor, oc } of effectOutcomes) {
      if (actor === id || oc.status !== 'done' || enemyOf(id, actor) || distBetween(id, actor) > 1) continue;
      const dup = oc.statTokens.filter(t => t.on === actor && t.value > 0).map(t => ({ ...t, on: id }));
      const heals = oc.heals.filter(h => h.on === actor).map(h => ({ ...h, on: id }));
      if (dup.length || heals.length) { oc.statTokens.push(...dup); oc.heals.push(...heals); if (id === PEER_ID_STRING || actor === PEER_ID_STRING) log.push(`[${PEER_LABEL}] transmuter ${id.slice(0, 8)} shares ${actor.slice(0, 8)}'s cast (${dup.length} token(s), ${heals.length} heal(s))`); }
    }
    return { effectOutcomes, log };
  },
  // "for (const d of destroyOutcomes) if (d.result === 'destroyed' && !d.phylactery && d.tok && classOf(d.actor) === 'class_restaurateur') { d.result = 'taken';"
  destroy_result: (_W, _ctx, cls, { d }) => { d = { ...d }; if (d.result === 'destroyed' && !d.phylactery && d.tok && cls === 'class_restaurateur') d.result = 'taken'; return d.result; },
  // endRound Guardian: "if (entity.classFlags && entity.permanents.has('class_guardian') && !entity.classFlags.movedThisRound && entity.life > 0) {"
  // CR 2026-11-17: no move on data still_actions (1-based, default all three) — movedRounds are hg.round indices
  end_turn: (_W, ctx, cls, { held, moved, life, lifeMax, movedRounds }) => { const sa = ctx.classData(cls)?.still_actions; const still = Array.isArray(sa) ? sa : [1, 2, 3]; const mv = Array.isArray(movedRounds) ? movedRounds.some(r => still.includes(r + 1)) : moved; const entity = { life, lifeMax }; if (cls === 'class_guardian' && held && !mv && entity.life > 0) { if (entity.life < entity.lifeMax) entity.life += 1; } return entity.life - life; },
  // trap steps: "const rogue = classStanding(who, 'class_rogue');" … "for (const tp of laid) springTrap(tp, who);"
  step: (_W, ctx, cls, a) => {
    const classStanding = (_who, c) => c === cls;
    const rogueThreatReady = () => a.threatReady, rogueTrapLeft = () => a.trapLeft, buildingTileAt = () => a.building;
    const laid = a.trap && !a.wtrap ? ['laid'] : a.trap ? ['laid'] : [], wtrap = a.wtrap && a.trap ? { id: 'w' } : null;
    let stealth = false;
    const rogue = classStanding('who', 'class_rogue');
    if (rogue && rogueThreatReady('who')) { const ring = a.ring; if (ring.length) stealth = true; }
    if (!laid.length && !wtrap) return { stealth, trap: 'none' };
    if (rogue && rogueTrapLeft('who') > 0) return { stealth: stealth && ctx.classData(cls)?.shared_charge !== true, trap: 'dodge' };   // CR 2026-11-17: one shared charge
    if (classStanding('who', 'class_cleric') && (wtrap || buildingTileAt())) return { stealth, trap: 'disable' };
    return { stealth, trap: 'spring' };
  },
  // dungeons: "if (tp && classStanding(id, 'class_rogue') && rogueTrapLeft(id) > 0) {" … "if (tp && classStanding(id, 'class_cleric'))"
  dungeon_step: (_W, _ctx, cls, { trap, trapLeft }) => { const tp = trap; if (tp && cls === 'class_rogue' && trapLeft > 0) return 'dodge'; if (tp && cls === 'class_cleric') return 'disable'; if (tp) return 'spring'; return 'none'; },
  combat_in: (_W, ctx, cls, { list }) => cls === 'class_manipulator' && (ctx.classData(cls)?.trigger === 'attack' ? attackHit(list) : combatHit(list)),   // CR 2026-11-17
  pick_target: (_W, _ctx, cls, { seed, cands }) => cls === 'class_manipulator' ? pickManipTarget(seed, cands, sha256Hex) : null,
  chase_step: (W, ctx, cls, { state, chasing }) => cls === 'class_avenger' ? chaseBonusStep(state, chasing, avengerConfig(refWorld(W, ctx).data.classes.class_avenger?.data)) : { chasers: [...new Set(chasing || [])].sort(), bonus: Number(state?.bonus) || 0, fresh: [], grant: 0, fade: false },
  contact: (_W, _ctx, cls, { foes }) => cls === 'class_prophet' ? prophetPick(foes) : null,
  // peer.mjs classBlocked (verbatim before phase 4): only the Necromancer is ever blocked.
  blocked: (_W, _ctx, cls, { fallen_near, archive_creature }) => cls === 'class_necromancer' && !(fallen_near || archive_creature) ? 'no fallen ally creature next to me and none in my archive' : null,
  // Bard: "for (const o of adjacentOf(r.actor, o => !enemyOf(r.actor, o) && !!byActorPre.get(o))) {" (one Bard's turn of the loop)
  share_skills: (W, ctx, cls, { actor, skills, adj }) => {
    if (cls !== 'class_bard') return { adds: [], log: [] };
    const { PEER_ID_STRING, PEER_LABEL, data } = refWorld(W, ctx);
    const TRANCE = 'skill_battle_trance';
    const skillRidesOn = (codes, req) => codes.includes(req) || ((req === 'M' || req === 'P') && (codes.includes('EP') || codes.includes('EM')));
    const byActorPre = new Map(adj.map(o => [o.id, { skills: [...o.skills], trance: o.codes.length > 1 ? o.codes : null, action: o.codes[0] }]));
    const r = { actor, skills }, adds = [], log = [];
    for (const o of adj.map(x => x.id)) {
      const rev = byActorPre.get(o);
      for (const sk of r.skills) {
        const req = data.skills[sk]?.data?.action_type; if (!req || sk === TRANCE || rev.skills.includes(sk)) continue;
        const codes = rev.trance || [rev.action];
        if (skillRidesOn(codes, req)) { rev.skills = [...rev.skills, sk]; adds.push({ on: o, skill: sk }); if (o === PEER_ID_STRING || r.actor === PEER_ID_STRING) log.push(`[${PEER_LABEL}] bard ${r.actor.slice(0, 8)}: ${o.slice(0, 8)} plays ${sk} too`); }
      }
    }
    return { adds, log };
  },
};
// share_skills: the fixture's codes list is [action] or [opt1, opt2] (a trance) — the hook receives exactly that.
const fixShare = (args) => ({ ...args, adj: args.adj.map(o => ({ ...o, codes: o.codes.length > 1 ? o.codes : [o.codes[0]] })) });

// ---- 2. worked examples ----------------------------------------------------------------------------------------
console.log('-- 2. worked examples (user rulings)');
{
  const ctx0 = genWorld(1).ctx;
  const cols = { matter: ['elem_air', 'elem_fire'], will: ['elem_concentration'] };
  const cs = { class_id: 'class_weapon_master', archived: false, down: [] };
  eq('strike: die 6 on a standing colour → destroyed (not last)', classHook('strike', 'class_weapon_master', ctx0, { cs, cols, stat: 'matter', elem: 'elem_fire', enemy: true, pb: { fail: false, value: 6, dice: [6, 1] } }), { result: 'destroyed', ok: true, last: false });
  eq('strike: die 5 → too weak', classHook('strike', 'class_weapon_master', ctx0, { cs, cols, stat: 'matter', elem: null, enemy: true, pb: { fail: false, value: 5, dice: [5] } }), { result: 'too weak', ok: false, last: false });
  eq('strike: last colour → the class leaves the board', classHook('strike', 'class_weapon_master', ctx0, { cs: { ...cs, down: ['matter'] }, cols, stat: 'will', elem: null, enemy: true, pb: { fail: false, value: 6, dice: [6, 2] } }), { result: 'destroyed', ok: true, last: true });
  eq('strike: element not of that colour → no target', classHook('strike', 'class_weapon_master', ctx0, { cs, cols, stat: 'matter', elem: 'elem_harmony', enemy: true, pb: { fail: false, value: 6, dice: [6] } }), null);
  eq('restore: recast of an archived class, colour still owed', classHook('restore', 'class_weapon_master', ctx0, { cs: { class_id: 'class_weapon_master', archived: true, tapped: false, progress: { mode: 'recast', done: ['matter'] } }, cols, stat: 'will', kind: 'recast' }), true);
  eq('restore: a colour already recast is not owed', classHook('restore', 'class_weapon_master', ctx0, { cs: { class_id: 'class_weapon_master', archived: true, tapped: false, progress: { mode: 'recast', done: ['matter'] } }, cols, stat: 'matter', kind: 'recast' }), false);
  eq('progress: recasting the last colour → back on the board', classHook('progress', 'class_weapon_master', ctx0, { state: { down: ['matter', 'will'], archived: true, tapped: false, progress: { mode: 'recast', done: ['matter'] } }, cols: ['matter', 'will'], co: { kind: 'recast', stat: 'will' } }), { state: { down: [], archived: false, tapped: false, progress: null }, event: 'recast' });
  eq('life_points: 2 damage on illusion + armor → both absorbed', classHook('life_points', 'class_overlord', ctx0, { dmg: 2, illusion: 1, armor: 1, chaseBonus: 1 }), { illusion: 0, armor: 0, chaseBonus: 1, absorbed: 2 });
  eq('Guardian: unmoved, hurt → +1 at the end of the turn (ruling 2026-11-12)', classHook('end_turn', 'class_guardian', ctx0, { held: true, moved: false, life: 2, lifeMax: 4 }), 1);
  eq('Guardian: full life → nothing', classHook('end_turn', 'class_guardian', ctx0, { held: true, moved: false, life: 4, lifeMax: 4 }), 0);
  {
    const cd = (id) => CLASSES[id].data;
    const hurtW = { ...ctx0, hasPerm: () => true, classData: cd, lifeOf: (id) => ({ 'peer:h': 2, 'peer:f': 4 })[id] ?? 0, view: (id) => ({ 'peer:h': { life: 2, life_max: 4 }, 'peer:f': { life: 4, life_max: 4 } })[id] };
    eq('Assassin (CR 2026-11-17): +1 once it already scored this action — vs an enemy below full life only', ['peer:h', 'peer:f'].map(d => classHook('attack_out', 'class_assassin', hurtW, { attacker: 'peer:a', dmg: 1, scored: ['peer:a'], defender: d })), [2, 1]);
    const nb = { ...ctx0, self: 'peer:n', hasPerm: () => true, classData: cd };
    eq('Noble (CR 2026-11-17): lifesteal only from my own Attack, at most 1 per action', [classHook('lifesteal', 'class_noble', nb, { attacker: 'peer:n', amount: 2, source: 'action', why: 'Attack' }), classHook('lifesteal', 'class_noble', nb, { attacker: 'peer:n', amount: 1, source: 'action', why: 'Block' }), classHook('lifesteal_apply', 'class_noble', nb, { amount: 2, life: 1, lifeMax: 5, held: true })], [2, 0, 2]);
    eq('Guardian (CR 2026-11-17): a move on the 1st action still heals; one on the 2nd or 3rd does not', [[0], [1], [2], []].map(mr => classHook('end_turn', 'class_guardian', { ...ctx0, classData: cd }, { held: true, moved: mr.length > 0, life: 2, lifeMax: 4, movedRounds: mr })), [1, 0, 0, 1]);
    eq('Manipulator (CR 2026-11-17): only an incoming Attack triggers', [[{ source: 'action', amount: 1, why: 'Attack' }], [{ source: 'action', amount: 1, why: 'Block' }], [{ source: 'action', amount: 2, why: 'P' }]].map(list => classHook('combat_in', 'class_manipulator', { ...ctx0, classData: cd }, { list })), [true, false, false]);
    eq('Rogue (CR 2026-11-17): one shared charge — a trap step in a threat ring dodges the trap, unseen no', classHook('step', 'class_rogue', { ...ctx0, classData: cd }, { threatReady: true, ring: ['peer:m'], trap: true, wtrap: true, building: true, trapLeft: 1 }), { stealth: false, trap: 'dodge' });
    eq('Weapon master (CR 2026-11-17; CP 2026-11-19 pick 1 a): local draw 2, only while the hand holds ≤ 3 cards', classHook('local', 'class_weapon_master', null), { op: 'draw', n: 2, max_hand: 3 });
    eq('Enchanter (CR 2026-11-18 b): A / B / M emit at every site, P-free codes EM / EP not', ['plan', 'destroy', 'manip', 'badge'].map(site => ['A', 'B', 'M', 'EM'].map(code => classHook('emits', 'class_enchanter', ctx0, { code, site }))), Array(4).fill([true, true, true, false]));
    eq('data (CR): Shaman 3 / Overlord 3 / Reaver 2 / Enchanter 4 colours; Witch range 1; Prophet contact 3; Seeker once per turn; Avenger tap', [CLASSES.class_shaman.data.colors.length, CLASSES.class_overlord.data.colors.length, CLASSES.class_reaver.data.colors.length, CLASSES.class_enchanter.data.colors.length, CLASSES.class_witch.data.range, CLASSES.class_prophet.data.contact, CLASSES.class_seeker.data.ability_kind, CLASSES.class_avenger.data.ability_kind], [3, 3, 2, 4, 1, 3, 'once_per_round', 'tap']);
  }
  eq('Rogue: trap step with a charge → dodged (ruling 2026-11-14; data without shared_charge)', classHook('step', 'class_rogue', { ...ctx0, classData: (id) => ({ ...CLASSES[id].data, shared_charge: undefined }) }, { threatReady: true, ring: ['peer:m'], trap: true, wtrap: true, building: true, trapLeft: 1 }), { stealth: true, trap: 'dodge' });
  eq('Cleric: stepping on a trapped building → disabled (ruling 2026-11-14)', classHook('step', 'class_cleric', ctx0, { threatReady: false, ring: [], trap: true, wtrap: true, building: true, trapLeft: 0 }), { stealth: false, trap: 'disable' });
  eq('Cleric: a laid trap on open ground still springs', classHook('step', 'class_cleric', ctx0, { threatReady: false, ring: [], trap: true, wtrap: false, building: false, trapLeft: 0 }), { stealth: false, trap: 'spring' });
  eq('Avenger: a new chaser grants +1, cap 1 (ruling 2026-11-15; data without max_only → +1 life too)', classHook('chase_step', 'class_avenger', { ...ctx0, classData: (id) => ({ ...CLASSES[id].data, chase_bonus: { life: 1, max: 1 } }) }, { state: { chasers: [], bonus: 0 }, chasing: ['peer:m2', 'peer:m1'] }), { chasers: ['peer:m1', 'peer:m2'], bonus: 1, fresh: ['peer:m1', 'peer:m2'], grant: 1, heal: 1, fade: false });
  // ---- CP 2026-11-19: the user's picks of CLASSES_BALANCE "Proposals 2026-11-19" (unit oracles) ----
  {
    const cd = (id) => CLASSES[id].data;
    const mk = (units, over = {}) => { const view = new Map(units.map(u => [u.peer_id, { tile_tokens_json: '[]', permanents_csv: '', ...u }])); return { ...ctx0, self: units[0].peer_id, view: (id) => view.get(id), viewIds: () => [...view.keys()], viewValues: () => [...view.values()],
      lifeOf: (id) => view.get(id)?.life ?? 0, dist: (a, b) => (view.get(a) && view.get(b) ? hexDistance(view.get(a), view.get(b)) : Infinity), enemyOf: (a, b) => fxSide(view.get(a)?.alliance) !== fxSide(view.get(b)?.alliance),
      hasPerm: () => false, statOf: (id, st) => view.get(id)?.stats?.[st] ?? 0, classData: cd, ...over }; };
    const H = { peer_id: 'peer:h', alliance: 'player', life: 2, tile_q: 0, tile_r: 0 }, A1 = { peer_id: 'peer:a', alliance: 'player', life: 2, tile_q: 1, tile_r: 0 }, E1 = { peer_id: 'peer:e', alliance: 'npc_b', life: 3, tile_q: 0, tile_r: 1 };
    const hab = (w, moved) => classHook('ability', 'class_healer', w, { actor: 'peer:h', ab: { id: 'class_healer', target: null, attach: null, stat: 'vitality' }, salt: 's1', moved });
    eq('Healer (CP pick 4 a): data unmoved_only + ally_required', [cd('class_healer').unmoved_only, cd('class_healer').ally_required], [true, true]);
    eq('Healer (CP pick 4 a): unmoved, ally adjacent → me and the ally +1', hab(mk([H, A1, E1]), false)?.out?.heals, [{ on: 'peer:h', amount: 1, by: 'peer:h' }, { on: 'peer:a', amount: 1, by: 'peer:h' }]);
    eq('Healer (CP pick 4 a): on an action I move in → not used (stays untapped)', [hab(mk([H, A1, E1]), true)?.used, hab(mk([H, A1, E1]), true)?.mine], [false, ['[T1] class healer: I move this action — the card stays untapped'.replace('T1', ctx0.label)]]);
    eq('Healer (CP pick 4 a): no ally next to me (only an enemy) → not used', [hab(mk([H, E1]), false)?.used, hab(mk([H, { ...A1, tile_q: 3 }]), false)?.used], [false, false]);
    eq('Healer: without the CP knobs it still heals me alone (data 1.1.0 rule)', hab(mk([H, E1], { classData: (id) => ({ ...cd(id), unmoved_only: undefined, ally_required: undefined }) }), true)?.out?.heals, [{ on: 'peer:h', amount: 1, by: 'peer:h' }]);
    // Druid: find a salt whose 1st point-buy fails and whose 2nd succeeds (stats 4 / 3: one die each, a roll above the stat fails)
    const D = { peer_id: 'peer:d', alliance: 'player', life: 3, tile_q: 0, tile_r: 0, stats: { vitality: 4, world: 3, matter: 2, will: 1 } };
    const dw = mk([D]), dab = (w, salt) => classHook('ability', 'class_druid', w, { actor: 'peer:d', ab: { id: 'class_druid', target: null, attach: null, stat: 'vitality' }, salt });
    let salt = null;
    for (let i = 0; i < 2000 && !salt; i++) { const a = pointBuy(4, `x${i}:druid:${dw.action}`, sha256Hex), b = pointBuy(3, `x${i}:druid:${dw.action}:2`, sha256Hex); if (a.fail && !b.fail) salt = `x${i}`; }
    const unchained = mk([D], { classData: (id) => ({ ...cd(id), chain_stones: undefined }) });
    eq('Druid (CP pick 2 b): data chain_stones; a salt with the 1st roll failed and the 2nd good exists', [cd('class_druid').chain_stones, !!salt], [true, true]);
    eq('Druid (CP2 answer 3): data fail_spends', cd('class_druid').fail_spends, true);
    eq('Druid (CP2 answer 3): the 1st point-buy failed → the 2nd is not rolled, no stone, the tap is SPENT', [dab(dw, salt).used, dab(dw, salt).note, (dab(dw, salt).mine || []).length, (dab(dw, salt).out.tokens || []).length], [true, 'no stone — the point-buy failed, the tap is spent', 1, 0]);
    const unspent = mk([D], { classData: (id) => ({ ...cd(id), fail_spends: undefined }) });
    // CPD 2026-11-19 (option C): the Healer's no-move gate on the Druid
    const dabm = (w, salt, moved) => classHook('ability', 'class_druid', w, { actor: 'peer:d', ab: { id: 'class_druid', target: null, attach: null, stat: 'vitality' }, salt, moved });
    eq('Druid (CPD option C): data unmoved_only', cd('class_druid').unmoved_only, true);
    eq('Druid (CPD): on an action I move in → blocked, not used (the tap is NOT spent), no stone, no roll', [dabm(dw, salt, true).used, dabm(dw, salt, true).mine, J(dabm(dw, salt, true).out)], [false, [`[${ctx0.label}] class druid: I move this action — the card stays untapped`], '{}']);
    eq('Druid (CPD): an unmoved action → allowed (a failed 1st roll still spends the tap)', [dabm(dw, salt, false).used, dabm(dw, salt, false).note], [true, 'no stone — the point-buy failed, the tap is spent']);
    eq('Druid (CPD): without unmoved_only a moving action still uses it', dabm(mk([D], { classData: (id) => ({ ...cd(id), unmoved_only: undefined }) }), salt, true).used, true);
    eq('Druid (CP pick 2 b, without fail_spends): the 1st failed → the ability stays ready', [dab(unspent, salt).used, (dab(unspent, salt).mine || []).length, (dab(unspent, salt).out.tokens || []).length], [false, 2, 0]);
    eq('Druid: without chain_stones the 2nd roll still raises its stone (CR 2026-11-17 rule)', [dab(unchained, salt).used, (dab(unchained, salt).out.tokens || []).map(t => t.elem)], [true, ['elem_souls']]);
    let both = null;
    for (let i = 0; i < 2000 && !both; i++) { const a = pointBuy(4, `y${i}:druid:${dw.action}`, sha256Hex), b = pointBuy(3, `y${i}:druid:${dw.action}:2`, sha256Hex); if (!a.fail && !b.fail) both = `y${i}`; }
    eq('Druid (CP pick 2 b): the 1st succeeded → the 2nd rolls too (two stones)', (dab(dw, both).out.tokens || []).length, 2);
    eq('Druid (CPD): unmoved with both rolls good → two stones; the same salt moving → none, not used', [(dabm(dw, both, false).out.tokens || []).length, dabm(dw, both, true).used, (dabm(dw, both, true).out.tokens || []).length], [2, false, 0]);
    // Healer (CP2 answer 4): a longer untap — data untap_emissions 4 over its 3 colours (vitality / world / matter)
    {
      const hw = { ...ctx0, classData: cd }, hcols = ['vitality', 'world', 'matter'];
      const run = (w, stats) => { let st = { down: [], archived: false, tapped: true, progress: null }; const ev = []; for (const stat of stats) { const r = classHook('progress', 'class_healer', w, { state: st, cols: hcols, co: { kind: 'untap', stat } }); st = r.state; ev.push(r.event); } return { st, ev }; };
      eq('Healer (CP2 answer 4): data untap_emissions 4 (3 colours)', [cd('class_healer').untap_emissions, Object.keys(classHook('colours', 'class_healer', hw)).length], [4, 3]);
      const r3 = run(hw, ['vitality', 'world', 'matter']);
      eq('Healer (CP2): 3 emissions (every colour once) → still tapped, the round starts again (done [], n 3)', [r3.ev, r3.st.tapped, r3.st.progress], [['step', 'step', 'step'], true, { mode: 'untap', done: [], n: 3 }]);
      const r4 = run(hw, ['vitality', 'world', 'matter', 'world']);
      eq('Healer (CP2): the 4th emission (any colour, a new round) → untapped', [r4.ev[3], r4.st.tapped, r4.st.progress], ['untap', false, null]);
      const rr = run(hw, ['vitality', 'vitality', 'world']);
      eq('Healer (CP2): a colour repeated within a round does not count', [rr.ev, rr.st.progress], [['step', 'step', 'step'], { mode: 'untap', done: ['vitality', 'world'], n: 2 }]);
      const cs = (progress) => ({ class_id: 'class_healer', tapped: true, archived: false, progress });
      const colsObj = classHook('colours', 'class_healer', hw);
      eq('Healer (CP2): restore — a colour already done this round is refused, after the round reset it is owed again', [classHook('restore', 'class_healer', hw, { cs: cs({ mode: 'untap', done: ['world'], n: 1 }), cols: colsObj, stat: 'world', kind: 'untap' }), classHook('restore', 'class_healer', hw, { cs: cs({ mode: 'untap', done: [], n: 3 }), cols: colsObj, stat: 'world', kind: 'untap' })], [false, true]);
      const old = run({ ...ctx0, classData: (id) => ({ ...cd(id), untap_emissions: undefined }) }, ['vitality', 'world', 'matter']);
      eq('Healer without untap_emissions: 3 colours untap (no n field)', [old.ev, old.st.tapped], [['step', 'step', 'untap'], false]);
      const rc = classHook('progress', 'class_healer', hw, { state: { down: [], archived: true, tapped: false, progress: { mode: 'recast', done: ['vitality', 'world'] } }, cols: hcols, co: { kind: 'recast', stat: 'matter' } });
      eq('Healer (CP2): a recast still takes every colour once (untap_emissions is the untap only)', [rc.event, rc.state.archived], ['recast', false]);
      eq('another tap class (Witch) is unchanged by the knob', run({ ...ctx0, classData: cd }, []).ev.length === 0 && classHook('progress', 'class_witch', hw, { state: { down: [], archived: false, tapped: true, progress: { mode: 'untap', done: ['vitality'] } }, cols: ['vitality', 'matter'], co: { kind: 'untap', stat: 'matter' } }).event, 'untap');
    }
    // Witch: her own discard
    const Wt = { peer_id: 'peer:w', alliance: 'player', life: 3, tile_q: 0, tile_r: 0 };
    const wr = classHook('ability', 'class_witch', mk([Wt, E1]), { actor: 'peer:w', ab: { id: 'class_witch', target: { kind: 'character', ref: 'peer:e' }, attach: null, stat: 'vitality' }, salt: 's9' });
    eq('Witch (CP pick 8 a): the enemy discards 3 and the Witch 1 of her own (seed …:self)', wr.out.discards.map(d => [d.on, d.n, d.self || false, d.seed.endsWith(':self')]), [['peer:e', 3, false, false], ['peer:w', 1, true, true]]);
    eq('Witch: no enemy adjacent → no discard at all (not even her own)', classHook('ability', 'class_witch', mk([Wt, { ...E1, tile_q: 3 }]), { actor: 'peer:w', ab: { id: 'class_witch', target: null, attach: null, stat: 'vitality' }, salt: 's9' }).used, false);
    // Priest: the Priest's Shrine heals 2, a copy 1
    const pc = priestConfig(cd('class_priest')), sh = shrineMade(pc, { path: 'x/shrine.png' }, 'class_priest');
    eq('Priest (CP pick 5 a): priestConfig heal 2 → the Shrine power {mend, n: 2}; an Animator copy mends 1', [pc.heal, sh.bonus, copyMade({ ...sh, placed: true }, 3, 4, 'class_animator').bonus, shrineMade(priestConfig({}), null, 'class_priest').bonus], [2, { power: { kind: 'mend', n: 2 } }, { power: { kind: 'mend' } }, { power: { kind: 'mend' } }]);
    // Avenger: +1 life max only
    const av = { ...ctx0, classData: cd };
    eq('Avenger (CP pick 9 a): a new chaser → grant +1 (life max), heal 0 (no +1 life)', classHook('chase_step', 'class_avenger', av, { state: { chasers: [], bonus: 0 }, chasing: ['peer:m1'] }), { chasers: ['peer:m1'], bonus: 1, fresh: ['peer:m1'], grant: 1, heal: 0, fade: false });
    eq('Avenger (CP pick 9 a): the max-only point is lost first and absorbs nothing', [classHook('life_points', 'class_avenger', av, { dmg: 1, illusion: 0, armor: 0, chaseBonus: 1 }), classHook('life_points', 'class_avenger', av, { dmg: 2, illusion: 0, armor: 1, chaseBonus: 1 })], [{ illusion: 0, armor: 0, chaseBonus: 0, absorbed: 0 }, { illusion: 0, armor: 0, chaseBonus: 0, absorbed: 1 }]);
    eq('Avenger: another class (Overlord) keeps the old absorbing chase point', classHook('life_points', 'class_overlord', av, { dmg: 1, illusion: 0, armor: 0, chaseBonus: 1 }), { illusion: 0, armor: 0, chaseBonus: 0, absorbed: 1 });
    // colours
    eq('colours (CP picks 1, 6, 7, 10; CP2 answers 1, 2: Elementalist +Concentration +Vitality, Assassin +Air +Water): WM, Seeker, Bard, Noble, Elementalist, Assassin',
      ['class_weapon_master', 'class_seeker', 'class_bard', 'class_noble', 'class_elementalist', 'class_assassin'].map(id => cd(id).colors.map(e => e.slice(5)).join('/')),
      ['air/earth/fire/concentration', 'time/space/souls/earth', 'time/space/souls/harmony', 'vitality/souls/water/harmony/time/space', 'air/water/earth/fire/harmony/concentration/vitality', 'time/space/fire/concentration/harmony/air/water']);
  }
  eq('Reaver EP / EM fight as A, Barbarian EP / EM as B (CR 2026-11-18 a); the Monk has no stance (CR 2026-11-17)', ['class_reaver', 'class_barbarian', 'class_monk'].map(c => classHook('stance', c, ctx0, { code: 'EP' })).concat(['class_reaver', 'class_barbarian', 'class_monk'].map(c => classHook('stance', c, ctx0, { code: 'EM' }))), ['A', 'B', null, 'A', 'B', null]);
  // user rulings 2026-11-16
  eq('Barbarian B and Monk M / EM emit at every site (plan, Rule 24, manipulator, badge)', ['plan', 'destroy', 'manip', 'badge'].map(site => [classHook('emits', 'class_barbarian', ctx0, { code: 'B', site }), classHook('emits', 'class_monk', ctx0, { code: 'EM', site }), classHook('emits', 'class_monk', ctx0, { code: 'M', site }), classHook('emits', 'class_barbarian', ctx0, { code: 'A', site })]), Array(4).fill([true, true, true, false]));
  const nd = { ...ctx0, classData: (id) => CLASSES[id].data };
  eq('Necromancer: Harmony with a 6 on a reanimated unit → struck (not last)', classHook('reanimated_strike', 'class_necromancer', nd, { down: [], stat: 'will', elem: 'elem_harmony', enemy: true, pb: { fail: false, value: 6, dice: [6] } }), { result: 'destroyed', ok: true, last: false, elem: 'elem_harmony' });
  eq('Necromancer: then Concentration with a 6 (another action) → the reanimated unit is destroyed', classHook('reanimated_strike', 'class_necromancer', nd, { down: ['elem_harmony'], stat: 'will', elem: null, enemy: true, pb: { fail: false, value: 6, dice: [6, 1] } }), { result: 'destroyed', ok: true, last: true, elem: 'elem_concentration' });
  eq('Necromancer: a 5 is too weak; a Matter emission has no target', [classHook('reanimated_strike', 'class_necromancer', nd, { down: [], stat: 'will', elem: null, enemy: true, pb: { fail: false, value: 5, dice: [5] } }), classHook('reanimated_strike', 'class_necromancer', nd, { down: [], stat: 'matter', elem: null, enemy: true, pb: { fail: false, value: 6, dice: [6] } })], [{ result: 'too weak', ok: false, last: false, elem: 'elem_harmony' }, null]);
  eq('Necromancer: other classes raise nothing that this applies to', classHook('reanimated_strike', 'class_healer', nd, { down: [], stat: 'will', elem: null, enemy: true, pb: { fail: false, value: 6, dice: [6] } }), null);
  // CR: channel rule (user ruling 2026-11-17) — game/channel-rule.mjs, as peer.mjs simulate()#channelBreaksFor calls it
  {
    const em = (cls) => (code) => classHook('emits', cls, ctx0, { code, site: 'plan' });
    const rv = (action, extra = {}) => ({ action, declared: action, trance: null, effect: null, ...extra });
    const cases = [
      ['Reaver A keeps the channel', rv('A'), 'class_reaver', { breaks: false, kept: true }],
      ['Barbarian B keeps the channel', rv('B'), 'class_barbarian', { breaks: false, kept: true }],
      ['Reaver B breaks it', rv('B'), 'class_reaver', { breaks: true, kept: false }],
      ['Barbarian A breaks it', rv('A'), 'class_barbarian', { breaks: true, kept: false }],
      ['plain A by a Healer breaks it', rv('A'), 'class_healer', { breaks: true, kept: false }],
      ['plain B by a classless unit breaks it', rv('B'), null, { breaks: true, kept: false }],
      ['Monk M breaks it (Move)', rv('M'), 'class_monk', { breaks: true, kept: false }],
      ['Enchanter A keeps the channel (CR 2026-11-18 b: its A emits)', rv('A'), 'class_enchanter', { breaks: false, kept: true }],
      ['Enchanter M breaks it (Move)', rv('M'), 'class_enchanter', { breaks: true, kept: false }],
      ['Barbarian EM (fights as B) breaks it — the player moved', rv('B', { declared: 'EM' }), 'class_barbarian', { breaks: true, kept: false }],
      ['Reaver Battle Trance pair A+P breaks it', rv('A', { trance: ['A', 'P'] }), 'class_reaver', { breaks: true, kept: false }],
      ['Barbarian Battle Trance pair B+EP breaks it', rv('B', { trance: ['B', 'EP'] }), 'class_barbarian', { breaks: true, kept: false }],
      ['Reaver A emitting an off-cost element breaks it', rv('A', { effect: { elements: ['elem_fire', 'elem_air'], step: 1 } }), 'class_reaver', { breaks: true, kept: false }],
      ['Barbarian B emitting the cost element keeps it', rv('B', { effect: { elements: ['elem_harm'], step: 1 } }), 'class_barbarian', { breaks: false, kept: true }],
      ['plain P with an off-cost element breaks it', rv('P', { effect: { elements: ['elem_fire'], step: 1 } }), 'class_healer', { breaks: true, kept: false }],
      ['plain P keeps it (not a class save)', rv('P'), 'class_healer', { breaks: false, kept: false }],
      ['Reaver EP (stance A, declared EP) keeps it as a Posture', rv('EP'), 'class_reaver', { breaks: false, kept: false }],
      ['no reveal → no break', null, 'class_reaver', { breaks: false, kept: false }],
    ];
    eq('channel rule oracle (Reaver A / Barbarian B keep; others, Trance pairs, off-cost elements break)', cases.map(([, rev, cls]) => channelBreaks(rev, 'elem_harm', cls ? em(cls) : null)), cases.map(c => c[3]));
    for (const [label, rev, cls, want] of cases) eq(`  channel: ${label}`, channelBreaks(rev, 'elem_harm', cls ? em(cls) : null), want, true);
  }
  eq('kinds: Elementalist / Rogue / Manipulator / Prophet passive; Weapon Master once_per_round; Bard static', ['class_elementalist', 'class_rogue', 'class_manipulator', 'class_prophet', 'class_weapon_master', 'class_bard', 'class_healer'].map(c => classHook('kind', c, { ...ctx0, classData: (id) => CLASSES[id].data })), ['passive', 'passive', 'passive', 'passive', 'once_per_round', 'static', 'tap']);
}

// ---- 3. identity ------------------------------------------------------------------------------------------------
console.log(`-- 3. identity: classes.mjs vs the verbatim peer.mjs code (${N} worlds per class and hook)`);
const HOOKS_TO_CHECK = HOOK_NAMES.filter(h => h !== 'local');
const exercised = {};
for (const id of CLASSES_IMPLEMENTED) {
  for (const h of HOOKS_TO_CHECK) {
    let bad = null, n = 0;
    for (let s = 0; s < N && !bad; s++) {
      const W = genWorld(s * 7919 + id.length * 31 + h.length);
      let { args, ctx = W.ctx } = argsFor(h, id, W, W.R);
      if (h === 'share_skills') args = fixShare(args);
      const snap = J(args);
      let got, want;
      if (h === 'ability') {
        if (REQ[id]) { got = classHook(h, id, ctx, structuredClone(args)); want = { used: true, note: '', log: [], mine: [], out: REQ[id](ctx.classData(id) || {}) }; }
        else {
          const res = classHook(h, id, ctx, structuredClone(args));
          got = observedFromHook(res, ctx, id, args.actor);
          want = (CLASS_RULES[id].phase === 'pre' || CLASS_RULES[id].phase === 'post') ? REF_ability(W, ctx, id, structuredClone(args)) : observedFromHook(null, ctx, id, args.actor);
          if (res?.used) (exercised[`${id} ability used`] = (exercised[`${id} ability used`] || 0) + 1);
          else (exercised[`${id} ability idle`] = (exercised[`${id} ability idle`] || 0) + 1);
        }
      } else if (h === 'transmute') {
        const res = classHook(h, id, ctx, structuredClone(args));
        const ref = REF.transmute(W, ctx, id, structuredClone(args));
        if (ref.effectOutcomes) {
          const mine = args.outcomes.map(o => ({ actor: o.actor, oc: { status: o.status, statTokens: [...o.statTokens], heals: [...o.heals] } }));
          for (const e of res.edits) { mine[e.i].oc.statTokens.push(...e.statTokens); mine[e.i].oc.heals.push(...e.heals); }
          got = { effectOutcomes: mine, log: res.log }; want = ref;
          if (res.edits.length) exercised[`${id} transmute edits`] = (exercised[`${id} transmute edits`] || 0) + 1;
        } else { got = res; want = ref; }
      } else {
        got = classHook(h, id, ctx, structuredClone(args));
        want = REF[h](W, ctx, id, structuredClone(args));
      }
      if (J(args) !== snap) { bad = { s, why: 'hook mutated its args' }; break; }
      if (J(got) !== J(want)) bad = { s, args: J(args).slice(0, 500), got: J(got).slice(0, 700), want: J(want).slice(0, 700) };
      n++;
    }
    if (bad) { fails++; console.log(`FAIL ${id} ${h} (seed ${bad.s}) ${bad.why || ''}\n     args ${bad.args}\n     got  ${bad.got}\n     want ${bad.want}`); }
    else oks++;
  }
}
console.log(`     ${CLASSES_IMPLEMENTED.length} classes × ${HOOKS_TO_CHECK.length} hooks identical`);
// both branches of every data-able ability were exercised
for (const id of CLASSES_IMPLEMENTED.filter(c => ['pre', 'post'].includes(CLASS_RULES[c].phase) && !REQ[c])) {
  const used = exercised[`${id} ability used`] || 0, idle = exercised[`${id} ability idle`] || 0;
  const needIdle = !['class_healer', 'class_illusionist', 'class_necromancer', 'class_alchemist', 'class_druid'].includes(id);   // these always fire (the fixture Library is never empty; CP2: the Druid's failed roll spends the tap — its idle branch is the fail_spends-off oracle)
  eq(`${id}: fixtures exercise the ability (used ${used}, idle ${idle})`, used > 0 && (!needIdle || idle > 0), true, true);
}
eq('transmuter: fixtures exercise shared casts', (exercised['class_transmuter transmute edits'] || 0) > 0, true, true);

console.log(fails ? `${fails} class check(s) FAILED (${oks} ok)` : `all class checks passed (${oks} ok)`);
process.exit(fails ? 1 : 0);
