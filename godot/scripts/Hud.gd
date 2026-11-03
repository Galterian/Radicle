class_name Hud
extends CanvasLayer
## HUD: portrait + life, phase/timer, 5-slot hand bar (A/B/M/P/EP/EM), battle log, hints.
## Built in code so the scene file stays trivial.

signal slot_pressed(index: int)
signal lock_pressed
## Fired when the player double-taps an enemy's permanent card in the roster.
## Carries the stat the destroy intent should emit at the perm (Rule 24).
signal destroy_perm_requested(peer_id: String, perm_id: String, stat: String)

const CODE_COLORS := {
	"A": Color("#d9772a"), "B": Color("#4f8fd6"), "M": Color("#7cc77a"), "P": Color("#c9b35a"),
	"EP": Color("#8a8fa3"), "EM": Color("#6f7a94"),
}
const CODE_NAMES := {"A": "Attack", "B": "Block", "M": "Move", "P": "Posture", "EP": "Empty (hold)", "EM": "Empty (run)"}

const SLOT_SIZE_DESKTOP := Vector2(150, 96)
const SLOT_SIZE_MOBILE  := Vector2(96, 76)
const SLOT_GAP := 8
# Runtime: mutated by _apply_layout() based on viewport width.
var SLOT_SIZE: Vector2 = SLOT_SIZE_DESKTOP

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
var _slot_icon: Array[TextureRect] = []    # real skill-card icon when the slot holds a skill_* id
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

# Rich unit hover card — mirror of game/js/main.js renderHoverCard: thumb, name,
# sub (wbc3 name/race), hp, stats V/W/M/Wi, tier, held skills (icon + 1-line
# desc), permanents (icon + full desc). Lives top-right under the log.
var _hover_panel: PanelContainer
var _hover_thumb: TextureRect
var _hover_name: Label
var _hover_sub: Label
var _hover_hp: Label
var _hover_stats: Label
var _hover_tier: Label
var _hover_skills_title: Label
var _hover_skills_box: VBoxContainer
var _hover_perms_title: Label
var _hover_perms_box: VBoxContainer
var _hover_unit_id: String = ""

# Roster panel — vertical stack of every entity, each row = thumb + name + stats
# + a mini-card per permanent (icon + name + full description).  Parity with
# game/js/main.js renderRoster.
var _roster_panel: PanelContainer
var _roster_box: VBoxContainer
var _roster_toggle: Button    # mobile only — floating button to show/hide the roster
var _roster_signature := ""     # cheap "is anything different?" guard

# Server-view overlay — populated by NetBridge signals when the Node peer is
# reachable. The local sim keeps drawing its own entity list; these dicts add
# server-only facts (perm power dice, class state, hand) that the local sim
# doesn't track. Both merge inside _make_roster_row.
var _server_hand: Dictionary = {}            # last `hand` message payload
var _server_peers: Array = []                # last `peers` message payload (array of per-peer dicts)
var _server_perm_power: Dictionary = {}      # peer_id -> {perm_id: die}
var _my_peer_id: String = ""

# Top-level panels — tracked so _apply_layout() can reposition them when the
# viewport aspect flips (desktop resize or phone orientation change).
var _panel_portrait: PanelContainer      # top-left: portrait + hp + quote
var _panel_phase: VBoxContainer          # top-centre: phase + timer + hover line
var _bar: HBoxContainer                  # bottom-centre: 5 slots + lock
var _log_panel: PanelContainer           # right column: log
# Element-emission chip. Fades out ~1.4s after the player's intent emits a
# non-empty element set — parity with the browser's hero-emit line.
var _emit_lbl: Label = null
var _emit_tween: Tween = null
# Destroy-queued chip. Visible while queuedDestroy is non-null in the local
# peer's handMsg — the user double-tapped an enemy perm and the server is
# holding the intent until a P / EP / A / M emission resolves at that perm.
var _destroy_chip: Label = null
# Overlay (world-space) for enemy-reveal emit chips. We draw these as a
# RichTextLabel per entity position so the player can see "emitting A P"
# floating over the actor during resolution.
var _world_emits: Dictionary = {}        # peer_id -> Label

