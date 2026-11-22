// The JS reference of the built-in effects' `standing` programs — TEST ORACLE (effect isolation F9e, 2026-11-22).
// Moved verbatim from game/effect-standing.mjs (F2: the behaviour peer.mjs had keyed on the effect ids). The game loads it
// only under EFFECT_STANDING_ENGINE / EFFECT_ENGINE = js | shadow; tools/effect-standing-check.mjs holds the definitions'
// programs equal to it. Lives in chaosD6-Effects (effects-repo-sync copies effects-data/oracle/).
// ---- the JS reference (the behaviour peer.mjs had before F2, verbatim in effect) -------------------------------------
// = oracle effects-js.mjs#invisibilityBreaks (user ruling 2026-11-14) with the holder's own id: Attack / Block (a trance option
// counts), a class code that fights as one (extra codes), or casting any effect other than this one.
const playBreaks = (rv, extra, self) => {
  if (!rv) return false;
  const codes = Array.isArray(rv.trance) && rv.trance.length ? rv.trance : [rv.action];
  if (codes.some(c => c === 'A' || c === 'B')) return true;
  if (extra.length && codes.some(c => extra.includes(c))) return true;
  const eff = rv.effect_id ?? rv.effect?.effect_id ?? null;
  return !!eff && eff !== self;
};
export const STANDING_JS = Object.freeze({
  effect_inner_fire: { combat_out: (a) => (a.dmg === 1 ? 2 : a.dmg) },                                   // a 1-damage strike deals 2
  effect_super_sense: { damage_in: (a) => (a.amount > 0 ? { amount: a.amount - 1, spend: true } : { amount: a.amount, spend: false }) },   // evade one point, spent
  effect_disable: { cast_in: (a) => ({ bar: a.every ? 'all' : 'caster', elem: a.last_elem, spend: true }) },   // stop the cast, bar its last element (∀: to all)
  effect_delay_time: { adjacent_lost: () => 1 },                                                          // each adjacent enemy holder: my last action
  effect_empower: { plan_emit: (a) => (a.step < a.of ? { extra: 1, spend: true } : { extra: 0, spend: false }) },   // two elements in one action, spent
  effect_sleep: { afflicted: (a) => ({ no_cast: !!a.in_contact, only: null }) },                          // no casting in contact with the holder
  effect_confusion: { afflicted: () => ({ no_cast: false, only: 'EP' }) },                               // Empty Posture only
  effect_blessing_curse: { harm_in: (a) => (a.every ? { negate: true, spend: 'every' } : null) },       // ∀: the second Blessing negates it
  effect_invisibility: { breaks: (a) => (a.every ? !!a.dealt_damage : (a.plays || []).some(p => playBreaks(p, a.extra_codes || [], a.self))) },   // A / B / another cast; ∀: dealt damage
});
