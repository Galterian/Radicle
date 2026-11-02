// local-seeds — peer-side half of the Firebase registry at firebase/.
//
// Why this exists: Radicle sync is p2p libp2p over TCP, which Firebase can't
// hold. But a new peer still needs to KNOW the address of at least one live
// seed to dial. This module turns the Firestore project at firebase/ into
// that discovery layer:
//
//   publishSeedPresence({nid, rid, radicleAddr, alias, uiHref})
//     ↳ upserts peers/<nid> every push + on peer boot. The web UI shows this
//       and the "clone" box on each peer's page uses radicleAddr for `--seed`.
//
//   publishDimensionPush({dimensionName, nid, rid, doorDoc, commit, subject})
//     ↳ upserts dimensions/<name>, writes dimensions/<name>/doors/<nid>, and
//       appends dimensions/<name>/commits/<sha>. Called from radicle-adapter's
//       pushDimension() right after a successful rad push.
//
//   fetchSeeds({rid, maxAgeMs}) → [{nid, radicleAddr, alias, lastSeen}]
//     ↳ a new peer calls this at boot and feeds the result to `rad sync` and
//       to its libp2p bootstrap list.
//
// Transport: Firestore REST v1 (no npm dep). All writes gated on
// FIREBASE_PROJECT_ID + FIREBASE_API_KEY env vars — unset = module is a no-op
// so existing peers run unchanged.

import { createHash } from 'node:crypto';

// Defaults are the "Dimensions contributor node" project. These are the
// *public* web-app identifiers (same values embedded in firebase/public/app.js);
// Firestore security is enforced by firestore.rules, not by hiding the apiKey.
// Env vars override so a fork can point its peers at a different project.
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'dimensions-4e9ae';
const FIREBASE_API_KEY    = process.env.FIREBASE_API_KEY    || 'AIzaSyBhdSRv94CpmE7rOYjupz0MfEzBR1YyqZg';
const SEEDS_ENABLED       = !!(FIREBASE_PROJECT_ID && FIREBASE_API_KEY) && process.env.FIREBASE_SEEDS_DISABLE !== '1';
// The firestore REST endpoint for a project; collection/document ids go in path.
const BASE = SEEDS_ENABLED
  ? `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`
  : '';
const KEY = SEEDS_ENABLED ? `?key=${encodeURIComponent(FIREBASE_API_KEY)}` : '';

export const seedsEnabled = SEEDS_ENABLED;
export const seedsReason  = SEEDS_ENABLED ? '' : 'FIREBASE_PROJECT_ID / FIREBASE_API_KEY unset';
if (!SEEDS_ENABLED) console.warn(`[local-seeds] disabled (${seedsReason}) — peer will not publish presence or discover others via Firebase`);

// Firestore REST wants typed Value wrappers (`stringValue`, `integerValue`,
// `timestampValue`, `mapValue`, `arrayValue`). Centralised here so the rest
// of the module writes plain JS objects.
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean')         return { booleanValue: v };
  if (typeof v === 'number')          return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string')          return { stringValue: v };
  if (v instanceof Date)              return { timestampValue: v.toISOString() };
  if (Array.isArray(v))               return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object')          return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
  return { stringValue: String(v) };
}
function fromValue(v) {
  if (!v) return undefined;
  if ('stringValue'    in v) return v.stringValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return v.doubleValue;
  if ('booleanValue'   in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue'      in v) return null;
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue'       in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromValue(x)]));
  return undefined;
}
function fieldsOf(doc) { return Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, toValue(v)])); }
function docToObject(doc) {
  if (!doc?.fields) return null;
  return Object.fromEntries(Object.entries(doc.fields).map(([k, v]) => [k, fromValue(v)]));
}