var _last_viewport_size := Vector2i.ZERO
var _is_portrait := false


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
	_panel_portrait = panel
	# Element-emit chip. Floats under the portrait's name label; _apply_layout
	# repositions as the portrait moves. Hidden until show_emit() fires.
	_emit_lbl = _label("", 11, Color(0.95, 0.75, 0.4))
	_emit_lbl.visible = false
	_emit_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	# Destroy-queued chip sits under the emit chip. Hidden by default; the
	# `hand` message's `destroy` field drives it (see set_server_hand).
	_destroy_chip = _label("", 11, Color(0.95, 0.55, 0.55))
	_destroy_chip.visible = false
	_destroy_chip.mouse_filter = Control.MOUSE_FILTER_IGNORE
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
	# emit chip sits last so it appears under hp/quote
	vb.add_child(_emit_lbl)
	vb.add_child(_destroy_chip)

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
	_panel_phase = pc
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
	_bar = bar
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
		# Real skill-card icon (from data/skills.json resources.sprites.icon). Hidden
		# unless the slot carries a skill_* id and the texture loaded.
		var si := TextureRect.new()
		si.custom_minimum_size = Vector2(SLOT_SIZE.x - 20, 24)
		si.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		si.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		si.mouse_filter = Control.MOUSE_FILTER_IGNORE
		si.visible = false
		stack.add_child(si)
		_slot_icon.append(si)
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
	_log_panel = lp
	_log = RichTextLabel.new()
	_log.bbcode_enabled = true
	_log.scroll_following = true
	_log.custom_minimum_size = Vector2(344, 284)
	_log.add_theme_font_size_override("normal_font_size", 12)
	lp.add_child(_log)

	# --- right, below log: rich unit hover card (hidden until a hover lands on a unit)
	_hover_panel = PanelContainer.new()
	_hover_panel.name = "HoverCard"
	_hover_panel.set_anchors_preset(Control.PRESET_TOP_RIGHT)
	_hover_panel.position = Vector2(-372, 320)
	_hover_panel.custom_minimum_size = Vector2(360, 0)
	_hover_panel.add_theme_stylebox_override("panel", _box(Color(0.06, 0.06, 0.08, 0.88)))
	_hover_panel.visible = false
	root.add_child(_hover_panel)
	var hvb := VBoxContainer.new()
	hvb.add_theme_constant_override("separation", 4)
	_hover_panel.add_child(hvb)
	var hhb := HBoxContainer.new()
	hhb.add_theme_constant_override("separation", 10)
	hvb.add_child(hhb)
	_hover_thumb = TextureRect.new()
	_hover_thumb.custom_minimum_size = Vector2(78, 88)
	_hover_thumb.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	_hover_thumb.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_hover_thumb.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	hhb.add_child(_hover_thumb)
	var hvcol := VBoxContainer.new()
	hvcol.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	hvcol.add_theme_constant_override("separation", 2)
	hhb.add_child(hvcol)
	_hover_name = _label("", 15, Color(0.98, 0.9, 0.75))
	hvcol.add_child(_hover_name)
	_hover_sub = _label("", 11, Color(0.78, 0.72, 0.6))
	_hover_sub.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_hover_sub.custom_minimum_size = Vector2(252, 0)
	hvcol.add_child(_hover_sub)
	_hover_hp = _label("", 12, Color(0.65, 0.9, 0.65))
	hvcol.add_child(_hover_hp)
	_hover_stats = _label("", 11, Color(0.78, 0.78, 0.9))
	hvcol.add_child(_hover_stats)
	_hover_tier = _label("", 10, Color(0.7, 0.6, 0.5))
	hvcol.add_child(_hover_tier)
	_hover_skills_title = _label("Skills", 11, Color(0.65, 0.65, 0.72))
	hvb.add_child(_hover_skills_title)
	_hover_skills_box = VBoxContainer.new()
	_hover_skills_box.add_theme_constant_override("separation", 2)
	hvb.add_child(_hover_skills_box)
	_hover_perms_title = _label("Permanents", 11, Color(0.65, 0.65, 0.72))
	hvb.add_child(_hover_perms_title)
	_hover_perms_box = VBoxContainer.new()
	_hover_perms_box.add_theme_constant_override("separation", 4)
	hvb.add_child(_hover_perms_box)

	# --- bottom-right: roster (every entity, stats, permanents as mini cards)
	_roster_panel = PanelContainer.new()
	_roster_panel.name = "Roster"
	_roster_panel.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
	_roster_panel.position = Vector2(-372, -(SLOT_SIZE.y + 20) - 268)
	_roster_panel.custom_minimum_size = Vector2(360, 0)
	_roster_panel.add_theme_stylebox_override("panel", _box(Color(0.06, 0.06, 0.08, 0.82)))
	root.add_child(_roster_panel)
	_roster_box = VBoxContainer.new()
	_roster_box.add_theme_constant_override("separation", 6)
	_roster_panel.add_child(_roster_box)

	# Mobile roster toggle — a small circular button bottom-right of the slot
	# bar that flips the roster panel visibility. Hidden on desktop (that
	# layout has room for the roster at all times).
	_roster_toggle = Button.new()
	_roster_toggle.name = "RosterToggle"
	_roster_toggle.text = "☰"
	_roster_toggle.custom_minimum_size = Vector2(44, 44)
	_roster_toggle.add_theme_font_size_override("font_size", 20)
	_roster_toggle.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
	_roster_toggle.add_theme_stylebox_override("normal",  _box(Color(0.08, 0.08, 0.1, 0.9)))
	_roster_toggle.add_theme_stylebox_override("hover",   _box(Color(0.14, 0.14, 0.18, 0.95)))
	_roster_toggle.add_theme_stylebox_override("pressed", _box(Color(0.22, 0.22, 0.26, 0.95)))
	_roster_toggle.visible = false
	_roster_toggle.pressed.connect(_toggle_roster)
	root.add_child(_roster_toggle)

	# Reflow when the window resizes OR the device rotates. Called once here
	# to apply the initial layout for whatever orientation we start in.
	get_viewport().size_changed.connect(_on_viewport_resized)
	_apply_layout()


