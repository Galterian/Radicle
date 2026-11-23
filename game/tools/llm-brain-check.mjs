// Offline oracles for game/llm-brain.mjs (no llama-server needed): node tools/llm-brain-check.mjs → "all llm checks passed".
import assert from 'node:assert/strict';
import { llmConfig, aiRoleFor, cleanSay, parseAnswer, answerSchema, askLlm, userPrompt, systemPrompt, echoesOption, askThisAction, SAY_MAX, parseBanter, askBanter, banterSchema, banterUserPrompt } from '../llm-brain.mjs';

// config
assert.equal(llmConfig({}).url, 'http://127.0.0.1:8095');
assert.equal(llmConfig({ LLM_URL: '0' }).url, '');
assert.equal(llmConfig({ LLM_URL: 'https://h/llm/' }).url, 'https://h/llm');
// roles: humans never get one, unknown roles none
assert.equal(aiRoleFor({ role: 'monster', isHuman: false }), 'monster');
assert.equal(aiRoleFor({ role: 'monster', isHuman: true }), '');
assert.equal(aiRoleFor({ role: 'wizard', isHuman: false }), '');
// say: one printable line, ≤ SAY_MAX, no markup characters
assert.equal(cleanSay('  Hold\nthe <b>line</b>!  '), 'Hold the b line /b !');
assert.equal(cleanSay(42), '');
assert.equal(cleanSay('x'.repeat(200)).length, SAY_MAX);
// answers: in range only, think block ignored, prose around the JSON tolerated
assert.deepEqual(parseAnswer('{"choice": 2, "say": "Grr"}', 3), { choice: 2, say: 'Grr' });
assert.deepEqual(parseAnswer('<think>hmm</think> {"choice":1,"say":""}', 3), { choice: 1, say: '' });
assert.equal(parseAnswer('{"choice": 4, "say": ""}', 3), null);
assert.equal(parseAnswer('{"choice": "x"}', 3), null);
assert.equal(parseAnswer('no json', 3), null);
// echo filter: a line that reads the option back is dropped, a real shout is kept
assert.equal(echoesOption('Attack Anna!', 'Attack Anna the Firestroker'), true);
assert.equal(echoesOption('Moving toward Pride Guardian', 'Move toward Pride Guardian'), true);
assert.equal(echoesOption('GRAAAH!', 'Attack Anna the Firestroker'), false);
assert.equal(echoesOption('Covering you, Anna!', 'Attack Anna the Firestroker'), false);
assert.equal(echoesOption('', 'Block'), false);
// schema: choice is an enum of the option numbers
assert.deepEqual(answerSchema(3).properties.choice.enum, [1, 2, 3]);
// prompts carry the options numbered from 1
const up = userPrompt({ turn: 2, round: 1, roundsPerTurn: 3, me: { life: 3, lifeMax: 5, hand: 'A, P' }, foes: [{ name: 'Orc', life: 2, lifeMax: 4, dist: 1, recent: ['A'] }], friends: [], options: [{ label: 'Attack Orc' }, { label: 'Block' }] });
assert.match(up, /^Turn 2 action 2\/3\./);
assert.match(up, /1\. Attack Orc\n2\. Block$/);
assert.match(up, /Orc 2\/4 d1 \(played A\)/);
// rotation: every 3rd action per unit, all units together cover every action
assert.equal(askThisAction(5, 'x', 1), true);
assert.equal([0, 1, 2, 3, 4, 5].filter(a => askThisAction(a, 'peer:foe-1', 3)).length, 2);
assert.match(systemPrompt({ role: 'builder', name: 'Bob' }), /builder/);

