// Map sync, compare-then-pull (P2P sync rework M3 "Map sync off Gun"). PURE logic: no sockets, no
// timers of its own, no globals — peer.mjs injects the transport (`request`), the store and the clock,
// and tools/map-sync-check.mjs drives it with an in-memory transport.
//
// The dimension map is a grow-only set of blocks keyed by id (js/map.js). Every peer keeps a DIGEST of
// its block ids: N_BUCKETS buckets, each { count, xor of hashA(id), sum of hashB(id) mod 2^32 }. Adding
// an id is O(1) and order-independent, so two peers holding the same id set always hold the same digest.
// The ROOT (`${count}.${hash of the bucket list}`) rides on every slim snapshot as `map_root` (~12 B).
//
// When a peer's advertised root differs from ours (and the difference has settled for a moment), we PULL:
//   1. → {t:'diff', from, root, s: <our encoded summary>}     ← {t:'ids', ids:[…their ids in differing buckets]} (chunked)
//                                                              or {t:'ids', ids:[], same:true}
//   2. → {t:'get', from, ids:[…ids we lack]}  (≤ GET_MAX ids)  ← {t:'blocks', blocks:[…]} (chunked, ≤ maxBytes each)
//   busy responder                                           ← {t:'busy'}
// The responder learns our root from step 1 and pulls back from us on its own if it lacks something, so
// one exchange converges both directions. Every response frame is ≤ maxBytes of JSON (32 KB direct,
// 24 KB on the bus).
//
// Transport (peer.mjs): a direct libp2p protocol `/chaos/<dim>/map/1` — one stream per request, frames
// are 4-byte big-endian length + UTF-8 JSON (encodeFrame / createFrameDecoder below); fallback over the
// Nostr bus as `map` events {to, from, rid, seq, last, m} when there is no open libp2p connection.

export const N_BUCKETS = 64;
export const MAX_FRAME_BYTES = 32 * 1024;
export const BUS_FRAME_BYTES = 24 * 1024;
export const GET_MAX = 1500;                 // ids per `get` request
export const PROTOCOL_VERSION = 1;

// ---- hashing (FNV-1a 32 + murmur3 finaliser, two independent seeds) ----
function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
export const hashA = (id) => fnv(id, 0x811c9dc5);
export const hashB = (id) => fnv(id, 0x9e3779b9);
export const bucketOf = (id, n = N_BUCKETS) => hashA(id) % n;

// ---- digest ----
export function createDigest(n = N_BUCKETS) {
  const count = new Array(n).fill(0), xa = new Array(n).fill(0), sb = new Array(n).fill(0);
  const ids = new Set();
  const byBucket = Array.from({ length: n }, () => []);
  let rootCache = null;
  return {
    n,
    add(id) {
      if (typeof id !== 'string' || ids.has(id)) return false;
      ids.add(id);
      const a = hashA(id), k = a % n;
      count[k]++; xa[k] = (xa[k] ^ a) >>> 0; sb[k] = (sb[k] + hashB(id)) >>> 0;
      byBucket[k].push(id);
      rootCache = null;
      return true;
    },
    has: (id) => ids.has(id),
    size: () => ids.size,
    summary: () => count.map((c, i) => [c, xa[i], sb[i]]),
    root() { return rootCache ??= rootOf(this.summary()); },
    idsInBuckets(list) { const out = []; for (const k of list) if (k >= 0 && k < n) out.push(...byBucket[k]); return out; },
  };
}
export function rootOf(summary) {
  let total = 0;
  for (const [c] of summary) total += c;
  return `${total}.${fnv(encodeSummary(summary), 0x811c9dc5).toString(36)}`;
}
// "c:xa:sb,c:xa:sb,…" in base 36 (~1 KB for 64 buckets); empty buckets are just "0".
export function encodeSummary(summary) {
  return summary.map(([c, a, b]) => (c ? `${c.toString(36)}:${a.toString(36)}:${b.toString(36)}` : '0')).join(',');
}
export function decodeSummary(str, n = N_BUCKETS) {
  if (typeof str !== 'string') return null;
  const parts = str.split(',');
  if (parts.length !== n) return null;
  const out = [];
  for (const p of parts) {
    if (p === '0') { out.push([0, 0, 0]); continue; }
    const [c, a, b] = p.split(':').map(x => parseInt(x, 36));
    if (![c, a, b].every(Number.isFinite)) return null;
    out.push([c, a >>> 0, b >>> 0]);
  }
  return out;
}
// Buckets where the two summaries disagree.
export function diffSummaries(a, b) {
  const out = [];
  const n = Math.max(a?.length || 0, b?.length || 0);
  for (let i = 0; i < n; i++) {
    const x = a?.[i] || [0, 0, 0], y = b?.[i] || [0, 0, 0];
    if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) out.push(i);
  }
  return out;
}

