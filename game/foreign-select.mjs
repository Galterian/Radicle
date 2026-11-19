// Partial foreign-card runs (tests only; env plumbing, no rule reads this).
//
// FORCE_FOREIGN_EFFECT / FORCE_FOREIGN_SKILL / FORCE_FOREIGN_CLASS preload a player-branch def into a peer's
// cache + deck. Without the knobs below EVERY peer gets it (old behaviour), so nobody ever "learns" it.
//
//   FOREIGN_HOLDERS=<n | label,label…>    only these peers apply the FORCE_FOREIGN_* defs; everyone else starts
//                                         without them and must learn them over the handshake.
//                                         n = the first n labels of FOREIGN_ORDER.
//   FOREIGN_REFUSERS=<n | label,label…>   these peers refuse every foreign effect / skill / class (as FX_ACCEPT=0
//                                         + SK_ACCEPT=0 + CL_ACCEPT=0). n = the last n labels of FOREIGN_ORDER
//                                         that are not holders.
//   FOREIGN_ORDER=<label,…>               label order for the numeric forms (default: the swarm heroes below).
//
// Labels are exact PEER_LABELs; companions (`<label>-sumN`) and monsters are never holders/refusers unless listed.

const list = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
// The swarm heroes (tools/swarm-test.mjs joins), C-Agent6 / D-Agent7 only when TEAM_C / TEAM_D is on.
const DEFAULT_ORDER = () => ['player-1', 'P-Agent2', 'P-Agent3', 'P-Agent4', 'P-Agent5',
  ...(process.env.TEAM_C === '1' ? ['C-Agent6'] : []), ...(process.env.TEAM_D === '1' ? ['D-Agent7'] : [])];
const order = () => (list(process.env.FOREIGN_ORDER).length ? list(process.env.FOREIGN_ORDER) : DEFAULT_ORDER());

/** Holder labels, or null when FOREIGN_HOLDERS is unset (= every peer holds). */
export function foreignHolders() {
  const v = String(process.env.FOREIGN_HOLDERS ?? '').trim();
  if (!v) return null;
  return /^\d+$/.test(v) ? order().slice(0, Number(v)) : list(v);
}
/** Refuser labels ([] when unset). */
export function foreignRefusers() {
  const v = String(process.env.FOREIGN_REFUSERS ?? '').trim();
  if (!v) return [];
  if (!/^\d+$/.test(v)) return list(v);
  const n = Number(v), h = new Set(foreignHolders() || []);
  return n > 0 ? order().filter(l => !h.has(l)).slice(-n) : [];
}
export const foreignHolder = (label) => { const h = foreignHolders(); return h === null || h.includes(label); };
export const foreignRefuser = (label) => foreignRefusers().includes(label);
/** 'holder' | 'refuser' | 'learner' | 'all' (no FOREIGN_HOLDERS: every peer holds). */
export function foreignRole(label) {
  if (foreignRefuser(label)) return 'refuser';
  const h = foreignHolders();
  return h === null ? 'all' : h.includes(label) ? 'holder' : 'learner';
}
export const foreignSelectActive = () => !!(String(process.env.FOREIGN_HOLDERS ?? '').trim() || String(process.env.FOREIGN_REFUSERS ?? '').trim());
