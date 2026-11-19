#!/usr/bin/env bash
# Fail loudly if ~/.radicle/config.json has any of the public mesh seeds in it.
# A fresh `rad` upgrade or a `rad config set` can silently add rosa / iris /
# seed.radicle.xyz back; this script catches that before your next pushDimension
# puts you on the public mesh's rate-limit radar.
#
# Exit codes: 0 clean · 2 found a public seed · 3 no config file yet
set -euo pipefail
export PATH="$HOME/.radicle/bin:$PATH"

RAD_HOME="${RAD_HOME:-$HOME/.radicle}"
CFG="$RAD_HOME/config.json"
# Hostnames the user does NOT want their rad node talking to. The script FAILS
# if any of these appear in ~/.radicle/config.json (connect / preferredSeeds /
# seeds). This is a blocklist, not a configuration — nothing here is enabled.
BLOCKLIST='rosa.radicle.network|iris.radicle.network|seed.radicle.xyz|seed.radicle.network|seed.radicle.dev|seed.radicle.garden'

if [ ! -f "$CFG" ]; then
  echo "no rad config at $CFG — nothing to check"
  exit 3
fi

echo "== scanning $CFG for public-mesh seeds"
offenders=$(grep -Eo "($BLOCKLIST)" "$CFG" | sort -u || true)
if [ -n "$offenders" ]; then
  echo "FAIL: public-mesh seeds present in rad config:"
  echo "$offenders" | sed 's/^/  - /'
  echo
  echo "Remove them from node.connect and preferredSeeds, then: rad node restart"
  echo "Dry-run patch to copy-paste:"
  python3 - "$CFG" <<'PY'
import json, sys, re
p = sys.argv[1]
with open(p) as f: cfg = json.load(f)
BAD = {'rosa.radicle.network','iris.radicle.network','seed.radicle.xyz',
       'seed.radicle.network','seed.radicle.dev','seed.radicle.garden'}
def clean(lst):
    return [x for x in lst if not any(h in (x if isinstance(x,str) else json.dumps(x)) for h in BAD)]
node = cfg.setdefault('node', {})
for k in ('connect','preferredSeeds','seeds'):
    if k in node and isinstance(node[k], list):
        node[k] = clean(node[k])
print('\n--- cleaned config.json ---')
print(json.dumps(cfg, indent=2))
PY
  exit 2
fi
echo "ok: no public-mesh seeds in rad config"
ptype=$(jq -r '.node.peers.type // "dynamic"' "$CFG")
if [ "$ptype" != "static" ]; then
  echo "FAIL: node.peers.type=$ptype -> node dials random public seeds; set it to static"; exit 2
fi
for rid in rad:zqZmP6itceBMqYwi1K1n8phQqCaj rad:z2xbfJfwT3kukR73m8LXmmuvchEwr rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ \
           rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5 rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH; do
  v=$(rad inspect "$rid" --visibility 2>/dev/null | head -1)
  [ "$v" = "public" ] && { echo "FAIL: $rid is public"; exit 2; }
done

# Also show whatever IS configured so the user can see at a glance.
echo
echo "== current node.connect / preferredSeeds:"
python3 - "$CFG" <<'PY' || true
import json, sys
with open(sys.argv[1]) as f: cfg = json.load(f)
n = cfg.get('node', {})
for k in ('connect','preferredSeeds','seeds'):
    v = n.get(k)
    if v is not None:
        print(f'  {k}:')
        for x in (v if isinstance(v, list) else [v]):
            print(f'    - {x}')
PY
