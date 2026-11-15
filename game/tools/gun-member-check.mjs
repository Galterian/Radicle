// Unit checks for game/gun-member.mjs (the slim Gun member record) and join-plan doorMapSummaries.
// Run from game/: node tools/gun-member-check.mjs  → "all gun-member checks passed"
import assert from 'node:assert/strict';
import { slimMemberRecord, gunMemberPatch, pickGunMember, gunMergeable, recordBytes, GUN_MEMBER_CAP, GUN_MEMBER_KEYS, GUN_KEEPALIVE_MS, GUN_MIN_PUT_MS } from '../gun-member.mjs';
import { doorMapSummaries, describeDimension } from '../join-plan.mjs';
import { initialBlock, discBlock, createKnownMap } from '../js/map.js';

const addr = i => `/ip4/192.168.1.${i}/tcp/74${10 + i}/ws/p2p/12D3KooWQx9pzk3Jf8nN1yR6m2vVtQ6c7x8z9AbCdEfGhIjKlMn${i}`;
// A full snapshot the way currentStateSnapshot() builds it (abridged game fields + the full-only ones).
const full = {
  peer_id: 'peer:alice', character_id: 'char_mage', creature_id: null, tile_q: 3, tile_r: -2, life: 7, life_max: 9,
  alliance: 'player', name: 'Alice', source_id: 'src_char_mage_v1', last_seen: new Date(1_000_000).toISOString(),
  owner_peer_id: '', summoned_csv: '', wards_csv: '', entry_q: 1, entry_r: 2,
  turn: 4, round: 1, action: 13, phase: 'planning', phase_ends_at: 1_006_000, map_blocks: 12,
  stat_vitality: 30, stat_world: 25, permanents_csv: 'effect_shield,effect_haste', stat_tokens_json: '[]',
  traps_json: '[{"q":1,"r":1}]', world_edits_json: '[]', replaces: '', team_name: 'MoonGuard', profile_char_id: 'p1', resources_id: 'res_mage',
  gun_url: 'http://192.168.1.5:7520/gun', multiaddrs_csv: [1, 2, 3].map(addr).join(','),
  nostr_pubkey: 'f'.repeat(64), nostr_relays_csv: 'wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band',
  map_tiles: 1419, map_sketch: Array.from({ length: 128 }, (_, i) => (1e8 + i * 7919).toString(36)).join(','),
};
const fullBytes = recordBytes(full);

// 1. Only whitelisted fields, never the fingerprint or game state; under the cap.
const { rec, bytes, dropped, over } = slimMemberRecord(full);
assert.equal(over, false); assert.deepEqual(dropped, []);
assert.ok(bytes <= GUN_MEMBER_CAP, `slim ${bytes} B`);
for (const k of Object.keys(rec)) assert.ok(GUN_MEMBER_KEYS.includes(k), k);
for (const k of ['map_sketch', 'permanents_csv', 'stat_vitality', 'traps_json', 'entry_q', 'summoned_csv']) assert.ok(!(k in rec), `${k} must stay out of Gun`);
for (const k of ['peer_id', 'name', 'alliance', 'tile_q', 'tile_r', 'life', 'life_max', 'turn', 'round', 'action', 'map_tiles', 'map_blocks', 'last_seen', 'multiaddrs_csv', 'gun_url'])
  assert.ok(k in rec, `${k} kept`);
console.log(`ok  slim record ${bytes} B (full snapshot here ${fullBytes} B)`);

// 2. Over the cap: optional fields go last-first, multiaddrs trimmed before dropped; core always stays.
const fat = { ...full, multiaddrs_csv: Array.from({ length: 30 }, (_, i) => addr(i)).join(','), team_name: 'x'.repeat(500) };
const r2 = slimMemberRecord(fat);
assert.ok(r2.bytes <= GUN_MEMBER_CAP, `capped ${r2.bytes}`);
assert.equal(slimMemberRecord({ ...full, team_name: 'x'.repeat(500) }).rec.team_name.length, 160, 'long single field truncated');
assert.ok(r2.dropped.includes('multiaddrs_csv(trimmed)'), r2.dropped.join());
assert.ok(r2.rec.multiaddrs_csv.split(',').length >= 1 && r2.rec.multiaddrs_csv.split(',').length < 30);
assert.ok(r2.dropped.indexOf('resources_id') < r2.dropped.indexOf('multiaddrs_csv(trimmed)'), 'drop order: tail of OPTIONAL first');
for (const k of ['peer_id', 'tile_q', 'life', 'turn', 'map_tiles']) assert.ok(k in r2.rec);
const r3 = slimMemberRecord({ ...fat, multiaddrs_csv: 'x'.repeat(5000) });   // one unsplittable address
assert.ok(!('multiaddrs_csv' in r3.rec) && r3.bytes <= GUN_MEMBER_CAP && r3.dropped.includes('multiaddrs_csv'));
const r4 = slimMemberRecord(full, { cap: 200 });   // core alone over a silly cap: flagged, core kept
assert.equal(r4.over, true); assert.ok('peer_id' in r4.rec && !('multiaddrs_csv' in r4.rec));
console.log(`ok  cap: ${r2.bytes} B after dropping ${r2.dropped.join(', ')}`);

