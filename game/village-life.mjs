// Village life (chaosD6-GameModels, 2026-11-24): who lives in a village at a given turn, which of them walk the map,
// what they say. Pure (no I/O) — peer.mjs villageTick() / agendaPlan() / questTick() drive it.
//
// Units of a village (all deterministic from the seed, the founding turn and the world-edit ledger):
//   residents   the template's residents, there from the founding        label <vid>_r<i>
//   produced    each standing producer building makes one of its NPC every `every_turns` turns after the founding,
//               while fewer than `cap` units are alive                     label <vid>_p<building index>_<n>
//   reborn      (2026-11-25, the user: "each NPC in case of dying is produced again from a building in the village")
//               a resident that died (`vgone:<label>` { turn }) — or that a hero led away and that died there, or a
//               diplomat that stayed as an envoy — comes back from its home building RESPAWN_TURNS after (a fighter
//               after FIGHTER_RESPAWN_TURNS), while that building stands: label <vid>_r<i>_g<n> (its n-th life). The
//               builders come back from the centre building. A recruited unit still alive elsewhere leaves its slot empty.
// Only a few are ACTIVE (a running peer) at a time — the nearest-to-a-hero villages, the most useful roles first —
// the others are the village's count (its centre card shows it). A villager far from every hero leaves the map
// (it is not gone: it walks out again when a hero comes near).
import { villageResidents, villageWanderers, villagesNear, compass, villageCatalog, personName } from './js/villages.js';

const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
export const ROLE_PRIORITY = { dragon: -0.5, quest_giver: 0, storyteller: 1, trader: 2, builder: 3, engineer: 3.5, diplomat: 3.7, smith: 4, wizard: 5, mercenary: 6, guard: 7, healer: 8, fighter: 8.5, villager: 9, wanderer: 10 };   // + diplomat, fighter (2026-11-25)   // the builder before the guards: it is for hire (2026-11-24); the dragon always out, the engineer for hire too (2026-11-25)
export const MAX_PRODUCED = 64;   // safety bound on the production timeline

