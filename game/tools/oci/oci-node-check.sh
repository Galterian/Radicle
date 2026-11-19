#!/usr/bin/env bash
# Runs ON the OCI seed (as user ubuntu, uses sudo). Diagnoses why the seed drops our nodes and, with --fix,
# puts the seed in the "private seed" setup (2026-11-18):
#   peers dynamic         — a seed must ACCEPT our players' nodes (static = only its own connect list)
#   seedingPolicy block   — replicate nothing by default ...
#   rad seed <our RIDs>   — ... except our 6 repos (no fetch from the network while doing it)
# Real privacy comes from making the repos private (game/tools/out/_privfix_B_effects.sh), not from this.
#
# From WSL (check only, then fix):
#   ssh -i ~/.ssh/id_rsa -o IdentitiesOnly=yes ubuntu@92-5-138-121.sslip.io 'bash -s' < game/tools/oci/oci-node-check.sh
#   ssh -i ~/.ssh/id_rsa -o IdentitiesOnly=yes ubuntu@92-5-138-121.sslip.io 'bash -s -- --fix' < game/tools/oci/oci-node-check.sh
set -u
FIX=0; [ "${1:-}" = "--fix" ] && FIX=1
RH=/home/radicle/.radicle
CFG=$RH/config.json
DESKTOP=z6Mkrh3gkVD8E4cJgibm1NDmStUCJuVASwmtq9C1Juvag6yy
PHONE=z6MkpdT8tvqUtLccmpR9HX2NE6ZK7rGSfXQqTCuGBLJs1tig
RIDS="rad:zqZmP6itceBMqYwi1K1n8phQqCaj rad:z2xbfJfwT3kukR73m8LXmmuvchEwr rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5 rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH"
RAD=$(sudo -u radicle bash -lc 'command -v rad' 2>/dev/null); [ -z "$RAD" ] && RAD=$RH/bin/rad
asrad() { sudo -u radicle env RAD_HOME=$RH HOME=/home/radicle "$@"; }

echo "== services"; systemctl is-active radicle-node radicle-httpd caddy 2>&1 | paste -sd' '
echo "== config (node part)"
sudo jq '.node | {peers, seedingPolicy, connect, listen, limits: (.limits // null | if . then {connection, rate} else null end)}' $CFG
echo "== node status"; asrad $RAD node status 2>&1 | head -20
echo "== log since 16:00 about our desktop / phone / rejects"
sudo journalctl -u radicle-node --since "today 16:00" --no-pager 2>/dev/null \
  | grep -iE "${DESKTOP:0:16}|${PHONE:0:16}|reject|refus|limit|ban|disconnect" | tail -25 | cut -c1-220
echo "== seeding policies"; asrad $RAD seed 2>&1 | head -15

[ $FIX = 1 ] || { echo; echo "check only — re-run with --fix to apply: peers dynamic, seedingPolicy block, seed our 6 RIDs, restart radicle-node"; exit 0; }

echo; echo "== FIX"
sudo cp $CFG $CFG.bak-$(date +%Y%m%dT%H%M%S)
sudo jq '.node.peers = {type:"dynamic"} | .node.seedingPolicy = {default:"block"}' $CFG | sudo tee /tmp/oci-cfg.json >/dev/null \
  && sudo jq -e . /tmp/oci-cfg.json >/dev/null && sudo install -o radicle -g radicle -m 644 /tmp/oci-cfg.json $CFG
sudo jq '.node | {peers, seedingPolicy}' $CFG
sudo systemctl restart radicle-node; sleep 6
for r in $RIDS; do asrad $RAD seed "$r" --scope all --no-fetch 2>&1 | tail -1; done
sleep 4; echo "== node status after fix"; asrad $RAD node status 2>&1 | head -20
echo "On the desktop now run:  rad node status   — expect the OCI row with ✓"
