// E2b fixtures for tools/effect-engine-check.mjs: relocation / meta permanents / scouting / Space Bending and the
// stat-buy family (Summoning, Golems ×3, Elementals ×3, Resurrect / Death Ward).
// Adds (1) hand-written worlds × casts reaching what the generic random worlds miss (a bounded map with
// freeTilesWithin up to 24 hexes, the Dimension Library, attached cards, Spirit Link / Phylactery / summon
// payloads), (2) max(600, N) extra random contexts per effect with those inputs, and (3) asserts that every
// listed branch was hit (judged on the JS outcome) and that both engines agreed on every case.
const IDS = ['super_force', 'traps_mastery', 'blessing_curse', 'teleportation', 'banish', 'creation', 'spirit_link', 'phantom', 'vision',
  'possess_phylactery', 'space_bending', 'summoning', 'golems_earth', 'golems_water', 'golems_air', 'elementals_air', 'elementals_water',
  'elementals_earth', 'resurrect_death_ward'].map(s => `effect_${s}`);

const hd = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((a.q + a.r) - (b.q + b.r)));
const has = (o, s) => o.notes.some(n => n.includes(s));
const fz = (s) => (o) => o.status === 'fizzled' && has(o, s);
const statBuy = {
  casting: (o) => o.status === 'casting' && Array.isArray(o.kept),
  done: (o) => o.status === 'done' && !!o.summon && o.permanents.length === 1,
  bindOk: (o) => o.status === 'done' && !!o.summon?.bind,
  bindGone: fz('the creature is gone'),
  blocked: (o) => o.status === 'blocked',
};
const BRANCHES = {
  effect_super_force: { pushed: (o) => o.moves.some(m => m.reason === 'pushed'), hitNoPush: (o) => o.hits.length > 0 && !o.moves.length, fizzled: fz('nobody in reach'), blocked: (o) => o.status === 'blocked' },
  effect_space_bending: { lock1: (o) => o.locks.some(l => l.n === 1), lock2: (o) => o.locks.some(l => l.n === 2), trapLibrary: (o) => o.traps.some(t => t.library), trapAttached: (o) => o.traps.some(t => !t.library),
    noFree: fz('no free tile within 10'), noCard: fz('no card to lay') },
  effect_traps_mastery: { trap: (o) => o.traps.some(t => t.holder === 'effect_traps_mastery') && o.permanents.length === 1, fizzled: fz('no effect attached'), tickNoPerm: (o, c) => c._channel_tick && o.status === 'done' && !o.permanents.length },
  effect_blessing_curse: { channelTarget: (o) => o.channels.some(ch => ch.target && ch.stop === 'never'), channelNoTarget: (o) => o.channels.some(ch => ch.target === null), fizzled: fz('no effect attached') },
  effect_teleportation: { chosen: (o, c) => c.target?.kind === 'tile' && o.moves.some(m => m.q === c.target.ref.q && m.r === c.target.ref.r), notFree: (o) => has(o, 'random tile instead') && o.moves.length,
    random: (o, c) => c.target?.kind !== 'tile' && o.moves.length, ally: (o, c) => o.moves.some(m => m.who !== c.actor), fizzled: fz('no free tile within 10') },
  effect_banish: { far: (o, c, w) => o.moves.some(m => hd(w.tileOf(c.actor), m) >= 18), near: (o, c, w) => o.moves.some(m => hd(w.tileOf(c.actor), m) < 18), holds: (o) => o.status === 'fizzled' && has(o, ' holds ('),
    nobody: fz('nobody in reach'), noTile: fz('no free tile to banish to') },
  effect_creation: { chosen: (o, c) => c.target?.kind === 'tile' && o.obstacles.some(x => x.q === c.target.ref.q && x.r === c.target.ref.r), auto: (o, c) => c.target?.kind !== 'tile' && o.obstacles.length, fizzled: fz('no free neighbour') },
  effect_spirit_link: { one: (o) => o.links.length === 1, all: (o) => o.links.length === 4, defaultVitality: (o, c) => o.links.length === 1 && o.links[0].stat === 'vitality' && c.link?.stat !== 'vitality', fizzled: fz('no ally to link') },
  effect_phantom: { phantom: (o) => o.phantom === true && o.permanents.length === 1, blocked: (o) => o.status === 'blocked' && !o.phantom },
  effect_vision: { tile: (o) => o.peeks.some(p => p.kind === 'tile'), hand: (o) => o.peeks.some(p => p.kind === 'hand'), hidden: (o) => has(o, 'keeps their hand hidden'), nobody: fz('nobody in reach and no tile') },
  effect_possess_phylactery: { bind: (o) => !!o.possess?.bind && o.permanents.some(p => p.by), phylactery: (o) => !!o.possess?.phylactery && o.permanents.some(p => !p.by), phylFail: fz('no such enemy permanent'),
    resists: (o) => has(o, ' resists ('), nobody: fz('nobody in reach') },
  effect_resurrect_death_ward: { nothing: fz('nothing to raise or ward'), casting: statBuy.casting, revive: (o) => o.status === 'done' && !!o.summon?.revive, reviveFail: fz('nothing to raise here'),
    ward: (o) => o.status === 'done' && !!o.summon?.ward && o.summon.need === 0, wardFail: fz('no ally to ward'), creature: (o) => o.status === 'done' && !!o.summon?.creature_id },
};
for (const id of IDS) if (/summoning|golems|elementals/.test(id)) BRANCHES[id] = statBuy;

