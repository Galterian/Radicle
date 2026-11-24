#!/usr/bin/env bash
# One-shot (idempotent) setup of the chaosD6 LLM gatekeeper on the OCI seed (2026-11-23, user: "the other mobile users
# should not know the key"). infra/oci/llm-gate.mjs on 127.0.0.1:8098 becomes the one door to /llm, /llm-big and
# /gen-test: the master key (the user's desktop) or a device-signed request (game/oci-auth.mjs) by a device id that owns
# a team branch of chaosD6-Profiles (/home/radicle/profiles-work, the canonical refs profiles-push keeps). It forwards
# with the master key, so llama-server / gen-test keep checking the same key as before.
#   - code: llm-gate.mjs + game/oci-auth.mjs + game/profile-auth.mjs in /opt/chaosd6-llm-gate (node:* only),
#   - unit chaosd6-llm-gate.service, User=radicle (reads profiles-work) + group chaosllm (reads the key),
#   - caddy: the old /llm/*, /llm-big/* and @gentest blocks are REPLACED by one block → 127.0.0.1:8098 (path kept;
#     the gate strips /llm and /llm-big itself). Backup $SITE.bak-gate; validate fails → restored.
# Needs llm-setup.sh --public --big and gentest-setup.sh first. Re-run after llm-gate.mjs / oci-auth.mjs changes.
# After it: rotate the master key once (it was shared before): new key → /etc/chaosd6-llm/api-key, restart
# chaosd6-llm, chaosd6-llm-big, chaosd6-gentest, `systemctl kill -s HUP chaosd6-llm-gate`, put it in the desktop's llm.json.
#
# Usage (from WSL, repo root):  infra/oci/llm-gate-setup.sh            deploy / update
#                               infra/oci/llm-gate-setup.sh --undo     put the old caddy blocks back (gate stays installed)
#   SSH_KEY=~/.ssh/id_rsa  OCI_HOST=ubuntu@92.5.138.121
set -euo pipefail
cd "$(dirname "$0")/../.."
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
OCI_HOST="${OCI_HOST:-ubuntu@92.5.138.121}"
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
UNDO=0; [ "${1:-}" = "--undo" ] && UNDO=1

if [ "$UNDO" = 0 ]; then
  for f in infra/oci/llm-gate.mjs game/oci-auth.mjs game/profile-auth.mjs; do node --check "$f"; done
  scp "${SSH_OPTS[@]}" infra/oci/llm-gate.mjs game/oci-auth.mjs game/profile-auth.mjs "$OCI_HOST:/tmp/"
fi

ssh "${SSH_OPTS[@]}" "$OCI_HOST" "UNDO=$UNDO bash -s" <<'REMOTE'
set -euo pipefail
SITE=/etc/caddy/sites/seed.caddy
if [ "$UNDO" = 1 ]; then
  sudo test -f "$SITE.bak-gate" || { echo "!! no $SITE.bak-gate" >&2; exit 1; }
  sudo cp "$SITE.bak-gate" "$SITE"
  sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null && sudo systemctl reload caddy
  echo "== caddy back to the direct /llm, /llm-big, /gen-test routes (Bearer key only)"; exit 0
fi
if ! sudo test -s /etc/chaosd6-llm/api-key; then echo "!! no /etc/chaosd6-llm/api-key — run infra/oci/llm-setup.sh --public --big first" >&2; exit 1; fi
if ! sudo test -d /home/radicle/profiles-work/.git; then echo "!! no /home/radicle/profiles-work — run infra/oci/profiles-setup.sh first" >&2; exit 1; fi

# 1. code
N=/usr/bin; [ -x /opt/chaosd6-node22/bin/node ] && N=/opt/chaosd6-node22/bin
sudo install -d -o root -g root -m 755 /opt/chaosd6-llm-gate
for f in llm-gate.mjs oci-auth.mjs profile-auth.mjs; do sudo install -o root -g root -m 644 "/tmp/$f" "/opt/chaosd6-llm-gate/$f"; rm -f "/tmp/$f"; done
"$N/node" --check /opt/chaosd6-llm-gate/llm-gate.mjs
sudo touch /etc/chaosd6-llm/devices.allow /etc/chaosd6-llm/devices.deny
sudo chown root:chaosllm /etc/chaosd6-llm/devices.allow /etc/chaosd6-llm/devices.deny
sudo chmod 640 /etc/chaosd6-llm/devices.allow /etc/chaosd6-llm/devices.deny

