#!/usr/bin/env bash
# One-shot debug APK build for the Godot client.
#
# Prerequisites:
#   - /home/galt/godot-android/env.sh exports JAVA_HOME, ANDROID_HOME,
#     debug-keystore paths (already configured on this box).
#   - Godot $GODOT_VER editor at $GODOT (default ~/godot-android/<ver>/) and its
#     Android export templates under ~/.local/share/godot/export_templates/ —
#     the first run of this script will install the templates if missing.
#     4.5+ is required for Play: 4.3's libgodot_android.so is 4 KB-aligned.
#   - godot/export_presets.cfg exists (checked in).
#
# Usage:
#   bash _tools/build_android_apk.sh              # debug build
#   bash _tools/build_android_apk.sh --release    # release build (same keystore for dev)
#
# Output: _tools/chaosd6-debug.apk relative to the repo root.

set -euo pipefail
cd "$(dirname "$0")/.."

source /home/galt/godot-android/env.sh

GODOT_VER="${GODOT_VER:-4.5.2}"
GODOT="${GODOT:-$HOME/godot-android/$GODOT_VER/Godot_v${GODOT_VER}-stable_linux.x86_64}"

MODE="debug"
PRESET="Android"
if [[ "${1-}" == "--release" ]]; then
  MODE="release"
  # Preset "Android Release" (preset.2) is APK-format and arm64-only. Dropping
  # x86_64 cuts ~132 MB of native libs from the release APK (libgodot_android
  # x86_64 70 MB + libnode x86_64 54 MB + libc++_shared x86_64 7 MB). The
  # exclude_filter also strips plugin gradle intermediates that Godot's
  # "all_resources" would otherwise duplicate into assets/. Debug builds keep
  # both ABIs on preset "Android" so the x86_64 emulator still works.
  PRESET="Android Release"
fi

# Dev convenience: if no release keystore is configured, reuse the debug one
# so --release builds don't fail with "Could not find keystore". Replace with
# a real release keystore before shipping to users.
if [[ "$MODE" == "release" && -z "${GODOT_ANDROID_KEYSTORE_RELEASE_PATH-}" ]]; then
  export GODOT_ANDROID_KEYSTORE_RELEASE_PATH="$GODOT_ANDROID_KEYSTORE_DEBUG_PATH"
  export GODOT_ANDROID_KEYSTORE_RELEASE_USER="$GODOT_ANDROID_KEYSTORE_DEBUG_USER"
  export GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD="$GODOT_ANDROID_KEYSTORE_DEBUG_PASSWORD"
  echo "[build] NOTE: using debug keystore for release signing (dev build)."
fi

OUT_DIR="$(pwd)/_tools"
mkdir -p "$OUT_DIR"
APK_PATH="$OUT_DIR/chaosd6-$MODE.apk"

# Install export templates on first run so a fresh box doesn't fail cryptically.
TEMPLATES_DIR="$HOME/.local/share/godot/export_templates/${GODOT_VER}.stable"
if [[ ! -d "$TEMPLATES_DIR" ]]; then
  echo "[build] fetching Godot $GODOT_VER export templates..."
  mkdir -p "$TEMPLATES_DIR"
  TPZ="/tmp/godot-templates-${GODOT_VER}.tpz"
  if [[ ! -f "$TPZ" ]]; then
    curl -L -o "$TPZ" "https://github.com/godotengine/godot/releases/download/${GODOT_VER}-stable/Godot_v${GODOT_VER}-stable_export_templates.tpz"
  fi
  (cd "$TEMPLATES_DIR" && unzip -o "$TPZ" >/dev/null)
  mv "$TEMPLATES_DIR/templates/"* "$TEMPLATES_DIR/" 2>/dev/null || true
fi

# Install the Android build template inside the project when `use_gradle_build`
# is enabled, or when it's from another Godot version — the editor's "Project >
# Install Android Build Template" done from the CLI, plus chaosD6's manifest /
# gradle / GodotApp.java customizations (see port_android_template.py).
if [[ "$(cat godot/android/.build_version 2>/dev/null)" != "${GODOT_VER}.stable" ]]; then
  echo "[build] installing Godot $GODOT_VER Android build template into godot/android/build..."
  python3 _tools/port_android_template.py "${GODOT_VER}.stable"
