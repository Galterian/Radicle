// Foreign-skill handshake (program chaosD6-Skills, milestone S4, user-approved 2026-11-16).
//
// The skills twin of effects-handshake.mjs (E4): "players create skills on branches; peers lacking a skill
// are told its branch, load it, and pass it on — the same as effects". Design note: game/skills-data/HANDSHAKE.md.
//
// Built-in skills (SKILL_RULES / data/skills.json / the bundled game/skills-data/skills/*.json) travel by NAME in
// the reveal's `skills` list, exactly as before. A FOREIGN skill — a definition from a player branch of
// chaosD6-Skills, with an id that is not a built-in — travels by NAME + REF, and every peer runs the same bytes
// (content addressed: sha256 of the canonical JSON, libraries pinned).
//
//   ref    { id, sha256, libs: { <lib id>: <sha256> }, repo?, branch?, commit?, name?, verdict? }   (as E4)
//   skKey(ref) = sha256(canonical {skill: ref.sha256, libs: ref.libs})      the pin of one runnable skill
//   skillSetId({libs, skills}) = sha256(canonical {libs:{id:sha}, skills:{id:sha}})   a peer's bundled set
//
// Wire (all absent unless a foreign skill is in play — built-in games are byte-identical):
//   commit  payload.sk_ref = [ref…]       the foreign skill cards riding on my action (fetch window commit→reveal)
//   reveal  payload.sk_ref = [ref…]       the same refs; THE ONLY thing a foreign skill resolves from
//           payload.sk_missing = [sha256…] foreign refs committed this action that THIS revealer cannot run
//   state   sk_have = "id@sha16,…" (slim snapshot)   sk_set = sha16 of my bundled skill set (full heartbeat)
//   fetch   libp2p /chaos/<dim>/skills/1 (own protocol, same framing + messages as /effects/1, wire kind 'skill'),
//           Nostr bus `sk` events when no direct link, then git (CHAOSD6_SKILLS_DIR) / radicle-httpd.
//
// Deterministic fallback (HANDSHAKE.md): a skill rides on an action, there is no cast to postpone. If ANY reveal
// of the action lists a foreign skill's sha in sk_missing, that skill is STRIPPED from its reveal on every peer
// before the skill passes run (the action resolves bare; the owner's card returns to hand, Rule 8 "never
// executed"). A peer that still lacks a non-stripped foreign skill at resolution waits ≤ SK_RESOLVE_WAIT_MS,
// then strips it too and ABSTAINS from the state hash for that action.
//
// The skill program engine is S2's (game/skills.mjs): registerForeignSkill(key, id, flags, {hook: program}, {meta,
// uses, libs, name, version}) binds a definition so every skillHook call folds it in; validateSkillDef checks it
// first; isForeignSkillId(id). Without the engine every foreign skill is refused (deterministically: every peer of
// the same build refuses) and stripped through sk_missing.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256Hex, skillHash, parseSkillRef, getSkillByRef, createSkillCache, skillsCacheDir,
  httpdSkillFetcher, gitSkillFetcher, SKILLS_RID, SkillRefError } from './skills-repo.mjs';
import { libShaMap, compactRef, createMemoryCache, createFxSync, parseLibbedRef, attachDefsRpc, prefixOf, foreignCardFromRef } from './effects-handshake.mjs';   // FXG: foreignCardFromRef
import * as SK from './skills.mjs';

export { compactRef, prefixOf, createMemoryCache };
export const SK_PROTOCOL_VERSION = 1;
export const skProtocol = (dimId) => `/chaos/${dimId}/skills/1`;
export const SK_BUS_KIND = 'sk';
export const SK_FRAME_BYTES = 32 * 1024;
export const SK_BUS_FRAME_BYTES = 24 * 1024;
const SHA_RE = /^[0-9a-f]{64}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DATA_DIR = path.join(HERE, 'skills-data');
const MAX_REFS = 8;   // skills riding on one action (a hand holds 5 cards)

