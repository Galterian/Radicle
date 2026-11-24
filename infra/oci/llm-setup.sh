#!/usr/bin/env bash
# One-shot (idempotent) setup of the chaosD6 llama-server on the OCI seed (Ampere A1, aarch64):
#   - system user `chaosllm`, /opt/chaosd6-llm: llama-server (llama.cpp release / source build) + Qwen3-1.7B Q4_K_M
#     (tools/llm/install-llama.sh, sha256-pinned model),
#   - systemd unit chaosd6-llm.service on 127.0.0.1:8095 (8080 is radicle-httpd, 8090 profiles-push), Nice 10 and
#     a memory cap so radicle-node / radicle-httpd keep priority on the 2 OCPU / 12 GB shape,
#   - with --public only: an API key (/etc/chaosd6-llm/api-key) and the caddy route /llm/* → 127.0.0.1:8095, so peers
#     that cannot run a model (phones) use LLM_URL=https://<host>/llm LLM_KEY=<key>. Without --public nothing is
#     reachable from outside the VM.
#   - with --big: a SECOND server, Qwen3-8B Q4_K_M (5.0 GB, sha256-pinned), unit chaosd6-llm-big.service on
#     127.0.0.1:8096, 1 slot × 16384 ctx, LLM_BIG_THREADS (2) — effect generation (game/effect-gen.mjs), never the
#     bots' planning clock: Nice 15 + CPUWeight 20 so the 1.7B bot server (CPUWeight 100) wins the cores; MemoryMax 14G (9G thrashed: the mmap-ed 4.7 GB model + 16k KV + buffers sat at the cap → 1 tok/s, 2026-11-23). Needs the
#     4 OCPU / 24 GB shape (refuses below 20 GB). With --public too: route /llm-big/* (same API key).
#
# Usage (from WSL, repo root):  infra/oci/llm-setup.sh [--public] [--big]
#   SSH_KEY=~/.ssh/id_rsa  OCI_HOST=ubuntu@92.5.138.121  LLM_THREADS=2  LLM_SLOTS=2  LLM_BIG_THREADS=2
set -euo pipefail
cd "$(dirname "$0")/../.."
PUBLIC=0; BIG=0
for a in "$@"; do case "$a" in --public) PUBLIC=1 ;; --big) BIG=1 ;; *) echo "usage: $0 [--public] [--big]" >&2; exit 2 ;; esac; done
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
OCI_HOST="${OCI_HOST:-ubuntu@92.5.138.121}"
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

ssh "${SSH_OPTS[@]}" "$OCI_HOST" 'mkdir -p /tmp/chaosd6-llm'
scp "${SSH_OPTS[@]}" tools/llm/install-llama.sh tools/llm/llama-run.sh "$OCI_HOST:/tmp/chaosd6-llm/"

ssh "${SSH_OPTS[@]}" "$OCI_HOST" "PUBLIC=$PUBLIC BIG=$BIG LLM_THREADS=${LLM_THREADS:-2} LLM_SLOTS=${LLM_SLOTS:-2} LLM_BIG_THREADS=${LLM_BIG_THREADS:-2} bash -s" <<'REMOTE'
set -euo pipefail
echo "== $(hostname): $(uname -m), $(nproc) cpus, $(free -g | awk '/Mem:/{print $2}') GB"
MEM_GB="$(free -g | awk '/Mem:/{print $2}')"
if [ "$BIG" = 1 ] && [ "$MEM_GB" -lt 20 ]; then
  echo "!! --big needs the 4 OCPU / 24 GB shape (this VM has ${MEM_GB} GB): resize in the OCI console first" >&2; exit 1
fi

# 1. build tools (only needed when the release binary does not run on this glibc)
need=""; for p in build-essential git curl python3-pip; do dpkg -s "$p" >/dev/null 2>&1 || need="$need $p"; done
if [ -n "$need" ]; then sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need; fi

