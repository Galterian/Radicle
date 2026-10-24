#!/usr/bin/env python3
"""Expand chaosD6 terrain assets from the extracted WBC3 archive:
   1. Convert N varied base BMP tiles per biome into PNG and rewrite assets/terrain/terrain_tiles.json.
   2. Copy the v2 building sprites verified by the parallel agent and merge them into
      assets/features/feature_table.json.

   Idempotent: re-running overwrites PNGs and JSON catalogs with the same content.
"""
import json, os, shutil
from PIL import Image, ImageDraw


def _hex_mask(w, h):
    """Flat-top hex alpha mask sized (w, h) — matches Hex.gd (HEX_SIZE=46, H_SQUASH=0.72)
    with aspect 92:57 ≈ 1.6. Opaque inside the hex, 0 outside, 2px soft edge."""
    import math
    m = Image.new("L", (w, h), 0)
    cx, cy = w / 2, h / 2
    # Flat-top hex matching Hex.gd: width = 2*HEX_SIZE, height = 2*HEX_SIZE*H_SQUASH.
    # Aspect ry/rx = H_SQUASH = 0.72 → for a 320-wide tile, ry ≈ 115.
    rx = w * 0.50
    ry = rx * 0.72
    pts = []
    for i in range(6):
        a = i * math.pi / 3   # flat-top: start at EAST, step 60°
        pts.append((cx + rx * math.cos(a), cy + ry * math.sin(a)))
    # Draw a larger soft hex first, then the opaque inner hex.
    big = [(cx + (p[0] - cx) * 1.10, cy + (p[1] - cy) * 1.10) for p in pts]
    ImageDraw.Draw(m).polygon(big, fill=120)
    mid = [(cx + (p[0] - cx) * 1.05, cy + (p[1] - cy) * 1.05) for p in pts]
    ImageDraw.Draw(m).polygon(mid, fill=200)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m

CHAOS_ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPPER_ROOT  = os.path.dirname(CHAOS_ROOT)
EXTRACTED    = os.path.join(MAPPER_ROOT, "extracted")

DECODE   = json.load(open("/tmp/wbc3_tile_decode.json"))
FEATV2   = json.load(open("/tmp/features_v2.json"))

# chaosD6 biome key -> extracted folder name
CHAOS_TO_FOLDER = {
    "grass": "Grass", "high_grass": "High Grass", "grass_coast": "Grass Coast",
    "dirt": "Dirt", "high_dirt": "High Dirt",
    "desert": "Desert", "desert_cliffs": "Desert Cliffs",
    "snow": "Snow", "snow_coast": "Snow Coast",
    "rock": "Rock", "rock_coast": "Rock Coast", "rock_cliffs": "Rock Cliffs",
    "mountains": "Mountains", "jungle": "Jungle",
    "marsh": "Marsh", "water": "Water",
    "lava": "Lava", "caverns": "Caverns",
}

# When a biome has no base tiles (coast/cliff), fall back to its parent biome.
COAST_FALLBACK = {
    "grass_coast":   "grass",
    "snow_coast":    "snow",
    "rock_coast":    "rock",
    "rock_cliffs":   "rock",
    "desert_cliffs": "desert",
}

# Fill colours per biome (used by MapGen when terrain_tiles.json is missing OR as the
# flat-colour fallback). Kept in sync with MapGen.BIOME_FILL.
BIOME_FILL = {
    "grass": "#2d4a26", "high_grass": "#243d1f", "grass_coast": "#3a4e2e",
    "dirt": "#5a4a30", "high_dirt": "#4a3d26",
    "desert": "#b89866", "desert_cliffs": "#8a6a3a",
    "snow": "#c8d4de", "snow_coast": "#9eb0c0",
    "rock": "#4a4a52", "rock_coast": "#5e5a58", "rock_cliffs": "#3a383c",
    "mountains": "#5a5260", "jungle": "#1a3818", "marsh": "#334434",
    "water": "#1a4a68", "lava": "#8a2a16", "caverns": "#141a24",
}

MOVE_COST = {
    "grass": 1, "high_grass": 1, "grass_coast": 1,
    "dirt": 1, "high_dirt": 1,
    "desert": 2, "desert_cliffs": 999,
    "snow": 2, "snow_coast": 2,
    "rock": 2, "rock_coast": 2, "rock_cliffs": 999,
    "mountains": 999, "jungle": 2, "marsh": 3,
    "water": 999, "lava": 999, "caverns": 2,
}

WALKABLE = {
    k: (MOVE_COST[k] < 999) for k in MOVE_COST
}

TILE_W, TILE_H = 320, 240   # standard WBC3 tile size (per decoder report)
TILE_MAX_PER_BIOME = 20     # cap how many variants we actually copy (keep repo small)


