#!/usr/bin/env bash
# Print the delegate set on the project's Radicle identity, and warn if it has
# grown past the creator — the "only creator can rebase/delete" guarantee for
# ActiveDimensions/* is backed by Radicle's delegate role, not by refs policy.
#
# Joiners always have write access to THEIR OWN NID namespace and nothing else,
# so they can push doors/<peer>.json but cannot touch the creator's refs. This
# check only matters for the project identity itself (who can revoke access or
# publish a new identity doc).
set -euo pipefail
export PATH="$HOME/.radicle/bin:$PATH"
RID="${RADICLE_RID:-rad:zqZmP6itceBMqYwi1K1n8phQqCaj}"
EXPECTED_NID="${EXPECTED_CREATOR_NID:-}"

echo "project rid: $RID"
if ! command -v rad >/dev/null 2>&1; then
  echo "rad not installed — skipping"; exit 0
fi
# `rad id` prints the identity doc including the delegate list. The exact JSON
# shape changes between rad 1.x releases, so grep tolerantly.
out="$(rad id --repo "$RID" 2>/dev/null || true)"
if [ -z "$out" ]; then
  echo "could not read identity doc for $RID (not seeded here, or rad auth missing)"
  exit 0
fi
echo "--- identity ---"
echo "$out" | sed -n '1,30p'
dels="$(echo "$out" | grep -oE 'did:key:[A-Za-z0-9]+' | sort -u)"
n="$(echo "$dels" | grep -c . || true)"
echo "--- delegates ($n) ---"
echo "$dels"
if [ -n "$EXPECTED_NID" ] && ! echo "$dels" | grep -q "$EXPECTED_NID"; then
  echo "WARN: expected creator $EXPECTED_NID not in delegate set"
  exit 1
fi
if [ "$n" -gt 1 ]; then
  echo "WARN: more than one delegate — the 'only creator can rebase/delete' guarantee is weakened"
  exit 2
fi
echo "ok: single-delegate identity, joiners can only write their own namespace"
