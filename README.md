# chaosD6 — Dimensions, a fully decentralized tactical RPG

> One repository, three roles: the **living rulebook** (`data/`), the **P2P contract** that says how players agree on what happened, and the **runtime** (`game/`) that plays a Dimension with no host, no server and no central authority. Radicle is the public directory, a public Nostr relay set is the always-on bus, libp2p and GunDB are the fast lanes between peers that can reach each other.

An interactive, colored version of this document is in [`architecture.html`](architecture.html).

---

## 1. The idea in one picture

```
                 ┌──────────────────────────────────────────────────────────────┐
                 │  RADICLE  rad:zqZmP6itceBMqYwi1K1n8phQqCaj  (public seeds)   │
                 │  main / develop / proposals/* / forks/*   ← rules governance  │
                 │  ActiveDimensions/<Dimension>/            ← live sessions     │
                 │      dimension.json                                           │
                 │      doors/<peer>.json   one Door per peer, in the peer's     │
                 │                          OWN namespace  rad://RID/<NID>       │
                 └───────────▲──────────────────────────────────▲────────────────┘
          push every 60 s   │                                  │  rad sync --fetch
          (every peer)      │                                  │  list every namespace
                 ┌──────────┴───────────┐            ┌─────────┴────────────┐
                 │  peer  "You"         │            │  peer on another box │
                 │  libp2p gossipsub ◄──┼── LAN ─────┼─►  libp2p gossipsub  │
                 │  GunDB relay      ◄──┼── graph ───┼─►  GunDB relay       │
                 │  Nostr bus        ◄──┼─ relays ───┼─►  Nostr bus         │
                 └──────────┬───────────┘  kind 29517 └──────────────────────┘
                            │ ws
                 ┌──────────┴───────────┐
                 │  browser  (thin)     │  canvas, deck bar, hex map, log
                 └──────────────────────┘
```

**Rule of the design:** every player holds a *Door* into the Dimension, which is their piece of the puzzle. Doors that have met on the map overlap and agree. There is no host, no lobby server, no Firebase in the running code (the design paper lists Firebase as an optional directory; the implementation replaced it with Doors on Radicle plus the Nostr bus).

---

## 2. Repository layout

| Path | Role |
|---|---|
| `DimentionsEN.docx.html`, `dim_text.txt`, `dim_paras.txt` | The paper rules ("Dimensions" tabletop RPG) and its text extractions. |
| `data/*.json` | **Living rulebook**: 18 versioned collections (concept, stats, elements, 26 rules, battle system, actions, 66 effects, skills, 33 classes, 12 characters, 29 creatures, 41 terrain items, 9 game modes, 6 contradictions) plus the machine-readable P2P contract (`sync_protocol`, `hashgraph_events`, `dimension_session`, `governance`). `index.json` gives the engine load order. |
| `data/examples/ActiveDimensions/Ashfall-Reach/` | Hand-written example of a published Dimension: `dimension.json`, two Doors, `rules_snapshot_commit`. |
| `bundle.py`, `dimensions-bundle.json` | Packs every `data/*.json` into one bundle (schema 0.2.0, load order from `index.json`). |
| `editor.html` | "Dimensions — Living Rulebook": browser for the bundle with version weights, proposals and rebalance views. |
| `chaosD6_request_phase1_extract_jsons_2.txt`, `request_*.txt` | The design brief this architecture implements (tiered sync, Door magnet protocol, git-fork metagame, 6 s / 10 s pacing). |
| `game/` | The runtime: Node peers, launcher, UI server, Radicle adapter, Nostr bus, browser client. |
| `game/tools/` | Dev tooling: two-launcher restart, second Radicle identity, Nostr relay probe, join probe. |
| `*.sh` at root | Radicle diagnostics and wait-for-push helpers used during development. |

---

## 3. Layer A — the living rulebook (`data/`)

Every entry in every collection is a `VersionedEntry`:

```
{ id, name, tags, versions: [ { version, weight, status, origin, author_peer_id,
                                created_at, parent_version, rebalance_links,
                                vote_log, notes, data } ] }
```

