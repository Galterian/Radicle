class_name Hex
## Flat-top axial hex math, identical to game/js/hex.js (HEX_SIZE 46, H_SQUASH 0.72).

const HEX_SIZE := 46.0
const H_SQUASH := 0.72
const DIRS: Array[Vector2i] = [Vector2i(1, 0), Vector2i(1, -1), Vector2i(0, -1), Vector2i(-1, 0), Vector2i(-1, 1), Vector2i(0, 1)]


static func key(q: int, r: int) -> String:
	return "%d,%d" % [q, r]


static func key_of(h: Vector2i) -> String:
	return "%d,%d" % [h.x, h.y]


static func hex_to_pixel(q: int, r: int, size: float = HEX_SIZE) -> Vector2:
	var w := sqrt(3.0) * size
	var h := 1.5 * size
	return Vector2(w * (q + r / 2.0), h * r * H_SQUASH)


static func corners(center: Vector2, size: float = HEX_SIZE) -> PackedVector2Array:
	var out := PackedVector2Array()
	for i in range(6):
		var a := deg_to_rad(60.0 * i - 30.0)
		out.append(Vector2(center.x + size * cos(a), center.y + size * sin(a) * H_SQUASH))
	return out


static func neighbours(h: Vector2i) -> Array[Vector2i]:
	var out: Array[Vector2i] = []
	for d in DIRS:
		out.append(h + d)
	return out


static func distance(a: Vector2i, b: Vector2i) -> int:
	return int((absi(a.x - b.x) + absi(a.x + a.y - b.x - b.y) + absi(a.y - b.y)) / 2)


## World pixel -> nearest axial hex (cube rounding), same as pixelToHexRaw.
static func pixel_to_hex(p: Vector2, size: float = HEX_SIZE) -> Vector2i:
	var w := sqrt(3.0) * size
	var h := 1.5 * size
	var rf := p.y / (h * H_SQUASH)
	var qf := p.x / w - rf / 2.0
	var sf := -qf - rf
	var q := roundi(qf)
	var r := roundi(rf)
	var s := roundi(sf)
	var dq := absf(q - qf)
	var dr := absf(r - rf)
	var ds := absf(s - sf)
	if dq > dr and dq > ds:
		q = -r - s
	elif dr > ds:
		r = -q - s
	return Vector2i(q, r)


## One step along the shortest line from `from` toward `to`, restricted to known hexes.
static func step_toward(from: Vector2i, to: Vector2i, known: Callable) -> Vector2i:
	var best := from
	var best_d := 1 << 30
	for n in neighbours(from):
		if not known.call(n):
			continue
		var d := distance(n, to)
		if d < best_d:
			best_d = d
			best = n
	return best


## Screen-space movement vector -> one of the 8 sheet directions (row names).
static func direction_name(delta: Vector2) -> String:
	if delta.length_squared() < 0.001:
		return "S"
	var ang := rad_to_deg(atan2(delta.y, delta.x))  # E = 0, S = 90, W = 180, N = -90
	var names := ["E", "SE", "S", "SW", "W", "NW", "N", "NE"]
	var idx := int(round(ang / 45.0))
	idx = posmod(idx, 8)
	return names[idx]
