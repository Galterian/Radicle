// Effect-hooks check (MV milestone, 2026-11-17): the peer-side effect rules of game/effect-hooks.mjs — channels,
// traps, holdings, summons — as data (game/effects-data/hooks/*.json) must give exactly what their JS references give,
// and applying the records must leave exactly the state the pre-MV inline peer.mjs code left.
//   node tools/effect-hooks-check.mjs            → ends with "all effect-hooks checks passed"
// 1. files: the 4 hook families load and validate; every hook has a program; tables.trap_power = effects.mjs TRAP_POWER.
// 2. identity: EFFECT_HOOKS_CHECK_N (default 700) seeded random worlds × every hook — JS vs data, JSON-identical;
//    every record op of every hook is produced at least once (coverage).
// 3. oracles: worked numbers (trap damage Σ(20 − stat)/10, the Reaver/Barbarian channel ruling 2026-11-17, Blessing
//    replacement, trap routing ruling 2026-10-30, Elementals/Golems family ruling 2026-11-12).
// 4. shadow apply: a small model of the peer's holdings; the pre-MV inline code (verbatim from peer.mjs) vs the
//    hook records applied through applyHookRecords with the handlers _mv_peer_hunks.py installs — identical state + logs.
// 5. failures: a data error / bad shape → the neutral value, counted; effectHook(…, 'shadow') reports 0 mismatches.
import * as H from '../effect-hooks.mjs';
import { channelBreaks } from '../channel-rule.mjs';
import { TRAP_POWER, trapDamageSum, roundHalfUp10 } from '../effects.mjs';

let fails = 0, oks = 0;
const ok = (label, cond, extra = '') => { if (cond) { oks++; console.log(`ok   ${label}`); } else { fails++; console.log(`FAIL ${label}${extra ? ` — ${String(extra).slice(0, 700)}` : ''}`); } };
const J = (x) => JSON.stringify(x);
const N = Number(process.env.EFFECT_HOOKS_CHECK_N) || 700;

// ---- 1. files ------------------------------------------------------------------------------------------------
console.log('-- 1. hook files');
const bundle = H.loadHookFiles();
ok('every hook of EFFECT_HOOK_SPECS has a data program', H.EFFECT_HOOK_NAMES.every(n => bundle.has(n)), H.EFFECT_HOOK_NAMES.filter(n => !bundle.has(n)).join());
ok('families channel / trap / holdings / summon', J([...new Set([...bundle.values()].map(p => p.family))].sort()) === J(['channel', 'holdings', 'summon', 'trap']));
ok('tables.trap_power = effects.mjs TRAP_POWER (20)', bundle.get('trap_spring').tables.trap_power === TRAP_POWER && TRAP_POWER === 20);
ok('a file with an unknown hook is refused', H.validateHookFile({ schema: H.EFFECT_HOOKS_SCHEMA_ID, id: 'trap', version: '1.0.0', hooks: { trap_fly: [] } }).some(e => /unknown hook/.test(e)));
ok('a hook in the wrong family is refused', H.validateHookFile({ schema: H.EFFECT_HOOKS_SCHEMA_ID, id: 'trap', version: '1.0.0', hooks: { perm_falls: [] } }).some(e => /belongs to family holdings/.test(e)));
ok('a denied op (emit) is refused', H.validateHookFile({ schema: H.EFFECT_HOOKS_SCHEMA_ID, id: 'trap', version: '1.0.0', hooks: { trap_lay: { emit: ['x', 1] } } }).length > 0);

// ---- random worlds ---------------------------------------------------------------------------------------------
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const STATS = ['vitality', 'world', 'matter', 'will'];
const ELEMS = { elem_fire: 'matter', elem_earth: 'matter', elem_air: 'world', elem_water: 'vitality', elem_time: 'world', elem_space: 'world', elem_souls: 'will', elem_harmony: 'will', elem_vitality: 'vitality' };
const EL = Object.keys(ELEMS);
const CODES = ['A', 'M', 'B', 'P', 'EM', 'EP'];
const CHAN = ['effect_harm', 'effect_combustion', 'effect_the_void', 'effect_light_darkness'];
const TRAPFX = ['effect_poison', 'effect_sleep', 'effect_confusion', 'effect_traps_mastery', 'effect_fireball'];
const hd = (a, b) => Math.max(Math.abs(a.tile_q - b.tile_q), Math.abs(a.tile_r - b.tile_r), Math.abs((a.tile_q + a.tile_r) - (b.tile_q + b.tile_r)));
const sideOf = (al) => (al === 'npc_a' || al === 'npc_b' ? al : 'player');

