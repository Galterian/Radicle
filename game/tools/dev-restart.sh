#!/usr/bin/env bash
# Dev helper: kill every chaosD6 node process, start two launchers (A on the
# first free port from 7357, B next), host Ashfall-Micro from A. Logs land in
# /tmp/chaos-A.log and /tmp/chaos-B.log. Needs node >= 18 on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
# /usr/bin/node on this box is v16 (no BroadcastChannel → libp2p dies); prefer nvm's 22.
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH

ps -eo pid,comm,args | grep -E '^ *[0-9]+ +node +.*\.mjs' | grep -v bash | awk '{print $1}' | xargs -r kill 2>/dev/null || true
sleep 1

node --check peer.mjs
setsid nohup node start-all.mjs < /dev/null > /tmp/chaos-A.log 2>&1 &
sleep 3
setsid nohup node start-all.mjs < /dev/null > /tmp/chaos-B.log 2>&1 &
sleep 3

A=$(grep -oE 'open http://127.0.0.1:[0-9]+' /tmp/chaos-A.log | grep -oE '[0-9]+$')
B=$(grep -oE 'open http://127.0.0.1:[0-9]+' /tmp/chaos-B.log | grep -oE '[0-9]+$')
echo "launcher A :$A   launcher B :$B"

IP=$(curl -s "http://127.0.0.1:$A/api/network" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).default))')
echo "hosting on $IP via A"
curl -s -X POST "http://127.0.0.1:$A/api/launch" -H 'Content-Type: application/json' \
  -d "{\"mode\":\"host\",\"dimensionName\":\"Ashfall-Micro\",\"publicIp\":\"$IP\"}"
echo
echo "B launcher: http://127.0.0.1:$B"
