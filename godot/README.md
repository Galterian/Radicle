# chaosD6 Dimensions — Godot 4 client

Isometric-hex RPG front end for chaosD6 that renders the game with the curated, free
Warlords Battlecry III assets described in `../data/*.json` (`resources` blocks) and
`../assets/frames.json`.

## Run (Linux / WSL2 Ubuntu)

One-time setup from `chaosD6/`:

```bash
./_tools/get_godot.sh                              # downloads Godot 4.3 Linux to _tools/godot (git-ignored, ~75 MB)
pip3 install --user -r tools/requirements.txt      # pillow + numpy for the asset tools
sudo apt install -y libpulse0                      # optional: enable WSLg sound (otherwise silent)
```

Then, from `chaosD6/godot/`:

```bash
../_tools/godot --headless --path . --import                                 # once: builds the class cache
../_tools/godot --path .                                                     # play
../_tools/godot --headless --path . -s tools/smoke_test.gd                   # data/assets/grids/A*/scene (14 checks)
../_tools/godot --path . -s tools/screenshot.gd ++ ../_tools/shot.png 120    # render 120 frames, save PNG
python3 ../tools/check_assets.py                                             # case-sensitive asset path audit
```

Assets load at runtime from `chaosD6/assets/...` (no Godot import step for art). If any
sheet is not in `assets/` the loader falls back to `../extracted/...` when present.
Run Godot from a shell (not a hook/script) so stdin is a real tty; otherwise close it
explicitly with `< /dev/null`.

## Controls

| Input | Action |
|---|---|
| `1`–`5` | pick a card from the hand (A Attack, B Block, M Move, P Posture, EP/EM Empty) |
| `8` | pick the Empty card |
| left-click hex | set the target / path for the chosen card |
| right-click | discard the chosen card once per round (redraws a random one) |
| `Space` | lock the intent (commit) — otherwise it locks when the 6 s planning timer ends |
| mouse wheel | zoom |
| middle-drag | pan (camera stops following) |
| `C` | recenter / follow your character |

## What is implemented

* `Hex.gd` / `MapGen.gd` / `Pathfinding.gd` — ports of `game/js/hex.js` and `game/js/map.js`:
  flat-top axial hexes (`HEX_SIZE 46`, `H_SQUASH 0.72`), FNV-1a `hash32`,
  `seedForDimension`, grow-only blocks (`rect:0,0,5x5`, `disc:q,r,R`), `terrainAt`
  (ash/cinder/basalt/ember), `needsReveal`, frontier, A* with blocked-goal fallback.
* `HexMap.gd` — draws known hexes using the hex-cut WBC3 tiles from
  `assets/terrain/terrain_tiles.json` (Caverns→ash, Rock→cinder, Dirt→basalt, Lava→ember),
  with the exact `map.js` colours as fallback, dashed frontier, hover, selection, reach tint
  and path preview.
* `SheetAnimator.gd` — builds `SpriteFrames` at runtime from a sheet (`AtlasTexture` cells):
  rows = 8 facings (N,NE,E,SE,S,SW,W,NW), cols = frames; grid from `assets/frames.json`,
  else detected from transparent cell boundaries, else `cols = round(w / (h/8·1.1))`.
* `Entity.gd` — `AnimatedSprite2D` with idle/walk/attack/death/fidget/cast states, facing
  from the move/attack vector, 1-hex slides, shadow, life pips, name, and WBC3 voice lines
  (`ready`, `select`, `order`, `deathblow`, `spell`) read from the entity's `resources.sounds`.
  Player colour: the extracted sheets keep WBC3's 15-step team ramp as pure green; the
  `shaders/team_recolor.gdshader` material tints it per faction (`Entity.team_color()`:
  player blue, npc red, ally green). The shader captures the modulate in `vertex()` because
  the fragment `COLOR` built-in is already texture × modulate.
* `Game.gd` — round loop *planning (6 s) → reveal → resolution* with `peer.mjs`
  semantics: move pass priority `A3 > M2 > EM1` with collision veto, EM = `min(3, max(1,
  round(d/2)))` steps, damage pass over the `battle_system.json` matrix (A>P>M>B>A),
  adversarial Empty (`EP→{A:P,P:M,M:EP,B:EP}`, `EM→{A:EM,P:EM,M:EM,B:M}`),
  `dmg = max(0, 1 + bonus)`, Block reflects 1, standoff detection; a simple NPC planner;
  map reveal around the player publishes a new block.
* `FxPlayer.gd` — plays `effects.json` strips (additive blend) and floating damage numbers.
* `DataLoader.gd` — loads `../data/*.json` in `index.json` order and resolves the active
  version exactly like `data.js pickActive`.
* `WavLoader.gd` — RIFF PCM → `AudioStreamWAV` (WBC3 speech is 22 kHz 16-bit mono).
* `NetBridge.gd` — commit/reveal/state/block signal stub, offline echo; swap in a
  WebSocket/libp2p transport to join Node peers.

## Default scene

Spawns `char_exuberant_firestroker` (Red Mage, you), `char_pride_guardian` (Knight
Champion, ally), `mon_ruinous_minotaur` (Minotaur) and `mon_ridge_runnet_3a` (Scorpionman)
on dimension `Ashfall-Micro`. Any id in `characters.json` / `creatures.json` can be spawned
via `Game.spawn(id, kind, faction, Vector2i(q, r))`.
