#!/usr/bin/env node
// Checks for /rules/api/gen/* (game/gen-api.mjs + game/gen-jobs.mjs) — no model, no game, no Radicle:
// a fake generate() (a renamed built-in), a fake test runner child (writes the result file), a temp profile dir and a
// temp bare repo standing in for chaosD6-Effects (radSync: false). Ephemeral 127.0.0.1 port, never 7357 / 7401.
//   node tools/gen-api-check.mjs   → "all gen-api checks passed"
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const REPO = path.resolve(GAME, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosd6-gen-check-'));
const PROFILE_DIR = path.join(T, 'profile');
process.env.CHAOSD6_PROFILE_DIR = PROFILE_DIR;
process.env.CHAOSD6_MOBILE = '';
process.env.LLM_BIG_URL = 'http://127.0.0.1:9';   // never called (fake generate)
const profileFile = path.join(PROFILE_DIR, 'profile.json');

const { handleEditorRequest, validateDefinition } = await import('../editor-api.mjs');
const { useGenJobs } = await import('../gen-api.mjs');
const { createGenJobs } = await import('../gen-jobs.mjs');
const { assemble, stripExample } = await import('../effect-gen.mjs');
const { stripSkill, assemble: assembleSkill, autoFix: skillFix } = await import('../skill-gen.mjs');
const { ridOfKind, defSha } = await import('../editor-publish.mjs');
const { generateIdentity } = await import('../profile-auth.mjs');
const { loadProfile } = await import('../profile.mjs');

let fails = 0;
const ok = (c, msg) => { if (c) console.log(`ok   ${msg}`); else { fails++; console.log(`FAIL ${msg}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (args, o = {}) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

// ---- fixtures: identity, team profile with two characters, a fake chaosD6-Effects remote ----
const me = generateIdentity();
fs.mkdirSync(path.join(PROFILE_DIR, 'radicle'), { recursive: true });
fs.writeFileSync(path.join(PROFILE_DIR, 'radicle', 'identity.pem'), me.privateKeyPem, { mode: 0o600 });
const chars = [{ id: 'pc_a', name: 'Ana', base_character: 'char_oran_rief', team: 'Gold Team', cards: [], actions: [], locked: true },
  { id: 'pc_b', name: 'Bo', base_character: 'char_rhox_bodyguard', team: 'Gold Team', cards: [], actions: [], locked: true }];
const writeProfile = (p) => fs.writeFileSync(profileFile, JSON.stringify({ version: 1, team_order: [], characters: chars, ...p }, null, 2));
writeProfile({ team_name: 'Gold Team', owners: [{ id: me.id, label: 'desk' }] });
const w = path.join(T, 'work');
fs.mkdirSync(path.join(w, 'effects'), { recursive: true }); fs.mkdirSync(path.join(w, 'lib'), { recursive: true });
const libs = {};
for (const f of fs.readdirSync(path.join(GAME, 'effects-data/lib')).filter(f => f.endsWith('.json'))) {
  fs.copyFileSync(path.join(GAME, 'effects-data/lib', f), path.join(w, 'lib', f));
  libs[f.slice(0, -5)] = defSha(JSON.parse(fs.readFileSync(path.join(GAME, 'effects-data/lib', f), 'utf8')));
}
fs.writeFileSync(path.join(w, 'index.json'), JSON.stringify({ format: 1, hash: 'sha256(canonical-json)', effects: {}, lib: libs }, null, 2) + '\n');
git(['init', '-q', '-b', 'main', w]); git(['add', '-A'], { cwd: w }); git(['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'main'], { cwd: w });
const remote = path.join(T, 'remote-effect.git');
git(['clone', '-q', '--bare', w, remote]);
// a fake chaosD6-Skills: skills/ + lib/ + index.json on main
const ws = path.join(T, 'work-skill');
fs.mkdirSync(path.join(ws, 'skills'), { recursive: true }); fs.mkdirSync(path.join(ws, 'lib'), { recursive: true });
for (const f of fs.readdirSync(path.join(GAME, 'skills-data/lib'))) fs.copyFileSync(path.join(GAME, 'skills-data/lib', f), path.join(ws, 'lib', f));
fs.writeFileSync(path.join(ws, 'index.json'), JSON.stringify({ format: 1, hash: 'sha256(canonical-json)', skills: {} }, null, 2) + '\n');
git(['init', '-q', '-b', 'main', ws]); git(['add', '-A'], { cwd: ws }); git(['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'main'], { cwd: ws });
const remoteSkill = path.join(T, 'remote-skill.git');
git(['clone', '-q', '--bare', ws, remoteSkill]);
const publishHooks = { profileFile, remoteUrlFor: (rid) => (rid === ridOfKind('effect') ? remote : rid === ridOfKind('skill') ? remoteSkill : path.join(T, 'none.git')), radSync: false, env: GIT_ENV, via: 'git' };

// ---- fake model + fake test runner ----
const light = stripExample(JSON.parse(fs.readFileSync(path.join(GAME, 'effects-data/effects/effect_lightning.json'), 'utf8')));
let genCalls = [];
const dodge = stripSkill(JSON.parse(fs.readFileSync(path.join(GAME, 'skills-data/skills/skill_dodge.json'), 'utf8')));
const fakeGenerate = async ({ kind, idea, prior, changes, onProgress, log, tagCheck }) => {
  genCalls.push({ kind, idea, prior: prior?.id || null, changes });
  onProgress?.({ attempt: 1, of: 3, phase: 'answer', done: 100, expect: 300 });
  log('attempt 1/3: asking fake');
  await sleep(150);
  const def = kind === 'skill'
    ? (() => { const s = assembleSkill({ ...dodge, id: 'skill_quick_step', name: 'Quick Step' }, { model: 'fake', idea, taken: new Set(['skill_dodge']) }); skillFix(s); return s; })()
    : assemble({ ...light, id: 'effect_static_bolt', name: prior ? 'Static Bolt II' : 'Static Bolt' }, { model: 'fake', idea, taken: new Set(['effect_lightning']) });
  const check = { effect_id: def.id, verdict: 'ok', judged_ratio: 1, band: { low: 0.8, high: 1.25 }, power: { value: 3, cost: { actions: 3 }, expected: 3, ratio: 1 }, reasons: ['fake reason'], suggestions: [] };
  const tp = tagCheck ? tagCheck(def) : [];
  return { ok: !tp.length, def, verdict: 'ok', problems: tp, tag_problems: tp, check, tries: [{ ms: 150, verdict: 'ok' }],
    talk: [{ role: 'player', text: `New ${kind}: ${idea}` }, { role: 'model', attempt: 1, text: JSON.stringify({ id: def.id }) }, { role: 'validator', attempt: 1, verdict: 'ok', text: 'VERDICT OK' }] };
};
let testPass = false;
const spawned = [];
const fakeSpawn = (exe, args) => {
  spawned.push(args);
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const out = args[args.indexOf('--out') + 1];
  setTimeout(() => {
    child.stdout.write('[test] 0:00 starting a private test game X\n[test] 0:10 playing 0:05/3:00 (3%) · casts 0, lands 0 · errors 0 · divergences 0\n');
    const res = testPass ? { pass: true, why: [], casts: 3, lands: 2, errors: 0, divergences: 0, lines: ['[player-1] effect …'], review: { summary: 'fine', suggestions: [] } }
      : { pass: false, why: ['cast 0 time(s), needs 2'], casts: 0, lands: 0, errors: 0, divergences: 0, lines: [], review: { summary: 'never cast', suggestions: ['make it cost one element less', 'range 2'] } };
    fs.writeFileSync(out, JSON.stringify(res));
    child.stdout.write(`[test] 0:20 ${res.pass ? 'PASS' : 'FAIL'} · casts ${res.casts}\n`);
    setTimeout(() => child.emit('exit', res.pass ? 0 : 1), 20);
  }, 100);
  return child;
};
const jobs = createGenJobs({ dir: path.join(PROFILE_DIR, 'gen-drafts'), draftsDir: path.join(PROFILE_DIR, 'effect-drafts'), llmFile: path.join(PROFILE_DIR, 'llm.json'),
  generate: fakeGenerate, spawnImpl: fakeSpawn, statsImpl: () => null, everyMs: 50 });
useGenJobs(profileFile, jobs);

// ---- server ----
const server = http.createServer(async (req, res) => {
  const handled = await handleEditorRequest(req, res, new URL(req.url, 'http://x'), { repoRoot: REPO, gameDir: GAME, profileFile, port: server.address().port, publish: publishHooks });
  if (!handled) { res.writeHead(418); res.end(); }
});
// --serve PORT: no checks — keep this fake node up for a browser walk-through of editor/gen.js
// (http://127.0.0.1:PORT/rules/#/gen/; the first test fails with suggestions, the next ones pass). Ctrl-C ends it.
const SERVE = process.argv.includes('--serve') ? Number(process.argv[process.argv.indexOf('--serve') + 1]) : 0;
await new Promise(r => server.listen(SERVE || 0, '127.0.0.1', r));
const port = server.address().port;
if (SERVE) {
  let n = 0;
  jobs.test = ((orig) => (id) => { testPass = n++ > 0; return orig(id); })(jobs.test);
  console.log(`fake gen node on http://127.0.0.1:${port}/rules/#/gen/ (profile ${PROFILE_DIR})`);
  await new Promise(() => {});
}
function rq(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { host: `127.0.0.1:${port}`, ...(data != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, setHost: false }, (res) => {
      let s = ''; res.on('data', c => { s += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject); r.end(data ?? undefined);
  });
}
const token = (await rq('GET', '/rules/api/editor/session')).json?.token;
const post = (p, body, headers = {}) => rq('POST', `/rules/api/gen/${p}`, { body, headers: { 'x-editor-token': token, ...headers } });
const get = (p) => rq('GET', `/rules/api/gen/${p}`);
const waitState = async (id, re, ms = 5000) => { const t = Date.now(); let d; while (Date.now() - t < ms) { d = (await get(`drafts/${id}`)).json?.draft; if (d && re.test(d.state)) return d; await sleep(40); } return d; };

try {
  // guard (8a's conditions)
  ok((await rq('POST', '/rules/api/gen/create', { body: { idea: 'a bolt that stuns everyone' } })).status === 403, 'POST without X-Editor-Token → 403');
  ok((await post('create', { idea: 'a bolt that stuns everyone' }, { host: 'evil.example:80' })).status === 403, 'wrong Host → 403');
  ok((await rq('GET', '/rules/api/gen/drafts', { headers: { host: 'evil.example' } })).status === 403, 'GET with a wrong Host → 403');
  ok((await post('create', { idea: 'a bolt that stuns everyone' }, { origin: 'http://evil.example' })).status === 403, 'cross-origin POST → 403');
  ok((await rq('POST', '/rules/api/gen/create', { headers: { 'x-editor-token': token, 'content-type': 'text/plain' } })).status === 415, 'non-JSON body → 415');
  ok((await rq('PUT', '/rules/api/gen/create', { headers: { 'x-editor-token': token } })).status === 405, 'PUT → 405');
  ok((await get('nope')).status === 404, 'unknown route → 404');
  // login
  writeProfile({ team_name: 'Gold Team', owners: [{ id: 'z6Mkother', label: 'x' }] });
  ok((await post('create', { idea: 'a bolt that stuns everyone' })).status === 403, 'not a team owner → 403 (writes need login)');
  ok((await get('drafts')).status === 200, 'reads work without login');
  writeProfile({ team_name: 'Gold Team', owners: [{ id: me.id, label: 'desk' }] });

  // create → preview
  let r = await post('create', { kind: 'effect', idea: 'a bolt that stuns everyone' });
  ok(r.status === 200 && r.json.draft.state === 'generating' && /^gen_/.test(r.json.draft.draft_id), 'create → generating');
  const id = r.json.draft.draft_id;
  ok((await post('create', { idea: 'another one at the same time' })).status === 409, 'one job at a time → 409');
  ok((await post('create', { kind: 'class', idea: 'a class please now' })).status === 400, 'classes are not built yet → 400');
  await sleep(80);
  ok(/^\[gen\] 0:0\d attempt 1\/3 \d+% · writing answer/.test((await get(`drafts/${id}`)).json.draft.status), 'status line in the [gen] format while generating');
  let d = await waitState(id, /^preview$/);
  ok(d.state === 'preview' && d.def?.id === 'effect_static_bolt' && d.verdict === 'ok' && d.def.source?.custom === true && fs.existsSync(d.file), 'preview: def (marked custom), verdict, draft file');
  ok((await get('drafts')).json.drafts.some(x => x.draft_id === id && x.name === 'Static Bolt'), 'drafts list');
  ok((await post('publish', { draft_id: id })).status === 409, 'publish before a test success → 409');

  // test → failed 1 → retry with a suggestion → test → success
  r = await post('test', { draft_id: id });
  ok(r.status === 200 && r.json.draft.state === 'testing', 'test → testing');
  d = await waitState(id, /^testing (failed|success)/);
  ok(d.state === 'testing failed 1' && d.suggestions.length === 2 && d.test.why[0].startsWith('cast 0'), `"testing failed 1" + the review's suggestions (${d.state})`);
  ok(spawned[0].includes('--review') && spawned[0][1] === d.file, 'the runner gets the draft file and --review');
  r = await post('retry', { draft_id: id, extra: 'it should also push them back', suggestions: [d.suggestions[0]] });
  ok(r.status === 200 && r.json.draft.state === 'generating', 'retry → generating');
  d = await waitState(id, /^preview$/);
  const last = genCalls.at(-1);
  ok(d.def.name === 'Static Bolt II' && last.prior === 'effect_static_bolt' && /push them back/.test(last.changes) && /one element less/.test(last.changes) && /cast 0/.test(last.changes), 'retry: prior def + extra + suggestion + the test finding go to the model');
  ok(d.state === 'preview' && d.fails === 1, 'retry keeps the failure count');
  testPass = true;
  await post('test', { draft_id: id });
  d = await waitState(id, /^testing (failed|success)/);
  ok(d.state === 'testing success', 'second test → "testing success"');

  // publish → branch + archive cards on every team character
  r = await post('publish', { draft_id: id });
  ok(r.status === 200 && r.json.ref?.branch === 'players/Gold-Team/static-bolt' && r.json.draft.state === 'published', `publish → ${r.json?.ref?.branch} (${r.json?.error || r.json?.publish?.state})`);
  ok(git(['--git-dir', remote, 'branch', '--list', 'players/*']).includes('players/Gold-Team/static-bolt'), 'the branch is on the (fake) chaosD6-Effects remote');
  const p = loadProfile(profileFile);
  const got = p.characters.map(c => (c.cards || []).find(x => x.id === 'effect_static_bolt'));
  ok(got.every(x => x && x.where === 'archive' && x.new === true && x.ref?.sha256 && x.ref.branch === 'players/Gold-Team/static-bolt' && x.custom === true && x.source?.custom === true) && p.characters.every(c => !c.kills), 'every team character: archive card, new, with its ref — no kill counted');
  ok(r.json.granted.length === 2, 'granted = 2 characters');
  ok((await post('publish', { draft_id: id })).status === 409, 'publish twice → 409');
  ok((await post('delete', { draft_id: id })).status === 200 && (await get(`drafts/${id}`)).status === 404, 'delete');
  ok(!(await get('drafts')).json.drafts.some(x => x.id === 'effect_static_bolt'), 'a deleted draft is not taken over again from its file');
  // A command-line draft (tools/effect-gen.mjs, before the editor flow: no custom mark) shows up as a preview.
  const cli = assemble({ ...light, id: 'effect_cli_bolt', name: 'CLI Bolt' }, { model: 'qwen3-8b', idea: 'a bolt from the CLI', taken: new Set() });
  delete cli.source.custom;
  fs.writeFileSync(path.join(PROFILE_DIR, 'effect-drafts', 'effect_cli_bolt.json'), JSON.stringify(cli, null, 2));
  const lst = (await get('drafts')).json.drafts.filter(x => x.id === 'effect_cli_bolt');
  const cd = lst[0] && (await get(`drafts/${lst[0].draft_id}`)).json.draft;
  ok(lst.length === 1 && cd.state === 'preview' && cd.verdict === 'ok' && cd.def.source.custom === true && cd.idea === 'a bolt from the CLI', 'a CLI draft is taken over: preview, validator verdict, custom mark, its idea');
  const again = (await get('drafts')).json;
  const cd2 = (await get(`drafts/${lst[0].draft_id}`)).json.draft;
  ok(again.drafts.filter(x => x.id === 'effect_cli_bolt').length === 1 && cd2.updated_at === cd.updated_at && !again.busy, '…only once: a repeated GET neither duplicates nor rewrites it, and starts no job');
  // Concurrent GETs (the list + a poll at the same moment) adopt a new CLI file exactly once.
  fs.writeFileSync(path.join(PROFILE_DIR, 'effect-drafts', 'effect_cli_bolt_two.json'), JSON.stringify({ ...cli, id: 'effect_cli_bolt_two', name: 'CLI Bolt Two' }, null, 2));
  await Promise.all(Array.from({ length: 6 }, () => get('drafts')));
  ok((await get('drafts')).json.drafts.filter(x => x.id === 'effect_cli_bolt_two').length === 1, '6 concurrent GETs adopt a CLI file once');

  // ---- tags (a hard requirement), resources, the report + the conversation ----
  const voc = (await get('vocab?kind=effect')).json;
  ok(voc?.groups?.find(g => g.id === 'element')?.values.includes('elem_water') && voc.groups.find(g => g.id === 'type')?.values.includes('point_buy'), 'GET vocab: effect tag groups (elements, effect types …)');
  ok((await get('vocab?kind=skill')).json?.groups?.some(g => g.id === 'lasts'), 'GET vocab?kind=skill');
  const cat = (await get('resources')).json;
  ok(cat?.sprites?.length > 50 && cat.sounds?.length > 50 && cat.sprites.some(s => s.in_pack === false), `GET resources: the chaosD6-Resources catalogue (${cat?.sprites?.length} sprites, ${cat?.sounds?.length} sounds, some not in the APK pack)`);
  ok((await post('create', { idea: 'a bolt that stuns everyone', resources: { sprite: 'assets/Sprites/../../etc/x.png' } })).status === 400, 'a resource outside the catalogue → 400');
  const spr = cat.sprites.find(s => !s.in_pack), snd = cat.sounds[0];
  r = await post('create', { idea: 'a watery bolt', tags: ['element:elem_water', 'duration:instant', 'bogus:x'], resources: { sprite: spr.path, sound: snd.path } });
  const tid = r.json.draft.draft_id;
  ok(JSON.stringify(r.json.draft.tags) === '["element:elem_water","duration:instant"]', 'create keeps the known tags only');
  d = await waitState(tid, /^preview$/);
  const g1 = genCalls.at(-1);
  ok(/Required .*element elem_water; duration instant/.test(g1.idea), 'the picked tags go to the model as a requirement');
  ok(d.tag_problems.length === (d.def.duration === 'instant' ? 1 : 2) && d.tag_problems[0].startsWith('tag element:elem_water is not met'), `tags are checked on the draft (${d.tag_problems.join(' | ')})`);
  ok(d.def.card.resources?.sprites?.effect?.path === spr.path && d.def.card.resources.sounds.fx[0].path === snd.path, 'the picked picture + sound are in the effect card.resources');
  ok((await post('test', { draft_id: tid })).status === 409, 'a draft that misses its tags cannot be tested (retry first)');
  ok(d.report?.[0]?.includes('VERDICT OK') && d.report.some(l => l.includes('fake reason')) && d.log.some(l => l.includes('[rebalance]')), 'the rebalance report is on the draft and in its log');
  ok(d.talk?.[0]?.role === 'round' && d.talk.some(t => t.role === 'player') && d.talk.some(t => t.role === 'validator'), 'the conversation is on the draft');
  await post('retry', { draft_id: tid, extra: 'make it water', tags: [] });
  d = await waitState(tid, /^preview$/);
  ok(!d.tag_problems.length && d.talk.filter(t => t.role === 'round').length === 2, 'a retry that drops the tags: nothing to meet; a second round in the conversation');
  { const v = await validateDefinition('effect', d.def); ok(v.ok, `an effect with picked resources still validates for publish (${v.errors?.slice(0, 2).join('; ')})`); }
  await post('delete', { draft_id: tid });

  // ---- a skill end to end: create → preview (/1, resources) → test → publish to chaosD6-Skills → archive cards ----
  testPass = true;
  r = await post('create', { kind: 'skill', idea: 'a quick sidestep that takes the edge off a blow', tags: ['action:M', 'lasts:instant'], resources: { sound: snd.path } });
  const sid = r.json.draft.draft_id;
  d = await waitState(sid, /^preview$/);
  ok(d.kind === 'skill' && d.def.schema === 'chaosd6.skill/1' && d.def.source.custom === true && d.def.resources?.sounds?.fx?.[0]?.path === snd.path && !d.tag_problems.length
    && path.basename(path.dirname(d.file)) === 'skill-drafts', 'skill: a /1 draft with its resources, tags met, in <profile>/skill-drafts');
  await post('test', { draft_id: sid });
  d = await waitState(sid, /^testing (failed|success)/);
  ok(d.state === 'testing success' && spawned.at(-1)[1] === d.file, 'skill: the test runner gets the skill draft file');
  ok(d.talk.some(t => t.role === 'test' && /^PASS · plays 3/.test(t.text)), 'the test result + review go into the conversation');
  r = await post('publish', { draft_id: sid });
  ok(r.status === 200 && r.json.ref?.branch === 'players/Gold-Team/quick-step' && git(['--git-dir', remoteSkill, 'branch', '--list', 'players/*']).includes('players/Gold-Team/quick-step'),
    `skill publish → ${r.json?.ref?.branch || r.json?.error} on the (fake) chaosD6-Skills`);
  const ps = loadProfile(profileFile).characters.map(c => (c.cards || []).find(x => x.id === 'skill_quick_step'));
  ok(ps.every(x => x && x.kind === 'skill' && x.where === 'archive' && x.custom === true && x.ref?.branch === 'players/Gold-Team/quick-step'), 'every team character gets the skill card in its archive (custom)');

  // ---- the phone: model key form + the test on OCI's gen-test service ----
  ok((await post('key', { url: 'http://evil.example/llm-big', key: 'k'.repeat(30) })).status === 400, 'key: a non-https / non-/llm-big url → 400');
  ok((await rq('POST', '/rules/api/gen/key', { body: { url: 'https://h.example/llm-big', key: 'k'.repeat(30) } })).status === 403, 'key: without the token → 403');
  r = await post('key', { url: 'https://h.example/llm-big', key: 'secret-key-0123456789abcdef' });
  const lf = path.join(PROFILE_DIR, 'llm.json');
  const lj = JSON.parse(fs.readFileSync(lf, 'utf8'));
  ok(r.status === 200 && !JSON.stringify(r.json).includes('secret-key') && (fs.statSync(lf).mode & 0o777) === 0o600
    && lj.big_url === 'https://h.example/llm-big' && lj.test_url === 'https://h.example/gen-test' && lj.remote_url === 'https://h.example/llm', 'key saved (600, test_url derived), never sent back');
  delete process.env.LLM_BIG_URL;   // the env wins over llm.json (set at the top for the fake model)
  const dl = (await get('drafts')).json;
  ok(dl.model.key_set === true && dl.model.host === 'h.example' && !JSON.stringify(dl).includes('secret-key'), 'GET drafts: key_set, host — no key');
  const calls = [];
  const fakeOci = async (url, o = {}) => {
    calls.push({ url, auth: o.headers?.Authorization, method: o.method || 'GET' });
    const n = calls.filter(c => c.method === 'GET').length;
    const J = (status, j) => ({ ok: status < 300, status, json: async () => j });
    if (o.method === 'POST') return J(202, { ok: true, id: 't_fake0001x' });
    if (n < 2) return J(200, { ok: true, state: 'running', status: '[test] 0:41 game 1/2 playing 0:24/3:00 (14%) · casts 1, lands 1 · errors 0 · divergences 0' });
    return J(200, { ok: true, state: 'done', status: '[test] 3:39 PASS', result: { pass: true, why: [], casts: 3, lands: 3, errors: 0, divergences: 0, lines: ['[player-1] effect …'], review: { summary: 'ok', suggestions: ['x'] } } });
  };
  const mobileJobs = createGenJobs({ dir: path.join(T, 'm', 'gen-drafts'), draftsDir: path.join(T, 'm', 'effect-drafts'), llmFile: lf, env: { CHAOSD6_MOBILE: '1' },
    generate: fakeGenerate, spawnImpl: () => { throw new Error('the phone must not spawn a local test game'); }, statsImpl: () => null, fetchImpl: fakeOci, everyMs: 40 });
  ok(mobileJobs.remoteTest()?.url === 'https://h.example/gen-test', 'phone: tests go to OCI (test_url)');
  let md = mobileJobs.create({ idea: 'a bolt that stuns everyone' });
  for (let i = 0; i < 100 && (mobileJobs.get(md.draft_id).state !== 'preview'); i++) await sleep(20);
  mobileJobs.test(md.draft_id);
  let seen = '';
  for (let i = 0; i < 200; i++) { md = mobileJobs.get(md.draft_id); if (/on OCI/.test(md.status)) seen = md.status; if (/^testing (success|failed)/.test(md.state)) break; await sleep(20); }
  ok(md.state === 'testing success' && md.test.where === 'oci' && md.test.casts === 3 && md.suggestions[0] === 'x', `phone: OCI test → ${md.state}`);
  // The phone's menu process restarts while OCI plays: the new process polls the same OCI test.
  const mfile = path.join(T, 'm', 'gen-drafts', `${md.draft_id}.json`);
  fs.writeFileSync(mfile, JSON.stringify({ ...JSON.parse(fs.readFileSync(mfile, 'utf8')), state: 'testing', remote_test: 't_fake0002x', test: null }));
  const again2 = createGenJobs({ dir: path.join(T, 'm', 'gen-drafts'), draftsDir: path.join(T, 'm', 'effect-drafts'), llmFile: lf, env: { CHAOSD6_MOBILE: '1' },
    generate: fakeGenerate, spawnImpl: () => { throw new Error('no'); }, statsImpl: () => null, fetchImpl: fakeOci, everyMs: 40 });
  let rd;
  for (let i = 0; i < 100; i++) { rd = again2.get(md.draft_id); if (rd.state !== 'testing') break; await sleep(20); }
  ok(rd.state === 'testing success' && !rd.remote_test && calls.some(c => c.url.endsWith('/tests/t_fake0002x')), `phone: after a restart the OCI test is polled again → ${rd.state}`);
  ok(/casts 1, lands 1 .* on OCI$/.test(seen) && calls[0].url === 'https://h.example/gen-test/tests' && calls.every(c => c.auth === 'Bearer secret-key-0123456789abcdef'), 'phone: OCI status lines shown, every call carries the key');
} finally {
  server.close();
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `${fails} gen-api check(s) FAILED` : 'all gen-api checks passed');
process.exit(fails ? 1 : 0);
