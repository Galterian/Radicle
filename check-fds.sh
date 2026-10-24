#!/bin/bash
echo "== all game-related processes =="
ps -eo pid,ppid,sid,etime,cmd | grep -E 'node (start-all|peer|discovery|ui-server)\.mjs|node /.*\.mjs' | grep -v grep
echo
echo "== fd 1 of each =="
for pid in $(ps -eo pid,cmd | grep -E 'node (start-all|peer|discovery|ui-server)\.mjs' | grep -v grep | awk '{print $1}'); do
  cmd=$(ps -p "$pid" -o cmd= 2>/dev/null)
  fd1=$(readlink /proc/"$pid"/fd/1 2>/dev/null)
  cwd=$(readlink /proc/"$pid"/cwd 2>/dev/null)
  echo "pid=$pid"
  echo "  cmd=$cmd"
  echo "  fd1=$fd1"
  echo "  cwd=$cwd"
done
echo
echo "== /tmp/chaos-host.log =="
ls -la /tmp/chaos-host.log 2>/dev/null
echo
echo "== game/host.log =="
ls -la /home/galt/repo_radicle/chaosD6/game/host.log