// A bounded hex map of radius R around (0,0) (peer.mjs: only known tiles), freeTilesWithin sorted q, r like peer.mjs,
// the Dimension Library (effect_id + elements), no tile tokens / traps / obstacles.
function withMap(w, R = 12, library = []) {
  w.freeTilesWithin = (q, r, d) => {
    const out = [];
    for (let dq = -d; dq <= d; dq++) for (let dr = Math.max(-d, -dq - d); dr <= Math.min(d, -dq + d); dr++) {
      const t = { q: q + dq, r: r + dr };
      if ((dq || dr) && hd(t, { q: 0, r: 0 }) <= R && w.isFree(t.q, t.r)) out.push(t);
    }
    return out;
  };
  w.library = () => library;
  w.tileTokensAt = () => [];
  w.trapsAt = () => [];
  w.obstacleAt = () => null;
  return w;
}
const LIB = [{ effect_id: 'effect_fireball', elements: ['elem_fire', 'elem_fire'] }, { effect_id: 'effect_lightning', elements: ['elem_fire', 'elem_air'] }, { effect_id: 'effect_sleep', elements: ['elem_souls'] }];
const ATTACH = { effect_id: 'effect_fireball', elements: ['elem_fire', 'elem_fire'], card_id: 'card-att' };

export default function e2b(h) {
  const { defs, world, M, compare, ok, mulberry32, randomCase, stats, JS, N, SEED, tiles, sides, base } = h;
  const mine = IDS.filter(id => defs.has(id));
  ok('E2b: all 19 E2b effects have definitions', mine.length === IDS.length, `(${mine.length}/${IDS.length}; missing ${IDS.filter(id => !defs.has(id)).join(', ') || 'none'})`);

  const far = { C: { q: 0, r: 0 }, E: { q: 5, r: 0 }, F: { q: 0, r: 5 }, A: { q: -1, r: 0 } };
  const pushBlocked = { C: { q: 0, r: 0 }, E: { q: 1, r: 0 }, F: { q: 2, r: 0 }, A: { q: -1, r: 0 } };
  // C boxed in: every neighbour occupied (Creation has no free neighbour).
  const boxed = { C: { q: 0, r: 0 }, E: { q: 1, r: 0 }, F: { q: 1, r: -1 }, A: { q: 0, r: -1 }, B: { q: -1, r: 0 }, g: { q: -1, r: 1 }, b: { q: 0, r: 1 } };
  const boxedSides = { C: 'player', E: 'npc_b', F: 'npc_b', A: 'player', B: 'player', g: 'npc_a', b: 'player' };
  const boxedSt = Object.fromEntries(Object.keys(boxed).map(k => [k, M(10, 10, 8, 10)]));
  boxedSt.C = M(10, 10, 16, 10);
  const worlds = [
    ['plain R12', withMap(world(base, tiles, sides), 12, LIB)],
    ['plain R24 no library', withMap(world(base, tiles, sides), 24, [])],
    ['plain R1 (cramped)', withMap(world(base, tiles, sides), 1, LIB)],
    ['alone R12', withMap(world({ ...base, C: M(15, 14, 10, 10) }, far, sides), 12, LIB)],
    ['alone R24', withMap(world({ ...base, C: M(15, 14, 10, 10) }, far, sides), 24, [])],
    ['alone no map', world(base, far, sides)],
    ['push blocked', withMap(world(base, pushBlocked, sides), 12, LIB)],
    ['boxed in', withMap(world(boxedSt, boxed, boxedSides), 12, LIB)],
    ['ally weaker', withMap(world(base, tiles, sides, { life: { A: 1, C: 4 } }), 12, LIB)],
    ['ally dead', withMap(world(base, tiles, sides, { life: { A: 0, E: 0 } }), 12, LIB)],
    ['strong world', withMap(world({ ...base, C: M(12, 30, 16, 12) }, tiles, sides), 24, LIB)],
    ['weak caster', withMap(world({ ...base, C: M(3, 3, 3, 3) }, tiles, sides), 12, LIB)],
    ['aura', withMap(world(base, tiles, sides, { perms: { C: ['effect_aura'], E: ['effect_haste'] } }), 12, LIB)],
    ['invisible E', withMap(world(base, tiles, sides, { perms: { E: ['effect_invisibility', 'effect_haste'] } }), 12, LIB)],
    ['emotions bombard', withMap(world(base, tiles, sides, { perms: { E: ['effect_emotions_bombard'] } }), 12, LIB)],
  ];
  const casts = (def) => {
    const b = { actor: 'C', effect_id: def.id, elements: def.elements, salt: 'e2b', target: { kind: 'character', ref: 'E' }, is_instant: false };
    const sm = { need: 20, creature_id: 'creature_x', name: 'X' };
    return [
      ['target E', b], ['target F', { ...b, target: { kind: 'character', ref: 'F' } }], ['target ally A', { ...b, target: { kind: 'character', ref: 'A' } }],
      ['no target', { ...b, target: null }], ['∀', { ...b, every: true }], ['aura ∀', { ...b, aura: true }], ['tick', { ...b, _channel_tick: true }],
      ['tile adjacent', { ...b, target: { kind: 'tile', ref: { q: 0, r: -1 } } }], ['tile far 3', { ...b, target: { kind: 'tile', ref: { q: 3, r: -1 } } }],
      ['tile 11 away', { ...b, target: { kind: 'tile', ref: { q: 11, r: 0 } } }], ['tile occupied', { ...b, target: { kind: 'tile', ref: { q: 1, r: 0 } } }],
      ['attach', { ...b, attach: ATTACH }], ['attach no card id', { ...b, attach: { effect_id: 'effect_sleep', elements: ['elem_souls'] }, target: null }],
      ['attach empty', { ...b, attach: { effect_id: 'effect_sleep', elements: [] } }],
      ['link A will', { ...b, link: { peer_id: 'A', stat: 'will' } }], ['link A bogus', { ...b, link: { peer_id: 'A', stat: 'bogus' } }],
      ['link A ∀', { ...b, every: true, link: { peer_id: 'A', stat: 'matter' } }], ['link E', { ...b, link: { peer_id: 'E', stat: 'will' } }], ['link self', { ...b, link: { peer_id: 'C' } }],
      ['phylactery E haste', { ...b, phylactery: { peer_id: 'E', perm: 'effect_haste' } }], ['phylactery E class', { ...b, phylactery: { peer_id: 'E', perm: 'class_rogue' } }],
      ['phylactery A', { ...b, phylactery: { peer_id: 'A', perm: 'effect_haste' } }],
      ['summon paid', { ...b, summon: sm, of: 3, step: 3, kept: [10, 10] }], ['summon step 1', { ...b, summon: sm, of: 3, step: 1, kept: null }],
      ['summon need str', { ...b, summon: { ...sm, need: '15' }, step: 2, of: 2 }], ['summon no need', { ...b, summon: { creature_id: 'c' } }],
      ['summon bind E', { ...b, summon: { ...sm, need: 5, bind: 'E' } }], ['summon bind F far', { ...b, summon: { ...sm, need: 5, bind: 'F', is_player: true, archive_card_id: 'arc-1' } }],
      ['revive E', { ...b, summon: { revive: 'E', need: 4, is_player: true } }], ['revive A', { ...b, summon: { revive: 'A', need: 4 } }], ['revive F', { ...b, summon: { revive: 'F', need: 4 } }],
      ['ward A', { ...b, summon: { ward: 'A', need: 0 } }], ['ward E', { ...b, summon: { ward: 'E' } }], ['ward + revive', { ...b, summon: { ward: 'E', revive: 'A', need: 1 } }],
      ['no summon', { ...b, summon: null }], ['salt s2', { ...b, salt: 's2' }], ['salt s3', { ...b, salt: 's3' }], ['no salt', { ...b, salt: undefined }],
    ];
  };

  for (const id of mine) {
    const def = defs.get(id);
    const seen = Object.fromEntries(Object.keys(BRANCHES[id] || {}).map(k => [k, 0]));
    let n = 0, same = 0;
    const judge = (w, c, label) => {
      n++; if (compare(def, w, c, label)) same++;
      let o; try { o = JS.resolveEffectJs(w, c); } catch { return; }
      for (const [k, f] of Object.entries(BRANCHES[id] || {})) if (f(o, c, w)) seen[k]++;
    };
    for (const [wl, w] of worlds) for (const [cl, c] of casts(def)) judge(w, c, `e2b fixture ${wl} / ${cl}`);
    // Extra random contexts: a bounded map (sometimes none), the Library, attached cards, link / phylactery / summon payloads.
    const rnd = mulberry32(SEED * 15485863 + [...id].reduce((a, ch) => a * 41 + ch.charCodeAt(0) | 0, 0));
    const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const pick = (l) => l[Math.floor(rnd() * l.length)];
    const R = Math.max(600, N);
    for (let i = 0; i < R; i++) {
      const { w, cast } = randomCase(rnd, def);
      const ids = w.peers();
      const me = cast.actor;
      if (rnd() < 0.85) withMap(w, pick([0, 1, 2, 6, 12, 18, 24]), rnd() < 0.6 ? LIB.slice(0, ri(1, 3)) : []);
      const other = () => (rnd() < 0.85 ? pick(ids) : 'nobody');
      if (rnd() < 0.5) cast.target = rnd() < 0.5 ? { kind: 'tile', ref: { q: ri(-12, 12), r: ri(-12, 12) } } : { kind: 'character', ref: pick(ids) };
      if (rnd() < 0.5) cast.attach = rnd() < 0.85 ? { effect_id: pick(LIB).effect_id, elements: [...pick(LIB).elements], ...(rnd() < 0.6 ? { card_id: `card-${i}` } : {}) } : { effect_id: 'effect_sleep', elements: [] };
      if (rnd() < 0.5) cast.link = { peer_id: other(), ...(rnd() < 0.8 ? { stat: pick(['vitality', 'world', 'will', 'matter', 'bogus']) } : {}) };
      if (rnd() < 0.3) cast.phylactery = { peer_id: rnd() < 0.9 ? other() : '', perm: pick(['effect_haste', 'effect_aura', 'effect_invisibility', 'class_rogue', 'effect_shield', '']) };
      if (rnd() < 0.75) {
        const sm = {};
        if (rnd() < 0.7) sm.need = rnd() < 0.9 ? ri(0, 70) : String(ri(0, 40));
        if (rnd() < 0.5) sm.creature_id = `creature_${ri(1, 4)}`;
        if (rnd() < 0.3) sm.name = 'Beast';
        if (rnd() < 0.25) sm.bind = pick(ids.filter(x => x !== me).concat([me]));
        if (rnd() < 0.3) sm.revive = pick(ids);
        if (rnd() < 0.3) sm.ward = pick(ids);
        if (rnd() < 0.2) sm.archive_card_id = `arc-${i}`;
        if (rnd() < 0.2) sm.is_player = true;
        cast.summon = sm;
      }
      if (rnd() < 0.3) { cast.of = ri(1, 8); cast.step = ri(1, 8); if (rnd() < 0.5) cast.kept = Array.from({ length: ri(0, 4) }, () => (rnd() < 0.2 ? null : ri(0, 30))); }
      void me;
      judge(w, cast, `e2b random #${i}`);
    }
    const missing = Object.entries(seen).filter(([, v]) => !v).map(([k]) => k);
    ok(`${id}: E2b fixtures + ${R} map-aware random contexts identical, branches hit`, same === n && !missing.length,
      `(${same}/${n}; branches ${JSON.stringify(seen)}${missing.length ? `; NOT HIT ${missing.join(', ')}` : ''}; total ${stats[id].same}/${stats[id].n})`);
  }
}
