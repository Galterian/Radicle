#!/usr/bin/env bash
# Stages peer.mjs + its minimal runtime dependencies into a working tree, then
# packs it as `_tools/_out/peer-pack.zip` (plus `peer-pack.zip.sha` sha256)
# for OCI lazy delivery.
#
# Design: we keep `game/` as the single source of truth. This script copies
# (not symlinks — the zip must be a self-contained tree) the subset peer.mjs
# actually imports plus a pruned production node_modules install, then zips
# the lot.
#
# The APK itself ships NO peer code. PeerBootstrap.gd downloads peer-pack.zip
# from https://92-5-138-121.sslip.io/pack/peer-pack.zip on first launch and
# extracts into user://peer/, where NodejsMobile.startNode consumes it via
# an absolute path. This keeps release APKs around ~90 MB instead of ~120 MB.
#
# The plugin's src/main/assets/nodejs-project/ is explicitly WIPED here so a
# subsequent `./gradlew assembleRelease` doesn't bake the peer back into the
# AAR by accident.
#
# Idempotent — re-runs replace both the staging area and the pack outputs.

set -euo pipefail
cd "$(dirname "$0")/.."

# Pick a modern node (needs BroadcastChannel + fetch for libp2p); matches
# _tools/_start-mobile-peer.sh's selection pattern.
for d in "$HOME"/.nvm/versions/node/v22.23.4/bin \
         "$HOME"/.nvm/versions/node/v22*/bin \
         "$HOME"/.nvm/versions/node/v20*/bin; do
    if [ -d "$d" ]; then PATH="$d:$PATH"; break; fi
done
echo "[stage] using node $(command -v node) ($(node -v))"

GAME_DIR="game"
# Stage directly into the plugin's assets dir — the AAR will embed it and the
# APK ships with a complete peer. Simpler and offline-friendly: no OCI
# download on first launch. The APK is mobile-only so the extra ~6 MB is
# only paid where it's actually used.
STAGE_DIR="godot/android/plugins/nodejs_mobile/src/main/assets/nodejs-project"

echo "[stage] wiping ${STAGE_DIR}"
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}"

# Everything peer.mjs reaches at import time, plus the data/ rulebook. The
# browser UI (game/css, game/html) is explicitly NOT bundled — the Godot client
# IS the UI on mobile and the embedded peer only speaks WebSocket.
# Include the browser UI files (index.html + css/ + js/) alongside the peer
# code so the on-device peer can serve them to the Android WebView. The
# desktop ui-server.mjs serves these same files from `game/` directly — this
# bundle is identical content, just a copy. sprites/ is still excluded (too
# big; AssetBootstrap downloads sprites lazily into user://assets/ and the
# served HTML will reference them via rewrites).
rsync -a --prune-empty-dirs \
    --include='*/' \
    --include='*.mjs' \
    --include='*.js' \
    --include='*.cjs' \
    --include='*.json' \
    --include='*.html' \
    --include='*.css' \
    --include='*.svg' \
    --exclude='node_modules/***' \
    --exclude='logs/***' \
    --exclude='radicle-work/***' \
    --exclude='radicle.git/***' \
    --exclude='sprites/***' \
    --exclude='tools/out/***' \
    --exclude='*' \
    "${GAME_DIR}/" "${STAGE_DIR}/"

# Copy data/ (JSON rulebook) and package.json into the nodejs-project root.
# peer.mjs resolves `data/*.json` relative to its own location, so data/ MUST
# live inside STAGE_DIR, not alongside it. The data/ directory in this repo
# lives at the repo root (../data from game/).
cp -r "${GAME_DIR}/package.json" "${STAGE_DIR}/package.json"
if [ -d "${GAME_DIR}/../data" ]; then
    rsync -a "${GAME_DIR}/../data/" "${STAGE_DIR}/data/"
fi
# Rules editor (2026-11-22): mobile-menu.mjs serves /rules/ from editor.html + editor/ (editor-api.mjs looks in the
# repo root first, then beside the game code — on the phone that is STAGE_DIR).
if [ -f "${GAME_DIR}/../editor.html" ]; then
    cp "${GAME_DIR}/../editor.html" "${STAGE_DIR}/editor.html"
    rsync -a --delete "${GAME_DIR}/../editor/" "${STAGE_DIR}/editor/"
fi

# Prune production node_modules into the staging area. We DO NOT reuse the
# dev-side node_modules (138 MB) or the committed package-lock.json: the
# lockfile pins some tarballs to artifactory.dowjones.io which 401s without
# auth. Install from package.json alone, overriding ~/.npmrc. The resulting
# tree may diverge slightly from desktop's locked versions — acceptable for
# the embedded peer, which runs the same source tree.
echo "[stage] installing production node_modules under ${STAGE_DIR}"
(cd "${STAGE_DIR}" && npm install \
    --omit=dev --omit=optional \
    --package-lock=false \
    --userconfig /dev/null \
    --registry https://registry.npmjs.org/ \
    --no-audit --no-fund)

echo "[stage] staged size:"
du -sh "${STAGE_DIR}"
echo "[stage] file counts:"
echo "  .mjs : $(find "${STAGE_DIR}" -name '*.mjs' -not -path '*/node_modules/*' | wc -l)"
echo "  .js  : $(find "${STAGE_DIR}" -name '*.js'  -not -path '*/node_modules/*' | wc -l)"
echo "  node_modules top-level: $(ls "${STAGE_DIR}/node_modules" 2>/dev/null | wc -l)"

echo "[stage] done. Next:"
echo "  1. Rebuild AAR (now includes the peer bundle in assets/nodejs-project/):"
echo "       cd godot/android/plugins/nodejs_mobile && ./gradlew assembleRelease"
echo "       cp build/outputs/aar/nodejs_mobile-release.aar ../nodejs_mobile.aar"
echo "  2. Build and deploy:"
echo "       bash _tools/build_and_deploy.sh --release"
