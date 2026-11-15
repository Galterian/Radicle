#!/usr/bin/env node
// rebalancing-check (milestone E5 of the chaosD6-Effects program, user-approved 2026-11-15):
// "a rebalancing_check script to validate should this effect be nerfed or boosted (to apply some
// tolerance based on the increased power level)". Every peer that meets a foreign effect runs this
// and must reach the SAME verdict, so the model is:
//   * analytic and exact — expectations are enumerated over a frozen character pool (no sampling,
//     no Math.log/exp/pow: only + − × ÷ and Math.round, which are bit-exact IEEE everywhere);
//   * self-contained — the verdict depends only on this file and tools/rebalancing-calibration.json
//     (both sha256-pinned, see `pin`), never on data/*.json or effects.mjs at check time.
//
//   node tools/rebalancing-check.mjs check <def.json|effect_id> [--baseline <id|def.json>] [--tolerance 0.2] [--json] [--mc N]
//   node tools/rebalancing-check.mjs report [--json]          every built-in: value, cost, ratio, verdict
//   node tools/rebalancing-check.mjs calibrate [--write]      refit the cost curve on the built-ins (writes fit + builtins + known_outliers)
//   node tools/rebalancing-check.mjs pin [--write <path>]     the validator pin (validator/pin.json for the chaosD6-Effects repo)
//
// Import: `import { checkEffect } from './tools/rebalancing-check.mjs'`;
//   checkEffect(def, { baseline, tolerance, calibration }) → { verdict: ok|nerf|boost|reject, power, ratio, suggestions, stamp, … }
//
// POWER MODEL (unit = one point of life swing). value V = Σ components, each an exact expectation over the
// pool (ordered caster/defender pairs for contests, casters for point-buys):
//   damage  delta: E round(Σ_el max(0, caster − defender)/10); pointbuy: E round(Σ kept dice/10) with the dice
//           conditioned on a successful buy (sum ≤ stat, keep the max) — × scope multiplier (+range bonus)
//   legs    tile token (P die ≥ 5), heal dealt (+D), self damage (−D), locks (actions × act_value), tokens
//           (E die × per-point weight), counters / relocation / surgery / summons / traps / named peer hooks
//   meta    permanent (base × durability = fixedPower or E rerolled die / 6), channel (repeatable legs × extra fires), ∀ every_bonus
// cost C (actions) = emissions × (instant ? instant_action_factor : 1) + expected point-buy retries; stat-buy
//   emissions = round-robin bank until the need is met (exact per caster).
// curve V̂(C) = a + b·C, least squares over the built-ins (`calibrate`). ratio r = V / V̂(C).
// VERDICT: reject (schema / unknown or unbounded op / r > hard_cap_ratio / r < hard_floor_ratio), nerf (r > 1+tol),
//   boost (r < 1−tol), ok. With a baseline (explicit, or automatic when the def has the id of / `extends` a built-in)
//   the band applies to r / r_baseline — a branch is judged against its parent, so an outlier built-in can still be tuned.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VALIDATOR_VERSION = '1.0.0';
export const PIN_FORMAT = 'chaosd6-effects-validator-pin/1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const ROOT = path.resolve(GAME, '..');
export const CALIBRATION_PATH = path.join(HERE, 'rebalancing-calibration.json');
const SELF_PATH = fileURLToPath(import.meta.url);

const r6 = (x) => Math.round(x * 1e6) / 1e6;
const r3 = (x) => Math.round(x * 1e3) / 1e3;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Canonical JSON: sorted keys, no whitespace — the same bytes on every peer whatever the file formatting.
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// ------------------------------------------------------------------ engines (logic audit only)
// The audit runs a definition's `logic` (E1 effect-engine.mjs#resolveEffectData) and the reference behaviour of
// its declared `flags` (effects.mjs#resolveEffect) on the same seeded duels. Both are loaded once here so that
// checkEffect() stays synchronous. Missing engine → no audit (reported, and the pin says so).
const ENGINE_FILES = { effects: path.join(GAME, 'effects.mjs'), effect_engine: path.join(GAME, 'effect-engine.mjs') };
const LIB_DIR = path.join(GAME, 'effects-data', 'lib');
let REF = null, DATA_ENGINE = null;
try { REF = await import(pathToFileURL(ENGINE_FILES.effects).href); } catch { REF = null; }
try { if (fs.existsSync(ENGINE_FILES.effect_engine)) DATA_ENGINE = await import(pathToFileURL(ENGINE_FILES.effect_engine).href); } catch { DATA_ENGINE = null; }
const fileSha = (p) => (fs.existsSync(p) ? sha256(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) : null);
function libsFor(uses) {
  const subs = new Map(), files = [];
  for (const u of uses || []) {
    const p = path.join(LIB_DIR, `${u}.json`);
    if (!fs.existsSync(p)) continue;
    const lib = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
    files.push(lib);
    for (const [k, s] of Object.entries(lib.subs || {})) if (!subs.has(k)) subs.set(k, s);
  }
  return { subs, files };
}
function engineHashes() {
  const libs = fs.existsSync(LIB_DIR) ? fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.json')).sort() : [];
  return {
    'game/effects.mjs': fileSha(ENGINE_FILES.effects),
    'game/effect-engine.mjs': fileSha(ENGINE_FILES.effect_engine),
    ...Object.fromEntries(libs.map(f => [`game/effects-data/lib/${f}`, sha256(canonicalJson(JSON.parse(fs.readFileSync(path.join(LIB_DIR, f), 'utf8').replace(/^﻿/, ''))))])),
  };
}

// ------------------------------------------------------------------ calibration + pin
let _cal = null;
export function loadCalibration(file = CALIBRATION_PATH) {
  if (file === CALIBRATION_PATH && _cal) return _cal;
  const cal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (file === CALIBRATION_PATH) _cal = cal;
  return cal;
}
// sha256 of this file with CRLF → LF (a Windows checkout must pin the same) and of the canonical calibration.
export function computePin(cal = loadCalibration()) {
  const src = fs.readFileSync(SELF_PATH, 'utf8').replace(/\r\n/g, '\n');
  const source_sha256 = sha256(src);
  const calibration_sha256 = sha256(canonicalJson(cal));
  // The audit's verdict depends on the engines, so they are part of the pin (null = absent → audit skipped).
  const audit = cal.policy.audit !== false;
  const engines = audit ? engineHashes() : {};
  const engines_sha256 = sha256(canonicalJson(engines));
  return {
    format: PIN_FORMAT,
    validator: 'rebalancing-check',
    validator_version: VALIDATOR_VERSION,
    source_path: 'game/tools/rebalancing-check.mjs',
    source_sha256,
    calibration_path: 'game/tools/rebalancing-calibration.json',
    calibration_sha256,
    audit,
    engines,
    engines_sha256,
    pin_id: sha256(`${VALIDATOR_VERSION}\n${source_sha256}\n${calibration_sha256}\n${engines_sha256}`),
    policy: { tolerance: cal.policy.tolerance, hard_cap_ratio: cal.policy.hard_cap_ratio, hard_floor_ratio: cal.policy.hard_floor_ratio, audit_slack: cal.policy.audit_slack },
    fit: cal.fit ? { a: cal.fit.a, b: cal.fit.b } : null,
    accept: ['ok'],
    notes: 'A ref (effect branch) is accepted when its stamp.pin_id equals this pin_id and stamp.verdict is in `accept`. Peers re-run checkEffect on the def and compare stamp.def_sha256 + verdict; a different pin_id means a different validator — re-check, do not trust.',
  };
}
// A peer holding a pin from the repo: does my running validator match it?
export function verifyPin(pin, cal = loadCalibration()) {
  const mine = computePin(cal);
  const diffs = ['format', 'validator_version', 'source_sha256', 'calibration_sha256', 'engines_sha256', 'pin_id'].filter(k => pin?.[k] !== mine[k]);
  return { ok: diffs.length === 0, diffs, mine: mine.pin_id, theirs: pin?.pin_id ?? null };
}

