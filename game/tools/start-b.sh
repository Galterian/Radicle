#!/usr/bin/env bash
# Start a launcher stack as the SECOND Radicle identity (see second-identity.sh),
# from its own clone — a stand-in for a stranger on another machine. Pushes go
# to that identity's namespace; the main identity only ever sees them via the
# public seeds. Log: /tmp/chaos-C.log
set -euo pipefail
export RAD_HOME="${RAD_HOME_B:-$HOME/.radicle-b}"
CLONE_DIR="${CLONE_DIR_B:-$HOME/repo_radicle_b}"
MAIN_GAME="$(cd "$(dirname "$0")/.." && pwd)"
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH="$HOME/.radicle/bin:$PATH"

# B's signing key in its own agent (socket reused across runs).
export SSH_AUTH_SOCK="$RAD_HOME/agent.sock"
if ! ssh-add -l >/dev/null 2>&1; then
  rm -f "$SSH_AUTH_SOCK"; ssh-agent -a "$SSH_AUTH_SOCK" >/dev/null
  ssh-add "$RAD_HOME/keys/radicle" 2>/dev/null
fi
rad node start >/dev/null 2>&1 || true

# The clone tracks the same code; sync its working tree with the main checkout
# so both sides run identical game code, and share node_modules.
rsync -a --delete --exclude node_modules --exclude radicle.git --exclude radicle-work --exclude sessions --exclude gun-data "$MAIN_GAME/" "$CLONE_DIR/game/"
rsync -a --delete "$MAIN_GAME/../data/" "$CLONE_DIR/data/"
[ -d "$CLONE_DIR/game/node_modules" ] || cp -a "$MAIN_GAME/node_modules" "$CLONE_DIR/game/"

cd "$CLONE_DIR/game"
ps -eo pid,args | grep -E 'node .*repo_radicle_b/game/.*\.mjs' | grep -v grep | awk '{print $1}' | xargs -r kill 2>/dev/null || true
sleep 1
setsid nohup node start-all.mjs < /dev/null > /tmp/chaos-C.log 2>&1 &
sleep 4
C=$(grep -oE 'open http://127.0.0.1:[0-9]+' /tmp/chaos-C.log | grep -oE '[0-9]+$' || true)
echo "launcher C (identity B, $(rad self --nid)) : http://127.0.0.1:${C:-?}"
