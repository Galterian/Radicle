// 2D isometric hex renderer. Flat-top hexes with vertical squash for the iso feel.
import { hexToPixel, hexCorners, pixelToHex, HEX_SIZE, H_SQUASH, stepToward, hexDistance } from './hex.js';
import { createUnitAnim, resourcesFor, dirIndexFromVector, loadFrames, loadResources, loadTerrain, terrainTile, terrainMeta, onAssetsChanged, effectStrip, drawEffectFrame, teamSource } from './sprites.js';
import { villageColour, ALLY_GREEN, villageAround, villageWallRing, raceWallSprites } from './villages.js';
import { hash32 } from './map.js';
import { shotPosAt } from './siege.js';
import { loadScatter, scatterAt, scatterImage, onScatterChanged } from './scatter.js';

// Speech balloons (AI skirmish): the speaker's name on top, the line word-wrapped to ~180 px (≤ 3 lines), the tail
// pointing down at the unit. Friends get a blue rim, foes a red one. Drawn AFTER every unit (a conversation layer on
// top), a newer balloon lifted above an older one it would cover. Plain fillText — the text never reaches the DOM.
const SPEECH_FONT = '12px system-ui, -apple-system, Segoe UI, sans-serif';
const SPEECH_NAME_FONT = 'bold 10px system-ui, -apple-system, Segoe UI, sans-serif';
function layoutSpeech(ctx, text, name) {
  ctx.font = SPEECH_FONT;
  const maxW = 180, lh = 14, pad = 6, nameH = name ? 12 : 0;
  const lines = [];
  let cur = '';
  for (const w of String(text).split(' ')) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxW && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  if (lines.length > 3) { lines.length = 3; lines[2] = `${lines[2].slice(0, -1)}…`; }
  const textW = Math.max(...lines.map(l => ctx.measureText(l).width));
  ctx.font = SPEECH_NAME_FONT;
  const nameW = name ? ctx.measureText(name).width : 0;
  const w = Math.min(maxW, Math.max(nameW, textW)) + pad * 2;
  return { lines, w, h: nameH + lines.length * lh + pad * 2, lh, pad, nameH };
}
function drawSpeechBalloons(ctx, balloons) {
  const placed = [];
  for (const b of balloons.sort((a, c) => a.startAt - c.startAt)) {   // older first: the newest ends on top
    const L = layoutSpeech(ctx, b.text, b.name);
    const bx = b.x - L.w / 2;
    let by = b.yTip - 8 - L.h;
    for (let guard = 0; guard < 6; guard++) {
      const hit = placed.find(r => bx < r.x + r.w + 4 && bx + L.w + 4 > r.x && by < r.y + r.h + 4 && by + L.h + 4 > r.y);
      if (!hit) break;
      by = hit.y - L.h - 6;
    }
    placed.push({ x: bx, y: by, w: L.w, h: L.h });
    const rr = 7, tx = Math.max(bx + rr + 6, Math.min(bx + L.w - rr - 6, b.x));
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, b.alpha)) * 0.94;
    ctx.beginPath();
    ctx.moveTo(bx + rr, by);
    ctx.arcTo(bx + L.w, by, bx + L.w, by + L.h, rr);
    ctx.arcTo(bx + L.w, by + L.h, bx, by + L.h, rr);
    ctx.lineTo(tx + 5, by + L.h); ctx.lineTo(b.x, b.yTip); ctx.lineTo(tx - 5, by + L.h);
    ctx.arcTo(bx, by + L.h, bx, by, rr);
    ctx.arcTo(bx, by, bx + L.w, by, rr);
    ctx.closePath();
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    ctx.fillStyle = 'rgba(250,247,238,0.96)';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = b.foe ? '#c94a4a' : '#4a86c9';
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    if (b.name) {
      ctx.font = SPEECH_NAME_FONT;
      ctx.fillStyle = b.foe ? '#a33434' : '#2f6aa8';
      ctx.fillText(b.name, bx + L.pad, by + L.pad - 1);
    }
    ctx.font = SPEECH_FONT;
    ctx.fillStyle = '#1b1d22';
    L.lines.forEach((l, i) => ctx.fillText(l, bx + L.pad, by + L.pad + L.nameH + i * L.lh));
    ctx.restore();
  }
}
import { loadFeatures, featureAt, featureImage, onFeaturesChanged, isVacantHex, LAB_WALL_PATHS } from './features.js';
import { buildingBonusAt } from './building-bonus.js';
import { loadBigFeatures, bigFeatureAt, bigFeatureImage, onBigFeaturesChanged } from './bigfeature.js';

const ALLIANCE_COLOR = {
  'player':   '#6ad9ff',
  'npc_a':    '#6ad99f',
  'npc_b':    '#e36666',
  'player_c': '#c79bff',
  'npc_c':    '#b07cff',
  'player_d': '#ffc266',
  'npc_d':    '#f0a040',
};
// Teams (same mapping as peer.mjs sideOf): A = the player, npc_a allies and
// their summons; B = npc_b; C = the third team (player_c / npc_c); D = the fourth (player_d / npc_d).
const sideOf = (a) => (a === 'player' || a === 'npc_a') ? 'A' : a === 'npc_b' ? 'B' : (a === 'player_c' || a === 'npc_c') ? 'C' : (a === 'player_d' || a === 'npc_d') ? 'D' : a;
// HP pip colour per team — filled / spent.
const TEAM_HP = { A: ['#5fe08a', '#16301f'], B: ['#ff6b6b', '#3a1616'], C: ['#b07cff', '#261a3a'], D: ['#ffa83a', '#3a2610'] };
// Shield life points sit on top of life (user ruling 2026-11-12): Overlord armor gold, Illusionist illusion cyan.
const HP_ARMOR = '#ffcc33', HP_ILLUSION = '#7fe8ff';
const DRUID_ORB = 'assets/Sprites/Buildings/Wood Elves/Healing Orb/Healing Orb - base [BPHO].png';
const DRUID_OBELISK = 'assets/terrain_scatter/standing_stone_obelisk_on_round_base_fgm0.png';
// Effect-placed Earth / Vitality tile tokens (Fossilization's bonus + shield, user ruling 2026-11-18 "map the tile-token
// permanent to an appropriate building"): a stone guardian statue for Earth (petrified), a Healing Orb for Vitality,
// standing on the hex while the token(s) do. Druid stones keep their own sprites; world features keep theirs.
// Effect tile tokens (Fossilization, Ice Blast, Artifice on a tile …) — one building per element (user 2026-11-23: no
// numbered dice on the map; the values are in the hex card, main.js tokenLines). None shared with WORLD_ITEM_BUILDING.
const TOKEN_BUILDING = {
  elem_earth: 'assets/Sprites/Buildings/Shared/Stone Golem (guardian statue)/Stone Golem (guardian statue) - base [BWGS].png',
  elem_vitality: 'assets/Sprites/Buildings/Wood Elves/Healing Orb/Healing Orb - base [BPHO].png',
  elem_souls: 'assets/Sprites/Buildings/Dark Elves/Tomb/Tomb - base [BPTO].png',
  elem_time: 'assets/Sprites/Buildings/High Elves/Dragonstone/Dragonstone - base [BPDI].png',
  elem_space: 'assets/Sprites/Buildings/Daemons/Portal/Portal - base [BPPO].png',
  elem_air: 'assets/Sprites/Buildings/Minotaurs/Lookout/Lookout - base [BPLO].png',
  elem_water: 'assets/Sprites/Buildings/Ssrathi/Sacred Pool/Sacred Pool - base [BPCP].png',
  elem_fire: 'assets/Sprites/Buildings/Neutral/Infernal Temple/Infernal Temple - base [BTIN].png',
  elem_concentration: 'assets/Sprites/Buildings/Ssrathi/Scrying Pool/Scrying Pool - base [BPYP].png',
  elem_harmony: 'assets/Sprites/Buildings/Fey/Magic Pool/Magic Pool - base [BPMP].png',
};
// World bonus items (map.js featureAt: Grove, Graveyard, Ruins, Crystals, Wells …) as a small building of their element
// instead of a numbered die (user 2026-11-23: "a number over the tile … is ugly"). One sprite per element, none shared
// with the effect / Druid tokens above; the item, element and value stay in the hover / object card.
const WORLD_ITEM_BUILDING = {
  elem_vitality: 'assets/Sprites/Buildings/Wood Elves/White Tree/White Tree - base [BPWT].png',
  elem_souls: 'assets/Sprites/Buildings/Undead/Gravestone/Gravestone - base [BAGR].png',
  elem_time: 'assets/Sprites/Buildings/Minotaurs/Henge/Henge - base [BPHG].png',
  elem_space: 'assets/Sprites/Buildings/Neutral/Black Portal/Black Portal - base [BMBP].png',
  elem_air: 'assets/Sprites/Buildings/Orcs/Totem/Totem - base [BWTP].png',
  elem_water: 'assets/Sprites/Buildings/Wood Elves/Magic Well/Magic Well - base [BPMW].png',
  elem_earth: 'assets/Sprites/Buildings/Neutral/Stone Quarry (size 1)/Stone Quarry (size 1) - base [BRS0].png',
  elem_fire: 'assets/Sprites/Buildings/Plaguelords/Fire Cave/Fire Cave - base [BPFC].png',
  elem_concentration: 'assets/Sprites/Buildings/Neutral/Shrine/Shrine - base [BMSH].png',
  elem_harmony: 'assets/Sprites/Buildings/Fey/Faerie Ring/Faerie Ring - base [BPFR].png',
};
// Skill isolation (2026-11-22): per-skill UI facts { tag, glyph, color, card_glyph?, card_color?, rest_hint?, trance, … }
// keyed by skill id = skills.mjs SKILL_UI, sent by the peer as hello.skill_ui; main.js calls setSkillUi() with it.
let _skillUi = {};
// The sprite a tile token is drawn as (main.js shows it in the hex card): world item, Druid stone or effect token.
export function tokenSpritePath(t) {
  if (!t) return null;
  if (t.world) return WORLD_ITEM_BUILDING[t.elem] || null;
  if (t.druid) return t.elem === 'elem_vitality' ? DRUID_ORB : DRUID_OBELISK;
  return TOKEN_BUILDING[t.elem] || null;
}
export function setSkillUi(map) { _skillUi = map instanceof Map ? Object.fromEntries(map) : (map && typeof map === 'object' ? { ...map } : {}); }
// Threat area: an enemy goes for whoever steps within this many hexes of it.
const THREAT_RADIUS = 2;
// Enemies my planned journey (pathPlan, else the destination) walks into the
// threat area of, where no one else hostile to them stands closer — they would
// come for me. Ties count as a threat (the chaser may still pick me).
function threatenedBy(entities, me, mySide, plan) {
  const out = new Set();
  if (!me || me.life <= 0 || !plan.length) return out;
  const alive = entities.filter(e => e.life > 0 && !e.gone && e.tile && Number.isInteger(e.tile.q));
  for (const foe of alive) {
    if (foe.isSelf || sideOf(foe.alliance) === mySide) continue;
    const dPath = Math.min(...plan.map(h => hexDistance(h, foe.tile)));
    if (dPath > THREAT_RADIUS) continue;
    const rival = alive.some(o => !o.isSelf && o !== foe && sideOf(o.alliance) !== sideOf(foe.alliance) && hexDistance(o.tile, foe.tile) < dPath);
    if (!rival) out.add(foe.peerId);
  }
  return out;
}
// Rule 12 tile tokens: a small die in the element's colour on the hex. Shield
// tokens are drawn hollow (they absorb an effect hit), bonus tokens filled.
const ELEM_COLOR = {
  elem_vitality: '#ff6b6b', elem_souls: '#b48cff', elem_time: '#d9c36a', elem_space: '#8fa3ff',
  elem_air: '#dfe3e8', elem_water: '#6ad9ff', elem_earth: '#c49a6c', elem_fire: '#ff9a3c',
  elem_concentration: '#6ad99f', elem_harmony: '#ffb6e6',
};
const ELEM_LETTER = {
  elem_vitality: 'V', elem_souls: 'S', elem_time: 'T', elem_space: 'Sp', elem_air: 'A',
  elem_water: 'W', elem_earth: 'E', elem_fire: 'F', elem_concentration: 'C', elem_harmony: 'H',
};

