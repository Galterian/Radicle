class_name Hud
extends CanvasLayer
## HUD: portrait + life, phase/timer, 5-slot hand bar (A/B/M/P/EP/EM), battle log, hints.
## Built in code so the scene file stays trivial.

signal slot_pressed(index: int)
signal lock_pressed

const CODE_COLORS := {
	"A": Color("#d9772a"), "B": Color("#4f8fd6"), "M": Color("#7cc77a"), "P": Color("#c9b35a"),
	"EP": Color("#8a8fa3"), "EM": Color("#6f7a94"),
}
const CODE_NAMES := {"A": "Attack", "B": "Block", "M": "Move", "P": "Posture", "EP": "Empty (hold)", "EM": "Empty (run)"}

var _portrait: TextureRect
var _name_lbl: Label
var _life_lbl: Label
var _phase_lbl: Label
var _timer_bar: ProgressBar
var _slots: Array[Button] = []
var _lock_btn: Button
var _log: RichTextLabel
var _hint: Label
var _hover_lbl: Label
var _quote_lbl: Label


func _ready() -> void:
	layer = 10
	var root := Control.new()
	root.name = "Root"
	root.set_anchors_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(root)

	# --- top-left: portrait panel
	var panel := PanelContainer.new()
	panel.position = Vector2(12, 12)
	panel.custom_minimum_size = Vector2(300, 112)
	panel.add_theme_stylebox_override("panel", _box(Color(0.06, 0.06, 0.08, 0.85)))
	root.add_child(panel)
	var hb := HBoxContainer.new()
	hb.add_theme_constant_override("separation", 10)
	panel.add_child(hb)
	_portrait = TextureRect.new()
	_portrait.custom_minimum_size = Vector2(88, 96)
	_portrait.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_portrait.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	hb.add_child(_portrait)
	var vb := VBoxContainer.new()
	hb.add_child(vb)
	_name_lbl = _label("—", 16, Color(0.98, 0.9, 0.75))
	vb.add_child(_name_lbl)
	_life_lbl = _label("", 13, Color(0.6, 0.9, 0.6))
	vb.add_child(_life_lbl)
	_quote_lbl = _label("", 11, Color(0.75, 0.72, 0.68))
	_quote_lbl.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_quote_lbl.custom_minimum_size = Vector2(190, 0)
	vb.add_child(_quote_lbl)

	# --- top-centre: phase + timer
	var pc := VBoxContainer.new()
	pc.set_anchors_preset(Control.PRESET_CENTER_TOP)
	pc.position = Vector2(-160, 12)
	pc.custom_minimum_size = Vector2(320, 0)
	root.add_child(pc)
	_phase_lbl = _label("planning", 18, Color(0.95, 0.85, 0.6))
	_phase_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	pc.add_child(_phase_lbl)
	_timer_bar = ProgressBar.new()
	_timer_bar.custom_minimum_size = Vector2(320, 8)
	_timer_bar.show_percentage = false
	_timer_bar.max_value = 1.0
	_timer_bar.value = 1.0
	_timer_bar.add_theme_stylebox_override("fill", _box(Color("#d9772a")))
	_timer_bar.add_theme_stylebox_override("background", _box(Color(0.1, 0.1, 0.12, 0.8)))
	pc.add_child(_timer_bar)
	_hover_lbl = _label("", 12, Color(0.7, 0.7, 0.75))
	_hover_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	pc.add_child(_hover_lbl)

	# --- bottom-centre: hand bar
	var bar := HBoxContainer.new()
	bar.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	bar.position = Vector2(-290, -96)
	bar.add_theme_constant_override("separation", 8)
	root.add_child(bar)
	for i in range(5):
		var b := Button.new()
		b.custom_minimum_size = Vector2(92, 76)
		b.text = "-"
		b.add_theme_font_size_override("font_size", 20)
		b.pressed.connect(func(): slot_pressed.emit(i))
		bar.add_child(b)
		_slots.append(b)
	_lock_btn = Button.new()
	_lock_btn.custom_minimum_size = Vector2(92, 76)
	_lock_btn.text = "LOCK\n[Space]"
	_lock_btn.pressed.connect(func(): lock_pressed.emit())
	bar.add_child(_lock_btn)

	_hint = _label("1-5 pick card · click hex = target/path · right-click = discard · Space = lock · wheel zoom · MMB pan · C recenter", 11, Color(0.6, 0.6, 0.65))
	_hint.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_hint.position = Vector2(-360, -16)
	_hint.custom_minimum_size = Vector2(720, 14)
	_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	root.add_child(_hint)

	# --- right: log
	var lp := PanelContainer.new()
	lp.set_anchors_preset(Control.PRESET_TOP_RIGHT)
	lp.position = Vector2(-372, 12)
	lp.custom_minimum_size = Vector2(360, 300)
	lp.add_theme_stylebox_override("panel", _box(Color(0.06, 0.06, 0.08, 0.75)))
	root.add_child(lp)
	_log = RichTextLabel.new()
	_log.bbcode_enabled = true
	_log.scroll_following = true
	_log.custom_minimum_size = Vector2(344, 284)
	_log.add_theme_font_size_override("normal_font_size", 12)
	lp.add_child(_log)


