# Class isolation — handoff (2026-11-20)

Hand-off from the Claude Code session that worked in `/home/galt/repo_radicle_clone2/chaosD6` (branch `feature/godot-use`).
This clone, `/home/galt/chaosd6_mapper/chaosD6`, branch `feature/class-isolation`, forked at `37f66b8`. All class-isolation
work happens HERE. Not committed; delete it or move it into docs/ when you're done.

## Goal (user)
chaosD6 becomes **class-oblivious**: the engine exposes generic state, hooks and primitives, and a new class needs changes
**only** in chaosD6-Classes (`game/classes-data/`, published as Radicle repo `rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi`).

## User rulings (2026-11-20)
1. Classes **choose from a fixed set of engine placement/ability results**. Everything modifiable is exposed as engine
   **state** that class programs can change (no class-side map geometry).
2. Bots: a **generic planner** that infers from each class's needs (no per-class `bot` block).
3. Built-in classes go **by reference with a hard version gate** (protocol change accepted).
4. Keep the current class schema (`chaosd6.class/1`) **loadable** alongside the new one (published player branches exist).
5. **chaosD6-Classes owns** the `data/classes.json` content and the **weights**. Rebalance and proposals keep running in the game repo.
6. Class-card destructibility: **keep current behaviour**.

## Where it stands (impact analysis)
Already data-driven:
- `classHook(hook, classId, ctx, args)` in `game/classes.mjs` (~:495). `classes-data/HOOKS.md` reports 28/33 classes as pure data for resolver rules.
- Godot only has the generic `class_ability`. Channels are already generic (`channel-rule.mjs` `classEmits`, `effect-hooks.mjs` `class_emits`).

The game still knows specific classes in 6 ways:
1. **`CLASS_RULES` is a hardcoded JS table** (`classes.mjs` ~:61-95). It duplicates each definition's `flags`; `BUILTIN_IDS` is derived from it.
   - The JS `HOOKS` (~:104-488) answer by default because `CLASS_ENGINE` defaults to `js` (~:513).
   - Data programs run only for foreign classes or with `CLASS_ENGINE=data|shadow`.
2. **Five `{"engine":"js"}` abilities** are resolved in `peer.mjs` `simulate()` by a `switch(ab.id)` (~:4706): Animator `animatorCopy`, Priest `priestShrine`,
   Cleric `clericDisableNearby`, Seeker `seekerPlant`, Warrior `warriorStep`. They need map, occupancy or move queries the engine doesn't expose yet.
3. **Per-class entity and snapshot fields:** `stealth_turn`, `rogue_trap_turn/n`, `lured_by`, `chase_bonus`, `chasers_csv`, `reanimated_csv`, `reanim_down_csv` (snapshot ~:1811, :1824).
4. **Class-specific plumbing in peer.mjs** (26 distinct literal ids):
   - Rogue charge :1176-1186, sim copies :4767-4787; `dungeonStep` in classes.mjs (~:296) hardcodes rogue/cleric.
   - Necromancer: `classBlocked` early return :1581; revive/companion block :5337-5356; `RAISED_BY` prefix test :896/:968.
   - Reaver/Monk: `isReaver`/`isMonk` :1245 (likely dead); `invisibilityBreaks({reaver})` :3478/:3539/:6124.
   - Manipulator: planning `manipAlt` publish :3222-3245 (in the commit hash!) + probe/swap/re-resolve :5008-5060.
   - Avenger chase :5223-5240 + npcPlan prey :6353. Prophet contact :5248-5260, `requestHand` range `why==='class_prophet'?2:1` :6484, WS notice :7411.
   - Animator/Priest/Seeker sites :4596-4645; `maxStanding(data.classes.class_priest|class_seeker)` :5290/:5316; `grantSeekerVision` :5306/:6649.
   - Skip list `['class_elementalist','class_illusionist','class_rogue']` :4693; Elementalist used-marker :4736-4740.
   - Config imports: `animatorConfig, priestConfig, seekerConfig` (class-world.mjs), `rogueConfig, clericConfig` (class-traps.mjs),
     `manipulatorConfig` (class-manipulator.mjs), `avengerConfig, prophetConfig` (class-chase.mjs).
5. **Two sources of class data:** `data/classes.json` in the game repo (read in ~26 places in peer.mjs; class pool ~:1082/:1114) and `classes-data/`.
6. **UI and bots:**
   - `js/main.js` hardcodes seeker, reaver, priest, monk and animator (~:741-745 emits fallback, ~:2306-2308 needs hints).
   - `tools/swarm-test.mjs` has about 120 lines of per-class bot logic (~:114-177, :231, :422, log regexes :58-67/:641-645).

