// The phone's start menu (user ruling 2026-11-13). When the app is opened without a chaosd6://
// link, mobile-entry.mjs runs this BEFORE peer.mjs: a small HTTP server on the peer's own port
// (PEER_PORT_HTTP, 7401) that serves the same browser UI the peer serves (index.html, css/, js/,
// /data/*, /assets/*) plus the profile API (profile.mjs handleProfileApi) and POST /api/launch.
// launcher.js opens it as /?mobile=1&menu=1 (profile panel only). The first valid launch is
// answered `{ peerPort }`, the server closes (the port is free again for peer.mjs) and runMenu()
// resolves with the plan; the page then navigates to /?peer=<port>&mobile=1.
//
// nodejs-mobile starts Node once per app process, so the menu and the peer share it: the menu
// must be gone before peer.mjs is imported (peer.mjs reads its env at load and binds the port).
//
// Its ready line contains "peer listening on 127.0.0.1:<port>" so NodejsMobilePlugin's
// node_ready regex fires for the menu too (EmbeddedPeer.gd tells the two apart by the "[menu]"
// prefix and MobileHudWebView.gd opens the menu page instead of the game).
//
// Launch plans (resolved value):
//   { mode: 'test-random' }                                  today's random-character test game
//   { mode: 'test-character', character }                    that profile character
//   { mode: 'test-team', hero, allies: [character…], tier }  top character + the next count−1
//   { mode: 'host', dimName, dimId, character|null }         Create Dimension <name> (top character or random)
//   { mode: 'restore', tmjPath, dimName, dimId, seed, character|null, savedHero|null }   Load old Dimension
//   { mode: 'join', dimName, side, character|null, characterId, creatureId, join, monsters }   a unit's name (next to it, nearTile,
//                                                                                        as its ally — npc_b next to a monster, HUMAN=1)
//   { mode: 'join-team', dimName, side, allySide, hero, character, allies, tier, join, monsters }  Join my top character / team
//                                                                                        (a new team: join-plan.mjs newTeamSide)
// `monsters` = Door-known monsters a quiet join regenerates at their last tiles (mobile-entry.mjs starts them as workers).
// A profile character the Doors know alive in ANY known dimension is refused with 409 (no cloning, one dimension at a
// time — user rulings 2026-11-15) — except for the test modes, which are local and private (user 2026-11-16): their
// plans carry { private: true, dimName, dimId (unguessable), env (join-plan.mjs PRIVATE_TEST_ENV) } and never refuse.
// `join` = prepareJoin() output: { env (peer.mjs env vars, incl. the map-blocks file), relays, summary } —
// mobile-entry.mjs applies it with applyJoinEnv(), the same path its chaosd6:// deep link takes.
//
// Besides the profile API the menu answers GET /api/dimensions (published dimensions, read from
// radicle-httpd on the seed) and GET /api/dimensions/local (TMJ saves on the phone), both with the launcher stats
// (dims-local.mjs enrichDimensions), and POST /api/dimensions/delete {dimensionName|dimId} — the ✕ of an old
// dimension: removes the phone's save dir + tape dir only, tombstones a Radicle-listed one (the seed keeps it).
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleProfileApi, profilePath, loadProfile, characterOf, teamCharacters, topCharacter } from './profile.mjs';

const SEED_HOST = () => process.env.RADICLE_SEED_HOST || '92-5-138-121.sslip.io';
const DIMS_RID = () => process.env.RADICLE_DIMS_RID || 'rad:z2xbfJfwT3kukR73m8LXmmuvchEwr';
// Same slug rule as ui-server.mjs / join-plan.mjs (DIM_ID = dim-<slug>).
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const dimIdFor = (name) => `dim-${slug(name)}`;
export const JOIN_SIDES = ['player', 'player_c', 'player_d', 'npc_a', 'npc_b', 'npc_c', 'npc_d'];

