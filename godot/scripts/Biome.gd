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

# Sub-biome structure (applied AFTER the Whittaker matrix picks a base biome).
# Two extra independent noise channels break up long uniform regions the way real
# WBC3 maps do: `ridge` grows snow-capped mountain clusters (with a rock rim)
# inside cold/high regions, `lake` carves lakes (with a shore ring and the
# occasional isle) into lowlands. Finer lattice than the base channels so a
# ~700-hex reveal sees several of them. Measured percentiles of the raw channel:
# 0.70 = top 15%, 0.77 = top 7%, 0.80 = top 5%, 0.88 = top 1%.
# Mirror of game/js/biome.js — constants and branch order must stay identical.
const SUB_BASE_SCALE := 0.18
const SUB_DETAIL_SCALE := 0.42
const SUB_CONTRAST := 1.0
const RIDGE_MOUNTAIN := 0.80
const RIDGE_FOOTHILL := 0.70
const LAKE_WATER := 0.80
const LAKE_SHORE := 0.77
const LAKE_ISLE := 0.88
const RIDGE_BIOMES := ["snow", "rock", "high_dirt", "high_grass", "grass"]
const SHORE_OF := {
	"grass": "grass_coast", "high_grass": "grass_coast", "grass_coast": "grass_coast",
	"marsh": "grass_coast", "jungle": "grass_coast",
	"snow": "snow_coast", "snow_coast": "snow_coast",
	"dirt": "rock_coast", "high_dirt": "rock_coast", "desert": "rock_coast",
	"rock": "rock_coast", "rock_coast": "rock_coast",
}

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


# Finer-lattice FBM for the ridge / lake sub-biome channels. Mirror of biome.js fbmSub.
static func _fbm_sub(seed_hex: String, qf: float, rf: float, salt: String) -> float:
	var v := _value_noise(seed_hex, qf * SUB_BASE_SCALE, rf * SUB_BASE_SCALE, salt)
	v += 0.5 * _value_noise(seed_hex, qf * SUB_DETAIL_SCALE, rf * SUB_DETAIL_SCALE, salt + ".d")
	return clampf((v / 1.5 - 0.5) * SUB_CONTRAST + 0.5, 0.0, 1.0)


## Sample the two sub-biome channels for a hex: {ridge, lake} in [0, 1].
func sample_sub(q: int, r: int) -> Dictionary:
	var qf := float(q)
	var rf := float(r)
	var ridge := _fbm_sub(seed_hex, qf + 3000.0, rf + 3000.0, "r")
	var lake := _fbm_sub(seed_hex, qf - 3000.0, rf + 3000.0, "l")
	return {"ridge": ridge, "lake": lake}


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
	var base := base_biome(s.elev, s.moist, s.temp)
	var sub := sample_sub(q, r)
	var ridge: float = sub.ridge
	var lake: float = sub.lake
	# --- mountains inside cold / high regions (rock rim inside snow) ---
	if base in RIDGE_BIOMES:
		if ridge > RIDGE_MOUNTAIN: return "mountains"
		if base == "snow" and ridge > RIDGE_FOOTHILL: return "rock"
	# --- lakes inside lowlands: shore ring, water, isle ---
	if s.elev < HIGHLAND and is_walkable(base) and SHORE_OF.has(base):
		if lake > LAKE_ISLE: return base
		if lake > LAKE_WATER: return "water"
		if lake > LAKE_SHORE: return SHORE_OF[base]
	return base


static func is_walkable(biome_type: String) -> bool:
	match biome_type:
		"water", "lava", "mountains", "rock_cliffs", "desert_cliffs": return false
		_: return true


## The Whittaker-matrix pick before the ridge / lake overlays. Mirror of biome.js baseBiome.
func base_biome(e: float, m: float, t: float) -> String:
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
		# Cool buffer (0.28..0.42): no jungle/marsh. Keeps snow neighbours safe —
		# the archive has no snow↔jungle / snow↔marsh transition tiles, so we
		# never let those biomes be adjacent at the sampler level.
		if t < 0.42:
			if m < 0.3: return "dirt"
			if m < 0.65: return "grass"
			return "high_grass"
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
		# Cool buffer in highlands too — no high-moisture biome touches snow.
		if t < 0.45:
			if m < 0.3: return "high_dirt"
			return "high_grass"
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
