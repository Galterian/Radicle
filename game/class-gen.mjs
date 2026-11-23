// Class generation (2026-11-23, the editor's "Generate from a description…" for classes): the big model writes a
// chaosd6.class/2 definition (a player-branch class: data {ability_kind, colors, text, knobs}, flags, `power` = what it
// does in the validator's vocabulary, hook programs in the effects' JsonLogic dialect) and THIS node judges it with the
// editor's own publish check (editor-api.mjs validateDefinition: id / schema / foreign rules, class-engine
// validateClassDef, tools/classes-rebalancing-check.mjs checkClass — the C3 validator every peer runs on a foreign class).
// Same loop as effects and skills (effect-gen.mjs generateDef); a local draft only.
// A foreign class may not do what the game code resolves itself (power keys marked peer / hand: build, plant,
// disable_traps, relocate, discard, reveal — user ruling 2026-11-17), so the prompt offers only the data-run keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDef } from './effect-gen.mjs';
import { POWER_KEYS, BUILTIN_POWER } from './tools/classes-rebalancing-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'classes-data');
// Data-run built-ins that pass the publish check as a foreign copy (tools/out/_class_probe.mjs, 2026-11-23): a tap
// ability, two local abilities, an end-of-turn static, a combat static, a stance + emit.
export const CLASS_GEN_EXAMPLES = Object.freeze(['class_overlord', 'class_kensei', 'class_guardian', 'class_weapon_master', 'class_assassin', 'class_barbarian']);
export const CLASS_GEN_LIBS = Object.freeze(['classes_std']);
export const CLASS_KINDS = Object.freeze(['tap', 'once_per_round', 'static', 'passive']);
export const CLASS_NEEDS = Object.freeze(['tile', 'ally_or_self', 'enemy_near', 'monster_near', 'attach_effect']);
/** The power keys a foreign class may declare (not resolved by peer.mjs, not a hand class). */
export const CLASS_POWERS = Object.freeze(Object.keys(POWER_KEYS).filter(k => !POWER_KEYS[k].peer && !POWER_KEYS[k].hand));
const BUILTIN_ONLY = ['deal_order', 'card', 'bot', 'standing', 'extends'];
const HAND_KEYS = ['hand_reveal', 'hand_discard'];
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

// What the model writes (the generator adds schema, version, source).
export function stripClass(d) {
  const o = { id: d.id, name: d.name, data: d.data, flags: d.flags, power: d.power || BUILTIN_POWER[d.id] || BUILTIN_POWER[d.extends] || {} };
  if (d.ui) o.ui = d.ui;
  Object.assign(o, { uses: d.uses, hooks: d.hooks });
  return o;
}