func _toggle_roster() -> void:
	if _roster_panel == null:
		return
	_roster_panel.visible = not _roster_panel.visible


func _on_viewport_resized() -> void:
	var sz := get_viewport().get_visible_rect().size
	if Vector2i(sz) == _last_viewport_size:
		return
	_last_viewport_size = Vector2i(sz)
	_apply_layout()


func _apply_layout() -> void:
	# Three layouts, picked from viewport size:
	#   desktop    (wide, roomy): dense stacks, 150-px slots, full right column.
	#   landscape-phone (wide but short): smaller slots fit the width, log/roster
	#                                     collapsed behind a toggle to leave the
	#                                     hex grid breathing room.
	#   portrait   (phone upright): compact half-width panels; slots scale down
	#                               so the whole hand + LOCK fits one row.
	var vp := get_viewport().get_visible_rect().size
	var portrait := vp.y > vp.x
	var mobile := OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios") or vp.x < 1100
	_is_portrait = portrait

	# Pick a slot size that lets 5 slots + LOCK button fit in the available
	# width with gaps. The LOCK button is ~ one slot wide; keep ~24px side
	# padding so slots don't hug the screen edges.
	var avail := maxf(vp.x - 24, 320.0)
	var ideal_slot_w := (avail - (SLOT_GAP * 6)) / 6.0   # 5 slots + 1 lock
	if not mobile and not portrait:
		SLOT_SIZE = SLOT_SIZE_DESKTOP
	else:
		var w := clampf(ideal_slot_w, 68.0, SLOT_SIZE_DESKTOP.x)
		var h := clampf(w * 0.64, 60.0, SLOT_SIZE_DESKTOP.y)
		SLOT_SIZE = Vector2(w, h)

	# Dump once per layout change so you can grep adb logcat for the viewport
	# Godot actually sees on-device vs what we design for (1440x900).
	print("[Hud] viewport=", vp, " portrait=", portrait, " mobile=", mobile,
		  " slot=", SLOT_SIZE)

	if _panel_portrait != null:
		_panel_portrait.position = Vector2(8, 8)
		if portrait or mobile:
			_panel_portrait.custom_minimum_size = Vector2(minf(vp.x * 0.44, 240), 100)
		else:
			_panel_portrait.custom_minimum_size = Vector2(300, 112)
	if _panel_phase != null:
		if portrait or mobile:
			_panel_phase.set_anchors_preset(Control.PRESET_TOP_RIGHT)
			_panel_phase.position = Vector2(-minf(vp.x * 0.44 + 4, 200), 8)
			_panel_phase.custom_minimum_size = Vector2(minf(vp.x * 0.44, 192), 0)
		else:
			_panel_phase.set_anchors_preset(Control.PRESET_CENTER_TOP)
			_panel_phase.position = Vector2(-160, 12)
			_panel_phase.custom_minimum_size = Vector2(320, 0)
	if _log_panel != null:
		if portrait:
			_log_panel.set_anchors_preset(Control.PRESET_TOP_RIGHT)
			_log_panel.position = Vector2(-(vp.x * 0.5 + 4), 120)
			_log_panel.custom_minimum_size = Vector2(vp.x * 0.5 - 12, minf(vp.y * 0.28, 180))
		elif mobile:
			# Landscape phone: a narrower log so there's room for the hex board.
			_log_panel.set_anchors_preset(Control.PRESET_TOP_RIGHT)
			_log_panel.position = Vector2(-minf(vp.x * 0.33, 320) - 4, 8)
			_log_panel.custom_minimum_size = Vector2(minf(vp.x * 0.33, 320), minf(vp.y * 0.4, 220))
		else:
			_log_panel.set_anchors_preset(Control.PRESET_TOP_RIGHT)
			_log_panel.position = Vector2(-372, 12)
			_log_panel.custom_minimum_size = Vector2(360, 300)
	if _hover_panel != null:
		if portrait:
			_hover_panel.position = Vector2(-(vp.x * 0.5 + 4), 316)
			_hover_panel.custom_minimum_size = Vector2(vp.x * 0.5 - 12, 0)
		elif mobile:
			# Below the log panel.
			_hover_panel.set_anchors_preset(Control.PRESET_TOP_RIGHT)
			_hover_panel.position = Vector2(-minf(vp.x * 0.33, 320) - 4, minf(vp.y * 0.4, 220) + 16)
			_hover_panel.custom_minimum_size = Vector2(minf(vp.x * 0.33, 320), 0)
		else:
			_hover_panel.set_anchors_preset(Control.PRESET_TOP_RIGHT)
			_hover_panel.position = Vector2(-372, 320)
			_hover_panel.custom_minimum_size = Vector2(360, 0)
	if _obj_panel != null:
		if portrait or mobile:
			_obj_panel.position = Vector2(8, _panel_portrait.custom_minimum_size.y + 16)
			_obj_panel.custom_minimum_size = Vector2(minf(vp.x * 0.44, 240), 0)
		else:
			_obj_panel.position = Vector2(12, 136)
			_obj_panel.custom_minimum_size = Vector2(300, 0)
	if _roster_panel != null:
		if portrait:
			_roster_panel.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
			_roster_panel.position = Vector2(-(vp.x * 0.5 + 4), -(SLOT_SIZE.y + 20) - 160)
			_roster_panel.custom_minimum_size = Vector2(vp.x * 0.5 - 12, 0)
		elif mobile:
			# Hidden by default; the floating ☰ toggle below reveals it. The
			# roster is still full-width when shown so the player can read
			# names/HP/perms without squinting.
			_roster_panel.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
			_roster_panel.position = Vector2(-minf(vp.x * 0.5, 340), -(SLOT_SIZE.y + 20) - 240)
			_roster_panel.custom_minimum_size = Vector2(minf(vp.x * 0.5 - 12, 340), 0)
			if _roster_panel.visible == true and _last_viewport_size == Vector2i.ZERO:
				_roster_panel.visible = false
		else:
			_roster_panel.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
			_roster_panel.position = Vector2(-372, -(SLOT_SIZE.y + 20) - 268)
			_roster_panel.custom_minimum_size = Vector2(360, 0)
	# Re-apply slot sizes to the (already-built) buttons so the shrink/grow
	# propagates. SLOT_SIZE changed above; the Button nodes keep whichever
	# min size they were given on build.
	for b in _slots:
		b.custom_minimum_size = SLOT_SIZE
	if _lock_btn != null:
		_lock_btn.custom_minimum_size = Vector2(SLOT_SIZE.x * 0.65, SLOT_SIZE.y)
	# Keep slot text proportions readable on the small size.
	var small := SLOT_SIZE.x < 110
	for lc in _slot_code:
		lc.add_theme_font_size_override("font_size", 14 if small else 18)
	for ln in _slot_name:
		ln.add_theme_font_size_override("font_size", 9 if small else 11)
	for ld in _slot_desc:
		ld.add_theme_font_size_override("font_size", 8 if small else 10)
	if _bar != null:
		var bar_w := SLOT_SIZE.x * 5 + (SLOT_SIZE.x * 0.65) + SLOT_GAP * 5
		_bar.position = Vector2(-bar_w * 0.5, -(SLOT_SIZE.y + 20))
	if _hint != null:
		_hint.visible = not portrait and not mobile
		if _hint.visible:
			_hint.text = "1-5 pick card · click hex = target/path · click building = info (Esc closes) · right-click = discard · Space = lock · wheel zoom · MMB pan · C recenter"
		else:
			_hint.text = ""
	# Position the roster toggle just above the right end of the slot bar,
	# visible only on mobile.
	if _roster_toggle != null:
		_roster_toggle.visible = portrait or mobile
		_roster_toggle.position = Vector2(-56, -(SLOT_SIZE.y + 20) - 56)


