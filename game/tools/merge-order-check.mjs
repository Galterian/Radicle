// Unit checks for game/merge-order.mjs — snapshot ordering (every mergePeerState input) and the join /
// phase clock reference. Oracles are the two Swarm-0407 divergences.
// Run from game/: node tools/merge-order-check.mjs  → "all merge-order checks passed"
import assert from 'node:assert/strict';
import { orderedMerge, pickClockRef, cohortDeadline, snapAction, meshZones, resolverPeers, clockFrame, notePrior, resolverBase, resolvedThrough } from '../merge-order.mjs';
import { gunMergeable, GUN_MEMBER_CORE } from '../gun-member.mjs';

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

// --- (e) GunLive85 run 3 T8.R3: gX (cut from libp2p + bus) is known on gA / gD only through Gun, on (15,-16).
//     gA moves to (15,-16). Before: the resolver view = every held snapshot → gA / gD vetoed the move, gB / gC let it.
{
  const now = T + 500_000;
  const s = (id, q, r, life = 5) => ({ peer_id: id, tile_q: q, tile_r: r, life, alliance: 'npc_a', last_seen: iso(now - 800) });
  const common = [s('peer:gA', 15, -15), s('peer:gB', 3, 1), s('peer:gC', 2, 3), s('peer:gM', 4, 4)];
  const gX = s('peer:gX', 15, -16);
  const wire = new Set(common.map(p => p.peer_id));
  const heldA = new Map([...common, gX].map(p => [p.peer_id, p]));   // gA / gD: gX merged from a Gun echo
  const heldB = new Map(common.map(p => [p.peer_id, p]));            // gB / gC: no Gun echo of gX yet
  const occupied = (view) => new Set([...view.values()].filter(p => p.life > 0).map(p => `${p.tile_q},${p.tile_r}`));
  const naive = [occupied(heldA).has('15,-16'), occupied(heldB).has('15,-16')];
  assert.deepEqual(naive, [true, false], 'the bug: the raw held map disagrees on (15,-16)');
  const vA = resolverPeers(heldA, 'peer:gA', wire), vB = resolverPeers(heldB, 'peer:gB', wire);
  assert.deepEqual([...vA.keys()].sort(), [...vB.keys()].sort(), 'same resolver members on both sides');
  assert.equal(occupied(vA).has('15,-16'), occupied(vB).has('15,-16'), 'same occupancy of the disputed hex');
  assert.ok(!vA.has('peer:gX'), 'a Gun-only member is not in the view');
  // once gX is heard on the wire (an envelope / state / clock frame), it is in everyone's view again
  const wire2 = new Set([...wire, 'peer:gX']);
  assert.ok(resolverPeers(heldA, 'peer:gA', wire2).has('peer:gX'));
  // self is always in, even if never "heard"
  assert.ok(resolverPeers(new Map([['peer:me', s('peer:me', 0, 0)]]), 'peer:me', new Set()).has('peer:me'));
  console.log('ok  a member known only through Gun never enters the resolver view / occupancy (GunLive85 T8.R3 oracle)');
}
// --- (f) Swarm-0226 without Gun: the planning clock reaches the cohort as a wire `clock` frame.
{
  const now = T + 600_000;
  const keys = GUN_MEMBER_CORE.filter(k => k !== 'gun_v');
  const full = { peer_id: 'peer:J', name: 'J', alliance: 'player', tile_q: 1, tile_r: 2, life: 9, life_max: 9, turn: 3, round: 1, action: 10,
    phase: 'resolution', phase_ends_at: now - 100, last_seen: iso(now - 2000), permanents_csv: 'effect_shield', stat_will: 6, map_sketch: 'x'.repeat(900) };
  let held = fold({}, full);                    // from J's state_hash envelope: resolving action 10
  const plan = { ...full, turn: 3, round: 2, action: 11, phase: 'planning', phase_ends_at: now + 4000, last_seen: iso(now - 50) };
  const { sig, rec } = clockFrame(plan, keys);
  assert.equal(sig, `11|planning|${now + 4000}`);
  assert.ok(!('permanents_csv' in rec) && !('map_sketch' in rec) && !('gun_v' in rec), 'core fields only');
  assert.ok(JSON.stringify({ kind: 'clock', dim: 'dim-x', state: rec }).length < 600, 'small frame');
  held = fold(held, rec);
  assert.equal(held.action, 11); assert.equal(held.phase, 'planning'); assert.equal(held.phase_ends_at, now + 4000);
  assert.equal(held.permanents_csv, 'effect_shield', 'a partial frame keeps the rest of the snapshot');
  // waitingOnBusyMember's test on the merged record: J is at our action, planning, deadline not passed → wait for it
  const busy = held.action === 11 && held.phase === 'planning' && held.phase_ends_at + 400 > now;
  assert.ok(busy, 'the joiner still planning is waited on, not closed out (Swarm-0226 signature)');
  assert.equal(cohortDeadline([held], 11, { now }), now + 4000, 'enterPhase sees its deadline');
  // the older envelope (bus copy, arriving late) can't roll the clock back
  held = fold(held, full);
  assert.equal(held.action, 11, 'clock not rolled back by a late older statement');
  assert.equal(clockFrame(plan, keys).sig, sig, 'same clock → same sig (deduped)');
  console.log('ok  clock frame: planning deadline reaches waitingOnBusyMember / cohortDeadline without Gun (Swarm-0226 oracle)');
}

