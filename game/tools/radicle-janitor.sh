#!/usr/bin/env bash
# Runtime janitor for a Radicle storage dir. Runs alongside rad-node (no stop
# required). Every INTERVAL seconds:
#   1. git repack -ad --window=30 --depth=30  → consolidate reachable, drop
#      redundant packs. Safe with concurrent reads.
#   2. git prune --expire=15.minutes          → delete orphan loose objects
#      older than 15 min (allowing in-flight fetches time to finish).
#   3. git fsck --no-dangling                 → if non-ref errors appear, warn
#      so you know the pollution is winning the race.
#
# Env:
#   RID_DIR     the repo id directory under ~/.radicle/storage/
#   INTERVAL    seconds between passes (default 600 = 10 min)
#   RAD_HOME    override Radicle home
#
# Usage:
#   bash game/tools/radicle-janitor.sh                     # foreground, Ctrl-C to stop
#   nohup bash game/tools/radicle-janitor.sh >/tmp/janitor.log 2>&1 &
set -u
RID_DIR="${RID_DIR:-zqZmP6itceBMqYwi1K1n8phQqCaj}"
RAD_HOME="${RAD_HOME:-$HOME/.radicle}"
INTERVAL="${INTERVAL:-600}"
SRC="$RAD_HOME/storage/$RID_DIR"

if [ ! -d "$SRC" ]; then
  echo "janitor: storage dir not found: $SRC" >&2
  exit 1
fi

echo "radicle-janitor"
echo "  storage : $SRC"
echo "  interval: ${INTERVAL}s"
echo "  pid     : $$"

while true; do
  START=$(date -u +%H:%M:%S)
  BEFORE_SZ=$(du -sh "$SRC" | cut -f1)
  BEFORE_PACKS=$(ls "$SRC/objects/pack/" 2>/dev/null | grep -c "\.pack$")

  # 1. repack
  REPACK_OUT=$(git -C "$SRC" repack -ad --window=30 --depth=30 --window-memory=128m 2>&1 || true)

  # 2. prune
  PRUNE_OUT=$(git -C "$SRC" prune --expire=15.minutes 2>&1 || true)

  # 3. fsck (non-dangling errors only — a dangling is fine, missing/invalid is not)
  FSCK_OUT=$(git -C "$SRC" fsck --no-dangling 2>&1 || true)
  if [ -n "$FSCK_OUT" ]; then
    FSCK_SUMMARY="WARN: $(printf "%s\n" "$FSCK_OUT" | wc -l) issue(s)"
  else
    FSCK_SUMMARY="clean"
  fi

  AFTER_SZ=$(du -sh "$SRC" | cut -f1)
  AFTER_PACKS=$(ls "$SRC/objects/pack/" 2>/dev/null | grep -c "\.pack$")
  END=$(date -u +%H:%M:%S)

  printf "%s janitor: %s/%s→%s/%s packs/size   fsck:%s\n" \
    "$START" "$BEFORE_PACKS" "$BEFORE_SZ" "$AFTER_PACKS" "$AFTER_SZ" "$FSCK_SUMMARY"

  if [ "$FSCK_SUMMARY" != "clean" ]; then
    printf "%s\n" "$FSCK_OUT" | head -5 | sed "s/^/           /"
  fi

  sleep "$INTERVAL"
done