// ------------------------------------------------------------------ exact dice maths
// Same as effects.mjs diceCount (Rule 20: 6·n nearest the stat, ties to more dice) — copied so the
// validator's pin does not depend on the engine file.
export function diceCount(stat) {
  let best = 1;
  for (let n = 1; n <= 4; n++) if (Math.abs(6 * n - stat) <= Math.abs(6 * best - stat)) best = n;
  return best;
}
const _pb = new Map();
// Point-buy of `stat`: p = P(sum ≤ stat); dist = value (max die) distribution given success; also the min die (Mutate).
export function pointBuyStats(stat) {
  if (_pb.has(stat)) return _pb.get(stat);
  let res;
  if (!(stat >= 1)) res = { p: 1, ev: 0, evMin: 0, dist: [[0, 1]] };
  else {
    const n = diceCount(stat);
    const dice = new Array(n).fill(1);
    const cnt = [0, 0, 0, 0, 0, 0, 0];
    let ok = 0, total = 0, sumMin = 0;
    for (;;) {
      total++;
      let s = 0, mx = 0, mn = 7;
      for (const d of dice) { s += d; if (d > mx) mx = d; if (d < mn) mn = d; }
      if (s <= stat) { ok++; cnt[mx]++; sumMin += mn; }
      let i = 0;
      while (i < n && dice[i] === 6) { dice[i] = 1; i++; }
      if (i === n) break;
      dice[i]++;
    }
    const dist = [];
    let ev = 0;
    for (let v = 1; v <= 6; v++) if (cnt[v]) { dist.push([v, cnt[v] / ok]); ev += v * cnt[v] / ok; }
    res = { p: ok / total, ev, evMin: ok ? sumMin / ok : 0, dist };
  }
  _pb.set(stat, res);
  return res;
}
// E[round(Σ X_i / 10)] for independent value distributions (exact convolution).
function expRoundSum(dists) {
  let acc = new Map([[0, 1]]);
  for (const d of dists) {
    const next = new Map();
    for (const [s, ps] of acc) for (const [v, pv] of d) next.set(s + v, (next.get(s + v) || 0) + ps * pv);
    acc = next;
  }
  let e = 0;
  for (const s of [...acc.keys()].sort((a, b) => a - b)) e += Math.round(s / 10) * acc.get(s);
  return e;
}

