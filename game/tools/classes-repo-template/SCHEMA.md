# Class definition schema

The schema lives in chaosD6 at `game/classes-data/SCHEMA.md` (`chaosd6.class/1`, `chaosd6.class-lib/1`).
`game/tools/classes-repo-sync.mjs` mirrors it here together with `HOOKS.md` and `class.schema.json`.
The loader relies on two fields only:

- `id` (string, `class_[a-z0-9_]+`): equal to the file name without `.json`.
- `uses` (optional array of lib ids): each id must exist as `lib/<id>.json`.

The rest of a definition is checked by the pinned engine (`classes.mjs#validateClassDef`) and the pinned validator.
A definition's identity is the sha256 of its canonical JSON.
