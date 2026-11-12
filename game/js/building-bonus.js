// Map buildings and big landmarks give a standing bonus (user ruling
// 2026-11-12): a unit gets it while it stands there — nothing is consumed, the
// building stays. PURE (seed, q, r) → bonus, shared by the resolver (peer.mjs)
// and the browser (object card), so every peer reads the same bonus off the
// same hex. The kind of bonus comes from the building's own catalogue text
// (assets/features/feature_table.json `label` / `desc`), so "Resting here
// restores 1 life" now does exactly that.
//
// Bonus fields (all optional):
//   rest:  n  heal n life (or 'all') at the end of an action spent resting here —
//             Empty Posture, no skill / effect / bonus round, no damage taken —
//             at most once per turn (paper "per quiet round")
//   restNear: true  the rest heal also works on the 6 hexes around it
//   guard: n  the first n points of combat damage taken each action are ignored
//   cover: n  a Block played here takes n less combat damage
//   sword: n  an Attack made from here that scores deals n more
//   sanctuary: true  no combat damage lands on whoever stands here
//   stat: { vitality|world|matter|will: n }  added to that stat while here
//   sight: n  this unit sees n hexes around it (UI fog only)
import { featureAt } from './features.js';
import { bigFeatureAt } from './bigfeature.js';

const DIRS = [[+1, 0], [+1, -1], [0, -1], [-1, 0], [-1, +1], [0, +1]];

// First match wins; tested against `${label} ${desc}`.
const BUILDING_RULES = [
  [/restores all lost life/i,                                   { rest: 'all' }],
  [/healing orb|resting adjacent heal|ending its turn adjacent heals/i, { rest: 1, restNear: true }],
  [/rest\w*[^.]*restores? 2 life|restore 2 life/i,              { rest: 2 }],
  [/rest\w*[^.]*restores? 1 life|restores 1 life/i,             { rest: 1 }],
  [/sanctuary/i,                                                { sanctuary: true }],
  [/ignore the first hit|cannot be pushed|cannot be ambushed/i, { guard: 1 }],
  [/\+1 block|\+1 to the next block|ramparts|cover:/i,          { cover: 1 }],
  [/\+1 (to the next )?attack|winning a fight|fire resistance|first visitor fights/i, { sword: 1 }],
  [/watch tower|reveals? (8 hexes|the map)|sees the whole/i,    { sight: 8, stat: { world: 2 } }],
  [/mine|quarry|foundry|furnace/i,                              { stat: { matter: 2 } }],
  [/library|guild|school|refreshes|skill/i,                     { stat: { will: 2 } }],
  [/temple|portal|ring|henge|obelisk|shrine|altar|grove|pool/i, { stat: { world: 2 } }],
  [/barn|depot|shop|trad|smith|alchemist|hut|camp|relic|tomb|barrow/i, { stat: { vitality: 2 } }],
];
const HARMFUL = /lose 1 life|costs 1 life|haunted|plague|pit\b/i;
const DEFAULT_BUILDING = { stat: { will: 1 } };

// Big landmarks: ruins, mines, rock piles and wrecks span their anchor hex and
// the six around it (`wide`); a tree or log gives its cover on its own hex only
// (forests are everywhere — cover on every hex near one would be no bonus at all).
const BIG_RULES = [
  [/temple|colonnade|ruin/i,           { rest: 1, stat: { world: 1 }, wide: true }],
  [/mine/i,                            { stat: { matter: 2 }, wide: true }],
  [/boulder|rock/i,                    { guard: 1, wide: true }],
  [/shipwreck/i,                       { stat: { vitality: 2 }, wide: true }],
  [/log/i,                             { cover: 1, stat: { vitality: 1 } }],
  [/tree|palm|pine/i,                  { cover: 1 }],
];

function ruleFor(rules, text, fallback) {
  for (const [re, b] of rules) if (re.test(text)) return b;
  return fallback;
}

// One line a player reads on the object card / log.
export function bonusText(b) {
  if (!b) return '';
  const out = [];
  if (b.rest) out.push(`rest here (Empty Posture, unhurt): ${b.rest === 'all' ? 'all lost life' : `+${b.rest} life`} once per turn${b.restNear ? ' — also on the hexes around it' : ''}`);
  if (b.sanctuary) out.push('no combat damage lands on you here');
  if (b.guard) out.push(`ignore the first ${b.guard} combat damage each action`);
  if (b.cover) out.push(`Block here: ${b.cover} less damage`);
  if (b.sword) out.push(`Attack from here: +${b.sword} damage`);
  for (const [k, v] of Object.entries(b.stat || {})) out.push(`+${v} ${k[0].toUpperCase()}${k.slice(1)}`);
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
  if (f && f.kind !== 'wall' && f.kind !== 'bridge') {
    const text = `${f.label || ''} ${f.desc || ''}`;
    if (!HARMFUL.test(text)) res = { source: f.label || f.id, kind: 'building', bonus: ruleFor(BUILDING_RULES, text, DEFAULT_BUILDING) };
  }
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
// The catalogue arrived / changed (browser fetch, node injection): forget lookups made without it.
export function clearBuildingBonusMemo() { _memo.clear(); }