// ------------------------------------------------------------------ definitions
// A definition is accepted in these shapes (E1's game/effects-data/effects/<id>.json is read the same way):
//   { id, element_cost: [elem…], effect_types: [..], every_bonus?, stat_buy_total?, extends?, rule: { EFFECT_RULES keys } }
//   { id, data: { element_cost, effect_types, every_bonus? … }, rule|engine: {…} }
//   { id, versions: [...] } (a data/effects.json entry) + rule
// `rule` may also be spelled `engine` / `ops` / `resolve` (object form only).
export const RULE_KEYS = {
  damage: (v) => v === 'delta' || v === 'pointbuy',
  scope: (v) => ['target', 'all_enemies', 'all_adjacent', 'all_seen', 'everyone', 'self', 'self_or_ally', 'self_or_enemy'].includes(v),
  range: (v, c) => Number.isInteger(v) && v >= 1 && v <= c.range,
  lock: (v, c) => Number.isInteger(v) && v >= 0 && v <= c.lock,
  lockRestOfTurn: (v) => typeof v === 'boolean',
  lockNextTurn: (v) => typeof v === 'boolean',
  tileToken: (v, c, E) => isObj(v) && typeof v.kind === 'string' && !!E[v.elem],
  selfTileTokens: (v, c, E) => Array.isArray(v) && v.length <= c.token_elems && v.every(e => !!E[e]),
  selfShieldTokens: (v, c, E) => Array.isArray(v) && v.length <= c.token_elems && v.every(e => !!E[e]),
  statPenalty: (v, c, E) => Array.isArray(v) && v.length <= c.token_elems && v.every(e => !!E[e]),
  statBonus: (v, c, E) => Array.isArray(v) && v.length <= c.token_elems && v.every(e => !!E[e]),
  swapTokens: (v) => typeof v === 'boolean',
  healDealt: (v) => typeof v === 'boolean',
  healIfNoTarget: (v) => typeof v === 'boolean',
  selfDamageEqual: (v) => typeof v === 'boolean',
  push: (v, c) => Number.isInteger(v) && v >= 0 && v <= c.push,
  teleportSelf: (v) => typeof v === 'boolean',
  draw: (v, c) => Number.isInteger(v) && v >= 0 && v <= c.draw,
  permanent: (v) => typeof v === 'boolean',
  statBuy: (v) => typeof v === 'boolean',
  fixedPower: (v, c) => Number.isInteger(v) && v >= 1 && v <= c.fixedPower,
  resurrect: (v) => typeof v === 'boolean',
  shieldElem: (v) => typeof v === 'boolean',
  disableElem: (v) => typeof v === 'boolean',
  voidThisAction: (v) => typeof v === 'boolean',
  zone: (v) => v === 'no_damage',
  channel: (v) => isObj(v) && v.stop === 'break',      // 'never' = an unbreakable channel → unbounded (only Blessing's attach makes one)
  trap: (v) => isObj(v) && ['targeted', 'enter'].includes(v.trigger) && ['damage', 'perm'].includes(v.mode),
  trapAttach: (v) => typeof v === 'boolean',
  altTrap: (v) => typeof v === 'boolean',
  tileTarget: (v) => typeof v === 'boolean',
  obstacle: (v) => typeof v === 'boolean',
  banish: (v) => typeof v === 'boolean',
  spiritLink: (v) => typeof v === 'boolean',
  pullToken: (v) => typeof v === 'boolean',
  altTileToken: (v) => typeof v === 'boolean',
  altFeature: (v) => typeof v === 'boolean',
  surgery: (v) => ['unite', 'split', 'switch', 'awake'].includes(v),
  blessAttach: (v) => typeof v === 'boolean',
  phantom: (v) => typeof v === 'boolean',
  possess: (v) => typeof v === 'boolean',
  vision: (v) => typeof v === 'boolean',
  completesWithoutTarget: (v) => typeof v === 'boolean',
};
function activeVersionOf(entry) {
  const vs = (entry.versions || []).filter(v => !['rejected', 'superseded'].includes(v.status));
  return vs.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0] || null;
}
export function normalizeDef(def, extraRule = null) {
  if (!isObj(def)) return { errors: ['definition is not an object'] };
  const v = def.versions ? activeVersionOf(def) : null;
  const data = isObj(def.data) ? def.data : (v?.data || {});
  const pick = (...ks) => { for (const k of ks) { if (def[k] !== undefined) return def[k]; if (data[k] !== undefined) return data[k]; } return undefined; };
  // E1 (chaosd6.effect/1): `flags` = the EFFECT_RULES keys the program implements, `every_text` = the paper ∀ bonus
  // (`every.behaviour` only documents what the engine does under ∀ — Lightning's 2 locks — and is not priced),
  // `instant: true` / `effect_types` = an instant card (played as a counter action).
  const rule = pick('rule', 'flags', 'engine', 'ops', 'resolve') ?? extraRule;
  const types = pick('effect_types', 'types') ?? (def.instant === true ? ['instant'] : []);
  const every = def.every_bonus ?? data.every_bonus ?? def.every_text ?? null;
  return {
    id: def.id ?? null,
    extends: pick('extends', 'base_id') ?? null,
    elements: pick('element_cost', 'elements') ?? def.cost?.elements,
    types,
    every_bonus: !!every,
    stat_buy_total: pick('stat_buy_total') ?? null,
    // Copies of the permanent that land together (monster natural permanents: 2, each power 6 — user ruling
    // 2026-11-15); Rule 24 must destroy every copy, so durability scales with the count. A natural_permanent block
    // on a card whose own rule is NOT a permanent (Creation, Earthquake: the monster mode is a separate innate
    // behaviour, the card a player casts is an obstacle / a damage spell) does not price the card.
    copies: pick('copies') ?? (isObj(rule) && rule.permanent ? (isObj(def.natural_permanent) ? def.natural_permanent.copies : undefined) ?? (isObj(data.natural_permanent) ? data.natural_permanent.copies : undefined) : undefined) ?? 1,
    rule,
    errors: [],
  };
}
export function validateNorm(n, cal) {
  const errs = [...(n.errors || [])];
  const E = cal.elements, caps = cal.policy.caps;
  if (typeof n.id !== 'string' || !/^effect_[a-z0-9_]+$/.test(n.id)) errs.push(`id must match effect_[a-z0-9_]+ (got ${JSON.stringify(n.id)})`);
  if (!Array.isArray(n.elements) || !n.elements.length) errs.push('element_cost must be a non-empty array');
  else {
    if (n.elements.length > cal.policy.max_elements) errs.push(`element_cost longer than ${cal.policy.max_elements}`);
    for (const el of n.elements) if (!E[el]) errs.push(`unknown element ${JSON.stringify(el)}`);
  }
  if (!Array.isArray(n.types) || n.types.some(t => typeof t !== 'string')) errs.push('effect_types must be an array of strings');
  if (!(Number.isInteger(n.copies) && n.copies >= 1 && n.copies <= cal.policy.caps.copies)) errs.push(`copies must be an integer 1..${cal.policy.caps.copies}`);
  if (n.copies > 1 && !(isObj(n.rule) && n.rule.permanent)) errs.push('copies > 1 needs a permanent');
  if (n.stat_buy_total != null && !(Number.isInteger(n.stat_buy_total) && n.stat_buy_total >= 0 && n.stat_buy_total <= 60)) errs.push('stat_buy_total must be an integer 0..60');
  if (Array.isArray(n.rule)) errs.push('rule given as an op list — not understood by validator 1.0.0 (object of engine keys expected)');
  else if (!isObj(n.rule)) errs.push('rule (engine keys) missing');
  else {
    for (const [k, val] of Object.entries(n.rule)) {
      if (!RULE_KEYS[k]) errs.push(`unknown rule key ${k}`);
      else if (!RULE_KEYS[k](val, caps, E)) errs.push(`rule.${k} out of bounds or malformed: ${JSON.stringify(val)}`);
    }
    if (!errs.length) {
      const r = n.rule;
      if (r.channel && r.permanent !== true) errs.push('a channel must be a permanent (rule.permanent: true)');
      if (r.statBuy && !r.permanent) errs.push('a stat buy must be a permanent');
      if (r.lockNextTurn && !r.lockRestOfTurn) errs.push('lockNextTurn needs lockRestOfTurn');
      if ((r.damage || r.lock || r.lockRestOfTurn || r.statPenalty || r.banish || r.possess) && !r.scope) errs.push('a hostile leg needs a scope');
      if (n.extends != null && !cal.weights.named[n.extends] && !cal.builtins?.[n.extends]) errs.push(`extends ${n.extends}: not a built-in`);
    }
  }
  return errs;
}

