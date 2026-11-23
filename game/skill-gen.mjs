// Skill generation (2026-11-23, the editor's "Generate from a description…" for skills): the big model writes a
// chaosd6.skill/1 definition (a player-branch skill: action_type, permanence, flags, hook programs in the effects'
// JsonLogic dialect) and THIS node judges it with the editor's own publish check (editor-api.mjs validateDefinition:
// id / schema / foreign rules, skill-engine validateSkillDef, tools/skills-rebalancing-check.mjs checkSkill — the
// validator every peer runs on a foreign skill). Same loop as effects (effect-gen.mjs generateDef); a local draft only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDef } from './effect-gen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'skills-data');
// Simple per-skill hooks, no pass programs (those order the built-ins), no JS-marked hooks.
export const SKILL_GEN_EXAMPLES = Object.freeze(['skill_dodge', 'skill_powerful_attack', 'skill_barricade', 'skill_ranged_weapon', 'skill_taunt']);
export const SKILL_GEN_LIBS = Object.freeze(['skills_std']);
export const SKILL_ACTIONS = Object.freeze(['A', 'M', 'B', 'P']);
export const SKILL_STATS = Object.freeze(['stat_vitality', 'stat_world', 'stat_matter', 'stat_will', 'any']);
const ORDER_FLAGS = ['passOrder', 'buildingSkill', 'planLock'];
const PASS_HOOKS = ['counter_pre', 'negate_action', 'negate_kind', 'trance_assign'];
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

// What the model writes (the generator adds schema, version, source).
export function stripSkill(d) {
  const flags = { ...(d.flags || {}) };
  for (const k of ORDER_FLAGS) delete flags[k];
  const o = { id: d.id, name: d.name, action_type: d.action_type, is_permanent: !!d.is_permanent, point_buy_stat: d.point_buy_stat ?? null };
  if (d.fixed_power !== undefined) o.fixed_power = d.fixed_power;
  Object.assign(o, { text: d.text, flags, uses: d.uses, hooks: d.hooks });
  return o;
}

const section = (doc, from, to) => { const a = doc.indexOf(from); if (a < 0) return ''; const b = to ? doc.indexOf(to, a + from.length) : -1; return doc.slice(a, b < 0 ? undefined : b).trim(); };
export function systemPrompt({ dataDir = DATA } = {}) {
  const doc = fs.readFileSync(path.join(dataDir, 'SCHEMA.md'), 'utf8').replace(/\r/g, '');
  const fxDoc = fs.readFileSync(path.join(dataDir, '..', 'effects-data', 'SCHEMA.md'), 'utf8').replace(/\r/g, '');
  const lib = readJson(path.join(dataDir, 'lib', 'skills_std.json'));
  const subs = `library "skills_std":\n` + Object.entries(lib.subs).map(([k, s]) => `  ${k}(${(s.params || []).join(', ')})${s.doc ? ` — ${s.doc}` : ''}`).join('\n');
  const examples = SKILL_GEN_EXAMPLES.map(id => JSON.stringify(stripSkill(readJson(path.join(dataDir, 'skills', `${id}.json`))))).join('\n');
  return [
    'You write new skills for chaosD6, a hex card game. A skill card rides on one action card of a round (Attack A, Move M,',
    'Block B, Posture P; M and P skills also ride on an empty action) and changes how that action resolves. You answer with',
    'ONE JSON object: a skill definition.',
    'Fields: id ("skill_" + lowercase words joined by _), name, action_type (A | M | B | P), is_permanent (true: the card stays',
    'in front of the deck after it lands; false: an instant for this action), point_buy_stat (a permanent: stat_vitality |',
    'stat_world | stat_matter | stat_will | any; an instant: null), fixed_power (optional, a permanent only, 1..6), text (the',
    'card rules text, 1-3 sentences), flags (see below), uses (["skills_std"]), hooks ({<hook>: <program>}).',
    'flags = the resolver keys action (= action_type), permanent (= is_permanent), pointBuyStat (the stat without "stat_",',
    'permanents only), negating (bool), hooks (the list of the hook names you wrote programs for), range, keepsTarget — PLUS',
    'the validator keys that say what the skill does (the validator prices the skill by them and refuses a program that does',
    'MORE than they declare): attackBonus n (+n damage on my landing Attack, 1..2), damageOff n (−n on the first combat hit I',
    'take, 1..2), negate {codes, who: "target"|"adjacent", mode: "ep"|"em"|"no_move"}, counterSkill true, counterElement true,',
    'voidEmission true, swap true, reach n (2..3, permanent only), trapImmune true, tauntGuard true, blockDenied true,',
    'immuneTo [codes] (permanent only), invincibleWhile [codes] (permanent only), effectShield true (permanent only),',
    'selfLock {codes, until: "end_of_round"}.',
    'Rules: no deal_order, card, ui, passOrder, buildingSkill or planLock (built-ins only); no {"engine": "js"} hooks; only the',
    'per-action hooks of the table (block_in, block_cost, attack_range, attack_out, attack_target, attack_vs_block, defend_in,',
    'damage_in, effect_in, effect_leg, end_round, perm_landing, perm_stats, disposition, plan_lock) — not the pass hooks.',
    'A program tests its owner with {"has_skill": [<id>, {"var": "skill"}]} (an instant) or {"has_perm": [<id>, {"var": "skill"}]}',
    '(a permanent), never with a literal skill id. No randomness: skills have no dice. A permanent lists',
    '"perm_landing": {"call": ["perm_landing"]}, "perm_stats": {"call": ["perm_stats"]}.',
    'Keep it fair: one clear, small benefit; a permanent is stronger than an instant. Do not copy an example; make what the',
    'player asks for.',
    '',
    section(doc, '### `flags`', '## Hooks'),
    '',
    section(doc, '## Hooks', '### Pass hooks as data'),
    '',
    section(doc, '## Vocabulary', '## Library `skills_std`'),
    '',
    'The JsonLogic dialect (shared with the effects; the outcome / dice forms emit put out note return seed rng point_buy are refused in skills):',
    section(fxDoc, '## The dialect', '### Outcome'),
    '',
    subs,
    '',
    'Examples (existing skills, same JSON shape as your answer):',
    examples,
  ].join('\n');
}

