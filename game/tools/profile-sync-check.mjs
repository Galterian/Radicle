// End-to-end check of profile-sync.mjs ↔ infra/oci/profiles-push.mjs against
// a throwaway local repo (no Radicle: MIRROR_REMOTE=none; a bare repo with
// refs/namespaces/<nid>/… stands in for Radicle storage, and a stub of the
// in-app node's loopback bridge writes into it). Run inside WSL:
//   node tools/profile-sync-check.mjs        → "all profile checks passed"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openProfileStore, loadIdentity } from '../profile-sync.mjs';
import { generateIdentity, profileRef, signPush, AUTH_HEADER, verifyPush, teamRef, idFromPrivateKeyPem } from '../profile-auth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-check-'));
const repo = path.join(tmp, 'server');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL_ = `http://127.0.0.1:${PORT}/profiles-push`;
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };
const sh = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Server repo: a normal repo with a default branch, like a `rad clone`.
fs.mkdirSync(repo);
sh(['init', '-q', '-b', 'main']);
fs.writeFileSync(path.join(repo, 'README.md'), 'chaosD6-Profiles\n');
sh(['add', '.']); sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
sh(['config', 'receive.denyNonFastForwards', 'true']);
sh(['config', 'receive.denyDeletes', 'true']);
const storage = path.join(tmp, 'storage.git');
sh(['init', '-q', '--bare', storage], tmp);

const srv = spawn(process.execPath, [path.join(here, '../../infra/oci/profiles-push.mjs')], {
  env: { ...process.env, PROFILES_REPO: repo, PORT: String(PORT), MIRROR_REMOTE: 'none', PROFILES_STORAGE: storage, PROMOTE_EVERY_MS: '300' }, stdio: ['ignore', 'pipe', 'inherit'],
});
const srvLog = [];
srv.stdout.on('data', (d) => srvLog.push(d.toString()));
await new Promise((r) => setTimeout(r, 600));

