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
# Wait for the launcher (a cold start can take more than a few seconds; with set -e a too-early grep used to end the run silently).
A=""
for i in $(seq 1 40); do
  A=$(grep -oE 'open http://127.0.0.1:[0-9]+' /tmp/chaos-A.log 2>/dev/null | grep -oE '[0-9]+$' || true)
  [ -n "$A" ] && break
  sleep 1
done
[ -n "$A" ] || { echo "launcher A did not come up:"; tail -20 /tmp/chaos-A.log; exit 1; }
echo "launcher A :$A"
# Second identity / second clone (launcher C) if it is set up — one player joins through it.
C=""
if [ -d "${RAD_HOME_B:-$HOME/.radicle-b}" ] && [ "${NO_C:-0}" != 1 ]; then
  bash tools/start-b.sh || true
  C=$(grep -oE 'open http://127.0.0.1:[0-9]+' /tmp/chaos-C.log | grep -oE '[0-9]+$' || true)
  echo "launcher C :${C:-none}"
fi
LAUNCHER_C="${C:+http://127.0.0.1:$C}" LOGS_C="${CLONE_DIR_B:-$HOME/repo_radicle_b}/game/logs"   node tools/swarm-test.mjs "http://127.0.0.1:$A" "${1:-4}" 2>&1 | tee /tmp/swarm.log
