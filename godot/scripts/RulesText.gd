class_name RulesText
extends RefCounted
## Player-facing rule text shared by the HUD: one-line help per basic action card,
## skill card text from data/skills.json, and short "what is this?" blurbs for map
## objects (buildings, mines, temples, scatter, big-feature landmarks).
##
## The strings below are copied VERBATIM from game/js/rules_text.js (the browser
## client's single source of truth) — edit them there first, then mirror here.
## They are derived from the authoritative matrix in data/battle_system.json
## (resolution_matrix.edges: cycle A > P > M > B > A) plus the resolver semantics
## shared by Game.gd::_resolve(), game/peer.mjs and game/js/combat.js:
##   - only Attack deals damage: 1 + bonus_damage_to_actor(A|defender), floor 0
##   - Block reflects 1 to each attacker who targeted the blocker
##   - Empty Posture is read adversarially (EP_MAP): an attacker treats it as Posture
##   - Empty Move is read adversarially (EM_MAP): a blocker treats it as Move
## `card` is the always-visible slot line (≤ 70 chars); `full` is the tooltip text.

const ACTION_ICON := {"A": "⚔", "B": "🛡", "M": "👣", "P": "🤺", "EM": "👣", "EP": "🤺"}

const ACTION_HELP := {
	"A": {
		"name": "Attack",
		"icon": "⚔",
		"card": "⚔ 1 dmg to adjacent target · vs 🤺/EP: 2 · vs 🛡: 0 & take 1 back",
		"full": "Attack — hits your adjacent target for 1 damage. vs Posture or Empty Posture: 2 damage. vs Block: 0 damage and the blocker deals 1 back to you. vs Attack / Move / Empty Move: 1 damage. Aimed at an empty hex instead: step 1 hex (no damage; wins a contested hex over Move and Empty Move). Cycle: A > P > M > B > A.",
	},
	"B": {
		"name": "Block",
		"icon": "🛡",
		"card": "🛡 Attacks on you deal 0 · each attacker takes 1 back · stand still",
		"full": "Block — you stand still. Every Attack aimed at you deals 0 and its attacker takes 1 damage back (an attacker with Ranged Weapon takes none). Beaten by Move in the cycle: A > P > M > B > A.",
	},
	"M": {
		"name": "Move",
		"icon": "👣",
		"card": "👣 Step 1 hex to target · beats 🛡 Block · vs ⚔ Attack: take 1",
		"full": "Move — step 1 hex toward your target. On a contested hex Move loses to an Attack-step and beats an Empty Move; equal claims block everybody. vs Attack: you take 1. Beats Block in the cycle: A > P > M > B > A.",
	},
	"P": {
		"name": "Posture",
		"icon": "🤺",
		"card": "🤺 Hold ground · base for Posture skills · beats 👣 · vs ⚔: take 2",
		"full": "Posture — hold your ground and set up: Posture skills (Intimidation, Taunt, Barricade, Sanctuary…) ride on it. vs Attack: you take 2 (Attack beats Posture). Beats Move in the cycle: A > P > M > B > A.",
	},
	"EM": {
		"name": "Empty Move",
		"icon": "👣",
		"card": "👣 Walk halfway to the hex (min 1) · 🛡 reads it as Move · vs ⚔: take 1",
		"full": "Empty Move — the Empty card played as a journey: walk half the distance (rounded, at least 1 hex) toward the target hex. Weakest claim on a contested hex (loses to Attack-step and Move). vs Attack: you take 1. A Block reads it as Move (Rule 6). Move and Posture skills may ride on it.",
	},
	"EP": {
		"name": "Empty Posture",
		"icon": "🤺",
		"card": "🤺 Do nothing · ⚔ reads it as Posture: take 2 · keeps Sanctuary",
		"full": "Empty Posture — play no action. An attacker reads it as Posture (Rule 6): vs Attack you take 2. Posture and Move skills may still ride on it. Resting in Sanctuary keeps you invincible only while you stay in Empty Posture.",
	},
	"BT": {
		"name": "Battle Trance",
		"icon": "✦",
		"card": "✦ Play two actions this turn · each enemy scored vs your better option",
		"full": "Battle Trance — reveal two action cards (Empty fills a missing one). Against each adjacent enemy the option that nets you the most (dealt − taken) is the one scored; an Attack option hits at most one enemy.",
	},
}

