#!/usr/bin/env node
// Oracle for game/skills-repo.mjs (+ the shared core game/defs-repo.mjs, skills-repo-sync.mjs and
// the repo's tools/: manifest.mjs, check.mjs, engine/, validator/, pins.json): hash stability, ref
// round-trip, load at a pinned commit (isomorphic-git and git CLI), tamper rejection, cache
// hit/miss, httpd fetcher URLs, cache dirs, tools sha256 recorded + enforced. Needs `git` on PATH
// (run inside WSL). Offline. Same coverage as effects-repo-check.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SKILLS_RID, canonicalJson, skillHash, skillRef, skillLibRef, parseSkillRef, verifySkill, buildSkillsManifest, createSkillCache,
  getSkillByRef, getSkillLibByRef, loadSkillsFrom, loadSkillLibsFrom, loadSkillSetFrom, gitSkillFetcher, gitSkillLibFetcher,
  httpdSkillFetcher, httpdSkillLibFetcher, skillsCacheDir, isPlayerBranch, SkillRefError,
} from '../skills-repo.mjs';
import { DefsRefError, createDefsRepo, sha256Hex } from '../defs-repo.mjs';
import * as effectsRepo from '../effects-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
const throwsCode = async (fn, code) => { try { await fn(); return false; } catch (e) { return e?.code === code || (code === '*' && !!e); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillrepo-'));
const sh = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', ...opts });

const A1 = { id: 'skill_alpha', name: 'Alpha', uses: ['std'], hooks: { onCast: { if: [{ '>': [{ var: 'a' }, 1] }, 2, 3] } }, power: 3 };
const A1_shuffled = { power: 3, hooks: { onCast: { if: [{ '>': [{ var: 'a' }, 1] }, 2, 3] } }, uses: ['std'], name: 'Alpha', id: 'skill_alpha' };
const A2 = { ...A1, power: 4 };
const B = { id: 'skill_beta', name: 'Beta', n: -0, f: 0.1, s: 'ü "q"\n', power: 1 };
const C = { id: 'skill_gamma', name: 'Gamma', power: 2 };
const LIB = { id: 'std', schema: 'chaosd6.skill-lib/1', subs: { one: { params: [], body: 1 } } };
const LIB2 = { ...LIB, subs: { ...LIB.subs, two: { params: [], body: 2 } } };

console.log('hash stability (shared core)');
ok(skillHash(A1) === skillHash(A1_shuffled), 'key order does not change the hash');
ok(skillHash(A1) === skillHash(JSON.parse(JSON.stringify(A1, null, 4))), 'whitespace does not change the hash');
ok(skillHash(A1) !== skillHash(A2), 'a changed value changes the hash');
ok(skillHash({ ...A1, uses: ['b', 'a'] }) !== skillHash({ ...A1, uses: ['a', 'b'] }), 'array order is significant');
ok(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 0, y: -0 } }) === '{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}', 'canonical form');
ok(await throwsCode(() => canonicalJson({ n: NaN }), '*'), 'NaN rejected');
ok(skillHash({ z: { c: null, b: false }, id: 'effect_x', a: [1, 'x'] }) === 'c38d7fc0ba5c5317ebd5baaf67e1544fbe43dd00b02230cbb844bdbae185b6fb', 'fixed test vector (same as effects)');
ok([A1, B, C, LIB].every(d => skillHash(d) === effectsRepo.effectHash(d)), 'skills and effects hash identically (one core)');
const tm = await import(pathToFileURL(path.join(HERE, 'skills-repo-template', 'tools', 'manifest.mjs')).href);
ok([A1, A2, B, C, LIB].every(d => tm.defHash(d) === skillHash(d)), 'repo tools/manifest.mjs hashes like the loader');

