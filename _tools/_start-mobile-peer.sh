#!/bin/bash
# Start a single peer bound to 127.0.0.1:7401 so the Android emulator can
# reach it via 10.0.2.2:7401 (host-loopback alias). Logs to /tmp/chaosd6-mobile/peer.log.
set -eu
cd /home/galt/repo_radicle_clone2/chaosD6/game
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
mkdir -p /tmp/chaosd6-mobile
# Reap any existing peer on 7401
if ss -tlnp 2>/dev/null | grep -q ':7401 '; then
  pids=$(pgrep -f 'node peer.mjs' || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  sleep 1
fi
setsid env PEER_LABEL=mobile-dev node peer.mjs \
  > /tmp/chaosd6-mobile/peer.log 2>&1 </dev/null &
disown
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if ss -tlnp 2>/dev/null | grep -q ':7401 '; then
    echo "ok: peer listening on 7401 after ${i}s"
    ss -tlnp 2>/dev/null | grep ':7401 ' | head -3
    exit 0
  fi
done
echo "FAIL: peer didn't bind 7401 in 10s. Log tail:"
tail -40 /tmp/chaosd6-mobile/peer.log
exit 1
