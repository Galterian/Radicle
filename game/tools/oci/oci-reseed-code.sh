#!/usr/bin/env bash
# Runs ON the OCI seed (user ubuntu, uses sudo), after game/tools/out/_history_switch.sh --apply (2026-11-20).
# Replaces OCI's copy of the Code repo (old 1.5 GB history incl. player-b's fork and OCI's own master) with a fresh
# fetch of the rewritten history FROM OUR DESKTOP ONLY. The desktop node must be running and connected.
# The old copy is moved aside (not deleted) — remove it by hand once the phone and the explorer work.
#   ssh -i ~/.ssh/id_rsa -o IdentitiesOnly=yes ubuntu@92-5-138-121.sslip.io 'bash -s' < game/tools/oci/oci-reseed-code.sh
set -u
RH=/home/radicle/.radicle
RID=rad:zqZmP6itceBMqYwi1K1n8phQqCaj; ID=${RID#rad:}
DESKTOP=z6Mkrh3gkVD8E4cJgibm1NDmStUCJuVASwmtq9C1Juvag6yy
RAD=$(sudo -u radicle bash -lc 'command -v rad' 2>/dev/null); [ -z "$RAD" ] && RAD=$RH/bin/rad
asrad() { sudo -u radicle env RAD_HOME=$RH HOME=/home/radicle "$@"; }
OLD=/home/radicle/chaosd6-code-old-$(date +%Y%m%d-%H%M%S)

echo "== before: $(sudo du -sh $RH/storage/$ID 2>/dev/null | cut -f1)   free: $(df -h /home | awk 'NR==2{print $4}')"
asrad $RAD node status 2>&1 | grep -qE "${DESKTOP:0:12}|${DESKTOP: -7}" || { echo "STOP: our desktop is not connected — start its node (rad node start) and re-run"; exit 1; }
echo "== stop radicle-node, move the old copy to $OLD"
sudo systemctl stop radicle-node
sudo mv $RH/storage/$ID $OLD || { sudo systemctl start radicle-node; echo "STOP: move failed"; exit 1; }
sudo systemctl start radicle-node; sleep 8
echo "== seed + fetch from the desktop only"
asrad $RAD seed $RID --scope all --no-fetch 2>&1 | tail -1
for i in 1 2 3; do asrad $RAD sync --fetch $RID --seed $DESKTOP --timeout 120sec 2>&1 | tail -2 && [ -d $RH/storage/$ID ] && break; sleep 10; done
echo "== after: $(sudo du -sh $RH/storage/$ID 2>/dev/null | cut -f1)"
sudo -u radicle git -C $RH/storage/$ID for-each-ref --format='%(refname)' refs/namespaces 2>/dev/null | sed -E 's#refs/namespaces/([^/]{12})[^/]*/.*#\1#' | sort | uniq -c | sed 's/^/   namespace /'
sudo systemctl restart radicle-httpd 2>/dev/null; sleep 3
curl -fsS -m 10 https://127.0.0.1/api/v1/repos/$RID -k 2>/dev/null | head -c 300; echo
echo "Old copy kept at $OLD — when everything works:  sudo rm -rf $OLD"
echo "Back on the desktop:  bash game/tools/out/_history_switch.sh --finish"
