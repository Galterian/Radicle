// Fixtures for the E2c effects (Throw / Force Pull, Metaphysics, Disruption, Mind Blast, Awake) — loaded by
// tools/effect-engine-check.mjs (section 4b). The generic check world has no map (tileTokensAt / trapsAt / obstacleAt /
// freeTilesWithin), so these effects' pull and surgery branches need their own worlds:
//   e2cCases(def, {sha, n, seed}) → [{label, ctx, cast}]   targeted fixtures + n seeded random map contexts
//   e2cBranch(id, cast, outcome)  → [branch labels]         what a (JS) outcome exercised
//   E2C_BRANCHES[id]                                        branches every run must hit
export const E2C_EFFECTS = ['effect_throw', 'effect_metaphysics', 'effect_disruption', 'effect_mind_blast', 'effect_awake'];

const ELEMS = ['elem_vitality', 'elem_souls', 'elem_time', 'elem_space', 'elem_air', 'elem_water', 'elem_earth', 'elem_fire', 'elem_concentration', 'elem_harmony'];
const ELEM_TO_STAT = { elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' };
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const hd = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((a.q + a.r) - (b.q + b.r)));
const M = (v, w, m, wi) => ({ vitality: v, world: w, matter: m, will: wi });

// A world with a map: tokens [{id, kind, elem, value, owner, item?, q, r}], traps [{id, owner, effect_id, q, r}],
// obstacles [{id, owner, q, r}]. `opts.no` drops ctx functions (['tileTokensAt', 'trapsAt', 'obstacleAt', 'freeTilesWithin']).
export function mapWorld(st, tiles, sides, map = {}, opts = {}, sha) {
  const pen = opts.pen || {}, perms = opts.perms || {};
  const tokens = map.tokens || [], traps = map.traps || [], obstacles = map.obstacles || [];
  const strip = ({ q, r, ...x }) => x;
  const unitOn = (q, r) => Object.values(tiles).some(t => t && t.q === q && t.r === r);
  const w = {
    me: Object.keys(tiles)[0],
    elemStat: el => ELEM_TO_STAT[el],
    statFor: (id, el) => Math.max(0, st[id][ELEM_TO_STAT[el]] - (pen[id]?.[el] || 0)),
    baseStat: (id, sk) => st[id][sk],
    lifeOf: id => opts.life?.[id] ?? 4,
    enemyOf: (a, b) => sides[a] !== sides[b],
    dist: (a, b) => hd(tiles[a], tiles[b]),
    tileOf: id => tiles[id],
    isFree: (q, r) => !unitOn(q, r) && !obstacles.some(o => o.q === q && o.r === r),
    neighbours: (q, r) => DIRS.map(([dq, dr]) => ({ q: q + dq, r: r + dr })),
    hasPerm: (id, p) => !!perms[id]?.includes(p),
    shieldedAgainst: (id, el) => !!opts.shield?.[id]?.includes(el),
    disabledElems: id => new Set(opts.disabled?.[id] || []),
    invisible: id => !!perms[id]?.includes('effect_invisibility'),
    peers: () => Object.keys(tiles).sort(),
    sha, actionIndex: opts.actionIndex ?? 7,
    castElemOf: () => 'elem_fire',
    threatElem: () => 'elem_fire',
    tileTokensAt: (q, r) => tokens.filter(t => t.q === q && t.r === r).map(strip),
    trapsAt: (q, r) => traps.filter(t => t.q === q && t.r === r).map(strip),
    obstacleAt: (q, r) => { const o = obstacles.find(x => x.q === q && x.r === r); return o ? strip(o) : null; },
    freeTilesWithin: (q, r, d) => {
      const outT = [];
      for (let dq = -d; dq <= d; dq++) for (let dr = Math.max(-d, -dq - d); dr <= Math.min(d, -dq + d); dr++) {
        const t = { q: q + dq, r: r + dr };
        if (w.isFree(t.q, t.r)) outT.push(t);
      }
      return outT;
    },
  };
  for (const k of opts.no || []) delete w[k];
  return w;
}

