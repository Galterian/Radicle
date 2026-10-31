class_name BigFeatureLayer
extends Node2D
## Draws the rare "big feature" landmarks (forest clusters, boulder piles, snow
## pines, cactus clumps, ruins) above the terrain and small scatter but below
## buildings. These sprites are scaled to visually span ~2 hex widths so a single
## one anchors a whole mini-region — the way real WBC3 maps break up uniform
## biome strips.
##
## z-order: HexMap(0) < ScatterLayer(3) < BigFeatureLayer(4) < FeatureLayer(5)
##   < Entities(10). Keeps buildings in front of trees so a tower never gets
##   hidden under a canopy.

var gen: MapGen

var _tex_cache: Dictionary = {}   # path -> Texture2D


func setup(gen_: MapGen) -> void:
	gen = gen_
	z_index = 4
	queue_redraw()


func _draw() -> void:
	if gen == null or gen.bigfeature == null or gen.biome == null:
		return
	var hex_h := Hex.HEX_SIZE * 2.0 * Hex.H_SQUASH
	var hex_w := sqrt(3.0) * Hex.HEX_SIZE
	# Y-sort so overlapping big features stack correctly.
	var items := gen.bigfeatures_for_known()
	items.sort_custom(func(a, b): return a.hex.y < b.hex.y or (a.hex.y == b.hex.y and a.hex.x < b.hex.x))
	for item in items:
		var tex := _tex(item.big_feature.path)
		if tex == null: continue
		var centre := Hex.hex_to_pixel(item.hex.x, item.hex.y)
		# Target visual width of ~2 hex widths. Scale uniformly so proportions stay
		# correct; some sprites are tall (dead trees), others wide (log/colonnade).
		var target_w: float = hex_w * 2.0
		var sx := tex.get_width()
		var sy := tex.get_height()
		# clamp against very large sprites so a 640px source doesn't blow out the view
		var scale: float = clampf(target_w / max(1, sx), 0.25, 1.4)
		var dw := sx * scale
		var dh := sy * scale
		# Small deterministic jitter so two neighbouring big features never share the
		# same baseline exactly — the real game's forest clusters feel organic.
		var h32 := MapGen.hash32("%s:bj:%d:%d" % [gen.seed_hex, item.hex.x, item.hex.y])
		var jx := (float(h32 & 0xFFFF) / 65536.0 - 0.5) * hex_h * 0.22
		var jy := (float((h32 >> 16) & 0xFFFF) / 65536.0 - 0.5) * hex_h * 0.15
		# Anchor the sprite's base near the hex centre so trees "stand on" the hex,
		# while large canopies overlap the hex above (which is exactly the 2x2 effect
		# WBC3 ships with its 640x480 TxF tiles).
		var rect := Rect2(centre.x - dw / 2.0 + jx, centre.y - dh + hex_h * 0.35 + jy, dw, dh)
		draw_texture_rect(tex, rect, false)


func _tex(path: String) -> Texture2D:
	if _tex_cache.has(path):
		return _tex_cache[path]
	var tex := Assets.load_texture(path)
	_tex_cache[path] = tex
	return tex