* The engine loads collections in `index.json` order and, per entry, resolves the **highest-weight non-rejected version**. That view is frozen for a Dimension session and recorded as `rules_snapshot_commit`.
* Statuses: `proposal → canonical | rejected`, previous canonical becomes `superseded` (kept as fallback with weight minus 0.01).
* Write policy per collection (`governance_write_permissions`): `vote-driven` for almost everything, `paper-only` for stats and elements (0.9 threshold, 25 voters), `rebalance-only` for the concept text, `resolution-vote` for the six recorded contradictions in the paper.

The game model itself: four pillars (vitality, world, matter, will; playable races sum to 40), ten elements, actions `A B M P` plus `EP EM` (Empty Posture / Empty Move), a rock-paper-scissors resolution cycle `attack > posture > move > block > attack` with Rule 6 adversarial reading of empty cards, 3 actions per round, hand of 5, decks of 15 to 20 cards in `mode_mmorpg`, lateral progression (no levels).

## 4. Layer B — governance, the git-fork metagame

Defined in `data/governance.json`, not yet automated in code:

| Branch | Content | Who writes |
|---|---|---|
| `main` | released `data/` that clients load | release script, weekly tag `data-vX.Y.Z` |
| `develop` | accepted proposals | tally script (hourly) |
| `proposals/<entry>-<ts>` | one new version object | proposer, rebalance script, vote log |
| `forks/<name>` | a group's divergent rule tree | fork owners; may merge back as one big proposal |
| `ActiveDimensions/<Name>` | live session artefacts | peers (see Layer C) |

Votes are `evt_vote` events gossiped in-game. Weight is `0.01 · (1 + log2(1 + times_used)) · (1 + 0.1 · dimensions_played)`, capped 0.10 per peer, so people who actually play with an effect decide its fate. Acceptance needs weight ≥ 0.6, quorum 7, and the rebalance script's power score within 15 %. Nothing in `game/` emits `evt_vote` yet; the editor exposes weights and proposals read-only.

## 5. Layer C — Dimensions on Radicle (the eventual rendezvous)

**Branch** `ActiveDimensions/<DimensionName>` on RID `rad:zqZmP6itceBMqYwi1K1n8phQqCaj`. Each peer pushes to **its own namespace** `rad://<RID>/<own NID>`, so Door files from different peers never conflict and the public seeds (`rosa.radicle.network`, `iris`, …) replicate every namespace. Anyone who runs `rad clone … --scope all` sees every Door anyone has published.

**Files written by every peer** (`game/radicle-adapter.mjs`, `peer.mjs`):

* `dimension.json` — id, name, repo, branch, `game_mode: mode_mmorpg`, `tileset {initial_size 5x5, axial q,r, bounds, map_seed, reveal_radius, tiles_known, extended_blocks[]}`, `clock {rounds_per_turn 3, round_seconds 6}`, join hint.
* `doors/<peer-label>.json` — **Door v2**: `peer_id`, entity (character or creature, alliance, tile, life), `hashgraph_head`, `clock {turn, round, action, phase, phase_ends_at}`, `known_members[]`, `known_tiles[]`, `map {seed, blocks[]}`, and `network {nostr {relays, pubkey, kind 29517, tag}, libp2p {multiaddrs, topic, bootstrap}, gun {url, relays}}`.
* Legacy host-era `doors/door-primary.json` and `rules_snapshot_commit` are pruned on push.

**Cadence.** First push after a 5 to 15 s stagger, then every `RADICLE_PUSH_SEC` (default 60 s, demo value; the paper says one hour with a lottery pusher). A Door newer than 3 minutes (`DOOR_LIVE_MS`) counts as "live" in the join list.

**Reading.** `listPublishedDimensions()` runs `rad sync --fetch`, then `git for-each-ref refs/namespaces/*/refs/heads/ActiveDimensions/*` directly in `~/.radicle/storage/<rid>`, groups Doors by dimension name and sorts by newest push. Log lines print the public explorer URLs (`https://radicle.network/nodes/rosa.radicle.network/rad%3A…/commits/<sha>` and `/tree/<sha>/ActiveDimensions/<dim>`), never the loopback ones.

## 6. Layer D — the live mesh (three transports, one envelope)