try {
  // 1. fresh player: nothing on the server
  const dirA = path.join(tmp, 'phoneA');
  const a = await openProfileStore({ dir: dirA, readUrl: URL_, pushUrl: URL_ });
  ok(/^z6Mk/.test(a.id) && a.ref === profileRef(a.id), `identity ${a.id}`);
  ok((await a.pull()) === null, 'pull of a new player → null');

  // 2. first save creates the orphan branch
  const d1 = await a.save({ name: 'Ash', level: 1 });
  ok(d1.pushed, `first save pushed ${d1.oid?.slice(0, 8)}`);
  ok(sh(['rev-parse', a.ref]) === d1.oid, 'server branch = pushed commit');
  ok(sh(['rev-list', '--count', a.ref]) === '1', 'orphan branch (no main history)');

  // 3. second device, same key, fresh dir: depth-1 pull sees the save
  const dirB = path.join(tmp, 'phoneB');
  fs.mkdirSync(dirB); fs.copyFileSync(path.join(dirA, 'identity.pem'), path.join(dirB, 'identity.pem'));
  const b = await openProfileStore({ dir: dirB, readUrl: URL_, pushUrl: URL_ });
  ok(JSON.stringify(await b.pull()) === JSON.stringify({ name: 'Ash', level: 1 }), 'second device pulls the profile');

  // 4. fast-forward saves from both devices
  const d2 = await b.save({ name: 'Ash', level: 2 });
  const s3 = await a.save({ name: 'Ash', level: 3 });
  ok(d2.pushed && s3.pushed, 'B then A save (each re-fetches the tip first)');
  ok(sh(['rev-list', '--count', a.ref]) === '3', 'history is linear, 3 commits');
  ok((await b.pull()).level === 3, 'B sees level 3');
  ok(fs.existsSync(path.join(dirB, 'repo.git', 'shallow')), 'client repo is shallow');

  // 5. a real `git clone --depth 1 --single-branch` works on the branch
  const cl = path.join(tmp, 'cli');
  execFileSync('git', ['clone', '-q', '--depth', '1', '--single-branch', '--branch', `profiles/${a.id}`, URL_, cl]);
  ok(JSON.parse(fs.readFileSync(path.join(cl, 'profile.json'), 'utf8')).level === 3, 'git CLI shallow single-branch clone');
  ok(sh(['branch', '-a'], cl).split('\n').length === 2, 'CLI clone only has that branch');

  // 6. offline save → pending.json → flushed by next pull
  const off = await openProfileStore({ dir: dirA, readUrl: URL_, pushUrl: 'http://127.0.0.1:1/profiles-push' });
  const s4 = await off.save({ name: 'Ash', level: 4 });
  ok(!s4.pushed && fs.existsSync(path.join(dirA, 'pending.json')), 'unreachable push → kept in pending.json');
  ok((await off.local()).level === 4, 'local() returns the pending save');
  ok((await a.pull()).level === 4 && !fs.existsSync(path.join(dirA, 'pending.json')), 'next pull flushes the pending save');

  // Raw pushes for the attack cases, built with isomorphic-git directly.
  const { default: git } = await import('isomorphic-git');
  const { default: http } = await import('isomorphic-git/http/node');
  const gitdir = path.join(dirA, 'repo.git');
  const tip = sh(['rev-parse', a.ref]);
  async function craft(files, parent) {
    const tree = await git.writeTree({ fs, gitdir, tree: await Promise.all(Object.entries(files).map(async ([p, c]) => ({ mode: '100644', path: p, type: 'blob', oid: await git.writeBlob({ fs, gitdir, blob: Buffer.from(c) }) }))) });
    const who = { name: 'x', email: 'x@x', timestamp: 1, timezoneOffset: 0 };
    return git.writeCommit({ fs, gitdir, commit: { tree, parent: parent ? [parent] : [], author: who, committer: who, message: 'x\n' } });
  }
  async function rawPush({ localOid, remoteRef, header, force = false }) {
    await git.writeRef({ fs, gitdir, ref: 'refs/heads/_probe', value: localOid, force: true });
    try {
      const r = await git.push({ fs, http, gitdir, url: URL_, ref: 'refs/heads/_probe', remoteRef, force, headers: header ? { [AUTH_HEADER]: header } : {} });
      return r.ok && r.refs?.[remoteRef]?.ok ? 'accepted' : `rejected:${r.refs?.[remoteRef]?.error}`;
    } catch (e) { return `error:${e.data?.statusMessage || e.data?.reason || e.message}`; }
  }
  const idA = loadIdentity(dirA);
  const mallory = generateIdentity();
  const good = await craft({ 'profile.json': '{"level":5}' }, tip);

  ok((await rawPush({ localOid: good, remoteRef: a.ref })).includes('missing X-Profile-Auth'), 'unsigned push refused');
  ok((await rawPush({ localOid: good, remoteRef: a.ref, header: signPush(mallory.privateKeyPem, { ref: a.ref, oldOid: tip, newOid: good }) })).includes('may only push'), "someone else's key refused");
  ok((await rawPush({ localOid: good, remoteRef: a.ref, header: signPush(idA.privateKeyPem, { ref: a.ref, oldOid: tip, newOid: tip }) })).includes('does not match'), 'signature for another commit refused');
  ok((await rawPush({ localOid: good, remoteRef: 'refs/heads/main', force: true, header: signPush(idA.privateKeyPem, { ref: 'refs/heads/main', oldOid: sh(['rev-parse', 'main']), newOid: good }) })).includes('refusing'), 'push to main refused');
  const stale = signPush(idA.privateKeyPem, { ref: a.ref, oldOid: tip, newOid: good, ts: Date.now() - 3600e3 });
  ok((await rawPush({ localOid: good, remoteRef: a.ref, header: stale })).includes('expired'), 'old signature refused');
  const extra = await craft({ 'profile.json': '{}', 'evil.bin': 'x' }, tip);
  ok((await rawPush({ localOid: extra, remoteRef: a.ref, header: signPush(idA.privateKeyPem, { ref: a.ref, oldOid: tip, newOid: extra }) })).includes('only profile.json'), 'extra files refused (and rolled back)');
  ok(sh(['rev-parse', a.ref]) === tip, 'branch unchanged after refusals');
  const notJson = await craft({ 'profile.json': 'nope' }, tip);
  ok((await rawPush({ localOid: notJson, remoteRef: a.ref, header: signPush(idA.privateKeyPem, { ref: a.ref, oldOid: tip, newOid: notJson }) })).includes('not valid JSON'), 'non-JSON profile refused');
  const rewrite = await craft({ 'profile.json': '{"level":99}' }, null);
  const rw = await rawPush({ localOid: rewrite, remoteRef: a.ref, force: true, header: signPush(idA.privateKeyPem, { ref: a.ref, oldOid: tip, newOid: rewrite }) });
  ok(rw !== 'accepted' && sh(['rev-parse', a.ref]) === tip, `non-fast-forward (history rewrite) refused: ${rw.replace(/\s+/g, ' ').slice(0, 70)}`);
  ok((await rawPush({ localOid: good, remoteRef: a.ref, header: signPush(idA.privateKeyPem, { ref: a.ref, oldOid: tip, newOid: good }) })) === 'accepted', 'correctly signed fast-forward accepted');

  let threw = false;
  try { verifyPush(signPush(idA.privateKeyPem, { ref: a.ref, oldOid: tip, newOid: good }).replace(/.$/, 'A'), { ref: a.ref, oldOid: tip, newOid: good }); } catch { threw = true; }
  ok(threw, 'tampered header refused');

  // 7. team branches (teams/<Team>, first claim wins, devices approved by id) via profile-radicle.mjs
  const { startProfileSync, mergeProfiles } = await import('../profile-radicle.mjs');
  const { updateProfile, loadProfile, deleteCharacter } = await import('../profile.mjs');
  const T = teamRef('Gold team');
  ok(T === 'refs/heads/teams/Gold-team', `team ref ${T}`);
  const mk = (name, team, chars) => { const f = path.join(tmp, name, 'profile.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ version: 1, team_name: team, team_order: [], characters: chars })); return f; };
  const ch = (id, extra = {}) => ({ id, name: id, cards: [], actions: {}, rev: 1, updated_at: '2026-11-13T00:00:00.000Z', ...extra });
  const opts = { readUrl: URL_, pushUrl: URL_, namespace: '', intervalMs: 1e9, watchMs: 200, log: (m) => srvLog.push(`[sync] ${m}\n`) };
  const f1 = mk('desk', 'Gold team', [ch('pc_a')]);
  const f2 = mk('phone', 'Gold team', [ch('pc_b')]);
  const sy1 = startProfileSync({ ...opts, file: f1, label: 'desk' });
  let t1 = await sy1.syncNow();
  ok(t1.state === 'synced', `desktop claims the team: ${t1.message}`);
  const teamJson = () => JSON.parse(sh(['show', `${T}:profile.json`]));
  ok(teamJson().owners.map(o => o.id).join() === sy1.id && teamJson().characters[0].id === 'pc_a', 'branch holds the profile, owner = desktop key');
  const sy2 = startProfileSync({ ...opts, file: f2, label: 'phone' });
  let t2 = await sy2.syncNow();
  ok(t2.state === 'awaiting-approval', `phone with the same team name waits for approval: ${t2.message.slice(0, 60)}`);
  ok(JSON.parse(sh(['show', `${profileRef(sy2.id)}:profile.json`])).join_team === 'Gold-team', 'phone pushed its join request on profiles/<id>');
  ok(loadProfile(f2).characters.map(c => c.id).join() === 'pc_b', 'not approved: nothing pulled into the phone profile');
  t1 = await sy1.syncNow({ requests: true });
  ok(t1.requests.some(r => r.id === sy2.id && r.label === 'phone'), `desktop lists the phone request ${JSON.stringify(t1.requests)}`);
  t1 = await sy1.approve(sy2.id);
  ok(t1.state === 'synced' && teamJson().owners.length === 2, 'approve adds the phone to owners');
  t2 = await sy2.syncNow();
  ok(t2.state === 'synced' && loadProfile(f2).characters.map(c => c.id).sort().join() === 'pc_a,pc_b', 'approved phone merges both characters');
  ok(teamJson().characters.length === 2, 'branch now holds both characters');
  // a game on the phone writes a death → the file watcher pushes it, the desktop pulls it
  updateProfile(p => { p.characters.find(c => c.id === 'pc_a').deaths = 1; }, f2);
  await new Promise(r => setTimeout(r, 3500));
  await sy2.syncNow();
  ok(teamJson().characters.find(c => c.id === 'pc_a').deaths === 1, 'phone profile write pushed (watcher)');
  await sy1.syncNow();
  ok(loadProfile(f1).characters.find(c => c.id === 'pc_a').deaths === 1 && loadProfile(f1).characters.find(c => c.id === 'pc_a').rev === 2, 'desktop pulls the death (rev 2)');
  updateProfile(p => deleteCharacter(p, 'pc_b'), f1);
  await sy1.syncNow(); await sy2.syncNow();
  ok(!loadProfile(f2).characters.some(c => c.id === 'pc_b'), 'deleted character drops on the other device');
  const cl2 = path.join(tmp, 'cli-team');
  execFileSync('git', ['clone', '-q', '--depth', '1', '--single-branch', '--branch', 'teams/Gold-team', URL_, cl2]);
  ok(sh(['rev-list', '--count', 'HEAD'], cl2) === '1' && fs.existsSync(path.join(cl2, 'profile.json')), 'team branch: git clone --single-branch --depth 1');

  // raw pushes against the team branch
  const ttip = sh(['rev-parse', T]);
  const mal = await craft({ 'profile.json': JSON.stringify({ owners: [{ id: idFromPrivateKeyPem(mallory.privateKeyPem) }] }) }, null);
  const malR = await rawPush({ localOid: mal, remoteRef: T, force: true, header: signPush(mallory.privateKeyPem, { ref: T, oldOid: '0'.repeat(40), newOid: mal }) });
  ok(malR.includes('team name taken'), 'second claim of a team name → "team name taken"');
  const mal2 = await craft({ 'profile.json': '{"owners":["x"]}' }, ttip);
  ok((await rawPush({ localOid: mal2, remoteRef: T, header: signPush(mallory.privateKeyPem, { ref: T, oldOid: ttip, newOid: mal2 }) })).includes('not an owner'), 'non-owner fast-forward refused');
  const empty = await craft({ 'profile.json': '{"owners":[]}' }, ttip);
  ok((await rawPush({ localOid: empty, remoteRef: T, header: signPush(idA.privateKeyPem, { ref: T, oldOid: ttip, newOid: empty }) })).includes('not an owner'), 'device A (no owner) refused');
  const k1 = loadIdentity(path.join(path.dirname(f1), 'radicle'));
  ok((await rawPush({ localOid: empty, remoteRef: T, header: signPush(k1.privateKeyPem, { ref: T, oldOid: ttip, newOid: empty }) })).includes('at least one owner') && sh(['rev-parse', T]) === ttip, 'owner emptying owners refused and rolled back');
  const T2 = teamRef('Silver');
  const noSelf = await craft({ 'profile.json': '{"owners":["z6MkSomeoneElse"]}' }, null);
  ok((await rawPush({ localOid: noSelf, remoteRef: T2, header: signPush(k1.privateKeyPem, { ref: T2, oldOid: '0'.repeat(40), newOid: noSelf }) })).includes('own key'), 'claim without own key in owners refused');
  ok((await rawPush({ localOid: noSelf, remoteRef: 'refs/heads/teams/../main', header: signPush(k1.privateKeyPem, { ref: 'refs/heads/teams/../main', oldOid: '0'.repeat(40), newOid: noSelf }) })).includes('refusing'), 'odd team ref refused');
  const m = mergeProfiles({ characters: [ch('x', { rev: 3, name: 'L' })], team_order: ['x'] }, { characters: [ch('x', { rev: 4, name: 'R' }), ch('y')], team_order: ['y', 'x'], deleted: {} });
  ok(m.characters.find(c => c.id === 'x').name === 'R' && m.team_order.join() === 'x,y', 'merge: higher rev wins, order kept, new ids appended');

  // 8. P2P write path: device saves land in their own namespace of Radicle storage, the promoter moves the
  //    canonical branch (fast-forward + owners rules, same as HTTPS pushes).
  const work = path.join(tmp, 'p2p-work');
  execFileSync('git', ['clone', '-q', '--bare', repo, work]);
  const commitIn = (cwd, content, parent, env = {}) => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: content, encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['mktree'], { cwd, input: `100644 blob ${blob}\tprofile.json\n`, encoding: 'utf8' }).trim();
    return execFileSync('git', ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'profile'], {
      cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@p', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@p', ...env },
    }).trim();
  };
  const announce = (nid, ref, oid, cwd = work) => sh(['push', '-q', '-f', storage, `${oid}:refs/namespaces/${nid}/${ref}`], cwd);
  const settle = () => new Promise(r => setTimeout(r, 1200));
  const desk = sy1.id, mal3 = idFromPrivateKeyPem(mallory.privateKeyPem);
  sh(['fetch', '-q', 'origin', `+${T}:${T}`], work);
  let tTip = sh(['rev-parse', T]);
  const withOwners = (extra) => JSON.stringify({ ...teamJson(), ...extra }, null, 2) + '\n';
  const p1 = commitIn(work, withOwners({ note: 'p2p' }), tTip);
  announce(desk, T, p1);
  await settle();
  ok(sh(['rev-parse', T]) === p1, 'owner commit in its own radicle namespace → promoted to the team branch');
  const pm = commitIn(work, withOwners({ note: 'mallory' }), p1);
  announce(mal3, T, pm);
  const pnf = commitIn(work, withOwners({ note: 'rewrite' }), tTip);
  announce(desk, T, pnf);
  const pother = commitIn(work, '{"x":1}\n', null);
  announce(mal3, profileRef(desk), pother);
  await settle();
  ok(sh(['rev-parse', T]) === p1, 'non-owner namespace and non-fast-forward are not promoted');
  ok(!sh(['for-each-ref', 'refs/heads/profiles/']).includes(pother) && srvLog.join('').includes("another key's profile branch"), "a key's namespace cannot write another key's profiles/<id>");
  ok(srvLog.join('').includes('refused: not an owner') && srvLog.join('').includes('refused: not a fast-forward'), 'refusals logged');
  const T3 = teamRef('Bronze');
  const claim = commitIn(work, JSON.stringify({ owners: [{ id: mal3 }] }) + '\n', null);
  announce(mal3, T3, claim);
  await settle();
  ok(sh(['rev-parse', T3]) === claim, 'unclaimed team: claim listing its own key promoted');

  // ...driven by profile-sync.mjs through a stub of the node's bridge (recreates the commit with git CLI,
  //    like the Rust side does with git2: the oid must be isomorphic-git's).
  const http2 = await import('node:http');
  let bridgeMode = 'ok', bridgeHits = 0;
  const bsrv = http2.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      bridgeHits++;
      const b = JSON.parse(Buffer.concat(chunks).toString());
      const reply = (j) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.headers['x-bridge-token'] !== 'tok') return reply({ ok: false, error: 'bad token' });
      if (bridgeMode === 'fail') return reply({ ok: false, error: 'node down' });
      sh(['fetch', '-q', 'origin', `+${b.ref}:${b.ref}`], work);
      const date = `${b.timestamp} +0000`;
      const oid = commitIn(work, b.content, b.parent, { GIT_AUTHOR_NAME: b.name, GIT_AUTHOR_EMAIL: b.email, GIT_COMMITTER_NAME: b.name, GIT_COMMITTER_EMAIL: b.email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      if (oid !== b.expect) return reply({ ok: false, error: `commit ${oid} differs from ${b.expect}` });
      if (bridgeMode !== 'silent') announce(b.email.split('@')[0], b.ref, oid);
      reply({ ok: true, oid });
    });
  });
  await new Promise(r => bsrv.listen(0, '127.0.0.1', r));
  const bridgeFile = path.join(tmp, 'bridge.json');
  fs.writeFileSync(bridgeFile, JSON.stringify({ port: bsrv.address().port, token: 'tok' }));
  process.env.PROFILES_BRIDGE_WAIT_MS = '4000';
  const deskDir = path.join(path.dirname(f1), 'radicle');
  const ps = await openProfileStore({ dir: deskDir, readUrl: URL_, pushUrl: URL_, namespace: '', ref: T, bridgeFile, rid: 'rad:zTest', seedNid: 'z6MkSeed' });
  const before = srvLog.join('').split('promoted from radicle').length;
  let cur = await ps.fetch();
  const o1 = await ps.commit({ ...cur.profile, note: 'via bridge' }, cur.oid);
  ok(sh(['rev-parse', T]) === o1 && srvLog.join('').split('promoted from radicle').length === before + 1, 'save via bridge: same oid rebuilt, promoted, no HTTPS push needed');
  bridgeMode = 'fail';
  cur = await ps.fetch();
  const o2 = await ps.commit({ ...cur.profile, note: 'https fallback' }, cur.oid);
  ok(sh(['rev-parse', T]) === o2, 'bridge error → HTTPS push of the same commit');
  bridgeMode = 'silent';
  cur = await ps.fetch();
  const o3 = await ps.commit({ ...cur.profile, note: 'not promoted' }, cur.oid);
  ok(sh(['rev-parse', T]) === o3 && bridgeHits === 3, 'promotion not seen in time → HTTPS fallback');
  bsrv.close();
  await sy1.stop(); await sy2.stop();
} catch (e) {
  failed++; console.error('FAIL exception', e);
} finally {
  srv.kill();
  if (failed) console.log(srvLog.join(''));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} profile check(s) FAILED` : 'all profile checks passed');
process.exit(failed ? 1 : 0);
