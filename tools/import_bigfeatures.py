#!/usr/bin/env python3
"""Curate a small set of WBC3 "big feature" terrain sprites — the large forest
clusters, dead-tree stands, boulder piles, pine clusters, cactus clumps — that act
as visual anchors spanning ~2 hex widths. They're imported from the extracted
Terrain-Features sprite set (which already has proper alpha, unlike the TxF .bmp
terrain tiles) and dropped into assets/terrain_bigfeatures/ alongside a catalog
JSON consumed by godot/scripts/BigFeature.gd.

We pick ~25 of the 60+ available: enough tree variety that a forest clump never
repeats the same sprite twice in a row, while boulders/ruins stay rare landmarks.
"""
import json
import os
import shutil
import sys
from pathlib import Path
from asset_root import media_path   # sprite PNGs go to the media root; the catalog stays in this repo

REPO = Path(__file__).resolve().parent.parent
EXTRACT = REPO.parent / "extracted" / "Sprites" / "Terrain Features"
DEST = REPO / "assets" / "terrain_bigfeatures"
CATALOG = DEST / "bigfeature_table.json"
MEDIA_DEST = Path(media_path("assets/terrain_bigfeatures"))

# Curated subset — each entry is (slug, source_rel_path, biomes, weight, label).
# Slug matches the pattern of assets/terrain_scatter/ files so the two layers read
# consistently. The source path is relative to EXTRACT.
CURATED = [
    # --- forests on temperate grass/high_grass (3) ---
    ("large_tree_cluster_fpm7.png",
        "GrassTrees/Large tree cluster/Large tree cluster - idle [FPM7].png",
        ["grass", "high_grass", "grass_coast", "jungle"], 4, "Large tree cluster"),
    ("large_leafy_tree_fpm8.png",
        "GrassTrees/Large leafy tree/Large leafy tree - idle [FPM8].png",
        ["grass", "high_grass", "jungle"], 3, "Large leafy tree"),
    ("fallen_log_fgmb.png",
        "GrassMisc/Fallen log/Fallen log - idle [FGMB].png",
        ["grass", "high_grass", "marsh"], 2, "Fallen log"),
    # --- grass misc (2) ---
    ("cave_mine_entrance_fgm1.png",
        "GrassMisc/Cave mine entrance in mossy rock/Cave mine entrance in mossy rock - idle [FGM1].png",
        ["grass", "high_grass", "rock"], 1, "Mossy mine entrance"),
    ("grey_boulder_cluster_fgm6.png",
        "GrassMisc/Grey boulder cluster/Grey boulder cluster - idle [FGM6].png",
        ["grass", "high_grass", "rock", "rock_coast"], 2, "Grey boulder cluster"),
    # --- dirt / wasteland dead trees (3) ---
    ("large_dead_tree_ftf0.png",
        "DirtTrees/Large dead tree/Large dead tree - idle [FTF0].png",
        ["dirt", "high_dirt"], 3, "Large dead tree"),
    ("large_dead_tree_ftf1.png",
        "DirtTrees/Large dead tree/Large dead tree - idle [FTF1].png",
        ["dirt", "high_dirt"], 3, "Large dead tree (alt)"),
    ("bare_dead_tree_large_ftb2.png",
        "DirtTrees/Bare dead tree (large)/Bare dead tree (large) - idle [FTB2].png",
        ["dirt", "high_dirt", "marsh"], 2, "Bare dead tree (large)"),
    # --- dirt / rock boulder cluster (1) ---
    ("boulder_cluster_large_frd5.png",
        "DirtMisc/Boulder cluster (large)/Boulder cluster (large) - idle [FRD5].png",
        ["dirt", "high_dirt", "rock", "rock_coast", "desert"], 2, "Boulder cluster"),
    # --- snow pines (3) ---
    ("snow_covered_pine_cluster_fpb7.png",
        "SnowTrees/Snow-covered pine cluster/Snow-covered pine cluster - idle [FPB7].png",
        ["snow", "snow_coast"], 4, "Snow pine cluster"),
    ("snow_covered_pine_large_fpb8.png",
        "SnowTrees/Snow-covered pine (large)/Snow-covered pine (large) - idle [FPB8].png",
        ["snow", "snow_coast"], 3, "Snow pine (large)"),
    ("snowy_fallen_log_large_fsf3.png",
        "SnowMisc/Snowy fallen log (large)/Snowy fallen log (large) - idle [FSF3].png",
        ["snow", "snow_coast"], 2, "Snowy fallen log (large)"),
    # --- desert palms + ruins (3) ---
    ("palm_tree_cluster_fdp4.png",
        "DesertTrees/Palm tree cluster/Palm tree cluster - idle [FDP4].png",
        ["desert", "jungle"], 3, "Palm tree cluster"),
    ("large_ruined_temple_fdm0.png",
        "DesertMisc/Large ruined temple/Large ruined temple - idle [FDM0].png",
        ["desert", "high_dirt"], 2, "Large ruined temple"),
    ("ruined_colonnade_fdm3.png",
        "DesertMisc/Ruined colonnade/Ruined colonnade - idle [FDM3].png",
        ["desert", "high_dirt"], 2, "Ruined colonnade"),
    # --- extra forest strips so grass/jungle/snow regions can grow real woods ---
    ("deciduous_tree_fpm2.png",
        "GrassTrees/Deciduous tree/Deciduous tree - idle [fpm2].png",
        ["grass", "high_grass", "grass_coast", "jungle", "marsh"], 3, "Deciduous tree"),
    ("deciduous_tree_fpm4.png",
        "GrassTrees/Deciduous tree/Deciduous tree - idle [FPM4].png",
        ["grass", "high_grass", "jungle"], 3, "Deciduous tree (broad)"),
    ("mossy_fallen_log_fgm9.png",
        "GrassMisc/Mossy fallen log/Mossy fallen log - idle [FGM9].png",
        ["grass", "high_grass", "jungle", "marsh"], 1, "Mossy fallen log"),
    ("palm_tree_cluster_fdp5.png",
        "DesertTrees/Palm tree cluster/Palm tree cluster - idle [FDP5].png",
        ["desert", "jungle"], 3, "Palm tree cluster (alt)"),
    ("snow_covered_pine_fpb2.png",
        "SnowTrees/Snow-covered pine/Snow-covered pine - idle [FPB2].png",
        ["snow", "snow_coast"], 3, "Snow pine"),
    ("snow_covered_pine_fpb3.png",
        "SnowTrees/Snow-covered pine/Snow-covered pine - idle [FPB3].png",
        ["snow", "snow_coast"], 3, "Snow pine (tall)"),
    ("snow_covered_rock_pile_frp0.png",
        "SnowMisc/Snow-covered rock pile/Snow-covered rock pile - idle [FRP0].png",
        ["snow", "snow_coast", "rock"], 1, "Snow-covered rock pile"),
    ("bare_dead_tree_ftb4.png",
        "DirtTrees/Bare dead tree/Bare dead tree - idle [FTB4].png",
        ["dirt", "high_dirt", "marsh"], 2, "Bare dead tree"),
    ("shipwreck_large_fsh0.png",
        "OtherMisc/Shipwreck (large)/Shipwreck (large) - idle [FSH0].png",
        ["grass_coast", "rock_coast", "snow_coast"], 1, "Shipwreck"),
]


