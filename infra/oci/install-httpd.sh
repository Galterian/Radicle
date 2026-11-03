#!/usr/bin/env bash
# Install radicle-httpd via the official Radicle apt repo, then fix Caddy's
# ACME email (invalid .local TLD rejected by Let's Encrypt), reload services.
set -euo pipefail

# 1. radicle archive keyring.
curl -sSfL -o /tmp/radicle-archive-keyring.deb https://files.radicle.xyz/apt/radicle-archive-keyring.deb
sudo apt-get install -y /tmp/radicle-archive-keyring.deb

# 2. apt sources.
sudo tee /etc/apt/sources.list.d/radicle.list >/dev/null <<'EOF'
deb [signed-by=/usr/share/radicle/radicle-archive-keyring.asc] https://files.radicle.xyz/apt release main
EOF

# 3. radicle-httpd.
sudo apt-get update -y
sudo apt-get install -y radicle-httpd

# 4. The apt package puts the binary in /usr/bin/radicle-httpd. Our systemd
#    unit expects it at /home/radicle/.radicle/bin/. Symlink.
sudo -u radicle mkdir -p /home/radicle/.radicle/bin
sudo ln -sf /usr/bin/radicle-httpd /home/radicle/.radicle/bin/radicle-httpd

# 5. Fix Caddy's ACME email — admin@chaosd6.local was rejected by Let's
#    Encrypt (invalid TLD). Use a .io email so account registration works.
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
{
  email admin@sslip.io
}
import /etc/caddy/sites/*.caddy
EOF

sudo systemctl restart radicle-httpd.service
sudo systemctl reload caddy

echo "===== after fix ====="
systemctl is-active radicle-node radicle-httpd caddy
echo "radicle-httpd:"
which radicle-httpd
radicle-httpd --version 2>&1 | head -1 || true