console.log('refs');
ok(SKILLS_RID === (process.env.CHAOSD6_SKILLS_RID || 'rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5'), `SKILLS_RID default/env (${SKILLS_RID})`);
const ref = skillRef(A1, { repo: 'rad:z2xbfJfwT3kukR73m8LXmmuvchEwr', branch: 'players/alice/alpha', commit: 'a'.repeat(40) });
ok(JSON.stringify(parseSkillRef(JSON.parse(JSON.stringify(ref)))) === JSON.stringify(ref), 'ref JSON round-trip');
ok(Object.keys(ref).sort().join() === 'branch,commit,id,repo,sha256', 'ref fields {repo, branch, commit, sha256, id}');
ok(skillRef(A1).repo === SKILLS_RID && parseSkillRef(skillRef(A1)).repo === SKILLS_RID, 'default repo = SKILLS_RID (placeholder accepted)');
ok(await throwsCode(() => parseSkillRef({ ...ref, sha256: 'xyz' }), 'bad-ref'), 'bad sha rejected');
ok(await throwsCode(() => parseSkillRef({ ...ref, id: '../etc/passwd' }), 'bad-id'), 'path-traversal id rejected');
ok(await throwsCode(() => parseSkillRef({ ...ref, commit: 'HEAD' }), 'bad-ref'), 'non-oid commit rejected');
ok(await throwsCode(() => parseSkillRef({ ...ref, repo: 'rad:../x' }), 'bad-ref'), 'bad repo rejected');
ok(isPlayerBranch('players/alice/alpha') && !isPlayerBranch('main') && !isPlayerBranch('players/x'), 'player branch convention');
ok(await throwsCode(() => verifySkill(A2, ref), 'sha-mismatch'), 'verifySkill: other version rejected');
try { verifySkill(A2, ref); } catch (e) { ok(e instanceof SkillRefError && e instanceof DefsRefError && e.name === 'SkillRefError' && /skill|sha256/.test(e.message), 'errors are SkillRefError (⊂ DefsRefError)'); }
try { parseSkillRef({ id: 7 }); } catch (e) { ok(/invalid skill id/.test(e.message), 'messages say "skill"', e.message); }
const man = buildSkillsManifest([B, A1], [LIB]);
ok(Object.keys(man).join() === 'format,hash,skills,lib' && Object.keys(man.skills).join() === 'skill_alpha,skill_beta' && man.skills.skill_alpha === ref.sha256 && man.lib.std === skillHash(LIB), 'manifest {skills, lib} sorted id → sha256');
ok(await throwsCode(() => buildSkillsManifest([A1, A2]), 'dup-id'), 'manifest rejects duplicate ids');
ok(JSON.stringify(effectsRepo.buildManifest([B, A1].map(d => ({ ...d, id: d.id.replace('skill', 'effect') })))).includes('"effects"') && !('lib' in effectsRepo.buildManifest([])), 'effects manifest shape unchanged (no lib key)');
const X = createDefsRepo({ kind: 'widget', subdir: 'widgets', rid: 'rad:zW', cacheEnv: 'X_CACHE' });
ok(X.path('w1') === 'widgets/w1.json' && new X.RefError('c', 'm').name === 'WidgetRefError' && X.buildManifest([{ id: 'w1' }]).widgets.w1, 'core: kind-parameterised (path, error name, manifest key)');