func attach_mobile_input(mi: MobileInput) -> void:
	# No direct HUD gestures today — the slots are regular Buttons so the
	# emulated-mouse layer already drives them from taps. We keep this hook
	# so later touch-only UI (long-press, swipe-dismiss, etc) can plug in
	# without a Game.gd change.
	if mi == null:
		return


# ------------------------------------------------------------------ element emission

## Show the player's own emitted elements (string like "A P"). Mirrors the
## browser's `renderHeroCard` emit line in game/js/main.js. Pass "" to hide.
func show_emit(text: String) -> void:
	if _emit_lbl == null:
		return
	if text == null or text == "":
		_emit_lbl.visible = false
		_emit_lbl.text = ""
		return
	_emit_lbl.text = "emitting %s" % text
	_emit_lbl.visible = true
	_emit_lbl.modulate = Color(1, 1, 1, 1)
	if _emit_tween != null and _emit_tween.is_running():
		_emit_tween.kill()
	# Stays solid for 900ms, then fades out over 500ms — same cadence as the
	# browser overlay so a reveal animation reads the same on both runtimes.
	_emit_tween = create_tween()
	_emit_tween.tween_interval(0.9)
	_emit_tween.tween_property(_emit_lbl, "modulate:a", 0.0, 0.5)
	_emit_tween.tween_callback(_hide_emit_lbl)


