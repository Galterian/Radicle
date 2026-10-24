class_name MapGen
extends RefCounted
## Grow-only known map of blocks — a faithful port of game/js/map.js so that
## every hex this client materialises matches what the Node peers draw.

const INITIAL_SIZE := 5
const DEFAULT_REVEAL_RADIUS := 10
const TERRAIN := [
	{"type": "ash", "fill": Color("#141a24"), "alt": Color("#101620")},
	{"type": "cinder", "fill": Color("#1b1a22"), "alt": Color("#17161e")},
	{"type": "basalt", "fill": Color("#111a1e"), "alt": Color("#0e161a")},
	{"type": "ember", "fill": Color("#201913"), "alt": Color("#1b150f")},
]

var seed_hex: String = "0x00000000"
var _blocks: Dictionary = {}   # id -> block dict
var _tiles: Dictionary = {}    # "q,r" -> Vector2i
var _bounds: Dictionary = {}


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
	add_block(initial_block())
	for b in blocks:
		add_block(b)


func terrain_at(q: int, r: int) -> Dictionary:
	var h := hash32("%s:%d:%d" % [seed_hex, q, r])
	var t: Dictionary = TERRAIN[h % TERRAIN.size()]
	var fill: Color = t.alt if ((q + r) & 1) == 1 else t.fill
	return {"type": t.type, "fill": fill}


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
