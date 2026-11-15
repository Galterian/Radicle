// Unit checks for game/merge-order.mjs — snapshot ordering (every mergePeerState input) and the join /
// phase clock reference. Oracles are the two Swarm-0407 divergences.
// Run from game/: node tools/merge-order-check.mjs  → "all merge-order checks passed"
import assert from 'node:assert/strict';
import { orderedMerge, pickClockRef, cohortDeadline, snapAction, meshZones } from '../merge-order.mjs';
import { gunMergeable } from '../gun-member.mjs';

const iso = (ms) => new Date(ms).toISOString();
const T = 1_700_000_000_000;
// The mergePeerState fold, as peer.mjs does it: take = orderedMerge(prev, p); held = { ...prev, ...take }.
const fold = (held, p) => { const take = orderedMerge(held, p); return take ? { ...held, ...take } : held; };

// --- (a) Swarm-0407 T2.R3: foe-1 died at T2.R2; the Nostr replay hands the joiner its pre-death envelopes AFTER the death snapshot.
{
  const alive = { peer_id: 'peer:foe-1', life: 1, tile_q: 2, tile_r: 1, action: 7, phase: 'reveal', permanents_csv: 'effect_earthquake', last_seen: iso(T) };
  const dead = { peer_id: 'peer:foe-1', life: 0, tile_q: 2, tile_r: 1, action: 8, phase: 'planning', permanents_csv: '', last_seen: iso(T + 3000) };
  let held = {};
  held = fold(held, dead);          // libp2p: the fresh death snapshot first
  held = fold(held, alive);         // bus replay: the older, pre-death one
  assert.equal(held.life, 0, 'dead stays dead');
  assert.equal(held.action, 8, 'clock not rolled back');
  assert.equal(held.permanents_csv, '', 'permanents not rolled back');
  assert.equal(held.last_seen, dead.last_seen);
  assert.equal(orderedMerge(dead, alive), null, 'nothing new in an older full snapshot');
  // order of arrival does not matter
  assert.deepEqual(fold(fold({}, alive), dead), fold(fold({}, dead), alive));
  console.log('ok  older snapshot never resurrects / rolls back life, clock, permanents (T2.R3 oracle)');
}
// --- older snapshot may fill gaps; a NEWER one (resurrection) wins
{
  const slim = { peer_id: 'peer:x', life: 0, action: 20, last_seen: iso(T + 5000) };
  const oldFull = { peer_id: 'peer:x', life: 4, action: 18, stat_will: 30, multiaddrs_csv: '/ip4/1.2.3.4/tcp/1', last_seen: iso(T) };
  const held = fold(slim, oldFull);
  assert.equal(held.life, 0); assert.equal(held.action, 20);
  assert.equal(held.stat_will, 30, 'missing field filled'); assert.equal(held.multiaddrs_csv, '/ip4/1.2.3.4/tcp/1');
  const raised = { peer_id: 'peer:x', life: 3, action: 22, last_seen: iso(T + 9000) };
  assert.equal(fold(held, raised).life, 3, 'resurrection by a newer snapshot');
  // same statement re-delivered (libp2p + bus): taken, idempotent
  assert.deepEqual(fold(raised, { ...raised }), raised);
  // first contact: taken whole
  assert.deepEqual(orderedMerge(undefined, oldFull), oldFull);
  assert.deepEqual(orderedMerge({}, oldFull), oldFull);
  // composes with the Gun path: gunMergeable's fill carries the held last_seen → taken as a fill
  const gunFill = gunMergeable(slim, { peer_id: 'peer:x', life: 4, name: 'X', last_seen: iso(T) });
  assert.deepEqual(gunFill, { name: 'X', peer_id: 'peer:x', last_seen: slim.last_seen });
  assert.equal(fold(slim, gunFill).name, 'X'); assert.equal(fold(slim, gunFill).life, 0);
  console.log('ok  older fills gaps only; newer (resurrection) wins; re-delivery idempotent; Gun fill composes');
}

