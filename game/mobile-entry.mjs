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

// The env as the app started me (before any join / menu pick): a Dimension Out back to the start menu (below)
// resets to it before the next pick.
const BASE_ENV = { ...process.env };
// Deep-link join (chaosd6://join?dim=&rid=&peer=&nid=&commit=, forwarded by
// EmbeddedPeer.gd as JOIN_URI): read the dim's Doors from radicle-httpd and
// spawn next to the clicked unit, on its side — what ui-server.mjs's
// joinDimension() does on desktop. peer.mjs reads its env at load, so all of
// this must happen before the import. On any failure we still join the named
// dimension (Nostr bus finds the others), just without the Door placement.
if (isMainThread && process.env.JOIN_URI) {
  const q = new URLSearchParams(process.env.JOIN_URI.split('?')[1] || '');
  if (q.get('nogun') === '1') process.env.NOGUN = '1';   // M6 step 1 test switch on the phone (EmbeddedPeer's env is fixed)
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
// (a function: a Dimension Out on the phone comes back here for the next pick — see the loop at the end)
async function menuToEnv() {
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
        // AI skirmish (as the desktop's Create Dimension, ui-server.mjs; user 2026-11-23): a rival team (npc_c) and NPC
        // builders (npc_a) as workers. No llama on the phone: they ask the OCI 1.7B (llm.json), else the rules play them.
        if (process.env.AI_SKIRMISH !== '0') teamAllies = { allies: [], tier: 'strong', file, profileEnv, bots: await skirmishBots() };
      }
      // A fresh dimension (Create / the tests): the layout-2 seed (half-size villages, dens — user 2026-11-28), as the
      // desktop launcher's startDimension; a restore keeps its saved seed (below), a join takes the Door's.
      if (plan.mode === 'host' || String(plan.mode || '').startsWith('test')) {
        const { seedForNewDimension } = await import('./js/map.js');
        process.env.MAP_SEED ||= seedForNewDimension(process.env.DIM_ID || 'dim-ashfall-micro');
      }
      // Load old Dimension: peer.mjs hydrates map / obstacles / tokens / traps from the TMJ (RESTORE_FROM_TMJ).
      if (plan.mode === 'restore') {
        Object.assign(process.env, { DIM_NAME: plan.dimName, DIM_ID: plan.dimId, RESTORE_FROM_TMJ: plan.tmjPath, ...(plan.seed ? { MAP_SEED: plan.seed } : {}) });
        if (plan.character) Object.assign(process.env, profileEnv(file, plan.character));
        else if (plan.savedHero) Object.assign(process.env, { CHARACTER_ID: plan.savedHero.characterId, ENTITY_NAME: plan.savedHero.name });
        // The saved hero's side (a human npc_b hero plays on the monsters' side, user ruling 2026-11-15).
        if (plan.alliance && plan.alliance !== 'player') Object.assign(process.env, { ALLIANCE: plan.alliance, HUMAN: '1' });
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
        // Join my team: the allies are the third team's bots (npc_a / npc_c); a quiet join also brings back the
        // Door-known monsters at their last tiles (user rulings 2026-11-15) — all as in-process workers.
        const allies = plan.mode === 'join-team' ? plan.allies : [];
        if (allies.length || plan.monsters?.length) teamAllies = { allies, tier: plan.tier || 'strong', file, profileEnv, keepMap: true, allySide: plan.allySide || 'npc_a', monsters: plan.monsters || [] };
        console.log(`[join] ${plan.join.summary}${plan.character ? ` as ${plan.character.name}` : plan.creatureId ? ` as ${plan.creatureId}` : ''}${allies.length ? ` + ${allies.length} allies (${plan.tier}, ${plan.allySide})` : ''}`);
      }
      // test-random: CHARACTER_ID stays 'random' → the block below picks one, as before. The hero plays my draft
      // class / skills / effects first, then my team's published ones (test-priority.mjs, user 2026-11-23; reset
      // with the rest of the env after a Dimension Out).
      if (plan.mode === 'test-random') {
        const { testPriorityEnv } = await import('./test-priority.mjs');
        const prio = testPriorityEnv(file, { loadProfile });
        Object.assign(process.env, prio.env);
        console.log(`[mobile] Test Random character: ${prio.summary}`);
        // with other teams' GameModels proposals (user 2026-11-25: the phone has every GameModels feature; ui-server.mjs
        // does the same on a desktop): up to 3 foreign proposals from this node's Radicle storage compiled over the staged
        // GameModels main into a temp catalog every peer reads. A proposed NPC spawns near me (peer.mjs testNpcTick); a
        // proposed monster enters as a foe 6–8 hexes out (the phone has no launcher roster for TEST_FOES).
        if (plan.proposals) {
          try {
            const { proposalTestCatalog } = await import('./gm-proposals.mjs');
            const { whoAmI } = await import('./proposal-votes.mjs');
            const { join, dirname } = await import('node:path');   // beside the profile: Android has no writable /tmp
            const pt = await proposalTestCatalog({ profileFile: file, me: whoAmI({ profileFile: file }), max: 3, outDir: join(dirname(file), 'gm-proposals', String(plan.dimId || 'test')) });
            if (!pt.file) console.log('[mobile] Test Random: no other team\'s GameModels proposal to try');
            else {
              const { TEST_FOES, TEST_NEAR_VILLAGE, ...env } = pt.env;
              Object.assign(process.env, env);
              const foes = String(TEST_FOES || '').split(',').filter(id => /^mon_[a-z0-9_]+$/.test(id)).map(id => ({ creature_id: id, name: pt.proposals.find(p => p.id === id)?.name || id }));
              if (foes.length) teamAllies = { allies: [], tier: 'strong', file, profileEnv, foes };
              console.log(`[mobile] Test Random with proposals: ${pt.proposals.map(p => `${p.kind} ${p.name || p.id} (${p.team || '?'})`).join(', ')}`);
            }
          } catch (e) { console.warn(`[mobile] Test Random: proposals skipped — ${e.message}`); }
        }
      }
    }
  } catch (e) {
    console.error(`[mobile] profile / menu failed (${e.message}); starting as a random character`);
  }
}
}
await menuToEnv();

