#!/usr/bin/env node
// Checks for the node's rules editor server (game/editor-api.mjs) + the definition publisher (game/editor-publish.mjs).
// Everything is local and temporary: the handler runs on an ephemeral 127.0.0.1 port (never ui-server.mjs / 7357),
// with a temp profile dir (a fresh identity, profile.json with team_name + owners), a temp copy of data/ (proposal
// writes land there, under a temp lock file), and temp bare repos standing in for the Radicle remotes (a fake `main`
// with the def-repo layout; radSync: false — nothing reaches rad or the OCI seed).
//   node tools/editor-api-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const REPO = path.resolve(GAME, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosd6-editor-check-'));
const PROFILE_DIR = path.join(T, 'profile');
process.env.CHAOSD6_PROFILE_DIR = PROFILE_DIR;   // before any game import (profileDir default)
process.env.CHAOSD6_MOBILE = '';
const profileFile = path.join(PROFILE_DIR, 'profile.json');

const { handleEditorRequest } = await import('../editor-api.mjs');
const { verifyDefinitionSignature, trailersOf, defSha, ridOfKind, publishDefinition } = await import('../editor-publish.mjs');
const { generateIdentity, idFromPrivateKeyPem } = await import('../profile-auth.mjs');
const { canonicalJson } = await import('../defs-repo.mjs');

let ok = 0;
const fails = [];
const check = (cond, what) => { if (cond) ok++; else { fails.push(what); console.log(`  ✗ ${what}`); } };
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (args, o = {}) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...(o.env || {}) }, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

// ------------------------------------------------------------------ fixtures
const me = generateIdentity();
fs.mkdirSync(path.join(PROFILE_DIR, 'radicle'), { recursive: true });
fs.writeFileSync(path.join(PROFILE_DIR, 'radicle', 'identity.pem'), me.privateKeyPem, { mode: 0o600 });
const other = generateIdentity();
const writeProfile = (p) => fs.writeFileSync(profileFile, JSON.stringify({ version: 1, team_order: [], characters: [], ...p }, null, 2));
writeProfile({ team_name: '' });

const dataDir = path.join(T, 'data');
fs.cpSync(path.join(REPO, 'data'), dataDir, { recursive: true });

// fake def repos: main = the repo layout (one built-in definition, lib/, index.json manifest)
const SUB = { skill: 'skills', effect: 'effects', class: 'classes' };
const DEFDIR = { skill: 'skills-data/skills', effect: 'effects-data/effects', class: 'classes-data/classes' };
const LIBDIR = { skill: 'skills-data/lib', effect: 'effects-data/lib', class: 'classes-data/lib' };
const SAMPLE = { skill: 'skill_dodge', effect: 'effect_fireball', class: 'class_enchanter' };
const remotes = {};
for (const kind of Object.keys(SUB)) {
  const w = path.join(T, `work-${kind}`);
  fs.mkdirSync(path.join(w, SUB[kind]), { recursive: true });
  fs.mkdirSync(path.join(w, 'lib'), { recursive: true });
  const def = JSON.parse(fs.readFileSync(path.join(GAME, DEFDIR[kind], `${SAMPLE[kind]}.json`), 'utf8'));
  fs.copyFileSync(path.join(GAME, DEFDIR[kind], `${SAMPLE[kind]}.json`), path.join(w, SUB[kind], `${SAMPLE[kind]}.json`));
  const libs = {};
  for (const f of fs.readdirSync(path.join(GAME, LIBDIR[kind])).filter(f => f.endsWith('.json'))) {
    fs.copyFileSync(path.join(GAME, LIBDIR[kind], f), path.join(w, 'lib', f));
    libs[f.slice(0, -5)] = defSha(JSON.parse(fs.readFileSync(path.join(GAME, LIBDIR[kind], f), 'utf8')));
  }
  fs.writeFileSync(path.join(w, 'README.md'), `fake ${kind} repo\n`);
  fs.writeFileSync(path.join(w, 'index.json'), JSON.stringify({ format: 1, hash: 'sha256(canonical-json)', [SUB[kind]]: { [def.id]: defSha(def) }, lib: libs }, null, 2) + '\n');
  git(['init', '-q', '-b', 'main', w]);
  git(['add', '-A'], { cwd: w });
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'main'], { cwd: w });
  remotes[ridOfKind(kind)] = path.join(T, `remote-${kind}.git`);
  git(['clone', '-q', '--bare', w, remotes[ridOfKind(kind)]]);
}
let broken = false;
const publishHooks = { profileFile, remoteUrlFor: (rid) => (broken ? path.join(T, 'no-such-remote.git') : remotes[rid]), radSync: false, env: GIT_ENV, via: 'git' };

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  const handled = await handleEditorRequest(req, res, new URL(req.url, 'http://x'),
    { repoRoot: REPO, dataDir, gameDir: GAME, profileFile, port: server.address().port, publish: publishHooks, lockFile: path.join(T, 'data.lock') });
  if (!handled) { res.writeHead(418); res.end('not mine'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const HOST = `127.0.0.1:${port}`;
function rq(method, p, { headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? null : JSON.stringify(body));
    const h = { host: HOST, ...(data != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, setHost: false }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json });
      });
    });
    r.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve({ status: 'reset' }) : reject(e)));
    if (data != null) r.end(data); else r.end();
  });
}
let token = null;
const post = (p, body, headers = {}) => rq('POST', `/rules/api/editor/${p}`, { body, headers: { 'x-editor-token': token, ...headers } });
const get = (p) => rq('GET', `/rules/api/editor/${p}`);

