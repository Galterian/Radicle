// Player profiles (user ruling 2026-11-13). A profile is the player's list of
// characters + their team, kept in the app's private data folder:
//   desktop (WSL2 / Linux)  $XDG_DATA_HOME/chaosd6/profile.json  (default ~/.local/share/chaosd6)
//   mobile                  $CHAOSD6_USER_DATA_DIR/profile.json   (Godot user://data)
//   override                $CHAOSD6_PROFILE_DIR (tests)
// Later the profile moves to Radicle; until then this file is the only copy.
//
// A character:
//   { id, name, created_at, team, locked,
//     base_character   data/characters.json id the peer reads the rest of the data from
//     stats            { vitality, world, matter, will } — Σ = 40, each 1..30
//     class_id         data/classes.json id, or a foreign class id with
//     class_ref        its handshake ref {id, sha256, libs, …} (CH: a player-branch class of chaosD6-Classes)
//     resources        { kind: 'character'|'creature', id } — the Warlords III Battlecry unit whose
//                      sprites / portrait / sounds this character uses
//     combo            3 letters of A/B/M/P with at least two A/B (BAM, APB, AMA …)
//     actions          { A, B, M, P } — action cards in the deck (any count)
//     cards            [{ uid, kind: 'skill'|'effect', id, where: 'deck'|'archive', from?, ref?, source? }]
//                      ref: a FOREIGN (player-branch) card's handshake ref {id, sha256, libs, repo?, branch?, commit?,
//                      name?, verdict?} (FXG) — the peer rebuilds it from the content cache / a fetch; source = ref (UI badge)
//     deaths, kills }
// Created: 4 random skills + 10 random effects; the player edits stats, class and resources
// once, then `locked` — afterwards only the deck (actions, deck vs archive) can change.
// Deck = Σ actions + cards in the deck, at least DECK_MIN.
// Death (user ruling 2026-11-13): the dead character drops one random non-action card from its
// deck (from the profile — future games lose it); it goes to the killer's archive.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { playableEffects, EFFECT_RULES, builtinEffectCatalog } from './effects.mjs';
import { fancyLabel } from './js/names.js';
import { readCollection } from './defs-collection.mjs';
import { SKILLS_IMPLEMENTED, NEGATING_SKILLS, TRANCE, builtinSkillCatalog } from './skills.mjs';   // S1; skill isolation: + builtinSkillCatalog

// S1: the skills the resolver plays, the negating ones and Battle Trance come from skills.mjs (SKILL_RULES).
export const PROFILE_SKILLS = [...SKILLS_IMPLEMENTED];
const TRANCE_SKILL = TRANCE;
export const STAT_KEYS = ['vitality', 'world', 'matter', 'will'];
export const STAT_SUM = 40, STAT_MIN = 1, STAT_MAX = 30;
export const DECK_MIN = 15, ACTION_MAX = 30;
export const ACTION_CODES = ['A', 'B', 'M', 'P'];
export const SKILL_COUNT = 4, EFFECT_COUNT = 10;
export const LIMITS = { STAT_KEYS, STAT_SUM, STAT_MIN, STAT_MAX, DECK_MIN, ACTION_MAX, ACTION_CODES, SKILL_COUNT, EFFECT_COUNT };

// ---------------------------------------------------------------------------------------------
// Storage
export function profileDir() {
  if (process.env.CHAOSD6_PROFILE_DIR) return process.env.CHAOSD6_PROFILE_DIR;
  if (process.env.CHAOSD6_USER_DATA_DIR) return process.env.CHAOSD6_USER_DATA_DIR;
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'chaosd6');
}
export const profilePath = () => path.join(profileDir(), 'profile.json');

