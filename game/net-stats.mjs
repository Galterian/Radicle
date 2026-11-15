// Network accounting for the P2P sync rework (M1 "measure first"). TELEMETRY ONLY: nothing here is
// read by the resolver or the state hash.
//
//   netStat(layer, dir, kind, bytes)   one message on `layer` ('libp2p'|'bus'|'gun'|'door'|'discovery'),
//                                      dir 'out'|'in', kind = envelope type / gun soul prefix / endpoint
//   netAttachGun(gun)                  wire totals off Gun's own mesh counters + per-field graph writes
//                                      (root 'put' event, by soul prefix) + a capped graph-size sample
//   netSnapshot()                      { window_s, layers:{L:{out,in:{msgs,bytes,min_msgs,min_bytes}},kinds},
//                                        gun_wire, gun_writes, graph:{nodes, approx_bytes}, mem }
//   netSummaryLine()                   `libp2p 120↑/340↓ msg/min 41/98 KB/min · bus … · gun … graph …`
//   netStart({ label, log })           30 s graph sampler + one `[label] [net] …` line per minute
//
// Rolling window = the last 6 completed 10-second buckets (exactly 60 s); totals since start.
// Bytes are approximate (JSON length of what the caller already serialized, or a cheap estimate).

export const NET_LAYERS = ['libp2p', 'bus', 'gun', 'door', 'discovery'];
const BUCKET_MS = 10_000, WINDOW_BUCKETS = 6;
const MAX_KINDS = 64;                        // per layer; anything past that folds into 'other'

const totals = new Map();                    // `${layer}|${dir}|${kind}` -> [msgs, bytes]
const buckets = new Map();                   // bucketIndex -> Map(key -> [msgs, bytes])
const kindsPerLayer = new Map();             // layer -> Set(kind)
const startedAt = Date.now();

function bump(map, key, bytes) {
  let c = map.get(key);
  if (!c) { c = [0, 0]; map.set(key, c); }
  c[0]++; c[1] += bytes;
}
function kindOf(layer, kind) {
  let s = kindsPerLayer.get(layer);
  if (!s) { s = new Set(); kindsPerLayer.set(layer, s); }
  const k = String(kind || '?');
  if (s.has(k)) return k;
  if (s.size >= MAX_KINDS) return 'other';
  s.add(k); return k;
}
function curBucket() {
  const idx = Math.floor(Date.now() / BUCKET_MS);
  let b = buckets.get(idx);
  if (!b) {
    b = new Map(); buckets.set(idx, b);
    for (const k of buckets.keys()) if (k < idx - WINDOW_BUCKETS - 1) buckets.delete(k);
  }
  return b;
}

export function netStat(layer, dir, kind, bytes = 0) {
  try {
    const key = `${layer}|${dir}|${kindOf(layer, kind)}`;
    const n = Number(bytes) || 0;
    bump(totals, key, n);
    bump(curBucket(), key, n);
  } catch {}
}

// Sum of the last WINDOW_BUCKETS completed buckets.
function windowCounts() {
  const cur = Math.floor(Date.now() / BUCKET_MS);
  const out = new Map();
  for (const [idx, b] of buckets) {
    if (idx >= cur || idx < cur - WINDOW_BUCKETS) continue;
    for (const [k, c] of b) { const o = out.get(k) || [0, 0]; o[0] += c[0]; o[1] += c[1]; out.set(k, o); }
  }
  const elapsed = Math.min(WINDOW_BUCKETS, Math.max(1, Math.floor((cur * BUCKET_MS - startedAt) / BUCKET_MS)));
  return { out, scale: WINDOW_BUCKETS / elapsed };   // scale: extrapolate to /min during the first minute
}

// ---- Gun ----
let gunRef = null, gunMesh = null;
let graphSample = { nodes: 0, approx_bytes: 0, at: 0, ms: 0 };
const wirePrev = { at: 0, hc: 0, hd: 0, sc: 0, sd: 0 };
let wireRate = { in_msgs: 0, in_bytes: 0, out_msgs: 0, out_bytes: 0 };   // per minute, from the last sample
const writes = new Map();                    // soul prefix -> per-field graph writes (total)
const writesWin = new Map();                 // bucket-style: prefix -> [{at, n}] collapsed per 10 s
function soulPrefix(soul) {
  const s = String(soul || '');
  if (s.includes('/members')) return 'members';
  if (s.includes('/map')) return 'map';
  if (s.includes('/doors')) return 'doors';
  return 'other';
}
export function netAttachGun(gun) {
  try {
    gunRef = gun;
    gunMesh = gun?._?.opt?.mesh || null;
    // Storage-adapter style listener: every field Gun merges into its graph (local or remote) — the
    // unit that blew the phone heap. Pass the message on FIRST so Gun's own chain is untouched.
    gun?._?.on?.('put', function (msg) {
      this.to.next(msg);
      try {
        const p = soulPrefix(msg?.put?.['#']);
        writes.set(p, (writes.get(p) || 0) + 1);
        const idx = Math.floor(Date.now() / BUCKET_MS);
        let w = writesWin.get(idx); if (!w) { w = new Map(); writesWin.set(idx, w); for (const k of writesWin.keys()) if (k < idx - WINDOW_BUCKETS - 1) writesWin.delete(k); }
        w.set(p, (w.get(p) || 0) + 1);
      } catch {}
    });
  } catch {}
}
function sampleWire() {
  const h = gunMesh?.hear, s = gunMesh?.say;
  if (!h || !s) return;
  const now = Date.now();
  const cur = { at: now, hc: h.c || 0, hd: h.d || 0, sc: s.c || 0, sd: s.d || 0 };
  // Gun zeroes its counters now and then (mesh re-init): a counter that went down restarts from 0.
  if (cur.hc < wirePrev.hc || cur.sc < wirePrev.sc) Object.assign(wirePrev, { hc: 0, hd: 0, sc: 0, sd: 0 });
  if (wirePrev.at) {
    const k = 60_000 / Math.max(1, now - wirePrev.at);
    wireRate = { in_msgs: Math.round((cur.hc - wirePrev.hc) * k), in_bytes: Math.round((cur.hd - wirePrev.hd) * k),
      out_msgs: Math.round((cur.sc - wirePrev.sc) * k), out_bytes: Math.round((cur.sd - wirePrev.sd) * k) };
  }
  Object.assign(wirePrev, cur);
}
// Graph size: key count is exact (one Object.keys); bytes are the mean JSON length of ≤ 40 evenly spaced
// nodes × the count — bounded work however big the graph gets.
const GRAPH_SAMPLE_NODES = 40;
function sampleGraph() {
  const t0 = Date.now();
  try {
    const g = gunRef?._?.graph;
    if (!g) return;
    const keys = Object.keys(g);
    const n = keys.length;
    let sum = 0, cnt = 0;
    if (n) {
      const step = Math.max(1, Math.floor(n / GRAPH_SAMPLE_NODES));
      for (let i = 0; i < n && cnt < GRAPH_SAMPLE_NODES; i += step) {
        try { sum += JSON.stringify(g[keys[i]])?.length || 0; cnt++; } catch {}
      }
    }
    graphSample = { nodes: n, approx_bytes: cnt ? Math.round(sum / cnt * n) : 0, at: t0, ms: Date.now() - t0 };
  } catch {}
}

