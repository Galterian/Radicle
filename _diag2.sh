#!/bin/bash
for d in /home/galt/repo_radicle_clone2/chaosD6/game /home/galt/repo_radicle/chaosD6/game /home/galt/repo_radicle_b/game; do
  [ -f "$d/js/main.js" ] || continue
  echo "$d"
  echo "   main.js Attack-step=$(grep -c 'Attack-step' "$d/js/main.js")  mtime=$(stat -c %y "$d/js/main.js" | cut -c1-19)"
  echo "   peer.mjs lastAttackTarget=$(grep -c 'lastAttackTarget' "$d/peer.mjs")  mtime=$(stat -c %y "$d/peer.mjs" | cut -c1-19)"
done
echo "--- who serves which UI port ---"
ss -tlnp 2>/dev/null | grep -E ':73[5-6][0-9] ' | while read -r line; do
  port=$(echo "$line" | awk '{print $4}')
  pid=$(echo "$line" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  echo "$port  pid=$pid  cwd=$(readlink /proc/$pid/cwd 2>/dev/null)  started=$(stat -c %y /proc/$pid 2>/dev/null | cut -c12-19)"
done