// ------------------------------------------------------------------ the power model
export function powerOf(n, cal) {
  const W = cal.weights, pool = cal.pool, E2S = cal.elements;
  const st = (c, el) => c[E2S[el]];
  const rule = n.rule, elems = n.elements, id = n.extends || n.id;
  const P = pool.length;
  const meanC = (f) => { let s = 0; for (const c of pool) s += f(c); return s / P; };
  const meanPairs = (f) => { let s = 0, k = 0; for (let i = 0; i < P; i++) for (let j = 0; j < P; j++) if (i !== j) { s += f(pool[i], pool[j]); k++; } return s / k; };
  const comp = {};
  const add = (k, v) => { if (v) comp[k] = r6((comp[k] || 0) + v); };
  let rep = 0, retries = 0;
  const actV = W.act_value;
  let scopeMul = rule.scope ? (W.scope[rule.scope] ?? 1) : 1;
  if (rule.scope === 'target' && rule.range > 1) scopeMul += (rule.range - 1) * W.range_bonus_per_hex;
  const tok = (el) => { retries += meanC(c => { const pb = pointBuyStats(st(c, el)); return (1 - pb.p) / pb.p; }); return meanC(c => pointBuyStats(st(c, el)).ev); };

  let D = 0;
  if (rule.damage === 'delta') D = meanPairs((c, d) => Math.round(elems.reduce((s, el) => s + Math.max(0, st(c, el) - st(d, el)), 0) / 10));
  else if (rule.damage === 'pointbuy') {
    D = meanC(c => expRoundSum(elems.map(el => pointBuyStats(st(c, el)).dist)));
    retries += meanC(c => elems.reduce((s, el) => { const pb = pointBuyStats(st(c, el)); return s + (1 - pb.p) / pb.p; }, 0));
  }
  if (rule.damage) {
    const dmg = D * W.damage * scopeMul;
    add('damage', dmg); rep += dmg;
    if (rule.tileToken) {
      const el = rule.tileToken.elem;
      const pHit = meanC(c => pointBuyStats(st(c, el)).dist.reduce((s, [v, p]) => s + (v >= 5 ? p : 0), 0));
      retries += meanC(c => { const pb = pointBuyStats(st(c, el)); return (1 - pb.p) / pb.p; });
      add('tile_token', pHit * scopeMul * W.tile_token_damage); rep += pHit * scopeMul * W.tile_token_damage;
    }
    if (rule.healDealt) add('heal_dealt', dmg * W.heal_dealt);
    if (rule.selfDamageEqual) add('self_damage', -dmg * W.self_damage_equal);
    if (rule.healIfNoTarget) add('alt_heal', meanC(c => Math.round(c.vitality / 10)) * W.heal_if_no_target);
  }
  if (rule.lock) { const v = rule.lock * actV * scopeMul; add('lock', v); rep += v; }
  if (rule.lockRestOfTurn) { const v = (W.rest_of_turn_actions + (rule.lockNextTurn ? W.next_turn_actions : 0)) * actV * scopeMul; add('lock', v); rep += v; }
  for (const el of rule.selfTileTokens || []) { const v = tok(el) * W.self_tile_token_per_pt; add('tile_tokens', v); rep += v; }
  for (const el of rule.selfShieldTokens || []) { const v = tok(el) * W.self_shield_token_per_pt; add('shield_tokens', v); rep += v; }
  for (const el of rule.statPenalty || []) { const v = tok(el) * W.stat_penalty_per_pt * scopeMul; add('stat_penalty', v); rep += v; }
  for (const el of rule.statBonus || []) add('stat_bonus', tok(el) * W.stat_bonus_per_pt);
  if (rule.swapTokens) {
    retries += meanC(c => { const pb = pointBuyStats(st(c, elems[0])); return (1 - pb.p) / pb.p; });
    add('swap_tokens', meanC(c => { const pb = pointBuyStats(st(c, elems[0])); return pb.ev + pb.evMin; }) * W.swap_per_pt);
  }
  if (rule.zone === 'no_damage') { add('zone', W.zone_no_damage); rep += W.zone_no_damage; }
  if (rule.voidThisAction) { add('void', W.void_this_action); rep += W.void_this_action; }
  if (rule.shieldElem) add('shield_elem', W.shield_elem);
  if (rule.disableElem) add('disable_elem', W.disable_elem);
  if (rule.push) add('push', rule.push * W.push_per_hex * scopeMul);
  if (rule.pullToken) add('pull_token', W.pull_token);
  if (rule.tileTarget) add('tile_target', W.tile_target);
  if (rule.surgery) add('surgery', W.surgery[rule.surgery]);
  if (rule.altTrap) add('alt_trap', W.alt_trap);
  if (rule.altFeature) add('alt_feature', W.alt_feature);
  if (rule.altTileToken) add('alt_tile_token', W.alt_tile_token);
  if (rule.completesWithoutTarget) add('completes_without_target', W.completes_without_target);
  if (rule.teleportSelf) add('teleport', W.teleport_self);
  if (rule.obstacle) add('obstacle', W.obstacle);
  if (rule.blessAttach) add('bless_attach', W.bless_attach);
  if (rule.phantom) add('phantom', W.phantom);
  if (rule.banish) add('banish', meanPairs((c, d) => elems.reduce((s, el) => s + Math.max(0, st(c, el) - st(d, el)), 0) > 0 ? 1 : 0) * W.banish);
  if (rule.possess) {
    const sum = (c) => c.vitality + c.world + c.matter + c.will;
    add('possess', meanPairs((c, d) => sum(c) > sum(d) ? 1 : 0) * W.possess + W.phylactery);
  }
  if (rule.vision) add('vision', W.vision_tile + meanPairs((c, d) => st(c, elems[0]) > st(d, elems[0]) ? 1 : 0) * W.vision_hand);
  if (rule.spiritLink) add('spirit_link', meanC(c => (c.vitality + c.world + c.matter + c.will) / 4) * W.spirit_link_per_stat_pt);
  if (rule.draw) add('draw', rule.draw * W.draw_per_card);
  if (rule.trap && rule.trap.mode === 'damage') {
    const pw = W.trap_power;
    add('trap', meanC(d => Math.round(elems.reduce((s, el) => s + Math.max(0, pw - st(d, el)), 0) / 10)) * W.trap_trigger_prob);
  }
  if (rule.trapAttach) add('trap_attach', W.trap_attach);
  let emissions = elems.length;
  if (rule.statBuy) {
    const need = n.stat_buy_total ?? W.stat_buy_need[id] ?? W.stat_buy_need.default;
    emissions = meanC(c => { let bank = 0, k = 0; while (bank < Math.max(1, need) && k < 60) { bank += st(c, elems[k % elems.length]); k++; } return k; });
    add('summon', need * W.summon_per_need_pt);
  }
  if (rule.permanent) {
    const dur = (rule.fixedPower ? rule.fixedPower / 6 : meanC(c => pointBuyStats(st(c, elems[0])).ev) / 6) * n.copies;
    add('permanent', W.permanent_base * dur);
  }
  if (rule.channel) add('channel', rep * W.channel_extra_fires);
  if (W.named[id] != null) add('named', W.named[id]);
  if (n.every_bonus) add('every_bonus', W.every_bonus);
  const instant = n.types.includes('instant');
  const value = r6(Object.values(comp).reduce((a, b) => a + b, 0));
  // An instant resolves in the one action it is played in; every element still weighs on the card
  // (more stats exposed to Disable / Counter Spell, a longer chain to interrupt — Rule 19).
  const acts = instant ? W.instant_actions : emissions;
  const actions = r6(acts + retries + W.element_cost * elems.length);
  return { value, cost: { emissions: r6(emissions), instant, retries: r6(retries), element_term: r6(W.element_cost * elems.length), actions }, components: comp };
}

const expected = (fit, C) => r6(fit.a + fit.b * C);
function ratioOf(pw, fit) { const e = expected(fit, pw.cost.actions); return { expected: e, ratio: r6(e > 0.05 ? pw.value / e : pw.value / 0.05) }; }

