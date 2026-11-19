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

// general_ux_channeling: a channel permanent's power is the SMALLEST die of its placement roll.
export function pointBuyPermanentMin(stat, seed, sha256Hex) {
  for (let i = 0; i < 32; i++) { const pb = pointBuy(stat, `${seed}#${i}`, sha256Hex); if (!pb.fail) return pb.dice.length ? Math.min(...pb.dice) : 1; }
  return 1;
}

export const roundHalfUp10 = (sum) => Math.round(sum / 10);

// Invisibility (user ruling 2026-11-14): the permanent is destroyed the moment its holder uses Attack or
// Block (a Battle Trance option counts; a Reaver's EP / EM fights as Attack) or starts / goes on casting any
// effect other than Invisibility itself (every emission, instants included). Moving, Posture without a
// cast, Empty Posture / Move, skills and Rule 24 destroy emissions keep it. `rv` = a reveal
// ({action, trance, effect}) or a bonus plan; pure, so every peer agrees.
export function invisibilityBreaks(rv, opts = {}) {
  if (!rv) return false;
  const codes = Array.isArray(rv.trance) && rv.trance.length ? rv.trance : [rv.action];
  if (codes.some(c => c === 'A' || c === 'B')) return true;
  if (opts.reaver && codes.some(c => c === 'EP' || c === 'EM')) return true;
  const eff = rv.effect_id ?? rv.effect?.effect_id ?? null;
  return !!eff && eff !== 'effect_invisibility';
}

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
//   channel: { stop: 'break' } — general_ux_channeling: the effect becomes a temporary permanent that
//     re-fires its (non-permanent, non-emission) leg every subsequent action until the caster breaks
//     concentration (plays A/B/M/EM or emits an element other than the channel's cost element). State
//     lives in entity.channels on peer.mjs; the resolver re-enters in `_channel_tick: true` mode (no
//     new permanent, no new channel, damage/stat/zone/void applied as usual).
//   trap: { trigger: 'targeted'|'enter', mode: 'damage'|'perm' } — the cast leaves the card as a trap under the caster
//     (Rule 2/4, user spec 2026-10-29). Power 20 per element. 'targeted': fires on the first enemy whose reveal targets the
//     owner while the owner stands on it. 'enter': fires on the first enemy stepping onto the tile. 'damage' = Σ max(0, 20 − victim
//     stat) per element, /10; 'perm' = the owner gains the card as a permanent that afflicts the victim while it stands.
//   trapAttach         → the attached card (cast.attach = {effect_id, elements, card_id}) is the trap's payload (Traps Mastery)
//   altTrap            → with nobody in reach, the attached card becomes an 'enter' trap on a random free tile within 10 (Space Bending)
export const TRAP_POWER = 20;
// Map features (general_ux_token_generated, minimal model): a building / artefact is a bonus tile
// token that carries an `item` name — whoever stands on it gets the element's stat bonus.
export const FEATURES = [
  { item: 'Sacred Land', elem: 'elem_souls', value: 6 }, { item: 'Sphere of Fire', elem: 'elem_fire', value: 5 },
  { item: 'Fountain of Vitality', elem: 'elem_vitality', value: 5 }, { item: 'Standing Stones', elem: 'elem_earth', value: 5 },
  { item: 'Wind Shrine', elem: 'elem_air', value: 5 }, { item: 'Clock Tower', elem: 'elem_time', value: 4 },
  { item: 'Rift', elem: 'elem_space', value: 4 }, { item: 'Monastery', elem: 'elem_concentration', value: 5 },
  { item: 'Choir', elem: 'elem_harmony', value: 5 }, { item: 'Spring', elem: 'elem_water', value: 5 },
];
export const ALL_ELEMS = ['elem_vitality', 'elem_souls', 'elem_time', 'elem_space', 'elem_air', 'elem_water', 'elem_earth', 'elem_fire', 'elem_concentration', 'elem_harmony'];
export const trapDamageSum = (elements, statOfVictim, shielded = () => false) =>
  elements.reduce((s, el) => s + (shielded(el) ? 0 : Math.max(0, TRAP_POWER - statOfVictim(el))), 0);

// Hand classes (user rework 2026-11-14: Witch, Priest; reused by anything that makes a unit drop hand cards).
// Deterministic picks from a reveal salt so every peer agrees on WHO; the victim alone knows its hand, so it
// alone applies WHICH cards — still deterministic: card ids sorted, index = sha(seed:k) mod what is left.
export const pickBySalt = (seed, list, sha256Hex) => list.length ? list[parseInt(sha256Hex(seed).slice(0, 8), 16) % list.length] : null;
export function pickHandDiscards(seed, cardIds, n, sha256Hex) {
  const pool = [...cardIds].map(String).sort(), out = [];
  for (let k = 0; k < n && pool.length; k++) out.push(pool.splice(parseInt(sha256Hex(`${seed}:${k}`).slice(0, 8), 16) % pool.length, 1)[0]);
  return out;
}

// Character stat bonus tokens (general_ux_tokens; Artifice, Mutate, a broken Fortress — user ruling 2026-11-14):
// one POSITIVE token per element in a unit's holding — a new one replaces a smaller one of that element, else
// it is dropped (penalties always stack). Pure: → { tokens (new list), placed, replaced (old token | null) }.
export function placeStatBonusToken(tokens, tok) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (!(tok?.value > 0)) return { tokens: [...list, tok], placed: true, replaced: null };
  const same = list.find(x => x.value > 0 && x.elem === tok.elem);
  if (same && same.value >= tok.value) return { tokens: list, placed: false, replaced: null, kept: same };
  return { tokens: [...list.filter(x => x !== same), tok], placed: true, replaced: same || null };
}
// Rule 24 destroy target order (user ruling 2026-11-14): an emission of a stat against an adjacent enemy takes
// 1) its permanents, 2) its character stat bonus tokens (Artifice, Fortress …), 3) the bonus tile tokens under
// it. Stable inside a class (the caller lists them in a deterministic order).
export const RULE24_KIND_RANK = { perm: 0, stat: 1, tile: 2 };
export const rule24Order = (cands) => cands.map((c, i) => [c, i])
  .sort((a, b) => (RULE24_KIND_RANK[a[0].kind] ?? 9) - (RULE24_KIND_RANK[b[0].kind] ?? 9) || a[1] - b[1]).map(x => x[0]);

