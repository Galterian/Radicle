#!/bin/bash
# Launch the host game stack inside a detached screen session so it survives
# transient wsl.exe invocations. Public IP is non-loopback so the player clone
# treats the host as remote.
set -e
export PATH=/home/galt/.nvm/versions/node/v22.23.3/bin:/home/galt/.radicle/bin:/usr/local/bin:/usr/bin:/bin
cd /home/galt/repo_radicle/chaosD6/game
rm -f host.log host.pid

# Kill any prior detached screen
screen -ls 2>/dev/null | grep -q chaosd6-host && screen -S chaosd6-host -X quit || true

screen -dmS chaosd6-host bash -c "
  cd /home/galt/repo_radicle/chaosD6/game
  export PEER_PUBLIC_IP=172.18.151.194
  export PATH=/home/galt/.nvm/versions/node/v22.23.3/bin:/home/galt/.radicle/bin:/usr/local/bin:/usr/bin:/bin
  exec node start-all.mjs 2>&1 | tee host.log
"
echo "launched screen session chaosd6-host"
sleep 3
screen -ls | grep chaosd6-host || true
pgrep -f 'node start-all.mjs' | head -1 > host.pid
echo "start-all.mjs pid=$(cat host.pid 2>/dev/null)"