// ------------------------------------------------------------------ set ids / refs
/** Deterministic id of the skills a peer ships: sha256(canonical {libs:{id:sha}, skills:{id:sha}}). */
export function skillSetId({ libs = {}, skills = {} } = {}) { return sha256Hex(canonicalJson({ libs, skills })); }
/** The pin of one runnable skill: its sha256 + the sha256 of every library it uses. */
export function skKey(ref) { return sha256Hex(canonicalJson({ skill: ref.sha256, libs: ref.libs || {} })); }

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const jsonFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f)) : []);
function dataSkillIds() {
  try { return readJson(path.join(HERE, '..', 'data', 'skills.json')).entries.map(e => e.id).filter(Boolean); } catch { return []; }
}
/**
 * The bundled skill set: game/skills-data/skills/*.json + lib/*.json (S2). Until S2 ships definition files the
 * set hashes the SKILL_RULES table entries ({id, rule}) so the id is still stable per build.
 * builtinIds = SKILL_RULES ∪ data/skills.json ∪ bundled files — every id that travels by name.
 */
export function bundledSkillSet(dir = process.env.SKILL_DEFS_DIR || SKILLS_DATA_DIR) {
  const skills = new Map(), libs = new Map();
  for (const f of jsonFiles(path.join(dir, 'lib'))) { try { const l = readJson(f); if (l?.id) libs.set(l.id, l); } catch {} }
  for (const f of jsonFiles(path.join(dir, 'skills'))) { try { const d = readJson(f); if (d?.id) skills.set(d.id, d); } catch {} }
  const set = { libs: libShaMap(libs), skills: {} };
  let source = 'files';
  if (!skills.size) {
    source = 'table';
    for (const id of Object.keys(SK.SKILL_RULES || {}).sort()) set.skills[id] = skillHash({ id, rule: SK.SKILL_RULES[id] });
  } else for (const id of [...skills.keys()].sort()) set.skills[id] = skillHash(skills.get(id));
  const builtinIds = new Set([...Object.keys(SK.SKILL_RULES || {}), ...dataSkillIds(), ...skills.keys()]);
  return { skills, libs, set, id: skillSetId(set), builtinIds, source };
}

/** A ref for skill `def` with its libraries pinned. `libs`: Map|array of lib objects or {name: sha}. */
export function makeSkRef(def, libs, { repo = '', branch = '', commit = '', verdict = null } = {}) {
  const uses = [...(def.uses || [])].sort();
  const byName = libs instanceof Map ? Object.fromEntries([...libs].map(([k, l]) => [k, skillHash(l)]))
    : Array.isArray(libs) ? libShaMap(libs) : { ...(libs || {}) };
  const pinned = {};
  for (const u of uses) {
    const s = typeof byName[u] === 'string' ? byName[u] : byName[u] && skillHash(byName[u]);
    if (!s) throw new SkillRefError('bad-def', `${def.id}: library ${u} is not available to pin`);
    pinned[u] = s;
  }
  const name = String(def.name || def.data?.name || '');
  const ref = { id: def.id, sha256: skillHash(def), libs: pinned, repo: String(repo || ''), branch: String(branch || ''), commit: String(commit || ''), name };
  if (verdict) ref.verdict = verdict;
  return parseSkRef(ref);
}
/** Validate a skill ref received from the network → normalised copy (throws SkillRefError). */
export function parseSkRef(ref) { return parseLibbedRef(ref, parseSkillRef, SkillRefError); }

/** What the resolver / cards read of a skill definition (top level, or under `data` as in data/skills.json). */
export function skillShape(def) {
  const d = def && typeof def.data === 'object' && def.data ? def.data : {};
  const pick = (...ks) => { for (const k of ks) { if (def?.[k] !== undefined) return def[k]; if (d[k] !== undefined) return d[k]; } return undefined; };
  const pbs = pick('point_buy_stat', 'pointBuyStat');
  return {
    action_type: pick('action_type', 'action') ?? null,
    is_permanent: !!pick('is_permanent', 'permanent'),
    point_buy_stat: pbs == null ? null : (pbs === 'any' || String(pbs).startsWith('stat_') ? String(pbs) : `stat_${pbs}`),
    name: String(pick('name') || def?.id || ''),
    text: String(pick('text') || ''),
    flags: pick('flags', 'rule') || {},
  };
}
/**
 * The S2 engine from skills.mjs, or null while it is not there:
 *   register(key, id, flags, hooks = {hookName: program}, {meta, uses, libs, name, version})  throws on a bad def
 *   validate(def, {libs}) → [errors]      isForeign(id) → bool
 * A registered foreign skill joins every data hook it has a program for (after the built-ins, ids in code-unit
 * order) — the resolver's skillHook calls reach it without any peer.mjs change.
 */
