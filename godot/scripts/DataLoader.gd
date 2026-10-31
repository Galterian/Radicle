class_name DataLoader
extends RefCounted
## Loads ../data/*.json (VersionedEntry files) in index.json load order and exposes the
## active version of each entry plus its non-versioned `resources` block (asset mapping).

var files: Dictionary = {}      # "characters" -> parsed file (Dictionary or Array)
var entries: Dictionary = {}    # kind -> { id -> entry }
var load_order: Array = []


func load_all() -> void:
	var root := Assets.repo_root()
	var index = Assets.read_json(root.path_join("data/index.json"))
	load_order = []
	if typeof(index) == TYPE_DICTIONARY:
		var lo = index.get("load_order_for_engine", [])
		if typeof(lo) == TYPE_ARRAY:
			load_order = lo
	if load_order.is_empty():
		load_order = ["concept", "stats", "elements", "rules", "battle_system", "actions", "effects", "skills",
			"classes", "terrain_items", "characters", "creatures", "game_modes"]
	for kind in load_order:
		var parsed = Assets.read_json(root.path_join("data/%s.json" % kind))
		if parsed == null:
			continue
		files[kind] = parsed
		entries[kind] = {}
		for e in _entry_list(parsed, kind):
			if typeof(e) == TYPE_DICTIONARY and e.has("id"):
				entries[kind][e.id] = e


## Files are either {"<kind>": [...]} / {"entries": [...]} or a bare array.
static func _entry_list(parsed: Variant, kind: String) -> Array:
	if typeof(parsed) == TYPE_ARRAY:
		return parsed
	if typeof(parsed) == TYPE_DICTIONARY:
		for k in [kind, "entries", "items"]:
			if parsed.has(k) and typeof(parsed[k]) == TYPE_ARRAY:
				return parsed[k]
		for v in parsed.values():
			if typeof(v) == TYPE_ARRAY and not v.is_empty() and typeof(v[0]) == TYPE_DICTIONARY and v[0].has("versions"):
				return v
	return []


## Same rule as game/js/data.js pickActive: highest weight among versions whose status is
## neither rejected nor superseded; ties -> later version string.
static func pick_active(entry: Dictionary) -> Dictionary:
	var best: Dictionary = {}
	var best_w := -1e18
	for v in entry.get("versions", []):
		if typeof(v) != TYPE_DICTIONARY:
			continue
		var st := str(v.get("status", "")).to_lower()
		if st == "rejected" or st == "superseded":
			continue
		var w := float(v.get("weight", 0))
		if w > best_w or (w == best_w and str(v.get("version", "")) > str(best.get("version", ""))):
			best_w = w
			best = v
	return best


func get_entry(kind: String, id: String) -> Dictionary:
	return entries.get(kind, {}).get(id, {})


func data_of(kind: String, id: String) -> Dictionary:
	var e := get_entry(kind, id)
	if e.is_empty():
		return {}
	return pick_active(e).get("data", {})


func resources_of(kind: String, id: String) -> Dictionary:
	var e := get_entry(kind, id)
	var r = e.get("resources", {})
	return r if typeof(r) == TYPE_DICTIONARY else {}


func ids(kind: String) -> Array:
	return entries.get(kind, {}).keys()


func name_of(kind: String, id: String) -> String:
	var e := get_entry(kind, id)
	return str(e.get("name", id))


## Resolution matrix from battle_system.json -> {"A|P": 1, "A|B": -1, ...}
func resolution_edges() -> Dictionary:
	var out := {"A|P": 1, "A|B": -1, "P|M": -1, "M|B": 1, "M|P": -1, "B|A": 1}
	var d := data_of("battle_system", "battle_system_core")
	var rm = d.get("resolution_matrix", {})
	if typeof(rm) == TYPE_DICTIONARY:
		var edges = rm.get("edges", [])
		if typeof(edges) == TYPE_ARRAY and not edges.is_empty():
			out = {}
			for e in edges:
				if typeof(e) == TYPE_DICTIONARY:
					out["%s|%s" % [e.get("actor", ""), e.get("defender", "")]] = int(e.get("bonus_damage_to_actor", 0))
	return out
