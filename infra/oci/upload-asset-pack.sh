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

# Build the file lists from the manifest, honoring .bmp -> .png substitutions
# (identical rule as AssetBootstrap.gd resolve()). Media files may live in the
# chaosD6-Resources repo: they are looked up under the media root of
# tools/asset_root.py (CHAOSD6_ASSETS_DIR, else ./assets when it still holds the
# media, else the resources checkout) and listed relative to it in $MEDIALIST.
FILELIST=$(mktemp)
MEDIALIST=$(mktemp)
trap 'rm -f "$FILELIST" "$MEDIALIST"' EXIT
MEDIA_ROOT=$(python3 - "$MANIFEST" "$FILELIST" "$MEDIALIST" <<'PY'
import json, os, sys
sys.path.insert(0, "tools")
from asset_root import MEDIA_ROOT, CODE_ASSETS, media_path, is_media
m = json.load(open(sys.argv[1]))
code, media = open(sys.argv[2], "w"), open(sys.argv[3], "w")
split = os.path.abspath(MEDIA_ROOT) != os.path.abspath(CODE_ASSETS)
def emit(p):
    if split and p.startswith("assets/") and is_media(p):
        if os.path.exists(media_path(p)):
            media.write(p[len("assets/"):] + "\n"); return True
        return False
    if os.path.exists(p):
        code.write(p + "\n"); return True
    return False
for e in m["entries"]:
    p = e["path"]
    # If a .bmp is listed but we only have the .png on disk, upload the png
    # under both names so clients asking for either path find it.
    if p.endswith(".bmp") and not emit(p):
        emit(p[:-4] + ".png")
        continue
    emit(p)
print(MEDIA_ROOT)
PY
)

COUNT=$(( $(wc -l < "$FILELIST") + $(wc -l < "$MEDIALIST") ))
echo "[upload] media root: $MEDIA_ROOT ($(wc -l < "$MEDIALIST") files listed from there)"
echo "[upload] manifest files to send: $COUNT"
echo "[upload] destination: $HOST:$REMOTE"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "[upload] DRY_RUN=1 — sample:"
  head -10 "$FILELIST"
  head -5 "$MEDIALIST" | sed 's#^#assets/#'
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
if [[ -s $MEDIALIST ]]; then
  rsync -av --progress --relative --files-from="$MEDIALIST" \
    -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
    "$MEDIA_ROOT/" "$HOST:$REMOTE/assets/"
fi

echo "[upload] done. Sample URL to probe:"
SAMPLE=$(head -1 "$FILELIST"); [[ -n $SAMPLE ]] || SAMPLE="assets/$(head -1 "$MEDIALIST")"
echo "  https://92-5-138-121.sslip.io/pack/$SAMPLE"
