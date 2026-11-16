# Skill definition schema (placeholder)

The real schema is written in chaosD6 `game/skills-data/SCHEMA.md` (program S2) and mirrored
here by `game/tools/skills-repo-sync.mjs`. Until then the only guaranteed fields are:

- `id` (string, `[A-Za-z0-9][A-Za-z0-9_.-]*`) — equal to the file name without `.json`.
- `uses` (optional array of lib ids) — each must exist as `lib/<id>.json`.

Everything else in a definition is opaque to the loader; identity is sha256 of the canonical JSON.
