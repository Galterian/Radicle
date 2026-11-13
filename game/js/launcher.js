// Startup router. If the URL has ?peer=<port>, we're already attached to a peer
// — hand off to main.js and reveal the game shell. Otherwise show the launcher
// panel, let the user pick host-or-join via /api/launch, then reload with
// ?peer=<peerPort>.

import { fancyLabel } from './names.js';
import { initProfilePanel, joinTeamButton, launchJoinTeam, peerSearch, IS_MENU, IS_MOBILE } from './profile-ui.js';

const peer = new URL(location.href).searchParams.get('peer');

function revealGame() {
  document.getElementById('launcher').hidden = true;
  for (const el of document.querySelectorAll('header#hud, main, footer#deck-bar')) el.hidden = false;
}

function showEntering(sub, mainText) {
  const ov = document.getElementById('entering-overlay');
  if (!ov) return;
  if (mainText) document.getElementById('entering-text').textContent = mainText;
  if (sub) document.getElementById('entering-sub').textContent = sub;
  ov.hidden = false;
}
export function hideEntering() {
  const ov = document.getElementById('entering-overlay');
  if (ov) ov.hidden = true;
}

async function launch() {
  const btn = document.getElementById('go');
  const msg = document.getElementById('launch-msg');
  btn.disabled = true;
  msg.textContent = 'launching…';
  const mode = document.querySelector('input[name="mode"]:checked').value;
  showEntering(mode === 'host' ? 'opening a new dimension…' : 'knocking on the door…', 'entering dimension…');
  let body;
  if (mode === 'host') {
    const name = document.getElementById('host-name').value.trim() || 'Ashfall-Micro';
    const publicIp = document.getElementById('host-ip').value || null;
    body = { mode: 'host', dimensionName: name, publicIp };
  } else if (mode === 'restore') {
    const tmjPath = document.getElementById('pick-restore').value;
    if (!tmjPath) { msg.textContent = 'no saved dimension picked'; btn.disabled = false; hideEntering(); return; }
    body = { mode: 'restore', tmjPath };
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
    location.search = peerSearch(out.peerPort);   // keeps ?mobile=1
  } catch (e) {
    msg.textContent = `failed: ${e.message}`;
    btn.disabled = false;
    hideEntering();
  }
}

// Zoom-out-friendly dimensions explorer: a grid of tiles, each listing the
// door chips (peer_id + side + tile + hp) for players who have published a
// Door into that ActiveDimensions/<Dim> branch across all Radicle namespaces.
// Clicking a chip picks that Door (join-door); clicking the tile picks the
// dimension (join-random). Chips use clamp()-sized text so door IDs stay
// readable when the launcher panel is narrow.
const MAX_CHIPS = 10;
const shortId = id => String(id || '').replace(/^peer:/, '');
const sideOf = a => (a === 'player' || a === 'npc_a' || a === 'npc_b') ? a : (a === 'player_c' || a === 'npc_c') ? 'team-c' : 'npc_b';

