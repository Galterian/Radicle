// Seeded random worlds + hook arguments for the chaosD6-Classes checks (C1 tools/classes-check.mjs, C2
// tools/class-engine-check.mjs). A world = a resolver view (Map id → snapshot) and the clCtx classes.mjs hooks read
// (classes.mjs header). Deterministic per seed (mulberry32), no I/O beyond reading data/*.json once.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
      reanimated_csv: R.p(0.2) ? [R.pick(ids), R.pick(ids)].join(',') : '',
      tile_tokens_json: stones.length ? JSON.stringify(stones) : R.pick(['', '[]', 'null', '{"x":1}', 'not json']),
      permanents_csv: [...perms].sort().join(','),
      class_id: cls,
      stats: Object.fromEntries(STATS.map(s => [s, R.int(22)])),
    };
    if (v.monster_state === undefined) delete v.monster_state;
    if (creature && parseInt(sha256Hex(`${seed}:${id}`).slice(0, 2), 16) < 64) v.raised_by = 'class_necromancer';   // a reanimated unit (no R draw: other fixtures unchanged)
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
    case 'progress': { const cols = STATS.filter(() => R.p(0.6)); return { args: { state: { down: STATS.filter(() => R.p(0.3)), archived: R.p(0.3), tapped: R.p(0.4), progress: R.p(0.5) ? { mode: R.pick(['recast', 'untap']), done: STATS.filter(() => R.p(0.5)) } : null },
      cols: cols.length ? cols : ['will'], co: { kind: R.pick(['colour', 'class_destroyed', 'recast', 'untap', 'other']), stat: R.pick(STATS) } } }; }
    case 'life_points': return { args: { dmg: R.int(4), illusion: R.int(2), armor: R.int(2), chaseBonus: R.int(2) } };
    case 'stance': return { args: { code: R.pick([...CODES, 'BT']) } };
    case 'stance_target': return { args: { cands: R.p(0.15) ? [] : ids.filter(() => R.p(0.6)).map(id => ({ id, cost: R.int(2), lands: R.int(2), life: R.int(4) })) } };
    case 'emits': return { args: { code: R.pick(CODES), site: R.pick(['plan', 'destroy', 'manip', 'badge']) } };
    case 'plan_emits': return { args: { held: R.p(0.8), archived: R.p(0.2), usedTurn: R.p(0.4) ? ctx.turn : ctx.turn - 1, turn: ctx.turn, options: R.p(0.2), code: R.pick(CODES), queued: R.p(0.7) } };
    case 'attack_out': return { args: { attacker: someId(), dmg: R.int(4), scored: ids.filter(() => R.p(0.4)) } };
    case 'lifesteal': return { args: { attacker: R.p(0.5) ? ctx.self : someId(), amount: R.int(4) } };
    case 'lifesteal_apply': { const lifeMax = 1 + R.int(6); return { args: { amount: R.int(4), life: R.int(lifeMax + 1), lifeMax, held: R.p(0.8) } }; }
    case 'pre_cast': return { args: { actor: someId(), elements: R.p(0.1) ? [] : ELEMS.filter(() => R.p(0.3)).concat(R.p(0.1) ? ['elem_bogus'] : []), salt: R.p(0.9) ? `s${R.int(1e6)}` : undefined } };
    case 'ability': {
      const actor = R.p(0.9) ? R.pick(ids) : 'peer:nobody';
      const kind = R.pick(['character', 'character', 'tile', null]);
      const v = view.get(actor);
      const target = kind === 'character' ? { kind, ref: R.pick(ids) } : kind === 'tile' ? { kind, ref: R.p(0.8) && v ? { q: (v.tile_q ?? 0) + R.int(3) - 1, r: (v.tile_r ?? 0) + R.int(3) - 1 } : R.p(0.5) ? { q: 'x', r: 1 } : null } : null;
      const eff = R.pick(LIBRARY);
      const attach = R.p(0.7) ? { card_id: R.p(0.8) ? `c${R.int(99)}` : null, kind: 'effect', name: R.p(0.7) ? 'Card' : '', effect_id: R.p(0.9) ? eff.effect_id : null, skill_id: null, elements: R.p(0.85) ? [...eff.elements] : R.p(0.5) ? [] : 'x' } : null;
      return { args: { actor, ab: { id: classId, target, attach, stat: R.p(0.8) ? R.pick(STATS) : 'luck' }, salt: R.p(0.9) ? `s${R.int(1e6)}` : undefined }, ctx: R.p(0.4) ? { ...ctx, self: actor } : ctx };
    }
    case 'transmute': {
      const id = R.pick(ids);
      const outcomes = Array.from({ length: R.int(5) }, () => { const actor = R.pick(ids); return { actor, status: R.pick(['done', 'done', 'casting', 'fizzled']),
        statTokens: Array.from({ length: R.int(3) }, (_, k) => ({ id: `t${k}`, on: R.p(0.7) ? actor : R.pick(ids), elem: R.pick(ELEMS), value: R.int(5) - 1, effect_id: 'effect_x' })),
        heals: Array.from({ length: R.int(3) }, () => ({ on: R.p(0.7) ? actor : R.pick(ids), amount: 1 + R.int(2), by: actor })) }; });
      return { args: { id, outcomes }, ctx: R.p(0.4) ? { ...ctx, self: id } : ctx };
    }
    case 'destroy_result': return { args: { d: { actor: someId(), result: R.pick(['destroyed', 'destroyed', 'retry', 'too weak', 'banked']), phylactery: R.p(0.2), tok: R.p(0.6) ? { id: 't', value: 3 } : null, kind: R.pick(['stat', 'tile', 'perm']) } } };
    case 'end_turn': { const lifeMax = 1 + R.int(6); return { args: { held: R.p(0.8), moved: R.p(0.5), life: R.int(lifeMax + 1), lifeMax } }; }
    case 'step': return { args: { threatReady: R.p(0.6), ring: ids.filter(() => R.p(0.3)), trap: R.p(0.6), wtrap: R.p(0.4), building: R.p(0.4), trapLeft: R.int(3) - (R.p(0.2) ? 1 : 0) } };
    case 'dungeon_step': return { args: { trap: R.p(0.7), trapLeft: R.int(3) } };
    case 'combat_in': return { args: { list: R.p(0.2) ? undefined : Array.from({ length: R.int(4) }, () => (R.p(0.1) ? null : { source: R.pick(['action', 'effect', 'trap']), amount: R.int(3), ...(R.p(0.3) ? { bonus: R.p(0.5) } : {}) })) } };
    case 'pick_target': return { args: { seed: `s${R.int(1e6)}:manipulator:${ctx.turn}.${R.int(3)}`, cands: ids.filter(() => R.p(0.5)) } };
    case 'chase_step': return { args: { state: R.p(0.1) ? undefined : { chasers: ids.filter(() => R.p(0.3)), bonus: R.pick([0, 1, 2, '1', undefined, null]) }, chasing: ids.filter(() => R.p(0.4)).concat(R.p(0.2) ? [R.pick(ids)] : []) } };
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
