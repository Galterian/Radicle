// Foreign-class handshake (program chaosD6-Classes, the classes twin of E4 / S4; coordinator task 2026-11-16).
//
// The classes twin of effects-handshake.mjs (E4) and skills-handshake.mjs (S4): a player creates a class on a
// branch of chaosD6-Classes (rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi); peers lacking it are told its ref, load it, check
// it and pass it on. Design note: game/classes-data/SCHEMA.md "Foreign classes (handshake)".
//
// Built-in classes (CLASS_RULES / data/classes.json / the bundled game/classes-data/classes/*.json) travel by NAME
// (snapshot class_id / permanents_csv), exactly as before. A FOREIGN class — a definition from a player branch,
// with an id that is not a built-in — travels by NAME + REF, and every peer runs the same bytes (content addressed:
// sha256 of the canonical JSON, libraries pinned).
//
//   ref    { id, sha256, libs: { <lib id>: <sha256> }, repo?, branch?, commit?, name?, verdict? }   (as E4 / S4)
//   clKey(ref) = sha256(canonical {class: ref.sha256, libs: ref.libs})     the pin of one runnable class
//   classSetId({libs, classes}) = sha256(canonical {libs:{id:sha}, classes:{id:sha}})   a peer's bundled set
//
// A class is not a card played on one action: its holder carries it all game, and other units' actions read it
// (a strike on its colours, its stance, its swap …). So the ref rides on the HOLDER:
//   state   cl_ref_json = compact ref of my foreign class (slim snapshot; Gun is flat → a JSON string)
//           cl_have = "id@sha16,…" (the foreign classes I hold and serve)       cl_set = sha16 of my bundled set (full)
//   Door    cl_ref (mine and every known member's) — a joiner learns the classes of the dimension before it plays
//   commit  payload.cl_ref = ref           my foreign class (fetch window commit → reveal)
//   reveal  payload.cl_ref = ref           the same; THE ref the resolver uses for a revealer's class
//           payload.cl_missing = [sha256…] foreign class refs in play this action (revealers' + my view's) that I
//                                          cannot run (not obtained in time, refused by the validator / policy)
//   fetch   libp2p /chaos/<dim>/classes/1 (same framing + messages as /effects/1, wire kind 'class'), Nostr bus `cl`
//           events when there is no direct link, then git (CHAOSD6_CLASSES_DIR) / radicle-httpd (classes-repo.mjs).
//
// Deterministic fallback (gateClasses): a foreign class whose sha any revealer of the action listed in cl_missing is
// DORMANT for that resolution on every peer (classes.mjs suspendForeignClasses: no flags, no data — exactly what a
// peer lacking it computes). A class in play that is neither dormant nor ready here (after ≤ CL_RESOLVE_WAIT_MS)
// makes this peer ABSTAIN from the state hash for that action (state_hash ''), resolving it as dormant.
// Region tag per revealer holding a foreign class: 'cl:<key16>' | 'dormant:<key16>' | 'missing:<key16>' | 'bad:<id>'.
//
// The program engine is C2's (game/classes.mjs): registerForeignClass(key, def, {libs}) binds a definition so every
// classHook call for its id runs its programs; validateClassDef checks it first; the C3 validator
// (tools/classes-rebalancing-check.mjs checkClass) gives the verdict. A foreign id must not be a built-in id — a
// branch variant of a built-in is a new id that `extends` it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256Hex, classHash, parseClassRef, getClassByRef, createClassCache, classesCacheDir,
  httpdClassFetcher, gitClassFetcher, CLASSES_RID, ClassRefError } from './classes-repo.mjs';
import { withProvenance } from './defs-repo.mjs';   // PV: ref provenance (ns, review) — never hashed
import { libShaMap, compactRef, createMemoryCache, createFxSync, parseLibbedRef, attachDefsRpc, prefixOf, foreignCardFromRef } from './effects-handshake.mjs';   // reused read-only (6f's file)
import * as CL from './classes.mjs';
import { foreignHolder, foreignRefuser } from './foreign-select.mjs';   // PS: partial foreign swarms