# 2. user + install
id chaosllm >/dev/null 2>&1 || sudo useradd --system --home-dir /opt/chaosd6-llm --shell /usr/sbin/nologin chaosllm
sudo install -d -o chaosllm -g chaosllm -m 755 /opt/chaosd6-llm
sudo chmod 755 /tmp/chaosd6-llm; sudo chmod 644 /tmp/chaosd6-llm/*.sh
sudo -u chaosllm -H env LLM_HOME=/opt/chaosd6-llm HOME=/opt/chaosd6-llm bash /tmp/chaosd6-llm/install-llama.sh
[ "$BIG" = 1 ] && sudo -u chaosllm -H env LLM_HOME=/opt/chaosd6-llm HOME=/opt/chaosd6-llm LLM_TIER=big bash /tmp/chaosd6-llm/install-llama.sh

# 3. API key (public only)
KEYLINE=""
if [ "$PUBLIC" = 1 ]; then
  sudo install -d -o root -g chaosllm -m 750 /etc/chaosd6-llm
  if ! sudo test -s /etc/chaosd6-llm/api-key; then
    head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40 | sudo tee /etc/chaosd6-llm/api-key >/dev/null
    sudo chown root:chaosllm /etc/chaosd6-llm/api-key; sudo chmod 640 /etc/chaosd6-llm/api-key
  fi
  KEYLINE="Environment=LLM_API_KEY_FILE=/etc/chaosd6-llm/api-key"
fi

# 4. service
sudo tee /etc/systemd/system/chaosd6-llm.service >/dev/null <<UNIT
[Unit]
Description=chaosD6 llama-server (Qwen3-1.7B Q4_K_M, 127.0.0.1:8095)
After=network.target

[Service]
User=chaosllm
Group=chaosllm
Environment=LLM_HOME=/opt/chaosd6-llm
Environment=LLM_PORT=8095
Environment=LLM_THREADS=$LLM_THREADS
Environment=LLM_SLOTS=$LLM_SLOTS
$KEYLINE
ExecStart=/opt/chaosd6-llm/bin/llama-run.sh
Restart=on-failure
RestartSec=5
Nice=10
CPUWeight=100
MemoryMax=4G
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/chaosd6-llm
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now chaosd6-llm.service
sudo systemctl restart chaosd6-llm.service
for _ in $(seq 1 90); do curl -fsS http://127.0.0.1:8095/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8095/health && echo " ← 127.0.0.1:8095/health" || { echo "!! llama-server not healthy"; sudo journalctl -u chaosd6-llm -n 40 --no-pager; exit 1; }

# 4b. the big server (--big): effect generation, low priority
if [ "$BIG" = 1 ]; then
sudo tee /etc/systemd/system/chaosd6-llm-big.service >/dev/null <<UNIT
[Unit]
Description=chaosD6 llama-server big (Qwen3-8B Q4_K_M, 127.0.0.1:8096, effect generation)
After=network.target chaosd6-llm.service

[Service]
User=chaosllm
Group=chaosllm
Environment=LLM_HOME=/opt/chaosd6-llm
Environment=LLM_TIER=big
Environment=LLM_PORT=8096
Environment=LLM_THREADS=$LLM_BIG_THREADS
Environment=LLM_SLOTS=1
$KEYLINE
ExecStart=/opt/chaosd6-llm/bin/llama-run.sh
Restart=on-failure
RestartSec=5
Nice=15
CPUWeight=20
MemoryMax=14G
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/chaosd6-llm
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now chaosd6-llm-big.service
sudo systemctl restart chaosd6-llm-big.service
for _ in $(seq 1 240); do curl -fsS http://127.0.0.1:8096/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8096/health && echo " ← 127.0.0.1:8096/health (8B)" || { echo "!! big llama-server not healthy"; sudo journalctl -u chaosd6-llm-big -n 40 --no-pager; exit 1; }
fi

# 5. caddy route (public only; inserted before the catch-all `handle {`, once — same guard as profiles-setup.sh)
if [ "$PUBLIC" = 1 ]; then
  SITE=/etc/caddy/sites/seed.caddy
  if ! sudo grep -q '^import /etc/caddy/sites/\*\.caddy' /etc/caddy/Caddyfile; then
    echo "!! /etc/caddy/Caddyfile does not import sites/*.caddy — not touching caddy (run infra/oci/restore-caddy.sh)" >&2; exit 1
  fi
  if grep -q '@chaosgate' "$SITE"; then echo "== caddy: /llm and /llm-big go through the gate (llm-gate-setup.sh) — not adding direct routes"; fi
  if ! grep -q 'handle_path /llm/\*' "$SITE" && ! grep -q '@chaosgate' "$SITE"; then
    sudo cp "$SITE" "$SITE.bak-llm"
    sudo python3 - "$SITE" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
block = """  # chaosD6 llama-server (infra/oci/llm-setup.sh): bots on phones, LLM_URL=https://<host>/llm + LLM_KEY.
  # llama-server checks the Bearer key itself (--api-key-file).
  handle_path /llm/* {
    request_body {
      max_size 64KB
    }
    reverse_proxy 127.0.0.1:8095
  }
"""
anchor = "\n  handle {\n"
assert s.count(anchor) == 1, "catch-all handle not found exactly once"
open(p, 'w').write(s.replace(anchor, "\n" + block + "  handle {\n"))
PY
    if ! sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
      sudo cp "$SITE.bak-llm" "$SITE"; echo "caddy validate failed, restored $SITE" >&2; exit 1
    fi
    sudo systemctl reload caddy
  fi
  if [ "$BIG" = 1 ] && ! grep -q 'handle_path /llm-big/\*' "$SITE" && ! grep -q '@chaosgate' "$SITE"; then
    sudo cp "$SITE" "$SITE.bak-llm-big"
    sudo python3 - "$SITE" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
block = """  # chaosD6 big llama-server (infra/oci/llm-setup.sh --big): effect generation, https://<host>/llm-big + LLM_KEY.
  handle_path /llm-big/* {
    request_body {
      max_size 256KB
    }
    reverse_proxy 127.0.0.1:8096 {
      transport http {
        read_timeout 15m
      }
    }
  }
"""
anchor = "\n  handle {\n"
assert s.count(anchor) == 1, "catch-all handle not found exactly once"
open(p, 'w').write(s.replace(anchor, "\n" + block + "  handle {\n"))
PY
    if ! sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
      sudo cp "$SITE.bak-llm-big" "$SITE"; echo "caddy validate failed, restored $SITE" >&2; exit 1
    fi
    sudo systemctl reload caddy
  fi
  HOST="$(grep -m1 -oE '^[a-z0-9.-]+\.sslip\.io' "$SITE" || hostname -f)"
  echo "== public: LLM_URL=https://$HOST/llm  LLM_KEY=$(sudo cat /etc/chaosd6-llm/api-key)"
  [ "$BIG" = 1 ] && echo "== public: LLM_BIG_URL=https://$HOST/llm-big  (same key)"
fi
echo "== chaosd6-llm.service: $(systemctl is-active chaosd6-llm)"
[ "$BIG" = 1 ] && echo "== chaosd6-llm-big.service: $(systemctl is-active chaosd6-llm-big)"
REMOTE
