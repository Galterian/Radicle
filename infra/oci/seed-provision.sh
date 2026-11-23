#!/usr/bin/env bash
# Runs ON a fresh Ubuntu 22.04/24.04 VM (OCI Ampere A1 or any amd64/arm64 box), as a sudo-capable user (OCI: ubuntu).
# Turns it into a chaosD6 Radicle seed set up like the live one (92-5-138-121.sslip.io, 2026-11-23):
#   - user `radicle`, rad + radicle-node (radicle.xyz/install) + radicle-httpd (files.radicle.xyz apt repo),
#     an unencrypted node identity (headless seed),
#   - radicle-node on 0.0.0.0:<GOSSIP_PORT> and radicle-httpd on 127.0.0.1:<HTTP_PORT>, systemd, Restart=always,
#   - the "private seed" policy (2026-11-18): peers dynamic (players' nodes may connect), seedingPolicy block
#     (replicate nothing by default) + `rad seed <rid> --scope all` for our repos only,
#   - all repos pinned in web.pinned.repositories (radicle-httpd /api/v1/repos lists them; phones read blobs there),
#   - the host firewall (OCI images REJECT all but :22 in iptables) opened for 80, 443, <GOSSIP_PORT>,
#   - caddy: Let's Encrypt TLS on <HOST>, routes /downloads/*, /pack/*, /rules/* (static, /var/www) and the catch-all
#     reverse proxy to radicle-httpd with CORS * — the same layout as infra/oci/seed.caddy, so llm-setup.sh and
#     profiles-setup.sh can insert their routes before the catch-all `handle {`,
#   - optionally fetches every repo from an UPSTREAM seed (the existing one) so it is a full mirror right away.
# Idempotent: re-running keeps the identity, merges config.json (keeps pins), and only rewrites caddy with FORCE_CADDY=1.
#
# Usually started from the workstation by infra/oci/new-seed.sh. By hand:
#   scp infra/oci/seed-provision.sh ubuntu@<ip>:/tmp/ && ssh ubuntu@<ip> 'bash /tmp/seed-provision.sh'
#
# Env (all optional):
#   HOST=<fqdn>                public hostname (default <ip-dashed>.sslip.io of the VM's public IP)
#   ALIAS=chaos-seed-<host>    node alias shown to peers
#   ACME_EMAIL=admin@sslip.io  Let's Encrypt account e-mail (must be a real-looking domain; .local is rejected)
#   GOSSIP_PORT=8776  HTTP_PORT=8080
#   RIDS="rad:… rad:…"         repos to seed (default: the 6 chaosD6 repos below)
#   UPSTREAM=<NID>@<host>:<port> | none   fetch the repos from this seed first (default: the live OCI seed)
#   FETCH_TIMEOUT=300sec       per-repo fetch timeout from UPSTREAM
#   FORCE_CADDY=1              rewrite /etc/caddy/sites/seed.caddy even if it exists (backup kept)
set -euo pipefail

