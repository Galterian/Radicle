#!/usr/bin/env node
// Oracle for game/effects-repo.mjs (+ effects-repo-sync.mjs and the repo's tools/manifest.mjs):
// hash stability, ref round-trip, load at a pinned commit (isomorphic-git and git CLI), tamper
// rejection, cache hit/miss, httpd fetcher URL. Needs `git` on PATH (run inside WSL). Offline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalJson, effectHash, effectRef, parseEffectRef, verifyEffect, buildManifest, createEffectCache,
  getEffectByRef, loadEffectsFrom, gitEffectFetcher, httpdEffectFetcher, effectsCacheDir, isPlayerBranch,
  buildEffectsManifest, effectHooksHash, effectHooksRef, parseEffectHooksRef, getEffectHooksByRef, gitEffectHooksFetcher,
  httpdEffectHooksFetcher, loadEffectSetFrom, effectHookFiles,
  effectLibHash, effectLibRef, parseEffectLibRef, getEffectLibByRef, gitEffectLibFetcher, httpdEffectLibFetcher,   // LR
  effectLibFiles, loadRunnableEffectsFrom,
} from '../effects-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
const throwsCode = async (fn, code) => { try { await fn(); return false; } catch (e) { return e?.code === code || (code === '*' && !!e); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'effrepo-'));
const sh = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();

const A1 = { id: 'effect_alpha', name: 'Alpha', cost: { world: 2, will: 1 }, tags: ['x', 'y'], rule: { if: [{ '>': [{ var: 'a' }, 1] }, 2, 3] } };
const A1_shuffled = { rule: { if: [{ '>': [{ var: 'a' }, 1] }, 2, 3] }, tags: ['x', 'y'], cost: { will: 1, world: 2 }, name: 'Alpha', id: 'effect_alpha' };
const A2 = { ...A1, cost: { world: 3, will: 1 } };
const B = { id: 'effect_beta', name: 'Beta', n: -0, f: 0.1, s: 'ü "q"\n' };
const C = { id: 'effect_gamma', name: 'Gamma' };

console.log('hash stability');
ok(effectHash(A1) === effectHash(A1_shuffled), 'key order does not change the hash');
ok(effectHash(A1) === effectHash(JSON.parse(JSON.stringify(A1, null, 4))), 'whitespace does not change the hash');
ok(effectHash(A1) !== effectHash(A2), 'a changed value changes the hash');
ok(effectHash({ ...A1, tags: ['y', 'x'] }) !== effectHash(A1), 'array order is significant');
ok(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 0, y: -0 } }) === '{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}', 'canonical form');
ok(effectHash({ id: 'x', u: undefined }) === effectHash({ id: 'x' }), 'undefined members dropped');
ok(await throwsCode(() => canonicalJson({ n: NaN }), '*'), 'NaN rejected');
ok(/^[0-9a-f]{64}$/.test(effectHash(B)), 'hex sha256');
// fixed vector: sha256 of '{"a":[1,"x"],"id":"effect_x","z":{"b":false,"c":null}}' (sha256sum) — guards the format
ok(effectHash({ z: { c: null, b: false }, id: 'effect_x', a: [1, 'x'] }) === 'c38d7fc0ba5c5317ebd5baaf67e1544fbe43dd00b02230cbb844bdbae185b6fb', 'fixed test vector');
const tm = await import(pathToFileURL(path.join(HERE, 'effects-repo-template', 'tools', 'manifest.mjs')).href);
ok([A1, A2, B, C].every(d => tm.effectHash(d) === effectHash(d)), "repo tools/manifest.mjs hashes like the loader");

