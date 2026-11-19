// game/effect-hooks.mjs — peer-side effect rules as data (MV milestone, 2026-11-17).
//
// effects.mjs#resolveEffect answers "what does this cast do"; the rules that act ACROSS actions — channels (which break,
// which tick), traps (which spring on a step / a declared target, what a sprung trap does, how a laid trap is
// recorded, where a spent trap card goes), the holdings a falling permanent takes with it, and the summon family
// (which creature a stat-buy card will raise, what a paid stat buy does) — used to be inline in peer.mjs. They are
// hooks here: `effectHook(name, ctx, args) → [edit records]` (or a value for summon_plan), each with a JS reference
// (verbatim the old inline logic) and a JsonLogic program in game/effects-data/hooks/<family>.json (schema
// chaosd6.effect-hooks/1, built by tools/out/_mv_build_hooks.mjs; ops below), run on effect-engine.mjs#runProgram. peer.mjs keeps the plumbing:
// it builds the read-only ctx (queries below), calls the hook, and APPLIES the records it gets back in order (card
// moves, entity writes, logs, autosave, resolveEffect of a channel tick, damage through the generic protections).
//
// Engine switch: EFFECT_HOOKS_ENGINE=js|data|shadow, else EFFECT_ENGINE's value (js|data|shadow), default js.
//   shadow — both run; the results must be JSON-identical (stderr `[effect-hooks] SHADOW MISMATCH`, EFFECT_HOOKS_SHADOW_STRICT=1
//   throws); the JS result is used. A data program error / limit → the hook's neutral value ([] / null) and a stderr line.
// Pure module: no peer globals; Node-18 compatible.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProgram, validateLogic, SPECIAL_OPS, PURE_OP_NAMES, EffectEngineLimit, EffectProgramError } from './effect-engine.mjs';
import { disabledCardMoves } from './class-traps.mjs';
import { channelBreaks } from './channel-rule.mjs';   // chaosd6-88's break rule (Reaver / Barbarian ruling 2026-11-17)
import { TRAP_POWER, trapDamageSum, roundHalfUp10 } from './effects.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EFFECT_HOOKS_DIR = path.join(here, 'effects-data', 'hooks');
export const EFFECT_HOOKS_SCHEMA_ID = 'chaosd6.effect-hooks/1';
export const EFFECT_HOOKS_LIMITS = Object.freeze({ maxOps: 100000, maxDepth: 64, maxRange: 256 });
export { TRAP_POWER };   // effects.mjs; the data programs read tables.trap_power (held equal by tools/effect-hooks-check.mjs)

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

const JS_HOOKS = {
  channel_pass: channelPass, channel_land: channelLand,
  trap_enter: trapEnter, trap_targeted: trapTargeted, trap_spring: trapSpring, trap_lay: trapLay, trap_spent: trapSpent,
  perm_falls: permFalls,
  summon_plan: summonPlan, summon_paid: summonPaid,
};
// family file of each hook, its neutral value (a failing data program) and the shape of its result.
export const EFFECT_HOOK_SPECS = Object.freeze({
  channel_pass:  { family: 'channel', result: 'records', ops: ['kept', 'break', 'contact', 'tick'] },
  channel_land:  { family: 'channel', result: 'records', ops: ['release_card', 'channels', 'hold_card'] },
  trap_enter:    { family: 'trap', result: 'list' },
  trap_targeted: { family: 'trap', result: 'records', ops: ['spring'] },
  trap_spring:   { family: 'trap', result: 'records', ops: ['bless', 'damage', 'afflict', 'perm_add'] },
  trap_lay:      { family: 'trap', result: 'records', ops: ['add_trap'] },
  trap_spent:    { family: 'trap', result: 'records', ops: ['trap_remove', 'release_card', 'discard_new', 'drop_perm', 'mine_done', 'world_edit', 'card_to_me'] },
  perm_falls:    { family: 'holdings', result: 'records', ops: ['release_card', 'channels', 'traps'] },
  summon_plan:   { family: 'summon', result: 'plan' },
  summon_paid:   { family: 'summon', result: 'records', ops: ['archive_take', 'ward', 'revive_player', 'summon_add', 'summon_end', 'release_held', 'ward_clear', 'drop_perm', 'spawn'] },
});
export const EFFECT_HOOK_NAMES = Object.freeze(Object.keys(EFFECT_HOOK_SPECS));
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const neutralOfHook = (name) => (EFFECT_HOOK_SPECS[name]?.result === 'plan' ? { op: 'keep' } : []);
export function hookResultOk(name, v) {
  const sp = EFFECT_HOOK_SPECS[name];
  if (!sp) return false;
  if (sp.result === 'plan') return isObj(v) && (v.op === 'keep' || (v.op === 'set' && isObj(v.summon)));
  if (!Array.isArray(v)) return false;
  if (sp.result === 'list') return v.every(isObj);
  return v.every(r => isObj(r) && sp.ops.includes(r.op));
}

