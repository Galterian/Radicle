// GameModels generation (user 2026-11-25: players add / change the race NPCs and buildings "with the LLM_Big in a
// pretty and descriptive way — more quest options, dialogs, more story teller options"). The editor's generate → test
// → publish loop (effect-gen.mjs generateDef) with two kinds:
//   npc      — an NPC of a race village with its persona, lines, talk topics (the questions in its card) and its quests
//   building — a race building (role, stat-buy bank, what it produces) placed in the race's village
//   monster  — a wild monster (chaosd6.monster/2, 2026-11-25): its creature card (stats, actions, innate effect, deck)
//              + agenda + temper; balanced by the chaosD6 logic layer (collection rules + the creature power score:
//              an edit within ±15 % of the card it changes, a new one inside the range of the existing monsters)
// A draft is a BUNDLE (chaosd6.gm-bundle/1): the new / changed definitions together — the npc + its quests, or the
// building — plus the village and race definitions they change (the NPC must stand somewhere: a resident of the
// village, one of its wanderers, or what a building produces). Editing an existing NPC / building = a bundle built from
// the repo (bundleFromRepo) given to the model as the prior answer ("add three questions about the old war").
// Checked with the GameModels' own check (gamemodels.mjs checkGameModels) on the repo with the bundle laid over it:
// only the problems that name the bundle's ids count. Not generated: flying / dragon-kin creature types (c2's work).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDef } from './effect-gen.mjs';
import { LogicEngine } from './logic-engine.mjs';
import { GAMEMODELS_DIR, KINDS, ROLES, BUILDING_ROLES, STATS, REWARDS, TALK_RESERVED, loadGameModels, checkGameModels, knownIds } from './gamemodels.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GM_KINDS = Object.freeze(['npc', 'building', 'monster']);
export const BUNDLE_SCHEMA = 'chaosd6.gm-bundle/1';
// Roles the generator writes. builder (builds[] + its price quest) and the gate guard post stay hand-made for now.
export const GEN_ROLES = Object.freeze(ROLES.filter(r => r !== 'builder'));
export const GEN_BUILDING_ROLES = Object.freeze(BUILDING_ROLES.filter(r => r !== 'centre'));   // one centre per village
export const LINE_KINDS = Object.freeze(['greet', 'quest', 'thanks', 'lore', 'warn']);
const EXAMPLE_NPCS = ['npc_empire_reeve', 'npc_empire_chronicler'];
// Monster card tags the generator writes; flyer / dragon-kin (creature types, c2's Flying / Dragon work) stay hand-made.
export const MONSTER_TAGS = Object.freeze(['brute', 'bruiser', 'caster', 'defender', 'support', 'pack', 'mental', 'lock', 'control']);
const NO_GEN_TAGS = ['flyer', 'dragon-kin', 'boss'];
const RIDER_ACTIONS = ['A', 'M', 'B', 'P'];
const NEW_MONSTER_ASSERTS = ['life_matches_proposal_stats', 'dice_pattern_valid', 'innate_effect_exists', 'rider_shape_valid', 'deck_effects_valid', 'deck_effects_affordable'];
const EXAMPLE_MONSTERS = ['mon_rhox_brute', 'mon_etherium_abomination', 'mon_nacatl_hunt_pride'];
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const clone = (o) => JSON.parse(JSON.stringify(o));
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strs = (v, n = 8, max = 200) => (Array.isArray(v) ? v.map(x => str(x, max)).filter(Boolean).slice(0, n) : []);
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const hexDist = ([q, r]) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));

let _models = null, _at = 0;
/** The GameModels repo (cached 10 s — the editor asks often). */
export function models(dir = GAMEMODELS_DIR) {
  if (!_models || Date.now() - _at > 10_000 || _models.dir !== dir) { _models = { dir, m: loadGameModels(dir) }; _at = Date.now(); }
  return _models.m;
}
const takenIds = (m) => new Set(Object.keys(KINDS).flatMap(k => Object.keys(m[k] || {})));
const raceShort = (m, race) => race.replace(/^race_/, '');

// ---- the prompt ----------------------------------------------------------------------------------------------------
const section = (doc, from, to) => { const a = doc.indexOf(from); if (a < 0) return ''; const b = to ? doc.indexOf(to, a + from.length) : -1; return doc.slice(a, b < 0 ? undefined : b).trim(); };
// What the model writes of an NPC / quest / building (the generator adds schema, version, race links, life, art).
export function stripNpc(n) {
  const o = { id: n.id, name: n.name, race: n.race, role: n.role, home: n.home ?? null, persona: n.persona, lines: n.lines || {} };
  if (n.talk) o.talk = n.talk;
  o.agenda = n.agenda; o.quests = n.quests || [];
  o.unit = { stats: n.unit?.stats, actions_per_round: n.unit?.actions_per_round, deck_effects: n.unit?.deck_effects || [], innate_effect: n.unit?.innate_effect ?? null };
  return o;
}
export const stripQuest = (q) => ({ id: q.id, name: q.name, need_text: q.need_text, need: q.need, consume: !!q.consume, rewards: q.rewards, repeatable: !!q.repeatable });
export const stripBuilding = (b) => ({ id: b.id, name: b.name, race: b.race, role: b.role, bank: b.bank, blocks: b.blocks !== false, produces: b.produces ?? null, text: b.text });
export const stripMonster = (mo) => ({ id: mo.id, name: mo.name, race: mo.race, temper: mo.temper, agenda: { uses: mo.agenda?.uses },
  card: { tags: mo.card?.tags || [], data: { stats: mo.card?.data?.stats, actions_per_round: mo.card?.data?.actions_per_round, innate_effect: mo.card?.data?.innate_effect ?? null,
    on_action_rider: mo.card?.data?.on_action_rider ?? null, deck_effects: mo.card?.data?.deck_effects || [] } } });
/** The bundle as the model sees it (its own earlier answer, for a retry / an edit). */
export function stripBundle(b) {
  if (b?.monster) return { monster: stripMonster(b.monster) };
  if (b?.building) return { building: stripBuilding(b.building), ...(b.place ? { place: b.place } : {}) };
  return { npc: b?.npc ? stripNpc(b.npc) : null, quests: (b?.quests || []).map(stripQuest), ...(b?.place ? { place: b.place } : {}) };
}

