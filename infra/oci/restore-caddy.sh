#!/usr/bin/env bash
# Restore the OCI seed's Caddy config after the 2026-11-13 02:40 reload
# (profiles-setup.sh) loaded a bare /etc/caddy/Caddyfile that does not import
# /etc/caddy/sites/*.caddy: explorer CORS broke (doubled Allow-Origin) and
# /rules, /pack, /downloads, /profiles-push all went 404.
#
# Puts back the layout from install-httpd.sh ({ email } + import sites/*.caddy),
# validates, reloads, and rolls back to the backup if anything fails.
# Then checks every route from outside. Safe to re-run.
#
# Usage (from WSL, repo root):  bash infra/oci/restore-caddy.sh
set -euo pipefail
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
OCI_HOST="${OCI_HOST:-ubuntu@92.5.138.121}"
PUBLIC=https://92-5-138-121.sslip.io

ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$OCI_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
CF=/etc/caddy/Caddyfile
BAK="$CF.bak-$(date +%Y%m%dT%H%M%S)"
sudo cp "$CF" "$BAK"
echo "== current $CF (backed up to $BAK)"
sudo cat "$CF"; echo "== end"

if sudo grep -q '^import /etc/caddy/sites/\*\.caddy' "$CF"; then
  echo "Caddyfile already imports sites/*.caddy — not rewriting it"
else
  printf '{\n  email admin@sslip.io\n}\nimport /etc/caddy/sites/*.caddy\n' | sudo tee "$CF" >/dev/null
  echo "== rewrote $CF to import /etc/caddy/sites/*.caddy"
fi

if ! sudo caddy validate --config "$CF" --adapter caddyfile; then
  echo "!! validate failed — restoring $BAK, NOT reloading" >&2
  sudo cp "$BAK" "$CF"
  exit 1
fi
sudo systemctl reload caddy
sleep 2
if ! systemctl is-active --quiet caddy; then
  echo "!! caddy not active after reload — restoring $BAK" >&2
  sudo cp "$BAK" "$CF"; sudo systemctl restart caddy
  exit 1
fi
echo "== caddy reloaded"
echo "== profiles-push service: $(systemctl is-active profiles-push 2>/dev/null || true)"
echo "== local health: $(curl -s -m 5 127.0.0.1:8090/profiles-push/health || echo 'no answer')"
REMOTE

echo
echo "== checks from outside"
n=$(curl -s -m 15 -i "$PUBLIC/api/v1" | tr -d '\r' | grep -ci '^access-control-allow-origin' || true)
echo "Access-Control-Allow-Origin headers on /api/v1: $n  (want 1)"
for p in /api/v1/node /rules/ /pack/ /downloads/ /profiles-push/health; do
  printf '%-24s %s\n' "$p" "$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$PUBLIC$p")"
done
echo "(want 200 for each; /pack/ may be 404 if it has no index — check a real pack file)"
[ "$n" = 1 ] && echo "OK — hard-refresh the explorer (Ctrl+F5)" || echo "!! still not 1 — paste this output"
