#!/usr/bin/env bash
# Push the chaosD6 Radicle repo to the OCI seed, with full diagnosis + diff
# reporting. Four phases:
#   1. preflight       — print BEFORE state (both sides, which refs OCI is missing)
#   2. p2p sync        — connect + --announce (fast; may time out on big batches)
#   3. rsync           — direct storage copy over SSH (reliable; delta-only after 1st run)
#   4. ensure alive    — restart services if dead, ensure repo is pinned so /repos lists it
#   5. report          — print AFTER state + a list of refs/branches newly on OCI
#
# Flags:
#   --p2p-only            only phases 1 → 2 → 4 → 5 (skip rsync)
#   --rsync-only          only phases 1 → 3 → 4 → 5 (skip p2p)
#   --timeout 900sec      override --announce timeout for phase 2 (default 900sec)
#   --quiet               skip the AFTER phase; just push
#
# Env overrides (all optional):
#   OCI_HOST=92-5-138-121.sslip.io
#   OCI_SEED_NID=z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT
#   RID_DIR=zqZmP6itceBMqYwi1K1n8phQqCaj
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
QUIET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --p2p-only)   DO_RSYNC=0; shift ;;
    --rsync-only) DO_P2P=0;   shift ;;
    --timeout)    TIMEOUT="$2"; shift 2 ;;
    --quiet)      QUIET=1; shift ;;
    -h|--help)    sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

SSH="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
SRC="$RAD_HOME/storage/$RID_DIR/"

# ---------------------------------------------------------------------------
# OCI probe helpers — call via a single multi-line SSH command for speed
# ---------------------------------------------------------------------------