def convert_tiles():
    """Convert BMP tiles -> PNG at a uniform size; return {biome: [paths]}."""
    out_dir = os.path.join(CHAOS_ROOT, "assets", "terrain")
    os.makedirs(out_dir, exist_ok=True)
    chaos_terrain = {}
    for chaos_key, folder in CHAOS_TO_FOLDER.items():
        src_folder = os.path.join(EXTRACTED, "Images", "Terrain", folder)
        decode_biome = DECODE["biomes"].get(folder, {})
        base_codes = list(decode_biome.get("suggested_varied_base_set", []))
        # If the biome has no base of its own, borrow the parent's.
        if not base_codes and chaos_key in COAST_FALLBACK:
            parent = COAST_FALLBACK[chaos_key]
            parent_folder = CHAOS_TO_FOLDER[parent]
            base_codes = list(DECODE["biomes"].get(parent_folder, {}).get("suggested_varied_base_set", []))
            src_folder = os.path.join(EXTRACTED, "Images", "Terrain", parent_folder)
        base_codes = base_codes[:TILE_MAX_PER_BIOME]
        variants = []
        for i, code in enumerate(base_codes):
            src = os.path.join(src_folder, code + ".bmp")
            if not os.path.isfile(src):
                continue
            try:
                img = Image.open(src).convert("RGBA")
            except Exception as e:
                print("  skip", src, "err=", e)
                continue
            if img.size != (TILE_W, TILE_H):
                img = img.resize((TILE_W, TILE_H), Image.LANCZOS)
            # Mask to a pointy-top hex so neighbouring tiles blend instead of
            # painting opaque rectangles over each other.
            img.putalpha(_hex_mask(TILE_W, TILE_H))
            dst_rel = "assets/terrain/wbc3_" + chaos_key + "_" + str(i) + ".png"
            dst_abs = os.path.join(CHAOS_ROOT, dst_rel)
            img.save(dst_abs)
            variants.append(dst_rel)
        chaos_terrain[chaos_key] = {
            "tileset": folder,
            "walkable": WALKABLE[chaos_key],
            "move_cost": MOVE_COST[chaos_key],
            "fill": BIOME_FILL[chaos_key],
            "variants": variants,
        }
        print(f"  {chaos_key:14s}  {len(variants):2d} tiles  (from {folder})")
    return chaos_terrain


def write_terrain_tiles(chaos_terrain):
    out_path = os.path.join(CHAOS_ROOT, "assets", "terrain", "terrain_tiles.json")
    cfg = {
        "hex": {"tile_w": TILE_W, "tile_h": TILE_H},
        "chaos_terrain": chaos_terrain,
    }
    json.dump(cfg, open(out_path, "w"), indent=2)
    print("wrote", out_path)


def copy_features():
    """Copy every v2 building sprite into assets/Sprites/... and rewrite feature_table.json."""
    bb_src = FEATV2.get("by_biome", {})
    bb_out = {}
    missing = 0
    for biome, items in bb_src.items():
        new_items = []
        for it in items:
            src_rel = it["path"]              # "extracted/Sprites/Buildings/.../X.png"
            src_abs = os.path.join(MAPPER_ROOT, src_rel)
            if not os.path.isfile(src_abs):
                print("  MISSING", src_rel)
                missing += 1
                continue
            # Mirror the path under assets/ (strip the extracted/ prefix).
            dst_rel = src_rel.split("extracted/", 1)[1]
            dst_rel = "assets/" + dst_rel
            dst_abs = os.path.join(CHAOS_ROOT, dst_rel)
            os.makedirs(os.path.dirname(dst_abs), exist_ok=True)
            if not os.path.isfile(dst_abs):
                shutil.copy2(src_abs, dst_abs)
            new = dict(it)
            new["path"] = dst_rel
            new_items.append(new)
        bb_out[biome] = new_items
    # Preserve density + min_sep from the agent output (it kept v1's).
    cfg = {
        "_comment": "Buildings/permanents placed on walkable biome hexes. Deterministic from (dim_seed, q, r). " \
                    "Expanded via tools/import_wbc3_terrain.py from parallel-agent catalog.",
        "min_separation": FEATV2.get("min_separation", 3),
        "density": FEATV2.get("density", {}),
        "by_biome": bb_out,
    }
    out_path = os.path.join(CHAOS_ROOT, "assets", "features", "feature_table.json")
    json.dump(cfg, open(out_path, "w"), indent=2)
    total = sum(len(v) for v in bb_out.values())
    print("wrote", out_path, "- %d entries, %d missing" % (total, missing))


def main():
    print("== convert terrain tiles ==")
    ct = convert_tiles()
    print("\n== write terrain_tiles.json ==")
    write_terrain_tiles(ct)
    print("\n== copy features + rewrite feature_table.json ==")
    copy_features()
    print("\ndone.")


if __name__ == "__main__":
    main()
