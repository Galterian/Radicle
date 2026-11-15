// chaosD6-Effects loader (program E3, user-approved 2026-11-15).
// Effects are data: one JSON definition per file, effects/<id>.json, in the Radicle repo
// chaosD6-Effects (`main` = built-in effects, `players/<nid-or-name>/<effect-slug>` = player
// proposals). Peers tell each other which effects they play by REF, never by name alone:
//
//   ref = { repo, branch, commit, sha256, id }
//     repo    RID of the effects repo ('rad:z…'; '' = the default EFFECTS_RID)
//     branch  branch the definition was taken from (informational; commit is what counts)
//     commit  40-hex commit oid the file was read at
//     sha256  hex sha256 of canonicalJson(definition) — the identity of the effect
//     id      definition.id (also the file name: effects/<id>.json)
//
// A definition is accepted only if effectHash(def) === ref.sha256 and def.id === ref.id, so a
// fetch from anyone (OCI httpd, a libp2p peer, a local clone) is safe to cache. The cache is
// content addressed: <cacheDir>/<sha256>.json (canonical JSON).
//   desktop  $XDG_DATA_HOME/chaosd6/effects   (default ~/.local/share/chaosd6/effects)
//   mobile   $CHAOSD6_USER_DATA_DIR/effects   (Godot user://data = <filesDir>/data)
//   override $CHAOSD6_EFFECTS_CACHE (tests)
//
// Node 18 compatible: global fetch + AbortSignal.timeout, node:crypto, isomorphic-git (pure JS,
// same as profile-sync.mjs) with plain `git` as the desktop fallback.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// TODO(E3/E4): set once `rad init` has created chaosD6-Effects (game/tools/out/effects-rad-init.sh
// prints it). Until then refs must carry `repo` or CHAOSD6_EFFECTS_RID must be set.
export const EFFECTS_RID = process.env.CHAOSD6_EFFECTS_RID || 'rad:TODO_EFFECTS_RID';
export const DEFAULT_SEED_HOST = '92-5-138-121.sslip.io';
export const EFFECTS_SUBDIR = 'effects';
export const MAIN_BRANCH = 'main';
export const PLAYER_BRANCH_PREFIX = 'players/';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;   // file-name safe: no '/', no '..' prefix
const SHA_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export class EffectRefError extends Error {
  constructor(code, message) { super(message); this.name = 'EffectRefError'; this.code = code; }
}

// ---------------------------------------------------------------------------
// canonical JSON + hash
// ---------------------------------------------------------------------------

/** Canonical JSON: object keys sorted (UTF-16 code unit order), no whitespace, arrays kept in
 *  order. Rejects values JSON cannot round-trip (undefined, functions, NaN/Infinity, BigInt). */
