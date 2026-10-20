# ChaosD6 Dimensions — Ashfall Micro

A simple real-time 2D isometric prototype that drops **one hero** into a **5×5 hex Dimension** alongside an **NPC ally**, facing **two creature opponents** on their own alliance. Session artefacts are written in the Radicle layout defined by `data/dimension_session.json`, and every action goes through a `commit → reveal → resolve` cycle whose envelopes match `data/sync_protocol.json` and `data/hashgraph_events.json`.

## Run

```
cd game
node server.mjs
```

Open http://127.0.0.1:7357

Requires Node ≥ 18 (uses `node:fs/promises` and native `fetch` is not needed on the server side).

## What it does

- Loads every collection listed in `data/index.json`, picks the active version per entry (highest-weight non-rejected `VersionedEntry`).
- Opens Dimension **`Ashfall-Micro`** under `game/sessions/Ashfall-Micro/`:
  - `dimension.json` — the `session_dimension_descriptor` shape
  - `doors/<DoorId>.json` — the `session_door` shape
  - `rules_snapshot_commit` — hash of the frozen rules view
  - `hashgraph.jsonl` — append-only tape of signed envelopes (`evt_genesis`, `evt_join`, `evt_action_commit`, `evt_action_reveal`, `evt_state_hash`, `evt_turn_commit`)
- Spawns four participants (shapes from the data layer):
  - **You** — `char_exuberant_firestroker` at (1,2)
  - **Ally** — `char_pride_guardian` at (0,3)
  - **Foe 1** — `mon_ruinous_minotaur` at (3,1)
  - **Foe 2** — `mon_ridge_runnet_3a` at (3,3)
- Builds a 15–20 card MMORPG deck for each (`mode_mmorpg.min/max_deck`), draws up to 5.
- Phase loop: `planning` (10s / 6s combat-heartbeat when any pair is adjacent, per the libp2p+GunDB spec) → `reveal` (5s) → `resolution` (5s) → `cleanup` → repeat.
- Resolution runs the deterministic resolver using the `resolution_matrix.edges` straight out of `battle_system.json`, honouring Rule 6 adversarial interpretation of Empty cards.
- NPCs plan their actions with the weighted-priority matrix from `chaosD6_PC_game_phase2.txt` (`HEALTH_CRITICAL / PROXIMITY_CLOSE / PROXIMITY_FAR`).
- Game ends when one alliance is eliminated.

## Controls

| input | effect |
| --- | --- |
| `1` – `5` | queue / unqueue the hand slot into the action buffer |
| `right-click` on a slot | toggle `will_discard` (opacity filter) |
| `8` | queue Empty Posture |
| `9` | queue Empty Move (declared openly during commit) |
| click a hex | pick target (entity or tile) |
| `space` | lock the commit early |

If you do nothing before the planning timer expires, the engine defaults you to `Empty Posture` (hotkey 8 fallback, per `action_empty_posture`).

## File map

```
game/
  server.mjs              dev server + Radicle write-shim
  index.html              page shell (canvas + deck bar + log)
  css/style.css
  js/
    main.js               boot, UI wiring, HUD, roster
    data.js               /data layer loader + active-version picker
    hex.js                flat-top hex math (iso projection)
    renderer.js           canvas 2D isometric drawer
    entities.js           Hero/Creature factories (life = round_half_up(Σstats/10))
    deck.js               15–20 card deck builder, drawHandUpTo
    ai.js                 weighted-priority NPC planner
    combat.js             deterministic resolver using battle_system edges
    phases.js             commit/reveal/resolve/cleanup FSM
    hashgraph.js          envelope builder + append tape
    radicle.js            thin fetch wrappers to the write-shim
    sha.js                sha256 / salt helpers
  sessions/               (runtime output — Radicle-shaped artefacts)
```

## What's intentionally simplified

- Hex grid uses **6-neighbour adjacency**; the paper's 8-neighbour rule assumes a square grid. The user requested "hex", so hex it is — a `contradictions.json` entry can be added later.
- Signatures are stubbed (`sig:<peer>:stub`) — the envelope shape is real, so swapping in real Radicle signing is a drop-in.
- Only one action per entity per round is resolved; `actions_per_round` from the data layer is loaded but not yet chained.
- Effects / skills / terrain items / point-buy are loaded but not yet wired to the resolver.
- Radicle "push" is a local disk write; the lottery, Firebase coordinator, and inter-peer gossip are not simulated — but every artefact the prototype writes matches the real session shape, so you can commit `game/sessions/Ashfall-Micro/` to Radicle verbatim.
