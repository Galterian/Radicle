// Offline checks for effect-gen.mjs (no model): the prompt builds, the validator loop accepts a good definition,
// refuses a broken one and feeds the problems back, ids never shadow a built-in.
//   node tools/effect-gen-check.mjs   → "all effect-gen checks passed"
import fs from 'node:fs';
import { systemPrompt, answerSchema, assemble, autoFix, autoTune, applySuggestion, checkDraft, complete, generateEffect, stripExample, parseJson } from '../effect-gen.mjs';

let fails = 0;
const ok = (c, msg) => { if (c) console.log(`ok   ${msg}`); else { fails++; console.log(`FAIL ${msg}`); } };
const read = (id) => JSON.parse(fs.readFileSync(new URL(`../effects-data/effects/${id}.json`, import.meta.url), 'utf8'));

const p = systemPrompt();
ok(p.includes('## The dialect') && p.includes('prelude(') && p.includes('"id":"effect_lightning"'), `system prompt has dialect, libraries, examples (${p.length} chars)`);
ok(systemPrompt() === p, 'system prompt is stable (prompt cache)');
ok(answerSchema().required.includes('logic'), 'answer schema');
ok(parseJson('<think></think>\n{"a":1}') ?.a === 1 && parseJson('nope') === null, 'parseJson');

// A built-in, renamed, as the "model answer": must pass the validator.
const light = stripExample(read('effect_lightning'));
const good = { ...light, id: 'effect_static_bolt', name: 'Static Bolt' };
const taken = new Set(['effect_lightning']);
const d = assemble(good, { model: 'fake', idea: 'x', taken });
ok(d.schema === 'chaosd6.effect/2' && d.cost === d.elements.length && JSON.stringify(d.card.data.element_cost) === JSON.stringify(d.elements), 'assemble fills schema / cost / card element_cost');
ok(assemble({ ...good, id: 'effect_lightning' }, { taken }).id === 'effect_lightning_gen', 'a built-in id gets _gen');
const c1 = await checkDraft(d);
ok(c1.ok && c1.verdict === 'ok', `renamed Lightning passes the validator (${c1.verdict}${c1.problems.length ? ': ' + c1.problems.join('; ') : ''})`);

// Program does more than its flags (lock flag removed, program still locks) → refused with the reason.
const over = assemble({ ...good, flags: { damage: 'delta', scope: 'target' } }, { taken });
const c2 = await checkDraft(over);
ok(!c2.ok && c2.problems.some(x => /exceeds|lock/.test(x)), `a program beyond its flags is refused (${c2.problems[0]?.slice(0, 80)})`);
// The 8B's first real Frost Nova (2026-11-22): map item not named → every scenario errors; the probe names the cause.
const unnamed = structuredClone(good);
unnamed.logic.seq = unnamed.logic.seq.map(x => (x.map ? { map: x.map.slice(0, 2) } : x));
const c3 = await checkDraft(assemble(unnamed, { taken }));
ok(!c3.ok && c3.problems.some(x => /^engine: no unit undefined/.test(x)), `an unnamed map item: the engine's message reaches the model (${c3.problems.at(-1)?.slice(0, 60)})`);
const fx = assemble(structuredClone(unnamed), { taken });
const fixedList = autoFix(fx);
ok(fixedList.length === 1 && (await checkDraft(fx)).ok, `autoFix names the map item and the draft passes (${fixedList.join('; ')})`);
ok(autoFix(assemble(structuredClone(good), { taken })).length === 0, 'autoFix leaves a correct program alone');
// The 8B's Frost Nova (2026-11-22, attempt 1 verbatim, map item named): 1.35× → too strong; autoTune keeps the scope + lock.
const nova = { id: 'effect_frost_nova', name: 'Frost Nova', elements: ['elem_water', 'elem_concentration'], kind: 'damage', duration: 'instant',
  every: { behaviour: 'none' }, text: 'Hits every adjacent enemy with water damage; each loses one action.', flags: { damage: 'delta', scope: 'all_adjacent', lock: 1 },
  uses: ['std', 'e2a'], card: { tags: ['damage'], data: { effect_types: ['damage', 'instant'] } },
  logic: { seq: [{ call: ['prelude'] }, { call: ['targets', 'all_adjacent', 1, true] }, { call: ['require_recipients'] },
    { map: [{ var: 'recipients' }, { seq: [{ call: ['hit_with', { var: 'def' }, [{ obj: { kind: 'main', sum: { call: ['main_delta', { var: 'def' }] } } }], false, false] }, { call: ['lock_n', { var: 'def' }, 1] }] }, 'def'] },
    { call: ['finish'] }] } };