const section = (doc, from, to) => { const a = doc.indexOf(from); if (a < 0) return ''; const b = to ? doc.indexOf(to, a + from.length) : -1; return doc.slice(a, b < 0 ? undefined : b).trim(); };
export function systemPrompt({ dataDir = DATA } = {}) {
  const doc = fs.readFileSync(path.join(dataDir, 'SCHEMA.md'), 'utf8').replace(/\r/g, '');
  const fxDoc = fs.readFileSync(path.join(dataDir, '..', 'effects-data', 'SCHEMA.md'), 'utf8').replace(/\r/g, '');
  const lib = readJson(path.join(dataDir, 'lib', 'classes_std.json'));
  const subs = `library "classes_std":\n` + Object.entries(lib.subs).map(([k, s]) => `  ${k}(${(s.params || []).join(', ')})${s.doc ? ` — ${String(s.doc).slice(0, 160)}` : ''}`).join('\n');
  const examples = CLASS_GEN_EXAMPLES.map(id => JSON.stringify(stripClass(readJson(path.join(dataDir, 'classes', `${id}.json`))))).join('\n');
  const powers = CLASS_POWERS.map(k => `  ${k} (${POWER_KEYS[k].trigger}, ${POWER_KEYS[k].shape})`).join('\n');
  return [
    'You write new character classes for chaosD6, a hex card game. A class is a card in front of a hero: an ability it taps',
    '(tap: once, untapped again by emitting its colours; once_per_round: once per turn) or a rule that always holds (static,',
    'passive). You answer with ONE JSON object: a class definition.',
    'Fields: id ("class_" + lowercase words joined by _), name, data, flags, power, ui (optional), uses (["classes_std"]),',
    'hooks ({<hook>: <program>}).',
    'data = { ability_kind: tap | once_per_round | static | passive, colors: 2-5 DISTINCT elements (elem_vitality elem_souls',
    'elem_time elem_space elem_air elem_water elem_earth elem_fire elem_concentration elem_harmony — the colours that untap',
    'it), text (the card rules text, 1-3 sentences), plus the knobs your hooks read with {"class_data": [{"var": "class"}]}',
    '(e.g. range, still_actions) }.',
    'flags = { phase: "post" | "pre" | "local" | null (a static class), needs (what a tap targets: tile | ally_or_self |',
    'enemy_near | monster_near | attach_effect), local (a local ability: the same object the local hook returns), hooks (the',
    'list of the hook names you wrote programs for) }.',
    'power = what the class does, in the validator\'s vocabulary (the validator prices the class by it and refuses a program',
    'that does MORE than it declares). Keys a player class may use (trigger, value shape):',
    powers,
    'Shapes: n = an integer 1..20; true = true; range = {"range": 0..64}; life = {"life": n, "max": n}; grant = true |',
    '{"effect_id": …}; codes = true | {"codes": [action codes]}.',
    'Rules: no deal_order, card, bot, standing or extends (built-ins only); no {"engine": "js"} hooks and no "peer:" names in',
    'flags.hooks; no hand_reveal / hand_discard / handDefaults (hand classes are built-ins only); no build, plant,',
    'disable_traps, relocate, discard or reveal power (the game code resolves those for the built-ins only). A tap or',
    'once_per_round class needs an "ability" hook (phase post) or a "local" hook (phase local); a static class answers the',
    'hooks of its rule (end_turn, attack_out, step, stance, emits, …).',
    'Keep it fair: one clear benefit, priced like the examples. Do not copy an example; make what the player asks for.',
    '',
    section(doc, '## A class definition', '## Hooks'),
    '',
    section(doc, '## Hooks', '## The library'),
    '',
    'The JsonLogic dialect (shared with the effects; the cast-bound forms emit put out note return return_empty seed rng',
    'point_buy are refused in classes):',
    section(fxDoc, '## The dialect', '### Outcome'),
    '',
    subs,
    '',
    'Examples (existing classes, same JSON shape as your answer):',
    examples,
  ].join('\n');
}

export function answerSchema() {
  const str = { type: 'string' };
  return {
    type: 'object',
    properties: {
      id: { type: 'string', pattern: '^class_[a-z0-9_]+$' }, name: str,
      data: { type: 'object', properties: { ability_kind: { type: 'string', enum: CLASS_KINDS }, colors: { type: 'array', items: str, minItems: 1, maxItems: 5 }, text: str }, required: ['ability_kind', 'colors', 'text'] },
      flags: { type: 'object' }, power: { type: 'object' }, ui: { type: 'object' },
      uses: { type: 'array', items: { type: 'string', enum: CLASS_GEN_LIBS } }, hooks: { type: 'object' },
    },
    required: ['id', 'name', 'data', 'flags', 'power', 'uses', 'hooks'],
  };
}

export function assemble(raw, { model = '', idea = '', taken = new Set() } = {}) {
  const r = isObj(raw) ? raw : {};
  let id = typeof r.id === 'string' && /^class_[a-z0-9_]+$/.test(r.id) ? r.id : `class_gen_${Date.now().toString(36)}`;
  if (taken.has(id)) id = `${id}_gen`;   // never a built-in's id
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 80) : id;
  const def = {
    schema: 'chaosd6.class/2', id, name, version: '0.1.0',
    source: { collection: 'generated', custom: true, model, idea: String(idea).slice(0, 500), at: new Date().toISOString() },
    data: isObj(r.data) ? { ...r.data } : {},
    flags: isObj(r.flags) ? { ...r.flags } : {},
    power: isObj(r.power) ? r.power : {},
  };
  if (isObj(r.ui) && Object.keys(r.ui).length) def.ui = r.ui;
  def.uses = Array.isArray(r.uses) && r.uses.length ? r.uses.filter(u => typeof u === 'string') : ['classes_std'];
  def.hooks = isObj(r.hooks) ? r.hooks : {};
  return def;
}

