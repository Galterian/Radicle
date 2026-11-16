# Foreign-effect handshake (chaosD6-Effects, milestone E4)

User spec (2026-11-15): *"when a player faces an effect they don't have, he gets notified what branch this
effect comes from so he can load its jsonlogic rules. If that player gains that effect he should notify the
next player"* — and every player can create effects and have them adopted in game.

Code: `game/effects-handshake.mjs` (pure core + the peer adapter), hook in `game/effects.mjs`
(`registerForeignEffect`, `resolveEffect` dispatch on `cast.fx`), glue in `game/peer.mjs` (grep `E4`).
Checks: `node tools/effects-handshake-check.mjs`. Live: `tools/out/_e4_live.sh <secs> accept|refuse|none`.

## Built-in vs foreign

- **Built-in** = what the peer ships: the JS `EFFECT_RULES` table and the bundled set
  `effects-data/effects/*.json` + `effects-data/lib/*.json`. Built-in casts travel by name, exactly as before.
- **Foreign** = a definition from a player branch (`players/<who>/<slug>` of chaosD6-Effects), i.e. a card
  whose definition the caster did not get from its bundled set. Only foreign casts carry a ref. With no foreign
  effect anywhere every wire message, snapshot field and state hash is byte-identical to the pre-E4 build
  (`fxPeer.active` stays false; the only addition is the informational `fx_set` in the full heartbeat).

## Identity: refs, keys, sets

```
ref     = { id, sha256, libs: { <lib id>: <sha256> }, repo?, branch?, commit?, name?, verdict? }
fxKey   = sha256(canonical { effect: ref.sha256, libs: ref.libs })        one runnable effect, libs included
set id  = sha256(canonical { libs: {id: sha}, effects: {id: sha} })       everything a peer runs (bundled set)
```

`sha256` is E3's `effectHash` (canonical JSON: sorted keys, no whitespace). `libs` pins **exactly** the libraries
the definition `uses` — a peer with another `std` gets another key, so it can never run the same ref against a
different library (the E1 risk). `repo/branch/commit` are provenance (what the UI shows, where httpd/git fetch);
they never change the key. `verdict` is the caster's rebalance verdict, display only. Every peer logs its bundled
set id at start (`fx: bundled set …`) and publishes the first 16 hex as `fx_set` in the heartbeat; a peer whose
set differs is logged once (relevant for `EFFECT_ENGINE=data|shadow`, never used by the resolver).

## Wire

| where | field | when |
|---|---|---|
| commit payload | `fx_ref: ref` | the committed card is foreign — peers start fetching at commit time |
| reveal `effects[0]` | `ref: ref` | same card; **the only thing a foreign cast resolves from** |
| reveal payload | `fx_missing: [sha256…]` | foreign refs committed this action that THIS revealer cannot run (not obtained / refused) |
| slim snapshot | `fx_have: "id@sha16,…"` | foreign effects I hold and serve (forced or learned) = "notify the next player" |
| full snapshot | `fx_set: sha16` | my bundled set |

Foreign cards ride the main plan only (bonus plans skip them; the bonus wire has no ref). A foreign id cast
without a ref (bonus, channel tick) resolves as "no rules" on every peer — the outcome a peer that never learned
it computes anyway.

## Fetch protocol `/chaos/<DIM_ID>/effects/1`

Same framing as map sync (4-byte length + UTF-8 JSON, one stream per request, frames ≤ 32 KB; bus frames ≤ 24 KB).

```
→ {t:'ref', v:1, from, prefix:<sha16>}                ← {t:'ref', ref} | {t:'none'}
→ {t:'get', v:1, from, kind:'effect'|'lib', sha}       ← {t:'blob', kind, sha, i, n, s}…  (canonical JSON in slices) | {t:'none'}
busy responder                                         ← {t:'busy'}   (token bucket 30 / +1 per 300 ms per requester)
```

Order of sources (`getEffectByRef` fetch list, E3): announced holders (most recent `fx_have` first) → the caster
→ local git clone (`CHAOSD6_EFFECTS_DIR`) → radicle-httpd (`effects/<id>.json` at `ref.commit`; only when the ref
names a repo or `CHAOSD6_EFFECTS_RID` is set; `FX_HTTPD=0` disables). Peers: libp2p when a connection is open,
else Nostr bus events of kind `fx` (`createBusRpc`, addressed `{to, from, rid, seq, last}`). Everything fetched is
verified (sha256 + id) and lands in the E3 content-addressed cache (`CHAOSD6_EFFECTS_CACHE`, `memory` for tests);
a holder serving other bytes is skipped (counted `tampered`) and the next source is tried. Libraries travel the
same way (by sha, peers only). Prefetch: a peer that sees an `fx_have` entry it lacks asks that holder for the ref
(`t:'ref'`) and loads it — usually long before anyone casts it.

Once loaded a definition is **prepared**: structure (`loadEffectDefs`), `ref.libs` = `def.uses`, a foreign def that
reuses a built-in id must keep that id's flags (peer.mjs reads them), one set of flags per foreign id, then the
**validator gate**: `checkEffect(def)` from E5 (`tools/rebalancing-check.mjs`, pinned); verdict `reject` (or a
validator error) → refused. `FX_ACCEPT=0` refuses every foreign effect (local player policy; the tests use it).
An accepted def registers its flags in `EFFECT_RULES` (new ids only; never in `playableEffects`, so dealing,
library and building picks are unchanged) and its runner under its fxKey. UI: `{kind:'effect_source', event:
'learned'|'shared'|'missing', ref, peer}` (E6 handler in main.js).

## Deterministic fallback — the rule

