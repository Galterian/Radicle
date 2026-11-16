// chaosD6-Effects loader (program E3, user-approved 2026-11-15) — thin wrapper over the
// kind-parameterised core game/defs-repo.mjs (program S3; chaosD6-Skills uses the same core via
// game/skills-repo.mjs). Exports and behaviour are those of the original E3 module.
//
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
import { createDefsRepo, makeRefError, canonicalJson, sha256Hex, isPlayerBranch, DEFAULT_SEED_HOST, MAIN_BRANCH, PLAYER_BRANCH_PREFIX } from './defs-repo.mjs';

export { canonicalJson, sha256Hex, isPlayerBranch, DEFAULT_SEED_HOST, MAIN_BRANCH, PLAYER_BRANCH_PREFIX };

// RID of chaosD6-Effects (published 2026-11-16); CHAOSD6_EFFECTS_RID overrides it (tests, forks).
export const EFFECTS_RID = process.env.CHAOSD6_EFFECTS_RID || 'rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ';
export const EFFECTS_SUBDIR = 'effects';

export const EffectRefError = makeRefError('EffectRefError');

const R = createDefsRepo({ kind: 'effect', subdir: EFFECTS_SUBDIR, manifestKey: 'effects', rid: EFFECTS_RID,
  cacheEnv: 'CHAOSD6_EFFECTS_CACHE', cacheSubdir: 'effects', RefError: EffectRefError, loadName: 'loadEffectsFrom' });

/** sha256 (hex) of the canonical JSON of an effect definition — key order and whitespace never matter. */
export const effectHash = R.hash;
export const assertEffectId = R.assertId;
/** Path of a definition inside the repo: effects/<id>.json */
export const effectPath = (id) => R.path(id);
export const effectRef = R.ref;
/** Validate the shape of a ref received from the network; returns a normalised copy. */
export const parseEffectRef = R.parseRef;
/** Throws unless `def` is exactly what `ref` names. */
export const verifyEffect = R.verify;
/** { format: 1, hash, effects: { <id>: <sha256> } } with ids sorted — written as index.json. */
export const buildManifest = (defs) => R.buildManifest(defs);
export const effectsCacheDir = R.cacheDir;
export const createEffectCache = R.createCache;
/** Definition named by `ref`: cache → fetchers (E4: libp2p / Radicle / httpd) → verify → cache. */
export const getEffectByRef = R.getByRef;

/**
 * Every effects/<id>.json at a pinned commit.
 * → { commit, effects: { <id>: def }, refs: { <id>: ref }, errors: [{ file, error }] }
 */
export async function loadEffectsFrom(opts = {}) {
  const { commit, defs, refs, errors } = await R.loadFrom(opts);
  return { commit, effects: defs, refs, errors };
}

/** Read effects/<id>.json at ref.commit from a local git repo (desktop clone or Radicle storage). */
export const gitEffectFetcher = R.gitFetcher;
/** radicle-httpd: GET <seed>/api/v1/repos/<rid>/blob/<commit>/effects/<id>.json */
export const httpdEffectFetcher = R.httpdFetcher;
