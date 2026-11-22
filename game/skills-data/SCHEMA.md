# Skill definitions as data (chaosD6-Skills, milestone S2)

A skill is one JSON file `skills/<skill_id>.json` (schema `chaosd6.skill/2` for the built-ins — `deal_order`, `card`,
`ui`; `chaosd6.skill/1` still loads, for foreign skills, which are never dealt). Since the skill isolation
(2026-11-22) the game is skill-oblivious: every table it used to hard-code (deal order, SKILL_RULES, TRANCE, the pass
order, the building skills, the plan locks, the cards, the UI tags / glyphs) comes from these files, and a new skill
needs changes only here. Its `hooks` map the hook points of
`game/skills.mjs#skillHook` (inventory, call sites, resolver order: `HOOKS.md`) to programs in the effects'
JsonLogic dialect (`game/effects-data/SCHEMA.md` — same evaluator, op budget, depth limit). Shared subroutines and
the std programs live in `lib/<id>.json` (schema `chaosd6.skill-lib/1`). Engine: `game/skill-engine.mjs`, dispatch:
`game/skills.mjs`. Structural JSON schema of both file kinds: `skill.schema.json`.

```
game/skills-data/
  SCHEMA.md  skill.schema.json  HOOKS.md
  skills/skill_dodge.json …          one definition per skill (14 built-ins)
  lib/skills_std.json                subroutines + the std programs of the per-skill hooks
  lib/skills_pass.json               subroutines of the pass-hook programs (edit records)
  oracle/skills-js.mjs               TEST ORACLE: the JS reference hooks + the frozen pre-isolation tables (never run by the game)
```
S3 (`tools/skills-repo-sync.mjs`) mirrors this layout into the chaosD6-Skills repo; S5's validator reads the same files.
A content hash of a skill must cover the skill file AND every library it `uses`.

## Engine switch

`SKILL_ENGINE=data` (default since the skill isolation) | `js` | `shadow`, read once by `skills.mjs`:
- `data` — every hook runs the program of the skill's definition (`SKILL_DEFS_DIR=<dir>` points the loader elsewhere).
  A hook marked `{"engine": "js", "impl": "skills.mjs#…"}` runs the oracle's JS hook when the oracle is installed, else
  its neutral value; `"impl": "peer.mjs#…"` (Force Shield `end_round`) is always neutral — peer.mjs does that part.
- `js` — the JS reference hooks of the TEST ORACLE `oracle/skills-js.mjs` (moved out of skills.mjs verbatim).
- `shadow` — both run; results must be JSON-identical (key order included; for `damage_in` the edited damage map and
  the pushed `skillFx`); a mismatch goes to stderr (`[skills] SHADOW MISMATCH …`), `SKILL_SHADOW_STRICT=1` throws;
  the JS result is returned. `SKILL_SHADOW_REPORT=1` prints a tally at exit.
- `js` and `shadow` need the oracle: `SK.installSkillOracle(await import('./skills-data/oracle/skills-js.mjs'))` (the
  caller does it — skills.mjs has no dynamic import, so skills-repo-sync's engine closure never pulls the oracle in).
  Without it the first hook call throws `SKILL_ENGINE=js needs the JS oracle: call installSkillOracle() …`.
- The bundle is loaded eagerly and leniently at import: an invalid definition is left out and reported by
  `skillBundleErrors()` (peer.mjs should refuse to start while it is not empty).
- A program error or limit in `data` mode gives the hook's **neutral value** (what the JS hook returns when the skill
  is not in play) and a `[skills] data hook:` line on stderr — deterministic on every peer. A ctx query that throws
  propagates (same as JS).
- `planning` calls `ridesOn` directly (peer.mjs), so `rides` in data only changes `skillHook('rides', …)` callers.

