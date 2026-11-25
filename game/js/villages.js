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
export const ORIGIN_MIN = 35, ORIGIN_MAX = 55, VILLAGE_RATE = 0.75, HAMLET_RATE = 0.4;

let cat = null, catHash = '';
const listeners = new Set();
export function setVillageCatalog(j) {
  cat = j && typeof j === 'object' && j.villages ? j : null;
  catHash = cat?.hash || '';
  _cells.clear(); _hexes.clear();
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
// The candidate centre of a cell before the spawn-cell spacing rule.
function rawVillage(seed, cx, cy) {
  if (!cat) return null;
  // full villages only (the pick stays what it was before hamlets existed); a hamlet replaces one of its race below
  const templates = Object.keys(cat.villages).filter(t => !cat.villages[t].size).sort();
  if (!templates.length) return null;
  let q, r;
  if (cx === 0 && cy === 0) {
    const d = ORIGIN_MIN + Math.floor(roll(seed, 'od') * (ORIGIN_MAX - ORIGIN_MIN + 1));
    ({ q, r } = ringPoint(d, roll(seed, 'oa'), roll(seed, 'ot')));
  } else {
    if (roll(seed, `p:${cx},${cy}`) >= VILLAGE_RATE) return null;
    const span = VILLAGE_CELL - 2 * VILLAGE_INSET;
    q = cx * VILLAGE_CELL + VILLAGE_INSET + Math.floor(roll(seed, `q:${cx},${cy}`) * span);
    r = cy * VILLAGE_CELL + VILLAGE_INSET + Math.floor(roll(seed, `r:${cx},${cy}`) * span);
  }
  let template = templates[Math.floor(roll(seed, `t:${cx},${cy}`) * templates.length)];
  // Smaller villages (user 2026-11-24): HAMLET_RATE of the cells away from the spawn hold a hamlet of the same race —
  // no wall, three buildings, a handful of people (a quest giver, a storyteller, a builder for hire, a trader).
  if ((cx || cy) && roll(seed, `h:${cx},${cy}`) < HAMLET_RATE) {
    const race0 = cat.villages[template].race;
    const h = Object.keys(cat.villages).sort().find(t => cat.villages[t].size === 'hamlet' && cat.villages[t].race === race0);
    if (h) template = h;
  }
  // Test games (GAMEMODELS_TEST_VILLAGE, set into the catalog by testCatalogOverrides): the spawn cell's village is
  // that template — in the catalog, so the browser and every peer pick the same one.
  if (cx === 0 && cy === 0 && cat.test_spawn_village && cat.villages[cat.test_spawn_village]) template = cat.test_spawn_village;
  const v = cat.villages[template], race = cat.races[v.race];
  const np = race?.village_names || { prefix: ['New'], suffix: ['town'] };
  const name = np.prefix[Math.floor(roll(seed, `n1:${cx},${cy}`) * np.prefix.length)] + np.suffix[Math.floor(roll(seed, `n2:${cx},${cy}`) * np.suffix.length)];
  return {
    id: `vil:${cx},${cy}`, cell: [cx, cy], q, r, template, race: v.race, race_name: race?.name || v.race, name,
    team: String(v.team || '{name} Village').replace('{name}', name),
    alliance: `village_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${cx}_${cy}`.replace(/-/g, 'm'),
    radius: v.radius, clear_radius: v.clear_radius ?? v.radius + 3, cap: v.cap, reputation: v.reputation,
    wall: wallOf(v.wall, q, r),
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
    if (o && dist(o, v) < MIN_APART) v = null;
  }
  if (_cells.size > 4096) _cells.clear();
  _cells.set(k, v);
  return v;
}
// Villages whose centre is within `radius` of (q, r), nearest first.
export function villagesNear(seed, q, r, radius = 150) {
  const out = [];
  const c0 = floorDiv(q - radius, VILLAGE_CELL), c1 = floorDiv(q + radius, VILLAGE_CELL);
  const d0 = floorDiv(r - radius, VILLAGE_CELL), d1 = floorDiv(r + radius, VILLAGE_CELL);
  const seen = new Set();
  const consider = (v) => { if (v && !seen.has(v.id)) { seen.add(v.id); const d = dist(v, { q, r }); if (d <= radius) out.push({ ...v, dist: d }); } };
  for (let cx = c0; cx <= c1; cx++) for (let cy = d0; cy <= d1; cy++) consider(villageOfCell(seed, cx, cy));
  if (dist({ q, r }, { q: 0, r: 0 }) <= radius + ORIGIN_MAX) consider(villageOfCell(seed, 0, 0));
  return out.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
}
export const nearestVillage = (seed, q, r, radius = 400) => villagesNear(seed, q, r, radius)[0] || null;
// The village whose cleared disc holds (q, r), or null. Only the hex's own cell and the spawn village can.
export function villageAround(seed, q, r) {
  const cands = [villageOfCell(seed, floorDiv(q, VILLAGE_CELL), floorDiv(r, VILLAGE_CELL))];
  if (Math.abs(q) <= ORIGIN_MAX + 20 && Math.abs(r) <= ORIGIN_MAX + 20) cands.push(villageOfCell(seed, 0, 0));
  for (const v of cands) if (v && dist(v, { q, r }) <= v.clear_radius) return v;
  return null;
}
function hexesOf(seed, v) {
  const k = `${seed}|${v.id}`;
  let m = _hexes.get(k);
  if (m) return m;
  m = new Map();
  for (const l of cat.villages[v.template].layout || []) {
    const def = cat.buildings[l.building];
    if (def) m.set(`${v.q + l.at[0]},${v.r + l.at[1]}`, { building: l.building, def, at: l.at });
  }
  const w = cat.villages[v.template].wall;
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
  if (b?.wall) return { village: v, wall: true, path: b.path };
  return b ? { village: v, building: b.building, def: b.def, at: b.at } : { village: v, clear: true };
}
export const isVillageWallAt = (seed, q, r) => !!villageHexAt(seed, q, r)?.wall;
// The wall ring of a village in walking order (6R hexes, the gate included, flagged), and its sprites — the renderer
// draws the wall as one continuous run along it instead of a sprite per hex.
const RING_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export function villageWallRing(v) {
  const w = v?.wall, t = cat?.villages?.[v?.template]?.wall;
  if (!w || !t) return null;
  const R = w.radius, out = [];
  let q = v.q + RING_DIRS[4][0] * R, r = v.r + RING_DIRS[4][1] * R;
  for (let i = 0; i < 6; i++) for (let j = 0; j < R; j++) {
    out.push({ q, r, corner: j === 0, gate: q === w.gate.q && r === w.gate.r });
    q += RING_DIRS[i][0]; r += RING_DIRS[i][1];
  }
  return { hexes: out, sprites: t.sprites || {} };
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
  const w = cat.villages[h.village.template].wall;
  return { path: h.path, label: `${h.village.name} ${w.name || 'Wall'}`, kind: 'wall', biome: '', blocking: true, id: `village_wall/${h.village.id}:${q},${r}`,
    desc: w.text || 'The village wall: no way in but the gate.', village: { id: h.village.id, name: h.village.name, team: h.village.team, race: h.village.race, race_name: h.village.race_name, wall: true } };
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
  const t = cat?.villages?.[v.template];
  if (!t) return [];
  return (t.residents || []).map((rs, i) => ({ npc: rs.npc, q: v.q + rs.at[0], r: v.r + rs.at[1], ...(rs.post ? { post: rs.post } : {}), label: `${v.id.replace(/[^a-z0-9]+/gi, '_')}_r${i}`, name: personName(seed, v, `r${i}`, rs.npc, i) }));
}
export function villageWanderers(seed, v) {
  const t = cat?.villages?.[v.template];
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
export const standingOf = (rep, rp) => rep < rp.hostile ? 'hostile' : rep >= rp.ally_all ? 'ally' : rep >= rp.enter ? 'welcome' : 'stranger';
