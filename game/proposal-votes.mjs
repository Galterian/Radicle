// Proposal votes (user ruling 2026-11-17): "Each time you see something from other branch you are
// receiving it for testing: those card should have a vote +6 to -6 (on minus vote you should have to put
// a comment). This is wrote in a Proposal vote collection property of that class, effect or class."
// Follow-up rulings 2026-11-17: (1) no vote from the author; (2) popup the first time (HUD); (3) publish
// automatically after each vote, OCI seed only; (4) n ≥ 10 and mean ≤ −3 → `review` flag; (5) votes do not
// carry over to a new version. Full contract: game/effects-data/PROPOSAL_VOTES.md.
//
// A FOREIGN definition = an effect / skill / class taken from a player branch players/<who>/<slug> of
// chaosD6-Effects / chaosD6-Skills / chaosD6-Classes (defs-repo.mjs refs). Every player who meets one in a
// game — except its author — may vote on that exact VERSION of it:
//
//   vote = { key, kind, repo, branch, id, sha256?, commit?, ns?, author?,   the def version (+ its publisher's
//                                                                          Radicle namespace / author, when known)
//            voter, voter_nid?, voter_name?, voter_handles?,              who votes (profile key, node NID, names)
//            value, comment, at, dimension?, door?, sig? }
//   key  = `${repo}|${branch}|${id}|${sha256 || commit}`        one vote per voter per key; a later vote replaces the earlier
//
// Votes are PROFILE data, never game state: nothing here is read by the resolver or the state hash.
// Local store: <profile dir>/proposal_votes.json; publish status: <profile dir>/proposal_votes.publish.json.
// Publishing (ruling 3), debounced, in the background after each vote, retried while a vote is owed:
//   desktop: child proposal-votes-publish.mjs → votes/<voter> → `git push rad` → `rad sync <rid> --seed <OCI> --announce`
//   phone:   in process, POST /publish of the in-app node bridge (feature "votes"), seed = OCI. Never a public seed.
// Collections (ruling 4): the publisher also collects everyone's votes from local Radicle storage →
// <profile dir>/proposal_votes.collected.json; review = n ≥ 10 and mean ≤ −3 (validatorWithVotes, HUD ⚑).
//
// Node 18 compatible, node:* only (+ defs-repo.mjs / profile-auth.mjs).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto, { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, ID_RE, SHA_RE, COMMIT_RE, isPlayerBranch } from './defs-repo.mjs';
import { idFromPrivateKeyPem, rawPublicKeyFromId, idFromRawPublicKey, generateIdentity } from './profile-auth.mjs';

export const VALUE_MIN = -6, VALUE_MAX = 6;
export const COMMENT_MAX = 500;
export const REVIEW_MIN_VOTES = 10, REVIEW_MEAN_MAX = -3;   // ruling (4): below 10 votes, no effect
export const KINDS = ['effect', 'skill', 'class'];
export const REPO_NAMES = { effect: 'chaosD6-Effects', skill: 'chaosD6-Skills', class: 'chaosD6-Classes' };
export const DEFAULT_RIDS = {
  effect: process.env.CHAOSD6_EFFECTS_RID || 'rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ',
  skill: process.env.CHAOSD6_SKILLS_RID || 'rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5',
  class: process.env.CHAOSD6_CLASSES_RID || 'rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi',
};
export const OCI_SEED_NID = process.env.CHAOSD6_OCI_SEED_NID || 'z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT';
export const VOTES_FILE = 'proposal_votes.json';
export const PUBLISH_FILE = 'proposal_votes.publish.json';
export const COLLECTED_FILE = 'proposal_votes.collected.json';   // everyone's votes, as last collected from Radicle storage
export const VOTE_BRANCH_PREFIX = 'votes/';
export const NID_RE = /^z6Mk[1-9A-HJ-NP-Za-km-z]{40,50}$/;
const RID_RE = /^(rad:)?z[1-9A-HJ-NP-Za-km-z]{20,}$/;
const VOTER_RE = /^(z6Mk[1-9A-HJ-NP-Za-km-z]{40,50}|peer:[A-Za-z0-9._-]{1,120})$/;
const SIG_DOMAIN = 'chaosd6-proposal-vote\n';
const KIND_OF_ID = (id) => /^effect_/.test(id) ? 'effect' : /^skill_/.test(id) ? 'skill' : /^class_/.test(id) ? 'class' : null;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, n);

