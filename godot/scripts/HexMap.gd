class_name HexMap
extends Node2D
## Draws the known hex map: WBC3-derived hex tiles from assets/terrain/terrain_tiles.json when
## available, otherwise flat polygons with the exact map.js colours. Also draws the dashed
## frontier, hover/selection highlights and the planned path.

signal hex_clicked(h: Vector2i, button: int)
signal hex_hovered(h: Vector2i)

var gen: MapGen
var hover: Vector2i = Vector2i(1 << 20, 0)
var selected: Vector2i = Vector2i(1 << 20, 0)
var path_preview: Array[Vector2i] = []
var reach: Dictionary = {}   # "q,r" -> true, hexes reachable this round (tinted)

var _tiles_cfg: Dictionary = {}
var _tile_tex: Dictionary = {}     # terrain type -> Array[Texture2D]
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
	_tile_scale = (expected_w / tw) * 1.10
	var ct = cfg.get("chaos_terrain", {})
	if typeof(ct) != TYPE_DICTIONARY:
		return
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


func _draw_tile(t: Vector2i) -> void:
	var c := Hex.hex_to_pixel(t.x, t.y)
	var terr := gen.terrain_at(t.x, t.y)
	if _use_tiles and _tile_tex.has(terr.type):
		var arr: Array = _tile_tex[terr.type]
		var tex: Texture2D = arr[MapGen.hash32("%s:v:%d:%d" % [gen.seed_hex, t.x, t.y]) % arr.size()]
		var sz := Vector2(tex.get_width(), tex.get_height()) * _tile_scale
		var rect := Rect2(c - sz / 2.0, sz)
		var tint := Color(1, 1, 1, 1) if ((t.x + t.y) & 1) == 0 else Color(0.93, 0.93, 0.95, 1)
		draw_texture_rect(tex, rect, false, tint)
	else:
		var pts := Hex.corners(c, Hex.HEX_SIZE)
		draw_colored_polygon(pts, terr.fill)
		draw_polyline(_closed(pts), Color(0.3, 0.33, 0.4, 0.45), 1.0, true)


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
