"""Copy every asset referenced by a `resources` key in data/*.json from ../extracted into assets/.

    python tools/collect_assets.py [--dry-run] [--src ../extracted] [--data data] [--assets assets]

Paths inside `resources` are repo-relative (`assets/<rest>`); the source is `<src>/<rest>`.
Copied .bmp files also get a .png twin next to them. Writes assets/asset_index.json and,
when assets/frames.json exists, the subset assets/frames_used.json.
"""
import argparse, glob, json, os, shutil, sys
from PIL import Image

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


def collect_refs(data_dir):
    refs = {}  # path -> list of "collection:entry_id:where"
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
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    refs = collect_refs(args.data)
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
        dst = os.path.join(args.assets, rest)
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
            png_dst = os.path.join(args.assets, rest[:-4] + '.png')
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