function worldFacts(m) {
  const lib = Object.values(m.lib)[0] || { agendas: {}, conditions: {} };
  const races = Object.values(m.race).map(r => {
    const blds = (r.buildings || []).map(id => `${id} (${m.building[id]?.role || '?'}: ${m.building[id]?.name || ''})`).join(', ');
    const npcs = (r.npcs || []).map(id => `${id} (${m.npc[id]?.role || '?'})`).join(', ');
    const vils = Object.entries(m.village).filter(([, v]) => v.race === r.id).map(([id, v]) => `${id}${v.size ? ` (${v.size})` : ''}`).join(', ');
    return `- ${r.id} "${r.name}" — ${r.temper || ''}\n  villages: ${vils}\n  buildings: ${blds}\n  npcs: ${npcs}`;
  }).join('\n');
  const k = (() => { try { return knownIds(); } catch { return { effects: new Set(), skills: new Set() }; } })();
  return [
    'Races of the world (Warlords Battlecry 3):', races, '',
    `Effect ids (deck_effects, quest needs and effect rewards): ${[...k.effects].sort().join(', ')}`,
    `Skill ids (quest needs and skill rewards): ${[...k.skills].sort().join(', ')}`,
    `Agendas (agenda.uses): ${Object.keys(lib.agendas || {}).join(', ')}`,
    `Agenda conditions ({"cond": name} inside a rule's when): ${Object.keys(lib.conditions || {}).join(', ')}`,
  ].join('\n');
}

export function npcSystemPrompt({ dir = GAMEMODELS_DIR } = {}) {
  const m = models(dir);
  const doc = fs.readFileSync(path.join(dir, 'SCHEMA.md'), 'utf8').replace(/\r/g, '');
  const examples = EXAMPLE_NPCS.filter(id => m.npc[id]).map(id => {
    const n = m.npc[id];
    return JSON.stringify({ npc: stripNpc(n), quests: (n.quests || []).map(q => m.quest[q]).filter(Boolean).map(stripQuest), place: { village: 'vil_empire', post: 'outside' } });
  }).join('\n');
  return [
    'You write characters for the villages of chaosD6, a hex card game set in the world of Warlords Battlecry 3. A village',
    'NPC has a persona, things it says, questions a hero can ask it (talk topics, shown in its card), an agenda (what it does',
    'each action) and quests it gives. Write vivid, characterful, in-world text: short spoken lines (one or two sentences, no',
    'stage directions), with the race\'s voice and temper. You answer with ONE JSON object:',
    '{"npc": {...}, "quests": [...], "place": {"village": <village id>, "post": "resident" | "outside" | "wanderer"}}',
    'npc fields: id ("npc_<race>_<words>"), name, race (a race id), role (' + GEN_ROLES.join(' | ') + '), home (a building id of',
    'its race, or null for a wanderer), persona (one sentence), lines {greet[], quest[], thanks[], lore[], warn[]} (2-4 lines',
    'each kind it needs: quest/thanks for quest givers and traders, lore for storytellers and wanderers), talk [{id, ask, say[]}]',
    `(2-5 questions; id lower_case, not ${TALK_RESERVED.join('/')}; ask ≤ 60 chars, phrased as the hero's question; say 2-3`,
    'answers, rotated), agenda {uses: <agenda>, params: {}, rules: []}, quests [quest ids], unit {stats {vitality, world, matter,',
    'will} (integers 6..18, sum 36..56), actions_per_round 1..3, deck_effects [3-4 effect ids], innate_effect null}.',
    'quests[] (a quest_giver needs 1-3, a trader at least one with consume true): id ("quest_<race>_<words>"), name, need_text',
    '(what the hero must have, as a phrase), need (JsonLogic over player.archive — see Quest below; use only listed effect /',
    'skill ids), consume (true: a barter — the card is handed over), rewards [{kind: ' + REWARDS.join(' | ') + ', ...}]',
    '(reputation {value 3..10}; allies {count, units: [npc ids of the same race]}; effect {id}; skill {id}; enter {}), repeatable.',
    'Line placeholders the game fills: {need} {reward} {village} {village_dir} {village_dist} {lore} {lore_dir} {name}.',
    'place: where the NPC lives — "resident" inside the village, "outside" (quest givers and storytellers wait outside the',
    'wall for strangers), "wanderer" (role wanderer: roams 50-100 hexes from the village; home null).',
    'To CHANGE an existing NPC, keep its id and every quest id you keep; you may add talk topics, lines and quests.',
    '',
    section(doc, '## NPC', '## Agenda'),
    '',
    section(doc, '## Quest', '## Village'),
    '',
    worldFacts(m),
    '',
    'Examples (existing NPCs, the same JSON shape as your answer):',
    examples,
  ].join('\n');
}

export function buildingSystemPrompt({ dir = GAMEMODELS_DIR } = {}) {
  const m = models(dir);
  const doc = fs.readFileSync(path.join(dir, 'SCHEMA.md'), 'utf8').replace(/\r/g, '');
  const ex = ['bld_empire_barn', 'bld_empire_library'].filter(id => m.building[id]).map(id => JSON.stringify({ building: stripBuilding(m.building[id]), place: { village: 'vil_empire' } })).join('\n');
  return [
    'You write buildings for the villages of chaosD6, a hex card game set in the world of Warlords Battlecry 3. You answer',
    'with ONE JSON object: {"building": {...}, "place": {"village": <village id>}}.',
    `building fields: id ("bld_<race>_<words>"), name, race (a race id), role (${GEN_BUILDING_ROLES.join(' | ')}), bank {stat:`,
    `${STATS.join(' | ')}, value 20..60} (a hero standing next to it stat-buys it; at bank ≥ value it breaks), blocks (true),`,
    'produces {npc: an npc id of its race, every_turns ≥ 10} or null, text (1-2 vivid sentences: what it is and does).',
    '',
    section(doc, '## Building', '## NPC'),
    '',
    worldFacts(m),
    '',
    'Examples (existing buildings):',
    ex,
  ].join('\n');
}

