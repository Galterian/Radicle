// E2a fixtures for tools/effect-engine-check.mjs: the easy effects + the channel / trap / token mediums.
// Adds (1) hand-written worlds × casts that reach branches the generic random worlds miss (declared ally,
// channel tick, card ids, map queries freeTilesWithin / tileTokensAt for the Ageing feature), (2) 300 extra
// random contexts per effect with those queries present, and (3) asserts that every listed branch was hit
// (judged on the JS outcome) and that both engines agreed on every case.
const IDS = ['sound_wave', 'drain', 'blizzard', 'ice_blast', 'dark_matter', 'potion_brew', 'nature_embrace', 'oblivion', 'inner_fire', 'emotions_bombard',
  'aura', 'disable', 'delay_time', 'empower', 'super_sense', 'turn_life', 'balefire', 'poison', 'sleep', 'confusion', 'harm', 'combustion', 'the_void',
  'light_darkness', 'aging'].map(s => `effect_${s}`);

const perm = { landed: (o) => o.permanents.length > 0, blocked: (o) => o.status === 'blocked' };
const BRANCHES = {
  effect_sound_wave: { hit: (o) => o.hits.length > 0, range2: (o, c, w) => o.hits.some(h => w.dist(c.actor, h.victim) === 2), fizzled: (o) => o.status === 'fizzled' },
  effect_drain: { healDealt: (o) => o.hits.some(h => h.healDealt), casting: (o) => o.status === 'casting', retry: (o) => o.status === 'retry' },
  effect_blizzard: { hits: (o) => o.hits.length > 1, zones: (o) => o.zones.length === 7, fizzledZones: (o) => o.status === 'fizzled' && o.zones.length === 7 },
  effect_ice_blast: { bonus: (o) => o.tokens.filter(t => t.kind === 'bonus').length === 2, shield: (o) => o.tokens.some(t => t.kind === 'shield'), hit: (o) => o.hits.length > 0, retry: (o) => o.status === 'retry' },
  effect_dark_matter: { shields: (o) => o.tokens.filter(t => t.kind === 'shield').length === 2, hit: (o) => o.hits.length > 0 },
  effect_potion_brew: { onAlly: (o, c) => o.statTokens.some(t => t.on !== c.actor), onMe: (o, c) => o.statTokens.some(t => t.on === c.actor), auraMany: (o) => new Set(o.statTokens.map(t => t.on)).size > 1 },
  effect_nature_embrace: { lift: (o, c) => o.statTokens.some(t => t.on === c.actor && t.value > 0), dent: (o, c) => o.statTokens.some(t => t.on === c.actor && t.value < 0), hostile: (o, c, w) => o.statTokens.some(t => t.on !== c.actor && w.enemyOf(c.actor, t.on) && t.value < 0) },
  effect_oblivion: { lockNext: (o) => o.locks.some(l => l.restOfTurn && l.nextTurn), landed: perm.landed, fizzled: (o) => o.status === 'fizzled' && !o.permanents.length },
  effect_inner_fire: perm, effect_emotions_bombard: perm, effect_aura: perm, effect_disable: perm, effect_delay_time: perm, effect_empower: perm, effect_super_sense: perm,
  effect_turn_life: { healAlly: (o, c) => o.heals.some(h => h.on !== c.actor), healMe: (o, c) => o.heals.some(h => h.on === c.actor), hit: (o) => o.hits.length > 0 && !o.heals.length },
  effect_balefire: { completesAlone: (o) => o.status === 'done' && !o.hits.length && o.draw === 5 && o.permanents.length === 1, hit: (o) => o.hits.length > 0 && o.permanents.length === 1, tickNoPerm: (o, c) => c._channel_tick && o.status === 'done' && !o.permanents.length },
  effect_poison: { trapCard: (o) => o.traps.some(t => t.card_id), trapAlone: (o) => o.traps.length && !o.hits.length, hitAndTrap: (o) => o.traps.length && o.hits.length, tickNoTrap: (o, c) => c._channel_tick && o.status === 'done' && !o.traps.length },
  effect_sleep: { trap: (o) => o.traps.some(t => t.trigger === 'enter' && t.mode === 'perm'), trapCard: (o) => o.traps.some(t => t.card_id), tickNoTrap: (o, c) => c._channel_tick && o.status === 'done' && !o.traps.length },
  effect_confusion: { trap: (o) => o.traps.some(t => t.trigger === 'enter' && t.mode === 'perm'), trapCard: (o) => o.traps.some(t => t.card_id), tickNoTrap: (o, c) => c._channel_tick && o.status === 'done' && !o.traps.length },
  effect_harm: { channel: (o) => o.channels.some(ch => ch.stop === 'break' && ch.target), channelNoTarget: (o) => o.channels.some(ch => ch.target === null), tick: (o, c) => c._channel_tick && o.hits.length && !o.channels.length && !o.permanents.length, shield: (o) => o.tokens.some(t => t.kind === 'shield'), casting: (o) => o.status === 'casting' },
  effect_combustion: { channel: (o) => o.channels.length === 1 && o.permanents.length === 1, penalty: (o) => o.statTokens.some(t => t.value < 0), tick: (o, c) => c._channel_tick && o.statTokens.length && !o.channels.length, fizzled: (o) => o.status === 'fizzled' },
  effect_the_void: { voidFor: (o) => o.voidFor.length === 1 && o.channels.length === 1, token: (o) => o.tokens.length === 1, tick: (o, c) => c._channel_tick && o.voidFor.length && !o.channels.length, retry: (o) => o.status === 'retry' },
  effect_light_darkness: { zones: (o) => o.zones.length === 7 && o.channels.length === 1, token: (o) => o.tokens.length === 1, tick: (o, c) => c._channel_tick && o.zones.length && !o.channels.length },
  effect_aging: { feature: (o) => o.tokens.some(t => t.item), noFreeTile: (o) => o.notes.includes('no free tile for a feature'), penalties: (o) => o.statTokens.filter(t => t.value < 0).length === 2, auraMany: (o) => new Set(o.statTokens.map(t => t.on)).size > 1 },
};