| Transport | What it is | What travels on it |
|---|---|---|
| **libp2p gossipsub** | TCP + noise + yamux, `@libp2p/gossipsub` 17, one topic `/chaos/<dim-id>/strong`. No mDNS, no DHT, no relay. Bootstrap addresses come from Doors and peer snapshots. | Every hashgraph envelope. Works when peers can dial each other (same LAN). |
| **GunDB** | Each peer runs its own memory-only relay (`radisk:false`); peers list each other's `/gun` URL. Graph root `chaosd6/dimensions/<dim-id>`. | `doors/<door>/members/<peer>` state snapshots, `doors/<door>/hashgraph/<hash>` envelope mirror (write-only), `map/blocks/<id>` map blocks (re-put every 60 s). |
| **Nostr bus** (`game/nostr-bus.mjs`) | NIP-01 over WSS to public relays, ephemeral kind **29517**, tag `d = chaosd6:<dim-id>`, 30 s lookback, 300 s expiration, dedupe ring of 4000. Default relays: relay.primal.net, relay.snort.social, relay.nostr.net. | Only `evt_action_commit`, `evt_action_reveal`, `evt_map_extend` and a `state` snapshot heartbeat every 15 s. Measured round trip 60 to 160 ms through WSL and a corporate proxy. This is the path that is always there. |
| **discovery.mjs** (opt-in, `WITH_DISCOVERY=1`) | In-memory Express mirror, the former "Firebase stub". | register / state / commit / reveal mirrors on a LAN. Nothing depends on it. |

**Envelope** (shape from `data/sync_protocol.json`):

```
{ type, dimension_id, door_id, turn, round, action_index, actor_peer_id,
  self_parent, other_parent, payload, timestamp, signature, state, _hash }
```

`_hash = sha256(envelope without _hash)`; `self_parent` is the actor's previous hash, `other_parent` the last hash received from anyone. Every envelope piggybacks the sender's `state` snapshot so one message both advances the hashgraph and refreshes presence. Signatures are still the stub `sig:<peer>:stub`.

**Routing matrix**

| Event | gossipsub | Nostr | Gun | `sessions/<dim>/hashgraph.jsonl` |
|---|:-:|:-:|:-:|:-:|
| `evt_genesis`, `evt_join`, `evt_state_hash`, `evt_turn_commit`, `evt_radicle_push` | ● | – | ● | ● |
| `evt_action_commit`, `evt_action_reveal`, `evt_map_extend` | ● | ● | ● | ● |
| state snapshot | in every envelope | every 15 s | `members/` | – |

## 7. Layer E — the round engine (`game/peer.mjs`)

All simulation runs in the Node peer, one process per entity. The browser is a thin client.

```
 ROUND_SEC = 6            ROUNDS_PER_TURN = 3           hand = 5
 ┌─────────────── planning ───────────────┐┌ reveal ┐┌ resolution ┐
 │ pick card / target, NPC npcPlan()      ││ ≤0.8 s ││  ≤1.5 s    │ → endRound → (×3) endTurn
 │ deadline trails slowest same-action peer││commit  ││ reveal     │
 └────────────────────────────────────────┘└────────┘└────────────┘
```

1. **Commit** — `commitment = sha256(code :: targetTag :: salt)`, `empty_move_announced` when the code is `EM` (Rule 6 says Empty Move is declared openly).
2. **Reveal** — `{action, effects, skills, target, salt}`. Reveal and resolution windows close early once every expected member (alive, seen in the last 20 s) has answered. A silent peer is treated as Empty Posture, exactly the paper's failure mode.
3. **Resolve** — deterministic, identical on every peer: movement first (A > M > EM priority, ties block, occupied tiles veto), then damage from `battle_system.resolution_matrix.edges` with adversarial reinterpretation of `EP`/`EM`, Block reflecting 1 to each attacker. Each peer applies only its own tile and life, then emits `evt_state_hash` over the sorted `[{id, tile, life}]` view.
4. **Turn end** — characters discard marked cards, draw to 5, reshuffle when empty; monsters never discard. `evt_turn_commit` carries positions, draws and the hashgraph head.

**Clock agreement without a leader.** `catchUpClock` runs every tick: if any peer is ahead in `action = turn·3 + round`, jump to it and forfeit the skipped picks as Empty Posture, unless exactly one behind mid-handshake. A joiner listens on the bus for a few seconds (`JOIN_SYNC_WAIT_MS`), adopts the most advanced clock and sits out the current action. When one side is eliminated the Dimension enters a **standoff** that keeps ticking so late joiners can resume the fight.