// askLlm: request shape, timeout and failure handling, with a fake fetch
let seen = null;
const ok = await askLlm(llmConfig({ LLM_KEY: 'k' }), { system: 's', user: 'u', n: 2, fetchImpl: async (url, init) => {
  seen = { url, init: { ...init, body: JSON.parse(init.body) } };
  return { ok: true, json: async () => ({ choices: [{ message: { content: '{"choice":2,"say":"Shields up!"}' } }] }) };
} });
assert.equal(ok.choice, 2); assert.equal(ok.say, 'Shields up!');
assert.equal(seen.url, 'http://127.0.0.1:8095/v1/chat/completions');
assert.equal(seen.init.headers.Authorization, 'Bearer k');
assert.equal(seen.init.body.response_format.type, 'json_schema');
assert.deepEqual(seen.init.body.response_format.json_schema.schema.properties.choice.enum, [1, 2]);
assert.equal(seen.init.body.chat_template_kwargs.enable_thinking, false);
const bad = await askLlm(llmConfig({}), { system: 's', user: 'u', n: 2, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"choice":9}' } }] }) }) });
assert.equal(bad.error, 'malformed answer');
const down = await askLlm(llmConfig({}), { system: 's', user: 'u', n: 2, fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
assert.equal(down.error, 'ECONNREFUSED');
const keepAlive = setTimeout(() => {}, 2000);   // AbortSignal.timeout's timer is unref'd; a real fetch holds a socket
const slow = await askLlm(llmConfig({}), { system: 's', user: 'u', n: 2, timeoutMs: 200, fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))) });
assert.equal(slow.error, 'timeout'); clearTimeout(keepAlive);
assert.equal(await askLlm(llmConfig({ LLM_URL: '0' }), { system: 's', user: 'u', n: 2 }), null);

// banter (bulk scene): speaker enum, cleaning, no back-to-back speaker, no repeats, word-boundary cut, failure paths
assert.deepEqual(banterSchema(3).properties.lines.items.properties.who.enum, [1, 2, 3]);
assert.match(banterUserPrompt({ units: [{ name: 'Grok', what: 'Orc', role: 'monster', friend: false }, { name: 'Mira', role: 'builder', friend: true }], place: 'Ashen Wastes' }), /1\. Grok \(Orc\) — a wild monster.*enemy.*\n2\. Mira — the hero's builder/);
const bl = parseBanter(JSON.stringify({ lines: [{ who: 1, line: 'Me smash *tiny* wall!' }, { who: 1, line: 'again me' }, { who: 2, line: 'Not my <b>wall</b>, Grok.' },
  { who: 3, line: 'nobody' }, { who: 1, line: 'Me smash tiny wall!' }, { who: 1, line: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen' }] }), 2);
assert.deepEqual(bl.map(l => l.who), [0, 1, 0]);
assert.equal(bl[0].line, 'Me smash tiny wall!');
assert.equal(bl[1].line, 'Not my  b wall /b , Grok.'.replace(/\s+/g, ' '));
assert.ok(bl[2].line.length <= 90 && bl[2].line.endsWith('…') && !/\s…$/.test(bl[2].line) && /(teen|fifteen|sixteen)…$/.test(bl[2].line), bl[2].line);   // banter: 90, cut at a word
assert.equal(parseBanter('{"lines": "x"}', 2), null);
let bseen = null;
const bok = await askBanter(llmConfig({}), { units: [{ name: 'A', role: 'hero', friend: true }, { name: 'B', role: 'monster', friend: false }], fetchImpl: async (url, init) => {
  bseen = JSON.parse(init.body);
  return { ok: true, json: async () => ({ choices: [{ message: { content: '{"lines":[{"who":2,"line":"Grr, tasty hero."},{"who":1,"line":"Not today, B."}]}' } }] }) };
} });
assert.deepEqual(bok.lines, [{ who: 1, line: 'Grr, tasty hero.' }, { who: 0, line: 'Not today, B.' }]);
assert.equal(bseen.response_format.json_schema.name, 'banter');
assert.equal(await askBanter(llmConfig({}), { units: [{ name: 'A' }] }), null);   // one unit: no scene
assert.equal(await askBanter(llmConfig({ LLM_URL: '0' }), { units: [{ name: 'A' }, { name: 'B' }] }), null);
console.log('all llm checks passed');
{
  const { fixSelfAddress, BANTER_SAY_MAX } = await import('../llm-brain.mjs');
  const names = ['Rhox Brute', 'Summit Apes', 'You (Cynder Pyromancer)'];
  const out = fixSelfAddress([{ who: 0, line: "Rhox, your alchemy's not working." }, { who: 1, line: "Summit Apes, you're too proud." }, { who: 2, line: 'Nice try, Rhox.' }], names);
  assert.equal(out[0].line, "Your alchemy's not working.");
  assert.equal(out[1].line, "Rhox Brute, you're too proud.");
  assert.equal(out[2].line, 'Nice try, Rhox.');
  assert.equal(BANTER_SAY_MAX, 90);
  console.log('banter self-address checks passed');
}
