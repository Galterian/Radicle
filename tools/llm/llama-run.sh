#!/usr/bin/env bash
# Foreground llama-server for the chaosD6 AI skirmish (installed into $LLM_HOME/bin by install-llama.sh; started by
# the systemd unit / screen session of llm-desktop.sh or infra/oci/llm-setup.sh).
#
#   LLM_HOME (dir of this script/..)  LLM_HOST 127.0.0.1  LLM_PORT 8095  LLM_SLOTS 4 (parallel requests)
#   LLM_THREADS (default: half the cpus, 2..8)  LLM_API_KEY_FILE (optional: require "Authorization: Bearer <key>")
#   LLM_TIER bot (default: models/current.gguf, alias qwen3-1.7b, 2048 ctx/slot) | big (models/big.gguf, alias
#   qwen3-8b, LLM_PORT 8096, 1 slot, 16384 ctx: effect generation — a definition + its JsonLogic and the retry errors)
#
# One slot per concurrent bot request; 2048 context tokens per slot is ~8× what a planning prompt needs. Qwen3's
# thinking is off (--reasoning-budget 0; peer requests also send enable_thinking:false), the prompt cache is on.
set -euo pipefail
LLM_HOME="${LLM_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
LLM_HOST="${LLM_HOST:-127.0.0.1}"
LLM_TIER="${LLM_TIER:-bot}"
if [ "$LLM_TIER" = big ]; then MODEL=big.gguf; ALIAS=qwen3-8b; DEF_PORT=8096; DEF_SLOTS=1; CTX_SLOT="${LLM_CTX_SLOT:-16384}"
else MODEL=current.gguf; ALIAS=qwen3-1.7b; DEF_PORT=8095; DEF_SLOTS=4; CTX_SLOT="${LLM_CTX_SLOT:-2048}"; fi
LLM_PORT="${LLM_PORT:-$DEF_PORT}"
LLM_SLOTS="${LLM_SLOTS:-$DEF_SLOTS}"
cpus="$(nproc)"; t=$(( cpus / 2 )); [ "$t" -lt 2 ] && t=2; [ "$t" -gt 8 ] && t=8
LLM_THREADS="${LLM_THREADS:-$t}"
BIN="$LLM_HOME/bin/llama-server"
export LD_LIBRARY_PATH="$LLM_HOME/bin${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
HELP="$("$BIN" --help 2>&1 || true)"
has() { grep -q -- "$1" <<<"$HELP"; }
ARGS=(-m "$LLM_HOME/models/$MODEL" --host "$LLM_HOST" --port "$LLM_PORT"
      -c $(( LLM_SLOTS * CTX_SLOT )) -np "$LLM_SLOTS" -t "$LLM_THREADS" --alias "$ALIAS")
has '--jinja' && ARGS+=(--jinja)
has '--reasoning-budget' && ARGS+=(--reasoning-budget 0)
has '--no-webui' && ARGS+=(--no-webui)
has '--cont-batching' && ARGS+=(--cont-batching)
# Host-RAM prompt cache: llama.cpp defaults to 8192 MiB, which grew the desktop server to 7.6 GB RSS and pushed a 16 GB
# box into swap (2026-11-23: disk 100 %, the game hung). The per-slot KV cache already keeps each bot's system prompt.
# Bot tier only: the big tier (effect/class generation) keeps llama.cpp's default so its ~6–7k-token system prompt
# survives between retries; LLM_CACHE_RAM overrides either tier.
if [ "$LLM_TIER" = big ]; then CACHE_RAM="${LLM_CACHE_RAM:-}"; else CACHE_RAM="${LLM_CACHE_RAM:-512}"; fi
[ -n "$CACHE_RAM" ] && has '--cache-ram' && ARGS+=(--cache-ram "$CACHE_RAM")
if [ -n "${LLM_API_KEY_FILE:-}" ]; then ARGS+=(--api-key-file "$LLM_API_KEY_FILE"); fi
echo "[llm] $BIN ${ARGS[*]}"
exec "$BIN" "${ARGS[@]}"
