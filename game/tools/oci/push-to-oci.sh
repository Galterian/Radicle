#!/usr/bin/env bash
# Push the chaosD6 Radicle repo to the OCI seed. Two mechanisms, both idempotent:
#   1. p2p sync   — connect dev-PC rad-node to OCI, --announce so OCI fetches
#   2. rsync      — direct storage copy over SSH (guaranteed; bypasses p2p timeouts)
#
# Default behaviour runs (1) then (2). Flags:
#   --p2p-only          only run step 1 (fast; use if OCI already has most of the repo)
#   --rsync-only        only run step 2 (reliable; use after big local changes)
#   --timeout 900sec    override --announce timeout for step 1 (default 900sec)
#
# Env overrides (all optional):
#   OCI_HOST=92-5-138-121.sslip.io
#   OCI_SEED_NID=z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT
#   RID_DIR=zqZmP6itceBMqYwi1K1n8phQqCaj          (name under ~/.radicle/storage/)
#   RAD_HOME=~/.radicle
#   SSH_KEY=~/.ssh/id_rsa
#
# Usage from anywhere:
#   bash /home/galt/repo_radicle_clone2/chaosD6/game/tools/oci/push-to-oci.sh
#   bash .../push-to-oci.sh --rsync-only
set -euo pipefail

OCI_HOST="${OCI_HOST:-92-5-138-121.sslip.io}"
OCI_SEED_NID="${OCI_SEED_NID:-z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT}"
RID_DIR="${RID_DIR:-zqZmP6itceBMqYwi1K1n8phQqCaj}"
RID="rad:$RID_DIR"
RAD_HOME="${RAD_HOME:-$HOME/.radicle}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
TIMEOUT="900sec"
DO_P2P=1
DO_RSYNC=1

while [ $# -gt 0 ]; do
  case "$1" in
    --p2p-only)   DO_RSYNC=0; shift ;;
    --rsync-only) DO_P2P=0;   shift ;;
    --timeout)    TIMEOUT="$2"; shift 2 ;;
    -h|--help)    sed -n '1,25p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

SSH="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
SRC="$RAD_HOME/storage/$RID_DIR/"

echo "OCI host     : $OCI_HOST"
echo "OCI NID      : ${OCI_SEED_NID:0:16}..."
echo "RID          : $RID"
echo "local source : $SRC"
echo

# ============================================================================
# STEP 1 — p2p: connect + announce
# ============================================================================
if [ "$DO_P2P" = 1 ]; then
  echo "=== [1/2] p2p sync via rad node"

  # Make sure rad-node is up. If not, user runs its launcher separately.
  if ! rad node status >/dev/null 2>&1; then
    echo "  ! rad-node is not running. Start it (e.g. 'rad node start' or"
    echo "    'node game/start-all.mjs' from the project) and re-run with --p2p-only"
    echo "    if you want to retry p2p."
  else
    # Connect (idempotent — rad silently no-ops if already connected)
    echo "  -> rad node connect ${OCI_SEED_NID:0:12}...@$OCI_HOST:8776"
    rad node connect "$OCI_SEED_NID@$OCI_HOST:8776" 2>&1 \
      | sed 's/^/     /' || true

    echo
    echo "  -> session state"
    rad node status 2>/dev/null \
      | grep -E "$OCI_SEED_NID|$OCI_HOST|minute|second|established" \
      | sed 's/^/     /' \
      || echo "     (no session row matched — rad will retry during --announce)"

    echo
    echo "  -> rad sync --announce (timeout $TIMEOUT)"
    rad sync "$RID" \
      --seed "$OCI_SEED_NID" \
      --announce --timeout "$TIMEOUT" --verbose 2>&1 \
      | sed 's/^/     /' \
      || echo "     (sync returned non-zero — p2p may have timed out, rsync below is the backup)"
  fi
  echo
fi

# ============================================================================
# STEP 2 — rsync storage directly over SSH
# ============================================================================
if [ "$DO_RSYNC" = 1 ]; then
  echo "=== [2/2] rsync storage -> OCI"

  if [ ! -d "$SRC" ]; then
    echo "  ! source dir does not exist: $SRC" >&2
    exit 1
  fi

  echo "  -> stopping OCI radicle services + clearing partial .tmp"
  $SSH "ubuntu@$OCI_HOST" bash <<EOF
sudo systemctl stop radicle-node radicle-httpd
sudo rm -rf /home/radicle/.radicle/storage/$RID_DIR.tmp
EOF

  echo "  -> rsync (size: $(du -sh "$SRC" 2>/dev/null | cut -f1))"
  # Rsync exit codes 23 (partial xfer, perms) and 24 (vanished source files during
  # transfer — happens when rad-node repacks mid-rsync) are warnings, not fatal:
  # a subsequent run with --delete will reconcile.
  set +e
  # -P keeps per-file progress; --info=progress2 adds a single whole-transfer
  # progress line (overall %, overall speed, ETA) so you can watch 1.1 GB
  # tick down without parsing one line per file.
  rsync -az --partial --info=progress2 --delete \
    --exclude '_broken-refs-backup-*' \
    --rsync-path='sudo rsync' \
    -e "$SSH" \
    "$SRC" \
    "ubuntu@$OCI_HOST:/home/radicle/.radicle/storage/$RID_DIR/"
  rc=$?
  set -e
  case "$rc" in
    0)      echo "  rsync: clean" ;;
    23|24)  echo "  rsync: partial (code $rc) — some files vanished mid-transfer; a re-run will reconcile" ;;
    *)      echo "  rsync FAILED (code $rc)" >&2; exit "$rc" ;;
  esac

  echo
  echo "  -> fixing ownership + restarting services on OCI"
  $SSH "ubuntu@$OCI_HOST" bash <<EOF
sudo chown -R radicle:radicle /home/radicle/.radicle/storage/$RID_DIR
sudo systemctl start radicle-node radicle-httpd
sleep 4
echo
echo "  --- /repos NOW"
curl -sS http://localhost:8080/api/v1/repos \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print("    count:",len(d));print("    rid:",d[0].get("rid","?")) if d else None'
echo
echo "  --- public probe via caddy"
curl -sS -m 5 "https://$OCI_HOST/api/v1/repos" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print("    count:",len(d))' \
  || echo "    (public probe failed — caddy may still be warming)"
EOF
fi

echo
echo "done."