// ---------------------------------------------------------------------------------------------
// Joining through a Door — one code path for the chaosd6:// deep link and the menu's join buttons.
// planJoin (join-plan.mjs) places the joiner from the Doors; the known map goes to a file (too big for env).
// `nearTile` {q,r}: next to that unit (the menu's unit list). Stale Doors work: no live Door → the joiner
// starts the dimension from the Doors' map (JOIN_SYNC_WAIT_MS 500, nobody to sync with).
// `regen` (quiet dimensions): plan the Door-known monsters' return (join-plan.mjs planJoin) — `regen` in the result.
export async function prepareJoin(dim, { doorId = null, side = 'player', placement = 'nearby', label = '', nearTile = null, preferredTile = null, tmpDir = os.tmpdir(), regen = false, regenMax = undefined } = {}) {
  const { planJoin, dimIdOf } = await import('./join-plan.mjs');
  const plan = planJoin(dim, { doorId, side, placement, label, nearTile, preferredTile, regen, ...(regenMax != null ? { regenMax } : {}) });
  const blocksFile = path.join(tmpDir, `map-blocks.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.json`);
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(blocksFile, JSON.stringify(plan.knownMap.blocks()));
  // Per-Door map share inputs for the HUD telemetry (nodes known only via their Door).
  const doorMapsFile = blocksFile.replace(/map-blocks\./, 'door-maps.');
  await fs.writeFile(doorMapsFile, JSON.stringify(plan.doorMaps || []));
  const env = {
    DOOR_MAPS_FILE: doorMapsFile,
    DIM_NAME: dim.dimension_name,
    DIM_ID: dimIdOf(dim),
    PEER_LABEL: plan.peerLabel,
    ENTITY_NAME: plan.peerLabel,
    ALLIANCE: side,
    START_TILE: JSON.stringify(plan.startTile),
    MAP_SEED: String(plan.knownMap.seed),
    MAP_BLOCKS_FILE: blocksFile,
    BOOTSTRAP: plan.network.bootstrap.join(','),
    PEER_GUN_URLS: plan.network.gunRelays.join(','),
    JOIN_SYNC_WAIT_MS: plan.liveDoors.length ? '8000' : '500',
  };
  const a = plan.anchorDoor;
  const summary = `${dim.dimension_name}: ${placement} ${a?.peer_id || '(no anchor)'} at ${a?.tile?.q},${a?.tile?.r}${nearTile ? ` near (${nearTile.q},${nearTile.r})` : ''} → ${side} ${plan.peerLabel} at ${plan.startTile.q},${plan.startTile.r} (${dim.doors.length} Doors, ${plan.liveDoors.length} live${plan.liveDoors.length ? '' : ' — quiet, starting it from its Doors'}, ${plan.knownMap.size()} hexes)`
    + (plan.regen?.length ? `; ${plan.regen.length}/${plan.regenKnown} known monsters come back` : '');
  return { env, relays: plan.network.relays, summary, startTile: plan.startTile, peerLabel: plan.peerLabel, quiet: !plan.liveDoors.length, regen: plan.regen || [] };
}
// Puts a prepareJoin() result into this process's env before peer.mjs loads. nostr-bus.mjs froze
// NOSTR_RELAYS into DEFAULT_RELAYS when join-plan.mjs loaded it; peer.mjs uses that same array, so extend it.
export async function applyJoinEnv(join, extraEnv = {}) {
  Object.assign(process.env, join.env, extraEnv);
  const { DEFAULT_RELAYS } = await import('./nostr-bus.mjs');
  for (const r of join.relays || []) if (!DEFAULT_RELAYS.includes(r)) DEFAULT_RELAYS.push(r);
}
const fetchDimensionDefault = async (dimensionName) => {
  const { fetchDimensionFromHttpd } = await import('./join-plan.mjs');
  return fetchDimensionFromHttpd({ seedHost: SEED_HOST(), rid: DIMS_RID(), dimensionName });
};

// ---------------------------------------------------------------------------------------------
// GET /api/dimensions on the phone: join-plan.mjs listDimensionsFromHttpd + describeDimension when they
// exist; until then the same over fetchDimensionFromHttpd (branch names from the seed's remotes) and a
// local describe (same shape as ui-server.mjs's).
function describeLocal(jp, d, now = Date.now()) {
  const ageSec = iso => Math.max(0, Math.round((now - Date.parse(iso || 0)) / 1000));
  const doors = (d.doors || []).map(p => ({
    peer_id: p.peer_id, name: p.name, alliance: p.alliance, character_id: p.character_id, creature_id: p.creature_id,
    tile: p.tile, life: p.life, life_max: p.life_max, clock: p.clock, pushed_at: p.pushed_at, age_sec: ageSec(p.pushed_at),
    live: now - Date.parse(p.pushed_at || 0) < jp.DOOR_LIVE_MS, nid: p.nid, commit: p.commit,
  }));
  const newest = doors[0]?.pushed_at || null;
  return {
    dimension_name: d.dimension_name, dimension_id: jp.dimIdOf(d), namespaces: d.namespaces || [],
    doors, members: jp.unionMembers(d.doors || []), live_doors: doors.filter(p => p.live).length,
    legacy: false, newest_push: newest, age_sec: newest ? ageSec(newest) : null,
    turn: Math.max(0, ...doors.filter(p => p.live).map(p => p.clock?.turn ?? 0)),
  };
}
// `mines` = Map<dim id, Set "q,r"> of my saves (dims-local.mjs mineMapsOf): shares + units are computed here,
// once per seed fetch, so the cached items the menu serves carry no block lists.
async function listDimensionsDefault({ limit = 30, mines = null, include = [] } = {}) {
  const jp = await import('./join-plan.mjs');
  const seedHost = SEED_HOST(), rid = DIMS_RID();
  let raw;
  if (typeof jp.listDimensionsFromHttpd === 'function') raw = await jp.listDimensionsFromHttpd({ seedHost, rid, limit, include });
  else {
    const origin = /^https?:\/\//.test(seedHost) ? seedHost : `https://${seedHost}`;
    const r = await fetch(`${origin}/api/v1/repos/${rid.startsWith('rad:') ? rid : `rad:${rid}`}/remotes`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`seed answered HTTP ${r.status}`);
    const names = new Set();
    for (const remote of await r.json()) for (const h of Object.keys(remote?.heads || {})) if (h.startsWith('ActiveDimensions/')) names.add(h.slice('ActiveDimensions/'.length));
    raw = [];
    for (const name of [...names].slice(0, limit)) {
      try { const d = await jp.fetchDimensionFromHttpd({ seedHost, rid, dimensionName: name }); if (d) raw.push(d); } catch { /* skip that one */ }
    }
  }
  const now = Date.now();
  return (raw || []).map(d => (typeof jp.describeDimension === 'function' ? jp.describeDimension(d, now, { mine: mines?.get(jp.dimIdOf(d)) || null, sketch: false }) : describeLocal(jp, d, now)));
}

