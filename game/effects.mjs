// Effect engine (Rules 18–21 + the pc overrides). Pure: everything it needs
// comes in through `ctx`, everything it decides goes out as an outcome the
// resolver applies. That keeps it re-runnable for the Rule 8 counterfactuals
// and checkable from tools/effects-check.mjs with the worked examples.

// How many d6 a point-buy rolls: 6·n nearest the stat, ties to more dice
// (Matter 15 → 12 vs 18 → 3 dice; 8 → 1 die; 9 → 2).
export function diceCount(stat) {
  let best = 1;
  for (let n = 1; n <= 4; n++) if (Math.abs(6 * n - stat) <= Math.abs(6 * best - stat)) best = n;
  return best;
}

// Deterministic dice: every peer derives the same roll from the reveal salt.
export function rollDice(seed, n, sha256Hex) {
  const hex = sha256Hex(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push((parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 6) + 1);
  return out;
}

// Rule 20 point-buy: roll, sum must stay ≤ stat; keep the highest die. A failed
// roll means "repeat next action as a contiguous action" — the cast retries.
export function pointBuy(stat, seed, sha256Hex) {
  if (stat < 1) return { fail: false, dice: [], value: 0 };
  const dice = rollDice(seed, diceCount(stat), sha256Hex);
  const sum = dice.reduce((s, d) => s + d, 0);
  return sum > stat ? { fail: true, dice, value: 0 } : { fail: false, dice, value: Math.max(...dice) };
}

// Rule 12 permanents: "you may repeat the roll if unhappy" — re-roll until the
// sum fits, so placing a permanent token never fails.
export function pointBuyPermanent(stat, seed, sha256Hex) {
  for (let i = 0; i < 32; i++) { const pb = pointBuy(stat, `${seed}#${i}`, sha256Hex); if (!pb.fail) return pb.value; }
  return 1;
}

export const roundHalfUp10 = (sum) => Math.round(sum / 10);

// What each effect does once its last element is emitted. Keys:
//   damage: 'delta' (Rule 21 Σ max(0, caster − defender) per element) | 'pointbuy' (one die per element, Σ)
//   scope: everyone (every living unit within `range`, caster included) | target | all_enemies | all_adjacent | all_seen (every creature in view but me) | self | self_or_ally
//   range: contact distance for `target` (default 1)
//   lock: n            → each hit target loses n actions (doubled when the effect is double-cast, Rule 23 ∀)
//   lockRestOfTurn     → hit target loses the remaining actions of this turn (paper: rest of the round)
//   lockNextTurn       → … and the whole next turn
//   tileToken: {kind, elem} → point-buy token on the target's tile (fire token)
//   selfTileTokens: [elem] → point-buy bonus tokens on the caster's tile (Rule 12 tile token)
//   selfShieldTokens: [elem] → point-buy shield tokens on the caster's tile (Rule 20)
//   statPenalty: [elem] → point-buy penalty token on the target's stat for each elem
//   statBonus: [elem]   → point-buy bonus token on the recipient's stat
//   swapTokens          → recipient: lowest stat −die, highest stat +die
//   healDealt / healIfNoTarget / selfDamageEqual / push / teleportSelf / draw
//   permanent           → the card itself stays in front of the deck (flag perms)
//   shieldElem / disableElem / voidThisAction / zone: 'no_damage' — counter effects; apply this action and (but for The Void) last the turn
export const EFFECT_RULES = {
  // damage
  effect_fireball:      { damage: 'delta', scope: 'target', tileToken: { kind: 'fire', elem: 'elem_fire' } },
  effect_lightning:     { damage: 'delta', scope: 'target', lock: 1 },
  effect_sound_wave:    { damage: 'delta', scope: 'target', range: 2 },
  effect_super_force:   { damage: 'delta', scope: 'target', push: 1 },
  effect_throw:         { damage: 'delta', scope: 'target' },
  effect_metaphysics:   { damage: 'delta', scope: 'target' },
  effect_disruption:    { damage: 'delta', scope: 'target' },
  effect_balefire:      { damage: 'delta', scope: 'target' },
  effect_poison:        { damage: 'delta', scope: 'target' },
  effect_space_bending: { damage: 'delta', scope: 'target', lock: 1 },
  effect_turn_life:     { damage: 'delta', scope: 'target', healIfNoTarget: true },
  effect_earthquake:    { damage: 'delta', scope: 'all_enemies' },
  effect_harm:          { damage: 'pointbuy', scope: 'target' },
  effect_mind_blast:    { damage: 'pointbuy', scope: 'target', selfDamageEqual: true },
  effect_drain:         { damage: 'pointbuy', scope: 'target', healDealt: true },
  effect_meteor_shower: { damage: 'pointbuy', scope: 'everyone', range: 10 },   // every unit within 10 hexes — me, allies, enemies
  effect_blizzard:      { damage: 'pointbuy', scope: 'all_enemies', zone: 'no_damage' },
  effect_ice_blast:     { damage: 'pointbuy', scope: 'target', selfTileTokens: ['elem_water', 'elem_fire'], selfShieldTokens: ['elem_water'] },
  effect_dark_matter:   { damage: 'pointbuy', scope: 'target', selfShieldTokens: ['elem_space', 'elem_fire'] },
  // stat tokens
  effect_aging:          { scope: 'target', statPenalty: ['elem_time', 'elem_souls'] },
  effect_combustion:     { scope: 'target', statPenalty: ['elem_harmony'] },
  effect_mutate:         { scope: 'self_or_enemy', swapTokens: true },   // on me: best for me; on an enemy: worst for them
  effect_nature_embrace: { scope: 'self', swapTokens: true },
  effect_potion_brew:    { scope: 'self_or_ally', statBonus: ['elem_vitality'] },
  effect_artifice:       { scope: 'self', statBonus: ['elem_earth'] },
  // locks
  effect_fossilization: { scope: 'target', lockRestOfTurn: true, selfTileTokens: ['elem_earth'], selfShieldTokens: ['elem_earth'] },
  effect_oblivion:      { scope: 'target', lockRestOfTurn: true, lockNextTurn: true, permanent: true },  // the lock holds while the caster's permanent stands
  // permanents read as flags elsewhere
  effect_inner_fire:       { permanent: true },
  effect_summoning:        { permanent: true, statBuy: true, fixedPower: 6 },   // stat buy of Souls → a creature of mine (peer.mjs spawns it)
  effect_invisibility:     { permanent: true },
  effect_emotions_bombard: { permanent: true },
  effect_aura:             { permanent: true },
  effect_haste:            { permanent: true, draw: 1 },
  // defence
  effect_shield:         { shieldElem: true },                        // ∀: becomes a permanent
  effect_disable:        { permanent: true },   // sits on me; fires by itself when an enemy effect is about to hurt me (peer.mjs), ∀: bars everyone
  effect_the_void:       { voidThisAction: true },
  effect_light_darkness: { zone: 'no_damage' },
  // relocation
  effect_teleportation:  { teleportSelf: true },
};

// Effects a character deck may hold: everything with rules, minus creature-innate ones.
export function playableEffects(dataEffects) {
  return Object.keys(EFFECT_RULES).filter(id => dataEffects[id] && dataEffects[id].data?.in_player_deck !== false);
}

// ctx: { me, elemStat(el)→stat key, statFor(id, el), baseStat(id, statKey), lifeOf(id), enemyOf(a,b),
//        dist(a,b), tileOf(id)→{q,r}|null, isFree(q,r), neighbours(q,r), hasPerm(id, perm),
//        shieldedAgainst(id, el), disabledElems(id)→Set, invisible(id), peers()→[ids], sha(seed), actionIndex }
// cast: { actor, effect_id, elements, salt, target: {kind, ref}|null, is_instant, every (∀ double cast), aura (through an Aura ∀),
//         step, of, kept: [die|null per element] } — point-buy damage rolls one element per emission (Rule 20 pc override):
//         the element emitted this step is bought now; a failed roll re-emits that element next action ('retry'), good dice
//         stay banked in `kept`; a cast still emitting returns status 'casting' with the updated bank.
export function resolveEffect(ctx, cast) {
  const rule = EFFECT_RULES[cast.effect_id];
  const out = { status: 'done', hits: [], tokens: [], statTokens: [], locks: [], zones: [], heals: [], permanents: [], moves: [], shieldElem: null, disableElem: null, voidFor: [], draw: 0, every: false, kept: null, summon: null, notes: [] };
  if (!rule) { out.status = 'fizzled'; out.notes.push('no rules for this effect'); return out; }
  const me = cast.actor;
  const myTile = ctx.tileOf(me);
  if (!myTile) { out.status = 'fizzled'; return out; }
  const elems = cast.elements || [];

  // Prohibitions first (Rule 8: applied finally as a replacement).
  const disabled = ctx.disabledElems(me);
  if (elems.some(el => disabled.has(el))) { out.status = 'blocked'; out.notes.push('element disabled'); return out; }
  for (const id of ctx.peers()) {
    if (id !== me && ctx.enemyOf(me, id) && ctx.hasPerm(id, 'effect_emotions_bombard') && ctx.dist(me, id) <= 1) {
      out.status = 'blocked'; out.notes.push('emotions bombard in contact'); return out;
    }
  }

  const seed = (tag) => `${cast.salt || ''}:${cast.effect_id}:${ctx.actionIndex}:${tag}`;
  // One point-buy per request; any failed roll turns the whole cast into a retry.
  let failed = false;
  const buyPB = (stat, tag) => {
    const pb = pointBuy(stat, seed(tag), ctx.sha);
    if (pb.fail) { failed = true; out.notes.push(`point-buy ${tag} failed [${pb.dice.join(',')}] > ${stat}`); }
    return pb;
  };
  const buy = (stat, tag) => buyPB(stat, tag).value;
  const lockN = (rule.lock || 0) * (cast.every ? 2 : 1);
  const lock = (defId) => {
    if (rule.lock) out.locks.push({ on: defId, n: lockN, by: me, effect_id: cast.effect_id });
    if (rule.lockRestOfTurn) out.locks.push({ on: defId, restOfTurn: true, nextTurn: !!rule.lockNextTurn, by: me, effect_id: cast.effect_id });
  };
  const myStat = (el) => ctx.statFor(me, el);
  const emptied = (status) => ({ ...out, status, hits: [], tokens: [], statTokens: [], locks: [], zones: [], heals: [], permanents: [], moves: [], shieldElem: null, disableElem: null, voidFor: [], draw: 0, summon: null });

  // Point-buy damage: buy the element being emitted right now, bank the die.
  const of = cast.of ?? elems.length;
  const step = Math.min(cast.step ?? of, Math.max(1, of));
  const complete = cast.is_instant || step >= of;
  if (rule.damage === 'pointbuy') {
    const kept = Array.isArray(cast.kept) && cast.kept.length === elems.length ? [...cast.kept] : elems.map(() => null);
    // Emission i buys element i; a doubled (∀) cast has one more emission than elements — it re-buys nothing.
    const idx = Math.min(step, elems.length) - 1;
    // Elements up to this one are bought (an earlier emission may have been
    // shared with the cast this one chained onto, so catch up on it here).
    for (let i = 0; i <= idx; i++) {
      if (kept[i] != null) continue;
      const pb = pointBuy(myStat(elems[i]), seed(`${elems[i]}#${i}`), ctx.sha);
      if (pb.fail) { out.notes.push(`point-buy ${elems[i]} failed [${pb.dice.join(',')}] > ${myStat(elems[i])} — re-emit it`); out.kept = kept; return emptied('retry'); }
      kept[i] = pb.value;
    }
    out.kept = kept;
    if (!complete) return emptied('casting');
  }

  // Targets. Aura (Rule: every effect you cast becomes mass) widens a single target.
  const aura = ctx.hasPerm(me, 'effect_aura');
  const range = rule.range || 1;
  const alive = (id) => ctx.lifeOf(id) > 0;
  const declared = cast.target?.kind === 'character' ? cast.target.ref : null;
  const visible = (id) => !ctx.invisible(id);
  const enemiesWithin = (d) => ctx.peers().filter(id => id !== me && alive(id) && visible(id) && ctx.enemyOf(me, id) && ctx.dist(me, id) <= d).sort();
  const deltaSum = (defId) => elems.reduce((s, el) => s + (ctx.shieldedAgainst(defId, el) ? 0 : Math.max(0, myStat(el) - ctx.statFor(defId, el))), 0);
  let recipients = [];
  switch (rule.scope) {
    case 'target': {
      if (aura) { recipients = enemiesWithin(range); break; }
      if (declared && declared !== me && alive(declared) && visible(declared) && ctx.dist(me, declared) <= range) { recipients = [declared]; break; }
      // Rule 15 pc override: the enemy my cast hurts the most (stat gap as the
      // yardstick, for point-buys too), lowest life next.
      recipients = enemiesWithin(range)
        .sort((a, b) => (rule.damage ? deltaSum(b) - deltaSum(a) : 0) || ctx.lifeOf(a) - ctx.lifeOf(b) || a.localeCompare(b))
        .slice(0, 1);
      break;
    }
    case 'all_enemies': recipients = enemiesWithin(1); break;
    case 'all_adjacent': recipients = ctx.peers().filter(id => id !== me && alive(id) && visible(id) && ctx.dist(me, id) <= 1).sort(); break;
    case 'all_seen': recipients = ctx.peers().filter(id => id !== me && alive(id) && visible(id)).sort(); break;
    case 'everyone': recipients = ctx.peers().filter(id => alive(id) && (id === me || visible(id)) && ctx.dist(me, id) <= range).sort(); break;
    case 'self_or_ally': recipients = [declared && declared !== me && alive(declared) && !ctx.enemyOf(me, declared) && ctx.dist(me, declared) <= 1 ? declared : me]; break;
    case 'self_or_enemy': recipients = [declared && declared !== me && alive(declared) && visible(declared) && ctx.enemyOf(me, declared) && ctx.dist(me, declared) <= 1 ? declared : me]; break;
    case 'self': recipients = [me]; break;
    default: recipients = [];
  }
  if (aura && (rule.scope === 'self' || rule.scope === 'self_or_ally')) {
    recipients = [...new Set([...recipients, ...ctx.peers().filter(id => id !== me && alive(id) && !ctx.enemyOf(me, id) && ctx.dist(me, id) <= 1)])].sort();
  }
  // Aura ∀ (Rule 23): this cast reaches everyone it could concern within 10 hexes.
  if (cast.aura) {
    if (['target', 'all_enemies', 'all_adjacent', 'all_seen', 'self_or_enemy'].includes(rule.scope)) recipients = enemiesWithin(10);
    else if (rule.scope === 'self' || rule.scope === 'self_or_ally') recipients = ctx.peers().filter(id => alive(id) && (id === me || visible(id)) && ctx.dist(me, id) <= 10).sort();
  }

  // Stat buy (Summoning): every emission banks my stat for the element (Souls →
  // World); the cast is paid once the bank covers the creature's stat sum
  // (cast.summon.need). No dice, so nothing fails — it only takes longer.
  if (rule.statBuy) {
    const need = Math.max(1, Number(cast.summon?.need) || 0);
    const kept = Array.isArray(cast.kept) ? [...cast.kept] : [];
    while (kept.length < step) kept.push(myStat(elems[0]));
    out.kept = kept;
    const bank = kept.reduce((a, v) => a + (v || 0), 0);
    out.notes.push(`stat buy ${bank}/${need}`);
    if (bank < need) return emptied('casting');
    const sm = cast.summon || {};
    // ∀: the creature in view becomes mine — it has to still be there.
    if (sm.bind && !(alive(sm.bind) && visible(sm.bind) && ctx.dist(me, sm.bind) <= 10)) { out.status = 'fizzled'; out.notes.push('the creature is gone'); return out; }
    out.summon = { owner: me, creature_id: sm.creature_id || null, name: sm.name || null, need, bind: sm.bind || null, archive_card_id: sm.archive_card_id || null };
  }

  // Damage legs (raw sums; the resolver applies Force Shield / tokens / rounding).
  if (rule.damage) {
    const healAlly = rule.healIfNoTarget && declared && declared !== me && alive(declared) && !ctx.enemyOf(me, declared) && ctx.dist(me, declared) <= 1 ? declared : null;
    if (healAlly) recipients = [];
    if (!recipients.length && rule.healIfNoTarget) {
      // Alt: restore life = my Vitality (÷10, capped by the peer at max life) on the ally I pointed at, else on me.
      out.heals.push({ on: healAlly || me, amount: roundHalfUp10(ctx.baseStat(me, 'vitality')) });
    } else if (!recipients.length) {
      out.status = 'fizzled'; out.notes.push('nobody in reach');
    }
    for (const defId of recipients) {
      let main = 0;
      if (rule.damage === 'delta') main = deltaSum(defId);
      else for (let i = 0; i < elems.length; i++) main += ctx.shieldedAgainst(defId, elems[i]) ? 0 : (out.kept[i] || 0);
      const legs = [{ kind: 'main', sum: main }];
      if (rule.tileToken) {
        const v = buy(myStat(rule.tileToken.elem), `token:${defId}`);
        legs.push({ kind: 'token', sum: v });
        const t = ctx.tileOf(defId);
        if (t) out.tokens.push({ kind: rule.tileToken.kind, elem: rule.tileToken.elem, value: v, q: t.q, r: t.r, consumed: true });
      }
      out.hits.push({ victim: defId, legs, healDealt: !!rule.healDealt, selfDamageEqual: !!rule.selfDamageEqual });
      lock(defId);
      if (rule.push) {
        const t = ctx.tileOf(defId);
        if (t) {
          const dq = t.q - myTile.q, dr = t.r - myTile.r;
          const away = { q: t.q + dq, r: t.r + dr };
          if (ctx.isFree(away.q, away.r)) out.moves.push({ who: defId, q: away.q, r: away.r, reason: 'pushed' });
        }
      }
    }
  } else {
    if (rule.lock || rule.lockRestOfTurn) {
      if (!recipients.length) { out.status = 'fizzled'; out.notes.push('nobody in reach'); }
      for (const defId of recipients) lock(defId);
    }
  }
  if (rule.statPenalty) {
    if (!recipients.length) { out.status = 'fizzled'; out.notes.push('nobody in reach'); }
    for (const defId of recipients) for (const el of rule.statPenalty) {
      const v = buy(myStat(el), `pen:${el}:${defId}`);
      if (v > 0) out.statTokens.push({ on: defId, stat: ctx.elemStat(el), elem: el, value: -v, effect_id: cast.effect_id });
    }
  }
  if (rule.statBonus) for (const who of recipients) for (const el of rule.statBonus) {
    const v = buy(myStat(el), `bonus:${el}:${who}`);
    if (v > 0) out.statTokens.push({ on: who, stat: ctx.elemStat(el), elem: el, value: v, effect_id: cast.effect_id });
  }
  // Mutate: one point-buy, two tokens. On myself (or an ally) the big die lifts
  // the SMALLEST stat and the small die dents the BIGGEST (ties: vitality is the
  // smallest, matter the biggest — 10/10/10/10 → +6 Vitality, −2 Matter); on an
  // enemy it is mirrored — big penalty on their biggest, small bonus on their smallest.
  if (rule.swapTokens) for (const who of recipients) {
    const order = ['vitality', 'world', 'will', 'matter'];
    const stats = order.map((k, i) => [k, ctx.baseStat(who, k), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]);
    const [low, high] = [stats[0], stats[stats.length - 1]];
    const pb = buyPB(myStat(elems[0]), `swap:${who}`);
    const big = pb.value, small = pb.fail ? 0 : Math.min(...pb.dice);
    if (big > 0) {
      const hostile = who !== me && ctx.enemyOf(me, who);
      if (hostile) {
        out.statTokens.push({ on: who, stat: high[0], elem: elems[0], value: -big, effect_id: cast.effect_id });
        if (small > 0) out.statTokens.push({ on: who, stat: low[0], elem: elems[0], value: small, effect_id: cast.effect_id });
      } else {
        out.statTokens.push({ on: who, stat: low[0], elem: elems[0], value: big, effect_id: cast.effect_id });
        if (small > 0) out.statTokens.push({ on: who, stat: high[0], elem: elems[0], value: -small, effect_id: cast.effect_id });
      }
    }
  }
  for (const el of rule.selfTileTokens || []) {
    const v = buy(myStat(el), `tile:${el}`);
    if (v > 0) out.tokens.push({ kind: 'bonus', elem: el, value: v, q: myTile.q, r: myTile.r });
  }
  for (const el of rule.selfShieldTokens || []) {
    const v = buy(myStat(el), `shield:${el}`);
    if (v > 0) out.tokens.push({ kind: 'shield', elem: el, value: v, q: myTile.q, r: myTile.r });
  }
  if (rule.zone === 'no_damage') {
    out.zones.push({ q: myTile.q, r: myTile.r });
    for (const n of ctx.neighbours(myTile.q, myTile.r)) out.zones.push({ q: n.q, r: n.r });
  }
  if (rule.voidThisAction) out.voidFor.push(me);
  if (rule.shieldElem) {
    // The element that would hurt me most this round; else the one I am weakest in.
    out.shieldElem = { on: me, elem: ctx.threatElem ? ctx.threatElem(me) : elems[0] };
    if (cast.every) out.permanents.push({ on: me, id: cast.effect_id });   // Rule 23 ∀: a permanent shield
  }
  if (rule.disableElem) {
    // (kept for rules that bar an element at cast time; Disable itself fires on the peer side)
    const tgt = recipients[0];
    const elem = tgt && ctx.castElemOf ? (ctx.castElemOf(tgt) || elems[0]) : elems[0];
    if (cast.every) out.disableElem = { on: '*', elem };
    else if (!tgt) { out.status = 'fizzled'; out.notes.push('nobody in reach'); }
    else out.disableElem = { on: tgt, elem };
  }
  if (rule.teleportSelf) {
    const t = cast.target?.kind === 'tile' ? cast.target.ref : null;
    if (t && ctx.isFree(t.q, t.r)) out.moves.push({ who: me, q: t.q, r: t.r, reason: 'teleported' });
    else { out.status = 'fizzled'; out.notes.push('no free tile target'); }
  }
  if (rule.draw) out.draw = rule.draw;
  if (rule.permanent && out.status === 'done') out.permanents.push({ on: me, id: cast.effect_id });
  out.every = !!cast.every;

  if (failed) {
    // Rule 20: a failed point-buy (token / stat dice, bought at completion) re-emits the last element. Nothing lands.
    return emptied('retry');
  }
  return out;
}
