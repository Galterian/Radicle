// Oracles for the 2026-11-14 user rulings on the Fortress building (stat buy), Animator and Seeker.
//   node tools/fortress-check.mjs   → must end "all fortress checks passed"
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { FORTRESS, configureFortress, fortressValue, fortressBonusDice, fortressBonusOf, fortressBankStep, FORTRESS_TOKEN_EFFECT, fortressTokenElem } from '../js/building-bonus.js';
import { animatorConfig, priestConfig, seekerConfig, nearestBuilding, buildSite, copyMade, shrineMade, hexDist, discAround } from '../class-world.mjs';
import { placedBuildingsFrom, setPlacedBuildings, featureAt, setFeatureCatalog, isBuildingFeature } from '../js/features.js';
import { buildingBonusAt, fortressAt, dungeonAt, dungeonExplored } from '../js/building-bonus.js';
import { tileInRing } from '../join-plan.mjs';
import { rollDice, placeStatBonusToken, rule24Order, playableEffects, EFFECT_RULES, TRAP_POWER } from '../effects.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
let fails = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const active = (file, id) => {
  const e = JSON.parse(fs.readFileSync(new URL(`../../data/${file}`, import.meta.url), 'utf8')).entries.find(x => x.id === id);
  const live = e.versions.filter(v => v.status !== 'rejected' && v.status !== 'superseded').sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  return (live[0] || e.versions[0]);
};

