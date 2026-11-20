#!/usr/bin/env node
// classes-rebalancing-check (milestone C5 of the chaosD6-Classes program, user request 2026-11-16: "do the same split for
// the CLASSES as well … extract there the skills as jsonlogic and the tools and validator").
// The classes twin of tools/skills-rebalancing-check.mjs (S5): every peer that meets a foreign class runs it and must
// reach the SAME verdict, so the model is
//   * analytic and exact — expectations are closed formulas over frozen game parameters (+ − × ÷ and Math.round
//     only, no sampling, no log/exp/pow: bit-exact IEEE everywhere);
//   * self-contained — the verdict depends only on this file, tools/rebalancing-core.mjs (imported, unchanged) and
//     tools/classes-rebalancing-calibration.json (all sha256-pinned), never on data/*.json at check time.
//
//   node tools/classes-rebalancing-check.mjs check <def.json|class_id> [--baseline <id|def.json>] [--no-baseline] [--tolerance t] [--json]
//   node tools/classes-rebalancing-check.mjs report [--json]       every built-in: V, k, ratio, verdict
//   node tools/classes-rebalancing-check.mjs calibrate [--write]   refit the curve on the 33 built-ins
//   node tools/classes-rebalancing-check.mjs audit <def.json|class_id>   logic audit only
//   node tools/classes-rebalancing-check.mjs pin [--write <path>]  the validator pin (validator/pin.json of chaosD6-Classes)
//
// Import: `import { checkClass } from './tools/classes-rebalancing-check.mjs'`;
//   checkClass(def, { baseline, tolerance, calibration }) → { verdict: ok|nerf|boost|reject, power, ratio, stamp, … }
//
// POWER MODEL (unit = one point of life swing over one game). A class is one card per character, so its fair power
// is a line over its colour count k (the card's price: k colours to strike before it leaves the board — and k
// colours to emit before it untaps or comes back):
//   game       A = turns · actions_per_turn actions
//   lifetime   q = p_strike (a colour of mine falls per enemy action, die of 6); L = k / q actions before the last
//              colour falls; R = k / p_restore actions to recast it. φ(k) = 1 if L ≥ A, else (L + (A − L)·L/(L+R)) / A
//   uses       tap: 1 + (A − 1) / (1 + U) (untap = every colour emitted again; 1.1.0: U = k / (p_restore +
//              p_recharge_emit · f), the recharge by emissions of other casts, see powerOf; + the gate wait (4));
//              once_per_round / passive / static: one per turn (turns)
//   power      the class's POWER vocabulary (BUILTIN_POWER for the built-ins, `power` in a foreign definition):
//              each key has a trigger — `use` (× uses), `action` (× A), `turn` (× turns) — and a per-trigger value
//              from the calibration weights and odds (VALUE below)
//   V          = φ(k) · Σ value(key)
// curve V̂(k) = a + b·k (fitCurve of rebalancing-core over the built-ins). ratio r = V / V̂(k). TOLERANCE ±30 %
// (user ruling 2026-11-18, as the effects and skills validators; was ±10 % since 2026-11-16), band [0.70, 1.30]. VERDICT: reject (schema / r > hard cap / r < floor /
// logic audit), nerf (r > 1+tol), boost (r < 1−tol), ok. With a baseline (explicit, or automatic when the def has the
// id of / `extends` a built-in) the band applies to r / r_baseline: a built-in unchanged is exactly 1 → ok.
//
// LOGIC AUDIT (needs game/classes.mjs, i.e. the pinned engine): the definition's hooks run on seeded mini worlds
// built HERE (no data files) through classes.mjs#resolveClassProgram, and may not do more than its power declares:
//   * every non-std hook it answers must be priced by a power key (HOOK_POWER) — an unpriced hook is rejected;
//   * a std hook it overrides (strike, restore, progress, life_points, colours, kind, ready) must answer exactly as
//     the classes_std default — those are the game's rules, not the class's;
//   * ability outputs per use: heals ≤ heal, armor ≤ armor, illusion targets within power.illusion.range, discards
//     ≤ discard, at most one trap / stone / revive, traps of power ≤ TRAP_POWER, lures within the lure range;
//     attack_out ≤ +attack_bonus, end_turn ≤ regen, lifesteal ≤ the damage, chase_step grant ≤ chase_bonus.life,
//     local draw ≤ draw.
// A built-in ability marked {"engine":"js"} resolves in peer.mjs and is audited by tools/classes-check.mjs instead.
//
// MODEL 1.1.0 (user rulings 2026-11-17, the six weight answers of CLASSES_BALANCE.md, all "Ok"):
//   (1) build = W.building_turn × p_building_used × the turns it stands, min(building_life_turns, (turns − 1)/2)
//       (a building raised over the game stands on average for half of what is left), not a flat price;
//   (2) W.recover 0.5 → 0.7 (a chosen card back beats a random draw, W.card 0.4);
//   (3) stance / emit / plan_emit priced per action code covered: Σ p(code) over the codes the class turns
//       (stance: {codes}) or makes emit (emit: {codes}); p(code) = code_mix[code] / Σ code_mix (equal weights, as
//       the skills validator's "basic-action mix not measurable" ruling). plan_emit (Enchanter, once per turn)
//       fires with p = 1 − (1 − p_cast_queued · Σ p(code))³ (three actions a turn);
//   (4) a range-gated use (POWER_KEYS gate: discard → p_enemy_near, build → p_building_near) is not spent without
//       a target, so the gate lengthens the tap cycle (+ (1 − p)/p actions of waiting) — it no longer scales the
//       value per use; a once-per-turn gated use fires with 1 − (1 − p)³;
//   (5) the odds only a swarm can measure are explicit calibration parameters (game.*, listed in
//       `swarm_placeholders` with their placeholder status); tools/class-fixtures.mjs genWorld({odds}) varies them;
//   (6) grant = W.card × V(granted effect) / mean V(built-in effects), both from the effects validator's calibration
//       (tools/rebalancing-calibration.json), frozen into `grants` by `calibrate`.
//   Necromancer: revive = W.revive · (p_fallen_near + (1 − p_fallen_near) · p_archived) · (1 − p_reanimated_destroyed ·
//   reanimated_loss) — the archive fallback, and the destroy-reanimated drawback (Rule 24: Harmony + Concentration at 6,
//   ruling 2026-11-17: an EXTRA way to kill the raised unit).
//   Tap recharge (user ruling 2026-11-17, Alchemist / every tap class): a tap card also untaps from the elements
//   emitted while casting other effects — the untap time is k / (p_restore + p_recharge_emit · f) (powerOf).
// MODEL 1.2.0 (user class rebalance rulings 2026-11-17 / 2026-11-18, data versions cr_2026_11_19): new optional
//   object shapes of the old keys (a bare number / true keeps its 1.1.0 meaning) and one new key:
//   draw {n, hand_max} × p_hand_small · heal {n, ally} — + ally heals × allies(1) · stone {n} (n stones per use) ·
//   discard {n, range} — range ≤ 1 gates on p_contact (else p_enemy_near) · attack_bonus {n, hurt_only} × p_foe_hurt ·
//   regen {n, still: [actions]} — p(unmoved on those actions) = p_unmoved_action^|still| (a product, no pow) ·
//   reroll {per: action} — trigger action, p_damage_spell_action · build {max} — the building-turn cap uses
//   min(building_slots, max) · reveal {range} — range > 1 uses p_enemy_near instead of p_contact · plant {max} — of the
//   traps planted only m + (uses − m) · p_planted_sprung get the chance to spring (a new one lifts the old) ·
//   swap {attack_only} × p_attack_of_combat · lifesteal {max, attack_only} — min(dmg_per_hit, max) (× p_attack_of_combat) ·
//   dodge n (NEW, Rogue one shared charge): n · (W.trap · p_trap_turn + W.threat · (1 − p_trap_turn)).
//   The new odds are swarm placeholders (calibration swarm_placeholders).
// MODEL 1.3.0 (user class picks 2026-11-19 of CLASSES_BALANCE "Proposals 2026-11-19", data cp_2026_11_19): new optional
//   fields of the object shapes (absent = the 1.2.0 meaning):
//   stone {chain} — the k-th point-buy rolls only after the (k−1)-th succeeded: Σ_{i<n} p^i stones a use instead of n ·
//   heal {unmoved, ally_required} — a tap gate (gateOf: p_unmoved_action × p_ally_adjacent; an unused tap waits), and
//   with ally_required the ally heal is certain (× 1, not × allies(1)) · discard {self} — the holder also discards
//   `self` own cards: (n − self) × W.card · build {heal} — a Shrine heals `heal` (× heal, the slot cap too) ·
//   chase_bonus {max_only} — +life MAX only, worth a life only while hurt (× p_hurt). New swarm placeholder p_ally_adjacent.
//   The fair line is LOCKED (policy.fit_locked, user instruction 2026-11-19 "do not refit the fair line"): calibrate()
//   re-snapshots the built-ins against the accepted fit instead of refitting it; fitCurve's answer is reported only.
//   CP2 (the user's answers, data cp2_2026_11_19): data untap_emissions N (a tap class, N above k) — the untap takes
//   N emissions instead of k: untap = max(k, N) / (p_restore + p_recharge_emit · f) (powerOf). Data fail_spends (Druid)
//   needs no new term: stone {chain} already prices a failed roll as a spent use.
//   CPD (Druid option C, data cpd_2026_11_19): stone {unmoved} — the Healer's no-move tap gate (gateOf p_unmoved_action).
// FOREIGN LIMITS (user ruling 2026-11-17): a foreign class (an id with no BUILTIN_POWER) may not have an ability the
// game code resolves itself (peer: hooks, JS markers, the peer-resolved keys build / disable_traps / plant /
// relocate) and may not be a hand class (data.hand_reveal / hand_discard, flags.handDefaults, the keys discard /
// reveal) — but it MAY be passive (ability_kind passive, data.passive, flags.passiveTurn).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CORE_VERSION, r6, r3, sha256, isObj, canonicalJson, fileSha, readJson, pointBuyStats, fitCurve, bandVerdict } from './rebalancing-core.mjs';

