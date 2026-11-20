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
- **Phase 1 committed** by the user (7de3172).
- **Phase 2 done (uncommitted):**
  - New `game/class-state.mjs` (pure): one store per unit, namespaced by class id; snapshot `class_state_json`
    (canonical, empties dropped, '' when empty); charges `{turn, n}` (`chargeLeft` = `chargesLeft`, proven in the new
    `tools/class-state-check.mjs`), `stateGet/Set`, `unionOf`, `anyChargeUsed`.
  - peer.mjs: `entity.classStore` replaces stealthTurn / rogueTrapTurn / rogueTrapN / chaseBonus / chasers /
    reanimated / reanimDown; every reader goes through the store (own) or `csOf(snapshot)` (others); NPC wake / chase
    = any class's `threat` charge this turn. Old snapshot fields still written, derived from the store (DUAL WRITE —
    drop them in a later phase together with main.js's `reanim_down_csv` read).
  - class-engine.mjs ctx ops `class_state(id, cls)`, `class_state_union(key)`; class_necromancer.json ability reads
    `class_state_union('raised')` (definition content changed, version 1.1.0 kept: data unchanged; old peers still see
    reanimated_csv). JS oracle, fixtures (blob = reanimated_csv), classes-check verbatim copy, swarm-test updated.
    SCHEMA.md / HOOKS.md document it.
  - Checks all green (+ class-state-check 19 ok). Swarms default engine: focused rogue/avenger/necro Swarm-1610 (blob in
    1268 tape snapshots, threat charge ×7, avenger bonus grant/loss/fade) + groups 1-4 Swarm-1618, 1625, 1631, 1638:
    0 errors, 0 divergences. Not exercised live: Necromancer raise, Rogue trap charge, reanimated strike (unit-checked only).
  - Pin diff (dry run): + tools/engine/class-state.mjs, validator pin f5adafae351d. Not synced.
