"""Detect the frame grid of every extracted WBC3 sprite sheet and write assets/frames.json.

Usage (from chaos_mapper/):  python chaosD6/tools/sheet_grid.py [extracted_root] [out_json]
"""
import sys, os, re, json, glob
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

# Row order of WBC3 8-direction sheets, verified visually (row 0 = unit facing away from the
# camera, clockwise; row 4 = facing the camera).
DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
UNIT_SUFFIX = {'': 'idle', 'w': 'walk', 'a': 'attack', 'd': 'death', 'f': 'fidget', 'c': 'cast', 's': 'special',
               'i': 'info', 'z': 'construction'}
TAG_RE = re.compile(r'\[([A-Za-z][A-Za-z0-9]{3})([a-z]?)\]\.png$')


def boundary_grid(prof, L, lo=16):
    best = 1
    for n in range(2, 129):
        if L % n:
            continue
        p = L // n
        if p < lo:
            break
        ok = 0
        for k in range(1, n):
            x = k * p
            if prof[max(0, x - 1):x + 2].min() == 0:
                ok += 1
        if ok / (n - 1) >= 0.85:
            best = n
    return best


def clean_cut_grid(prof, L, cell_h, lo=16, tol=0.05, aspect=(0.4, 2.2)):
    """Finest divisor whose cut columns carry <= tol of the peak column content, cells are
    plausibly shaped for the known row height, and at most 25% of cells are empty.
    Robust against sprites that touch their cell edge (no fully transparent gutter)."""
    prof = prof.astype(float)
    mx = prof.max()
    if mx <= 0:
        return 1
    best = 1
    for n in range(2, 129):
        if L % n:
            continue
        cw = L // n
        if cw < lo:
            break
        if not (aspect[0] * cell_h <= cw <= aspect[1] * cell_h):
            continue
        cutmax = max(prof[k * cw - 1:k * cw + 1].max() for k in range(1, n)) / mx
        if cutmax > tol:
            continue
        cents = []
        empty = 0
        for k in range(n):
            seg = prof[k * cw:(k + 1) * cw]
            s = seg.sum()
            if s == 0:
                empty += 1
                continue
            cents.append((seg * np.arange(cw)).sum() / s / cw)
        if empty > n * 0.25 or (len(cents) > 1 and np.std(cents) > 0.08):
            continue
        best = n
    return best


def corr_grid(prof, L, lo=20):
    scores = []
    for n in range(2, 129):
        if L % n:
            continue
        p = L // n
        if p < lo:
            break
        segs = prof[:p * n].reshape(n, p).astype(float)
        m = segs.mean(0)
        if m.std() == 0:
            continue
        c = [np.corrcoef(s, m)[0, 1] for s in segs if s.std() > 0]
        if len(c) < n * 0.8:
            continue
        scores.append((n, float(np.mean(c))))
    if not scores:
        return 1, 0.0
    mx = max(s for _, s in scores)
    if mx < 0.6:
        return 1, mx
    cands = [n for n, s in scores if s >= mx - 0.05]
    return max(cands), mx


def detect_axis(prof, L):
    n = boundary_grid(prof, L)
    if n > 1:
        return n, 'boundary', 1.0
    n, sc = corr_grid(prof, L)
    if n == 2 and sc < 0.97:
        # symmetric images (UI frames, icons) produce a spurious 2-fold correlation
        return 1, 'none', sc
    return n, ('correlation' if n > 1 else 'none'), sc


def ratio_grid(w, h, lo=24):
    """Strip fallback: pick the divisor whose cell width is closest to the strip height (square-ish frames)."""
    best = None
    for n in range(2, 129):
        if w % n:
            continue
        cw = w // n
        if cw < lo:
            break
        if cw > 2.5 * h:
            continue
        d = abs(cw - h)
        if best is None or d < best[1]:
            best = (n, d)
    return best[0] if best else 1


def classify(rel):
    """Return (anim, category) from the asset path."""
    parts = rel.replace('\\', '/').split('/')
    category = parts[2] if len(parts) > 2 else 'Misc'   # Units / Buildings / Effects / Misc / Terrain Features
    m = TAG_RE.search(os.path.basename(rel))
    suf = m.group(2) if m else None
    name = os.path.basename(rel)
    if category == 'Buildings':
        anim = {'': 'base', 'i': 'info', 'z': 'construction'}.get(suf, None)
        if anim is None:
            anim = 'variant' if ' - variant' in name else ('base' if suf is None else 'base')
    elif category == 'Units':
        anim = UNIT_SUFFIX.get(suf, 'idle') if suf is not None else 'idle'
    else:
        anim = 'info' if suf == 'i' else 'effect'
    return anim, category, suf


