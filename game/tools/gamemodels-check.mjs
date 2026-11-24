#!/usr/bin/env node
// Oracles for the GameModels layer: definitions check (and catch planted mistakes), agendas pick the expected
// goals, quests read the archive, villages are placed deterministically ≥ 100 hexes apart.
//   node tools/gamemodels-check.mjs → "all gamemodels checks passed"
import assert from 'node:assert/strict';
import { loadGameModels, checkGameModels, compileCatalog, knownIds } from '../gamemodels.mjs';
import { agendaGoal, questMet } from '../agenda.mjs';
import { setVillageCatalog, villageOfCell, villagesNear, villageHexAt, villageFeatureAt, villageResidents, villageWanderers, nearestVillage, compass, isVillageWallAt, villageRep, standingOf, villageColour, MIN_APART, ORIGIN_MIN, ORIGIN_MAX } from '../js/villages.js';
import { assetFile } from '../asset-root.mjs';

const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
const m = loadGameModels();
const known = knownIds();
assert.deepEqual(checkGameModels(m, { known, assetFile }), []);

// planted mistakes are caught
const planted = (fn, re) => {
  const c = structuredClone(m); fn(c);
  const errs = checkGameModels(c, { known, assetFile });
  assert.ok(errs.some(e => re.test(e)), `expected ${re} in:\n  ${errs.join('\n  ')}`);
};
planted(c => { c.npc.npc_empire_reeve.unit.life = 9; }, /npc_empire_reeve: unit.life 9/);
planted(c => { c.npc.npc_empire_reeve.agenda.rules = [{ id: 'x', when: { cond: 'nope' }, goal: { do: 'idle' } }]; }, /unknown condition "nope"/);
planted(c => { c.npc.npc_empire_reeve.agenda.rules = [{ id: 'x', when: { var: 'mee.life' }, goal: { do: 'idle' } }]; }, /reads "mee.life"/);
planted(c => { c.npc.npc_empire_reeve.agenda.rules = [{ id: 'x', when: true, goal: { do: 'dance' } }]; }, /unknown goal "dance"/);
planted(c => { c.npc.npc_empire_reeve.unit.deck_effects = ['effect_nope']; }, /unknown deck effect effect_nope/);
planted(c => { c.building.bld_empire_barn.bank.value = 0; }, /bld_empire_barn: bank/);
planted(c => { c.building.bld_empire_barn.card.resources.sprites.base = 'assets/Sprites/Buildings/Empire/Nope.png'; }, /missing sprite/);
planted(c => { c.village.vil_empire.layout[0].at = [1, 1]; }, /centre building stands at \[0,0\]/);
planted(c => { c.village.vil_empire.cap = 25; }, /cap 1..20/);
planted(c => { c.village.vil_empire.residents[0].at = [0, -3]; }, /stands on a building hex/);
planted(c => { c.quest.quest_empire_barricade.need = true; }, /need already holds/);
planted(c => { c.village.vil_empire.team = 'Village'; }, /team must contain \{name\}/);
planted(c => { c.village.vil_empire.wall.gate = [3, 5]; }, /wall.gate must be a corner hex/);
planted(c => { c.village.vil_empire.wall.radius = 10; }, /wall.radius must lie in/);
planted(c => { c.village.vil_empire.residents.find(r => r.post === 'gate').at = [0, 7]; }, /the gate post stands right outside the gate/);
planted(c => { c.village.vil_empire.residents.push({ ...c.village.vil_empire.residents.find(r => r.post === 'gate') }); }, /exactly one gate guard/);
planted(c => { c.village.vil_empire.wall.sprites.joint = 'assets/Sprites/Buildings/Shared/Nope.png'; }, /missing sprite/);

