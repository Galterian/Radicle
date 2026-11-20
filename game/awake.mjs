// Awake (effect_awake) — which nearby thing moves where (user request 2026-11-17: "clicking a tile while casting
// must move the nearby building / ally / me there; with no click, do it in the most beneficial position").
// Pure and deterministic in its arguments: peer.mjs builds the input from the resolution view on every peer and
// hands the plan to the effect as `cast.awake`; effects.mjs (and effects-data/effects/effect_awake.json) only
// turn the plan into a move (unit) or a relocation (building).
//
// Movers ("subjects"): me; a living ally in contact (≤ 1 hex); a movable building within 2 hexes of me (a world
// building or a placed one; never a fortress, tree, grove, wall). Destinations: hexes 1..10 from me — for a unit
// a walkable, empty hex with no trap / token on it; for a building a walkable hex with no feature, unit, obstacle
// or trap.
//
// The click (cast.target tile):
//   - on my own hex / an ally in contact / a movable building near me → that thing moves, to its best hex;
//   - on a legal destination → it is the destination; the subject is the one that gains most by going there;
//   - nothing clicked / an illegal hex → the best (subject, destination) pair overall.
// "Most beneficial" = the largest gain = value(new spot) − value(old spot):
//   unit (me / ally): +2 when it stands on a building (its bonus applies there), plus
//     healthy (life > half of max): −(hexes beyond contact with the nearest visible enemy) − (extra enemies in
//       contact beyond the first) → it goes to fight, next to one enemy;
//     hurt (life ≤ half of max): + hexes to the nearest visible enemy (capped at 10) → it goes to safety;
//     no visible enemy: only the building term.
//   building: +2 per friendly unit (me, allies) within 1 hex (they can stand on it at once), −2 per visible enemy
//     within 1 hex (they could take its bonus).
//   wall (an obstacle — Creation, a building's wall arc — or a labyrinth wall, within 2 of me; 2026-11-18): +3 per hurt
//     friend it shields (next to that friend, closer to the friend's nearest enemy than the friend is).
// Ties: shorter move, then me → ally → building → wall, then id, then (q, r).
import { discAround, hexDist } from './world-prims.mjs';   // class isolation phase 6 (was class-world.mjs)

export const AWAKE_CONFIG = { range: 10, allyNear: 1, buildingNear: 2, wallNear: 2, onBuilding: 2, perFriend: 2, perEnemy: 2, perShield: 3, safeCap: 10 };
const KIND_ORDER = { me: 0, ally: 1, building: 2, wall: 3 };
const isHex = (t) => !!t && Number.isInteger(t.q) && Number.isInteger(t.r);
const same = (a, b) => a.q === b.q && a.r === b.r;

/**
 * @param {object} p
 * @param {{id: string, q: number, r: number}} p.me
 * @param {Array<{id: string, q: number, r: number, life: number, lifeMax?: number, side: 'me'|'ally'|'enemy'}>} p.units
 *   living units with a known tile (enemies: only the ones the caster sees)
 * @param {Array<{q: number, r: number, label?: string}>} p.buildings movable buildings within `buildingNear` of me
 * @param {{q: number, r: number}|null} p.picked the clicked tile
 * @param {(q: number, r: number) => boolean} p.unitFree a unit may land there
 * @param {(q: number, r: number) => boolean} p.siteFree a building may stand there
 * @param {(q: number, r: number) => boolean} p.hasBuilding a building stands there (for the "stand on it" bonus)
 * @returns {{kind: 'unit'|'building', who?: string, label?: string, from: {q,r}, q: number, r: number, gain: number, how: string}
 *   | {kind: 'none', why: string}}
 */
