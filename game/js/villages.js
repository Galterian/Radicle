// Named villages on the procedural map (chaosD6-GameModels, user request 2026-11-24). PURE function of
// (map seed, q, r) plus the GameModels catalog (assets/gamemodels/catalog.json — setVillageCatalog), so the
// resolver (node) and every browser agree hex for hex.
//
// Placement: the plane is cut into CELL×CELL axial cells; a cell holds at most one village whose centre lies in
// [INSET, CELL − INSET) of the cell on both axes, so two villages of different cells are ≥ CELL − 2·INSET = 100
// hexes apart (axial hex distance ≥ max(|dq|, |dr|)). The spawn cell is special: its village (always present)
// sits ORIGIN_MIN..ORIGIN_MAX hexes from (0, 0) so a new hero can find one; a neighbouring cell's village closer
// than MIN_APART to it is dropped. Each village: a race (hash pick among the village templates), a name from the
// race's prefix/suffix lists ("Silverleaf"), its team "<Name> Village", buildings at the template's offsets, and
// a cleared disc (no labyrinth walls / scenery) of `clear_radius` around the centre.
// Godot's Features.gd does not mirror this yet (the phone map is the WebView build of main.js).
import { hash32 } from './map.js';

export const VILLAGE_CELL = 200, VILLAGE_INSET = 50, MIN_APART = 100;
export const ORIGIN_MIN = 35, ORIGIN_MAX = 55, VILLAGE_RATE = 0.75, OUTPOST_RATE = 0.4;
// Layout 2 (user 2026-11-28: "make the villages twice smaller, and the distances between them cut by half"): NEW
// dimensions only — their map seed ends in LAYOUT_V2_MARK (js/map.js seedForNewDimension), so every peer and browser
// of a dimension, reading the same seed off its Door, agrees; an older dimension keeps its villages where they stood.
// Half the grid, half the villages (villageTemplate derives the half-size template from the catalog's), each
// village with 4 towers on its wall and 2 catapults + 1 ballista posted inside, each outpost with 1 tower + 1 ballista.
export const LAYOUT_V2_MARK = '~v2';
export const villageLayoutOf = (seed) => String(seed ?? '').endsWith(LAYOUT_V2_MARK) ? 2 : 1;
const GEOM = {
  1: { cell: VILLAGE_CELL, inset: VILLAGE_INSET, apart: MIN_APART, oMin: ORIGIN_MIN, oMax: ORIGIN_MAX },
  2: { cell: 100, inset: 25, apart: 50, oMin: 18, oMax: 28 },
};
export const villageGeometry = (seed) => GEOM[villageLayoutOf(seed)];
export const TOWER_HP = 4, TOWER_RANGE = 4;   // a wall tower: 4 HP, shoots the nearest enemy of its village within 4 once a turn
export const isOutpostTemplate = (t) => t?.size === 'outpost' || t?.size === 'hamlet';   // 'hamlet': the catalogs before the rename (2026-11-28)

let cat = null, catHash = '';
const listeners = new Set();
export function setVillageCatalog(j) {
  cat = j && typeof j === 'object' && j.villages ? j : null;
  catHash = cat?.hash || '';
  _cells.clear(); _hexes.clear(); _tpl.clear();
  for (const fn of listeners) { try { fn(); } catch {} }
  return !!cat;
}
export const villageCatalog = () => cat;
// Test-game knobs on a catalog object (node: peer.mjs, ui-server.mjs, join-plan.mjs — each process reads its env; the
// launcher serves the browser the same overridden catalog): GAMEMODELS_TEST_VILLAGE=<template id> → the spawn cell's
// village. The test NPC (GAMEMODELS_TEST_NPC) is spawned by the hero's peer (peer.mjs testNpcTick).
export function testCatalogOverrides(j, env = {}) {
  if (!j || typeof j !== 'object' || !env.GAMEMODELS_TEST_VILLAGE) return j;
  if (!j.villages?.[env.GAMEMODELS_TEST_VILLAGE]) { console.warn(`[gamemodels] GAMEMODELS_TEST_VILLAGE: no village template "${env.GAMEMODELS_TEST_VILLAGE}" in the catalog`); return j; }
  return { ...j, test_spawn_village: env.GAMEMODELS_TEST_VILLAGE };
}
// The catalog file a node process reads: GAMEMODELS_CATALOG_FILE (a test game's own compiled catalog, e.g. with
// draft definitions) before the usual places.
export function gameModelsCatalogTries(defaults, env = {}) { return [...(env.GAMEMODELS_CATALOG_FILE ? [env.GAMEMODELS_CATALOG_FILE] : []), ...defaults]; }
export const villageCatalogReady = () => !!cat;
export const onVillagesChanged = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
// Browser: fetch the catalog once (node calls setVillageCatalog with the file).
export function loadVillageCatalog(url = '/assets/gamemodels/catalog.json') {
  if (cat || typeof fetch !== 'function') return Promise.resolve(cat);
  return fetch(url).then(r => r.ok ? r.json() : null).then(j => { setVillageCatalog(j); return cat; }).catch(() => null);
}