1. A foreign cast resolves **only** from the caster's reveal ref (never by name, never from a local guess).
2. A peer building its reveal checks every `fx_ref` committed this action (waiting ≤ `FX_REVEAL_WAIT_MS`, 1.5 s);
   each one it cannot run goes into its reveal's `fx_missing`.
3. At resolution every peer takes the union of `fx_missing` over **the reveals it resolves**. A cast whose
   sha256 is in it is **postponed**: its effect leaves the resolver input on every peer (the action card itself
   still resolves); the caster treats it like a failed point-buy (`castStatus 'retry'`) and re-emits next action.
   After `FX_POSTPONE_MAX` (3) postponements in a row the caster gives up (cast ends, card spent).
4. Otherwise the cast runs the pinned definition (`cast.fx.key` → `resolveEffectData`) on every peer.
5. A peer that, against rule 2, still lacks a non-postponed definition at resolution (it never saw the commit,
   or its reveal went out before the commit arrived) waits ≤ `FX_RESOLVE_WAIT_MS` (4 s) fetching; if it still
   lacks it, it drops the cast **and abstains**: it publishes `state_hash: ''` for that action and does not compare
   other peers' hashes against its own. It never publishes a guess.
6. The state-hash region gets `fx: 'fx:<key16>' | 'postponed:<key16>'` on the caster's entry, only for foreign
   casts; `checkStateHash` reports a mismatch of that tag as a divergence.

**Why this is deterministic.** The resolver is already a pure function of the reveal set (that is what the state
hash checks). Rule 3 makes the postpone decision a function of that same reveal set — `fx_missing` is inside the
reveals, not a side channel with its own timing — so every peer that resolves the same reveals postpones the same
casts, whoever holds what. Rule 4 runs content-addressed bytes, so every holder computes the same outcome
(fxKey covers the libraries). The only non-deterministic input left — "do I hold the bytes right now" — can only
make a peer abstain (rule 5), never produce a different hash. Built-in casts never enter rules 2–6.

**Why not the alternatives.** *Postpone if anyone announced `missing` before a deadline*: announcements arrive at
different times on different peers, so the set "announced before the deadline" differs per peer → divergence.
Folding the announcement INTO the reveal (rule 2–3) is that proposal made deterministic. *Run it only on holders
and let the others accept the outcome via state sync*: the non-holders would hash a different state (the hash
covers every revealer's life and tile), producing divergences by construction, and a non-holder's own entity
(authoritative for itself) would never take the damage.

**Residual risk** (rule 5): a revealer whose reveal left before the caster's commit arrived and that then can't
fetch within 4 s resolves without the effect; if it was a victim its own life differs from what the others
computed (it abstains from the hash, so no divergence is logged, but the state differs until the next snapshot).
Prefetch from `fx_have` makes this unlikely — the caster announces the card from the moment it holds it.

Information leak (accepted): `fx_have` lists definitions a peer holds (its deck's foreign cards among them);
`fx_ref` names the committed effect at commit time, after every plan is frozen.

## Death-card gifts and profile cards (FXG)

A foreign card leaving play (death drop → `evt_card_gift`, a won card saved in a profile) carries its ref:
`card: {kind, id, ref}` (ref = the card's `fx` / `sk`, compactRef). The gift payload also gets `from_peer` (the
holder: the dead peer, or the hero for a shadow) — only when `card.ref` is set; built-in gifts are byte-identical.
The receiver (`foreignCardFromRef`, adapters `fxPeer.cardFromRef` / `skPeer.cardFromRef`): held → card at once;
otherwise `sync.ensure` (content cache first, then announced holders, `from_peer`, the envelope sender, git / httpd),
validator gate included; refused / not obtained within 30 s → log + `effect_source|skill_source missing` notice,
the card is lost. Log: `card gift: foreign <id> learned from <src>`. Profile `cards[]` entries keep `ref` (+ `source`
for the UI badge); on profile load the peer rebuilds them cache-first (2 s), else retries after the transports are
up (8 / 30 / 90 s). `validateCharacter` accepts a card with a valid ref. All of this is private deck state — the
resolver and the state hash never see it. Test env: `FX_PREFETCH=0` / `SK_PREFETCH=0` (no `*_have` prefetch).
Live: `tools/out/_fxg_live.sh <secs> ["FX_PREFETCH=0 SK_PREFETCH=0" | "FX_ACCEPT=0 …"]`.

## Env

`FORCE_FOREIGN_EFFECT=<def.json>` (dev/test: that definition on top of my deck; libs from my bundled set; branch
`FX_FORCE_BRANCH` or `players/local/<slug>`, `FX_FORCE_REPO`, `FX_FORCE_COMMIT`), `FX_ACCEPT=0`, `FX_VALIDATOR=0`
(no E5 gate), `FX_HTTPD=0`, `FX_FORCE_BUS=1`, `FX_REVEAL_WAIT_MS`, `FX_RESOLVE_WAIT_MS`, `FX_POSTPONE_MAX`,
`CHAOSD6_EFFECTS_CACHE`, `CHAOSD6_EFFECTS_DIR`, `CHAOSD6_EFFECTS_SEED`, `CHAOSD6_EFFECTS_RID`.

## Not done yet

- Players loading a foreign card into a deck from the UI / profile (today: `FORCE_FOREIGN_EFFECT` only); the
  swarm bots (`tools/swarm-test.mjs`) have no foreign-card path.
- Foreign effects in bonus plans, chains as the non-first entry are untested, channel ticks resolve "no rules".
- `is_instant` is always false for foreign cards (the definition schema has no instant flag yet).
- `EFFECTS_RID` is still the placeholder; httpd fetch only runs for refs that name a repo.