function pickMode(value) {
  const radio = document.querySelector(`input[name="mode"][value="${value}"]`);
  if (!radio || radio.disabled) return false;
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function doorChip(door) {
  const chip = document.createElement('button');
  chip.type = 'button';
  const side = sideOf(door.alliance);
  const isDead = (door.life ?? 1) <= 0;
  chip.className = `door-chip side-${side}${door.live ? '' : ' is-stale'}${isDead ? ' is-dead' : ''}`;
  chip.title = `${door.name || shortId(door.peer_id)}\nnid: ${door.nid}\ndoor: ${shortId(door.peer_id)}\ntile: (${door.tile?.q},${door.tile?.r})\nhp: ${door.life}/${door.life_max}\npushed: ${door.pushed_at}`;
  const dot = document.createElement('span'); dot.className = 'dc-dot'; chip.appendChild(dot);
  const id = document.createElement('span'); id.className = 'dc-id'; id.textContent = shortId(door.peer_id); chip.appendChild(id);
  if (Number.isInteger(door.tile?.q) && Number.isInteger(door.tile?.r)) {
    const c = document.createElement('span'); c.className = 'dc-coord'; c.textContent = `(${door.tile.q},${door.tile.r})`; chip.appendChild(c);
  }
  if (door.life != null && door.life_max != null) {
    const hp = document.createElement('span'); hp.className = 'dc-hp'; hp.textContent = `${door.life}/${door.life_max}`; chip.appendChild(hp);
  }
  return chip;
}

function renderDimensionsExplorer(items, ago) {
  const grid = document.getElementById('dx-grid');
  const empty = document.getElementById('dx-empty');
  if (!grid) return;
  grid.innerHTML = '';
  if (!items.length) { empty.hidden = false; return; }
  empty.hidden = true;

  const sorted = [...items].sort((a, b) => (b.live_doors - a.live_doors) || ((a.age_sec ?? 1e12) - (b.age_sec ?? 1e12)));
  for (const d of sorted) {
    const tile = document.createElement('div');
    tile.className = `dx-tile${d.legacy ? ' is-legacy' : ''}`;
    tile.dataset.dim = d.dimension_name;

    const name = document.createElement('div'); name.className = 'dx-name';
    const nm = document.createElement('span'); nm.textContent = d.dimension_name; name.appendChild(nm);
    const badge = document.createElement('span');
    badge.className = `dx-badge${d.live_doors > 0 ? ' is-live' : ''}`;
    badge.textContent = d.legacy ? 'legacy' : d.live_doors > 0 ? `LIVE · turn ${d.turn ?? 0}` : 'quiet';
    name.appendChild(badge);
    tile.appendChild(name);

    const meta = document.createElement('div'); meta.className = 'dx-meta';
    meta.innerHTML = `<span><b>${d.live_doors}</b>/${d.doors.length} door${d.doors.length === 1 ? '' : 's'}</span>` +
                     `<span><b>${(d.namespaces || []).length}</b> ns</span>` +
                     `<span>newest ${ago(d.age_sec)}</span>`;
    tile.appendChild(meta);

    const chips = document.createElement('div'); chips.className = 'dx-chips';
    // Live first, then by freshness; cap to MAX_CHIPS with a "+N more" badge
    // so the panel keeps its height bounded when a dimension gets busy.
    const ordered = [...d.doors].sort((a, b) => (b.live - a.live) || ((a.age_sec ?? 1e12) - (b.age_sec ?? 1e12)));
    const shown = ordered.slice(0, MAX_CHIPS);
    for (const door of shown) {
      const chip = doorChip(door);
      chip.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (d.legacy || !door.live) return;
        if (!pickMode('join-door')) return;
        const sel = document.getElementById('pick-door');
        const want = `${d.dimension_name}|${door.peer_id}`;
        for (const o of sel.options) if (o.value === want && !o.disabled) { sel.value = want; break; }
        document.querySelectorAll('.dx-tile.is-selected').forEach(t => t.classList.remove('is-selected'));
        tile.classList.add('is-selected');
      });
      chips.appendChild(chip);
      // "Join my <team> team" next to every live player Door (user ruling 2026-11-13); hidden without characters.
      if (!d.legacy && door.live && (door.life ?? 1) > 0 && (door.alliance === 'player' || door.alliance === 'player_c')) chips.appendChild(joinTeamButton(d.dimension_name, door.peer_id));
    }
    if (ordered.length > shown.length) {
      const more = document.createElement('span');
      more.className = 'dc-more';
      more.textContent = `+${ordered.length - shown.length} more`;
      chips.appendChild(more);
    }
    tile.appendChild(chips);

    tile.addEventListener('click', () => {
      if (d.legacy) return;
      // Clicking a tile picks the whole dimension (join-random mode).
      if (!pickMode('join-random')) return;
      const sel = document.getElementById('pick-dim');
      for (const o of sel.options) if (o.value === d.dimension_name && !o.disabled) { sel.value = d.dimension_name; break; }
      document.querySelectorAll('.dx-tile.is-selected').forEach(t => t.classList.remove('is-selected'));
      tile.classList.add('is-selected');
    });

    grid.appendChild(tile);
  }
}

// Phone menu (?mobile=1&menu=1, served by the phone's menu server): only the profile panel — that server
// has no /api/dimensions, /api/network …, so none of the host / join / restore setup runs.
async function renderMenu() {
  document.documentElement.classList.add('menu-mode');
  document.getElementById('launcher').hidden = false;
  document.querySelector('#launcher h1').textContent = 'ChaosD6';
  await initProfilePanel(document.getElementById('profile-panel'));
  hideEntering();
}

