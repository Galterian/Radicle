// Player-facing rule text for the basic action cards and map objects.
//
// Single source of truth for the browser deck (main.js renderDeck) — the Godot
// client copies these strings verbatim, so keep them data-only (no DOM, no
// imports). Every string must be understandable without hovering.
//
// The damage matrix below is derived from the authoritative resolver in
// game/peer.mjs (doResolution: `edgeMap`, `mapDef`, `hitDmg`, `blockBack`) and
// data/battle_system.json `resolution_matrix.edges`:
//
//   cycle            A > P > M > B > A
//   Attack  hits its adjacent character target for 1 + edge(A, defender):
//             vs P  → 2        (edge +1)
//             vs EP → 2        (Rule 6: an attacker reads Empty Posture as Posture)
//             vs B  → 0        (edge -1) and the blocker returns 1 to the attacker
//             vs A / M / EM → 1
//   Block   takes nothing from Attack and reflects 1 to each attacker
//           (Ranged Weapon on the attacker cancels the reflect).
//   Posture / Move / EM / EP score no damage of their own; they are the bodies
//           skills ride on and the movement intents (Rule 8).
//   Movement priority on a contested hex: Attack-step 3 > Move 2 > Empty Move 1;
//           ties block everybody.
//   Empty Move walks round(d/2) hexes (min 1) toward the target hex; a Block
//           reads it as Move (Rule 6).
//
// `card` is the always-visible line printed on the hand slot (≤ 70 chars);
// `full` is the tooltip / long form. Icons: ⚔ Attack · 🛡 Block · 👣 Move ·
// 🤺 Posture.

export const ACTION_ICON = { A: '⚔', B: '🛡', M: '👣', P: '🤺', EM: '👣', EP: '🤺' };

export const ACTION_HELP = {
  A: {
    name: 'Attack',
    icon: '⚔',
    card: '⚔ 1 dmg to adjacent target · vs 🤺/EP: 2 · vs 🛡: 0 & take 1 back',
    full: 'Attack — hits your adjacent target for 1 damage. vs Posture or Empty Posture: 2 damage. vs Block: 0 damage and the blocker deals 1 back to you. vs Attack / Move / Empty Move: 1 damage. Aimed at an empty hex instead: step 1 hex (no damage; wins a contested hex over Move and Empty Move). Cycle: A > P > M > B > A.',
  },
  B: {
    name: 'Block',
    icon: '🛡',
    card: '🛡 Attacks on you deal 0 · each attacker takes 1 back · stand still',
    full: 'Block — you stand still. Every Attack aimed at you deals 0 and its attacker takes 1 damage back (an attacker with Ranged Weapon takes none). Beaten by Move in the cycle: A > P > M > B > A.',
  },
  M: {
    name: 'Move',
    icon: '👣',
    card: '👣 Step 1 hex to target · beats 🛡 Block · vs ⚔ Attack: take 1',
    full: 'Move — step 1 hex toward your target. On a contested hex Move loses to an Attack-step and beats an Empty Move; equal claims block everybody. vs Attack: you take 1. Beats Block in the cycle: A > P > M > B > A.',
  },
  P: {
    name: 'Posture',
    icon: '🤺',
    card: '🤺 Hold ground · base for Posture skills · beats 👣 · vs ⚔: take 2',
    full: 'Posture — hold your ground and set up: Posture skills (Intimidation, Taunt, Barricade, Sanctuary…) ride on it. vs Attack: you take 2 (Attack beats Posture). Beats Move in the cycle: A > P > M > B > A.',
  },
  EM: {
    name: 'Empty Move',
    icon: '👣',
    card: '👣 Walk halfway to the hex (min 1) · 🛡 reads it as Move · vs ⚔: take 1',
    full: 'Empty Move — the Empty card played as a journey: walk half the distance (rounded, at least 1 hex) toward the target hex. Weakest claim on a contested hex (loses to Attack-step and Move). vs Attack: you take 1. A Block reads it as Move (Rule 6). Move and Posture skills may ride on it.',
  },
  EP: {
    name: 'Empty Posture',
    icon: '🤺',
    card: '🤺 Do nothing · ⚔ reads it as Posture: take 2 · keeps Sanctuary',
    full: 'Empty Posture — play no action. An attacker reads it as Posture (Rule 6): vs Attack you take 2. Posture and Move skills may still ride on it. Resting in Sanctuary keeps you invincible only while you stay in Empty Posture.',
  },
  BT: {
    name: 'Battle Trance',
    icon: '✦',
    card: '✦ Play two actions this turn · each enemy scored vs your better option',
    full: 'Battle Trance — reveal two action cards (Empty fills a missing one). Against each adjacent enemy the option that nets you the most (dealt − taken) is the one scored; an Attack option hits at most one enemy.',
  },
};

// One-line cycle summary, handy for a hint bar.
export const CYCLE_TEXT = '⚔ Attack > 🤺 Posture > 👣 Move > 🛡 Block > ⚔ Attack · only Attack scores damage, Block returns 1 to each attacker';

// Generic purpose per map-object kind. Used when the catalog entry
// (assets/features/feature_table.json) has no `desc` of its own.
export const KIND_DESC = {
  building:   'A settlement building. Landmark for navigation; a future hold-to-claim point for supplies and refuge.',
  mine:       'A mine. Resource point — holding the hex is meant to yield gold or ore for your side between turns.',
  temple:     'A temple or shrine. Sacred ground — a place to rest, bless permanents and recover between fights.',
  tower:      'A watchtower. Extends the reach of whoever holds it (chess-like 2-3 hex range per building).',
  wall:       'A wall segment. Blocks movement and line of attack; fights happen around it, not through it.',
  scatter:    'Terrain decoration (grass, rock, trees). No effect on play — the hex is walkable as its biome says.',
  bigfeature: 'A large landmark spanning several hexes. Orientation point for the whole region.',
};
KIND_DESC.big_feature = KIND_DESC.bigfeature;   // bigfeature.js reports kind 'big_feature'

// Trim a long rule text to `max` characters on a word boundary with an ellipsis.
export function abbreviate(text, max = 70) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:·—-]+$/, '') + '…';
}