function genWorld(seed) {
  const R = rng(seed), ri = (a, b) => a + Math.floor(R() * (b - a + 1)), pick = (l) => l[Math.floor(R() * l.length)], maybe = (p) => R() < p;
  const n = ri(2, 6);
  const ids = Array.from({ length: n }, (_, i) => `peer:${String.fromCharCode(97 + i)}${(seed * 7 + i * 13) % 1000}`).sort();
  const turn = ri(1, 9), action = ri(0, 2);
  const views = new Map(), reveals = [], channels = new Map(), perms = new Map(), emits = new Map();
  for (const id of ids) {
    const v = { peer_id: id, name: `N${id.slice(5, 6)}`, alliance: pick(['player', 'player', 'npc_a', 'npc_b']), life: maybe(0.15) ? 0 : ri(1, 6),
      tile_q: maybe(0.05) ? null : ri(-3, 3), tile_r: ri(-3, 3), ...(maybe(0.4) ? { creature_id: pick(['mon_wolf', 'mon_bear', 'mon_imp']) } : {}) };
    for (const s of STATS) if (maybe(0.9)) v[`stat_${s}`] = ri(2, 22);
    views.set(id, v);
    perms.set(id, new Set(['effect_blessing_curse', 'effect_traps_mastery', 'effect_shield'].filter(() => maybe(0.4))));
    emits.set(id, new Set(['A', 'B'].filter(() => maybe(0.3))));
    const chs = [];
    for (let k = ri(0, 2); k > 0; k--) {
      const never = maybe(0.25), awake = !never && maybe(0.3);
      chs.push({ effect_id: awake ? 'effect_awake' : pick(CHAN), target: maybe(0.6) ? pick(ids) : null, elements: Array.from({ length: ri(1, 3) }, () => pick(EL)), salt: maybe(0.9) ? `s${ri(0, 99)}` : '',
        stop: never ? 'never' : (!awake && maybe(0.15)) ? 'contact' : 'break', holder: never ? pick(['effect_blessing_curse', null]) : null, card_id: maybe(0.5) ? `card-${ri(0, 99)}` : null,
        startedTurn: maybe(0.4) ? turn : turn - 1, startedAction: ri(0, 2) });
    }
    channels.set(id, chs);
    if (maybe(0.8)) {
      const r = { actor: id, action: pick(CODES) };
      if (maybe(0.2)) r.declared = pick(CODES);
      if (maybe(0.15)) r.trance = [pick(CODES), pick(CODES)];
      if (maybe(0.5)) r.effect = { elements: Array.from({ length: ri(1, 3) }, () => pick(EL)), ...(maybe(0.7) ? { step: ri(0, 4) } : {}) };
      if (maybe(0.6)) r.target = maybe(0.85) ? { kind: 'character', ref: pick(ids) } : { kind: 'tile', ref: { q: ri(-2, 2), r: ri(-2, 2) } };
      reveals.push(r);
    }
  }
  const owners = [...ids, 'world'];
  const traps = [];
  for (let k = ri(0, 6); k > 0; k--) {
    const owner = pick(owners), own = views.get(owner);
    const onOwner = own && maybe(0.5);
    traps.push({ id: owner === 'world' ? (maybe(0.5) ? `dng:${ri(-3, 3)},${ri(-3, 3)}` : `wtrap:${ri(-3, 3)},${ri(-3, 3)}`) : `${owner.slice(-8)}#${ri(0, 2)}#trap${k}`,
      q: onOwner ? own.tile_q : ri(-3, 3), r: onOwner ? own.tile_r : ri(-3, 3), effect_id: pick(TRAPFX), elements: Array.from({ length: ri(0, 3) }, () => pick(EL)),
      card_id: maybe(0.6) ? `card-t${k}` : null, power: TRAP_POWER, trigger: pick(['enter', 'targeted']), mode: pick(['damage', 'damage', 'perm']),
      holder: maybe(0.3) ? 'effect_traps_mastery' : null, ...(maybe(0.2) ? { library: true } : {}), owner });
  }
  const gone = new Set(traps.filter(() => maybe(0.15)).map(t => t.id)), spent = new Set(traps.filter(() => maybe(0.15)).map(t => t.id));
  const blessed = new Set(ids.filter(() => maybe(0.2))), shieldedSet = new Set(), untouch = new Set(), known = new Set(TRAPFX.filter(() => maybe(0.8))), weGone = new Set(traps.filter(() => maybe(0.3)).map(t => t.id));
  for (const id of ids) { for (const el of EL) if (maybe(0.1)) shieldedSet.add(`${id}|${el}`); if (maybe(0.1)) untouch.add(id); }
  const self = pick(ids);
  const enemyOf = (a, b) => a === 'world' || b === 'world' || (views.has(a) && views.has(b) && sideOf(views.get(a).alliance) !== sideOf(views.get(b).alliance));
  const ctx = {
    self,
    ids: () => ids, view: (id) => views.get(id), lifeOf: (id) => views.get(id)?.life ?? 0, channelsOf: (id) => channels.get(id) || [],
    reveal: (id) => reveals.find(r => r.actor === id), hasPerm: (id, p) => !!perms.get(id)?.has(p), classEmits: (id, code) => !!emits.get(id)?.has(code),
    traps: () => traps, trapGone: (id) => gone.has(id), trapSpent: (id) => spent.has(id), enemyOf, reveals: () => reveals,
    distBetween: (a, b) => { const pa = views.get(a), pb = views.get(b); return pa && pb ? hd(pa, pb) : Infinity; },   // = peer.mjs distBetween
    blessedEvery: (id) => blessed.has(id), statOf: (id, st) => views.get(id)?.[`stat_${st}`] ?? 0, elemStat: (el) => ELEMS[el],
    shielded: (id, el) => shieldedSet.has(`${id}|${el}`), untouchable: (v) => untouch.has(v),
    effectKnown: (id) => known.has(id), worldEditGone: (id) => weGone.has(id),
    sideOf, hexDistance: hd, creature: (cid) => (cid === 'mon_imp' ? null : { name: cid.replace('mon_', '').toUpperCase(), stat_sum: cid.length * 3 }),
  };
  // the hooks' args, as peer.mjs builds them
  const tile = { q: ri(-3, 3), r: ri(-3, 3) };
  const outCh = Array.from({ length: ri(0, 2) }, () => { const bless = maybe(0.4); return { on: maybe(0.8) ? self : pick(ids), effect_id: bless ? pick([...CHAN, 'effect_fireball']) : pick(CHAN), target: maybe(0.5) ? pick(ids) : null,
    elements: [pick(EL)], salt: `x${ri(0, 9)}`, stop: bless ? 'never' : 'break', holder: bless ? 'effect_blessing_curse' : null, card_id: bless || maybe(0.3) ? `card-c${ri(0, 9)}` : null }; });
  const outTraps = Array.from({ length: ri(0, 3) }, () => ({ by: maybe(0.8) ? self : pick(ids), q: ri(-3, 3), r: ri(-3, 3), effect_id: pick(TRAPFX), elements: [pick(EL)], card_id: maybe(0.7) ? `card-l${ri(0, 9)}` : null,
    ...(maybe(0.2) ? { library: true } : {}), power: TRAP_POWER, trigger: pick(['enter', 'targeted']), mode: pick(['damage', 'perm']), holder: maybe(0.3) ? 'effect_traps_mastery' : null }));
  const tsOf = () => { const tp = pick(traps.length ? traps : [{ id: 'dng:0,0', owner: 'world', effect_id: 'effect_poison', trigger: 'enter', mode: 'damage', holder: null, card_id: null }]);
    const dis = maybe(0.3);
    return { owner: maybe(0.5) ? self : tp.owner, id: tp.id, victim: maybe(0.5) ? self : pick(ids), effect_id: tp.effect_id, mode: tp.mode, trigger: tp.trigger, holder: tp.holder || null, card_id: tp.card_id || null,
      ...(dis ? { library: !!tp.library, disabled: true, cleric_mode: pick(['passive', 'active']), by: pick(ids), to: pick([self, tp.owner, pick(ids), null]) } : {}) }; };
  const SUMMONS = ['effect_summoning', 'effect_resurrect_death_ward', 'effect_golems_earth', 'effect_golems_fire', 'effect_elementals_air', 'effect_elementals_water'];
  const smOf = () => pick([
    { creature_id: pick(['mon_wolf', 'mon_imp']), name: 'W', need: ri(0, 40) },
    { creature_id: 'mon_bear', name: 'B', need: 20, archive_card_id: `arc-${ri(0, 9)}` },
    { ward: pick(ids), name: 'A', need: 0 }, { revive: pick(ids), creature_id: null, is_player: true, name: 'P', need: 30 },
    { revive: pick(ids), creature_id: 'mon_wolf', is_player: false, name: 'W', need: 30, ...(maybe(0.5) ? { archive_card_id: 'arc-r' } : {}) },
    { bind: pick(ids), creature_id: 'mon_wolf', name: 'W', need: 18 }, { pending: true, need: 0 }]);
  const perm_id = pick(SUMMONS);
  const args = {
    channel_pass: { turn, action, round: action },
    channel_land: { channels: outCh, mine: channels.get(self), self, turn, action },
    trap_enter: { who: pick(ids), q: maybe(0.6) && traps.length ? pick(traps).q : tile.q, r: maybe(0.6) && traps.length ? pick(traps).r : tile.r },
    trap_targeted: {},
    trap_spring: { trap: traps.length ? pick(traps) : { id: 'x', owner: 'world', mode: 'damage', elements: ['elem_fire'], effect_id: 'effect_poison' }, victim: pick(ids) },
    trap_lay: { traps: outTraps, self, action, count: ri(0, 4) },
    trap_spent: { ts: tsOf(), self, turn, action },
    perm_falls: { id: pick(['effect_blessing_curse', 'effect_traps_mastery', 'effect_harm', 'effect_shield']), channels: channels.get(self), traps: traps.filter(t => t.owner === self).map(({ owner, ...t }) => t) },
    summon_plan: { effect_id: pick([...SUMMONS, 'effect_fireball']), every: maybe(0.4), self, here: { q: views.get(self).tile_q ?? 0, r: views.get(self).tile_r },
      target: maybe(0.5) ? pick(ids) : maybe(0.5) ? { q: 1, r: 1 } : null, side: sideOf(views.get(self).alliance), peers: [...views.values()],
      archived: maybe(0.3) ? { creature_id: 'mon_bear', name: 'Bear', stat_sum: 33, card_id: 'arc-1' } : null,
      dealt: maybe(0.5) ? smOf() : (maybe(0.5) ? { creature_id: 'mon_wolf', name: 'W', need: 5 } : null) },
    summon_paid: { perm_id, sm: smOf(), summons: maybe(0.5) ? [{ peer_id: 'x', perm: perm_id }] : [{ peer_id: 'y', perm: 'effect_phantom' }],
      permanents: [...new Set([perm_id, ...SUMMONS.filter(() => maybe(0.3)), 'effect_shield'])] },
  };
  return { ctx, args, ids, views, traps, self, turn, action, channels, perms, R };
}

