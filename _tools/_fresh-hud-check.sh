#!/bin/bash
set -eu
cd /home/galt/repo_radicle_clone2/chaosD6
ADB=$HOME/android-tools/platform-tools/adb
[ -x "$ADB" ] || ADB=adb
PKG=net.dimensions.radicle
# Wait up to 25s for Godot to boot and log the Hud lines
for i in 1 2 3 4 5; do
  pid=$("$ADB" shell pidof "$PKG" 2>/dev/null | tr -d '\r\n')
  [ -n "$pid" ] && break
  sleep 2
done
echo "pid=$pid"
sleep 8
"$ADB" exec-out screencap -p > _tools/screen.png
ls -la _tools/screen.png
echo "--- fresh Hud + NetBridge + bootstrap lines ---"
"$ADB" logcat -d -v time 2>/dev/null | grep -iE '\[Hud\]|\[NetBridge\]|AssetBootstrap' | tail -60
echo "--- any godot ERROR / WARNING in last 60s ---"
"$ADB" logcat -d -v time -s godot:V 2>/dev/null | grep -iE 'ERROR|WARN' | tail -30
