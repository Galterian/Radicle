"""Where the MEDIA files (sprites, images, sounds, screenshots) live — Python twin of game/asset-root.mjs.

Catalogue JSONs (feature_table.json, frames.json, asset_index.json, mapping_*.json, terrain_tiles.json, ...) always
stay in the Code repo's assets/ (CODE_ASSETS). Media may live in the chaosD6-Resources repo at the same relative paths.

Media root, first match wins:
  1. env CHAOSD6_ASSETS_DIR
  2. <code repo>/assets if it still holds media (assets/Sprites exists) — the behaviour before the split
  3. env CHAOSD6_RESOURCES_REPO + /assets
  4. first existing of RESOURCES_REPO_CANDIDATES + /assets
  5. otherwise <code repo>/assets

Usage in tools/*.py:   from asset_root import media_path, CODE_ROOT, MEDIA_ROOT
    media_path("assets/Sprites/x.png") -> absolute path on disk (write media there, JSON catalogues under CODE_ROOT)
"""
import os

CODE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE_ASSETS = os.path.join(CODE_ROOT, 'assets')
RESOURCES_REPO_CANDIDATES = [
    os.path.normpath(os.path.join(CODE_ROOT, '..', 'chaosd6-resources-repo')),
    os.path.normpath(os.path.join(CODE_ROOT, '..', '..', 'chaosd6-resources-repo')),
]
MEDIA_SENTINEL = 'Sprites'
# Extensions that move to chaosD6-Resources; everything else (JSON catalogues) stays in the Code repo.
MEDIA_EXT = ('.png', '.bmp', '.jpg', '.jpeg', '.gif', '.webp', '.wav', '.ogg', '.mp3', '.ttf', '.svg')


def is_media(rel):
    return str(rel).lower().endswith(MEDIA_EXT)


def resolve_media_root(env=os.environ):
    if env.get('CHAOSD6_ASSETS_DIR'):
        return os.path.abspath(env['CHAOSD6_ASSETS_DIR']), 'CHAOSD6_ASSETS_DIR'
    if os.path.isdir(os.path.join(CODE_ASSETS, MEDIA_SENTINEL)):
        return CODE_ASSETS, 'code repo assets/'
    if env.get('CHAOSD6_RESOURCES_REPO'):
        return os.path.join(os.path.abspath(env['CHAOSD6_RESOURCES_REPO']), 'assets'), 'CHAOSD6_RESOURCES_REPO'
    for c in RESOURCES_REPO_CANDIDATES:
        if os.path.isdir(os.path.join(c, 'assets')):
            return os.path.join(c, 'assets'), 'resources repo'
    return CODE_ASSETS, 'none found (code repo assets/)'


MEDIA_ROOT, MEDIA_VIA = resolve_media_root()
MEDIA_REPO_ROOT = os.path.dirname(MEDIA_ROOT)


def media_path(rel):
    """'assets/...' or 'warlords3_screenshots/...' -> absolute path of the media file."""
    r = str(rel).replace('\\', '/').lstrip('/')
    if r == 'assets' or r.startswith('assets/'):
        return os.path.join(MEDIA_ROOT, *[p for p in r[len('assets'):].split('/') if p])
    return os.path.join(MEDIA_REPO_ROOT, *r.split('/'))


def asset_file(rel):
    """Overlay lookup ('assets/...'): media from the media root first, catalogues from the Code repo first;
    each falls back to the other. None when missing."""
    r = str(rel).replace('\\', '/').lstrip('/')
    code = os.path.join(CODE_ROOT, *r.split('/'))
    for cand in ((media_path(r), code) if is_media(r) else (code, media_path(r))):
        if os.path.isfile(cand):
            return cand
    return None