static func _label(text: String, size: int, col: Color) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", col)
	return l


static func _box(col: Color) -> StyleBoxFlat:
	var sb := StyleBoxFlat.new()
	sb.bg_color = col
	sb.set_corner_radius_all(6)
	sb.set_content_margin_all(8)
	sb.border_color = Color(0.85, 0.55, 0.25, 0.5)
	sb.set_border_width_all(1)
	return sb


# ------------------------------------------------------------------ API

func set_entity(e: Entity) -> void:
	if e == null:
		_name_lbl.text = "—"
		_life_lbl.text = ""
		_portrait.texture = null
		return
	_name_lbl.text = e.display_name
	update_life(e)
	var p := e.portrait_path()
	var tex: Texture2D = Assets.load_texture(p) if p != "" else null
	if tex == null:
		# Fall back to the top (portrait) part of the WBC3 info sheet.
		var info := e.info_sheet_path()
		var it := Assets.load_texture(info)
		if it != null:
			var at := AtlasTexture.new()
			at.atlas = it
			at.region = Rect2(0, 0, it.get_width(), minf(it.get_height(), it.get_width() * 1.1))
			tex = at
	_portrait.texture = tex
	set_quote(e.quote_for("select"))


func update_life(e: Entity) -> void:
	if e == null:
		return
	var s := ""
	for i in range(e.life_max):
		s += "●" if i < e.life else "○"
	_life_lbl.text = "%s  %d/%d" % [s, e.life, e.life_max]


func set_quote(text: String) -> void:
	_quote_lbl.text = ("“%s”" % text) if text != "" else ""


func set_phase(text: String, frac: float) -> void:
	_phase_lbl.text = text
	_timer_bar.value = clampf(frac, 0.0, 1.0)


func set_hover(text: String) -> void:
	_hover_lbl.text = text


func set_hand(hand: Array, chosen: int, locked: bool, targets: Dictionary) -> void:
	for i in range(_slots.size()):
		var b := _slots[i]
		if i >= hand.size():
			b.text = "-"
			b.disabled = true
			b.modulate = Color(1, 1, 1, 0.4)
			continue
		var code := str(hand[i])
		var t: String = str(targets.get(i, ""))
		b.text = "%s\n%s%s" % [code, CODE_NAMES.get(code, code), ("\n→ " + t) if t != "" else ""]
		b.disabled = locked
		var col: Color = CODE_COLORS.get(code, Color.WHITE)
		b.modulate = col.lightened(0.35) if i == chosen else col.darkened(0.15)
		b.add_theme_font_size_override("font_size", 14)
	_lock_btn.disabled = locked
	_lock_btn.text = "LOCKED" if locked else "LOCK\n[Space]"


func log_line(text: String, col := Color(0.85, 0.85, 0.85)) -> void:
	_log.append_text("[color=#%s]%s[/color]\n" % [col.to_html(false), text])
