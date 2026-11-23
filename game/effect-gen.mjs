// Effect generation (2026-11-22): a player describes an effect in words; the big model (Qwen3-8B Q4_K_M on the
// desktop's 127.0.0.1:8096 or OCI's /llm-big — tools/llm/llama-run.sh LLM_TIER=big) writes a chaosd6.effect/2
// definition — flags, the JsonLogic program, card data — and THIS node tests it with the validator every peer runs on
// a foreign effect (tools/rebalancing-check.mjs checkEffect: schema + engine validation, the program run over the
// audit scenarios and held to its flags, the power price against the cost curve). Problems go back to the model
// for another attempt (GEN_ATTEMPTS, 3). The result is a local DRAFT only — nothing is published or playable until
// the player sends it through the chaosD6-Effects branch flow.
//
// Not on the planning clock: one request can take minutes on a CPU. The fixed part of the prompt (dialect, libraries,
// examples) comes first and never changes, so llama-server's prompt cache pays for it once per server start.
// Thinking stays off (chat_template_kwargs.enable_thinking false + "/no_think"); the answer is held to a JSON schema.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { ALL_ELEMS, loadEffectDefs, resolveEffectData } from './effect-engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'effects-data');
// Varied, std / e2a only, no standing programs (a new standing program is refused by the validator today).
export const GEN_EXAMPLES = Object.freeze(['effect_lightning', 'effect_meteor_shower', 'effect_sound_wave', 'effect_potion_brew', 'effect_shield', 'effect_poison']);
export const GEN_LIBS = Object.freeze(['std', 'e2a']);
export const GEN_KINDS = Object.freeze(['damage', 'lock', 'stat_token', 'permanent', 'counter', 'trap', 'relocation', 'meta']);
export const GEN_DURATIONS = Object.freeze(['instant', 'permanent', 'channel', 'trap']);