// ---------------------------------------------------------------- targeted fixtures
function targeted(id, sha) {
  const cases = [];
  const add = (label, ctx, cast) => cases.push({ label, ctx, cast });
  const tiles = { C: { q: 0, r: 0 }, E: { q: 1, r: 0 }, F: { q: 0, r: 1 }, A: { q: -1, r: 0 } };
  const far = { C: { q: 0, r: 0 }, E: { q: 5, r: 0 }, F: { q: 0, r: 5 }, A: { q: -1, r: 0 } };
  const sides = { C: 'player', E: 'npc_b', F: 'npc_b', A: 'player', B: 'player' };
  const base = { C: M(10, 12, 16, 14), E: M(10, 10, 8, 10), F: M(10, 10, 8, 10), A: M(10, 10, 8, 10), B: M(9, 9, 9, 9) };
  const W = (t, map, opts, st = base) => mapWorld(st, t, sides, map, opts, sha);
  const sacred = { id: 'f1', kind: 'bonus', elem: 'elem_souls', value: 6, owner: 'A', item: 'Sacred Land', q: 0, r: -1 };
  const poison = { id: 't9', owner: 'E', effect_id: 'effect_poison', q: 5, r: 0 };
  const els = (n) => ({ effect_throw: ['elem_air'], effect_metaphysics: ['elem_space', 'elem_earth'], effect_disruption: ['elem_souls', 'elem_harmony'], effect_mind_blast: ['elem_concentration'], effect_awake: ['elem_harmony'] })[n];
  const c0 = { actor: 'C', effect_id: id, elements: els(id), salt: 'fx', target: { kind: 'character', ref: 'E' }, is_instant: false };
  const tile = (q, r, x = {}) => ({ ...c0, target: { kind: 'tile', ref: { q, r } }, ...x });
  const salts = ['fx', 'a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7'];

  if (id === 'effect_throw') {
    const tk = (o) => ({ id: 'tk1', kind: 'bonus', elem: 'elem_fire', value: 3, owner: 'E', item: 'Sphere of Fire', q: 1, r: 0, ...o });
    for (const s of salts) {
      add(`pull ok/failed ${s}`, W(tiles, { tokens: [tk()] }), { ...c0, salt: s });
      add(`pull high token ${s}`, W(tiles, { tokens: [tk({ value: 6 })] }), { ...c0, salt: s });
      add(`pull roll fails (Matter 3) ${s}`, W(tiles, { tokens: [tk()] }, {}, { ...base, C: M(10, 10, 3, 10) }), { ...c0, salt: s });
      add(`pull no item ${s}`, W(far, { tokens: [tk({ item: undefined, q: 1, r: -1, value: 1 })] }), { ...c0, salt: s, target: null });
    }
    add('token under ally ignored → smash', W(tiles, { tokens: [tk({ id: 'tk2', q: -1, r: 0, owner: 'A' })] }), c0);
    add('own token ignored', W(tiles, { tokens: [tk({ owner: 'C' })] }), c0);
    add('fire / shield tokens ignored', W(tiles, { tokens: [tk({ kind: 'fire' }), tk({ id: 'z', kind: 'shield' })] }), c0);
    add('token on my own tile ignored', W(tiles, { tokens: [tk({ q: 0, r: 0 })] }), c0);
    add('strongest element first', W(tiles, { tokens: [tk({ id: 'a', elem: 'elem_vitality', value: 1 }), tk({ id: 'b', elem: 'elem_concentration', value: 1, q: 0, r: -1 })] }), c0);
    add('id tie-break', W(tiles, { tokens: [tk({ id: 'b', value: 1 }), tk({ id: 'a', value: 1, q: 1, r: -1 }), tk({ id: 'B', value: 1, q: 0, r: -1 })] }), c0);
    add('no tileTokensAt → smash', W(tiles, { tokens: [tk()] }, { no: ['tileTokensAt'] }), c0);
    add('no tokens → smash', W(tiles, {}), c0);
    add('alone, no tokens → fizzled', W(far, {}), { ...c0, target: null });
    add('alone, token pulled', W(far, { tokens: [tk({ q: 0, r: -1, value: 1 })] }), { ...c0, target: null });
    add('aura ∀ + token', W(far, { tokens: [tk({ q: 0, r: -1, value: 1 })] }), { ...c0, aura: true });
    add('dead ally tile not protected', W(tiles, { tokens: [tk({ q: -1, r: 0, value: 1 })] }, { life: { A: 0 } }), c0);
    add('disabled air', W(tiles, { tokens: [tk()] }, { disabled: { C: ['elem_air'] } }), c0);
  }
  if (id === 'effect_metaphysics' || id === 'effect_disruption') {
    const mk = (t, extra = {}, opts) => W(t, { tokens: [sacred], traps: [poison], ...extra }, opts);
    for (const s of salts.slice(0, 3)) {
      add(`no enemy adjacent → move ${s}`, mk(far), tile(2, 2, { salt: s }));
      add(`enemy adjacent → damage ${s}`, mk(tiles), tile(2, 2, { salt: s }));
    }
    add('character target, enemy adjacent', mk(tiles), c0);
    add('character target, alone', mk(far), c0);
    add('dest occupied', mk(far), tile(5, 0));
    add('dest holds a token', mk(far, { tokens: [sacred, { ...sacred, id: 'f2', q: 2, r: 2 }] }), tile(2, 2));
    add('dest holds an obstacle', mk(far, { obstacles: [{ id: 'o1', owner: 'E', q: 2, r: 2 }] }), tile(2, 2));
    add('dest too far', mk(far), tile(11, 0));
    add('dest = 10 away', mk(far), tile(10, 0));
    add('nothing nearby / no trap in view', W(far, {}), tile(2, 2));
    add('only an obstacle next to me', W(far, { obstacles: [{ id: 'o1', owner: 'A', q: 0, r: -1 }] }), tile(2, 2));
    add('trap next to me', W(far, { traps: [{ ...poison, q: 1, r: -1, id: 't1' }] }), tile(2, 2));
    add('trap on a free tile', W(far, { traps: [{ ...poison, q: 3, r: -2, id: 't3' }] }), tile(2, 2));
    add('trap far (12)', W(far, { traps: [{ ...poison, q: 12, r: 0, id: 't3' }] }), tile(2, 2));
    add('duplicate trap ids + sort', W({ ...far, F: { q: 5, r: 0 } }, { tokens: [{ ...sacred, id: 'b' }, { ...sacred, id: 'a', q: 1, r: -1, item: undefined }], traps: [poison, { ...poison, id: 'T', q: 0, r: -1 }, { ...poison, id: 'a', q: 3, r: 3 }] }), tile(2, 2));
    add('no freeTilesWithin', mk(far, {}, { no: ['freeTilesWithin'] }), tile(2, 2));
    add('no trapsAt → damage', mk(far, {}, { no: ['trapsAt'] }), tile(2, 2));
    add('no obstacleAt', mk(far, { obstacles: [{ id: 'o1', owner: 'E', q: 2, r: 2 }] }, { no: ['obstacleAt'] }), tile(2, 2));
    add('aura ∀ with a fizzled surgery → hits', mk(far), tile(5, 0, { aura: true }));
    add('aura ∀ with surgery', mk(far), tile(2, 2, { aura: true }));
    add('invisible adjacent enemy', mk(tiles, {}, { perms: { E: ['effect_invisibility'], F: ['effect_invisibility'] } }), tile(2, 2));
    add('no target', mk(tiles), { ...c0, target: null });
    add('channel tick', mk(far), tile(2, 2, { _channel_tick: true, every: true }));
  }
  if (id === 'effect_mind_blast') {
    const mk = (t, extra = {}, opts) => W(t, { tokens: [sacred, { ...sacred, id: 'm1', q: 0, r: 0, item: 'Clock Tower', owner: 'C' }], traps: [poison, { ...poison, id: 'tm', q: 0, r: 0, owner: 'C' }], ...extra }, opts);
    const pb = { step: 1, of: 1, kept: [4] };
    for (const s of salts.slice(0, 4)) {
      add(`switch with a unit ${s}`, mk(far), tile(5, 0, { ...pb, salt: s }));
      add(`switch empty tile ${s}`, mk(far), tile(3, 3, { ...pb, salt: s }));
      add(`switch, roll now ${s}`, mk(far), tile(5, 0, { salt: s }));
      add(`damage ${s}`, mk(tiles), { ...c0, salt: s });
    }
    add('switch with an obstacle', mk(far, { obstacles: [{ id: 'o1', owner: 'E', q: 2, r: 2 }] }), tile(2, 2, pb));
    add('switch with the adjacent enemy', mk(tiles), tile(1, 0, pb));
    add('switch with a dead unit', mk(far, {}, { life: { E: 0 } }), tile(5, 0, pb));
    add('tile = my tile', mk(far), tile(0, 0, pb));
    add('tile 11 away', mk(far), tile(11, 0, pb));
    add('tile 10 away', mk(far), tile(10, 0, pb));
    add('casting (step 1/2)', mk(far), tile(5, 0, { elements: ['elem_concentration', 'elem_concentration'], step: 1, of: 2, kept: null }));
    add('retry (will 2)', mk(far, {}, {}, { ...base, C: M(10, 10, 10, 2) }), tile(5, 0, { kept: null }));
    add('no ctx map → damage on tile cast', mk(tiles, {}, { no: ['tileTokensAt'] }), tile(1, 0, pb));
    add('aura ∀ damage', mk(far), { ...c0, aura: true, ...pb });
    add('shielded concentration', mk(tiles, {}, { shield: { E: ['elem_concentration'] } }), { ...c0, ...pb });
    add('boost', mk(tiles), { ...c0, ...pb, boost: 5 });
  }
  if (id === 'effect_awake') {
    const mk = (t, extra = {}, opts) => W(t, { tokens: [sacred], traps: [poison], ...extra }, opts);
    add('adjacent ally moves', mk(far), tile(3, 0));
    add('no ally → me', mk({ ...far, A: { q: -4, r: 0 } }), tile(3, 0));
    add('two allies → first by id', mk({ ...far, B: { q: 1, r: -1 } }, {}, {}), tile(3, 0));
    add('enemy adjacent only', mk({ C: { q: 0, r: 0 }, E: { q: 1, r: 0 } }), tile(3, 0));
    add('dead ally', mk(far, {}, { life: { A: 0 } }), tile(3, 0));
    add('dest occupied', mk(far), tile(5, 0));
    add('dest holds a feature', mk(far), tile(0, -1));
    add('dest holds a trap', W(far, { traps: [{ ...poison, q: 3, r: 0 }] }), tile(3, 0));
    add('dest too far', mk(far), tile(11, 0));
    add('dest = my tile (occupied)', mk(far), tile(0, 0));
    add('no target', mk(far), { ...c0, target: null });
    add('character target', mk(far), c0);
    add('no trapsAt', mk(far, {}, { no: ['trapsAt'] }), tile(3, 0));
    add('blocked by bombard', mk(tiles, {}, { perms: { E: ['effect_emotions_bombard'] } }), tile(3, 0));
    // The resolver's plan (game/awake.mjs → cast.awake, user request 2026-11-17).
    const unitPlan = (who, q, r, how = 'auto', gain = 2) => ({ kind: 'unit', who, from: { q: 0, r: 0 }, q, r, gain, how });
    const bldPlan = { kind: 'building', label: 'Watch Tower', from: { q: 1, r: -1 }, q: -1, r: 1, gain: 4, how: 'picked tile' };
    add('plan: me moves', mk(far), { ...c0, target: null, awake: unitPlan('C', 4, 0) });
    add('plan: ally moves (picked tile)', mk(far), tile(3, 0, { awake: unitPlan('A', 3, 0, 'picked tile', -1) }));
    add('plan: building moves', mk(far), tile(-1, 1, { awake: bldPlan }));
    add('plan: building without a label', mk(far), { ...c0, awake: { ...bldPlan, label: undefined } });
    add('plan: none', mk(far), tile(3, 0, { awake: { kind: 'none', why: 'nothing near me can move to a free hex within 10' } }));
    add('plan: none without why', mk(far), { ...c0, awake: { kind: 'none' } });
    add('plan: unit without who', mk(far), { ...c0, awake: { kind: 'unit', q: 1, r: 1 } });
    add('plan: kind not a string', mk(far), tile(3, 0, { awake: { kind: 7 } }));
    add('plan: blocked by bombard', mk(tiles, {}, { perms: { E: ['effect_emotions_bombard'] } }), { ...c0, awake: unitPlan('C', 4, 0) });
    add('plan: disabled harmony', mk(far, {}, { disabled: { C: ['elem_harmony'] } }), { ...c0, awake: bldPlan });
    // 2026-11-18: wall tokens (obstacle by its owner / labyrinth wall as world edits), the Harmony channel tick, ∀.
    const obPlan = { kind: 'wall', label: 'obstacle', from: { q: 1, r: -1 }, q: 0, r: -2, gain: 3, how: 'auto', reloc: { kind: 'obstacle', owner: 'A', id: 'o1', label: 'obstacle', by: 'C', q: 0, r: -2 } };
    const labPlan = { kind: 'wall', label: 'Impassable Wall', from: { q: -1, r: 1 }, q: 1, r: 1, gain: 3, how: 'picked thing', reloc: { kind: 'wall', owner: 'world', id: 'lab:-1,1', label: 'Impassable Wall', by: 'C', from: { q: -1, r: 1 }, q: 1, r: 1 } };
    add('plan: obstacle moves', mk(far), { ...c0, awake: obPlan });
    add('plan: labyrinth wall moves', mk(far), tile(-1, 1, { awake: labPlan }));
    add('plan: wall without reloc', mk(far), { ...c0, awake: { ...obPlan, reloc: undefined } });
    add('plan: ∀ unit move', mk(far), { ...c0, every: true, awake: unitPlan('A', 3, 0) });
    for (const s of salts) {
      add(`channel tick ${s}`, mk(far), { ...c0, target: null, salt: s, _channel_tick: true });
      add(`channel tick weak will ${s}`, mk(far, {}, {}, { ...base, C: M(10, 12, 16, 3) }), { ...c0, target: null, salt: s, _channel_tick: true });
    }
    add('channel tick with a plan (plan ignored)', mk(far), { ...c0, _channel_tick: true, awake: bldPlan });
    add('channel tick blocked by bombard', mk(tiles, {}, { perms: { E: ['effect_emotions_bombard'] } }), { ...c0, _channel_tick: true });
    add('∀', mk(far), tile(3, 0, { every: true }));
  }
  return cases;
}

