class_name SheetAnimator
## Turns a WBC3 sprite sheet (cols = frames, 8 rows = facing directions N,NE,E,SE,S,SW,W,NW — row 0 faces away from the camera)
## into a SpriteFrames resource at runtime: one animation per direction, named "<state>_<DIR>".
## Grid comes from assets/frames.json; if a sheet is unknown we detect it from transparent
## boundaries, and as a last resort assume square-ish cells (cols = round(w / (h/8 * 1.1))).

const DIRECTIONS: Array[String] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]  # verified visually (Knight Champion, Minotaur)
const DEFAULT_FPS := 12.0
static var _sf_cache: Dictionary = {}   # "rel|state" -> SpriteFrames (shared, cheap to reuse)
static var _grid_cache: Dictionary = {}


## Grid for a sheet: {cols, rows, cell_w, cell_h, kind, fps, loop}.
static func grid_for(rel: String, hint_kind := "") -> Dictionary:
	if _grid_cache.has(rel):
		return _grid_cache[rel]
	var g := {}
	var info := Assets.frame_info(rel)
	var img := Assets.load_image(rel)
	if img == null:
		_grid_cache[rel] = g
		return g
	var w := img.get_width()
	var h := img.get_height()
	if not info.is_empty() and int(info.get("cols", 0)) > 0 and int(info.get("rows", 0)) > 0:
		g = {
			"cols": int(info.cols), "rows": int(info.rows),
			"cell_w": int(info.get("cell_w", w / int(info.cols))), "cell_h": int(info.get("cell_h", h / int(info.rows))),
			"kind": str(info.get("kind", "unit-8dir")), "fps": float(info.get("fps", DEFAULT_FPS)),
			"loop": bool(info.get("loop", true)), "method": "frames.json",
		}
	else:
		g = _detect_grid(img, hint_kind)
	_grid_cache[rel] = g
	return g


## Build (or fetch) SpriteFrames for a sheet. For 8-row sheets the animations are
## "<state>_S", "<state>_SE", ...; for strips/singles a lone "<state>" animation.
static func frames_for(rel: String, state: String, loop_override := -1) -> SpriteFrames:
	var ck := rel + "|" + state
	if _sf_cache.has(ck):
		return _sf_cache[ck]
	var tex := Assets.load_texture(rel)
	if tex == null:
		_sf_cache[ck] = null
		return null
	var g := grid_for(rel, state)
	if g.is_empty():
		_sf_cache[ck] = null
		return null
	var sf := SpriteFrames.new()
	var loop: bool = g.loop if loop_override < 0 else bool(loop_override)
	var cw: int = g.cell_w
	var ch: int = g.cell_h
	var cols: int = g.cols
	var rows: int = g.rows
	if rows == 8 and g.kind != "strip" and g.kind != "single":
		for r in range(8):
			var anim: String = state + "_" + DIRECTIONS[r]
			sf.add_animation(anim)
			sf.set_animation_speed(anim, g.fps)
			sf.set_animation_loop(anim, loop)
			for c in range(cols):
				sf.add_frame(anim, _cell(tex, Rect2(c * cw, r * ch, cw, ch)))
	else:
		sf.add_animation(state)
		sf.set_animation_speed(state, g.fps)
		sf.set_animation_loop(state, loop)
		for r in range(rows):
			for c in range(cols):
				sf.add_frame(state, _cell(tex, Rect2(c * cw, r * ch, cw, ch)))
	if sf.has_animation("default"):
		sf.remove_animation("default")
	_sf_cache[ck] = sf
	return sf


static func has_directions(sf: SpriteFrames, state: String) -> bool:
	return sf != null and sf.has_animation(state + "_S")


static func _cell(tex: Texture2D, region: Rect2) -> AtlasTexture:
	var at := AtlasTexture.new()
	at.atlas = tex
	at.region = region
	return at


# ---------------------------------------------------------------- grid detection

static func _detect_grid(img: Image, hint_kind: String) -> Dictionary:
	var w := img.get_width()
	var h := img.get_height()
	var kind := "unit-8dir"
	var rows := 8
	var cols := 1
	if hint_kind == "effect" or hint_kind == "strip" or hint_kind == "death":
		kind = "strip"
		rows = 1
	# 1. Rows: 8 clean horizontal boundaries?
	if rows == 8 and (h % 8 != 0 or not _clean_h_boundaries(img, 8)):
		rows = _best_divisor(img, h, true)
		if rows <= 1:
			kind = "strip" if w > h * 1.5 else "single"
			rows = 1
	# 2. Columns from clean vertical boundaries.
	cols = _best_divisor(img, w, false)
	if cols <= 1:
		if kind == "unit-8dir":
			var ch := h / rows
			cols = maxi(1, roundi(float(w) / (ch * 1.1)))
			if w % cols != 0:
				cols = _nearest_divisor(w, cols)
		else:
			cols = 1
	if kind == "strip" and rows == 1 and cols == 1:
		kind = "single"
	return {"cols": cols, "rows": rows, "cell_w": w / cols, "cell_h": h / rows, "kind": kind,
		"fps": DEFAULT_FPS, "loop": kind != "single", "method": "runtime"}


static func _clean_h_boundaries(img: Image, n: int) -> bool:
	var ch := img.get_height() / n
	var clean := 0
	for k in range(1, n):
		if _row_transparent(img, k * ch - 1) or _row_transparent(img, k * ch):
			clean += 1
	return clean >= int(ceil((n - 1) * 0.85))


static func _best_divisor(img: Image, extent: int, horizontal: bool) -> int:
	var best := 1
	for n in range(2, 65):
		if extent % n != 0:
			continue
		var cell := extent / n
		if cell < 16:
			break
		var clean := 0
		for k in range(1, n):
			var ok := false
			if horizontal:
				ok = _row_transparent(img, k * cell - 1) or _row_transparent(img, k * cell)
			else:
				ok = _col_transparent(img, k * cell - 1) or _col_transparent(img, k * cell)
			if ok:
				clean += 1
		if clean >= int(ceil((n - 1) * 0.85)):
			best = n  # largest clean divisor wins
	return best


static func _nearest_divisor(n: int, target: int) -> int:
	var best := 1
	var best_d := 1 << 30
	for d in range(1, n + 1):
		if n % d == 0 and absi(d - target) < best_d:
			best_d = absi(d - target)
			best = d
	return best


static func _row_transparent(img: Image, y: int) -> bool:
	if y < 0 or y >= img.get_height():
		return true
	var w := img.get_width()
	var step := maxi(1, w / 256)
	for x in range(0, w, step):
		if img.get_pixel(x, y).a > 0.02:
			return false
	return true


static func _col_transparent(img: Image, x: int) -> bool:
	if x < 0 or x >= img.get_width():
		return true
	var h := img.get_height()
	var step := maxi(1, h / 256)
	for y in range(0, h, step):
		if img.get_pixel(x, y).a > 0.02:
			return false
	return true
