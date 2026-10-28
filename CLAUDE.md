# chaosD6 — working notes for Claude Code

Start with the skill `chaosd6-map` (repo layout, vocabulary, standing rulings) instead of exploring.
Then pick by task: `chaosd6-effect-impl` (effects/skills in the resolver), `chaosd6-swarm-test` (bot runs, divergence triage),
`chaosd6-logic-layer` (data/*.json rules, proposals, rebalance), `chaosd6-env` (WSL/UNC/npm/patch mechanics).

Non-negotiables: never commit unless asked; append data versions, never edit in place; after resolver changes run
`node --check game/peer.mjs`, `node tools/effects-check.mjs`, `node tools/logic-check.mjs`, then a swarm run expecting 0 divergences.
