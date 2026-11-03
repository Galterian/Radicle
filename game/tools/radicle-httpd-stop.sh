#!/usr/bin/env bash
# Kill every radicle-httpd running on this box (any port). Prints what it
# killed. Idempotent — exits 0 even if nothing was running.
#
#   tools/radicle-httpd-stop.sh           # TERM then KILL after 2s
#   tools/radicle-httpd-stop.sh 8080      # only kill the one bound to :8080
set -euo pipefail

PORT="${1:-}"

if [ -n "${PORT}" ]; then
  PIDS=$(ss -ltnp 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p { print $0 }' | grep -oE 'pid=[0-9]+' | sed 's/pid=//' | sort -u || true)
  if [ -z "${PIDS}" ]; then
    PIDS=$(pgrep -f "radicle-httpd.*:${PORT}" || true)
  fi
  echo "targeting radicle-httpd on :${PORT} → pids: ${PIDS:-<none>}"
else
  PIDS=$(pgrep -x radicle-httpd || true)
  echo "targeting all radicle-httpd → pids: ${PIDS:-<none>}"
fi

if [ -z "${PIDS}" ]; then
  echo "nothing to stop"
  exit 0
fi

for pid in ${PIDS}; do
  echo "kill -TERM ${pid}"
  kill -TERM "${pid}" 2>/dev/null || true
done
sleep 2

for pid in ${PIDS}; do
  if kill -0 "${pid}" 2>/dev/null; then
    echo "kill -KILL ${pid}"
    kill -KILL "${pid}" 2>/dev/null || true
  fi
done

echo "== after"
pgrep -lx radicle-httpd || echo "no radicle-httpd running"
