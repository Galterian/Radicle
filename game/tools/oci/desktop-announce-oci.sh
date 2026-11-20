#!/usr/bin/env bash
# Runs on the DESKTOP (WSL). Announces each of our 6 repos to the OCI seed only, then shows the sync status of
# each repo for you and the OCI seed (rows for other nodes are old records from before the 2026-11-18 privacy fix,
# not live connections).
#   bash game/tools/oci/desktop-announce-oci.sh
set -u
OCI=z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT
declare -A NAME=(
  [rad:zqZmP6itceBMqYwi1K1n8phQqCaj]=Code       [rad:z2xbfJfwT3kukR73m8LXmmuvchEwr]=Dimensions
  [rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ]=Effects    [rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5]=Skills
  [rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi]=Classes    [rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH]=Profiles )
RESOURCES_RID="rad:zZA4j9cK1QF5ThY3KjEoLV4HTd14"   # chaosD6-Resources (public). "" = not published yet: skipped, never seeded. Set by game/tools/out/_resources_rid_patch.py
EXTRA=""; case "$RESOURCES_RID" in rad:z?*) NAME[$RESOURCES_RID]=Resources; EXTRA="$RESOURCES_RID" ;; esac
echo "== node: $(rad node status 2>&1 | grep -c "${OCI:0:12}\|${OCI: -7}") OCI row(s) in rad node status"
for r in rad:zqZmP6itceBMqYwi1K1n8phQqCaj rad:z2xbfJfwT3kukR73m8LXmmuvchEwr rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ \
         rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5 rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH $EXTRA; do
  echo "== ${NAME[$r]} $r"
  # --replicas 1: OCI is the only seed we want; without it rad tries to reach its default replication factor from
  # old routing-table rows (the "21 seed(s) timed out" warning on Dimensions, 2026-11-19).
  rad sync --announce "$r" --seed "$OCI" --replicas 1 --timeout 30sec 2>&1 | tail -2
  rad sync status "$r" 2>&1 | grep -E '\(you\)|chaos-oci-seed' || echo "   (no OCI row)"
done
