// Skill rules check (chaosD6-Skills S1): game/skills.mjs against the pre-refactor inline code of peer.mjs.
//   node tools/skills-check.mjs            → ends with "all skill checks passed"
// 1. table: SKILL_RULES flags = data/skills.json (active version), deal order, NEGATING_SKILLS.
// 2. worked examples from the user's rulings (Counter Spell, Force Shield, Dodge, Bluff, Intimidation, …).
// 3. identity: ≥ 300 seeded random cases per hook, the REF_* functions below are the peer.mjs code as it was
//    before S1 (copied verbatim, only the closure names bound to the test world), compared JSON-for-JSON
//    with skillHook(...) on a deep copy of the same world.
// 2026-11-16 SKILL REBALANCE (user rulings): Force Shield, Taunt, Ranged Weapon, Sanctuary, Overrun, Disruption Move and
//    Powerful Attack are now INTENTIONALLY different from the pre-S1 code. Their REF_* lines below are replaced by the
//    reference of the ruling (marked `ruling 2026-11-16`), and section 2b holds the worked examples of the rulings.
import fs from 'node:fs';
import { SKILL_RULES, SKILLS_IMPLEMENTED, NEGATING_SKILLS, TRANCE, HOOK_NAMES, skillHook, ridesOn, ridesFor } from '../skills.mjs';

