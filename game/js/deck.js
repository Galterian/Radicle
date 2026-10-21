// Build a 15-20 card MMORPG deck for an entity (mode_mmorpg: min 15 / max 20).
// For the micro-dimension we draw entirely from the four basic actions plus the
// two empties — real skills can be slotted later by reading /data/skills.json.

const BASIC_IDS = ['action_attack', 'action_block', 'action_move', 'action_posture'];

function pickCard(actions, id) {
  const a = actions.find(x => x.id === id);
  return { card_id: `${a.id}#${crypto.randomUUID().slice(0, 6)}`, action_id: a.id, action_name: a.name, code: a.data.code };
}

// mode_mmorpg: min 15 / max 20. Base is the minimum; combo weighting (Rule 16)
// may bring the total up toward the max.
const DECK_MIN = 15;
const DECK_MAX = 20;

export function buildDeckForCharacter(entity, actionsByCode) {
  // 15-card base (4 A / 4 B / 4 M / 3 P), weighted up to +1 per combo code so
  // matching cards appear more often but we never exceed the 20-card max.
  const combo = new Set(entity.combo || []);
  const counts = { A: 4, B: 4, M: 4, P: 3 };
  for (const code of combo) if (counts[code] !== undefined) counts[code] += 1;

  const deck = [];
  for (const code of ['A', 'B', 'M', 'P']) {
    const actionId = code === 'A' ? 'action_attack' : code === 'B' ? 'action_block' : code === 'M' ? 'action_move' : 'action_posture';
    for (let i = 0; i < counts[code]; i++) deck.push(pickCard(Object.values(actionsByCode), actionId));
  }
  while (deck.length > DECK_MAX) deck.pop();
  // Combo should never shrink us below the min — a safety belt if a future
  // weighting scheme ever subtracts.
  while (deck.length < DECK_MIN) deck.push(pickCard(Object.values(actionsByCode), 'action_posture'));
  shuffle(deck);
  return deck;
}

export function buildDeckForCreature(entity, actions) {
  // Creatures with dice_pattern use that pattern cyclically; others get a brutal
  // melee deck (lots of Attack, some Move, a bit of Posture, a token Block).
  const deck = [];
  const push = (id) => deck.push(pickCard(actions, id));
  if (entity.dicePattern) {
    for (let i = 0; i < DECK_MIN; i++) {
      const code = entity.dicePattern[i % entity.dicePattern.length];
      push(code === 'A' ? 'action_attack' : code === 'B' ? 'action_block' : code === 'M' ? 'action_move' : 'action_posture');
    }
  } else {
    // 8 / 4 / 2 / 1 = 15
    for (let i = 0; i < 8; i++) push('action_attack');
    for (let i = 0; i < 4; i++) push('action_move');
    for (let i = 0; i < 2; i++) push('action_posture');
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
