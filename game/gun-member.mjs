// The slim member record a peer keeps in Gun (dimRoot/doors/<DOOR_ID>/members/<peer_id>).
//
// Gun is the slow, survive-every-reconnect tier: it only has to answer "who is in this dimension,
// where, alive?, on which clock, how far is their map, how do I dial them". Everything else in the
// public snapshot (stats, permanents, tokens, the `map_sketch` fingerprint…) reaches peers on the
// envelopes (slim game snapshot, libp2p + Nostr bus), the bus `state` heartbeat (full snapshot),
// the discovery mirror and the Door — never through Gun. A Gun put of the whole ~3–4 KB snapshot
// every action, re-gossiped by every relay, is what took the phone's Node heap to 2 GB (2026-11-14).
//
// Rules: (1) a record is ≤ GUN_MEMBER_CAP bytes of JSON — optional fields are dropped (last one in
// OPTIONAL first) until it fits; (2) a put only carries the fields that changed (Gun merges per
// field), and only when a non-volatile field changed or the keep-alive is due; (3) a reader takes
// only GUN_MEMBER_KEYS from a member node (stale fields an older run / build left in the relay graph
// stay out), and a Gun echo never overwrites what a fresher transport already told us.
// Pure; unit test: tools/gun-member-check.mjs.

export const GUN_MEMBER_CAP = 2048;
// Re-put at least this often so `last_seen` stays inside the readers' 90 s freshness window.
export const GUN_KEEPALIVE_MS = 60_000;
// …and at most this often for ordinary changes (tile, life, map growth): one put per action at most.
export const GUN_MIN_PUT_MS = 4_000;

// Always kept. Consumers: mergePeerState (peer_id, last_seen freshness, replaces, map_blocks → offerMapSync),
// roster / tierOf / standoff (name, alliance, ids, owner, tile, life), syncClockFromMesh / catchUpClock /
// waitingOnBusyMember (turn, round, action, phase, phase_ends_at), telemetry (map_tiles).
export const GUN_MEMBER_VERSION = 2;   // `gun_v` on every slim record; a node without it was written by an older build
export const GUN_MEMBER_CORE = [
  'gun_v', 'peer_id', 'name', 'alliance', 'character_id', 'creature_id', 'owner_peer_id',
  'tile_q', 'tile_r', 'life', 'life_max',
  'turn', 'round', 'action', 'phase', 'phase_ends_at', 'last_seen',
  'map_blocks', 'map_tiles', 'map_root', 'replaces',   // map_root: M3 digest root, so Gun-only peers sync by root
];
// Kept while the record fits, dropped from the END of this list first. multiaddrs_csv (mergePeerState
// dials it; buildDoor's bootstrap list) is trimmed address by address before it goes entirely.
export const GUN_MEMBER_OPTIONAL = [
  'multiaddrs_csv', 'gun_url', 'nostr_pubkey', 'nostr_relays_csv',
  'source_id', 'team_name', 'profile_char_id', 'resources_id',
];
export const GUN_MEMBER_KEYS = [...GUN_MEMBER_CORE, ...GUN_MEMBER_OPTIONAL];
const KEYSET = new Set(GUN_MEMBER_KEYS);
// Written with every put, but a change in it alone never causes one.
export const GUN_VOLATILE = new Set(['last_seen']);
// The live clock: a change here is put AT ONCE, never throttled. Between a peer's evt_turn/state_hash
// and its next commit, Gun is the only local path that tells the others "I am in planning for action N
// until T" — enterPhase (trail the slowest), waitingOnBusyMember (wait for a member still planning) and
// catchUpClock read exactly these. Deduping them (first M2 cut) let a joiner on a shifted cohort be
// closed out of an action it was still planning → its attack resolved only on its own peer
// (Swarm-0226 T1.R1, foe-2 hp1 vs hp2).
export const GUN_URGENT = new Set(['turn', 'round', 'action', 'phase', 'phase_ends_at']);

const MAX_STR = 160;   // one field; multiaddrs_csv / nostr_relays_csv are budgeted by the cap instead
const LONG_OK = new Set(['multiaddrs_csv', 'nostr_relays_csv']);
export const recordBytes = (r) => Buffer.byteLength(JSON.stringify(r), 'utf8');

