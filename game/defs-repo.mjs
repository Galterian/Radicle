// Kind-parameterised core of the chaosD6 definition repos (program E3 effects, program S3 skills).
// A "defs repo" is a Radicle git repo holding one JSON definition per file, <subdir>/<id>.json
// (`main` = built-ins, `players/<nid-or-name>/<slug>` = player proposals). Peers name a
// definition by REF, never by name alone:
//
//   ref = { repo, branch, commit, sha256, id }
//     repo    RID of the repo ('rad:z…'; '' = the kind's default RID)
//     branch  branch the definition was taken from (informational; commit is what counts)
//     commit  40-hex commit oid the file was read at
//     sha256  hex sha256 of canonicalJson(definition) — the identity of the definition
//     id      definition.id (also the file name: <subdir>/<id>.json)
//
// A definition is accepted only if hash(def) === ref.sha256 and def.id === ref.id, so a fetch
// from anyone (OCI httpd, a libp2p peer, a local clone) is safe to cache. The cache is content
// addressed: <cacheDir>/<sha256>.json (canonical JSON).
//
//   const repo = createDefsRepo({ kind: 'skill', subdir: 'skills', rid, cacheEnv: 'CHAOSD6_SKILLS_CACHE' });
//   repo.hash / ref / parseRef / verify / buildManifest / cacheDir / createCache / getByRef /
//   loadFrom / gitFetcher / httpdFetcher / assertId / path / RefError
//
// game/effects-repo.mjs and game/skills-repo.mjs are thin named-export wrappers over this.
// Node 18 compatible: global fetch + AbortSignal.timeout, node:crypto, isomorphic-git (pure JS,
// same as profile-sync.mjs) with plain `git` as the desktop fallback.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const DEFAULT_SEED_HOST = '92-5-138-121.sslip.io';
export const MAIN_BRANCH = 'main';
export const PLAYER_BRANCH_PREFIX = 'players/';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;   // file-name safe: no '/', no '..' prefix
export const SHA_RE = /^[0-9a-f]{64}$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const RID_RE = /^(rad:)?z[1-9A-HJ-NP-Za-km-z]+$/;

/** Base class of every kind's ref error (EffectRefError, SkillRefError, …); `.code` is the contract. */
export class DefsRefError extends Error {
  constructor(code, message) { super(message); this.name = 'DefsRefError'; this.code = code; }
}
/** A named subclass, e.g. makeRefError('EffectRefError'): instances have that .name and are instanceof DefsRefError. */
export function makeRefError(name) {
  return ({ [name]: class extends DefsRefError { constructor(code, message) { super(code, message); this.name = name; } } })[name];
}

// ---------------------------------------------------------------------------
// canonical JSON + hash (kind independent: the same bytes hash the same everywhere)
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

/** sha256 (hex) of the canonical JSON of a definition — key order and whitespace never matter. */
export const defHash = (def) => sha256Hex(canonicalJson(def));

export const isPlayerBranch = (b) => typeof b === 'string' && b.startsWith(PLAYER_BRANCH_PREFIX) && b.split('/').length >= 3;

/** Cache dir by convention: $<cacheEnv> → $CHAOSD6_USER_DATA_DIR/<sub> (phone: Godot user://data =
 *  <filesDir>/data) → $XDG_DATA_HOME/chaosd6/<sub> (default ~/.local/share/chaosd6/<sub>). */
export function cacheDirFor(cacheEnv, sub) {
  if (cacheEnv && process.env[cacheEnv]) return process.env[cacheEnv];
  if (process.env.CHAOSD6_USER_DATA_DIR) return path.join(process.env.CHAOSD6_USER_DATA_DIR, sub);
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'chaosd6', sub);
}

// ---------------------------------------------------------------------------
// git access (shared by every kind)
// ---------------------------------------------------------------------------

let _iso = null;
export async function isoGit() {
  if (_iso === null) { try { _iso = (await import('isomorphic-git')).default; } catch { _iso = false; } }
  return _iso || null;
}

