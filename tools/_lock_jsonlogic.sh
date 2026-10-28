#!/usr/bin/env bash
# Add json-logic-js to game/package-lock.json without npm touching the Artifactory-pinned tree.
set -euo pipefail
cd "$(dirname "$0")/../game"
for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; export PATH
V=$(node -p "require('./node_modules/json-logic-js/package.json').version")
URL="https://registry.npmjs.org/json-logic-js/-/json-logic-js-$V.tgz"
curl -fsSL "$URL" -o /tmp/jl.tgz
INTEGRITY="sha512-$(openssl dgst -sha512 -binary /tmp/jl.tgz | base64 -w0)"
node - "$V" "$URL" "$INTEGRITY" <<'EOF'
const fs = require('fs'); const [v, url, integrity] = process.argv.slice(2);
const p = 'package-lock.json'; const raw = fs.readFileSync(p, 'utf8'); const crlf = raw.includes('\r\n');
const l = JSON.parse(raw);
l.packages[''].dependencies['json-logic-js'] = '^' + v;
const deps = l.packages['']; deps.dependencies = Object.fromEntries(Object.entries(deps.dependencies).sort(([a], [b]) => a.localeCompare(b)));
l.packages['node_modules/json-logic-js'] = { version: v, resolved: url, integrity, license: 'MIT' };
l.packages = Object.fromEntries(Object.entries(l.packages).sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))));
let out = JSON.stringify(l, null, 2) + '\n'; if (crlf) out = out.replace(/\n/g, '\r\n');
fs.writeFileSync(p, out); console.log('lock: json-logic-js', v, integrity.slice(0, 20) + '…');
EOF
npm ls json-logic-js --userconfig /dev/null 2>&1 | tail -2
