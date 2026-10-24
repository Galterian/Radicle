#!/usr/bin/env bash
# Dev helper: show what every peer of a dimension holds of the map (log lines
# from the current session + /status), so a reveal can be traced hop by hop.
# usage: tools/map-check.sh [dimension-slug] [first-http-port] [count]
cd "$(dirname "$0")/.."
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH
SLUG="${1:-ashfall-micro}"; PORT="${2:-7401}"; N="${3:-4}"
for f in logs/"$SLUG"/peer_*.log; do
  case "$f" in *.ui.log) continue;; esac
  start=$(grep -n "session start" "$f" | tail -1 | cut -d: -f1)
  echo "== $f (from line ${start:-1})"
  tail -n +"${start:-1}" "$f" | grep -iE "map|UNCAUGHT|REJECTION|Error" | head -12
done
echo "== /status"
for i in $(seq 0 $((N-1))); do
  p=$((PORT+i))
  curl -s "http://127.0.0.1:$p/status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.peer_id, "T"+j.turn+"."+j.round, "tile", JSON.stringify(j.entity.tile), "map", JSON.stringify(j.map))}catch{console.log("port '"$p"': no status")}})'
done