- **Phase 2 committed** in 4acb70b (its message is another session's reply text).
- **Necromancer 1.2.0** (user: "use the new version"): data/classes.json 1.2.0 canonical (data = 1.1.0, rebalance verdict
  accept), 1.1.0 superseded 0.99; definition version / source 1.2.0.
- **Phase 3 done (uncommitted):**
  - class-engine.mjs `ABILITY_REQUESTS` = copy_building / build / far_trap / disable_traps / step (ability `out` keys);
    peer.mjs simulate() resolves them in the post pass (`ABILITY_REQUEST_FNS`, same geometry / salts / log text as the old
    animatorCopy / priestShrine / seekerPlant / clericDisableNearby / warriorStep, which are gone together with the
    post-pass `switch` and the elementalist/illusionist/rogue skip list). classAbility(r, ab, requests) resolves them.
  - Max standing is generic: build / far_trap records carry `max_standing`, counted per class (`made.made_by` / trap
    `made_by`; the trap's old `seeker: true` flag is gone — a TMJ-restored legacy trap would not count, dev path only).
    shrineMade(cfg, sprite, by, byName) names the builder class; the vision grant names the class that laid the trap.
  - The 5 definitions: ability = data program (`done('', {<request>: [cfg_<class> + max_standing]})`); no JS markers
    left; every built-in validates as foreign. Versions animator 1.2.0, priest 1.3.0, seeker 1.3.0, cleric 1.2.0,
    warrior 1.1.0 (data unchanged; data/classes.json versions appended, old → superseded 0.99).
  - JS oracle: PEER_ABILITIES removed, ABILITIES return the same requests. classes-check asserts each request = the old
    config; class-engine-check: no markers, foreign-valid; validator prices requests (build / plant / disable_traps /
    relocate); fortress-check versions moved.
  - Checks all green. Swarms default engine: focused animator/priest/seeker/cleric/warrior Swarm-1727 (copy ×1, Shrine
    ×11 + one-standing ×7, far trap ×5 + vision ×5 + one-standing ×4, cleric 33× miss path) + groups 1-4 Swarm-1734,
    1741, 1749, 1755: 0 errors, 0 divergences. Not live: Cleric disabling a trap, the Warrior step (bot never clicks).
  - Pin diff (dry run): + class-world.mjs, validator changed. Not synced (OCI sync at the end, user 2026-11-20).
- **Phase 4 done (uncommitted):** no `class_<id>` literal is left in peer.mjs (only `class_ability` / `class_id` keys).
  - Helpers: `hasHook(cls, h)` (flags.hooks), `clShort` / `clName`, `chargeCfgOf(cls)` (config trapPerTurn /
    threatPerTurn / threatRadius, 0 when absent; data shared_charge), `invisCodesOf(perms)`, `CL_CHASERS` / `chaseBonusNow()`.
  - Rogue charges per stepping class (its namespace, memoised config per simulate); Reaver → flag `invisBreaks: ["EP","EM"]`
    (reaver 1.3.0), effects.mjs `invisibilityBreaks(p, {codes})` (old `{reaver}` still accepted); Elementalist pending
    boost carries `cls`; Manipulator = a class with `combat_in` (config publishRange / range, seed `${salt}:${clShort}:…`
    unchanged); Avenger = every `chase_step` class; Prophet = a class with `contact` (requestHand +2 range for it);
    Necromancer: new hook `blocked` (args fallen_near, archive_creature → reason | null; necromancer 1.3.0) and revive
    records carry `cls` (set in classAbility). The Cleric disable notice names my class.
  - Snapshot: stealth_turn, rogue_trap_turn, rogue_trap_n, reanimated_csv, chase_bonus, chasers_csv dropped (no reader);
    reanim_down_csv stays for the UI until phase 5. Unused class config imports dropped from peer.mjs.
  - Validator: HOOK_POWER `blocked: null` (a UI gate, never priced). Schema hookName + `blocked`; docs HOOKS.md
    ("No class ids in peer.mjs"), SCHEMA.md (blocked, invisBreaks).
  - Checks all green. Swarms default engine: focused rogue/manipulator/avenger/prophet/necromancer/reaver/elementalist
    Swarm-1831 (group `r`; blob namespaces ok, threat charge, chase grant/loss, necro blocked=21) + groups 1-4 Swarm-1837,
    1843, 1850, 1856: 0 errors, 0 divergences. Still not live: Rogue trap dodge, Manipulator swap, Prophet hand look.
  - Pin diff (dry run): engine + validator + 7 definitions + schema/docs changed. Not synced.
  - Patches: tools/out/_patch_ci17.py (engine), _ci18 (defs), _ci19 (peer.mjs), _ci20 (tidy), _ci21 (docs).
- **Phase 5 done (uncommitted, session 67a309e0, 2026-11-20):** js/main.js and tools/swarm-test.mjs name no class id.
  - Schema `chaosd6.class/2` = `/1` + optional `ui` {needs_hint, ability_label, icon, notice} (class-engine.mjs
    `CLASS_SCHEMA_IDS`, `UI_KEYS`, `classUi`); `/1` still loads, `/1` with `ui` is refused. class.schema.json + SCHEMA.md.
  - Definitions with a ui block (data unchanged, data/classes.json version appended, old → superseded 0.99):
    animator 1.3.0, priest 1.4.0, seeker 1.4.0 (needs_hint), prophet 1.3.0 (notice). Script tools/out/_p5_defs.mjs.
  - classes.mjs `classUiOf(id)` = ui block + `reanim` (data.destroy_reanimated {elements, die}); peer.mjs sends it as
    `class_ui` (hello + class_catalog); the Prophet notice reads `ui.notice`.
  - main.js: needs text / glyph / ready label from class_ui; emits only from classStateForUI.emits (Reaver/Monk
    fallback gone); reanimated pill reads `class_state_json` `<raised_by>.down` + class_ui reanim.
  - `reanim_down_csv` dropped from the snapshot (reanimFields → raised_by only).
  - Bots (ruling 2): generic planner `classProfile` in swarm-test.mjs — needs, data knobs (near, place_range, range,
    lure_range, disable_range), hooks (step/dungeon_step, contact/combat_in), `class-engine.mjs#abilityRecordsOf`.
    Witch now uses its real range (data.range 1, was a hard-coded 3).
  - `[class-event] {"class","kind"}` lines (peer.mjs `classEventLine`): ability, trap_charge, threat_charge,
    disable_active/passive, swap, contact; swarm-test counts them per class (CLASS_LOG regexes gone).
  - Checks all green (class-engine-check 55 ok incl. /1-/2 tests; chase/fortress version pins moved). Swarms default
    engine: group p Swarm-2029 + groups 1-4 Swarm-2036, 2042, 2048, 2054: 0 errors, 0 divergences. Now live:
    Manipulator swap (34 lines), Prophet contact (6 + 3). Still not live: Rogue trap dodge, Warrior step, Cleric disable.
  - Pin diff (dry run): validator pin moves to 572e1dc2242a (engines changed) + 4 definitions + schema/docs. Not synced.
  - Not done: the APK's copy of main.js (godot/android/.../nodejs-project/js) refreshes on the next build_and_deploy.sh.
- **Phase 6 done (uncommitted, session 67a309e0, 2026-11-20) — except the republish (needs the user):**
  - Split: class-world/traps/chase/manipulator.mjs removed (copies in tools/out/_p6_removed). Generic primitives →
    game/world-prims.mjs + game/contact-prims.mjs (moved verbatim, tools/out/_p6_split.mjs); class configs →
    classes-data/oracle/class-configs.mjs; the JS reference hooks + jsHook → classes-data/oracle/classes-js.mjs
    (tools/out/_p6_oracle.mjs). classes.mjs 632 → ~250 lines: the dispatcher; `installClassOracle()` for
    CLASS_ENGINE=js|shadow (peer.mjs + classes-check load the oracle dynamically, only in those modes); a dormant
    foreign class now answers through its data path.
  - Built-ins by reference (ruling 3): snapshot `cl_key` = clKey(bundled def + libs) 16 hex; classes-handshake.mjs
    `gateBuiltins` + adapter `builtinKey` / `gateBuiltins` (log CLASS VERSION GATE, UI class_source event `version`);
    peer.mjs withholds state_hash on a mismatch / missing pin (clVer.abstain, beside the foreign abstain).
  - Grep gate: class-engine-check section 6 (12 game files, no class id as code; old modules gone; no static oracle
    import; oracle HOOKS = engine hooks). 59 ok. handshake-check: BR section (pin, snapshot, gate, notice once).
  - classes-repo-sync: engine entries + world/contact prims; mirrors oracle/*.mjs → oracle/, data/classes.json →
    data/ (ruling 5); template README documents it. Validator 1.4.0 (model unchanged), ENGINE_FILES = classes,
    class-engine, effect-engine, class-state, world-prims, contact-prims. Dry run: pin 220833e7049a.
  - classes-check stays in the game as the data-vs-oracle check (imports the oracle from classes-data/oracle).
  - Swarms: group p shadow strict Swarm-2232 (oracle loaded dynamically, Cleric disable live for the first time) +
    groups 1-4 default Swarm-2239, 2245, 2251, 2257: 0 errors, 0 divergences, 0 version-gate lines.
  - Left as-is: provenance doc strings naming class-*.mjs inside classes_std.json / data/classes.json /
    logic_rules.json (editing them moves every pin for a comment).
  - TODO (user): real classes-repo-sync (commits in /home/galt/chaosd6-classes-repo) + push rad / GitHub + announce.
