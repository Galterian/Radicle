#!/usr/bin/env bash
# Cross-compile radicle-node as an in-process JNI library (ffi/ →
# libradicle_node_ffi.so) for aarch64-linux-android and drop it into the
# radicle_node plugin's jniLibs, so it ships inside the plugin AAR.
#
# The node is loaded with System.loadLibrary and run on a thread inside
# RadicleNodeService (process ":radicle") — never exec()'d — so there is no
# executable in the APK and no useLegacyPackaging/extractNativeLibs needed.
#
# Linked with 16 KB max-page-size: Play rejects 4 KB-aligned native libs at
# targetSdk 35+. (NDK r28+ does this by default; the flag makes r26/r27 work.)
#
# Prereqs (install once):
#   - Android NDK r26+        (ANDROID_NDK_HOME env or ANDROID_HOME/ndk/<ver>)
#   - rustup                  https://rustup.rs  (heartwood needs Rust >= 1.88)
#   - rustup target add aarch64-linux-android
#   - cargo install cargo-ndk
#   - git
#
# One-shot:
#   godot/android/radicle-node/build.sh
#   godot/android/radicle-node/build.sh --clean                  # wipe & rebuild
#   godot/android/radicle-node/build.sh --tag releases/1.10.3    # pin radicle version
#
# NOT TESTED (needs NDK + ~500MB of Rust deps + 10-20min). After building,
# check alignment:  llvm-readelf -l <so> | grep LOAD   → Align 0x4000

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"           # chaosD6 repo root
WORK="$ROOT/godot/android/radicle-node"
SRC="$WORK/src"
OUT="$ROOT/godot/android/plugins/radicle_node/src/main/jniLibs"
# Heartwood tags are releases/X.Y.Z (not vX.Y.Z). 1.10.3 = commit 7e1cb406,
# same as the desktop rad/radicle-node.
RADICLE_TAG="${RADICLE_TAG:-releases/1.10.3}"
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
  rm -rf "$SRC" "$OUT/arm64-v8a/libradicle_node_ffi.so"
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

# 2. Fetch heartwood at the pinned tag. The canonical Radicle seed is current;
#    the GitHub mirror stopped at releases/1.9.1.
if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$SRC"
  git clone --depth 1 --branch "$RADICLE_TAG" \
    https://seed.radicle.xyz/z3gqcJUoA1n9HaHKufZs5FCSGazv5.git "$SRC"
fi
if [ ! -f "$SRC/crates/radicle-node/Cargo.toml" ]; then
  echo "crates/radicle-node not found in heartwood $RADICLE_TAG. Available crates:" >&2
  ls "$SRC/crates" >&2 || true
  exit 1
fi

# 3. Drop the wrapper into the workspace (members = crates/*) so it builds
#    against heartwood's Cargo.lock.
rm -rf "$SRC/crates/radicle-node-ffi"
cp -r "$WORK/ffi" "$SRC/crates/radicle-node-ffi"

# 4. Build. cargo-ndk wires linker + sysroot; git2 vendors libgit2 and sqlite
#    is bundled, so no system C libs are needed. heartwood pins its toolchain
#    (rust-toolchain file), so the Android target must be added to that one.
cd "$SRC"
rustup target add "$TARGET" >/dev/null
echo "== cross-compiling radicle-node-ffi ($RADICLE_TAG) for $TARGET (min-sdk $MIN_SDK)"
RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=16384" \
cargo ndk \
  --platform "$MIN_SDK" \
  --target "$TARGET" \
  -o "$OUT" \
  build --release -p radicle-node-ffi

SO="$OUT/arm64-v8a/libradicle_node_ffi.so"
if [ ! -f "$SO" ]; then
  echo "cargo-ndk did not produce $SO" >&2
  find "$OUT" -maxdepth 3 >&2
  exit 1
fi

echo
echo "== built: $SO"
file "$SO" | head -1
du -h "$SO"