Line numbers are from 37f66b8 and will drift; grep the names.

## Generic replacements
| Mechanism | Primitive | Hook |
|---|---|---|
| CLASS_RULES | built from definition `flags`; `BUILTIN_IDS` = loaded bundle | exists (C2 loader) |
| Rogue/Cleric traps & charges | `class_state.charges[name]={turn,n}`, limits from data; `step`/`dungeon_step` get generic args (`charges`, ctx op `foes_in_radius(r)`); result `{consume:'trap'}` | args/records NEW |
| 5 JS abilities | fixed **ability-record vocabulary** applied by the engine: `build{site,made,max_standing}`, `trap{…,vision}`, `move{who,dest}`, `disable_traps{radius,mode}`, `peek`, `vision`; ctx ops `site_free`, `nearest_building`, `traps_in_range`, `step_toward` | `ability` exists; ops NEW |
| max standing | field on build/trap records (`made_by` = class id, generic) | NEW |
| Prophet peek / Avenger lure | contact hook returns `{peek:{of,n,why}}` (range from config); `lure` record → generic `lured_by`; chase bonus via `life_points` | contact/chase_step exist; make them per-held-class |
| Manipulator | planning `alt_action_demand` query (enemy in range holds a class with flag `wants_alt_action{range}`) → `alt` in commit; after the probe, a `rewrite` hook returns `{on, swap}` | NEW |
| Reaver invis | `emits` site `invis` | small NEW |
| Necromancer | `blocked` hook (std default null); `revive` record → companions with `RAISED_BY = classId` | `blocked` NEW |
| Elementalist | `after_cast` hook, or `pre_cast` result `consume:'action'\|'turn'` | NEW, small |
| UI | definition `ui` block (`needs_hint`, `ability_label`, icon), generic renderer | NEW schema field |
| Bots (ruling 2) | generic planner reading `needs` + ability records; structured `[class-event] {class, kind}` log lines instead of regexes | generic |

Passive triggers (Manipulator swap, Avenger chase, Prophet contact, Necromancer revive) are gated on `entity.classId === …`.
They need a class-agnostic "who holds a class with hook X" dispatch.

## Determinism and sync risks
- **One `class_state_json`** in the snapshot replaces the per-class fields. It must be canonical JSON (sorted keys) and namespaced per class id.
  - HOOKS.md notes that `parseJson(v.class_progress_json)` returns null for a remote object. That is harmless today, but not once peers read others' charges.
  - Check the size budget of the Gun slim record (`slimMemberRecord`).
- **Iteration order:** iterate classes by **sorted id**, not readdir/data order. First-match lookups (`CL_STEPPERS.find`, `CL_SHARERS`, `CL_LIFESTEAL`, `CL_ATTACK_OUT`) and summed lifesteal must be asserted as order-independent.
- **Hook order inside `simulate()` must not change.** Document it in HOOKS.md:
  1. stance
  2. pre-pass: pre_cast, pre ability, share_skills
  3. effects
  4. Rule 24: emits/restore/reanimated_strike/strike
  5. damage: lifesteal/attack_out
  6. post ability
  7. elementalist
  8. transmute, then destroy_result
  9. trap steps, then dungeon steps

  Then in `doResolution`: manipulator probe/re-resolve, application block, life. In `endRound`: `end_turn`.
- **Version gate (ruling 3):** built-ins currently travel by NAME (`classes-handshake.mjs:7-8`). Give them the same ref/`clKey` path as foreign classes, with the bundled set as a pre-seeded cache. A mismatch must not resolve silently.
- **Engine pins:** `classes-repo-sync.mjs` copies classes.mjs plus the class-*.mjs import closure into the Classes repo `tools/engine` with sha pins. Each phase moves the pin, so re-sync and republish.
- **Cost:** `CLASS_LIMITS` is 50k ops/hook call; `ready`, `emits`, `colours` and `kind` run per unit per action, and twice in the Manipulator probe. Memoise per (hook, class, args-hash) within one `simulate`.
- **The Manipulator rewrite changes the commit hash,** so old and new peers can't share a game.

## What moves / stays
- **To chaosD6-Classes:**
  - all definitions (`flags` as the only source), `classes_std.json` plus new lib helpers;
  - the `data/classes.json` content and weights (ruling 5);
  - `ui` blocks;
  - the JS reference hooks and class-*.mjs configs, as test oracles;
  - the per-class `classes-check` fixtures.
