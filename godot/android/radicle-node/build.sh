#!/usr/bin/env bash
# Cross-compile radicle-node for aarch64-linux-android and drop the artifact
# where Godot's gradle build will bundle it into the APK/AAB.
#
# Target: aarch64-linux-android (arm64-v8a) — matches the only arch our Play
# Store preset ships. Output: godot/android/build/libs/arm64-v8a/libradicle-node.so
# (the `lib*.so` name is what Android's packager extracts to the app's native
# library dir with extractNativeLibs=true; it is a plain ELF executable despite
# the suffix.)
#
# Prereqs (install once):
#   - Android NDK r26+        (ANDROID_NDK_HOME env or ANDROID_HOME/ndk/<ver>)
#   - rustup                  https://rustup.rs
#   - rustup target add aarch64-linux-android
#   - cargo install cargo-ndk
#   - git
#
# One-shot:
#   godot/android/radicle-node/build.sh
#   godot/android/radicle-node/build.sh --clean         # wipe & rebuild
#   godot/android/radicle-node/build.sh --tag 1.10.3    # pin radicle version
#
# NOT TESTED on this machine (needs NDK + ~500MB of Rust deps + 10-20min). The
# recipe below follows the published radicle-node Cargo workspace layout.
# When you run it, verify the output binary runs on your device (adb shell).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"              # chaosD6 repo root
WORK="$ROOT/godot/android/radicle-node"
SRC="$WORK/src"
OUT="$ROOT/godot/android/build/libs/arm64-v8a"
RADICLE_TAG="${RADICLE_TAG:-v1.10.3}"
TARGET="aarch64-linux-android"
MIN_SDK="${MIN_SDK:-24}"

CLEAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --clean) CLEAN=1 ;;
    --tag)   shift; RADICLE_TAG="$1" ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$CLEAN" = "1" ]; then
  rm -rf "$SRC" "$OUT"
fi

# 1. Toolchain checks.
if ! command -v rustup >/dev/null; then
  echo "rustup not found. Install from https://rustup.rs" >&2; exit 1
fi
if ! command -v cargo-ndk >/dev/null; then
  echo "cargo-ndk not found. Run: cargo install cargo-ndk" >&2; exit 1
fi
rustup target add "$TARGET" >/dev/null

: "${ANDROID_NDK_HOME:=${ANDROID_NDK:-}}"
if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -n "${ANDROID_HOME:-}" ]; then
  # Pick the newest NDK installed next to the SDK.
  ANDROID_NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "${ANDROID_NDK_HOME:-}" ] || [ ! -d "$ANDROID_NDK_HOME" ]; then
  echo "ANDROID_NDK_HOME not set and no NDK found under ANDROID_HOME/ndk/." >&2
  exit 1
fi
export ANDROID_NDK_HOME

# 2. Fetch the Radicle (heartwood) source at the pinned tag.
if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$SRC"
  git clone --depth 1 --branch "$RADICLE_TAG" \
    https://seed.radicle.xyz/z3gqcJUoA1n9HaHKufZs5FCSGazv5.git "$SRC" \
    || git clone --depth 1 --branch "$RADICLE_TAG" \
       https://github.com/radicle-dev/heartwood.git "$SRC"
fi

# 3. OpenSSL / git2 need a C cross toolchain. cargo-ndk sets CC/AR for us. The
#    git2-sys crate used by radicle-node vendors libgit2 if libgit2-sys's
#    `vendored` feature is on — which it is by default in heartwood 1.x.
cd "$SRC"
mkdir -p "$OUT"

# radicle-node lives at crates/radicle-node (release 1.x). If the layout
# differs for a given tag, print the actual Cargo.toml path and bail.
NODE_CRATE="radicle-node"
if [ ! -f "crates/radicle-node/Cargo.toml" ]; then
  echo "WARNING: crates/radicle-node not at expected path for $RADICLE_TAG." >&2
  echo "Available crates:" >&2
  ls crates 2>/dev/null >&2 || true
  exit 1
fi

# 4. Build. cargo-ndk takes care of linker + sysroot wiring.
echo "== cross-compiling radicle-node $RADICLE_TAG for $TARGET (min-sdk $MIN_SDK)"
cargo ndk \
  --platform "$MIN_SDK" \
  --target "$TARGET" \
  -o "$OUT/.staging" \
  build --release -p "$NODE_CRATE"

# cargo-ndk writes the binary into .staging/arm64-v8a/radicle-node — we need
# it as libradicle-node.so in the final libs/arm64-v8a/ dir.
STAGED="$OUT/.staging/arm64-v8a/radicle-node"
if [ ! -f "$STAGED" ]; then
  echo "cargo-ndk did not produce $STAGED" >&2
  find "$OUT/.staging" -maxdepth 4 >&2
  exit 1
fi
mv "$STAGED" "$OUT/libradicle-node.so"
rm -rf "$OUT/.staging"

echo
echo "== built: $OUT/libradicle-node.so"
file "$OUT/libradicle-node.so" | head -1
du -h "$OUT/libradicle-node.so"
