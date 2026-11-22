# Skill isolation — handoff (2026-11-22, session chaosd6-8a)

Goal (user): the same isolation for skills as for classes and effects. The game is skill-oblivious; a new skill needs
changes only in `game/skills-data/` (mirrored to the chaosD6-Skills repo). The JS hooks are a test oracle.
Behaviour is bit-identical for the 14 built-ins (deal order, hook results, fold order, logs).
Design spec for the agents: `/home/galt/chaosd6_mapper/chaosD6/game/tools/out/SKILL_ISOLATION_SPEC.md`.

## User ruling
- **Definitions only** (as effects F9): `data/index.json` skills entry has `"definitions": "game/skills-data/skills"`;
  logic-engine builds the skills collection from the definitions' `card` blocks (defs-collection.mjs).
  `data/skills.json` is a frozen record (no new versions). `logic-apply` skips skills; `rebalance` refuses skill
  proposals (message points at tools/skills-rebalancing-check.mjs).

## What changed (uncommitted, clone2 feature/godot-use)
- **Definitions** (skills-data/skills/*.json): schema `chaosd6.skill/2` (`/1` still loads, for foreign skills) with
  `deal_order` 1-14, `card` {name, tags, resources, data, rebalance_links, logic} copied from data/skills.json,
  `ui` {tag, glyph, color, rest_hint (Sanctuary)}; flags `passOrder` (pass-hook order), `buildingSkill` (building-bonus
  list index, part of the (seed,q,r) contract). No `planLock`: Powerful Attack's `selfLock.codes` is used. Each
  definition's `version` +1 minor; `source.version` unchanged. lib/skills_pass.json 1.1.0 (`ps_non_perm` tests the
  `trance` flag instead of naming Battle Trance). skill.schema.json accepts /1 and /2.
- **Engine**: skill-engine.mjs validates /1 and /2 (`validateCard`, `validateUi`, deal_order / passOrder /
  buildingSkill uniqueness; lenient loader with `errors`); HOOK_SPECS pass `order` derived from `flags.passOrder`.
  skills.mjs: eager lenient bundle, every table derived (`SKILL_RULES`, `SKILLS_IMPLEMENTED`, `NEGATING_SKILLS`,
  `TRANCE`, `BUILDING_SKILLS`, `PLAN_LOCKS`), `builtinSkillEntries()` / `builtinSkillCatalog()`, `skillUiOf()`,
  `skillBundleErrors()`. **`SKILL_ENGINE` default is now `data`**; js/shadow need `installSkillOracle()`.
  Only built-ins with a `deal_order` take part in deal/building/pass/plan-lock orderings (foreign skills never do).
- **Oracle**: skills-data/oracle/skills-js.mjs — the JS hooks moved verbatim + frozen REF tables (old SKILL_RULES,
  deal/pass/building orders, validator flags) that the checks compare the derived values against.
- **Version gate** (skills-handshake.mjs): snapshot `sk_set` pin; `gateSkillSet` / `gateBuiltins` with the
  slim/full rule; a mismatch logs `SKILL VERSION GATE …` and the peer withholds its state hash (peer.mjs `skVer`,
  beside `fxVer`); UI notice via `skill_source` event `version`. builtinIds come from the bundle only.
- **peer.mjs**: no skill id as code. Loads the oracle dynamically only for js/shadow; exits on `skillBundleErrors()`;
  `data.skills = builtinSkillEntries()`; generic hooks (shield skill from the effectShield flag, end-round filter
  from invincibleWhile, trance via `SKILL_RULES[id].trance`); hello carries `skill_ui` + `building_skills`;
  `skill_catalog` broadcast for foreign skills; class ctx `skillIsTrance`.
- **UI**: main.js / renderer.js / skill_card.js read tags, glyphs, colours and the rest hint from `skill_ui`
  (SKILL_TAG / SKILL_ICON / SKILL_GLYPHS gone); building-bonus.js gets its list via `setBuildingSkills()` (throws
  if unset — node tools that read a skill building must call it, see tools/fortress-check.mjs).
- **Classes**: classes.mjs TRANCE gone; profile.mjs uses builtinSkillCatalog(); new class-engine ctx op
  `skill_is_trance`; class_bard 1.2.0 (share_skills asks the op instead of naming Battle Trance; data/classes.json
  version appended, 1.1.0 superseded 0.99).
- **Validator**: skills-rebalancing-check.mjs 1.2.0 — built-ins from the definitions' card.data, BUILTIN_FLAGS
  derived, deal_order refused on foreign skills; pin 8d5a8dec07de.
- **Grep gate** (skill-engine-check §6c): no built-in skill id as code in the 12 game files; allowlisted only the
  main.js DEV_FIXTURE demo line. class-engine-check §6: no skill id in class definitions / class engine.
- **skills-repo-sync** mirrors `oracle/*.mjs` (outside tools/engine); skills-repo-check tests it.

## Checks (all green, 2026-11-22)
skills-check 98113 ok (data, js, shadow strict), skill-engine-check 198, skills-handshake-check,
skills-rebalancing-check-test 267, skills-repo-check 92; classes-check 1059 (default + shadow strict),
class-engine-check 61, class-state, classes-handshake, classes-rebalancing-check-test 71, classes-repo-check 89;
effects-check, effect-engine, effect-hooks 187, effect-standing 64, effects-handshake, effects-repo 99,
rebalancing-check-test 512; logic-check, fortress, profile, monster-deck 300, bound-release 22, chase,
proposal-votes 136, merge-order. Script: tools/out/_sk_all.sh (scratch dir of the chaosd6_mapper clone).

## Swarms (FORCE_SKILLS groups of 4, NO_C=1; tools/out/_sk_swarm.sh)
- Shadow strict (skills + classes + effect hooks): Swarm-0346 (g1), 0352 (g2), 0406 (g3), 0412 (g4); default
  engine: 0419 (g1), 0426 (g2) — 0 errors, 0 divergences, 0 shadow mismatches, 0 version-gate lines.
- Swarm-0359 (g3, first run): one event, 4 `#1` lines, all against the dead companion ally-1 (bus-only link) at
  T2.R3: it never resolved foe-1's Banish and kept player-1 at the pre-Banish hex. No skill involved, 0 mismatches,
  not repeated on the rerun 0406. chaosd6-b9 confirmed the known dead-follower signature (ally-1 died T1.R2, only
  follows the clock over the bus afterwards; same as F7's Swarm-2034) — not Banish, not skills; no action.

## Left / TODO
- TODO (user): real skills-repo-sync (dry run shows 14 skills, lib, docs, oracle, engine, validator pin, index) +
  push rad / GitHub + announce. Not synced.
- Dev fixtures still name skill ids (main.js DEV_FIXTURE, js/effect_source.js `?fxsrc=demo`) — demo data, like
  the effect ids there. Test files and godot/tools/hud_check.gd name ids by design.
- The APK's copy of the game code refreshes on the next build_and_deploy.sh.