const emptyProfile = () => ({ version: 1, team_name: '', team_order: [], characters: [] });
export function loadProfile(file = profilePath()) {
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { p = emptyProfile(); }
  p.version ??= 1; p.team_name ??= ''; p.characters ??= []; p.team_order ??= [];
  // The order holds every character exactly once (new ones at the end).
  const ids = new Set(p.characters.map(c => c.id));
  p.team_order = p.team_order.filter((id, i, a) => ids.has(id) && a.indexOf(id) === i);
  for (const c of p.characters) if (!p.team_order.includes(c.id)) p.team_order.push(c.id);
  for (const c of p.characters) {
    c.team = p.team_name;
    // Taken before the "new" mark existed: still unseen.
    for (const x of c.cards || []) if (x.from && x.new === undefined) x.new = true;
  }
  return p;
}
export const newCardCount = (c) => (c?.cards || []).filter(x => x.new).length;
export function saveProfile(p, file = profilePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, file);   // atomic: a peer and the launcher may both write
}
// Read-modify-write in one go (peers write on death / kill while the launcher may be open).
// Every character the edit changed gets rev+1 / updated_at: the Radicle sync (profile-radicle.mjs) merges
// devices per character by them.
export function updateProfile(fn, file = profilePath()) {
  const p = loadProfile(file);
  const before = new Map(p.characters.map(c => [c.id, JSON.stringify(c)]));
  const out = fn(p);
  const now = new Date().toISOString();
  for (const c of p.characters) {
    if (before.get(c.id) === JSON.stringify(c)) continue;
    c.rev = (c.rev | 0) + 1; c.updated_at = now;
  }
  saveProfile(p, file);
  return out;
}
export const characterOf = (p, id) => p.characters.find(c => c.id === id) || null;
export const topCharacter = (p) => characterOf(p, p.team_order[0]) || p.characters[0] || null;
// The team in priority order (top first), `n` of them.
export const teamCharacters = (p, n = Infinity) => p.team_order.map(id => characterOf(p, id)).filter(Boolean).slice(0, n);