export function canonicalJson(value) {
  const out = (v, where) => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string': return JSON.stringify(v);
      case 'boolean': return v ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number at ${where}`);
        return JSON.stringify(v);   // -0 → "0", shortest round-trip form
      case 'object': {
        if (Array.isArray(v)) return `[${v.map((x, i) => out(x, `${where}[${i}]`)).join(',')}]`;
        const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${out(v[k], `${where}.${k}`)}`).join(',')}}`;
      }
      default: throw new TypeError(`canonicalJson: unsupported ${typeof v} at ${where}`);
    }
  };
  return out(value, '$');
}

export const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** sha256 (hex) of the canonical JSON of an effect definition — key order and whitespace never matter. */
export const effectHash = (def) => sha256Hex(canonicalJson(def));

export function assertEffectId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new EffectRefError('bad-id', `invalid effect id ${JSON.stringify(id)}`);
  return id;
}

/** Path of a definition inside the repo: effects/<id>.json */
export const effectPath = (id) => `${EFFECTS_SUBDIR}/${assertEffectId(id)}.json`;

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

export function effectRef(def, { repo = EFFECTS_RID, branch = MAIN_BRANCH, commit } = {}) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) throw new EffectRefError('bad-def', 'definition must be an object');
  return { repo: String(repo || ''), branch: String(branch || ''), commit: String(commit || ''), sha256: effectHash(def), id: assertEffectId(def.id) };
}

/** Validate the shape of a ref received from the network; returns a normalised copy. */
export function parseEffectRef(ref) {
  if (!ref || typeof ref !== 'object') throw new EffectRefError('bad-ref', 'ref must be an object');
  const r = { repo: String(ref.repo || ''), branch: String(ref.branch || ''), commit: String(ref.commit || '').toLowerCase(),
    sha256: String(ref.sha256 || '').toLowerCase(), id: assertEffectId(ref.id) };
  if (!SHA_RE.test(r.sha256)) throw new EffectRefError('bad-ref', `ref ${r.id}: sha256 must be 64 hex`);
  if (r.commit && !COMMIT_RE.test(r.commit)) throw new EffectRefError('bad-ref', `ref ${r.id}: commit must be 40 hex`);
  if (r.repo && !/^(rad:)?z[1-9A-HJ-NP-Za-km-z]+$/.test(r.repo) && r.repo !== EFFECTS_RID) throw new EffectRefError('bad-ref', `ref ${r.id}: bad repo ${r.repo}`);
  return r;
}

export const isPlayerBranch = (b) => typeof b === 'string' && b.startsWith(PLAYER_BRANCH_PREFIX) && b.split('/').length >= 3;

/** Throws unless `def` is exactly what `ref` names. */
export function verifyEffect(def, ref) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) throw new EffectRefError('bad-def', `ref ${ref.id}: fetched definition is not an object`);
  const got = effectHash(def);
  if (got !== ref.sha256) throw new EffectRefError('sha-mismatch', `ref ${ref.id}: sha256 mismatch (want ${ref.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
  if (def.id !== ref.id) throw new EffectRefError('id-mismatch', `ref ${ref.id}: definition id is ${JSON.stringify(def.id)}`);
  return def;
}

// ---------------------------------------------------------------------------
// manifest (index.json in the repo)
// ---------------------------------------------------------------------------

/** { format: 1, effects: { <id>: <sha256> } } with ids sorted — written as index.json. */
export function buildManifest(defs) {
  const effects = {};
  for (const d of [...defs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    assertEffectId(d.id);
    if (effects[d.id]) throw new EffectRefError('dup-id', `duplicate effect id ${d.id}`);
    effects[d.id] = effectHash(d);
  }
  return { format: 1, hash: 'sha256(canonical-json)', effects };
}

// ---------------------------------------------------------------------------
// cache (content addressed)
// ---------------------------------------------------------------------------

export function effectsCacheDir() {
  if (process.env.CHAOSD6_EFFECTS_CACHE) return process.env.CHAOSD6_EFFECTS_CACHE;
  if (process.env.CHAOSD6_USER_DATA_DIR) return path.join(process.env.CHAOSD6_USER_DATA_DIR, 'effects');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'chaosd6', 'effects');
}

export function createEffectCache({ dir = effectsCacheDir() } = {}) {
  const file = (sha) => {
    if (!SHA_RE.test(sha)) throw new EffectRefError('bad-ref', `bad sha256 ${sha}`);
    return path.join(dir, `${sha}.json`);
  };
  const stats = { hits: 0, misses: 0, puts: 0, corrupt: 0 };
  return {
    dir, stats, path: file,
    has: (sha) => fs.existsSync(file(sha)),
    /** Definition for `sha`, or null. A file whose content no longer hashes to its name is deleted. */
    get(sha) {
      const f = file(sha);
      let txt;
      try { txt = fs.readFileSync(f, 'utf8'); } catch { stats.misses++; return null; }
      try {
        const def = JSON.parse(txt);
        if (effectHash(def) === sha) { stats.hits++; return def; }
      } catch {}
      stats.corrupt++; stats.misses++;
      try { fs.unlinkSync(f); } catch {}
      return null;
    },
    /** Store a definition under its own hash (atomic rename); returns the sha256. */
    put(def) {
      const txt = canonicalJson(def); const sha = sha256Hex(txt); const f = file(sha);
      if (!fs.existsSync(f)) {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, txt); fs.renameSync(tmp, f);
      }
      stats.puts++;
      return sha;
    },
  };
}