export { compactRef, prefixOf, createMemoryCache };
export const CL_PROTOCOL_VERSION = 1;
export const clProtocol = (dimId) => `/chaos/${dimId}/classes/1`;
export const CL_BUS_KIND = 'cl';
export const CL_FRAME_BYTES = 32 * 1024;
export const CL_BUS_FRAME_BYTES = 24 * 1024;
const SHA_RE = /^[0-9a-f]{64}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLASSES_DATA_DIR = path.join(HERE, 'classes-data');
const MAX_MISSING = 16;

// ------------------------------------------------------------------ set ids / refs
/** Deterministic id of the classes a peer ships: sha256(canonical {libs:{id:sha}, classes:{id:sha}}). */
export function classSetId({ libs = {}, classes = {} } = {}) { return sha256Hex(canonicalJson({ libs, classes })); }
/** The pin of one runnable class: its sha256 + the sha256 of every library it uses. */
export function clKey(ref) { return sha256Hex(canonicalJson({ class: ref.sha256, libs: ref.libs || {} })); }

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const jsonFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f)) : []);
function dataClassIds() {
  try { return readJson(path.join(HERE, '..', 'data', 'classes.json')).entries.map(e => e.id).filter(Boolean); } catch { return []; }
}
/**
 * The bundled class set: game/classes-data/classes/*.json + lib/*.json (C2). builtinIds = classes.mjs
 * CLASSES_IMPLEMENTED ∪ data/classes.json ∪ bundled files — every id that travels by name.
 */
export function bundledClassSet(dir = process.env.CLASS_DEFS_DIR || CLASSES_DATA_DIR) {
  const classes = new Map(), libs = new Map();
  for (const f of jsonFiles(path.join(dir, 'lib'))) { try { const l = readJson(f); if (l?.id) libs.set(l.id, l); } catch {} }
  for (const f of jsonFiles(path.join(dir, 'classes'))) { try { const d = readJson(f); if (d?.id) classes.set(d.id, d); } catch {} }
  const set = { libs: libShaMap(libs), classes: {} };
  for (const id of [...classes.keys()].sort()) set.classes[id] = classHash(classes.get(id));
  const builtinIds = new Set([...CL.CLASSES_IMPLEMENTED, ...dataClassIds(), ...classes.keys()]);
  return { classes, libs, set, id: classSetId(set), builtinIds };
}

/** A ref for class `def` with its libraries pinned. `libs`: Map|array of lib objects or {name: sha}. */
export function makeClRef(def, libs, { repo = '', branch = '', commit = '', verdict = null, ns = '', review = false } = {}) {   // PV: ns / review
  const uses = [...(def.uses || [])].sort();
  const byName = libs instanceof Map ? Object.fromEntries([...libs].map(([k, l]) => [k, classHash(l)]))
    : Array.isArray(libs) ? libShaMap(libs) : { ...(libs || {}) };
  const pinned = {};
  for (const u of uses) {
    const s = typeof byName[u] === 'string' ? byName[u] : byName[u] && classHash(byName[u]);
    if (!s) throw new ClassRefError('bad-def', `${def.id}: library ${u} is not available to pin`);
    pinned[u] = s;
  }
  const ref = { id: def.id, sha256: classHash(def), libs: pinned, repo: String(repo || ''), branch: String(branch || ''), commit: String(commit || ''), name: String(def.name || '') };
  if (verdict) ref.verdict = verdict;
  withProvenance(ref, { ns, review });   // PV
  return parseClRef(ref);
}
/** Validate a class ref received from the network → normalised copy (throws ClassRefError). */
export function parseClRef(ref) {
  const r = parseLibbedRef(ref, parseClassRef, ClassRefError);
  if (!/^class_[a-z0-9_]+$/.test(r.id)) throw new ClassRefError('bad-ref', `ref ${r.id}: a class id is class_[a-z0-9_]+`);
  return r;
}
/** A ref out of a snapshot / Door field (object or JSON string) → normalised ref or null. */
export function clRefOf(x) {
  if (!x) return null;
  try { return parseClRef(typeof x === 'string' ? JSON.parse(x) : x); } catch { return null; }
}

