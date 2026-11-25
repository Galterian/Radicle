#!/usr/bin/env bash
# Publish the local chaosD6-GameModels repo to Radicle and the OCI seed.
# RUN THIS YOURSELF (it signs with your Radicle key — the passphrase stays with you):
#   rad auth                       # once per session: unlocks the key into ssh-agent
#   bash /home/galt/repo_radicle_clone2/chaosD6/game/tools/oci/gamemodels-rad-init.sh [--dry-run]
#
# Steps (each is idempotent; re-running after a failure is safe):
#   0. preflight  repo exists, on main, clean, has commits; rad CLI; local rad-node running
#   1. rad init   --name chaosD6-GameModels --private --default-branch main  (skipped if already a rad repo)
#   2. git push rad main                      (no-op right after init)
#   3. OCI seeding policy: infra/oci/gamemodels-setup.sh (rad seed --scope all) in the background,
#      while 4. rad node connect + rad sync --announce  hands the repo to the seed
#   5. infra/oci/gamemodels-setup.sh again → pin in web.pinned.repositories, restart httpd
#   6. HTTPS check + the follow-up commands to wire the RID into the game
set -euo pipefail
export PATH="$HOME/.radicle/bin:$PATH"
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done

REPO="${CHAOSD6_GAMEMODELS_REPO:-/home/galt/chaosd6-gamemodels-repo}"
GAME_ROOT="/home/galt/repo_radicle_clone2/chaosD6"
OCI_HOST="${OCI_HOST:-92-5-138-121.sslip.io}"
OCI_SEED_NID="${OCI_SEED_NID:-z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT}"
NAME="chaosD6-GameModels"
DESC="chaosD6 races, village buildings, NPCs, monsters, villages and quests as data (JsonLogic agendas) + offline tools: main = built-in, players/<nid-or-name>/<slug> = proposals"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }

echo "== 0. preflight =="
[ -d "$REPO/.git" ] || { echo "!! $REPO is not a git repo — run: node $GAME_ROOT/game/tools/gamemodels-repo-sync.mjs" >&2; exit 1; }
cd "$REPO"
BR=$(git symbolic-ref --short HEAD)
[ "$BR" = main ] || { echo "!! $REPO is on '$BR', expected main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "!! $REPO has uncommitted changes" >&2; git status --short >&2; exit 1; }
git rev-parse --verify -q HEAD >/dev/null || { echo "!! no commits yet" >&2; exit 1; }
# the repo's tools need json-logic-js (node_modules/ is gitignored): npm first; behind the corporate proxy npm may fail —
# then the game's own copy (the same library the game evaluates agendas with)
if [ ! -d node_modules/json-logic-js ]; then
  npm install --no-audit --no-fund >/dev/null 2>&1 || { echo "npm install failed — using $GAME_ROOT/game/node_modules/json-logic-js"; mkdir -p node_modules && cp -r "$GAME_ROOT/game/node_modules/json-logic-js" node_modules/; }
fi
node tools/manifest.mjs --check
node tools/check.mjs >/dev/null || { echo "!! tools/check.mjs fails (pins/schema) — fix before publishing" >&2; node tools/check.mjs >&2; exit 1; }
command -v rad >/dev/null || { echo "!! rad CLI not found" >&2; exit 1; }
rad node status >/dev/null 2>&1 || { echo "!! local radicle-node is not running: start it (rad node start) and re-run" >&2; [ "$DRY" = 1 ] || exit 1; }
echo "repo $REPO @ $(git rev-parse --short HEAD) ($(git rev-list --count HEAD) commits), identity $(rad self --alias 2>/dev/null) $(rad node status --only nid 2>/dev/null || true)"

echo "== 1. rad init =="
if RID=$(rad . 2>/dev/null) && [ -n "$RID" ] && git remote get-url rad >/dev/null 2>&1; then
  echo "already a Radicle repo: $RID"
else
  run rad init --name "$NAME" --description "$DESC" --default-branch main --private --scope followed --no-confirm
  RID=$( [ "$DRY" = 1 ] && echo "rad:zDRYRUN" || rad . )
fi
echo "RID: $RID"

echo "== 2. push main =="
run git push rad main

echo "== 3+4. OCI seeding policy + announce =="
run rad node connect "$OCI_SEED_NID@$OCI_HOST:8776" || true
if [ "$DRY" = 1 ]; then
  bash "$GAME_ROOT/infra/oci/gamemodels-setup.sh" "$RID" --dry-run
else
  # gamemodels-setup.sh sets `rad seed --scope all` then waits (≤ WAIT_SECS) for the repo to land; announce meanwhile.
  ( cd "$GAME_ROOT" && WAIT_SECS=180 bash infra/oci/gamemodels-setup.sh "$RID" ) & SETUP_PID=$!
  sleep 8
  rad sync "$RID" --seed "$OCI_SEED_NID" --announce --timeout 120sec || echo "  (announce returned non-zero; setup keeps waiting)"
  if ! wait "$SETUP_PID"; then
    echo "!! OCI did not get the repo over p2p — rsync fallback:" >&2
    echo "   RID_DIR=${RID#rad:} bash $GAME_ROOT/game/tools/oci/push-to-oci.sh --rsync-only" >&2
    echo "   then: bash $GAME_ROOT/infra/oci/gamemodels-setup.sh $RID" >&2
    exit 3
  fi
fi

echo "== 6. check =="
run curl -fsS -m 10 "https://$OCI_HOST/api/v1/repos/$RID"
echo
cat <<EOF

Done. The definitions live only in $REPO; the game reads the catalog compiled from it
(node $GAME_ROOT/game/tools/gamemodels-build.mjs → assets/gamemodels/catalog.json).
Record the RID for the player-generated NPC / monster flow:  export CHAOSD6_GAMEMODELS_RID=$RID
Later: edit + commit in $REPO, then  (cd $REPO && git push rad main && rad sync --announce --seed $OCI_SEED_NID)
Checker tools changed in chaosD6:  node $GAME_ROOT/game/tools/gamemodels-repo-sync.mjs --commit
EOF
