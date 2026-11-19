// Ordering rules for other peers' public snapshots and for the join / phase clock (Swarm-0407).
//
// (1) orderedMerge — ONE freshness rule for every input of mergePeerState (envelope `state`, libp2p
//     `kind:'state'` frames, the Nostr bus `state` heartbeat, Gun echoes, the discovery mirror). A
//     snapshot is the owner's own statement at `last_seen` (its own clock, so monotonic per peer). An
//     OLDER statement than the one we hold may only fill fields we lack — it never rolls life / tile /
//     clock / permanents back. Before this, the Nostr relay replay (30 s, nostr-bus MAX_AGE_SEC) handed a
//     joiner foe-1's pre-death envelopes after its death snapshot: foe-1 came back to life in the
//     joiner's view and its natural earthquake ticked there only (Swarm-0407 T2.R3). Dead stays dead
//     unless a NEWER snapshot (a resurrection) says otherwise — that falls out of the same rule.
//     gunMergeable (gun-member.mjs) is the same rule for the Gun path; both compose (a fill keeps the
//     held last_seen, which is "not older", so it is taken as the fill it is).
//
// (2) pickClockRef — which live peer a joiner takes its clock from. Most advanced action among FRESH
//     peers (a replayed or long-silent snapshot is not evidence of the live clock), then the phase most
//     of that cohort is in (a tie goes to the later phase: joining a handshake already under way means
//     abstaining from it), then the MEDIAN deadline of those peers — not the latest: the latest belongs
//     to whichever peer is itself lagging (a fresh joiner), and copying it is how a joiner inherited a
//     shifted clock and propagated it (Swarm-0407 T4.R2, M-Foe3 ← P-Agent5).
//
// (3) cohortDeadline — the planning deadline the peers already planning OUR action hold (the latest of
//     them), so a peer whose own cadence ended up later than the whole cohort pulls its deadline in
//     instead of committing after the others have closed the action (every reveal "late" elsewhere).
//
// Pure; unit test: tools/merge-order-check.mjs.

export const snapTime = (s) => Date.parse(s?.last_seen || 0) || 0;
export function snapAction(s, roundsPerTurn = 3) {
  if (!s) return -1;
  if (typeof s.action === 'number' && Number.isFinite(s.action)) return s.action;
  if (typeof s.turn === 'number' && Number.isFinite(s.turn)) return s.turn * roundsPerTurn + (Number(s.round) || 0);
  return -1;
}
const PHASE_ORDER = { planning: 0, reveal: 1, resolution: 2, cleanup: 3 };

// What to hand to the merge for `incoming`, given what we hold (`prev`, may be undefined / {}).
// Returns the object to spread over prev, or null when there is nothing to take.
export function orderedMerge(prev, incoming) {
  if (!incoming || typeof incoming !== 'object') return null;
  if (!prev || !Object.keys(prev).length) return incoming;
  if (snapTime(incoming) >= snapTime(prev)) return incoming;   // newer, or the same statement re-delivered
  const fill = {};
  for (const [k, v] of Object.entries(incoming)) if (prev[k] === undefined && v !== undefined) fill[k] = v;
  return Object.keys(fill).length ? { ...fill, peer_id: incoming.peer_id, last_seen: prev.last_seen } : null;
}

// others: snapshots of OTHER peers (self excluded by the caller). Returns null when none has a clock,
// else { ref, action, phase, phase_ends_at, cohort } — `ref` is the peer whose deadline was taken.
export function pickClockRef(others, { now = Date.now(), freshMs = 20_000, roundsPerTurn = 3 } = {}) {
  const withClock = (others || []).filter(p => p && snapAction(p, roundsPerTurn) >= 0);
  if (!withClock.length) return null;
  const fresh = withClock.filter(p => snapTime(p) > now - freshMs);
  const pool = fresh.length ? fresh : withClock;
  const action = Math.max(...pool.map(p => snapAction(p, roundsPerTurn)));
  const cohort = pool.filter(p => snapAction(p, roundsPerTurn) === action);
  const count = new Map();
  for (const p of cohort) { const ph = p.phase in PHASE_ORDER ? p.phase : 'planning'; count.set(ph, (count.get(ph) || 0) + 1); }
  const phase = [...count.entries()].sort((a, b) => (b[1] - a[1]) || (PHASE_ORDER[b[0]] - PHASE_ORDER[a[0]]))[0][0];
  const inPhase = cohort.filter(p => (p.phase in PHASE_ORDER ? p.phase : 'planning') === phase);
  const timed = inPhase.filter(p => typeof p.phase_ends_at === 'number').sort((a, b) => (a.phase_ends_at - b.phase_ends_at) || String(a.peer_id).localeCompare(String(b.peer_id)));
  const ref = timed.length ? timed[(timed.length - 1) >> 1] : inPhase.sort((a, b) => String(a.peer_id).localeCompare(String(b.peer_id)))[0];
  return { ref, action, phase, phase_ends_at: typeof ref.phase_ends_at === 'number' ? ref.phase_ends_at : null, cohort: cohort.length };
}