// ---------------------------------------------------------------------------------------------
// Catalogue (what a character may be made of) — from data/*.json, active versions only.
function pickActive(entry) {
  const live = (entry.versions || []).filter(v => v.status !== 'rejected' && v.status !== 'superseded');
  live.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const v = live[0] ?? entry.versions?.[0];
  return { id: entry.id, name: entry.name, tags: entry.tags || [], data: v?.data || {}, resources: entry.resources || null,
    source: entry.source || v?.data?.source || null };   // chaosD6-Effects / chaosD6-Skills provenance (js/effect_source.js contract)
}
const _catalogs = new Map();
export function loadCatalog(dataDir) {
  if (_catalogs.has(dataDir)) return _catalogs.get(dataDir);
  const read = (n) => Object.fromEntries(readCollection(dataDir, n).entries.map(e => [e.id, pickActive(e)]));   // split A: creatures from the GameModels catalog
  const characters = read('characters'), creatures = read('creatures'), classes = read('classes'), skills = Object.fromEntries(builtinSkillCatalog().entries.map(e => [e.id, pickActive(e)])), effects = Object.fromEntries(builtinEffectCatalog().entries.map(e => [e.id, pickActive(e)]));   // F9 / skill isolation: effect + skill cards = definitions
  const portraitOf = (r) => r?.portrait?.path || r?.sprites?.info?.path || null;
  const soundOf = (r) => r?.sounds?.select?.[0]?.path || r?.sounds?.ready?.[0]?.path || r?.sounds?.order?.[0]?.path || null;
  // every voice line of the unit (user 2026-11-23: ▶ plays them one after another, click again and again)
  const soundsOf = (r) => ['select', 'ready', 'order'].flatMap(k => (Array.isArray(r?.sounds?.[k]) ? r.sounds[k] : []).filter(s => s?.path).map(s => ({ path: s.path, kind: k, ...(s.quote ? { line: String(s.quote) } : {}) })));
  const units = [
    ...Object.values(characters).map(e => ({ kind: 'character', ...e })),
    ...Object.values(creatures).map(e => ({ kind: 'creature', ...e })),
  ].filter(e => e.resources?.sprites && Object.keys(e.resources.sprites).length)
    .map(e => ({ kind: e.kind, id: e.id, name: e.name, unit: e.resources.wbc3_name || e.name, race: e.resources.wbc3_race || '', portrait: portraitOf(e.resources), sound: soundOf(e.resources), sounds: soundsOf(e.resources), idle: e.resources.sprites.idle?.path || null }));
  const cat = {
    characters, creatures, classes, skills, effects, units,
    skillIds: PROFILE_SKILLS.filter(id => skills[id]),
    effectIds: playableEffects(effects).sort(),
  };
  _catalogs.set(dataDir, cat);
  return cat;
}
// The catalogue as the UI needs it (small). `p` (the profile): its team's published custom classes join the class list
// (user 2026-11-23: a new character may take one; custom: true + the ref the peer boots it from + its unit voice).
export function catalogForUI(cat, p = null) {
  return {
    limits: LIMITS,
    classes: [...Object.values(cat.classes).map(c => ({ id: c.id, name: c.name, text: c.data.text || '', kind: c.data.ability_kind || '', colors: c.data.colors || [] })),
      ...customClassesOf(p).filter(x => !cat.classes[x.id]).map(x => ({ id: x.id, name: x.name, text: x.text, kind: x.kind, colors: x.colors, custom: true, ref: x.ref, voice: x.voice || [] }))],
    units: cat.units,
    // The flags the in-game hand shows (peer.mjs makeSkillCard / makeEffectCard + main.js card chips).
    skills: cat.skillIds.map(id => {
      const s = cat.skills[id];
      return { id, name: s.name, text: s.data.text || '', action_type: id === TRANCE_SKILL ? '*' : s.data.action_type || '', permanent: !!s.data.is_permanent,
        negating: NEGATING_SKILLS.has(id), point_buy_stat: s.data.point_buy_stat || null, tags: s.tags || [],
        source: s.source || null };   // chaosD6-Skills provenance (js/effect_source.js contract)
    }),
    effects: cat.effectIds.map(id => {
      const e = cat.effects[id], rule = EFFECT_RULES[id] || {};
      const types = Array.isArray(e.data.effect_types) ? e.data.effect_types : [];
      return { id, name: e.name, text: e.data.text || '', elements: e.data.element_cost || [], permanent: !!rule.permanent,
        damage: !!rule.damage, point_buy: rule.damage === 'pointbuy', instant: types.includes('instant'), channel: types.includes('channel'),
        tile_target: !!rule.tileTarget, tags: e.tags || [], source: e.source || null };
    }),
    base_characters: Object.values(cat.characters).map(c => ({ id: c.id, name: c.name })),
  };
}

