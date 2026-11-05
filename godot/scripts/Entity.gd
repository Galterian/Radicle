class_name Entity
extends Node2D
## One character / creature on the hex map, animated from WBC3 sprite sheets.
## States: idle, walk, attack, death, fidget, cast. Facing is picked from the movement or
## attack vector (8 sheet rows). Moves slide one hex per round along a path.

signal arrived
signal died(entity: Entity)
signal animation_done(state: String)

const SLIDE_TIME := 0.55   # seconds per hex when sliding
const FIDGET_CHANCE := 0.15

var id: String = ""
var kind: String = "characters"     # "characters" | "creatures"
var display_name: String = ""
var faction: String = "player"      # "player" | "npc"
var hex: Vector2i = Vector2i.ZERO
var life := 4
var life_max := 4
var actions_per_round := 3
var combo: Array = ["A", "P", "M"]
var data: Dictionary = {}
var resources: Dictionary = {}
var alive := true
var state := "idle"
var facing := "S"

var _sheets: Dictionary = {}      # state -> rel path
var _sprites: AnimatedSprite2D
var _shadow: Node2D
var _label: Label
var _pips: Node2D
var _audio: AudioStreamPlayer2D
var _sfx: AudioStreamPlayer2D
var _tween: Tween
var _path: Array[Vector2i] = []
var _rng := RandomNumberGenerator.new()
var _scale_fix := 1.0
var _last_play_key: String = ""   # (sheet|state|facing|anim) of the most recent mutation; guards against per-tick re-plays that reset frame to 0 (observed as flicker on mobile GL compat).


func setup(ent_id: String, ent_kind: String, dl: DataLoader, start: Vector2i, fac: String, fallback_sheets: Dictionary = {}) -> void:
	id = ent_id
	kind = ent_kind
	faction = fac
	hex = start
	display_name = dl.name_of(kind, id)
	data = dl.data_of(kind, id)
	resources = dl.resources_of(kind, id)
	life_max = int(data.get("life", 4))
	life = life_max
	actions_per_round = int(data.get("actions_per_round", 3))
	if data.has("combo") and typeof(data.combo) == TYPE_ARRAY:
		combo = data.combo
	_rng.randomize()
	_collect_sheets(fallback_sheets)
	_build_nodes()
	position = Hex.hex_to_pixel(hex.x, hex.y)
	play("idle")
	play_sound("ready")


func _collect_sheets(fallback: Dictionary) -> void:
	var sp = resources.get("sprites", {})
	if typeof(sp) == TYPE_DICTIONARY:
		for st in ["idle", "walk", "attack", "death", "fidget", "cast", "special"]:
			if sp.has(st) and typeof(sp[st]) == TYPE_DICTIONARY:
				var p := str(sp[st].get("path", ""))
				if Assets.exists(p):
					_sheets[st] = p
	for st in fallback.keys():
		if not _sheets.has(st) and Assets.exists(fallback[st]):
			_sheets[st] = fallback[st]
	if not _sheets.has("idle") and _sheets.has("walk"):
		_sheets["idle"] = _sheets["walk"]


## Team tint for the sprite's player-colour ramp. Players are blue, NPC/monsters red; the
## shipped WBC3 default (green) is kept for anything else.
func team_color() -> Color:
	match faction:
		"player":
			return Color(0.25, 0.45, 1.0)
		"npc", "enemy", "monster":
			return Color(0.95, 0.2, 0.15)
		_:
			return Color(0.1, 0.9, 0.2)


