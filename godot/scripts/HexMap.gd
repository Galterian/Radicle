class_name HexMap
extends Node2D
## Draws the known hex map: WBC3-derived hex tiles from assets/terrain/terrain_tiles.json when
## available, otherwise flat polygons with the exact map.js colours. Also draws the dashed
## frontier, hover/selection highlights and the planned path.
##
## Terrain-edge blending (fixes the "hard biome edge" problem):
##   For every hex we build a 6-bit edge mask (bit i = 1 when neighbour i has a different
##   biome than this hex, Hex.DIRS order). When terrain_transitions.json offers tiles for
##   (own_biome, dominant_foreign_biome) we pick the tile whose authored mask has the
##   lowest Hamming distance to the required mask (deterministic hash tie-break).
##   Otherwise we fall back to the base variant pick.
##
## Variety:
##   Base tiles are deterministically mirrored (flip_h / flip_v from hash32) so the same
##   N variants effectively cover ~4N appearances. Transition tiles are drawn un-mirrored
##   because mirroring would permute their edge mask.

signal hex_clicked(h: Vector2i, button: int)
signal hex_hovered(h: Vector2i)

var gen: MapGen
var hover: Vector2i = Vector2i(1 << 20, 0)
var selected: Vector2i = Vector2i(1 << 20, 0)
var path_preview: Array[Vector2i] = []
var reach: Dictionary = {}   # "q,r" -> true, hexes reachable this round (tinted)

var _tiles_cfg: Dictionary = {}
var _tile_tex: Dictionary = {}     # terrain type -> Array[Texture2D]
# own_biome -> foreign_biome -> Array[{tex: Texture2D, mask: int, code: String}]
var _trans_tex: Dictionary = {}
var _tile_scale := 1.0
var _tile_size := Vector2(159, 132)
var _use_tiles := false


func setup(map_gen: MapGen) -> void:
	gen = map_gen
	_load_tiles()
	queue_redraw()


func _load_tiles() -> void:
	var cfg = Assets.read_json("assets/terrain/terrain_tiles.json")
	if typeof(cfg) != TYPE_DICTIONARY:
		return
	_tiles_cfg = cfg
	var hexcfg: Dictionary = cfg.get("hex", {})
	var tw := float(hexcfg.get("tile_w", 159))
	var th := float(hexcfg.get("tile_h", 132))
	_tile_size = Vector2(tw, th)
	# Flat-top hex: width is the long axis (2*HEX_SIZE). Alpha-masked WBC3 tiles
	# are soft-edged so a tiny overlap (5%) blends adjacent tiles smoothly.
	var expected_w := 2.0 * Hex.HEX_SIZE
	# Overlap matches the import mask's 1.18 outer ring so neighbour tiles
	# alpha-blend through each other and biome boundaries blur across hex edges.
	_tile_scale = (expected_w / tw) * 1.18
	var ct = cfg.get("chaos_terrain", {})
	if typeof(ct) == TYPE_DICTIONARY:
		for ttype in ct.keys():
			var variants = ct[ttype].get("variants", []) if typeof(ct[ttype]) == TYPE_DICTIONARY else ct[ttype]
			var arr: Array = []
			if typeof(variants) == TYPE_ARRAY:
				for p in variants:
					var tex := Assets.load_texture(str(p))
					if tex != null:
						arr.append(tex)
			if not arr.is_empty():
				_tile_tex[ttype] = arr
	_use_tiles = _tile_tex.size() >= 1

	# Load transition tiles (edge-blending set). Optional — the renderer falls
	# back to base variants when a (own, foreign) pair has no transitions.
	var tcfg = Assets.read_json("assets/terrain/terrain_transitions.json")
	if typeof(tcfg) == TYPE_DICTIONARY:
		var trans: Dictionary = tcfg.get("transitions", {})
		if typeof(trans) == TYPE_DICTIONARY:
			for own_biome in trans.keys():
				var by_for: Dictionary = trans[own_biome]
				if typeof(by_for) != TYPE_DICTIONARY:
					continue
				var own_dict: Dictionary = {}
				for foreign_biome in by_for.keys():
					var tiles = by_for[foreign_biome]
					if typeof(tiles) != TYPE_ARRAY:
						continue
					var list: Array = []
					for rec in tiles:
						if typeof(rec) != TYPE_DICTIONARY: continue
						var path = str(rec.get("path", ""))
						var mask = int(rec.get("edge_mask", 0))
						if path == "" or mask == 0: continue
						var tex := Assets.load_texture(path)
						if tex == null: continue
						list.append({"tex": tex, "mask": mask, "code": str(rec.get("code", ""))})
					if not list.is_empty():
						own_dict[foreign_biome] = list
				if not own_dict.is_empty():
					_trans_tex[own_biome] = own_dict


