---
name: chaosd6-effect-impl
description: Checklist and code patterns for adding or changing an effect/skill in chaosD6 (EFFECT_RULES in effects.mjs, peer.mjs hooks, snapshot fields, UI perms strip, bot support, effects-check oracles, data logic description). Use when the user says "implement <effect>", "fix <effect>", "what is left to implement", or asks for rule changes in the resolver.
---

# Implementing an effect in chaosD6

Order of work (each step has a verification; stop at the first failure):

1. **Rule in `game/effects.mjs`** — add/extend the `EFFECT_RULES[effect_id]` entry. Existing keys (header
   comment lines 40-55 is the spec): `damage: 'delta'|'pointbuy'`, `scope: target|all_enemies|all_adjacent|all_seen|everyone|self|self_or_ally|self_or_enemy`,
   `range`, `lock: n`, `lockRestOfTurn`, `lockNextTurn`, `tileToken`, `selfTileTokens`, `selfShieldTokens`,
   `statPenalty`, `statBonus`, `swapTokens`, `healDealt`, `healIfNoTarget`, `selfDamageEqual`, `push`, `teleportSelf`,
   `draw`, `permanent`, `statBuy` + `fixedPower` + `resurrect`, `shieldElem`, `disableElem`, `voidThisAction`, `zone: 'no_damage'`.
   A NEW kind of key needs a branch in `resolveEffect()` that writes into the `out` object
   (`hits, tokens, statTokens, locks, zones, heals, permanents, moves, shieldElem, disableElem, voidFor, draw, every, kept, summon, notes`).
   Effects with no rule entry are not dealt to players (`playableEffects`). Verify: `node --check game/effects.mjs`.

2. **Oracle in `game/tools/effects-check.mjs`** — append a block using the tiny world helper
   (`world(stats, tiles, sides, opts)`, `M(vit, world, matter, will)`, `eq(label, got, want)`). Use the user's worked
   numbers when a ruling exists. Run `node tools/effects-check.mjs` → must end `all checks passed`.

3. **peer.mjs consumption** — the resolver only applies what `simulate()` knows how to land. Where things go:
   - damage/heals/locks/tokens/zones: the outcomes loop in `doResolution` (search `for (const lk of oc.locks)`, `oc.hits`, `oc.statTokens`, `oc.zones`).
   - a permanent landing: `oc.permanents` → `entity.permanents.add`, `holdCard`; perm-specific side effects go in the same place (`RESURRECT`/`SUMMON_PERMS` branches show the pattern); falling → `dropPermanent(id)` (add cleanup there if the perm owns state).
   - state other peers must see → add a CSV/JSON-string field to `currentStateSnapshot()` AND read it back via `view.get(id)?.<field>` in the resolver (never object fields; snapshots are flat strings).
   - per-turn/per-action timing → `endRound()` (expiry, lock decrement, hold/release) or the start of `doPlanningEnd()`.
   - bots: `npcPlan()` (monsters/companions) and `tools/swarm-test.mjs` (players: when to start a cast, how to target).
   - UI: `game/js/main.js` perms strip `action:` map (~line 720: `'aura'|'bonus'|null`), `SUMMON_PERM_IDS`, labels; hand msg fields in peer `uiHttp`/WS handler (`m.kind === …`).
   Verify: `node --check game/peer.mjs`.

4. **Data logic description** — `game/tools/logic/effects.logic.json` entry for the effect: update `description`
   (say it is implemented / how), prerequisites/effects blocks if the maths changed; apply with
   `node tools/logic-apply.mjs tools/logic/effects.logic.json --replace` then `node tools/logic-check.mjs` → `all logic checks passed`.
   (See skill `chaosd6-logic-layer`.)

5. **Swarm regression** — force the effect into bot decks and run 4 minutes (skill `chaosd6-swarm-test`):
   `export FORCE_EFFECTS=effect_x,effect_y NO_C=1 && bash tools/swarm-run.sh 4` (via WSL, foreground).
   Expect `divergences: 0`, no `TypeError/ReferenceError`, and log lines proving the effect fired.
   Add a `console.log(\`[${PEER_LABEL}] <effect>: …\`)` on EVERY peer that lands it (not only the caster) so the summary script can grep it.

6. **Report** — what landed, what the bots proved, what is still unmodelled, rulings needed. Update memory `project_rules_pc_overrides.md` only for new user rulings.

## Patterns to reuse (already in the code)

- **Lock kinds**: `{on, n}` plain lost actions; Oblivion = lock tied to caster's permanent (`entity.lockList` entries carry `effect_id, by`; planning filter drops them when `by` no longer holds the perm).
- **Permanent that fires by itself** (Disable, Death Ward): detect in `simulate()` on the defender side, mark `*Fired`, and `dropPermanent` after the loop — never mid-simulate (determinism).
- **Stat-buy cast** (`statBuy`): `cast.summon.need`, `kept[k] = myStat(elems[k % n])`, `status: 'casting'` until paid; peer grows/shrinks `casting.entries[k].len`.
- **Companion / bound creature**: own process via `onSummoned`; life tied to the owner's permanent (`/summon-hold` heartbeat); use `becomeBound(owner, permId, mode)` for alliance switches.
- **Return-to-hand instants (Rule 8)**: counterfactual replay of `runRound` with the instant removed; `benefit = took less OR dealt more OR healed more`.
- **Determinism rules**: everything the resolver uses must come from reveals + snapshots; dice from `sha(salt + …)`; iterate peers in sorted order; `freezeRoundMembers()` before any early return.

## Known doubts (keep this list current when you finish something)

Not implemented (Oct 2026): super_sense, spirit_link, blessing_curse, banish, sleep, delay_time, empower, awake,
creation, confusion, vision, phantom, traps_mastery, possess_phylactery, love, awe, domination, anger, mists, petrify, fear.
Doubtful: super_force variants, teleport others, location tokens (throw/artifice/aging/space_bending),
channelling tokens (harm/combustion/the_void/light_darkness), poison trap leg, map surgery (metaphysics/disruption/mind_blast).
Design already agreed for the next batch: Mists (victim's Attack → EP, caster bans adjacent), Petrify (`stoneBy`, skip while caster holds perm and is adjacent),
Delay Time (turn-start lock n=1 on adjacent enemies of holders), Empower (+1 emission-only bonus plan, perm consumed), Super Sense (auto-evade 1 damage once, perm consumed).
