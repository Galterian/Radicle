# Proposal votes on player-made definitions

User ruling 2026-11-17: when a card from another branch reaches you, you are testing it. Each such
card takes a vote from −6 to +6, and a minus vote needs a comment. The votes form the def's
**proposal vote collection**. This applies to effects, skills and classes (chaosD6-Effects,
chaosD6-Skills and chaosD6-Classes) and, since 2026-11-25, to GameModels bundles (chaosD6-GameModels).

Follow-up rulings (2026-11-17, the user's 5 answers):

1. **No vote from the author.** A vote is refused, and collectors drop it, when the voter's key or
   node NID owns the Radicle namespace the def came from, or when one of the voter's names (character
   name, team name, Radicle alias) equals the branch's `<who>` or the ref's `author`. The HUD hides
   the vote control for your own cards.
2. **A popup** appears the first time you see a player-made card version. It holds the slider, a
   comment box, **Vote** and **Later**. "Later" dismisses it, and the pulsing 🗳 button stays. It is
   shown once per def version per session, and never again after a vote or a dismissal. Several new
   cards queue up. It never steals the planning hotkeys.
3. **Publish automatically** after each vote, in the background and debounced, to the OCI seed only.
   If the publish fails, the vote stays local and is marked pending, and the publish is retried
   later. The HUD shows saved, published or pending.
4. **The validator** is fed only with **n ≥ 10** votes. When n ≥ 10 and mean ≤ −3, the collection
   gets a `review` flag that the verdict and the badge show. Below 10 votes, the votes have no
   effect. The creation validators keep their ±10 % tolerance.
5. **No carry-over:** a new def version (a new sha256, or a new commit for commit-only refs) starts
   with an empty collection.

Rulings of 2026-11-28 (these apply to every kind: effects, skills, classes and GameModels bundles
from chaosD6-GameModels — NPCs, monsters, buildings, quests):

6. **Tags.** Every vote may carry tags beside the number, saying what is wrong or right with it.
   The list is `TAGS` / `TAG_LABELS` in `game/proposal-votes.mjs`:

   | id | label |
   |---|---|
   | `overpowered` | Overpowered |
   | `weak` | Weak |
   | `too_simple` | Too simple |
   | `out_of_theme` | Too out of theme |
   | `duplicate` | Duplicating another |
   | `confusing` | Confusing |
   | `buggy` | Buggy / does not work |
   | `fun` | Fun |
   | `well_themed` | Fits the theme |
   | `creative` | Creative |

   Tags are optional on any vote, plus or minus. A minus vote still needs its comment. Unknown tags
   are dropped, not refused (`normalizeTags`: trimmed, lower case, de-duplicated, sorted).
7. **Needs rework.** The `review` flag (n ≥ 10 and mean ≤ −3) now means **NEEDS REWORK: that
   version is not playable.** The caster's side leaves it out; the resolver never reads votes. This
   replaces the 2026-11-22 ruling "shown grey, still playable". It lasts until the author pushes a
   new version, which starts at 0 votes (ruling 5) and can be voted on again.
8. **Publishable.** When n ≥ 10 and **more than 60 %** of the votes are positive (value > 0; 0 is
   not positive), the version is publishable: its author may merge it to main, or open a patch when
   they cannot merge. So 7 of 10 positive is publishable and 6 of 10 is not. A version that needs
   rework is never publishable. GameModels have no rebalance check, so votes (plus the 8B review)
   are their only gate.

The code is in `game/proposal-votes.mjs` (core, store, signing, git, scheduler, collections) and
`game/proposal-votes-publish.mjs` (publisher and collector, also a CLI). The HUD is
`game/js/proposal_vote_ui.js`. The tests are `game/tools/proposal-votes-check.mjs` (178 checks).
The peer and HUD wiring is in the PV1–PV6 hunks of `game/tools/out/_pv_hunks.py`, which are not
applied yet.

## Vote record

