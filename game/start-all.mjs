// Thin bootstrapper. Spawns discovery + ui-server so the browser can take over.
// The user picks "host a new Dimension" or "join an existing one" from the
// launcher page served by ui-server.mjs at http://127.0.0.1:7357 — ui-server
// then spawns the peer processes on demand.
//
// Flags: --list    print published dimensions and exit (for scripts)

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ensureBare, listPublishedDimensions, radicleEnv, RADICLE_BARE } from './radicle-adapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

await ensureBare();
console.log(`[launcher] radicle bare repo ready at ${RADICLE_BARE}`);

if (argv.includes('--list')) {
  if (!radicleEnv.enabled) { console.error(`[launcher] cannot fetch published dimensions: ${radicleEnv.reason}`); process.exit(1); }
  try {
    const items = await listPublishedDimensions();
    if (!items.length) console.log('(no ActiveDimensions/* branches published yet)');
    const ageMin = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso || 0)) / 60000));
    for (const d of items) for (const door of d.doors) console.log(`  ${d.dimension_name} / ${door.door_id}  (push ${ageMin(door.last_push?.at)} min ago)`);
  } catch (e) { console.error(`[launcher] ${e.message}`); process.exit(1); }
  process.exit(0);
}

// Several launchers can run on one box (to simulate different machines), so
// the UI and discovery ports are only preferences — take the next free one.
// UI_PORT / DISCOVERY_PORT env still pin them explicitly if you want.
async function freePort(start) {
  for (let p = start; p < start + 200; p++) {
    const ok = await new Promise(res => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, '0.0.0.0', () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error(`no free port near ${start}`);
}
const UI_PORT        = Number(process.env.UI_PORT)        || await freePort(7357);
const DISCOVERY_PORT = Number(process.env.DISCOVERY_PORT) || await freePort(7350);

const PEER_PUBLIC_IP = process.env.PEER_PUBLIC_IP || '';
const netEnv = {
  UI_PORT: String(UI_PORT),
  DISCOVERY_PORT: String(DISCOVERY_PORT),
  DISCOVERY_URL: `http://127.0.0.1:${DISCOVERY_PORT}`,
  PUBLIC_DISCOVERY_URL: `http://${PEER_PUBLIC_IP || '127.0.0.1'}:${DISCOVERY_PORT}`,
  ...(PEER_PUBLIC_IP ? { PEER_PUBLIC_IP, BIND_HOST: '0.0.0.0' } : {}),
};
console.log(`[launcher] network: ${PEER_PUBLIC_IP ? `public at ${PEER_PUBLIC_IP}` : 'loopback only (set PEER_PUBLIC_IP to allow remote joiners)'}`);
if (UI_PORT !== 7357 || DISCOVERY_PORT !== 7350) console.log(`[launcher] default ports busy — using ui :${UI_PORT}, discovery :${DISCOVERY_PORT}`);

const children = [];
function run(name, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child._name = name;
  child.stdout.on('data', b => process.stdout.write(b));
  child.stderr.on('data', b => process.stderr.write(b));
  child.on('exit', c => console.log(`[launcher] ${name} exited (${c})`));
  children.push(child);
  return child;
}

run('discovery', 'node', [path.join(__dirname, 'discovery.mjs')], netEnv);
// LAUNCHER_MODE tells ui-server.mjs to enable /api/dimensions and /api/launch
// and to spawn peer processes on demand when the browser POSTs a choice.
run('ui',        'node', [path.join(__dirname, 'ui-server.mjs')], { LAUNCHER_MODE: '1', ...netEnv });

console.log(`[launcher] open http://127.0.0.1:${UI_PORT} to choose a dimension`);
process.on('SIGINT', () => { for (const c of children) try { c.kill('SIGINT'); } catch {}; process.exit(0); });
