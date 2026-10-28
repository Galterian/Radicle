#!/usr/bin/env bash
# Render the overview screenshot + biome stats for several dimensions.
# Usage: _tools/run_overviews.sh <prefix> [dim ...]
set -u
cd "$(dirname "$0")/.." || exit 1
export DISPLAY="${DISPLAY:-:0}"
PREFIX="${1:-rich}"; shift || true
DIMS=("$@")
if [ ${#DIMS[@]} -eq 0 ]; then DIMS=(Ashfall-Micro frostpeak deepwilds obsidian); fi
for d in "${DIMS[@]}"; do
  echo "== $d"
  timeout 300 _tools/godot --path godot --resolution 1600x1000 -s tools/overview.gd ++ "$d" 70 "$PWD/_tools/${PREFIX}_$d.png" 2>&1 \
    | grep -E "overview dim|biomes:|water:|features:|hexes:|wrote|SCRIPT ERROR|Parse Error|FAIL" | grep -v "ERR_CANT_OPEN"
done
