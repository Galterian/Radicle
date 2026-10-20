#!/bin/bash
# Wait up to ~5 min for a Radicle push whose door JSON lists 5 members (incl. player-2).
LOG=/home/galt/repo_radicle/chaosD6/game/host.log
for i in $(seq 1 60); do
  # Find the most recent push and check if its door JSON has player-2.
  LAST=$(grep -E "radicle push → " "$LOG" | tail -1 | awk '{print $4}')
  if [ -n "$LAST" ]; then
    PEER=$(grep -c "peer:player-2" "$LOG")
    if [ "$PEER" -gt 0 ] && grep -qE "radicle push → " "$LOG"; then
      # Fetch the latest push's door JSON and check members count.
      cd /home/galt/repo_radicle_clone2/chaosD6
      NID=z6Mkrh3gkVD8E4cJgibm1NDmStUCJuVASwmtq9C1Juvag6yy
      REF=refs/remotes/rad-ns-${NID: -8}/ActiveDimensions/Ashfall-Micro
      git fetch rad://zqZmP6itceBMqYwi1K1n8phQqCaj/$NID "+refs/heads/ActiveDimensions/*:refs/remotes/rad-ns-${NID: -8}/ActiveDimensions/*" >/dev/null 2>&1
      MEMBERS=$(git show "$REF:ActiveDimensions/Ashfall-Micro/doors/door-primary.json" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('members',[])))" 2>/dev/null)
      if [ "$MEMBERS" = "5" ]; then
        echo "tick $i: PUSH WITH 5 MEMBERS confirmed"
        git show "$REF:ActiveDimensions/Ashfall-Micro/doors/door-primary.json" | python3 -c "import json,sys; d=json.load(sys.stdin); print('turn=',d['turn'],'phase=',d['phase']); [print(' ',m['peer_id'],'at (',m['tile']['q'],',',m['tile']['r'],') clan=',m['clan']) for m in d['members']]"
        exit 0
      fi
    fi
  fi
  LASTL=$(grep -E "lottery #" "$LOG" 2>/dev/null | tail -1)
  echo "tick $i: ${LASTL:-no lottery yet} | pushes so far: $(grep -c 'radicle push →' $LOG)"
  sleep 5
done
echo "---TIMED OUT---"
grep -E "lottery #|radicle push → " "$LOG" | tail -20
exit 1