// ---- 2. identity ------------------------------------------------------------------------------------------------
console.log(`-- 2. JS reference vs data program, ${N} seeded worlds × ${H.EFFECT_HOOK_NAMES.length} hooks`);
const tally = new Map(), opsSeen = new Map();
let firstBad = null;
for (let s = 1; s <= N; s++) {
  const w = genWorld(s);
  for (const name of H.EFFECT_HOOK_NAMES) {
    const a = J(H.effectHookJs(name, w.ctx, w.args[name]));
    let b;
    try { b = J(H.runHookData(name, w.ctx, w.args[name])); } catch (e) { b = `throws ${e.message}`; }
    const t = tally.get(name) || { n: 0, same: 0 }; t.n++; if (a === b) t.same++; else if (!firstBad) firstBad = `${name} seed ${s}\n  js   ${a.slice(0, 500)}\n  data ${b.slice(0, 500)}`;
    tally.set(name, t);
    const v = JSON.parse(a);
    const seen = opsSeen.get(name) || new Set();
    if (Array.isArray(v)) for (const r of v) seen.add(r?.op ?? 'item'); else seen.add(v?.op);
    opsSeen.set(name, seen);
  }
}
for (const [name, t] of tally) ok(`${name}: ${t.same}/${t.n} identical`, t.same === t.n, firstBad);
for (const name of H.EFFECT_HOOK_NAMES) {
  const sp = H.EFFECT_HOOK_SPECS[name], seen = opsSeen.get(name);
  const want = sp.result === 'records' ? sp.ops : sp.result === 'plan' ? ['set', 'keep'] : ['item'];
  ok(`${name}: covered ${want.join('/')}`, want.every(o => seen.has(o)), `missing ${want.filter(o => !seen.has(o)).join()}`);
}

