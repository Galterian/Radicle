# firebase/ — chaosD6 Radicle seed registry + GitHub-like explorer

A Firebase project that does two jobs for the chaosD6 Radicle mesh:

1. **Seed registry** — peers publish `{nid, rid, radicleAddr, lastSeen}` to Firestore on every push. A new peer calls `fetchSeeds()` at boot and uses the returned addresses as `rad sync --seed <addr> --from <nid>` targets and libp2p bootstrap hints. **The actual sync still goes peer-to-peer over libp2p/TCP** — Firestore just answers "who's online and where?"
2. **GitHub-equivalent UI** — Firebase Hosting serves a single-page explorer with:
   - `/explore` — list of registered peers (seeds) and active dimensions (branches)
   - `/peers/<nid>` — per-peer profile: `rad clone … --seed … --from <nid>` command and the dimensions this peer pushed
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
firestore.indexes.json     — lastSeen + commits ordering
public/index.html          — SPA shell + templates
public/app.js              — Firebase SDK client, routing, rendering
public/style.css           — GitHub-dark-ish palette
```