// Turn-scoped no-damage zones (Blizzard, Light/Darkness) live in every resolver's local `activeZones`,
// not in anyone's entity — a peer joining (or abstaining) mid-turn missed the action that laid them and
// resolved the rest of the turn without them (Swarm-0544 T4.R3: Blizzard zone laid at T4.R2, C-Agent6
// joined at T4.R3 planning, the T4-end Earthquake tick hit P-Agent4 in the zone on C-Agent6 only).
// Union of `zones_json` of fresh peers already at `action` that still stand this `turn`, sorted, deduped.
export function meshZones(others, action, turn, { now = Date.now(), freshMs = 20_000, roundsPerTurn = 3 } = {}) {
  const byHex = new Map();
  for (const p of others || []) {
    if (!p || snapAction(p, roundsPerTurn) !== action || snapTime(p) <= now - freshMs) continue;
    let zs; try { zs = JSON.parse(p.zones_json || '[]'); } catch { continue; }
    if (!Array.isArray(zs)) continue;
    for (const z of zs) {
      if (!z || !Number.isInteger(z.q) || !Number.isInteger(z.r) || !(Number(z.until_turn) >= turn)) continue;
      const k = `${z.q},${z.r}`, u = Number(z.until_turn);
      if (!byHex.has(k) || byHex.get(k).until_turn < u) byHex.set(k, { q: z.q, r: z.r, until_turn: u });
    }
  }
  return [...byHex.values()].sort((a, b) => a.q - b.q || a.r - b.r);
}

// The latest planning deadline among fresh peers planning `action` (self excluded by the caller), or null.
export function cohortDeadline(others, action, { now = Date.now(), freshMs = 20_000, roundsPerTurn = 3 } = {}) {
  let latest = null;
  for (const p of others || []) {
    if (!p || snapAction(p, roundsPerTurn) !== action || p.phase !== 'planning' || typeof p.phase_ends_at !== 'number') continue;
    if (snapTime(p) <= now - freshMs) continue;
    if (latest === null || p.phase_ends_at > latest) latest = p.phase_ends_at;
  }
  return latest;
}

// (4) M6 step 1 (drop Gun) — the resolver's view and the wire clock frame.
//
// resolverPeers — which held snapshots the resolver may read: self and peers heard on a WIRE transport
//     (envelope, libp2p state / clock frame, Nostr bus, discovery). A member known only through a side
//     channel (Gun) is in some resolvers' views and not in others', and every read of the view (move
//     occupancy, collision, targets, Creation bars, zones…) then splits them (GunLive85 run 3, T8.R3:
//     gX on (15,-16) vetoed gA's move on gA / gD only). Revealers are re-added from their envelopes.
export function resolverPeers(held, selfId, wireHeard) {
  return new Map([...held].filter(([id]) => id === selfId || wireHeard.has(id)));
}

// (5) resolverBase — a peer that does not reveal the action being resolved (a corpse, an abstaining joiner) is
//     read from its held snapshot, and its owner may already have published what THIS action did to it (Swarm-0559
//     T4.R1: dead ally-1 spent its shield token on (2,3) and published at once; the 3 peers that resolved before
//     that frame arrived absorbed Frost Lance with the token, the 7 after it did not → foe-2 hp4 vs hp3).
//     Every snapshot says which action its owner last resolved (`resolved_action`, -1 / absent = none or an older
//     build). notePrior keeps, per peer, the held snapshot from before the last merge that moved resolved_action
//     forward; resolverBase hands the resolver of `action` that earlier statement instead of one that already
//     reflects `action` (resolved_action >= action). No clean earlier statement: the held one (old behaviour).
export const resolvedThrough = (s) => Number.isInteger(s?.resolved_action) ? s.resolved_action : -1;
export function notePrior(prior, prev, merged) {
  if (merged?.peer_id && prev && Object.keys(prev).length && resolvedThrough(merged) > resolvedThrough(prev)) prior.set(merged.peer_id, prev);
}
export function resolverBase(held, prior, action) {
  return new Map([...held].map(([id, s]) => {
    if (resolvedThrough(s) < action) return [id, s];
    const p = prior.get(id);
    return [id, p && resolvedThrough(p) < action ? p : s];
  }));
}

// clockFrame — what a clock change puts on the wire at once (the Swarm-0226 duty Gun's GUN_URGENT put
// had): the slim core record (`keys`), and the dedupe signature action|phase|deadline. Partial by design:
// mergePeerState spreads it over the held snapshot under the same orderedMerge rule as everything else.
export function clockFrame(snap, keys) {
  const rec = {};
  for (const k of keys) if (snap?.[k] !== undefined && snap[k] !== null) rec[k] = snap[k];
  return { sig: `${snap?.action}|${snap?.phase}|${snap?.phase_ends_at}`, rec };
}

