#!/usr/bin/env node
import fs from 'node:fs';
const files = ['actions','characters','classes','creatures','effects','elements','skills','terrain_items'];
let ok = true;
for (const name of files) {
  const p = `data/${name}.json`;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const n = (j.entries || []).length;
    const r = (j.entries || []).filter(e => e.resources).length;
    console.log(`${p.padEnd(28)} entries=${String(n).padStart(3)}  resources=${String(r).padStart(3)}`);
    if (r !== n) { ok = false; console.log('  WARN: resource coverage not 100%'); }
  } catch (e) {
    ok = false;
    console.log(`${p}: FAIL ${e.message}`);
  }
}
process.exit(ok ? 0 : 1);
