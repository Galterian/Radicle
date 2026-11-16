// Class rules check (chaosD6-Classes C1): game/classes.mjs against the inline class code of peer.mjs.
//   node tools/classes-check.mjs            → ends with "all class checks passed"   (CLASSES_CHECK_N=… cases per hook, default 400)
// 1. table: CLASS_RULES covers data/classes.json; CLASS_NEEDS / PASSIVE_TURN_CLASSES / HAND defaults / local
//    descriptors = the peer.mjs tables; TRAP_POWER / pickBySalt / pointBuy = effects.mjs.
// 2. worked examples from the user's rulings (strike die 6, recast / untap, Guardian, Overlord, Avenger, Rogue, Cleric).
// 3. identity: ≥ 300 seeded random worlds per hook and class — the REF_* functions below are the peer.mjs code as it
//    is on 2026-11-16 (copied verbatim, only the closure names bound to the test world; grep the quoted anchors in
//    peer.mjs), compared JSON-for-JSON with classHook(...) on a deep copy of the same world.
// Under CLASS_ENGINE=shadow|data (tools/class-engine-check.mjs runs it that way) the classHook side is the data engine.
import { CLASS_RULES, CLASSES_IMPLEMENTED, CLASS_NEEDS, PASSIVE_TURN_CLASSES, PEER_ABILITIES, TRAP_POWER as CL_TRAP_POWER, ELEM_TO_STAT as CL_E2S, HOOK_NAMES, classHook, CLASS_ENGINE } from '../classes.mjs';
import { TRAP_POWER, pickBySalt, pointBuy } from '../effects.mjs';
import { pointBuy as enginePointBuy } from '../effect-engine.mjs';
import { rogueConfig, clericConfig } from '../class-traps.mjs';
import { manipulatorConfig, combatHit, pickManipTarget } from '../class-manipulator.mjs';
import { avengerConfig, prophetConfig, isWildMonster, lureTargets, chaseBonusStep, prophetPick } from '../class-chase.mjs';
import { animatorConfig, priestConfig, seekerConfig } from '../class-world.mjs';
import { CLASSES, SKILLS, ELEM_TO_STAT, STATS, genWorld, argsFor, sha256Hex } from './class-fixtures.mjs';

