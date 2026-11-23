# chaosD6 class definitions — `chaosd6.class/2` (`/1` still loads) and `chaosd6.class-lib/1`

The chaosD6-Classes program (user request 2026-11-16) splits the classes out the way the effects (E1–E6) and the skills (S1–S6) were split:

| layer | file | what |
|---|---|---|
| pure rules | `game/classes.mjs` | `CLASS_RULES` (one entry per class: flags + the hooks it answers) and the built-in JS hooks; `classHook(hook, classId, ctx, args)` |
| engine | `game/class-engine.mjs` | the hook table (`HOOK_SPECS`), validation, loading, `runHookProgram` over effect-engine.mjs `runProgram` (not modified) |
| data | `game/classes-data/` | `classes/<id>.json` (33 classes), `lib/classes_std.json`, `class.schema.json`, this file, `HOOKS.md` |
| repo | `game/classes-repo.mjs` | the chaosD6-Classes Radicle repo (`CHAOSD6_CLASSES_RID`), a thin wrapper over `defs-repo.mjs` |

`CLASS_ENGINE=js` (default) answers every hook from classes.mjs. `CLASS_ENGINE=data` runs the definitions. `CLASS_ENGINE=shadow` runs both and requires JSON-identical results: mismatches go to stderr, `CLASS_SHADOW_STRICT=1` throws, and `CLASS_SHADOW_REPORT=1` prints a tally at exit. A foreign class (`registerForeignClass`, from a player branch) always runs as data.

## A class definition

```json
{
  "schema": "chaosd6.class/1",
  "id": "class_witch",
  "name": "Witch",
  "version": "1.1.0",
  "source": { "collection": "classes", "version": "1.1.0" },
  "data":  { "ability_kind": "tap", "colors": ["elem_vitality", "elem_air", "elem_water"], "range": 3, "hand_discard": { "n": 3 }, "text": "…" },
  "flags": { "phase": "post", "needs": "enemy_near", "handDefaults": { "hand_discard": { "n": 3 } }, "hooks": ["ability", "config"] },
  "uses":  ["classes_std"],
  "hooks": { "ability": { "let": [ … ] }, "config": { "call": ["cfg_witch"] } }
}
```