# Density per biome. Forest biomes are dense (and pack with min_separation 1, see
# MIN_SEP_BY_BIOME) so trees overlap into real woods; boulders/ruins stay rare
# landmarks. BigFeature also multiplies by a grove noise field (0.15..1.8) so
# the woods come in clumps of 3-6 trees with glades between.
DENSITY = {
    "grass": 0.16, "high_grass": 0.16, "grass_coast": 0.06,
    "dirt": 0.035, "high_dirt": 0.03,
    "desert": 0.03, "desert_cliffs": 0.0,
    "snow": 0.12, "snow_coast": 0.05,
    "rock": 0.025, "rock_coast": 0.03, "rock_cliffs": 0.0,
    "jungle": 0.18, "marsh": 0.05,
    "mountains": 0.0, "water": 0.0, "lava": 0.0, "caverns": 0.0,
}

# Poisson radius default is MIN_SEP; forest biomes use 0 (no spacing at all) so
# neighbouring 2-hex-wide canopies overlap into a continuous wood inside a grove.
MIN_SEP = 5
MIN_SEP_BY_BIOME = {
    "grass": 0, "high_grass": 0, "jungle": 0, "snow": 0,
    "marsh": 2, "grass_coast": 2,
    "dirt": 3, "desert": 3, "snow_coast": 3,
}


def main() -> int:
    if not EXTRACT.is_dir():
        print(f"missing source: {EXTRACT}", file=sys.stderr)
        return 2
    DEST.mkdir(parents=True, exist_ok=True)
    MEDIA_DEST.mkdir(parents=True, exist_ok=True)

    # Index entries by biome so the Godot loader can look up a per-biome list without
    # scanning the full catalog on every hex.
    by_biome: dict[str, list[dict]] = {b: [] for b in DENSITY}
    items: list[dict] = []
    copied = 0
    for slug, rel, biomes, weight, label in CURATED:
        src = EXTRACT / rel
        if not src.is_file():
            print(f"MISSING: {src}", file=sys.stderr)
            return 3
        dst = MEDIA_DEST / slug
        if not dst.exists() or dst.stat().st_size != src.stat().st_size:
            shutil.copy2(src, dst)
            copied += 1
        # Pre-measure so the layer knows the native sprite size without touching disk.
        try:
            from PIL import Image
            with Image.open(dst) as img:
                w, h = img.size
        except Exception as e:
            print(f"size probe failed for {dst}: {e}", file=sys.stderr)
            return 4
        entry = {
            "id": "wbc3/%s" % slug.rsplit(".", 1)[0].rsplit("_", 1)[-1].upper(),
            "label": label,
            "path": "assets/terrain_bigfeatures/" + slug,
            "weight": weight,
            "native_w": w,
            "native_h": h,
            "biomes": biomes,
        }
        items.append(entry)
        for b in biomes:
            if b in by_biome:
                by_biome[b].append(entry)

    catalog = {
        "_comment": (
            "Big (multi-hex-looking) landmark features — forests, boulder clusters, "
            "ruins, pine stands. Scaled ~2 hex widths wide by BigFeatureLayer so each "
            "sprite visually anchors a region. Deterministic from (dim_seed, q, r); "
            "min_separation keeps them a visible landmark, not wallpaper."
        ),
        "min_separation": MIN_SEP,
        "min_separation_by_biome": MIN_SEP_BY_BIOME,
        "density": DENSITY,
        "by_biome": by_biome,
    }
    CATALOG.write_text(json.dumps(catalog, indent=2))
    print(f"wrote {CATALOG}  ({len(items)} items, {copied} newly-copied)")
    # Human-readable biome summary.
    for b in sorted(by_biome):
        n = len(by_biome[b])
        if n:
            print(f"  {b:14s} -> {n} options")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
