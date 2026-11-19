#!/usr/bin/env bash
# Provision an OCI (or any Ubuntu 22.04+) VM as a public read-only Radicle
# seed for chaosD6. Run as a sudo-capable user on the VM — NOT on your dev PC.
#
# What this installs & wires up:
#   - radicle-node + radicle-httpd (official binaries into /opt/radicle)
#   - a dedicated 'rad' system user owning /var/lib/radicle
#   - rad node listening on 0.0.0.0:8776 (libp2p gossip)
#   - radicle-httpd on 127.0.0.1:8080 (JSON API, loopback-only)
#   - caddy fronting :443 with Let's Encrypt → reverse-proxy to httpd
#   - systemd units (radicle-node.service, radicle-httpd.service) with Restart=always
#   - `rad seed rad:zqZmP6itceBMqYwi1K1n8phQqCaj` so the node fetches and holds the project
#   - ufw rules opening 22/tcp, 80/tcp, 443/tcp, 8776/tcp
#
# What this prints at the end (SAVE THESE):
#   NID        — the node's Base58 identity (goes into dev-PC env OCI_SEED_NID)
#   ADDR       — the public connect string <host>:8776
#   HTTPD URL  — https://<host>/api/v1/ (what config.json preferredSeeds should point to)
#
# Required env or args:
#   HOST=<public-hostname-or-ip-wrapped-in-sslip> — e.g. my-chaosd6.oci.example or 92-5-138-121.sslip.io
#   RID=rad:zqZmP6itceBMqYwi1K1n8phQqCaj         — chaosD6 project RID (default below)
#   ALIAS=chaosd6-oci                             — node alias shown in logs/registry
#
# Usage:
#   sudo HOST=my-chaosd6.oci.example bash provision.sh
#
# Idempotent: safe to re-run after a config change.

set -euo pipefail

HOST="${HOST:-}"
RID="${RID:-rad:zqZmP6itceBMqYwi1K1n8phQqCaj}"
ALIAS="${ALIAS:-chaosd6-oci}"
RAD_HOME="/var/lib/radicle"
RAD_BIN="/opt/radicle/bin"
RAD_VERSION="${RAD_VERSION:-1.10.3}"

if [[ $EUID -ne 0 ]]; then echo "run with sudo"; exit 1; fi
if [[ -z "$HOST" ]]; then
  echo "HOST=<public-hostname> is required. Examples:"
  echo "  sudo HOST=my-chaosd6.example.com bash provision.sh"
  echo "  sudo HOST=\$(curl -s ifconfig.me | tr . -).sslip.io bash provision.sh"
  exit 2
fi

echo "== installing packages"
apt-get update -y
apt-get install -y curl ca-certificates gnupg lsb-release jq git ufw

echo "== creating rad system user"
if ! id rad >/dev/null 2>&1; then
  useradd --system --home-dir "$RAD_HOME" --shell /usr/sbin/nologin --create-home rad
fi
install -d -o rad -g rad -m 0755 "$RAD_HOME" "$RAD_HOME/.radicle"

echo "== fetching radicle binaries ($RAD_VERSION, arch=$(dpkg --print-architecture))"
install -d "$RAD_BIN"
ARCH_DEB="$(dpkg --print-architecture)"
case "$ARCH_DEB" in
  amd64) RAD_TGT="x86_64-unknown-linux-musl" ;;
  arm64) RAD_TGT="aarch64-unknown-linux-musl" ;;
  *) echo "unsupported arch: $ARCH_DEB"; exit 3 ;;
esac
TARBALL="/tmp/radicle-${RAD_VERSION}.tar.xz"
# Official Radicle release — hosted at files.radicle.xyz. The URL path is
# stable across versions.
if [[ ! -x "$RAD_BIN/rad" ]]; then
  curl -fsSL "https://files.radicle.xyz/releases/${RAD_VERSION}/radicle-${RAD_VERSION}-${RAD_TGT}.tar.xz" -o "$TARBALL"
  tar -xJf "$TARBALL" -C /opt
  rm -rf "/opt/radicle" || true
  mv "/opt/radicle-${RAD_VERSION}-${RAD_TGT}" /opt/radicle
fi
install -m 0755 -t /usr/local/bin "$RAD_BIN/rad" "$RAD_BIN/radicle-node" "$RAD_BIN/radicle-httpd" "$RAD_BIN/git-remote-rad" || true

echo "== generating node key (if missing)"
if [[ ! -f "$RAD_HOME/.radicle/keys/radicle" ]]; then
  # `rad auth` prompts interactively — provide the passphrase (empty) via EOF.
  # The seed node runs headless; passphrase stays empty. For production you'd
  # want ssh-agent + a real passphrase.
  sudo -u rad -H env RAD_HOME="$RAD_HOME/.radicle" bash -c "
    cd '$RAD_HOME'
    yes '' | $RAD_BIN/rad auth --alias '$ALIAS'
  "
