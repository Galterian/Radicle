// Monster effect cards (user ruling 2026-11-15: "make the monsters hold in deck 4 effects and cast them" +
// "let the monsters have 2 more random effects, besides the 4 effects mix they have").
// Pure helpers shared by peer.mjs (deck build + npcPlan casting) and tools/monster-deck-check.mjs.
//
// - thematic picks: per creature, chosen once from its stats / tags / name / innate effect and RECORDED in
//   data/creatures.json (`deck_effects`, 4 ids). pickThematicEffects() is the algorithm that produced them
//   (peer.mjs falls back to it when an entry has no deck_effects).
// - random picks: per monster INSTANCE at deck build, deterministic from (map seed, peer label, creature id) so a
//   restart rebuilds the same deck; any playable effect, need not be affordable.
// - casting: npcCastChoice() — which effect card in hand a monster starts casting this action, and at whom.
// Counts and filters are data-driven: data/rules.json rule_monster_deck_effects → data.monster_deck.

import { createHash } from 'node:crypto';
import { EFFECT_BOT } from './effects.mjs';

export const MONSTER_DECK_DEFAULTS = {
  thematic: 4,                 // effect cards chosen per creature (recorded as deck_effects)
  random: 2,                   // extra random playable effects per monster instance
  mix: { damage: 2, defence: 1 },   // thematic mix: 2 damage, 1 defensive, the 4th the best remaining
  max_len: 3,                  // affordable: at most this many elements (emissions)
  min_stat: 10,                // affordable: every element's stat at least this (point-buy rolls succeed)
  min_stat_delta: 15,          // affordable delta damage: mean element stat at least this (else it deals 0 to a hero)
  // Effects the monster AI cannot drive (they need a tile, an attached card, an ally stat, bonus plans, a
  // companion process …) are never thematic picks and are never cast by npcPlan.
  ai_exclude_keys: ['tileTarget', 'trapAttach', 'blessAttach', 'spiritLink', 'possess', 'statBuy', 'phantom', 'trap', 'draw'],
  ai_exclude_effects: [],      // extra ids (data may list some); since F8 an effect says so itself: bot.ai = false
  // npcPlan: chance to start a cast when a sensible one is in hand (the monster's own RNG; plans are committed).
  cast_chance: { damage: 0.6, defence: 0.4, control: 0.45 },
  threat_range: 2,             // a defensive cast is sensible with an enemy this close
  // User ruling 2026-11-15 ("allied npc_a heroes and summons also cast their effect cards → yes"): every bot-driven
  // non-human unit (npc_a / npc_c heroes, companions, summons) casts the effect cards of its OWN deck with the same
  // choice (npcCastChoice ally mode). false = only wild monsters cast.
  ally_cast: true,
  // Ally mode only (user ruling 2026-11-15, "looser threshold for allies and for heal effects"): an allied bot
  // plays the deck a person built, so it casts cheaper-backed cards; the recorded monster deck_effects keep
  // min_stat / min_stat_delta above (affordable() is unchanged).
  ally_min_stat: 8,            // every element's stat at least this
  ally_min_stat_delta: 12,     // delta damage: mean element stat at least this
  heal_ignores_delta: true,    // a heal (Turn Life) is judged on the stat that drives it (Vitality, heal round(Vit/10) ≥ 1), not the delta mean
};

