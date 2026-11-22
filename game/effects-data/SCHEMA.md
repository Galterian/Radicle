# Effect definitions as data (chaosD6-Effects, milestone E1)

An effect is one JSON file `effects/<effect_id>.json`. Its `logic` is a small program in a
JsonLogic dialect that receives the same `ctx` / `cast` as `effects.mjs#resolveEffect` and
produces the same **outcome object** (the building blocks `peer.mjs` applies). Shared building
blocks are subroutines in `lib/<id>.json`. Engine: `game/effect-engine.mjs`.
Structural JSON schema: `effect.schema.json` (both file kinds).

```
game/effects-data/
  SCHEMA.md  effect.schema.json
  effects/effect_fireball.json …      one definition per effect   (schema "chaosd6.effect/1")
  lib/std.json                        shared subroutines          (schema "chaosd6.effect-lib/1")
```
E3 mirrors this layout into the chaosD6-Effects repo; E5's validator reads the same files. A content
hash of an effect must cover the effect file AND every library it `uses`.

## Engine switch

`EFFECT_ENGINE=data` (default since effect isolation F1, 2026-11-21) | `js` | `shadow`, read once by `effects.mjs`
(`EFFECT_HOOKS_ENGINE` for `effect-hooks.mjs`, same values and default):
- `data` — an effect with a definition runs on `resolveEffectData`; one without has no rules (`noRulesOutcome`, fizzles).
- `js` — the JS reference engine `resolveEffectJs` (the `EFFECT_RULES_JS` table): a test oracle.
- `shadow` — both run; the outcomes must be JSON-identical (key order included); a mismatch is
  logged to stderr (`[effects] SHADOW MISMATCH …`), thrown with `EFFECT_SHADOW_STRICT=1`; the JS
  outcome is returned. `EFFECT_SHADOW_REPORT=1` prints a tally at exit.
- `EFFECT_DEFS_DIR=<dir>` points the loader elsewhere (e.g. a clone of the effects repo).