func _hide_emit_lbl() -> void:
	if _emit_lbl != null:
		_emit_lbl.visible = false


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
			_slot_icon[i].texture = null
			_slot_icon[i].visible = false
			_slot_code[i].visible = true
			b.tooltip_text = ""
			b.disabled = true
			b.modulate = Color(1, 1, 1, 0.4)
			continue
		var code := str(hand[i])
		var t: String = str(targets.get(i, ""))
		var is_skill := code.begins_with("skill_")
		var full := RulesText.card_help(dl, code)
		var name: String = RulesText.skill_name(dl, code) if is_skill else str(CODE_NAMES.get(code, code))
		# Real sprite icon for skill cards (data/skills.json resources.sprites.icon,
		# frame 0 of the sheet-sliced sprite). When sibling #1 has not populated the
		# `icon` field yet we fall back to the effect-strip's frame 0 — and when
		# even that is missing, show the words-form string in the code label.
		var icon_tex: Texture2D = RulesText.skill_icon_texture(dl, code) if is_skill else null
		if is_skill and icon_tex != null:
			_slot_icon[i].texture = icon_tex
			_slot_icon[i].visible = true
			_slot_code[i].visible = false
		else:
			_slot_icon[i].texture = null
			_slot_icon[i].visible = false
			_slot_code[i].visible = true
			# No emoji glyph in the bundled font — "SKILL" reads cleanly for skill
			# slots; action codes already show as A/B/M/P/EM/EP.
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


# ------------------------------------------------------------------ unit hover card

## Rich hover card for the unit on the hovered hex — parity with
## game/js/main.js renderHoverCard: thumb + name + sub (wbc3 name/race) + hp +
## stats V/W/M/Wi + tier + held skills (icon + 1-line desc) + permanents
## (icon + full description). Pass null to hide.
func show_unit_hover(e: Entity) -> void:
	if e == null:
		hide_unit_hover()
		return
	_hover_unit_id = e.id
	_hover_name.text = e.display_name
	var sub_bits: Array[String] = []
	var wbc_name := str(e.resources.get("wbc3_name", ""))
	var wbc_race := str(e.resources.get("wbc3_race", ""))
	if wbc_name != "":
		sub_bits.append(wbc_name)
	if wbc_race != "":
		sub_bits.append("(%s)" % wbc_race)
	_hover_sub.text = " ".join(sub_bits) if not sub_bits.is_empty() else e.kind
	_hover_hp.text = "hp %d/%d · %s%s" % [e.life, e.life_max, e.faction, " · dead" if not e.alive else ""]
	_hover_hp.add_theme_color_override("font_color", Color(0.9, 0.4, 0.4) if not e.alive else Color(0.65, 0.9, 0.65))
	# V/W/M/Wi stat strip. The browser renders four little pills; the Godot
	# default font has no coloured icons so the labels do the talking.
	var stats: Dictionary = e.data.get("stats", {})
	if typeof(stats) != TYPE_DICTIONARY:
		stats = {}
	_hover_stats.text = "V %s · W %s · M %s · Wi %s" % [
		str(stats.get("vitality", "—")),
		str(stats.get("world", "—")),
		str(stats.get("matter", "—")),
		str(stats.get("will", "—")),
	]
	# Tier — characters use `adept_element`, creatures use `innate_effect` as
	# their signature line. Either (or neither) may be set per entry.
	var tier_bits: Array[String] = []
	var adept := str(e.data.get("adept_element", ""))
	var innate := str(e.data.get("innate_effect", ""))
	if adept != "":
		tier_bits.append("adept: %s" % adept.replace("elem_", ""))
	if innate != "":
		tier_bits.append("innate: %s" % innate.replace("effect_", "").replace("_", " "))
	var combo = e.data.get("combo", [])
	if typeof(combo) == TYPE_ARRAY and not combo.is_empty():
		tier_bits.append("combo " + " > ".join(combo))
	_hover_tier.text = " · ".join(tier_bits)
	_hover_tier.visible = not tier_bits.is_empty()
	# Portrait: same source as the top-left set_entity() uses.
	var p := e.portrait_path()
	var tex: Texture2D = Assets.load_texture(p) if p != "" else null
	if tex == null:
		var info := e.info_sheet_path()
		var it := Assets.load_texture(info)
		if it != null:
			var at := AtlasTexture.new()
			at.atlas = it
			at.region = Rect2(0, 0, it.get_width(), minf(it.get_height(), it.get_width() * 1.1))
			tex = at
	_hover_thumb.texture = tex
	# Held skills (1-line description each).
	_fill_skill_list(_hover_skills_box, e.data.get("skills", []), false)
	_hover_skills_title.visible = _hover_skills_box.get_child_count() > 0
	_hover_skills_box.visible = _hover_skills_box.get_child_count() > 0
	# Permanents (full description each). The hover card is read-only so we
	# surface the badge but keep clicks disabled — the roster row is the
	# gesture target for destroy intents.
	_fill_skill_list(_hover_perms_box, e.data.get("permanents", []), true, _peer_id_for_entity(e), false)
	_hover_perms_title.visible = _hover_perms_box.get_child_count() > 0
	_hover_perms_box.visible = _hover_perms_box.get_child_count() > 0
	_hover_panel.visible = true
	_hover_panel.reset_size()
	_fit_hover_card()