export function answerSchema() {
  const str = { type: 'string' };
  return {
    type: 'object',
    properties: {
      id: { type: 'string', pattern: '^skill_[a-z0-9_]+$' }, name: str,
      action_type: { type: 'string', enum: SKILL_ACTIONS }, is_permanent: { type: 'boolean' },
      point_buy_stat: { anyOf: [{ type: 'string', enum: SKILL_STATS }, { type: 'null' }] },
      fixed_power: { type: 'integer', minimum: 1, maximum: 6 },
      text: str, flags: { type: 'object' }, uses: { type: 'array', items: { type: 'string', enum: SKILL_GEN_LIBS } },
      hooks: { type: 'object' },
    },
    required: ['id', 'name', 'action_type', 'is_permanent', 'point_buy_stat', 'text', 'flags', 'uses', 'hooks'],
  };
}

export function assemble(raw, { model = '', idea = '', taken = new Set() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let id = typeof r.id === 'string' && /^skill_[a-z0-9_]+$/.test(r.id) ? r.id : `skill_gen_${Date.now().toString(36)}`;
  if (taken.has(id)) id = `${id}_gen`;   // never a built-in's id
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 80) : id;
  const action = SKILL_ACTIONS.includes(r.action_type) ? r.action_type : 'A';
  const perm = r.is_permanent === true;
  const def = {
    schema: 'chaosd6.skill/1', id, name, version: '0.1.0',
    source: { collection: 'generated', custom: true, model, idea: String(idea).slice(0, 500), at: new Date().toISOString() },
    action_type: action, is_permanent: perm,
    point_buy_stat: perm ? (SKILL_STATS.includes(r.point_buy_stat) ? r.point_buy_stat : 'stat_vitality') : null,
  };
  if (perm && Number.isInteger(r.fixed_power)) def.fixed_power = r.fixed_power;
  def.text = typeof r.text === 'string' ? r.text.trim() : '';
  def.flags = r.flags && typeof r.flags === 'object' && !Array.isArray(r.flags) ? { ...r.flags } : {};
  def.uses = Array.isArray(r.uses) && r.uses.length ? r.uses.filter(u => typeof u === 'string') : ['skills_std'];
  def.hooks = r.hooks && typeof r.hooks === 'object' && !Array.isArray(r.hooks) ? r.hooks : {};
  return def;
}