// How long an entity's position change takes to animate, in ms. The move is
// committed at end-of-resolution, which is ~1.5-2.3 s after the planning
// window started on the clock belonging to the resolution we're inside; from
// *there* to the next end-of-resolution is one full round (ROUND_SEC) plus
// the handshake. 7500 ms gives us almost the whole round+handshake, so the
// marker glides continuously and only arrives shortly before the next move —
// instead of parking on its destination for 2-3 s during reveal / resolution.
// If a new move lands before the current animation finishes, interpAt blends
// from the current drawn position into the new target without a jump.
const MOVE_DURATION_MS = 7500;
// Any tile change for an entity that we've known about for less than this
// window counts as "cold sync" — just reconnected / just loaded — and the
// marker snaps to the new position instead of sliding. Without this the
// browser would stage a slow 7.5s slide from each entity's initially-reported
// tile to whatever the mesh converges on next, so opening the app mid-game
// looked like "everyone is drifting into position" instead of "here's the
// current state."
const COLD_SYNC_MS = 1500;
// Smooth-step easing — slow in, slow out.
const ease = t => t < 0 ? 0 : t > 1 ? 1 : (t * t * (3 - 2 * t));

// Camera easing per frame toward the player's marker. The marker itself
// slides over MOVE_DURATION_MS, so a light follow keeps the world scrolling
// smoothly instead of pinning the hero dead-centre with a hard lock.
const CAM_FOLLOW = 0.12;
const ZOOM_MIN = 0.35, ZOOM_MAX = 1.6;

// A village wall built the WBC3 way (user 2026-11-24: no holes): horizontal pieces along the two flat rows, vertical
// pieces stacked down the slanted sides as a screen staircase (the WBC3 tiles only run left-right or up-down), a joint
// tower at the six corners and either side of the gate. Each piece is cropped to its opaque body (the baked shadow
// left out) and stretched centre to centre, so neighbouring pieces always overlap. Geometry only here
// ({ kind, x | x0..x1, y | y0..y1, key }); images resolve at draw time.
const WALL_S = 0.64;   // sprite px → map px: a horizontal piece's body (≈62 px) spans about half a hex step
const WALL_RANK = { vertical: 0, horizontal: 1, joint: 2 };
function buildVillageWalls(seed, features) {
  const shown = new Set(), firstOf = new Map(), pieces = [];
  for (const it of features) if (it.f.village?.wall) { shown.add(`${it.q},${it.r}`); if (!firstOf.has(it.f.village.id)) firstOf.set(it.f.village.id, it); }
  for (const [vid, it] of firstOf) {
    const v = villageAround(seed, it.q, it.r), ring = villageWallRing(v);
    if (!ring) continue;
    // a wall hex broken by a siege ram (vacated) is a gap like the gate
    const H = ring.hexes.map(h => isVacantHex(h.q, h.r) ? { ...h, gate: true } : h), n = H.length, cy = hexToPixel(v.q, v.r).y;
    const add = (p, key) => pieces.push({ ...p, key, vid, cy, sprites: ring.sprites });
    const seen = (h) => shown.has(`${h.q},${h.r}`);
    for (let i = 0; i < n; i++) {
      const a = H[i], b = H[(i + 1) % n];
      if (a.gate || b.gate || !(seen(a) || seen(b))) continue;
      const A = hexToPixel(a.q, a.r), B = hexToPixel(b.q, b.r);
      if (Math.abs(A.y - B.y) < 1) { add({ kind: 'horizontal', x0: Math.min(A.x, B.x), x1: Math.max(A.x, B.x), y: A.y }, A.y); continue; }
      const [U, L] = A.y < B.y ? [A, B] : [B, A];   // down the upper hex's column, then across the lower hex's row
      add({ kind: 'vertical', x: U.x, y0: U.y, y1: L.y }, L.y);
      add({ kind: 'horizontal', x0: Math.min(U.x, L.x), x1: Math.max(U.x, L.x), y: L.y }, L.y);
    }
    for (let i = 0; i < n; i++) {
      const h = H[i];
      if (h.gate || !seen(h) || !(h.corner || H[(i + 1) % n].gate || H[(i + n - 1) % n].gate)) continue;
      const P = hexToPixel(h.q, h.r);
      add({ kind: 'joint', x: P.x, y: P.y }, P.y);
    }
  }
  return pieces.sort((a, b) => a.key - b.key || WALL_RANK[a.kind] - WALL_RANK[b.kind]);
}
// An NPC builder's Barricades (made_by npc_builder) and the Creation walls, drawn as a WBC3 wall too (2026-11-27 "a
// proper wall … a consistent wall, a circle around the hamlet"): in the race's wall (a hamlet's = its race's full
// village's) and the village's colour inside a village, the neutral wall outside. Neighbouring Barricades join like
// a village wall — a horizontal piece along a row, a vertical + horizontal staircase on the slants — with a joint
// tower where a run ends or turns.
const NEUTRAL_WALL = { joint: LAB_WALL_PATHS[0], horizontal: LAB_WALL_PATHS[1], vertical: LAB_WALL_PATHS[2] };
function wallLookAt(seed, q, r) {
  const v = villageAround(seed, q, r);
  return { vid: v?.id || null, sprites: (v && raceWallSprites(v.race)) || NEUTRAL_WALL };
}
const HEX_DIRS6 = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];   // d and d + 3 are opposite
function buildBarricadeWalls(seed, features) {
  const at = new Map(), pieces = [];
  for (const it of features) if (it.f.made_by === 'npc_builder' && it.f.kind === 'wall') at.set(`${it.q},${it.r}`, it);
  for (const it of at.values()) {
    const look = wallLookAt(seed, it.q, it.r), A = hexToPixel(it.q, it.r);
    const add = (p, key) => pieces.push({ ...p, key, ...look });
    const dirs = [];
    for (let d = 0; d < 6; d++) {
      const b = at.get(`${it.q + HEX_DIRS6[d][0]},${it.r + HEX_DIRS6[d][1]}`);
      if (!b) continue;
      dirs.push(d);
      if (d >= 3) continue;   // each pair once
      const B = hexToPixel(b.q, b.r);
      if (Math.abs(A.y - B.y) < 1) { add({ kind: 'horizontal', x0: Math.min(A.x, B.x), x1: Math.max(A.x, B.x), y: A.y }, A.y); continue; }
      const [U, L] = A.y < B.y ? [A, B] : [B, A];
      add({ kind: 'vertical', x: U.x, y0: U.y, y1: L.y }, L.y);
      add({ kind: 'horizontal', x0: Math.min(U.x, L.x), x1: Math.max(U.x, L.x), y: L.y }, L.y);
    }
    if (!(dirs.length === 2 && dirs[1] - dirs[0] === 3)) add({ kind: 'joint', x: A.x, y: A.y }, A.y);
  }
  return pieces.sort((a, b) => a.key - b.key || WALL_RANK[a.kind] - WALL_RANK[b.kind]);
}
// Some WBC3 building sprites are a row of animation frames (Black Portal 736×112, Shrine 1184×147: 8 frames each) —
// drawn whole they read as a row of 8 buildings (2026-11-24, the "purple domes" along the village wall). The frame
// width: the even split of a wide sheet whose frames come out closest to square.
const _frameW = new WeakMap();
function frameW(img) {
  let f = _frameW.get(img);
  if (f) return f;
  const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
  f = w;
  if (w > 1.8 * h) {
    let best = Infinity;
    for (let n = 2; n <= 16; n++) if (w % n === 0 && Math.abs(Math.log(w / n / h)) < best) { best = Math.abs(Math.log(w / n / h)); f = w / n; }
  }
  _frameW.set(img, f);
  return f;
}
const _wallBody = new WeakMap();
function wallBody(img) {   // the opaque body of a wall sprite (the shadow is alpha ≈ 112)
  let b = _wallBody.get(img);
  if (b) return b;
  const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
  b = { x: 0, y: 0, w, h };
  try {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, w, h).data;
    // the body = the widest run of mostly-opaque columns (the shadow's edge has stray opaque pixels: BWN1, BWG0 at x 0)
    const col = new Array(w).fill(0), row = new Array(h).fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 200) col[x]++;
    const cMin = Math.max(...col) * 0.25;
    let x0 = -1, x1 = -2;
    for (let x = 0, s = -1; x <= w; x++) {
      if (x < w && col[x] >= cMin) { if (s < 0) s = x; continue; }
      if (s >= 0 && x - 1 - s > x1 - x0) { x0 = s; x1 = x - 1; }
      s = -1;
    }
    for (let y = 0; y < h; y++) for (let x = Math.max(0, x0); x <= x1; x++) if (d[(y * w + x) * 4 + 3] > 200) row[y]++;
    const rMin = Math.max(...row) * 0.1;
    const y0 = row.findIndex(n => n >= rMin), y1 = h - 1 - [...row].reverse().findIndex(n => n >= rMin);
    if (x0 >= 0 && x1 >= x0 && y0 >= 0 && y1 >= y0) b = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  } catch { /* tainted canvas: draw the whole sprite */ }
  _wallBody.set(img, b);
  return b;
}
function drawWallPiece(ctx, p, seed, hexH) {
  const tex = featureImage(p.sprites[p.kind] || p.sprites.joint);
  if (!tex) return;
  const src = teamSource(tex, villageColour(seed, p.vid)), b = wallBody(tex.img);
  const base = hexH * 0.18, dw = b.w * WALL_S, dh = b.h * WALL_S;   // the wall's foot sits just below the hex centre
  if (p.kind === 'horizontal') {
    const len = p.x1 - p.x0, k = Math.max(1, Math.round(len / dw)), step = len / k;
    for (let i = 0; i < k; i++) ctx.drawImage(src, b.x, b.y, b.w, b.h, p.x0 + i * step - 1, p.y + base - dh, step + 2, dh);
  } else if (p.kind === 'vertical') {
    const len = p.y1 - p.y0, k = Math.max(1, Math.ceil(len / (32 * WALL_S * 0.75)));
    for (let i = 0; i <= k; i++) ctx.drawImage(src, b.x, b.y, b.w, b.h, p.x - dw / 2, p.y0 + i * len / k + base - dh, dw, dh);
  } else ctx.drawImage(src, b.x, b.y, b.w, b.h, p.x - dw / 2, p.y + base + 2 - dh, dw, dh);
}

