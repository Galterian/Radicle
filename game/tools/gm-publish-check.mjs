// Offline check of editor-publish.mjs publishGameModels (a GameModels bundle → one commit on players/<team>/<id> of
// chaosD6-GameModels). The "Radicle remote" is a bare clone of the local GameModels repo; no rad, no network.
//   node tools/gm-publish-check.mjs → "all gm-publish checks passed"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { GAMEMODELS_DIR, KINDS, defHash } from '../gamemodels.mjs';
import { generateDef } from '../effect-gen.mjs';
import { gmSpec, bundleDefs } from '../gm-gen.mjs';
import { publishGameModels, gmSignedOf, verifyDefinitionSignature, trailersOf, loadStatus, retryDefinition } from '../editor-publish.mjs';
import { idFromRawPublicKey } from '../profile-auth.mjs';

let fails = 0;
const ok = (c, msg) => { if (c) console.log(`ok   ${msg}`); else { fails++; console.log(`FAIL ${msg}`); } };
if (!GAMEMODELS_DIR) { console.log('skip: no chaosD6-GameModels checkout'); process.exit(0); }
const git = (args, o = {}) => execFileSync('git', args, { encoding: 'utf8', ...o }).trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-publish-'));
const remote = path.join(tmp, 'remote.git');
git(['clone', '-q', '--bare', GAMEMODELS_DIR, remote]);
const profileFile = path.join(tmp, 'profile', 'profile.json');
fs.mkdirSync(path.dirname(profileFile), { recursive: true });
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const identity = { id: idFromRawPublicKey(raw), privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
const team = { name: 'Moon Guard', slug: 'moon-guard' };
const hooks = { profileFile, remoteUrlFor: () => remote, radSync: false, nid: null, via: 'git' };

// a generated storyteller (fake model) — the bundle touches the village and the race too
const cfg = { url: 'http://x', key: '', model: 'm', timeoutMs: 5000, attempts: 1, maxTokens: 1024 };
const answer = { npc: { id: 'npc_empire_bard', name: 'Old Bard', race: 'race_empire', role: 'storyteller', home: 'bld_empire_library', persona: 'A travelling bard who sings of the Lion Throne.',
  lines: { greet: ['Sit, friend, and hear a song.'], lore: ['{lore}'] }, talk: [{ id: 'song_of_lions', ask: 'Sing me the Song of Lions.', say: ['Four lions, four gates, one throne.'] }],
  agenda: { uses: 'storyteller', params: {}, rules: [] }, quests: [], unit: { stats: { vitality: 9, world: 15, matter: 8, will: 16 }, actions_per_round: 2, deck_effects: ['effect_vision'] } },
  quests: [], place: { village: 'vil_empire', post: 'outside' } };
const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { completion_tokens: 100 } }) });
const g = await generateDef(gmSpec('npc'), { idea: 'a bard', cfg, fetchImpl });
ok(g.ok, `the bundle generates (${g.problems?.join('; ')})`);
const b = g.def;
const defs = bundleDefs(b).map(([k, def]) => [KINDS[k][0], def, defHash(def)]);
ok(defs.map(([s]) => s).join() === 'npcs,villages,races', `bundle files: ${defs.map(([s, d]) => `${s}/${d.id}`).join(', ')}`);

const r = await publishGameModels({ bundle: { id: b.id, name: b.name, version: b.version, kind: 'npc' }, defs, identity, team, message: 'npc: Old Bard' }, hooks);
ok(r.ok && r.publish.state === 'published' && r.ref.branch === 'players/moon-guard/npc-empire-bard', `published on ${r.ref?.branch} (${r.publish?.state}${r.publish?.error ? `: ${r.publish.error}` : ''})`);
const ref = 'refs/heads/players/moon-guard/npc-empire-bard';
const tip = git(['--git-dir', remote, 'rev-parse', ref]);
ok(tip === r.ref.commit, 'the remote branch is the commit returned');
const main = git(['--git-dir', remote, 'rev-parse', 'refs/heads/main']);
ok(git(['--git-dir', remote, 'rev-parse', `${tip}^`]) === main, 'its parent is main');
const changed = git(['--git-dir', remote, 'diff', '--name-only', main, tip]).split('\n').sort();
ok(changed.join() === ['index.json', 'npcs/npc_empire_bard.json', 'races/race_empire.json', 'villages/vil_empire.json'].sort().join(), `changed files: ${changed.join(', ')}`);
const idx = JSON.parse(git(['--git-dir', remote, 'show', `${tip}:index.json`]));
ok(idx.npcs.npc_empire_bard === defHash(b.npc) && idx.villages.vil_empire === defHash(b.touches.village), 'index.json carries the new sha256s');
const msg = git(['--git-dir', remote, 'log', '-1', '--format=%B', tip]);
const tr = trailersOf(msg);
ok(tr['Chaosd6-Author'] === identity.id && verifyDefinitionSignature(gmSignedOf(b.id, defs), tr['Chaosd6-Signature'], identity.id), 'signed by the team identity (signature verifies)');
ok(!verifyDefinitionSignature(gmSignedOf(b.id, defs.slice(0, 1)), tr['Chaosd6-Signature'], identity.id), 'the signature covers every file');

