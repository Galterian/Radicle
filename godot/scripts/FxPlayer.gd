class_name FxPlayer
extends Node2D
## One-shot effect strips (assets/Sprites/Effects/...) and floating damage numbers.

var _dl: DataLoader


func setup(dl: DataLoader) -> void:
	_dl = dl


## Play the effect mapped to `effect_id` (data/effects.json -> resources.sprites.effect) at a hex.
func play_effect(effect_id: String, at: Vector2i, additive := true) -> void:
	var res := _dl.resources_of("effects", effect_id) if _dl != null else {}
	var sp = res.get("sprites", {})
	var rel := ""
	if typeof(sp) == TYPE_DICTIONARY:
		for k in ["effect", "static", "cast", "special"]:
			if sp.has(k) and typeof(sp[k]) == TYPE_DICTIONARY:
				rel = str(sp[k].get("path", ""))
				if Assets.exists(rel):
					break
				rel = ""
	if rel != "":
		play_sheet(rel, at, additive)
	else:
		burst(Hex.hex_to_pixel(at.x, at.y), Color(0.95, 0.7, 0.3))
	var snd = res.get("sounds", {})
	if typeof(snd) == TYPE_DICTIONARY:
		var fx = snd.get("fx", [])
		if typeof(fx) == TYPE_ARRAY and not fx.is_empty():
			var pick = fx[randi() % fx.size()]
			var p := str(pick.get("path", "")) if typeof(pick) == TYPE_DICTIONARY else str(pick)
			play_wav(p, Hex.hex_to_pixel(at.x, at.y))


func play_sheet(rel: String, at: Vector2i, additive := true) -> void:
	var sf := SheetAnimator.frames_for(rel, "fx", 0)
	if sf == null:
		return
	var spr := AnimatedSprite2D.new()
	spr.sprite_frames = sf
	spr.position = Hex.hex_to_pixel(at.x, at.y)
	spr.z_index = 50
	var anim := sf.get_animation_names()[0]
	var tex := sf.get_frame_texture(anim, 0)
	if tex != null:
		var target := Hex.HEX_SIZE * 2.2
		var s := clampf(target / maxf(tex.get_height(), 1.0), 0.3, 2.0)
		spr.scale = Vector2.ONE * s
		spr.offset = Vector2(0, -tex.get_height() * 0.35)
	if additive:
		var mat := CanvasItemMaterial.new()
		mat.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
		spr.material = mat
	add_child(spr)
	spr.animation_finished.connect(spr.queue_free)
	spr.play(anim)


func play_wav(rel: String, at: Vector2) -> void:
	var stream := Assets.load_wav(rel)
	if stream == null:
		return
	var p := AudioStreamPlayer2D.new()
	p.stream = stream
	p.position = at
	p.max_distance = 3000
	add_child(p)
	p.finished.connect(p.queue_free)
	p.play()


## Floating number / text above a world position.
func float_text(at: Vector2, text: String, col: Color) -> void:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", 18)
	l.add_theme_color_override("font_color", col)
	l.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.9))
	l.add_theme_constant_override("outline_size", 4)
	l.position = at + Vector2(-30, -70)
	l.size = Vector2(60, 24)
	l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	l.z_index = 100
	add_child(l)
	var t := create_tween()
	t.tween_property(l, "position:y", l.position.y - 40, 0.9).set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	t.parallel().tween_property(l, "modulate:a", 0.0, 0.9).set_delay(0.3)
	t.finished.connect(l.queue_free)


## Simple procedural burst when no sheet is mapped.
func burst(at: Vector2, col: Color) -> void:
	var n := Node2D.new()
	n.position = at
	n.z_index = 50
	var r := [0.0]
	n.draw.connect(_burst_draw.bind(n, r, col))
	add_child(n)
	var t := create_tween()
	t.tween_method(_burst_step.bind(n, r), 0.0, 1.0, 0.5)
	t.finished.connect(n.queue_free)


func _burst_draw(n: Node2D, r: Array, col: Color) -> void:
	n.draw_arc(Vector2.ZERO, 6.0 + r[0] * 40.0, 0, TAU, 24, Color(col, 1.0 - r[0]), 3.0, true)


func _burst_step(v: float, n: Node2D, r: Array) -> void:
	r[0] = v
	n.queue_redraw()