export function netSnapshot() {
  const { out: win, scale } = windowCounts();
  const layers = {};
  for (const L of NET_LAYERS) layers[L] = { out: { msgs: 0, bytes: 0, min_msgs: 0, min_bytes: 0 }, in: { msgs: 0, bytes: 0, min_msgs: 0, min_bytes: 0 }, kinds: {} };
  for (const [key, c] of totals) {
    const [L, dir, kind] = key.split('|');
    const l = layers[L] || (layers[L] = { out: { msgs: 0, bytes: 0, min_msgs: 0, min_bytes: 0 }, in: { msgs: 0, bytes: 0, min_msgs: 0, min_bytes: 0 }, kinds: {} });
    const d = l[dir]; if (!d) continue;
    d.msgs += c[0]; d.bytes += c[1];
    const w = win.get(key) || [0, 0];
    const mm = Math.round(w[0] * scale), mb = Math.round(w[1] * scale);
    d.min_msgs += mm; d.min_bytes += mb;
    const k = l.kinds[kind] || (l.kinds[kind] = {});
    k[dir] = { msgs: c[0], bytes: c[1], min_msgs: mm, min_bytes: mb };
  }
  const cur = Math.floor(Date.now() / BUCKET_MS);
  const gw = {};
  for (const [p, n] of writes) gw[p] = { total: n, min: 0 };
  for (const [idx, w] of writesWin) { if (idx >= cur || idx < cur - WINDOW_BUCKETS) continue; for (const [p, n] of w) gw[p].min += Math.round(n * scale); }
  const mu = process.memoryUsage();
  return { at: Date.now(), up_s: Math.round((Date.now() - startedAt) / 1000), window_s: 60, layers,
    gun_wire: { ...wireRate, total_in_msgs: gunMesh?.hear?.c || 0, total_in_bytes: gunMesh?.hear?.d || 0, total_out_msgs: gunMesh?.say?.c || 0, total_out_bytes: gunMesh?.say?.d || 0 },
    gun_writes: gw, graph: graphSample,
    mem: { rss: mu.rss, heap_used: mu.heapUsed, heap_total: mu.heapTotal, external: mu.external } };
}

const kb = b => (b / 1024 < 10 ? (b / 1024).toFixed(1) : Math.round(b / 1024));
export function netSummaryLine(s = netSnapshot()) {
  const parts = [];
  for (const L of NET_LAYERS) {
    const l = s.layers[L]; if (!l) continue;
    if (!l.out.msgs && !l.in.msgs && L !== 'gun') continue;
    let p = `${L} ${l.out.min_msgs}↑/${l.in.min_msgs}↓ msg/min ${kb(l.out.min_bytes)}/${kb(l.in.min_bytes)} KB/min`;
    if (L === 'gun') {
      const w = s.gun_wire;
      const wr = Object.entries(s.gun_writes).map(([k, v]) => `${k} ${v.min}`).join(' ');
      p += ` wire ${w.out_msgs}↑/${w.in_msgs}↓ ${kb(w.out_bytes)}/${kb(w.in_bytes)} KB/min${wr ? ` writes/min ${wr}` : ''} graph ${s.graph.nodes.toLocaleString('en-US')} nodes ~${(s.graph.approx_bytes / 1048576).toFixed(1)} MB`;
    }
    parts.push(p);
  }
  parts.push(`heap ${Math.round(s.mem.heap_used / 1048576)} MB rss ${Math.round(s.mem.rss / 1048576)} MB`);
  return parts.join(' · ');
}

let started = false;
export function netStart({ label = 'peer', log = console.log, summaryMs = 60_000, graphMs = 30_000 } = {}) {
  if (started) return; started = true;
  sampleWire(); sampleGraph();
  setInterval(() => { sampleWire(); sampleGraph(); }, graphMs).unref?.();
  setInterval(() => { try { log(`[${label}] [net] ${netSummaryLine()}`); } catch {} }, summaryMs).unref?.();
}