// ---- chunking: split `items` into messages make(items) whose JSON is ≤ maxBytes ----
// An item that alone exceeds the budget still goes out (alone) — blocks are ~100 B, ids ~20 B.
const utf8len = (s) => Buffer.byteLength(s, 'utf8');
export function chunkMessages(items, make, maxBytes = MAX_FRAME_BYTES) {
  const overhead = utf8len(JSON.stringify(make([])));
  const out = [];
  let cur = [], size = overhead;
  for (const it of items) {
    const len = utf8len(JSON.stringify(it)) + 1;
    if (cur.length && size + len > maxBytes) { out.push(make(cur)); cur = []; size = overhead; }
    cur.push(it); size += len;
  }
  if (cur.length || !out.length) out.push(make(cur));
  return out;
}

// ---- framing: 4-byte big-endian length + UTF-8 JSON ----
export const FRAME_LIMIT = 256 * 1024;       // reject anything bigger (a frame is ≤ 32 KB by construction)
export function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0); body.copy(out, 4);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}
export function createFrameDecoder(limit = FRAME_LIMIT) {
  let buf = Buffer.alloc(0);
  return {
    // push raw bytes; returns the complete frames decoded so far (objects). Throws on an oversize frame.
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, Buffer.from(chunk)]) : Buffer.from(chunk);
      const out = [];
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len > limit) throw new Error(`map-sync frame of ${len} bytes exceeds ${limit}`);
        if (buf.length < 4 + len) break;
        out.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
        buf = buf.subarray(4 + len);
      }
      return out;
    },
    pending: () => buf.length,
  };
}

