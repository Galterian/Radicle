// Dev helper: print the map fields of a Door + dimension.json from a Radicle
// work tree. usage: node tools/door-map.mjs [worktree=peer-player-1] [dim=Ashfall-Micro] [door=player-1]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const [wt = 'peer-player-1', dim = 'Ashfall-Micro', door = 'player-1'] = process.argv.slice(2);
const base = path.join(here, '..', 'radicle-work', wt, 'ActiveDimensions', dim);
const d = JSON.parse(fs.readFileSync(path.join(base, 'doors', `${door}.json`), 'utf8'));
console.log(`door ${door}: pushed_at ${d.pushed_at}, tile (${d.tile.q},${d.tile.r}), map ${d.map?.tiles_known} hexes / ${d.map?.blocks?.length} blocks, bounds ${JSON.stringify(d.map?.bounds)}`);
const dd = JSON.parse(fs.readFileSync(path.join(base, 'dimension.json'), 'utf8'));
console.log('dimension.json tileset:', JSON.stringify(dd.tileset, null, 1).slice(0, 700));
