#!/usr/bin/env bash
# One-shot (idempotent) setup of chaosD6-Profiles on the OCI seed:
#   - Node 20 (NodeSource) if the VM has no node >= 18,
#   - /home/radicle/profiles-work: a `rad init`ed repo "chaosD6-Profiles"
#     (OCI node = sole delegate, so its `git push rad` is canonical),
#     fast-forward-only, no deletes,
#   - /opt/chaosd6-profiles/{profiles-push.mjs,profile-auth.mjs} + systemd unit,
#   - the /profiles-push route in /etc/caddy/sites/seed.caddy (validated).
# Prints the RID and the delegate NID — the phone needs both:
#   RADICLE_PROFILES_RID=rad:…  PROFILES_NAMESPACE=<nid>
#
# Usage (from WSL, repo root):  infra/oci/profiles-setup.sh
#   SSH_KEY=~/.ssh/id_rsa  OCI_HOST=ubuntu@92.5.138.121
set -euo pipefail
cd "$(dirname "$0")/../.."
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
OCI_HOST="${OCI_HOST:-ubuntu@92.5.138.121}"
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

scp "${SSH_OPTS[@]}" infra/oci/profiles-push.mjs game/profile-auth.mjs infra/oci/profiles-push.service "$OCI_HOST:/tmp/"

ssh "${SSH_OPTS[@]}" "$OCI_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail

# 1. node
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "node $(node -v)"

# 2. the repo
sudo -u radicle -H bash -s <<'RAD'
set -euo pipefail
export PATH="$HOME/.radicle/bin:$PATH"
W="$HOME/profiles-work"
if [ ! -d "$W/.git" ]; then
  mkdir -p "$W" && cd "$W"
  git init -q -b main
  cat > README.md <<'MD'
# chaosD6-Profiles

One orphan branch per player: `profiles/<did:key id>`, holding `profile.json`.
Written only through the OCI push endpoint (signed by the player's key, fast-forward only).
Read with: `git clone --depth 1 --single-branch --branch profiles/<id> <seed>/<RID>.git`
MD
  git add README.md
  git -c user.name=chaosd6-oci -c user.email=oci@chaosd6 commit -qm "chaosD6-Profiles"
  rad init --name chaosD6-Profiles --description "chaosD6 player profiles" --default-branch main --public --no-confirm
fi
cd "$W"
git config receive.denyNonFastForwards true
git config receive.denyDeletes true
git config user.name chaosd6-oci
git config user.email oci@chaosd6
echo "RID: $(rad . 2>/dev/null || rad inspect)"
echo "NID: $(rad self --nid)"
RAD

# 3. service
sudo install -d -m 755 /opt/chaosd6-profiles
sudo install -m 644 /tmp/profiles-push.mjs /tmp/profile-auth.mjs /opt/chaosd6-profiles/
sudo install -m 644 /tmp/profiles-push.service /etc/systemd/system/profiles-push.service
sudo systemctl daemon-reload
sudo systemctl enable --now profiles-push.service
sudo systemctl restart profiles-push.service

# 4. caddy route (inserted before the catch-all `handle {`, once)
SITE=/etc/caddy/sites/seed.caddy
# A reload rebuilds Caddy from /etc/caddy/Caddyfile alone: if that does not
# import sites/*.caddy, reloading drops every route (2026-11-13 outage).
if ! sudo grep -q '^import /etc/caddy/sites/\*\.caddy' /etc/caddy/Caddyfile; then
  echo "!! /etc/caddy/Caddyfile does not import sites/*.caddy — not touching caddy (run infra/oci/restore-caddy.sh)" >&2
  exit 1
fi
if ! grep -q 'profiles-push' "$SITE"; then
  sudo cp "$SITE" "$SITE.bak-profiles"
  sudo python3 - "$SITE" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
block = """  # chaosD6-Profiles write endpoint (profiles-push.mjs; radicle-httpd is read-only).
  @profiles path /profiles-push /profiles-push/*
  handle @profiles {
    request_body {
      max_size 4MB
    }
    reverse_proxy 127.0.0.1:8090
  }
"""
anchor = "\n  handle {\n"
assert s.count(anchor) == 1, "catch-all handle not found exactly once"
open(p, 'w').write(s.replace(anchor, "\n" + block + "  handle {\n"))
PY
  if ! sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
    sudo cp "$SITE.bak-profiles" "$SITE"; echo "caddy validate failed, restored $SITE" >&2; exit 1
  fi
  sudo systemctl reload caddy
fi

# 5. pin the repo so radicle-httpd's /repos (default show=pinned) and the
#    explorer's node page list it — same edit as push-to-oci.sh phase 4.
RID=$(sudo -u radicle -H bash -c 'export PATH=$HOME/.radicle/bin:$PATH; cd ~/profiles-work && rad .')
CFG=/home/radicle/.radicle/config.json
if ! sudo -u radicle jq -e --arg r "$RID" '.web.pinned.repositories // [] | index($r)' "$CFG" >/dev/null 2>&1; then
  echo "pinning $RID"
  sudo -u radicle cp "$CFG" "$CFG.bak-profiles"
  sudo -u radicle bash -c "jq --arg r '$RID' '.web = (.web // {}) | .web.pinned = (.web.pinned // {}) | .web.pinned.repositories = ((.web.pinned.repositories // []) + [\$r] | unique)' $CFG > $CFG.new && mv $CFG.new $CFG"
  sudo systemctl restart radicle-httpd
  sleep 2
fi
echo "pinned: $(sudo -u radicle jq -c '.web.pinned.repositories' "$CFG")  httpd: $(systemctl is-active radicle-httpd)"

sleep 1
echo "service: $(systemctl is-active profiles-push) health: $(curl -s https://$(cat /home/radicle/public-hostname.txt)/profiles-push/health)"
REMOTE