export function skillsEngine(mod = SK) {
  if (typeof mod?.registerForeignSkill !== 'function') return null;
  return { register: mod.registerForeignSkill, validate: typeof mod.validateSkillDef === 'function' ? mod.validateSkillDef : null,
    isForeign: typeof mod.isForeignSkillId === 'function' ? mod.isForeignSkillId : null };
}

// ------------------------------------------------------------------ store: what this peer holds
// validate(def) → { verdict, reasons } | null (S5 checkSkill). engine: skillsEngine() (null = no program engine → refuse).
export function createSkStore({ bundled = null, builtinIds = null, validate = null, engine = null, onReady = null, log = () => {} } = {}) {
  const defs = new Map(), libs = new Map();
  const prepared = new Map();      // skKey -> { status, ref, key, def, shape, hooks, flags, verdict, reason }
  const keyById = new Map();       // foreign id -> skKey of the one accepted definition (first accepted wins)
  const builtin = builtinIds || bundled?.builtinIds || new Set();
  if (bundled) for (const l of bundled.libs.values()) libs.set(skillHash(l), l);
  const addDef = (d) => { const s = skillHash(d); if (!defs.has(s)) defs.set(s, d); return s; };
  const addLib = (l) => { const s = skillHash(l); if (!libs.has(s)) libs.set(s, l); return s; };
  function prepare(ref) {
    const key = skKey(ref);
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
      // Skills dispatch by id (skills.mjs hooks test r.skills ids), so a foreign skill needs its own id: a branch
      // variant of a built-in is a new id that `extends` it.
      if (builtin.has(def.id)) throw new Error(`${def.id} is a built-in skill id — a branch variant needs its own id (extends: ${def.id})`);
      if (keyById.has(def.id) && keyById.get(def.id) !== key) throw new Error(`another foreign ${def.id} is already loaded (one definition per id)`);
      if (!engine) throw new Error('no skill program engine (game/skills.mjs#registerForeignSkill missing)');
      const libsCopy = libObjs.map(l => structuredClone(l));
      const errs = engine.validate ? engine.validate(def, { libs: libsCopy }) : [];
      if (errs.length) throw new Error(`invalid skill definition: ${errs.slice(0, 3).join('; ')}`);
      const shape = skillShape(def);
      let verdict = 'unchecked', reasons = [];
      if (validate) {
        try { const v = validate(def); verdict = v?.verdict || 'unchecked'; reasons = v?.reasons || []; }
        catch (e) { verdict = 'reject'; reasons = [`validator error: ${e.message}`]; }
      }
      if (verdict === 'reject') res = { status: 'rejected', reason: `rebalance verdict reject${reasons.length ? `: ${reasons.join('; ')}` : ''}`, verdict };
      else {
        // Registered HERE, before the definition counts as ready: a peer that says "ready" always runs it.
        // uses / libs are exactly the pinned ones (a def needing skills_std must `use` it — then its bytes are pinned).
        const runnable = structuredClone(def);
        const flags = structuredClone(shape.flags && typeof shape.flags === 'object' ? shape.flags : {});
        const hooks = structuredClone(runnable.hooks || {});
        engine.register(key, def.id, flags, hooks, { meta: { action_type: shape.action_type, is_permanent: shape.is_permanent, point_buy_stat: shape.point_buy_stat },
          uses: [...(def.uses || [])], libs: libsCopy, name: shape.name, version: String(def.version || '0.0.0') });
        keyById.set(def.id, key);
        res = { status: 'ready', def: runnable, shape, hooks, flags, verdict };
      }
    } catch (e) { res = { status: 'rejected', reason: e.message, verdict: null }; }
    const out = { ...res, ref, key };
    prepared.set(key, out);
    if (out.status === 'ready') onReady?.(out);
    else log(`skill ${ref.id} (${prefixOf(ref.sha256)}) refused: ${out.reason}`);
    return out;
  }
  return {
    addDef, addLib, prepare,
    hasDef: (s) => defs.has(s), hasLib: (s) => libs.has(s), getDef: (s) => defs.get(s) || null, getLib: (s) => libs.get(s) || null,
    status: (ref) => prepared.get(skKey(ref))?.status || 'missing',
    prepared: (key) => prepared.get(key) || null,
    ready: () => [...prepared.values()].filter(p => p.status === 'ready'),
    readyById: (id) => { const k = keyById.get(id); const p = k && prepared.get(k); return p?.status === 'ready' ? p : null; },
    isBuiltin: (id) => builtin.has(id),
  };
}

