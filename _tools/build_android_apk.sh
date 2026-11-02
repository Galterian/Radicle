#!/usr/bin/env bash
# One-shot debug APK build for the Godot client.
#
# Prerequisites:
#   - /home/galt/godot-android/env.sh exports JAVA_HOME, ANDROID_HOME,
#     debug-keystore paths (already configured on this box).
#   - Godot 4.3's Android export templates installed under
#     ~/.local/share/godot/export_templates/4.3.stable/ — the first run of
#     this script will install them if missing.
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

PRESET="Android"
MODE="debug"
if [[ "${1-}" == "--release" ]]; then
  MODE="release"
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
TEMPLATES_DIR="$HOME/.local/share/godot/export_templates/4.3.stable"
if [[ ! -d "$TEMPLATES_DIR" ]]; then
  echo "[build] fetching Godot 4.3 export templates..."
  mkdir -p "$TEMPLATES_DIR"
  TPZ="/tmp/godot-templates-4.3.tpz"
  if [[ ! -f "$TPZ" ]]; then
    curl -L -o "$TPZ" https://github.com/godotengine/godot/releases/download/4.3-stable/Godot_v4.3-stable_export_templates.tpz
  fi
  (cd "$TEMPLATES_DIR" && unzip -o "$TPZ" >/dev/null)
  mv "$TEMPLATES_DIR/templates/"* "$TEMPLATES_DIR/" 2>/dev/null || true
fi

# Install the Android build template inside the project when `use_gradle_build`
# is enabled — this is the editor's "Project > Install Android Build Template"
# action done from the CLI. Needed once per Godot version per project.
if [[ ! -d godot/android/build ]]; then
  echo "[build] installing Android build template into godot/android/build..."
  mkdir -p godot/android/build
  (cd godot/android/build && unzip -o "$TEMPLATES_DIR/android_source.zip" >/dev/null)
  touch godot/android/build/.gdignore
fi

# Tell Godot where the SDK + keystore live for this invocation. The editor
# settings file is normally where this lives, but setting them per-call lets a
# CI box build without a pre-configured editor profile.
export GODOT_EDITOR_HEADLESS=1

echo "[build] preset=$PRESET  mode=$MODE  out=$APK_PATH"
rm -f "$APK_PATH"

cd godot
if [[ "$MODE" == "debug" ]]; then
  godot4 --headless --export-debug "$PRESET" "$APK_PATH" || true
else
  godot4 --headless --export-release "$PRESET" "$APK_PATH" || true
fi

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
       cd $(pwd) && godot4 .
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
