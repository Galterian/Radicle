// End-to-end check of profile-sync.mjs ↔ infra/oci/profiles-push.mjs against
// a throwaway local repo (no Radicle: MIRROR_REMOTE=none). Run inside WSL:
//   node tools/profile-sync-check.mjs        → "all profile checks passed"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openProfileStore, loadIdentity } from '../profile-sync.mjs';
import { generateIdentity, profileRef, signPush, AUTH_HEADER, verifyPush } from '../profile-auth.mjs';

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
  const s1 = await a.save({ name: 'Ash', level: 1 });
  ok(s1.pushed, `first save pushed ${s1.oid?.slice(0, 8)}`);
  ok(sh(['rev-parse', a.ref]) === s1.oid, 'server branch = pushed commit');
  ok(sh(['rev-list', '--count', a.ref]) === '1', 'orphan branch (no main history)');

  // 3. second device, same key, fresh dir: depth-1 pull sees the save
  const dirB = path.join(tmp, 'phoneB');
  fs.mkdirSync(dirB); fs.copyFileSync(path.join(dirA, 'identity.pem'), path.join(dirB, 'identity.pem'));
  const b = await openProfileStore({ dir: dirB, readUrl: URL_, pushUrl: URL_ });
  ok(JSON.stringify(await b.pull()) === JSON.stringify({ name: 'Ash', level: 1 }), 'second device pulls the profile');

  // 4. fast-forward saves from both devices
  const s2 = await b.save({ name: 'Ash', level: 2 });
  const s3 = await a.save({ name: 'Ash', level: 3 });
  ok(s2.pushed && s3.pushed, 'B then A save (each re-fetches the tip first)');
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
} catch (e) {
  failed++; console.error('FAIL exception', e);
} finally {
  srv.kill();
  if (failed) console.log(srvLog.join(''));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} profile check(s) FAILED` : 'all profile checks passed');
process.exit(failed ? 1 : 0);