| field | rule |
|---|---|
| `kind` | `effect` \| `skill` \| `class` \| `gamemodels` (from the id prefix if not given; `npc_` / `bld_` / `mon_` = gamemodels) |
| `repo`, `branch`, `id` | the def ref (defs-repo.mjs). `branch` must be `players/<who>/<slug>`; built-ins take no votes |
| `sha256` / `commit` | the def version. At least one is needed: the full 64-hex sha256 or the full 40-hex commit |
| `ns` | optional: the publisher's Radicle namespace (node NID `z6Mk…`) the def was read from. It is not part of the key |
| `author` | optional: the ref's author name (defaults to `<who>` in the HUD) |
| `key` | `repo|branch|id|<sha256, else commit>` |
| `voter` | a `z6Mk…` profile device key (`<profile dir>/radicle/identity.pem`, shared with profile sync). Without a key it is `peer:<id>`, which is unsigned and kept local only |
| `voter_nid`, `voter_name`, `voter_handles` | who votes: the node NID and the names used for the author check |
| `value` | an integer from −6 to +6 |
| `comment` | 500 characters at most, with control characters stripped. **Required and non-empty when value < 0** |
| `tags` | optional (ruling 6): known tag ids only, sorted and de-duplicated; left out when empty. Part of the signed bytes |
| `at` | the ISO time of the vote |
| `dimension`, `door` | the game it was tested in. These are informational |
| `sig` | base64 ed25519 over `"chaosd6-proposal-vote\n" + canonicalJson(vote without sig)` |

Each voter has **one vote per voter per key**. The vote with the later `at` replaces the earlier one.

The **collection** is `aggregate(votes, key)`, which gives `{ n, mean (2 dp), min, max, positive,
review, publishable, tags: { <tag>: count }, negatives: [{ voter, voter_name?, value, comment, at }] }`,
where `positive` = the number of votes > 0,
`review = needsRework = n ≥ 10 && mean ≤ −3` (ruling 7: not playable) and
`publishable = n ≥ 10 && positive / n > 0.6 && !review` (ruling 8; `PUBLISH_MIN_VOTES`,
`PUBLISH_POSITIVE_SHARE`). Both flags are always derived again from n, mean and positive, and a
cached flag is never trusted.

The collection is **never stored inside the def**, because that would change its sha256. Readers
attach it in memory as `def.proposal_votes` (`withVoteCollection`).

Votes are profile data. The resolver, the snapshots and the state hash never read them.

## Authorship (ruling 1)

`authorConflict(target, me)` decides, with `me = { voter, nid, handles }`. Names are compared after
folding: lower case, accents stripped, non-alphanumerics turned into `-`, so "P-Larkin" equals
`players/p-larkin/…`.

- **Ref plumbing for `ns`.** None of these change any sha256, nor `fxKey` / `skKey` / `clKey`.
  - `defs-repo.mjs`: `ref(def, { ns })`, `parseRef` and `withProvenance()`. `loadFrom` takes `ns`,
    or reads it, together with the branch, off a Radicle storage ref
    `refs/namespaces/<nid>/refs/heads/<branch>`.
  - The handshakes: `makeFxRef` / `makeSkRef` / `makeClRef` take `{ ns }`. `parseLibbedRef` and
    `compactRef` carry `ns` (and `review`) on the wire. `FX_FORCE_NS` / `SK_FORCE_NS` /
    `CL_FORCE_NS` set it for the forced dev defs.
  - `js/effect_source.js`: `normalizeSource` keeps `ns` and `review`.
- **Who am I.**
  - `voter` is the profile key.
  - `nid` is the ctx `nid`, else the phone `bridge.json` nid, else `$RAD_HOME/keys/radicle.pub`
    (`localNodeNid`).
  - `handles` are the character name, the team, every `team_name` and character name in
    profile.json, and the Radicle alias.
- **Peer:** `recordVote` / `pvHandle` refuse with `code: 'author'`. `validateVote` also refuses a
  vote whose own voter fields name the author.
- **Collector:** `collectVotesFromGit` drops a vote when its votes branch's namespace, its voter or
  its `voter_nid` owns the def's `players/<who>/<slug>` branch in that storage, or equals the vote's
  `ns`, or is listed in the optional `authors` map.
- **HUD:** `pvIsMine(src, me)` mirrors the same rule. Own cards get no control, are left out of the
  🗳 count, and get no popup. A `code: 'author'` reply also hides that card.

## Storage, publish and collect (ruling 3)