console.log('fake game/ (engine + validator) and sync');
const g = path.join(tmp, 'g'); fs.mkdirSync(path.join(g, 'tools'), { recursive: true });
fs.writeFileSync(path.join(g, 'eng-helper.mjs'), "export const MAXP = 5;\n");
fs.writeFileSync(path.join(g, 'effect-engine.mjs'), "import { MAXP } from './eng-helper.mjs';\nexport const ENGINE = 'fake';\nexport { MAXP };\n");
fs.writeFileSync(path.join(g, 'skills.mjs'), "import { MAXP } from './effect-engine.mjs';\nexport function validateSkillDef(def) { return typeof def.power === 'number' ? [] : ['power must be a number']; }\nexport { MAXP };\nexport async function neverCalled() { return import('./peer.mjs'); }\n");
fs.writeFileSync(path.join(g, 'peer.mjs'), "export const NOPE = 1;\n");
fs.writeFileSync(path.join(g, 'tools', 'skills-validator.mjs'), [
  "import fs from 'node:fs';",
  "import { MAXP } from '../skills.mjs';",
  "const cal = JSON.parse(fs.readFileSync(new URL('./skills-validator-calibration.json', import.meta.url), 'utf8'));",
  "export function checkSkill(def) { return { verdict: def.power * cal.k > MAXP ? 'too-strong' : 'ok', reasons: ['power ' + def.power] }; }",
  "const SELF = fs.readFileSync(new URL(import.meta.url), 'utf8').split(String.fromCharCode(13)).join('');",
  "const LIBD = new URL('../skills-data/lib/', import.meta.url);",
  "const LIBN = fs.existsSync(LIBD) ? fs.readdirSync(LIBD).length : -1;",
  "export function computePin() { return { format: 'fake-pin/1', pin_id: SELF.length + '.' + cal.k + '.' + LIBN, accept: ['ok'] }; }",
  "export function verifyPin(pin) { const m = computePin(); return { ok: pin?.pin_id === m.pin_id, diffs: pin?.pin_id === m.pin_id ? [] : ['pin_id'] }; }",
  '',
].join('\r\n'));   // CRLF source: pins are over LF bytes
fs.writeFileSync(path.join(g, 'tools', 'skills-validator-calibration.json'), '{ "k": 1 }\n');
const src = path.join(g, 'skills-data'); fs.mkdirSync(path.join(src, 'skills'), { recursive: true }); fs.mkdirSync(path.join(src, 'lib'));
fs.writeFileSync(path.join(src, 'SCHEMA.md'), '# skills schema\n'); fs.writeFileSync(path.join(src, 'HOOKS.md'), '# hooks\r\n');
// skill isolation: the JS oracle (<src>/oracle/*.mjs) is mirrored byte-identical (LF) to oracle/, never into tools/engine
fs.mkdirSync(path.join(src, 'oracle'));
fs.writeFileSync(path.join(src, 'oracle', 'skills-js.mjs'), "import { MAXP } from '../../skills.mjs';\r\nexport const HOOKS = { max: () => MAXP };\r\n");
fs.writeFileSync(path.join(src, 'oracle', 'old-js.mjs'), "export const OLD = 1;\n");
const repo = path.join(tmp, 'repo');
const sync = (...a) => { const r = node([path.join(HERE, 'skills-repo-sync.mjs'), '--repo', repo, '--src', src, '--game-root', g, ...a]); if (r.status) throw new Error(r.stdout + r.stderr); return r.stdout; };
const put = (d, sub = 'skills', pretty = 2) => fs.writeFileSync(path.join(src, sub, `${d.id}.json`), JSON.stringify(d, null, pretty));
put(A1); put(B); put(LIB, 'lib');
const dry = sync('--dry-run');
ok(dry.includes('dry run') && !fs.existsSync(repo), '--dry-run writes nothing');
sync('-m', 'one');
const c1 = sh(repo, 'rev-parse', 'HEAD');
ok(fs.existsSync(path.join(repo, 'oracle', 'old-js.mjs')) && fs.readFileSync(path.join(repo, 'oracle', 'skills-js.mjs'), 'utf8') === "import { MAXP } from '../../skills.mjs';\nexport const HOOKS = { max: () => MAXP };\n", 'oracle/*.mjs mirrored from src (LF)');
fs.unlinkSync(path.join(src, 'skills', 'skill_beta.json')); put(A2, 'skills', 0); put(C); put(LIB2, 'lib');
fs.unlinkSync(path.join(src, 'oracle', 'old-js.mjs'));
sync('-m', 'two');
const c2 = sh(repo, 'rev-parse', 'HEAD');
ok(c1 !== c2 && sh(repo, 'rev-list', '--count', 'HEAD') === '2', 'sync committed twice locally');
ok(!fs.existsSync(path.join(repo, 'oracle', 'old-js.mjs')) && fs.existsSync(path.join(repo, 'oracle', 'skills-js.mjs')), 'a stale oracle file is pruned');
ok(sh(repo, 'remote') === '', 'sync added no remote (local only)');
ok(node([path.join(repo, 'tools', 'manifest.mjs'), '--check']).stdout.includes('ok (2 skills, 1 libs)'), 'repo index.json fresh (manifest --check)');
ok(['README.md', 'SCHEMA.md', 'HOOKS.md', '.gitattributes', 'validator/pin.json', 'tools/README.md', 'tools/check.mjs'].every(f => fs.existsSync(path.join(repo, f))), 'skeleton files present (README, SCHEMA, HOOKS, pin, tools/README, check)');
ok(fs.readFileSync(path.join(repo, 'SCHEMA.md'), 'utf8') === '# skills schema\n' && !fs.readFileSync(path.join(repo, 'HOOKS.md'), 'utf8').includes('\r'), 'SCHEMA/HOOKS mirrored from src, LF');
ok(!sync().includes('committed'), 'sync is idempotent (no empty commit)');