// the branch passes the GameModels repo's own checker
const wt = path.join(tmp, 'wt');
git(['clone', '-q', '--branch', 'players/moon-guard/npc-empire-bard', remote, wt]);
fs.symlinkSync(path.join(GAMEMODELS_DIR, 'node_modules'), path.join(wt, 'node_modules'), 'dir');
let check = '';
try { check = execFileSync(process.execPath, ['tools/check.mjs'], { cwd: wt, encoding: 'utf8' }); } catch (e) { check = `FAILED ${e.stdout || ''}${e.stderr || ''}`; }
ok(/^ok: \d+ definitions/m.test(check), `the branch passes tools/check.mjs (${check.trim().split('\n').pop()})`);
let man = '';
try { man = execFileSync(process.execPath, ['tools/manifest.mjs', '--check'], { cwd: wt, encoding: 'utf8' }); } catch (e) { man = `FAILED ${e.stdout || ''}${e.stderr || ''}`; }
ok(/up to date/.test(man), `the branch's index.json is up to date (${man.trim().split('\n').pop()})`);

// again with the same bundle: no new commit; a changed bundle: a fast-forward on the branch
const r2 = await publishGameModels({ bundle: { id: b.id, name: b.name, version: b.version, kind: 'npc' }, defs, identity, team }, hooks);
ok(r2.ref.commit === tip, 'the same bundle again → the same commit');
const b3 = structuredClone(b); b3.npc.lines.greet.push('Mind the lions.');
const defs3 = bundleDefs(b3).map(([k, def]) => [KINDS[k][0], def, defHash(def)]);
const r3 = await publishGameModels({ bundle: { id: b3.id, name: b3.name, version: b3.version, kind: 'npc' }, defs: defs3, identity, team }, hooks);
ok(r3.ref.commit !== tip && git(['--git-dir', remote, 'rev-parse', `${r3.ref.commit}^`]) === tip, 'a change → a new commit on top of the earlier one');
const st = loadStatus(hooks).defs['gamemodels:npc_empire_bard'];
ok(st?.publish?.state === 'published' && st.gm_kind === 'npc' && st.defs.length === 3, 'status record kept (kind gamemodels)');
const rr = await retryDefinition({ kind: 'gamemodels', id: 'npc_empire_bard', identity, team }, hooks);
ok(rr.ok && rr.ref.commit === r3.ref.commit, 'retry republishes the stored bundle');
const bad = await publishGameModels({ bundle: { id: b.id, name: b.name, version: b.version, kind: 'npc' }, defs, identity, team }, { ...hooks, via: 'bridge' });
ok(bad.publish.state === 'pending' && /phone/.test(bad.publish.error), 'the phone: pending with a clear reason');