function randomEntryId(dataDir, file, fallback) {
  try {
    const doc = JSON.parse(fsSync.readFileSync(path.join(dataDir, file), 'utf8'));
    const ids = (doc.entries || []).filter(e => e?.id && (e.versions || []).some(v => !['rejected', 'superseded'].includes(v.status))).map(e => e.id);
    if (ids.length) return ids[Math.floor(Math.random() * ids.length)];
  } catch { /* fallback */ }
  return fallback;
}
// The hero a TMJ save was written by (props.peer_id, else the first human hero) — ui-server restoreDimension's rule.
function savedHeroOf(map) {
  const props = Object.fromEntries((map.properties || []).map(p => [p.name, p.value]));
  const ents = ((map.layers || []).find(l => l.name === 'entities')?.objects || []).map(o => ({ p: Object.fromEntries((o.properties || []).map(x => [x.name, x.value])), name: o.name }));
  const isHero = e => ['player', 'player_c', 'player_d'].includes(String(e.p.alliance || '')) && String(e.p.source_id || '').startsWith('char_');
  const myId = String(props.peer_id || (props.peer_label ? `peer:${props.peer_label}` : ''));
  // The author on any side: only human hands write saves (a human npc_b hero too, user ruling 2026-11-15).
  const e = (myId && ents.find(x => x.p.peer_id === myId && String(x.p.source_id || '').startsWith('char_'))) || ents.find(isHero);
  return { props, hero: e ? { characterId: String(e.p.source_id), name: String(e.name || e.p.name || e.p.source_id), alliance: String(e.p.alliance) } : null };
}
async function listSaves(dimensionsDir) {
  const { listSavedDimensions, DIMENSIONS_DIR } = await import('./tools/autosave.mjs');
  const baseDir = dimensionsDir || DIMENSIONS_DIR;
  return { baseDir, items: await listSavedDimensions(baseDir) };
}

// Same table as peer.mjs's mobile static handler.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico':  'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.wav':  'audio/wav', '.ogg':  'audio/ogg', '.mp3': 'audio/mpeg',
};

