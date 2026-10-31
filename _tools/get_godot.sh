#!/usr/bin/env bash
# Fetch the Godot 4.3 Linux x86_64 editor binary into this folder (not committed; ~75 MB).
# Usage: ./_tools/get_godot.sh            -> _tools/godot
set -euo pipefail
cd "$(dirname "$0")"
VER="${GODOT_VERSION:-4.3-stable}"
ZIP="Godot_v${VER}_linux.x86_64.zip"
URL="https://github.com/godotengine/godot/releases/download/${VER}/${ZIP}"
if [ -x godot ]; then
  echo "godot already present: $(./godot --version 2>/dev/null || echo '?')"
  exit 0
fi
echo "downloading ${URL}"
curl -fL -o "${ZIP}" "${URL}"
unzip -o -q "${ZIP}"
mv "Godot_v${VER}_linux.x86_64" godot
chmod +x godot
rm -f "${ZIP}"
echo "ok: $(./godot --version)"