API (skills.mjs): `skillHook(hook, id, ctx, args)`, `resolveSkillProgram(def, hook, ctx, args)` (run ONE definition —
S5's audit), `validateSkillDef(def, {libs|libMap})`, `registerForeignSkill(key, id, flags, hooks[, opts])`,
`isForeignSkillId(id)`, `foreignSkillDef(keyOrId)`, `clearForeignSkills()` (tests), `skillBundle()`,
`skillBundleErrors()`, `SKILL_ENGINE`, `skillShadowStats`, `installSkillOracle(mod)`, `skillOracle()`; the derived tables
`SKILL_RULES` (flags, deal order), `SKILLS_IMPLEMENTED` (deal order), `NEGATING_SKILLS`, `TRANCE` (the id with
`flags.trance`), `BUILDING_SKILLS` (`flags.buildingSkill` order), `PLAN_LOCKS` (`flags.planLock` / `selfLock.codes`),
`builtinSkillEntries()` (`{id: {id, name, tags, data}}` from the cards, deal order — what peer.mjs used to read from
data/skills.json), `builtinSkillCatalog()` (a data/skills.json-shaped collection for the browser / Godot), `SKILL_UI` /
`skillUiOf(id)` (the `ui` block + `trance`, `keeps_target`, `attack_reach` (flags.reach, 1 = contact), `rest_keeps`
(flags.invincibleWhile or null)), `sanctuaryBreaks(reveal[, keeps])`, `ridesOn`, `ridesFor`, `passHookData`.
skill-engine.mjs: `loadSkillDefs(src, {builtinIds, lenient})` (→ `{defs, libs, std, errors}`), `validateSkillDef`,
`validateCard`, `validateUi`, `validateSkillLib`, `HOOK_SPECS` (pass `order` derived from the built-ins' flags.passOrder),
`PASS_HOOKS`, `derivePassOrders(defs)`, `setBuiltinPassOrders(defs)`, `SKILL_OPS`, `SKILL_CTX_OPS`, `SKILL_LIMITS`,
`runHookProgram`, `neutralOf`, `resultOk`.

## Definition fields

| field | meaning |
|---|---|
| `schema` | `"chaosd6.skill/2"` (built-ins) or `"chaosd6.skill/1"` (foreign; no `deal_order` / `card` / `ui`) |
| `id`, `name`, `version` | `skill_[a-z0-9_]+`, display name, semver of THIS definition (bumped by the isolation) |
| `source` | provenance of the metadata (`data/skills.json` active version it was copied from — data/skills.json is a frozen record now) |
| `deal_order` | /2 built-ins (required, integer ≥ 1, unique across the built-ins): position in the deal order (`SKILLS_IMPLEMENTED`, every "in deal order" fold). A foreign skill has none — it is never dealt |
| `card` | /2: `{name, tags, resources, data, rebalance_links, logic}` — exactly the data/skills.json entry (name / tags / resources) and its active version (data / rebalance_links / logic); `card.data` keys `action_type, is_permanent, point_buy_stat, text` (required) `, element, fixed_power` must equal the top-level fields (same shape as an effect's card) |
| `ui` | /2: `{tag, glyph, color}` (strings, required for a built-in) + optional `card_glyph`, `card_color` (when the skill card glyph differs from the map icon), `rest_hint` (the rest-slot hint text, Sanctuary) |
| `fixed_power` | permanent only, 1..6: lands with that Rule 24 power, no roll (Force Shield 6) |
| `action_type` | `A · M · B · P` — the action card it rides on (M / P also on EM / EP; Battle Trance on anything) |
| `is_permanent`, `point_buy_stat` | permanent (Rule 12 landing, Rule 24 destruction) and its stat `stat_vitality · stat_world · stat_matter · stat_will · any`; `null` for an instant |
| `element`, `text` | optional, from data/skills.json (documentation) |
| `flags` | resolver + validator metadata (below) |
| `uses` | library ids whose subroutines `call` may name (`["skills_std"]`) |
| `hooks` | `{ <hook>: <program> }` or, for a built-in hook kept in JS, `{ <hook>: {"engine": "js", "impl": "skills.mjs#…", "note": "…"} }` |

### `flags` — two vocabularies in one object

| vocabulary | keys | read by | checked by |
|---|---|---|---|
| **resolver** (= `skills.mjs#SKILL_RULES[id]`, same key order) | `action`, `permanent`, `pointBuyStat` (`'any'`), `negating` (judged by whether it did its job — ruling 2026-11-12), `hooks` (the hook points it acts in, incl. peer-side `plan` / `move`), `range`, `negates`, `keepsTarget`, `trance`, `attackBonus`, `damageOff` | peer.mjs / bots / UI (via SKILL_RULES); in `data` mode the programs read them with `skill_flag` | skill-engine-check: equal to SKILL_RULES |
| **validator** (S5 `skills-rebalancing-check.mjs#FLAG_KEYS`, what a skill is priced by) | `attackBonus`, `damageOff`, `negate {codes, who, mode}`, `altCounterSkill`, `counterSkill`, `counterElement`, `trance`, `blockImmune`, `trapImmune`, `tauntGuard`, `immuneTo`, `restInvincible`, `effectShield` | the validator (`normalizeDef` drops the resolver-only keys `hooks negating range keepsTarget notes action permanent pointBuyStat negates`) | skill-engine-check: equal to `BUILTIN_FLAGS[id]`; S5: a built-in is ok in baseline mode |

Shared keys (`attackBonus`, `damageOff`, `trance`) mean the same in both and carry the same value. Every other key
belongs to exactly one vocabulary; an unknown key is an error for the validator.

`SKILL_RULES[id]` is now the deep-cloned `flags` of the definition (resolver keys first); tools/skill-engine-check.mjs and
skills-check.mjs compare its resolver keys with the oracle's frozen pre-isolation table (`SKILL_RULES_REF`).

**Isolation flags** (validated by skill-engine.mjs; resolver-side, ignored by the validator's pricing):

| key | meaning | rule |
|---|---|---|
| `passOrder` | `{<pass hook>: n}` — this built-in's place in the pass (`HOOK_SPECS[hook].order` = the built-ins sorted by n, then id): `counter_pre` Counter Spell 1; `negate_action` Bluff 1, Intimidation 2; `negate_kind` Grapple 1, Disruption Move 2, Overrun 3; `trance_assign` Battle Trance 1 | pass hooks only, integer ≥ 1, (hook, n) unique; a /2 built-in with a pass program must have it |
| `buildingSkill` | 0-based slot in the building-bonus skill list (`BUILDING_SKILLS`, part of the (seed, q, r) contract): Dodge 0, Powerful Attack 1, Intimidation 2, Grapple 3, Disruption Move 4, Bluff 5, Counter Spell 6 | integer ≥ 0, unique |
| `planLock` | the codes a skill that paid off still allows this round (`plan_lock`) | non-empty list of `A B M P EM EP`; Powerful Attack uses the existing `selfLock {codes: ['A'], until}` instead (`PLAN_LOCKS` reads `planLock`, else `selfLock.codes`) |
| `trance` | the skill plays two actions (`TRANCE`, lib `ps_non_perm`) | Battle Trance |
| `reach`, `invincibleWhile` | UI facts (`skillUiOf`: `attack_reach`, `rest_keeps`) | Ranged Weapon 2; Sanctuary `[M, EM, EP]` |

## Hooks

Every program sees the registers below plus `skill` (its own id — a program tests `has_skill(attacker, skill)`, not a
literal id, so a foreign copy works unchanged). Maps arrive as `[[key, value]…]` pairs (`call pair_get`), Sets as arrays.
`kind` = how `skillHook` combines the participants of one call: the named built-in (or, with id `null`, every
built-in with a program, in deal order), then registered foreign skills in id order.

| hook | engine | kind | registers | result | std default |
|---|---|---|---|---|---|
| `rides` | data | single | `codes, req` | bool | `rides` |
| `plan_target` | data | single | `skillIds` | bool (any skill with `flags.keepsTarget`) | `plan_target` |
| `counter_pre` | data | pass (sorted reveals) | `r, actor, phase, carry` | edit records (`skills`, `fx`, `trance_collapse`, `pen`, `log`, `continue`) | |
| `negate_action` | data | pass (Bluff → Intimidation) | `r, actor, phase, carry` | edit records (`set_code`, `drop_trance`, `replace`, `skills`, `fx`) | |
| `negate_kind` | data | pass (Grapple → Disruption Move → Overrun) | `r, actor, phase, carry` | edit records (`replace`, `no_move`, `no_emit`, `swap`, `fx`) | |
| `trance_assign` | data | pass | `r, actor, phase, carry` (+ ctx `by_actor, code_vs, attacks_on`) | edit record `trance {vs, played}` | |
| `block_in` | data | or | `defender, blocker` | truthy = the Block deals nothing | |
| `block_cost` | data | max | `attacker, defender` | number | |
| `attack_range` | data | max | `attacker, code` | hexes the strike reaches (neutral 1) | |
| `attack_out` | data | chain `dmg` | `attacker, dmg` | dmg | |
| `attack_target` | data | or | `attacker, defender` | truthy = this Attack deals 0 | |
| `attack_vs_block` | data | or | `attacker, defender` | truthy = the defender's Block does not count against this Attack | |
| `defend_in` | data | chain `dmg` | `code, defender, dmg, byActor` (pairs id → reveal with `declared`) | dmg | |
| `damage_in` | data | edit | `damage` (pairs victim → `[{source, amount, attacker}]`) | `{edits: [{victim, i, amount}], fx: [skillFx records]}` — the dispatcher sets `damage[victim][i].amount` and pushes `fx`, in order | |
| `effect_in` | data | first | `defender` | the shield die (0 = none) | |
| `effect_leg` | data | single | `shield, sum` | `{shield, sum, spent}` | |
| `end_round` | data | single | `reveal` (my reveal) | bool: Sanctuary falls | |
| `perm_landing` | data | each id of `skillIds` | `skillIds, playedCodes (array or null), stats` + `skill` = that id | `{id, stat[, power]}` or null (nulls dropped; `power` 1–6 = a fixed landing power, no roll) | `perm_landing` |
| `perm_stats` | data | single | — | `[stat…]` | `perm_stats` |
| `disposition` | data | single | `fx, self` | `permanent · negated · countered · spent · unused · judge` | `disposition` |
| `plan_lock` | data | single | `paid` | the action codes still allowed this round, or null (neutral) | |

A result of the wrong shape (e.g. a string from `attack_out`) is replaced by the neutral value. Force Shield's
`end_round` is marked `{"engine": "js", "impl": "peer.mjs#endRound"}`: the falling of a spent shield is peer
bookkeeping (the die spent by `effect_leg`), there is no rule left to run.

**Data / JS split (S2):** data — `rides, plan_target, block_in, block_cost, attack_range, attack_out, attack_target,
attack_vs_block, defend_in, damage_in, effect_in, effect_leg, end_round, perm_landing, perm_stats, disposition, plan_lock`
(attack_range, attack_vs_block, plan_lock and block_in's `blocker`: SKILL REBALANCE 2026-11-16); since MV 2026-11-17 also
the pass hooks `counter_pre, negate_action, negate_kind, trance_assign` (Counter Spell, Bluff, Intimidation, Grapple,
Disruption Move, Overrun, Battle Trance) — programs in the skill files + `lib/skills_pass.json`.

### Pass hooks as data: ordered edit records (MV 2026-11-17)

They edit the resolver's registers in place and later skills read the edits of earlier ones in the same pass
(Intimidation sees Bluff's EP; Overrun's target choice reads codes rewritten by Grapple). The dispatcher
(skills.mjs `dataPass`) runs one program per (reveal, skill) — reveals sorted by actor (`counter_pre`) or in live order,
skills in `HOOK_SPECS[hook].order` (derived from the built-ins' `flags.passOrder`) — with root registers `{skill, r, actor, phase, carry}`; the program returns edit
records (`skill-engine.mjs PASS_OPS`) that are applied in order before the next program runs, so `code_is` /
`reveal_of` see them:

| record | applied as |
|---|---|
| `set_code {id, code}` / `drop_trance {id}` / `replace {id, from, to}` | `effAction.set` / `tranceOpts.delete` / `ctx.replace` (trance-aware) |
| `skills {id, skills}` | the reveal's skills list := skills (Counter Spell's strip) |
| `fx {fx}` / `log {text}` | `skillFx.push` / `ctx.log` |
| `no_move {id}` / `no_emit {id}` / `swap {by, on}` | `noMove` / `noEmit` / `swaps` (the last two only when the register exists) |
| `trance_collapse {id, code}` | the trance falls to `code` (Counter Spell on Battle Trance) |
| `pen {id, elem, amount}` | `counterPen[id][elem] += amount` |
| `trance {vs: [[enemy, i]…], played: [i…]}` | `r.vs` (Map) / `r.played` (Set) of the current reveal |
| `continue {carry}` | apply what came before, then run the same program again with `phase + 1` (≤ 8 phases) |

Counter Spell probes elements with the ctx query `effect_dmg_pen [o, def, el, amount]` (sets, reads and restores
`counterPen` — the JS `bestElem` probe). A program error / limit / bad record stops that (reveal, skill) run with the
records already applied, counted as a data-hook error. Shadow mode runs data on the real registers, snapshots them,
restores, then runs JS; every register, the reveals' `skills / trance / vs / played` and the logs must be identical.
Foreign skills with a pass program run after the built-ins' pass, foreign ids in order.

## Vocabulary (`SKILL_OPS`, 90 ops)

The effects' control forms and pure ops (`effects-data/SCHEMA.md` — `if and or seq let set call var quote obj map
filter find all some none reduce sort_by range`, maths, strings, lists, `??`, `bool`) **minus** the outcome / dice
forms (`emit put out note return return_empty seed hash_int rng point_buy point_buy_seed` — refused at load and at run
time), plus the skill ctx queries (read-only; registers come back as arrays):

| query | = resolver ctx |
|---|---|
| `has_skill [id, skill]` | `byActorPre.get(id).skills` includes skill |
| `from_building [by, skill]` | `byActorPre.get(by).buildingSkill === skill` |
| `reveal_of id`, `reveals` | the reveal of an actor (or null), all reveals of the action |
| `code_is [id, code]` | trance-aware code test |
| `has_perm [id, perm]`, `perm_power id` | permanents, powers `{perm: die}` |
| `enemy_of [a, b]`, `hidden_from [viewer, id]`, `dist [a, b]`, `life_of id` | sides, invisibility, hex distance, life |
| `view id`, `views` | one snapshot (or null) / all snapshots in view order |
| `elem_stat el`, `edge_dmg [atk, def]` | ELEM_TO_STAT, the damage matrix |
| `casts_damage o`, `effect_dmg [o, def]` | effect queries (effect_dmg reads counterPen) |
| `skill_data id` | the skill's data/skills.json `data` (a foreign skill: its metadata) |
| `skill_flag [id, key]` | a key of the skill's `flags` |
| `ctx_self`, `ctx_has name` | my peer id; whether the ctx has a query |

New pure op in effect-engine.mjs (S2): `bool x` = JS `!!x` (JsonLogic `!!` treats `[]` as false).

**Limits** (`SKILL_LIMITS`): 20 000 evaluated operations per hook call, depth 64, `range` ≤ 256.

## Library `skills_std` (lib/skills_std.json)

`defaults` names the std program of each per-skill hook; `subs`: `pair_get pairs key`, `strip_stat s`
(`stat_matter` → `matter`), `rides`, `plan_target`, `perm_landing`, `perm_stats`, `disposition` (the S1 rules, see
HOOKS.md). A skill file lists the std hooks it relies on as `{"call": ["perm_stats"]}` (same program).

`skills_pass` 1.1.0 (skill isolation): `ps_non_perm` tests `skill_flag [id, "trance"]` instead of the Battle Trance id
literal (same result: Battle Trance is the only skill with `flags.trance`). No library names a skill id.

## Foreign skills (S4)

`registerForeignSkill(key, id, flags, hooks[, {meta, uses, libs, name, version}])` validates (`builtin: false` — no JS
markers, data hooks only), binds the libraries, adds `flags` to `SKILL_RULES` (never over a built-in) and, when
`flags.negating`, to `NEGATING_SKILLS`; dealing (`SKILLS_IMPLEMENTED`) is unchanged. The last registration of an id
wins. From then on the skill takes part in every data hook it has a program for — after the built-ins, foreign ids in
code-unit order — in every `SKILL_ENGINE` mode; its per-skill hooks (`perm_stats`, `disposition`, …) run its own program
or the std default on its metadata. A pass program of a foreign skill runs after the built-ins' pass (MV).

## Example (Dodge)

```json
"damage_in": {"let":[{"hits":{"filter":[{"map":[{"var":"damage"},
  {"if":[{"has_skill":[{"at":[{"var":"e"},0]},{"var":"skill"}]},
    {"let":[{"h":{"find":[{"map":[{"at":[{"var":"e"},1]},{"obj":{"i":{"var":"i"},"source":{"var":"d.source"},"amount":{"var":"d.amount"},"attacker":{"var":"d.attacker"}}},"d"]},
                          {"and":[{"===":[{"var":"x.source"},"action"]},{">":[{"var":"x.amount"},0]}]},"x"]}},
      {"if":[{"var":"h"},{"obj":{"victim":{"at":[{"var":"e"},0]},"i":{"var":"h.i"},"amount":{"-":[{"var":"h.amount"},1]},"attacker":{"var":"h.attacker"}}},null]}]},
    null]},"e"]},{"var":"y"},"y"]}},
  {"obj":{"edits":{"map":[{"var":"hits"},{"obj":{"victim":{"var":"h.victim"},"i":{"var":"h.i"},"amount":{"var":"h.amount"}}},"h"]},
          "fx":{"map":[{"var":"hits"},{"obj":{"by":{"var":"h.victim"},"skill":{"var":"skill"},"on":{"var":"h.attacker"},"what":"damage","building":{"from_building":[{"var":"h.victim"},{"var":"skill"}]}}},"h"]}}}]}
```

## Validate

`node tools/skill-engine-check.mjs` (files, /2 card / ui / deal_order, flags vs the frozen old table, ≥ 600 seeded
cases per skill per data hook vs the ORACLE's JS hooks, rejection, limits, foreign API, skills-check under shadow / js /
data, the lenient loader, the engine without the oracle, the grep gate: no built-in skill id as code in the game files)
and `SKILL_ENGINE=shadow SKILL_SHADOW_STRICT=1 node tools/skills-check.mjs` (derived tables = the old literals, worked
examples, identity vs the pre-S1 code). Pricing: `node tools/skills-rebalancing-check.mjs check skills-data/skills/<id>.json`.