- **Stays in chaosD6:**
  - the hook runner (class-engine.mjs, the generic parts of classes.mjs);
  - record appliers;
  - a generic world-primitives module (`buildSite`, `discAround`, `nearestBuilding`, `hexDist`);
  - the class-state store and snapshot blob;
  - the handshake;
  - the generic UI renderer and generic bot planner;
  - rebalance/proposals (ruling 5).
- **Tools:**
  - `classes-check.mjs` (592 lines) moves or becomes data-vs-oracle; `class-engine-check` stays.
  - `classes-rebalancing-check.mjs` is the validator and ships via repo-sync.
  - `class-fixtures.mjs` and `chase-check.mjs` need rewiring; `classes-handshake-check` needs the by-ref built-in case.
- **Mobile:** `game/tools/stage-mobile-bundle.mjs` already copies `classes-data/` wholesale. If `data/classes.json` content moves, check the bundle no longer needs it.
- **Godot:** no change.

## Phased plan
Each phase ends with:
- `node --check game/peer.mjs`, `tools/effects-check.mjs`, `effect-hooks-check`, `logic-check`, `classes-check`, `class-engine-check`, `classes-handshake-check`;
- a `classes-repo-sync --dry-run` pin diff;
- a swarm with FORCE_CLASS over all 33 classes and **0 STATE DIVERGENCE**.

0. **Shadow as the norm:** swarms with `CLASS_ENGINE=shadow CLASS_SHADOW_STRICT=1` (+ `EFFECT_HOOKS_ENGINE=shadow EFFECT_HOOKS_SHADOW_STRICT=1`), then one with `CLASS_ENGINE=data`; fix every mismatch at its root, with an oracle. Status below.
1. **Definitions = single source:**
   - build `CLASS_RULES`/`BUILTIN_IDS` from the bundle, default `CLASS_ENGINE=data`;
   - one class-data source (ruling 5); drop `dungeonStep` literals.
   - Size: ~−450/+120 lines in classes.mjs, ~30 in peer.
2. **Generic `class_state_json` + charges:** migrate the Rogue/Avenger/Necro fields; dual-write old and new for one phase. Highest divergence risk. ~200 lines peer + lib.
3. **World primitives:** the record vocabulary + ctx ops; the 5 JS abilities become data; remove the post-pass `switch` and skip list; generic max-standing. ~300 peer, +250 JSON.
4. **New hooks:** Manipulator rewrite, Prophet contact/peek, Necro `blocked`/raise, `after_cast`, `invis`; delete the remaining literals. ~250.
5. **UI `ui` block + generic bot planner** (ruling 2); main.js and swarm-test become generic; schema `/2` with `/1` still loadable (ruling 4). ~150.
6. **Split:** remove class-*.mjs from the game (oracles move to Classes); built-ins by ref with a hard gate (ruling 3); re-sync pins; republish. Add a grep gate: no `class_<id>` literals in peer.mjs.

Total: ~1,300–1,600 lines touched/new in chaosD6, ~600 moved to Classes.

## Phase 0 status (done in the OLD clone at 37f66b8, so it applies here too)
- **Checks:**
  - `classes-check`: 1025 ok (33 classes × 28 hooks); also identical under shadow strict (138,749 comparisons, 0 mismatches) and under data.
  - `class-engine-check` 46 ok; chase-check, fortress-check and effect-hooks-check (187 ok, 0 shadow mismatches) pass.
- **Swarm-1159**, group 1, shadow strict, classes alchemist…elementalist:
  - errors 0, divergences 0, class shadow mismatches 0, effect-hook mismatches 0.
  - It used a fixture workaround, see below.
- **Not yet run:** shadow groups 2–4 (the other 24 classes), and one `CLASS_ENGINE=data` run.
- **Baseline published:** Classes validator 1.3.0, pin `ccde42d34407`.

## Infra issues found (fix before more swarms)
1. **Swarms had no joiners.** Commit 37f66b8 made `RADICLE_PUSH_REMOTE=0` the `game/tools/swarm-run.sh` default. That disables `joinDimension`/`listPublishedDimensions` (radicle-adapter `buildEnv` → disabled), so a swarm has no joiners (Swarm-1146).
   - Fixed in the old clone: replaced with `export RADICLE_DIMS_RID="${RADICLE_DIMS_RID:-code}"` (swarm doors go to the Code repo, as before 2026-11-19, and stay off the Dimensions repo the phone lists).
   - **Apply the same fix here.**
