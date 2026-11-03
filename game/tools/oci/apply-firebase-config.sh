#!/usr/bin/env bash
# Update firebase/public/radicle/config.json preferredSeeds[0] to the given
# hostname (default: 92-5-138-121.sslip.io) and deploy Firebase Hosting.
# Run from the chaosD6 repo root.
set -euo pipefail
HOST="${1:-92-5-138-121.sslip.io}"
CFG="firebase/public/radicle/config.json"
[[ -f "$CFG" ]] || { echo "run from repo root"; exit 1; }

tmp=$(mktemp)
jq --arg host "$HOST" '
  .preferredSeeds = [
    { hostname: $host, port: 443,  scheme: "https" },
    { hostname: "localhost", port: 8080, scheme: "http" }
  ]
  | .nodes.defaultHttpdPort   = 443
  | .nodes.defaultHttpdScheme = "https"
' "$CFG" > "$tmp" && mv "$tmp" "$CFG"

[[ -x "$HOME/.nvm/versions/node/v22.23.3/bin/firebase" ]] \
  && export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"
[[ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" && -f "$HOME/.firebase-dimensions-sa.json" ]] \
  && export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.firebase-dimensions-sa.json"

(cd firebase && firebase deploy --only hosting --project dimensions-4e9ae)
