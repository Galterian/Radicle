#!/usr/bin/env bash
# The desktop node's llama-server (WSL Ubuntu) for the chaosD6 AI skirmish.
#
#   tools/llm/llm-desktop.sh install   # install-llama.sh into ~/.local/share/chaosd6-llm, then start
#   tools/llm/llm-desktop.sh start|stop|restart|status|logs
#
# 8 slots (one per bot of an AI skirmish: each keeps its cached system prompt). Runs as the systemd --user unit chaosd6-llm.service when WSL has systemd (it does here), else in the detached
# screen session "chaosd6-llm" (like start-host.sh). Loopback only: 127.0.0.1:${LLM_PORT:-8095} — the peers
# (game/peer.mjs, LLM_URL default http://127.0.0.1:8095) call it; nothing else needs to reach it.
# From Windows:  MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash /home/galt/<checkout>/tools/llm/llm-desktop.sh status
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export LLM_HOME="${LLM_HOME:-$HOME/.local/share/chaosd6-llm}"
PORT="${LLM_PORT:-8095}"
UNIT=chaosd6-llm.service
use_systemd() { systemctl --user show-environment >/dev/null 2>&1; }

write_unit() {
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/$UNIT" <<EOF
[Unit]
Description=chaosD6 llama-server (Qwen3-1.7B Q4_K_M, 127.0.0.1:$PORT)
After=network.target

[Service]
Environment=LLM_HOME=$LLM_HOME
Environment=LLM_PORT=$PORT
Environment=LLM_SLOTS=${LLM_SLOTS:-8}
${LLM_THREADS:+Environment=LLM_THREADS=$LLM_THREADS}
ExecStart=$LLM_HOME/bin/llama-run.sh
Restart=on-failure
RestartSec=5
Nice=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
}

wait_up() {
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then echo "llama-server up on 127.0.0.1:$PORT"; return 0; fi
    sleep 1
  done
  echo "!! llama-server did not answer /health on :$PORT within 60 s — see: $0 logs" >&2; return 1
}

start() {
  [ -x "$LLM_HOME/bin/llama-run.sh" ] || { echo "!! not installed — run: $0 install" >&2; exit 1; }
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then echo "already up on :$PORT"; return 0; fi
  if use_systemd; then write_unit; systemctl --user enable --now "$UNIT" >/dev/null 2>&1 || systemctl --user restart "$UNIT"
  else screen -dmS chaosd6-llm bash -c "'$LLM_HOME/bin/llama-run.sh' 2>&1 | tee /tmp/chaosd6-llm.log"; fi
  wait_up
}
stop() {
  if use_systemd && systemctl --user is-active --quiet "$UNIT"; then systemctl --user stop "$UNIT"; fi
  screen -S chaosd6-llm -X quit >/dev/null 2>&1 || true
  echo "stopped"
}

case "${1:-status}" in
  install) bash "$HERE/install-llama.sh"; start ;;
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status)
    if use_systemd; then systemctl --user --no-pager status "$UNIT" 2>/dev/null | head -5 || true; fi
    curl -fsS "http://127.0.0.1:$PORT/health" && echo || echo "down (:$PORT)" ;;
  logs) if use_systemd; then journalctl --user -u "$UNIT" -n 80 --no-pager; else tail -n 80 /tmp/chaosd6-llm.log; fi ;;
  *) echo "usage: $0 install|start|stop|restart|status|logs" >&2; exit 2 ;;
esac
