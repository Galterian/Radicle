#!/usr/bin/env bash
# Builds a 16 KB page-aligned libnode.so (nodejs-mobile, Node 18.20.4, arm64)
# from source and stages it into the nodejs_mobile plugin, replacing the 4 KB
# one _tools/fetch_nodejs_mobile.sh installs. Play rejects 4 KB-aligned native
# libs at targetSdk 35+, and upstream has not released a 16 KB build yet
# (nodejs-mobile issue #161), so this builds `main` at the commit that added
# the flag (d9552e0e, PR #154).
#
# Recipe from nodejs-mobile issue #161 (reported working on-device):
#   - host tools built with the NDK's clang: host g++ 12 ICEs on V8, and
#     android_configure.py hardcodes gcc/g++, so we patch it to honour CC_host
#   - LDFLAGS max/common-page-size=16384 (what upstream CI uses)
#
# Prereqs (WSL/Linux): Android NDK r24-r27 (upstream CI uses r24), python3,
# make, git, ~10 GB free disk, ~1-3 h. NOT r28+: its libc++ dropped the generic
# std::char_traits, which V8 10.2's inspector (String16 = basic_string<uint16_t>)
# needs. The 16 KB alignment comes from LDFLAGS, so an older NDK is fine; the
# APK's libc++_shared.so comes from Godot. Low-RAM hosts: keep JOBS small (V8
# OOMs at high -j).
#
# Usage:
#   _tools/fetch_nodejs_mobile.sh                  # once, for the headers
#   ANDROID_NDK_HOME=~/Android/Sdk/ndk/25.1.8937393 _tools/build_nodejs_mobile_16k.sh
#   JOBS=4 _tools/build_nodejs_mobile_16k.sh       # more parallelism if RAM allows
#
# NOT TESTED on this machine.

set -euo pipefail
cd "$(dirname "$0")/.."

NODEJS_MOBILE_COMMIT="${NODEJS_MOBILE_COMMIT:-d9552e0e}"
SDK_VERSION="${SDK_VERSION:-24}"          # matches plugin minSdk and upstream CI
JOBS="${JOBS:-2}"
SRC="_tools/_cache/nodejs-mobile-src"
DST="godot/android/plugins/nodejs_mobile/src/main/jniLibs/arm64-v8a"

: "${ANDROID_NDK_HOME:=${ANDROID_NDK:-}}"
if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -n "${ANDROID_HOME:-}" ]; then
  ANDROID_NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "${ANDROID_NDK_HOME:-}" ] || [ ! -d "$ANDROID_NDK_HOME" ]; then
  echo "ANDROID_NDK_HOME not set and no NDK found under ANDROID_HOME/ndk/." >&2
  exit 1
fi
NDK_BIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
NDK_MAJOR="$(sed -n 's/^Pkg.Revision *= *\([0-9]*\).*/\1/p' "$ANDROID_NDK_HOME/source.properties")"
if [ "${NDK_MAJOR:-0}" -ge 28 ]; then
  echo "NDK r$NDK_MAJOR at $ANDROID_NDK_HOME is too new for Node 18's V8 (see header); use r24-r27." >&2
  exit 1
fi

# 1. Source at the pinned commit.
if [ ! -d "$SRC/.git" ]; then
  git clone --filter=blob:none https://github.com/nodejs-mobile/nodejs-mobile.git "$SRC"
fi
git -C "$SRC" checkout -q "$NODEJS_MOBILE_COMMIT"

# 2. Let CC_host/CXX_host override the hardcoded gcc/g++ (issue #161 patch).
sed -i \
  -e "s/^os.environ\['CC_host'\] = /os.environ.setdefault('CC_host', /" \
  -e "s/^os.environ\['CXX_host'\] = /os.environ.setdefault('CXX_host', /" \
  -e "/setdefault('C\(XX\|C\)_host'/ s/\.strip()$/.strip())/" \
  "$SRC/android_configure.py"
grep -q "setdefault('CC_host'" "$SRC/android_configure.py" \
  || { echo "android_configure.py patch did not apply — check the CC_host lines" >&2; exit 1; }

# 3. Configure + build libnode only.
export CC_host="$NDK_BIN/clang" CXX_host="$NDK_BIN/clang++"
export LDFLAGS="${LDFLAGS:-} -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"
cd "$SRC"
./android-configure "$ANDROID_NDK_HOME" "$SDK_VERSION" arm64
make -C out BUILDTYPE=Release libnode -j"$JOBS"
cd - >/dev/null

# Same output lookup as upstream tools/android_build.sh.
SO=""
for f in "$SRC/out/Release/lib.target/libnode.so" "$SRC/out/Release/obj.target/libnode.so" "$SRC/out/Release/libnode.so"; do
  [ -f "$f" ] && { SO="$f"; break; }
done
[ -n "$SO" ] || { echo "libnode.so not found under $SRC/out/Release" >&2; exit 1; }

# 4. Verify every LOAD segment is 16 KB aligned before staging.
if "$NDK_BIN/llvm-readelf" -lW "$SO" | awk '$1 == "LOAD" { print $NF }' | grep -qv '^0x4000$'; then
  echo "$SO has LOAD segments not aligned to 0x4000:" >&2
  "$NDK_BIN/llvm-readelf" -lW "$SO" | grep LOAD >&2
  exit 1
fi

# 5. Strip (upstream prebuilt is stripped too) and stage.
mkdir -p "$DST"
"$NDK_BIN/llvm-strip" --strip-unneeded -o "$DST/libnode.so" "$SO"
echo "[build] staged 16 KB-aligned $(du -h "$DST/libnode.so" | cut -f1) $DST/libnode.so"