// Test my team (user ruling 2026-11-13): the next count−1 profile characters fight beside me as
// bots (alliance npc_a, like the desktop's ally-1) — ordinary peers, not companions (no
// OWNER_PEER_ID), each in a worker thread running this entry (nodejs-mobile can't exec a second
// node; same reason as peer.mjs spawnCompanionWorker). Placed around my START_TILE by tier:
// strong 2–6 hexes, reachable 9–10 (STRONG_RADIUS 8 < d ≤ REACH_RADIUS 10), never on a
// labyrinth wall. Started one by one once my peer answers /status, each bootstrapping off the
// peers already up (what ui-server.mjs startDimension does).
// keepMap (Join my team): the allies enter the same joined dimension, so they keep its map-blocks file.
// allySide: the team's bot side (npc_a; npc_c when I am the third team). monsters: a quiet join's regenerated
// Door-known monsters [{ label, name, creature_id, tile, life }] — npc_b bots on their last tiles, under their old
// peer ids (so the Doors' records of them are superseded, not doubled), started after the allies.
// The AI skirmish of a Create Dimension (ui-server.mjs startDimension: AI_RIVALS 2 rivals 7–9 hexes out, npc_c;
// AI_BUILDERS 2 builders 2–3 hexes from me, npc_a), each a random character.
async function skirmishBots() {
  const chars = await characterList();
  const any = () => chars[Math.floor(Math.random() * chars.length)] || { id: 'char_oran_rief', name: 'Oran Rief' };
  const n = (v, d) => Math.max(0, Number(v ?? d) || 0);
  return [
    ...Array.from({ length: n(process.env.AI_RIVALS, 2) }, (_, i) => { const c = any(); return { tag: `rival${i + 1}`, character: c.id, name: `Rival — ${c.name}`, alliance: 'npc_c', aiRole: 'rival', ring: [7, 9] }; }),
    ...Array.from({ length: n(process.env.AI_BUILDERS, 2) }, (_, i) => { const c = any(); return { tag: `builder${i + 1}`, character: c.id, name: `Builder — ${c.name}`, alliance: 'npc_a', aiRole: 'builder', ring: [2, 3] }; }),
  ];
}
async function startTeamAllies({ allies, tier, file, profileEnv, keepMap = false, allySide = 'npc_a', monsters = [], bots = [], foes = [] }) {
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
  const taken = new Set([`${home.q},${home.r}`, ...monsters.map(m => `${m.tile.q},${m.tile.r}`)]);
  const ringOf = (lo, hi) => {
    const out = [];
    for (let dq = -hi; dq <= hi; dq++) for (let dr = -hi; dr <= hi; dr++) {
      const t = { q: home.q + dq, r: home.r + dr }, d = hexDistance(home, t);
      if (d >= lo && d <= hi && (walkable ? walkable(seed, t.q, t.r) : !isLabyrinthWallAt(seed, t.q, t.r))) out.push(t);
    }
    return out;
  };
  const ring = ringOf(dMin, dMax);
  const split = (v) => String(v || '').split(',').filter(Boolean);
  const bootstrap = [...new Set([...me.multiaddrs, ...split(process.env.BOOTSTRAP)])];
  // NOGUN=1 (M6 step 1): the workers inherit it via process.env and get no Gun relays to mesh with.
  const gunUrls = process.env.NOGUN === '1' ? [] : [...new Set([...(me.gun_url ? [me.gun_url] : []), ...split(process.env.PEER_GUN_URLS)])];
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
  const startWorker = async (tag, who, envExtra) => {
    const [pL, pH, pG] = await Promise.all([freePort(), freePort(), freePort()]);
    const env = {
      ...process.env,
      OWNER_PEER_ID: '', PHANTOM: '', REPLACES_PEER_ID: '', START_LIFE: '', TEAM_GATE: '', TEAM_GATE_DOOR: '', RESTORE_FROM_TMJ: '', HUMAN: '',
      ...envExtra,
      PEER_LABEL: tag, PEER_PORT_LIBP2P: String(pL), PEER_PORT_HTTP: String(pH), PEER_PORT_GUN: String(pG),
      BOOTSTRAP: bootstrap.join(','), PEER_GUN_URLS: gunUrls.join(','), JOIN_SYNC_WAIT_MS: '8000',
    };
    delete env.JOIN_URI;
    if (!keepMap) { delete env.MAP_BLOCKS_FILE; delete env.MAP_BLOCKS; }
    // S5 (2026-11-27): the same small young generation + old-space ceiling as peer.mjs gives its companions (COMPANION_LIMITS).
    const semi = Number(process.env.COMPANION_SEMI_MB ?? 2), old = Number(process.env.COMPANION_OLD_MB ?? 384);
    const resourceLimits = { ...(semi > 0 ? { maxYoungGenerationSizeMb: semi * 3 } : {}), ...(old > 0 ? { maxOldGenerationSizeMb: old } : {}) };
    const w = new Worker(new URL('./mobile-entry.mjs', import.meta.url), { env, stdout: true, stderr: true, resourceLimits });
    (globalThis.__chaosWorkers ||= []).push(w);   // stopped with my peer after a Dimension Out (the loop below)
    w.stdout.pipe(relabel()).on('data', b => process.stdout.write(b));
    w.stderr.pipe(relabel()).on('data', b => process.stderr.write(b));
    w.on('error', (e) => console.error(`[team] ${tag} (${who}) failed: ${e.message}`));
    w.on('exit', (code) => console.log(`[team] ${tag} (${who}) left (${code})`));
    const st = await waitStatus(pH, 120_000);
    if (st) { bootstrap.push(...st.multiaddrs); if (st.gun_url) gunUrls.push(st.gun_url); }
  };
  for (const [i, c] of allies.entries()) {
    const free = ring.filter(t => !taken.has(`${t.q},${t.r}`));
    const tile = free[Math.floor(Math.random() * free.length)];
    if (!tile) { console.error(`[team] no free tile ${dMin}–${dMax} hexes from (${home.q},${home.r}) for ${c.name}`); continue; }
    taken.add(`${tile.q},${tile.r}`);
    const tag = `${label}-ally${i + 1}`;
    console.log(`[team] ${c.name} (${c.base_character}) enters as ${tag} (${allySide}) at (${tile.q},${tile.r}), ${hexDistance(home, tile)} hexes from me (${tier})`);
    // AI skirmish (llm-route.mjs): no llama on the phone — my allies ask my teammates' nodes (signed with this device's
    // key, direct libp2p) or the OCI route (<profile dir>/llm.json); none reachable → the rules play them, as before.
    const ai = process.env.AI_SKIRMISH !== '0' ? { AI_ROLE: 'team', LLM_PROFILE_FILE: file, LLM_URL: process.env.LLM_URL || '' } : {};
    await startWorker(tag, c.name, { ...profileEnv(file, c), ALLIANCE: allySide, CREATURE_ID: '', START_TILE: JSON.stringify(tile), ...ai });
  }
  for (const m of monsters) {
    console.log(`[regen] ${m.name} (${m.creature_id}) comes back as ${m.label} at its last tile (${m.tile.q},${m.tile.r})${m.life ? ` with ${m.life} life` : ''}`);
    await startWorker(m.label, m.name, { PROFILE_FILE: '', PROFILE_CHAR_ID: '', PROFILE_TEAM: '', CHARACTER_ID: '', CREATURE_ID: m.creature_id, ENTITY_NAME: m.name,
      ALLIANCE: 'npc_b', START_TILE: JSON.stringify(m.tile), START_LIFE: m.life ? String(m.life) : '', FORCE_CLASS: '' });
  }
  // Test Random with proposals: another team's proposed monster, a wild foe (npc_b) 6–8 hexes from me
  for (const [i, f] of foes.entries()) {
    const free = ringOf(6, 8).filter(t => !taken.has(`${t.q},${t.r}`));
    const tile = free[Math.floor(Math.random() * free.length)];
    if (!tile) { console.error(`[proposal] no free tile 6–8 hexes out for ${f.name}`); continue; }
    taken.add(`${tile.q},${tile.r}`);
    console.log(`[proposal] ${f.name} (${f.creature_id}) enters as ${label}-foe${i + 1} at (${tile.q},${tile.r})`);
    await startWorker(`${label}-foe${i + 1}`, f.name, { PROFILE_FILE: '', PROFILE_CHAR_ID: '', PROFILE_TEAM: '', CHARACTER_ID: '', CREATURE_ID: f.creature_id, ENTITY_NAME: f.name,
      ALLIANCE: 'npc_b', START_TILE: JSON.stringify(tile), START_LIFE: '', FORCE_CLASS: '' });
  }
  // AI skirmish bots (skirmishBots): no profile, no llama here (LLM_URL '') → llm-route asks the OCI 1.7B through
  // LLM_REMOTE_FILE (my llm.json), never my teammates' nodes (they are not my team's bots); none reachable → the rules.
  const llmFile = `${String(file).replace(/[\\/][^\\/]*$/, '')}/llm.json`;
  for (const b of bots) {
    const free = ringOf(b.ring[0], b.ring[1]).filter(t => !taken.has(`${t.q},${t.r}`));
    const tile = free[Math.floor(Math.random() * free.length)];
    if (!tile) { console.error(`[skirmish] no free tile ${b.ring[0]}–${b.ring[1]} hexes from (${home.q},${home.r}) for ${b.name}`); continue; }
    taken.add(`${tile.q},${tile.r}`);
    const tag = `${label}-${b.tag}`;
    console.log(`[skirmish] ${b.name} (${b.character}) enters as ${tag} (${b.alliance}, ${b.aiRole}) at (${tile.q},${tile.r}), ${hexDistance(home, tile)} hexes from me`);
    await startWorker(tag, b.name, { PROFILE_FILE: '', PROFILE_CHAR_ID: '', PROFILE_TEAM: '', CHARACTER_ID: b.character, CREATURE_ID: '', ENTITY_NAME: b.name,
      ALLIANCE: b.alliance, START_TILE: JSON.stringify(tile), FORCE_CLASS: '', AI_ROLE: b.aiRole, LLM_URL: '', LLM_PROFILE_FILE: '',
      // only the rivals ask the OCI model (user 2026-11-24: it is too slow for four bots); builders build by the rules
      LLM_REMOTE_FILE: b.aiRole === 'builder' ? '' : llmFile,
      // the OCI round trip needs more than the 4.5 s default: the whole planning window (llmKick caps it at its end − 400 ms)
      LLM_TIMEOUT_MS: process.env.LLM_TIMEOUT_MS || '5800',
      LLM_SERVE: '0', FORCE_FOREIGN_CLASS: '', FOREIGN_CLASS_REF_JSON: '', FORCE_FOREIGN_SKILL: '', FORCE_FOREIGN_EFFECT: '', FOREIGN_CARD_REFS_JSON: '', TEST_PRIORITY: '' });
  }
}
// Playable characters of data/characters.json: [{ id, name }] (the active versions; ../data next to the bundle, else ./data).
async function characterList() {
  const fs = await import('node:fs');
  for (const rel of ['../data/characters.json', './data/characters.json']) {
    try {
      const doc = JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
      const out = (doc.entries || []).filter(e => e?.id && (e.versions || []).some(v => !['rejected', 'superseded'].includes(v.status))).map(e => ({ id: e.id, name: e.name || e.id }));
      if (out.length) return out;
    } catch { /* try the next location */ }
  }
  return [];
}
// The phone starts as a random character each launch (user ruling 2026-11-12) unless one is pinned.
// Same data/ lookup as peer.mjs (../data next to the bundle), falling back to the bundled ./data.
async function pickRandomCharacter() {
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
}