console.log('refs');
const ref = effectRef(A1, { repo: 'rad:z2xbfJfwT3kukR73m8LXmmuvchEwr', branch: 'players/alice/alpha', commit: 'a'.repeat(40) });
const rt = parseEffectRef(JSON.parse(JSON.stringify(ref)));
ok(JSON.stringify(rt) === JSON.stringify(ref), 'ref JSON round-trip');
ok(Object.keys(ref).sort().join() === 'branch,commit,id,repo,sha256', 'ref fields {repo, branch, commit, sha256, id}');
ok(ref.sha256 === effectHash(A1) && ref.id === 'effect_alpha', 'ref sha256/id');
ok(await throwsCode(() => parseEffectRef({ ...ref, sha256: 'xyz' }), 'bad-ref'), 'bad sha rejected');
ok(await throwsCode(() => parseEffectRef({ ...ref, id: '../etc/passwd' }), 'bad-id'), 'path-traversal id rejected');
ok(await throwsCode(() => parseEffectRef({ ...ref, commit: 'HEAD' }), 'bad-ref'), 'non-oid commit rejected');
ok(isPlayerBranch('players/alice/alpha') && !isPlayerBranch('main') && !isPlayerBranch('players/x'), 'player branch convention');
ok(await throwsCode(() => verifyEffect(A2, ref), 'sha-mismatch'), 'verifyEffect: other version rejected');
const man = buildManifest([B, A1]);
ok(Object.keys(man.effects).join() === 'effect_alpha,effect_beta' && man.effects.effect_alpha === ref.sha256, 'manifest sorted id → sha256');
ok(await throwsCode(() => buildManifest([A1, A2]), 'dup-id'), 'manifest rejects duplicate ids');

console.log('load at a pinned commit');
const src = path.join(tmp, 'src', 'effects'); fs.mkdirSync(src, { recursive: true });
const repo = path.join(tmp, 'repo');
const sync = (...a) => execFileSync(process.execPath, [path.join(HERE, 'effects-repo-sync.mjs'), '--repo', repo, '--src', src, ...a], { encoding: 'utf8' });
const put = (d, pretty = 2) => fs.writeFileSync(path.join(src, `${d.id}.json`), JSON.stringify(d, null, pretty));
put(A1); put(B);
sync('-m', 'one');
const c1 = sh(repo, 'rev-parse', 'HEAD');
fs.unlinkSync(path.join(src, 'effect_beta.json')); put(A2, 0); put(C);
sync('-m', 'two');
const c2 = sh(repo, 'rev-parse', 'HEAD');
ok(c1 !== c2 && sh(repo, 'rev-list', '--count', 'HEAD') === '2', 'sync committed twice locally');
ok(sh(repo, 'remote').trim() === '', 'sync added no remote (local only)');
ok(execFileSync(process.execPath, [path.join(repo, 'tools', 'manifest.mjs'), '--check'], { encoding: 'utf8' }).includes('ok (2 effects)'), 'repo index.json fresh (manifest --check)');
ok(fs.existsSync(path.join(repo, 'README.md')) && fs.existsSync(path.join(repo, 'validator', 'pin.json')) && fs.existsSync(path.join(repo, 'SCHEMA.md')), 'skeleton files present');
ok(!sync().includes('committed'), 'sync is idempotent (no empty commit)');
for (const engine of ['isomorphic', 'git']) {
  const L1 = await loadEffectsFrom({ dir: repo, commit: c1, engine, repo: 'rad:zTest', branch: 'main' });
  const L2 = await loadEffectsFrom({ dir: repo, commit: c2, engine });
  ok(L1.commit === c1 && Object.keys(L1.effects).join() === 'effect_alpha,effect_beta', `${engine}: commit 1 = alpha+beta`);
  ok(effectHash(L1.effects.effect_alpha) === effectHash(A1) && L1.refs.effect_alpha.commit === c1 && L1.refs.effect_alpha.repo === 'rad:zTest', `${engine}: commit 1 alpha is v1, ref pinned`);
  ok(Object.keys(L2.effects).join() === 'effect_alpha,effect_gamma' && L2.refs.effect_alpha.sha256 === effectHash(A2), `${engine}: commit 2 = alpha v2 + gamma`);
  const LH = await loadEffectsFrom({ dir: repo, commit: 'main', engine });
  ok(LH.commit === c2 && LH.refs.effect_gamma.branch === 'main', `${engine}: branch name resolves to the tip`);
  const LG = await loadEffectsFrom({ gitdir: path.join(repo, '.git'), commit: c1, engine });
  ok(Object.keys(LG.effects).length === 2, `${engine}: gitdir works (Radicle storage style)`);
}
// a mis-named file is reported, not loaded
fs.writeFileSync(path.join(repo, 'effects', 'effect_wrong.json'), JSON.stringify({ id: 'effect_other' }));
sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'bad');
const LB = await loadEffectsFrom({ dir: repo });
ok(!LB.effects.effect_other && !LB.effects.effect_wrong && LB.errors.length === 1, 'id/file-name mismatch reported in errors');