func _fit_hover_card() -> void:
	for i in range(2):
		await get_tree().process_frame
	if _hover_panel.visible:
		_hover_panel.reset_size()


func hide_unit_hover() -> void:
	_hover_unit_id = ""
	_hover_panel.visible = false


func hover_unit_visible() -> bool:
	return _hover_panel.visible


## Entity id currently shown in the hover card, or "". Used by hud_check.gd.
func hover_unit_id() -> String:
	return _hover_unit_id


## Number of permanent mini-cards currently rendered in the hover panel. Used by
## hud_check.gd for permanent-list parity (matches the browser's renderHoverCard
## permanent count for the same entity).
func hover_perm_count() -> int:
	return _hover_perms_box.get_child_count() if _hover_perms_box != null else 0


# ------------------------------------------------------------------ roster

## Rebuild the right-column roster to match `entities`. Parity with
## game/js/main.js renderRoster: thumb + name + stats pills + a vertical stack
## of mini permanent cards (icon + name + full description).
## Called from Game.gd when NetBridge gets a `hand` message. Right now we
## only cache it so queued state and casting progress can land in the HUD
## later; the server's `peers` message carries the perm_power the destroy UI
## needs below.
func set_server_hand(payload: Dictionary) -> void:
	_server_hand = payload
	if payload.has("peer_id"):
		_my_peer_id = String(payload.get("peer_id", ""))
	# A roster rebuild re-reads _server_perm_power on the next peers message;
	# force a sig flush so the badge appears as soon as we have the data.
	_roster_signature = ""
	# Destroy-queued chip. The server's handMsg sets `destroy = { stat }` while
	# queuedDestroy is live; a null means it has cleared (resolved or cancelled).
	if _destroy_chip != null:
		var d: Variant = payload.get("destroy", null)
		if typeof(d) == TYPE_DICTIONARY and String((d as Dictionary).get("stat", "")) != "":
			_destroy_chip.text = "destroy queued: %s" % String((d as Dictionary).get("stat", ""))
			_destroy_chip.visible = true
		else:
			_destroy_chip.visible = false
			_destroy_chip.text = ""


## Return the stat string of a currently-queued destroy intent, or "" when none
## is active. Game.gd uses this to toggle the intent off (sending the same stat
## again clears it, server-side at peer.mjs L4489).
func destroy_queued_stat() -> String:
	var d: Variant = _server_hand.get("destroy", null)
	if typeof(d) != TYPE_DICTIONARY:
		return ""
	return String((d as Dictionary).get("stat", ""))

## Called from Game.gd when NetBridge gets a `peers` message. Normalises the
## perm_power dict per peer so the roster rows can show the power badge
## (Rule 12/24) and route destroy intents at it.
func set_server_peers(peers: Array) -> void:
	_server_peers = peers
	_server_perm_power.clear()
	for raw in peers:
		if typeof(raw) != TYPE_DICTIONARY:
			continue
		var p: Dictionary = raw
		var pid := String(p.get("peer_id", ""))
		if pid == "":
			continue
		var pp_raw: Variant = p.get("perm_power_json", "{}")
		var pp: Dictionary = {}
		if typeof(pp_raw) == TYPE_STRING:
			var parsed: Variant = JSON.parse_string(String(pp_raw))
			if typeof(parsed) == TYPE_DICTIONARY:
				pp = parsed
		elif typeof(pp_raw) == TYPE_DICTIONARY:
			pp = pp_raw
		_server_perm_power[pid] = pp
	# Signature already includes perm-id lists; wipe it so the perm-cards
	# re-render with the fresh dice numbers.
	_roster_signature = ""

func set_roster(entities: Array) -> void:
	# Cheap diff: if the (id, life, perm-ids) tuple is unchanged, skip the rebuild.
	var sig := ""
	for e in entities:
		if e == null:
			continue
		var perms = e.data.get("permanents", [])
		var ptxt := ""
		if typeof(perms) == TYPE_ARRAY:
			ptxt = ",".join(perms.map(func(x): return str(x)))
		sig += "%s|%d|%s;" % [e.id, e.life, ptxt]
	if sig == _roster_signature:
		# Still refresh life pips in-place when nothing structural changed.
		_refresh_roster_life(entities)
		return
	_roster_signature = sig
	for c in _roster_box.get_children():
		c.queue_free()
	for e in entities:
		if e == null:
			continue
		_roster_box.add_child(_make_roster_row(e))
	_roster_panel.reset_size()