/** Sync (fetch / serve / have / prefetch): createFxSync of E4 with the skill kind. */
export function createSkSync(o) {
  return createFxSync({ ...o, kind: 'skill', parseRef: parseSkRef, getByRef: getSkillByRef, keyOf: skKey });
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
const parseRefList = (list) => {
  const out = new Map();
  for (const raw of (Array.isArray(list) ? list : []).slice(0, MAX_REFS)) {
    try { const r = parseSkRef(raw); if (!out.has(r.id)) out.set(r.id, r); } catch {}
  }
  return out;
};
/** actor → Map(skill id → ref) from the reveals the resolver uses (mine from my own reveal record). */
export function skillRefsByActor(reveals, tape, turn, round, self = null, selfRefs = null) {
  const first = firstRevealPerActor(tape, turn, round);
  const m = new Map();
  for (const r of reveals) m.set(r.actor, parseRefList(r.actor === self && Array.isArray(selfRefs) ? selfRefs : first.get(r.actor)?.payload?.sk_ref));
  return m;
}
/** Union of the sk_missing lists of the reveals the resolver uses (the same set on every peer). */
export function skMissingUnion(reveals, tape, turn, round, self = null, selfMissing = null) {
  const first = firstRevealPerActor(tape, turn, round);
  const out = new Set();
  for (const r of reveals) {
    const list = r.actor === self && Array.isArray(selfMissing) ? selfMissing : first.get(r.actor)?.payload?.sk_missing;
    if (Array.isArray(list)) for (const s of list.slice(0, 16)) if (typeof s === 'string' && SHA_RE.test(s)) out.add(s);
  }
  return out;
}
/**
 * The S4 rule on the resolver's reveal list (r.skills REPLACED, never mutated in place). Per reveal, per skill id
 * that is not a built-in (sorted):
 *   no ref for it in the reveal          → stripped                          tag 'bad:<id>'
 *   ref sha in any sk_missing            → stripped (on every peer)          tag 'stripped:<key16>'
 *   ready here                           → kept (skills.mjs runs it)          tag 'sk:<key16>'
 *   not ready here                       → stripped + abstain                tag 'missing:<key16>'
 * → { tags: Map(actor → 'tag,tag'), abstain, stripped: Map(actor → [ids]), missing: [ref] }. Built-in ids untouched.
 */
export function gateSkills(reveals, missing, statusOf, refsByActor, isBuiltin) {
  const tags = new Map(), stripped = new Map(), missingRefs = [];
  let abstain = false;
  for (const r of reveals) {
    const ids = Array.isArray(r.skills) ? r.skills : [];
    const foreign = ids.filter(id => !isBuiltin(id));
    if (!foreign.length) continue;
    const refs = refsByActor.get(r.actor) || new Map();
    const drop = new Set(), parts = [];
    for (const id of [...new Set(foreign)].sort()) {
      const ref = refs.get(id);
      if (!ref) { drop.add(id); parts.push(`bad:${id}`); continue; }
      const k16 = skKey(ref).slice(0, 16);
      if (missing.has(ref.sha256)) { drop.add(id); parts.push(`stripped:${k16}`); continue; }
      if (statusOf(ref) === 'ready') { parts.push(`sk:${k16}`); continue; }
      drop.add(id); abstain = true; missingRefs.push(ref); parts.push(`missing:${k16}`);
    }
    if (drop.size) { r.skills = ids.filter(id => !drop.has(id)); stripped.set(r.actor, [...drop].sort()); }
    tags.set(r.actor, parts.join(','));
  }
  return { tags, abstain, stripped, missing: missingRefs };
}

// ------------------------------------------------------------------ the peer adapter (peer.mjs glue)
const envMs = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= 0 ? v : dflt; };
export async function createSkPeer({ selfId, label = selfId, dimId, ui = () => {}, log: logIn = null, nameOf = () => null, engine: engineIn, validate: validateIn } = {}) {
  const log = logIn || ((line) => console.log(`[${label}] sk: ${line}`));
  const bundled = bundledSkillSet();
  const engine = engineIn !== undefined ? engineIn : skillsEngine();
  let validate = validateIn ?? null, validatorInfo = validateIn ? 'injected' : 'none';
  if (validateIn === undefined && process.env.SK_VALIDATOR !== '0') {
    try {
      const m = await import('./tools/skills-rebalancing-check.mjs');
      if (typeof m.checkSkill === 'function') { validate = (def) => m.checkSkill(def); validatorInfo = `skills-rebalancing-check ${m.VALIDATOR_VERSION || '?'}`; }
    } catch (e) { validatorInfo = `absent (${e.message.slice(0, 60)})`; }
  }
  // SK_ACCEPT=0: this player refuses every foreign skill (local policy) — its reveals list them in sk_missing,
  // so those skills are stripped for everybody in the action.
  if (process.env.SK_ACCEPT === '0') { validate = () => ({ verdict: 'reject', reasons: ['SK_ACCEPT=0: this player refuses foreign skills'] }); validatorInfo = 'SK_ACCEPT=0 (refuse all)'; }
  const cache = process.env.CHAOSD6_SKILLS_CACHE === 'memory' ? createMemoryCache() : createSkillCache({ dir: skillsCacheDir() });
  const fallbackFetchers = [];
  if (process.env.CHAOSD6_SKILLS_DIR) fallbackFetchers.push(gitSkillFetcher({ dir: process.env.CHAOSD6_SKILLS_DIR }));
  if (process.env.SK_HTTPD !== '0') {
    const httpd = httpdSkillFetcher({ seedHost: process.env.CHAOSD6_SKILLS_SEED || undefined });
    fallbackFetchers.push(async (r) => (r.commit && (r.repo || !SKILLS_RID.includes('TODO')) ? httpd(r) : null));
  }
  const refOut = (ref, verdict) => ({ ...compactRef(ref), kind: 'skill', ...(verdict ? { verdict } : {}) });
  const notice = (event, prep, peer) => ui({ kind: 'skill_source', event, ref: refOut(prep.ref, prep.verdict), peer: peer ? { peer_id: peer, name: nameOf(peer) || undefined } : null });
  const store = createSkStore({ bundled, validate, engine, log });   // ready = registered with skills.mjs (registerForeignSkill)
  let request = null;
  let active = false;
  const sync = createSkSync({
    selfId, store, cache, fallbackFetchers, log, opts: process.env.SK_PREFETCH === '0' ? { prefetch: false } : {},   // FXG: SK_PREFETCH=0 (tests) — no sk_have prefetch
    request: (peerId, msg) => (request ? request(peerId, msg) : Promise.reject(Object.assign(new Error('no transport yet'), { code: 'NO_ROUTE' }))),
    onLearned: (p, src) => { active = true; log(`learned ${p.ref.id} (${prefixOf(p.ref.sha256)}, ${p.ref.branch || 'no branch'}, verdict ${p.verdict}) from ${src}`); notice('learned', p, src && src.startsWith('peer:') ? src : null); },
    onShared: (p, peer) => { log(`shared ${p.ref.id} (${prefixOf(p.ref.sha256)}) with ${peer}`); notice('shared', p, peer); },
  });
  let busRpc = null;
  const REVEAL_WAIT = envMs('SK_REVEAL_WAIT_MS', 1500), RESOLVE_WAIT = envMs('SK_RESOLVE_WAIT_MS', 4000);
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r('missing'), ms).unref?.())]);
  const missingNoticed = new Set();
  log(`bundled skill set ${bundled.id.slice(0, 16)} (${bundled.source}: ${Object.keys(bundled.set.skills).length} skills, ${bundled.libs.size} libs), engine ${engine ? 'skills.mjs' : 'none (foreign skills refused)'}, validator ${validatorInfo}`);
  const isBuiltin = (id) => bundled.builtinIds.has(id);

  const api = {
    setId: bundled.id, bundled, store, sync, isBuiltin,
    get active() { return active; },
    /** Resolver data of a foreign skill I hold (action_type, is_permanent, point_buy_stat, name, text) or undefined. */
    skillData(id) { const p = store.readyById(id); return p ? { action_type: p.shape.action_type, is_permanent: p.shape.is_permanent, point_buy_stat: p.shape.point_buy_stat, name: p.shape.name, text: p.shape.text } : undefined; },
    /** FORCE_FOREIGN_SKILL=<def.json>: a player-branch skill in my deck (dev/test). → a skill card or null. */
    forcedCard(file) {
      let def;
      try { def = readJson(file); } catch (e) { log(`FORCE_FOREIGN_SKILL ${file}: ${e.message}`); return null; }
      try {
        const libObjs = (def.uses || []).map(u => { const l = bundled.libs.get(u); if (!l) throw new Error(`library ${u} not bundled`); return l; });
        const slug = String(def.id || '').replace(/^skill_/, '').replace(/_/g, '-');
        const ref0 = makeSkRef(def, libObjs, { repo: process.env.SK_FORCE_REPO || '', branch: process.env.SK_FORCE_BRANCH || `players/local/${slug}`, commit: process.env.SK_FORCE_COMMIT || '' });
        const prep = sync.adopt(def, ref0, libObjs);
        if (prep.status !== 'ready') { log(`FORCE_FOREIGN_SKILL ${def.id}: refused (${prep.reason || prep.status})`); return null; }
        active = true;
        const ref = compactRef({ ...prep.ref, verdict: prep.verdict });
        log(`foreign skill in my deck: ${def.id} ${prefixOf(ref.sha256)} key ${prep.key.slice(0, 16)} (${ref.branch}, verdict ${prep.verdict})`);
        return api.cardFor(prep, ref);
      } catch (e) { log(`FORCE_FOREIGN_SKILL ${file}: ${e.message}`); return null; }
    },
    cardFor(prep, ref) {
      const s = prep.shape;
      return {
        card_id: `${prep.def.id}#${randomBytes(3).toString('hex')}`, kind: 'skill', skill_id: prep.def.id, name: s.name, requires: s.action_type, is_trance: false,
        text: s.text, tags: ['foreign'], is_permanent: s.is_permanent, sk: ref, source: { ...ref, kind: 'skill' },
      };
    },
    /** FXG: a {kind:'skill', id, ref} gift / profile card → foreignCardFromRef result (refused / missing → log + UI notice). */
    async cardFromRef(x, { from = null, holders = [], timeoutMs = 0, why = 'card', quiet = false } = {}) {
      const res = await foreignCardFromRef(x, { store, sync, parseRef: parseSkRef, cardFor: api.cardFor, from, holders, timeoutMs });
      if (res.status === 'ready') active = true;
      else {
        log(`${why}: foreign ${x?.id} ${res.status}${res.reason ? ` (${res.reason})` : ''}`);
        if (res.ref && !quiet) ui({ kind: 'skill_source', event: 'missing', ref: refOut(res.ref), peer: from ? { peer_id: from, name: nameOf(from) || undefined } : null });
      }
      return res;
    },
    /** Slim snapshot fields (absent with no foreign skill held). */
    snapshotFields() { const h = sync.haveCsv(); return h ? { sk_have: h } : {}; },
    onPeerState(p) {
      if (!p?.peer_id) return;
      if (typeof p.sk_have === 'string' && p.sk_have) { active = true; sync.noteHave(p.peer_id, p.sk_have); }
      if (typeof p.sk_set === 'string' && p.sk_set && p.sk_set !== bundled.id.slice(0, 16) && !api._setWarned?.has(p.peer_id)) {
        (api._setWarned ||= new Set()).add(p.peer_id);
        log(`peer ${p.peer_id} ships another built-in skill set (${p.sk_set} vs ours ${bundled.id.slice(0, 16)})`);
      }
    },
    /** Commit / reveal envelopes: start fetching every foreign skill ref at once (the owner holds it). */
    onEnvelope(env) {
      if (env?.type !== 'evt_action_commit' && env?.type !== 'evt_action_reveal') return;
      const list = env.payload?.sk_ref;
      if (!Array.isArray(list) || !list.length) return;
      active = true;
      for (const ref of list.slice(0, MAX_REFS)) sync.ensure(ref, { from: env.actor_peer_id }).catch(() => {});
    },
    /** My reveal: the sha256 of every foreign skill ref committed this action that I cannot run (sorted). */
    async missingForReveal(tape, turn, round) {
      const refs = new Map();
      for (const env of tape || []) {
        if (env?.type !== 'evt_action_commit' || env.turn !== turn || env.round !== round || !Array.isArray(env.payload?.sk_ref)) continue;
        for (const r of parseRefList(env.payload.sk_ref).values()) refs.set(skKey(r), { r, from: env.actor_peer_id });
      }
      const out = [];
      for (const { r, from } of refs.values()) {
        const st = await withTimeout(sync.ensure(r, { from }), REVEAL_WAIT);
        if (st !== 'ready') {
          out.push(r.sha256);
          const k = `${skKey(r)}|${turn}.${round}`;
          if (!missingNoticed.has(k)) { missingNoticed.add(k); log(`missing ${r.id} (${prefixOf(r.sha256)}) from ${from} at reveal (${st}) — the skill is stripped from that action`); ui({ kind: 'skill_source', event: 'missing', ref: refOut(r), peer: { peer_id: from, name: nameOf(from) || undefined } }); }
        }
      }
      return [...new Set(out)].sort();
    },
    /** Does this action need the gate at all? (any non-built-in id in a reveal, or any sk_ref on the tape / mine). */
    needsGate(reveals, tape, { turn, round, myReveal } = {}) {
      if (myReveal?.skillRefs?.length) return true;
      if (reveals.some(r => (r.skills || []).some(id => !isBuiltin(id)))) return true;
      return (tape || []).some(env => env?.type === 'evt_action_reveal' && env.turn === turn && env.round === round && (env.payload?.sk_ref?.length || env.payload?.sk_missing?.length));
    },
    /**
     * Resolver gate, once per action right after the reveal list is final (sorted, corpses out), BEFORE the
     * building-skill injection and every skill pass. myReveal: peer.mjs myLastReveal (skillRefs / skMissing).
     * → gateSkills result + mine: [ids of my skills stripped this action].
     */
    async prepareResolution(reveals, tape, { turn, round, self, myReveal }) {
      const refsBy = skillRefsByActor(reveals, tape, turn, round, self, myReveal?.skillRefs || null);
      const missing = skMissingUnion(reveals, tape, turn, round, self, myReveal?.skMissing || null);
      const status = new Map();
      for (const r of reveals) {
        const refs = refsBy.get(r.actor);
        for (const id of r.skills || []) {
          const ref = !isBuiltin(id) && refs?.get(id);
          if (!ref || missing.has(ref.sha256)) continue;
          const k = skKey(ref);
          if (!status.has(k)) status.set(k, store.status(ref) === 'ready' ? 'ready' : await withTimeout(sync.ensure(ref, { from: r.actor }), RESOLVE_WAIT));
        }
      }
      const res = gateSkills(reveals, missing, (ref) => status.get(skKey(ref)) || store.status(ref), refsBy, isBuiltin);
      for (const ref of res.missing) log(`could not load ${ref.id} (${prefixOf(ref.sha256)}) by resolution T${turn}.R${round + 1} — skill stripped here, no state hash from me this action`);
      res.mine = res.stripped.get(self) || [];
      if (res.mine.length) log(`my ${res.mine.join(',')} stripped from T${turn}.R${round + 1} — a peer in this action lacks it; the card returns to my hand`);
      for (const [actor, tag] of res.tags) if (actor !== self) log(`T${turn}.R${round + 1} ${actor}: ${tag}`);
      return res;
    },
    /** Transport: libp2p /chaos/<dim>/skills/1 + Nostr bus `sk` fallback. */
    async attach({ libp2p, openConnTo, getBus, netStat = () => {}, forceBus = false }) {
      await attachDefsRpc({ proto: skProtocol(dimId), busKind: SK_BUS_KIND, selfId, handle: (m, o) => sync.handle(m, o), log, libp2p, openConnTo, getBus, netStat, forceBus,
        frameBytes: SK_FRAME_BYTES, busFrameBytes: SK_BUS_FRAME_BYTES, onTransport: (t) => { request = t.request; busRpc = t.busRpc; } });
    },
    /** Bus `sk` events addressed to us. */
    onBus(ev) { if (busRpc && ev?.to === selfId) busRpc.deliver(ev); },
  };
  return api;
}
