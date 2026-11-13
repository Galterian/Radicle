// Oracles for game/profile.mjs (user ruling 2026-11-13: player profiles). `node tools/profile-check.mjs` → "all profile checks passed".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../profile.mjs';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosd6-profile-'));
const file = path.join(dir, 'profile.json');
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log(`FAIL ${msg}`); } };
const throwsMsg = (fn, re, msg) => { try { fn(); ok(false, `${msg}: did not throw`); } catch (e) { ok(re.test(e.message), `${msg}: ${e.message}`); } };

const cat = P.loadCatalog(dataDir);
ok(cat.units.length >= 30, `units ${cat.units.length}`);
ok(cat.skillIds.length >= 10 && cat.effectIds.length >= 10, 'skill/effect pools');
for (let i = 0; i < 200; i++) ok(P.comboValid(P.randomCombo()), 'random combo valid');
for (let i = 0; i < 200; i++) { const s = P.randomStats(); ok(Object.values(s).reduce((a, b) => a + b, 0) === 40 && Object.values(s).every(v => v >= 1 && v <= 30), 'random stats'); }
ok(!P.comboValid(['M', 'P', 'A']) && P.comboValid(['B', 'A', 'M']) && P.comboValid(['A', 'M', 'A']), 'combo rule');

const d = P.newDraft(cat);
ok(P.validateCharacter(d, cat).length === 0, `draft valid: ${P.validateCharacter(d, cat)}`);
ok(d.cards.filter(c => c.kind === 'skill').length === 4 && d.cards.filter(c => c.kind === 'effect').length === 10, '4 skills 10 effects');

// Create: stats must sum to 40.
const bad = structuredClone(d); bad.stats.vitality += 1;
throwsMsg(() => P.createCharacter(P.loadProfile(file), bad, cat), /sum to 40/, 'stat sum');
P.updateProfile(p => P.setTeam(p, { team_name: 'Gold' }), file);
P.updateProfile(p => P.createCharacter(p, d, cat), file);
const d2 = P.newDraft(cat); P.updateProfile(p => P.createCharacter(p, d2, cat), file);
let p = P.loadProfile(file);
ok(p.characters.length === 2 && p.characters.every(c => c.locked && c.team === 'Gold'), 'created + locked + team');
ok(P.topCharacter(p).id === d.id, 'top = first created');
P.updateProfile(q => P.setTeam(q, { order: [d2.id] }), file);
ok(P.topCharacter(P.loadProfile(file)).id === d2.id, 'team order');

// Deck edits: archive cards, but never below 15.
const c = P.characterOf(P.loadProfile(file), d.id);
const allArchive = c.cards.map(x => ({ uid: x.uid, where: 'archive' }));
throwsMsg(() => P.updateProfile(q => P.editDeck(q, d.id, { cards: allArchive, actions: { A: 1, B: 1, M: 1, P: 1 } }, cat), file), /at least 15/, 'deck min');
P.updateProfile(q => P.editDeck(q, d.id, { cards: allArchive.slice(0, 5), actions: { P: 6 } }, cat), file);
const c2 = P.characterOf(P.loadProfile(file), d.id);
ok(c2.cards.filter(x => x.where === 'archive').length === 5 && c2.actions.P === 6, 'deck edit applied');
ok(JSON.stringify(c2.stats) === JSON.stringify(d.stats) && c2.class_id === d.class_id, 'stats/class unchanged');

// Death: one random DECK card leaves; the killer gets it in its archive.
const before = P.deckSize(c2);
const lost = P.dropRandomDeckCard(file, d.id);
const c3 = P.characterOf(P.loadProfile(file), d.id);
ok(lost && P.deckSize(c3) === before - 1 && c3.deaths === 1, 'death drops a deck card');
const got = P.addArchivedCard(file, d2.id, lost, 'Ridge Runnet');
const k = P.characterOf(P.loadProfile(file), d2.id);
ok(got && k.cards.some(x => x.uid === got.uid && x.where === 'archive') && k.kills === 1, 'kill → archive');
// A card won from a kill is "new" until the editor reports it seen (glows in the profile deck).
ok(P.newCardCount(k) === 1 && k.cards.find(x => x.uid === got.uid).new === true, 'won card is new');
P.updateProfile(q => P.editDeck(q, d2.id, { seen: [got.uid] }, cat), file);
ok(P.newCardCount(P.characterOf(P.loadProfile(file), d2.id)) === 0, 'seen clears new');

// Editor card flags (same as the in-game hand).
const ui = P.catalogForUI(cat);
const sk = Object.fromEntries(ui.skills.map(s => [s.id, s])), ef = Object.fromEntries(ui.effects.map(e => [e.id, e]));
ok(sk.skill_dodge?.action_type === 'M' && sk.skill_dodge.negating && !sk.skill_dodge.permanent, 'dodge flags');
ok(sk.skill_ranged_weapon?.permanent && sk.skill_ranged_weapon.action_type === 'A', 'ranged weapon flags');
ok(sk.skill_battle_trance?.action_type === '*', 'trance any action');
ok(ef.effect_fireball?.damage && !ef.effect_fireball.permanent, 'fireball flags');
ok(ui.effects.some(e => e.permanent) && ui.effects.some(e => e.instant), 'some permanent + instant effects');

const env = P.profileEnv(file, k);
ok(env.PROFILE_CHAR_ID === k.id && env.CHARACTER_ID === k.base_character, 'profile env');
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} profile check(s) FAILED` : 'all profile checks passed');
process.exit(fails ? 1 : 0);
