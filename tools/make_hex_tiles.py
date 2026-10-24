"""Cut hex-shaped ground tiles out of the WBC3 terrain texture blocks.

Geometry matches game/js/hex.js: HEX_SIZE 46, corners at 60*i-30 degrees, y squashed by 0.72.
Tiles are produced at 2x (160x133) so the renderer can downscale them crisply.

    python tools/make_hex_tiles.py [--src ../extracted/Images/Terrain] [--out assets/terrain]
"""
import argparse, glob, json, math, os, random, re
import numpy as np
from PIL import Image, ImageDraw

HEX_SIZE = 46
H_SQUASH = 0.72
SCALE = 2
VARIANTS = 4
SS = 4  # mask supersampling

# chaosD6 terrain names (game/js/map.js) -> preferred WBC3 tileset
CHAOS_TERRAIN = {
    'ash': 'Caverns',
    'cinder': 'Rock',
    'basalt': 'Dirt',
    'ember': 'Lava',
}
# data/elements.json ids -> tileset
ELEMENT_TERRAIN = {
    'elem_vitality': 'Grass',
    'elem_souls': 'Caverns',
    'elem_time': 'Desert',
    'elem_space': 'Water',
    'elem_air': 'High Grass',
    'elem_water': 'Water',
    'elem_earth': 'Mountains',
    'elem_fire': 'Lava',
    'elem_concentration': 'High Dirt',
    'elem_harmony': 'Jungle',
}
# wiki terrain-design names that the manifest uses
WIKI_DESIGN = {
    'Grass': 'Terrain design: Grass', 'High Grass': 'Terrain design: High Grass', 'Dirt': 'Terrain design: Dirt',
    'High Dirt': 'Terrain design: High Dirt', 'Jungle': 'Terrain design: Jungle', 'Snow': 'Terrain design: Snow',
    'Marsh': 'Terrain design: Marsh', 'Mountains': 'Terrain design: Mountains', 'Desert': 'Terrain design: Desert',
    'Rock': 'Terrain design: Rock', 'Lava': 'Terrain design: Lava', 'Water': 'Terrain design: Shallow Water',
    'Caverns': 'Terrain type: Rock', 'Grass Coast': 'Terrain design: Grass', 'Rock Coast': 'Terrain design: Rock',
    'Snow Coast': 'Terrain design: Snow', 'Desert Cliffs': 'Terrain design: Desert', 'Rock Cliffs': 'Terrain design: Rock',
}


def slug(name):
    return re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')


def hex_mask(w, h):
    big = Image.new('L', (w * SS, h * SS), 0)
    cx, cy = w * SS / 2, h * SS / 2
    size = HEX_SIZE * SCALE * SS
    pts = []
    for i in range(6):
        a = math.radians(60 * i - 30)
        pts.append((cx + size * math.cos(a), cy + size * math.sin(a) * H_SQUASH))
    ImageDraw.Draw(big).polygon(pts, fill=255)
    return big.resize((w, h), Image.LANCZOS)


def plain_blocks(files):
    plain = [f for f in files if re.match(r'T..X\d*\.bmp$', os.path.basename(f), re.I)]
    return plain or files