// 3. Dedupe: first put = whole record; clock ticks alone wait for the keep-alive; real changes go
//    (rate-limited) and carry only the changed fields; a field the cap drops is put as null.
const t0 = 2_000_000;
assert.deepEqual(gunMemberPatch(null, rec), rec);
const tick = slimMemberRecord({ ...full, action: 14, round: 2, phase: 'planning', phase_ends_at: 1_012_000, last_seen: new Date(t0 + 500).toISOString() }).rec;
const tp = gunMemberPatch(rec, tick, { now: t0 + 500, lastPutAt: t0 });
assert.deepEqual(Object.keys(tp).sort(), ['action', 'last_seen', 'phase_ends_at', 'round'], 'clock change goes out at once, unthrottled (Swarm-0226)');
const beat = slimMemberRecord({ ...full, last_seen: new Date(t0 + 15000).toISOString() }).rec;
assert.equal(gunMemberPatch(rec, beat, { now: t0 + 15000, lastPutAt: t0 }), null, 'heartbeat with nothing new is deduped');
const ka = gunMemberPatch(rec, beat, { now: t0 + GUN_KEEPALIVE_MS, lastPutAt: t0 });
assert.ok(ka && Object.keys(ka).join() === 'last_seen', 'keep-alive carries just last_seen');
const moved = slimMemberRecord({ ...full, tile_q: 4, last_seen: new Date(t0 + 5000).toISOString() }).rec;
assert.equal(gunMemberPatch(rec, moved, { now: t0 + GUN_MIN_PUT_MS - 1, lastPutAt: t0 }), null, 'rate-limited');
const mp = gunMemberPatch(rec, moved, { now: t0 + GUN_MIN_PUT_MS, lastPutAt: t0 });
assert.deepEqual(Object.keys(mp).sort(), ['last_seen', 'tile_q']);
assert.equal(gunMemberPatch(rec, rec, { now: t0 + 10 * GUN_KEEPALIVE_MS, lastPutAt: t0 }), null, 'identical → nothing');
const gone = { ...rec }; delete gone.team_name;
assert.equal(gunMemberPatch(rec, gone, { now: t0 + GUN_MIN_PUT_MS, lastPutAt: t0 }).team_name, null);
console.log(`ok  dedupe: move patch ${recordBytes(mp)} B, keep-alive ${recordBytes(ka)} B`);

// 4. Reader: whitelist (Gun meta + stale/legacy full fields dropped), stale echoes only fill gaps.
assert.equal(rec.gun_v, 2, 'slim records are versioned');
const gunNode = { _: { '#': 'x', '>': {} }, ...full, gun_v: 2, permanents_csv: 'stale', map_sketch: 'stale' };
const picked = pickGunMember(gunNode);
assert.ok(!('_' in picked) && !('permanents_csv' in picked) && !('map_sketch' in picked) && picked.tile_q === 3);
const legacy = pickGunMember({ _: { '#': 'x' }, ...full });   // an older build's full-snapshot put
assert.ok(!('_' in legacy) && legacy.permanents_csv === full.permanents_csv && legacy.map_sketch === full.map_sketch, 'legacy record taken whole');
assert.equal(pickGunMember({ name: 'no id' }), null);
const fresher = { ...full, tile_q: 9, last_seen: new Date(2_000_000).toISOString() };
assert.equal(gunMergeable(fresher, picked), null, 'older echo with nothing new is ignored');
const fill = gunMergeable({ peer_id: full.peer_id, tile_q: 9, last_seen: fresher.last_seen }, picked);
assert.equal(fill.tile_q, undefined); assert.equal(fill.name, 'Alice'); assert.equal(fill.last_seen, fresher.last_seen);
assert.equal(gunMergeable({ ...full, last_seen: new Date(1).toISOString() }, picked), picked, 'newer echo applies');
assert.equal(gunMergeable(undefined, picked), picked);
console.log('ok  reader whitelist + freshness merge');

// 5. Door map summaries: exact `held` from blocks; sketch-only and legacy Doors.
const seed = '0x1234abcd';
const bA = [initialBlock(), discBlock(10, 0, 3, 'peer:a')], bB = [initialBlock(), discBlock(-10, 0, 3, 'peer:b')];
const now = new Date().toISOString();
const dim = { dimension_name: 'T', dimension_id: 'dim-t', namespaces: [], legacy_doors: [], doors: [
  { door_version: 2, peer_id: 'peer:a', name: 'A', character_id: 'char_x', pushed_at: now, map: { seed, tiles_known: 62, blocks: bA }, map_tiles: 62, map_sketch: 'abc,def' },
  { door_version: 2, peer_id: 'peer:b', name: 'B', character_id: 'char_y', pushed_at: now, map: { seed, tiles_known: 62, blocks: bB } },
  { door_version: 2, peer_id: 'peer:c', name: 'C', creature_id: 'mon_z', pushed_at: now, map_sketch: 'k1,k2' },
] };
const km = createKnownMap(seed, [...bA, ...bB]);
const sums = doorMapSummaries(dim, km);
const A = sums.find(s => s.peer_id === 'peer:a'), C = sums.find(s => s.peer_id === 'peer:c');
assert.equal(A.held, createKnownMap(seed, bA).size()); assert.equal(A.held_of, km.size());
assert.equal(A.map_sketch, 'abc,def'); assert.equal(C.held, null); assert.equal(C.map_sketch, 'k1,k2');
assert.ok(A.held / km.size() > 0.5 && A.held / km.size() < 1, `share ${A.held}/${km.size()}`);
const desc = describeDimension(dim);
assert.equal(desc.doors.find(d => d.peer_id === 'peer:a').map_sketch, 'abc,def');
assert.equal(desc.doors.find(d => d.peer_id === 'peer:b').map_sketch, null);
console.log(`ok  door summaries: A holds ${A.held}/${km.size()} hexes (exact), C sketch-only`);

console.log('all gun-member checks passed');
