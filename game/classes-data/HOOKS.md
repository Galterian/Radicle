# Class hook sites — inventory (chaosD6-Classes C1, 2026-11-16)

This lists every place where game code branches on a class: `game/peer.mjs`, `game/effects.mjs` and `game/class-*.mjs`. For each site it gives the hook of `classes.mjs#classHook` that answers it and whether the class definition carries it as JsonLogic. Line numbers are those of peer.mjs on 2026-11-16 (before P2) and drift; the quoted anchor is what to grep for. `tools/classes-check.mjs` holds verbatim copies of these sites (`REF_*`) and proves that classes.mjs equals them.

Legend:
- **data**: a JsonLogic program in `classes/<id>.json` or the lib default.
- **js**: a `{"engine":"js"}` marker; the site stays in peer.mjs.
- **peer**: a call site in peer.mjs that is not a hook. It is wire, UI or state plumbing that reads a hook result.

## Setup tables (peer.mjs ~1035–1110)

| site (anchor) | hook / table | classes | how |
|---|---|---|---|
| `const classColours = (classId) =>` | `colours` (std) | all | data (lib `colours`) |
| `const PASSIVE_TURN_CLASSES = new Set([` | `CLASS_RULES[id].passiveTurn` → `PASSIVE_TURN_CLASSES` | Elementalist, Rogue, Manipulator | flag |
| `const HAND_CLASS_DEFAULTS = {` / `handRevealOf` / `handDiscardOf` | `flags.handDefaults`, read by `config` | Prophet, Witch | flag + data (`cfg_prophet`, `cfg_witch`) |
| `const classPassive =` / `const classKindOf = (classId) =>` | `kind` (std) | all | data (lib `kind`) |
| `const classRangeOf` | `config` (std, `cfg_default` → `{range}`) | all | data |
| `const CLASS_NEEDS = {` | `CLASS_RULES[id].needs` → `CLASS_NEEDS` | Animator, Priest, Alchemist, Warrior, Healer, Overlord, Witch, Avenger, Ranger, Seeker | flag |
| `const CLASS_LOCAL = {` | `local` | Weapon Master, Summoner, Paladin, Shaman, Kensei | data (`quote` descriptor) |
| rogue charges / `rogueConfig(` | `config` | Rogue | data (`cfg_rogue` = class-traps.mjs `rogueConfig`) |

## Planning and UI

