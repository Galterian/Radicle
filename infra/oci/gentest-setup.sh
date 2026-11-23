#!/usr/bin/env bash
# One-shot (idempotent) setup of the chaosD6 draft TEST service on the OCI seed (2026-11-23, user: "phone talks to OCI
# only"): a phone sends a generated effect draft, this VM plays it in a private Test Random game (game/tools/
# effect-gen-test.mjs — loopback only, no Door, no bus) and the 8B on 127.0.0.1:8096 writes the review.
#   - Node 22 of its own (/opt/chaosd6-node22, sha256-checked; the system node 20 that profiles-push uses is untouched —
#     the game needs Node 22: libp2p uses Promise.withResolvers),
#   - system user `chaosgen` (group chaosllm: reads /etc/chaosd6-llm/api-key), code in /opt/chaosd6-game
#     (game/ + data/ + assets/**/*.json from THIS checkout, node_modules included: pure JS),
#   - unit chaosd6-gentest.service on 127.0.0.1:8097 — ONE test at a time, Nice 15 + CPUWeight 30 (the bot model's
#     100 wins the cores), MemoryMax 3G,
#   - the caddy route /gen-test/* (same Bearer key as /llm and /llm-big; the server checks it).
# Needs llm-setup.sh --public --big first (the key file and the 8B).
# Re-run after game code changes: it re-copies the code and restarts the unit.
#
# Usage (from WSL, repo root):  infra/oci/gentest-setup.sh
#   SSH_KEY=~/.ssh/id_rsa  OCI_HOST=ubuntu@92.5.138.121  NODE_VER=22.23.4  GEN_TEST_MINUTES=3
set -euo pipefail
cd "$(dirname "$0")/../.."
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
OCI_HOST="${OCI_HOST:-ubuntu@92.5.138.121}"
NODE_VER="${NODE_VER:-22.23.4}"
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

# 1. the code bundle (no logs, sessions, local Radicle / Gun state, scratch)
BUNDLE="$(mktemp /tmp/chaosd6-game-XXXX.tgz)"
trap 'rm -f "$BUNDLE"' EXIT
tar czf "$BUNDLE" \
  --exclude='game/logs' --exclude='game/sessions' --exclude='game/saves' --exclude='game/radata' --exclude='game/gun-data' \
  --exclude='game/radicle-work' --exclude='game/radicle.git' --exclude='game/tools/out' --exclude='game/host.log' --exclude='game/host.pid' \
  --exclude='*.log' \
  game data $(find assets -name '*.json' 2>/dev/null)
echo "bundle: $(du -h "$BUNDLE" | cut -f1)"
scp "${SSH_OPTS[@]}" "$BUNDLE" "$OCI_HOST:/tmp/chaosd6-game.tgz"

ssh "${SSH_OPTS[@]}" "$OCI_HOST" "NODE_VER=$NODE_VER GEN_TEST_MINUTES=${GEN_TEST_MINUTES:-3} bash -s" <<'REMOTE'
set -euo pipefail
echo "== $(hostname): $(uname -m), $(nproc) cpus, $(free -g | awk '/Mem:/{print $2}') GB"
if ! sudo test -s /etc/chaosd6-llm/api-key; then echo "!! no /etc/chaosd6-llm/api-key — run infra/oci/llm-setup.sh --public --big first" >&2; exit 1; fi

# 1. Node 22 of its own
N=/opt/chaosd6-node22
if [ "$("$N/bin/node" -v 2>/dev/null || true)" != "v$NODE_VER" ]; then
  ARCH="$(uname -m)"; case "$ARCH" in aarch64) A=arm64 ;; x86_64) A=x64 ;; *) echo "unsupported arch $ARCH" >&2; exit 1 ;; esac
  T="$(mktemp -d)"; F="node-v$NODE_VER-linux-$A.tar.xz"
  curl -fsSL -o "$T/$F" "https://nodejs.org/dist/v$NODE_VER/$F"
  curl -fsSL -o "$T/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VER/SHASUMS256.txt"
  (cd "$T" && grep " $F\$" SHASUMS256.txt | sha256sum -c -)
  sudo rm -rf "$N"; sudo mkdir -p "$N"
  sudo tar xJf "$T/$F" -C "$N" --strip-components=1
  rm -rf "$T"
fi
echo "node $("$N/bin/node" -v) at $N"