// ------------------------------------------------------------------ mutations (suggested tuning)
function clone(n) { return JSON.parse(JSON.stringify(n)); }
function mutations(n) {
  const out = [];
  const m = (change, fn) => { const c = clone(n); fn(c); out.push({ change, norm: c }); };
  const r = n.rule, last = n.elements[n.elements.length - 1];
  m(`+1 element (${last}) on the cost`, c => c.elements.push(last));
  if (n.elements.length > 1) m(`one element less (drop ${last})`, c => c.elements.pop());
  if (r.lock) { m(`lock ${r.lock} → ${r.lock - 1}`, c => { c.rule.lock = r.lock - 1; if (!c.rule.lock) delete c.rule.lock; }); m(`lock ${r.lock} → ${r.lock + 1}`, c => { c.rule.lock = r.lock + 1; }); }
  if (r.lockNextTurn) m('lock no longer carries into the next turn', c => { delete c.rule.lockNextTurn; });
  if (r.draw) { m(`draw ${r.draw} → ${r.draw - 1}`, c => { c.rule.draw = r.draw - 1; if (!c.rule.draw) delete c.rule.draw; }); m(`draw ${r.draw} → ${r.draw + 1}`, c => { c.rule.draw = r.draw + 1; }); }
  if (r.scope === 'target' && r.damage) {
    const rg = r.range || 1;
    if (rg > 1) m(`range ${rg} → ${rg - 1}`, c => { c.rule.range = rg - 1; if (c.rule.range === 1) delete c.rule.range; });
    m(`range ${rg} → ${rg + 1}`, c => { c.rule.range = rg + 1; });
  }
  if (r.push) m(`push ${r.push} → ${r.push - 1}`, c => { c.rule.push = r.push - 1; if (!c.rule.push) delete c.rule.push; });
  const down = { all_seen: 'all_enemies', everyone: 'all_enemies', all_enemies: 'target', all_adjacent: 'target' };
  const up = { target: 'all_enemies', all_enemies: 'all_seen' };
  if (down[r.scope]) m(`scope ${r.scope} → ${down[r.scope]}`, c => { c.rule.scope = down[r.scope]; if (c.rule.scope !== 'everyone') delete c.rule.range; });
  if (up[r.scope] && (r.damage || r.lock || r.statPenalty)) m(`scope ${r.scope} → ${up[r.scope]}`, c => { c.rule.scope = up[r.scope]; delete c.rule.range; });
  for (const k of ['selfTileTokens', 'selfShieldTokens', 'statPenalty', 'statBonus']) if (r[k]?.length) {
    m(`${k} loses ${r[k][r[k].length - 1]}`, c => { c.rule[k].pop(); if (!c.rule[k].length) delete c.rule[k]; });
    m(`${k} gains another ${r[k][r[k].length - 1]}`, c => { c.rule[k].push(r[k][r[k].length - 1]); });
  }
  if (r.channel) m('no longer a channel', c => { delete c.rule.channel; });
  if (r.fixedPower > 1) m(`fixedPower ${r.fixedPower} → ${r.fixedPower - 1}`, c => { c.rule.fixedPower = r.fixedPower - 1; });
  if (n.every_bonus) m('loses its every_bonus (∀ text)', c => { c.every_bonus = false; });
  else m('gains an every_bonus (∀ text to be written)', c => { c.every_bonus = true; });
  if (n.types.includes('instant')) m('no longer an instant', c => { c.types = c.types.filter(t => t !== 'instant'); });
  else m('becomes an instant', c => { c.types.push('instant'); });
  return out;
}
function patchOf(n0, n1) {
  const p = {};
  if (canonicalJson(n0.elements) !== canonicalJson(n1.elements)) p.element_cost = n1.elements;
  if (canonicalJson(n0.types) !== canonicalJson(n1.types)) p.effect_types = n1.types;
  if (n0.every_bonus !== n1.every_bonus) p.every_bonus = n1.every_bonus ? 'TODO: describe the ∀ bonus' : null;
  if (canonicalJson(n0.rule) !== canonicalJson(n1.rule)) p.rule = n1.rule;
  return p;
}

// ------------------------------------------------------------------ checkEffect
// opts: { baseline: effect id | definition | null (auto: own id / extends a built-in), tolerance, calibration }
export function checkEffect(def, opts = {}) {
  const cal = opts.calibration || loadCalibration();
  const pin = computePin(cal);
  const tol = Number.isFinite(opts.tolerance) ? opts.tolerance : cal.policy.tolerance;
  const n = normalizeDef(def);
  const def_sha256 = sha256(canonicalJson(def));
  const base = { validator: { version: VALIDATOR_VERSION, pin_id: pin.pin_id }, effect_id: n.id ?? null, def_sha256, tolerance: tol };
  const stamp = (verdict, ratio) => ({ effect_id: n.id ?? null, def_sha256, pin_id: pin.pin_id, verdict, ratio, tolerance: tol });
  const errors = validateNorm(n, cal);
  if (errors.length) return { ...base, valid: false, errors, verdict: 'reject', reasons: ['invalid definition'], suggestions: [], stamp: stamp('reject', null) };
  if (!cal.fit) throw new Error('calibration has no fit — run `node tools/rebalancing-check.mjs calibrate --write`');
  // Logic audit: the program may not do more than the flags it is priced by.
  const audit = auditLogic(def, n, cal);
  if (audit.fatal || audit.exceeds?.length) {
    const why = audit.errors?.length ? audit.errors : audit.exceeds?.length ? audit.exceeds.map(x => `logic exceeds its declared flags — ${x}`) : [audit.why];
    return { ...base, valid: !audit.errors?.length, errors: audit.errors || [], audit, verdict: 'reject', reasons: why, suggestions: [], stamp: stamp('reject', null) };
  }
  const pw = powerOf(n, cal);
  const { expected: exp, ratio } = ratioOf(pw, cal.fit);

  // Baseline: the parent this definition is judged against.
  let baseline = null;
  let bref = opts.baseline;
  if (bref === undefined) bref = cal.builtins?.[n.id] ? n.id : (n.extends && cal.builtins?.[n.extends] ? n.extends : null);
  if (typeof bref === 'string') {
    const b = cal.builtins?.[bref];
    if (!b) return { ...base, valid: false, errors: [`baseline ${bref} is not a calibrated built-in`], verdict: 'reject', reasons: ['bad baseline'], suggestions: [], stamp: stamp('reject', null) };
    baseline = { id: bref, value: b.value, actions: b.actions, ratio: b.ratio };
  } else if (isObj(bref)) {
    const bn = normalizeDef(bref), be = validateNorm(bn, cal);
    if (be.length) return { ...base, valid: false, errors: be.map(e => `baseline: ${e}`), verdict: 'reject', reasons: ['bad baseline'], suggestions: [], stamp: stamp('reject', null) };
    const bp = powerOf(bn, cal);
    baseline = { id: bn.id, value: bp.value, actions: bp.cost.actions, ratio: ratioOf(bp, cal.fit).ratio };
  }
  const judged = baseline ? r6(ratio / Math.max(1e-6, baseline.ratio)) : ratio;
  const lo = r6(1 - tol), hi = r6(1 + tol);
  const reasons = [];
  let verdict;
  if (judged > cal.policy.hard_cap_ratio) { verdict = 'reject'; reasons.push(`power ${judged}× the ${baseline ? 'baseline' : 'cost curve'} > hard cap ${cal.policy.hard_cap_ratio}×`); }
  else if (judged < cal.policy.hard_floor_ratio) { verdict = 'reject'; reasons.push(`power ${judged}× < floor ${cal.policy.hard_floor_ratio}× (does next to nothing)`); }
  else if (judged > hi) { verdict = 'nerf'; reasons.push(`power ${judged}× above the band [${lo}, ${hi}]`); }
  else if (judged < lo) { verdict = 'boost'; reasons.push(`power ${judged}× below the band [${lo}, ${hi}]`); }
  else { verdict = 'ok'; reasons.push(`power ${judged}× inside the band [${lo}, ${hi}]`); }

  const suggestions = [];
  if (verdict !== 'ok') {
    const want = judged > 1 ? -1 : 1;
    const target = baseline ? baseline.ratio : 1;
    const cands = mutations(n).map(mu => {
      if (validateNorm(mu.norm, cal).length) return null;
      const p2 = powerOf(mu.norm, cal), rr = ratioOf(p2, cal.fit).ratio, j = r6(rr / target);
      return { change: mu.change, value: p2.value, actions: p2.cost.actions, ratio: j, in_band: j >= lo && j <= hi, patch: patchOf(n, mu.norm) };
    }).filter(c => c && Math.sign(c.ratio - judged) === want);
    const inBand = cands.filter(c => c.in_band).sort((a, b) => Math.abs(a.ratio - 1) - Math.abs(b.ratio - 1) || a.change.localeCompare(b.change));
    const rest = cands.filter(c => !c.in_band).sort((a, b) => Math.abs(a.ratio - 1) - Math.abs(b.ratio - 1) || a.change.localeCompare(b.change));
    suggestions.push(...inBand.slice(0, 3), ...(inBand.length ? [] : rest.slice(0, 2)));
    // Continuous hints: scale every outcome by k, or pay Δ extra actions, to land on the curve.
    const goalV = baseline ? baseline.ratio * exp : exp;
    suggestions.push({ change: `scale the outcome ×${r3(goalV / Math.max(1e-6, pw.value))} (to ${r3(goalV)})`, kind: 'hint' });
    if (cal.fit.b > 0) {
      // ratio·(a + b·C') = V → C' = (V/target − a)/b
      const C2 = (pw.value / (baseline ? baseline.ratio : 1) - cal.fit.a) / cal.fit.b;
      suggestions.push({ change: `cost ${r3(pw.cost.actions)} → ${r3(C2)} actions (${C2 >= pw.cost.actions ? '+' : ''}${r3(C2 - pw.cost.actions)})`, kind: 'hint' });
    }
  }
  return {
    ...base, valid: true, errors: [],
    mode: baseline ? 'baseline' : 'curve',
    power: { value: pw.value, components: pw.components, cost: pw.cost, expected: exp, ratio },
    baseline, judged_ratio: judged, band: { low: lo, high: hi, hard_cap: cal.policy.hard_cap_ratio, hard_floor: cal.policy.hard_floor_ratio },
    audit: audit.ran ? { ran: true, N: audit.N, identical: audit.identical, exceeds: [] } : { ran: false, why: audit.why },
    verdict, reasons, suggestions, stamp: stamp(verdict, judged),
  };
}

