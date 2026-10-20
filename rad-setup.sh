#!/bin/bash
set -e
export PATH="$HOME/.radicle/bin:$PATH"
export CURL_CA_BUNDLE="$HOME/.ca-bundle.crt"

echo "=== rad version ==="
rad --version

echo
echo "=== rad path ==="
rad path || true

echo
echo "=== seed.radicle.dev NID (public) ==="
# Documented NID for the public seed node operated by the Radicle project:
echo "z6MksFqXN3Yhqk8pTJdUGLwATkRfQvwZXPqR2qMEhbS9wzpT"