// ---- 3. oracles --------------------------------------------------------------------------------------------------
console.log('-- 3. oracles (worked numbers, rulings)');
const ENGINES = ['js', 'data'];
const both = (label, name, ctx, args, check) => { for (const m of ENGINES) ok(`${label} [${m}]`, check(H.effectHook(name, ctx, args, m)), J(H.effectHook(name, ctx, args, m))); };
{
  // Trap damage: Fireball-coloured trap (fire + air) on a victim with Matter 12, World 15 → (20−12) + (20−15) = 13 → 1.
  const v = { peer_id: 'V', stat_matter: 12, stat_world: 15 };
  const c = { self: 'O', blessedEvery: () => false, statOf: (id, st) => v[`stat_${st}`] ?? 0, elemStat: (el) => ELEMS[el], shielded: () => false, untouchable: () => false };
  const tp = { id: 't', owner: 'O', mode: 'damage', elements: ['elem_fire', 'elem_air'], effect_id: 'effect_poison' };
  both('trap damage: (20−12)+(20−15) = 13 → 1', 'trap_spring', c, { trap: tp, victim: 'V' }, (r) => J(r) === J([{ op: 'damage', amount: 1 }]));
  ok('trap damage = effects.mjs trapDamageSum / roundHalfUp10', roundHalfUp10(trapDamageSum(tp.elements, el => c.statOf('V', ELEMS[el]))) === 1);
  both('trap damage: a shielded element counts 0 (fire shielded → 5 → 1)', 'trap_spring', { ...c, shielded: (id, el) => el === 'elem_fire' }, { trap: tp, victim: 'V' }, (r) => r[0].amount === 1);
  both('trap damage: three weak elements (Matter 2: 18 × 3 = 54 → 5)', 'trap_spring', { ...c, statOf: () => 2 }, { trap: { ...tp, elements: ['elem_fire', 'elem_earth', 'elem_fire'] }, victim: 'V' }, (r) => r[0].amount === 5);
  both('trap damage on an untouchable victim → 0', 'trap_spring', { ...c, untouchable: () => true }, { trap: tp, victim: 'V' }, (r) => r[0].amount === 0);
  both('Blessing ∀ negates a sprung trap', 'trap_spring', { ...c, blessedEvery: () => true }, { trap: tp, victim: 'V' }, (r) => J(r) === J([{ op: 'bless' }]));
  both('perm trap (Sleep) afflicts the victim; the owner (me) gains the permanent', 'trap_spring', c, { trap: { ...tp, mode: 'perm', effect_id: 'effect_sleep' }, victim: 'V' },
    (r) => J(r) === J([{ op: 'afflict', on: 'V', effect_id: 'effect_sleep', by: 'O' }, { op: 'perm_add', id: 'effect_sleep' }]));
  both('perm trap of another owner: no permanent for me', 'trap_spring', { ...c, self: 'X' }, { trap: { ...tp, mode: 'perm', effect_id: 'effect_sleep' }, victim: 'V' }, (r) => r.length === 1 && r[0].op === 'afflict');
}
{
  // Channels: a Reaver's Attack (class emits on A) keeps the channel (user ruling 2026-11-17); a plain Attack breaks it;
  // emitting another element breaks it; the cast action itself does not tick.
  const ch = { effect_id: 'effect_harm', target: 'E', elements: ['elem_fire'], salt: 's', stop: 'break', holder: null, card_id: null, startedTurn: 3, startedAction: 0 };
  const mk = (rev, emits) => ({ ids: () => ['R'], view: () => ({ tile_q: 0, tile_r: 0 }), lifeOf: () => 3, channelsOf: () => [ch], reveal: () => rev, hasPerm: () => false, classEmits: (id, code) => emits.includes(code) });
  const A = { turn: 3, action: 1, round: 1 };
  both('Reaver plays A (class emits on A): channel kept + ticks', 'channel_pass', mk({ actor: 'R', action: 'A' }, ['A']), A, (r) => J(r.map(x => x.op)) === J(['kept', 'tick']) && r[1].cast.salt === 's:tick:3:1' && r[1].cast._channel_tick === true);
  both('plain A: channel breaks', 'channel_pass', mk({ actor: 'R', action: 'A' }, []), A, (r) => J(r) === J([{ op: 'break', owner: 'R', effect_id: 'effect_harm' }]));
  both('Barbarian B keeps it, but emitting air (cost fire) still breaks', 'channel_pass', mk({ actor: 'R', action: 'B', effect: { elements: ['elem_air'], step: 1 } }, ['B']), A, (r) => J(r.map(x => x.op)) === J(['break']));
  both('Battle Trance pair with A: breaks even for a Reaver', 'channel_pass', mk({ actor: 'R', action: 'P', trance: ['A', 'P'] }, ['A']), A, (r) => J(r.map(x => x.op)) === J(['break']));
  both('Posture emitting the cost element: ticks', 'channel_pass', mk({ actor: 'R', action: 'EP', effect: { elements: ['elem_fire'] } }, []), A, (r) => J(r.map(x => x.op)) === J(['tick']));
  both('the cast action itself does not tick', 'channel_pass', mk({ actor: 'R', action: 'EP' }, []), { turn: 3, action: 0, round: 0 }, (r) => r.length === 0);
  for (const rev of [null, { action: 'M' }, { action: 'A' }, { action: 'B' }, { action: 'EP', declared: 'EM' }, { action: 'P', trance: ['B', 'M'] }, { action: 'P', effect: { elements: ['elem_fire', 'elem_air'], step: 2 } }])
    for (const em of [[], ['A'], ['B'], ['A', 'B']]) {
      const want = channelBreaks(rev, 'elem_fire', (code) => em.includes(code));
      const got = H.effectHook('channel_pass', mk(rev && { actor: 'R', ...rev }, em), A, 'data');
      ok(`data channel break = channel-rule.mjs (${J(rev)} emits ${em.join('') || '-'})`, got.some(x => x.op === 'break') === want.breaks && got.some(x => x.op === 'kept') === want.kept);
    }
  // Awake (2026-11-18, chaosd6-1b): 'every action until contact' - a living enemy next to the holder ends the channel,
  // after the break check and before the cast-action skip (so on the cast action too); a dead / far / allied unit does not.
  const aw = { ...ch, effect_id: 'effect_awake', stop: 'break' };
  const pos = { R: [0, 0], E: [1, 0], F: [3, 0], L: [0, 1] };
  const mkA = (rev, others, chs = [aw], life = {}) => ({ ...mk(rev, []), ids: () => ['R', ...others], channelsOf: (id) => (id === 'R' ? chs : []),
    view: (id) => ({ tile_q: pos[id][0], tile_r: pos[id][1] }), lifeOf: (id) => life[id] ?? 3, enemyOf: (a, b) => (a === 'R') !== (b === 'R') && a !== 'L' && b !== 'L',
    distBetween: (a, b) => hd({ tile_q: pos[a][0], tile_r: pos[a][1] }, { tile_q: pos[b][0], tile_r: pos[b][1] }) });
  const P0 = { actor: 'R', action: 'EP' };
  both('Awake: an enemy next to the holder -> contact (no tick)', 'channel_pass', mkA(P0, ['E']), A, (r) => J(r) === J([{ op: 'contact', owner: 'R', effect_id: 'effect_awake' }]));
  both('Awake: contact also on the cast action itself', 'channel_pass', mkA(P0, ['E']), { turn: 3, action: 0, round: 0 }, (r) => J(r.map(x => x.op)) === J(['contact']));
  both('Awake: enemy 3 hexes away -> ticks', 'channel_pass', mkA(P0, ['F']), A, (r) => J(r.map(x => x.op)) === J(['tick']));
  both('Awake: a dead enemy next to it -> ticks', 'channel_pass', mkA(P0, ['E'], [aw], { E: 0 }), A, (r) => J(r.map(x => x.op)) === J(['tick']));
  both('Awake: an ally next to it -> ticks', 'channel_pass', mkA(P0, ['L']), A, (r) => J(r.map(x => x.op)) === J(['tick']));
  both('Awake: break wins over contact (plain A)', 'channel_pass', mkA({ actor: 'R', action: 'A' }, ['E']), A, (r) => J(r.map(x => x.op)) === J(['break']));
  both('stop contact (any effect) ends on contact; a plain channel next to an enemy ticks', 'channel_pass', mkA(P0, ['E'], [{ ...ch, stop: 'contact' }, ch]), A, (r) => J(r.map(x => x.op)) === J(['contact', 'tick']));
  both('a blessed (stop never) Awake ignores contact', 'channel_pass', { ...mkA(P0, ['E'], [{ ...aw, stop: 'never', holder: 'effect_blessing_curse' }]), hasPerm: () => true }, A, (r) => J(r.map(x => x.op)) === J(['tick']));
  const bless = { on: 'M', effect_id: 'effect_fireball', target: 'E', elements: ['elem_fire'], salt: 'b', stop: 'never', holder: 'effect_blessing_curse', card_id: 'c-new' };
  const mine = [{ effect_id: 'effect_harm', holder: 'effect_blessing_curse', card_id: 'c-old' }, { effect_id: 'effect_the_void', holder: null, card_id: null }];
  both('a new Blessing releases the old blessed card, keeps the other channel, holds the new card', 'channel_land', {}, { channels: [bless], mine, self: 'M', turn: 4, action: 2 },
    (r) => J(r.map(x => x.op)) === J(['release_card', 'channels', 'hold_card']) && r[0].card_id === 'c-old' && J(r[1].list.map(c => c.effect_id)) === J(['effect_the_void', 'effect_fireball']) && r[1].list[1].startedTurn === 4);
}
{
  // Trap routing (user ruling 2026-10-30): an open-tile damage trap → the card goes to whoever sprang it; under its owner → owner's discard.
  const c = { effectKnown: () => true, worldEditGone: () => false };
  const ts = { owner: 'O', id: 'O#1#trap0', victim: 'V', effect_id: 'effect_fireball', mode: 'damage', trigger: 'enter', holder: null, card_id: 'c1' };
  both('open-tile trap, owner side: removed, card leaves my deck (to_discard false)', 'trap_spent', c, { ts, self: 'O', turn: 2, action: 1 },
    (r) => J(r) === J([{ op: 'trap_remove', id: ts.id }, { op: 'release_card', card_id: 'c1', to_discard: false }, { op: 'mine_done', card_to_victim: true }]));
  both('open-tile trap, victim side: the card joins my discard', 'trap_spent', c, { ts, self: 'V', turn: 2, action: 1 }, (r) => J(r) === J([{ op: 'card_to_me', effect_id: 'effect_fireball', notice: null }]));
  both('targeted trap under its owner: owner discard, victim gets nothing', 'trap_spent', c, { ts: { ...ts, trigger: 'targeted', holder: 'effect_traps_mastery' }, self: 'O', turn: 2, action: 1 },
    (r) => J(r.map(x => x.op)) === J(['trap_remove', 'release_card', 'drop_perm', 'mine_done']) && r[1].to_discard === true);
  both('dungeon explored by me: world edit replaced, card to me (notice dungeon)', 'trap_spent', c, { ts: { ...ts, owner: 'world', id: 'dng:1,2', card_id: null }, self: 'V', turn: 7, action: 2 },
    (r) => J(r) === J([{ op: 'world_edit', replace: true, edit: { id: 'dng:1,2', explored: 7, at: 2 } }, { op: 'card_to_me', effect_id: 'effect_fireball', notice: 'dungeon' }]));
}
{
  // Elementals / Golems family (user ruling 2026-11-12): a new one replaces the earlier one of its family.
  const sm = { creature_id: 'mon_golem', name: 'G', need: 24 };
  both('a new Golems drops the earlier Golems, keeps the Elementals, spawns', 'summon_paid', {}, { perm_id: 'effect_golems_fire', sm, summons: [], permanents: ['effect_golems_earth', 'effect_elementals_air', 'effect_golems_fire'] },
    (r) => J(r) === J([{ op: 'drop_perm', id: 'effect_golems_earth' }, { op: 'spawn', creature_id: 'mon_golem' }]));
  both('Death Ward lands, nothing else', 'summon_paid', {}, { perm_id: 'effect_resurrect_death_ward', sm: { ward: 'A', name: 'A', need: 0, archive_card_id: 'arc' }, summons: [], permanents: [] },
    (r) => J(r) === J([{ op: 'archive_take', card_id: 'arc' }, { op: 'ward', peer_id: 'A' }]));
  const peers = [{ peer_id: 'ME', tile_q: 0, tile_r: 0, life: 3, alliance: 'player' }, { peer_id: 'D2', tile_q: 1, tile_r: 0, life: 0, creature_id: 'mon_wolf', name: 'Wolf', stat_vitality: 5, stat_world: 5, stat_matter: 5, stat_will: 5 },
    { peer_id: 'D1', tile_q: 0, tile_r: 1, life: 0, name: 'Hero', stat_vitality: 10 }];
  const c = { sideOf, hexDistance: hd, creature: () => null };
  both('Resurrect: lowest id dead neighbour first (D1, a player: need = Σ stats)', 'summon_plan', c, { effect_id: 'effect_resurrect_death_ward', every: false, self: 'ME', here: { q: 0, r: 0 }, target: null, side: 'player', peers, archived: null, dealt: null },
    (r) => J(r) === J({ op: 'set', summon: { revive: 'D1', creature_id: null, is_player: true, name: 'Hero', need: 10 } }));
  both('Resurrect: the right-clicked dead unit wins', 'summon_plan', c, { effect_id: 'effect_resurrect_death_ward', every: false, self: 'ME', here: { q: 0, r: 0 }, target: 'D2', side: 'player', peers, archived: null, dealt: null },
    (r) => r.summon.revive === 'D2' && r.summon.need === 20);
  both('Golems keep the creature they were dealt with', 'summon_plan', c, { effect_id: 'effect_golems_earth', every: false, self: 'ME', here: { q: 0, r: 0 }, target: null, side: 'player', peers, archived: null, dealt: null }, (r) => r.op === 'keep');
}

