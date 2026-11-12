// Map buildings and big landmarks (user rulings 2026-11-12). A unit gets a
// building's bonus while it stands there — nothing is consumed, the building
// stays. PURE (seed, q, r) → bonus, shared by the resolver (peer.mjs) and the
// browser (object card, stat pills), so every peer reads the same bonus off the
// same hex. The catalogue text (assets/features/feature_table.json `label` /
// `desc`) picks the flavour where it says something ("Resting here restores 1
// life" does exactly that); the hex hash picks the rest.
//
// Every walkable building does something (ruling #2, 2026-11-12):
//   stat: { vitality|world|matter|will: 5..10 }  added to that stat while here — it
//             raises the life maximum by the usual round((Σstats+bonus)/10) rule
//   power: one of
//     { kind: 'skill', skill }      a skill rides free on every action played here
//                                    (when the action fits it — Dodge on anything,
//                                    Powerful Attack on an Attack, …)
//     { kind: 'stance', code }      an Empty Posture here fights as `code` (P / B)
//     { kind: 'teleport' }          stepping in sends a hero to `teleportTargets`
//     { kind: 'walls' }             standing here at the end of a turn's 3rd action
//                                    raises a connected wall arc 5 hexes out (3 turns)
//     { kind: 'mend' }              end of the 3rd action here: +1 life
//     { kind: 'explore' }           end of the 3rd action here: a distant place
//                                    (20–28 hexes away) is explored
//     { kind: 'draw' }              end of the 3rd action here: draw a card
//     { kind: 'learn' }             (University / School / Academy / Library) end of the 3rd
//                                    action here: a random effect card joins your discard pile
//   Temples always mend (+1 life at the end of the 3rd action).
//   A dungeon (Dungeon / Lair / Cave / Crypt …, bonus { dungeon: true }, nothing else) is a pure trap
//   building: while unexplored it holds one random trap effect; the hero who ends the turn's 3rd
//   action there springs it, its card goes to that hero's discard pile and the dungeon is explored
//   (world edit `dng:q,r` { explored: turn }) — it re-arms with a new effect 5 turns later.
//     { kind: 'hurt' }              (haunted / plague text) end of the 3rd action: −1 life
//   A fortress (power { kind: 'fortress', stat, value }, no stat bonus) blocks the
//   way: an adjacent unit emitting that stat's element with that stat ABOVE
//   `value` (any successful point-buy) breaks it — world edit `bld:q,r` gone.
// Text extras kept from the first pass (all optional):
//   rest: n | 'all', restNear, guard: n, cover: n, sword: n, sanctuary, sight: n
import { featureAt } from './features.js';
import { bigFeatureAt } from './bigfeature.js';
import { hash32 } from './map.js';

const DIRS = [[+1, 0], [+1, -1], [0, -1], [-1, 0], [-1, +1], [0, +1]];
const STATS = ['vitality', 'world', 'matter', 'will'];
const STAT_NAME = { vitality: 'Vitality', world: 'World', matter: 'Matter', will: 'Will' };
// Skills a building can lend: the non-permanent ones the resolver implements.
export const BUILDING_SKILLS = ['skill_dodge', 'skill_powerful_attack', 'skill_intimidation', 'skill_grapple', 'skill_disruption_move', 'skill_bluff', 'skill_counter_spell'];
const SKILL_NAME = { skill_dodge: 'Dodge', skill_powerful_attack: 'Powerful Attack', skill_intimidation: 'Intimidation', skill_grapple: 'Grapple', skill_disruption_move: 'Disruption Move', skill_bluff: 'Bluff', skill_counter_spell: 'Counter Spell' };
const STANCE_NAME = { P: 'Posture', B: 'Block' };

// FNV-1a alone barely moves its top bits when only the last characters differ (neighbour hexes rolled alike),
// so mix it (murmur3 finaliser) before scaling to [0, 1).
const mix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
const roll = (seed, q, r, salt) => mix(hash32(`${seed}:bld:${salt}:${q}:${r}`)) / 4294967296;
const pickBy = (u, list) => list[Math.min(list.length - 1, Math.floor(u * list.length))];

