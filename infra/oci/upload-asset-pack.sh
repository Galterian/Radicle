#!/usr/bin/env bash
# Upload the asset pack referenced by godot/assets_manifest.json to OCI's
# /var/www/pack/, then signal caddy. Resumable (rsync) — safe to re-run.
#
# Why this exists: radicle-httpd/gitoxide can't stream the ~800 MB git pack
# containing all the WB3 assets, so the mobile first-launch flow pulls raw
# files via a plain caddy static-file route instead. See
# godot/scripts/AssetBootstrap.gd DELIVERY_MODE == "static".
#
# Usage:
#   bash infra/oci/upload-asset-pack.sh                 # upload every file in the manifest
#   DRY_RUN=1 bash infra/oci/upload-asset-pack.sh       # list what would upload, do nothing
#
# Requires:
#   - infra/oci/keys/oci_seeder (SSH private key)
#   - godot/assets_manifest.json (produced by tools/build-asset-manifest.mjs)

set -euo pipefail
cd "$(dirname "$0")/../.."

MANIFEST=godot/assets_manifest.json
KEY=infra/oci/keys/oci_seeder
HOST=ubuntu@92.5.138.121
REMOTE=/var/www/pack

[[ -f $MANIFEST ]] || { echo "missing $MANIFEST — run tools/build-asset-manifest.mjs first" >&2; exit 1; }
[[ -f $KEY ]] || { echo "missing SSH key $KEY" >&2; exit 1; }

# Build the file list from the manifest, honoring .bmp -> .png substitutions
# (identical rule as AssetBootstrap.gd resolve()).
FILELIST=$(mktemp)
trap 'rm -f "$FILELIST"' EXIT
python3 - "$MANIFEST" > "$FILELIST" <<'PY'
import json, os, sys
m = json.load(open(sys.argv[1]))
for e in m["entries"]:
    p = e["path"]
    # If a .bmp is listed but we only have the .png on disk, upload the png
    # under both names so clients asking for either path find it.
    if p.endswith(".bmp") and not os.path.exists(p):
        twin = p[:-4] + ".png"
        if os.path.exists(twin):
            print(twin)
            continue
    if os.path.exists(p):
        print(p)
PY

COUNT=$(wc -l < "$FILELIST")
echo "[upload] manifest files to send: $COUNT"
echo "[upload] destination: $HOST:$REMOTE"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "[upload] DRY_RUN=1 — sample:"
  head -10 "$FILELIST"
  exit 0
fi

# Ensure remote dir exists and is writable by the ubuntu user.
ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST" "sudo install -d -o ubuntu -g ubuntu $REMOTE"

# rsync: preserve paths, delete nothing on remote, resumable, show progress.
# --files-from reads the manifest list; paths are repo-relative so --relative
# recreates the directory tree on the remote side.
rsync -av --progress --relative --files-from="$FILELIST" \
  -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  ./ "$HOST:$REMOTE/"

echo "[upload] done. Sample URL to probe:"
SAMPLE=$(head -1 "$FILELIST")
echo "  https://92-5-138-121.sslip.io/pack/$SAMPLE"