export { canonicalJson };
export const VALIDATOR_VERSION = '1.3.0';   // 1.3.0 (class picks 2026-11-19): MODEL 1.3.0 below; 1.2.0 (class rebalance rulings 2026-11-17/18): MODEL 1.2.0; 1.1.0: the six weight answers
export const DEFAULT_TOLERANCE = 0.30;   // user ruling 2026-11-18 (was 0.10 since 2026-11-16)
export const PIN_FORMAT = 'chaosd6-classes-validator-pin/1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
export const CALIBRATION_PATH = path.join(HERE, 'classes-rebalancing-calibration.json');
const SELF_PATH = fileURLToPath(import.meta.url);
const CORE_PATH = path.join(HERE, 'rebalancing-core.mjs');
const TRAP_POWER = 20;
const ELEM_TO_STAT = { elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' };
const ELEMS = Object.keys(ELEM_TO_STAT);
const KINDS = ['tap', 'once_per_round', 'static', 'passive'];

// ------------------------------------------------------------------ engines (logic audit only)
const ENGINE_FILES = ['classes.mjs', 'class-engine.mjs', 'effect-engine.mjs', 'class-traps.mjs', 'class-manipulator.mjs', 'class-chase.mjs', 'class-world.mjs'];
const LIB_DIR = path.join(GAME, 'classes-data', 'lib');
let CL = null;
try { if (fs.existsSync(path.join(GAME, 'classes.mjs'))) CL = await import(pathToFileURL(path.join(GAME, 'classes.mjs')).href); } catch { CL = null; }
function engineHashes() {
  const libs = fs.existsSync(LIB_DIR) ? fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.json')).sort() : [];
  return {
    ...Object.fromEntries(ENGINE_FILES.map(f => [`game/${f}`, fileSha(path.join(GAME, f))])),
    ...Object.fromEntries(libs.map(f => [`game/classes-data/lib/${f}`, sha256(canonicalJson(readJson(path.join(LIB_DIR, f))))])),
  };
}

// ------------------------------------------------------------------ calibration + pin
let _cal = null;
export function loadCalibration(file = CALIBRATION_PATH) {
  if (file === CALIBRATION_PATH && _cal) return _cal;
  const cal = readJson(file);
  if (file === CALIBRATION_PATH) _cal = cal;
  return cal;
}
const _pins = new WeakMap();
export function computePin(cal = loadCalibration()) {
  if (!_pins.has(cal)) _pins.set(cal, computePinUncached(cal));
  return JSON.parse(JSON.stringify(_pins.get(cal)));
}
function computePinUncached(cal) {
  const source_sha256 = fileSha(SELF_PATH);
  const core_sha256 = fileSha(CORE_PATH);
  const calibration_sha256 = sha256(canonicalJson(cal));
  const audit = cal.policy.audit !== false;
  const engines = audit ? engineHashes() : {};
  const engines_sha256 = sha256(canonicalJson(engines));
  return {
    format: PIN_FORMAT,
    validator: 'classes-rebalancing-check',
    validator_version: VALIDATOR_VERSION,
    source_path: 'game/tools/classes-rebalancing-check.mjs',
    source_sha256,
    core_path: 'game/tools/rebalancing-core.mjs',
    core_version: CORE_VERSION,
    core_sha256,
    calibration_path: 'game/tools/classes-rebalancing-calibration.json',
    calibration_sha256,
    audit,
    engines,
    engines_sha256,
    pin_id: sha256(`${VALIDATOR_VERSION}\n${source_sha256}\n${core_sha256}\n${calibration_sha256}\n${engines_sha256}`),
    policy: { tolerance: cal.policy.tolerance, hard_cap_ratio: cal.policy.hard_cap_ratio, hard_floor_ratio: cal.policy.hard_floor_ratio },
    fit: cal.fit ? { a: cal.fit.a, b: cal.fit.b } : null,
    accept: ['ok'],
    notes: 'A ref (class branch) is accepted when its stamp.pin_id equals this pin_id and stamp.verdict is in `accept`. Peers re-run checkClass on the def and compare stamp.def_sha256 + verdict; a different pin_id means a different validator — re-check, do not trust.',
  };
}
export function verifyPin(pin, cal = loadCalibration()) {
  const mine = computePin(cal);
  const diffs = ['format', 'validator_version', 'source_sha256', 'core_sha256', 'calibration_sha256', 'engines_sha256', 'pin_id'].filter(k => pin?.[k] !== mine[k]);
  return { ok: diffs.length === 0, diffs, mine: mine.pin_id, theirs: pin?.pin_id ?? null };
}

// ------------------------------------------------------------------ power vocabulary
// key → trigger + the shape of its value. n = a positive integer count unless noted.
export const POWER_KEYS = {
  heal:          { trigger: 'use',    shape: 'n' },        // n life tokens restored (self or an ally)
  armor:         { trigger: 'use',    shape: 'n' },        // n armor life points
  illusion:      { trigger: 'use',    shape: 'range' },    // one illusion point on me + every ally within range
  discard:       { trigger: 'use',    shape: 'n', gate: 'p_enemy_near', hand: true },   // an enemy (within range) discards n random hand cards
  stone:         { trigger: 'use',    shape: 'true' },     // a point-buy stat bonus token on my tile
  trap:          { trigger: 'use',    shape: 'true' },     // a trap of TRAP_POWER (Library or hand card)
  plant:         { trigger: 'use',    shape: 'true', peer: true },     // a hand effect as a far trap + vision
  lure:          { trigger: 'use',    shape: 'range' },    // wild monsters within range chase me
  revive:        { trigger: 'use',    shape: 'true' },     // a fallen ally creature rises
  build:         { trigger: 'use',    shape: 'build', peer: true },   // a building rises: true (Shrine) | {gate: true} (Animator: needs a building near to copy)
  disable_traps: { trigger: 'use',    shape: 'range', peer: true },    // every foreign trap within range is gone
  draw:          { trigger: 'use',    shape: 'n' },        // draw n cards
  recover:       { trigger: 'use',    shape: 'n' },        // n cards discard pile → hand
  grant:         { trigger: 'use',    shape: 'grant' },    // an effect card granted: true (= effect_summoning) | {effect_id} (priced from calibration grants)
  plan_emit:     { trigger: 'use',    shape: 'codes' },    // once per turn, emit during one of these codes while a cast is queued: true (= A, B, M) | {codes}
  attack_bonus:  { trigger: 'action', shape: 'n' },        // +n combat damage once I scored this round
  lifesteal:     { trigger: 'action', shape: 'true' },     // heal the combat damage I deal
  stance:        { trigger: 'action', shape: 'codes' },    // these empty codes fight as another action: true (= EP) | {codes: [EP, EM]}
  emit:          { trigger: 'action', shape: 'codes' },    // these (non-emitting) codes emit: {codes: [A|B|M|EM]} | n (legacy: n codes of mean odds)
  trap_disable:  { trigger: 'action', shape: 'true' },     // stepping on a building trap disables it
  share_skills:  { trigger: 'action', shape: 'true' },     // adjacent allies use my skills too
  take_tokens:   { trigger: 'action', shape: 'true' },     // destroyed tokens become mine
  transmute:     { trigger: 'action', shape: 'true' },     // a nearby ally's stat / heal cast works on me too
  relocate:      { trigger: 'action', shape: 'true', peer: true },     // move a nearby unit one hex at the end of a round
  regen:         { trigger: 'turn',   shape: 'n' },        // +n life at the end of an unmoved turn
  trap_dodge:    { trigger: 'turn',   shape: 'n' },        // n trap steps per turn do not trigger
  threat_dodge:  { trigger: 'turn',   shape: 'n' },        // n threatened moves per turn are stealthy
  dodge:         { trigger: 'turn',   shape: 'n' },        // 1.2.0: n shared charges per turn — a trap step does not trigger, else a threatened move is stealthy
  reroll:        { trigger: 'turn',   shape: 'true' },     // a point-buy die added to a damage spell
  swap:          { trigger: 'turn',   shape: 'true' },     // a nearby enemy's action is swapped before it hits me
  reveal:        { trigger: 'turn',   shape: 'true', hand: true },     // an adjacent enemy's hand opens
  chase_bonus:   { trigger: 'turn',   shape: 'life' },     // +life max while monsters chase me
};
// Built-in power, read off peer.mjs / classes.mjs on 2026-11-16 (the logic audit proves the data-run ones).
export const BUILTIN_POWER = {
  class_alchemist: { trap: true },
  class_animator: { build: { gate: true } },   // 1.1.0: copies the building nearest (within 2) — gated by p_building_near
  class_assassin: { attack_bonus: { n: 1, hurt_only: true } },   // CR 2026-11-17: only vs an enemy below full life
  class_avenger: { lure: { range: 10 }, chase_bonus: { life: 1, max: 1, max_only: true } },   // CP 2026-11-19 (pick 9 a): +1 life MAX only
  class_barbarian: { stance: { codes: ['EP', 'EM'] }, emit: { codes: ['B'] } },   // CR 2026-11-18 (a): EM is a Block too (only a real Block emits)   // ruling 2026-11-16: may emit during Block (B); 2026-11-17: that Block emission progresses (keeps the channel, peer.mjs classKeeps) = a full emit
  class_bard: { share_skills: true },
  class_cleric: { disable_traps: { range: 3 }, trap_disable: true },
  class_druid: { stone: { n: 2, chain: true, unmoved: true } },   // CPD 2026-11-19 (option C): only on an action I do not move;   // CR 2026-11-17: two stones (best stat + next best); CP 2026-11-19 (pick 2 b): the 2nd only after the 1st succeeded
  class_elementalist: { reroll: { per: 'action' } },   // CR 2026-11-17: once per ACTION
  class_enchanter: { emit: { codes: ['A', 'B', 'M'] } },   // CR 2026-11-18 (b): static, A / B / M emit at every site
  class_guardian: { regen: { n: 1, still: [2, 3] } },   // CR 2026-11-17: unmoved on the 2nd and 3rd action
  class_healer: { heal: { n: 1, ally: 1, unmoved: true, ally_required: true } },   // CR 2026-11-17: me AND an adjacent ally; CP 2026-11-19 (pick 4 a): only unmoved, only with an ally adjacent
  class_illusionist: { illusion: { range: 10 } },
  class_kensei: { recover: 1 },
  class_manipulator: { swap: { attack_only: true } },   // CR 2026-11-17: only an incoming Attack
  class_monk: { emit: { codes: ['M', 'EM'] } },   // CR 2026-11-17: no EP-as-Move stance   // ruling 2026-11-16: Move and Empty Move emit at every site
  class_necromancer: { revive: true },
  class_noble: { lifesteal: { max: 1, attack_only: true } },   // CR 2026-11-17: ≤ 1 per action, own Attack only
  class_overlord: { armor: 1 },
  class_paladin: { recover: 1 },
  class_priest: { build: { max: 1, heal: 2 } },   // CR 2026-11-17: one Shrine standing; CP 2026-11-19 (pick 5 a): the Priest's Shrine heals 2
  class_prophet: { reveal: { range: 3 } },   // CR 2026-11-17: an enemy within 3 hexes
  class_ranger: { trap: true },
  class_reaver: { stance: { codes: ['EP', 'EM'] }, emit: { codes: ['A'] } },   // EP / EM fight as Attack; the Attack emits (and keeps the channel, ruling 2026-11-17)
  class_restaurateur: { take_tokens: true },
  class_rogue: { dodge: 1 },   // CR 2026-11-17: one shared charge per turn
  class_seeker: { plant: { max: 1 } },   // CR 2026-11-17: once per turn, one trap standing
  class_shaman: { recover: 1 },
  class_summoner: { grant: { effect_id: 'effect_summoning' } },
  class_transmuter: { transmute: true },
  class_warrior: { relocate: true },
  class_weapon_master: { draw: { n: 2, hand_max: 3 } },   // CR 2026-11-17: only while the hand holds ≤ 3; CP 2026-11-19 (pick 1 a): draw 2
  class_witch: { discard: { n: 3, range: 1, self: 1 } },   // CR 2026-11-18 (b): range 1; CP 2026-11-19 (pick 8 a): she also discards 1 of her own
};
// A non-std hook is priced by any of these keys (the ability by its output keys, see auditAbility).
export const HOOK_POWER = {
  ability: ['heal', 'armor', 'illusion', 'discard', 'stone', 'trap', 'plant', 'lure', 'revive', 'build', 'disable_traps', 'relocate'],
  config: null,   // knobs only
  blocked: null,  // phase 4: why the class card cannot be clicked now — a UI / planning gate, never a gain
  stance: ['stance'], stance_target: ['stance'], emits: ['emit', 'stance'], plan_emits: ['plan_emit'],
  attack_out: ['attack_bonus'], lifesteal: ['lifesteal'], lifesteal_apply: ['lifesteal'],
  pre_cast: ['reroll'], transmute: ['transmute'], destroy_result: ['take_tokens'], end_turn: ['regen'],
  step: ['trap_dodge', 'threat_dodge', 'trap_disable', 'dodge'], dungeon_step: ['trap_dodge', 'trap_disable', 'dodge'],
  combat_in: ['swap'], pick_target: ['swap'], chase_step: ['chase_bonus'], contact: ['reveal'],
  local: ['draw', 'recover', 'grant'], share_skills: ['share_skills'],
  // Necromancer destroy reanimated (ruling 2026-11-16): a way for ENEMIES to destroy what the class raised — a drawback
  // on power.revive, never a gain (the neutral answer, null, is the strongest), so it needs no power key of its own;
  // 1.1.0 prices it inside revive (p_reanimated_destroyed × reanimated_loss, see keyValue).
  reanimated_strike: null,
};
const STD = ['colours', 'kind', 'ready', 'config', 'strike', 'restore', 'progress', 'life_points'];

// ------------------------------------------------------------------ definitions
// normalizeDef(def) → { id, extends, kind, colours, k, power, hooks, data, def }. Power: the definition's `power`,
// else (a built-in id or `extends`) BUILTIN_POWER.
export function normalizeDef(def) {
  const d = isObj(def) ? def : {};
  const data = isObj(d.data) ? d.data : {};
  const base = typeof d.extends === 'string' ? d.extends : null;
  const power = isObj(d.power) ? d.power : (BUILTIN_POWER[d.id] || (base && BUILTIN_POWER[base]) || null);
  const colours = Array.isArray(data.colors) ? data.colors : [];
  const passive = data.passive === true || (isObj(d.flags) && d.flags.passiveTurn === true);
  return { id: d.id, extends: base, kind: passive ? 'passive' : data.ability_kind, colours, k: colours.length, power, hooks: isObj(d.hooks) ? d.hooks : {}, data, def: d };
}
const posInt = (x) => Number.isInteger(x) && x >= 1 && x <= 20;
export function validateNorm(n, cal = null) {
  const errors = [];
  if (typeof n.id !== 'string' || !/^class_[a-z0-9_]+$/.test(n.id)) errors.push('id must match class_[a-z0-9_]+');
  if (n.extends !== null && !BUILTIN_POWER[n.extends]) errors.push(`extends ${n.extends}: not a built-in class`);
  if (!KINDS.includes(n.kind)) errors.push(`data.ability_kind must be ${KINDS.join('|')}`);
  if (!n.k || !n.colours.every(e => ELEMS.includes(e)) || new Set(n.colours).size !== n.k) errors.push('data.colors must be a non-empty list of distinct elements');
  if (n.data.untap_emissions !== undefined && !posInt(n.data.untap_emissions)) errors.push('data.untap_emissions must be an integer 1..20');   // 1.3.0 CP2
  if (!n.power) errors.push('power required (a foreign class declares what it does: see POWER_KEYS)');
  else {
    if (!Object.keys(n.power).length) errors.push('power is empty (the class does nothing)');
    for (const [key, v] of Object.entries(n.power)) {
      const pk = POWER_KEYS[key];
      if (!pk) { errors.push(`power.${key}: unknown key (${Object.keys(POWER_KEYS).join(', ')})`); continue; }
      const ok = shapeOk(key, pk.shape, v);
      if (!ok) errors.push(`power.${key}: must be ${SHAPE_TEXT[key] || SHAPE_TEXT[pk.shape]}`);
    }
  }
  if (!BUILTIN_POWER[n.id]) errors.push(...foreignLimits(n));
  if (cal && n.power?.grant !== undefined && shapeOk('grant', 'grant', n.power.grant) && grantValue(n.power.grant, cal.weights, cal) === null) errors.push(`power.grant: ${isObj(n.power.grant) ? n.power.grant.effect_id : 'effect_summoning'} has no price in the calibration grants (the effects validator's built-ins)`);
  return errors;
}
// 1.1.0 shapes. codes: true (the legacy default codes) | {codes: [distinct codes of the key's set]}; emit also n.
export const STANCE_CODES = ['EP', 'EM'];
export const EMIT_CODES = ['A', 'B', 'M', 'EM'];   // the codes that do not emit by themselves (P / EP always emit)
const CODE_SET = { stance: STANCE_CODES, emit: EMIT_CODES, plan_emit: ['A', 'B', 'M', 'EM'] };
const LEGACY_CODES = { stance: ['EP'], plan_emit: ['A', 'B', 'M'] };
const codesOk = (key, v) => isObj(v) && Array.isArray(v.codes) && v.codes.length > 0 && new Set(v.codes).size === v.codes.length && v.codes.every(c => CODE_SET[key].includes(c));
// 1.2.0: the object forms of the old keys (CR 2026-11-17/18). `n` (where listed) is required and an integer 1..20.
const bool = (x) => typeof x === 'boolean';
const range64 = (x) => Number.isInteger(x) && x >= 0 && x <= 64;
const EXT = {
  draw: { n: posInt, hand_max: posInt }, heal: { n: posInt, ally: posInt, unmoved: bool, ally_required: bool }, stone: { n: posInt, chain: bool, unmoved: bool }, discard: { n: posInt, range: range64, self: posInt },   // 1.3.0: + unmoved / ally_required, chain, self
  attack_bonus: { n: posInt, hurt_only: bool }, regen: { n: posInt, still: (x) => Array.isArray(x) && x.length > 0 && new Set(x).size === x.length && x.every(a => [1, 2, 3].includes(a)) },
  reroll: { per: (x) => x === 'action' || x === 'turn' }, reveal: { range: range64 }, plant: { max: posInt },
  swap: { attack_only: bool }, lifesteal: { max: posInt, attack_only: bool },
};
const NEEDS_N = ['draw', 'heal', 'stone', 'discard', 'attack_bonus', 'regen'];
const extOk = (key, v) => isObj(v) && !!EXT[key] && Object.keys(v).length > 0 && Object.entries(v).every(([f, x]) => EXT[key][f] && EXT[key][f](x)) && (!NEEDS_N.includes(key) || posInt(v.n));
export const nOf = (v) => (typeof v === 'number' ? v : isObj(v) && posInt(v.n) ? v.n : 1);
function shapeOk(key, shape, v) {
  if (EXT[key] && isObj(v)) return extOk(key, v);
  switch (shape) {
    case 'n': return posInt(v);
    case 'true': return v === true;
    case 'range': return isObj(v) && Number.isInteger(v.range) && v.range >= 0 && v.range <= 64;
    case 'life': return isObj(v) && posInt(v.life) && posInt(v.max ?? v.life) && Object.keys(v).every(k => ['life', 'max', 'max_only'].includes(k)) && (v.max_only === undefined || bool(v.max_only));   // 1.3.0: + max_only
    case 'codes': return (key !== 'emit' && v === true) || (key === 'emit' && Number.isInteger(v) && v >= 1 && v <= EMIT_CODES.length) || codesOk(key, v);
    case 'build': return v === true || (isObj(v) && Object.keys(v).every(k => k === 'gate' || k === 'max' || k === 'heal') && (v.gate === undefined || typeof v.gate === 'boolean') && (v.max === undefined || posInt(v.max)) && (v.heal === undefined || posInt(v.heal)));   // 1.3.0: + heal
    case 'grant': return v === true || (isObj(v) && typeof v.effect_id === 'string' && /^effect_[a-z0-9_]+$/.test(v.effect_id));
    default: return false;
  }
}
const SHAPE_TEXT = { n: 'an integer 1..20 (or its 1.2.0 object form)', true: 'true (or its 1.2.0 object form)', range: '{range: 0..64}', life: '{life, max, max_only?} (1..20)', build: 'true | {gate: boolean, max: 1..20, heal: 1..20}', grant: 'true | {effect_id}',
  stance: `true | {codes: ${STANCE_CODES.join('|')}}`, emit: `an integer 1..${EMIT_CODES.length} | {codes: ${EMIT_CODES.join('|')}}`, plan_emit: `true | {codes: ${CODE_SET.plan_emit.join('|')}}` };
// The codes a codes-shaped key covers.
export function codesOf(key, v) { return isObj(v) && Array.isArray(v.codes) ? v.codes : (LEGACY_CODES[key] || null); }
// Foreign limits (user ruling 2026-11-17): no ability the game code resolves itself, no hand class — passive is fine.
export function foreignLimits(n) {
  const errors = [];
  const flags = isObj(n.def?.flags) ? n.def.flags : {};
  const peerHooks = Array.isArray(flags.hooks) ? flags.hooks.filter(h => typeof h === 'string' && h.startsWith('peer:')) : [];
  if (peerHooks.length) errors.push(`foreign class: flags.hooks ${peerHooks.join(', ')} — an ability the game code resolves itself is for built-in classes only`);
  const js = Object.entries(n.hooks || {}).filter(([, p]) => isObj(p) && Object.prototype.hasOwnProperty.call(p, 'engine')).map(([h]) => h);
  if (js.length) errors.push(`foreign class: hooks ${js.join(', ')} marked {"engine": …} — the game code resolving it is for built-in classes only`);
  for (const key of Object.keys(n.power || {})) {
    if (POWER_KEYS[key]?.peer) errors.push(`foreign class: power.${key} is resolved by the game code (peer.mjs) — built-in classes only`);
    if (POWER_KEYS[key]?.hand) errors.push(`foreign class: power.${key} makes it a hand class — built-in classes only`);
  }
  for (const k of ['hand_reveal', 'hand_discard']) if (n.data?.[k] !== undefined && n.data[k] !== null) errors.push(`foreign class: data.${k} makes it a hand class — built-in classes only`);
  if (flags.handDefaults !== undefined && flags.handDefaults !== null) errors.push('foreign class: flags.handDefaults makes it a hand class — built-in classes only');
  return errors;
}

// ------------------------------------------------------------------ the model
const allies = (G, range) => r6(G.allies_max * range / (range + G.allies_half));
// 1.1.0 (3): p(an action is one of `codes`) = Σ code_mix[c] / Σ code_mix (equal weights in the calibration).
export function pCodes(G, codes) {
  const mix = G.code_mix || {};
  let all = 0, hit = 0;
  for (const c of Object.keys(mix).sort()) { all += mix[c]; if (codes.includes(c)) hit += mix[c]; }
  return all > 0 ? hit / all : 0;
}
// 1.1.0 (4): the per-action odds that a gated use finds its target (null = not gated). A gated use is not spent
// without one, so the gate goes into the uses (powerOf), not into the value per use.
export function gateOf(key, v, G) {
  if (key === 'discard') return isObj(v) && Number.isInteger(v.range) && v.range <= 1 ? G.p_contact : G.p_enemy_near;   // 1.2.0: range 1 = contact
  if (key === 'heal' && isObj(v) && (v.unmoved || v.ally_required)) return (v.unmoved ? G.p_unmoved_action : 1) * (v.ally_required ? G.p_ally_adjacent : 1);   // 1.3.0: Healer tap gates
  if (key === 'stone' && isObj(v) && v.unmoved) return G.p_unmoved_action;   // 1.3.0 CPD: the Druid's no-move tap gate
  if (key === 'build' && isObj(v) && v.gate) return G.p_building_near;
  if (key === 'plan_emit') return G.p_cast_queued * pCodes(G, codesOf(key, v));
  return null;
}
// 1.1.0 (6): the granted effect card, priced in cards: W.card × V(effect) / mean V(built-in effects) (calibration grants).
export function grantValue(v, W, cal) {
  const id = isObj(v) ? v.effect_id : 'effect_summoning';
  const g = cal?.grants?.effects?.[id];
  return g && cal.grants.mean_value > 0 ? W.card * g / cal.grants.mean_value : null;
}
// Value of one power key per trigger (calibration weights W, odds G; cal for the grants table).
export function keyValue(key, v, G, W, cal = null) {
  const pbOk = pointBuyStats(G.stat_mean);
  const n = nOf(v);
  const o = isObj(v) ? v : {};
  switch (key) {
    case 'heal': return (n + (o.ally || 0) * (o.ally_required ? 1 : allies(G, 1))) * W.life * G.p_hurt;   // 1.2.0: + the adjacent ally's heal; 1.3.0: certain with ally_required (the gate prices the wait)
    case 'armor': return n * W.shield;
    case 'illusion': return (1 + allies(G, v.range)) * W.illusion;
    case 'discard': return (n - (o.self || 0)) * W.card;   // 1.1.0 (4): p_enemy_near is in the uses (gateOf); 1.3.0: − my own discards
    case 'stone': { let k = n; if (o.chain) { k = 0; let q = 1; for (let i = 0; i < n; i++) { k += q; q *= pbOk.p; } } return k * pbOk.p * pbOk.ev * W.stat_point; }   // 1.3.0: chain → Σ p^i
    case 'trap': return TRAP_POWER / 20 * W.trap * G.p_trap_springs;
    case 'plant': return W.trap * G.p_trap_springs * G.p_far_trap + W.vision;
    case 'lure': return allies(G, v.range) * G.monsters_per_ally * W.lure;
    case 'revive': return W.revive * (G.p_fallen_near + (1 - G.p_fallen_near) * G.p_archived) * (1 - G.p_reanimated_destroyed * G.reanimated_loss);
    case 'build': return W.building_turn * G.p_building_used * Math.min(G.building_life_turns, (G.turns - 1) / 2) * (posInt(o.heal) ? o.heal : 1);   // 1.1.0 (1); 1.3.0: × heal
    case 'disable_traps': return allies(G, v.range) * G.traps_per_ally * W.disable;
    case 'draw': return n * W.card * (o.hand_max ? G.p_hand_small : 1);   // 1.2.0: only while the hand is small
    case 'recover': return n * W.recover;
    case 'grant': return grantValue(v, W, cal) ?? 0;   // 1.1.0 (6)
    case 'plan_emit': return W.emit;   // 1.1.0 (3): fires with gateOf (p_cast_queued × p(code))
    case 'attack_bonus': return n * W.life * G.p_combat * G.p_scored * (o.hurt_only ? G.p_foe_hurt : 1);
    case 'lifesteal': return W.lifesteal * G.p_combat * (o.max ? Math.min(G.dmg_per_hit, o.max) : G.dmg_per_hit) * G.p_hurt * (o.attack_only ? G.p_attack_of_combat : 1);
    case 'stance': return W.stance * pCodes(G, codesOf('stance', v));   // 1.1.0 (3): per code covered
    case 'emit': return W.emit * (typeof v === 'number' ? v * pCodes(G, EMIT_CODES) / EMIT_CODES.length : pCodes(G, codesOf('emit', v)));
    case 'trap_disable': return W.disable * G.p_trap_step;
    case 'share_skills': return W.skill * G.p_skill_use * G.adjacent_allies;
    case 'take_tokens': return W.take * G.p_destroy_near;
    case 'transmute': return W.transmute * G.p_ally_cast;
    case 'relocate': return W.relocate;
    case 'regen': { let still = G.p_unmoved; if (Array.isArray(o.still)) { still = 1; for (let i = 0; i < o.still.length; i++) still *= G.p_unmoved_action; } return n * W.life * still * G.p_hurt; }
    case 'trap_dodge': return n * W.trap * G.p_trap_turn;
    case 'threat_dodge': return n * W.threat;
    case 'dodge': return n * (W.trap * G.p_trap_turn + W.threat * (1 - G.p_trap_turn));
    case 'reroll': return W.stat_point * pbOk.p * pbOk.ev * (o.per === 'action' ? G.p_damage_spell_action : G.p_damage_spell);
    case 'swap': return W.swap * G.p_combat_taken * (o.attack_only ? G.p_attack_of_combat : 1);
    case 'reveal': return W.info * (Number.isInteger(o.range) && o.range > 1 ? G.p_enemy_near : G.p_contact);
    case 'chase_bonus': return Math.min(v.life, v.max ?? v.life) * W.life * G.p_chased * (v.max_only ? G.p_hurt : 1);   // 1.3.0: max only → worth a life only while hurt
    default: return 0;
  }
}
export const triggerOf = (key, v) => (key === 'reroll' && isObj(v) && v.per === 'action' ? 'action' : POWER_KEYS[key].trigger);   // 1.2.0
export function rechargeShare(colours) {
  const stats = new Set((colours || []).map(e => ELEM_TO_STAT[e]).filter(Boolean));
  return ELEMS.filter(e => stats.has(ELEM_TO_STAT[e])).length / ELEMS.length / 2;
}
export function powerOf(n, cal) {
  const G = cal.game, W = cal.weights;
  const A = G.turns * G.actions_per_turn;
  const k = n.k;
  const L = k / G.p_strike, R = k / G.p_restore;
  const phi = L >= A ? 1 : (L + (A - L) * L / (L + R)) / A;
  // 1.1.0 (user ruling 2026-11-17, relayed): a tap class also untaps from the elements I emit while casting OTHER
  // effects ("the Class is recharged whenever you emit the unchecked element by casting other effects"). An untap
  // takes k / (p_restore + p_recharge_emit · f) actions: f = the share of incidental emissions that land on a still
  // unchecked stat of the class = ½ × (elements of the class's stats) / 10 (half of them unchecked on average;
  // restore is per stat, classes.mjs restore). p_recharge_emit is a swarm placeholder (calibration swarm_placeholders).
  const ue = n.data?.untap_emissions, emissions = n.kind === 'tap' && Number.isInteger(ue) && ue > k ? ue : k;   // 1.3.0 CP2: a longer untap
  const untap = emissions / (G.p_restore + (G.p_recharge_emit || 0) * rechargeShare(n.colours));
  const uses = n.kind === 'tap' ? 1 + (A - 1) / (1 + untap) : G.turns;
  // 1.1.0 (4): a gated use waits (1 − p)/p actions for its target (tap), or fires in a turn with 1 − (1 − p)^actions.
  const usesOf = (p) => {
    if (p === null || p >= 1) return uses;
    if (!(p > 0)) return 0;
    if (n.kind === 'tap') return 1 + (A - 1) / (1 + untap + (1 - p) / p);
    let miss = 1;
    for (let i = 0; i < G.actions_per_turn; i++) miss *= 1 - p;
    return G.turns * (1 - miss);
  };
  const components = {};
  let sum = 0;
  for (const [key, v] of Object.entries(n.power)) {
    const t = triggerOf(key, v);
    const per = keyValue(key, v, G, W, cal);
    const gate = t === 'use' ? gateOf(key, v, G) : null;
    const times = t === 'use' ? usesOf(gate) : t === 'action' ? A : G.turns;
    // 1.1.0 (1): building-turns are capped by the units that can stand on them: at most building_slots of my
    // buildings are used a turn, over the turns after the first one rises (turns − 1).
    const slots = key === 'build' && isObj(v) && posInt(v.max) ? Math.min(G.building_slots, v.max) : G.building_slots;   // 1.2.0: max standing
    let x;
    if (key === 'build') x = r6(Math.min(per * times, W.building_turn * G.p_building_used * slots * (G.turns - 1) * (isObj(v) && posInt(v.heal) ? v.heal : 1)));   // 1.3.0: × heal
    else if (key === 'plant' && isObj(v) && posInt(v.max)) {
      // 1.2.0: a new plant lifts the oldest beyond max — only m + (times − m) · p_planted_sprung traps get to spring; the vision is per plant
      const live = Math.min(times, v.max + Math.max(0, times - v.max) * G.p_planted_sprung);
      x = r6(W.trap * G.p_trap_springs * G.p_far_trap * live + W.vision * times);
    } else x = r6(per * times);
    components[key] = { trigger: t, per: r6(per), times: r6(times), value: x, ...(gate !== null ? { gate: r6(gate) } : {}) };
    sum += x;
  }
  return { value: r6(phi * sum), lifetime: r6(phi), uses: r6(uses), k, kind: n.kind, components };
}
const ratioOf = (pw, fit) => { const expected = r6(fit.a + fit.b * pw.k); return { expected, ratio: r6(pw.value / Math.max(1e-6, expected)) }; };

// ------------------------------------------------------------------ logic audit
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hex = (a, b) => (Math.abs(a.tile_q - b.tile_q) + Math.abs(a.tile_r - b.tile_r) + Math.abs(a.tile_q + a.tile_r - b.tile_q - b.tile_r)) / 2;
const side = (al) => (al === 'npc_b' ? 'B' : al === 'player_c' || al === 'npc_c' ? 'C' : 'A');
const LIB_CARDS = [{ effect_id: 'effect_fireball', elements: ['elem_fire', 'elem_air'] }, { effect_id: 'effect_frost', elements: ['elem_water'] }, { effect_id: 'effect_quake', elements: ['elem_earth', 'elem_earth'] }];
// A seeded mini world: 3..8 units on a 9×9 patch, the class under audit on unit 0.
function auditWorld(seed, n) {
  const f = mulberry32(seed * 2654435761 >>> 0), int = (m) => Math.floor(f() * m), pick = (a) => a[int(a.length)];
  const view = new Map();
  const count = 3 + int(6);
  for (let i = 0; i < count; i++) {
    const id = `peer:u${i}`;
    const creature = i > 0 && f() < 0.4;
    view.set(id, {
      peer_id: id, name: `U${i}`, tile_q: int(9) - 4, tile_r: int(9) - 4, life: i > 0 && f() < 0.2 ? 0 : 1 + int(4),
      alliance: i === 0 ? 'player' : pick(['player', 'npc_a', 'npc_b', 'npc_b']), armor: f() < 0.3 ? 1 : 0,
      creature_id: creature ? pick(['mon_wolf', 'mon_bat']) : '', character_id: creature ? '' : 'char_x', monster_state: creature ? pick(['sleeping', 'awake']) : '',
      owner_peer_id: '', reanimated_csv: '', tile_tokens_json: '[]', permanents_csv: i === 0 ? n.id : '', class_id: i === 0 ? n.id : '',
      stats: { vitality: int(20), world: int(20), matter: int(20), will: int(20) },
    });
  }
  const ctx = {
    self: 'peer:u0', label: 'audit', view: (id) => view.get(id), viewIds: () => [...view.keys()], viewValues: () => [...view.values()],
    lifeOf: (id) => view.get(id)?.life ?? 0,
    dist: (a, b) => { const x = view.get(a), y = view.get(b); return x && y ? hex(x, y) : Infinity; },
    enemyOf: (a, b) => { const x = view.get(a), y = view.get(b); return !!x && !!y && side(x.alliance) !== side(y.alliance); },
    hasPerm: (id, p) => String(view.get(id)?.permanents_csv || '').split(',').includes(p),
    statOf: (id, st) => view.get(id)?.stats?.[st] ?? 0, sideOf: side,
    classData: () => n.data, skillAction: () => 'A', library: () => LIB_CARDS, elemStat: (el) => ELEM_TO_STAT[el],
    turn: 5, action: 17 + int(9), sha: sha256,
  };
  const ids = [...view.keys()];
  return { view, ctx, ids, f, int, pick };
}
// The audit's argument draws per hook (a compact subset of tools/class-fixtures.mjs#argsFor).
function auditArgs(h, n, Wd) {
  const { ids, f, int, pick, ctx } = Wd;
  const cols = Object.fromEntries([...new Set(n.colours.map(e => ELEM_TO_STAT[e]))].map(st => [st, n.colours.filter(e => ELEM_TO_STAT[e] === st)]));
  const cs = () => ({ class_id: n.id, down: Object.keys(cols).filter(() => f() < 0.3), archived: f() < 0.3, tapped: f() < 0.5, progress: f() < 0.4 ? { mode: pick(['recast', 'untap']), done: Object.keys(cols).filter(() => f() < 0.5) } : null, usedTurn: f() < 0.5 ? ctx.turn : ctx.turn - 1 });
  const stat = pick(['vitality', 'world', 'matter', 'will']);
  switch (h) {
    case 'ready': return { cs: cs(), held: f() < 0.8, turn: ctx.turn };
    case 'strike': { const fail = f() < 0.3; return { cs: cs(), cols, stat, elem: f() < 0.5 ? null : pick(ELEMS), enemy: f() < 0.8, pb: { fail, dice: [1 + int(6)], value: fail ? 0 : 1 + int(6) } }; }
    case 'restore': return { cs: cs(), cols, stat, kind: pick(['recast', 'untap']) };
    case 'progress': return { state: { down: Object.keys(cols).filter(() => f() < 0.3), archived: f() < 0.3, tapped: f() < 0.4, progress: null }, cols: Object.keys(cols), co: { kind: pick(['colour', 'class_destroyed', 'recast', 'untap']), stat: pick(Object.keys(cols)) } };
    case 'life_points': return { dmg: int(4), illusion: int(2), armor: int(2), chaseBonus: int(2) };
    case 'ability': { const kind = pick(['character', 'tile', null]); return { actor: 'peer:u0', ab: { id: n.id, target: kind === 'character' ? { kind, ref: pick(ids) } : kind === 'tile' ? { kind, ref: { q: int(3) - 1, r: int(3) - 1 } } : null, attach: f() < 0.7 ? { card_id: 'c1', kind: 'effect', name: 'Card', effect_id: 'effect_frost', skill_id: null, elements: ['elem_water'] } : null, stat }, salt: `a${int(1e6)}`, moved: f() < 0.3 }; }   // 1.3.0: + moved
    case 'attack_out': return { attacker: 'peer:u0', dmg: int(4), scored: f() < 0.5 ? ['peer:u0'] : [], defender: pick(ids) };   // 1.2.0: + defender
    case 'lifesteal': return { attacker: 'peer:u0', amount: int(4), source: pick(['action', 'effect']), why: pick(['Attack', 'Block', 'P']) };   // 1.2.0: + source / why
    case 'lifesteal_apply': return { amount: int(4), life: 1 + int(3), lifeMax: 4, held: true };
    case 'end_turn': { const mr = [0, 1, 2].filter(() => f() < 0.3); return { held: true, moved: mr.length > 0, life: 1 + int(3), lifeMax: 4, movedRounds: mr }; }   // 1.2.0: + movedRounds
    case 'chase_step': return { state: { chasers: [], bonus: 0 }, chasing: ids.filter(() => f() < 0.4) };
    default: return {};
  }
}
const sum = (l, k) => l.reduce((s, x) => s + (Number(x?.[k]) || 0), 0);
const J1 = (x) => JSON.stringify(x);
// auditLogic(def, n, cal) → { ran, why?, fatal?, exceeds: [..], runs }
export function auditLogic(def, n, cal = loadCalibration()) {
  if (cal.policy.audit === false) return { ran: false, why: 'audit disabled by the calibration', exceeds: [] };
  if (!CL || typeof CL.resolveClassProgram !== 'function') return { ran: false, why: 'game/classes.mjs not available (engine not pinned)', exceeds: [] };
  const exceeds = new Set();
  const P = n.power || {};
  // 1. priced hooks
  for (const h of Object.keys(n.hooks)) {
    if (STD.includes(h)) continue;
    const keys = HOOK_POWER[h];
    if (keys === undefined) exceeds.add(`hook ${h} is not known to the validator`);
    else if (keys && !keys.some(k => P[k] !== undefined)) exceeds.add(`hook ${h} is not priced (power needs one of ${keys.join(', ')})`);
  }
  let prepared;
  try { prepared = JSON.parse(JSON.stringify(def)); CL.validateClassDef(prepared); } catch (e) { return { ran: false, fatal: true, why: `definition does not load: ${e.message}`, exceeds: [] }; }
  const errs = CL.validateClassDef(prepared);
  if (errs.length) return { ran: false, fatal: true, why: `engine rejects the definition: ${errs.join('; ')}`, exceeds: [] };
  const stripped = (h) => { const d = JSON.parse(JSON.stringify(prepared)); delete d.hooks[h]; return d; };
  const N = cal.policy.audit_worlds || 120;
  const run = (d, h, Wd, args) => { try { return CL.resolveClassProgram(d, h, Wd.ctx, args); } catch (e) { return { $throws: String(e.message).slice(0, 80) }; } };
  let runs = 0;
  // 2. std overrides answer as the std default
  for (const h of STD.filter(x => x !== 'config' && n.hooks[x] !== undefined)) {
    const plain = stripped(h);
    for (let s = 0; s < N; s++) {
      const Wd = auditWorld(1000 + s, n), args = auditArgs(h, n, Wd);
      runs++;
      if (JSON.stringify(run(prepared, h, Wd, args)) !== JSON.stringify(run(plain, h, Wd, args))) { exceeds.add(`std hook ${h} differs from the classes_std rule (seed ${1000 + s})`); break; }
    }
  }
  // 3. what the hooks do, per use
  const marker = (h) => isObj(n.hooks[h]) && Object.prototype.hasOwnProperty.call(n.hooks[h], 'engine');
  for (let s = 0; s < N; s++) {
    const Wd = auditWorld(5000 + s, n);
    if (n.hooks.ability !== undefined && !marker('ability')) {
      const r = run(prepared, 'ability', Wd, auditArgs('ability', n, Wd)); runs++;
      if (r?.$throws) { exceeds.add(`ability throws: ${r.$throws}`); continue; }
      const out = r?.out || {};
      const lim = (key, ok, why) => { if (!ok) exceeds.add(why); };
      for (const [k, l] of Object.entries(out)) {
        if (!l.length) continue;
        const healMax = P.heal ? nOf(P.heal) + (isObj(P.heal) ? P.heal.ally || 0 : 0) : 0;
        if (k === 'heals') lim(k, P.heal && sum(l, 'amount') <= healMax, `heals ${sum(l, 'amount')} > power.heal ${healMax}`);
        else if (k === 'armor') lim(k, P.armor && l.length <= P.armor, `armor ${l.length} > power.armor ${P.armor ?? 0}`);
        else if (k === 'illusion') lim(k, P.illusion && l.every(x => x.on === 'peer:u0' || Wd.ctx.dist('peer:u0', x.on) <= P.illusion.range), `illusion beyond power.illusion.range ${P.illusion?.range ?? '-'}`);
        else if (k === 'discards') {   // 1.3.0: my own discards (on the holder) are bounded by power.discard.self
          const mine = l.filter(x => x?.on === 'peer:u0'), theirs = l.filter(x => x?.on !== 'peer:u0');
          lim(k, P.discard && sum(theirs, 'n') <= nOf(P.discard) && sum(mine, 'n') <= (isObj(P.discard) ? P.discard.self || 0 : 0), `discards ${sum(theirs, 'n')} (+${sum(mine, 'n')} own) > power.discard ${P.discard ? J1(P.discard) : 0}`);
        }
        else if (k === 'traps') lim(k, (P.trap || P.plant) && l.length <= 1 && l.every(t => Number(t.power) <= TRAP_POWER), `traps ${l.length} (power ${l.map(t => t.power)}) without power.trap / > 1 / > ${TRAP_POWER}`);
        else if (k === 'tokens') lim(k, P.stone && l.length <= nOf(P.stone) && l.every(t => Number(t.value) <= 6), `tokens ${l.length} without power.stone / > ${P.stone ? nOf(P.stone) : 0} / value > 6`);
        else if (k === 'revives') lim(k, P.revive && l.length <= 1, `revives ${l.length} without power.revive / > 1`);
        else if (k === 'lures') lim(k, P.lure && l.every(x => Wd.ctx.dist('peer:u0', x.on) <= P.lure.range), `lures beyond power.lure.range ${P.lure?.range ?? '-'}`);
        // Class isolation phase 3: the engine requests (class-engine.mjs ABILITY_REQUESTS), priced by the keys the map-bound
        // classes always had — one request per use, never more than the power declares.
        else if (k === 'copy_building') lim(k, P.build && l.length <= 1, `copy_building ${l.length} without power.build / > 1`);
        else if (k === 'build') lim(k, P.build && l.length <= 1 && l.every(x => Number(x.heal ?? 1) <= (isObj(P.build) && P.build.heal ? P.build.heal : 1) && (!isObj(P.build) || !P.build.max || (Number.isInteger(x.max_standing) && x.max_standing <= P.build.max))), `build ${J1(l)} beyond power.build ${P.build ? J1(P.build) : '-'}`);
        else if (k === 'far_trap') lim(k, P.plant && l.length <= 1 && (!isObj(P.plant) || !P.plant.max || l.every(x => Number.isInteger(x.max_standing) && x.max_standing <= P.plant.max)), `far_trap ${J1(l)} beyond power.plant ${P.plant ? J1(P.plant) : '-'}`);
        else if (k === 'disable_traps') lim(k, P.disable_traps && l.length <= 1 && l.every(x => Number(x.radius) <= (isObj(P.disable_traps) ? P.disable_traps.range ?? 0 : 0)), `disable_traps ${J1(l)} beyond power.disable_traps ${P.disable_traps ? J1(P.disable_traps) : '-'}`);
        else if (k === 'step') lim(k, P.relocate && l.length <= 1 && l.every(x => Number(x.n ?? 1) <= 1), `step ${J1(l)} without power.relocate / more than 1 hex`);
        else exceeds.add(`ability output ${k} is not priced`);
      }
    }
    const num = (h) => { if (n.hooks[h] === undefined) return null; const a = auditArgs(h, n, Wd); runs++; return { a, r: run(prepared, h, Wd, a) }; };
    let x;
    if ((x = num('attack_out')) && !(Number(x.r) - x.a.dmg <= (P.attack_bonus ? nOf(P.attack_bonus) : 0))) exceeds.add(`attack_out +${Number(x.r) - x.a.dmg} > power.attack_bonus ${P.attack_bonus ? nOf(P.attack_bonus) : 0}`);
    if ((x = num('end_turn')) && !(Number(x.r) <= (P.regen ? nOf(P.regen) : 0))) exceeds.add(`end_turn +${x.r} > power.regen ${P.regen ? nOf(P.regen) : 0}`);
    if ((x = num('lifesteal')) && !(Number(x.r) <= (P.lifesteal ? x.a.amount : 0))) exceeds.add(`lifesteal ${x.r} > the damage dealt ${x.a.amount}`);
    if ((x = num('lifesteal_apply')) && !(Number(x.r) - x.a.life <= (P.lifesteal ? (isObj(P.lifesteal) && P.lifesteal.max ? Math.min(x.a.amount, P.lifesteal.max) : x.a.amount) : 0))) exceeds.add(`lifesteal_apply +${Number(x.r) - x.a.life} > the damage dealt (or power.lifesteal.max)`);
    if ((x = num('chase_step')) && !(Number(x.r?.grant) <= (P.chase_bonus?.life || 0) && Number(x.r?.bonus) <= (P.chase_bonus?.max ?? P.chase_bonus?.life ?? 0))) exceeds.add(`chase_step grant ${x.r?.grant} / bonus ${x.r?.bonus} > power.chase_bonus`);
    if (x && P.chase_bonus?.max_only && Number(x.r?.heal) > 0) exceeds.add(`chase_step heal ${x.r?.heal} > 0 (power.chase_bonus.max_only)`);   // 1.3.0
    if (s === 0 && (x = num('local')) && x.r) {
      const op = x.r.op;
      if (op === 'draw' && !(Number(x.r.n) <= (P.draw ? nOf(P.draw) : 0))) exceeds.add(`local draw ${x.r.n} > power.draw ${P.draw ? nOf(P.draw) : 0}`);
      if (op === 'draw' && isObj(P.draw) && P.draw.hand_max && !(Number.isInteger(x.r.max_hand) && x.r.max_hand <= P.draw.hand_max)) exceeds.add(`local draw max_hand ${x.r.max_hand} beyond power.draw.hand_max ${P.draw.hand_max}`);
      if (op === 'recover' && !P.recover) exceeds.add('local recover without power.recover');
      if (op === 'grant' && !P.grant) exceeds.add('local grant without power.grant');
    }
  }
  // 4. 1.1.0 (3): stance / emits / plan_emits answer only for the codes their power key covers (priced per code).
  const ALL_CODES = ['A', 'B', 'M', 'P', 'EM', 'EP'];
  const covers = (key) => (P[key] === undefined ? [] : typeof P[key] === 'number' ? null : codesOf(key, P[key]) || []);
  for (let s = 0; s < Math.min(N, 12); s++) {
    const Wd = auditWorld(9000 + s, n);
    const on = (h) => n.hooks[h] !== undefined && !marker(h);
    if (on('stance')) {
      const cov = covers('stance');
      for (const code of ALL_CODES) { const r = run(prepared, 'stance', Wd, { code }); runs++; if (r !== null && r !== undefined && !r?.$throws && !cov.includes(code)) exceeds.add(`stance turns ${code} (power.stance covers ${cov.join(', ') || 'none'})`); }
    }
    if (on('emits')) {
      const cov = covers('emit');
      const extra = new Set();
      for (const code of ALL_CODES) for (const site of ['plan', 'destroy', 'manip', 'badge']) { const r = run(prepared, 'emits', Wd, { code, site }); runs++; if (r === true && code !== 'P' && code !== 'EP' && !(cov || []).includes(code)) extra.add(code); }
      if (cov === null ? extra.size > P.emit : extra.size) exceeds.add(`emits on ${[...extra].sort().join(', ')} beyond power.emit ${JSON.stringify(P.emit ?? null)}`);
    }
    if (on('plan_emits')) {
      const cov = covers('plan_emit');
      for (const code of ALL_CODES) { const r = run(prepared, 'plan_emits', Wd, { held: true, archived: false, usedTurn: Wd.ctx.turn - 1, turn: Wd.ctx.turn, options: false, code, queued: true }); runs++; if (r === true && !cov.includes(code)) exceeds.add(`plan_emits on ${code} (power.plan_emit covers ${cov.join(', ') || 'none'})`); }
    }
  }
  return { ran: true, engine: 'game/classes.mjs#resolveClassProgram', runs, N, exceeds: [...exceeds].sort() };
}

// ------------------------------------------------------------------ check
export function checkClass(def, opts = {}) {
  const cal = opts.calibration || loadCalibration();
  const pin = computePin(cal);
  const tol = Number.isFinite(opts.tolerance) ? opts.tolerance : (Number.isFinite(cal.policy.tolerance) ? cal.policy.tolerance : DEFAULT_TOLERANCE);
  const n = normalizeDef(def);
  const def_sha256 = sha256(canonicalJson(isObj(def) ? def : null));
  const base = { validator: { version: VALIDATOR_VERSION, pin_id: pin.pin_id }, class_id: n.id ?? null, def_sha256, tolerance: tol };
  const stamp = (verdict, ratio) => ({ class_id: n.id ?? null, def_sha256, pin_id: pin.pin_id, verdict, ratio, tolerance: tol });
  const reject = (errors, reasons, extra = {}) => ({ ...base, valid: !errors.length, errors, ...extra, verdict: 'reject', reasons, suggestions: [], stamp: stamp('reject', null) });
  const errors = validateNorm(n, cal);
  if (errors.length) return reject(errors, ['invalid definition']);
  if (!cal.fit) throw new Error('calibration has no fit — run `node tools/classes-rebalancing-check.mjs calibrate --write`');
  const audit = auditLogic(def, n, cal);
  if (audit.fatal || audit.exceeds.length) return reject([], audit.exceeds.length ? audit.exceeds.map(x => `logic exceeds its declared power — ${x}`) : [audit.why], { audit });
  const pw = powerOf(n, cal);
  const { expected, ratio } = ratioOf(pw, cal.fit);
  let baseline = null;
  let bref = opts.baseline;
  if (bref === undefined) bref = cal.builtins?.[n.id] ? n.id : (n.extends && cal.builtins?.[n.extends] ? n.extends : null);
  if (typeof bref === 'string') {
    const b = cal.builtins?.[bref];
    if (!b) return reject([`baseline ${bref} is not a calibrated built-in`], ['bad baseline']);
    baseline = { id: bref, value: b.value, k: b.k, ratio: b.ratio };
  } else if (isObj(bref)) {
    const bn = normalizeDef(bref), be = validateNorm(bn, cal);
    if (be.length) return reject(be.map(e => `baseline: ${e}`), ['bad baseline']);
    const bp = powerOf(bn, cal);
    baseline = { id: bn.id, value: bp.value, k: bp.k, ratio: ratioOf(bp, cal.fit).ratio };
  }
  const judged = baseline ? r6(ratio / Math.max(1e-6, baseline.ratio)) : ratio;
  const bv = bandVerdict(judged, tol, cal.policy.hard_cap_ratio, cal.policy.hard_floor_ratio, baseline ? 'baseline' : 'colour curve');
  const suggestions = [];
  if (bv.verdict !== 'ok') {
    const goal = (baseline ? baseline.ratio : 1) * expected;
    suggestions.push({ change: `scale the power ×${r3(goal / Math.max(1e-6, pw.value))} (to ${r3(goal)})`, kind: 'hint' });
    for (const dk of [-1, 1]) {
      const k2 = pw.k + dk;
      if (k2 < 1 || k2 > ELEMS.length) continue;
      const p2 = powerOf({ ...n, k: k2 }, cal), j = r6(ratioOf(p2, cal.fit).ratio / (baseline ? baseline.ratio : 1));
      if (Math.sign(j - judged) === (judged > 1 ? -1 : 1)) suggestions.push({ change: `${dk > 0 ? 'add' : 'drop'} a colour (k ${pw.k} → ${k2})`, ratio: j, in_band: j >= bv.lo && j <= bv.hi });
    }
  }
  return {
    ...base, valid: true, errors: [], mode: baseline ? 'baseline' : 'curve',
    power: { ...pw, expected, ratio }, baseline, judged_ratio: judged,
    band: { low: bv.lo, high: bv.hi, hard_cap: cal.policy.hard_cap_ratio, hard_floor: cal.policy.hard_floor_ratio },
    audit: audit.ran ? { ran: true, engine: audit.engine, runs: audit.runs, N: audit.N, exceeds: [] } : { ran: false, why: audit.why },
    verdict: bv.verdict, reasons: [bv.reason], suggestions, stamp: stamp(bv.verdict, judged),
  };
}

// ------------------------------------------------------------------ built-ins + calibration
export function loadBuiltinDefs() {
  const dir = path.join(GAME, 'classes-data', 'classes');
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => readJson(path.join(dir, f)));
}
// 1.1.0 (6): the grants table — V of every grantable effect and the mean V of the built-in effects, read off the
// effects validator's calibration (tools/rebalancing-calibration.json, E5) at calibrate time only; checkClass reads
// the frozen copy here (self-contained). Only the effects a class may grant are copied (GRANTABLE).
export const EFFECTS_CALIBRATION_PATH = path.join(HERE, 'rebalancing-calibration.json');
export const GRANTABLE = ['effect_summoning'];
export function grantsTable(file = EFFECTS_CALIBRATION_PATH) {
  const ec = readJson(file);
  const vals = Object.keys(ec.builtins || {}).sort().map(id => ec.builtins[id].value).filter(Number.isFinite);
  let tot = 0; for (const x of vals) tot += x;
  return {
    source: 'game/tools/rebalancing-calibration.json (effects validator builtins.value)',
    source_sha256: sha256(canonicalJson(ec)),
    mean_value: r6(vals.length ? tot / vals.length : 0), n: vals.length,
    effects: Object.fromEntries(GRANTABLE.filter(id => Number.isFinite(ec.builtins?.[id]?.value)).map(id => [id, ec.builtins[id].value])),
  };
}
export function calibrate(cal0 = loadCalibration()) {
  const cal = { ...cal0, grants: grantsTable() };
  const defs = loadBuiltinDefs();
  const pts = defs.map(d => { const n = normalizeDef(d); return { id: n.id, n, pw: powerOf(n, cal) }; });
  const ols = fitCurve(pts.map(p => ({ C: p.pw.k, V: p.pw.value })), { drop: cal.policy.fit_drop ?? 0.6, minKeep: 5 });
  // 1.3.0: a locked fair line (policy.fit_locked) is kept as accepted; the OLS refit is only reported (calibrate CLI).
  const fit = cal.policy.fit_locked && cal0.fit ? cal0.fit : ols;

  const builtins = {};
  for (const p of pts) { const e = r6(fit.a + fit.b * p.pw.k); builtins[p.id] = { k: p.pw.k, kind: p.pw.kind, value: p.pw.value, ratio: r6(p.pw.value / Math.max(1e-6, e)) }; }
  const out = { ...cal, fit, builtins };
  if (cal.policy.fit_locked) Object.defineProperty(out, 'refit', { value: ols, enumerable: false });   // 1.3.0: reported, never written
  return out;
}
export function report(cal = loadCalibration()) {
  return loadBuiltinDefs().map(d => {
    const n = normalizeDef(d), pw = powerOf(n, cal), { expected, ratio } = ratioOf(pw, cal.fit);
    const bv = bandVerdict(ratio, cal.policy.tolerance, cal.policy.hard_cap_ratio, cal.policy.hard_floor_ratio, 'colour curve');
    return { id: n.id, kind: n.kind, k: pw.k, value: pw.value, expected, ratio, curve_verdict: bv.verdict, keys: Object.keys(pw.components) };
  });
}

