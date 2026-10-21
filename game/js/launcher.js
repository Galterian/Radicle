// Startup router. If the URL has ?peer=<port>, we're already attached to a peer
// — hand off to main.js and reveal the game shell. Otherwise show the launcher
// panel, let the user pick host-or-join via /api/launch, then reload with
// ?peer=<peerPort>.

import { fancyLabel } from './names.js';

const peer = new URL(location.href).searchParams.get('peer');

function revealGame() {
  document.getElementById('launcher').hidden = true;
  for (const el of document.querySelectorAll('header#hud, main, footer#deck-bar')) el.hidden = false;
}

async function launch() {
  const btn = document.getElementById('go');
  const msg = document.getElementById('launch-msg');
  btn.disabled = true;
  msg.textContent = 'launching…';
  const mode = document.querySelector('input[name="mode"]:checked').value;
  let body;
  if (mode === 'host') {
    const name = document.getElementById('host-name').value.trim() || 'Ashfall-Micro';
    const publicIp = document.getElementById('host-ip').value || null;
    body = { mode: 'host', dimensionName: name, publicIp };
  } else {
    const side = document.getElementById('pick-side').value;
    const kind = document.getElementById('pick-kind').value;
    const whoId = document.getElementById('pick-who').value;
    const label = document.getElementById('pick-label').value.trim() || null;
    let dimensionName, doorId;
    if (mode === 'join-door') {
      [dimensionName, doorId] = document.getElementById('pick-door').value.split('|');
    } else {
      dimensionName = document.getElementById('pick-dim').value;
      doorId = null;
    }
    body = {
      mode: 'join',
      dimensionName, doorId,
      placement: mode === 'join-random' ? 'random' : 'nearby',
      side,
      characterId: kind === 'character' ? whoId : null,
      creatureId:  kind === 'creature'  ? whoId : null,
      label,
    };
  }
  try {
    const r = await fetch('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await r.json();
    if (!out.ok) throw new Error(out.error || 'launch failed');
    msg.textContent = `up on peer :${out.peerPort} — reloading…`;
    location.search = `?peer=${out.peerPort}`;
  } catch (e) {
    msg.textContent = `failed: ${e.message}`;
    btn.disabled = false;
  }
}

async function renderLauncher() {
  document.getElementById('launcher').hidden = false;

  const [dimsRes, charsRes, creasRes, netRes] = await Promise.all([
    fetch('/api/dimensions').then(r => r.json()).catch(e => ({ ok: false, items: [], reason: String(e) })),
    fetch('/data/characters.json').then(r => r.json()),
    fetch('/data/creatures.json').then(r => r.json()),
    fetch('/api/network').then(r => r.json()).catch(() => ({ candidates: [{ address: '127.0.0.1', kind: 'loopback', iface: 'lo' }], default: '127.0.0.1' })),
  ]);

  const hostIp = document.getElementById('host-ip');
  for (const c of netRes.candidates || []) {
    const o = document.createElement('option');
    o.value = c.address;
    o.textContent = c.kind === 'loopback' ? '127.0.0.1 — this machine only' : `${c.address} — ${c.kind} (${c.iface})`;
    if (c.address === netRes.default) o.selected = true;
    hostIp.appendChild(o);
  }

  // Each dimension is a set of Doors, one per player who has been in it (their
  // piece of the puzzle), each published from that player's own Radicle
  // namespace. A Door newer than the liveness window means its player is in
  // there right now.
  const items = dimsRes.items || [];
  const ago = sec => sec == null ? '—' : sec < 90 ? `${sec}s ago` : sec < 5400 ? `${Math.round(sec / 60)} min ago` : `${Math.round(sec / 3600)} h ago`;
  const isAlive = p => p.live && (p.life ?? 0) > 0;
  // Only player Doors are joinable, but monster Doors are tracked separately so
  // the status line can tell "empty dimension" from "monsters-only dimension".
  const doors = [];
  let liveMonsterDoors = 0;
  const monsterDims = new Set();
  for (const d of items) for (const p of d.doors) {
    if (p.alliance !== 'player') {
      if (isAlive(p)) { liveMonsterDoors++; monsterDims.add(d.dimension_name); }
      continue;
    }
    const who = `${p.name || p.peer_id.replace(/^peer:/, '')} (hp ${p.life}/${p.life_max}, tile ${p.tile?.q},${p.tile?.r})`;
    const tag = p.live ? `LIVE · turn ${p.clock?.turn ?? '?'} · door ${ago(p.age_sec)}` : `gone · door ${ago(p.age_sec)}`;
    doors.push({ d, p, live: isAlive(p), label: `${d.dimension_name} / ${who}  — ${tag}` });
  }
  const liveDoors = doors.filter(r => r.live);
  const livePlayerDims = new Set(liveDoors.map(r => r.d.dimension_name));
  const monstersPhrase = liveMonsterDoors
    ? ` ${liveMonsterDoors} monster${liveMonsterDoors === 1 ? '' : 's'} alive in ${monsterDims.size} dimension${monsterDims.size === 1 ? '' : 's'}.`
    : '';
  const status = document.getElementById('launcher-status');
  if (!dimsRes.enabled) status.textContent = `Radicle not reachable (${dimsRes.reason}). You can still start a new Dimension; it will be published once Radicle is back.`;
  else if (!items.length) status.textContent = 'Nothing published yet. Start a new Dimension below.';
  else if (!liveDoors.length) status.textContent = `${items.length} dimension${items.length === 1 ? '' : 's'} on Radicle, no players in any of them right now.${monstersPhrase} Start a new Dimension to open one.`;
  else status.textContent = `${liveDoors.length} player${liveDoors.length === 1 ? '' : 's'} live in ${livePlayerDims.size} dimension${livePlayerDims.size === 1 ? '' : 's'}.${monstersPhrase} ${items.length} dimension${items.length === 1 ? '' : 's'} published in total, from ${new Set(items.flatMap(d => d.namespaces)).size} Radicle namespace${new Set(items.flatMap(d => d.namespaces)).size === 1 ? '' : 's'}.`;

  // Only alive players can be joined "next to", so stale/dead player Doors stay
  // listed (for context) but are disabled.
  const pickDoor = document.getElementById('pick-door');
  doors.sort((a, b) => (b.live - a.live) || (a.p.age_sec - b.p.age_sec));
  for (const r of doors) { const o = document.createElement('option'); o.value = `${r.d.dimension_name}|${r.p.peer_id}`; o.textContent = r.label; o.disabled = r.d.legacy || !r.live; pickDoor.appendChild(o); }
  const firstLive = doors.findIndex(r => r.live); if (firstLive >= 0) pickDoor.selectedIndex = firstLive;

  const pickDim = document.getElementById('pick-dim');
  for (const d of items) {
    const o = document.createElement('option'); o.value = d.dimension_name;
    o.textContent = d.legacy
      ? `${d.dimension_name}  (older format — cannot join)`
      : `${d.dimension_name}  (${d.live_doors} live / ${d.doors.length} door${d.doors.length === 1 ? '' : 's'}, newest ${ago(d.age_sec)})`;
    o.disabled = d.legacy; pickDim.appendChild(o);
  }
  const firstLiveDim = items.findIndex(d => d.live_doors > 0); if (firstLiveDim >= 0) pickDim.selectedIndex = firstLiveDim;

  const pickKind = document.getElementById('pick-kind');
  const pickWho  = document.getElementById('pick-who');
  const characters = charsRes.entries.map(e => ({ id: e.id, name: e.name }));
  const creatures  = creasRes.entries.map(e => ({ id: e.id, name: e.name }));
  function fillWho() {
    pickWho.innerHTML = '';
    const list = pickKind.value === 'character' ? characters : creatures;
    for (const e of list) { const o = document.createElement('option'); o.value = e.id; o.textContent = `${e.name}  (${e.id})`; pickWho.appendChild(o); }
  }
  fillWho(); pickKind.addEventListener('change', fillWho);

  // Suggest a handle; the server picks its own if the field is left empty, so
  // this is just so the user sees what "auto" will look like.
  const takenLabels = new Set(items.flatMap(d => (d.members || []).map(m => String(m.peer_id || '').replace(/^peer:/, ''))));
  document.getElementById('pick-label').placeholder = fancyLabel(takenLabels);

  // `host` is always available; `join-door` enables only when at least one
  // alive player Door is publishing; `join-random` stays disabled.
  const modes = document.querySelectorAll('input[name="mode"]');
  const joinDoorRadio = document.querySelector('input[name="mode"][value="join-door"]');
  joinDoorRadio.disabled = liveDoors.length === 0;
  if (liveDoors.length) joinDoorRadio.checked = true;
  function syncPanels() {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    for (const el of document.querySelectorAll('.mode-panel')) el.hidden = el.dataset.for !== mode;
    document.querySelector('.join-opts').hidden = mode === 'host';
  }
  for (const m of modes) m.addEventListener('change', syncPanels); syncPanels();
  document.getElementById('go').disabled = false;

  document.getElementById('go').addEventListener('click', launch);
}

if (peer) {
  revealGame();
  await import('./main.js');
} else {
  await renderLauncher();
}