oci_state() {
  # Prints key-value lines: services, size, repos_count, pinned, remotes_json
  $SSH "ubuntu@$OCI_HOST" bash <<EOF 2>&1
set +e
echo "node=\$(systemctl is-active radicle-node 2>&1)"
echo "httpd=\$(systemctl is-active radicle-httpd 2>&1)"
sz=\$(sudo du -sh /home/radicle/.radicle/storage/$RID_DIR 2>/dev/null | cut -f1)
echo "size=\${sz:-missing}"
pc=\$(sudo ls /home/radicle/.radicle/storage/$RID_DIR/objects/pack/ 2>/dev/null | grep -c '\.pack$')
echo "packs=\${pc:-0}"
rc=\$(curl -sS -m 5 http://localhost:8080/api/v1/repos 2>/dev/null | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else 0)' 2>/dev/null)
echo "repos_count=\${rc:-?}"
pinned=\$(sudo -u radicle jq -r '.web.pinned.repositories // [] | contains(["$RID"])' /home/radicle/.radicle/config.json 2>/dev/null)
echo "pinned=\${pinned:-false}"
echo "---REMOTES---"
curl -sS -m 5 http://localhost:8080/api/v1/repos/$RID/remotes 2>/dev/null \
  | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  if not isinstance(d,list): sys.exit(0)
  for r in d:
    h=r.get("heads") or {}
    for name,sha in h.items():
      print(r["id"]+" "+name+" "+sha)
except Exception as e: pass'
EOF
}

devpc_state() {
  # Prints the same key-value shape for comparison
  echo "node=$(rad node status >/dev/null 2>&1 && echo active || echo inactive)"
  echo "size=$(du -sh "$SRC" 2>/dev/null | cut -f1)"
  echo "packs=$(ls "$SRC/objects/pack/" 2>/dev/null | grep -c '\.pack$')"
  echo "---LOCAL-REFS---"
  # List every ref: namespace sha name
  if [ -f "$SRC/packed-refs" ]; then
    grep -oE "^[0-9a-f]{40} refs/namespaces/[^/]+/refs/heads/[^ ]+" "$SRC/packed-refs" | \
      awk '{split($2,a,"/"); print a[3]" "$1" "a[5]"/"a[6]"/"a[7]"/"a[8]"/"a[9]}' | sed 's/[ /]*$//'
  fi
  # Also include loose refs
  if [ -d "$SRC/refs/namespaces" ]; then
    find "$SRC/refs/namespaces" -type f -path '*/refs/heads/*' 2>/dev/null | while read f; do
      nid=$(echo "$f" | sed -E 's|.*/namespaces/([^/]+)/refs/heads/.*|\1|')
      br=$(echo "$f" | sed -E 's|.*/refs/heads/||')
      sha=$(cat "$f" 2>/dev/null)
      [ -n "$sha" ] && echo "$nid $sha $br"
    done
  fi
}

# ---------------------------------------------------------------------------
# PHASE 1 — preflight
# ---------------------------------------------------------------------------
echo "================================================================"
echo " chaosD6 → OCI push"
echo "================================================================"
echo "OCI host     : $OCI_HOST"
echo "OCI NID      : ${OCI_SEED_NID:0:16}..."
echo "RID          : $RID"
echo "local source : $SRC"
echo

echo "=== BEFORE ==="
DEV_BEFORE=$(devpc_state)
OCI_BEFORE=$(oci_state)
printf '  dev-PC : size=%s packs=%s node=%s\n' \
  "$(printf '%s\n' "$DEV_BEFORE" | awk -F= '/^size=/{print $2}')" \
  "$(printf '%s\n' "$DEV_BEFORE" | awk -F= '/^packs=/{print $2}')" \
  "$(printf '%s\n' "$DEV_BEFORE" | awk -F= '/^node=/{print $2}')"
printf '  OCI    : size=%s packs=%s node=%s httpd=%s repos=%s pinned=%s\n' \
  "$(printf '%s\n' "$OCI_BEFORE" | awk -F= '/^size=/{print $2}')" \
  "$(printf '%s\n' "$OCI_BEFORE" | awk -F= '/^packs=/{print $2}')" \
  "$(printf '%s\n' "$OCI_BEFORE" | awk -F= '/^node=/{print $2}')" \
  "$(printf '%s\n' "$OCI_BEFORE" | awk -F= '/^httpd=/{print $2}')" \
  "$(printf '%s\n' "$OCI_BEFORE" | awk -F= '/^repos_count=/{print $2}')" \
  "$(printf '%s\n' "$OCI_BEFORE" | awk -F= '/^pinned=/{print $2}')"

# Compute diff: refs on dev-PC not on OCI (by sha+name)
LOCAL_REFS=$(printf '%s\n' "$DEV_BEFORE" | sed -n '/---LOCAL-REFS---/,$p' | tail -n +2 | sort -u)
OCI_REFS=$(printf '%s\n' "$OCI_BEFORE" | sed -n '/---REMOTES---/,$p' | tail -n +2 | sort -u)
MISSING=$(comm -23 <(printf '%s\n' "$LOCAL_REFS") <(printf '%s\n' "$OCI_REFS") 2>/dev/null)
MISSING_N=$(printf '%s\n' "$MISSING" | grep -c . || true)
printf '  diff   : %s ref(s) on dev-PC not yet on OCI\n' "${MISSING_N:-0}"
if [ "${MISSING_N:-0}" -gt 0 ] && [ "${MISSING_N:-0}" -le 20 ]; then
  printf '%s\n' "$MISSING" | sed 's/^/           /'
elif [ "${MISSING_N:-0}" -gt 20 ]; then
  printf '%s\n' "$MISSING" | head -20 | sed 's/^/           /'
  echo "           ... (+$((MISSING_N - 20)) more)"
fi
echo

# ---------------------------------------------------------------------------
# PHASE 2 — p2p sync
# ---------------------------------------------------------------------------
if [ "$DO_P2P" = 1 ]; then
  echo "=== PHASE 2: p2p sync via rad node ==="
  if ! rad node status >/dev/null 2>&1; then
    echo "  ! rad-node not running on dev-PC; skipping p2p phase"
    echo "    (start it: 'rad node start' or 'node game/start-all.mjs', then re-run --p2p-only)"
  else
    rad node connect "$OCI_SEED_NID@$OCI_HOST:8776" 2>&1 | sed 's/^/  /'
    rad sync "$RID" --seed "$OCI_SEED_NID" --announce --timeout "$TIMEOUT" --verbose 2>&1 \
      | sed 's/^/  /' \
      || echo "  (sync returned non-zero — rsync below is the backup)"
  fi
  echo
fi

# ---------------------------------------------------------------------------
# PHASE 3 — rsync
# ---------------------------------------------------------------------------
if [ "$DO_RSYNC" = 1 ]; then
  echo "=== PHASE 3: rsync storage → OCI ==="
  if [ ! -d "$SRC" ]; then
    echo "  ! source dir does not exist: $SRC" >&2
    exit 1
  fi
  echo "  stopping OCI radicle services + clearing partial .tmp"
  $SSH "ubuntu@$OCI_HOST" bash <<EOF
sudo systemctl stop radicle-node radicle-httpd
sudo rm -rf /home/radicle/.radicle/storage/$RID_DIR.tmp
EOF

  echo "  rsync (--info=progress2 for a single overall-progress line)"
  # Rsync exit codes 23/24 are warnings (vanished mid-transfer, e.g. rad-node repack).
  set +e
  rsync -az --partial --info=progress2 --delete \
    --exclude '_broken-refs-backup-*' \
    --rsync-path='sudo rsync' \
    -e "$SSH" \
    "$SRC" \
    "ubuntu@$OCI_HOST:/home/radicle/.radicle/storage/$RID_DIR/"
  rc=$?
  set -e
  case "$rc" in
    0)     echo "  rsync: clean" ;;
    23|24) echo "  rsync: partial (code $rc) — some files vanished mid-transfer; a re-run reconciles" ;;
    *)     echo "  rsync FAILED (code $rc)" >&2; exit "$rc" ;;
  esac
  echo
