// Foreign-effect handshake (program chaosD6-Effects, milestone E4, user-approved 2026-11-15).
//
// "When a player faces an effect they don't have, he gets notified what branch this effect comes from so
//  he can load its jsonlogic rules. If that player gains that effect he should notify the next player."
//
// Built-in effects (the bundled main set: game/effects-data/effects/*.json + lib/*.json, or the JS
// EFFECT_RULES table) travel by NAME, exactly as before. A FOREIGN effect — a definition from a player
// branch of chaosD6-Effects that is not in the caster's bundled set — travels by REF, and every peer runs
// the very same bytes for it (content addressed: sha256 of the canonical JSON, libraries included).
// Design note with the reasoning: game/effects-data/HANDSHAKE.md.
// Kind-generic pieces reused by the skills handshake (S4, game/skills-handshake.mjs): createFxSync({kind, parseRef,
// getByRef, keyOf}), attachDefsRpc, parseLibbedRef, blobFrames/assembleBlob, createMemoryCache, libShaMap, compactRef.
//
//   ref (E3 + E4)  { id, sha256, libs: { <lib id>: <sha256> }, repo?, branch?, commit?, name?, verdict? }
//     libs     exactly the libraries the definition `uses`, pinned by hash (a std change = a new pin)
//     verdict  the caster's rebalance verdict — display only; every peer re-runs the validator
//   fxKey(ref) = sha256(canonical {effect: ref.sha256, libs: ref.libs})      the pin of one runnable effect
//   effectSetId({libs, effects}) = sha256(canonical {libs:{id:sha}, effects:{id:sha}})   a peer's whole set
//
// Wire (all fields absent unless a foreign effect is in play — built-in games are byte-identical):
//   commit  payload.fx_ref = ref                  (gives everybody the commit→reveal window to fetch)
//   reveal  payload.effects[0].ref = ref           payload.fx_missing = [sha256…]  (what THIS revealer lacks)
//   state   fx_have = "id@sha16,…"  (slim snapshot: what I hold and serve)   fx_set = sha16 of my bundled set
//   fetch   libp2p /chaos/<dim>/effects/1 (one stream per request, map-sync framing, ≤ 32 KB frames),
//           Nostr bus `fx` events (createBusRpc, ≤ 24 KB) when no direct link, then git / radicle-httpd.
//     → {t:'ref', prefix}                ← {t:'ref', ref} | {t:'none'}
//     → {t:'get', kind:'effect'|'lib', sha}  ← {t:'blob', kind, sha, i, n, s}… (canonical JSON in slices) | {t:'none'}
//     busy responder                     ← {t:'busy'}
//
// Deterministic fallback (HANDSHAKE.md): a foreign cast resolves only from the caster's reveal ref; if ANY
// reveal of the action lists its sha in fx_missing, the cast is POSTPONED on every peer (the reveal's
// effect is dropped from the resolver input; the caster re-emits next action, like a failed point-buy).
// A peer that still lacks a non-postponed foreign def at resolution waits ≤ FX_RESOLVE_WAIT_MS, then
// drops the cast too and ABSTAINS from the state hash for that action (it never publishes a guess).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalJson, sha256Hex, effectHash, parseEffectRef, getEffectByRef, createEffectCache, effectsCacheDir,
  httpdEffectFetcher, gitEffectFetcher, EFFECTS_RID, EffectRefError } from './effects-repo.mjs';
import { loadEffectDefs, resolveEffectData, EFFECTS_DATA_DIR } from './effect-engine.mjs';
import { encodeFrame, createFrameDecoder, createBusRpc } from './map-sync.mjs';
import { registerForeignEffect, EFFECT_RULES } from './effects.mjs';

export const FX_PROTOCOL_VERSION = 1;
export const fxProtocol = (dimId) => `/chaos/${dimId}/effects/1`;
export const FX_FRAME_BYTES = 32 * 1024;
export const FX_BUS_FRAME_BYTES = 24 * 1024;
const SHA_RE = /^[0-9a-f]{64}$/;
const PREFIX_RE = /^[0-9a-f]{16}$/;
const LIB_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const VERDICTS = new Set(['ok', 'nerf', 'boost', 'reject', 'unchecked']);
export const prefixOf = (sha) => String(sha || '').slice(0, 16);

// ------------------------------------------------------------------ set ids / refs

/** {id: sha256} of libraries (array or Map of lib objects), keys sorted. */
export function libShaMap(libs) {
  const list = libs instanceof Map ? [...libs.values()] : [...(libs || [])];
  const out = {};
  for (const l of list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) out[l.id] = effectHash(l);
  return out;
}
/** Deterministic id of what a peer runs: sha256(canonical {libs:{name:sha}, effects:{id:sha}}). */
export function effectSetId({ libs = {}, effects = {} } = {}) {
  return sha256Hex(canonicalJson({ libs, effects }));
}
/** The pin of one runnable effect: its sha256 + the sha256 of every library it uses. */
export function fxKey(ref) { return sha256Hex(canonicalJson({ effect: ref.sha256, libs: ref.libs || {} })); }

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const jsonFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f)) : []);
/** The bundled main set (effects-data/effects + lib) and its set id. */
export function bundledEffectSet(dir = process.env.EFFECT_DEFS_DIR || EFFECTS_DATA_DIR) {
  const effDir = fs.existsSync(path.join(dir, 'effects')) ? path.join(dir, 'effects') : dir;
  const libDir = fs.existsSync(path.join(dir, 'lib')) ? path.join(dir, 'lib') : path.join(effDir, '..', 'lib');
  const effects = new Map(), libs = new Map();
  for (const f of jsonFiles(libDir)) { try { const l = readJson(f); if (l?.id) libs.set(l.id, l); } catch {} }
  for (const f of jsonFiles(effDir)) { try { const d = readJson(f); if (d?.id) effects.set(d.id, d); } catch {} }
  const set = { libs: libShaMap(libs), effects: {} };
  for (const id of [...effects.keys()].sort()) set.effects[id] = effectHash(effects.get(id));
  return { effects, libs, set, id: effectSetId(set) };
}

