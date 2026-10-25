#!/usr/bin/env python3
"""Enrich assets/features/feature_table.json so revealed regions show more
buildings, walls and towers (the "WBC3 map" look):

  * density x1.6 across the board, min_separation 5 -> 4
  * wall segments / ramparts / gates from the archive as kind "wall"
  * towers / keeps / interesting neutral buildings so every walkable biome has
    >= 7 entries
  * a `desc` string (<= 120 chars) on EVERY entry for the click-to-inspect UI,
    with `desc_status: "placeholder"` where the rules don't define a purpose yet

Sprites are copied from the extracted WBC3 archive into assets/Sprites/...
mirroring the archive layout (extracted/Sprites/Buildings/<race>/<name>/<file>).
Every path is verified on disk before the entry is written. Idempotent: re-running
updates descs/densities and only appends entries whose id isn't already present
for that biome.
"""
import json
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MANIFEST = REPO.parent / "extracted" / "warlords3_battlecry_manifest.json"
TABLE = REPO / "assets" / "features" / "feature_table.json"

DENSITY_MULT = 1.6
MIN_SEP = 4

# (race, name) -> [biomes], weight, kind. `race` is the manifest `race` field.
NEW_ENTRIES = [
    # --- walls (kind "wall") ---
    (("Shared", "Walls (neutral, 2x1 horizontal)"), ["grass", "grass_coast", "dirt", "rock", "rock_coast", "high_dirt"], 2, "wall"),
    (("Shared", "Walls (neutral, 1x2 vertical)"),   ["grass", "grass_coast", "dirt", "rock", "rock_coast", "high_dirt"], 2, "wall"),
    (("Shared", "Walls (neutral, 2x2 joint)"),      ["grass", "dirt", "rock", "high_dirt"], 1, "wall"),
    (("Shared", "Walls (good, 2x1 horizontal)"),    ["grass", "high_grass", "grass_coast", "snow"], 2, "wall"),
    (("Shared", "Walls (good, 1x2 vertical)"),      ["grass", "high_grass", "grass_coast", "snow"], 2, "wall"),
    (("Shared", "Walls (evil, 2x1 horizontal)"),    ["marsh", "caverns", "dirt", "high_dirt", "desert"], 2, "wall"),
    (("Shared", "Walls (evil, 1x2 vertical)"),      ["marsh", "caverns", "dirt", "high_dirt", "desert"], 2, "wall"),
    (("Shared", "Ramparts"),                        ["rock", "rock_coast", "high_dirt", "dirt", "desert", "snow_coast"], 2, "wall"),
    (("Shared", "Wall of Ice"),                     ["snow", "snow_coast"], 2, "wall"),
    (("Shared", "Wall of Thorns"),                  ["jungle", "high_grass"], 2, "wall"),
    (("Dark Elves", "Kargothian Gate"),             ["rock", "caverns", "rock_coast"], 1, "wall"),
    # --- towers / keeps ---
    (("Shared", "Tower (Empire)"),       ["grass", "grass_coast"], 2, "building"),
    (("Shared", "Tower (Knights)"),      ["grass"], 2, "building"),
    (("Shared", "Tower (Wood Elf)"),     ["high_grass", "jungle"], 2, "building"),
    (("Wood Elves", "Forest Tower"),     ["high_grass", "jungle"], 2, "building"),
    (("Knights", "Keep (level 1)"),      ["grass_coast", "grass"], 1, "building"),
    (("Shared", "Tower (Barbarian)"),    ["dirt"], 2, "building"),
    (("Shared", "Tower (Orc)"),          ["dirt", "high_dirt"], 2, "building"),
    (("Orcs", "Goblin Tower"),           ["dirt", "desert"], 2, "building"),
    (("Shared", "Tower (Minotaur)"),     ["high_dirt"], 2, "building"),
    (("Shared", "Tower (Dark Dwarf)"),   ["high_dirt", "rock"], 2, "building"),
    (("Shared", "Tower (Ssrathi)"),      ["desert", "jungle"], 2, "building"),
    (("Shared", "Tower (Swarm)"),        ["desert"], 2, "building"),
    (("Swarm", "Watcher"),               ["desert"], 1, "building"),
    (("Shared", "Tower (High Elf)"),     ["snow"], 2, "building"),
    (("High Elves", "White Tower (level 3)"), ["snow"], 1, "building"),
    (("Shared", "Tower (Fey)"),          ["snow", "snow_coast"], 2, "building"),
    (("Dwarves", "Citadel (level 1)"),   ["rock"], 1, "building"),
    (("Shared", "Tower (Dwarf)"),        ["rock_coast"], 2, "building"),
    (("Shared", "Tower (Plaguelords)"),  ["marsh"], 2, "building"),
    (("Shared", "Tower (Undead)"),       ["marsh"], 2, "building"),
    (("Shared", "Tower (Daemon)"),       ["caverns"], 2, "building"),
    (("Shared", "Tower (Dark Elf)"),     ["caverns"], 2, "building"),
    # --- interesting neutral / flavour buildings ---
    (("Empire", "Archway"),              ["grass", "grass_coast"], 2, "building"),
    (("Empire", "Barn"),                 ["grass"], 2, "building"),
    (("Fey", "Magic Pool"),              ["grass", "high_grass"], 2, "building"),
    (("Neutral", "Lair (Bandit camp)"),  ["grass", "dirt"], 2, "building"),
    (("Wood Elves", "Magic Well"),       ["high_grass", "jungle"], 2, "building"),
    (("Wood Elves", "Healing Orb"),      ["high_grass"], 1, "building"),
    (("Neutral", "Lair (Goblin)"),       ["dirt", "high_dirt"], 2, "building"),
    (("Neutral", "Lair (Gnoll hut)"),    ["dirt"], 2, "building"),
    (("Orcs", "Hovel"),                  ["dirt"], 1, "building"),
    (("Neutral", "Lair (Harpy nest)"),   ["high_dirt", "desert", "rock"], 2, "building"),
    (("Minotaurs", "Altar of Sartek"),   ["high_dirt"], 1, "building"),
    (("Ssrathi", "Hatchery"),            ["desert"], 1, "building"),
    (("Ssrathi", "Scrying Pool"),        ["desert", "jungle"], 1, "building"),
    (("Plaguelords", "Ice Cave"),        ["snow", "snow_coast"], 2, "building"),
    (("High Elves", "Dragon Shrine"),    ["snow", "snow_coast"], 1, "building"),
    (("High Elves", "Healer"),           ["snow_coast", "grass_coast"], 2, "building"),
    (("Dark Dwarves", "Guild"),          ["rock"], 1, "building"),
    (("Dark Dwarves", "Supply Depot"),   ["rock", "rock_coast"], 2, "building"),
    (("Dark Dwarves", "Trader"),         ["rock_coast"], 2, "building"),
    (("Undead", "Graveyard"),            ["marsh"], 2, "building"),
    (("Undead", "Gravestone"),           ["marsh", "dirt"], 2, "building"),
    (("Undead", "Barrow"),               ["marsh", "high_dirt"], 1, "building"),
    (("Ssrathi", "Sacred Pool"),         ["jungle"], 2, "building"),
    (("Neutral", "Snake/Dragon Temple"), ["jungle"], 1, "building"),
    (("Plaguelords", "Fire Cave"),       ["caverns"], 2, "building"),
    (("Daemons", "Portal"),              ["caverns"], 1, "building"),
    (("Neutral", "Shop (Blacksmith)"),   ["grass_coast", "rock_coast", "dirt"], 2, "building"),
    (("Neutral", "Shop (Alchemist)"),    ["grass_coast", "snow_coast"], 1, "building"),
]

