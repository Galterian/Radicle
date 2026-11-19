#!/usr/bin/env bash
# Dev helper: clean slate, one launcher, then the swarm test against it.
# usage: tools/swarm-run.sh [minutes=4]   (log: /tmp/swarm.log)
set -euo pipefail
cd "$(dirname "$0")/.."
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH
# FORCE_CLASS=a,b,c: round-robin over every hero label (bot-driven ones first, then the NPC roster and the
# joined monsters) so each listed class is held by at least one peer — peer.mjs reads FORCE_CLASS_LABELS.
# FORCE_CLASS_MONSTERS=1 also hands the list to wild lurkers (by label hash).
if [[ "${FORCE_CLASS:-}" == *,* && -z "${FORCE_CLASS_LABELS:-}" ]]; then
  FORCE_CLASS_LABELS="player-1,P-Agent2,P-Agent3,P-Agent4,P-Agent5"
  [ "${TEAM_C:-0}" = 1 ] && FORCE_CLASS_LABELS="$FORCE_CLASS_LABELS,C-Agent6"
  [ "${TEAM_D:-0}" = 1 ] && FORCE_CLASS_LABELS="$FORCE_CLASS_LABELS,D-Agent7"
  export FORCE_CLASS_LABELS="$FORCE_CLASS_LABELS,ally-1,foe-1,foe-2,M-Foe3,M-Foe4"
fi
# The swarm summary scans the hashgraph tape (swarm-test.mjs §6 reads hashgraph.1.jsonl + hashgraph.jsonl): cap it at
# 64 MB per file (peer.mjs TAPE_MAX_BYTES rotates past it) — an uncapped tape reached 1.2 GB (Swarm-1159). 0 = unbounded.
export TAPE_MAX_BYTES="${TAPE_MAX_BYTES:-67108864}"
# NOGUN=1: every peer (launcher A/C, joiners, companions) runs without Gun (P2P rework M6 step 1). Default: Gun on.
export NOGUN="${NOGUN:-0}"
ps -eo pid,comm,args | grep -E '^ *[0-9]+ +node +.*\.mjs' | grep -v bash | awk '{print $1}' | xargs -r kill 2>/dev/null || true
sleep 1
node --check peer.mjs
setsid nohup node start-all.mjs < /dev/null > /tmp/chaos-A.log 2>&1 &
LAUNCHER_PID=$!
# At the end (or on failure) stop this run's launcher and every peer of its dimension: a launcher left running kept
# 19 peers playing Swarm-1159 for 15 h. KEEP_LAUNCHER=1 leaves it up (e.g. to look at the dimension in a browser).
stop_swarm() {
  [ "${KEEP_LAUNCHER:-0}" = 1 ] && { echo "KEEP_LAUNCHER=1 — launcher A left running (pid $LAUNCHER_PID)"; return; }
  local n dim p
  n=$(grep -oE 'hosted Swarm-[0-9]+' /tmp/swarm.log 2>/dev/null | head -1 | grep -oE '[0-9]+$' || true)
  dim="dim-swarm-${n:-none}"
  kill -- -"$LAUNCHER_PID" 2>/dev/null || kill "$LAUNCHER_PID" 2>/dev/null || true
  for p in $(pgrep -f 'peer\.mjs' || true); do
    tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -qx "DIM_ID=$dim" && kill "$p" 2>/dev/null || true
  done
  echo "swarm stopped: launcher A (pid $LAUNCHER_PID) and the peers of $dim"
}
trap stop_swarm EXIT
# Wait for the launcher (a cold start can take more than a few seconds; with set -e a too-early grep used to end the run silently).
A=""
for i in $(seq 1 40); do
  A=$(grep -oE 'open http://127.0.0.1:[0-9]+' /tmp/chaos-A.log 2>/dev/null | grep -oE '[0-9]+$' || true)
  [ -n "$A" ] && break
  sleep 1
done
[ -n "$A" ] || { echo "launcher A did not come up:"; tail -20 /tmp/chaos-A.log; exit 1; }
# start-all prints "open http://…" before its ui-server child listens (a slow cold start → ECONNREFUSED in
# swarm-test, 2026-11-19): wait until the port answers.
for i in $(seq 1 60); do
  (exec 3<>/dev/tcp/127.0.0.1/$A) 2>/dev/null && break
  sleep 1
done
(exec 3<>/dev/tcp/127.0.0.1/$A) 2>/dev/null || { echo "launcher A :$A never answered:"; tail -20 /tmp/chaos-A.log; exit 1; }
echo "launcher A :$A"
# Second identity / second clone (launcher C) if it is set up — one player joins through it.
C=""
if [ -d "${RAD_HOME_B:-$HOME/.radicle-b}" ] && [ "${NO_C:-0}" != 1 ]; then
  bash tools/start-b.sh || true
  C=$(grep -oE 'open http://127.0.0.1:[0-9]+' /tmp/chaos-C.log | grep -oE '[0-9]+$' || true)
  echo "launcher C :${C:-none}"
fi
LAUNCHER_C="${C:+http://127.0.0.1:$C}" LOGS_C="${CLONE_DIR_B:-$HOME/repo_radicle_b}/game/logs"   node tools/swarm-test.mjs "http://127.0.0.1:$A" "${1:-4}" 2>&1 | tee /tmp/swarm.log