// Bonus tile token element choice (paper text, user request 2026-11-17): Fossilization "may put an Earth OR
// Vitality permanent bonus token on your tile". The cast's `elem` (a stat-pill click, like Artifice) picks one of
// the listed elements; otherwise the one my stat is higher in (tie: the first). Not an EFFECT_RULES key, so the
// flags (effects-data parity, rebalancing-check RULE_KEYS) stay as they are; effects-data mirrors it in logic.
export const TILE_TOKEN_CHOICE = { effect_fossilization: ['elem_earth', 'elem_vitality'] };
// User ruling 2026-11-18 (Fossilization): "No, the old token stays but you are spending one more round in retrying
// (lock)". A failed tile/shield token roll no longer voids the cast: the lock and the tokens already bought land
// (status 'done'), `out.kept` lists the token slots [value | null] and the peer re-emits the cast's last element
// next action (castStatus 'retry'); that retry emission buys only the owed token(s) and locks nobody ("do retry,
// not lock" — the caster's failed roll is the caster's problem); with nobody in reach it still buys them (no fizzle).
export const TOKEN_RETRY_KEEPS = new Set(['effect_fossilization']);
export const tokenRetryOwed = (effectId, oc) => TOKEN_RETRY_KEEPS.has(effectId) && oc?.status === 'done' && Array.isArray(oc.kept) && oc.kept.some(v => v == null);
export function tileTokenElem(cast, el, myStat) {
  const choice = TILE_TOKEN_CHOICE[cast?.effect_id];
  if (!choice || !choice.includes(el)) return el;
  if (choice.includes(cast.elem)) return cast.elem;
  return choice.reduce((best, e) => (myStat(e) > myStat(best) ? e : best), choice[0]);
}