let fails = 0, oks = 0;
const eq = (label, got, want, quietOk = false) => {
  const g = JSON.stringify(got), w = JSON.stringify(want), ok = g === w;
  if (ok) oks++; else fails++;
  if (!ok || !quietOk) console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${g.length > 300 ? g.slice(0, 300) + '…' : g}${ok ? '' : `\n     want ${w.length > 300 ? w.slice(0, 300) + '…' : w}`}`);
  return ok;
};

// ---- data ----------------------------------------------------------------------------------------------
const skillsJson = JSON.parse(fs.readFileSync(new URL('../../data/skills.json', import.meta.url), 'utf8'));
// pickActive (peer.mjs): not rejected / superseded, highest weight.
const pickActive = (e) => (e.versions || []).filter(v => v.status !== 'rejected' && v.status !== 'superseded').sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0] || null;
const DATA = {};
for (const e of skillsJson.entries) { const v = pickActive(e); if (v) DATA[e.id] = { name: e.name, data: v.data }; }
const skillData = (id) => DATA[id]?.data;
const ELEM_TO_STAT = { elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' };
const ELEMS = Object.keys(ELEM_TO_STAT);
const CODES = ['A', 'B', 'M', 'P', 'EM', 'EP'];

// ---- 1. table -------------------------------------------------------------------------------------------
console.log('-- 1. table');
const OLD_IMPLEMENTED = [
  'skill_powerful_attack', 'skill_overrun', 'skill_grapple', 'skill_ranged_weapon',
  'skill_taunt', 'skill_barricade', 'skill_sanctuary',
  'skill_dodge', 'skill_bluff', 'skill_intimidation', 'skill_disruption_move',
  'skill_battle_trance', 'skill_force_shield', 'skill_counter_spell',
];
const OLD_NEGATING = new Set(['skill_intimidation', 'skill_bluff', 'skill_grapple', 'skill_disruption_move', 'skill_overrun', 'skill_dodge', 'skill_counter_spell']);
eq('SKILLS_IMPLEMENTED = old deal order', SKILLS_IMPLEMENTED, OLD_IMPLEMENTED);
eq('NEGATING_SKILLS = old set', [...NEGATING_SKILLS].sort(), [...OLD_NEGATING].sort());
eq('TRANCE', TRANCE, 'skill_battle_trance');
for (const id of SKILLS_IMPLEMENTED) {
  const d = skillData(id), r = SKILL_RULES[id];
  const pb = d?.point_buy_stat ? (d.point_buy_stat === 'any' ? 'any' : d.point_buy_stat.replace(/^stat_/, '')) : undefined;
  eq(`flags ${id} = data/skills.json`, { action: r.action, permanent: r.permanent, pointBuyStat: r.pointBuyStat }, { action: d?.action_type, permanent: !!d?.is_permanent, pointBuyStat: pb }, true);
  for (const h of r.hooks) if (!HOOK_NAMES.includes(h) && !['plan', 'move'].includes(h)) { fails++; console.log(`FAIL ${id}: unknown hook ${h}`); }
}
console.log(`ok   ${SKILLS_IMPLEMENTED.length} skills: flags match data, hooks known`);

// ---- seeded PRNG + random worlds ---------------------------------------------------------------------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function rngOf(seed) { const f = mulberry32(seed * 2654435761 >>> 0); return { f, int: (n) => Math.floor(f() * n), pick: (a) => a[Math.floor(f() * a.length)], p: (x) => f() < x }; }
const hexDistance = (a, b) => (Math.abs(a.tile_q - b.tile_q) + Math.abs(a.tile_r - b.tile_r) + Math.abs((a.tile_q + a.tile_r) - (b.tile_q + b.tile_r))) / 2;
const statRaw = (v, sk) => Math.max(0, v?.[`stat_${sk}`] ?? 0);
const roundHalfUp10 = (sum) => Math.round(sum / 10);

function genWorld(seed) {
  const R = rngOf(seed);
  const n = 2 + R.int(5);
  const ids = Array.from({ length: n }, (_, i) => `peer:${'abcdefgh'[i]}${R.int(90) + 10}`);
  const view = {};
  for (const id of ids) {
    if (R.p(0.05)) continue;   // a revealer the view does not know
    const v = { peer_id: id, life: R.p(0.1) ? 0 : 1 + R.int(4), tile_q: R.int(3) - 1, tile_r: R.int(3) - 1, alliance: R.pick(['player', 'npc_a', 'npc_b', 'player_c']) };
    for (const s of ['vitality', 'world', 'matter', 'will']) if (!R.p(0.05)) v[`stat_${s}`] = R.int(21);
    view[id] = v;
  }
  const perms = {}, power = {}, invis = [];
  for (const id of ids) {
    perms[id] = ['skill_taunt', 'skill_ranged_weapon', 'skill_barricade', 'skill_sanctuary', 'skill_force_shield', 'class_x'].filter(() => R.p(0.2));
    power[id] = {}; for (const p of perms[id]) if (R.p(0.85)) power[id][p] = 1 + R.int(6);
    if (R.p(0.12)) invis.push(id);
  }
  const reveals = [];
  for (const id of ids) {
    if (R.p(0.1)) continue;
    const action = R.p(0.15) ? 'BT' : R.pick(CODES);
    const r = { actor: id, action, target: null, skills: [], trance: null, effect: null, salt: `s${seed}` };
    if (action === 'BT' && R.p(0.85)) r.trance = [R.pick(CODES), R.pick(CODES)];
    const k = R.int(4);
    for (let i = 0; i < k; i++) { const s = R.pick(SKILLS_IMPLEMENTED); if (!r.skills.includes(s)) r.skills.push(s); }
    if (r.skills.length && R.p(0.15)) r.buildingSkill = R.pick(r.skills);
    const t = R.f();
    if (t < 0.55) r.target = { kind: 'character', ref: R.pick(ids) }; else if (t < 0.7) r.target = { kind: 'tile', ref: { q: R.int(3) - 1, r: R.int(3) - 1 } };
    if (R.p(0.45)) r.effect = { effect_id: 'effect_t', elements: Array.from({ length: 1 + R.int(3) }, () => R.pick(ELEMS)), dmg: R.p(0.8) };
    reveals.push(r);
  }
  reveals.sort((a, b) => a.actor.localeCompare(b.actor));
  return { ids, view, perms, power, invis, reveals, self: R.pick(ids) };
}

// The resolver registers + queries over a world, built the way simulate() builds them (peer.mjs 3052-3062).
function bind(w) {
  const view = new Map(Object.entries(w.view));
  const revealsThisTurn = w.reveals;
  const logs = [];
  const log = (...a) => logs.push(a.join(' '));
  const byActorPre = new Map(revealsThisTurn.map(r => [r.actor, r]));
  const hasPerm = (id, p) => (w.perms[id] || []).includes(p);
  const permPowerOf = (id) => w.power[id] || {};
  const distBetween = (a, b) => { const pa = view.get(a), pb = view.get(b); return pa && pb ? hexDistance(pa, pb) : Infinity; };
  const sideOfId = (id) => view.get(id)?.alliance ?? null;
  const enemyOf = (a, b) => { const sa = sideOfId(a), sb = sideOfId(b); return sa !== null && sb !== null && sa !== sb; };
  const invisibleNow = (id) => w.invis.includes(id);
  const hiddenFrom = (viewer, id) => viewer !== id && invisibleNow(id) && enemyOf(viewer, id) && !invisibleNow(viewer);
  const lifeOf = (id) => view.get(id)?.life ?? 0;
  const effAction = new Map(revealsThisTurn.map(r => [r.actor, r.action]));
  const tranceOpts = new Map(revealsThisTurn.filter(r => r.action === 'BT' && r.trance).map(r => [r.actor, [...r.trance]]));
  for (const r of revealsThisTurn) if (r.action === 'BT' && !r.trance) effAction.set(r.actor, 'EP');
  const codeIs = (id, c) => tranceOpts.has(id) ? tranceOpts.get(id).includes(c) : effAction.get(id) === c;
  const replace = (id, from, to) => {
    const o = tranceOpts.get(id);
    if (o) { for (let i = 0; i < o.length; i++) if (o[i] === from) o[i] = to; }
    else if (effAction.get(id) === from) effAction.set(id, to);
  };
  const noMove = new Set();
  const noEmit = new Set(), swaps = [];   // ruling 2026-11-16: Disruption voids an emission / Overrun swap (peer.mjs SKR hunks)
  const counterPen = new Map();
  const castsDamage = (o) => !!o.effect && Array.isArray(o.effect.elements) && o.effect.elements.length > 0 && !!o.effect.dmg;
  // A Rule 21 delta cast: Σ per element max(0, caster stat − Counter Spell pen − defender stat), rounded once.
  const effectDmgNoShield = (o, defId) => {
    if (!castsDamage(o)) return 0;
    const cv = view.get(o.actor), dv = view.get(defId);
    if (!cv || !dv) return 0;
    let s = 0;
    for (const el of o.effect.elements) s += Math.max(0, Math.max(0, statRaw(cv, ELEM_TO_STAT[el]) - (counterPen.get(o.actor)?.[el] || 0)) - statRaw(dv, ELEM_TO_STAT[el]));
    return roundHalfUp10(s);
  };
  const edgeMap = { A: { M: 0, B: -1, A: 0 }, P: { M: 1, A: 0, B: 0 }, M: { B: 1, EP: 0 }, B: { A: 1 } };
  const edgeDmg = (atk, def) => { if (atk === 'A' && (def === 'EP' || def === 'EM' || def === 'P')) return 1; return Math.max(0, (atk === 'A' ? 1 : 0) + (edgeMap[atk]?.[def] ?? 0)); };
  const skillFx = [];
  const skCtx = {
    self: w.self, label: 'T', log, reveals: revealsThisTurn, byActorPre,
    effAction, tranceOpts, noMove, counterPen, skillFx, codeIs, replace, noEmit, swaps,
    enemyOf, hiddenFrom, dist: distBetween, lifeOf,
    view: (id) => view.get(id), viewValues: () => view.values(),
    elemStat: (el) => ELEM_TO_STAT[el], hasPerm, permPower: permPowerOf,
    castsDamage, effectDmgNoShield, skillData, edgeDmg,
  };
  if (w.noRegisters) { delete skCtx.noEmit; delete skCtx.swaps; }   // the resolver before the SKR hunks
  return { view, revealsThisTurn, logs, log, byActorPre, hasPerm, permPowerOf, distBetween, enemyOf, hiddenFrom, lifeOf, effAction, tranceOpts, codeIs, replace, noMove, noEmit, swaps, counterPen, castsDamage, effectDmgNoShield, edgeDmg, skillFx, skCtx, w, PEER_ID_STRING: w.self, PEER_LABEL: 'T' };
}
const data = { skills: DATA };

// ---- REF: peer.mjs before S1 (verbatim; `B` = the bound world) ---------------------------------------
function REF_passes(B) {
  const { revealsThisTurn, byActorPre, effAction, tranceOpts, codeIs, replace, noMove, noEmit, swaps, counterPen, enemyOf, hiddenFrom, distBetween, lifeOf, castsDamage, effectDmgNoShield, skillFx, log, view, PEER_ID_STRING, PEER_LABEL } = B;
  const has = (id, skill) => (byActorPre.get(id)?.skills || []).includes(skill);
  const ridesFor = (r) => {
    const codes = r.trance || [r.action];
    return c => codes.includes(c) || ((c === 'M' || c === 'P') && (codes.includes('EP') || codes.includes('EM')));
  };
  const nonPerm = (id) => id !== TRANCE && !data.skills[id]?.data?.is_permanent;
  const fromBuilding = (by, skill) => byActorPre.get(by)?.buildingSkill === skill;
  const negate = (by, skill, o, what) => {
    const ridden = (o.skills || []).filter(nonPerm);
    o.skills = (o.skills || []).filter(id => !nonPerm(id));
    skillFx.push({ by, skill, on: o.actor, what, negated: true, ridden, building: fromBuilding(by, skill) });
  };
  const counterSkills = (by, skill, o) => {
    const countered = (o.skills || []).filter(nonPerm);
    o.skills = (o.skills || []).filter(id => !nonPerm(id));
    skillFx.push({ by, skill, on: o.actor, what: 'skills', countered, building: fromBuilding(by, skill) });
  };
  const adjacentFoes = (id) => revealsThisTurn.filter(o => o.actor !== id && enemyOf(id, o.actor) && !hiddenFrom(id, o.actor) && distBetween(id, o.actor) <= 1).map(o => o.actor);
  const foeFor = (r) => {
    const t = r.target?.kind === 'character' ? r.target.ref : null;
    if (t && effAction.has(t) && !hiddenFrom(r.actor, t)) return t;
    return adjacentFoes(r.actor).sort((a, b) => (Number(codeIs(b, 'A')) - Number(codeIs(a, 'A'))) || a.localeCompare(b))[0] || null;
  };
  for (const r of [...revealsThisTurn].sort((a, b) => a.actor.localeCompare(b.actor))) {
    if (!(r.skills || []).includes('skill_counter_spell')) continue;
    if (!ridesFor(r)('P')) continue;
    const casterV = view.get(r.actor);
    if (!casterV) continue;
    const declared = r.target?.kind === 'character' ? r.target.ref : null;
    const cands = revealsThisTurn.filter(o => o.actor !== r.actor && enemyOf(r.actor, o.actor) && !hiddenFrom(r.actor, o.actor) && distBetween(r.actor, o.actor) <= 1);
    if (!cands.length) continue;
    const bestElem = (o) => {
      if (!castsDamage(o)) return null;
      const before = effectDmgNoShield(o, r.actor);
      const prev = counterPen.get(o.actor);
      let best = null;
      for (const el of [...new Set(o.effect.elements)].sort()) {
        const amount = statRaw(casterV, ELEM_TO_STAT[el]);
        if (!amount) continue;
        counterPen.set(o.actor, { ...(prev || {}), [el]: (prev?.[el] || 0) + amount });
        const saved = before - effectDmgNoShield(o, r.actor);
        if (!best || saved > best.saved) best = { el, amount, saved };
      }
      if (prev) counterPen.set(o.actor, prev); else counterPen.delete(o.actor);
      return best;
    };
    const casters = cands.filter(castsDamage);
    let o = cands.find(c => c.actor === declared && castsDamage(c)) || null;
    if (!o && casters.length) {
      o = casters.map(c => ({ c, b: bestElem(c) }))
        .sort((x, y) => (y.b?.saved ?? -1) - (x.b?.saved ?? -1) || lifeOf(x.c.actor) - lifeOf(y.c.actor) || x.c.actor.localeCompare(y.c.actor))[0].c;
    }
    if (!o) o = cands.find(c => c.actor === declared) || null;
    if (!o) continue;
    const tgt = o.actor;
    const kept = (o.skills || []).filter(id => !!data.skills[id]?.data?.is_permanent);
    const stripped = (o.skills || []).filter(id => !kept.includes(id));
    o.skills = kept;
    const bCs = bestElem(o);
    if (stripped.length || bCs) skillFx.push({ by: r.actor, skill: 'skill_counter_spell', on: tgt, what: 'skills', countered: stripped.filter(id => id !== TRANCE), building: fromBuilding(r.actor, 'skill_counter_spell') });
    if (stripped.includes(TRANCE) && o.trance) { effAction.set(tgt, o.trance[0]); tranceOpts.delete(tgt); o.trance = null; }
    const b = bestElem(o);
    if (b) {
      const pen = counterPen.get(tgt) || {};
      pen[b.el] = (pen[b.el] || 0) + b.amount;
      counterPen.set(tgt, pen);
    }
    if (r.actor === PEER_ID_STRING || tgt === PEER_ID_STRING) log(`[${PEER_LABEL}] counter spell ${r.actor.slice(0, 8)} → ${tgt.slice(0, 8)}: stripped [${stripped.join(',')}]${b ? `, −${b.amount} on ${b.el} (saves ${b.saved})` : ', nothing to counter'}`);
  }
  for (const r of revealsThisTurn) {
    if (!(r.skills || []).length) continue;
    const me = r.actor, rides = ridesFor(r);
    if (rides('M') && has(me, 'skill_bluff')) {
      const t = foeFor(r), o = t && byActorPre.get(t);
      if (o && distBetween(me, t) <= 1 && (tranceOpts.has(t) || effAction.get(t) !== 'EP')) {
        const what = tranceOpts.has(t) ? tranceOpts.get(t).join('+') : effAction.get(t);
        effAction.set(t, 'EP'); tranceOpts.delete(t); negate(me, 'skill_bluff', o, what);
      }
    }
    if (rides('P') && has(me, 'skill_intimidation')) {
      const atk = adjacentFoes(me).filter(id => codeIs(id, 'A'));
      for (const id of atk) { replace(id, 'A', 'EP'); negate(me, 'skill_intimidation', byActorPre.get(id), 'A'); }
      if (!atk.length) {
        const o = [foeFor(r), ...adjacentFoes(me)].filter(Boolean).map(id => byActorPre.get(id))
          .find(x => x && distBetween(me, x.actor) <= 1 && (x.skills || []).some(nonPerm));
        if (o) counterSkills(me, 'skill_intimidation', o);
      }
    }
  }
  for (const r of revealsThisTurn) {
    if (!(r.skills || []).length) continue;
    const me = r.actor, rides = ridesFor(r);
    if (rides('A') && has(me, 'skill_grapple')) { const t = foeFor(r); if (t && codeIs(t, 'P')) { replace(t, 'P', 'EP'); negate(me, 'skill_grapple', byActorPre.get(t), 'P'); } }
    // ruling 2026-11-16 (paper text): the ENEMY's Posture (negated) and Empty Posture are both played as an Empty
    // Move that goes nowhere; a non-instant effect on it emits nothing (noEmit). An EP turned is the job only when it
    // stopped such an emission. (pre-S1: Posture → Empty Posture only.)
    if (rides('M') && has(me, 'skill_disruption_move')) {
      const t = foeFor(r);
      if (t && enemyOf(me, t) && (codeIs(t, 'P') || codeIs(t, 'EP'))) {
        const o = byActorPre.get(t), postured = codeIs(t, 'P');
        const silenced = !B.w?.noRegisters && !!(o && o.effect && !o.effect.is_instant);
        for (const from of ['P', 'EP']) replace(t, from, 'EM');
        if (!tranceOpts.has(t)) noMove.add(t);
        if (silenced) noEmit.add(t);
        if (postured) negate(me, 'skill_disruption_move', o, 'P');
        else if (silenced) skillFx.push({ by: me, skill: 'skill_disruption_move', on: t, what: 'EP', building: fromBuilding(me, 'skill_disruption_move') });
      }
    }
    if (rides('A') && has(me, 'skill_overrun')) {
      const t = foeFor(r);
      if (t && distBetween(me, t) <= 1) {
        const mv = codeIs(t, 'M') ? 'M' : codeIs(t, 'EM') ? 'EM' : null; noMove.add(t); if (mv) negate(me, 'skill_overrun', byActorPre.get(t), mv);
        // ruling 2026-11-16 (paper text): swap places with the adjacent enemy of a character-targeted Attack — once per unit.
        const busy = new Set(swaps.flatMap(x => [x.by, x.on]));
        if (!B.w?.noRegisters && enemyOf(me, t) && r.target?.kind !== 'tile' && !busy.has(me) && !busy.has(t)) {
          swaps.push({ by: me, on: t });
          if (!mv) skillFx.push({ by: me, skill: 'skill_overrun', on: t, what: 'swap', building: fromBuilding(me, 'skill_overrun') });
        }
      }
    }
  }
}
// The peer code between the passes and the trance assignment that stays in peer.mjs (3424-3449).
function finalise(B) {
  const { revealsThisTurn, effAction, tranceOpts } = B;
  for (const r of revealsThisTurn) {
    r.action = effAction.get(r.actor);
    r.trance = r.action === 'BT' ? tranceOpts.get(r.actor) || null : null;
    if (r.action === 'BT' && !r.trance) r.action = 'EP';
  }
  const byActor = new Map(revealsThisTurn.map(r => [r.actor, r]));
  const codeVs = (id, other) => { const r = byActor.get(id); if (!r) return 'EP'; if (!r.trance) return r.action; const idx = r.vs?.get(other) ?? (r.played ? [...r.played][0] : 0); return r.trance[idx] ?? 'EP'; };
  const attacksOn = (r, victim) => {
    if (!r) return false;
    const declared = r.target?.kind === 'character' && r.target.ref === victim;
    if (!r.trance) return r.action === 'A' && declared;
    const idx = r.vs?.get(victim);
    if (idx !== undefined) return r.trance[idx] === 'A';
    return !r.vs && declared && r.trance.includes('A');
  };
  return { byActor, codeVs, attacksOn };
}
function REF_trance(B, { byActor, codeVs, attacksOn }) {
  const { revealsThisTurn, view, enemyOf, hiddenFrom, distBetween, edgeDmg } = B;
  for (const r of revealsThisTurn) {
    if (!r.trance) continue;
    const me = view.get(r.actor);
    if (!me) { r.vs = new Map(); r.played = new Set([0, 1]); continue; }
    const declared = r.target?.kind === 'character' ? r.target.ref : null;
    const adj = [...view.values()]
      .filter(p => p && p.peer_id !== r.actor && byActor.has(p.peer_id) && p.life > 0 && enemyOf(r.actor, p.peer_id) && !hiddenFrom(r.actor, p.peer_id) && distBetween(r.actor, p.peer_id) <= 1)
      .map(p => p.peer_id)
      .sort((a, b) => (a === declared ? -1 : b === declared ? 1 : a.localeCompare(b)));
    r.vs = new Map();
    r.played = new Set();
    const usedA = new Set();
    for (const e of adj) {
      const er = byActor.get(e);
      const eCode = er ? codeVs(e, r.actor) : 'EP';
      const eHits = attacksOn(er, r.actor);
      const eAims = eCode === 'A' ? eHits : eCode === 'M' ? er?.target?.kind === 'character' && er.target.ref === r.actor : true;
      let best = -1, bestScore = -Infinity;
      r.trance.forEach((opt, i) => {
        if (opt === 'A' && usedA.has(i)) return;
        const taken = eAims ? edgeDmg(eCode, opt) : 0;
        const dealt = opt === 'B' && !eHits ? 0 : edgeDmg(opt, eCode);
        const score = dealt - taken;
        if (score > bestScore) { bestScore = score; best = i; }
      });
      if (best < 0) continue;
      r.vs.set(e, best);
      r.played.add(best);
      if (r.trance[best] === 'A') usedA.add(best);
    }
    if (!adj.length) r.played = new Set([0, 1]);
  }
}
const snap = (B) => ({
  effAction: [...B.effAction], tranceOpts: [...B.tranceOpts], noMove: [...B.noMove].sort(), counterPen: [...B.counterPen], noEmit: [...B.noEmit].sort(), swaps: B.swaps,
  skillFx: B.skillFx, logs: B.logs,
  reveals: B.revealsThisTurn.map(r => ({ actor: r.actor, action: r.action, skills: r.skills, trance: r.trance, vs: r.vs ? [...r.vs] : null, played: r.played ? [...r.played] : null })),
});

// ---- 2. worked examples -----------------------------------------------------------------------------------
console.log('-- 2. worked examples (user rulings)');
const W = (view, reveals, opts = {}) => ({ ids: Object.keys(view), view, perms: opts.perms || {}, power: opts.power || {}, invis: opts.invis || [], reveals, self: opts.self || 'peer:me', ...(opts.noRegisters ? { noRegisters: true } : {}) });
const st = (q, r, side, s, life = 4) => ({ tile_q: q, tile_r: r, alliance: side, life, stat_vitality: s.v ?? 8, stat_world: s.w ?? 8, stat_matter: s.m ?? 8, stat_will: s.l ?? 8 });
const withIds = (o) => { for (const k of Object.keys(o)) o[k].peer_id = k; return o; };
const runPasses = (w) => { const B = bind(w); skillHook('counter_pre', 'skill_counter_spell', B.skCtx); skillHook('negate_action', null, B.skCtx); skillHook('negate_kind', null, B.skCtx); return B; };
{
  // Counter Spell (ruling): pick one element, subtract MY stat per instance. Lightning = fire+air, enemy Matter 16 vs my 8.
  // Without counter (16−8)+(16−8) = 16 → 2; counter one element (−8 on every instance of it): 8 → 1.
  const w = W(withIds({ 'peer:me': st(0, 0, 'player', { m: 8 }), 'peer:zz': st(1, 0, 'npc_b', { m: 16 }) }), [
    { actor: 'peer:me', action: 'EP', target: { kind: 'character', ref: 'peer:zz' }, skills: ['skill_counter_spell'], trance: null, effect: null },
    { actor: 'peer:zz', action: 'P', target: { kind: 'character', ref: 'peer:me' }, skills: ['skill_dodge'], trance: null, effect: { effect_id: 'effect_lightning', elements: ['elem_fire', 'elem_air'], dmg: true } },
  ]);
  const B = bind(w);
  eq('counter spell: Lightning before', B.effectDmgNoShield(w.reveals[1], 'peer:me'), 2);
  skillHook('counter_pre', 'skill_counter_spell', B.skCtx);
  eq('counter spell: pen = my Matter 8 on one element (ties → first sorted, air)', [...B.counterPen], [['peer:zz', { elem_air: 8 }]]);
  eq('counter spell: Lightning after = 8 → 1', B.effectDmgNoShield(w.reveals[1], 'peer:me'), 1);
  eq('counter spell: strips the non-permanent Dodge', w.reveals[1].skills, []);
  eq('counter spell: fx', B.skillFx, [{ by: 'peer:me', skill: 'skill_counter_spell', on: 'peer:zz', what: 'skills', countered: ['skill_dodge'], building: false }]);
  eq('counter spell: log', B.logs, ['[T] counter spell peer:me → peer:zz: stripped [skill_dodge], −8 on elem_air (saves 1)']);
}
{
  // Counter Spell keeps a permanent skill; Battle Trance countered collapses to its first card.
  const w = W(withIds({ 'peer:me': st(0, 0, 'player', {}), 'peer:zz': st(0, 1, 'npc_b', {}) }), [
    { actor: 'peer:me', action: 'P', target: { kind: 'character', ref: 'peer:zz' }, skills: ['skill_counter_spell'], trance: null, effect: null },
    { actor: 'peer:zz', action: 'BT', target: null, skills: ['skill_battle_trance', 'skill_taunt'], trance: ['A', 'B'], effect: null },
  ]);
  const B = runPasses(w);
  eq('counter spell vs trance: permanent Taunt kept', w.reveals[1].skills, ['skill_taunt']);
  eq('counter spell vs trance: collapses to A', [B.effAction.get('peer:zz'), B.tranceOpts.has('peer:zz'), w.reveals[1].trance], ['A', false, null]);
  eq('counter spell vs trance: Battle Trance not listed as countered', B.skillFx[0].countered, []);
}
{
  // Bluff (M, rides on EM/EP): the adjacent enemy's action → Empty Posture, its riding instants return.
  const w = W(withIds({ 'peer:me': st(0, 0, 'player', {}), 'peer:zz': st(1, 0, 'npc_b', {}) }), [
    { actor: 'peer:me', action: 'EM', target: null, skills: ['skill_bluff'], trance: null, effect: null },
    { actor: 'peer:zz', action: 'A', target: { kind: 'character', ref: 'peer:me' }, skills: ['skill_powerful_attack', 'skill_ranged_weapon'], trance: null, effect: null },
  ]);
  const B = runPasses(w);
  eq('bluff: A → EP', B.effAction.get('peer:zz'), 'EP');
  eq('bluff: fx (ridden Powerful Attack, permanent kept)', [B.skillFx, w.reveals[1].skills], [[{ by: 'peer:me', skill: 'skill_bluff', on: 'peer:zz', what: 'A', negated: true, ridden: ['skill_powerful_attack'], building: false }], ['skill_ranged_weapon']]);
}
{
  // Intimidation: negate adjacent Attacks first; with nobody attacking, counter a non-permanent skill.
  const w = W(withIds({ 'peer:me': st(0, 0, 'player', {}), 'peer:aa': st(1, 0, 'npc_b', {}), 'peer:bb': st(0, 1, 'npc_b', {}) }), [
    { actor: 'peer:aa', action: 'A', target: { kind: 'character', ref: 'peer:me' }, skills: [], trance: null, effect: null },
    { actor: 'peer:bb', action: 'M', target: null, skills: ['skill_dodge'], trance: null, effect: null },
    { actor: 'peer:me', action: 'EP', target: null, skills: ['skill_intimidation'], trance: null, effect: null },
  ]);
  const B = runPasses(w);
  eq('intimidation: attacker → EP, the skill user untouched', [B.effAction.get('peer:aa'), w.reveals[1].skills], ['EP', ['skill_dodge']]);
  const w2 = W(withIds({ 'peer:me': st(0, 0, 'player', {}), 'peer:bb': st(0, 1, 'npc_b', {}) }), [
    { actor: 'peer:bb', action: 'M', target: null, skills: ['skill_dodge'], trance: null, effect: null },
    { actor: 'peer:me', action: 'EP', target: null, skills: ['skill_intimidation'], trance: null, effect: null },
  ]);
  const B2 = runPasses(w2);
  eq('intimidation: nobody attacks → counters Dodge', B2.skillFx, [{ by: 'peer:me', skill: 'skill_intimidation', on: 'peer:bb', what: 'skills', countered: ['skill_dodge'], building: false }]);
}
{
  // Grapple / Disruption Move negate Posture; Overrun negates the move (noMove) of an adjacent enemy.
  const w = W(withIds({ 'peer:me': st(0, 0, 'player', {}), 'peer:aa': st(1, 0, 'npc_b', {}) }), [
    { actor: 'peer:aa', action: 'M', target: { kind: 'tile', ref: { q: 2, r: 0 } }, skills: [], trance: null, effect: null },
    { actor: 'peer:me', action: 'A', target: { kind: 'character', ref: 'peer:aa' }, skills: ['skill_overrun', 'skill_grapple'], trance: null, effect: null },
  ]);
  const B = runPasses(w);
  eq('overrun: move negated, grapple found no Posture', [[...B.noMove], B.skillFx.map(f => [f.skill, f.what])], [['peer:aa'], [['skill_overrun', 'M']]]);
}
{
  // Dodge: one point off the combat damage I take this action, not one per attacker.
  const w = W(withIds({ 'peer:me': st(0, 0, 'player', {}) }), [{ actor: 'peer:me', action: 'M', target: null, skills: ['skill_dodge'], trance: null, effect: null }]);
  const B = bind(w);
  const damage = new Map([['peer:me', [{ source: 'effect', amount: 2, attacker: 'peer:x' }, { source: 'action', amount: 1, attacker: 'peer:a' }, { source: 'action', amount: 1, attacker: 'peer:b' }]]]);
  skillHook('damage_in', 'skill_dodge', B.skCtx, { damage });
  eq('dodge: 2 attackers × 1 → 0 + 1 (effect damage untouched)', damage.get('peer:me').map(d => d.amount), [2, 0, 1]);
}
{
  // Force Shield: the die comes off the first leg that would land, BEFORE rounding; spent by that.
  const leg = (shield, sum) => skillHook('effect_leg', 'skill_force_shield', null, { shield, sum });
  eq('force shield: Σ16 − die 2 = 14 → 1 (not 2)', [leg(2, 16), roundHalfUp10(leg(2, 16).sum)], [{ shield: 0, sum: 14, spent: 2 }, 1]);
  eq('force shield: Σ14 − die 5 = 9 → 1 (die absorbs before rounding)', roundHalfUp10(leg(5, 14).sum), 1);
  eq('force shield: Σ4 rounds to 0 → not spent, kept for the next leg', leg(3, 4), { shield: 3, sum: 4, spent: 0 });
  const B = bind(W(withIds({ 'peer:me': st(0, 0, 'player', {}) }), [], { perms: { 'peer:me': ['skill_force_shield'] }, power: { 'peer:me': { skill_force_shield: 4 } } }));
  eq('force shield: effect_in = die', skillHook('effect_in', 'skill_force_shield', B.skCtx, { defender: 'peer:me' }), 4);
}
{
  // Taunt / Barricade / Sanctuary / Powerful Attack / Ranged Weapon one-liners.
  const w = W(withIds({ 'peer:a': st(0, 0, 'player', {}), 'peer:t': st(1, 0, 'npc_b', {}), 'peer:d': st(0, 1, 'npc_b', {}) }), [
    { actor: 'peer:a', action: 'A', target: { kind: 'character', ref: 'peer:d' }, skills: ['skill_powerful_attack'], trance: null, effect: null },
    { actor: 'peer:t', action: 'EP', target: null, skills: [], trance: null, effect: null },
  ], { perms: { 'peer:t': ['skill_taunt'], 'peer:d': ['skill_barricade', 'skill_sanctuary', 'skill_ranged_weapon'] } });
  const B = bind(w);
  eq('powerful attack: 1 → 2, 0 stays 0', [skillHook('attack_out', 'skill_powerful_attack', B.skCtx, { attacker: 'peer:a', dmg: 1 }), skillHook('attack_out', 'skill_powerful_attack', B.skCtx, { attacker: 'peer:a', dmg: 0 })], [2, 0]);
  eq('taunt: attacking anyone but the adjacent taunter → 0', [skillHook('attack_target', 'skill_taunt', B.skCtx, { attacker: 'peer:a', defender: 'peer:d' }), skillHook('attack_target', 'skill_taunt', B.skCtx, { attacker: 'peer:a', defender: 'peer:t' })], [true, false]);
  const byActor = new Map([['peer:d', { declared: 'A' }]]);
  eq('barricade A → 0, P passes; sanctuary not resting', [skillHook('defend_in', null, B.skCtx, { code: 'A', defender: 'peer:d', dmg: 2, byActor }), skillHook('defend_in', null, B.skCtx, { code: 'P', defender: 'peer:d', dmg: 2, byActor })], [0, 2]);
  eq('sanctuary resting (no reveal = EP) → 0', skillHook('defend_in', 'skill_sanctuary', B.skCtx, { code: 'P', defender: 'peer:d', dmg: 2, byActor: new Map() }), 0);
  eq('ranged weapon: a Block call without a blocker (the pre-SKR call site) does not score', skillHook('block_in', 'skill_ranged_weapon', B.skCtx, { defender: 'peer:d' }), true);
  eq('sanctuary: leaves on a skill / effect / non-EP, building skill ok', [{ declared: 'EP', skills: [] }, { declared: 'EP', skills: ['skill_x'], buildingSkill: 'skill_x' }, { declared: 'EP', skills: ['skill_dodge'] }, { declared: 'B', skills: [] }, { declared: 'EP', skills: [], effect: {} }, null].map(reveal => skillHook('end_round', 'skill_sanctuary', null, { reveal })), [false, false, true, true, true, false]);
  eq('perm_landing: Sanctuary any → best stat; trance lands only played codes', skillHook('perm_landing', null, { skillData }, { skillIds: ['skill_sanctuary', 'skill_taunt', 'skill_dodge', 'skill_ranged_weapon'], playedCodes: new Set(['B']), stats: { vitality: 5, world: 9, matter: 9, will: 1 } }), [{ id: 'skill_sanctuary', stat: 'world' }, { id: 'skill_taunt', stat: 'vitality' }]);
}

// ---- 2b. worked examples of the SKILL REBALANCE rulings (user, 2026-11-16) ---------------------------------
console.log('-- 2b. worked examples (SKILL REBALANCE rulings 2026-11-16)');
// A one-action duel the way peer.mjs strike() runs once the SKR hunks are in: reach = attack_range, a Block scores
// only against an Attack aimed at the blocker and not when block_in says so (blocker passed), Attack → attack_out
// → attack_target → attack_vs_block (the Block counts as an Empty action), then defend_in. Returns damage taken per unit.
function duel(w) {
  const B = bind(w);
  skillHook('counter_pre', 'skill_counter_spell', B.skCtx); skillHook('negate_action', null, B.skCtx); skillHook('negate_kind', null, B.skCtx);
  const { byActor, codeVs, attacksOn } = finalise(B);
  for (const r of B.revealsThisTurn) r.declared = r.action;
  const taken = Object.fromEntries(w.ids.map(id => [id, 0]));
  const strike = (r, code, defId) => {
    if (!B.enemyOf(r.actor, defId)) return;
    if (B.distBetween(r.actor, defId) > skillHook('attack_range', null, B.skCtx, { attacker: r.actor, code })) return;
    let defCode = codeVs(defId, r.actor);
    if (code === 'B') {
      if (defCode !== 'A' || !attacksOn(byActor.get(defId), r.actor)) return;
      if (skillHook('block_in', null, B.skCtx, { defender: defId, blocker: r.actor })) return;
    }
    if (code === 'A' && defCode === 'B' && skillHook('attack_vs_block', null, B.skCtx, { attacker: r.actor, defender: defId })) defCode = 'EP';
    let dmg = B.edgeDmg(code, defCode);
    if (code === 'A') {
      dmg = skillHook('attack_out', 'skill_powerful_attack', B.skCtx, { attacker: r.actor, dmg });
      if (skillHook('attack_target', 'skill_taunt', B.skCtx, { attacker: r.actor, defender: defId })) dmg = 0;
    }
    dmg = skillHook('defend_in', null, B.skCtx, { code, defender: defId, dmg, byActor });
    taken[defId] += dmg;
  };
  for (const r of B.revealsThisTurn) {
    const t = r.target?.kind === 'character' ? r.target.ref : null;
    if (r.action === 'A' || r.action === 'M') { if (t) strike(r, r.action, t); }
    else if (r.action === 'P' || r.action === 'B') for (const o of B.revealsThisTurn) if (o.actor !== r.actor) strike(r, r.action, o.actor);
  }
  return taken;
}
const rv = (actor, action, target = null, extra = {}) => ({ actor, action, target: target ? { kind: 'character', ref: target } : null, skills: [], trance: null, effect: null, ...extra });
{
  // Force Shield "always power 6" (agent interpretation: no roll, die fixed at 6): it lands with power 6, whatever the
  // stats; Σ16 → 16 − 6 = 10 → 1 (2 without the shield); Σ4 rounds to 0 → not spent; Rule 24 power = 6.
  const land = skillHook('perm_landing', null, { skillData }, { skillIds: ['skill_force_shield', 'skill_taunt'], playedCodes: null, stats: { vitality: 2, world: 20, matter: 20, will: 20 } });
  eq('force shield: lands with power 6 (no roll), vitality its Rule 24 stat; Taunt still rolls', land, [{ id: 'skill_force_shield', stat: 'vitality', power: 6 }, { id: 'skill_taunt', stat: 'vitality' }]);
  const B = bind(W(withIds({ 'peer:me': st(0, 0, 'player', {}) }), [], { perms: { 'peer:me': ['skill_force_shield'] }, power: { 'peer:me': { skill_force_shield: land[0].power } } }));
  const die = skillHook('effect_in', 'skill_force_shield', B.skCtx, { defender: 'peer:me' });
  const leg = skillHook('effect_leg', 'skill_force_shield', null, { shield: die, sum: 16 });
  eq('force shield: Σ16 − 6 = 10 → 1 damage (2 unshielded), spent', [die, leg, roundHalfUp10(leg.sum), roundHalfUp10(16)], [6, { shield: 0, sum: 10, spent: 6 }, 1, 2]);
  eq('force shield: Σ20 − 6 = 14 → 1; Σ4 → 0 lands nothing, the shield waits', [roundHalfUp10(skillHook('effect_leg', 'skill_force_shield', null, { shield: 6, sum: 20 }).sum), skillHook('effect_leg', 'skill_force_shield', null, { shield: 6, sum: 4 })], [1, { shield: 6, sum: 4, spent: 0 }]);
}
{
  // Taunt with 2 allies adjacent: T (taunter) at (0,0) with allies X (1,0) and Y (0,1); enemy E (1,−1) touches T and X,
  // enemy F (−1,1) touches T and Y, enemy G (2,0) touches X only. E → X and F → Y deal 0 (both allies protected);
  // E → T lands; G → X lands (G is not near the taunter).
  const v = withIds({ 'peer:t': st(0, 0, 'player', {}), 'peer:x': st(1, 0, 'player', {}), 'peer:y': st(0, 1, 'player', {}), 'peer:e': st(1, -1, 'npc_b', {}), 'peer:f': st(-1, 1, 'npc_b', {}), 'peer:g': st(2, 0, 'npc_b', {}) });
  const perms = { perms: { 'peer:t': ['skill_taunt'] } };
  const t1 = duel(W(v, [rv('peer:t', 'EP'), rv('peer:e', 'A', 'peer:x'), rv('peer:f', 'A', 'peer:y'), rv('peer:g', 'A', 'peer:x')], perms));
  eq('taunt: E→X 0, F→Y 0 (every ally near the taunter protected), G→X (not near T) 1', [t1['peer:x'], t1['peer:y']], [1, 0]);
  const t2 = duel(W(structuredClone(v), [rv('peer:t', 'EP'), rv('peer:e', 'A', 'peer:t'), rv('peer:f', 'A', 'peer:y')], perms));
  eq('taunt: E→T lands (1), F→Y 0', [t2['peer:t'], t2['peer:y']], [1, 0]);
  // "cannot Block against you": T Attacks E who Blocks — E takes 1 (Block counts as Empty), T takes 0 (the Block does not score).
  const t3 = duel(W(structuredClone(v), [rv('peer:t', 'A', 'peer:e'), rv('peer:e', 'B')], perms));
  eq('taunt: T Attack vs E Block → E 1, T 0 (enemy cannot Block against the taunter)', [t3['peer:e'], t3['peer:t']], [1, 0]);
  const t4 = duel(W(structuredClone(v), [rv('peer:x', 'A', 'peer:e'), rv('peer:e', 'B')], perms));
  eq('taunt: an ally (no Taunt) Attacking a Block → E 0, X 1 (plain matrix)', [t4['peer:e'], t4['peer:x']], [0, 1]);
}
{
  // Ranged Weapon "+1 range" + "no bonuses on nearby enemy": holder H at (0,0); the enemy at distance 2 (2,0) or 1 (1,0).
  const at = (d) => withIds({ 'peer:h': st(0, 0, 'player', {}), 'peer:z': st(d, 0, 'npc_b', {}) });
  const ranged = { perms: { 'peer:h': ['skill_ranged_weapon'] } };
  const vs = (d, code, perms = ranged) => { const t = duel(W(at(d), [rv('peer:h', 'A', 'peer:z'), rv('peer:z', code, code === 'A' || code === 'M' ? 'peer:h' : null)], perms)); return [t['peer:z'], t['peer:h']]; };
  eq('ranged: Attack vs a Block 2 hexes away → enemy 0, me 0 (the Block deals me nothing)', vs(2, 'B'), [0, 0]);
  eq('ranged: Attack vs a Block adjacent → enemy 0, me 1 (its regular damage)', vs(1, 'B'), [0, 1]);
  eq('ranged: Attack from 2 hexes vs Move / Posture / Empty Posture / Attack → 1 dealt, 0 taken (no contact)', ['M', 'P', 'EP', 'A'].map(c => vs(2, c)), [[1, 0], [1, 0], [1, 0], [1, 0]]);
  eq('ranged: without the skill nothing reaches 2 hexes', ['B', 'M', 'P', 'EP', 'A'].map(c => vs(2, c, {})), [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
  eq('ranged: adjacent, a Ranged Attack = a plain Attack (every code)', CODES.map(c => vs(1, c)), CODES.map(c => vs(1, c, {})));
  const B = bind(W(at(1), [rv('peer:h', 'A', 'peer:z'), rv('peer:z', 'B')], ranged));
  eq('ranged: Reaver block_cost of an adjacent Block = 1 (as a plain attacker); attack_range A 2, M 1', [skillHook('block_cost', 'skill_ranged_weapon', B.skCtx, { attacker: 'peer:h', defender: 'peer:z' }), skillHook('attack_range', null, B.skCtx, { attacker: 'peer:h', code: 'A' }), skillHook('attack_range', null, B.skCtx, { attacker: 'peer:h', code: 'M' }), skillHook('attack_range', null, B.skCtx, { attacker: 'peer:z', code: 'A' })], [1, 2, 1, 1]);
}
{
  // Sanctuary: "move around and prepare your hand in the next turns being invincible". S holds it; enemy E attacks S.
  const v = withIds({ 'peer:s': st(0, 0, 'player', {}), 'peer:e': st(1, 0, 'npc_b', {}) });
  const sanct = { perms: { 'peer:s': ['skill_sanctuary'] } };
  const hitWhile = (mine) => duel(W(structuredClone(v), [{ ...rv('peer:s', 'EP'), ...mine }, rv('peer:e', 'A', 'peer:s')], sanct))['peer:s'];
  eq('sanctuary: invincible while Moving / Empty Moving / resting (EP); hit when it Attacks, Blocks, Postures, plays a skill, casts',
    [hitWhile({ action: 'M', target: { kind: 'tile', ref: { q: -1, r: 0 } } }), hitWhile({ action: 'EM', target: { kind: 'tile', ref: { q: -1, r: 0 } } }), hitWhile({}), hitWhile({ action: 'A', target: { kind: 'character', ref: 'peer:e' } }), hitWhile({ action: 'P' }), hitWhile({ skills: ['skill_dodge'] }), hitWhile({ effect: { effect_id: 'effect_t', elements: ['elem_fire'], dmg: true } })],
    [0, 0, 0, 1, 1, 1, 1]);
  const ends = (r) => skillHook('end_round', 'skill_sanctuary', null, { reveal: r });
  eq('sanctuary: stays after M / EM / EP / a building skill / a trance of moves; falls after A, B, P, a skill, a cast, a destroy emission, a trance with A',
    [{ declared: 'M' }, { declared: 'EM' }, { declared: 'EP' }, { declared: 'EP', skills: ['skill_x'], buildingSkill: 'skill_x' }, { declared: 'BT', trance: ['M', 'EP'] }, null,
      { declared: 'A' }, { declared: 'B' }, { declared: 'P' }, { declared: 'M', skills: ['skill_bluff'] }, { declared: 'EP', effect: {} }, { declared: 'EP', destroy: { stat: 'will' } }, { declared: 'BT', trance: ['M', 'A'] }].map(ends),
    [false, false, false, false, false, false, true, true, true, true, true, true, true]);
  const B = bind(W(structuredClone(v), [], sanct));
  eq('sanctuary: effect damage too (code effect) while moving, not once it Attacks', [skillHook('defend_in', 'skill_sanctuary', B.skCtx, { code: 'effect', defender: 'peer:s', dmg: 3, byActor: new Map([['peer:s', { declared: 'M' }]]) }), skillHook('defend_in', null, B.skCtx, { code: 'effect', defender: 'peer:s', dmg: 3, byActor: new Map([['peer:s', { declared: 'A' }]]) })], [0, 3]);
}
{
  // Overrun swap: me (0,0) Attacks aa (1,0) with Overrun → we trade hexes; a moving target is also negated (one fx).
  const v = () => withIds({ 'peer:me': st(0, 0, 'player', {}), 'peer:aa': st(1, 0, 'npc_b', {}), 'peer:bb': st(0, 1, 'npc_b', {}) });
  const ov = (tgt, extra = {}, opts = {}) => { const w = W(v(), [rv('peer:aa', 'EP'), rv('peer:bb', 'M', null, { target: { kind: 'tile', ref: { q: 0, r: 2 } } }), { ...rv('peer:me', 'A', null), target: tgt, skills: ['skill_overrun'], ...extra }], opts); const B = runPasses(w); return [B.swaps, [...B.noMove].sort(), B.skillFx.map(f => [f.skill, f.on, f.what, !!f.negated])]; };
  eq('overrun: Attack on an adjacent enemy (EP) → swap me↔aa, aa cannot move, fx swap (spent)', ov({ kind: 'character', ref: 'peer:aa' }), [[{ by: 'peer:me', on: 'peer:aa' }], ['peer:aa'], [['skill_overrun', 'peer:aa', 'swap', false]]]);
  eq('overrun: on a Moving enemy → swap + Move negated (one fx, negated)', ov({ kind: 'character', ref: 'peer:bb' }), [[{ by: 'peer:me', on: 'peer:bb' }], ['peer:bb'], [['skill_overrun', 'peer:bb', 'M', true]]]);
  eq('overrun: an Attack swinging at a tile → no swap (the auto-target aa still cannot move)', ov({ kind: 'tile', ref: { q: -1, r: 0 } }), [[], ['peer:aa'], []]);
  eq('overrun: before the SKR hunks (no swaps register) → old behaviour, nothing on an EP target', ov({ kind: 'character', ref: 'peer:aa' }, {}, { noRegisters: true }), [[], ['peer:aa'], []]);
}
{
  // Disruption Move: the enemy's Posture (negated) and Empty Posture are played as an Empty Move — nowhere, no emission.
  const v = () => withIds({ 'peer:me': st(0, 0, 'player', {}), 'peer:zz': st(1, 0, 'npc_b', {}), 'peer:al': st(0, 1, 'player', {}) });
  const cast = (inst = false) => ({ effect_id: 'effect_t', elements: ['elem_fire'], dmg: true, is_instant: inst });
  const dm = (tgt, theirs, opts = {}) => { const w = W(v(), [{ ...rv('peer:me', 'EM'), target: { kind: 'character', ref: tgt }, skills: ['skill_disruption_move'] }, { ...rv(tgt, 'EP'), ...theirs }], opts); const B = runPasses(w); const o = w.reveals[1]; return [B.effAction.get(tgt), [...B.noMove], [...B.noEmit], B.skillFx.map(f => [f.what, !!f.negated, f.ridden || null]), o.skills]; };
  eq('disruption: enemy Posture + cast → Empty Move, no move, no emission, Posture negated (riders back)', dm('peer:zz', { action: 'P', effect: cast(), skills: ['skill_dodge'] }), ['EM', ['peer:zz'], ['peer:zz'], [['P', true, ['skill_dodge']]], []]);
  eq('disruption: enemy Empty Posture + cast → Empty Move, emission voided, fx EP (spent), riders keep riding', dm('peer:zz', { effect: cast(), skills: ['skill_dodge'] }), ['EM', ['peer:zz'], ['peer:zz'], [['EP', false, null]], ['skill_dodge']]);
  eq('disruption: bare Empty Posture → Empty Move, nothing stopped (no fx: back to hand)', dm('peer:zz', {}), ['EM', ['peer:zz'], [], [], []]);
  eq('disruption: an instant on the Empty Posture still goes out', dm('peer:zz', { effect: cast(true) }), ['EM', ['peer:zz'], [], [], []]);
  eq('disruption: an ally target is left alone', dm('peer:al', { action: 'P', effect: cast() }), ['P', [], [], [], []]);
  eq('disruption: before the SKR hunks (no noEmit register) → codes only, nothing voided', dm('peer:zz', { action: 'P', effect: cast() }, { noRegisters: true }), ['EM', ['peer:zz'], [], [['P', true, []]], []]);
}
{
  // Powerful Attack: once it paid off (its card did not return), only Attack until the end of the round.
  eq('powerful attack: plan_lock paid → [A], unpaid → null; other skills → null',
    [skillHook('plan_lock', 'skill_powerful_attack', { skillData }, { paid: true }), skillHook('plan_lock', 'skill_powerful_attack', { skillData }, { paid: false }), skillHook('plan_lock', 'skill_dodge', { skillData }, { paid: true })], [['A'], null, null]);
}
{
  // Intimidation: DO NOT CHANGE (user) — still negates every adjacent Attack, then counters a skill.
  eq('intimidation unchanged: SKILL_RULES', SKILL_RULES.skill_intimidation, { action: 'P', permanent: false, negating: true, hooks: ['negate_action'], range: 1, negates: ['A'] });
}

// ---- 3. identity: random worlds -----------------------------------------------------------------------
// ruling 2026-11-16: what keeps a Sanctuary standing (the holder only moved / rested) — no reveal keeps it too.
function keepsSanctuary(rv) {
  if (!rv) return true;
  const c = rv.declared ?? rv.action;
  const played = c === 'BT' ? (rv.trance || []) : [c];
  return played.every(x => ['M', 'EM', 'EP'].includes(x)) && (rv.skills || []).every(id => id === rv.buildingSkill) && !rv.effect && !rv.destroy;
}
console.log('-- 3. identity vs the pre-S1 inline code + the 2026-11-16 ruling references (seeded random cases)');
const N = Number(process.env.SKILLS_CHECK_N || 2000);
const clone = (x) => structuredClone(x);
const tally = {};
const count = (h, ok) => { tally[h] = tally[h] || { n: 0, bad: 0, fired: 0 }; tally[h].n++; if (!ok) tally[h].bad++; };
const fired = (h) => { tally[h].fired++; };
for (let s = 1; s <= N; s++) {
  const w = genWorld(s);
  // passes (counter_pre → negate_action → negate_kind) + trance_assign
  const A = bind(clone(w)); REF_passes(A); const fa = finalise(A); REF_trance(A, fa);
  const Bw = bind(clone(w));
  skillHook('counter_pre', 'skill_counter_spell', Bw.skCtx); skillHook('negate_action', null, Bw.skCtx); skillHook('negate_kind', null, Bw.skCtx);
  const fb = finalise(Bw); skillHook('trance_assign', TRANCE, Bw.skCtx, fb);
  const sa = snap(A), sb = snap(Bw);
  const ok = JSON.stringify(sa) === JSON.stringify(sb);
  for (const h of ['counter_pre', 'negate_action', 'negate_kind', 'trance_assign']) count(h, ok);
  if (sa.skillFx.some(f => f.skill === 'skill_counter_spell') || sa.counterPen.length) fired('counter_pre');
  if (sa.skillFx.some(f => ['skill_bluff', 'skill_intimidation'].includes(f.skill))) fired('negate_action');
  if (sa.skillFx.some(f => ['skill_grapple', 'skill_disruption_move', 'skill_overrun'].includes(f.skill)) || sa.noMove.length || sa.swaps.length) fired('negate_kind');
  if (sa.reveals.some(r => r.vs && r.vs.length)) fired('trance_assign');
  if (!ok) eq(`passes world ${s}`, sb, sa);
  // per-strike hooks on the post-pass world (A's registers)
  const R = rngOf(s + 99991);
  const ids = w.ids;
  for (let k = 0; k < 4; k++) {
    const atk = R.pick(ids), def = R.pick(ids), code = R.pick(['A', 'B', 'P', 'M']), dmg = R.int(4);
    const has = (id, skill) => (A.byActorPre.get(id)?.skills || []).includes(skill);
    // attack_out: `if (dmg >= 1 && has(r.actor, 'skill_powerful_attack')) dmg += 1;`
    let d0 = dmg; if (d0 >= 1 && has(atk, 'skill_powerful_attack')) d0 += 1;
    count('attack_out', eq(`attack_out ${s}/${k}`, skillHook('attack_out', 'skill_powerful_attack', Bw.skCtx, { attacker: atk, dmg }), d0, true)); if (d0 !== dmg) fired('attack_out');
    // attack_target (Taunt)
    const t0 = A.revealsThisTurn.some(t => t.actor !== def && t.actor !== atk && A.enemyOf(atk, t.actor) && A.hasPerm(t.actor, 'skill_taunt') && A.distBetween(atk, t.actor) <= 1);
    count('attack_target', eq(`attack_target ${s}/${k}`, skillHook('attack_target', 'skill_taunt', Bw.skCtx, { attacker: atk, defender: def }), t0, true)); if (t0) fired('attack_target');
    // block_in — ruling 2026-11-16: Ranged Weapon: a Block from beyond contact deals the holder nothing, an adjacent one
    // its regular damage ("no bonuses on nearby enemy"); Taunt: a nearby enemy cannot Block against the taunter.
    // (pre-S1: `if (hasPerm(defId, 'skill_ranged_weapon')) return;` — still what a call without a blocker gives.)
    const blk = R.p(0.1) ? undefined : R.pick(ids);
    const bR = A.hasPerm(def, 'skill_ranged_weapon') && A.distBetween(blk, def) > 1;
    const bT = A.hasPerm(def, 'skill_taunt') && A.enemyOf(blk, def) && A.distBetween(blk, def) <= 1;
    count('block_in', eq(`block_in ${s}/${k}`, [skillHook('block_in', null, Bw.skCtx, { defender: def, blocker: blk }), skillHook('block_in', 'skill_ranged_weapon', Bw.skCtx, { defender: def, blocker: blk }), skillHook('block_in', 'skill_taunt', Bw.skCtx, { defender: def, blocker: blk }), skillHook('block_in', 'skill_ranged_weapon', Bw.skCtx, { defender: def })],
      [bR || bT, bR, bT, A.hasPerm(def, 'skill_ranged_weapon')], true)); if (bR || bT) fired('block_in');
    // block_cost (Reaver pick) — ruling 2026-11-16: a ranged attacker pays an ADJACENT Block like anyone.
    const c0 = A.codeIs(def, 'B') && !(A.hasPerm(atk, 'skill_ranged_weapon') && A.distBetween(atk, def) > 1) ? 1 : 0;
    count('block_cost', eq(`block_cost ${s}/${k}`, skillHook('block_cost', 'skill_ranged_weapon', Bw.skCtx, { attacker: atk, defender: def }), c0, true)); if (c0) fired('block_cost');
    // attack_range — ruling 2026-11-16 (Ranged Weapon "+1 range"): the holder's Attack reaches 2 hexes, all else 1.
    const rc = R.p(0.6) ? 'A' : R.pick(CODES);
    const r0 = rc === 'A' && A.hasPerm(atk, 'skill_ranged_weapon') ? 2 : 1;
    count('attack_range', eq(`attack_range ${s}/${k}`, [skillHook('attack_range', null, Bw.skCtx, { attacker: atk, code: rc }), skillHook('attack_range', 'skill_ranged_weapon', Bw.skCtx, { attacker: atk, code: rc })], [r0, r0], true)); if (r0 > 1) fired('attack_range');
    // attack_vs_block — ruling 2026-11-16 (Taunt): an adjacent enemy's Block does not count against the taunter's Attack.
    const v0 = A.hasPerm(atk, 'skill_taunt') && A.enemyOf(atk, def) && A.distBetween(atk, def) <= 1;
    count('attack_vs_block', eq(`attack_vs_block ${s}/${k}`, skillHook('attack_vs_block', null, Bw.skCtx, { attacker: atk, defender: def }), v0, true)); if (v0) fired('attack_vs_block');
    // defend_in: barricade, then Sanctuary — ruling 2026-11-16: it protects while the holder only moves / rests
    // (M, EM, EP; no skill but a building's, no effect, no destroy emission). (pre-S1: only a declared EP.)
    const byActor = fa.byActor;
    for (const r of byActor.values()) { r.declared = R.p(0.5) ? 'EP' : R.pick([...CODES, 'BT']); if (R.p(0.1)) r.destroy = { stat: 'matter' }; else delete r.destroy; }
    let e0 = dmg; if ((code === 'A' || code === 'B') && A.hasPerm(def, 'skill_barricade')) e0 = 0; if (A.hasPerm(def, 'skill_sanctuary') && keepsSanctuary(byActor.get(def))) e0 = 0;
    count('defend_in', eq(`defend_in ${s}/${k}`, skillHook('defend_in', null, Bw.skCtx, { code, defender: def, dmg, byActor }), e0, true)); if (e0 !== dmg) fired('defend_in');
  }
  // damage_in (Dodge) on a random damage map
  {
    const mk = () => { const R2 = rngOf(s + 7); const m = new Map(); for (const id of ids) if (R2.p(0.7)) m.set(id, Array.from({ length: R2.int(4) }, () => ({ source: R2.pick(['action', 'effect', 'trap']), amount: R2.int(3), attacker: R2.pick(ids) }))); return m; };
    const dA = mk(), dB = mk();
    const has = (id, skill) => (A.byActorPre.get(id)?.skills || []).includes(skill);
    const fromBuilding = (by, skill) => A.byActorPre.get(by)?.buildingSkill === skill;
    const fxA = [];
    for (const [victim, list] of dA) {
      if (!has(victim, 'skill_dodge')) continue;
      const hit = list.find(d => d.source === 'action' && d.amount > 0);
      if (hit) { hit.amount -= 1; fxA.push({ by: victim, skill: 'skill_dodge', on: hit.attacker, what: 'damage', building: fromBuilding(victim, 'skill_dodge') }); }
    }
    const before = Bw.skillFx.length;
    skillHook('damage_in', 'skill_dodge', Bw.skCtx, { damage: dB });
    count('damage_in', eq(`damage_in ${s}`, [[...dB], Bw.skillFx.slice(before)], [[...dA], fxA], true)); if (fxA.length) fired('damage_in');
  }
  // effect_in + effect_leg (Force Shield) — the whole leg loop of the effect-hit pass
  {
    const def = R.pick(ids);
    const legs = Array.from({ length: 1 + R.int(3) }, () => ({ kind: R.pick(['main', 'token']), sum: R.int(40) }));
    let shield = A.hasPerm(def, 'skill_force_shield') ? (A.permPowerOf(def).skill_force_shield || 0) : 0;
    let spent = 0; const outA = [];
    for (const leg of legs) { let sum = leg.sum; if (shield && roundHalfUp10(sum) > 0) { spent = shield; sum = Math.max(0, sum - shield); shield = 0; } outA.push(roundHalfUp10(sum)); }
    let shieldB = skillHook('effect_in', 'skill_force_shield', Bw.skCtx, { defender: def }); let spentB = 0; const outB = [];
    for (const leg of legs) { let sum = leg.sum; if (shieldB) { const fs = skillHook('effect_leg', 'skill_force_shield', Bw.skCtx, { shield: shieldB, sum }); if (fs.spent) spentB = fs.spent; shieldB = fs.shield; sum = fs.sum; } outB.push(roundHalfUp10(sum)); }
    const ok2 = eq(`effect_in/leg ${s}`, [outB, spentB], [outA, spent], true);
    count('effect_in', ok2); count('effect_leg', ok2); if (spent) { fired('effect_in'); fired('effect_leg'); }
  }
  // end_round (Sanctuary leaves) / perm_landing / perm_stats / disposition / rides / plan_target
  {
    const myR = R.p(0.1) ? undefined : { declared: R.p(0.3) ? undefined : R.pick([...CODES, 'BT']), action: R.pick(CODES), trance: R.p(0.4) ? [R.pick(CODES), R.pick(CODES)] : null, skills: R.p(0.5) ? [] : [R.pick(SKILLS_IMPLEMENTED)], buildingSkill: R.p(0.3) ? R.pick(SKILLS_IMPLEMENTED) : undefined, effect: R.p(0.3) ? {} : null, ...(R.p(0.1) ? { destroy: { stat: 'world' } } : {}) };
    // end_round — ruling 2026-11-16: Sanctuary falls on the first action that does not keep it (as defend_in above).
    const l0 = myR !== undefined && !keepsSanctuary(myR);
    count('end_round', eq(`end_round ${s}`, skillHook('end_round', 'skill_sanctuary', { skillData }, { reveal: myR }), !!l0, true)); if (l0) fired('end_round');

    const skillIds = Array.from({ length: R.int(5) }, () => R.pick([...SKILLS_IMPLEMENTED, 'skill_unknown']));
    const playedCodes = R.p(0.5) ? null : new Set(Array.from({ length: R.int(3) }, () => R.pick(CODES)));
    const stats = {}; for (const k of ['vitality', 'world', 'matter', 'will']) if (!R.p(0.05)) stats[k] = R.int(6) * 3;
    const pA = [];
    for (const id of skillIds) {
      const sd = data.skills[id]?.data;
      if (sd?.is_permanent && (!playedCodes || playedCodes.has(sd.action_type))) {
        const st = sd.point_buy_stat === 'any' ? ['vitality', 'world', 'matter', 'will'].sort((a, b) => stats[b] - stats[a])[0] : (sd.point_buy_stat || 'stat_vitality').replace(/^stat_/, '');
        // ruling 2026-11-16: Force Shield "always power 6" — the landing carries the fixed power (no roll).
        pA.push(id === 'skill_force_shield' ? { id, stat: st, power: 6 } : { id, stat: st });
      }
    }
    count('perm_landing', eq(`perm_landing ${s}`, skillHook('perm_landing', null, { skillData }, { skillIds, playedCodes, stats }), pA, true)); if (pA.length) fired('perm_landing');

    const pid = R.pick([...SKILLS_IMPLEMENTED, 'skill_unknown']);
    const permStatsOld = (permId) => { const st = data.skills[permId]?.data?.point_buy_stat; return st === 'any' ? ['vitality', 'world', 'matter', 'will'] : st ? [st.replace(/^stat_/, '')] : ['vitality']; };
    const npcOld = (permId) => { const pb = data.skills[permId]?.data?.point_buy_stat || ''; if (pb === 'any') return ['vitality', 'world', 'matter', 'will']; return pb ? [pb.replace(/^stat_/, '')] : ['vitality']; };
    const ps = skillHook('perm_stats', pid, { skillData });
    count('perm_stats', eq(`perm_stats ${s}`, [ps, ps], [permStatsOld(pid), npcOld(pid)], true)); fired('perm_stats');

    // disposition: the classification part of the Rule 8 loop (peer.mjs 5039-5047).
    const self = R.pick(ids);
    const fx = Array.from({ length: R.int(5) }, () => ({ by: R.pick(ids), skill: R.pick(SKILLS_IMPLEMENTED), on: R.pick(ids), ...(R.p(0.5) ? { ridden: [R.pick(SKILLS_IMPLEMENTED)] } : { countered: [R.pick(SKILLS_IMPLEMENTED)] }), building: R.p(0.2) }));
    const onMe = fx.filter(f => f.on === self);
    for (const id of SKILLS_IMPLEMENTED) {
      let want;
      if (data.skills[id]?.data?.is_permanent) want = 'permanent';
      else if (onMe.some(f => (f.ridden || []).includes(id))) want = 'negated';
      else if (onMe.some(f => (f.countered || []).includes(id))) want = 'countered';
      else if (OLD_NEGATING.has(id)) want = !fx.some(f => f.by === self && f.skill === id && !f.building) ? 'unused' : 'spent';
      else want = 'judge';
      count('disposition', eq(`disposition ${s} ${id}`, skillHook('disposition', id, { skillData }, { fx, self }), want, true));
      if (want === 'spent' || want === 'negated' || want === 'countered') fired('disposition');
    }

    // rides (planning ridesOn, resolver ridesFor, Bard) and plan_target
    const codes = R.p(0.3) ? [R.pick(CODES), R.pick(CODES)] : [R.pick(CODES)];
    for (const req of CODES) {
      const wants = c => codes.includes(c);
      const old = wants(req) || ((req === 'M' || req === 'P') && (wants('EP') || wants('EM')));
      const ok3 = ridesOn(codes, req) === old && skillHook('rides', null, null, { codes, req }) === old && ridesFor({ action: codes[0], trance: codes.length > 1 ? codes : null })(req) === old;
      count('rides', ok3); if (!ok3) eq(`rides ${codes} ${req}`, ridesOn(codes, req), old); if (old) fired('rides');
    }
    const sk = Array.from({ length: R.int(4) }, () => R.pick(SKILLS_IMPLEMENTED));
    const pt = sk.includes('skill_counter_spell');
    count('plan_target', eq(`plan_target ${s}`, skillHook('plan_target', null, null, { skillIds: sk }), pt, true)); if (pt) fired('plan_target');
    // plan_lock — ruling 2026-11-16 (Powerful Attack): only Attack for the rest of the round once it paid off.
    const lid = R.pick([...SKILLS_IMPLEMENTED, 'skill_unknown']), paid = R.p(0.5);
    const lk = lid === 'skill_powerful_attack' && paid ? ['A'] : null;
    count('plan_lock', eq(`plan_lock ${s}`, skillHook('plan_lock', lid, { skillData }, { paid }), lk, true)); if (lk) fired('plan_lock');
  }
}
for (const h of HOOK_NAMES) {
  const t = tally[h];
  if (!t) { fails++; console.log(`FAIL hook ${h}: never exercised`); continue; }
  const ok = t.bad === 0 && t.n >= 300;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${h.padEnd(14)} ${t.n} cases, ${t.fired} where the skill acted, ${t.bad} differ`);
}
console.log(fails ? `${fails} skill check(s) FAILED (${oks} ok)` : `all skill checks passed (${oks} ok)`);
process.exit(fails ? 1 : 0);