const cat = compileCatalog(m);
// agendas
const npc = (id) => cat.npcs[id].agenda;
const village = { id: 'vil:0,0', radius: 6, cap: 20, units: 8, alarm: false, rep: { hostile: 40, enter: 70, ally_all: 90 } };
const me = { life: 4, life_max: 4, q: 0, r: 0, dist_home: 1 };
const goal = (a, ctx) => agendaGoal(a, { me, village, turn: 3, foe: null, friend: null, stranger: null, ...ctx })?.id;
assert.equal(goal(npc('npc_empire_reeve'), { stranger: { dist: 1, rep: 50, quests_open: 2, quests_ready: 1 } }), 'reward');
assert.equal(goal(npc('npc_empire_reeve'), { stranger: { dist: 2, rep: 50, quests_open: 2, quests_ready: 0 } }), 'ask');
assert.equal(goal(npc('npc_empire_reeve'), { stranger: { dist: 5, rep: 50, quests_open: 1, quests_ready: 0 } }), 'beckon');
assert.equal(goal(npc('npc_empire_reeve'), { stranger: { dist: 1, rep: 35, quests_open: 1, quests_ready: 0 } }), 'idle');
assert.equal(goal(npc('npc_empire_reeve'), {}), 'idle');
assert.equal(goal(npc('npc_empire_pikeman'), { stranger: { dist: 3, dist_village: 4, rep: 50 } }), 'warn');
assert.equal(goal(npc('npc_empire_pikeman'), { stranger: { dist: 3, dist_village: 4, rep: 75 } }), 'patrol');
assert.equal(goal(npc('npc_empire_pikeman'), { village: { ...village, alarm: true }, foe: { dist: 9 } }), 'alarm');
assert.equal(goal(npc('npc_empire_builder'), { foe: { dist: 2 } }), 'flee');
assert.equal(goal(npc('npc_empire_builder'), {}), 'build');
assert.equal(goal(npc('npc_high_elves_lorekeeper'), { stranger: { dist: 2, rep: 50 } }), 'tell');
assert.equal(goal(npc('npc_high_elves_lorekeeper'), { stranger: { dist: 10, rep: 50 } }), 'meet');
assert.equal(goal(npc('npc_empire_reeve'), { stranger: { dist: 10, rep: 50, quests_open: 1, quests_ready: 0 } }), 'beckon');
assert.equal(goal(npc('npc_high_elves_healer'), { friend: { dist: 2, life: 1, life_max: 4 } }), 'heal');
assert.equal(goal(npc('npc_high_elves_elder'), { me: { ...me, life: 2 }, foe: { dist: 2 } }), 'flee_hurt');
assert.equal(goal(npc('npc_high_elves_unicorn_rider'), {}), 'roam');
assert.equal(goal(cat.monsters.mon_ruinous_minotaur.agenda, { foe: { dist: 7 } }), 'hunt');
assert.equal(goal(cat.monsters.mon_guardian_of_coverdell.agenda, { foe: { dist: 7 } }), 'rest');
assert.equal(goal(cat.monsters.mon_guardian_of_coverdell.agenda, { foe: { dist: 2 } }), 'defend');
assert.equal(goal(cat.monsters.mon_tangle_spider_2b.agenda, { foe: { dist: 1 } }), 'back_off');
assert.equal(goal(npc('npc_empire_gatekeeper'), { stranger: { dist: 4, rep: 50 } }), 'bar');
assert.equal(goal(npc('npc_empire_gatekeeper'), { stranger: { dist: 2, rep: 70 } }), 'let_in');
assert.equal(goal(npc('npc_empire_gatekeeper'), { stranger: { dist: 12, rep: 50 } }), 'watch');
assert.equal(goal(npc('npc_high_elves_gatekeeper'), { village: { ...village, alarm: true }, foe: { dist: 6 } }), 'alarm');
// quests read the archive
const Qs = cat.quests;
assert.equal(questMet(Qs.quest_high_elves_starfire, { archive: [{ kind: 'effect', id: 'effect_fireball' }] }), true);
assert.equal(questMet(Qs.quest_high_elves_starfire, { archive: [{ kind: 'skill', id: 'effect_fireball' }] }), false);
assert.equal(questMet(Qs.quest_high_elves_frost, { archive: [{ kind: 'effect', id: 'effect_blizzard' }] }), true);
assert.equal(questMet(Qs.quest_empire_barricade, { archive: [{ kind: 'skill', id: 'skill_barricade' }] }), true);
assert.equal(questMet(Qs.quest_empire_supply, { archive: [{ kind: 'creature', id: 'mon_rhox_brute', tags: ['brute'] }] }), true);
assert.equal(questMet(Qs.quest_empire_supply, { archive: [{ kind: 'creature', id: 'mon_dragon', tags: ['boss'] }] }), false);
console.log('gamemodels definitions + agendas + quests: ok');