export const EFFECT_RULES = {
  // damage
  effect_fireball:      { damage: 'delta', scope: 'target', tileToken: { kind: 'fire', elem: 'elem_fire' } },
  effect_lightning:     { damage: 'delta', scope: 'target', lock: 1 },
  effect_sound_wave:    { damage: 'delta', scope: 'target', range: 2 },
  effect_super_force:   { damage: 'delta', scope: 'target', push: 1 },
  effect_throw:         { damage: 'delta', scope: 'target', pullToken: true },   // Force Smash / Pull: steal an adjacent bonus tile token instead when one is in reach
  effect_metaphysics:   { damage: 'delta', scope: 'target', tileTarget: true, surgery: 'unite' },    // no enemy adjacent: move a nearby feature / trap onto the chosen free tile
  effect_disruption:    { damage: 'delta', scope: 'target', tileTarget: true, surgery: 'split' },    // no enemy adjacent: move any visible trap (even under an enemy) onto the chosen free tile
  effect_awake:         { tileTarget: true, surgery: 'awake', permanent: true, channel: { stop: 'break' } },   // (the extra "until contact" stop is keyed on effect_awake in peer.mjs — the validator only bounds stop 'break') move me / an ally in contact / a building or wall within 2 — clicked tile or the most beneficial spot within 10 (game/awake.mjs → cast.awake); channel: a Harmony token each action until contact; ∀ = the permanent stays + the target's stat (peer.mjs)
  effect_balefire:      { damage: 'delta', scope: 'target', permanent: true, fixedPower: 6, draw: 5, completesWithoutTarget: true },   // Balefire(6): +5 cards, every card an instant until the end of my next turn
  effect_poison:        { damage: 'delta', scope: 'target', trap: { trigger: 'targeted', mode: 'damage' } },   // + the card stays as a trap under me
  effect_space_bending: { damage: 'delta', scope: 'target', lock: 1, altTrap: true },                          // nobody in reach → a random trap within 10
  effect_turn_life:     { damage: 'delta', scope: 'target', healIfNoTarget: true },
  effect_earthquake:    { damage: 'delta', scope: 'all_enemies' },
  effect_harm:          { damage: 'pointbuy', scope: 'target', permanent: true, selfShieldTokens: ['elem_vitality'], channel: { stop: 'break' } },
  effect_mind_blast:    { damage: 'pointbuy', scope: 'target', selfDamageEqual: true, tileTarget: true, surgery: 'switch' },   // with a tile chosen: swap everything on my tile with everything on it
  effect_drain:         { damage: 'pointbuy', scope: 'target', healDealt: true },
  effect_meteor_shower: { damage: 'pointbuy', scope: 'everyone', range: 10 },   // every unit within 10 hexes — me, allies, enemies
  effect_blizzard:      { damage: 'pointbuy', scope: 'all_enemies', zone: 'no_damage' },
  effect_ice_blast:     { damage: 'pointbuy', scope: 'target', selfTileTokens: ['elem_water', 'elem_fire'], selfShieldTokens: ['elem_water'] },
  effect_dark_matter:   { damage: 'pointbuy', scope: 'target', selfShieldTokens: ['elem_space', 'elem_fire'] },
  // stat tokens
  effect_aging:          { scope: 'target', statPenalty: ['elem_time', 'elem_souls'], altFeature: true },   // nobody in reach → a random building / artefact on a free tile within 2
  effect_combustion:     { scope: 'target', statPenalty: ['elem_harmony'], permanent: true, channel: { stop: 'break' } },
  effect_mutate:         { scope: 'self_or_enemy', swapTokens: true },   // on me: best for me; on an enemy: worst for them
  effect_nature_embrace: { scope: 'self', swapTokens: true },
  effect_potion_brew:    { scope: 'self_or_ally', statBonus: ['elem_vitality'] },
  effect_artifice:       { scope: 'self', statBonus: ['elem_earth'], tileTarget: true, altTileToken: true },   // with a tile (mine / adjacent): an element bonus token there instead
  // locks
  effect_fossilization: { scope: 'target', lockRestOfTurn: true, selfTileTokens: ['elem_earth'], selfShieldTokens: ['elem_earth'] },
  effect_oblivion:      { scope: 'target', lockRestOfTurn: true, lockNextTurn: true, permanent: true },  // the lock holds while the caster's permanent stands
  // permanents read as flags elsewhere
  effect_inner_fire:       { permanent: true },
  effect_summoning:        { permanent: true, statBuy: true, fixedPower: 6 },   // stat buy of Souls → a creature of mine (peer.mjs spawns it)
  effect_golems_earth:     { permanent: true, statBuy: true, fixedPower: 6 },   // Souls, Harmony in turn → a golem (need 24)
  effect_golems_water:     { permanent: true, statBuy: true, fixedPower: 6 },
  effect_golems_air:       { permanent: true, statBuy: true, fixedPower: 6 },
  effect_elementals_air:   { permanent: true, statBuy: true, fixedPower: 6 },   // Harmony, Concentration in turn → an elemental (need 30)
  effect_elementals_water: { permanent: true, statBuy: true, fixedPower: 6 },
  effect_elementals_earth: { permanent: true, statBuy: true, fixedPower: 6 },
  effect_resurrect_death_ward: { permanent: true, statBuy: true, fixedPower: 6, resurrect: true },   // Vitality → raise the dead unit next to me / spawn an archived creature / Death Ward an ally
  effect_invisibility:     { permanent: true },   // point-buy permanent: hidden from enemies until I Attack / Block / start a cast (peer.mjs invisibleNow)
  effect_emotions_bombard: { permanent: true },
  effect_aura:             { permanent: true },
  effect_haste:            { permanent: true, draw: 1 },
  // defence
  effect_shield:         { shieldElem: true },                        // ∀: becomes a permanent
  effect_disable:        { permanent: true },   // sits on me; fires by itself when an enemy effect is about to hurt me (peer.mjs), ∀: bars everyone
  effect_the_void:       { voidThisAction: true, selfTileTokens: ['elem_concentration'], permanent: true, channel: { stop: 'break' } },
  effect_light_darkness: { zone: 'no_damage', selfTileTokens: ['elem_fire'], permanent: true, channel: { stop: 'break' } },
  // traps (Rule 2/4): the card waits under me; the owner holds the fired perm-traps (Sleep, Confusion) at fixed power 6
  effect_traps_mastery:  { permanent: true, trapAttach: true, fixedPower: 6 },
  effect_sleep:          { trap: { trigger: 'enter', mode: 'perm' }, fixedPower: 6 },       // afflicted enemy cannot cast while in contact with me
  effect_confusion:      { trap: { trigger: 'enter', mode: 'perm' }, fixedPower: 6 },       // afflicted enemy can only Empty Posture
  // relocation
  effect_teleportation:  { teleportSelf: true, tileTarget: true },
  effect_banish:         { scope: 'target', banish: true },                       // beat the target's World (Space, Souls) → 20 hexes away
  // map surgery / meta permanents (user spec 2026-10-29)
  effect_creation:       { obstacle: true, tileTarget: true },                    // an Earth obstacle (5 hp) on an adjacent free tile; enemies may not pass
  effect_delay_time:     { permanent: true },                                     // adjacent enemies lose their last action per holder (peer.mjs planning)
  effect_empower:        { permanent: true },                                     // spent to emit two elements of one cast in one action (peer.mjs planning)
  effect_spirit_link:    { permanent: true, spiritLink: true },                   // an ally's stat is added to mine while it stands (∀: all four)
  effect_blessing_curse: { permanent: true, blessAttach: true },                  // the attached effect fires every action while this stands (an unbreakable channel)
  effect_phantom:        { permanent: true, phantom: true },                      // a copy of me (stats + deck) fights for me; it falls at the first point of damage
  effect_possess_phylactery: { permanent: true, scope: 'self', possess: true, fixedPower: 6 },   // user 2026-11-17: play a creature from my archive (cast.possess) while it stands; empty archive → the Phylactery permanent (click: shatter the nearest enemy's best permanent)
  // scouting
  effect_vision:         { scope: 'target', vision: true, tileTarget: true },     // a tile: reveal the map around it; an enemy: beat their World (Time) → see their hand
  effect_super_sense:    { permanent: true },                                     // see the traps around me; the permanent is spent to evade one point of damage (peer.mjs)
  // monster natural permanents (user rulings 2026-11-15, rule_monster_natural_permanents): never cast — a monster
  // starts with 2 copies of power 6 standing; what they do lives in peer.mjs hooks + game/natural-perms.mjs.
  effect_love:           { permanent: true, fixedPower: 6 },   // an enemy that came in contact cannot damage me until it visits its tower
  effect_awe:            { permanent: true, fixedPower: 6 },   // (same as Love)
  effect_fear:           { permanent: true, fixedPower: 6 },   // … cannot damage anyone until it visits its tower
  effect_anger:          { permanent: true, fixedPower: 6 },   // … in contact with me may only attack / damage me
  effect_domination:     { permanent: true, fixedPower: 6 },   // an enemy in contact loses one action per turn
  effect_petrify:        { permanent: true, fixedPower: 6 },   // an enemy in contact is locked for the rest of the turn
  effect_mists:          { permanent: true, fixedPower: 6 },   // adjacent enemies cannot Attack
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
//
// Engine switch (chaosD6-Effects E1): EFFECT_ENGINE=js (default) | data | shadow.
//   data   → an effect with a definition in game/effects-data/effects/<id>.json (or EFFECT_DEFS_DIR) runs on
//            effect-engine.mjs#resolveEffectData; every other effect stays on resolveEffectJs below.
//   shadow → both engines run; any outcome difference (JSON-identical comparison) is logged, thrown with
//            EFFECT_SHADOW_STRICT=1; the JS outcome is returned. EFFECT_SHADOW_REPORT=1 prints a tally at exit.
const ENGINE_ENV = (typeof process !== 'undefined' && process.env) || {};
export const EFFECT_ENGINE = ['data', 'shadow'].includes(ENGINE_ENV.EFFECT_ENGINE) ? ENGINE_ENV.EFFECT_ENGINE : 'js';
const dataEngine = EFFECT_ENGINE === 'js' ? null : await import('./effect-engine.mjs').then(m => ({ m, defs: m.loadEffectDefs() }));
export const shadowStats = { compared: 0, mismatches: 0, byEffect: {} };
if (dataEngine && ENGINE_ENV.EFFECT_SHADOW_REPORT === '1') process.on('exit', () => console.log(`[effects] ${EFFECT_ENGINE}: ${dataEngine.defs.size} data effects; shadow compared ${shadowStats.compared}, mismatches ${shadowStats.mismatches} ${JSON.stringify(shadowStats.byEffect)}`));
// Foreign (player-branch) effects, E4 (effects-handshake.mjs): a cast whose reveal carried a ref runs the
// pinned definition (`cast.fx.key` = fxKey: effect sha + lib shas) on every peer, whatever EFFECT_ENGINE says.
// A foreign id is added to EFFECT_RULES (flags only, never over a built-in) so peer.mjs / bots read its
// metadata; it is never in playableEffects (data.effects lacks it), so dealing / library picks are unchanged.
// A foreign id cast WITHOUT a ref (bonus plan, channel tick) resolves as "no rules" — the same outcome a peer
// that never learned it computes.
const foreignRuns = new Map();          // fxKey -> (ctx, cast) => outcome
const foreignIds = new Set();           // ids registered by registerForeignEffect (not built-in)
export function registerForeignEffect(key, id, flags, run) {
  foreignRuns.set(key, run);
  if (!EFFECT_RULES[id]) { EFFECT_RULES[id] = { ...(flags || {}) }; foreignIds.add(id); }
}
export const isForeignEffectId = (id) => foreignIds.has(id);
export function resolveEffect(ctx, cast) {
  if (cast?.fx || foreignIds.has(cast?.effect_id)) {
    const run = cast?.fx ? foreignRuns.get(cast.fx.key) : null;
    return run ? run(ctx, cast) : resolveEffectJs(ctx, { ...cast, effect_id: '' });
  }
  const def = dataEngine?.defs.get(cast?.effect_id);
  if (!def) return resolveEffectJs(ctx, cast);
  if (EFFECT_ENGINE === 'data') return dataEngine.m.resolveEffectData(def, ctx, cast);
  const js = resolveEffectJs(ctx, cast);
  let got;
  try { got = JSON.stringify(dataEngine.m.resolveEffectData(def, ctx, cast)); } catch (e) { got = `throws ${e?.message}`; }
  const want = JSON.stringify(js);
  shadowStats.compared++;
  shadowStats.byEffect[cast.effect_id] = (shadowStats.byEffect[cast.effect_id] || 0) + 1;
  if (got !== want) {
    shadowStats.mismatches++;
    console.error(`[effects] SHADOW MISMATCH ${cast.effect_id}\n  js:   ${want}\n  data: ${got}`);
    if (ENGINE_ENV.EFFECT_SHADOW_STRICT === '1') throw new Error(`shadow mismatch on ${cast.effect_id}`);
  }
  return js;
}
export function resolveEffectJs(ctx, cast) {
  const rule = EFFECT_RULES[cast.effect_id];
  const out = { status: 'done', hits: [], tokens: [], statTokens: [], locks: [], zones: [], heals: [], permanents: [], moves: [], shieldElem: null, disableElem: null, voidFor: [], draw: 0, every: false, kept: null, summon: null, channels: [], traps: [], obstacles: [], links: [], pulls: [], relocations: [], peeks: [], possess: null, phantom: false, notes: [], rolls: [] };
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
    out.rolls.push({ elem: tag, dice: [...pb.dice], stat, ok: !pb.fail });
    if (pb.fail) { failed = true; out.notes.push(`point-buy ${tag} failed [${pb.dice.join(',')}] > ${stat}`); }
    return pb;
  };
  const buy = (stat, tag) => buyPB(stat, tag).value;
  const lockN = (rule.lock || 0) * (cast.every ? 2 : 1);
  // Token retry (TOKEN_RETRY_KEEPS, user ruling 2026-11-18 "do retry, not lock"): the retry emission of a cast whose
  // lock already landed (cast.kept = the token slots) only buys the owed token — it locks nobody again.
  const tokKept = TOKEN_RETRY_KEEPS.has(cast.effect_id) && Array.isArray(cast.kept) && cast.kept.length ? cast.kept : null;
  const lock = (defId) => {
    if (tokKept) return;
    if (rule.lock) out.locks.push({ on: defId, n: lockN, by: me, effect_id: cast.effect_id });
    if (rule.lockRestOfTurn) out.locks.push({ on: defId, restOfTurn: true, nextTurn: !!rule.lockNextTurn, by: me, effect_id: cast.effect_id });
  };
  const myStat = (el) => ctx.statFor(me, el);
  const emptied = (status) => ({ ...out, status, hits: [], tokens: [], statTokens: [], locks: [], zones: [], heals: [], permanents: [], moves: [], shieldElem: null, disableElem: null, voidFor: [], draw: 0, summon: null, channels: [], traps: [], obstacles: [], links: [], pulls: [], relocations: [], peeks: [], possess: null, phantom: false });

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
      out.rolls.push({ elem: elems[i], dice: [...pb.dice], stat: myStat(elems[i]), ok: !pb.fail });
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
  // Invisibility (user ruling 2026-11-14): an invisible unit is hidden from its ENEMIES only (allies still
  // see it); another invisible unit sees it (paper text). ctx.invisible(id) is already "invisible this action"
  // (peer.mjs: holds the permanent and its reveal does not break it).
  const visible = (id) => !(ctx.invisible(id) && ctx.enemyOf(me, id)) || ctx.invisible(me);
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
    // Untargeted area (Meteor Shower): nobody is aimed at, so invisible units are hit too (ruling 2026-11-14).
    case 'everyone': recipients = ctx.peers().filter(id => alive(id) && ctx.dist(me, id) <= range).sort(); break;
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
    const sm = cast.summon || {};
    // Resurrect with nothing to aim at (no dead unit, no archived creature, no ally) does nothing.
    if (rule.resurrect && !sm.revive && !sm.creature_id && !sm.ward) { out.status = 'fizzled'; out.notes.push('nothing to raise or ward'); return out; }
    const need = Math.max(sm.ward ? 0 : 1, Number(sm.need) || 0);
    const kept = Array.isArray(cast.kept) ? [...cast.kept] : [];
    // Emission k banks my stat for the card's k-th element (round-robin: Souls, Harmony, Souls, …).
    while (kept.length < step) kept.push(myStat(elems[kept.length % Math.max(1, elems.length)]));
    out.kept = kept;
    const bank = kept.reduce((a, v) => a + (v || 0), 0);
    out.notes.push(`stat buy ${bank}/${need}`);
    if (bank < need) return emptied('casting');
    // ∀: the creature in view becomes mine — it has to still be there.
    if (sm.bind && !(alive(sm.bind) && visible(sm.bind) && ctx.dist(me, sm.bind) <= 10)) { out.status = 'fizzled'; out.notes.push('the creature is gone'); return out; }
    // Resurrect: the dead unit must still lie next to me; a Death Ward needs its ally alive next to me.
    if (sm.revive) {
      const life = ctx.lifeOf(sm.revive), d = ctx.dist(me, sm.revive);
      if (!(life <= 0 && d <= 1)) { out.status = 'fizzled'; out.notes.push(`nothing to raise here (${sm.revive} life ${life}, ${d} away)`); return out; }
      out.notes.push(`raise ${sm.revive} (life ${life}, ${d} away)`);
    }
    if (sm.ward && !(alive(sm.ward) && !ctx.enemyOf(me, sm.ward) && ctx.dist(me, sm.ward) <= 1)) { out.status = 'fizzled'; out.notes.push('no ally to ward'); return out; }
    out.summon = { owner: me, creature_id: sm.creature_id || null, name: sm.name || null, need, bind: sm.bind || null, archive_card_id: sm.archive_card_id || null, revive: sm.revive || null, is_player: !!sm.is_player, ward: sm.ward || null };
  }

  // Force Pull (Throw, user spec 2026-10-29): a bonus tile token on an adjacent tile that is not
  // under an ally is stolen instead of dealing damage — the one whose element I am strongest in;
  // my point-buy die for that element must reach the token's value (destroy rules, but it moves to my tile).
  if (rule.pullToken && ctx.tileTokensAt) {
    const allyTiles = ctx.peers().filter(id => id !== me && alive(id) && !ctx.enemyOf(me, id)).map(id => ctx.tileOf(id)).filter(Boolean);
    const cands = ctx.neighbours(myTile.q, myTile.r)
      .filter(t => !allyTiles.some(a => a.q === t.q && a.r === t.r))
      .flatMap(t => ctx.tileTokensAt(t.q, t.r).filter(tk => tk.kind === 'bonus' && tk.owner !== me))
      .sort((a, b) => myStat(b.elem) - myStat(a.elem) || String(a.id).localeCompare(String(b.id)));
    if (cands.length) {
      const tk = cands[0];
      const pb = buyPB(myStat(tk.elem), `pull:${tk.id}`);
      if (!pb.fail) {
        if (pb.value >= tk.value) { out.pulls.push({ by: me, token_id: tk.id, owner: tk.owner, elem: tk.elem, value: tk.value, item: tk.item || null, q: myTile.q, r: myTile.r }); out.notes.push(`pulled ${tk.item || tk.elem} (${tk.value}) with a ${pb.value}`); }
        else out.notes.push(`pull failed: die ${pb.value} < token ${tk.value}`);
        recipients = [];   // the Pull replaces the Smash
      }
    }
  }
  // Artifice alt (user spec 2026-10-29): a tile (mine or adjacent) was chosen → an element bonus token
  // there (cast.elem from the stat click, else a random element), bought with my stat; no holding token.
  let artificeTile = null;
  if (rule.altTileToken && cast.target?.kind === 'tile') {
    const t = cast.target.ref;
    const hd = Math.max(Math.abs(myTile.q - t.q), Math.abs(myTile.r - t.r), Math.abs((myTile.q + myTile.r) - (t.q + t.r)));
    if (hd <= 1) {
      const el = ALL_ELEMS.includes(cast.elem) ? cast.elem : ALL_ELEMS[parseInt(ctx.sha(seed('artifice')).slice(0, 8), 16) % ALL_ELEMS.length];
      const v = buy(myStat(el), `artifice:${el}`);
      if (v > 0) out.tokens.push({ kind: 'bonus', elem: el, value: v, q: t.q, r: t.r });
      artificeTile = t; recipients = [];
    }
  }
  // Map surgery (user spec 2026-10-29). Everything on a tile = the unit standing there (out.moves),
  // the bonus tokens / features (relocations kind 'token'), the traps ('trap') and obstacles ('obstacle');
  // each relocation is applied by the thing's owner, so every peer derives the same map.
  let surgeryDone = false;
  // Awake (user request 2026-11-17): the resolver's plan (game/awake.mjs → cast.awake, built on every peer from the
  // same view) says what moves where — a unit (me / an ally in contact) or a building near me. 'none' = nothing can.
  // Awake channel (user ruling 2026-11-18, paper "Channel: draw a Harmony token every action until contact"): each tick
  // (every action after the cast while the channel stands — peer.mjs breaks it on A/B/M/EM, another element, or
  // contact with an enemy) puts a Harmony bonus token on my tile, bought with my Will; a failed roll = no token
  // this action (the channel goes on). A tick moves nothing.
  const awakeTick = rule.surgery === 'awake' && !!cast._channel_tick;
  if (awakeTick) {
    const st = myStat('elem_harmony'), pb = pointBuy(st, seed('awake:elem_harmony'), ctx.sha);
    out.rolls.push({ elem: 'awake:elem_harmony', dice: [...pb.dice], stat: st, ok: !pb.fail });
    if (!pb.fail && pb.value > 0) out.tokens.push({ kind: 'bonus', elem: 'elem_harmony', value: pb.value, q: myTile.q, r: myTile.r });
    out.notes.push(pb.fail ? 'awake channel: the Harmony roll failed' : `awake channel: Harmony token ${pb.value}`);
    surgeryDone = true;
  }
  const awakePlanned = !awakeTick && rule.surgery === 'awake' && typeof cast.awake?.kind === 'string';
  if (awakePlanned) {
    const p = cast.awake;
    if (p.kind === 'unit' && p.who) {
      out.moves.push({ who: p.who, q: p.q, r: p.r, reason: 'awakened' });
      out.notes.push(`awake moves ${p.who} to (${p.q},${p.r}) [${p.how}, gain ${p.gain}]`);
      surgeryDone = true;
    } else if (p.kind === 'building' && p.from) {
      out.relocations.push({ kind: 'building', owner: 'world', id: `bld:${p.from.q},${p.from.r}`, label: p.label, by: me, from: { q: p.from.q, r: p.from.r }, q: p.q, r: p.r });
      out.notes.push(`awake moves the ${p.label} (${p.from.q},${p.from.r}) to (${p.q},${p.r}) [${p.how}, gain ${p.gain}]`);
      surgeryDone = true;
    } else if (p.kind === 'wall' && p.reloc && p.from) {
      // A wall token (Creation / building-wall obstacle: kind 'obstacle', applied by its owner) or a labyrinth wall
      // (kind 'wall', world edits by me) — awake.mjs builds the relocation itself.
      out.relocations.push({ ...p.reloc });
      out.notes.push(`awake moves the ${p.label} (${p.from.q},${p.from.r}) to (${p.q},${p.r}) [${p.how}, gain ${p.gain}]`);
      surgeryDone = true;
    } else { out.status = 'fizzled'; out.notes.push(`awake: ${p.why || 'nothing can move'}`); }
  }
  if (rule.surgery && !awakePlanned && !awakeTick && cast.target?.kind === 'tile' && ctx.tileTokensAt && ctx.trapsAt) {
    const hd = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((a.q + a.r) - (b.q + b.r)));
    const dest = cast.target.ref;
    const unitAt = (q, r) => ctx.peers().find(id => alive(id) && (t => t && t.q === q && t.r === r)(ctx.tileOf(id))) || null;
    const thingsAt = (q, r) => [
      ...ctx.tileTokensAt(q, r).filter(t => t.kind === 'bonus').map(t => ({ kind: 'token', owner: t.owner, id: t.id, label: t.item || t.elem, by: me })),
      ...ctx.trapsAt(q, r).map(t => ({ kind: 'trap', owner: t.owner, id: t.id, label: t.effect_id, by: me })),
      ...(ctx.obstacleAt && ctx.obstacleAt(q, r) ? [{ kind: 'obstacle', owner: ctx.obstacleAt(q, r).owner, id: ctx.obstacleAt(q, r).id, label: 'obstacle', by: me }] : []),
    ];
    const enemyAdjacent = enemiesWithin(1).length > 0;
    const destFree = ctx.isFree(dest.q, dest.r) && !thingsAt(dest.q, dest.r).length;
    if (rule.surgery === 'switch') {
      // Mind Blast: swap my tile with the chosen one — units, tokens, traps, obstacles.
      if (hd(myTile, dest) >= 1 && hd(myTile, dest) <= 10) {
        const other = unitAt(dest.q, dest.r);
        out.moves.push({ who: me, q: dest.q, r: dest.r, reason: 'switched' });
        if (other) out.moves.push({ who: other, q: myTile.q, r: myTile.r, reason: 'switched' });
        for (const th of thingsAt(myTile.q, myTile.r)) out.relocations.push({ ...th, q: dest.q, r: dest.r });
        for (const th of thingsAt(dest.q, dest.r)) out.relocations.push({ ...th, q: myTile.q, r: myTile.r });
        out.notes.push(`switch (${myTile.q},${myTile.r}) ⇄ (${dest.q},${dest.r})${other ? ` with ${other}` : ''}`);
        surgeryDone = true; recipients = [];
      } else out.notes.push('tile to switch must be 1–10 hexes away');
    } else if (rule.surgery === 'awake') {
      // Awake: the chosen free tile within 10 receives an adjacent ally, else me (the paper's trap /
      // wall option is reached only when neither exists — never, since I am always here).
      if (!destFree || hd(myTile, dest) > 10) { out.status = 'fizzled'; out.notes.push('no free tile within 10 chosen'); }
      else {
        const ally = ctx.peers().filter(id => id !== me && alive(id) && !ctx.enemyOf(me, id) && ctx.dist(me, id) <= 1).sort()[0];
        out.moves.push({ who: ally || me, q: dest.q, r: dest.r, reason: 'awakened' });
        out.notes.push(`awake moves ${ally || 'me'} to (${dest.q},${dest.r})`);
        surgeryDone = true;
      }
    } else if (!enemyAdjacent) {
      // Metaphysics (unite): a feature / trap next to me goes onto the chosen free tile.
      // Disruption (split): any trap in view (10) — even under an enemy — goes onto the chosen free tile.
      if (!destFree || hd(myTile, dest) > 10) { out.status = 'fizzled'; out.notes.push('no free tile within 10 chosen'); }
      else {
        let pool = [];
        if (rule.surgery === 'unite') pool = ctx.neighbours(myTile.q, myTile.r).flatMap(t => thingsAt(t.q, t.r).filter(th => th.kind !== 'obstacle'));
        else for (const t of ctx.freeTilesWithin ? [...ctx.freeTilesWithin(myTile.q, myTile.r, 10), ...ctx.peers().map(id => ctx.tileOf(id)).filter(Boolean)] : []) pool.push(...ctx.trapsAt(t.q, t.r).map(x => ({ kind: 'trap', owner: x.owner, id: x.id, label: x.effect_id })));
        pool = pool.filter((th, i, arr) => arr.findIndex(o => o.kind === th.kind && o.id === th.id) === i).sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const pick = pool[0];
        if (!pick) { out.status = 'fizzled'; out.notes.push(rule.surgery === 'unite' ? 'nothing nearby to move' : 'no trap in view to move'); }
        else { out.relocations.push({ ...pick, q: dest.q, r: dest.r }); out.notes.push(`${pick.label} moved to (${dest.q},${dest.r})`); surgeryDone = true; recipients = []; }
      }
    }
  }
  if (rule.surgery === 'awake' && !surgeryDone && out.status === 'done') { out.status = 'fizzled'; out.notes.push('awake needs a free tile within 10'); }
  // Damage legs (raw sums; the resolver applies Force Shield / tokens / rounding).
  if (rule.damage && !surgeryDone && !out.pulls.length && !(rule.pullToken && out.notes.some(n => n.startsWith('pull failed')))) {
    const healAlly = rule.healIfNoTarget && declared && declared !== me && alive(declared) && !ctx.enemyOf(me, declared) && ctx.dist(me, declared) <= 1 ? declared : null;
    if (healAlly) recipients = [];
    if (!recipients.length && rule.healIfNoTarget) {
      // Alt: restore life = my Vitality (÷10, capped by the peer at max life) on the ally I pointed at, else on me.
      out.heals.push({ on: healAlly || me, amount: roundHalfUp10(ctx.baseStat(me, 'vitality')) });
    } else if (!recipients.length && rule.altTrap) {
      // Space Bending alt (user ruling 2026-10-30): a RANDOM card out of the Dimension Library becomes a
      // trap on a random free tile within 10 hexes — nothing leaves my hand; whoever springs it gets the
      // card in their discard pile (`library: true`). Without a library (tests) the attached card serves.
      const free = (ctx.freeTilesWithin ? ctx.freeTilesWithin(myTile.q, myTile.r, 10) : []).filter(t => !(t.q === myTile.q && t.r === myTile.r));
      const lib = ctx.library ? ctx.library() : [];
      const card = lib.length ? lib[parseInt(ctx.sha(seed('altcard')).slice(0, 8), 16) % lib.length] : (cast.attach?.elements?.length ? { effect_id: cast.attach.effect_id, elements: cast.attach.elements, card_id: cast.attach.card_id || null } : null);
      if (!free.length) { out.status = 'fizzled'; out.notes.push('no free tile within 10'); }
      else if (!card) { out.status = 'fizzled'; out.notes.push('no card to lay'); }
      else {
        const pick = free[parseInt(ctx.sha(seed('alttrap')).slice(0, 8), 16) % free.length];
        out.traps.push({ by: me, q: pick.q, r: pick.r, effect_id: card.effect_id, elements: [...card.elements], card_id: card.card_id || null, library: !card.card_id, power: TRAP_POWER, trigger: 'enter', mode: 'damage', holder: null });
        out.notes.push(`trap ${card.effect_id} laid at (${pick.q},${pick.r})`);
      }
    } else if (!recipients.length && !rule.trap && !rule.completesWithoutTarget) {
      out.status = 'fizzled'; out.notes.push('nobody in reach');
    } else if (!recipients.length) out.notes.push(rule.trap ? 'nobody in reach — the trap is set' : 'nobody in reach — the cast still completes');
    for (const defId of recipients) {
      let main = 0;
      if (rule.damage === 'delta') main = deltaSum(defId);
      else for (let i = 0; i < elems.length; i++) main += ctx.shieldedAgainst(defId, elems[i]) ? 0 : (out.kept[i] || 0);
      // Elementalist (passive class, once per turn): an extra point-buy die rides on the completing emission as
      // damage, added to the Σ before rounding — also when the cast's own Σ is 0 (user ruling 2026-11-12).
      if (cast.boost > 0) main += cast.boost;
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
      if (!recipients.length && !tokKept) { out.status = 'fizzled'; out.notes.push('nobody in reach'); }
      for (const defId of recipients) lock(defId);
    }
  }
  if (rule.statPenalty) {
    if (!recipients.length && rule.altFeature) {
      // Ageing alt (user spec 2026-10-29): nobody in reach → a random building / artefact on a free tile within 2.
      const free = (ctx.freeTilesWithin ? ctx.freeTilesWithin(myTile.q, myTile.r, 2) : []).filter(t => !ctx.tileTokensAt || !ctx.tileTokensAt(t.q, t.r).some(tk => tk.item));
      if (!free.length) { out.status = 'fizzled'; out.notes.push('no free tile for a feature'); }
      else {
        const h = ctx.sha(seed('feature'));
        const t = free[parseInt(h.slice(0, 8), 16) % free.length];
        const f = FEATURES[parseInt(h.slice(8, 16), 16) % FEATURES.length];
        out.tokens.push({ kind: 'bonus', elem: f.elem, value: f.value, q: t.q, r: t.r, item: f.item });
        out.notes.push(`${f.item} rises at (${t.q},${t.r})`);
      }
    } else if (!recipients.length) { out.status = 'fizzled'; out.notes.push('nobody in reach'); }
    for (const defId of recipients) for (const el of rule.statPenalty) {
      const v = buy(myStat(el), `pen:${el}:${defId}`);
      if (v > 0) out.statTokens.push({ on: defId, stat: ctx.elemStat(el), elem: el, value: -v, effect_id: cast.effect_id });
    }
  }
  if (rule.statBonus && !artificeTile) for (const who of recipients) for (const el of rule.statBonus) {
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
  // TOKEN_RETRY_KEEPS: a failed token roll does not cancel the cast — the lock and the tokens bought land, the
  // missing token re-emits next action (out.kept = per token slot: value placed | null still owed).
  const keepTok = TOKEN_RETRY_KEEPS.has(cast.effect_id) && out.status === 'done';
  const slots = [...(rule.selfTileTokens || []).map(el => ['bonus', el]), ...(rule.selfShieldTokens || []).map(el => ['shield', el])];
  const newKept = [];
  let tokFailed = false;
  slots.forEach(([kind, el0], s) => {
    const el = kind === 'bonus' ? tileTokenElem(cast, el0, myStat) : el0;
    const tag = `${kind === 'bonus' ? 'tile' : 'shield'}:${el}`;
    if (keepTok) {
      if (tokKept && tokKept[s] != null) { newKept.push(tokKept[s]); return; }
      const pb = pointBuy(myStat(el), seed(tag), ctx.sha);
      out.rolls.push({ elem: tag, dice: [...pb.dice], stat: myStat(el), ok: !pb.fail });
      if (pb.fail) { tokFailed = true; newKept.push(null); out.notes.push(`point-buy ${tag} failed [${pb.dice.join(',')}] > ${myStat(el)} — that token re-emits next action`); return; }
      newKept.push(pb.value);
      if (pb.value > 0) out.tokens.push({ kind, elem: el, value: pb.value, q: myTile.q, r: myTile.r });
      return;
    }
    const v = buy(myStat(el), tag);
    if (v > 0) out.tokens.push({ kind, elem: el, value: v, q: myTile.q, r: myTile.r });
  });
  if (keepTok && tokFailed) out.kept = newKept;
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
    // User spec 2026-10-29: the chosen tile within 10 hexes (else a random free one within 10,
    // general_ux_range_cast_target) receives me or the adjacent ally with less life (tie → me).
    const hexDist = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((a.q + a.r) - (b.q + b.r)));
    let t = cast.target?.kind === 'tile' ? cast.target.ref : null;
    if (t && !(ctx.isFree(t.q, t.r) && hexDist(myTile, t) <= 10)) { out.notes.push(`tile (${t.q},${t.r}) not free within 10 — random tile instead`); t = null; }
    if (!t) {
      const free = ctx.freeTilesWithin ? ctx.freeTilesWithin(myTile.q, myTile.r, 10) : [];
      if (free.length) t = free[parseInt(ctx.sha(seed('teleport')).slice(0, 8), 16) % free.length];
    }
    if (!t) { out.status = 'fizzled'; out.notes.push('no free tile within 10'); }
    else {
      const ally = ctx.peers().filter(id => id !== me && alive(id) && !ctx.enemyOf(me, id) && ctx.dist(me, id) <= 1 && ctx.lifeOf(id) < ctx.lifeOf(me)).sort((a, b) => ctx.lifeOf(a) - ctx.lifeOf(b) || a.localeCompare(b))[0];
      out.moves.push({ who: ally || me, q: t.q, r: t.r, reason: 'teleported' });
      if (ally) out.notes.push(`teleports ally ${ally} (life ${ctx.lifeOf(ally)} < mine ${ctx.lifeOf(me)})`);
    }
  }
  // Banish: an enemy in reach whose World I beat with my World (Space, Souls) lands on a random
  // free tile ~20 hexes away (the farthest known free tile if the map is not that wide yet).
  if (rule.banish) {
    const hexDist = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((a.q + a.r) - (b.q + b.r)));
    const tgt = recipients[0];
    if (!tgt) { out.status = 'fizzled'; out.notes.push('nobody in reach'); }
    else {
      const gap = elems.reduce((s, el) => s + Math.max(0, myStat(el) - ctx.statFor(tgt, el)), 0);
      if (gap <= 0) { out.status = 'fizzled'; out.notes.push(`${tgt} holds (World ${ctx.statFor(tgt, elems[0])} ≥ mine ${myStat(elems[0])})`); }
      else {
        const all = ctx.freeTilesWithin ? ctx.freeTilesWithin(myTile.q, myTile.r, 24) : [];
        const far = all.filter(t => hexDist(myTile, t) >= 18);
        const pool = far.length ? far : all.slice().sort((a, b) => hexDist(myTile, b) - hexDist(myTile, a) || a.q - b.q || a.r - b.r).slice(0, 6);
        if (!pool.length) { out.status = 'fizzled'; out.notes.push('no free tile to banish to'); }
        else {
          const t = pool[parseInt(ctx.sha(seed(`banish:${tgt}`)).slice(0, 8), 16) % pool.length];
          out.moves.push({ who: tgt, q: t.q, r: t.r, reason: 'banished' });
          out.notes.push(`banish ${tgt} → (${t.q},${t.r}), ${hexDist(myTile, t)} away`);
        }
      }
    }
  }
  // Creation: an Earth obstacle (5 hp) on the chosen adjacent free tile, else the free neighbour
  // closest to the nearest enemy. My side walks over it; enemies must wear it down with Matter.
  if (rule.obstacle) {
    const nb = ctx.neighbours(myTile.q, myTile.r).filter(t => ctx.isFree(t.q, t.r));
    let t = cast.target?.kind === 'tile' && nb.some(n => n.q === cast.target.ref.q && n.r === cast.target.ref.r) ? cast.target.ref : null;
    if (!t && nb.length) {
      const foe = enemiesWithin(10).sort((a, b) => ctx.dist(me, a) - ctx.dist(me, b) || a.localeCompare(b))[0];
      const ft = foe ? ctx.tileOf(foe) : null;
      const hd = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((a.q + a.r) - (b.q + b.r)));
      t = ft ? nb.slice().sort((a, b) => hd(a, ft) - hd(b, ft) || a.q - b.q || a.r - b.r)[0] : nb[0];
    }
    if (!t) { out.status = 'fizzled'; out.notes.push('no free neighbour for the obstacle'); }
    else out.obstacles.push({ by: me, q: t.q, r: t.r, hp: 5, elem: 'elem_earth' });
  }
  // Spirit Link: the chosen ally's stat (cast.link = {peer_id, stat}; ∀: every stat) is added to mine while the permanent stands.
  if (rule.spiritLink) {
    const ally = cast.link?.peer_id;
    const stats = ['vitality', 'world', 'will', 'matter'];
    if (!ally || ally === me || !alive(ally) || ctx.enemyOf(me, ally)) { out.status = 'fizzled'; out.notes.push('no ally to link'); }
    else for (const sk of cast.every ? stats : [stats.includes(cast.link.stat) ? cast.link.stat : 'vitality']) out.links.push({ on: me, from: ally, stat: sk, value: ctx.baseStat(ally, sk) });
  }
  // Blessing / Curse: the attached effect becomes an unbreakable channel held by this permanent
  // (it re-fires every action while Blessing stands; the attached card is held, discarded with it).
  if (rule.blessAttach) {
    if (!cast.attach?.elements?.length) { out.status = 'fizzled'; out.notes.push('no effect attached to bless'); }
    else out.channels.push({ on: me, effect_id: cast.attach.effect_id, target: cast.target?.kind === 'character' ? cast.target.ref : null, elements: [...cast.attach.elements], salt: cast.salt || '', stop: 'never', holder: cast.effect_id, card_id: cast.attach.card_id || null });
  }
  // Phantom: peer.mjs spawns a copy of me bound to this permanent.
  if (rule.phantom && out.status === 'done') out.phantom = true;
  // Possess (user ruling 2026-11-17): the reveal carries the creature I picked from my archive
  // (cast.possess = {creature_id, card_id?, name?}) — I play it while the Possess permanent stands in MY
  // holding (peer.mjs spawns it next to me; my hero holds EP). No creature in my archive → the permanent
  // is the Phylactery (peer.mjs: one click shatters the nearest enemy's best permanent, then it is spent).
  if (rule.possess) {
    const pk = cast.possess;
    if (pk && typeof pk.creature_id === 'string' && pk.creature_id) {
      out.possess = { creature: { creature_id: pk.creature_id, card_id: typeof pk.card_id === 'string' ? pk.card_id : null, name: typeof pk.name === 'string' ? pk.name : null } };
      out.notes.push(`possess ${pk.creature_id} from my archive`);
    } else { out.possess = { phylactery: true }; out.notes.push('no creature in my archive — the Phylactery'); }
  }
  // Vision: a tile → the map around it is revealed to me; an enemy in reach → my World (Time) must beat theirs to see their hand.
  if (rule.vision) {
    if (cast.target?.kind === 'tile') { out.peeks.push({ by: me, kind: 'tile', q: cast.target.ref.q, r: cast.target.ref.r }); recipients = []; }
    else {
      const tgt = recipients[0];
      if (!tgt) { out.status = 'fizzled'; out.notes.push('nobody in reach and no tile'); }
      else if (myStat(elems[0]) <= ctx.statFor(tgt, elems[0])) { out.status = 'fizzled'; out.notes.push(`${tgt} keeps their hand hidden (World ${ctx.statFor(tgt, elems[0])} ≥ mine ${myStat(elems[0])})`); }
      else out.peeks.push({ by: me, kind: 'hand', of: tgt });
    }
  }
  if (rule.draw) out.draw = rule.draw;
  // Traps (Rule 2/4): the card itself waits under me (Poison, Sleep, Confusion) …
  if (rule.trap && out.status === 'done' && !cast._channel_tick) {
    out.traps.push({ by: me, q: myTile.q, r: myTile.r, effect_id: cast.effect_id, elements: [...elems], card_id: cast.card_id || null, power: TRAP_POWER, trigger: rule.trap.trigger, mode: rule.trap.mode, holder: null });
  }
  // … or the attached card does, held by this permanent (Traps Mastery).
  if (rule.trapAttach) {
    if (!cast.attach?.elements?.length) { out.status = 'fizzled'; out.notes.push('no effect attached as the trap'); }
    else out.traps.push({ by: me, q: myTile.q, r: myTile.r, effect_id: cast.attach.effect_id, elements: [...cast.attach.elements], card_id: cast.attach.card_id || null, power: TRAP_POWER, trigger: 'targeted', mode: 'damage', holder: cast.effect_id });
  }
  // Permanent landing on the original cast only. Channel ticks re-fire the
  // behaviour but the card is already in front of the caster — don't double-land it.
  // Every permanent lands on the caster (Possess too since 2026-11-17: it stands in my holding).
  if (rule.permanent && out.status === 'done' && !cast._channel_tick) out.permanents.push({ on: me, id: cast.effect_id });
  // Register the channel on the original cast; the tick path never re-emits one.
  if (rule.channel && out.status === 'done' && !cast._channel_tick) {
    out.channels.push({
      on: me,
      effect_id: cast.effect_id,
      target: cast.target?.kind === 'character' ? cast.target.ref : null,
      elements: elems,
      salt: cast.salt || '',
      stop: rule.channel.stop,
    });
  }
  out.every = !!cast.every;

  if (failed) {
    // Rule 20: a failed point-buy (token / stat dice, bought at completion) re-emits the last element. Nothing lands.
    return emptied('retry');
  }
  return out;
}