/** What peer.mjs / the cards read of a class definition. */
export function classShape(def) {
  const d = def && typeof def.data === 'object' && def.data ? def.data : {};
  return { name: String(def?.name || def?.id || ''), text: String(d.text || ''), kind: d.ability_kind || 'static', colors: Array.isArray(d.colors) ? [...d.colors] : [], extends: typeof def?.extends === 'string' ? def.extends : null, version: String(def?.version || '0.0.0') };
}

// ------------------------------------------------------------------ store: what this peer holds
// validate(def) → { verdict, reasons } | null (C3 checkClass). register(key, def, {libs}) → classes.mjs registerForeignClass.
export function createClStore({ bundled = null, builtinIds = null, validate = null, register = CL.registerForeignClass, validateDef = CL.validateClassDef, onReady = null, log = () => {} } = {}) {
  const defs = new Map(), libs = new Map();
  const prepared = new Map();      // clKey -> { status, ref, key, def, shape, verdict, reason }
  const keyById = new Map();       // foreign id -> clKey of the one accepted definition (first accepted wins)
  const builtin = builtinIds || bundled?.builtinIds || new Set();
  if (bundled) for (const l of bundled.libs.values()) libs.set(classHash(l), l);
  const addDef = (d) => { const s = classHash(d); if (!defs.has(s)) defs.set(s, d); return s; };
  const addLib = (l) => { const s = classHash(l); if (!libs.has(s)) libs.set(s, l); return s; };
  function prepare(ref) {
    const key = clKey(ref);
    const got = prepared.get(key);
    if (got) return got;
    const def = defs.get(ref.sha256);
    if (!def) return { status: 'missing', ref, key };
    const libObjs = [];
    for (const [name, s] of Object.entries(ref.libs)) { const l = libs.get(s); if (!l) return { status: 'missing', ref, key, lib: name }; libObjs.push(l); }
    let res;
    try {
      if (def.id !== ref.id) throw new Error(`definition id ${def.id} ≠ ref id ${ref.id}`);
      const uses = [...(def.uses || [])].sort(), names = Object.keys(ref.libs).sort();
      if (canonicalJson(uses) !== canonicalJson(names)) throw new Error(`ref pins libs [${names}] but the definition uses [${uses}]`);
      for (const l of libObjs) if (!Object.prototype.hasOwnProperty.call(ref.libs, l.id)) throw new Error(`library id ${l.id} not pinned`);
      if (builtin.has(def.id)) throw new Error(`${def.id} is a built-in class id — a branch variant needs its own id (extends: ${def.id})`);
      if (keyById.has(def.id) && keyById.get(def.id) !== key) throw new Error(`another foreign ${def.id} is already loaded (one definition per id)`);
      const libsCopy = libObjs.map(l => structuredClone(l));
      const errs = validateDef ? validateDef(def, { libs: libsCopy }) : [];
      if (errs.length) throw new Error(`invalid class definition: ${errs.slice(0, 3).join('; ')}`);
      let verdict = 'unchecked', reasons = [];
      if (validate) {
        try { const v = validate(def); verdict = v?.verdict || 'unchecked'; reasons = v?.reasons || []; }
        catch (e) { verdict = 'reject'; reasons = [`validator error: ${e.message}`]; }
      }
      if (verdict === 'reject') res = { status: 'rejected', reason: `rebalance verdict reject${reasons.length ? `: ${reasons.join('; ')}` : ''}`, verdict };
      else {
        // Registered HERE, before the definition counts as ready: a peer that says "ready" always runs it.
        register(key, structuredClone(def), { libs: libsCopy });
        keyById.set(def.id, key);
        res = { status: 'ready', def: structuredClone(def), shape: classShape(def), verdict };
      }
    } catch (e) { res = { status: 'rejected', reason: e.message, verdict: null }; }
    const out = { ...res, ref, key };
    prepared.set(key, out);
    if (out.status === 'ready') onReady?.(out);
    else log(`class ${ref.id} (${prefixOf(ref.sha256)}) refused: ${out.reason}`);
    return out;
  }
  return {
    addDef, addLib, prepare,
    hasDef: (s) => defs.has(s), hasLib: (s) => libs.has(s), getDef: (s) => defs.get(s) || null, getLib: (s) => libs.get(s) || null,
    status: (ref) => prepared.get(clKey(ref))?.status || 'missing',
    prepared: (key) => prepared.get(key) || null,
    ready: () => [...prepared.values()].filter(p => p.status === 'ready'),
    readyById: (id) => { const k = keyById.get(id); const p = k && prepared.get(k); return p?.status === 'ready' ? p : null; },
    isBuiltin: (id) => builtin.has(id),
  };
}