API: `loadEffectDefs(dir | {effects, libs} | [defs]) → Map(id → def)` (validates, throws on a bad file),
`resolveEffectData(def, ctx, cast[, {limits, libs}]) → outcome`, `validateEffectDef(def, subs)`,
`validateLib(lib)`, `ALL_OPS`, `OUTCOME_ARRAYS`, `OUTCOME_SCALARS`, `ENGINE_LIMITS`.
S2 (skills, `game/skill-engine.mjs`) reuses the evaluator through `runProgram(logic, subs, ctx, root, {ctxOps, deny, limits})`
(returns the program's value, throws on limits) and `validateLogic(logic, subs, known)`; `SPECIAL_OPS` / `PURE_OP_NAMES` are
exported for its vocabulary. Effect behaviour is unchanged (effect-engine-check identical).

## Foreign effects (E4)

A definition that is not in a peer's bundled set (a player branch) is played by ref
`{id, sha256, libs:{<lib>: sha256}, repo, branch, commit}` — the libraries it `uses` are pinned by hash, so a
ref never runs against another `std`. Peers fetch it over `/chaos/<dim>/effects/1` (bus / git / httpd fallback),
gate it with the E5 validator, and postpone a cast deterministically when any revealer lacks it. Protocol,
set ids and the fallback rule: `HANDSHAKE.md`.

## Definition fields

| field | meaning |
|---|---|
| `schema` | `"chaosd6.effect/2"` (since effect isolation F2, 2026-11-21; `"chaosd6.effect/1"` = /2 without `standing`, still loads) |
| `id`, `name`, `version` | `effect_[a-z0-9_]+`, display name, semver of THIS definition |
| `source` | provenance of the metadata (`data/effects.json` active version) |
| `elements`, `cost` | element cost in emission order; `cost = elements.length` |
| `kind` | `damage · lock · stat_token · permanent · counter · trap · relocation · surgery · summon · scouting · meta` |
| `duration` | `instant · permanent · channel · trap · cast` (stat-buy casts) |
| `every` | ∀ behaviour `{behaviour, note}` — documentation; the program reads `cast.every` / `cast.aura` |
| `text`, `every_text` | rules text (from data/effects.json) |
| `flags` | the resolver metadata peer.mjs / bots / UI read today = the `EFFECT_RULES[id]` entry (`damage, scope, range, permanent, statBuy, fixedPower, channel, trap, tileTarget, …`). Since F1 `effects.mjs` builds `EFFECT_RULES` from it (id order); `tools/effect-engine-check.mjs` holds it equal to the JS oracle `EFFECT_RULES_JS` |
| `uses` | library ids (`["std"]`) whose subroutines `call` may name |
| `logic` | the program |

## Standing programs (`standing`, chaosd6.effect/2 — effect isolation F2, F3)

What a PERMANENT does while it stands in front of its holder's deck. `standing` maps a hook to a program; peer.mjs asks the
hook at a fixed point of the round for every permanent a unit holds that answers it (`effect-standing.mjs#holding`, code-unit
id order) and applies the shape-checked VALUE with generic code. No effect id appears in peer.mjs for these.

| hook | asked | args (root registers) | value |
|---|---|---|---|
| `combat_out` | each combat strike of the holder | `holder, code, dmg, every` | the strike's damage (Inner Fire: 1 → 2) |
| `damage_in` | first damage > 0 on the holder, once per action and permanent | `holder, attacker, amount, source, every` | `{amount, spend}` — spend: the permanent is used up (Super Sense) |
| `cast_in` | an enemy cast about to hurt the holder, once per action and holder | `holder, caster, effect_id, last_elem, every` | `null` or `{bar: caster\|all, elem, spend}` — the cast is blocked, `elem` barred for the turn (Disable) |
| `adjacent_lost` | an enemy plans while adjacent to the holder | `holder, victim, every` | actions the victim loses from the end of its turn (Delay Time: 1) |
| `plan_emit` | the holder plans an emission of its cast | `holder, step, of, every` | `{extra, spend}` — `extra` more elements this action (Empower) |
| `afflicted` | the victim of an affliction this effect laid (sprung perm trap) | `holder, victim, in_contact, every` | `{no_cast, only}` — `only`: `null` or `"EP"` (Sleep, Confusion) |
| `harm_in` | an enemy effect about to touch the holder (damage, lock, penalty, forced move, possession, hand peek, a sprung trap), once per action and holder | `holder, caster, effect_id, every` | `null` or `{negate: true, spend}` — that part is dropped; spend `"every"` = the ∀ copy goes to the discard, `"perm"` = the permanent, `null` = nothing (Blessing ∀) |
| `breaks` | the holder's plays of this action (before the run, and after it with `dealt_damage`) | `holder, self, plays[{action, trance, effect_id}], dealt_damage, every, extra_codes` | `true` = the permanent falls (Invisibility: A / B / another cast; ∀: dealt damage). `extra_codes` = the holder's class codes that fight as Attack (Reaver EP / EM) |

`every` = the permanent was cast doubled (∀). Vocabulary: the control forms and pure ops of the dialect below, minus the
cast-bound forms (`emit put out note return return_empty seed rng point_buy`), plus the read-only queries `has_perm(id, p)`,
`enemy_of(a, b)`, `dist(a, b)`, `life_of(id)`. Limits per call: 20,000 ops, depth 48, `range` ≤ 64. A failing program (limit,
program error, bad shape) answers the hook's neutral value (`dmg`, `{amount, spend:false}`, `null`, `0`, `{extra:0, spend:false}`,
`{no_cast:false, only:null}`, `null`, `false`) and is tallied. `EFFECT_STANDING_ENGINE=data|js|shadow` (default data, else `EFFECT_ENGINE`);
`js` = `STANDING_JS`, the reference the built-ins were checked against (tools/effect-standing-check.mjs). A foreign effect's
programs always run as data. The validator (1.2.0) prices a standing program only if it is identical to a calibrated
built-in's (`STANDING_CALIBRATED`, at that built-in's named weight); any other is refused for now.