// file: <profile dir>/llm.json { big_url, big_key, remote_url, remote_key } — mode 600, written by `effect-gen.mjs --save-key`,
// never in the repo. The environment wins over the file.
export function readLlmFile(file) {
  try { return file ? JSON.parse(fs.readFileSync(file, 'utf8')) || {} : {}; } catch { return {}; }
}
export function genConfig(env = {}, { file = '' } = {}) {
  const f = readLlmFile(file);
  // the phone has no local big model: no default there (the Drafts page asks for the OCI URL + key)
  const url = String(env.LLM_BIG_URL ?? f.big_url ?? (env.CHAOSD6_MOBILE === '1' ? '' : 'http://127.0.0.1:8096')).replace(/\/+$/, '');
  return {
    url: url === '0' ? '' : url,
    key: String(env.LLM_BIG_KEY ?? f.big_key ?? env.LLM_KEY ?? f.remote_key ?? ''),
    model: env.LLM_BIG_MODEL || 'qwen3-8b',
    timeoutMs: Math.max(30_000, Number(env.LLM_BIG_TIMEOUT_MS) || 20 * 60_000),
    attempts: Math.max(1, Math.min(6, Number(env.GEN_ATTEMPTS) || 3)),
    maxTokens: Math.max(512, Number(env.GEN_MAX_TOKENS) || 2048),
  };
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
// What the model writes (the generator adds schema, version, cost, source and the card's element_cost).
export function stripExample(d) {
  const o = { id: d.id, name: d.name, elements: d.elements, kind: d.kind, duration: d.duration, every: d.every, text: d.text,
    flags: d.flags, uses: d.uses, logic: d.logic };
  if (d.bot) o.bot = d.bot;
  o.card = { tags: d.card?.tags || [], data: { effect_types: d.card?.data?.effect_types || [] } };
  return o;
}

// The fixed system prompt. Read from the repo each time (SCHEMA.md, lib/*.json, the example definitions), so it follows
// the engine; identical text between calls = the server's prompt cache hits.
export function systemPrompt({ dataDir = DATA } = {}) {
  const schema = fs.readFileSync(path.join(dataDir, 'SCHEMA.md'), 'utf8').replace(/\r/g, '');
  const dialect = schema.slice(schema.indexOf('## The dialect'), schema.indexOf('## Library `std`')).trim();
  const subs = GEN_LIBS.map(id => {
    const lib = readJson(path.join(dataDir, 'lib', `${id}.json`));
    return `library "${id}":\n` + Object.entries(lib.subs).map(([k, s]) => `  ${k}(${(s.params || []).join(', ')})${s.description ? ` — ${s.description}` : ''}`).join('\n');
  }).join('\n');
  const examples = GEN_EXAMPLES.map(id => JSON.stringify(stripExample(readJson(path.join(dataDir, 'effects', `${id}.json`))))).join('\n');
  return [
    'You write new spell effects for chaosD6, a hex card game. You answer with ONE JSON object: an effect definition.',
    'Fields: id ("effect_" + lowercase words joined by _), name, elements (the element cost in emission order, 1-4 of the element ids),',
    `kind (${GEN_KINDS.join(' | ')}), duration (${GEN_DURATIONS.join(' | ')}), every ({behaviour, note}: what a doubled cast does),`,
    'text (the card rules text, 1-3 sentences), flags (the resolver metadata the program implements — the validator prices the',
    'effect by them and refuses a program that does MORE than its flags), uses (library ids), logic (the program), bot',
    '(optional: {tags, names, defence, contact, heals_self}), card ({tags, data: {effect_types}}).',
    `Element ids: ${ALL_ELEMS.join(', ')}.`,
    'Flag keys and values: damage "delta"|"pointbuy"; scope "target"|"all_enemies"|"all_adjacent"|"all_seen"|"everyone"|"self"|"self_or_ally"|"self_or_enemy";',
    'range 1..10; lock n actions; lockRestOfTurn / lockNextTurn bool; tileToken {kind, elem}; selfTileTokens / selfShieldTokens / statPenalty /',
    'statBonus [element ids]; healDealt / healIfNoTarget / selfDamageEqual bool; push n; draw n; permanent bool; shieldElem bool;',
    'everyPermanent bool; trap {trigger: "targeted"|"enter", mode: "damage"|"perm"}; fixedPower n; zone "no_damage"; ignoresZones bool.',
    'Rules: no `standing` field. Use only the operations of the dialect and the library subroutines below; every random choice goes',
    'through seed / point_buy / rng / the library buy subroutines. Start with {"call":["prelude"]}, end with {"call":["finish"]}.',
    'Keep the power fair for its cost: more elements = stronger. Do not copy an example; make what the player asks for.',
    'Common mistakes: a map over recipients must name its item — {"map":[{"var":"recipients"},{…uses {"var":"def"}…},"def"]};',
    'every library subroutine you call must be in a library listed in `uses`; flags must declare everything the program does',
    '(damage, lock n, tokens…) and nothing it does not.',
    '',
    dialect,
    '',
    subs,
    '',
    'Examples (existing effects, same JSON shape as your answer):',
    examples,
  ].join('\n');
}

// The answer's top level (the program itself is free-form JSON: `logic: {}`).
export function answerSchema() {
  const str = { type: 'string' };
  return {
    type: 'object',
    properties: {
      id: { type: 'string', pattern: '^effect_[a-z0-9_]+$' }, name: str,
      elements: { type: 'array', items: { type: 'string', enum: ALL_ELEMS }, minItems: 1, maxItems: 4 },
      kind: { type: 'string', enum: GEN_KINDS }, duration: { type: 'string', enum: GEN_DURATIONS },
      every: { type: 'object', properties: { behaviour: str, note: str }, required: ['behaviour'] },
      text: str, flags: { type: 'object' }, uses: { type: 'array', items: { type: 'string', enum: GEN_LIBS } },
      logic: { type: 'object' }, bot: { type: 'object' },
      card: { type: 'object', properties: { tags: { type: 'array', items: str }, data: { type: 'object', properties: { effect_types: { type: 'array', items: str } } } } },
    },
    required: ['id', 'name', 'elements', 'kind', 'duration', 'text', 'flags', 'uses', 'logic', 'card'],
  };
}

// The model's object → a full definition (fields it does not own are set here).
export function assemble(raw, { model = '', idea = '', taken = new Set() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let id = typeof r.id === 'string' && /^effect_[a-z0-9_]+$/.test(r.id) ? r.id : `effect_gen_${Date.now().toString(36)}`;
  if (taken.has(id)) id = `${id}_gen`;   // never the id of a built-in (the validator would judge it as that built-in's branch)
  const elements = Array.isArray(r.elements) ? r.elements : [];
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 80) : id;
  const text = typeof r.text === 'string' ? r.text.trim() : '';
  const def = {
    schema: 'chaosd6.effect/2', id, name, version: '0.1.0',
    // custom: true = a player-made definition (user ruling 2026-11-23) — the editor, the card and the vote popup show a "custom" badge.
    source: { collection: 'generated', custom: true, model, idea: String(idea).slice(0, 500), at: new Date().toISOString() },
    elements, cost: elements.length, kind: r.kind, duration: r.duration,
    every: r.every && typeof r.every === 'object' ? r.every : { behaviour: 'none' },
    text, flags: r.flags && typeof r.flags === 'object' ? r.flags : {},
  };
  if (r.bot && typeof r.bot === 'object' && Object.keys(r.bot).length) def.bot = r.bot;
  const tags = Array.isArray(r.card?.tags) ? r.card.tags.filter(t => typeof t === 'string').slice(0, 8) : [];
  const types = Array.isArray(r.card?.data?.effect_types) ? r.card.data.effect_types.filter(t => typeof t === 'string').slice(0, 8) : [];
  def.card = { name, tags, data: { effect_types: types.length ? types : [r.kind].filter(Boolean), element_cost: elements, text } };
  def.uses = Array.isArray(r.uses) && r.uses.length ? r.uses : ['std'];
  def.logic = r.logic;
  return def;
}

// Mechanical repairs of mistakes the 8B makes and does not fix when told (seen 2026-11-22: it re-sent the same answer
// four times). → list of what was changed. Only shape fixes; the validator still judges the result.
const usesVar = (x, name) => (Array.isArray(x) ? x.some(y => usesVar(y, name))
  : x && typeof x === 'object' ? Object.entries(x).some(([k, v]) => (k === 'var' && (v === name || (typeof v === 'string' && v.startsWith(`${name}.`)) || (Array.isArray(v) && v[0] === name))) || usesVar(v, name)) : false);
export function autoFix(def) {
  const fixed = [];
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    for (const op of ['map', 'filter', 'find', 'all', 'some', 'none']) {
      const a = x[op];
      if (Array.isArray(a) && a.length === 2 && usesVar(a[1], 'def') && !usesVar(a[1], 'it')) { a.push('def'); fixed.push(`named the ${op} item "def"`); }
    }
    Object.values(x).forEach(walk);
  };
  walk(def.logic);
  const need = new Set(); const calls = (x) => { if (Array.isArray(x)) x.forEach(calls); else if (x && typeof x === 'object') { if (Array.isArray(x.call) && typeof x.call[0] === 'string') need.add(x.call[0]); Object.values(x).forEach(calls); } };
  calls(def.logic);
  if (!def.uses.includes('e2a') && E2A_SUBS.some(k => need.has(k))) { def.uses = [...def.uses, 'e2a']; fixed.push('added library e2a to uses'); }
  return fixed;
}
const E2A_SUBS = Object.keys(readJson(path.join(DATA, 'lib', 'e2a.json')).subs);

