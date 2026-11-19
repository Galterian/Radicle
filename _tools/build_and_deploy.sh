#!/usr/bin/env bash
# Build the Godot Android APK with the Firebase google-services.json baked in,
# then install it on an attached device via adb. Every build first stages the
# current game/ code into the phone bundle (game/tools/stage-mobile-bundle.mjs).
#
# Usage:
#   bash _tools/build_and_deploy.sh                  # debug build + install
#   bash _tools/build_and_deploy.sh --release        # release build + install (bumps minor)
#   bash _tools/build_and_deploy.sh --no-install     # build only
#   bash _tools/build_and_deploy.sh --no-build       # skip build, just install the existing apk
#
# --release also bumps version/code (+1) and version/name (minor +1, patch -> 0)
# in godot/export_presets.cfg before building, so each release is strictly
# newer. Dev builds don't bump. --release also scp's the built APK to
# OCI's /var/www/downloads/chaosd6-release.apk (unless the SSH key is
# missing), so the Firebase site's "Download APK" link stays current.
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

# -- 1b. On release: bump version/code (+1) and version/name (minor +1, patch -> 0)
# across both export presets, so Play Store and side-loaded installs always get
# a strictly newer artifact. Dev/debug builds don't bump — they'd churn git.
if [[ "$MODE" == "release" && $DO_BUILD -eq 1 ]]; then
  PRESETS=godot/export_presets.cfg
  CUR_CODE="$(grep -E '^version/code=' "$PRESETS" | head -1 | sed -E 's/.*=([0-9]+).*/\1/')"
  CUR_NAME="$(grep -E '^version/name=' "$PRESETS" | head -1 | sed -E 's/.*="([^"]+)".*/\1/')"
  if [[ -z "$CUR_CODE" || -z "$CUR_NAME" ]]; then
    echo "[deploy] could not read version/code or version/name from $PRESETS" >&2
    exit 1
  fi
  NEW_CODE=$(( CUR_CODE + 1 ))
  IFS=. read -r MAJ MIN PAT <<< "$CUR_NAME"
  NEW_NAME="${MAJ}.$((MIN + 1)).0"
  # Replace *every* occurrence in the file so preset.0 (APK) and preset.1 (AAB) stay in lockstep.
  sed -i -E "s|^version/code=.*|version/code=${NEW_CODE}|g" "$PRESETS"
  sed -i -E "s|^version/name=.*|version/name=\"${NEW_NAME}\"|g" "$PRESETS"
  echo "[deploy] bumped version: ${CUR_NAME} (code ${CUR_CODE}) -> ${NEW_NAME} (code ${NEW_CODE})"
fi

# -- 1c. Stage the phone's Node bundle from the current game/ sources ----------
# The APK ships godot/android/plugins/nodejs_mobile/src/main/assets/nodejs-project as-is; without this step
# 0.79–0.83 shipped the 11-16 game code (2026-11-19). Syntax-check first so a broken peer never reaches the phone.
if (( DO_BUILD )); then
  NODE_BIN="$(command -v node || echo /home/galt/.nvm/versions/node/v22.23.4/bin/node)"
  for f in peer.mjs mobile-entry.mjs mobile-menu.mjs join-plan.mjs; do
    "$NODE_BIN" --check "game/$f" || { echo "[deploy] syntax error in game/$f — not building" >&2; exit 1; }
  done
  "$NODE_BIN" game/tools/effects-check.mjs | tail -1
  "$NODE_BIN" game/tools/stage-mobile-bundle.mjs || { echo "[deploy] staging the phone bundle failed — not building" >&2; exit 1; }
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

# -- 2b. Release only: upload the APK to OCI so the Firebase site's
# "Download APK" button serves the just-built artifact. Skipped on debug
# builds (dev churn) and skipped if the SSH key isn't present (CI, etc).
if [[ "$MODE" == "release" ]]; then
  OCI_KEY="infra/oci/keys/oci_seeder"
  OCI_HOST="ubuntu@92.5.138.121"
  OCI_PATH="/var/www/downloads/chaosd6-release.apk"
  if [[ -f "$OCI_KEY" ]]; then
    echo "[deploy] uploading APK to $OCI_HOST:$OCI_PATH ..."
    if scp -i "$OCI_KEY" -o StrictHostKeyChecking=accept-new "$APK_PATH" "$OCI_HOST:/tmp/chaosd6-release.apk"; then
      ssh -i "$OCI_KEY" "$OCI_HOST" "sudo mv /tmp/chaosd6-release.apk $OCI_PATH && sudo chown ubuntu:ubuntu $OCI_PATH"
      echo "[deploy] uploaded. Browser download URL: https://92-5-138-121.sslip.io/downloads/chaosd6-release.apk"
    else
      echo "[deploy] WARN: scp failed; OCI download URL will keep serving the previous APK."
    fi
  else
    echo "[deploy] skip OCI upload (missing $OCI_KEY)"
  fi

  # Peer bundle is now shipped inside the APK (plugin assets/nodejs-project/).
  # No separate OCI upload needed — the mobile APK is self-contained.
fi

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
