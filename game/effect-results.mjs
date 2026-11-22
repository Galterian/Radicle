// Effect result toasts (user request 2026-11-17): "If <the penalty> fails I should be notified over the enemy with
// '<effect> failed' vanishing icon + text, otherwise '<effect> success' … also for other effects that give some
// penalty to the enemy." Pure: built on EVERY peer from the outcome its own resolver computed (the same on every
// peer), sent to the local UI only (broadcastUI {kind:'effect_result'}) — no network field, no state-hash input.
//
// Item: { key, effect_id, name, on, by, ok, why, q, r } — `on` is the unit the toast floats over.
// No effect id is named here (effect isolation F8): rules = EFFECT_RULES, ui = EFFECT_UI (the definitions' `ui` block),
// natural permanents by their naturalKind.
import { naturalKind } from './natural-perms.mjs';

// An effect penalises an enemy when its rule (EFFECT_RULES) does one of these to its recipients.
export function isPenaltyRule(rule) {
  if (!rule) return false;
  return !!(rule.lock || rule.lockRestOfTurn || rule.lockNextTurn || rule.statPenalty?.length || rule.banish || rule.possess
    || rule.push || rule.vision || (rule.swapTokens && rule.scope === 'self_or_enemy'));
}

// Damage effects that also get toasts (user ruling 2026-11-18, Blizzard): ui.toast_hits — their hits count as the penalty.
const toastHits = (id, ui) => !!ui?.[id]?.toast_hits;
const toasted = (id, rule, ui) => isPenaltyRule(rule) || toastHits(id, ui);

const WHY = { retry: 'roll failed', fizzled: 'nobody in reach', blocked: 'blocked' };

