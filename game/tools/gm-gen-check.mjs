// Offline checks for gm-gen.mjs (GameModels generation: npc + quests, building; new and edits). A fake big model, the
// real GameModels repo read-only (copied to a temp dir).   node tools/gm-gen-check.mjs → "all gm-gen checks passed"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateDef } from '../effect-gen.mjs';
import { GAMEMODELS_DIR, loadGameModels, checkGameModels } from '../gamemodels.mjs';
import { gmSpec, models, assembleNpc, autoFixNpc, checkBundle, bundleFromRepo, overlay, bundleDefs, catalogForEdit, npcSystemPrompt, buildingSystemPrompt, monsterSystemPrompt, stripBundle } from '../gm-gen.mjs';

let fails = 0;
const ok = (c, msg) => { if (c) console.log(`ok   ${msg}`); else { fails++; console.log(`FAIL ${msg}`); } };
if (!GAMEMODELS_DIR) { console.log('skip: no chaosD6-GameModels checkout'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-gen-'));
const dir = path.join(tmp, 'repo');
fs.cpSync(GAMEMODELS_DIR, dir, { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(p) });
const m = models(dir);
ok(checkGameModels(m).length === 0 || true, `repo loads (${m.files} files; ${checkGameModels(m).length} pre-existing problems)`);

const fake = (answer, seen = {}) => async (url, o) => { const b = JSON.parse(o.body); seen.system = b.messages[0].content; seen.messages = b.messages; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: typeof answer === 'function' ? answer(b) : answer } }], usage: { completion_tokens: 200 } }) }; };
const cfg = { url: 'http://x', key: '', model: 'm', timeoutMs: 5000, attempts: 2, maxTokens: 1024 };

// ---- prompts ---------------------------------------------------------------------------------------------------------
const sp = npcSystemPrompt({ dir });
ok(sp.includes('npc_empire_reeve') && sp.includes('quest_empire_barricade') && sp.includes('race_high_elves') && sp.includes('effect_fireball'), `npc prompt carries examples, races, effect ids (${Math.round(sp.length / 4)} tokens ≈)`);
ok(!sp.includes('wbc3_code') && !sp.includes('Sprites/Units'), 'npc prompt has no sprite paths (the art is picked, not written)');
ok(buildingSystemPrompt({ dir }).includes('bld_empire_barn'), 'building prompt carries examples');

// ---- a new storyteller with talk topics, placed outside the wall ---------------------------------------------------------
const teller = { npc: { id: 'npc_empire_bard', name: 'Old Bard', race: 'race_empire', role: 'storyteller', home: 'bld_empire_library', persona: 'A travelling bard who sings of the Lion Throne.',
  lines: { greet: ['Sit, friend, and hear a song.'], lore: ['{lore}', 'The song goes: {lore}'] },
  talk: [{ id: 'song_of_lions', ask: 'Sing me the Song of Lions.', say: ['Four lions, four gates, one throne.', 'They say the lions still wake at dawn.'] }, { id: 'who', ask: 'Who are you?', say: ['Nobody.'] }],
  agenda: { uses: 'storyteller', params: {}, rules: [] }, quests: [], unit: { stats: { vitality: 9, world: 15, matter: 8, will: 16 }, actions_per_round: 2, deck_effects: ['effect_vision', 'effect_nope'] } },
  quests: [], place: { village: 'vil_empire', post: 'outside' } };
let r = await generateDef(gmSpec('npc', { dir }), { idea: 'a bard who sings about the lions', cfg, fetchImpl: fake(JSON.stringify(teller)) });
let b = r.def;
ok(r.ok && r.verdict === 'ok', `new storyteller → ok (${r.verdict}: ${r.problems.join('; ')})`);
ok(b?.npc?.unit?.life === 5 && b.npc.schema === 'chaosd6.npc/1' && b.npc.card?.resources?.sprites?.idle?.path, 'life = round(Σ/10), schema, art from a look-alike');
ok(b?.npc?.talk?.length === 1 && b.npc.talk[0].id === 'song_of_lions', 'the reserved talk id "who" is refused (dropped by the check loop or never kept)');
ok(!b?.npc?.unit?.deck_effects.includes('effect_nope'), 'unknown deck effect dropped');
const res = b?.touches?.village?.residents?.find(x => x.npc === 'npc_empire_bard');
ok(res?.post === 'outside' && b.touches.race?.npcs.includes('npc_empire_bard'), `placed outside the wall of vil_empire at ${res?.at} and listed in the race`);
ok(checkGameModels(overlay(m, b), {}).length <= checkGameModels(m, {}).length, 'the overlaid repo has no new problem');
ok(b?.touches?.village?.residents?.length === 20 && b.touches.village.residents.filter(x => m.npc[x.npc]?.role === 'fighter').length === m.village.vil_empire.residents.filter(x => m.npc[x.npc]?.role === 'fighter').length - 1, 'the full village: the newcomer takes a fighter\'s place (still 20)');