# ------------------------------------------------------------------ parameters
# Code, Dimensions, Effects, Skills, Classes, Profiles (game/tools/oci/oci-seed-sync.sh NAME table)
DEFAULT_RIDS="rad:zqZmP6itceBMqYwi1K1n8phQqCaj rad:z2xbfJfwT3kukR73m8LXmmuvchEwr rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5 rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH"
RIDS="${RIDS:-$DEFAULT_RIDS}"
UPSTREAM="${UPSTREAM:-z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT@92-5-138-121.sslip.io:8776}"
GOSSIP_PORT="${GOSSIP_PORT:-8776}"
HTTP_PORT="${HTTP_PORT:-8080}"
ACME_EMAIL="${ACME_EMAIL:-admin@sslip.io}"
FETCH_TIMEOUT="${FETCH_TIMEOUT:-300sec}"
FORCE_CADDY="${FORCE_CADDY:-0}"
RH=/home/radicle/.radicle
CFG=$RH/config.json
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n== %s\n' "$*"; }
asrad() { sudo -u radicle -H env RAD_HOME=$RH HOME=/home/radicle PATH="$RH/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }
command -v sudo >/dev/null || { echo "sudo is required" >&2; exit 1; }

say "packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl ca-certificates jq git python3 gnupg debian-keyring debian-archive-keyring apt-transport-https iptables >/dev/null
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | sudo debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | sudo debconf-set-selections
sudo apt-get install -y -qq iptables-persistent >/dev/null || true

if [ -z "${HOST:-}" ]; then
  PUBLIC_IP="$(curl -sSf -m 10 https://api.ipify.org || curl -sSf -m 10 https://ifconfig.me)"
  HOST="$(echo "$PUBLIC_IP" | tr '.' '-').sslip.io"
fi
ALIAS="${ALIAS:-chaos-seed-${HOST%%.*}}"
echo "host $HOST  alias $ALIAS  gossip $GOSSIP_PORT  httpd 127.0.0.1:$HTTP_PORT  arch $(uname -m)"

say "user radicle + rad / radicle-node"
id radicle >/dev/null 2>&1 || sudo useradd -m -s /bin/bash radicle
if [ ! -x "$RH/bin/rad" ] || [ ! -x "$RH/bin/radicle-node" ]; then
  asrad bash -c 'curl -sSfL https://radicle.xyz/install | sh' | tail -3
fi
asrad rad --version

say "radicle-httpd (files.radicle.xyz apt repo)"
if ! command -v radicle-httpd >/dev/null 2>&1 && [ ! -x "$RH/bin/radicle-httpd" ]; then
  curl -sSfL -o /tmp/radicle-archive-keyring.deb https://files.radicle.xyz/apt/radicle-archive-keyring.deb
  sudo apt-get install -y -qq /tmp/radicle-archive-keyring.deb >/dev/null
  echo 'deb [signed-by=/usr/share/radicle/radicle-archive-keyring.asc] https://files.radicle.xyz/apt release main' \
    | sudo tee /etc/apt/sources.list.d/radicle.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq radicle-httpd >/dev/null
fi
if [ ! -x "$RH/bin/radicle-httpd" ]; then
  sudo -u radicle mkdir -p "$RH/bin"
  sudo ln -sf "$(command -v radicle-httpd)" "$RH/bin/radicle-httpd"
fi
"$RH/bin/radicle-httpd" --version 2>&1 | head -1 || true

say "node identity (unencrypted — headless seed)"
if [ ! -f "$RH/keys/radicle" ]; then
  asrad env RAD_PASSPHRASE='' rad auth --alias "$ALIAS"
fi
NID="$(asrad rad self --nid)"
echo "NID $NID"

say "config.json (private-seed policy, merged — existing pins kept)"
[ -f "$CFG" ] || echo '{}' | sudo -u radicle tee "$CFG" >/dev/null
sudo cp "$CFG" "$CFG.bak-$(date +%Y%m%dT%H%M%S)"
PINS_JSON="$(printf '%s\n' $RIDS | jq -R . | jq -s .)"
if [ "$UPSTREAM" != none ] && [ -n "$UPSTREAM" ]; then UP_JSON="[\"$UPSTREAM\"]"; else UP_JSON='[]'; fi
sudo jq --arg host "$HOST" --arg alias "$ALIAS" --arg port "$GOSSIP_PORT" --argjson pins "$PINS_JSON" --argjson up "$UP_JSON" '
    .publicExplorer = ("https://" + $host + "/nodes/$host/$rid$path")
  | .preferredSeeds = (.preferredSeeds // [])
  | .cli = (.cli // {hints: true})
  | .node = ((.node // {}) + {
      alias: $alias, listen: ["0.0.0.0:" + $port], externalAddresses: [$host + ":" + $port],
      peers: {type: "dynamic"}, network: "main", log: "INFO", relay: "auto", workers: 8,
      seedingPolicy: {default: "block"} })
  | .node.connect = (((.node.connect // []) + $up) | unique)   # permanent link to the upstream seed: its new refs keep arriving
  | .web = (.web // {}) | .web.pinned = (.web.pinned // {})
  | .web.pinned.repositories = (((.web.pinned.repositories // []) + $pins) | unique)
' "$CFG" > /tmp/seed-cfg.json
jq -e . /tmp/seed-cfg.json >/dev/null && sudo install -o radicle -g radicle -m 644 /tmp/seed-cfg.json "$CFG"
sudo jq -c '{node: (.node | {alias, listen, externalAddresses, peers, seedingPolicy}), pinned: .web.pinned.repositories}' "$CFG"
echo "$HOST" | sudo -u radicle tee /home/radicle/public-hostname.txt >/dev/null
echo "$NID"  | sudo -u radicle tee /home/radicle/node-nid.txt >/dev/null

say "systemd units"
sudo tee /etc/systemd/system/radicle-node.service >/dev/null <<EOF
[Unit]
Description=chaosD6 Radicle node (gossip)
After=network-online.target
Wants=network-online.target

[Service]
User=radicle
Group=radicle
Environment=RAD_HOME=$RH
Environment=PATH=$RH/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$RH/bin/radicle-node --listen 0.0.0.0:$GOSSIP_PORT
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
sudo tee /etc/systemd/system/radicle-httpd.service >/dev/null <<EOF
[Unit]
Description=chaosD6 Radicle HTTP API
After=network-online.target radicle-node.service
Wants=network-online.target

[Service]
User=radicle
Group=radicle
Environment=RAD_HOME=$RH
Environment=PATH=$RH/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$RH/bin/radicle-httpd --listen 127.0.0.1:$HTTP_PORT
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable -q radicle-node.service radicle-httpd.service
sudo systemctl restart radicle-node.service
sleep 4
sudo systemctl restart radicle-httpd.service

say "host firewall (iptables; the OCI security list must ALSO allow 80, 443, $GOSSIP_PORT — terraform does)"
for p in 80 443 "$GOSSIP_PORT"; do
  sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save >/dev/null 2>&1 || true
else sudo mkdir -p /etc/iptables && sudo iptables-save | sudo tee /etc/iptables/rules.v4 >/dev/null; fi

say "caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq caddy >/dev/null
fi
OWNER="${SUDO_USER:-$(id -un)}"   # new-seed.sh uploads rules / pack / APK as this user
sudo install -d -m 755 /var/www
sudo install -d -o "$OWNER" -g "$(id -gn "$OWNER")" -m 755 /var/www/downloads /var/www/pack /var/www/rules
sudo mkdir -p /etc/caddy/sites
# The global Caddyfile MUST import sites/*.caddy: a reload rebuilds caddy from it alone (2026-11-13 outage).
printf '{\n  email %s\n}\nimport /etc/caddy/sites/*.caddy\n' "$ACME_EMAIL" | sudo tee /etc/caddy/Caddyfile >/dev/null
SITE=/etc/caddy/sites/seed.caddy
if [ ! -f "$SITE" ] || [ "$FORCE_CADDY" = 1 ]; then
  [ -f "$SITE" ] && sudo cp "$SITE" "$SITE.bak-$(date +%Y%m%dT%H%M%S)"
  sudo tee "$SITE" >/dev/null <<CADDY
$HOST {
  @downloads path /downloads/*
  handle @downloads {
    root * /var/www
    header /downloads/*.apk Content-Type "application/vnd.android.package-archive"
    header /downloads/*.apk Content-Disposition "attachment; filename=chaosd6-release.apk"
    header /downloads/* >Access-Control-Allow-Origin "*"
    file_server browse
  }
  @pack path /pack/*
  handle @pack {
    uri strip_prefix /pack
    root * /var/www/pack
    file_server
    header >Access-Control-Allow-Origin "*"
    header >Cache-Control "public, max-age=86400, immutable"
  }
  # Rules editor (read-only public copy, built by game/tools/rules-site-build.mjs).
  redir /rules /rules/
  redir /rules.html /rules/
  @rules path /rules/*
  handle @rules {
    uri strip_prefix /rules
    root * /var/www/rules
    file_server {
      index rules.html
    }
    header >Access-Control-Allow-Origin "*"
    header >Cache-Control "no-cache"
  }
  handle {
    reverse_proxy 127.0.0.1:$HTTP_PORT
    header >Access-Control-Allow-Origin "*"
    header >Access-Control-Allow-Methods "GET, POST, OPTIONS"
    header >Access-Control-Allow-Headers "content-type"
  }
}
CADDY
else
  echo "$SITE exists — kept (FORCE_CADDY=1 rewrites it)"
fi
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1
sudo systemctl enable -q caddy
sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy

say "seed the repos (scope all, no fetch from the public network)"
for r in $RIDS; do asrad rad seed "$r" --scope all --no-fetch 2>&1 | tail -1 || echo "   seed $r failed"; done

if [ "$UPSTREAM" != none ] && [ -n "$UPSTREAM" ]; then
  UP_NID="${UPSTREAM%%@*}"
  say "fetch every repo from the upstream seed ${UP_NID:0:12}… only"
  asrad rad node connect "$UPSTREAM" --timeout 20s 2>&1 | tail -1 || true
  for r in $RIDS; do
    echo "-- $r"
    asrad rad sync --fetch "$r" --seed "$UP_NID" --timeout "$FETCH_TIMEOUT" 2>&1 | tail -2 || echo "   fetch failed — re-run later or announce from a desktop (rad sync --announce $r --seed $NID)"
  done
fi
sudo systemctl restart radicle-httpd.service
sleep 3

say "summary"
echo "services: $(systemctl is-active radicle-node radicle-httpd caddy | paste -sd' ')"
for r in $RIDS; do
  if [ -d "$RH/storage/${r#rad:}" ]; then st="in storage"; else st="NOT in storage yet"; fi
  printf '  %-38s %s\n' "$r" "$st"
done
echo "local api: $(curl -s -m 5 "http://127.0.0.1:$HTTP_PORT/api/v1" | head -c 120)"
sudo tee /home/radicle/seeder.json >/dev/null <<JSON
{
  "comment": "Written by infra/oci/seed-provision.sh",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "public_ip": "$(curl -s -m 5 https://api.ipify.org || true)",
  "hostname": "$HOST",
  "nid": "$NID",
  "alias": "$ALIAS",
  "gossip_port": $GOSSIP_PORT,
  "http_port": $HTTP_PORT,
  "api_base": "https://$HOST/",
  "radicle_version": "$(asrad rad --version | awk '{print $2}')",
  "preferred_seed_entry": "$NID@$HOST:$GOSSIP_PORT",
  "connect_entry": "$NID@$HOST:$GOSSIP_PORT",
  "seeding_rids": $PINS_JSON
}
JSON
sudo cat /home/radicle/seeder.json
echo
echo "SEED READY: $NID@$HOST:$GOSSIP_PORT   (https://$HOST/api/v1 once Let's Encrypt has issued the cert, ~1 min)"
