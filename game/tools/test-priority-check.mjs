// node tools/test-priority-check.mjs — test-priority.mjs (Test Random character: my drafts → my team's published → built-ins)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testPriorityEnv, draftDefs, publishedOfTeam, TEST_PRIORITY_BLANK } from '../test-priority.mjs';

let fails = 0;
const ok = (c, msg) => { if (c) console.log(`ok   ${msg}`); else { fails++; console.log(`FAIL ${msg}`); } };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosd6-prio-'));
const file = path.join(T, 'profile.json');
const ref = (id, n = 'a') => ({ id, sha256: n.repeat(64), libs: { std: 'x' } });
const draft = (n, kind, id, state, at, extra = {}) => {
  const defsDir = path.join(T, `${kind}-drafts`);
  fs.mkdirSync(defsDir, { recursive: true });
  const f = path.join(defsDir, `${id}.json`);
  fs.writeFileSync(f, JSON.stringify({ id }));
  fs.mkdirSync(path.join(T, 'gen-drafts'), { recursive: true });
  fs.writeFileSync(path.join(T, 'gen-drafts', `gen_${n}.json`), JSON.stringify({ draft_id: `gen_${n}`, kind, state, file: f, def: { id, name: id }, updated_at: at, ...extra }));
  return f;
};
const save = (p) => fs.writeFileSync(file, JSON.stringify(p));

save({ characters: [] });
ok(Object.keys(testPriorityEnv(file, { env: {} }).env).length === 0, 'nothing of mine → no env (built-ins only)');

const fc = draft('aaaaaa01', 'class', 'class_old', 'preview', '2026-11-20T00:00:00Z');
const fc2 = draft('aaaaaa02', 'class', 'class_new', 'testing success', '2026-11-22T00:00:00Z');
draft('aaaaaa03', 'class', 'class_gen', 'generating', '2026-11-23T00:00:00Z');
draft('aaaaaa04', 'class', 'class_pub', 'published', '2026-11-23T01:00:00Z', { published: { ok: true } });
const e1 = draft('aaaaaa05', 'effect', 'effect_a', 'preview', '2026-11-21T00:00:00Z');
const e2 = draft('aaaaaa06', 'effect', 'effect_b', 'preview', '2026-11-22T00:00:00Z');
const s1 = draft('aaaaaa07', 'skill', 'skill_a', 'preview', '2026-11-22T00:00:00Z');
ok(draftDefs(file).map(d => d.id).join() === 'class_new,effect_b,skill_a,effect_a,class_old', 'drafts: newest first, generating / published left out');

save({ custom_classes: [{ id: 'class_team', name: 'Team Class', ref: ref('class_team'), at: '2026-11-22T00:00:00Z' }],
  characters: [{ cards: [{ kind: 'effect', id: 'effect_pub', custom: true, ref: ref('effect_pub', 'b') }, { kind: 'effect', id: 'effect_a', custom: true, ref: ref('effect_a', 'c') },
    { kind: 'skill', id: 'skill_won', ref: ref('skill_won', 'd') }] }, { cards: [{ kind: 'effect', id: 'effect_pub', custom: true, ref: ref('effect_pub', 'b') }] }] });
const pub = publishedOfTeam(JSON.parse(fs.readFileSync(file, 'utf8')));
ok(pub.classes[0]?.id === 'class_team' && pub.cards.map(x => x.id).join() === 'effect_a,effect_pub', 'published: the custom class; custom cards once each (a card won by a kill is not "published by us")');

let r = testPriorityEnv(file, { env: {} });
ok(r.env.FORCE_FOREIGN_CLASS === fc2 && !r.env.FOREIGN_CLASS_REF_JSON, 'class: the newest draft wins over the published one');
ok(r.env.FORCE_FOREIGN_EFFECT === `${e2},${e1}` && r.env.FORCE_FOREIGN_SKILL === s1, 'skills / effects: my drafts (comma lists, newest first)');
const refs = JSON.parse(r.env.FOREIGN_CARD_REFS_JSON);
ok(refs.length === 1 && refs[0].id === 'effect_pub', 'published cards fill the slots left (effect_a: the draft, not twice)');
ok(r.env.TEST_PRIORITY === '1' && /class class_new \(draft\)/.test(r.summary) && /effect_pub \(published\)/.test(r.summary), `summary: ${r.summary}`);

fs.rmSync(path.join(T, 'gen-drafts'), { recursive: true });
r = testPriorityEnv(file, { env: {} });
ok(JSON.parse(r.env.FOREIGN_CLASS_REF_JSON).id === 'class_team' && !r.env.FORCE_FOREIGN_CLASS && !r.env.FORCE_FOREIGN_EFFECT, 'no drafts: the team\'s published class by ref');

ok(!Object.keys(testPriorityEnv(file, { env: { FORCE_FOREIGN_EFFECT: '/x.json' } }).env).length && !Object.keys(testPriorityEnv(file, { env: { FORCE_EFFECTS: 'effect_shield' } }).env).length
  && !Object.keys(testPriorityEnv(file, { env: { TEST_PRIORITY: '0' } }).env).length, 'a harness (FORCE_*) or TEST_PRIORITY=0 → left alone');
ok(Object.values(TEST_PRIORITY_BLANK).every(v => v === '') && 'FOREIGN_CARD_REFS_JSON' in TEST_PRIORITY_BLANK, 'the blank env for workers');

fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} test-priority check(s) FAILED` : 'all test-priority checks passed');
process.exit(fails ? 1 : 0);
