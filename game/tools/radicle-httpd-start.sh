#!/usr/bin/env bash
# Start rad node (if not already up) and launch radicle-httpd in the background.
# Default listen is 0.0.0.0:8080; pass a different port as $1.
#
#   tools/radicle-httpd-start.sh            # listens on 0.0.0.0:8080
#   tools/radicle-httpd-start.sh 8090       # listens on 0.0.0.0:8090
#
# Logs go to /tmp/radicle-httpd-<port>.log. The process is nohup'd and
# disowned so you can close the terminal. tools/radicle-httpd-stop.sh kills
# every radicle-httpd this box owns.

set -euo pipefail
export PATH="$HOME/.radicle/bin:$PATH"

PORT="${1:-8080}"
LISTEN="0.0.0.0:${PORT}"
LOG="/tmp/radicle-httpd-${PORT}.log"

if ! command -v radicle-httpd >/dev/null 2>&1; then
  echo "radicle-httpd not found in PATH ($HOME/.radicle/bin/)" >&2
  exit 1
fi

if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}\$"; then
  echo "port ${PORT} is already bound — refusing to double-start" >&2
  ss -ltn | grep -E "[:.]${PORT}\$" >&2 || true
  exit 2
fi

echo "== rad node start"
rad node start >/dev/null 2>&1 || true
sleep 1
rad node status | head -3 || true

echo "== radicle-httpd --listen ${LISTEN}  (log: ${LOG})"
nohup radicle-httpd --listen "${LISTEN}" > "${LOG}" 2>&1 &
HTTPD_PID=$!
disown "${HTTPD_PID}" 2>/dev/null || true
sleep 1

echo "pid: ${HTTPD_PID}"
if ss -ltn 2>/dev/null | grep -qE "[:.]${PORT}\$"; then
  echo "listening: $(ss -ltn | grep -E "[:.]${PORT}\$" | head -1)"
else
  echo "warning: nothing is listening on :${PORT} yet; check ${LOG}" >&2
fi

echo "== probe"
curl -sS --max-time 3 "http://127.0.0.1:${PORT}/api/v1/node" | head -c 200 || true
echo
