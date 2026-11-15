// Oracles for game/map-sync.mjs (P2P rework M3): digest, diff, chunking, framing, the pull coordinator
// (in-memory transport + fake clock), rate limiting, back-off, in-flight dedupe and the bus RPC.
//   node tools/map-sync-check.mjs   → "all checks passed"
import { createKnownMap, isBlock } from '../js/map.js';
import {
  N_BUCKETS, MAX_FRAME_BYTES, BUS_FRAME_BYTES, GET_MAX, createDigest, rootOf, encodeSummary, decodeSummary, diffSummaries,
  bucketOf, chunkMessages, encodeFrame, createFrameDecoder, createMapSync, createBusRpc,
} from '../map-sync.mjs';

let fails = 0, checks = 0;
function ok(cond, msg) { checks++; if (!cond) { fails++; console.log(`FAIL ${msg}`); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)?.slice(0, 200)} want ${JSON.stringify(b)?.slice(0, 200)}`); }

// Row-run blocks like a TMJ restore / tools/out/_telem_blocks.mjs: rows r0..r1 inclusive, 23 wide.
function rows(r0, r1, by = 'restore') {
  const out = [];
  for (let r = r0; r <= r1; r++) out.push({ id: `rect:${-11 - Math.floor(r / 2)},${r},23x1`, kind: 'rect', q: -11 - Math.floor(r / 2), r, w: 23, h: 1, by, at: '2026-11-15T00:00:00.000Z' });
  return out;
}
function discs(n, by) { const out = []; for (let i = 0; i < n; i++) out.push({ id: `disc:${i * 7},${-i * 3},6`, kind: 'disc', q: i * 7, r: -i * 3, radius: 6, by, at: '2026-11-15T00:00:00.000Z' }); return out; }

// ---- 1. digest: order independence, idempotence, encode/decode ----
{
  const ids = rows(-31, 30).map(b => b.id);
  const d1 = createDigest(), d2 = createDigest();
  for (const id of ids) d1.add(id);
  for (const id of [...ids].reverse()) d2.add(id);
  eq(d1.root(), d2.root(), 'digest root is order-independent');
  ok(!d1.add(ids[0]) && d1.size() === ids.length, 'digest add is idempotent');
  eq(d1.root().split('.')[0], String(ids.length), 'root carries the id count');
  const enc = encodeSummary(d1.summary());
  eq(decodeSummary(enc), d1.summary(), 'summary encode/decode round-trips');
  eq(rootOf(decodeSummary(enc)), d1.root(), 'root of decoded summary');
  ok(enc.length < 1200, `summary of ${ids.length} ids is small (${enc.length} B)`);
  ok(decodeSummary('1,2') === null && decodeSummary(null) === null, 'bad summaries are rejected');
  eq(diffSummaries(d1.summary(), d2.summary()), [], 'equal sets → no differing buckets');
  const d3 = createDigest(); for (const id of ids) d3.add(id); d3.add('disc:99,99,6');
  eq(diffSummaries(d1.summary(), d3.summary()), [bucketOf('disc:99,99,6')], 'one extra id → exactly its bucket differs');
  ok(d1.root() !== d3.root(), 'one extra id changes the root');
  const inB = d3.idsInBuckets([bucketOf('disc:99,99,6')]);
  ok(inB.includes('disc:99,99,6') && inB.every(id => bucketOf(id) === bucketOf('disc:99,99,6')), 'idsInBuckets lists that bucket only');
  // Same count, different members → still differs (xor/sum, not just counts).
  const e1 = createDigest(), e2 = createDigest();
  for (const id of ids.slice(0, 40)) e1.add(id);
  for (const id of ids.slice(1, 41)) e2.add(id);
  ok(e1.root() !== e2.root() && diffSummaries(e1.summary(), e2.summary()).length >= 1, 'same count, different members → differs');
  // Bucket spread: 1,400 ids land in all 64 buckets, none above 3× the mean.
  const big = createDigest(); for (let i = 0; i < 1400; i++) big.add(`disc:${i},${-i},6`);
  const cs = big.summary().map(x => x[0]);
  ok(cs.every(c => c > 0) && Math.max(...cs) < 3 * 1400 / N_BUCKETS, `bucket spread ok (min ${Math.min(...cs)}, max ${Math.max(...cs)})`);
}

// ---- 2. chunking ----
{
  const blocks = [...rows(-700, 700), ...discs(300, 'peer:x')];
  const msgs = chunkMessages(blocks, bl => ({ t: 'blocks', blocks: bl }), MAX_FRAME_BYTES);
  ok(msgs.length > 1, `chunking splits ${blocks.length} blocks into ${msgs.length} messages`);
  ok(msgs.every(m => Buffer.byteLength(JSON.stringify(m)) <= MAX_FRAME_BYTES), 'every chunk ≤ 32 KB');
  eq(msgs.flatMap(m => m.blocks).map(b => b.id), blocks.map(b => b.id), 'chunks concatenate to the input, in order');
  const bus = chunkMessages(blocks, bl => ({ t: 'blocks', blocks: bl }), BUS_FRAME_BYTES);
  ok(bus.every(m => Buffer.byteLength(JSON.stringify(m)) <= BUS_FRAME_BYTES) && bus.length > msgs.length, 'bus chunks ≤ 24 KB');
  eq(chunkMessages([], ids => ({ t: 'ids', ids })), [{ t: 'ids', ids: [] }], 'empty input → one empty message');
  const fill = Math.floor(MAX_FRAME_BYTES / 0.9);
  const huge = chunkMessages(['x'.repeat(fill)], ids => ({ t: 'ids', ids }));
  eq(huge.length, 1, 'an oversize single item still goes out alone');
}

// ---- 3. framing ----
{
  const objs = [{ t: 'diff', s: 'a'.repeat(5000) }, { t: 'ids', ids: ['x', 'y'] }, { t: 'blocks', blocks: rows(0, 300) }, { t: 'busy' }];
  const wire = Buffer.concat(objs.map(o => Buffer.from(encodeFrame(o))));
  for (const step of [1, 3, 7, 1000, 65536, wire.length]) {
    const dec = createFrameDecoder(); const got = [];
    for (let i = 0; i < wire.length; i += step) got.push(...dec.push(wire.subarray(i, i + step)));
    eq(got, objs, `frames decode across ${step}-byte reads`);
    eq(dec.pending(), 0, `no leftover bytes (${step})`);
  }
  const bad = Buffer.alloc(8); bad.writeUInt32BE(10 * 1024 * 1024, 0);
  let threw = false; try { createFrameDecoder().push(bad); } catch { threw = true; }
  ok(threw, 'oversize frame header is rejected');
}

// ---- in-memory network ----
function makeNet() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const nodes = new Map();
  const net = { msgs: 0, bytes: 0, getIds: [], down: new Set() };
  function makeNode(id, blocks) {
    const map = createKnownMap('seed', blocks);
    const byId = new Map(map.blocks().map(b => [b.id, b]));
    const digest = createDigest(); for (const b of map.blocks()) digest.add(b.id);
    const store = {
      digest, has: (x) => byId.has(x), get: (x) => byId.get(x),
      add(b) { if (!isBlock(b) || !map.addBlock(b)) return false; byId.set(b.id, b); digest.add(b.id); return true; },
    };
    const sync = createMapSync({
      selfId: id, store, now: clock.now,
      async request(to, m) {
        await null;   // async hop
        if (net.down.has(to) || !nodes.has(to)) throw new Error('no route');
        if (m.t === 'get') net.getIds.push(...m.ids);
        const req = JSON.stringify(m);
        const resp = nodes.get(to).sync.handle(JSON.parse(req)).map(x => JSON.stringify(x));
        net.msgs += 1 + resp.length; net.bytes += req.length + resp.reduce((s, x) => s + x.length, 0);
        await null;
        return { msgs: resp.map(x => JSON.parse(x)), via: 'mem', bytesOut: req.length, bytesIn: resp.reduce((s, x) => s + x.length, 0) };
      },
    });
    const node = { id, map, store, sync };
    nodes.set(id, node);
    return node;
  }
  // One "heartbeat": every node advertises its root to every other.
  function gossip() { for (const a of nodes.values()) for (const b of nodes.values()) if (a !== b) b.sync.noteRemote(a.id, a.store.digest.root()); }
  async function settle() { for (let i = 0; i < 20; i++) await null; }
  return { clock, nodes, net, makeNode, gossip, settle };
}
const idsOf = (n) => n.map.blocks().map(b => b.id).sort();

// ---- 4. two peers converge to the union (A rows −31..30, B −11..50) ----
{
  const { clock, net, makeNode, gossip, settle } = makeNet();
  const A = makeNode('peer:A', rows(-31, 30)), B = makeNode('peer:B', rows(-11, 50));
  const union = [...new Set([...idsOf(A), ...idsOf(B)])].sort();
  gossip(); await settle();
  for (let i = 0; i < 10 && (idsOf(A).join() !== union.join() || idsOf(B).join() !== union.join()); i++) { clock.advance(5000); gossip(); A.sync.tick(); B.sync.tick(); await settle(); }
  eq(idsOf(A), union, 'A converges to the union');
  eq(idsOf(B), union, 'B converges to the union');
  eq(A.store.digest.root(), B.store.digest.root(), 'roots agree after convergence');
  ok(net.msgs <= 12, `two-peer convergence in ${net.msgs} msgs, ${net.bytes} B`);
  console.log(`  two peers (62+62 rows, union ${union.length}): ${net.msgs} msgs, ${net.bytes} B`);
  // Once equal, gossip triggers nothing.
  const before = net.msgs;
  for (let i = 0; i < 5; i++) { clock.advance(15000); gossip(); A.sync.tick(); B.sync.tick(); await settle(); }
  eq(net.msgs, before, 'no traffic while roots agree');
}

// ---- 5. three peers + late joiner seeded from a stale Door ----
{
  const { clock, net, nodes, makeNode, gossip, settle } = makeNet();
  const A = makeNode('peer:A', [...rows(-31, 30), ...discs(40, 'peer:A')]);
  const B = makeNode('peer:B', [...rows(-11, 50), ...discs(20, 'peer:B')]);
  const C = makeNode('peer:C', rows(-31, 0));   // late joiner: Door blocks = half of A's rows
  const all = [...new Set([...idsOf(A), ...idsOf(B)])].sort();
  for (let i = 0; i < 12; i++) { gossip(); for (const n of nodes.values()) n.sync.tick(); await settle(); clock.advance(5000); }
  for (const n of [A, B, C]) eq(idsOf(n), all, `${n.id} holds the union of all three`);
  console.log(`  three peers incl. late joiner (union ${all.length}): ${net.msgs} msgs, ${net.bytes} B`);
  // Every block id was fetched by C at most once (in-flight dedupe across A and B).
  const perId = new Map(); for (const id of net.getIds) perId.set(id, (perId.get(id) || 0) + 1);
  ok(Math.max(...perId.values()) <= 3, `ids requested ≤ 3× in total (max ${Math.max(...perId.values())})`);
}

// ---- 6. in-flight dedupe: two concurrent pulls never ask for the same id twice ----
{
  const { net, makeNode, settle } = makeNet();
  const shared = discs(30, 'peer:x');
  const A = makeNode('peer:A', shared), B = makeNode('peer:B', shared), C = makeNode('peer:C', []);
  C.sync.noteRemote('peer:A', A.store.digest.root()); C.sync.noteRemote('peer:B', B.store.digest.root());   // first sight → both fire now
  await settle();
  const counts = new Map(); for (const id of net.getIds) counts.set(id, (counts.get(id) || 0) + 1);
  ok([...counts.values()].every(c => c === 1), 'concurrent pulls dedupe wanted ids');
  eq(idsOf(C), idsOf(A), 'C got everything from the two pulls');
}

// ---- 7. grace, min interval, zero-gain back-off ----
{
  const { clock, net, makeNode, settle } = makeNet();
  const A = makeNode('peer:A', rows(0, 9)), B = makeNode('peer:B', rows(0, 4));
  net.down.add('peer:A');   // B cannot pull back from A (else it converges and the mismatch is gone)
  // A sees B (a subset) for the first time → one pull (first sight skips the grace), gains 0.
  A.sync.noteRemote('peer:B', B.store.digest.root()); await settle();
  eq(A.sync.stats().pulls, 1, 'first sight pulls at once');
  eq(A.sync.stats().gained, 0, 'pulling a subset gains nothing');
  // Same root again and again → back-off: no new pull for 10 s, then doubling.
  let pulls = A.sync.stats().pulls;
  for (let i = 0; i < 4; i++) { clock.advance(2000); A.sync.noteRemote('peer:B', B.store.digest.root()); A.sync.tick(); await settle(); }
  eq(A.sync.stats().pulls, pulls, 'no re-pull inside the back-off window');
  clock.advance(3000); A.sync.tick(); await settle();
  eq(A.sync.stats().pulls, pulls + 1, 'one re-pull once the 10 s back-off passed');
  pulls = A.sync.stats().pulls;
  clock.advance(15000); A.sync.tick(); await settle();
  eq(A.sync.stats().pulls, pulls, 'back-off doubled to 20 s');
  clock.advance(6000); A.sync.tick(); await settle();
  eq(A.sync.stats().pulls, pulls + 1, 're-pull after 20 s');
  // A newly changed remote root waits for the grace period (blocks still in flight on the fast path).
  B.store.add(rows(20, 20)[0]);
  clock.advance(10_000); A.sync.noteRemote('peer:B', B.store.digest.root()); A.sync.tick(); await settle();
  pulls = A.sync.stats().pulls;
  clock.advance(1000); A.sync.tick(); await settle();
  eq(A.sync.stats().pulls, pulls, 'changed root: no pull inside the grace');
  clock.advance(4000); A.sync.tick(); await settle();
  eq(A.sync.stats().pulls, pulls + 1, 'changed root: pull after the grace');
  ok(A.store.has('rect:-21,20,23x1'), 'and the new block arrived');
  // Failing transport → error back-off (5 s, 10 s …).
  const { clock: c2, net: n2, makeNode: mk2, settle: s2 } = makeNet();
  const X = mk2('peer:X', rows(0, 3)); mk2('peer:Y', rows(0, 5)); n2.down.add('peer:Y');
  X.sync.noteRemote('peer:Y', 'zzz.1'); await s2();
  eq(X.sync.stats().pulls_failed, 1, 'unreachable peer → failed pull');
  c2.advance(4000); X.sync.tick(); await s2();
  eq(X.sync.stats().pulls_failed, 1, 'error back-off 5 s');
  c2.advance(1500); X.sync.tick(); await s2();
  eq(X.sync.stats().pulls_failed, 2, 'retry after 5 s');
  // No route yet (a joiner still dialling) is not a failure: retried 1.5 s later as a first pull.
  {
    let route = false; let t = 0;
    const d = createDigest(); d.add('a');
    const s = createMapSync({ selfId: 'peer:J', now: () => t, store: { digest: d, has: x => d.has(x), get: () => null, add: () => false },
      request: async () => { if (!route) throw Object.assign(new Error('no link'), { code: 'NO_ROUTE' }); return { msgs: [{ t: 'ids', ids: [] }], via: 'mem' }; } });
    s.noteRemote('peer:K', '9.zz'); await s2();
    eq([s.stats().pulls, s.stats().pulls_failed, s.stats().no_route], [0, 0, 1], 'no route: not counted as a pull or a failure');
    t += 1000; s.tick(); await s2();
    eq(s.stats().no_route, 1, 'no route: waits 1.5 s');
    route = true; t += 600; s.tick(); await s2();
    eq([s.stats().pulls, s.stats().pulls_ok], [1, 1], 'no route: pulls as soon as a link exists (no grace, no back-off)');
  }
  // A big pull is applied in slices of 100 blocks with a yield in between.
  {
    const src = createDigest(), blocks = rows(-250, 249);
    for (const b of blocks) src.add(b.id);
    const byId = new Map(blocks.map(b => [b.id, b]));
    const S = createMapSync({ selfId: 'peer:S', store: { digest: src, has: x => src.has(x), get: x => byId.get(x), add: () => false } });
    const d = createDigest(); let yields = 0;
    const J = createMapSync({ selfId: 'peer:J', yieldFn: async () => { yields++; },
      store: { digest: d, has: x => d.has(x), get: () => null, add: (b) => d.add(b.id) },
      request: async (to, m) => { const msgs = S.handle(JSON.parse(JSON.stringify(m))); return { msgs, via: 'mem' }; } });
    J.noteRemote('peer:S', '0.x');   // first sight → pulls at once
    for (let i = 0; i < 100 && !J.stats().pulls_ok; i++) await null;
    eq([J.stats().gained, d.size(), yields], [500, 500, 5], '500 blocks applied with 5 yields');
  }
  void net; void n2;
}

// ---- 8. responder rate limit + bad requests ----
{
  const { makeNode } = makeNet();
  const A = makeNode('peer:A', rows(0, 5));
  let busy = 0;
  for (let i = 0; i < 30; i++) if (A.sync.handle({ t: 'get', from: 'peer:spam', ids: ['rect:-11,0,23x1'] })[0].t === 'busy') busy++;
  eq(busy, 10, 'token bucket: burst of 20, then busy');
  eq(A.sync.handle({ t: 'get', from: 'peer:other', ids: ['rect:-11,0,23x1'] })[0].blocks.length, 1, 'other peers are not throttled');
  eq(A.sync.handle({ t: 'diff', from: 'peer:z', s: 'nonsense' })[0].t, 'error', 'bad summary → error');
  eq(A.sync.handle({ t: 'nope', from: 'peer:z' })[0].t, 'error', 'unknown request → error');
  const ids = Array.from({ length: GET_MAX + 500 }, (_, i) => `rect:${i},0,1x1`);
  ok(A.sync.handle({ t: 'get', from: 'peer:q', ids }).every(m => m.t === 'blocks'), 'oversize get is capped, not refused');
  const same = A.sync.handle({ t: 'diff', from: 'peer:w', root: A.store.digest.root(), s: encodeSummary(A.store.digest.summary()) });
  eq(same, [{ t: 'ids', ids: [], same: true, root: A.store.digest.root() }], 'equal summary → same');
}

// ---- 9. bus RPC: broadcast channel, addressed, chunked ≤ 24 KB, converges ----
{
  let t = 5_000_000; const now = () => t;
  const subscribers = [];
  let busMsgs = 0, busBytes = 0, maxEv = 0;
  const publish = (ev) => { const s = JSON.stringify(ev); busMsgs++; busBytes += s.length; maxEv = Math.max(maxEv, s.length); for (const f of subscribers) queueMicrotask(() => f(JSON.parse(s))); return true; };
  function node(id, blocks) {
    const map = createKnownMap('seed', blocks), byId = new Map(map.blocks().map(b => [b.id, b]));
    const digest = createDigest(); for (const b of map.blocks()) digest.add(b.id);
    const store = { digest, has: x => byId.has(x), get: x => byId.get(x), add(b) { if (!isBlock(b) || !map.addBlock(b)) return false; byId.set(b.id, b); digest.add(b.id); return true; } };
    let rpc;
    const sync = createMapSync({ selfId: id, store, now, request: (to, m) => rpc.request(to, m) });
    rpc = createBusRpc({ selfId: id, publish, handle: sync.handle, now });
    subscribers.push(ev => rpc.deliver(ev));
    return { id, map, store, sync, rpc };
  }
  const A = node('peer:A', [...rows(-300, 300), ...discs(200, 'peer:A')]), B = node('peer:B', rows(-11, 50)), O = node('peer:O', rows(0, 1));
  const settle = async () => { for (let i = 0; i < 200; i++) await null; };
  const oBefore = idsOf(O);
  B.sync.noteRemote('peer:A', A.store.digest.root()); await settle();
  A.sync.noteRemote('peer:B', B.store.digest.root()); await settle();
  const union = [...new Set([...idsOf(A), ...idsOf(B)])].sort();
  eq(idsOf(B), union, 'bus: B converges');
  eq(idsOf(A), union, 'bus: A converges');
  eq(idsOf(O), oBefore, 'bus: a bystander only discards traffic addressed to others');
  ok(maxEv <= BUS_FRAME_BYTES,`bus events stay ≤ ~24 KB (max ${maxEv} B)`);
  eq(A.rpc.pending() + B.rpc.pending(), 0, 'no pending bus requests');
  console.log(`  bus fallback (union ${union.length}): ${busMsgs} events, ${busBytes} B, largest ${maxEv} B`);
  // Timeout path.
  let timedOut = false;
  const lone = createBusRpc({ selfId: 'peer:L', publish: () => true, handle: () => [], now, timeoutMs: 5, setTimer: setTimeout, clearTimer: clearTimeout });
  await lone.request('peer:nobody', { t: 'diff' }).catch(e => { timedOut = /timeout/.test(e.message); });
  ok(timedOut, 'bus request times out');
  void t;
}

if (fails) { console.log(`${fails} of ${checks} checks FAILED`); process.exit(1); }
console.log(`all checks passed (${checks})`);
