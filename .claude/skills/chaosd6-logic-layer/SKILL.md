---
name: chaosd6-logic-layer
description: Working with the chaosD6 JsonLogic data layer — authoring logic blocks via mapping files (tools/logic/*.logic.json + logic-apply), adding named rules to data/logic_rules.json, running logic-check, writing/validating proposals and new data versions with rebalance.mjs, and the json-logic-js pitfalls (literal objects, root op, max_of, CRLF). Use for any change to data/*.json, rules, contradictions, balance, or "validate this proposal".
---

# JsonLogic layer

Every active version in `data/*.json` has `logic: {description, prerequisites[], effects[], validation[], references[]}`
beside `data`. Shared maths lives ONCE as a named rule in `data/logic_rules.json` (144 rules; 45 core, 99 tagged
`shared_candidate` with `from:<collection>`). Engine: `game/logic-engine.mjs` (`LogicEngine`, `engine()`, `activeVersion`, `writeDataFile`).
Authoring guide with the context shape and the named-rule list: `game/tools/logic/README.md` (read it before writing logic).

## Commands (run in `game/`)

```bash
node tools/logic-check.mjs [--verbose]      # rule examples, expansion, coverage, self-check → must end "all logic checks passed"
node tools/logic-apply.mjs tools/logic/<collection>.logic.json [--dry-run] [--replace]   # land logic blocks on active versions
node tools/rebalance.mjs report [collection]            # power scores
node tools/rebalance.mjs check <proposal.json> [--apply]  # validate → score → ±15% → counter-proposals → verdict
node tools/rebalance.mjs selfcheck
```
`WARN` lines from logic-check = the paper data contradicts its own rules (fix by proposal, not fatal). `FAIL` = bug.
Known accepted WARN: `char_razorfin_abolisher` (Σ 30, life 4 — awaiting the user's ruling).

## Change recipes

**Edit an entry's logic** → edit `game/tools/logic/<collection>.logic.json` → `logic-apply … --replace` → `logic-check`. Never hand-edit the `logic` key in data.

**Change game data (stats, cost, text)** → write a proposal file
```json
{ "collection": "creatures", "entry_id": "mon_x",
  "version": { "version": "1.1.0", "origin": "paper_rules|player_vote|rebalance_script", "parent_version": "1.0.0",
               "notes": "why", "data": { ...full data... }, "logic": { ...optional... } } }
```
→ `rebalance.mjs check file.json` (verdict `accept | accept_with_counters | needs_rework | blocked`) → `--apply` appends the
version with `status: proposal, weight 0`. To make it canonical (user ruling): set `status: canonical, weight 1.0`, mark the old
one `superseded` with `weight − 0.01`. Versions are appended, never edited in place; ids are never reused.
Examples: `game/tools/proposals/example-*.json`; drafts for the life-formula contradictions in `tools/proposals/contradictions/`.

**Add a named rule** → append to `data/logic_rules.json` `entries[]`: `{id, name, description, params: {p: {description, default?}}, logic, examples: [{args|data, expect}], tags}`.
Reference with `{"rule": ["id", {"p": <logic>}]}`; inside the rule body use `{"param": "p"}`. Give at least one example (checked by logic-check).
If every proposal of a collection must satisfy it, list the id under `collection_validation.<collection>` (or `_all`).
Power-score formulas: `power_score.<collection>` → rule id; weights are tunable there (note: a damage element is worth +0.6 and costs −0.3).

**Resolve a contradiction** → new canonical version of the affected entries + new version of the `contradictions.json` entry with the resolution (`formula_wins` etc.), then logic-check must stop WARNing on them.

## Pitfalls (each cost real time once)

- json-logic-js treats EVERY object as an operation → no literal objects/arrays-of-objects inside logic. `engine.rule(id, args, ctx)` moves literal args into `ctx.__args` and references them as `{"root": "__args.x"}`.
- `map/filter/all/none/some` bodies see only the item → read outer values with `{"root": "caster.stats"}`, never `var`.
- `max`/`min` are varargs → use `max_of`/`min_of` on arrays. Other custom ops: `round_half_up, round_div10, max0, abs, floor, ceil, sum, count, len, includes, subset_of, distinct, keys, values, stat_sum, stat_of, dice_count, hex_distance, semver_gt, matches, typeof, entry, rule, param, root`.
- `{"entry": ["id", "path"]}` reads another entry's ACTIVE data (catalog lookup).
- `references` is a plain id list — iterate only `prerequisites/effects/validation` as items.
- `logic_rules` is a collection in `index.json` but NOT a VersionedEntry collection — the engine skips it.
- Data files are CRLF with `"weight": 1.0` formatting → always write through `writeDataFile()` (JSON.stringify alone = whole-file diff).
- **Compact format (user request 2026-10-30)**: `writeDataFile` → `compactJson` keeps the 2-space structure but writes every JsonLogic
  rule block (`{id, when|assert|value}`), every example (`{args, expect}`), a non-entry `logic` value and the keys in `ONE_LINE_KEYS`
  (`when, assert, value, logic, params, args, tags, colors, element_cost, stats, dice, …`) on ONE line, opening brackets on the key's
  line (`"when": {"and": [...]}`). `oneLine()` is a real serializer (never regex). `logic-apply.mjs` and `rebalance.mjs` write
  through it; `tools/out/_reformat_data_2026-10-30.mjs` re-serialises every collection (round-trip verified). A file that comes out
  fully expanded again means someone wrote it with `JSON.stringify` — re-run the reformat script.
- `tools/logic/classes.logic.json` is generated by `tools/out/_patch_logic_2026-10-30.mjs` (the `impl` table) — edit there, not by hand.
- Terrain vocabulary includes `terrain` and `puzzle_building`; `rps_edge` includes B vs EM = 1.
- Tolerance invariant `stat_sum_within_5_or_species_40` (characters) was widened for Razorfin; check such invariants before proposing stat moves.
- Counter-proposal drafting: candidates are single-property changes scored by sign/magnitude best fit (`candidates()` in rebalance.mjs) — a bad counter usually means a missing `rebalance_links` entry, not a formula bug.

## Context for battle-side use

`engine.checkPrerequisites(entryId, ctx)` → `{ok, failed[]}` and `computeEffects(entryId, ctx)` exist for peer.mjs gating; the
context shape (`caster, target, dist, elements, cast, die, turn, round`) is in the README. Not yet wired into peer.mjs — the
resolver still owns the maths; the logic layer documents and validates it.