// ------------------------------------------------------------------ built-ins + calibration
// Built-ins = data/effects.json active versions + effects.mjs EFFECT_RULES (flags-only definitions; effects without
// an engine rule are not playable and skipped). With { prefer: 'e1' } an E1 file game/effects-data/effects/<id>.json
// replaces the flags-only def when present (its card types still come from data/effects.json: E1 has no instant marker yet).
export async function loadBuiltinDefs({ prefer = 'data' } = {}) {
  const EFFECT_RULES = REF?.EFFECT_RULES || {};
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'effects.json'), 'utf8'));
  const dir = path.join(GAME, 'effects-data', 'effects');
  const defs = [];
  let e1 = 0;
  for (const e of [...j.entries].sort((a, b) => a.id.localeCompare(b.id))) {
    const v = activeVersionOf(e);
    if (!v || !EFFECT_RULES[e.id]) continue;
    const f = path.join(dir, `${e.id}.json`);
    if (prefer === 'e1' && fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
      if (d.effect_types === undefined && d.instant === undefined && (v.data.effect_types || []).includes('instant')) d.instant = true;
      if (d.stat_buy_total === undefined && v.data.stat_buy_total != null) d.stat_buy_total = v.data.stat_buy_total;
      if (d.copies === undefined && d.natural_permanent === undefined && v.data.natural_permanent?.copies != null && EFFECT_RULES[e.id].permanent) d.copies = v.data.natural_permanent.copies;
      defs.push(d); e1++; continue;
    }
    defs.push({ id: e.id, version: v.version, element_cost: v.data.element_cost, effect_types: v.data.effect_types, ...(v.data.every_bonus ? { every_bonus: v.data.every_bonus } : {}), ...(v.data.stat_buy_total != null ? { stat_buy_total: v.data.stat_buy_total } : {}), ...(v.data.natural_permanent?.copies != null && EFFECT_RULES[e.id].permanent ? { copies: v.data.natural_permanent.copies } : {}), rule: JSON.parse(JSON.stringify(EFFECT_RULES[e.id])) });
  }
  return { source: `data/effects.json + effects.mjs EFFECT_RULES${e1 ? ` (${e1} from game/effects-data/effects)` : ''}`, defs };
}
// Least squares V = a + b·C over the built-ins, then one refit without the gross outliers
// (|r − 1| > 0.6 on the first fit) so a few hand-tagged peer hooks do not drag the curve.
export function fitCurve(points) {
  const ols = (ps) => {
    const k = ps.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of ps) { sx += p.C; sy += p.V; sxx += p.C * p.C; sxy += p.C * p.V; }
    const den = k * sxx - sx * sx;
    const b = den ? (k * sxy - sx * sy) / den : 0;
    return { a: (sy - b * sx) / k, b };
  };
  const f1 = ols(points);
  const kept = points.filter(p => { const e = f1.a + f1.b * p.C; return e > 0 && Math.abs(p.V / e - 1) <= 0.6; });
  const f2 = ols(kept.length >= 5 ? kept : points);
  return { a: r6(f2.a), b: r6(f2.b), n: points.length, n_fit: kept.length >= 5 ? kept.length : points.length, model: 'V = a + b·C (OLS, refit without |r−1|>0.6)' };
}
export async function calibrate(cal = loadCalibration()) {
  const { source, defs } = await loadBuiltinDefs();
  const rows = [];
  for (const d of defs) {
    const n = normalizeDef(d), errs = validateNorm(n, { ...cal, builtins: {} });
    if (errs.length) { rows.push({ id: d.id, errors: errs }); continue; }
    const pw = powerOf(n, cal);
    // Unpriced = the model sees nothing but "it is a permanent" (behaviour only in peer.mjs hooks keyed on the id,
    // no hand-set `named` value — e.g. the monster-only natural permanents Love / Awe / Fear …). Such a point carries
    // no information about the curve: it stays out of the fit and the outlier list, but is snapshotted so a branch
    // that `extends` it is still judged against it (baseline mode).
    const unpriced = Object.keys(pw.components).every(k => k === 'permanent');
    rows.push({ id: n.id, V: pw.value, C: pw.cost.actions, pw, unpriced });
  }
  const fit = fitCurve(rows.filter(r => !r.errors && !r.unpriced));
  fit.unpriced = rows.filter(r => r.unpriced).map(r => r.id);
  const builtins = {};
  const outliers = [];
  for (const r of rows.filter(x => !x.errors)) {
    const { ratio } = ratioOf(r.pw, fit);
    const v = ratio > cal.policy.hard_cap_ratio || ratio < cal.policy.hard_floor_ratio ? 'reject' : ratio > 1 + cal.policy.tolerance ? 'nerf' : ratio < 1 - cal.policy.tolerance ? 'boost' : 'ok';
    builtins[r.id] = { value: r.V, actions: r.C, ratio, curve_verdict: r.unpriced ? 'unpriced' : v };
    if (v !== 'ok' && !r.unpriced) outliers.push({ id: r.id, ratio, curve_verdict: v });
  }
  outliers.sort((a, b) => b.ratio - a.ratio || a.id.localeCompare(b.id));
  return { source, fit, builtins, known_outliers: outliers, errors: rows.filter(r => r.errors) };
}