// ---------------------------------------------------------------------------------------------
// Generation + validation
const uid = () => `c_${randomBytes(4).toString('hex')}`;
const pick = (list, rnd) => list[Math.floor(rnd() * list.length)];
function shuffle(list, rnd) { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export const comboValid = (combo) => Array.isArray(combo) && combo.length === 3 && combo.every(c => ACTION_CODES.includes(c)) && combo.filter(c => c === 'A' || c === 'B').length >= 2;
export function randomCombo(rnd = Math.random) {
  for (;;) { const c = [0, 1, 2].map(() => pick(ACTION_CODES, rnd)); if (comboValid(c)) return c; }
}
export function randomStats(rnd = Math.random) {
  const s = Object.fromEntries(STAT_KEYS.map(k => [k, 4]));
  for (let left = STAT_SUM - 16; left > 0;) { const k = pick(STAT_KEYS, rnd); if (s[k] < STAT_MAX) { s[k] += 1; left -= 1; } }
  return s;
}
export const deckSize = (c) => ACTION_CODES.reduce((a, k) => a + (c.actions?.[k] | 0), 0) + (c.cards || []).filter(x => x.where === 'deck').length;

// A fresh, fully random character (not saved): the editable template of "Create a new character".
export function newDraft(cat, p = null, rnd = Math.random) {
  const unit = pick(cat.units, rnd);
  const base = cat.characters[unit.id] ? unit.id : pick(Object.keys(cat.characters), rnd);
  const combo = randomCombo(rnd);
  const skills = shuffle(cat.skillIds, rnd).slice(0, SKILL_COUNT);
  const effects = shuffle(cat.effectIds, rnd).slice(0, EFFECT_COUNT);
  const actions = { A: 2, B: 2, M: 2, P: 2 };
  for (const k of combo) actions[k] += 1;
  const taken = new Set((p?.characters || []).map(c => c.name));
  return {
    id: `pc_${randomBytes(4).toString('hex')}`, name: fancyLabel(taken, rnd), created_at: new Date().toISOString(),
    team: p?.team_name || '', locked: false, base_character: base,
    stats: randomStats(rnd), class_id: pick(Object.keys(cat.classes), rnd), resources: { kind: unit.kind, id: unit.id },
    combo, actions,
    cards: [...skills.map(id => ({ uid: uid(), kind: 'skill', id, where: 'deck' })), ...effects.map(id => ({ uid: uid(), kind: 'effect', id, where: 'deck' }))],
    deaths: 0, kills: 0,
  };
}
export function validateCharacter(c, cat) {
  const err = [];
  if (!c || typeof c !== 'object') return ['no character'];
  if (!String(c.name || '').trim()) err.push('a name is needed');
  const vals = STAT_KEYS.map(k => c.stats?.[k]);
  if (vals.some(v => !Number.isInteger(v) || v < STAT_MIN || v > STAT_MAX)) err.push(`each stat must be a whole number ${STAT_MIN}–${STAT_MAX}`);
  else if (vals.reduce((a, b) => a + b, 0) !== STAT_SUM) err.push(`the four stats must sum to ${STAT_SUM} (now ${vals.reduce((a, b) => a + b, 0)})`);
  // CH: a foreign (player-branch) class carries its handshake ref (class_ref); the peer's classes handshake checks it.
  if (!cat.classes[c.class_id] && !foreignRefOf({ id: c.class_id, ref: c.class_ref })) err.push(`unknown class ${c.class_id}`);
  if (!cat.units.some(u => u.kind === c.resources?.kind && u.id === c.resources?.id)) err.push('unknown unit resources');
  if (!cat.characters[c.base_character]) err.push(`unknown base character ${c.base_character}`);
  if (!comboValid(c.combo)) err.push('the combo needs 3 actions with at least two A/B');
  for (const k of ACTION_CODES) { const n = c.actions?.[k]; if (!Number.isInteger(n) || n < 0 || n > ACTION_MAX) err.push(`${k} cards: 0–${ACTION_MAX}`); }
  for (const x of c.cards || []) {
    if (!['deck', 'archive'].includes(x.where)) err.push(`card ${x.uid}: deck or archive`);
    if (foreignRefOf(x)) continue;   // FXG: a foreign card (won from a kill) is checked by the peer's handshake, not the catalogue
    if (x.kind === 'skill' ? !cat.skills[x.id] : x.kind === 'effect' ? !cat.effects[x.id] : true) err.push(`card ${x.uid}: unknown ${x.kind} ${x.id}`);
  }
  if (deckSize(c) < DECK_MIN) err.push(`the deck needs at least ${DECK_MIN} cards (now ${deckSize(c)})`);
  return err;
}

// ---------------------------------------------------------------------------------------------
// Profile edits (each returns the changed profile or throws Error with a player-readable message)
const fail = (msg) => { const e = new Error(msg); e.status = 400; throw e; };
export function createCharacter(p, draft, cat) {
  const c = structuredClone(draft);
  c.id = c.id && !characterOf(p, c.id) ? c.id : `pc_${randomBytes(4).toString('hex')}`;
  c.name = String(c.name || '').trim().slice(0, 40);
  c.created_at ||= new Date().toISOString();
  c.deaths ??= 0; c.kills ??= 0;
  for (const x of c.cards || []) x.uid ||= uid();
  // a custom class: only one the team published (profile.custom_classes), with ITS ref (not the client's)
  if (!cat.classes[c.class_id]) {
    const cc = customClassesOf(p).find(x => x.id === c.class_id);
    if (!cc) fail(`unknown class ${c.class_id} (a custom class must be one your team published)`);
    c.class_ref = structuredClone(cc.ref);
  } else delete c.class_ref;
  const err = validateCharacter(c, cat);
  if (err.length) fail(err.join('; '));
  // The template from newDraft fixes the 4 skills + 10 effects + combo; the editor may only touch
  // stats / class / resources / name / deck placement — refuse a different card set.
  if ((c.cards || []).filter(x => x.kind === 'skill').length !== SKILL_COUNT || (c.cards || []).filter(x => x.kind === 'effect').length !== EFFECT_COUNT) fail(`a new character has ${SKILL_COUNT} skills and ${EFFECT_COUNT} effects`);
  c.locked = true;
  c.team = p.team_name;
  p.characters.push(c);
  p.team_order.push(c.id);
  return p;
}
// Deck edits only: action counts and where each card sits. Stats / class / resources are locked.
// `seen: [uid…]` clears the "new" mark of cards taken from kills (the editor glows them until tapped).
export function editDeck(p, id, { actions, cards, seen }, cat) {
  const c = characterOf(p, id) || fail('no such character');
  if (Array.isArray(seen)) for (const x of c.cards) if (seen.includes(x.uid)) x.new = false;
  if (!actions && !Array.isArray(cards)) return p;
  const next = structuredClone(c);
  if (actions) for (const k of ACTION_CODES) if (actions[k] !== undefined) next.actions[k] = Number(actions[k]);
  if (Array.isArray(cards)) for (const { uid: u, where } of cards) { const x = next.cards.find(y => y.uid === u); if (x && ['deck', 'archive'].includes(where)) x.where = where; }
  const err = validateCharacter(next, cat);
  if (err.length) fail(err.join('; '));
  Object.assign(c, { actions: next.actions, cards: next.cards });
  return p;
}
export function setTeam(p, { team_name, order }) {
  if (team_name !== undefined) p.team_name = String(team_name).trim().slice(0, 30);
  if (Array.isArray(order)) {
    const ids = new Set(p.characters.map(c => c.id));
    const o = order.filter((id, i, a) => ids.has(id) && a.indexOf(id) === i);
    for (const c of p.characters) if (!o.includes(c.id)) o.push(c.id);
    p.team_order = o;
    p.order_at = new Date().toISOString();
  }
  for (const c of p.characters) c.team = p.team_name;
  return p;
}
export function deleteCharacter(p, id) {
  p.characters = p.characters.filter(c => c.id !== id);
  p.team_order = p.team_order.filter(x => x !== id);
  (p.deleted ||= {})[id] = new Date().toISOString();   // tombstone: other devices drop it on sync
  return p;
}

// ---------------------------------------------------------------------------------------------
// FXG: a foreign card's ref, kept compact ({id, sha256, libs} + provenance), or null (built-in card / no valid ref).
const SHA64 = /^[0-9a-f]{64}$/;
export function foreignRefOf(x) {
  const r = x?.ref;
  if (!r || typeof r !== 'object' || r.id !== x.id || !SHA64.test(String(r.sha256 || '')) || !r.libs || typeof r.libs !== 'object') return null;
  const o = { id: r.id, sha256: r.sha256, libs: { ...r.libs } };
  for (const k of ['repo', 'branch', 'commit', 'name', 'verdict']) if (typeof r[k] === 'string' && r[k]) o[k] = r[k].slice(0, 200);
  return o;
}
// {kind, id} (+ ref for a foreign card): what a death drop / gift / profile card says about a card.
const cardRefOut = (x) => { const ref = foreignRefOf(x); return ref ? { kind: x.kind, id: x.id, ref } : { kind: x.kind, id: x.id }; };

// ---------------------------------------------------------------------------------------------
// Death / kill bookkeeping (called by peer.mjs; writes the profile file)
// The dead character loses one random non-action card from its DECK; returns it ({kind,id}) or null.
export function dropRandomDeckCard(file, charId, rnd = Math.random) {
  return updateProfile(p => {
    const c = characterOf(p, charId);
    if (!c) return null;
    c.deaths = (c.deaths | 0) + 1;
    const inDeck = c.cards.filter(x => x.where === 'deck');
    if (!inDeck.length) return null;
    const lost = pick(inDeck, rnd);
    c.cards = c.cards.filter(x => x !== lost);
    return cardRefOut(lost);   // FXG: + ref for a foreign card
  }, file);
}
// A card taken from a unit I killed lands in my archive.
// kill: false = not a kill reward; custom: true = the team's own published custom card (gen-api.mjs) — the profile
// editor shows it as "New effect type is added" with a custom badge.
export function addArchivedCard(file, charId, card, from = '', { kill = true, custom = false } = {}) {
  return updateProfile(p => {
    const c = characterOf(p, charId);
    if (!c || !['skill', 'effect'].includes(card?.kind) || !card.id) return null;
    if (kill) c.kills = (c.kills | 0) + 1;
    const x = { uid: uid(), kind: card.kind, id: card.id, where: 'archive', from: String(from).slice(0, 60), new: true, taken_at: new Date().toISOString() };
    if (custom) x.custom = true;
    const ref = foreignRefOf(card);   // FXG: a foreign card keeps its ref (rebuilt next session from the cache / a fetch)
    if (ref) { x.ref = ref; x.source = { ...ref, kind: card.kind, ...(custom ? { custom: true } : {}) }; }
    c.cards.push(x);
    return x;
  }, file);
}

// A card I bartered away (GameModels trader, peer.mjs completeQuest consume): the first archived card of that kind + id.
export function removeArchivedCard(file, charId, card) {
  return updateProfile(p => {
    const c = characterOf(p, charId);
    if (!c || !card?.id) return null;
    const i = c.cards.findIndex(x => x.where === 'archive' && x.kind === card.kind && x.id === card.id);
    if (i < 0) return null;
    const [x] = c.cards.splice(i, 1);
    return x;
  }, file);
}

// The team's published custom classes (gen-api.mjs publish of a class, user 2026-11-23: a class is not a card — a NEW
// character may take one). profile.custom_classes = [{ id, name, text, kind, colors, ref, voice, at }]; a valid ref only.
export function customClassesOf(p) {
  return (Array.isArray(p?.custom_classes) ? p.custom_classes : []).filter(x => x && /^class_[a-z0-9_]+$/.test(String(x.id)) && foreignRefOf({ id: x.id, ref: x.ref }));
}
export function addCustomClass(file, def, ref) {
  return updateProfile(p => {
    const r = foreignRefOf({ id: def?.id, ref });
    if (!r) return null;
    const voice = Array.isArray(def.resources?.sounds?.voice) ? def.resources.sounds.voice.slice(0, 16).map(s => ({ path: String(s.path), kind: String(s.kind || ''), ...(s.line ? { line: String(s.line) } : {}) })) : [];
    const x = { id: def.id, name: String(def.name || def.id).slice(0, 80), text: String(def.data?.text || '').slice(0, 600), kind: def.data?.ability_kind || '', colors: [...(def.data?.colors || [])],
      ref: r, voice, ...(def.resources?.unit ? { unit: { race: String(def.resources.unit.race), unit: String(def.resources.unit.unit) } } : {}), at: new Date().toISOString() };
    p.custom_classes = [...customClassesOf(p).filter(y => y.id !== x.id), x];
    return x;
  }, file);
}

// ---------------------------------------------------------------------------------------------
// What a peer process needs to play a profile character (spread into its env).
export function profileEnv(file, c) {
  return { PROFILE_FILE: file, PROFILE_CHAR_ID: c.id, CHARACTER_ID: c.base_character, ENTITY_NAME: c.name, PROFILE_TEAM: c.team || '' };
}

// ---------------------------------------------------------------------------------------------
// HTTP API, shared by the desktop launcher (ui-server.mjs) and the phone's menu (mobile-entry.mjs).
//   GET    /api/profile                      → { profile, limits }
//   GET    /api/profile/catalog              → classes, units, skills, effects, limits
//   POST   /api/profile/draft                → a random, unsaved character template
//   POST   /api/profile/characters           { character } → create (validated, then locked)
//   PUT    /api/profile/characters/<id>      { actions?, cards?: [{uid, where}] } → deck edit
//   DELETE /api/profile/characters/<id>
//   PUT    /api/profile/team                 { team_name?, order?: [id…] }
//   GET    /api/profile/sync                 → Radicle sync status (profile-radicle.mjs), { state: 'off' } without it
//   POST   /api/profile/sync                 → sync now, then the status
//   POST   /api/profile/sync/approve         { id } → add that device to the team's owners
// Returns true when it answered the request.
let _sync = null;
/** The running Radicle sync (profile-radicle.mjs startProfileSync), or null. */
export function attachProfileSync(s) { _sync = s; }
async function readBody(req) {
  let s = '';
  for await (const ch of req) { s += ch; if (s.length > 1e6) break; }
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
export async function handleProfileApi(req, res, urlPath, { file = profilePath(), dataDir }) {
  if (!urlPath.startsWith('/api/profile')) return false;
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const cat = loadCatalog(dataDir);
    const m = req.method;
    if (m === 'GET' && urlPath === '/api/profile') return send(200, { profile: loadProfile(file), limits: LIMITS, file }), true;
    if (m === 'GET' && urlPath === '/api/profile/catalog') return send(200, catalogForUI(cat, loadProfile(file))), true;
    if (m === 'POST' && urlPath === '/api/profile/draft') return send(200, { character: newDraft(cat, loadProfile(file)) }), true;
    if (m === 'POST' && urlPath === '/api/profile/characters') { const b = await readBody(req); return send(200, { profile: updateProfile(p => createCharacter(p, b.character, cat), file) }), true; }
    const cm = /^\/api\/profile\/characters\/([\w-]+)$/.exec(urlPath);
    if (m === 'PUT' && cm) { const b = await readBody(req); return send(200, { profile: updateProfile(p => editDeck(p, cm[1], b, cat), file) }), true; }
    if (m === 'DELETE' && cm) return send(200, { profile: updateProfile(p => deleteCharacter(p, cm[1]), file) }), true;
    if (m === 'PUT' && urlPath === '/api/profile/team') { const b = await readBody(req); return send(200, { profile: updateProfile(p => setTeam(p, b), file) }), true; }
    if (urlPath === '/api/profile/sync' && m === 'GET') return send(200, _sync ? _sync.status() : { state: 'off', message: 'Radicle sync is not running' }), true;
    if (urlPath === '/api/profile/sync' && m === 'POST') return send(200, _sync ? await _sync.syncNow({ requests: true }) : { state: 'off', message: 'Radicle sync is not running' }), true;
    if (urlPath === '/api/profile/sync/approve' && m === 'POST') {
      const b = await readBody(req);
      if (!_sync) fail('Radicle sync is not running');
      return send(200, await _sync.approve(String(b.id || ''))), true;
    }
    send(404, { error: `no ${m} ${urlPath}` });
  } catch (e) { send(e.status || 500, { error: e.message }); }
  return true;
}