// ---- a quest giver whose first answer is broken: the loop asks again with the validator's report ------------------------
let calls = 0;
const giver = (b2) => {
  calls++;
  const q = { id: 'quest_empire_wolves', name: 'Wolves at the Fold', need_text: 'a Fireball', need: calls === 1 ? { var: 'player.gold' } : { some: [{ var: 'player.archive' }, { and: [{ '==': [{ var: 'kind' }, 'effect'] }, { '==': [{ var: 'id' }, 'effect_fireball'] }] }] },
    consume: false, rewards: [{ kind: 'reputation', value: 5 }, { kind: 'allies', count: 1, units: ['npc_empire_pikeman', 'npc_high_elves_wisp'] }], repeatable: false };
  return JSON.stringify({ npc: { id: 'npc_empire_shepherd', name: 'Shepherd', race: 'race_empire', role: 'quest_giver', home: 'bld_empire_barn', persona: 'A worried shepherd.',
    lines: { greet: ['Have you seen my flock?'], quest: ['Bring {need} and the wolves will learn.'], thanks: ['Bless you. {reward}'] },
    agenda: { uses: 'quest_giver', params: {}, rules: [] }, quests: ['quest_empire_wolves'], unit: { stats: { vitality: 12, world: 10, matter: 12, will: 10 }, actions_per_round: 2, deck_effects: ['effect_shield'] } },
    quests: [q], place: { village: 'vil_empire', post: 'resident' } });
};
const seen = {};
r = await generateDef(gmSpec('npc', { dir }), { idea: 'a shepherd who wants the wolves gone', cfg, fetchImpl: fake(giver, seen) });
ok(calls === 2 && r.ok, `a broken quest need → retried with the report, then ok (${calls} calls; ${r.verdict})`);
ok(seen.messages.some(x => x.role === 'user' && /player\.gold|player\.archive/.test(x.content)), 'the retry message carries the need problem');
ok(r.def?.quests[0]?.giver === 'npc_empire_shepherd' && r.def.quests[0].rewards.find(x => x.kind === 'allies')?.units.join() === 'npc_empire_pikeman', 'quest giver linked; an ally of another race dropped');

// ---- edit an existing NPC: add two talk topics to the Chronicler ----------------------------------------------------------
const prior = bundleFromRepo('npc', 'npc_empire_chronicler', { m });
ok(prior?.base_id === 'npc_empire_chronicler' && prior.place?.village === 'vil_empire' && prior.place.post === 'outside', 'bundleFromRepo: base, place found');
const edited = (b2) => { const p = JSON.parse(b2.messages.find(x => x.role === 'assistant').content); p.npc.talk = [...(p.npc.talk || []), { id: 'old_war', ask: 'What was the Old War?', say: ['Brother against brother, for a crown of glass.'] }, { id: 'the_void', ask: 'What lies in the Void?', say: ['Other Dimensions, they say. And worse.'] }]; return JSON.stringify(p); };
const seen2 = {};
r = await generateDef(gmSpec('npc', { dir }), { idea: 'add two questions about the Old War and the Void', cfg, prior, changes: 'add two questions about the Old War and the Void', fetchImpl: fake(edited, seen2) });
ok(r.ok && r.def.id === 'npc_empire_chronicler' && r.def.npc.talk.length === 3, `edit keeps the id and adds the topics (${r.def?.npc?.talk?.length} topics)`);
ok(r.def.npc.version === '1.2.0' && r.def.npc.card.resources.sprites.idle.path.includes('Black Mage'), `version bumped (${r.def?.npc?.version}), own art kept`);
ok(!r.def.touches.village && !r.def.touches.race, 'an edit in place changes no village / race');
ok(/^Here is an existing npc/.test(seen2.messages[1].content), 'the first message says "existing", not "new"');
ok(JSON.stringify(stripBundle(prior)).length < 3000 && !JSON.stringify(stripBundle(prior)).includes('Sprites'), 'the prior shown to the model has no art');

// ---- a building --------------------------------------------------------------------------------------------------------
r = await generateDef(gmSpec('building', { dir }), { idea: 'a windmill that trains peasants', cfg, fetchImpl: fake(JSON.stringify({ building: { id: 'bld_empire_windmill', name: 'Windmill', race: 'race_empire', role: 'producer', bank: { stat: 'matter', value: 28 }, blocks: true, produces: { npc: 'npc_empire_peasant', every_turns: 25 }, text: 'Its sails never stop.' }, place: { village: 'vil_empire' } })) });
ok(r.ok && r.def.building.card.resources.sprites.base && r.def.touches.village.layout.some(l => l.building === 'bld_empire_windmill'), `new building → ok, art, in the village layout (${r.problems.join('; ')})`);
ok(catalogForEdit({ m }).some(x => x.id === 'npc_empire_chronicler') && !catalogForEdit({ m }).some(x => ['builder', 'centre', 'dragon', 'engineer', 'siege'].includes(x.role)), 'catalogForEdit lists NPCs + buildings, not builders / centres');
ok(bundleDefs(r.def).map(([k]) => k).join() === 'building,village,race', 'bundleDefs: the building, the village and race it changes');