// ------------------------------------------------------------------ seeded scenarios (logic audit + Monte-Carlo)
// N duels on a small fixed board: me (0,0), the target foe (1,0), on odd i a second foe (-1,1), on i ≡ 0 (mod 3) a
// wounded ally (0,-1). Caster = pool[i mod P], foe = pool[(7i+3) mod P]. The cast is stepped one emission per action
// (retry → re-emit, casting → next element) with salts `rbc:<id>:<i>:<action>` — fixed strings, so every peer gets
// the same numbers. Magnitudes are summed per outcome field and averaged over N.
export const DIMS = ['damage', 'heal', 'lock', 'stat_tokens', 'tile_tokens', 'moves', 'draw', 'permanents', 'traps', 'channels', 'obstacles', 'links', 'peeks', 'pulls', 'relocations', 'zones', 'voids', 'shield', 'disable', 'summon', 'possess', 'phantom'];
function scenarioRun(resolve, n, N, cal) {
  const E2S = cal.elements, P = cal.pool.length;
  const tot = Object.fromEntries(DIMS.map(d => [d, 0]));
  let actions = 0, done = 0, errors = 0;
  const hd = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((a.q + a.r) - (b.q + b.r)));
  for (let i = 0; i < N; i++) {
    const c = cal.pool[i % P]; let d = cal.pool[(7 * i + 3) % P]; if (d === c) d = cal.pool[(i + 1) % P];
    const units = { me: { s: c, t: { q: 0, r: 0 }, side: 'a', life: 6 }, foe: { s: d, t: { q: 1, r: 0 }, side: 'b', life: 4 } };
    if (i % 2 === 1) units.foe2 = { s: cal.pool[(5 * i + 1) % P], t: { q: -1, r: 1 }, side: 'b', life: 4 };
    if (i % 3 === 0) units.ally = { s: cal.pool[(3 * i + 2) % P], t: { q: 0, r: -1 }, side: 'a', life: 2 };
    let ai = 0;
    const ctx = {
      me: 'me', elemStat: (el) => E2S[el], statFor: (id, el) => units[id].s[E2S[el]], baseStat: (id, k) => units[id].s[k], lifeOf: (id) => units[id]?.life ?? 0,
      enemyOf: (a, b) => units[a].side !== units[b].side, dist: (a, b) => hd(units[a].t, units[b].t), tileOf: (id) => units[id]?.t ?? null,
      isFree: (q, r) => !Object.values(units).some(u => u.t.q === q && u.t.r === r),
      neighbours: (q, r) => [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]].map(([a, b]) => ({ q: q + a, r: r + b })),
      hasPerm: () => false, shieldedAgainst: () => false, disabledElems: () => new Set(), invisible: () => false,
      peers: () => Object.keys(units).sort(), sha: (s) => sha256(String(s)),
      threatElem: () => n.elements[0], castElemOf: () => null,
      get actionIndex() { return ai; },
      freeTilesWithin: (q, r, k) => { const o = []; for (let a = -k; a <= k; a++) for (let b = -k; b <= k; b++) { const t = { q: q + a, r: r + b }; if (hd({ q, r }, t) <= k && ctx.isFree(t.q, t.r)) o.push(t); } return o; },
      tileTokensAt: () => [], trapsAt: () => [], obstacleAt: () => null, library: () => [],
    };
    const of = n.elements.length;
    const need = n.stat_buy_total ?? cal.weights.stat_buy_need[n.extends || n.id] ?? cal.weights.stat_buy_need.default;
    let kept = null, step = 1, out = null;
    for (let guard = 0; guard < 40; guard++) {
      actions++;
      const cast = { actor: 'me', effect_id: n.id, elements: [...n.elements], salt: `rbc:${n.id}:${i}:${ai}`, target: { kind: 'character', ref: 'foe' }, is_instant: n.types.includes('instant'), step, of, kept, card_id: `rbc-card-${i}` };
      if (n.rule.statBuy) cast.summon = n.rule.resurrect ? { ward: 'ally', need: 0 } : { need, creature_id: 'rbc_creature' };
      if (n.rule.spiritLink) cast.link = { peer_id: 'ally', stat: 'vitality' };
      if (n.rule.blessAttach || n.rule.trapAttach) cast.attach = { effect_id: 'effect_fireball', elements: ['elem_fire', 'elem_fire'], card_id: 'rbc-attach' };
      out = resolve(ctx, cast);
      ai++;
      kept = out.kept;
      if (out.status === 'retry') continue;
      if (out.status === 'casting') { step++; continue; }
      break;
    }
    if (out.status === 'error') { errors++; continue; }
    if (out.status !== 'done') continue;
    done++;
    for (const h of out.hits || []) for (const l of h.legs || []) tot.damage += Math.round((l.sum || 0) / 10);
    for (const h of out.heals || []) tot.heal += h.amount || 0;
    for (const l of out.locks || []) tot.lock += (l.n || 0) + (l.restOfTurn ? 1 : 0) + (l.nextTurn ? 3 : 0);
    for (const t of out.statTokens || []) tot.stat_tokens += Math.abs(t.value || 0);
    for (const t of out.tokens || []) tot.tile_tokens += Math.abs(t.value || 0);
    for (const l of out.links || []) tot.links += l.value || 0;
    tot.moves += (out.moves || []).length; tot.draw += out.draw || 0; tot.permanents += (out.permanents || []).length;
    tot.traps += (out.traps || []).length; tot.channels += (out.channels || []).length; tot.obstacles += (out.obstacles || []).length;
    tot.peeks += (out.peeks || []).length; tot.pulls += (out.pulls || []).length; tot.relocations += (out.relocations || []).length;
    tot.zones += (out.zones || []).length; tot.voids += (out.voidFor || []).length;
    tot.shield += out.shieldElem ? 1 : 0; tot.disable += out.disableElem ? 1 : 0; tot.summon += out.summon ? 1 : 0;
    tot.possess += out.possess ? 1 : 0; tot.phantom += out.phantom ? 1 : 0;
  }
  return { N, done, errors, actions: r6(actions / N), mean: Object.fromEntries(DIMS.map(k => [k, r6(tot[k] / N)])) };
}
// The reference behaviour of a flags object = effects.mjs#resolveEffect with the flags registered under the
// effect's id for the duration of the run (restored afterwards — the dice seeds include the id, so it must match).
function referenceResolver(n) {
  return (ctx, cast) => {
    const had = Object.prototype.hasOwnProperty.call(REF.EFFECT_RULES, n.id), old = REF.EFFECT_RULES[n.id];
    REF.EFFECT_RULES[n.id] = n.rule;
    try { return REF.resolveEffect(ctx, cast); } finally { if (had) REF.EFFECT_RULES[n.id] = old; else delete REF.EFFECT_RULES[n.id]; }
  };
}
function logicResolver(def) {
  const { subs } = libsFor(def.uses);
  const bound = { ...def };
  Object.defineProperty(bound, '$subs', { value: subs, enumerable: false });
  return (ctx, cast) => { try { return DATA_ENGINE.resolveEffectData(bound, ctx, cast); } catch (e) { return { status: 'error', notes: [String(e.message || e)] }; } };
}
// Audit: the program may not do MORE than its flags declare (they are what the validator prices) — on any
// dimension, or by finishing in fewer actions. Doing less is allowed (priced as the flags: the author's loss).
export function auditLogic(def, n, cal = loadCalibration()) {
  const N = cal.policy.audit_scenarios || 48, slack = cal.policy.audit_slack ?? 0.05;
  if (cal.policy.audit === false) return { ran: false, why: 'audit disabled by the calibration policy' };
  if (def.logic === undefined) return { ran: false, why: 'no logic program (flags-only definition: the reference engine runs the flags)' };
  if (!DATA_ENGINE?.resolveEffectData || !REF?.resolveEffect) return { ran: false, why: 'engine missing (effect-engine.mjs / effects.mjs)', fatal: true };
  const errors = [];
  if (def.schema && DATA_ENGINE.validateEffectDef) errors.push(...DATA_ENGINE.validateEffectDef(def, libsFor(def.uses).subs));
  if (errors.length) return { ran: false, errors, fatal: true, why: 'E1 schema validation failed' };
  const ref = scenarioRun(referenceResolver(n), n, N, cal);
  const got = scenarioRun(logicResolver(def), n, N, cal);
  const exceeds = [];
  if (got.errors) exceeds.push(`the program errored / ran out of engine budget in ${got.errors}/${N} scenarios`);
  for (const k of DIMS) if (got.mean[k] > ref.mean[k] * (1 + slack) + slack) exceeds.push(`${k}: program ${got.mean[k]} vs flags ${ref.mean[k]}`);
  if (got.actions < ref.actions * (1 - slack) - slack) exceeds.push(`actions: program ${got.actions} vs flags ${ref.actions} (finishes faster than its cost)`);
  const identical = canonicalJson(ref) === canonicalJson(got);
  return { ran: true, N, identical, exceeds, reference: ref, program: got };
}
// Informative Monte-Carlo of the analytic model's inputs (not part of the verdict beyond the audit).
export function monteCarlo(def, N = 240, cal = loadCalibration()) {
  const n = normalizeDef(def);
  if (def.logic !== undefined && DATA_ENGINE?.resolveEffectData) return { engine: 'effect-engine.mjs#resolveEffectData', ...scenarioRun(logicResolver(def), n, N, cal) };
  if (!REF?.resolveEffect) return { engine: null, error: 'no engine' };
  return { engine: 'effects.mjs#resolveEffect (flags)', ...scenarioRun(referenceResolver(n), n, N, cal) };
}

