// Serves the browser UI (index.html + /js + /css + /data) on :7357.
// The browser connects via WebSocket to the player peer at ws://127.0.0.1:7401.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

const MIME = { '.html':'text/html;charset=utf-8', '.js':'application/javascript;charset=utf-8', '.css':'text/css;charset=utf-8', '.json':'application/json;charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  const serve = async (abs) => {
    try { const b = await fs.readFile(abs); res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(b); }
    catch { res.writeHead(404); res.end('not found'); }
  };
  if (p.startsWith('/data/')) return serve(path.join(DATA_DIR, p.slice('/data/'.length).replace(/\.\./g, '')));
  const rel = p === '/' ? '/index.html' : p;
  const abs = path.join(__dirname, rel.replace(/\.\./g, ''));
  if (!abs.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
  await serve(abs);
});
const PORT = Number(process.env.UI_PORT || 7357);
server.listen(PORT, '127.0.0.1', () => console.log(`[ui-server] http://127.0.0.1:${PORT}`));
