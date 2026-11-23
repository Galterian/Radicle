# firebase/ — chaosD6 Radicle seed registry + GitHub-like explorer

A Firebase project that does two jobs for the chaosD6 Radicle mesh:

1. **Seed registry** — peers publish `{nid, rid, radicleAddr, lastSeen}` to Firestore on every push. A new peer calls `fetchSeeds()` at boot and uses the returned addresses as `rad sync --seed <addr> --from <nid>` targets and libp2p bootstrap hints. **The actual sync still goes peer-to-peer over libp2p/TCP** — Firestore just answers "who's online and where?"
2. **GitHub-equivalent UI** — Firebase Hosting serves a single-page explorer with:
   - `/explore` — known seeds (live `/api/v1/node` probe), registered peers and active dimensions (first 3 of each list, then "Show more" +10 per click), plus an architecture teaser linking into `/architecture#overview|repos|workflows|round`
   - `/peers/<nid>` — per-peer profile: `rad clone … --seed … --from <nid>` command; the dimensions this peer created / has a door in / pushed commits to (role chips); and its `players/<team>/<slug>` branches in chaosD6-Skills / -Effects / -Classes, read live from the OCI seed's radicle-httpd (`/api/v1/repos/<rid>/remotes/<nid>`), linked into the bundled Radicle explorer (`/nodes/<seed>/<rid>/remotes/<nid>/tree/<branch>`, `/nodes/<seed>/<rid>/commits/<oid>`)
   - `/architecture` — static overview page (`public/architecture.html`)
   - `/dimensions/<name>` — per-dimension "repo" page: commit list, live doors sidebar, `rad clone` + `git checkout ActiveDimensions/<name>` instructions

## Setup (one-time)

```sh
cd firebase
npm i -g firebase-tools                  # if not installed
firebase login
cp .firebaserc.example .firebaserc       # then edit: set your project ID
# At Firebase console → Project settings → Your apps, create a Web app;
# copy its SDK config into firebase/public/app.js (FIREBASE_CONFIG).
# At Firebase console → Build → Firestore → Rules, publish firestore.rules.
firebase deploy --only hosting,firestore
```

The peer page's door/commit lookups are collection-group queries
(`collectionGroup("doors") where nid ==`, `collectionGroup("commits") where pushedBy ==`).
They need the `fieldOverrides` in `firestore.indexes.json`; deploy them with
`firebase deploy --only firestore:indexes` (index build takes a few minutes).
Until then those two queries fail quietly and the page falls back to
`dimensions where creatorNid ==` only.

Local, network-free check: set `globalThis.__CHAOSD6_FIXTURE` before importing
`/app.js` (shape in the `app.js` header). Firebase is then never initialised and
all Firestore/httpd reads come from the fixture.

## Peer side — enabling publish/discovery

The Node adapter at `game/local-seeds.mjs` is auto-loaded by `game/radicle-adapter.mjs`. Enable it with:

```sh
export FIREBASE_PROJECT_ID=your-project-id
export FIREBASE_API_KEY=the-web-app-apiKey   # NOT a service account; the public Web API key is correct
# then start peers normally
LAUNCHER_MODE=1 node game/ui-server.mjs
```

With both vars set, every successful `pushDimension()` writes:
- `peers/<nid>` — this peer's presence (upserted every push)
- `dimensions/<name>` — the dimension header (creator, last push)
- `dimensions/<name>/doors/<nid>` — this peer's door into that dimension
- `dimensions/<name>/commits/<sha>` — a commit record so the explorer can list history

Without those vars the adapter is a silent no-op, so unconfigured dev boxes still work.

### CLI

```sh
FIREBASE_PROJECT_ID=... FIREBASE_API_KEY=... node game/local-seeds.mjs peers
FIREBASE_PROJECT_ID=... FIREBASE_API_KEY=... node game/local-seeds.mjs dims
FIREBASE_PROJECT_ID=... FIREBASE_API_KEY=... node game/local-seeds.mjs commits Ashfall-Micro
FIREBASE_PROJECT_ID=... FIREBASE_API_KEY=... node game/local-seeds.mjs peer   <nid>
```

## What this is NOT

- **Not** a Radicle seed node itself. Radicle sync is p2p libp2p over TCP; Firebase can't hold that connection. The actual seeds are the long-running Radicle nodes behind the `radicleAddr` values peers publish here.
- **Not** a replacement for the Radicle explorer at `radicle.network`. It's a thin layer on top of what peers *tell* Firebase they pushed, so it can show the mesh without needing to speak the Radicle protocol in the browser.

## Security note

`firestore.rules` as shipped is **permissive** (anyone can write a `peers/<nid>` doc so long as the NID looks right). This is fine for a private playtest. Before exposing the deploy publicly, wire in Firebase App Check or Anonymous Auth and tighten the rules.

## Files

```
firebase.json              — hosting (SPA rewrites) + firestore config
.firebaserc.example        — copy to .firebaserc and fill in project ID
firestore.rules            — public read, write-with-shape-check
firestore.indexes.json     — lastSeen + commits ordering; collection-group overrides doors.nid / commits.pushedBy
public/index.html          — SPA shell + templates
public/app.js              — Firebase SDK client, routing, rendering
public/style.css           — GitHub-dark-ish palette
```
