class_name ScatterLayer
extends Node2D
## Draws small decorative overlays (grass tufts, boulders, dead trees, flowers, ...) above
## the terrain and below buildings. Pure function of (dim_seed, q, r, biome) via
## MapGen.scatter. New reveals auto-populate.

var gen: MapGen
var _tex_cache: Dictionary = {}   # path -> Texture2D


func setup(gen_: MapGen) -> void:
	gen = gen_
	z_index = 3   # above HexMap (0), below FeatureLayer (5), well below entities (10)
	queue_redraw()


func _draw() -> void:
	if gen == null or gen.scatter == null or gen.biome == null:
		return
	var hex_h := Hex.HEX_SIZE * 2.0 * Hex.H_SQUASH
	# Sort by row so overlapping sprites stack naturally back-to-front.
	var items := gen.scatter_for_known()
	items.sort_custom(func(a, b): return a.hex.y < b.hex.y or (a.hex.y == b.hex.y and a.hex.x < b.hex.x))
	for item in items:
		var tex := _tex(item.scatter.path)
		if tex == null: continue
		var centre := Hex.hex_to_pixel(item.hex.x, item.hex.y)
		# Deterministic jitter so overlays don't align into visible rows.
		var h32 := MapGen.hash32("%s:sj:%d:%d" % [gen.seed_hex, item.hex.x, item.hex.y])
		var jx := (float(h32 & 0xFFFF) / 65536.0 - 0.5) * hex_h * 0.55
		var jy := (float((h32 >> 16) & 0xFFFF) / 65536.0 - 0.5) * hex_h * 0.42
		# Scatter is small — target ~0.55 hex height, with a bit of per-hex size variation.
		var size_jit := 0.85 + (float((h32 >> 8) & 0xFF) / 255.0) * 0.35   # 0.85..1.20
		var target_h: float = hex_h * 0.55 * size_jit
		var sx := tex.get_width()
		var sy := tex.get_height()
		var scale: float = clampf(target_h / max(1, sy), 0.08, 0.9)
		var dw := sx * scale
		var dh := sy * scale
		var rect := Rect2(centre.x - dw / 2.0 + jx, centre.y - dh + hex_h * 0.15 + jy, dw, dh)
		draw_texture_rect(tex, rect, false)


func _tex(path: String) -> Texture2D:
	if _tex_cache.has(path):
		return _tex_cache[path]
	var tex := Assets.load_texture(path)
	_tex_cache[path] = tex
	return tex
