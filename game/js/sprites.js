// Sprite / sound layer for the browser client.
//
// Resolves an entity's `resources` block (entry-level key in data/characters.json
// and data/creatures.json — see assets/resources_schema.json), loads the frame
// grids from assets/frames.json, lazily loads the WBC3 sheets served under
// /assets/, and drives per-entity frame animation (idle / fidget / walk /
// attack / cast / death). Also a tiny sound bank for the unit voice lines.
//
// Everything here is best-effort: until a sheet is loaded (or if an entity has
// no resources at all) callers fall back to the old disc marker.

// Row order of every WBC3 8-direction unit sheet, verified visually on the
// Knight Champion (mounted) and Minotaur sheets: clockwise starting from
// "facing away from the viewer". Row 0 = N … row 4 = S (facing the camera).
export const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const DIR_S = 4;

// Screen-space motion vector (y grows downward) → row index.
export function dirIndexFromVector(dx, dy) {
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return DIR_S;
  const a = Math.atan2(dx, -dy) * 180 / Math.PI;   // 0 = north, 90 = east
  return ((Math.round(a / 45) % 8) + 8) % 8;
}

// ---------------------------------------------------------------------------
// frames.json + resources

let frames = null;                 // path -> grid
let framesLoading = null;
const resourcesById = new Map();   // source_id -> resources
let resourcesLoading = null;
const listeners = new Set();

function notify() { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }
export function onAssetsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function loadFrames() {
  if (!framesLoading) {
    framesLoading = fetch('/assets/frames.json')
      .then(r => r.ok ? r.json() : {})
      .catch(() => ({}))
      .then(j => { frames = j || {}; notify(); return frames; });
  }
  return framesLoading;
}

function activeVersion(entry) {
  const vs = Array.isArray(entry?.versions) ? entry.versions : [];
  let best = null;
  for (const v of vs) {
    if (v && v.status === 'rejected') continue;
    if (!best || (v.weight ?? 0) > (best.weight ?? 0)) best = v;
  }
  return best;
}

export function loadResources() {
  if (!resourcesLoading) {
    const one = (url) => fetch(url).then(r => r.ok ? r.json() : null).catch(() => null);
    // Skills and effects carry `resources` too (effect strip + fx sounds), so a
    // revealed skill id resolves through the same resourcesFor() lookup.
    // + the GameModels catalog (2026-11-24): villagers / wanderers are creatures whose sprites live in their NPC entry.
    resourcesLoading = Promise.all([one('/data/characters.json'), one('/data/creatures.json'), one('/data/creatures_builtin.json'), one('/data/skills.json'), one('/data/effects.json'), one('/assets/gamemodels/catalog.json')]).then(docs => {
      for (const doc of docs) {
        const entries = Array.isArray(doc) ? doc : doc?.npcs ? Object.entries(doc.npcs).map(([id, n]) => ({ id, name: n.name, resources: n.resources })) : (doc?.entries || []);
        for (const e of entries) {
          if (!e || !e.id) continue;
          // `resources` is an entry-level key by contract; tolerate a version
          // that carries it in `data` as well.
          const res = e.resources || activeVersion(e)?.data?.resources || null;
          if (res) resourcesById.set(e.id, { ...res, _entryName: e.name });
        }
      }
      notify();
      return resourcesById;
    });
  }
  return resourcesLoading;
}

export function resourcesFor(sourceId) {
  if (!sourceId) return null;
  return resourcesById.get(sourceId) || null;
}

export function assetUrl(path) {
  if (!path) return null;
  return '/' + String(path).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}

// ---------------------------------------------------------------------------
// Effect strips (skills / effects `resources.sprites.effect`): one row of
// frames, cols from frames.json or inferred from the aspect ratio.

const effectStrips = new Map();   // path -> {img, ready, cols, fps}

export function effectStrip(path) {
  if (!path) return null;
  let s = effectStrips.get(path);
  if (!s) {
    s = { img: new Image(), ready: false, cols: 1, fps: 10 };
    s.img.onload = () => {
      const g = frames ? frames[path] : null;
      s.cols = g?.cols || Math.max(1, Math.round(s.img.width / s.img.height));
      s.fps = g?.fps || 10;
      s.ready = true;
      notify();
    };
    s.img.src = assetUrl(path);
    effectStrips.set(path, s);
  }
  return s.ready ? s : null;
}

