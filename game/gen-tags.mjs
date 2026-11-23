// The tags a player picks in the editor's "Generate from a description…" form (user 2026-11-23: the description uses the
// well-known tags the built-ins have — elem_water, instant, point_buy, … — and they are CHECKED, a hard requirement).
// A tag is "<group>:<value>". vocab(kind) lists the groups (values gathered from the built-in definitions + the engine's
// enums); tagProblems(kind, def, tags) → the tags the draft does not meet, worded for the model ([] = all met).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_ELEMS } from './effect-engine.mjs';
import { GEN_KINDS as FX_KINDS, GEN_DURATIONS } from './effect-gen.mjs';
import { SKILL_ACTIONS, SKILL_STATS } from './skill-gen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCOPES = ['target', 'all_enemies', 'all_adjacent', 'all_seen', 'everyone', 'self', 'self_or_ally', 'self_or_enemy'];
const SKILL_DOES = ['attackBonus', 'damageOff', 'negate', 'counterSkill', 'counterElement', 'voidEmission', 'swap', 'reach', 'trapImmune', 'tauntGuard', 'blockDenied', 'immuneTo', 'invincibleWhile', 'effectShield', 'selfLock'];
const readDefs = (sub) => { const dir = path.join(HERE, sub); try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const countBy = (lists) => { const m = new Map(); for (const l of lists) for (const x of l || []) if (typeof x === 'string') m.set(x, (m.get(x) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v); };

// group → { label, values, has(def, value) → bool, now(def) → what the draft has (for the message) }
function groupsOf(kind) {
  if (kind === 'effect') {
    const fx = readDefs('effects-data/effects');
    return {
      element: { label: 'element', values: [...ALL_ELEMS], has: (d, v) => (d.elements || []).includes(v), now: (d) => (d.elements || []).join(', ') || 'none' },
      kind: { label: 'kind', values: [...FX_KINDS], has: (d, v) => d.kind === v, now: (d) => d.kind },
      duration: { label: 'duration', values: [...GEN_DURATIONS], has: (d, v) => d.duration === v, now: (d) => d.duration },
      damage: { label: 'damage', values: ['delta', 'pointbuy'], has: (d, v) => d.flags?.damage === v, now: (d) => d.flags?.damage ?? 'none' },
      scope: { label: 'scope', values: SCOPES, has: (d, v) => d.flags?.scope === v, now: (d) => d.flags?.scope ?? 'none' },
      type: { label: 'effect type', values: countBy(fx.map(d => d.card?.data?.effect_types)), has: (d, v) => (d.card?.data?.effect_types || []).includes(v), now: (d) => (d.card?.data?.effect_types || []).join(', ') || 'none' },
      tag: { label: 'card tag', values: countBy(fx.map(d => d.card?.tags)), has: (d, v) => (d.card?.tags || []).includes(v), now: (d) => (d.card?.tags || []).join(', ') || 'none' },
    };
  }
  if (kind === 'skill') {
    return {
      action: { label: 'rides on', values: [...SKILL_ACTIONS], has: (d, v) => d.action_type === v, now: (d) => d.action_type },
      lasts: { label: 'lasts', values: ['instant', 'permanent'], has: (d, v) => (v === 'permanent') === (d.is_permanent === true), now: (d) => (d.is_permanent ? 'permanent' : 'instant') },
      stat: { label: 'point-buy stat', values: [...SKILL_STATS], has: (d, v) => d.point_buy_stat === v, now: (d) => d.point_buy_stat ?? 'none' },
      does: { label: 'does', values: SKILL_DOES, has: (d, v) => d.flags?.[v] !== undefined && d.flags?.[v] !== false, now: (d) => SKILL_DOES.filter(k => d.flags?.[k] !== undefined && d.flags?.[k] !== false).join(', ') || 'nothing priced' },
    };
  }
  return {};
}

/** → { kind, groups: [{ id, label, values[] }] } for the editor's chips. */
export function vocab(kind) {
  return { kind, groups: Object.entries(groupsOf(kind)).map(([id, g]) => ({ id, label: g.label, values: g.values })) };
}

/** Normalise the picked tags: known "<group>:<value>" strings only, unique, ≤ 12. */
export function cleanTags(kind, tags) {
  const g = groupsOf(kind);
  const out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const [k, ...rest] = String(t).split(':'); const v = rest.join(':');
    if (g[k]?.values.includes(v) && !out.includes(`${k}:${v}`)) out.push(`${k}:${v}`);
  }
  return out.slice(0, 12);
}

/** The prompt line: "Required: element elem_water; duration instant". */
export function tagsPrompt(kind, tags) {
  const g = groupsOf(kind);
  const t = cleanTags(kind, tags);
  if (!t.length) return '';
  return `Required (the player picked these tags; the answer must match every one): ${t.map(x => { const [k, v] = x.split(':'); return `${g[k].label} ${v}`; }).join('; ')}.`;
}

/** → ["tag element:elem_water is not met (elements: elem_fire)", …] */
export function tagProblems(kind, def, tags) {
  const g = groupsOf(kind);
  const out = [];
  for (const t of cleanTags(kind, tags)) {
    const [k, v] = t.split(':');
    if (!g[k].has(def || {}, v)) out.push(`tag ${t} is not met (${g[k].label}: ${g[k].now(def || {})})`);
  }
  return out;
}