// Lazy fill of user://assets from the OCI asset pack, as peer.mjs fetchPackAsset does (the menu
// shows unit portraits / plays unit sounds before the peer exists).
const PACK_BASE = process.env.CHAOSD6_PACK_BASE || 'https://92-5-138-121.sslip.io/pack';
const packInFlight = new Map();
const packMisses = new Set();
function fetchPackAsset(root, rel) {
  if (packMisses.has(rel) || rel.includes('..')) return Promise.resolve(false);
  if (packInFlight.has(rel)) return packInFlight.get(rel);
  const p = (async () => {
    const abs = path.resolve(root, '.' + rel);
    if (!abs.startsWith(root + path.sep)) return false;
    try {
      const url = `${PACK_BASE}/assets${rel.split('/').map(encodeURIComponent).join('/')}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) { packMisses.add(rel); return false; }
      const buf = Buffer.from(await r.arrayBuffer());
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(`${abs}.part`, buf);
      await fs.rename(`${abs}.part`, abs);
      return true;
    } catch { return false; }
    finally { packInFlight.delete(rel); }
  })();
  packInFlight.set(rel, p);
  return p;
}

async function readBody(req) {
  let s = '';
  for await (const ch of req) { s += ch; if (s.length > 1e6) break; }
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

// A launch body → a plan, or throws { status, message }. `deps` (tests inject them): fetchDimension(name),
// dataDir, tmpDir, dimensionsDir.
export async function planOf(body, file, deps = {}) {
  const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
  const mode = String(body?.mode || '');
  // Test games are LOCAL and PRIVATE (user 2026-11-16): a fresh unguessable dimension id, no Door, no Nostr bus,
  // loopback, never unattended (join-plan.mjs PRIVATE_TEST_ENV; mobile-entry applies `env`) — and so no
  // one-dimension refusal (supersedes the 2026-11-15 ruling for tests).
  const privateOf = async () => {
    const jp = await import('./join-plan.mjs');
    const dimName = String(body?.dimensionName || '').trim().slice(0, 40) || 'Ashfall-Micro';
    return { private: true, dimName, dimId: jp.privateDimId(dimName), env: { ...jp.PRIVATE_TEST_ENV, TEST_MODE: mode } };
  };
  if (mode === 'test-random') return { mode, ...(await privateOf()) };
  const p = loadProfile(file);
  // One dimension at a time (user ruling 2026-11-15) for Create Dimension / Restore / Test launches: a profile
  // character (or team member) alive in ANOTHER dimension the menu knows (the list cache) → 409 naming it. `except`
  // = the dimension a Restore goes back to (alive there is the allowed way back). Dead is allowed.
  const refuseElsewhere = async (chars, except = null) => {
    chars = (chars || []).filter(Boolean);
    if (!chars.length) return;
    const jp = await import('./join-plan.mjs');
    const dims = ((deps.knownDims && deps.knownDims()) || []).filter(d => d?.dimension_name !== except);
    const hits = jp.aliveInDimensions(dims, chars);
    if (hits.length) fail(409, jp.aliveWhereText(hits));
  };
  if (mode === 'host') {
    const dimName = String(body.dimensionName || '').trim().slice(0, 40);
    if (!slug(dimName)) fail(400, 'the new dimension needs a name with letters or digits');
    // Create Dimension plays the top profile character (random without one), like the desktop panel.
    const character = !body.characterId || body.characterId === 'profile:top' ? topCharacter(p) : characterOf(p, String(body.characterId));
    await refuseElsewhere([character]);
    return { mode, dimName, dimId: dimIdFor(dimName), character };
  }
  if (mode === 'restore') {
    const { items } = await listSaves(deps.dimensionsDir);
    const it = items.find(x => x.path === String(body.tmjPath || ''));
    if (!it) fail(400, `no saved dimension ${body.tmjPath || '(none given)'} on this device`);
    let saved = { props: {}, hero: null };
    try { saved = savedHeroOf(JSON.parse(await fs.readFile(it.path, 'utf8'))); } catch (e) { fail(400, `the save is unreadable (${e.message})`); }
    // The saved hero again; as the profile character when one matches it, else (no hero in the save) the top one.
    const match = saved.hero && p.characters.find(c => c.base_character === saved.hero.characterId && c.name === saved.hero.name);
    const character = match || (saved.hero ? null : topCharacter(p));
    const dimName = String(saved.props.dim_name || it.dim_name || 'Restored-Dimension');
    // A private test game's save (private.json, listSaves → it.private) comes back private: no one-dimension check,
    // no Door lookup, the private env again.
    if (it.private) {
      const jp = await import('./join-plan.mjs');
      return { mode, tmjPath: it.path, dimName, dimId: String(saved.props.dim_id || it.dim_id), seed: String(saved.props.seed || it.seed || ''), character, savedHero: match ? null : saved.hero,
        alliance: saved.hero?.alliance || null, private: true, env: { ...jp.PRIVATE_TEST_ENV, TEST_MODE: String(it.test_mode || 'test') } };
    }
    await refuseElsewhere([character], dimName);
    // Hero shadows (rule_hero_shadow): a shadow of the saved hero stood in after the save → take it over (its tile,
    // its life, REPLACES_PEER_ID — applied to the env by runMenu); killed → the hero died there: refused.
    let extraEnv = null;
    const heroId = String(saved.props.peer_id || (saved.props.peer_label ? `peer:${saved.props.peer_label}` : ''));
    if (heroId) {
      const sdim = await (deps.fetchDimension || fetchDimensionDefault)(dimName).catch(() => null);
      const jp = await import('./join-plan.mjs');
      const sh = sdim?.doors?.length ? jp.heroShadowIn(sdim.doors, heroId, Date.parse(saved.props.saved_at || 0) || 0) : null;
      if (sh?.dead) fail(409, `${saved.hero?.name || heroId} died in ${dimName} as its shadow${sh.killer_name ? ` (killed by ${sh.killer_name})` : ''} — it cannot come back there`);
      if (sh) extraEnv = { REPLACES_PEER_ID: sh.peer_id, START_LIFE: String(sh.life), PEER_LABEL: heroId.replace(/^peer:/, ''), ...(sh.tile ? { START_TILE: JSON.stringify(sh.tile) } : {}) };
    }
    return { mode, tmjPath: it.path, dimName, dimId: String(saved.props.dim_id || it.dim_id || dimIdFor(dimName)), seed: String(saved.props.seed || it.seed || ''), character, savedHero: match ? null : saved.hero,
      alliance: saved.hero?.alliance || null, ...(extraEnv ? { extraEnv } : {}) };
  }
  if (mode === 'join' || mode === 'join-team' || mode === 'restore-here' || mode === 'dim-out') {
    const dimensionName = String(body.dimensionName || '').trim();
    if (!dimensionName) fail(400, 'dimensionName is required');
    const doorId = body.doorId ? String(body.doorId) : null;
    if (mode === 'join-team' && !doorId) fail(400, 'doorId is required');
    const team = teamCharacters(p);
    if (mode === 'join-team' && !team.length) fail(400, 'Create a character first');
    let dim = null;
    try { dim = await (deps.fetchDimension || fetchDimensionDefault)(dimensionName); }
    catch (e) { fail(502, `could not read ${dimensionName} from the seed (${e.message})`); }
    if (!dim) fail(404, `${dimensionName} is not published on the seed`);
    if (!dim.doors?.length) fail(400, `${dimensionName} has no Doors to join through`);
    // A placement that can't be done (no such Door, no walkable hex) is the player's 400, not a crash.
    // nearTile (unit list: next to that unit) — integers or nothing.
    const nt = body.nearTile ?? null;
    if (nt != null && !(Number.isInteger(nt?.q) && Number.isInteger(nt?.r))) fail(400, 'nearTile must be {q, r} integers');
    const jp = await import('./join-plan.mjs');
    // No cloning (user ruling 2026-11-15): a profile character the Doors know alive in this dimension → 409.
    // One dimension at a time (ruling 2): alive in ANY dimension the menu knows (this one, freshly read, first; then
    // the list cache — the newest MENU_DIMS_LIMIT dimensions of the seed) → 409 naming that dimension.
    // Only LIVE presence counts elsewhere (user 2026-11-16: old Doors of quiet dimensions the phone left alive
    // blocked every join); in this dimension a record of any age still refuses (no second copy of me here).
    const refuseAlive = (chars) => {
      const hits = jp.aliveInDimensions([dim, ...((deps.knownDims && deps.knownDims()) || [])], chars.filter(Boolean), { anyAgeIn: dim.dimension_name });
      if (hits.length) fail(409, jp.aliveWhereText(hits));
    };
    // Quiet dimension: the Door-known monsters come back (≤ MOBILE_REGEN_MAX nearest, in-process workers — the phone).
    const regenMax = deps.regenMax ?? Number(process.env.MOBILE_REGEN_MAX || 4);
    const prep = async (side, placement, label = '', preferredTile = null) => {
      const join = await prepareJoin(dim, { doorId, side, placement, label, nearTile: placement === 'nearby' && nt ? { q: nt.q, r: nt.r } : null, preferredTile, tmpDir: deps.tmpDir || os.tmpdir(), regen: true, regenMax })
        .catch(e => fail(400, e.message));
      if (join.regen.length) {
        // No live Door (DOOR_LIVE_MS 25 min) is not enough: anybody on the bus → it runs, nothing is regenerated.
        const heard = await (deps.probeLive || jp.probeDimensionLive)({ dimId: jp.dimIdOf(dim), relays: join.relays }).catch(() => ({ peers: [] }));
        if (heard.peers?.length) { join.summary += ` — but ${heard.peers.length} peer(s) answer on the bus: it is live, no monster regenerated`; join.regen = []; }
      }
      return join;
    };
    if (mode === 'restore-here') {
      // "↻ Restore <name> here" (user 2026-11-16) — ui-server.mjs restoreHere's rule: the profile character's newest
      // alive record there (join-plan.mjs restoreHereTarget; its live shadow is taken over), under its own peer id, at
      // its last tile with its last life, from the Doors' map (quiet → Door-known monsters come back), first Door
      // pushed at once (the announcement). LIVE presence in another dimension refuses; stale records don't.
      // Planned as a 'join' so mobile-entry.mjs applies it like any Door join (env + profileEnv(character)).
      const c = characterOf(p, String(body.profileCharId || ''));
      if (!c) fail(400, `no profile character ${body.profileCharId || '(none given)'}`);
      return restoreHerePlan(c);
    }
    if (mode === 'dim-out') {
      // "⇱ Dimension Out" from the start screen (rule_dimension_out): the same restore-here / takeover, and the peer
      // starts its 10-round Dimension Out at once (DIM_OUT_ON_START) — the game opens so the countdown shows.
      const c = characterOf(p, String(body.profileCharId || ''));
      if (!c) fail(400, `no profile character ${body.profileCharId || '(none given)'}`);
      const plan = await restoreHerePlan(c);
      plan.join.env.DIM_OUT_ON_START = '1';
      plan.join.summary += ' — Dimension Out at once';
      return { ...plan, dimOut: true };
    }
    async function restoreHerePlan(c) {
      const t = jp.restoreHereTarget(dim, c);
      if (!t) fail(409, `${c.name} is not alive in ${dim.dimension_name} (dead there, or never there)`);
      await refuseElsewhere([c], dim.dimension_name);
      const side = ['player', 'player_c', 'player_d', 'npc_b'].includes(t.alliance) ? t.alliance : 'player';
      const join = await prep(side, 'nearby', t.label, t.tile);
      const taken = t.tile && jp.unionMembers(dim.doors).some(m => m.peer_id !== t.peer_id && m.peer_id !== t.replaces && (m.life ?? 1) > 0 && m.tile?.q === t.tile.q && m.tile?.r === t.tile.r);
      if (t.tile && !taken) { join.env.START_TILE = JSON.stringify(t.tile); join.startTile = t.tile; }
      Object.assign(join.env, { HUMAN: '1', RADICLE_PUSH_FIRST_SEC: process.env.RESTORE_PUSH_FIRST_SEC || '1', ALLY_OF: '',   // back in my hands: no group
        ...(t.life > 0 ? { START_LIFE: String(t.life) } : {}), ...(t.replaces ? { REPLACES_PEER_ID: t.replaces } : {}) });
      join.summary += ` — restoring ${c.name} as ${t.label} hp ${t.life ?? '?'}${t.replaces ? `, taking over its shadow ${t.replaces}` : ''}`;
      return { mode: 'join', restoreHere: true, dimName: dim.dimension_name, side, character: c, join, monsters: join.regen, target: t };
    }
    if (mode === 'join-team') {
      // The top character opens a gate 30–50 hexes from the Door; count−1 more arrive beside it (tier ring).
      // A NEW team (user rulings 2026-11-15); the allies are its bots.
      const count = Math.max(1, Math.min(team.length, Math.floor(Number(body.count) || 1)));
      const tier = body.tier === 'reachable' ? 'reachable' : 'strong';
      refuseAlive(team.slice(0, count));
      // A new team on the first FREE side (A, C, D; ruling 2026-11-15) — none free → refused.
      const side = jp.newTeamSide(jp.dimensionUnits(dim.doors).sides);
      if (!side) fail(409, `${dim.dimension_name}: ${jp.NO_FREE_SIDE}`);
      const join = await prep(side, 'far', body.label || '');
      Object.assign(join.env, { TEAM_GATE: '1', TEAM_GATE_DOOR: doorId, HUMAN: '1' });
      return { mode, dimName: dim.dimension_name, side, allySide: jp.teamBotSide(side), hero: team[0], character: team[0], allies: team.slice(1, count), tier, join, monsters: join.regen };
    }
    const side = String(body.side || 'player');
    if (!JOIN_SIDES.includes(side)) fail(400, `side must be one of ${JOIN_SIDES.join(', ')}`);
    const placement = body.placement === 'random' ? 'random' : 'nearby';
    let character = null, characterId = '', creatureId = '';
    // 'random' / 'known' = the Monster join: the known type there (join-plan.mjs knownMonsterType), a bot; random
    // only when the dimension knows no monster.
    if (body.creatureId) creatureId = ['random', 'known'].includes(body.creatureId)
      ? (jp.knownMonsterType(dim, { doorId, nearTile: nt }) || randomEntryId(deps.dataDir || '', 'creatures.json', 'mon_ruinous_minotaur')) : String(body.creatureId);
    else if (!body.characterId || body.characterId === 'profile:top') character = topCharacter(p);   // null → random below
    else characterId = String(body.characterId);
    if (!creatureId && !character && !characterId) characterId = randomEntryId(deps.dataDir || '', 'characters.json', 'char_oran_rief');
    // The owner comes back (rule_unattended_character): my profile character unattended there → this join is its
    // restore-here takeover; its own record (live, or left alive while quiet) still refuses (rejoin/restore there).
    const back = character ? jp.restoreHereTarget(dim, character) : null;
    if (back?.replaces) return restoreHerePlan(character);
    if (character) refuseAlive([character]);
    const join = await prep(side, placement, body.label || '');
    // I play it (user ruling 2026-11-15): a character joining next to a monster is a human npc_b, not a bot.
    if (!creatureId) join.env.HUMAN = '1';
    // The ally-join link (rule_unattended_character): joined next to `nearPeer` as its ally → published ally_of.
    const nearPeer = typeof body.nearPeer === 'string' && /^peer:[A-Za-z0-9_.:-]{1,80}$/.test(body.nearPeer) ? body.nearPeer : '';
    join.env.ALLY_OF = nearPeer && !creatureId ? nearPeer : '';
    return { mode, dimName: dim.dimension_name, side, character, characterId, creatureId, join, monsters: join.regen };
  }
  if (mode === 'test-character') {
    const c = characterOf(p, String(body.profileCharId || ''));
    if (!c) fail(400, `no profile character ${body.profileCharId || '(none given)'}`);
    return { mode, character: c, ...(await privateOf()) };
  }
  if (mode === 'test-team') {
    const team = teamCharacters(p);
    if (!team.length) fail(400, 'the profile has no characters yet');
    // Asking for more characters than the team has plays the whole team.
    const count = Math.max(1, Math.min(team.length, Math.floor(Number(body.count) || 1)));
    const tier = body.tier === 'strong' ? 'strong' : 'reachable';
    return { mode, hero: team[0], allies: team.slice(1, count), tier, ...(await privateOf()) };
  }
  fail(400, `unknown launch mode "${mode}"`);
}
const planText = (plan) => [
  plan.mode,
  plan.dimName ? ` ${plan.dimName}` : '',
  plan.character ? ` as ${plan.character.name}` : plan.savedHero ? ` as ${plan.savedHero.name}` : plan.creatureId ? ` as ${plan.creatureId}` : plan.characterId ? ` as ${plan.characterId}` : '',
  plan.allies ? ` + ${plan.allies.length} allies (${plan.tier})` : '',
  plan.side ? ` (${plan.side})` : '',
  plan.monsters?.length ? ` + ${plan.monsters.length} regenerated monsters` : '',
  plan.private ? ` [private test ${plan.dimId}]` : '',
].join('');

// Saves + the Radicle list (the menu's cache) → both lists with the launcher stats, tombstoned ones dropped.
async function dimsView({ radicle, dimensionsDir, sessionsDir }) {
  const dl = await import('./dims-local.mjs');
  const { items } = await listSaves(dimensionsDir);
  const opts = { ...(dimensionsDir ? { dimensionsDir } : {}), ...(sessionsDir ? { sessionsDir } : {}) };
  return { ...(await dl.enrichDimensions({ ...opts, saves: items, hidden: await dl.loadHidden(), radicle })), raw: items, dl, opts };
}

// `fetchDimension`, `listDimensions`, `dimensionsDir`, `sessionsDir`, `tmpDir`, `probeLive`: test hooks (defaults: the seed's
// radicle-httpd, tools/autosave.mjs DIMENSIONS_DIR, dims-local.mjs SESSIONS_DIR, os.tmpdir(), join-plan.mjs probeDimensionLive).
export async function runMenu({ port, dataDir, assetsDir = '', gameDir, userDataDir = process.env.CHAOSD6_USER_DATA_DIR || '',
  fetchDimension = null, listDimensions = null, dimensionsDir = null, sessionsDir = null, tmpDir = null, probeLive = null }) {
  const file = profilePath();
  const deps = { fetchDimension, dataDir, dimensionsDir, tmpDir: tmpDir || os.tmpdir(), ...(probeLive ? { probeLive } : {}),
    knownDims: () => dimsCache?.items || [] };   // one dimension at a time: the listed dimensions' alive_chars
  let dimsCache = null;   // { at, items } — the seed is slow; ?sync=1 (the ↻ button) skips it
  // ~100 KB per Door blob at ~1 s each over radicle-httpd: only the newest few, one read at a time
  // (overlapping requests share it), started as soon as the menu opens.
  let dimsLoading = null;
  const loadDims = () => (dimsLoading ??= Promise.resolve()
    .then(async () => {
      const { mineMapsOf } = await import('./dims-local.mjs');
      // + every dimension I have a save of, however old: where my character may still be alive ("You are here").
      const saved = await listSaves(dimensionsDir).then(({ items }) => items).catch(() => []);
      const mines = await mineMapsOf(saved).catch(() => new Map());
      return (listDimensions || listDimensionsDefault)({ limit: Number(process.env.MENU_DIMS_LIMIT || 6), mines, include: saved.map(x => x.dim_name).filter(Boolean) });
    })
    .then(items => { dimsCache = { at: Date.now(), items }; return items; })
    // Hero shadows (rule_hero_shadow): a fallen shadow of my profile character → its death card leaves my profile.
    .then(async items => {
      try { for (const s of await (await import('./shadow-settle.mjs')).settleFromDimensions(file, items)) console.log(`[menu] shadow: ${s.text}`); }
      catch (e) { console.error(`[menu] shadow settle: ${e.message}`); }
      return items;
    })
    .finally(() => { dimsLoading = null; }));
  loadDims().catch(e => console.error(`[menu] dimensions prefetch: ${e.message}`));
  let pending = false;    // a launch is being planned (join: the seed is being read)
  let done = null;   // the plan once a launch was accepted (later requests are refused)
  const { promise, resolve, reject } = Promise.withResolvers();
  const server = http.createServer(async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    const serve = async (root, rel) => {
      if (!root || rel.includes('..')) return false;
      const abs = path.resolve(root, '.' + rel);
      if (!abs.startsWith(root + path.sep) && abs !== root) return false;
      const mime = MIME[path.extname(abs).toLowerCase()];
      if (!mime) return false;
      try {
        const data = await fs.readFile(abs);
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
        res.end(data);
        return true;
      } catch { return false; }
    };
    let u;
    try { u = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
    try {
      if (u.startsWith('/api/')) {
        if (await handleProfileApi(req, res, u, { file, dataDir })) return;
        if (u === '/api/dimensions' && req.method === 'GET') {
          const fresh = new URLSearchParams((req.url || '').split('?')[1] || '').get('sync') === '1';
          // + on_radicle / saved_locally / local_bytes / last_active / old / hexes / turn_max; tombstoned ones dropped.
          const view = async (list) => (await dimsView({ radicle: list || [], dimensionsDir, sessionsDir }).catch(() => ({ radicle: list || [] }))).radicle;
          if (!fresh && dimsCache && Date.now() - dimsCache.at < 30_000) return json(200, { ok: true, enabled: true, cached: true, items: await view(dimsCache.items) });
          try {
            const items = await loadDims();
            return json(200, { ok: true, enabled: true, items: await view(items) });
          } catch (e) {
            console.error(`[menu] dimensions: ${e.message}`);
            return json(200, { ok: false, enabled: false, reason: e.message, items: await view(dimsCache?.items) });
          }
        }
        if (u === '/api/dimensions/local' && req.method === 'GET') {
          try {
            const v = await dimsView({ radicle: dimsCache?.items || null, dimensionsDir, sessionsDir });
            return json(200, { ok: true, baseDir: dimensionsDir || (await import('./tools/autosave.mjs')).DIMENSIONS_DIR, old_after_ms: v.dl.OLD_AFTER_MS, items: v.saves });
          }
          catch (e) { return json(200, { ok: false, error: e.message, items: [] }); }
        }
        if (u === '/api/dimensions/delete' && req.method === 'POST') {
          // Nothing runs while the menu is up (peer.mjs starts after it), so only the 72 h rule applies. The
          // Radicle list is the menu's cache; the seed is never asked to delete anything.
          try {
            const v = await dimsView({ radicle: dimsCache?.items || [], dimensionsDir, sessionsDir });
            const plan = await v.dl.planDelete(await readBody(req), { ...v.opts, radicle: dimsCache?.items || [], saves: v.raw });
            const out = await v.dl.removeLocalDirs(plan, v.opts);
            if (plan.onRadicle) await v.dl.hideDimension(plan.name);
            console.log(`[menu] deleted local copy of ${plan.name || plan.dimId}: ${out.removed.length} dir(s)${plan.onRadicle ? ', hidden (still on Radicle)' : ''}`);
            return json(200, { ok: true, dimension_name: plan.name, dim_id: plan.dimId, removed: out.removed, freed_bytes: out.freed_bytes, hidden: plan.onRadicle, note: v.dl.LOCAL_ONLY_NOTE });
          } catch (e) { return json(e.status || 500, { ok: false, error: e.message }); }
        }
        if (u === '/api/launch' && req.method === 'POST') {
          if (done || pending) return json(409, { error: 'a game is already starting', peerPort: port });
          pending = true;
          let plan;
          try { plan = await planOf(await readBody(req), file, deps); } finally { pending = false; }
          done = plan;
          // Plain env additions of a plan (a Restore taking over its hero's shadow): peer.mjs loads after the menu.
          if (plan.extraEnv) Object.assign(process.env, plan.extraEnv);
          // A private test game (user 2026-11-16): its unguessable dimension + the private env (no Door, no bus,
          // loopback); the peer's autosave writes private.json beside its saves ("test" in Load old Dimension).
          if (plan.private) Object.assign(process.env, plan.env, { DIM_NAME: plan.dimName, DIM_ID: plan.dimId });
          console.log(`[menu] launch ${planText(plan)}${plan.join ? ` — ${plan.join.summary}` : ''}`);
          res.setHeader('connection', 'close');
          json(200, { peerPort: port, mode: plan.mode });
          // Free the port for peer.mjs: stop listening, drop idle keep-alive sockets (the
          // WebView keeps some open), then hand the plan over.
          res.on('finish', () => {
            server.close(() => resolve(plan));
            server.closeIdleConnections?.();
            setTimeout(() => server.closeAllConnections?.(), 250);
          });
          return;
        }
        return json(404, { error: `no ${req.method} ${u}` });
      }
      if (u.startsWith('/assets/') && assetsDir) {
        const rel = u.slice('/assets'.length);
        if (await serve(assetsDir, rel)) return;
        if (await fetchPackAsset(assetsDir, rel) && await serve(assetsDir, rel)) return;
        if (/\.bmp$/i.test(rel)) {   // data/*.json names portraits as .bmp; the pack ships .png
          const png = rel.replace(/\.bmp$/i, '.png');
          if (await serve(assetsDir, png)) return;
          if (await fetchPackAsset(assetsDir, png) && await serve(assetsDir, png)) return;
        }
      } else if (u.startsWith('/user-data/') && userDataDir) {
        if (await serve(userDataDir, u.slice('/user-data'.length))) return;
      } else if (u.startsWith('/data/')) {
        if (await serve(dataDir, u.slice('/data'.length))) return;
        if (await serve(gameDir, u)) return;
      } else {
        const rel = (u === '/' || u === '') ? '/index.html' : u;
        if (await serve(gameDir, rel)) return;
      }
      res.writeHead(404); res.end();
    } catch (e) {
      if (!res.headersSent) json(e.status || 500, { error: e.message });
      else res.end();
    }
  });
  server.on('error', (e) => { if (!done) reject(e); });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[menu] profile menu — peer listening on 127.0.0.1:${port} (profile ${file})`);
  });
  return promise;
}