func _build_nodes() -> void:
	_shadow = Node2D.new()
	_shadow.name = "Shadow"
	_shadow.z_index = -1
	_shadow.draw.connect(_draw_shadow)
	add_child(_shadow)

	_sprites = AnimatedSprite2D.new()
	_sprites.name = "Sprite"
	_sprites.centered = true
	_sprites.animation_finished.connect(_on_anim_finished)
	# WBC3 player-colour ramp (pure green in the extracted sheets) -> faction tint via shader.
	var shader: Shader = load("res://shaders/team_recolor.gdshader")
	if shader != null:
		var mat := ShaderMaterial.new()
		mat.shader = shader
		mat.set_shader_parameter("team_color", team_color())
		_sprites.material = mat
	add_child(_sprites)
	# Target on-screen height ≈ 1.6 hex so big WBC3 sheets (giants, dragons) don't swamp the map.
	var g := SheetAnimator.grid_for(_sheets.get("idle", _sheets.get("walk", "")))
	if not g.is_empty():
		var ch := float(g.cell_h)
		var target := Hex.HEX_SIZE * 1.9
		_scale_fix = clampf(target / ch, 0.35, 1.6) if ch > target else 1.0
	_sprites.scale = Vector2.ONE * _scale_fix

	_label = Label.new()
	_label.name = "Name"
	_label.text = display_name
	_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_label.add_theme_font_size_override("font_size", 11)
	_label.add_theme_color_override("font_color", Color(0.95, 0.9, 0.8) if faction == "player" else Color(0.95, 0.6, 0.55))
	_label.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.9))
	_label.add_theme_constant_override("outline_size", 3)
	_label.size = Vector2(160, 16)
	_label.position = Vector2(-80, 6)
	add_child(_label)

	_pips = Node2D.new()
	_pips.name = "Pips"
	_pips.draw.connect(_draw_pips)
	add_child(_pips)

	_audio = AudioStreamPlayer2D.new()
	_audio.name = "Voice"
	_audio.max_distance = 2500
	add_child(_audio)
	_sfx = AudioStreamPlayer2D.new()
	_sfx.name = "Sfx"
	_sfx.max_distance = 2500
	add_child(_sfx)
	_layout_overlays()


func _layout_overlays() -> void:
	var h := _sprite_height()
	_label.position.y = 6
	_pips.position = Vector2(0, -h - 10)


func _sprite_height() -> float:
	if _sprites.sprite_frames == null:
		return 40.0
	var anim := _sprites.animation
	if _sprites.sprite_frames.get_frame_count(anim) == 0:
		return 40.0
	var tex := _sprites.sprite_frames.get_frame_texture(anim, 0)
	return tex.get_height() * _scale_fix if tex != null else 40.0


func _draw_shadow() -> void:
	var col := Color(0, 0, 0, 0.35)
	_shadow.draw_set_transform(Vector2.ZERO, 0.0, Vector2(1.0, Hex.H_SQUASH * 0.6))
	_shadow.draw_circle(Vector2.ZERO, Hex.HEX_SIZE * 0.42, col)
	var ring := Color(0.98, 0.65, 0.2, 0.55) if faction == "player" else Color(0.9, 0.3, 0.25, 0.55)
	_shadow.draw_arc(Vector2.ZERO, Hex.HEX_SIZE * 0.5, 0, TAU, 32, ring, 1.5, true)


func _draw_pips() -> void:
	var n := maxi(life_max, 1)
	var w := 7.0
	var gap := 2.0
	var total := n * w + (n - 1) * gap
	var x := -total / 2.0
	for i in range(n):
		var col := Color(0.35, 0.85, 0.4) if i < life else Color(0.2, 0.2, 0.22, 0.8)
		if faction != "player" and i < life:
			col = Color(0.9, 0.35, 0.3)
		_pips.draw_rect(Rect2(x, 0, w, 4), col)
		_pips.draw_rect(Rect2(x, 0, w, 4), Color(0, 0, 0, 0.7), false, 1.0)
		x += w + gap


# ------------------------------------------------------------------ animation

func play(new_state: String, dir := "") -> void:
	if not alive and new_state != "death":
		return
	if dir != "":
		facing = dir
	var st := new_state
	if not _sheets.has(st):
		st = "idle" if _sheets.has("idle") else (_sheets.keys()[0] if not _sheets.is_empty() else "")
	state = new_state
	if st == "":
		return
	var loop := new_state in ["idle", "walk"]
	var sf := SheetAnimator.frames_for(_sheets[st], st, 1 if loop else 0)
	if sf == null:
		return
	var anim := st + "_" + facing if SheetAnimator.has_directions(sf, st) else st
	if not sf.has_animation(anim):
		anim = sf.get_animation_names()[0]
	# Skip no-op reassignments: setting sprite_frames or calling play(anim) again on
	# the already-current (sheet,state,facing,anim) resets frame to 0 every call, which
	# on Android GL compat reads as rapid flicker. is_playing() was in this guard
	# earlier but can report false after a pause/resume cycle on mobile, so the
	# guard rebooted every tick -> the flicker returned. Compare the tuple only;
	# if a non-looping anim actually finished, _on_anim_finished has already set
	# state back to "idle" and the next explicit play("idle") takes a different key.
	var key: String = "%s|%s|%s|%s" % [_sheets[st], st, facing, anim]
	if key == _last_play_key and _sprites.sprite_frames == sf:
		return
	_last_play_key = key
	_sprites.sprite_frames = sf
	# WBC3 sheets anchor the unit's feet at the bottom-centre of each cell.
	var tex := sf.get_frame_texture(anim, 0)
	if tex != null:
		_sprites.offset = Vector2(0, -tex.get_height() / 2.0 + 4.0)
	_sprites.play(anim)
	_layout_overlays()
	print("[sprite] %s state=%s facing=%s anim=%s frames=%d" % [display_name, state, facing, anim, sf.get_frame_count(anim)])