try {
  // ---------------------------------------------------------------- static routes
  console.log('static routes');
  let r = await rq('GET', '/rules');
  check(r.status === 302 && r.headers.location === '/rules/', '/rules → 302 /rules/');
  const shell = fs.readFileSync(path.join(REPO, 'editor.html'));
  for (const p of ['/rules/', '/rules/rules.html', '/rules/editor.html']) {
    r = await rq('GET', p);
    check(r.status === 200 && /^text\/html/.test(r.headers['content-type']) && r.buf.equals(shell), `${p} = editor.html (text/html)`);
  }
  if (fs.existsSync(path.join(REPO, 'editor', 'app.js'))) {
    r = await rq('GET', '/rules/editor/app.js');
    check(r.status === 200 && /^text\/javascript/.test(r.headers['content-type']), 'editor/app.js text/javascript');
  }
  if (fs.existsSync(path.join(REPO, 'editor', 'editor.css'))) {
    r = await rq('GET', '/rules/editor/editor.css');
    check(r.status === 200 && /^text\/css/.test(r.headers['content-type']), 'editor/editor.css text/css');
  }
  r = await rq('GET', '/rules/data/index.json');
  check(r.status === 200 && r.json?.collections?.length > 5 && r.headers['cache-control'] === 'no-cache', 'data/index.json (no-cache)');
  r = await rq('GET', '/rules/data/effects.json');
  check(r.status === 200 && r.json?.entries?.length > 30 && r.json.entries[0].versions[0].status === 'canonical', 'data/effects.json built from the definitions');
  r = await rq('GET', '/rules/data/characters.json');
  check(r.status === 200 && r.buf.equals(fs.readFileSync(path.join(dataDir, 'characters.json'))), 'data/characters.json byte for byte (CRLF)');
  r = await rq('GET', '/rules/defs/index.json');
  check(r.status === 200 && r.json?.skill?.includes('skill_dodge') && r.json?.effect?.includes('effect_fireball') && r.json?.class?.includes('class_warrior'), 'defs/index.json lists the built-ins');
  r = await rq('GET', '/rules/defs/skill/skill_dodge.json');
  check(r.status === 200 && r.json?.id === 'skill_dodge', 'defs/skill/skill_dodge.json');
  r = await rq('GET', '/rules/defs/skill/effect_fireball.json');
  check(r.status === 404, 'defs/<kind>/<id> refuses an id of another kind');
  for (const p of ['/rules/editor/../../game/package.json', '/rules/editor/%2e%2e/%2e%2e/game/package.json', '/rules/editor/..%2f..%2fgame%2fpackage.json',
    '/rules/data/..%2fgame%2fpackage.json', '/rules/data/../game/package.json', '/rules/defs/skill/..%2f..%2fpackage.json', '/rules/editor/%00x.js',
    '/rules/editor/.hidden.js', '/rules/editor/..\\..\\package.json', '/rules/../game/package.json']) {
    r = await rq('GET', p);
    check(r.status === 404 || r.status === 418 && !r.text.includes('"name"'), `traversal refused: ${p} (${r.status})`);
  }
  r = await rq('GET', '/index.html');
  check(r.status === 418, 'non-/rules path falls through (handler → false)');
  r = await rq('GET', '/rules/api/other');
  check(r.status === 404, '/rules/api/<not editor> → 404');

  // ---------------------------------------------------------------- session
  console.log('session');
  r = await rq('GET', '/rules/api/editor/session', { headers: { host: `evil.example:${port}` } });
  check(r.status === 403 && r.json?.ok === false, 'wrong Host → 403 (DNS rebinding)');
  r = await rq('GET', '/rules/api/editor/session', { headers: { host: `127.0.0.1:${port + 1}` } });
  check(r.status === 403, 'wrong port in Host → 403');
  r = await rq('GET', '/rules/api/editor/session', { headers: { host: `localhost:${port}` } });
  check(r.status === 200 && r.json?.mode === 'node', 'Host localhost:<port> accepted');
  check(!r.headers['access-control-allow-origin'], 'no CORS header');
  check(r.headers['cache-control'] === 'no-store', 'API Cache-Control no-store');
  r = await get('session');
  token = r.json?.token;
  check(/^[0-9a-f]{64}$/.test(token || ''), 'session hands out the 32-byte token');
  check(r.json?.identity?.id === idFromPrivateKeyPem(me.privateKeyPem), 'session identity = the profile key');
  check(r.json?.team === null && r.json?.logged_in === false && r.json?.reason === 'no team' && r.json?.can_author === false, 'no team → read-only, reason "no team"');
  check(r.json?.publish?.mode === 'desktop' && typeof r.json?.publish?.ready === 'boolean', 'session publish readiness (desktop)');
  writeProfile({ team_name: 'Gold Team', owners: [{ id: other.id, label: 'other' }] });
  r = await post('login', {});
  check(r.status === 200 && r.json?.team?.slug === 'Gold-Team' && r.json?.team?.owner === false && r.json?.reason === 'not an owner' && !r.json.logged_in, 'non-owner → reason "not an owner"');
  r = await post('definitions', { kind: 'skill', def: {} });
  check(r.status === 403, 'definitions refused when not logged in');
  r = await post('proposals', { collection: 'creatures', entry_id: 'x', data: {} });
  check(r.status === 403, 'proposals refused when not logged in');
  writeProfile({ team_name: 'Gold Team', owners: [{ id: other.id, label: 'other' }, { id: me.id, label: 'desk' }] });
  r = await post('login', {});
  check(r.json?.logged_in === true && r.json?.team?.owner === true && r.json?.can_propose === true && !r.json.reason && r.json.identity.label === 'desk', 'owner → logged in');
  check(r.json?.token === token, 'token stable for the process');

  // ---------------------------------------------------------------- POST guards
  console.log('POST guards');
  const vbody = { kind: 'skill', def: {} };
  r = await rq('POST', '/rules/api/editor/validate', { body: vbody });
  check(r.status === 403, 'POST without X-Editor-Token → 403');
  r = await post('validate', vbody, { 'x-editor-token': 'f'.repeat(64) });
  check(r.status === 403, 'POST with a wrong token → 403');
  r = await post('validate', vbody, { origin: 'http://evil.example' });
  check(r.status === 403, 'POST with a foreign Origin → 403');
  r = await post('validate', vbody, { origin: `http://localhost:${port}` });
  check(r.status === 403, 'POST with Origin ≠ Host origin → 403');
  r = await post('validate', vbody, { origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' });
  check(r.status === 200, 'POST same Origin accepted');
  r = await post('validate', vbody, { 'sec-fetch-site': 'cross-site' });
  check(r.status === 403, 'POST Sec-Fetch-Site cross-site → 403');
  r = await post('validate', vbody, { host: `evil.example:${port}` });
  check(r.status === 403, 'POST with a wrong Host → 403');
  r = await rq('POST', '/rules/api/editor/validate', { raw: JSON.stringify(vbody), headers: { 'x-editor-token': token, 'content-type': 'text/plain' } });
  check(r.status === 415, 'POST text/plain → 415');
  r = await rq('POST', '/rules/api/editor/validate', { raw: 'x'.repeat(600 * 1024), headers: { 'x-editor-token': token, 'content-type': 'application/json' } });
  check(r.status === 413 || r.status === 'reset', `POST > 512 KB → 413 (${r.status})`);
  r = await rq('POST', '/rules/api/editor/validate', { raw: '{nope', headers: { 'x-editor-token': token, 'content-type': 'application/json' } });
  check(r.status === 400, 'POST bad JSON → 400');
  r = await rq('PUT', '/rules/api/editor/validate', { body: vbody, headers: { 'x-editor-token': token } });
  check(r.status === 405, 'PUT → 405');

  // ---------------------------------------------------------------- templates + validate
  console.log('templates + validate');
  const tpl = {};
  for (const kind of ['skill', 'effect', 'class']) {
    r = await get(`templates?kind=${kind}`);
    tpl[kind] = r.json?.def;
    check(r.status === 200 && tpl[kind]?.id === `${kind}_my_new_${kind}` && /\/1$/.test(tpl[kind]?.schema) && Array.isArray(r.json?.hints?.sections), `template ${kind} (schema /1, placeholder id)`);
    r = await post('validate', { kind, def: tpl[kind] });
    check(r.json?.ok === true && r.json.errors.length === 0 && ['ok', 'nerf', 'boost'].includes(r.json.verdict), `template ${kind} validates (${r.json?.verdict}${r.json?.errors?.length ? ': ' + r.json.errors.join('; ') : ''})`);
  }
  r = await get('templates?kind=spell');
  check(r.status === 400, 'templates?kind=spell → 400');
  r = await post('validate', { kind: 'skill', def: { ...tpl.skill, id: 'skill_dodge' } });
  check(r.json?.ok === false && r.json.errors.some(e => /built-in/.test(e)), 'validate rejects a built-in id');
  r = await post('validate', { kind: 'skill', def: { ...tpl.skill, schema: 'chaosd6.skill/2' } });
  check(r.json?.ok === false && r.json.errors.some(e => /schema/.test(e)), 'validate rejects a built-in schema (skill /2)');
  r = await post('validate', { kind: 'skill', def: { ...tpl.skill, schema: 'chaosd6.nope/9' } });
  check(r.json?.ok === false && r.json.errors.some(e => /schema/.test(e)), 'validate rejects a bad schema');
  r = await post('validate', { kind: 'skill', def: { ...tpl.skill, deal_order: 3 } });
  check(r.json?.ok === false && r.json.errors.some(e => /deal_order/.test(e)), 'validate rejects deal_order');
  r = await post('validate', { kind: 'effect', def: { ...tpl.effect, id: 'skill_wrong_prefix' } });
  check(r.json?.ok === false && r.json.errors.some(e => /\^effect_/.test(e)), 'validate rejects an id of another kind');
  r = await post('validate', { kind: 'class', def: { ...tpl.class, hooks: { emits: { engine: 'js', impl: 'x' } } } });
  check(r.json?.ok === false && r.json.errors.some(e => /built-in/.test(e)), 'validate rejects a JS marker on a foreign class');

  // ---------------------------------------------------------------- definitions → players/<team>/<slug>
  console.log('definitions publish');
  const sk = { ...tpl.skill, id: 'skill_ice_wall', name: 'Ice Wall' };
  r = await post('definitions', { kind: 'skill', def: sk, message: 'a wall of ice' });
  check(r.status === 200 && r.json?.ok === true && r.json.publish?.state === 'published', `skill published (${r.json?.publish?.error || r.json?.error || ''})`);
  const branch = 'players/Gold-Team/ice-wall';
  check(r.json?.ref?.branch === branch && r.json.ref.sha256 === defSha(sk) && r.json.ref.repo === ridOfKind('skill') && /^[0-9a-f]{40}$/.test(r.json.ref.commit || ''), 'ref { repo, branch, commit, sha256, id }');
  const bare = remotes[ridOfKind('skill')];
  const tip = git(['--git-dir', bare, 'rev-parse', `refs/heads/${branch}`]);
  check(tip === r.json?.ref?.commit, 'the remote branch tip = the reported commit');
  const mainOid = git(['--git-dir', bare, 'rev-parse', 'refs/heads/main']);
  check(git(['--git-dir', bare, 'rev-parse', `${tip}^`]) === mainOid, 'first commit: parent = main');
  const files = git(['--git-dir', bare, 'ls-tree', '-r', '--name-only', tip]).split('\n');
  check(files.includes('skills/skill_ice_wall.json') && files.includes('skills/skill_dodge.json') && files.includes('README.md') && files.some(f => f.startsWith('lib/')), 'branch = main tree + the definition');
  check(git(['--git-dir', bare, 'diff', '--name-only', mainOid, tip]).split('\n').sort().join(',') === 'index.json,skills/skill_ice_wall.json', 'branch differs from main by the def + index.json only');
  const stored = JSON.parse(git(['--git-dir', bare, 'show', `${tip}:skills/skill_ice_wall.json`]));
  check(canonicalJson(stored) === canonicalJson(sk), 'the committed file is the definition');
  const man = JSON.parse(git(['--git-dir', bare, 'show', `${tip}:index.json`]));
  check(man.skills?.skill_ice_wall === defSha(sk) && man.skills?.skill_dodge && man.lib && man.format === 1, 'index.json manifest gains the id → sha256');
  const msg = git(['--git-dir', bare, 'log', '-1', '--format=%B', tip]);
  const tr = trailersOf(msg);
  check(tr['Chaosd6-Author'] === me.id, 'trailer Chaosd6-Author = identity id');
  check(verifyDefinitionSignature(sk, tr['Chaosd6-Signature'], me.id), 'trailer Chaosd6-Signature verifies');
  check(!verifyDefinitionSignature({ ...sk, name: 'tampered' }, tr['Chaosd6-Signature'], me.id) && !verifyDefinitionSignature(sk, tr['Chaosd6-Signature'], other.id), 'signature fails on a tampered def / another key');
  check(git(['--git-dir', bare, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', tip]) === `Gold Team <${me.id}@chaosd6>|Gold Team <${me.id}@chaosd6>`, 'author = committer = <team> <id@chaosd6>');
  check(/a wall of ice/.test(msg), 'commit subject carries the message');
  check(!git(['--git-dir', bare, 'for-each-ref', '--format=%(refname)']).split('\n').some(x => x !== 'refs/heads/main' && !x.startsWith('refs/heads/players/')), 'nothing but players/* pushed (main untouched)');
  check(git(['--git-dir', bare, 'rev-parse', 'refs/heads/main']) === mainOid, 'main unchanged');
  r = await post('definitions', { kind: 'skill', def: { ...sk, version: '0.1.1' } });
  const tip2 = git(['--git-dir', bare, 'rev-parse', `refs/heads/${branch}`]);
  check(r.json?.publish?.state === 'published' && tip2 !== tip && git(['--git-dir', bare, 'rev-parse', `${tip2}^`]) === tip, 'second version fast-forwards the branch');
  r = await post('definitions', { kind: 'skill', def: { ...sk, version: '0.1.1' } });
  check(r.json?.ref?.commit === tip2, 'same definition again → same commit (no empty commit)');

  // phone path: the bridge request (radicle-node ffi definition_commit rebuilds commitGit's commit from it; the oid
  // identity itself is checked by the crate's definition_matches_desktop_git test)
  const phoneHooks = (features) => {
    const bridgeFile = path.join(T, `bridge-${features.join('-')}.json`);
    fs.writeFileSync(bridgeFile, JSON.stringify({ port: 9, token: 'tok', features }));
    const seen = [];
    return { seen, hooks: { profileFile: path.join(T, 'phone', 'profile.json'), via: 'bridge', bridgeFile,
      fetchImpl: async (url, o) => { seen.push({ url, headers: o.headers, body: JSON.parse(o.body) }); return { status: 200, json: async () => ({ ok: true, oid: 'f'.repeat(40) }) }; } } };
  };
  const pdef = { ...sk, version: '0.1.1' };
  const pid = { id: me.id, privateKeyPem: me.privateKeyPem }, pteam = { name: 'Gold Team', slug: 'Gold-Team' };
  const ph = phoneHooks(['save', 'publish', 'defs']);
  let pr = await publishDefinition({ kind: 'skill', def: pdef, identity: pid, team: pteam, message: '' }, ph.hooks);
  const breq = ph.seen[0];
  check(pr?.publish?.state === 'published' && pr.ref.commit === 'f'.repeat(40) && breq?.url === 'http://127.0.0.1:9/publish' && breq.headers['x-bridge-token'] === 'tok', 'phone: POST /publish to the bridge with its token → the node oid');
  check(breq?.body?.mode === 'definition' && breq.body.ref === `refs/heads/${branch}` && breq.body.base === 'refs/heads/main' && breq.body.rid === ridOfKind('skill')
    && Object.keys(breq.body.files).join() === 'skills/skill_ice_wall.json' && breq.body.files['skills/skill_ice_wall.json'] === git(['--git-dir', bare, 'cat-file', 'blob', `${tip2}:skills/skill_ice_wall.json`]) + '\n'
    && breq.body.manifest?.file === 'index.json' && breq.body.manifest.key === 'skills' && breq.body.manifest.id === 'skill_ice_wall' && breq.body.manifest.sha256 === defSha(pdef),
    'phone: request = { mode definition, ref, base main, files (the desktop bytes), manifest }');
  const dmsg = git(['--git-dir', bare, 'cat-file', 'commit', tip2]).split('\n\n').slice(1).join('\n\n');
  check(breq?.body?.message?.trimEnd() === dmsg && breq.body.name === 'Gold Team' && breq.body.email === `${me.id}@chaosd6`, 'phone: message / author byte-identical to the desktop commit');
  const old = phoneHooks(['save', 'publish']);
  pr = await publishDefinition({ kind: 'skill', def: pdef, identity: pid, team: pteam }, old.hooks);
  check(pr?.publish?.state === 'pending' && /defs/.test(pr.publish.error || '') && old.seen.length === 0, 'phone: a bridge without "defs" → pending, nothing sent');
  r = await post('definitions', { kind: 'skill', def: { ...sk, id: 'skill_dodge' } });
  check(r.status === 400 && r.json?.errors?.some(e => /built-in/.test(e)), 'definitions refuses an invalid def (400 + errors)');

  // pending → retry
  broken = true;
  const ef = { ...tpl.effect, id: 'effect_frost_lance', name: 'Frost Lance' };
  r = await post('definitions', { kind: 'effect', def: ef });
  check(r.status === 200 && r.json?.publish?.state === 'pending' && /main|fetch|read/.test(r.json.publish.error || ''), `unreachable repo → pending (${r.json?.publish?.error})`);
  r = await get('definitions/mine');
  const mine = r.json?.definitions || [];
  check(mine.length === 2 && mine.some(d => d.id === 'skill_ice_wall' && d.publish.state === 'published' && d.commit === tip2) && mine.some(d => d.id === 'effect_frost_lance' && d.publish.state === 'pending' && d.publish.tries === 1), 'definitions/mine lists both with their states');
  broken = false;
  r = await post('definitions/retry', { kind: 'effect', id: 'effect_frost_lance' });
  check(r.json?.ok === true && r.json.publish?.state === 'published' && r.json.ref.branch === 'players/Gold-Team/frost-lance', `retry publishes (${r.json?.publish?.error || r.json?.error || ''})`);
  const ebare = remotes[ridOfKind('effect')];
  check(git(['--git-dir', ebare, 'ls-tree', '-r', '--name-only', 'refs/heads/players/Gold-Team/frost-lance']).split('\n').includes('effects/effect_frost_lance.json'), 'effect on chaosD6-Effects players/Gold-Team/frost-lance');
  r = await post('definitions/retry', { kind: 'effect', id: 'effect_unknown' });
  check(r.status === 404 && r.json?.ok === false, 'retry of an unknown id → 404');
  const cl = { ...tpl.class, id: 'class_frost_warden', name: 'Frost Warden' };
  r = await post('definitions', { kind: 'class', def: cl });
  check(r.json?.publish?.state === 'published' && git(['--git-dir', remotes[ridOfKind('class')], 'cat-file', '-t', 'refs/heads/players/Gold-Team/frost-warden:classes/class_frost_warden.json']) === 'blob', 'class published on chaosD6-Classes');
  const st = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'editor-defs.json'), 'utf8'));
  check(Object.keys(st.defs).length === 3 && fs.existsSync(path.join(PROFILE_DIR, 'editor-defs-git')), 'status in <profile dir>/editor-defs.json, work repos in editor-defs-git/');

  // ---------------------------------------------------------------- proposals
  console.log('proposals');
  // split A (2026-11-25): creatures are the GameModels catalog's (refused below) - the data-proposal fixture is characters
  const cfile = path.join(dataDir, 'characters.json');
  const before = fs.readFileSync(cfile, 'utf8');
  const cj = JSON.parse(before);
  const entry = cj.entries[0];
  const { activeVersion } = await import('../logic-engine.mjs');
  const act = activeVersion(entry);
  r = await post('proposals', { collection: 'characters', entry_id: entry.id, data: act.data, notes: 'same stats, checking the pipeline' });
  check(r.status === 200 && r.json?.ok === true, `proposal on characters/${entry.id} (${r.json?.error || ''} ${(r.json?.errors || []).join('; ')})`);
  const [maj, min] = act.version.split('.').map(Number);
  check(r.json?.version === `${maj}.${min + 1}.0` && r.json.parent_version === act.version, `version bump ${act.version} → ${r.json?.version}`);
  const after = fs.readFileSync(cfile, 'utf8');
  check(before.includes('\r\n') && after.includes('\r\n') && !/[^\r]\n/.test(after), 'CRLF kept');
  const bl = before.split('\r\n'), al = after.split('\r\n');
  let j = 0; for (const l of al) if (j < bl.length && l === bl[j]) j++;
  check(j === bl.length && al.length > bl.length, `append-only diff (+${al.length - bl.length} lines, every old line kept in order)`);
  const nv = JSON.parse(after).entries[0].versions.at(-1);
  check(nv.status === 'proposal' && nv.weight === 0 && nv.origin === 'player_vote' && nv.parent_version === act.version && /Gold Team/.test(nv.notes) && nv.notes.includes(me.id) && nv.created_at, 'version fields: proposal, weight 0, player_vote, parent, notes with team + identity');
  check(/"weight": 0\.0/.test(after.split(`"version": "${r.json?.version}"`)[1] || ''), 'weight written as 0.0 (writeDataFile)');
  check(r.json?.verdict === 'accept' && Array.isArray(r.json.counters) && !r.json.counters.length && r.json.within_tolerance === true, `unchanged stats → rebalance verdict accept, no counters (${r.json?.verdict})`);
  r = await post('proposals', { collection: 'characters', entry_id: entry.id, data: act.data });
  check(r.json?.version === `${maj}.${min + 2}.0`, 'next proposal takes the next free version');
  // the shared tools/rebalance.mjs checkProposal: blocked → refused, needs_rework → appended (as `check --apply`)
  const { checkProposal } = await import('./rebalance.mjs');   // importing must not run the CLI
  const { LogicEngine } = await import('../logic-engine.mjs');
  const rhox = JSON.parse(fs.readFileSync(path.join(HERE, 'proposals', 'contradictions', 'mon_rhox_brute-1.1.0.json'), 'utf8'));
  let cthrew = null; try { checkProposal(JSON.parse(JSON.stringify(rhox)), { eng: new LogicEngine({ dataDir }) }); } catch (e) { cthrew = e.message; }
  check(/GameModels/.test(cthrew || ''), 'checkProposal throws for the catalog collection creatures (split A)');
  const blk = { collection: 'characters', entry_id: entry.id, version: { version: '9.0.0', origin: 'player_vote', parent_version: act.version, data: { ...act.data, stats: { ...act.data.stats, vitality: act.data.stats.vitality + 60 } } } };
  const cr = checkProposal(JSON.parse(JSON.stringify(blk)), { eng: new LogicEngine({ dataDir }) });
  check(cr.verdict === 'blocked' && cr.ok === false && cr.errors.some(e => /stat_sum_within_5_or_species_40/.test(e)) && Array.isArray(cr.counters) && cr.applied === null, 'checkProposal: contradiction fixture → blocked with errors (as rebalance.mjs check)');
  let threw = null; try { checkProposal({ collection: 'effects', entry_id: 'effect_fireball', version: { version: '9.0.0', data: {} } }, { eng: new LogicEngine({ dataDir }) }); } catch (e) { threw = e.message; }
  check(/effects-data|rebalancing-check/.test(threw || ''), 'checkProposal throws for a definitions collection (F9b)');
  const cbefore = fs.readFileSync(cfile, 'utf8');
  r = await post('proposals', { collection: 'creatures', entry_id: rhox.entry_id, data: rhox.version.data, notes: 'contradiction' });
  check(r.status === 400 && /GameModels/.test(r.json?.error || ''), `proposals refuse the catalog collection creatures (${r.json?.error})`);
  r = await post('proposals', { collection: blk.collection, entry_id: blk.entry_id, data: blk.version.data, notes: 'contradiction' });
  check(r.status === 400 && r.json?.verdict === 'blocked' && (r.json.errors || []).some(e => /stat_sum_within_5_or_species_40/.test(e)) && fs.readFileSync(cfile, 'utf8') === cbefore, 'blocked proposal → 400 with verdict + errors, nothing written');
  const clfile = path.join(dataDir, 'classes.json');
  const anim = JSON.parse(fs.readFileSync(clfile, 'utf8')).entries.find(e => e.id === 'class_animator');
  if (anim && (activeVersion(anim).rebalance_links || []).length) {
    const n0 = anim.versions.length;
    r = await post('proposals', { collection: 'classes', entry_id: 'class_animator', data: { ...activeVersion(anim).data, ability_power: 3 }, notes: 'strong animator' });
    const cs = r.json?.counters || [];
    check(r.status === 200 && r.json.verdict === 'needs_rework' && r.json.within_tolerance === false && cs.length >= 1
      && cs.every(c => c.entry_id && c.change && typeof c.score_before === 'number' && typeof c.score_after === 'number' && typeof c.within === 'boolean'),
    `outside tolerance → needs_rework + compact counters (${r.json?.verdict}, ${cs.map(c => `${c.entry_id}: ${c.change}`).join('; ') || r.json?.error})`);
    const cl = JSON.parse(fs.readFileSync(clfile, 'utf8'));
    check(cl.entries.find(e => e.id === 'class_animator').versions.length === n0 + 1
      && cs.every(c => cl.entries.find(e => e.id === c.entry_id).versions.every(v => v.origin !== 'rebalance_script')), 'needs_rework appended; counters returned only, not written');
  } else check(false, 'fixture class_animator with rebalance_links missing');
  for (const c of ['effects', 'skills']) {
    r = await post('proposals', { collection: c, entry_id: c === 'effects' ? 'effect_fireball' : 'skill_dodge', data: {} });
    check(r.status === 400 && /definitions|POST definitions/.test(r.json?.error || ''), `proposals refuse the definitions collection ${c}`);
  }
  r = await post('proposals', { collection: 'characters', entry_id: 'char_does_not_exist', data: {} });
  check(r.status === 404, 'proposal on an unknown entry → 404');
  r = await post('proposals', { collection: 'logic_rules', entry_id: 'x', data: {} });
  check(r.status === 400 || r.status === 404, 'proposal on logic_rules refused');
  check(fs.readFileSync(path.join(REPO, 'data', 'characters.json'), 'utf8') === before, 'the real data/characters.json untouched');
  check(!fs.readFileSync(path.join(REPO, 'data', 'classes.json'), 'utf8').includes('strong animator'), 'the real data/classes.json untouched');
} finally {
  server.close();
  fs.rmSync(T, { recursive: true, force: true });
}
if (fails.length) { console.log(`\n${fails.length} editor-api check(s) FAILED (${ok} ok)`); process.exit(1); }
console.log(`\nall editor-api checks passed (${ok} ok)`);
process.exit(0);
