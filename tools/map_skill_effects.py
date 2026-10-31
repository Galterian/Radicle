#!/usr/bin/env python3
"""Fill the missing `resources.sprites.effect` strips for skills in data/skills.json
from the extracted WBC3 archive. Copies the PNG under assets/Sprites/... (same
layout the other skills use) and records wbc3_name/wbc3_code like collect_assets.py.
Idempotent: skills that already have an effect strip are left alone."""
import json, os, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPPER = os.path.dirname(ROOT)
MANIFEST = json.load(open(os.path.join(MAPPER, "extracted", "warlords3_battlecry_manifest.json")))

# skill id -> (manifest effect name, why it fits)
PICK = {
    "skill_grapple":         ("Grey crescent arcs",                   "grey arcs wrap the target like a grip"),
    "skill_barricade":       ("Grey ring arcs",                       "stone-grey ring around the holder's tile"),
    "skill_disruption_move": ("Grey arc sweeps",                      "sweeping arcs for the disruptive dash"),
    "skill_dodge":           ("Spell effect: faint white rings",      "faint after-image rings of the dodge"),
    "skill_bluff":           ("Spell effect: small purple ring/spiral", "purple spiral for the feint/illusion"),
    "skill_intimidation":    ("Red crescent arcs",                    "red arcs of the fear aura"),
}
USAGE = "marker/animation strip shown on the skill target hex (cols = frames)"

skills_path = os.path.join(ROOT, "data", "skills.json")
doc = json.load(open(skills_path))
by_id = {s["id"]: s for s in doc["entries"]}

for sid, (name, why) in PICK.items():
    s = by_id[sid]
    res = s.setdefault("resources", {"source": "warlords3_battlecry", "sprites": {}, "sounds": {}})
    if res.get("sprites", {}).get("effect", {}).get("path"):
        print("keep  ", sid)
        continue
    ent = MANIFEST["entities"][name]
    sp = [x for x in ent["files"]["sprites"] if "info" not in x["path"].lower()][0]
    local = "assets/" + sp["path"].split("extracted/", 1)[1]
    src = os.path.join(MAPPER, sp["path"])
    dst = os.path.join(ROOT, local)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if not os.path.isfile(dst):
        shutil.copy2(src, dst)
    res.setdefault("sprites", {})["effect"] = {"path": local, "usage": USAGE}
    res["wbc3_name"] = name
    res["wbc3_code"] = (ent.get("codes") or [""])[0]
    res["wbc3_race"] = ent.get("race", "Effects1")
    res["match_reason"] = (res.get("match_reason") or "") + ("; " if res.get("match_reason") else "") + why
    print("mapped", sid, "->", name, local)

json.dump(doc, open(skills_path, "w"), indent=2, ensure_ascii=False)
print("wrote", skills_path)
