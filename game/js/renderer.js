// 2D isometric hex renderer. Flat-top hexes with vertical squash for the iso feel.
import { hexToPixel, hexCorners, HEX_SIZE, H_SQUASH, stepToward } from './hex.js';

const ALLIANCE_COLOR = {
  'player':  '#6ad9ff',
  'npc_a':   '#6ad99f',
  'npc_b':   '#e36666',
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

export function createRenderer(canvas, state) {
  const ctx = canvas.getContext('2d');

  // Origin in canvas space so the 5x5 grid sits centred.
  const origin = { x: 0, y: 0 };

  // Per-entity motion book-keeping: { fromQ, fromR, toQ, toR, startAt }.
  // When we spot an entity's tile has changed since last render, we open a new
  // interpolation starting from where it was being drawn (not necessarily its
  // last whole-tile position — so interrupted moves blend smoothly).
  const moves = new Map();  // peerId -> { fromPx, toQ, toR, startAt }

  function layout() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const far = hexToPixel(4, 4);
    origin.x = (w - far.x) / 2;
    origin.y = (h - far.y) / 2 - 20;
  }

  function tilePx(q, r) {
    const p = hexToPixel(q, r);
    return { x: origin.x + p.x, y: origin.y + p.y };
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
    if ((stillMoving || stillFloating || stillIcons) && !rafId) {
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
    EP: { glyph: '➙',  color: '#ffe66e' },  // Empty Posture (yellow)
    EM: { glyph: '➙',  color: '#c9b84c' },  // Empty Move — dim yellow
  };

  function render() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Draw tiles.
    for (let r = 0; r < 5; r++) {
      for (let q = 0; q < 5; q++) {
        const { x, y } = tilePx(q, r);
        const corners = hexCorners(x, y);
        ctx.beginPath();
        for (let i = 0; i < corners.length; i++) {
          const c = corners[i];
          if (i === 0) ctx.moveTo(c.x, c.y);
          else ctx.lineTo(c.x, c.y);
        }
        ctx.closePath();
        const checker = (q + r) % 2;
        ctx.fillStyle = checker ? '#141a24' : '#101620';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#232a38';
        ctx.stroke();

        // Coordinate label (debug / learning aid).
        ctx.fillStyle = '#2f3a4a';
        ctx.font = '9px ui-monospace, Consolas, monospace';
        ctx.fillText(`${q},${r}`, x - 10, y - HEX_SIZE * H_SQUASH + 12);
      }
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

    const now = performance.now();
    // Track self's actually-drawn pixel so the destination arrow starts from
    // the marker (not from the tile centre of a cell the marker is only
    // halfway into). Filled in during the entity loop below.
    let selfDrawnPx = null;
    // Entities. Dead entities render as a faded tombstone so a wiped ally still
    // leaves a marker on the map (otherwise it looks like the piece vanished).
    for (const e of state.entities) {
      const dead = e.life <= 0;
      const target = tilePx(e.tile.q, e.tile.r);
      let x = target.x, y = target.y;
      // Smooth-slide motion between tile changes. We key on peer id and the
      // whole-tile target so arrival-after-arrival still triggers a new tween.
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
        const live = moves.get(key);
        const p = interpAt(live, now);
        x = p.x; y = p.y;
      }
      if (e.isSelf) selfDrawnPx = { x, y };
      const color = ALLIANCE_COLOR[e.alliance] || '#ccc';

      ctx.save();
      if (dead) ctx.globalAlpha = 0.35;

      // Shadow + body (iso-ish lozenge).
      ctx.beginPath();
      ctx.ellipse(x, y + 10, 20, 6, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill();

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

      // Health pips.
      const lifeMax = Math.max(1, e.lifeMax || 1);
      const lifePx = x - (lifeMax * 4 - 2);
      for (let i = 0; i < lifeMax; i++) {
        ctx.fillStyle = i < e.life ? '#ffb0b0' : '#2a1a1a';
        ctx.fillRect(lifePx + i * 8, y + 16, 6, 4);
      }

      // Label.
      ctx.fillStyle = '#e8ecf1';
      ctx.font = '11px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(e.name, x, y - 28);

      // Queued-action chip over the player's head during planning. Once
      // committed, keep the letter as-is until the next round — only the
      // colour shifts to orange so the user can still tell at a glance that
      // the action is locked in.
      if (e.isSelf && e.queuedCode) {
        ctx.fillStyle = e.locked ? '#ffb66e' : '#a08eff';
        ctx.font = 'bold 11px ui-monospace, Consolas, monospace';
        ctx.fillText(`[${e.queuedCode}]`, x, y - 40);
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
        const spec = ACTION_ICON[f.action] || ACTION_ICON.EP;
        const k = ease(t);
        const from = tilePx(f.fromQ, f.fromR);
        const to   = tilePx(f.toQ, f.toR);
        const x = from.x + (to.x - from.x) * k;
        // Self-only actions get a stronger vertical lift so they're clearly
        // "rising" rather than drifting sideways.
        const lift = f.upOnly ? 36 * t : 20 * t;
        const y = from.y + (to.y - from.y) * k - lift - 24;
        const alpha = t < 0.75 ? 1 : (1 - (t - 0.75) / 0.25);
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.font = 'bold 18px "Segoe UI Emoji", "Apple Color Emoji", ui-sans-serif, system-ui';
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = spec.color;
        ctx.fillStyle = spec.color;
        ctx.strokeText(spec.glyph, x, y);
        ctx.fillText(spec.glyph, x, y);
        ctx.restore();
      }
      icons.length = liveWriteIdx;
    }
  }

  function origin_() { return origin; }

  window.addEventListener('resize', () => { layout(); render(); });
  layout();

  // Wrap render so every external render-request also wakes the animation
  // loop if any entity is mid-slide.
  const renderPublic = () => { render(); scheduleIfAnimating(); };

  return { render: renderPublic, origin: origin_, tilePx };
}
