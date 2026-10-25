class_name MapGen
extends RefCounted
## Grow-only known map of blocks — a faithful port of game/js/map.js so that
## every hex this client materialises matches what the Node peers draw.

const INITIAL_SIZE := 5
const DEFAULT_REVEAL_RADIUS := 10
# Legacy ash/cinder/basalt/ember flat palette (used when terrain_tiles.json is missing
# and as the final fallback inside HexMap). The real tiles live under assets/terrain/.
const TERRAIN := [
	{"type": "ash", "fill": Color("#141a24"), "alt": Color("#101620")},
	{"type": "cinder", "fill": Color("#1b1a22"), "alt": Color("#17161e")},
	{"type": "basalt", "fill": Color("#111a1e"), "alt": Color("#0e161a")},
	{"type": "ember", "fill": Color("#201913"), "alt": Color("#1b150f")},
]
# Fill colours per biome, matching assets/terrain/terrain_tiles.json chaos_terrain.fill.
# Used when the hex sits outside the view-port tile atlas or when terrain_tiles.json
# fails to load. Keeps the "flat colour" fallback consistent with the real tiles.
const BIOME_FILL := {
	"grass": "#2d4a26", "high_grass": "#243d1f", "grass_coast": "#3a4e2e",
	"dirt": "#5a4a30", "high_dirt": "#4a3d26",
	"desert": "#b89866", "desert_cliffs": "#8a6a3a",
	"snow": "#c8d4de", "snow_coast": "#9eb0c0",
	"rock": "#4a4a52", "rock_coast": "#5e5a58", "rock_cliffs": "#3a383c",
	"mountains": "#5a5260", "jungle": "#1a3818", "marsh": "#334434",
	"water": "#1a4a68", "lava": "#8a2a16", "caverns": "#141a24",
}

var seed_hex: String = "0x00000000"
var _blocks: Dictionary = {}   # id -> block dict
var _tiles: Dictionary = {}    # "q,r" -> Vector2i
var _bounds: Dictionary = {}
var biome: Biome                 # deterministic biome sampler for this dimension
var features: Features           # deterministic feature placer (null if catalog missing)
var scatter: Scatter             # deterministic scatter overlay placer (bonus WBC3 decorations)
var bigfeature: BigFeature       # deterministic placer for rare 2x2-sized landmark features
var _features_dirty := true
var _features_cache: Array = []
var _scatter_dirty := true
var _scatter_cache: Array = []
var _bigfeatures_dirty := true
var _bigfeatures_cache: Array = []


## FNV-1a over the UTF-16 code units of `s` -> 32-bit unsigned (same arithmetic as JS).
static func hash32(s: String) -> int:
	var h := 0x811c9dc5
	for i in range(s.length()):
		h ^= s.unicode_at(i)
		h = (h * 0x01000193) & 0xFFFFFFFF
	return h


static func seed_for_dimension(dim_id: String) -> String:
	return "0x" + ("%08x" % hash32("chaosd6:" + dim_id))


static func initial_block(size: int = INITIAL_SIZE) -> Dictionary:
	return {"id": "rect:0,0,%dx%d" % [size, size], "kind": "rect", "q": 0, "r": 0, "w": size, "h": size, "by": "genesis"}


static func disc_block(q: int, r: int, radius: int, by: String = "") -> Dictionary:
	return {"id": "disc:%d,%d,%d" % [q, r, radius], "kind": "disc", "q": q, "r": r, "radius": radius, "by": by,
		"at": Time.get_datetime_string_from_system(true)}


static func block_tiles(b: Dictionary) -> Array[Vector2i]:
	var out: Array[Vector2i] = []
	if b.get("kind") == "rect":
		for r in range(int(b.r), int(b.r) + int(b.h)):
			for q in range(int(b.q), int(b.q) + int(b.w)):
				out.append(Vector2i(q, r))
	elif b.get("kind") == "disc":
		var R := int(b.radius)
		for dq in range(-R, R + 1):
			var lo := maxi(-R, -dq - R)
			var hi := mini(R, -dq + R)
			for dr in range(lo, hi + 1):
				out.append(Vector2i(int(b.q) + dq, int(b.r) + dr))
	return out


func _init(dim_id: String = "Ashfall-Micro", blocks: Array = []) -> void:
	seed_hex = seed_for_dimension(dim_id)
	biome = Biome.new(seed_hex)
	features = Features.new(seed_hex)
	scatter = Scatter.new(seed_hex)
	bigfeature = BigFeature.new(seed_hex)
	add_block(initial_block())
	for b in blocks:
		add_block(b)


## Deterministic feature on this specific hex (building/permanent) or {} if none.
func feature_at(q: int, r: int) -> Dictionary:
	if features == null or biome == null: return {}
	return features.feature_at(q, r, biome)


## All features inside the currently-known tiles.
func features_for_known() -> Array:
	if features == null or biome == null: return []
	if _features_dirty:
		_features_cache = features.features_for(_tiles.values(), biome)
		_features_dirty = false
	return _features_cache


