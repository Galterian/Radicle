// chaosD6-Skills loader (program S3, user-approved 2026-11-16: "do the same split for the skills
// as well"). Same contract as game/effects-repo.mjs, over the shared core game/defs-repo.mjs:
//
//   skills/<id>.json   one skill definition (JsonLogic hooks, see SCHEMA.md / HOOKS.md)
//   lib/<id>.json      shared sub-routine libraries the skills `use`
//   index.json         { format, hash, skills: { id: sha256 }, lib: { id: sha256 } }
//   tools/             manifest.mjs, check.mjs, engine/ (pinned engine copy), validator/
//
// ref = { repo, branch, commit, sha256, id } — sha256 of canonicalJson(definition) is the identity.
// Libraries have refs of their own (same shape; id = lib id, file lib/<id>.json).
// Cache (content addressed <sha256>.json, skills and libs side by side):
//   desktop  $XDG_DATA_HOME/chaosd6/skills   (default ~/.local/share/chaosd6/skills)
//   mobile   $CHAOSD6_USER_DATA_DIR/skills   (Godot user://data = <filesDir>/data → <filesDir>/data/skills)
//   override $CHAOSD6_SKILLS_CACHE (tests)
import { createDefsRepo, makeRefError, canonicalJson, sha256Hex, isPlayerBranch, DEFAULT_SEED_HOST, MAIN_BRANCH, PLAYER_BRANCH_PREFIX } from './defs-repo.mjs';

export { canonicalJson, sha256Hex, isPlayerBranch, DEFAULT_SEED_HOST, MAIN_BRANCH, PLAYER_BRANCH_PREFIX };

// TODO(S3): set once `rad init` has created chaosD6-Skills (game/tools/oci/skills-rad-init.sh prints
// it; game/tools/out/_skills_rid_patch.py wires it in). Until then refs must carry `repo` or
// CHAOSD6_SKILLS_RID must be set.
export const SKILLS_RID = process.env.CHAOSD6_SKILLS_RID || 'rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5';
export const SKILLS_SUBDIR = 'skills';
export const SKILL_LIB_SUBDIR = 'lib';

export const SkillRefError = makeRefError('SkillRefError');

const common = { rid: SKILLS_RID, cacheEnv: 'CHAOSD6_SKILLS_CACHE', cacheSubdir: 'skills', RefError: SkillRefError };
const S = createDefsRepo({ ...common, kind: 'skill', subdir: SKILLS_SUBDIR, manifestKey: 'skills', loadName: 'loadSkillsFrom' });
const L = createDefsRepo({ ...common, kind: 'skill lib', subdir: SKILL_LIB_SUBDIR, manifestKey: 'lib', loadName: 'loadSkillLibsFrom' });

export const skillHash = S.hash;
export const assertSkillId = S.assertId;
/** skills/<id>.json */
export const skillPath = (id) => S.path(id);
/** lib/<id>.json */
export const skillLibPath = (id) => L.path(id);
export const skillRef = S.ref;
export const skillLibRef = L.ref;
export const parseSkillRef = S.parseRef;
export const verifySkill = S.verify;
/** { format: 1, hash, skills: { id: sha256 }, lib: { id: sha256 } } — index.json of chaosD6-Skills. */
export const buildSkillsManifest = (skills, libs = []) => S.buildManifest(skills, { libs });
export const skillsCacheDir = S.cacheDir;
export const createSkillCache = S.createCache;
/** Skill named by `ref`: cache → fetchers (libp2p / Radicle / httpd) → verify sha256 + id → cache. */
export const getSkillByRef = S.getByRef;
/** Library named by a lib ref (fetchers must be lib fetchers: gitSkillLibFetcher / httpdSkillLibFetcher). */
export const getSkillLibByRef = L.getByRef;

/** Every skills/<id>.json at a pinned commit → { commit, skills, refs, errors }. */
export async function loadSkillsFrom(opts = {}) {
  const { commit, defs, refs, errors } = await S.loadFrom(opts);
  return { commit, skills: defs, refs, errors };
}
/** Every lib/<id>.json at a pinned commit → { commit, libs, refs, errors }. */
export async function loadSkillLibsFrom(opts = {}) {
  const { commit, defs, refs, errors } = await L.loadFrom(opts);
  return { commit, libs: defs, refs, errors };
}
/** Skills + libs at the same commit (what a resolver needs to run a pinned skill set). */
export async function loadSkillSetFrom(opts = {}) {
  const s = await loadSkillsFrom(opts);
  const l = await loadSkillLibsFrom({ ...opts, commit: s.commit, branch: opts.branch || (opts.commit && !/^[0-9a-f]{40}$/.test(opts.commit) ? opts.commit : '') });
  return { commit: s.commit, skills: s.skills, libs: l.libs, refs: s.refs, libRefs: l.refs, errors: [...s.errors, ...l.errors] };
}

export const gitSkillFetcher = S.gitFetcher;
export const gitSkillLibFetcher = L.gitFetcher;
/** radicle-httpd: GET <seed>/api/v1/repos/<rid>/blob/<commit>/skills/<id>.json */
export const httpdSkillFetcher = S.httpdFetcher;
/** radicle-httpd: GET <seed>/api/v1/repos/<rid>/blob/<commit>/lib/<id>.json */
export const httpdSkillLibFetcher = L.httpdFetcher;
