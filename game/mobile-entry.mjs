// Android entry point for the embedded peer (EmbeddedPeer.gd starts this, not
// peer.mjs). nodejs-mobile's Node 18 is built without ICU, so
// `new TextDecoder('utf-8', { fatal: true })` throws ERR_NO_ICU — cborg does
// exactly that at module load, Node exits, and the whole app is torn down.
// Patch TextDecoder BEFORE anything imports cborg: on ERR_NO_ICU retry without
// `fatal` (UTF-8 still decodes; invalid bytes become U+FFFD instead of
// throwing). Same for the newer-Node globals libp2p expects (below). No
// static imports here — they would be hoisted above the patches.

const NativeTextDecoder = globalThis.TextDecoder;
if (NativeTextDecoder) {
  globalThis.TextDecoder = class TextDecoder extends NativeTextDecoder {
    constructor(label, options) {
      try {
        super(label, options);
      } catch (e) {
        if (e?.code !== 'ERR_NO_ICU' || !options?.fatal) throw e;
        super(label, { ...options, fatal: false });
      }
    }
  };
}

// Node 19–22 globals the libp2p stack assumes (Node 18 lacks or flags them).
if (typeof globalThis.CustomEvent !== 'function') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    #detail;
    constructor(type, options) {
      super(type, options);
      this.#detail = options?.detail ?? null;
    }
    get detail() { return this.#detail; }
  };
}
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new this((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}
if (typeof AbortSignal.any !== 'function') {
  AbortSignal.any = function any(signals) {
    const ac = new AbortController();
    for (const s of signals) {
      if (s.aborted) { ac.abort(s.reason); return ac.signal; }
    }
    const onAbort = (ev) => {
      for (const s of signals) s.removeEventListener('abort', onAbort);
      ac.abort(ev.target.reason);
    };
    for (const s of signals) s.addEventListener('abort', onAbort);
    return ac.signal;
  };
}
if (!globalThis.crypto?.getRandomValues) {
  const { webcrypto } = await import('node:crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
}
// Android has no /tmp, and os.tmpdir() falls back to it (peer.mjs puts GUN's
// store there). Use <app filesDir>/tmp, next to nodejs-project/.
{
  const fs = await import('node:fs');
  const tmp = fs.existsSync(process.env.TMPDIR || '/tmp') ? null
    : new URL('../tmp/', import.meta.url).pathname;
  if (tmp) { fs.mkdirSync(tmp, { recursive: true }); process.env.TMPDIR = tmp; }
}
Symbol.dispose ??= Symbol.for('nodejs.dispose');
Symbol.asyncDispose ??= Symbol.for('nodejs.asyncDispose');

// Deep-link join (chaosd6://join?dim=&rid=&peer=&nid=&commit=, forwarded by
// EmbeddedPeer.gd as JOIN_URI): read the dim's Doors from radicle-httpd and
// spawn next to the clicked unit, on its side — what ui-server.mjs's
// joinDimension() does on desktop. peer.mjs reads its env at load, so all of
// this must happen before the import. On any failure we still join the named
// dimension (Nostr bus finds the others), just without the Door placement.
if (process.env.JOIN_URI) {
  const q = new URLSearchParams(process.env.JOIN_URI.split('?')[1] || '');
  const dimName = q.get('dim');
  if (dimName) {
    process.env.DIM_NAME = dimName;
    process.env.DIM_ID = `dim-${dimName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
    try {
      const { fetchDimensionFromHttpd, planJoin, dimIdOf } = await import('./join-plan.mjs');
      const dim = await fetchDimensionFromHttpd({
        seedHost: process.env.RADICLE_SEED_HOST || '92-5-138-121.sslip.io',
        rid: q.get('rid') || process.env.RADICLE_DIMS_RID || 'rad:z2xbfJfwT3kukR73m8LXmmuvchEwr',
        dimensionName: dimName,
      });
      if (!dim) throw new Error(`${dimName} is not published on the seed`);
      process.env.DIM_ID = dimIdOf(dim);
      // Anchor: the clicked unit's Door, else any Door under the clicked NID.
      const anchor = dim.doors.find(d => d.peer_id === q.get('peer') || d.peer_id === `peer:${q.get('peer')}`)
        || dim.doors.find(d => d.nid === q.get('nid')) || dim.doors[0];
      // "Join as ally": side A for a player/npc_a unit (we stay a human
      // 'player'), npc_b for an npc_b unit.
      const side = anchor?.alliance === 'npc_b' ? 'npc_b' : 'player';
      const plan = planJoin(dim, { doorId: anchor?.peer_id, side });
      const fs = await import('node:fs');
      const blocksFile = `${process.env.TMPDIR || '/tmp'}/map-blocks.${Date.now()}.json`;
      fs.writeFileSync(blocksFile, JSON.stringify(plan.knownMap.blocks()));
      Object.assign(process.env, {
        PEER_LABEL: plan.peerLabel,
        ENTITY_NAME: plan.peerLabel,
        ALLIANCE: side,
        START_TILE: JSON.stringify(plan.startTile),
        MAP_SEED: String(plan.knownMap.seed),
        MAP_BLOCKS_FILE: blocksFile,
        BOOTSTRAP: plan.network.bootstrap.join(','),
        PEER_GUN_URLS: plan.network.gunRelays.join(','),
        JOIN_SYNC_WAIT_MS: plan.liveDoors.length ? '8000' : '500',
      });
      // nostr-bus.mjs already froze NOSTR_RELAYS into DEFAULT_RELAYS when
      // join-plan.mjs loaded it; peer.mjs uses that same array, so extend it.
      const { DEFAULT_RELAYS } = await import('./nostr-bus.mjs');
      for (const r of plan.network.relays) if (!DEFAULT_RELAYS.includes(r)) DEFAULT_RELAYS.push(r);
      console.log(`[join] ${dimName}: next to ${anchor?.peer_id} at ${anchor?.tile?.q},${anchor?.tile?.r} → ${side} ${plan.peerLabel} at ${plan.startTile.q},${plan.startTile.r} (${dim.doors.length} Doors, ${plan.liveDoors.length} live, ${plan.knownMap.size()} hexes)`);
    } catch (e) {
      console.error(`[join] ${dimName}: Door placement failed (${e.message}); joining without it`);
    }
  }
}

await import('./peer.mjs');