let _defaultCache = null;
const defaultCache = () => (_defaultCache ||= createEffectCache());

/**
 * Definition named by `ref`: cache → else `fetch(ref)` (E4 plugs libp2p / Radicle / httpd
 * fetchers in; may be an array tried in order) → verify sha256 + id → cache. Concurrent calls for
 * the same sha share one fetch. Throws EffectRefError ('sha-mismatch', 'not-found', …).
 */
const inflight = new Map();
export async function getEffectByRef(ref, { cache = defaultCache(), fetch: fetcher = null } = {}) {
  const r = parseEffectRef(ref);
  const hit = cache.get(r.sha256);
  if (hit) return verifyEffect(hit, r);
  const fetchers = (Array.isArray(fetcher) ? fetcher : [fetcher]).filter(Boolean);
  if (!fetchers.length) throw new EffectRefError('not-found', `effect ${r.id} (${r.sha256.slice(0, 12)}…) not cached and no fetcher`);
  const key = `${cache.dir}|${r.sha256}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const errors = [];
    for (const f of fetchers) {
      try {
        let def = await f(r);
        if (def == null) continue;
        if (typeof def === 'string' || Buffer.isBuffer(def) || def instanceof Uint8Array) def = JSON.parse(Buffer.from(def).toString('utf8'));
        verifyEffect(def, r);
        cache.put(def);
        return def;
      } catch (e) { errors.push(e); }
    }
    const mism = errors.find(e => e?.code === 'sha-mismatch' || e?.code === 'id-mismatch');
    if (mism) throw mism;
    throw new EffectRefError('not-found', `effect ${r.id} (${r.sha256.slice(0, 12)}…): ${errors.map(e => e?.message || e).join('; ') || 'no fetcher had it'}`);
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// reading a pinned commit from a git repo (local clone / Radicle working copy / storage)
// ---------------------------------------------------------------------------

let _iso = null;
async function isoGit() {
  if (_iso === null) { try { _iso = (await import('isomorphic-git')).default; } catch { _iso = false; } }
  return _iso || null;
}

function gitCli(args, cwdOrGitdir, isGitdir) {
  const base = isGitdir ? ['--git-dir', cwdOrGitdir] : ['-C', cwdOrGitdir];
  return execFileSync('git', [...base, ...args], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
}

async function readCommitFiles({ dir, gitdir, commit, subdir, engine }) {
  const useIso = engine !== 'git' && (await isoGit());
  if (engine === 'isomorphic' && !useIso) throw new Error('isomorphic-git not available');
  if (useIso) {
    const git = useIso;
    const opts = { fs, ...(dir ? { dir } : {}), ...(gitdir ? { gitdir } : {}) };
    const oid = COMMIT_RE.test(commit) ? commit : await git.resolveRef({ ...opts, ref: commit });
    const { commit: c } = await git.readCommit({ ...opts, oid });
    let tree = [];
    try { tree = (await git.readTree({ ...opts, oid: c.tree, filepath: subdir })).tree; }
    catch (e) { if (e?.code !== 'NotFoundError') throw e; }
    const files = [];
    for (const e of tree) {
      if (e.type !== 'blob' || !e.path.endsWith('.json')) continue;
      const { blob } = await git.readBlob({ ...opts, oid: e.oid });
      files.push({ name: e.path, text: Buffer.from(blob).toString('utf8') });
    }
    return { commit: oid, files };
  }
  const where = gitdir || dir; const isGd = !!gitdir;
  const oid = gitCli(['rev-parse', '--verify', `${commit}^{commit}`], where, isGd).toString().trim();
  let ls = '';
  try { ls = gitCli(['ls-tree', '-z', `${oid}:${subdir}`], where, isGd).toString(); } catch { ls = ''; }
  const files = [];
  for (const line of ls.split('\0').filter(Boolean)) {
    const m = /^\d+ (\w+) ([0-9a-f]+)\t(.+)$/.exec(line);
    if (!m || m[1] !== 'blob' || !m[3].endsWith('.json')) continue;
    files.push({ name: m[3], text: gitCli(['cat-file', 'blob', m[2]], where, isGd).toString('utf8') });
  }
  return { commit: oid, files };
}

/**
 * Every effects/<id>.json at a pinned commit.
 *   { dir | gitdir, commit = 'HEAD' (oid or ref name), repo, branch, subdir = 'effects',
 *     engine = 'auto' | 'isomorphic' | 'git', cache (optional: store each definition) }
 * → { commit, effects: { <id>: def }, refs: { <id>: ref }, errors: [{ file, error }] }
 * A file whose `id` does not match its name is reported in `errors`, not loaded.
 */
export async function loadEffectsFrom({ dir = null, gitdir = null, commit = 'HEAD', repo = EFFECTS_RID, branch = '',
  subdir = EFFECTS_SUBDIR, engine = 'auto', cache = null } = {}) {
  if (!dir && !gitdir) throw new Error('loadEffectsFrom: dir or gitdir required');
  const { commit: oid, files } = await readCommitFiles({ dir, gitdir, commit, subdir, engine });
  const effects = {}; const refs = {}; const errors = [];
  for (const { name, text } of files.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    try {
      const def = JSON.parse(text);
      assertEffectId(def?.id);
      if (`${def.id}.json` !== name) throw new EffectRefError('id-mismatch', `id ${def.id} in ${name}`);
      effects[def.id] = def;
      refs[def.id] = effectRef(def, { repo, branch: branch || (COMMIT_RE.test(commit) ? '' : commit), commit: oid });
      if (cache) cache.put(def);
    } catch (e) { errors.push({ file: `${subdir}/${name}`, error: e.message }); }
  }
  return { commit: oid, effects, refs, errors };
}

// ---------------------------------------------------------------------------
// fetchers for getEffectByRef
// ---------------------------------------------------------------------------

/** Read effects/<id>.json at ref.commit from a local git repo (desktop clone or Radicle storage). */
export function gitEffectFetcher({ dir = null, gitdir = null, engine = 'auto' } = {}) {
  return async (ref) => {
    if (!ref.commit) return null;
    const useIso = engine !== 'git' && (await isoGit());
    if (useIso) {
      const opts = { fs, ...(dir ? { dir } : {}), ...(gitdir ? { gitdir } : {}) };
      try {
        const { blob } = await useIso.readBlob({ ...opts, oid: ref.commit, filepath: effectPath(ref.id) });
        return Buffer.from(blob).toString('utf8');
      } catch (e) { if (e?.code === 'NotFoundError') return null; throw e; }
    }
    try { return gitCli(['show', `${ref.commit}:${effectPath(ref.id)}`], gitdir || dir, !!gitdir).toString('utf8'); }
    catch { return null; }
  };
}

/** radicle-httpd (phone / any host without git): GET <seed>/api/v1/repos/<rid>/blob/<commit>/effects/<id>.json
 *  — same request style as join-plan.mjs httpdClient. `fetchImpl` is injectable for tests. */
export function httpdEffectFetcher({ seedHost = DEFAULT_SEED_HOST, rid = EFFECTS_RID, timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const origin = (/^https?:\/\//.test(seedHost) ? seedHost : `https://${seedHost}`).replace(/\/+$/, '');
  return async (ref) => {
    if (!ref.commit) return null;
    const repo = ref.repo || rid;
    const r = await fetchImpl(`${origin}/api/v1/repos/${repo.startsWith('rad:') ? repo : `rad:${repo}`}/blob/${ref.commit}/${effectPath(ref.id)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${ref.id}@${ref.commit.slice(0, 8)}`);
    const body = await r.json();
    if (body?.binary) throw new Error(`${ref.id}: httpd says binary`);
    return String(body?.content ?? '');
  };
}
