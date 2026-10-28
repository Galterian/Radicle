#!/usr/bin/env bash
cd "$(dirname "$0")/../game"
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH
npm install json-logic-js --userconfig /dev/null --registry https://registry.npmjs.org/ --package-lock=false --no-audit --no-fund 2>&1 | tail -3
node -e "import('json-logic-js').then(m => { const j = m.default; j.add_operation('twice', x => x * 2); console.log('smoke', j.apply({ twice: [{ var: 'a' }] }, { a: 21 }), Object.keys(j)); })"
grep -n '"json-logic-js"' package.json