// Run the game. A worker (summon / ally / regenerated monster) runs its peer once. The phone's main thread loops:
// Dimension Out (rule_dimension_out, peer.mjs leaveDimension) must bring the start menu back, and nodejs-mobile
// starts Node only once per app process — so instead of exiting, the peer calls __chaosMobileLeave; I stop it
// (__chaosPeerStop: its sockets, libp2p, bus, Gun relay), clear the timers its module started, stop its workers,
// reset the env to the app's and serve the menu again; the next pick loads a fresh copy of peer.mjs (?run=N).
if (!isMainThread) {
  await pickRandomCharacter();
  await import('./peer.mjs');
} else {
  const nativeSetTimeout = globalThis.setTimeout, nativeSetInterval = globalThis.setInterval;
  const nativeClearTimeout = globalThis.clearTimeout, nativeClearInterval = globalThis.clearInterval;
  for (let run = 1; ; run++) {
    if (run > 1) {
      for (const k of Object.keys(process.env)) if (!(k in BASE_ENV)) delete process.env[k];
      Object.assign(process.env, BASE_ENV);
      delete process.env.JOIN_URI;   // the deep link was the first game's
      teamAllies = null;
      await menuToEnv();
    }
    if (teamAllies) startTeamAllies(teamAllies).catch(e => console.error(`[team] allies failed: ${e.message}`));
    await pickRandomCharacter();
    // Timers created by this run's peer module (its stack names peer.mjs) — cleared when it stops.
    const mine = new Set();
    const copyProps = (dst, src) => { for (const k of Object.keys(src)) { try { dst[k] = src[k]; } catch {} } return dst; };   // own enumerable string keys only
    // (a short stack: building a full one on every timer Gun / libp2p / yamux start was a steady CPU cost on the phone)
    const fromPeer = () => { const lim = Error.stackTraceLimit; Error.stackTraceLimit = 24; try { return /peer\.mjs/.test(new Error().stack || ''); } finally { Error.stackTraceLimit = lim; } };
    // (Gun hangs helpers on the global setTimeout — setTimeout.each / .turn / .poll: the wrappers carry them over)
    // A timeout leaves `mine` when it fires or is cleared (2026-11-27: the Set kept every timer of the game — and each
    // one's callback closure — for the whole session: part of the phone's 700–900 MB).
    globalThis.setTimeout = copyProps(function (fn, ...a) {
      if (typeof fn !== 'function' || !fromPeer()) return nativeSetTimeout(fn, ...a);
      const h = nativeSetTimeout(function (...b) { mine.delete(h); return fn.apply(this, b); }, ...a);
      mine.add(h); return h;
    }, nativeSetTimeout);
    globalThis.setInterval = copyProps(function (...a) { const h = nativeSetInterval(...a); if (fromPeer()) mine.add(h); return h; }, nativeSetInterval);
    globalThis.clearTimeout = function (h) { mine.delete(h); return nativeClearTimeout(h); };
    globalThis.clearInterval = function (h) { mine.delete(h); return nativeClearInterval(h); };
    const left = new Promise(res => { globalThis.__chaosMobileLeave = res; });
    // (not awaited: a module whose top level never settles must not keep me from stopping it)
    import(run === 1 ? './peer.mjs' : `./peer.mjs?run=${run}`).catch(e => console.error(`[mobile] peer failed: ${e.stack || e.message}`));
    const info = await left;
    console.log(`[mobile] ${info?.dimension || 'the dimension'}: ${info?.why || 'left'} — stopping the game, back to the start menu`);
    try { await globalThis.__chaosPeerStop?.(); } catch (e) { console.error(`[mobile] peer stop: ${e.message}`); }
    for (const h of mine) { nativeClearTimeout(h); nativeClearInterval(h); }
    for (const w of globalThis.__chaosWorkers || []) { try { await w.terminate(); } catch {} }
    globalThis.__chaosWorkers = [];
    copyProps(nativeSetTimeout, globalThis.setTimeout); copyProps(nativeSetInterval, globalThis.setInterval);   // keep what Gun added
    globalThis.setTimeout = nativeSetTimeout; globalThis.setInterval = nativeSetInterval;
    globalThis.clearTimeout = nativeClearTimeout; globalThis.clearInterval = nativeClearInterval;
    globalThis.__chaosMobileLeave = null; globalThis.__chaosPeerStop = null;
  }
}
