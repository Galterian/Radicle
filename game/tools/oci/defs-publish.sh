#!/bin/bash
# Publish chaosD6-Effects / -Skills / -Classes after editing definitions IN THE REPO (the source of truth since the defs
# flip, 2026-11-28; game/<kind>-data is the built copy, tools/defs-build.mjs). Run inside WSL, by a delegate:
#   bash /home/galt/repo_radicle_clone2/chaosD6/game/tools/oci/defs-publish.sh <effects|skills|classes> -m "what changed"
# Steps: build the game copy from the repo → the kind's checks on it → <kind>-repo-sync --no-commit (the repo's tooling,
# pins, index.json from the repo itself) → repo check → commit → git push rad main → announce to the OCI seed only →
# rebuild the game copy so game/defs-pins.json records the published commit (that file is then a game-repo change).
# Env: DRY=1 (no ssh-agent, no push / announce; the commit still happens — use with a <KIND>_REPO copy),
#      REPO=<path> (default: the kind's repo next to chaosD6). Stops on the first failure.
set -euo pipefail
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
[ -d "$HOME/.radicle/bin" ] && PATH="$HOME/.radicle/bin:$PATH"
GAME=/home/galt/repo_radicle_clone2/chaosD6/game
SEED=z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT   # OCI seed only
KIND=${1:-}; shift || true
MSG=""
while [ $# -gt 0 ]; do case "$1" in -m) MSG=$2; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
die() { echo "STOP: $*" >&2; exit 1; }
step() { echo; echo "=== $*"; }
case "$KIND" in
  effects) DEF_REPO=${REPO:-/home/galt/chaosd6-effects-repo}; SYNC=effects-repo-sync
           CHECKS="effects-repo-check effect-engine-check effect-standing-check effect-hooks-check effects-check logic-check effects-handshake-check";;
  skills)  DEF_REPO=${REPO:-/home/galt/chaosd6-skills-repo}; SYNC=skills-repo-sync
           CHECKS="skills-repo-check skill-engine-check skills-check skills-handshake-check skills-rebalancing-check-test logic-check";;
  classes) DEF_REPO=${REPO:-/home/galt/chaosd6-classes-repo}; SYNC=classes-repo-sync
           CHECKS="classes-repo-check class-engine-check classes-check classes-handshake-check logic-check";;
  *) die "usage: defs-publish.sh <effects|skills|classes> -m \"message\"";;
esac
[ -n "$MSG" ] || die "-m \"what changed\" is required (the repo commit message)"
DRY=${DRY:-0}
LOG=$(mktemp -d /tmp/defs-publish-$KIND.XXXXXX)

if [ "$DRY" != 1 ]; then
  step "ssh-agent"
  export SSH_AUTH_SOCK=$HOME/.ssh/agent.sock
  ssh-add -l || die "no key in the ssh agent at $SSH_AUTH_SOCK (ssh-add your Radicle key first)"
  command -v rad >/dev/null || die "rad not on PATH"
fi
[ -d "$DEF_REPO/.git" ] || die "$DEF_REPO is not a git repo"
[ "$(git -C "$DEF_REPO" symbolic-ref --short HEAD)" = main ] || die "$DEF_REPO is not on main"

cd "$GAME"
step "build game/$KIND-data from $DEF_REPO"
node tools/defs-build.mjs "$KIND" --repo-"$KIND" "$DEF_REPO" || die "defs-build failed"

step "checks (logs $LOG)"
run() { local t=$1; shift; if "$@" > "$LOG/$t.log" 2>&1; then echo "  ok   $t ($(grep -v '^\s*$' "$LOG/$t.log" | tail -1 | cut -c1-90))"; else tail -20 "$LOG/$t.log"; die "$t failed (log $LOG/$t.log)"; fi; }
for t in $CHECKS; do [ -f "tools/$t.mjs" ] || die "tools/$t.mjs missing"; run "$t" node "tools/$t.mjs"; done

step "refresh the repo's tooling + index from the repo itself"
node "tools/$SYNC.mjs" --repo "$DEF_REPO" --no-commit > "$LOG/sync.log" 2>&1 || { tail -10 "$LOG/sync.log"; die "$SYNC failed"; }
if [ -f "$DEF_REPO/tools/check.mjs" ]; then (cd "$DEF_REPO" && node tools/check.mjs --all > "$LOG/repo-check.log" 2>&1) || { tail -10 "$LOG/repo-check.log"; die "repo tools/check.mjs failed"; }
else (cd "$DEF_REPO" && node tools/manifest.mjs --check) || die "index.json stale"; fi

step "commit"
git -C "$DEF_REPO" add -A
git -C "$DEF_REPO" diff --cached --quiet && die "nothing to publish in $DEF_REPO"
git -C "$DEF_REPO" diff --cached --stat | tail -8
git -C "$DEF_REPO" commit -q -m "$MSG"
echo "  $(git -C "$DEF_REPO" log --oneline -1)"

if [ "$DRY" = 1 ]; then echo; echo "DRY=1: not pushing / announcing. Logs: $LOG"; exit 0; fi
step "push $DEF_REPO"
git -C "$DEF_REPO" push rad main || die "git push rad main failed"
(cd "$DEF_REPO" && rad sync --announce --seed "$SEED") || die "rad sync --announce failed"

step "pin the published commit in game/defs-pins.json"
node tools/defs-build.mjs "$KIND" --repo-"$KIND" "$DEF_REPO" && node tools/defs-build.mjs --check | tail -1
echo; echo "done: $KIND published @ $(git -C "$DEF_REPO" rev-parse --short HEAD). Commit game/defs-pins.json + game/$KIND-data with the game. Logs: $LOG"
