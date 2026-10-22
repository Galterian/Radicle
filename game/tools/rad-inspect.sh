#!/usr/bin/env bash
# Show where Radicle keeps this repo's storage and which namespaces/branches it has.
export PATH="$HOME/.radicle/bin:$PATH"
RID=rad:zqZmP6itceBMqYwi1K1n8phQqCaj
echo "rad path: $(rad path)"
echo "--- seeding policy ---"; rad seed 2>/dev/null | head -5
echo "--- config: seedingPolicy ---"; rad config | grep -A4 '"seedingPolicy"' | head -6
STORAGE="$(rad path)/storage/${RID#rad:}"
echo "storage: $STORAGE"; ls "$STORAGE" | head
echo "--- namespaces with ActiveDimensions refs ---"
git -C "$STORAGE" for-each-ref --format='%(refname)' 'refs/namespaces/*/refs/heads/ActiveDimensions/*' | head -20
echo "--- all namespaces ---"
git -C "$STORAGE" for-each-ref --format='%(refname)' 'refs/namespaces/*/refs/heads/master' | sed 's#refs/namespaces/##; s#/refs/heads/master##' | head
echo "--- rad sync status ---"; timeout 20 rad sync status 2>&1 | head -8