export function awakePlan({ me, units = [], buildings = [], walls = [], picked = null, unitFree, siteFree, hasBuilding, cfg = AWAKE_CONFIG }) {
  if (!isHex(me)) return { kind: 'none', why: 'caster has no tile' };
  const enemies = units.filter(u => u.side === 'enemy' && isHex(u));
  const friends = units.filter(u => u.side !== 'enemy' && isHex(u));
  const unitValue = (u, t) => {
    let v = hasBuilding(t.q, t.r) ? cfg.onBuilding : 0;
    if (!enemies.length) return v;
    const ds = enemies.map(e => hexDist(t, e));
    const d = Math.min(...ds);
    const hurt = Number.isFinite(u.lifeMax) && u.lifeMax > 0 ? u.life * 2 <= u.lifeMax : u.life <= 1;
    if (hurt) return v + Math.min(d, cfg.safeCap);
    const inContact = ds.filter(x => x <= 1).length;
    return v - Math.max(0, d - 1) - Math.max(0, inContact - 1);
  };
  // A building is valued where it stands: friends within 1 (standing on it counts) minus enemies within 1.
  // The moved building's own old hex is no longer a building for that count — it is not used by the value.
  const buildingValue = (t) => cfg.perFriend * friends.filter(f => hexDist(t, f) <= 1).length - cfg.perEnemy * enemies.filter(e => hexDist(t, e) <= 1).length;

  // A wall (user ruling 2026-11-18: wall tokens are Awake targets too) is worth +3 for every HURT friend it shields:
  // it stands next to that friend on the side of the friend's nearest enemy (closer to that enemy than the friend).
  const hurtOf = (u) => Number.isFinite(u.lifeMax) && u.lifeMax > 0 ? u.life * 2 <= u.lifeMax : u.life <= 1;
  const shieldees = enemies.length ? friends.filter(hurtOf).map(f => { const e = [...enemies].sort((a, b) => hexDist(f, a) - hexDist(f, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]; return { f, e, d: hexDist(f, e) }; }) : [];
  const wallValue = (t) => cfg.perShield * shieldees.filter(x => hexDist(t, x.f) === 1 && hexDist(t, x.e) < x.d).length;
  const subjects = [];
  const meU = units.find(u => u.id === me.id) || { id: me.id, q: me.q, r: me.r, life: 1, side: 'me' };
  subjects.push({ kind: 'me', id: me.id, from: { q: me.q, r: me.r }, u: meU });
  for (const a of friends.filter(f => f.id !== me.id && hexDist(me, f) <= cfg.allyNear).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) subjects.push({ kind: 'ally', id: a.id, from: { q: a.q, r: a.r }, u: a });
  for (const b of buildings.filter(b => isHex(b) && hexDist(me, b) <= cfg.buildingNear).sort((x, y) => x.q - y.q || x.r - y.r)) subjects.push({ kind: 'building', id: `${b.q},${b.r}`, from: { q: b.q, r: b.r }, label: b.label || 'Building' });
  // walls: [{ q, r, label, lab: true (labyrinth wall, world edits) | owner + id (an obstacle: Creation, building wall arc) }]
  for (const w of walls.filter(w => isHex(w) && hexDist(me, w) <= cfg.wallNear).sort((x, y) => x.q - y.q || x.r - y.r)) subjects.push({ kind: 'wall', id: `${w.q},${w.r}`, from: { q: w.q, r: w.r }, label: w.label || (w.lab ? 'Impassable Wall' : 'obstacle'), w });

  const dests = discAround(me, cfg.range).filter(t => hexDist(me, t) >= 1);
  const legal = (s, t) => !same(s.from, t) && (s.kind === 'building' || s.kind === 'wall' ? siteFree(t.q, t.r) : unitFree(t.q, t.r));
  const gainOf = (s, t) => s.kind === 'building' ? buildingValue(t) - buildingValue(s.from) : s.kind === 'wall' ? wallValue(t) - wallValue(s.from) : unitValue(s.u, t) - unitValue(s.u, s.from);
  const better = (a, b) => {
    if (!b) return true;
    if (a.gain !== b.gain) return a.gain > b.gain;
    const da = hexDist(a.s.from, a.t), db = hexDist(b.s.from, b.t);
    if (da !== db) return da < db;
    if (KIND_ORDER[a.s.kind] !== KIND_ORDER[b.s.kind]) return KIND_ORDER[a.s.kind] < KIND_ORDER[b.s.kind];
    if (a.s.id !== b.s.id) return a.s.id < b.s.id;
    return a.t.q - b.t.q < 0 || (a.t.q === b.t.q && a.t.r < b.t.r);
  };
  const bestOf = (subs, ts) => {
    let best = null;
    for (const s of subs) for (const t of ts) { if (!legal(s, t)) continue; const c = { s, t, gain: gainOf(s, t) }; if (better(c, best)) best = c; }
    return best;
  };
  const wallReloc = (s, t) => s.w.lab
    ? { kind: 'wall', owner: 'world', id: `lab:${s.from.q},${s.from.r}`, label: s.label, by: me.id, from: { q: s.from.q, r: s.from.r }, q: t.q, r: t.r }
    : { kind: 'obstacle', owner: s.w.owner, id: s.w.id, label: s.label, by: me.id, q: t.q, r: t.r };
  const planOf = (c, how) => ({
    kind: c.s.kind === 'building' || c.s.kind === 'wall' ? c.s.kind : 'unit',
    ...(c.s.kind === 'building' || c.s.kind === 'wall' ? { label: c.s.label } : { who: c.s.id }),
    from: { q: c.s.from.q, r: c.s.from.r }, q: c.t.q, r: c.t.r, gain: c.gain, how,
    ...(c.s.kind === 'wall' ? { reloc: wallReloc(c.s, c.t) } : {}),
  });

  let pick = null, how = 'auto';
  if (isHex(picked)) {
    const chosen = subjects.find(s => same(s.from, picked));
    if (chosen) { pick = bestOf([chosen], dests); how = 'picked thing'; }
    else if (hexDist(me, picked) <= cfg.range) { pick = bestOf(subjects, [{ q: picked.q, r: picked.r }]); how = 'picked tile'; }
  }
  if (!pick) { pick = bestOf(subjects, dests); how = isHex(picked) ? 'auto (picked hex not usable)' : 'auto'; }
  if (!pick) return { kind: 'none', why: 'nothing near me can move to a free hex within 10' };
  return planOf(pick, how);
}