// First match wins; tested against `${label} ${desc}`. The extras ride on top of the stat + power.
const BUILDING_RULES = [
  [/restores all lost life/i,                                   { rest: 'all' }],
  [/healing orb|resting adjacent heal|ending its turn adjacent heals/i, { rest: 1, restNear: true }],
  [/rest\w*[^.]*restores? 2 life|restore 2 life/i,              { rest: 2 }],
  [/rest\w*[^.]*restores? 1 life|restores 1 life/i,             { rest: 1 }],
  [/sanctuary/i,                                                { sanctuary: true }],
  [/ignore the first hit|cannot be pushed|cannot be ambushed/i, { guard: 1 }],
  [/\+1 block|\+1 to the next block|ramparts|cover:/i,          { cover: 1 }],
  [/\+1 (to the next )?attack|winning a fight|fire resistance|first visitor fights/i, { sword: 1 }],
  [/watch tower|reveals? (8 hexes|the map)|sees the whole/i,    { sight: 8 }],
];
// Which stat the boon favours, from the text (else the hash picks one).
const STAT_HINTS = [
  [/mine|quarry|foundry|furnace|forge|smith|mason/i, 'matter'],
  [/library|guild|school|academy|skill|mage|wizard|arcane/i, 'will'],
  [/temple|portal|ring|henge|obelisk|shrine|altar|grove|pool|tower/i, 'world'],
  [/barn|depot|shop|trad|alchemist|hut|camp|farm|inn|tavern|tree of life|healing/i, 'vitality'],
];
// Which power the text suggests (else the hash picks one by weight).
const POWER_HINTS = [
  [/portal|gate|henge|stone circle|ring of|waystone|teleport/i, 'teleport'],
  [/castle|fort|keep|citadel|bastion|stronghold|garrison|fortress/i, 'fortress'],
  [/watch|lookout|observ|beacon|spire/i, 'explore'],
  [/universit|school|academ|college|library|archive|scriptor/i, 'learn'],
  [/temple|shrine|altar|chapel|church|tree of life|healing|sanct/i, 'mend'],
  [/arena|training|barracks|dojo|camp|war/i, 'stance'],
  [/mage|wizard|arcane|crystal|orb|obelisk|magic|totem/i, 'skill'],
  [/quarry|mine|mason|forge|foundry|lumber/i, 'walls'],
];
// These names always get their power (user ruling 2026-11-12): temples mend, schools teach.
const POWER_ALWAYS = [[/temple/i, 'mend'], [/universit|school|academ|college|library/i, 'learn']];
export const DUNGEON = /dungeon|lair|cave|crypt|catacomb|cavern|grotto|\bden\b/i;
export const DUNGEON_REARM_TURNS = 5;
export const LEARN_REARM_TURNS = 60;   // a school teaches once, then is explored for 60 turns
const POWER_WEIGHTS = [['skill', 18], ['stance', 12], ['mend', 14], ['teleport', 10], ['walls', 9], ['explore', 10], ['draw', 9], ['fortress', 10]];
const HARMFUL = /lose 1 life|costs 1 life|haunted|plague|pit\b/i;

// Big landmarks: ruins, mines, rock piles and wrecks span their anchor hex and
// the six around it (`wide`); a tree or log gives its cover on its own hex only
// (forests are everywhere — cover on every hex near one would be no bonus at all).
const BIG_RULES = [
  [/temple|colonnade|ruin/i,           { rest: 1, stat: { world: 3 }, wide: true }],
  [/mine/i,                            { stat: { matter: 4 }, wide: true }],
  [/boulder|rock/i,                    { guard: 1, wide: true }],
  [/shipwreck/i,                       { stat: { vitality: 4 }, wide: true }],
  [/log/i,                             { cover: 1, stat: { vitality: 1 } }],
  [/tree|palm|pine/i,                  { cover: 1 }],
];

function ruleFor(rules, text, fallback) {
  for (const [re, b] of rules) if (re.test(text)) return b;
  return fallback;
}

