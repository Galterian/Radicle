# Foreign-skill handshake (chaosD6-Skills, milestone S4)

Program (user-approved 2026-11-16): players create skills on branches of the chaosD6-Skills repo; a peer
lacking a skill is told its branch, loads it, and passes it on, the same way effects work (E4,
`game/effects-data/HANDSHAKE.md`).

Code: `game/skills-handshake.mjs` (pure core + peer adapter `createSkPeer`). It reuses the kind-generic parts of
`game/effects-handshake.mjs`: `createFxSync` (with `kind:'skill'`, `parseRef`, `getByRef`, `keyOf`), `attachDefsRpc`
(transport), `parseLibbedRef`, blob framing, the memory cache. Glue is in `game/peer.mjs` (grep `S4`). The skill
program engine belongs to S2 (`game/skills.mjs`: `resolveSkillProgram`, `registerForeignSkill`, `isForeignSkillId`).
Checks: `node tools/skills-handshake-check.mjs`. Effects are unchanged: `node tools/effects-handshake-check.mjs`.

## Design choice: a second protocol, `/chaos/<DIM_ID>/skills/1`

The skills handshake uses its own protocol and its own bus kind, `sk`. It does not share one `/defs/1` with a
`kind` field. The messages are the same as `/effects/1` (`ref` / `get` / `blob` / `none` / `busy`); the only
difference is that a definition's wire kind is `'skill'`.

- **Effects stay byte-identical.** Putting effects on `/defs/1` would need a new effects protocol version, so
  phones still on an E4 build could no longer fetch effects. With two protocols, an E4-only peer simply has no
  `/skills/1` handler. A request to it fails with "protocol not supported", and the next holder or the
  fallback is tried. Mixed builds are still not safe with a foreign skill in play: a pre-S4 peer neither runs
  the skill nor writes `sk_missing`, so its hash can differ from the others'. That is the same as a pre-E4 peer
  facing a foreign effect.
- **Kinds stay apart.** Effect and skill content hashes live in separate stores, caches
  (`~/.local/share/chaosd6/{effects,skills}`) and validators. Under one protocol, `kind` would be one more field
  to get wrong when routing a sha.
- **Rate limits are separate.** Each protocol has its own token bucket, so loading a skill never takes an
  effect fetch's budget.
- **The code is shared anyway.** The generic sync and transport live in `effects-handshake.mjs`. A third kind
  (classes, creatures) is one more `createFxSync({kind})` + `attachDefsRpc({proto, busKind})`.

## Built-in vs foreign, identity

- **Built-in** = every id of the definitions bundle: the files `game/skills-data/skills/*.json` (or
  `SKILL_DEFS_DIR`) ∪ the ids skills.mjs's loader accepted (`bundledSkillSet().builtinIds`). Skill isolation removed
  the `data/skills.json` read and the `SKILL_RULES` table fallback: `data/skills.json` is a frozen record, and the
  game knows no skill id the definitions do not name. Built-ins travel by name in the reveal's `skills` list.
- **No definition files** is an error state, not a fallback: `bundledSkillSet()` returns `source: 'none'`, no
  built-ins, and `errors` (the adapter logs each as `SKILL BUNDLE ERROR: …`, together with skills.mjs's
  `skillBundleErrors()`). Its set id hashes the libs only, so no healthy peer shares its pin and the version gate
  below keeps both sides out of each other's hash vote.
- **Foreign** = any other id. It must come with a ref, and its id must not be a built-in one. Skills dispatch by
  id (`skills.mjs` hooks test `r.skills` ids), so a branch variant of Dodge is a NEW id that `extends:
  'skill_dodge'` (the S5 validator prices it against Dodge). A definition that reuses a built-in id is refused.
  Each foreign id has exactly one definition per peer (the first one accepted wins; a second set of bytes under
  the same id is refused, which puts it in `sk_missing` and strips it).

