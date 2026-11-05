#!/usr/bin/env bash
# Report how many refs OCI is behind dev-PC, then try to close the gap via
# Radicle p2p (announce) — no rsync. Fast, uses only the running rad-node.
#
# Flags:
#   --dry-run      only report the diff, don't sync
#   --timeout T    announce timeout (default 300sec)
#
# Env overrides: OCI_HOST, OCI_SEED_NID, RID_DIR, RAD_HOME
set -euo pipefail

OCI_HOST="${OCI_HOST:-92-5-138-121.sslip.io}"
OCI_SEED_NID="${OCI_SEED_NID:-z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT}"
RID_DIR="${RID_DIR:-zqZmP6itceBMqYwi1K1n8phQqCaj}"
RID="rad:$RID_DIR"
RAD_HOME="${RAD_HOME:-$HOME/.radicle}"
TIMEOUT="300sec"
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY=1; shift ;;
    --timeout)  TIMEOUT="$2"; shift 2 ;;
    -h|--help)  sed -n '1,15p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

SRC="$RAD_HOME/storage/$RID_DIR"

# ---- collect dev-PC refs (nid sha name) ---------------------------------
local_refs() {
  if [ -f "$SRC/packed-refs" ]; then
    grep -oE "^[0-9a-f]{40} refs/namespaces/[^/]+/refs/heads/[^ ]+" "$SRC/packed-refs" \
      | awk '{
          split($2,a,"/");
          nid=a[3];
          sub(/^refs\/namespaces\/[^\/]+\/refs\/heads\//,"",$2);
          print nid" "$1" heads/"$2
        }'
  fi
  if [ -d "$SRC/refs/namespaces" ]; then
    find "$SRC/refs/namespaces" -type f -path '*/refs/heads/*' 2>/dev/null | while read f; do
      nid=$(echo "$f" | sed -E 's|.*/namespaces/([^/]+)/refs/heads/.*|\1|')
      br=$(echo "$f" | sed -E 's|.*/refs/heads/||')
      sha=$(cat "$f" 2>/dev/null)
      [ -n "$sha" ] && echo "$nid $sha heads/$br"
    done
  fi
}

# ---- collect OCI refs (nid sha name) via public API ---------------------
oci_refs() {
  curl -sS -m 10 "https://$OCI_HOST/api/v1/repos/$RID/remotes" 2>/dev/null \
    | python3 -c '
import json,sys
try:  d=json.load(sys.stdin)
except: sys.exit(0)
if not isinstance(d,list): sys.exit(0)
for r in d:
    nid = r.get("id","")
    heads = r.get("heads") or {}
    for name,sha in heads.items():
        print(nid+" "+sha+" heads/"+name)
'
}

echo "================================================================"
echo " OCI p2p catchup check"
echo "================================================================"
echo "OCI    : $OCI_HOST ($OCI_SEED_NID)"
echo "RID    : $RID"
echo "local  : $SRC"
echo

LOCAL=$(local_refs | sort -u)
OCI=$(oci_refs | sort -u)
LOCAL_N=$(printf '%s\n' "$LOCAL" | grep -c . || true)
OCI_N=$(printf '%s\n' "$OCI" | grep -c . || true)
BEHIND=$(comm -23 <(printf '%s\n' "$LOCAL") <(printf '%s\n' "$OCI") 2>/dev/null)
AHEAD=$(comm -13  <(printf '%s\n' "$LOCAL") <(printf '%s\n' "$OCI") 2>/dev/null)
BEHIND_N=$(printf '%s\n' "$BEHIND" | grep -c . || true)
AHEAD_N=$(printf '%s\n' "$AHEAD" | grep -c . || true)

printf '  dev-PC refs : %s\n' "$LOCAL_N"
printf '  OCI refs    : %s\n' "$OCI_N"
printf '  OCI behind  : %s refs (on dev-PC, not on OCI)\n' "$BEHIND_N"
printf '  OCI ahead   : %s refs (on OCI, not on dev-PC)\n' "$AHEAD_N"
echo

