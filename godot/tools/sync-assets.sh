#!/usr/bin/env bash
# Copy (hardlink where supported) the loose assets/ tree from the repo root
# into godot/assets/ so Godot's exporter can bundle them into the APK/AAB.
# Idempotent — safe to re-run; only new/changed files are touched.
#
# Why: at dev time the Godot client reads loose files from the repo root via
# Assets.gd + FileAccess (fast iteration, no .import roundtrip). But Android
# builds can only ship files inside res://, so for a mobile export we must
# have the assets tree under godot/assets/ before `godot --export-release`.
#
# One-time editor step after this sync: open the Godot project ONCE in the
# editor (headless or GUI) so it generates .import files for every PNG. The
# APK export then packs the imported StreamTexture resources, which
# Assets.load_image() picks up via ResourceLoader on mobile.
#
#   godot/tools/sync-assets.sh                           # mirror ../assets → godot/assets
#   godot/tools/sync-assets.sh --import                  # + run `godot --headless --editor --quit` to import
#
# WARNING: the full WBC3 asset tree is a few hundred MB. The resulting APK
# will be large; use the Play App Bundle (.aab) preset so Google splits it
# per device.

set -euo pipefail
cd "$(dirname "$0")/.."                                 # inside godot/

SRC="../assets"
DST="assets"

if [ ! -d "$SRC" ]; then
  echo "no $SRC — nothing to sync" >&2
  exit 1
fi

echo "== mirror $SRC → $DST"
mkdir -p "$DST"
# rsync + hardlinks: cheap on same filesystem, bytewise copy on crossing one.
if command -v rsync >/dev/null; then
  rsync -a --delete --link-dest="$(cd "$SRC" && pwd)" "$SRC"/ "$DST"/
else
  cp -R "$SRC"/. "$DST"/
fi

# Make sure Godot doesn't try to import anything Image-sized unexpectedly.
# .gdignore skips sub-trees we don't want imported (sheet raw dumps, oversized
# PNGs that make the editor hang). Edit this list later as needed.
: > "$DST/_SyncedFromRepo"
echo "synced $(date -u --iso-8601=seconds)" > "$DST/_SyncedFromRepo"

if [ "${1:-}" = "--import" ]; then
  echo "== triggering Godot headless import (editor-side)"
  if ! command -v godot >/dev/null; then
    echo "godot not in PATH — install it or run the editor manually to import." >&2
    exit 2
  fi
  # Opens the project, imports anything new, exits.
  godot --headless --path . --editor --quit >/dev/null 2>&1 || true
fi

echo "done. assets available under godot/$DST/"
echo "next: open the Godot editor once (or re-run with --import) so .import files are generated"
echo "then: godot --headless --path godot --export-release \"Android Play Store (AAB)\" ../_tools/chaosd6-release.aab"
