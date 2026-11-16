// chaosD6-Classes loader (program C3, user request 2026-11-16: "do the same split for the CLASSES
// as well"). Same contract as game/effects-repo.mjs, over the shared core game/defs-repo.mjs:
//
//   classes/<id>.json  one class definition (JsonLogic hooks, see classes-data/SCHEMA.md / HOOKS.md)
//   lib/<id>.json      shared sub-routine libraries the classes `use` (classes_std)
//   index.json         { format, hash, classes: { id: sha256 }, lib: { id: sha256 } }
//   tools/             manifest.mjs, check.mjs, engine/ (pinned engine copy), validator/
//
// ref = { repo, branch, commit, sha256, id } — sha256 of canonicalJson(definition) is the identity.
// Libraries have refs of their own (same shape; id = lib id, file lib/<id>.json).
// Cache (content addressed <sha256>.json, classes and libs side by side):
//   desktop  $XDG_DATA_HOME/chaosd6/classes   (default ~/.local/share/chaosd6/classes)
//   mobile   $CHAOSD6_USER_DATA_DIR/classes   (Godot user://data = <filesDir>/data → <filesDir>/data/classes)
//   override $CHAOSD6_CLASSES_CACHE (tests)
import { createDefsRepo, makeRefError, canonicalJson, sha256Hex, isPlayerBranch, DEFAULT_SEED_HOST, MAIN_BRANCH, PLAYER_BRANCH_PREFIX } from './defs-repo.mjs';

export { canonicalJson, sha256Hex, isPlayerBranch, DEFAULT_SEED_HOST, MAIN_BRANCH, PLAYER_BRANCH_PREFIX };

// TODO(C3): set once `rad init` has created chaosD6-Classes (game/tools/oci/classes-rad-init.sh prints
// it; game/tools/out/_classes_rid_patch.py wires it in). Until then refs must carry `repo` or
// CHAOSD6_CLASSES_RID must be set.
export const CLASSES_RID = process.env.CHAOSD6_CLASSES_RID || 'rad:TODO_CLASSES_RID';
export const CLASSES_SUBDIR = 'classes';
export const CLASS_LIB_SUBDIR = 'lib';

export const ClassRefError = makeRefError('ClassRefError');

const common = { rid: CLASSES_RID, cacheEnv: 'CHAOSD6_CLASSES_CACHE', cacheSubdir: 'classes', RefError: ClassRefError };
const S = createDefsRepo({ ...common, kind: 'class', subdir: CLASSES_SUBDIR, manifestKey: 'classes', loadName: 'loadClassesFrom' });
const L = createDefsRepo({ ...common, kind: 'class lib', subdir: CLASS_LIB_SUBDIR, manifestKey: 'lib', loadName: 'loadClassLibsFrom' });

export const classHash = S.hash;
export const assertClassId = S.assertId;
/** classes/<id>.json */
export const classPath = (id) => S.path(id);
/** lib/<id>.json */
export const classLibPath = (id) => L.path(id);
export const classRef = S.ref;
export const classLibRef = L.ref;
export const parseClassRef = S.parseRef;
export const verifyClass = S.verify;
/** { format: 1, hash, classes: { id: sha256 }, lib: { id: sha256 } } — index.json of chaosD6-Classes. */
export const buildClassesManifest = (classes, libs = []) => S.buildManifest(classes, { libs });
export const classesCacheDir = S.cacheDir;
export const createClassCache = S.createCache;
/** Class named by `ref`: cache → fetchers (libp2p / Radicle / httpd) → verify sha256 + id → cache. */
export const getClassByRef = S.getByRef;
/** Library named by a lib ref (fetchers must be lib fetchers: gitClassLibFetcher / httpdClassLibFetcher). */
export const getClassLibByRef = L.getByRef;

/** Every classes/<id>.json at a pinned commit → { commit, classes, refs, errors }. */
export async function loadClassesFrom(opts = {}) {
  const { commit, defs, refs, errors } = await S.loadFrom(opts);
  return { commit, classes: defs, refs, errors };
}
/** Every lib/<id>.json at a pinned commit → { commit, libs, refs, errors }. */
export async function loadClassLibsFrom(opts = {}) {
  const { commit, defs, refs, errors } = await L.loadFrom(opts);
  return { commit, libs: defs, refs, errors };
}
/** Classes + libs at the same commit (what a resolver needs to run a pinned class set). */
export async function loadClassSetFrom(opts = {}) {
  const s = await loadClassesFrom(opts);
  const l = await loadClassLibsFrom({ ...opts, commit: s.commit, branch: opts.branch || (opts.commit && !/^[0-9a-f]{40}$/.test(opts.commit) ? opts.commit : '') });
  return { commit: s.commit, classes: s.classes, libs: l.libs, refs: s.refs, libRefs: l.refs, errors: [...s.errors, ...l.errors] };
}

export const gitClassFetcher = S.gitFetcher;
export const gitClassLibFetcher = L.gitFetcher;
/** radicle-httpd: GET <seed>/api/v1/repos/<rid>/blob/<commit>/classes/<id>.json */
export const httpdClassFetcher = S.httpdFetcher;
/** radicle-httpd: GET <seed>/api/v1/repos/<rid>/blob/<commit>/lib/<id>.json */
export const httpdClassLibFetcher = L.httpdFetcher;
