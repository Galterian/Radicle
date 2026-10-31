"""Verify every asset path referenced by data/*.json, assets/terrain/terrain_tiles.json and
assets/frames.json exists on disk (case-sensitive; frames.json keys may fall back to ../extracted).

Usage (from chaosD6/): python3 tools/check_assets.py [--fix-frames]
Exit 0 = all hard references resolved, non-zero otherwise.
"""
import json, os, glob, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTRACTED = os.path.join(os.path.dirname(ROOT), 'extracted')
_cache = {}


def listing(d):
    if d not in _cache:
        try:
            _cache[d] = set(os.listdir(d))
        except OSError:
            _cache[d] = set()
    return _cache[d]


def exists_cs(base, rel):
    cur = base
    for p in rel.split('/'):
        if p not in listing(cur):
            return False
        cur = os.path.join(cur, p)
    return True


def found(rel):
    if exists_cs(ROOT, rel):
        return True
    return rel.startswith('assets/') and exists_cs(EXTRACTED, rel[len('assets/'):])


def main():
    fix = '--fix-frames' in sys.argv
    hard = set()
    for f in glob.glob(os.path.join(ROOT, 'data', '*.json')) + [os.path.join(ROOT, 'assets', 'terrain', 'terrain_tiles.json')]:
        if os.path.isfile(f):
            txt = open(f, encoding='utf-8').read()
            for m in re.finditer(r'"(assets/[^"]+\.(?:png|bmp|wav|json))"', txt):
                hard.add(m.group(1))
    bad_hard = sorted(r for r in hard if not exists_cs(ROOT, r))
    print(f'hard references: {len(hard)}, missing: {len(bad_hard)}')
    for r in bad_hard[:20]:
        print('  MISSING', r)

    fp = os.path.join(ROOT, 'assets', 'frames.json')
    if os.path.isfile(fp):
        frames = json.load(open(fp, encoding='utf-8'))
        bad = [k for k in frames if not found(k)]
        print(f'frames.json keys: {len(frames)}, not found (assets/ or ../extracted/): {len(bad)}')
        if bad and fix:
            out = {}
            repaired = 0
            for k, v in frames.items():
                if k in bad:
                    d = os.path.dirname(k)
                    base = ROOT if exists_cs(ROOT, d) else EXTRACTED
                    rel_d = d if base == ROOT else d[len('assets/'):]
                    names = [n for n in listing(os.path.join(base, rel_d)) if n.endswith('.png')]
                    fn = os.path.basename(k)
                    tag = re.search(r'\[([^\]]+)\]\.png$', fn)
                    cands = [n for n in names if tag and n.endswith(f'[{tag.group(1)}].png')] or \
                            [n for n in names if n.startswith(fn[:-4].rstrip('… .-'))]
                    if len(cands) == 1 and cands[0] != fn:
                        out[d + '/' + cands[0]] = v
                        repaired += 1
                        continue
                out[k] = v
            json.dump(out, open(fp, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
            print(f'repaired {repaired} keys')
        for k in bad[:20]:
            print('  NOFILE', k)
    return 1 if bad_hard else 0


if __name__ == '__main__':
    sys.exit(main())
