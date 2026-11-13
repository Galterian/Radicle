#!/usr/bin/env bash
# Install isomorphic-git (chaosD6-Profiles sync, game/profile-sync.mjs) into game/node_modules and into the
# staged phone bundle (nodejs-project/node_modules), same flags as _npm_jsonlogic.sh. Version pinned by game/package.json.
cd "$(dirname "$0")/../game"
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH
V=$(node -p "require('./package.json').dependencies['isomorphic-git']")
npm install "isomorphic-git@$V" --userconfig /dev/null --registry https://registry.npmjs.org/ --package-lock=false --no-audit --no-fund 2>&1 | tail -2
S=../godot/android/plugins/nodejs_mobile/src/main/assets/nodejs-project
if [ -d "$S/node_modules" ]; then
  (cd "$S" && npm install "isomorphic-git@$V" --userconfig /dev/null --registry https://registry.npmjs.org/ --package-lock=false --no-save --omit=dev --no-audit --no-fund 2>&1 | tail -2)
fi
node -e "Promise.all([import('isomorphic-git'), import('isomorphic-git/http/node')]).then(([g]) => console.log('isomorphic-git', g.default.version()))"
(cd "$S" && node -e "import('isomorphic-git').then(g => console.log('bundle isomorphic-git', g.default.version()))")