# What each object is + its (placeholder) gameplay purpose. <= 120 chars.
# Entries present in the caller's rules are marked `given`; everything else is a
# placeholder for the click-to-inspect UI until the rules team fills it in.
GIVEN = {
    "Shrine": "Neutral shrine. Resting here restores 1 life per quiet round.",
    "Gold Mine (size 1)": "Resource node. Controlling it yields gold each turn.",
}
DESC = {
    # resources
    "Gold Mine (size 3)": "Rich gold mine. Controlling it yields extra gold each turn.",
    "Metal Mine (size 2)": "Metal mine. Controlling it yields metal for weapon upgrades each turn.",
    "Metal Mine (size 3)": "Deep metal mine. Controlling it yields extra metal each turn.",
    "Stone Quarry (size 1)": "Small quarry. Controlling it yields stone for walls and towers.",
    "Stone Quarry (size 2)": "Stone quarry. Controlling it yields stone each turn.",
    "Crystal Mine (size 2)": "Crystal mine. Controlling it yields crystal for spells each turn.",
    "Mill": "Windmill. Supplies grain: allied units resting adjacent heal 1 extra life.",
    "Barn": "Farm barn. Supply point: resting here refills one consumable card.",
    # knowledge / shrines / temples
    "Library": "Archive of lore. Visiting reveals one hidden skill of a nearby creature.",
    "Cathedral": "Great cathedral. Sanctuary: no attacks may be declared on this hex.",
    "Celestial Temple": "Temple of the heavens. Resting here cleanses a curse or poison.",
    "Shrine of the Sword": "Warrior shrine. Resting here grants +1 to the next Attack.",
    "Shrine of Melkor": "Shrine of the Swarm god. Resting here grants +1 to the next Block.",
    "Plague Shrine": "Diseased altar. Units ending a turn here lose 1 life unless undead.",
    "Sun Temple (level 2)": "Ssrathi sun temple. Resting here at noon restores 2 life.",
    "Ziggurat (level 2)": "Minotaur ziggurat. Stronghold: defenders here cannot be pushed back.",
    "Infernal Temple": "Daemonic temple. Resting here trades 1 life for a bonus action card.",
    "Dragon Shrine": "Shrine to the dragons. Resting here grants fire resistance for a round.",
    "Altar of Sartek": "Minotaur blood altar. Winning a fight adjacent heals the victor 1 life.",
    "Sacred Pool": "Ssrathi sacred pool. Resting here restores 2 life.",
    "Scrying Pool": "Scrying pool. Visiting reveals the map 6 hexes further around it.",
    "Magic Pool": "Fey magic pool. Resting here restores 1 life and refreshes a skill.",
    "Magic Well": "Wood Elf magic well. Drinking here refreshes one used skill.",
    "Healing Orb": "Healing orb. Any unit ending its turn adjacent heals 1 life.",
    "Healer": "Healer's house. Resting here restores all lost life once per visit.",
    "Snake/Dragon Temple": "Serpent temple. Guarded ruin: first visitor draws a bonus card.",
    # nature
    "Faerie Ring": "Mushroom ring. Resting here teleports you to another ring next round.",
    "White Tree": "Sacred white tree. Resting beneath it restores 1 life and clears fear.",
    "Unicorn Grove": "Unicorn grove. Units resting here cannot be ambushed.",
    "Tree of Life": "Tree of Life. Resting here restores 2 life per quiet round.",
    "Henge": "Standing stones. Resting here grants +1 range to the next ranged attack.",
    "Dragonstone": "Dragon-bone monolith. Flyers resting here gain +1 movement next turn.",
    "Totem": "Orc war totem. Allied units adjacent gain +1 Attack while it stands.",
    # military / towers / keeps
    "Scout Tower": "Barbarian scout tower. Standing on it reveals the map 8 hexes around.",
    "Lookout": "Minotaur lookout. Standing on it reveals the map 8 hexes around.",
    "Camp": "Barbarian camp. Resting here restores 1 life; ambushers get +1 Attack.",
    "Fortress (level 2)": "Barbarian fortress. Stronghold: defenders inside ignore the first hit.",
    "Keep (level 1)": "Knight keep. Stronghold: defenders inside ignore the first hit each round.",
    "Keep (level 2)": "Knight keep. Stronghold: defenders inside ignore the first hit each round.",
    "Dunekeep (level 2)": "Swarm dunekeep. Stronghold: defenders inside ignore the first hit.",
    "Citadel (level 1)": "Dwarven citadel. Stronghold: defenders inside ignore the first hit.",
    "Hall of Plague (level 2)": "Plaguelord hall. Stronghold; non-undead inside lose 1 life per round.",
    "Dark Tower (level 3)": "Dark Elf tower. Stronghold; occupant sees the whole revealed map.",
    "White Tower (level 1)": "High Elf tower. Standing here reveals 8 hexes and blocks ambush.",
    "White Tower (level 2)": "High Elf tower. Standing here reveals 8 hexes and blocks ambush.",
    "White Tower (level 3)": "High Elf tower. Standing here reveals 8 hexes and blocks ambush.",
    "Tower (High Elf)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Dwarf)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Knights)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Empire)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Wood Elf)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Barbarian)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Orc)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Minotaur)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Dark Dwarf)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Ssrathi)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Swarm)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Fey)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Plaguelords)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Undead)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Daemon)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Tower (Dark Elf)": "Watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Forest Tower": "Wood Elf tree tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Goblin Tower": "Goblin watch tower. Standing on it grants +1 range and reveals 8 hexes.",
    "Watcher": "Swarm watcher spire. Standing on it reveals 8 hexes around.",
    # walls
    "Walls (neutral, 2x1 horizontal)": "Stone wall segment. Blocks line of sight; cover: ranged attacks on this hex -1.",
    "Walls (neutral, 1x2 vertical)": "Stone wall segment. Blocks line of sight; cover: ranged attacks on this hex -1.",
    "Walls (neutral, 2x2 joint)": "Stone wall corner. Blocks line of sight; cover: ranged attacks on this hex -1.",
    "Walls (good, 2x1 horizontal)": "White stone wall. Blocks line of sight; cover: ranged attacks on this hex -1.",
    "Walls (good, 1x2 vertical)": "White stone wall. Blocks line of sight; cover: ranged attacks on this hex -1.",
    "Walls (evil, 2x1 horizontal)": "Black iron wall. Blocks line of sight; cover: ranged attacks on this hex -1.",
    "Walls (evil, 1x2 vertical)": "Black iron wall. Blocks line of sight; cover: ranged attacks on this hex -1.",
    "Ramparts": "Earthen rampart. Cover: defenders on this hex gain +1 Block.",
    "Wall of Ice": "Wall of ice. Cover: ranged attacks on this hex -1; melts if lava is adjacent.",
    "Wall of Thorns": "Living thorn hedge. Cover; entering costs 1 life unless you are Fey.",
    "Kargothian Gate": "Dark Elf gatehouse. Chokepoint: only one unit may pass per round.",
    # lairs / dark
    "Lair (Bandit camp)": "Bandit camp. Hostile lair: first visitor fights a bandit for loot.",
    "Lair (Goblin)": "Goblin lair. Hostile lair: first visitor fights goblins for loot.",
    "Lair (Gnoll hut)": "Gnoll hut. Hostile lair: first visitor fights a gnoll for loot.",
    "Lair (Harpy nest)": "Harpy nest. Hostile lair: first visitor fights a harpy for loot.",
    "Hovel": "Orc hovel. Resting here restores 1 life; orcs rest for 2.",
    "Hydra Cave": "Hydra cave. Hostile lair: first visitor fights a hydra for rare loot.",
    "Ice Cave": "Ice cave. Shelter: units resting here ignore cold damage.",
    "Fire Cave": "Fire cave. Shelter from the dark; resting here restores 1 life.",
    "Gallows": "Gallows. Fear aura: enemies adjacent lose 1 Posture at round start.",
    "Tomb": "Sealed tomb. Opening it (rest here) draws a relic card or a curse.",
    "Graveyard": "Graveyard. Undead resting here restore 2 life; others may be haunted.",
    "Gravestone": "Lone gravestone. Marker: a fallen hero's card may be recovered here.",
    "Barrow": "Burial mound. Opening it (rest here) draws a relic card or wakes a wight.",
    "Pit": "Daemon pit. Falling in costs 1 life; climbing out ends your turn.",
    "Black Portal": "Black portal. Resting here teleports you to another portal next round.",
    "Portal": "Daemon portal. Resting here teleports you to another portal next round.",
    "Archway": "Imperial archway. Waypoint: moving through it costs no movement.",
    "Guild": "Dark Dwarf guild hall. Trading post: swap one card for a random one.",
    "Supply Depot": "Supply depot. Resting here refills one consumable card.",
    "Trader": "Dark Dwarf trader. Trading post: swap one card for a random one.",
    "Shop (Blacksmith)": "Blacksmith. Trading post: upgrade one weapon card for gold.",
    "Shop (Alchemist)": "Alchemist. Trading post: buy a potion card for gold.",
    "Hatchery": "Ssrathi hatchery. Lair: first visitor fights hatchlings for loot.",
    "Foundry": "Dwarven foundry. Trading post: upgrade one armour card for metal.",
    "Furnace (level 3)": "Dark Dwarf furnace. Stronghold; adjacent hexes count as lava-warm.",
}