// ---------------------------------------------------------------- seeded random map contexts
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const POOL = ['C', 'E', 'F', 'A', 'g', 'b', 'B', 'peer:z', 'peer:Ab', 'x-1', 'Ω'];
const PERMS = ['effect_aura', 'effect_invisibility', 'effect_haste', 'effect_emotions_bombard'];
const SIDES = ['player', 'npc_a', 'npc_b'];
const ITEMS = ['Sacred Land', 'Rift', 'Choir', 'Spring', ''];
const TRAP_FX = ['effect_poison', 'effect_sleep', 'effect_confusion'];
function randomCase(rnd, def, sha) {
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (l) => l[Math.floor(rnd() * l.length)];
  const chance = (p) => rnd() < p;
  const ids = [...POOL].sort(() => rnd() - 0.5).slice(0, ri(1, 7));
  const me = ids[0];
  const R = chance(0.3) ? 1 : chance(0.5) ? 2 : 4;
  const tiles = {}, st = {}, sd = {}, life = {}, perms = {}, shield = {}, pen = {};
  tiles[me] = { q: 0, r: 0 };
  for (const id of ids) {
    if (id !== me) tiles[id] = chance(0.15) ? { q: ri(4, 12), r: ri(-3, 3) } : { q: ri(-R, R), r: ri(-R, R) };
    st[id] = M(ri(0, 32), ri(0, 32), ri(0, 32), ri(0, 32));
    sd[id] = pick(SIDES);
    life[id] = chance(0.15) ? 0 : ri(1, 6);
    perms[id] = PERMS.filter(p => chance(p === 'effect_emotions_bombard' ? 0.03 : p === 'effect_aura' ? 0.08 : 0.12));
    if (chance(0.2)) shield[id] = ELEMS.filter(() => chance(0.25));
  }
  // order of tiles keys: me first (world.me), peers() sorts anyway
  const ownerOf = () => (chance(0.1) ? undefined : chance(0.2) ? me : pick(ids));
  const near = () => (chance(0.6) ? (([dq, dr]) => ({ q: dq, r: dr }))(pick(DIRS)) : { q: ri(-3, 3), r: ri(-3, 3) });
  const idOf = (p) => (chance(0.08) ? pick(['x', 'y', 'X', '1', '10', 'ä']) : `${p}${ri(0, 30)}`);
  const tokens = Array.from({ length: ri(0, 7) }, () => ({ id: idOf('tk'), kind: chance(0.75) ? 'bonus' : pick(['fire', 'shield']), elem: chance(0.97) ? pick(ELEMS) : 'bogus', value: ri(0, 7), owner: ownerOf(), ...(chance(0.5) ? { item: pick(ITEMS) } : {}), ...near() }));
  const traps = Array.from({ length: ri(0, 5) }, () => ({ id: idOf('tr'), owner: ownerOf(), effect_id: pick(TRAP_FX), ...(chance(0.3) ? tiles[pick(ids)] : chance(0.5) ? near() : { q: ri(-11, 11), r: ri(-6, 6) }) }));
  const obstacles = Array.from({ length: chance(0.6) ? 0 : ri(1, 3) }, () => ({ id: idOf('ob'), owner: ownerOf(), ...near() }));
  if (chance(0.3)) pen[me] = { [pick(ELEMS)]: ri(1, 10) };
  const no = ['tileTokensAt', 'trapsAt', 'obstacleAt', 'freeTilesWithin'].filter(() => chance(0.04));
  const opts = { pen, perms, shield, life, actionIndex: ri(0, 40), no };
  if (chance(0.04)) opts.disabled = { [me]: [pick(def.elements)] };
  const w = mapWorld(st, tiles, sd, { tokens, traps, obstacles }, opts, sha);
  if (chance(0.03)) { const t0 = w.tileOf; w.tileOf = id => (id === me ? undefined : t0(id)); }
  const elems = chance(0.75) ? [...def.elements] : chance(0.8) ? Array.from({ length: ri(1, 3) }, () => pick(ELEMS)) : chance(0.5) ? [] : [...def.elements, pick(ELEMS)];
  const tk = rnd();
  // tile targets dominate: the pick lands on free tiles, things, units, my own tile, far tiles
  const tileRef = () => {
    const k = rnd();
    if (k < 0.35) { const f = w.freeTilesWithin ? w.freeTilesWithin(0, 0, 4) : []; return f.length ? { ...pick(f) } : { q: 2, r: 2 }; }
    if (k < 0.5) return { q: tokens.length ? tokens[0].q : 1, r: tokens.length ? tokens[0].r : 1 };
    if (k < 0.65) { const t = tiles[pick(ids)]; return { q: t.q, r: t.r }; }
    if (k < 0.8) return { q: ri(-11, 11), r: ri(-11, 11) };
    return { q: ri(-2, 2), r: ri(-2, 2) };
  };
  const target = tk < 0.6 ? { kind: 'tile', ref: tileRef() } : tk < 0.88 ? { kind: 'character', ref: pick(ids) } : null;
  const of = chance(0.5) ? ri(1, 3) : undefined;
  const cast = {
    actor: me, effect_id: def.id, elements: elems, salt: chance(0.05) ? undefined : `s${ri(0, 1e6)}`, target,
    is_instant: chance(0.2), every: chance(0.2), aura: chance(0.08),
    ...(of !== undefined ? { of } : {}), ...(chance(0.5) ? { step: ri(1, 4) } : {}),
    kept: chance(0.4) ? null : chance(0.8) ? elems.map(() => (chance(0.3) ? null : ri(1, 6))) : [ri(1, 6)],
    ...(chance(0.12) ? { boost: ri(1, 9) } : {}), ...(chance(0.04) ? { _channel_tick: true } : {}),
  };
  return { ctx: w, cast };
}

