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
//   uses       tap: 1 + (A − 1) / (1 + k / p_restore) (untap = every colour emitted again);
//              once_per_round / passive / static: one per turn (turns)
//   power      the class's POWER vocabulary (BUILTIN_POWER for the built-ins, `power` in a foreign definition):
//              each key has a trigger — `use` (× uses), `action` (× A), `turn` (× turns) — and a per-trigger value
//              from the calibration weights and odds (VALUE below)
//   V          = φ(k) · Σ value(key)
// curve V̂(k) = a + b·k (fitCurve of rebalancing-core over the built-ins). ratio r = V / V̂(k). TOLERANCE ±10 %
// (user ruling 2026-11-16, as the effects and skills validators). VERDICT: reject (schema / r > hard cap / r < floor /
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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CORE_VERSION, r6, r3, sha256, isObj, canonicalJson, fileSha, readJson, pointBuyStats, fitCurve, bandVerdict } from './rebalancing-core.mjs';

export { canonicalJson };
export const VALIDATOR_VERSION = '1.0.0';
export const DEFAULT_TOLERANCE = 0.10;   // user ruling 2026-11-16
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
  discard:       { trigger: 'use',    shape: 'n' },        // an enemy discards n random hand cards
  stone:         { trigger: 'use',    shape: 'true' },     // a point-buy stat bonus token on my tile
  trap:          { trigger: 'use',    shape: 'true' },     // a trap of TRAP_POWER (Library or hand card)
  plant:         { trigger: 'use',    shape: 'true' },     // a hand effect as a far trap + vision
  lure:          { trigger: 'use',    shape: 'range' },    // wild monsters within range chase me
  revive:        { trigger: 'use',    shape: 'true' },     // a fallen ally creature rises
  build:         { trigger: 'use',    shape: 'true' },     // a building (copy / shrine) rises
  disable_traps: { trigger: 'use',    shape: 'range' },    // every foreign trap within range is gone
  draw:          { trigger: 'use',    shape: 'n' },        // draw n cards
  recover:       { trigger: 'use',    shape: 'n' },        // n cards discard pile → hand
  grant:         { trigger: 'use',    shape: 'true' },     // an effect (Summoning) granted
  plan_emit:     { trigger: 'use',    shape: 'true' },     // emit an element during a non-Posture action
  attack_bonus:  { trigger: 'action', shape: 'n' },        // +n combat damage once I scored this round
  lifesteal:     { trigger: 'action', shape: 'true' },     // heal the combat damage I deal
  stance:        { trigger: 'action', shape: 'true' },     // Empty Posture fights as another action
  emit:          { trigger: 'action', shape: 'n' },        // n more action codes emit elements
  trap_disable:  { trigger: 'action', shape: 'true' },     // stepping on a building trap disables it
  share_skills:  { trigger: 'action', shape: 'true' },     // adjacent allies use my skills too
  take_tokens:   { trigger: 'action', shape: 'true' },     // destroyed tokens become mine
  transmute:     { trigger: 'action', shape: 'true' },     // a nearby ally's stat / heal cast works on me too
  relocate:      { trigger: 'action', shape: 'true' },     // move a nearby unit one hex at the end of a round
  regen:         { trigger: 'turn',   shape: 'n' },        // +n life at the end of an unmoved turn
  trap_dodge:    { trigger: 'turn',   shape: 'n' },        // n trap steps per turn do not trigger
  threat_dodge:  { trigger: 'turn',   shape: 'n' },        // n threatened moves per turn are stealthy
  reroll:        { trigger: 'turn',   shape: 'true' },     // a point-buy die added to a damage spell
  swap:          { trigger: 'turn',   shape: 'true' },     // a nearby enemy's action is swapped before it hits me
  reveal:        { trigger: 'turn',   shape: 'true' },     // an adjacent enemy's hand opens
  chase_bonus:   { trigger: 'turn',   shape: 'life' },     // +life max while monsters chase me
};
// Built-in power, read off peer.mjs / classes.mjs on 2026-11-16 (the logic audit proves the data-run ones).
export const BUILTIN_POWER = {
  class_alchemist: { trap: true },
  class_animator: { build: true },
  class_assassin: { attack_bonus: 1 },
  class_avenger: { lure: { range: 10 }, chase_bonus: { life: 1, max: 1 } },
  class_barbarian: { stance: true, emit: 1 },   // ruling 2026-11-16: may emit during Block (B)
  class_bard: { share_skills: true },
  class_cleric: { disable_traps: { range: 3 }, trap_disable: true },
  class_druid: { stone: true },
  class_elementalist: { reroll: true },
  class_enchanter: { plan_emit: true },
  class_guardian: { regen: 1 },
  class_healer: { heal: 1 },
  class_illusionist: { illusion: { range: 10 } },
  class_kensei: { recover: 1 },
  class_manipulator: { swap: true },
  class_monk: { stance: true, emit: 2 },   // ruling 2026-11-16: Move and Empty Move emit at every site
  class_necromancer: { revive: true },
  class_noble: { lifesteal: true },
  class_overlord: { armor: 1 },
  class_paladin: { recover: 1 },
  class_priest: { build: true },
  class_prophet: { reveal: true },
  class_ranger: { trap: true },
  class_reaver: { stance: true, emit: 1 },
  class_restaurateur: { take_tokens: true },
  class_rogue: { trap_dodge: 1, threat_dodge: 1 },
  class_seeker: { plant: true },
  class_shaman: { recover: 1 },
  class_summoner: { grant: true },
  class_transmuter: { transmute: true },
  class_warrior: { relocate: true },
  class_weapon_master: { draw: 1 },
  class_witch: { discard: 3 },
};
// A non-std hook is priced by any of these keys (the ability by its output keys, see auditAbility).
export const HOOK_POWER = {
  ability: ['heal', 'armor', 'illusion', 'discard', 'stone', 'trap', 'plant', 'lure', 'revive', 'build', 'disable_traps', 'relocate'],
  config: null,   // knobs only
  stance: ['stance'], stance_target: ['stance'], emits: ['emit', 'stance'], plan_emits: ['plan_emit'],
  attack_out: ['attack_bonus'], lifesteal: ['lifesteal'], lifesteal_apply: ['lifesteal'],
  pre_cast: ['reroll'], transmute: ['transmute'], destroy_result: ['take_tokens'], end_turn: ['regen'],
  step: ['trap_dodge', 'threat_dodge', 'trap_disable'], dungeon_step: ['trap_dodge', 'trap_disable'],
  combat_in: ['swap'], pick_target: ['swap'], chase_step: ['chase_bonus'], contact: ['reveal'],
  local: ['draw', 'recover', 'grant'], share_skills: ['share_skills'],
  // Necromancer destroy reanimated (ruling 2026-11-16): a way for ENEMIES to destroy what the class raised — a drawback
  // on power.revive, never a gain (the neutral answer, null, is the strongest), so it needs no price of its own.
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
export function validateNorm(n) {
  const errors = [];
  if (typeof n.id !== 'string' || !/^class_[a-z0-9_]+$/.test(n.id)) errors.push('id must match class_[a-z0-9_]+');
  if (n.extends !== null && !BUILTIN_POWER[n.extends]) errors.push(`extends ${n.extends}: not a built-in class`);
  if (!KINDS.includes(n.kind)) errors.push(`data.ability_kind must be ${KINDS.join('|')}`);
  if (!n.k || !n.colours.every(e => ELEMS.includes(e)) || new Set(n.colours).size !== n.k) errors.push('data.colors must be a non-empty list of distinct elements');
  if (!n.power) errors.push('power required (a foreign class declares what it does: see POWER_KEYS)');
  else {
    if (!Object.keys(n.power).length) errors.push('power is empty (the class does nothing)');
    for (const [key, v] of Object.entries(n.power)) {
      const pk = POWER_KEYS[key];
      if (!pk) { errors.push(`power.${key}: unknown key (${Object.keys(POWER_KEYS).join(', ')})`); continue; }
      const ok = pk.shape === 'n' ? posInt(v) : pk.shape === 'true' ? v === true : pk.shape === 'range' ? isObj(v) && Number.isInteger(v.range) && v.range >= 0 && v.range <= 64 : isObj(v) && posInt(v.life) && posInt(v.max ?? v.life);
      if (!ok) errors.push(`power.${key}: must be ${pk.shape === 'n' ? 'an integer 1..20' : pk.shape === 'true' ? 'true' : pk.shape === 'range' ? '{range: 0..64}' : '{life, max} (1..20)'}`);
    }
  }
  return errors;
}

// ------------------------------------------------------------------ the model
const allies = (G, range) => r6(G.allies_max * range / (range + G.allies_half));
// Value of one power key per trigger (calibration weights W, odds G).
export function keyValue(key, v, G, W) {
  const pbOk = pointBuyStats(G.stat_mean);
  const n = typeof v === 'number' ? v : 1;
  switch (key) {
    case 'heal': return n * W.life * G.p_hurt;
    case 'armor': return n * W.shield;
    case 'illusion': return (1 + allies(G, v.range)) * W.illusion;
    case 'discard': return n * W.card * G.p_enemy_near;
    case 'stone': return pbOk.p * pbOk.ev * W.stat_point;
    case 'trap': return TRAP_POWER / 20 * W.trap * G.p_trap_springs;
    case 'plant': return W.trap * G.p_trap_springs * G.p_far_trap + W.vision;
    case 'lure': return allies(G, v.range) * G.monsters_per_ally * W.lure;
    case 'revive': return W.revive * G.p_fallen_near;
    case 'build': return W.building;
    case 'disable_traps': return allies(G, v.range) * G.traps_per_ally * W.disable;
    case 'draw': return n * W.card;
    case 'recover': return n * W.recover;
    case 'grant': return W.grant;
    case 'plan_emit': return W.emit;
    case 'attack_bonus': return n * W.life * G.p_combat * G.p_scored;
    case 'lifesteal': return W.lifesteal * G.p_combat * G.dmg_per_hit * G.p_hurt;
    case 'stance': return W.stance * G.p_empty_posture;
    case 'emit': return n * W.emit * G.p_code;
    case 'trap_disable': return W.disable * G.p_trap_step;
    case 'share_skills': return W.skill * G.p_skill_use * G.adjacent_allies;
    case 'take_tokens': return W.take * G.p_destroy_near;
    case 'transmute': return W.transmute * G.p_ally_cast;
    case 'relocate': return W.relocate;
    case 'regen': return n * W.life * G.p_unmoved * G.p_hurt;
    case 'trap_dodge': return n * W.trap * G.p_trap_turn;
    case 'threat_dodge': return n * W.threat;
    case 'reroll': return W.stat_point * pbOk.p * pbOk.ev * G.p_damage_spell;
    case 'swap': return W.swap * G.p_combat_taken;
    case 'reveal': return W.info * G.p_contact;
    case 'chase_bonus': return Math.min(v.life, v.max ?? v.life) * W.life * G.p_chased;
    default: return 0;
  }
}
export function powerOf(n, cal) {
  const G = cal.game, W = cal.weights;
  const A = G.turns * G.actions_per_turn;
  const k = n.k;
  const L = k / G.p_strike, R = k / G.p_restore;
  const phi = L >= A ? 1 : (L + (A - L) * L / (L + R)) / A;
  const uses = n.kind === 'tap' ? 1 + (A - 1) / (1 + k / G.p_restore) : G.turns;
  const components = {};
  let sum = 0;
  for (const [key, v] of Object.entries(n.power)) {
    const t = POWER_KEYS[key].trigger;
    const per = keyValue(key, v, G, W);
    const times = t === 'use' ? uses : t === 'action' ? A : G.turns;
    const x = r6(per * times);
    components[key] = { trigger: t, per: r6(per), times: r6(times), value: x };
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
    case 'ability': { const kind = pick(['character', 'tile', null]); return { actor: 'peer:u0', ab: { id: n.id, target: kind === 'character' ? { kind, ref: pick(ids) } : kind === 'tile' ? { kind, ref: { q: int(3) - 1, r: int(3) - 1 } } : null, attach: f() < 0.7 ? { card_id: 'c1', kind: 'effect', name: 'Card', effect_id: 'effect_frost', skill_id: null, elements: ['elem_water'] } : null, stat }, salt: `a${int(1e6)}` }; }
    case 'attack_out': return { attacker: 'peer:u0', dmg: int(4), scored: f() < 0.5 ? ['peer:u0'] : [] };
    case 'lifesteal': return { attacker: 'peer:u0', amount: int(4) };
    case 'lifesteal_apply': return { amount: int(4), life: 1 + int(3), lifeMax: 4, held: true };
    case 'end_turn': return { held: true, moved: f() < 0.5, life: 1 + int(3), lifeMax: 4 };
    case 'chase_step': return { state: { chasers: [], bonus: 0 }, chasing: ids.filter(() => f() < 0.4) };
    default: return {};
  }
}
const sum = (l, k) => l.reduce((s, x) => s + (Number(x?.[k]) || 0), 0);
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
        if (k === 'heals') lim(k, P.heal && sum(l, 'amount') <= P.heal, `heals ${sum(l, 'amount')} > power.heal ${P.heal ?? 0}`);
        else if (k === 'armor') lim(k, P.armor && l.length <= P.armor, `armor ${l.length} > power.armor ${P.armor ?? 0}`);
        else if (k === 'illusion') lim(k, P.illusion && l.every(x => x.on === 'peer:u0' || Wd.ctx.dist('peer:u0', x.on) <= P.illusion.range), `illusion beyond power.illusion.range ${P.illusion?.range ?? '-'}`);
        else if (k === 'discards') lim(k, P.discard && sum(l, 'n') <= P.discard, `discards ${sum(l, 'n')} > power.discard ${P.discard ?? 0}`);
        else if (k === 'traps') lim(k, (P.trap || P.plant) && l.length <= 1 && l.every(t => Number(t.power) <= TRAP_POWER), `traps ${l.length} (power ${l.map(t => t.power)}) without power.trap / > 1 / > ${TRAP_POWER}`);
        else if (k === 'tokens') lim(k, P.stone && l.length <= 1 && l.every(t => Number(t.value) <= 6), `tokens ${l.length} without power.stone / > 1 / value > 6`);
        else if (k === 'revives') lim(k, P.revive && l.length <= 1, `revives ${l.length} without power.revive / > 1`);
        else if (k === 'lures') lim(k, P.lure && l.every(x => Wd.ctx.dist('peer:u0', x.on) <= P.lure.range), `lures beyond power.lure.range ${P.lure?.range ?? '-'}`);
        else exceeds.add(`ability output ${k} is not priced`);
      }
    }
    const num = (h) => { if (n.hooks[h] === undefined) return null; const a = auditArgs(h, n, Wd); runs++; return { a, r: run(prepared, h, Wd, a) }; };
    let x;
    if ((x = num('attack_out')) && !(Number(x.r) - x.a.dmg <= (P.attack_bonus || 0))) exceeds.add(`attack_out +${Number(x.r) - x.a.dmg} > power.attack_bonus ${P.attack_bonus || 0}`);
    if ((x = num('end_turn')) && !(Number(x.r) <= (P.regen || 0))) exceeds.add(`end_turn +${x.r} > power.regen ${P.regen || 0}`);
    if ((x = num('lifesteal')) && !(Number(x.r) <= (P.lifesteal ? x.a.amount : 0))) exceeds.add(`lifesteal ${x.r} > the damage dealt ${x.a.amount}`);
    if ((x = num('lifesteal_apply')) && !(Number(x.r) - x.a.life <= (P.lifesteal ? x.a.amount : 0))) exceeds.add(`lifesteal_apply +${Number(x.r) - x.a.life} > the damage dealt`);
    if ((x = num('chase_step')) && !(Number(x.r?.grant) <= (P.chase_bonus?.life || 0) && Number(x.r?.bonus) <= (P.chase_bonus?.max ?? P.chase_bonus?.life ?? 0))) exceeds.add(`chase_step grant ${x.r?.grant} / bonus ${x.r?.bonus} > power.chase_bonus`);
    if (s === 0 && (x = num('local')) && x.r) {
      const op = x.r.op;
      if (op === 'draw' && !(Number(x.r.n) <= (P.draw || 0))) exceeds.add(`local draw ${x.r.n} > power.draw ${P.draw || 0}`);
      if (op === 'recover' && !P.recover) exceeds.add('local recover without power.recover');
      if (op === 'grant' && !P.grant) exceeds.add('local grant without power.grant');
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
  const errors = validateNorm(n);
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
    const bn = normalizeDef(bref), be = validateNorm(bn);
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
export function calibrate(cal = loadCalibration()) {
  const defs = loadBuiltinDefs();
  const pts = defs.map(d => { const n = normalizeDef(d); return { id: n.id, n, pw: powerOf(n, cal) }; });
  const fit = fitCurve(pts.map(p => ({ C: p.pw.k, V: p.pw.value })), { drop: cal.policy.fit_drop ?? 0.6, minKeep: 5 });
  const builtins = {};
  for (const p of pts) { const e = r6(fit.a + fit.b * p.pw.k); builtins[p.id] = { k: p.pw.k, kind: p.pw.kind, value: p.pw.value, ratio: r6(p.pw.value / Math.max(1e-6, e)) }; }
  return { ...cal, fit, builtins };
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
