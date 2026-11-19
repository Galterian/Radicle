// Bound-creature release (2026-11-19) — pure helpers for peer.mjs (resolver + the bound creature itself) and
// tools/bound-release-check.mjs. Sibling of possess.mjs releasedCompanions, for the units that STAY on the map.
//
//   A BOUND creature is a peer of its own that someone else's permanent holds: ∀ Summoning bound it ('bind': it fights
//   for the binder's side) or Resurrect / the Necromancer raised its corpse ('revive': back at full life, on the raiser's
//   side). It is released when its owner no longer holds it: the owner is dead, the permanent is gone, or the owner
//   dropped it from summoned_csv (ruling 2026-11-19: a same-type recast ends what the previous cast held while the
//   permanent stays). Released: 'revive' → it falls again (life 0); 'bind' → back to its own alliance.
//
//   Up to 2026-11-19 the creature's own 1.5 s timer judged this from live gossip and republished; other peers learnt it
//   from a LATER snapshot, at different actions (the stale-snapshot race of Swarm-1536's Possess divergence). Now every
//   resolver judges it from the frozen view at the same action: the creature's snapshot marker
//     bound_to (owner peer id), bound_perm, bound_mode ('bind' | 'revive'), bound_at (the action whose resolution bound
//     it), bound_alliance (its alliance before it was bound)
//   against the owner's snapshot in the same view (life, permanents_csv, summoned_csv, resolved_action).
//
//   "Not yet listed" guard, from frozen data: the owner adds the creature to its summons (summon_paid summon_add /
//   Necromancer revive) in the SAME resolution step in which the creature binds itself, unconditionally. So an owner
//   snapshot with resolved_action ≥ bound_at has listed it; absence there is a drop. An owner snapshot older than that
//   (resolved_action < bound_at, or none) predates the bind — no judgement, neither on summoned_csv nor on the permanent.
//   No peer-local history (the old boundSeenListed flag) enters the decision.
export const csvHas = (csv, x) => String(csv || '').split(',').includes(x);

// The bound marker of a snapshot, or null (not bound / malformed).
export function boundOf(p) {
  if (!p || typeof p.bound_to !== 'string' || !p.bound_to || typeof p.bound_perm !== 'string' || !p.bound_perm) return null;
  if (p.bound_mode !== 'bind' && p.bound_mode !== 'revive') return null;
  return { owner: p.bound_to, perm: p.bound_perm, mode: p.bound_mode, at: Number.isInteger(p.bound_at) ? p.bound_at : null, alliance: typeof p.bound_alliance === 'string' && p.bound_alliance ? p.bound_alliance : null };
}

// One creature: id, its snapshot p, its owner's snapshot o (same view). → null (holds / no judgement) | release record.
export function boundReleaseOf(id, p, o) {
  const b = boundOf(p);
  if (!b || b.owner === id || !o) return null;
  if (b.at === null || !Number.isInteger(o.resolved_action) || o.resolved_action < b.at) return null;   // owner's state predates the bind
  const why = (o.life ?? 1) <= 0 ? 'its owner fell'
    : !csvHas(o.permanents_csv, b.perm) ? 'the permanent is gone'
    : !csvHas(o.summoned_csv, id) ? 'its owner no longer lists it (same-type recast)'
    : null;
  return why ? { id, owner: b.owner, perm: b.perm, mode: b.mode, at: b.at, alliance: b.alliance, why } : null;
}

// view: Map id → snapshot. → release records sorted by id (owner not in the view: no judgement).
export function boundReleases(view) {
  const out = [];
  for (const [id, p] of view) { const r = boundReleaseOf(id, p, view.get(p?.bound_to)); if (r) out.push(r); }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// The snapshot a resolver uses for a released creature — exactly what the creature publishes once it applied the
// release itself (peer.mjs applyBoundRelease): revive → life 0; bind → its own alliance back; no owner, no marker.
export function releasedBoundView(p, rel) {
  const { bound_to, bound_perm, bound_mode, bound_at, bound_alliance, ...rest } = p || {};
  const out = { ...rest, owner_peer_id: '' };
  if (rel.mode === 'revive') out.life = 0;
  else if (rel.alliance) out.alliance = rel.alliance;
  return out;
}
