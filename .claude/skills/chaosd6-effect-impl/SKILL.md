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

4. **Data logic description** — the definition's `card.logic` block (edit `effects/<id>.json` in the chaosD6-Effects repo
   `/home/galt/chaosd6-effects-repo`, then `node tools/defs-build.mjs effects` — game/effects-data is a built copy since
   2026-11-28; data/effects.json and tools/logic/effects.logic.json were deleted 2026-11-22): update `description`
   (say it is implemented / how), prerequisites/effects blocks if the maths changed, bump the definition's version, then
   `node tools/logic-check.mjs` → `all logic checks passed`. (See skill `chaosd6-logic-layer`.)

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

## Newer out-fields / rule keys (2026-10-29 batch)

`out` gained `channels, traps, obstacles, links, pulls, relocations, peeks, possess, phantom`. Rule keys:
`channel:{stop:'break'|'never'}`, `trap:{trigger:'targeted'|'enter', mode:'damage'|'perm'}`, `trapAttach`, `altTrap`,
`tileTarget`, `obstacle`, `banish`, `spiritLink`, `pullToken`, `altTileToken`, `altFeature`, `surgery:'unite'|'split'|'switch'|'awake'`,
`blessAttach`, `phantom`, `possess`, `vision`, `fixedPower`, `completesWithoutTarget`. `ctx` gained `freeTilesWithin, tileTokensAt, trapsAt, obstacleAt`.
peer.mjs: `entity.channels/traps/afflictions/obstacles/links` (+ `*_json` snapshot fields), `lifeMaxBase` (HP recalc per
general_ux_hitpoints_calculations), reveal fields `effect.attach/card_id/link/elem`, `phylactery`; WS `attach|link|elem|rebless|phylactery`;
simulate collectors `channelsBroken, trapsSpent, afflictionsOut, obstacleHits, relocations` applied only in `doResolution`.
Companions: `spawnCompanion(permId, {creature_id, name, env})`; Phantom = same CHARACTER_ID + `PHANTOM=1` (dies on first damage).
Hand cards carry UI hints `tile_target, takes_attach, takes_link, takes_elem`; hand msg carries `channels, sensed_traps, queued_*`;
UI msg `{kind:'peek'}` → popup; envelope `evt_peek` carries a hand to its looker.

## Classes (2026-10-30 ruling — every unit has one; destroyable colour by colour)

- Data: `classColours(id)` → `{stat: [elems]}` (a colour = stat group), `classKindOf(id)` = `tap | once_per_round | static`.
  Every entity gets a class at start (`FORCE_CLASS`, creature → hash of CREATURE_ID). Entity fields `classDown, classArchived,
  classTapped, classProgress {mode, done}, classUsedAction, armor, worldEdits`; snapshot `class_id, class_down_csv, class_archived,
  class_tapped, class_progress_json, class_used_action, armor, world_edits_json`.
- Reveal: `destroy: {stat, class?, elem?, recast?, untap?}` (class strike needs die ≥ 6; recast / untap any success) and
  `classAbility: {id, target, attach, stat}` (WS `class_ability` toggles `queuedClassAbility`; `CLASS_NEEDS` says what target /
  attach the class wants; `CLASS_LOCAL` abilities resolve at planning on this peer only: Paladin / Shaman / Kensei / Weapon Master / Summoner).
- simulate(): `classStateOf, classReady, abilityOf`; **pre-pass** (before casts: Elementalist `castBoost` → `cast.boost` added to the
  main damage leg, Illusionist `illusionFor`, Rogue `rogueMove` + `stealth`, Bard skill sharing); **Rule 24 block** →
  `classOutcomes {kind: colour|class_destroyed|recast|untap}`; **post-pass** (after springTrap is defined, before the enter-trap loop)
  fills `classAbilityOut {used, heals, discards, peeks, traps, tokens, armor, revives, moves, stealth}` + `trapGone` (Animator / Cleric),
  Transmuter duplicates an adjacent ally's statTokens/heals, Restaurateur turns `destroyOutcomes.result` into `'taken'`, Avenger
  pushes `peeks kind:'hand2'`. Everything is applied in `doResolution` (search `classAbilityOut.used`). `publishPeek(to, {what, n})`.
