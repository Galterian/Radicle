// Firebase-stub discovery directory. Spec: "a lightweight cloud directory service
// like Firebase serves as a discovery index for initial peer-to-peer (P2P) coordinate
// matching and clan lobbying" — never game state, only pointers.
//
// Endpoints:
//   GET  /dimensions                 -> list of registered DimensionIds
//   POST /register                   -> peer announces { dimension_id, dimension_name, door_id, peer_id, multiaddrs[], character_id }
//   GET  /peers/:dimensionId         -> active peer list for the Dimension
//   POST /heartbeat                  -> keepalive  { peer_id, dimension_id }

import express from 'express';

const PORT = Number(process.env.DISCOVERY_PORT || 7350);
const DIMENSIONS = new Map();  // dimension_id -> { dimension_name, created_at, peers: Map(peer_id -> entry) }
const STALE_MS = 2 * 60 * 1000;

const app = express();
app.use(express.json({ limit: '256kb' }));

app.post('/register', (req, res) => {
  const { dimension_id, dimension_name, door_id, peer_id, multiaddrs, character_id, creature_id } = req.body || {};
  if (!dimension_id || !peer_id) return res.status(400).json({ ok: false, error: 'missing dimension_id or peer_id' });
  let dim = DIMENSIONS.get(dimension_id);
  if (!dim) {
    dim = { dimension_id, dimension_name, created_at: Date.now(), peers: new Map() };
    DIMENSIONS.set(dimension_id, dim);
  }
  dim.peers.set(peer_id, {
    peer_id, door_id, multiaddrs: multiaddrs || [], character_id, creature_id,
    last_seen: Date.now(),
  });
  console.log(`[discovery] register ${peer_id} @ ${dimension_name} (${multiaddrs?.length || 0} addrs)`);
  res.json({ ok: true, dimension_name: dim.dimension_name });
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[discovery] firebase-stub directory  → http://127.0.0.1:${PORT}`);
});
