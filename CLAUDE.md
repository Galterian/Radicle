# chaosD6 — working notes for Claude Code

Start with the skill `chaosd6-map` (repo layout, vocabulary, standing rulings) instead of exploring.
Then pick by task: `chaosd6-effect-impl` (effects/skills in the resolver), `chaosd6-swarm-test` (bot runs, divergence triage),
`chaosd6-logic-layer` (data/*.json rules, proposals, rebalance), `chaosd6-env` (WSL/UNC/npm/patch mechanics),
`chaosd6-llm` (AI skirmish: llama-server on desktop/OCI, LLM bot roles, NPC builders, speech balloons).

Non-negotiables: never commit unless asked; append data versions, never edit in place; after resolver changes run
`node --check game/peer.mjs`, `node tools/effects-check.mjs`, `node tools/logic-check.mjs`, then a swarm run expecting 0 divergences.

Definitions (since 2026-11-28): effects, skills and classes are edited in their repos (`/home/galt/chaosd6-{effects,skills,classes}-repo`),
never in `game/{effects,skills,classes}-data/` — those are built copies (`node tools/defs-build.mjs [kind]`, pins in `game/defs-pins.json`,
`--check` fails on a hand edit). Publish with `tools/oci/defs-publish.sh <kind> -m "…"` (the user runs it: Radicle key).