- **data**: exactly the `data` of the active `data/classes.json` version. It is what `ctx.classData(id)` and the `class_data` op return. It requires `ability_kind` (`tap|once_per_round|static|passive`), `colors` (a non-empty list of distinct elements) and `text`. Other knobs (`range`, `contact`, `chase_bonus`, `building`, `distance`, `vision`, `trap_dodges_per_turn`, …) are read by the class's `config` hook. As with every data rule, append a new version and never edit a published one.
- **flags** = `classes.mjs CLASS_RULES[id]`, which is how the resolver sees the class:
  - `phase`: `pre` (resolved before the action, e.g. the Illusionist), `post` (after the action, e.g. the Healer or Witch), or `local` (applied only on the owner's peer: draw, recover, grant).
  - `needs` (the target the UI asks for): `tile | ally_or_self | enemy_near | monster_near | attach_effect`.
  - `local`: the descriptor of a local class.
  - `passiveTurn`: the card is never tapped.
  - `handDefaults`: `hand_reveal` / `hand_discard` defaults.
  - `stance` and `emits`: Reaver, Barbarian, Monk (`emits`: code → `true` for every site, or a list of sites).
  - `planEmits`: Enchanter.
  - `attackBonus`: Assassin.
  - `illusionRange`: Illusionist.
  - `invisBreaks`: action codes that also break Invisibility for a unit holding the class (Reaver: `["EP", "EM"]`, they fight as an Attack).
  - `hooks`: the non-std hooks the class answers. `peer:<site>` names a site that stays in peer.mjs and is documentation only.
- **ui** (`chaosd6.class/2` only, optional; class isolation phase 5, 2026-11-20): what the generic UI renderer of `js/main.js` shows, so the UI names no class. Keys (`class-engine.mjs UI_KEYS`), each a non-empty string:
  - `needs_hint`: what the click must carry (replaces the generic text per `flags.needs`), e.g. the Animator's "a building within 2 hexes to copy; …".
  - `ability_label`: the class card's text while it is ready (default `ready`).
  - `icon`: one glyph (≤ 4 chars) on the class card (default ⚜).
  - `notice`: what a click on a class that fires by itself says (the Prophet's "automatic — …").
  - The peer sends every class's block as `class_ui` (hello / `class_catalog`, `classes.mjs#classUiOf`), plus `reanim` = `data.destroy_reanimated` {elements, die} for a class that raises units (the reanimated pill).
  - `/1` definitions (published player branches) still load: `/1` is `/2` without `ui`; a `/1` file with a `ui` block is refused. Bots have no per-class block (user ruling 2026-11-20 #2): `tools/swarm-test.mjs` infers from `needs`, the data knobs, the hooks and `class-engine.mjs#abilityRecordsOf`.
- **resources** (optional, data only; generated classes 2026-11-23): the class's voice is the whole sound set of one chaosD6-Resources unit, `{"unit": {"race", "unit"}, "sounds": {"voice": [{"path", "kind", "line"?}]}}`. There are 1..16 lines, each `assets/Sounds/Units/<race>/<unit>/….wav` inside that unit's folder, with no `..` (`class-engine.mjs validateClassResources`). Nothing in a game reads it yet.
- **uses**: the libraries whose subs `call` may reach, searched in order.
- **hooks**: hook name → program. A hook that is absent falls back to the lib default for std hooks, or to the neutral value for the others.
  - A built-in class may instead give a marker, `{"engine": "js", "impl": "peer.mjs#animatorCopy", "note": "…"}`. This is used only for the 5 abilities that need map geometry, occupancy or the move register: Animator, Priest, Cleric, Seeker and Warrior.
  - A foreign class must give a program for every hook it declares.

## Hooks

A program sees the hook arguments as root registers (`{"var": "cs.archived"}`) plus `class` (its own id). The program's **value** is the hook result. Maps are passed as `[[k, v]…]` pairs and Sets as arrays. Each result is shape-checked (`resultOk`). A program that fails, by exceeding the op budget or depth, raising a program error or returning a bad shape, yields the hook's neutral value (`neutralOf`) and is tallied in `classShadowStats.errors`. A ctx query that throws propagates, exactly as in JS.

| hook | std | args | result |
|---|---|---|---|
| `colours` | ✓ | – | `[[stat, [elem…]]…]` pairs → `{stat: [elem…]}` |
| `kind` | ✓ | – | `tap \| once_per_round \| static \| passive` |
| `ready` | ✓ | `cs, held, turn` | bool: the ability may be used now |
| `config` | ✓ | – | object: the class's resolved knobs |
| `strike` | ✓ | `cs, cols, stat, elem, enemy, pb` | `null` (no target) or `{result: retry\|destroyed\|too weak, ok, last}` (die of 6) |
| `restore` | ✓ | `cs, cols, stat, kind` | bool: this colour is owed for a `recast` / `untap` |
| `progress` | ✓ | `state, cols, co` | `{state: {down, archived, tapped, progress}, event}` |
| `life_points` | ✓ | `dmg, illusion, armor, chaseBonus` | `{illusion, armor, chaseBonus, absorbed}` (shields go first) |
| `stance` | | `code` | the code it fights as, or `null` |
| `stance_target` | | `cands` | id, or `null` (Reaver auto-target) |
| `emits` | | `code, site` | bool (`site`: `plan\|destroy\|manip\|badge`; since the 2026-11-16 rulings the built-ins answer the same at every site) |
| `reanimated_strike` | | `down, stat, elem, enemy, pb` | `null` (no open element of `stat`, or not in reach) or `{result: retry\|destroyed\|too weak, ok, last, elem}`. It is asked of the class in a unit's `raised_by` (Necromancer: Harmony + Concentration, die of 6) |
| `plan_emits` | | `held, archived, usedTurn, turn, options, code, queued` | bool (Enchanter) |
| `attack_out` | | `attacker, dmg, scored` | number |
| `lifesteal` | | `attacker, amount` | number gained by me |
| `lifesteal_apply` | | `amount, life, lifeMax, held` | new life |
| `pre_cast` | | `actor, elements, salt` | `null` or `{stat, fail, dice, value}` (Elementalist) |
| `ability` | | `actor, ab, salt` | `{used, note, log[], mine[], out: {heals, armor, illusion, discards, lures, revives, traps, tokens}}`, plus the engine requests `copy_building, build, far_trap, disable_traps, step` (phase 3, HOOKS.md "Ability requests") |
| `transmute` | | `id, outcomes` | `{edits: [{i, statTokens, heals}], log}` |
| `destroy_result` | | `d` | the destroy outcome's `result` |
| `end_turn` | | `held, moved, life, lifeMax` | life gained |
| `step` | | `threatReady, ring, trap, wtrap, building, trapLeft` | `{stealth, trap: none\|dodge\|disable\|spring}` |
| `dungeon_step` | | `trap, trapLeft` | `none\|dodge\|disable\|spring` |
| `combat_in` | | `list` | bool (Manipulator: a real hit this round) |
| `pick_target` | | `seed, cands` | id or `null` |
| `chase_step` | | `state, chasing` | `{chasers, bonus, fresh, grant, fade}` |
| `contact` | | `foes` | id or `null` (Prophet) |
| `local` | | – | `null` or `{op: recover\|draw\|grant, …}` |
| `share_skills` | | `actor, skills, adj` | `{adds: [{on, skill}], log}` (Bard) |
| `blocked` | | `fallen_near, archive_creature` | `null` or the reason the card cannot be clicked now (Necromancer; UI / planning only) |

The argument shapes are described in `HOOKS.md`, which also lists the peer.mjs site that calls each hook.

## The vocabulary

This is the effects' JsonLogic dialect: `effects-data/SCHEMA.md` describes the evaluator, the pure ops, `let`/`obj`/`quote`/`sort_by`/`reduce`/`call`, and `hash_int`/`point_buy_seed`, with W.sha as the resolver's sha256. A class program can use everything except the cast-bound forms `emit put out note return return_empty seed rng point_buy`. On top of that it gets read-only ctx queries:

`view(id)`, `view_ids`, `views`, `life_of(id)`, `dist(a, b)`, `enemy_of(a, b)`, `has_perm(id, p)`, `stat_of(id, stat)`, `side_of(alliance)`, `class_data(id)`, `class_flag(id, key)`, `class_state(id, cls)` (one class's namespace of a unit's class state, snapshot `class_state_json`, `{}` if none), `class_state_union(key)` (a list key over every unit and class namespace, sorted), `skill_action(skill)`, `skill_is_trance(skill)` (true for the trance skill, i.e. its definition's `flags.trance`, so no class program names a skill id; a ctx without `skillIsTrance` answers false), `library`, `ctx_self`, `ctx_label`, `ctx_turn`, `ctx_action`, `elem_stat(el)`, `elems_of_stat(stat)`, `sha_hex(s)`

and pure helpers:

`num(x)` (= `Number(x)`), `is_int`, `json_list(s, default)` (= peer `parseJson`), `csv`, `with_key(o, k, v)`, `type_of`, `keys`, `has_key`.

Limits per hook call (`CLASS_LIMITS`): 50,000 ops, depth 64, `range` ≤ 256.

To mirror JS exactly, a program must follow JS's edge cases: `!(d > 1)` is not the same as `d <= 1` when d is NaN; `!Number(x)` is `{"!": {"+": [x]}}`; `??` is written with `is_null`; `||` is `or`; and `!!x` is written as `bool`, because JsonLogic's `!!` treats `[]` as false.

## The library `classes_std` (`chaosd6.class-lib/1`)

```json
{ "schema": "chaosd6.class-lib/1", "id": "classes_std", "version": "1.0.0",
  "defaults": { "colours": "colours", "kind": "kind", "ready": "ready", "config": "cfg_default", "strike": "strike", "restore": "restore", "progress": "progress", "life_points": "life_points" },
  "subs": { "nat": { "params": ["x", "d"], "doc": "…", "body": … }, … } }
```

`defaults` gives the program of every std hook for a class without its own, and only std hooks may have defaults. `subs` holds 35 subroutines: the config readers (`cfg_rogue`, `cfg_cleric`, …, the same formulas as class-*.mjs), the ability helpers (`done`, `not_done`, `ab_peer`, `ab_tile`, `near_ally`, `foes_nearby`, `pick_by_salt` = effects.mjs `pickBySalt`, …) and the std hooks.

## Checks

- `node tools/classes-check.mjs` (C1): compares classes.mjs with verbatim copies of the inline peer.mjs class code over seeded worlds, checks the table identities and runs worked examples from the rulings.
- `node tools/class-engine-check.mjs` (C2): compares the definitions with the JS hooks over N worlds per class and hook, then checks limits, denied ops, foreign classes and classes-check under shadow and data.
- `node tools/classes-repo-check.mjs`: covers the repo layer, the manifest, the template, the validator pin, and the sync dry-run.
- `node tools/classes-rebalancing-check.mjs check`: checks the power of each class against the fitted curve (±10%).

## Lava (user ruling 2026-11-16, option c)

Lava hexes stay walkable, and nothing is built or planted on them. This is the current behaviour, so there is no data or hook change. A class whose ability places something on the map (a building, a Shrine, a copy, a planted trap) must refuse lava hexes, as the built-in Priest, Animator and Seeker do through join-plan.mjs `hexWalkableAt` (biome.js `isWalkable` refuses lava). Unit movement onto lava is unchanged.

## Foreign classes (handshake)

**Built-in classes (phase 6, user ruling 3)** travel by name + pin: the holder's snapshot `cl_key` = `clKey` of the bundled definition and its libraries (16 hex). Every peer compares it with its own bundled copy once per action; a different or missing pin means another version, so the peer withholds its state hash for the action (`CLASS VERSION GATE`, UI notice `version`). The bundled set is the pre-seeded cache; two versions of one built-in id never run side by side. See HOOKS.md "The split".

A foreign class is a definition from a player branch of chaosD6-Classes. Its id is not a built-in id: a variant of a built-in is a new id that `extends` it. It travels by ref `{id, sha256, libs, repo?, branch?, commit?, name?, verdict?}` (game/classes-handshake.mjs, the twin of the effects and skills handshakes).

- **Where the ref rides.** On the holder: the snapshot `cl_ref_json` (slim, a JSON string because Gun is flat), `cl_have` (the foreign classes a peer holds and serves), `cl_set` (the bundled set, full heartbeat), and the Door `cl_ref` (own and every known member). On the actions: the commit and the reveal carry `cl_ref` (the revealer's class), and the reveal carries `cl_missing` (the sha256 of every foreign class in play that this revealer cannot run).
- **How peers learn it.** Over libp2p `/chaos/<dim>/classes/1`, the Nostr bus `cl` events, then git (`CHAOSD6_CLASSES_DIR`) / radicle-httpd (classes-repo.mjs). The content is checked against its sha256. Then come validateClassDef, the C3 validator (`classes-rebalancing-check.mjs` checkClass: a `reject` verdict refuses it) and `registerForeignClass`.
- **Fallback.** A foreign class whose sha is in any revealer's `cl_missing` is dormant for that resolution on every peer (`suspendForeignClasses`: no flags, no data, every hook answers as for an unknown class). If a class in play is neither dormant nor ready on this peer, the peer abstains: it publishes `state_hash ''` for that action. The region tag per revealer is `cl:<key16>`, `dormant:<key16>`, `missing:<key16>` or `bad:<id>`.
- **Switches.** `FORCE_FOREIGN_CLASS=<def.json>` (dev / test: boot with it; `tools/classes-handshake-check.mjs --write-fixture <f>` writes the Marauder, a player branch of the Reaver). `CL_ACCEPT=0` refuses every foreign class. `CL_VALIDATOR=0` skips the validator. `CL_HTTPD=0` turns off the httpd fallback. `CHAOSD6_CLASSES_CACHE=memory` keeps the content cache in memory. `CL_REVEAL_WAIT_MS` / `CL_RESOLVE_WAIT_MS` / `CL_BOOT_WAIT_MS` set the waits.
- **Profile.** A profile character may hold `class_id` = a foreign id together with `class_ref`. The peer boots it from the content cache (then git / httpd), and if that fails it falls back to the built-in path.
- **Limits.** These tables are built from CLASS_RULES at load, so a foreign class does not join them: `PASSIVE_TURN_CLASSES` (passive once-per-turn firing) and the `handDefaults` table. A foreign class can have no peer-resolved ability (no JS markers).
