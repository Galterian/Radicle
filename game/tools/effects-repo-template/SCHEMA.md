# Effect definition schema (placeholder)

The real schema is written by milestone E1 in chaosD6 `game/effects-data/SCHEMA.md` and mirrored
here by `game/tools/effects-repo-sync.mjs`. Until then the only guaranteed fields are:

- `id` (string, `[A-Za-z0-9][A-Za-z0-9_.-]*`) — equal to the file name without `.json`.

Everything else in a definition is opaque to the loader; identity is sha256 of the canonical JSON.
