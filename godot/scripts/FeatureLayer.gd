class_name FeatureLayer
extends Node2D
## Draws buildings and other permanents (one per hex at most) above the terrain and
## below entities. Features come from MapGen.features (a Features instance) and are
## pure functions of (dim_seed, q, r), so new reveals automatically populate.

var gen: MapGen

var _hex_scale := 0.9       # feature sprite height relative to a hex height
var _tex_cache: Dictionary = {}   # path -> Texture2D


func setup(gen_: MapGen) -> void:
	gen = gen_
	z_index = 5                # above HexMap (which draws at default z), below entities
	queue_redraw()


func _draw() -> void:
	if gen == null or gen.features == null or gen.biome == null:
		return
	var hex_h := Hex.HEX_SIZE * 2.0 * Hex.H_SQUASH
	# Y-sort features by hex row so overlapping sprites stack correctly.
	var items := gen.features_for_known()
	items.sort_custom(func(a, b): return a.hex.y < b.hex.y or (a.hex.y == b.hex.y and a.hex.x < b.hex.x))
	for item in items:
		var tex := _tex(item.feature.path)
		if tex == null: continue
		var centre := Hex.hex_to_pixel(item.hex.x, item.hex.y)
		# Target on-screen height ≈ 1.1 hex so buildings sit on a hex without crowding neighbours.
		var target_h := hex_h * 1.1
		var sx := tex.get_width()
		var sy := tex.get_height()
		var scale := clampf(target_h / max(1, sy), 0.25, 1.2)
		var dw := sx * scale
		var dh := sy * scale
		# Anchor bottom-centre on the hex centre (slight offset so the "foot" lands on tile)
		var rect := Rect2(centre.x - dw / 2.0, centre.y - dh + hex_h * 0.12, dw, dh)
		draw_texture_rect(tex, rect, false)


func _tex(path: String) -> Texture2D:
	if _tex_cache.has(path):
		return _tex_cache[path]
	var tex := Assets.load_texture(path)
	_tex_cache[path] = tex
	return tex