const SHOT_MS = 900, shotSeen = new Map();   // siege shots: "peer@action" → when that action counter was first drawn
export function createRenderer(canvas, state) {
  const ctx = canvas.getContext('2d');

  // The map is unbounded, so everything is drawn in *world* pixels
  // (hexToPixel) under a camera transform: `cam` is the world point at the
  // canvas centre, `zoom` the scale. tilePx() returns world pixels; toWorld()
  // maps a canvas pixel back. Nothing below needs to know where the camera is.
  const cam = { x: 0, y: 0, set: false, manual: false };
  let zoom = 1;
  let viewW = 0, viewH = 0, dpr = 1;

  // Per-entity motion book-keeping: { fromPx (world), toQ, toR, startAt }.
  // When we spot an entity's tile has changed since last render, we open a new
  // interpolation starting from where it was being drawn (not necessarily its
  // last whole-tile position — so interrupted moves blend smoothly).
  const moves = new Map();  // peerId -> { fromPx, toQ, toR, startAt }

  // Per-entity sprite animator (created lazily once the entity's resources
  // are known) + last drawn position, used to derive the facing direction.
  const anims = new Map();  // peerId -> { anim, sourceId, lastX, lastY, dir, wasDead }
  loadFrames(); loadResources(); loadTerrain(); loadScatter(); loadBigFeatures(); loadFeatures();
  onAssetsChanged(() => render());    // repaint when a sheet / tile / json lands
  // Scatter and feature catalogs arrive asynchronously after the first render.
  // The tile cache keys off (mapVersion, seed) so a plain repaint wouldn't
  // rebuild the scatter/feature draw lists — bump catalogEpoch so the cache
  // notices and rebuilds. PNG loads (not catalog loads) only need a repaint
  // because the lists already contain the item, just waiting on the image.
  let catalogEpoch = 0;
  onScatterChanged(() => { catalogEpoch++; render(); });
  onBigFeaturesChanged(() => { catalogEpoch++; render(); });
  onFeaturesChanged(() => { catalogEpoch++; render(); });

  // Kills the player wants to see land: main.js calls renderer.trigger(peerId,
  // 'attack' | 'cast') when an action resolves so the sprite swings.
  function trigger(peerId, name) { const a = anims.get(peerId); if (a?.anim) a.anim.trigger(name); }

  // Known tiles + fog frontier, rebuilt only when the map version changes.
  // Scatter and feature lists are derived from the same set of known tiles so
  // they stay in lock-step with the terrain pass; both are y-sorted (matching
  // Godot's ScatterLayer / FeatureLayer custom sort) so overlapping sprites
  // stack back-to-front correctly.
  // Building power → roof glyph (js/building-bonus.js).
  const BUILDING_GLYPH = { skill: '✦', stance: '⚔', teleport: '⟲', walls: '▦', mend: '✚', explore: '👁', draw: '📜', learn: '🎓', hurt: '☠', fortress: '🛡' };
  const tileCache = { version: -1, seed: null, epoch: -1, tiles: [], frontier: [], scatter: [], bigfeatures: [], features: [] };
  function tilesFor(map, version) {
    if (tileCache.version !== version || tileCache.seed !== map.seed || tileCache.epoch !== catalogEpoch) {
      tileCache.version = version;
      tileCache.seed = map.seed;
      tileCache.epoch = catalogEpoch;
      tileCache.tiles = [...map.tiles()].map(t => {
        const terr = map.terrain(t.q, t.r);
        // Deterministic variant per hex so the tiling doesn't shimmer. Not
        // modded here — sprites.terrainTile wraps against the per-biome list
        // length (20 variants per biome today, previously 4).
        const variant = hash32(`${map.seed}:v:${t.q}:${t.r}`) & 0x7fffffff;
        return { q: t.q, r: t.r, ...hexToPixel(t.q, t.r), fill: terr.fill, type: terr.type, variant };
      });
      // Draw order: top rows first so tile edges overlap in iso fashion.
      tileCache.tiles.sort((a, b) => a.y - b.y || a.x - b.x);
      tileCache.frontier = map.frontier().map(t => ({ q: t.q, r: t.r, ...hexToPixel(t.q, t.r) }));
      // Build scatter/feature draw lists once per map version. Both are pure
      // functions of (seed, q, r) so the only time they can change is when
      // more hexes are revealed (which bumps mapVersion).
      tileCache.scatter = [];
      tileCache.bigfeatures = [];
      tileCache.features = [];
      for (const t of tileCache.tiles) {
        const s = scatterAt(map.seed, t.q, t.r);
        if (s) tileCache.scatter.push({ q: t.q, r: t.r, x: t.x, y: t.y, s });
        const b = bigFeatureAt(map.seed, t.q, t.r);
        if (b) tileCache.bigfeatures.push({ q: t.q, r: t.r, x: t.x, y: t.y, b });
        const f = featureAt(map.seed, t.q, t.r);
        if (f) tileCache.features.push({ q: t.q, r: t.r, x: t.x, y: t.y, f });
      }
      tileCache.walls = buildVillageWalls(map.seed, tileCache.features).concat(buildBarricadeWalls(map.seed, tileCache.features))
        .sort((a, b) => a.key - b.key || WALL_RANK[a.kind] - WALL_RANK[b.kind]);
      // Already y-sorted courtesy of iterating `tileCache.tiles` in draw order.
    }
    return tileCache;
  }

  function layout() {
    viewW = canvas.clientWidth; viewH = canvas.clientHeight;
    dpr = devicePixelRatio || 1;
    canvas.width = viewW * dpr; canvas.height = viewH * dpr;
  }

  function tilePx(q, r) { return hexToPixel(q, r); }
  function toWorld(px, py) { return { x: (px - viewW / 2) / zoom + cam.x, y: (py - viewH / 2) / zoom + cam.y }; }
  function pickHex(px, py, known) { const w = toWorld(px, py); return pixelToHex(w.x, w.y, { x: 0, y: 0 }, known); }
  function applyCamera() {
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * (viewW / 2 - cam.x * zoom), dpr * (viewH / 2 - cam.y * zoom));
  }
  function inView(x, y, margin = HEX_SIZE * 1.5) {
    const hw = viewW / (2 * zoom) + margin, hh = viewH / (2 * zoom) + margin;
    return x > cam.x - hw && x < cam.x + hw && y > cam.y - hh && y < cam.y + hh;
  }

  // Hold the left button and drag to pan. The first few pixels are ignored so
  // an ordinary click never nudges the camera; once a drag has started the
  // camera stops following the hero (`cam.manual`) until recentre() — key C —
  // so you can scout the far side of the map without being yanked back every
  // round. The click event that follows a drag is flagged via wasDrag() so
  // main.js can ignore it.
  const drag = { active: false, moved: false, lastX: 0, lastY: 0 };
  const DRAG_THRESHOLD_PX = 4;
  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    drag.active = true; drag.moved = false; drag.lastX = ev.clientX; drag.lastY = ev.clientY;
  });
  window.addEventListener('mousemove', (ev) => {
    if (!drag.active) return;
    const dx = ev.clientX - drag.lastX, dy = ev.clientY - drag.lastY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true; drag.lastX = ev.clientX; drag.lastY = ev.clientY;
    cam.x -= dx / zoom; cam.y -= dy / zoom; cam.manual = true;
    canvas.classList.add('panning');
    render();
  });
  window.addEventListener('mouseup', (ev) => {
    if (ev.button !== 0) return;
    drag.active = false;
    canvas.classList.remove('panning');
  });
  window.addEventListener('blur', () => { drag.active = false; canvas.classList.remove('panning'); });
  function wasDrag() { return drag.moved; }
  function recentre() { cam.manual = false; render(); }

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const before = toWorld(ev.offsetX, ev.offsetY);
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * (ev.deltaY > 0 ? 0.9 : 1.1)));
    // Keep the hex under the cursor where it is while zooming.
    const after = toWorld(ev.offsetX, ev.offsetY);
    cam.x += before.x - after.x; cam.y += before.y - after.y;
    render();
  }, { passive: false });

  // Phone (html.mobile): one finger drags the map, two fingers pinch-zoom
  // around their midpoint. A finger that moved past the slop marks the gesture
  // as a drag, so the tap that follows is ignored like a mouse pan's.
  const isMobileUI = document.documentElement.classList.contains('mobile');
  if (isMobileUI) {
    const pts = new Map();
    const pinch = { dist: 0, zoom: 1 };
    const TOUCH_SLOP_PX = 10;
    canvas.addEventListener('touchstart', (ev) => {
      for (const t of ev.changedTouches) pts.set(t.identifier, { x: t.clientX, y: t.clientY });
      const list = [...pts.values()];
      if (list.length === 1) { drag.active = true; drag.moved = false; drag.lastX = list[0].x; drag.lastY = list[0].y; }
      if (list.length >= 2) { pinch.dist = Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y) || 1; pinch.zoom = zoom; drag.moved = true; }
    }, { passive: true });
    canvas.addEventListener('touchmove', (ev) => {
      ev.preventDefault();
      for (const t of ev.changedTouches) if (pts.has(t.identifier)) pts.set(t.identifier, { x: t.clientX, y: t.clientY });
      const list = [...pts.values()];
      if (list.length >= 2) {
        const rect = canvas.getBoundingClientRect();
        const mx = (list[0].x + list[1].x) / 2 - rect.left, my = (list[0].y + list[1].y) / 2 - rect.top;
        const before = toWorld(mx, my);
        const d = Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
        zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinch.zoom * d / pinch.dist));
        const after = toWorld(mx, my);
        cam.x += before.x - after.x; cam.y += before.y - after.y; cam.manual = true;
        render();
        return;
      }
      if (!list.length || !drag.active) return;
      const dx = list[0].x - drag.lastX, dy = list[0].y - drag.lastY;
      if (!drag.moved && Math.hypot(dx, dy) < TOUCH_SLOP_PX) return;
      drag.moved = true; drag.lastX = list[0].x; drag.lastY = list[0].y;
      cam.x -= dx / zoom; cam.y -= dy / zoom; cam.manual = true;
      render();
    }, { passive: false });
    const touchEnd = (ev) => {
      for (const t of ev.changedTouches) pts.delete(t.identifier);
      const list = [...pts.values()];
      if (!list.length) drag.active = false;
      else { drag.lastX = list[0].x; drag.lastY = list[0].y; }   // pinch → pan without a jump
    };
    canvas.addEventListener('touchend', touchEnd);
    canvas.addEventListener('touchcancel', touchEnd);
  }

  function interpAt(mv, now) {
    const t = Math.min(1, (now - mv.startAt) / MOVE_DURATION_MS);
    const k = ease(t);
    const to = tilePx(mv.toQ, mv.toR);
    return { x: mv.fromPx.x + (to.x - mv.fromPx.x) * k, y: mv.fromPx.y + (to.y - mv.fromPx.y) * k };
  }

  // Keep repainting while any entity is still sliding — otherwise animation
  // only ticks when `render()` is called externally and the piece would jump.
  let rafId = 0;
  function scheduleIfAnimating() {
    const now = performance.now();
    const stillMoving = [...moves.values()].some(m => now - m.startAt < MOVE_DURATION_MS);
    const stillFloating = (state.ui.floatingDmgs || []).some(f => now - f.startAt < f.duration);
    const stillIcons = (state.ui.floatingIcons || []).some(f => now - f.startAt < f.duration);
    const stillBadges = Object.values(state.ui.revealBadges || {}).some(b => now - b.startAt < b.duration);
    const stillToasts = (state.ui.effectToasts || []).some(f => now - f.startAt < f.duration);
    const stillSpeech = Object.values(state.ui.speech || {}).some(b => now - b.startAt < b.duration);
    if ((stillMoving || stillFloating || stillIcons || stillBadges || stillToasts || stillSpeech) && !rafId) {
      rafId = requestAnimationFrame(() => { rafId = 0; render(); scheduleIfAnimating(); });
    }
  }

  // Per-action icon + color for the revealer's floating marker. The emoji
  // characters are drawn as text; the color only affects a stroked halo
  // behind it (emoji glyphs are rendered by the system font with their own
  // colors, so we can't recolor the ⚔️ itself, but a tinted outline reads
  // clearly against the dark map).
  const ACTION_ICON = {
    A:  { glyph: '⚔️', color: '#ff6b6b' },  // Attack (red)
    B:  { glyph: '🛡',  color: '#6ad99f' },  // Block (green)
    M:  { glyph: '🤺', color: '#6ad9ff' },  // Move (blue)
    P:  { glyph: '👁',  color: '#dfe3e8' },  // Posture (dark white)
    EP: { glyph: '🧘', color: '#ffe66e' },  // Empty Posture (yellow)
    EM: { glyph: '🏃', color: '#ffe66e' },  // Empty Move (yellow)
    BT: { glyph: '🌀', color: '#ffb66e' },  // Battle Trance (two actions)
    // Standoff arrow — not an action, but used by the no-damage-in-contact
    // path to float a ➙ between each pair of adjacent enemies who clinched
    // without scoring.
    STANDOFF: { glyph: '➙', color: '#ffe66e' },
  };
  // Skill glyphs float in a row next to the action icon they rode on and
  // vanish with it. One picture per skill, closest Unicode match to its text.
  // Skill isolation (2026-11-22): the per-skill glyph / colour is the definition's `ui` block
  // (skills-data/skills/*.json ui.glyph / ui.color), handed in at runtime by setSkillUi() (main.js, from the
  // peer's hello.skill_ui); an unknown skill (or before the hello) keeps the default spark.
  const SKILL_ICON_DEFAULT = { glyph: '✦', color: '#c9b8ff' };
  const skillIcon = (id) => { const u = _skillUi[id]; return u && u.glyph && u.color ? { glyph: u.glyph, color: u.color } : SKILL_ICON_DEFAULT; };

  function hexPath(x, y) {
    const corners = hexCorners(x, y);
    ctx.beginPath();
    for (let i = 0; i < corners.length; i++) {
      const c = corners[i];
      if (i === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    }
    ctx.closePath();
  }

  // Work out where every entity is drawn this frame (opening a new slide when
  // its tile changed) BEFORE anything is painted, so the camera can follow the
  // player's marker and the tile pass can be culled against the final view.
  function entityPositions(now) {
    const out = new Map();
    for (const e of state.entities) {
      const target = tilePx(e.tile.q, e.tile.r);
      let x = target.x, y = target.y;
      const key = e.peerId;
      const prev = moves.get(key);
      if (!prev || prev.toQ !== e.tile.q || prev.toR !== e.tile.r) {
        // Cold-sync snap: if this is the first time we've seen this entity,
        // we've only known about it for a moment (fresh reconnect / page
        // load), or the client just set `state.ui.coldSyncUntil` to a future
        // time (via a hello handshake), jump the marker to the new position
        // instead of sliding. Lets the browser render "the current state"
        // immediately rather than animating a 7.5 s drift from the first
        // snapshot into the mesh's actual positions.
        const coldWindow = state.ui.coldSyncUntil && now < state.ui.coldSyncUntil;
        const isColdSync = !prev || (now - prev.startAt < COLD_SYNC_MS) || coldWindow;
        const fromPx = isColdSync ? target : interpAt(prev, now);
        moves.set(key, { fromPx, toQ: e.tile.q, toR: e.tile.r, startAt: now });
      } else {
        const p = interpAt(moves.get(key), now);
        x = p.x; y = p.y;
      }
      out.set(key, { x, y });
    }
    return out;
  }

  function followCamera(positions, now) {
    const me = state.entities.find(e => e.isSelf);
    let target = me ? positions.get(me.peerId) : null;
    if (!target) {
      const b = state.map.bounds();
      target = hexToPixel((b.min_q + b.max_q) / 2, (b.min_r + b.max_r) / 2);
    }
    const coldWindow = state.ui.coldSyncUntil && now < state.ui.coldSyncUntil;
    if (!cam.set || coldWindow) { cam.x = target.x; cam.y = target.y; cam.set = true; cam.manual = false; return; }
    if (cam.manual) return;   // the player dragged the map; hold still until recentre()
    cam.x += (target.x - cam.x) * CAM_FOLLOW;
    cam.y += (target.y - cam.y) * CAM_FOLLOW;
  }

  function render() {
    const now = performance.now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    const positions = entityPositions(now);
    followCamera(positions, now);
    applyCamera();

    // Known tiles, coloured by the seed-derived terrain; then the fog line —
    // the unknown hexes touching the known world, drawn as faint dashed
    // outlines so the edge of the revealed dimension is visible.
    const { tiles, frontier } = tilesFor(state.map, state.mapVersion);
    // Fog of war: a hex is "currently in sight" when state.ui.sightSet
    // (set by main.js#recomputeSightSet) contains "q,r". Known-but-out-of-
    // sight hexes get a dark overlay below; enemies drop out of the entity
    // draw loop. The set is absent before main.js's first raf — fall back to
    // "everything in sight" so the first few frames don't black-paint.
    const sightSet = state.ui?.sightSet || null;
    const inSight = sightSet ? (q, r) => sightSet.has(`${q},${r}`) : () => true;
    const showLabels = zoom >= 0.75 && state.ui.showCoords;
    ctx.lineWidth = 1;
    // Terrain PNGs are flat-top WBC3 hexes authored at `tile_w × tile_h`
    // (assets/terrain/terrain_tiles.json → "hex"). Our game hex is 2*HEX_SIZE
    // wide, so the scale that maps the PNG's long axis onto our hex is
    // (2*HEX_SIZE / tile_w); then the Godot client bumps that by 1.10 so
    // alpha-masked edges overlap neighbours instead of showing seams. Match
    // that exactly so both runtimes land the same pixel size.
    const tm = terrainMeta();
    const tileScale = tm && tm.tile_w
      ? ((2 * HEX_SIZE) / tm.tile_w) * 1.10
      : ((2 * HEX_SIZE) / (tm?.size || 320)) * 1.10;
    for (const t of tiles) {
      if (!inView(t.x, t.y)) continue;
      const img = terrainTile(t.type, t.variant);
      if (img) {
        const dw = img.img.naturalWidth * tileScale, dh = img.img.naturalHeight * tileScale;
        ctx.drawImage(img.img, t.x - dw / 2, t.y - dh / 2, dw, dh);
        if (zoom >= 1.1) { hexPath(t.x, t.y); ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.stroke(); }
      } else {
        hexPath(t.x, t.y);
        ctx.fillStyle = t.fill;
        ctx.fill();
        ctx.strokeStyle = '#232a38';
        ctx.stroke();
      }
      if (showLabels) {
        ctx.fillStyle = '#2f3a4a';
        ctx.font = '9px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${t.q},${t.r}`, t.x - 10, t.y - HEX_SIZE * H_SQUASH + 12);
      }
    }
    ctx.save();
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = '#1c2230';
    for (const t of frontier) {
      if (!inView(t.x, t.y)) continue;
      hexPath(t.x, t.y);
      ctx.stroke();
    }
    ctx.restore();

    // Scatter overlays (z-order 3 in Godot — above terrain, below features).
    // 2D canvas has no z buffer, so order == paint order: terrain painted
    // above (z=0), scatter now, features below (z=5), entities last (z=10).
    // Match ScatterLayer.gd's sizing: target height ≈ 0.55 hex with a small
    // hash-based jitter so overlays don't align into visible rows.
    const hexH = HEX_SIZE * 2 * H_SQUASH;
    const hexW = Math.sqrt(3) * HEX_SIZE;
    const { scatter: scatterItems, bigfeatures: bigItems, features: featureItems } = tileCache;
    for (const it of scatterItems) {
      if (!inView(it.x, it.y)) continue;
      const tex = scatterImage(it.s.path);
      if (!tex) continue;
      const h32 = hash32(`${state.map.seed}:sj:${it.q}:${it.r}`);
      const jx = ((h32 & 0xFFFF) / 65536 - 0.5) * hexH * 0.55;
      const jy = (((h32 >> 16) & 0xFFFF) / 65536 - 0.5) * hexH * 0.42;
      const sizeJit = 0.85 + (((h32 >> 8) & 0xFF) / 255) * 0.35;
      const sy = tex.img.naturalHeight || 1;
      const sx = tex.img.naturalWidth || 1;
      const target = hexH * 0.55 * sizeJit;
      const scale = Math.min(0.9, Math.max(0.08, target / sy));
      const dw = sx * scale, dh = sy * scale;
      ctx.drawImage(tex.img, it.x - dw / 2 + jx, it.y - dh + hexH * 0.15 + jy, dw, dh);
    }

    // Big features (forest clumps, boulder piles, ruins) — z-order 4 in Godot,
    // between scatter and buildings so a tower never hides under a canopy.
    // Sizing mirrors BigFeatureLayer.gd: ~2 hex widths wide, uniform scale
    // clamped to [0.25, 1.4], base anchored just below the hex centre, with a
    // small "bj" jitter so neighbouring trees never share a baseline exactly.
    for (const it of bigItems) {
      if (!inView(it.x, it.y, HEX_SIZE * 3)) continue;
      const tex = bigFeatureImage(it.b.path);
      if (!tex) continue;
      const sx = tex.img.naturalWidth || 1;
      const sy = tex.img.naturalHeight || 1;
      const scale = Math.min(1.4, Math.max(0.25, (hexW * 2) / sx));
      const dw = sx * scale, dh = sy * scale;
      const h32 = hash32(`${state.map.seed}:bj:${it.q}:${it.r}`);
      const jx = ((h32 & 0xFFFF) / 65536 - 0.5) * hexH * 0.22;
      const jy = (((h32 >> 16) & 0xFFFF) / 65536 - 0.5) * hexH * 0.15;
      ctx.drawImage(tex.img, it.x - dw / 2 + jx, it.y - dh + hexH * 0.35 + jy, dw, dh);
    }

    // Village walls: the far half (above the village centre) behind the buildings, the near half in front.
    const wallPieces = tileCache.walls || [];
    const wallVisible = (p) => inView(p.x ?? (p.x0 + p.x1) / 2, p.y ?? p.y1, HEX_SIZE * 2.5);
    for (const p of wallPieces) if (p.key < p.cy && wallVisible(p)) drawWallPiece(ctx, p, state.map.seed, hexH);
    // Features (buildings / permanents) — z-order 5 in Godot. Larger target
    // size (≈1.1 hex) with a tiny jitter so adjacent features in a long biome
    // strip don't line up into visible rows.
    for (const it of featureItems) {
      if (!inView(it.x, it.y)) continue;
      if (it.f.village?.wall || (it.f.made_by === 'npc_builder' && it.f.kind === 'wall')) continue;   // drawn as one run (buildVillageWalls / buildBarricadeWalls)
      const tex = featureImage(it.f.path);
      if (!tex) continue;
      const h32 = hash32(`${state.map.seed}:j:${it.q}:${it.r}`);
      const jx = ((h32 & 0xFFFF) / 65536 - 0.5) * hexH * 0.18;
      const jy = (((h32 >> 16) & 0xFFFF) / 65536 - 0.5) * hexH * 0.12;
      const sy = tex.img.naturalHeight || 1;
      const sx = frameW(tex.img);
      const target = hexH * 1.1;
      const scale = Math.min(1.2, Math.max(0.25, target / sy));
      const dw = sx * scale, dh = sy * scale;
      // A broken fortress stays as a faded ruin (user ruling 2026-11-12).
      const ruined = state.brokenBuildings?.has(`bld:${it.q},${it.r}`);
      if (ruined) ctx.globalAlpha = 0.3;
      // A village's walls and buildings wear its team colour (the WBC3 green ramp, recoloured like a unit's).
      const tint = it.f.village ? villageColour(state.map.seed, it.f.village.id) : null;
      ctx.drawImage(tint ? teamSource(tex, tint) : tex.img, 0, 0, sx, sy, it.x - dw / 2 + jx, it.y - dh + hexH * 0.12 + jy, dw, dh);
      ctx.globalAlpha = 1;
      // What the building does, as a small glyph on its roof — every building does something.
      const pw = !ruined && it.f.kind !== 'wall' && it.f.kind !== 'bridge' ? buildingBonusAt(state.map.seed, it.q, it.r)?.bonus?.power : null;
      // Dungeons: 🕳 while unexplored (a trap waits), a faded ✓ once explored.
      const dgBonus = !pw && !ruined && it.f.kind !== 'wall' && it.f.kind !== 'bridge' ? buildingBonusAt(state.map.seed, it.q, it.r)?.bonus : null;
      const dgDone = dgBonus?.dungeon && state.dungeonIsExplored?.(`dng:${it.q},${it.r}`);
      const glyph = pw?.kind === 'learn' && state.dungeonIsExplored?.(`lrn:${it.q},${it.r}`) ? '✓' : pw ? BUILDING_GLYPH[pw.kind] : dgBonus?.dungeon ? (dgDone ? '✓' : '🕳') : null;
      if (glyph && zoom > 0.45) {
        ctx.font = `${Math.round(hexH * 0.32)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const gx = it.x + dw * 0.32 + jx, gy = it.y - dh + hexH * 0.3 + jy;
        ctx.fillStyle = '#0b0d12cc'; ctx.beginPath(); ctx.arc(gx, gy, hexH * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffe66e'; ctx.fillText(glyph, gx, gy + 1);
      }
    }
    for (const p of wallPieces) if (p.key >= p.cy && wallVisible(p)) drawWallPiece(ctx, p, state.map.seed, hexH);

    // Target highlight.
    if (state.ui.hoverTile) {
      const { x, y } = tilePx(state.ui.hoverTile.q, state.ui.hoverTile.r);
      const corners = hexCorners(x, y);
      ctx.beginPath();
      for (let i = 0; i < corners.length; i++) {
        const c = corners[i];
        if (i === 0) ctx.moveTo(c.x, c.y);
        else ctx.lineTo(c.x, c.y);
      }
      ctx.closePath();
      ctx.strokeStyle = '#ffe66e';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (state.ui.selectedTarget) {
      const t = state.ui.selectedTarget;
      const { x, y } = tilePx(t.q, t.r);
      ctx.beginPath();
      ctx.arc(x, y, HEX_SIZE * 0.6, 0, Math.PI * 2);
      ctx.strokeStyle = '#e36666';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Druid stones (user ruling 2026-11-12): a Druid's tile bonus stands on its hex as a mapped building — a
    // Healing Orb when it carries Vitality, a standing-stone obelisk otherwise. One sprite per hex.
    const druidHexes = new Map();
    for (const t of (state.tileTokens || [])) if (t.druid) { const k = `${t.q},${t.r}`; druidHexes.set(k, druidHexes.get(k) || t.elem === 'elem_vitality'); }
    for (const [k, orb] of druidHexes) {
      const [q, r] = k.split(',').map(Number);
      const { x, y } = tilePx(q, r);
      if (!inView(x, y)) continue;
      const tex = featureImage(orb ? DRUID_ORB : DRUID_OBELISK);
      if (!tex?.ready) continue;
      const sy = tex.img.naturalHeight || 1, sx = frameW(tex.img);
      const scale = Math.min(1.0, Math.max(0.2, (hexH * 0.75) / sy));
      const dw = sx * scale, dh = sy * scale;
      // Beside whoever stands on the hex (right side), so the unit's sprite doesn't hide it.
      ctx.drawImage(tex.img, 0, 0, sx, sy, x - dw / 2 + HEX_SIZE * 0.5, y - dh + hexH * 0.25, dw, dh);
    }
    // Effect tile tokens as a building (left side of the hex; Vitality wins the hex when both stand — the orb heals).
    const tokenHexes = new Map();
    const tokenDrawn = new Set();   // tokens shown as a building / Druid stone + pip: no die for them below
    const pipsAt = new Map();       // "q,r" -> [{ elem, shield }] — one small pip per token at the building's foot
    const addPip = (t) => { const k = `${t.q},${t.r}`; if (!pipsAt.has(k)) pipsAt.set(k, []); pipsAt.get(k).push({ elem: t.elem, shield: t.kind === 'shield' }); };
    for (const t of (state.tileTokens || [])) {
      if (t.world || t.item) continue;
      const k = `${t.q},${t.r}`;
      if (t.druid || druidHexes.has(k)) { if (featureImage(druidHexes.get(k) ? DRUID_ORB : DRUID_OBELISK)?.ready) { tokenDrawn.add(t); addPip(t); } continue; }
      if (!TOKEN_BUILDING[t.elem]) continue;
      if (!tokenHexes.has(k) || t.elem === 'elem_vitality') tokenHexes.set(k, t.elem);
    }
    for (const [k, elem] of tokenHexes) {
      const [q, r] = k.split(',').map(Number);
      const { x, y } = tilePx(q, r);
      const tex = featureImage(TOKEN_BUILDING[elem]);
      if (!tex?.ready) continue;
      for (const t of (state.tileTokens || [])) if (!t.world && !t.item && !t.druid && t.q === q && t.r === r && TOKEN_BUILDING[t.elem]) { tokenDrawn.add(t); addPip(t); }
      if (!inView(x, y)) continue;
      const sy = tex.img.naturalHeight || 1, sx = frameW(tex.img);
      const scale = Math.min(0.8, Math.max(0.15, (hexH * 0.55) / sy));
      const dw = sx * scale, dh = sy * scale;
      ctx.globalAlpha = 0.92;
      ctx.drawImage(tex.img, 0, 0, sx, sy, x - dw / 2 - HEX_SIZE * 0.45, y - dh + hexH * 0.3, dw, dh);
      ctx.globalAlpha = 1;
    }
    for (const [k, pips] of pipsAt) {
      const [q, r] = k.split(',').map(Number);
      const { x, y } = tilePx(q, r);
      if (!inView(x, y)) continue;
      const px0 = x - HEX_SIZE * 0.45 - (pips.length - 1) * 3.5, py = y + hexH * 0.3 + 2;
      pips.slice(0, 4).forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(px0 + i * 7, py, 2.6, 0, Math.PI * 2);
        if (p.shield) { ctx.lineWidth = 1.4; ctx.strokeStyle = ELEM_COLOR[p.elem] || '#ccc'; ctx.stroke(); }
        else { ctx.fillStyle = ELEM_COLOR[p.elem] || '#ccc'; ctx.fill(); }
      });
    }
    // World bonus items: a small building of the element (WORLD_ITEM_BUILDING), back-right of the hex, with a tiny
    // element-coloured pip at its foot. Falls back to the die below while the sprite loads / if it is missing.
    const worldDrawn = new Set();
    for (const t of (state.tileTokens || [])) {
      if (!t.world || !WORLD_ITEM_BUILDING[t.elem]) continue;
      const { x, y } = tilePx(t.q, t.r);
      if (!inView(x, y)) continue;
      const tex = featureImage(WORLD_ITEM_BUILDING[t.elem]);
      if (!tex?.ready) continue;
      const sy = tex.img.naturalHeight || 1, sx = frameW(tex.img);
      const scale = Math.min(0.8, Math.max(0.15, (hexH * 0.55) / sy));
      const dw = sx * scale, dh = sy * scale;
      const bx = x + HEX_SIZE * 0.42, by = y + hexH * 0.3;
      ctx.globalAlpha = 0.92;
      ctx.drawImage(tex.img, 0, 0, sx, sy, bx - dw / 2, by - dh, dw, dh);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(bx, by + 2, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = ELEM_COLOR[t.elem] || '#ccc';
      ctx.fill();
      worldDrawn.add(t);
    }
    // Tile tokens (dice left on hexes by effects), bottom-right of the hex.
    for (const t of (state.tileTokens || [])) {
      if (worldDrawn.has(t) || tokenDrawn.has(t)) continue;   // the die only while its building sprite is not loaded
      const { x, y } = tilePx(t.q, t.r);
      const i = (state.tileTokens || []).filter(o => o.q === t.q && o.r === t.r).indexOf(t);
      // 2026-11-17 (Fossilization request): a bigger die with the element's letter on top so an Earth / Vitality
      // bonus (filled) or shield (hollow, 🛡 corner) token reads at a glance next to the unit standing on it.
      const tx = x + HEX_SIZE * 0.45 - i * 15, ty = y + HEX_SIZE * H_SQUASH * 0.55;
      if (!inView(tx, ty)) continue;
      ctx.beginPath();
      ctx.rect(tx - 7, ty - 7, 14, 14);
      ctx.fillStyle = t.kind === 'shield' ? '#0b0d12' : (ELEM_COLOR[t.elem] || '#ccc');
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = ELEM_COLOR[t.elem] || '#ccc';
      ctx.stroke();
      ctx.fillStyle = t.kind === 'shield' ? (ELEM_COLOR[t.elem] || '#ccc') : '#0b0d12';
      ctx.font = 'bold 10px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(t.value), tx, ty + 4);
      if (!t.world) {
        const letter = ELEM_LETTER[t.elem] || '?';
        ctx.font = 'bold 8px ui-sans-serif, system-ui, sans-serif';
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        const lbl = t.kind === 'shield' ? `${letter}🛡` : `${letter}+`;
        ctx.strokeText(lbl, tx, ty - 9);
        ctx.fillStyle = ELEM_COLOR[t.elem] || '#ccc';
        ctx.fillText(lbl, tx, ty - 9);
      }
      // World-generated features (Shrine, Grove, Crystal …) carry their name over the die so the land reads at a glance.
      if (t.world && t.item) {
        ctx.font = '7px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = ELEM_COLOR[t.elem] || '#ccc';
        ctx.globalAlpha = 0.85;
        ctx.fillText(t.item, tx - 4, ty - 8);
        ctx.globalAlpha = 1;
      }
    }

    // Obstacles (Creation, building walls): a WBC3 wall tower (the 🧱 glyph until its sprite is in) with its hit points.
    for (const o of (state.obstacles || [])) {
      const { x, y } = tilePx(o.q, o.r);
      if (!inView(x, y)) continue;
      const look = wallLookAt(state.map.seed, o.q, o.r);
      ctx.textAlign = 'center';
      if (featureImage(look.sprites.joint)?.ready) drawWallPiece(ctx, { kind: 'joint', x, y, ...look }, state.map.seed, HEX_SIZE * H_SQUASH * 2);
      else { ctx.font = `${Math.round(HEX_SIZE * 0.9)}px sans-serif`; ctx.fillStyle = '#c9a56a'; ctx.fillText('🧱', x, y + HEX_SIZE * 0.3); }
      ctx.font = 'bold 8px ui-monospace, Consolas, monospace';
      ctx.fillStyle = '#ffe6b0';
      ctx.fillText(`${o.hp}`, x + HEX_SIZE * 0.4, y - HEX_SIZE * 0.35);
    }
    // Traps I know of (mine; the ones Super Sense shows me), top-left of the hex.
    for (const t of (state.traps || [])) {
      const { x, y } = tilePx(t.q, t.r);
      const tx = x - HEX_SIZE * 0.45, ty = y - HEX_SIZE * H_SQUASH * 0.45;
      if (!inView(tx, ty)) continue;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.globalAlpha = t.mine ? 0.95 : 0.8;
      ctx.fillStyle = t.mine ? '#9fd38a' : '#e3a04a';
      ctx.fillText('🪤', tx, ty + 4);
      ctx.globalAlpha = 1;
    }

    // Fog overlay: dark hex on every known tile that isn't in state.ui.sightSet
    // this frame. Painted AFTER terrain/features/scatter/walls so everything
    // in those hexes dims uniformly; painted BEFORE entities so my hero and
    // teammates still render at full brightness on top.
    if (sightSet) {
      ctx.save();
      ctx.fillStyle = 'rgba(6, 10, 18, 0.55)';
      for (const t of tiles) {
        if (!inView(t.x, t.y)) continue;
        if (inSight(t.q, t.r)) continue;
        hexPath(t.x, t.y);
        ctx.fill();
      }
      ctx.restore();
    }

    // Track self's actually-drawn pixel so the destination arrow starts from
    // the marker (not from the tile centre of a cell the marker is only
    // halfway into).
    let selfDrawnPx = null;
    // Entities. Dead entities render as a faded tombstone so a wiped ally still
    // leaves a marker on the map (otherwise it looks like the piece vanished).
    // Y-sort so a unit lower on the screen is painted over one behind it.
    const drawOrder = [...state.entities].sort((a, b) => positions.get(a.peerId).y - positions.get(b.peerId).y);
    const mySide = sideOf(state.entities.find(x => x.isSelf)?.alliance || 'player');
    const selfEnt = state.entities.find(x => x.isSelf);
    const journey = state.ui.destinationTile && selfEnt
      ? (Array.isArray(state.ui.pathPlan) && state.ui.pathPlan.length ? state.ui.pathPlan : [state.ui.destinationTile]) : [];
    const threats = threatenedBy(state.entities, selfEnt, mySide, journey);
    if (typeof window !== "undefined") window.__chaosThreats = { journey, threats: [...threats] };   // test hook
    const balloons = [];   // speech balloons, drawn after every unit (drawSpeechBalloons)
    for (const e of drawOrder) {
      const dead = e.life <= 0;
      // Fog of war: enemies the team can't currently see simply don't paint.
      // My own hero, teammates (alliance player / npc_a) and units I own
      // always paint — the sightSet check only culls opponents.
      const mine = e.isSelf;
      const ownedByMe = e.owner_peer_id && state.myPeerId && e.owner_peer_id === state.myPeerId;
      const alliedChar = sideOf(e.alliance) === mySide;
      if (sightSet && !mine && !ownedByMe && !alliedChar
          && Number.isInteger(e.tile_q) && Number.isInteger(e.tile_r)
          && !inSight(e.tile_q, e.tile_r)) continue;
      const { x, y } = positions.get(e.peerId);
      if (e.isSelf) selfDrawnPx = { x, y };
      // A village's people: its own colour — the ally green once it counts me an ally (≥ ally_all) or follows me.
      const color = e.villageId ? ((e.follower && e.ownedByMe) || state.ui?.villageAllies?.has(e.villageId) ? ALLY_GREEN : villageColour(state.map.seed, e.villageId) || '#ccc') : ALLIANCE_COLOR[e.alliance] || '#ccc';

      // Sprite book-keeping: create the animator once resources resolve,
      // derive facing from the drawn-position delta, flag walking while the
      // slide is still in flight.
      let a = anims.get(e.peerId);
      if (!a) { a = { anim: null, sourceId: null, lastX: x, lastY: y, dir: 4, wasDead: dead }; anims.set(e.peerId, a); }
      if (!a.anim || a.sourceId !== e.sourceId || a.team !== color) {
        const res = resourcesFor(e.sourceId);
        if (res) { a.anim = createUnitAnim(res, { team: color }); a.sourceId = e.sourceId; a.team = color; }
      }
      const mv = moves.get(e.peerId);
      const moving = !!mv && (now - mv.startAt) < MOVE_DURATION_MS && (mv.fromPx.x !== tilePx(mv.toQ, mv.toR).x || mv.fromPx.y !== tilePx(mv.toQ, mv.toR).y);
      const ddx = x - a.lastX, ddy = y - a.lastY;
      if (moving && (Math.abs(ddx) > 0.05 || Math.abs(ddy) > 0.05)) a.dir = dirIndexFromVector(ddx, ddy);
      a.lastX = x; a.lastY = y;
      if (a.anim) a.anim.tick(now, { moving, dirIdx: a.dir, dead });

      ctx.save();

      // Ground ring: alliance colour, brighter for the player's own hero.
      ctx.beginPath();
      ctx.ellipse(x, y + 4, 22, 9, 0, 0, Math.PI * 2);
      ctx.fillStyle = dead ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.35)';
      ctx.fill();
      ctx.lineWidth = e.isSelf ? 2.5 : 1.5;
      ctx.strokeStyle = e.isSelf ? '#ffe66e' : color;
      ctx.globalAlpha = dead ? 0.4 : 0.9;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Invisibility: I and my allies still see the hidden unit, faded (enemies never get it — main.js hiddenFromMe).
      // A hero shadow (rule_hero_shadow) is drawn dimmed too.
      const drewSprite = a.anim ? a.anim.draw(ctx, x, y + 6, now, e.gone ? 0.35 : dead ? 0.75 : e.invisible ? 0.45 : e.shadow ? 0.5 : 1) : false;
      if (!drewSprite) {
        // Fallback disc marker while the sheet is loading / no resources.
        if (dead || e.gone) ctx.globalAlpha = 0.35;
        else if (e.invisible || e.shadow) ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.arc(x, y - 6, 16, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = e.isSelf ? 3 : 2;
        ctx.strokeStyle = e.isSelf ? '#ffe66e' : '#0b0d12';
        ctx.stroke();
        if (dead) {
          ctx.strokeStyle = '#e36666';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x - 12, y - 18); ctx.lineTo(x + 12, y + 6);
          ctx.moveTo(x + 12, y - 18); ctx.lineTo(x - 12, y + 6);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      const top = drewSprite ? y + 6 - a.anim.height() : y - 22;
      // Health: one tiny square per life point (desktop and phone), in the
      // unit's team colour — A green, B red, C purple; spent points dark.
      const lifeMax = Math.max(1, e.lifeMax || 1);
      const [hpOn, hpOff] = TEAM_HP[sideOf(e.alliance)] || ['#dddddd', '#2a2a2a'];
      const lifePx = x - (lifeMax * 4 - 2);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(lifePx - 1, y + 15, lifeMax * 8 - 1, 6);
      const shI = e.illusion ? 1 : 0, shA = e.armor ? 1 : 0;
      for (let i = 0; i < lifeMax; i++) {
        ctx.fillStyle = i >= e.life ? hpOff : i >= e.life - shI ? HP_ILLUSION : i >= e.life - shI - shA ? HP_ARMOR : hpOn;
        ctx.fillRect(lifePx + i * 8, y + 16, 6, 4);
      }

      // Elements this unit has emitted in its current cast, oldest → newest
      // (the newest is ringed). Cleared by the UI once it acts without emitting.
      const trail = !dead && !e.gone && Array.isArray(e.emitTrail) ? e.emitTrail : null;
      if (trail && trail.length) {
        const r = isMobileUI ? 4.5 : 4, step = r * 2 + 3;
        const tx = x - ((trail.length - 1) * step) / 2, ty = y + 28;
        trail.forEach((el, i) => {
          ctx.beginPath();
          ctx.arc(tx + i * step, ty, r, 0, Math.PI * 2);
          ctx.fillStyle = ELEM_COLOR[el] || '#ccc';
          ctx.fill();
          ctx.lineWidth = i === trail.length - 1 ? 2 : 1;
          ctx.strokeStyle = i === trail.length - 1 ? '#ffffff' : 'rgba(0,0,0,0.8)';
          ctx.stroke();
        });
      }

      // Label (outlined so it reads over textured tiles).
      // Unattended characters (rule_unattended_character): "follow <leader>" / "unattended"; a master gets a ⚑ flag.
      const label = isMobileUI && dead ? `☠ ${e.name}` : e.gone ? `⌛ ${e.name}` : e.shadow ? `${e.name} · ${e.followName ? `follow ${e.followName}` : 'unattended'}`
        : e.leader > 0 && !dead ? `⚑ ${e.name}` : e.aiRole === 'builder' && !dead ? `🔨 ${e.name}` : e.name;
      ctx.font = '11px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineJoin = 'round';
      ctx.strokeText(label, x, top - 6);
      ctx.fillStyle = dead || e.gone ? '#9aa0a8' : e.leader > 0 ? '#ffd166' : e.shadow ? '#c9a0ff' : '#e8ecf1';
      ctx.fillText(label, x, top - 6);
      // Dimension Out (rule_dimension_out): a violet "⇱ N" countdown chip under the name, for everyone.
      if (e.dimOutLeft != null && !dead && !e.gone) {
        const txt = `⇱ ${e.dimOutLeft}`;
        ctx.save();
        ctx.font = 'bold 11px ui-sans-serif, system-ui';
        const w = ctx.measureText(txt).width + 10, cy = top - 22;
        ctx.fillStyle = 'rgba(70, 30, 120, 0.85)'; ctx.strokeStyle = '#c9a0ff'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - w / 2, cy - 8, w, 15, 7) : ctx.rect(x - w / 2, cy - 8, w, 15); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#f1e6ff'; ctx.textAlign = 'center'; ctx.fillText(txt, x, cy + 3);
        ctx.restore();
      }
      // The leader flag: a small pennant over a master's head (gold), so the group's leader reads at a glance.
      if (e.leader > 0 && !dead && !e.gone) {
        const fx = x + 14, fy = top - 30;
        ctx.save();
        ctx.strokeStyle = '#2b2410'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy + 14); ctx.stroke();
        ctx.fillStyle = '#ffd166';
        ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + 10, fy + 3.5); ctx.lineTo(fx, fy + 7); ctx.closePath(); ctx.fill();
        ctx.restore();
      }

      // Queued-action chip over the player's head during planning. Once
      // committed, keep the letter as-is until the next round — only the
      // colour shifts to orange so the user can still tell at a glance that
      // the action is locked in.
      // Revealed composition over every unit — `[EM + A + ✦BT + ✦Po]` — which
      // vanishes on the same clock and fade curve as the floating action icon.
      // While it is live it replaces the planning chip for my own hero.
      // Locked out of acting (lost actions): an hourglass over the marker.
      if (e.lostActions > 0 && !dead) {
        ctx.font = '12px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffe66e';
        ctx.fillText(`⏳${e.lostActions > 1 ? e.lostActions : ''}`, x + 18, y - 16);
      }
      const badge = e.revealBadge;
      const bt = badge ? (now - badge.startAt) / badge.duration : 1;
      if (badge && bt < 1) {
        const alpha = bt < 0.75 ? 1 : (1 - (bt - 0.75) / 0.25);
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.font = 'bold 11px ui-monospace, Consolas, monospace';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(11,13,18,0.9)';
        ctx.fillStyle = e.isSelf ? '#ffe66e' : (sideOf(e.alliance) !== mySide ? '#ff9c9c' : '#9fd8ff');
        const text = `[${badge.text}]`;
        ctx.strokeText(text, x, y - 40 - 6 * bt);
        ctx.fillText(text, x, y - 40 - 6 * bt);
        ctx.restore();
      } else if (e.isSelf && e.queuedCode) {
        ctx.font = 'bold 11px ui-monospace, Consolas, monospace';
        ctx.strokeText(`[${e.queuedCode}]`, x, top - 18);
        ctx.fillStyle = e.locked ? '#ffb66e' : '#a08eff';
        ctx.fillText(`[${e.queuedCode}]`, x, top - 18);
      }
      // AI skirmish speech balloon (the `say` of the unit's reveal): above the head and the reveal chip, fading
      // out over its last fifth.
      const sp = e.speech;
      const st = sp ? (now - sp.startAt) / sp.duration : 1;
      if (sp && st >= 0 && st < 1 && !dead) balloons.push({ text: sp.text, name: String(e.name || '').replace(/^(Builder|Rival|Ally) — /, ''), startAt: sp.startAt,
        x, yTip: Math.min(top - 26, y - 54), alpha: st < 0.85 ? 1 : 1 - (st - 0.85) / 0.15, foe: sideOf(e.alliance) !== mySide });

      ctx.restore();
    }

    // Siege ammunition in flight (2026-11-25, js/siege.js): the engine's snapshot shots, `action` = the engine's next
    // action; the flight of the action after launch eases in over SHOT_MS from the moment that counter was seen.
    for (const e of state.entities) {
      if (!e.siegeShots?.length) continue;
      const seenKey = `${e.peerId}@${e.siegeAction}`;
      if (!shotSeen.has(seenKey)) { if (shotSeen.size > 200) shotSeen.clear(); shotSeen.set(seenKey, now); }
      const ease = Math.min(1, (now - shotSeen.get(seenKey)) / SHOT_MS);
      for (const s of e.siegeShots) {
        const p = shotPosAt(s, Math.max(0, e.siegeAction - s.at - 1 + ease));
        if (!p) continue;
        const c = tilePx(p.q, p.r), lift = 26 * p.arc;
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath(); ctx.ellipse(c.x, c.y, 5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
        if (s.kind === 'ballista') {
          const f = tilePx(s.from.q, s.from.r), a = Math.atan2(c.y - f.y, c.x - f.x);
          ctx.strokeStyle = '#5a3a1a'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(c.x - 9 * Math.cos(a), c.y - 8 - 9 * Math.sin(a)); ctx.lineTo(c.x + 9 * Math.cos(a), c.y - 8 + 9 * Math.sin(a)); ctx.stroke();
        } else {
          ctx.fillStyle = '#8a8478'; ctx.strokeStyle = '#2b2924'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(c.x, c.y - 8 - lift, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        ctx.restore();
      }
    }
    if (balloons.length) drawSpeechBalloons(ctx, balloons);

    // Threat areas my journey walks into: a ring of tiny red arrows on the hexes
    // THREAT_RADIUS away from each such enemy, pointing out — "step inside and
    // it comes for you". Pulses so it reads as a warning, not terrain.
    if (threats.size) {
      const pulse = 0.55 + 0.45 * Math.sin(now / 180);
      const ah = isMobileUI ? 8 : 7;
      ctx.save();
      ctx.fillStyle = '#ff3b3b';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 1;
      ctx.globalAlpha = pulse;
      for (const e of state.entities) {
        if (!threats.has(e.peerId) || !e.tile) continue;
        const c = positions.get(e.peerId) || tilePx(e.tile.q, e.tile.r);
        for (let dq = -THREAT_RADIUS; dq <= THREAT_RADIUS; dq++) for (let dr = -THREAT_RADIUS; dr <= THREAT_RADIUS; dr++) {
          const h = { q: e.tile.q + dq, r: e.tile.r + dr };
          if (hexDistance(h, e.tile) !== THREAT_RADIUS) continue;
          const t = tilePx(h.q, h.r);
          const ang = Math.atan2(t.y - c.y, t.x - c.x);
          const tx = t.x, ty = t.y - 4;
          ctx.beginPath();
          ctx.moveTo(tx + Math.cos(ang) * ah, ty + Math.sin(ang) * ah);
          ctx.lineTo(tx + Math.cos(ang + 2.4) * ah * 0.75, ty + Math.sin(ang + 2.4) * ah * 0.75);
          ctx.lineTo(tx + Math.cos(ang - 2.4) * ah * 0.75, ty + Math.sin(ang - 2.4) * ah * 0.75);
          ctx.closePath(); ctx.fill(); ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Destination arrow: now that the entity loop has filled in selfDrawnPx,
    // we can draw the dashed polyline starting from the marker's *actual*
    // pixel (mid-slide if an animation is running) rather than the tile
    // centre of its destination cell. Any pathPlan prefix that happens to
    // match the marker's current tile is trimmed — otherwise, in the brief
    // window between a move landing and the next resumeJourney, the arrow
    // would draw a zero-length kink before continuing on.
    if (state.ui.destinationTile && selfDrawnPx) {
      const me = state.entities.find(p => p.isSelf);
      if (me) {
        const d = state.ui.destinationTile;
        let plan = Array.isArray(state.ui.pathPlan) && state.ui.pathPlan.length
          ? state.ui.pathPlan
          : [(me.tile.q === d.q && me.tile.r === d.r) ? d : stepToward({ q: me.tile.q, r: me.tile.r }, d)];
        // Drop any leading hex that is already the marker's current tile.
        while (plan.length > 1 && plan[0].q === me.tile.q && plan[0].r === me.tile.r) {
          plan = plan.slice(1);
        }
        ctx.save();
        ctx.strokeStyle = '#a08eff';
        ctx.fillStyle = '#a08eff';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(selfDrawnPx.x, selfDrawnPx.y);
        for (const hex of plan) {
          const p = tilePx(hex.q, hex.r);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        const last = plan[plan.length - 1];
        const prevHex = plan.length > 1 ? plan[plan.length - 2] : null;
        const lp = tilePx(last.q, last.r);
        const pp = prevHex ? tilePx(prevHex.q, prevHex.r) : selfDrawnPx;
        const ang = Math.atan2(lp.y - pp.y, lp.x - pp.x);
        const ah = 10;
        ctx.beginPath();
        ctx.moveTo(lp.x, lp.y);
        ctx.lineTo(lp.x - ah * Math.cos(ang - Math.PI / 7), lp.y - ah * Math.sin(ang - Math.PI / 7));
        ctx.lineTo(lp.x - ah * Math.cos(ang + Math.PI / 7), lp.y - ah * Math.sin(ang + Math.PI / 7));
        ctx.closePath(); ctx.fill();
        if (!(last.q === d.q && last.r === d.r)) {
          const dp = tilePx(d.q, d.r);
          ctx.strokeStyle = '#a08eff88';
          ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(dp.x, dp.y, HEX_SIZE * 0.5, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();
      }
    }

    // Floating "-N❤" damage markers: lerp from dealer tile to victim tile
    // while fading out. Expired entries are swept so the array doesn't grow
    // unbounded across a long session.
    const floats = state.ui.floatingDmgs || [];
    if (floats.length) {
      let liveWriteIdx = 0;
      for (let i = 0; i < floats.length; i++) {
        const f = floats[i];
        const t = (now - f.startAt) / f.duration;
        if (t >= 1) continue;
        if (liveWriteIdx !== i) floats[liveWriteIdx] = f;
        liveWriteIdx++;
        if (t < 0) continue;   // scheduled for later (normal action after a Haste bonus round)
        const k = ease(t);
        const from = tilePx(f.fromQ, f.fromR);
        const to   = tilePx(f.toQ, f.toR);
        // Slow travel + a gentle lift so the number drifts upward as it moves.
        const x = from.x + (to.x - from.x) * k;
        const y = from.y + (to.y - from.y) * k - 16 * t;
        const alpha = t < 0.75 ? 1 : (1 - (t - 0.75) / 0.25);
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.font = 'bold 14px ui-sans-serif, system-ui';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.fillStyle = '#ff8888';
        const text = `-${f.amount}❤`;
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
        ctx.restore();
      }
      floats.length = liveWriteIdx;
    }

    // Floating per-action icons (⚔️ / 🛡 / 🤺 / 👁 / ➙). Same lerp+fade as
    // damage: targeted actions (A/M/EM) travel actor→aim; self-only actions
    // (B/P/EP) rise straight up from the actor's tile. A tinted stroked halo
    // behind the glyph gives the per-action color — the OS emoji font won't
    // let us recolor the glyph itself.
    const icons = state.ui.floatingIcons || [];
    if (icons.length) {
      let liveWriteIdx = 0;
      for (let i = 0; i < icons.length; i++) {
        const f = icons[i];
        const t = (now - f.startAt) / f.duration;
        if (t >= 1) continue;
        if (liveWriteIdx !== i) icons[liveWriteIdx] = f;
        liveWriteIdx++;
        if (t < 0) continue;   // scheduled for later (normal action after a Haste bonus round)
        const spec = f.effect ? { glyph: f.glyph || '✺', color: '#e6a4ff' }
          : f.skill ? skillIcon(f.skill) : (ACTION_ICON[f.action] || ACTION_ICON.EP);
        const k = ease(t);
        const from = tilePx(f.fromQ, f.fromR);
        const to   = tilePx(f.toQ, f.toR);
        // `dx` spreads an action's icons (its options + its skills) into a row.
        const x = from.x + (to.x - from.x) * k + (f.dx || 0);
        // Self-only actions get a stronger vertical lift so they're clearly
        // "rising" rather than drifting sideways.
        const lift = f.upOnly ? 36 * t : 20 * t;
        const y = from.y + (to.y - from.y) * k - lift - 24;
        const alpha = t < 0.75 ? 1 : (1 - (t - 0.75) / 0.25);
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.font = 'bold 18px "Segoe UI Emoji", "Apple Color Emoji", ui-sans-serif, system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 4;
        ctx.strokeStyle = spec.color;
        ctx.fillStyle = spec.color;
        // The ➙ standoff glyph points right by default; rotate it so each
        // arrow actually faces the enemy it's drifting toward. Other icons
        // are drawn upright.
        // Skills with a mapped WBC3 effect strip (data/skills.json
        // resources.sprites.effect) animate that strip over the actor; the
        // glyph is the fallback while the image loads or when none is mapped.
        const strip = f.skill ? effectStrip(resourcesFor(f.skill)?.sprites?.effect?.path) : null;
        if (strip) {
          drawEffectFrame(ctx, strip, t, x, y, 44);
          ctx.font = 'bold 11px "Segoe UI Emoji", "Apple Color Emoji", ui-sans-serif, system-ui';
          ctx.lineWidth = 3;
          ctx.strokeText(spec.glyph, x + 16, y + 16);
          ctx.fillText(spec.glyph, x + 16, y + 16);
        } else if (f.action === 'STANDOFF') {
          const ang = Math.atan2(to.y - from.y, to.x - from.x);
          ctx.translate(x, y);
          ctx.rotate(ang);
          ctx.strokeText(spec.glyph, 0, 0);
          ctx.fillText(spec.glyph, 0, 0);
        } else {
          ctx.strokeText(spec.glyph, x, y);
          ctx.fillText(spec.glyph, x, y);
        }
        ctx.restore();
      }
      icons.length = liveWriteIdx;
    }

    // Effect result toasts (user request 2026-11-17): "<effect> success" (green) / "<effect> failed" (red) over
    // the unit an enemy penalty landed on / missed — the effect's WBC3 strip (or a ✔ / ✖ glyph) above the text,
    // rising slowly and fading out. Fed by main.js onEffectResults from the peer's `effect_result` message.
    const toasts = state.ui.effectToasts || [];
    if (toasts.length) {
      let live = 0;
      for (let i = 0; i < toasts.length; i++) {
        const f = toasts[i];
        const t = (now - f.startAt) / f.duration;
        if (t >= 1) continue;
        if (live !== i) toasts[live] = f;
        live++;
        if (t < 0) continue;
        const p = tilePx(f.q, f.r);
        if (!inView(p.x, p.y)) continue;
        const x = p.x, y = p.y - HEX_SIZE * 0.9 - 26 * t - (f.dy || 0);
        const alpha = t < 0.1 ? t / 0.1 : t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
        const col = f.ok ? '#7dff9a' : '#ff6b6b';
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha);
        const strip = effectStrip(resourcesFor(f.effect_id)?.sprites?.effect?.path);
        if (strip) drawEffectFrame(ctx, strip, Math.min(1, t * 1.6), x, y - 18, 34);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 13px "Segoe UI Emoji", "Apple Color Emoji", ui-sans-serif, system-ui';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        if (!strip) { ctx.strokeText(f.ok ? '✔' : '✖', x, y - 16); ctx.fillStyle = col; ctx.fillText(f.ok ? '✔' : '✖', x, y - 16); }
        ctx.font = 'bold 12px ui-sans-serif, system-ui, sans-serif';
        ctx.strokeText(f.text, x, y);
        ctx.fillStyle = col;
        ctx.fillText(f.text, x, y);
        if (f.why) {
          ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
          ctx.lineWidth = 3;
          ctx.strokeText(f.why, x, y + 12);
          ctx.fillStyle = f.ok ? '#d0ffd8' : '#ffd0d0';
          ctx.fillText(f.why, x, y + 12);
        }
        ctx.restore();
      }
      toasts.length = live;
    }
  }

  window.addEventListener('resize', () => { layout(); render(); });
  layout();

  // Wrap render so every external render-request also wakes the animation
  // loop if any entity is mid-slide.
  const renderPublic = () => { render(); scheduleIfAnimating(); };

  return { render: renderPublic, tilePx, toWorld, pickHex, zoom: () => zoom, wasDrag, recentre, isPanned: () => cam.manual, trigger };
}
