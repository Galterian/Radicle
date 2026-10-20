#!/bin/bash
export PATH="$HOME/.radicle/bin:$PATH"
export CURL_CA_BUNDLE="$HOME/.ca-bundle.crt"

echo "=== rad self ==="
rad self 2>&1 | head -20

echo
echo "=== keys dir ==="
ls -la ~/.radicle/keys 2>&1

echo
echo "=== node status ==="
rad node status 2>&1 | head -10