/** A ref for `def` with its libraries pinned. `libs`: Map|array of lib objects or {name: sha}. */
export function makeFxRef(def, libs, { repo = '', branch = '', commit = '', verdict = null } = {}) {
  const uses = [...(def.uses || [])].sort();
  const byName = libs instanceof Map ? Object.fromEntries([...libs].map(([k, l]) => [k, effectHash(l)]))
    : Array.isArray(libs) ? libShaMap(libs) : { ...(libs || {}) };
  const pinned = {};
  for (const u of uses) {
    const s = typeof byName[u] === 'string' ? byName[u] : byName[u] && effectHash(byName[u]);
    if (!s) throw new EffectRefError('bad-def', `${def.id}: library ${u} is not available to pin`);
    pinned[u] = s;
  }
  const ref = { id: def.id, sha256: effectHash(def), libs: pinned, repo: String(repo || ''), branch: String(branch || ''), commit: String(commit || ''), name: String(def.name || '') };
  if (verdict) ref.verdict = verdict;
  return parseFxRef(ref);
}
/** Validate a ref received from the network → normalised copy (throws EffectRefError). */
export function parseFxRef(ref) { return parseLibbedRef(ref, parseEffectRef, EffectRefError); }
/** Kind-generic form (S4: skills reuse it with parseSkillRef / SkillRefError): base ref fields + `libs` pins. */
export function parseLibbedRef(ref, parseBase, RefError) {
  const base = parseBase(ref);
  const libs = {};
  const raw = ref.libs;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RefError('bad-ref', `ref ${base.id}: libs must be an object {name: sha256}`);
  const names = Object.keys(raw).sort();
  if (names.length > 16) throw new RefError('bad-ref', `ref ${base.id}: too many libs`);
  for (const n of names) {
    const s = String(raw[n] || '').toLowerCase();
    if (!LIB_RE.test(n) || !SHA_RE.test(s)) throw new RefError('bad-ref', `ref ${base.id}: bad lib pin ${n}`);
    libs[n] = s;
  }
  const out = { id: base.id, sha256: base.sha256, libs, repo: base.repo, branch: base.branch, commit: base.commit };
  if (typeof ref.name === 'string' && ref.name) out.name = ref.name.slice(0, 64);
  if (typeof ref.verdict === 'string' && VERDICTS.has(ref.verdict)) out.verdict = ref.verdict;
  return out;
}
/** Wire form: empty provenance fields dropped. */
export function compactRef(ref) {
  const o = { id: ref.id, sha256: ref.sha256, libs: ref.libs };
  for (const k of ['repo', 'branch', 'commit', 'name', 'verdict']) if (ref[k]) o[k] = ref[k];
  return o;
}

// ------------------------------------------------------------------ in-memory cache (tests / no disk)
export function createMemoryCache() {
  const m = new Map();
  const stats = { hits: 0, misses: 0, puts: 0, corrupt: 0 };
  return {
    dir: `mem:${randomBytes(4).toString('hex')}`, stats,
    has: (sha) => m.has(sha),
    get(sha) { const t = m.get(sha); if (!t) { stats.misses++; return null; } stats.hits++; return JSON.parse(t); },
    put(def) { const t = canonicalJson(def); const s = sha256Hex(t); m.set(s, t); stats.puts++; return s; },
    /** tests: overwrite a cache entry with arbitrary content */
    poison(sha, obj) { m.set(sha, JSON.stringify(obj)); },
  };
}

// ------------------------------------------------------------------ store: what this peer holds
// validate(def) → { verdict } | null (no validator). builtinRules: the EFFECT_RULES as built (before any
// foreign registration) — a foreign def reusing a built-in id must keep its flags (peer.mjs reads them).
export function createFxStore({ bundled = null, builtinRules = {}, validate = null, onReady = null, log = () => {} } = {}) {
  const defs = new Map(), libs = new Map();   // sha256 -> plain object
  const prepared = new Map();                  // fxKey -> { status: ready|rejected, ref, key, run, def, verdict, reason }
  const flagsById = new Map();                 // foreign id -> canonical flags (first accepted wins)
  const builtinFlags = new Map(Object.entries(builtinRules || {}).map(([k, v]) => [k, canonicalJson(v)]));
  if (bundled) {
    for (const l of bundled.libs.values()) libs.set(effectHash(l), l);
    for (const d of bundled.effects.values()) defs.set(effectHash(d), d);
  }
  const addDef = (d) => { const s = effectHash(d); if (!defs.has(s)) defs.set(s, d); return s; };
  const addLib = (l) => { const s = effectHash(l); if (!libs.has(s)) libs.set(s, l); return s; };
  function prepare(ref) {
    const key = fxKey(ref);
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
      const runnable = loadEffectDefs({ effects: [structuredClone(def)], libs: libObjs.map(l => structuredClone(l)) }).get(def.id);
      const flags = canonicalJson(def.flags || {});
      if (builtinFlags.has(def.id) && builtinFlags.get(def.id) !== flags) throw new Error(`flags differ from the built-in ${def.id}`);
      if (flagsById.has(def.id) && flagsById.get(def.id) !== flags) throw new Error(`another foreign ${def.id} with different flags is already loaded`);
      let verdict = 'unchecked', reasons = [];
      if (validate) {
        try { const v = validate(def); verdict = v?.verdict || 'unchecked'; reasons = v?.reasons || []; }
        catch (e) { verdict = 'reject'; reasons = [`validator error: ${e.message}`]; }
      }
      if (verdict === 'reject') res = { status: 'rejected', reason: `rebalance verdict reject${reasons.length ? `: ${reasons.join('; ')}` : ''}`, verdict };
      else {
        flagsById.set(def.id, flags);
        res = { status: 'ready', def: runnable, verdict, run: (ctx, cast) => resolveEffectData(runnable, ctx, cast) };
      }
    } catch (e) { res = { status: 'rejected', reason: e.message, verdict: null }; }
    const out = { ...res, ref, key };
    prepared.set(key, out);
    if (out.status === 'ready') onReady?.(out);
    else log(`effect ${ref.id} (${prefixOf(ref.sha256)}) refused: ${out.reason}`);
    return out;
  }
  return {
    addDef, addLib, prepare,
    hasDef: (s) => defs.has(s), hasLib: (s) => libs.has(s), getDef: (s) => defs.get(s) || null, getLib: (s) => libs.get(s) || null,
    status: (ref) => prepared.get(fxKey(ref))?.status || 'missing',
    prepared: (key) => prepared.get(key) || null,
    ready: () => [...prepared.values()].filter(p => p.status === 'ready'),
  };
}