1. **Local:** the votes are kept in `<profile dir>/proposal_votes.json` as
   `{ version: 1, votes: { "<key>#<voter>": vote } }`. This is a sidecar of `profile.json`, and
   `profile.json` itself is untouched. The publish state is in `proposal_votes.publish.json` as
   `{ repos: { <rid>: { state, upto, count, voter, commit?, error?, tries, via, at } } }`. Both
   files are written atomically.
2. **Peer WS:**
   - `{ kind: 'proposal_vote', ref, value, comment, tags? }` gives
     `{ kind: 'proposal_vote_saved', ok, key, publish, mine | error, code }`.
   - On hello, and again after each publish run (`notify = broadcastUI`), the peer sends
     `{ kind: 'proposal_votes', mine, me, collections, publish, limits, tags }`:
     - `mine[key]` = `{ value, comment, tags, at, pub, pub_error? }`;
     - `collections[key]` = `{ n, mean, positive, review, publishable, tags }`;
     - `limits` = `{ min, max, comment_max, review_min_votes, review_mean_max, publish_min_votes,
       publish_positive_share }`;
     - `tags` = `[{ id, label }]`, the tag list in display order.
   - `mine[key].pub` is one of:
     - `saved`: stored, with a publish queued or running. An unsigned vote is saved and local only.
     - `published`: pushed and announced.
     - `pending`: the last attempt after this vote failed. `pub_error` says why.
3. **Scheduler** (`schedulePublish`, inside the peer process):
   - It runs 3 s after the last vote, one run at a time.
   - While a signed vote is still owed, it retries with back-off: 2 min, doubling, up to 15 min.
   - A hello with owed votes from an earlier run schedules a retry 10 s later.
   - `PV_PUBLISH=0` turns publishing off.
4. **Desktop publish:** a child process `proposal-votes-publish.mjs`, per def repo:
   - It uses a bare `<profile dir>/proposal-votes-git/<rid>.git`.
   - It runs `git fetch rad +votes/<voter>`, then `publishVotesCommit`, which makes the whole tree of
     my signed votes for that repo at `votes/<id>/<branch with / → ~>@<version>.json`.
   - Then `git push rad refs/heads/votes/<voter>` (`rad://<rid>/<nid>`), then
     `rad sync <rid> --seed z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT --announce`.
   - The OCI seed (`CHAOSD6_OCI_SEED_NID`) is the only seed. There is no `rad sync` without
     `--seed`.
   - `SSH_AUTH_SOCK` falls back to `~/.ssh/agent.sock`. With no agent, the push fails, so the vote
     is pending and retried.
5. **Collect** (the same child, after publishing; or `--collect-only`):
   - `collectAll` reads `refs/namespaces/*/refs/heads/votes/*` from
     `$RAD_HOME/storage/<rid>` of the three def repos.
   - It keeps a vote only when it is signed, the signer is the branch's `<voter>`, the file name
     matches the vote, and it is not an author vote. My local votes are added.
   - The result goes to `<profile dir>/proposal_votes.collected.json` as
     `{ at, collections: { <key>: aggregate } }`.

## Validator and badge (rulings 4, 6–8)

- `validatorWithVotes(validate, { profileFile })` wraps a creation validator. Its verdict, with the
  ±10 % tolerance, is returned unchanged plus `{ votes: { n, mean }, review, publishable }`. `review`
  is true only with n ≥ 10 and mean ≤ −3; `publishable` only with n ≥ 10 and more than 60 %
  positive. `verdictWithVotes(verdict, aggregate)` is the same rule as a pure function.
- `collectionOf(ref)` and `collectionsForUI()` read the collected file.
- HUD (`js/proposal_vote_ui.js`, mirrors of the peer constants are checked by the tests):
  - The panel and popup rows show "players +1.5 (12)".
  - Needs rework: **⚑ needs rework — not playable**, and `setEffectSource(id, { …, review: true })`
    puts ⚑ on the card's source badge (the card turns grey; `votedLow()` is true).
  - Otherwise, when publishable: **✓ publishable (12 votes, 75 % positive)**.
  - The 3 most frequent tags with their counts: "tags: Overpowered ×4 · Weak ×2 · Fun ×1".
  - The vote control has a row of toggle chips, one per tag (from the hello's `tags`, else the
    built-in copy). My saved tags start selected, are sent with the vote, and are listed in
    "your vote +3 [Fun, Creative] · time".
  - `effect_source.js` renders ⚑ for any source with `review: true` and adds the tooltip line
    "⚑ NEEDS REWORK … not playable until its author pushes a new one".
