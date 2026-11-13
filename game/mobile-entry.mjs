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
// Android has no usable /tmp (absent on the emulator, present-but-unwritable on
// HyperOS), and os.tmpdir() falls back to it (peer.mjs puts GUN's store there).
// Always use <app filesDir>/tmp, next to nodejs-project/; cleared each launch.
// Setting TMPDIR alone is not enough: os.tmpdir() reads it via safeGetenv,
// which ignores the environment in AT_SECURE processes (Android app processes
// on HyperOS), so override os.tmpdir too (peer.mjs uses the default os object).
// A summoned companion runs this same entry in a worker thread (peer.mjs
// spawnCompanionWorker): it must not wipe the tmp dir the host is using
// (its own map-blocks file is in there).
const { isMainThread } = await import('node:worker_threads');
{
  const fs = await import('node:fs');
  const { default: os } = await import('node:os');
  const tmp = new URL('../tmp', import.meta.url).pathname;
  if (isMainThread) fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  process.env.TMPDIR = tmp;
  os.tmpdir = () => tmp;
}
// Node 22's global WebSocket (nostr-bus.mjs dials relays with it; without it
// the bus silently retries forever: "bus: 0/3 relays"). `ws` is the same
// package peer.mjs already uses for its UI socket.
if (typeof globalThis.WebSocket !== 'function') {
  const { default: WebSocket } = await import('ws');
  globalThis.WebSocket = WebSocket;
}
Symbol.dispose ??= Symbol.for('nodejs.dispose');
Symbol.asyncDispose ??= Symbol.for('nodejs.asyncDispose');

