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

`EFFECT_ENGINE=js` (default) | `data` | `shadow`, read once by `effects.mjs`:
- `js` — unchanged: `resolveEffectJs` (the `EFFECT_RULES` table).
- `data` — an effect with a definition runs on `resolveEffectData`; the others stay on JS.
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
| `schema` | `"chaosd6.effect/1"` |
| `id`, `name`, `version` | `effect_[a-z0-9_]+`, display name, semver of THIS definition |
| `source` | provenance of the metadata (`data/effects.json` active version) |
| `elements`, `cost` | element cost in emission order; `cost = elements.length` |
| `kind` | `damage · lock · stat_token · permanent · counter · trap · relocation · surgery · summon · scouting · meta` |
| `duration` | `instant · permanent · channel · trap · cast` (stat-buy casts) |
| `every` | ∀ behaviour `{behaviour, note}` — documentation; the program reads `cast.every` / `cast.aura` |
| `text`, `every_text` | rules text (from data/effects.json) |
| `flags` | the resolver metadata peer.mjs / bots / UI read today = the `EFFECT_RULES[id]` entry (`damage, scope, range, permanent, statBuy, fixedPower, channel, trap, tileTarget, …`). The check asserts equality; E2 builds `EFFECT_RULES` from it |
| `uses` | library ids (`["std"]`) whose subroutines `call` may name |
| `logic` | the program |

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
