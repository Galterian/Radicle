#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/../game"
node --check ui-server.mjs
echo SYNTAX_OK
UI_PID=$(pgrep -af 'node ui-server.mjs' | grep -v vscode | awk '{print $1}' | head -1 || true)
if [ -n "${UI_PID:-}" ]; then kill -9 "$UI_PID" 2>/dev/null || true; fi
sleep 1
(setsid nohup bash -c 'UI_PORT=7358 node ui-server.mjs' > /tmp/ui-7358.log 2>&1 < /dev/null &)
sleep 2
tail -3 /tmp/ui-7358.log
echo ---CURL---
curl -sS -D - -o /dev/null 'http://127.0.0.1:7358/assets/terrain/terrain_tiles.json' | grep -iE 'HTTP|cache-control|content-length'
echo ---SPRITE---
curl -sS -D - -o /dev/null 'http://127.0.0.1:7358/assets/Sprites/Buildings/Empire/Library/Library%20-%20base%20%5BBPLI%5D.png' | grep -iE 'HTTP|cache-control|content-length'
