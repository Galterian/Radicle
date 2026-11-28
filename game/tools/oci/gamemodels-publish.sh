#!/bin/bash
# Publish chaosD6-GameModels after editing it (the repo is the source; the game builds assets/gamemodels/catalog.json from
# it). Run inside WSL, by a delegate:
#   bash /home/galt/repo_radicle_clone2/chaosD6/game/tools/oci/gamemodels-publish.sh -m "what changed"
# Steps: gamemodels-repo-sync (tooling, the engine pinned = game/gamemodels.mjs + agenda.mjs, pins.json, index.json) →
# repo check → game build + gamemodels-check → commit → git push rad main → announce to the OCI seed only.
# Env: DRY=1 (no ssh-agent, no push / announce; the commit still happens — use with a REPO copy), REPO=<path>.
# Stops on the first failure.
set -euo pipefail
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
[ -d "$HOME/.radicle/bin" ] && PATH="$HOME/.radicle/bin:$PATH"
GAME=/home/galt/repo_radicle_clone2/chaosD6/game
SEED=z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT   # OCI seed only
GM_REPO=${REPO:-/home/galt/chaosd6-gamemodels-repo}
MSG=""
while [ $# -gt 0 ]; do case "$1" in -m) MSG=$2; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
die() { echo "STOP: $*" >&2; exit 1; }
step() { echo; echo "=== $*"; }
[ -n "$MSG" ] || die "-m \"what changed\" is required (the repo commit message)"
DRY=${DRY:-0}

if [ "$DRY" != 1 ]; then
  step "ssh-agent"
  export SSH_AUTH_SOCK=$HOME/.ssh/agent.sock
  ssh-add -l || die "no key in the ssh agent at $SSH_AUTH_SOCK (ssh-add your Radicle key first)"
  command -v rad >/dev/null || die "rad not on PATH"
fi
[ -d "$GM_REPO/.git" ] || die "$GM_REPO is not a git repo"
[ "$(git -C "$GM_REPO" symbolic-ref --short HEAD)" = main ] || die "$GM_REPO is not on main"

cd "$GAME"
step "sync tooling + engine pin + index"
node tools/gamemodels-repo-sync.mjs --repo "$GM_REPO" | tail -3 || die "gamemodels-repo-sync failed"
(cd "$GM_REPO" && node tools/check.mjs | tail -1) || die "GameModels repo check failed"
step "game build + checks"
CHAOSD6_GAMEMODELS_REPO="$GM_REPO" node tools/gamemodels-build.mjs | tail -1 || die "gamemodels-build failed"
node tools/gamemodels-check.mjs | tail -1 || die "gamemodels-check failed"

step "commit"
git -C "$GM_REPO" add -A
git -C "$GM_REPO" diff --cached --quiet && die "nothing to publish in $GM_REPO"
git -C "$GM_REPO" diff --cached --stat | tail -6
git -C "$GM_REPO" commit -q -m "$MSG"
echo "  $(git -C "$GM_REPO" log --oneline -1)"

if [ "$DRY" = 1 ]; then echo; echo "DRY=1: not pushing / announcing."; exit 0; fi
step "push $GM_REPO"
git -C "$GM_REPO" push rad main || die "git push rad main failed"
(cd "$GM_REPO" && rad sync --announce --seed "$SEED") || die "rad sync --announce failed"
echo; echo "done: chaosD6-GameModels published @ $(git -C "$GM_REPO" rev-parse --short HEAD). Commit assets/gamemodels/catalog.json with the game."
