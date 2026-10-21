#!/bin/bash
echo "--- node game procs (pid | cwd | cmd) ---"
for p in $(pgrep -f 'node .*\.mjs'); do
  echo "$p | $(readlink /proc/$p/cwd 2>/dev/null) | $(tr '\0' ' ' </proc/$p/cmdline | cut -c1-100)"
done
echo
echo "--- listening game ports ---"
ss -tlnp 2>/dev/null | grep -E ':73[0-9][0-9] |:74[0-9][0-9] ' | awk '{print $4, $6}'
echo
echo "--- does each UI port serve the NEW main.js? ---"
for port in 7357 7358 7359 7360 7361 7362; do
  body=$(curl -s --max-time 2 "http://127.0.0.1:$port/js/main.js")
  [ -z "$body" ] && continue
  n=$(printf '%s' "$body" | grep -c 'double-click to commit')
  echo "port $port -> new-code markers: $n"
done
echo
echo "--- on-disk copies of main.js ---"
for f in $(find /home/galt -path '*/node_modules' -prune -o -name main.js -path '*chaosD6/game/js/*' -print 2>/dev/null); do
  echo "$f -> markers: $(grep -c 'double-click to commit' "$f")  mtime: $(stat -c %y "$f" | cut -c1-19)"
done
