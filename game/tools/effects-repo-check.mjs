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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\neffects-repo-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
