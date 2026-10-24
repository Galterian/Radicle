class_name Biome
extends RefCounted
## Deterministic biome generator. Mirror of game/js/biome.js — the same (dim_seed, q, r)
## must yield the same biome in Godot and the browser so a dimension looks identical to
## every peer and across sessions.
##
## Pipeline per hex:
##   elevation  = FBM(seed, q, r)          # 0..1
##   moisture   = FBM(seed + "m", q, r)
##   temperature = FBM(seed + "t", q, r) + heat_bias   # heat_bias per dimension (-0.5..0.5)
## Then a Whittaker-like matrix picks one of the 18 chaos_terrain keys from
## assets/terrain/terrain_tiles.json. The matrix below favours *regions*: biomes change
## only when all three channels change, so neighbouring hexes mostly agree and
## boundaries are smooth bands rather than a hex-by-hex speckle.

const WATER_LEVEL := 0.26
const COAST_BAND := 0.05
const HIGHLAND := 0.60
const ROUGH := 0.78
const PEAK := 0.90
# Noise lattices (world hexes per lattice step). Lower = larger coherent regions.
const BASE_SCALE := 0.07
const DETAIL_SCALE := 0.17

var seed_hex: String
var heat_bias: float = 0.0
var wet_bias: float = 0.0


func _init(seed_hex_: String) -> void:
	seed_hex = seed_hex_
	# Per-dimension bias so one dimension is hot (desert/lava heavy), another cold
	# (snow heavy), another wet, etc. Deterministic from the dim seed.
	heat_bias = (float(_h32(seed_hex + ":heat") % 1000) / 1000.0 - 0.5) * 0.8
	wet_bias  = (float(_h32(seed_hex + ":wet")  % 1000) / 1000.0 - 0.5) * 0.6


static func _h32(s: String) -> int:
	var h := 0x811c9dc5
	for i in range(s.length()):
		h ^= s.unicode_at(i)
		h = (h * 0x01000193) & 0xFFFFFFFF
	return h


# [0, 1] from (seed, ix, iy)
static func _rand01(seed_hex: String, ix: int, iy: int, salt: String) -> float:
	return float(_h32("%s:%s:%d:%d" % [seed_hex, salt, ix, iy])) / 4294967296.0


# Bilinear value noise with smoothstep.
static func _value_noise(seed_hex: String, x: float, y: float, salt: String) -> float:
	var ix := int(floor(x))
	var iy := int(floor(y))
	var fx := x - ix
	var fy := y - iy
	var sx := fx * fx * (3.0 - 2.0 * fx)
	var sy := fy * fy * (3.0 - 2.0 * fy)
	var a := _rand01(seed_hex, ix,     iy,     salt)
	var b := _rand01(seed_hex, ix + 1, iy,     salt)
	var c := _rand01(seed_hex, ix,     iy + 1, salt)
	var d := _rand01(seed_hex, ix + 1, iy + 1, salt)
	var ab := a + sx * (b - a)
	var cd := c + sx * (d - c)
	return ab + sy * (cd - ab)


# Two-octave FBM, normalised to [0, 1].
static func _fbm(seed_hex: String, qf: float, rf: float, salt: String) -> float:
	var v := _value_noise(seed_hex, qf * BASE_SCALE, rf * BASE_SCALE, salt)
	v += 0.5 * _value_noise(seed_hex, qf * DETAIL_SCALE, rf * DETAIL_SCALE, salt + ".d")
	return clampf(v / 1.5, 0.0, 1.0)


## Sample all three channels for a hex. Public so the renderer can tint by elevation
## or do its own weighting if desired.
func sample(q: int, r: int) -> Dictionary:
	var qf := float(q)
	var rf := float(r)
	var elev  := _fbm(seed_hex, qf, rf, "e")
	var moist := clampf(_fbm(seed_hex, qf + 1000.0, rf - 1000.0, "m") + wet_bias, 0.0, 1.0)
	var temp  := clampf(_fbm(seed_hex, qf - 500.0, rf + 500.0, "t") + heat_bias, 0.0, 1.0)
	return {"elev": elev, "moist": moist, "temp": temp}


## Which biome key (matches terrain_tiles.json chaos_terrain) belongs at (q, r)?
## The matrix is intentionally region-shaped: elevation picks a *band*, then
## (moisture, temperature) select within it. No single-channel is enough to flip
## biome at a hex boundary, so neighbours overwhelmingly agree.
func biome_at(q: int, r: int) -> String:
	var s := sample(q, r)
	var e: float = s.elev
	var m: float = s.moist
	var t: float = s.temp

	# --- water / coast ---
	if e < WATER_LEVEL:
		if t > 0.78 and e < WATER_LEVEL - 0.03:
			return "lava"              # extreme hot = lava "sea"
		return "water"

	if e < WATER_LEVEL + COAST_BAND:
		if t < 0.3: return "snow_coast"
		if m > 0.55: return "grass_coast"
		if t > 0.7: return "rock_coast"
		return "rock_coast"

	# --- lowlands ---
	if e < HIGHLAND:
		if t > 0.82 and m < 0.3:
			return "lava"
		if t < 0.28:
			return "snow" if m > 0.3 else "snow_coast"
		if t > 0.7:
			if m < 0.25: return "desert"
			if m < 0.55: return "dirt"
			return "jungle" if m > 0.75 else "grass"
		if m < 0.18: return "desert"
		if m < 0.35: return "dirt"
		if m < 0.65: return "grass"
		if m < 0.82: return "marsh"
		return "jungle"

	# --- highlands ---
	if e < ROUGH:
		if t < 0.3: return "snow"
		if m < 0.3: return "high_dirt"
		if m < 0.65: return "high_grass"
		if t > 0.6: return "jungle"
		return "marsh"

	# --- rough / cliffs ---
	if e < PEAK:
		if t < 0.3: return "snow"
		if t > 0.78 and m < 0.4: return "desert_cliffs"
		if m < 0.4: return "rock"
		if m < 0.7: return "rock_cliffs"
		return "caverns"               # deep ravines / underground

	# --- peaks ---
	if t < 0.4: return "snow"
	return "mountains"
