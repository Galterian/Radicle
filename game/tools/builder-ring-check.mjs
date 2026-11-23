#!/usr/bin/env node
// Offline oracles for builder-ring.mjs (NPC builders' ring wall).   node tools/builder-ring-check.mjs
import assert from 'node:assert/strict';
import { ringHexes, homeIndex, nextWallHex, ringStep, hexDist } from '../builder-ring.mjs';

const c = { q: 0, r: 0 };
const ring = ringHexes(c, 20);
assert.equal(ring.length, 120);
assert.ok(ring.every(h => hexDist(h, c) === 20), 'every hex at radius 20');
assert.equal(new Set(ring.map(h => `${h.q},${h.r}`)).size, 120, 'no duplicates');
for (let i = 0; i < ring.length; i++) assert.equal(hexDist(ring[i], ring[(i + 1) % ring.length]), 1, 'walking order: neighbours');
assert.equal(ring.filter(h => h.gate).length, 6, 'six gates');
assert.deepEqual(ringHexes(c, 0), []);
assert.equal(ringHexes({ q: 3, r: -2 }, 1).length, 6);

const a = homeIndex('builder-1', 120), b = homeIndex('builder-2', 120);
assert.ok(a !== b && a >= 0 && a < 120);
const built = new Set();
const site = nextWallHex({ ring, home: a, built: (q, r) => built.has(`${q},${r}`), blocked: () => false });
assert.ok(site && !site.gate);
built.add(`${site.q},${site.r}`);
const next = nextWallHex({ ring, home: a, built: (q, r) => built.has(`${q},${r}`), blocked: () => false });
assert.notDeepEqual(next, site);
assert.equal(nextWallHex({ ring, home: 0, built: () => true, blocked: () => false }), null, 'ring done');
const skipped = nextWallHex({ ring, home: 0, built: () => false, blocked: (q, r) => q === ring[0].q && r === ring[0].r });
assert.equal(skipped.i, 1, 'blocked hex skipped');

// walking out from the centre gets strictly closer, then builds from a neighbouring hex
let me = { q: 0, r: 0 }, steps = 0;
const target = ring[37];
for (;;) {
  const s = ringStep({ me, site: target, free: () => true });
  assert.ok(s, 'never stuck on open ground');
  if (s.build) break;
  assert.ok(hexDist(s.stepTo, me) === 1);
  me = s.stepTo; steps++;
  assert.ok(steps < 40);
}
assert.equal(hexDist(me, target), 1);
assert.equal(steps, 19);
assert.ok(ringStep({ me: target, site: target, free: () => true }).stepTo, 'standing on the site: step off');
assert.equal(ringStep({ me: { q: 0, r: 0 }, site: target, free: () => false }), null, 'walled in: no step');
// a wall in the way: the path goes round it (greedy stepping got stuck here in the live test)
const wall = new Set(['1,0', '1,-1', '1,1', '0,1', '1,-2']);
let w = { q: 0, r: 0 }, n2 = 0;
const goalSite = { q: 4, r: 0 };
for (;;) {
  const s2 = ringStep({ me: w, site: goalSite, free: (q, r) => !wall.has(`${q},${r}`) });
  assert.ok(s2, 'finds a way round');
  if (s2.build) break;
  assert.ok(!wall.has(`${s2.stepTo.q},${s2.stepTo.r}`));
  w = s2.stepTo; n2++;
  assert.ok(n2 < 20);
}
assert.equal(hexDist(w, goalSite), 1);
assert.equal(ringStep({ me: { q: 0, r: 0 }, site: goalSite, free: (q, r) => Math.abs(q) + Math.abs(r) + Math.abs(q + r) <= 2, maxNodes: 100 }), null, 'enclosed: no path');
console.log('all builder ring checks passed');
