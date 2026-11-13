#!/usr/bin/env bash
# Live sync monitor for the chaosD6 OCI seed. Runs on the dev PC. Polls two
# sides every INTERVAL seconds and prints one row per tick:
#   - local TCP socket to <OCI>:8776 — bytes sent / received (and derived rate)
#   - OCI httpd /api/v1/repos count + /remotes branch-count (what replicated)
# Also tails the dev-PC rad node's log for lines containing the OCI NID prefix.
#
# Usage:
#   bash game/tools/oci/sync-monitor.sh               # 3s ticks, runs forever
#   INTERVAL=1 bash game/tools/oci/sync-monitor.sh    # 1s ticks
#   HOST=my.other.seed bash game/tools/oci/sync-monitor.sh
#
# Ctrl-C to stop.
set -u

HOST="${HOST:-92-5-138-121.sslip.io}"
RID="${RID:-rad:zqZmP6itceBMqYwi1K1n8phQqCaj}"
OCI_NID_PREFIX="${OCI_NID_PREFIX:-z6MknLjCKC}"
INTERVAL="${INTERVAL:-3}"

# Resolve the sslip hostname once so ss can match the IP in socket entries.
HOST_IP=$(getent ahosts "$HOST" | awk '/STREAM|RAW|DGRAM/{print $1; exit}')
if [ -z "$HOST_IP" ]; then
  echo "could not resolve $HOST (DNS blocked?). Falling back to IP sniffing."
  HOST_IP="(unknown)"
fi

RAD_LOG="$HOME/.radicle/node/node.log"
echo "OCI_HOST   = $HOST ($HOST_IP)"
echo "RID        = $RID"
echo "rad log    = $RAD_LOG"
echo "interval   = ${INTERVAL}s"
echo
printf '%-8s %12s %12s %12s %10s %8s %10s   %s\n' \
  "time" "sock-sent" "sock-rcvd" "sent-rate" "oci-repos" "oci-brs" "br-rate" "note"
echo "-------------------------------------------------------------------------------------------"

prev_sent=0
prev_rcvd=0
prev_brs=0
prev_ts=$(date +%s)

while true; do
  now=$(date +%H:%M:%S)
  ts=$(date +%s)

  # ss -tin matches established TCP sockets with their byte counters (in the
  # "bytes_sent" and "bytes_received" fields of the second line of each entry).
  # Match either by IP (if resolved) or by remote port 8776 as a loose fallback.
  if [ "$HOST_IP" != "(unknown)" ]; then
    SOCK=$(ss -tin state established "( dst $HOST_IP and dport = :8776 )" 2>/dev/null)
  else
    SOCK=$(ss -tin state established dport = :8776 2>/dev/null)
  fi
  sent=$(printf '%s\n' "$SOCK" | grep -oE 'bytes_sent:[0-9]+' | head -1 | cut -d: -f2)
  rcvd=$(printf '%s\n' "$SOCK" | grep -oE 'bytes_received:[0-9]+' | head -1 | cut -d: -f2)
  sent=${sent:-0}
  rcvd=${rcvd:-0}

  # OCI side
  repos_json=$(curl -sS -m 4 "https://$HOST/api/v1/repos" 2>/dev/null || echo '[]')
  repos_count=$(printf '%s\n' "$repos_json" | python3 -c 'import json,sys
try:  d=json.load(sys.stdin)
except: d=[]
print(len(d) if isinstance(d,list) else 0)' 2>/dev/null || echo 0)
  if [ "$repos_count" != "0" ]; then
    remotes_json=$(curl -sS -m 4 "https://$HOST/api/v1/repos/$RID/remotes" 2>/dev/null || echo '[]')
    brs=$(printf '%s\n' "$remotes_json" | python3 -c 'import json,sys
try:  d=json.load(sys.stdin)
except: print(0); exit()
if not isinstance(d,list): print(0); exit()
print(sum(len((r.get("heads") or {})) for r in d))' 2>/dev/null || echo 0)
  else
    brs=0
  fi

  # Rates (per second since last tick)
  dt=$(( ts - prev_ts )); dt=$(( dt > 0 ? dt : 1 ))
  sent_rate=$(( (sent - prev_sent) / dt ))
  br_rate=$(( (brs - prev_brs) / dt ))

  # Pretty-format bytes
  fmt_bytes() {
    local n=$1
    if   [ "$n" -ge 1073741824 ]; then printf '%.1fG' "$(echo "$n/1073741824" | bc -l)"
    elif [ "$n" -ge 1048576    ]; then printf '%.1fM' "$(echo "$n/1048576"    | bc -l)"
    elif [ "$n" -ge 1024       ]; then printf '%.1fK' "$(echo "$n/1024"       | bc -l)"
    else printf '%dB' "$n"
    fi
  }
  sent_h=$(fmt_bytes "$sent")
  rcvd_h=$(fmt_bytes "$rcvd")
  sr_h=$(fmt_bytes "$sent_rate")

  # Tail last line of rad log that mentions the OCI NID prefix.
  note=""
  if [ -f "$RAD_LOG" ]; then
    note=$(grep -F "$OCI_NID_PREFIX" "$RAD_LOG" 2>/dev/null | tail -1 | sed 's/.*INFO *//' | cut -c1-80)
  fi

  printf '%-8s %12s %12s %12s %10s %8s %10s   %s\n' \
    "$now" "$sent_h" "$rcvd_h" "${sr_h}/s" "$repos_count" "$brs" "${br_rate}/s" "${note:-·}"

  prev_sent=$sent
  prev_rcvd=$rcvd
  prev_brs=$brs
  prev_ts=$ts
  sleep "$INTERVAL"
done
