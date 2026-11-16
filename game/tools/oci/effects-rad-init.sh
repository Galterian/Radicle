#!/usr/bin/env bash
# Publish the local chaosD6-Effects repo (program E3) to Radicle and the OCI seed.
# RUN THIS YOURSELF (it signs with your Radicle key — the passphrase stays with you):
#   rad auth                       # once per session: unlocks the key into ssh-agent
#   bash /home/galt/repo_radicle_clone2/chaosD6/game/tools/oci/effects-rad-init.sh [--dry-run]
#
# Steps (each is idempotent; re-running after a failure is safe):
#   0. preflight  repo exists, on main, clean, has commits; rad CLI; local rad-node running
#   1. rad init   --name chaosD6-Effects --public --default-branch main  (skipped if already a rad repo)
#   2. git push rad main                      (no-op right after init)
#   3. OCI seeding policy: infra/oci/effects-setup.sh (rad seed --scope all) in the background,
#      while 4. rad node connect + rad sync --announce  hands the repo to the seed
#   5. infra/oci/effects-setup.sh again → pin in web.pinned.repositories, restart httpd
#   6. HTTPS check + the follow-up commands to wire the RID into the game
set -euo pipefail
export PATH="$HOME/.radicle/bin:$PATH"
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done

REPO="${CHAOSD6_EFFECTS_REPO:-/home/galt/chaosd6-effects-repo}"
GAME_ROOT="/home/galt/repo_radicle_clone2/chaosD6"
OCI_HOST="${OCI_HOST:-92-5-138-121.sslip.io}"
OCI_SEED_NID="${OCI_SEED_NID:-z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT}"
NAME="chaosD6-Effects"
DESC="chaosD6 effects as data: main = built-in, players/<nid-or-name>/<slug> = proposals"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }

echo "== 0. preflight =="
[ -d "$REPO/.git" ] || { echo "!! $REPO is not a git repo — run: node $GAME_ROOT/game/tools/effects-repo-sync.mjs" >&2; exit 1; }
cd "$REPO"
BR=$(git symbolic-ref --short HEAD)
[ "$BR" = main ] || { echo "!! $REPO is on '$BR', expected main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "!! $REPO has uncommitted changes" >&2; git status --short >&2; exit 1; }
git rev-parse --verify -q HEAD >/dev/null || { echo "!! no commits yet" >&2; exit 1; }
node tools/manifest.mjs --check
command -v rad >/dev/null || { echo "!! rad CLI not found" >&2; exit 1; }
rad node status >/dev/null 2>&1 || { echo "!! local radicle-node is not running: start it (rad node start) and re-run" >&2; [ "$DRY" = 1 ] || exit 1; }
echo "repo $REPO @ $(git rev-parse --short HEAD) ($(git rev-list --count HEAD) commits), identity $(rad self --alias 2>/dev/null) $(rad node status --only nid 2>/dev/null || true)"

echo "== 1. rad init =="
if RID=$(rad . 2>/dev/null) && [ -n "$RID" ] && git remote get-url rad >/dev/null 2>&1; then
  echo "already a Radicle repo: $RID"
else
  run rad init --name "$NAME" --description "$DESC" --default-branch main --public --scope all --no-confirm
  RID=$( [ "$DRY" = 1 ] && echo "rad:zDRYRUN" || rad . )
fi
echo "RID: $RID"

echo "== 2. push main =="
run git push rad main

echo "== 3+4. OCI seeding policy + announce =="
run rad node connect "$OCI_SEED_NID@$OCI_HOST:8776" || true
if [ "$DRY" = 1 ]; then
  bash "$GAME_ROOT/infra/oci/effects-setup.sh" "$RID" --dry-run
else
  # effects-setup.sh sets `rad seed --scope all` then waits (≤ WAIT_SECS) for the repo to land; announce meanwhile.
  ( cd "$GAME_ROOT" && WAIT_SECS=180 bash infra/oci/effects-setup.sh "$RID" ) & SETUP_PID=$!
  sleep 8
  rad sync "$RID" --seed "$OCI_SEED_NID" --announce --timeout 120sec || echo "  (announce returned non-zero; setup keeps waiting)"
  if ! wait "$SETUP_PID"; then
    echo "!! OCI did not get the repo over p2p — rsync fallback:" >&2
    echo "   RID_DIR=${RID#rad:} bash $GAME_ROOT/game/tools/oci/push-to-oci.sh --rsync-only" >&2
    echo "   then: bash $GAME_ROOT/infra/oci/effects-setup.sh $RID" >&2
    exit 3
  fi
fi

echo "== 6. check =="
run curl -fsS -m 10 "https://$OCI_HOST/api/v1/repos/$RID"
echo
cat <<EOF

Done. Wire the RID into the game (prepared, not applied — review the diff first):
  python3 $GAME_ROOT/game/tools/out/_effects_rid_patch.py $RID            # dry run: shows the edits
  python3 $GAME_ROOT/game/tools/out/_effects_rid_patch.py $RID --apply    # RadicleBoot.gd + effects-repo.mjs
Later syncs of built-in effects:
  node $GAME_ROOT/game/tools/effects-repo-sync.mjs && (cd $REPO && git push rad main && rad sync --announce)
EOF