func _on_anim_finished() -> void:
	var finished := state
	animation_done.emit(finished)
	if finished == "death":
		_sprites.pause()
		return
	if finished in ["attack", "cast", "fidget", "special"]:
		play("idle")


func _process(_dt: float) -> void:
	# Idle fidget: WBC3 units have a dedicated fidget sheet; trigger occasionally.
	if alive and state == "idle" and _sheets.has("fidget") and _rng.randf() < FIDGET_CHANCE * _dt:
		play("fidget")


# ------------------------------------------------------------------ movement

func face_toward(target_hex: Vector2i) -> void:
	var delta := Hex.hex_to_pixel(target_hex.x, target_hex.y) - Hex.hex_to_pixel(hex.x, hex.y)
	facing = Hex.direction_name(delta)


## Slide along `steps` (hex sequence, excluding current). Emits `arrived` at the end.
func move_along(steps: Array[Vector2i]) -> void:
	_path = steps.duplicate()
	if _path.is_empty():
		arrived.emit()
		return
	_next_step()


func _next_step() -> void:
	if _path.is_empty():
		play("idle")
		arrived.emit()
		return
	var nxt: Vector2i = _path.pop_front()
	face_toward(nxt)
	play("walk", facing)
	var dest := Hex.hex_to_pixel(nxt.x, nxt.y)
	hex = nxt
	if _tween != null and _tween.is_valid():
		_tween.kill()
	_tween = create_tween()
	_tween.tween_property(self, "position", dest, SLIDE_TIME).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	_tween.finished.connect(_next_step)


func teleport(h: Vector2i) -> void:
	hex = h
	position = Hex.hex_to_pixel(h.x, h.y)


# ------------------------------------------------------------------ combat

func attack(target: Entity) -> void:
	face_toward(target.hex)
	play("attack", facing)


func cast(target_hex: Vector2i) -> void:
	face_toward(target_hex)
	play("cast" if _sheets.has("cast") else "attack", facing)
	play_sound("spell")


func take_damage(n: int) -> void:
	if n <= 0 or not alive:
		return
	life = maxi(0, life - n)
	_pips.queue_redraw()
	_flash()
	if life == 0:
		alive = false
		play("death")
		play_sound("death")
		died.emit(self)


func _flash() -> void:
	var t := create_tween()
	_sprites.modulate = Color(1.6, 0.7, 0.7)
	t.tween_property(_sprites, "modulate", Color.WHITE, 0.35)


# ------------------------------------------------------------------ sound

func play_sound(group: String) -> void:
	var snd = resources.get("sounds", {})
	if typeof(snd) != TYPE_DICTIONARY:
		return
	var arr = snd.get(group, [])
	if typeof(arr) != TYPE_ARRAY or arr.is_empty():
		return
	var pick = arr[_rng.randi_range(0, arr.size() - 1)]
	var p := str(pick.get("path", "")) if typeof(pick) == TYPE_DICTIONARY else str(pick)
	var stream := Assets.load_wav(p)
	if stream == null:
		return
	var player := _sfx if group == "fx" else _audio
	player.stream = stream
	player.play()


func quote_for(group: String) -> String:
	var snd = resources.get("sounds", {})
	if typeof(snd) != TYPE_DICTIONARY:
		return ""
	var arr = snd.get(group, [])
	if typeof(arr) != TYPE_ARRAY or arr.is_empty():
		return ""
	var pick = arr[_rng.randi_range(0, arr.size() - 1)]
	return str(pick.get("quote", "")) if typeof(pick) == TYPE_DICTIONARY else ""


func portrait_path() -> String:
	var p = resources.get("portrait", {})
	if typeof(p) == TYPE_DICTIONARY:
		return str(p.get("path", ""))
	return ""


func info_sheet_path() -> String:
	var sp = resources.get("sprites", {})
	if typeof(sp) == TYPE_DICTIONARY and sp.has("info"):
		return str(sp.info.get("path", ""))
	return ""
