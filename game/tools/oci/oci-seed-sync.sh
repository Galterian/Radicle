#!/usr/bin/env bash
# Runs ON the OCI seed (as user ubuntu, uses sudo). For each of our 6 repos: is it seeded (policy), is it in storage,
# whose refs does the seed hold, and what does the journal say about fetching it. With --fix: (re)seed every RID and
# fetch it from OUR DESKTOP ONLY (--seed <desktop NID>, never the public network) — the desktop node must be running
# and connected to the seed (desktop: rad node status shows the OCI row).
# 2026-11-19: desktop `rad sync status` showed chaos-oci-seed 2 weeks behind on the Code repo; Profiles no longer seeded.
#
# From WSL (check only, then fix):
#   ssh -i ~/.ssh/id_rsa -o IdentitiesOnly=yes ubuntu@92-5-138-121.sslip.io 'bash -s' < game/tools/oci/oci-seed-sync.sh
#   ssh -i ~/.ssh/id_rsa -o IdentitiesOnly=yes ubuntu@92-5-138-121.sslip.io 'bash -s -- --fix' < game/tools/oci/oci-seed-sync.sh
set -u
FIX=0; [ "${1:-}" = "--fix" ] && FIX=1
RH=/home/radicle/.radicle
DESKTOP=z6Mkrh3gkVD8E4cJgibm1NDmStUCJuVASwmtq9C1Juvag6yy
RAD=$(sudo -u radicle bash -lc 'command -v rad' 2>/dev/null); [ -z "$RAD" ] && RAD=$RH/bin/rad
asrad() { sudo -u radicle env RAD_HOME=$RH HOME=/home/radicle "$@"; }
declare -A NAME=(
  [rad:zqZmP6itceBMqYwi1K1n8phQqCaj]=Code       [rad:z2xbfJfwT3kukR73m8LXmmuvchEwr]=Dimensions
  [rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ]=Effects    [rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5]=Skills
  [rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi]=Classes    [rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH]=Profiles )
RIDS="rad:zqZmP6itceBMqYwi1K1n8phQqCaj rad:z2xbfJfwT3kukR73m8LXmmuvchEwr rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5 rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH"

report() {
  echo "== services: $(systemctl is-active radicle-node radicle-httpd 2>&1 | paste -sd' ')"
  echo "== config: $(sudo jq -c '.node | {peers, seedingPolicy}' $RH/config.json)"
  echo "== is our desktop connected?"; asrad $RAD node status 2>&1 | grep -E "${DESKTOP:0:12}|${DESKTOP: -7}" || echo "   NO — start the desktop node first (rad node start), then re-run"
  echo "== seeding policies (rad seed)"; asrad $RAD seed 2>&1 | head -20
  for r in $RIDS; do
    local id=${r#rad:}
    echo "== ${NAME[$r]} $r"
    if [ -d "$RH/storage/$id" ]; then
      echo "   in storage; HEAD of each namespace (sigrefs):"
      sudo -u radicle git -C "$RH/storage/$id" for-each-ref --format='   %(refname) %(objectname:short) %(committerdate:relative)' 'refs/namespaces/*/refs/rad/sigrefs' 2>/dev/null \
        | sed "s#refs/namespaces/\([^/]*\)/refs/rad/sigrefs#\1#" | head -8
    else
      echo "   NOT in storage"
    fi
    sudo journalctl -u radicle-node --since "-3 days" --no-pager 2>/dev/null | grep -F "$id" | grep -iE 'fetch|error|fail|refus|block' | tail -3 | cut -c1-200
  done
}

report
[ $FIX = 1 ] || { echo; echo "check only — re-run with --fix: seed each RID (scope all) and fetch it from the desktop only"; exit 0; }

echo; echo "== FIX: seed + fetch from the desktop ($DESKTOP) only"
for r in $RIDS; do
  echo "-- ${NAME[$r]}"
  asrad $RAD seed "$r" --scope all --no-fetch 2>&1 | tail -1
  asrad $RAD sync --fetch "$r" --seed "$DESKTOP" --timeout 60sec 2>&1 | tail -3
done
echo; echo "== after"; report
echo; echo "On the desktop now run:  bash game/tools/oci/desktop-announce-oci.sh   — expect chaos-oci-seed ✓ for every repo"