// villages on the map
setVillageCatalog(cat);
let villages = 0, races = new Set();
for (let s = 0; s < 40; s++) {
  const seed = `seed${s}`;
  const all = [];
  for (let cx = -3; cx <= 3; cx++) for (let cy = -3; cy <= 3; cy++) { const v = villageOfCell(seed, cx, cy); if (v) all.push(v); }
  const o = villageOfCell(seed, 0, 0);
  assert.ok(o, 'the spawn cell always holds a village');
  const od = dist(o, { q: 0, r: 0 });
  assert.ok(od >= ORIGIN_MIN && od <= ORIGIN_MAX, `spawn village ${od} hexes out`);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(dist(all[i], all[j]) >= MIN_APART, `${seed}: ${all[i].id} – ${all[j].id} only ${dist(all[i], all[j])} apart`);
  villages += all.length;
  for (const v of all) races.add(v.race);
  // determinism + the building layer
  assert.deepEqual(villageOfCell(seed, 1, 2), villageOfCell(seed, 1, 2));
  const c = villageHexAt(seed, o.q, o.r);
  assert.equal(c.def.role, 'centre');
  const f = villageFeatureAt(seed, o.q, o.r);
  assert.equal(f.theme, 'fortress'); assert.ok(f.bank.value > 0); assert.ok(f.label.startsWith(o.name));
  assert.equal(villageHexAt(seed, o.q + o.clear_radius + 1, o.r), null);
  assert.ok(villageHexAt(seed, o.q + 1, o.r + 1).clear || villageHexAt(seed, o.q + 1, o.r + 1).def);
  for (const rs of villageResidents(seed, o)) assert.ok(!villageHexAt(seed, rs.q, rs.r)?.def && !villageHexAt(seed, rs.q, rs.r)?.wall, 'a resident never starts on a building or the wall');
  for (const w of villageWanderers(seed, o)) { const d = dist(w, o); assert.ok(d >= 50 && d <= 100, `wanderer ${d} out`); }
  assert.equal(nearestVillage(seed, 0, 0).id, o.id);
  assert.ok(villagesNear(seed, 0, 0, 300).length >= 1);
}
assert.deepEqual([...races].sort(), ['race_empire', 'race_high_elves']);