// ---- Fortress: data/rules.json rule_building_fortress ↔ js/building-bonus.js defaults ----
const DEFAULTS = { ...FORTRESS };
const fv = active('rules.json', 'rule_building_fortress');
eq('fortress rule is canonical 1.0.0', [fv.status, fv.version], ['canonical', '1.0.0']);
const fd = fv.data.fortress;
eq('data fortress block equals the browser defaults', { stat_min: fd.stat_min, stat_max: fd.stat_max, near: fd.near, per: fd.per, bonus_divisor: fd.bonus_divisor, bonus: fd.bonus }, DEFAULTS);
configureFortress(fd);
eq('configureFortress(data) keeps them', { ...FORTRESS }, DEFAULTS);
// Values 30..60 (the user's range), every hex deterministic.
{
  let lo = Infinity, hi = -Infinity, bad = 0;
  for (let q = -40; q <= 40; q++) for (let r = -40; r <= 40; r++) { const v = fortressValue('0xabc', q, r); if (!Number.isInteger(v) || v < 30 || v > 60) bad++; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  eq('fortress values over 6561 hexes: [min, max, out of range]', [lo, hi, bad], [30, 60, 0]);
  eq('fortress value is deterministic', fortressValue('0xabc', 7, -3), fortressValue('0xabc', 7, -3));
}
// Dice of the break point-buy = round(value / 10), half up.
eq('bonus dice 30/45/44/55/60', [30, 45, 44, 55, 60].map(fortressBonusDice), [3, 5, 4, 6, 6]);
eq('data bonus mode is the highest die (user ruling 2026-11-14 #2)', fd.bonus, 'max');
eq('bonus = highest die', fortressBonusOf([3, 4, 5]), 5);
eq('bonus = highest die of 6', fortressBonusOf([2, 6, 1, 6, 3, 4]), 6);
eq('bonus of no dice', fortressBonusOf([]), 0);
eq('break dice are deterministic from the salt', rollDice('salt:fortress:bld:1,2:9', 5, sha), rollDice('salt:fortress:bld:1,2:9', 5, sha));
eq('break dice count', rollDice('salt:fortress:bld:1,2:9', fortressBonusDice(47), sha).length, 5);
// Stat buy: bank my stat once per action until it reaches the value.
{
  const fz = { id: 'bld:1,2', value: 40 };
  const s1 = fortressBankStep(null, fz, 15, 3, 9);
  eq('first emission banks 15', s1, { ok: true, bank: 15, broken: false });
  const rec = { id: fz.id, bank: 15, turn: 3, action: 9 };
  eq('second emission in the same action is refused', fortressBankStep(rec, fz, 15, 3, 9).ok, false);
  const s2 = fortressBankStep(rec, fz, 15, 3, 10);
  eq('next action banks 30', s2, { ok: true, bank: 30, broken: false });
  eq('third emission reaches 40 → broken', fortressBankStep({ ...rec, bank: 30, action: 10 }, fz, 10, 4, 11), { ok: true, bank: 40, broken: true });
  eq('a bank against another fortress does not count', fortressBankStep({ id: 'bld:9,9', bank: 35, turn: 3, action: 9 }, fz, 12, 3, 9), { ok: true, bank: 12, broken: false });
  configureFortress({ per: 'turn' });
  eq('per turn: a later action of the same turn is refused', fortressBankStep(rec, fz, 15, 3, 10).ok, false);
  eq('per turn: the next turn banks', fortressBankStep(rec, fz, 15, 4, 12), { ok: true, bank: 30, broken: false });
  configureFortress({ bonus: 'sum' });
  eq('bonus sum mode (not the ruling, still configurable)', fortressBonusOf([3, 4, 5]), 12);
  configureFortress(fd);
  eq('restored', { ...FORTRESS }, DEFAULTS);
}
// The bonus is a character stat bonus TOKEN like Artifice's (user ruling 2026-11-14 #2): effect id, element of the
// stat, one positive token per element — it replaces an earlier one only if higher.
{
  const elems = JSON.parse(fs.readFileSync(new URL('../../data/elements.json', import.meta.url), 'utf8')).entries;
  const E2S = {};
  for (const e of elems) { const v = active('elements.json', e.id); E2S[e.id] = String(v.data?.stat || '').replace(/^stat_/, ''); }
  eq('token element per stat (first sorted element of the stat)', ['vitality', 'world', 'matter', 'will'].map(s => fortressTokenElem(s, E2S)), ['elem_vitality', 'elem_souls', 'elem_air', 'elem_concentration']);
  eq('every token element maps back to its stat', ['vitality', 'world', 'matter', 'will'].every(s => E2S[fortressTokenElem(s, E2S)] === s), true);
  eq('no element for an unknown stat', fortressTokenElem('luck', E2S), null);
  eq('token effect id', FORTRESS_TOKEN_EFFECT, 'rule_building_fortress');
  const fzTok = (v, id = 'a#9#fz0') => ({ id, stat: 'will', elem: 'elem_concentration', value: v, effect_id: FORTRESS_TOKEN_EFFECT });
  const p1 = placeStatBonusToken([], fzTok(4));
  eq('first fortress token placed', [p1.placed, p1.tokens.map(t => t.value)], [true, [4]]);
  const p2 = placeStatBonusToken(p1.tokens, fzTok(3, 'a#12#fz1'));
  eq('lower one is dropped, the old stays', [p2.placed, p2.kept?.value, p2.tokens.map(t => t.value)], [false, 4, [4]]);
  const p3 = placeStatBonusToken(p1.tokens, fzTok(6, 'a#12#fz1'));
  eq('higher one replaces', [p3.placed, p3.replaced?.value, p3.tokens.map(t => [t.id, t.value])], [true, 4, [['a#12#fz1', 6]]]);
  eq('equal one is dropped', placeStatBonusToken(p1.tokens, fzTok(4, 'x')).placed, false);
  const art = { id: 'a#3#0', stat: 'matter', elem: 'elem_earth', value: 5, effect_id: 'effect_artifice' };
  const p4 = placeStatBonusToken([art], { ...fzTok(2), stat: 'matter', elem: 'elem_air' });
  eq('a fortress Matter token (Air) stacks with an Artifice Matter token (Earth)', p4.tokens.map(t => [t.elem, t.value]), [['elem_earth', 5], ['elem_air', 2]]);
  eq('Artifice keeps its own rule: same element, bigger replaces', placeStatBonusToken([art], { ...art, id: 'b', value: 6 }).tokens.map(t => t.value), [6]);
  eq('penalties always stack', placeStatBonusToken([{ ...art, value: -2 }], { ...art, id: 'c', value: -3 }).tokens.map(t => t.value), [-2, -3]);
}
// Rule 24 destroy order (user ruling 2026-11-14): 1 permanents, 2 character stat bonus tokens (Artifice / Fortress), 3 tile tokens.
{
  const c = [
    { kind: 'tile', id: 't1' }, { kind: 'stat', id: 'a#3#0' }, { kind: 'perm', id: 'effect_haste' },
    { kind: 'stat', id: 'a#9#fz0' }, { kind: 'tile', id: 't0' }, { kind: 'perm', id: 'effect_oblivion' },
  ];
  eq('order: perms, then stat tokens, then tile tokens (stable inside a class)', rule24Order(c).map(x => x.id), ['effect_haste', 'effect_oblivion', 'a#3#0', 'a#9#fz0', 't1', 't0']);
  eq('no perm → the fortress / Artifice token is taken before the tile token', rule24Order([{ kind: 'tile', id: 't' }, { kind: 'stat', id: 'fz' }])[0].id, 'fz');
  eq('only a tile token → it is the target', rule24Order([{ kind: 'tile', id: 't' }])[0].id, 't');
  eq('input not mutated', c[0].id, 't1');
  eq('deterministic', rule24Order(c), rule24Order([...c]));
}

// ---- Animator / Priest (classes.json class_animator 1.1.0, class_priest 1.1.0 — user rulings 2026-11-14 #2) ----
const av = active('classes.json', 'class_animator');
eq('animator canonical 1.1.0, near 2, copy rises next to me', [av.version, animatorConfig(av.data).near, animatorConfig(av.data).place], ['1.1.0', 2, 1]);
eq('animator defaults', animatorConfig({}), { near: 2, place: 1 });
const pv = active('classes.json', 'class_priest');
eq('priest canonical 1.1.0, once per turn, Shrine (mend) within 2', [pv.version, pv.data.ability_kind, priestConfig(pv.data)], ['1.1.0', 'once_per_round', { place: 2, label: 'Shrine', power: 'mend' }]);
eq('priest has no forced discard / passive left', [pv.data.hand_discard ?? null, pv.data.passive ?? null], [null, null]);
eq('priest defaults', priestConfig({}), { place: 2, label: 'Shrine', power: 'mend' });
{
  const here = { q: 0, r: 0 };
  const blds = [{ q: 2, r: 0 }, { q: 0, r: 2 }, { q: 1, r: -1 }, { q: 5, r: 0 }, { q: -1, r: 0 }];
  eq('nearest building within 2 (distance, then q, r)', nearestBuilding(blds, here, 2), { q: -1, r: 0 });
  eq('tie on distance → lower q first', nearestBuilding(blds.filter(b => !(b.q === -1)), here, 2), { q: 1, r: -1 });
  eq('the building under me counts (distance 0)', nearestBuilding([...blds, { q: 0, r: 0 }], here, 2), { q: 0, r: 0 });
  eq('no building within 2 → null (ability stays ready)', nearestBuilding([{ q: 5, r: 0 }], here, 2), null);
  const free = () => true;
  eq('site: picked neighbour is used', buildSite({ here, range: 1, picked: { q: 0, r: 1 }, okTile: free, salt: 's', sha }), { dest: { q: 0, r: 1 }, random: false });
  const s2 = buildSite({ here, range: 1, picked: { q: 2, r: 0 }, okTile: free, salt: 's', sha });
  eq('site: picked too far → random neighbour', [s2.random, hexDist(here, s2.dest)], [true, 1]);
  eq('site: my own hex is never used', buildSite({ here, range: 1, picked: { q: 0, r: 0 }, okTile: free, salt: 's', sha }).random, true);
  { let ok = true; for (let i = 0; i < 50; i++) { const d = hexDist(here, buildSite({ here, range: 2, picked: null, okTile: free, salt: `p${i}`, sha }).dest); if (d < 1 || d > 2) ok = false; } eq('site: 50 random Priest sites all 1..2 hexes away', ok, true); }
  eq('site: deterministic by salt', buildSite({ here, range: 2, picked: null, okTile: free, salt: 'x', sha }), buildSite({ here, range: 2, picked: null, okTile: free, salt: 'x', sha }));
  eq('site: occupied hexes skipped', buildSite({ here, range: 1, picked: null, okTile: (t) => t.q === -1 && t.r === 1, salt: 'y', sha }).dest, { q: -1, r: 1 });
  eq('site: picked but not free → random', buildSite({ here, range: 1, picked: { q: 1, r: 0 }, okTile: (t, isPick) => !isPick, salt: 's', sha }).random, true);
  eq('site: nothing free → null (ability stays ready)', buildSite({ here, range: 2, picked: null, okTile: () => false, salt: 's', sha }), null);
  // The made records and the features.js overlay (what every peer and the HUD read).
  const src = { label: 'Magic Well', path: 'a/b.png', desc: 'd', biome: 'plains', theme: 'skill' };
  eq('copy points at its source hex', copyMade(src, 3, -1, 'class_animator').copy_of, { q: 3, r: -1 });
  eq('copy of a copy points at the first source', copyMade({ ...src, copy_of: { q: 9, r: 9 } }, 3, -1, 'class_animator').copy_of, { q: 9, r: 9 });
  const shrine = shrineMade(priestConfig({}), { path: 'x/shrine.png' }, 'class_priest');
  eq('shrine: label, sprite, mend only', [shrine.label, shrine.path, shrine.bonus], ['Shrine', 'x/shrine.png', { power: { kind: 'mend' } }]);
  const units = [
    { peer_id: 'B', world_edits_json: JSON.stringify([{ id: 'made:4,4', q: 4, r: 4, made: shrine, at: 7 }, { id: 'made:1,1', q: 1, r: 1, made: shrine, at: 9 }]) },
    { peer_id: 'A', world_edits_json: JSON.stringify([{ id: 'made:4,4', q: 4, r: 4, made: src, at: 7 }, { id: 'wtrap:0,0', gone: true }, { id: 'made:2,2', q: 3, r: 3, made: src, at: 1 }]) },
  ];
  const placed = placedBuildingsFrom(units);
  eq('placed: one per hex (earliest, then creator id), bad ids ignored', placed.map(b => `${b.q},${b.r}:${b.by}:${b.label}`), ['1,1:B:Shrine', '4,4:A:Magic Well']);
  setPlacedBuildings(placedBuildingsFrom([{ peer_id: 'B', world_edits_json: JSON.stringify([{ id: 'made:4,4', q: 4, r: 4, made: shrine, at: 7 }]) }]));
  eq('featureAt answers the placed Shrine', [featureAt('0xabc', 4, 4)?.label, featureAt('0xabc', 4, 4)?.placed], ['Shrine', true]);
  eq('buildingBonusAt: the Shrine mends (+1 life at the end of the turn), no stat', buildingBonusAt('0xabc', 4, 4)?.bonus, { power: { kind: 'mend' } });
  setPlacedBuildings([{ ...src, q: 0, r: 0 }, { ...copyMade(src, 0, 0, 'class_animator'), q: 7, r: 3 }]);
  eq('buildingBonusAt: the copy has the same bonus as its source', JSON.stringify(buildingBonusAt('0xabc', 7, 3)?.bonus), JSON.stringify(buildingBonusAt('0xabc', 0, 0)?.bonus));
  eq('the overlay notifies only on change', setPlacedBuildings([{ ...src, q: 0, r: 0 }, { ...copyMade(src, 0, 0, 'class_animator'), q: 7, r: 3 }]), false);
  setPlacedBuildings([]);
  eq('overlay cleared → nothing there', featureAt('0xabc', 4, 4), null);
}
{
  const here = { q: 0, r: 0 };
  const trap = { q: 1, r: 0 };
  // buildSite as the old destination picker (range 2, any free hex but mine): the generic cases still hold.
  const animatorDestination = ({ here, near, picked, okTile, salt, sha }) => buildSite({ here, range: near, picked: picked && picked.q === trap.q && picked.r === trap.r ? null : picked, okTile: (t, p) => !(t.q === trap.q && t.r === trap.r) && okTile(t, p), salt, sha });
  const free = () => true;
  eq('picked tile is used', animatorDestination({ here, near: 2, trap, picked: { q: -1, r: 2 }, okTile: free, salt: 's', sha }), { dest: { q: -1, r: 2 }, random: false });
  const far = animatorDestination({ here, near: 2, trap, picked: { q: 3, r: 0 }, okTile: free, salt: 's', sha });
  eq('picked too far → random within 2, not the trap hex', [far.random, hexDist(here, far.dest) <= 2, !(far.dest.q === trap.q && far.dest.r === trap.r)], [true, true, true]);
  eq('picked = the trap hex → random', animatorDestination({ here, near: 2, trap, picked: { q: 1, r: 0 }, okTile: free, salt: 's', sha }).random, true);
  eq('no pick → random, deterministic', animatorDestination({ here, near: 2, trap, picked: null, okTile: free, salt: 'x', sha }), animatorDestination({ here, near: 2, trap, picked: null, okTile: free, salt: 'x', sha }));
  eq('occupied tiles are skipped', (() => { const occ = new Set(discAround(here, 2).filter(t => !(t.q === -2 && t.r === 1)).map(t => `${t.q},${t.r}`)); return animatorDestination({ here, near: 2, trap, picked: null, okTile: (t) => !occ.has(`${t.q},${t.r}`), salt: 'y', sha })?.dest; })(), { q: -2, r: 1 });
  eq('nothing free → null', animatorDestination({ here, near: 2, trap, picked: null, okTile: () => false, salt: 's', sha }), null);
  eq('a picked occupied tile is refused (okTile false) → random', animatorDestination({ here, near: 2, trap, picked: { q: 0, r: 1 }, okTile: (t, isPick) => !(isPick && t.q === 0 && t.r === 1), salt: 's', sha }).random, true);
  eq('disc of radius 2 has 19 hexes', discAround(here, 2).length, 19);
}

// ---- Seeker (classes.json class_seeker 1.1.0) ----
const sv = active('classes.json', 'class_seeker');
const sc = seekerConfig(sv.data);
eq('seeker canonical 1.1.0, distance 20..30, vision 5, until end of next turn', [sv.version, sc.min, sc.max, sc.radius, sc.turns], ['1.1.0', 20, 30, 5, 1]);
eq('seeker defaults', seekerConfig({}), { min: 20, max: 30, radius: 5, turns: 1 });
{
  const anchor = { q: 3, r: -4 };
  let bad = 0;
  for (let i = 0; i < 40; i++) { const t = tileInRing(anchor, { min: sc.min, max: sc.max, seed: '0xabc', salt: `salt${i}:seeker:7`, isBlocked: () => false }); const d = t ? hexDist(anchor, t) : -1; if (d < 20 || d > 30) bad++; }
  eq('40 seeker spots all 20..30 hexes away', bad, 0);
  const a = tileInRing(anchor, { min: 20, max: 30, seed: '0xabc', salt: 'k:seeker:7', isBlocked: () => false });
  eq('seeker spot is deterministic', tileInRing(anchor, { min: 20, max: 30, seed: '0xabc', salt: 'k:seeker:7', isBlocked: () => false }), a);
  const b = tileInRing(anchor, { min: 20, max: 30, seed: '0xabc', salt: 'k:seeker:7', isBlocked: () => false, occupied: new Set([`${a.q},${a.r}`]) });
  eq('an occupied spot is skipped', !!b && !(b.q === a.q && b.r === a.r) && hexDist(anchor, b) >= 20, true);
  eq('everything blocked → null', tileInRing(anchor, { min: 20, max: 30, seed: '0xabc', salt: 'k', isBlocked: () => true }), null);
}

// ---- The whole Fortress path on the REAL peer.mjs code (2026-11-15): the resolver's fortressStatBuy, statOf,
// Rule 24 candidatesOf and the peer's applyFortressOutcomes are cut out of peer.mjs by anchor and run on a stub
// world — bank → break → point-buy → token → my stat → snapshot round-trip → later actions / turns → Rule 24.
{
  const src = fs.readFileSync(new URL('../peer.mjs', import.meta.url), 'utf8');
  const cut = (start, end) => { const i = src.indexOf(start); if (i < 0) throw new Error(`peer.mjs anchor missing: ${start}`); const j = src.indexOf(end, i); if (j < 0) throw new Error(`peer.mjs end missing after: ${start}`); return src.slice(i, j + end.length); };
  const statOfSrc = cut('const statOf = (id, sk) => {', '\n  };');
  const bankInSrc = cut('const fortressBankIn = (id) =>', '\n');
  const buySrc = cut('const fortressStatBuy = (r, stat) => {', '\n  };');
  const applySrc = cut('function applyFortressOutcomes(outcomes) {', '\n}\n');
  const candSrc = cut('const candidatesOf = (e) => {', '\n    };');
  const endRoundSrc = cut('async function endRound() {', '\n}\n');
  const worldGoneSrc = cut('const worldGone = (id, why) =>', '\n');
  const elems = JSON.parse(fs.readFileSync(new URL('../../data/elements.json', import.meta.url), 'utf8')).entries;
  const ELEM_TO_STAT = {};
  for (const e of elems) ELEM_TO_STAT[e.id] = String(active('elements.json', e.id).data?.stat || '').replace(/^stat_/, '');
  const hexDistance = (a, b) => (Math.abs(a.tile_q - b.tile_q) + Math.abs(a.tile_r - b.tile_r) + Math.abs(a.tile_q + a.tile_r - b.tile_q - b.tile_r)) / 2;
  const ME = 'peer:me-00000001', FOE = 'peer:foe-0000002';
  const SEED = '0xabc';
  // A fortress raised on (3,0) through the features.js overlay (themed → power fortress, value / stat from its hex).
  setPlacedBuildings([{ label: 'Fortress', path: 'x/fortress.png', theme: 'fortress', q: 3, r: 0 }]);
  const fz0 = fortressAt(SEED, 3, 0);
  eq('peer path: a themed fortress stands on (3,0), value 30..60', !!fz0 && fz0.value >= 30 && fz0.value <= 60, true);
  const S = fz0.stat;
  const entity = { statTokens: [], fortressBank: null, worldEdits: [], permanents: new Set() };
  const hg = { turn: 4, round: 0, action: 12 };
  const view = new Map();
  const base = { vitality: 12, world: 12, matter: 12, will: 12, [S]: 20 };
  const snapOf = (id, tile, extra = {}) => ({ peer_id: id, tile_q: tile.q, tile_r: tile.r, ...Object.fromEntries(Object.entries(base).map(([k, v]) => [`stat_${k}`, v])), stat_tokens_json: '[]', tile_tokens_json: '[]', world_edits_json: '[]', fortress_bank_json: 'null', permanents_csv: '', perm_power_json: '{}', ...extra });
  // My snapshot as currentStateSnapshot() writes it (strings only), re-parsed the way gossip delivers it.
  const publish = () => view.set(ME, JSON.parse(JSON.stringify({ ...view.get(ME), stat_tokens_json: JSON.stringify(entity.statTokens), fortress_bank_json: JSON.stringify(entity.fortressBank || null), world_edits_json: JSON.stringify(entity.worldEdits || []), permanents_csv: [...entity.permanents].sort().join(',') })));
  view.set(ME, snapOf(ME, { q: 2, r: 0 }));
  view.set(FOE, snapOf(FOE, { q: 1, r: 0 }));
  const gone = () => { const m = new Map(); for (const v of view.values()) for (const e of JSON.parse(v.world_edits_json || '[]')) m.set(e.id, e); return m; };
  const quiet = { log() {}, warn() {} };
  const notices = [];
  const build = new Function('deps', `
    const { MAP_SEED, view, worldEditsNow, FORTRESS, PEER_ID_STRING, PEER_LABEL, hg, entity, destroyOutcomes, hexDistance, buildingBonusAt, fortressAt,
      fortressBankStep, rollDice, sha256Hex, fortressBonusDice, fortressBonusOf, fortressTokenElem, ELEM_TO_STAT, placeStatBonusToken,
      FORTRESS_TOKEN_EFFECT, liveWorldEdits, rule24Order, permStats, permPowerOf, console, broadcastUI, handMsg } = deps;
    const _autosave = null, log = () => {}, stat = deps.stat;
    const parseJson = (s, dflt) => { try { const v = JSON.parse(s || ''); return Array.isArray(v) ? v : dflt; } catch { return dflt; } };
    const statRaw = (v, sk) => Math.max(0, v?.['stat_' + sk] ?? 0);
    const linkedStat = () => 0;
    const statTokensOfRaw = (id) => parseJson(view.get(id)?.stat_tokens_json, []);
    const statTokensOf = statTokensOfRaw;
    const tileTokensAt = () => [];
    const permsOfRaw = (id) => String(view.get(id)?.permanents_csv || '').split(',').filter(Boolean);
    ${statOfSrc}
    ${bankInSrc}
    ${buySrc}
    ${applySrc}
    ${worldGoneSrc}
    ${candSrc}
    return { statOf, fortressStatBuy, applyFortressOutcomes, worldGone, candidatesOf };`);
  const peerAt = (destroyOutcomes, stat = S) => build({
    MAP_SEED: SEED, view, worldEditsNow: gone(), FORTRESS, PEER_ID_STRING: ME, PEER_LABEL: 'me', hg, entity, destroyOutcomes, hexDistance, buildingBonusAt, fortressAt,
    fortressBankStep, rollDice, sha256Hex: sha, fortressBonusDice, fortressBonusOf, fortressTokenElem, ELEM_TO_STAT, placeStatBonusToken, FORTRESS_TOKEN_EFFECT,
    liveWorldEdits: gone, rule24Order, permStats: (pid) => pid === 'effect_test' ? [S] : [], permPowerOf: (id) => JSON.parse(view.get(id)?.perm_power_json || '{}'), console: quiet, stat,
    broadcastUI: (m) => notices.push(m.notice), handMsg: (x) => x,
  });
  // One action of mine: the resolver half (every peer) and my doResolution half (worldGone, then applyFortressOutcomes).
  const act = (emit) => {
    const outs = [];
    const p = peerAt(outs);
    if (emit) p.fortressStatBuy({ actor: ME, salt: `salt${hg.action}`, declared: 'P', destroy: { stat: S, building: '3,0' } }, S);
    for (const d of outs) if ((d.result === 'destroyed' || d.result === 'taken') && d.owner === 'world' && d.actor === ME) p.worldGone(d.id, d.result);
    p.applyFortressOutcomes(outs);
    publish();
    hg.action++; hg.round = (hg.round + 1) % 3; if (hg.round === 0) hg.turn++;
    return outs;
  };
  const need = Math.ceil(fz0.value / 20);
  let last = null, n = 0;
  for (; n < 10 && !(last && last.result === 'destroyed'); n++) last = act(true)[0];
  eq(`peer path: ${need} emissions of ${S} 20 break a ${fz0.value} fortress`, [n, last?.result, last?.bank], [need, 'destroyed', 20 * need]);
  eq('peer path: the fortress is gone for everybody (world edit bld:3,0)', fortressAt(SEED, 3, 0, gone()), null);
  eq('peer path: my bank is cleared', entity.fortressBank, null);
  eq('peer path: point-buy round(value / 10) d6 dice', [last.dice.length, last.dice.every(d => Number.isInteger(d) && d >= 1 && d <= 6)], [fortressBonusDice(fz0.value), true]);
  eq('peer path: the dice are the reveal-salted roll', last.dice, rollDice(`salt${hg.action - 1}:fortress:bld:3,0:${hg.action - 1}`, fortressBonusDice(fz0.value), sha));
  const hi = Math.max(...last.dice);
  const tok = entity.statTokens.find(t => t.effect_id === FORTRESS_TOKEN_EFFECT);
  eq('peer path: ONE character stat token = the HIGHEST die (not the sum, not the dice count)', [entity.statTokens.length, tok?.stat, tok?.elem, tok?.value], [1, S, fortressTokenElem(S, ELEM_TO_STAT), hi]);
  eq('peer path: the outcome carries that bonus', [last.bonus, last.die], [hi, hi]);
  eq('peer path: the player is told the dice and the token (HUD notice)', notices.length === 1 && notices[0].includes(`[${last.dice.join(', ')}]`) && notices[0].includes(`+${hi}`), true);
  eq('peer path: my stat (resolver statOf, from the published snapshot) rises by it', peerAt([]).statOf(ME, S), 20 + hi);
  eq('peer path: the token round-trips through stat_tokens_json', JSON.parse(view.get(ME).stat_tokens_json), entity.statTokens);
  // Permanent: nothing but Rule 24 (or death) takes it — later actions, turn ends, a failed emission.
  const before = JSON.stringify(entity.statTokens);
  for (let k = 0; k < 9; k++) act(k === 4);   // one more emission against the now-broken fortress
  eq('peer path: 9 actions / 3 turn ends later the token still stands', JSON.stringify(entity.statTokens), before);
  eq('peer path: still in my stat', peerAt([]).statOf(ME, S), 20 + hi);
  eq('peer path: endRound never touches stat tokens', /statTokens/.test(endRoundSrc), false);
  const writers = src.split('\n').filter(l => /entity\.statTokens\s*=[^=]/.test(l)).map(l => l.trim());
  eq('peer path: every write of entity.statTokens is init / placeStatBonusToken / a Rule 24 removal by id / the death drop', writers.filter(l => !(/= \[\];/.test(l) || /placeStatBonusToken|pl\.tokens/.test(l) || /filter\(t => t\.id !== d\.id\)/.test(l) || /^if \(fzLost\.length\)/.test(l))), []);
  // Rule 24: the foe next to me emits my token's stat: my permanents first, then this token, then tile tokens.
  entity.permanents.add('effect_test'); publish();
  view.set(ME, { ...view.get(ME), perm_power_json: JSON.stringify({ effect_test: 3 }) });
  const c1 = peerAt([], S).candidatesOf(ME);
  eq('peer path: Rule 24 order — permanent, then the fortress token', c1.map(c => [c.kind, c.id]), [['perm', 'effect_test'], ['stat', tok.id]]);
  entity.permanents.delete('effect_test'); publish();
  const c2 = peerAt([], S).candidatesOf(ME);
  eq('peer path: no permanent → the fortress token is the target, power = its value', [c2[0]?.kind, c2[0]?.id, c2[0]?.power], ['stat', tok.id, hi]);
  eq('peer path: another stat does not reach it', peerAt([], S === 'will' ? 'matter' : 'will').candidatesOf(ME).length, 0);
  // Death ends it (a Resurrect does not bring it back); other stat tokens are not touched there.
  const deathSrc = cut('const fzLost = entity.statTokens.filter(', 'are gone`); }');
  entity.statTokens.push({ id: 'x#1#0', stat: 'matter', elem: 'elem_earth', value: 4, effect_id: 'effect_artifice' });
  new Function('entity', 'FORTRESS_TOKEN_EFFECT', 'console', 'PEER_LABEL', deathSrc)(entity, FORTRESS_TOKEN_EFFECT, quiet, 'me');
  eq('peer path: on death the Fortress token goes, the Artifice token stays', entity.statTokens.map(t => t.effect_id), ['effect_artifice']);
  eq('peer path: the death drop sits in the DIED branch', /if \(wasAlive && entity\.life <= 0\) \{[\s\S]{0,900}const fzLost = entity\.statTokens/.test(src), true);
  // The UI's "aimed" state is the peer's queued destroy (hand msg), which the peer drops after every action.
  const mainSrc = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  eq('UI: the fortress button reads the peer-queued destroy, no sticky local aim flag', [/destroyAim/.test(mainSrc), /const aimed = state\.destroy\?\.building ===/.test(mainSrc)], [false, true]);
  eq('peer: queuedDestroy is cleared at every action start', /queuedDestroy = null; queuedAttach = null/.test(src), true);
  setPlacedBuildings([]);
}

// ---- Animator copies carry traps (user ruling 2026-11-15, "They are carrying traps") — peer.mjs worldTrapAt /
// dungeonTrap / worldTrapsOn cut out of peer.mjs and run on the real building catalogue. ----
{
  const src = fs.readFileSync(new URL('../peer.mjs', import.meta.url), 'utf8');
  const cut = (start, end) => { const i = src.indexOf(start); if (i < 0) throw new Error(`peer.mjs anchor missing: ${start}`); const j = src.indexOf(end, i); return src.slice(i, j + end.length); };
  setFeatureCatalog(JSON.parse(fs.readFileSync(new URL('../../assets/features/feature_table.json', import.meta.url), 'utf8')));
  const data = { effects: Object.fromEntries(JSON.parse(fs.readFileSync(new URL('../../data/effects.json', import.meta.url), 'utf8')).entries.map(e => [e.id, { id: e.id, data: active('effects.json', e.id).data }])) };
  const WORLD_TRAP_EFFECTS = playableEffects(data.effects).filter(id => EFFECT_RULES[id]?.damage && (data.effects[id]?.data?.element_cost || []).length).sort();
  const SEED = '0xabc';
  const mk = () => new Function('deps', `
    const { MAP_SEED, data, WORLD_TRAP_EFFECTS, sha256Hex, buildingFeatureAt, buildingBonusAt, dungeonAt, dungeonExplored, TRAP_POWER, worldEditsNow, spentIds, hg } = deps;
    const WORLD_TRAP_RATE = 0.35;
    const buildingPowerAt = (q, r) => { const b = Number.isInteger(q) ? buildingBonusAt(MAP_SEED, q, r) : null; return b?.kind === 'building' ? b.bonus.power || null : null; };
    const _worldTraps = new Map();
    ${cut('function dungeonTrap(dg, since) {', '\n}\n')}
    ${cut('function worldTrapAt(q, r) {', '\n}\n')}
    ${cut('const worldTrapsOn = (q, r) => {', '\n  };')}
    ${cut('const buildingTileAt = (q, r) =>', '\n')}
    return { worldTrapAt, dungeonTrap, worldTrapsOn, buildingTileAt };`)({ MAP_SEED: SEED, data, WORLD_TRAP_EFFECTS, sha256Hex: sha, buildingFeatureAt: featureAt, buildingBonusAt, dungeonAt, dungeonExplored, TRAP_POWER, worldEditsNow: edits, spentIds: new Set(), hg: { turn: 9 } });
  let edits = new Map();
  let W = mk();
  // Catalogue buildings around the origin: one hiding a trap, one without, one dungeon.
  let trapped = null, clean = null, dung = null;
  for (let d = 1; d < 60 && !(trapped && clean && dung); d++) for (let q = -d; q <= d; q++) for (const r of [-d, d - Math.abs(q)]) {
    const f = featureAt(SEED, q, r);
    if (!isBuildingFeature(f)) continue;
    if (dungeonAt(SEED, q, r)) { dung ||= { q, r, f }; continue; }
    if (fortressAt(SEED, q, r)) continue;
    const t = W.worldTrapAt(q, r);
    if (t && !trapped) trapped = { q, r, f, t }; else if (!t && !clean && !f.blocking) clean = { q, r, f };
  }
  eq('animator traps: the catalogue has a trapped building, a clean one and a dungeon near the origin', [!!trapped, !!clean, !!dung], [true, true, true]);
  // Copies on free hexes far from everything (the overlay is what syncPlacedBuildings builds from `made:q,r` edits).
  const freeHex = (q0) => { for (let q = q0; q < q0 + 400; q++) if (!featureAt(SEED, q, 200) && !featureAt(SEED, q + 1, 200)) return { q, r: 200 }; return null; };
  const h1 = freeHex(0), h2 = { q: h1.q + 1, r: 200 }, h3 = freeHex(h1.q + 5), h4 = freeHex(h3.q + 5), h5 = freeHex(h4.q + 5);
  const shrine = shrineMade(priestConfig({}), { path: 'x/shrine.png' }, 'class_priest');
  setPlacedBuildings([
    { ...copyMade(trapped.f, trapped.q, trapped.r, 'class_animator'), ...h1 },
    { ...copyMade({ ...trapped.f, placed: true, copy_of: { q: trapped.q, r: trapped.r } }, h1.q, h1.r, 'class_animator'), ...h2 },   // a copy of the copy
    { ...copyMade(clean.f, clean.q, clean.r, 'class_animator'), ...h3 },
    { ...copyMade(dung.f, dung.q, dung.r, 'class_animator'), ...h4 },
    { ...shrine, ...h5 },
  ]);
  W = mk();
  const c1 = W.worldTrapAt(h1.q, h1.r), c2 = W.worldTrapAt(h2.q, h2.r);
  eq('animator traps: the copy hides the SAME trap effect as its source', [c1?.effect_id, c1?.elements], [trapped.t.effect_id, trapped.t.elements]);
  eq('animator traps: …armed on its own hex (own id, enter / damage, power 20)', [c1?.id, c1?.q, c1?.r, c1?.trigger, c1?.mode, c1?.power, c1?.copy_of], [`wtrap:${h1.q},${h1.r}`, h1.q, h1.r, 'enter', 'damage', TRAP_POWER, { q: trapped.q, r: trapped.r }]);
  eq('animator traps: a copy of the copy carries it too', c2?.effect_id, trapped.t.effect_id);
  eq('animator traps: a copy of a clean building hides nothing', W.worldTrapAt(h3.q, h3.r), null);
  eq('animator traps: a Priest Shrine hides no trap', W.worldTrapAt(h5.q, h5.r), null);
  const sc = copyMade({ ...featureAt(SEED, h5.q, h5.r) }, h5.q, h5.r, 'class_animator');
  eq('animator: a copy of a Shrine keeps the Shrine bonus (mend, no stat)', sc.bonus, { power: { kind: 'mend' } });
  // The source's trap sprung / disabled (world edit wtrap:<source> gone) → the copy's stays armed; and vice versa.
  edits = new Map([[trapped.t.id, { id: trapped.t.id, gone: true }]]);
  W = mk();
  eq('animator traps: source sprung → the source hex holds nothing, the copy is still armed', [W.worldTrapsOn(trapped.q, trapped.r).length, W.worldTrapsOn(h1.q, h1.r).map(t => [t.id, t.owner])], [0, [[`wtrap:${h1.q},${h1.r}`, 'world']]]);
  edits = new Map([[c1.id, { id: c1.id, gone: true }]]);
  W = mk();
  eq('animator traps: the copy sprung → gone there, the source keeps its own', [W.worldTrapsOn(h1.q, h1.r).length, W.worldTrapsOn(trapped.q, trapped.r).length], [0, 1]);
  // Rogue (trap charge) / Cleric (passive: a building tile; active: worldTrapsOn within 3) see the copy as a trapped building.
  eq('animator traps: the copy hex counts as a building tile for the Cleric passive', W.buildingTileAt(h3.q, h3.r), true);
  eq('animator traps: the step check, Rogue charge and Cleric passive read worldTrapAt on the entered hex', /const wt = before\.character_id \? worldTrapAt\(t\.q, t\.r\) : null;/.test(src), true);
  eq('animator traps: Cleric tap disables world traps through worldTrapsOn', /hexesWithin\(here, R\)\.flatMap\(h => worldTrapsOn\(h\.q, h\.r\)\)/.test(src), true);
  // A copied dungeon is a dungeon of its own: unexplored when it rises, holding the trap its source would hold.
  edits = new Map([[`dng:${dung.q},${dung.r}`, { id: `dng:${dung.q},${dung.r}`, explored: 8 }]]);
  W = mk();
  const dg4 = dungeonAt(SEED, h4.q, h4.r);
  eq('animator traps: a copied dungeon is a dungeon (dng:<copy hex>)', dg4?.id, `dng:${h4.q},${h4.r}`);
  const srcFirst = W.dungeonTrap(dungeonAt(SEED, dung.q, dung.r), 'first');
  eq('animator traps: …unexplored (its source explored on turn 8 does not matter), the source\'s first trap', W.worldTrapsOn(h4.q, h4.r).map(t => [t.id, t.effect_id]), [[`dng:${h4.q},${h4.r}`, srcFirst.effect_id]]);
  eq('animator traps: the explored source holds none now', W.worldTrapsOn(dung.q, dung.r).length, 0);
  setPlacedBuildings([]);
  setFeatureCatalog(null);
}

console.log(fails ? `${fails} FAILED` : 'all fortress checks passed');
process.exit(fails ? 1 : 0);
