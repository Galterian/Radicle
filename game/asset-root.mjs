// One place that decides where the MEDIA files (sprites, images, sounds, screenshots) live.
//
// Since 2026-11-20 the media can live in a separate repo, chaosD6-Resources, at the SAME relative paths
// (assets/Sprites/..., assets/Sounds/..., warlords3_screenshots/...). The catalogue JSONs (feature_table.json,
// frames.json, asset_index.json, mapping_*.json, terrain_tiles.json, ...) always stay in this Code repo's assets/,
// because they feed the deterministic (seed, q, r) map and every peer must read the same copy.
//
// Media root, first match wins:
//   1. env CHAOSD6_ASSETS_DIR (absolute path of an assets/ tree; also what the phone peer gets: user://assets)
//   2. <code repo>/assets, if it still holds media (assets/Sprites exists) — the behaviour before the split
//   3. env CHAOSD6_RESOURCES_REPO + /assets
//   4. the first existing of RESOURCES_REPO_CANDIDATES + /assets (default checkout locations, see below)
//   5. otherwise <code repo>/assets (callers then report the missing files)
//
// Asset paths in the catalogues stay repo-relative ("assets/Sprites/.../x.png"); mediaPath() maps them to disk.
// assetFile() is the overlay a server uses for /assets/*: media files (MEDIA_EXT) from the media root first, every
// other file (the catalogue JSONs) from the Code repo's assets/ first; each falls back to the other root.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CODE_ASSETS_DIR = path.join(CODE_ROOT, 'assets');
// Radicle id of chaosD6-Resources. Placeholder "" until the user publishes it; set with
// game/tools/out/_resources_rid_patch.py <RID> --apply.
export const RESOURCES_RID = 'rad:zZA4j9cK1QF5ThY3KjEoLV4HTd14';
// Default checkout locations of the resources repo, relative to the Code repo root. The first is a true sibling;
// the second matches the layout /home/galt/repo_radicle_clone2/chaosD6 + /home/galt/chaosd6-resources-repo.
export const RESOURCES_REPO_CANDIDATES = [
  path.resolve(CODE_ROOT, '..', 'chaosd6-resources-repo'),
  path.resolve(CODE_ROOT, '..', '..', 'chaosd6-resources-repo'),
];
// A media folder that only exists where the media are; the catalogue JSONs never create it.
const MEDIA_SENTINEL = 'Sprites';
// Extensions that move to chaosD6-Resources; everything else (JSON catalogues) stays in the Code repo.
export const MEDIA_EXT = ['.png', '.bmp', '.jpg', '.jpeg', '.gif', '.webp', '.wav', '.ogg', '.mp3', '.ttf', '.svg'];
export const isMedia = (rel) => MEDIA_EXT.includes(path.extname(String(rel)).toLowerCase());

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

export function resolveMediaRoot(env = process.env) {
  if (env.CHAOSD6_ASSETS_DIR) return { root: path.resolve(env.CHAOSD6_ASSETS_DIR), via: 'CHAOSD6_ASSETS_DIR' };
  if (isDir(path.join(CODE_ASSETS_DIR, MEDIA_SENTINEL))) return { root: CODE_ASSETS_DIR, via: 'code repo assets/' };
  if (env.CHAOSD6_RESOURCES_REPO) return { root: path.resolve(env.CHAOSD6_RESOURCES_REPO, 'assets'), via: 'CHAOSD6_RESOURCES_REPO' };
  for (const c of RESOURCES_REPO_CANDIDATES) if (isDir(path.join(c, 'assets'))) return { root: path.join(c, 'assets'), via: 'resources repo' };
  return { root: CODE_ASSETS_DIR, via: 'none found (code repo assets/)' };
}

export const MEDIA = resolveMediaRoot();
export const MEDIA_ROOT = MEDIA.root;
// Root of the resources repo layout (parent of the media assets/), where warlords3_screenshots/ sits too.
export const MEDIA_REPO_ROOT = path.dirname(MEDIA_ROOT);

// "assets/Sprites/x.png" | "warlords3_screenshots/x.jpg" → absolute path of the media file.
export function mediaPath(rel) {
  const r = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (r === 'assets' || r.startsWith('assets/')) return path.join(MEDIA_ROOT, r.slice('assets'.length));
  return path.join(MEDIA_REPO_ROOT, r);
}

// Overlay lookup for a path under /assets/ (rel WITHOUT the "assets/" prefix): Code repo first, then the media root.
// Returns an absolute path inside one of the two roots, or null (missing, or a traversal attempt).
export function assetFile(rel) {
  const r = '.' + path.posix.join('/', String(rel).replace(/\\/g, '/'));
  const roots = MEDIA_ROOT === CODE_ASSETS_DIR ? [CODE_ASSETS_DIR] : isMedia(r) ? [MEDIA_ROOT, CODE_ASSETS_DIR] : [CODE_ASSETS_DIR, MEDIA_ROOT];
  for (const root of roots) {
    const abs = path.resolve(root, r);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    try { if (fs.statSync(abs).isFile()) return abs; } catch {}
  }
  return null;
}