// outcomes: resolver effectOutcomes [{ actor, eff, oc, bonus?, channel? }]
// opts: { rules, nameOf(effect_id), enemyOf(a, b), targetOf(actor) → id|null (declared character target),
//         autoTarget(actor, range) → id|null (the enemy the engine would aim at), tileOf(id) → {q, r}|null,
//         disableTriggers [{holder, caster, elem, perm}], blessFired [{holder, caster, effect_id}], ui (EFFECT_UI),
//         afflictionsOut [{on, effect_id, by}], tag (turn:round string for the keys) }
export function effectResultsOf(outcomes, opts) {
  const names = new Map((outcomes || []).filter(o => o?.eff?.name).map(o => [o.eff.effect_id, o.eff.name]));
  const { rules = {}, ui = {}, nameOf: nameOf0 = (id) => id, enemyOf = () => true, targetOf = () => null, autoTarget = () => null, tileOf = () => null, tag = '' } = opts || {};
  const nameOf = (id) => names.get(id) || nameOf0(id);   // the revealed card name first
  const items = [];
  const seen = new Set();
  const push = (effect_id, on, by, ok, why) => {
    if (!on) return;
    const key = `${tag}:${effect_id}:${by}:${on}:${ok ? 1 : 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    const t = tileOf(on);
    items.push({ key, effect_id, name: nameOf(effect_id), on, by, ok, ...(why ? { why } : {}), ...(t ? { q: t.q, r: t.r } : {}) });
  };
  for (const { actor, eff, oc, channel } of outcomes || []) {
    const id = eff?.effect_id;
    const rule = rules[id];
    if (!id || !oc || !toasted(id, rule, ui) || oc.status === 'casting') continue;
    if (oc.status === 'done') {
      const victims = new Set([
        ...(toastHits(id, ui) ? (oc.hits || []).map(h => h.victim) : []),
        ...(oc.locks || []).map(l => l.on),
        ...(oc.statTokens || []).filter(t => t.value < 0).map(t => t.on),
        ...(oc.moves || []).filter(m => m.who !== actor).map(m => m.who),
        ...(oc.relocations || []).filter(m => m.who && m.who !== actor).map(m => m.who),
        ...(oc.possess?.bind ? [oc.possess.bind] : []),
        ...(oc.peeks || []).filter(p => p.kind === 'hand').map(p => p.of),
      ].filter(v => v && v !== actor && enemyOf(actor, v)));
      for (const v of [...victims].sort()) push(id, v, actor, true);
      continue;   // done with nobody hurt: an alternative leg (Ageing feature, Space Bending trap, Mutate on me) or a Blessing ∀ (below)
    }
    if (channel) continue;   // a channel tick that did not land is the channel breaking — its own pill says so
    const disabled = (oc.notes || []).some(n => /Disable bars/.test(n));
    const dt = disabled ? (opts?.disableTriggers || []).find(d => d.caster === actor) : null;
    const on = dt?.holder || targetOf(actor) || autoTarget(actor, rule.range || 1) || actor;
    const resisted = (oc.notes || []).some(n => / holds \(| keeps their hand hidden/.test(n));
    push(id, on, actor, false, disabled ? 'Disable' : resisted ? 'resisted' : (WHY[oc.status] || oc.status));
  }
  for (const b of opts?.blessFired || []) push(b.effect_id, b.holder, b.caster, false, 'Blessing ∀');
  for (const d of opts?.disableTriggers || []) if (d.perm) push(d.perm, d.caster, d.holder, true);   // the permanent that stopped it (Disable)
  for (const a of opts?.afflictionsOut || []) push(a.effect_id, a.on, a.by, true);
  return items;
}

// Actions lost at planning to standing permanents (Delay Time, natural Domination, natural Petrify): judged by
// the victim's peer from adjacency; every peer recomputes the same from the action's starting tiles for the toast.
// units: [{ id, foes: [{ id, delay, domination, petrify }] }] (adjacent living enemies; each field = the effect id of the
// permanent doing it — an adjacent_lost standing program / a natural lose_action / a natural stone — or null).
export function plannedLossResults(units, { roundsPerTurn, round, lostToHolders, nameOf = (id) => id, tileOf = () => null, tag = '' }) {
  const items = [];
  for (const u of units || []) {
    const holders = u.foes.filter(f => f.delay || f.domination);
    const lost = lostToHolders(holders.length, roundsPerTurn, round);
    const pet = u.foes.filter(f => f.petrify).map(f => f.id).sort()[0];
    const t = tileOf(u.id);
    const mk = (effect_id, by) => ({ key: `${tag}:${effect_id}:${by}:${u.id}:1`, effect_id, name: nameOf(effect_id), on: u.id, by, ok: true, why: 'action lost', ...(t ? { q: t.q, r: t.r } : {}) });
    if (lost) { const h = holders.map(f => f.id).sort()[0]; const f = u.foes.find(x => x.id === h); items.push(mk(f.delay || f.domination, h)); }
    else if (pet) items.push(mk(u.foes.find(f => f.id === pet).petrify, pet));
  }
  return items;
}

// Monster natural permanents acting on an enemy (user ruling 2026-11-18): Mists (an Attack in contact became an
// Empty Posture), Anger (an aim forced onto the holder), Love / Awe / Fear (damage withheld by an affliction, or a
// new contact affliction). events [{ effect_id, on, by, kind: 'ban'|'aim'|'block'|'afflict' }] → success items.
// event kind → natural kind (natural-perms.mjs) → text.
export const NATURAL_WHY = {
  ban: { no_attack: 'cannot Attack in contact' },
  aim: { only_holder: 'may only aim at it' },
  block: { spare_holder: 'cannot damage it', no_damage: 'cannot damage anyone', only_holder: 'cannot damage others' },
  afflict: { spare_holder: 'afflicted until its tower', no_damage: 'afflicted until its tower', only_holder: 'afflicted until its tower' },
};
export function naturalResults(events, { nameOf = (id) => id, tileOf = () => null, tag = '' } = {}) {
  const items = [], seen = new Set();
  for (const ev of events || []) {
    if (!ev?.effect_id || !ev.on) continue;
    const key = `${tag}:${ev.effect_id}:${ev.by}:${ev.on}:1:${ev.kind || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = tileOf(ev.on);
    const why = NATURAL_WHY[ev.kind]?.[naturalKind(ev.effect_id)] || ev.why || '';
    items.push({ key, effect_id: ev.effect_id, name: nameOf(ev.effect_id), on: ev.on, by: ev.by, ok: true, ...(why ? { why } : {}), ...(t ? { q: t.q, r: t.r } : {}) });
  }
  return items;
}