```
ref     = { id, sha256, libs: { <lib id>: <sha256> }, repo?, branch?, commit?, name?, verdict? }   (E4 shape, skills-repo parseSkillRef)
skKey   = sha256(canonical { skill: ref.sha256, libs: ref.libs })      one runnable skill (own namespace, ≠ fxKey)
set id  = sha256(canonical { libs: {id: sha}, skills: {id: sha} })      the bundled skill set: every definition
          file hashed IN FULL (resolver fields, flags, hooks, card and ui blocks) + every lib; logged at start,
          `sk_set` = its 16-hex prefix
```

## Built-in skills by reference: the version gate

The twin of the effects F9 gate (`effects-handshake.mjs` `gateEffectSet` / adapter `gateBuiltins`) and the
classes' phase-6 gate. Built-in skills travel by name, so two peers resolve the same action alike only if they
run the same bundled definitions. Every peer publishes `sk_set` (the 16-hex pin of its bundled set), on the slim
envelope snapshot too. One pin covers the whole set, not one per skill: a hand is private, and the libs are shared
by every skill anyway.

- Pure: `gateSkillSet(units, mine)`. `units = [{id, sk_set, full}]` are the units in my view (not me), sorted by
  id; `mine` is my 16-hex pin. For each unit:
  - same pin: fine;
  - no pin and `full === false` (I hold just its Gun slim record, which keeps core fields only): **unknown**,
    skipped until its full snapshot arrives;
  - anything else is a **mismatch**: another pin, or a FULL snapshot without a pin. `full` is judged by KEY
    presence of `permanents_csv`, so an empty `permanents_csv: ''` (a fresh monster) still means full.
  
  It returns `{ abstain: mismatches.length > 0, mismatches: [{unit, got, want}], unknown: [ids] }`.
- Adapter: `skPeer.gateBuiltins(units, {turn, round})`, once per action. It runs the gate against
  `bundled.id.slice(0, 16)` and reports each mismatch **once per unit|pin** (a new pin of the same unit is
  reported again):
  `SKILL VERSION GATE T<turn>.R<round+1>: <unit> runs built-in skill set <got | none (full snapshot without a pin)>, mine <want> — no state hash from me while it is in play`
  and UI `{kind:'skill_source', event:'version', ref:{id:'builtin_skills', kind:'skill', name:'the built-in skills'},
  peer:{peer_id, name}, got, want}`. It returns the gate result.
- **Abstain:** while `abstain` is true I publish `state_hash: ''` for the action and keep no local hash to
  compare against. A version mismatch is never resolved silently with other skills.
- The old soft `onPeerState` warning ("ships another built-in skill set") stays, as it does on the effects side.
- peer.mjs wiring (skill isolation, chaosd6-8a): `sk_set` moves onto the slim snapshot next to `fx_set`;
  `const skVer = skPeer.gateBuiltins(…)` sits next to `fxVer`; `!skVer.abstain` / `|| skVer.abstain` go at the two
  state-hash sites. The regex checks for these are in `tools/skills-handshake-check.mjs` (section VG), commented
  out until that wiring lands.

## Wire (every field is absent unless a foreign skill is in play)

| where | field | when |
|---|---|---|
| commit payload | `sk_ref: [ref…]` | foreign skill cards ride on my action; peers start fetching at commit time |
| reveal payload | `sk_ref: [ref…]` | the same refs; **the only thing a foreign skill resolves from** (by `ref.id` = the id in `skills`) |
| reveal payload | `sk_missing: [sha256…]` | foreign skill refs committed this action that THIS revealer cannot run (not obtained / refused) |
| slim snapshot | `sk_have: "id@sha16,…"` | foreign skills I hold and serve: this is how "notify the next player" works |
| snapshot (slim + full) | `sk_set: sha16` | my bundled skill set pin, read by the version gate (always present, like `fx_set`) |
| state-hash region | `sk: "sk:<key16>,stripped:<key16>,…"` | only on entries of revealers that carried a foreign skill id |

Fetch order (as E4): announced holders (most recent `sk_have`) → the owner → local clone `CHAOSD6_SKILLS_DIR` →
radicle-httpd (`skills/<id>.json` at `ref.commit`, only if the ref names a repo or `CHAOSD6_SKILLS_RID` is set;
`SK_HTTPD=0` disables it). Libraries come from peers only, by sha. Everything fetched is verified (sha256 + id)
and cached by content. A holder that serves other bytes is skipped and counted as `tampered`.