def main() -> int:
    manifest = json.loads(MANIFEST.read_text())
    ents = manifest["entities"]
    # (race, name) -> base sprite path relative to repo parent
    by_key = {}
    for e in ents.values():
        if e.get("type") != "building":
            continue
        base = [s for s in e["files"]["sprites"] if s.get("animation") == "base"]
        if base:
            by_key[(e.get("race"), e["name"])] = base[0]["path"]

    table = json.loads(TABLE.read_text())
    by_biome = table["by_biome"]

    # 1) density x1.6, min_separation 4
    if not table.get("_density_scaled"):
        table["density"] = {k: (round(v * DENSITY_MULT, 4) if v else 0) for k, v in table["density"].items()}
        table["_density_scaled"] = True
    table["min_separation"] = MIN_SEP

    # 2) new entries
    added = 0
    copied = 0
    missing = []
    for (race, name), biomes, weight, kind in NEW_ENTRIES:
        src_rel = by_key.get((race, name))
        if not src_rel:
            missing.append(f"{race}/{name} (not in manifest)")
            continue
        src = REPO.parent / src_rel
        if not src.is_file():
            missing.append(f"{race}/{name} (missing on disk: {src})")
            continue
        dst_rel = src_rel.replace("extracted/", "assets/", 1)
        dst = REPO / dst_rel
        if not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            copied += 1
        if not dst.is_file():
            missing.append(f"{race}/{name} (copy failed)")
            continue
        fid = f"{race}/{name}"
        for b in biomes:
            pool = by_biome.setdefault(b, [])
            hit = next((x for x in pool if x.get("id") == fid), None)
            if hit:
                hit["kind"] = kind  # e.g. Wall of Thorns building -> wall
                continue
            pool.append({"id": fid, "label": name, "weight": weight, "path": dst_rel, "kind": kind})
            added += 1

    # 3) descs on every entry
    undescribed = set()
    for b, pool in by_biome.items():
        for e in pool:
            label = e["label"]
            if label in GIVEN:
                e["desc"] = GIVEN[label]
                e.pop("desc_status", None)
            elif label in DESC:
                e["desc"] = DESC[label]
                e["desc_status"] = "placeholder"
            else:
                undescribed.add(label)
            if "desc" in e and len(e["desc"]) > 120:
                print(f"desc too long ({len(e['desc'])}): {label}", file=sys.stderr)
                return 5

    # 4) verify every path exists
    bad = [(b, e["id"]) for b, pool in by_biome.items() for e in pool if not (REPO / e["path"]).is_file()]
    if bad:
        print("missing sprite files:", bad, file=sys.stderr)
        return 3

    table["_comment"] = (
        "Buildings/permanents placed on walkable biome hexes. Deterministic from (dim_seed, q, r). "
        "Expanded via tools/import_wbc3_terrain.py and tools/expand_features.py (walls, towers, "
        "descs for the inspect UI). kind is building | wall; desc_status=placeholder marks purposes "
        "not yet backed by rules."
    )
    TABLE.write_text(json.dumps(table, indent=2, ensure_ascii=False) + "\n")

    print(f"wrote {TABLE}: +{added} entries, {copied} sprites copied")
    for b in sorted(by_biome):
        n = len(by_biome[b])
        walls = sum(1 for e in by_biome[b] if e.get("kind") == "wall")
        if n:
            print(f"  {b:14s} {n:2d} entries ({walls} walls)  density={table['density'].get(b)}")
    if missing:
        print("SKIPPED:", *missing, sep="\n  ", file=sys.stderr)
    if undescribed:
        print("NO DESC:", sorted(undescribed), file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
