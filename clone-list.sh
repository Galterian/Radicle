#!/bin/bash
export PATH=/home/galt/.nvm/versions/node/v22.23.3/bin:/home/galt/.radicle/bin:/usr/local/bin:/usr/bin:/bin
cd /home/galt/repo_radicle_clone2/chaosD6
echo "=== rad sync ==="
rad sync --fetch 2>&1 | tail -8
echo
echo "=== join.mjs --list ==="
node game/join.mjs --list 2>&1 | tail -20
echo
echo "=== door JSON on the pushed branch ==="
NID=z6Mkrh3gkVD8E4cJgibm1NDmStUCJuVASwmtq9C1Juvag6yy
REF=refs/remotes/rad-ns-${NID: -8}/ActiveDimensions/Ashfall-Micro
git fetch rad://zqZmP6itceBMqYwi1K1n8phQqCaj/$NID "+refs/heads/ActiveDimensions/*:refs/remotes/rad-ns-${NID: -8}/ActiveDimensions/*" 2>/dev/null
git show "$REF:ActiveDimensions/Ashfall-Micro/doors/door-primary.json" 2>&1 > /tmp/door.json
echo "---network block---"
python3 -c "import json; d=json.load(open('/tmp/door.json')); print(json.dumps(d.get('network',{}),indent=2))" 2>/dev/null || grep -nE "network|bootstrap|discovery_url|gun_relays|ip4" /tmp/door.json | head -20
echo "---last_push---"
python3 -c "import json; d=json.load(open('/tmp/door.json')); print(json.dumps(d.get('last_push',{}),indent=2))" 2>/dev/null