// ---- monsters ----
// The full engine (every collection: the deck rules read entries of rules.json); rebuilt each minute.
let _engine = null, _engineAt = 0;
const logicEngine = () => { if (!_engine || Date.now() - _engineAt > 60_000) { _engine = new LogicEngine(); _engineAt = Date.now(); } return _engine; };
const sumStats = (st) => STATS.reduce((a, k) => a + (Number(st?.[k]) || 0), 0);
const genMonsters = (m) => Object.values(m.monster).filter(mo => mo.schema === 'chaosd6.monster/2' && !(mo.card?.tags || []).some(t => NO_GEN_TAGS.includes(t)));
/** The creature power score of a card's data (logic_rules power_score.creatures), null when it cannot be scored. */
export function monsterPower(data) { try { return logicEngine().powerScore('creatures', data); } catch { return null; } }
/** [lo, hi] of the existing (generatable) monsters' power scores: a NEW monster must land inside. */
export function monsterPowerRange(m) {
  const p = genMonsters(m).map(mo => monsterPower(mo.card.data)).filter(x => typeof x === 'number');
  return p.length ? [Math.min(...p), Math.max(...p)] : [0, Infinity];
}
// rules.json rule_monster_deck_effects: monster_deck { thematic (the deck_effects count), mix, max_len, min_stat, … }
const deckRule = () => { try { const e = logicEngine().catalog.get('rule_monster_deck_effects')?.entry; const v = e && (e.versions.find(x => x.status === 'canonical') || e.versions[0]); return v?.data?.monster_deck || { thematic: 4 }; } catch { return { thematic: 4 }; } };
const monsterAgendas = (m) => Object.keys((Object.values(m.lib)[0] || {}).agendas || {}).filter(a => a.startsWith('monster_'));
const artRaces = (m) => [...new Set(Object.values(m.monster).map(mo => mo.race).filter(Boolean))].sort();
export function monsterSystemPrompt({ dir = GAMEMODELS_DIR } = {}) {
  const m = models(dir);
  const doc = fs.readFileSync(path.join(dir, 'SCHEMA.md'), 'utf8').replace(/\r/g, '');
  const k = (() => { try { return knownIds(); } catch { return { effects: new Set() }; } })();
  const table = genMonsters(m).map(mo => {
    const d = mo.card.data;
    return `- ${mo.id} "${mo.name}" [${(mo.card.tags || []).join(',')}] V${d.stats.vitality}/W${d.stats.world}/M${d.stats.matter}/Wi${d.stats.will} Σ${sumStats(d.stats)} actions ${d.actions_per_round} power ${monsterPower(d) ?? '?'}${d.innate_effect ? ` innate ${d.innate_effect}` : ''}${d.on_action_rider ? ` rider ${d.on_action_rider.action}+${d.on_action_rider.bonus_damage}` : ''}`;
  }).join('\n');
  const [lo, hi] = monsterPowerRange(m);
  const ex = EXAMPLE_MONSTERS.filter(id => m.monster[id]).map(id => JSON.stringify({ monster: stripMonster(m.monster[id]) })).join('\n');
  return [
    'You write wild monsters for chaosD6, a hex card game set in the world of Warlords Battlecry 3. A monster lurks on its',
    'hex until a hero comes near, then fights with its creature card: four stats, actions per round, an innate effect and a',
    'deck of effect cards. Write a vivid name and temper (1-2 sentences: what it looks like, how it hunts, what folk say about',
    'it) — the temper is what the player reads on its card. You answer with ONE JSON object: {"monster": {...}}.',
    `monster fields: id ("mon_<words>"), name, race (the Warlords Battlecry 3 race of its look: ${artRaces(m).join(', ')}), temper,`,
    `agenda {uses: ${monsterAgendas(m).join(' | ')}}, card {tags [1-2 of ${MONSTER_TAGS.join(', ')}], data {stats {vitality, world, matter, will}`,
    '(integers 5..30), actions_per_round 1..4, innate_effect (an effect id or null — cast on its Posture), on_action_rider',
    `(null or {"action": "A" | "M" | "B" | "P", "bonus_damage": 1} — +1 damage on that action), deck_effects [exactly ${deckRule().thematic}`,
    `effect ids that fit it: ${deckRule().mix?.damage ?? 2} damage, ${deckRule().mix?.defence ?? 1} defence, the rest its best other; each costs at most ${deckRule().max_len ?? 3} elements and`,
    `its stat behind every element must be ≥ ${deckRule().min_stat ?? 10} (≥ ${deckRule().min_stat_delta ?? 15} for a delta-damage effect) — the monster must afford it]}}.`,
    'Life is computed (round(Σstats/10)); do not write it. More actions per round = a weaker card per action: a 4-action',
    'monster has Σ ≈ 50-55, a 1-action one Σ ≈ 65-70.',
    `BALANCE: the game scores every card (power). A NEW monster must score between ${lo} and ${hi}. A CHANGED monster must stay`,
    'within ±15 % of the score it had. The existing monsters (pick numbers near a similar one):',
    table,
    'To CHANGE an existing monster: keep its id, move each stat by at most ±5, keep actions_per_round as it is, keep',
    `${deckRule().thematic} deck effects; its name, temper, look, tags, rider and innate effect may change.`,
    '',
    section(doc, '## Monster', '\n## '),
    '',
    `Effect ids: ${[...k.effects].sort().join(', ')}`,
    '',
    'Examples (existing monsters, the same JSON shape as your answer):',
    ex,
  ].join('\n');
}
export function monsterAnswerSchema() {
  const s = { type: 'string' }, int = { type: 'integer' };
  return {
    type: 'object', required: ['monster'],
    properties: {
      monster: { type: 'object', required: ['id', 'name', 'race', 'temper', 'agenda', 'card'],
        properties: { id: { type: 'string', pattern: '^mon_[a-z0-9_]+$' }, name: s, race: s, temper: s, agenda: { type: 'object', properties: { uses: s } },
          card: { type: 'object', required: ['tags', 'data'], properties: { tags: { type: 'array', items: { type: 'string', enum: [...MONSTER_TAGS] } },
            data: { type: 'object', required: ['stats', 'actions_per_round', 'deck_effects'], properties: { stats: { type: 'object', properties: Object.fromEntries(STATS.map(k => [k, int])) }, actions_per_round: int,
              innate_effect: { anyOf: [s, { type: 'null' }] }, on_action_rider: { anyOf: [{ type: 'object', properties: { action: { type: 'string', enum: RIDER_ACTIONS }, bonus_damage: int } }, { type: 'null' }] },
              deck_effects: { type: 'array', items: s } } } } } } },
    },
  };
}

export function npcAnswerSchema() {
  const s = { type: 'string' }, arr = { type: 'array', items: s };
  return {
    type: 'object', required: ['npc', 'quests', 'place'],
    properties: {
      npc: { type: 'object', required: ['id', 'name', 'race', 'role', 'persona', 'lines', 'agenda', 'unit'],
        properties: { id: { type: 'string', pattern: '^npc_[a-z0-9_]+$' }, name: s, race: s, role: { type: 'string', enum: [...GEN_ROLES] }, home: { anyOf: [s, { type: 'null' }] }, persona: s,
          lines: { type: 'object', properties: Object.fromEntries(LINE_KINDS.map(k => [k, arr])) },
          talk: { type: 'array', items: { type: 'object', required: ['id', 'ask', 'say'], properties: { id: s, ask: s, say: arr } } },
          agenda: { type: 'object' }, quests: arr,
          unit: { type: 'object', properties: { stats: { type: 'object', properties: Object.fromEntries(STATS.map(k => [k, { type: 'integer' }])) }, actions_per_round: { type: 'integer' }, deck_effects: arr } } } },
      quests: { type: 'array', items: { type: 'object', required: ['id', 'name', 'need_text', 'need', 'rewards'], properties: { id: { type: 'string', pattern: '^quest_[a-z0-9_]+$' }, name: s, need_text: s, need: { type: 'object' }, consume: { type: 'boolean' }, rewards: { type: 'array', items: { type: 'object' } }, repeatable: { type: 'boolean' } } } },
      place: { type: 'object', properties: { village: s, post: { type: 'string', enum: ['resident', 'outside', 'wanderer'] } } },
    },
  };
}
export function buildingAnswerSchema() {
  const s = { type: 'string' };
  return {
    type: 'object', required: ['building', 'place'],
    properties: {
      building: { type: 'object', required: ['id', 'name', 'race', 'role', 'bank', 'text'], properties: { id: { type: 'string', pattern: '^bld_[a-z0-9_]+$' }, name: s, race: s, role: { type: 'string', enum: [...GEN_BUILDING_ROLES] },
        bank: { type: 'object', properties: { stat: { type: 'string', enum: [...STATS] }, value: { type: 'integer' } } }, blocks: { type: 'boolean' }, produces: { anyOf: [{ type: 'object' }, { type: 'null' }] }, text: s } },
      place: { type: 'object', properties: { village: s } },
    },
  };
}

