#!/bin/bash
# Stop every ChaosD6 process (any checkout), then start one clean launcher from clone2.
pkill -f 'node .*start-all\.mjs' 2>/dev/null
pkill -f 'node .*ui-server\.mjs' 2>/dev/null
pkill -f 'node .*peer\.mjs' 2>/dev/null
pkill -f 'node .*discovery\.mjs' 2>/dev/null
sleep 1.5
left=$(pgrep -f 'node .*(start-all|ui-server|peer|discovery)\.mjs' | wc -l)
echo "remaining game procs: $left"
ss -tlnp 2>/dev/null | grep -E ':73[5-6][0-9] ' && echo "(ports still held)" || echo "UI ports clear"

export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1
export PATH="$HOME/.radicle/bin:$PATH"
cd /home/galt/repo_radicle_clone2/chaosD6/game
nohup node start-all.mjs > host.log 2>&1 &
echo "launcher pid $!"
sleep 6
echo "--- host.log ---"
tail -8 host.log
echo "--- serving new code on 7357? ---"
curl -s --max-time 3 http://127.0.0.1:7357/js/main.js | grep -c 'double-click to commit'
