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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefsRepo, makeRefError, canonicalJson, sha256Hex, isPlayerBranch, DEFAULT_SEED_HOST, MAIN_BRANCH, PLAYER_BRANCH_PREFIX } from './defs-repo.mjs';
import { validateLib, loadEffectDefs } from './effect-engine.mjs';   // LR: repo libs validated / bound by the engine itself

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

// ---------------------------------------------------------------------------
// HR (2026-11-18, user decision b): the peer-side effect hook programs (game/effect-hooks.mjs, schema
// chaosd6.effect-hooks/1) live in chaosD6-Effects too: hooks/<family>.json (channel, trap, holdings,
// summon; "id" inside == family == file name), listed in index.json under `hooks` (same sha256 of the
// canonical JSON as the effects). The game bundle game/effects-data/hooks/ stays the built-in fallback.
// Not in validator/pin.json: rebalancing-check never runs a hook (it prices channels / traps / summons
// analytically), so a hook edit changes no verdict and must not invalidate player stamps.
// In the handshake set id (effects-handshake.mjs#bundledEffectSet): a peer running other hook programs
// (EFFECT_HOOKS_ENGINE=data|shadow) resolves channel ticks / traps / summons differently — fx_set must show it.
// ---------------------------------------------------------------------------
export const EFFECT_HOOKS_SUBDIR = 'hooks';
const H = createDefsRepo({ kind: 'effect hooks', subdir: EFFECT_HOOKS_SUBDIR, manifestKey: 'hooks', rid: EFFECTS_RID,
  cacheEnv: 'CHAOSD6_EFFECTS_CACHE', cacheSubdir: 'effects', RefError: EffectRefError, loadName: 'loadEffectHooksFrom' });
/** The bundled built-in hook programs (the fallback): game/effects-data/hooks/ (EFFECT_HOOKS_DIR overrides, as in effect-hooks.mjs). */
export const BUNDLED_EFFECT_HOOKS_DIR = fileURLToPath(new URL('./effects-data/hooks/', import.meta.url));

export const effectHooksHash = H.hash;
export const assertEffectHooksId = H.assertId;
/** hooks/<family>.json */
export const effectHooksPath = (id) => H.path(id);
export const effectHooksRef = H.ref;
export const parseEffectHooksRef = H.parseRef;
export const verifyEffectHooks = H.verify;
/** Hook file named by a ref: cache → fetchers (gitEffectHooksFetcher / httpdEffectHooksFetcher) → verify → cache. */
export const getEffectHooksByRef = H.getByRef;
export const gitEffectHooksFetcher = H.gitFetcher;
/** radicle-httpd: GET <seed>/api/v1/repos/<rid>/blob/<commit>/hooks/<family>.json */
export const httpdEffectHooksFetcher = H.httpdFetcher;
/** index.json of chaosD6-Effects: { format, hash, effects[, hooks][, libs] } — `hooks` / `libs` only when such
 *  files are given, so an index written before HR / LR stays byte-identical. */
export function buildEffectsManifest(defs, hooks = null, libs = null) {
  const m = R.buildManifest(defs);
  if (hooks && hooks.length) m.hooks = H.buildManifest(hooks).hooks;
  if (libs && libs.length) m.libs = L.buildManifest(libs).libs;
  return m;
}

// ---------------------------------------------------------------------------
// LR (2026-11-18, user decision): the effect libraries every effect `use`s (std, e2a, e2b, e2c; schema
// chaosd6.effect-lib/1, effect-engine.mjs#validateLib) live in chaosD6-Effects too: lib/<id>.json, listed in
// index.json under `libs` (sha256 of the canonical JSON — the same hash the handshake refs pin in ref.libs and
// rebalancing-check pins in validator/pin.json engines). game/effects-data/lib/ stays the built-in fallback for
// commits without lib/. Pin: engineHashes() pins the bundled game/effects-data/lib/*.json by that hash; since
// validator 1.1.0 the audit binds the libs a ref / commit pins (checkEffect opts.libs + libShas, CLI --libs / --ref)
// and stamp.libs records them, the bundled ones only when none are given. Set id: unchanged —
// effectSetId already has `libs`.
// ---------------------------------------------------------------------------
export const EFFECT_LIBS_SUBDIR = 'lib';
const L = createDefsRepo({ kind: 'effect lib', subdir: EFFECT_LIBS_SUBDIR, manifestKey: 'libs', rid: EFFECTS_RID,
  cacheEnv: 'CHAOSD6_EFFECTS_CACHE', cacheSubdir: 'effects', RefError: EffectRefError, loadName: 'loadEffectLibsFrom' });
/** The bundled libraries (the fallback): game/effects-data/lib/. */
export const BUNDLED_EFFECT_LIBS_DIR = fileURLToPath(new URL('./effects-data/lib/', import.meta.url));
export const effectLibHash = L.hash;
export const assertEffectLibId = L.assertId;
/** lib/<id>.json */
export const effectLibPath = (id) => L.path(id);
export const effectLibRef = L.ref;
export const parseEffectLibRef = L.parseRef;
export const verifyEffectLib = L.verify;
export const getEffectLibByRef = L.getByRef;
/** lib/<id>.json at ref.commit from a local git repo. */
export const gitEffectLibFetcher = L.gitFetcher;
/** radicle-httpd: GET <seed>/api/v1/repos/<rid>/blob/<commit>/lib/<id>.json */
export const httpdEffectLibFetcher = L.httpdFetcher;
/** Every lib/<id>.json at a pinned commit → { commit, libs: { <id>: lib }, refs, errors } (each lib checked by validateLib). */
export async function loadEffectLibsFrom(opts = {}) {
  const { commit, defs, refs, errors } = await L.loadFrom(opts);
  for (const id of Object.keys(defs)) {
    const errs = validateLib(defs[id]);
    if (errs.length) { errors.push({ file: `lib/${id}.json`, error: errs.join('; ') }); delete defs[id]; delete refs[id]; }
  }
  return { commit, libs: defs, refs, errors };
}
const readJsonDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()
  .map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8').replace(/^﻿/, ''))) : []);