// Deep-link join (chaosd6://join?dim=&rid=&peer=&nid=&commit=, forwarded by
// EmbeddedPeer.gd as JOIN_URI): read the dim's Doors from radicle-httpd and
// spawn next to the clicked unit, on its side — what ui-server.mjs's
// joinDimension() does on desktop. peer.mjs reads its env at load, so all of
// this must happen before the import. On any failure we still join the named
// dimension (Nostr bus finds the others), just without the Door placement.
if (isMainThread && process.env.JOIN_URI) {
  const q = new URLSearchParams(process.env.JOIN_URI.split('?')[1] || '');
  const dimName = q.get('dim');
  if (dimName) {
    process.env.DIM_NAME = dimName;
    process.env.DIM_ID = `dim-${dimName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
    try {
      const { fetchDimensionFromHttpd, dimIdOf } = await import('./join-plan.mjs');
      const dim = await fetchDimensionFromHttpd({
        seedHost: process.env.RADICLE_SEED_HOST || '92-5-138-121.sslip.io',
        rid: q.get('rid') || process.env.RADICLE_DIMS_RID || 'rad:z2xbfJfwT3kukR73m8LXmmuvchEwr',
        dimensionName: dimName,
      });
      if (!dim) throw new Error(`${dimName} is not published on the seed`);
      process.env.DIM_ID = dimIdOf(dim);
      // The phone is always a human hand: any other alliance makes peer.mjs
      // run npcPlan() every action, which overwrites the player's picks (the
      // REL7 "can't move after joining" bug — doors[0] was a monster, so the
      // join came up npc_b and the bot AI played EP + a random skill).
      // `team=c` joins the third team (player_c, hostile to both sides).
      const teamC = String(q.get('team') || '').toLowerCase() === 'c';
      const side = teamC ? 'player_c' : 'player';
      const mySide = teamC ? ['player_c', 'npc_c'] : ['player', 'npc_a'];
      // Anchor: the clicked unit's Door, else any Door under the clicked NID,
      // else a Door of my own side (a bare dim link must not land us beside
      // whichever monster happens to be listed first). Team C with no
      // teammate around enters away from everyone instead.
      const want = q.get('peer');
      const anchor = (want && dim.doors.find(d => d.peer_id === want || d.peer_id === `peer:${want}`))
        || (q.get('nid') && dim.doors.find(d => d.nid === q.get('nid')))
        || dim.doors.find(d => mySide.includes(d.alliance))
        || (teamC ? null : dim.doors.find(d => d.alliance !== 'npc_b') || dim.doors[0]);
      // Same code path as the menu's join buttons (mobile-menu.mjs prepareJoin / applyJoinEnv).
      const { prepareJoin, applyJoinEnv } = await import('./mobile-menu.mjs');
      const join = await prepareJoin(dim, { doorId: anchor?.peer_id || null, side, placement: anchor ? 'nearby' : 'random' });
      await applyJoinEnv(join);
      console.log(`[join] ${join.summary}`);
    } catch (e) {
      console.error(`[join] ${dimName}: Door placement failed (${e.message}); joining without it`);
    }
  }
}

// Player profile (user ruling 2026-11-13; profile.mjs, $CHAOSD6_USER_DATA_DIR/profile.json).
//   • opened from a chaosd6:// link: join as the TOP character of my team (random if I have none);
//   • opened plainly: the start menu (mobile-menu.mjs) on PEER_PORT_HTTP until the player picks
//     Test my character / Test a random character / Test my team; then the peer starts as that.
// A pinned character (CHARACTER_ID other than 'random', or PROFILE_CHAR_ID) skips both.
let teamAllies = null;   // test-team: { allies, tier } — started as extra peers once mine is up
// Profile ⇄ chaosD6-Profiles on Radicle (profile-radicle.mjs): started before the menu so it shows the sync
// state, and kept running through the game so deaths / kills reach the team branch.
if (isMainThread && process.env.PROFILE_SYNC !== '0') {
  try {
    const [{ startProfileSync }, { profilePath, attachProfileSync }] = await Promise.all([import('./profile-radicle.mjs'), import('./profile.mjs')]);
    attachProfileSync(startProfileSync({ file: profilePath(), label: process.env.CHAOSD6_DEVICE_LABEL || 'phone' }));
  } catch (e) { console.error(`[mobile] profile sync not started (${e.message})`); }
}
if (isMainThread && (!process.env.CHARACTER_ID || process.env.CHARACTER_ID === 'random') && !process.env.PROFILE_CHAR_ID) {
  try {
    const { profilePath, loadProfile, topCharacter, profileEnv } = await import('./profile.mjs');
    const file = profilePath();
    if (process.env.JOIN_URI) {
      const top = topCharacter(loadProfile(file));
      if (top) {
        Object.assign(process.env, profileEnv(file, top));
        console.log(`[mobile] joining as my top character ${top.name} (${top.base_character})`);
      }
    } else {
      const fs = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const gameDir = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
      // Same data/ lookup as below: ../data next to the bundle (dev tree), else the bundled ./data.
      const dataDir = ['../data', './data'].map(rel => fileURLToPath(new URL(rel, import.meta.url)))
        .find(d => fs.existsSync(`${d}/characters.json`)) || `${gameDir}/data`;
      const { runMenu } = await import('./mobile-menu.mjs');
      const plan = await runMenu({ port: Number(process.env.PEER_PORT_HTTP || 7401), dataDir, assetsDir: process.env.CHAOSD6_ASSETS_DIR || '', gameDir });
      if (plan.mode === 'test-character') Object.assign(process.env, profileEnv(file, plan.character));
      if (plan.mode === 'test-team') {
        Object.assign(process.env, profileEnv(file, plan.hero));
        if (plan.allies.length) teamAllies = { allies: plan.allies, tier: plan.tier, file, profileEnv };
      }
      // Create Dimension: a named dimension instead of the private Ashfall-Micro (peer.mjs publishes its Door).
      if (plan.mode === 'host') {
        Object.assign(process.env, { DIM_NAME: plan.dimName, DIM_ID: plan.dimId });
        if (plan.character) Object.assign(process.env, profileEnv(file, plan.character));
        console.log(`[mobile] new dimension ${plan.dimName} (${plan.dimId}) as ${plan.character?.name || 'a random character'}`);
      }
      // Load old Dimension: peer.mjs hydrates map / obstacles / tokens / traps from the TMJ (RESTORE_FROM_TMJ).
      if (plan.mode === 'restore') {
        Object.assign(process.env, { DIM_NAME: plan.dimName, DIM_ID: plan.dimId, RESTORE_FROM_TMJ: plan.tmjPath, ...(plan.seed ? { MAP_SEED: plan.seed } : {}) });
        if (plan.character) Object.assign(process.env, profileEnv(file, plan.character));
        else if (plan.savedHero) Object.assign(process.env, { CHARACTER_ID: plan.savedHero.characterId, ENTITY_NAME: plan.savedHero.name });
        console.log(`[mobile] loading ${plan.dimName} from ${plan.tmjPath} as ${plan.character?.name || plan.savedHero?.name || 'a random character'}`);
      }
      // Dimensions list: Ally / Enemy / Monster next to a node, or Join my top character / my team (30–50 hexes
      // from the Door) — the env prepareJoin() planned in the menu, applied like the deep link's.
      if (plan.mode === 'join' || plan.mode === 'join-team') {
        const { applyJoinEnv } = await import('./mobile-menu.mjs');
        await applyJoinEnv(plan.join);
        if (plan.character) Object.assign(process.env, profileEnv(file, plan.character));
        else if (plan.creatureId) Object.assign(process.env, { CHARACTER_ID: '', CREATURE_ID: plan.creatureId });
        else if (plan.characterId) process.env.CHARACTER_ID = plan.characterId;
        if (plan.mode === 'join-team' && plan.allies.length) teamAllies = { allies: plan.allies, tier: plan.tier, file, profileEnv, keepMap: true };
        console.log(`[join] ${plan.join.summary}${plan.character ? ` as ${plan.character.name}` : plan.creatureId ? ` as ${plan.creatureId}` : ''}${plan.allies?.length ? ` + ${plan.allies.length} allies (${plan.tier})` : ''}`);
      }
      // test-random: CHARACTER_ID stays 'random' → the block below picks one, as before.
    }
  } catch (e) {
    console.error(`[mobile] profile / menu failed (${e.message}); starting as a random character`);
  }
}

// Test my team (user ruling 2026-11-13): the next count−1 profile characters fight beside me as
// bots (alliance npc_a, like the desktop's ally-1) — ordinary peers, not companions (no
// OWNER_PEER_ID), each in a worker thread running this entry (nodejs-mobile can't exec a second
// node; same reason as peer.mjs spawnCompanionWorker). Placed around my START_TILE by tier:
// strong 2–6 hexes, reachable 9–10 (STRONG_RADIUS 8 < d ≤ REACH_RADIUS 10), never on a
// labyrinth wall. Started one by one once my peer answers /status, each bootstrapping off the
// peers already up (what ui-server.mjs startDimension does).
// keepMap (Join my team): the allies enter the same joined dimension, so they keep its map-blocks file.
async function startTeamAllies({ allies, tier, file, profileEnv, keepMap = false }) {
  const { Worker } = await import('node:worker_threads');
  const { Transform } = await import('node:stream');
  const net = await import('node:net');
  const { seedForDimension } = await import('./js/map.js');
  const { hexDistance } = await import('./js/hex.js');
  const { isLabyrinthWallAt } = await import('./js/features.js');
  // join-plan.mjs hexWalkableAt also refuses water / lava / fortresses; the wall test alone is the fallback.
  const walkable = await import('./join-plan.mjs').then(m => m.hexWalkableAt).catch(() => null);
  const label = process.env.PEER_LABEL || 'mobile-dev';
  const httpPort = Number(process.env.PEER_PORT_HTTP || 7401);
  const status = async (prt) => {
    try { return await fetch(`http://127.0.0.1:${prt}/status`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()); } catch { return null; }
  };
  const waitStatus = async (prt, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 1000))) {
      const st = await status(prt);
      if (st?.multiaddrs) return st;
    }
    return null;
  };
  const freePort = () => new Promise((res, rej) => { const sv = net.createServer(); sv.on('error', rej); sv.listen(0, '127.0.0.1', () => { const prt = sv.address().port; sv.close(() => res(prt)); }); });
  const me = await waitStatus(httpPort, 180_000);
  if (!me) { console.error('[team] my peer never answered /status; no allies'); return; }
  // Tiles: same seed and wall test peer.mjs uses (spawnCompanion).
  const seed = process.env.MAP_SEED || seedForDimension(process.env.DIM_ID || 'dim-ashfall-micro');
  const home = JSON.parse(process.env.START_TILE || '{"q":1,"r":2}');
  const [dMin, dMax] = tier === 'strong' ? [2, 6] : [9, 10];
  const taken = new Set([`${home.q},${home.r}`]);
  const ring = [];
  for (let dq = -dMax; dq <= dMax; dq++) for (let dr = -dMax; dr <= dMax; dr++) {
    const t = { q: home.q + dq, r: home.r + dr }, d = hexDistance(home, t);
    if (d >= dMin && d <= dMax && (walkable ? walkable(seed, t.q, t.r) : !isLabyrinthWallAt(seed, t.q, t.r))) ring.push(t);
  }
  const split = (v) => String(v || '').split(',').filter(Boolean);
  const bootstrap = [...new Set([...me.multiaddrs, ...split(process.env.BOOTSTRAP)])];
  const gunUrls = [...new Set([...(me.gun_url ? [me.gun_url] : []), ...split(process.env.PEER_GUN_URLS)])];
  // A worker's "UI socket on ws://…" / "peer listening on" line would match the plugin's
  // node_ready regex and repoint the phone's HUD at the ally — reword it (line-buffered).
  const reword = (s) => s.replace(/UI socket on ws:\/\//g, 'ally UI socket at ').replace(/peer listening on/g, 'ally listening at');
  const relabel = () => {
    let tail = '';
    return new Transform({
      transform(chunk, _enc, cb) { const lines = (tail + chunk).split('\n'); tail = lines.pop(); cb(null, lines.length ? reword(lines.join('\n') + '\n') : ''); },
      flush(cb) { cb(null, tail ? reword(tail) : ''); },
    });
  };
  for (const [i, c] of allies.entries()) {
    const free = ring.filter(t => !taken.has(`${t.q},${t.r}`));
    const tile = free[Math.floor(Math.random() * free.length)];
    if (!tile) { console.error(`[team] no free tile ${dMin}–${dMax} hexes from (${home.q},${home.r}) for ${c.name}`); continue; }
    taken.add(`${tile.q},${tile.r}`);
    const [pL, pH, pG] = await Promise.all([freePort(), freePort(), freePort()]);
    const tag = `${label}-ally${i + 1}`;
    const env = {
      ...process.env,
      ...profileEnv(file, c),
      PEER_LABEL: tag, ALLIANCE: 'npc_a', CREATURE_ID: '', START_TILE: JSON.stringify(tile),
      PEER_PORT_LIBP2P: String(pL), PEER_PORT_HTTP: String(pH), PEER_PORT_GUN: String(pG),
      BOOTSTRAP: bootstrap.join(','), PEER_GUN_URLS: gunUrls.join(','), JOIN_SYNC_WAIT_MS: '8000',
      OWNER_PEER_ID: '', PHANTOM: '', REPLACES_PEER_ID: '', START_LIFE: '', TEAM_GATE: '', TEAM_GATE_DOOR: '', RESTORE_FROM_TMJ: '',
    };
    delete env.JOIN_URI;
    if (!keepMap) { delete env.MAP_BLOCKS_FILE; delete env.MAP_BLOCKS; }
    const w = new Worker(new URL('./mobile-entry.mjs', import.meta.url), { env, stdout: true, stderr: true });
    w.stdout.pipe(relabel()).on('data', b => process.stdout.write(b));
    w.stderr.pipe(relabel()).on('data', b => process.stderr.write(b));
    w.on('error', (e) => console.error(`[team] ${tag} (${c.name}) failed: ${e.message}`));
    w.on('exit', (code) => console.log(`[team] ${tag} (${c.name}) left (${code})`));
    console.log(`[team] ${c.name} (${c.base_character}) enters as ${tag} at (${tile.q},${tile.r}), ${hexDistance(home, tile)} hexes from me (${tier})`);
    const st = await waitStatus(pH, 120_000);
    if (st) { bootstrap.push(...st.multiaddrs); if (st.gun_url) gunUrls.push(st.gun_url); }
  }
}
if (teamAllies) startTeamAllies(teamAllies).catch(e => console.error(`[team] allies failed: ${e.message}`));

// The phone starts as a random character each launch (user ruling 2026-11-12) unless one is pinned.
// Same data/ lookup as peer.mjs (../data next to the bundle), falling back to the bundled ./data.
if (isMainThread && (!process.env.CHARACTER_ID || process.env.CHARACTER_ID === 'random') && !process.env.CREATURE_ID) {
  const fs = await import('node:fs');
  let ids = [];
  for (const rel of ['../data/characters.json', './data/characters.json']) {
    try {
      const doc = JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
      ids = (doc.entries || []).filter(e => e?.id && (e.versions || []).some(v => !['rejected', 'superseded'].includes(v.status))).map(e => e.id);
      if (ids.length) break;
    } catch { /* try the next location */ }
  }
  process.env.CHARACTER_ID = ids.length ? ids[Math.floor(Math.random() * ids.length)] : 'char_oran_rief';
  console.log(`[mobile] random character: ${process.env.CHARACTER_ID} (of ${ids.length})`);
}

await import('./peer.mjs');
