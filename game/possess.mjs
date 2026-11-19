// Possess / Phylactery (user ruling 2026-11-17) — pure helpers shared by peer.mjs (resolver + UI hint) and
// tools/effects-check.mjs. Data: data/effects.json effect_possess_phylactery 1.1.0 (data.possess, data.phylactery).
//
//   Possess: the cast's reveal carries the creature I picked from my ARCHIVE (a unit I killed — its creature card
//   lands in the killer's archive on death). The permanent stands in MY holding; while it stands I play that
//   creature (it enters next to me as my companion, driven by my action + target; my hero only holds EP).
//   It ends when the permanent falls (the creature leaves, its card back to my archive) or the creature dies
//   (the permanent falls with it; the card is gone — its killer gets a creature card).
//   Phylactery: Possess cast with no creature in my archive. One click (reveal `phylactery: {auto: true}`)
//   shatters one enemy permanent outright, no roll, then the Phylactery is spent. The target is judged by every
//   peer from the same view: the NEAREST enemy within `reach` that holds a destroyable permanent (class cards
//   never), and on it the permanent worth the most to remove.
export const POSSESS_ID = 'effect_possess_phylactery';
export const PHYLACTERY_DEFAULTS = { reach: 2 };
export const phylacteryConfig = (d) => ({ ...PHYLACTERY_DEFAULTS, ...(d || {}) });

// The archive creature Possess plays: the picked card if it is still there, else the strongest one
// (Σ stats high → low, then name, then card id). null = none → the cast becomes the Phylactery.
export function possessArchivePick(archive, cardId = null, isCreature = () => true) {
  const list = (archive || []).filter(c => c && c.kind === 'creature' && typeof c.creature_id === 'string' && isCreature(c.creature_id));
  if (!list.length) return null;
  const chosen = cardId ? list.find(c => c.card_id === cardId) : null;
  if (chosen) return chosen;
  return [...list].sort((a, b) => ((b.stat_sum || 0) - (a.stat_sum || 0)) || String(a.name || '').localeCompare(String(b.name || '')) || String(a.card_id).localeCompare(String(b.card_id)))[0];
}

// Rank of one enemy permanent (bigger = better to shatter): its Rule 24 power first (the free destroy is worth
// most on what a die could hardly beat), then one that holds a creature (Summoning, Golems, Possess …: a unit
// leaves the board), then one that hurts / hinders me (damage, locks, penalties, channels, traps, monster
// natural permanents), then the id (alphabetical, for a total order).
const rankOf = (p) => [p.power, p.creature ? 1 : 0, p.hostile ? 1 : 0];
const cmpRank = (a, b) => { const ra = rankOf(a), rb = rankOf(b); for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i]; return a.perm.localeCompare(b.perm); };

// ctx: { me, ids, alive(id), enemy(a, b), dist(a, b), perms(id) → [perm ids], power(id, perm) → n,
//        holdsCreature(perm) → bool, hostile(perm) → bool }
// → { peer_id, perm, power, dist, why } | null (no enemy in reach, or none of them holds a permanent).
export function phylacteryPick(ctx, reach = PHYLACTERY_DEFAULTS.reach) {
  const cands = [];
  for (const id of [...(ctx.ids || [])].sort()) {
    if (id === ctx.me || !ctx.alive(id) || !ctx.enemy(ctx.me, id)) continue;
    const d = ctx.dist(ctx.me, id);
    if (!(d <= reach)) continue;
    const perms = [...new Set(ctx.perms(id) || [])].filter(p => typeof p === 'string' && p && !p.startsWith('class_'))
      .map(perm => ({ perm, power: Number(ctx.power(id, perm)) || 1, creature: !!ctx.holdsCreature(perm), hostile: !!ctx.hostile(perm) }))
      .sort(cmpRank);
    if (perms.length) cands.push({ id, d, best: perms[0] });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (a.d - b.d) || cmpRank(a.best, b.best) || a.id.localeCompare(b.id));
  const c = cands[0], b = c.best;
  return { peer_id: c.id, perm: b.perm, power: b.power, dist: c.d, why: `nearest enemy with a permanent (${c.d} away); its ${b.perm}: power ${b.power}${b.creature ? ', holds a creature' : ''}${b.hostile ? ', hostile' : ''}` };
}

// Swarm-1536 T16.R2 (2026-11-18): a possessed creature whose Possess permanent fell is GONE for the resolver from
// the next action on, judged from its possessor's snapshot (the one every peer resolves with: its reveal state) —
// not from the creature's own last words. Its process vanishes on release and its life-0 snapshot reaches some
// peers and not others; where it did not, the stale living copy kept its hex (2,6) occupied and vetoed its
// possessor's move there → 3 of 12 peers held (2,5). Gone = possessed_by X, owner X, X in the view, and X no
// longer lists it in summoned_csv (dropped at once when the permanent falls — onSummonEnd / a new Possess).
// 2026-11-18 (user-approved follow-up): the same for EVERY companion — a unit that leaves the map when released
// (Summoning, Golems, Elementals, phantom, Necromancer's raised companions, Possess). Its snapshot says so:
// `companion_of: <owner>` (peer.mjs, set only in a companion process). A BOUND creature (∀ Summoning / Resurrect /
// revive) has owner_peer_id but no companion_of — it stays on the map when released and is never judged here.
// Older snapshots without companion_of: the Possess form (possessed_by X + owner X) still counts.
// view: Map id → snapshot. → sorted ids to leave out (selfId never: a vanishing creature knows it is dead;
// owner not in the view: no judgement).
export const companionOwner = (p) => (typeof p?.companion_of === 'string' && p.companion_of) ? p.companion_of
  : (p?.possessed_by && p.owner_peer_id === p.possessed_by ? p.possessed_by : null);
export function releasedCompanions(view, selfId = null) {
  const out = [];
  for (const [id, p] of view) {
    const by = companionOwner(p);
    if (!by || id === selfId || by === id) continue;
    const o = view.get(by);
    if (!o) continue;
    if (!String(o.summoned_csv || '').split(',').includes(id)) out.push(id);
  }
  return out.sort();
}
export const releasedPossessed = releasedCompanions;   // the Swarm-1536 name
