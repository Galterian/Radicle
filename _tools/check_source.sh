#!/usr/bin/env bash
set -eu
echo "=== all node processes serving game ports ==="
for port in 7357 7358 7359; do
  line=$(ss -tlnp 2>/dev/null | awk -v p=":${port}" '$0 ~ p {print}' | head -1)
  if [ -z "$line" ]; then echo "port $port: not bound"; continue; fi
  pid=$(echo "$line" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  cmd=$(tr '\0' ' ' < /proc/$pid/cmdline)
  cwd=$(readlink /proc/$pid/cwd 2>/dev/null || echo '?')
  echo "port $port -> pid $pid"
  echo "  cmd: $cmd"
  echo "  cwd: $cwd"
done
echo
echo "=== verify browser gets branch content from :7358 ==="
echo -n "features/feature_table.json first entry: "
curl -sS http://127.0.0.1:7358/assets/features/feature_table.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["by_biome"]["grass"][0]["id"])'
echo -n "terrain_tiles.json chaos_terrain count: "
curl -sS http://127.0.0.1:7358/assets/terrain/terrain_tiles.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["chaos_terrain"]))'
echo -n "sprites.js has labyrinth walls marker: "
curl -sS http://127.0.0.1:7358/js/features.js | grep -c LAB_SEED_RATE || true
echo
echo "=== branch feature_table_json first grass id (ground truth) ==="
python3 -c 'import json; d=json.load(open("/home/galt/chaosd6_mapper/chaosD6/assets/features/feature_table.json")); print(d["by_biome"]["grass"][0]["id"])'