export function e2cCases(def, { sha, n = 600, seed = 1 } = {}) {
  if (!E2C_EFFECTS.includes(def.id)) return [];
  const cases = targeted(def.id, sha);
  const rnd = mulberry32(seed * 104729 + [...def.id].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 0));
  for (let i = 0; i < n; i++) { const { ctx, cast } = randomCase(rnd, def, sha); cases.push({ label: `e2c random #${i}`, ctx, cast }); }
  return cases;
}

// Branches an outcome exercised (read off the JS outcome).
export function e2cBranch(id, cast, o) {
  const b = [];
  const has = (p) => o.notes.some(x => x.startsWith(p));
  b.push(`status ${o.status}`);
  if (o.hits.length) b.push('damage');
  if (id === 'effect_throw') {
    if (o.pulls.length) b.push('pull ok');
    if (has('pull failed')) b.push('pull failed');
    if (o.rolls.some(r => String(r.elem).startsWith('pull:') && !r.ok)) b.push('pull roll failed');
    if (o.hits.length && !o.rolls.length) b.push('smash');
  }
  if (id === 'effect_metaphysics' || id === 'effect_disruption') {
    for (const r of o.relocations) b.push(`moved ${r.kind}`);
    if (has('no free tile within 10 chosen')) b.push('dest refused');
    if (has('nothing nearby to move') || has('no trap in view to move')) b.push('nothing to move');
    if (cast.target?.kind === 'tile' && o.hits.length) b.push('tile cast deals damage');
  }
  if (id === 'effect_mind_blast') {
    if (o.moves.length === 2) b.push('switch with a unit');
    if (o.moves.length === 1) b.push('switch without a unit');
    if (o.relocations.length) b.push('switch moves things');
    if (o.relocations.some(r => r.kind === 'obstacle')) b.push('switch moves an obstacle');
    if (has('tile to switch')) b.push('switch refused');
    if (o.hits.some(h => h.selfDamageEqual)) b.push('self damage equal');
  }
  if (id === 'effect_awake') {
    if (o.moves.length && o.moves[0].who !== cast.actor) b.push('ally moved');
    if (o.moves.length && o.moves[0].who === cast.actor) b.push('me moved');
    if (has('no free tile within 10 chosen')) b.push('dest refused');
    if (has('awake needs a free tile')) b.push('needs a tile');
    if (o.relocations.some(r => r.kind === 'building')) b.push('building moved');
    if (o.relocations.some(r => r.kind === 'obstacle' || r.kind === 'wall')) b.push('wall moved');
    if (has('awake channel: Harmony token')) b.push('tick token');
    if (has('awake channel: the Harmony roll failed')) b.push('tick roll failed');
    if (o.permanents.length && o.channels.length) b.push('permanent + channel');
    if (has('awake: ')) b.push('plan none');
  }
  return b;
}
export const E2C_BRANCHES = {
  effect_throw: ['pull ok', 'pull failed', 'pull roll failed', 'smash', 'status done', 'status fizzled', 'status retry', 'status blocked'],
  effect_metaphysics: ['moved token', 'moved trap', 'dest refused', 'nothing to move', 'tile cast deals damage', 'damage', 'status done', 'status fizzled', 'status blocked'],
  effect_disruption: ['moved trap', 'dest refused', 'nothing to move', 'tile cast deals damage', 'damage', 'status done', 'status fizzled', 'status blocked'],
  effect_mind_blast: ['switch with a unit', 'switch without a unit', 'switch moves things', 'switch moves an obstacle', 'switch refused', 'self damage equal', 'status done', 'status fizzled', 'status casting', 'status retry', 'status blocked'],
  effect_awake: ['ally moved', 'me moved', 'building moved', 'wall moved', 'tick token', 'tick roll failed', 'permanent + channel', 'plan none', 'dest refused', 'needs a tile', 'status done', 'status fizzled', 'status blocked'],
};

