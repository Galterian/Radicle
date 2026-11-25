"""Enrich data/characters.json, classes.json, creatures.json with WBC3 asset `resources`.

Idempotent: re-running replaces the entry-level `resources` key. Paths are written as
`assets/...` (mirror of chaos_mapper/extracted/...). Source catalogue is the WBC3 manifest.
"""
import glob
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTRACTED = os.path.join(os.path.dirname(ROOT), 'extracted')
DATA = os.path.join(ROOT, 'data')

# entry_id: (wbc3 entity name, reason, confidence, portrait number or None)
CHARACTERS = {
    'char_oran_rief': ('Gladewarden', 'ranger survivalist (vitality adept, M/B/P combo) -> Wood Elf forest ranger archer', 'high', 21),
    'char_pride_guardian': ('Knight Champion', 'guardian tag, world/time pillars; armoured champion of a knightly pride', 'high', 0),
    'char_exuberant_firestroker': ('Red Mage', 'fire-adept caster -> Empire fire mage (Ring of Fire caster)', 'high', 49),
    'char_razorfin_abolisher': ('Naga', 'space-adept matter-20 caster with aquatic "razorfin" theme -> Ssrathi Naga spellcaster', 'medium', 13),
    'char_manor_skeleton': ('Skeleton', 'undead tag -> Undead Skeleton', 'high', 52),
    'char_rhox_bodyguard': ('Khazrimi Guard', 'balanced heavy bodyguard -> elite dwarven guard unit', 'medium', 25),
    'char_sanctum_gargoyle': ('Imp', 'astral winged stone gargoyle -> grey winged Imp', 'medium', 62),
    'char_moonglove_changeling': ('Ice Maiden', 'mental/will-21 moon-themed changeling -> High Elf Ice Maiden (moon caster)', 'medium', 61),
    'char_behemoth_herald': ('Warlord', 'warrior with vitality 18 -> Barbarian Warlord', 'high', 23),
    'char_cynder_pyromancer': ('Daemon Hero', 'pyromancer caster -> Daemon race hero (fire-themed, has cast/spell animations and hero voice)', 'medium', 42),
    'char_akki_coalfinger': ('Goblin Shaman', 'Akki are goblins; earth-adept caster -> Goblin Shaman', 'high', 41),
    'char_godtracker_jund': ('Lizard Rider', 'Jund = dragon/lizard jungle; air-adept tracker -> Ssrathi Lizard Rider', 'medium', 53),
}