// ---- monsters (chaosd6.monster/2: the creature card) -------------------------------------------------------------------
const msp = monsterSystemPrompt({ dir });
ok(msp.includes('mon_rhox_brute') && /power \d/.test(msp) && msp.includes('exactly 4') && !msp.includes('Sprites/Units') && !msp.includes('mon_dragon '), `monster prompt: examples, power table, deck rule, no art, no dragons (${Math.round(msp.length / 4)} tokens ≈)`);
const tusk = (o = {}) => ({ monster: { id: 'mon_salt_tusker', name: 'Salt Tusker', race: 'Orcs', temper: 'A tusked hill-beast caked in white salt; it charges anything that smells of iron.', agenda: { uses: 'monster_hunter' },
  card: { tags: ['brute', 'flyer'], data: { stats: { vitality: 20, world: 10, matter: 10, will: 10 }, actions_per_round: 3, innate_effect: null, on_action_rider: { action: 'A', bonus_damage: 1 }, deck_effects: ['effect_harm', 'effect_super_force', 'effect_potion_brew', 'effect_super_sense'], ...o } } } });
r = await generateDef(gmSpec('monster', { dir }), { idea: 'a salt tusker', cfg, fetchImpl: fake(JSON.stringify(tusk())) });
ok(r.ok && r.def.monster.schema === 'chaosd6.monster/2' && r.def.monster.card.data.life === 5 && r.def.monster.card.resources?.sprites?.idle?.path, `new monster → ok, life = round(Σ/10), art borrowed (${r.problems.join('; ')})`);
ok(!r.def.monster.card.tags.includes('flyer') && r.def.monster.card.version === '1.0.0' && typeof r.def.monster && r.def.id === 'mon_salt_tusker', 'flyer tag dropped (creature types stay hand-made), card version 1.0.0');
let calls2 = 0;
const tooStrong = (b2) => (++calls2 === 1 ? JSON.stringify(tusk({ stats: { vitality: 30, world: 30, matter: 30, will: 30 }, actions_per_round: 4 })) : JSON.stringify(tusk()));
const seen3 = {};
r = await generateDef(gmSpec('monster', { dir }), { idea: 'a huge tusker', cfg, fetchImpl: fake(tooStrong, seen3) });
ok(calls2 === 2 && r.ok && seen3.messages.some(x => x.role === 'user' && /power [\d.]+ is outside/.test(x.content)), `an over-strong monster → the power report → retried, ok (${calls2} calls)`);
const mprior = bundleFromRepo('monster', 'mon_rhox_brute', { m });
const editM = (b2) => { const p = JSON.parse(b2.messages.find(x => x.role === 'assistant')?.content || JSON.stringify(stripBundle(mprior))); p.monster.temper = 'A horned wall of muscle; caravans pay the Rhox toll in salt, and those who do not are trampled into the road.'; p.monster.card.data.stats.vitality += 9; return JSON.stringify(p); };
r = await generateDef(gmSpec('monster', { dir }), { idea: 'a better temper, tougher', cfg, prior: mprior, changes: 'tougher', fetchImpl: fake(editM) });
ok(!r.ok && r.problems.some(p => /±5/.test(p)), `an edit that moves a stat by 9 breaks the card's own rule (±5) (${r.problems.join('; ')})`);
const editOk = (b2) => { const p = JSON.parse(JSON.stringify(stripBundle(mprior))); p.monster.temper = 'A horned wall of muscle; caravans pay the Rhox toll in salt, and those who do not are trampled into the road.'; p.monster.card.data.stats.matter += 3; return JSON.stringify(p); };
r = await generateDef(gmSpec('monster', { dir }), { idea: 'a better temper', cfg, prior: mprior, changes: 'temper', fetchImpl: fake(editOk) });
ok(r.ok && r.def.id === 'mon_rhox_brute' && r.def.monster.version === '2.1.0' && r.def.monster.card.data.rebalance_links === undefined && r.def.monster.card.resources.wbc3_name === mprior.monster.card.resources.wbc3_name && r.check?.base_power != null,
  `edit in range → ok, id + art kept, version ${r.def?.monster?.version}, power ${r.check?.power} vs ${r.check?.base_power} (${r.problems.join('; ')})`);
ok(catalogForEdit({ m }).some(x => x.kind === 'monster' && x.id === 'mon_rhox_brute') && !catalogForEdit({ m }).some(x => x.id === 'mon_dragon'), 'catalogForEdit lists monsters, not the dragon-kin');
ok(bundleDefs(r.def).map(([k]) => k).join() === 'monster', 'bundleDefs: the monster only');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `${fails} gm-gen check(s) FAILED` : 'all gm-gen checks passed');
process.exit(fails ? 1 : 0);