## All scatter overlays inside the currently-known tiles.
func scatter_for_known() -> Array:
	if scatter == null or biome == null: return []
	if _scatter_dirty:
		_scatter_cache = scatter.scatter_for(_tiles.values(), biome)
		_scatter_dirty = false
	return _scatter_cache


## All big-feature landmarks inside the currently-known tiles.
func bigfeatures_for_known() -> Array:
	if bigfeature == null or biome == null: return []
	if _bigfeatures_dirty:
		_bigfeatures_cache = bigfeature.big_features_for(_tiles.values(), biome)
		_bigfeatures_dirty = false
	return _bigfeatures_cache


## Pick the nearest walkable hex within `max_radius` of (q, r). Returns the hex itself
## if it's already walkable, or {} if nothing walkable is reachable within the radius.
## Used by the spawner so a fixed-position spawn never lands in water/lava.
func nearest_walkable(h: Vector2i, max_radius: int = 4) -> Vector2i:
	if biome == null:
		return h
	if _walkable(biome.biome_at(h.x, h.y)):
		return h
	for R in range(1, max_radius + 1):
		for dq in range(-R, R + 1):
			var lo := maxi(-R, -dq - R)
			var hi := mini(R, -dq + R)
			for dr in range(lo, hi + 1):
				if abs(dq) + abs(dr) + abs(dq + dr) != 2 * R: continue   # ring only
				var n := Vector2i(h.x + dq, h.y + dr)
				if _walkable(biome.biome_at(n.x, n.y)):
					return n
	return h   # give up, caller gets the (unwalkable) original


## Returns {type, fill, walkable, elev, moist, temp} for a hex. `type` is a key from
## assets/terrain/terrain_tiles.json chaos_terrain (grass, lava, snow_coast, …) — not the
## old 4-biome ash/cinder/basalt/ember set.
func terrain_at(q: int, r: int) -> Dictionary:
	var s := biome.sample(q, r)
	var t := biome.biome_at(q, r)
	var hex := "#%06x" % 0
	if BIOME_FILL.has(t):
		hex = BIOME_FILL[t]
	var fill := Color(hex)
	# Micro-shade adjacent hexes so flat-colour fallback still shows seams.
	if ((q + r) & 1) == 1:
		fill = fill.darkened(0.06)
	return {"type": t, "fill": fill, "walkable": _walkable(t), "elev": s.elev, "moist": s.moist, "temp": s.temp}


static func _walkable(biome_type: String) -> bool:
	match biome_type:
		"water", "lava", "mountains", "rock_cliffs", "desert_cliffs": return false
		_: return true


func has(h: Vector2i) -> bool:
	return _tiles.has(Hex.key_of(h))


func size() -> int:
	return _tiles.size()


func blocks() -> Array:
	return _blocks.values()


func tiles() -> Array:
	return _tiles.values()


func bounds() -> Dictionary:
	return _bounds.duplicate()


func add_block(b: Dictionary) -> bool:
	if not b.has("id") or _blocks.has(b.id):
		return false
	if b.get("kind") != "rect" and b.get("kind") != "disc":
		return false
	_blocks[b.id] = b.duplicate()
	for t in block_tiles(b):
		_tiles[Hex.key_of(t)] = t
		if _bounds.is_empty():
			_bounds = {"min_q": t.x, "max_q": t.x, "min_r": t.y, "max_r": t.y}
		else:
			_bounds.min_q = mini(_bounds.min_q, t.x)
			_bounds.max_q = maxi(_bounds.max_q, t.x)
			_bounds.min_r = mini(_bounds.min_r, t.y)
			_bounds.max_r = maxi(_bounds.max_r, t.y)
	_features_dirty = true
	_scatter_dirty = true
	_bigfeatures_dirty = true
	return true


## True when some hex within `radius` of (q,r) is still unknown.
func needs_reveal(h: Vector2i, radius: int) -> bool:
	for t in block_tiles({"kind": "disc", "q": h.x, "r": h.y, "radius": radius}):
		if not _tiles.has(Hex.key_of(t)):
			return true
	return false


## Reveal around a position if it is closer than `radius` to the frontier. Returns the new block or {}.
func reveal_around(h: Vector2i, radius: int = DEFAULT_REVEAL_RADIUS, by: String = "") -> Dictionary:
	if not needs_reveal(h, radius):
		return {}
	var b := disc_block(h.x, h.y, radius, by)
	return b if add_block(b) else {}


## Unknown hexes adjacent to a known one — the fog line.
func frontier() -> Array[Vector2i]:
	var out: Dictionary = {}
	for t in _tiles.values():
		for n in Hex.neighbours(t):
			var k := Hex.key_of(n)
			if not _tiles.has(k) and not out.has(k):
				out[k] = n
	var arr: Array[Vector2i] = []
	for v in out.values():
		arr.append(v)
	return arr