CREATURES = {
    'mon_ruinous_minotaur': ('Minotaur', 'minotaur bruiser -> Minotaur', 'high'),
    'mon_ridge_runnet_3a': ('Scorpionman', 'ridge-dwelling brute (vit 20, +1 on Attack) -> Swarm Scorpionman', 'low'),
    'mon_hellkite_hatchling': ('Wyvern', 'young dragon-kin flyer -> Wyvern (smaller dragon-kin)', 'medium'),
    'mon_cloudhearth_drake_2a': ('Storm Dragon', 'cloud-themed drake flyer -> Storm Dragon', 'medium'),
    'mon_harbor_serpent': ('Hydra', 'water serpent brute -> many-headed Hydra', 'medium'),
    'mon_tangle_spider_2b': ('Queen Spider', 'web-weaving caster spider (Creation innate) -> Queen Spider', 'high'),
    'mon_cliffy_serpent': ('Pterodactyl', 'cliff-dwelling flying serpent -> Pterodactyl', 'low'),
    'mon_bant_battlemage_3p': ('Inquisitor', 'armoured battlemage caster (Love innate) -> Knights Inquisitor caster', 'medium'),
    'mon_angel_of_mercy': ('Archon', 'angel caster (Awe innate) -> celestial Archon', 'high'),
    'mon_pathrazer_of_ulamog': ('Daemon', 'eldritch winged brute -> Daemon', 'medium'),
    'mon_dragon': ('Fire Dragon', 'boss dragon -> Fire Dragon', 'high'),
    'mon_canyon_minotaur': ('Minotaur King', 'minotaur bruiser variant (Earthquake) -> Minotaur King (distinct from Ruinous Minotaur)', 'high'),
    'mon_selftower_sphynx': ('Griffon', 'sphinx (lion body, wings) control monster -> Griffon', 'medium'),
    'mon_sigiled_behemoth': ('Triceratops', 'massive armoured brute -> Triceratops', 'medium'),
    'mon_rakewalk_gargantuan': ('Ironbark', 'gargantuan bruiser (Anger) -> giant tree titan Ironbark', 'medium'),
    'mon_nacatl_hunt_pride': ('Wolf Rider', 'pack hunters (Mists) -> Wolf Rider pack', 'medium'),
    'mon_rhox_brute': ('Troll', 'rhino-man brute -> Troll', 'medium'),
    'mon_everbark_shaman': ('Treant', 'tree-bark defender shaman -> Treant', 'high'),
    'mon_bonebreaker_giant': ('Giant', 'giant bruiser -> Orc Giant', 'high'),
    'mon_steambeam_aquitect': ('Engineer', 'steam/artifice architect -> Dark Dwarf Engineer', 'medium'),
    'mon_greater_basilisk': ('Basilisk', 'basilisk (Petrify) -> Basilisk', 'high'),
    'mon_cavern_thoctar': ('Tyrannosaurus Rex', 'huge cave beast brute -> T. Rex', 'medium'),
    'mon_etherium_abomination': ('Bronze Golem', 'metal construct abomination caster (Fear) -> Bronze Golem', 'medium'),
    'mon_siegemind_ogre': ('Ogre', 'ogre -> Ogre', 'high'),
    'mon_ember_weaver': ('Fire Elemental', 'ember/fire weaving caster -> Fire Elemental', 'high'),
    'mon_infectious_horror': ('Plague Priest', 'infectious fear caster -> Plaguelords Plague Priest', 'medium'),
    'mon_summit_apes': ('Gnoll', 'mountain ape pack bruiser -> Gnoll beastmen', 'low'),
    'mon_guardian_of_coverdell': ('Stone Golem', 'immovable defender (+1 on Block) -> Stone Golem', 'high'),
    'mon_loxodon_mystic': ('Elephant', 'loxodon = elephant-folk mystic -> Elephant', 'medium'),
}

CLASSES = {
    'class_weapon_master': ('Dwarf Berserker', 'dual-axe weapon master -> Dwarf Berserker', 'high', 10),
    'class_animator': ('Dark Dwarf Hero', 'trap-animating tinkerer -> Dark Dwarf hero (cast/special anims)', 'medium', 36),
    'class_druid': ('Druid', 'druid -> Wood Elf Druid', 'high', 15),
    'class_enchanter': ('High Elf Hero', 'element-emitting enchanter -> High Elf hero caster', 'medium', 18),
    'class_elementalist': ('Black Mage', 'elemental damage caster -> Empire Black Mage', 'high', 1),
    'class_transmuter': ('Minotaur Hero', 'transmuter sharing effects -> Minotaur race hero caster', 'low', 45),
    'class_alchemist': ('Dwarf Hero', 'alchemist/trap brewer -> Dwarf hero', 'medium', 32),
    'class_summoner': ('Summoner', 'summoner -> Daemon Summoner', 'high', 8),
    'class_illusionist': ('Moonguard', 'damage-ignoring illusionist -> High Elf Moonguard', 'medium', 70),
    'class_healer': ('White Mage', 'healer -> Empire White Mage', 'high', 17),
    'class_priest': ('Knight Hero (variant 0)', 'white-robed priest sprite (sounds borrowed from Knight Hero)', 'medium', 30),
    'class_prophet': ('Wood Elf Hero', 'forest seer / prophet -> Wood Elf hero', 'medium', 73),
    'class_seeker': ('Sorceror', 'card-seeking diviner -> Dark Elf Sorceror', 'medium', 39),
    'class_paladin': ('Knight Lord', 'paladin -> Knight Lord', 'high', 9),
    'class_cleric': ('Knight Hero', 'holy cleric -> Knight race hero (gold armour, cast anims)', 'medium', 12),
    'class_guardian': ('Iceguard', 'stationary regenerating guardian -> Iceguard', 'medium', 47),
    'class_manipulator': ('Dark Elf Hero', 'mind manipulator -> Dark Elf hero', 'medium', 24),
    'class_bard': ('Leprechaun', 'bard -> Fey Leprechaun (music/luck)', 'medium', 22),
    'class_shaman': ('Minotaur Shaman', 'shaman -> Minotaur Shaman', 'high', 56),
    'class_necromancer': ('Liche', 'necromancer -> Undead Liche', 'high', 31),
    'class_witch': ('Banshee', 'witch -> Fey Banshee caster', 'medium', 43),
    'class_restaurateur': ('Peasant', 'utility/food provider -> Peasant', 'medium', 58),
    'class_warrior': ('Swordsman', 'warrior -> Knights Swordsman', 'high', 51),
    'class_ranger': ('Elven Hunter', 'trap-laying ranger -> Wood Elf Elven Hunter', 'high', 6),
    'class_kensei': ('Dragon Knight', 'sword saint -> High Elf Dragon Knight', 'medium', 27),
    'class_reaver': ('Reaver', 'reaver -> Barbarian Reaver', 'high', 68),
    'class_barbarian': ('Barbarian', 'barbarian -> Barbarian', 'high', 23),
    'class_overlord': ('Doom Knight', 'armour-granting overlord -> Undead Doom Knight', 'medium', 80),
    'class_rogue': ('Dark Infantry', 'stealthy rogue -> Dark Elf light infantry', 'medium', 29),
    'class_avenger': ('Slayer Knight', 'avenger -> Undead Slayer Knight', 'medium', 44),
    'class_monk': ('Mystic', 'mobile monk -> High Elf Mystic', 'medium', 48),
    'class_noble': ('Dwarf Lord', 'noble lord -> Dwarf Lord', 'medium', 76),
    'class_assassin': ('Assassin', 'assassin -> Dark Elf Assassin', 'high', 88),
}

