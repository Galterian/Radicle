// Oracles for game/proposal-votes.mjs (proposal votes on foreign defs, 2026-11-17).
// `node tools/proposal-votes-check.mjs` → "all proposal-votes checks passed". Needs `git` for the publish/collect part.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as V from '../proposal-votes.mjs';
import { generateIdentity, idFromRawPublicKey, rawPublicKeyFromId } from '../profile-auth.mjs';
import * as P from '../proposal-votes-publish.mjs';
import { effectRef, parseEffectRef, effectHash, loadEffectsFrom } from '../effects-repo.mjs';
import { makeFxRef, parseFxRef, compactRef, fxKey } from '../effects-handshake.mjs';

process.env.PV_PUBLISH = '0';                                         // no background publish from the WS tests
const RAD_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosd6-pv-rad-'));
process.env.RAD_HOME = RAD_TMP;                                         // localNodeNid() must not read the real node key
delete process.env.CHAOSD6_RADICLE_BRIDGE;
let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { fails++; console.log(`FAIL ${msg}`); } };
const throwsCode = (fn, code, msg) => { try { fn(); ok(false, `${msg}: did not throw`); } catch (e) { ok(e instanceof V.VoteError && e.code === code, `${msg}: ${e.code} ${e.message}`); } };

const SHA = 'a'.repeat(64), SHA2 = 'b'.repeat(64), COMMIT = 'c'.repeat(40);
const ref = { repo: 'chaosD6-Effects', branch: 'players/ana/fire-whip', id: 'effect_fire_whip', sha256: SHA, commit: COMMIT, name: 'Fire Whip', verdict: 'ok' };
const A = 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const base = (o = {}) => ({ ...ref, voter: A, value: 3, comment: '', at: '2026-11-17T10:00:00.000Z', ...o });

// ---- targets / keys
ok(V.voteKey(V.normalizeTarget(ref)) === `chaosD6-Effects|players/ana/fire-whip|effect_fire_whip|${SHA}`, 'key uses sha256');
ok(V.normalizeTarget({ ...ref, sha256: undefined }).key.endsWith(`|${COMMIT}`), 'key falls back to commit');
ok(V.normalizeTarget({ id: 'skill_dodge', branch: 'players/ana/quick-dodge', sha256: SHA }).repo === 'chaosD6-Skills', 'default repo per kind (skill)');
ok(V.normalizeTarget({ class_id: 'class_seer', branch: 'players/bo/seer', commit: COMMIT }).kind === 'class', 'class ref via class_id');
throwsCode(() => V.normalizeTarget({ ...ref, branch: 'main' }), 'ref', 'main branch is not foreign');
throwsCode(() => V.normalizeTarget({ ...ref, branch: 'players/ana' }), 'ref', 'players/<who> without slug');
throwsCode(() => V.normalizeTarget({ ...ref, sha256: 'xyz', commit: 'abc1234' }), 'ref', 'no full version');
throwsCode(() => V.normalizeTarget({ ...ref, id: '../etc' }), 'ref', 'id path traversal');
throwsCode(() => V.normalizeTarget({ ...ref, id: 'fire_whip', kind: undefined }), 'ref', 'kind unknown');

// ---- value / comment rules
for (let x = -6; x <= 6; x++) { try { V.validateVote(base({ value: x, comment: x < 0 ? 'too strong' : '' })); ok(true, ''); } catch (e) { ok(false, `value ${x}: ${e.message}`); } }
throwsCode(() => V.validateVote(base({ value: 7 })), 'value', '+7');
throwsCode(() => V.validateVote(base({ value: -7, comment: 'x' })), 'value', '-7');
throwsCode(() => V.validateVote(base({ value: 2.5 })), 'value', 'fraction');
throwsCode(() => V.validateVote(base({ value: '3' })), 'value', 'string value');
throwsCode(() => V.validateVote(base({ value: -1 })), 'comment', 'minus without comment');
throwsCode(() => V.validateVote(base({ value: -1, comment: '   \u0001 ' })), 'comment', 'minus with blank comment');
throwsCode(() => V.validateVote(base({ value: -2, comment: 'x'.repeat(V.COMMENT_MAX + 1) })), 'comment', 'comment too long');
ok(V.validateVote(base({ value: -2, comment: '  dmg x2  ' })).comment === 'dmg x2', 'comment trimmed');
ok(V.validateVote(base({ value: 4, comment: 'fun' })).comment === 'fun', 'positive may comment');
throwsCode(() => V.validateVote(base({ voter: 'bob' })), 'voter', 'bad voter');
throwsCode(() => V.validateVote(base({ at: 'yesterday' })), 'at', 'bad time');
throwsCode(() => V.validateVote(base({ key: 'other' })), 'key', 'wrong key');

