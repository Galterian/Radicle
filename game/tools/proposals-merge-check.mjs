// Offline check of "Publish to main" (user ruling 2026-11-28 A) and the GameModels 8B review (ruling B).
//   node tools/proposals-merge-check.mjs → "all proposals-merge checks passed"
// A: a fake chaosD6-Effects (temp bare "Radicle storage" with an identity document refs/rad/id + a maintainer checkout);
//    effects published by the editor (editor-publish.mjs publishDefinition → players/<team>/<slug>), signed votes on
//    votes/<voter> branches; then listMineWithVotes, publishToMain (dry, merge as a delegate, patch as a non-delegate),
//    the vote gate (not publishable, needs rework), the CLI tools/oci/proposals-merge.mjs (list, DRY merge).
//    No rad, no network, no push outside the temp dir; the real publish pipeline is replaced by a fake commit.
// B: gm-gen.mjs reviewGameModel (a fake 8B), gen-jobs review() / the test's review → draft.review, the publish gate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'proposals-merge-check-'));
process.env.CHAOSD6_PROFILE_DIR = path.join(T, 'profile');
process.env.PV_PUBLISH = '0';
delete process.env.PROPOSALS_MERGE_DRY;
const { publishDefinition, listMineWithVotes, publishToMain, ridOfKind, defSha, loadStatus } = await import('../editor-publish.mjs');
const M = await import('./oci/proposals-merge.mjs');
const { templateOf } = await import('../editor-api.mjs');
const { signVote, publishVotesCommit } = await import('../proposal-votes.mjs');
const { idFromRawPublicKey, generateIdentity } = await import('../profile-auth.mjs');