// ------------------------------------------------------------------ blob framing (canonical JSON in slices)
export function blobFrames(kind, obj, maxBytes = FX_FRAME_BYTES) {
  const text = canonicalJson(obj), sha = sha256Hex(text);
  const parts = [];
  let budget = Math.max(512, Math.floor((maxBytes - 256) / 2));
  for (let i = 0; i < text.length;) {
    let s = text.slice(i, i + budget);
    while (Buffer.byteLength(JSON.stringify({ t: 'blob', kind, sha, i: 99999, n: 99999, s }), 'utf8') > maxBytes && s.length > 64) s = s.slice(0, Math.floor(s.length / 2));
    parts.push(s); i += s.length;
  }
  if (!parts.length) parts.push('');
  return parts.map((s, i) => ({ t: 'blob', kind, sha, i, n: parts.length, s }));
}
export function assembleBlob(msgs, sha) {
  const mine = (msgs || []).filter(m => m?.t === 'blob' && m.sha === sha && Number.isInteger(m.i) && Number.isInteger(m.n) && typeof m.s === 'string');
  if (!mine.length) return null;
  const n = mine[0].n, parts = new Array(n);
  for (const m of mine) if (m.n === n && m.i >= 0 && m.i < n) parts[m.i] = m.s;
  for (let i = 0; i < n; i++) if (typeof parts[i] !== 'string') return null;
  return parts.join('');
}

