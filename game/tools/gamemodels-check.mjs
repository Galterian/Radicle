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
assert.equal(goal(npc('npc_empire_halberdier'), { stranger: { dist: 3, dist_village: 4, rep: 50 } }), 'warn');
assert.equal(goal(npc('npc_empire_halberdier'), { stranger: { dist: 3, dist_village: 4, rep: 75 } }), 'patrol');
assert.equal(goal(npc('npc_empire_halberdier'), { village: { ...village, alarm: true }, foe: { dist: 9 } }), 'alarm');
// villages at war (2026-11-25): wall guards walk the wall, fighters fall on a foe at war, civilians run from one
assert.equal(goal(npc('npc_empire_pikeman'), {}), 'walk');
assert.equal(goal(npc('npc_empire_pikeman'), { foe: { dist: 3, war: 1 } }), 'war');
assert.equal(goal(npc('npc_empire_archer'), { foe: { dist: 12, war: 1 } }), 'war');
assert.equal(goal(npc('npc_empire_archer'), { foe: { dist: 3, war: 0 } }), 'drill');
assert.equal(goal(npc('npc_undead_fighter'), { foe: { dist: 5, war: 1 } }), 'war');
assert.equal(goal(npc('npc_empire_trader'), { foe: { dist: 2, war: 1 } }), 'war_flee');
assert.equal(goal(npc('npc_empire_halberdier'), { foe: { dist: 3, war: 1 } }), 'war');
assert.equal(goal(npc('npc_empire_mason'), {}), 'mend');
assert.equal(goal(npc('npc_empire_mason'), { foe: { dist: 2 } }), 'flee');
assert.equal(goal(npc('npc_knights_diplomat'), { stranger: { dist: 5, rep: 50 } }), 'offer');
assert.equal(goal(npc('npc_knights_diplomat'), { stranger: { dist: 1, rep: 50 } }), 'greet');
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
  { const first = villageResidents(seed, o).map(rs => rs.name.split(',')[0]).slice(0, cat.races[o.race].person_names.length);
    assert.equal(new Set(first).size, first.length, `${seed}: two villagers share a name (${first})`); }
  for (const rs of villageResidents(seed, o)) assert.ok(!villageHexAt(seed, rs.q, rs.r)?.def && !villageHexAt(seed, rs.q, rs.r)?.wall, 'a resident never starts on a building or the wall');
  for (const w of villageWanderers(seed, o)) { const d = dist(w, o); assert.ok(d >= 50 && d <= 100, `wanderer ${d} out`); }
  assert.equal(nearestVillage(seed, 0, 0).id, o.id);
  assert.ok(villagesNear(seed, 0, 0, 300).length >= 1);
}
assert.deepEqual([...races].sort(), Object.keys(cat.races).sort(), 'every race founds villages');

