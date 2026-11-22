// The JS reference of the built-in natural permanents' kinds — TEST ORACLE (effect isolation F9e, 2026-11-22).
// Moved verbatim from game/natural-perms.mjs: the game reads each definition's flag `naturalKind` (effects.mjs installs
// the lookup); tools/effect-standing-check.mjs holds those flags equal to this table. Lives in chaosD6-Effects.
export const NATURAL_KINDS = {
  effect_earthquake: 'turn_tick',      // end of every engine turn: Earthquake's delta damage to every enemy in contact
  effect_creation: 'ward',             // enemies with Matter < mine cannot enter my adjacent hexes
  effect_spirit_link: 'link',          // linked to the nearest allied creature (alone: nothing)
  effect_love: 'spare_holder',         // an enemy that came in contact cannot damage me until it visits its tower
  effect_awe: 'spare_holder',
  effect_fear: 'no_damage',            // … cannot damage anyone until it visits its tower
  effect_anger: 'only_holder',         // … in contact with me may only attack / damage me (forced target)
  effect_domination: 'lose_action',    // an enemy in contact loses one action per turn (Delay Time model)
  effect_petrify: 'stone',             // an enemy in contact is locked for the rest of the turn, each turn
  effect_mists: 'no_attack',           // adjacent enemies cannot Attack while in contact
};
