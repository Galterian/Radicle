// Pure effect primitives (effect isolation F9e, 2026-11-22: cut out of effects.mjs, which re-exports them): dice,
// point-buy, rounding, trap sums, map features, hand picks, stat bonus tokens, the Rule 24 destroy order. No effect id,
// no definition, no engine switch — shared by the game (effects.mjs, effect-hooks.mjs) and the JS oracle
// (effects-data/oracle/effects-js.mjs), so the oracle can load without importing effects.mjs back.

// How many d6 a point-buy rolls: 6·n nearest the stat, ties to more dice
// (Matter 15 → 12 vs 18 → 3 dice; 8 → 1 die; 9 → 2).
export function diceCount(stat) {
  let best = 1;
  for (let n = 1; n <= 4; n++) if (Math.abs(6 * n - stat) <= Math.abs(6 * best - stat)) best = n;
  return best;
}

// Deterministic dice: every peer derives the same roll from the reveal salt.
export function rollDice(seed, n, sha256Hex) {
  const hex = sha256Hex(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push((parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 6) + 1);
  return out;
}

// Rule 20 point-buy: roll, sum must stay ≤ stat; keep the highest die. A failed
// roll means "repeat next action as a contiguous action" — the cast retries.
export function pointBuy(stat, seed, sha256Hex) {
  if (stat < 1) return { fail: false, dice: [], value: 0 };
  const dice = rollDice(seed, diceCount(stat), sha256Hex);
  const sum = dice.reduce((s, d) => s + d, 0);
  return sum > stat ? { fail: true, dice, value: 0 } : { fail: false, dice, value: Math.max(...dice) };
}

// Rule 12 permanents: "you may repeat the roll if unhappy" — re-roll until the
// sum fits, so placing a permanent token never fails.
export function pointBuyPermanent(stat, seed, sha256Hex) {
  for (let i = 0; i < 32; i++) { const pb = pointBuy(stat, `${seed}#${i}`, sha256Hex); if (!pb.fail) return pb.value; }
  return 1;
}

// general_ux_channeling: a channel permanent's power is the SMALLEST die of its placement roll.
export function pointBuyPermanentMin(stat, seed, sha256Hex) {
  for (let i = 0; i < 32; i++) { const pb = pointBuy(stat, `${seed}#${i}`, sha256Hex); if (!pb.fail) return pb.dice.length ? Math.min(...pb.dice) : 1; }
  return 1;
}

export const roundHalfUp10 = (sum) => Math.round(sum / 10);

export const TRAP_POWER = 20;
// Map features (general_ux_token_generated, minimal model): a building / artefact is a bonus tile
// token that carries an `item` name — whoever stands on it gets the element's stat bonus.
export const FEATURES = [
  { item: 'Sacred Land', elem: 'elem_souls', value: 6 }, { item: 'Sphere of Fire', elem: 'elem_fire', value: 5 },
  { item: 'Fountain of Vitality', elem: 'elem_vitality', value: 5 }, { item: 'Standing Stones', elem: 'elem_earth', value: 5 },
  { item: 'Wind Shrine', elem: 'elem_air', value: 5 }, { item: 'Clock Tower', elem: 'elem_time', value: 4 },
  { item: 'Rift', elem: 'elem_space', value: 4 }, { item: 'Monastery', elem: 'elem_concentration', value: 5 },
  { item: 'Choir', elem: 'elem_harmony', value: 5 }, { item: 'Spring', elem: 'elem_water', value: 5 },
];
export const ALL_ELEMS = ['elem_vitality', 'elem_souls', 'elem_time', 'elem_space', 'elem_air', 'elem_water', 'elem_earth', 'elem_fire', 'elem_concentration', 'elem_harmony'];
export const trapDamageSum = (elements, statOfVictim, shielded = () => false) =>
  elements.reduce((s, el) => s + (shielded(el) ? 0 : Math.max(0, TRAP_POWER - statOfVictim(el))), 0);

// Hand classes (user rework 2026-11-14: Witch, Priest; reused by anything that makes a unit drop hand cards).
// Deterministic picks from a reveal salt so every peer agrees on WHO; the victim alone knows its hand, so it
// alone applies WHICH cards — still deterministic: card ids sorted, index = sha(seed:k) mod what is left.
export const pickBySalt = (seed, list, sha256Hex) => list.length ? list[parseInt(sha256Hex(seed).slice(0, 8), 16) % list.length] : null;
export function pickHandDiscards(seed, cardIds, n, sha256Hex) {
  const pool = [...cardIds].map(String).sort(), out = [];
  for (let k = 0; k < n && pool.length; k++) out.push(pool.splice(parseInt(sha256Hex(`${seed}:${k}`).slice(0, 8), 16) % pool.length, 1)[0]);
  return out;
}

// Character stat bonus tokens (general_ux_tokens; Artifice, Mutate, a broken Fortress — user ruling 2026-11-14):
// one POSITIVE token per element in a unit's holding — a new one replaces a smaller one of that element, else
// it is dropped (penalties always stack). Pure: → { tokens (new list), placed, replaced (old token | null) }.
export function placeStatBonusToken(tokens, tok) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (!(tok?.value > 0)) return { tokens: [...list, tok], placed: true, replaced: null };
  const same = list.find(x => x.value > 0 && x.elem === tok.elem);
  if (same && same.value >= tok.value) return { tokens: list, placed: false, replaced: null, kept: same };
  return { tokens: [...list.filter(x => x !== same), tok], placed: true, replaced: same || null };
}
// Rule 24 destroy target order (user ruling 2026-11-14): an emission of a stat against an adjacent enemy takes
// 1) its permanents, 2) its character stat bonus tokens (Artifice, Fortress …), 3) the bonus tile tokens under
// it. Stable inside a class (the caller lists them in a deterministic order).
export const RULE24_KIND_RANK = { perm: 0, stat: 1, tile: 2 };
export const rule24Order = (cands) => cands.map((c, i) => [c, i])
  .sort((a, b) => (RULE24_KIND_RANK[a[0].kind] ?? 9) - (RULE24_KIND_RANK[b[0].kind] ?? 9) || a[1] - b[1]).map(x => x[0]);

// Bonus tile token element choice (paper text, user request 2026-11-17 — Fossilization "may put an Earth OR Vitality
// permanent bonus token on your tile"): `choice` = the effect's flag tileTokenChoice. The cast's `elem` (a stat-pill
// click, like Artifice) picks one of the listed elements; otherwise the one my stat is higher in (tie: the first).
export function pickTileTokenElem(choice, cast, el, myStat) {
  if (!Array.isArray(choice) || !choice.includes(el)) return el;
  if (choice.includes(cast?.elem)) return cast.elem;
  return choice.reduce((best, e) => (myStat(e) > myStat(best) ? e : best), choice[0]);
}
