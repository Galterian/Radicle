// Seeded random worlds + hook arguments for the chaosD6-Classes checks (C1 tools/classes-check.mjs, C2
// tools/class-engine-check.mjs). A world = a resolver view (Map id → snapshot) and the clCtx classes.mjs hooks read
// (classes.mjs header). Deterministic per seed (mulberry32), no I/O beyond reading data/*.json once.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classStateJson } from '../class-state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '..', '..', 'data');
export const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const pickActive = (e) => (e.versions || []).filter(v => v.status !== 'rejected' && v.status !== 'superseded').sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0] || null;
const readCollection = (name) => {
  const j = JSON.parse(fs.readFileSync(path.join(DATA, `${name}.json`), 'utf8'));
  const out = {};
  for (const e of j.entries) { const v = pickActive(e); if (v) out[e.id] = { id: e.id, name: e.name, version: v.version, data: v.data }; }
  return out;
};
export const CLASSES = readCollection('classes');
export const SKILLS = readCollection('skills');
export const EFFECTS = readCollection('effects');
export const ELEM_TO_STAT = { elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' };
export const ELEMS = Object.keys(ELEM_TO_STAT);
export const STATS = ['vitality', 'world', 'matter', 'will'];
export const CODES = ['A', 'B', 'M', 'P', 'EM', 'EP'];
export const LIBRARY = Object.keys(EFFECTS).filter(id => (EFFECTS[id].data?.element_cost || []).length).sort().slice(0, 40).map(id => ({ effect_id: id, elements: [...EFFECTS[id].data.element_cost] }));

export function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function rngOf(seed) { const f = mulberry32(seed * 2654435761 >>> 0); return { f, int: (n) => Math.floor(f() * n), pick: (a) => a[Math.floor(f() * a.length)], p: (x) => f() < x }; }
export function sideOf(alliance) {   // = peer.mjs sideOf
  if (alliance === 'player' || alliance === 'npc_a') return 'A';
  if (alliance === 'npc_b') return 'B';
  if (alliance === 'player_c' || alliance === 'npc_c') return 'C';
  return 'A';
}
export const hexDistance = (a, b) => (Math.abs(a.tile_q - b.tile_q) + Math.abs(a.tile_r - b.tile_r) + Math.abs(a.tile_q + a.tile_r - b.tile_q - b.tile_r)) / 2;   // = peer.mjs hexDistance

// Mutated class data (configs with odd knobs, missing keys) — the hooks must read it exactly as peer.mjs does.
function mutateData(R, d) {
  const m = JSON.parse(JSON.stringify(d));
  const odd = () => R.pick([0, 1, 2, 3, 5, 7, 12, -1, 2.5, '3', null, undefined, true, [1, 2], { n: 2 }]);
  for (const k of ['range', 'contact', 'near', 'place_range', 'disable_range', 'trap_dodges_per_turn', 'threat_dodges_per_turn', 'threat_radius', 'lure_range', 'publish_range']) if (R.p(0.3)) m[k] = odd();
  if (R.p(0.2)) m.passive = R.pick([true, false, null, undefined, 0, 1]);
  if (R.p(0.15)) m.ability_kind = R.pick(['tap', 'once_per_round', 'static', 'passive', '', undefined]);
  if (R.p(0.2)) m.chase_bonus = R.pick([undefined, null, {}, { life: odd(), max: odd() }, { life: 2, max: 3 }]);
  if (R.p(0.2)) m.hand_discard = R.pick([undefined, null, { n: odd() }, { n: 5 }]);
  if (R.p(0.2)) m.hand_reveal = R.pick([undefined, null, { n: 'all' }, { n: 2 }]);
  if (R.p(0.2)) m.building = R.pick([undefined, null, 'x', [], {}, { label: 'Altar', power: 'stance' }, { label: '', power: 7 }]);
  if (R.p(0.2)) m.distance = R.pick([undefined, [20, 30], [5, 3], [0, 4], [3, 9], [1], 'x', [2, 2.5]]);
  if (R.p(0.2)) m.vision = R.pick([undefined, null, {}, { radius: odd() }, { radius: 4 }]);
  if (R.p(0.2)) m.colors = R.pick([[], ['elem_fire'], ['elem_fire', 'elem_air', 'elem_souls'], ['elem_bogus', 'elem_will', 'elem_harmony'], [...ELEMS]]);
  if (R.p(0.2)) m.destroy_reanimated = R.pick([undefined, null, {}, { elements: [] }, { elements: ['elem_harmony'], die: 5 }, { elements: ['elem_fire', 'elem_harmony', 'elem_concentration'] }, { die: '6' }, { die: 4 }]);   // ruling 2026-11-16
  // CR 2026-11-17/18 knobs (Assassin, Noble, Guardian, Manipulator, Rogue)
  if (R.p(0.2)) m.vs_hurt_only = R.pick([true, false, undefined, 1, 'true']);
  if (R.p(0.2)) m.lifesteal = R.pick([undefined, null, [], 'attack', {}, { from: 'attack' }, { max_per_action: 1 }, { from: 'attack', max_per_action: 2 }, { max_per_action: -1 }, { max_per_action: 1.5 }, { from: 'any', max_per_action: 0 }]);
  if (R.p(0.2)) m.still_actions = R.pick([undefined, null, [], [3], [2, 3], [1, 2, 3], 'x', [0]]);
  if (R.p(0.2)) m.trigger = R.pick([undefined, null, 'attack', 'combat', 'Attack']);
  if (R.p(0.2)) m.shared_charge = R.pick([undefined, null, true, false, 1, 'true']);
  // CP 2026-11-19 knobs (Druid chain, Healer gates, Witch own discard, Priest Shrine heal, Avenger max-only bonus)
  if (R.p(0.2)) m.chain_stones = R.pick([undefined, null, true, false, 1, 'true']);
  if (R.p(0.2)) m.unmoved_only = R.pick([undefined, null, true, false, 1]);
  if (R.p(0.2)) m.ally_required = R.pick([undefined, null, true, false, 'yes']);
  if (R.p(0.2)) m.self_discard = R.pick([undefined, null, 0, 1, 2, -1, 1.5, '1']);
  if (R.p(0.2)) m.chase_bonus = R.pick([{ life: 1, max: 1, max_only: true }, { life: 2, max: 3, max_only: false }, { max_only: true }, { life: 1, max: 1, max_only: 'yes' }]);
  if (R.p(0.2)) m.building = R.pick([{ label: 'Shrine', power: 'mend', heal: 2 }, { heal: 0 }, { power: 'mend', heal: 'x' }, { heal: 3 }]);
  // CP2 2026-11-19 knobs (Druid fail spends the tap, Healer longer untap)
  if (R.p(0.2)) m.fail_spends = R.pick([undefined, null, true, false, 1, 'true']);
  if (R.p(0.25)) m.untap_emissions = R.pick([undefined, null, 0, 1, 2, 3, 4, 5, 6, 7, -2, 1.5, '5']);
  for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
  return m;
}

// genWorld(seed, {mutate}) → { R, ids, view: Map, ctx }
export function genWorld(seed, { mutate = 0.25 } = {}) {
  const R = rngOf(seed);
  const n = 2 + R.int(7);
  const ids = Array.from({ length: n }, (_, i) => `peer:${'abcdefghij'[i]}${R.int(90) + 10}`);
  const classIds = Object.keys(CLASSES);
  const view = new Map();
  const cx = R.int(5) - 2, cy = R.int(5) - 2;
  for (const id of ids) {
    if (R.p(0.04)) continue;   // a unit without a snapshot
    const tiled = !R.p(0.04);
    const tq = cx + R.int(7) - 3, tr = cy + R.int(7) - 3;
    const cls = R.p(0.85) ? R.pick(classIds) : '';
    const perms = new Set();
    if (cls && R.p(0.85)) perms.add(cls);
    for (const p of ['effect_invisibility', 'class_noble', 'class_assassin', 'skill_taunt']) if (R.p(0.1)) perms.add(p);
    const creature = R.p(0.35);
    const stones = [];
    let raisedL = [];
    if (R.p(0.3)) for (let k = R.int(4); k-- > 0;) stones.push({ id: `${id}#d${k}`, kind: R.p(0.85) ? 'bonus' : 'shield', druid: R.p(0.85), elem: R.pick(ELEMS), value: 1 + R.int(6), q: R.p(0.8) ? tq : tq + 1, r: tr });
    const v = {
      peer_id: id, name: R.p(0.85) ? `Unit ${id.slice(5)}` : '',
      ...(tiled ? { tile_q: tq, tile_r: tr } : {}),
      life: R.p(0.2) ? 0 : 1 + R.int(5),
      alliance: R.pick(['player', 'npc_a', 'npc_b', 'player_c', 'npc_b']),
      armor: R.p(0.3) ? 1 : 0,
      creature_id: creature ? R.pick(['mon_wolf', 'mon_goblin', 'mon_bat', 'mon_elemental_fire']) : '',
      character_id: creature ? '' : 'char_x',
      monster_state: creature ? R.pick(['sleeping', 'awake', '', undefined]) : '',
      owner_peer_id: creature && R.p(0.3) ? R.pick(ids) : '',
      reanimated_csv: (raisedL = R.p(0.2) ? [R.pick(ids), R.pick(ids)] : []).join(','),
      tile_tokens_json: stones.length ? JSON.stringify(stones) : R.pick(['', '[]', 'null', '{"x":1}', 'not json']),
      permanents_csv: [...perms].sort().join(','),
      class_id: cls,
      stats: Object.fromEntries(STATS.map(s => [s, R.int(22)])),
    };
    if (v.monster_state === undefined) delete v.monster_state;
    v.class_state_json = classStateJson(raisedL.length ? { class_necromancer: { raised: raisedL } } : {});   // phase 2: the same list in the blob
    if (creature && parseInt(sha256Hex(`${seed}:${id}`).slice(0, 2), 16) < 64) v.raised_by = 'class_necromancer';   // a reanimated unit (no R draw: other fixtures unchanged)
    // CR 2026-11-17 (Assassin vs an enemy below full life): life_max = life + 0..2, sometimes missing (no R draw)
    { const h = parseInt(sha256Hex(`${seed}:${id}:life_max`).slice(0, 2), 16); if (h >= 24) v.life_max = v.life + (h % 3); }
    view.set(id, v);
  }
  const self = R.p(0.85) ? R.pick(ids) : 'peer:zz99';
  const dataOf = new Map();
  for (const id of classIds) dataOf.set(id, R.p(mutate) ? mutateData(R, CLASSES[id].data) : CLASSES[id].data);
  const ctx = {
    self, label: `T${seed % 7}`,
    view: (id) => view.get(id),
    viewIds: () => [...view.keys()],
    viewValues: () => [...view.values()],
    lifeOf: (id) => view.get(id)?.life ?? 0,
    dist: (a, b) => { const pa = view.get(a), pb = view.get(b); return pa && pb ? hexDistance(pa, pb) : Infinity; },
    enemyOf: (a, b) => { const pa = view.get(a), pb = view.get(b); return !!pa && !!pb && sideOf(pa.alliance) !== sideOf(pb.alliance); },
    hasPerm: (id, p) => String(view.get(id)?.permanents_csv || '').split(',').includes(p),
    statOf: (id, st) => view.get(id)?.stats?.[st] ?? 0,
    sideOf,
    classData: (id) => dataOf.get(id),
    skillAction: (sk) => SKILLS[sk]?.data?.action_type,
    library: () => LIBRARY,
    elemStat: (el) => ELEM_TO_STAT[el],
    turn: 3 + R.int(20), action: 10 + R.int(60),
    sha: sha256Hex,
  };
  return { R, ids, view, ctx, dataOf };
}

// Random arguments for one hook of one class in a world. Returns { args, ctx } (ctx may be adjusted, e.g. the
// actor made self). Values sweep the edges the peer code branches on.
export function argsFor(hook, classId, W, R) {
  const { ids, view, ctx } = W;
  const someId = () => (R.p(0.9) ? R.pick(ids) : 'peer:nobody');
  const cs = () => ({ class_id: R.p(0.8) ? classId : R.p(0.5) ? '' : R.pick(Object.keys(CLASSES)), down: STATS.filter(() => R.p(0.3)), archived: R.p(0.3), tapped: R.p(0.4),
    progress: R.p(0.4) ? { mode: R.pick(['recast', 'untap']), done: STATS.filter(() => R.p(0.4)) } : null, usedTurn: R.p(0.5) ? ctx.turn : ctx.turn - 1 - R.int(3) });
  const colsObj = () => { const o = {}; for (const st of STATS) if (R.p(0.6)) o[st] = ELEMS.filter(e => ELEM_TO_STAT[e] === st && R.p(0.6)); return o; };
  const pb = () => { const fail = R.p(0.3); return { fail, dice: [1 + R.int(6)], value: fail ? 0 : 1 + R.int(6) }; };
  switch (hook) {
    case 'colours': case 'kind': case 'config': case 'local': return { args: {} };
    case 'ready': return { args: { cs: cs(), held: R.p(0.8), turn: ctx.turn } };
    case 'strike': { const c = cs(); const cols = colsObj(); const stat = R.p(0.9) ? R.pick(STATS) : 'luck'; return { args: { cs: c, cols, stat, elem: R.p(0.5) ? null : R.pick(ELEMS), enemy: R.p(0.75), pb: pb() } }; }
    case 'reanimated_strike': { const pool = ['elem_harmony', 'elem_concentration', 'elem_harmony', 'elem_concentration', ...ELEMS]; return { args: { down: [...new Set(Array.from({ length: R.int(3) }, () => R.pick(pool)))], stat: R.p(0.7) ? 'will' : R.p(0.8) ? R.pick(STATS) : 'luck', elem: R.p(0.5) ? null : R.pick(pool), enemy: R.p(0.8), pb: pb() } }; }
    case 'restore': return { args: { cs: cs(), cols: colsObj(), stat: R.pick(STATS), kind: R.pick(['recast', 'untap']) } };
    case 'progress': { const cols = STATS.filter(() => R.p(0.6)); return { args: { state: { down: STATS.filter(() => R.p(0.3)), archived: R.p(0.3), tapped: R.p(0.4), progress: R.p(0.5) ? { mode: R.pick(['recast', 'untap']), done: STATS.filter(() => R.p(0.5)), ...(R.p(0.5) ? { n: R.pick([0, 1, 2, 3, 4, 6, -1, 2.5, 'x', null]) } : {}) } : null },
      cols: cols.length ? cols : ['will'], co: { kind: R.pick(['colour', 'class_destroyed', 'recast', 'untap', 'other']), stat: R.pick(STATS) } } }; }
    case 'life_points': return { args: { dmg: R.int(4), illusion: R.int(2), armor: R.int(2), chaseBonus: R.int(2) } };
    case 'stance': return { args: { code: R.pick([...CODES, 'BT']) } };
    case 'stance_target': return { args: { cands: R.p(0.15) ? [] : ids.filter(() => R.p(0.6)).map(id => ({ id, cost: R.int(2), lands: R.int(2), life: R.int(4) })) } };
    case 'emits': return { args: { code: R.pick(CODES), site: R.pick(['plan', 'destroy', 'manip', 'badge']) } };
    case 'plan_emits': return { args: { held: R.p(0.8), archived: R.p(0.2), usedTurn: R.p(0.4) ? ctx.turn : ctx.turn - 1, turn: ctx.turn, options: R.p(0.2), code: R.pick(CODES), queued: R.p(0.7) } };
    case 'attack_out': return { args: { attacker: someId(), dmg: R.int(4), scored: ids.filter(() => R.p(0.4)), defender: R.p(0.9) ? someId() : undefined } };   // CR: + defender
    case 'lifesteal': return { args: { attacker: R.p(0.5) ? ctx.self : someId(), amount: R.int(4), source: R.pick(['action', 'action', 'effect', 'trap']), why: R.pick(['Attack', 'Attack', 'Block', 'P', '', undefined]) } };   // CR: + source / why
    case 'lifesteal_apply': { const lifeMax = 1 + R.int(6); return { args: { amount: R.int(4), life: R.int(lifeMax + 1), lifeMax, held: R.p(0.8) } }; }
    case 'pre_cast': return { args: { actor: someId(), elements: R.p(0.1) ? [] : ELEMS.filter(() => R.p(0.3)).concat(R.p(0.1) ? ['elem_bogus'] : []), salt: R.p(0.9) ? `s${R.int(1e6)}` : undefined } };
    case 'ability': {
      const actor = R.p(0.9) ? R.pick(ids) : 'peer:nobody';
      const kind = R.pick(['character', 'character', 'tile', null]);
      const v = view.get(actor);
      const target = kind === 'character' ? { kind, ref: R.pick(ids) } : kind === 'tile' ? { kind, ref: R.p(0.8) && v ? { q: (v.tile_q ?? 0) + R.int(3) - 1, r: (v.tile_r ?? 0) + R.int(3) - 1 } : R.p(0.5) ? { q: 'x', r: 1 } : null } : null;
      const eff = R.pick(LIBRARY);
      const attach = R.p(0.7) ? { card_id: R.p(0.8) ? `c${R.int(99)}` : null, kind: 'effect', name: R.p(0.7) ? 'Card' : '', effect_id: R.p(0.9) ? eff.effect_id : null, skill_id: null, elements: R.p(0.85) ? [...eff.elements] : R.p(0.5) ? [] : 'x' } : null;
      return { args: { actor, ab: { id: classId, target, attach, stat: R.p(0.8) ? R.pick(STATS) : 'luck' }, salt: R.p(0.9) ? `s${R.int(1e6)}` : undefined, moved: R.p(0.3) }, ctx: R.p(0.4) ? { ...ctx, self: actor } : ctx };   // CP 2026-11-19: + moved (peer.mjs moveCodeOf)
    }
    case 'transmute': {
      const id = R.pick(ids);
      const outcomes = Array.from({ length: R.int(5) }, () => { const actor = R.pick(ids); return { actor, status: R.pick(['done', 'done', 'casting', 'fizzled']),
        statTokens: Array.from({ length: R.int(3) }, (_, k) => ({ id: `t${k}`, on: R.p(0.7) ? actor : R.pick(ids), elem: R.pick(ELEMS), value: R.int(5) - 1, effect_id: 'effect_x' })),
        heals: Array.from({ length: R.int(3) }, () => ({ on: R.p(0.7) ? actor : R.pick(ids), amount: 1 + R.int(2), by: actor })) }; });
      return { args: { id, outcomes }, ctx: R.p(0.4) ? { ...ctx, self: id } : ctx };
    }
    case 'destroy_result': return { args: { d: { actor: someId(), result: R.pick(['destroyed', 'destroyed', 'retry', 'too weak', 'banked']), phylactery: R.p(0.2), tok: R.p(0.6) ? { id: 't', value: 3 } : null, kind: R.pick(['stat', 'tile', 'perm']) } } };
    case 'end_turn': { const lifeMax = 1 + R.int(6); const mr = R.p(0.15) ? undefined : [0, 1, 2].filter(() => R.p(0.3)); return { args: { held: R.p(0.8), moved: mr ? mr.length > 0 : R.p(0.5), life: R.int(lifeMax + 1), lifeMax, ...(mr ? { movedRounds: mr } : {}) } }; }   // CR: + movedRounds
    case 'step': return { args: { threatReady: R.p(0.6), ring: ids.filter(() => R.p(0.3)), trap: R.p(0.6), wtrap: R.p(0.4), building: R.p(0.4), trapLeft: R.int(3) - (R.p(0.2) ? 1 : 0) } };
    case 'dungeon_step': return { args: { trap: R.p(0.7), trapLeft: R.int(3) } };
    case 'combat_in': return { args: { list: R.p(0.2) ? undefined : Array.from({ length: R.int(4) }, () => (R.p(0.1) ? null : { source: R.pick(['action', 'effect', 'trap']), amount: R.int(3), ...(R.p(0.3) ? { bonus: R.p(0.5) } : {}), why: R.pick(['Attack', 'Attack', 'Block', 'P']) })) } };   // CR: + why
    case 'pick_target': return { args: { seed: `s${R.int(1e6)}:manipulator:${ctx.turn}.${R.int(3)}`, cands: ids.filter(() => R.p(0.5)) } };
    case 'chase_step': return { args: { state: R.p(0.1) ? undefined : { chasers: ids.filter(() => R.p(0.3)), bonus: R.pick([0, 1, 2, '1', undefined, null]) }, chasing: ids.filter(() => R.p(0.4)).concat(R.p(0.2) ? [R.pick(ids)] : []) } };
    case 'blocked': return { args: { fallen_near: R.p(0.5), archive_creature: R.p(0.5) } };
    case 'contact': return { args: { foes: R.p(0.1) ? undefined : ids.filter(() => R.p(0.5)).map(id => (R.p(0.05) ? null : { id, fought: R.p(0.3) })) } };
    case 'share_skills': {
      const sk = Object.keys(SKILLS);
      const actor = R.pick(ids);
      return { args: { actor, skills: [...sk.filter(() => R.p(0.25)), ...(R.p(0.1) ? ['skill_bogus'] : [])],
        adj: ids.filter(o => o !== actor && R.p(0.5)).sort().map(id => ({ id, codes: R.p(0.2) ? [R.pick(CODES), R.pick(CODES)] : [R.pick(CODES)], skills: sk.filter(() => R.p(0.15)) })) }, ctx: R.p(0.4) ? { ...ctx, self: actor } : ctx };
    }
    default: throw new Error(`argsFor: no generator for ${hook}`);
  }
}

// CL2 (2026-11-17, validator 1.1.0 weight answer 5): fixtures that VARY the odds only a swarm can measure (the
// calibration's swarm_placeholders: adjacent_allies, p_ally_cast, p_trap_step, p_destroy_near, p_archived, …).
// withOdds(W, me, odds, seed) → W + { odds }: when odds.adjacent_allies is a number, the units within 1 hex of `me`
// are rearranged so that floor(x) (+1 with p = the fraction) living allies stand next to it (allies first, then far
// enemies turned allies); adjacent enemies and corpses stay where they are. The
// odds.p_fallen_near places (or removes) a fallen allied creature next to `me`. The
// other odds ride along in W.odds for the measuring code (tools/out/_c3_balance.mjs) to draw its arguments with. A
// separate rng (seed ^ 0x5eed1) is used, so genWorld and every existing fixture stay byte-identical.
const NEIGHBOURS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export function withOdds(W, me, odds = {}, seed = 0) {
  const R2 = rngOf(((seed ^ 0x5eed1) >>> 0) || 1);
  const v0 = W.view.get(me);
  const x = odds.adjacent_allies;
  if (Number.isFinite(x) && x >= 0 && v0 && Number.isInteger(v0.tile_q)) {
    const others = W.ids.filter(o => o !== me && W.view.get(o) && Number.isInteger(W.view.get(o).tile_q)).sort();
    const living = others.filter(o => (W.view.get(o).life ?? 0) > 0);   // corpses stay where they fell (Necromancer)
    const foe = (o) => sideOf(W.view.get(o).alliance) !== sideOf(v0.alliance);
    // living allies next to me step back (enemies stay: the enemy context of the world is kept)
    for (const o of living) { const v = W.view.get(o); if (!foe(o) && hexDistance(v0, v) <= 1) { v.tile_q = v0.tile_q + 3 + R2.int(3); v.tile_r = v0.tile_r - 1 - R2.int(2); } }
    const taken = new Set(others.map(o => W.view.get(o)).filter(v => hexDistance(v0, v) <= 1).map(v => `${v.tile_q},${v.tile_r}`));
    const free = NEIGHBOURS.map(([dq, dr]) => [v0.tile_q + dq, v0.tile_r + dr]).filter(([q, r]) => !taken.has(`${q},${r}`));
    // allies first, then far enemies turned allies (an adjacent enemy is never converted)
    const pool = [...living.filter(o => !foe(o)), ...living.filter(o => foe(o) && hexDistance(v0, W.view.get(o)) > 1)];
    const want = Math.min(free.length, pool.length, Math.floor(x) + (R2.p(x % 1) ? 1 : 0));
    for (let i = 0; i < want; i++) {
      const v = W.view.get(pool[i]);
      v.alliance = v0.alliance; v.tile_q = free[i][0]; v.tile_r = free[i][1];
    }
  }
  // odds.p_fallen_near: with that p a fallen allied creature (not raised before) lies next to `me`, else none does.
  const pf = odds.p_fallen_near;
  if (Number.isFinite(pf) && v0 && Number.isInteger(v0.tile_q)) {
    const raised = new Set([...W.view.values()].flatMap(v => String(v?.reanimated_csv || '').split(',').filter(Boolean)));
    const near = (v) => Number.isInteger(v.tile_q) && hexDistance(v0, v) <= 1;
    const fallenAlly = (o) => { const v = W.view.get(o); return (v.life ?? 0) <= 0 && v.creature_id && sideOf(v.alliance) === sideOf(v0.alliance); };
    const others = W.ids.filter(o => o !== me && W.view.get(o)).sort();
    for (const o of others) { const v = W.view.get(o); if (fallenAlly(o) && near(v)) { v.tile_q = v0.tile_q + 4; v.tile_r = v0.tile_r - 2; } }
    if (R2.p(pf)) {
      const cand = others.filter(o => !raised.has(o) && !near(W.view.get(o)) && (W.view.get(o).life ?? 0) <= 0);
      const pool = cand.length ? cand : others.filter(o => !raised.has(o) && !near(W.view.get(o)));
      if (pool.length) {
        const v = W.view.get(pool[R2.int(pool.length)]);
        const [dq, dr] = NEIGHBOURS[R2.int(6)];
        Object.assign(v, { life: 0, alliance: v0.alliance, creature_id: v.creature_id || 'mon_wolf', character_id: '', tile_q: v0.tile_q + dq, tile_r: v0.tile_r + dr });
        delete v.raised_by;
      }
    }
  }
  return { ...W, odds: { ...odds } };
}