export const RESPAWN_TURNS = 20, FIGHTER_RESPAWN_TURNS = 50;
export const respawnDelay = (npc) => npc?.role === 'fighter' ? FIGHTER_RESPAWN_TURNS : RESPAWN_TURNS;
// The resident slot label of a unit label: '<vid>_r3_g2' → '<vid>_r3' (a follower's '<label>_f' too).
export const homeLabel = (label) => String(label || '').replace(/_f$/, '').replace(/_g\d+$/, '');
// The hex a resident is (re)born at: its home building's when that building is in the layout (the builders: the
// centre), else the centre. → { q, r, building } or null.
export function rebirthSite(v, npcId) {
  const cat = villageCatalog(), t = cat?.villages?.[v.template], n = cat?.npcs?.[npcId];
  if (!t) return null;
  const centre = (t.layout || []).find(l => cat.buildings[l.building]?.role === 'centre') || (t.layout || [])[0];
  const home = n?.role === 'builder' ? centre : (t.layout || []).find(l => l.building === n?.home) || centre;
  return home ? { q: v.q + home.at[0], r: v.r + home.at[1], building: home.building } : null;
}
// → [{ label, npc, name, q, r, born, kind: 'resident'|'produced', life }] alive at `turn` (founding `founded`;
// `gone`: Map label → the turn it died / left (null: no rebirth — e.g. recruited, still alive) — a Set means "gone
// for good" (older callers); `broken`: Set of 'q,r' of broken buildings), oldest first, at most the village cap.
export function villageUnits(seed, v, { turn, founded, gone = new Map(), broken = new Set() }) {
  const cat = villageCatalog();
  const t = cat?.villages?.[v.template];
  if (!t || !Number.isInteger(founded)) return [];
  const goneTurn = (l) => gone instanceof Map ? (gone.has(l) ? gone.get(l) : undefined) : gone.has(l) ? null : undefined;
  const events = [];
  for (const r0 of villageResidents(seed, v)) {
    let label = r0.label, born = founded, life = 0;
    for (let n = 0; n <= MAX_PRODUCED; n++) {
      const g = goneTurn(label);
      if (g === undefined) { events.push({ ...r0, label, born, kind: 'resident', life, ...(life ? { name: personName(seed, v, `${r0.label}_g${life}`, r0.npc) } : {}) }); break; }
      const site = rebirthSite(v, r0.npc);
      if (!Number.isFinite(g) || !site || broken.has(`${site.q},${site.r}`)) break;   // waits for its building (or never)
      const next = g + respawnDelay(cat.npcs[r0.npc]);
      if (next > turn) break;
      life = n + 1; label = `${r0.label}_g${life}`; born = next;
    }
  }
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
    if (e.kind === 'produced' && goneTurn(e.label) !== undefined) continue;
    if (alive.length < t.cap) alive.push(e);
  }
  return alive;
}
// The units worth a running peer now: the gate guard first (a walled village is shut without him), then roles in
// ROLE_PRIORITY order, then oldest; at most `max`.
export function activeUnits(units, max) {
  const cat = villageCatalog();
  const rank = (u) => u.post === 'gate' ? -1 : ROLE_PRIORITY[cat?.npcs?.[u.npc]?.role] ?? 11;
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
// How far, as a traveller says it (user 2026-11-24: "not the number of hexes … an Orc at 3 minutes walking distance
// at north-east"): a hero walks one hex per action, an action lasts `roundSec` seconds.
export function walkWords(hexes, roundSec = 6) {
  const m = hexes * roundSec / 60;
  if (hexes <= 2) return 'a stone\'s throw away';
  if (m < 0.9) return 'less than a minute\'s walk away';
  if (m < 1.5) return 'about a minute\'s walk away';
  if (m <= 20) return `about ${Math.round(m)} minutes' walk away`;
  if (m <= 45) return `half an hour's walk or so`;
  return `a long journey — the better part of ${m <= 75 ? 'an hour' : 'a day'} on foot`;
}
const pick = (list, n) => list[((n % list.length) + list.length) % list.length];
const article = (s) => /^(the |an? )/i.test(s) ? s : `${/^[aeiou]/i.test(s) ? 'an' : 'a'} ${s}`;
// One piece of intel as a storyteller tells it. `f` = { kind: monster | hero | village | dungeon | school | item |
// wanderer | quiet, name, dir, hexes, … }; `n` rotates the wording.
export function intelLine(f, n = 0, roundSec = 6) {
  const walk = Number.isFinite(f.hexes) ? walkWords(f.hexes, roundSec) : '';
  const dir = f.dir || 'somewhere';
  switch (f.kind) {
    case 'monster': return pick([
      `${article(f.name)} prowls to the ${dir}, ${walk}. Keep your blade loose in its sheath.`,
      `Scouts saw ${article(f.name)} to the ${dir} — ${walk}. It looked hungry.`,
      `Beware the ${dir}: ${article(f.name)} hunts there, ${walk}.`,
      `The birds went quiet to the ${dir}. ${article(f.name).replace(/^./, c => c.toUpperCase())} — ${walk}.`,
    ], n);
    case 'pack': return pick([
      `${f.count} ${f.name}s run together to the ${dir}, ${walk}. Do not meet them alone.`,
      `A pack — ${f.count} ${f.name}s — was seen to the ${dir}, ${walk}.`,
    ], n);
    case 'hero': return pick([
      `Another hero walks the land: ${f.name}, ${walk} to the ${dir}. Friend or foe, who can say?`,
      `A stranger called ${f.name} passed to the ${dir} — ${walk}. Armed, and in a hurry.`,
    ], n);
    case 'village': return pick([
      `${f.name} of the ${f.race} stands to the ${dir}, ${walk}. Tell them we sent you.`,
      `Follow the ${dir} road and you reach ${f.name}, where the ${f.race} live — ${walk}.`,
    ], n);
    case 'dungeon': return f.explored
      ? `Old stones hide a dungeon to the ${dir}, ${walk}. Someone emptied it lately — give it time.`
      : pick([
        `Old stones hide a dungeon to the ${dir}, ${walk}. A trap waits inside — and what it guards.`,
        `There is a hole in the earth to the ${dir}, ${walk}: the ${f.name}. Brave fools come back richer.`,
      ], n);
    case 'school': return `The ${f.name} to the ${dir} (${walk}) still teaches those who rest there a while.`;
    case 'item': return pick([
      `${article(f.name).replace(/^./, c => c.toUpperCase())} hums with ${f.elem} to the ${dir}, ${walk}. Stand upon it and that power is yours.`,
      `To the ${dir}, ${walk}, lies ${article(f.name)} — ${f.elem} gathers there.`,
    ], n);
    case 'wanderer': return `${f.name} roams the wilds to the ${dir}, ${walk}. Ask for news if you meet them.`;
    case 'dimension': return `This land is called ${f.name}. ${f.heroes ? `${f.heroes} hero${f.heroes === 1 ? '' : 'es'} walk${f.heroes === 1 ? 's' : ''} it now.` : 'Few heroes walk it.'}`;
    case 'quiet': default: return pick(['The roads are quiet. Too quiet.', 'Nothing stirs near by — enjoy it while it lasts.'], n);
  }
}
// A storyteller's fact about the Dimension, `n` rotating through what it knows: other villages, a monster near by,
// the heroes walking the land, the Dimension's name — as intelLine says it (direction + walking time).
export function loreFact(seed, v, here, n, { monsters = [], heroes = 0, dimension = '', roundSec = 6 } = {}) {
  const facts = [];
  for (const o of villagesNear(seed, here.q, here.r, 450).filter(o => o.id !== v?.id).slice(0, 3)) facts.push({ kind: 'village', name: o.team, race: o.race_name, dir: compass(here, o), hexes: dist(here, o) });
  const m = [...monsters].sort((a, b) => dist(here, a) - dist(here, b))[0];
  if (m) facts.push({ kind: 'monster', name: m.name, dir: compass(here, m), hexes: dist(here, m) });
  if (dimension) facts.push({ kind: 'dimension', name: dimension, heroes });
  return facts.length ? intelLine(pick(facts, n), n, roundSec) : '';
}
// The archive items a quest's `need` reads: [{ kind, id, tags }] from peer.mjs archive cards.
export function archiveItems(archive, creatureTags = () => []) {
  return (archive || []).map(c => c?.kind === 'effect' ? { kind: 'effect', id: c.effect_id } : c?.kind === 'skill' ? { kind: 'skill', id: c.skill_id }
    : c?.kind === 'creature' ? { kind: 'creature', id: c.creature_id, tags: creatureTags(c.creature_id) } : null).filter(x => x && x.id);
}
export const rewardWords = (r, nameOf = (id) => id) => r.kind === 'reputation' ? `our trust in you grows by ${r.value}%` : r.kind === 'allies' ? `${r.count} of us will follow you`
  : r.kind === 'effect' || r.kind === 'skill' ? `take this ${nameOf(r.id)}` : r.kind === 'enter' ? 'our gates are open to you' : '';

// A wild monster: a creature with no owner and no village.
export const isWildMonsterSnap = (p) => !!p?.creature_id && !p.owner_peer_id && !p.npc_id && p.alliance === 'npc_b';
// Villages are neutral in the resolver too (2026-11-24): two view snapshots → true when a village keeps them apart
// (no foes whatever their sides) — both villagers, or a villager and a unit that is no wild monster and not on the
// villager's hostile_to_csv (by its id, its owner, the hero it shadows). peer.mjs enemyOf; pure, so every resolver
// judges the same.
export const isVillagerSnap = (p) => !!p?.npc_id && !p.follower && !!p.village_id;
// `war(vidA, vidB)` (optional, 2026-11-25): true when two villages are at war (js/villages.js atWar) — their people fight.
export function villageNeutral(a, b, war = null) {
  const va = isVillagerSnap(a), vb = isVillagerSnap(b);
  if (!va && !vb) return false;
  if (va && vb) return !(war && a.village_id !== b.village_id && war(a.village_id, b.village_id));
  const vil = va ? a : b, other = va ? b : a;
  if (!other || isWildMonsterSnap(other)) return false;
  const hostile = String(vil.hostile_to_csv || '').split(',').filter(Boolean);
  return ![other.peer_id, other.owner_peer_id, other.shadow_of].some(k => k && hostile.includes(k));
}