/** Sync (fetch / serve / have / prefetch): createFxSync of E4 with the class kind. */
export function createClSync(o) {
  return createFxSync({ ...o, kind: 'class', parseRef: parseClRef, getByRef: getClassByRef, keyOf: clKey });
}

// ------------------------------------------------------------------ resolver gate (pure, testable)
const firstRevealPerActor = (tape, turn, round) => {
  const m = new Map();
  for (const env of tape || []) {
    if (env?.type !== 'evt_action_reveal' || env.turn !== turn || env.round !== round) continue;
    if (!m.has(env.actor_peer_id)) m.set(env.actor_peer_id, env);
  }
  return m;
};
/** actor → its revealed foreign class ref (or null), mine from my own reveal record. */
export function classRefsByActor(reveals, tape, turn, round, self = null, selfRef = undefined) {
  const first = firstRevealPerActor(tape, turn, round);
  const m = new Map();
  for (const r of reveals) m.set(r.actor, clRefOf(r.actor === self && selfRef !== undefined ? selfRef : first.get(r.actor)?.payload?.cl_ref));
  return m;
}
/** Union of the cl_missing lists of the reveals the resolver uses (the same set on every peer). */
export function clMissingUnion(reveals, tape, turn, round, self = null, selfMissing = null) {
  const first = firstRevealPerActor(tape, turn, round);
  const out = new Set();
  for (const r of reveals) {
    const list = r.actor === self && Array.isArray(selfMissing) ? selfMissing : first.get(r.actor)?.payload?.cl_missing;
    if (Array.isArray(list)) for (const s of list.slice(0, MAX_MISSING)) if (typeof s === 'string' && SHA_RE.test(s)) out.add(s);
  }
  return out;
}
/**
 * The class rule for one resolution. units: [{ id, class_id, ref }] — every unit the resolver reads (mine
 * included); ref = the unit's snapshot ref (a revealer's REVEALED ref wins: refsByActor). Per unit whose class_id
 * is not a built-in:
 *   no ref                         → abstain (dormant here)             revealer tag 'bad:<id>'
 *   ref sha in any cl_missing      → dormant on every peer              revealer tag 'dormant:<key16>'
 *   ready here (same key as held)  → runs (classes.mjs data hooks)      revealer tag 'cl:<key16>'
 *   otherwise                      → abstain (dormant here)             revealer tag 'missing:<key16>'
 * → { tags: Map(revealer → tag), abstain, dormant: [ids, sorted], missing: [ref] }.
 */