if [ "${BEHIND_N:-0}" -gt 0 ]; then
  echo "=== top of the behind-list"
  printf '%s\n' "$BEHIND" | head -10 | awk '{printf "  %s... %s %s\n",substr($1,1,14),substr($2,1,8),$3}'
  [ "${BEHIND_N:-0}" -gt 10 ] && echo "  ... (+$((BEHIND_N - 10)) more)"
  echo
fi

if [ "${BEHIND_N:-0}" = 0 ]; then
  echo "✓ OCI is caught up — nothing to do."
  exit 0
fi

if [ "$DRY" = 1 ]; then
  echo "(--dry-run: not syncing)"
  exit 0
fi

# ---- sync via radicle p2p -----------------------------------------------
echo "=== syncing via radicle p2p"

if ! command -v rad >/dev/null 2>&1; then
  for d in "$HOME"/.radicle/bin "$HOME"/.nvm/versions/node/v2*/bin; do
    [ -d "$d" ] && export PATH="$d:$PATH"
  done
fi

if ! rad node status >/dev/null 2>&1; then
  echo "  ! rad-node not running on dev-PC"
  echo "    start it with:  rad node start"
  echo "    or:             node game/start-all.mjs"
  echo "  then re-run this script."
  exit 3
fi

echo "  -> connect to OCI (idempotent)"
rad node connect "$OCI_SEED_NID@$OCI_HOST:8776" 2>&1 | sed 's/^/     /' || true

echo "  -> rad sync --announce --timeout $TIMEOUT"
rad sync "$RID" --seed "$OCI_SEED_NID" --announce --timeout "$TIMEOUT" --verbose 2>&1 \
  | sed 's/^/     /' \
  || echo "     (sync returned non-zero; see output above)"

# ---- re-check and report delta ------------------------------------------
echo
echo "=== after"
sleep 3
OCI_AFTER=$(oci_refs | sort -u)
OCI_AFTER_N=$(printf '%s\n' "$OCI_AFTER" | grep -c . || true)
BEHIND_AFTER=$(comm -23 <(printf '%s\n' "$LOCAL") <(printf '%s\n' "$OCI_AFTER") 2>/dev/null)
BEHIND_AFTER_N=$(printf '%s\n' "$BEHIND_AFTER" | grep -c . || true)
NEW_ON_OCI=$(comm -13 <(printf '%s\n' "$OCI") <(printf '%s\n' "$OCI_AFTER") 2>/dev/null)
NEW_N=$(printf '%s\n' "$NEW_ON_OCI" | grep -c . || true)

printf '  OCI refs now  : %s  (+%s)\n' "$OCI_AFTER_N" "${NEW_N:-0}"
printf '  OCI still behind : %s refs\n' "$BEHIND_AFTER_N"

if [ "${NEW_N:-0}" -gt 0 ] && [ "${NEW_N:-0}" -le 20 ]; then
  echo
  echo "=== refs that landed"
  printf '%s\n' "$NEW_ON_OCI" | awk '{printf "  + %s... %s %s\n",substr($1,1,14),substr($2,1,8),$3}'
fi

if [ "${BEHIND_AFTER_N:-0}" -gt 0 ]; then
  echo
  echo "⚠ p2p didn't close the gap — $BEHIND_AFTER_N ref(s) still missing on OCI."
  echo
  echo "  Likely causes:"
  echo "   (a) OCI has dangling refs that break pack delta resolution"
  echo "       (gix 'Failed to consume the pack sent by the remote' in OCI's journal)."
  echo "       Repair:  bash game/tools/out/_oci_repair_broken_refs.sh | ssh ubuntu@$OCI_HOST bash"
  echo "   (b) The pack is too big to fit OCI's peer-timeout window."
  echo "       Fallback: bash game/tools/oci/push-to-oci.sh --rsync-only"
fi