func _refresh_roster_life(entities: Array) -> void:
	var rows := _roster_box.get_children()
	for i in range(rows.size()):
		if i >= entities.size():
			break
		var row := rows[i] as Control
		if row == null:
			continue
		var life_lbl := row.find_child("Life", true, false) as Label
		if life_lbl != null:
			var e: Entity = entities[i]
			life_lbl.text = "hp %d/%d · %s" % [e.life, e.life_max, e.faction]


func _make_roster_row(e: Entity) -> PanelContainer:
	var row := PanelContainer.new()
	row.add_theme_stylebox_override("panel", _box(
		Color(0.1, 0.14, 0.08, 0.6) if e.faction == "player" else Color(0.18, 0.08, 0.08, 0.6)
	))
	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 3)
	row.add_child(vb)
	var hb := HBoxContainer.new()
	hb.add_theme_constant_override("separation", 8)
	vb.add_child(hb)
	var thumb := TextureRect.new()
	thumb.custom_minimum_size = Vector2(48, 54)
	thumb.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	thumb.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	var p := e.portrait_path()
	var tex: Texture2D = Assets.load_texture(p) if p != "" else null
	if tex == null:
		var info := e.info_sheet_path()
		var it := Assets.load_texture(info)
		if it != null:
			var at := AtlasTexture.new()
			at.atlas = it
			at.region = Rect2(0, 0, it.get_width(), minf(it.get_height(), it.get_width() * 1.1))
			tex = at
	thumb.texture = tex
	hb.add_child(thumb)
	var col := VBoxContainer.new()
	col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	col.add_theme_constant_override("separation", 1)
	hb.add_child(col)
	var nm := _label(e.display_name, 13, Color(0.98, 0.9, 0.75) if e.faction == "player" else Color(0.95, 0.75, 0.6))
	col.add_child(nm)
	var life := _label("hp %d/%d · %s" % [e.life, e.life_max, e.faction], 11, Color(0.65, 0.9, 0.65) if e.alive else Color(0.9, 0.4, 0.4))
	life.name = "Life"
	col.add_child(life)
	var stats: Dictionary = e.data.get("stats", {})
	if typeof(stats) != TYPE_DICTIONARY:
		stats = {}
	col.add_child(_label("V %s · W %s · M %s · Wi %s" % [
		str(stats.get("vitality", "—")), str(stats.get("world", "—")),
		str(stats.get("matter", "—")), str(stats.get("will", "—")),
	], 10, Color(0.78, 0.78, 0.9)))
	# Permanent mini cards — one row per permanent, icon + name + full desc.
	# Thread the owning peer_id in so each card can look up its live power die
	# (Rule 24) and wire the destroy intent for enemies.
	var perms = e.data.get("permanents", [])
	if typeof(perms) == TYPE_ARRAY and not perms.is_empty():
		var perm_box := VBoxContainer.new()
		perm_box.add_theme_constant_override("separation", 3)
		vb.add_child(perm_box)
		var owner := _peer_id_for_entity(e)
		var enemy := e.faction != "player"
		for sid in perms:
			perm_box.add_child(_make_perm_card(str(sid), true, owner, enemy))
	return row


## Fill `box` with a mini card per skill id. `full_desc` picks between the
## one-line abbreviated form (held skills) and the full data/skills.json text
## (permanents). `owner_peer_id` + `is_enemy` thread through to each perm card
## so enemy-side perms show a power badge and accept a double-click destroy.
func _fill_skill_list(box: VBoxContainer, ids: Variant, full_desc: bool, owner_peer_id: String = "", is_enemy: bool = false) -> void:
	for c in box.get_children():
		c.queue_free()
	if typeof(ids) != TYPE_ARRAY:
		return
	for sid in ids:
		var s := str(sid)
		if s == "":
			continue
		box.add_child(_make_perm_card(s, full_desc, owner_peer_id, is_enemy))