2. Peers print the shadow tallies only on `process.on('exit')`, which SIGTERM skips, so "0 mismatches" means no mismatch lines were logged. Consider a SIGTERM handler.
3. Swarm log folders are `logs/swarm-HHMM` and get reused across days (lines were appended to a 2026-11-15 folder). Add the date.
4. `swarm-run.sh` kills **every** `node *.mjs` on the machine, including the other clone's games and checks (it killed the user's `class-engine-check` during a republish). Consider killing only its own launcher/peers.

## Working rules (from CLAUDE.md and user standing instructions)
- **Never commit unless asked.** Commits sometimes appear on their own, using Claude's reply text as the message; check `git log -3` before planning one.
- Append data versions, never edit committed ones in place (today's uncommitted versions may be amended).
- Data/logic writes under `flock /tmp/chaosd6-data.lock`; logic via `bash tools/logic/apply-all.sh`.
- Shared files (peer.mjs, main.js, classes.mjs, swarm-test.mjs): small exact Edit replacements only, re-read before each.
- After resolver changes: node --check, effects-check, logic-check, then a swarm expecting 0 divergences.
- WSL from Windows Git Bash: run scripts from files (`MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash <file>`, or `tr -d '\r' < f | bash`); inline `$VAR` in `wsl bash -c` gets mangled. Scripts started that way skip ~/.bashrc: export `SSH_AUTH_SOCK=$HOME/.ssh/agent.sock`.
- `game/tools/out/` is gitignored and **empty in this clone**. Recreate scratch scripts here with this clone's paths; the old ones hardcode `/home/galt/repo_radicle_clone2`.
- **Swarms:** ask the user before starting one. They kill every `node *.mjs`, so warn other Claude sessions first (chaosd6-6f works in the old clone).
- **Shared between the clones:** `~/.radicle`, ports and `/tmp` (`/tmp/swarm.log`, `/tmp/chaos-A.log`).
- Never drive the user's phone while they use it. Never curl the OCI seed. Radicle: OCI seed only, no public seeds.
- The phone APK ships a staged copy of game/: build via `_tools/build_and_deploy.sh`, which stages first.

## Progress in this clone (session chaosd6-8a, 2026-11-20)
- swarm-run.sh fix applied by the user (a3e9ed4). Launcher C (`~/repo_radicle_b`) hangs swarm-test on its seed sync
  before P-Agent5 joins: run with `NO_C=1`. Scratch runner `game/tools/out/_ci_run.sh <1|2|3|4|p> [shadow|data|default]`
  (+ `_ci_summary.sh`, `_ci_checks.sh` = every phase-end check inside WSL, `_ci_sync.sh` = repo-sync dry run).
- **Phase 0 done:** shadow strict groups 2-4 (Swarm-1259, 1318, 1325) and CLASS_ENGINE=data over the 10 plumbing
  classes (Swarm-1333): 0 errors / divergences / class + effect-hook mismatches each.
- **Phase 1 done (uncommitted):**
  - classes.mjs: `CLASS_RULES` = the bundle's `flags`, sorted by id (the literal table is gone); `BUILTIN_IDS` = the
    bundle; `CLASS_ENGINE` defaults to `data` (js / shadow on request; JS hooks stay as oracles until phase 6).
  - Bundle loads eagerly and leniently (`loadClassDefs(…, {lenient})` → `errors`; `classBundleErrors()`), so a staged
    Classes tree with a bad file still imports the engine; peer.mjs exits if any built-in definition is invalid.
  - peer.mjs: `data.classes = builtinClassEntries()` (the definitions' name + data), not data/classes.json.
    data/classes.json stays the rebalance / proposals collection; class-engine-check keeps it = the definitions.
  - classes-check: sorted-order assertions + "every bundled definition loads".
  - Checks all green in WSL (classes-repo-check's cache-dir cases fail only under Windows node: POSIX paths).
  - Swarms, default engine, groups 1-4: Swarm-1527, 1533, 1540, 1547 — 0 errors, 0 divergences.
  - Pin diff (dry run): engine classes.mjs + class-engine.mjs, validator pin f532347fd5a0 (was ccde42d34407).
    Not synced / republished yet.
- **Left from phase 1:** the physical move of the data/classes.json collection (content + weights) into
  classes-data / chaosD6-Classes (ruling 5) — readers: peer loadJson, js/main.js `/data/classes.json`, swarm-test
  readData, class-fixtures, fortress-check / chase-check `active()`, classes-handshake dataClassIds, logic tools,
  rebalance / proposals, stage-mobile-bundle. `dungeonStep` literals only remain in the JS oracle (data programs answer).
