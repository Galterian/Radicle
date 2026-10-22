#!/usr/bin/env bash
# Dev helper: clean slate, one launcher, then the swarm test against it.
# usage: tools/swarm-run.sh [minutes=4]   (log: /tmp/swarm.log)
set -euo pipefail
cd "$(dirname "$0")/.."
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH
ps -eo pid,comm,args | grep -E '^ *[0-9]+ +node +.*\.mjs' | grep -v bash | awk '{print $1}' | xargs -r kill 2>/dev/null || true
sleep 1
node --check peer.mjs
setsid nohup node start-all.mjs < /dev/null > /tmp/chaos-A.log 2>&1 &
sleep 4
A=$(grep -oE 'open http://127.0.0.1:[0-9]+' /tmp/chaos-A.log | grep -oE '[0-9]+$')
echo "launcher A :$A"
node tools/swarm-test.mjs "http://127.0.0.1:$A" "${1:-4}" 2>&1 | tee /tmp/swarm.log