function scalar(k, v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v);
  return LONG_OK.has(k) || s.length <= MAX_STR ? s : s.slice(0, MAX_STR);
}

// Full public snapshot → slim record. `dropped` lists what the cap removed (empty normally).
export function slimMemberRecord(snap, { cap = GUN_MEMBER_CAP } = {}) {
  const rec = {};
  for (const k of GUN_MEMBER_KEYS) { const v = scalar(k, snap?.[k]); if (v !== undefined) rec[k] = v; }
  rec.gun_v = GUN_MEMBER_VERSION;
  const dropped = [];
  let bytes = recordBytes(rec);
  for (let i = GUN_MEMBER_OPTIONAL.length - 1; bytes > cap && i >= 0; i--) {
    const k = GUN_MEMBER_OPTIONAL[i];
    if (!(k in rec)) continue;
    if (k === 'multiaddrs_csv') {
      const addrs = String(rec[k]).split(',').filter(Boolean);
      while (addrs.length > 1 && bytes > cap) { addrs.pop(); rec[k] = addrs.join(','); bytes = recordBytes(rec); }
      if (bytes <= cap) { dropped.push(`${k}(trimmed)`); break; }
    }
    delete rec[k]; dropped.push(k); bytes = recordBytes(rec);
  }
  return { rec, bytes, dropped, over: bytes > cap };
}

// What to put now, given the last record put (null = nothing put yet). Returns null when nothing is due.
// A field that left the record (dropped by the cap) is put as null — Gun's delete.
export function gunMemberPatch(prev, rec, { now = Date.now(), lastPutAt = 0, keepaliveMs = GUN_KEEPALIVE_MS, minPutMs = GUN_MIN_PUT_MS } = {}) {
  if (!prev) return { ...rec };
  const patch = {};
  let meaningful = false, urgent = false;
  for (const k of new Set([...Object.keys(prev), ...Object.keys(rec)])) {
    const v = k in rec ? rec[k] : null;
    if (prev[k] === v) continue;
    patch[k] = v;
    if (!GUN_VOLATILE.has(k)) meaningful = true;
    if (GUN_URGENT.has(k)) urgent = true;
  }
  const age = now - lastPutAt;
  if (!urgent && !(meaningful && age >= minPutMs) && age < keepaliveMs) return null;
  if (!Object.keys(patch).length) return null;
  return patch;
}

// Reader side: a member node as Gun hands it to `.map().on` → the slim record (Gun's `_` meta and any
// field outside GUN_MEMBER_KEYS dropped — e.g. what an older run of the same peer id left in the relay
// graph). A node without `gun_v` comes from an older build that still writes its full snapshot every
// round: taken whole (minus `_`), as before, so its stats / sketch keep arriving. null = not a member.
export function pickGunMember(m) {
  if (!m || typeof m !== 'object' || typeof m.peer_id !== 'string' || !m.peer_id) return null;
  const legacy = !(Number(m.gun_v) >= GUN_MEMBER_VERSION);
  const out = {};
  for (const k of Object.keys(m)) if (k !== '_' && k !== 'gun_v' && (legacy || KEYSET.has(k)) && m[k] !== null && m[k] !== undefined) out[k] = m[k];
  return out;   // the format marker stays in Gun: peersPublic entries look exactly like any other transport's
}

// Merge rule for a Gun echo against what we already hold for that peer: when our entry is at least as
// fresh (last_seen), Gun may only fill fields we lack — a late echo must not roll tile / life / clock back.
// Returns the object to hand to mergePeerState, or null when there is nothing new.
export function gunMergeable(prev, rec) {
  if (!rec) return null;
  if (!prev) return rec;
  const pt = Date.parse(prev.last_seen || 0) || 0, rt = Date.parse(rec.last_seen || 0) || 0;
  if (rt > pt) return rec;
  const fill = {};
  for (const [k, v] of Object.entries(rec)) if (prev[k] === undefined) fill[k] = v;
  return Object.keys(fill).length ? { ...fill, peer_id: rec.peer_id, last_seen: prev.last_seen } : null;
}
