// ChaosD6 Dimensions — local dev server + session store.
// Serves the browser game and persists Radicle-shaped session artefacts
// to game/sessions/<DimensionName>/ following dimension_session.json shapes.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetFile } from './asset-root.mjs';   // catalogues from ../assets, media from the media root

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT     = __dirname;
const DATA_DIR = path.resolve(ROOT, '..', 'data');
const SESS_DIR = path.resolve(ROOT, 'sessions');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.bmp':  'image/bmp',
  '.wav':  'audio/wav'
};

const safeRel = (p) => p.replace(/\.\.(\/|\\|$)/g, '').replace(/^[\/\\]+/, '');

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function serveFile(res, abs, mime) {
  try {
    const buf = await fs.readFile(abs);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 not found: ' + abs);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (p.startsWith('/assets/')) {
    const rel = safeRel(p.slice('/assets/'.length));
    return serveFile(res, assetFile(rel) || path.join(ROOT, '..', 'assets', rel), MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream');
  }
  if (p.startsWith('/data/')) {
    const rel = safeRel(p.slice('/data/'.length));
    return serveFile(res, path.join(DATA_DIR, rel), MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream');
  }

  if (p === '/api/session/write' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const abs = path.join(SESS_DIR, safeRel(body.path));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body.content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: path.relative(ROOT, abs) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  if (p === '/api/session/append' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const abs = path.join(SESS_DIR, safeRel(body.path));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.appendFile(abs, body.line + '\n');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  const rel = p === '/' ? '/index.html' : p;
  const abs = path.join(ROOT, safeRel(rel));
  if (!abs.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  await serveFile(res, abs, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
});

const PORT = Number(process.env.PORT || 7357);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`ChaosD6 Dimensions dev server  → http://127.0.0.1:${PORT}`);
  console.log(`  data layer  : ${DATA_DIR}`);
  console.log(`  sessions dir: ${SESS_DIR}`);
});
