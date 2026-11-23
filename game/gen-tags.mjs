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
import { CLASS_KINDS, CLASS_NEEDS, CLASS_POWERS } from './class-gen.mjs';

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
      // mode: 'count' = a value may repeat (water, fire, water = two water elements in the cost; ≤ max in all),
      //       'one' = one value of the group (picking another replaces it), 'set' = any number, each once
      element: { label: 'element', mode: 'count', max: 4, values: [...ALL_ELEMS], count: (d, v) => (d.elements || []).filter(e => e === v).length, now: (d) => (d.elements || []).join(', ') || 'none' },
      kind: { label: 'kind', mode: 'one', values: [...FX_KINDS], has: (d, v) => d.kind === v, now: (d) => d.kind },
      duration: { label: 'duration', mode: 'one', values: [...GEN_DURATIONS], has: (d, v) => d.duration === v, now: (d) => d.duration },
      damage: { label: 'damage', mode: 'one', values: ['delta', 'pointbuy'], has: (d, v) => d.flags?.damage === v, now: (d) => d.flags?.damage ?? 'none' },
      scope: { label: 'scope', mode: 'one', values: SCOPES, has: (d, v) => d.flags?.scope === v, now: (d) => d.flags?.scope ?? 'none' },
      type: { label: 'effect type', mode: 'set', values: countBy(fx.map(d => d.card?.data?.effect_types)), has: (d, v) => (d.card?.data?.effect_types || []).includes(v), now: (d) => (d.card?.data?.effect_types || []).join(', ') || 'none' },
      tag: { label: 'card tag', mode: 'set', values: countBy(fx.map(d => d.card?.tags)), has: (d, v) => (d.card?.tags || []).includes(v), now: (d) => (d.card?.tags || []).join(', ') || 'none' },
    };
  }
  if (kind === 'skill') {
    return {
      action: { label: 'rides on', mode: 'one', values: [...SKILL_ACTIONS], has: (d, v) => d.action_type === v, now: (d) => d.action_type },
      lasts: { label: 'lasts', mode: 'one', values: ['instant', 'permanent'], has: (d, v) => (v === 'permanent') === (d.is_permanent === true), now: (d) => (d.is_permanent ? 'permanent' : 'instant') },
      stat: { label: 'point-buy stat', mode: 'one', values: [...SKILL_STATS], has: (d, v) => d.point_buy_stat === v, now: (d) => d.point_buy_stat ?? 'none' },
      does: { label: 'does', mode: 'set', values: SKILL_DOES, has: (d, v) => d.flags?.[v] !== undefined && d.flags?.[v] !== false, now: (d) => SKILL_DOES.filter(k => d.flags?.[k] !== undefined && d.flags?.[k] !== false).join(', ') || 'nothing priced' },
    };
  }
  if (kind === 'class') {
    return {
      ability: { label: 'ability', mode: 'one', values: [...CLASS_KINDS], has: (d, v) => d.data?.ability_kind === v, now: (d) => d.data?.ability_kind ?? 'none' },
      color: { label: 'colour', mode: 'set', values: [...ALL_ELEMS], has: (d, v) => (d.data?.colors || []).includes(v), now: (d) => (d.data?.colors || []).join(', ') || 'none' },
      power: { label: 'power', mode: 'set', values: [...CLASS_POWERS], has: (d, v) => d.power?.[v] !== undefined && d.power[v] !== false, now: (d) => Object.keys(d.power || {}).join(', ') || 'none' },
      needs: { label: 'targets', mode: 'one', values: [...CLASS_NEEDS], has: (d, v) => d.flags?.needs === v, now: (d) => d.flags?.needs ?? 'none' },
    };
  }
  return {};
}

/** → { kind, groups: [{ id, label, mode, max?, values[] }] } for the editor's tag editor. */
export function vocab(kind) {
  return { kind, groups: Object.entries(groupsOf(kind)).map(([id, g]) => ({ id, label: g.label, mode: g.mode, ...(g.max ? { max: g.max } : {}), values: g.values })) };
}

/** Normalise the picked tags (a list, in order): known "<group>:<value>" only; 'one' groups keep the last pick, 'set'
 *  groups each value once, 'count' groups repeat up to their max; ≤ 16 in all. */
export function cleanTags(kind, tags) {
  const g = groupsOf(kind);
  let out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const [k, ...rest] = String(t).split(':'); const v = rest.join(':');
    const grp = g[k];
    if (!grp?.values.includes(v)) continue;
    const tag = `${k}:${v}`;
    if (grp.mode === 'one') { out = out.filter(x => !x.startsWith(`${k}:`)); out.push(tag); }
    else if (grp.mode === 'count') { if (out.filter(x => x.startsWith(`${k}:`)).length < (grp.max || 4)) out.push(tag); }
    else if (!out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 16);
}

// "element:elem_water" ×2 → [{ tag, k, v, n }]
const tally = (list) => { const m = new Map(); for (const t of list) m.set(t, (m.get(t) || 0) + 1); return [...m.entries()].map(([tag, n]) => { const [k, v] = tag.split(':'); return { tag, k, v, n }; }); };

/** The prompt line: "Required: element elem_water ×2; element elem_fire; duration instant". */
export function tagsPrompt(kind, tags) {
  const g = groupsOf(kind);
  const t = tally(cleanTags(kind, tags));
  if (!t.length) return '';
  return `Required (the player picked these tags; the answer must match every one): ${t.map(({ k, v, n }) => `${g[k].label} ${v}${n > 1 ? ` ×${n} (that many times in the element cost)` : ''}`).join('; ')}.`;
}

/** → ["tag element:elem_water ×2 is not met (elements: elem_water, elem_fire)", …] */
export function tagProblems(kind, def, tags) {
  const g = groupsOf(kind);
  const out = [];
  for (const { tag, k, v, n } of tally(cleanTags(kind, tags))) {
    const grp = g[k], d = def || {};
    const met = grp.mode === 'count' ? grp.count(d, v) >= n : grp.has(d, v);
    if (!met) out.push(`tag ${tag}${n > 1 ? ` ×${n}` : ''} is not met (${grp.label}: ${grp.now(d)})`);
  }
  return out;
}