console.log('cache + getEffectByRef');
const cache = createEffectCache({ dir: path.join(tmp, 'cache') });
const r1 = effectRef(A1, { commit: c1 });
let calls = 0;
const gitF = gitEffectFetcher({ dir: repo });
const counting = async (r) => { calls++; return gitF(r); };
const got1 = await getEffectByRef(r1, { cache, fetch: counting });
ok(effectHash(got1) === r1.sha256 && calls === 1 && cache.stats.misses === 1, 'miss → fetched old commit from git, verified');
ok(fs.existsSync(cache.path(r1.sha256)) && fs.readFileSync(cache.path(r1.sha256), 'utf8') === canonicalJson(A1), 'cached as <sha256>.json (canonical)');
const got2 = await getEffectByRef(r1, { cache, fetch: counting });
ok(calls === 1 && cache.stats.hits === 1 && effectHash(got2) === r1.sha256, 'hit → no fetch');
const [p1, p2] = await Promise.all([getEffectByRef(effectRef(C, { commit: c2 }), { cache, fetch: counting }), getEffectByRef(effectRef(C, { commit: c2 }), { cache, fetch: counting })]);
ok(calls === 2 && p1.id === p2.id, 'concurrent misses share one fetch');
ok(await throwsCode(() => getEffectByRef(effectRef(B, { commit: c2 }), { cache, fetch: gitF }), 'not-found'), 'absent at commit → not-found');
ok(await throwsCode(() => getEffectByRef(effectRef(B), { cache }), 'not-found'), 'no fetcher → not-found');

console.log('tamper');
const rB = effectRef(B, { commit: c1 });
const evil = async () => ({ ...B, n: 99 });
ok(await throwsCode(() => getEffectByRef(rB, { cache, fetch: evil }), 'sha-mismatch'), 'tampered fetch → sha-mismatch');
ok(!cache.has(rB.sha256), 'tampered definition not cached');
const renamed = { ...C, id: 'effect_beta' };
ok(await throwsCode(() => getEffectByRef(effectRef(B, { commit: c1 }), { cache, fetch: async () => renamed }), 'sha-mismatch'), 'substituted definition rejected');
const got3 = await getEffectByRef(rB, { cache, fetch: [evil, gitF] });
ok(effectHash(got3) === rB.sha256, 'fetcher list: bad source skipped, good one accepted');
fs.writeFileSync(cache.path(rB.sha256), canonicalJson({ ...B, n: 5 }));
ok(cache.get(rB.sha256) === null && !cache.has(rB.sha256) && cache.stats.corrupt === 1, 'tampered cache file → miss + deleted');
ok((await getEffectByRef(rB, { cache, fetch: gitF })).id === 'effect_beta', 're-fetched after cache tamper');

console.log('httpd fetcher');
let seenUrl = '';
const fakeFetch = async (url) => { seenUrl = url; return { ok: true, status: 200, json: async () => ({ content: JSON.stringify(A1, null, 2), binary: false }) }; };
const h = httpdEffectFetcher({ seedHost: 'seed.example', rid: 'rad:zDefault', fetchImpl: fakeFetch });
const cacheH = createEffectCache({ dir: path.join(tmp, 'cacheH') });
await getEffectByRef({ ...r1, repo: 'z2xbfJfwT3kukR73m8LXmmuvchEwr' }, { cache: cacheH, fetch: h });
ok(seenUrl === `https://seed.example/api/v1/repos/rad:z2xbfJfwT3kukR73m8LXmmuvchEwr/blob/${c1}/effects/effect_alpha.json`, 'URL = /api/v1/repos/<rid>/blob/<commit>/effects/<id>.json', seenUrl);
await getEffectByRef({ ...effectRef(A2, { commit: c2 }), repo: '' }, { cache: cacheH, fetch: h }).catch(() => {});
ok(seenUrl.includes('/rad:zDefault/'), 'empty ref.repo → default rid');
const h404 = httpdEffectFetcher({ seedHost: 'seed.example', fetchImpl: async () => ({ ok: false, status: 404 }) });
ok(await throwsCode(() => getEffectByRef(effectRef(C, { commit: c2 }), { cache: cacheH, fetch: h404 }), 'not-found'), 'httpd 404 → not-found');

