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

const SLOT_SIZE := Vector2(150, 96)   # was 92x76: wider for the rule line, +20px tall
const SLOT_GAP := 8

var dl: DataLoader = null             # set by Game so skill cards can show their rule text

var _portrait: TextureRect
var _name_lbl: Label
var _life_lbl: Label
var _phase_lbl: Label
var _timer_bar: ProgressBar
var _slots: Array[Button] = []
var _slot_code: Array[Label] = []
var _slot_name: Array[Label] = []
var _slot_desc: Array[Label] = []
var _lock_btn: Button
var _log: RichTextLabel
var _hint: Label
var _hover_lbl: Label
var _quote_lbl: Label

# object (feature / scatter / landmark) info card — top-left, under the portrait
var _obj_panel: PanelContainer
var _obj_thumb: TextureRect
var _obj_title: Label
var _obj_kind: Label
var _obj_coords: Label
var _obj_desc: Label
var _obj_hex: Variant = null


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

	# --- top-left, below the portrait: object info card (hidden until a click)
	_obj_panel = PanelContainer.new()
	_obj_panel.name = "ObjectCard"
	_obj_panel.position = Vector2(12, 136)
	_obj_panel.custom_minimum_size = Vector2(300, 0)
	_obj_panel.add_theme_stylebox_override("panel", _box(Color(0.06, 0.06, 0.08, 0.88)))
	_obj_panel.visible = false
	root.add_child(_obj_panel)
	var ohb := HBoxContainer.new()
	ohb.add_theme_constant_override("separation", 10)
	_obj_panel.add_child(ohb)
	_obj_thumb = TextureRect.new()
	_obj_thumb.custom_minimum_size = Vector2(88, 88)
	_obj_thumb.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	_obj_thumb.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_obj_thumb.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	ohb.add_child(_obj_thumb)
	var ovb := VBoxContainer.new()
	ovb.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	ovb.add_theme_constant_override("separation", 2)
	ohb.add_child(ovb)
	_obj_title = _label("", 15, Color(0.98, 0.9, 0.75))
	_obj_title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	ovb.add_child(_obj_title)
	_obj_kind = _label("", 11, Color(0.85, 0.65, 0.4))
	ovb.add_child(_obj_kind)
	_obj_coords = _label("", 11, Color(0.6, 0.6, 0.65))
	ovb.add_child(_obj_coords)
	_obj_desc = _label("", 11, Color(0.8, 0.78, 0.74))
	_obj_desc.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_obj_desc.custom_minimum_size = Vector2(186, 0)
	ovb.add_child(_obj_desc)
	var oclose := _label("Esc / click elsewhere to close", 9, Color(0.5, 0.5, 0.55))
	ovb.add_child(oclose)

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
	# Slots are 5 cards + LOCK; each card button carries a code / name / rule-text
	# label stack so the rule is always visible (full text in the tooltip).
	var bar := HBoxContainer.new()
	var bar_w := SLOT_SIZE.x * 5 + 92 + SLOT_GAP * 5
	bar.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	bar.position = Vector2(-bar_w * 0.5, -(SLOT_SIZE.y + 20))
	bar.add_theme_constant_override("separation", SLOT_GAP)
	root.add_child(bar)
	for i in range(5):
		var b := Button.new()
		b.custom_minimum_size = SLOT_SIZE
		b.text = ""
		b.clip_text = true
		b.pressed.connect(func(): slot_pressed.emit(i))
		bar.add_child(b)
		_slots.append(b)
		var stack := VBoxContainer.new()
		stack.set_anchors_preset(Control.PRESET_FULL_RECT)
		stack.offset_left = 6; stack.offset_right = -6; stack.offset_top = 2; stack.offset_bottom = -3
		stack.mouse_filter = Control.MOUSE_FILTER_IGNORE
		stack.add_theme_constant_override("separation", 0)
		b.add_child(stack)
		var lc := _label("-", 18, Color(1, 1, 1))
		lc.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		lc.mouse_filter = Control.MOUSE_FILTER_IGNORE
		stack.add_child(lc)
		_slot_code.append(lc)
		var ln := _label("", 11, Color(0.95, 0.95, 0.95))
		ln.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		ln.mouse_filter = Control.MOUSE_FILTER_IGNORE
		stack.add_child(ln)
		_slot_name.append(ln)
		var ld := _label("", 10, Color(0.88, 0.88, 0.92))
		ld.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		ld.vertical_alignment = VERTICAL_ALIGNMENT_TOP
		ld.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		ld.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
		ld.max_lines_visible = 3
		ld.add_theme_constant_override("line_spacing", 0)
		ld.size_flags_vertical = Control.SIZE_EXPAND_FILL
		ld.mouse_filter = Control.MOUSE_FILTER_IGNORE
		stack.add_child(ld)
		_slot_desc.append(ld)
	_lock_btn = Button.new()
	_lock_btn.custom_minimum_size = Vector2(92, SLOT_SIZE.y)
	_lock_btn.text = "LOCK\n[Space]"
	_lock_btn.pressed.connect(func(): lock_pressed.emit())
	bar.add_child(_lock_btn)

	_hint = _label("1-5 pick card · click hex = target/path · click building = info (Esc closes) · right-click = discard · Space = lock · wheel zoom · MMB pan · C recenter", 11, Color(0.6, 0.6, 0.65))
	_hint.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_hint.position = Vector2(-440, -16)
	_hint.custom_minimum_size = Vector2(880, 14)
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
			_slot_code[i].text = "-"
			_slot_name[i].text = ""
			_slot_desc[i].text = ""
			b.tooltip_text = ""
			b.disabled = true
			b.modulate = Color(1, 1, 1, 0.4)
			continue
		var code := str(hand[i])
		var t: String = str(targets.get(i, ""))
		var is_skill := code.begins_with("skill_")
		var full := RulesText.card_help(dl, code)
		var name: String = RulesText.skill_name(dl, code) if is_skill else str(CODE_NAMES.get(code, code))
		_slot_code[i].text = "SKILL" if is_skill else code
		_slot_code[i].add_theme_font_size_override("font_size", 13 if is_skill else 18)
		_slot_name[i].text = name + ((" → " + t) if t != "" else "")
		_slot_desc[i].text = RulesText.card_short(dl, code)
		b.tooltip_text = full
		b.disabled = locked
		var col: Color = CODE_COLORS.get(code, Color("#b58ad6") if is_skill else Color.WHITE)
		b.modulate = col.lightened(0.35) if i == chosen else col.darkened(0.15)
	_lock_btn.disabled = locked
	_lock_btn.text = "LOCKED" if locked else "LOCK\n[Space]"