// ------------------------------------------------------------------ sync: fetch / serve / have
// request(peerId, msg) → Promise<{ msgs, via }> (throws {code:'NO_ROUTE'} when there is no transport).
// Kind-generic (S4): `kind` is the wire kind of a definition ('effect' | 'skill'; libraries are always 'lib'),
// `parseRef` / `getByRef` / `keyOf` the kind's ref parser, loader and pin key. The defaults are the E4 effect behaviour, unchanged.
export const FX_DEFAULTS = { prefetchGapMs: 10_000, serveBurst: 30, serveRefillMs: 300, prefetch: true };
export function createFxSync({ selfId, store, cache = createMemoryCache(), request = null, fallbackFetchers = [], now = () => Date.now(),
  log = () => {}, onLearned = null, onShared = null, opts = {}, kind: DEF = 'effect', parseRef = parseFxRef, getByRef = getEffectByRef, keyOf = fxKey }) {
  const o = { ...FX_DEFAULTS, ...opts };
  const holders = new Map();      // sha16 -> Map(peerId -> at)
  const inflight = new Map();     // fxKey -> Promise<status>
  const prefetchAt = new Map();   // sha16 -> last prefetch try (ms)
  const own = new Set();          // fxKeys we announce (forced + learned foreign effects)
  const sharedWith = new Set();   // `${key}|${peer}` — one 'shared' notice per pair
  const buckets = new Map();
  const stats = { fetched: 0, from_cache: 0, tampered: 0, failed: 0, served: 0, busy: 0, prefetches: 0 };
  const source = new Map();       // sha256 -> where it came from (peer id | 'cache' | 'fallback' | 'bundled')

  function noteHolder(sha16, peerId) {
    if (!PREFIX_RE.test(sha16) || !peerId || peerId === selfId) return;
    let m = holders.get(sha16);
    if (!m) holders.set(sha16, m = new Map());
    m.set(peerId, now());
  }
  // Who to ask: the peers that ANNOUNCED the effect, most recent first, then the caster (last resort) —
  // the load spreads along the "notify the next player" chain instead of piling on the author.
  function candidates(sha16, from) {
    const m = holders.get(sha16);
    const list = m ? [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([p]) => p) : [];
    const out = list.filter(p => p !== from && p !== selfId);
    if (from && from !== selfId) out.push(from);
    return out;
  }
  function peerFetcher(kind, cands, box) {
    return async (r) => {
      if (!request) return null;
      for (const p of cands) {
        try {
          const res = await request(p, { t: 'get', v: FX_PROTOCOL_VERSION, from: selfId, kind, sha: r.sha256 });
          const text = assembleBlob(res.msgs, r.sha256);
          if (text == null) continue;
          const obj = JSON.parse(text);
          if (effectHash(obj) !== r.sha256 || obj?.id !== r.id) { stats.tampered++; log(`${DEF} ${kind} ${r.id} from ${p} via ${res.via}: content does not match ${prefixOf(r.sha256)} — ignored`); continue; }
          box.peer = p; box.via = res.via;
          return obj;
        } catch (e) { if (e?.code !== 'NO_ROUTE') log(`${DEF} ${kind} ${r.id} from ${p} failed: ${e.message}`); }
      }
      return null;
    };
  }
  async function obtain(kind, id, sha, ref, cands) {
    if (kind === DEF ? store.hasDef(sha) : store.hasLib(sha)) return 'have';
    const box = {};
    const fetchers = [peerFetcher(kind, cands, box), ...(kind === DEF ? fallbackFetchers.map(f => async (r) => { const v = await f(r); if (v != null) box.peer = box.peer || 'fallback'; return v; }) : [])];
    const hitsBefore = cache.stats?.hits ?? 0;
    const obj = await getByRef({ id, sha256: sha, repo: kind === DEF ? ref.repo : '', branch: '', commit: kind === DEF ? ref.commit : '' }, { cache, fetch: fetchers });
    if (kind === DEF) store.addDef(obj); else store.addLib(obj);
    const src = box.peer || ((cache.stats?.hits ?? 0) > hitsBefore ? 'cache' : 'fallback');
    source.set(sha, src);
    if (src === 'cache') stats.from_cache++; else stats.fetched++;
    return src;
  }
  /** Make `ref` runnable here. → 'ready' | 'rejected' | 'missing'. Concurrent calls share one attempt. */
  function ensure(refIn, { from = null } = {}) {
    let ref;
    try { ref = parseRef(refIn); } catch (e) { return Promise.resolve('rejected'); }
    const key = keyOf(ref);
    noteHolder(prefixOf(ref.sha256), from);
    const st = store.status(ref);
    if (st !== 'missing') return Promise.resolve(st);
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const cands = candidates(prefixOf(ref.sha256), from);
      try {
        const src = await obtain(DEF, ref.id, ref.sha256, ref, cands);
        for (const [name, s] of Object.entries(ref.libs)) await obtain('lib', name, s, ref, cands);
        const prep = store.prepare(ref);
        if (prep.status === 'ready' && !own.has(key)) {
          own.add(key);
          onLearned?.(prep, src === 'have' ? (source.get(ref.sha256) || 'bundled') : src);
        }
        return prep.status;
      } catch (e) {
        stats.failed++;
        log(`${DEF} ${ref.id} (${prefixOf(ref.sha256)}) not obtained: ${e.message}`);
        return e?.code === 'sha-mismatch' || e?.code === 'id-mismatch' ? 'missing' : 'missing';
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  /** A def we created / were handed locally (forced effect): hold + announce it. */
  function adopt(def, ref, libObjs = []) {
    store.addDef(def); for (const l of libObjs) store.addLib(l);
    const prep = store.prepare(ref);
    if (prep.status === 'ready') { own.add(prep.key); source.set(ref.sha256, 'local'); }
    return prep;
  }
  function haveCsv() {
    return [...own].map(k => store.prepared(k)).filter(p => p?.status === 'ready')
      .map(p => `${p.ref.id}@${prefixOf(p.ref.sha256)}`).sort().join(',');
  }
  /** A peer's `fx_have` (heartbeat / state): remember it serves those; prefetch what we lack. */
  function noteHave(peerId, csv) {
    if (!peerId || peerId === selfId || typeof csv !== 'string' || !csv) return [];
    const started = [];
    for (const ent of csv.split(',').slice(0, 32)) {
      const [id, sha16] = ent.split('@');
      if (!id || !PREFIX_RE.test(sha16 || '')) continue;
      noteHolder(sha16, peerId);
      if (!o.prefetch || !request) continue;
      if (store.ready().some(p => prefixOf(p.ref.sha256) === sha16)) continue;
      const t = now();
      if (t - (prefetchAt.get(sha16) || -Infinity) < o.prefetchGapMs) continue;
      prefetchAt.set(sha16, t);
      stats.prefetches++;
      started.push((async () => {
        try {
          const res = await request(peerId, { t: 'ref', v: FX_PROTOCOL_VERSION, from: selfId, prefix: sha16 });
          const m = res.msgs.find(x => x?.t === 'ref');
          if (!m) return 'missing';
          const ref = parseRef(m.ref);
          if (prefixOf(ref.sha256) !== sha16 || ref.id !== id) return 'missing';
          return await ensure(ref, { from: peerId });
        } catch (e) { if (e?.code !== 'NO_ROUTE') log(`${DEF} prefetch ${id}@${sha16} from ${peerId}: ${e.message}`); return 'missing'; }
      })());
    }
    return started;
  }
  function allow(peerId) {
    const t = now();
    let b = buckets.get(peerId);
    if (!b) { b = { tokens: o.serveBurst, at: t }; buckets.set(peerId, b); }
    b.tokens = Math.min(o.serveBurst, b.tokens + (t - b.at) / o.serveRefillMs); b.at = t;
    if (b.tokens < 1) return false;
    b.tokens--; return true;
  }
  /** Responder: one request → response messages (each ≤ maxBytes of JSON). */
  function handle(msg, { maxBytes = FX_FRAME_BYTES } = {}) {
    if (!msg || typeof msg !== 'object') return [{ t: 'error', error: 'bad request' }];
    const from = typeof msg.from === 'string' ? msg.from : '?';
    if (!allow(from)) { stats.busy++; return [{ t: 'busy' }]; }
    if (msg.t === 'ref') {
      const p = PREFIX_RE.test(msg.prefix || '') ? store.ready().find(x => own.has(x.key) && prefixOf(x.ref.sha256) === msg.prefix) : null;
      return p ? [{ t: 'ref', ref: compactRef(p.ref) }] : [{ t: 'none' }];
    }
    if (msg.t === 'get') {
      const sha = String(msg.sha || '');
      if (!SHA_RE.test(sha)) return [{ t: 'error', error: 'bad sha' }];
      const obj = msg.kind === 'lib' ? store.getLib(sha) : store.getDef(sha);
      if (!obj) return [{ t: 'none' }];
      stats.served++;
      if (msg.kind !== 'lib') {
        const p = store.ready().find(x => own.has(x.key) && x.ref.sha256 === sha);
        if (p && !sharedWith.has(`${p.key}|${from}`)) { sharedWith.add(`${p.key}|${from}`); onShared?.(p, from); }
      }
      return blobFrames(msg.kind === 'lib' ? 'lib' : DEF, obj, maxBytes);
    }
    return [{ t: 'error', error: `unknown request ${String(msg.t).slice(0, 20)}` }];
  }
  return { ensure, adopt, noteHave, noteHolder, handle, haveCsv, candidates, stats: () => ({ ...stats }), source: (s) => source.get(s) || null };
}

// ------------------------------------------------------------------ FXG: foreign cards handed over outside play
// A death-card gift / a won card saved in a profile travels as { kind, id, ref } (ref = compactRef, the ref the
// card carried: card.fx for effects, card.sk for skills). Kind-generic (effects and skills): the def already held
// (store ready) → the card at once; otherwise the same sync.ensure as learning (cache first — getByRef checks the
// content cache before any fetcher — then the giving peer `from`, announced holders, git / httpd), validator gate
// included. Private deck state only: nothing here reaches the resolver or the state hash.
//   → { status: 'ready' | 'rejected' | 'missing' | 'bad', card?, ref?, prep?, src?, reason? }
export async function foreignCardFromRef(x, { store, sync, parseRef = parseFxRef, cardFor, from = null, holders = [], timeoutMs = 0 } = {}) {
  let ref;
  try { ref = parseRef(x?.ref); } catch (e) { return { status: 'bad', reason: e.message }; }
  if (!x?.id || ref.id !== x.id) return { status: 'bad', ref, reason: `ref id ${ref.id} ≠ card id ${x?.id}` };
  const mkCard = (prep) => cardFor(prep, compactRef({ ...prep.ref, verdict: prep.verdict }));
  const st0 = store.status(ref);
  if (st0 === 'ready') { const prep = store.prepare(ref); return { status: 'ready', card: mkCard(prep), ref, prep, held: true, src: sync.source(ref.sha256) || 'held' }; }
  if (st0 === 'rejected') { const prep = store.prepare(ref); return { status: 'rejected', ref, reason: prep.reason || 'refused' }; }
  for (const h of holders || []) if (h) sync.noteHolder(prefixOf(ref.sha256), h);
  let p = sync.ensure(ref, { from });
  if (timeoutMs > 0) p = Promise.race([p, new Promise(r => { const t = setTimeout(() => r('missing'), timeoutMs); t.unref?.(); })]);
  const st = await p;
  if (st !== 'ready') return { status: st === 'rejected' ? 'rejected' : 'missing', ref, reason: st === 'rejected' ? (store.prepare(ref).reason || 'refused') : 'not obtained' };
  const prep = store.prepare(ref);
  return { status: 'ready', card: mkCard(prep), ref, prep, src: sync.source(ref.sha256) || from || 'store' };
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
/** Union of the fx_missing lists of the reveals the resolver uses (the same set on every peer). */
export function missingUnion(reveals, tape, turn, round, self = null, selfMissing = null) {
  const first = firstRevealPerActor(tape, turn, round);
  const out = new Set();
  for (const r of reveals) {
    const list = r.actor === self && Array.isArray(selfMissing) ? selfMissing : first.get(r.actor)?.payload?.fx_missing;
    if (Array.isArray(list)) for (const s of list.slice(0, 16)) if (typeof s === 'string' && SHA_RE.test(s)) out.add(s);
  }
  return out;
}
/**
 * Applies the E4 rule to the resolver's reveal list IN PLACE (reveal.effect replaced, never mutated):
 *   ref sha in any fx_missing → effect dropped (postponed)    held & ready → effect.fx = {key}
 *   not held → effect dropped + abstain (no state hash for this action from this peer)
 * statusOf(ref) → 'ready' | 'rejected' | 'missing' (after any waiting). Returns
 *   { tags: Map(actor → 'fx:<key16>' | 'postponed:<key16>' | 'bad'), abstain, postponed: [actor], missing: [ref] }.
 */
export function gateReveals(reveals, missing, statusOf) {
  const tags = new Map(), postponed = [], missingRefs = [];
  let abstain = false;
  for (const r of reveals) {
    const raw = r.effect?.ref;
    if (!raw) continue;
    let ref;
    try { ref = parseFxRef(raw); } catch { r.effect = null; tags.set(r.actor, 'bad'); continue; }
    const k16 = fxKey(ref).slice(0, 16);
    if (missing.has(ref.sha256)) { r.effect = null; r.fxPostponed = k16; tags.set(r.actor, `postponed:${k16}`); postponed.push(r.actor); continue; }
    if (statusOf(ref) === 'ready') { r.effect = { ...r.effect, fx: { key: fxKey(ref) } }; tags.set(r.actor, `fx:${k16}`); continue; }
    r.effect = null; abstain = true; missingRefs.push(ref); tags.set(r.actor, `missing:${k16}`);
  }
  return { tags, abstain, postponed, missing: missingRefs };
}

// ------------------------------------------------------------------ transport (kind-generic, S4)
// One request per libp2p stream on `proto` (map-sync framing), else a createBusRpc exchange over bus events of
// type `busKind` ('fx' for effects, 'sk' for skills). `handle(msg, {maxBytes})` answers requests. onTransport is
// called with { request, busRpc } before the libp2p handler is registered (request may be used at once).
export async function attachDefsRpc({ proto, busKind, selfId, handle, log = () => {}, libp2p, openConnTo, getBus, netStat = () => {}, forceBus = false,
  frameBytes = FX_FRAME_BYTES, busFrameBytes = FX_BUS_FRAME_BYTES, timeoutMs = 10_000, onTransport = null }) {
  const PROTO = proto, TIMEOUT = timeoutMs;
  const fb = (m) => Buffer.byteLength(JSON.stringify(m), 'utf8') + 4;
  const busRpc = createBusRpc({ selfId, publish: (ev) => { const b = getBus(); return b ? b.publish(busKind, ev) > 0 : false; }, handle: (m, o) => handle(m, o), maxBytes: busFrameBytes });
  async function viaLibp2p(conn, msg) {
    const req = encodeFrame(msg);
    const stream = await conn.newStream(PROTO, { signal: AbortSignal.timeout(TIMEOUT) });
    const timer = setTimeout(() => stream.abort(new Error(`${busKind} rpc timeout`)), TIMEOUT);
    try {
      netStat('libp2p', 'out', busKind, req.length);
      if (!stream.send(req)) await stream.onDrain();
      await stream.close();
      const dec = createFrameDecoder(), msgs = [];
      for await (const chunk of stream) for (const m of dec.push(chunk instanceof Uint8Array ? chunk : chunk.subarray())) { msgs.push(m); netStat('libp2p', 'in', busKind, fb(m)); }
      return { msgs, via: 'libp2p' };
    } finally { clearTimeout(timer); }
  }
  const request = async (peerId, msg) => {
    const conn = forceBus ? null : openConnTo(peerId);
    if (conn) {
      try { return await viaLibp2p(conn, msg); }
      catch (e) { if (!getBus()?.stats().open) throw e; log(`rpc to ${peerId} over libp2p failed (${e.message}) — trying the bus`); }
    }
    if (!getBus()?.stats().open) throw Object.assign(new Error('no direct link and no bus'), { code: 'NO_ROUTE' });
    return busRpc.request(peerId, msg);
  };
  onTransport?.({ request, busRpc });
  await libp2p.handle(PROTO, async (stream) => {
    const timer = setTimeout(() => stream.abort(new Error(`${busKind} rpc timeout`)), TIMEOUT);
    try {
      const dec = createFrameDecoder(64 * 1024);
      let req = null;
      for await (const chunk of stream) for (const m of dec.push(chunk instanceof Uint8Array ? chunk : chunk.subarray())) req ??= m;
      if (!req) throw new Error(`empty ${busKind} request`);
      netStat('libp2p', 'in', busKind, fb(req));
      for (const m of handle(req, { maxBytes: frameBytes })) {
        const f = encodeFrame(m);
        netStat('libp2p', 'out', busKind, f.length);
        if (!stream.send(f)) await stream.onDrain();
      }
      await stream.close();
    } catch (e) { try { stream.abort(e); } catch {} }
    finally { clearTimeout(timer); }
  }, { maxInboundStreams: 8 });
  return { request, busRpc };
}

// ------------------------------------------------------------------ the peer adapter (peer.mjs glue)
const envMs = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= 0 ? v : dflt; };
export async function createFxPeer({ selfId, label = selfId, dimId, ui = () => {}, log: logIn = null, nameOf = () => null } = {}) {
  const log = logIn || ((line) => console.log(`[${label}] fx: ${line}`));
  const bundled = bundledEffectSet();
  const builtinRules = { ...EFFECT_RULES };
  let validate = null, validatorInfo = 'none';
  if (process.env.FX_VALIDATOR !== '0') {
    try {
      const m = await import('./tools/rebalancing-check.mjs');
      if (typeof m.checkEffect === 'function') { validate = (def) => m.checkEffect(def); validatorInfo = `rebalancing-check ${m.VALIDATOR_VERSION || '?'}`; }
    } catch (e) { validatorInfo = `absent (${e.message.slice(0, 60)})`; }
  }
  // FX_ACCEPT=0: this player refuses every foreign effect (local policy) — its reveals list them in fx_missing,
  // so such casts are postponed for everybody in the action (and the tests exercise that path).
  if (process.env.FX_ACCEPT === '0') { validate = () => ({ verdict: 'reject', reasons: ['FX_ACCEPT=0: this player refuses foreign effects'] }); validatorInfo = 'FX_ACCEPT=0 (refuse all)'; }
  const cache = process.env.CHAOSD6_EFFECTS_CACHE === 'memory' ? createMemoryCache() : createEffectCache({ dir: effectsCacheDir() });
  const fallbackFetchers = [];
  if (process.env.CHAOSD6_EFFECTS_DIR) fallbackFetchers.push(gitEffectFetcher({ dir: process.env.CHAOSD6_EFFECTS_DIR }));
  if (process.env.FX_HTTPD !== '0') {
    const httpd = httpdEffectFetcher({ seedHost: process.env.CHAOSD6_EFFECTS_SEED || undefined });
    // The placeholder RID would only produce a 404 round trip: ask the seed when the ref names a repo or the RID is set.
    fallbackFetchers.push(async (r) => (r.commit && (r.repo || !EFFECTS_RID.includes('TODO')) ? httpd(r) : null));
  }
  const notice = (event, prep, peer) => ui({ kind: 'effect_source', event, ref: { ...compactRef(prep.ref), ...(prep.verdict ? { verdict: prep.verdict } : {}) }, peer: peer ? { peer_id: peer, name: nameOf(peer) || undefined } : null });
  const store = createFxStore({
    bundled, builtinRules, validate, log,
    onReady: (p) => registerForeignEffect(p.key, p.def.id, p.def.flags, p.run),
  });
  let request = null, busRpc = null;
  let active = false;
  const sync = createFxSync({
    selfId, store, cache, fallbackFetchers, log, opts: process.env.FX_PREFETCH === '0' ? { prefetch: false } : {},   // FXG: FX_PREFETCH=0 (tests) — no fx_have prefetch
    request: (peerId, msg) => (request ? request(peerId, msg) : Promise.reject(Object.assign(new Error('no transport yet'), { code: 'NO_ROUTE' }))),
    onLearned: (p, src) => { active = true; log(`learned ${p.ref.id} (${prefixOf(p.ref.sha256)}, ${p.ref.branch || 'no branch'}, verdict ${p.verdict}) from ${src}`); notice('learned', p, src && src.startsWith('peer:') ? src : null); },
    onShared: (p, peer) => { log(`shared ${p.ref.id} (${prefixOf(p.ref.sha256)}) with ${peer}`); notice('shared', p, peer); },
  });
  const REVEAL_WAIT = envMs('FX_REVEAL_WAIT_MS', 1500), RESOLVE_WAIT = envMs('FX_RESOLVE_WAIT_MS', 4000), POSTPONE_MAX = envMs('FX_POSTPONE_MAX', 3);
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r('missing'), ms).unref?.())]);
  const postponedCount = new Map();   // card id -> consecutive postponements of my cast
  const missingNoticed = new Set();
  log(`bundled set ${bundled.id.slice(0, 16)} (${bundled.effects.size} effects, libs ${Object.entries(bundled.set.libs).map(([k, v]) => `${k}@${v.slice(0, 8)}`).join(' ')}), validator ${validatorInfo}`);

  const api = {
    setId: bundled.id, bundled, store, sync,
    get active() { return active; },
    /** FORCE_FOREIGN_EFFECT=<def.json>: a player-branch effect in my deck (dev/test). → an effect card or null. */
    forcedCard(file) {
      let def;
      try { def = readJson(file); } catch (e) { log(`FORCE_FOREIGN_EFFECT ${file}: ${e.message}`); return null; }
      try {
        const libObjs = (def.uses || []).map(u => { const l = bundled.libs.get(u); if (!l) throw new Error(`library ${u} not bundled`); return l; });
        const slug = String(def.id || '').replace(/^effect_/, '').replace(/_/g, '-');
        const ref0 = makeFxRef(def, libObjs, { repo: process.env.FX_FORCE_REPO || '', branch: process.env.FX_FORCE_BRANCH || `players/local/${slug}`, commit: process.env.FX_FORCE_COMMIT || '' });
        const prep = sync.adopt(def, ref0, libObjs);
        if (prep.status !== 'ready') { log(`FORCE_FOREIGN_EFFECT ${def.id}: refused (${prep.reason || prep.status})`); return null; }
        active = true;
        const ref = compactRef({ ...prep.ref, verdict: prep.verdict });
        log(`foreign effect in my deck: ${def.id} ${prefixOf(ref.sha256)} key ${prep.key.slice(0, 16)} (${ref.branch}, verdict ${prep.verdict})`);
        return api.cardFor(prep, ref);
      } catch (e) { log(`FORCE_FOREIGN_EFFECT ${file}: ${e.message}`); return null; }
    },
    cardFor(prep, ref) {
      const d = prep.def, f = d.flags || {};
      return {
        card_id: `${d.id}#${randomBytes(3).toString('hex')}`, kind: 'effect', effect_id: d.id, name: d.name,
        element_cost: [...d.elements], effect_types: [], is_permanent: !!f.permanent, is_damage: !!f.damage, is_point_buy: f.damage === 'pointbuy',
        is_instant: false, scope: f.scope || (f.teleportSelf ? 'tile' : 'self'),
        tile_target: !!f.tileTarget, takes_attach: !!(f.trapAttach || f.blessAttach), takes_link: !!f.spiritLink, takes_elem: !!f.altTileToken,
        text: d.text || '', tags: ['foreign'], summon: null,
        fx: ref, source: { ...ref },
      };
    },
    /** FXG: a {kind:'effect', id, ref} gift / profile card → foreignCardFromRef result (refused / missing → log + UI notice). */
    async cardFromRef(x, { from = null, holders = [], timeoutMs = 0, why = 'card', quiet = false } = {}) {
      const res = await foreignCardFromRef(x, { store, sync, parseRef: parseFxRef, cardFor: api.cardFor, from, holders, timeoutMs });
      if (res.status === 'ready') active = true;
      else {
        log(`${why}: foreign ${x?.id} ${res.status}${res.reason ? ` (${res.reason})` : ''}`);
        if (res.ref && !quiet) ui({ kind: 'effect_source', event: 'missing', ref: compactRef(res.ref), peer: from ? { peer_id: from, name: nameOf(from) || undefined } : null });
      }
      return res;
    },
    /** Slim snapshot fields (absent with no foreign effect held). */
    snapshotFields() { const h = sync.haveCsv(); return h ? { fx_have: h } : {}; },
    /** Every merged peer state. */
    onPeerState(p) {
      if (!p?.peer_id) return;
      if (typeof p.fx_have === 'string' && p.fx_have) { active = true; sync.noteHave(p.peer_id, p.fx_have); }
      if (typeof p.fx_set === 'string' && p.fx_set && p.fx_set !== bundled.id.slice(0, 16) && !api._setWarned?.has(p.peer_id)) {
        (api._setWarned ||= new Set()).add(p.peer_id);
        log(`peer ${p.peer_id} runs another bundled effect set (${p.fx_set} vs ours ${bundled.id.slice(0, 16)}) — data-engine casts may differ (EFFECT_ENGINE=${process.env.EFFECT_ENGINE || 'js'})`);
      }
    },
    /** Commit / reveal envelopes: start fetching any foreign ref at once (the caster holds it). */
    onEnvelope(env) {
      const ref = env?.type === 'evt_action_commit' ? env.payload?.fx_ref : env?.type === 'evt_action_reveal' ? env.payload?.effects?.[0]?.ref : null;
      if (!ref) return;
      active = true;
      sync.ensure(ref, { from: env.actor_peer_id }).catch(() => {});
    },
    /** My reveal: the sha256 of every foreign ref committed this action that I cannot run (sorted). */
    async missingForReveal(tape, turn, round) {
      const refs = new Map();
      for (const env of tape || []) {
        if (env?.type !== 'evt_action_commit' || env.turn !== turn || env.round !== round || !env.payload?.fx_ref) continue;
        try { const r = parseFxRef(env.payload.fx_ref); refs.set(fxKey(r), { r, from: env.actor_peer_id }); } catch {}
      }
      const out = [];
      for (const { r, from } of refs.values()) {
        const st = await withTimeout(sync.ensure(r, { from }), REVEAL_WAIT);
        if (st !== 'ready') {
          out.push(r.sha256);
          const k = `${fxKey(r)}|${turn}.${round}`;
          if (!missingNoticed.has(k)) { missingNoticed.add(k); log(`missing ${r.id} (${prefixOf(r.sha256)}) from ${from} at reveal (${st}) — the cast is postponed`); ui({ kind: 'effect_source', event: 'missing', ref: compactRef(r), peer: { peer_id: from, name: nameOf(from) || undefined } }); }
        }
      }
      return [...new Set(out)].sort();
    },
    /**
     * Resolver gate, called once per action right after the reveal list is final (sorted, corpses out).
     * myReveal: peer.mjs myLastReveal (its effectFx / fxMissing / effectCardId).
     */
    async prepareResolution(reveals, tape, { turn, round, self, myReveal }) {
      if (myReveal?.effectFx) for (const r of reveals) if (r.actor === self && r.effect && !r.effect.ref) r.effect = { ...r.effect, ref: myReveal.effectFx };
      const missing = missingUnion(reveals, tape, turn, round, self, myReveal?.fxMissing || null);
      const status = new Map();
      for (const r of reveals) {
        if (!r.effect?.ref) continue;
        let ref; try { ref = parseFxRef(r.effect.ref); } catch { continue; }
        if (missing.has(ref.sha256)) continue;
        const k = fxKey(ref);
        if (!status.has(k)) status.set(k, store.status(ref) === 'ready' ? 'ready' : await withTimeout(sync.ensure(ref, { from: r.actor }), RESOLVE_WAIT));
      }
      const res = gateReveals(reveals, missing, (ref) => status.get(fxKey(ref)) || store.status(ref));
      for (const ref of res.missing) log(`could not load ${ref.id} (${prefixOf(ref.sha256)}) by resolution T${turn}.R${round + 1} — cast dropped here, no state hash from me this action`);
      res.mine = res.postponed.includes(self) ? 'postponed' : null;
      if (res.mine && myReveal?.effectCardId) {
        const n = (postponedCount.get(myReveal.effectCardId) || 0) + 1;
        postponedCount.set(myReveal.effectCardId, n);
        res.giveUp = n > POSTPONE_MAX;
        log(`my ${myReveal.effectId} is postponed (${n}×) — a peer in this action lacks it${res.giveUp ? '; giving up, the card is spent' : ''}`);
      } else if (myReveal?.effectCardId) postponedCount.delete(myReveal.effectCardId);
      for (const [actor, tag] of res.tags) if (actor !== self) log(`T${turn}.R${round + 1} ${actor}: ${tag}`);
      return res;
    },
    /** Transport: libp2p protocol + Nostr bus fallback (attachDefsRpc, shared with the skills handshake). */
    async attach({ libp2p, openConnTo, getBus, netStat = () => {}, forceBus = false }) {
      await attachDefsRpc({ proto: fxProtocol(dimId), busKind: 'fx', selfId, handle: (m, o) => sync.handle(m, o), log, libp2p, openConnTo, getBus, netStat, forceBus,
        frameBytes: FX_FRAME_BYTES, busFrameBytes: FX_BUS_FRAME_BYTES, onTransport: (t) => { request = t.request; busRpc = t.busRpc; } });
    },
    /** Bus `fx` events addressed to us. */
    onBus(ev) { if (busRpc && ev?.to === selfId) busRpc.deliver(ev); },
  };
  return api;
}