// ------------------------------------------------------------------ CLI
async function cli(argv) {
  const [cmd, ...rest] = argv;
  const flags = {}; const args = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) { const k = a.slice(2); const nx = rest[i + 1]; if (nx !== undefined && !nx.startsWith('--') && ['baseline', 'tolerance', 'mc', 'write'].includes(k)) { flags[k] = nx; i++; } else flags[k] = true; }
    else args.push(a);
  }
  const readDef = async (ref) => {
    if (fs.existsSync(ref)) return JSON.parse(fs.readFileSync(ref, 'utf8'));
    const { defs } = await loadBuiltinDefs({ prefer: 'e1' });
    const d = defs.find(x => x.id === ref);
    if (!d) throw new Error(`no file or built-in effect ${ref}`);
    return d;
  };
  if (cmd === 'check') {
    if (!args[0]) throw new Error('check <def.json|effect_id>');
    const def = await readDef(args[0]);
    const opts = {};
    if (flags.tolerance !== undefined) opts.tolerance = Number(flags.tolerance);
    if (typeof flags.baseline === 'string') opts.baseline = fs.existsSync(flags.baseline) ? JSON.parse(fs.readFileSync(flags.baseline, 'utf8')) : flags.baseline;
    if (flags['no-baseline']) opts.baseline = null;
    const res = checkEffect(def, opts);
    if (flags.mc) res.monte_carlo = monteCarlo(def, Number(flags.mc) || 240);
    if (flags.json) { console.log(JSON.stringify(res, null, 2)); return res.verdict === 'reject' ? 1 : 0; }
    console.log(`${res.effect_id}: VERDICT ${res.verdict.toUpperCase()}  (validator ${VALIDATOR_VERSION}, pin ${res.validator.pin_id.slice(0, 12)})`);
    if (!res.valid) { for (const e of res.errors) console.log(`  ✗ ${e}`); return 1; }
    const p = res.power;
    console.log(`  value ${p.value}  cost ${p.cost.actions} actions (emissions ${p.cost.emissions}${p.cost.instant ? ' instant' : ''}, retries ${p.cost.retries})  curve ${p.expected}  ratio ${p.ratio}`);
    console.log(`  components: ${Object.entries(p.components).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (res.baseline) console.log(`  baseline ${res.baseline.id}: ratio ${res.baseline.ratio} → judged ${res.judged_ratio}`);
    for (const r of res.reasons) console.log(`  · ${r}`);
    for (const s of res.suggestions) console.log(`  → ${s.change}${s.ratio != null ? ` (ratio ${s.ratio}${s.in_band ? ', in band' : ''})` : ''}`);
    if (res.monte_carlo) console.log(`  monte-carlo (engine, informative): ${JSON.stringify(res.monte_carlo)}`);
    return res.verdict === 'reject' ? 1 : 0;
  }
  if (cmd === 'report' || cmd === 'calibrate') {
    const cal = loadCalibration();
    const c = await calibrate(cal);
    if (cmd === 'calibrate' && flags.write) {
      const next = { ...cal, fit: c.fit, builtins: c.builtins, known_outliers: c.known_outliers, calibrated_from: c.source };
      fs.writeFileSync(CALIBRATION_PATH, JSON.stringify(next, null, 2) + '\n');
      console.log(`calibration written: ${CALIBRATION_PATH}`);
    }
    if (flags.json) { console.log(JSON.stringify(c, null, 2)); return 0; }
    console.log(`source: ${c.source}\nfit: V = ${c.fit.a} + ${c.fit.b}·C  (${c.fit.n_fit}/${c.fit.n} built-ins in the fit)`);
    const rows = Object.entries(c.builtins).sort((a, b) => b[1].ratio - a[1].ratio);
    for (const [id, b] of rows) console.log(`  ${String(b.ratio).padStart(9)}  ${b.curve_verdict.padEnd(6)} ${id.padEnd(30)} V ${String(b.value).padStart(9)}  C ${b.actions}`);
    const cnt = {}; for (const [, b] of rows) cnt[b.curve_verdict] = (cnt[b.curve_verdict] || 0) + 1;
    console.log(`\nverdicts vs the curve (±${cal.policy.tolerance * 100}%): ${JSON.stringify(cnt)}`);
    for (const e of c.errors) console.log(`  invalid built-in ${e.id}: ${e.errors.join('; ')}`);
    return 0;
  }
  if (cmd === 'pin') {
    const pin = computePin();
    const txt = JSON.stringify(pin, null, 2) + '\n';
    if (typeof flags.write === 'string') { fs.mkdirSync(path.dirname(flags.write), { recursive: true }); fs.writeFileSync(flags.write, txt); console.log(`pin written: ${flags.write}`); }
    else process.stdout.write(txt);
    return 0;
  }
  console.log('usage: node tools/rebalancing-check.mjs check <def.json|effect_id> [--baseline <id|file>] [--no-baseline] [--tolerance t] [--json] [--mc N]\n       | report [--json] | calibrate [--write] | pin [--write <path>]');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  cli(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e.stack || String(e)); process.exit(2); });
}