export class VoteError extends Error { constructor(code, message) { super(message); this.name = 'VoteError'; this.code = code; this.status = 400; } }
const fail = (code, msg) => { throw new VoteError(code, msg); };

// ---------------------------------------------------------------------------------------------
// authorship (ruling 1: no vote from the author)

/** Compare names loosely: "P-Larkin" = "p_larkin" = "p larkin". */
export const handleSlug = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const branchWho = (b) => /^players\/([^/]+)\//.exec(String(b || ''))?.[1] || null;

/** Why `me` ({ voter, nid, handles }) is the author of `target` (a ref / vote), or null.
 *  Author = the publisher's Radicle namespace (target.ns) is my profile key or node NID, or the branch's <who> /
 *  the ref's author is my key / NID / one of my names (profile team + character names, Radicle alias). */
export function authorConflict(target, me) {
  const ids = new Set([me?.voter, me?.nid].filter(Boolean));
  if (target?.ns && ids.has(target.ns)) return 'you published this definition — authors do not vote on their own cards';
  const hs = new Set((me?.handles || []).map(handleSlug).filter(Boolean));
  for (const a of [branchWho(target?.branch), target?.author]) {
    if (!a) continue;
    if (ids.has(a) || hs.has(handleSlug(a))) return `${target.branch} is your own branch — authors do not vote on their own cards`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// keys + validation (pure)

/** The def version a ref names: sha256 when known (content identity), else the commit. */
export const versionOf = (ref) => (SHA_RE.test(String(ref?.sha256 || '')) ? ref.sha256 : COMMIT_RE.test(String(ref?.commit || '')) ? ref.commit : null);
export const voteKey = (ref) => `${ref.repo}|${ref.branch}|${ref.id}|${versionOf(ref)}`;

/** A ref / source object (effect_source.js or defs-repo.mjs shape) → the def-version fields of a vote, or throws. */
export function normalizeTarget(ref) {
  if (!ref || typeof ref !== 'object') fail('ref', 'no definition named');
  const id = String(ref.id || ref.effect_id || ref.skill_id || ref.class_id || '');
  if (!ID_RE.test(id)) fail('ref', `bad definition id ${JSON.stringify(id)}`);
  const kind = KINDS.includes(ref.kind) ? ref.kind : KIND_OF_ID(id);
  if (!kind) fail('ref', `unknown kind for ${id}`);
  const branch = String(ref.branch || '');
  if (!isPlayerBranch(branch)) fail('ref', `only player-branch (players/<who>/<slug>) definitions take votes, not ${JSON.stringify(branch || 'main')}`);
  const repo = clip(ref.repo || REPO_NAMES[kind], 200);
  if (!repo || /\|/.test(repo)) fail('ref', 'bad repo');
  const t = { kind, repo, branch: branch.slice(0, 200), id };
  if (SHA_RE.test(String(ref.sha256 || ''))) t.sha256 = ref.sha256;
  if (COMMIT_RE.test(String(ref.commit || ''))) t.commit = ref.commit;
  if (!t.sha256 && !t.commit) fail('ref', 'a vote needs the definition version (sha256 or full commit)');
  if (NID_RE.test(String(ref.ns || ''))) t.ns = ref.ns;
  const author = clip(ref.author, 60); if (author) t.author = author;
  t.key = voteKey(t);
  return t;
}

/** Validate + normalise a vote (throws VoteError with a player-readable message). Does not check `sig`.
 *  A vote whose own voter fields name the def's author is invalid (ruling 1) — collectors drop it too. */
export function validateVote(v) {
  if (!v || typeof v !== 'object') fail('vote', 'no vote');
  const t = normalizeTarget(v);
  if (v.key !== undefined && v.key !== t.key) fail('key', 'vote key does not match its definition');
  const voter = String(v.voter || '');
  if (!VOTER_RE.test(voter)) fail('voter', 'bad voter id');
  const value = v.value;
  if (!Number.isInteger(value) || value < VALUE_MIN || value > VALUE_MAX) fail('value', `a vote is a whole number ${VALUE_MIN}…+${VALUE_MAX}`);
  const raw = String(v.comment ?? '');
  if (raw.length > COMMENT_MAX) fail('comment', `comment too long (max ${COMMENT_MAX} characters)`);
  const comment = clip(raw, COMMENT_MAX);
  if (value < 0 && !comment) fail('comment', 'a minus vote needs a comment: say what is wrong with it');
  const at = String(v.at || '');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(at) || Number.isNaN(Date.parse(at))) fail('at', 'bad vote time');
  const out = { ...t, voter, value, comment, at };
  if (NID_RE.test(String(v.voter_nid || ''))) out.voter_nid = v.voter_nid;
  const name = clip(v.voter_name, 60); if (name) out.voter_name = name;
  const hs = [...new Set((Array.isArray(v.voter_handles) ? v.voter_handles : []).map(h => clip(h, 60)).filter(Boolean))].slice(0, 12);
  if (hs.length) out.voter_handles = hs;
  const dim = clip(v.dimension, 80); if (dim) out.dimension = dim;
  const door = clip(v.door, 80); if (door) out.door = door;
  if (typeof v.sig === 'string' && v.sig) out.sig = v.sig;
  const why = authorConflict(out, { voter, nid: out.voter_nid, handles: [out.voter_name, ...(out.voter_handles || [])] });
  if (why) fail('author', why);
  return out;
}

/** votes[] + one vote → votes[] with it added, replacing the same voter's earlier vote on the same key
 *  (the later `at` wins; equal `at` → the incoming one). Pure: returns a new array, input order kept. */
export function upsertVote(votes, vote) {
  const v = validateVote(vote);
  const out = [];
  let placed = false;
  for (const x of votes || []) {
    if (x.key === v.key && x.voter === v.voter) {
      if (!placed) out.push(String(x.at) > String(v.at) ? x : v);
      placed = true;
    } else out.push(x);
  }
  if (!placed) out.push(v);
  return out;
}

/** Many votes (any order, duplicates allowed) → one per (key, voter), latest `at`. Invalid / author votes dropped. */
export const dedupeVotes = (votes) => (votes || []).reduce((acc, v) => { try { return upsertVote(acc, v); } catch { return acc; } }, []);

/** The PROPOSAL VOTE COLLECTION of one def version (pass a key, or votes already filtered by key).
 *  Only that exact version counts (ruling 5: no carry-over). review = n ≥ 10 and mean ≤ −3 (ruling 4). */
export function aggregate(votes, key = null) {
  const vs = dedupeVotes(votes).filter(v => !key || v.key === key);   // dedupe first: it derives each vote's key
  if (!vs.length) return { n: 0, mean: null, min: null, max: null, review: false, negatives: [] };
  const vals = vs.map(v => v.value);
  const mean = Math.round((vals.reduce((a, b) => a + b, 0) / vs.length) * 100) / 100;
  return {
    n: vs.length, mean, min: Math.min(...vals), max: Math.max(...vals),
    review: reviewFlag({ n: vs.length, mean }),
    negatives: vs.filter(v => v.value < 0).sort((a, b) => a.value - b.value || String(a.at).localeCompare(String(b.at)))
      .map(v => ({ voter: v.voter, ...(v.voter_name ? { voter_name: v.voter_name } : {}), value: v.value, comment: v.comment, at: v.at })),
  };
}
export const reviewFlag = (agg) => !!agg && (agg.n | 0) >= REVIEW_MIN_VOTES && typeof agg.mean === 'number' && agg.mean <= REVIEW_MEAN_MAX;
/** { <key>: collection } for every key present. */
export function aggregateAll(votes) {
  const vs = dedupeVotes(votes);
  const keys = [...new Set(vs.map(v => v.key))];
  return Object.fromEntries(keys.map(k => [k, aggregate(vs, k)]));
}
/** A def + its collection, in memory only (the def's sha256 is computed WITHOUT this property). */
export function withVoteCollection(def, ref, votes) {
  const key = voteKey(normalizeTarget(ref));
  return { ...def, proposal_votes: { key, ...aggregate(votes, key) } };
}
/** Validator verdict + players' votes: the rebalancing verdict itself (±10 %) is unchanged; votes only ADD a
 *  `review` flag when the collection qualifies. `verdict`: 'ok' | 'nerf' | … or { verdict, … }. */
export function verdictWithVotes(verdict, agg) {
  const base = typeof verdict === 'object' && verdict ? { ...verdict } : { verdict: verdict ?? null };
  base.votes = agg ? { n: agg.n | 0, mean: agg.mean ?? null } : { n: 0, mean: null };
  base.review = reviewFlag(agg);
  return base;
}

// ---------------------------------------------------------------------------------------------
// serialisation + signatures

/** The canonical bytes of a vote (sig excluded) — what is signed and what is written to git. */
export function serializeVote(v) { const { sig, ...rest } = validateVote(v); return canonicalJson(rest); }
export function parseVote(text) { return validateVote(JSON.parse(text)); }

export function signVote(privateKeyPem, vote) {
  const v = { ...vote, voter: idFromPrivateKeyPem(privateKeyPem) };
  delete v.sig;
  const sig = crypto.sign(null, Buffer.from(SIG_DOMAIN + serializeVote(v)), crypto.createPrivateKey(privateKeyPem));
  return { ...validateVote(v), sig: sig.toString('base64') };
}
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export function verifyVote(vote) {
  try {
    const v = validateVote(vote);
    if (!v.sig || !v.voter.startsWith('z6Mk')) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, rawPublicKeyFromId(v.voter)]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(SIG_DOMAIN + serializeVote(v)), key, Buffer.from(v.sig, 'base64'));
  } catch { return false; }
}
/** File of a vote on its voter's votes/<voter> branch. */
export const voteBranch = (voter) => `${VOTE_BRANCH_PREFIX}${voter}`;
export const votePath = (v) => `votes/${v.id}/${v.branch.replace(/\//g, '~')}@${versionOf(v)}.json`;
/** The Radicle repo id a vote is published to (its def repo). */
export const ridOf = (v) => {
  const r = RID_RE.test(String(v.repo || '')) ? String(v.repo) : DEFAULT_RIDS[v.kind];
  return r.startsWith('rad:') ? r : `rad:${r}`;
};