| site | hook | classes | how |
|---|---|---|---|
| `const classStateForUI = () =>` (~1482) | `kind`, `colours` | all | peer (reads hooks) |
| `hello` message `class_colours:` (~6713) | `colours` | all | peer, wire unchanged |
| `const enchanterNow = entity.permanents.has('class_enchanter')` (~2831) | `plan_emits` | Enchanter | data |
| `const emitsLong = … classHook('emits', …, { site: 'plan' })` (~2884) | `emits` site `plan` | Reaver, Barbarian, Monk | data |
| `clEmits(code)` (module scope, ~1164): the Rule 24 intent gate, bonus plans (`bEmits`, `effOK`), the WS plan checks, `classStateForUI().emits` (the UI's `clsEmits`) | `emits` site `plan` | Reaver, Barbarian, Monk | data (ruling 2026-11-16) |
| planning: queued class ability / `m.kind === 'class_ability'` (~6878) | `ready`, `CLASS_NEEDS` | all | peer (WS validation) |
| bot emission choice `const emitsNow = pick === 'P' \|\| slot < 0 \|\| clEmits(pick)` (~6030) | `emits` site `plan` | Reaver, Barbarian, Monk | peer (bot heuristics, same rule; an adjacent reanimated enemy is aimed at first) |
| Manipulator alt action publish (`manipAlt`, `pickAltAction`) | `config` | Manipulator | peer: `peer:manipAlt` (hand access) |

## Resolver: simulate()

| site | hook | classes | how |
|---|---|---|---|
| `const classStateOf = (id) =>` (~3292) | – | all | peer. Note: `parseJson(v.class_progress_json, null)` returns null for an object, so a remote class's progress always reads as null. This is harmless because only the owner's progress counts. |
| `const classReady = (id, classId) =>` (~3298) | `ready` (std) | all | data |
| stances `if (c === 'class_reaver' && (cur === 'EP' \|\| cur === 'EM')) {` (~3580) | `stance` | Reaver, Barbarian, Monk | data |
| Reaver auto-target `.sort((a, b) => a.cost - b.cost \|\| a.lands - b.lands …` | `stance_target` | Reaver | data |
| pre-pass Elementalist `const best = [...new Set(r.effect.elements.map(` (~3839) | `pre_cast` | Elementalist | data (`point_buy_seed`) |
| pre-pass Illusionist `ab?.id === 'class_illusionist'` | `ability` (phase pre) | Illusionist | data |
| Bard `for (const o of adjacentOf(r.actor, o => !enemyOf(r.actor, o) && !!byActorPre.get(o)))` (~3855) | `share_skills` | Bard | data |
| Rule 24 `const emitsNow = ['P', 'EP'].includes(r.declared) \|\| …` (~4043) | `emits` site `destroy` | Reaver, Barbarian, Monk | data (ruling 2026-11-16: Barbarian B and Monk M / EM emit here too) |
| `// --- my own class: recast from the archive / untap the ability` (~4046) | `restore` (std) | all | data |
| `// --- C1 ruling 2026-11-16, Necromancer "destroy reanimated"` (~4153) | `reanimated_strike` (asked of the unit's `raised_by` class) | Necromancer | data → `destroyOutcomes` kind `reanimated`; the unit applies it itself (Rule 24 loop, then life 0 next to the Phantom line) |
| `// --- an enemy's class colour (die of 6) ---` (~4166) | `strike` (std) | all | data |
| Noble `hasPerm(attacker, 'class_noble') && attacker === PEER_ID_STRING` (~4145) | `lifesteal` | Noble | data |
| Assassin `hasPerm(r.actor, 'class_assassin') && assassinScored.has(r.actor)` (~4193) | `attack_out` | Assassin | data |
| post-pass `['class_elementalist', 'class_illusionist', 'class_rogue'].includes(ab.id)` + `switch (ab.id)` (~4386) | `ability` (phase post) | Healer, Overlord, Druid, Witch, Avenger, Alchemist, Ranger, Necromancer | data |
| `const animatorCopy = (r, me, tile) =>` (~4308) | `ability` | Animator | **js** `peer.mjs#animatorCopy` (map tiles, buildings) |
| `const priestShrine = (r, me, tile) =>` (~4324) | `ability` | Priest | **js** `peer.mjs#priestShrine` (building placement) |
| `const seekerPlant = (r, me, ab, here) =>` (~4338) | `ability` | Seeker | **js** `peer.mjs#seekerPlant` (map distance ring, occupancy) |
| `const clericDisableNearby = (me, here) =>` (~4378) | `ability` | Cleric | **js** `peer.mjs#clericDisableNearby` (trap registry) |
| `case 'class_warrior':` | `ability` | Warrior | **js** `peer.mjs#warriorStep` (move register) |
| `// Transmuter (static): a nearby ally's completed cast` (~4492) | `transmute` | Transmuter | data (edits by outcome index) |
| `classOf(d.actor) === 'class_restaurateur'` (~4503) | `destroy_result` | Restaurateur | data |
| trap steps `const rogue = classStanding(who, 'class_rogue');` (~4534) | `step` | Rogue, Cleric | data |
| dungeons `classStanding(id, 'class_rogue') && rogueTrapLeft(id) > 0` (~4562) | `dungeon_step` | Rogue, Cleric | data |
| Manipulator `const emitsFor = (id) => (c) =>` (~4763) | `emits` site `manip` | Reaver, Monk | data |
| Manipulator `combatHit(probe.damage.get(m))` (~4769) | `combat_in` | Manipulator | data (= class-manipulator.mjs `combatHit`) |
| Manipulator `pickManipTarget(` (~4773) | `pick_target` | Manipulator | data (= `pickManipTarget`) |
| Necromancer revive of an archived creature | `ability` → `revives: [{who: null}]` | Necromancer | peer: `peer:revive` (archive access) |
| a class-raised unit's snapshot: `raised_by` (env `RAISED_BY` of a class companion, or a bound revive by a `class_` perm) (`reanimFields()`; the struck elements: its class state `<raised_by>.down`) | – | Necromancer | peer (absent on every other unit) |

## Ability requests (class isolation phase 3, 2026-11-20)

An ability program may return an engine **request** in its `out`, alongside the record lists (`heals`, `traps`, …). Requests are the fixed set of placement / ability results a class may choose from (user ruling 2026-11-20 #1). The program gives only the numbers; peer.mjs simulate() does the map geometry, occupancy and the move register in the post pass. Each request decides the use itself: on success the ability is used and the engine writes the note. A request that finds nothing leaves the ability ready, except `far_trap` with no hex, which spends the use. Requests only resolve for phase `post` abilities.

| Request | Fields | Engine result | Was |
|---|---|---|---|
| `copy_building` | `near`, `place` | copy of the nearest building within `near` (distance, q, r; broken fortresses skipped) on the picked hex within `place`, else a random free one | Animator `animatorCopy` |
| `build` | `label`, `power`, `heal`, `place`, `max_standing` | a building of that power on the picked / a random free hex within `place`; at most `max_standing` of the class's own stand (`made.made_by`) | Priest `priestShrine` |
| `far_trap` | `min`, `max`, `radius`, `turns`, `max_standing` | the attached effect card as an `enter` trap on a random walkable hex `min..max` away, with vision `radius` until turn + `turns`; at most `max_standing` per class (`made_by`) | Seeker `seekerPlant` |
| `disable_traps` | `radius` | every trap within `radius` that is not mine is disabled (active route) | Cleric `clericDisableNearby` |
| `step` | `n` | the adjacent ally pointed at (else me) steps `n` hexes toward the picked tile, if unmoved and free | Warrior `warriorStep` |

No definition carries a `{"engine":"js"}` marker any more, and every built-in also validates as a foreign class. The validator prices requests with the old power keys: `build`, `plant`, `disable_traps`, `relocate`.

## Class state (class isolation phase 2, 2026-11-20)

Every unit keeps one generic store, namespaced by class id, in `game/class-state.mjs`. It is published as one snapshot field, `class_state_json`: canonical JSON with sorted keys, empty values dropped, and `''` when the store is empty. Peers read another unit's state only through it; class programs use the ctx ops `class_state(id, cls)` and `class_state_union(key)`.

| Namespace.key | Was | Written by |
|---|---|---|
| `class_rogue.charges.threat` `{turn, n}` | `stealth_turn` | the threat charge spent (monsters neither wake nor chase that turn; NPCs check any class's `threat` charge) |
| `class_rogue.charges.trap` `{turn, n}` | `rogue_trap_turn` / `rogue_trap_n` | trap-charge uses (`chargeLeft` = `chargesLeft`) |
| `class_avenger.bonus` / `.chasers` | `chase_bonus` / `chasers_csv` | the chase step and life points |
| `class_necromancer.raised` | `reanimated_csv` | a raise; "already raised" = `class_state_union('raised')` over every unit and class |
| `<raised_by>.down` | `reanim_down_csv` | a reanimated unit's struck elements |

Phase 4: the derived fields `stealth_turn`, `rogue_trap_turn`, `rogue_trap_n`, `reanimated_csv`, `chase_bonus` and `chasers_csv` are gone (no reader left). Phase 5: `reanim_down_csv` is gone too — `js/main.js` reads `<raised_by>.down` from `class_state_json`. Tests: `tools/class-state-check.mjs`.

## No class ids in peer.mjs (class isolation phase 4, 2026-11-20)

peer.mjs asks what a class does, never which class it is: `hasHook(cls, h)` (flags.hooks), the class's `config` and its flags. Every namespace above is the unit's own class id.

| Site | Reads | Was |
|---|---|---|
| step charges (simulate step / dungeon step, the perms strip, the threat / trap spend) | the stepping class's `config` `trapPerTurn`, `threatPerTurn`, `threatRadius` (0 when absent) and data `shared_charge` | Rogue |
| Invisibility breaks (3 sites) | flag `invisBreaks` of every held class (`invisibilityBreaks(p, {codes})`) | `class_reaver` held |
| the pre-cast boost bookkeeping | the boosting class (`pre_cast`), its `perAction` flag | Elementalist |
| fallback action commit, the swap probe, the used mark | a class with `combat_in`; its `config` `publishRange` / `range`; `combat_in` / `pick_target` of that class | Manipulator |
| chase bonus (step, life points, life max) | every class with `chase_step`, summed over their namespaces; `config` `maxOnly` | Avenger |
| first contact, the hand request range, the UI notice | a class with `contact`; `config` `contact` | Prophet |
| the card's blocked reason | the `blocked` hook (args `fallen_near`, `archive_creature`) | Necromancer |
| a revive (raised list, companion, onRevived) | the class of the revive record (`cls`, set by classAbility) | Necromancer |

Log and notice texts use the class's short id / name, so the built-ins print exactly what they printed before.

## UI, bots and class events (class isolation phase 5, 2026-11-20)

`js/main.js` and `tools/swarm-test.mjs` name no class either.

| Site | Reads | Was |
|---|---|---|
| class card: the needs text, glyph, ready label | the definition's `ui` block (`chaosd6.class/2`: `needs_hint`, `icon`, `ability_label`), sent as `class_ui` (`classes.mjs#classUiOf`) | Animator / Priest / Seeker texts in main.js |
| click on a class that fires by itself | `ui.notice` (fallback "automatic — it fires by itself") | the Prophet text in peer.mjs |
| emitting action codes | `classStateForUI.emits` only | a Reaver / Monk fallback in main.js |
| reanimated pill (roster) | `class_state_json` `<raised_by>.down`; elements + die = `class_ui[raised_by].reanim` (data `destroy_reanimated`) | `reanim_down_csv`, H / C hard-coded |
| bot planner | `needs`, the data knobs (`near`, `place_range`, `range`, `lure_range`, `disable_range`), the hooks (`step` / `dungeon_step` → trap-aware, `contact` / `combat_in` → seeks contact), `class-engine.mjs#abilityRecordsOf` (`copy_building`, `build`, `disable_traps`, …) | ~10 `cid === 'class_…'` branches |
| bot counters | `[class-event] {"class", "kind"}` lines | a regex per class |

`[class-event]` lines (peer.mjs `classEventLine`, log only, never hashed; inside the resolver through `log()`, so quiet re-runs stay silent): `ability` (a click that took effect — the clicker, `useAbility`), `trap_charge` / `threat_charge` (the mover), `disable_active` / `disable_passive` (the disabler, per trap), `swap` (every peer), `contact` (the holder).

## The split (class isolation phase 6, 2026-11-20)

| What | Where now | Was |
|---|---|---|
| generic primitives the resolver applies class results with: `hexDist`, `discAround`, `nearestBuilding`, `buildSite`, `copyMade`, `shrineMade`, `chargesLeft`, `trapsInRange`, `clericRoute`, `disabledCardMoves` | `game/world-prims.mjs` | class-world.mjs, class-traps.mjs |
| `isWildMonster`, `lureTargets`, `chaseBonusStep`, `prophetPick`, `pickAltAction`, `combatHit`, `attackHit`, `pickManipTarget`, `applyManipSwap` | `game/contact-prims.mjs` | class-chase.mjs, class-manipulator.mjs |
| the class configs (`*Config`, `*_DEFAULTS`, `rogueShared`, `maxStanding`) | `classes-data/oracle/class-configs.mjs` (test oracle) | the same 4 files |
| the JS reference hooks (`HOOKS`, `jsHook`) | `classes-data/oracle/classes-js.mjs` (test oracle) | classes.mjs |

- The game runs the definitions only (`CLASS_ENGINE=data`). `js` / `shadow` need the oracle: peer.mjs and `tools/classes-check.mjs` call `installClassOracle(await import('./classes-data/oracle/classes-js.mjs'))` for those modes only. A dormant foreign class answers through its data path (no definition: std programs / neutral).
- `classes-repo-sync` mirrors `classes-data/oracle/*.mjs` → `oracle/` and `data/classes.json` → `data/` (user ruling 5); the engine copy adds `world-prims.mjs`, `contact-prims.mjs` (and `class-state.mjs` through the import closure). The validator pins `classes.mjs`, `class-engine.mjs`, `effect-engine.mjs`, `class-state.mjs`, the two primitive modules and the libs.
- **Built-ins by reference, hard version gate** (user ruling 3, `classes-handshake.mjs` `gateBuiltins`): a holder's snapshot carries `cl_key` = `clKey(bundled definition + libs)`, 16 hex. Once per action every peer compares the `cl_key` of each unit holding a built-in with its own bundled pin; a different or missing one → log `CLASS VERSION GATE …`, a UI notice (`class_source` event `version`), and **no state hash** from this peer for the action (`state_hash: ''`, as the foreign-class abstain). It never resolves with another version silently.
- **Grep gate** (`tools/class-engine-check.mjs` section 6): no built-in class id as code (line comments stripped) in peer.mjs, js/main.js, tools/swarm-test.mjs, classes.mjs, class-engine.mjs, class-state.mjs, world-prims.mjs, contact-prims.mjs, classes-handshake.mjs, effect-hooks.mjs, effects.mjs, awake.mjs; the 4 class-*.mjs files are gone; no game file imports the oracle statically.

## Application: doResolution / endRound

| site | hook | classes | how |
|---|---|---|---|
| `// Class cards (user ruling 2026-10-30) — what happened to MY class this action.` (~4894) | `progress` (std) | all | data |
| `chaseBonusStep({ chasers: entity.chasers, bonus: entity.chaseBonus }, chasing,` (~4940) | `chase_step` | Avenger | data (= class-chase.mjs `chaseBonusStep`) |
| `const foe = prophetPick(foes);` (~4955) | `contact` | Prophet | data (= `prophetPick`); the hand reveal stays `peer:requestHand` |
| `// Shield life points are the first life lost` (~5328) | `life_points` (std) | all | data |
| `lifestealForMe.amount > 0 && entity.life > 0 && entity.permanents.has('class_noble')` (~5339) | `lifesteal_apply` | Noble | data |
| element badge `const anyEmit = (trance ? trance : [act]).some(` (~5497) | `emits` site `badge` | Reaver, Monk | data |
| Guardian `entity.permanents.has('class_guardian') && !entity.classFlags.movedThisRound` (~5740) | `end_turn` | Guardian | data |
| local abilities (CLASS_LOCAL apply: draw / recover / grant) | `local` | Weapon Master, Summoner, Paladin, Shaman, Kensei | data descriptor, applied by peer |

## effects.mjs and class-*.mjs

- effects.mjs `!String(cast.phylactery.perm).startsWith('class_')` (~674): a phylactery never guards a class. This is not a class hook; it stays.
- effects.mjs `TRAP_POWER` = classes.mjs `TRAP_POWER` (asserted by classes-check). `pickBySalt` is mirrored by lib `pick_by_salt`.
- class-traps.mjs `rogueConfig` / `clericConfig` → lib `cfg_rogue` / `cfg_cleric`. `chargesLeft`, `trapsInRange`, `clericRoute` and `disabledCardMoves` stay JS (peer plumbing).
- class-manipulator.mjs `manipulatorConfig` → `cfg_manipulator`, `combatHit` → `combat_in`, `pickManipTarget` → `pick_target`. `pickAltAction` and `applyManipSwap` stay JS (hand / reveal mutation).
- class-chase.mjs: `avengerConfig` / `prophetConfig` → `cfg_avenger` / `cfg_prophet`; `isWildMonster` → lib `is_wild`; `lureTargets` → the Avenger ability; `chaseBonusStep` → `chase_step`; `prophetPick` → `contact`.
- class-world.mjs `animatorConfig` / `priestConfig` / `seekerConfig` → `cfg_animator` / `cfg_priest` / `cfg_seeker`. `discAround`, `nearestBuilding`, `buildSite`, `copyMade` and `shrineMade` stay JS, used by the js-marked abilities.

## Coverage per class

| class | kind | phase | hooks in the definition (besides the std defaults) | stays in peer |
|---|---|---|---|---|
| Alchemist | tap | post | ability | – |
| Animator | tap | post | config; ability = js | animatorCopy |
| Assassin | static | – | attack_out | – |
| Avenger | once_per_round | post | ability, config, chase_step | – |
| Barbarian | static | – | stance, emits | – |
| Bard | static | – | share_skills | – |
| Cleric | tap | post | config, step, dungeon_step; ability = js | clericDisableNearby |
| Druid | tap | post | ability | – |
| Elementalist | tap (passive turn) | – | pre_cast | – |
| Enchanter | once_per_round | – | plan_emits | – |
| Guardian | static | – | end_turn | – |
| Healer | tap | post | ability | – |
| Illusionist | tap | pre | ability | – |
| Kensei / Paladin / Shaman / Summoner | tap | local | local | apply (hand, deck) |
| Weapon Master | once_per_round | local | local | apply (draw) |
| Manipulator | passive | – | config, combat_in, pick_target | manipAlt publish / swap |
| Monk | static | – | stance, emits | – |
| Necromancer | tap | post | ability, reanimated_strike | archived-creature revive; raised_by snapshot field (struck elements in class_state_json) |
| Noble | static | – | lifesteal, lifesteal_apply | – |
| Overlord | tap | post | ability | – |
| Priest | once_per_round | post | config; ability = js | priestShrine |
| Prophet | once_per_round (passive) | – | config, contact | requestHand |
| Ranger | tap | post | ability | – |
| Reaver | static | – | stance, stance_target, emits | – |
| Restaurateur | static | – | destroy_result | – |
| Rogue | tap (passive turn) | – | config, step, dungeon_step | charge bookkeeping |
| Seeker | tap | post | config; ability = js | seekerPlant |
| Transmuter | static | – | transmute | – |
| Warrior | static | post | ability = js | warriorStep |
| Witch | tap | post | ability, config | – |

In total, 28 of 33 classes are fully data for their resolver rules. The other 5 (Animator, Priest, Cleric, Seeker, Warrior) have data for every hook except the ability.

## P2 wiring (peer.mjs, `C1`-tagged hunks)

peer.mjs calls `classHook` at every site above marked data, so `CLASS_ENGINE=data|shadow` switches the whole resolver. Two contexts are used:

- `CL_BASE` (module scope) answers `colours`, `kind`, `ready`, `local`, `progress`, `life_points`, `chase_step`, `contact`, `lifesteal_apply`, `end_turn`, `plan_emits`, the plan and badge `emits`, and the Manipulator's `combat_in`, `pick_target` and manip `emits`.
- `clCtx` (inside `simulate`, read-only view queries) answers `stance`, `stance_target`, `pre_cast`, `ability` (pre and post), `share_skills`, the destroy `emits`, `restore`, `strike`, `lifesteal`, `attack_out`, `transmute`, `destroy_result`, `step` and `dungeon_step`.

The post-pass `switch` keeps only the five peer-resolved cases. The state hash and the wire format are unchanged.

## Open questions (text vs code)

- Monk EM (was: emits at plan / manip only). User ruling 2026-11-16: Move and Empty Move emit at every site (plan, Rule 24 destroy / strike, manip, badge): `emits: { M: true, EM: true }`, power `emit: 2`; data/classes.json class_monk 1.1.0.
- Barbarian "may emit during Block" (was: stance only). User ruling 2026-11-16: Block emits at every site: `emits: { B: true }`, power `emit: 1`; class_barbarian 1.1.0.
- Necromancer "destroy reanimated" (was: not implemented). User ruling 2026-11-16: hook `reanimated_strike`; class_necromancer 1.1.0 data `destroy_reanimated: {elements: [elem_harmony, elem_concentration], die: 6}`. Reading: a unit the class raised (a corpse raised in place, a re-spawned summon, an archived creature) carries `raised_by: class_necromancer`. An adjacent enemy emits Will at it (`destroy: {stat: "will", reanimated: <peer>, elem}`, on any emitting action). A point-buy die of 6 strikes that element, one per emission, in any order, and the emissions need not be contiguous. When both are struck, the unit is destroyed. Ordinary damage still kills it, and a reanimated corpse is never raised again. Confirmed by the user 2026-11-17: (a) "destroy" is an extra way for enemies to kill it, not an immunity to damage; (b) the two strikes may come from different enemies, also in the same action (the unit counts what is down after the action, peer.mjs Rule 24 apply loop).
- Channels (user ruling 2026-11-17, "the casting progress should not be broken in those cases"): a Reaver Attack and a Barbarian Block are class emissions. Like a Posture, they keep the holder's channel going: peer.mjs `channelBreaksFor` skips `CHANNEL_BREAK` for A / B when the holder's class `emits` on that code. Only an emitted element other than the channel cost breaks it. A cast in progress already advanced on them (Rule 19 `emitsLong`). A Monk Move, a plain A / B and a Battle Trance pair still break a channel. Dimension Out keeps its own interrupt rule. class_reaver 1.1.0 and class_barbarian 1.2.0 (notes only, data unchanged).
- `classStateOf` parses `class_progress_json` with `parseJson(…, null)`, which accepts arrays only, so remote progress is always null.

## World rulings that touch classes

- Lava (user ruling 2026-11-16, option c): lava hexes stay walkable, and nothing is built or planted on them. This is the current code, unchanged. Units still move onto lava (resolver movement does not test the biome). Priest (Shrine), Animator (copy) and Seeker (plant) place through join-plan.mjs `hexWalkableAt` (peer.mjs `buildSiteFree`, the Seeker `isBlocked`), which refuses water / lava / mountains / cliffs (biome.js `isWalkable`). A foreign class that places a building or a trap must refuse lava hexes the same way. No hook change.

## Class rebalance rulings 2026-11-17 / 2026-11-18 (CR, data versions tagged `cr_2026_11_19`)

Hook changes (JS in classes.mjs = JsonLogic in classes-data, shadow-checked); peer.mjs side in `// CR:`-tagged hunks (tools/out/_cr_peer_hunks.py).

- Weapon master 1.1.0: `local` gives `{op: draw, n: 1, max_hand: 3}`; peer.mjs draws only while the hand holds ≤ 3 cards.
- Druid 1.2.0: `ability` raises up to 2 stones (free stats best first, then the stood stones lowest first), one point-buy each (salt `…:druid:<action>` / `…:2`); all rolls failing keeps the ability ready.
- Elementalist 1.2.0: `perAction: true` — peer.mjs never marks it used for the turn (once per action).
- Healer 1.1.0: `ability` heals me AND the adjacent ally (the one pointed at, else the first adjacent non-enemy by id).
- Priest 1.2.0 / Seeker 1.2.0: data `max_standing: 1` (class-world `maxStanding`); peer.mjs turns the older Shrine into a `gone` world edit / lifts the older Seeker trap (card to my discard). Seeker becomes `once_per_round`.
- Prophet 1.2.0: data `range: 3, contact: 3`. Witch 1.2.0: data `range: 1` (3 cards). Avenger 1.2.0: `ability_kind: tap` (chase bonus unchanged).
- Guardian 1.2.0: `end_turn` arg `movedRounds` (hg.round indices); data `still_actions: [2, 3]` — a move on the 1st action does not cost the heal.
- Manipulator 1.2.0: data `trigger: attack` → `combat_in` uses class-manipulator `attackHit` (an action damage entry with `why: 'Attack'`).
- Shaman 1.1.0: colours Vitality / Souls / Water. Overlord 1.2.0: Souls removed ("Solus" read as Souls). Reaver 1.2.0: colours Vitality / Souls.
- Rogue 1.3.0: data `shared_charge: true` (class-traps `rogueShared`) — `step` returns no stealth when the step dodges a trap; peer.mjs zeroes the other charge once one is used.
- Monk 1.2.0: no `stance` (EP no longer fights as Move); `emits` M / EM unchanged.
- Noble 1.1.0: data `lifesteal: {from: attack, max_per_action: 1}` — `lifesteal` args `source`, `why`; `lifesteal_apply` caps the heal.
- Assassin 1.1.0: data `vs_hurt_only: true` — `attack_out` arg `defender`; +1 only when its snapshot life < `life_max`.
- Enchanter 1.1.0: `static`, `emits: {A, B, M}` at every site, `plan_emits` gone; colours Air / Water / Earth / Fire. Its A / B now keep a channel (channel-rule).
- Barbarian 1.3.0: `stance: {EP: B, EM: B}` — EM fights as a Block and still moves (ruling 2026-11-19, like the Reaver's EM: peer.mjs `moveAs`); only a real Block card emits and keeps the channel (the EM stays an Empty Move there).
- Alchemist: unchanged (recharge-by-casting is priced by the validator's `p_recharge_emit`).

## Class picks 2026-11-19 (CP, user picks of CLASSES_BALANCE "Proposals 2026-11-19", tag `cp_2026_11_19`)

Today's uncommitted CR versions amended in place; Bard 1.1.0 appended. peer.mjs side in `// CP:`-tagged hunks (tools/out/_cp_peer_hunks.py, applied). The answers to the open items (tag `cp2_2026_11_19`) amend the same versions.

- Weapon master 1.1.0: `local` gives `{op: draw, n: 2, max_hand: 3}`; peer.mjs CLASS_LOCAL draws `local.n` cards (hunk `wm_draw_n`). Colours without Water.
- Druid 1.2.0: data `chain_stones: true` — `ability` rolls the 2nd point-buy only when the 1st succeeded; a failed 1st keeps the ability ready.
- Healer 1.1.0: data `unmoved_only`, `ally_required` — `ability` arg `moved` (peer.mjs `!!moveCodeOf(r)`, hunk `healer_moved`): moved → not used; no adjacent living ally → not used (the card stays untapped).
- Priest 1.2.0: data `building.heal: 2` — class-world `priestConfig().heal`, `shrineMade` power `{kind: mend, n: 2}`, `copyMade` drops `n` (a copy mends 1); peer.mjs turn-end mend heals `power.n` (hunk `shrine_heal_n`).
- Seeker 1.2.0: colours Time / Space / Souls / Earth. Bard 1.1.0: colours Time / Space / Souls / Harmony. Noble 1.1.0: + Time, Space.
- Witch 1.2.0: data `self_discard: 1` — `ability` adds `{on: me, n: 1, seed: …:self, self: true}` to `discards` (the peer's forced-discard loop applies it; never a card in play).
- Avenger 1.2.0: data `chase_bonus.max_only: true` — `chase_step` returns `heal: 0` (`heal` = `grant` without max_only); std `life_points` loses the max-only point first but counts it in no `absorbed`; peer.mjs adds `st.heal` to life and refunds the max drop of a lost / faded max-only point (hunks `avenger_*`).
- CP2 Elementalist 1.2.0: + Concentration, Vitality (7 colours). Assassin 1.1.0: + Air, Water (7 colours).
- CP2 Druid 1.2.0: data `fail_spends: true` — `ability`: every rolled point-buy failed → `used: true`, no stone, `mine` = the fail lines (the tap is spent; no peer change, `useAbility` taps).
- CP2 Healer 1.1.0: data `untap_emissions: 4` — std `progress` (untap only, N an integer above the colour count): every fresh colour counts in `progress.n`; a round with every colour done restarts (`done: []`); `n ≥ N` → untap. `restore` is unchanged (a colour once per round). `progress.n` carries over on other events; without the knob the progress object has no `n`. Cosmetic peer hunk `healer_untap_log` (tools/out/_cp2_peer_hunks.py, applied): the step log line shows `n/N emissions`.
- CPD Druid 1.2.0 (option C, tag `cpd_2026_11_19`): data `unmoved_only: true` — the Healer's gate: `ability` arg `moved` (peer.mjs `!!moveCodeOf(r)`, every ability) → not used, the card stays untapped; no roll. On top of `chain_stones` and `fail_spends`; untap unchanged. No peer hunk.
