# chaosD6 class definitions — `chaosd6.class/1` and `chaosd6.class-lib/1`

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
  - `stance` and `emits`: Reaver, Barbarian, Monk.
  - `planEmits`: Enchanter.
  - `attackBonus`: Assassin.
  - `illusionRange`: Illusionist.
  - `hooks`: the non-std hooks the class answers. `peer:<site>` names a site that stays in peer.mjs and is documentation only.
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
| `emits` | | `code, site` | bool (`site`: `plan\|destroy\|manip\|badge`) |
| `plan_emits` | | `held, archived, usedTurn, turn, options, code, queued` | bool (Enchanter) |
| `attack_out` | | `attacker, dmg, scored` | number |
| `lifesteal` | | `attacker, amount` | number gained by me |
| `lifesteal_apply` | | `amount, life, lifeMax, held` | new life |
| `pre_cast` | | `actor, elements, salt` | `null` or `{stat, fail, dice, value}` (Elementalist) |
| `ability` | | `actor, ab, salt` | `{used, note, log[], mine[], out: {heals, armor, illusion, discards, lures, revives, traps, tokens}}`; `null` = peer-resolved |
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

The argument shapes are described in `HOOKS.md`, which also lists the peer.mjs site that calls each hook.

## The vocabulary

This is the effects' JsonLogic dialect: `effects-data/SCHEMA.md` describes the evaluator, the pure ops, `let`/`obj`/`quote`/`sort_by`/`reduce`/`call`, and `hash_int`/`point_buy_seed`, with W.sha as the resolver's sha256. A class program can use everything except the cast-bound forms `emit put out note return return_empty seed rng point_buy`. On top of that it gets read-only ctx queries:

`view(id)`, `view_ids`, `views`, `life_of(id)`, `dist(a, b)`, `enemy_of(a, b)`, `has_perm(id, p)`, `stat_of(id, stat)`, `side_of(alliance)`, `class_data(id)`, `class_flag(id, key)`, `skill_action(skill)`, `library`, `ctx_self`, `ctx_label`, `ctx_turn`, `ctx_action`, `elem_stat(el)`, `elems_of_stat(stat)`, `sha_hex(s)`

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
