#!/bin/bash
set -eu
cd /home/galt/repo_radicle_clone2/chaosD6
ADB=$HOME/android-tools/platform-tools/adb
if [ ! -x "$ADB" ]; then ADB=adb; fi
echo "--- adb devices ---"
"$ADB" devices
echo "--- screencap ---"
"$ADB" exec-out screencap -p > _tools/screen.png 2>/dev/null || echo "screencap failed"
ls -la _tools/screen.png 2>/dev/null || true
pid=$("$ADB" shell pidof net.dimensions.radicle 2>/dev/null | tr -d '\r\n')
[ -z "$pid" ] && pid=$("$ADB" shell pidof io.chaosd6.dimensions 2>/dev/null | tr -d '\r\n')
echo "--- game pid: '$pid' ---"
if [ -n "$pid" ]; then
  echo "--- logcat tail (pid=$pid) ---"
  "$ADB" logcat -d --pid="$pid" -v time 2>/dev/null | tail -120
else
  echo "--- no game pid; logcat tail filtered to godot/chaos ---"
  "$ADB" logcat -d -v time 2>/dev/null | grep -iE 'godot|chaos|hud|net|assetboot' | tail -120
fi