- Not wired yet: the handshakes' `validate` hooks (another session's files). Wrapping them with
  `validatorWithVotes` is a one-line change per handshake when wanted. Leaving a needs-rework
  version out of play is the caster's side (hand / deck building), never the resolver.

## Phone (Godot) — spec only, not implemented

- **Peer side:** the same as desktop. The in-process peer has `pvHandle` and `pvHello`.
  `CHAOSD6_MOBILE=1` makes `publishMode()` return `'phone'`, so the publish runs in process as
  `publishAll({ via: 'bridge' })`. It POSTs `http://127.0.0.1:<port>/publish` with the bridge
  token:

  ```json
  { "rid": "<def repo rid>", "ref": "refs/heads/votes/<voter>", "mode": "snapshot",
    "files": { "votes/<id>/<file>.json": "<canonical vote json>\n" }, "remove": [], "prune_prefix": "votes/",
    "name": "<voter>", "email": "<voter>@chaosd6", "timestamp": 0, "message": "proposal votes (n)",
    "seed": "z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT" }
  ```

  - **lib.rs TODO:** add the `"votes"` feature. It accepts only `refs/heads/votes/z6Mk…` refs and
    paths under `votes/<id>/` that end in `.json`. It replaces the tree as a whole snapshot, with
    the parent set to our tip in our namespace, and announces only to `seed`.
  - Until then the bridge lacks `"votes"`, so the votes are **pending** with the error "phone Radicle
    node cannot publish votes yet". The votes stay on the phone, and the retry loop picks them up
    once a new APK ships the feature.
- **Hud.gd 🗳 button** sits next to the source-badge area.
  - It is hidden while no foreign def that is not mine has been seen.
  - Its count is the number of defs I have not voted on yet.
  - It pulses while that count is above 0.
- **Data:**
  - It uses the same WS messages as the desktop.
  - Defs count as "seen" from these:
    - hand, archive and class-state cards with a `source`;
    - `effect_source` / `skill_source` / `class_source` notices whose event is not `missing`.
  - The key is computed as in `pvKey()`.
  - The author check is `pvIsMine(src, me)`, with `me` from the hello.
- **Popup (ruling 2):**
  - It is a non-modal `PanelContainer` centred at the top, below the top bar, about 92 % of the
    screen width and at most 40 % of its height. Place it with `_anchored()`, not `.position`, and
    give it an explicit size inside the CanvasLayer.
  - It shows these, in order:
    - the title "New player-made <kind> in testing", plus "+N more" when cards are queued;
    - the name and the compact badge;
    - the players' mean and n, "⚑ needs rework — not playable" or "✓ publishable (n, % positive)"
      when it applies, and the top 3 tags with counts;
    - an `HSlider` from −6 to +6 with step 1;
    - one toggle `Button` per tag (hello `tags`), my saved tags pressed, sent as `tags`;
    - a `TextEdit` for the comment, with at most 500 characters;
    - the buttons **Vote** and **Later**.
  - It never calls `grab_focus()` on open. Tapping elsewhere on the map or the hand works normally,
    and the popup stays up.
  - The queue is in first-seen order, one card at a time. The shown and dismissed keys go to a
    session-only Dictionary, so they are not persisted across app restarts.
  - Show a card when all of these hold:
    - its key is not in `mine`;
    - it is not mine;
    - it has not been shown yet this session;
    - the hello has arrived, or 3 s have passed.
  - Close it, and remember the key, on **Later**, on `proposal_vote_saved ok`, or on `code: author`.
    A new def version is a new key, so it asks again.
- **Bottom sheet (🗳 tap):**
  - It is full width with one row per def, unvoted defs first. Each row has the same controls
    without **Later**.
  - The **Vote** button stays disabled while the value is below 0 and the trimmed comment is empty
    (hint: "A minus vote needs a comment").
  - Under the row it shows "your vote +3 · time", then the state: 💾 saved, ✓ published, or
    ⏳ pending with `pub_error` as the tooltip or subtitle. On failure it shows the error text from
    `proposal_vote_saved` instead.
- **Godot 4 trap:** the WebView tap block does not apply, because this is a native Control.