let fails = 0, oks = 0;
const J = (x) => JSON.stringify(x);
const eq = (label, got, want, quietOk = false) => {
  const g = J(got), w = J(want), ok = g === w;
  if (ok) oks++; else fails++;
  if (!ok || !quietOk) console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${String(g).length > 300 ? String(g).slice(0, 300) + '…' : g}${ok ? '' : `\n     want ${String(w).length > 300 ? String(w).slice(0, 300) + '…' : w}`}`);
  return ok;
};
const N = Number(process.env.CLASSES_CHECK_N || 400);
if (CLASS_ENGINE !== 'js') console.log(`note: CLASS_ENGINE=${CLASS_ENGINE} — classHook answers through the ${CLASS_ENGINE} engine`);

// ---- 1. table -------------------------------------------------------------------------------------------------
console.log('-- 1. table');
eq('CLASS_RULES ids = data/classes.json ids (same order)', CLASSES_IMPLEMENTED, Object.keys(CLASSES));
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
eq('local descriptors = peer.mjs CLASS_LOCAL', Object.fromEntries(CLASSES_IMPLEMENTED.filter(id => CLASS_RULES[id].phase === 'local').map(id => [id, classHook('local', id, null)])), {
  class_weapon_master: { op: 'draw', n: 1 }, class_summoner: { op: 'grant', effect_id: 'effect_summoning' },
  class_paladin: { op: 'recover', kind: 'action', what: 'an action card' }, class_shaman: { op: 'recover', kind: 'effect', what: 'an effect card' }, class_kensei: { op: 'recover', kind: 'skill', what: 'a skill card' } });
// peer.mjs post-pass: "if (!ab || ['class_elementalist', 'class_illusionist', 'class_rogue'].includes(ab.id)) continue;" + its switch cases
const POST_CASES = ['class_healer', 'class_overlord', 'class_druid', 'class_witch', 'class_avenger', 'class_animator', 'class_priest', 'class_cleric', 'class_alchemist', 'class_ranger', 'class_seeker', 'class_warrior', 'class_necromancer'];
eq('phase post = the post-pass switch cases', CLASSES_IMPLEMENTED.filter(id => CLASS_RULES[id].phase === 'post').sort(), [...POST_CASES].sort());
eq('phase pre = Illusionist', CLASSES_IMPLEMENTED.filter(id => CLASS_RULES[id].phase === 'pre'), ['class_illusionist']);
eq('peer-resolved abilities = animator / priest / cleric / seeker / warrior', Object.keys(PEER_ABILITIES).sort(), ['class_animator', 'class_cleric', 'class_priest', 'class_seeker', 'class_warrior']);
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
  const reanimatedAll = (peers) => new Set(peers.flatMap(p => String(p?.reanimated_csv || '').split(',').filter(Boolean)));
  const tileNear = (id, t) => { const v = view.get(id); return !!v && !!t && Number.isInteger(t.q) && Number.isInteger(t.r) && ((Math.abs(v.tile_q - t.q) + Math.abs(v.tile_r - t.r) + Math.abs(v.tile_q + v.tile_r - t.q - t.r)) / 2) <= 1; };
  const libraryCardFor = (salt) => { const lib = effCtx.library(); return lib.length ? lib[parseInt(sha256Hex(salt).slice(0, 8), 16) % lib.length] : null; };
  return { PEER_ID_STRING, PEER_LABEL, view, data, hg, lifeOf, distBetween, enemyOf, hasPerm, statOf, sideOf, parseJson, effCtx, classColours, classDataOf, classRangeOf, handRevealOf, handDiscardOf, classKindOf, elemsOfStat, reanimatedAll, tileNear, libraryCardFor };
}

// The abilities of simulate(): the pre-pass Illusionist and the post-pass switch, verbatim.
function REF_ability(W, ctx, classId, { actor, ab: ab0, salt }) {
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
      case 'class_healer': { const who = nearAlly || me; classAbilityOut.heals.push({ on: who, amount: 1, by: me }); useAbility(r, `one life token restored to ${who === me ? 'me' : who.slice(0, 8)}`); break; }
      case 'class_overlord': {
        const bare = (id) => !Number(view.get(id)?.armor);
        const who = bare(me) ? me : nearAlly && bare(nearAlly) ? nearAlly : adjacentOf(me, o => !enemyOf(me, o) && bare(o))[0] || null;
        if (!who) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class overlord: I and every ally next to me already wear an armor point`); break; }
        classAbilityOut.armor.push({ on: who, by: me }); useAbility(r, `${who === me ? 'I wear' : `${who.slice(0, 8)} wears`} an armor life point`); break;
      }
      case 'class_druid': {
        const stones = parseJson(v.tile_tokens_json, []).filter(t => t.kind === 'bonus' && t.druid && t.q === here.q && t.r === here.r);
        const have = new Map(stones.map(t => [ELEM_TO_STAT[t.elem], t]));
        const STATS4 = ['vitality', 'world', 'matter', 'will'];
        const st = [...STATS4].sort((a, b) => statOf(me, b) - statOf(me, a) || a.localeCompare(b)).find(x => !have.has(x))
          || [...have.values()].sort((a, b) => a.value - b.value || String(a.id).localeCompare(String(b.id))).map(t => ELEM_TO_STAT[t.elem])[0] || stat;
        const elem = (classColours('class_druid')[st] || [])[0] || elemsOfStat(st)[0] || 'elem_vitality';
        const pb = pointBuy(statOf(me, st), `${r.salt || ''}:druid:${hg.action}`, sha256Hex);
        if (pb.fail) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class druid: the ${st} point-buy failed [${pb.dice.join(',')}] — no stone, the ability stays ready`); break; }
        if (have.has(st) && have.get(st).value >= pb.value) { useAbility(r, `all four stones stand; the ${pb.value} does not beat the lowest (${st} ${have.get(st).value})`); break; }
        classAbilityOut.tokens.push({ by: me, kind: 'bonus', druid: true, elem, value: pb.value, q: here.q, r: here.r });
        useAbility(r, `a Druid stone of ${st} +${pb.value} rises on my tile`); break;
      }
      case 'class_witch': {
        const foes = foesNearby(me, classRangeOf('class_witch'));
        const seed = `${r.salt || ''}:witch:${hg.action}:${me}`;
        const on = foes.includes(peer) ? peer : pickBySalt(`${seed}:who`, foes, sha256Hex);
        if (!on) { if (me === PEER_ID_STRING) log(`[${PEER_LABEL}] class witch: no enemy within ${classRangeOf('class_witch')} hexes — the card stays untapped`); break; }
        const n = Number(handDiscardOf('class_witch')?.n) || 3;
        classAbilityOut.discards.push({ on, by: me, n, seed, why: 'witch' });
        log(`[${PEER_LABEL}] witch: ${me.slice(0, 14)} makes ${on.slice(0, 14)} discard ${n} (seed ${sha256Hex(seed).slice(0, 8)})`);
        useAbility(r, `${on.slice(0, 8)} puts ${n} random hand cards onto its discard pile`); break;
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
      if (!entity.classProgress.done.includes(co.stat)) entity.classProgress.done.push(co.stat);
      const complete = cols.every(s => entity.classProgress.done.includes(s));
      if (complete && co.kind === 'recast') { entity.classArchived = false; entity.classDown = []; entity.classProgress = null; event = 'recast'; }
      else if (complete) { entity.classTapped = false; entity.classProgress = null; event = 'untap'; }
      else event = 'step';
    }
    return { state: { down: entity.classDown, archived: entity.classArchived, tapped: entity.classTapped, progress: entity.classProgress }, event };
  },
  // "// Shield life points are the first life lost — the illusion, then the armor." (+ the chase bonus line)
  life_points: (_W, _ctx, _id, { dmg, illusion, armor, chaseBonus }) => {
    const myDmg = dmg, entity = { illusion, armor, chaseBonus };
    let shieldHit = 0;
    if (myDmg > 0 && entity.illusion) { entity.illusion = 0; shieldHit++; }
    if (myDmg > shieldHit && entity.armor) { entity.armor = 0; shieldHit++; }
    if (myDmg > shieldHit && entity.chaseBonus) { entity.chaseBonus = 0; shieldHit++; }
    return { illusion: entity.illusion, armor: entity.armor, chaseBonus: entity.chaseBonus, absorbed: shieldHit };
  },
  // class stances: "if (c === 'class_reaver' && (cur === 'EP' || cur === 'EM')) {" … "else if (c === 'class_monk') effAction.set(r.actor, 'M');"
  stance: (_W, _ctx, c, { code: cur }) => {
    let out = null;
    if (c === 'class_reaver' && (cur === 'EP' || cur === 'EM')) out = 'A';
    else if (cur !== 'EP') return null;
    else if (c === 'class_barbarian') out = 'B';
    else if (c === 'class_monk') out = 'M';
    return out;
  },
  // Reaver auto-target: ".sort((a, b) => a.cost - b.cost || a.lands - b.lands || a.life - b.life || a.id.localeCompare(b.id))[0]"
  stance_target: (_W, _ctx, c, { cands }) => { if (c !== 'class_reaver') return null; const pick = [...cands].sort((a, b) => a.cost - b.cost || a.lands - b.lands || a.life - b.life || a.id.localeCompare(b.id))[0]; return pick ? pick.id : null; },
  // the four emission sites: planning emitsLong, Rule 24 emitsNow, manipulator emitsFor, element badge anyEmit
  // User rulings 2026-11-16 ("Implement them"): Barbarian "may emit during Block" and Monk Empty Move emit at EVERY
  // site (before: Monk EM only at plan / manip, Barbarian never) — the same answer at all four sites now.
  emits: (_W, _ctx, cls, { code: c }) => {
    return (cls === 'class_reaver' && c === 'A') || (cls === 'class_barbarian' && c === 'B') || (cls === 'class_monk' && (c === 'M' || c === 'EM'));
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
  plan_emits: (_W, ctx, cls, a) => cls === 'class_enchanter' && (a.held && !a.archived && a.usedTurn !== ctx.turn && !a.options && ['A', 'B', 'M'].includes(a.code) && a.queued),
  // "if (dmg >= 1 && hasPerm(r.actor, 'class_assassin') && assassinScored.has(r.actor)) dmg += 1;"
  attack_out: (_W, ctx, cls, { attacker, dmg, scored }) => { if (cls !== 'class_assassin') return dmg; const assassinScored = new Set(scored); if (dmg >= 1 && ctx.hasPerm(attacker, 'class_assassin') && assassinScored.has(attacker)) dmg += 1; return dmg; },
  // "if (amount > 0 && hasPerm(attacker, 'class_noble') && attacker === PEER_ID_STRING) lifestealForMe.amount += amount;"
  lifesteal: (_W, ctx, cls, { attacker, amount }) => { const lifestealForMe = { amount: 0 }; if (cls === 'class_noble' && amount > 0 && ctx.hasPerm(attacker, 'class_noble') && attacker === ctx.self) lifestealForMe.amount += amount; return lifestealForMe.amount; },
  // "if (lifestealForMe.amount > 0 && entity.life > 0 && entity.permanents.has('class_noble')) {"
  lifesteal_apply: (_W, _ctx, cls, { amount, life, lifeMax, held }) => { const entity = { life, lifeMax }; if (cls === 'class_noble' && amount > 0 && entity.life > 0 && held) entity.life = Math.min(entity.lifeMax, entity.life + amount); return entity.life; },
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
  end_turn: (_W, _ctx, cls, { held, moved, life, lifeMax }) => { const entity = { life, lifeMax }; if (cls === 'class_guardian' && held && !moved && entity.life > 0) { if (entity.life < entity.lifeMax) entity.life += 1; } return entity.life - life; },
  // trap steps: "const rogue = classStanding(who, 'class_rogue');" … "for (const tp of laid) springTrap(tp, who);"
  step: (_W, _ctx, cls, a) => {
    const classStanding = (_who, c) => c === cls;
    const rogueThreatReady = () => a.threatReady, rogueTrapLeft = () => a.trapLeft, buildingTileAt = () => a.building;
    const laid = a.trap && !a.wtrap ? ['laid'] : a.trap ? ['laid'] : [], wtrap = a.wtrap && a.trap ? { id: 'w' } : null;
    let stealth = false;
    const rogue = classStanding('who', 'class_rogue');
    if (rogue && rogueThreatReady('who')) { const ring = a.ring; if (ring.length) stealth = true; }
    if (!laid.length && !wtrap) return { stealth, trap: 'none' };
    if (rogue && rogueTrapLeft('who') > 0) return { stealth, trap: 'dodge' };
    if (classStanding('who', 'class_cleric') && (wtrap || buildingTileAt())) return { stealth, trap: 'disable' };
    return { stealth, trap: 'spring' };
  },
  // dungeons: "if (tp && classStanding(id, 'class_rogue') && rogueTrapLeft(id) > 0) {" … "if (tp && classStanding(id, 'class_cleric'))"
  dungeon_step: (_W, _ctx, cls, { trap, trapLeft }) => { const tp = trap; if (tp && cls === 'class_rogue' && trapLeft > 0) return 'dodge'; if (tp && cls === 'class_cleric') return 'disable'; if (tp) return 'spring'; return 'none'; },
  combat_in: (_W, _ctx, cls, { list }) => cls === 'class_manipulator' && combatHit(list),
  pick_target: (_W, _ctx, cls, { seed, cands }) => cls === 'class_manipulator' ? pickManipTarget(seed, cands, sha256Hex) : null,
  chase_step: (W, ctx, cls, { state, chasing }) => cls === 'class_avenger' ? chaseBonusStep(state, chasing, avengerConfig(refWorld(W, ctx).data.classes.class_avenger?.data)) : { chasers: [...new Set(chasing || [])].sort(), bonus: Number(state?.bonus) || 0, fresh: [], grant: 0, fade: false },
  contact: (_W, _ctx, cls, { foes }) => cls === 'class_prophet' ? prophetPick(foes) : null,
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
  eq('Assassin: +1 once it already scored this action', classHook('attack_out', 'class_assassin', { ...ctx0, hasPerm: () => true }, { attacker: 'peer:a', dmg: 1, scored: ['peer:a'] }), 2);
  eq('Rogue: trap step with a charge → dodged (ruling 2026-11-14)', classHook('step', 'class_rogue', ctx0, { threatReady: true, ring: ['peer:m'], trap: true, wtrap: true, building: true, trapLeft: 1 }), { stealth: true, trap: 'dodge' });
  eq('Cleric: stepping on a trapped building → disabled (ruling 2026-11-14)', classHook('step', 'class_cleric', ctx0, { threatReady: false, ring: [], trap: true, wtrap: true, building: true, trapLeft: 0 }), { stealth: false, trap: 'disable' });
  eq('Cleric: a laid trap on open ground still springs', classHook('step', 'class_cleric', ctx0, { threatReady: false, ring: [], trap: true, wtrap: false, building: false, trapLeft: 0 }), { stealth: false, trap: 'spring' });
  eq('Avenger: a new chaser grants +1, cap 1 (ruling 2026-11-15)', classHook('chase_step', 'class_avenger', ctx0, { state: { chasers: [], bonus: 0 }, chasing: ['peer:m2', 'peer:m1'] }), { chasers: ['peer:m1', 'peer:m2'], bonus: 1, fresh: ['peer:m1', 'peer:m2'], grant: 1, fade: false });
  eq('Reaver EP fights as A, Barbarian EP as B, Monk EP as M; Reaver EM as A', ['class_reaver', 'class_barbarian', 'class_monk'].map(c => classHook('stance', c, ctx0, { code: 'EP' })).concat([classHook('stance', 'class_reaver', ctx0, { code: 'EM' }), classHook('stance', 'class_monk', ctx0, { code: 'EM' })]), ['A', 'B', 'M', 'A', null]);
  // user rulings 2026-11-16
  eq('Barbarian B and Monk M / EM emit at every site (plan, Rule 24, manipulator, badge)', ['plan', 'destroy', 'manip', 'badge'].map(site => [classHook('emits', 'class_barbarian', ctx0, { code: 'B', site }), classHook('emits', 'class_monk', ctx0, { code: 'EM', site }), classHook('emits', 'class_monk', ctx0, { code: 'M', site }), classHook('emits', 'class_barbarian', ctx0, { code: 'A', site })]), Array(4).fill([true, true, true, false]));
  const nd = { ...ctx0, classData: (id) => CLASSES[id].data };
  eq('Necromancer: Harmony with a 6 on a reanimated unit → struck (not last)', classHook('reanimated_strike', 'class_necromancer', nd, { down: [], stat: 'will', elem: 'elem_harmony', enemy: true, pb: { fail: false, value: 6, dice: [6] } }), { result: 'destroyed', ok: true, last: false, elem: 'elem_harmony' });
  eq('Necromancer: then Concentration with a 6 (another action) → the reanimated unit is destroyed', classHook('reanimated_strike', 'class_necromancer', nd, { down: ['elem_harmony'], stat: 'will', elem: null, enemy: true, pb: { fail: false, value: 6, dice: [6, 1] } }), { result: 'destroyed', ok: true, last: true, elem: 'elem_concentration' });
  eq('Necromancer: a 5 is too weak; a Matter emission has no target', [classHook('reanimated_strike', 'class_necromancer', nd, { down: [], stat: 'will', elem: null, enemy: true, pb: { fail: false, value: 5, dice: [5] } }), classHook('reanimated_strike', 'class_necromancer', nd, { down: [], stat: 'matter', elem: null, enemy: true, pb: { fail: false, value: 6, dice: [6] } })], [{ result: 'too weak', ok: false, last: false, elem: 'elem_harmony' }, null]);
  eq('Necromancer: other classes raise nothing that this applies to', classHook('reanimated_strike', 'class_healer', nd, { down: [], stat: 'will', elem: null, enemy: true, pb: { fail: false, value: 6, dice: [6] } }), null);
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
        if (PEER_ABILITIES[id]) { got = classHook(h, id, ctx, structuredClone(args)); want = null; }
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
for (const id of CLASSES_IMPLEMENTED.filter(c => ['pre', 'post'].includes(CLASS_RULES[c].phase) && !PEER_ABILITIES[c])) {
  const used = exercised[`${id} ability used`] || 0, idle = exercised[`${id} ability idle`] || 0;
  const needIdle = !['class_healer', 'class_illusionist', 'class_necromancer', 'class_alchemist'].includes(id);   // these always fire (the fixture Library is never empty)
  eq(`${id}: fixtures exercise the ability (used ${used}, idle ${idle})`, used > 0 && (!needIdle || idle > 0), true, true);
}
eq('transmuter: fixtures exercise shared casts', (exercised['class_transmuter transmute edits'] || 0) > 0, true, true);

console.log(fails ? `${fails} class check(s) FAILED (${oks} ok)` : `all class checks passed (${oks} ok)`);
process.exit(fails ? 1 : 0);
