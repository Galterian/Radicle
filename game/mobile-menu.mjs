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
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { handleProfileApi, profilePath, loadProfile, characterOf, teamCharacters } from './profile.mjs';

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

// A launch body → a plan, or throws { status, message }.
function planOf(body, file) {
  const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
  const mode = String(body?.mode || '');
  if (mode === 'test-random') return { mode };
  const p = loadProfile(file);
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
  if (mode === 'join' || mode === 'join-team') fail(400, `${mode} is started from a chaosd6:// link on the phone`);
  fail(400, `unknown launch mode "${mode}"`);
}

export async function runMenu({ port, dataDir, assetsDir = '', gameDir, userDataDir = process.env.CHAOSD6_USER_DATA_DIR || '' }) {
  const file = profilePath();
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
        if (u === '/api/launch' && req.method === 'POST') {
          if (done) return json(409, { error: 'a game is already starting', peerPort: port });
          const plan = planOf(await readBody(req), file);
          done = plan;
          console.log(`[menu] launch ${plan.mode}${plan.character ? ` as ${plan.character.name}` : ''}${plan.hero ? ` as ${plan.hero.name} + ${plan.allies.length} allies (${plan.tier})` : ''}`);
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
