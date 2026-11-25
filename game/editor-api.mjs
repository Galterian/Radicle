// Rules editor served by the node (EDITOR_SPEC ruling 1, 2026-11-22): the same editor as the public read-only site
// https://92-5-138-121.sslip.io/rules/, opened from the node's own server at http://127.0.0.1:<port>/rules/, where it is
// editable. Mounted by ui-server.mjs (desktop launcher) and mobile-menu.mjs (phone menu) with one line:
//   if (await handleEditorRequest(req, res, url, { repoRoot, dataDir, gameDir, profileFile, port, publish })) return;
//
// Static (relative to /rules/, the same layout as tools/rules-site-build.mjs writes for the public site):
//   ./ , rules.html, editor.html  the shell (editor.html of repoRoot, else gameDir: the phone bundle)
//   editor/*                      the editor modules / css
//   data/index.json, data/<f>     definitionsCollectionText first (effects, skills = the definitions' cards), else dataDir
//   defs/index.json               { skill: [ids], effect: [ids], class: [ids] } — the built-in definition files
//   defs/<kind>/<id>.json         game/skills-data/skills, effects-data/effects, classes-data/classes
// API under /rules/api/editor/ (JSON in / out; errors 4xx { ok:false, error }):
//   GET session · POST login · GET templates?kind= · POST validate · POST definitions · GET definitions/mine ·
//   POST definitions/retry · POST proposals   (contract: game/tools/out/EDITOR_SPEC.md "Node API")
// Security (same-origin only, no CORS headers ever): every API request needs Host 127.0.0.1:<port> | localhost:<port>
// (DNS-rebinding guard); a POST also needs X-Editor-Token (random per process, handed out by GET session only),
// Content-Type application/json, a body ≤ 512 KB, and — when sent — Origin = the server's own origin and
// Sec-Fetch-Site same-origin|none. Writing (definitions, proposals, retry) needs a logged-in team owner.
// Proposals append a NEW version (status proposal, weight 0, origin player_vote) via logic-engine writeDataFile under
// flock /tmp/chaosd6-data.lock (the lock apply-all.sh takes); definitions collections are never written.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { definitionsCollectionText } from './defs-collection.mjs';
import { ID_RE } from './defs-repo.mjs';
import { loadProfile, profilePath } from './profile.mjs';
import { teamSlug, ownerIds } from './profile-auth.mjs';
import { voterIdentity } from './proposal-votes.mjs';
import { publishDefinition, retryDefinition, listMine, publishReadiness, KINDS } from './editor-publish.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BODY_MAX = 512 * 1024;
export const DATA_LOCK = '/tmp/chaosd6-data.lock';
const TOKEN = randomBytes(32).toString('hex');   // one per server process
const DEF_DIRS = { skill: 'skills-data/skills', effect: 'effects-data/effects', class: 'classes-data/classes' };
const SCHEMA_DOCS = { skill: 'skills-data/SCHEMA.md', effect: 'effects-data/SCHEMA.md', class: 'classes-data/SCHEMA.md' };
// Foreign schemas: a skill from a player branch is chaosd6.skill/1 (deal_order / card / ui are built-in only);
// effects and classes: what validateEffectDef / validateClassDef accept.
const FOREIGN_SCHEMAS = { skill: ['chaosd6.skill/1'], effect: ['chaosd6.effect/1', 'chaosd6.effect/2'], class: ['chaosd6.class/1', 'chaosd6.class/2'] };
const TEMPLATE_BASE = { skill: 'skill_dodge', effect: 'effect_fireball', class: 'class_enchanter' };   // simple built-ins, rated ok
const BUILTIN_ONLY = ['source', 'deal_order', 'card', 'ui', 'bot', 'standing', 'extends'];
// Skill isolation flags that order the BUILT-INS (deal / pass hooks / building list / plan locks): never on a player skill.
const BUILTIN_ORDER_FLAGS = ['passOrder', 'buildingSkill', 'planLock'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.map': 'application/json' };

class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }
const fail = (status, msg, extra) => { throw new HttpError(status, msg, extra); };

