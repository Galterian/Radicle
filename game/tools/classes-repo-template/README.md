# chaosD6-Classes

The classes of chaosD6, defined as data (JsonLogic hooks). One class per file:

**This repo is the source of truth** (since 2026-11-28). Edit the classes, libraries, oracles and docs here.
chaosD6 builds its game copy `game/classes-data/` from this repo (`node game/tools/defs-build.mjs classes`) and
pins the commit in `game/defs-pins.json`; never edit that copy — `defs-build.mjs --check` fails on it.
`tools/engine/`, `tools/validator/` and `data/classes.json` stay copies OF the game (written by
`game/tools/classes-repo-sync.mjs`; rebalance and proposals still write chaosD6 `data/classes.json`).
Publish with `bash game/tools/oci/defs-publish.sh classes` (a delegate, with the Radicle key in the agent).

```
classes/<id>.json       one class definition; "id" inside == file name
lib/<id>.json          shared sub-routine libraries a class lists in "uses"
SCHEMA.md              the definition format
HOOKS.md               the resolver hook points a class can attach to
index.json             manifest: id -> sha256 of the canonical JSON, for classes and lib
data/classes.json      the class data versions + weights (rebalance / proposals collection; owned here, ruling 2026-11-20 #5)
oracle/                JS TEST ORACLES: the reference hooks (classes-js.mjs) + class configs (class-configs.mjs) the
                       definitions are checked against (CLASS_ENGINE=shadow); never run by the game itself
validator/pin.json     which validator build gates merges into main (commit + sha256)
tools/                 everything needed to check a class OFFLINE — see tools/README.md
  manifest.mjs         index.json generator / checker
  check.mjs            schema + pinned engine + pinned validator:  node tools/check.mjs classes/<id>.json
  engine/              copy of the pinned chaosD6 engine (effect-engine.mjs, classes.mjs + class-engine.mjs hook runner,
                       class-state.mjs, world-prims.mjs / contact-prims.mjs generic primitives)
  validator/           copy of the pinned classes validator (+ calibration)
  pins.json            sha256 of every file in engine/ and validator/
```

## Identity of a class

A class is identified by **sha256 of its canonical JSON** (object keys sorted, no whitespace,
arrays in order), not by its name or path. Peers in a game exchange refs:

```json
{ "repo": "rad:z…", "branch": "players/alice/storm-caller", "commit": "<40 hex>", "sha256": "<64 hex>", "id": "class_storm_caller" }
```

A peer that lacks the class fetches `classes/<id>.json` at `commit` from anyone (seed, peer,
local clone) and accepts it only if the sha256 matches. Libraries are fetched the same way
(`lib/<id>.json`, own sha256). Reformatting a file does not change its sha256; changing any
value does — that is a new class version.

## Branches

| branch | contents | who writes |
|---|---|---|
| `main` | the built-in classes the game ships with | the chaosD6 delegate(s) only |
| `players/<nid-or-name>/<class-slug>` | `main` + exactly one new or changed `classes/<id>.json` | that player (in their own Radicle namespace) |

Rules:
- **One class per file**, one class per player branch. Do not touch other files except
  `index.json` (regenerate it). New shared libraries go to `main` via the delegates.
- New classes pick a new `id` (`class_<slug>`, lowercase, `[a-z0-9_]`). Changing a built-in
  class keeps its `id`; the different sha256 makes it a distinct version. Built-ins travel by
  reference with a hard version gate: a game build pins each built-in (sha256 of the definition +
  its libraries); a player holding another version makes the other peers withhold their state
  hash — every peer of a game must ship the same `main`.
- Branch names are permanent once announced; pick the slug carefully.
- Never rewrite history on a branch other peers may have pinned (`commit` in their refs must stay reachable).
- Do not edit `tools/` on a player branch: `tools/pins.json` would no longer match and every
  peer rejects the check.

## How to propose a class

```bash
rad clone rad:<SKILLS_RID>             # or: git pull on an existing clone
cd chaosD6-Classes
git switch -c players/<your-nid-or-name>/<class-slug> main
$EDITOR classes/class_<slug>.json       # follow SCHEMA.md / HOOKS.md
node tools/check.mjs classes/class_<slug>.json   # schema + engine + validator, offline
node tools/manifest.mjs                # refresh index.json
node tools/manifest.mjs --check
git add classes/class_<slug>.json index.json
git commit -m "class_<slug>: <one line>"
git push rad players/<your-nid-or-name>/<class-slug>
rad patch open                         # optional: ask for it to be merged into main
```

Your branch is playable as soon as it is pushed: pick the class and your peers will fetch it by
ref. Merging into `main` (making it built-in) is the delegates' call, after `tools/check.mjs`
passes with the validator pinned in `validator/pin.json`.
