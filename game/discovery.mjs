// Firebase-stub discovery directory. Originally spec'd as "pointers only, never
// game state"; in practice the libp2p-gossipsub mesh takes a while to form on
// localhost and the GunDB CRDT doesn't always converge inside one turn, so we
// also mirror peer state + per-turn reveals here as a reliable sync fallback.
// The libp2p/Gun paths still run in parallel — this is belt-and-suspenders.
//
// Endpoints:
//   GET  /dimensions                 -> list of registered DimensionIds
//   POST /register                   -> peer announces membership + initial state
//   POST /state                      -> peer publishes current tile/life snapshot
//   POST /reveal                     -> peer publishes a turn reveal (dim, turn, peer, action, target)
//   GET  /peers/:dimensionId         -> active peer list for the Dimension (incl. state)
//   GET  /reveals/:dim/:turn         -> all reveals for a given turn
//   POST /heartbeat                  -> keepalive  { peer_id, dimension_id }

import express from 'express';

const PORT = Number(process.env.DISCOVERY_PORT || 7350);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const DIMENSIONS = new Map();  // dimension_id -> { dimension_name, created_at, peers: Map(peer_id -> entry), reveals: Map(turn -> Map(peer_id -> reveal)) }
const STALE_MS = 2 * 60 * 1000;

function getOrCreateDim(dimension_id, dimension_name) {
  let dim = DIMENSIONS.get(dimension_id);
  if (!dim) {
    dim = { dimension_id, dimension_name, created_at: Date.now(), peers: new Map(), reveals: new Map() };
    DIMENSIONS.set(dimension_id, dim);
  } else if (dimension_name && !dim.dimension_name) {
    dim.dimension_name = dimension_name;
  }
  return dim;
}

const app = express();
app.use(express.json({ limit: '256kb' }));

app.post('/register', (req, res) => {
  const { dimension_id, dimension_name, door_id, peer_id, multiaddrs, character_id, creature_id, state } = req.body || {};
  if (!dimension_id || !peer_id) return res.status(400).json({ ok: false, error: 'missing dimension_id or peer_id' });
  const dim = getOrCreateDim(dimension_id, dimension_name);
  const prev = dim.peers.get(peer_id) || {};
  dim.peers.set(peer_id, {
    ...prev,
    peer_id, door_id, multiaddrs: multiaddrs || [], character_id, creature_id,
    state: state || prev.state || null,
    last_seen: Date.now(),
  });
  console.log(`[discovery] register ${peer_id} @ ${dim.dimension_name} (${multiaddrs?.length || 0} addrs)`);
  res.json({ ok: true, dimension_name: dim.dimension_name });
});

app.post('/state', (req, res) => {
  const { dimension_id, peer_id, state } = req.body || {};
  if (!dimension_id || !peer_id || !state) return res.status(400).json({ ok: false });
  const dim = DIMENSIONS.get(dimension_id);
  if (!dim) return res.status(404).json({ ok: false });
  const p = dim.peers.get(peer_id);
  if (!p) return res.status(404).json({ ok: false });
  p.state = state;
  p.last_seen = Date.now();
  res.json({ ok: true });
});

app.post('/reveal', (req, res) => {
  const { dimension_id, peer_id, turn, action, target } = req.body || {};
  if (!dimension_id || !peer_id || typeof turn !== 'number' || !action) return res.status(400).json({ ok: false });
  const dim = getOrCreateDim(dimension_id);
  if (!dim.reveals.has(turn)) dim.reveals.set(turn, new Map());
  dim.reveals.get(turn).set(peer_id, { peer_id, action, target: target || null, at: Date.now() });
  // Prune very old turns to avoid unbounded growth.
  if (dim.reveals.size > 32) {
    const keep = [...dim.reveals.keys()].sort((a, b) => a - b).slice(-32);
    const next = new Map();
    for (const k of keep) next.set(k, dim.reveals.get(k));
    dim.reveals = next;
  }
  res.json({ ok: true });
});

app.get('/reveals/:dim/:turn', (req, res) => {
  const dim = DIMENSIONS.get(req.params.dim);
  const turn = Number(req.params.turn);
  if (!dim || !Number.isFinite(turn)) return res.json({ ok: true, reveals: [] });
  const m = dim.reveals.get(turn);
  res.json({ ok: true, reveals: m ? [...m.values()] : [] });
});

app.post('/heartbeat', (req, res) => {
  const { dimension_id, peer_id } = req.body || {};
  const p = DIMENSIONS.get(dimension_id)?.peers.get(peer_id);
  if (p) p.last_seen = Date.now();
  res.json({ ok: !!p });
});

app.get('/dimensions', (req, res) => {
  const now = Date.now();
  const out = [];
  for (const d of DIMENSIONS.values()) {
    const peers = [...d.peers.values()].filter(p => now - p.last_seen < STALE_MS);
    out.push({ dimension_id: d.dimension_id, dimension_name: d.dimension_name, peer_count: peers.length });
  }
  res.json({ ok: true, dimensions: out });
});

app.get('/peers/:dim', (req, res) => {
  const dim = DIMENSIONS.get(req.params.dim);
  if (!dim) return res.json({ ok: true, peers: [] });
  const now = Date.now();
  const peers = [...dim.peers.values()].filter(p => now - p.last_seen < STALE_MS);
  res.json({ ok: true, dimension_name: dim.dimension_name, peers });
});

app.listen(PORT, BIND_HOST, () => {
  console.log(`[discovery] firebase-stub directory  → http://${BIND_HOST}:${PORT}`);
});
