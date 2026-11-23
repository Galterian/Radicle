<div align="center">

# ⬡ chaosD6 — *Dimensions*

**A fully peer-to-peer tactical card RPG on an endless hex map.**
No game server, no lobby, no central authority: every player runs the same deterministic engine,
the rulebook is versioned data that players vote on, and Radicle is the shared memory.

[📖 Rules (live)](https://92-5-138-121.sslip.io/rules/) ·
[📱 Android APK](https://92-5-138-121.sslip.io/downloads/chaosd6-release.apk) ·
[🧭 Architecture (interactive)](architecture.html) ·
[🖥️ Play on a desktop](#desktop) ·
[🛰️ Host a seed](#host-a-seed)

`Node 22` · `Radicle 1.10` · `libp2p` · `GunDB` · `Nostr` · `JsonLogic` · `Godot 4.5` · `llama.cpp`

</div>

---

## Contents

| | Section | What you find there |
|:-:|---|---|
| 1 | [Architecture](#architecture) | the pieces, how a round travels, the seven repos |
| 2 | [The game](#the-game) | stats, elements, actions, effects, classes, modes, governance — with links into the rules |
| 3 | [Host a new seed (OCI)](#host-a-seed) | `infra/oci/new-seed.sh` + `seed-provision.sh` |
| 4 | [Set up a desktop node and play](#desktop) | `tools/setup-desktop.sh` |
| 5 | [Profiles and seeds](#profiles) | what follows the new seed, what stays on the profile delegate |
| 6 | [Android: build, release, install](#android) | `_tools/build_and_deploy.sh`, `_tools/emu.sh` |
| 7 | [Repository map](#repo-map) | where everything lives |

---

<a id="architecture"></a>

## 1. Architecture

### 1.1 The big picture

```
                        ┌──────────────────────────── RADICLE (p2p git) ─────────────────────────────┐
                        │  chaosD6 (code + data/)   Dimensions   Effects   Skills   Classes   Profiles │
                        │        main = built-in rules · players/<team>/<slug> = proposals             │
                        └───────────▲─────────────────────────────▲────────────────────────▲──────────┘
                                    │ rad sync (announce / fetch)  │                        │
   ┌────────── DESKTOP NODE ────────┴───┐          ┌───────────────┴────── SEED (OCI) ──────┴───────────┐
   │ rad node      (your identity)      │◄────────►│ radicle-node :8776   (seeds our 6 repos only)       │
   │ start-all.mjs → launcher :7357     │  gossip  │ radicle-httpd :8080 → caddy :443  /api/v1           │
   │ peer.mjs × N  (you + bots)         │          │ /rules/  (read-only rulebook)  /pack/  /downloads/  │
   │ llama-server :8095 (AI bots, opt.) │          │ /profiles-push (profile writes)  /llm/ (opt.)       │
   └──────┬─────────────────────▲───────┘          └────────────────────▲───────────────────────────────┘
          │ ws                  │ libp2p · Gun · Nostr                   │ https (blobs, pack, profiles)
   ┌──────┴──────┐      ┌───────┴──────────────────────┐        ┌────────┴─────────────────────────┐
   │ browser UI  │      │ other players' peers         │        │ PHONE  Godot 4.5 app             │
   │ hex map,    │      │ (same deterministic resolver)│◄──────►│  nodejs-mobile → peer.mjs        │
   │ hand, perms │      └──────────────────────────────┘        │  in-app Radicle node, WebView HUD │
   └─────────────┘                                              └──────────────────────────────────┘
```

**The rule of the design:** every peer resolves every action itself and publishes a state hash.
Peers that disagree log a `STATE DIVERGENCE`; nobody is "the host".

### 1.2 Layers

| Layer | Lives in | Role |
|---|---|---|
| 📚 **Living rulebook** | `data/*.json`, `data/logic_rules.json` | 18 versioned collections; every entry has `versions[]` with `status`, `weight`, `data` and a **JsonLogic** `logic` block |
| 🧩 **Definitions** | `game/effects-data`, `skills-data`, `classes-data` → repos *chaosD6-Effects / -Skills / -Classes* | one JSON file per effect / skill / class with its hooks; players author new ones on `players/<team>/<slug>` branches |
| ⚙️ **Engines** | `game/peer.mjs`, `effect-engine.mjs`, `skill-engine.mjs`, `class-engine.mjs`, `logic-engine.mjs` | deterministic round resolver; dice come from the revealed salts, so every peer rolls the same |
| 🌐 **Mesh** | `nostr-bus.mjs`, libp2p gossipsub, GunDB | commit / reveal / state envelopes; Nostr crosses any NAT, libp2p + Gun are the fast lanes |
| 🗂️ **Radicle** | `radicle-adapter.mjs`, `*-repo.mjs`, `profile-sync.mjs` | Doors (one per peer and Dimension), definitions, votes, team profiles |
| 🛰️ **Seed** | `infra/oci/` | always-on Radicle node + HTTPS API + static rulebook, asset pack, APK |
| 🖥️ **Clients** | `game/js/` (browser), `godot/` (Android) | thin UIs over a local peer |
| 🤖 **AI** | `game/llm-brain.mjs`, `tools/llm/` | Qwen3-1.7B on llama-server drives team bots, rivals, monsters and NPC builders; rules-only fallback |

### 1.3 One action, end to end

| # | Phase | What happens |
|:-:|---|---|
| 1 | **Plan** | each player picks a card and a target (≤ 6 s); bots plan through `npcPlan()` (+ LLM hints) |
| 2 | **Commit** | `sha256(card :: target :: salt)` is broadcast — nobody can change their mind after seeing others |
| 3 | **Reveal** | card, effects, skills, target, salt; a silent peer counts as *Empty Posture* (the paper's failure rule) |
| 4 | **Resolve** | every peer runs the same resolver: movement, the damage matrix, effect emissions, point-buy dice from the salts |
| 5 | **Agree** | each peer publishes a state hash; a mismatch is logged as `STATE DIVERGENCE` and triaged with the swarm tools |
| 6 | **Publish** | every ~60 s each peer pushes its *Door* (position, clock, known map, network addresses) to the Dimensions repo |

### 1.4 The seven Radicle repos

| Repo | RID | Content | Who writes |
|---|---|---|---|
| **chaosD6** (code) | `rad:zqZmP6itceBMqYwi1K1n8phQqCaj` | this repository: engine, data, tools | maintainers |
| **chaosD6-Dimensions** | `rad:z2xbfJfwT3kukR73m8LXmmuvchEwr` | `ActiveDimensions/<name>` branches, one Door per peer | every peer, in its own namespace |
| **chaosD6-Effects** | `rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ` | effect definitions + hooks | `main` built-in, `players/*` proposals |
| **chaosD6-Skills** | `rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5` | skill definitions | same |
| **chaosD6-Classes** | `rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi` | class definitions | same |
| **chaosD6-Profiles** | `rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH` | one branch per team / device profile | the seed only (signed pushes via `/profiles-push`) |
| chaosD6-Resources | `rad:zZA4j9cK1QF5ThY3KjEoLV4HTd14` | sprites, sounds (third-party assets) | maintainers; served to phones as `/pack/` |

---

<a id="the-game"></a>

## 2. The game

> *Dimensions* started as a paper tabletop RPG ([`DimentionsEN.docx.html`](DimentionsEN.docx.html)).
> chaosD6 turns it into a real-time digital grid where the rulebook itself is data — browse it any time at
> **[92-5-138-121.sslip.io/rules/](https://92-5-138-121.sslip.io/rules/)**.

### 2.1 Your character

| | | |
|---|---|---|
| **4 stats** — [stats](https://92-5-138-121.sslip.io/rules/#/stats) | Vitality · World (Souls) · Matter (Ethereality) · Will | playable characters sum to **40**; **Life = round(Σ stats / 10)** |
| **10 elements** — [elements](https://92-5-138-121.sslip.io/rules/#/elements) | Vitality · Souls · Time · Space · Air · Water · Earth · Fire · Concentration · Harmony | the "mana" of effects; each element maps to the stat that powers it |
| **A deck** | 15–20 cards, hand of 5 | action cards + effects + skills + one class card; no levels — progression is lateral |

### 2.2 Turns, rounds, actions

* A paper **round** = 3 **actions**. Every action all players play one card *simultaneously* (commit → reveal).
* Six action cards — [actions](https://92-5-138-121.sslip.io/rules/#/actions):

| Card | | Beats | Notes |
|:-:|---|---|---|
| **A** | ⚔️ Attack | Posture | |
| **P** | 🧘 Posture | Move | emits one element of the effect you are casting |
| **M** | 🏃 Move | Block | moving interrupts a cast |
| **B** | 🛡️ Block | Attack | reflects 1 damage to each attacker |
| **EP** | Empty Posture | — | emits elements, read adversarially ([Rule 6](https://92-5-138-121.sslip.io/rules/#/rules/rule_6_empty_posture_move)) |
| **EM** | Empty Move | — | declared openly, emits nothing |

The cycle **Attack › Posture › Move › Block › Attack** is the core rock-paper-scissors
([battle system](https://92-5-138-121.sslip.io/rules/#/battle_system)).

### 2.3 Magic: effects, skills, classes

| Concept | In short | Rules |
|---|---|---|
| ✨ **Cast** | an effect costs a list of elements; each Posture / Empty Posture emits one. Finish the list → the effect fires | [Rule 18](https://92-5-138-121.sslip.io/rules/#/rules/rule_18_element_emit), [Rule 19](https://92-5-138-121.sslip.io/rules/#/rules/rule_19_effect_cast) |
| 🔗 **Chain** | the next effect may start on the element the previous one ended with | [Rule 22](https://92-5-138-121.sslip.io/rules/#/rules/rule_22_multicast) |
| ∀ **Double cast** | two copies queued together: cost + 1, often a different meaning (Shield → permanent, Haste → +1 card …) | [Rule 23](https://92-5-138-121.sslip.io/rules/#/rules/rule_23_double_cast) |
| 🎲 **Point-buy** | at each emission roll N dice against the stat; a failed roll re-emits next action | [Rule 21](https://92-5-138-121.sslip.io/rules/#/rules/rule_21_effect_damage) |
| 💥 **Delta damage** | Σ over the elements of max(0, caster stat − defender stat), ÷ 10, rounded half up | [Rule 21](https://92-5-138-121.sslip.io/rules/#/rules/rule_21_effect_damage) |
| 🏰 **Permanents** | cards that stay in front of the deck until destroyed by a stat emission | [Rule 12](https://92-5-138-121.sslip.io/rules/#/rules/rule_12_permanent_types), [Rule 24](https://92-5-138-121.sslip.io/rules/#/rules/rule_24_destroy_permanent_token) |
| ⚡ **Skills** | instants with their own timing | [Rule 17](https://92-5-138-121.sslip.io/rules/#/rules/rule_17_skills) |
| 🎭 **Class card** | one per character; a passive or tap ability | [Rule 9](https://92-5-138-121.sslip.io/rules/#/rules/rule_9_class_card) |

### 2.4 The world

| Collection | Count | Browse |
|---|:-:|---|
| Rules | 31 | [rules](https://92-5-138-121.sslip.io/rules/#/rules) |
| Effects | 66 | [effects](https://92-5-138-121.sslip.io/rules/#/effects) |
| Skills | 14 | [skills](https://92-5-138-121.sslip.io/rules/#/skills) |
| Classes | 33 | [classes](https://92-5-138-121.sslip.io/rules/#/classes) |
| Characters | 12 | [characters](https://92-5-138-121.sslip.io/rules/#/characters) |
| Creatures | 29 | [creatures](https://92-5-138-121.sslip.io/rules/#/creatures) |
| Terrain items | 41 | [terrain_items](https://92-5-138-121.sslip.io/rules/#/terrain_items) |
| Game modes | 9 | [game_modes](https://92-5-138-121.sslip.io/rules/#/game_modes) — Arena, Invasion, Raid, World, MMORPG, Puzzle, Cards, Time management, Real-time MMORPG |
| Contradictions in the paper | 6 | [contradictions](https://92-5-138-121.sslip.io/rules/#/contradictions) — resolved by vote |

**The map** grows as you explore: a seeded hex world (same seed → same terrain on every peer), discs revealed around
each player, traps and buildings discovered on the way ([Rule 2](https://92-5-138-121.sslip.io/rules/#/rules/rule_2_discover_tile),
[Rule 4](https://92-5-138-121.sslip.io/rules/#/rules/rule_4_traps)). A **Dimension** is one live session; anyone can
create one from the launcher or join a live one next to a friend.

### 2.5 Players change the rules

```
 propose ──► validate (JsonLogic) ──► power score ±15 % ──► counter-proposals ──► vote ──► canonical
```

* **Data collections** (rules, creatures, terrain …): the node's rules editor appends a new version with
  `status: proposal`, `weight: 0` — never in place. `game/tools/rebalance.mjs` gives the verdict
  (`accept` · `accept_with_counters` · `needs_rework` · `blocked`) and drafts counter-proposals on linked entries.
* **New effects / skills / classes**: authored as definitions on your team branch `players/<team>/<slug>`, checked by the
  rebalancing validators (`ok` · `nerf` · `boost` · `reject`), signed with your key and published to the seed.
* Votes are weighted by how much you actually play with an entry ([governance](https://92-5-138-121.sslip.io/rules/#/governance)).

> 🔒 The public rules site is **read-only** (built by `game/tools/rules-site-build.mjs`). Your own node serves the same
> editor (`editor.html` + `editor/`, `game/editor-api.mjs`) at `http://127.0.0.1:7357/rules/` — startup menu → **Rules
> editor** — where, signed in with your team (profile team name + owner key), you can propose new versions and publish
> new skills, effects and classes (`game/editor-publish.mjs`). It loads collections on demand, works on a phone, and
> prints JsonLogic compactly (`editor/jsonfmt.js`); `#/<collection>/<id>` links open an entry directly.

---

<a id="host-a-seed"></a>

## 🛰️ Host a new seed (OCI)

Turn a fresh VM into a seed that hosts all the chaosD6 repos exactly like the live one.

```
 your workstation                                         the new VM
 ────────────────                                         ──────────
 infra/oci/new-seed.sh ──ssh/scp──► seed-provision.sh  ►  radicle-node · radicle-httpd · caddy · firewall
        │                                                 private-seed policy · 6 repos pinned + fetched
        ├──► rules site, asset pack, APK  ───────────────► /var/www/{rules,pack,downloads}
        ├──► (opt) llm-setup.sh / profiles-setup.sh
        └──► infra/oci/seeder-<host>.json + wiring line for players
```

### ✅ Prerequisites

| Need | Details |
|---|---|
| 🖥️ **A VM** | Ubuntu 22.04 / 24.04, arm64 (OCI Ampere A1, Always Free) or amd64, public IP, a sudo user (OCI: `ubuntu`) |
| 🔓 **Cloud firewall** | TCP **22, 80, 443, 8776** open (OCI: VCN security list). The script opens the VM's own iptables itself |
| 🔑 **SSH key pair** | `ssh-keygen -t ed25519 -f infra/oci/keys/oci_seeder -N ''` — the `.pub` goes in at instance creation |
| 🧰 **Locally** | `bash ssh scp tar curl python3`; Node ≥ 18 for the full rules build; `rsync` only for `--pack-source local` |
| 🌍 **Domain** | not needed — `<ip-dashed>.sslip.io` resolves to the IP and Let's Encrypt issues for it |
| ☁️ *(only `--terraform`)* | `terraform`, `~/.oci/config` (OCI API key), `infra/oci/terraform.tfvars` from `terraform.tfvars.example` |

### 🚀 Usage

```sh
infra/oci/new-seed.sh --host ubuntu@203.0.113.7 --dry-run          # show the plan, change nothing
infra/oci/new-seed.sh --host ubuntu@203.0.113.7 --key ~/.ssh/k     # full mirror: repos + rules + pack + APK
infra/oci/new-seed.sh --host ubuntu@203.0.113.7 --llm-public       # + AI model reachable by phones
infra/oci/new-seed.sh --terraform                                   # create the VM with terraform first
```

### ⚙️ Options — `new-seed.sh`

| Option | Default | Meaning |
|---|---|---|
| `--host USER@IP` | *required* (unless `--terraform`) | the VM; a bare IP means `ubuntu@IP` |
| `--key PATH` | `infra/oci/keys/oci_seeder` → `~/.ssh/id_ed25519` → `~/.ssh/id_rsa` | ssh private key |
| `--hostname FQDN` | `<ip>.sslip.io` | your own domain (A record → the IP) |
| `--alias NAME` | `chaos-seed-<host>` | node alias seen by peers |
| `--email ADDR` | `admin@sslip.io` | Let's Encrypt account (`.local` is rejected) |
| `--upstream NID@H:P` \| `none` | the live seed | where the repos are fetched from; `none` = independent, empty seed |
| `--upstream-www URL` | `https://92-5-138-121.sslip.io` | source of the asset pack and APK |
| `--content LIST` | `all` | `rules,pack,apk` · `all` · `none` |
| `--pack-source` | `upstream` | `upstream`: the VM downloads the pack itself · `local`: rsync from this checkout (+ `_tools/chaosd6-release.apk`) |
| `--with-llm` / `--llm-public` | off | llama-server loopback-only / plus `/llm` behind an API key (`infra/oci/llm-setup.sh`) |
| `--own-profiles` | off | a NEW Profiles repo delegated to this seed — independent networks only ([why](#profiles)) |
| `--force-caddy` | off | rewrite the caddy site even if one exists (backup kept) |
| `--dry-run` | off | print the plan and exit |

### 🔧 What the VM ends up with (`seed-provision.sh`)

| Piece | Setting |
|---|---|
| user / binaries | `radicle`, rad + radicle-node (`radicle.xyz/install`), radicle-httpd (files.radicle.xyz apt), unencrypted node key |
| radicle-node | `0.0.0.0:8776`, external address `<host>:8776`, systemd `Restart=always` |
| policy | `peers: dynamic` · `seedingPolicy: block` · `rad seed --scope all` for the 6 repos only · upstream in `node.connect` |
| radicle-httpd | `127.0.0.1:8080`, all repos in `web.pinned.repositories` |
| caddy | TLS on `<host>`; `/downloads/*` `/pack/*` `/rules/*` static from `/var/www`, everything else → httpd, CORS `*` |
| firewall | iptables ACCEPT 80, 443, 8776 (saved with netfilter-persistent) |
| record | `/home/radicle/seeder.json`, `public-hostname.txt`, `node-nid.txt` |

Run it **by hand** on the VM if you prefer:

```sh
scp infra/oci/seed-provision.sh ubuntu@IP:/tmp/
ssh ubuntu@IP 'HOST=seed.example.org ALIAS=my-seed bash /tmp/seed-provision.sh'
```

| Env | Default | | Env | Default |
|---|---|---|---|---|
| `HOST` | `<ip>.sslip.io` | | `RIDS` | the 6 repos |
| `ALIAS` | `chaos-seed-<host>` | | `UPSTREAM` | live seed · `none` |
| `ACME_EMAIL` | `admin@sslip.io` | | `FETCH_TIMEOUT` | `300sec` |
| `GOSSIP_PORT` / `HTTP_PORT` | `8776` / `8080` | | `FORCE_CADDY` | `0` |

### 📋 After the run

```
NEW SEED: z6Mk…@203-0-113-7.sslip.io:8776      api https://203-0-113-7.sslip.io/
```

* HTTPS checks red on the first run → wait ~1 min for the certificate. Port 8776 **CLOSED** → the cloud security list.
* ♻️ Re-running is safe: identity kept, config merged, pins kept.
* 🔁 Stays in sync with the upstream over gossip. For a two-way link add `<new NID>@<host>:8776` to the upstream's `node.connect`.
* 🩺 Health later: `game/tools/oci/oci-seed-sync.sh`, `oci-node-check.sh` (piped over ssh, see their headers).

---

<a id="desktop"></a>

## 🖥️ Set up a desktop node and play

Everything a new player needs, in one script — Linux or **Windows WSL2 (Ubuntu)**.

```sh
bash setup-desktop.sh                     # fresh machine: just the script file
tools/setup-desktop.sh                    # from a checkout (re-run = update)
tools/setup-desktop.sh --seed z6Mk…@203-0-113-7.sslip.io:8776 --dir ~/games/chaosD6 --alias moth --with-llm
```

### ⚙️ Options — `setup-desktop.sh`

| Option | Default | Meaning |
|---|---|---|
| `--seed NID@HOST:PORT` | the live seed | the seed to connect to and fetch from (the line `new-seed.sh` prints) |
| `--dir PATH` | `~/chaosD6` (or the checkout the script is in) | where the game is cloned |
| `--alias NAME` | `$USER` | your Radicle alias (new identity only) |
| `--branch NAME` | repo default | branch to check out |
| `--with-llm` | off | llama-server + Qwen3-1.7B for AI bots (~1.2 GB); without it bots play by the rules |
| `--dev` | off | Python venv `<dir>/.venv` with the asset tools |
| `--no-apt` | off | skip system packages (macOS / no sudo — needs git, curl, jq, python3) |
| `--no-start` | off | don't start or restart the Radicle node |

### 🪜 What it does

| # | Step | |
|:-:|---|---|
| 1 | 📦 apt packages | git curl jq python3 build-essential screen … (asks for sudo once) |
| 2 | 🟩 Node 22 | via nvm |
| 3 | 🌱 Radicle | `~/.radicle/bin`, PATH line in `~/.bashrc` |
| 4 | 🔑 `rad auth` | only without a key; with a passphrase run `rad auth` once per session before playing |
| 5 | 🔒 node config | seed = only peer + preferred seed, `seedingPolicy: block` (backup kept), node restarted |
| 6 | 📥 repos | clone the code repo, fetch Dimensions / Effects / Skills / Classes / Profiles **from the seed only** |
| 7 | 📚 npm | `npm install` from the public registry (ignores a private `~/.npmrc` token) |
| 8 | 🚀 launcher | `~/.config/chaosd6/env` + `~/.local/bin/chaosd6-play` |

### 🎮 Play

```sh
. ~/.bashrc
chaosd6-play              # → open http://127.0.0.1:7357
chaosd6-play --list       # every Dimension on Radicle and who is live
```

In the startup menu set your **team name** — proposals and the rules editor need it.
Check: `rad node status` (the seed is connected) · `rad sync status rad:zqZmP6itceBMqYwi1K1n8phQqCaj`.

| Key | Action |
|:-:|---|
| `1`–`5` | queue a card from the hand |
| `8` | the Empty card (EP, or EM with a tile target) |
| `9` `0` `-` `=` | permanents |
| right-click | discard a card / set an attack or a journey on the map |
| `Space` | lock your choice |

---

<a id="profiles"></a>

## 🪪 Profiles and seeds

`game/profile-sync.mjs` keeps two things apart:

| Value | Follows | Why |
|---|---|---|
| **sync seed** (`seedNid`) | `CHAOSD6_OCI_SEED_NID` → `OCI_SEED_NID` → live seed | the seed your node announces profile commits to — `setup-desktop.sh` writes both variables |
| **delegate namespace** (`OCI_NID`) | fixed: the live seed | the only node allowed to write chaosD6-Profiles; branches live in its namespace |
| **push / read URL** | `RADICLE_SEED_HOST` (default the live seed) | `/profiles-push` exists only on the delegate — leave it unset on mirrors |

➡️ A **mirror** seed serves profiles for reading; writes keep going to the delegate. Use `--own-profiles` only for a
separate network, then give players `RADICLE_PROFILES_RID=<new rid>` and `PROFILES_NAMESPACE=<new seed NID>`.

---

<a id="android"></a>

## 📱 Android: build, release, install

The phone app is a **Godot 4.5** client (`godot/`) that runs the same `peer.mjs` through **nodejs-mobile**, its own
in-app **Radicle node** and a WebView HUD. Package `net.dimensions.radicle`.

### ✅ Prerequisites (once)

| Need | How |
|---|---|
| Godot 4.5.2 editor + Android export templates | `_tools/get_godot.sh` (templates installed on first build) |
| JDK + Android SDK | exported by `~/godot-android/env.sh` (`JAVA_HOME`, `ANDROID_HOME`) |
| Keystores | debug: `GODOT_ANDROID_KEYSTORE_DEBUG_{PATH,USER,PASSWORD}`; release: `GODOT_ANDROID_KEYSTORE_RELEASE_*` (falls back to debug — use a real one before shipping) |
| Firebase | `google-services.json` (baked in by the build) |
| adb | `$ADB` → `adb` on PATH → `/mnt/c/platform-tools/adb.exe` |

### 🔨 Build

| Command | Result |
|---|---|
| `bash _tools/build_and_deploy.sh` | debug APK, installed on the attached device |
| `bash _tools/build_and_deploy.sh --release` | **release**: bumps `version/code` +1 and `version/name` minor, builds, installs, uploads to the seed's `/downloads/chaosd6-release.apk` |
| `bash _tools/build_and_deploy.sh --no-install` | build only |
| `bash _tools/build_and_deploy.sh --no-build` | install the existing APK |
| `bash _tools/build_android_apk.sh [--release]` | plain build → `_tools/chaosd6-debug.apk` / release APK |

Every build first **stages the current `game/` code** into the phone bundle, so an APK can never ship stale peer code.

### 📲 Install

| Where | How |
|---|---|
| 📥 any phone | download **[chaosd6-release.apk](https://92-5-138-121.sslip.io/downloads/chaosd6-release.apk)**, allow "install unknown apps" |
| 🔌 USB device | `adb install -r _tools/chaosd6-release.apk` (or `build_and_deploy.sh` does it) |
| 🧪 emulator (Windows, from WSL) | `bash _tools/emu.sh deploy` · `emu.sh logs` · `emu.sh shot` · `emu.sh view` · `emu.sh down` |

On first launch the app downloads the art from the seed's `/pack/` (`godot/assets_manifest.json`).

---

<a id="repo-map"></a>

## 🗺️ Repository map

| Path | What |
|---|---|
| `data/` | the living rulebook (18 collections + `logic_rules.json`) |
| `game/` | Node runtime: `peer.mjs`, `start-all.mjs`, `ui-server.mjs`, engines, Radicle adapters, browser UI (`js/`, `css/`) |
| `game/effects-data/`, `skills-data/`, `classes-data/` | built-in definitions (mirrored in their own repos) |
| `game/tools/` | checks (`logic-check`, `effects-check`, `editor-api-check` …), `rebalance.mjs`, swarm runner, OCI helpers (`oci/`) |
| `editor.html` (+ `editor/` with the rework) | the rules editor (public read-only, editable on your node) |
| `godot/` | Android / desktop Godot client and its plugins (`nodejs_mobile`, `radicle_node`, `webview_hud`) |
| `infra/oci/` | seed: `new-seed.sh`, `seed-provision.sh`, terraform, caddy, profiles, LLM setup |
| `tools/` | `setup-desktop.sh`, `llm/` (llama-server), asset/data porters |
| `_tools/` | Android build, deploy, emulator |
| `architecture.html` | interactive architecture diagram |

### 🧪 Checks after changing the engine

```sh
cd game
node --check peer.mjs
node tools/effects-check.mjs        # → all checks passed
node tools/logic-check.mjs          # → all logic checks passed
bash tools/swarm-run.sh             # bot swarm — expect 0 STATE DIVERGENCE
```

<div align="center">

*Built on Radicle — clone it:* `rad clone rad:zqZmP6itceBMqYwi1K1n8phQqCaj --scope all`

</div>