// The full bonus of the catalogue building on (q, r) — deterministic from seed + hex + text.
function buildingBonus(seed, q, r, f) {
  const text = `${f.label || ''} ${f.desc || ''}`;
  if (DUNGEON.test(f.label || '')) return { dungeon: true };
  const extras = ruleFor(BUILDING_RULES, text, {});
  let kind = ruleFor(POWER_HINTS, text, null);
  // Text hints win half the time, so two Temples are not always the same building.
  if (!kind || roll(seed, q, r, 'hint') < 0.5) {
    const total = POWER_WEIGHTS.reduce((a, [, w]) => a + w, 0);
    let u = roll(seed, q, r, 'power') * total;
    for (const [k, w] of POWER_WEIGHTS) { u -= w; if (u < 0) { kind = k; break; } }
    kind ||= 'skill';
  }
  for (const [re, k] of POWER_ALWAYS) if (re.test(text)) { kind = k; break; }
  if (HARMFUL.test(text)) kind = 'hurt';
  // Every Shrine holds exactly one skill, rolled from its hex (user ruling 2026-11-12).
  if (/shrine/i.test(f.label || '')) kind = 'skill';
  const stat = ruleFor(STAT_HINTS, text, null) && roll(seed, q, r, 'shint') < 0.6 ? ruleFor(STAT_HINTS, text, null) : pickBy(roll(seed, q, r, 'stat'), STATS);
  if (kind === 'fortress') return { power: { kind, stat, value: 10 + Math.floor(roll(seed, q, r, 'fval') * 9) } };
  const power = kind === 'skill' ? { kind, skill: pickBy(roll(seed, q, r, 'skill'), BUILDING_SKILLS) }
    : kind === 'stance' ? { kind, code: roll(seed, q, r, 'stance') < 0.6 ? 'P' : 'B' }
    : { kind };
  return { ...extras, stat: { [stat]: 5 + Math.floor(roll(seed, q, r, 'sval') * 6) }, power };
}

// One line a player reads on the object card / log.
export function bonusText(b) {
  if (!b) return '';
  const out = [];
  for (const [k, v] of Object.entries(b.stat || {})) out.push(`+${v} ${STAT_NAME[k] || k} (your life maximum follows)`);
  const p = b.power;
  if (p?.kind === 'fortress') out.push(`blocks the way — break it by emitting a ${STAT_NAME[p.stat]} element next to it with ${STAT_NAME[p.stat]} above ${p.value} (any successful roll)`);
  if (p?.kind === 'skill') out.push(`${SKILL_NAME[p.skill] || p.skill} rides free on every action you play here (when the action fits it)`);
  if (p?.kind === 'stance') out.push(`an Empty Posture here fights as ${STANCE_NAME[p.code]}`);
  if (p?.kind === 'teleport') out.push('stepping in teleports a hero far away');
  if (p?.kind === 'walls') out.push('stand here at the end of a turn: a wall arc rises 5 hexes away (3 turns)');
  if (p?.kind === 'mend') out.push('stand here at the end of a turn: +1 life');
  if (p?.kind === 'explore') out.push('stand here at the end of a turn: a place 20+ hexes away is explored');
  if (p?.kind === 'draw') out.push('stand here at the end of a turn: draw a card');
  if (p?.kind === 'learn') out.push(`unexplored, it teaches once: stand here at the end of a turn — a random effect card joins your discard pile; then it is explored, and teaches again ${LEARN_REARM_TURNS} turns later`);
  if (b.dungeon) out.push(`a dungeon — unexplored, it hides a trap: end a turn's 3rd action here to explore it (the trap springs on you, its card joins your discard pile); it is unexplored again ${DUNGEON_REARM_TURNS} turns later`);
  if (p?.kind === 'hurt') out.push('cursed — stand here at the end of a turn: −1 life');
  if (b.rest) out.push(`rest here (Empty Posture, unhurt): ${b.rest === 'all' ? 'all lost life' : `+${b.rest} life`} once per turn${b.restNear ? ' — also on the hexes around it' : ''}`);
  if (b.sanctuary) out.push('no combat damage lands on you here');
  if (b.guard) out.push(`ignore the first ${b.guard} combat damage each action`);
  if (b.cover) out.push(`Block here: ${b.cover} less damage`);
  if (b.sword) out.push(`Attack from here: +${b.sword} damage`);
  if (b.sight) out.push(`see ${b.sight} hexes around`);
  return out.join(' · ');
}

