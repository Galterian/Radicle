// End-to-end check of profile-sync.mjs ↔ infra/oci/profiles-push.mjs against
// a throwaway local repo (no Radicle: MIRROR_REMOTE=none). Run inside WSL:
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

const srv = spawn(process.execPath, [path.join(here, '../../infra/oci/profiles-push.mjs')], {
  env: { ...process.env, PROFILES_REPO: repo, PORT: String(PORT), MIRROR_REMOTE: 'none' }, stdio: ['ignore', 'pipe', 'inherit'],
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
