#!/usr/bin/env python3
"""Copy a curated subset of extracted WBC3 terrain-features into assets/terrain_scatter/
and build scatter_table.json describing which biomes each decoration may appear on."""
import json, os, shutil, re, sys
from asset_root import media_path   # PNGs go to the media root; scatter_table.json stays in this repo

rows = json.load(open("/tmp/scatter_pick.json"))

# Which chaosd6 biomes each extracted family of decorations may appear on.
FAMILY_TO_BIOMES = {
    "GrassPlants": ["grass", "high_grass", "grass_coast"],
    "GrassTrees":  ["grass", "high_grass", "jungle"],
    "GrassMisc":   ["grass", "high_grass", "grass_coast", "dirt", "rock_coast"],
    "DirtMisc":    ["dirt", "high_dirt", "desert"],
    "DirtTrees":   ["dirt", "high_dirt"],
    "DesertTrees": ["desert", "desert_cliffs"],
    "DesertMisc":  ["desert", "desert_cliffs"],
    "SnowTrees":   ["snow", "snow_coast"],
    "SnowMisc":    ["snow", "snow_coast", "rock", "rock_coast"],
}

dst_dir = "assets/terrain_scatter"
os.makedirs(dst_dir, exist_ok=True)
os.makedirs(media_path(dst_dir), exist_ok=True)
entries = []
for r in rows:
    src = os.path.join("..", r["path"])
    slug = re.sub(r"[^a-z0-9]+", "_", r["name"].lower()).strip("_")
    code = r["code"].lower()
    dst_name = slug + "_" + code + ".png"
    dst_rel = dst_dir + "/" + dst_name
    dst_abs = media_path(dst_rel)
    if not os.path.isfile(dst_abs):
        shutil.copy2(src, dst_abs)
    biomes = FAMILY_TO_BIOMES.get(r["race"], [])
    entries.append({
        "id": "wbc3/" + r["code"],
        "label": r["name"],
        "path": dst_rel,
        "family": r["race"],
        "biomes": biomes,
    })

DENSITY = {
    "grass": 0.42, "high_grass": 0.45, "grass_coast": 0.38,
    "dirt": 0.30, "high_dirt": 0.28,
    "desert": 0.22, "desert_cliffs": 0.18,
    "snow": 0.32, "snow_coast": 0.30,
    "rock": 0.25, "rock_coast": 0.22, "rock_cliffs": 0.15,
    "jungle": 0.48, "marsh": 0.25,
    "mountains": 0.0, "water": 0.0, "lava": 0.0, "caverns": 0.0,
}
catalog = {
    "min_separation": 1,
    "density": DENSITY,
    "items": entries,
}
json.dump(catalog, open(dst_dir + "/scatter_table.json", "w"), indent=2)
print("wrote", len(entries), "items, catalog at", dst_dir + "/scatter_table.json")
pngs = [f for f in os.listdir(media_path(dst_dir)) if f.endswith(".png")]
print("copied PNGs:", len(pngs))