// ------------------------------------------------------------------ responses
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
function sendJson(res, code, obj) {
  res.writeHead(code, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function sendText(res, code, type, body, cache = 'no-cache') {
  const h = { ...BASE_HEADERS, 'Content-Type': type, 'Cache-Control': cache };
  if (type.startsWith('text/html')) { h['X-Frame-Options'] = 'SAMEORIGIN'; h['Content-Security-Policy'] = "frame-ancestors 'self'"; }
  res.writeHead(code, h);
  res.end(body);
}
const notFound = (res) => { res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain' }); res.end('not found'); };

/** `rel` (url path, '/'-separated, already decoded) inside `root`, or null (traversal, NUL, backslash, dot-segments). */
export function safeJoin(root, rel) {
  if (!root || typeof rel !== 'string' || /[\0\\]/.test(rel)) return null;
  const parts = rel.split('/').filter(Boolean);
  if (parts.some(p => p === '.' || p === '..' || p.startsWith('.'))) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, ...parts);
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
}
function serveFile(res, abs) {
  const type = abs && MIME[path.extname(abs).toLowerCase()];
  if (!type) return false;
  let buf;
  try { if (!fs.statSync(abs).isFile()) return false; buf = fs.readFileSync(abs); } catch { return false; }
  sendText(res, 200, type, buf);
  return true;
}

// ------------------------------------------------------------------ definitions on disk
const builtinIds = (gameDir, kind) => {
  try { return fs.readdirSync(path.join(gameDir, DEF_DIRS[kind])).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(); } catch { return []; }
};
export const defsIndex = (gameDir) => Object.fromEntries(KINDS.map(k => [k, builtinIds(gameDir, k)]));
const readDef = (gameDir, kind, id) => JSON.parse(fs.readFileSync(path.join(gameDir, DEF_DIRS[kind], `${id}.json`), 'utf8').replace(/^﻿/, ''));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The rebalancing validators (pinned files — imported, never edited). Lazy: they load the engines.
const validators = {};
async function validatorOf(kind) {
  if (validators[kind]) return validators[kind];
  if (kind === 'skill') { const m = await import('./tools/skills-rebalancing-check.mjs'); validators.skill = { check: (d) => m.checkSkill(d), version: m.VALIDATOR_VERSION }; }
  else if (kind === 'effect') { const m = await import('./tools/rebalancing-check.mjs'); validators.effect = { check: (d) => m.checkEffect(d), version: m.VALIDATOR_VERSION, resolveLibs: m.resolveLibs }; }
  else { const m = await import('./tools/classes-rebalancing-check.mjs'); validators.class = { check: (d) => m.checkClass(d), version: m.VALIDATOR_VERSION, builtinPower: m.BUILTIN_POWER }; }
  return validators[kind];
}
async function engineErrors(kind, def) {
  if (kind === 'skill') return (await import('./skill-engine.mjs')).validateSkillDef(def);
  if (kind === 'class') return (await import('./class-engine.mjs')).validateClassDef(def);
  const subs = (await validatorOf('effect')).resolveLibs(def).subs;   // the bundled libs the def `uses`
  return (await import('./effect-engine.mjs')).validateEffectDef(def, subs);
}

/** Schema + engine + foreign rules + rebalancing verdict. → { ok, errors, verdict, score?, report? }.
 *  ok = no errors and verdict ≠ reject (a reject's reasons are listed in errors). */
export async function validateDefinition(kind, def, { gameDir = HERE } = {}) {
  const errors = [];
  if (!KINDS.includes(kind)) return { ok: false, errors: [`kind must be ${KINDS.join('|')}`], verdict: null };
  if (!isObj(def)) return { ok: false, errors: ['definition is not an object'], verdict: null };
  const idRe = new RegExp(`^${kind}_[a-z0-9_]+$`);
  if (typeof def.id !== 'string' || !idRe.test(def.id) || !ID_RE.test(def.id) || def.id.length > 64) errors.push(`id must match ^${kind}_[a-z0-9_]+$ (≤ 64 chars)`);
  else if (builtinIds(gameDir, kind).includes(def.id)) errors.push(`id ${def.id} is a built-in ${kind} — a new ${kind} needs a new id`);
  if (!FOREIGN_SCHEMAS[kind].includes(def.schema)) errors.push(`schema must be ${FOREIGN_SCHEMAS[kind].join(' or ')} (a player-branch ${kind})`);
  if (def.deal_order !== undefined) errors.push('deal_order is for built-ins only');
  for (const f of BUILTIN_ORDER_FLAGS) if (isObj(def.flags) && def.flags[f] !== undefined) errors.push(`flags.${f} orders the built-ins only — remove it`);
  let size = 0;
  try { size = JSON.stringify(def).length; } catch { errors.push('definition is not serialisable'); }
  if (size > 256 * 1024) errors.push('definition larger than 256 KB');
  try { for (const e of await engineErrors(kind, def)) if (!errors.includes(e)) errors.push(e); }
  catch (e) { errors.push(`engine validation failed: ${e.message}`); }
  if (errors.length) return { ok: false, errors, verdict: null };
  let r;
  try { r = (await validatorOf(kind)).check(def); }
  catch (e) { return { ok: false, errors: [`rebalancing validator failed: ${e.message}`], verdict: null }; }
  for (const e of r.errors || []) errors.push(`rebalancing: ${e}`);
  const verdict = r.verdict || null;
  if (verdict === 'reject') for (const why of r.reasons || []) errors.push(`rebalancing verdict reject: ${why}`);
  if (!verdict) errors.push('rebalancing validator gave no verdict');
  const report = { validator: r.validator || null, mode: r.mode || null, reasons: r.reasons || [], band: r.band || null,
    suggestions: (r.suggestions || []).slice(0, 6).map(s => ({ change: s.change, ratio: s.ratio ?? null, in_band: s.in_band ?? null, kind: s.kind || null })) };
  return { ok: !errors.length, errors, verdict, score: r.judged_ratio ?? r.power?.ratio ?? null, report };
}

/** A minimal valid foreign skeleton of `kind`: a simple built-in, built-in-only blocks stripped, schema /1, new id. */
export async function templateOf(kind, { gameDir = HERE } = {}) {
  const base = readDef(gameDir, kind, TEMPLATE_BASE[kind]);
  const def = { schema: FOREIGN_SCHEMAS[kind][0], id: `${kind}_my_new_${kind}`, name: `My new ${kind}`, version: '0.1.0' };
  for (const [k, v] of Object.entries(base)) if (!(k in def) && !BUILTIN_ONLY.includes(k)) def[k] = v;
  if (isObj(def.flags)) { def.flags = { ...def.flags }; for (const f of BUILTIN_ORDER_FLAGS) delete def.flags[f]; }
  if (kind === 'class' && !def.power) {   // a foreign class declares its power (classes-rebalancing-check POWER_KEYS)
    const p = (await validatorOf('class')).builtinPower?.[TEMPLATE_BASE.class];
    if (p) def.power = structuredClone(p);
  }
  let hints = [];
  try { hints = fs.readFileSync(path.join(gameDir, SCHEMA_DOCS[kind]), 'utf8').split('\n').filter(l => /^##+ /.test(l)).map(l => l.replace(/^#+\s*/, '').trim()); } catch {}
  return { def, hints: { schema_doc: `game/${SCHEMA_DOCS[kind]}`, sections: hints, based_on: TEMPLATE_BASE[kind] } };
}

// ------------------------------------------------------------------ session
function sessionOf({ profileFile }) {
  const me = voterIdentity(profileFile, '', { create: false });
  const p = loadProfile(profileFile);
  const owners = Array.isArray(p.owners) ? p.owners : [];
  const label = me.privateKeyPem ? ((owners.find(o => (typeof o === 'string' ? o : o?.id) === me.id)?.label) || os.hostname()) : '';
  const identity = me.privateKeyPem ? { ...me, label } : null;
  const name = String(p.team_name || '').trim();
  const slug = teamSlug(name);
  const team = name && slug ? { name, slug, owner: !!identity && ownerIds(p).includes(identity.id) } : null;
  const reason = !identity ? 'no identity' : !team ? 'no team' : !team.owner ? 'not an owner' : null;
  return { identity, team, logged_in: !reason, reason };
}
async function sessionJson(ctx) {
  const s = sessionOf(ctx);
  return { ok: true, mode: 'node', token: TOKEN, identity: s.identity ? { id: s.identity.id, label: s.identity.label || '' } : null,
    team: s.team, logged_in: s.logged_in, can_author: s.logged_in, can_propose: s.logged_in, ...(s.reason ? { reason: s.reason } : {}),
    publish: await publishReadiness(ctx.publish || {}), kinds: [...KINDS] };
}
function requireLogin(ctx) {
  const s = sessionOf(ctx);
  if (!s.logged_in) fail(403, `read-only: ${s.reason} — sign in from the startup menu (set your team)`);
  return s;
}

// ------------------------------------------------------------------ proposals (data collections)
/** Take the data lock (flock on `file`, as tools/logic/apply-all.sh) while fn runs. No flock binary (phone) → a
 *  mkdir lock beside it (stale after 60 s). */
export async function withDataLock(fn, file = DATA_LOCK) {
  const viaFlock = await new Promise((resolve) => {
    let cp;
    try { cp = spawn('flock', ['-w', '30', file, 'sh', '-c', 'echo locked; read x'], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { return resolve(null); }
    let out = '';
    cp.on('error', () => resolve(null));
    cp.on('exit', (code) => resolve(out.includes('locked') ? cp : code === 1 ? 'timeout' : null));
    cp.stdout.on('data', (b) => { out += b; if (out.includes('locked')) resolve(cp); });
  });
  if (viaFlock === 'timeout') fail(503, `data lock ${file} busy (another data write is running) — try again`);
  if (viaFlock) {
    try { return await fn(); } finally { try { viaFlock.stdin.end('\n'); } catch {} }
  }
  const dir = `${file}.d`;
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(dir).mtimeMs > 60e3) { fs.rmdirSync(dir); continue; } } catch {}
      if (i > 300) fail(503, `data lock ${dir} busy — try again`);
      await new Promise(r => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { try { fs.rmdirSync(dir); } catch {} }
}
export function nextVersion(active, taken) {
  const m = /^(\d+)\.(\d+)/.exec(String(active || '1.0.0')) || [null, '1', '0'];
  let minor = Number(m[2]) + 1;
  while (taken.has(`${m[1]}.${minor}.0`)) minor++;
  return `${m[1]}.${minor}.0`;
}
async function propose(ctx, body, s) {
  const { collection, entry_id: entryId, data, logic, notes } = body;
  if (typeof collection !== 'string' || !/^[a-z0-9_]+$/.test(collection)) fail(400, 'collection required');
  if (typeof entryId !== 'string' || !ID_RE.test(entryId)) fail(400, 'entry_id required');
  if (!isObj(data)) fail(400, 'data must be an object');
  if (logic !== undefined && logic !== null && !isObj(logic)) fail(400, 'logic must be an object');
  const clean = (x, n) => String(x ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, n);
  return withDataLock(async () => {
    const { LogicEngine, activeVersion, writeDataFile, definitionsDirOf, authoredElsewhere } = await import('./logic-engine.mjs');
    const index = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'index.json'), 'utf8'));
    const c = (index.collections || []).find(x => x.id === collection);
    if (!c) fail(404, `no collection ${collection}`);
    if (definitionsDirOf(index, collection)) fail(400, `${collection} is read from ${c.definitions}: definitions are authored as a new ${collection.replace(/s$/, '')} (POST definitions), never as data proposals`);
    // split A (2026-11-25): the monster cards are chaosD6-GameModels monster/2 definitions (published to the team branch)
    if (authoredElsewhere(index, collection)) fail(400, `${collection} is read from ${authoredElsewhere(index, collection)}: a monster is a chaosD6-GameModels definition (monsters/<id>.json card) — change it there, never as a data proposal`);
    if (collection === 'logic_rules') fail(400, 'logic_rules is the rule vocabulary, not a versioned collection');
    const file = path.join(ctx.dataDir, c.file || `${collection}.json`);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = (json.entries || []).find(e => e.id === entryId);
    if (!entry) fail(404, `no entry ${entryId} in ${collection}`);
    const active = activeVersion(entry);
    const version = nextVersion(active?.version, new Set((entry.versions || []).map(v => v.version)));
    const who = `team ${s.team.name} (${s.identity.id})`;
    const v = { version, weight: 0, status: 'proposal', origin: 'player_vote', author_peer_id: s.identity.id, created_at: new Date().toISOString().slice(0, 10),
      parent_version: active?.version ?? null, rebalance_links: active?.rebalance_links || [], vote_log: [],
      notes: `${clean(notes, 2000) || 'proposal from the rules editor'} — ${who}`, data, ...(isObj(logic) ? { logic } : {}) };
    // tools/rebalance.mjs check, shared: validation → power score → ±tolerance → counter-proposals on the linked
    // closure → verdict. Like `check --apply`, only `blocked` is refused (needs_rework is appended — the vote decides);
    // the counter-proposals are returned as drafts, never written from here.
    const { checkProposal } = await import('./tools/rebalance.mjs');
    let r;
    try { r = checkProposal({ collection, entry_id: entryId, version: v }, { eng: new LogicEngine({ dataDir: ctx.dataDir }) }); }
    catch (e) { fail(400, `rebalance check failed: ${e.message}`); }
    if (r.verdict === 'blocked') fail(400, 'the proposal does not pass validation', { verdict: r.verdict, errors: r.errors });
    entry.versions.push(v);
    writeDataFile(file, json);   // keeps the file's CRLF; append-only (a new version object)
    const counters = r.counters.map(c => ({ entry_id: c.entry_id, change: c.change, score_before: c.score_before, score_after: c.score_after, within: c.within, valid: c.valid, ...(c.same_entry ? { same_entry: true } : {}) }));
    return { ok: true, collection, entry_id: entryId, version, parent_version: v.parent_version, verdict: r.verdict, scores: r.scores,
      within_tolerance: r.within_tolerance ?? null, closure_mean_drift: r.closure_mean_drift ?? null, counters };
  }, ctx.lockFile || DATA_LOCK);
}

// ------------------------------------------------------------------ request plumbing
async function readJsonBody(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json(\s*;|$)/.test(type)) fail(415, 'Content-Type must be application/json');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > BODY_MAX) fail(413, `body larger than ${BODY_MAX} bytes`);
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > BODY_MAX) fail(413, `body larger than ${BODY_MAX} bytes`); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  let v;
  try { v = JSON.parse(text); } catch { fail(400, 'body is not JSON'); }
  if (!isObj(v)) fail(400, 'body must be a JSON object');
  return v;
}
function tokenOk(got) {
  const a = Buffer.from(String(got || ''), 'utf8'), b = Buffer.from(TOKEN, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function guard(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(host)) fail(403, 'forbidden host');
  if (req.method === 'POST') {
    if (!tokenOk(req.headers['x-editor-token'])) fail(403, 'missing or wrong X-Editor-Token (reload the editor)');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) fail(403, 'cross-origin request refused');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') fail(403, 'cross-site request refused');
  } else if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'method not allowed');
}
const KIND_RE = /^(skill|effect|class)$/;

