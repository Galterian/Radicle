// Serves the browser UI (index.html + /js + /css + /data) on :7357.
// The browser connects via WebSocket to the player peer at ws://127.0.0.1:7401.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RADICLE_BARE, radicleEnv } from './radicle-adapter.mjs';

const pexec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

const MIME = { '.html':'text/html;charset=utf-8', '.js':'application/javascript;charset=utf-8', '.css':'text/css;charset=utf-8', '.json':'application/json;charset=utf-8' };

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

async function renderCommit(sha) {
  const run = async (args) => (await pexec('git', ['--git-dir', RADICLE_BARE, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const [meta, body, stat, diff] = await Promise.all([
    run(['show', '-s', '--format=%H%n%an <%ae>%n%aI%n%d%n%s', sha]),
    run(['show', '-s', '--format=%b', sha]),
    run(['show', '--stat', '--format=', sha]),
    run(['show', '--format=', sha]),
  ]);
  const [full, author, date, refs, subject] = meta.split('\n');
  return `<!doctype html><meta charset="utf-8"><title>${esc(full.slice(0,10))} — ${esc(subject)}</title>
<style>
  body{font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#0f1115;color:#d8dee9;margin:0;padding:24px;max-width:1100px}
  h1{font-size:16px;margin:0 0 4px}
  .meta{color:#8b95a7;margin-bottom:16px}
  .meta b{color:#d8dee9;font-weight:600}
  pre{background:#161a22;border:1px solid #222a37;border-radius:6px;padding:12px;overflow:auto;white-space:pre}
  .add{color:#8ec07c}.rem{color:#fb4934}.hdr{color:#83a598}.file{color:#d3869b}
  a{color:#83a598}
</style>
<h1>${esc(subject)}${esc(refs)}</h1>
<div class="meta">
  <div><b>${esc(full)}</b></div>
  <div>${esc(author)} · ${esc(date)}</div>
  <div><a href="/">← back to game</a></div>
</div>
${body.trim() ? `<pre>${esc(body)}</pre>` : ''}
<pre>${esc(stat)}</pre>
<pre>${esc(diff).replace(/^(diff --git .*|index .*|--- .*|\+\+\+ .*)$/gm, '<span class="file">$1</span>').replace(/^@@.*$/gm, '<span class="hdr">$&</span>').replace(/^\+(?!\+\+).*$/gm, '<span class="add">$&</span>').replace(/^-(?!--).*$/gm, '<span class="rem">$&</span>')}</pre>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  const serve = async (abs) => {
    try { const b = await fs.readFile(abs); res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(b); }
    catch { res.writeHead(404); res.end('not found'); }
  };
  // Human-readable alias redirect: /r/<alias>/commits/<sha> or /r/<alias>/tree/<sha>/<path>
  // → 302 to the real explorer URL. The alias is purely cosmetic — the destination
  // still uses the raw RID because public seeds don't know about our local alias.
  const rMatch = p.match(/^\/r\/([^/]+)\/(commits|tree)\/([^/]+)(\/.*)?$/);
  if (rMatch) {
    if (!radicleEnv.enabled) { res.writeHead(503); return res.end('radicle remote push disabled'); }
    const [, alias, kind, sha, rest] = rMatch;
    if (radicleEnv.alias && alias !== radicleEnv.alias) {
      res.writeHead(404); return res.end(`unknown alias "${alias}" (configured: "${radicleEnv.alias}")`);
    }
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) { res.writeHead(400); return res.end('bad sha'); }
    const target = kind === 'commits'
      ? radicleEnv.rawCommitUrl(sha)
      : radicleEnv.rawTreeUrl(sha, rest ? rest.slice(1) : '');
    res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (p.startsWith('/commit/')) {
    const sha = p.slice('/commit/'.length);
    if (!SHA_RE.test(sha)) { res.writeHead(400); return res.end('bad sha'); }
    try {
      const html = await renderCommit(sha);
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(`commit ${sha} not found in ${RADICLE_BARE}\n${e.message}`);
    }
  }
  if (p.startsWith('/data/')) return serve(path.join(DATA_DIR, p.slice('/data/'.length).replace(/\.\./g, '')));
  const rel = p === '/' ? '/index.html' : p;
  const abs = path.join(__dirname, rel.replace(/\.\./g, ''));
  if (!abs.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
  await serve(abs);
});
const PORT = Number(process.env.UI_PORT || 7357);
server.listen(PORT, '127.0.0.1', () => console.log(`[ui-server] http://127.0.0.1:${PORT}`));