## 8. Layer F — the map (new, in progress)

`game/js/map.js` replaces the fixed 5×5 grid with a **grow-only set of revealed hexes**:

* Blocks: `rect:0,0,5x5` at genesis plus `disc:q,r,radius` discs. Each has a stable id, so adding the same block twice is a no-op and transport order never matters.
* Every *player* peer reveals a disc of `REVEAL_RADIUS` (default 10) around itself at spawn and after each move when it is close to the frontier.
* A block travels three ways at once: Gun `map/blocks`, an `evt_map_extend` envelope over gossipsub and the Nostr bus, and the `map.blocks` list in the peer's Door. Joiners union all Doors' blocks before placement (`nearby` = free hex next to the anchor, `random` = free hex more than 2 tiles from every living member).
* Terrain (`ash | cinder | basalt | ember`) is derived from `seedForDimension(dim_id)` so all peers draw identical ground without exchanging it. `hex.js` now takes a `known(q, r)` predicate for pathing and picking; A* is capped at 20 000 expansions.

This mirrors the paper's `evt_map_extend` / `extended_blocks` idea (joining at a stale Door grows the world from the root seed).

## 9. Layer G — processes and the browser

| Process | File | Port (default) |
|---|---|---|
| launcher | `game/start-all.mjs` | spawns the others; `--list` prints every Door on Radicle |
| UI server / launcher API | `game/ui-server.mjs` | HTTP 7357 (`/api/network`, `/api/dimensions`, `/api/live/:dim`, `/api/launch`, `/r/<alias>/…` explorer redirects) |
| peer (one per entity) | `game/peer.mjs` | libp2p 7400+, UI HTTP+WS 7401+, Gun 7501+ |
| CLI joiner | `game/join.mjs` | `--list`, `--dimension <name> --placement nearby|random --as <label>`, `--start <name>` |
| LAN mirror (opt-in) | `game/discovery.mjs` | 7350 |

A hosted Dimension spawns four peers: `player-1` (you, `char_exuberant_firestroker`), `ally-1` (`npc_a`, `char_pride_guardian`), `foe-1` and `foe-2` (`npc_b`, `mon_ruinous_minotaur`, `mon_ridge_runnet_3a`). Sides collapse to A = {player, npc_a} and B = {npc_b}.

**Browser** (`game/index.html`, `js/launcher.js`, `js/main.js`, `js/renderer.js`) connects over WebSocket to one peer. Inbound kinds: `hello, map, phase, hand, peers, evt, contact, standoff, radicle`. Outbound: `queue, target, lock, discard, uilog`. Keys `1`–`5` queue a hand slot, `8` the Empty slot (EP, or EM when a tile is targeted), `Space` locks. Right-click toggles discard on a slot, or sets an attack / journey on the map; journeys are A* paths resumed each planning phase. The canvas draws seeded terrain, a dashed fog frontier, alliance-colored entities with health pips, floating action emoji and damage, with a 7.5 s slide per move and a 1.5 s snap window after cold sync.

## 10. Design brief vs. what runs today

