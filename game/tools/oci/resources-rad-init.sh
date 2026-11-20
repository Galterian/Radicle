#!/usr/bin/env bash
# Publish the local chaosD6-Resources repo (media split out of the Code repo, 2026-11-20) to Radicle and the OCI seed.
# Modelled on classes-rad-init.sh / effects-rad-init.sh, with two differences:
#   - the repo is PUBLIC (--public): the phone fetches media anonymously through radicle-httpd;
#   - it is ~800 MB, so the OCI wait is longer and the rsync fallback is the likely path.
# RUN THIS YOURSELF (it signs with your Radicle key — the passphrase stays with you):
#   rad auth                       # once per session: unlocks the key into ssh-agent
#   bash /home/galt/repo_radicle_clone2/chaosD6/game/tools/oci/resources-rad-init.sh [--dry-run]
#
# Steps (each is idempotent; re-running after a failure is safe):
#   0. preflight  repo exists, on main, clean, has commits, manifest.json checks; rad CLI; local rad-node running
#   1. rad init   --name chaosD6-Resources --public --default-branch main  (skipped if already a rad repo)
#   2. git push rad main                      (no-op right after init)
#   3. OCI seeding policy: infra/oci/resources-setup.sh (rad seed --scope all) in the background,
#      while 4. rad node connect + rad sync --announce (OCI seed only) hands the repo to the seed
#   5. infra/oci/resources-setup.sh again → pin in web.pinned.repositories, restart httpd
#   6. HTTPS check + the follow-up commands to wire the RID into the game
set -euo pipefail
export PATH="$HOME/.radicle/bin:$PATH"
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done

REPO="${CHAOSD6_RESOURCES_REPO:-/home/galt/chaosd6-resources-repo}"
GAME_ROOT="/home/galt/repo_radicle_clone2/chaosD6"
OCI_HOST="${OCI_HOST:-92-5-138-121.sslip.io}"
# The ONLY seed we sync with. Never add others.
OCI_SEED_NID="z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT"
NAME="chaosD6-Resources"
DESC="chaosD6 media (Warlords 3 / Warlords Battlecry sprites, images, sounds, screenshots); third-party assets, rights belong to their owners"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }

echo "== 0. preflight =="
[ -d "$REPO/.git" ] || { echo "!! $REPO is not a git repo — see game/tools/out/CUTOVER.md" >&2; exit 1; }
cd "$REPO"
BR=$(git symbolic-ref --short HEAD)
[ "$BR" = main ] || { echo "!! $REPO is on '$BR', expected main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "!! $REPO has uncommitted changes" >&2; git status --short | head -20 >&2; exit 1; }
git rev-parse --verify -q HEAD >/dev/null || { echo "!! no commits yet" >&2; exit 1; }
node tools/manifest.mjs --check
command -v rad >/dev/null || { echo "!! rad CLI not found" >&2; exit 1; }
rad node status >/dev/null 2>&1 || { echo "!! local radicle-node is not running: start it (rad node start) and re-run" >&2; [ "$DRY" = 1 ] || exit 1; }
echo "repo $REPO @ $(git rev-parse --short HEAD) ($(git rev-list --count HEAD) commits), identity $(rad self --alias 2>/dev/null) $(rad node status --only nid 2>/dev/null || true)"

echo "== 1. rad init =="
if RID=$(rad . 2>/dev/null) && [ -n "$RID" ] && git remote get-url rad >/dev/null 2>&1; then
  echo "already a Radicle repo: $RID"
else
  run rad init --name "$NAME" --description "$DESC" --default-branch main --public --scope followed --no-confirm
  RID=$( [ "$DRY" = 1 ] && echo "rad:zDRYRUN" || rad . )
fi
echo "RID: $RID"

echo "== 2. push main =="
run git push rad main

echo "== 3+4. OCI seeding policy + announce =="
run rad node connect "$OCI_SEED_NID@$OCI_HOST:8776" || true
if [ "$DRY" = 1 ]; then
  bash "$GAME_ROOT/infra/oci/resources-setup.sh" "$RID" --dry-run
  echo "+ rad sync $RID --seed $OCI_SEED_NID --replicas 1 --announce --timeout 600sec"
else
  # resources-setup.sh sets `rad seed --scope all` then waits (≤ WAIT_SECS) for the repo to land; announce meanwhile.
  ( cd "$GAME_ROOT" && WAIT_SECS=900 bash infra/oci/resources-setup.sh "$RID" ) & SETUP_PID=$!
  sleep 8
  # --replicas 1: OCI is the only seed we want (see desktop-announce-oci.sh).
  rad sync "$RID" --seed "$OCI_SEED_NID" --replicas 1 --announce --timeout 600sec || echo "  (announce returned non-zero; setup keeps waiting)"
  if ! wait "$SETUP_PID"; then
    echo "!! OCI did not get the repo over p2p (expected for ~800 MB) — rsync fallback:" >&2
    echo "   RID_DIR=${RID#rad:} bash $GAME_ROOT/game/tools/oci/push-to-oci.sh --rsync-only" >&2
    echo "   then: bash $GAME_ROOT/infra/oci/resources-setup.sh $RID" >&2
    exit 3
  fi
fi

echo "== 6. check =="
run curl -fsS -m 10 "https://$OCI_HOST/api/v1/repos/$RID"
echo
cat <<EOF

Done. Wire the RID into the game (prepared, not applied — review the diff first):
  python3 $GAME_ROOT/game/tools/out/_resources_rid_patch.py $RID --check    # shows the edits
  python3 $GAME_ROOT/game/tools/out/_resources_rid_patch.py $RID --apply    # AssetBootstrap.gd, asset-root.mjs, OCI seed lists
Then follow game/tools/out/CUTOVER.md (APK build, phone fresh-install test, cutover, commit).
Later media updates:
  (cd $REPO && node tools/manifest.mjs --write && git add -A && git commit -m "..." && git push rad main \\
     && rad sync --announce $RID --seed $OCI_SEED_NID --replicas 1)
EOF
