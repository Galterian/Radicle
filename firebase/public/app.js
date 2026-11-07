// chaosD6 seeds — Firebase client. Reads the registry collections and renders
// a GitHub-ish explorer with three views:
//   /explore               list of peers (seeds) + list of active dimensions
//   /peers/<nid>           per-peer profile: their rad clone/sync hints + dims
//   /dimensions/<name>     per-dimension repo page: commits + live doors
//
// Firestore shape (see firestore.rules):
//   peers/<nid>                           { nid, alias, rid, radicleAddr, uiHref, lastSeen }
//   dimensions/<name>                     { name, creatorNid, lastPushAt, lastCommit, peerCount, rid }
//   dimensions/<name>/doors/<nid>         { nid, peer_id, alliance, tile, life, life_max, pushed_at, name, commit }
//   dimensions/<name>/commits/<sha>       { sha, branch, subject, when, pushedBy (nid), author }

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore, collection, collectionGroup, doc, getDoc, getDocs,
  query, where, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// ---- CONFIG ---------------------------------------------------------------
// Paste the web-app config from Firebase console → Project settings → Your
// apps → SDK setup. Leaving placeholders triggers the "not configured" view.
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBhdSRv94CpmE7rOYjupz0MfEzBR1YyqZg",
  authDomain:        "dimensions-4e9ae.firebaseapp.com",
  projectId:         "dimensions-4e9ae",
  storageBucket:     "dimensions-4e9ae.firebasestorage.app",
  messagingSenderId: "1084963762264",
  appId:             "1:1084963762264:web:aa280ace504cd8c00cda2d",
  measurementId:     "G-DV935M3SZV"
};

// Soft defaults for the "clone" boxes — overridden per-peer when a peer
// publishes its own rid/addr. Keep in sync with game/radicle-adapter.mjs:
//   DEFAULT_RID       → the game CODE repo (RADICLE_RID; chaosD6 source).
//   DEFAULT_DIMS_RID  → the ActiveDimensions-only repo (RADICLE_DIMS_RID;
//                       what peer.mjs:publishDoor() writes to). On a legacy
//                       single-RID deployment this is the same string.
// When a dim doc in Firestore carries its own `rid`, that always wins over
// these defaults — the constants are only the fallback for cards that
// predate the split.
const DEFAULT_RID       = "rad:zqZmP6itceBMqYwi1K1n8phQqCaj";
const DEFAULT_DIMS_RID  = "rad:zqZmP6itceBMqYwi1K1n8phQqCaj"; // ← set to the new dims RID once `rad init` completes

// --- liveness window used for the LIVE badge + stale greys. 3 minutes mirrors
// game/ui-server.mjs's DOOR_LIVE_MS default.
const LIVE_MS = 3 * 60 * 1000;

