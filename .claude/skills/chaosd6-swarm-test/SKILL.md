---
name: chaosd6-swarm-test
description: How to run the chaosD6 bot swarm (tools/swarm-run.sh via WSL), force effects/classes into decks, find the right log directory, summarise a run, and triage STATE DIVERGENCE lines (resolver bug vs far-peer tiering false alarm). Use for "run the swarm", "regression", "divergences", "check the logs".
---

# Swarm run and triage

## Run (always via WSL, foreground, from a script file)

```bash
# from Windows bash — one line, no inline $ or parentheses
MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash /home/galt/repo_radicle/chaosD6-fix/game/tools/out/_run.sh
```
with `_run.sh`:
```bash
#!/usr/bin/env bash
cd /home/galt/repo_radicle/chaosD6-fix/game
export FORCE_EFFECTS=effect_golems_earth,effect_resurrect_death_ward   # pins effects into player decks
export FORCE_CLASS=class_reaver NO_C=1                                   # optional; NO_C=1 skips launcher C (second identity)
bash tools/swarm-run.sh 4                                                 # arg = minutes; ~4 min + 20 s startup
```
Tool timeout: 600000 ms for a 4-minute run. `nohup`/detached from a `wsl` session dies — stay foreground.
`swarm-run.sh` kills every `node *.mjs`, `node --check peer.mjs`, starts `start-all.mjs` (launcher A, log `/tmp/chaos-A.log`),
optionally launcher C (`tools/start-b.sh`, needs `~/.radicle-b`), then `tools/swarm-test.mjs <launcher> <minutes>`
(stdout → `/tmp/swarm.log`). Other knobs the launcher inherits: `FORCE_SKILLS`, `FORCE_OPENING`, `CHARACTER_ID`, `REVEAL_RADIUS`.

## Find the logs

Per-peer logs: `game/logs/swarm-HHMM/peer_<label>.log` (players `player-1`, `P-Agent3`…, monsters, companions `*-sumN.log`).
**Do not use `ls -td`** — WSL mtimes lag. Take the dimension from `/tmp/swarm.log`:
```bash
D=logs/swarm-$(grep -oE 'hosted Swarm-[0-9]+' /tmp/swarm.log | head -1 | grep -oE '[0-9]+$')
```

## Summarise (template — copy to `game/tools/out/_swarm_summary.sh`, adjust the grep for the effect under test)

```bash
#!/usr/bin/env bash
cd "$(dirname "$0")/../.."
D=logs/swarm-$(grep -oE 'hosted Swarm-[0-9]+' /tmp/swarm.log | head -1 | grep -oE '[0-9]+$'); echo "DIR $D"
echo "errors: $(grep -h 'Uncaught\|TypeError\|ReferenceError\|SyntaxError' "$D"/*.log | wc -l)"
grep -h 'Uncaught\|TypeError\|ReferenceError\|SyntaxError' "$D"/*.log | head -5
echo "divergences: $(grep -h 'STATE DIVERGENCE' "$D"/*.log | wc -l)"
echo '--- effect lines'
grep -h 'paid (\|falls —\|raised by\|Death Ward\|<your log tag>' "$D"/*.log | sed 's/^\[\([^]]*\)\] /\1: /' \
  | sed 's/([0-9-]*,[0-9-]*)/(q,r)/g' | sort | uniq -c | sort -rn | head -30
grep -h 'strong-region' /tmp/swarm.log | tail -1 | cut -c1-160
grep -h 'agents stopped' /tmp/swarm.log | cut -c1-700
```
Keep the output under ~60 lines (`uniq -c`, `cut -c1-160`, `head`). Previous variants live in `game/tools/out/_swarm_summary*.sh`, `_swarm_div*.sh`, `_swarm_raise*.sh`.

## Triage divergences

1. `strong-region sizes` in `/tmp/swarm.log`: sizes 0–5 with bots spread far apart → near-vs-far peer tiering, **not a bug** (seen twice; reruns with one shared region → 0). Only chase when regions are large or the same action diverges on peers in contact.
2. Pick two peers that disagree, print the ~60 lines before `STATE DIVERGENCE #1` filtered to resolution lines (`_swarm_div3.sh` pattern): compare damage, members, `summoned_csv`, wards.
3. Classic causes already fixed (recognise the signature): dead peer admitting a mid-action joiner (members differ by one fresh companion → `freezeRoundMembers()` ordering); companion vanished while owner held the card (gossip loss → loopback heartbeat); caster fizzles while the corpse sees a raise (`resurrect:` lines now printed on all peers with life/distance).
4. An effect never firing is usually bot behaviour, not engine: check `tools/swarm-test.mjs` start/target conditions and `npcPlan()`.

## What a passing run looks like

`errors: 0`, `divergences: 0`, the forced effect's log line from several peers with identical text, `agents stopped` with all agents alive or dead for a reason you can name.
Note anything "verified only on the miss path" (e.g. Balefire landing, Rule 24 on Summoning, ∀ binds) — bots rarely double-cast.