// The validator's own suggestions (checkEffect → suggestions[].patch) applied without the model, when the change maps
// onto one spot of the program: the element cost (the program reads `elems`, not a count), a lock count (the literal
// n of lock_n), the scope / range (the literal args of `targets`), a dropped stat token element (its stat_token call). → { def, change } | null. The validator re-judges it.
const isCall = (x, sub) => x && typeof x === 'object' && Array.isArray(x.call) && x.call[0] === sub;
function rewriteCalls(x, sub, fn) {
  if (Array.isArray(x)) return x.map(y => rewriteCalls(y, sub, fn));
  if (!x || typeof x !== 'object') return x;
  const o = Object.fromEntries(Object.entries(x).map(([k, v]) => [k, rewriteCalls(v, sub, fn)]));
  return isCall(o, sub) ? fn(o) : o;
}
export function applySuggestion(def, sg) {
  const p = sg?.patch;
  if (!p || p.effect_types || p.every_bonus !== undefined) return null;
  const d = structuredClone(def);
  let n = 0;
  if (p.element_cost) { d.elements = [...p.element_cost]; d.cost = d.elements.length; d.card.data.element_cost = [...d.elements]; n++; }
  if (p.rule) {
    const keys = new Set([...Object.keys(def.flags), ...Object.keys(p.rule)].filter(k => JSON.stringify(def.flags[k]) !== JSON.stringify(p.rule[k])));
    if ([...keys].some(k => !['lock', 'scope', 'range', 'statPenalty', 'statBonus'].includes(k))) return null;
    let touched = true;
    if (keys.has('lock')) {
      let hits = 0;
      d.logic = rewriteCalls(d.logic, 'lock_n', (c) => (typeof c.call[2] === 'number' && c.call[2] === (def.flags.lock || 0) ? (hits++, p.rule.lock ? { call: [c.call[0], c.call[1], p.rule.lock, ...c.call.slice(3)] } : null) : c));
      touched &&= hits > 0;
    }
    for (const [k, sign] of [['statPenalty', -1], ['statBonus', 1]]) if (keys.has(k)) {   // a token element dropped: its stat_token call goes
      const was = def.flags[k] || [], now = p.rule[k] || [];
      if (now.length !== was.length - 1) return null;
      const gone = was[was.length - 1];
      let hits = 0;
      d.logic = rewriteCalls(d.logic, 'stat_token', (c) => (c.call[2] === gone && c.call[3] === sign && !hits ? (hits++, null) : c));
      touched &&= hits > 0;
    }
    if (keys.has('scope') || keys.has('range')) {
      let hits = 0;
      d.logic = rewriteCalls(d.logic, 'targets', (c) => (c.call[1] === def.flags.scope ? (hits++, { call: ['targets', p.rule.scope, p.rule.range ?? 1, ...c.call.slice(3)] }) : c));
      touched &&= hits > 0;
    }
    if (!touched) return null;
    d.flags = { ...p.rule };
    n++;
  }
  return n ? { def: d, change: sg.change } : null;
}
// Order: keep the player's design where possible — the cost first (one element more for a nerf, one less for a boost),
// then the lock count, the range, the scope last ("every adjacent enemy" → "one target" changes the idea).
const TUNE_ORDER = (sg) => (sg.patch.element_cost ? 0 : sg.change.startsWith('lock') ? 1 : sg.change.startsWith('range') ? 2 : /^stat(Penalty|Bonus)/.test(sg.change) ? 3 : 4);
export async function autoTune(def, res, { checkEffect = null } = {}) {
  const last = def.elements.at(-1);
  const own = [];
  if (res?.verdict === 'nerf') for (let k = 1; k <= 2 && def.elements.length + k <= 4; k++) own.push({ change: `+${k} element${k > 1 ? 's' : ''} (${last}) on the cost`, patch: { element_cost: [...def.elements, ...Array(k).fill(last)] } });
  if (res?.verdict === 'boost') for (let k = 1; k <= 2 && def.elements.length - k >= 1; k++) own.push({ change: `${k} element${k > 1 ? 's' : ''} less (drop ${last})`, patch: { element_cost: def.elements.slice(0, -k) } });
  const list = [...own, ...(res?.check?.suggestions || []).filter(x => x.patch)].sort((a, b) => TUNE_ORDER(a) - TUNE_ORDER(b));
  for (const sg of list) {
    const a = applySuggestion(def, sg);
    if (!a) continue;
    const r = await checkDraft(a.def, { checkEffect });
    if (r.ok) return { def: a.def, res: r, change: a.change };
  }
  return null;
}