/**
 * The libraries effects of a repo commit resolve `uses` against.
 *   { dir | gitdir, commit, … } → lib/*.json of that commit; a commit without lib/ (pre-LR history) or a load /
 *   validation error → the bundled libs.   {} → the bundled libs (game/effects-data/lib).
 * → { source: 'repo' | 'bundled', commit, files: [lib…], refs: { <id>: ref }, errors }
 */
export async function effectLibFiles(opts = {}) {
  const bundled = () => ({ source: 'bundled', commit: null, files: readJsonDir(BUNDLED_EFFECT_LIBS_DIR), refs: {} });
  if (!opts.dir && !opts.gitdir) return { ...bundled(), errors: [] };
  let X;
  try { X = await loadEffectLibsFrom(opts); } catch (e) { return { ...bundled(), errors: [{ file: 'lib/', error: e.message }] }; }
  if (X.errors.length || !Object.keys(X.libs).length) return { ...bundled(), errors: X.errors };
  return { source: 'repo', commit: X.commit, files: Object.keys(X.libs).sort().map(k => X.libs[k]), refs: X.refs, errors: [] };
}
/**
 * Effects of a repo commit, runnable, with `uses` bound to THAT commit's libs (bundled fallback for pre-LR commits).
 * → { commit, libSource, effects: Map(id → runnable def), refs: { <id>: ref + libs: { <lib id>: sha256 } }, libs, errors }
 * The refs carry `libs` exactly as effects-handshake.mjs#makeFxRef pins them (only the libs the def uses), so a
 * peer learning such an effect fetches the commit's lib versions. A def that does not bind is reported in errors.
 */
export async function loadRunnableEffectsFrom(opts = {}) {
  const E = await loadEffectsFrom(opts);
  const lf = await effectLibFiles({ ...opts, commit: E.commit });
  const byId = new Map(lf.files.map(l => [l.id, l]));
  const effects = new Map(); const refs = {}; const errors = [...E.errors, ...lf.errors];
  for (const id of Object.keys(E.effects)) {
    const def = E.effects[id];
    try {
      const run = loadEffectDefs({ effects: [structuredClone(def)], libs: lf.files }).get(id);
      const libs = {};
      for (const u of [...(def.uses || [])].sort()) libs[u] = L.hash(byId.get(u));
      effects.set(id, run);
      refs[id] = { ...E.refs[id], libs };
    } catch (e) { errors.push({ file: `effects/${id}.json`, error: e.message }); }
  }
  return { commit: E.commit, libSource: lf.source, effects, refs, libs: lf.files, errors };
}

/** Every hooks/<family>.json at a pinned commit → { commit, hooks: { <family>: file }, refs, errors }. */
export async function loadEffectHooksFrom(opts = {}) {
  const { commit, defs, refs, errors } = await H.loadFrom(opts);
  return { commit, hooks: defs, refs, errors };
}
/** Effects + hook files + libs at the same commit (`libs` empty for a pre-LR commit). */
export async function loadEffectSetFrom(opts = {}) {
  const e = await loadEffectsFrom(opts);
  const o2 = { ...opts, commit: e.commit, branch: opts.branch || (opts.commit && !/^[0-9a-f]{40}$/.test(opts.commit) ? opts.commit : '') };
  const h = await loadEffectHooksFrom(o2);
  const l = await loadEffectLibsFrom(o2);
  return { commit: e.commit, effects: e.effects, hooks: h.hooks, libs: l.libs, refs: e.refs, hookRefs: h.refs, libRefs: l.refs,
    errors: [...e.errors, ...h.errors, ...l.errors] };
}
const readHookDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()
  .map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8').replace(/^﻿/, ''))) : []);
/**
 * The hook files a peer should run, as the array effect-hooks.mjs#loadHookFiles(array) takes.
 *   { dir | gitdir, commit, … }  → hooks/*.json of that repo commit; a commit with no hooks/ (pre-HR history) or
 *   a load error → the bundled files.   {} → the bundled files (EFFECT_HOOKS_DIR, else game/effects-data/hooks).
 * → { source: 'repo' | 'bundled', commit, files: [file…], refs: { <family>: ref }, errors }
 */
export async function effectHookFiles(opts = {}) {
  const bundled = () => ({ source: 'bundled', commit: null, files: readHookDir(process.env.EFFECT_HOOKS_DIR || BUNDLED_EFFECT_HOOKS_DIR), refs: {} });
  if (!opts.dir && !opts.gitdir) return { ...bundled(), errors: [] };
  let L;
  try { L = await loadEffectHooksFrom(opts); } catch (e) { return { ...bundled(), errors: [{ file: 'hooks/', error: e.message }] }; }
  if (L.errors.length || !Object.keys(L.hooks).length) return { ...bundled(), errors: L.errors };
  return { source: 'repo', commit: L.commit, files: Object.keys(L.hooks).sort().map(k => L.hooks[k]), refs: L.refs, errors: [] };
}
