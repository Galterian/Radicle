"""Copy every asset referenced by a `resources` key in data/*.json from ../extracted into assets/.

    python tools/collect_assets.py [--dry-run | --index-only] [--src ../extracted] [--data data] [--assets assets]
                                   [--gamemodels <chaosD6-GameModels checkout>]

Sources of `resources` (2026-11-25, generic): the data/*.json collections, the definitions directories data/index.json
names (`definitions`: effects / skills / classes card blocks) and every kind folder the chaosD6-GameModels repo's
index.json lists (races, buildings, npcs, monsters, villages, quests, lib) — any `resources` object anywhere in a
definition. used_by = "<collection or GameModels folder>:<id>:<where>"; GameModels ones are "gamemodels/<folder>:…".
--index-only rewrites asset_index.json from the media already on disk (no copy, no .png conversion).

Paths inside `resources` are repo-relative (`assets/<rest>`); the source is `<src>/<rest>`.
Copied .bmp files also get a .png twin next to them. Writes assets/asset_index.json and,
when assets/frames.json exists, the subset assets/frames_used.json.
"""
import argparse, glob, json, os, shutil, sys
from PIL import Image
from asset_root import MEDIA_ROOT   # media files go here; JSON indexes stay in --assets

PREFIX = 'assets/'


def iter_paths(node, where=''):
    """Yield (path, context) for every `path` value under a resources dict."""
    if isinstance(node, dict):
        if isinstance(node.get('path'), str):
            yield node['path'], where
        for k, v in node.items():
            if k != 'path':
                yield from iter_paths(v, f'{where}.{k}' if where else k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from iter_paths(v, f'{where}[{i}]')
    elif isinstance(node, str) and node.startswith(PREFIX):   # a bare path (GameModels buildings: sprites.base)
        yield node, where


def iter_resources(node, where=''):
    """Yield (path, context) for every `path` under any `resources` object of a definition (card.resources, ...)."""
    if isinstance(node, dict):
        for k, v in node.items():
            w = f'{where}.{k}' if where else k
            if k == 'resources' and isinstance(v, (dict, list)):
                yield from iter_paths(v, w)
            else:
                yield from iter_resources(v, w)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from iter_resources(v, f'{where}[{i}]')


def resolve_gamemodels_dir(root, env=os.environ):
    """Python twin of game/gamemodels.mjs resolveGameModelsDir: env, then a sibling checkout (one with lib/)."""
    for k in ('CHAOSD6_GAMEMODELS_DIR', 'CHAOSD6_GAMEMODELS_REPO'):
        if env.get(k):
            return os.path.abspath(env[k])
    for c in (os.path.join(root, '..', 'chaosd6-gamemodels-repo'), os.path.join(root, '..', '..', 'chaosd6-gamemodels-repo')):
        if os.path.isdir(os.path.join(c, 'lib')):
            return os.path.normpath(c)
    return None


def load_json(f):
    return json.load(open(f, encoding='utf-8-sig'))


def collect_definition_refs(refs, files, label):
    for f in files:
        try:
            d = load_json(f)
        except Exception as ex:
            print(f'  ! cannot parse {f}: {ex}', file=sys.stderr)
            continue
        if not isinstance(d, dict) or not d.get('id'):
            continue
        for p, where in iter_resources(d):
            refs.setdefault(p.replace('\\', '/'), []).append(f'{label}:{d["id"]}:{where}')


def collect_refs(data_dir, gamemodels_dir=None):
    refs = {}  # path -> list of "collection:entry_id:where"
    root = os.path.dirname(os.path.abspath(data_dir))
    try:
        index = load_json(os.path.join(data_dir, 'index.json'))
    except Exception:
        index = {}
    for c in index.get('collections', []):          # effects / skills / classes: their definitions' card blocks
        d = c.get('definitions') and os.path.join(root, c['definitions'])
        if d and os.path.isdir(d):
            collect_definition_refs(refs, sorted(glob.glob(os.path.join(d, '*.json'))), c['id'])
    if gamemodels_dir:                              # every kind folder the GameModels repo indexes
        try:
            gm_index = load_json(os.path.join(gamemodels_dir, 'index.json'))
        except Exception as ex:
            gm_index = {}
            print(f'  ! no GameModels index.json in {gamemodels_dir}: {ex}', file=sys.stderr)
        for sub in sorted(k for k, v in gm_index.items() if isinstance(v, dict)):
            collect_definition_refs(refs, sorted(glob.glob(os.path.join(gamemodels_dir, sub, '*.json'))), f'gamemodels/{sub}')
    else:
        print('  ! no chaosD6-GameModels checkout: races / NPCs / buildings / monsters are not indexed', file=sys.stderr)
    for jf in sorted(glob.glob(os.path.join(data_dir, '*.json'))):
        try:
            d = json.load(open(jf, encoding='utf-8'))
        except Exception as ex:
            print(f'  ! cannot parse {jf}: {ex}', file=sys.stderr)
            continue
        entries = d.get('entries') if isinstance(d, dict) else None
        if not isinstance(entries, list):
            continue
        coll = os.path.splitext(os.path.basename(jf))[0]
        for e in entries:
            res = e.get('resources') if isinstance(e, dict) else None
            if not res:
                continue
            for p, where in iter_paths(res):
                refs.setdefault(p.replace('\\', '/'), []).append(f'{coll}:{e.get("id")}:{where}')
    return refs


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    ap.add_argument('--src', default=os.path.join(root, '..', 'extracted'))
    ap.add_argument('--data', default=os.path.join(root, 'data'))
    ap.add_argument('--assets', default=os.path.join(root, 'assets'))
    ap.add_argument('--media', default=MEDIA_ROOT, help='where media files are copied (default: tools/asset_root.py)')
    ap.add_argument('--gamemodels', default=resolve_gamemodels_dir(root), help='chaosD6-GameModels checkout (default: env / sibling)')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--index-only', action='store_true', help='rewrite asset_index.json from the media on disk; copy nothing')
    args = ap.parse_args()
    try:
        old_files = load_json(os.path.join(args.assets, 'asset_index.json')).get('files', {})
    except Exception:
        old_files = {}

    refs = collect_refs(args.data, args.gamemodels)
    copied = skipped = missing = converted = 0
    total_bytes = 0
    index = {'files': {}, 'missing': [], 'png_twins': {}}
    for rel, users in sorted(refs.items()):
        if not rel.startswith(PREFIX):
            print(f'  ! not under assets/: {rel}  ({users[0]})')
            index['missing'].append(rel)
            missing += 1
            continue
        rest = rel[len(PREFIX):]
        src = os.path.join(args.src, rest)
        dst = os.path.join(args.media, rest)
        if args.index_only:
            have = dst if os.path.isfile(dst) else src if os.path.isfile(src) else None
            if not have:
                print(f'  ! missing: {dst}  ({users[0]})')
                index['missing'].append(rel)
                missing += 1
                continue
            size = os.path.getsize(have)
            total_bytes += size
            index['files'][rel] = {'bytes': size, 'used_by': users, **({'generated': True} if old_files.get(rel, {}).get('generated') else {})}
            if rel.lower().endswith('.bmp'):
                index['png_twins'][rel] = rel[:-4] + '.png'
            skipped += 1
            continue
        if not os.path.isfile(src):
            if os.path.isfile(dst):      # generated asset (e.g. assets/terrain/*.png)
                size = os.path.getsize(dst)
                index['files'][rel] = {'bytes': size, 'used_by': users, 'generated': True}
                total_bytes += size
                skipped += 1
                continue
            print(f'  ! missing source: {src}  ({users[0]})')
            index['missing'].append(rel)
            missing += 1
            continue
        size = os.path.getsize(src)
        total_bytes += size
        index['files'][rel] = {'bytes': size, 'used_by': users}
        if os.path.isfile(dst) and os.path.getsize(dst) == size:
            skipped += 1
        else:
            copied += 1
            if not args.dry_run:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
        if rel.lower().endswith('.bmp'):
            png_rel = rel[:-4] + '.png'
            png_dst = os.path.join(args.media, rest[:-4] + '.png')
            index['png_twins'][rel] = png_rel
            if not args.dry_run and not os.path.isfile(png_dst):
                im = Image.open(src).convert('RGBA')
                px = im.load()
                w, h = im.size
                for y in range(h):          # magenta is WBC3's transparency key
                    for x in range(w):
                        r, g, b, a = px[x, y]
                        if r > 230 and g < 40 and b > 230:
                            px[x, y] = (0, 0, 0, 0)
                im.save(png_dst)
                converted += 1

    frames_path = os.path.join(args.assets, 'frames.json')
    frames_used = 0
    if os.path.isfile(frames_path):
        frames = json.load(open(frames_path, encoding='utf-8'))
        used = {k: v for k, v in frames.items() if k in refs}
        frames_used = len(used)
        if not args.dry_run:
            json.dump(used, open(os.path.join(args.assets, 'frames_used.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)

    index['summary'] = {'referenced': len(refs), 'copied': copied, 'already_present': skipped, 'missing': missing,
                        'bmp_to_png': converted, 'frames_used': frames_used, 'total_bytes': total_bytes,
                        'total_mb': round(total_bytes / 1e6, 1), 'dry_run': args.dry_run}
    if not args.dry_run:
        os.makedirs(args.assets, exist_ok=True)
        json.dump(index, open(os.path.join(args.assets, 'asset_index.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    print(json.dumps(index['summary'], indent=1))


if __name__ == '__main__':
    main()
