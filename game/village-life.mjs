// Village life (chaosD6-GameModels, 2026-11-24): who lives in a village at a given turn, which of them walk the map,
// what they say. Pure (no I/O) — peer.mjs villageTick() / agendaPlan() / questTick() drive it.
//
// Units of a village (all deterministic from the seed, the founding turn and the world-edit ledger):
//   residents   the template's residents, there from the founding        label <vid>_r<i>
//   produced    each standing producer building makes one of its NPC every `every_turns` turns after the founding,
//               while fewer than `cap` units are alive                     label <vid>_p<building index>_<n>
//   gone        a unit seen dead (`vgone:<label>` edit) or recruited by a hero (`vrec:<label>`) never comes back;
//               its place in the cap is free again for the producers.
// Only a few are ACTIVE (a running peer) at a time — the nearest-to-a-hero villages, the most useful roles first —
// the others are the village's count (its centre card shows it). A villager far from every hero leaves the map
// (it is not gone: it walks out again when a hero comes near).
import { villageResidents, villageWanderers, villagesNear, compass, villageCatalog } from './js/villages.js';

const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
export const ROLE_PRIORITY = { quest_giver: 0, storyteller: 1, guard: 2, builder: 3, healer: 4, villager: 5, wanderer: 6 };
export const MAX_PRODUCED = 64;   // safety bound on the production timeline

// → [{ label, npc, name, q, r, born, kind: 'resident'|'produced' }] alive at `turn` (founding `founded`; `gone`:
// Set of labels; `broken`: Set of 'q,r' of broken buildings), oldest first, at most the village cap.
export function villageUnits(seed, v, { turn, founded, gone = new Set(), broken = new Set() }) {
  const cat = villageCatalog();
  const t = cat?.villages?.[v.template];
  if (!t || !Number.isInteger(founded)) return [];
  const events = villageResidents(seed, v).map(r => ({ ...r, born: founded, kind: 'resident' }));
  (t.layout || []).forEach((l, bi) => {
    const b = cat.buildings[l.building];
    const q = v.q + l.at[0], r = v.r + l.at[1];
    if (!b?.produces || broken.has(`${q},${r}`)) return;
    const npc = b.produces.npc, every = b.produces.every_turns;
    for (let n = 1; n <= MAX_PRODUCED && founded + n * every <= turn; n++) {
      events.push({ npc, q: v.q + l.at[0], r: v.r + l.at[1], label: `${v.id.replace(/[^a-z0-9]+/gi, '_')}_p${bi}_${n}`, name: `${cat.npcs[npc]?.name || 'Villager'} of ${v.name}`, born: founded + n * every, kind: 'produced', from: l.building });
    }
  });
  events.sort((a, b) => a.born - b.born || (a.label < b.label ? -1 : 1));
  const alive = [];
  for (const e of events) {
    if (alive.length >= t.cap) {
      if (e.kind === 'produced') continue;   // full: the producer waits (this slot is skipped)
    }
    if (gone.has(e.label)) continue;
    if (alive.length < t.cap) alive.push(e);
  }
  return alive;
}
// The units worth a running peer now: the gate guard first (a walled village is shut without him), then roles in
// ROLE_PRIORITY order, then oldest; at most `max`.
export function activeUnits(units, max) {
  const cat = villageCatalog();
  const rank = (u) => u.post === 'gate' ? -1 : ROLE_PRIORITY[cat?.npcs?.[u.npc]?.role] ?? 9;
  return [...units].sort((a, b) => rank(a) - rank(b) || a.born - b.born || (a.label < b.label ? -1 : 1)).slice(0, Math.max(0, max));
}
export const wanderersOf = (seed, v, gone = new Set()) => villageWanderers(seed, v).filter(w => !gone.has(w.label));

// A line of an NPC: `kind` (greet / quest / thanks / lore / warn) rotated by `n`, placeholders filled from `vars`.
export function npcLine(npc, kind, n, vars = {}) {
  const list = npc?.lines?.[kind];
  if (!Array.isArray(list) || !list.length) return '';
  const tpl = list[((n % list.length) + list.length) % list.length];
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? '') === '' ? m : String(vars[k])).replace(/\{\w+\}/g, '').replace(/\s{2,}/g, ' ').trim();
}
// A storyteller's fact about the Dimension, `n` rotating through what it knows: other villages (name, race,
// direction, distance), a monster near by, the heroes walking the land, the Dimension's name.
export function loreFact(seed, v, here, n, { monsters = [], heroes = 0, dimension = '' } = {}) {
  const facts = [];
  for (const o of villagesNear(seed, here.q, here.r, 450).filter(o => o.id !== v?.id).slice(0, 3)) facts.push(`${o.team} of the ${o.race_name} lies ${compass(here, o)}, ${Math.round(dist(here, o))} hexes away`);
  const m = [...monsters].sort((a, b) => dist(here, a) - dist(here, b))[0];
  if (m) facts.push(`a ${m.name} prowls ${compass(here, m)} of here, ${Math.round(dist(here, m))} hexes off`);
  if (heroes > 0) facts.push(`${heroes} hero${heroes === 1 ? '' : 'es'} walk${heroes === 1 ? 's' : ''} this Dimension`);
  if (dimension) facts.push(`this land is called ${dimension}`);
  if (v) facts.push(`${v.name} was raised by the ${v.race_name}`);
  return facts.length ? facts[((n % facts.length) + facts.length) % facts.length] : '';
}
// The archive items a quest's `need` reads: [{ kind, id, tags }] from peer.mjs archive cards.
export function archiveItems(archive, creatureTags = () => []) {
  return (archive || []).map(c => c?.kind === 'effect' ? { kind: 'effect', id: c.effect_id } : c?.kind === 'skill' ? { kind: 'skill', id: c.skill_id }
    : c?.kind === 'creature' ? { kind: 'creature', id: c.creature_id, tags: creatureTags(c.creature_id) } : null).filter(x => x && x.id);
}
export const rewardWords = (r, nameOf = (id) => id) => r.kind === 'reputation' ? `our trust in you grows by ${r.value}%` : r.kind === 'allies' ? `${r.count} of us will follow you`
  : r.kind === 'effect' || r.kind === 'skill' ? `take this ${nameOf(r.id)}` : r.kind === 'enter' ? 'our gates are open to you' : '';