export function gateClasses(units, missing, statusOf, refsByActor, isBuiltin, readyKeyOf = () => null) {
  const tags = new Map(), dormant = new Set(), missingRefs = [];
  let abstain = false;
  const seen = new Set();
  for (const u of [...units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const id = u.class_id;
    if (!id || isBuiltin(id) || seen.has(u.id)) continue;
    seen.add(u.id);
    const isRevealer = refsByActor.has(u.id);
    const ref = (isRevealer ? refsByActor.get(u.id) : null) || clRefOf(u.ref);
    const tag = (t) => { if (isRevealer) tags.set(u.id, t); };
    if (!ref || ref.id !== id) { abstain = true; dormant.add(id); tag(`bad:${id}`); continue; }
    const k = clKey(ref), k16 = k.slice(0, 16);
    if (missing.has(ref.sha256)) { dormant.add(id); tag(`dormant:${k16}`); continue; }
    if (statusOf(ref) === 'ready' && (readyKeyOf(id) == null || readyKeyOf(id) === k)) { tag(`cl:${k16}`); continue; }
    abstain = true; dormant.add(id); missingRefs.push(ref); tag(`missing:${k16}`);
  }
  return { tags, abstain, dormant: [...dormant].sort(), missing: missingRefs };
}

// ------------------------------------------------------------------ the peer adapter (peer.mjs glue)
const envMs = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= 0 ? v : dflt; };
export async function createClPeer({ selfId, label = selfId, dimId, ui = () => {}, log: logIn = null, nameOf = () => null, validate: validateIn, onReady = null } = {}) {
  const log = logIn || ((line) => console.log(`[${label}] cl: ${line}`));
  const bundled = bundledClassSet();
  let validate = validateIn ?? null, validatorInfo = validateIn ? 'injected' : 'none';
  if (validateIn === undefined && process.env.CL_VALIDATOR !== '0') {
    try {
      const m = await import('./tools/classes-rebalancing-check.mjs');
      if (typeof m.checkClass === 'function') { validate = (def) => m.checkClass(def); validatorInfo = `classes-rebalancing-check ${m.VALIDATOR_VERSION || '?'}`; }
    } catch (e) { validatorInfo = `absent (${e.message.slice(0, 60)})`; }
  }
  // CL_ACCEPT=0: this player refuses every foreign class (local policy) — its reveals list them in cl_missing, so
  // those classes are dormant for everybody in the action.
  if (process.env.CL_ACCEPT === '0') { validate = () => ({ verdict: 'reject', reasons: ['CL_ACCEPT=0: this player refuses foreign classes'] }); validatorInfo = 'CL_ACCEPT=0 (refuse all)'; }
  else if (foreignRefuser(label)) { validate = () => ({ verdict: 'reject', reasons: ['FOREIGN_REFUSERS: this player refuses foreign classes'] }); validatorInfo = 'FOREIGN_REFUSERS (refuse all)'; }   // PS
  const cache = process.env.CHAOSD6_CLASSES_CACHE === 'memory' ? createMemoryCache() : createClassCache({ dir: classesCacheDir() });
  const fallbackFetchers = [];
  if (process.env.CHAOSD6_CLASSES_DIR) fallbackFetchers.push(gitClassFetcher({ dir: process.env.CHAOSD6_CLASSES_DIR }));
  if (process.env.CL_HTTPD !== '0') {
    const httpd = httpdClassFetcher({ seedHost: process.env.CHAOSD6_CLASSES_SEED || undefined });
    fallbackFetchers.push(async (r) => (r.commit && (r.repo || !CLASSES_RID.includes('TODO')) ? httpd(r) : null));
  }
  const refOut = (ref, verdict) => ({ ...compactRef(ref), kind: 'class', ...(verdict ? { verdict } : {}) });
  const notice = (event, prep, peer) => ui({ kind: 'class_source', event, ref: refOut(prep.ref, prep.verdict), peer: peer ? { peer_id: peer, name: nameOf(peer) || undefined } : null });
  let active = false;
  const store = createClStore({ bundled, validate, log, onReady: (p) => { active = true; onReady?.(p); } });
  let request = null, busRpc = null;
  const sync = createClSync({
    selfId, store, cache, fallbackFetchers, log, opts: process.env.CL_PREFETCH === '0' ? { prefetch: false } : {},
    request: (peerId, msg) => (request ? request(peerId, msg) : Promise.reject(Object.assign(new Error('no transport yet'), { code: 'NO_ROUTE' }))),
    onLearned: (p, src) => { log(`learned ${p.ref.id} (${prefixOf(p.ref.sha256)}, ${p.ref.branch || 'no branch'}, verdict ${p.verdict}) from ${src}`); notice('learned', p, src && !['cache', 'fallback', 'local', 'bundled'].includes(src) ? src : null); },
    onShared: (p, peer) => { log(`shared ${p.ref.id} (${prefixOf(p.ref.sha256)}) with ${peer}`); notice('shared', p, peer); },
  });
  const REVEAL_WAIT = envMs('CL_REVEAL_WAIT_MS', 1500), RESOLVE_WAIT = envMs('CL_RESOLVE_WAIT_MS', 4000), BOOT_WAIT = envMs('CL_BOOT_WAIT_MS', 8000);
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => { const t = setTimeout(() => r('missing'), ms); t.unref?.(); })]);
  const missingNoticed = new Set();
  const isBuiltin = (id) => bundled.builtinIds.has(id);
  const peerRefs = new Map();   // peer id → its foreign class ref (snapshot cl_ref_json / Door)
  let mine = null;              // { prep, ref } — my own foreign class
  log(`bundled class set ${bundled.id.slice(0, 16)} (${Object.keys(bundled.set.classes).length} classes, ${bundled.libs.size} libs), validator ${validatorInfo}`);

  const notePeerRef = (peerId, raw) => {
    const ref = clRefOf(raw);
    if (!peerId || peerId === selfId || !ref) return null;
    const had = peerRefs.get(peerId);
    peerRefs.set(peerId, ref);
    active = true;
    if (!had || clKey(had) !== clKey(ref)) sync.ensure(ref, { from: peerId }).catch(() => {});
    return ref;
  };
  const api = {
    setId: bundled.id, bundled, store, sync, isBuiltin,
    get active() { return active; },
    get mine() { return mine; },
    /** My foreign class ref (compact) or null. */
    myRef() { return mine ? mine.ref : null; },
    /** A foreign class I can run: { id, name, text, kind, colors, verdict, ref } or null. */
    info(id) { const p = store.readyById(id); return p ? { id, ...p.shape, verdict: p.verdict, ref: compactRef(p.ref) } : null; },
    /** The ref a peer's snapshot / Door announced for its foreign class (or null). */
    refOf(peerId) { return peerId === selfId ? (mine?.ref || null) : (peerRefs.get(peerId) || null); },
    /**
     * Boot: my class from FORCE_FOREIGN_CLASS=<def.json> (dev / test: a player-branch class) or a ref (profile
     * character class_ref, a hero shadow's FOREIGN_CLASS_REF_JSON) — cache first, then git / httpd. → info | null.
     */
    async boot({ file = '', ref: refIn = null } = {}) {
      let prep = null;
      if (file && !foreignHolder(label)) { log(`FORCE_FOREIGN_CLASS: not a holder (FOREIGN_HOLDERS) — I boot with a built-in class`); return null; }   // PS
      if (file) {
        let def;
        try { def = readJson(file); } catch (e) { log(`FORCE_FOREIGN_CLASS ${file}: ${e.message}`); return null; }
        try {
          const libObjs = (def.uses || []).map(u => { const l = bundled.libs.get(u); if (!l) throw new Error(`library ${u} not bundled`); return l; });
          const slug = String(def.id || '').replace(/^class_/, '').replace(/_/g, '-');
          const ref0 = makeClRef(def, libObjs, { repo: process.env.CL_FORCE_REPO || '', branch: process.env.CL_FORCE_BRANCH || `players/local/${slug}`, commit: process.env.CL_FORCE_COMMIT || '', ns: process.env.CL_FORCE_NS || '' });   // PV: CL_FORCE_NS = publisher namespace (NID)
          prep = sync.adopt(def, ref0, libObjs);
          if (prep.status !== 'ready') { log(`FORCE_FOREIGN_CLASS ${def.id}: refused (${prep.reason || prep.status})`); return null; }
        } catch (e) { log(`FORCE_FOREIGN_CLASS ${file}: ${e.message}`); return null; }
      } else if (refIn) {
        const ref = clRefOf(refIn);
        if (!ref) { log(`foreign class ref unreadable — not used`); return null; }
        const st = await withTimeout(sync.ensure(ref), BOOT_WAIT);
        if (st !== 'ready') { log(`foreign class ${ref.id} (${prefixOf(ref.sha256)}) ${st} at boot — not used`); ui({ kind: 'class_source', event: 'missing', ref: refOut(ref), peer: null }); return null; }
        prep = store.prepare(ref);
      } else return null;
      active = true;
      mine = { prep, ref: compactRef({ ...prep.ref, verdict: prep.verdict }) };
      log(`my class is foreign: ${prep.ref.id} ${prefixOf(prep.ref.sha256)} key ${prep.key.slice(0, 16)} (${prep.ref.branch || 'no branch'}, verdict ${prep.verdict})`);
      return api.info(prep.ref.id);
    },
    /** FXG: a {kind:'class', id, ref} gift / profile entry → foreignCardFromRef result (a class card). */
    async cardFromRef(x, { from = null, holders = [], timeoutMs = 0, why = 'card', quiet = false } = {}) {
      const res = await foreignCardFromRef(x, { store, sync, parseRef: parseClRef, cardFor: api.cardFor, from, holders, timeoutMs });
      if (res.status !== 'ready') {
        log(`${why}: foreign ${x?.id} ${res.status}${res.reason ? ` (${res.reason})` : ''}`);
        if (res.ref && !quiet) ui({ kind: 'class_source', event: 'missing', ref: refOut(res.ref), peer: from ? { peer_id: from, name: nameOf(from) || undefined } : null });
      }
      return res;
    },
    cardFor(prep, ref) {
      const s = prep.shape || classShape(prep.def);
      return { card_id: `${prep.ref.id}#class`, kind: 'class', class_id: prep.ref.id, name: s.name, text: s.text, tags: ['foreign'], cl: ref, source: { ...ref, kind: 'class' } };
    },
    /** Slim snapshot fields (absent with no foreign class in play). */
    snapshotFields() {
      const h = sync.haveCsv();
      return { ...(mine ? { cl_ref_json: JSON.stringify(mine.ref) } : {}), ...(h ? { cl_have: h } : {}) };
    },
    /** Door fields of one member (mine: no peer id). */
    doorRef(peerId = null) { const r = peerId ? api.refOf(peerId) : mine?.ref; return r ? { cl_ref: compactRef(r) } : {}; },
    onPeerState(p) {
      if (!p?.peer_id || p.peer_id === selfId) return;
      if (p.cl_ref_json) notePeerRef(p.peer_id, p.cl_ref_json);
      if (p.cl_ref) notePeerRef(p.peer_id, p.cl_ref);   // a Door member record
      if (typeof p.cl_have === 'string' && p.cl_have) { active = true; sync.noteHave(p.peer_id, p.cl_have); }
      if (typeof p.cl_set === 'string' && p.cl_set && p.cl_set !== bundled.id.slice(0, 16) && !api._setWarned?.has(p.peer_id)) {
        (api._setWarned ||= new Set()).add(p.peer_id);
        log(`peer ${p.peer_id} ships another built-in class set (${p.cl_set} vs ours ${bundled.id.slice(0, 16)})`);
      }
    },
    /** Commit / reveal envelopes: start fetching the actor's foreign class at once (the owner holds it). */
    onEnvelope(env) {
      if (env?.type !== 'evt_action_commit' && env?.type !== 'evt_action_reveal') return;
      if (env.payload?.cl_ref) notePeerRef(env.actor_peer_id, env.payload.cl_ref);
    },
    /**
     * My reveal: the sha256 of every foreign class ref in play this action that I cannot run (sorted) — the
     * commits' cl_ref of this action plus `viewRefs` ([{id, ref}] of the units in my view).
     */
    async missingForReveal(tape, turn, round, viewRefs = []) {
      const refs = new Map();
      const add = (raw, from) => { const r = clRefOf(raw); if (r && !isBuiltin(r.id)) refs.set(clKey(r), { r, from }); };
      for (const env of tape || []) if (env?.type === 'evt_action_commit' && env.turn === turn && env.round === round && env.payload?.cl_ref) add(env.payload.cl_ref, env.actor_peer_id);
      for (const v of viewRefs) if (v?.ref && v.id !== selfId) add(v.ref, v.id);
      const out = [];
      for (const { r, from } of refs.values()) {
        const st = await withTimeout(sync.ensure(r, { from }), REVEAL_WAIT);
        const held = store.readyById(r.id);
        if (st !== 'ready' || (held && held.key !== clKey(r))) {
          out.push(r.sha256);
          const k = `${clKey(r)}|${turn}.${round}`;
          if (!missingNoticed.has(k)) { missingNoticed.add(k); log(`missing ${r.id} (${prefixOf(r.sha256)}) of ${from} at reveal (${st}) — the class is dormant in that action`); ui({ kind: 'class_source', event: 'missing', ref: refOut(r), peer: { peer_id: from, name: nameOf(from) || undefined } }); }
        }
      }
      return [...new Set(out)].sort().slice(0, MAX_MISSING);
    },
    /** Does this action need the gate? (a unit with a non-built-in class, or any cl_ref / cl_missing on the tape / mine). */
    needsGate(units, tape, { turn, round, myReveal } = {}) {
      if (mine || myReveal?.clRef || myReveal?.clMissing?.length) return true;
      if (units.some(u => u.class_id && !isBuiltin(u.class_id))) return true;
      return (tape || []).some(env => env?.type === 'evt_action_reveal' && env.turn === turn && env.round === round && (env.payload?.cl_ref || env.payload?.cl_missing?.length));
    },
    /**
     * Resolver gate, once per action right after the reveal list is final. units: [{id, class_id, ref?}] (ref
     * filled here from the known snapshot refs when absent). → gateClasses result; call suspend(res) right before
     * simulate and resume() right after.
     */
    async prepareResolution(reveals, tape, { turn, round, self, myReveal, units = [] }) {
      const refsBy = classRefsByActor(reveals, tape, turn, round, self, myReveal ? (myReveal.clRef || null) : undefined);
      const missing = clMissingUnion(reveals, tape, turn, round, self, myReveal?.clMissing || null);
      const us = units.map(u => ({ ...u, ref: u.ref || api.refOf(u.id) }));
      const status = new Map();
      for (const u of us) {
        if (!u.class_id || isBuiltin(u.class_id)) continue;
        const ref = refsBy.get(u.id) || clRefOf(u.ref);
        if (!ref || missing.has(ref.sha256)) continue;
        const k = clKey(ref);
        if (!status.has(k)) status.set(k, store.status(ref) === 'ready' ? 'ready' : await withTimeout(sync.ensure(ref, { from: u.id }), RESOLVE_WAIT));
      }
      const res = gateClasses(us, missing, (ref) => status.get(clKey(ref)) || store.status(ref), refsBy, isBuiltin, (id) => store.readyById(id)?.key ?? null);
      for (const ref of res.missing) log(`could not load ${ref.id} (${prefixOf(ref.sha256)}) by resolution T${turn}.R${round + 1} — dormant here, no state hash from me this action`);
      if (res.abstain && !res.missing.length) log(`T${turn}.R${round + 1}: a unit's foreign class has no usable ref — no state hash from me this action`);
      res.mineDormant = !!(mine && res.dormant.includes(mine.ref.id));
      if (res.mineDormant) log(`my class ${mine.ref.id} is dormant in T${turn}.R${round + 1} — a revealer cannot run it`);
      for (const [actor, tag] of res.tags) if (actor !== self && !tag.startsWith('cl:')) log(`T${turn}.R${round + 1} ${actor}: ${tag}`);
      return res;
    },
    /** Right before simulate (synchronous): the dormant classes leave CLASS_RULES; resume() puts them back. */
    suspend(res) { return res?.dormant?.length ? CL.suspendForeignClasses(res.dormant) : (CL.resumeForeignClasses(), []); },
    resume() { CL.resumeForeignClasses(); },
    /** Transport: libp2p /chaos/<dim>/classes/1 + Nostr bus `cl` fallback. */
    async attach({ libp2p, openConnTo, getBus, netStat = () => {}, forceBus = false }) {
      await attachDefsRpc({ proto: clProtocol(dimId), busKind: CL_BUS_KIND, selfId, handle: (m, o) => sync.handle(m, o), log, libp2p, openConnTo, getBus, netStat, forceBus,
        frameBytes: CL_FRAME_BYTES, busFrameBytes: CL_BUS_FRAME_BYTES, onTransport: (t) => { request = t.request; busRpc = t.busRpc; } });
    },
    /** Bus `cl` events addressed to us. */
    onBus(ev) { if (busRpc && ev?.to === selfId) busRpc.deliver(ev); },
  };
  return api;
}