// ------------------------------------------------------------ data side
// ctx queries of the hook programs (read-only). W = { c: the peer's ctx }.
export const HOOK_CTX_OPS = {
  ids: (W) => [...W.c.ids()],
  view: (W, [id]) => W.c.view(id) ?? null,
  life_of: (W, [id]) => W.c.lifeOf(id),
  channels_of: (W, [id]) => [...W.c.channelsOf(id)],
  reveal_of: (W, [id]) => W.c.reveal(id) ?? null,
  has_perm: (W, [id, p]) => !!W.c.hasPerm(id, p),
  class_emits: (W, [id, code]) => !!W.c.classEmits(id, code),
  traps: (W) => [...W.c.traps()],
  trap_gone: (W, [id]) => !!W.c.trapGone(id),
  trap_spent: (W, [id]) => !!W.c.trapSpent(id),
  enemy_of: (W, [a, b]) => !!W.c.enemyOf(a, b),
  dist_between: (W, [a, b]) => W.c.distBetween(a, b),
  reveals: (W) => [...W.c.reveals()],
  blessed_every: (W, [id]) => !!W.c.blessedEvery(id),
  stat_of: (W, [id, stat]) => W.c.statOf(id, stat),
  elem_stat: (W, [el]) => W.c.elemStat(el),
  shielded: (W, [id, el]) => !!W.c.shielded(id, el),
  untouchable: (W, [victim, attacker]) => !!W.c.untouchable(victim, attacker),
  ctx_self: (W) => W.c?.self ?? null,
  effect_known: (W, [id]) => !!W.c.effectKnown(id),
  world_edit_gone: (W, [id]) => !!W.c.worldEditGone(id),
  disabled_card_moves: (_W, [ts]) => disabledCardMoves(ts),     // class-traps.mjs (Cleric routing, class rule)
  side_of: (W, [a]) => W.c.sideOf(a),
  hex_distance: (W, [a, b]) => W.c.hexDistance(a, b),
  creature: (W, [cid]) => W.c.creature(cid) ?? null,
  is_string: (_W, [x]) => typeof x === 'string',
  int_q: (_W, [x]) => Number.isInteger(x),
};
export const DENIED_OPS = Object.freeze(['emit', 'put', 'out', 'note', 'return', 'return_empty', 'seed', 'hash_int', 'rng', 'point_buy', 'point_buy_seed']);
const DENY = new Set(DENIED_OPS);
export const HOOK_OPS = Object.freeze([...SPECIAL_OPS.filter(o => !DENY.has(o)), ...PURE_OP_NAMES, ...Object.keys(HOOK_CTX_OPS)].sort());
const KNOWN = new Set(HOOK_OPS);

