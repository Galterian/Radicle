// Oracles for the 2026-11-14 user rulings on Avenger (lure + chase bonus) and Prophet (first contact).
//   node tools/chase-check.mjs   → must end "all chase checks passed"
import fs from 'node:fs';
import { AVENGER_DEFAULTS, PROPHET_DEFAULTS, avengerConfig, prophetConfig, isWildMonster, lureTargets, chaseBonusStep, prophetPick } from '../class-chase.mjs';

let fails = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const active = (file, id) => {
  const e = JSON.parse(fs.readFileSync(new URL(`../../data/${file}`, import.meta.url), 'utf8')).entries.find(x => x.id === id);
  const live = e.versions.filter(v => v.status !== 'rejected' && v.status !== 'superseded').sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  return (live[0] || e.versions[0]);
};

// ---- data ↔ defaults ----
const av = active('classes.json', 'class_avenger'), pr = active('classes.json', 'class_prophet');
// CR 2026-11-17 (data cr_2026_11_19): Avenger 1.2.0 (tap lure), Prophet 1.2.0 (contact 3); CP 2026-11-19 (pick 9 a): the Avenger's bonus is max-only.
eq('avenger 1.2.0 canonical', [av.version, av.status], ['1.2.0', 'canonical']);
eq('prophet 1.2.0 canonical', [pr.version, pr.status], ['1.2.0', 'canonical']);
eq('avenger data = defaults but max_only', avengerConfig(av.data), { ...avengerConfig(AVENGER_DEFAULTS), maxOnly: true });
eq('avenger config 10 / +1 / max 1, life max only', avengerConfig(av.data), { range: 10, per: 1, max: 1, maxOnly: true });
eq('avenger has no hand_reveal any more', av.data.hand_reveal ?? null, null);
eq('prophet contact 3 (CR 2026-11-17: within 3 hexes; default 1)', [prophetConfig(pr.data), prophetConfig(PROPHET_DEFAULTS)], [{ contact: 3 }, { contact: 1 }]);
eq('prophet is passive and reveals the whole hand', [pr.data.passive, pr.data.hand_reveal?.n], [true, 'all']);

// ---- wild monsters ----
eq('sleeping creature is wild', isWildMonster({ monster_state: 'sleeping' }), true);
eq('awake creature is wild', isWildMonster({ monster_state: 'awake' }), true);
eq('companion is not wild', isWildMonster({ monster_state: 'awake', owner_peer_id: 'peer:x' }), false);
eq('hero is not wild', isWildMonster({ monster_state: null }), false);

// ---- lure ----
const cands = [
  { id: 'm3', wild: true, enemy: true, alive: true, d: 10 },   // edge of range → lured
  { id: 'm1', wild: true, enemy: true, alive: true, d: 2 },
  { id: 'm9', wild: true, enemy: true, alive: true, d: 11 },   // too far
  { id: 'm2', wild: true, enemy: true, alive: false, d: 1 },   // dead
  { id: 'h1', wild: false, enemy: true, alive: true, d: 1 },   // enemy hero: not a monster
  { id: 'm4', wild: true, enemy: false, alive: true, d: 1 },   // a monster on my side
];
eq('lure: living wild enemy monsters within 10, sorted', lureTargets(cands, 10), ['m1', 'm3']);

// ---- chase bonus (max 1, re-granted by a NEW chaser) ----
const cfg = avengerConfig(av.data);
let s = { chasers: [], bonus: 0 };
let o = chaseBonusStep(s, ['m1', 'm3'], cfg);
eq('two new chasers → +1 only (max 1)', [o.fresh, o.grant, o.bonus, o.fade], [['m1', 'm3'], 1, 1, false]);
s = o; o = chaseBonusStep(s, ['m1', 'm3'], cfg);
eq('same chasers next action → nothing', [o.fresh, o.grant, o.bonus], [[], 0, 1]);
s = { ...o, bonus: 0 };   // the point was lost to damage
o = chaseBonusStep(s, ['m1', 'm3'], cfg);
eq('point lost, no new chaser → stays lost', [o.grant, o.bonus], [0, 0]);
s = o; o = chaseBonusStep(s, ['m1', 'm3', 'm7'], cfg);
eq('point lost, a new chaser m7 → +1 again', [o.fresh, o.grant, o.bonus], [['m7'], 1, 1]);
s = o; o = chaseBonusStep(s, ['m3', 'm8'], cfg);
eq('bonus held, new chaser m8 → no second point', [o.fresh, o.grant, o.bonus], [['m8'], 0, 1]);
s = o; o = chaseBonusStep(s, [], cfg);
eq('nobody chases any more → the point fades', [o.fade, o.bonus, o.chasers], [true, 0, []]);
s = o; o = chaseBonusStep(s, ['m3'], cfg);
eq('m3 chases again after the chase ended → counts as new', [o.fresh, o.grant, o.bonus], [['m3'], 1, 1]);
eq('chase bonus +1 life max AND +1 life (heal = grant) without max_only', [o.grant, o.heal, chaseBonusStep({ chasers: [], bonus: 0 }, ['m1'], avengerConfig(AVENGER_DEFAULTS)).heal], [1, cfg.maxOnly ? 0 : 1, 1]);
{ const mo = avengerConfig({ chase_bonus: { life: 1, max: 1, max_only: true } }); const g = chaseBonusStep({ chasers: [], bonus: 0 }, ['m1'], mo);
  eq('CP 2026-11-19 (pick 9 a): max_only → +1 life max, heal 0 (no +1 life)', [g.grant, g.heal, g.bonus], [1, 0, 1]); }

// ---- Prophet pick ----
eq('prophet: the enemy I fought first', prophetPick([{ id: 'a' }, { id: 'c', fought: true }, { id: 'b', fought: true }]), 'b');
eq('prophet: else the smallest id', prophetPick([{ id: 'z' }, { id: 'k' }]), 'k');
eq('prophet: nobody in contact', prophetPick([]), null);

if (fails) { console.log(`${fails} chase check(s) FAILED`); process.exit(1); }
console.log('all chase checks passed');
