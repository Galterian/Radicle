#!/usr/bin/env bash
# Install llama.cpp's llama-server + Qwen3-1.7B Q4_K_M for the chaosD6 AI skirmish (game/llm-brain.mjs).
# Runs ON the target box: the desktop node (WSL Ubuntu, x86_64) or the OCI seed (Ampere A1, aarch64).
# Idempotent: a second run only re-checks the binary and the model hash.
#
#   LLM_HOME      install dir            (default ~/.local/share/chaosd6-llm; the OCI setup uses /opt/chaosd6-llm)
#   LLAMA_TAG     llama.cpp release tag  (default b12626, 2026-11-22)
#   MODEL_URL / MODEL_SHA256             (default unsloth/Qwen3-1.7B-GGUF Q4_K_M, sha256 pinned below)
#
# Binary: the release tarball llama-<tag>-bin-ubuntu-<x64|arm64>.tar.gz (sha256 checked against the release's
# digest), else — no asset, or it does not run on this glibc — a CPU build from source (cmake via pip --user if
# missing). Layout: $LLM_HOME/bin/llama-server (+ its .so files, llama-run.sh), $LLM_HOME/models/*.gguf.
set -euo pipefail
LLM_HOME="${LLM_HOME:-$HOME/.local/share/chaosd6-llm}"
LLAMA_TAG="${LLAMA_TAG:-b12626}"
MODEL_URL="${MODEL_URL:-https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf}"
MODEL_SHA256="${MODEL_SHA256:-b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897}"
MODEL_FILE="$LLM_HOME/models/$(basename "${MODEL_URL%%\?*}")"
HERE="$(cd "$(dirname "$0")" && pwd)"

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "!! unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
mkdir -p "$LLM_HOME/bin" "$LLM_HOME/models" "$LLM_HOME/src"
echo "== chaosD6 llm: $(uname -m) ($ARCH), $(nproc) cpus, into $LLM_HOME"

server_runs() { LD_LIBRARY_PATH="$LLM_HOME/bin" "$LLM_HOME/bin/llama-server" --version >/dev/null 2>&1; }

try_prebuilt() {
  local asset="llama-${LLAMA_TAG}-bin-ubuntu-${ARCH}.tar.gz"
  local url="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${asset}"
  local tmp; tmp="$(mktemp -d)"
  echo "-- prebuilt: $asset"
  if ! curl -fsSL -o "$tmp/$asset" "$url"; then echo "   no such asset"; rm -rf "$tmp"; return 1; fi
  local want
  want="$(curl -fsSL "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${LLAMA_TAG}" 2>/dev/null \
    | python3 -c 'import json,sys; a=[x for x in json.load(sys.stdin).get("assets",[]) if x.get("name")==sys.argv[1]]; print((a[0].get("digest") or "").replace("sha256:","") if a else "")' "$asset" 2>/dev/null || true)"
  local got; got="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
  if [ -n "$want" ] && [ "$want" != "$got" ]; then echo "!! sha256 mismatch for $asset ($got, release says $want)" >&2; rm -rf "$tmp"; return 1; fi
  [ -n "$want" ] && echo "   sha256 ok ($got)" || echo "   (release lists no digest — sha256 $got)"
  tar -xzf "$tmp/$asset" -C "$tmp"
  local bin; bin="$(find "$tmp" -type f -name llama-server | head -1)"
  if [ -z "$bin" ]; then echo "   no llama-server in the tarball"; rm -rf "$tmp"; return 1; fi
  cp -a "$(dirname "$bin")"/. "$LLM_HOME/bin/"
  rm -rf "$tmp"
  if server_runs; then return 0; fi
  echo "   the prebuilt binary does not run here ($(ldd --version | head -1)) — building from source"
  return 1
}

build_source() {
  echo "-- source build of $LLAMA_TAG (CPU, native)"
  command -v g++ >/dev/null && command -v make >/dev/null && command -v git >/dev/null || { echo "!! need g++, make, git (sudo apt-get install -y build-essential git)" >&2; exit 1; }
  local CMAKE; CMAKE="$(command -v cmake || true)"
  if [ -z "$CMAKE" ]; then
    python3 -m pip install --user --quiet cmake
    CMAKE="$HOME/.local/bin/cmake"
  fi
  local src="$LLM_HOME/src/llama.cpp"
  if [ -d "$src/.git" ]; then git -C "$src" fetch -q --depth 1 origin tag "$LLAMA_TAG" && git -C "$src" checkout -q "$LLAMA_TAG"
  else git clone -q --depth 1 --branch "$LLAMA_TAG" https://github.com/ggml-org/llama.cpp "$src"; fi
  "$CMAKE" -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DBUILD_SHARED_LIBS=OFF -DLLAMA_CURL=OFF \
    -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF >/dev/null
  "$CMAKE" --build "$src/build" --config Release -j "$(nproc)" --target llama-server
  install -m 755 "$src/build/bin/llama-server" "$LLM_HOME/bin/llama-server"
  server_runs || { echo "!! the source build does not run either" >&2; exit 1; }
}

if [ -x "$LLM_HOME/bin/llama-server" ] && [ "$(cat "$LLM_HOME/bin/.tag" 2>/dev/null)" = "$LLAMA_TAG" ] && server_runs; then
  echo "-- llama-server $LLAMA_TAG already installed"
else
  try_prebuilt || build_source
  echo "$LLAMA_TAG" > "$LLM_HOME/bin/.tag"
fi
echo "   $(LD_LIBRARY_PATH="$LLM_HOME/bin" "$LLM_HOME/bin/llama-server" --version 2>&1 | grep -m1 -i version || echo '?')"
install -m 755 "$HERE/llama-run.sh" "$LLM_HOME/bin/llama-run.sh"

# The model (1.1 GB): resumable download, sha256 pinned.
if [ -f "$MODEL_FILE" ] && [ "$(sha256sum "$MODEL_FILE" | cut -d' ' -f1)" = "$MODEL_SHA256" ]; then
  echo "-- model $(basename "$MODEL_FILE") already in place (sha256 ok)"
else
  echo "-- model: $MODEL_URL"
  curl -fL --retry 3 -C - -o "$MODEL_FILE.part" "$MODEL_URL"
  got="$(sha256sum "$MODEL_FILE.part" | cut -d' ' -f1)"
  if [ "$got" != "$MODEL_SHA256" ]; then echo "!! model sha256 $got, expected $MODEL_SHA256 — kept as $MODEL_FILE.part" >&2; exit 1; fi
  mv "$MODEL_FILE.part" "$MODEL_FILE"
  echo "   sha256 ok"
fi
ln -sf "$(basename "$MODEL_FILE")" "$LLM_HOME/models/current.gguf"
echo "== done: $LLM_HOME/bin/llama-run.sh serves $(basename "$MODEL_FILE") on 127.0.0.1:\${LLM_PORT:-8095}"