let fails = 0, oks = 0;
const ok = (c, msg) => { if (c) { oks++; console.log(`ok   ${msg}`); } else { fails++; console.log(`FAIL ${msg}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GIT_ID = ['-c', 'user.name=check', '-c', 'user.email=check@x'];
const git = (args, o = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...o }).trim();
const newNid = () => { const { publicKey } = crypto.generateKeyPairSync('ed25519'); return idFromRawPublicKey(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)); };
/** An identity COB tip (manifest, action 0 = revision → the doc blob, embeds/radicle.json) on refs/rad/id. */
function makeIdentity(gitdir, delegates, threshold = 1) {
  const g = (args, input) => git(['--git-dir', gitdir, ...args], input === undefined ? {} : { input });
  const doc = g(['hash-object', '-w', '--stdin'], JSON.stringify({ delegates: delegates.map(d => `did:key:${d}`), payload: { 'xyz.radicle.project': { defaultBranch: 'main', name: 'chaosD6-Effects', description: 'check' } }, threshold }));
  const old = g(['hash-object', '-w', '--stdin'], JSON.stringify({ delegates: [], payload: {}, threshold: 1 }));
  const embeds = g(['mktree'], `100644 blob ${old}\tradicle.json\n`);
  const action = g(['hash-object', '-w', '--stdin'], JSON.stringify({ type: 'revision', blob: doc, parent: null, signature: 'x', title: 'check' }));
  const manifest = g(['hash-object', '-w', '--stdin'], JSON.stringify({ typeName: 'xyz.radicle.id', version: 1 }));
  const tree = g(['mktree'], `100644 blob ${action}\t0\n040000 tree ${embeds}\tembeds\n100644 blob ${manifest}\tmanifest\n`);
  const c = git(['--git-dir', gitdir, ...GIT_ID, 'commit-tree', tree, '-m', 'identity']);
  g(['update-ref', 'refs/rad/id', c]);
}

try {
  // ---------------------------------------------------------------- the fake chaosD6-Effects
  const work = path.join(T, 'work');
  fs.mkdirSync(path.join(work, 'effects'), { recursive: true }); fs.mkdirSync(path.join(work, 'tools'), { recursive: true });
  const realManifest = path.join(M.repoDirOf('effect'), 'tools', 'manifest.mjs');
  const haveManifest = fs.existsSync(realManifest);
  if (haveManifest) fs.copyFileSync(realManifest, path.join(work, 'tools', 'manifest.mjs'));
  fs.copyFileSync(path.join(GAME, 'effects-data', 'effects', 'effect_fireball.json'), path.join(work, 'effects', 'effect_fireball.json'));
  if (haveManifest) execFileSync(process.execPath, ['tools/manifest.mjs'], { cwd: work, stdio: 'pipe' });
  else fs.writeFileSync(path.join(work, 'index.json'), JSON.stringify({ format: 1, hash: 'sha256(canonical-json)', effects: {} }, null, 2) + '\n');
  git(['init', '-q', '-b', 'main', work]); git(['-C', work, 'add', '-A']); git(['-C', work, ...GIT_ID, 'commit', '-q', '-m', 'main']);
  const storage = path.join(T, 'storage.git');
  git(['clone', '-q', '--bare', work, storage]);
  const ME = newNid(), OTHER = newNid();
  makeIdentity(storage, [ME]);
  const checkout = path.join(T, 'checkout');
  git(['clone', '-q', storage, checkout]);

  // ---------------------------------------------------------------- identity document → merge rights
  const doc = M.identityDoc(storage);
  ok(doc && doc.delegates.length === 1 && doc.delegates[0] === ME && doc.threshold === 1 && doc.name === 'chaosD6-Effects', 'identityDoc: the revision blob of refs/rad/id (delegates, threshold, name)');
  ok(M.mergeRights({ storageDir: storage, nid: ME }).can === true, 'a delegate (threshold 1) may merge');
  ok(/not a delegate/.test(M.mergeRights({ storageDir: storage, nid: OTHER }).why || ''), 'another node may not (→ a patch)');
  ok(M.mergeRights({ storageDir: storage, nid: null }).can === false && M.mergeRights({ storageDir: path.join(T, 'none'), nid: ME }).can === false, 'no NID / no storage → no merge (a patch)');
  const s2 = path.join(T, 'storage2.git'); git(['init', '-q', '--bare', s2]); makeIdentity(s2, [ME, OTHER], 2);
  ok(/needs 2 delegates/.test(M.mergeRights({ storageDir: s2, nid: ME }).why || ''), 'threshold 2 → a patch even for a delegate');

  // ---------------------------------------------------------------- the editor publishes three effects
  const profileFile = path.join(T, 'profile', 'profile.json');
  fs.mkdirSync(path.dirname(profileFile), { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const identity = { id: idFromRawPublicKey(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  const team = { name: 'Check Team', slug: 'Check-Team' };
  let runs = 0;
  const fakePublish = async ({ repoDir, message }) => { runs++; git(['-C', repoDir, ...GIT_ID, 'commit', '-q', '-m', message]); return { code: 0, out: 'fake pipeline: checks ok, pushed' }; };
  const hooks = { profileFile, remoteUrlFor: () => storage, radSync: false, via: 'git', nid: ME, storageDirFor: () => storage, repoDirFor: () => checkout, runPublish: fakePublish };
  const tpl = (await templateOf('effect')).def;
  const mk = (id, name) => ({ ...structuredClone(tpl), id, name });
  const good = mk('effect_check_bolt', 'Check Bolt'), few = mk('effect_check_spark', 'Check Spark'), bad = mk('effect_check_dud', 'Check Dud');
  for (const d of [good, few, bad]) {
    const r = await publishDefinition({ kind: 'effect', def: d, identity, team, message: d.name }, hooks);
    ok(r.ok && r.publish.state === 'published', `published ${d.id} on ${r.ref.branch}`);
  }
  const st = loadStatus(hooks).defs;
  const tipOf = (id) => st[`effect:${id}`].commit;

  // ---------------------------------------------------------------- votes (signed, on votes/<voter> branches of the storage)
  const voteOn = (def, values) => {
    const ref = { kind: 'effect', repo: ridOfKind('effect'), branch: st[`effect:${def.id}`].branch, id: def.id, sha256: defSha(def) };
    values.forEach((value, i) => {
      const vk = generateIdentity();
      const at = new Date(Date.UTC(2026, 10, 28, 10, i)).toISOString();
      const v = signVote(vk.privateKeyPem, { ...ref, value, comment: value < 0 ? 'too strong for its cost' : '', tags: value > 0 ? ['fun'] : ['overpowered'], at });
      publishVotesCommit({ gitdir: storage, votes: [v], voter: v.voter });
    });
  };
  voteOn(good, [6, 5, 4, 3, 2, 2, 1, 1, -2, -3]);   // 10 votes, 8 positive (80 %) → publishable
  voteOn(few, [6, 6, 6, 6, 6, 6, 6, 6, 6]);         // 9 votes → not yet
  voteOn(bad, [-5, -5, -4, -6, -3, -5, -4, -5, -6, 1]);   // 10 votes, mean ≤ −3 → needs rework

  const mine = await listMineWithVotes(team.slug, hooks);
  const by = Object.fromEntries(mine.map(x => [x.id, x]));
  ok(by.effect_check_bolt?.votes?.n === 10 && by.effect_check_bolt.votes.share === 80 && by.effect_check_bolt.votes.publishable && !by.effect_check_bolt.votes.needs_rework && by.effect_check_bolt.can_main,
    `definitions/mine: Check Bolt 10 votes, ${by.effect_check_bolt?.votes?.share} % positive, publishable`);
  ok(by.effect_check_bolt.votes.top_tags[0]?.id === 'fun' && by.effect_check_bolt.votes.top_tags[0].n === 8, 'top tags with counts (fun ×8)');
  ok(by.effect_check_spark?.votes?.n === 9 && !by.effect_check_spark.votes.publishable && !by.effect_check_spark.can_main, 'Check Spark: 9 votes → not publishable');
  ok(by.effect_check_dud?.votes?.needs_rework && !by.effect_check_dud.votes.publishable, 'Check Dud: needs rework');

  // ---------------------------------------------------------------- the gate
  let r = await publishToMain({ kind: 'effect', id: 'effect_check_spark', identity, team, dry: true }, hooks);
  ok(!r.ok && /not publishable yet: 9 vote/.test(r.error), `not publishable → refused (${r.error})`);
  r = await publishToMain({ kind: 'effect', id: 'effect_check_dud', identity, team, dry: true }, hooks);
  ok(!r.ok && /NEEDS REWORK/.test(r.error), 'needs rework → refused');
  const dudAgg = M.collectionOfVersion('effect', { branch: st['effect:effect_check_dud'].branch, id: bad.id, sha256: defSha(bad) }, { storageDir: storage });
  ok(/NEEDS REWORK/.test(M.gateOf(dudAgg, { force: true }) || ''), 'needs rework is refused even with --force');
  ok(M.gateOf(M.collectionOfVersion('effect', { branch: st['effect:effect_check_spark'].branch, id: few.id, sha256: defSha(few) }, { storageDir: storage }), { force: true }) === null, '--force lets a not-yet-publishable version through (maintainer only)');
  r = await publishToMain({ kind: 'effect', id: 'effect_check_bolt', identity, team: { name: 'Other', slug: 'other' }, dry: true }, hooks);
  ok(!r.ok && /belongs to team/.test(r.error), 'another team cannot publish my version');

  // ---------------------------------------------------------------- the CLI (list, DRY merge) — before the real merge
  const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(GAME, 'tools', 'oci', 'proposals-merge.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  let c = cli(['list', '--kind', 'effect', '--storage', storage, '--nid', ME]);
  const out = c.stdout || '';
  ok(c.status === 0 && /this node may merge \(delegate\)/.test(out) && /effect_check_bolt .*votes 10 +80 %\+ +PUBLISHABLE/.test(out) && /effect_check_dud .*NEEDS REWORK/.test(out) && /effect_check_spark .*votes +9 .* open/.test(out),
    `CLI list: the three proposals with their collections\n${out.trim().split('\n').map(l => `       ${l}`).join('\n')}`);
  c = cli(['list', '--kind', 'effect', '--storage', storage, '--json']);
  let js = null; try { js = JSON.parse(c.stdout); } catch {}
  ok(Array.isArray(js) && js.length === 3 && js.every(p => p.votes && p.sha256 && p.commit), 'CLI list --json');
  const headBefore = git(['-C', checkout, 'rev-parse', 'HEAD']);
  c = cli(['merge', '--kind', 'effect', '--branch', st['effect:effect_check_bolt'].branch, '--storage', storage, '--repo', checkout, '--nid', ME], { DRY: '1' });
  ok(c.status === 0 && /DRY=1: nothing merged/.test(c.stdout) && /validates/.test(c.stdout) && /defs-publish\.sh effects -m/.test(c.stdout), `CLI DRY merge runs every check (${(c.stderr || '').trim().split('\n').pop() || 'ok'})`);
  c = cli(['merge', '--kind', 'effect', '--branch', st['effect:effect_check_spark'].branch, '--storage', storage, '--repo', checkout, '--nid', ME], { DRY: '1' });
  ok(c.status === 1 && /not publishable yet/.test(c.stderr), 'CLI merge refuses a not-publishable version');
  c = cli(['merge', '--kind', 'effect', '--branch', st['effect:effect_check_dud'].branch, '--storage', storage, '--repo', checkout, '--nid', ME, '--force'], { DRY: '1' });
  ok(c.status === 1 && /NEEDS REWORK/.test(c.stderr), 'CLI merge --force still refuses a version that needs rework');
  c = cli(['merge', '--kind', 'effect', '--branch', st['effect:effect_check_bolt'].branch, '--storage', storage, '--repo', checkout, '--nid', OTHER], { DRY: '1' });
  ok(c.status === 1 && /not a delegate/.test(c.stderr), 'CLI merge on a non-delegate node → refused (the editor opens a patch)');

  // ---------------------------------------------------------------- the editor: dry, patch, merge
  r = await publishToMain({ kind: 'effect', id: 'effect_check_bolt', identity, team, dry: true }, hooks);
  ok(r.ok && r.mode === 'merge' && r.dry && r.steps.some(s => /validates/.test(s)) && r.steps.some(s => /= the voted one/.test(s)) && (haveManifest ? r.steps.some(s => /manifest\.mjs --check/.test(s)) : true),
    `dry run as a delegate: merge, every check (${r.error || r.steps.length + ' steps'})`);
  ok(git(['-C', checkout, 'rev-parse', 'HEAD']) === headBefore && !git(['-C', checkout, 'status', '--porcelain']) && runs === 0 && !loadStatus(hooks).defs['effect:effect_check_bolt'].main, 'dry: the checkout, the pipeline and the status are untouched');
  r = await publishToMain({ kind: 'effect', id: 'effect_check_bolt', identity, team, dry: true }, { ...hooks, nid: OTHER });
  ok(r.ok && r.mode === 'patch' && r.commands.some(x => x.includes(`${tipOf('effect_check_bolt')}:refs/patches`) && x.includes('patch.message=')) && /not a delegate/.test(r.rights.why), 'a non-delegate: a Radicle patch (git push rad <tip>:refs/patches -o patch.message=…), dry');
  // the branch moved after the votes (a new commit with another version) → the merge refuses (votes do not carry over)
  const bogus = await M.mergeProposal({ kind: 'effect', source: storage, srcRef: `refs/heads/${st['effect:effect_check_bolt'].branch}`, expect: { id: good.id, sha256: 'f'.repeat(64) },
    agg: M.collectionOfVersion('effect', { branch: st['effect:effect_check_bolt'].branch, id: good.id, sha256: defSha(good) }, { storageDir: storage }), repoDir: checkout, dry: true });
  ok(!bogus.ok && /not the voted version/.test(bogus.error), 'a tip that is not the voted version → refused');
  fs.writeFileSync(path.join(checkout, 'stray.txt'), 'x');
  r = await publishToMain({ kind: 'effect', id: 'effect_check_bolt', identity, team }, hooks);
  ok(!r.ok && /uncommitted changes/.test(r.error), 'a dirty checkout → refused');
  fs.rmSync(path.join(checkout, 'stray.txt'));
  r = await publishToMain({ kind: 'effect', id: 'effect_check_bolt', identity, team }, hooks);
  const head = git(['-C', checkout, 'rev-parse', 'HEAD']);
  const parents = git(['-C', checkout, 'rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').slice(1);
  ok(r.ok && r.mode === 'merge' && runs === 1 && r.merged?.commit === head && parents.length === 2 && parents[0] === headBefore && parents[1] === tipOf('effect_check_bolt'),
    `merge as a delegate → the pipeline's commit is a merge of main + the proposal tip (${r.error || head.slice(0, 8)})`);
  ok(git(['-C', checkout, 'ls-tree', '--name-only', 'HEAD', 'effects/']).split('\n').includes('effects/effect_check_bolt.json') && !git(['-C', checkout, 'for-each-ref', 'refs/chaosd6/']), 'main carries the effect; no helper refs left behind');
  const rec = loadStatus(hooks).defs['effect:effect_check_bolt'];
  ok(rec.main?.state === 'merged' && rec.main.commit === head && rec.main.sha256 === defSha(good), 'status: main = merged @ the commit');
  r = await publishToMain({ kind: 'effect', id: 'effect_check_bolt', identity, team, dry: true }, hooks);
  ok(!r.ok && /already in main/.test(r.error), 'a second time → already in main');
  const mine2 = await listMineWithVotes(team.slug, hooks);
  ok(mine2.find(x => x.id === 'effect_check_bolt')?.main?.state === 'merged', 'definitions/mine shows it in main');
  // a failed pipeline before its commit → the merge is undone
  const failPublish = async () => ({ code: 1, out: 'STOP: effects-check failed', error: 'effects-check failed' });
  voteOn(few, [5]);   // the 10th vote → publishable
  const h0 = git(['-C', checkout, 'rev-parse', 'HEAD']);
  r = await publishToMain({ kind: 'effect', id: 'effect_check_spark', identity, team }, { ...hooks, runPublish: failPublish });
  ok(!r.ok && /merge is undone/.test(r.error) && git(['-C', checkout, 'rev-parse', 'HEAD']) === h0 && !git(['-C', checkout, 'status', '--porcelain']) && !fs.existsSync(path.join(checkout, '.git', 'MERGE_HEAD')),
    'the pipeline stops before its commit → the merge is aborted, the checkout is clean');
  ok(loadStatus(hooks).defs['effect:effect_check_spark'].main?.state === 'failed', 'status: main = failed (with the error)');
  // index.json conflicts (main moved since the proposal) → regenerated by the repo's manifest.mjs
  if (haveManifest) {
    r = await publishToMain({ kind: 'effect', id: 'effect_check_spark', identity, team }, hooks);
    ok(r.ok && r.steps.some(s => /index\.json conflicted — regenerated/.test(s)) && JSON.parse(fs.readFileSync(path.join(checkout, 'index.json'), 'utf8')).effects.effect_check_spark === defSha(few),
      `main moved → index.json conflict regenerated, merged (${r.error || 'ok'})`);
  }
  // the phone cannot
  r = await publishToMain({ kind: 'effect', id: 'effect_check_bolt', identity, team }, { ...hooks, via: 'bridge' });
  ok(!r.ok && /desktop/.test(r.error), 'the phone: publish to main is a desktop action');

  // ---------------------------------------------------------------- GameModels vote keys (no repo in the ref → the repo name)
  {
    const P = await import('../proposal-votes.mjs');
    const vk = generateIdentity();
    const ref = { kind: 'gamemodels', branch: 'players/x/npc-a', id: 'npc_a', sha256: 'a'.repeat(64) };
    const v = P.signVote(vk.privateKeyPem, { ...ref, value: 4, comment: '', at: '2026-11-28T10:00:00.000Z' });
    ok(M.collectionFromVotes([v], 'gamemodels', ref).n === 1 && M.voteKeysOf('gamemodels', ref).includes(v.key), 'a GameModels vote (repo chaosD6-GameModels) is found by its version');
  }

  // ---------------------------------------------------------------- B: the 8B review of a GameModels item
  const G = await import('../gm-gen.mjs');
  const { GAMEMODELS_DIR } = await import('../gamemodels.mjs');
  let bundle = null;
  if (GAMEMODELS_DIR) { const npc = G.catalogForEdit().find(x => x.kind === 'npc'); bundle = npc ? G.bundleFromRepo('npc', npc.id) : null; }
  bundle ||= { schema: G.BUNDLE_SCHEMA, kind: 'npc', id: 'npc_check', name: 'Check', version: '0.1.0', npc: { id: 'npc_check', name: 'Check', race: 'race_empire', role: 'storyteller', persona: 'x', lines: { greet: ['hi'] } }, quests: [], place: { village: 'vil_empire' }, touches: {} };
  const msgs = G.reviewMessages(bundle, { pass: true, why: [], spawned: true, talks: 2, talk: [{ ask: 'Who are you?', answer: 'A teller of tales.' }] });
  ok(/"verdict": "good" \| "needs_work"/.test(msgs[0].content) && /no balance script/.test(msgs[0].content) && /Who are you\?/.test(msgs[1].content), 'review prompt: asks a verdict, says there is no balance script, carries the conversation');
  let seenCfg = null;
  const fake8b = (text) => async (cfg, messages, opts) => { seenCfg = { cfg, opts }; return { text }; };
  const cfg = { url: 'http://127.0.0.1:8096', model: 'qwen3-8b' };
  let rv = await G.reviewGameModel(bundle, { cfg, completeImpl: fake8b('{"verdict":"good","summary":"Vivid and fitting.","suggestions":["add a lore line"]}') });
  ok(rv.verdict === 'good' && rv.model === 'qwen3-8b' && rv.where === 'local' && rv.suggestions.length === 1 && seenCfg.opts.schema.properties.verdict.enum.includes('needs_work'), 'reviewGameModel: verdict + summary + suggestions from the 8B (schema has the verdict enum)');
  ok(G.parseReview('{"verdict":"Needs some work","summary":"x","suggestions":[]}').verdict === 'needs_work' && G.parseReview('nope').error && G.parseReview('{"summary":"x"}').error, 'parseReview: loose verdicts, no JSON / no verdict → error');
  ok((await G.reviewGameModel(bundle, { cfg: { url: '' } })).error, 'no model configured → an error, not a verdict');

  const { createGenJobs } = await import('../gen-jobs.mjs');
  const { genConfig } = await import('../effect-gen.mjs');
  const PD = path.join(T, 'gen');
  const llmFile = path.join(PD, 'llm.json');
  fs.mkdirSync(PD, { recursive: true });
  let reviewCalls = 0, lastReviewCfg = null;
  const spawned = [];
  const fakeSpawn = (exe, args) => {
    spawned.push(args);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    const o = args[args.indexOf('--out') + 1];
    setTimeout(() => { fs.writeFileSync(o, JSON.stringify({ pass: true, why: [], spawned: true, talks: 2, agenda: 1, quests: 0, errors: 0, divergences: 0, lines: [], talk: [], review: { verdict: 'needs_work', summary: 'Flat voice.', suggestions: ['give it a dialect'], model: 'qwen3-8b', where: 'local' } })); child.emit('exit', 0); }, 30);
    return child;
  };
  const jobs = createGenJobs({ dir: path.join(PD, 'gen-drafts'), draftsDir: path.join(PD, 'effect-drafts'), llmFile, env: {}, spawnImpl: fakeSpawn, statsImpl: () => null, everyMs: 30,
    generate: async () => ({ ok: false, error: 'no generation in this check' }),
    reviewImpl: async (b, o) => { reviewCalls++; lastReviewCfg = o.cfg; return { verdict: 'good', summary: 'Ready.', suggestions: ['one more quest'], model: o.cfg.model, where: 'local', at: new Date().toISOString() }; } });
  const write = (d) => { fs.mkdirSync(path.join(PD, 'gen-drafts'), { recursive: true }); fs.writeFileSync(path.join(PD, 'gen-drafts', `${d.draft_id}.json`), JSON.stringify(d)); };
  write({ draft_id: 'gen_check0001', kind: 'npc', idea: 'a bard', state: 'testing success', fails: 0, def: bundle, verdict: 'ok', problems: [], log: [], created_at: new Date().toISOString() });
  let threw = null; try { jobs.beginPublish('gen_check0001'); } catch (e) { threw = e; }
  ok(threw?.status === 409 && threw.code === 'no_review' && /has not reviewed/.test(threw.message), 'publishing a GameModels draft without the 8B verdict → 409 no_review');
  jobs.review('gen_check0001');
  let d;
  for (let i = 0; i < 100; i++) { d = jobs.get('gen_check0001'); if (!d.reviewing) break; await sleep(20); }
  ok(reviewCalls === 1 && d.review?.verdict === 'good' && d.review.from === 'review' && d.suggestions.includes('one more quest') && d.state === 'testing success', 'review(): the 8B verdict on the draft, its suggestions offered, the state kept');
  ok(lastReviewCfg?.model === genConfig({}, { file: llmFile }).model && /8b/i.test(lastReviewCfg.model), `the review goes to the editor's 8B route (${lastReviewCfg?.model} at ${lastReviewCfg?.url})`);
  ok(jobs.beginPublish('gen_check0001').state === 'publishing', 'with a verdict the publish starts');
  jobs.endPublish('gen_check0001', { ok: false, error: 'x' });
  write({ draft_id: 'gen_check0002', kind: 'npc', idea: 'a bard 2', state: 'testing success', fails: 0, def: bundle, verdict: 'ok', problems: [], log: [], created_at: new Date().toISOString() });
  ok(jobs.beginPublish('gen_check0002', { withoutReview: true }).state === 'publishing', '"publish without the review" (the author confirmed) → allowed');
  write({ draft_id: 'gen_check0003', kind: 'npc', idea: 'a bard 3', state: 'preview', fails: 0, def: bundle, verdict: 'ok', problems: [], log: [], created_at: new Date().toISOString(), file: path.join(PD, 'gm-drafts', `${bundle.id}.json`) });
  jobs.test('gen_check0003');
  for (let i = 0; i < 100; i++) { d = jobs.get('gen_check0003'); if (d.state !== 'testing') break; await sleep(20); }
  const a = spawned.at(-1) || [];
  ok(d.state === 'testing success' && d.review?.verdict === 'needs_work' && d.review.from === 'test' && d.talk?.some(t => /8B: needs work/.test(t.text)), 'the test game\'s review → draft.review (needs work) + the conversation');
  ok(a.includes('--review') && a[a.indexOf('--llm-file') + 1] === llmFile && /gm-gen-test\.mjs$/.test(a[0]), 'the test runner gets --review and the editor\'s llm.json (--llm-file)');
  write({ draft_id: 'gen_check0004', kind: 'effect', idea: 'x', state: 'preview', fails: 0, def: { id: 'effect_x' }, verdict: 'ok', problems: [], log: [], created_at: new Date().toISOString() });
  threw = null; try { jobs.review('gen_check0004'); } catch (e) { threw = e; }
  ok(threw?.status === 400, 'review() is for GameModels drafts only (effects / skills / classes keep the rebalance validator)');
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `${fails} proposals-merge check(s) FAILED (${oks} ok)` : `all proposals-merge checks passed (${oks} ok)`);
process.exit(fails ? 1 : 0);
