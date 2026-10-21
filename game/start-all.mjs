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
    for (const d of items) {
      console.log(`${d.dimension_name}  (${d.doors.length} door${d.doors.length === 1 ? '' : 's'} from ${d.namespaces.length} namespace${d.namespaces.length === 1 ? '' : 's'}${d.legacy_doors.length ? `, ${d.legacy_doors.length} legacy door(s)` : ''})`);
      for (const p of d.doors) console.log(`  ${p.peer_id.padEnd(18)} ${String(p.alliance).padEnd(6)} hp ${p.life}/${p.life_max}  tile (${p.tile?.q},${p.tile?.r})  turn ${p.clock?.turn}  pushed ${ageMin(p.pushed_at)} min ago  ns ${p.nid.slice(0, 12)}…`);
    }
  } catch (e) { console.error(`[launcher] ${e.message}`); process.exit(1); }
  process.exit(0);
}

// Several launchers can run on one box (to simulate different machines), so
// the UI port is only a preference — take the next free one. UI_PORT still
// pins it explicitly if you want.
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
const UI_PORT = Number(process.env.UI_PORT) || await freePort(7357);

// No host, no directory server: peers find each other through the Doors on
// Radicle and talk over the public Nostr bus. The old discovery.mjs mirror is
// only started when asked (WITH_DISCOVERY=1) as a same-LAN accelerator.
const WITH_DISCOVERY = process.env.WITH_DISCOVERY === '1';
const DISCOVERY_PORT = WITH_DISCOVERY ? (Number(process.env.DISCOVERY_PORT) || await freePort(7350)) : null;
const PEER_PUBLIC_IP = process.env.PEER_PUBLIC_IP || '';
const netEnv = {
  UI_PORT: String(UI_PORT),
  ...(WITH_DISCOVERY ? { DISCOVERY_PORT: String(DISCOVERY_PORT), DISCOVERY_URL: `http://127.0.0.1:${DISCOVERY_PORT}` } : {}),
  ...(PEER_PUBLIC_IP ? { PEER_PUBLIC_IP } : {}),
};
console.log(`[launcher] bus relays: ${process.env.NOSTR_RELAYS || 'wss://relay.primal.net, wss://relay.snort.social, wss://relay.nostr.net (override with NOSTR_RELAYS)'}`);
console.log(`[launcher] direct links: ${PEER_PUBLIC_IP ? `preset address ${PEER_PUBLIC_IP}` : 'address auto-detected when you start a dimension (override with PEER_PUBLIC_IP)'}`);
if (UI_PORT !== 7357) console.log(`[launcher] default UI port busy — using :${UI_PORT}`);

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

if (WITH_DISCOVERY) run('discovery', process.execPath, [path.join(__dirname, 'discovery.mjs')], { ...netEnv, BIND_HOST: '0.0.0.0' });
// LAUNCHER_MODE tells ui-server.mjs to enable /api/dimensions and /api/launch
// and to spawn peer processes on demand when the browser POSTs a choice.
// process.execPath keeps the same node binary (the system one may be too old).
run('ui', process.execPath, [path.join(__dirname, 'ui-server.mjs')], { LAUNCHER_MODE: '1', ...netEnv });

console.log(`[launcher] open http://127.0.0.1:${UI_PORT} to choose a dimension`);
process.on('SIGINT', () => { for (const c of children) try { c.kill('SIGINT'); } catch {}; process.exit(0); });
