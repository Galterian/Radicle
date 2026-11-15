// Offline checks for the phone's dimension paths:
//   1. join-plan.mjs listDimensionsFromHttpd / fetchDimensionFromHttpd / describeDimension
//      against a stubbed radicle-httpd (fetchImpl).
//   2. radicle-adapter.mjs mobile publish (CHAOSD6_MOBILE=1) against a stub
//      bridge HTTP server on 127.0.0.1: exact /publish body, token header, path
//      validation, and "no publish feature" → silent { pushed:false }.
// Usage: node tools/dims-httpd-check.mjs   (from game/)
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
process.on('unhandledRejection', e => fail(e?.stack || e));

// ---------------------------------------------------------------- 1. httpd read
const { listDimensionsFromHttpd, fetchDimensionFromHttpd, describeDimension, DOOR_LIVE_MS } = await import('../join-plan.mjs');

const NOW = Date.parse('2026-11-13T12:00:00Z');
const iso = msAgo => new Date(NOW - msAgo).toISOString();
const NS_A = 'z6MkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NS_B = 'z6MkBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const door = (peer, pushedAt, extra = {}) => ({
  door_version: 2, door_id: peer, peer_id: peer, name: peer.replace('peer:', ''), alliance: 'player',
  character_id: 'c1', creature_id: 'cr1', tile: { q: 1, r: 2 }, life: 5, life_max: 7,
  clock: { turn: 4, round: 1, action: 0 }, known_members: [{ peer_id: peer, name: 'x', last_seen: pushedAt }],
  known_tiles: [{ q: 0, r: 0 }, { q: 1, r: 0 }], map: { tiles_known: 25, blocks: [{ kind: 'rect' }] }, pushed_at: pushedAt, ...extra,
});
const dimDoc = name => ({ dimension_id: `dim-${name.toLowerCase()}`, dimension_name: name });
// commit sha → { relPath: json }
const commits = {
  a_alpha:  { 'ActiveDimensions/Alpha/dimension.json': dimDoc('Alpha'), 'ActiveDimensions/Alpha/doors/p-alpha.json': door('peer:alpha', iso(10 * 60_000)) },
  a_shared: { 'ActiveDimensions/Shared/dimension.json': dimDoc('Shared'),
              'ActiveDimensions/Shared/doors/p1.json': door('peer:p1', iso(5 * 60_000)),
              'ActiveDimensions/Shared/doors/p2.json': door('peer:p2', iso(30_000), { clock: { turn: 9 } }),
              'ActiveDimensions/Shared/doors/door-primary.json': { door_id: 'legacy', last_push: { at: iso(99 * 60_000) } } },
  b_beta:   { 'ActiveDimensions/Beta/dimension.json': dimDoc('Beta'), 'ActiveDimensions/Beta/doors/p-beta.json': door('peer:beta', iso(60_000)) },
  b_shared: { 'ActiveDimensions/Shared/dimension.json': dimDoc('Shared'),
              'ActiveDimensions/Shared/doors/p1.json': door('peer:p1', iso(10_000), { clock: { turn: 6 } }) },
  b_broken: { 'ActiveDimensions/Broken/doors/x.json': door('peer:x', iso(1000)) },   // no dimension.json → skipped
};
const remotes = [
  { id: NS_A, alias: 'a', heads: { main: 'm1', 'ActiveDimensions/Alpha': 'a_alpha', 'ActiveDimensions/Shared': 'a_shared' } },
  { id: NS_B, alias: 'b', heads: { 'ActiveDimensions/Beta': 'b_beta', 'ActiveDimensions/Shared': 'b_shared', 'ActiveDimensions/Broken': 'b_broken' } },
];
const BASE = 'https://seed.test/api/v1/repos/rad:zTEST';
let inFlight = 0, maxInFlight = 0; const seen = [];
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
async function fakeFetch(url, opts) {
  assert.ok(opts?.signal, 'every request carries a timeout signal');
  assert.equal(opts.headers?.Accept, 'application/json');
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await new Promise(r => setTimeout(r, 2));
    assert.ok(url.startsWith(`${BASE}/`), `unexpected url ${url}`);
    const tail = url.slice(BASE.length + 1); seen.push(tail);
    if (tail === 'remotes') return res(200, remotes);
    let m = tail.match(/^blob\/([^/]+)\/(.+)$/);
    if (m) { const f = commits[m[1]]?.[m[2]]; return f ? res(200, { content: JSON.stringify(f) }) : res(404, { error: 'nope' }); }
    m = tail.match(/^tree\/([^/]+)\/(.+)$/);
    if (m) {
      const files = Object.keys(commits[m[1]] || {}).filter(k => k.startsWith(`${m[2]}/`)).map(k => k.slice(m[2].length + 1));
      const time = Math.floor((NOW - ({ a_alpha: 600, a_shared: 30, b_beta: 60, b_shared: 10, b_broken: 1 }[m[1]] ?? 0) * 1000) / 1000);
      return files.length ? res(200, { entries: files.map(name => ({ name, kind: 'blob', oid: `${m[1]}:${name}` })), lastCommit: { committer: { time } } }) : res(404, {});
    }
    return res(404, {});
  } finally { inFlight--; }
}

