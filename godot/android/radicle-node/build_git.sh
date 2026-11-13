#!/usr/bin/env bash
# Cross-compiles `git` for Android arm64 and stages it as
# plugins/radicle_node/src/main/jniLibs/arm64-v8a/libgit.so.
#
# Why: radicle-node serves every fetch from this device (the OCI seed pulling
# our signed profile refs) by spawning `git upload-pack`
# (crates/radicle-node/src/worker/upload_pack.rs), and upload-pack spawns
# `git pack-objects`. Android has no git, so without this the seed's fetch is
# reset and saves fall back to HTTPS.
#
# Shipped as lib*.so so the installer extracts it into nativeLibraryDir — the
# one app location Android lets an app exec from (W^X: app-writable dirs are
# not executable for targetSdk >= 29). Needs extracted native libs
# (export preset gradle_build/compress_native_libraries=true). At run time
# RadicleNodeService symlinks <RAD_HOME>/bin/git -> libgit.so and puts that dir
# first on PATH, the only variable radicle-node passes to the child.
#
# Only the `git` binary is built (upload-pack and pack-objects are builtins);
# no curl/openssl/expat/perl/python/gettext/iconv.
#
# Usage: godot/android/radicle-node/build_git.sh   (WSL/Linux, NDK r25+)
#   GIT_VERSION=2.47.1 ANDROID_NDK_HOME=... MIN_SDK=24

set -euo pipefail
WORK="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$WORK/../../.." && pwd)"
GIT_VERSION="${GIT_VERSION:-2.47.1}"
MIN_SDK="${MIN_SDK:-24}"
SRC="$WORK/git-src/git-$GIT_VERSION"
OUT="$ROOT/godot/android/plugins/radicle_node/src/main/jniLibs/arm64-v8a"

: "${ANDROID_NDK_HOME:=${ANDROID_NDK:-}}"
if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -n "${ANDROID_HOME:-}" ]; then
  ANDROID_NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)"
fi
[ -d "${ANDROID_NDK_HOME:-}" ] || { echo "ANDROID_NDK_HOME not set and no NDK under ANDROID_HOME/ndk/" >&2; exit 1; }
TC="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"

# 1. Source.
if [ ! -f "$SRC/Makefile" ]; then
  mkdir -p "$WORK/git-src"
  curl -fL "https://mirrors.edge.kernel.org/pub/software/scm/git/git-$GIT_VERSION.tar.xz" -o "$WORK/git-src/git.tar.xz"
  tar -xJf "$WORK/git-src/git.tar.xz" -C "$WORK/git-src"
  rm "$WORK/git-src/git.tar.xz"
fi

# 2. Build. No ./configure: the Makefile's uname_* overrides + NO_* knobs are
#    the cross-compile path. bionic has pthreads/rt in libc; zlib is an NDK
#    system library. Paths baked in (prefix, /etc/gitconfig) don't exist on
#    the phone, which is what we want: no system config, exec path via PATH.
cd "$SRC"
make -j"$(nproc)" git \
  CC="$TC/aarch64-linux-android$MIN_SDK-clang" AR="$TC/llvm-ar" \
  CFLAGS="-O2 -fPIE -include $WORK/git-android-compat.h" \
  LDFLAGS="-pie -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384" \
  uname_S=Linux uname_M=aarch64 uname_O=Android uname_R=android \
  prefix=/nonexistent/chaosd6-git \
  NO_GETTEXT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1 NO_CURL=1 NO_EXPAT=1 \
  NO_OPENSSL=1 NO_ICONV=1 NO_INSTALL_HARDLINKS=1 NO_REGEX=NeedsStartEnd \
  PTHREAD_LIBS= NEEDS_LIBRT= HAVE_DEV_TTY=YesPlease \
  HAVE_SYNC_FILE_RANGE= CSPRNG_METHOD=   # sync_file_range / getrandom: bionic API 26 / 28 > MIN_SDK

# 3. Verify + stage.
if "$TC/llvm-readelf" -lW git | awk '$1 == "LOAD" { print $NF }' | grep -qv '^0x4000$'; then
  echo "git has LOAD segments not aligned to 0x4000" >&2; exit 1
fi
mkdir -p "$OUT"
"$TC/llvm-strip" --strip-unneeded -o "$OUT/libgit.so" git
echo "== staged $(du -h "$OUT/libgit.so" | cut -f1) $OUT/libgit.so (git $GIT_VERSION)"
"$TC/llvm-readelf" -d "$OUT/libgit.so" | grep NEEDED
