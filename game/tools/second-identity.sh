#!/usr/bin/env bash
# Create (once) and start a SECOND Radicle identity on this box, so a second
# player can be simulated with its own node, key and namespace — exactly like
# a stranger on another machine. Everything lives under $RAD_HOME_B.
#
#   tools/second-identity.sh setup     # create identity + node config + clone the repo
#   tools/second-identity.sh start     # start node B (idempotent), print status
#   tools/second-identity.sh status
#   tools/second-identity.sh stop
set -euo pipefail
export PATH="$HOME/.radicle/bin:$PATH"
export RAD_HOME="${RAD_HOME_B:-$HOME/.radicle-b}"
export RAD_PASSPHRASE="${RAD_PASSPHRASE_B:-}"
RID=rad:zqZmP6itceBMqYwi1K1n8phQqCaj
CLONE_DIR="${CLONE_DIR_B:-$HOME/repo_radicle_b}"
NODE_PORT="${RAD_NODE_PORT_B:-8777}"
cmd="${1:-status}"

case "$cmd" in
  setup)
    if [ ! -f "$RAD_HOME/keys/radicle" ]; then
      echo "== rad auth (identity B in $RAD_HOME)"
      rad auth --alias player-b
    fi
    mkdir -p "$RAD_HOME"
    CFG="$RAD_HOME/config.json"
    if [ -f "$CFG" ]; then
      # Separate listen port + seed everything from the repo (all namespaces).
      python3 - "$CFG" "$NODE_PORT" <<'EOF'
import json, sys
p, port = sys.argv[1], sys.argv[2]
c = json.load(open(p))
c.setdefault("node", {})["listen"] = [f"0.0.0.0:{port}"]
c["node"]["seedingPolicy"] = {"default": "block"}
json.dump(c, open(p, "w"), indent=2)
EOF
    fi
    echo "== starting node B"; rad node start >/dev/null 2>&1 || true; sleep 3
    rad node status | head -3 || true
    echo "== seed + clone $RID → $CLONE_DIR"
    rad seed "$RID" --scope all || true
    if [ ! -d "$CLONE_DIR/.git" ]; then
      mkdir -p "$(dirname "$CLONE_DIR")"
      rad clone "$RID" "$CLONE_DIR" --scope all
    fi
    echo "== node B identity"; rad self
    ;;
  start)
    rad node start >/dev/null 2>&1 || true; sleep 2; rad node status | head -3
    ;;
  status)
    rad node status | head -5 || true; rad self | head -4 || true
    ;;
  stop)
    rad node stop || true
    ;;
  *) echo "unknown command $cmd"; exit 2;;
esac