## One-line cycle summary, handy for a hint bar.
const CYCLE_TEXT := "⚔ Attack > 🤺 Posture > 👣 Move > 🛡 Block > ⚔ Attack · only Attack scores damage, Block returns 1 to each attacker"

## Generic purpose per map-object kind. Used when the catalog entry
## (assets/features/feature_table.json) has no `desc` of its own.
const KIND_DESC := {
	"building": "A settlement building. Landmark for navigation; a future hold-to-claim point for supplies and refuge.",
	"mine": "A mine. Resource point — holding the hex is meant to yield gold or ore for your side between turns.",
	"temple": "A temple or shrine. Sacred ground — a place to rest, bless permanents and recover between fights.",
	"tower": "A watchtower. Extends the reach of whoever holds it (chess-like 2-3 hex range per building).",
	"wall": "A wall segment. Blocks movement and line of attack; fights happen around it, not through it.",
	"bridge": "A span over water or ravine. The only legal crossing on this stretch of shore — chokepoint for both sides.",
	"scatter": "Terrain decoration (grass, rock, trees). No effect on play — the hex is walkable as its biome says.",
	"bigfeature": "A large landmark spanning several hexes. Orientation point for the whole region.",
	"big_feature": "A large landmark spanning several hexes. Orientation point for the whole region.",
}

## The bundled Godot font has no emoji glyphs; the slot line swaps the icons for
## the action names (the browser shows the icons as-is).
const ICON_WORDS := {"⚔": "Attack", "🛡": "Block", "👣": "Move", "🤺": "Posture", "✦": "*"}

const SHORT_MAX := 70

static var _feature_desc_cache: Dictionary = {}
static var _feature_desc_loaded := false
static var _skill_icon_cache: Dictionary = {}      # skill_id -> Texture2D (may be null)


## Full rule text (tooltip form) for a basic action code, or "" when unknown.
static func action_help(code: String) -> String:
	var e = ACTION_HELP.get(code, null)
	return str(e.get("full", "")) if typeof(e) == TYPE_DICTIONARY else ""


## Display name for a basic action code ("Attack", "Empty Posture", …) or "".
static func action_name(code: String) -> String:
	var e = ACTION_HELP.get(code, null)
	return str(e.get("name", "")) if typeof(e) == TYPE_DICTIONARY else ""


## Slot-sized help: the browser's `card` line with icons swapped for words (the
## bundled font has no emoji), else the full line without its "Name — " prefix.
static func action_short(code: String, max_len: int = SHORT_MAX) -> String:
	var e = ACTION_HELP.get(code, null)
	if typeof(e) == TYPE_DICTIONARY and e.has("card"):
		return abbreviate(icons_to_words(str(e.card)), max_len + 20)
	return abbreviate(strip_name(action_help(code)), max_len)


## "⚔ 1 dmg · vs 🤺/EP: 2 · beats 🛡 Block" -> "1 dmg · vs Posture/EP: 2 · beats Block"
## A leading icon is dropped; inline icons become words; "Block Block" is collapsed.
static func icons_to_words(text: String) -> String:
	var s := text.strip_edges()
	for icon in ICON_WORDS.keys():
		if s.begins_with(icon):
			s = s.substr(icon.length()).strip_edges()
			break
	for icon in ICON_WORDS.keys():
		var w: String = ICON_WORDS[icon]
		s = s.replace("%s %s" % [icon, w], w)   # "🛡 Block" -> "Block"
		s = s.replace(icon, w)
	return s


