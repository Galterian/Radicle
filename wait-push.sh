#!/bin/bash
# Wait up to ~5 min for an actual Radicle push whose log line matches the
# `radicle push → <sha>` format emitted by peer.mjs on success.
LOG=/home/galt/repo_radicle/chaosD6/game/host.log
for i in $(seq 1 60); do
  if grep -qE "radicle push → [0-9a-f]{7,}" "$LOG" 2>/dev/null; then
    echo "push observed at tick $i"
    grep -E "radicle push → |commit: |tree: " "$LOG" | tail -6
    exit 0
  fi
  LASTL=$(grep -E "lottery #" "$LOG" 2>/dev/null | tail -1)
  echo "tick $i: ${LASTL:-no lottery yet}"
  sleep 5
done
echo "---TIMED OUT---"
grep -nE "lottery|radicle push|commit: |tree: " "$LOG" | tail -30
exit 1