// --- utilities -------------------------------------------------------------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = s => { const t = String(s || ""); return t.length > 14 ? t.slice(0, 6) + "…" + t.slice(-5) : t; };
const toMs = v => v?.toMillis ? v.toMillis() : (typeof v === "number" ? v : Date.parse(v || 0));
const ago = ms => {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const isLive = ms => ms && (Date.now() - ms < LIVE_MS);
const sideOf = a => (a === "player" || a === "npc_a" || a === "npc_b") ? a : "npc_b";
const cloneCmd = (rid, addr, nid) => {
  const seedPart = addr && nid ? ` --seed ${addr} --from ${nid}` : "";
  return `rad clone ${rid}${seedPart}`;
};

// --- bootstrap -------------------------------------------------------------
const isConfigured = () => FIREBASE_CONFIG.apiKey !== "REPLACE_ME" && FIREBASE_CONFIG.projectId !== "YOUR-PROJECT";
let db = null;
if (isConfigured()) {
  const app = initializeApp(FIREBASE_CONFIG);
  db = getFirestore(app);
}

// --- data access -----------------------------------------------------------
async function fetchPeers() {
  const snap = await getDocs(query(collection(db, "peers"), orderBy("lastSeen", "desc"), limit(100)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function fetchPeer(nid) {
  const s = await getDoc(doc(db, "peers", nid));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}
async function fetchPeerDimensions(nid) {
  // Dimensions where this peer has a door — pulled from the doors subcollection
  // via a collection-group query. A missing composite index just returns [].
  try {
    const snap = await getDocs(query(collectionGroup(db, "doors"), where("nid", "==", nid), limit(200)));
    const names = new Set();
    for (const d of snap.docs) {
      const dim = d.ref.parent.parent?.id;
      if (dim) names.add(dim);
    }
    return [...names];
  } catch (e) { console.warn("peer dimensions query failed", e.message); return []; }
}
async function fetchDimensions() {
  const snap = await getDocs(query(collection(db, "dimensions"), orderBy("lastPushAt", "desc"), limit(100)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function fetchDimension(name) {
  const s = await getDoc(doc(db, "dimensions", name));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}
async function fetchDoors(name) {
  const snap = await getDocs(query(collection(db, "dimensions", name, "doors"), orderBy("pushed_at", "desc"), limit(50)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function fetchCommits(name) {
  try {
    const snap = await getDocs(query(collection(db, "dimensions", name, "commits"), orderBy("when", "desc"), limit(30)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

// --- rendering -------------------------------------------------------------
function mount(tplId) {
  const view = $("#view");
  view.innerHTML = "";
  const t = $(`#${tplId}`);
  if (!t) { view.innerHTML = `<p class="empty">missing template ${tplId}</p>`; return null; }
  view.appendChild(t.content.cloneNode(true));
  return view;
}

function wireCopy(scope) {
  $$("[data-copy]", scope).forEach(btn => {
    btn.addEventListener("click", () => {
      const box = btn.previousElementSibling;
      if (!box) return;
      navigator.clipboard.writeText(box.textContent.trim()).then(() => {
        const old = btn.textContent; btn.textContent = "copied"; setTimeout(() => btn.textContent = old, 1200);
      });
    });
  });
}

function renderPeerListItem(p) {
  const seen = toMs(p.lastSeen);
  const live = isLive(seen);
  const li = document.createElement("li");
  li.innerHTML = `
    <a class="ri-name" href="/peers/${encodeURIComponent(p.id)}">${esc(p.alias || short(p.id))}</a>
    <span class="ri-meta">
      <span class="badge ${live ? "live" : "stale"}">${live ? "LIVE" : "stale"}</span>
      <span>${esc(ago(seen))}</span>
    </span>
    <div class="ri-sub">
      <span class="mono">${esc(p.id)}</span>
      ${p.radicleAddr ? ` · seed <code>${esc(p.radicleAddr)}</code>` : " · no public addr"}
      ${p.rid ? ` · <code>${esc(p.rid)}</code>` : ""}
    </div>`;
  return li;
}

function renderDimListItem(d) {
  const t = toMs(d.lastPushAt);
  const live = isLive(t);
  const li = document.createElement("li");
  li.innerHTML = `
    <a class="ri-name" href="/dimensions/${encodeURIComponent(d.id)}">${esc(d.id)}</a>
    <span class="ri-meta">
      <span class="badge ${live ? "live" : "stale"}">${live ? "LIVE" : "quiet"}</span>
      <span>${esc(ago(t))}</span>
    </span>
    <div class="ri-sub">
      ActiveDimensions/${esc(d.id)} · ${d.peerCount ?? "?"} peers
      ${d.creatorNid ? ` · creator <span class="mono">${esc(short(d.creatorNid))}</span>` : ""}
    </div>`;
  return li;
}

// Hard-coded always-on seeders. Static source of truth lives in
// infra/oci/seeder.json; keep this list in lockstep when the IP changes.
const KNOWN_SEEDS = [
  {
    label: "OCI Frankfurt (chaos-oci-seed)",
    hostname: "92-5-138-121.sslip.io",
    gossipPort: 8776,
    apiBase: "https://92-5-138-121.sslip.io",
    nidHint: "z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT",
  },
];

async function probeKnownSeed(s) {
  try {
    const r = await fetch(`${s.apiBase}/api/v1/node`, { cache: "no-store" });
    if (!r.ok) throw new Error(`http ${r.status}`);
    const info = await r.json();
    return { ...s, info, ok: true };
  } catch (e) {
    return { ...s, ok: false, error: String(e && e.message || e) };
  }
}

function renderKnownSeedItem(s) {
  const li = document.createElement("li");
  const nid = (s.info && s.info.id) || s.nidHint || "";
  const alias = (s.info && s.info.config && s.info.config.alias) || "";
  const addr = `${nid}@${s.hostname}:${s.gossipPort}`;
  li.innerHTML = `
    <a class="ri-name" href="${esc(s.apiBase)}/api/v1/node" target="_blank" rel="noreferrer">${esc(s.label)}</a>
    <span class="ri-meta">
      <span class="badge ${s.ok ? "live" : "stale"}">${s.ok ? "LIVE" : "unreachable"}</span>
      ${s.info && s.info.agent ? `<span>${esc(s.info.agent)}</span>` : ""}
    </span>
    <div class="ri-sub">
      ${alias ? `<span>${esc(alias)}</span> · ` : ""}
      <span class="mono">${esc(nid)}</span>
      · dial <code>${esc(addr)}</code>
      ${s.ok ? "" : ` · <span class="muted">${esc(s.error || "")}</span>`}
    </div>`;
  return li;
}

async function viewExplore() {
  mount("tpl-explore");
  const [known, peers, dims] = await Promise.all([
    Promise.all(KNOWN_SEEDS.map(probeKnownSeed)),
    fetchPeers().catch(() => []),
    fetchDimensions().catch(() => []),
  ]);
  const kl = $("#known-list"), pl = $("#peer-list"), dl = $("#dim-list");
  if (!known.length) kl.innerHTML = `<li class="empty">No known seeders configured.</li>`;
  else known.forEach(s => kl.appendChild(renderKnownSeedItem(s)));
  if (!peers.length) pl.innerHTML = `<li class="empty">No peers have published yet. Run <code>game/local-seeds.mjs</code> on a peer to register one.</li>`;
  else peers.forEach(p => pl.appendChild(renderPeerListItem(p)));
  if (!dims.length) dl.innerHTML = `<li class="empty">No dimensions pushed yet.</li>`;
  else dims.forEach(d => dl.appendChild(renderDimListItem(d)));
}

async function viewPeer(nid) {
  mount("tpl-peer");
  const peer = await fetchPeer(nid).catch(() => null);
  if (!peer) return viewNotFound();
  $(".crumb-peer").textContent = peer.alias || short(nid);
  $(".alias").textContent = peer.alias || "(no alias)";
  $(".nid").textContent = nid;
  const seen = toMs(peer.lastSeen);
  $(".profile-sub").innerHTML = `
    ${isLive(seen) ? `<span class="badge live">LIVE</span>` : `<span class="badge stale">stale</span>`}
    last seen ${esc(ago(seen))}
    ${peer.radicleAddr ? ` · seed <code>${esc(peer.radicleAddr)}</code>` : ""}
    ${peer.rid ? ` · <code>${esc(peer.rid)}</code>` : ""}
  `;
  $(".clone-box").textContent = cloneCmd(peer.rid || DEFAULT_RID, peer.radicleAddr, nid);
  wireCopy($("#view"));

  const names = await fetchPeerDimensions(nid);
  const list = $(".dim-list");
  if (!names.length) list.innerHTML = `<li class="empty">This peer has not pushed any dimension doors yet.</li>`;
  else {
    const dims = await Promise.all(names.map(n => fetchDimension(n).then(d => d || { id: n })));
    dims.sort((a, b) => toMs(b.lastPushAt) - toMs(a.lastPushAt));
    dims.forEach(d => list.appendChild(renderDimListItem(d)));
  }
}

async function viewDimension(name) {
  mount("tpl-dim");
  const [dim, doors, commits] = await Promise.all([
    fetchDimension(name).catch(() => null),
    fetchDoors(name).catch(() => []),
    fetchCommits(name).catch(() => []),
  ]);
  if (!dim && !doors.length && !commits.length) return viewNotFound();
  const d = dim || { id: name };
  $(".crumb-dim").textContent = name;
  $$(".dim-name, .dim-name-inline").forEach(el => el.textContent = name);
  const latest = toMs(d.lastPushAt) || toMs(doors[0]?.pushed_at) || toMs(commits[0]?.when);
  if (isLive(latest)) $(".badge.live").hidden = false;
  $(".peer-count").textContent = String(d.peerCount ?? doors.length);
  $(".updated").textContent = ago(latest);
  // Dim cards clone from the dims repo (not the code repo) — that's where the
  // ActiveDimensions/<Name> branch lives after Phase 2 of the RID split. Any
  // dim doc with its own `rid` keeps winning so legacy rows still work.
  const dimRid = d.rid || DEFAULT_DIMS_RID;
  $(".clone-box").textContent = `git clone --branch ActiveDimensions/${name} --single-branch --depth 1 ${dimRid}  # (Radicle-aware git required; rad clone also fine)`;
  wireCopy($("#view"));

  const cl = $(".commit-list");
  if (!commits.length) cl.innerHTML = `<li class="empty">No commits recorded. Peers register commits by calling <code>publishCommit()</code> in <code>game/local-seeds.mjs</code>.</li>`;
  else commits.forEach(c => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>
        <div class="co-subject">${esc(c.subject || "(no subject)")}</div>
        <div class="co-meta">
          <span class="mono">${esc(short(c.pushedBy || ""))}</span>
          · ${esc(ago(toMs(c.when)))}
          · <code>${esc(c.branch || "")}</code>
        </div>
      </div>
      <a class="co-sha mono" href="${esc(c.href || `#${c.sha}`)}" ${c.href ? 'target="_blank" rel="noreferrer"' : ""}>${esc(String(c.sha || "").slice(0, 10))}</a>`;
    cl.appendChild(li);
  });

  const dl = $(".door-list");
  if (!doors.length) dl.innerHTML = `<li class="empty">No doors published.</li>`;
  else doors.forEach(door => {
    const t = toMs(door.pushed_at);
    const live = isLive(t);
    const li = document.createElement("li");
    if (!live) li.classList.add("stale");
    const side = sideOf(door.alliance);
    li.innerHTML = `
      <span class="dot side-${side}"></span>
      <span class="door-id" title="${esc(door.peer_id || "")}">${esc(door.name || short(door.peer_id || ""))}</span>
      <span class="co-meta">${esc(ago(t))}</span>
      <span class="door-sub">
        ${door.tile ? `(${door.tile.q},${door.tile.r}) · ` : ""}
        ${door.life != null ? `hp ${esc(door.life)}/${esc(door.life_max)} · ` : ""}
        nid <span class="mono">${esc(short(door.nid || ""))}</span>
      </span>`;
    dl.appendChild(li);
  });
}

function viewNotFound() { mount("tpl-404"); }
function viewConfig()   { mount("tpl-config"); }

// --- router ---------------------------------------------------------------
async function route() {
  if (!isConfigured()) return viewConfig();
  const path = location.pathname;
  try {
    if (path === "/" || path === "/explore" || path === "/index.html") return await viewExplore();
    let m;
    if ((m = path.match(/^\/peers\/([^/]+)\/?$/)))      return await viewPeer(decodeURIComponent(m[1]));
    if ((m = path.match(/^\/dimensions\/([^/]+)\/?$/))) return await viewDimension(decodeURIComponent(m[1]));
    return viewNotFound();
  } catch (e) {
    console.error(e);
    $("#view").innerHTML = `<p class="empty">error: ${esc(e.message)}</p>`;
  }
}

// Intercept same-origin link clicks only for paths THIS SPA handles. Anything
// else (e.g. the top-nav link into /nodes/<seed>/rad:<rid>/..., which belongs
// to the Radicle Explorer SPA served from /radicle/ via Firebase's catchall
// rewrite) must fall through to a real navigation — otherwise pushState keeps
// us on this page and the router shows viewNotFound.
const SPA_ROUTE = /^\/(?:$|explore(?:$|\/)|index\.html$|peers\/|dimensions\/)/;
document.addEventListener("click", (ev) => {
  const a = ev.target.closest("a");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href || href.startsWith("http") || href.startsWith("mailto:") || a.target === "_blank") return;
  if (!SPA_ROUTE.test(href)) return;
  ev.preventDefault();
  history.pushState({}, "", href);
  route();
});
window.addEventListener("popstate", route);

// Minimal client-side search — jumps to a peer or dimension by exact match.
$("#q")?.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  const v = ev.target.value.trim();
  if (!v) return;
  if (/^z[1-9A-HJ-NP-Za-km-z]{10,}$/.test(v)) { history.pushState({}, "", `/peers/${encodeURIComponent(v)}`); route(); }
  else { history.pushState({}, "", `/dimensions/${encodeURIComponent(v)}`); route(); }
});

route();