// Draw frame `t` (0..1 through the strip) centred on (x, y) at height `h`.
export function drawEffectFrame(ctx, strip, t, x, y, h) {
  const cw = strip.img.width / strip.cols;
  const ch = strip.img.height;
  const i = Math.min(strip.cols - 1, Math.floor(Math.max(0, t) * strip.cols));
  const w = h * (cw / ch);
  ctx.drawImage(strip.img, i * cw, 0, cw, ch, x - w / 2, y - h / 2, w, h);
}

// ---------------------------------------------------------------------------
// Sheets

const sheets = new Map();   // path -> sheet

// Fallback grid when frames.json lacks the sheet or its detection looks
// wrong (cell wider than ~2.2× its height is never a unit frame): 8 rows,
// and the divisor of the width whose cell is closest to 1.1× the cell height.
function fallbackGrid(w, h) {
  const rows = 8;
  const ch = h / rows;
  let bestCols = Math.max(1, Math.round(w / (ch * 1.1)));
  let bestErr = Infinity;
  for (let n = 1; n <= 64; n++) {
    if (w % n) continue;
    const cw = w / n;
    if (cw < ch * 0.5 || cw > ch * 2.2) continue;
    const err = Math.abs(cw - ch * 1.1);
    if (err < bestErr) { bestErr = err; bestCols = n; }
  }
  return { cols: bestCols, rows, cw: w / bestCols, ch };
}

function applyGrid(sheet) {
  const w = sheet.img.naturalWidth, h = sheet.img.naturalHeight;
  const g = frames ? frames[sheet.path] : null;
  let cols, rows, cw, ch;
  if (g && g.cols > 0 && g.rows > 0) {
    cols = g.cols; rows = g.rows; cw = w / cols; ch = h / rows;
    sheet.kind = g.kind || sheet.kind;
    sheet.fps = g.fps || sheet.fps;
    if (typeof g.loop === 'boolean') sheet.loop = g.loop;
  }
  const isUnit = sheet.kind === 'unit-8dir' || sheet.unitLike;
  if (isUnit && (!g || cw > ch * 2.2 || rows !== 8)) {
    if (!(g && g.kind === 'strip' && rows === 1)) {
      ({ cols, rows, cw, ch } = fallbackGrid(w, h));
      sheet.method = 'fallback';
    }
  }
  if (!cols) { cols = 1; rows = 1; cw = w; ch = h; }
  sheet.cols = cols; sheet.rows = rows; sheet.cw = cw; sheet.ch = ch;
  sheet.ready = true;
}

export function getSheet(path, opts = {}) {
  if (!path) return null;
  let s = sheets.get(path);
  if (s) return s;
  s = { path, img: new Image(), ready: false, failed: false, cols: 1, rows: 1, cw: 0, ch: 0,
        kind: opts.kind || 'unit-8dir', unitLike: opts.unitLike !== false, fps: opts.fps || 12, loop: opts.loop !== false, method: 'frames' };
  s.img.onload = () => { applyGrid(s); notify(); };
  s.img.onerror = () => { s.failed = true; notify(); };
  s.img.src = assetUrl(path);
  sheets.set(path, s);
  loadFrames();
  return s;
}

// ---------------------------------------------------------------------------
// Team colour. The extractor normalises the WBC3 player-colour palette ramp to
// pure (0, g, 0); a recoloured copy of the sheet is produced once per
// (sheet, team) on an offscreen canvas and cached on the sheet object.