console.log('tools/ mirrored + sha256 recorded');
const pins = JSON.parse(fs.readFileSync(path.join(repo, 'tools', 'pins.json'), 'utf8'));
ok(Object.keys(pins.engine.files).sort().join() === 'effect-engine.mjs,eng-helper.mjs,skills.mjs', 'engine/ = entries + their import closure', Object.keys(pins.engine.files).join());
ok(pins.engine.entry.skills === 'skills.mjs' && pins.engine.entry.effect_engine === 'effect-engine.mjs', 'engine entries recorded');
ok(pins.validator.entry === 'skills-validator.mjs' && Object.keys(pins.validator.files).sort().join() === 'skills-validator-calibration.json,skills-validator.mjs', 'validator/ = validator + calibration');
ok(pins.unresolved.length === 1 && pins.unresolved[0].import === 'g/peer.mjs', 'peer.mjs never mirrored (listed unresolved)', JSON.stringify(pins.unresolved));
const vtxt = fs.readFileSync(path.join(repo, 'tools', 'validator', 'skills-validator.mjs'), 'utf8');
ok(vtxt === fs.readFileSync(path.join(g, 'tools', 'skills-validator.mjs'), 'utf8').replace(/\r\n/g, '\n') && vtxt.includes("from '../skills.mjs'"), 'validator copied byte-identical (LF), imports untouched');
ok(pins.validator.files['skills-validator.mjs'].source === 'g/tools/skills-validator.mjs' && pins.engine.files['skills.mjs'].source === 'g/skills.mjs' && pins.game_dir === 'g', 'chaosD6 source paths recorded (layout for staging)');
const vpinFile = JSON.parse(fs.readFileSync(path.join(repo, 'validator', 'pin.json'), 'utf8'));
ok(vpinFile.format === 'fake-pin/1' && vpinFile.pin_id === pins.validator.pin_id, "validator/pin.json = the validator's computePin(), pin_id in pins.json");
const allRecorded = [['', pins.self.files], ['engine', pins.engine.files], ['validator', pins.validator.files]].every(([area, files]) =>
  Object.entries(files).every(([rel, rec]) => sha256Hex(fs.readFileSync(path.join(repo, 'tools', area, rel), 'utf8')) === rec.sha256));
ok(allRecorded && Object.keys(pins.self.files).sort().join() === 'README.md,check.mjs,manifest.mjs', 'every tools file sha256 matches pins.json');
ok(pins.engine.files['effect-engine.mjs'].sha256 === sha256Hex(fs.readFileSync(path.join(g, 'effect-engine.mjs'), 'utf8')), 'engine sha256 = sha of the chaosD6 file');
const shaMap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.sha256]));
ok(pins.tools_sha256 === sha256Hex(canonicalJson({ self: shaMap(pins.self.files), engine: shaMap(pins.engine.files), validator: shaMap(pins.validator.files) })), 'tools_sha256 over {self, engine, validator}');

