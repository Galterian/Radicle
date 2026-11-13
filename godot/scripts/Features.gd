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
##
## A second pass stamps labyrinth-wall arcs on open ground — see
## _labyrinth_wall_at(). This is a parity mirror of features.js#labyrinthWallAt
## and must match salt names, roll ranges, and the half-circle formula exactly.

## Labyrinth-wall placer parameters (parity mirror of features.js#labyrinthWallAt).
const LAB_SEED_RATE: float = 1.0 / 350.0
const LAB_MIN_LEN := 6
const LAB_MAX_LEN := 12
const LAB_BRANCH_RATE := 0.5
const LAB_CHUNK := 16
const LAB_SPAWN_CLEAR := 2
const LAB_TURNS: Array[int] = [-1, 0, 0, 1]
# Flat-top hex directions, matches Hex.DIRS order exactly.
const LAB_DIRS: Array[Vector2i] = [
	Vector2i(1, 0), Vector2i(1, -1), Vector2i(0, -1),
	Vector2i(-1, 0), Vector2i(-1, 1), Vector2i(0, 1),
]
const LAB_BIOMES := {"grass": true, "high_grass": true, "dirt": true, "high_dirt": true}
# WBC3 wall sprites reused verbatim from feature_table.json (`kind: "wall"`).
const LAB_WALL_PATHS: Array[String] = [
	"assets/Sprites/Buildings/Shared/Walls (neutral, 2x2 joint)/Walls (neutral, 2x2 joint) - base [BWN0].png",
	"assets/Sprites/Buildings/Shared/Walls (neutral, 2x1 horizontal)/Walls (neutral, 2x1 horizontal) - base [BWN1].png",
	"assets/Sprites/Buildings/Shared/Walls (neutral, 1x2 vertical)/Walls (neutral, 1x2 vertical) - base [BWN2].png",
]
const LAB_DESC := "Impassable wall — the fallen rampart of a long-abandoned keep. Units must path around it."
# chunk "cq,cr" computed → true; wall hex "q,r" → [sq, sr, k] (see features.js labChunk)
var _lab_chunks: Dictionary = {}
var _lab_walls: Dictionary = {}

var seed_hex: String
var _catalog: Dictionary = {}         # biome -> Array[Dictionary{id,label,weight,path,kind}]
var _density: Dictionary = {}         # biome -> float
var _min_sep: int = 2
# Per-biome min_separation overrides (optional in the catalog JSON). Coast strips are
# narrow and visually tight, so a slightly larger separation here is the cheap part
# of the "no cluster" fix — it reduces the number of same-biome features inside a
# single strip, which is the condition clustering requires to show up.
var _min_sep_biome: Dictionary = {}
# Radius within which neighbouring features' picks also contribute to the diversity
# check in _pick_idx(). Keep this >= _min_sep so every reachable neighbour counted.
var _diversity_radius: int = 6
var _loaded: bool = false


func _init(seed_hex_: String, catalog_path: String = "assets/features/feature_table.json") -> void:
	seed_hex = seed_hex_
	var cfg = Assets.read_json(catalog_path)
	if typeof(cfg) == TYPE_DICTIONARY:
		_catalog = cfg.get("by_biome", {})
		_density = cfg.get("density", {})
		_min_sep = int(cfg.get("min_separation", 2))
		_min_sep_biome = cfg.get("min_separation_by_biome", {})
		_diversity_radius = int(cfg.get("diversity_radius", maxi(_min_sep + 2, 6)))
		_loaded = true


## Separation radius for a specific biome — allows coast strips to spread features
## farther apart than inland regions even though the global default stays modest.
func _sep_for(biome_type: String) -> int:
	return int(_min_sep_biome.get(biome_type, _min_sep))


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
## The separation radius comes from the local biome so coast strips can spread features
## farther than inland regions.
func _is_candidate(q: int, r: int, biome: Biome) -> bool:
	if biome == null: return false
	var btype := biome.biome_at(q, r)
	if (_catalog.get(btype, []) as Array).is_empty(): return false
	if not _passes_density(q, r, btype): return false
	var my := _roll01(q, r, "f")
	var R := _sep_for(btype)
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


