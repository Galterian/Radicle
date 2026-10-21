// CLI front door for joining (or starting) a dimension without the browser.
// Thin on purpose: it drives the same launcher API the web page uses, so the
// Door/bus/placement logic lives in exactly one place (ui-server.mjs).
//
//   node game/join.mjs --list
//   node game/join.mjs --dimension Ashfall-Micro [--door peer:foe-2] [--placement nearby|random]
//                      [--as P-Name] [--character char_oran_rief | --creature mon_x] [--side player|npc_a|npc_b]
//   node game/join.mjs --start Ashfall-Micro [--public-ip 192.168.1.5]
//
// If a launcher is already running on UI_PORT (default 7357) it is used;
// otherwise one is started here (and keeps running so the browser UI works).

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  args[k] = v;
}
const UI_PORT = Number(process.env.UI_PORT || args['ui-port'] || 7357);
const base = `http://127.0.0.1:${UI_PORT}`;

async function launcherUp() {
  try { const r = await fetch(`${base}/api/network`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
async function ensureLauncher() {
  if (await launcherUp()) return;
  console.log(`[join] no launcher on :${UI_PORT} — starting one`);
  const child = spawn(process.execPath, [path.join(__dirname, 'start-all.mjs')], { env: { ...process.env, UI_PORT: String(UI_PORT) }, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
  child.unref();
  for (let i = 0; i < 60; i++) { if (await launcherUp()) return; await new Promise(r => setTimeout(r, 500)); }
  throw new Error(`launcher did not come up on :${UI_PORT}`);
}

await ensureLauncher();

if (args.list) {
  const d = await fetch(`${base}/api/dimensions`).then(r => r.json());
  if (!d.enabled) { console.error(`[join] radicle unavailable: ${d.reason}`); process.exit(1); }
  const ago = s => s == null ? '—' : s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
  for (const dim of d.items) {
    console.log(`${dim.dimension_name}  — ${dim.live_doors} live / ${dim.doors.length} Door(s), ${dim.namespaces.length} namespace(s)${dim.legacy ? '  [older format, not joinable]' : ''}`);
    for (const p of dim.doors) console.log(`  ${p.peer_id.padEnd(18)} ${String(p.alliance).padEnd(6)} hp ${p.life}/${p.life_max}  tile (${p.tile?.q},${p.tile?.r})  turn ${p.clock?.turn ?? '?'}  ${p.live ? 'LIVE' : 'gone'} · ${ago(p.age_sec)} ago  ns ${p.nid.slice(0, 12)}…`);
  }
  process.exit(0);
}

let body;
if (args.start) {
  body = { mode: 'start', dimensionName: args.start === true ? 'Ashfall-Micro' : args.start, publicIp: args['public-ip'] || null };
} else {
  if (!args.dimension) { console.error('usage: node game/join.mjs --list | --dimension <name> [--door <peer_id>] [--placement nearby|random] [--as <label>] [--character <id> | --creature <id>] [--side player|npc_a|npc_b] | --start <name>'); process.exit(2); }
  body = {
    mode: 'join', dimensionName: args.dimension, doorId: args.door || null,
    placement: args.placement === 'random' ? 'random' : 'nearby',
    side: args.side || 'player',
    characterId: args.creature ? null : (args.character || 'char_oran_rief'),
    creatureId: args.creature || null,
    label: args.as || null,
  };
}
const r = await fetch(`${base}/api/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const out = await r.json();
if (!out.ok) { console.error(`[join] ${out.error}`); process.exit(1); }
console.log(`[join] ${out.status}: ${out.dimension}${out.door ? ` through Door ${out.door}` : ''}${out.startTile ? ` at tile (${out.startTile.q},${out.startTile.r}) [${out.placement}]` : ''}`);
console.log(`[join] open ${base}/?peer=${out.peerPort}`);
process.exit(0);
