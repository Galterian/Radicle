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
| a class-raised unit's snapshot: `raised_by` (env `RAISED_BY` of a class companion, or a bound revive by a `class_` perm) and `reanim_down_csv` (`reanimFields()`, ~942) | – | Necromancer | peer (absent on every other unit) |

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
| Necromancer | tap | post | ability, reanimated_strike | archived-creature revive; raised_by / reanim_down_csv snapshot fields |
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
- Necromancer "destroy reanimated" (was: not implemented). User ruling 2026-11-16: hook `reanimated_strike`; class_necromancer 1.1.0 data `destroy_reanimated: {elements: [elem_harmony, elem_concentration], die: 6}`. Reading: a unit the class raised (a corpse raised in place, a re-spawned summon, an archived creature) carries `raised_by: class_necromancer`. An adjacent enemy emits Will at it (`destroy: {stat: "will", reanimated: <peer>, elem}`, on any emitting action). A point-buy die of 6 strikes that element, one per emission, in any order, and the emissions need not be contiguous. When both are struck, the unit is destroyed. Ordinary damage still kills it, and a reanimated corpse is never raised again. To confirm with the user: (a) "destroy" is an extra way for enemies to kill it, not an immunity to damage; (b) the two strikes may come from different enemies.
- Open (not covered by the rulings): a Barbarian Block, like a Reaver Attack or a Monk Move, still breaks a channel (`CHANNEL_BREAK`). Emitting during it does not keep a channel alive.
- `classStateOf` parses `class_progress_json` with `parseJson(…, null)`, which accepts arrays only, so remote progress is always null.

## World rulings that touch classes

- Lava (user ruling 2026-11-16, option c): lava hexes stay walkable, and nothing is built or planted on them. This is the current code, unchanged. Units still move onto lava (resolver movement does not test the biome). Priest (Shrine), Animator (copy) and Seeker (plant) place through join-plan.mjs `hexWalkableAt` (peer.mjs `buildSiteFree`, the Seeker `isBlocked`), which refuses water / lava / mountains / cliffs (biome.js `isWalkable`). A foreign class that places a building or a trap must refuse lava hexes the same way. No hook change.