// ---------------------------------------------------------------------------------------------
// local store: <profile dir>/proposal_votes.json (sidecar of profile.json)

export function votesDir(profileFile = '') {
  if (profileFile) return path.dirname(profileFile);
  if (process.env.CHAOSD6_PROFILE_DIR) return process.env.CHAOSD6_PROFILE_DIR;
  if (process.env.CHAOSD6_USER_DATA_DIR) return process.env.CHAOSD6_USER_DATA_DIR;
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'chaosd6');
}
export const votesFile = (profileFile = '') => path.join(votesDir(profileFile), VOTES_FILE);
export const publishFile = (profileFile = '') => path.join(votesDir(profileFile), PUBLISH_FILE);

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
export function loadVotes(file = votesFile()) {
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { s = null; }
  const votes = [];
  for (const v of Object.values(s?.votes || {})) { try { votes.push(validateVote(v)); } catch { /* drop a damaged entry */ } }
  return votes;
}
export function saveVotes(votes, file = votesFile()) {
  writeJsonAtomic(file, { version: 1, votes: Object.fromEntries(dedupeVotes(votes).map(v => [`${v.key}#${v.voter}`, v])) });
}
export function loadPublishStatus(file = publishFile()) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { version: 1, repos: {}, ...s }; } catch { return { version: 1, repos: {} }; }
}
export const savePublishStatus = (s, file = publishFile()) => writeJsonAtomic(file, s);

