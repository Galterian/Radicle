#!/usr/bin/env bash
# Runs ON the OCI VM. SSHd there with `scp ... && bash remote-bootstrap.sh`.
# Idempotent — safe to re-run. Installs rad under /home/radicle, creates an
# unencrypted identity, pins the project RID, writes caddy site config, and
# restarts the systemd units.
set -euo pipefail

RID="${RID:-rad:zqZmP6itceBMqYwi1K1n8phQqCaj}"
ALIAS="${ALIAS:-chaos-oci-seed}"
GOSSIP_PORT="${GOSSIP_PORT:-8776}"
HTTP_PORT="${HTTP_PORT:-8080}"
FIREBASE_ORIGIN="${FIREBASE_ORIGIN:-https://dimensions-4e9ae.web.app}"

if ! id radicle >/dev/null 2>&1; then
  sudo useradd -m -s /bin/bash radicle
fi

PUBLIC_IP="$(curl -sSf https://api.ipify.org)"
EXT_HOST="$(echo "$PUBLIC_IP" | tr '.' '-').sslip.io"

# 1. Install rad as the radicle user (idempotent — the installer skips existing bins).
sudo -u radicle -H bash -lc '
  set -e
  export RAD_HOME=$HOME/.radicle
  export PATH=$RAD_HOME/bin:$PATH
  if [ ! -x "$RAD_HOME/bin/rad" ]; then
    curl -sSfL https://radicle.xyz/install | sh
  fi
  rad --version
'

# 2. Create identity if missing (empty passphrase for an unencrypted key).
sudo -u radicle -H bash -lc "
  set -e
  export RAD_HOME=\$HOME/.radicle
  export PATH=\$RAD_HOME/bin:\$PATH
  if [ ! -f \"\$RAD_HOME/keys/radicle\" ]; then
    RAD_PASSPHRASE='' rad auth --alias '$ALIAS'
  fi
  rad self --nid > \$HOME/node-nid.txt
"

# 3. Write node config (listen on all ports, seed everything, external advertise = sslip host).
sudo -u radicle -H bash -lc "
  set -e
  mkdir -p \$HOME/.radicle
  cat > \$HOME/.radicle/config.json <<JSON
{
  \"publicExplorer\": \"https://$EXT_HOST/nodes/\\\$host/\\\$rid\\\$path\",
  \"preferredSeeds\": [],
  \"cli\": { \"hints\": true },
  \"node\": {
    \"alias\": \"$ALIAS\",
    \"listen\": [\"0.0.0.0:$GOSSIP_PORT\"],
    \"externalAddresses\": [\"$EXT_HOST:$GOSSIP_PORT\"],
    \"peers\": { \"type\": \"dynamic\" },
    \"connect\": [],
    \"network\": \"main\",
    \"log\": \"INFO\",
    \"relay\": \"auto\",
    \"workers\": 8,
    \"seedingPolicy\": { \"default\": \"block\" }
  }
}
JSON
  echo '$EXT_HOST' > \$HOME/public-hostname.txt
"

# 4. caddy site: TLS termination on <ip>.sslip.io -> radicle-httpd.
sudo mkdir -p /etc/caddy/sites
sudo tee /etc/caddy/sites/seed.caddy >/dev/null <<CADDY
$EXT_HOST {
  reverse_proxy 127.0.0.1:$HTTP_PORT
  header Access-Control-Allow-Origin "$FIREBASE_ORIGIN"
  header Access-Control-Allow-Methods "GET, POST, OPTIONS"
  header Access-Control-Allow-Headers "content-type"
}
CADDY
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CAD'
{
  email admin@chaosd6.local
}
import /etc/caddy/sites/*.caddy
CAD

# 5. Seed the project RID (requires node running — start it first).
sudo systemctl daemon-reload
sudo systemctl restart radicle-node.service
sleep 3
sudo systemctl restart radicle-httpd.service
sudo systemctl reload caddy

sudo -u radicle -H bash -lc "
  export RAD_HOME=\$HOME/.radicle
  export PATH=\$RAD_HOME/bin:\$PATH
  rad seed '$RID' --scope all || true
"

echo
echo '===== seeder ready ====='
echo "hostname: $EXT_HOST"
echo -n "nid: "; sudo cat /home/radicle/node-nid.txt
echo "radicle-node: $(sudo systemctl is-active radicle-node.service)"
echo "radicle-httpd: $(sudo systemctl is-active radicle-httpd.service)"
echo "caddy: $(sudo systemctl is-active caddy)"