console.log('tools/check.mjs (offline)');
const check = (...a) => node([path.join(repo, 'tools', 'check.mjs'), ...a], { cwd: repo });
let r = check('skills/skill_gamma.json');
ok(r.status === 0 && /ok\s+skills\/skill_gamma\.json.*schema:ok engine:ok validator:ok \(ok\)/.test(r.stdout), 'good skill passes schema + engine + validator (staged layout)', r.stdout);
ok(/validator pin: ok/.test(r.stdout), 'validator/pin.json verified against the staged validator (verifyPin)', r.stdout);
r = check('--all', '--json');
const J = JSON.parse(r.stdout);
ok(r.status === 0 && J.ok && J.results.length === 2 && J.results.every(x => x.sha256 === skillHash(JSON.parse(fs.readFileSync(path.join(repo, x.file), 'utf8')))), '--all --json: sha256 per skill');
const scratch = path.join(tmp, 'prop'); fs.mkdirSync(scratch);
const wr = (d, n = `${d.id}.json`) => { const f = path.join(scratch, n); fs.writeFileSync(f, JSON.stringify(d)); return f; };
r = check(wr({ id: 'skill_big', power: 9 }));
ok(r.status === 1 && r.stdout.includes('too-strong'), 'validator verdict outside accept → fail');
r = check(wr({ id: 'skill_nopow' }));
ok(r.status === 1 && r.stdout.includes('power must be a number'), 'pinned engine validateSkillDef runs');
r = check(wr({ id: 'skill_lib', power: 1, uses: ['nolib'] }));
ok(r.status === 1 && r.stdout.includes('unknown lib nolib'), 'unknown lib → schema fail');
r = check(wr({ id: 'skill_x', power: 1 }, 'other_name.json'));
ok(r.status === 1 && r.stdout.includes('file name must be skill_x.json'), 'id ≠ file name → schema fail');
r = check(wr({ id: 'skill_big', power: 9 }), '--no-validator');
ok(r.status === 0 && r.stdout.includes('validator:skipped'), '--no-validator skips the validator');
fs.writeFileSync(path.join(repo, 'validator', 'pin.json'), JSON.stringify({ ...vpinFile, pin_id: 'other' }));
r = check('skills/skill_gamma.json');
ok(r.status === 1 && /validator pin: FAIL/.test(r.stdout), 'validator/pin.json for another validator → FAIL', r.stdout);
sh(repo, 'checkout', '--', 'validator/pin.json');
fs.appendFileSync(path.join(repo, 'tools', 'engine', 'eng-helper.mjs'), '// tampered\n');
r = check('skills/skill_gamma.json');
ok(r.status === 1 && /pins: FAIL[\s\S]*tools\/engine\/eng-helper\.mjs: sha256/.test(r.stdout), 'tampered engine file → pins FAIL', r.stdout);
sh(repo, 'checkout', '--', 'tools/engine/eng-helper.mjs');
ok(check('skills/skill_gamma.json').status === 0, 'restored → pass again');

console.log('load at a pinned commit');
for (const engine of ['isomorphic', 'git']) {
  const L1 = await loadSkillsFrom({ dir: repo, commit: c1, engine, repo: 'rad:zTest', branch: 'main' });
  const L2 = await loadSkillsFrom({ dir: repo, commit: c2, engine });
  ok(L1.commit === c1 && Object.keys(L1.skills).join() === 'skill_alpha,skill_beta', `${engine}: commit 1 = alpha+beta`);
  ok(skillHash(L1.skills.skill_alpha) === skillHash(A1) && L1.refs.skill_alpha.commit === c1 && L1.refs.skill_alpha.repo === 'rad:zTest', `${engine}: commit 1 alpha is v1, ref pinned`);
  ok(Object.keys(L2.skills).join() === 'skill_alpha,skill_gamma' && L2.refs.skill_alpha.sha256 === skillHash(A2), `${engine}: commit 2 = alpha v2 + gamma`);
  const LL1 = await loadSkillLibsFrom({ dir: repo, commit: c1, engine }); const LL2 = await loadSkillLibsFrom({ dir: repo, commit: c2, engine });
  ok(skillHash(LL1.libs.std) === skillHash(LIB) && skillHash(LL2.libs.std) === skillHash(LIB2) && LL2.refs.std.sha256 === skillHash(LIB2), `${engine}: lib/std pinned per commit`);
  const LH = await loadSkillSetFrom({ dir: repo, commit: 'main', engine });
  ok(LH.commit === c2 && LH.refs.skill_gamma.branch === 'main' && LH.libRefs.std.branch === 'main' && LH.libs.std && !LH.errors.length, `${engine}: skill set at branch tip (skills + libs)`);
  const LG = await loadSkillsFrom({ gitdir: path.join(repo, '.git'), commit: c1, engine });
  ok(Object.keys(LG.skills).length === 2, `${engine}: gitdir works (Radicle storage style)`);
}
fs.writeFileSync(path.join(repo, 'skills', 'skill_wrong.json'), JSON.stringify({ id: 'skill_other' }));
sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'bad');
const LB = await loadSkillsFrom({ dir: repo });
ok(!LB.skills.skill_other && !LB.skills.skill_wrong && LB.errors.length === 1 && LB.errors[0].file === 'skills/skill_wrong.json', 'id/file-name mismatch reported in errors');

