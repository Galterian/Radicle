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
//   { mode: 'join', dimName, side, character|null, characterId, creatureId, join }       Ally / Enemy / Monster
//   { mode: 'join-team', dimName, hero, character, allies, tier, join }                  Join my top character / team
// `join` = prepareJoin() output: { env (peer.mjs env vars, incl. the map-blocks file), relays, summary } —
// mobile-entry.mjs applies it with applyJoinEnv(), the same path its chaosd6:// deep link takes.
//
// Besides the profile API the menu answers GET /api/dimensions (published dimensions, read from
// radicle-httpd on the seed) and GET /api/dimensions/local (TMJ saves on the phone).
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
export const JOIN_SIDES = ['player', 'player_c', 'npc_a', 'npc_b', 'npc_c'];

// ---------------------------------------------------------------------------------------------
// Joining through a Door — one code path for the chaosd6:// deep link and the menu's join buttons.
// planJoin (join-plan.mjs) places the joiner from the Doors; the known map goes to a file (too big for env).
export async function prepareJoin(dim, { doorId = null, side = 'player', placement = 'nearby', label = '', tmpDir = os.tmpdir() } = {}) {
  const { planJoin, dimIdOf } = await import('./join-plan.mjs');
  const plan = planJoin(dim, { doorId, side, placement, label });
  const blocksFile = path.join(tmpDir, `map-blocks.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.json`);
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(blocksFile, JSON.stringify(plan.knownMap.blocks()));
  const env = {
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
  const summary = `${dim.dimension_name}: ${placement} ${a?.peer_id || '(no anchor)'} at ${a?.tile?.q},${a?.tile?.r} → ${side} ${plan.peerLabel} at ${plan.startTile.q},${plan.startTile.r} (${dim.doors.length} Doors, ${plan.liveDoors.length} live, ${plan.knownMap.size()} hexes)`;
  return { env, relays: plan.network.relays, summary, startTile: plan.startTile, peerLabel: plan.peerLabel };
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
async function listDimensionsDefault({ limit = 30 } = {}) {
  const jp = await import('./join-plan.mjs');
  const seedHost = SEED_HOST(), rid = DIMS_RID();
  let raw;
  if (typeof jp.listDimensionsFromHttpd === 'function') raw = await jp.listDimensionsFromHttpd({ seedHost, rid, limit });
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
  return (raw || []).map(d => (typeof jp.describeDimension === 'function' ? jp.describeDimension(d, now) : describeLocal(jp, d, now)));
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
  const isHero = e => ['player', 'player_c'].includes(String(e.p.alliance || '')) && String(e.p.source_id || '').startsWith('char_');
  const myId = String(props.peer_id || (props.peer_label ? `peer:${props.peer_label}` : ''));
  const e = (myId && ents.find(x => x.p.peer_id === myId && isHero(x))) || ents.find(isHero);
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
  if (mode === 'test-random') return { mode };
  const p = loadProfile(file);
  if (mode === 'host') {
    const dimName = String(body.dimensionName || '').trim().slice(0, 40);
    if (!slug(dimName)) fail(400, 'the new dimension needs a name with letters or digits');
    // Create Dimension plays the top profile character (random without one), like the desktop panel.
    const character = !body.characterId || body.characterId === 'profile:top' ? topCharacter(p) : characterOf(p, String(body.characterId));
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
    return { mode, tmjPath: it.path, dimName, dimId: String(saved.props.dim_id || it.dim_id || dimIdFor(dimName)), seed: String(saved.props.seed || it.seed || ''), character, savedHero: match ? null : saved.hero };
  }
  if (mode === 'join' || mode === 'join-team') {
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
    const prep = (side, placement, label = '') => prepareJoin(dim, { doorId, side, placement, label, tmpDir: deps.tmpDir || os.tmpdir() });
    if (mode === 'join-team') {
      // The top character opens a gate 30–50 hexes from the Door; count−1 more arrive beside it (tier ring).
      const count = Math.max(1, Math.min(team.length, Math.floor(Number(body.count) || 1)));
      const tier = body.tier === 'reachable' ? 'reachable' : 'strong';
      const join = await prep('player', 'far', body.label || '').catch(e => fail(400, e.message));
      Object.assign(join.env, { TEAM_GATE: '1', TEAM_GATE_DOOR: doorId });
      return { mode, dimName: dim.dimension_name, hero: team[0], character: team[0], allies: team.slice(1, count), tier, join };
    }
    const side = String(body.side || 'player');
    if (!JOIN_SIDES.includes(side)) fail(400, `side must be one of ${JOIN_SIDES.join(', ')}`);
    const placement = body.placement === 'random' ? 'random' : 'nearby';
    let character = null, characterId = '', creatureId = '';
    if (body.creatureId) creatureId = body.creatureId === 'random' ? randomEntryId(deps.dataDir || '', 'creatures.json', 'mon_ruinous_minotaur') : String(body.creatureId);
    else if (!body.characterId || body.characterId === 'profile:top') character = topCharacter(p);   // null → random below
    else characterId = String(body.characterId);
    if (!creatureId && !character && !characterId) characterId = randomEntryId(deps.dataDir || '', 'characters.json', 'char_oran_rief');
    const join = await prep(side, placement, body.label || '').catch(e => fail(400, e.message));
    return { mode, dimName: dim.dimension_name, side, character, characterId, creatureId, join };
  }
  if (mode === 'test-character') {
    const c = characterOf(p, String(body.profileCharId || ''));
    if (!c) fail(400, `no profile character ${body.profileCharId || '(none given)'}`);
    return { mode, character: c };
  }
  if (mode === 'test-team') {
    const team = teamCharacters(p);
    if (!team.length) fail(400, 'the profile has no characters yet');
    // Asking for more characters than the team has plays the whole team.
    const count = Math.max(1, Math.min(team.length, Math.floor(Number(body.count) || 1)));
    const tier = body.tier === 'strong' ? 'strong' : 'reachable';
    return { mode, hero: team[0], allies: team.slice(1, count), tier };
  }
  fail(400, `unknown launch mode "${mode}"`);
}
const planText = (plan) => [
  plan.mode,
  plan.dimName ? ` ${plan.dimName}` : '',
  plan.character ? ` as ${plan.character.name}` : plan.savedHero ? ` as ${plan.savedHero.name}` : plan.creatureId ? ` as ${plan.creatureId}` : plan.characterId ? ` as ${plan.characterId}` : '',
  plan.allies ? ` + ${plan.allies.length} allies (${plan.tier})` : '',
  plan.side ? ` (${plan.side})` : '',
].join('');

// `fetchDimension`, `listDimensions`, `dimensionsDir`, `tmpDir`: test hooks (defaults: the seed's radicle-httpd,
// tools/autosave.mjs DIMENSIONS_DIR, os.tmpdir()).
export async function runMenu({ port, dataDir, assetsDir = '', gameDir, userDataDir = process.env.CHAOSD6_USER_DATA_DIR || '',
  fetchDimension = null, listDimensions = null, dimensionsDir = null, tmpDir = null }) {
  const file = profilePath();
  const deps = { fetchDimension, dataDir, dimensionsDir, tmpDir: tmpDir || os.tmpdir() };
  let dimsCache = null;   // { at, items } — the seed is slow; ?sync=1 (the ↻ button) skips it
  // ~100 KB per Door blob at ~1 s each over radicle-httpd: only the newest few, one read at a time
  // (overlapping requests share it), started as soon as the menu opens.
  let dimsLoading = null;
  const loadDims = () => (dimsLoading ??= Promise.resolve()
    .then(() => (listDimensions || listDimensionsDefault)({ limit: Number(process.env.MENU_DIMS_LIMIT || 6) }))
    .then(items => { dimsCache = { at: Date.now(), items }; return items; })
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
          if (!fresh && dimsCache && Date.now() - dimsCache.at < 30_000) return json(200, { ok: true, enabled: true, cached: true, items: dimsCache.items });
          try {
            const items = await loadDims();
            return json(200, { ok: true, enabled: true, items });
          } catch (e) {
            console.error(`[menu] dimensions: ${e.message}`);
            return json(200, { ok: false, enabled: false, reason: e.message, items: dimsCache?.items || [] });
          }
        }
        if (u === '/api/dimensions/local' && req.method === 'GET') {
          try { return json(200, { ok: true, ...(await listSaves(dimensionsDir)) }); }
          catch (e) { return json(200, { ok: false, error: e.message, items: [] }); }
        }
        if (u === '/api/launch' && req.method === 'POST') {
          if (done || pending) return json(409, { error: 'a game is already starting', peerPort: port });
          pending = true;
          let plan;
          try { plan = await planOf(await readBody(req), file, deps); } finally { pending = false; }
          done = plan;
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