// ---- upsert: one per voter per version
let vs = [];
vs = V.upsertVote(vs, base({ value: 2 }));
vs = V.upsertVote(vs, base({ value: 5, at: '2026-11-17T11:00:00.000Z' }));
ok(vs.length === 1 && vs[0].value === 5, 'later vote replaces earlier');
vs = V.upsertVote(vs, base({ value: 1, at: '2026-11-17T09:00:00.000Z' }));
ok(vs.length === 1 && vs[0].value === 5, 'older vote does not replace newer');
vs = V.upsertVote(vs, base({ sha256: SHA2, value: -3, comment: 'nerf shield' }));
ok(vs.length === 2, 'new def version = new vote');
const B = 'peer:12D3KooWabc';
vs = V.upsertVote(vs, base({ voter: B, value: -6, comment: 'breaks the game' }));
vs = V.upsertVote(vs, base({ voter: 'z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH', value: 0 }));
const key = V.normalizeTarget(ref).key;
const agg = V.aggregate(vs, key);
ok(agg.n === 3 && agg.min === -6 && agg.max === 5 && agg.mean === Math.round(((5 - 6 + 0) / 3) * 100) / 100, `aggregate ${JSON.stringify(agg)}`);
ok(agg.negatives.length === 1 && agg.negatives[0].comment === 'breaks the game' && agg.negatives[0].voter === B, 'negatives carry comments');
ok(V.aggregate([], key).n === 0 && V.aggregate([], key).mean === null, 'empty aggregate');
ok(Object.keys(V.aggregateAll(vs)).length === 2, 'aggregateAll per version');
const def = { id: 'effect_fire_whip', element_cost: ['elem_fire'] };
const withC = V.withVoteCollection(def, ref, vs);
ok(withC.proposal_votes.n === 3 && !('proposal_votes' in def), 'collection attached in memory only');

// ---- signatures
const id1 = generateIdentity(), id2 = generateIdentity();
const s1 = V.signVote(id1.privateKeyPem, base({ value: -4, comment: 'too cheap' }));
ok(s1.voter === id1.id && V.verifyVote(s1), 'signed vote verifies');
ok(!V.verifyVote({ ...s1, value: 4 }), 'tampered value fails');
ok(!V.verifyVote({ ...s1, voter: id2.id }), 'other voter fails');
ok(!V.verifyVote(base()), 'unsigned fails');
ok(V.parseVote(V.serializeVote(s1)).value === -4, 'serialize/parse round trip');
ok(!V.serializeVote(s1).includes('"sig"'), 'serialized bytes exclude sig');

// ---- local store + WS glue (temp profile dir)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosd6-pv-'));
const pf = path.join(dir, 'profile.json');
fs.writeFileSync(pf, '{"version":1,"characters":[]}');
const before = fs.readFileSync(pf, 'utf8');
let r = V.pvHandle({ kind: 'proposal_vote', ref, value: -2 }, { profileFile: pf, name: 'Moonblade', dimension: 'Ashfall', door: 'door-1', peerId: '12D3x' });
ok(!r.ok && /comment/.test(r.error) && r.key === key, 'WS: minus without comment refused');
r = V.pvHandle({ kind: 'proposal_vote', ref, value: -2, comment: 'damage too high for 2 elements' }, { profileFile: pf, name: 'Moonblade', dimension: 'Ashfall', door: 'door-1', peerId: '12D3x' });
ok(r.ok && r.mine[key]?.value === -2, `WS: saved ${JSON.stringify(r)}`);
r = V.pvHandle({ kind: 'proposal_vote', ref, value: 4 }, { profileFile: pf, peerId: '12D3x' });
ok(r.ok && r.mine[key]?.value === 4 && Object.keys(r.mine).length === 1, 'WS: re-vote replaces');
r = V.pvHandle({ kind: 'proposal_vote', ref: { ...ref, branch: 'main' }, value: 1 }, { profileFile: pf });
ok(!r.ok, 'WS: built-in refused');
const stored = V.loadVotes(V.votesFile(pf));
ok(stored.length === 1 && V.verifyVote(stored[0]) && stored[0].voter.startsWith('z6Mk'), 'stored vote signed by the profile key');
ok(fs.existsSync(path.join(dir, 'radicle', 'identity.pem')), 'identity in <profile dir>/radicle (shared with profile sync)');
ok(fs.readFileSync(pf, 'utf8') === before, 'profile.json untouched');
ok(V.pvHello({ profileFile: pf }).mine[key].value === 4, 'hello lists my votes');
fs.writeFileSync(V.votesFile(pf), '{"version":1,"votes":{"x":{"value":99}}}');
ok(V.loadVotes(V.votesFile(pf)).length === 0, 'damaged entries dropped');

