class_name Features
extends RefCounted
## Deterministic feature (building/permanent) placer. Mirror of game/js/features.js.
##
## feature_at(q, r) is a pure function of (dim_seed, q, r, biome) plus the catalog in
## assets/features/feature_table.json. "Pure" means revealing a new disc of hexes always
## produces the same feature set — no state kept outside the catalog.
##
## Placement algorithm (deterministic Poisson-like):
##   1. If the hex isn't walkable, skip.
##   2. Hash (seed, q, r) to a 0..1 roll. If roll > density[biome], skip.
##   3. For every neighbour hex within `min_separation`, repeat the above test.
##      If any neighbour wins with a smaller hash, this hex loses -> skip.
##      (Lowest-hash hex wins; produces spacing without needing global state.)
##   4. Pick the feature from catalog[biome] by weight-roll on another hash.

var seed_hex: String
var _catalog: Dictionary = {}         # biome -> Array[Dictionary{id,label,weight,path,kind}]
var _density: Dictionary = {}         # biome -> float
var _min_sep: int = 2
var _loaded: bool = false


func _init(seed_hex_: String, catalog_path: String = "assets/features/feature_table.json") -> void:
	seed_hex = seed_hex_
	var cfg = Assets.read_json(catalog_path)
	if typeof(cfg) == TYPE_DICTIONARY:
		_catalog = cfg.get("by_biome", {})
		_density = cfg.get("density", {})
		_min_sep = int(cfg.get("min_separation", 2))
		_loaded = true


static func _h32(s: String) -> int:
	var h := 0x811c9dc5
	for i in range(s.length()):
		h ^= s.unicode_at(i)
		h = (h * 0x01000193) & 0xFFFFFFFF
	return h


func _roll01(q: int, r: int, salt: String) -> float:
	return float(_h32("%s:%s:%d:%d" % [seed_hex, salt, q, r])) / 4294967296.0


func _passes_density(q: int, r: int, biome_type: String) -> bool:
	var d = float(_density.get(biome_type, 0.0))
	if d <= 0: return false
	return _roll01(q, r, "f") < d


## Nearest-wins Poisson spacing: the hex with the lowest "f" hash among all
## hexes within radius `min_sep` that also pass the density check gets the feature.
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
			# tie-break by (q, r) so equal hashes still have a stable winner
			if nh < my or (nh == my and (nr < r or (nr == r and nq < q))):
				return false
	return true


## {path, label, kind, biome, id} for a feature on (q, r), or {} if none.
func feature_at(q: int, r: int, biome: Biome) -> Dictionary:
	if not _loaded: return {}
	if not _is_candidate(q, r, biome): return {}
	var btype := biome.biome_at(q, r)
	var choices: Array = _catalog.get(btype, [])
	if choices.is_empty(): return {}
	# Pick by max-hash across choices: each entry gets its own hash of (seed, q, r, idx)
	# then we pick the index with the largest hash * weight. This produces much better
	# spatial variety than hash%N — adjacent features in a long biome strip reliably
	# pick different entries, instead of all landing on the highest-weight option.
	var best_idx := 0
	var best_score := -1.0
	for i in range(choices.size()):
		var w := float(choices[i].get("weight", 1.0))
		var s := _roll01(q, r, "p%d" % i) * w
		if s > best_score:
			best_score = s
			best_idx = i
	var c = choices[best_idx]
	return {"path": c.path, "label": c.label, "kind": c.get("kind", "building"), "biome": btype, "id": c.get("id", c.label)}


## Iterate all features currently visible on the given hex set.
## Yields {hex: Vector2i, feature: {...}}.
func features_for(hexes: Array, biome: Biome) -> Array:
	var out: Array = []
	if not _loaded or biome == null: return out
	for h in hexes:
		var q: int = h.x if typeof(h) == TYPE_VECTOR2I else int(h.q)
		var r: int = h.y if typeof(h) == TYPE_VECTOR2I else int(h.r)
		var f := feature_at(q, r, biome)
		if not f.is_empty():
			out.append({"hex": Vector2i(q, r), "feature": f})
	return out