// Shape repairs the validator would refuse and the model need not think about: the resolver keys that must equal the
// top-level fields, flags.hooks = the programs written, no built-in order flags, the std per-permanent hooks.
export function autoFix(def) {
  const fixed = [];
  const f = def.flags;
  if (f.action !== def.action_type) { f.action = def.action_type; fixed.push('flags.action = action_type'); }
  if (f.permanent !== def.is_permanent) { f.permanent = def.is_permanent; fixed.push('flags.permanent = is_permanent'); }
  const pbs = def.point_buy_stat ? def.point_buy_stat.replace(/^stat_/, '') : undefined;
  if (def.is_permanent && f.pointBuyStat !== pbs) { f.pointBuyStat = pbs; fixed.push('flags.pointBuyStat from point_buy_stat'); }
  if (!def.is_permanent && f.pointBuyStat !== undefined) { delete f.pointBuyStat; fixed.push('dropped flags.pointBuyStat (an instant)'); }
  if (typeof f.negating !== 'boolean') { f.negating = false; fixed.push('flags.negating = false'); }
  for (const k of ORDER_FLAGS) if (f[k] !== undefined) { delete f[k]; fixed.push(`dropped flags.${k} (built-ins only)`); }
  for (const k of Object.keys(def.hooks)) {
    const h = def.hooks[k];
    if (PASS_HOOKS.includes(k) || (h && typeof h === 'object' && h.engine)) { delete def.hooks[k]; fixed.push(`dropped the ${k} hook (${PASS_HOOKS.includes(k) ? 'a pass hook' : 'a JS marker'})`); }
  }
  if (def.is_permanent) for (const k of ['perm_landing', 'perm_stats']) if (!def.hooks[k]) { def.hooks[k] = { call: [k] }; fixed.push(`added the std ${k} hook`); }
  const want = Object.keys(def.hooks);
  const had = Array.isArray(f.hooks) ? f.hooks : [];
  const keep = had.filter(h => ['plan', 'move'].includes(h));   // peer-side hook points a flag list may name
  const next = [...new Set([...want, ...keep])];
  if (JSON.stringify(next) !== JSON.stringify(had)) { f.hooks = next; fixed.push('flags.hooks = the hooks with a program'); }
  if (!def.uses.includes('skills_std') && JSON.stringify(def.hooks).includes('"call"')) { def.uses = [...def.uses, 'skills_std']; fixed.push('added library skills_std to uses'); }
  return fixed;
}

// The editor's publish check (the same one POST publish runs). → { ok, verdict, problems[], check }
export async function checkSkillDraft(def, { validateDefinition = null } = {}) {
  validateDefinition ||= (await import('./editor-api.mjs')).validateDefinition;
  let v;
  try { v = await validateDefinition('skill', def); } catch (e) { return { ok: false, verdict: 'reject', problems: [`validator error: ${e.message}`], check: null }; }
  const problems = [...(v.errors || [])];
  if (v.verdict && v.verdict !== 'ok') problems.push(...(v.report?.reasons || []));
  if (v.verdict === 'nerf' || v.verdict === 'boost') for (const s of (v.report?.suggestions || []).slice(0, 4)) problems.push(`suggestion: ${s.change}`);
  const verdict = v.errors?.length ? 'reject' : (v.verdict || 'reject');
  // the raw validator result (power, band, audit, reasons, suggestions) for the draft's log — validateDefinition keeps a summary
  let check = null;
  if (v.verdict) { try { check = (await import('./tools/skills-rebalancing-check.mjs')).checkSkill(def); } catch {} }
  return { ok: v.ok && verdict === 'ok', verdict, problems: [...new Set(problems)].slice(0, 20), check };
}

export function skillSpec({ validateDefinition = null } = {}) {
  return {
    kind: 'skill', expect: 450,
    systemPrompt: () => systemPrompt(), answerSchema, strip: stripSkill, assemble, autoFix,
    taken: () => new Set(fs.readdirSync(path.join(DATA, 'skills')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))),
    check: (def) => checkSkillDraft(def, { validateDefinition }),
  };
}

/** generateSkill({ idea, cfg, prior, changes, onProgress, log }) → the generateDef result. */
export function generateSkill({ validateDefinition = null, ...o }) {
  return generateDef(skillSpec({ validateDefinition }), o);
}