// --- (f) Swarm-0559 T4.R1: dead ally-1 (no reveal) holds a shield token on (2,3); foe-2 is swapped onto (2,3) and
// takes Frost Lance during action 12. ally-1 resolves first, spends the token, publishes at 20.101 (resolved_action 12).
// P-Agent2 resolved before that frame arrived, P-Agent3 after: both must read the token-bearing statement.
{
  const shield = { id: 'r:ally-1#8#1', kind: 'shield', elem: 'elem_earth', value: 6, q: 2, r: 3 };
  const bonus = { id: 'r:ally-1#8#0', kind: 'bonus', elem: 'elem_earth', value: 2, q: 2, r: 3 };
  const base = { peer_id: 'peer:ally-1', life: 0, tile_q: 2, tile_r: 3, turn: 4, round: 0, action: 12 };
  const afterT3R2 = { ...base, phase: 'resolution', resolved_action: 11, tile_tokens_json: JSON.stringify([bonus, shield]), last_seen: iso(T + 13_585) };   // turn_commit T4.R0
  const afterT4R0 = { ...base, phase: 'resolution', resolved_action: 12, tile_tokens_json: JSON.stringify([bonus]), last_seen: iso(T + 20_101) };          // state_hash T4.R0
  const absorbs = (view) => JSON.parse(view.get('peer:ally-1')?.tile_tokens_json || '[]').some(t => t.kind === 'shield' && t.q === 2 && t.r === 3);
  // what mergePeerState does on each peer: fold + notePrior into peersPublic
  const mergeInto = (held, prior, p) => { const prev = held.get(p.peer_id) || {}; const take = orderedMerge(prev, p); if (!take) return; const m = { ...prev, ...take }; notePrior(prior, prev, m); held.set(p.peer_id, m); };
  const resolveAt = (frames) => { const held = new Map(), prior = new Map(); for (const f of frames) mergeInto(held, prior, f); return absorbs(resolverBase(held, prior, 12)); };
  assert.equal(resolveAt([afterT3R2]), true, 'fast peer (P-Agent2, 20.094): token there');
  assert.equal(resolveAt([afterT3R2, afterT4R0]), true, 'slow peer (P-Agent3, 20.129): still the pre-resolution statement → same outcome');
  // the old view (held snapshots as they are) split the two — the divergence this guards against
  { const held = new Map(), prior = new Map(); for (const f of [afterT3R2, afterT4R0]) mergeInto(held, prior, f); assert.equal(absorbs(held), false, 'raw peersPublic lost the token'); }
  // the next action (13) reads the post-resolution statement: the spent token is gone for everyone
  { const held = new Map(), prior = new Map(); for (const f of [afterT3R2, afterT4R0]) mergeInto(held, prior, f); assert.equal(absorbs(resolverBase(held, prior, 13)), false, 'action 13 sees the token spent'); }
  // a late, older bus copy (fill-only) does not disturb it; a slim clock frame keeps resolved_action from the full one
  assert.equal(resolveAt([afterT3R2, afterT4R0, afterT3R2]), true);
  assert.equal(resolveAt([afterT3R2, afterT4R0, { peer_id: 'peer:ally-1', action: 13, phase: 'planning', last_seen: iso(T + 26_000) }]), true);
  // an older build (no resolved_action) is read as before; a joiner that only ever heard the post-resolution frame too
  assert.equal(resolvedThrough({}), -1);
  assert.equal(resolveAt([{ ...afterT4R0, resolved_action: undefined }]), false, 'no stamp → held snapshot (old behaviour)');
  assert.equal(resolveAt([afterT4R0]), false, 'no earlier statement → held snapshot');
  console.log('ok  non-revealer read from its pre-resolution statement: dead ally-1 shield token, fast vs slow resolver (Swarm-0559 oracle)');
}

console.log('all merge-order checks passed');