const _memo = new Map();   // `${seed}|q,r` → { source, bonus } | null
// Bonus for a unit standing on (q, r): the catalogue building there, else a big
// landmark whose footprint covers it, else a rest-near building next door.
export function buildingBonusAt(seed, q, r) {
  const key = `${seed}|${q},${r}`;
  if (_memo.has(key)) return _memo.get(key);
  let res = null;
  const f = featureAt(seed, q, r);
  if (f && f.kind !== 'wall' && f.kind !== 'bridge') res = { source: f.label || f.id, kind: 'building', bonus: buildingBonus(seed, q, r, f) };
  if (!res) {
    for (const [dq, dr] of [[0, 0], ...DIRS]) {
      const big = bigFeatureAt(seed, q + dq, r + dr);
      if (!big) continue;
      const b = ruleFor(BIG_RULES, big.label || '', null);
      if (b && (b.wide || (dq === 0 && dr === 0))) { res = { source: big.label || big.id, kind: 'big_feature', bonus: b }; break; }
    }
  }
  if (!res) {
    for (const [dq, dr] of DIRS) {
      const n = featureAt(seed, q + dq, r + dr);
      if (!n || n.kind === 'wall' || n.kind === 'bridge') continue;
      const b = ruleFor(BUILDING_RULES, `${n.label || ''} ${n.desc || ''}`, null);
      if (b?.restNear) { res = { source: n.label || n.id, kind: 'building', bonus: { rest: b.rest, restNear: true } }; break; }
    }
  }
  if (_memo.size > 20000) _memo.clear();
  _memo.set(key, res);
  return res;
}
// A standing fortress on (q, r) (not yet broken — `gone` is the set of broken `bld:q,r` ids).
export function fortressAt(seed, q, r, gone = null) {
  const b = buildingBonusAt(seed, q, r);
  if (b?.kind !== 'building' || b.bonus.power?.kind !== 'fortress') return null;
  if (gone && gone.has(`bld:${q},${r}`)) return null;
  return { id: `bld:${q},${r}`, q, r, source: b.source, ...b.bonus.power };
}
// A dungeon on (q, r): { id, q, r, source } (explored or not — the caller reads `dng:q,r` edits).
export function dungeonAt(seed, q, r) {
  const b = buildingBonusAt(seed, q, r);
  return b?.kind === 'building' && b.bonus.dungeon ? { id: `dng:${q},${r}`, q, r, source: b.source } : null;
}
// Is the dungeon explored on `turn`, given the `dng:q,r` edit ({ explored: turn }) if any?
export const dungeonExplored = (edit, turn, rearm = DUNGEON_REARM_TURNS) => !!edit && Number.isInteger(edit.explored) && turn - edit.explored < rearm;
// A school (learn power) on (q, r): { id: 'lrn:q,r', q, r, source } — explored state in `lrn:q,r` edits.
export function schoolAt(seed, q, r) {
  const b = buildingBonusAt(seed, q, r);
  return b?.kind === 'building' && b.bonus.power?.kind === 'learn' ? { id: `lrn:${q},${r}`, q, r, source: b.source } : null;
}
// Where a teleport building sends a hero: up to 12 candidate hexes 8–14 away, in a fixed order per building;
// the resolver takes the first one that is free (no unit, wall or fortress).
export function teleportTargets(seed, q, r) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const d = 8 + Math.floor(roll(seed, q, r, `tpd${i}`) * 7);
    const [dq, dr] = DIRS[Math.floor(roll(seed, q, r, `tpa${i}`) * 6)];
    const [sq, sr] = DIRS[(DIRS.findIndex(x => x[0] === dq && x[1] === dr) + 2) % 6];
    const k = Math.floor(roll(seed, q, r, `tpk${i}`) * d);
    out.push({ q: q + dq * d + sq * k, r: r + dr * d + sr * k });
  }
  return out;
}
// The wall arc a walls building raises on turn `turn`: 5 connected hexes on the radius-5 ring around it,
// centred on a direction that turns with the turn number.
export function wallArc(seed, q, r, turn) {
  const R = 5;
  const ring = [];
  let cq = q + DIRS[4][0] * R, cr = r + DIRS[4][1] * R;
  for (let side = 0; side < 6; side++) for (let i = 0; i < R; i++) { ring.push({ q: cq, r: cr }); cq += DIRS[side][0]; cr += DIRS[side][1]; }
  const start = Math.floor(roll(seed, q, r, `arc${turn}`) * ring.length);
  return [-2, -1, 0, 1, 2].map(k => ring[(start + k + ring.length) % ring.length]);
}
// A place 20–28 hexes away an explore building shows on turn `turn`.
export function exploreTarget(seed, q, r, turn) {
  const d = 20 + Math.floor(roll(seed, q, r, `exd${turn}`) * 9);
  const a = Math.floor(roll(seed, q, r, `exa${turn}`) * 6);
  const [dq, dr] = DIRS[a], [sq, sr] = DIRS[(a + 2) % 6];
  const k = Math.floor(roll(seed, q, r, `exk${turn}`) * d);
  return { q: q + dq * d + sq * k, r: r + dr * d + sr * k };
}
// The catalogue arrived / changed (browser fetch, node injection): forget lookups made without it.
export function clearBuildingBonusMemo() { _memo.clear(); }