def load_rgb(path):
    im = Image.open(path).convert('RGB')
    if im.size[0] >= 640:
        im = im.resize((im.size[0] // 2, im.size[1] // 2), Image.LANCZOS)
    return im


def keyed_fraction(arr):
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    magenta = (r > 230) & (g < 40) & (b > 230)
    black = (r == 0) & (g == 0) & (b == 0)
    return float((magenta | black).mean())


def pick_patches(blocks, w, h, n, rng):
    """Return n (block_path, x, y) patches: uniform ground, no keyed pixels, spread across blocks."""
    cands = []
    for bp in blocks:
        im = load_rgb(bp)
        arr = np.asarray(im).astype(np.float32)
        bw, bh = im.size
        if bw < w or bh < h:
            continue
        for _ in range(40):
            x = rng.randint(0, bw - w)
            y = rng.randint(0, bh - h)
            patch = arr[y:y + h, x:x + w]
            if keyed_fraction(patch) > 0.02:
                continue
            cands.append((float(patch.std()), bp, x, y))
    if not cands:
        return []
    cands.sort()
    # keep the calmest 35% (plain ground, no walls/roads/cliffs/lava), then spread picks over blocks
    keep = cands[:max(n * 3, int(len(cands) * 0.35))]
    rng.shuffle(keep)
    nblocks = len(set(b for _, b, _, _ in keep))
    out, used = [], {}
    for std, bp, x, y in keep:
        if nblocks > 1 and used.get(bp, 0) >= max(1, -(-n // nblocks)):
            continue
        if any(b == bp and abs(x - ox) < w // 2 and abs(y - oy) < h // 2 for b, ox, oy in out):
            continue
        out.append((bp, x, y))
        used[bp] = used.get(bp, 0) + 1
        if len(out) == n:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    ap.add_argument('--src', default=os.path.join(root, '..', 'extracted', 'Images', 'Terrain'))
    ap.add_argument('--out', default=os.path.join(root, 'assets', 'terrain'))
    ap.add_argument('--contact', default=os.path.join(root, '..', '_test', 'hex_tiles.png'))
    args = ap.parse_args()

    w = int(round(math.sqrt(3) * HEX_SIZE * SCALE))
    h = int(round(2 * HEX_SIZE * H_SQUASH * SCALE))
    mask = hex_mask(w, h)
    os.makedirs(args.out, exist_ok=True)
    rng = random.Random(6)

    index = {'hex': {'size': HEX_SIZE, 'squash': H_SQUASH, 'scale': SCALE, 'tile_w': w, 'tile_h': h,
                     'orientation': 'pointy-top (corners at 60*i-30 deg), matches game/js/hex.js'},
             'chaos_terrain': {}, 'elements': {}, 'tilesets': {}}
    tiles_for_sheet = []
    for ts in sorted(os.listdir(args.src)):
        files = [f for f in sorted(glob.glob(os.path.join(args.src, ts, '*.bmp'))) if not f.lower().endswith('i.bmp')]
        if not files:
            continue
        patches = pick_patches(plain_blocks(files), w, h, VARIANTS, rng)
        if len(patches) < VARIANTS:
            patches = pick_patches(files, w, h, VARIANTS, rng)
        variants = []
        for i, (bp, x, y) in enumerate(patches):
            im = load_rgb(bp).crop((x, y, x + w, y + h))
            tile = Image.new('RGBA', (w, h), (0, 0, 0, 0))
            tile.paste(im, (0, 0), mask)
            name = f'{slug(ts)}_{i}.png'
            tile.save(os.path.join(args.out, name))
            arr = np.asarray(im).reshape(-1, 3).mean(0)
            variants.append({'file': f'assets/terrain/{name}', 'source': os.path.relpath(bp, args.src).replace(os.sep, '/'),
                             'crop': [x, y, w, h], 'avg_color': '#%02x%02x%02x' % tuple(int(v) for v in arr)})
            tiles_for_sheet.append((ts, tile))
        if not variants:
            continue
        avg = np.mean([[int(v['avg_color'][k:k + 2], 16) for k in (1, 3, 5)] for v in variants], axis=0)
        index['tilesets'][ts] = {
            'slug': slug(ts), 'variants': variants, 'avg_color': '#%02x%02x%02x' % tuple(int(v) for v in avg),
            'wiki_entity': WIKI_DESIGN.get(ts), 'transition_set': not any(re.match(r'T..X', os.path.basename(f)) for f in files),
            'source_dir': f'assets/Images/Terrain/{ts}'}
    for k, ts in CHAOS_TERRAIN.items():
        index['chaos_terrain'][k] = {'tileset': ts, 'variants': [v['file'] for v in index['tilesets'][ts]['variants']]}
    for k, ts in ELEMENT_TERRAIN.items():
        index['elements'][k] = {'tileset': ts, 'variants': [v['file'] for v in index['tilesets'][ts]['variants']]}
    with open(os.path.join(args.out, 'terrain_tiles.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, indent=2, ensure_ascii=False)

    # contact sheet
    cols = VARIANTS
    rows = len(index['tilesets'])
    sheet = Image.new('RGBA', (cols * (w + 8) + 220, rows * (h + 8)), (50, 50, 60, 255))
    d = ImageDraw.Draw(sheet)
    for r, (ts, info) in enumerate(index['tilesets'].items()):
        d.text((6, r * (h + 8) + h // 2 - 6), ts, fill=(255, 255, 0, 255))
        for c, v in enumerate(info['variants']):
            t = Image.open(os.path.join(root, v['file']))
            sheet.alpha_composite(t, (220 + c * (w + 8), r * (h + 8) + 4))
    os.makedirs(os.path.dirname(args.contact), exist_ok=True)
    sheet.save(args.contact)
    print(f'{sum(len(v["variants"]) for v in index["tilesets"].values())} tiles for {rows} tilesets -> {args.out}; contact sheet {args.contact}')


if __name__ == '__main__':
    main()
