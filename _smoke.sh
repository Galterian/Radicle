#!/bin/bash
export PATH="$HOME/.radicle/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 22 >/dev/null
cd /home/galt/repo_radicle_clone2/chaosD6/game

for f in start-all.mjs ui-server.mjs js/launcher.js; do
  node --check "$f" >/dev/null 2>&1 && echo "syntax $f OK" || { echo "syntax $f FAIL"; node --check "$f"; exit 1; }
done

node start-all.mjs > /tmp/start-all.log 2>&1 &
PID=$!
sleep 8
echo "--- GET /js/launcher.js first line ---"
curl -s --max-time 3 http://127.0.0.1:7357/js/launcher.js | head -1
echo "--- GET /api/dimensions (first 300 chars) ---"
curl -s --max-time 15 http://127.0.0.1:7357/api/dimensions | head -c 300
echo
kill $PID 2>/dev/null; wait 2>/dev/null
