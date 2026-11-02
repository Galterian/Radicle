#!/usr/bin/env bash
# Build the Godot Android APK with the Firebase google-services.json baked in,
# then install it on an attached device via adb.
#
# Usage:
#   bash _tools/build_and_deploy.sh                  # debug build + install
#   bash _tools/build_and_deploy.sh --release        # release build + install
#   bash _tools/build_and_deploy.sh --no-install     # build only
#   bash _tools/build_and_deploy.sh --no-build       # skip build, just install the existing apk
#
# adb resolution order:
#   $ADB env var -> adb on PATH -> /mnt/c/platform-tools/adb.exe (Windows host install)

set -euo pipefail
cd "$(dirname "$0")/.."

# Pick up JAVA_HOME / ANDROID_HOME / keystore paths and put the SDK's
# platform-tools (adb) on PATH, so the Linux adb is preferred over Windows.
if [[ -f /home/galt/godot-android/env.sh ]]; then
  # shellcheck disable=SC1091
  source /home/galt/godot-android/env.sh
fi

MODE="debug"
DO_BUILD=1
DO_INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --release)    MODE="release" ;;
    --debug)      MODE="debug" ;;
    --no-install) DO_INSTALL=0 ;;
    --no-build)   DO_BUILD=0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

APK_PATH="$(pwd)/_tools/chaosd6-${MODE}.apk"
GSJ_DEST="godot/android/build/google-services.json"

# -- 1. Write google-services.json --------------------------------------------
mkdir -p "$(dirname "$GSJ_DEST")"
cat > "$GSJ_DEST" <<'JSON'
{
  "project_info": {
    "project_number": "1084963762264",
    "project_id": "dimensions-4e9ae",
    "storage_bucket": "dimensions-4e9ae.firebasestorage.app"
  },
  "client": [
    {
      "client_info": {
        "mobilesdk_app_id": "1:1084963762264:android:e5e0fc22aa6eddfa0cda2d",
        "android_client_info": {
          "package_name": "net.dimensions.radicle"
        }
      },
      "oauth_client": [],
      "api_key": [
        {
          "current_key": "AIzaSyDGQQQVwHAFSa_UuzLjzoyvMkoqKK-4wMM"
        }
      ],
      "services": {
        "appinvite_service": {
          "other_platform_oauth_client": []
        }
      }
    }
  ],
  "configuration_version": "1"
}
JSON
echo "[deploy] wrote $GSJ_DEST"

# Warn if the Godot preset's package name doesn't match the json.
PRESET_PKG="$(grep -E '^package/unique_name=' godot/export_presets.cfg | head -1 | sed -E 's/.*="([^"]+)".*/\1/')"
GSJ_PKG="net.dimensions.radicle"
if [[ -n "$PRESET_PKG" && "$PRESET_PKG" != "$GSJ_PKG" ]]; then
  echo "[deploy] WARN: export_presets.cfg package '$PRESET_PKG' != google-services.json package '$GSJ_PKG'"
  echo "[deploy]       Firebase will not initialize at runtime until these match"
  echo "[deploy]       (or an app with the preset package is added to the Firebase project)."
fi

# -- 2. Build -----------------------------------------------------------------
if (( DO_BUILD )); then
  echo "[deploy] building $MODE APK..."
  if [[ "$MODE" == "release" ]]; then
    bash _tools/build_android_apk.sh --release
  else
    bash _tools/build_android_apk.sh
  fi
fi

if [[ ! -f "$APK_PATH" ]]; then
  echo "[deploy] APK not found at $APK_PATH" >&2
  exit 1
fi
echo "[deploy] apk: $APK_PATH"

# -- 3. Install ---------------------------------------------------------------
if (( ! DO_INSTALL )); then
  echo "[deploy] --no-install set, done."
  exit 0
fi

resolve_adb() {
  if [[ -n "${ADB-}" ]] && command -v "$ADB" >/dev/null 2>&1; then
    echo "$ADB"; return
  fi
  if command -v adb >/dev/null 2>&1; then
    command -v adb; return
  fi
  if [[ -x "/home/galt/godot-android/android-sdk/platform-tools/adb" ]]; then
    echo "/home/galt/godot-android/android-sdk/platform-tools/adb"; return
  fi
  if [[ -x "/mnt/c/platform-tools/adb.exe" ]]; then
    echo "/mnt/c/platform-tools/adb.exe"; return
  fi
  return 1
}

ADB_BIN="$(resolve_adb)" || {
  echo "[deploy] no adb found. Set \$ADB, install adb in WSL, or install Platform-Tools on Windows at C:\\platform-tools\\." >&2
  exit 1
}
echo "[deploy] adb: $ADB_BIN"

DEVICES="$("$ADB_BIN" devices | awk 'NR>1 && $2=="device" {print $1}')"
if [[ -z "$DEVICES" ]]; then
  echo "[deploy] no authorized devices attached. Run: $ADB_BIN devices" >&2
  exit 1
fi
echo "[deploy] device(s): $DEVICES"

# When calling adb.exe (Windows) from WSL, translate the path.
APK_FOR_ADB="$APK_PATH"
if [[ "$ADB_BIN" == *.exe ]]; then
  APK_FOR_ADB="$(wslpath -w "$APK_PATH")"
fi

echo "[deploy] installing..."
"$ADB_BIN" install -r "$APK_FOR_ADB"
echo "[deploy] done."