// ---- assemble: the model's answer → a bundle -----------------------------------------------------------------------
const newId = (want, prefix, fallback, taken) => {
  let id = typeof want === 'string' && new RegExp(`^${prefix}_[a-z0-9_]+$`).test(want) ? want : `${prefix}_${fallback}`;
  if (!taken.has(id)) return id;
  for (let i = 2; ; i++) if (!taken.has(`${id}_${i}`)) return `${id}_${i}`;
};
const bump = (v) => { const [a, b] = String(v || '1.0.0').split('.').map(Number); return `${a || 1}.${(b || 0) + 1}.0`; };
const source = (model, idea) => ({ collection: 'generated', custom: true, model, idea: String(idea).slice(0, 500), at: new Date().toISOString() });

/** raw → bundle. prior: the bundle being changed (its base_id is the repo definition edited, kept). */
export function assembleNpc(raw, { model = '', idea = '', taken = new Set(), prior = null, m = models() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const n = r.npc && typeof r.npc === 'object' ? r.npc : {};
  const base = prior?.base_id ? m.npc[prior.base_id] : null;
  const keep = prior?.npc?.id || null;   // a retry / an edit keeps the npc id
  const race = m.race[n.race] ? n.race : base?.race || prior?.npc?.race || Object.keys(m.race)[0];
  const name = str(n.name, 60) || base?.name || 'Villager';
  const free = new Set([...taken].filter(id => id !== keep && !(prior?.quests || []).some(q => q.id === id)));
  const id = keep || newId(n.id, 'npc', `${raceShort(m, race)}_${slug(name) || 'villager'}`, free);
  const role = GEN_ROLES.includes(n.role) ? n.role : base?.role || 'villager';
  const lines = {};
  for (const k of LINE_KINDS) { const l = strs(n.lines?.[k], 6, 160); if (l.length) lines[k] = l; }
  const talk = (Array.isArray(n.talk) ? n.talk : []).slice(0, 8).map(t => ({ id: slug(t?.id || t?.ask).slice(0, 24), ask: str(t?.ask, 60), say: strs(t?.say, 4, 240) }))
    .filter(t => t.id && t.ask && t.say.length);
  const u = n.unit || {};
  const stats = Object.fromEntries(STATS.map(k => [k, Math.max(0, Math.min(30, Math.round(Number(u.stats?.[k]) || 0)))]));
  const def = {
    schema: KINDS.npc[1], id, name, version: base ? bump(base.version) : '0.1.0', race, role,
    home: typeof n.home === 'string' ? n.home : null, persona: str(n.persona, 240), lines, ...(talk.length ? { talk } : {}),
    agenda: n.agenda && typeof n.agenda === 'object' ? { uses: str(n.agenda.uses, 40), params: n.agenda.params && typeof n.agenda.params === 'object' ? n.agenda.params : {}, rules: Array.isArray(n.agenda.rules) ? n.agenda.rules : [] } : null,
    quests: [],
    unit: { stats, life: Math.round(STATS.reduce((a, k) => a + stats[k], 0) / 10), actions_per_round: Math.max(1, Math.min(4, Math.round(Number(u.actions_per_round) || 2))),
      deck_effects: strs(u.deck_effects, 6, 60), innate_effect: null },
    card: base?.card ? clone(base.card) : { name, tags: ['npc', role], resources: null },
  };
  // base fields the generator does not write (a builder's builds, …) survive an edit
  if (base) for (const k of ['builds', 'build_max']) if (base[k] !== undefined) def[k] = clone(base[k]);
  const qTaken = new Set([...free, id]);
  const quests = (Array.isArray(r.quests) ? r.quests : []).slice(0, 4).map(q => {
    const kept = (prior?.quests || []).find(p => p.id === q?.id) || (base?.quests || []).includes(q?.id) ? q.id : null;
    const qid = kept || newId(q?.id, 'quest', `${raceShort(m, race)}_${slug(q?.name) || 'task'}`, qTaken);
    qTaken.add(qid);
    const old = m.quest[qid];
    return { schema: KINDS.quest[1], id: qid, name: str(q?.name, 60) || 'A Task', version: old ? bump(old.version) : '0.1.0', race, giver: id,
      need_text: str(q?.need_text, 120), need: q?.need && typeof q.need === 'object' ? q.need : null, consume: q?.consume === true,
      rewards: (Array.isArray(q?.rewards) ? q.rewards : []).slice(0, 4).filter(x => x && typeof x === 'object'), repeatable: q?.repeatable === true };
  });
  def.quests = quests.map(q => q.id);
  const place = r.place && typeof r.place === 'object' ? { village: str(r.place.village, 40), post: ['resident', 'outside', 'wanderer'].includes(r.place.post) ? r.place.post : 'resident' } : prior?.place || null;
  return { schema: BUNDLE_SCHEMA, kind: 'npc', id, name, version: def.version, ...(prior?.base_id || base ? { base_id: prior?.base_id || id } : {}),
    source: source(model, idea), npc: def, quests, place, touches: {} };
}

export function assembleBuilding(raw, { model = '', idea = '', taken = new Set(), prior = null, m = models() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const b = r.building && typeof r.building === 'object' ? r.building : {};
  const base = prior?.base_id ? m.building[prior.base_id] : null;
  const keep = prior?.building?.id || null;
  const race = m.race[b.race] ? b.race : base?.race || prior?.building?.race || Object.keys(m.race)[0];
  const name = str(b.name, 60) || base?.name || 'Building';
  const id = keep || newId(b.id, 'bld', `${raceShort(m, race)}_${slug(name) || 'house'}`, new Set([...taken].filter(x => x !== keep)));
  const role = GEN_BUILDING_ROLES.includes(b.role) || (base && b.role === base.role) ? b.role : base?.role || 'house';
  const def = {
    schema: KINDS.building[1], id, name, version: base ? bump(base.version) : '0.1.0', race, role,
    bank: { stat: STATS.includes(b.bank?.stat) ? b.bank.stat : 'vitality', value: Math.max(1, Math.min(80, Math.round(Number(b.bank?.value) || 30))) },
    blocks: b.blocks !== false,
    produces: b.produces && typeof b.produces === 'object' && b.produces.npc ? { npc: str(b.produces.npc, 60), every_turns: Math.max(5, Math.round(Number(b.produces.every_turns) || 20)) } : null,
    text: str(b.text, 300),
    card: base?.card ? clone(base.card) : { name, tags: ['building', role], resources: null },
  };
  const place = r.place && typeof r.place === 'object' && r.place.village ? { village: str(r.place.village, 40) } : prior?.place || null;
  return { schema: BUNDLE_SCHEMA, kind: 'building', id, name, version: def.version, ...(prior?.base_id || base ? { base_id: prior?.base_id || id } : {}),
    source: source(model, idea), building: def, place, touches: {} };
}

export function assembleMonster(raw, { model = '', idea = '', taken = new Set(), prior = null, m = models() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const mo = r.monster && typeof r.monster === 'object' ? r.monster : {};
  const base = prior?.base_id ? m.monster[prior.base_id] : null;
  const keep = prior?.monster?.id || null;
  const name = str(mo.name, 60) || base?.name || 'Monster';
  const id = keep || newId(mo.id, 'mon', slug(name) || 'beast', new Set([...taken].filter(x => x !== keep)));
  const c = mo.card && typeof mo.card === 'object' ? mo.card : {}, d = c.data && typeof c.data === 'object' ? c.data : {};
  const stats = Object.fromEntries(STATS.map(k => [k, Math.max(0, Math.min(40, Math.round(Number(d.stats?.[k]) || 0)))]));
  const rider = d.on_action_rider && RIDER_ACTIONS.includes(d.on_action_rider.action) ? { action: d.on_action_rider.action, bonus_damage: 1 } : null;
  const bd = base?.card?.data || {};
  const data = {
    // fields the generator does not write (dice_pattern, behavior, innate_effect_text, …) survive an edit
    ...clone(bd), stats, life: Math.round(sumStats(stats) / 10), actions_per_round: Math.max(1, Math.min(4, Math.round(Number(d.actions_per_round) || 2))),
    dice_pattern: bd.dice_pattern ?? null, innate_effect: typeof d.innate_effect === 'string' && d.innate_effect ? str(d.innate_effect, 60) : null, on_action_rider: rider,
    deck_effects: strs(d.deck_effects, 4, 60),
  };
  if (data.innate_effect !== (bd.innate_effect ?? null)) delete data.innate_effect_text;   // the old text named the old effect
  const def = {
    schema: 'chaosd6.monster/2', id, name, version: base ? bump(base.version) : '0.1.0', race: str(mo.race, 40) || base?.race || '',
    temper: str(mo.temper, 400), agenda: { uses: str(mo.agenda?.uses, 40), params: {}, rules: [] },
    card: { name, tags: strs(c.tags, 3, 20), ...(base?.card?.resources ? { resources: clone(base.card.resources) } : {}), version: base?.card?.version ? bump(base.card.version) : '1.0.0', data,
      ...(base?.card?.rebalance_links ? { rebalance_links: clone(base.card.rebalance_links) } : {}) },
  };
  if (base?.agenda && def.agenda.uses === base.agenda.uses) { def.agenda.params = clone(base.agenda.params || {}); def.agenda.rules = clone(base.agenda.rules || []); }
  return { schema: BUNDLE_SCHEMA, kind: 'monster', id, name, version: def.version, ...(prior?.base_id || base ? { base_id: prior?.base_id || id } : {}),
    source: source(model, idea), monster: def, place: null, touches: {} };
}

// ---- autoFix: links the model need not think about -----------------------------------------------------------------
const villagesOf = (m, race) => Object.entries(m.village).filter(([, v]) => v.race === race);
// A free hex of a village: not a building, not a resident, within `max` of the centre (and `min` away), nearest first.
function freeHex(v, { min = 1, max = v.radius, avoid = [] } = {}) {
  const used = new Set([...(v.layout || []).map(l => String(l.at)), ...(v.residents || []).map(r => String(r.at)), ...avoid.map(String)]);
  const gate = v.wall?.gate;
  for (let d = min; d <= max; d++) for (let q = -d; q <= d; q++) for (let r = -d; r <= d; r++) {
    if (hexDist([q, r]) !== d || used.has(`${q},${r}`)) continue;
    if (gate && Math.max(Math.abs(q - gate[0]), Math.abs(r - gate[1]), Math.abs(q + r - gate[0] - gate[1])) <= 1) continue;
    return [q, r];
  }
  return null;
}
// The art: the picked look-alike NPC's sprite set (d.resources = { npc: id }), else a same-race NPC of the role.
export function npcArt(m, npc, pickNpc = null) {
  const from = (pickNpc && m.npc[pickNpc]) || Object.values(m.npc).find(o => o.race === npc.race && o.role === npc.role && o.id !== npc.id) || Object.values(m.npc).find(o => o.race === npc.race && o.id !== npc.id);
  return from?.card?.resources ? { resources: clone(from.card.resources), from: from.id } : null;
}
export function buildingArt(m, bld, pickBld = null) {
  const from = (pickBld && m.building[pickBld]) || Object.values(m.building).find(o => o.race === bld.race && o.role === bld.role && o.id !== bld.id) || Object.values(m.building).find(o => o.race === bld.race && o.id !== bld.id);
  return from?.card?.resources ? { resources: clone(from.card.resources), from: from.id } : null;
}

/** The editor's "looks like" pick ({ npc | building: id }) on a bundle, without a regeneration. → the id used or null. */
export function gmLook(b, pick, { m = models() } = {}) {
  const d = b?.npc || b?.building;
  if (!d) return null;
  const art = b.npc ? npcArt(m, d, pick?.npc) : buildingArt(m, d, pick?.building);
  if (!art) return null;
  d.card = { ...(d.card || {}), resources: art.resources };
  return art.from;
}

export function autoFixNpc(b, { m = models(), pick = null } = {}) {
  const fixed = [];
  const n = b.npc;
  const lib = Object.values(m.lib)[0] || { agendas: {} };
  const likeRole = Object.values(m.npc).find(o => o.race === n.race && o.role === n.role && o.id !== n.id);
  if (!n.agenda || !lib.agendas?.[n.agenda.uses]) { n.agenda = { uses: likeRole?.agenda?.uses || (lib.agendas?.[n.role] ? n.role : 'villager'), params: n.agenda?.params || {}, rules: [] }; fixed.push(`agenda uses ${n.agenda.uses}`); }
  if (n.agenda.rules?.length && n.agenda.rules[n.agenda.rules.length - 1]?.when !== true) { n.agenda.rules = []; fixed.push('dropped agenda rules without a final when: true (the library agenda decides)'); }
  // the engine's own questions (who are you, news, …) are asked by the role already: a topic with such an id is dropped
  if (n.talk?.length) {
    const ids = new Set();
    const keep = n.talk.filter(t => !TALK_RESERVED.includes(t.id) && !ids.has(t.id) && ids.add(t.id));
    if (keep.length !== n.talk.length) { fixed.push(`dropped talk ${n.talk.filter(t => !keep.includes(t)).map(t => t.id).join(', ')} (the engine's own question / a repeat)`); n.talk = keep; }
    if (!n.talk.length) delete n.talk;
  }
  if (n.role === 'wanderer') { if (n.home !== null) { n.home = null; fixed.push('a wanderer has no home'); } }
  else if (!m.building[n.home] || m.building[n.home].race !== n.race) {
    const h = likeRole?.home || (m.race[n.race]?.buildings || [])[0] || null;
    n.home = h; fixed.push(`home = ${h}`);
  }
  const known = (() => { try { return knownIds(); } catch { return null; } })();
  if (known) {
    const keep = n.unit.deck_effects.filter(fx => known.effects.has(fx));
    if (keep.length !== n.unit.deck_effects.length) fixed.push(`dropped unknown deck effects ${n.unit.deck_effects.filter(fx => !known.effects.has(fx)).join(', ')}`);
    n.unit.deck_effects = keep.length ? keep : (likeRole?.unit?.deck_effects || []).slice();
  }
  const life = Math.round(STATS.reduce((a, k) => a + n.unit.stats[k], 0) / 10);
  if (n.unit.life !== life) { n.unit.life = life; fixed.push('unit.life = round(Σstats/10)'); }
  n.card = n.card || { name: n.name, tags: ['npc', n.role], resources: null };
  n.card.name = n.name; n.card.tags = ['npc', n.role];
  const art = (pick?.npc || !n.card.resources?.sprites?.idle?.path) ? npcArt(m, n, pick?.npc) : null;
  if (art) { n.card.resources = art.resources; fixed.push(`looks like ${art.from}`); }
  for (const q of b.quests) {
    if (!q.need) { q.need = { some: [{ var: 'player.archive' }, { '==': [{ var: 'kind' }, 'effect'] }] }; fixed.push(`${q.id}: need = any effect card`); }
    q.rewards = q.rewards.filter(x => REWARDS.includes(x.kind));
    if (!q.rewards.some(x => x.kind === 'reputation')) { q.rewards.unshift({ kind: 'reputation', value: 5 }); fixed.push(`${q.id}: +5 reputation reward`); }
    for (const x of q.rewards) if (x.kind === 'allies') { x.units = (x.units || []).filter(u => m.npc[u]?.race === n.race || u === n.id); x.count = Math.max(1, Math.min(x.units.length || 1, Number(x.count) || 1)); }
    q.rewards = q.rewards.filter(x => x.kind !== 'allies' || x.units.length);
  }
  // place: a village of the race; resident / outside → a free hex; wanderer → the wanderers list
  const vils = villagesOf(m, n.race);
  let vid = b.place?.village && m.village[b.place.village]?.race === n.race ? b.place.village : (vils.find(([, v]) => !v.size) || vils[0])?.[0];
  if (vid !== b.place?.village) fixed.push(`placed in ${vid}`);
  if (vid) {
    const post = n.role === 'wanderer' ? 'wanderer' : (b.place?.post === 'outside' && m.village[vid].wall ? 'outside' : b.place?.post === 'wanderer' ? 'resident' : b.place?.post || 'resident');
    b.place = { village: vid, post };
    const v = clone(m.village[vid]);
    const was = JSON.stringify(v);
    if (post === 'wanderer') {
      v.wanderers = v.wanderers || { ring: [50, 100], npcs: [] };
      if (!v.wanderers.npcs.includes(n.id)) v.wanderers.npcs.push(n.id);
    } else if (!(v.residents || []).some(r => r.npc === n.id)) {
      const w = v.wall, cr = v.clear_radius ?? v.radius + 3;
      const at = post === 'outside' && w ? freeHex(v, { min: w.radius + 1, max: cr }) : freeHex(v, { min: 1, max: v.radius });
      if (at) {
        v.residents = [...(v.residents || []), { npc: n.id, at, ...(post === 'outside' ? { post: 'outside' } : {}) }];
        if (v.residents.length > v.cap) { v.cap = Math.min(20, v.residents.length); }
        b.place.at = at;
      } else fixed.push(`no free hex in ${vid}`);
    }
    if (JSON.stringify(v) !== was) { v.version = bump(m.village[vid].version); b.touches.village = v; }
  }
  const race = clone(m.race[n.race]);
  if (race && !(race.npcs || []).includes(n.id)) { race.npcs = [...(race.npcs || []), n.id]; race.version = bump(m.race[n.race].version); b.touches.race = race; }
  b.id = n.id; b.name = n.name; b.version = n.version;
  return fixed;
}

export function autoFixBuilding(b, { m = models(), pick = null } = {}) {
  const fixed = [];
  const d = b.building;
  if (d.produces && m.npc[d.produces.npc]?.race !== d.race) { d.produces = null; fixed.push('dropped produces (an npc of another race / unknown)'); }
  d.card = d.card || { name: d.name, tags: ['building', d.role], resources: null };
  d.card.name = d.name; d.card.tags = ['building', d.role];
  const art = (pick?.building || !d.card.resources?.sprites?.base) ? buildingArt(m, d, pick?.building) : null;
  if (art) { d.card.resources = art.resources; fixed.push(`looks like ${art.from}`); }
  const vils = villagesOf(m, d.race);
  const vid = b.place?.village && m.village[b.place.village]?.race === d.race ? b.place.village : (vils.find(([, v]) => !v.size) || vils[0])?.[0];
  if (vid && vid !== b.place?.village) fixed.push(`placed in ${vid}`);
  if (vid) {
    b.place = { village: vid };
    const v = clone(m.village[vid]);
    if (!(v.layout || []).some(l => l.building === d.id)) {
      const at = freeHex(v, { min: 2, max: v.radius });
      if (at) { v.layout = [...(v.layout || []), { building: d.id, at }]; v.version = bump(m.village[vid].version); b.touches.village = v; b.place.at = at; }
      else fixed.push(`no free hex in ${vid}`);
    }
  }
  const race = clone(m.race[d.race]);
  if (race && !(race.buildings || []).includes(d.id)) { race.buildings = [...(race.buildings || []), d.id]; race.version = bump(m.race[d.race].version); b.touches.race = race; }
  b.id = d.id; b.name = d.name; b.version = d.version;
  return fixed;
}

// The art: the picked look-alike monster's unit (sprites + sounds), else one of its race with a shared tag, else any.
export function monsterArt(m, mo, pickMon = null) {
  const others = Object.values(m.monster).filter(o => o.id !== mo.id && o.card?.resources?.sprites);
  const shares = (o) => (o.card.tags || []).some(t => mo.card.tags.includes(t));
  const from = (pickMon && m.monster[pickMon]?.card?.resources ? m.monster[pickMon] : null) || others.find(o => o.race === mo.race && shares(o))
    || others.find(o => o.race === mo.race) || others.find(shares) || others[0];
  return from ? { resources: clone(from.card.resources), from: from.id, race: from.race } : null;
}
export function autoFixMonster(b, { m = models(), pick = null } = {}) {
  const fixed = [];
  const mo = b.monster, d = mo.card.data;
  const agendas = monsterAgendas(m);
  if (!agendas.includes(mo.agenda.uses)) {
    const was = mo.agenda.uses;
    mo.agenda = { uses: mo.card.tags.includes('pack') && agendas.includes('monster_pack') ? 'monster_pack' : agendas.includes('monster_skirmisher') ? 'monster_skirmisher' : agendas[0], params: {}, rules: [] };
    fixed.push(`agenda uses ${mo.agenda.uses}${was ? ` (not ${was})` : ''}`);
  }
  const baseTags = (b.base_id && m.monster[b.base_id]?.card?.tags) || [];
  const tags = mo.card.tags.filter(t => MONSTER_TAGS.includes(t) || baseTags.includes(t));
  if (tags.length !== mo.card.tags.length) fixed.push(`dropped tags ${mo.card.tags.filter(t => !tags.includes(t)).join(', ')}`);
  mo.card.tags = tags.length ? tags : ['brute'];
  const known = (() => { try { return knownIds(); } catch { return null; } })();
  if (known) {
    const keep = [...new Set(d.deck_effects)].filter(fx => known.effects.has(fx));
    if (keep.length !== d.deck_effects.length) fixed.push(`dropped deck effects ${d.deck_effects.filter(fx => !keep.includes(fx)).join(', ') || '(repeats)'}`);
    d.deck_effects = keep;
    if (d.innate_effect && !known.effects.has(d.innate_effect)) { fixed.push(`dropped unknown innate effect ${d.innate_effect}`); d.innate_effect = null; delete d.innate_effect_text; }
  }
  const life = Math.round(sumStats(d.stats) / 10);
  if (d.life !== life) { d.life = life; fixed.push('life = round(Σstats/10)'); }
  mo.card.name = mo.name;
  const art = (pick?.monster || !mo.card.resources?.sprites?.idle?.path) ? monsterArt(m, mo, pick?.monster) : null;
  if (art) { mo.card.resources = art.resources; fixed.push(`looks like ${art.from}`); if (pick?.monster || !artRaces(m).includes(mo.race)) mo.race = art.race; }
  if (!artRaces(m).includes(mo.race) && mo.card.resources?.wbc3_race) { mo.race = mo.card.resources.wbc3_race; fixed.push(`race = ${mo.race} (its look)`); }
  b.id = mo.id; b.name = mo.name; b.version = mo.version;
  return fixed;
}
// The logic layer on the card: the creatures collection + entry rules — only the failures the card it changes does not
// have already — and the power score (an edit: ±15 % of the base; a new one: inside the existing monsters' range).
export function monsterBalance(b, { m = models() } = {}) {
  const mo = b.monster, d = mo.card.data;
  const out = { problems: [], power: null, base_power: null, range: null };
  let e;
  try { e = logicEngine(); } catch { return out; }
  const base = b.base_id ? m.monster[b.base_id] : null;
  const prop = { version: mo.card.version, status: 'proposal', weight: 0, origin: 'player_vote', parent_version: base?.card?.version || null, data: d };
  const inCatalog = !!base && e.catalog.has(base.id);
  const run = (p) => { try { return e.validateProposal('creatures', inCatalog ? base.id : null, p, inCatalog ? {} : { newEntry: { id: mo.id, name: mo.name, tags: mo.card.tags } }).failures; } catch (x) { return [{ scope: 'engine', id: 'engine', description: x.message }]; } };
  const had = new Set(base ? run({ ...prop, data: base.card.data, version: `${prop.version}-base` }).map(f => `${f.scope}:${f.id}`) : []);
  for (const f of run(prop)) if (!had.has(`${f.scope}:${f.id}`) && f.id !== 'id_taken') out.problems.push(`${mo.id}: ${f.description || f.id}`);
  // a NEW monster has no entry rules of its own: the shape / affordability asserts every monster card shares, from one
  if (!inCatalog) {
    const like = genMonsters(m).find(o => e.catalog.has(o.id));
    const asserts = (like ? e.entryContext(like.id)?.logic?.validation || [] : []).filter(v => NEW_MONSTER_ASSERTS.includes(v.id));
    for (const v of asserts) {
      try { if (!e.evaluate(v.assert, { proposal: prop, entry: { data: d }, collection: 'creatures' })) out.problems.push(`${mo.id}: ${v.description || v.id}`); }
      catch (x) { out.problems.push(`${mo.id}: ${v.id} — ${x.message}`); }
    }
  }
  out.power = monsterPower(d);
  if (typeof out.power !== 'number') return out;
  if (base) {
    out.base_power = monsterPower(base.card.data);
    if (typeof out.base_power === 'number' && !e.withinTolerance(out.base_power, out.power)) out.problems.push(`${mo.id}: power ${out.power} is not within ±15 % of ${base.name}'s ${out.base_power} — move the stats / actions back toward it`);
  } else {
    out.range = monsterPowerRange(m);
    const [lo, hi] = out.range;
    if (out.power < lo || out.power > hi) out.problems.push(`${mo.id}: power ${out.power} is outside the monsters' range ${lo}..${hi} — ${out.power > hi ? 'lower the stats or the actions per round' : 'raise the stats or give it more actions'}`);
  }
  return out;
}

// ---- check: the GameModels check on the repo with the bundle laid over it -------------------------------------------
/** The definitions of a bundle: [[kind, def]] (the npc + quests / the building, then the village and race it changes). */
export function bundleDefs(b) {
  const out = [];
  if (b?.npc) out.push(['npc', b.npc]);
  for (const q of b?.quests || []) out.push(['quest', q]);
  if (b?.building) out.push(['building', b.building]);
  if (b?.monster) out.push(['monster', b.monster]);
  if (b?.touches?.village) out.push(['village', b.touches.village]);
  if (b?.touches?.race) out.push(['race', b.touches.race]);
  return out;
}
export function overlay(m, b) {
  const o = { ...m, errors: [...(m.errors || [])] };
  for (const k of Object.keys(KINDS)) o[k] = { ...(m[k] || {}) };
  // an edit that drops a quest of the base NPC: the quest goes too (else the check reports it orphaned)
  const base = b?.base_id && b.npc ? m.npc[b.base_id] : null;
  for (const q of base?.quests || []) if (!b.npc.quests.includes(q)) delete o.quest[q];
  for (const [kind, def] of bundleDefs(b)) o[kind][def.id] = def;
  return o;
}
/** → { ok, verdict, problems[], check } (the generateDef shape). */
export function checkBundle(b, { m = models(), assetFile = null } = {}) {
  if (!b || b.schema !== BUNDLE_SCHEMA) return { ok: false, verdict: 'reject', problems: ['not a GameModels draft'], check: null };
  const ids = new Set(bundleDefs(b).map(([, d]) => d.id));
  const before = new Set(checkGameModels(m, { known: safeKnown(), assetFile }));
  const all = checkGameModels(overlay(m, b), { known: safeKnown(), assetFile });
  const mine = all.filter(line => !before.has(line) && (ids.has(line.split(':')[0]) || [...ids].some(id => line.includes(id))));
  const problems = [...new Set(mine)].slice(0, 20);
  if (b.npc) {
    const n = b.npc;
    if (!n.persona) problems.push(`${n.id}: persona needed (one sentence)`);
    if (!Object.values(n.lines || {}).flat().length) problems.push(`${n.id}: no lines`);
    if (['storyteller', 'wanderer'].includes(n.role) && !(n.lines?.lore?.length || n.talk?.length)) problems.push(`${n.id}: a ${n.role} needs lore lines or talk topics`);
    if (!b.place?.village) problems.push(`${n.id}: placed in no village (it would never appear)`);
  }
  if (b.building && !b.building.text) problems.push(`${b.building.id}: text needed`);
  let balance = null;
  if (b.monster) {
    const mo = b.monster;
    if (!mo.temper || mo.temper.length < 20) problems.push(`${mo.id}: temper needed (1-2 sentences the player reads)`);
    const want = deckRule().thematic || 4;
    if (mo.card.data.deck_effects.length !== want) problems.push(`${mo.id}: deck_effects needs exactly ${want} known effect ids (has ${mo.card.data.deck_effects.length})`);
    balance = monsterBalance(b, { m });
    const counted = problems.some(p => p.includes('deck_effects needs exactly'));   // the clearer line of the same rule
    problems.push(...balance.problems.filter(p => !(counted && p.includes('monster_deck_effects_valid'))));
  }
  return { ok: !problems.length, verdict: problems.length ? 'reject' : 'ok', problems, check: balance ? { power: balance.power, base_power: balance.base_power, range: balance.range } : null };
}
const safeKnown = () => { try { return knownIds(); } catch { return null; } };

// ---- edit an existing definition ---------------------------------------------------------------------------------
/** The bundle of a repo NPC / building (its quests too), as the prior of an edit. */
export function bundleFromRepo(kind, id, { m = models() } = {}) {
  if (kind === 'npc') {
    const n = m.npc[id];
    if (!n) return null;
    const vil = Object.entries(m.village).find(([, v]) => (v.residents || []).some(r => r.npc === id) || (v.wanderers?.npcs || []).includes(id));
    const post = vil ? ((vil[1].wanderers?.npcs || []).includes(id) ? 'wanderer' : (vil[1].residents.find(r => r.npc === id).post === 'outside' ? 'outside' : 'resident')) : 'resident';
    return { schema: BUNDLE_SCHEMA, kind: 'npc', id, name: n.name, version: n.version, base_id: id, source: { collection: 'gamemodels', id }, npc: clone(n),
      quests: (n.quests || []).map(q => m.quest[q]).filter(Boolean).map(clone), place: vil ? { village: vil[0], post } : null, touches: {} };
  }
  if (kind === 'building') {
    const d = m.building[id];
    if (!d) return null;
    const vil = Object.entries(m.village).find(([, v]) => (v.layout || []).some(l => l.building === id));
    return { schema: BUNDLE_SCHEMA, kind: 'building', id, name: d.name, version: d.version, base_id: id, source: { collection: 'gamemodels', id }, building: clone(d), place: vil ? { village: vil[0] } : null, touches: {} };
  }
  if (kind === 'monster') {
    const mo = m.monster[id];
    if (!mo || mo.schema !== 'chaosd6.monster/2') return null;
    return { schema: BUNDLE_SCHEMA, kind: 'monster', id, name: mo.name, version: mo.version, base_id: id, source: { collection: 'gamemodels', id }, monster: clone(mo), place: null, touches: {} };
  }
  return null;
}
/** What the editor lists to start from: [{ kind, id, name, race, role }] (a monster: role = its tags). */
export function catalogForEdit({ m = models() } = {}) {
  return [
    ...Object.values(m.npc).filter(n => n.role !== 'builder').map(n => ({ kind: 'npc', id: n.id, name: n.name, race: n.race, role: n.role })),
    ...Object.values(m.building).filter(b => b.role !== 'centre').map(b => ({ kind: 'building', id: b.id, name: b.name, race: b.race, role: b.role })),
    ...genMonsters(m).map(mo => ({ kind: 'monster', id: mo.id, name: mo.name, race: mo.race, role: (mo.card.tags || []).join(', ') })),
  ];
}

// ---- the generateDef specs -----------------------------------------------------------------------------------------
export function gmSpec(kind, { dir = GAMEMODELS_DIR, pick = null } = {}) {
  const m = () => models(dir);
  if (kind === 'npc') return {
    kind: 'npc', expect: 900,
    systemPrompt: () => npcSystemPrompt({ dir }), answerSchema: npcAnswerSchema, strip: stripBundle,
    assemble: (raw, o) => assembleNpc(raw, { ...o, m: m() }), autoFix: (b) => autoFixNpc(b, { m: m(), pick }),
    taken: () => takenIds(m()), check: (b) => checkBundle(b, { m: m() }),
  };
  if (kind === 'building') return {
    kind: 'building', expect: 300,
    systemPrompt: () => buildingSystemPrompt({ dir }), answerSchema: buildingAnswerSchema, strip: stripBundle,
    assemble: (raw, o) => assembleBuilding(raw, { ...o, m: m() }), autoFix: (b) => autoFixBuilding(b, { m: m(), pick }),
    taken: () => takenIds(m()), check: (b) => checkBundle(b, { m: m() }),
  };
  if (kind === 'monster') return {
    kind: 'monster', expect: 350,
    systemPrompt: () => monsterSystemPrompt({ dir }), answerSchema: monsterAnswerSchema, strip: stripBundle,
    assemble: (raw, o) => assembleMonster(raw, { ...o, m: m() }), autoFix: (b) => autoFixMonster(b, { m: m(), pick }),
    taken: () => takenIds(m()), check: (b) => checkBundle(b, { m: m() }),
  };
  throw new Error(`no GameModels generator for ${kind}`);
}
/** generateGameModel({ kind, idea, cfg, prior, changes, onProgress, log, pick }) → the generateDef result. */
export function generateGameModel({ kind, pick = null, dir = GAMEMODELS_DIR, ...o }) {
  if (!dir) return Promise.resolve({ ok: false, error: 'no chaosD6-GameModels checkout on this node', tries: [] });
  return generateDef(gmSpec(kind, { dir, pick }), o);
}
export { HERE as GM_GEN_HERE };
