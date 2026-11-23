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
//
// The peer page's dimension list is the union of three isolated queries:
// dimensions where creatorNid == nid (auto-indexed), collectionGroup("doors")
// where nid == nid and collectionGroup("commits") where pushedBy == nid. The
// two collection-group queries need the fieldOverrides in
// firestore.indexes.json (`firebase deploy --only firestore:indexes`); until
// they are deployed those queries fail quietly and only the creator list shows.
// The peer page also lists the node's `players/<team>/<slug>` branches in the
// Skills / Effects / Classes repos via the seed's radicle-httpd
// (GET /api/v1/repos/<rid>/remotes/<nid> → { heads: { <branch>: <oid> } }).
//
// Test fixture hook: if globalThis.__CHAOSD6_FIXTURE is set BEFORE this module
// loads (only a local test page does that), Firebase is never initialised and
// the data functions read from it instead of Firestore / httpd:
//   { peers: [doc…], dimensions: [doc…],            // docs carry `id`
//     doors: { <dim>: [door…] }, commits: { <dim>: [commit…] },
//     http:  { <absolute url>: <json> | { __error: "msg", __status?: 404 } } }
// Unknown URLs in fixture mode throw "fixture: no response" (never hit the net).

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
const DEFAULT_DIMS_RID  = "rad:z2xbfJfwT3kukR73m8LXmmuvchEwr"; // chaosD6-Dimensions — dims-only repo for ActiveDimensions/<Name> branches
// OCI radicle-httpd host for the HTTPS-based clone box. Keep in sync with
// infra/oci/seeder.json and KNOWN_SEEDS[0].hostname below. The dim-view clone
// box uses this to build a vanilla-git command that works without the Radicle
// toolchain (so mobile users and anyone without `rad` installed can clone).
const DEFAULT_SEED_HOST = "92-5-138-121.sslip.io";

// --- liveness window used for the LIVE badge + stale greys. 3 minutes mirrors
// game/ui-server.mjs's DOOR_LIVE_MS default.
const LIVE_MS = 3 * 60 * 1000;

