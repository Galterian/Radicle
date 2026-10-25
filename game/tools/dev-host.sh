#!/usr/bin/env bash
# Dev helper: kill every chaosD6 node process, start one launcher on :7357 and
# host a fresh dimension on it. Also brings up the dev UI server on :7358 and
# the 174xx → 74xx proxy (tools/wsl-proxy.mjs) so a Windows browser can reach
# the WSL peers even when another checkout holds 7357/7401+ on the Windows side.
# Prints the dimension name and the player peer's UI port.
#
#   tools/dev-host.sh [dimensionName=Dev-<hhmm>]
set -euo pipefail
cd "$(dirname "$0")/.."
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH
export SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-$HOME/.ssh/agent.sock}"
DIM="${1:-Dev-$(date +%H%M)}"

ps -eo pid,args | grep -E 'node(\.exe)? .*(peer|start-all|ui-server|wsl-proxy|skill-probe|swarm-test)\.mjs' | grep -v grep | awk '{print $1}' | xargs -r kill 2>/dev/null || true
sleep 2
node --check peer.mjs
setsid nohup node start-all.mjs < /dev/null > /tmp/chaos-A.log 2>&1 &
for i in $(seq 1 20); do grep -q 'open http://127.0.0.1' /tmp/chaos-A.log && break; sleep 0.5; done
A=$(grep -oE 'open http://127.0.0.1:[0-9]+' /tmp/chaos-A.log | grep -oE '[0-9]+$')
IP=$(curl -s "http://127.0.0.1:$A/api/network" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).default))')
OUT=$(curl -s -X POST "http://127.0.0.1:$A/api/launch" -H 'Content-Type: application/json' -d "{\"mode\":\"host\",\"dimensionName\":\"$DIM\",\"publicIp\":\"$IP\"}")
PORT=$(echo "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.ok){console.error(s);process.exit(1)}console.log(j.peerPort)})')
UI_PORT=7358 setsid nohup node ui-server.mjs < /dev/null > /tmp/ui-7358.log 2>&1 &
setsid nohup node tools/wsl-proxy.mjs < /dev/null > /tmp/proxy.log 2>&1 &
echo "$DIM" > /tmp/dim.txt
echo "dimension $DIM · launcher :$A · player UI socket :$PORT (Windows browser: http://localhost:7358/?peer=1$PORT)"