| Brief / `data/sync_protocol.json` | Status | In the code |
|---|---|---|
| Doors published to `ActiveDimensions/<Name>/doors/` on Radicle | ✅ | per-peer Door v2 in own namespace, 60 s |
| Commit → reveal → state-hash handshake, chained envelopes | ✅ | `peer.mjs`, salt + sha256, self/other parent |
| Silent peer = Empty Posture; laggards jump to max turn | ✅ | reveal/resolution caps, `catchUpClock` |
| Join near friend / at random place, adopt live clock | ✅ | `ui-server.mjs placeFromDoors`, `syncClockFromMesh` |
| `evt_map_extend` + seeded map blocks | ✅ (uncommitted) | `js/map.js`, Gun + bus + Door |
| Public bus that crosses NAT with nothing to host | ✅ | Nostr kind 29517 on 3 relays |
| 6 s combat heartbeat / 10 s out-of-combat planning | ◐ | fixed `ROUND_SEC=6`; "heartbeat" is a HUD flag for adjacency ≤ 1 |
| Strong (2-tile) / reachable / far region tiers, promotion | ◐ | one gossip topic for the whole Dimension; radius 2 used only for random placement |
| Hourly push by lottery pusher, 5-min poll | ◐ | `electPusher` exists but unused; every peer pushes every 60 s; only the launcher polls |
| Firebase directory | ✗ by design | replaced by Doors + bus; `discovery.mjs` is a LAN stub |
| Commitment verified against reveal; state-hash comparison; `sync_divergence_merge`, `evt_merge` | ✗ | hashes emitted, never compared |
| Real signatures / stable peer identity | ✗ | `sig:<peer>:stub`; libp2p and Nostr keys ephemeral per process; identity = label |
| `evt_vote`, `evt_leave`, `evt_dice`, `evt_instant`, effects/skills/point-buy in resolver | ✗ | loaded from `data/`, not wired |
| 3 actions per round, deck 15–20 | ◐ | 1 action per round; character decks 20–26 cards |
| Gun persistence (Radisk) | ✗ on purpose | memory-only; persisted graphs resurrected ghost peers |

## 11. Running it

```
rad clone rad:zqZmP6itceBMqYwi1K1n8phQqCaj --scope all && cd chaosD6
(cd game && npm --userconfig /dev/null install)
node game/start-all.mjs            # launcher at http://127.0.0.1:7357
node game/start-all.mjs --list     # every Door on Radicle, who is live
node game/join.mjs --dimension Ashfall-Micro --placement nearby --as P-Moth
```

Requirements: Node ≥ 18 (use the nvm Node 22 under WSL, not the system Node 16), `rad` on PATH with `rad auth` done and `rad node` running, a `rad` remote of the form `rad://<RID>/<NID>` so the adapter can push into your namespace.

Two players on one machine: `game/tools/dev-restart.sh` (two launchers, A on 7357 and B on 7358) and `game/tools/second-identity.sh setup` followed by `game/tools/start-b.sh` for a genuinely separate Radicle identity whose Doors arrive only through the public seeds. `game/tools/probe-join.mjs <launcherUrl> <seconds> <label>` proves a join without a browser.

### Environment variables that matter

| Variable | Default | Meaning |
|---|---|---|
| `ROUND_SEC`, `ROUNDS_PER_TURN` | 6, 3 | round cadence |
| `COMMIT_WAIT_MS`, `REVEAL_WAIT_MS` | 800, 1500 | handshake caps |
| `RADICLE_PUSH_SEC` | 60 | Door push interval |
| `NOSTR_RELAYS`, `NOSTR_ENABLED` | 3 relays, 1 | bus |
| `PEER_PUBLIC_IP`, `BIND_HOST` | 127.0.0.1 | announce address for libp2p and Gun |
| `REVEAL_RADIUS`, `MAP_SEED` | 10, hash of dim id | map growth |
| `JOIN_SYNC_WAIT_MS` | 6000 (launcher passes 500 / 8000) | clock adoption window |
| `DOOR_LIVE_MS` | 180000 | "live" threshold in the join list |
| `RADICLE_SEED`, `RADICLE_EXPLORER_BASE`, `RADICLE_ALIAS` | rosa.radicle.network, https://radicle.network, "" | explorer URLs in logs |
| `WITH_DISCOVERY`, `DISCOVERY_URL` | off | LAN mirror |

## 12. Known loose ends

* `game/README.md` predates the host-less redesign (documents `server.mjs`, hotkey 9, a browser-side engine). The modules `js/phases.js`, `hashgraph.js`, `combat.js`, `deck.js`, `ai.js`, `entities.js`, `data.js`, `radicle.js`, `sha.js` and `server.mjs` are dead code from that prototype.
* Every peer emits its own `evt_genesis` with `owners: ['peer:player-1']` and `rules_snapshot_commit: 'local'`; the real snapshot commit is not yet recorded on the branch.
* `DOOR_ID` is always `door-primary` inside Gun, while Radicle Doors are per peer.
* `nostr-bus.mjs` imports `@noble/curves` and `@noble/hashes` transitively; they should be declared in `game/package.json`.
* The map work (`js/map.js`, `hex.js`, `peer.mjs`) is uncommitted as of 2026-10-22.
