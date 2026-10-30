// 2D isometric hex renderer. Flat-top hexes with vertical squash for the iso feel.
import { hexToPixel, hexCorners, pixelToHex, HEX_SIZE, H_SQUASH, stepToward } from './hex.js';
import { createUnitAnim, resourcesFor, dirIndexFromVector, loadFrames, loadResources, loadTerrain, terrainTile, terrainMeta, onAssetsChanged, effectStrip, drawEffectFrame } from './sprites.js';
import { hash32 } from './map.js';
import { loadScatter, scatterAt, scatterImage, onScatterChanged } from './scatter.js';
import { loadFeatures, featureAt, featureImage, onFeaturesChanged } from './features.js';
import { loadBigFeatures, bigFeatureAt, bigFeatureImage, onBigFeaturesChanged } from './bigfeature.js';

const ALLIANCE_COLOR = {
  'player':  '#6ad9ff',
  'npc_a':   '#6ad99f',
  'npc_b':   '#e36666',
};
// Rule 12 tile tokens: a small die in the element's colour on the hex. Shield
// tokens are drawn hollow (they absorb an effect hit), bonus tokens filled.
const ELEM_COLOR = {
  elem_vitality: '#ff6b6b', elem_souls: '#b48cff', elem_time: '#d9c36a', elem_space: '#8fa3ff',
  elem_air: '#dfe3e8', elem_water: '#6ad9ff', elem_earth: '#c49a6c', elem_fire: '#ff9a3c',
  elem_concentration: '#6ad99f', elem_harmony: '#ffb6e6',
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
    if ((stillMoving || stillFloating || stillIcons || stillBadges) && !rafId) {
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
  const SKILL_ICON = {
    skill_battle_trance:   { glyph: '🌀', color: '#ffb66e' },  // two actions, one trance
    skill_powerful_attack: { glyph: '💥', color: '#ff6b6b' },  // +1 damage
    skill_overrun:         { glyph: '🐂', color: '#ff6b6b' },  // charge, negates the target's move
    skill_grapple:         { glyph: '✊', color: '#ff6b6b' },  // hold → target plays EP
    skill_ranged_weapon:   { glyph: '🏹', color: '#ff6b6b' },  // Block does not strike back
    skill_barricade:       { glyph: '🧱', color: '#6ad99f' },  // permanent wall
    skill_taunt:           { glyph: '📣', color: '#6ad99f' },  // only legal target
    skill_sanctuary:       { glyph: '⛩', color: '#6ad99f' },  // untouchable while resting
    skill_force_shield:    { glyph: '🔰', color: '#6ad99f' },
    skill_dodge:           { glyph: '💨', color: '#6ad9ff' },  // −1 damage taken
    skill_bluff:           { glyph: '🎭', color: '#6ad9ff' },  // target plays EP
    skill_disruption_move: { glyph: '🌪', color: '#6ad9ff' },  // target plays EP
    skill_intimidation:    { glyph: '😠', color: '#dfe3e8' },  // target plays EP
    skill_counter_spell:   { glyph: '✨', color: '#dfe3e8' },
    default:               { glyph: '✦',  color: '#c9b8ff' },
  };

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

    // Features (buildings / permanents) — z-order 5 in Godot. Larger target
    // size (≈1.1 hex) with a tiny jitter so adjacent features in a long biome
    // strip don't line up into visible rows.
    for (const it of featureItems) {
      if (!inView(it.x, it.y)) continue;
      const tex = featureImage(it.f.path);
      if (!tex) continue;
      const h32 = hash32(`${state.map.seed}:j:${it.q}:${it.r}`);
      const jx = ((h32 & 0xFFFF) / 65536 - 0.5) * hexH * 0.18;
      const jy = (((h32 >> 16) & 0xFFFF) / 65536 - 0.5) * hexH * 0.12;
      const sy = tex.img.naturalHeight || 1;
      const sx = tex.img.naturalWidth || 1;
      const target = hexH * 1.1;
      const scale = Math.min(1.2, Math.max(0.25, target / sy));
      const dw = sx * scale, dh = sy * scale;
      ctx.drawImage(tex.img, it.x - dw / 2 + jx, it.y - dh + hexH * 0.12 + jy, dw, dh);
    }

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

    // Tile tokens (dice left on hexes by effects), bottom-right of the hex.
    for (const t of (state.tileTokens || [])) {
      const { x, y } = tilePx(t.q, t.r);
      const i = (state.tileTokens || []).filter(o => o.q === t.q && o.r === t.r).indexOf(t);
      const tx = x + HEX_SIZE * 0.45 - i * 11, ty = y + HEX_SIZE * H_SQUASH * 0.55;
      if (!inView(tx, ty)) continue;
      ctx.beginPath();
      ctx.rect(tx - 5, ty - 5, 10, 10);
      ctx.fillStyle = t.kind === 'shield' ? '#0b0d12' : (ELEM_COLOR[t.elem] || '#ccc');
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = ELEM_COLOR[t.elem] || '#ccc';
      ctx.stroke();
      ctx.fillStyle = t.kind === 'shield' ? (ELEM_COLOR[t.elem] || '#ccc') : '#0b0d12';
      ctx.font = 'bold 8px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(t.value), tx, ty + 3);
      // World-generated features (Shrine, Grove, Crystal …) carry their name over the die so the land reads at a glance.
      if (t.world && t.item) {
        ctx.font = '7px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = ELEM_COLOR[t.elem] || '#ccc';
        ctx.globalAlpha = 0.85;
        ctx.fillText(t.item, tx - 4, ty - 8);
        ctx.globalAlpha = 1;
      }
    }

    // Obstacles (Creation): a wall glyph with its hit points, centre of the hex.
    for (const o of (state.obstacles || [])) {
      const { x, y } = tilePx(o.q, o.r);
      if (!inView(x, y)) continue;
      ctx.font = `${Math.round(HEX_SIZE * 0.9)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#c9a56a';
      ctx.fillText('🧱', x, y + HEX_SIZE * 0.3);
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

    // Track self's actually-drawn pixel so the destination arrow starts from
    // the marker (not from the tile centre of a cell the marker is only
    // halfway into).
    let selfDrawnPx = null;
    // Entities. Dead entities render as a faded tombstone so a wiped ally still
    // leaves a marker on the map (otherwise it looks like the piece vanished).
    // Y-sort so a unit lower on the screen is painted over one behind it.
    const drawOrder = [...state.entities].sort((a, b) => positions.get(a.peerId).y - positions.get(b.peerId).y);
    for (const e of drawOrder) {
      const dead = e.life <= 0;
      const { x, y } = positions.get(e.peerId);
      if (e.isSelf) selfDrawnPx = { x, y };
      const color = ALLIANCE_COLOR[e.alliance] || '#ccc';

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

      const drewSprite = a.anim ? a.anim.draw(ctx, x, y + 6, now, dead ? 0.75 : 1) : false;
      if (!drewSprite) {
        // Fallback disc marker while the sheet is loading / no resources.
        if (dead) ctx.globalAlpha = 0.35;
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

      // Health pips.
      const lifeMax = Math.max(1, e.lifeMax || 1);
      const lifePx = x - (lifeMax * 4 - 2);
      for (let i = 0; i < lifeMax; i++) {
        ctx.fillStyle = i < e.life ? '#ffb0b0' : '#2a1a1a';
        ctx.fillRect(lifePx + i * 8, y + 16, 6, 4);
      }

      // Label (outlined so it reads over textured tiles).
      ctx.font = '11px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineJoin = 'round';
      ctx.strokeText(e.name, x, top - 6);
      ctx.fillStyle = dead ? '#9aa0a8' : '#e8ecf1';
      ctx.fillText(e.name, x, top - 6);

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
        ctx.fillStyle = e.isSelf ? '#ffe66e' : (e.alliance === 'npc_b' ? '#ff9c9c' : '#9fd8ff');
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
          : f.skill ? (SKILL_ICON[f.skill] || SKILL_ICON.default) : (ACTION_ICON[f.action] || ACTION_ICON.EP);
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
  }

  window.addEventListener('resize', () => { layout(); render(); });
  layout();

  // Wrap render so every external render-request also wakes the animation
  // loop if any entity is mid-slide.
  const renderPublic = () => { render(); scheduleIfAnimating(); };

  return { render: renderPublic, tilePx, toWorld, pickHex, zoom: () => zoom, wasDrag, recentre, isPanned: () => cam.manual, trigger };
}