# 2. user + code
id chaosgen >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/chaosd6-gentest --shell /usr/sbin/nologin chaosgen
getent group chaosllm >/dev/null && sudo usermod -aG chaosllm chaosgen
sudo install -d -o chaosgen -g chaosgen -m 750 /var/lib/chaosd6-gentest
sudo rm -rf /opt/chaosd6-game.new && sudo install -d -o chaosgen -g chaosgen -m 755 /opt/chaosd6-game.new
sudo tar xzf /tmp/chaosd6-game.tgz -C /opt/chaosd6-game.new
sudo chown -R chaosgen:chaosgen /opt/chaosd6-game.new
# keep the old run's logs out of the swap; then swap the code in one move
sudo systemctl stop chaosd6-gentest.service 2>/dev/null || true
sudo rm -rf /opt/chaosd6-game.old; [ -d /opt/chaosd6-game ] && sudo mv /opt/chaosd6-game /opt/chaosd6-game.old
sudo mv /opt/chaosd6-game.new /opt/chaosd6-game
sudo rm -rf /opt/chaosd6-game.old /tmp/chaosd6-game.tgz
sudo -u chaosgen "$N/bin/node" --check /opt/chaosd6-game/game/tools/gen-test-server.mjs

# 3. service
sudo tee /etc/systemd/system/chaosd6-gentest.service >/dev/null <<UNIT
[Unit]
Description=chaosD6 draft test service (private test games for generated effects, 127.0.0.1:8097)
After=network.target chaosd6-llm-big.service

[Service]
User=chaosgen
Group=chaosgen
SupplementaryGroups=chaosllm
WorkingDirectory=/opt/chaosd6-game/game
Environment=HOME=/var/lib/chaosd6-gentest
Environment=PATH=$N/bin:/usr/bin:/bin
Environment=PORT=8097
Environment=HOST=127.0.0.1
Environment=GEN_TEST_KEY_FILE=/etc/chaosd6-llm/api-key
Environment=GEN_TEST_DIR=/var/lib/chaosd6-gentest/srv
Environment=GEN_TEST_MINUTES=$GEN_TEST_MINUTES
Environment=GEN_TEST_PORT_BASE=7801
Environment=LLM_BIG_URL=http://127.0.0.1:8096
Environment=NOSTR_ENABLED=0
ExecStart=$N/bin/node /opt/chaosd6-game/game/tools/gen-test-server.mjs
Restart=on-failure
RestartSec=5
Nice=15
CPUWeight=30
MemoryMax=3G
TasksMax=512
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/chaosd6-game /var/lib/chaosd6-gentest
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now chaosd6-gentest.service
sudo systemctl restart chaosd6-gentest.service
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8097/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8097/health && echo " ← 127.0.0.1:8097/health" || { echo "!! gen-test not healthy"; sudo journalctl -u chaosd6-gentest -n 40 --no-pager; exit 1; }

# 4. caddy route /gen-test/* (inserted before the catch-all `handle {`, once — same guard as llm-setup.sh)
SITE=/etc/caddy/sites/seed.caddy
if ! sudo grep -q '^import /etc/caddy/sites/\*\.caddy' /etc/caddy/Caddyfile; then
  echo "!! /etc/caddy/Caddyfile does not import sites/*.caddy — not touching caddy (run infra/oci/restore-caddy.sh)" >&2; exit 1
fi
if ! grep -q 'path /gen-test /gen-test/\*' "$SITE"; then
  sudo cp "$SITE" "$SITE.bak-gentest"
  sudo python3 - "$SITE" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
nl = chr(10)
block = nl.join([
  "  # chaosD6 draft test service (infra/oci/gentest-setup.sh): phones test generated effects, Bearer = the LLM key.",
  "  @gentest path /gen-test /gen-test/*",
  "  handle @gentest {",
  "    request_body {",
  "      max_size 300KB",
  "    }",
  "    reverse_proxy 127.0.0.1:8097",
  "  }",
  ""])
anchor = nl + "  handle {" + nl
assert s.count(anchor) == 1, "catch-all handle not found exactly once"
open(p, 'w').write(s.replace(anchor, nl + block + "  handle {" + nl))
PY
  if ! sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
    sudo cp "$SITE.bak-gentest" "$SITE"; echo "caddy validate failed, restored $SITE" >&2; exit 1
  fi
  sudo systemctl reload caddy
fi
HOST="$(grep -m1 -oE '^[a-z0-9.-]+\.sslip\.io' "$SITE" || hostname -f)"
echo "== public: https://$HOST/gen-test  (same key as /llm-big)"
echo "== chaosd6-gentest.service: $(systemctl is-active chaosd6-gentest)"
REMOTE
