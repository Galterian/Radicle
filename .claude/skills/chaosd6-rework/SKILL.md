---
name: chaosd6-rework
description: Guide for extending the chaosD6 dual-runtime hex strategy game (browser JS + Godot). Trigger whenever a task adds, parity-checks, or reworks map features, biomes, HUD, catalogs, assets, or rules text across the two runtimes. Load BEFORE editing anything under game/js, godot/scripts, assets/*/_table.json, data/skills.json, or tools/*.py. The skill encodes the deterministic (seed, q, r) contract, the JSON-catalog source-of-truth pattern, the browser-first-then-Godot-parity order, the image-cache ordering rule, and the WSL-based verification workflow.
---

# chaosD6 Rework Skill

Load this when the task touches the dual-runtime game. Everything below is specific to this repo — do not generalize patterns to other projects.

## The one invariant

Everything that places something on a hex is a pure function of `(dim_seed, q, r)`. The browser and Godot runtimes MUST produce bit-for-bit identical placements for the same seed. If a change breaks that, it is wrong — not an optimization opportunity, not a known-divergence.

The hash that both runtimes agree on:

- JS: `hash32("${seed}:${salt}:${q}:${r}") / 4294967296` (see `game/js/map.js#hash32`, `game/js/features.js#roll01`)
- Godot: same FNV-1a over the identical string, same divisor (see `godot/scripts/Features.gd` `_roll01` / `roll01`)

The max-score picker (used by features, bigfeatures, scatter) is:
```
for i in 0..choices.length-1:
  score = roll01(seed, q, r, "p" + i) * choices[i].weight
pick = argmax(score)
```
Never `hash % n` — the weighted-max picker gives much better spatial variety and both runtimes must use it.

## Runtime layout

**Browser (primary)** — `game/js/`:
- `main.js` — bootstrap, state, hover/inspect cards, reveal animation
- `renderer.js` — canvas painter, tile cache keyed on `(mapVersion, seed, catalogEpoch)`
- `biome.js` — noise channels (ridge/lake/forest/etc.), biome resolution per hex
- `features.js` — buildings/walls/bridges/towers (`feature_table.json`)
- `bigfeature.js` — multi-hex landmarks (`bigfeature_table.json`)
- `scatter.js` — tiny per-hex decorations (`scatter_table.json`)
- `sprites.js` — asset URL + sprite-sheet indexing (`frames.json`), `resourcesFor(sourceId)`
- `rules_text.js` — card text, `KIND_DESC` fallbacks, `abbreviate()`
- `ui-server.mjs` — static server on :7358 that `decodeURIComponent`s the path once

**Godot (parity mirror)** — `godot/scripts/`:
- `Biome.gd`, `BigFeature.gd`, `Features.gd` — mirror the JS placers one-for-one
- `RulesText.gd` — strings copied VERBATIM from `rules_text.js` (icons→words since the Godot default font has no emoji)
- `Hud.gd`, `Game.gd` — HUD + game loop

**Shared source-of-truth catalogs**:
- `assets/features/feature_table.json` — buildings/walls/bridges per biome
- `assets/terrain_bigfeatures/bigfeature_table.json` — large landmarks
- `assets/terrain_scatter/scatter_table.json` — tiny decorations
- `data/skills.json` — skill cards (effect strip paths, fx sound paths)
- `assets/frames.json` — sprite-sheet dimensions, anchors, animations
- `assets/asset_index.json` — asset discovery index

Both runtimes `fetch`/`read_json` the same files. If you add a field, both must handle it.

## Order of operations for ANY feature touch

1. **Browser first**. Edit `game/js/*.js` and the relevant JSON catalog. Verify with `node --check` and a running ui-server.
2. **Godot parity last**. Mirror the behavior in `godot/scripts/*.gd`. Run the parity checker if one exists (`godot/tools/biome_counts.gd`, `godot/tools/hud_check.gd`).
3. **Never Godot-first**. The browser is where fast iteration happens; Godot catches up.

For `KIND_DESC` and other parity-locked tables: when you add a kind in `game/js/rules_text.js`, add the EXACT same string in `godot/scripts/RulesText.gd`. Example (bridges, added 2026-10-26):

```js
// game/js/rules_text.js
bridge: 'A span over water or ravine. The only legal crossing on this stretch of shore — chokepoint for both sides.',
```
```gdscript
# godot/scripts/RulesText.gd
"bridge": "A span over water or ravine. The only legal crossing on this stretch of shore — chokepoint for both sides.",
```

## Catalog editing rules

### feature_table.json entry shape
```json
{
  "id": "Faction/Name",          // stable key, "<faction>/<label>"
  "label": "Human Name",         // what the inspect card shows
  "weight": 2,                   // max-score picker weight
  "path": "assets/Sprites/Buildings/.../base [CODE].png",
  "kind": "building",            // building | wall | bridge | tower | mine | temple
  "desc": "What it does in game terms.",
  "desc_status": "placeholder"   // optional; marks text not yet rule-backed
}
```

- `path` is relative to repo root, forward-slashed. The runtime URL-encodes each segment, so spaces and `[]` in filenames are fine.
- `kind: "bridge"` is a tagged alias — WBC3 has no actual bridge sprites, so re-use Archway (`Empire/Archway/Archway - base [BPAC].png`) or Kargothian Gate (`Dark Elves/Kargothian Gate/Kargothian Gate - base [BAAG].png`). Place on `grass_coast`, `snow_coast`, `rock_coast`, `marsh` only.
- `_density_scaled: true` at the top of `feature_table.json` means density has been multiplied (last pass was ×1.6). Do not scale again.
- Non-walkable biomes (`mountains`, `water`, `lava`, `rock_cliffs`, `desert_cliffs`) must have `density: 0` and an empty `by_biome` list.

### Adding a new kind
If you introduce a brand-new `kind:` value anywhere (new mechanic — portal, altar, etc.):
1. Add it to `KIND_DESC` in `rules_text.js` AND `RulesText.gd` (both strings identical).
2. If the renderer should treat it specially (different z-order, special draw), update `renderer.js` AND the matching `*Layer.gd`.
3. Grep both runtimes for the old kinds table to spot anywhere a switch/match is missing a case.

## Image-cache ordering rule (burned once — do not repeat)

`features.js`, `bigfeature.js`, and `scatter.js` all cache textures in a module-level `_imgs: Map<path, {img, ready, failed}>`. **Store in the map before assigning `img.src`**, otherwise a browser-cache hit that fires `onload` synchronously will call `notify()` → listener → `featureImage(path)` and build a second `Image()`, orphaning the one that actually loaded.

Correct shape:
```js
export function featureImage(path) {
  if (!path) return null;
  let t = _imgs.get(path);
  if (!t) {
    t = { img: new Image(), ready: false, failed: false };
    _imgs.set(path, t);                                 // ← BEFORE src
    const url = '/' + String(path).replace(/\\/g, '/')
      .split('/').map(encodeURIComponent).join('/');
    t.img.onload = () => { t.ready = true; notify(); };
    t.img.onerror = () => { t.failed = true; console.warn('[features] image failed to load:', url); };
    t.img.src = url;
  }
  return t.ready ? t : null;
}
```

The `console.warn` in `onerror` is deliberate — the next person to debug a missing sprite needs the URL in devtools, not just a silent skip.

## URL encoding (do not get this wrong)

Paths in catalogs look like `assets/Sprites/Buildings/Daemons/Gallows/Gallows - base [BPGA].png`. The browser-side encoder is ALWAYS:

```js
'/' + String(path).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
```

- Split-then-encode-then-join preserves `/` and encodes each segment (spaces → `%20`, `[` → `%5B`, `]` → `%5D`).
- `encodeURIComponent(path)` applied to the WHOLE string encodes `/` too — this breaks the URL. Do not do that.
- The server does `decodeURIComponent(url.pathname)` once, then `path.resolve(ASSETS_DIR, '.' + rel.replace(/\.\./g, ''))`. Case-sensitive on WSL.

## Dev-host workflow (WSL-only)

`game/tools/dev-host.sh` uses `ps -eo` which git-bash on Windows does NOT support. From the Windows side, invoke it through WSL:

```bash
wsl.exe -d Ubuntu -- bash -lc "cd /home/galt/chaosd6_mapper/chaosD6 && bash game/tools/dev-host.sh"
```

For a standalone ui-server without the whole peer stack (handy for curl'ing an asset):
```bash
wsl.exe -d Ubuntu -- bash -lc "cd /home/galt/chaosd6_mapper/chaosD6/game && (setsid nohup bash -c 'UI_PORT=7358 node ui-server.mjs' > /tmp/ui-7358.log 2>&1 < /dev/null &); sleep 2; cat /tmp/ui-7358.log"
```

Then from Windows (`curl.exe` works since WSL port-forwards 127.0.0.1):
```bash
curl.exe -sS -o /dev/null -w "HTTP %{http_code}\n" "http://127.0.0.1:7358/assets/..."
```

Stop with:
```bash
wsl.exe -d Ubuntu -- bash -lc "pkill -f 'node ui-server.mjs'"
```

Ports used:
- `:7357` — launcher (REST API for creating peers)
- `:7358` — UI/static server (serves `/assets/`, `/data/`, `/js/`, `/css/`, `/`)
- `:7401+` — individual peer sockets (set by launcher)
- `:17xxx` — WSL-proxy forwards so a Windows browser can reach WSL peers

## Verification before claiming done

Run these in parallel where possible:

1. **JS syntax**: `cd game && node --check js/<file>.js`
2. **JSON validity**: `python3 -c "import json; json.load(open('<path>.json'))"`
3. **Live asset serve**: start the standalone ui-server above, curl new paths, expect HTTP 200.
4. **Browser smoke test**: open `http://localhost:7358/?peer=1<port>` (port printed by dev-host.sh) in a real browser; check devtools console for the new `[features/bigfeature/scatter] image failed to load` warnings — if any fire, a path in a catalog is wrong.
5. **Godot parity check** (if touching biome/feature placers):
   - `godot --headless -s godot/tools/biome_counts.gd` — compares JS and GD biome counts per hex over a fixed seed; 0 divergences expected.
   - `godot --headless -s godot/tools/hud_check.gd` — HUD/inspect-card parity.
6. **Overview capture** for visual regressions: `bash _tools/run_overviews.sh` writes PNGs to `_tools/`.

**If you can't test the UI, say so explicitly** rather than claiming success. `node --check` and `json.load` are correctness, not feature verification.

## Fan-out agent pattern (for the big reworks)

When a user's ask spans disjoint files (e.g. "add richer maps + clickable object card + Godot HUD parity"), launch 2–3 parallel subagents in a single message, each scoped to a dimension and told which files are OFF-LIMITS to avoid merge conflicts:

- **Map richness** — owns `biome.js`, `Biome.gd`, feature/bigfeature catalogs, `renderer.js` draw passes
- **Browser UI** — owns `main.js`, `index.html`, `style.css`, `rules_text.js`
- **Godot HUD** — owns `Hud.gd`, `Game.gd`, `RulesText.gd`, tools under `godot/tools/`

Each agent must return a verification report (JS parse clean, parity checker 0 failures, screenshots). Hold the merge until all three return.

## Deterministic placement — common salts

Keep salt strings stable; both runtimes agree:
- `"f"` — feature density roll
- `"p<i>"` — feature max-score picker, index i
- `"v"` — terrain variant per hex
- `"j"` — feature draw jitter
- `"bj"` — bigfeature draw jitter
- `"sj"` — scatter draw jitter
- `"ridge"`, `"lake"`, `"forest"` — biome noise channels

If you add a new salt, add it to BOTH `game/js/*.js` and `godot/scripts/*.gd` in the same commit.

## WBC3 asset gotchas

- Not everything exists. Before promising a feature, grep `assets/asset_index.json` and `assets/Sprites/Buildings/*/`. Example: WBC3 has no bridge sprites — the "bridges" ask was fulfilled by re-tagging existing stone-arch sprites (`Archway`, `Kargothian Gate`) as `kind: "bridge"` on coast/marsh biomes.
- Buildings may be sprite-sheets (multiple frames side-by-side), not single images. `frames.json` records `cols`/`rows`. The feature renderer currently treats them as single images at full `naturalWidth` — if you add a feature with cols>1 and it looks stretched, slice via `frames.json`.
- Each building has three variants: `base [CODE].png`, `construction [CODEz].png`, `info [CODEi].png`. Always use `base` for placement; `info` is for the inspect card thumbnail (see `assetUrl` in `sprites.js`).
- Faction codes in filenames: `BP*` = buildings, `BA*` = archways/gates, `BK*` = keeps, `BW*` = walls/towers, `BR*` = resources (mines), `BM*` = shrines/misc.

## Commit style (observed on this branch)

- Imperative lead line, scope prefix: `feat(map): ...`, `fix(renderer): ...`, `chore(parity): ...`
- Bullet details below explaining WHY and WHAT, not HOW.
- Attribution:
  ```
  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  ```
- Branch convention: feature work lives on `feature/godot` or `feature/godot-use` (both have been in play — check `git branch --show-current` before pushing).

## Pitfalls caught historically

- **Sync-cache image race** (fixed 2026-10-26 in `features.js`/`bigfeature.js`/`scatter.js`): see "Image-cache ordering rule" above.
- **Density scaled twice** — the `_density_scaled: true` sentinel exists to prevent this. Honor it.
- **CRLF warnings** on commit are harmless; git auto-converts. Don't try to "fix" them.
- **Running dev-host.sh from Windows git-bash** silently fails on `ps -eo`. Always via `wsl.exe`.
- **Reaped background shells** — if a long background job gets killed with "system running low on memory," check `git log` to see if its work already landed before worrying about rerunning it.
- **Agent reports a bug but can't repro from this harness** — note it, add diagnostic logging (`console.warn` in error paths), ship a defensive fix, and let the next run surface the real cause with the diagnostic signal.

## File inventory (quick reference)

```
assets/
  features/feature_table.json            buildings/walls/bridges/towers per biome
  terrain_bigfeatures/bigfeature_table.json  multi-hex landmarks
  terrain_scatter/scatter_table.json     tiny per-hex decorations
  frames.json                            sprite-sheet metadata (cols, rows, anchor)
  asset_index.json                       flat index of every asset path
  Sprites/Buildings/<faction>/<name>/*.png   base/construction/info variants
data/
  skills.json                            skill cards + effect strips + fx sounds
game/
  index.html style.css                   bootstrap + UI
  ui-server.mjs                          static server (:7358)
  start-all.mjs peer.mjs                 launcher + peer processes
  tools/dev-host.sh                      WSL-only full-stack launcher
  js/
    main.js renderer.js biome.js         bootstrap, canvas, biome resolver
    features.js bigfeature.js scatter.js JSON-driven placers (lazy load, notify)
    sprites.js rules_text.js             asset URL + card text
    map.js hex.js                        hash + hex math
godot/
  scripts/
    Biome.gd BigFeature.gd Features.gd   parity mirrors of the JS placers
    RulesText.gd                         verbatim copy of rules_text.js strings
    Hud.gd Game.gd                       HUD + game loop
  tools/
    biome_counts.gd hud_check.gd         parity checkers
    overview.gd                          offscreen render → PNG
tools/
  import_bigfeatures.py expand_features.py  Python helpers to build catalogs
_tools/
  run_overviews.sh                       capture overview PNGs
  overview.gd                            Godot overview capture
```

## When this skill does NOT apply

- The user is working on a different checkout (`XCR Explorer`, `chaosd6_mapper` without the Godot subtree, etc.).
- The task is purely docs / git ops / CI with no runtime code touched.
- The task is in `data/` only (skill stat tuning) and does NOT add new kinds, salts, or catalog fields.
