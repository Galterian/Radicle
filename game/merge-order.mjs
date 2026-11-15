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