## Slot-sized help for any hand card (basic action or skill id).
static func card_short(dl: DataLoader, code: String, max_len: int = SHORT_MAX) -> String:
	if ACTION_HELP.has(code):
		return action_short(code, max_len)
	return abbreviate(card_help(dl, code), max_len)


## "Attack — vs Posture…" -> "vs Posture…"
static func strip_name(text: String) -> String:
	var i := text.find(" — ")
	return text.substr(i + 3) if i >= 0 else text


## Trim to `max_len` characters on a word boundary and append an ellipsis.
static func abbreviate(text: String, max_len: int = SHORT_MAX) -> String:
	text = text.strip_edges()
	if text.length() <= max_len:
		return text
	var cut := text.substr(0, max_len - 1)
	var sp := cut.rfind(" ")
	if sp > max_len / 2:
		cut = cut.substr(0, sp)
	return cut.rstrip(" ·,;:") + "…"


## Full rule text of a skill card from data/skills.json (versions -> active -> data.text).
static func skill_text(dl: DataLoader, skill_id: String) -> String:
	if dl == null:
		return ""
	var entry := dl.get_entry("skills", skill_id)
	if entry.is_empty():
		return ""
	var data := DataLoader.pick_active(entry)
	var d = data.get("data", {})
	if typeof(d) != TYPE_DICTIONARY or not d.has("text"):
		var versions = entry.get("versions", [])
		if typeof(versions) == TYPE_ARRAY and not versions.is_empty() and typeof(versions[0]) == TYPE_DICTIONARY:
			d = versions[0].get("data", {})
	return str(d.get("text", "")) if typeof(d) == TYPE_DICTIONARY else ""


static func skill_name(dl: DataLoader, skill_id: String) -> String:
	if dl == null:
		return skill_id
	return dl.name_of("skills", skill_id)


## Help text for any hand card: basic action codes or skill ids.
static func card_help(dl: DataLoader, code: String) -> String:
	if ACTION_HELP.has(code):
		return action_help(code)
	if code.begins_with("skill_"):
		return skill_text(dl, code)
	return ""


## Infer a help-kind from the catalog kind + label ("Gold Mine (size 1)" -> mine, …).
static func object_kind(feature: Dictionary) -> String:
	var kind := str(feature.get("kind", "building"))
	if kind != "building":
		return kind
	var l := str(feature.get("label", "")).to_lower()
	if l.contains("mine") or l.contains("quarry") or l.contains("foundry") or l.contains("furnace") or l.contains("mill"):
		return "mine"
	if l.contains("temple") or l.contains("shrine") or l.contains("cathedral") or l.contains("henge") or l.contains("totem") or l.contains("ziggurat") or l.contains("grove") or l.contains("ring") or l.contains("tree"):
		return "temple"
	if l.contains("tower") or l.contains("lookout") or l.contains("keep") or l.contains("fortress"):
		return "tower"
	if l.contains("wall") or l.contains("gate"):
		return "wall"
	if l.contains("portal"):
		return "portal"
	return kind


## Description for a map object: the catalog `desc` (feature_table.json, read once),
## else the generic OBJECT_HELP line for its kind.
static func object_desc(feature: Dictionary) -> String:
	var own := str(feature.get("desc", ""))
	if own != "":
		return own
	var id := str(feature.get("id", ""))
	if id != "":
		_load_feature_descs()
		if _feature_desc_cache.has(id):
			return str(_feature_desc_cache[id])
	return str(KIND_DESC.get(object_kind(feature), KIND_DESC["building"]))