async function handleApi(req, res, url, sub, ctx) {
  guard(req, ctx.port);
  const route = `${req.method} ${sub}`;
  const kindOf = (k) => { if (!KIND_RE.test(String(k || ''))) fail(400, `kind must be ${KINDS.join('|')}`); return k; };
  switch (route) {
    case 'GET session': return sendJson(res, 200, await sessionJson(ctx));
    case 'POST login': await readJsonBody(req); return sendJson(res, 200, await sessionJson(ctx));
    case 'GET templates': {
      const kind = kindOf(url.searchParams.get('kind'));
      return sendJson(res, 200, { ok: true, kind, ...(await templateOf(kind, ctx)) });
    }
    case 'POST validate': {
      const b = await readJsonBody(req);
      return sendJson(res, 200, await validateDefinition(kindOf(b.kind), b.def, ctx));
    }
    case 'POST definitions': {
      const s = requireLogin(ctx);
      const b = await readJsonBody(req);
      const kind = kindOf(b.kind);
      const v = await validateDefinition(kind, b.def, ctx);
      if (!v.ok) return sendJson(res, 400, { ok: false, error: 'the definition does not validate', errors: v.errors, verdict: v.verdict });
      const r = await publishDefinition({ kind, def: b.def, identity: s.identity, team: s.team, message: typeof b.message === 'string' ? b.message.slice(0, 200) : '' }, ctx.publish || {});
      return sendJson(res, 200, { ...r, verdict: v.verdict });
    }
    case 'GET definitions/mine': {
      const s = sessionOf(ctx);
      return sendJson(res, 200, { ok: true, team: s.team, definitions: s.team ? listMine(s.team.slug, ctx.publish || {}) : [] });
    }
    case 'POST definitions/retry': {
      const s = requireLogin(ctx);
      const b = await readJsonBody(req);
      const kind = kindOf(b.kind);
      if (typeof b.id !== 'string' || !ID_RE.test(b.id)) fail(400, 'id required');
      const r = await retryDefinition({ kind, id: b.id, identity: s.identity, team: s.team }, ctx.publish || {});
      return sendJson(res, r.ok ? 200 : 404, r);
    }
    case 'POST proposals': {
      const s = requireLogin(ctx);
      return sendJson(res, 200, await propose(ctx, await readJsonBody(req), s));
    }
    default: fail(404, `no editor API ${route}`);
  }
}