// --- utilities -------------------------------------------------------------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = s => { const t = String(s || ""); return t.length > 14 ? t.slice(0, 6) + "…" + t.slice(-5) : t; };
const toMs = v => v?.toMillis ? v.toMillis() : (typeof v === "number" ? v : (v ? Date.parse(v) || 0 : 0));
const ago = ms => {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const isLive = ms => ms && (Date.now() - ms < LIVE_MS);
const sideOf = a => (a === "player" || a === "npc_a" || a === "npc_b") ? a : (a === "player_c" || a === "npc_c") ? "team-c" : "npc_b";
const cloneCmd = (rid, addr, nid) => {
  const seedPart = addr && nid ? ` --seed ${addr} --from ${nid}` : "";
  return `rad clone ${rid}${seedPart}`;
};

// --- bootstrap -------------------------------------------------------------
const isConfigured = () => FIREBASE_CONFIG.apiKey !== "REPLACE_ME" && FIREBASE_CONFIG.projectId !== "YOUR-PROJECT";
const FX = globalThis.__CHAOSD6_FIXTURE || null;   // see header: test-only
let db = null;
if (isConfigured() && !FX) {
  const app = initializeApp(FIREBASE_CONFIG);
  db = getFirestore(app);
}

// --- data access -----------------------------------------------------------
const byDesc = key => (a, b) => toMs(b[key]) - toMs(a[key]);
const fxList = (name, sub) => (sub ? FX[name]?.[sub] : FX[name]) || [];

// Cross-origin JSON GET (radicle-httpd). Errors carry `.status` so callers can
// tell "this peer has no remote in that repo" (404) from a real failure.
async function getJson(url) {
  if (FX) {
    if (!(url in (FX.http || {}))) throw new Error("fixture: no response");
    const v = FX.http[url];
    if (v && v.__error) { const e = new Error(v.__error); e.status = v.__status; throw e; }
    return v;
  }
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) { const e = new Error(`http ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

async function fetchPeers() {
  if (FX) return [...fxList("peers")].sort(byDesc("lastSeen")).slice(0, 100);
  const snap = await getDocs(query(collection(db, "peers"), orderBy("lastSeen", "desc"), limit(100)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function fetchPeer(nid) {
  if (FX) return fxList("peers").find(p => p.id === nid) || null;
  const s = await getDoc(doc(db, "peers", nid));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}
// Dimensions this peer took part in, as Map<name, { doc?, roles:Set }>. Three
// independent sources — each isolated so one failing query (e.g. a collection-
// group index not deployed yet) never blanks the others.
async function fetchPeerDimensions(nid) {
  const out = new Map();
  const add = (name, role, docData) => {
    if (!name) return;
    const e = out.get(name) || { roles: new Set() };
    e.roles.add(role);
    if (docData) e.doc = docData;
    out.set(name, e);
  };
  const sources = FX ? [
    async () => fxList("dimensions").filter(d => d.creatorNid === nid).forEach(d => add(d.id, "creator", d)),
    async () => Object.entries(FX.doors || {}).forEach(([dim, ds]) => ds.some(d => d.nid === nid) && add(dim, "door")),
    async () => Object.entries(FX.commits || {}).forEach(([dim, cs]) => cs.some(c => c.pushedBy === nid) && add(dim, "commits")),
  ] : [
    async () => {
      const snap = await getDocs(query(collection(db, "dimensions"), where("creatorNid", "==", nid), limit(200)));
      snap.docs.forEach(d => add(d.id, "creator", { id: d.id, ...d.data() }));
    },
    async () => {
      const snap = await getDocs(query(collectionGroup(db, "doors"), where("nid", "==", nid), limit(200)));
      snap.docs.forEach(d => add(d.ref.parent.parent?.id, "door"));
    },
    async () => {
      const snap = await getDocs(query(collectionGroup(db, "commits"), where("pushedBy", "==", nid), limit(300)));
      snap.docs.forEach(d => add(d.ref.parent.parent?.id, "commits"));
    },
  ];
  const labels = ["creator", "doors", "commits"];
  await Promise.all(sources.map((fn, i) => fn().catch(e => console.warn(`peer dimensions (${labels[i]}) query failed:`, e.message))));
  return out;
}
async function fetchDimensions() {
  if (FX) return [...fxList("dimensions")].sort(byDesc("lastPushAt")).slice(0, 100);
  const snap = await getDocs(query(collection(db, "dimensions"), orderBy("lastPushAt", "desc"), limit(100)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function fetchDimension(name) {
  if (FX) return fxList("dimensions").find(d => d.id === name) || null;
  const s = await getDoc(doc(db, "dimensions", name));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}
async function fetchDoors(name) {
  if (FX) return [...fxList("doors", name)].sort(byDesc("pushed_at")).slice(0, 50);
  const snap = await getDocs(query(collection(db, "dimensions", name, "doors"), orderBy("pushed_at", "desc"), limit(50)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function fetchCommits(name) {
  if (FX) return [...fxList("commits", name)].sort(byDesc("when")).slice(0, 30);
  try {
    const snap = await getDocs(query(collection(db, "dimensions", name, "commits"), orderBy("when", "desc"), limit(30)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

// Definition repos a node authors into from the rules editor. Each authored
// skill/effect/class lands on branch players/<team>/<slug> in the author's
// namespace of the matching repo (fetched by the seed).
const DEF_REPOS = [
  { kind: "skill",  name: "chaosD6-Skills",  rid: "rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5" },
  { kind: "effect", name: "chaosD6-Effects", rid: "rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ" },
  { kind: "class",  name: "chaosD6-Classes", rid: "rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi" },
];
// → { repo, branches: [{ branch, team, slug, oid }] } or { repo, error }.
// A 404 means the seed holds no refs for this node in that repo: not an error.
async function fetchPeerBranches(seed, repo, nid) {
  try {
    const r = await getJson(`${seed.apiBase}/api/v1/repos/${repo.rid}/remotes/${encodeURIComponent(nid)}`);
    const branches = Object.entries(r?.heads || {})
      .filter(([b]) => b.startsWith("players/"))
      .map(([branch, oid]) => {
        const [, team = "", ...rest] = branch.split("/");
        return { branch, team, slug: rest.join("/") || team, oid: String(oid || "") };
      })
      .sort((a, b) => (a.team + "/" + a.slug).localeCompare(b.team + "/" + b.slug));
    return { repo, branches };
  } catch (e) {
    if (e.status === 404) return { repo, branches: [] };
    return { repo, error: String(e && e.message || e) };
  }
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

// `roles` (peer page only): which sources linked the peer to this dimension.
function renderDimListItem(d, roles) {
  const t = toMs(d.lastPushAt);
  const live = isLive(t);
  const li = document.createElement("li");
  const roleChips = roles && roles.size
    ? `<span class="roles">${[...roles].map(r => `<span class="chip role-${esc(r)}">${esc(r)}</span>`).join("")}</span>`
    : "";
  li.innerHTML = `
    <a class="ri-name" href="/dimensions/${encodeURIComponent(d.id)}">${esc(d.id)}</a>
    <span class="ri-meta">
      ${roleChips}
      <span class="badge ${live ? "live" : "stale"}">${live ? "LIVE" : "quiet"}</span>
      <span>${esc(ago(t))}</span>
    </span>
    <div class="ri-sub">
      ActiveDimensions/${esc(d.id)} · ${esc(d.peerCount ?? "?")} peers
      ${d.creatorNid ? ` · creator <span class="mono">${esc(short(d.creatorNid))}</span>` : ""}
    </div>`;
  return li;
}

// Render `items` into `ul` a page at a time: `first` rows up front, then a
// "Show more" button below the list that reveals `step` more per click.
function renderPaged(ul, items, renderItem, { first = 3, step = 10 } = {}) {
  let shown = 0;
  const more = document.createElement("div");
  more.className = "more-row";
  more.innerHTML = `<button class="btn more" type="button"></button>`;
  const btn = more.firstElementChild;
  const reveal = n => {
    items.slice(shown, shown + n).forEach(it => ul.appendChild(renderItem(it)));
    shown = Math.min(items.length, shown + n);
    const left = items.length - shown;
    more.hidden = left <= 0;
    btn.textContent = left > step ? `Show ${step} more (${left} remaining)` : `Show ${left} more`;
  };
  btn.addEventListener("click", () => reveal(step));
  ul.after(more);
  reveal(first);
}

function renderBranchItem(seed, nid, repo, b) {
  const host = seed.hostname;
  const seg = s => s.split("/").map(encodeURIComponent).join("/");
  const treeHref = `/nodes/${host}/${repo.rid}/remotes/${encodeURIComponent(nid)}/tree/${seg(b.branch)}`;
  const commitHref = `/nodes/${host}/${repo.rid}/commits/${encodeURIComponent(b.oid)}`;
  const li = document.createElement("li");
  li.innerHTML = `
    <a class="ri-name" href="${esc(treeHref)}">${esc(b.slug)}</a>
    <span class="ri-meta">
      <span class="chip kind-${esc(repo.kind)}">${esc(repo.kind)}</span>
      ${b.oid ? `<a class="mono" href="${esc(commitHref)}" title="${esc(b.oid)}">${esc(b.oid.slice(0, 7))}</a>` : ""}
    </span>
    <div class="ri-sub">
      team <b>${esc(b.team || "—")}</b> · <code>${esc(b.branch)}</code> · ${esc(repo.name)}
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
    const info = await getJson(`${s.apiBase}/api/v1/node`);
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
  else renderPaged(pl, peers, renderPeerListItem);
  if (!dims.length) dl.innerHTML = `<li class="empty">No dimensions pushed yet.</li>`;
  else renderPaged(dl, dims, d => renderDimListItem(d));
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

  await Promise.all([renderPeerDims(nid), renderPeerBranches(nid)]);
}

async function renderPeerDims(nid) {
  const found = await fetchPeerDimensions(nid);
  const list = $(".dim-list");
  list.innerHTML = "";
  if (!found.size) { list.innerHTML = `<li class="empty">This peer has not created, joined or pushed to any dimension yet.</li>`; return; }
  const rows = await Promise.all([...found].map(async ([name, e]) =>
    ({ d: e.doc || await fetchDimension(name).catch(() => null) || { id: name }, roles: e.roles })));
  rows.sort((a, b) => toMs(b.d.lastPushAt) - toMs(a.d.lastPushAt));
  rows.forEach(r => list.appendChild(renderDimListItem(r.d, r.roles)));
}

async function renderPeerBranches(nid) {
  const seed = KNOWN_SEEDS[0];
  const results = await Promise.all(DEF_REPOS.map(repo => fetchPeerBranches(seed, repo, nid)));
  const list = $(".branch-list");
  list.innerHTML = "";
  for (const r of results) {
    if (r.error) continue;
    r.branches.forEach(b => list.appendChild(renderBranchItem(seed, nid, r.repo, b)));
  }
  if (!list.children.length && results.some(r => !r.error)) list.innerHTML = `<li class="empty">No skills, effects or classes published from this node yet — author them in the rules editor on your node.</li>`;
  for (const r of results) {
    if (!r.error) continue;
    const li = document.createElement("li");
    li.className = "quiet-error";
    li.innerHTML = `<span class="muted">${esc(r.repo.name)}: could not read from the seed (${esc(r.error)})</span>`;
    list.appendChild(li);
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
  // Shallow single-branch clone via the Radicle toolchain. Requires `rad` and
  // `git-remote-rad` on PATH — both ship as part of a Radicle install, which
  // every joining peer is expected to have. Three details that must be exactly
  // right for `git clone` to resolve the dim branch:
  //   1. URL scheme is `rad://` (two slashes). `rad:<RID>` with a single colon
  //      is parsed by git as scp-style `user@host:path`, which bypasses the
  //      remote helper entirely and fails with "ssh: Could not resolve rad".
  //   2. The URL carries the publisher NID as a path suffix:
  //        rad://<RID>/<NID>
  //      Without it, `git-remote-rad` only serves refs from the clone-user's
  //      OWN namespace, which won't contain the branch unless they're the
  //      publisher. Suffixing the NID targets that peer's namespace directly.
  //   3. `--branch`/`--single-branch`/`--depth 1` are standard git flags that
  //      git-remote-rad honours, giving us minimum-size dim fetches (no code
  //      history, just the one branch — tested at ~350 KB per dim).
  const dimRid    = d.rid || DEFAULT_DIMS_RID;
  const ridBare   = dimRid.replace(/^rad:/, "");
  // Prefer `creatorNid` from the dim doc (set by publishDimensionPush); fall
  // back to the first door's nid if the doc predates creator tracking.
  const publisher = d.creatorNid || doors[0]?.nid || "";
  // Trailing `${name}` is the clone target dir — without it, `git clone`
  // defaults to the last URL segment (the NID), so your working tree lands
  // in a folder named z6Mkrh3g…ag6yy/ instead of the dim name.
  const safeDirName = String(name).replace(/[^A-Za-z0-9._-]/g, "_");
  $(".clone-box").textContent = publisher
    ? `git clone --branch ActiveDimensions/${name} --single-branch --depth 1 rad://${ridBare}/${publisher} ${safeDirName}`
    : `git clone --branch ActiveDimensions/${name} --single-branch --depth 1 rad://${ridBare} ${safeDirName}  # (publisher NID unknown — may need rad://<RID>/<NID>)`;
  wireCopy($("#view"));

  // Build a chaosd6:// deeplink that the Android app's intent-filter picks up.
  // The Godot DimensionLauncher parses this URL at launch, fetches the dim via
  // radicle-httpd, and spawns the player next to the chosen unit as its ally.
  // Shape:
  //   chaosd6://join?dim=<name>&rid=<RID bare>&peer=<peer_id>&nid=<publisher>&commit=<sha>[&team=c]
  // `peer` picks the unit: several peers in one desktop mesh share a single NID.
  // `team=c` ("Join as my team") enters as a third team, hostile to both sides;
  // without it the app joins as an ally of the player's side.
  const joinUri = (peer, nid, sha, team) => {
    const parts = [`dim=${encodeURIComponent(name)}`, `rid=${encodeURIComponent(ridBare)}`];
    if (peer) parts.push(`peer=${encodeURIComponent(peer)}`);
    if (nid) parts.push(`nid=${encodeURIComponent(nid)}`);
    if (sha) parts.push(`commit=${encodeURIComponent(sha)}`);
    if (team) parts.push(`team=${encodeURIComponent(team)}`);
    return `chaosd6://join?${parts.join("&")}`;
  };
  const peerFromSubject = s => (String(s || "").match(/^\[([^\]]+)\]/) || [])[1] || "";

  const cl = $(".commit-list");
  if (!commits.length) cl.innerHTML = `<li class="empty">No commits recorded. Peers register commits by calling <code>publishCommit()</code> in <code>game/local-seeds.mjs</code>.</li>`;
  else commits.forEach(c => {
    const li = document.createElement("li");
    const joinHref = joinUri(peerFromSubject(c.subject), c.pushedBy, c.sha);
    const teamHref = joinUri(peerFromSubject(c.subject), c.pushedBy, c.sha, "c");
    li.innerHTML = `
      <div>
        <div class="co-subject">${esc(c.subject || "(no subject)")}</div>
        <div class="co-meta">
          <span class="mono">${esc(short(c.pushedBy || ""))}</span>
          · ${esc(ago(toMs(c.when)))}
          · <code>${esc(c.branch || "")}</code>
          · <a class="join-link" href="${esc(joinHref)}">Join as ally</a>
            <a class="join-link team-c" href="${esc(teamHref)}">Join as my team</a>
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
    const joinHref = joinUri(door.peer_id, door.nid, door.commit);
    const teamHref = joinUri(door.peer_id, door.nid, door.commit, "c");
    li.innerHTML = `
      <span class="dot side-${side}"></span>
      <span class="door-id" title="${esc(door.peer_id || "")}">${esc(door.name || short(door.peer_id || ""))}</span>
      <span class="co-meta">${esc(ago(t))}</span>
      <span class="door-sub">
        ${door.tile ? `(${door.tile.q},${door.tile.r}) · ` : ""}
        ${door.life != null ? `hp ${esc(door.life)}/${esc(door.life_max)} · ` : ""}
        nid <span class="mono">${esc(short(door.nid || ""))}</span>
      </span>
      <a class="join-link" href="${esc(joinHref)}">Join as ally →</a>
      <a class="join-link team-c" href="${esc(teamHref)}">Join as my team →</a>`;
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