// ---- the proposals list (gm-proposals.mjs) on a Radicle-like storage: the branch under the publisher's namespace
const { listGmProposals } = await import('../gm-proposals.mjs');
const V = await import('../proposal-votes.mjs');
const ns = 'z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
const top = git(['--git-dir', remote, 'rev-parse', ref]);
git(['--git-dir', remote, 'update-ref', `refs/namespaces/${ns}/refs/heads/players/moon-guard/npc-empire-bard`, top]);
git(['--git-dir', remote, 'update-ref', '-d', ref]);
const voterProfile = path.join(tmp, 'voter', 'profile.json');
fs.mkdirSync(path.dirname(voterProfile), { recursive: true });
const voter = V.whoAmI({ profileFile: voterProfile, team: 'Sun Riders', create: true });
let L = listGmProposals({ storageDir: remote, profileFile: voterProfile, me: voter });
const p = L.proposals[0];
ok(L.available && L.proposals.length === 1 && p.id === 'npc_empire_bard' && p.team === 'moon-guard' && p.ns === ns, `listed: ${L.proposals.map(x => `${x.branch} (${x.ns?.slice(0, 10)})`).join(', ')}`);
ok(p.signature_ok && p.author === identity.id && p.commit === top, 'its author and signature verify');
ok(p.bundle.kind === 'npc' && p.bundle.npc.lines.greet.includes('Mind the lions.') && p.bundle.touches.village?.id === 'vil_empire' && p.bundle.place?.post === 'outside', 'the bundle is rebuilt from the commit (npc, village, place)');
ok(p.sha256 === r3.ref.sha256, 'its version (sha256) is the one the publisher returned');
ok(!p.own && listGmProposals({ storageDir: remote, profileFile, me: V.whoAmI({ profileFile, team: 'Moon Guard' }) }).proposals[0].own, 'own: false for another team, true for the author team');
const vote = V.recordVote({ ref: p.ref, value: -2, comment: 'too sad', profileFile: voterProfile, team: 'Sun Riders' });
ok(vote.vote.sig && vote.vote.kind === 'gamemodels' && vote.vote.repo === 'chaosD6-GameModels', 'a signed vote on it (kind gamemodels)');
L = listGmProposals({ storageDir: remote, profileFile: voterProfile, me: voter });
ok(L.proposals[0].mine?.value === -2, 'my vote shows on the list');
let threw = '';
try { V.recordVote({ ref: p.ref, value: -3, comment: '', profileFile: voterProfile, team: 'Sun Riders' }); } catch (e) { threw = e.message; }
ok(/comment/i.test(threw), `a minus vote needs a comment (${threw})`);
threw = '';
try { V.recordVote({ ref: p.ref, value: 5, profileFile, team: 'Moon Guard' }); } catch (e) { threw = e.code; }
ok(threw === 'author', 'the author team cannot vote on it');
const { createGenJobs } = await import('../gen-jobs.mjs');
const jobs = createGenJobs({ dir: path.join(tmp, 'gen'), draftsDir: path.join(tmp, 'drafts'), llmFile: path.join(tmp, 'llm.json'), log: () => {} });
const dr = jobs.importProposal({ kind: p.kind, bundle: p.bundle, proposal: p });
ok(dr.state === 'preview' && dr.proposal.branch === p.branch && dr.def.id === 'npc_empire_bard' && fs.existsSync(dr.file), `"Try it": imported as a draft (${dr.verdict}${dr.problems.length ? `: ${dr.problems.join('; ')}` : ''})`);
ok(jobs.importProposal({ kind: p.kind, bundle: p.bundle, proposal: p }).draft_id === dr.draft_id, 'the same proposal again → the same draft');
let pubErr = '';
try { jobs.beginPublish(dr.draft_id); } catch (e) { pubErr = e.message; }
ok(/not yours|testing success/.test(pubErr), `another team's proposal is not published from here (${pubErr})`);

// ---- Test Random with the proposals: the catalog + env the launcher would pass
const { proposalTestCatalog } = await import('../gm-proposals.mjs');
const tc = await proposalTestCatalog({ storageDir: remote, profileFile: voterProfile, me: voter, outDir: path.join(tmp, 'tc') });
const cat = tc.file ? JSON.parse(fs.readFileSync(tc.file, 'utf8')) : {};
ok(tc.proposals.map(x => x.id).join() === 'npc_empire_bard' && cat.npcs?.npc_empire_bard && cat.villages?.vil_empire, 'the proposal is in the compiled test catalog');
ok(tc.env.GAMEMODELS_TEST_NPC === 'npc_empire_bard' && tc.env.GAMEMODELS_TEST_VILLAGE === 'vil_empire' && JSON.parse(tc.env.GAMEMODELS_PROPOSALS)[0].branch === p.branch, 'env: the test hooks + the refs to vote on');
const mineTc = await proposalTestCatalog({ storageDir: remote, profileFile, me: V.whoAmI({ profileFile, team: 'Moon Guard' }), outDir: path.join(tmp, 'tc2') });
ok(!mineTc.file && !mineTc.proposals.length, 'my own team\'s proposals are not put in my test games');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `${fails} gm-publish check(s) FAILED` : 'all gm-publish checks passed');
process.exit(fails ? 1 : 0);