function parseColor(css) {
  if (!css) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function teamSource(sheet, team) {
  if (!team || !sheet.ready || sheet.failed) return sheet.img;
  sheet.tints ||= new Map();
  let cv = sheet.tints.get(team);
  if (cv) return cv;
  const rgb = parseColor(team);
  if (!rgb) return sheet.img;
  cv = document.createElement('canvas');
  cv.width = sheet.img.naturalWidth; cv.height = sheet.img.naturalHeight;
  const g2 = cv.getContext('2d', { willReadFrequently: true });
  g2.drawImage(sheet.img, 0, 0);
  try {
    const id = g2.getImageData(0, 0, cv.width, cv.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (g > 38 && r < 0.08 * g + 5 && b < 0.08 * g + 5) {   // saturated green = team ramp
        const k = g / 255;
        d[i] = rgb[0] * k; d[i + 1] = rgb[1] * k; d[i + 2] = rgb[2] * k;
      }
    }
    g2.putImageData(id, 0, 0);
  } catch { return sheet.img; }
  sheet.tints.set(team, cv);
  return cv;
}

// Draw one cell. (x, y) is the bottom-centre anchor in world pixels.
export function drawCell(ctx, sheet, col, row, x, y, scale, footOffset = 0, team = null) {
  if (!sheet || !sheet.ready || sheet.failed) return false;
  const c = Math.max(0, Math.min(sheet.cols - 1, col | 0));
  const r = Math.max(0, Math.min(sheet.rows - 1, row | 0));
  const dw = sheet.cw * scale, dh = sheet.ch * scale;
  ctx.drawImage(teamSource(sheet, team), c * sheet.cw, r * sheet.ch, sheet.cw, sheet.ch, x - dw / 2, y - dh + footOffset * dh, dw, dh);
  return true;
}

// ---------------------------------------------------------------------------
// Per-entity animation

// How tall a unit should stand on screen, in world pixels. HEX_SIZE 46 →
// a hex is ~66 px tall after the iso squash, so this is ≈1.6 hexes.
export const UNIT_TARGET_H = 74;
// Fraction of the cell height that hangs *below* the anchor — the WBC3 cells
// include the drop shadow under the feet, so the feet sit a little above the
// cell's bottom edge.
const FOOT_OFFSET = 0.22;

const ONE_SHOT = new Set(['attack', 'cast', 'special', 'death', 'fidget']);

export function createUnitAnim(resources, opts = {}) {
  const team = opts.team || null;   // CSS hex colour for the player-colour ramp
  const sprites = resources?.sprites || {};
  const sheetFor = (name) => sprites[name]?.path ? getSheet(sprites[name].path) : null;
  const has = (name) => !!sprites[name]?.path;

  const st = { name: 'idle', startAt: performance.now(), dir: DIR_S, nextFidget: performance.now() + 3000 + Math.random() * 6000, pending: null, scale: null, deadDone: false };

  function play(name, now) {
    if (!has(name)) return false;
    st.name = name; st.startAt = now;
    return true;
  }

  // Scale is derived once from the idle sheet (fallback: walk) so all
  // animations of the unit share a pixel scale and don't pop in size.
  function scaleFor() {
    if (st.scale) return st.scale;
    const ref = sheetFor('idle') || sheetFor('walk') || sheetFor('attack');
    if (!ref || !ref.ready) return null;
    st.scale = UNIT_TARGET_H / Math.max(1, ref.ch * (1 - FOOT_OFFSET));
    return st.scale;
  }

  function trigger(name) { if (has(name)) st.pending = name; }

  // moving: bool, dirIdx: 0..7 or null, dead: bool
  function tick(now, { moving, dirIdx, dead }) {
    if (Number.isInteger(dirIdx)) st.dir = dirIdx;
    if (dead) {
      if (st.name !== 'death') { if (!play('death', now)) st.name = 'idle'; }
      return;
    }
    if (st.name === 'death') { st.name = 'idle'; st.startAt = now; }  // resurrected / reset
    const cur = sheetFor(st.name);
    const oneShot = ONE_SHOT.has(st.name);
    if (oneShot && cur && cur.ready) {
      const dur = (cur.cols / (cur.fps || 12)) * 1000;
      if (now - st.startAt < dur) return;   // let it finish
      st.name = 'idle'; st.startAt = now;
    } else if (oneShot && cur && !cur.ready && !cur.failed) {
      return;   // waiting for the sheet
    }
    if (st.pending) { const p = st.pending; st.pending = null; if (play(p, now)) return; }
    if (moving) {
      if (st.name !== 'walk') { if (!play('walk', now)) st.name = 'idle'; }
      st.nextFidget = now + 3000 + Math.random() * 6000;
      return;
    }
    if (st.name === 'walk') { st.name = 'idle'; st.startAt = now; }
    if (st.name === 'idle' && now > st.nextFidget) {
      st.nextFidget = now + 4000 + Math.random() * 8000;
      play('fidget', now);
    }
  }

  function frameIndex(sheet, now) {
    const fps = sheet.fps || 12;
    const n = Math.max(1, sheet.cols);
    const f = Math.floor((now - st.startAt) * fps / 1000);
    if (st.name === 'death') return Math.min(n - 1, f);            // hold the last frame
    if (ONE_SHOT.has(st.name)) return Math.min(n - 1, f);
    if (st.name === 'idle' && n <= 2) return Math.floor((now - st.startAt) / 600) % n;  // slow breathe
    return f % n;
  }

  // Returns true when something was drawn.
  function draw(ctx, x, y, now, alpha = 1) {
    let sheet = sheetFor(st.name) || sheetFor('idle');
    if (!sheet) return false;
    if (!sheet.ready) {
      if (sheet.failed) { sheet = sheetFor('idle'); if (!sheet || !sheet.ready) return false; }
      else return false;
    }
    const scale = scaleFor();
    if (!scale) return false;
    const row = sheet.rows >= 8 ? st.dir : 0;
    const col = frameIndex(sheet, now);
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * alpha;
    drawCell(ctx, sheet, col, row, x, y, scale, FOOT_OFFSET, team);
    ctx.globalAlpha = prevAlpha;
    return true;
  }

  // Footprint (world px) of the current frame — used for hit-testing / labels.
  function height() { const s = scaleFor(); const sh = sheetFor('idle') || sheetFor('walk'); return s && sh && sh.ready ? sh.ch * s * (1 - FOOT_OFFSET) : UNIT_TARGET_H; }

  return { tick, trigger, draw, height, get name() { return st.name; } };
}

// ---------------------------------------------------------------------------
// Sounds

export function createSoundBank() {
  let muted = false;
  const last = new Map();  // key -> time
  const cache = new Map(); // url -> Audio (template)
  function pick(list) { return Array.isArray(list) && list.length ? list[Math.floor(Math.random() * list.length)] : null; }
  function play(resources, kind, { throttleMs = 350, volume = 0.6 } = {}) {
    if (muted || !resources) return false;
    const entry = pick(resources.sounds?.[kind]);
    if (!entry?.path) return false;
    const key = `${resources.wbc3_code || resources._entryName || '?'}:${kind}`;
    const now = performance.now();
    if (now - (last.get(key) || 0) < throttleMs) return false;
    last.set(key, now);
    const url = assetUrl(entry.path);
    try {
      let tpl = cache.get(url);
      if (!tpl) { tpl = new Audio(url); tpl.preload = 'auto'; cache.set(url, tpl); }
      const a = tpl.cloneNode();
      a.volume = volume;
      a.play().catch(() => { /* autoplay blocked until a gesture — fine */ });
    } catch { return false; }
    return true;
  }
  function playUrl(path, volume = 0.5) {
    if (muted || !path) return;
    try { const a = new Audio(assetUrl(path)); a.volume = volume; a.play().catch(() => {}); } catch { /* ignore */ }
  }
  return {
    play, playUrl,
    get muted() { return muted; },
    toggle() { muted = !muted; return muted; },
    set(m) { muted = !!m; },
  };
}

// ---------------------------------------------------------------------------
// Terrain tiles (assets/terrain/terrain_tiles.json + PNGs)

let terrainInfo = null;
let terrainLoading = null;
const terrainImgs = new Map();  // path -> {img, ready}

export function loadTerrain() {
  if (!terrainLoading) {
    terrainLoading = fetch('/assets/terrain/terrain_tiles.json')
      .then(r => r.ok ? r.json() : null).catch(() => null)
      .then(j => { terrainInfo = j; notify(); return j; });
  }
  return terrainLoading;
}

// Returns {img, w, h} for terrain type + variant or null while loading.
export function terrainTile(type, variant) {
  if (!terrainInfo) return null;
  const set = terrainInfo.chaos_terrain?.[type];
  const list = set?.variants;
  if (!list || !list.length) return null;
  const path = list[((variant % list.length) + list.length) % list.length];
  let t = terrainImgs.get(path);
  if (!t) {
    t = { img: new Image(), ready: false, failed: false };
    t.img.onload = () => { t.ready = true; notify(); };
    t.img.onerror = () => { t.failed = true; };
    t.img.src = assetUrl(path);
    terrainImgs.set(path, t);
  }
  return t.ready ? t : null;
}

export function terrainMeta() { return terrainInfo?.hex || null; }
