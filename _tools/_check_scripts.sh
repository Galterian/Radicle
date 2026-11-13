#!/usr/bin/env bash
set -u
source /home/galt/godot-android/env.sh
cd "$(dirname "$0")/.."
for f in CameraRig.gd Game.gd HexMap.gd Hud.gd MobileInput.gd; do
  echo "== $f"
  "${GODOT:-$HOME/godot-android/4.5.2/Godot_v4.5.2-stable_linux.x86_64}" --headless --path godot --check-only --script "scripts/$f" 2>&1 | tail -5
done
