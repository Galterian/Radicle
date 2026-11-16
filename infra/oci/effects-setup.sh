#!/usr/bin/env bash
# Idempotent OCI-seed side of chaosD6-Effects (program E3). Unlike chaosD6-Profiles the OCI
# node is NOT the delegate: the repo is `rad init`ed on the dev PC (delegate = the user's key,
# game/tools/oci/effects-rad-init.sh) and players push `players/<nid-or-name>/<slug>` branches in
# their own namespaces. The seed must therefore
#   1. seed the RID with scope `all` (every player namespace, not only followed NIDs),
#   2. once the repo has replicated into storage, pin it in web.pinned.repositories so
#      radicle-httpd's /api/v1/repos (default show=pinned) lists it — the phone reads
#      /api/v1/repos/<rid>/blob/<commit>/effects/<id>.json from there (game/effects-repo.mjs),
#   3. restart radicle-httpd and check the repo answers over HTTPS.
# No service, no caddy route: writes arrive over Radicle p2p only.
#
# Usage (from WSL, repo root):  infra/oci/effects-setup.sh rad:z…   [--dry-run]
#   SSH_KEY=~/.ssh/id_rsa  OCI_HOST=ubuntu@92.5.138.121  WAIT_SECS=120 (storage poll)
set -euo pipefail
cd "$(dirname "$0")/../.."
RID="${1:-}"
DRY=0; [ "${2:-}" = "--dry-run" ] && DRY=1
case "$RID" in
  rad:z*) ;;
  z*) RID="rad:$RID" ;;
  *) echo "usage: $0 rad:z<effects RID> [--dry-run]" >&2; exit 2 ;;
esac
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
OCI_HOST="${OCI_HOST:-ubuntu@92.5.138.121}"
WAIT_SECS="${WAIT_SECS:-120}"
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

if [ "$DRY" = 1 ]; then
  echo "[dry-run] would ssh ${OCI_HOST}: rad seed $RID --scope all; wait ≤${WAIT_SECS}s for storage/${RID#rad:}; pin in web.pinned.repositories; restart radicle-httpd"
  exit 0
fi

ssh "${SSH_OPTS[@]}" "$OCI_HOST" "RID='$RID' WAIT_SECS='$WAIT_SECS' bash -s" <<'REMOTE'
set -euo pipefail
BARE="${RID#rad:}"
STORE="/home/radicle/.radicle/storage/$BARE"
CFG=/home/radicle/.radicle/config.json

# 1. seeding policy for this RID: scope all (player namespaces included)
sudo -u radicle -H env RID="$RID" bash -c 'export PATH="$HOME/.radicle/bin:$PATH"; rad seed "$RID" --scope all --no-fetch 2>&1 || rad seed "$RID" --scope all 2>&1' | sed 's/^/  seed: /'

# 2. wait for replication (the dev PC announces after `rad init`; OCI fetches over that session)
for i in $(seq 1 "$WAIT_SECS"); do
  [ -d "$STORE" ] && break
  [ "$i" = 1 ] && echo "  waiting for $STORE (run 'rad sync $RID --announce' on the dev PC) …"
  sleep 1
done
if [ ! -d "$STORE" ]; then
  echo "!! $RID not in OCI storage yet — not pinning. Re-run this script after the dev PC's 'rad sync --announce'" >&2
  echo "   (or rsync it: RID_DIR=$BARE bash game/tools/oci/push-to-oci.sh --rsync-only)" >&2
  exit 3
fi
sudo chown -R radicle:radicle "$STORE"

# 3. pin (same jq edit as profiles-setup.sh / push-to-oci.sh phase 4)
if ! sudo -u radicle jq -e --arg r "$RID" '.web.pinned.repositories // [] | index($r)' "$CFG" >/dev/null 2>&1; then
  echo "  pinning $RID"
  sudo -u radicle cp "$CFG" "$CFG.bak-effects"
  sudo -u radicle env RID="$RID" CFG="$CFG" bash -c 'jq --arg r "$RID" ".web = (.web // {}) | .web.pinned = (.web.pinned // {}) | .web.pinned.repositories = ((.web.pinned.repositories // []) + [\$r] | unique)" "$CFG" > "$CFG.new" && mv "$CFG.new" "$CFG"'
fi
sudo systemctl restart radicle-httpd
sleep 2
echo "  pinned: $(sudo -u radicle jq -c '.web.pinned.repositories' "$CFG")  httpd: $(systemctl is-active radicle-httpd)"
echo "  heads:  $(curl -s -m 5 "http://127.0.0.1:8080/api/v1/repos/$RID/remotes" | head -c 400)"
echo "  index:  $(curl -s -m 5 "http://127.0.0.1:8080/api/v1/repos/$RID" | head -c 300)"
REMOTE
