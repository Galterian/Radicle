// Generic contact / chase / swap primitives of the class engine (class isolation phase 6, 2026-11-20): wild monsters,
// lure targets, the chase-bonus step, the first-contact pick, the committed fallback action and the reveal swap.
// Class-oblivious: peer.mjs applies them for any class with the matching hook (chase_step, contact, combat_in —
// classes-data/HOOKS.md "No class ids in peer.mjs"). Pure; no I/O, no peer state. Moved verbatim from
// class-chase.mjs / class-manipulator.mjs; the class configs are test oracles now (classes-data/oracle/class-configs.mjs).
// A wild monster as seen in a snapshot: a creature that sleeps or is awake (monster_state) and has no owner.
export function isWildMonster(s) {
  return !!s && (s.monster_state === 'sleeping' || s.monster_state === 'awake') && !s.owner_peer_id;
}
// Monsters the Avenger lures: `cands` = [{ id, wild, enemy, alive, d }] (d = hex distance to the Avenger);
// living wild enemy monsters within range, sorted by id (deterministic on every peer).
export function lureTargets(cands, range) {
  return cands.filter(c => c && c.wild && c.enemy && c.alive && Number.isInteger(c.d) && c.d <= range).map(c => c.id).sort();
}
// One step of the Avenger's chase bonus. `state` = { chasers: [ids], bonus: 0..max } (what I had),
// `chasingNow` = ids of the monsters chasing me this action. Returns the new state plus what changed:
//   fresh  — the monsters that started chasing me now (not in the previous chaser list)
//   grant  — life points to add to life max: only when someone fresh came and room is left
//   heal   — life points to add to life with it: = grant, or 0 with cfg.maxOnly (CP 2026-11-19, pick 9 a)
//   fade   — the bonus is dropped (nobody chases me any more)
export function chaseBonusStep(state, chasingNow, cfg = { per: 1, max: 1, maxOnly: false }) {
  const prev = new Set(state?.chasers || []);
  const now = [...new Set(chasingNow || [])].sort();
  const fresh = now.filter(id => !prev.has(id));
  let bonus = Math.max(0, Number(state?.bonus) || 0);
  let grant = 0, fade = false;
  if (!now.length && bonus > 0) { fade = true; bonus = 0; }
  else if (fresh.length && bonus < cfg.max) { grant = Math.min(cfg.per * fresh.length, cfg.max - bonus); bonus += grant; }
  return { chasers: now, bonus, fresh, grant, heal: cfg.maxOnly ? 0 : grant, fade };
}
// Prophet: whom to look at among the enemies in contact. `foes` = [{ id, fought }] (fought = we targeted each
// other this action); one I fought first, then the smallest id.
export function prophetPick(foes) {
  const s = [...(foes || [])].filter(Boolean).sort((a, b) => (Number(!!b.fought) - Number(!!a.fought)) || String(a.id).localeCompare(String(b.id)));
  return s[0]?.id || null;
}

// The fallback the target commits: one random Action card of the hand other than the played one (and other than
// cards already spent by bonus plans / Battle Trance). `rnd` is the target's own randomness (private choice).
export function pickAltAction(hand, excludeIds, rnd = Math.random) {
  const ex = new Set((excludeIds || []).filter(Boolean));
  const pool = (hand || []).filter(c => c && c.kind === 'action' && !ex.has(c.card_id));
  if (!pool.length) return { code: 'EP', card_id: null };
  const c = pool[Math.floor(rnd() * pool.length) % pool.length];
  return { code: c.code, card_id: c.card_id };
}
// "About to get combat damage": a positive matrix strike of the main action in the damage list.
export const combatHit = (list) => (list || []).some(d => d && d.source === 'action' && !d.bonus && d.amount > 0);
// CR (user class ruling 2026-11-17): "only an incoming Attack triggers" — class data trigger: "attack" → only a positive
// matrix strike of an enemy ATTACK (peer.mjs addDmg `why` 'Attack' = the strike's code A; a Block / Posture strike no).
export const attackHit = (list) => (list || []).some(d => d && d.source === 'action' && !d.bonus && d.amount > 0 && d.why === 'Attack');
// The random nearby enemy: candidates sorted by id, index from the Manipulator's reveal salt.
export function pickManipTarget(seed, candidateIds, sha256Hex) {
  const ids = [...candidateIds].sort();
  return ids.length ? ids[parseInt(sha256Hex(seed).slice(0, 8), 16) % ids.length] : null;
}
// Swap the target's reveal in place: its action (and any skill riding on it, Battle Trance included) goes back to
// its hand, the committed alt is played bare. A building's free skill keeps riding. A non-instant cast survives
// only if the new action still emits (`emits(code)`), a Rule 24 emission likewise. Returns { old, new }.
export function applyManipSwap(r, alt, emits = (c) => c === 'P' || c === 'EP') {
  const old = r.trance ? 'BT' : r.action;
  const code = ['A', 'B', 'M', 'P', 'EM', 'EP'].includes(alt?.code) ? alt.code : 'EP';
  r.action = code;
  r.target = alt?.target || null;
  r.trance = null;
  r.skills = r.buildingSkill ? [r.buildingSkill] : [];
  if (r.effect && !r.effect.is_instant && !emits(code)) r.effect = null;
  if (r.destroy && !emits(code)) r.destroy = null;
  r.manipulated = { old, new: code };
  return { old, new: code };
}
