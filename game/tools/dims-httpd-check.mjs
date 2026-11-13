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
  known_members: 1, known_tiles: 2, map_tiles: 25, map_blocks: 1,
});
assert.equal(desc.turn, 9); assert.equal(desc.legacy, false);
assert.equal(desc.newest_push, iso(10_000)); assert.equal(desc.age_sec, 10);
assert.ok(Array.isArray(desc.members));
const stale = describeDimension(list[2], NOW + DOOR_LIVE_MS);
assert.equal(stale.live_doors, 0); assert.equal(stale.turn, 0);
const legacyOnly = describeDimension({ dimension_name: 'Old Thing', doors: [], namespaces: [], legacy_doors: [{ last_push: { at: iso(60_000) } }] }, NOW);
assert.equal(legacyOnly.legacy, true); assert.equal(legacyOnly.dimension_id, 'dim-old-thing'); assert.equal(legacyOnly.age_sec, 60);
console.log(`ok  httpd list/fetch/describe (${seen.length} requests)`);

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
