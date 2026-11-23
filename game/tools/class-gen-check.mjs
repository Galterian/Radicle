// node tools/class-gen-check.mjs — class generation from templates (class-gen.mjs) + the answer-loop cut (effect-gen.mjs)
// Offline: no model. Every template must pass the publish check as a renamed player copy (else drop it from CLASS_TEMPLATES).
import { CLASS_TEMPLATES, templatePrompt, templateAnswerSchema, assemble, autoFix, checkClassDraft, stripForModel, classSpec } from '../class-gen.mjs';
import { answerLoop, complete, generateDef } from '../effect-gen.mjs';

let fails = 0;
const ok = (c, msg) => { if (c) console.log(`ok   ${msg}`); else { fails++; console.log(`FAIL ${msg}`); } };
const build = (raw) => { const d = assemble(raw, { model: 'check', idea: 'check', taken: new Set() }); autoFix(d); return d; };

const p = templatePrompt();
ok(p.length < 14_000 && CLASS_TEMPLATES.every(id => p.includes(`${id} — `)) && !p.includes('## The dialect'), `template prompt: ${p.length} chars (≈ ${Math.round(p.length / 3.6)} tok), every template listed, no dialect`);
ok(templateAnswerSchema().properties.template.enum.length === CLASS_TEMPLATES.length, 'answer schema: template enum');

// every template, renamed, with new colours → ok
const bad = [];
for (const t of CLASS_TEMPLATES) {
  const d = build({ id: `class_${t.slice(6)}_copy`, name: `Copy ${t.slice(6)}`, template: t, data: { colors: ['elem_fire', 'elem_air'], text: 'A copy.' } });
  const c = await checkClassDraft(d);
  if (!c.ok && c.verdict !== 'nerf' && c.verdict !== 'boost') bad.push(`${t}: ${c.verdict} ${c.problems.slice(0, 2).join(' | ')}`);
}
ok(!bad.length, `every template builds a class the publish check accepts (or prices) — ${bad.join('; ') || 'all fine'}`);

// the Field Medic the 8B was asked for
const fm = build({ id: 'class_field_medic', name: 'Field Medic', template: 'class_healer',
  data: { colors: ['elem_vitality', 'elem_water'], text: 'Tap: you or an adjacent ally regains 1 life.', unmoved_only: false, ability_kind: 'static', nonsense: 3 }, power: { heal: { n: 1, ally: 1, ally_required: true }, armor: 2 } });
ok(fm.data.ability_kind === 'tap' && fm.flags.needs === 'ally_or_self' && fm.data.unmoved_only === false && fm.data.colors.join() === 'elem_vitality,elem_water', 'template: kind / needs are the template\'s, colours + a knob are mine');
ok(fm.source.template === 'class_healer' && fm.source.ignored.join() === 'ability_kind,nonsense,power.armor' && !fm.power.armor && fm.power.heal.unmoved === undefined, 'unknown knobs / power keys ignored (and noted); a template power key takes my value');
ok(!JSON.stringify(fm.hooks).includes('class healer:') && JSON.stringify(fm.hooks).includes('class field medic:'), 'the hooks\' log text names the new class');
const fmc = await checkClassDraft(fm);
console.log(`     Field Medic: ${fmc.verdict} ${fmc.problems.slice(0, 3).join(' | ')}`);
ok(['ok', 'nerf', 'boost'].includes(fmc.verdict), 'Field Medic validates (priced)');
const back = stripForModel(fm);
ok(back.template === 'class_healer' && !back.hooks && back.data.unmoved_only === false, 'a retry shows the model the template form, not the hooks');
ok(build({ id: 'class_x', name: 'X', data: { ability_kind: 'tap', colors: ['elem_fire', 'elem_air'], text: 't' }, flags: {}, power: { armor: 1 }, uses: ['classes_std'], hooks: { ability: { var: 'x' } } }).hooks.ability, 'a whole class (no template) still assembles');

// answer loops
ok(answerLoop('{"a":' + ']}}'.repeat(30)) === 'closing brackets repeat', 'loop: 40+ closing brackets');
ok(answerLoop('{"a":{"b":[1,2,{"c":3}]}}') === '' && answerLoop('x'.repeat(100) + 'abcdefghij'.repeat(30)) === 'the same 10-character chunk repeats', 'loop: a real JSON end is fine; a repeating chunk is cut');
let sent = 0;
const loopFetch = async () => ({ ok: true, status: 200, body: (async function* () {
  for (let i = 0; i < 2000; i++) { sent = i; yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: i < 5 ? '{"a":' : ']}' } }] })}\n\n`); }
})() });
const a = await complete({ url: 'http://x', key: '', model: 'm', timeoutMs: 5000, maxTokens: 4096 }, [{ role: 'user', content: 'x' }], { fetchImpl: loopFetch, onProgress: () => {} });
ok(/^loop: closing brackets repeat/.test(a.error || '') && sent < 100, `a looping stream is cut early (${a.error}; ${sent} pieces read of 2000)`);

// the generation loop with a fake model answering the template form
const answer = JSON.stringify({ id: 'class_field_medic', name: 'Field Medic', template: 'class_healer', data: { colors: ['elem_vitality', 'elem_water'], text: 'Tap: you or an adjacent ally regains 1 life.' } });
let sys = '';
const fakeModel = async (url, o) => { sys = JSON.parse(o.body).messages[0].content; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: answer } }], usage: { completion_tokens: 60 } }) }; };
const r = await generateDef(classSpec(), { idea: 'a field medic', cfg: { url: 'http://x', key: '', model: 'm', timeoutMs: 5000, attempts: 1, maxTokens: 512 }, fetchImpl: fakeModel });
ok(r.def?.source?.template === 'class_healer' && r.def.hooks && /compactly on ONE line/.test(sys), `generateDef: the template answer → a class (${r.verdict}); the prompt asks for one-line JSON`);

console.log(fails ? `${fails} class-gen check(s) FAILED` : 'all class-gen checks passed');
process.exit(fails ? 1 : 0);