async function restPatch(path, fields, updateMask) {
  if (!SEEDS_ENABLED) return { skipped: true };
  const url = `${BASE}/${path}${KEY}${updateMask ? '&' + updateMask.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&') : ''}`;
  const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`firestore PATCH ${path} ${res.status}: ${body.slice(0, 240)}`);
  }
  return res.json();
}
async function restGet(path) {
  if (!SEEDS_ENABLED) return null;
  const res = await fetch(`${BASE}/${path}${KEY}`, { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`firestore GET ${path} ${res.status}: ${body.slice(0, 240)}`);
  }
  return res.json();
}
async function restRunQuery(parent, query) {
  if (!SEEDS_ENABLED) return [];
  const res = await fetch(`${BASE}/${parent}:runQuery${KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: query }) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`firestore runQuery ${res.status}: ${body.slice(0, 240)}`);
  }
  const rows = await res.json();
  return rows.filter(r => r.document).map(r => docToObject(r.document));
}

// Firestore wants document ids to match [a-zA-Z0-9_.-]+; NIDs are base58 so
// they're already safe. Dimension names come from users, so sanitise.
const safeName = s => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const safeNid  = s => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

// Register / refresh this peer's presence. Call at boot and after each push.
export async function publishSeedPresence({ nid, rid, radicleAddr = null, alias = '', uiHref = '' } = {}) {
  if (!SEEDS_ENABLED || !nid) return { ok: false, reason: SEEDS_ENABLED ? 'no nid' : seedsReason };
  const fields = fieldsOf({
    nid, rid: rid || '', radicleAddr: radicleAddr || '', alias: alias || '', uiHref: uiHref || '',
    lastSeen: new Date(),
  });
  try {
    await restPatch(`peers/${safeNid(nid)}`, fields);
    return { ok: true };
  } catch (e) { console.warn(`[local-seeds] publishSeedPresence failed: ${e.message}`); return { ok: false, reason: e.message }; }
}

// Called by radicle-adapter.mjs after a successful pushDimension. Writes three
// documents in parallel — the dimension header, the door for this peer, and
// one commit record (uniqueified by sha, so retries are idempotent).
export async function publishDimensionPush({
  dimensionName, nid, rid, radicleAddr = null, alias = '',
  doorDoc = null, commit = null, subject = '', branch = '',
} = {}) {
  if (!SEEDS_ENABLED || !dimensionName || !nid) return { ok: false, reason: SEEDS_ENABLED ? 'missing args' : seedsReason };
  const name = safeName(dimensionName);
  const now = new Date();
  const dim = fieldsOf({
    name: dimensionName, creatorNid: doorDoc?.creator_nid || nid, rid: rid || '',
    lastPushAt: now, lastCommit: commit || '', peerCount: doorDoc?.known_members?.length || 1,
  });
  const ops = [restPatch(`dimensions/${name}`, dim)];
  if (doorDoc) {
    const door = fieldsOf({
      nid, peer_id: doorDoc.peer_id || '', alliance: doorDoc.alliance || '',
      name:  doorDoc.name || '', life: doorDoc.life ?? null, life_max: doorDoc.life_max ?? null,
      tile:  doorDoc.tile || null, pushed_at: now, commit: commit || '',
    });
    ops.push(restPatch(`dimensions/${name}/doors/${safeNid(nid)}`, door));
  }
  if (commit) {
    const sha = String(commit).slice(0, 40);
    const row = fieldsOf({
      sha, branch: branch || `ActiveDimensions/${dimensionName}`,
      subject: subject || `push ${dimensionName}`, when: now,
      pushedBy: nid, author: alias || nid,
    });
    ops.push(restPatch(`dimensions/${name}/commits/${sha}`, row));
  }
  try { await Promise.all(ops); return { ok: true }; }
  catch (e) { console.warn(`[local-seeds] publishDimensionPush failed: ${e.message}`); return { ok: false, reason: e.message }; }
}

// A new peer calls this at boot. maxAgeMs defaults to 1h — anything older is
// probably offline. Returns {nid, radicleAddr} tuples the caller can feed to
// `rad sync --seed <addr> --from <nid>` and to libp2p bootstrap.
export async function fetchSeeds({ rid = '', maxAgeMs = 3600_000, max = 20 } = {}) {
  if (!SEEDS_ENABLED) return [];
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  // Firestore REST where+orderBy need matching index; keep the query simple
  // and filter rid in-process so no composite index is required.
  const q = {
    from: [{ collectionId: 'peers' }],
    where: { fieldFilter: { field: { fieldPath: 'lastSeen' }, op: 'GREATER_THAN', value: { timestampValue: cutoff } } },
    orderBy: [{ field: { fieldPath: 'lastSeen' }, direction: 'DESCENDING' }],
    limit: Math.max(1, Math.min(100, max * 4)),
  };
  try {
    const rows = await restRunQuery('', q);
    const out = rows.filter(r => r.nid && (!rid || !r.rid || r.rid === rid)).slice(0, max);
    return out.map(r => ({ nid: r.nid, radicleAddr: r.radicleAddr || '', alias: r.alias || '', rid: r.rid || '', lastSeen: r.lastSeen }));
  } catch (e) { console.warn(`[local-seeds] fetchSeeds failed: ${e.message}`); return []; }
}

// Convenience for peer boot: dedup/merge the seed addresses into an existing
// bootstrap list (e.g. the one assembled by ui-server.mjs from the Door docs).
export function mergeBootstrap(existing, seeds) {
  const set = new Set(existing || []);
  for (const s of seeds) if (s.radicleAddr) set.add(s.radicleAddr);
  return [...set];
}

// Deterministic avatar hash for the UI if an alias isn't set — same NID → same
// chip color across all browsers.
export function colorForNid(nid) {
  const h = createHash('sha256').update(String(nid || '')).digest('hex');
  return `#${h.slice(0, 6)}`;
}

// CLI entry: inspect what Firebase currently knows.
//   node game/local-seeds.mjs peers
//   node game/local-seeds.mjs peer   <nid>
//   node game/local-seeds.mjs dims
//   node game/local-seeds.mjs commit <dimensionName>
if (process.argv[1] && process.argv[1].endsWith('local-seeds.mjs')) {
  const cmd = process.argv[2];
  if (!SEEDS_ENABLED) {
    console.error(`local-seeds disabled: ${seedsReason}`);
    console.error('Set FIREBASE_PROJECT_ID and FIREBASE_API_KEY to use this.');
    process.exit(2);
  }
  if (cmd === 'peers') {
    const seeds = await fetchSeeds({ maxAgeMs: 24 * 3600_000, max: 50 });
    for (const s of seeds) console.log(`${s.nid}  ${s.radicleAddr || '(no addr)'}  alias=${s.alias || '-'}  last=${s.lastSeen}`);
  } else if (cmd === 'peer' && process.argv[3]) {
    const r = await restGet(`peers/${safeNid(process.argv[3])}`);
    console.log(JSON.stringify(docToObject(r), null, 2));
  } else if (cmd === 'dims') {
    const q = { from: [{ collectionId: 'dimensions' }], orderBy: [{ field: { fieldPath: 'lastPushAt' }, direction: 'DESCENDING' }], limit: 50 };
    const rows = await restRunQuery('', q);
    for (const d of rows) console.log(`${d.name}  creator=${d.creatorNid}  last=${d.lastPushAt}  peers=${d.peerCount ?? '?'}`);
  } else if (cmd === 'commits' && process.argv[3]) {
    const name = safeName(process.argv[3]);
    const q = { from: [{ collectionId: 'commits' }], orderBy: [{ field: { fieldPath: 'when' }, direction: 'DESCENDING' }], limit: 20 };
    const rows = await restRunQuery(`dimensions/${name}`, q);
    for (const c of rows) console.log(`${String(c.sha).slice(0, 10)}  ${c.when}  ${c.pushedBy}  ${c.subject}`);
  } else {
    console.log('usage: node local-seeds.mjs peers | peer <nid> | dims | commits <dimensionName>');
  }
}
