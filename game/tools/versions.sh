#!/usr/bin/env bash
# Print the installed versions of the libp2p stack (helps spot nested-duplicate
# @libp2p/* packages, which silently break gossipsub).
cd "$(dirname "$0")/.."
for p in libp2p @chainsafe/libp2p-gossipsub @chainsafe/libp2p-noise @chainsafe/libp2p-yamux @libp2p/identify @libp2p/tcp @libp2p/interface @libp2p/crypto; do
  v=$(node -p "require('./node_modules/$p/package.json').version" 2>/dev/null || echo '-')
  printf '%-34s %s\n' "$p" "$v"
done
echo "--- nested duplicates ---"
find node_modules -path '*/node_modules/@libp2p/*/package.json' -mindepth 4 2>/dev/null | grep '/node_modules/.*/node_modules/@libp2p/' | while read -r f; do
  printf '%s  %s\n' "$(node -p "require('./$f').version")" "$f"
done
echo "--- package.json deps ---"
node -p "JSON.stringify(require('./package.json').dependencies, null, 1)"