fi

# Tell Godot where the SDK + keystore live for this invocation. The editor
# settings file is normally where this lives, but setting them per-call lets a
# CI box build without a pre-configured editor profile.
export GODOT_EDITOR_HEADLESS=1

echo "[build] preset=$PRESET  mode=$MODE  out=$APK_PATH"
rm -f "$APK_PATH"

cd godot

# Godot 4.3 --headless --export-* hangs ~275s AFTER the export completes before
# the process actually exits — it idles probing the adb server (even for
# runnable=false release presets, and even when export failed). The APK is
# fully written long before this hang. We wrap the invocation so once we see
# "export: end" AND the APK is on disk, we SIGTERM the Godot process. If the
# APK never appears within WATCH_TIMEOUT seconds, we let Godot run to its own
# natural end and surface whatever error it prints.
LOG="$(mktemp -t godot-export.XXXXXX.log)"
WATCH_TIMEOUT=600   # 10 min upper bound on real build time; cold gradle+dex is ~2-3 min.
if [[ "$MODE" == "debug" ]]; then
  "$GODOT" --headless --export-debug "$PRESET" "$APK_PATH" >"$LOG" 2>&1 &
else
  "$GODOT" --headless --export-release "$PRESET" "$APK_PATH" >"$LOG" 2>&1 &
fi
GPID=$!
START=$(date +%s)
EXPORT_END_SEEN=0
# set -e makes `(( EXPORT_END_SEEN ))` fatal when the value is 0 (that's a
# non-zero `((...))` exit), so use [[ ]] throughout this watcher loop.
while kill -0 "$GPID" 2>/dev/null; do
  if [[ $EXPORT_END_SEEN -eq 0 ]] && grep -q "^export: end$" "$LOG" 2>/dev/null; then
    EXPORT_END_SEEN=1
  fi
  if [[ $EXPORT_END_SEEN -eq 1 && -s "$APK_PATH" ]]; then
    # Give APK writer a beat to flush, then shut Godot down cleanly.
    sleep 1
    kill -TERM "$GPID" 2>/dev/null || true
    sleep 2
    kill -KILL "$GPID" 2>/dev/null || true
    echo "[build] cut Godot's post-export idle (saved ~4-5 min)"
    break
  fi
  NOW=$(date +%s)
  if [[ $((NOW - START)) -gt $WATCH_TIMEOUT ]]; then
    echo "[build] WARN: ${WATCH_TIMEOUT}s elapsed without APK — letting Godot continue"
    break
  fi
  sleep 2
done
wait "$GPID" 2>/dev/null || true
# Surface godot output for diagnostics; strip the harmless tail noise.
grep -v -E "^(error: failed to read response from server)$" "$LOG" || true
rm -f "$LOG"

if [[ -f "$APK_PATH" ]]; then
  ls -lh "$APK_PATH"
  echo "[build] done. Install with: adb install -r '$APK_PATH'"
  exit 0
fi

# Godot's headless export reports "configuration errors" but swallows the
# per-field detail — only the GUI editor's export dialog lists exactly which
# field is wrong. If we get here, the preset or editor settings need a one-
# time fix in the editor:
cat <<EOF
[build] export failed. The headless Godot CLI doesn't print per-field reasons.
To diagnose:
  1. Open the project in the Godot editor:
       cd $(pwd) && $GODOT .
  2. Project > Export > Android — the dialog will list the exact missing
     setting (usually one of):
       - Java SDK path (should auto-fill from JAVA_HOME)
       - Android SDK path (should auto-fill from ANDROID_HOME)
       - Debug Keystore (path to /home/galt/godot-android/keys/debug.keystore)
       - Install Android build template (one-off, Project > Install Android
         Build Template)
  3. Once the dialog is green, re-run this script.
EOF
exit 1
