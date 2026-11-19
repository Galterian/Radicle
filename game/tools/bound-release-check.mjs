// Oracles for game/bound-release.mjs (bound-creature release judged on the frozen view, 2026-11-19).
// usage: node tools/bound-release-check.mjs → "all checks passed"
import { boundOf, boundReleaseOf, boundReleases, releasedBoundView } from '../bound-release.mjs';

let fails = 0, n = 0;
const eq = (name, got, want) => { n++; const a = JSON.stringify(got), b = JSON.stringify(want); if (a !== b) { fails++; console.log(`FAIL ${name}: got ${a} want ${b}`); } };

// Owner O bound W (∀ Summoning) and raised R (Resurrect) at action 10.
const W = { peer_id: 'peer:W', life: 5, alliance: 'npc_a', owner_peer_id: 'peer:O', bound_to: 'peer:O', bound_perm: 'effect_summoning', bound_mode: 'bind', bound_at: 10, bound_alliance: 'npc_b', tile_q: 1, tile_r: 1 };
const R = { peer_id: 'peer:R', life: 4, alliance: 'npc_a', owner_peer_id: 'peer:O', bound_to: 'peer:O', bound_perm: 'effect_resurrect_death_ward', bound_mode: 'revive', bound_at: 10, bound_alliance: 'npc_b', tile_q: 2, tile_r: 1 };
const O = (x = {}) => ({ peer_id: 'peer:O', life: 6, resolved_action: 10, permanents_csv: 'effect_resurrect_death_ward,effect_summoning', summoned_csv: 'peer:R,peer:W', ...x });
const view = (o, ...rest) => new Map([['peer:O', o], ...rest.map(p => [p.peer_id, p])]);
const ids = (v) => boundReleases(v).map(r => `${r.id}:${r.mode}`);

// Marker parsing.
eq('boundOf W', boundOf(W), { owner: 'peer:O', perm: 'effect_summoning', mode: 'bind', at: 10, alliance: 'npc_b' });
eq('boundOf unbound', boundOf({ peer_id: 'x', owner_peer_id: 'peer:O' }), null);
eq('boundOf released (bound_to empty)', boundOf({ ...W, bound_to: '' }), null);
eq('boundOf bad mode', boundOf({ ...W, bound_mode: 'spawn' }), null);

// Not released: the owner holds the permanent, lists the creature, is alive.
eq('holds', ids(view(O(), W, R)), []);
// Released: the permanent is gone (Rule 24 / expiry) — only the creature it held.
eq('perm gone → bind', ids(view(O({ permanents_csv: 'effect_resurrect_death_ward' }), W, R)), ['peer:W:bind']);
eq('perm gone → revive', ids(view(O({ permanents_csv: 'effect_summoning' }), W, R)), ['peer:R:revive']);
// Owner dead: both go.
eq('owner dead', ids(view(O({ life: 0 }), W, R)), ['peer:R:revive', 'peer:W:bind']);
// Owner listed then dropped (same-type recast, 2026-11-19): the permanent stays, the creature is not listed any more.
eq('listed then dropped', ids(view(O({ resolved_action: 14, summoned_csv: 'peer:W,peer:R2' }), W, R)), ['peer:R:revive']);
eq('why dropped', boundReleaseOf('peer:R', R, O({ resolved_action: 14, summoned_csv: 'peer:W' }))?.why, 'its owner no longer lists it (same-type recast)');
// Not yet listed: the owner's snapshot in the view predates the bind (resolved_action < bound_at) — not listed, not even
// holding the permanent: no judgement. A peer whose view holds the owner's newer statement and one holding the older
// one decide from the same frozen data, never from what each saw listed before.
eq('not yet listed (owner snapshot older)', ids(view(O({ resolved_action: 9, summoned_csv: '', permanents_csv: '' }), W, R)), []);
eq('owner snapshot without resolved_action', ids(view(O({ resolved_action: undefined, summoned_csv: '' }), W, R)), []);
eq('marker without bound_at', ids(view(O({ summoned_csv: '' }), { ...W, bound_at: undefined })), []);
// Owner not in the view: no judgement. A creature "bound to itself": none.
eq('owner absent', ids(new Map([['peer:W', W]])), []);
eq('self-owned', boundReleaseOf('peer:O', { ...W, peer_id: 'peer:O' }, O({ life: 0 })), null);
// Owner dead with a snapshot older than the bind: still no judgement (the bind came after that statement).
eq('owner dead but older', ids(view(O({ life: 0, resolved_action: 8 }), W)), []);
// Companions (companion_of) are possess.mjs's: never judged here.
eq('companion untouched', ids(view(O({ summoned_csv: '' }), { peer_id: 'peer:O-sum1', companion_of: 'peer:O', owner_peer_id: 'peer:O', life: 4 })), []);
// Sorted output.
eq('sorted', boundReleases(view(O({ life: 0 }), W, R)).map(r => r.id), ['peer:R', 'peer:W']);

// The view a resolver uses = what the creature publishes after applying the release itself.
const relW = boundReleaseOf('peer:W', W, O({ summoned_csv: 'peer:R' }));
const relR = boundReleaseOf('peer:R', R, O({ summoned_csv: 'peer:W' }));
eq('released bind view', releasedBoundView(W, relW), { peer_id: 'peer:W', life: 5, alliance: 'npc_b', owner_peer_id: '', tile_q: 1, tile_r: 1 });
eq('released revive view', releasedBoundView(R, relR), { peer_id: 'peer:R', life: 0, alliance: 'npc_a', owner_peer_id: '', tile_q: 2, tile_r: 1 });
eq('released view idempotent', boundReleases(new Map([['peer:O', O({ summoned_csv: '' })], ['peer:W', releasedBoundView(W, relW)]])), []);
eq('input untouched', W.bound_to, 'peer:O');

if (fails) { console.log(`${fails} of ${n} checks FAILED`); process.exit(1); }
console.log(`all checks passed (${n})`);