SOUND_KEYS = {'Ready': 'ready', 'Select': 'select', 'Order': 'order', 'Deathblow': 'deathblow',
              'Conversion': 'conversion', 'Spell': 'spell', 'Mana': 'spell', 'Build': 'fx', 'CantBuild': 'fx'}
SOUND_USAGE = {'ready': 'play when the entity spawns / is recruited', 'select': 'play on click-select, pick randomly',
               'order': 'play when an action is queued / a target is set', 'deathblow': 'play when the entity kills a target',
               'conversion': 'play when capturing a terrain item', 'spell': 'play when casting an effect',
               'fx': 'misc voice line (build / cannot build)'}
SPRITE_USAGE = {
    'idle': '8-direction idle loop (rows = directions, cols = frames; grid in assets/frames.json)',
    'walk': '8-direction walk cycle, play while moving along the hex path',
    'attack': '8-direction attack, play on action A / skill',
    'death': 'death strip, play once when life reaches 0',
    'fidget': '8-direction idle variation, play randomly while idle',
    'cast': '8-direction spell cast, play on effect/skill use',
    'special': 'special ability animation',
    'info': 'info panel image: portrait on top, team-coloured UI icons below',
    'z': 'extra animation strip',
}
SOUND_BORROW = {'Knight Hero (variant 0)': 'Knight Hero', 'Knight Hero (variant 1)': 'Knight Hero',
                'Empire Hero': 'Knight Hero', 'Ssrathi Hero': 'Naga', 'Swarm Hero': 'Scorpionpriest', 'Reaper': 'Daemon'}


def load_manifest():
    for name in ('warlords3_battlecry_manifest.json', 'manifest.json'):
        p = os.path.join(EXTRACTED, name)
        if os.path.exists(p):
            return json.load(open(p, encoding='utf-8'))
    raise SystemExit('manifest not found under ' + EXTRACTED)


def to_asset(path):
    assert path.startswith('extracted/'), path
    if not os.path.exists(os.path.join(os.path.dirname(ROOT), path)):
        raise SystemExit('missing file: ' + path)
    return 'assets/' + path[len('extracted/'):]


def portrait(num):
    if num is None:
        return None
    hits = glob.glob(os.path.join(EXTRACTED, 'Images', 'Portraits', f'*[[]Portrait{num:02d}[]]*.bmp'))
    if not hits:
        return None
    rel = os.path.relpath(hits[0], os.path.dirname(ROOT)).replace('\\', '/')
    return {'path': to_asset(rel), 'usage': 'hero/character portrait for HUD and roster'}