func world_to_hex(p: Vector2) -> Vector2i:
	return Hex.pixel_to_hex(to_local(p))


func _draw() -> void:
	if gen == null:
		return
	var tiles := gen.tiles()
	# Terrain, back to front so overlapping tile art stacks correctly.
	tiles.sort_custom(func(a, b): return a.y < b.y or (a.y == b.y and a.x < b.x))
	for t in tiles:
		_draw_tile(t)
	# Persistent hex grid overlay — faint so terrain still reads as continuous,
	# but visible enough to anchor the gameplay interaction (movement, targeting).
	for t in tiles:
		var c := Hex.hex_to_pixel(t.x, t.y)
		draw_polyline(_closed(Hex.corners(c, Hex.HEX_SIZE)), Color(0.0, 0.0, 0.0, 0.18), 1.0, true)
	# Frontier (unknown neighbours of known hexes) as dashed outlines.
	for f in gen.frontier():
		var c := Hex.hex_to_pixel(f.x, f.y)
		var pts := Hex.corners(c, Hex.HEX_SIZE * 0.92)
		for i in range(6):
			_dashed(pts[i], pts[(i + 1) % 6], Color(0.55, 0.45, 0.35, 0.35))
	# Reachable tint.
	for k in reach.keys():
		var parts: PackedStringArray = k.split(",")
		var c := Hex.hex_to_pixel(int(parts[0]), int(parts[1]))
		draw_colored_polygon(Hex.corners(c, Hex.HEX_SIZE * 0.9), Color(0.95, 0.75, 0.3, 0.10))
	# Path preview.
	if path_preview.size() > 0:
		var prev := Hex.hex_to_pixel(selected.x, selected.y) if gen.has(selected) else Hex.hex_to_pixel(path_preview[0].x, path_preview[0].y)
		for h in path_preview:
			var c := Hex.hex_to_pixel(h.x, h.y)
			draw_line(prev, c, Color(0.95, 0.75, 0.3, 0.7), 2.0, true)
			draw_circle(c, 4.0, Color(0.95, 0.75, 0.3, 0.9))
			prev = c
	# Hover & selection.
	if gen.has(hover):
		var c := Hex.hex_to_pixel(hover.x, hover.y)
		draw_polyline(_closed(Hex.corners(c, Hex.HEX_SIZE * 0.95)), Color(0.9, 0.85, 0.7, 0.8), 1.5, true)
	if gen.has(selected):
		var c := Hex.hex_to_pixel(selected.x, selected.y)
		draw_polyline(_closed(Hex.corners(c, Hex.HEX_SIZE * 0.97)), Color(0.98, 0.65, 0.2, 1.0), 2.5, true)


# Build the edge mask + find the dominant foreign biome for the hex at (q, r).
# Returns {"mask": int, "foreign": String}. `foreign` is empty when every
# neighbour matches (mask == 0).
func _compute_edge_mask(q: int, r: int, own_type: String) -> Dictionary:
	var mask := 0
	var counts: Dictionary = {}
	for i in range(Hex.DIRS.size()):
		var d: Vector2i = Hex.DIRS[i]
		var n_type: String = gen.biome.biome_at(q + d.x, r + d.y)
		if n_type == own_type:
			continue
		mask |= (1 << i)
		counts[n_type] = int(counts.get(n_type, 0)) + 1
	var foreign := ""
	var best := 0
	# Deterministic pick: first by count desc, then by biome name asc.
	var keys := counts.keys()
	keys.sort()
	for k in keys:
		var c: int = counts[k]
		if c > best:
			best = c
			foreign = k
	return {"mask": mask, "foreign": foreign}