// (4) Start clock (user 2026-11-17): "I should start at the last known game state, round and turn." A joiner
//     never starts at T0.R0 of a dimension that has run before. `live` = other peers' snapshots heard at join
//     sync; `known` = lastKnownClock(...) of the newest Door clocks and the local TMJ save (launcher env
//     START_ACTION / RESTORE_FROM_TMJ meta). Rule:
//       · a FRESH live node that is not a wild monster (a hero, an ally bot, an unattended hero, a summon)
//         → the live clock (pickClockRef over everyone heard: max fresh action, majority phase, median
//         deadline — unchanged), whatever the Doors say;
//       · otherwise (nobody, or only monsters / stale snapshots) → the higher of the live monsters' action and
//         the last known action, entered in planning; `null` known and nobody live → fresh (action 0).
//     Returns { source: 'live' | 'known' | 'fresh', action, turn, round, phase, phase_ends_at, ref, cohort, from }.
export const isWildMonster = (p) => !!p && !!p.creature_id && !p.owner_peer_id;
export function clockCandidate(c, roundsPerTurn = 3) {
  if (!c) return -1;
  const a = Number(c.action);
  if (c.action !== undefined && c.action !== null && c.action !== '' && Number.isInteger(a) && a >= 0) return a;
  const t = Number(c.turn), r = Number(c.round) || 0;
  return c.turn !== undefined && c.turn !== null && c.turn !== '' && Number.isInteger(t) && t >= 0 ? t * roundsPerTurn + Math.max(0, Math.min(roundsPerTurn - 1, r)) : -1;
}
// cands: [{ action | turn+round, at (ms or ISO), source }]. The newest state is the most advanced action — a
// dimension's clock only runs forward, so a time-based pick would let a Door pushed later by a peer whose
// clock was reset (a pre-fix quiet join at T0) undo the real one; ties → the later `at`. null when none.
export function lastKnownClock(cands, { roundsPerTurn = 3 } = {}) {
  let best = null;
  for (const c of cands || []) {
    const action = clockCandidate(c, roundsPerTurn);
    if (action < 0) continue;
    const at = typeof c.at === 'number' ? c.at : (Date.parse(c.at || 0) || 0);
    if (!best || action > best.action || (action === best.action && at > best.at)) best = { action, at, source: String(c.source || '?') };
  }
  return best && { ...best, turn: Math.floor(best.action / roundsPerTurn), round: best.action % roundsPerTurn };
}
// The clock candidates of a dimension's Doors (join-plan / launcher records: { peer_id, clock, pushed_at }).
export const doorClockCands = (doors) => (doors || []).filter(d => d?.clock).map(d => ({ ...d.clock, at: typeof d.clock.at === 'number' ? d.clock.at : d.pushed_at, source: `door ${d.peer_id || '?'}` }));
// A local TMJ save (autosave.mjs listSavedDimensions item, or loadTmj().meta).
export const saveClockCand = (s, path = '') => s ? { turn: s.turn, round: s.round, at: s.saved_at || s.mtime, source: `save ${path || s.path || s.dim_id || ''}`.trim() } : null;
export function pickStartClock(live, known, { now = Date.now(), freshMs = 20_000, roundsPerTurn = 3 } = {}) {
  const others = (live || []).filter(p => p && snapAction(p, roundsPerTurn) >= 0);
  const keepers = others.filter(p => !isWildMonster(p) && snapTime(p) > now - freshMs);
  const at = (action, extra) => ({ action, turn: Math.floor(action / roundsPerTurn), round: action % roundsPerTurn, ...extra });
  if (keepers.length) {   // the live mesh: the same reference as ever, over everyone heard (monsters included)
    const pick = pickClockRef(others, { now, freshMs, roundsPerTurn });
    return at(pick.action, { source: 'live', phase: pick.phase, phase_ends_at: pick.phase_ends_at, ref: pick.ref, cohort: pick.cohort, from: pick.ref.peer_id });
  }
  const mon = others.length ? pickClockRef(others, { now, freshMs, roundsPerTurn }) : null;
  const k = known && Number.isInteger(known.action) && known.action >= 0 ? known.action : -1;
  if (mon && mon.action >= k) return at(mon.action, { source: 'live', phase: mon.phase, phase_ends_at: mon.phase_ends_at, ref: mon.ref, cohort: mon.cohort, from: mon.ref.peer_id });
  if (k >= 0) return at(k, { source: 'known', phase: 'planning', phase_ends_at: null, ref: null, cohort: 0, from: known.source });
  return at(0, { source: 'fresh', phase: 'planning', phase_ends_at: null, ref: null, cohort: 0, from: null });
}
