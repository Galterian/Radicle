#!/bin/bash
set -eu
cd /home/galt/repo_radicle_clone2/chaosD6
ADB=$HOME/android-tools/platform-tools/adb
[ -x "$ADB" ] || ADB=adb
APK=_tools/chaosd6-release.apk
PKG=net.dimensions.radicle
echo "--- devices ---"
"$ADB" devices
echo "--- installing $APK ---"
"$ADB" install -r "$APK"
echo "--- launching $PKG ---"
"$ADB" shell am force-stop "$PKG" >/dev/null 2>&1 || true
"$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
sleep 2
pid=$("$ADB" shell pidof "$PKG" 2>/dev/null | tr -d '\r\n')
echo "pid=$pid"
# Wait up to 25s for the HUD to settle (deferred retries happen at 0.6s)
sleep 10
echo "--- screencap ---"
"$ADB" exec-out screencap -p > _tools/screen.png
ls -la _tools/screen.png
echo "--- logcat tail (recent) ---"
"$ADB" logcat -d -v time -s godot:V 2>/dev/null | tail -80
echo "--- Hud lines ---"
"$ADB" logcat -d -v time 2>/dev/null | grep -iE '\[Hud\]|AssetBootstrap|net.dimensions' | tail -60