// the map layer: featureAt answers the village buildings, fortressAt gives their bank, labyrinth walls stay out
{
  const fs = await import('node:fs');
  const { setFeatureCatalog, featureAt, labyrinthWallAt } = await import('../js/features.js');
  const { fortressAt, buildingBonusAt } = await import('../js/building-bonus.js');
  const { biomeFor } = await import('../js/biome.js');
  const rel = (p) => new URL(`../../assets/${p}`, import.meta.url);
  setFeatureCatalog(JSON.parse(fs.readFileSync(rel('features/feature_table.json'), 'utf8')));
  for (const seed of ['seed1', 'seed7', 'a1b2c3']) {
    const o = villageOfCell(seed, 0, 0);
    const tpl = cat.villages[o.template];
    for (const l of tpl.layout) {
      const q = o.q + l.at[0], r = o.r + l.at[1];
      const f = featureAt(seed, q, r);
      assert.equal(f?.village?.building, l.building, `${seed}: featureAt(${q},${r})`);
      const fz = fortressAt(seed, q, r);
      assert.deepEqual([fz?.stat, fz?.value], [cat.buildings[l.building].bank.stat, cat.buildings[l.building].bank.value]);
      assert.equal(fortressAt(seed, q, r, new Set([`bld:${q},${r}`])), null, 'a broken village building is gone');
    }
    let walls = 0;
    for (let dq = -o.clear_radius; dq <= o.clear_radius; dq++) for (let dr = -o.clear_radius; dr <= o.clear_radius; dr++) {
      const q = o.q + dq, r = o.r + dr;
      if (dist({ q, r }, o) > o.clear_radius) continue;
      // the wall ring blocks (labyrinthWallAt = every blocking rule), all but its gate; nothing else in the disc does
      const onRing = dist({ q, r }, o) === o.wall.radius && !(q === o.wall.gate.q && r === o.wall.gate.r);
      const lw = labyrinthWallAt(seed, q, r);
      assert.equal(!!lw, onRing, `${seed}: (${q},${r}) wall ${!!lw}, ring ${onRing}`);
      if (lw) { walls++; assert.ok(lw.blocking && lw.kind === 'wall' && lw.id.startsWith('village_wall/') && lw.path); assert.ok(isVillageWallAt(seed, q, r)); }
      const f = featureAt(seed, q, r);
      assert.ok(!f || f.village, `${seed}: only village buildings inside the disc (${q},${r}: ${f?.label})`);
      assert.ok(biomeFor(seed).isWalkable(q, r), `${seed}: (${q},${r}) inside the village is ${biomeFor(seed).biomeAt(q, r)} — a village clears its land`);
    }
    assert.equal(walls, 6 * o.wall.radius - 1, 'the whole ring but the gate');
    for (const h of [o.wall.gate, o.wall.inner, o.wall.outer]) assert.equal(labyrinthWallAt(seed, h.q, h.r), null, 'gate, its inner hex and the guard post are open');
    const guard = villageResidents(seed, o).find(rs => rs.post === 'gate');
    assert.deepEqual([guard.q, guard.r], [o.wall.outer.q, o.wall.outer.r], 'the gate guard stands right outside the gate');
    assert.ok(buildingBonusAt(seed, o.q, o.r)?.bonus?.power?.kind === 'fortress');
  }
  console.log('map layer: village buildings are stat-buy fortresses, the disc is clear');
}
// relationship in percent (user 2026-11-24): 50 % start, 70 % for a hero of the village's race, quest +5, a hurt
// villager −5 (once per unit — the writer keeps one vhit per label), an uninvited entry −5 each, clamped 0..100
{
  const o = villageOfCell('seed3', 0, 0);
  const led = (edits) => [{ peer_id: 'peer:h', world_edits_json: JSON.stringify(edits) }];
  const raceName = cat.races[o.race].wbc3_race;
  assert.equal(villageRep('seed3', o, 'peer:h', []), 50);
  assert.equal(villageRep('seed3', o, 'peer:h', [], raceName), 70);
  assert.equal(villageRep('seed3', o, 'peer:h', [], raceName === 'Empire' ? 'High Elves' : 'Empire'), 50);
  assert.equal(villageRep('seed3', o, 'peer:h', led([{ id: 'vq:quest_x', v: o.id, d: 5 }, { id: 'vhit:vil_0_0_r1', v: o.id }, { id: 'vhit:vil_0_0_r2', v: o.id }])), 45);
  assert.equal(villageRep('seed3', o, 'peer:h', led([{ id: `ventry:${o.id}:1`, v: o.id }, { id: `ventry:${o.id}:2`, v: o.id }, { id: 'vhit:x', v: 'vil:9,9' }])), 40);
  assert.equal(villageRep('seed3', o, 'peer:h', led(Array.from({ length: 30 }, (_, i) => ({ id: `vhit:u${i}`, v: o.id })))), 0, 'clamped at 0');
  assert.equal(standingOf(39, o.reputation), 'hostile'); assert.equal(standingOf(40, o.reputation), 'stranger');
  assert.equal(standingOf(70, o.reputation), 'welcome'); assert.equal(standingOf(90, o.reputation), 'ally');
  // every village its own colour, never green (allies) nor red (monsters)
  const hueOf = (hex) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
  const cols = new Set();
  for (let cx = -4; cx <= 4; cx++) for (let cy = -4; cy <= 4; cy++) { const c = villageColour('seed3', `vil:${cx},${cy}`); cols.add(c); const h = hueOf(c); assert.ok((h >= 20 && h <= 70) || (h >= 203 && h <= 332), `${c} hue ${h.toFixed(0)}`); }
  assert.ok(cols.size > 40, 'villages wear different colours');
  console.log('relationship: percent rules, race start, clamp, standings; village colours never green / red');
}
assert.equal(compass({ q: 0, r: 0 }, { q: 5, r: 0 }).includes('east'), true);
console.log(`villages: ${villages} placed over 40 seeds × 49 cells, all ≥ ${MIN_APART} apart, both races used`);
console.log('all gamemodels checks passed');
