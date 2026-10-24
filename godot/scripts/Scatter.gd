class_name Scatter
extends RefCounted
## Deterministic scatter (small decorative overlays — rocks, grass tufts, flowers, dead
## trees, snow pines, ruins). These are the "bonus other resources" borrowed from the
## real WBC3 archive to break up uniform biome regions and visually soften transitions.
##
## Separate from Features.gd on purpose: features are rare, high-value, Poisson-spaced
## (one per hex of interest). Scatter is dense, no spacing constraint — the goal is to
## cover 20-45% of walkable hexes so a revealed region never looks flat.
##
## scatter_at(q, r) is a pure function of (dim_seed, q, r, biome). Reveal grows the map
## and new scatter overlays appear automatically with no state change.

var seed_hex: String
var _items: Array = []                 # [{id, label, path, biomes, family}]
var _per_biome: Dictionary = {}        # biome -> Array[int]  (indices into _items)
var _density: Dictionary = {}          # biome -> float
var _loaded := false


func _init(seed_hex_: String, catalog_path: String = "assets/terrain_scatter/scatter_table.json") -> void:
	seed_hex = seed_hex_
	var cfg = Assets.read_json(catalog_path)
	if typeof(cfg) != TYPE_DICTIONARY:
		return
	_items = cfg.get("items", [])
	_density = cfg.get("density", {})
	for i in range(_items.size()):
		var it: Dictionary = _items[i]
		for b in (it.get("biomes", []) as Array):
			if not _per_biome.has(b):
				_per_biome[b] = []
			_per_biome[b].append(i)
	_loaded = true


static func _h32(s: String) -> int:
	var h := 0x811c9dc5
	for i in range(s.length()):
		h ^= s.unicode_at(i)
		h = (h * 0x01000193) & 0xFFFFFFFF
	return h


func _roll01(q: int, r: int, salt: String) -> float:
	return float(_h32("%s:s:%s:%d:%d" % [seed_hex, salt, q, r])) / 4294967296.0


func scatter_at(q: int, r: int, biome: Biome) -> Dictionary:
	if not _loaded or biome == null: return {}
	var btype := biome.biome_at(q, r)
	var d: float = float(_density.get(btype, 0.0))
	if d <= 0: return {}
	if _roll01(q, r, "d") >= d: return {}
	var pool: Array = _per_biome.get(btype, [])
	if pool.is_empty(): return {}
	# Pick the item index whose hash scores highest for this hex — gives varied-looking
	# clusters without biasing toward any single sprite in a long biome strip.
	var best_idx := 0
	var best_score := -1.0
	for i in pool:
		var s := _roll01(q, r, "p%d" % i)
		if s > best_score:
			best_score = s
			best_idx = i
	var it: Dictionary = _items[best_idx]
	return {
		"path": it.path,
		"label": it.get("label", ""),
		"id": it.get("id", ""),
		"family": it.get("family", ""),
		"biome": btype,
		"kind": "scatter",
	}


func scatter_for(hexes: Array, biome: Biome) -> Array:
	var out: Array = []
	if not _loaded or biome == null: return out
	for h in hexes:
		var q: int = h.x
		var r: int = h.y
		var s := scatter_at(q, r, biome)
		if not s.is_empty():
			out.append({"hex": Vector2i(q, r), "scatter": s})
	return out