## Score each entry at (q, r) and return the sorted index list, best-first.
## Separated out so the diversity pass below can reach into the top-2 cheaply.
func _ranked_indices(q: int, r: int, choices: Array) -> Array:
	var scored: Array = []
	for i in range(choices.size()):
		var w := float(choices[i].get("weight", 1.0))
		var s := _roll01(q, r, "p%d" % i) * w
		scored.append([s, i])
	scored.sort_custom(func(a, b): return a[0] > b[0])
	var out: Array = []
	for s in scored:
		out.append(int(s[1]))
	return out


## Diversity-aware pick: start with the max-score entry, but demote it if a nearby
## candidate neighbour would independently pick the same index.
##
## "Nearby" = within _diversity_radius hexes AND itself a successful feature
## candidate (passes density + Poisson spacing). "Independently pick the same" =
## top-1 index matches ours. We only yield when (nr, nq) < (r, q), so the ownership
## is deterministic — the first-ordered candidate keeps its pick, later candidates
## shift to top-2 (and top-3, if two neighbours already own both). This breaks the
## 6-identical-building-in-a-strip pattern without needing global state.
func _pick_idx(q: int, r: int, choices: Array, biome: Biome) -> int:
	var ranks := _ranked_indices(q, r, choices)
	if ranks.is_empty(): return -1
	# Track how many "owner" neighbours exist for each tier so we can skip past them.
	var skip_tier := 0
	var R := _diversity_radius
	for dq in range(-R, R + 1):
		var lo := maxi(-R, -dq - R)
		var hi := mini(R, -dq + R)
		for dr in range(lo, hi + 1):
			if dq == 0 and dr == 0: continue
			var nq := q + dq
			var nr := r + dr
			# Only neighbours with the same catalog shape matter — different biome
			# feature pools can repeat an id without visual clustering because the
			# surrounding tiles differ.
			var nbt := biome.biome_at(nq, nr)
			var npool: Array = _catalog.get(nbt, [])
			if npool.is_empty(): continue
			if not _passes_density(nq, nr, nbt): continue
			# Older neighbours (lower (nr, nq)) hold onto their picks; we yield.
			if not (nr < r or (nr == r and nq < q)): continue
			# Compute the neighbour's top-1 if we share a catalog; otherwise ids
			# differ and the diversity check doesn't apply.
			if npool != choices: continue
			var n_rank: int = _ranked_indices(nq, nr, npool)[0] if not npool.is_empty() else -1
			if n_rank == ranks[skip_tier] and skip_tier + 1 < ranks.size():
				skip_tier += 1
	return ranks[skip_tier]


## Labyrinth-wall placer — parity mirror of features.js#labyrinthWallAt (2026-11-12).
## From each sparse seed hex a wall walks 6–12 hexes, bending at most one
## direction per step, plus an optional 2–3 hex side branch; it stops (never
## skips) at ground that isn't open or near the spawn disc. Same salts, rolls and
## chunk ownership rule as features.js so both runtimes draw the same walls.
func _lab_open(q: int, r: int, biome: Biome) -> bool:
	if not LAB_BIOMES.has(biome.biome_at(q, r)): return false
	return (absi(q) + absi(r) + absi(q + r)) / 2 > LAB_SPAWN_CLEAR