// the map layer: featureAt answers the village buildings, fortressAt gives their bank, labyrinth walls stay out
{
  const fs = await import('node:fs');
  const { setFeatureCatalog, featureAt, labyrinthWallAt } = await import('../js/features.js');
  const { fortressAt, buildingBonusAt } = await import('../js/building-bonus.js');
  const { biomeFor } = await import('../js/biome.js');
  const { featureAt: worldItemAt } = await import('../js/map.js');
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
      assert.equal(worldItemAt(seed, q, r), null, `${seed}: a world item inside the village at (${q},${r})`);
      assert.ok(biomeFor(seed).isWalkable(q, r),`${seed}: (${q},${r}) inside the village is ${biomeFor(seed).biomeAt(q, r)} — a village clears its land`);
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
// directions as the map shows them (north = up the screen)
assert.equal(compass({ q: 0, r: 0 }, { q: 5, r: -5 }), 'north-east'); assert.equal(compass({ q: 0, r: 0 }, { q: 0, r: -5 }), 'north-west'); assert.equal(compass({ q: 0, r: 0 }, { q: 3, r: -6 }), 'north');
assert.equal(compass({ q: 0, r: 0 }, { q: -3, r: 6 }), 'south'); assert.equal(compass({ q: 0, r: 0 }, { q: -5, r: 0 }), 'west');
// dialogues (user 2026-11-24): role people, their own questions, the quest givers + storyteller outside the wall
{
  const { walkWords, intelLine } = await import('../village-life.mjs');
  assert.equal(walkWords(30), 'about 3 minutes\' walk away'); assert.equal(walkWords(2), 'a stone\'s throw away');
  assert.match(intelLine({ kind: 'monster', name: 'Orc', dir: 'north-east', hexes: 30 }, 0), /Orc.*north-east.*3 minutes/);
  assert.ok(!/\d+ hexes/.test(intelLine({ kind: 'village', name: 'Ashford Village', race: 'Empire', dir: 'south', hexes: 240 }, 1)), 'no hex counts in the lore');
  planted(c => { c.village.vil_empire.residents.find(r => r.post === 'outside').at = [-1, 9]; }, /must not stand next to the gate/);
  planted(c => { c.village.vil_empire.residents.find(r => r.post === 'outside').at = [-1, 3]; }, /between the wall and the cleared edge/);
  planted(c => { c.npc.npc_empire_trader.talk[0].id = 'news'; }, /talk: id "news"/);
  planted(c => { c.npc.npc_empire_trader.quests = []; }, /a trader needs a barter/);
  for (const vid of ['vil_empire', 'vil_high_elves']) {
    const t = cat.villages[vid];
    const roles = new Set(t.residents.map(r => cat.npcs[r.npc].role));
    for (const r of ['smith', 'wizard', 'mercenary', 'trader', 'quest_giver', 'storyteller']) assert.ok(roles.has(r), `${vid} has a ${r}`);
    for (const r of t.residents.filter(r => /^(quest_giver|storyteller)$/.test(cat.npcs[r.npc].role))) assert.equal(r.post, 'outside', `${vid}: ${r.npc} waits outside the wall`);
  }
  assert.equal(goal(npc('npc_empire_trader'), { stranger: { dist: 2, rep: 50 } }), 'greet');
  assert.equal(goal(npc('npc_high_elves_trader'), { stranger: { dist: 6, rep: 50 } }), 'hawk', 'a trader walks up to a customer');
  assert.equal(goal(npc('npc_empire_trader'), { stranger: { dist: 6, rep: 30 } }), 'idle', 'but not to a hostile one');
  assert.equal(goal(npc('npc_high_elves_mercenary'), { stranger: { dist: 3, dist_village: 4, rep: 50 } }), 'warn');
  assert.equal(goal(npc('npc_empire_mercenary'), { stranger: { dist: 5, dist_village: 4, rep: 70 } }), 'offer', 'a sellsword walks up to a welcome hero');
  assert.equal(questMet(Qs.quest_empire_trade_creature, { archive: [{ kind: 'creature', id: 'mon_rhox_brute' }] }), true);
  assert.equal(Qs.quest_empire_trade_creature.consume && Qs.quest_empire_trade_creature.repeatable, true);
  console.log('dialogues: walking-time lore, role people in both villages, quest givers + storyteller outside the wall');
}
// hired builders + hamlets (user 2026-11-24): a builder's price is a barter whose reward is the builder; its menu
// names race buildings and a power; some villages are hamlets (no wall, few people), never the spawn one
{
  planted(c => { c.npc.npc_empire_trader.builds = c.npc.npc_empire_builder.builds; c.npc.npc_empire_trader.build_max = 2; }, /builds: only a builder builds/);
  planted(c => { c.npc.npc_empire_builder.builds[0].power = { kind: 'fly' }; }, /power.kind not in/);
  planted(c => { c.npc.npc_empire_builder.builds[0].building = 'bld_high_elves_healer'; }, /missing or of another race/);
  planted(c => { c.npc.npc_empire_builder.quests = []; c.quest.quest_empire_hire_builder.giver = 'npc_empire_reeve'; c.npc.npc_empire_reeve.quests.push('quest_empire_hire_builder'); }, /needs its price/);
  planted(c => { c.village.vil_empire_hamlet.size = 'tiny'; }, /size: "hamlet" or none/);
  for (const id of ['npc_empire_builder', 'npc_high_elves_builder']) {
    const n = cat.npcs[id], price = cat.quests[n.quests[0]];
    assert.ok(price.consume && price.repeatable && price.rewards.some(r => r.kind === 'allies' && r.units.includes(id)), `${id}: hire price`);
    assert.ok(n.builds.some(b => b.id === 'tower') && n.builds.some(b => b.wall), `${id}: a tower and a barricade on the menu`);
  }
  assert.equal(goal(npc('npc_empire_builder'), { stranger: { dist: 5, rep: 50 } }), 'offer', 'a builder for hire walks up to a stranger');
  assert.equal(goal(npc('npc_empire_builder'), { stranger: { dist: 5, rep: 30 } }), 'build', 'but not to a hostile one');
  assert.equal(questMet(Qs.quest_empire_hire_builder, { archive: [{ kind: 'effect', id: 'effect_haste' }] }), true);
  assert.equal(questMet(Qs.quest_high_elves_hire_builder, { archive: [{ kind: 'effect', id: 'effect_haste' }] }), false);
  let hamlets = 0, full = 0;
  for (let s = 0; s < 40; s++) for (let cx = -3; cx <= 3; cx++) for (let cy = -3; cy <= 3; cy++) {
    const v = villageOfCell(`seed${s}`, cx, cy);
    if (!v) continue;
    const t = cat.villages[v.template];
    if (t.size === 'hamlet') {
      hamlets++;
      assert.ok(cx || cy, 'the spawn village is never a hamlet');
      assert.equal(v.wall, null, 'a hamlet has no wall'); assert.ok(v.team.endsWith('Hamlet'));
      const roles = new Set(villageResidents(`seed${s}`, v).map(rs => cat.npcs[rs.npc].role));
      for (const r of ['quest_giver', 'storyteller', 'builder', 'trader']) assert.ok(roles.has(r), `${v.team} has a ${r}`);
    } else full++;
  }
  assert.ok(hamlets > 0.25 * (hamlets + full) && hamlets < 0.5 * (hamlets + full), `hamlets ${hamlets} of ${hamlets + full}`);
  console.log(`builders for hire (price + menu) and hamlets: ${hamlets} hamlets, ${full} villages`);
  // villages are neutral in the resolver (contact / area / autotarget): only wild monsters and heroes on the list
  const { villageNeutral } = await import('../village-life.mjs');
  const vil = { peer_id: 'peer:v1', npc_id: 'npc_empire_healer', village_id: 'vil:0,0', alliance: 'village_x', hostile_to_csv: '' };
  const hero = { peer_id: 'peer:h', character_id: 'char_x', alliance: 'player' };
  const wild = { peer_id: 'peer:m', creature_id: 'mon_rhox_brute', alliance: 'npc_b' };
  assert.equal(villageNeutral(vil, hero), true, 'a friendly village and a hero');
  assert.equal(villageNeutral(hero, vil), true);
  assert.equal(villageNeutral(vil, wild), false, 'villagers fight wild monsters');
  assert.equal(villageNeutral({ ...vil, hostile_to_csv: 'peer:h' }, hero), false, 'a hostile village fights the hero');
  assert.equal(villageNeutral({ ...vil, hostile_to_csv: 'peer:h' }, { peer_id: 'peer:s', creature_id: 'mon_x', owner_peer_id: 'peer:h', alliance: 'npc_a' }), false, '…and its summons');
  assert.equal(villageNeutral(vil, { ...vil, peer_id: 'peer:v2', village_id: 'vil:1,0' }), true, 'villages leave each other alone');
  assert.equal(villageNeutral({ ...vil, follower: 1 }, wild), false, 'a follower is no villager');
  assert.equal(villageNeutral(hero, wild), false, 'no village, no say');
  console.log('villages neutral in the resolver: friendly heroes, other villages; hostile heroes + wild monsters fight');
  // the village dragon, the engineer and his siege engines (user 2026-11-25)
  planted(c => { delete c.npc.npc_empire_dragon.unit.breath; }, /a dragon needs unit.breath/);
  planted(c => { c.npc.npc_empire_dragon.unit.tags = ['swimming']; }, /unit.tags: a list of/);
  planted(c => { c.npc.npc_empire_catapult.siege.min = 1; }, /siege catapult: min 2/);
  planted(c => { c.npc.npc_empire_ram.siege.rounds = 0; }, /siege.rounds/);
  planted(c => { c.npc.npc_empire_catapult.quests = ['quest_empire_engine_ram']; }, /gives no quests/);
  planted(c => { c.npc.npc_empire_reeve.siege = c.npc.npc_empire_catapult.siege; }, /exactly the siege role has one/);
  planted(c => { c.npc.npc_empire_engineer.quests = []; for (const k of ['catapult', 'ballista', 'ram']) c.quest[`quest_empire_engine_${k}`].giver = 'npc_empire_reeve'; }, /an engineer needs a consume quest/);
  planted(c => { c.village.vil_empire.residents.find(r => r.post === 'centre').at = [2, -1]; }, /post "centre" stands next to the centre building/);
  planted(c => { c.village.vil_empire.residents.find(r => r.post === 'centre').npc = 'npc_empire_reeve'; }, /only a dragon holds post "centre"/);
  for (const race of ['empire', 'high_elves']) {
    const d = cat.npcs[`npc_${race}_dragon`], u = d.unit;
    assert.deepEqual([u.stats.vitality, u.stats.world, u.stats.matter, u.stats.will, u.breath.range], [30, 30, 30, 30, 2], `${race} dragon 30/30/30/30, breath 2`);
    assert.ok(u.tags.includes('flying'));
    const vt = Object.values(cat.villages).find(v => v.race === `race_${race}` && !v.size);
    assert.ok(vt.residents.some(r => r.npc === `npc_${race}_dragon` && r.post === 'centre') && vt.residents.some(r => r.npc === `npc_${race}_engineer`), `${race} village houses its dragon and engineer`);
    for (const k of ['catapult', 'ballista', 'ram']) {
      const s = cat.npcs[`npc_${race}_${k}`];
      assert.deepEqual([s.role, s.unit.stats.matter, s.unit.stats.vitality + s.unit.stats.world + s.unit.stats.will, s.siege.kind], ['siege', 25, 0, k]);
      const q = cat.quests[`quest_${race}_engine_${k}`];
      assert.ok(q.consume && q.repeatable && q.rewards.some(r => r.kind === 'allies' && r.count === 1 && r.units.includes(`npc_${race}_${k}`)), `${race} ${k}: one archive card`);
    }
    assert.equal(goal(npc(`npc_${race}_dragon`), { foe: { dist: 2 } }), 'breathe');
    assert.equal(goal(npc(`npc_${race}_dragon`), { me: { ...me, dist_home: 5 } }), 'leash');
  }
  console.log('village dragons (30×4, breath 2, flying, post centre) and engineers (catapult / ballista / ram for one card)');
}
// diplomats, the Ministry, rebirth, the mason, wall guards, fighters, all 16 races, villages at war, alignment (user 2026-11-25)
{
  const V = await import('../js/villages.js'), L = await import('../village-life.mjs');
  planted(c => { delete c.race.race_orcs.alignment_pct; }, /race_orcs: alignment_pct 0..100/);
  planted(c => { c.npc.npc_empire_trader.repairs = { rounds: 3 }; }, /repairs: only a builder mends/);
  planted(c => { c.npc.npc_empire_mason.repairs = { rounds: 9 }; }, /repairs: \{ rounds 1..6 \}/);
  planted(c => { c.npc.npc_empire_mason.builds = c.npc.npc_empire_builder.builds; c.npc.npc_empire_mason.build_max = 2; }, /the mason stays home/);
  planted(c => { c.village.vil_empire.residents.push({ npc: 'npc_empire_peasant', at: [5, 0] }); c.village.vil_empire.cap = 20; c.village.vil_empire.residents.splice(0, 1); }, /at most two builders/);
  planted(c => { c.village.vil_empire.layout = c.village.vil_empire.layout.filter(l => l.building !== 'bld_empire_ministry'); }, /needs the Ministry of Foreign Affairs/);
  planted(c => { c.village.vil_empire.residents.find(r => r.post === 'wall').at = [0, -6]; }, /post "wall" starts on the ring inside the wall/);
  planted(c => { c.npc.npc_empire_diplomat.home = null; }, /a diplomat needs its home/);
  planted(c => { c.quest.quest_empire_trade_skill.rewards = [{ kind: 'sabotage' }]; }, /reward sabotage: a consume quest of a diplomat/);
  const ALIGN = { race_high_elves: 100, race_wood_elves: 95, race_fey: 85, race_knights: 80, race_dwarves: 75, race_empire: 70, race_barbarians: 60, race_orcs: 55, race_minotaurs: 45, race_ssrathi: 40, race_dark_dwarves: 35, race_dark_elves: 30, race_swarm: 20, race_daemons: 15, race_plaguelords: 5, race_undead: 0 };
  assert.deepEqual(Object.keys(cat.races).sort(), Object.keys(ALIGN).sort(), 'the 16 races');
  for (const [race, pct] of Object.entries(ALIGN)) {
    assert.equal(cat.races[race].alignment_pct, pct, `${race} ${pct}%`);
    const vt = Object.values(cat.villages).find(v => v.race === race && !v.size), roles = vt.residents.map(r => cat.npcs[r.npc]);
    assert.equal(vt.cap, 20); assert.equal(vt.residents.length, 20, `${race}: 20 residents`);
    const count = (f) => roles.filter(f).length;
    assert.deepEqual([count(n => n.role === 'dragon'), count(n => n.role === 'builder'), count(n => n.repairs), count(n => n.role === 'fighter'), vt.residents.filter(r => r.post === 'gate').length, vt.residents.filter(r => r.post === 'wall').length],
      [1, 2, 1, 5, 1, 2], `${race}: 1 dragon, 2 builders (1 mason), 5 fighters, 1 gate guard, 2 wall guards`);
    for (const role of ['quest_giver', 'storyteller', 'trader', 'smith', 'wizard', 'mercenary', 'healer', 'engineer', 'diplomat']) assert.equal(count(n => n.role === role), 1, `${race}: one ${role}`);
    assert.ok(vt.layout.some(l => cat.buildings[l.building].role === 'ministry'), `${race}: its Ministry`);
    for (const r of vt.residents) { const n = cat.npcs[r.npc]; if (n.home && n.role !== 'builder') assert.ok(vt.layout.some(l => l.building === n.home), `${race}: ${r.npc} is reborn in its home ${n.home}`); }
    assert.ok(Object.values(cat.villages).some(v => v.race === race && v.size === 'hamlet'), `${race} hamlet`);
    for (const b of vt.layout) assert.ok(!cat.buildings[b.building].produces, `${race}: ${b.building} produces nobody (they are reborn)`);
  }
  // relations: 100 − 2·gap, +5 per diplomat led, −5 per spy mission, war under 40
  const he = { id: 'vil:1,0', race: 'race_high_elves' }, un = { id: 'vil:2,0', race: 'race_undead' }, em = { id: 'vil:3,0', race: 'race_empire' }, orc = { id: 'vil:4,0', race: 'race_orcs' };
  assert.equal(V.villageRelation(he, em), 40); assert.equal(V.villageRelation(he, un), 0); assert.equal(V.villageRelation(em, orc), 70); assert.equal(V.villageRelation(he, he), 100);
  assert.equal(V.atWar(he, em), false); assert.equal(V.atWar(he, un), true);
  const led = (edits, id = 'peer:h') => ({ peer_id: id, world_edits_json: JSON.stringify(edits) });
  const ledger = [led([{ id: `vdip:${V.pairKey(he.id, em.id)}`, v: he.id, v2: em.id, d: 5 }]), led([{ id: `vdip:${V.pairKey(he.id, em.id)}`, v: em.id, v2: he.id, d: 5 }], 'peer:h2')];
  assert.equal(V.villageRelation(he, em, V.diplomacyLedger(ledger)), 50, 'two heroes led diplomats: +10');
  const spied = [...ledger, led([{ id: `vspy:${V.pairKey(he.id, em.id)}#1`, v: em.id, v2: he.id, d: -5 }, { id: `vspy:${V.pairKey(he.id, em.id)}#2`, v: em.id, v2: he.id, d: -5 }, { id: `vspy:${V.pairKey(he.id, em.id)}#3`, v: em.id, v2: he.id, d: -5 }], 'peer:s')];
  assert.equal(V.villageRelation(he, em, V.diplomacyLedger(spied)), 35); assert.equal(V.atWar(he, em, V.diplomacyLedger(spied)), true, 'spies drive them to war');
  const emV = { ...em, reputation: cat.villages.vil_empire.reputation };
  assert.equal(V.villageRep('s', emV, 'peer:s', spied), 65, 'the spy\'s client: +5 per mission'); assert.equal(V.villageRep('s', { ...he, reputation: cat.villages.vil_high_elves.reputation }, 'peer:s', spied), 50, 'the target never knows');
  assert.equal(V.villageRep('s', emV, 'peer:w', [led([{ id: 'vhome:x_w0', v: em.id, d: 5 }], 'peer:w')]), 55, 'a wanderer walked home');
  // the hero's alignment: its race + its deeds; neutrality of villages at war
  assert.equal(V.heroAlignment([], 'peer:x', 'Undead'), 0); assert.equal(V.heroAlignment([], 'peer:x', ''), 50); assert.equal(V.heroAlignment([], 'peer:x', 'High Elves'), 100);
  assert.equal(V.heroAlignment([led([{ id: 'valign:hit:a', d: -5 }, { id: 'valign:hit:b', d: -5 }, { id: 'valign:quest:q', d: 5 }], 'peer:x')], 'peer:x', 'Empire'), 65);
  assert.equal(V.heroAlignment([led([{ id: 'valign:quest:q', d: 5 }], 'peer:x')], 'peer:x', 'High Elves'), 100, 'clamped');
  const a = { peer_id: 'peer:a', npc_id: 'npc_undead_fighter', village_id: un.id }, b = { peer_id: 'peer:b', npc_id: 'npc_high_elves_longbow', village_id: he.id };
  assert.equal(L.villageNeutral(a, b), true, 'no war judge: neutral');
  assert.equal(L.villageNeutral(a, b, (x, y) => V.atWar(x === un.id ? un : he, y === un.id ? un : he)), false, 'villages at war fight');
  assert.equal(L.villageNeutral(a, { ...a, peer_id: 'peer:c' }, () => true), true, 'one village never fights itself');
  // repairs: a broken building counts until a repair as late
  assert.deepEqual([...V.brokenHexes([{ id: 'bld:1,2', gone: true, at: 10 }, { id: 'bld:3,4', gone: true, at: 10 }, { id: 'vfix:3,4', at: 12 }])], ['1,2']);
  assert.deepEqual([...V.brokenHexes([{ id: 'vfix:3,4', at: 12 }, { id: 'bld:3,4', gone: true, at: 20 }])], ['3,4'], 'broken again after the repair');
  // rebirth: 20 turns (a fighter 50) from its home building, a new life label; a broken home waits; a recruit leaves the slot empty
  let vx = null;
  for (let cx = 1; cx < 6 && !vx; cx++) for (let cy = 0; cy < 6 && !vx; cy++) { const v = villageOfCell('seed1', cx, cy); if (v && !cat.villages[v.template].size) vx = v; }
  const res = villageResidents('seed1', vx), ri = res.findIndex(r => cat.npcs[r.npc].role === 'diplomat'), fi = res.findIndex(r => cat.npcs[r.npc].role === 'fighter');
  const dl = res[ri].label, fl = res[fi].label;
  const units = (gone, turn, broken) => L.villageUnits('seed1', vx, { turn, founded: 0, gone, broken });
  assert.equal(units(new Map(), 5).length, 20);
  assert.equal(units(new Map([[dl, 10]]), 29).some(u => u.label.startsWith(dl)), false, 'not before 20 turns');
  const back = units(new Map([[dl, 10]]), 30).find(u => u.label.startsWith(dl));
  assert.equal(back?.label, `${dl}_g1`); assert.equal(back.born, 30);
  const site = L.rebirthSite(vx, res[ri].npc);
  assert.equal(site.building, cat.npcs[res[ri].npc].home, 'the diplomat comes back from the Ministry');
  assert.equal(units(new Map([[dl, 10]]), 40, new Set([`${site.q},${site.r}`])).some(u => u.label.startsWith(dl)), false, 'a broken Ministry trains nobody');
  assert.equal(units(new Map([[fl, 10]]), 59).some(u => u.label.startsWith(fl)), false); assert.ok(units(new Map([[fl, 10]]), 60).some(u => u.label === `${fl}_g1`), 'a fighter after 50');
  assert.equal(units(new Map([[dl, null]]), 400).some(u => u.label.startsWith(dl)), false, 'led away and alive: no rebirth');
  const bi = res.findIndex(r => cat.npcs[r.npc].role === 'builder');
  assert.equal(L.rebirthSite(vx, res[bi].npc).building, cat.villages[vx.template].layout[0].building, 'the builders come back from the centre');
  console.log('diplomats + Ministry, rebirth (20 / 50 turns), mason, wall guards, fighters, 16 races (20 each), relations, spies, war, alignment');
}
console.log(`villages: ${villages} placed over 40 seeds × 49 cells, all ≥ ${MIN_APART} apart, all ${races.size} races used`);
console.log('all gamemodels checks passed');
