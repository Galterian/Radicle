// Entity factories. Hero/ally stats pulled from characters.json; enemies from
// creatures.json. Life = round_half_up(Σstats/10) per battle_system_core.resolution_math,
// which lands at 4 for every paper character.

function roundHalfUp(x) { return Math.floor(x + 0.5); }

export function makeFromCharacter(ch, { peerId, name, alliance, tile }) {
  const d = ch.data;
  const sumStats = d.stats.vitality + d.stats.world + d.stats.matter + d.stats.will;
  return {
    kind: 'character',
    peerId, name, alliance, tile,
    sourceId: ch.id,
    sourceName: ch.name,
    adeptElement: d.adept_element,
    combo: d.combo,
    comboProgress: 0,
    stats: { ...d.stats },
    lifeMax: Math.max(1, roundHalfUp(sumStats / 10)),
    life: Math.max(1, roundHalfUp(sumStats / 10)),
    actionsPerRound: d.actions_per_round ?? 3,
    hand: [],
    deck: [],
    discard: [],
    queued: [],      // slot indices committed this round
    locked: false,
    willDiscard: new Set(),
    target: null,    // {q,r} or peerId
  };
}

export function makeFromCreature(cr, { peerId, name, alliance, tile }) {
  const d = cr.data;
  const sumStats = d.stats.vitality + d.stats.world + d.stats.matter + d.stats.will;
  return {
    kind: 'creature',
    peerId, name, alliance, tile,
    sourceId: cr.id,
    sourceName: cr.name,
    stats: { ...d.stats },
    innateEffect: d.innate_effect,
    dicePattern: d.dice_pattern,
    onActionRider: d.on_action_rider,
    lifeMax: d.life ?? roundHalfUp(sumStats / 10),
    life: d.life ?? roundHalfUp(sumStats / 10),
    actionsPerRound: d.actions_per_round ?? 2,
    hand: [],
    deck: [],
    discard: [],
    queued: [],
    locked: false,
    willDiscard: new Set(),
    target: null,
  };
}

export const isAlive = (e) => e.life > 0;