# 2. service
sudo tee /etc/systemd/system/chaosd6-llm-gate.service >/dev/null <<UNIT
[Unit]
Description=chaosD6 LLM gatekeeper (master key or team-owner device signature → llama / gen-test, 127.0.0.1:8098)
After=network.target chaosd6-llm.service chaosd6-llm-big.service chaosd6-gentest.service

[Service]
User=radicle
SupplementaryGroups=chaosllm
WorkingDirectory=/opt/chaosd6-llm-gate
Environment=PORT=8098
Environment=HOST=127.0.0.1
Environment=KEY_FILE=/etc/chaosd6-llm/api-key
Environment=PROFILES_REPO=/home/radicle/profiles-work
Environment=GIT_CONFIG_COUNT=1
Environment=GIT_CONFIG_KEY_0=safe.directory
Environment=GIT_CONFIG_VALUE_0=/home/radicle/profiles-work
ExecStart=$N/node /opt/chaosd6-llm-gate/llm-gate.mjs
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now chaosd6-llm-gate.service
sudo systemctl restart chaosd6-llm-gate.service
for _ in $(seq 1 20); do curl -fsS http://127.0.0.1:8098/llm/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8098/llm/health >/dev/null && echo "== gate → /llm/health ok" || { echo "!! gate not healthy — caddy untouched"; sudo journalctl -u chaosd6-llm-gate -n 40 --no-pager; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8098/llm/v1/chat/completions)
[ "$code" = 401 ] && echo "== gate refuses an unsigned request (401) ok" || { echo "!! unsigned request gave $code, expected 401 — caddy untouched"; exit 1; }
sudo journalctl -u chaosd6-llm-gate -n 5 --no-pager | grep -m1 'owners:' || true

# 3. caddy: one block to the gate instead of the three direct ones
if ! sudo grep -q '^import /etc/caddy/sites/\*\.caddy' /etc/caddy/Caddyfile; then
  echo "!! /etc/caddy/Caddyfile does not import sites/*.caddy — not touching caddy (run infra/oci/restore-caddy.sh)" >&2; exit 1
fi
if ! grep -q '@chaosgate' "$SITE"; then
  sudo cp "$SITE" "$SITE.bak-gate"
  sudo python3 - "$SITE" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
nl = chr(10)
# the old direct blocks (llm-setup.sh, gentest-setup.sh): their comment lines + the block up to its 2-space "  }"
for name, head in (("/llm", r"  handle_path /llm/\* \{"), ("/llm-big", r"  handle_path /llm-big/\* \{"),
                   ("@gentest", r"  @gentest path /gen-test /gen-test/\*\n  handle @gentest \{")):
    s, n = re.subn(r"(?:  # chaosD6[^\n]*\n(?:  #[^\n]*\n)*)?" + head + r".*?\n  \}\n\n?", "", s, count=1, flags=re.S)
    print(("removed old " if n else "no old ") + name + " block")
block = nl.join([
  "  # chaosD6 LLM gate (infra/oci/llm-gate-setup.sh): /llm, /llm-big, /gen-test — the master key or a request signed",
  "  # by a team owner's device (game/oci-auth.mjs). The gate adds the key for llama-server / gen-test.",
  "  @chaosgate path /llm /llm/* /llm-big /llm-big/* /gen-test /gen-test/*",
  "  handle @chaosgate {",
  "    request_body {",
  "      max_size 512KB",
  "    }",
  "    reverse_proxy 127.0.0.1:8098 {",
  "      flush_interval -1",
  "      transport http {",
  "        read_timeout 65m",
  "      }",
  "    }",
  "  }",
  ""])
anchor = nl + "  handle {" + nl
assert s.count(anchor) == 1, "catch-all handle not found exactly once"
open(p, 'w').write(s.replace(anchor, nl + block + "  handle {" + nl))
PY
  if ! sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
    sudo cp "$SITE.bak-gate" "$SITE"; echo "caddy validate failed, restored $SITE" >&2; exit 1
  fi
  sudo systemctl reload caddy
fi
HOST="$(grep -m1 -oE '^[a-z0-9.-]+\.sslip\.io' "$SITE" || hostname -f)"
sleep 1
echo "== public https://$HOST/llm/health → $(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/llm/health")  (expect 200)"
echo "== public unsigned POST → $(curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' "https://$HOST/llm/v1/chat/completions")  (expect 401)"
echo "== chaosd6-llm-gate.service: $(systemctl is-active chaosd6-llm-gate)   log: sudo journalctl -u chaosd6-llm-gate -f"
REMOTE