fi

# ---------------------------------------------------------------------------
# PHASE 4 — ensure alive, services up, repo pinned
# ---------------------------------------------------------------------------
echo "=== PHASE 4: ensure OCI is alive and listing the repo ==="
$SSH "ubuntu@$OCI_HOST" bash <<EOF 2>&1 | sed 's/^/  /'
set -e
# fix ownership — rsync via sudo wrote files as root, radicle-node needs them as radicle
sudo chown -R radicle:radicle /home/radicle/.radicle/storage/$RID_DIR

# ensure repo is in web.pinned.repositories so /api/v1/repos (default show=pinned) lists it
if ! sudo -u radicle jq -e '.web.pinned.repositories // [] | contains(["$RID"])' \
     /home/radicle/.radicle/config.json >/dev/null 2>&1; then
  echo "pinning $RID"
  sudo -u radicle bash -c "cd \\\$HOME/.radicle && jq --arg r '$RID' '
      .web = (.web // {}) |
      .web.pinned = (.web.pinned // {}) |
      .web.pinned.repositories = ((.web.pinned.repositories // []) + [\\\$r] | unique)
    ' config.json > config.new && mv config.new config.json"
fi

# (re)start services; they may already be running after phase 2 only
sudo systemctl start radicle-node radicle-httpd
sleep 2
# force httpd re-scan storage after rsync
sudo systemctl restart radicle-httpd
sleep 2

echo "services: node=\$(systemctl is-active radicle-node) httpd=\$(systemctl is-active radicle-httpd)"
EOF
echo

# ---------------------------------------------------------------------------
# PHASE 5 — report
# ---------------------------------------------------------------------------
if [ "$QUIET" = 1 ]; then
  echo "done. (--quiet: skipping report)"
  exit 0
fi

echo "=== AFTER ==="
OCI_AFTER=$(oci_state)
printf '  OCI    : size=%s packs=%s node=%s httpd=%s repos=%s pinned=%s\n' \
  "$(printf '%s\n' "$OCI_AFTER" | awk -F= '/^size=/{print $2}')" \
  "$(printf '%s\n' "$OCI_AFTER" | awk -F= '/^packs=/{print $2}')" \
  "$(printf '%s\n' "$OCI_AFTER" | awk -F= '/^node=/{print $2}')" \
  "$(printf '%s\n' "$OCI_AFTER" | awk -F= '/^httpd=/{print $2}')" \
  "$(printf '%s\n' "$OCI_AFTER" | awk -F= '/^repos_count=/{print $2}')" \
  "$(printf '%s\n' "$OCI_AFTER" | awk -F= '/^pinned=/{print $2}')"

# Compute delta: refs newly on OCI since BEFORE
OCI_REFS_AFTER=$(printf '%s\n' "$OCI_AFTER" | sed -n '/---REMOTES---/,$p' | tail -n +2 | sort -u)
NEW_ON_OCI=$(comm -13 <(printf '%s\n' "$OCI_REFS") <(printf '%s\n' "$OCI_REFS_AFTER") 2>/dev/null)
NEW_N=$(printf '%s\n' "$NEW_ON_OCI" | grep -c . || true)
STILL_MISSING=$(comm -23 <(printf '%s\n' "$LOCAL_REFS") <(printf '%s\n' "$OCI_REFS_AFTER") 2>/dev/null)
STILL_MISSING_N=$(printf '%s\n' "$STILL_MISSING" | grep -c . || true)

echo
echo "=== CHANGES ==="
printf '  %s ref(s) newly on OCI\n' "${NEW_N:-0}"
if [ "${NEW_N:-0}" -gt 0 ]; then
  printf '%s\n' "$NEW_ON_OCI" | head -30 | sed 's/^/    + /'
  [ "${NEW_N:-0}" -gt 30 ] && echo "    ... (+$((NEW_N - 30)) more)"
fi
printf '  %s ref(s) still on dev-PC not on OCI\n' "${STILL_MISSING_N:-0}"
if [ "${STILL_MISSING_N:-0}" -gt 0 ] && [ "${STILL_MISSING_N:-0}" -le 10 ]; then
  printf '%s\n' "$STILL_MISSING" | sed 's/^/    ! /'
fi

echo
echo "public URL: https://$OCI_HOST/api/v1/repos"
echo "phone UI  : https://dimensions-4e9ae.web.app/radicle/"
echo "done."