F2 also moved these per-id tables of peer.mjs into `flags` (resolver metadata): `everyInstant` (∀ = an instant), `everyPermanent`
(∀ shield element stays, goes with the permanent), `permTurns: n`, `lockWhileStanding` (its locks hold while the caster holds
it), `keepsCastOnDestroy` (a Rule 24 emission keeps the cast), `everyWidens` (held ∀: the next cast goes through it, spent),
`sensesTraps` (the holder knows the traps around it). F3 added `hides` (while it stands and does not `break`, enemies do not see, target or chase its holder; area effects still hit it). F7 added `naturalKind` — what a monster's natural copies do while they stand (rule_monster_natural_permanents), one of the game primitives in natural-perms.mjs: `turn_tick` (the effect casts itself on enemies in contact at the end of every turn), `ward` (enemies with lower Matter cannot enter the adjacent hexes), `link` (Spirit Link to the nearest allied creature; 2 copies = ∀), `spare_holder` / `no_damage` / `only_holder` (contact afflictions: cannot damage the holder / anyone / anyone but the holder, lifted at the tower), `lose_action`, `stone` (locked for the rest of the turn), `no_attack`. Also F7: `everyOutlastsChannel` (∀: the permanent stays when its channel breaks — Awake) and `ignoresZones` (its damage passes no-damage zones — Blizzard). F4: `bonusPlans: n` (bonus plans per action while it stands), `bonusOncePerTurn` (only once per turn — Haste), `bonusOneEmission` (every card an instant, still one element emission per action — Balefire), `everyHandSize: n` (∀: hand size + n — Haste). F5: `summon: {kind, label, need}` — the creature a stat-buy permanent holds: `library` (a library creature, need = its stat sum), `golem` / `elemental` (a built-in one of that kind, fixed need), `resurrect` (decided at queue time: raise the dead neighbour, an archived creature or a Death Ward; with flag `resurrect`). F9e: `tileTokenChoice: [elem, …]` (the bonus tile token may be any of these — the cast's chosen element, else the higher of my stats; Fossilization: Earth or Vitality) and `tokenRetryKeeps` (a failed tile / shield token roll keeps the lock and the tokens bought; the next action re-emits for the owed ones — ruling 2026-11-18). The JS references these flags were checked against live in `oracle/` (effects-js.mjs, standing-js.mjs, natural-kinds-js.mjs, hooks-js.mjs) — test oracles, never loaded by the default data engine.

## Bots and UI (`bot`, `ui`, chaosd6.effect/2 — effect isolation F8)

Never read by a resolver; validated by the loader (unknown keys are refused). Neither the game nor its bots name an effect:

