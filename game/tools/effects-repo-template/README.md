# chaosD6-Effects

The effects (and later skills) of chaosD6, defined as data. One effect per file:

**This repo is the source of truth** (since 2026-11-28). Edit the effects, hooks, libraries, oracles and docs
here. chaosD6 builds its game copy `game/effects-data/` from this repo (`node game/tools/defs-build.mjs effects`)
and pins the commit in `game/defs-pins.json`; never edit that copy — `defs-build.mjs --check` fails on it.
Publish with `bash game/tools/oci/defs-publish.sh effects` (a delegate, with the Radicle key in the agent).

```
effects/<id>.json      one definition; "id" inside == file name
hooks/<family>.json    peer-side effect hook programs (channel, trap, holdings, summon; schema
                       chaosd6.effect-hooks/1, run by chaosD6 game/effect-hooks.mjs); "id" == family == file name.
                       Changed by the delegates only; the game ships the same files as its built-in fallback
lib/<id>.json          libraries of sub-routines the effects `use` (std, e2a, e2b, e2c; schema chaosd6.effect-lib/1).
                       Changed by the delegates only. A ref pins each used lib by sha256 (ref.libs), so a peer
                       fetches lib/<id>.json at the ref's commit; commits without lib/ use the game's bundled libs
SCHEMA.md              the definition format (effect.schema.json: its structural JSON schema)
HANDSHAKE.md           how peers agree on the effect set and fetch a foreign effect
PROPOSAL_VOTES.md      votes on player-made effects / skills / classes
index.json             manifest: effects + hooks + libs, id -> sha256 of the canonical JSON (node tools/manifest.mjs)
validator/pin.json     which validator build checks this repo (commit + sha256 of the validator)
tools/manifest.mjs     manifest generator / checker (standalone, Node >= 18)
```

## Identity of an effect

An effect is identified by **sha256 of its canonical JSON** (object keys sorted, no whitespace,
arrays in order), not by its name or path. Peers in a game exchange refs:

```json
{ "repo": "rad:z…", "branch": "players/alice/frost-nova", "commit": "<40 hex>", "sha256": "<64 hex>", "id": "effect_frost_nova" }
```

A peer that lacks the effect fetches `effects/<id>.json` at `commit` from anyone (seed, peer,
local clone) and accepts it only if the sha256 matches. Reformatting a file does not change
its sha256; changing any value does — that is a new effect version.

## Branches

| branch | contents | who writes |
|---|---|---|
| `main` | the built-in effects the game ships with | the chaosD6 delegate(s) only |
| `players/<nid-or-name>/<effect-slug>` | `main` + exactly one new or changed `effects/<id>.json` | that player (in their own Radicle namespace) |

Rules:
- **One effect per file**, one effect per player branch. Do not touch other files except
  `index.json` (regenerate it).
- New effects pick a new `id` (`effect_<slug>`, lowercase, `[a-z0-9_]`). Changing a built-in
  effect keeps its `id`; the different sha256 makes it a distinct version.
- Branch names are permanent once announced; pick the slug carefully.
- Never rewrite history on a branch other peers may have pinned (`commit` in their refs must stay reachable).

## How to propose an effect

```bash
rad clone rad:<EFFECTS_RID>            # or: git pull on an existing clone
cd chaosD6-Effects
git switch -c players/<your-nid-or-name>/<effect-slug> main
$EDITOR effects/effect_<slug>.json     # follow SCHEMA.md
node tools/manifest.mjs                # refresh index.json
node tools/manifest.mjs --check
git add effects/effect_<slug>.json index.json
git commit -m "effect_<slug>: <one line>"
git push rad players/<your-nid-or-name>/<effect-slug>
rad patch open                         # optional: ask for it to be merged into main
```

Your branch is playable as soon as it is pushed: put the effect in your deck and your peers will
fetch it by ref. Merging into `main` (making it built-in) is the delegates' call, after the
validator pinned in `validator/pin.json` passes.
