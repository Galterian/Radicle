// Launches discovery + ui-server + 4 peers. Each peer is a real Node process with
// its own libp2p mesh node, GunDB relay, and hashgraph tape. The browser UI talks
// to peer-player-1 (which is also the human-controlled entity).

import { spawn } from 'node:child_process';
import { ensureBare, RADICLE_BARE } from './radicle-adapter.mjs';
import process from 'node:process';

await ensureBare();
console.log(`[launcher] radicle bare repo ready at ${RADICLE_BARE}`);

const DIM_NAME = 'Ashfall-Micro';
const DIM_ID   = 'dim-ashfall-micro';
const DOOR_ID  = 'door-primary';

// Peer specs — one per entity. Each peer owns its own ports and GunDB relay URL.
const peers = [
  { label: 'player-1', alliance: 'player', character: 'char_exuberant_firestroker', creature: '',                      name: 'You (Firestroker)',    tile: { q: 1, r: 2 }, libp2p: 7410, http: 7401, gun: 7501 },
  { label: 'ally-1',   alliance: 'npc_a',  character: 'char_pride_guardian',          creature: '',                      name: 'Ally — Pride Guardian', tile: { q: 0, r: 3 }, libp2p: 7411, http: 7402, gun: 7502 },
  { label: 'foe-1',    alliance: 'npc_b',  character: '',                              creature: 'mon_ruinous_minotaur',  name: 'Ruinous Minotaur',     tile: { q: 3, r: 1 }, libp2p: 7412, http: 7403, gun: 7503 },
  { label: 'foe-2',    alliance: 'npc_b',  character: '',                              creature: 'mon_ridge_runnet_3a',   name: 'Ridge Runnet 3A',      tile: { q: 3, r: 3 }, libp2p: 7413, http: 7404, gun: 7504 },
];

const children = [];
function run(name, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child._name = name;
  child.stdout.on('data', (b) => process.stdout.write(`${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`${b}`));
  child.on('exit', (code) => console.log(`[launcher] ${name} exited (${code})`));
  children.push(child);
}

run('discovery', 'node', ['discovery.mjs']);
run('ui',        'node', ['ui-server.mjs']);

// Give discovery a head start, then spawn peers with cross-pointing Gun peer URLs.
await new Promise(r => setTimeout(r, 1500));

const allGunUrls = peers.map(p => `http://127.0.0.1:${p.gun}/gun`);
for (const p of peers) {
  const others = allGunUrls.filter(u => !u.includes(`:${p.gun}/`));
  run(`peer:${p.label}`, 'node', ['peer.mjs'], {
    PEER_LABEL:        p.label,
    ALLIANCE:          p.alliance,
    ENTITY_NAME:       p.name,
    CHARACTER_ID:      p.character,
    CREATURE_ID:       p.creature,
    START_TILE:        JSON.stringify(p.tile),
    PEER_PORT_LIBP2P:  String(p.libp2p),
    PEER_PORT_HTTP:    String(p.http),
    PEER_PORT_GUN:     String(p.gun),
    DIM_NAME, DIM_ID, DOOR_ID,
    PEER_GUN_URLS:     others.join(','),
    RADICLE_PUSH_SEC:  '45',
  });
  // Stagger so libp2p ports don't race.
  await new Promise(r => setTimeout(r, 800));
}

console.log('[launcher] all processes up. UI → http://127.0.0.1:7357');

process.on('SIGINT', () => { for (const c of children) try { c.kill('SIGINT'); } catch {}; process.exit(0); });
