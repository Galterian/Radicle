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
const { stripClass, assemble: assembleClass, autoFix: classFix } = await import('../class-gen.mjs');
const { ridOfKind, defSha } = await import('../editor-publish.mjs');
const { cleanTags, tagProblems, tagsPrompt } = await import('../gen-tags.mjs');
const { assetFile } = await import('../asset-root.mjs');
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
// a fake chaosD6-Classes: classes/ + lib/ + index.json on main
const wc = path.join(T, 'work-class');
fs.mkdirSync(path.join(wc, 'classes'), { recursive: true }); fs.mkdirSync(path.join(wc, 'lib'), { recursive: true });
for (const f of fs.readdirSync(path.join(GAME, 'classes-data/lib'))) fs.copyFileSync(path.join(GAME, 'classes-data/lib', f), path.join(wc, 'lib', f));
fs.writeFileSync(path.join(wc, 'index.json'), JSON.stringify({ format: 1, hash: 'sha256(canonical-json)', classes: {} }, null, 2) + '\n');
git(['init', '-q', '-b', 'main', wc]); git(['add', '-A'], { cwd: wc }); git(['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'main'], { cwd: wc });
const remoteClass = path.join(T, 'remote-class.git');
git(['clone', '-q', '--bare', wc, remoteClass]);
const publishHooks = { profileFile, remoteUrlFor: (rid) => (rid === ridOfKind('effect') ? remote : rid === ridOfKind('skill') ? remoteSkill : rid === ridOfKind('class') ? remoteClass : path.join(T, 'none.git')), radSync: false, env: GIT_ENV, via: 'git' };

// ---- fake model + fake test runner ----
const light = stripExample(JSON.parse(fs.readFileSync(path.join(GAME, 'effects-data/effects/effect_lightning.json'), 'utf8')));
let genCalls = [];
const dodge = stripSkill(JSON.parse(fs.readFileSync(path.join(GAME, 'skills-data/skills/skill_dodge.json'), 'utf8')));
const overlord = stripClass(JSON.parse(fs.readFileSync(path.join(GAME, 'classes-data/classes/class_overlord.json'), 'utf8')));
const fakeGenerate = async ({ kind, idea, prior, changes, onProgress, log, tagCheck }) => {
  genCalls.push({ kind, idea, prior: prior?.id || null, changes });
  onProgress?.({ attempt: 1, of: 3, phase: 'answer', done: 100, expect: 300 });
  log('attempt 1/3: asking fake');
  await sleep(150);
  const def = kind === 'class'
    ? (() => { const c = assembleClass({ ...overlord, id: 'class_field_medic', name: 'Field Medic' }, { model: 'fake', idea, taken: new Set(['class_overlord']) }); classFix(c); return c; })()
    : kind === 'skill'
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
  // /assets/* as ui-server serves it (the picker's previews and sounds)
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/assets/')) {
    const abs = assetFile(decodeURIComponent(u.pathname).slice('/assets/'.length).replace(/\.\./g, ''));
    if (!abs || !fs.existsSync(abs)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': /\.png$/i.test(abs) ? 'image/png' : /\.wav$/i.test(abs) ? 'audio/wav' : 'application/octet-stream' });
    return fs.createReadStream(abs).pipe(res);
  }
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
  ok((await post('create', { kind: 'monster', idea: 'a monster please now' })).status === 400, 'an unknown kind → 400');
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
  // the picture / sound alone (POST media): no regeneration, the def's card.resources follow, the verdict stands
  { const spr2 = cat.sprites.find(s => s.path !== spr.path && s.grid), verdict = d.verdict;
    r = await post('media', { draft_id: tid, resources: { sprite: spr2.path, sound: null } });
    const m = r.json?.draft;
    ok(r.status === 200 && m.state === 'preview' && m.verdict === verdict && m.def.card.resources.sprites.effect.path === spr2.path && !m.def.card.resources.sounds && m.resources.sprite === spr2.path,
      `POST media: the card's picture changes, the sound goes, no regeneration (${r.status} ${r.json?.error || ''})`);
    ok(JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'effect-drafts', `${m.def.id}.json`), 'utf8')).card.resources.sprites.effect.path === spr2.path, 'POST media: the draft def file is rewritten');
    ok((await post('media', { draft_id: tid, resources: { sprite: 'assets/Sprites/nope.png' } })).status === 400, 'POST media: a path outside the catalogue → 400');
    r = await post('media', { draft_id: tid, resources: null });
    ok(r.status === 200 && !r.json.draft.def.card.resources && r.json.draft.resources === null, 'POST media null: the picture and sound are dropped');
    ok(spr2.grid.cols >= 1 && spr2.grid.w > 0 && spr2.grid.fps > 0, `the catalogue gives the strip grid for the animated preview (${JSON.stringify(spr2.grid)})`);
  }
  await post('retry', { draft_id: tid, extra: 'again' });
  ok((await post('media', { draft_id: tid, resources: null })).status === 409, 'POST media while generating → 409');
  await waitState(tid, /^preview$/);
  await post('delete', { draft_id: tid });
  // repeated elements (user 2026-11-23: water, fire, water = two water in the cost)
  { const t = cleanTags('effect', ['element:elem_water', 'element:elem_fire', 'element:elem_water', 'kind:damage', 'kind:lock', 'type:point_buy', 'type:point_buy', 'element:elem_air', 'element:elem_air']);
    ok(JSON.stringify(t) === JSON.stringify(['element:elem_water', 'element:elem_fire', 'element:elem_water', 'kind:lock', 'type:point_buy', 'element:elem_air']), `cleanTags: elements repeat (≤ 4), 'one' replaces, 'set' once (${t.join(', ')})`);
    const need = ['element:elem_water', 'element:elem_fire', 'element:elem_water'];
    ok(/elem_water ×2 \(that many times/.test(tagsPrompt('effect', need)), 'the prompt asks for water ×2');
    const p1 = tagProblems('effect', { elements: ['elem_water', 'elem_fire'] }, need);
    ok(p1.length === 1 && p1[0].startsWith('tag element:elem_water ×2 is not met'), `one water where two are picked → missed (${p1.join(' | ')})`);
    ok(!tagProblems('effect', { elements: ['elem_fire', 'elem_water', 'elem_water'] }, need).length, 'water, fire, water in any order → met'); }
  // /assets/* (the picker's previews) on the fake node, as ui-server serves them
  { const a = cat.sprites.find(s => s.in_pack && /[ ()[\]]/.test(s.path)) || cat.sprites.find(s => s.in_pack);
    const st = a ? (await rq('GET', '/' + a.path.split('/').map(encodeURIComponent).join('/'))).status : 0;
    ok(st === 200 || (st === 404 && !fs.existsSync(assetFile(a.path.slice('assets/'.length)) || '')), `GET /assets/<encoded path> of a packed sprite → ${st}`); }

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

  // ---- a class end to end: create (tags, a unit's whole voice) → preview (/2) → voice change → test → publish to
  // chaosD6-Classes (no archive card: a class is not a card) ----
  { const voc = (await get('vocab?kind=class')).json;
    ok(['ability', 'color', 'power', 'needs'].every(g => voc?.groups?.some(x => x.id === g)) && voc.groups.find(g => g.id === 'power').values.includes('armor') && !voc.groups.find(g => g.id === 'power').values.includes('build'),
      'GET vocab?kind=class: ability kind, colours, power (no peer / hand keys), targets');
    const unit = cat.units?.find(u => u.sounds.length >= 5), unit2 = cat.units?.find(u => u !== unit && u.sounds.some(s => /[!?']/.test(s.path)));
    ok(cat.units?.length > 100 && unit && unit2, `GET resources: ${cat.units?.length} units with their voice sets`);
    ok((await post('create', { kind: 'class', idea: 'a medic', resources: { unit: 'Nobody/Nothing' } })).status === 400, 'class: a unit outside the catalogue → 400');
    r = await post('create', { kind: 'class', idea: 'a field medic who shields an ally', tags: ['ability:tap', 'power:armor', 'color:elem_space', 'color:elem_fire'], resources: { unit: `${unit.race}/${unit.unit}` } });
    const cid = r.json.draft.draft_id;
    d = await waitState(cid, /^preview$/);
    ok(d.kind === 'class' && d.def.schema === 'chaosd6.class/2' && d.def.source.custom === true && path.basename(path.dirname(d.file)) === 'class-drafts', 'class: a /2 draft in <profile>/class-drafts, marked custom');
    ok(d.def.resources?.unit?.unit === unit.unit && d.def.resources.sounds.voice.length === Math.min(16, unit.sounds.length) && d.def.resources.sounds.voice.every(s => s.path.startsWith(`assets/Sounds/Units/${unit.race}/${unit.unit}/`)),
      `class: the unit's whole voice set (${d.def.resources?.sounds?.voice?.length} sounds) in def.resources`);
    ok(d.tag_problems.length === 1 && d.tag_problems[0].startsWith('tag color:elem_fire is not met'), `class tags checked (${d.tag_problems.join(' | ')})`);
    r = await post('media', { draft_id: cid, resources: { unit: `${unit2.race}/${unit2.unit}` } });
    ok(r.status === 200 && r.json.draft.def.resources.unit.unit === unit2.unit, `class: POST media changes the voice (${unit2.unit}: paths with ! ? ')`);
    { const v = await validateDefinition('class', r.json.draft.def); ok(v.ok, `a class with a unit voice validates for publish (${v.errors?.slice(0, 2).join('; ')})`); }
    { const bad = structuredClone(r.json.draft.def); bad.resources.sounds.voice[0].path = 'assets/Sounds/Units/../../etc/x.wav';
      const v = await validateDefinition('class', bad); ok(!v.ok && v.errors.some(e => /voice\[0\]\.path/.test(e)), 'a voice path with ".." is refused');
      bad.resources.sounds.voice[0].path = `assets/Sounds/Units/${unit.race}/${unit.unit}/x.wav`;
      const v2 = await validateDefinition('class', bad); ok(!v2.ok && v2.errors.some(e => /not in the folder/.test(e)), 'a voice path of another unit is refused'); }
    await post('retry', { draft_id: cid, extra: 'no fire', tags: ['ability:tap', 'power:armor'] });
    d = await waitState(cid, /^preview$/);
    ok(!d.tag_problems.length && d.def.resources.unit.unit === unit2.unit, 'class retry: new tags met, the voice kept');
    await post('test', { draft_id: cid });
    d = await waitState(cid, /^testing (failed|success)/);
    ok(d.state === 'testing success' && spawned.at(-1)[1] === d.file, 'class: the test runner gets the class draft file');
    ok(d.talk.some(t => t.role === 'test' && /^PASS · uses 3/.test(t.text)), 'class: the test line says uses');
    const before = JSON.stringify(loadProfile(profileFile).characters.map(c => c.cards));
    r = await post('publish', { draft_id: cid });
    ok(r.status === 200 && r.json.ref?.branch === 'players/Gold-Team/field-medic' && git(['--git-dir', remoteClass, 'branch', '--list', 'players/*']).includes('players/Gold-Team/field-medic'),
      `class publish → ${r.json?.ref?.branch || r.json?.error} on the (fake) chaosD6-Classes`);
    ok(r.json.granted?.length === 0 && JSON.stringify(loadProfile(profileFile).characters.map(c => c.cards)) === before && r.json.draft.published?.class_ref?.id === 'class_field_medic' && r.json.draft.published.class_ref.sha256,
      'class publish: no archive card; the class ref (sha256) is on the draft');
    // a NEW character of the team may take the published class (user 2026-11-23): profile.custom_classes → catalog → create
    const P = await import('../profile.mjs');
    const pc = loadProfile(profileFile);
    const cc = P.customClassesOf(pc).find(x => x.id === 'class_field_medic');
    ok(cc?.ref?.sha256 === r.json.draft.published.class_ref.sha256 && cc.voice.length === d.def.resources.sounds.voice.length && cc.name === 'Field Medic',
      'class publish → profile.custom_classes (ref, name, the voice)');
    const pcat = P.loadCatalog(path.join(REPO, 'data'));
    const ui = P.catalogForUI(pcat, pc).classes.find(x => x.id === 'class_field_medic');
    ok(ui?.custom === true && ui.voice.length === cc.voice.length && !P.catalogForUI(pcat).classes.some(x => x.custom), 'the catalog offers the custom class (with its voice) to the editor');
    const draft = { ...P.newDraft(pcat, pc), name: 'Medic One', class_id: 'class_field_medic', class_ref: { id: 'class_field_medic', sha256: 'f'.repeat(64), libs: {} } };
    const p2 = P.createCharacter(structuredClone(pc), draft, pcat);
    const made = p2.characters.at(-1);
    ok(made.class_id === 'class_field_medic' && made.class_ref.sha256 === cc.ref.sha256, 'a new character takes the custom class with the TEAM\'s ref (not the client\'s)');
    let refused = '';
    try { P.createCharacter(structuredClone(pc), { ...P.newDraft(pcat, pc), name: 'X', class_id: 'class_not_published' }, pcat); } catch (e) { refused = e.message; }
    ok(/custom class must be one your team published/.test(refused), 'an unpublished custom class is refused');
    const merged = (await import('../profile-radicle.mjs')).mergeProfiles({ ...pc, custom_classes: [] }, pc);
    ok(merged.custom_classes?.some(x => x.id === 'class_field_medic'), 'the team-branch merge keeps custom_classes');
  }

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
  ok(dl.model.key_set === true && dl.model.host === '127.0.0.1:8096' && dl.model.fallback === 'h.example' && !JSON.stringify(dl).includes('secret-key'), 'GET drafts (desktop): the own 8B, else OCI h.example, key_set — no key');
  {   // the desktop: its own 8B first, OCI when it is not reachable (user 2026-11-23)
    const { genConfig: gc, complete } = await import('../effect-gen.mjs');
    const cfg = gc({}, { file: lf });
    ok(cfg.url === 'http://127.0.0.1:8096' && cfg.key === '' && cfg.fallback?.url === 'https://h.example/llm-big' && cfg.fallback.key === 'secret-key-0123456789abcdef', 'desktop config: local first, the OCI url + key as the fallback (no OCI key sent to localhost)');
    ok(gc({ CHAOSD6_MOBILE: '1' }, { file: lf }).url === 'https://h.example/llm-big' && !gc({ CHAOSD6_MOBILE: '1' }, { file: lf }).fallback && !gc({ LLM_BIG_URL: 'http://x:1' }, { file: lf }).fallback, 'phone / LLM_BIG_URL: that url only, no fallback');
    const hits = [];
    const fake = async (url, o) => { hits.push([url, o.headers.Authorization || '']); if (url.startsWith('http://127.0.0.1')) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8096'), { code: 'ECONNREFUSED' });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }) }; };
    let fb = null;
    const a1 = await complete(cfg, [{ role: 'user', content: 'x' }], { fetchImpl: fake, onFallback: (x) => { fb = x; } });
    const a2 = await complete(cfg, [{ role: 'user', content: 'y' }], { fetchImpl: fake });
    ok(a1.text === '{"a":1}' && a1.fell_back?.error === 'ECONNREFUSED' && fb?.to === 'https://h.example/llm-big' && hits[1][1] === 'Bearer secret-key-0123456789abcdef' && hits[0][1] === '',
      'own 8B refused → the same call goes to OCI with the OCI key');
    ok(a2.text && hits.length === 3 && hits[2][0].startsWith('https://h.example') && cfg.fell_back_from === 'http://127.0.0.1:8096', 'the next attempt goes straight to OCI');
    const c2 = gc({}, { file: lf }), hits2 = [];
    const httpErr = async (url) => { hits2.push(url); return { ok: false, status: 500, text: async () => 'boom' }; };
    ok((await complete(c2, [{ role: 'user', content: 'x' }], { fetchImpl: httpErr })).error.startsWith('http 500') && hits2.length === 1, 'a local http error is NOT a fallback (the 8B is there)');
  }
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