fi

NID=$(sudo -u rad -H env RAD_HOME="$RAD_HOME/.radicle" "$RAD_BIN/rad" self --nid)
echo "== node NID: $NID"

echo "== configuring rad node (listen on 0.0.0.0:8776, allow inbound)"
CFG="$RAD_HOME/.radicle/config.json"
# radicle-node reads config.json; patch listen + external-addresses with jq.
# "listen": ["0.0.0.0:8776"] makes the node accept inbound libp2p dials.
sudo -u rad -H bash -c "
  cd '$RAD_HOME/.radicle'
  if [[ ! -f config.json ]]; then echo '{}' > config.json; fi
  tmp=\$(mktemp)
  jq --arg host '$HOST' --arg alias '$ALIAS' '
    .node.alias = \$alias
    | .node.listen = [\"0.0.0.0:8776\"]
    | .node.externalAddresses = [\$host + \":8776\"]
    | .node.policy = \"allow\"
    | .node.scope = \"all\"
    | .node.seedingPolicy = { default: \"block\" }
    | .node.peers = { type: \"dynamic\" }   # a seed must accept players; privacy = block policy + rad seed only ours
    | .preferredSeeds = []
  ' config.json > \"\$tmp\" && mv \"\$tmp\" config.json
"
chown rad:rad "$CFG"

echo "== seeding the chaosD6 RID"
# `rad seed` writes the policy; the node then fetches as peers appear.
sudo -u rad -H env RAD_HOME="$RAD_HOME/.radicle" "$RAD_BIN/rad" seed "$RID" --scope all || true

echo "== writing systemd units"
cat > /etc/systemd/system/radicle-node.service <<EOF
[Unit]
Description=Radicle node (chaosD6 OCI seed)
After=network-online.target
Wants=network-online.target

[Service]
User=rad
Group=rad
Environment=RAD_HOME=$RAD_HOME/.radicle
ExecStart=/usr/local/bin/radicle-node --listen 0.0.0.0:8776
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/radicle-httpd.service <<EOF
[Unit]
Description=Radicle HTTP(d) JSON API (loopback only; caddy terminates TLS)
After=radicle-node.service
Requires=radicle-node.service

[Service]
User=rad
Group=rad
Environment=RAD_HOME=$RAD_HOME/.radicle
ExecStart=/usr/local/bin/radicle-httpd --listen 127.0.0.1:8080
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "== installing caddy for :443 TLS termination"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

cat > /etc/caddy/Caddyfile <<EOF
# chaosD6 OCI seed — public TLS front for radicle-httpd.
# The Radicle Explorer SPA (served from Firebase Hosting) hits this at
# /api/v1/* over https. CORS is permissive because the SPA is on a different
# origin (dimensions-4e9ae.web.app).
$HOST {
  encode zstd gzip
  header {
    Access-Control-Allow-Origin "*"
    Access-Control-Allow-Methods "GET, OPTIONS"
    Access-Control-Allow-Headers "Content-Type"
  }
  @options method OPTIONS
  respond @options 204
  reverse_proxy 127.0.0.1:8080
}
EOF

echo "== firewall"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8776/tcp
ufw --force enable

echo "== starting services"
systemctl daemon-reload
systemctl enable --now radicle-node.service
systemctl enable --now radicle-httpd.service
systemctl enable --now caddy

sleep 3
echo
echo "== status snapshot"
systemctl is-active radicle-node.service radicle-httpd.service caddy || true
ss -ltn | grep -E ':(443|8080|8776)\b' || true
echo

cat <<EOF
=========================================================================
PROVISIONING DONE. Save these values — the dev-PC wiring needs them.

  OCI_SEED_NID    = $NID
  OCI_SEED_ADDR   = $HOST:8776
  OCI_SEED_HTTPD  = https://$HOST
  RID             = $RID

Quick sanity checks (run from your laptop or phone):
  curl -sS https://$HOST/api/v1/                           # expect {"message":"Welcome!"...}
  curl -sS https://$HOST/api/v1/repos/$RID | head -c 400   # expect project detail
  rad node connect $NID@$HOST:8776                         # (from dev PC) should return OK

NEXT STEPS on your dev PC (not this VM):
  1. In the chaosD6 shell:
       export OCI_SEED_NID=$NID
       export OCI_SEED_ADDR=$HOST:8776
       export RADICLE_SEED=$HOST                           # the explorer URL seed
     Then \`node start-all.mjs\` as usual.
  2. From inside chaosD6/, apply the Firebase config:
       bash game/tools/oci/apply-firebase-config.sh $HOST
=========================================================================
EOF