// ---- the coordinator ----
// store: { has(id), get(id) → block|undefined, add(block, via) → bool (true = new), digest }
// request(peerId, msg) → Promise<{ msgs: [response…], via: 'libp2p'|'bus', bytesOut, bytesIn }>
export const DEFAULTS = {
  graceMs: 4_000,          // a root mismatch must have settled this long (blocks in flight on the fast path)
  minIntervalMs: 10_000,   // per peer between pulls
  backoffMaxMs: 120_000,   // zero-gain / failing pulls back off ×2 up to this
  errorBackoffMs: 5_000,
  noRouteRetryMs: 1_500,   // request() threw {code:'NO_ROUTE'}: no transport to that peer yet
  yieldEvery: 100,         // blocks applied between two yieldFn() calls
  maxConcurrent: 2,
  wantTtlMs: 15_000,       // an id requested from one peer is not requested from another meanwhile
  serveBurst: 20,          // responder token bucket: burst …
  serveRefillMs: 500,      // … one token per this many ms per requesting peer
};
export function createMapSync({ selfId, store, request, now = () => Date.now(), log = () => {}, yieldFn = null, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const remotes = new Map();   // peerId -> { root, rootAt, since, nextAt, backoff, zeroRoot, pulls, gained }
  const inflight = new Set();  // peerIds being pulled
  const wanted = new Map();    // block id -> expiry (ms)
  const buckets = new Map();   // requesting peerId -> { tokens, at } (serve rate limit)
  const stats = { pulls: 0, pulls_ok: 0, pulls_failed: 0, no_route: 0, gained: 0, served: 0, busy: 0, msgs_out: 0, msgs_in: 0, bytes_out: 0, bytes_in: 0 };
  let myRootAt = now(), lastRoot = store.digest.root();
  const myRoot = () => { const r = store.digest.root(); if (r !== lastRoot) { lastRoot = r; myRootAt = now(); } return r; };

  function noteRemote(peerId, root, { urgent = false } = {}) {
    if (!peerId || peerId === selfId || typeof root !== 'string' || !root) return;
    const t = now();
    let r = remotes.get(peerId);
    if (!r) { r = { root: null, rootAt: 0, since: 0, nextAt: 0, backoff: 0, zeroRoot: null, pulls: 0, gained: 0, first: true, firstAt: t }; remotes.set(peerId, r); }
    if (r.root !== root) { r.root = root; r.rootAt = t; }
    if (root === myRoot()) { r.since = 0; return; }
    if (!r.since) r.since = t;
    if (urgent || r.first) maybePull(peerId);
  }
  function forget(peerId) { remotes.delete(peerId); buckets.delete(peerId); }

  function due(peerId, t = now()) {
    const r = remotes.get(peerId);
    if (!r || !r.root || inflight.has(peerId) || inflight.size >= o.maxConcurrent) return false;
    if (r.root === myRoot()) { r.since = 0; return false; }
    if (t < r.nextAt) return false;
    // A zero-gain pull against this very root: wait out the back-off (their root changing lifts it).
    if (r.zeroRoot === r.root && t < r.zeroAt + r.backoff) return false;
    if (r.first) return true;
    const settled = Math.max(r.since, r.rootAt, myRootAt);
    return t - settled >= o.graceMs;
  }
  function maybePull(peerId) { if (due(peerId)) pull(peerId).catch(() => {}); }
  // Called by the host on a timer (every few seconds): fires any pull that became due.
  function tick() { const t = now(); for (const id of remotes.keys()) if (due(id, t)) pull(id).catch(() => {}); }

  function account(res) {
    stats.msgs_out++; stats.msgs_in += res.msgs.length;
    stats.bytes_out += res.bytesOut || 0; stats.bytes_in += res.bytesIn || 0;
  }
  async function pull(peerId) {
    const r = remotes.get(peerId);
    inflight.add(peerId); stats.pulls++;
    const t0 = now(), theirRoot = r.root;
    r.first = false; r.pulls++;
    let gained = 0, msgs = 0, bytes = 0, via = '?';
    const mine = [];
    try {
      const res1 = await request(peerId, { t: 'diff', v: PROTOCOL_VERSION, from: selfId, root: myRoot(), s: encodeSummary(store.digest.summary()) });
      account(res1); via = res1.via; msgs += 1 + res1.msgs.length; bytes += (res1.bytesOut || 0) + (res1.bytesIn || 0);
      if (res1.msgs.some(m => m?.t === 'busy')) throw new Error('busy');
      const t = now();
      for (const [id, exp] of wanted) if (exp < t) wanted.delete(id);
      const ids = res1.msgs.flatMap(m => (m?.t === 'ids' && Array.isArray(m.ids) ? m.ids : []));
      const missing = ids.filter(id => typeof id === 'string' && !store.has(id) && !wanted.has(id));
      for (const id of missing) { wanted.set(id, t + o.wantTtlMs); mine.push(id); }
      for (let i = 0; i < missing.length; i += GET_MAX) {
        const res2 = await request(peerId, { t: 'get', v: PROTOCOL_VERSION, from: selfId, ids: missing.slice(i, i + GET_MAX) });
        account(res2); msgs += 1 + res2.msgs.length; bytes += (res2.bytesOut || 0) + (res2.bytesIn || 0);
        if (res2.msgs.some(m => m?.t === 'busy')) throw new Error('busy');
        // Applied in slices with a yield in between (a block can be a 331-hex disc): a big pull never
        // holds the event loop for long while commits / reveals are arriving.
        let n = 0;
        for (const m of res2.msgs) if (m?.t === 'blocks' && Array.isArray(m.blocks)) for (const b of m.blocks) {
          if (store.add(b, `pull from ${peerId}`)) gained++;
          if (yieldFn && ++n % o.yieldEvery === 0) await yieldFn();
        }
      }
      stats.pulls_ok++; stats.gained += gained; r.gained += gained;
      if (gained) { r.backoff = 0; r.zeroRoot = null; }
      else { r.zeroRoot = theirRoot; r.zeroAt = now(); r.backoff = Math.min(o.backoffMaxMs, r.backoff ? r.backoff * 2 : o.minIntervalMs); }
      r.nextAt = now() + o.minIntervalMs;
      log(`map pull ← ${peerId} via ${via}: ${ids.length} ids offered, ${missing.length} missing, +${gained} blocks (${msgs} msgs, ${bytes} B, ${now() - t0} ms)`);
      return { gained, msgs, bytes, via, ms: now() - t0 };
    } catch (e) {
      if (e?.code === 'NO_ROUTE') {   // no link to them yet (a joiner still dialling): not a failure — retry soon, as a first pull
        stats.pulls--; r.pulls--; r.first = true; stats.no_route++;
        r.nextAt = now() + o.noRouteRetryMs;
        return { gained, msgs, bytes, via, error: e.message };
      }
      stats.pulls_failed++;
      r.backoff = Math.min(o.backoffMaxMs, r.backoff ? r.backoff * 2 : o.errorBackoffMs);
      r.nextAt = now() + r.backoff;
      log(`map pull ← ${peerId} failed (${e.message}); retry in ${Math.round(r.backoff / 1000)} s`);
      return { gained, msgs, bytes, via, error: e.message };
    } finally {
      for (const id of mine) wanted.delete(id);
      inflight.delete(peerId);
    }
  }

  function allow(peerId) {
    const t = now();
    let b = buckets.get(peerId);
    if (!b) { b = { tokens: o.serveBurst, at: t }; buckets.set(peerId, b); }
    b.tokens = Math.min(o.serveBurst, b.tokens + (t - b.at) / o.serveRefillMs); b.at = t;
    if (b.tokens < 1) return false;
    b.tokens--; return true;
  }
  // Responder: one request → list of response messages (each ≤ maxBytes of JSON).
  function handle(msg, { maxBytes = MAX_FRAME_BYTES } = {}) {
    if (!msg || typeof msg !== 'object') return [{ t: 'error', error: 'bad request' }];
    const from = typeof msg.from === 'string' ? msg.from : '?';
    if (!allow(from)) { stats.busy++; return [{ t: 'busy' }]; }
    stats.served++;
    if (msg.t === 'diff') {
      const theirs = decodeSummary(msg.s, store.digest.n);
      if (!theirs) return [{ t: 'error', error: 'bad summary' }];
      const diff = diffSummaries(store.digest.summary(), theirs);
      // They told us their root: if they hold something we lack, we pull back on our own.
      if (typeof msg.root === 'string') noteRemote(from, msg.root, { urgent: false });
      if (!diff.length) return [{ t: 'ids', ids: [], same: true, root: myRoot() }];
      return chunkMessages(store.digest.idsInBuckets(diff), ids => ({ t: 'ids', ids }), maxBytes);
    }
    if (msg.t === 'get') {
      const ids = Array.isArray(msg.ids) ? msg.ids.slice(0, GET_MAX) : [];
      const blocks = [];
      for (const id of ids) { const b = typeof id === 'string' ? store.get(id) : null; if (b) blocks.push(b); }
      return chunkMessages(blocks, bl => ({ t: 'blocks', blocks: bl }), maxBytes);
    }
    return [{ t: 'error', error: `unknown request ${String(msg.t).slice(0, 20)}` }];
  }

  return {
    noteRemote, forget, tick, handle, pull, myRoot,
    stats: () => ({ ...stats, inflight: inflight.size, remotes: remotes.size }),
    remote: (id) => remotes.get(id),
  };
}

// ---- bus fallback: request/response correlation over a broadcast channel ----
// publish(obj) sends one bus event; deliver(obj) is fed every incoming `map` bus event.
//   request:  { v, to, from, rid, m }            response: { v, to, from, rid, seq, last, m }
export function createBusRpc({ selfId, publish, handle, maxBytes = BUS_FRAME_BYTES, timeoutMs = 12_000, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const pending = new Map();   // rid -> { msgs: [], resolve, reject, timer, bytesIn, bytesOut, got:Set }
  let seq = 0;
  const size = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
  function request(to, m) {
    const rid = `${selfId}:${now().toString(36)}:${(seq++).toString(36)}`;
    const ev = { v: PROTOCOL_VERSION, to, from: selfId, rid, m };
    return new Promise((resolve, reject) => {
      const p = { msgs: [], resolve, reject, bytesIn: 0, bytesOut: size(ev), got: new Set(), total: null };
      p.timer = setTimer(() => { pending.delete(rid); reject(new Error('bus timeout')); }, timeoutMs);
      pending.set(rid, p);
      try { if (!publish(ev)) throw new Error('bus not connected'); }
      catch (e) { clearTimer(p.timer); pending.delete(rid); reject(e); }
    });
  }
  // Returns the response events this node published (for accounting), or null.
  function deliver(ev) {
    if (!ev || ev.to !== selfId || typeof ev.rid !== 'string') return null;
    if (typeof ev.seq === 'number') {   // a response to one of ours
      const p = pending.get(ev.rid);
      if (!p || p.got.has(ev.seq)) return null;
      p.got.add(ev.seq); p.msgs[ev.seq] = ev.m; p.bytesIn += size(ev);
      if (ev.last) p.total = ev.seq + 1;
      if (p.total !== null && p.got.size >= p.total) {
        clearTimer(p.timer); pending.delete(ev.rid);
        p.resolve({ msgs: p.msgs.slice(0, p.total), via: 'bus', bytesOut: p.bytesOut, bytesIn: p.bytesIn });
      }
      return null;
    }
    const resp = handle({ ...(ev.m || {}), from: ev.from }, { maxBytes: maxBytes - 512 });   // room for the {to,from,rid,seq} wrapper
    const out = resp.map((m, i) => ({ v: PROTOCOL_VERSION, to: ev.from, from: selfId, rid: ev.rid, seq: i, last: i === resp.length - 1, m }));
    for (const r of out) publish(r);
    return out;
  }
  return { request, deliver, pending: () => pending.size };
}