const nd = assemble(nova, { taken }), nr = await checkDraft(nd);
const tuned = await autoTune(nd, nr);
ok(nr.verdict === 'nerf' && tuned?.res.ok && tuned.def.flags.scope === 'all_adjacent' && tuned.def.flags.lock === 1, `autoTune: ${nr.verdict} ${nr.check?.judged_ratio} → "${tuned?.change}" ${tuned?.res.verdict} ${tuned?.res.check.judged_ratio} (scope + lock kept)`);
const lk = applySuggestion(nd, { change: 'lock 1 → 0', patch: { rule: { damage: 'delta', scope: 'all_adjacent' } } });
ok(lk && !JSON.stringify(lk.def.logic).includes('lock_n') && !lk.def.flags.lock, 'a lock suggestion rewrites flags AND program (lock_n dropped)');
ok(applySuggestion(nd, { change: 'x', patch: { rule: { ...nd.flags, push: 1 } } }) === null, 'a suggestion the program cannot follow mechanically is left to the model');
const bad = assemble({ ...good, logic: { nonsense_op: [1] } }, { taken });
ok(!(await checkDraft(bad)).ok, 'an unknown operation is refused');

// The loop: first answer broken, second good → 2 tries, ok, the problems went back to the model.
const answers = [JSON.stringify({ ...good, logic: { nonsense_op: [1] } }), JSON.stringify(good)];
const sent = [];
const fakeFetch = async (url, o) => {
  const body = JSON.parse(o.body); sent.push(body);
  const content = answers[sent.length - 1] ?? '{}';
  return { ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) };
};
const r = await generateEffect({ idea: 'a bolt that stuns', cfg: { url: 'http://fake', key: '', model: 'fake', timeoutMs: 1000, attempts: 3, maxTokens: 512 }, fetchImpl: fakeFetch, taken });
ok(r.ok && r.tries.length === 2 && r.def.id === 'effect_static_bolt', `retry loop: refused, fixed, ok in ${r.tries.length} tries`);
ok(sent[1].messages.length === 4 && /validator refused/.test(sent[1].messages[3].content) && sent[0].chat_template_kwargs.enable_thinking === false, 'second request carries the problems; thinking off');
ok(sent[0].messages[0].content === sent[1].messages[0].content, 'same system prompt on every try (cache)');
// Streaming (status line): prompt_progress + answer tokens reach onProgress; the text and timings are the same.
const enc = new TextEncoder();
const sse = [{ prompt_progress: { total: 100, cache: 40, processed: 60 } }, { choices: [{ delta: { content: '{"a":' } }] }, { choices: [{ delta: { content: '1}' } }] }, { choices: [{ delta: {} }], timings: { prompt_n: 60, cache_n: 40, predicted_n: 2 } }]
  .map(o => `data: ${JSON.stringify(o)}\n\n`).join('') + 'data: [DONE]\n\n';
const seen = [];
const st = await complete({ url: 'http://fake', key: '', model: 'm', timeoutMs: 1000, maxTokens: 10 }, [], {
  onProgress: (x) => seen.push(x.phase === 'prompt' ? `p${x.done}/${x.total}` : `a${x.done}`),
  fetchImpl: async () => ({ ok: true, body: (async function* () { for (const part of [sse.slice(0, 50), sse.slice(50)]) yield enc.encode(part); })() }) });
ok(st.text === '{"a":1}' && seen.join() === 'p60/100,a1,a2' && st.usage.prompt_tokens === 100 && st.usage.completion_tokens === 2, `streaming: ${seen.join(' ')} → "${st.text}"`);
const none = await generateEffect({ idea: 'x', cfg: { url: '', attempts: 1 } });
ok(!none.ok && /no big model/.test(none.error), 'no model configured → clear error');

console.log(fails ? `${fails} effect-gen check(s) FAILED` : 'all effect-gen checks passed');
process.exit(fails ? 1 : 0);