// --- (b) Swarm-0407 T4.R2 clock reference
assert.equal(snapAction({ turn: 3, round: 1 }), 10);
assert.equal(snapAction({ action: 9, turn: 99 }), 9);
{
  const now = T + 100_000;
  const at = (id, action, phase, endsIn, seenAgo = 500) => ({ peer_id: id, action, turn: Math.floor(action / 3), round: action % 3, phase, phase_ends_at: now + endsIn, last_seen: iso(now - seenAgo) });
  // Cohort planning action 9 ending ~1.2 s from now; fresh joiner P-Agent5 also at 9 with a deadline 6 s out.
  const others = [at('peer:ally-1', 9, 'planning', 1200), at('peer:P-Agent3', 9, 'planning', 1300), at('peer:P-Agent4', 9, 'planning', 1250), at('peer:P-Agent5', 9, 'planning', 6500)];
  const pick = pickClockRef(others, { now });
  assert.equal(pick.action, 9); assert.equal(pick.phase, 'planning');
  assert.notEqual(pick.ref.peer_id, 'peer:P-Agent5', 'not the lagging joiner (old rule took the latest deadline)');
  assert.equal(pick.phase_ends_at, now + 1250, 'median deadline of the cohort');
  // A replayed / long-silent snapshot at a lower action is not evidence; a stale one at a HIGHER action neither.
  const withStale = [...others, at('peer:gone', 30, 'planning', 900, 60_000)];
  assert.equal(pickClockRef(withStale, { now }).action, 9, 'stale far-ahead snapshot ignored');
  // Most advanced FRESH action wins (cohort already at 10).
  const ahead = [...others, at('peer:foe-2', 10, 'planning', 5000), at('peer:P-Agent2', 10, 'planning', 5100)];
  const p2 = pickClockRef(ahead, { now });
  assert.equal(p2.action, 10); assert.equal(p2.cohort, 2);
  // Handshake under way at the top action → the joiner abstains (phase != planning); tie → later phase.
  const mid = [at('peer:a', 8, 'resolution', 300), at('peer:b', 8, 'reveal', 600), at('peer:c', 7, 'planning', 2000)];
  const p3 = pickClockRef(mid, { now });
  assert.equal(p3.action, 8); assert.equal(p3.phase, 'resolution');
  const maj = [at('peer:a', 8, 'planning', 300), at('peer:b', 8, 'planning', 600), at('peer:c', 8, 'reveal', 200)];
  assert.equal(pickClockRef(maj, { now }).phase, 'planning', 'majority phase');
  // Nobody fresh: fall back to whatever we heard (old behaviour), never null when someone has a clock.
  const allStale = [at('peer:a', 5, 'planning', 100, 50_000), at('peer:b', 6, 'planning', 100, 50_000)];
  assert.equal(pickClockRef(allStale, { now }).action, 6);
  assert.equal(pickClockRef([], { now }), null);
  assert.equal(pickClockRef([{ peer_id: 'peer:n' }], { now }), null);
  // Deterministic tie-break on equal deadlines.
  const tie = [at('peer:b', 4, 'planning', 1000), at('peer:a', 4, 'planning', 1000)];
  assert.equal(pickClockRef(tie, { now }).ref.peer_id, 'peer:a');
  console.log('ok  clock reference: fresh, most advanced, majority phase, median deadline (T4.R2 oracle)');

  // cohortDeadline: what a peer that slid a phase behind pulls its planning deadline in to.
  const plan10 = [at('peer:a', 10, 'planning', 1000), at('peer:b', 10, 'planning', 1400), at('peer:c', 10, 'reveal', 300), at('peer:d', 9, 'resolution', 200), at('peer:old', 10, 'planning', 9000, 40_000)];
  assert.equal(cohortDeadline(plan10, 10, { now }), now + 1400, 'latest fresh planning deadline at our action');
  assert.equal(cohortDeadline(plan10, 11, { now }), null);
  console.log('ok  cohort deadline: latest fresh planning deadline at the action, stale and other phases ignored');
}

// --- Swarm-0544 T4.R3: Blizzard laid 7 no-damage hexes at T4.R2 (action 13); C-Agent6 joined planning action 14 and
// resolved the T4-end Earthquake tick on P-Agent4 (in the zone) without them → hp1 vs hp2 everywhere else.
{
  const now = T + 200_000;
  const snap = (id, action, zones, seenAgo = 500) => ({ peer_id: id, action, last_seen: iso(now - seenAgo), zones_json: JSON.stringify(zones) });
  const bliz = [{ q: -1, r: 3, until_turn: 4 }, { q: -1, r: 4, until_turn: 4 }, { q: 0, r: 3, until_turn: 4 }];
  const old = [{ q: 5, r: 5, until_turn: 3 }];
  const peers = [snap('peer:player-1', 14, bliz), snap('peer:P-Agent4', 14, [...bliz].reverse()), snap('peer:late', 14, []),
    snap('peer:lag', 13, [{ q: 9, r: 9, until_turn: 4 }]), snap('peer:stale', 14, [{ q: 8, r: 8, until_turn: 4 }], 60_000), snap('peer:prev', 14, old)];
  const got = meshZones(peers, 14, 4, { now });
  assert.deepEqual(got, [{ q: -1, r: 3, until_turn: 4 }, { q: -1, r: 4, until_turn: 4 }, { q: 0, r: 3, until_turn: 4 }], 'union of fresh peers at the action, expired / lagging / stale ignored, sorted');
  assert.ok(got.some(z => z.q === -1 && z.r === 3), "P-Agent4's hex (-1,3) is a no-damage zone for the joiner");
  assert.deepEqual(meshZones([snap('peer:x', 14, 'garbage')], 14, 4, { now }), []);
  assert.deepEqual(meshZones([{ peer_id: 'peer:y', action: 14, last_seen: iso(now), zones_json: '{bad' }], 14, 4, { now }), []);
  console.log('ok  mid-turn joiner adopts the no-damage zones laid earlier this turn (Swarm-0544 T4.R3 oracle)');
}

console.log('all merge-order checks passed');