// ---- 4. shadow apply: pre-MV inline peer.mjs code vs records + handlers ---------------------------------------------
console.log('-- 4. shadow apply (state after the inline code = state after the records)');
// A tiny peer: holdings, cards, logs. `inline.*` are the pre-MV peer.mjs blocks, verbatim but for the globals.
function peerModel(w) {
  const P = { channels: structuredClone(w.channels.get(w.self) || []), traps: structuredClone(w.args.perm_falls.traps), held: [], discard: [], archive: [{ card_id: 'arc-1', kind: 'creature' }, { card_id: 'arc-r', kind: 'creature' }],
    perms: new Set(w.args.summon_paid.permanents), summons: structuredClone(w.args.summon_paid.summons), wards: [], worldEdits: [{ id: 'wtrap:0,0', gone: true, at: 0 }], logs: [], dropped: [], spawned: [], ended: [], dirty: 0 };
  for (const c of [...P.channels, ...P.traps]) if (c.card_id) P.held.push({ card_id: c.card_id });
  for (const c of w.args.channel_land.channels) if (c.card_id) P.held.push({ card_id: c.card_id });
  for (const c of w.args.trap_lay.traps) if (c.card_id) P.held.push({ card_id: c.card_id });
  P.releaseHeldCard = (cid, toDiscard = true) => { if (!cid) return; for (let i = P.held.length - 1; i >= 0; i--) if (P.held[i].card_id === cid) { const c = P.held.splice(i, 1)[0]; if (toDiscard) P.discard.push(c); P.logs.push(`spent ${cid} ${toDiscard}`); } };
  P.holdCard = (cid) => P.logs.push(`hold ${cid}`);
  P.dropPermanent = (id) => { P.dropped.push(id); P.perms.delete(id); };
  P.onSummonEnd = (id) => { P.ended.push(id); P.summons = P.summons.filter(x => x.perm !== id); };
  P.makeEffectCard = (eid) => ({ card_id: `new-${eid}`, name: eid });
  return P;
}
const state = (P) => J([P.channels, P.traps, P.held, P.discard, P.archive, [...P.perms], P.summons, P.wards, P.worldEdits, P.logs, P.dropped, P.spawned, P.ended, P.dirty]);
const inline = {
  perm_falls(P, { id }) {
    for (const ch of P.channels.filter(c => c.holder === id)) P.releaseHeldCard(ch.card_id);
    P.channels = P.channels.filter(c => c.effect_id !== id && c.holder !== id);
    for (const tp of P.traps.filter(t => t.holder === id)) P.releaseHeldCard(tp.card_id);
    P.traps = P.traps.filter(t => t.holder !== id);
  },
  channel_land(P, { channels, self, turn, action }) {
    for (const ch of channels || []) if (ch.on === self) {
      if (ch.holder) for (const old of P.channels.filter(c => c.holder === ch.holder)) P.releaseHeldCard(old.card_id);
      P.channels = P.channels.filter(c => c.effect_id !== ch.effect_id && !(ch.holder && c.holder === ch.holder));
      P.channels.push({ effect_id: ch.effect_id, target: ch.target, elements: ch.elements, salt: ch.salt, stop: ch.stop, holder: ch.holder || null, card_id: ch.card_id || null, startedTurn: turn, startedAction: action });
      if (ch.card_id) { P.holdCard(ch.card_id); P.logs.push(`${ch.effect_id} is blessed`); }
    }
  },
  trap_lay(P, { traps, self, action }) {
    for (const tp of traps || []) if (tp.by === self) {
      const id = `${self.slice(-8)}#${action}#trap${P.traps.length}`;
      P.traps.push({ id, q: tp.q, r: tp.r, effect_id: tp.effect_id, elements: tp.elements, card_id: tp.card_id, power: tp.power, trigger: tp.trigger, mode: tp.mode, holder: tp.holder, ...(tp.library ? { library: true } : {}) });
      if (tp.card_id) P.holdCard(tp.card_id);
      P.logs.push(`trap ${tp.effect_id} laid at (${tp.q},${tp.r}) [${tp.trigger}/${tp.mode}]`); P.dirty++;
    }
  },
  trap_spent(P, { ts, self, turn, action }, known) {
    const cardToVictim = ts.disabled ? (!!ts.to && ts.to !== ts.owner) : (ts.trigger === 'enter' && ts.mode === 'damage');
    if (ts.owner === self) {
      P.traps = P.traps.filter(t => t.id !== ts.id);
      if (ts.mode === 'damage' || ts.disabled) P.releaseHeldCard(ts.card_id, !cardToVictim);
      if (ts.disabled && !cardToVictim && !ts.card_id && known(ts.effect_id)) { P.discard.push(P.makeEffectCard(ts.effect_id)); P.logs.push(`library trap ${ts.effect_id} to my discard`); }
      if (ts.holder) P.dropPermanent(ts.holder);
      P.logs.push(`my trap ${ts.effect_id} ${ts.disabled ? 'is disabled' : `sprang on ${ts.victim}`}${cardToVictim ? ' — its card is theirs now' : ''}`); P.dirty++;
    }
    const receiver = ts.disabled ? ts.to : ts.victim;
    const isDungeon = String(ts.id).startsWith('dng:');
    if (isDungeon && ts.victim === self) { P.worldEdits = P.worldEdits.filter(e => e.id !== ts.id); P.worldEdits.push({ id: ts.id, explored: turn, at: action }); P.logs.push(`dungeon ${ts.id} explored`); }
    else if (ts.owner === 'world' && ts.victim === self && !P.worldEdits.some(e => e.id === ts.id && e.gone)) P.worldEdits.push({ id: ts.id, gone: true, at: action });
    if (cardToVictim && receiver === self && receiver !== ts.owner && known(ts.effect_id)) {
      const c = P.makeEffectCard(ts.effect_id); P.discard.push(c);
      P.logs.push(`I dealt with the ${c.name} trap`);
      if (ts.disabled) P.logs.push('notice cleric'); else if (ts.owner === 'world') P.logs.push(`notice ${isDungeon ? 'dungeon' : 'building'}`);
    }
  },
  summon_paid(P, { perm_id: permId, sm }) {
    if (sm.archive_card_id) { const i = P.archive.findIndex(c => c.card_id === sm.archive_card_id); if (i >= 0) P.archive.splice(i, 1); }
    if (sm.ward) { if (!P.wards.includes(sm.ward)) P.wards.push(sm.ward); P.logs.push(`ward ${sm.ward}`); return; }
    if (sm.revive) {
      if (sm.is_player) { P.logs.push(`${sm.name} back`); P.dropPermanent(permId); return; }
      P.summons.push({ peer_id: sm.revive, creature_id: sm.creature_id, name: sm.name, bound: true, perm: permId, mode: 'revive' }); P.logs.push(`${sm.name} rises`); return;
    }
    if (P.summons.some(x => x.perm === permId)) { P.logs.push(`a new ${permId} releases`); P.onSummonEnd(permId); }
    const familyOf = (id) => id.startsWith('effect_elementals') ? 'Elementals' : id.startsWith('effect_golems') ? 'Golems' : null;
    if (familyOf(permId)) for (const other of [...P.perms]) if (other !== permId && familyOf(other) === familyOf(permId)) { P.logs.push(`replaces ${other}`); P.dropPermanent(other); }
    if (sm.bind) { P.summons.push({ peer_id: sm.bind, creature_id: sm.creature_id, name: sm.name, bound: true, perm: permId, mode: 'bind' }); P.logs.push(`${sm.name} bound`); return; }
    if (sm.creature_id === 'mon_imp') return;   // = `if (!cre) return;` (no such creature in data)
    P.spawned.push(sm.creature_id);
  },
};
// The handlers _mv_peer_hunks.py installs in peer.mjs (same bodies, peer globals → the model).
const handlers = {
  perm_falls: (P) => ({ release_card: (x) => P.releaseHeldCard(x.card_id, x.to_discard ?? true), channels: (x) => { P.channels = x.list; }, traps: (x) => { P.traps = x.list; } }),
  channel_land: (P) => ({ release_card: (x) => P.releaseHeldCard(x.card_id), channels: (x) => { P.channels = x.list; }, hold_card: (x) => { P.holdCard(x.card_id); P.logs.push(`${x.effect_id} is blessed`); } }),
  trap_lay: (P) => ({ add_trap: ({ trap: tp }) => { P.traps.push(tp); if (tp.card_id) P.holdCard(tp.card_id); P.logs.push(`trap ${tp.effect_id} laid at (${tp.q},${tp.r}) [${tp.trigger}/${tp.mode}]`); P.dirty++; } }),
  trap_spent: (P, ts) => ({
    trap_remove: (x) => { P.traps = P.traps.filter(t => t.id !== x.id); },
    release_card: (x) => P.releaseHeldCard(x.card_id, x.to_discard),
    discard_new: (x) => { P.discard.push(P.makeEffectCard(x.effect_id)); P.logs.push(`library trap ${x.effect_id} to my discard`); },
    drop_perm: (x) => P.dropPermanent(x.id),
    mine_done: (x) => { P.logs.push(`my trap ${ts.effect_id} ${ts.disabled ? 'is disabled' : `sprang on ${ts.victim}`}${x.card_to_victim ? ' — its card is theirs now' : ''}`); P.dirty++; },
    world_edit: (x) => { if (x.replace) { P.worldEdits = P.worldEdits.filter(e => e.id !== x.edit.id); P.worldEdits.push(x.edit); P.logs.push(`dungeon ${x.edit.id} explored`); } else P.worldEdits.push(x.edit); },
    card_to_me: (x) => { const c = P.makeEffectCard(x.effect_id); P.discard.push(c); P.logs.push(`I dealt with the ${c.name} trap`); if (x.notice) P.logs.push(`notice ${x.notice}`); },
  }),
  summon_paid: (P, a) => ({
    archive_take: (x) => { const i = P.archive.findIndex(c => c.card_id === x.card_id); if (i >= 0) P.archive.splice(i, 1); },
    ward: (x) => { if (!P.wards.includes(x.peer_id)) P.wards.push(x.peer_id); P.logs.push(`ward ${x.peer_id}`); },
    revive_player: () => { P.logs.push(`${a.sm.name} back`); P.dropPermanent(a.perm_id); },
    summon_add: (x) => { P.summons.push(x.summon); P.logs.push(x.summon.mode === 'revive' ? `${x.summon.name} rises` : `${x.summon.name} bound`); },
    summon_end: (x) => { P.logs.push(`a new ${x.perm} releases`); P.onSummonEnd(x.perm); },
    drop_perm: (x) => { P.logs.push(`replaces ${x.id}`); P.dropPermanent(x.id); },
    spawn: (x) => { if (x.creature_id === 'mon_imp') return; P.spawned.push(x.creature_id); },
  }),
};
const applyTally = new Map();
for (let s = 1; s <= N; s++) {
  const w = genWorld(s + 100000);
  for (const name of ['perm_falls', 'channel_land', 'trap_lay', 'trap_spent', 'summon_paid']) {
    for (const mode of ENGINES) {
      const A = peerModel(w), B = peerModel(w);
      const a = { ...w.args[name] };
      if (name === 'channel_land') a.mine = A.channels;
      if (name === 'trap_lay') a.count = A.traps.length;
      if (name === 'perm_falls') { a.channels = A.channels; a.traps = A.traps; }
      if (name === 'summon_paid') { a.summons = A.summons; a.permanents = [...A.perms]; }
      inline[name](A, structuredClone(a), w.ctx.effectKnown);
      const b = { ...structuredClone(a), ...(name === 'channel_land' ? { mine: B.channels } : {}), ...(name === 'perm_falls' ? { channels: B.channels, traps: B.traps } : {}), ...(name === 'summon_paid' ? { summons: B.summons, permanents: [...B.perms] } : {}) };
      const ctx = name === 'trap_spent' ? { ...w.ctx, worldEditGone: (id) => B.worldEdits.some(e => e.id === id && e.gone) } : w.ctx;
      if (name === 'trap_spent') inline.trap_spent(A, structuredClone(a), w.ctx.effectKnown);   // a second spend of the same trap (world edit already there)
      H.applyHookRecords(H.effectHook(name, ctx, b, mode), handlers[name](B, b.ts ?? b));
      if (name === 'trap_spent') H.applyHookRecords(H.effectHook(name, ctx, b, mode), handlers[name](B, b.ts));
      const t = applyTally.get(`${name} ${mode}`) || { n: 0, same: 0, bad: null }; t.n++;
      if (state(A) === state(B)) t.same++; else t.bad ||= `seed ${s}\n  inline  ${state(A).slice(0, 600)}\n  records ${state(B).slice(0, 600)}`;
      applyTally.set(`${name} ${mode}`, t);
    }
  }
}
for (const [k, t] of applyTally) ok(`${k}: inline state = records state ${t.same}/${t.n}`, t.same === t.n, t.bad);
{
  // prepareSummon (planning, local): the pre-MV inline body vs card.summon from the summon_plan hook.
  const RES = 'effect_resurrect_death_ward', SUMMON_PERMS = ['effect_summoning', RES, 'effect_golems_earth', 'effect_golems_fire', 'effect_elementals_air', 'effect_elementals_water'];
  const prepInline = (card, every, a, c) => {
    if (!card || !SUMMON_PERMS.includes(card.effect_id)) return;
    const here = { tile_q: a.here.q, tile_r: a.here.r }, target = a.target, MY_SIDE = a.side, arch = a.archived;
    const statSumOf = (cid) => { const cr = c.creature(cid); return cr ? cr.stat_sum : 0; };
    if (card.effect_id === RES) {
      const adj = a.peers.filter(p => p && p.peer_id !== a.self && Number.isInteger(p.tile_q) && hd(here, p) <= 1);
      const dead = adj.filter(p => (p.life ?? 1) <= 0);
      const pick = (typeof target === 'string' && dead.find(p => p.peer_id === target)) || dead.sort((x, y) => x.peer_id.localeCompare(y.peer_id))[0];
      if (pick) { card.summon = { revive: pick.peer_id, creature_id: pick.creature_id || null, is_player: !pick.creature_id, name: pick.name, need: (pick.stat_vitality || 0) + (pick.stat_world || 0) + (pick.stat_matter || 0) + (pick.stat_will || 0) }; return; }
      if (arch) { card.summon = { creature_id: arch.creature_id, name: arch.name, need: arch.stat_sum, archive_card_id: arch.card_id }; return; }
      const allies = adj.filter(p => p.life > 0 && sideOf(p.alliance) === MY_SIDE);
      const ally = (typeof target === 'string' && allies.find(p => p.peer_id === target)) || allies.sort((x, y) => x.peer_id.localeCompare(y.peer_id))[0];
      card.summon = ally ? { ward: ally.peer_id, name: ally.name, need: 0 } : { pending: true, need: 0 };
      return;
    }
    if (card.effect_id !== 'effect_summoning') return;
    if (every) {
      const x = a.peers.filter(p => p && p.peer_id !== a.self && p.creature_id && sideOf(p.alliance) !== MY_SIDE && p.life > 0 && hd(here, p) <= 10)
        .sort((p, q2) => hd(here, p) - hd(here, q2) || p.peer_id.localeCompare(q2.peer_id))[0];
      if (x) { card.summon = { bind: x.peer_id, creature_id: x.creature_id, name: x.name, need: (x.stat_vitality || 0) + (x.stat_world || 0) + (x.stat_matter || 0) + (x.stat_will || 0) }; return; }
    }
    if (arch) card.summon = { creature_id: arch.creature_id, name: arch.name, need: arch.stat_sum, archive_card_id: arch.card_id };
    else if (card.summon?.bind || card.summon?.archive_card_id) { const cid = card.summon.creature_id; card.summon = { creature_id: cid, name: c.creature(cid)?.name || cid, need: statSumOf(cid) }; }
  };
  for (const mode of ENGINES) {
    let same = 0, n = 0, bad = null;
    for (let s = 1; s <= N; s++) {
      const w = genWorld(s + 400000), a = w.args.summon_plan;
      if (!SUMMON_PERMS.includes(a.effect_id)) continue;   // peer.mjs returns before the hook for any other card
      const c1 = { effect_id: a.effect_id, ...(a.dealt ? { summon: structuredClone(a.dealt) } : {}) }, c2 = structuredClone(c1);
      prepInline(c1, a.every, structuredClone(a), w.ctx);
      const plan = H.effectHook('summon_plan', w.ctx, { ...a, dealt: c2.summon ?? null }, mode);
      if (plan.op === 'set') c2.summon = plan.summon;
      n++; if (J(c1) === J(c2)) same++; else bad ||= `seed ${s}\n  inline ${J(c1)}\n  hook   ${J(c2)}`;
    }
    ok(`prepareSummon ${mode}: inline card.summon = summon_plan ${same}/${n}`, same === n && n > N / 2, bad);
  }
}
{
  // The simulate()-side hooks: inline springTrap / targeted / enter loops vs the records (what reaches addDmg, afflictions, blessings).
  let same = 0, n = 0, bad = null;
  for (let s = 1; s <= N; s++) {
    const w = genWorld(s + 200000), c = w.ctx;
    for (const mode of ENGINES) {
      const run = (useHooks) => {
        const spent = new Set(), out = [];
        const spring = (tp, victim) => {
          if (spent.has(`trap:${tp.id}`)) return; spent.add(`trap:${tp.id}`);
          if (!useHooks) {
            if (c.blessedEvery(victim)) out.push(['bless', victim, tp.owner]);
            else if (tp.mode === 'damage') out.push(['dmg', victim, tp.owner, c.untouchable(victim, tp.owner) ? 0 : roundHalfUp10(trapDamageSum(tp.elements || [], el => c.statOf(victim, ELEMS[el]), el => c.shielded(victim, el)))]);
            else { out.push(['afflict', victim, tp.effect_id, tp.owner]); if (tp.owner === c.self) out.push(['perm', tp.effect_id]); }
            return;
          }
          H.applyHookRecords(H.effectHook('trap_spring', c, { trap: tp, victim }, mode), {
            bless: () => out.push(['bless', victim, tp.owner]), damage: (x) => out.push(['dmg', victim, tp.owner, x.amount]),
            afflict: (x) => out.push(['afflict', x.on, x.effect_id, x.by]), perm_add: (x) => out.push(['perm', x.id]) });
        };
        for (const who of w.ids) {
          const t = w.args.trap_enter;
          const laid = useHooks ? H.effectHook('trap_enter', c, { who, q: t.q, r: t.r }, mode)
            : c.traps().filter(tp => tp.trigger === 'enter' && tp.q === t.q && tp.r === t.r && tp.owner !== who && c.enemyOf(tp.owner, who) && !c.trapGone(tp.id) && !spent.has(`trap:${tp.id}`) && !c.trapSpent(tp.id));
          for (const tp of laid) spring(tp, who);
        }
        if (useHooks) H.applyHookRecords(H.effectHook('trap_targeted', c, {}, mode), { spring: (x) => spring(x.trap, x.victim) });
        else for (const r of c.reveals()) {
          const tgt = r.target?.kind === 'character' ? r.target.ref : null;
          if (!tgt || tgt === r.actor || c.lifeOf(r.actor) <= 0 || !c.enemyOf(r.actor, tgt)) continue;
          const ov = c.view(tgt); if (!ov) continue;
          for (const tp of c.traps()) if (tp.trigger === 'targeted' && tp.owner === tgt && tp.q === ov.tile_q && tp.r === ov.tile_r && !c.trapGone(tp.id)) spring(tp, r.actor);
        }
        return J(out);
      };
      n++; const x = run(false), y = run(true); if (x === y) same++; else bad ||= `seed ${s} ${mode}\n  inline ${x}\n  hooks  ${y}`;
    }
  }
  ok(`simulate traps (enter + targeted + spring): inline = hooks ${same}/${n}`, same === n, bad);
}
{
  // channel_pass: the peer.mjs channel loop (verbatim but for the globals: view -> ctx, log -> logs, resolveEffect -> ticks)
  // vs the records applied with the handlers _mv_peer_hunks.py installs (kept / break / contact / tick).
  const inlinePass = (c, { turn, action, round }) => {
    const channelsBroken = [], logs = [], ticks = [];
    const channelBreaksFor = (ownerId, costElem, effectId) => {
      const res = channelBreaks(c.reveal(ownerId), costElem, (code) => !!c.classEmits(ownerId, code));
      if (res.kept) logs.push(`channel kept: ${ownerId.slice(0, 14)} - ${effectId || 'channel'} goes on (t${turn} a${action})`);
      return res.breaks;
    };
    for (const id of [...c.ids()].sort()) {
      const v = c.view(id);
      if (!v || !Number.isInteger(v.tile_q) || c.lifeOf(id) <= 0) continue;
      for (const ch of c.channelsOf(id)) {
        const sameAction = (ch.startedTurn === turn && ch.startedAction === action);
        const cost = ch.elements?.[0] || null;
        if (ch.stop === 'never') { if (!c.hasPerm(id, ch.holder || 'effect_blessing_curse')) continue; }
        else if (channelBreaksFor(id, cost, ch.effect_id)) { channelsBroken.push({ owner: id, effect_id: ch.effect_id }); continue; }
        else if ((ch.stop === 'contact' || ch.effect_id === 'effect_awake') && [...c.ids()].some(o => o !== id && c.lifeOf(o) > 0 && c.enemyOf(id, o) && c.distBetween(id, o) <= 1)) {
          channelsBroken.push({ owner: id, effect_id: ch.effect_id, why: 'contact with an enemy' });
          logs.push(`awake: ${id.slice(0, 14)}'s ${ch.effect_id} channel ends - contact with an enemy`);
          continue;
        }
        if (sameAction) continue;
        const tickCast = {
          actor: id, effect_id: ch.effect_id, elements: ch.elements, salt: `${ch.salt || ''}:tick:${turn}:${round}`,
          target: ch.target ? { kind: 'character', ref: ch.target } : null,
          is_instant: true, every: false, aura: false,
          step: ch.elements.length, of: ch.elements.length, kept: null, summon: null,
          _channel_tick: true,
        };
        ticks.push([id, ch.effect_id, ch.target, tickCast]);
      }
    }
    return J([channelsBroken, logs, ticks]);
  };
  const recordsPass = (c, a, mode) => {
    const channelsBroken = [], logs = [], ticks = [];
    H.applyHookRecords(H.effectHook('channel_pass', c, a, mode), {
      kept: (x) => logs.push(`channel kept: ${x.owner.slice(0, 14)} - ${x.effect_id || 'channel'} goes on (t${a.turn} a${a.action})`),
      break: (x) => { channelsBroken.push({ owner: x.owner, effect_id: x.effect_id }); },
      contact: (x) => {
        channelsBroken.push({ owner: x.owner, effect_id: x.effect_id, why: 'contact with an enemy' });
        logs.push(`awake: ${x.owner.slice(0, 14)}'s ${x.effect_id} channel ends - contact with an enemy`);
      },
      tick: (x) => { ticks.push([x.owner, x.effect_id, x.target, x.cast]); },
    });
    return J([channelsBroken, logs, ticks]);
  };
  for (const mode of ENGINES) {
    let same = 0, n = 0, contacts = 0, bad = null;
    for (let s = 1; s <= N; s++) {
      const w = genWorld(s + 500000), a = w.args.channel_pass;
      const x = inlinePass(w.ctx, a), y = recordsPass(w.ctx, a, mode);
      n++; if (x === y) same++; else bad ||= `seed ${s}\n  inline  ${x.slice(0, 600)}\n  records ${y.slice(0, 600)}`;
      if (x.includes('contact with an enemy')) contacts++;
    }
    ok(`channel_pass ${mode}: inline (with the Awake contact rule) = records ${same}/${n}, ${contacts} worlds with a contact`, same === n && contacts > 0, bad);
  }
}
// The enter-trap inline filter reads spentIds (traps sprung earlier this action); the hook reads ctx.trapSpent — peer.mjs
// gives it `(id) => spentIds.has('trap:' + id)`, so a trap sprung by an earlier mover is skipped either way (above: `spent`
// is folded in by the fixture only through spring(), the same dedup the peer has).