// The validator every peer runs on a foreign effect. → { ok, verdict, problems[], check }
export async function checkDraft(def, { checkEffect = null } = {}) {
  checkEffect ||= (await import('./tools/rebalancing-check.mjs')).checkEffect;
  let res;
  try { res = checkEffect(def); } catch (e) { return { ok: false, verdict: 'reject', problems: [`validator error: ${e.message}`], check: null }; }
  const problems = [...(res.errors || [])];
  if (res.verdict !== 'ok') problems.push(...(res.reasons || []));
  // The validator only counts erroring scenarios; one run here recovers the engine's own message for the model.
  if (problems.some(x => /errored|engine budget/.test(x))) problems.push(...probeErrors(def));
  if (res.verdict === 'nerf' || res.verdict === 'boost') {
    for (const s of (res.suggestions || []).slice(0, 4)) problems.push(`suggestion: ${s.change}`);
  }
  return { ok: res.verdict === 'ok', verdict: res.verdict, problems: [...new Set(problems)].slice(0, 20), check: res };
}

// The program on one small scene (me + an adjacent enemy + a second enemy, every element at 30) → the engine's notes
// of an error outcome, as "engine: …" lines. [] when it runs.
export function probeErrors(def) {
  let bound;
  try { bound = loadEffectDefs({ effects: [structuredClone(def)] }).get(def.id); } catch (e) { return [`engine: ${String(e.message).slice(0, 300)}`]; }
  const units = { me: { t: { q: 0, r: 0 }, side: 'a', life: 6 }, foe: { t: { q: 1, r: 0 }, side: 'b', life: 4 }, foe2: { t: { q: -1, r: 1 }, side: 'b', life: 4 } };
  // Strict like the validator's scenes: a unit id that is not on the map throws (an unnamed map item reads as undefined).
  const u = (id) => { if (!units[id]) throw new Error(`no unit ${JSON.stringify(id)} — a variable is undefined (is the map item named, e.g. "def"?)`); return units[id]; };
  const hd = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((a.q + a.r) - (b.q + b.r)));
  const ctx = {
    me: 'me', elemStat: () => 'matter', statFor: (id) => (u(id), 30), baseStat: (id) => (u(id), 30), lifeOf: (id) => units[id]?.life ?? 0,
    enemyOf: (a, b) => u(a).side !== u(b).side, dist: (a, b) => hd(u(a).t, u(b).t), tileOf: (id) => units[id]?.t ?? null,
    isFree: (q, r) => !Object.values(units).some(u => u.t.q === q && u.t.r === r),
    neighbours: (q, r) => [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]].map(([a, b]) => ({ q: q + a, r: r + b })),
    hasPerm: () => false, shieldedAgainst: () => false, disabledElems: () => new Set(), invisible: () => false,
    peers: () => Object.keys(units).sort(), sha: (s) => crypto.createHash('sha256').update(String(s)).digest('hex'),
    threatElem: () => def.elements[0], castElemOf: () => null, actionIndex: 0,
    freeTilesWithin: () => [], tileTokensAt: () => [], trapsAt: () => [], obstacleAt: () => null, library: () => [],
  };
  const of = def.elements.length, notes = new Set();
  for (let step = 1; step <= of; step++) {
    const cast = { actor: 'me', effect_id: def.id, elements: [...def.elements], salt: 'gen-probe', target: { kind: 'character', ref: 'foe' }, is_instant: def.duration === 'instant', step, of, kept: null, card_id: 'gen-card' };
    let out;
    try { out = resolveEffectData(bound, ctx, cast); } catch (e) { notes.add(`engine: ${String(e.message).slice(0, 300)}`); break; }
    if (out.status === 'error') for (const n of out.notes || []) notes.add(`engine: ${String(n).slice(0, 300)}`);
    if (out.status !== 'casting') break;
  }
  return [...notes].slice(0, 4);
}