function gitCli(args, cwdOrGitdir, isGitdir) {
  const base = isGitdir ? ['--git-dir', cwdOrGitdir] : ['-C', cwdOrGitdir];
  return execFileSync('git', [...base, ...args], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
}

/** Every <subdir>/*.json blob at `commit` → { commit: oid, files: [{ name, text }] }. */
export async function readCommitFiles({ dir, gitdir, commit, subdir, engine }) {
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

// in-flight fetches, keyed by cache dir + sha (shared across kinds: a sha is a sha)
const inflight = new Map();

// ---------------------------------------------------------------------------
// the kind-parameterised repo
// ---------------------------------------------------------------------------

/**
 * createDefsRepo({
 *   kind        'effect' | 'skill' | 'skill lib' … — the noun used in error messages
 *   subdir      directory of the definitions inside the repo ('effects', 'skills', 'lib')
 *   manifestKey key of the id → sha256 map in index.json (default subdir)
 *   rid         default RID (string, may be a 'rad:TODO_…' placeholder until `rad init`)
 *   cacheEnv    env var overriding the cache dir (tests), e.g. 'CHAOSD6_EFFECTS_CACHE'
 *   cacheSubdir cache dir leaf (default subdir)
 *   RefError    error class to throw (default makeRefError(<Kind>RefError))
 *   loadName    function name used in the loadFrom usage error
 * })
 */
export function createDefsRepo({ kind, subdir, manifestKey = subdir, rid = '', cacheEnv = null, cacheSubdir = subdir,
  RefError = null, loadName = 'loadFrom' } = {}) {
  if (!kind || !subdir) throw new Error('createDefsRepo: kind and subdir required');
  const Err = RefError || makeRefError(`${kind.replace(/(^|\s)(\w)/g, (_, s, c) => c.toUpperCase())}RefError`);
  const RID = rid;

  function assertId(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Err('bad-id', `invalid ${kind} id ${JSON.stringify(id)}`);
    return id;
  }
  /** Path of a definition inside the repo: <subdir>/<id>.json */
  const defPath = (id, sub = subdir) => `${sub}/${assertId(id)}.json`;

  function ref(def, { repo = RID, branch = MAIN_BRANCH, commit } = {}) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Err('bad-def', 'definition must be an object');
    return { repo: String(repo || ''), branch: String(branch || ''), commit: String(commit || ''), sha256: defHash(def), id: assertId(def.id) };
  }

  /** Validate the shape of a ref received from the network; returns a normalised copy. */
  function parseRef(r0) {
    if (!r0 || typeof r0 !== 'object') throw new Err('bad-ref', 'ref must be an object');
    const r = { repo: String(r0.repo || ''), branch: String(r0.branch || ''), commit: String(r0.commit || '').toLowerCase(),
      sha256: String(r0.sha256 || '').toLowerCase(), id: assertId(r0.id) };
    if (!SHA_RE.test(r.sha256)) throw new Err('bad-ref', `ref ${r.id}: sha256 must be 64 hex`);
    if (r.commit && !COMMIT_RE.test(r.commit)) throw new Err('bad-ref', `ref ${r.id}: commit must be 40 hex`);
    if (r.repo && !RID_RE.test(r.repo) && r.repo !== RID) throw new Err('bad-ref', `ref ${r.id}: bad repo ${r.repo}`);
    return r;
  }

  /** Throws unless `def` is exactly what `ref` names. */
  function verify(def, r) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Err('bad-def', `ref ${r.id}: fetched definition is not an object`);
    const got = defHash(def);
    if (got !== r.sha256) throw new Err('sha-mismatch', `ref ${r.id}: sha256 mismatch (want ${r.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
    if (def.id !== r.id) throw new Err('id-mismatch', `ref ${r.id}: definition id is ${JSON.stringify(def.id)}`);
    return def;
  }

  const sortedMap = (defs, what) => {
    const m = {};
    for (const d of [...defs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      assertId(d.id);
      if (m[d.id]) throw new Err('dup-id', `duplicate ${what} id ${d.id}`);
      m[d.id] = defHash(d);
    }
    return m;
  };
  /** { format: 1, hash, <manifestKey>: { <id>: <sha256> } [, lib: { <id>: <sha256> }] } — index.json.
   *  `lib` appears only when `libs` is given (skills repo). */
  function buildManifest(defs, { libs = null } = {}) {
    const m = { format: 1, hash: 'sha256(canonical-json)', [manifestKey]: sortedMap(defs, kind) };
    if (libs) m.lib = sortedMap(libs, `${kind} lib`);
    return m;
  }

  const cacheDir = () => cacheDirFor(cacheEnv, cacheSubdir);

  function createCache({ dir = cacheDir() } = {}) {
    const file = (sha) => {
      if (!SHA_RE.test(sha)) throw new Err('bad-ref', `bad sha256 ${sha}`);
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
          if (defHash(def) === sha) { stats.hits++; return def; }
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
  const defaultCache = () => (_defaultCache ||= createCache());

  /**
   * Definition named by `ref`: cache → else `fetch(ref)` (may be an array tried in order) →
   * verify sha256 + id → cache. Concurrent calls for the same sha share one fetch.
   * Throws RefError ('sha-mismatch', 'not-found', …).
   */
  async function getByRef(r0, { cache = defaultCache(), fetch: fetcher = null } = {}) {
    const r = parseRef(r0);
    const hit = cache.get(r.sha256);
    if (hit) return verify(hit, r);
    const fetchers = (Array.isArray(fetcher) ? fetcher : [fetcher]).filter(Boolean);
    if (!fetchers.length) throw new Err('not-found', `${kind} ${r.id} (${r.sha256.slice(0, 12)}…) not cached and no fetcher`);
    const key = `${cache.dir}|${r.sha256}`;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const errors = [];
      for (const f of fetchers) {
        try {
          let def = await f(r);
          if (def == null) continue;
          if (typeof def === 'string' || Buffer.isBuffer(def) || def instanceof Uint8Array) def = JSON.parse(Buffer.from(def).toString('utf8'));
          verify(def, r);
          cache.put(def);
          return def;
        } catch (e) { errors.push(e); }
      }
      const mism = errors.find(e => e?.code === 'sha-mismatch' || e?.code === 'id-mismatch');
      if (mism) throw mism;
      throw new Err('not-found', `${kind} ${r.id} (${r.sha256.slice(0, 12)}…): ${errors.map(e => e?.message || e).join('; ') || 'no fetcher had it'}`);
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /**
   * Every <subdir>/<id>.json at a pinned commit.
   *   { dir | gitdir, commit = 'HEAD' (oid or ref name), repo, branch, subdir, engine = 'auto' | 'isomorphic' | 'git', cache }
   * → { commit, defs: { <id>: def }, refs: { <id>: ref }, errors: [{ file, error }] }
   * A file whose `id` does not match its name is reported in `errors`, not loaded.
   */
  async function loadFrom({ dir = null, gitdir = null, commit = 'HEAD', repo = RID, branch = '',
    subdir: sub = subdir, engine = 'auto', cache = null } = {}) {
    if (!dir && !gitdir) throw new Error(`${loadName}: dir or gitdir required`);
    const { commit: oid, files } = await readCommitFiles({ dir, gitdir, commit, subdir: sub, engine });
    const defs = {}; const refs = {}; const errors = [];
    for (const { name, text } of files.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      try {
        const def = JSON.parse(text);
        assertId(def?.id);
        if (`${def.id}.json` !== name) throw new Err('id-mismatch', `id ${def.id} in ${name}`);
        defs[def.id] = def;
        refs[def.id] = ref(def, { repo, branch: branch || (COMMIT_RE.test(commit) ? '' : commit), commit: oid });
        if (cache) cache.put(def);
      } catch (e) { errors.push({ file: `${sub}/${name}`, error: e.message }); }
    }
    return { commit: oid, defs, refs, errors };
  }

  /** Read <subdir>/<id>.json at ref.commit from a local git repo (desktop clone or Radicle storage). */
  function gitFetcher({ dir = null, gitdir = null, engine = 'auto' } = {}) {
    return async (r) => {
      if (!r.commit) return null;
      const useIso = engine !== 'git' && (await isoGit());
      if (useIso) {
        const opts = { fs, ...(dir ? { dir } : {}), ...(gitdir ? { gitdir } : {}) };
        try {
          const { blob } = await useIso.readBlob({ ...opts, oid: r.commit, filepath: defPath(r.id) });
          return Buffer.from(blob).toString('utf8');
        } catch (e) { if (e?.code === 'NotFoundError') return null; throw e; }
      }
      try { return gitCli(['show', `${r.commit}:${defPath(r.id)}`], gitdir || dir, !!gitdir).toString('utf8'); }
      catch { return null; }
    };
  }

  /** radicle-httpd (phone / any host without git): GET <seed>/api/v1/repos/<rid>/blob/<commit>/<subdir>/<id>.json
   *  — same request style as join-plan.mjs httpdClient. `fetchImpl` is injectable for tests. */
  function httpdFetcher({ seedHost = DEFAULT_SEED_HOST, rid: defRid = RID, timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
    const origin = (/^https?:\/\//.test(seedHost) ? seedHost : `https://${seedHost}`).replace(/\/+$/, '');
    return async (r) => {
      if (!r.commit) return null;
      const repo = r.repo || defRid;
      const res = await fetchImpl(`${origin}/api/v1/repos/${repo.startsWith('rad:') ? repo : `rad:${repo}`}/blob/${r.commit}/${defPath(r.id)}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${r.id}@${r.commit.slice(0, 8)}`);
      const body = await res.json();
      if (body?.binary) throw new Error(`${r.id}: httpd says binary`);
      return String(body?.content ?? '');
    };
  }

  return Object.freeze({
    kind, subdir, manifestKey, RID, RefError: Err,
    hash: defHash, assertId, path: defPath, ref, parseRef, verify, buildManifest,
    cacheDir, createCache, getByRef, loadFrom, gitFetcher, httpdFetcher,
  });
}