// ---- git: publish votes/<voter>, collect
let haveGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { haveGit = false; }
if (haveGit) {
  const gd = path.join(dir, 'repo.git');
  execFileSync('git', ['init', '-q', '--bare', gd]);
  const v1 = V.signVote(id1.privateKeyPem, base({ value: -4, comment: 'too cheap' }));
  const v1b = V.signVote(id1.privateKeyPem, base({ sha256: SHA2, value: 6 }));
  const v2 = V.signVote(id2.privateKeyPem, base({ value: 2 }));
  const c1 = V.publishVotesCommit({ gitdir: gd, votes: [v1, v1b, v2, base()], repo: 'chaosD6-Effects', voter: id1.id });
  ok(/^[0-9a-f]{40}$/.test(c1 || ''), 'publish commit');
  ok(V.publishVotesCommit({ gitdir: gd, votes: [v1, v1b], repo: 'chaosD6-Effects', voter: id1.id }) === null, 'publish idempotent');
  V.publishVotesCommit({ gitdir: gd, votes: [v2], repo: 'chaosD6-Effects', voter: id2.id });
  // a forged file on id2's branch claiming id1 + a Radicle-style namespaced ref
  const forged = { ...v1, value: 6, comment: '' };
  const blob = execFileSync('git', ['--git-dir', gd, 'hash-object', '-w', '--stdin'], { input: JSON.stringify(forged), encoding: 'utf8' }).trim();
  const t1 = execFileSync('git', ['--git-dir', gd, 'mktree'], { input: `100644 blob ${blob}\t${V.votePath(forged).split('/')[2]}\n`, encoding: 'utf8' }).trim();
  const t2 = execFileSync('git', ['--git-dir', gd, 'mktree'], { input: `040000 tree ${t1}\t${forged.id}\n`, encoding: 'utf8' }).trim();
  const t3 = execFileSync('git', ['--git-dir', gd, 'mktree'], { input: `040000 tree ${t2}\tvotes\n`, encoding: 'utf8' }).trim();
  const fc = execFileSync('git', ['--git-dir', gd, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit-tree', t3, '-m', 'forged'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['--git-dir', gd, 'update-ref', `refs/namespaces/${id2.id}/refs/heads/votes/${id2.id}`, fc]);
  const col = V.collectVotesFromGit({ gitdir: gd });
  ok(col.votes.length === 3, `collect 3 genuine votes (got ${col.votes.length})`);
  ok(col.rejected.length === 1 && /voter/.test(col.rejected[0].why), `forged vote rejected ${JSON.stringify(col.rejected)}`);
  const a2 = V.aggregate(col.votes, key);
  ok(a2.n === 2 && a2.min === -4 && a2.max === 2 && a2.negatives[0].comment === 'too cheap', `collected aggregate ${JSON.stringify(a2)}`);
  const files = execFileSync('git', ['--git-dir', gd, 'ls-tree', '-r', '--name-only', `refs/heads/votes/${id1.id}`], { encoding: 'utf8' }).trim().split('\n');
  ok(files.length === 2 && files.every(f => /^votes\/effect_fire_whip\/players~ana~fire-whip@[0-9a-f]{64}\.json$/.test(f)), `tree layout ${files}`);
} else console.log('(git not found: publish/collect skipped)');

// ---- HUD module (js/proposal_vote_ui.js) agrees with the peer on keys + the comment rule
const UI = await import('../js/proposal_vote_ui.js');
const ES = await import('../js/effect_source.js');
for (const r0 of [ref, { ...ref, sha256: undefined }, { id: 'skill_dodge', kind: 'skill', branch: 'players/ana/quick-dodge', sha256: SHA2 }, { id: 'class_seer', kind: 'class', branch: 'players/bo/seer', commit: COMMIT }]) {
  const src = ES.normalizeSource(r0);
  ok(UI.pvKey(src) === V.normalizeTarget(src).key, `UI key = peer key for ${r0.id}`);
}
ok(UI.pvKey(ES.normalizeSource({ ...ref, branch: 'main' })) === null && UI.pvKey(null) === null, 'UI: built-in has no key');
ok(UI.commentNeeded(-1, ' ') && !UI.commentNeeded(-1, 'why') && !UI.commentNeeded(0, ''), 'UI comment rule');
ok(UI.VALUE_MIN === V.VALUE_MIN && UI.VALUE_MAX === V.VALUE_MAX && UI.COMMENT_MAX === V.COMMENT_MAX, 'UI limits mirror the peer');
ok(UI.pvSeen({ effect_id: 'effect_fire_whip', source: ref }) === true && UI.pvSeen(ref) === false && UI.pvSeen({ effect_id: 'effect_fireball' }) === false, 'UI pvSeen: once per version, built-ins ignored');


// ==== ruling 1: no vote from the author ===========================================================
const idA = generateIdentity(), idN = generateIdentity();          // idA = Ana's profile key, idN = Ana's node NID
const refNs = { ...ref, ns: idN.id };
ok(V.normalizeTarget(refNs).ns === idN.id && V.normalizeTarget({ ...ref, ns: 'bogus' }).ns === undefined, 'target keeps a valid ns only');
ok(V.normalizeTarget(refNs).key === key, 'ns is not part of the vote key');
ok(/published/.test(V.authorConflict(refNs, { voter: idA.id, nid: idN.id, handles: [] }) || ''), 'author: my node NID owns the namespace');
ok(!!V.authorConflict({ ...ref, ns: idA.id }, { voter: idA.id, handles: [] }), 'author: my profile key owns the namespace');
ok(!!V.authorConflict({ ...ref, branch: 'players/p-larkin/heavy-swing' }, { voter: A, handles: ['P-Larkin'] }), 'author: handle P-Larkin = branch <who> p-larkin');
ok(!!V.authorConflict({ ...ref, branch: 'players/moonguard/x' }, { voter: A, handles: ['Moon Guard', 'MoonGuard'] }), 'author: team name = branch <who>');
ok(!!V.authorConflict({ ...ref, branch: 'players/x1/y', author: 'Ána' }, { voter: A, handles: ['ana'] }), 'author: ref author vs handle (accents folded)');
ok(V.authorConflict(refNs, { voter: A, nid: idA.id, handles: ['Bo', 'Moonblade'] }) === null, 'not the author: other names, other namespace');
throwsCode(() => V.validateVote(base({ ns: idN.id, voter_nid: idN.id })), 'author', 'vote whose voter_nid is the ns');
throwsCode(() => V.validateVote(base({ voter_name: 'ANA' })), 'author', 'vote whose voter_name is the branch <who>');
{
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosd6-pv-a-')), pf1 = path.join(d1, 'profile.json');
  fs.writeFileSync(pf1, JSON.stringify({ version: 1, team_name: 'MoonGuard', characters: [{ name: 'Moonblade' }] }));
  let r1 = V.pvHandle({ kind: 'proposal_vote', ref, value: 5 }, { profileFile: pf1, name: 'Ana' });
  ok(!r1.ok && r1.code === 'author', `WS: author (name) refused ${r1.error}`);
  r1 = V.pvHandle({ kind: 'proposal_vote', ref: { ...ref, branch: 'players/moonguard/fire-whip' }, value: 5 }, { profileFile: pf1, name: 'Moonblade' });
  ok(!r1.ok && r1.code === 'author', 'WS: author (team in profile.json) refused');
  r1 = V.pvHandle({ kind: 'proposal_vote', ref: refNs, value: 5 }, { profileFile: pf1, name: 'Moonblade', nid: idN.id });
  ok(!r1.ok && r1.code === 'author', 'WS: author (node NID = ns) refused');
  r1 = V.pvHandle({ kind: 'proposal_vote', ref: refNs, value: 5 }, { profileFile: pf1, name: 'Moonblade', nid: idA.id });
  ok(r1.ok, 'WS: a non-author votes');
  ok(V.loadVotes(V.votesFile(pf1)).length === 1, 'only the non-author vote stored');
  // node NID from $RAD_HOME/keys/radicle.pub (OpenSSH ed25519)
  const raw = rawPublicKeyFromId(idN.id);
  const sshStr = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
  fs.mkdirSync(path.join(RAD_TMP, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(RAD_TMP, 'keys', 'radicle.pub'), `ssh-ed25519 ${Buffer.concat([sshStr(Buffer.from('ssh-ed25519')), sshStr(Buffer.from(raw))]).toString('base64')} radicle\n`);
  ok(V.localNodeNid({ radHome: RAD_TMP, fresh: true }) === idN.id && idFromRawPublicKey(raw) === idN.id, 'localNodeNid from radicle.pub');
  ok(V.localNodeNid({ radHome: path.join(RAD_TMP, 'none'), fresh: true }) === null, 'localNodeNid: no key → null');
  fs.rmSync(d1, { recursive: true, force: true });
}
// ref plumbing: ns travels (defs-repo ref/parseRef, handshake makeFxRef/parseFxRef/compactRef) without touching any hash
{
  const def0 = { id: 'effect_fire_whip', name: 'Fire Whip', element_cost: ['elem_fire'] };
  const r0 = effectRef(def0, { branch: 'players/ana/fire-whip', commit: COMMIT }), r1 = effectRef(def0, { branch: 'players/ana/fire-whip', commit: COMMIT, ns: idN.id });
  ok(r0.sha256 === r1.sha256 && r1.sha256 === effectHash(def0) && r1.ns === idN.id && !('ns' in r0), 'defs-repo ref: ns added, sha256 unchanged');
  ok(parseEffectRef({ ...r1 }).ns === idN.id && !('ns' in parseEffectRef({ ...r1, ns: 'nope' })), 'parseRef keeps a valid ns only');
  const f0 = makeFxRef(def0, {}, { branch: 'players/ana/fire-whip', commit: COMMIT }), f1 = makeFxRef(def0, {}, { branch: 'players/ana/fire-whip', commit: COMMIT, ns: idN.id });
  ok(f1.ns === idN.id && f1.sha256 === f0.sha256 && fxKey(f1) === fxKey(f0), 'makeFxRef: ns, same sha256 + fxKey');
  ok(compactRef(f1).ns === idN.id && parseFxRef(compactRef(f1)).ns === idN.id && !('ns' in compactRef(f0)), 'compactRef / parseFxRef carry ns over the wire');
  ok(UI.pvKey(ES.normalizeSource(compactRef(f1))) === UI.pvKey(ES.normalizeSource(compactRef(f0))) && ES.normalizeSource(compactRef(f1)).ns === idN.id, 'HUD source keeps ns, same key');
  let haveGit2 = true; try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { haveGit2 = false; }
  if (haveGit2) {
    const gd = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosd6-pv-ns-')) + '/s.git';
    execFileSync('git', ['init', '-q', '--bare', gd]);
    const b = execFileSync('git', ['--git-dir', gd, 'hash-object', '-w', '--stdin'], { input: JSON.stringify(def0), encoding: 'utf8' }).trim();
    const t1 = execFileSync('git', ['--git-dir', gd, 'mktree'], { input: `100644 blob ${b}\teffect_fire_whip.json\n`, encoding: 'utf8' }).trim();
    const t2 = execFileSync('git', ['--git-dir', gd, 'mktree'], { input: `040000 tree ${t1}\teffects\n`, encoding: 'utf8' }).trim();
    const c = execFileSync('git', ['--git-dir', gd, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit-tree', t2, '-m', 'def'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['--git-dir', gd, 'update-ref', `refs/namespaces/${idN.id}/refs/heads/players/ana/fire-whip`, c]);
    const L = await loadEffectsFrom({ gitdir: gd, commit: `refs/namespaces/${idN.id}/refs/heads/players/ana/fire-whip`, engine: 'git' });
    const lr = L.refs.effect_fire_whip;
    ok(lr && lr.ns === idN.id && lr.branch === 'players/ana/fire-whip' && lr.commit === c && lr.sha256 === effectHash(def0), `loadFrom: ns + branch from a Radicle storage ref ${JSON.stringify(lr)}`);
    // collector: the def branch lives in idN's namespace → votes from that namespace / by that NID are author votes
    const vAuthor = V.signVote(idA.privateKeyPem, base({ value: 6, voter_nid: idA.id }));          // signed by idA, pushed from namespace idN
    const vOther = V.signVote(id2.privateKeyPem, base({ value: -2, comment: 'too strong' }));
    V.publishVotesCommit({ gitdir: gd, votes: [vAuthor], voter: idA.id });
    V.publishVotesCommit({ gitdir: gd, votes: [vOther], voter: id2.id });
    for (const [vid, nsId] of [[idA.id, idN.id], [id2.id, id1.id]]) {
      const tip = execFileSync('git', ['--git-dir', gd, 'rev-parse', `refs/heads/votes/${vid}`], { encoding: 'utf8' }).trim();
      execFileSync('git', ['--git-dir', gd, 'update-ref', `refs/namespaces/${nsId}/refs/heads/votes/${vid}`, tip]);
      execFileSync('git', ['--git-dir', gd, 'update-ref', '-d', `refs/heads/votes/${vid}`]);
    }
    const col2 = V.collectVotesFromGit({ gitdir: gd });
    ok(col2.votes.length === 1 && col2.votes[0].voter === id2.id, `collector keeps the non-author vote (${col2.votes.length})`);
    ok(col2.rejected.length === 1 && /author vote/.test(col2.rejected[0].why), `collector drops the author's vote ${JSON.stringify(col2.rejected)}`);
    const col3 = V.collectVotesFromGit({ gitdir: gd, authors: { 'players/ana/fire-whip': [id1.id] } });
    ok(col3.votes.length === 0 && col3.rejected.length === 2, 'collector: authors map (handshake ns) drops the namespace id1 vote too');
    fs.rmSync(path.dirname(gd), { recursive: true, force: true });
  }
}
ok(UI.pvIsMine(ES.normalizeSource(refNs), { voter: A, nid: idN.id, handles: [] }) && UI.pvIsMine(ES.normalizeSource({ ...ref, branch: 'players/p-larkin/x' }), { voter: A, handles: ['P-Larkin'] })
  && !UI.pvIsMine(ES.normalizeSource(refNs), { voter: A, nid: idA.id, handles: ['Bo'] }), 'HUD pvIsMine mirrors authorConflict');
ok(UI.handleSlug('Ána Ström') === V.handleSlug('Ána Ström') && V.handleSlug('Ána Ström') === 'ana-strom', 'handleSlug HUD = peer');

// ==== ruling 2: the first-time popup queue (state only; the DOM part needs a browser) =================
{
  const r2 = { ...ref, branch: 'players/zed/fire-whip-2', sha256: 'd'.repeat(64) };
  const r3 = { ...ref, branch: 'players/zed/fire-whip-2', sha256: 'e'.repeat(64) };
  const mineCard = { ...ref, branch: 'players/moonblade/own', sha256: 'f'.repeat(64) };
  const k2 = UI.pvKey(ES.normalizeSource(r2)), k3 = UI.pvKey(ES.normalizeSource(r3)), kOwn = UI.pvKey(ES.normalizeSource(mineCard));
  UI.pvSeen(r2); UI.pvSeen(r3); UI.pvSeen(mineCard);
  UI.pvOnMessage({ kind: 'proposal_votes', mine: { [key]: { value: 4, at: '2026-11-17T10:00:00.000Z', pub: 'saved' } }, me: { voter: A, handles: ['Moonblade'] }, collections: {} });
  let q = UI.pvPopupCandidates();
  ok(!q.includes(key) && q[0] === k2 && q[1] === k3 && !q.includes(kOwn), `popup: queued in order, voted + own cards skipped ${q.length}`);
  UI.pvPopupDismiss(k2);
  q = UI.pvPopupCandidates();
  ok(!q.includes(k2) && q[0] === k3, '"Later" dismisses that card for the session');
  ok(UI.pvSeen(r2) === false && !UI.pvPopupCandidates().includes(k2), 'popup not shown again for the same version');
  UI.pvOnMessage({ kind: 'proposal_vote_saved', ok: true, key: k3, mine: { [key]: { value: 4, at: 'x' }, [k3]: { value: 1, at: 'y', pub: 'saved' } } });
  ok(UI.pvPopupCandidates().length === 0, 'a vote closes it for good');
  const r4 = { ...r3, sha256: '9'.repeat(64) };
  UI.pvSeen(r4);
  ok(UI.pvPopupCandidates()[0] === UI.pvKey(ES.normalizeSource(r4)), 'a NEW version of a voted card asks again (ruling 5)');
  UI.pvOnMessage({ kind: 'proposal_vote_saved', ok: false, key: UI.pvKey(ES.normalizeSource(r4)), code: 'author', error: 'own' });
  ok(UI.pvPopupCandidates().length === 0, 'peer says "author" → hidden');
}

// ==== ruling 3: automatic publish, OCI seed only, saved / published / pending ============================
{
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosd6-pv-pub-')), pf3 = path.join(d3, 'profile.json');
  fs.writeFileSync(pf3, '{"version":1,"characters":[]}');
  V.recordVote({ ref: { ...ref, branch: 'players/zed/fire-whip' }, value: 2, profileFile: pf3, name: 'Moonblade', now: new Date('2026-11-17T12:00:00Z') });
  V.recordVote({ ref: { id: 'skill_dodge', kind: 'skill', branch: 'players/zed/quick-dodge', sha256: SHA2 }, value: -1, comment: 'too swingy', profileFile: pf3, name: 'Moonblade', now: new Date('2026-11-17T12:01:00Z') });
  const st0 = V.myVotesForUI(V.loadVotes(V.votesFile(pf3)), V.loadPublishStatus(V.publishFile(pf3)));
  ok(Object.values(st0).every(x => x.pub === 'saved'), 'fresh votes: saved');
  ok(V.publishStateOf({ voter: 'peer:x', at: 'z' }, null) === 'saved', 'unsigned (no profile key) = saved, local only');
  ok(V.schedulePublish({ profileFile: pf3 }) === 'off' && !V.publishScheduler.pending, 'PV_PUBLISH=0 → no publish');
  if (haveGit) {
    const remotes = path.join(d3, 'remotes'); fs.mkdirSync(remotes);
    const urlFor = (rid) => { const g = path.join(remotes, `${rid.replace(/^rad:/, '')}.git`); if (!fs.existsSync(g)) execFileSync('git', ['init', '-q', '--bare', g]); return g; };
    let st = await P.publishAll({ profileFile: pf3, via: 'git', remoteUrlFor: () => path.join(d3, 'no-such-remote.git'), radSync: false, now: () => new Date('2026-11-17T12:05:00Z') });
    const rids = Object.keys(st.repos);
    ok(rids.length === 2 && rids.every(r => st.repos[r].state === 'pending' && /push/.test(st.repos[r].error)), `push failure → pending ${JSON.stringify(st.repos)}`);
    let ui = V.myVotesForUI(V.loadVotes(V.votesFile(pf3)), V.loadPublishStatus(V.publishFile(pf3)));
    ok(Object.values(ui).every(x => x.pub === 'pending' && x.pub_error) && V.loadVotes(V.votesFile(pf3)).length === 2, 'votes kept locally, HUD shows pending + why');
    st = await P.publishAll({ profileFile: pf3, via: 'git', remoteUrlFor: urlFor, radSync: false, now: () => new Date('2026-11-17T12:10:00Z') });
    ok(Object.values(st.repos).every(r => r.state === 'published' && r.tries === 0), 'retry succeeds → published');
    ui = V.myVotesForUI(V.loadVotes(V.votesFile(pf3)), V.loadPublishStatus(V.publishFile(pf3)));
    ok(Object.values(ui).every(x => x.pub === 'published'), 'HUD shows published');
    const me3 = V.voterIdentity(pf3, '', { create: false }).id;
    const fx = path.join(remotes, `${V.DEFAULT_RIDS.effect.replace(/^rad:/, '')}.git`);
    const files3 = execFileSync('git', ['--git-dir', fx, 'ls-tree', '-r', '--name-only', `refs/heads/votes/${me3}`], { encoding: 'utf8' }).trim().split('\n');
    ok(files3.length === 1 && files3[0].startsWith('votes/effect_fire_whip/players~zed~fire-whip@'), `pushed votes/<voter> to the effects repo only ${files3}`);
    V.recordVote({ ref: { ...ref, branch: 'players/zed/fire-whip' }, value: 5, profileFile: pf3, name: 'Moonblade', now: new Date('2026-11-17T12:20:00Z') });
    ui = V.myVotesForUI(V.loadVotes(V.votesFile(pf3)), V.loadPublishStatus(V.publishFile(pf3)));
    ok(Object.values(ui).filter(x => x.pub === 'saved').length === 1, 'a changed vote is "saved" again until the next publish');
  }
  // phone: bridge path
  let st = await P.publishAll({ profileFile: pf3, via: 'bridge', bridgeFile: path.join(d3, 'none.json') });
  ok(Object.values(st.repos).some(r => r.state === 'pending' && /bridge/.test(r.error)), 'phone without a running node → pending');
  const bf = path.join(d3, 'bridge.json');
  fs.writeFileSync(bf, JSON.stringify({ port: 1, token: 't', nid: idN.id, features: ['publish'] }));
  st = await P.publishAll({ profileFile: pf3, via: 'bridge', bridgeFile: bf });
  ok(Object.values(st.repos).some(r => r.state === 'pending' && /"votes" feature/.test(r.error)), 'phone bridge without "votes" → pending, says why');
  fs.writeFileSync(bf, JSON.stringify({ port: 1, token: 't', nid: idN.id, features: ['publish', 'votes'] }));
  const bodies = [];
  const fakeFetch = async (url, o) => { bodies.push({ url, body: JSON.parse(o.body), token: o.headers['x-bridge-token'] }); return { status: 200, json: async () => ({ ok: true, oid: 'a'.repeat(40) }) }; };
  st = await P.publishAll({ profileFile: pf3, via: 'bridge', bridgeFile: bf, fetchImpl: fakeFetch });
  ok(Object.values(st.repos).every(r => r.state === 'published') && Object.values(st.repos).some(r => r.via === 'bridge'), 'phone bridge publish → published');
  ok(bodies.length >= 1 && bodies.every(b => b.url === 'http://127.0.0.1:1/publish' && b.token === 't' && b.body.seed === V.OCI_SEED_NID && /^refs\/heads\/votes\/z6Mk/.test(b.body.ref)
    && b.body.mode === 'snapshot' && Object.keys(b.body.files).every(p => p.startsWith('votes/'))), 'bridge body: votes/<voter> snapshot, OCI seed only');
  const src = fs.readFileSync(new URL('../proposal-votes-publish.mjs', import.meta.url), 'utf8');
  const syncs = src.match(/run\('rad', \['sync'[^\n]*/g) || [];
  ok(syncs.length === 1 && syncs[0].includes("'--seed', OCI_SEED_NID") && syncs[0].includes("'--announce'"), 'the only rad sync announces to the OCI seed');
  ok(V.OCI_SEED_NID === 'z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT' || !!process.env.CHAOSD6_OCI_SEED_NID, 'OCI seed NID default');

  // ==== ruling 4: review flag only with n ≥ 10 and mean ≤ −3; validator verdict otherwise untouched ===============
  const many = (n, val) => Array.from({ length: n }, (_, i) => base({ voter: `peer:v${i}`, value: val, comment: 'weak' }));
  ok(!V.aggregate(many(9, -6), key).review, '9 votes at −6: no effect');
  ok(V.aggregate(many(10, -3), key).review, '10 votes at −3: review');
  ok(!V.aggregate([...many(9, -3), base({ voter: 'peer:v9', value: -2, comment: 'meh' })], key).review, '10 votes, mean −2.9: no review');
  ok(!V.aggregate(many(30, 6), key).review, 'positive collection: no review');
  const vq = V.verdictWithVotes({ verdict: 'nerf', reasons: ['+12 %'] }, V.aggregate(many(9, -6), key));
  ok(vq.verdict === 'nerf' && vq.reasons[0] === '+12 %' && vq.review === false && vq.votes.n === 9, 'validator verdict untouched below 10 votes');
  ok(V.verdictWithVotes('ok', V.aggregate(many(10, -4), key)).review === true && V.verdictWithVotes('ok', V.aggregate(many(10, -4), key)).verdict === 'ok', 'review added, verdict ok kept');
  V.saveCollections(many(12, -5), V.collectedFile(pf3));
  const wrapped = V.validatorWithVotes(() => ({ verdict: 'ok', reasons: [] }), { profileFile: pf3 });
  ok(wrapped({}, ref).review === true && wrapped({}, { ...ref, sha256: SHA2 }).review === false, 'validatorWithVotes: review for that version only');
  ok(V.collectionsForUI(pf3)[key]?.review === true && V.collectionOf(ref, pf3).n === 12, 'collections for the HUD');
  fs.writeFileSync(V.collectedFile(pf3), JSON.stringify({ version: 1, collections: { [key]: { n: 3, mean: -6, review: true } } }));
  ok(V.collectionOf(ref, pf3).review === false, 'a cached review flag is re-derived (n 3 → no review)');
  ok(UI.reviewFlag({ n: 10, mean: -3 }) && !UI.reviewFlag({ n: 9, mean: -6 }) && UI.REVIEW_MIN_VOTES === V.REVIEW_MIN_VOTES && UI.REVIEW_MEAN_MAX === V.REVIEW_MEAN_MAX, 'HUD review rule mirrors the peer');
  if (haveGit) {
    const sd = path.join(d3, 'storage.git'); execFileSync('git', ['init', '-q', '--bare', sd]);
    const vs3 = Array.from({ length: 10 }, () => V.signVote(generateIdentity().privateKeyPem, base({ value: -4, comment: 'broken' })));
    for (const v of vs3) V.publishVotesCommit({ gitdir: sd, votes: [v], voter: v.voter });
    const c = P.collectAll({ profileFile: pf3, rids: [V.DEFAULT_RIDS.effect], storageDirFor: () => sd });
    ok(c.votes.filter(v => v.key === key).length === 10 && V.collectionOf(ref, pf3).review === true, 'collectAll: 10 votes from storage → review');
  }
  fs.rmSync(d3, { recursive: true, force: true });
}

// ==== ruling 5: votes do not carry over to a new version ======================================================
{
  const vOld = Array.from({ length: 12 }, (_, i) => base({ voter: `peer:o${i}`, value: -6, comment: 'bad' }));
  const keyNew = V.normalizeTarget({ ...ref, sha256: SHA2 }).key;
  ok(keyNew !== key && V.aggregate(vOld, keyNew).n === 0 && !V.aggregate(vOld, keyNew).review, 'new version starts with an empty collection');
  ok(V.aggregate(vOld, key).review, '…while the old version keeps its review');
  const both = V.upsertVote(V.upsertVote([], base({ value: -2, comment: 'x' })), base({ sha256: SHA2, value: 3 }));
  ok(both.length === 2 && V.aggregate(both, keyNew).n === 1 && V.aggregate(both, keyNew).mean === 3, 'a voter votes again on the new version, old vote stays on the old key');
  ok(V.withVoteCollection({ id: 'effect_fire_whip' }, { ...ref, sha256: SHA2 }, vOld).proposal_votes.n === 0, 'withVoteCollection of the new version ignores old votes');
  ok(V.normalizeTarget({ ...ref, sha256: undefined, commit: 'd'.repeat(40) }).key !== V.normalizeTarget({ ...ref, sha256: undefined }).key, 'commit-only refs: new commit = new key');
}

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(RAD_TMP, { recursive: true, force: true });
console.log(fails ? `${fails} of ${n} proposal-votes check(s) FAILED` : `all proposal-votes checks passed (${n})`);
process.exit(fails ? 1 : 0);