// ------------------------------------------------------------------ CLI
const resolveDef = (a) => {
  if (fs.existsSync(a)) return readJson(a);
  const f = path.join(GAME, 'classes-data', 'classes', `${a}.json`);
  if (fs.existsSync(f)) return readJson(f);
  throw new Error(`no definition file or built-in class ${a}`);
};
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const json = rest.includes('--json');
  const out = (o, txt) => console.log(json ? JSON.stringify(o, null, 2) : txt);
  try {
    if (cmd === 'check') {
      const def = resolveDef(rest.find(a => !a.startsWith('--') && a !== opt('--baseline') && a !== opt('--tolerance')));
      const b = opt('--baseline');
      const res = checkClass(def, { baseline: rest.includes('--no-baseline') ? null : b ? (fs.existsSync(b) ? readJson(b) : b) : undefined, tolerance: opt('--tolerance') !== undefined ? Number(opt('--tolerance')) : undefined });
      out(res, `${res.class_id}: ${res.verdict} — ${res.reasons.join('; ')}${res.power ? `  (V ${res.power.value}, k ${res.power.k}, curve ${res.power.expected}, ratio ${res.power.ratio}${res.baseline ? `, baseline ${res.baseline.id} ${res.baseline.ratio}` : ''}; audit ${res.audit.ran ? `${res.audit.runs} runs` : res.audit.why})` : ''}${(res.errors || []).length ? `\n  ${res.errors.join('\n  ')}` : ''}${res.suggestions.length ? `\n  suggestions: ${res.suggestions.map(s => s.change).join(' | ')}` : ''}`);
      process.exit(res.verdict === 'ok' ? 0 : 1);
    } else if (cmd === 'report') {
      const rows = report();
      out(rows, rows.map(r => `${r.id.padEnd(22)} ${String(r.kind).padEnd(15)} k=${r.k} V=${String(r.value).padEnd(10)} V̂=${String(r.expected).padEnd(10)} r=${String(r.ratio).padEnd(9)} ${r.curve_verdict.padEnd(6)} ${r.keys.join(',')}`).join('\n'));
    } else if (cmd === 'calibrate') {
      const c = calibrate();
      if (c.refit) console.log(`fair line LOCKED (policy.fit_locked ${c.policy.fit_locked}): kept a=${c.fit.a} b=${c.fit.b}; an OLS refit would give a=${c.refit.a} b=${c.refit.b} (fit on ${c.refit.n_fit})`);
      if (rest.includes('--write')) { fs.writeFileSync(CALIBRATION_PATH, JSON.stringify(c, null, 2) + '\n'); console.log(`calibration written: a=${c.fit.a} b=${c.fit.b} (n=${c.fit.n}, fit on ${c.fit.n_fit})`); }
      else out(c, `fit a=${c.fit.a} b=${c.fit.b} (n=${c.fit.n}, fit on ${c.fit.n_fit}) — not written (--write)`);
    } else if (cmd === 'audit') {
      const def = resolveDef(rest.find(a => !a.startsWith('--')));
      const a = auditLogic(def, normalizeDef(def));
      out(a, `${def.id}: ${a.ran ? `${a.runs} runs, ${a.exceeds.length ? `EXCEEDS:\n  ${a.exceeds.join('\n  ')}` : 'within its power'}` : `not run — ${a.why}`}`);
      process.exit(a.fatal || a.exceeds.length ? 1 : 0);
    } else if (cmd === 'pin') {
      const p = computePin();
      const w = opt('--write');
      if (w) { fs.writeFileSync(w, JSON.stringify(p, null, 2) + '\n'); console.log(`pin ${p.pin_id} written to ${w}`); }
      else console.log(JSON.stringify(p, null, 2));
    } else {
      console.error('usage: classes-rebalancing-check.mjs check <def|id> [--baseline b] [--no-baseline] [--tolerance t] [--json] | report | calibrate [--write] | audit <def|id> | pin [--write path]');
      process.exit(2);
    }
  } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
}
