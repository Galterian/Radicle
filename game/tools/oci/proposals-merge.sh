#!/bin/bash
# Maintainer tool: list the open proposals (player branches + patches) of chaosD6-Effects / -Skills / -Classes /
# -GameModels with their vote collections, and merge a PUBLISHABLE one into main through the repo-side pipeline
# (defs-publish.sh / gamemodels-publish.sh: checks → commit → git push rad main → announce to the OCI seed only).
# Run inside WSL, by a delegate:
#   bash /home/galt/repo_radicle_clone2/chaosD6/game/tools/oci/proposals-merge.sh list [--kind effect|skill|class|gamemodels] [--all]
#   DRY=1 bash …/proposals-merge.sh merge --kind effect --branch players/<who>/<slug>      # every check, nothing merged / pushed
#   bash …/proposals-merge.sh merge --kind effect --branch players/<who>/<slug> [--force] [-m "message"]
# Refuses a version that is not publishable (n ≥ 10, > 60 % positive) unless --force; never one that needs rework.
# Details: proposals-merge.mjs header.
set -euo pipefail
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
[ -d "$HOME/.radicle/bin" ] && PATH="$HOME/.radicle/bin:$PATH"
GAME=/home/galt/repo_radicle_clone2/chaosD6/game
if [ "${1:-}" = merge ] && [ "${DRY:-0}" != 1 ]; then
  export SSH_AUTH_SOCK=${SSH_AUTH_SOCK:-$HOME/.ssh/agent.sock}
  ssh-add -l >/dev/null || { echo "STOP: no key in the ssh agent at $SSH_AUTH_SOCK (ssh-add your Radicle key first, or DRY=1)" >&2; exit 1; }
  command -v rad >/dev/null || { echo "STOP: rad not on PATH" >&2; exit 1; }
fi
exec node "$GAME/tools/oci/proposals-merge.mjs" "$@"