static func _load_feature_descs() -> void:
	if _feature_desc_loaded:
		return
	_feature_desc_loaded = true
	for path in ["assets/features/feature_table.json", "assets/terrain_bigfeatures/bigfeature_table.json"]:
		var cfg = Assets.read_json(path)
		if typeof(cfg) != TYPE_DICTIONARY:
			continue
		var by_biome = cfg.get("by_biome", {})
		if typeof(by_biome) != TYPE_DICTIONARY:
			continue
		for pool in by_biome.values():
			if typeof(pool) != TYPE_ARRAY:
				continue
			for c in pool:
				if typeof(c) == TYPE_DICTIONARY and c.has("desc") and str(c.desc) != "":
					_feature_desc_cache[str(c.get("id", c.get("label", "")))] = str(c.desc)
	var sc = Assets.read_json("assets/terrain_scatter/scatter_table.json")
	if typeof(sc) == TYPE_DICTIONARY and typeof(sc.get("items", null)) == TYPE_ARRAY:
		for it in sc.items:
			if typeof(it) == TYPE_DICTIONARY and it.has("desc") and str(it.desc) != "":
				_feature_desc_cache[str(it.get("id", it.get("label", "")))] = str(it.desc)


## Skill-card icon: an AtlasTexture pointing at frame 0 of the icon sheet from
## data/skills.json `resources.sprites.icon` (sibling #1 adds this field). When
## the entry has no `icon` yet we fall back to the first frame of
## `resources.sprites.effect` and guess `cols` from the sheet aspect ratio
## (cols ≈ round(w/h)). Returns null when neither sheet exists or the texture
## fails to load; callers must swap in the words-form string from
## icons_to_words() in that case.
static func skill_icon_texture(dl: DataLoader, skill_id: String) -> Texture2D:
	if dl == null or not skill_id.begins_with("skill_"):
		return null
	if _skill_icon_cache.has(skill_id):
		return _skill_icon_cache[skill_id]
	var entry := dl.get_entry("skills", skill_id)
	var res = entry.get("resources", {})
	var tex: Texture2D = null
	if typeof(res) == TYPE_DICTIONARY:
		var sprites = res.get("sprites", {})
		if typeof(sprites) == TYPE_DICTIONARY:
			var icon = sprites.get("icon", null)
			var path := ""
			var cols := 1
			var frame := 0
			if typeof(icon) == TYPE_DICTIONARY and str(icon.get("path", "")) != "":
				path = str(icon.get("path", ""))
				cols = maxi(1, int(icon.get("cols", 1)))
				frame = int(icon.get("frame", 0))
			else:
				# No dedicated icon sheet yet — slice frame 0 off the effect strip.
				var eff = sprites.get("effect", null)
				if typeof(eff) == TYPE_DICTIONARY:
					path = str(eff.get("path", ""))
					cols = maxi(0, int(eff.get("cols", 0)))
					frame = int(eff.get("frame", 0))
			if path != "":
				var sheet := Assets.load_texture(path)
				if sheet != null:
					if cols <= 1:
						var w := sheet.get_width()
						var h := sheet.get_height()
						if h > 0 and w > h:
							cols = maxi(1, roundi(float(w) / float(h)))
					if cols <= 1:
						tex = sheet
					else:
						var cell_w := int(sheet.get_width() / cols)
						var at := AtlasTexture.new()
						at.atlas = sheet
						at.region = Rect2(frame * cell_w, 0, cell_w, sheet.get_height())
						tex = at
	_skill_icon_cache[skill_id] = tex
	return tex


## True when the icon came from the authoritative `resources.sprites.icon`
## field (not the effect-strip fallback). hud_check.gd uses this to assert
## sibling #1's schema contract is wired through when icons are populated.
static func has_dedicated_icon(dl: DataLoader, skill_id: String) -> bool:
	if dl == null or not skill_id.begins_with("skill_"):
		return false
	var entry := dl.get_entry("skills", skill_id)
	var res = entry.get("resources", {})
	if typeof(res) != TYPE_DICTIONARY:
		return false
	var sprites = res.get("sprites", {})
	if typeof(sprites) != TYPE_DICTIONARY:
		return false
	var icon = sprites.get("icon", null)
	return typeof(icon) == TYPE_DICTIONARY and str(icon.get("path", "")) != ""
