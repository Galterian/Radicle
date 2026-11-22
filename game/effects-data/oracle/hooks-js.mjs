// The JS reference of the effect hooks — TEST ORACLE (effect isolation F9e, 2026-11-22).
// Moved verbatim from game/effect-hooks.mjs (the pre-MV inline peer.mjs code). The game runs the data programs of
// effects-data/hooks/*.json; effect-hooks.mjs loads this file only under EFFECT_HOOKS_ENGINE / EFFECT_ENGINE = js | shadow,
// and tools/effect-hooks-check.mjs installs it to hold the two equal. Lives in chaosD6-Effects.
import { disabledCardMoves } from '../../world-prims.mjs';
import { channelBreaks } from '../../channel-rule.mjs';
import { TRAP_POWER, trapDamageSum, roundHalfUp10 } from '../../effect-prims.mjs';
export { TRAP_POWER };

// ------------------------------------------------------------ JS reference hooks (the pre-MV inline peer.mjs code)
// ---- channels (general_ux_channeling) ----
// The break rule itself is chaosd6-88's channel-rule.mjs (A/B/M/EM put down, or another element emitted; a Reaver
// Attack / Barbarian Block that emits keeps it, ruling 2026-11-17) — the JS reference calls it; the data program
// (hooks/channel.json ch_breaks) mirrors it and tools/effect-hooks-check.mjs holds the two equal.
// channel_pass — every action, every living unit's channels (sorted ids): a blessed one (stop 'never') ticks while its
// holder permanent stands; another breaks (→ {op:'break'}), is kept by the class exception (→ {op:'kept'}, the peer
// logs it), or, from the action after its cast, re-fires its leg (→ {op:'tick', cast} — the peer resolves the cast).
// 'contact' (Awake, 2026-11-18, chaosd6-1b: "every action until contact"): a non-blessed channel with stop 'contact' or
// effect id effect_awake that did not break ends once its holder stands next to a living enemy (→ {op:'contact'}; the
// peer pushes channelsBroken with why 'contact with an enemy' and logs it). Checked after the break, before the
// cast-action skip (so it fires on the cast action too), then the tick.
// ctx: ids, view, lifeOf, channelsOf, reveal, hasPerm, classEmits, enemyOf, distBetween.
function channelPass(ctx, { turn, action, round }) {
  const out = [];
  for (const id of ctx.ids()) {
    const v = ctx.view(id);
    if (!v || !Number.isInteger(v.tile_q) || ctx.lifeOf(id) <= 0) continue;
    for (const ch of ctx.channelsOf(id)) {
      const sameAction = (ch.startedTurn === turn && ch.startedAction === action);
      const cost = ch.elements?.[0] || null;
      if (ch.stop === 'never') { if (!ctx.hasPerm(id, ch.holder || 'effect_blessing_curse')) continue; }
      else {
        const res = channelBreaks(ctx.reveal(id), cost, (code) => !!ctx.classEmits(id, code));
        if (res.kept) out.push({ op: 'kept', owner: id, effect_id: ch.effect_id });
        if (res.breaks) { out.push({ op: 'break', owner: id, effect_id: ch.effect_id }); continue; }
        if ((ch.stop === 'contact' || ch.effect_id === 'effect_awake') && ctx.ids().some(o => o !== id && ctx.lifeOf(o) > 0 && ctx.enemyOf(id, o) && ctx.distBetween(id, o) <= 1)) {
          out.push({ op: 'contact', owner: id, effect_id: ch.effect_id }); continue;
        }
      }
      if (sameAction) continue;
      out.push({ op: 'tick', owner: id, effect_id: ch.effect_id, target: ch.target, cast: {
        actor: id, effect_id: ch.effect_id, elements: ch.elements, salt: `${ch.salt || ''}:tick:${turn}:${round}`,
        target: ch.target ? { kind: 'character', ref: ch.target } : null,
        is_instant: true, every: false, aura: false,
        step: ch.elements.length, of: ch.elements.length, kept: null, summon: null,
        _channel_tick: true,
      } });
    }
  }
  return out;
}
// channel_land — the channels a cast of mine registers (outcome `channels` on me): a new Blessing replaces the effect
// under the old one (its card → discard), one channel per effect id.  args {channels, mine, self, turn, action}.
function channelLand(_ctx, { channels, mine, self, turn, action }) {
  const out = [];
  let list = mine;
  for (const ch of channels || []) {
    if (ch.on !== self) continue;
    if (ch.holder) for (const old of list.filter(c => c.holder === ch.holder)) out.push({ op: 'release_card', card_id: old.card_id });
    list = list.filter(c => c.effect_id !== ch.effect_id && !(ch.holder && c.holder === ch.holder));
    list = [...list, { effect_id: ch.effect_id, target: ch.target, elements: ch.elements, salt: ch.salt, stop: ch.stop, holder: ch.holder || null, card_id: ch.card_id || null, startedTurn: turn, startedAction: action }];
    out.push({ op: 'channels', list });
    if (ch.card_id) out.push({ op: 'hold_card', card_id: ch.card_id, effect_id: ch.effect_id });
  }
  return out;
}
// ---- traps (Rule 2/4, user spec 2026-10-29, routing ruling 2026-10-30) ----
// trap_enter — the laid traps a step onto (q, r) springs: 'enter' traps there of an enemy owner, not lifted / spent.
function trapEnter(ctx, { who, q, r }) {
  return ctx.traps().filter(tp => tp.trigger === 'enter' && tp.q === q && tp.r === r && tp.owner !== who && ctx.enemyOf(tp.owner, who) && !ctx.trapGone(tp.id) && !ctx.trapSpent(tp.id));
}
// trap_targeted — an enemy who declares the owner of a 'targeted' trap as target while the owner stands on it springs it.
function trapTargeted(ctx) {
  const out = [];
  for (const r of ctx.reveals()) {
    const tgt = r.target?.kind === 'character' ? r.target.ref : null;
    if (!tgt || tgt === r.actor || ctx.lifeOf(r.actor) <= 0 || !ctx.enemyOf(r.actor, tgt)) continue;
    const ov = ctx.view(tgt);
    if (!ov) continue;
    for (const tp of ctx.traps()) if (tp.trigger === 'targeted' && tp.owner === tgt && tp.q === ov.tile_q && tp.r === ov.tile_r && !ctx.trapGone(tp.id)) out.push({ op: 'spring', trap: tp, victim: r.actor });
  }
  return out;
}
// trap_spring — what one sprung trap does: a Blessing ∀ negates it; damage mode Σ max(0, 20 − victim stat) per element
// (shielded elements 0), /10, nothing on an untouchable victim (the peer then lets a shield token absorb it); perm mode
// afflicts the victim and the owner gains the card as a permanent.  ctx: blessedEvery, statOf, elemStat, shielded, untouchable, self.
function trapSpring(ctx, { trap: tp, victim }) {
  if (ctx.blessedEvery(victim)) return [{ op: 'bless' }];
  if (tp.mode === 'damage') {
    const sum = trapDamageSum(tp.elements || [], el => ctx.statOf(victim, ctx.elemStat(el)), el => ctx.shielded(victim, el));
    return [{ op: 'damage', amount: ctx.untouchable(victim, tp.owner) ? 0 : roundHalfUp10(sum) }];
  }
  return [{ op: 'afflict', on: victim, effect_id: tp.effect_id, by: tp.owner }, ...(tp.owner === ctx.self ? [{ op: 'perm_add', id: tp.effect_id }] : [])];
}
// trap_lay — the traps a cast of mine lays (outcome `traps` by me) as my holding records (id = <me>#<action>#trap<n>).
function trapLay(_ctx, { traps, self, action, count }) {
  return (traps || []).filter(tp => tp.by === self).map((tp, k) => ({ op: 'add_trap', trap: { id: `${self.slice(-8)}#${action}#trap${count + k}`, q: tp.q, r: tp.r, effect_id: tp.effect_id, elements: tp.elements, card_id: tp.card_id, power: tp.power, trigger: tp.trigger, mode: tp.mode, holder: tp.holder, ...(tp.library ? { library: true } : {}) } }));
}
// trap_spent — after the run, one spent / disabled trap as seen by me: gone from my holding, its card to my discard (a
// trap under its owner) or to whoever dealt with it (an open-tile damage trap; a Cleric's disabled trap → its `to`);
// a disabled Library trap still lands in my discard as that card; its holder permanent falls; world traps leave a
// world edit (dungeon explored / building trap gone).  ctx: effectKnown(id), worldEditGone(id).
function trapSpent(ctx, { ts, self, turn, action }) {
  const out = [];
  const cardToVictim = ts.disabled ? disabledCardMoves(ts) : (ts.trigger === 'enter' && ts.mode === 'damage');
  if (ts.owner === self) {
    out.push({ op: 'trap_remove', id: ts.id });
    if (ts.mode === 'damage' || ts.disabled) out.push({ op: 'release_card', card_id: ts.card_id, to_discard: !cardToVictim });
    if (ts.disabled && !cardToVictim && !ts.card_id && ctx.effectKnown(ts.effect_id)) out.push({ op: 'discard_new', effect_id: ts.effect_id, by: ts.by });
    if (ts.holder) out.push({ op: 'drop_perm', id: ts.holder });
    out.push({ op: 'mine_done', card_to_victim: cardToVictim });
  }
  const receiver = ts.disabled ? ts.to : ts.victim;
  const isDungeon = String(ts.id).startsWith('dng:');
  if (isDungeon && ts.victim === self) out.push({ op: 'world_edit', replace: true, edit: { id: ts.id, explored: turn, at: action } });
  else if (ts.owner === 'world' && ts.victim === self && !ctx.worldEditGone(ts.id)) out.push({ op: 'world_edit', replace: false, edit: { id: ts.id, gone: true, at: action } });
  if (cardToVictim && receiver === self && receiver !== ts.owner && ctx.effectKnown(ts.effect_id)) out.push({ op: 'card_to_me', effect_id: ts.effect_id, notice: ts.disabled ? 'cleric' : ts.owner === 'world' ? (isDungeon ? 'dungeon' : 'building') : null });
  return out;
}
// ---- holdings ----
// perm_falls — a permanent of mine falls: the effect under it (a Blessing's channel) and a trap it holds (Traps Mastery)
// go with it, their cards to the discard pile.  args {id, channels, traps}.
function permFalls(_ctx, { id, channels, traps }) {
  const out = [];
  for (const ch of (channels || []).filter(c => c.holder === id)) out.push({ op: 'release_card', card_id: ch.card_id });
  out.push({ op: 'channels', list: (channels || []).filter(c => c.effect_id !== id && c.holder !== id) });
  for (const tp of (traps || []).filter(t => t.holder === id)) out.push({ op: 'release_card', card_id: tp.card_id });
  out.push({ op: 'traps', list: (traps || []).filter(t => t.holder !== id) });
  return out;
}
// ---- summons (stat-buy family) ----
const RESURRECT = 'effect_resurrect_death_ward';
const statSum = (p) => (p.stat_vitality || 0) + (p.stat_world || 0) + (p.stat_matter || 0) + (p.stat_will || 0);
// summon_plan — which creature a queued stat-buy card raises (the cast is fixed once it starts). Resurrect: the dead unit
// next to me (right-clicked first, else lowest id), else an archived creature, else a Death Ward on the ally next to me
// (right-clicked first), else pending. Summoning ∀: the nearest visible enemy creature within 10 is bound instead;
// otherwise my archived creature, else the dealt one (a dealt bind / archive pick falls back to the card's creature).
// Golems / Elementals keep the creature they were dealt with.  → {op:'set', summon} | {op:'keep'}.
// args {effect_id, every, self, here: {q, r}, target, side, peers, archived (first creature card or null), dealt}
// ctx: sideOf(alliance), hexDistance(a, b), creature(cid) → {name, stat_sum} | null.
function summonPlan(ctx, { effect_id, every, self, here: at, target, side, peers, archived, dealt }) {
  const here = { tile_q: at.q, tile_r: at.r };
  if (effect_id === RESURRECT) {
    const adj = peers.filter(p => p && p.peer_id !== self && Number.isInteger(p.tile_q) && ctx.hexDistance(here, p) <= 1);
    const dead = adj.filter(p => (p.life ?? 1) <= 0);
    const pick = (typeof target === 'string' && dead.find(p => p.peer_id === target)) || dead.sort((a, b) => a.peer_id.localeCompare(b.peer_id))[0];
    if (pick) return { op: 'set', summon: { revive: pick.peer_id, creature_id: pick.creature_id || null, is_player: !pick.creature_id, name: pick.name, need: statSum(pick) } };
    if (archived) return { op: 'set', summon: { creature_id: archived.creature_id, name: archived.name, need: archived.stat_sum, archive_card_id: archived.card_id } };
    const allies = adj.filter(p => p.life > 0 && ctx.sideOf(p.alliance) === side);
    const ally = (typeof target === 'string' && allies.find(p => p.peer_id === target)) || allies.sort((a, b) => a.peer_id.localeCompare(b.peer_id))[0];
    return { op: 'set', summon: ally ? { ward: ally.peer_id, name: ally.name, need: 0 } : { pending: true, need: 0 } };
  }
  if (effect_id !== 'effect_summoning') return { op: 'keep' };
  if (every) {
    const c = peers.filter(p => p && p.peer_id !== self && p.creature_id && ctx.sideOf(p.alliance) !== side && p.life > 0 && ctx.hexDistance(here, p) <= 10)
      .sort((a, b) => ctx.hexDistance(here, a) - ctx.hexDistance(here, b) || a.peer_id.localeCompare(b.peer_id))[0];
    if (c) return { op: 'set', summon: { bind: c.peer_id, creature_id: c.creature_id, name: c.name, need: statSum(c) } };
  }
  if (archived) return { op: 'set', summon: { creature_id: archived.creature_id, name: archived.name, need: archived.stat_sum, archive_card_id: archived.card_id } };
  if (dealt?.bind || dealt?.archive_card_id) { const cid = dealt.creature_id, cr = ctx.creature(cid); return { op: 'set', summon: { creature_id: cid, name: cr?.name || cid, need: cr?.stat_sum ?? 0 } }; }
  return { op: 'keep' };
}
// summon_paid — a stat buy of mine is paid (outcome `summon`): what happens, in order. The archived card leaves the
// archive; a Death Ward lands; a raised player is back (the permanent is spent); a raised creature / a bound one joins
// my summons; otherwise the creature the permanent held is released, a new Elementals / Golems replaces the earlier one
// of its family (user ruling 2026-11-12), and the creature is spawned. A same-type recast (Golems, Elementals, Summoning,
// Resurrect / Death Ward) while the same permanent stands sends the old card from the holding to the discard pile
// (release_held; user ruling 2026-11-19 — as drop_perm does for another Golems; the new card is still in hand and is held
// after the action). A raised player spends the permanent (dropPermanent releases the card and ends what it held).
// User ruling 2026-11-19 (Resurrect): the recast also ends the creature the previous cast raised (summon_end: an archive
// creature vanishes, a corpse raised in place falls again; its card goes to my archive) — before a Death Ward or a
// raised corpse too, as on the spawn / bind path. User ruling 2026-11-19 (Death Ward): a Resurrect recast also clears
// the Death Ward the earlier cast placed (ward_clear {peers}: the warded ids leave my wards, so wards_csv in my next
// snapshot) — after summon_end / release_held, before the new ward / raised corpse / spawn; a raised player spends the
// permanent instead (dropPermanent clears the wards).  args {perm_id, sm, summons,
// permanents, held, wards} (held: the perm id of each card in my permanents holding; wards: my Death Ward peer ids).
const familyOf = (id) => id.startsWith('effect_elementals') ? 'Elementals' : id.startsWith('effect_golems') ? 'Golems' : null;
function summonPaid(_ctx, { perm_id: permId, sm, summons, permanents, held, wards }) {
  const out = [];
  const recast = (held || []).includes(permId) ? [{ op: 'release_held', perm: permId }] : [];   // ruling 2026-11-19
  const ended = (summons || []).some(x => x.perm === permId) ? [{ op: 'summon_end', perm: permId }] : [];   // ruling 2026-11-19 (Resurrect)
  const cleared = permId === RESURRECT && (wards || []).length > 0 ? [{ op: 'ward_clear', peers: [...wards] }] : [];   // ruling 2026-11-19 (Death Ward)
  if (sm.archive_card_id) out.push({ op: 'archive_take', card_id: sm.archive_card_id });
  if (sm.ward) { out.push(...ended, ...recast, ...cleared, { op: 'ward', peer_id: sm.ward }); return out; }
  if (sm.revive) {
    if (sm.is_player) { out.push({ op: 'revive_player' }); return out; }
    out.push(...ended, ...recast, ...cleared, { op: 'summon_add', summon: { peer_id: sm.revive, creature_id: sm.creature_id, name: sm.name, bound: true, perm: permId, mode: 'revive' } });
    return out;
  }
  out.push(...ended, ...recast, ...cleared);
  if (familyOf(permId)) for (const other of permanents || []) if (other !== permId && familyOf(other) === familyOf(permId)) out.push({ op: 'drop_perm', id: other });
  if (sm.bind) { out.push({ op: 'summon_add', summon: { peer_id: sm.bind, creature_id: sm.creature_id, name: sm.name, bound: true, perm: permId, mode: 'bind' } }); return out; }
  out.push({ op: 'spawn', creature_id: sm.creature_id });
  return out;
}

export const JS_HOOKS = {
  channel_pass: channelPass, channel_land: channelLand,
  trap_enter: trapEnter, trap_targeted: trapTargeted, trap_spring: trapSpring, trap_lay: trapLay, trap_spent: trapSpent,
  perm_falls: permFalls,
  summon_plan: summonPlan, summon_paid: summonPaid,
};
