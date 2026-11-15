#!/bin/bash
# Regenerate every `logic` key in data/*.json from game/tools/logic/<collection>.logic.json — the single source of
# truth for logic since 2026-11-14 (the tools/out generators are retired). logic-apply --replace over every mapping,
# under the shared data lock. A no-op (no file rewritten) when data is already in sync.
#   bash game/tools/logic/apply-all.sh [--dry-run]        (WSL; from Windows: MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash <abs path>)
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
cd "$(dirname "$0")/../.." || exit 1
exec flock /tmp/chaosd6-data.lock sh -c 'rc=0; for m in tools/logic/*.logic.json; do node tools/logic-apply.mjs "$m" --replace "$@" || rc=1; done; exit $rc' sh "$@"