console.log('cache + getSkillByRef');
const cache = createSkillCache({ dir: path.join(tmp, 'cache') });
const r1 = skillRef(A1, { commit: c1 });
let calls = 0;
const gitF = gitSkillFetcher({ dir: repo });
const counting = async (x) => { calls++; return gitF(x); };
const got1 = await getSkillByRef(r1, { cache, fetch: counting });
ok(skillHash(got1) === r1.sha256 && calls === 1 && cache.stats.misses === 1, 'miss → fetched old commit from git, verified');
ok(fs.readFileSync(cache.path(r1.sha256), 'utf8') === canonicalJson(A1), 'cached as <sha256>.json (canonical)');
const got2 = await getSkillByRef(r1, { cache, fetch: counting });
ok(calls === 1 && cache.stats.hits === 1 && skillHash(got2) === r1.sha256, 'hit → no fetch');
const [p1, p2] = await Promise.all([getSkillByRef(skillRef(C, { commit: c2 }), { cache, fetch: counting }), getSkillByRef(skillRef(C, { commit: c2 }), { cache, fetch: counting })]);
ok(calls === 2 && p1.id === p2.id, 'concurrent misses share one fetch');
ok(await throwsCode(() => getSkillByRef(skillRef(B, { commit: c2 }), { cache, fetch: gitF }), 'not-found'), 'absent at commit → not-found');
ok(await throwsCode(() => getSkillByRef(skillRef(B), { cache }), 'not-found'), 'no fetcher → not-found');
const lib1 = await getSkillLibByRef(skillLibRef(LIB, { commit: c1 }), { cache, fetch: gitSkillLibFetcher({ dir: repo, engine: 'git' }) });
ok(skillHash(lib1) === skillHash(LIB), 'lib by ref from lib/<id>.json at the old commit (git CLI)');
ok(await throwsCode(() => getSkillLibByRef(skillLibRef(LIB2, { commit: c1 }), { cache, fetch: gitSkillLibFetcher({ dir: repo }) }), 'sha-mismatch'), 'lib v2 ref at commit 1 → sha-mismatch');

console.log('tamper');
const rB = skillRef(B, { commit: c1 });
const evil = async () => ({ ...B, n: 99 });
ok(await throwsCode(() => getSkillByRef(rB, { cache, fetch: evil }), 'sha-mismatch'), 'tampered fetch → sha-mismatch');
ok(!cache.has(rB.sha256), 'tampered definition not cached');
ok(await throwsCode(() => getSkillByRef(rB, { cache, fetch: async () => ({ ...C, id: 'skill_beta' }) }), 'sha-mismatch'), 'substituted definition rejected');
ok(skillHash(await getSkillByRef(rB, { cache, fetch: [evil, gitF] })) === rB.sha256, 'fetcher list: bad source skipped, good one accepted');
fs.writeFileSync(cache.path(rB.sha256), canonicalJson({ ...B, n: 5 }));
ok(cache.get(rB.sha256) === null && !cache.has(rB.sha256) && cache.stats.corrupt === 1, 'tampered cache file → miss + deleted');
ok((await getSkillByRef(rB, { cache, fetch: gitF })).id === 'skill_beta', 're-fetched after cache tamper');

console.log('httpd fetchers');
let seenUrl = '';
const fakeFetch = (body) => async (url) => { seenUrl = url; return { ok: true, status: 200, json: async () => ({ content: JSON.stringify(body, null, 2), binary: false }) }; };
const cacheH = createSkillCache({ dir: path.join(tmp, 'cacheH') });
await getSkillByRef({ ...r1, repo: 'z2xbfJfwT3kukR73m8LXmmuvchEwr' }, { cache: cacheH, fetch: httpdSkillFetcher({ seedHost: 'seed.example', rid: 'rad:zDefault', fetchImpl: fakeFetch(A1) }) });
ok(seenUrl === `https://seed.example/api/v1/repos/rad:z2xbfJfwT3kukR73m8LXmmuvchEwr/blob/${c1}/skills/skill_alpha.json`, 'URL = /api/v1/repos/<rid>/blob/<commit>/skills/<id>.json', seenUrl);
await getSkillLibByRef({ ...skillLibRef(LIB, { commit: c1 }), repo: '' }, { cache: cacheH, fetch: httpdSkillLibFetcher({ seedHost: 'https://seed.example/', rid: 'rad:zDefault', fetchImpl: fakeFetch(LIB) }) });
ok(seenUrl === `https://seed.example/api/v1/repos/rad:zDefault/blob/${c1}/lib/std.json`, 'lib URL …/lib/<id>.json; empty ref.repo → default rid', seenUrl);
const h404 = httpdSkillFetcher({ seedHost: 'seed.example', fetchImpl: async () => ({ ok: false, status: 404 }) });
ok(await throwsCode(() => getSkillByRef(skillRef(C, { commit: c2 }), { cache: cacheH, fetch: h404 }), 'not-found'), 'httpd 404 → not-found');