def build_resources(manifest, wbc3_name, reason, confidence, portrait_num=None):
    ent = manifest['entities'][wbc3_name]
    sprites = {}
    for f in ent['files']['sprites']:
        if 'Sprites/Units' not in f['path']:
            continue
        anim = f.get('animation') or 'idle'
        if anim in sprites:
            continue
        sprites[anim] = {'path': to_asset(f['path']), 'usage': SPRITE_USAGE.get(anim, anim), 'size': f.get('size')}
    sound_src = ent
    borrowed = None
    if not ent['files']['sounds'] and wbc3_name in SOUND_BORROW:
        borrowed = SOUND_BORROW[wbc3_name]
        sound_src = manifest['entities'][borrowed]
    sounds = {}
    for f in sound_src['files']['sounds']:
        key = SOUND_KEYS.get(f.get('category'))
        if not key:
            continue
        rec = {'path': to_asset(f['path']), 'usage': SOUND_USAGE[key]}
        if f.get('quote'):
            rec['quote'] = f['quote']
        sounds.setdefault(key, []).append(rec)
    res = {
        'source': 'warlords3_battlecry',
        'wbc3_name': wbc3_name,
        'wbc3_code': (ent.get('codes') or [None])[0],
        'wbc3_race': ent.get('race'),
        'wbc3_internal_name': ent.get('internal_name'),
        'match_reason': reason + (f'; voice lines borrowed from {borrowed}' if borrowed else ''),
        'confidence': confidence,
        'sprites': sprites,
    }
    p = portrait(portrait_num)
    if p:
        res['portrait'] = p
    res['sounds'] = sounds
    wiki = ent.get('wiki') or {}
    if wiki.get('url'):
        res['wbc3_wiki'] = wiki['url']
    return res


def enrich(fname, table, manifest, mapping_out):
    path = os.path.join(DATA, fname)
    doc = json.load(open(path, encoding='utf-8'))
    for entry in doc['entries']:
        spec = table.get(entry['id'])
        if not spec:
            print('  UNMAPPED', entry['id'])
            continue
        name, reason, conf = spec[0], spec[1], spec[2]
        pnum = spec[3] if len(spec) > 3 else None
        res = build_resources(manifest, name, reason, conf, pnum)
        # keep `resources` right after `tags`, before `versions`
        rebuilt = {}
        for k, v in entry.items():
            if k == 'resources':
                continue
            rebuilt[k] = v
            if k == 'tags':
                rebuilt['resources'] = res
        if 'resources' not in rebuilt:
            rebuilt['resources'] = res
        entry.clear()
        entry.update(rebuilt)
        mapping_out[entry['id']] = {'name': entry['name'], 'wbc3_name': name, 'wbc3_code': res['wbc3_code'],
                                    'race': res['wbc3_race'], 'reason': reason, 'confidence': conf,
                                    'portrait': res.get('portrait', {}).get('path'),
                                    'animations': sorted(res['sprites']), 'sound_lines': sum(len(v) for v in res['sounds'].values())}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'{fname}: {len(doc["entries"])} entries enriched')


def main():
    manifest = load_manifest()
    mapping = {}
    enrich('characters.json', CHARACTERS, manifest, mapping)
    # Split A (2026-11-25): the monster cards (and their `resources`) moved to chaosD6-GameModels monsters/<id>.json
    # (chaosd6.monster/2 card.resources) — data/creatures.json is a frozen record and mapping_units.json has no mon_
    # keys any more. CREATURES above stays as the record of the picks.
    enrich('classes.json', CLASSES, manifest, mapping)
    out = os.path.join(ROOT, 'assets', 'mapping_units.json')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)
        f.write('\n')
    used = {}
    for v in mapping.values():
        used.setdefault(v['wbc3_name'], []).append(v['name'])
    dups = {k: v for k, v in used.items() if len(v) > 1}
    print('mapping_units.json:', len(mapping), 'entries;', 'reused WBC3 units:', dups or 'none')


if __name__ == '__main__':
    main()