// validateHookFile(file) → [errors]. A file: {schema, id (= family), version, description?, subs: {name: {params, body}}, tables?, hooks: {name: program}}.
export function validateHookFile(f) {
  const errors = [];
  if (!isObj(f)) return ['file is not an object'];
  if (f.schema !== EFFECT_HOOKS_SCHEMA_ID) errors.push(`schema must be ${EFFECT_HOOKS_SCHEMA_ID}`);
  if (typeof f.id !== 'string' || !/^[a-z0-9_]+$/.test(f.id)) errors.push('id must match [a-z0-9_]+');
  if (typeof f.version !== 'string' || !/^\d+\.\d+\.\d+/.test(f.version)) errors.push('version must be semver');
  const subs = new Map(Object.entries(isObj(f.subs) ? f.subs : {}));
  if (f.subs !== undefined && !isObj(f.subs)) errors.push('subs must be an object');
  for (const [n, s] of subs) {
    if (!Array.isArray(s?.params)) errors.push(`${n}: params must be an array`);
    errors.push(...validateLogic(s?.body, subs, KNOWN).map(e => `${n}: ${e}`));
  }
  if (!isObj(f.hooks)) errors.push('hooks required');
  else for (const [h, prog] of Object.entries(f.hooks)) {
    if (!EFFECT_HOOK_SPECS[h]) { errors.push(`hooks.${h}: unknown hook (${EFFECT_HOOK_NAMES.join(', ')})`); continue; }
    if (EFFECT_HOOK_SPECS[h].family !== f.id) errors.push(`hooks.${h}: belongs to family ${EFFECT_HOOK_SPECS[h].family}`);
    errors.push(...validateLogic(prog, subs, KNOWN).map(e => `hooks.${h}: ${e}`));
  }
  return errors;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
// loadHookFiles(dir | [files]) → Map(hook → {logic, subs, tables, family, version}). Invalid files throw.
export function loadHookFiles(src = process.env.EFFECT_HOOKS_DIR || EFFECT_HOOKS_DIR) {
  const files = Array.isArray(src) ? src : (fs.existsSync(src) ? fs.readdirSync(src).filter(n => n.endsWith('.json')).sort().map(n => readJson(path.join(src, n))) : []);
  const out = new Map();
  for (const f of files) {
    const e = validateHookFile(f);
    if (e.length) throw new Error(`effect hooks ${f?.id}: ${e.join('; ')}`);
    const subs = new Map(Object.entries(f.subs || {}));
    for (const [h, logic] of Object.entries(f.hooks)) {
      if (out.has(h)) throw new Error(`effect hook ${h} defined twice`);
      out.set(h, { logic, subs, tables: f.tables || {}, family: f.id, version: f.version });
    }
  }
  return out;
}
let bundle = null;
export const hookBundle = () => (bundle ||= loadHookFiles());
// runHookData(name, ctx, args[, prog]) → the program's value (throws EffectEngineLimit / EffectProgramError / a ctx query's error).
export function runHookData(name, ctx, args = {}, prog = hookBundle().get(name)) {
  if (!prog) throw new EffectProgramError(`no data program for ${name}`);
  return runProgram(prog.logic, prog.subs, { c: ctx }, { ...args, tables: prog.tables }, { ctxOps: HOOK_CTX_OPS, deny: DENY, limits: EFFECT_HOOKS_LIMITS });
}
export const effectHookJs = (name, ctx, args = {}) => JS_HOOKS[name](ctx, args);

// ------------------------------------------------------------ dispatcher
const ENV = (typeof process !== 'undefined' && process.env) || {};
const pickMode = (x) => (['js', 'data', 'shadow'].includes(x) ? x : null);
export const EFFECT_HOOKS_ENGINE = pickMode(ENV.EFFECT_HOOKS_ENGINE) || pickMode(ENV.EFFECT_ENGINE) || 'js';
export const effectHookStats = { compared: 0, mismatches: 0, errors: 0, unhandled: 0, byHook: {} };
let noted = 0;
const note = (msg) => { effectHookStats.errors++; if (noted++ < 20) console.error(`[effect-hooks] data hook: ${msg}`); };
function dataResult(name, ctx, args) {
  try {
    const v = runHookData(name, ctx, args);
    if (hookResultOk(name, v)) return v;
    note(`${name}: bad result ${JSON.stringify(v)?.slice(0, 200)}`);
  } catch (e) {
    if (!(e instanceof EffectEngineLimit || e instanceof EffectProgramError)) throw e;   // a ctx query threw: as JS
    note(`${name}: ${e.message}`);
  }
  return neutralOfHook(name);
}
// applyHookRecords(records, handlers) — the generic plumbing peer.mjs (and the fixtures of tools/effect-hooks-check.mjs)
// use: each record, in order, goes to handlers[record.op](record); a record without a handler is skipped (counted).
export function applyHookRecords(records, handlers) {
  for (const rec of records || []) {
    const h = handlers[rec?.op];
    if (h) h(rec); else effectHookStats.unhandled++;
  }
}
// effectHook(name, ctx, args) → the hook's records (or summon_plan's {op}); see the header for the engine switch.
export function effectHook(name, ctx, args = {}, mode = EFFECT_HOOKS_ENGINE) {
  const js = JS_HOOKS[name];
  if (!js) throw new Error(`effect-hooks.mjs: unknown hook ${name}`);
  if (mode === 'js') return js(ctx, args);
  if (mode === 'data') return dataResult(name, ctx, args);
  const want = js(ctx, args);
  let got;
  try { got = JSON.stringify(dataResult(name, ctx, args)); } catch (e) { got = `throws ${e?.message}`; }
  effectHookStats.compared++;
  effectHookStats.byHook[name] = (effectHookStats.byHook[name] || 0) + 1;
  const w = JSON.stringify(want);
  if (got !== w) {
    effectHookStats.mismatches++;
    console.error(`[effect-hooks] SHADOW MISMATCH ${name}\n  js:   ${w?.slice(0, 600)}\n  data: ${got?.slice(0, 600)}`);
    if (ENV.EFFECT_HOOKS_SHADOW_STRICT === '1') throw new Error(`effect-hooks shadow mismatch in ${name}`);
  }
  return want;
}
if (EFFECT_HOOKS_ENGINE !== 'js') {
  hookBundle();   // fail fast on a bad file
  if (ENV.EFFECT_HOOKS_SHADOW_REPORT === '1' || ENV.EFFECT_SHADOW_REPORT === '1') process.on('exit', () => console.log(`[effect-hooks] ${EFFECT_HOOKS_ENGINE}: shadow compared ${effectHookStats.compared}, mismatches ${effectHookStats.mismatches}, errors ${effectHookStats.errors} ${JSON.stringify(effectHookStats.byHook)}`));
}
