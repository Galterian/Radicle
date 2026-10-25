class_name BigFeature
extends RefCounted
## Deterministic placer for rare "big feature" landmarks — large forest clusters,
## boulder piles, pine stands, cactus clumps and ruins that visually span ~2 hex
## widths. Mirror of the Features.gd shape, with:
##   - lower density (~0.02 per hex), so they feel like landmarks
##   - larger min_separation (6+), so two big clusters never touch
##   - its own neighbour-aware diversity check so a long biome strip doesn't repeat
##     the same forest sprite
##
## big_feature_at(q, r) is a pure function of (dim_seed, q, r, biome). Reveal grows
## the known map and new big features automatically appear.

var seed_hex: String
var _catalog: Dictionary = {}         # biome -> Array[Dictionary]
var _density: Dictionary = {}
var _min_sep: int = 6
var _loaded: bool = false


func _init(seed_hex_: String, catalog_path: String = "assets/terrain_bigfeatures/bigfeature_table.json") -> void:
	seed_hex = seed_hex_
	var cfg = Assets.read_json(catalog_path)
	if typeof(cfg) == TYPE_DICTIONARY:
		_catalog = cfg.get("by_biome", {})
		_density = cfg.get("density", {})
		_min_sep = int(cfg.get("min_separation", 6))
		_loaded = true


static func _h32(s: String) -> int:
	var h := 0x811c9dc5
	for i in range(s.length()):
		h ^= s.unicode_at(i)
		h = (h * 0x01000193) & 0xFFFFFFFF
	return h


func _roll01(q: int, r: int, salt: String) -> float:
	return float(_h32("%s:B:%s:%d:%d" % [seed_hex, salt, q, r])) / 4294967296.0


func _passes_density(q: int, r: int, biome_type: String) -> bool:
	var d = float(_density.get(biome_type, 0.0))
	if d <= 0: return false
	return _roll01(q, r, "f") < d


## Nearest-wins Poisson spacing identical to Features.gd — the hex with the lowest
## "f" hash among all candidates inside radius `min_sep` keeps the slot.
func _is_candidate(q: int, r: int, biome: Biome) -> bool:
	if biome == null: return false
	var btype := biome.biome_at(q, r)
	if (_catalog.get(btype, []) as Array).is_empty(): return false
	if not _passes_density(q, r, btype): return false
	var my := _roll01(q, r, "f")
	var R := _min_sep
	for dq in range(-R, R + 1):
		var lo := maxi(-R, -dq - R)
		var hi := mini(R, -dq + R)
		for dr in range(lo, hi + 1):
			if dq == 0 and dr == 0: continue
			var nq := q + dq
			var nr := r + dr
			var nbt := biome.biome_at(nq, nr)
			if (_catalog.get(nbt, []) as Array).is_empty(): continue
			if not _passes_density(nq, nr, nbt): continue
			var nh := _roll01(nq, nr, "f")
			if nh < my or (nh == my and (nr < r or (nr == r and nq < q))):
				return false
	return true


## Pick index of the entry with the highest score at (q, r); return -1 if the pool
## is empty. Score = roll(seed, q, r, "p<idx>") * weight. Mirrors Features.gd._pick_idx
## so adjacent cells in a long strip reliably choose different sprites.
func _pick_idx(q: int, r: int, pool: Array) -> int:
	var best_idx := -1
	var best_score := -1.0
	for i in range(pool.size()):
		var w := float(pool[i].get("weight", 1.0))
		var s := _roll01(q, r, "p%d" % i) * w
		if s > best_score:
			best_score = s
			best_idx = i
	return best_idx


func big_feature_at(q: int, r: int, biome: Biome) -> Dictionary:
	if not _loaded: return {}
	if not _is_candidate(q, r, biome): return {}
	var btype := biome.biome_at(q, r)
	var pool: Array = _catalog.get(btype, [])
	if pool.is_empty(): return {}
	var idx := _pick_idx(q, r, pool)
	if idx < 0: return {}
	var c = pool[idx]
	return {
		"path": c.path,
		"label": c.label,
		"kind": "big_feature",
		"biome": btype,
		"id": c.get("id", c.label),
		"native_w": int(c.get("native_w", 0)),
		"native_h": int(c.get("native_h", 0)),
	}


## Iterate every big feature inside a set of known hexes.
func big_features_for(hexes: Array, biome: Biome) -> Array:
	var out: Array = []
	if not _loaded or biome == null: return out
	for h in hexes:
		var q: int = h.x if typeof(h) == TYPE_VECTOR2I else int(h.q)
		var r: int = h.y if typeof(h) == TYPE_VECTOR2I else int(h.r)
		var f := big_feature_at(q, r, biome)
		if not f.is_empty():
			out.append({"hex": Vector2i(q, r), "big_feature": f})
	return out