- Manipulator = affliction `class_manipulator` with `until_action`; the victim's `doPlanningEnd` forces a random Action card.
- Counterfactual safety: writes to `entity.*` inside simulate are guarded with `!quiet` (channels / traps / obstacles / links).
- UI: roster class pill with colour chips (`.chip.<stat>`, `.down` en-gray; enemy chip clicked twice → `destroy {stat, class, elem}`);
  perms strip class card first (key Q → `class_ability`; tapped / archived → chips send `destroy {stat, untap|recast}`); hello carries
  `class_colours`, hand msg `class_state, queued_class_ability, possessing`. World features: `worldFeatures()` in main.js from
  `featureAt(seed, q, r)` + every peer's `world_edits_json`; renderer labels `t.world` tokens with `t.item`.
- Bots: `tools/swarm-test.mjs` strikes adjacent enemy class colours, recasts / untaps, clicks its own class (attach for Ranger / Seeker).
- Logic: edit `tools/logic/classes.logic.json` directly (canonical since 2026-11-14), then `bash tools/logic/apply-all.sh`; named rules `class_colour_falls, class_colours_all_down, class_progress_complete, class_ability_ready`.

## Known doubts (keep this list current when you finish something)

Implemented 2026-11-15 as MONSTER NATURAL PERMANENTS (never cast; game/natural-perms.mjs, rule_monster_natural_permanents, snapshot perm_copies_json = copies per perm id): love, awe, fear, anger, domination, petrify, mists + natural earthquake / creation / spirit_link. Not implementable: super_force variants.
Implemented 2026-10-29 per the user's spec (see memory `project_rules_pc_overrides.md`): channels (harm, combustion, the_void,
light_darkness; power = MIN die), traps (poison, traps_mastery, sleep, confusion; fixed 6 for the named perms), space_bending alt trap,
teleportation (tile ≤10 / weaker adjacent ally), banish, creation (obstacle 5 hp, Matter/10 per hit), delay_time, empower, spirit_link,
balefire rework (perm 6 until end of next turn, draw 5, 9 bonus plans, one emission), throw → Force Smash/Pull, artifice tile token,
aging feature, metaphysics/disruption/mind_blast surgery, awake, blessing_curse (incl. rebless), phantom, possess_phylactery
(possess = alliance bind + owner EP/EM lock; phylactery = reveal-level trigger, no roll, spends Possess), vision (tile reveal + hand peek
popup), super_sense (adjacent traps listed, 1 damage evaded once then spent).
Settled 2026-10-30 by user ruling: Sleep/Confusion fixed 6 (confirmed); trap card routing (under owner → owner's discard; open tile →
the discard of whoever dealt with it); Possess = control transfer (proxy reveal, perm on the possessed unit, first Rule 24 target for
its allies), NOT a side switch; Blessing ∀ negates one hostile effect per action and is spent; Creation card spent (confirmed); Space
Bending alt = random LIBRARY card trap; world features generated by `featureAt` (flat element values, no special building rules);
Razorfin 9/9/20/2 Σ40 life 4 (version 1.1.0); classes destroyable colour by colour → owner's archive, recast / untap power 1.
Still open / approximations: destroyed class goes to the owner's ARCHIVE (user said both "discard" and "archive"); "once per turn
(not round)" read as once per ACTION (hg.action); Bard does not share Counter Spell; Transmuter = copy of an adjacent ally's positive
tokens / heals; Seeker locate = trap tiles with the card's id; Avenger is automatic each action; Necromancer archive revive needs a
creature card in the archive; world buildings are flat bonus tokens (no Shrine attack ban / 3-turn healing / School teaching);
"tower tiles unlock the 4 mind-control bans, a peek channel unlocks" was not found anywhere in the repo (probable mis-paste).
Swarm: runs 4 (balefire/throw/artifice), 5 (phantom/possess/vision), 7 (2026-10-30: classes + possess + space bending + blessing, 0 divergences) —
see memory `project_last_session.md`. Design already agreed for the next batch: Mists (victim's Attack → EP, caster bans adjacent),
Petrify (`stoneBy`, skip while caster holds perm and is adjacent).
