// Build a 15-20 card MMORPG deck for an entity (mode_mmorpg: min 15 / max 20).
// For the micro-dimension we draw entirely from the four basic actions plus the
// two empties — real skills can be slotted later by reading /data/skills.json.

const BASIC_IDS = ['action_attack', 'action_block', 'action_move', 'action_posture'];

function pickCard(actions, id) {
  const a = actions.find(x => x.id === id);
  return { card_id: `${a.id}#${crypto.randomUUID().slice(0, 6)}`, action_id: a.id, action_name: a.name, code: a.data.code };
}

export function buildDeckForCharacter(entity, actionsByCode) {
  // Weight the deck toward the character's combo codes (Rule 16 — matching cards earn a bonus
  // and letting them appear more often raises the chance to complete it).
  const combo = new Set(entity.combo || []);
  const counts = { A: 5, B: 5, M: 5, P: 5 };
  for (const code of combo) counts[code] = Math.min(7, counts[code] + 2);

  const deck = [];
  for (const code of ['A', 'B', 'M', 'P']) {
    for (let i = 0; i < counts[code]; i++) deck.push(pickCard(Object.values(actionsByCode), code === 'A' ? 'action_attack' : code === 'B' ? 'action_block' : code === 'M' ? 'action_move' : 'action_posture'));
  }
  // Cap to 20 (mode_mmorpg.max_deck)
  while (deck.length > 20) deck.pop();
  shuffle(deck);
  return deck;
}

export function buildDeckForCreature(entity, actions) {
  // Creatures with dice_pattern use that pattern cyclically; others get a brutal
  // melee deck (lots of Attack, some Move, a bit of Posture).
  const deck = [];
  const push = (id) => deck.push(pickCard(actions, id));
  if (entity.dicePattern) {
    for (let i = 0; i < 20; i++) {
      const code = entity.dicePattern[i % entity.dicePattern.length];
      push(code === 'A' ? 'action_attack' : code === 'B' ? 'action_block' : code === 'M' ? 'action_move' : 'action_posture');
    }
  } else {
    for (let i = 0; i < 10; i++) push('action_attack');
    for (let i = 0; i < 6; i++) push('action_move');
    for (let i = 0; i < 3; i++) push('action_posture');
    for (let i = 0; i < 1; i++) push('action_block');
  }
  shuffle(deck);
  return deck;
}

export function drawHandUpTo(entity, n = 5) {
  while (entity.hand.length < n && entity.deck.length) entity.hand.push(entity.deck.shift());
  if (!entity.deck.length && entity.discard.length) {
    // reshuffle discard into deck (Rule 10 draw cycle, simplified)
    entity.deck = entity.discard;
    entity.discard = [];
    shuffle(entity.deck);
  }
  while (entity.hand.length < n && entity.deck.length) entity.hand.push(entity.deck.shift());
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
