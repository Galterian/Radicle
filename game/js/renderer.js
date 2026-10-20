// 2D isometric hex renderer. Flat-top hexes with vertical squash for the iso feel.
import { hexToPixel, hexCorners, HEX_SIZE, H_SQUASH } from './hex.js';

const ALLIANCE_COLOR = {
  'player':  '#6ad9ff',
  'npc_a':   '#6ad99f',
  'npc_b':   '#e36666',
};

export function createRenderer(canvas, state) {
  const ctx = canvas.getContext('2d');

  // Origin in canvas space so the 5x5 grid sits centred.
  const origin = { x: 0, y: 0 };

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

    // Entities.
    for (const e of state.entities) {
      if (e.life <= 0) continue;
      const { x, y } = tilePx(e.tile.q, e.tile.r);
      const color = ALLIANCE_COLOR[e.alliance] || '#ccc';

      // Shadow + body (iso-ish lozenge).
      ctx.beginPath();
      ctx.ellipse(x, y + 10, 20, 6, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x, y - 6, 16, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0b0d12';
      ctx.stroke();

      // Health pips.
      const lifePx = x - (e.lifeMax * 4 - 2);
      for (let i = 0; i < e.lifeMax; i++) {
        ctx.fillStyle = i < e.life ? '#ffb0b0' : '#2a1a1a';
        ctx.fillRect(lifePx + i * 8, y + 16, 6, 4);
      }

      // Label.
      ctx.fillStyle = '#e8ecf1';
      ctx.font = '11px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(e.name, x, y - 28);

      // Queued-action chevron over head (only visible for the player while planning;
      // locked actions show it face-down).
      if (e.alliance === 'player' && e.queued.length) {
        const codes = e.queued.map(i => e.hand[i]?.code || '?').join('·');
        ctx.fillStyle = e.locked ? '#ffb66e' : '#a08eff';
        ctx.font = 'bold 11px ui-monospace, Consolas, monospace';
        ctx.fillText(`[${e.locked ? '◆' : codes}]`, x, y - 40);
      } else if (e.queued.length && e.locked) {
        ctx.fillStyle = '#555';
        ctx.font = 'bold 11px ui-monospace, Consolas, monospace';
        ctx.fillText(`[◆]`, x, y - 40);
      }
    }
  }

  function origin_() { return origin; }

  window.addEventListener('resize', () => { layout(); render(); });
  layout();

  return { render, origin: origin_, tilePx };
}