/** Per vote (what the HUD shows):
 *    'saved'      stored in the profile; a publish is queued / running (or the vote is unsigned = local only)
 *    'published'  pushed to votes/<voter> and announced to the OCI seed
 *    'pending'    the last publish attempt after this vote failed (kept local, retried later; status error says why) */
export function publishStateOf(v, status) {
  if (!v.sig || !v.voter.startsWith('z6Mk')) return 'saved';
  const r = status?.repos?.[ridOf(v)];
  if (r && r.state === 'published' && r.upto && String(r.upto) >= String(v.at) && r.voter === v.voter) return 'published';
  if (r && r.state === 'pending' && r.at && String(r.at) >= String(v.at)) return 'pending';
  return 'saved';
}
/** Signed and not yet published (the publisher still owes it). */
export const needsPublish = (v, status) => !!v.sig && v.voter.startsWith('z6Mk') && publishStateOf(v, status) !== 'published';

// ---------------------------------------------------------------------------------------------
// who am I (voter identity + the names that make me "the author")

/** This device's voter identity: the profile's Radicle-sync key <profile dir>/radicle/identity.pem
 *  (created the same way profile-sync.mjs loadIdentity does, flag 'wx'), else peer:<fallbackId> (unsigned). */
export function voterIdentity(profileFile = '', fallbackId = '', { create = true } = {}) {
  const keyFile = path.join(votesDir(profileFile), 'radicle', 'identity.pem');
  try {
    if (create) {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      try { fs.writeFileSync(keyFile, generateIdentity().privateKeyPem, { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    const privateKeyPem = fs.readFileSync(keyFile, 'utf8');
    return { id: idFromPrivateKeyPem(privateKeyPem), privateKeyPem };
  } catch {
    return { id: `peer:${String(fallbackId || 'local').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120) || 'local'}`, privateKeyPem: null };
  }
}
/** My names: the given character name + team, every character / team name in profile.json, the Radicle alias. */
export function myHandles({ profileFile = '', name = '', team = '' } = {}) {
  const out = [name, team];
  try {
    const p = JSON.parse(fs.readFileSync(profileFile || path.join(votesDir(), 'profile.json'), 'utf8'));
    out.push(p.team_name, ...(p.characters || []).map(c => c.name));
  } catch {}
  try {
    const radHome = process.env.RAD_HOME || path.join(os.homedir(), '.radicle');
    out.push(JSON.parse(fs.readFileSync(path.join(radHome, 'config.json'), 'utf8'))?.node?.alias);
  } catch {}
  return [...new Set(out.map(h => clip(h, 60)).filter(Boolean))].slice(0, 12);
}
/** This device's Radicle node NID: the phone bridge.json `nid`, else $RAD_HOME/keys/radicle.pub (OpenSSH ed25519). */
let _nidCache;
export function localNodeNid({ radHome = process.env.RAD_HOME || path.join(os.homedir(), '.radicle'), bridgeFile = process.env.CHAOSD6_RADICLE_BRIDGE || '', fresh = false } = {}) {
  if (_nidCache !== undefined && !fresh) return _nidCache;
  let nid = null;
  try { const b = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')); if (NID_RE.test(String(b?.nid || ''))) nid = b.nid; } catch {}
  if (!nid) {
    try {
      const [type, b64] = fs.readFileSync(path.join(radHome, 'keys', 'radicle.pub'), 'utf8').trim().split(/\s+/);
      const blob = Buffer.from(b64, 'base64');
      if (type === 'ssh-ed25519' && blob.length >= 32) nid = idFromRawPublicKey(blob.subarray(blob.length - 32));
    } catch {}
  }
  if (!fresh) _nidCache = nid;
  return nid;
}
export function whoAmI({ profileFile = '', peerId = '', nid = '', name = '', team = '', create = false } = {}) {
  const id = voterIdentity(profileFile, peerId, { create });
  return { voter: id.id, nid: NID_RE.test(String(nid || '')) ? nid : localNodeNid(), handles: myHandles({ profileFile, name, team }), privateKeyPem: id.privateKeyPem };
}

/** Record MY vote (latest replaces earlier) in the local store; returns { vote, votes }. Refuses author votes. */
export function recordVote({ ref, value, comment = '', profileFile = '', name = '', team = '', nid = '', dimension = '', door = '', peerId = '', now = new Date() }) {
  const file = votesFile(profileFile);
  const target = normalizeTarget(ref);
  const me = whoAmI({ profileFile, peerId, nid, name, team, create: true });
  const why = authorConflict(target, me);
  if (why) fail('author', why);
  let v = { ...target, voter: me.voter, value, comment, at: now.toISOString(), voter_name: name, dimension, door,
    ...(me.nid ? { voter_nid: me.nid } : {}), voter_handles: me.handles };
  v = me.privateKeyPem ? signVote(me.privateKeyPem, v) : validateVote(v);
  const votes = upsertVote(loadVotes(file), v);
  saveVotes(votes, file);
  return { vote: v, votes };
}

/** What the UI shows: my vote per key + its publish state. */
export function myVotesForUI(votes, status = null) {
  return Object.fromEntries(dedupeVotes(votes).map(v => {
    const pub = publishStateOf(v, status);
    const r = status?.repos?.[ridOf(v)];
    return [v.key, { value: v.value, comment: v.comment, at: v.at, pub, ...(pub === 'pending' && r?.error ? { pub_error: r.error } : {}) }];
  }));
}

// ---------------------------------------------------------------------------------------------
// background publish (ruling 3) — debounced, one run at a time, retried with back-off while a vote is still owed.
//   desktop: a child process (proposal-votes-publish.mjs): git push rad votes/<voter> + rad sync --announce, OCI seed only
//   phone:   in process, POST to the in-app Radicle node bridge /publish (feature "votes"; publishAll({ via: 'bridge' }))
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proposal-votes-publish.mjs');
const _pub = { timer: null, running: false, again: false, retryMs: 0, ctx: null };
export const PUBLISH_DEBOUNCE_MS = 3000, RETRY_MIN_MS = 2 * 60e3, RETRY_MAX_MS = 15 * 60e3;
export function publishMode() {
  if (process.env.PV_PUBLISH === '0') return 'off';
  if (process.env.CHAOSD6_MOBILE === '1') return 'phone';
  return 'desktop';
}
/** Ask for a publish soon (debounced: a burst of votes = one publish). ctx: { profileFile, nid, notify(msg) }. → mode. */
export function schedulePublish(ctx = {}, delayMs = PUBLISH_DEBOUNCE_MS) {
  const mode = publishMode();
  if (mode === 'off') return mode;
  _pub.ctx = ctx;
  clearTimeout(_pub.timer);
  _pub.timer = setTimeout(() => { _pub.timer = null; _runPublish(_pub.ctx || ctx, mode); }, delayMs);
  _pub.timer.unref?.();
  return mode;
}
/** Test / shutdown hook: the scheduler's state (no timers left behind by the checks). */
export const publishScheduler = { get pending() { return !!_pub.timer; }, get running() { return _pub.running; }, get retryMs() { return _pub.retryMs; },
  cancel() { clearTimeout(_pub.timer); _pub.timer = null; _pub.again = false; } };
function _afterPublish(ctx) {
  _pub.running = false;
  try { ctx.notify?.(pvHello(ctx, { retry: false })); } catch {}
  if (_pub.again) { _pub.again = false; schedulePublish(ctx, 1000); return; }
  const status = loadPublishStatus(publishFile(ctx.profileFile));
  if (!loadVotes(votesFile(ctx.profileFile)).some(v => needsPublish(v, status))) { _pub.retryMs = 0; return; }
  _pub.retryMs = Math.min(RETRY_MAX_MS, _pub.retryMs ? _pub.retryMs * 2 : RETRY_MIN_MS);
  schedulePublish(ctx, _pub.retryMs);
}
function _runPublish(ctx, mode) {
  if (_pub.running) { _pub.again = true; return; }
  _pub.running = true;
  let done = false;
  const finish = () => { if (!done) { done = true; _afterPublish(ctx); } };
  if (mode === 'phone') {
    import('./proposal-votes-publish.mjs').then(m => m.publishAll({ profileFile: ctx.profileFile || '', via: 'bridge' })).catch(() => {}).finally(finish);
    return;
  }
  let child;
  try {
    child = spawn(process.execPath, [WORKER, '--profile-file', ctx.profileFile || '', ...(ctx.nid ? ['--nid', ctx.nid] : [])], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  } catch { finish(); return; }
  child.on('error', finish);
  child.on('exit', finish);
}

// ---------------------------------------------------------------------------------------------
// collections (ruling 4): everyone's votes as last collected from the local Radicle storage by the publisher
// (proposal-votes-publish.mjs collectAll) → <profile dir>/proposal_votes.collected.json { at, collections: {key: aggregate} }

export const collectedFile = (profileFile = '') => path.join(votesDir(profileFile), COLLECTED_FILE);
export function loadCollections(file = collectedFile()) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); if (s && s.collections && typeof s.collections === 'object') return s; } catch {}
  return { version: 1, at: null, collections: {} };
}
export function saveCollections(votes, file = collectedFile(), now = new Date()) {
  writeJsonAtomic(file, { version: 1, at: now.toISOString(), collections: aggregateAll(votes) });
}
/** The collection of one def version (ref) from the cache: { n, mean, review, … } or the empty collection. */
export function collectionOf(ref, profileFile = '') {
  let key; try { key = voteKey(normalizeTarget(ref)); } catch { return aggregate([]); }
  const a = loadCollections(collectedFile(profileFile)).collections[key];
  return a ? { ...a, review: reviewFlag(a) } : aggregate([]);   // review re-derived: never trust a cached flag
}
/** HUD summary: { <key>: { n, mean, review } }. */
export function collectionsForUI(profileFile = '') {
  const c = loadCollections(collectedFile(profileFile)).collections;
  return Object.fromEntries(Object.entries(c).map(([k, a]) => [k, { n: a?.n | 0, mean: a?.mean ?? null, review: reviewFlag(a) }]));
}
/** Wrap a creation validator (def, ref) → verdict: the verdict itself (±10 % tolerance) is untouched; the players'
 *  collection only adds { votes: {n, mean}, review } (review only when n ≥ 10 and mean ≤ −3). */
export function validatorWithVotes(validate, { profileFile = '' } = {}) {
  return (def, ref, ...rest) => verdictWithVotes(validate(def, ref, ...rest), ref ? collectionOf(ref, profileFile) : null);
}

// ---------------------------------------------------------------------------------------------
// peer.mjs glue (UI WebSocket). ctx = { profileFile, name, team, nid, dimension, door, peerId, notify }.
//   { kind: 'proposal_vote', ref, value, comment } → { kind: 'proposal_vote_saved', ok, key, error?, code?, mine, publish }
//   hello add-on: { kind: 'proposal_votes', mine, me, collections, limits, publish }. No game state is touched.
export function pvHandle(m, ctx = {}) {
  try {
    const { vote, votes } = recordVote({ ref: m.ref, value: Number(m.value), comment: m.comment, ...ctx });
    const mode = vote.sig ? schedulePublish(ctx) : 'local';
    return { kind: 'proposal_vote_saved', ok: true, key: vote.key, publish: mode, mine: myVotesForUI(votes, loadPublishStatus(publishFile(ctx.profileFile))) };
  } catch (e) {
    let key = null; try { key = normalizeTarget(m.ref).key; } catch {}
    return { kind: 'proposal_vote_saved', ok: false, key, code: e.code || null, error: e instanceof VoteError ? e.message : `vote not saved: ${e.message}` };
  }
}
export function pvHello(ctx = {}, { retry = true } = {}) {
  const votes = loadVotes(votesFile(ctx.profileFile));
  const status = loadPublishStatus(publishFile(ctx.profileFile));
  const mine = myVotesForUI(votes, status);
  if (retry && votes.some(v => needsPublish(v, status)) && !_pub.timer && !_pub.running) schedulePublish(ctx, 10e3);   // owed from an earlier run
  const me = whoAmI({ ...ctx, create: false });
  return { kind: 'proposal_votes', mine, me: { voter: me.voter, nid: me.nid, handles: me.handles }, publish: publishMode(),
    collections: collectionsForUI(ctx.profileFile),
    limits: { min: VALUE_MIN, max: VALUE_MAX, comment_max: COMMENT_MAX, review_min_votes: REVIEW_MIN_VOTES, review_mean_max: REVIEW_MEAN_MAX } };
}

// ---------------------------------------------------------------------------------------------
// git side (plain git CLI). publishVotesCommit = local commit only; pushing is proposal-votes-publish.mjs.

const git = (args, gitdir, input) => execFileSync('git', ['--git-dir', gitdir, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

/** Write my signed votes for this repo as one commit on refs/heads/votes/<voter> of `gitdir` (a clone's
 *  .git or a bare repo), replacing the branch's tree (all my votes = the whole tree). Returns the commit oid,
 *  or null when nothing changed. Unsigned / foreign-voter / other-repo votes are skipped (`repo` matches
 *  vote.repo or its rid; omit it to take all). */
export function publishVotesCommit({ gitdir, votes, repo = null, voter, message = 'proposal votes' }) {
  const mine = dedupeVotes(votes).filter(v => v.voter === voter && (!repo || v.repo === repo || ridOf(v) === repo) && verifyVote(v));
  const byId = new Map();
  for (const v of mine) {
    const blob = git(['hash-object', '-w', '--stdin'], gitdir, canonicalJson(v) + '\n');
    const [, id, fileName] = votePath(v).split('/');
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(`100644 blob ${blob}\t${fileName}`);
  }
  const idTrees = [...byId.keys()].sort().map(id => `040000 tree ${git(['mktree'], gitdir, byId.get(id).sort().join('\n') + '\n')}\t${id}`);
  const votesTree = git(['mktree'], gitdir, idTrees.join('\n') + (idTrees.length ? '\n' : ''));
  const root = git(['mktree'], gitdir, `040000 tree ${votesTree}\tvotes\n`);
  const ref = `refs/heads/${voteBranch(voter)}`;
  let parent = null;
  try { parent = git(['rev-parse', '--verify', '-q', ref], gitdir); } catch { parent = null; }
  if (parent && git(['rev-parse', `${parent}^{tree}`], gitdir) === root) return null;
  const env = { ...process.env, GIT_AUTHOR_NAME: voter, GIT_AUTHOR_EMAIL: `${voter}@chaosd6`, GIT_COMMITTER_NAME: voter, GIT_COMMITTER_EMAIL: `${voter}@chaosd6` };
  const commit = execFileSync('git', ['--git-dir', gitdir, 'commit-tree', root, ...(parent ? ['-p', parent] : []), '-m', message], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['update-ref', ref, commit, ...(parent ? [parent] : [])], gitdir);
  return commit;
}

/** Every vote on every votes/<voter> branch of `gitdir` (Radicle storage: refs/namespaces/<nid>/refs/heads/votes/*,
 *  a working clone: refs/heads/votes/*, refs/remotes/<r>/votes/*). Keeps only valid signed votes whose signer is the
 *  branch's <voter>, and drops AUTHOR votes (ruling 1): self-declared (validateVote), or the vote branch's Radicle
 *  namespace — or the voter / voter_nid — owns the def's branch players/<who>/<slug> in this storage, or is the
 *  ref's `ns`. `authors`: optional { <def branch>: [nid…] } known from elsewhere (handshake refs).
 *  → { votes (deduped), rejected: [{ ref, path, why }] }. */
export function collectVotesFromGit({ gitdir, authors = {} }) {
  const all = git(['for-each-ref', '--format=%(refname)', 'refs/namespaces/', 'refs/heads/', 'refs/remotes/'], gitdir).split('\n').filter(Boolean);
  const owners = new Map();   // def branch → Set(nid) owning it
  const own = (b, nid) => { if (!owners.has(b)) owners.set(b, new Set()); owners.get(b).add(nid); };
  for (const r of all) { const m = /^refs\/namespaces\/([^/]+)\/refs\/heads\/(players\/.+)$/.exec(r); if (m) own(m[2], m[1]); }
  for (const [b, nids] of Object.entries(authors || {})) for (const n of nids || []) own(b, n);
  const refs = all.filter(r => /(^|\/)refs\/heads\/votes\/[^/]+$/.test(r) || /^refs\/remotes\/[^/]+\/votes\/[^/]+$/.test(r));
  const votes = [], rejected = [];
  for (const ref of refs) {
    const voter = ref.split('/').pop();
    const ns = /^refs\/namespaces\/([^/]+)\//.exec(ref)?.[1] || null;
    const files = git(['ls-tree', '-r', '--name-only', ref, '--', 'votes/'], gitdir).split('\n').filter(Boolean);
    for (const f of files) {
      let v;
      try { v = parseVote(git(['show', `${ref}:${f}`], gitdir)); } catch (e) { rejected.push({ ref, path: f, why: e.message }); continue; }
      if (v.voter !== voter) { rejected.push({ ref, path: f, why: `voter ${v.voter} on ${voter}'s branch` }); continue; }
      if (!verifyVote(v)) { rejected.push({ ref, path: f, why: 'bad signature' }); continue; }
      if (votePath(v) !== f) { rejected.push({ ref, path: f, why: 'file name does not match the vote' }); continue; }
      const o = owners.get(v.branch) || new Set();
      if (v.ns) o.add(v.ns);
      if ([ns, v.voter, v.voter_nid].some(x => x && o.has(x))) { rejected.push({ ref, path: f, why: `author vote (${v.branch} belongs to this voter)` }); continue; }
      votes.push(v);
    }
  }
  return { votes: dedupeVotes(votes), rejected };
}
