"""Enrich data/effects.json, skills.json, actions.json, elements.json, terrain_items.json
with an entry-level `resources` block (see assets/resources_schema.json) pointing at
curated Warlords Battlecry III assets under assets/ (mirroring ../extracted/).

Idempotent: re-running replaces the `resources` key; `versions` is never touched.
Also writes assets/mapping_effects.json ({entry_id: {asset, reason, confidence}}).

Usage:  python tools/enrich_effects.py            (from the chaosD6 repo root or anywhere)
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTRACTED = os.path.normpath(os.path.join(ROOT, '..', 'extracted'))
DATA = os.path.join(ROOT, 'data')
FILES = ['effects', 'skills', 'actions', 'elements', 'terrain_items']

# ----------------------------------------------------------------------------- asset lookup
missing = []


def _rel(path_in_extracted):
    """extracted-relative path -> 'assets/...' (only if the file exists)."""
    full = os.path.join(EXTRACTED, path_in_extracted)
    if not os.path.exists(full):
        missing.append(path_in_extracted)
        return None
    return 'assets/' + path_in_extracted.replace('\\', '/')


def _listdir(sub):
    p = os.path.join(EXTRACTED, sub)
    return sorted(os.listdir(p)) if os.path.isdir(p) else []


CODE_RE = re.compile(r'\[([A-Za-z0-9]+)\]\.png$')


def _code(fname):
    m = CODE_RE.search(fname)
    return m.group(1).upper() if m else None


def effect_sprite(dirname, usage=None, blend=None):
    """Effects1/<dirname>/<first png>  ->  {'path','usage'} (+ code via _last_code)."""
    sub = os.path.join('Sprites', 'Effects', 'Effects1', dirname)
    files = [f for f in _listdir(sub) if f.lower().endswith('.png')]
    if not files:
        missing.append(sub)
        return None
    f = files[0]
    code = _code(f) or _EFFECT_CODE_FALLBACK.get(dirname)
    d = {'path': _rel(os.path.join(sub, f)),
         'usage': usage or 'effect animation strip (cols = frames; grid in assets/frames.json), play once at the target hex'}
    if blend:
        d['blend'] = blend
    d['_code'] = code
    return d


# directory names whose file name was truncated ("…") and therefore lost the [code]
_EFFECT_CODE_FALLBACK = {
    'Spell effect tall whiteblue flame columns (summon pillar)': 'EZ09',
}

_FX_INDEX = {f.lower(): f for f in _listdir(os.path.join('Sounds', 'SoundFX'))}


def fx(name, usage, optional=False):
    """SoundFX/<name>.wav (case-insensitive) -> {'path','usage'}."""
    real = _FX_INDEX.get(name.lower() + '.wav')
    if not real:
        if not optional:
            missing.append('Sounds/SoundFX/' + name)
        return None
    return {'path': _rel(os.path.join('Sounds', 'SoundFX', real)), 'usage': usage}


def fxs(names, usage):
    return [s for s in (fx(n, usage) for n in names) if s]


def building(race, name, usage_static=None):
    """Sprites/Buildings/<race>/<name>/ -> sprites dict (static/info/construction/variants) + code + building sound."""
    sub = os.path.join('Sprites', 'Buildings', race, name)
    files = _listdir(sub)
    if not files:
        missing.append(sub)
        return {}, None, []
    sprites, code = {}, None
    for f in files:
        if not f.lower().endswith('.png'):
            continue
        c = _code(f)
        kind = f.rsplit(' - ', 1)[-1].split(' [')[0] if ' - ' in f else 'base'
        rel = _rel(os.path.join(sub, f))
        if kind == 'base':
            code = c
            sprites['static'] = {'path': rel, 'usage': usage_static or 'single still image, anchor bottom-center on the hex (team colour slots FB-FE already tinted red)'}
        elif kind == 'info':
            sprites['info'] = {'path': rel, 'usage': 'info panel image (140x370): portrait on top, UI icons below; use the top part as a card picture'}
        elif kind == 'construction':
            sprites['construction'] = {'path': rel, 'usage': '3-frame construction/growth strip; play while the item is being deployed/channelled'}
        elif kind.startswith('variant'):
            sprites.setdefault('variants', []).append({'path': rel, 'usage': kind + ' - alternative still for matching terrain (w=snow, d=desert, a=other)'})
    sounds = []
    if code:
        for cand in (code, code[:3] + 'X'):
            s = fx(cand, 'ambient/activation loop of the original building; play when a character enters or captures the item', optional=True)
            if s:
                sounds.append(s)
                break
    return sprites, code, sounds


def unit_anims(race, unit):
    """Sprites/Units/<race>/<unit>/ -> {idle,walk,attack,death,fidget,cast,special,info} + code."""
    sub = os.path.join('Sprites', 'Units', race, unit)
    usage = {
        'idle': '8-direction idle loop (rows = directions N,NE,E,SE,S,SW,W,NW; cols = frames), grid in assets/frames.json',
        'walk': '8-direction walk cycle, play while moving along the hex path',
        'attack': '8-direction attack, play when the summon deals damage',
        'death': 'death strip, play once when the summon vanishes',
        'fidget': '8-direction idle variation, play randomly while idle',
        'cast': '8-direction cast animation',
        'special': 'special ability animation',
        'info': 'info panel image: portrait on top, team-coloured UI icons below',
    }
    out, code = {}, None
    for f in _listdir(sub):
        if not f.lower().endswith('.png'):
            continue
        kind = f.rsplit(' - ', 1)[-1].split(' [')[0]
        if kind in usage:
            out[kind] = {'path': _rel(os.path.join(sub, f)), 'usage': usage[kind]}
            if kind == 'idle':
                code = _code(f)
    if not out:
        missing.append(sub)
    return out, code


def feature(archive, name):
    sub = os.path.join('Sprites', 'Terrain Features', archive, name)
    files = [f for f in _listdir(sub) if f.lower().endswith('.png')]
    if not files:
        missing.append(sub)
        return None, None
    return {'path': _rel(os.path.join(sub, files[0])),
            'usage': 'single still terrain-feature image, anchor bottom-center on the hex'}, _code(files[0])


def tiles(tileset, limit=6):
    """Images/Terrain/<tileset>/ -> list of tile blocks (skipping the *i info variants)."""
    sub = os.path.join('Images', 'Terrain', tileset)
    files = [f for f in _listdir(sub) if f.lower().endswith('.bmp') and not f[:-4].lower().endswith('i')]
    if not files:
        missing.append(sub)
    return [{'path': _rel(os.path.join(sub, f)),
             'usage': f'{tileset} terrain tile block (8-bit 320x240 tile sheet) - source for hex tiles of this terrain (see assets/terrain/ and tools/make_hex_tiles.py)'}
            for f in files[:limit]]


# ----------------------------------------------------------------------------- mapping tables
# effects: id -> (Effects1 dir, [SoundFX names], reason, confidence, extra)
#   extra: {'blend': 'additive', 'summon': ('UnitRace','Unit'), 'static': ('BuildingRace','Building')}
EFFECTS = {
    'effect_super_sense':       ('Yellow light orb glow growing (sizes)', ['STEZ06', 'Sparkles'], 'growing light orb = heightened perception revealing a tile', 'medium', {}),
    'effect_super_force':       ('Smokedust puff animation', ['Thump', 'Whack'], 'impact dust puff where the pushed/thrown body lands', 'medium', {}),
    'effect_harm':              ('Particle set red sparks', ['STEZ17', 'Whack'], 'red damage sparks for a direct harm channel', 'medium', {}),
    'effect_sound_wave':        ('Spell effect white rings', ['STEZ04', 'LongWhoosh'], 'expanding rings read as a sound wave', 'medium', {}),
    'effect_summoning':         ('Spell effect tall whiteblue flame columns (summon pillar)', ['STEZ09'], 'WBC3 summon pillar effect', 'high', {'blend': 'additive'}),
    'effect_aura':              ('Purple domeshield arcs', ['STEZ37'], 'dome around the caster = aura extending effects to neighbours', 'medium', {'blend': 'additive'}),
    'effect_drain':             ('Spell effect red oval blobs', ['STEZ17', 'HeartBeatSlow'], 'red life blobs flowing from target to caster', 'medium', {}),
    'effect_spirit_link':       ('Cyan beams', ['Magic'], 'beams connecting two subjects', 'medium', {'blend': 'additive'}),
    'effect_blessing_curse':    ('Yellow ring with + sign (buff marker)', ['Sparkles'], 'WBC3 buff ring marker; tint red for Curse', 'medium', {}),
    'effect_banish':            ('Spell effect white smoke cloud ring (large)', ['STEZ13'], 'large vanishing smoke ring where the subject was relocated from', 'medium', {}),
    'effect_oblivion':          ('Grey smoke wisps', ['STEZ38', 'Fade'], 'grey wisps = mind emptied, cannot act', 'medium', {}),
    'effect_teleportation':     ('Bluewhite ring burst', ['Sparkles', 'Fade'], 'ring burst at origin and destination hex', 'medium', {'blend': 'additive'}),
    'effect_sleep':             ('Spell effect faint white rings', ['STEZ08'], 'faint rings hovering over the sleeping target', 'low', {}),
    'effect_aging':             ('Grey arcs', ['Fade'], 'grey sweeping arcs like clock hands', 'low', {}),
    'effect_space_bending':     ('Spell effect small purple ringspiral', ['STEZ02'], 'purple spiral = warped space', 'medium', {'blend': 'additive'}),
    'effect_emotions_bombard':  ('Pinkred sparkles', ['STEZ23'], 'pink sparkles for an emotional assault', 'medium', {}),
    'effect_delay_time':        ('Spell effect faint rings', ['STEZ14'], 'slow faint rings for slowed time', 'medium', {}),
    'effect_potion_brew':       ('Green sparkle clusters', ['DwarvenBrew', 'STEZ36'], 'green alchemical sparkles; DwarvenBrew is the WBC3 brewing sound', 'medium', {}),
    'effect_artifice':          ('Blue crystaldiamond icons', ['Crystallize', 'STEZ36'], 'crystal icon = crafted permanent token', 'medium', {}),
    'effect_invisibility':      ('Grey arc sweeps', ['Fade'], 'faint grey sweeps fading the hero out', 'low', {}),
    'effect_mutate':            ('Green dome arcs', ['Morph'], 'green dome + WBC3 Morph sound', 'medium', {'blend': 'additive'}),
    'effect_lightning':         ('Spell effect vertical lightning boltspillars', ['LightningH1', 'LightningM1', 'STEZ11'], 'WBC3 vertical lightning bolts', 'high', {'blend': 'additive'}),
    'effect_fireball':          ('Fireball explosion (growing orange blast)', ['fireball', 'Boom'], 'WBC3 fireball explosion', 'high', {'blend': 'additive'}),
    'effect_shield':            ('Cyan dome shield arcs', ['STEZ41'], 'WBC3 dome shield', 'high', {'blend': 'additive'}),
    'effect_empower':           ('Purple ring with + sign (buff marker)', ['Sparkles', 'STEZ21'], 'buff marker ring with + sign', 'medium', {}),
    'effect_nature_embrace':    ('Green dotted rings', ['Sparkles'], 'green nature rings wrapping the target', 'medium', {}),
    'effect_disable':           ('Red X cancel marker (sizes)', ['Error', 'Fade'], 'red X over the disabled element', 'medium', {}),
    'effect_throw':             ('Thrown stonerock projectile', ['swoosh', 'Thump'], 'thrown rock projectile strip (directions)', 'high', {}),
    'effect_elementals_air':    ('Bluewhite arcs', ['LongWhoosh', 'STEZ09'], 'air arcs on cast; summoned creature uses the WBC3 Air Elemental unit', 'high', {'summon': ('Temples', 'Air Elemental'), 'blend': 'additive'}),
    'effect_elementals_water':  ('Particle set blue sparks + crystals', ['Splash', 'STEZ09'], 'water sparks on cast; summoned creature uses the WBC3 Water Elemental unit', 'high', {'summon': ('Temples', 'Water Elemental')}),
    'effect_elementals_earth':  ('Greybrown dust puffs', ['Stomp', 'STEZ09'], 'dust on cast; summoned creature uses the WBC3 Earth Elemental unit', 'high', {'summon': ('Temples', 'Earth Elemental')}),
    'effect_balefire':          ('Red beamline effect', ['fireball', 'ElectricCrit'], 'red beam = Fiery Beam', 'high', {'blend': 'additive'}),
    'effect_golems_earth':      ('Small dust puffs', ['Build', 'STEZ09'], 'summoned creature uses the WBC3 Stone Golem unit', 'high', {'summon': ('Dark Dwarves', 'Stone Golem')}),
    'effect_golems_water':      ('Small dust puffs', ['Build', 'Splash'], 'no water golem in WBC3; Bronze Golem (verdigris/sea colours) stands in', 'low', {'summon': ('Dark Dwarves', 'Bronze Golem')}),
    'effect_golems_air':        ('Small dust puffs', ['Build', 'LongWhoosh'], 'no air golem in WBC3; Iron Golem stands in', 'low', {'summon': ('Dark Dwarves', 'Iron Golem')}),
    'effect_awake':             ('Yellow smileysun face icons', ['STEZ25'], 'sun/face icon = awakened terrain or ally', 'low', {}),
    'effect_resurrect_death_ward': ('Spell effect white glowing orb growing', ['STEZ07', 'HeroLevelUp'], 'growing white orb = returning life', 'medium', {'blend': 'additive'}),
    'effect_creation':          ('Small dust puffs', ['Build'], 'wall token created from earth; still image is the WBC3 neutral wall segment', 'high', {'static': ('Shared', 'Walls (neutral, 2x1 horizontal)')}),
    'effect_ice_blast':         ('Cyan ice shards', ['IceCrit', 'Crystallize'], 'WBC3 ice shards', 'high', {}),
    'effect_combustion':        ('Fire flames (torchburning)', ['Fire', 'STEZ42'], 'burning flames on the target', 'high', {'blend': 'additive'}),
    'effect_fossilization':     ('Grey rings', ['Petrify'], 'grey rings + WBC3 Petrify sound', 'medium', {}),
    'effect_the_void':          ('Objectivetarget ring marker - black', ['Fade'], 'black ring = void absorbing all damage', 'medium', {}),
    'effect_metaphysics':       ('Spell effect pale starburst', ['STEZ20'], 'pale starburst = mass change', 'low', {}),
    'effect_confusion':         ('Spell effect yellow ring markers', ['STEZ12'], 'yellow spinning rings over a confused target', 'low', {}),
    'effect_inner_fire':        ('Orange glowing rings', ['STEZ28'], 'orange glow around an empowered fighter', 'medium', {'blend': 'additive'}),
    'effect_blizzard':          ('Cyan star sparkles', ['RainH', 'LongWhoosh'], 'cyan snowflake sparkles', 'medium', {}),
    'effect_vision':            ('Spell effect orange glowing ring eye', ['STEZ06'], 'WBC3 glowing eye ring = vision/scrying', 'high', {}),
    'effect_light_darkness':    ('White sparkle orbs (large)', ['STEZ32'], 'large white orbs; invert/tint black for Darkness', 'medium', {'blend': 'additive'}),
    'effect_phantom':           ('Spell effect green hooded figure sprites (phantom)', ['STEZ22'], 'WBC3 phantom hooded figure', 'high', {}),
    'effect_meteor_shower':     ('Fireexplosion burst animation (large)', ['Falling0', 'Boom'], 'large fire burst on every known creature', 'high', {'blend': 'additive'}),
    'effect_traps_mastery':     ('Particle set yellow sparks + X marks', ['Clank'], 'X marks = hidden trap markers (owner-only)', 'low', {}),
    'effect_possess_phylactery': ('Purple dome arcs', ['STEZ44', 'evilselect'], 'purple dome swapping bodies', 'medium', {'blend': 'additive'}),
    'effect_dark_matter':       ('Spell effect purplewhite glowing orbs', ['STEZ05'], 'purple-white orbs colliding', 'medium', {'blend': 'additive'}),
    'effect_poison':            ('Particle set green sparks', ['Poison'], 'green sparks + WBC3 Poison sound', 'medium', {}),
    'effect_disruption':        ('Spell effect cyan energy shards', ['STEZ03'], 'shards = object split apart', 'medium', {'blend': 'additive'}),
    'effect_mind_blast':        ('Spell effect starburst (large)', ['STEZ19'], 'large starburst over the head', 'medium', {'blend': 'additive'}),
    'effect_haste':             ('Spell effect tiny sparkles', ['STEZ21', 'FastWalk'], 'tiny sparkles trailing a hasted character', 'medium', {}),
    'effect_turn_life':         ('Spell effect starburst sparkles', ['STEZ15'], 'starburst sparkles for inverted vital energy', 'medium', {'blend': 'additive'}),
    'effect_earthquake':        ('Large smokedust explosion animation', ['Stomp', 'Thump'], 'big dust explosion on all adjacent hexes', 'high', {}),
    'effect_love':              ('Heart icons (healingcharm)', ['STEZ23'], 'WBC3 heart charm icons', 'high', {}),
    'effect_awe':               ('Small white starbursts', ['STEZ34'], 'white starbursts of awe', 'medium', {}),
    'effect_domination':        ('Red ring markers', ['evilselect'], 'red control ring under the dominated target', 'medium', {}),
    'effect_anger':             ('Orange ember sparks', ['STEZ27'], 'ember sparks of rage', 'medium', {'blend': 'additive'}),
    'effect_mists':             ('Spell effect white smoke puffs', ['STEZ18'], 'WBC3 white mist puffs', 'high', {}),
    'effect_petrify':           ('Grey crescent arcs', ['Petrify'], 'grey arcs + WBC3 Petrify sound', 'medium', {}),
    'effect_fear':              ('Spell effect white smoke rings', ['Scream', 'STEZ10'], 'white rings + scream', 'medium', {}),
}

# skills: id -> ([SoundFX], sprite spec or None, reason, confidence)
#   sprite spec: ('effect', dir) | ('building', race, name)
SKILLS = {
    'skill_powerful_attack': (['Sword', 'CrushCrit'], ('effect', 'Blood splatter (red) and green ichor splatter'), 'heavy sword hit + crit; blood splatter on the target', 'high'),
    'skill_overrun':         (['Stomp', 'Whack'], ('effect', 'Smokedust puff animation'), 'stomp through the enemy, dust at the swap', 'medium'),
    'skill_grapple':         (['Whack', 'Thump'], None, 'body impact sounds', 'medium'),
    'skill_ranged_weapon':   (['Missile0', 'swoosh'], ('effect', 'Arrow projectile (directions)'), 'arrow projectile strip + missile sound', 'high'),
    'skill_taunt':           (['Scream'], ('effect', 'Crossed burning swords icon (battle marker)'), 'battle marker over the taunting hero', 'low'),
    'skill_force_shield':    (['Clank', 'DoubleClang'], ('effect', 'Cyan dome shield arcs'), 'dome shield + metal clang', 'high'),
    'skill_barricade':       (['Build'], ('building', 'Shared', 'Ramparts'), 'WBC3 rampart still around the hero', 'medium'),
    'skill_sanctuary':       (['Sparkles'], ('effect', 'Spell effect white rings'), 'white protective rings', 'medium'),
    'skill_disruption_move': (['ShortWhoosh'], None, 'quick dash sound', 'low'),
    'skill_dodge':           (['swoosh2', 'swooshlr'], None, 'whoosh of a dodge', 'medium'),
    'skill_bluff':           (['swooshrl', 'ClickSft'], None, 'feint whoosh + soft click', 'low'),
    'skill_intimidation':    (['drum', 'HeartBeatFast'], None, 'drum + racing heartbeat of the intimidated enemy', 'low'),
    'skill_battle_trance':   (['HeartBeatFast'], ('effect', 'Yellow ring with + sign (buff marker)'), 'buff marker + heartbeat', 'medium'),
    'skill_counter_spell':   (['Magic'], ('effect', 'Red X cancel marker variant'), 'cancel X over the countered skill', 'medium'),
}

ACTIONS = {
    'action_attack':        (['Sword', 'Whack', 'Attack00', 'Attack01', 'Attack02'], ('effect', 'Crossed burning swords icon (battle marker)'), 'generic melee hit sounds (pick randomly) + battle marker', 'high'),
    'action_block':         (['Clank', 'DoubleClang'], ('effect', 'Shieldgem icons in 8 player colours'), 'shield clang + shield gem icon', 'high'),
    'action_move':          (['Walk', 'FastWalk'], ('effect', 'Footprints small ground marks'), 'footsteps + footprints along the hex path', 'high'),
    'action_posture':       (['Magic'], ('effect', 'Spell effect faint rings'), 'faint rings while concentrating/casting', 'medium'),
    'action_empty_posture': (['Pad'], None, 'soft UI pad sound (no card played)', 'low'),
    'action_empty_move':    (['Walk'], None, 'half-step footsteps', 'low'),
    'action_combo':         (['xp', 'GainedLevel'], ('effect', 'Digit glyphs 0-9 (floating numbers)'), 'floating damage digits for the +1 combo bonus', 'medium'),
    'action_trade':         (['merchant'], ('effect', 'Dialoginventory icon sheet (many small item icons)'), 'WBC3 merchant sound + item icons', 'medium'),
    'action_enter_dimension': (['Embark', 'Land'], ('effect', 'Spell effect tall whiteblue flame columns (summon pillar)'), 'arrival pillar of light on the starting tile', 'medium'),
    'action_travel_door':   (['Disembark', 'Fade'], ('building', 'Neutral', 'Black Portal'), 'WBC3 Black Portal as the dimension door', 'medium'),
}

# elements: id -> (tilesets, Effects1 dir, [SoundFX], reason, confidence)
ELEMENTS = {
    'elem_vitality':      (['Grass'], 'Particle set red sparks', ['HeartBeatSlow'], 'living grass terrain, red life sparks, heartbeat', 'medium'),
    'elem_souls':         (['Caverns'], 'Spell effect purplewhite glowing orbs', ['STEZ05', 'Skeleton'], 'dark caverns, violet soul orbs', 'medium'),
    'elem_time':          (['Desert'], 'Grey arcs', ['PageTurn'], 'sand (hourglass) terrain, sweeping arcs', 'low'),
    'elem_space':         (['Caverns', 'Rock Cliffs'], 'Spell effect small purple ringspiral', ['STEZ02'], 'deep caverns, purple spiral', 'medium'),
    'elem_air':           (['Snow', 'High Grass'], 'Bluewhite arcs', ['LongWhoosh'], 'high open terrain, blue-white wind arcs', 'medium'),
    'elem_water':         (['Water', 'Grass Coast'], 'Particle set blue sparks + crystals', ['Splash'], 'water tiles, blue droplets', 'high'),
    'elem_earth':         (['Rock', 'Mountains'], 'Greybrown dust puffs', ['Stomp'], 'rock/mountain tiles, dust', 'high'),
    'elem_fire':          (['Lava'], 'Fire flames (torchburning)', ['Fire'], 'lava tiles, flames', 'high'),
    'elem_concentration': (['High Dirt'], 'Small white rings', ['Sparkles'], 'bare high plateau, silver rings', 'medium'),
    'elem_harmony':       (['Jungle', 'Marsh'], 'Yellow sparks', ['Magic'], 'lush jungle, golden sparks', 'medium'),
}

# terrain items: id -> dict(kind=..., ...)
TOWER_BUILDINGS = {
    'tower_vitality':      ('Wood Elves', 'Tree of Life', 'Tree of Life = vitality', 'medium'),
    'tower_souls':         ('Undead', 'Altar of Shadows', 'undead altar for the Souls element', 'medium'),
    'tower_time':          ('Neutral', 'Celestial Temple', 'celestial (stars/time) temple', 'medium'),
    'tower_space':         ('Dark Elves', 'Void', 'WBC3 "Void" building', 'high'),
    'tower_air':           ('Fliers', 'Eyrie (level 3)', 'eyrie on a crag for Air', 'medium'),
    'tower_water':         ('Ssrathi', 'Sacred Pool', 'sacred pool for Water', 'medium'),
    'tower_earth':         ('Neutral', 'Elemental Temple', 'stone elemental temple for Earth', 'medium'),
    'tower_fire':          ('Neutral', 'Infernal Temple', 'infernal temple for Fire', 'high'),
    'tower_concentration': ('High Elves', 'Tower of the Moon', 'Tower of the Moon = concentration/magic', 'high'),
    'tower_harmony':       ('Wood Elves', 'White Tree', 'White Tree = harmony', 'medium'),
}
TOWER_TILES = {'tower_vitality': 'Grass', 'tower_souls': 'Caverns', 'tower_time': 'Desert', 'tower_space': 'Caverns', 'tower_air': 'Snow',
               'tower_water': 'Water', 'tower_earth': 'Rock', 'tower_fire': 'Lava', 'tower_concentration': 'High Dirt', 'tower_harmony': 'Jungle'}
CRYSTALS = {
    'crystal_vitality': ('Crystal Mine (size 1)', 'tint red'),
    'crystal_world':    ('Crystal Mine (size 2)', 'tint violet/indigo'),
    'crystal_matter':   ('Crystal Mine (size 3)', 'tint brown/aqua'),
    'crystal_will':     ('Crystal Mine (size 3)', 'tint silver/gold'),
}
ITEMS = {
    'item_library':        ('Empire', 'Library', 'WBC3 Library (alt: Undead/Black Library)', 'high'),
    'item_nexus':          ('Neutral', 'Circle of Power', 'ritual circle = nexus / entry point (alt: Daemons/Portal)', 'high'),
    'item_trade_center':   ('Knights', 'Market', 'market = trade center (alt: Dwarves/Trading Post)', 'high'),
    'item_stash':          ('Dark Dwarves', 'Supply Depot', 'supply depot = stash', 'high'),
    'item_dimension_door': ('Neutral', 'Black Portal', 'WBC3 Black Portal', 'high'),
    'item_tower_terrain':  ('Shared', 'Tower (Knights)', 'neutral defensive tower (per-race variants in Sprites/Buildings/Shared/Tower (*))', 'high'),
    'item_force_field':    ('Shared', 'Walls (neutral, 2x1 horizontal)', 'neutral wall segment (alt: Wall of Ice, Wall of Thorns; 1x2 vertical / 2x2 joint variants)', 'high'),
    'item_artifact':       ('Neutral', 'Shrine', 'shrine holding an artifact', 'medium'),
    'item_attraction_recruitment_center': ('Wood Elves', 'Hostel', 'hostel attracts recruits (alt: Minotaurs/Ale Store, Knights/Garrison)', 'medium'),
}
ITEM_ALTS = {
    'item_library': [('Undead', 'Black Library')],
    'item_nexus': [('Daemons', 'Portal')],
    'item_trade_center': [('Dwarves', 'Trading Post')],
    'item_force_field': [('Shared', 'Wall of Ice'), ('Shared', 'Wall of Thorns'), ('Shared', 'Walls (neutral, 1x2 vertical)'), ('Shared', 'Walls (neutral, 2x2 joint)')],
    'item_attraction_recruitment_center': [('Minotaurs', 'Ale Store')],
    'item_tower_terrain': [('Shared', 'Tower (Undead)'), ('Shared', 'Tower (High Elf)')],
}


def mine_building(mine_id, idx):
    """Choose a WBC3 mine type by the dominant element of the triple."""
    if 'fir' in mine_id:
        kind, why = 'Metal Mine', 'fire (forge) in the triple -> metal mine'
    elif 'ear' in mine_id:
        kind, why = 'Stone Quarry', 'earth in the triple -> stone quarry'
    elif any(k in mine_id for k in ('tim', 'spa', 'sou')):
        kind, why = 'Crystal Mine', 'world element in the triple -> crystal mine'
    else:
        kind, why = 'Gold Mine', 'vitality/water/air/will triple -> gold mine'
    return f'{kind} (size {idx % 3 + 1})', why


# ----------------------------------------------------------------------------- builders
def base(name=None, code=None, race=None, reason='', confidence='medium'):
    r = {'source': 'warlords3_battlecry'}
    if name:
        r['wbc3_name'] = name
    if code:
        r['wbc3_code'] = code
    if race:
        r['wbc3_race'] = race
    r['match_reason'] = reason
    r['confidence'] = confidence
    return r


def strip_private(d):
    d.pop('_code', None)
    return d


def res_effect(eid, entry):
    dirname, sounds, reason, conf, extra = EFFECTS[eid]
    spr = effect_sprite(dirname, blend=extra.get('blend'))
    code = spr['_code'] if spr else None
    r = base(dirname, code, 'Effects1', reason, conf)
    sprites = {}
    if spr:
        sprites['effect'] = strip_private(spr)
    if 'static' in extra:
        b, bcode, bsnd = building(*extra['static'], usage_static='still image of the created wall token on the target hex')
        if 'static' in b:
            sprites['static'] = b['static']
    if 'summon' in extra:
        anims, ucode = unit_anims(*extra['summon'])
        sprites.update(anims)
        r['summon_unit'] = {'wbc3_name': extra['summon'][1], 'wbc3_code': ucode, 'wbc3_race': extra['summon'][0]}
    r['sprites'] = sprites
    stez = [s for s in sounds if s.upper().startswith('STEZ')]
    other = [s for s in sounds if not s.upper().startswith('STEZ')]
    r['sounds'] = {}
    spell = fxs(stez, 'WBC3 spell-cast sound paired with the EZ effect; play when the effect is cast')
    if spell:
        r['sounds']['spell'] = spell
    fx_list = fxs(other, 'sound effect on resolution / impact of the effect')
    if fx_list:
        r['sounds']['fx'] = fx_list
    return r


def res_skill_or_action(table, sid, kind_word):
    sounds, spec, reason, conf = table[sid]
    r = base(None, None, None, reason, conf)
    sprites = {}
    if spec:
        if spec[0] == 'effect':
            spr = effect_sprite(spec[1], usage=f'marker/animation strip shown on the {kind_word} target hex (cols = frames)')
            if spr:
                r['wbc3_name'], r['wbc3_code'], r['wbc3_race'] = spec[1], spr['_code'], 'Effects1'
                sprites['effect'] = strip_private(spr)
        else:
            b, bcode, _ = building(spec[1], spec[2])
            if 'static' in b:
                r['wbc3_name'], r['wbc3_code'], r['wbc3_race'] = spec[2], bcode, spec[1]
                sprites['static'] = b['static']
    r['sprites'] = sprites
    r['sounds'] = {'fx': fxs(sounds, f'play when the {kind_word} resolves (pick randomly if several)')}
    return r


def res_element(eid):
    tilesets, dirname, sounds, reason, conf = ELEMENTS[eid]
    spr = effect_sprite(dirname, usage='element emission flash: play on the caster hex when this element is emitted; also usable as the element card icon frame 0')
    r = base(dirname, spr['_code'] if spr else None, 'Effects1', reason, conf)
    r['sprites'] = {'effect': strip_private(spr)} if spr else {}
    r['tiles'] = [t for ts in tilesets for t in tiles(ts, limit=4)]
    r['tilesets'] = tilesets
    r['sounds'] = {'fx': fxs(sounds, 'play when a token of this element is emitted / placed')}
    return r


def res_terrain(tid, idx_mine):
    if tid in TOWER_BUILDINGS:
        race, name, why, conf = TOWER_BUILDINGS[tid]
        sprites, code, snd = building(race, name)
        r = base(name, code, race, why, conf)
        r['sprites'] = sprites
        r['tiles'] = tiles(TOWER_TILES[tid], limit=2)
        r['sounds'] = {'fx': snd} if snd else {}
        return r
    if tid in CRYSTALS:
        name, tint = CRYSTALS[tid]
        sprites, code, snd = building('Neutral', name, usage_static=f'crystal still on the hex; {tint} for this stat (team slots are red by default)')
        r = base(name, code, 'Neutral', 'WBC3 crystal mine = crystal deposit; ' + tint, 'medium')
        r['sprites'] = sprites
        r['sounds'] = {'fx': snd} if snd else {}
        return r
    if tid in ITEMS:
        race, name, why, conf = ITEMS[tid]
        sprites, code, snd = building(race, name)
        r = base(name, code, race, why, conf)
        alts = []
        for arace, aname in ITEM_ALTS.get(tid, []):
            asp, acode, _ = building(arace, aname)
            if 'static' in asp:
                alts.append({'wbc3_name': aname, 'wbc3_code': acode, 'wbc3_race': arace, 'path': asp['static']['path'], 'usage': 'alternative still (variant by owner alignment / orientation)'})
        if alts:
            sprites['alternatives'] = alts
        r['sprites'] = sprites
        r['sounds'] = {'fx': snd} if snd else {}
        if tid == 'item_dimension_door':
            r['sounds'].setdefault('fx', []).extend(fxs(['Embark', 'Disembark'], 'play when a character travels through the door'))
        if tid == 'item_force_field':
            r['sounds'].setdefault('fx', []).extend(fxs(['Build'], 'play when the wall is deployed'))
        return r
    if tid == 'item_river':
        r = base('Water terrain', None, 'Terrain', 'shallow water tiles = river wall', 'high')
        r['sprites'] = {}
        r['tiles'] = tiles('Water', limit=6) + tiles('Grass Coast', limit=2)
        r['tilesets'] = ['Water', 'Grass Coast']
        r['sounds'] = {'fx': fxs(['Splash', 'SplashMove'], 'play when a character enters / crosses the river hex')}
        return r
    if tid == 'item_lava':
        r = base('Lava terrain', None, 'Terrain', 'lava tiles = lava wall', 'high')
        r['sprites'] = {}
        spr = effect_sprite('Fire flames (torchburning)', usage='flame animation looping over the lava hex', blend='additive')
        if spr:
            r['sprites']['effect'] = strip_private(spr)
        r['tiles'] = tiles('Lava', limit=6)
        r['tilesets'] = ['Lava']
        r['sounds'] = {'fx': fxs(['Fire', 'Boom'], 'play when a character enters / is burned by the lava hex')}
        return r
    if tid == 'item_element_bonus_terrain':
        f, code = feature('GrassMisc', 'Standing stone obelisk on round base')
        r = base('Standing stone obelisk on round base', code, 'GrassMisc', 'standing stone = element source; tint by element colour_hint', 'medium')
        r['sprites'] = {'static': f} if f else {}
        spr = effect_sprite('Spell effect yellow sparkle cloud (very wide sheet)', usage='sparkle cloud looping over the source hex while tokens are available')
        if spr:
            r['sprites']['effect'] = strip_private(spr)
        r['sounds'] = {'fx': fxs(['Sparkles'], 'play when a token is drawn from the terrain')}
        return r
    if tid.startswith('mine_'):
        name, why = mine_building(tid, idx_mine)
        sprites, code, snd = building('Neutral', name)
        r = base(name, code, 'Neutral', why, 'medium')
        r['sprites'] = sprites
        r['sounds'] = {'fx': snd} if snd else {}
        return r
    return None


def primary_asset(r):
    for k in ('effect', 'static', 'idle'):
        if k in r.get('sprites', {}):
            return r['sprites'][k]['path']
    if r.get('tiles'):
        return r['tiles'][0]['path']
    for v in r.get('sounds', {}).values():
        if v:
            return v[0]['path']
    return None


def with_resources(entry, res):
    """Rebuild the entry dict so `resources` sits right before `versions` (key order preserved otherwise)."""
    out = {}
    for k, v in entry.items():
        if k == 'resources':
            continue
        if k == 'versions':
            out['resources'] = res
        out[k] = v
    if 'resources' not in out:
        out['resources'] = res
    return out


def main():
    mapping = {}
    stats = {}
    for fname in FILES:
        path = os.path.join(DATA, fname + '.json')
        with open(path, encoding='utf-8') as f:
            doc = json.load(f)
        mine_idx = 0
        new_entries = []
        n = 0
        for entry in doc['entries']:
            eid = entry['id']
            res = None
            if fname == 'effects' and eid in EFFECTS:
                res = res_effect(eid, entry)
            elif fname == 'skills' and eid in SKILLS:
                res = res_skill_or_action(SKILLS, eid, 'skill')
            elif fname == 'actions' and eid in ACTIONS:
                res = res_skill_or_action(ACTIONS, eid, 'action')
            elif fname == 'elements' and eid in ELEMENTS:
                res = res_element(eid)
            elif fname == 'terrain_items':
                res = res_terrain(eid, mine_idx)
                if eid.startswith('mine_'):
                    mine_idx += 1
            if res is None:
                print(f'  !! no mapping for {fname}:{eid}')
                new_entries.append(entry)
                continue
            new_entries.append(with_resources(entry, res))
            mapping[eid] = {'collection': fname, 'asset': primary_asset(res), 'wbc3_name': res.get('wbc3_name'),
                            'reason': res['match_reason'], 'confidence': res['confidence']}
            n += 1
        doc['entries'] = new_entries
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write('\n')
        stats[fname] = (n, len(new_entries))
        print(f'{fname}.json: {n}/{len(new_entries)} entries enriched')

    out = os.path.join(ROOT, 'assets', 'mapping_effects.json')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    low = sorted(k for k, v in mapping.items() if v['confidence'] == 'low')
    doc = {'source': 'warlords3_battlecry', 'generated_by': 'tools/enrich_effects.py',
           'collections': {k: {'enriched': v[0], 'total': v[1]} for k, v in stats.items()},
           'low_confidence': low, 'entries': mapping}
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'wrote {os.path.relpath(out, ROOT)}: {len(mapping)} entries, {len(low)} low-confidence')
    if missing:
        print('MISSING assets (not written):')
        for m in sorted(set(missing)):
            print('  ', m)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
