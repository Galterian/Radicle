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

  const items = dimsRes.items || [];
  const doors = [];
  for (const d of items) for (const door of d.doors) {
    const min = Math.max(0, Math.round((Date.now() - Date.parse(door.last_push?.at || 0)) / 60000));
    const live = door.live;
    const tag = live ? `LIVE · ${live.peers} peer${live.peers === 1 ? '' : 's'} · turn ${live.turn}` : `offline · last push ${min} min ago`;
    doors.push({ d, door, live: !!live, label: `${d.dimension_name} / ${door.door_id}  — ${tag}` });
  }
  const liveDoors = doors.filter(r => r.live);
  const status = document.getElementById('launcher-status');
  if (!dimsRes.enabled) status.textContent = `Radicle not reachable (${dimsRes.reason}). You can still create a new local Dimension.`;
  else if (!doors.length) status.textContent = 'Nothing published yet. Create a new Dimension below.';
  else if (!liveDoors.length) status.textContent = `${doors.length} published door${doors.length === 1 ? '' : 's'}, none live right now — their hosts are not running. Create a new Dimension below.`;
  else status.textContent = `${liveDoors.length} live door${liveDoors.length === 1 ? '' : 's'} (${doors.length - liveDoors.length} offline) across ${items.length} dimension${items.length === 1 ? '' : 's'}.`;

  // Offline doors are listed but not selectable — joining them only yields a
  // lonely peer spamming "fetch failed" at a host that is gone.
  const pickDoor = document.getElementById('pick-door');
  for (const r of doors) { const o = document.createElement('option'); o.value = `${r.d.dimension_name}|${r.door.door_id}`; o.textContent = r.label; o.disabled = !r.live; pickDoor.appendChild(o); }
  const firstLive = [...pickDoor.options].findIndex(o => !o.disabled); if (firstLive >= 0) pickDoor.selectedIndex = firstLive;

  const pickDim = document.getElementById('pick-dim');
  for (const d of items) {
    const liveCount = d.doors.filter(x => x.live).length;
    const o = document.createElement('option'); o.value = d.dimension_name;
    o.textContent = `${d.dimension_name}  (${liveCount}/${d.doors.length} door${d.doors.length === 1 ? '' : 's'} live)`;
    o.disabled = liveCount === 0; pickDim.appendChild(o);
  }
  const firstLiveDim = [...pickDim.options].findIndex(o => !o.disabled); if (firstLiveDim >= 0) pickDim.selectedIndex = firstLiveDim;

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
  const takenLabels = new Set(doors.flatMap(r => (r.door.members || []).map(m => String(m.peer_id || '').replace(/^peer:/, ''))));
  document.getElementById('pick-label').placeholder = fancyLabel(takenLabels);

  const modes = document.querySelectorAll('input[name="mode"]');
  for (const m of modes) if (m.value !== 'host' && liveDoors.length) m.disabled = false;
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