export const ELEM_STAT = { elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' };
// What each effect means to the bots (effect isolation F8, 2026-11-21): the definition's `bot` block — tags / names
// (creature tags and name patterns it suits), defence (the "1 defensive" of the mix), ai: false (bots cannot drive it),
// contact (cast only with an enemy in contact), heals_self (also sensible when I am hurt). effects.mjs#EFFECT_BOT.
const botOf = (id) => EFFECT_BOT[id] || {};
const nameRes = new Map();
const nameHits = (pat, text) => { if (!nameRes.has(pat)) nameRes.set(pat, new RegExp(pat, 'i')); return nameRes.get(pat).test(text); };

export const sha256Hex = (s) => createHash('sha256').update(String(s)).digest('hex');
const frac = (s) => parseInt(sha256Hex(s).slice(0, 8), 16) / 0x100000000;
export const monsterDeckConfig = (d) => ({ ...MONSTER_DECK_DEFAULTS, ...(d || {}), mix: { ...MONSTER_DECK_DEFAULTS.mix, ...(d?.mix || {}) }, cast_chance: { ...MONSTER_DECK_DEFAULTS.cast_chance, ...(d?.cast_chance || {}) } });

// Can the monster AI drive this effect at all?
export function npcCastable(id, rules, cfg = MONSTER_DECK_DEFAULTS) {
  const r = rules[id];
  if (!r || botOf(id).ai === false || (cfg.ai_exclude_effects || []).includes(id)) return false;
  return !cfg.ai_exclude_keys.some(k => r[k]);
}
export const effectKind = (id, rules) => rules[id]?.damage ? 'damage' : botOf(id).defence ? 'defence' : 'control';
// Affordable for these stats: few enough emissions, every element backed by a decent stat, delta damage strong
// enough to hurt. `elements` = the effect's element_cost.
export function affordable(stats, elements, rule, cfg = MONSTER_DECK_DEFAULTS) {
  const els = Array.isArray(elements) ? elements : [];
  if (!els.length || els.length > cfg.max_len) return false;
  const vals = els.map(el => stats?.[ELEM_STAT[el]] ?? 0);
  if (vals.some(v => v < cfg.min_stat)) return false;
  if (rule?.damage === 'delta' && vals.reduce((a, b) => a + b, 0) / vals.length < cfg.min_stat_delta) return false;
  return true;
}
// Ally-mode affordability (npcCastChoice / npcStuckCard with ally = true): ally_min_stat / ally_min_stat_delta, and a
// heal effect (healIfNoTarget) with heal_ignores_delta is affordable when its elements pass ally_min_stat and its
// heal — round(Vitality / 10) — is at least 1. Monsters (ally = false) use affordable() as recorded.
export function affordableFor(stats, elements, rule, cfg = MONSTER_DECK_DEFAULTS, ally = false) {
  if (!ally) return affordable(stats, elements, rule, cfg);
  const heal = !!rule?.healIfNoTarget && cfg.heal_ignores_delta !== false;
  const loose = { ...cfg, min_stat: cfg.ally_min_stat ?? cfg.min_stat, min_stat_delta: heal ? 0 : (cfg.ally_min_stat_delta ?? cfg.min_stat_delta) };
  if (!affordable(stats, elements, rule, loose)) return false;
  return !heal || Math.round((stats?.vitality ?? 0) / 10) >= 1;
}

// The thematic picks of one creature. creature = { id, name, tags, data: { stats, innate_effect } };
// effects = id → { data: { element_cost } }; playable = EFFECTS_IMPLEMENTED; rules = EFFECT_RULES.
export function scoreThematic(creature, id, effects, rules) {
  const els = effects[id]?.data?.element_cost || [];
  const st = creature.data?.stats || {};
  const avg = els.reduce((s, el) => s + (st[ELEM_STAT[el]] ?? 0), 0) / Math.max(1, els.length);
  const b = botOf(id);
  const tagHit = (creature.tags || []).some(t => (b.tags || []).includes(t)) ? 5 : 0;
  const nameHit = (b.names || []).some(pat => nameHits(pat, `${creature.name || ''} ${creature.id}`)) ? 9 : 0;
  const innate = creature.data?.innate_effect === id ? 10 : 0;
  return avg + tagHit + nameHit + innate - (els.length - 1) + frac(`${creature.id}:${id}`);
}
export function pickThematicEffects(creature, effects, playable, rules, cfg = MONSTER_DECK_DEFAULTS) {
  const st = creature.data?.stats || {};
  const pool = [...playable].filter(id => effects[id] && npcCastable(id, rules, cfg) && affordable(st, effects[id].data?.element_cost, rules[id], cfg))
    .map(id => ({ id, kind: effectKind(id, rules), els: effects[id].data.element_cost, score: scoreThematic(creature, id, effects, rules) }));
  const out = [], used = [];
  // Greedy: the best score, minus 3 per element an earlier pick already uses (a varied hand of elements).
  const take = (pred, n) => {
    while (n > 0 && out.length < cfg.thematic) {
      const best = pool.filter(x => !out.includes(x.id) && pred(x))
        .map(x => ({ x, s: x.score - 3 * x.els.filter(el => used.includes(el)).length }))
        .sort((a, b) => (b.s - a.s) || a.x.id.localeCompare(b.x.id))[0];
      if (!best) break;
      out.push(best.x.id); used.push(...best.x.els); n--;
    }
  };
  take(x => x.kind === 'damage', cfg.mix.damage);
  take(x => x.kind === 'defence', cfg.mix.defence);
  take(() => true, cfg.thematic - out.length);
  return out;
}
// The random picks of one monster instance: distinct playable effects not among `exclude`, from a stable seed.
export function pickRandomEffects(seed, playable, exclude, n) {
  const pool = [...playable].filter(id => !exclude.includes(id)).sort();
  const out = [];
  for (let k = 0; out.length < n && pool.length; k++) out.push(pool.splice(parseInt(sha256Hex(`${seed}:${k}`).slice(0, 8), 16) % pool.length, 1)[0]);
  return out;
}
export const monsterDeckSeed = (mapSeed, label, creatureId) => `${mapSeed}:monster-deck:${label}:${creatureId}`;

// npcPlan casting. Pure: everything comes in as plain values.
//   hand: cards ({kind, effect_id, element_cost}); me: { stats, life, lifeMax, permanents: Set|array };
//   foes / friends: [{ peer_id, dist, life, lifeMax?, stats? }] (friends without me, the owner included);
//   rules = EFFECT_RULES; rand() in [0,1) — the unit's own RNG. → { index, effect_id, kind, target: peer_id|null } | null
//   ally: true for an allied bot (npc hero / companion / summon), which also looks after its side:
//     - Turn Life heals the most hurt friend in contact (effects.mjs: a declared ally within 1 is healed, not hit)
//       when that friend is at half life or less, or when no enemy in reach can be hurt;
//     - Meteor Shower (hits everyone within 10) needs more enemies than my side INCLUDING me (owner / allies / me).
export function npcCastChoice({ hand, me, foes, friends = [], rules, cfg = MONSTER_DECK_DEFAULTS, rand = Math.random, ally = false }) {
  const perms = me.permanents instanceof Set ? me.permanents : new Set(me.permanents || []);
  const byDist = [...foes].sort((a, b) => (a.dist - b.dist) || (a.life - b.life) || String(a.peer_id).localeCompare(String(b.peer_id)));
  const cands = [];
  // The most hurt friend in contact (ally mode): lowest life share, then lowest life, then id.
  const share = (p) => (p.life ?? 0) / Math.max(1, p.lifeMax ?? p.life ?? 1);
  const hurtFriend = !ally ? null : friends.filter(p => p.dist <= 1 && (p.life ?? 0) > 0 && p.lifeMax != null && p.life < p.lifeMax)
    .sort((a, b) => (share(a) - share(b)) || (a.life - b.life) || String(a.peer_id).localeCompare(String(b.peer_id)))[0] || null;
  hand.forEach((c, index) => {
    if (c?.kind !== 'effect') return;
    const id = c.effect_id, r = rules[id];
    if (!npcCastable(id, rules, cfg) || !affordableFor(me.stats, c.element_cost, r, cfg, ally)) return;
    if (r.permanent && perms.has(id)) return;             // already standing
    const kind = effectKind(id, rules);
    const range = r.range || 1;
    let target = null, ok = false, value = 0;
    if (r.scope === 'target' || r.scope === 'self_or_enemy' && kind !== 'defence') {
      const inReach = byDist.filter(p => p.dist <= range);
      // Delta damage: only at someone it actually hurts (Σ max(0, mine − theirs) per element, /10 rounded).
      const hurts = (p) => r.damage !== 'delta' || !p.stats || Math.round((c.element_cost || []).reduce((s, el) => s + Math.max(0, (me.stats[ELEM_STAT[el]] ?? 0) - (p.stats[ELEM_STAT[el]] ?? 0)), 0) / 10) > 0;
      const p = inReach.filter(hurts).sort((a, b) => (a.life - b.life) || (a.dist - b.dist) || String(a.peer_id).localeCompare(String(b.peer_id)))[0];
      // Ally: Turn Life on the most hurt friend in contact — when it is at half life or less, or nobody in reach can
      // be hurt and it is worse off than me (with nobody in reach an undeclared Turn Life heals me instead).
      const meWorse = share(me) <= (hurtFriend ? share(hurtFriend) : 1) && me.life < me.lifeMax;
      if (r.healIfNoTarget && hurtFriend && (p ? hurtFriend.life * 2 <= hurtFriend.lifeMax : !meWorse)) { target = hurtFriend.peer_id; ok = true; value = hurtFriend.lifeMax - hurtFriend.life; }
      else if (p) { target = p.peer_id; ok = true; value = 3 - Math.min(2, p.life); }
      else if (r.healIfNoTarget && me.life < me.lifeMax) ok = true;   // Turn Life heals me with nobody in reach
    } else if (r.scope === 'all_enemies' || r.scope === 'all_adjacent') {
      const n = byDist.filter(p => p.dist <= 1).length; ok = n > 0; value = n;
    } else if (r.scope === 'everyone') {
      const reach = r.range || 10;
      const nf = byDist.filter(p => p.dist <= reach).length, na = friends.filter(p => p.dist <= reach).length;
      const mine = na + (ally ? 1 : 0);                               // an ally counts itself on its side too
      ok = nf >= 1 && nf > mine && me.life >= 3; value = nf - mine;   // Meteor Shower hits me and my side too
    } else {
      // self / self_or_ally / no scope: a defensive or control card, sensible with an enemy close.
      const near = byDist.filter(p => p.dist <= cfg.threat_range).length;
      ok = near > 0 && (!botOf(id).contact || byDist.some(p => p.dist <= 1));
      if (botOf(id).heals_self) ok = ok || me.life < me.lifeMax;
      // Ally: a self_or_ally card (Potion Brew) goes on the friend in contact it helps more than me — more hurt
      // (lower life share), or as hurt but weaker (smaller life max). Planning keeps that target in the reveal
      // (peer.mjs effectTakesUnit); effects.mjs lands it on the friend if still allied and within 1, else on me.
      if (ally && r.scope === 'self_or_ally') {
        const f = friends.filter(p => p.dist <= 1 && (p.life ?? 0) > 0 && p.lifeMax != null)
          .sort((a, b) => (share(a) - share(b)) || (a.lifeMax - b.lifeMax) || String(a.peer_id).localeCompare(String(b.peer_id)))[0];
        if (f && (share(f) < share(me) || share(f) === share(me) && f.lifeMax < me.lifeMax) && (near > 0 || f.life < f.lifeMax)) { target = f.peer_id; ok = true; }
      }
      value = near + (me.life < me.lifeMax || target ? 1 : 0);
    }
    if (ok) cands.push({ index, effect_id: id, kind, target, value });
  });
  if (!cands.length) return null;
  // Damage first, then defence, then control; inside a kind the best value, then the hand order.
  const rank = { damage: 0, defence: 1, control: 2 };
  cands.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (b.value - a.value) || (a.index - b.index));
  for (const c of cands) if (rand() < (cfg.cast_chance[c.kind] ?? 0.5)) return { index: c.index, effect_id: c.effect_id, kind: c.kind, target: c.target };
  return null;
}
// A card the monster will never cast from this hand (not AI-castable or not affordable for its stats).
export const npcStuckCard = (c, stats, rules, cfg = MONSTER_DECK_DEFAULTS, ally = false) => c?.kind === 'effect' && (!npcCastable(c.effect_id, rules, cfg) || !affordableFor(stats, c.element_cost, rules[c.effect_id], cfg, ally));
