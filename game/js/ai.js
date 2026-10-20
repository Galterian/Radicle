// Weighted-priority NPC AI per chaosD6_PC_game_phase2.txt.
// Three regimes: HEALTH_CRITICAL, PROXIMITY_CLOSE, PROXIMITY_FAR.

import { hexDistance } from './hex.js';
import { isAlive } from './entities.js';

const WEIGHTS = {
  HEALTH_CRITICAL: { B: 0.60, M_AWAY: 0.30, A: 0.10 },
  PROXIMITY_CLOSE: { A: 0.50, P: 0.30, M: 0.20 },
  PROXIMITY_FAR:   { M: 0.70, P: 0.30, A: 0.0  },
};

function sampleWeighted(dist) {
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [k, w] of Object.entries(dist)) {
    r -= w;
    if (r <= 0) return k;
  }
  return Object.keys(dist)[0];
}

export function planForNPC(npc, allEntities) {
  const enemies = allEntities.filter(e => isAlive(e) && e.alliance !== npc.alliance);
  if (enemies.length === 0) return { intents: [], target: null };

  enemies.sort((a, b) => hexDistance(npc.tile, a.tile) - hexDistance(npc.tile, b.tile));
  const nearest = enemies[0];
  const d = hexDistance(npc.tile, nearest.tile);

  let regime;
  if (npc.life <= 1 && npc.lifeMax > 1) regime = 'HEALTH_CRITICAL';
  else if (d <= 1) regime = 'PROXIMITY_CLOSE';
  else regime = 'PROXIMITY_FAR';

  const intentCode = sampleWeighted(WEIGHTS[regime]);

  // Pick a hand card matching the intent code, else fall back to Empty Posture.
  const slotForCode = (code) => npc.hand.findIndex(c => c && c.code === code);
  let slot;
  let actionCode = intentCode;
  let target = nearest;

  switch (intentCode) {
    case 'A': slot = slotForCode('A'); if (slot < 0) { actionCode = 'EP'; slot = -1; } break;
    case 'B': slot = slotForCode('B'); if (slot < 0) { actionCode = 'EP'; slot = -1; } break;
    case 'P': slot = slotForCode('P'); if (slot < 0) { actionCode = 'EP'; slot = -1; } break;
    case 'M':
    case 'M_AWAY':
      slot = slotForCode('M');
      if (slot < 0) { actionCode = 'EM'; slot = -1; }
      break;
    default: slot = -1;
  }

  const queued = slot >= 0 ? [slot] : [];
  const flagEmptyMoveAway = intentCode === 'M_AWAY';
  return {
    queuedSlots: queued,
    actionCode,
    target: target.peerId,
    emptyMoveAway: flagEmptyMoveAway,
    regime,
  };
}
