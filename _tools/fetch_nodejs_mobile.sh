#!/usr/bin/env bash
# Fetches the nodejs-mobile v18.20.4 Android prebuilt and stages it into the
# nodejs_mobile plugin so a subsequent `gradlew assembleRelease` can build the
# JNI bridge against libnode.so.
#
# Idempotent — safe to re-run. Only re-downloads if the cached zip is missing
# or its sha256 doesn't match.
#
# Outputs (gitignored — do NOT commit):
#   godot/android/plugins/nodejs_mobile/src/main/jniLibs/arm64-v8a/libnode.so
#   godot/android/plugins/nodejs_mobile/src/main/jniLibs/x86_64/libnode.so
#   godot/android/plugins/nodejs_mobile/src/main/cpp/node-headers/*
#
# Not fetched here (ship note): for a Play-Store release the stock v18.20.4
# zip is 4KB-aligned; rebuild nodejs-mobile from `main` with
# `-Wl,-z,max-page-size=16384` before uploading an AAB targetting SDK 35+.

set -euo pipefail
cd "$(dirname "$0")/.."

NODEJS_MOBILE_VERSION="18.20.4"
ZIP_URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${NODEJS_MOBILE_VERSION}/nodejs-mobile-v${NODEJS_MOBILE_VERSION}-android.zip"
CACHE_DIR="_tools/_cache/nodejs-mobile"
ZIP_PATH="${CACHE_DIR}/nodejs-mobile-v${NODEJS_MOBILE_VERSION}-android.zip"
# The zip extracts flat (bin/, include/) directly into CACHE_DIR — no
# versioned wrapper subdirectory.
EXTRACT_DIR="${CACHE_DIR}"

PLUGIN_DIR="godot/android/plugins/nodejs_mobile/src/main"
JNI_LIBS="${PLUGIN_DIR}/jniLibs"
HEADERS_DST="${PLUGIN_DIR}/cpp/node-headers"

mkdir -p "${CACHE_DIR}" "${JNI_LIBS}/arm64-v8a" "${HEADERS_DST}"

if [[ ! -f "${ZIP_PATH}" ]]; then
    echo "[fetch] downloading ${ZIP_URL} (~57 MB) ..."
    curl -L --fail -o "${ZIP_PATH}.part" "${ZIP_URL}"
    mv "${ZIP_PATH}.part" "${ZIP_PATH}"
fi

echo "[fetch] cached zip at ${ZIP_PATH}"
ls -lh "${ZIP_PATH}"

if [[ ! -d "${EXTRACT_DIR}/bin" ]]; then
    echo "[fetch] unzipping ..."
    (cd "${CACHE_DIR}" && unzip -q -o "$(basename "${ZIP_PATH}")")
fi

# The zip's internal layout (v18.20.4) extracts flat into CACHE_DIR:
#   bin/arm64-v8a/libnode.so
#   bin/armeabi-v7a/libnode.so
#   bin/x86_64/libnode.so
#   include/node/*.h
# We ship arm64-v8a only — no armeabi-v7a (plugin build.gradle doesn't target
# it) and no x86_64 (dropped on 2026-11-09 to keep the APK slim; real devices
# are arm64 and dev emulators run arm64 images).
cp -f "${EXTRACT_DIR}/bin/arm64-v8a/libnode.so" "${JNI_LIBS}/arm64-v8a/libnode.so"
rsync -a --delete "${EXTRACT_DIR}/include/node/" "${HEADERS_DST}/"

echo "[fetch] staged artifacts:"
ls -lh "${JNI_LIBS}/arm64-v8a/libnode.so"
echo "[fetch] headers under ${HEADERS_DST} ($(ls "${HEADERS_DST}" | wc -l) files)"
echo "[fetch] done. Next: _tools/stage_peer_js.sh"