// Shape repairs the validator would refuse and the model need not think about: built-in-only blocks, JS markers,
// peer: hook names, hand knobs, distinct colours, flags.hooks = the non-std programs written, the std library.
export function autoFix(def) {
  const fixed = [];
  const f = def.flags, d = def.data;
  for (const k of BUILTIN_ONLY) if (def[k] !== undefined) { delete def[k]; fixed.push(`dropped ${k} (built-ins only)`); }
  if (!CLASS_KINDS.includes(d.ability_kind)) { d.ability_kind = 'tap'; fixed.push('data.ability_kind = tap'); }
  if (Array.isArray(d.colors)) { const c = [...new Set(d.colors.filter(e => typeof e === 'string'))]; if (c.length !== d.colors.length) { d.colors = c; fixed.push('data.colors made distinct'); } }
  if (typeof d.text !== 'string') { d.text = ''; fixed.push('data.text = ""'); }
  for (const k of HAND_KEYS) if (d[k] !== undefined) { delete d[k]; fixed.push(`dropped data.${k} (hand classes are built-ins only)`); }
  if (f.handDefaults !== undefined) { delete f.handDefaults; fixed.push('dropped flags.handDefaults'); }
  for (const k of Object.keys(def.power)) if (POWER_KEYS[k] && !CLASS_POWERS.includes(k)) { delete def.power[k]; fixed.push(`dropped power.${k} (built-in classes only)`); }
  for (const k of Object.keys(def.hooks)) {
    const h = def.hooks[k];
    if (isObj(h) && Object.prototype.hasOwnProperty.call(h, 'engine')) { delete def.hooks[k]; fixed.push(`dropped the ${k} hook (a JS marker)`); }
  }
  if (isObj(def.hooks.local) && def.hooks.local.quote && !isObj(f.local) && isObj(def.hooks.local.quote)) { f.local = def.hooks.local.quote; fixed.push('flags.local = the local hook\'s answer'); }
  if (def.hooks.local && f.phase !== 'local') { f.phase = 'local'; fixed.push('flags.phase = local (a local hook)'); }
  const STD = ['colours', 'kind', 'ready', 'config', 'strike', 'restore', 'progress', 'life_points'];
  const want = Object.keys(def.hooks).filter(h => !STD.includes(h) || h === 'config');
  const had = Array.isArray(f.hooks) ? f.hooks : [];
  if (JSON.stringify(want) !== JSON.stringify(had)) { f.hooks = want; fixed.push('flags.hooks = the hooks with a program'); }
  if (!def.uses.includes('classes_std')) { def.uses = [...def.uses, 'classes_std']; fixed.push('added library classes_std to uses'); }
  return fixed;
}

// The editor's publish check (the same one POST publish runs). → { ok, verdict, problems[], check }
export async function checkClassDraft(def, { validateDefinition = null } = {}) {
  validateDefinition ||= (await import('./editor-api.mjs')).validateDefinition;
  let v;
  try { v = await validateDefinition('class', def); } catch (e) { return { ok: false, verdict: 'reject', problems: [`validator error: ${e.message}`], check: null }; }
  const problems = [...(v.errors || [])];
  if (v.verdict && v.verdict !== 'ok') problems.push(...(v.report?.reasons || []));
  if (v.verdict === 'nerf' || v.verdict === 'boost') for (const s of (v.report?.suggestions || []).slice(0, 4)) problems.push(`suggestion: ${s.change}`);
  const verdict = v.errors?.length ? 'reject' : (v.verdict || 'reject');
  let check = null;
  if (v.verdict) { try { check = (await import('./tools/classes-rebalancing-check.mjs')).checkClass(def); } catch {} }
  return { ok: v.ok && verdict === 'ok', verdict, problems: [...new Set(problems)].slice(0, 20), check };
}

export function classSpec({ validateDefinition = null } = {}) {
  return {
    kind: 'class', expect: 650,
    systemPrompt: () => systemPrompt(), answerSchema, strip: stripClass, assemble, autoFix,
    taken: () => new Set(fs.readdirSync(path.join(DATA, 'classes')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))),
    check: (def) => checkClassDraft(def, { validateDefinition }),
  };
}

/** generateClass({ idea, cfg, prior, changes, onProgress, log }) → the generateDef result. */
export function generateClass({ validateDefinition = null, ...o }) {
  return generateDef(classSpec({ validateDefinition }), o);
}