| block.key | read by | meaning |
|---|---|---|
| `bot.tags` | monster-deck.mjs | creature tags the effect suits (+5 thematic score at deck build) |
| `bot.names` | monster-deck.mjs | case-insensitive patterns on the creature's name / id it suits (+9) |
| `bot.defence` | monster-deck.mjs | a self-protecting card: the monster mix's defensive pick, npc casts it as defence |
| `bot.ai: false` | monster-deck.mjs | bots cannot drive it: never a thematic pick, never cast by npcPlan |
| `bot.contact` | monster-deck.mjs | a defensive / control cast only with an enemy in contact (Delay Time) |
| `bot.heals_self` | monster-deck.mjs | also sensible when the caster is hurt (Potion Brew, Nature's Embrace) |
| `ui.target_hint` | js/main.js | the targeting help line while the card is selected (Awake) |
| `ui.toast_hits` | effect-results.mjs | its result toast lists every enemy hit (Blizzard) |
| `ui.perm_help` | js/main.js | the perms-strip tooltip while it stands |

peer.mjs sends the browser `hello.effect_ui` — per effect id: `every_instant`, `hides`, `link`, `perm_action` (`aura` = flag
everyWidens, `bless` = flag blessAttach), `target_hint`, `perm_help` — so main.js reads hints, never ids.

## The dialect

Evaluation: a primitive is itself; an array evaluates element-wise; an object must have **exactly one
key** = the operation (`{"op": [args…]}`, a single non-array arg may be written bare). Object literals
only via `{"obj": {key: expr}}` (values evaluated) or `{"quote": literal}`.
Differences from json-logic-js, on purpose (so results are byte-identical to the JS engine):
- `var` follows JS: a missing path is `undefined` (not `null`); `{"var": ["p", default]}` gives the default.
  Paths are dotted (`cast.target.ref.q`); `__proto__ / prototype / constructor` never resolve.
- truthiness is JsonLogic's (`[]` is false); `all` on `[]` is **true** (JS `every`).
- iteration bodies see the outer variables; the item is `it` (or the name given as the 3rd arg:
  `{"map": [list, body, "def"]}`), the index `i`; `reduce` binds `current`/`accumulator` (aliases `it`/`acc`).
- `call` runs a library subroutine in a fresh scope: its params + the root registers (never the caller's locals).

**Root registers** (pre-declared; `set` only assigns existing names): `cast`, `me` (= cast.actor),
`elems` (= cast.elements), `effect_id`, `my_tile`, `recipients`, `failed`, `declared`, `aura`, `tmp`.

**Limits** (`ENGINE_LIMITS`): 200 000 evaluated operations, depth 96, `range` ≤ 1024 items. Exceeding
any, or a program error (unknown variable in `set`, bad outcome key/status, unknown subroutine), gives
the deterministic outcome `{status: 'error', notes: ['effect engine: <id>: <reason>'], …empty}`. An
exception thrown by a `ctx` query propagates (same as the JS engine).

### Operations (103, `ALL_OPS`)

| group | ops |
|---|---|
| control (lazy) | `if` / `?:` (chained), `and`, `or`, `seq`, `let [{name: expr…}, body]` (sequential), `set [name, expr]`, `call [sub, args…]`, `return [status?]` (stop; outcome as built), `return_empty [status]` (stop; nothing lands — effects.mjs `emptied`) |
| values | `var`, `quote`, `obj`, `undefined`, `all_elems` |
| compare / logic | `== === != !== < <= > >= ! !!`, `bool` (JS `!!`: `[]` is true — S2), `??` (first non-null), `is_null`, `is_array` |
| maths | `+ - * / %`, `min max` (varargs), `min_of max_of sum` (lists), `round floor ceil abs round_div10`, `dice_count`, `hex_dist [a, b]` |
| strings | `cat`, `join [list, sep]`, `str`, `starts_with`, `in` |
| lists | `map filter find all some none reduce` (lazy bodies), `sort_by [list, {asc\|desc\|locale\|code: key}…, name?]` (stable; `locale` = `String#localeCompare`), `sort` (JS default order), `uniq`, `concat`, `merge`, `slice`, `at` (undefined out of range), `last`, `len`, `includes [list, x]`, `get [obj, key, default?]`, `set_at [list, i, v]` (copy), `range [a?, b]` |
| ctx queries (read-only) | `peers`, `stat_of [id, el]` (statFor), `base_stat [id, stat]`, `life_of`, `enemy_of [a, b]`, `dist [a, b]`, `tile_of`, `is_free [q, r]`, `neighbours [q, r]`, `has_perm [id, perm]`, `shielded [id, el]`, `disabled_elems id` (sorted list), `invisible`, `elem_stat el`, `threat_elem`, `cast_elem_of`, `free_tiles_within [q, r, d]`, `tile_tokens_at`, `traps_at`, `obstacle_at`, `library`, `ctx_has name`, `action_index` |
| dice (deterministic) | `seed tag` → `"<salt>:<effect_id>:<actionIndex>:<tag>"`; `point_buy [stat, tag]` → `{fail, dice, value}` (Rule 20, same seed as effects.mjs); `point_buy_seed [stat, seed]`; `rng [tag, n]` = `int(sha(seed(tag))[0..8]) mod n`; `hash_int [string, from?, to?]` |
| outcome | `emit [list, value]` (append), `put [field, value]` (set; `status` must be a known status), `out field` (read), `note parts…` (cat → notes) |

### Outcome (building blocks peer.mjs applies — unchanged)

`status`: `done · casting · retry · fizzled · blocked` (+ `error` from the engine).
Lists (`emit`): `hits {victim, legs:[{kind:'main'|'token', sum}], healDealt, selfDamageEqual}` ·
`tokens {kind:'fire'|'bonus'|'shield', elem, value, q, r, consumed?, item?}` · `statTokens {on, stat, elem, value±, effect_id}` ·
`locks {on, n, by, effect_id}` | `{on, restOfTurn, nextTurn, by, effect_id}` · `zones {q, r}` · `heals {on, amount}` ·
`permanents {on, id, by?}` · `moves {who, q, r, reason: pushed|teleported|banished|switched|awakened}` · `voidFor [id]` ·
`channels {on, effect_id, target, elements, salt, stop, holder?, card_id?}` · `traps {by, q, r, effect_id, elements, card_id, library?, power, trigger, mode, holder}` ·
`obstacles {by, q, r, hp, elem}` · `links {on, from, stat, value}` · `pulls {by, token_id, owner, elem, value, item, q, r}` ·
`relocations {kind: token|trap|obstacle, owner, id, label, by?, q, r}` · `peeks {by, kind:'tile', q, r}` | `{by, kind:'hand', of}` ·
`notes [string]` · `rolls {elem, dice, stat, ok}`.
Scalars (`put`): `shieldElem {on, elem}` · `disableElem {on|'*', elem}` · `draw n` · `every bool` · `kept [die|null]` (point-buy bank) / `[stat]` (stat-buy bank) ·
`summon {owner, creature_id, name, need, bind, archive_card_id, revive, is_player, ward}` · `possess {bind}` | `{phylactery: {peer_id, perm}}` · `phantom bool`.

## Library `std` (lib/std.json)

`alive id`, `visible id` (Invisibility ruling), `my_stat el`, `enemies_within d`, `delta_sum def` (Rule 21),
`boost` (Elementalist), `main_delta def`, `main_kept def` (point-buy Σ), `buy_pb stat tag` / `buy stat tag`
(recorded point-buy; failure → `failed`, note), `prelude` (my tile; disabled element / Emotions Bombard → blocked),
`pointbuy_bank` (Rule 20 per-emission bank → `casting` / `retry`), `targets scope range by_damage` (all scopes,
Rule 15 auto-target, Aura, Aura ∀), `require_recipients`, `hit def legs`, `lock_n def n`, `lock_rest def next_turn`,
`self_tile_token el kind tag`, `stat_token who el sign tag`, `land_permanent`, `finish` (∀ flag; failed → retry).

## Library `e2a` (lib/e2a.json)

Used as `"uses": ["std", "e2a"]`. A library is validated on its own (`validateLib` only knows its own subs), so
e2a never calls std; values that need std (a point-buy, a main leg) are computed by the effect and passed in.
`hit_with def legs heal self_eq` (Drain healDealt / selfDamageEqual), `zone_around` (my tile + 6 neighbours),
`channel_reg stop` (completed non-tick cast registers its channel), `trap_self trigger mode` (card trap under me, power 20),
`swap_tokens who pb` (Mutate / Nature Embrace with `pb` = std `buy_pb … "swap:<who>"`), `alt_feature d` (Ageing: a random
`FEATURES` entry on a free featureless tile within d).

## Library `e2c` (lib/e2c.json) — map surgery

Used by Metaphysics, Disruption, Mind Blast, Awake as `"uses": ["std", "e2c"]` (Throw's Force Pull is inline, std only).
Self-contained (no std calls). `e2c_surgery_ok` (tile chosen + ctx has tileTokensAt / trapsAt), `e2c_things_at q r`
(bonus tokens / traps / obstacle on a tile as `{kind, owner, id, label, by}`), `e2c_unit_at q r`, `e2c_dest_free`,
`e2c_dest_ok` (free + ≤ 10, else fizzled), `e2c_first_by_id things`, `e2c_move_one unite|split`, `e2c_switch`, `e2c_awake`.
"surgeryDone" is read off the outcome (relocations / moves non-empty), not a register.

## Library `e2b` (lib/e2b.json) — stat buy, relocation, meta permanents

Used by Super Force, Space Bending, Traps Mastery, Blessing / Curse, Teleportation, Banish, Creation, Spirit Link, Phantom,
Vision, Possess / Phylactery and the stat-buy family as `"uses": ["std", "e2b"]`. Self-contained (alive / visible / my_stat
inlined). `fizzle msg` (status fizzled + note; later legs still run), `stat_sum id` (Σ of the four base stats),
`attached` (cast.attach.elements non-empty), `stat_buy resurrect` (round-robin bank of my stat per emission until
`cast.summon.need`, → `casting`; then the ∀ bind / revive / Death Ward fizzles — they stop the program — and `summon`).
A stat-buy effect is `prelude, stat_buy <resurrect?>, land_permanent, finish`. Fixtures: `effect-engine-fixtures/e2b.mjs`.

Effect-specific check fixtures: every `game/tools/effect-engine-fixtures/*.mjs` default-exports `(helpers) => void` and is
run by `effect-engine-check.mjs` (section 4b) — e.g. `e2a.mjs` asserts the branches each E2a effect must reach.

## Example (Lightning)

```json
{"seq": [
  {"call":["prelude"]},
  {"call":["targets","target",1,true]},
  {"call":["require_recipients"]},
  {"map":[{"var":"recipients"},{"seq":[
     {"call":["hit",{"var":"def"},[{"obj":{"kind":"main","sum":{"call":["main_delta",{"var":"def"}]}}}]]},
     {"call":["lock_n",{"var":"def"},{"*":[1,{"if":[{"var":"cast.every"},2,1]}]}]}]},"def"]},
  {"call":["finish"]}
]}
```

## Determinism rules for authors

- Never depend on object key order of ctx data or on `sort` of objects; sort ids / numbers, use `sort_by`.
- Every random choice goes through `seed`/`point_buy`/`rng` (salted by the reveal) — never anything else.
- Emit outcome objects with keys in the documented order (the shadow check compares JSON text).
- Validate: `node tools/effect-engine-check.mjs` (both engines identical on fixtures + ≥500 random contexts per effect).