/** Serve /rules, /rules/* — true when handled (the caller returns), false for any other path. */
export async function handleEditorRequest(req, res, url, { repoRoot = path.resolve(HERE, '..'), dataDir, gameDir = HERE, profileFile = profilePath(), port, publish = {}, lockFile } = {}) {
  const u = typeof url === 'string' ? new URL(url, 'http://x') : url;
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { return false; }
  if (p !== '/rules' && !p.startsWith('/rules/')) return false;
  const ctx = { repoRoot, dataDir: dataDir || path.resolve(repoRoot, 'data'), gameDir, profileFile, port: port ?? req.socket?.localPort, publish, lockFile };
  try {
    if (p === '/rules') { res.writeHead(302, { Location: '/rules/', 'Cache-Control': 'no-cache' }); res.end(); return true; }
    const rel = p.slice('/rules/'.length);
    if (rel.startsWith('api/')) {
      // /rules/api/gen/* (gen-api.mjs, b9 2026-11-23): generate → preview → test → publish; same guard, POST = token + login.
      if (rel.startsWith('api/gen/')) {
        guard(req, ctx.port);
        await (await import('./gen-api.mjs')).handleGenApi(req, res, u, rel.slice('api/gen/'.length), ctx, { readJsonBody, requireLogin, validateDefinition, fail, sendJson });
        return true;
      }
      if (!rel.startsWith('api/editor/')) fail(404, 'not found');
      await handleApi(req, res, u, rel.slice('api/editor/'.length), ctx);
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }
    if (rel === '' || rel === 'rules.html' || rel === 'editor.html') {
      if (serveFile(res, safeJoin(repoRoot, 'editor.html')) || serveFile(res, safeJoin(gameDir, 'editor.html'))) return true;
      notFound(res); return true;
    }
    if (rel.startsWith('editor/')) {
      const sub = rel.slice('editor/'.length);
      if (serveFile(res, safeJoin(path.join(repoRoot, 'editor'), sub)) || serveFile(res, safeJoin(path.join(gameDir, 'editor'), sub))) return true;
      notFound(res); return true;
    }
    if (rel.startsWith('data/')) {
      const f = rel.slice('data/'.length);
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.json$/.test(f) || f.includes('..')) { notFound(res); return true; }
      const dc = definitionsCollectionText(ctx.dataDir, f);
      if (dc) { sendText(res, 200, MIME['.json'], dc); return true; }
      if (!serveFile(res, safeJoin(ctx.dataDir, f))) notFound(res);
      return true;
    }
    // chaosD6-GameModels (b9 2026-11-25): every kind as a read-only collection (gamemodels-collections.mjs)
    if (rel.startsWith('gamemodels/')) {
      const G = await import('./gamemodels-collections.mjs');
      const f = rel.slice('gamemodels/'.length);
      if (f === 'index.json') { sendText(res, 200, MIME['.json'], JSON.stringify(G.gameModelsIndex(ctx.dataDir))); return true; }
      const gm = /^([a-z_]+)\.json$/.exec(f), c = gm && G.gameModelsCollection(ctx.dataDir, gm[1]);
      if (c) sendText(res, 200, MIME['.json'], JSON.stringify(c)); else notFound(res);
      return true;
    }
    if (rel === 'defs/index.json') { sendText(res, 200, MIME['.json'], JSON.stringify(defsIndex(gameDir))); return true; }
    const m = /^defs\/(skill|effect|class)\/([a-z]+_[a-z0-9_]+)\.json$/.exec(rel);
    if (m && m[2].startsWith(`${m[1]}_`)) {
      if (!serveFile(res, safeJoin(path.join(gameDir, DEF_DIRS[m[1]]), `${m[2]}.json`))) notFound(res);
      return true;
    }
    notFound(res);
    return true;
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return true; }
    if (e instanceof HttpError) sendJson(res, e.status, { ok: false, error: e.message, ...e.extra });
    else { console.error(`[editor-api] ${req.method} ${p}: ${e.stack || e.message}`); sendJson(res, 500, { ok: false, error: e.message }); }
    return true;
  }
}