// Section 4b entry point (tools/effect-engine-check.mjs loads every file of this folder).
export default function e2c(h) {
  const { defs, compare, ok, sha, JS, N, SEED } = h;
  const mine = E2C_EFFECTS.filter(id => defs.has(id));
  ok('E2c: all 5 E2c effects have definitions', mine.length === E2C_EFFECTS.length, `(${mine.length}/${E2C_EFFECTS.length}; missing ${E2C_EFFECTS.filter(id => !defs.has(id)).join(', ') || 'none'})`);
  for (const id of mine) {
    const def = defs.get(id);
    const cases = e2cCases(def, { sha, n: N, seed: SEED });
    const nRandom = cases.filter(c => c.label.startsWith('e2c random')).length;
    let same = 0;
    const hit = {};
    for (const { label, ctx, cast } of cases) {
      if (compare(def, ctx, cast, label)) same++;
      let o = null;
      try { o = JS.resolveEffectJs(ctx, cast); } catch { hit.threw = (hit.threw || 0) + 1; }
      if (o) for (const b of e2cBranch(id, cast, o)) hit[b] = (hit[b] || 0) + 1;
    }
    ok(`${id}: ${cases.length - nRandom} map fixtures + ${nRandom} random map contexts identical`, same === cases.length, `(${same}/${cases.length})`);
    const miss = E2C_BRANCHES[id].filter(b => !hit[b]);
    ok(`${id}: every reachable branch hit`, !miss.length, miss.length ? `missing ${miss.join(', ')}` : `(${E2C_BRANCHES[id].map(b => `${b} ${hit[b]}`).join(', ')})`);
  }
}