def analyse(path, rel):
    im = Image.open(path)
    a = np.array(im.convert('RGBA'))[:, :, 3] > 0
    h, w = a.shape
    anim, category, suf = classify(rel)
    col = a.sum(0)
    row = a.sum(1)
    entry = {'width': w, 'height': h}
    conf = 'high'
    method = 'assumed'

    if anim == 'info':
        cols, rows = 1, 1
        kind = 'info'
    elif anim == 'base' or anim == 'variant':
        cols, rows = 1, 1
        kind = 'single'
        if category == 'Misc' or w > 3 * h:
            # neutral map objects are animation strips
            n, method, sc = detect_axis(col, w)
            if n > 1:
                cols, kind = n, 'strip'
                conf = 'high' if method == 'boundary' else ('medium' if sc >= 0.8 else 'low')
    elif anim == 'construction':
        cols, rows, kind = 3, 1, 'construction'
        method = 'assumed'
        if w % 3:
            n, method, sc = detect_axis(col, w)
            cols = n
            conf = 'low'
    else:
        cols, method, sc = detect_axis(col, w)
        conf = 'high' if method == 'boundary' else ('medium' if sc >= 0.8 else 'low')
        if cols == 1 and w > 1.5 * h and category != 'Units':
            cols = ratio_grid(w, h)
            if cols > 1:
                method, conf = 'ratio', 'low'
        if cols == 1 and w <= 1.5 * h:
            method, conf = 'assumed', 'medium'
        rows = 1
        if category == 'Units' and anim in ('idle', 'walk', 'attack', 'fidget', 'cast', 'special'):
            if h % 8 == 0 and h // 8 >= 24:
                rows = 8
                rn, rmethod, rsc = detect_axis(row, h)
                if rn not in (8, 1, 2, 4) and rsc > 0.9:
                    rows = rn
            else:
                rows, rmethod, rsc = detect_axis(row, h)
        elif category == 'Units' and anim == 'death':
            rn, rmethod, rsc = detect_axis(row, h)
            rows = rn if rn in (1, 8) else (8 if h % 8 == 0 and rsc > 0.7 else 1)
            if cols == 1 and w > 1.5 * (h // rows):
                cols = ratio_grid(w, h // rows)
                if cols > 1:
                    method, conf = 'ratio', 'low'
        else:
            rn, rmethod, rsc = detect_axis(row, h)
            if rn > 1 and h // rn >= 24 and (rmethod == 'boundary' or rsc >= 0.8):
                rows = rn
        if category == 'Units':
            # Re-derive columns with the row height known: sprites that fill their cell edge to
            # edge defeat the strict gutter search and fall back to far too coarse a grid.
            n2 = clean_cut_grid(col, w, h // rows)
            if n2 > cols or (cols > 1 and w // cols < 0.4 * (h // rows)):
                cols, method, conf = n2, 'clean-cut', 'high'
        if cols == 1 and w > 2 * h:
            conf = 'low'
        kind ='unit-8dir' if rows == 8 and category == 'Units' else ('strip' if rows == 1 and cols > 1 else ('grid' if rows > 1 else 'single'))

    entry.update({'cols': cols, 'rows': rows, 'cell_w': w // cols, 'cell_h': h // rows, 'kind': kind,
                  'category': category, 'animation': anim})
    if kind == 'unit-8dir':
        entry['directions'] = DIRECTIONS
    if kind in ('info', 'single'):
        entry['fps'] = 0
        entry['loop'] = False
    elif category == 'Units':
        entry['fps'] = 12
        entry['loop'] = anim in ('idle', 'walk', 'fidget')
    elif kind == 'construction':
        entry['fps'] = 0
        entry['loop'] = False
    else:
        entry['fps'] = 10
        entry['loop'] = category in ('Misc', 'Terrain Features')
    entry['anchor'] = 'bottom-center'
    entry['method'] = method
    entry['confidence'] = conf
    return entry


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else 'extracted'
    out = sys.argv[2] if len(sys.argv) > 2 else 'chaosD6/assets/frames.json'
    files = sorted(glob.glob(os.path.join(root, 'Sprites', '**', '*.png'), recursive=True))
    result = {}
    for i, f in enumerate(files):
        rel = 'assets/' + os.path.relpath(f, root).replace('\\', '/')
        try:
            result[rel] = analyse(f, rel)
        except Exception as ex:
            result[rel] = {'error': str(ex)}
        if i % 200 == 0:
            print(i, len(files), flush=True)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(result, open(out, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    print('wrote', out, len(result))


if __name__ == '__main__':
    main()