// One completion. → { text, ms, usage, timings } | { error, ms }
// With onProgress it streams (llama-server SSE + return_progress): onProgress({ phase: 'prompt', done, total, cached })
// while the prompt is read, then ({ phase: 'answer', done }) per answer token. Same result either way.
// A POST with node:http(s) shaped like fetch's answer ({ ok, status, body: async iterable, json(), text() }). Node's fetch
// (undici) gives up when the reply headers take > 300 s (UND_ERR_HEADERS_TIMEOUT, seen on OCI 2026-11-23: a slow 8B sends
// nothing until its first prompt batch is read); this has no such limit — only the caller's AbortSignal.
export function longFetch(url, { method = 'POST', headers = {}, body = '', signal } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, signal }, (res) => {
      const read = async () => { let s = ''; for await (const c of res) s += c; return s; };
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: res, text: read, json: async () => JSON.parse(await read()) });
    });
    req.on('error', (e) => reject(e.name === 'AbortError' ? Object.assign(new Error('timeout'), { name: 'TimeoutError' }) : e));
    req.end(body);
  });
}

// schema: the JSON schema the answer is held to (default: an effect definition; null = free text, e.g. a test review).
export async function complete(cfg, messages, { fetchImpl = longFetch, timeoutMs = cfg.timeoutMs, temperature = 0.4, onProgress = null, schema = answerSchema(), maxTokens = cfg.maxTokens } = {}) {
  const t0 = Date.now();
  const stream = typeof onProgress === 'function';
  try {
    const r = await fetchImpl(`${cfg.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
      body: JSON.stringify({
        model: cfg.model, messages, temperature, max_tokens: maxTokens, cache_prompt: true,
        chat_template_kwargs: { enable_thinking: false },
        ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: false, schema } } } : {}),
        ...(stream ? { stream: true, return_progress: true } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { error: `http ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`, ms: Date.now() - t0 };
    if (!stream || !r.body) {
      const j = await r.json();
      return { text: j?.choices?.[0]?.message?.content ?? '', ms: Date.now() - t0, usage: j?.usage || null, timings: j?.timings || null };
    }
    let text = '', buf = '', n = 0, timings = null, usage = null;
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.prompt_progress) onProgress({ phase: 'prompt', done: j.prompt_progress.processed ?? 0, total: j.prompt_progress.total ?? 0, cached: j.prompt_progress.cache ?? 0 });
        const piece = j.choices?.[0]?.delta?.content;
        if (typeof piece === 'string' && piece) { text += piece; n++; onProgress({ phase: 'answer', done: n }); }
        if (j.timings) timings = j.timings;
        if (j.usage) usage = j.usage;
      }
    }
    if (!usage && timings) usage = { prompt_tokens: (timings.prompt_n ?? 0) + (timings.cache_n ?? 0), completion_tokens: timings.predicted_n ?? n };
    return { text, ms: Date.now() - t0, usage, timings };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.message || 'error'), ms: Date.now() - t0 };
  }
}

// The status line of a generation (CLI every 5 s, the editor's label every 10 s):
// "[gen] m:ss attempt i/n X% · reading prompt …/… tok (..%) | writing answer n/~N tok (..%) | validating · <host> CPU …".
// state = generateEffect's onProgress object; sample = machine-stats latest() (or null); statsError = its error().
export const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
export function formatStatus(state, { elapsedMs = 0, sample = null, statsError = '', where = 'local' } = {}) {
  if (!state) return '';
  const pct = (a, b) => (b > 0 ? Math.min(99, Math.round(100 * a / b)) : 0);
  let what;
  if (state.phase === 'prompt') what = `reading prompt ${state.done}/${state.total} tok (${pct(state.done, state.total)}%${state.cached ? `, ${state.cached} cached` : ''})`;
  else if (state.phase === 'answer') what = `writing answer ${state.done}/~${state.expect} tok (${pct(state.done, state.expect)}%)`;
  else if (state.phase === 'check') what = 'validating (99%)';
  else what = 'waiting for the server';
  // the attempt's own %: prompt = 0–20 %, answer = 20–99 % (the answer is most of the time once the prompt is cached)
  const job = state.phase === 'prompt' ? Math.round(20 * pct(state.done, state.total) / 100) : state.phase === 'answer' ? 20 + Math.round(79 * pct(state.done, state.expect) / 100) : state.phase === 'check' ? 99 : 0;
  let m = '';
  if (sample) {
    const big = (sample.servers || []).find(sv => sv.port === '8096');
    m = ` · ${where} CPU ${sample.cpu}% · mem ${sample.mem}% (${sample.memUsedGb}/${sample.memTotalGb} GB)${big ? ` · 8B ${big.cpu ?? '?'}% CPU, ${big.rssGb} GB` : ''}`;
  } else if (statsError) m = ` · stats: ${statsError}`;
  return `[gen] ${mmss(elapsedMs)} attempt ${state.attempt}/${state.of} ${job}% · ${what}${m}`;
}

// The rebalance validator's own report as the CLI prints it (tools/rebalancing-check.mjs / skills-rebalancing-check.mjs
// `check <file>`), from the raw check result → lines for the draft's log (the player sees why it is rated so).
export function validatorReport(res) {
  if (!res || typeof res !== 'object') return [];
  const id = res.effect_id || res.skill_id || res.class_id || '?';
  const out = [`${id}: VERDICT ${String(res.verdict || '?').toUpperCase()}  (validator ${res.validator?.version || '?'}${res.validator?.pin_id ? `, pin ${res.validator.pin_id.slice(0, 12)}` : ''})`];
  if (res.valid === false) { for (const e of res.errors || []) out.push(`  ✗ ${e}`); return out; }
  const p = res.power;
  if (p && typeof p === 'object') {
    const cost = p.cost && typeof p.cost === 'object' ? ` cost ${p.cost.actions} ${res.skill_id || res.class_id ? 'card-' : ''}actions${p.cost.emissions != null ? ` (emissions ${p.cost.emissions}${p.cost.instant ? ' instant' : ''}, retries ${p.cost.retries})` : ''}` : '';
    out.push(`  value ${p.value}${p.uses != null ? ` (uses ${p.uses}${p.per_use != null ? ` × ${p.per_use}` : ''})` : ''}${p.kind ? ` ${p.kind}` : ''}${p.k != null ? `, ${p.k} colours` : ''} ${cost}  curve ${p.expected}  ratio ${p.ratio}`);
    if (p.components) out.push(`  components: ${Object.entries(p.components).map(([k, v]) => (v && typeof v === 'object' ? `${k} ${v.value} (${v.trigger || ''}${v.per != null ? ` ${v.per} × ${v.times}` : ''})` : `${k} ${v}`)).join(', ')}`);
  }
  if (res.baseline) out.push(`  baseline ${res.baseline.id}: ratio ${res.baseline.ratio} → judged ${res.judged_ratio}`);
  if (res.band) out.push(`  band [${res.band.low}, ${res.band.high}]`);
  if (res.audit) out.push(`  audit: ${res.audit.ran ? `${res.audit.engine}, ${res.audit.N} ${res.skill_id ? 'duels' : 'scenarios'}, ${res.audit.identical ? 'identical to the flags' : 'within the flags'}` : res.audit.why || 'not run'}`);
  for (const r of res.reasons || []) out.push(`  · ${r}`);
  for (const s of res.suggestions || []) out.push(`  → ${s.change}${s.ratio != null ? ` (ratio ${s.ratio}${s.in_band ? ', in band' : ''})` : ''}`);
  return out.slice(0, 40);
}

export function parseJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

// generateEffect({ idea }) → { ok, def, verdict, problems, tries: [{ms, verdict, problems, usage}] }
// onProgress({ attempt, of, phase: 'prompt'|'answer'|'check', done, total, cached, expect }) — CLI status line.
// prior + changes (the editor's "retry"): the previous draft goes back as the model's own answer, followed by the
// player's extra description and the test review's suggestions — the model edits it instead of starting over.
export async function generateEffect({ checkEffect = null, ...o }) {
  return generateDef(effectSpec({ checkEffect }), o);
}
// What generateDef needs to know about one kind of definition (effects here; skill-gen.mjs, class-gen.mjs the others).
export function effectSpec({ checkEffect = null } = {}) {
  return {
    kind: 'effect', expect: 350,   // answer tokens expected (an effect definition ~300–350)
    systemPrompt: () => systemPrompt(), answerSchema, strip: stripExample, assemble, autoFix,
    taken: () => new Set(fs.readdirSync(path.join(DATA, 'effects')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))),
    check: (def) => checkDraft(def, { checkEffect }),
    tune: (def, res) => autoTune(def, res, { checkEffect }),
  };
}

// The model loop for any kind: ask → parse → assemble → auto-fix → the validator → (tune) → the problems back to the model.
// tagCheck(def) → problems (gen-tags.mjs tagProblems for the tags the player picked; a hard requirement: a draft that
// misses one is not ok, the problems go back to the model like a validator's reasons).
export async function generateDef(spec, { idea, cfg = genConfig(process.env), fetchImpl = longFetch, log = () => {}, taken = null, onProgress = null, prior = null, changes = '', tagCheck = null }) {
  if (!cfg.url) return { ok: false, error: 'no big model configured (LLM_BIG_URL)', tries: [] };
  if (!idea || !String(idea).trim()) return { ok: false, error: `describe the ${spec.kind}`, tries: [] };
  taken ||= spec.taken();
  const messages = [{ role: 'system', content: spec.systemPrompt() }, { role: 'user', content: `New ${spec.kind}: ${String(idea).trim().slice(0, 1000)}\n/no_think` }];
  if (prior && typeof prior === 'object') {
    messages.push({ role: 'assistant', content: JSON.stringify(spec.strip(prior)).slice(0, 12_000) });
    messages.push({ role: 'user', content: `Change it: ${String(changes || 'make it work as described').trim().slice(0, 2000)}\nKeep the id "${prior.id}". Answer with the whole corrected JSON object.\n/no_think` });
  }
  const tries = [];
  // the conversation for the draft's log (the system prompt left out): the player's words, each answer, the validator's report
  const talk = messages.slice(1).filter(m => m.role === 'user').map(m => ({ role: 'player', text: m.content.replace(/\n\/no_think$/, '').slice(0, 2000) }));
  let best = null, expect = spec.expect || 350;   // then the last attempt's length
  for (let i = 1; i <= cfg.attempts; i++) {
    log(`attempt ${i}/${cfg.attempts}: asking ${cfg.model} at ${cfg.url}…`);
    const prog = onProgress ? (x) => onProgress({ attempt: i, of: cfg.attempts, expect, ...x }) : null;
    prog?.({ phase: 'wait' });
    const ans = await complete(cfg, messages, { fetchImpl, temperature: Math.min(0.9, 0.4 + 0.2 * (i - 1)), onProgress: prog, schema: spec.answerSchema() });   // retries vary more: the 8B re-sends its answer otherwise
    if (ans.usage?.completion_tokens) expect = ans.usage.completion_tokens;
    prog?.({ phase: 'check' });
    if (ans.error) { tries.push({ ms: ans.ms, error: ans.error }); log(`attempt ${i}: ${ans.error} after ${ans.ms} ms`); if (/^(timeout|http 40[13])/.test(ans.error)) break; continue; }
    const raw = parseJson(ans.text);
    let def = null, res;
    if (!raw) res = { ok: false, verdict: 'reject', problems: ['the answer is not one JSON object'] };
    else {
      def = spec.assemble(raw, { model: cfg.model, idea, taken });
      if (prior?.id && raw.id === prior.id) def.id = prior.id;   // a retry keeps its draft's id (taken only holds the built-ins)
      const fixed = spec.autoFix ? spec.autoFix(def) : [];
      if (fixed.length) { def.source.auto_fixed = fixed; log(`attempt ${i}: auto-fixed — ${fixed.join('; ')}`); }
      res = await spec.check(def);
      if ((res.verdict === 'nerf' || res.verdict === 'boost') && spec.tune) {
        const t = await spec.tune(def, res);
        if (t) { def = t.def; (def.source.auto_fixed ||= []).push(`validator suggestion: ${t.change}`); log(`attempt ${i}: ${res.verdict} → applied the validator's suggestion "${t.change}"`); res = t.res; }
      }
      const tp = tagCheck ? tagCheck(def) : [];
      if (tp.length) res = { ...res, ok: false, tagProblems: tp, problems: [...tp, ...res.problems] };
    }
    tries.push({ ms: ans.ms, verdict: res.verdict, problems: res.problems, usage: ans.usage, timings: ans.timings });
    log(`attempt ${i}: ${res.verdict} in ${Math.round(ans.ms / 1000)} s${res.problems.length ? ` — ${res.problems.slice(0, 3).join('; ')}` : ''}`);
    talk.push({ role: 'model', attempt: i, text: def ? JSON.stringify(spec.strip(def)).slice(0, 1500) : String(ans.text).slice(0, 600) },
      { role: 'validator', attempt: i, verdict: res.verdict, text: [...validatorReport(res.check), ...(res.check ? [] : res.problems.map(p => `  · ${p}`))].join('\n').slice(0, 3000) });
    const score = rank(res.verdict) - (res.tagProblems?.length ? 0.5 : 0);   // a draft that meets the tags wins a tie
    if (def && (!best || score > best.score)) best = { def, verdict: res.verdict, problems: res.problems, check: res.check, tagProblems: res.tagProblems || [], score };
    if (res.ok) break;
    messages.push({ role: 'assistant', content: ans.text.slice(0, 12_000) });
    messages.push({ role: 'user', content: `The validator refused it (${res.verdict}):\n- ${res.problems.join('\n- ')}\nFix these and answer with the whole corrected JSON object.\n/no_think` });
  }
  return { ok: best?.verdict === 'ok' && !best.tagProblems.length, def: best?.def || null, verdict: best?.verdict || 'none', problems: best?.problems || [], check: best?.check || null,
    tag_problems: best?.tagProblems || [], tries, talk };
}
const rank = (v) => ({ ok: 3, nerf: 2, boost: 2, reject: 1 })[v] || 0;

// A draft beside the player's profile (<profile dir>/effect-drafts/<id>.json) — never in the repo, never published here.
export function saveDraft(def, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${def.id}.json`);
  fs.writeFileSync(file, JSON.stringify(def, null, 2) + '\n');
  return file;
}