func _make_perm_card(card_id: String, full_desc: bool, owner_peer_id: String = "", is_enemy: bool = false) -> PanelContainer:
	# card_id may be either `skill_*` or `effect_*`; the browser's skill_card.js
	# ingests both pools identically, so we route through RulesText's prefix-aware
	# helpers to pull icon / name / text regardless of which catalog owns the id.
	#
	# owner_peer_id (optional): used to look up the current perm-power die in
	# _server_perm_power — the die an attacker's emission has to beat under
	# Rule 24. When present, we paint a small orange badge over the icon.
	#
	# is_enemy: when true, the card is a destroy target — a double-click or
	# emulated-touch double-tap emits destroy_perm_requested so Game.gd can
	# send a toggle_destroy intent to the peer.
	var card := PanelContainer.new()
	card.add_theme_stylebox_override("panel", _box(Color(0.1, 0.1, 0.14, 0.75)))
	# Enemy perm cards receive gui_input so they can detect double-clicks /
	# double-taps even in the middle of the busy roster panel.
	if is_enemy and owner_peer_id != "":
		card.mouse_filter = Control.MOUSE_FILTER_STOP
		card.set_meta("perm_card_id", card_id)
		card.set_meta("perm_owner_peer_id", owner_peer_id)
		card.gui_input.connect(_on_perm_card_gui_input.bind(card))
		card.tooltip_text = "double-click to attempt destroy (Rule 24)"
	var hb := HBoxContainer.new()
	hb.add_theme_constant_override("separation", 6)
	card.add_child(hb)
	# Icon + badge are stacked so the die floats over the icon's corner.
	var icon_wrap := Control.new()
	icon_wrap.custom_minimum_size = Vector2(32, 32)
	icon_wrap.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hb.add_child(icon_wrap)
	var icon := TextureRect.new()
	icon.set_anchors_preset(Control.PRESET_FULL_RECT)
	icon.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	icon.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	icon.texture = RulesText.card_icon_texture(dl, card_id)
	icon.visible = icon.texture != null
	icon_wrap.add_child(icon)
	var die_text := _power_badge_for(owner_peer_id, card_id)
	if die_text != "":
		# Orange badge, top-left corner, same visual as the browser's
		# .skill-card-power span painted by skill_card.js. Label defaults to
		# MOUSE_FILTER_STOP which would eat the card's gui_input, so force
		# IGNORE and let the parent PanelContainer catch double-clicks.
		var badge := Label.new()
		badge.text = die_text
		badge.add_theme_font_size_override("font_size", 10)
		badge.add_theme_color_override("font_color", Color(1, 0.95, 0.55))
		var pbg := StyleBoxFlat.new()
		pbg.bg_color = Color(0.85, 0.47, 0.17, 0.95)
		pbg.set_corner_radius_all(4)
		pbg.set_content_margin_all(1)
		badge.add_theme_stylebox_override("normal", pbg)
		badge.position = Vector2(-2, -2)
		badge.mouse_filter = Control.MOUSE_FILTER_IGNORE
		badge.tooltip_text = "power %s — the die an enemy's emission has to beat (Rule 24)" % die_text
		icon_wrap.add_child(badge)
	var col := VBoxContainer.new()
	col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	col.add_theme_constant_override("separation", 1)
	hb.add_child(col)
	var nm := _label(RulesText.card_entry_name(dl, card_id), 11, Color(0.95, 0.85, 0.75))
	col.add_child(nm)
	var text := RulesText.card_entry_text(dl, card_id)
	var desc := text if full_desc else RulesText.abbreviate(text, 80)
	var ds := _label(desc, 10, Color(0.82, 0.82, 0.9))
	ds.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	ds.custom_minimum_size = Vector2(260, 0)
	col.add_child(ds)
	return card


func _on_perm_card_gui_input(event: InputEvent, card: Control) -> void:
	# Any pointer source that reports double_click (desktop LMB, emulated-mouse
	# from a double-tap) triggers a destroy intent. Right-click is a no-op; the
	# browser only wires double-click to destroy, so we match that.
	if not (event is InputEventMouseButton):
		return
	var mb: InputEventMouseButton = event
	if not mb.pressed or not mb.double_click:
		return
	if mb.button_index != MOUSE_BUTTON_LEFT:
		return
	var card_id := String(card.get_meta("perm_card_id", ""))
	var owner := String(card.get_meta("perm_owner_peer_id", ""))
	if card_id == "" or owner == "":
		return
	destroy_perm_requested.emit(owner, card_id, "")


func _power_badge_for(peer_id: String, card_id: String) -> String:
	if peer_id == "" or card_id == "":
		return ""
	var per_peer: Variant = _server_perm_power.get(peer_id, null)
	if typeof(per_peer) != TYPE_DICTIONARY:
		return ""
	var die: Variant = (per_peer as Dictionary).get(card_id, null)
	if die == null:
		return ""
	return String(die)


## Return the peer_id associated with the entity `e`, or "" if no server
## snapshot matches. Entities on the local sim carry a character_id or
## creature_id in e.id; the server's peersPublic snapshot uses the same ids.
func _peer_id_for_entity(e: Entity) -> String:
	if e == null:
		return ""
	var want := String(e.id)
	for raw in _server_peers:
		if typeof(raw) != TYPE_DICTIONARY:
			continue
		var p: Dictionary = raw
		var cid := String(p.get("character_id", ""))
		var creid := String(p.get("creature_id", ""))
		if cid == want or creid == want:
			return String(p.get("peer_id", ""))
	return ""


## True when every skill_* / effect_* id in `entities[].data.permanents`
## resolves to a real sprite icon (not the words-form fallback). hud_check.gd
## uses this to assert sibling #1's `resources.sprites.icon` schema is wired.
## Permanents that have no icon field yet still return a texture via the
## effect-strip fallback.
func every_permanent_has_texture(entities: Array) -> bool:
	for e in entities:
		if e == null:
			continue
		var perms = e.data.get("permanents", [])
		if typeof(perms) != TYPE_ARRAY:
			continue
		for sid in perms:
			if RulesText.card_icon_texture(dl, str(sid)) == null:
				return false
	return true
