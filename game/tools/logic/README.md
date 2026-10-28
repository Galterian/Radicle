# JsonLogic layer — authoring guide

Every entry in `data/*.json` gets a `logic` block (sibling of `data` on the
active version). Blocks are authored in **mapping files** here
(`<collection>.logic.json`) and applied with:

```
node tools/logic-apply.mjs tools/logic/<collection>.logic.json [--dry-run] [--replace]
node tools/logic-check.mjs            # expansion + validation + coverage, must pass
```

Never edit `data/<collection>.json` by hand for this — regenerate from the
mapping so the work is reviewable and re-runnable.

## Mapping file

```json
{ "collection": "effects",
  "entries": {
    "effect_fireball": {
      "description": "Longer machine-oriented description: what is checked, what changes, edge cases, pc-game overrides.",
      "prerequisites": [ { "id": "...", "description": "...", "when": <logic> } ],
      "effects":       [ { "id": "...", "description": "...", "target": "caster|target|all_enemies|everyone|tile|proposal", "unit": "damage|life|die|actions|cards|tokens|hexes|stat", "value": <logic> } ],
      "validation":    [ { "id": "...", "description": "...", "assert": <logic over {entry, proposal}> } ]
    }
  } }
```

* `prerequisites.when` — all must be true before the entry may be used / cast / triggered. Evaluated on the battle context.
* `effects.value` — the outcome maths (a number, list or object). Battle context.
* `validation.assert` — invariants every NEW version (proposal) of this entry must keep. Context `{ entry, proposal, collection }` where `entry.data` is the canonical data and `proposal.data` the candidate.
* Give every item a stable kebab/snake `id` and a one-sentence `description`.

## Context you may read (`{"var": "..."}`)

```
caster / target / defender : unit = { id, name, kind: character|creature, alliance: player|npc_a|npc_b,
                                      stats: {vitality, world, matter, will}, life, life_max, tile: {q, r},
                                      action: A|B|M|P|EP|EM, permanents: [entry_id], tokens: [{kind, elem, value}],
                                      disabled_elems: [element_id], actions_per_round, hand_size }
dist      : hex distance caster → target
elements  : [element_id] of the cast
cast      : { step, of, every (∀ double cast), aura, kept: [die|null], bank, need }
die       : the point-buy die just rolled
turn, round (0..2), action_index
entry     : { id, collection, name, tags, version, data, logic }   (the entry itself)
proposal  : { version, origin, parent_version, data, logic? }      (validation only)
```

## Named rules (data/logic_rules.json) — reference with `{"rule": ["<id>", {params}]}`

Use them whenever the logic is shared; inline only what is unique to the entry.
`using_rule_24(die, power, is_class_card?)`, `fixed_power_6()`,
`rule_21_delta_damage(caster, defender, elements)`, `point_buy_dice_count(stat)`,
`point_buy_succeeds(dice, stat)`, `point_buy_token_value(dice)`,
`stat_buy_paid(bank, need)`, `stat_buy_emissions_needed(need, caster, elements)`,
`life_from_stats(stats)`, `stat_sum_of(stats)`, `in_contact(dist)`, `in_view(dist, radius?)`,
`is_enemy(a_alliance, b_alliance)`, `is_ally(a_alliance, b_alliance)`,
`action_can_cast_non_instant(action, is_instant?)`, `elements_not_disabled(elements, disabled?)`,
`rps_edge(actor, defender)`, `hand_refill(hand_size, limit?)`, `deck_floor(circulating, min?)`,
`double_cast_every(copies, cost)`, `rule_8_instant_returns(...)`,
`valid_element_ids()`, `valid_action_codes()`, `valid_effect_types()`,
power scores: `power_score_effect|skill|class|creature|character` (context `{data}`), `within_tolerance(current, proposal, relative?)`.

Params take logic or literals: `{"rule": ["in_contact", {"dist": {"var": "dist"}}]}`.
**Inside iterating rules** (`rule_21_delta_damage`, `stat_buy_emissions_needed`, `elements_not_disabled`)
pass units/lists as `{"root": "caster"}` (root context), not `{"var": ...}`.

Catalog lookup: `{"entry": ["effect_fireball", "element_cost"]}` reads another entry's canonical data.

## Custom operations (besides json-logic's own)

`round_half_up`, `round_div10`, `max0`, `abs`, `floor`, `ceil`, `sum(array)`, `count(array)`, `len`,
`includes(array, v)`, `subset_of(array, allowed)`, `distinct(array)`, `keys`, `values`, `stat_sum(stats)`,
`stat_of(unit, element_id)`, `dice_count(stat)`, `hex_distance(a, b)`, `semver_gt`, `matches(s, regex)`,
`typeof(x)` → string|number|boolean|array|object|null|undefined, `max_of(array)`, `min_of(array)`, `root(path)`.
json-logic's `max`/`min` take varargs — use `max_of`/`min_of` for arrays. Objects are always read as
operations: never write a literal object inside logic; put it in the context or use `entry`/`var`.

## Shared-rule candidates

If you find logic that two or more of YOUR entries repeat, inline it for now and list it in
`<collection>.shared.json` (same shape as a logic_rules entry: id, name, description, params, logic,
examples) — the integrator merges those into `data/logic_rules.json`. Do not edit logic_rules.json yourself.