**Prepare / gate** (`createSkStore.prepare`) checks, in order:
1. the id matches;
2. `ref.libs` = `def.uses`;
3. the id is not a built-in;
4. the id has only one definition;
5. the S2 engine is present, and `validateSkillDef(def, {libs: pinned})` finds no errors (a `chaosd6.skill/1`
   definition, data programs only);
6. `checkSkill(def)` from S5 (`tools/skills-rebalancing-check.mjs`): a `reject` verdict or a validator error
   means refused. Today S5 can only audit a program that `extends` a built-in (it replays that built-in's hooks),
   so a foreign skill with programs must name `extends`. `SK_ACCEPT=0` refuses every foreign skill (local player
   policy).

If accepted, the store calls `registerForeignSkill(skKey, id, def.flags, def.hooks, { meta: {action_type,
is_permanent, point_buy_stat}, uses: def.uses, libs: <the pinned lib objects>, name, version })` **inside the
prepare step**. If that call throws, the skill is refused, so a peer that reports "ready" always runs the skill.

After that, every `skillHook` call folds the skill in for each data hook it has a program for, after the
built-ins, foreign ids in code-unit order. No resolver call site needs to change, and `sdOf` reads a foreign id's
`SKILL_RULES` entry. A definition that needs `skills_std` must list it in `uses`; then those bytes are pinned.
(The std *defaults* for the per-skill hooks a definition leaves out — `rides`, `disposition`, … — come from the
peer's bundled `skills_std`. A peer that ships another std has another `sk_set`, which is logged.)

UI events: `{kind:'skill_source', event:'learned'|'shared'|'missing', ref:{…, kind:'skill'}, peer}` (the S6 handler
in main.js), plus `event:'version'` from the version gate (`ref.id = 'builtin_skills'`, with `got` / `want`).

## Deterministic fallback: the rule

A skill has no cast. It rides on an action card and acts inside one resolution. So the E4 "postpone the cast"
becomes **strip the skill**:

1. A foreign skill resolves **only** from its owner's reveal `sk_ref` (never by name alone, never from a local guess).
2. When a peer builds its reveal, it checks every `sk_ref` committed this action, waiting at most
   `SK_REVEAL_WAIT_MS` (1.5 s). Each ref it cannot run goes into its reveal's `sk_missing`.
3. At resolution, right after the reveal list is final (sorted, corpses out) and **before** the building-skill
   injection and every skill pass, each peer takes the union of `sk_missing` over the reveals it resolves. A
   foreign skill whose sha256 is in that union is **stripped** from its reveal on every peer, the owner and the
   holders included. The action card itself still resolves, bare.
4. Otherwise the skill stays in `r.skills`, and skills.mjs runs the pinned definition through the registered hooks
   on every peer.
5. A foreign id with no ref in its reveal (e.g. a bonus-plan wire, or another build) is stripped by everyone.
6. A peer that still lacks a non-stripped definition at resolution (for example, its reveal left before the
   commit arrived) waits at most `SK_RESOLVE_WAIT_MS` (4 s) while fetching. If it still lacks it, it strips the
   skill **and abstains**: it publishes `state_hash: ''` for that action and does not compare other peers'
   hashes against its own.
7. The state-hash region gets the `sk` tag only on entries that carried a foreign id. `checkStateHash` reports
   a mismatch of that tag as a divergence. **Built-in play hashes exactly as today:** with no foreign id and no
   `sk_ref` on the tape the gate does not run at all (`needsGate`), and no wire, snapshot or region field is added.

**Where this sits in the resolver order (HOOKS.md).** The strip runs at step 0, before `counter_pre`. Every later
step sees the action without the skill:
- `counter_pre`, `negate_action`, `negate_kind`: a stripped skill cannot counter or negate, and it cannot be
  countered or listed as `ridden`;
- `trance_assign`, `block_*`, `attack_*`, `defend_in`, `damage_in`, `effect_*`;
- the Bard share (it reads `r.skills`, and foreign skills are not shared anyway: they have no `data/skills.json`
  `action_type`);
- the Rule 8 counterfactual runs, which start from `pristineReveals`, cloned after the gate.

After the run, for the owner:
- **disposition (8):** a stripped skill **returns to the owner's hand**, like the `negated` case: it never
  executed, so Rule 8 gives no benefit. It is not discarded, and it is not judged by the counterfactual.
- **perm_landing (10):** a stripped permanent skill does not land.
- **end_round (9):** Sanctuary reads my final reveal, so a stripped rider does not count as acting.

Nothing is retried. The card is back in hand, and the player (or bot) may play it again in a later action, when
the peers around may hold it.

**Why this is deterministic.** It is the E4 argument. The resolver is a pure function of the reveal set, and the
strip decision is a function of that same set: `sk_missing` and `sk_ref` are inside the reveals. So every peer
that resolves the same reveals strips the same skills, whoever holds what. A kept skill runs content-addressed
bytes (skKey covers the libraries) through the same engine, so every holder computes the same outcome. The only
input left that is not deterministic, "do I hold the bytes right now", can only make a peer abstain (rule 6).

**Residual risk** (as E4 rule 5): a revealer whose reveal left before the owner's commit arrived, and that then
cannot fetch within 4 s, resolves without the skill and abstains. If the skill changed that revealer's own entity
(for example Quick Dodge's owner hit it), its own life can differ until the next snapshot. `sk_have` prefetch
makes this unlikely.

## Env

| variable | effect |
|---|---|
| `FORCE_FOREIGN_SKILL=<def.json>` | dev/test: that definition on top of my deck; libs come from my bundled set; branch `SK_FORCE_BRANCH` or `players/local/<slug>`, plus `SK_FORCE_REPO`, `SK_FORCE_COMMIT`. Fixture: `node tools/skills-handshake-check.mjs --write-fixture <f>` (Quick Dodge = Dodge under `skill_quick_dodge`, extends `skill_dodge`, without Dodge's built-in-only `deal_order` / `card` / `ui` / flags `buildingSkill` `passOrder` `planLock`; S5 verdict ok) |
| `SK_ACCEPT=0` | refuse every foreign skill |
| `SK_VALIDATOR=0` | no S5 gate |
| `SK_HTTPD=0` | no radicle-httpd fallback |
| `SK_FORCE_BUS=1` | fetch over the bus even with a direct link |
| `SK_REVEAL_WAIT_MS`, `SK_RESOLVE_WAIT_MS` | the waits in rules 2 and 6 |
| `CHAOSD6_SKILLS_CACHE` (`memory` for tests), `CHAOSD6_SKILLS_DIR`, `CHAOSD6_SKILLS_SEED`, `CHAOSD6_SKILLS_RID` | cache and fallback sources |
| `SKILL_DEFS_DIR` | bundled set dir (default `game/skills-data`) |

## Death-card gifts and profile cards (FXG)

Same as effects (`game/effects-data/HANDSHAKE.md`, section FXG): a foreign skill card leaving play travels as
`{kind:'skill', id, ref}` (ref = the card's `sk`), the receiver loads it through `skPeer.cardFromRef` (held → at
once; else cache, holders, giver; validator + engine gate; refused → `skill_source missing` notice, card lost), and
profile cards keep the ref for the next session. `SK_PREFETCH=0` disables `sk_have` prefetch (tests).

## Not done yet

- **Pass hooks.** Foreign skills take part in data hooks only. The in-place pass hooks (`counter_pre`,
  `negate_action`, `negate_kind`, `trance_assign`) are still JS in S2. A foreign Bluff-like skill cannot be written yet.
- **Bonus plans.** Foreign skills are kept out of bonus plans (the bonus wire has no ref). A foreign id in a bonus
  wire from another build is not gated inside `runRound`'s bonus rounds.
- **Loading foreign cards.** There is no UI or profile path to load a foreign skill card into a deck yet (only
  `FORCE_FOREIGN_SKILL`). The bots play it like any skill card (by `requires`).
- **`SKILLS_RID`** is still the placeholder.
