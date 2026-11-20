#!/usr/bin/env bash
# Runs ON the OCI seed (user ubuntu, uses sudo), after game/tools/out/_history_switch.sh --apply (2026-11-20).
# Replaces OCI's copy of the Code repo (old history incl. player-b's fork and OCI's own master) with the rewritten
# history from OUR DESKTOP. OCI cannot dial the desktop (home NAT: "No addresses known"), so the desktop pushes:
# this script only moves the old copy aside (no node restart, so the desktop's connection stays up) and keeps the
# seeding policy; then on the desktop run the announce printed at the end.
# 2026-11-20 first version restarted radicle-node → the desktop connection dropped → the fetch failed.
#   ssh -i ~/.ssh/id_rsa -o IdentitiesOnly=yes ubuntu@92-5-138-121.sslip.io 'bash -s' < game/tools/oci/oci-reseed-code.sh
#   ... -- 'bash -s -- --restore <dir>' to move an old copy back.
set -u
RH=/home/radicle/.radicle
RID=rad:zqZmP6itceBMqYwi1K1n8phQqCaj; ID=${RID#rad:}
DESKTOP=z6Mkrh3gkVD8E4cJgibm1NDmStUCJuVASwmtq9C1Juvag6yy
OCI=z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT
RAD=$(sudo -u radicle bash -lc 'command -v rad' 2>/dev/null); [ -z "$RAD" ] && RAD=$RH/bin/rad
asrad() { sudo -u radicle env RAD_HOME=$RH HOME=/home/radicle "$@"; }

if [ "${1:-}" = "--restore" ]; then
  [ -d "${2:-}" ] || { echo "usage: --restore /home/radicle/chaosd6-code-old-<ts>"; exit 1; }
  [ -d $RH/storage/$ID ] && sudo mv $RH/storage/$ID $RH/../chaosd6-code-new-$(date +%H%M%S)
  sudo mv "$2" $RH/storage/$ID && echo "restored $2" && exit 0
fi

echo "== storage: $(sudo du -sh $RH/storage/$ID 2>/dev/null | cut -f1 || echo none)   free: $(df -h /home | awk 'NR==2{print $4}')"
echo "== desktop connected: $(asrad $RAD node status 2>&1 | grep -cE "${DESKTOP:0:12}|${DESKTOP: -7}") row(s)"
if [ -d $RH/storage/$ID ]; then
  OLD=/home/radicle/chaosd6-code-old-$(date +%Y%m%d-%H%M%S)
  if sudo -u radicle git -C $RH/storage/$ID rev-list --objects --all 2>/dev/null | grep -qiE ' assets/.*\.(png|bmp|wav)$'; then
    sudo mv $RH/storage/$ID $OLD && echo "== old history found — moved aside to $OLD"
  else
    echo "== storage already holds only the new history — nothing to move"
  fi
fi
asrad $RAD seed $RID --scope all --no-fetch 2>&1 | tail -1
sudo -u radicle git -C $RH/storage/$ID for-each-ref --format='%(refname)' refs/namespaces 2>/dev/null | sed -E 's#refs/namespaces/([^/]{12})[^/]*/.*#\1#' | sort | uniq -c | sed 's/^/   namespace /'
ls -d /home/radicle/chaosd6-code-old-* 2>/dev/null | sed 's/^/   old copy: /'
cat <<EOF
Now on the DESKTOP (its node must show the OCI row in 'rad node status'):
  rad sync --announce $RID --seed $OCI --replicas 1 --timeout 300sec
then re-run this script: it should report "only the new history" and the desktop namespace.
EOF
