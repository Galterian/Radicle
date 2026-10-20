#!/bin/bash
export PATH="$HOME/.radicle/bin:$PATH"
export CURL_CA_BUNDLE="$HOME/.ca-bundle.crt"

echo "=== rad self ==="
rad self 2>&1 | head -20

echo
echo "=== rad ls (local repos) ==="
rad ls 2>&1 | head -40

echo
echo "=== repo storage dir ==="
ls ~/.radicle/storage 2>&1