// Map queries the generic worlds lack: free tiles within d (axial order), bonus / feature tokens per tile.
function withMap(w, tokens = {}) {
  w.freeTilesWithin = (q, r, d) => {
    const out = [];
    for (let dq = -d; dq <= d; dq++) for (let dr = Math.max(-d, -dq - d); dr <= Math.min(d, -dq + d); dr++) if (w.isFree(q + dq, r + dr)) out.push({ q: q + dq, r: r + dr });
    return out;
  };
  w.tileTokensAt = (q, r) => tokens[`${q},${r}`] || [];
  return w;
}

export default function e2a(h) {
  const { defs, world, M, compare, ok, mulberry32, randomCase, stats, JS, N, SEED, tiles, sides, base } = h;
  const mine = IDS.filter(id => defs.has(id));
  ok('E2a: all 25 E2a effects have definitions', mine.length === IDS.length, `(${mine.length}/${IDS.length}; missing ${IDS.filter(id => !defs.has(id)).join(', ') || 'none'})`);

  // Hand-written worlds.
  const far = { C: { q: 0, r: 0 }, E: { q: 5, r: 0 }, F: { q: 0, r: 5 }, A: { q: -1, r: 0 } };
  const ring2 = { C: { q: 0, r: 0 }, E: { q: 2, r: 0 }, F: { q: 0, r: -2 }, A: { q: -1, r: 0 } };
  const allFeatures = {};
  for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) allFeatures[`${q},${r}`] = [{ kind: 'bonus', elem: 'elem_fire', value: 3, owner: 'Z', id: `f${q}${r}`, item: 'Sphere of Fire' }];
  const someFeatures = { '0,-1': [{ kind: 'bonus', elem: 'elem_fire', value: 3, owner: 'Z', id: 'f1', item: 'Spring' }], '1,-1': [{ kind: 'bonus', elem: 'elem_air', value: 2, owner: 'Z', id: 'b1' }] };
  const worlds = [
    ['plain+map', withMap(world(base, tiles, sides))],
    ['alone+map', withMap(world({ ...base, C: M(15, 12, 10, 10) }, far, sides))],
    ['alone, features everywhere', withMap(world(base, far, sides), allFeatures)],
    ['alone, some features', withMap(world(base, far, sides), someFeatures)],
    ['ring 2', withMap(world({ ...base, C: M(12, 14, 20, 12) }, ring2, sides))],
    ['ally hurt', withMap(world(base, tiles, sides, { life: { A: 1, C: 4 } }))],
    ['ally dead', withMap(world(base, tiles, sides, { life: { A: 0 } }))],
    ['aura', withMap(world(base, tiles, sides, { perms: { C: ['effect_aura'] } }))],
    ['strong caster', withMap(world({ ...base, C: M(18, 18, 12, 14) }, tiles, sides))],
    ['weak caster', withMap(world({ ...base, C: M(3, 3, 3, 3) }, tiles, sides))],
    ['invisible E', withMap(world(base, tiles, sides, { perms: { E: ['effect_invisibility'] } }))],
    ['emotions bombard', withMap(world(base, tiles, sides, { perms: { E: ['effect_emotions_bombard'] } }))],
  ];
  const casts = (def) => {
    const b = { actor: 'C', effect_id: def.id, elements: def.elements, salt: 'e2a', target: { kind: 'character', ref: 'E' }, is_instant: false };
    return [
      ['target E', b], ['target E card', { ...b, card_id: 'card-17' }], ['target ally A', { ...b, target: { kind: 'character', ref: 'A' } }],
      ['target self', { ...b, target: { kind: 'character', ref: 'C' } }], ['no target', { ...b, target: null, card_id: 'card-9' }],
      ['tile', { ...b, target: { kind: 'tile', ref: { q: 1, r: -1 } } }], ['tick', { ...b, _channel_tick: true }], ['tick no target', { ...b, target: null, _channel_tick: true }],
      ['∀', { ...b, every: true }], ['aura ∀', { ...b, aura: true }], ['aura ∀ ally', { ...b, aura: true, target: { kind: 'character', ref: 'A' } }],
      ['instant', { ...b, is_instant: true }], ['step 1/2', { ...b, of: 2, step: 1, kept: null }], ['step 2/2 kept', { ...b, of: 2, step: 2, kept: [5, 6].slice(0, def.elements.length) }],
      ...['s1', 's2', 's3', 's4', 's5', 's6'].map(s => [`salt ${s}`, { ...b, salt: s }]), ['no salt', { ...b, salt: undefined }],
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
    for (const [wl, w] of worlds) for (const [cl, c] of casts(def)) judge(w, c, `e2a fixture ${wl} / ${cl}`);
    // Extra random contexts with map queries, card ids and ally-biased targets.
    const rnd = mulberry32(SEED * 104729 + [...id].reduce((a, ch) => a * 37 + ch.charCodeAt(0) | 0, 0));
    const R = Math.max(300, Math.floor(N / 2));
    for (let i = 0; i < R; i++) {
      const { w, cast } = randomCase(rnd, def);
      const ids = w.peers();
      const toks = {};
      for (const pid of ids) { const t = w.tileOf(pid); if (t && rnd() < 0.3) toks[`${t.q},${t.r}`] = [{ kind: 'bonus', elem: 'elem_water', value: 2, owner: pid, id: `t${i}${pid}`, ...(rnd() < 0.5 ? { item: 'Spring' } : {}) }]; }
      if (rnd() < 0.8) withMap(w, toks);
      if (rnd() < 0.5) cast.card_id = `card-${i}`;
      if (rnd() < 0.3) { const allies = ids.filter(x => x !== cast.actor && !w.enemyOf(cast.actor, x)); if (allies.length) cast.target = { kind: 'character', ref: allies[i % allies.length] }; }
      judge(w, cast, `e2a random #${i}`);
    }
    const missing = Object.entries(seen).filter(([, v]) => !v).map(([k]) => k);
    ok(`${id}: E2a fixtures + ${R} map-aware random contexts identical, branches hit`, same === n && !missing.length,
      `(${same}/${n}; branches ${JSON.stringify(seen)}${missing.length ? `; NOT HIT ${missing.join(', ')}` : ''}; total ${stats[id].same}/${stats[id].n})`);
  }
}