# Pick the transition tile whose authored mask is closest (Hamming distance) to
# `required`. Among ties, prefer the one whose authored mask is a SUPERSET of
# the required mask (every required bit set + maybe extras), then tie-break by
# a deterministic hash of (seed, q, r, code) so re-renders look identical.
func _pick_transition(candidates: Array, required: int, q: int, r: int) -> Dictionary:
	var best = null
	var best_score := Vector3i(999, 999, 0)   # (hamming, superset_penalty, hash)
	for rec in candidates:
		var m: int = rec.mask
		var diff: int = m ^ required
		var hamming: int = _popcount6(diff)
		# "Superset-matching" bonus: no required bit missing from m.
		var missing: int = required & ~m
		var superset_penalty: int = _popcount6(missing)
		var h: int = int(MapGen.hash32("%s:tr:%d:%d:%s" % [gen.seed_hex, q, r, rec.code])) & 0xFFFF
		var score := Vector3i(hamming, superset_penalty, h)
		if best == null \
				or score.x < best_score.x \
				or (score.x == best_score.x and score.y < best_score.y) \
				or (score.x == best_score.x and score.y == best_score.y and score.z < best_score.z):
			best = rec
			best_score = score
	return best if best != null else {}


static func _popcount6(x: int) -> int:
	var n := 0
	for i in range(6):
		if (x >> i) & 1:
			n += 1
	return n


func _draw_tile(t: Vector2i) -> void:
	var c := Hex.hex_to_pixel(t.x, t.y)
	var terr := gen.terrain_at(t.x, t.y)
	if not (_use_tiles and _tile_tex.has(terr.type)):
		var pts := Hex.corners(c, Hex.HEX_SIZE)
		draw_colored_polygon(pts, terr.fill)
		draw_polyline(_closed(pts), Color(0.3, 0.33, 0.4, 0.45), 1.0, true)
		return

	# Decide between a transition tile and a base variant.
	var mask_info := _compute_edge_mask(t.x, t.y, terr.type)
	var required_mask: int = mask_info.mask
	var foreign: String = mask_info.foreign

	var picked_tex: Texture2D = null
	var is_transition := false
	if required_mask != 0 and _trans_tex.has(terr.type):
		var by_for: Dictionary = _trans_tex[terr.type]
		if by_for.has(foreign):
			var pick := _pick_transition(by_for[foreign], required_mask, t.x, t.y)
			if not pick.is_empty():
				picked_tex = pick.tex
				is_transition = true

	if picked_tex == null:
		var arr: Array = _tile_tex[terr.type]
		var vhash: int = int(MapGen.hash32("%s:v:%d:%d" % [gen.seed_hex, t.x, t.y]))
		picked_tex = arr[vhash % arr.size()]

	var sz := Vector2(picked_tex.get_width(), picked_tex.get_height()) * _tile_scale
	# Deterministic ±5% brightness jitter in addition to the odd/even seam shade.
	var jhash: int = int(MapGen.hash32("%s:j:%d:%d" % [gen.seed_hex, t.x, t.y]))
	var jitter: float = 1.0 + ((float(jhash & 1023) / 1023.0) - 0.5) * 0.10
	var seam: float = 1.0 if ((t.x + t.y) & 1) == 0 else 0.95
	var k: float = clampf(jitter * seam, 0.80, 1.10)
	var tint := Color(k, k, k * 1.01, 1.0)

	if is_transition:
		# Transitions encode which edges carry the foreign biome; mirroring would
		# break that, so draw them in their authored orientation.
		var rect := Rect2(c - sz / 2.0, sz)
		draw_texture_rect(picked_tex, rect, false, tint)
	else:
		# Deterministic 2-bit mirror for base variants to multiply apparent variety.
		var mhash: int = int(MapGen.hash32("%s:m:%d:%d" % [gen.seed_hex, t.x, t.y]))
		var sx: float = -1.0 if (mhash & 1) else 1.0
		var sy: float = -1.0 if ((mhash >> 1) & 1) else 1.0
		draw_set_transform(c, 0.0, Vector2(sx, sy))
		draw_texture_rect(picked_tex, Rect2(-sz / 2.0, sz), false, tint)
		draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)


static func _closed(pts: PackedVector2Array) -> PackedVector2Array:
	var out := PackedVector2Array(pts)
	out.append(pts[0])
	return out


func _dashed(a: Vector2, b: Vector2, col: Color, dash := 6.0) -> void:
	var len := a.distance_to(b)
	var dir := (b - a) / len
	var d := 0.0
	while d < len:
		var e := minf(d + dash, len)
		draw_line(a + dir * d, a + dir * e, col, 1.0, true)
		d += dash * 2.0


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion:
		var h := world_to_hex(get_global_mouse_position())
		if h != hover:
			hover = h
			hex_hovered.emit(h)
			queue_redraw()
	elif event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_LEFT or event.button_index == MOUSE_BUTTON_RIGHT:
			var h := world_to_hex(get_global_mouse_position())
			hex_clicked.emit(h, event.button_index)