console.log('cache dir');
const env = { ...process.env };
for (const k of ['CHAOSD6_SKILLS_CACHE', 'CHAOSD6_EFFECTS_CACHE', 'CHAOSD6_USER_DATA_DIR']) delete process.env[k];
process.env.XDG_DATA_HOME = '/x/share';
ok(skillsCacheDir() === '/x/share/chaosd6/skills', 'desktop: $XDG_DATA_HOME/chaosd6/skills');
process.env.CHAOSD6_USER_DATA_DIR = '/data/user/0/app/files/data';
ok(skillsCacheDir() === '/data/user/0/app/files/data/skills', 'phone: <filesDir>/data/skills');
process.env.CHAOSD6_SKILLS_CACHE = '/t/s';
ok(skillsCacheDir() === '/t/s' && effectsRepo.effectsCacheDir() === '/data/user/0/app/files/data/effects', 'override: $CHAOSD6_SKILLS_CACHE (effects cache unaffected)');
for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
Object.assign(process.env, env);

console.log('real tree: dry-run sync over game/');
r = node([path.join(HERE, 'skills-repo-sync.mjs'), '--repo', path.join(tmp, 'real'), '--dry-run']);
ok(r.status === 0 && /tools: engine [^\n]*effect-engine\.mjs/.test(r.stdout) && !fs.existsSync(path.join(tmp, 'real')), 'default engine includes game/effect-engine.mjs; nothing written', r.stdout + r.stderr);
r = node([path.join(HERE, 'skills-repo-sync.mjs'), '--repo', path.join(tmp, 'real'), '--no-commit']);
const realPins = r.status === 0 ? JSON.parse(fs.readFileSync(path.join(tmp, 'real', 'tools', 'pins.json'), 'utf8')) : null;
ok(realPins && !realPins.unresolved.length && realPins.engine.files['effect-engine.mjs']?.sha256 === sha256Hex(fs.readFileSync(path.join(GAME, 'effect-engine.mjs'), 'utf8').replace(/\r\n/g, '\n')), 'real sync: engine pinned to game/effect-engine.mjs, nothing unresolved', r.stdout + r.stderr);
// skill isolation: the oracle is mirrored to oracle/ (byte-identical, LF) and stays out of the engine closure
const realOracle = path.join(GAME, 'skills-data', 'oracle', 'skills-js.mjs');
if (fs.existsSync(realOracle)) ok(realPins && fs.readFileSync(path.join(tmp, 'real', 'oracle', 'skills-js.mjs'), 'utf8') === fs.readFileSync(realOracle, 'utf8').replace(/\r\n/g, '\n')
  && !Object.keys(realPins.engine.files).some(f => /oracle/.test(f)) && !Object.keys(realPins.validator.files || {}).some(f => /oracle/.test(f)), 'real sync: oracle/skills-js.mjs mirrored, not in tools/engine or tools/validator', JSON.stringify(Object.keys(realPins?.engine?.files || {})));
if (realPins?.validator?.entry) {
  const probe = path.join(tmp, 'real', 'skills', 'skill_s3_probe.json');
  fs.writeFileSync(probe, JSON.stringify({ id: 'skill_s3_probe' }));
  r = node([path.join(tmp, 'real', 'tools', 'check.mjs'), probe, '--json'], { cwd: path.join(tmp, 'real') });
  let RJ = null; try { RJ = JSON.parse(r.stdout); } catch {}
  ok(RJ && RJ.pins === 'ok' && !RJ.load.length && RJ.validator_pin.ok && /^ok/.test(RJ.validator_pin.why) && RJ.results[0].steps.validator,
    `real validator (${realPins.validator.entry}) runs offline from the repo, its pin matches (verdict ${RJ?.results?.[0]?.verdict ?? '?'})`, r.stdout.slice(0, 600) + r.stderr.slice(0, 600));
} else ok(true, 'real sync: no skills validator in game/tools yet (skipped)');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nskills-repo-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
