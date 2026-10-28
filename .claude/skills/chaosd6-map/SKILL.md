---
name: chaosd6-map
description: Orientation for the chaosD6 repo — where every piece lives (data layer, resolver, effect engine, UI, bots, tools), the vocabulary (turn/round/action, permanents, stat buy, ∀), and the user's standing rulings. Load first for ANY chaosD6 task instead of exploring with grep/ls; it replaces ~20 discovery tool calls.
---

# chaosD6 — map of the repo

P2P hex card game. Peers are independent `node peer.mjs` processes that gossip reveals,
each runs the SAME deterministic resolver and publishes a state hash; a mismatch logs
`STATE DIVERGENCE`. The paper rulebook lives as versioned JSON in `data/`.
Full prose: `README.md` (sections 2 layout, 7 round engine, 11 running, 12 loose ends).

## Files that matter (sizes ≈ Oct 2026)

| Path | Role | Touch when |
|---|---|---|
| `game/peer.mjs` (~3550 lines) | one peer: deck/hand, planning, gossip, resolver, snapshot, companions, UI WebSocket/HTTP | any rule that needs state across actions |
| `game/effects.mjs` (~350) | PURE effect engine: `EFFECT_RULES` table + `resolveEffect(ctx, cast)` → outcome, deterministic dice from reveal salt | what an effect does at its last emission |
| `game/js/main.js` (~1600), `game/css/style.css` | browser UI (hand, perms strip, roster, map) | new card kinds, labels, keys |
| `game/tools/swarm-test.mjs` (~290) | bot driver for N players; decides casts/targets | an effect needs the bots to exercise it |
| `game/tools/effects-check.mjs` (~190) | unit oracles for effects.mjs (`node tools/effects-check.mjs` → `all checks passed`) | every effects.mjs change |
| `game/logic-engine.mjs`, `game/tools/{logic-check,logic-apply,rebalance}.mjs`, `game/tools/logic/*.logic.json` | JsonLogic layer (see skill `chaosd6-logic-layer`) | data/*.json rules, proposals |
| `data/*.json` (18 collections) + `data/logic_rules.json` | the living rulebook; every entry = `versions[]` with `status`, `weight`, `data`, `logic` | never edit `logic` by hand; use logic-apply |
| `game/tools/out/` (gitignored) | scratch: `_patch*.py`, `_swarm_*.sh` summary scripts | patches, log triage |
| `game/logs/swarm-HHMM/` (gitignored) | per-peer logs of a swarm run | triage |

Other dirs: `game/ui-server.mjs`, `start-all.mjs` (launcher), `discovery.mjs`, `radicle-adapter.mjs`;
repo-root `tools/` holds one-off data porters and npm helpers (`_npm_jsonlogic.sh`, `_lock_jsonlogic.sh`).

## peer.mjs anchors (grep these names, line numbers drift)

- `pickActive(entry)` — active version of a data entry (not rejected/superseded, highest weight). `BUILT_IN_CREATURES`, `ELEM_TO_STAT`, `EFFECTS_IMPLEMENTED = playableEffects(data.effects)`.
- Permanents: `entity.permanents` (Set), `dropPermanent(id)` (→ `onSummonEnd`, `releaseHeld`), `entity.permUntil`, `heldCards[]`/`holdCard`/`releaseHeld` (landed permanent cards are HELD, not discarded; `circulating()` counts them for the 15-card floor `DECK_MIN`).
- Summon family: `SUMMON_PERMS`, `prepareSummon(card, every)`, `onSummoned(permId, sm)`, `onSummonEnd`, `becomeBound(owner, permId, mode)`, `onRevived`; `entity.summons[]`, `companions[]`; loopback `/summon-hold` every 2 s, `/summon-release`.
- Round flow: `doPlanningEnd()` (freeze members FIRST, even for dead peers) → `doResolution()` which contains the closures `simulate()` (one action) and `runRound(reveals, quiet)` (Balefire pre-round → bonus rounds → main) → `endRound()` (discard/hold/return-to-hand, lock decrements, perm expiry) → `npcPlan()` for bots/companions.
- Bonus rounds: `bonusAllowance()` (Haste 1 + balefireCharge), resolver `allowanceOf(id)`, WS `{kind:'bonus', plans}`.
- Locks: `entity.lockList[{effect_id, by, n}]`, planning filter skips locked players (Oblivion lock lifts if its permanent dies).
- Snapshot (`currentStateSnapshot()`): CSV/JSON STRINGS only (`permanents_csv`, `summoned_csv`, `wards_csv`, `shield_elems_csv`, `entry_q/entry_r`, `bonus_charge` …). Anything the resolver reads about another peer must be in the snapshot.

## Vocabulary (final — do not re-derive)

- Paper **round** = engine `hg.turn` = 3 **actions** (`hg.round` 0..2). "Until end of round" = until the engine turn ends.
- Action cards: A attack, M move, B block, P posture, EM empty-move, EP empty-posture. Only EP/P emit elements; EM does not; moving interrupts a cast (Monk excepted). Damage matrix is authoritative for every action (see rulings).
- **Cast** = one element per emission; Posture/EP emits; `casting = {entries[{cardId, effectId, every, len}], emitted, aura}`; chaining = next effect's FIRST element equals the tail's LAST (`joinableNow`).
- **∀ (every / double cast)** = two copies queued together → one chained cast of cost+1; many effects change meaning under ∀ (Shield → permanent, Lightning → 2 locks, Haste → +1 card…).
- **Permanent** = card stays in front of the deck (perms strip, keys 9/0/-/=), destroyable by Rule 24 (stat emission point-buy vs power; stat-buy family has fixed power 6).
- **Point-buy** = roll N dice (6N nearest stat, tie → more dice) at each EMISSION; roll > stat fails → that element re-emits next action; good dice banked in `kept[]`.
- **Delta damage** = Σ per element max(0, caster stat − defender stat), then `round(Σ/10)` (half up).
- **Stat buy** (Summoning, Golems, Elementals, Resurrect): emission k banks the stat of the card's k-th element round-robin until bank ≥ need (creature Σ / 24 / 30 / 0).
- Life of every creature = `round(Σstats/10)` (ruled 2026-10-28, canonical in creatures.json).
- Alliances: `player | npc_a | npc_b`; companions are separate peer processes with `OWNER_PEER_ID`.

## User rulings (authoritative, override the paper text)

The full list with worked numbers is in the memory file `project_rules_pc_overrides.md`
(also summarised in effects.mjs header comments). Key ones:
Rule 8 instants return to hand if no benefit; Counter Spell = pick one element, subtract MY stat per instance;
Force Shield die absorbs before rounding; Rule 15 autotarget priority; Reaver EM/EP fight as Attack;
Rule 19 interrupted cast is DISCARDED; Meteor Shower hits everyone within 10; Turn Life heal round(Vit/10);
Disable fires by itself; Oblivion lock lasts while its permanent stands; bonus rounds deal base damage only;
dead peers freeze round members too. Reuse the worked examples as test oracles.

Open rulings (ask, don't guess): Lightning N locks vs 1(×2 ∀); Rule 24 power of point-buy permanents;
class-card destructibility; Razorfin stats (Σ 30, life 4).

## Task → skill

- Implement/alter an effect or skill → `chaosd6-effect-impl`
- Run bots and triage logs/divergences → `chaosd6-swarm-test`
- data/*.json rules, named rules, proposals, rebalance → `chaosd6-logic-layer`
- Shell/WSL/UNC/npm/CRLF/patch mechanics → `chaosd6-env`

## Habits the user expects

- Never commit unless asked. Never hand-edit `data/*.json` versions in place: append a new version, superseded one gets `weight − 0.01`.
- After any resolver change: `node --check game/peer.mjs`, `node tools/effects-check.mjs`, then a swarm run with the effect forced and expect 0 divergences.
- Report in the user's terms (effect names, rule numbers), flag doubts as a short list, keep "what was left" lists current.