const list = await listDimensionsFromHttpd({ seedHost: 'seed.test', rid: 'zTEST', concurrency: 3, fetchImpl: fakeFetch });
assert.deepEqual(list.map(d => d.dimension_name), ['Shared', 'Beta', 'Alpha'], 'newest first, Broken skipped');
assert.ok(maxInFlight <= 3 && maxInFlight >= 2, `concurrency bounded (max in flight ${maxInFlight})`);
const shared = list[0];
assert.deepEqual(Object.keys(shared).sort(), ['dimension', 'dimension_id', 'dimension_name', 'doors', 'legacy_doors', 'namespaces']);
assert.deepEqual(shared.namespaces, [NS_A, NS_B]);
assert.equal(shared.dimension_id, 'dim-shared');
assert.deepEqual(shared.doors.map(d => [d.peer_id, d.nid]), [['peer:p1', NS_B], ['peer:p2', NS_A]], 'p1 newest copy (ns B) wins, newest Door first');
assert.equal(shared.doors[0].commit, 'b_shared');
assert.equal(shared.doors[0].ref, `refs/namespaces/${NS_B}/refs/heads/ActiveDimensions/Shared`);
assert.equal(shared.legacy_doors.length, 1);
assert.equal(list[1].namespaces[0], NS_B); assert.equal(list[2].namespaces[0], NS_A);
seen.length = 0;
const top = await listDimensionsFromHttpd({ seedHost: 'seed.test', rid: 'zTEST', limit: 1, fetchImpl: fakeFetch });
assert.deepEqual(top.map(d => d.dimension_name), ['Shared'], 'limit 1 → freshest by tree lastCommit');
assert.ok(!seen.some(t => t.startsWith('blob/') && !/\/(Shared|Broken)\//.test(t)), 'limit: blobs of lower-ranked dimensions are never read (Broken ranks first, is unreadable, Shared backfills)');
seen.length = 0;
const top2 = await listDimensionsFromHttpd({ seedHost: 'seed.test', rid: 'zTEST', limit: 2, fetchImpl: fakeFetch });
assert.deepEqual(top2.map(d => d.dimension_name), ['Shared', 'Beta'], 'Broken (ranked 1st, unreadable) is backfilled by Beta');

const one = await fetchDimensionFromHttpd({ seedHost: 'seed.test', rid: 'rad:zTEST', dimensionName: 'Shared', fetchImpl: fakeFetch });
assert.deepEqual(one.doors.map(d => d.peer_id), ['peer:p1', 'peer:p2']);
assert.equal(await fetchDimensionFromHttpd({ seedHost: 'seed.test', rid: 'zTEST', dimensionName: 'Nope', fetchImpl: fakeFetch }), null);
await assert.rejects(listDimensionsFromHttpd({ seedHost: 'seed.test', rid: 'zTEST', fetchImpl: async () => res(500, {}) }), /HTTP 500/, '/remotes failure is fatal');

const desc = describeDimension(shared, NOW);
assert.equal(desc.dimension_name, 'Shared'); assert.equal(desc.dimension_id, 'dim-shared');
assert.deepEqual(desc.namespaces, [NS_A, NS_B]);
assert.equal(desc.doors.length, 2); assert.equal(desc.live_doors, 2);
assert.deepEqual(desc.doors[0], {
  peer_id: 'peer:p1', name: 'p1', alliance: 'player', character_id: 'c1', creature_id: 'cr1', tile: { q: 1, r: 2 }, life: 5, life_max: 7,
  clock: { turn: 6 }, pushed_at: iso(10_000), age_sec: 10, live: true, nid: NS_B, commit: 'b_shared',
  known_members: 1, known_tiles: 2, map_tiles: 25, map_blocks: 1, map_sketch: null,
  map_hexes: null, map_share: null, mine_share: null,   // its one block is not a valid block → no exact share
});
assert.equal(desc.map_share_median, null); assert.equal(desc.mine_cover, null); assert.ok(!('map_share_best' in desc), 'the summary has the median Door, not the best');
assert.equal(desc.new_team_side, 'player_c', 'two player Doors (side A) → a new team is player_c');
assert.deepEqual(desc.units_sides, { A: 2, B: 0, C: 0, D: 0 });
assert.ok(Array.isArray(desc.units) && desc.units.length === 2 && desc.units.every(u => u.group === 'ally'), 'units: the two player Doors');
assert.equal(desc.turn, 9); assert.equal(desc.legacy, false);
assert.equal(desc.newest_push, iso(10_000)); assert.equal(desc.age_sec, 10);
assert.ok(Array.isArray(desc.members));
// Live window = the Door cadence (user ruling 2026-11-15, corrected): 2 × RADICLE_PUSH_SEC (600 s) + 5 min = 25 min.
assert.equal(DOOR_LIVE_MS, 25 * 60_000, 'DOOR_LIVE_MS = 2 push intervals + 5 min');
const stale = describeDimension(list[2], NOW + DOOR_LIVE_MS);
assert.equal(stale.live_doors, 0); assert.equal(stale.turn, 0);
const legacyOnly = describeDimension({ dimension_name: 'Old Thing', doors: [], namespaces: [], legacy_doors: [{ last_push: { at: iso(60_000) } }] }, NOW);
assert.equal(legacyOnly.legacy, true); assert.equal(legacyOnly.dimension_id, 'dim-old-thing'); assert.equal(legacyOnly.age_sec, 60);
console.log(`ok  httpd list/fetch/describe (${seen.length} requests)`);

// ---------------------------------------------------------------- 1b. exact map shares + alive units
{
  const { dimensionMapShares, dimensionUnits } = await import('../join-plan.mjs');
  const { initialBlock, discBlock } = await import('../js/map.js');
  const { hexDistance } = await import('../js/hex.js');
  const { saveTileKeys, mineMapsOf } = await import('../dims-local.mjs');
  const { tmjFromSnapshot } = await import('./autosave.mjs');
  const SEED = '0xfeedbeef';
  // Independent oracle: hex sets by brute force (no blockTiles / createKnownMap).
  const rectSet = (q0, r0, w, h) => { const s = new Set(); for (let r = r0; r < r0 + h; r++) for (let q = q0; q < q0 + w; q++) s.add(`${q},${r}`); return s; };
  const discSet = (cq, cr, R) => { const s = new Set(); for (let q = cq - R; q <= cq + R; q++) for (let r = cr - R; r <= cr + R; r++) if (hexDistance({ q, r }, { q: cq, r: cr }) <= R) s.add(`${q},${r}`); return s; };
  const U = (...ss) => { const o = new Set(); for (const s of ss) for (const k of s) o.add(k); return o; };
  const I = (a, b) => [...a].filter(k => b.has(k)).length;
  const G = rectSet(0, 0, 5, 5), DA = discSet(20, 20, 3), DB = discSet(22, 20, 3), DM = discSet(20, 20, 1);
  const A = U(G, DA), B = U(G, DB), UNION = U(A, B), MINE = U(G, DM, new Set(['50,50']));
  assert.ok(I(DA, DB) > 0 && I(DA, DB) < DA.size, 'the two discs overlap partly');
  const shareDim = { dimension_name: 'Share-Dim', dimension_id: 'dim-share-dim', namespaces: [], legacy_doors: [], doors: [
    { door_version: 2, peer_id: 'peer:a', name: 'A', alliance: 'player', pushed_at: iso(5_000), commit: 'c1', tile: { q: 20, r: 20 }, life: 4, life_max: 4,
      map: { seed: SEED, blocks: [initialBlock(), discBlock(20, 20, 3, 'peer:a', 'x')] } },
    { door_version: 2, peer_id: 'peer:b', name: 'B', alliance: 'npc_b', creature_id: 'mon_x', pushed_at: iso(9 * 60_000), commit: 'c2', tile: { q: 22, r: 20 }, life: 6, life_max: 6,
      map: { seed: SEED, blocks: [initialBlock(), discBlock(22, 20, 3, 'peer:b', 'y')] } },
    { door_version: 2, peer_id: 'peer:old', name: 'Old', alliance: 'player_c', pushed_at: iso(60 * 60_000), map_tiles: 12 },   // no blocks (older build)
  ] };
  // My saved copy as a real TMJ (autosave.mjs writer) → saveTileKeys must read back exactly G ∪ DM ∪ {50,50}.
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dims-share-'));
  fs.mkdirSync(path.join(tdir, 'dim-share-dim'));
  const tmjFile = path.join(tdir, 'dim-share-dim', 'map_autosave.tmj');
  fs.writeFileSync(tmjFile, JSON.stringify(tmjFromSnapshot({ seed: SEED, blocks: [initialBlock(), discBlock(20, 20, 1, 'me', 'z'), discBlock(50, 50, 0, 'me', 'z')], meta: { dim_id: 'dim-share-dim', dim_name: 'Share-Dim' } })));
  const mine = await saveTileKeys(tmjFile);
  assert.equal(mine.size, MINE.size, `save hexes ${mine?.size} vs ${MINE.size}`); assert.equal(I(mine, MINE), MINE.size, 'save hex set exact');
  assert.equal(await saveTileKeys(tmjFile), mine, 'saveTileKeys memoised per mtime');
  const mines = await mineMapsOf([{ dim_id: 'dim-share-dim', dim_name: 'Share-Dim', path: tmjFile }]);
  assert.equal(mines.get('dim-share-dim'), mine);
  const r3 = x => Math.round(x * 1000) / 1000;
  const sh = dimensionMapShares(shareDim, { mine });
  assert.equal(sh.union_hexes, UNION.size);
  assert.deepEqual(sh.doors.get('peer:a'), { hexes: A.size, share: r3(A.size / UNION.size), mine_share: r3(I(A, MINE) / MINE.size) });
  assert.deepEqual(sh.doors.get('peer:b'), { hexes: B.size, share: r3(B.size / UNION.size), mine_share: r3(I(B, MINE) / MINE.size) });
  assert.equal(sh.doors.has('peer:old'), false);
  assert.equal(sh.best, r3(Math.max(A.size, B.size) / UNION.size)); assert.equal(sh.mine_cover, r3(I(MINE, UNION) / UNION.size));
  // Median Door (user ruling 2026-11-15): two Doors with blocks → the mean of their shares (Old has no blocks, not counted).
  assert.equal(sh.median, r3((r3(A.size / UNION.size) + r3(B.size / UNION.size)) / 2));
  assert.equal(dimensionMapShares(shareDim, { mine }).doors.get('peer:a').hexes, A.size, 'memoised union gives the same');
  const dd = describeDimension(shareDim, NOW, { mine });
  const da = dd.doors.find(p => p.peer_id === 'peer:a'), dold = dd.doors.find(p => p.peer_id === 'peer:old');
  assert.equal(da.map_share, r3(A.size / UNION.size)); assert.equal(da.map_hexes, A.size); assert.equal(da.mine_share, r3(I(A, MINE) / MINE.size));
  assert.equal(dold.map_share, null); assert.equal(dd.hexes, UNION.size); assert.equal(dd.mine_hexes, MINE.size);
  assert.equal(dd.map_share_median, sh.median);
  {
    const { medianOf } = await import('../join-plan.mjs');
    assert.equal(medianOf([0.9, 0.1, 0.5]), 0.5); assert.equal(medianOf([0.2, 0.8, 0.4, 0.6]), 0.5); assert.equal(medianOf([]), null); assert.equal(medianOf([0.333]), 0.333);
  }
  assert.ok(!JSON.stringify(dd).includes('"blocks"'), 'no block lists in the launcher payload');
  console.log(`ok  exact shares: A ${A.size}/${UNION.size} = ${da.map_share}, B ${B.size}/${UNION.size}, mine A ${da.mine_share} · cover ${dd.mine_cover}`);

  // Units: newest sighting wins (P1 saw P2 later than P2's own Door), dead in the newest record drop out,
  // groups from the player side, `via` = the reporting Door, no age cut-off (quiet dimension).
  const doorsU = [
    { peer_id: 'peer:p1', name: 'P1', alliance: 'player', pushed_at: iso(40 * 60_000), tile: { q: 1, r: 1 }, life: 5, life_max: 5, known_members: [
      { peer_id: 'peer:p2', name: 'P2', alliance: 'player_c', tile: { q: 4, r: 4 }, life: 1, life_max: 3, last_seen: iso(41 * 60_000) },
      { peer_id: 'peer:mino', name: 'Minotaur', alliance: 'npc_b', creature_id: 'mon_m', tile: { q: 2, r: 3 }, life: 7, life_max: 9, last_seen: iso(40 * 60_000) },
      { peer_id: 'peer:x', name: 'X', alliance: 'npc_a', tile: { q: 0, r: 4 }, life: 0, life_max: 4, last_seen: iso(40 * 60_000) },
      { peer_id: 'peer:helper', name: 'Helper', alliance: 'npc_a', tile: { q: 3, r: 0 }, life: 2, life_max: 4, last_seen: iso(40 * 60_000) },
    ] },
    { peer_id: 'peer:p2', name: 'P2', alliance: 'player_c', pushed_at: iso(42 * 60_000), tile: { q: 4, r: 3 }, life: 3, life_max: 3, known_members: [
      { peer_id: 'peer:x', name: 'X', alliance: 'npc_a', tile: { q: 0, r: 4 }, life: 4, life_max: 4, last_seen: iso(42 * 60_000) },
    ] },
  ];
  const uu = dimensionUnits(doorsU, NOW);
  const byId = Object.fromEntries(uu.units.map(u => [u.peer_id, u]));
  assert.deepEqual(uu.units.map(u => u.peer_id), ['peer:helper', 'peer:p1', 'peer:p2', 'peer:mino'], 'allies, enemies, monsters (same age → by name); X is dead');
  assert.deepEqual(uu.alive, { ally: 2, enemy: 1, monster: 1 }); assert.equal(uu.dead, 1);
  assert.deepEqual([byId['peer:p2'].life, byId['peer:p2'].via, byId['peer:p2'].tile], [1, 'peer:p1', { q: 4, r: 4 }], 'P1 saw P2 after P2\'s own Door');
  assert.equal(byId['peer:mino'].group, 'monster'); assert.equal(byId['peer:mino'].kind, 'creature'); assert.equal(byId['peer:p1'].via, 'peer:p1');
  assert.ok(uu.units.every(u => u.via_live === false), 'quiet: every reporting Door is stale, units still listed');
  fs.rmSync(tdir, { recursive: true, force: true });
  console.log(`ok  units: ${uu.units.map(u => `${u.name}(${u.group})`).join(' ')}, ${uu.dead} dead`);
}

// ---------------------------------------------------------------- 1c. third team, no cloning, quiet regeneration (2026-11-15)
{
  const jp = await import('../join-plan.mjs');
  const { initialBlock, discBlock } = await import('../js/map.js');
  const { hexDistance } = await import('../js/hex.js');
  // New team (rulings 2026-11-15): the first FREE side of A, C, D; monsters (B) never count; all taken → null.
  assert.equal(jp.newTeamSide({}), 'player');
  assert.equal(jp.newTeamSide({ A: 3, B: 5 }), 'player_c');
  assert.equal(jp.newTeamSide({ C: 2 }), 'player');
  assert.equal(jp.newTeamSide({ A: 1, C: 2 }), 'player_d', '"Fourth team is joining at 4th side"');
  assert.equal(jp.newTeamSide({ A: 1, C: 1, D: 1 }), null, 'all three taken → refused, never merged');
  assert.match(jp.NO_FREE_SIDE, /no free side/);
  assert.equal(jp.teamBotSide('player'), 'npc_a'); assert.equal(jp.teamBotSide('player_c'), 'npc_c'); assert.equal(jp.teamBotSide('player_d'), 'npc_d');
  assert.deepEqual(['player', 'npc_a', 'npc_b', 'player_c', 'npc_c', 'player_d', 'npc_d'].map(jp.sideOfAlliance), ['A', 'A', 'B', 'C', 'C', 'D', 'D']);
  {
    const dimD = { dimension_name: 'D-Dim', namespaces: [], legacy_doors: [], doors: [
      { peer_id: 'peer:PA', name: 'PA', alliance: 'player', tile: { q: 0, r: 0 }, life: 3, pushed_at: iso(60 * 60_000) },
      { peer_id: 'peer:PC', name: 'PC', alliance: 'player_c', tile: { q: 6, r: 0 }, life: 3, pushed_at: iso(60 * 60_000) }] };
    const uD = jp.dimensionUnits(dimD.doors);
    assert.deepEqual(uD.sides, { A: 1, B: 0, C: 1, D: 0 });
    assert.equal(jp.describeDimension(dimD, NOW).new_team_side, 'player_d');
    // "… on a door that is distant to them": the new Door is 30–50 from its anchor AND >= 30 from every foe unit.
    for (let i = 0; i < 6; i++) {
      const pd = jp.planJoin(dimD, { doorId: 'peer:PA', side: 'player_d', placement: 'far', label: `D${i}` });
      const da = hexDistance(pd.startTile, { q: 0, r: 0 }), dc = hexDistance(pd.startTile, { q: 6, r: 0 });
      assert.ok(da >= jp.FAR_MIN && da <= jp.FAR_MAX && dc >= jp.FAR_MIN, `D Door distant to them (A ${da}, C ${dc})`);
    }
    // Other TEAMS only (ruling 2026-11-15): a wild monster next to the picked hex changes nothing; a summon there
    // counts with its owner's side (C) → the Door moves ≥ 30 away from it.
    const base0 = jp.planJoin(dimD, { doorId: 'peer:PA', side: 'player_d', placement: 'far', label: 'Dm' }).startTile;
    const nb = { q: base0.q + 1, r: base0.r };
    const withMon = (extra) => ({ ...dimD, doors: [{ ...dimD.doors[0], known_members: [{ alliance: 'npc_b', tile: nb, life: 5, last_seen: iso(60 * 60_000), ...extra }] }, dimD.doors[1]] });
    const pw = jp.planJoin(withMon({ peer_id: 'peer:wild', creature_id: 'mon_wolf' }), { doorId: 'peer:PA', side: 'player_d', placement: 'far', label: 'Dm' }).startTile;
    assert.deepEqual(pw, base0, 'a wild monster is no team: the D Door may sit next to it');
    const ps = jp.planJoin(withMon({ peer_id: 'peer:summ', creature_id: 'mon_imp', owner_peer_id: 'peer:PC' }), { doorId: 'peer:PA', side: 'player_d', placement: 'far', label: 'Dm' }).startTile;
    assert.ok(hexDistance(ps, nb) >= jp.FAR_MIN, `a summon counts with its owner's side (${hexDistance(ps, nb)} from it)`);
  }
  // Monster join = the known type (ruling 2026-11-15): the monster at nearTile, else a monster anchor Door's
  // creature, else the commonest wild alive type (ties alphabetical); none → null (caller: random).
  {
    const T = iso(60 * 60_000);
    const md = { dimension_name: 'M-Dim', doors: [
      { peer_id: 'peer:H', name: 'H', alliance: 'player', creature_id: '', tile: { q: 0, r: 0 }, life: 3, pushed_at: T, known_members: [
        { peer_id: 'peer:w1', alliance: 'npc_b', creature_id: 'mon_wolf', tile: { q: 1, r: 1 }, life: 2, last_seen: T },
        { peer_id: 'peer:w2', alliance: 'npc_b', creature_id: 'mon_wolf', tile: { q: 2, r: 1 }, life: 2, last_seen: T },
        { peer_id: 'peer:w3', alliance: 'npc_b', creature_id: 'mon_wolf', tile: { q: 3, r: 1 }, life: 2, last_seen: T },
        { peer_id: 'peer:m1', alliance: 'npc_b', creature_id: 'mon_ruinous_minotaur', tile: { q: 5, r: 5 }, life: 9, last_seen: T },
        { peer_id: 'peer:s1', alliance: 'npc_b', creature_id: 'mon_imp', owner_peer_id: 'peer:H', tile: { q: 4, r: 4 }, life: 1, last_seen: T },
        { peer_id: 'peer:s2', alliance: 'npc_b', creature_id: 'mon_imp', owner_peer_id: 'peer:H', tile: { q: 4, r: 5 }, life: 1, last_seen: T },
        { peer_id: 'peer:s3', alliance: 'npc_b', creature_id: 'mon_imp', owner_peer_id: 'peer:H', tile: { q: 4, r: 6 }, life: 1, last_seen: T },
        { peer_id: 'peer:dz', alliance: 'npc_b', creature_id: 'mon_zombie', tile: { q: 7, r: 7 }, life: 0, last_seen: T }] },
      { peer_id: 'peer:Mino', name: 'Mino', alliance: 'npc_b', creature_id: 'mon_ruinous_minotaur', tile: { q: 5, r: 5 }, life: 9, pushed_at: T }] };
    assert.equal(jp.knownMonsterType(md, { nearTile: { q: 5, r: 5 } }), 'mon_ruinous_minotaur', 'the monster I click');
    assert.equal(jp.knownMonsterType(md, { doorId: 'peer:Mino' }), 'mon_ruinous_minotaur', 'a monster Door: its own type');
    assert.equal(jp.knownMonsterType(md, { doorId: 'peer:H' }), 'mon_wolf', 'else the commonest wild alive type (summons, dead out)');
    assert.equal(jp.knownMonsterType(md, { nearTile: { q: 7, r: 7 } }), 'mon_wolf', 'a dead one is no type source');
    assert.equal(jp.knownMonsterType({ doors: [{ peer_id: 'peer:x', alliance: 'player', creature_id: 'cr1', tile: { q: 0, r: 0 }, life: 1, pushed_at: T }] }, { doorId: 'peer:x' }), null, 'no monster known → null');
  }
  // No cloning: profile id first, base character + name for older Doors; dead in the newest record → allowed.
  const me = { id: 'pc_aaaa1111', name: 'Larkin', base_character: 'char_oran_rief' };
  const mate = { id: 'pc_bbbb2222', name: 'Mira', base_character: 'char_pride_guardian' };
  const ghost = { id: 'pc_cccc3333', name: 'Ghost', base_character: 'char_x' };
  const OLDT = iso(60 * 60_000), NEWT = iso(30 * 60_000);
  const cloneDoors = [
    { peer_id: 'peer:P-Larkin', name: 'Larkin', alliance: 'player', character_id: 'char_oran_rief', profile_char_id: 'pc_aaaa1111', tile: { q: 1, r: 1 }, life: 3, life_max: 5, pushed_at: OLDT, known_members: [
      { peer_id: 'peer:P-Larkin-ally1', name: 'Mira', alliance: 'npc_a', character_id: 'char_pride_guardian', tile: { q: 2, r: 1 }, life: 0, life_max: 4, last_seen: OLDT },   // dead, older Door (no profile id)
      { peer_id: 'peer:Gh', name: 'Ghost', alliance: 'player', character_id: 'char_x', profile_char_id: 'pc_other', tile: { q: 0, r: 0 }, life: 4, last_seen: OLDT },          // same name, other profile id
    ] },
  ];
  let hits = jp.aliveProfileUnits(cloneDoors, [me, mate, ghost]);
  assert.deepEqual(hits.map(h => h.character.id), ['pc_aaaa1111'], 'Larkin alive (profile id); Mira dead; Ghost is somebody else');
  assert.match(jp.aliveText(hits), /Larkin \(as P-Larkin, hp 3\): you are already alive in this dimension — rejoin\/restore instead/);
  // Larkin died later (another Door saw it) → allowed again; an old-format record (no profile id) matches by base + name.
  const later = [...cloneDoors, { peer_id: 'peer:Obs', name: 'Obs', alliance: 'player_c', tile: { q: 9, r: 9 }, life: 2, pushed_at: NEWT, known_members: [
    { peer_id: 'peer:P-Larkin', name: 'Larkin', alliance: 'player', character_id: 'char_oran_rief', profile_char_id: 'pc_aaaa1111', tile: { q: 1, r: 2 }, life: 0, last_seen: NEWT },
    { peer_id: 'peer:M2', name: 'Mira', alliance: 'npc_a', character_id: 'char_pride_guardian', tile: { q: 3, r: 3 }, life: 2, last_seen: NEWT } ] }];
  hits = jp.aliveProfileUnits(later, [me, mate]);
  assert.deepEqual(hits.map(h => h.character.id), ['pc_bbbb2222'], 'dead Larkin allowed; old-format Mira record matched by base + name');
  // One dimension at a time (ruling 2026-11-15): alive in ANY dimension → named; raw dims (doors) or listed items
  // (alive_chars) alike; the first item of a name wins (the freshly fetched target before the cached list).
  const dA = { dimension_name: 'Dim-A', doors: cloneDoors }, dB = { dimension_name: 'Dim-B', doors: later };
  let where = jp.aliveInDimensions([dA, dB], [me, mate, ghost]);
  assert.deepEqual(where.map(h => `${h.character.name}@${h.dimension_name}`), ['Larkin@Dim-A', 'Mira@Dim-B']);
  assert.match(jp.aliveWhereText(where), /^Larkin \(as P-Larkin, hp 3\) is alive in Dim-A — rejoin\/restore there; Mira \(as M2, hp 2\) is alive in Dim-B/);
  where = jp.aliveInDimensions([{ dimension_name: 'Dim-A', doors: later }, dA, jp.describeDimension(dB, NOW)], [me]);
  assert.deepEqual(where, [], 'dead Larkin in the fresh Dim-A wins over the stale cached copy; dead in Dim-B too');
  const dl = jp.describeDimension({ dimension_name: 'Clone-Dim', doors: later, namespaces: [], legacy_doors: [] }, NOW);
  assert.ok(dl.alive_chars.some(m => m.profile_char_id === null && m.name === 'Mira') && !dl.alive_chars.some(m => m.peer_id === 'peer:P-Larkin'), 'alive_chars: every alive character, dead ones out');
  // Quiet regeneration: alive npc_b creatures without owner, newest record, valid tile; nearest `max` to the join point.
  const SEED = '0xabc12345';
  const regDoors = [{ door_version: 2, peer_id: 'peer:R-Hero', name: 'R-Hero', alliance: 'player', tile: { q: 2, r: 2 }, life: 4, life_max: 4, pushed_at: OLDT, commit: 'r1',
    map: { seed: SEED, blocks: [initialBlock(), discBlock(2, 2, 12, 'peer:R-Hero', OLDT)] },
    known_members: [
      ...Array.from({ length: 9 }, (_, i) => ({ peer_id: `peer:mon${i}`, name: `Mon ${i}`, alliance: 'npc_b', creature_id: 'mon_ruinous_minotaur', tile: { q: 2 + i, r: 4 }, life: 3 + (i % 3), life_max: 9, last_seen: OLDT })),
      { peer_id: 'peer:dead-mon', name: 'Dead', alliance: 'npc_b', creature_id: 'mon_x', tile: { q: 3, r: 3 }, life: 0, last_seen: OLDT },
      { peer_id: 'peer:sum', name: 'Summon', alliance: 'npc_b', creature_id: 'mon_x', owner_peer_id: 'peer:somebody', tile: { q: 1, r: 3 }, life: 3, last_seen: OLDT },
      { peer_id: 'peer:npcb-hero', name: 'Hero B', alliance: 'npc_b', character_id: 'char_oran_rief', tile: { q: 0, r: 3 }, life: 3, last_seen: OLDT },
      { peer_id: 'peer:other-ally', name: 'Ally', alliance: 'npc_a', character_id: 'char_pride_guardian', tile: { q: 0, r: 2 }, life: 3, last_seen: OLDT },
    ] }];
  const qm = jp.quietMonsters(regDoors);
  assert.deepEqual(qm.map(m => m.peer_id).sort(), Array.from({ length: 9 }, (_, i) => `peer:mon${i}`).sort(), 'only wild alive monsters (no dead, no summon, no heroes / allies)');
  assert.deepEqual(qm.find(m => m.peer_id === 'peer:mon4'), { peer_id: 'peer:mon4', label: 'mon4', name: 'Mon 4', creature_id: 'mon_ruinous_minotaur', tile: { q: 6, r: 4 }, life: 4, life_max: 9 });
  const near = jp.nearestMonsters(qm, { q: 2, r: 4 }, 6);
  assert.deepEqual(near.map(m => m.label), ['mon0', 'mon1', 'mon2', 'mon3', 'mon4', 'mon5'], 'capped to the 6 nearest');
  const qdim = { dimension_name: 'Regen-Dim', doors: regDoors, namespaces: [], legacy_doors: [] };
  const pjq = jp.planJoin(qdim, { doorId: 'peer:R-Hero', side: 'player', placement: 'nearby', nearTile: { q: 2, r: 4 }, regen: true, regenMax: 4 });
  assert.equal(pjq.regen.length, 4); assert.equal(pjq.regenKnown, 9);
  assert.ok(!qm.some(m => m.tile.q === pjq.startTile.q && m.tile.r === pjq.startTile.r), 'my start tile is never a regenerated monster\'s tile');
  const dists = pjq.regen.map(m => hexDistance(m.tile, pjq.startTile));
  assert.ok(qm.filter(m => !pjq.regen.some(x => x.peer_id === m.peer_id)).every(m => hexDistance(m.tile, pjq.startTile) >= Math.max(...dists)), 'the regenerated ones are the nearest to my start tile');
  assert.equal(jp.planJoin(qdim, { doorId: 'peer:R-Hero', side: 'player', placement: 'nearby', nearTile: { q: 2, r: 4 } }).regen.length, 0, 'regen off by default');
  const liveDim = { ...qdim, doors: [{ ...regDoors[0], pushed_at: new Date(Date.now() - 20 * 60_000).toISOString() }] };
  assert.equal(jp.planJoin(liveDim, { doorId: 'peer:R-Hero', side: 'player', placement: 'nearby', nearTile: { q: 2, r: 4 }, regen: true }).regen.length, 0, 'a Door pushed 20 min ago is live (< 25 min) → nothing regenerated');
  const quiet26 = { ...qdim, doors: [{ ...regDoors[0], pushed_at: new Date(Date.now() - 26 * 60_000).toISOString() }] };
  assert.equal(jp.planJoin(quiet26, { doorId: 'peer:R-Hero', side: 'player', placement: 'nearby', nearTile: { q: 2, r: 4 }, regen: true, regenMax: 4 }).regen.length, 4, '26 min ago → quiet → regenerated');
  console.log(`ok  new team A/C/D + distant Door / known monster type / one dimension at a time / regen (live < 25 min): ${pjq.regen.map(m => `${m.label}@${m.tile.q},${m.tile.r}`).join(' ')} of ${pjq.regenKnown} near ${pjq.startTile.q},${pjq.startTile.r}`);
}

// ---------------------------------------------------------------- 2. mobile publish
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dims-check-'));
const bridgeFile = path.join(tmp, 'bridge.json');
const TOKEN = 'tok-123'; const NID = 'z6MkPhoneNodeNid';
let reply = { ok: true, oid: 'f'.repeat(40) }; const got = [];
const srv = http.createServer((req, res2) => {
  let buf = ''; req.on('data', c => { buf += c; });
  req.on('end', () => {
    got.push({ method: req.method, url: req.url, token: req.headers['x-bridge-token'], type: req.headers['content-type'], body: JSON.parse(buf || 'null') });
    res2.writeHead(200, { 'content-type': 'application/json' }); res2.end(JSON.stringify(reply));
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const writeBridge = features => fs.writeFileSync(bridgeFile, JSON.stringify({ port, token: TOKEN, nid: NID, ...(features ? { features } : {}) }));
writeBridge(['save', 'publish']);
process.env.CHAOSD6_MOBILE = '1';
process.env.CHAOSD6_RADICLE_BRIDGE = bridgeFile;
delete process.env.RADICLE_DIMS_RID;
const ad = await import('../radicle-adapter.mjs');

assert.equal(ad.dimensionBranch('Ashfall-Micro'), 'ActiveDimensions/Ashfall-Micro');
for (const ok of ['Ashfall-Micro', 'REL7-Ashfall-Micro', 'Swarm-0236', 'a_b.c']) assert.ok(ad.isValidDimensionName(ok), ok);
for (const bad of ['', 'two words', 'a/b', 'a..b', '.x', 'x.', 'x.lock', 'a:b', 'a~b', 'a^b', 'a?b', 'a*b', 'a[b', 'a\\b', '@', 'a@{b', 'tab\t']) assert.ok(!ad.isValidDimensionName(bad), JSON.stringify(bad));
assert.deepEqual(ad.dimsIdentity(), { repo: 'rad:z2xbfJfwT3kukR73m8LXmmuvchEwr', namespace: NID });

const DIM = 'Ashfall-Micro';
const dimensionDoc = { dimension_id: 'dim-ashfall-micro', dimension_name: DIM };
const doorDoc = { door_version: 2, peer_id: 'peer:player-1' };
const files = { [`ActiveDimensions/${DIM}/dimension.json`]: dimensionDoc, [`ActiveDimensions/${DIM}/doors/player-1.json`]: doorDoc };
const removes = [`ActiveDimensions/${DIM}/doors/door-primary.json`, `ActiveDimensions/${DIM}/rules_snapshot_commit`];
const t0 = Math.floor(Date.now() / 1000);
let r = await ad.pushDimension('peer:player-1', DIM, files, removes);
assert.equal(got.length, 1);
const req = got[0];
assert.equal(req.method, 'POST'); assert.equal(req.url, '/publish'); assert.equal(req.token, TOKEN); assert.equal(req.type, 'application/json');
assert.ok(Number.isInteger(req.body.timestamp) && Math.abs(req.body.timestamp - t0) <= 2, 'timestamp = unix seconds');
assert.match(req.body.message, /^\[peer:player-1\] push Ashfall-Micro @ \d{4}-\d\d-\d\dT/);
const { timestamp, message, ...rest } = req.body;
assert.deepEqual(rest, {
  rid: 'rad:z2xbfJfwT3kukR73m8LXmmuvchEwr', ref: 'refs/heads/ActiveDimensions/Ashfall-Micro',
  files: { [`ActiveDimensions/${DIM}/dimension.json`]: JSON.stringify(dimensionDoc, null, 2), [`ActiveDimensions/${DIM}/doors/player-1.json`]: JSON.stringify(doorDoc, null, 2) },
  remove: removes, prune_prefix: 'ActiveDimensions/',
  name: 'peer:player-1', email: 'peer:player-1@chaosd6.local', seed: 'z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT',
});
assert.equal(Object.keys(req.body).length, 10, 'no extra body fields');
assert.equal(r.pushed, true); assert.equal(r.commit, 'f'.repeat(40)); assert.equal(r.branch, `ActiveDimensions/${DIM}`); assert.equal(r.remote.published, true);
assert.ok(r.explorerUrl === null || r.explorerUrl.endsWith(`/rad:z2xbfJfwT3kukR73m8LXmmuvchEwr/commits/${'f'.repeat(40)}`));

reply = { ok: true, oid: 'e'.repeat(40), unchanged: true };
r = await ad.pushDimension('peer:player-1', DIM, files, removes);
assert.equal(r.pushed, false); assert.equal(r.reason, 'no-changes');
reply = { ok: false, error: 'seed unreachable' };
r = await ad.pushDimension('peer:player-1', DIM, files, removes);
assert.equal(r.pushed, false); assert.match(r.reason, /bridge-publish-failed: seed unreachable/);
const n = got.length;
r = await ad.pushDimension('peer:player-1', 'bad name', { 'ActiveDimensions/bad name/dimension.json': '{}' });
assert.equal(r.pushed, false); assert.match(r.reason, /invalid-dimension-name/);
for (const bad of [`ActiveDimensions/${DIM}/../Other/x.json`, `ActiveDimensions/Other/doors/x.json`, `/ActiveDimensions/${DIM}/x.json`, `ActiveDimensions/${DIM}//x.json`, `ActiveDimensions/${DIM}/a\\b.json`, 'README.md']) {
  r = await ad.pushDimension('peer:player-1', DIM, { [bad]: '{}' });
  assert.equal(r.pushed, false, bad); assert.match(r.reason, /invalid-path/, bad);
  r = await ad.pushDimension('peer:player-1', DIM, files, [bad]);
  assert.equal(r.pushed, false, `remove ${bad}`); assert.match(r.reason, /invalid-path/);
}
assert.equal(got.length, n, 'invalid requests never reach the bridge');

reply = { ok: true, oid: 'f'.repeat(40) };
for (const features of [['save'], null]) {
  writeBridge(features);
  r = await ad.pushDimension('peer:player-1', DIM, files, removes);
  assert.deepEqual(r, { pushed: false, reason: 'mobile-peer-no-radicle' }, `features ${JSON.stringify(features)}`);
  assert.deepEqual(ad.dimsIdentity(), { repo: 'rad:local-bare', namespace: null });
  assert.equal(ad.mobileDimsPublisher(), null);
}
fs.rmSync(bridgeFile);
r = await ad.pushDimension('peer:player-1', DIM, files, removes);
assert.deepEqual(r, { pushed: false, reason: 'mobile-peer-no-radicle' }, 'no bridge file');
assert.equal(got.length, n, 'no-publish bridges are never called');
writeBridge(['publish']);
srv.close(); await new Promise(r2 => setTimeout(r2, 50));
r = await ad.pushDimension('peer:player-1', DIM, files, removes);
assert.equal(r.pushed, false); assert.match(r.reason, /bridge-publish-failed/, 'bridge down → pushed:false, not a throw');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok  mobile publish via bridge');

console.log('all dims checks passed');
process.exit(0);