// ---- 5. failures, shadow -------------------------------------------------------------------------------------------
console.log('-- 5. failures and shadow');
{
  const bad = new Map([['trap_lay', { logic: [{ obj: { op: 'fly' } }], subs: new Map(), tables: {} }]]);
  const w = genWorld(5);
  let threw = null;
  try { H.runHookData('trap_lay', w.ctx, w.args.trap_lay, bad.get('trap_lay')); } catch (e) { threw = e; }
  ok('a data program returning an unknown record op fails hookResultOk', threw === null && !H.hookResultOk('trap_lay', [{ op: 'fly' }]));
  ok('neutral values: [] for records, {op:keep} for summon_plan', J(H.neutralOfHook('trap_lay')) === '[]' && J(H.neutralOfHook('summon_plan')) === J({ op: 'keep' }));
  const loop = { logic: { reduce: [{ range: [0, 250] }, { reduce: [{ range: [0, 250] }, { '+': [{ var: 'acc' }, 1] }, { var: 'acc' }] }, 0] }, subs: new Map(), tables: {} };
  let lim = null; try { H.runHookData('trap_lay', w.ctx, {}, loop); } catch (e) { lim = e; }
  ok('the op budget stops a runaway program (EffectEngineLimit)', lim && /budget|limit/i.test(lim.message), lim?.message);
  const before = H.effectHookStats.mismatches;
  for (let s = 1; s <= 200; s++) { const w2 = genWorld(s + 300000); for (const name of H.EFFECT_HOOK_NAMES) H.effectHook(name, w2.ctx, w2.args[name], 'shadow'); }
  ok(`effectHook shadow mode: ${H.effectHookStats.compared} compared, ${H.effectHookStats.mismatches - before} mismatches`, H.effectHookStats.mismatches === before && H.effectHookStats.compared >= 200 * H.EFFECT_HOOK_NAMES.length);
  ok('applyHookRecords: unknown ops are skipped and counted', (() => { const u = H.effectHookStats.unhandled; const seen = []; H.applyHookRecords([{ op: 'a' }, { op: 'zz' }], { a: () => seen.push(1) }); return seen.length === 1 && H.effectHookStats.unhandled === u + 1; })());
}

console.log(fails ? `\n${fails} FAILED (${oks} ok)` : `\nall effect-hooks checks passed (${oks} ok)`);
process.exit(fails ? 1 : 0);
