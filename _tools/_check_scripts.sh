#!/usr/bin/env bash
set -u
source /home/galt/godot-android/env.sh
cd "$(dirname "$0")/.."
for f in CameraRig.gd Game.gd HexMap.gd Hud.gd MobileInput.gd; do
  echo "== $f"
  godot4 --headless --path godot --check-only --script "scripts/$f" 2>&1 | tail -5
done