func _lab_wall_run(sq: int, sr: int, biome: Biome) -> Array:
	if not _lab_open(sq, sr, biome): return []
	var length := LAB_MIN_LEN + int(_roll01(sq, sr, "lw:len") * float(LAB_MAX_LEN - LAB_MIN_LEN + 1))
	var d := int(_roll01(sq, sr, "lw:orient") * 6.0) % 6
	var run: Array = [Vector2i(sq, sr)]
	var seen := {"%d,%d" % [sq, sr]: true}
	var q := sq
	var r := sr
	for k in range(1, length):
		d = (d + LAB_TURNS[int(_roll01(sq, sr, "lw:turn%d" % k) * 4.0) % 4] + 6) % 6
		var nq := q + LAB_DIRS[d].x
		var nr := r + LAB_DIRS[d].y
		if not _lab_open(nq, nr, biome) or seen.has("%d,%d" % [nq, nr]): break
		run.append(Vector2i(nq, nr)); seen["%d,%d" % [nq, nr]] = true; q = nq; r = nr
	if run.size() >= 4 and _roll01(sq, sr, "lw:branch") < LAB_BRANCH_RATE:
		var mid: Vector2i = run[run.size() / 2]
		var bd := (d + (2 if _roll01(sq, sr, "lw:bside") < 0.5 else 4)) % 6
		var blen := 2 + int(_roll01(sq, sr, "lw:blen") * 2.0)
		var bq := mid.x
		var br := mid.y
		for k in range(blen):
			var nq := bq + LAB_DIRS[bd].x
			var nr := br + LAB_DIRS[bd].y
			if not _lab_open(nq, nr, biome) or seen.has("%d,%d" % [nq, nr]): break
			run.append(Vector2i(nq, nr)); seen["%d,%d" % [nq, nr]] = true; bq = nq; br = nr
	return run


func _lab_chunk(cq: int, cr: int, biome: Biome) -> void:
	var ck := "%d,%d" % [cq, cr]
	if _lab_chunks.has(ck): return
	_lab_chunks[ck] = true
	for sq in range(cq * LAB_CHUNK, (cq + 1) * LAB_CHUNK):
		for sr in range(cr * LAB_CHUNK, (cr + 1) * LAB_CHUNK):
			if _roll01(sq, sr, "lw:seed") >= LAB_SEED_RATE: continue
			var run := _lab_wall_run(sq, sr, biome)
			for k in range(run.size()):
				var key := "%d,%d" % [run[k].x, run[k].y]
				var cur = _lab_walls.get(key)
				# The seed with the smaller (sr, sq) owns a shared hex, as in features.js.
				if cur == null or sr < cur[1] or (sr == cur[1] and sq < cur[0]):
					_lab_walls[key] = [sq, sr, k]


func _labyrinth_wall_at(q: int, r: int, biome: Biome) -> Dictionary:
	if biome == null: return {}
	var cq := floori(float(q) / LAB_CHUNK)
	var cr := floori(float(r) / LAB_CHUNK)
	for i in range(-1, 2):
		for j in range(-1, 2):
			_lab_chunk(cq + i, cr + j, biome)
	var w = _lab_walls.get("%d,%d" % [q, r])
	if w == null: return {}
	return _lab_wall_feature(w[0], w[1], w[2], biome.biome_at(q, r))


func _lab_wall_feature(sq: int, sr: int, k: int, biome_type: String) -> Dictionary:
	var idx := int(_h32("%s:lw:sprite:%d:%d:%d" % [seed_hex, sq, sr, k])) % LAB_WALL_PATHS.size()
	return {
		"path": LAB_WALL_PATHS[idx],
		"label": "Impassable Wall",
		"kind": "wall",
		"desc": LAB_DESC,
		"blocking": true,
		"id": "labyrinth_wall/%d,%d:%d" % [sq, sr, k],
		"biome": biome_type,
	}


## Boolean variant for pathfinding — parity mirror of features.js#isLabyrinthWallAt.
func is_labyrinth_wall(q: int, r: int, biome: Biome) -> bool:
	return not _labyrinth_wall_at(q, r, biome).is_empty()


## {path, label, kind, biome, id} for a feature on (q, r), or {} if none.
func feature_at(q: int, r: int, biome: Biome) -> Dictionary:
	# Labyrinth walls win over vanilla features — parity mirror of
	# features.js#featureAt: wall-first, Poisson pipeline second.
	var lw := _labyrinth_wall_at(q, r, biome)
	if not lw.is_empty(): return lw
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
