// Public real-time bus over Nostr relays (NIP-01). Every peer in a dimension
// publishes ephemeral events (kind 29517 — relays forward but never store
// them) tagged with the dimension id, and subscribes to the same tag. This is
// what lets players on different machines, all behind NAT, exchange the 6s
// commit/reveal handshake without anyone hosting anything: the relays are
// public, plentiful and speak WSS on :443, so corporate proxies let them
// through where libp2p's TCP/hole-punching would not. libp2p still runs for
// LAN/direct speed; the bus is the path that is always there.
//
//   const bus = createNostrBus({ relays, dimId, label, onEvent(type, payload, meta) })
//   bus.publish('env', envelope)      // fan-out to every connected relay
//   bus.pubkey                        // this process's ephemeral identity
//   bus.stats()                       // { open, sent, received, dropped }
//   bus.close()
//
// Keys are ephemeral (one per process) — authority over game state stays with
// the signed hashgraph envelopes, the Nostr signature only proves "same sender
// as before" within a session.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

export const DEFAULT_RELAYS = (process.env.NOSTR_RELAYS || 'wss://relay.primal.net,wss://relay.snort.social,wss://nostr.bitcoiner.social,wss://relay.nostr.net').split(',').map(s => s.trim()).filter(Boolean);
export const CHAOS_KIND = 29517;            // ephemeral range 20000–29999
const TAG_PREFIX = 'chaosd6:';
const LOOKBACK_SEC = 30;                    // how far back a fresh subscription asks for
const MAX_AGE_SEC = 30;                     // ignore anything older — a replay from a previous run, not a live peer

const utf8 = new TextEncoder();

function signEvent(sk, pk, { kind, tags, content, created_at }) {
  const ser = JSON.stringify([0, pk, created_at, kind, tags, content]);
  const idBytes = sha256(utf8.encode(ser));
  const sig = bytesToHex(schnorr.sign(idBytes, sk));
  return { id: bytesToHex(idBytes), pubkey: pk, created_at, kind, tags, content, sig };
}

export function createNostrBus({ relays = DEFAULT_RELAYS, dimId, label = 'peer', onEvent, log = console.log, warn = console.warn }) {
  const sk = randomBytes(32);
  const pk = bytesToHex(schnorr.getPublicKey(sk));
  const dTag = `${TAG_PREFIX}${dimId}`;
  const subId = `chaos-${Math.random().toString(36).slice(2, 8)}`;
  const seen = new Set();                  // event ids already delivered (dedupe across relays)
  const seenOrder = [];
  const stats = { open: 0, sent: 0, received: 0, dropped: 0, relays: {} };
  const sockets = new Map();               // url -> { ws, open, backoff, timer }
  let closed = false;

  function remember(id) {
    if (seen.has(id)) return false;
    seen.add(id); seenOrder.push(id);
    if (seenOrder.length > 4000) for (const old of seenOrder.splice(0, 2000)) seen.delete(old);
    return true;
  }

  function handleFrame(url, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(m)) return;
    if (m[0] === 'EVENT' && m[2]) {
      const ev = m[2];
      if (ev.kind !== CHAOS_KIND || ev.pubkey === pk) return;
      if (!(ev.tags || []).some(t => t[0] === 'd' && t[1] === dTag)) return;
      if (Math.floor(Date.now() / 1000) - ev.created_at > MAX_AGE_SEC) return;
      if (!remember(ev.id)) return;
      stats.received++;
      let body; try { body = JSON.parse(ev.content); } catch { return; }
      try { onEvent?.(body.type, body.payload, { from: body.from, pubkey: ev.pubkey, relay: url, created_at: ev.created_at }); }
      catch (e) { warn(`[${label}] nostr handler error: ${e.message}`); }
    } else if (m[0] === 'OK' && m[2] === false) {
      stats.dropped++;
      if (stats.dropped <= 3 || stats.dropped % 50 === 0) warn(`[${label}] nostr ${url} rejected event: ${m[3]}`);
    } else if (m[0] === 'NOTICE') {
      warn(`[${label}] nostr ${url} notice: ${String(m[1]).slice(0, 120)}`);
    } else if (m[0] === 'CLOSED') {
      warn(`[${label}] nostr ${url} closed subscription: ${m[2]}`);
    }
  }

  function connect(url) {
    if (closed) return;
    const slot = sockets.get(url) || { ws: null, open: false, backoff: 1000, timer: null };
    sockets.set(url, slot);
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return scheduleReconnect(url, slot); }
    slot.ws = ws;
    ws.onopen = () => {
      slot.open = true; slot.backoff = 1000; stats.open++;
      stats.relays[url] = 'open';
      ws.send(JSON.stringify(['REQ', subId, { kinds: [CHAOS_KIND], '#d': [dTag], since: Math.floor(Date.now() / 1000) - LOOKBACK_SEC }]));
      log(`[${label}] nostr ↔ ${url}`);
    };
    ws.onmessage = (e) => handleFrame(url, typeof e.data === 'string' ? e.data : e.data.toString());
    ws.onerror = () => { stats.relays[url] = 'error'; };
    ws.onclose = () => {
      if (slot.open) stats.open--;
      slot.open = false; slot.ws = null; stats.relays[url] = 'closed';
      scheduleReconnect(url, slot);
    };
  }
  function scheduleReconnect(url, slot) {
    if (closed || slot.timer) return;
    slot.timer = setTimeout(() => { slot.timer = null; connect(url); }, slot.backoff);
    slot.backoff = Math.min(slot.backoff * 2, 30_000);
  }
  for (const url of relays) connect(url);

  return {
    pubkey: pk,
    relays: [...relays],
    publish(type, payload) {
      const ev = signEvent(sk, pk, {
        kind: CHAOS_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', dTag], ['t', type], ['expiration', String(Math.floor(Date.now() / 1000) + 300)]],
        content: JSON.stringify({ type, payload, from: label, sent_at: Date.now() }),
      });
      remember(ev.id);   // never echo our own event back through another relay
      const frame = JSON.stringify(['EVENT', ev]);
      let n = 0;
      for (const slot of sockets.values()) if (slot.open && slot.ws?.readyState === 1) { try { slot.ws.send(frame); n++; } catch {} }
      if (n) stats.sent++;
      return n;
    },
    stats() { return { ...stats, relays: { ...stats.relays } }; },
    close() { closed = true; for (const s of sockets.values()) { clearTimeout(s.timer); try { s.ws?.close(); } catch {} } },
  };
}