const mix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16; return h >>> 0; };
const roll = (seed, salt) => mix(hash32(`${seed}:vil:${salt}`)) / 4294967296;
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
const floorDiv = (a, b) => Math.floor(a / b);
// A hex exactly `d` from (0, 0): side u1 ∈ [0,1) of the six, position u2 ∈ [0,1) along it.
const RING_CORNER = [[1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1]], RING_STEP = [[0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1], [1, 0]];
function ringPoint(d, u1, u2) {
  const side = Math.floor(u1 * 6) % 6, t = Math.floor(u2 * d);
  return { q: RING_CORNER[side][0] * d + RING_STEP[side][0] * t, r: RING_CORNER[side][1] * d + RING_STEP[side][1] * t };
}

const _cells = new Map();   // `${seed}|cx,cy` → village | null
const _hexes = new Map();   // `${seed}|vid` → Map("q,r" → { building, def })
const _tpl = new Map();     // template id → its layout-2 (half-size) template

// ---- the layout-2 template (2026-11-28) ----
const hexLen = ([q, r]) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
// The offset (q, r) moved along its own direction to exactly `d` hexes from the centre (cube rounding of the scaled
// vector: its largest component is ±d exactly, so the rounded hex is exactly d out).
function toDist([q, r], d) {
  const n = hexLen([q, r]);
  if (!n || d <= 0) return [0, 0];
  const x = q * d / n, z = r * d / n, y = -x - z;
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
  return [rx + 0, rz + 0];
}
const AXIAL_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
// The first free offset at `want`, else around it (rings 1, 2) no farther than `maxD` from the centre — so no two
// buildings of a halved layout share a hex.
function freeOffset(want, taken, maxD) {
  const key = (a) => `${a[0]},${a[1]}`;
  if (!taken.has(key(want)) && hexLen(want) <= maxD) return want;
  for (let k = 1; k <= 2; k++) for (const [dq, dr] of AXIAL_DIRS) { const c = [want[0] + dq * k, want[1] + dr * k]; if (!taken.has(key(c)) && hexLen(c) <= maxD) return c; }
  return want;
}
// Compass points of a ring of radius R as js/hex.js draws it (north = up): N (R/2, −R), E (R, 0), S (−R/2, R), W (−R, 0).
const COMPASS = [['north', [1, -2]], ['east', [1, 0]], ['south', [-1, 2]], ['west', [-1, 0]]];
const siegeNpcOf = (race, kind) => Object.keys(cat?.npcs || {}).sort().find(k => cat.npcs[k].race === race && cat.npcs[k].role === 'siege' && cat.npcs[k].siege?.kind === kind) || null;
const towerBuildingOf = (race) => Object.keys(cat?.buildings || {}).sort().find(k => cat.buildings[k].race === race && cat.buildings[k].role === 'tower') || null;
// The half-size template: the wall at half its radius (8 → 4), the buildings inside at half their distance, every
// resident at its post (gate guard right outside the gate, wall guards on the ring inside, the people outside just past
// the wall, the others at half distance), wanderers at half the ring; then the defences:
//   village — a tower on each of the north, east, south and west walls (ON the wall ring, the gate's hex excepted —
//             the tower moves one hex along), and behind three of them (never the wall with the gate) a siege engine
//             inside: 2 catapults and a ballista, real villagers (counted in the cap, which grows by 3)
//   outpost — no wall: one tower on its north edge and a ballista next to it inside
function halfTemplate(id, t) {
  const out = { ...t, layout_version: 2 };
  const outpost = isOutpostTemplate(t);
  const R1 = t.wall?.radius || 0, R2 = R1 ? Math.round(R1 / 2) : 0;
  const disc = Math.max(1, Math.round((t.radius || 2) / 2));
  out.radius = disc;
  out.clear_radius = R2 ? R2 + 1 : Math.round((t.clear_radius ?? t.radius + 3) / 2);
  const inMax = R2 ? R2 - 2 : disc;   // buildings: inside the wall's inner ring (kept for the guards and engines)
  const taken = new Set();
  out.layout = (t.layout || []).map(l => {
    const at = freeOffset(toDist(l.at, Math.ceil(hexLen(l.at) / 2)), taken, inMax);
    taken.add(`${at[0]},${at[1]}`);
    return { ...l, at };
  });
  if (t.wall && R2) out.wall = { ...t.wall, radius: R2, gate: toDist(t.wall.gate, R2) };
  out.residents = (t.residents || []).map(rs => {
    const n = hexLen(rs.at);
    const d = !R2 ? Math.min(disc, Math.ceil(n / 2))
      : rs.post === 'gate' ? R2 + 1 : rs.post === 'wall' ? R2 - 1 : rs.post === 'outside' ? Math.max(R2 + 1, n - R1 + R2) : Math.min(R2 - 1, Math.ceil(n / 2));
    return { ...rs, at: toDist(rs.at, d) };
  });
  if (t.wanderers?.ring) out.wanderers = { ...t.wanderers, ring: t.wanderers.ring.map(x => Math.ceil(x / 2)) };
  if (t.reputation?.threat_radius) out.reputation = { ...t.reputation, threat_radius: Math.round(t.reputation.threat_radius / 2) };
  const towerB = towerBuildingOf(t.race);
  const towers = [], engines = [];
  if (!outpost && out.wall) {
    const gate = out.wall.gate, ring = ringOffsets(R2);
    const gi = ring.findIndex(h => h[0] === gate[0] && h[1] === gate[1]);
    const near = COMPASS.map(([dir, v]) => ({ dir, at: toDist(v, R2) }))
      .map(x => ({ ...x, gd: hexLen([x.at[0] - gate[0], x.at[1] - gate[1]]) }));
    const gateWall = [...near].sort((a, b) => a.gd - b.gd)[0].dir;
    for (const x of near) {
      let at = x.at;
      if (at[0] === gate[0] && at[1] === gate[1]) at = ring[(gi + 1) % ring.length];   // the gate's own hex: one along
      towers.push({ dir: x.dir, at, building: towerB });
      if (x.dir !== gateWall) engines.push({ dir: x.dir, at: toDist(at, R2 - 1) });
    }
    const kinds = ['catapult', 'catapult', 'ballista'];
    engines.slice(0, 3).forEach((e, i) => { const npc = siegeNpcOf(t.race, kinds[i]); if (npc) out.residents.push({ npc, at: e.at, post: 'siege', dir: e.dir }); });
  } else if (outpost) {
    const at = toDist(COMPASS[0][1], disc);
    towers.push({ dir: 'north', at, building: towerB });
    const npc = siegeNpcOf(t.race, 'ballista');
    if (npc) out.residents.push({ npc, at: toDist(at, Math.max(1, disc - 1)), post: 'siege', dir: 'north' });
  }
  out.towers = towers.filter(x => x.building);
  out.cap = (t.cap || 0) + out.residents.filter(r => r.post === 'siege').length;
  return out;
}
// The hexes of the ring of radius R around (0, 0) in walking order (offsets), starting at the south-west corner —
// the order villageWallRing walks.
function ringOffsets(R) {
  const out = [];
  let q = RING_DIRS[4][0] * R, r = RING_DIRS[4][1] * R;
  for (let i = 0; i < 6; i++) for (let j = 0; j < R; j++) { out.push([q, r]); q += RING_DIRS[i][0]; r += RING_DIRS[i][1]; }
  return out;
}
// The template a village of a dimension uses: the catalog's (layout 1) or its half-size form (layout 2).
export function templateOf(templateId, layout = 1) {
  const t = cat?.villages?.[templateId];
  if (!t || layout !== 2) return t || null;
  let h = _tpl.get(templateId);
  if (!h) { h = halfTemplate(templateId, t); _tpl.set(templateId, h); }
  return h;
}
export const villageTemplate = (v) => templateOf(v?.template, v?.layout || 1);
// The candidate centre of a cell before the spawn-cell spacing rule.
function rawVillage(seed, cx, cy) {
  if (!cat) return null;
  // full villages only (the pick stays what it was before outposts existed); an outpost replaces one of its race below
  const templates = Object.keys(cat.villages).filter(t => !cat.villages[t].size).sort();
  if (!templates.length) return null;
  const G = villageGeometry(seed), layout = villageLayoutOf(seed);
  let q, r;
  if (cx === 0 && cy === 0) {
    const d = G.oMin + Math.floor(roll(seed, 'od') * (G.oMax - G.oMin + 1));
    ({ q, r } = ringPoint(d, roll(seed, 'oa'), roll(seed, 'ot')));
  } else {
    if (roll(seed, `p:${cx},${cy}`) >= VILLAGE_RATE) return null;
    const span = G.cell - 2 * G.inset;
    q = cx * G.cell + G.inset + Math.floor(roll(seed, `q:${cx},${cy}`) * span);
    r = cy * G.cell + G.inset + Math.floor(roll(seed, `r:${cx},${cy}`) * span);
  }
  let template = templates[Math.floor(roll(seed, `t:${cx},${cy}`) * templates.length)];
  // Smaller villages (user 2026-11-24; "rename the hamlet to outpost" 2026-11-28): OUTPOST_RATE of the cells away
  // from the spawn hold an outpost of the same race — no wall, three buildings, a handful of people (a quest giver, a
  // storyteller, a builder for hire, a trader).
  if ((cx || cy) && roll(seed, `h:${cx},${cy}`) < OUTPOST_RATE) {
    const race0 = cat.villages[template].race;
    const h = Object.keys(cat.villages).sort().find(t => isOutpostTemplate(cat.villages[t]) && cat.villages[t].race === race0);
    if (h) template = h;
  }
  // Test games (GAMEMODELS_TEST_VILLAGE, set into the catalog by testCatalogOverrides): the spawn cell's village is
  // that template — in the catalog, so the browser and every peer pick the same one.
  if (cx === 0 && cy === 0 && cat.test_spawn_village && cat.villages[cat.test_spawn_village]) template = cat.test_spawn_village;
  const v = templateOf(template, layout), race = cat.races[v.race];
  const np = race?.village_names || { prefix: ['New'], suffix: ['town'] };
  const name = np.prefix[Math.floor(roll(seed, `n1:${cx},${cy}`) * np.prefix.length)] + np.suffix[Math.floor(roll(seed, `n2:${cx},${cy}`) * np.suffix.length)];
  return {
    id: `vil:${cx},${cy}`, cell: [cx, cy], q, r, template, race: v.race, race_name: race?.name || v.race, name,
    team: String(v.team || '{name} Village').replace('{name}', name).replace(/ Hamlet$/, ' Outpost'),
    alliance: `village_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${cx}_${cy}`.replace(/-/g, 'm'),
    radius: v.radius, clear_radius: v.clear_radius ?? v.radius + 3, cap: v.cap, reputation: v.reputation,
    wall: wallOf(v.wall, q, r),
    ...(layout === 2 ? { layout, towers: (v.towers || []).map(tw => ({ q: q + tw.at[0], r: r + tw.at[1], dir: tw.dir, building: tw.building })) } : {}),
  };
}
// The wall ring (user 2026-11-24: "an unpassable wall around the village with one guard in front of its gate"):
// every hex at `radius` from the centre but the gate, a corner hex of that ring (on one of the six axes), so its
// one inner neighbour (`inner`) and the hex straight out (`outer`, the gate guard's post) are axis hexes too.
function wallOf(w, q, r) {
  if (!w || !(w.radius > 0) || !Array.isArray(w.gate)) return null;
  const R = w.radius, dq = w.gate[0] / R, dr = w.gate[1] / R;
  return { radius: R, gate: { q: q + w.gate[0], r: r + w.gate[1] }, inner: { q: q + dq * (R - 1), r: r + dr * (R - 1) }, outer: { q: q + dq * (R + 1), r: r + dr * (R + 1) } };
}
// The village of a cell (or null).
export function villageOfCell(seed, cx, cy) {
  const k = `${seed}|${cx},${cy}`;
  if (_cells.has(k)) return _cells.get(k);
  let v = rawVillage(seed, cx, cy);
  if (v && !(cx === 0 && cy === 0) && Math.abs(cx) <= 1 && Math.abs(cy) <= 1) {
    const o = rawVillage(seed, 0, 0);
    if (o && dist(o, v) < villageGeometry(seed).apart) v = null;
  }
  if (_cells.size > 4096) _cells.clear();
  _cells.set(k, v);
  return v;
}
// Villages whose centre is within `radius` of (q, r), nearest first.
export function villagesNear(seed, q, r, radius = 150) {
  const out = [], G = villageGeometry(seed);
  const c0 = floorDiv(q - radius, G.cell), c1 = floorDiv(q + radius, G.cell);
  const d0 = floorDiv(r - radius, G.cell), d1 = floorDiv(r + radius, G.cell);
  const seen = new Set();
  const consider = (v) => { if (v && !seen.has(v.id)) { seen.add(v.id); const d = dist(v, { q, r }); if (d <= radius) out.push({ ...v, dist: d }); } };
  for (let cx = c0; cx <= c1; cx++) for (let cy = d0; cy <= d1; cy++) consider(villageOfCell(seed, cx, cy));
  if (dist({ q, r }, { q: 0, r: 0 }) <= radius + G.oMax) consider(villageOfCell(seed, 0, 0));
  return out.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
}
export const nearestVillage = (seed, q, r, radius = 400) => villagesNear(seed, q, r, radius)[0] || null;
// The village whose cleared disc holds (q, r), or null. Only the hex's own cell and the spawn village can.
export function villageAround(seed, q, r) {
  const G = villageGeometry(seed);
  const cands = [villageOfCell(seed, floorDiv(q, G.cell), floorDiv(r, G.cell))];
  if (Math.abs(q) <= G.oMax + 20 && Math.abs(r) <= G.oMax + 20) cands.push(villageOfCell(seed, 0, 0));
  for (const v of cands) if (v && dist(v, { q, r }) <= v.clear_radius) return v;
  return null;
}
function hexesOf(seed, v) {
  const k = `${seed}|${v.id}`;
  let m = _hexes.get(k);
  if (m) return m;
  m = new Map();
  const t = villageTemplate(v);
  for (const l of t.layout || []) {
    const def = cat.buildings[l.building];
    if (def) m.set(`${v.q + l.at[0]},${v.r + l.at[1]}`, { building: l.building, def, at: l.at });
  }
  const w = t.wall;
  if (v.wall && w) {
    const R = v.wall.radius;
    for (let dq = -R; dq <= R; dq++) for (let dr = Math.max(-R, -dq - R); dr <= Math.min(R, -dq + R); dr++) {
      const a = [Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)];
      if (Math.max(...a) !== R || (dq === w.gate[0] && dr === w.gate[1])) continue;
      // sprite by the ring's shape on screen: corners → joint, the two flat sides (|dr| = R) → horizontal, else vertical
      const shape = a.filter(x => x === R).length > 1 ? 'joint' : Math.abs(dr) === R ? 'horizontal' : 'vertical';
      m.set(`${v.q + dq},${v.r + dr}`, { wall: true, path: w.sprites?.[shape] || w.sprites?.joint || '' });
    }
  }
  // Layout-2 towers (2026-11-28): on the wall ring (a wall hex that is a tower — impassable like the wall, broken
  // the same way), or on an outpost's edge (no wall: the tower alone blocks its hex).
  for (const tw of v.towers || []) {
    const def = cat.buildings[tw.building];
    m.set(`${tw.q},${tw.r}`, { wall: true, tower: true, building: tw.building, def, dir: tw.dir, path: def?.sprites?.base || w?.sprites?.joint || '' });
  }
  if (_hexes.size > 256) _hexes.clear();
  _hexes.set(k, m);
  return m;
}
// What the village puts on (q, r): { village, building, def } for a building hex, { village, clear: true } inside
// the cleared disc, null outside every village.
export function villageHexAt(seed, q, r) {
  if (!cat) return null;
  const v = villageAround(seed, q, r);
  if (!v) return null;
  const b = hexesOf(seed, v).get(`${q},${r}`);
  if (b?.tower) return { village: v, wall: true, tower: true, path: b.path, building: b.building, def: b.def, dir: b.dir };
  if (b?.wall) return { village: v, wall: true, path: b.path };
  return b ? { village: v, building: b.building, def: b.def, at: b.at } : { village: v, clear: true };
}
export const isVillageWallAt = (seed, q, r) => !!villageHexAt(seed, q, r)?.wall;
// The wall ring of a village in walking order (6R hexes, the gate included, flagged), and its sprites — the renderer
// draws the wall as one continuous run along it instead of a sprite per hex.
const RING_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export function villageWallRing(v) {
  const w = v?.wall, t = villageTemplate(v)?.wall;
  if (!w || !t) return null;
  const R = w.radius, out = [];
  const towerAt = new Set((v.towers || []).map(tw => `${tw.q},${tw.r}`));   // layout 2: a tower stands in the run
  let q = v.q + RING_DIRS[4][0] * R, r = v.r + RING_DIRS[4][1] * R;
  for (let i = 0; i < 6; i++) for (let j = 0; j < R; j++) {
    out.push({ q, r, corner: j === 0, gate: q === w.gate.q && r === w.gate.r, ...(towerAt.has(`${q},${r}`) ? { tower: true } : {}) });
    q += RING_DIRS[i][0]; r += RING_DIRS[i][1];
  }
  return { hexes: out, sprites: t.sprites || {} };
}
// The wall sprites of a race (its full village's wall — an outpost has none of its own): { joint, horizontal, vertical }
// or null. The renderer dresses an NPC builder's Barricade ring in them (2026-11-27).
export function raceWallSprites(race) {
  if (!cat || !race) return null;
  const t = Object.keys(cat.villages).sort().find(k => cat.villages[k].race === race && cat.villages[k].wall?.sprites?.joint);
  return t ? cat.villages[t].wall.sprites : null;
}
// The team colour of a village id ("vil:cx,cy") — each village its own (user 2026-11-24): a hash-picked hue that is
// never green (your allies) nor red (the monsters), nor the players' light blue; saturated so it reads apart from the
// pastel alliance colours. The renderer tints the village's units, walls and buildings with it (WBC3 player ramp).
const HUE_BANDS = [[22, 68], [205, 330]];   // orange…yellow, blue…violet…magenta
export function villageColour(seed, vid) {
  if (!/^vil:-?\d+,-?\d+$/.test(String(vid || ''))) return null;
  const span = HUE_BANDS.reduce((a, [lo, hi]) => a + hi - lo, 0);
  let x = roll(seed, `col:${vid}`) * span, hue = HUE_BANDS[0][0];
  for (const [lo, hi] of HUE_BANDS) { if (x < hi - lo) { hue = lo + x; break; } x -= hi - lo; }
  return hslHex(hue, 0.72, 0.5);
}
function hslHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
}
export const ALLY_GREEN = '#6ad99f';   // = renderer ALLIANCE_COLOR.npc_a: a village that counts you an ally wears it
// The impassable wall feature of a wall hex (features.js labyrinthWallAt answers it, so every blocking rule holds).
export function villageWallFeature(seed, q, r, h = villageHexAt(seed, q, r)) {
  if (!h?.wall) return null;
  const w = villageTemplate(h.village)?.wall || {};
  const vil = { id: h.village.id, name: h.village.name, team: h.village.team, race: h.village.race, race_name: h.village.race_name, wall: true };
  // a tower (layout 2): blocks like the wall, shoots at the village's enemies, falls to TOWER_HP hits or a ram
  if (h.tower) return { path: h.path, label: `${h.village.name} ${h.def?.name || 'Tower'}`, kind: 'wall', biome: '', blocking: true, id: `village_wall/${h.village.id}:${q},${r}`,
    desc: `${h.def?.text || 'A tower of the village.'} It shoots a stone at the nearest enemy of ${h.village.team} within ${TOWER_RANGE} hexes once a turn. ${TOWER_HP} HP — Attacks and siege shots wear it down; a ram next to it for 3 actions breaks it.`,
    tower: { hp: TOWER_HP, range: TOWER_RANGE, dir: h.dir }, village: { ...vil, tower: true } };
  return { path: h.path, label: `${h.village.name} ${w.name || 'Wall'}`, kind: 'wall', biome: '', blocking: true, id: `village_wall/${h.village.id}:${q},${r}`,
    desc: w.text || 'The village wall: no way in but the gate.', village: vil };
}
// The feature object features.js featureAt() answers for a village building hex.
export function villageFeatureAt(seed, q, r) {
  const h = villageHexAt(seed, q, r);
  if (!h) return null;
  if (h.clear) return { clear: true, village: h.village };
  if (h.wall) return villageWallFeature(seed, q, r, h);
  const d = h.def;
  return {
    path: d.sprites?.base || '', label: `${h.village.name} ${d.name}`, kind: 'building', biome: '', id: `vbld:${q},${r}`,
    desc: d.text || '', theme: 'fortress', bank: { ...d.bank }, blocking: false,
    village: { id: h.village.id, name: h.village.name, team: h.village.team, race: h.village.race, race_name: h.village.race_name, building: h.building, role: d.role, produces: d.produces || null },
  };
}
// The village's residents ({ npc, q, r, name }) and wanderer spots (50–100 hexes out) — deterministic; the
// spawner (peer.mjs) still looks for the nearest walkable free hex.
export function villageResidents(seed, v) {
  const t = villageTemplate(v);
  if (!t) return [];
  return (t.residents || []).map((rs, i) => ({ npc: rs.npc, q: v.q + rs.at[0], r: v.r + rs.at[1], ...(rs.post ? { post: rs.post } : {}), label: `${v.id.replace(/[^a-z0-9]+/gi, '_')}_r${i}`, name: personName(seed, v, `r${i}`, rs.npc, i) }));
}
export function villageWanderers(seed, v) {
  const t = villageTemplate(v);
  if (!t?.wanderers) return [];
  const [lo, hi] = t.wanderers.ring;
  return (t.wanderers.npcs || []).map((npc, i) => {
    const d = lo + Math.floor(roll(seed, `wd:${v.id}:${i}`) * (hi - lo + 1));
    const { q, r } = ringPoint(d, roll(seed, `wa:${v.id}:${i}`), roll(seed, `wt:${v.id}:${i}`));
    return { npc, q: v.q + q, r: v.r + r, label: `${v.id.replace(/[^a-z0-9]+/gi, '_')}_w${i}`, name: personName(seed, v, `w${i}`, npc, (t.residents || []).length + i) };
  });
}
// "Aelindra, Elder of Silverleaf"
// With `idx` the names are dealt from a seeded shuffle of the race's list, so no two villagers share one until the
// list runs out (residents 0.., then the wanderers after them).
export function personName(seed, v, salt, npc, idx) {
  const names = cat?.races?.[v.race]?.person_names || ['Someone'];
  let who;
  if (Number.isInteger(idx)) {
    const deck = names.map((n, i) => [roll(seed, `pn:${v.id}:deck:${i}`), n]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    who = deck[idx % deck.length];
  } else who = names[Math.floor(roll(seed, `pn:${v.id}:${salt}`) * names.length)];
  return `${who}, ${cat?.npcs?.[npc]?.name || 'Villager'} of ${v.name}`;
}
// Compass word for the direction from a to b (flat-top axial → screen), for storytellers.
// As the map shows it (js/hex.js hexToPixel: x = √3·(q + r/2), y = 1.5·r·H_SQUASH, north = up).
export function compass(a, b) {
  const dq = b.q - a.q, dr = b.r - a.r;
  const x = Math.sqrt(3) * (dq + dr / 2), y = 1.5 * 0.72 * dr;
  if (!x && !y) return 'here';
  const deg = (Math.atan2(-y, x) * 180 / Math.PI + 360) % 360;
  return ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'][Math.round(deg / 45) % 8];
}
export const villageCatalogHash = () => catHash;
// 'vil:cx,cy' → that village (or null).
export function villageById(seed, id) {
  const m = /^vil:(-?\d+),(-?\d+)$/.exec(String(id || ''));
  return m ? villageOfCell(seed, Number(m[1]), Number(m[2])) : null;
}
// A hero's reputation with a village, from the world-edit ledger (world-ledger.js ledgerUnits shape:
// [{ peer_id: author, world_edits_json }]): start + every quest the hero completed there (its own `vq:<quest>` edit
// { v, d }) + `building_broken` per building of the village the hero broke (its `bld:q,r` gone edit)
// + `villager_killed` per villager it killed (its `vkill:<label>` edit { v }). Pure: every peer and browser agree.
// A hero's relationship with a village, in percent (user 2026-11-24), from the world-edit ledger:
//   start 50 % — start_same_race 70 % when the hero's character art is of the village's race (heroRace = its WBC3 race)
//   + each quest done (`vq:` d, +5)   − each villager the hero hurt (`vhit:<label>`, once per unit, −5)
//   − each building of the village it broke (`bld:q,r` gone, −5), each wall hex its siege ram broke (`vwall:q,r`, −5)
//   − each time it walked inside the wall below `enter`
//   (`ventry:`, −5); clamped to 0..100. Under `hostile` (40) the village attacks it in its threat area; at `enter`
//   (70) the gate opens; at `ally_all` (90) every villager fights at its side.
export const sameRace = (v, heroRace) => {
  const r = cat?.races?.[v?.race];
  return !!heroRace && !!r && String(heroRace).toLowerCase() === String(r.wbc3_race || r.name || '').toLowerCase();
};
export function villageRep(seed, v, heroId, ledger, heroRace = '') {
  const rp = v?.reputation || {};
  let rep = sameRace(v, heroRace) && rp.start_same_race != null ? rp.start_same_race : rp.start ?? 50;
  const mine = (ledger || []).find(u => u.peer_id === heroId);
  let edits = []; try { edits = JSON.parse(mine?.world_edits_json || '[]'); } catch {}
  for (const e of Array.isArray(edits) ? edits : []) {
    if (!e || typeof e.id !== 'string') continue;
    if (e.id.startsWith('vq:') && e.v === v.id) rep += Number(e.d) || 0;
    else if (e.id.startsWith('vhit:') && e.v === v.id) rep += rp.villager_attacked ?? -5;
    else if (e.id.startsWith('ventry:') && e.v === v.id) rep += rp.trespass ?? -5;
    else if (e.id.startsWith('vwall:') && e.v === v.id) rep += rp.building_broken ?? -5;   // my siege ram broke a wall hex (2026-11-25)
    else if (e.id.startsWith('vdip:') && (e.v === v.id || e.v2 === v.id)) rep += Number(e.d) || 0;   // I led its diplomat there / theirs here
    else if (e.id.startsWith('vspy:') && e.v === v.id) rep += DIPLOMACY_STEP;   // I led its diplomat to spy (2026-11-25): the client thanks me, the target never knows
    else if (e.id.startsWith('vhome:') && e.v === v.id) rep += Number(e.d) || 0;   // I walked one of its wanderers home
    else if (e.gone) { const m = /^bld:(-?\d+),(-?\d+)$/.exec(e.id); if (m && villageHexAt(seed, Number(m[1]), Number(m[2]))?.village?.id === v.id) rep += rp.building_broken ?? -5; }
  }
  return Math.max(0, Math.min(100, rep));
}
// The quests a hero has done in a village (ids), from its own `vq:` edits.
export function questsDone(ledger, heroId) {
  const mine = (ledger || []).find(u => u.peer_id === heroId);
  let edits = []; try { edits = JSON.parse(mine?.world_edits_json || '[]'); } catch {}
  return new Map((Array.isArray(edits) ? edits : []).filter(e => typeof e?.id === 'string' && e.id.startsWith('vq:')).map(e => [e.id.slice(3), e]));
}
// ---- between villages (user 2026-11-25) ----
// Each race has an alignment, in percent of good (race.alignment_pct: High Elves 100 … Undead 0). Two villages start
// at 100 − 2·|difference| (the closer the alignment, the better they get on; same race 100) and each diplomat a hero
// led from one to the other adds +5 (`vdip:<vid a>|<vid b>` in that hero's world edits, the pair sorted — once per
// hero and pair); clamped 0..100. Under WAR_BELOW (40) the two are at war: their people fight when they meet.
export const WAR_BELOW = 40, DIPLOMACY_STEP = 5;
export const raceAlignment = (race) => { const a = Number(cat?.races?.[race]?.alignment_pct); return Number.isFinite(a) ? a : 50; };
export const pairKey = (a, b) => [String(a), String(b)].sort().join('|');
// pair key → Σd of every hero's escort (+5, `vdip:`) and spy mission (−5, `vspy:<pair>#<n>`, the diplomat's sabotage
// paid for — user 2026-11-25), from the ledger shape villageRep reads
export function diplomacyLedger(ledger) {
  const out = new Map();
  for (const u of ledger || []) {
    let edits = []; try { edits = JSON.parse(u?.world_edits_json || '[]'); } catch {}
    for (const e of Array.isArray(edits) ? edits : []) if (typeof e?.id === 'string' && /^v(dip|spy):/.test(e.id) && e.v && e.v2) { const k = pairKey(e.v, e.v2); out.set(k, (out.get(k) || 0) + (Number(e.d) || 0)); }
  }
  return out;
}
// ---- a hero's alignment (user 2026-11-25: "Each Character should have alignment … attacking a not hostile creature
// will drop your alignment with 5%. Helping NPC may rise your alignment with 5%. NPCs has its village alignment.
// Monsters have no alignment") in percent of good: its race's alignment_pct (the race whose wbc3_race / name is the
// character art's race; 50 for none) + Σ its `valign:<why>:<key>` { d } edits (±ALIGN_STEP), clamped 0..100.
// A wanderer whose village's alignment lies more than ALIGN_HOSTILE_GAP away from a hero's is hostile to that hero.
export const ALIGN_STEP = 5, ALIGN_HOSTILE_GAP = 30;
export const raceOfHero = (heroRace) => Object.keys(cat?.races || {}).find(id => !!heroRace && String(heroRace).toLowerCase() === String(cat.races[id].wbc3_race || cat.races[id].name || '').toLowerCase()) || null;
export function heroAlignment(ledger, heroId, heroRace = '') {
  const race = raceOfHero(heroRace);
  let a = race ? raceAlignment(race) : 50;
  const mine = (ledger || []).find(u => u.peer_id === heroId);
  let edits = []; try { edits = JSON.parse(mine?.world_edits_json || '[]'); } catch {}
  for (const e of Array.isArray(edits) ? edits : []) if (typeof e?.id === 'string' && e.id.startsWith('valign:')) a += Number(e.d) || 0;
  return Math.max(0, Math.min(100, a));
}
export const alignmentWords = (pct) => pct >= 80 ? 'good' : pct >= 60 ? 'decent' : pct >= 40 ? 'neutral' : pct >= 20 ? 'wicked' : 'evil';
export function villageRelation(a, b, dip = new Map()) {
  if (!a || !b) return 100;
  if (a.id === b.id) return 100;
  const base = 100 - 2 * Math.abs(raceAlignment(a.race) - raceAlignment(b.race));
  return Math.max(0, Math.min(100, Math.round(base + (dip.get(pairKey(a.id, b.id)) || 0))));
}
export const atWar = (a, b, dip) => !!a && !!b && a.id !== b.id && villageRelation(a, b, dip) < WAR_BELOW;
// The other villages a village knows (found by some hero: `vfound:` edits), nearest first, with the relation.
export function villageRelations(seed, v, ledger) {
  const dip = diplomacyLedger(ledger), seen = new Set();
  for (const u of ledger || []) { let edits = []; try { edits = JSON.parse(u?.world_edits_json || '[]'); } catch {} for (const e of Array.isArray(edits) ? edits : []) if (typeof e?.id === 'string' && e.id.startsWith('vfound:')) seen.add(e.id.slice(7)); }
  const out = [];
  for (const id of seen) { const o = villageById(seed, id); if (o && o.id !== v.id) { const rel = villageRelation(v, o, dip); out.push({ village: o, relation: rel, war: rel < WAR_BELOW, dist: dist(v, o) }); } }
  return out.sort((x, y) => x.dist - y.dist || (x.village.id < y.village.id ? -1 : 1));
}
// Repairs (the village mason, 2026-11-25): `vfix:q,r` { q, r, at } puts a broken village building back — a `bld:q,r`
// gone edit counts only when no repair of that hex is as late. → the Set of 'q,r' still broken.
export function brokenHexes(edits) {
  const gone = new Map(), fixed = new Map();
  for (const e of edits || []) {
    if (typeof e?.id !== 'string') continue;
    let m = /^bld:(-?\d+),(-?\d+)$/.exec(e.id);
    if (m && e.gone) { const k = `${m[1]},${m[2]}`; gone.set(k, Math.max(gone.get(k) ?? -Infinity, e.at ?? 0)); continue; }
    m = /^vfix:(-?\d+),(-?\d+)/.exec(e.id);
    if (m) { const k = `${m[1]},${m[2]}`; fixed.set(k, Math.max(fixed.get(k) ?? -Infinity, e.at ?? 0)); }
  }
  return new Set([...gone].filter(([k, at]) => !(fixed.get(k) >= at)).map(([k]) => k));
}
export const standingOf = (rep, rp) => rep < rp.hostile ? 'hostile' : rep >= rp.ally_all ? 'ally' : rep >= rp.enter ? 'welcome' : 'stranger';
