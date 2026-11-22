#!/usr/bin/env bash
# Foreground llama-server for the chaosD6 AI skirmish (installed into $LLM_HOME/bin by install-llama.sh; started by
# the systemd unit / screen session of llm-desktop.sh or infra/oci/llm-setup.sh).
#
#   LLM_HOME (dir of this script/..)  LLM_HOST 127.0.0.1  LLM_PORT 8095  LLM_SLOTS 4 (parallel requests)
#   LLM_THREADS (default: half the cpus, 2..8)  LLM_API_KEY_FILE (optional: require "Authorization: Bearer <key>")
#
# One slot per concurrent bot request; 2048 context tokens per slot is ~8× what a planning prompt needs. Qwen3's
# thinking is off (--reasoning-budget 0; peer requests also send enable_thinking:false), the prompt cache is on.
set -euo pipefail
LLM_HOME="${LLM_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
LLM_HOST="${LLM_HOST:-127.0.0.1}"
LLM_PORT="${LLM_PORT:-8095}"
LLM_SLOTS="${LLM_SLOTS:-4}"
cpus="$(nproc)"; t=$(( cpus / 2 )); [ "$t" -lt 2 ] && t=2; [ "$t" -gt 8 ] && t=8
LLM_THREADS="${LLM_THREADS:-$t}"
BIN="$LLM_HOME/bin/llama-server"
export LD_LIBRARY_PATH="$LLM_HOME/bin${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
HELP="$("$BIN" --help 2>&1 || true)"
has() { grep -q -- "$1" <<<"$HELP"; }
ARGS=(-m "$LLM_HOME/models/current.gguf" --host "$LLM_HOST" --port "$LLM_PORT"
      -c $(( LLM_SLOTS * 2048 )) -np "$LLM_SLOTS" -t "$LLM_THREADS" --alias qwen3-1.7b)
has '--jinja' && ARGS+=(--jinja)
has '--reasoning-budget' && ARGS+=(--reasoning-budget 0)
has '--no-webui' && ARGS+=(--no-webui)
has '--cont-batching' && ARGS+=(--cont-batching)
if [ -n "${LLM_API_KEY_FILE:-}" ]; then ARGS+=(--api-key-file "$LLM_API_KEY_FILE"); fi
echo "[llm] $BIN ${ARGS[*]}"
exec "$BIN" "${ARGS[@]}"