async function renderLauncher() {
  if (IS_MENU) return renderMenu();
  document.getElementById('launcher').hidden = false;
  // The profile panel loads on its own; a missing profile API only disables it.
  initProfilePanel(document.getElementById('profile-panel')).catch(() => {});
  // The radios + selects are disabled until we know what dimensions exist and
  // which doors are live, so block interaction behind the same overlay the
  // dimension-entry flow uses — different label, same spinner.
  showEntering('fetching dimensions, characters and relay candidates', 'ChaosD6 — getting ready to pick a dimension');

  // Page load uses sync=0: list whatever Radicle storage already knows about
  // without blocking on a seed fetch. Starting a new dimension and loading a
  // local TMJ don't need other peers' doors; only the two "join" modes do, and
  // for those we fire a background refresh when the user actually picks them.
  const [dimsRes, charsRes, creasRes, netRes, localRes] = await Promise.all([
    fetch('/api/dimensions?sync=0').then(r => r.json()).catch(e => ({ ok: false, items: [], reason: String(e) })),
    fetch('/data/characters.json').then(r => r.json()),
    fetch('/data/creatures.json').then(r => r.json()),
    fetch('/api/network').then(r => r.json()).catch(() => ({ candidates: [{ address: '127.0.0.1', kind: 'loopback', iface: 'lo' }], default: '127.0.0.1' })),
    fetch('/api/dimensions/local').then(r => r.json()).catch(() => ({ ok: false, items: [] })),
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
    if (p.alliance !== 'player' && p.alliance !== 'player_c') {
      if (isAlive(p)) { liveMonsterDoors++; monsterDims.add(d.dimension_name); }
      continue;
    }
    const who = `${p.name || p.peer_id.replace(/^peer:/, '')} (hp ${p.life}/${p.life_max}, tile ${p.tile?.q},${p.tile?.r})`;
    const tag = p.live ? `LIVE · turn ${p.clock?.turn ?? '?'} · door ${ago(p.age_sec)}` : `gone · door ${ago(p.age_sec)}`;
    doors.push({ d, p, live: isAlive(p), label: `${d.dimension_name} / ${who}  — ${tag}` });
  }
  const liveDoors = doors.filter(r => r.live);
  renderDimensionsExplorer(items, ago);
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

  // Local TMJ autosaves on this box — populates the restore panel.
  const pickRestore = document.getElementById('pick-restore');
  const localItems = (localRes && localRes.items) || [];
  const whenAgo = iso => { const s = Math.max(0, Math.round((Date.now() - Date.parse(iso || 0)) / 1000)); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  for (const it of localItems) {
    const o = document.createElement('option');
    o.value = it.path;
    o.textContent = `${it.dim_name || it.dim_id}  (${it.kind}, saved ${whenAgo(it.saved_at)})`;
    pickRestore.appendChild(o);
  }

  // `host` is always available; `join-door` enables only when at least one
  // alive player Door is publishing; `join-random` stays disabled; `restore`
  // enables only when at least one local TMJ was found.
  const modes = document.querySelectorAll('input[name="mode"]');
  const joinDoorRadio = document.querySelector('input[name="mode"][value="join-door"]');
  joinDoorRadio.disabled = liveDoors.length === 0;
  if (liveDoors.length) joinDoorRadio.checked = true;
  const restoreRadio = document.querySelector('input[name="mode"][value="restore"]');
  restoreRadio.disabled = localItems.length === 0;
  // Lazy seed sync: only hit the Radicle seeds the first time the user picks
  // a join mode. Host and restore never trigger it, so starting a new
  // dimension or loading a local TMJ waits on nothing network-side.
  let _joinSyncTriggered = false;
  async function refreshJoinListings() {
    if (_joinSyncTriggered) return;
    _joinSyncTriggered = true;
    const st = document.getElementById('launcher-status');
    const prev = st.textContent;
    st.textContent = 'checking the seeds for fresh doors…';
    try {
      const fresh = await fetch('/api/dimensions?sync=1').then(r => r.json()).catch(() => null);
      if (fresh?.items?.length) st.textContent = `refreshed ${fresh.items.length} dimension${fresh.items.length === 1 ? '' : 's'} from the seeds — reload the page to see them in the pickers`;
      else st.textContent = prev;
    } catch { st.textContent = prev; }
  }
  function syncPanels() {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    for (const el of document.querySelectorAll('.mode-panel')) el.hidden = el.dataset.for !== mode;
    document.querySelector('.join-opts').hidden = (mode === 'host' || mode === 'restore');
    if (mode === 'join-door' || mode === 'join-random') refreshJoinListings();
  }
  for (const m of modes) m.addEventListener('change', syncPanels); syncPanels();
  document.getElementById('go').disabled = false;

  document.getElementById('go').addEventListener('click', launch);
  // "Join my team" next to the Door picker: the picked Door, top profile character, 30–50 hexes away.
  document.getElementById('pick-door-team').addEventListener('click', () => {
    const opt = pickDoor.selectedOptions[0];
    if (!opt || opt.disabled || !opt.value) { document.getElementById('launch-msg').textContent = 'no live Door picked'; return; }
    const [dimName, doorId] = opt.value.split('|');
    launchJoinTeam(dimName, doorId);
  });
  hideEntering();
}

if (peer) {
  // We've just reloaded with ?peer=NNN. Keep the overlay up until main.js
  // hears the peer's first hello (handled over there) — otherwise the user
  // stares at an empty board while the WebSocket + hashgraph wake up.
  showEntering('connecting to peer…', 'entering dimension…');
  revealGame();
  await import('./main.js');
} else {
  document.documentElement.classList.add('in-launcher');
  if (IS_MOBILE) document.documentElement.classList.add('mobile');
  await renderLauncher();
}
