#!/usr/bin/env bash
# Run on YOUR WORKSTATION (WSL). Adds the OCI seeder to ~/.radicle/config.json
# as a preferredSeed + node.connect entry, backs up the previous config,
# restarts the local Radicle node, then pushes the project RID to the OCI so
# the explorer there starts answering project queries.
#
#   infra/oci/wire-workstation.sh
#
# Reads the live roster from infra/oci/seeder.json (written at deploy time).

set -euo pipefail
export PATH="$HOME/.radicle/bin:$PATH"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROSTER="$HERE/seeder.json"

if [ ! -f "$ROSTER" ]; then
  echo "no $ROSTER — run terraform apply first" >&2
  exit 1
fi

NID=$(python3 -c "import json; print(json.load(open('$ROSTER'))['nid'])")
HOST=$(python3 -c "import json; print(json.load(open('$ROSTER'))['hostname'])")
PORT=$(python3 -c "import json; print(json.load(open('$ROSTER'))['gossip_port'])")
ALIAS=$(python3 -c "import json; print(json.load(open('$ROSTER'))['alias'])")
RID=$(python3 -c "import json; print(json.load(open('$ROSTER'))['seeding_rid'])")

PREF="${NID}@${HOST}:${PORT}"
CONN="${NID}@${HOST}:${PORT}"
CFG="$HOME/.radicle/config.json"
BAK="$CFG.bak-$(date -u +%Y-%m-%dT%H-%M-%S)"
cp "$CFG" "$BAK"

python3 - "$CFG" "$PREF" "$CONN" <<'PY'
import json, sys
cfg_path, pref, conn = sys.argv[1], sys.argv[2], sys.argv[3]
c = json.load(open(cfg_path))
c.setdefault("preferredSeeds", [])
c.setdefault("node", {}).setdefault("connect", [])
if pref not in c["preferredSeeds"]:
    c["preferredSeeds"].insert(0, pref)
if conn not in c["node"]["connect"]:
    c["node"]["connect"].insert(0, conn)
json.dump(c, open(cfg_path, "w"), indent=2)
print("[wire] preferredSeeds:", c["preferredSeeds"])
print("[wire] node.connect:",   c["node"]["connect"])
PY
echo "[wire] backup saved at $BAK"

echo "[wire] restarting local rad node"
rad node stop >/dev/null 2>&1 || true
sleep 1
rad node start >/dev/null 2>&1 || true
sleep 2
rad node status | head -3 || true

echo "[wire] pushing $RID to OCI via rad sync (announce + fetch)"
rad sync "$RID" --timeout 60sec --seed "$NID"
echo
echo "[wire] verifying OCI inventory"
sleep 3
curl -sS --max-time 10 "https://${HOST}/api/v1/stats"
echo
curl -sS --max-time 10 "https://${HOST}/api/v1/node/inventory"
echo