## Show the object info card for a map feature / scatter / landmark on hex `h`.
## `obj` is the dict from MapGen.feature_at / Scatter.scatter_at / BigFeature.big_feature_at
## ({path, label, kind, biome, id[, desc]}). An empty dict hides the card.
func show_object_card(obj: Dictionary, h: Vector2i) -> void:
	if obj.is_empty():
		hide_object_card()
		return
	_obj_hex = h
	var label := str(obj.get("label", obj.get("id", "?")))
	var kind := str(obj.get("kind", "building")).replace("_", " ")
	var help_kind := RulesText.object_kind(obj)
	if help_kind != str(obj.get("kind", "building")):
		kind = "%s · %s" % [kind, help_kind]
	var biome := str(obj.get("biome", "")).replace("_", " ")
	_obj_title.text = label
	_obj_kind.text = kind + ((" · " + biome) if biome != "" else "")
	_obj_coords.text = "hex %s" % Hex.key_of(h)
	var desc := str(obj.get("desc", ""))
	if desc == "":
		desc = RulesText.object_desc(obj)
	_obj_desc.text = desc
	var tex: Texture2D = Assets.load_texture(str(obj.get("path", "")))
	_obj_thumb.texture = tex
	_obj_panel.visible = true
	# Autowrap labels report their final height only after a layout pass, so shrink
	# the panel now and again once the containers have sorted; otherwise it keeps
	# the tallest size it ever had.
	_obj_panel.reset_size()
	_fit_object_card()


func _fit_object_card() -> void:
	for i in range(2):
		await get_tree().process_frame
	if _obj_panel.visible:
		_obj_panel.reset_size()


func hide_object_card() -> void:
	_obj_hex = null
	_obj_panel.visible = false


func object_card_visible() -> bool:
	return _obj_panel.visible


## Hex the open object card refers to, or null.
func object_card_hex() -> Variant:
	return _obj_hex


func log_line(text: String, col := Color(0.85, 0.85, 0.85)) -> void:
	_log.append_text("[color=#%s]%s[/color]\n" % [col.to_html(false), text])