console.log('cache dir');
const env = { ...process.env };
delete process.env.CHAOSD6_EFFECTS_CACHE; delete process.env.CHAOSD6_USER_DATA_DIR; process.env.XDG_DATA_HOME = '/x/share';
ok(effectsCacheDir() === '/x/share/chaosd6/effects', 'desktop: $XDG_DATA_HOME/chaosd6/effects');
process.env.CHAOSD6_USER_DATA_DIR = '/data/user/0/app/files/data';
ok(effectsCacheDir() === '/data/user/0/app/files/data/effects', 'phone: $CHAOSD6_USER_DATA_DIR/effects');
process.env.CHAOSD6_EFFECTS_CACHE = '/t/c';
ok(effectsCacheDir() === '/t/c', 'override: $CHAOSD6_EFFECTS_CACHE');
Object.assign(process.env, env);
for (const k of ['CHAOSD6_EFFECTS_CACHE', 'CHAOSD6_USER_DATA_DIR', 'XDG_DATA_HOME']) if (!(k in env)) delete process.env[k];

console.log('hooks (HR: effect hook programs in the repo)');
{
  const hsrc = path.join(tmp, 'hsrc'); const hEff = path.join(hsrc, 'effects'); const hHooks = path.join(hsrc, 'hooks');
  fs.mkdirSync(hEff, { recursive: true }); fs.mkdirSync(hHooks, { recursive: true });
  fs.writeFileSync(path.join(hEff, 'effect_alpha.json'), JSON.stringify(A1));
  const BUNDLED_HOOKS = path.join(HERE, '..', 'effects-data', 'hooks');
  const realHooks = fs.readdirSync(BUNDLED_HOOKS).filter(n => n.endsWith('.json')).sort();
  for (const n of realHooks) fs.copyFileSync(path.join(BUNDLED_HOOKS, n), path.join(hHooks, n));
  const hrepo = path.join(tmp, 'hrepo');
  const hsync = (...a) => execFileSync(process.execPath, [path.join(HERE, 'effects-repo-sync.mjs'), '--repo', hrepo, '--src', hEff, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out1 = hsync('-m', 'h1');
  const h1 = sh(hrepo, 'rev-parse', 'HEAD');
  ok(out1.includes(`${realHooks.length} hook file(s)`) && realHooks.every(n => fs.existsSync(path.join(hrepo, 'hooks', n))), 'sync mirrors <src>/../hooks/*.json → hooks/', out1);
  const idx = JSON.parse(fs.readFileSync(path.join(hrepo, 'index.json'), 'utf8'));
  const want = Object.fromEntries(realHooks.map(n => { const f = JSON.parse(fs.readFileSync(path.join(BUNDLED_HOOKS, n), 'utf8').replace(/^﻿/, '')); return [f.id, effectHooksHash(f)]; }));
  ok(JSON.stringify(idx.hooks) === JSON.stringify(want) && idx.effects.effect_alpha === effectHash(A1), 'index.json lists hooks {family: sha256} beside effects');
  ok(JSON.stringify(buildEffectsManifest([A1], realHooks.map(n => JSON.parse(fs.readFileSync(path.join(BUNDLED_HOOKS, n), 'utf8').replace(/^﻿/, ''))))) === JSON.stringify(idx), 'buildEffectsManifest == index.json');
  ok(execFileSync(process.execPath, [path.join(hrepo, 'tools', 'manifest.mjs'), '--check'], { encoding: 'utf8' }).includes(`ok (1 effects, ${realHooks.length} hook files)`), 'repo tools/manifest.mjs --check agrees on hooks');
  ok(JSON.stringify(buildEffectsManifest([A1])) === JSON.stringify(buildManifest([A1])) && !('hooks' in buildEffectsManifest([A1], [])), 'no hook files → no `hooks` key (pre-HR index.json unchanged)');
  ok(!hsync().includes('committed'), 'hooks sync is idempotent');
  for (const engine of ['isomorphic', 'git']) {
    const S = await loadEffectSetFrom({ dir: hrepo, commit: 'main', engine });
    ok(S.commit === h1 && Object.keys(S.hooks).sort().join() === Object.keys(want).join() && S.hookRefs.trap?.sha256 === want.trap && S.hookRefs.trap.branch === 'main' && S.errors.length === 0, `${engine}: loadEffectSetFrom = effects + hooks at one commit`);
  }
  // a stale hook file is removed; a changed one is a new sha; an invalid one stops the sync before anything is written
  const trap = JSON.parse(fs.readFileSync(path.join(hHooks, 'trap.json'), 'utf8').replace(/^﻿/, ''));
  const trap2 = { ...trap, version: '9.9.9' };
  fs.writeFileSync(path.join(hHooks, 'trap.json'), JSON.stringify(trap2));
  fs.unlinkSync(path.join(hHooks, 'holdings.json'));
  hsync('-m', 'h2');
  const h2 = sh(hrepo, 'rev-parse', 'HEAD');
  ok(!fs.existsSync(path.join(hrepo, 'hooks', 'holdings.json')) && JSON.parse(fs.readFileSync(path.join(hrepo, 'index.json'), 'utf8')).hooks.trap === effectHooksHash(trap2), 'stale hook removed, changed hook re-hashed');
  fs.writeFileSync(path.join(hHooks, 'bogus.json'), JSON.stringify({ schema: 'chaosd6.effect-hooks/1', id: 'bogus', version: '1.0.0', hooks: { not_a_hook: true } }));
  let threw = false; try { hsync('--no-commit'); } catch { threw = true; }
  ok(threw && !fs.existsSync(path.join(hrepo, 'hooks', 'bogus.json')) && sh(hrepo, 'status', '--porcelain') === '', 'invalid hook file → sync fails, repo untouched');
  fs.unlinkSync(path.join(hHooks, 'bogus.json'));
  // refs / cache / fetchers — same contract as the effects
  const rT1 = effectHooksRef(trap, { commit: h1 });
  const hcache = createEffectCache({ dir: path.join(tmp, 'hcache') });
  const gotT = await getEffectHooksByRef(rT1, { cache: hcache, fetch: gitEffectHooksFetcher({ dir: hrepo }) });
  ok(effectHooksHash(gotT) === want.trap && hcache.has(want.trap), 'getEffectHooksByRef: old commit fetched from git, verified, cached');
  ok(await throwsCode(() => getEffectHooksByRef(rT1, { cache: createEffectCache({ dir: path.join(tmp, 'hc2') }), fetch: async () => trap2 }), 'sha-mismatch'), 'tampered hook file → sha-mismatch');
  let hUrl = '';
  const hh = httpdEffectHooksFetcher({ seedHost: 'seed.example', rid: 'rad:zDefault', fetchImpl: async (u) => { hUrl = u; return { ok: true, status: 200, json: async () => ({ content: JSON.stringify(trap) }) }; } });
  await getEffectHooksByRef({ ...rT1, repo: '' }, { cache: createEffectCache({ dir: path.join(tmp, 'hc3') }), fetch: hh });
  ok(hUrl === `https://seed.example/api/v1/repos/rad:zDefault/blob/${h1}/hooks/trap.json`, 'httpd URL = …/blob/<commit>/hooks/<family>.json', hUrl);
  ok(await throwsCode(() => parseEffectHooksRef({ ...rT1, id: '../x' }), 'bad-id'), 'hook ref id is path safe');
  // effectHookFiles: repo commit → its files; a pre-HR commit (no hooks/) → the bundled fallback
  const fromRepo = await effectHookFiles({ dir: hrepo, commit: h2 });
  ok(fromRepo.source === 'repo' && fromRepo.commit === h2 && fromRepo.files.length === realHooks.length - 1 && fromRepo.files.find(f => f.id === 'trap')?.version === '9.9.9', 'effectHookFiles(repo@commit) → that commit\'s hook files');
  const fromOld = await effectHookFiles({ dir: repo, commit: c1 });
  ok(fromOld.source === 'bundled' && fromOld.files.length === realHooks.length, 'commit without hooks/ → bundled fallback');
  const fromNone = await effectHookFiles();
  ok(fromNone.source === 'bundled' && fromNone.files.map(f => f.id).sort().join() === Object.keys(want).join(), 'no repo → bundled game/effects-data/hooks');
  const { loadHookFiles } = await import(pathToFileURL(path.join(HERE, '..', 'effect-hooks.mjs')).href);
  const fromHead = await effectHookFiles({ dir: hrepo, commit: h1 });
  ok(loadHookFiles(fromHead.files).size === loadHookFiles(BUNDLED_HOOKS).size, 'repo hook files load in effect-hooks.mjs#loadHookFiles (same hooks as the bundle)');
  // --hooks-src none: hooks dropped, index.json back to the pre-HR shape
  hsync('--hooks-src', 'none', '-m', 'h3');
  ok(!fs.existsSync(path.join(hrepo, 'hooks')) || !fs.readdirSync(path.join(hrepo, 'hooks')).some(n => n.endsWith('.json')), '--hooks-src none removes hooks/');
  ok(!('hooks' in JSON.parse(fs.readFileSync(path.join(hrepo, 'index.json'), 'utf8'))), '--hooks-src none → index.json without hooks');
}

console.log('libs (LR: effect libraries in the repo)');
{
  const GAMEFX = path.join(HERE, '..', 'effects-data');
  const lsrc = path.join(tmp, 'lsrc'); const lEff = path.join(lsrc, 'effects'); const lLib = path.join(lsrc, 'lib');
  fs.mkdirSync(lEff, { recursive: true }); fs.mkdirSync(lLib, { recursive: true });
  const effNames = fs.readdirSync(path.join(GAMEFX, 'effects')).filter(n => n.endsWith('.json')).sort();
  const libNames = fs.readdirSync(path.join(GAMEFX, 'lib')).filter(n => n.endsWith('.json')).sort();
  for (const n of effNames) fs.copyFileSync(path.join(GAMEFX, 'effects', n), path.join(lEff, n));
  const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
  const realLibs = libNames.map(n => rd(path.join(GAMEFX, 'lib', n)));
  const wantL = Object.fromEntries(realLibs.map(l => [l.id, effectLibHash(l)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const lrepo = path.join(tmp, 'lrepo');
  const lsync = (...a) => execFileSync(process.execPath, [path.join(HERE, 'effects-repo-sync.mjs'), '--repo', lrepo, '--src', lEff, '--hooks-src', 'none', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // l0: a pre-LR commit (no lib/ in the source yet) — index.json byte-identical to the pre-LR format
  lsync('-m', 'l0');
  const l0 = sh(lrepo, 'rev-parse', 'HEAD');
  const idx0 = fs.readFileSync(path.join(lrepo, 'index.json'), 'utf8');
  ok(!fs.existsSync(path.join(lrepo, 'lib')) && idx0 === JSON.stringify(buildManifest(effNames.map(n => rd(path.join(lEff, n)))), null, 2) + '\n', 'no lib/ source → no lib/, index.json = the pre-LR bytes');
  ok(!('libs' in JSON.parse(fs.readFileSync(path.join(repo, 'index.json'), 'utf8'))) && !('libs' in buildEffectsManifest([A1], [], [])), 'no libs → no `libs` key (older indexes unchanged)');
  for (const l of realLibs) fs.writeFileSync(path.join(lLib, `${l.id}.json`), JSON.stringify(l, null, 2));
  const out1 = lsync('-m', 'l1');
  const l1 = sh(lrepo, 'rev-parse', 'HEAD');
  ok(out1.includes(`${realLibs.length} lib(s)`) && libNames.every(n => fs.existsSync(path.join(lrepo, 'lib', n))), 'sync mirrors <src>/../lib/*.json → lib/', out1);
  const idx1 = JSON.parse(fs.readFileSync(path.join(lrepo, 'index.json'), 'utf8'));
  ok(JSON.stringify(idx1.libs) === JSON.stringify(wantL) && Object.keys(idx1.effects).length === effNames.length && !('hooks' in idx1), 'index.json lists libs {id: sha256} beside effects');
  ok(JSON.stringify(buildEffectsManifest(effNames.map(n => rd(path.join(lEff, n))), null, realLibs)) === JSON.stringify(idx1), 'buildEffectsManifest(defs, null, libs) == index.json');
  ok(execFileSync(process.execPath, [path.join(lrepo, 'tools', 'manifest.mjs'), '--check'], { encoding: 'utf8' }).includes(`ok (${effNames.length} effects, ${realLibs.length} libs)`), 'repo tools/manifest.mjs --check agrees on libs');
  ok(!lsync().includes('committed'), 'libs sync is idempotent');
  // the libs are the ones the validator pin and the handshake set id already hash
  const { computePin } = await import(pathToFileURL(path.join(HERE, 'rebalancing-check.mjs')).href);
  const pinEng = computePin().engines || {};
  ok(Object.entries(wantL).every(([id, s]) => pinEng[`game/effects-data/lib/${id}.json`] === s), 'index.json libs == validator pin engine hashes of game/effects-data/lib');
  const { bundledEffectSet, makeFxRef, parseFxRef, fxKey } = await import(pathToFileURL(path.join(HERE, '..', 'effects-handshake.mjs')).href);
  ok(JSON.stringify(bundledEffectSet().set.libs) === JSON.stringify(wantL), 'index.json libs == handshake bundled set libs (set id input)');
  for (const engine of ['isomorphic', 'git']) {
    const S = await loadEffectSetFrom({ dir: lrepo, commit: 'main', engine });
    ok(S.commit === l1 && JSON.stringify(Object.fromEntries(Object.entries(S.libRefs).map(([k, r]) => [k, r.sha256]))) === JSON.stringify(wantL) && S.libRefs.std.commit === l1 && S.errors.length === 0, `${engine}: loadEffectSetFrom = effects + libs at one commit`);
  }
  // runnable effects bound to the commit's libs; refs pin the libs exactly like makeFxRef
  const R1 = await loadRunnableEffectsFrom({ dir: lrepo, commit: l1 });
  ok(R1.libSource === 'repo' && R1.effects.size === effNames.length && R1.errors.length === 0, 'loadRunnableEffectsFrom(repo@l1): every effect binds to the repo libs', JSON.stringify(R1.errors).slice(0, 200));
  const sample = [...R1.effects.keys()].filter(id => (R1.effects.get(id).uses || []).length).slice(0, 8);
  ok(sample.length > 0 && sample.every(id => { const r = R1.refs[id]; const m = makeFxRef(R1.effects.get(id), realLibs, { commit: r.commit }); return JSON.stringify(m.libs) === JSON.stringify(r.libs) && fxKey(parseFxRef(r)) === fxKey(m); }), 'repo refs carry libs == makeFxRef pins (same fxKey)');
  const R0 = await loadRunnableEffectsFrom({ dir: lrepo, commit: l0 });
  ok(R0.libSource === 'bundled' && R0.effects.size === effNames.length && R0.refs[sample[0]].libs.std === wantL.std, 'pre-LR commit → bundled libs fallback');
  const F0 = await effectLibFiles({ dir: lrepo, commit: l0 }), FN = await effectLibFiles();
  ok(F0.source === 'bundled' && FN.source === 'bundled' && FN.files.length === realLibs.length, 'effectLibFiles: commit without lib/ and no repo → bundled');
  // a new std at l2: effects of l2 resolve `uses` against it, l1 keeps the old one
  const std = realLibs.find(l => l.id === 'std');
  const std2 = { ...std, version: '9.9.9', subs: { ...std.subs, lr_probe: { params: [], body: 1 } } };
  fs.writeFileSync(path.join(lLib, 'std.json'), JSON.stringify(std2, null, 2));
  lsync('-m', 'l2');
  const l2 = sh(lrepo, 'rev-parse', 'HEAD');
  const R2 = await loadRunnableEffectsFrom({ dir: lrepo, commit: l2 });
  const useStd = [...R2.effects.keys()].find(id => (R2.effects.get(id).uses || []).includes('std'));
  ok(useStd && R2.effects.get(useStd).$subs.has('lr_probe') && !R1.effects.get(useStd).$subs.has('lr_probe'), 'effects resolve `uses` against THEIR commit\'s libs');
  ok(R2.refs[useStd].libs.std === effectLibHash(std2) && R1.refs[useStd].libs.std === wantL.std && R2.refs[useStd].sha256 === R1.refs[useStd].sha256, 'same effect bytes, new std → new lib pin (another fxKey)');
  // lib refs: git at the old commit, httpd URL, tamper
  const rStd1 = effectLibRef(std, { commit: l1 });
  const lcache = createEffectCache({ dir: path.join(tmp, 'lc') });
  const gotStd = await getEffectLibByRef(rStd1, { cache: lcache, fetch: gitEffectLibFetcher({ dir: lrepo }) });
  ok(effectLibHash(gotStd) === wantL.std && lcache.has(wantL.std), 'getEffectLibByRef: old commit\'s std fetched from git, verified, cached');
  ok(await throwsCode(() => getEffectLibByRef(rStd1, { cache: createEffectCache({ dir: path.join(tmp, 'lc2') }), fetch: async () => std2 }), 'sha-mismatch'), 'tampered lib → sha-mismatch');
  let lUrl = '';
  const hl = httpdEffectLibFetcher({ seedHost: 'seed.example', rid: 'rad:zDefault', fetchImpl: async (u) => { lUrl = u; return { ok: true, status: 200, json: async () => ({ content: JSON.stringify(std) }) }; } });
  await getEffectLibByRef({ ...rStd1, repo: '' }, { cache: createEffectCache({ dir: path.join(tmp, 'lc3') }), fetch: hl });
  ok(lUrl === `https://seed.example/api/v1/repos/rad:zDefault/blob/${l1}/lib/std.json`, 'httpd URL = …/blob/<commit>/lib/<id>.json', lUrl);
  ok(await throwsCode(() => parseEffectLibRef({ ...rStd1, id: '../x' }), 'bad-id'), 'lib ref id is path safe');
  // validation before writing: an invalid lib, or an effect using an unsynced lib, stops the sync
  fs.writeFileSync(path.join(lLib, 'bogus.json'), JSON.stringify({ schema: 'chaosd6.effect-lib/1', id: 'bogus', subs: { s: { params: 'x', body: { no_such_op: [] } } } }));
  let threw = false; try { lsync('--no-commit'); } catch { threw = true; }
  ok(threw && !fs.existsSync(path.join(lrepo, 'lib', 'bogus.json')) && sh(lrepo, 'status', '--porcelain') === '', 'invalid lib (validateLib) → sync fails, repo untouched');
  fs.unlinkSync(path.join(lLib, 'bogus.json'));
  fs.renameSync(path.join(lLib, 'e2a.json'), path.join(tmp, 'e2a.json'));
  threw = false; try { lsync('--no-commit'); } catch { threw = true; }
  ok(threw && fs.existsSync(path.join(lrepo, 'lib', 'e2a.json')) && sh(lrepo, 'status', '--porcelain') === '', 'effect using an unsynced lib → sync fails, repo untouched');
  fs.renameSync(path.join(tmp, 'e2a.json'), path.join(lLib, 'e2a.json'));
  // a broken lib committed by hand → reported; effects fall back to the bundled libs
  fs.writeFileSync(path.join(lrepo, 'lib', 'std.json'), JSON.stringify({ id: 'std', subs: {} }));
  sh(lrepo, 'add', '-A'); sh(lrepo, 'commit', '-qm', 'broken std');
  const FB = await effectLibFiles({ dir: lrepo, commit: 'HEAD' });
  ok(FB.source === 'bundled' && FB.errors.some(e => e.file === 'lib/std.json'), 'invalid repo lib → error + bundled fallback');
  // --libs-src none: libs dropped, index.json back to the pre-LR shape
  lsync('--libs-src', 'none', '-m', 'l3');
  ok(!fs.readdirSync(path.join(lrepo, 'lib')).some(n => n.endsWith('.json')) && fs.readFileSync(path.join(lrepo, 'index.json'), 'utf8') === idx0, '--libs-src none removes lib/, index.json = pre-LR bytes');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\neffects-repo-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
