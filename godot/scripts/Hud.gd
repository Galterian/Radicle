class_name Hud
extends CanvasLayer
## HUD: portrait + life, phase/timer, 5-slot hand bar (A/B/M/P/EP/EM), battle log, hints.
## Built in code so the scene file stays trivial.

signal slot_pressed(index: int)
signal lock_pressed
## Fired when the player double-taps an enemy's permanent card in the roster.
## Carries the stat the destroy intent should emit at the perm (Rule 24).
signal destroy_perm_requested(peer_id: String, perm_id: String, stat: String)
## Fired when the player taps a roster row — Game.gd makes that entity the
## HUD's active one (portrait + camera focus). Mobile-only wire.
signal entity_activated(entity_id: String)

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
# Always-on top-centre status strip. On mobile this replaces the keyboard
# shortcut hint so the player can confirm the game is still running even
# when another panel clips off-screen.
var _status_strip: PanelContainer
var _status_lbl: Label
# Secondary strip label — shows "<effect> ch." in orange while the local
# player is channeling. Game.gd drives it via set_channel_label(). Empty
# text hides it.
var _channel_lbl: Label
# Mobile-only inline hint shown while planning with no card picked.
var _mobile_hint: Label
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
# GridContainer so >3 permanents wrap into 2 columns instead of overflowing
# vertically into the log/roster above. columns is toggled per-render.
var _hover_perms_box: GridContainer
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
# Opaque backdrop behind the slot bar. On Android some slot modulates can
# render transparent; the backdrop keeps the hand visible as a block.
var _bar_bg: PanelContainer
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

# Mobile-only compact strips above the hand bar — the Godot HUD never built
# the browser's #archive-pile / #deck-pile / #perms widgets, so phones ran
# without any pile counts or permanents readout. These two labels fill that
# gap: one line of pile counts, one line of permanent codes.
var _mobile_piles_lbl: Label = null
var _mobile_perms_lbl: Label = null
# Mobile-only big floating commit button. The regular _lock_btn sits inside
# the HBoxContainer `_bar`; if `_bar`'s position ends up off-screen (narrow
# viewport, orientation glitch, container measurement race) the player can't
# commit a turn at all. This independent BOTTOM_RIGHT-anchored button
# guarantees a commit affordance on phones regardless of _bar's state.
var _mobile_commit_btn: Button = null
# Root Control that owns every HUD child. We hold a reference so _apply_layout
# can force it to the current viewport size — Controls that are direct children
# of a CanvasLayer don't automatically inherit the viewport rect on Android,
# so without this every anchor-based child computes from a (0,0,0,0) parent
# rect and lands off-screen top-left (visible symptom: only the top-left
# portrait panel renders; hand bar, log, END TURN, roster all missing).
var _root: Control = null
# How many pixels of extra bottom padding to add on Android so the hand bar
# clears the system gesture/nav area. Measured on a Pixel-class phone — the
# bar's lower edge was ~40 px below the usable rect without this lift.
const MOBILE_SAFE_BOTTOM := 56.0


func _ready() -> void:
	layer = 10
	var root := Control.new()
	root.name = "Root"
	root.set_anchors_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(root)
	_root = root

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
	# Backdrop first — must be added BEFORE _bar so it renders beneath.
	_bar_bg = PanelContainer.new()
	_bar_bg.name = "BarBackdrop"
	_bar_bg.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_bar_bg.add_theme_stylebox_override("panel", _box(Color(0.06, 0.06, 0.08, 0.75)))
	_bar_bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(_bar_bg)
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
		# Explicit styleboxes — Android's default Button theme can render
		# near-invisible on dark backgrounds, so pin the look here.
		b.add_theme_stylebox_override("normal",   _box(Color(0.14, 0.14, 0.18, 0.95)))
		b.add_theme_stylebox_override("hover",    _box(Color(0.22, 0.22, 0.28, 0.98)))
		b.add_theme_stylebox_override("pressed",  _box(Color(0.32, 0.32, 0.40, 1.00)))
		b.add_theme_stylebox_override("disabled", _box(Color(0.08, 0.08, 0.10, 0.80)))
		b.add_theme_stylebox_override("focus",    _box(Color(0.55, 0.75, 0.95, 0.20)))
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
	# Same explicit styleboxes as the slot buttons — Android's default theme
	# can render buttons near-invisible on the dark backdrop.
	_lock_btn.add_theme_stylebox_override("normal",   _box(Color(0.14, 0.14, 0.18, 0.95)))
	_lock_btn.add_theme_stylebox_override("hover",    _box(Color(0.22, 0.22, 0.28, 0.98)))
	_lock_btn.add_theme_stylebox_override("pressed",  _box(Color(0.32, 0.32, 0.40, 1.00)))
	_lock_btn.add_theme_stylebox_override("disabled", _box(Color(0.08, 0.08, 0.10, 0.80)))
	_lock_btn.add_theme_stylebox_override("focus",    _box(Color(0.55, 0.75, 0.95, 0.20)))
	_lock_btn.pressed.connect(func(): lock_pressed.emit())
	bar.add_child(_lock_btn)

	_hint = _label("1-5 pick card · click hex = target/path · click building = info (Esc closes) · right-click = discard · Space = lock · wheel zoom · MMB pan · C recenter", 11, Color(0.6, 0.6, 0.65))
	_hint.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_hint.position = Vector2(-440, -16)
	_hint.custom_minimum_size = Vector2(880, 14)
	_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	root.add_child(_hint)

	# --- top-centre: always-on status strip (R / DIM / HAND / HEX)
	_status_strip = PanelContainer.new()
	_status_strip.name = "StatusStrip"
	_status_strip.set_anchors_preset(Control.PRESET_CENTER_TOP)
	_status_strip.add_theme_stylebox_override("panel", _box(Color(0.06, 0.06, 0.08, 0.80)))
	_status_strip.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(_status_strip)
	# HBox wrapper lets the channel chip sit beside the status line without
	# fighting PanelContainer's single-child layout.
	var strip_hb := HBoxContainer.new()
	strip_hb.add_theme_constant_override("separation", 10)
	strip_hb.alignment = BoxContainer.ALIGNMENT_CENTER
	strip_hb.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_status_strip.add_child(strip_hb)
	_status_lbl = _label("R:- · DIM:- · HAND:- · HEX:-", 12, Color(0.9, 0.9, 0.95))
	_status_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_status_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	strip_hb.add_child(_status_lbl)
	_channel_lbl = _label("", 12, Color(0.95, 0.75, 0.4))
	_channel_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_channel_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_channel_lbl.visible = false
	strip_hb.add_child(_channel_lbl)

	# --- bottom-centre: compact pile + permanent strips (mobile only)
	# These sit above the hand bar on phones. On desktop the roster + hover
	# card already surface the same info, so we keep them hidden there.
	_mobile_piles_lbl = _label("", 11, Color(0.85, 0.9, 0.95))
	_mobile_piles_lbl.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_mobile_piles_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_mobile_piles_lbl.custom_minimum_size = Vector2(560, 14)
	_mobile_piles_lbl.visible = false
	_mobile_piles_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_mobile_piles_lbl.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.9))
	_mobile_piles_lbl.add_theme_constant_override("outline_size", 3)
	root.add_child(_mobile_piles_lbl)
	_mobile_perms_lbl = _label("", 11, Color(0.95, 0.85, 0.5))
	_mobile_perms_lbl.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_mobile_perms_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_mobile_perms_lbl.custom_minimum_size = Vector2(560, 14)
	_mobile_perms_lbl.visible = false
	_mobile_perms_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_mobile_perms_lbl.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.9))
	_mobile_perms_lbl.add_theme_constant_override("outline_size", 3)
	root.add_child(_mobile_perms_lbl)

	# --- bottom-centre: mobile planning hint (hidden until Game sets text)
	_mobile_hint = _label("", 11, Color(0.95, 0.85, 0.6))
	_mobile_hint.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_mobile_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_mobile_hint.custom_minimum_size = Vector2(360, 14)
	_mobile_hint.visible = false
	_mobile_hint.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(_mobile_hint)

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
	_hover_perms_box = GridContainer.new()
	_hover_perms_box.columns = 1
	_hover_perms_box.add_theme_constant_override("h_separation", 4)
	_hover_perms_box.add_theme_constant_override("v_separation", 4)
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

	# Mobile commit (lock) fallback — big, anchored BOTTOM_RIGHT, independent
	# of the _bar HBoxContainer so a container-sizing glitch can't hide it.
	# Hidden on desktop; _apply_layout flips it on when OS reports mobile.
	_mobile_commit_btn = Button.new()
	_mobile_commit_btn.name = "MobileCommit"
	_mobile_commit_btn.text = "END\nTURN"
	_mobile_commit_btn.custom_minimum_size = Vector2(96, 72)
	_mobile_commit_btn.add_theme_font_size_override("font_size", 16)
	_mobile_commit_btn.add_theme_stylebox_override("normal",   _box(Color(0.22, 0.14, 0.08, 0.95)))
	_mobile_commit_btn.add_theme_stylebox_override("hover",    _box(Color(0.32, 0.20, 0.10, 0.98)))
	_mobile_commit_btn.add_theme_stylebox_override("pressed",  _box(Color(0.45, 0.28, 0.14, 1.00)))
	_mobile_commit_btn.add_theme_stylebox_override("disabled", _box(Color(0.14, 0.10, 0.08, 0.80)))
	_mobile_commit_btn.add_theme_color_override("font_color", Color(1, 0.9, 0.6))
	_mobile_commit_btn.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
	_mobile_commit_btn.visible = false
	_mobile_commit_btn.pressed.connect(func(): lock_pressed.emit())
	root.add_child(_mobile_commit_btn)

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
	# Android caveat: get_viewport().size_changed fires on surface recreate
	# (alt-tab, orientation flip) but NOT at first-boot — the viewport is
	# still (1,1) or stale when _ready runs, so the initial _apply_layout
	# positions every panel off-screen. We poll in _process until the viewport
	# stabilises; after that `size_changed` handles subsequent flips.
	get_viewport().size_changed.connect(_on_viewport_resized)
	_apply_layout()
	# Belt-and-braces: on Android the viewport is often still a stub when
	# _ready fires, so _apply_layout runs with a bad vp and leaves the HUD
	# off-screen (and the defensive left-clamp drags TOP_RIGHT panels to the
	# left edge). Schedule two more applies — one on the next frame and one
	# ~0.6 s later — so even a slow surface warm-up resolves correctly.
	call_deferred("_apply_layout")
	get_tree().create_timer(0.6).timeout.connect(_apply_layout)
	set_process(true)


var _layout_poll_t := 0.0
var _layout_poll_done := false

## Android: `size_changed` doesn't fire at first-boot. Poll the viewport for
## the first ~4 seconds and re-apply the layout whenever the size differs
## from the one we last laid out against. Once we hit a stable non-stub
## viewport we stop polling (set_process(false)).
func _process(dt: float) -> void:
	if _layout_poll_done:
		return
	_layout_poll_t += dt
	var sz := get_viewport().get_visible_rect().size
	var sz_i := Vector2i(sz)
	if sz_i != _last_viewport_size and sz.x > 32 and sz.y > 32:
		_last_viewport_size = sz_i
		_apply_layout()
	# Stop polling once we have a sensible viewport AND four seconds have
	# elapsed — covers slow Android surface warm-up without burning CPU
	# forever. If a rotation happens later, size_changed catches it.
	if _layout_poll_t > 4.0 and sz.x > 32 and sz.y > 32:
		_layout_poll_done = true
		set_process(false)


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
	# Bail out on a garbage viewport (Android first-boot reports (0,0) / (1,1)
	# before the surface is laid out). Running _apply_layout with vp.x < 32
	# would collapse SLOT_SIZE to its clamp min, position the bar at
	# (-212, -136) → off-screen, and trip the x-clamp below which would drag
	# every TOP_RIGHT-anchored panel to global x=0 (visible symptom: the log
	# panel appears at the TOP-LEFT corner instead of top-right, and the hand
	# bar / commit button / portrait never appear). _process polling will
	# call us again once the real viewport arrives; the deferred calls in
	# _ready also retry on the next frame + at 0.6 s.
	if vp.x < 32 or vp.y < 32:
		return
	# Pin _root to the actual viewport rect. CanvasLayer isn't a Control, so a
	# Control that's a direct child doesn't get resized to the viewport
	# automatically on Android — its rect stays (0,0,0,0) and every
	# anchor-based child lands off-screen top-left. PRESET_FULL_RECT would
	# re-derive the size from the (0,0,0,0) parent rect, so clear the
	# right/bottom anchors first and set the size explicitly.
	if _root != null:
		_root.anchor_left = 0.0
		_root.anchor_top = 0.0
		_root.anchor_right = 0.0
		_root.anchor_bottom = 0.0
		_root.position = Vector2.ZERO
		_root.size = vp
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
			_anchored(_panel_phase, Vector2(-minf(vp.x * 0.44 + 4, 200), 8))
			_panel_phase.custom_minimum_size = Vector2(minf(vp.x * 0.44, 192), 0)
		else:
			_panel_phase.set_anchors_preset(Control.PRESET_CENTER_TOP)
			_anchored(_panel_phase, Vector2(-160, 12))
			_panel_phase.custom_minimum_size = Vector2(320, 0)
	if _log_panel != null:
		if portrait:
			_log_panel.set_anchors_preset(Control.PRESET_TOP_RIGHT)
			_anchored(_log_panel, Vector2(-(vp.x * 0.5 + 4), 120))
			_log_panel.custom_minimum_size = Vector2(vp.x * 0.5 - 12, minf(vp.y * 0.28, 180))
		elif mobile:
			# Landscape phone: a narrower log so there's room for the hex board.
			# Cap at 30% height so the bigger mobile font doesn't push the log
			# into the roster below it.
			_log_panel.set_anchors_preset(Control.PRESET_TOP_RIGHT)
			_anchored(_log_panel, Vector2(-minf(vp.x * 0.33, 320) - 4, 8))
			_log_panel.custom_minimum_size = Vector2(minf(vp.x * 0.33, 320), minf(vp.y * 0.3, 180))
		else:
			_log_panel.set_anchors_preset(Control.PRESET_TOP_RIGHT)
			_anchored(_log_panel, Vector2(-372, 12))
			_log_panel.custom_minimum_size = Vector2(360, 300)
	if _hover_panel != null:
		if portrait:
			_anchored(_hover_panel, Vector2(-(vp.x * 0.5 + 4), 316))
			_hover_panel.custom_minimum_size = Vector2(vp.x * 0.5 - 12, 0)
		elif mobile:
			# Below the log panel (new mobile log height 0.3*vp.y / 180).
			_hover_panel.set_anchors_preset(Control.PRESET_TOP_RIGHT)
			_anchored(_hover_panel, Vector2(-minf(vp.x * 0.33, 320) - 4, minf(vp.y * 0.3, 180) + 16))
			_hover_panel.custom_minimum_size = Vector2(minf(vp.x * 0.33, 320), 0)
		else:
			_hover_panel.set_anchors_preset(Control.PRESET_TOP_RIGHT)
			_anchored(_hover_panel, Vector2(-372, 320))
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
			_anchored(_roster_panel, Vector2(-(vp.x * 0.5 + 4), -(SLOT_SIZE.y + 20) - 160))
			_roster_panel.custom_minimum_size = Vector2(vp.x * 0.5 - 12, 0)
		elif mobile:
			# Hidden by default; the floating ☰ toggle below reveals it. The
			# roster is still full-width when shown so the player can read
			# names/HP/perms without squinting.
			_roster_panel.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
			_anchored(_roster_panel, Vector2(-minf(vp.x * 0.5, 340), -(SLOT_SIZE.y + 20) - 240))
			_roster_panel.custom_minimum_size = Vector2(minf(vp.x * 0.5 - 12, 340), 0)
			if _roster_panel.visible == true and _last_viewport_size == Vector2i.ZERO:
				_roster_panel.visible = false
		else:
			_roster_panel.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
			_anchored(_roster_panel, Vector2(-372, -(SLOT_SIZE.y + 20) - 268))
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
	# On mobile the Android nav/gesture area at the bottom pushes the hand bar
	# off-screen; add a safe-area lift so the whole bar + its indicators stay
	# in the usable rect. 0 on desktop so nothing changes there.
	var safe_bottom: float = MOBILE_SAFE_BOTTOM if (OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")) else 0.0
	if _bar != null:
		var bar_w := SLOT_SIZE.x * 5 + (SLOT_SIZE.x * 0.65) + SLOT_GAP * 5
		_anchored(_bar, Vector2(-bar_w * 0.5, -(SLOT_SIZE.y + 20) - safe_bottom))
		# Backdrop follows the bar with ~8px padding so a transparent slot can
		# never hide the hand entirely.
		if _bar_bg != null:
			var pad := 8.0
			_anchored(_bar_bg, Vector2(-bar_w * 0.5 - pad, -(SLOT_SIZE.y + 20) - pad - safe_bottom))
			_bar_bg.custom_minimum_size = Vector2(bar_w + pad * 2, SLOT_SIZE.y + pad * 2)
			_bar_bg.size = _bar_bg.custom_minimum_size
	# Mobile piles + perms strips stack right above the hand bar. Hidden on
	# desktop (the roster/hover already carry the same info).
	var _is_mobile_now := OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")
	if _mobile_piles_lbl != null:
		_mobile_piles_lbl.visible = _is_mobile_now
		_anchored(_mobile_piles_lbl, Vector2(-280, -(SLOT_SIZE.y + 20) - safe_bottom - 16))
	if _mobile_perms_lbl != null:
		_mobile_perms_lbl.visible = _is_mobile_now and _mobile_perms_lbl.text != ""
		_anchored(_mobile_perms_lbl, Vector2(-280, -(SLOT_SIZE.y + 20) - safe_bottom - 30))
	if _hint != null:
		_hint.visible = not portrait and not mobile
		if _hint.visible:
			_hint.text = "1-5 pick card · click hex = target/path · click building = info (Esc closes) · right-click = discard · Space = lock · wheel zoom · MMB pan · C recenter"
		else:
			_hint.text = ""
	# Top-centre status strip. On mobile _panel_phase has moved to the right
	# corner so the top-centre is free; on desktop it's also top-centre, so
	# push the status strip a bit lower to avoid overlap.
	if _status_strip != null:
		_status_strip.set_anchors_preset(Control.PRESET_CENTER_TOP)
		var strip_w := minf(vp.x * 0.6, 460.0)
		_status_strip.custom_minimum_size = Vector2(strip_w, 0)
		var strip_y := 8.0 if (portrait or mobile) else 56.0
		_anchored(_status_strip, Vector2(-strip_w * 0.5, strip_y))
	if _mobile_hint != null:
		_mobile_hint.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
		_anchored(_mobile_hint, Vector2(-180, -(SLOT_SIZE.y + 20) - safe_bottom - 44))
		var on_mobile := OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")
		if not on_mobile:
			_mobile_hint.visible = false
	# Position the roster toggle above the slot bar. On mobile we also force
	# the roster panel visible so the player always sees the unit list and
	# can tap an entry to activate it (the toggle still lets them hide it).
	if _roster_toggle != null:
		_roster_toggle.visible = portrait or mobile
		_anchored(_roster_toggle, Vector2(-56, -(SLOT_SIZE.y + 20) - safe_bottom - 56))
	if mobile and _roster_panel != null:
		_roster_panel.visible = true
	# Mobile commit (lock) fallback: anchored BOTTOM_RIGHT, placed to the LEFT
	# of the roster toggle so neither covers the other and both clear the hand
	# bar. Hidden on desktop (the in-bar _lock_btn handles that path).
	if _mobile_commit_btn != null:
		_mobile_commit_btn.visible = portrait or mobile
		_anchored(_mobile_commit_btn, Vector2(-(96 + 56 + 12), -(SLOT_SIZE.y + 20) - safe_bottom - 76))
	# Mobile log font bump — the 12-pt default is unreadable on a phone and
	# collides visually with the roster. Keep desktop at 12.
	if _log != null:
		_log.add_theme_font_size_override("normal_font_size", 16 if (portrait or mobile) else 12)
	# Defensive clamps — only pull a panel back on-screen when its RIGHT edge
	# is still off the left side of the viewport. The previous version
	# clamped on `position.x < 0`, which on Android fired every time
	# _apply_layout ran before the viewport settled: a TOP_RIGHT-anchored
	# panel with offset_left=-324 and parent.right≈0 had position.x = -324,
	# so the clamp bumped position.x += 324, forcing the control to global
	# x=0 (TOP-LEFT) permanently. The vp.x < 32 early-return above now
	# prevents that case; this clamp only catches the rare "panel wider than
	# viewport" overflow.
	if _log_panel != null:
		var lp_rect := _log_panel.get_global_rect()
		if lp_rect.position.x + lp_rect.size.x < 32.0:
			_log_panel.position.x += (32.0 - (lp_rect.position.x + lp_rect.size.x))
	if _hover_panel != null:
		var hv_rect := _hover_panel.get_global_rect()
		if hv_rect.position.x + hv_rect.size.x < 32.0:
			_hover_panel.position.x += (32.0 - (hv_rect.position.x + hv_rect.size.x))
	if _roster_panel != null:
		var rp_rect := _roster_panel.get_global_rect()
		if rp_rect.position.x + rp_rect.size.x < 32.0:
			_roster_panel.position.x += (32.0 - (rp_rect.position.x + rp_rect.size.x))
	if _panel_phase != null:
		var pp_rect := _panel_phase.get_global_rect()
		if pp_rect.position.x + pp_rect.size.x < 32.0:
			_panel_phase.position.x += (32.0 - (pp_rect.position.x + pp_rect.size.x))
	# Boot-time diagnostic: every major panel's absolute rect so adb logcat
	# makes mis-positioning obvious.
	print("[Hud] bar=", _bar.get_global_rect() if _bar else "nil",
		  " log=", _log_panel.get_global_rect() if _log_panel else "nil",
		  " status=", _status_strip.get_global_rect() if _status_strip else "nil")


func attach_mobile_input(mi: MobileInput) -> void:
	# No direct HUD gestures today — the slots are regular Buttons so the
	# emulated-mouse layer already drives them from taps. We keep this hook
	# so later touch-only UI (long-press, swipe-dismiss, etc) can plug in
	# without a Game.gd change.
	if mi == null:
		return


# ------------------------------------------------------------------ anchored position

# Set a Control's position in anchor-relative terms (i.e. offset from the
# anchor origin, which is Godot 3's `.position` semantics). In Godot 4 the
# plain `.position` setter writes to the final rendered top-left (not the
# anchor-relative offset), so a `.position = Vector2(-bar_w*0.5, -SLOT_H)`
# that was correct in the original codebase lands the control at absolute
# (-bar_w*0.5, -SLOT_H) → off-screen top-left on Android. Writing offset_left
# / offset_top restores the anchor-relative behavior the code expects.
static func _anchored(c: Control, p: Vector2) -> void:
	c.offset_left = p.x
	c.offset_top = p.y

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


## Update the always-visible top-centre status strip. Called from Game.gd
## with the current round / dim / hand / hex-count values.
func set_status(round_no: int, dim_name: String, hand_size: int, hex_count: int) -> void:
	if _status_lbl == null:
		return
	_status_lbl.text = "R:%d · DIM:%s · HAND:%d · HEX:%d" % [round_no, dim_name, hand_size, hex_count]


## Channel chip beside the status line. Game.gd calls with e.g. "Blizzard ch."
## while a channel is active, "" when it ends. Hidden when empty.
func set_channel_label(text: String) -> void:
	if _channel_lbl == null:
		return
	if text == null or text == "":
		_channel_lbl.visible = false
		_channel_lbl.text = ""
		return
	_channel_lbl.text = text
	_channel_lbl.visible = true


## Mobile piles indicator: compact "arch:A · deck:D (at-min) · disc:X" line.
## Called from Game.gd whenever any pile count changes. Hidden on desktop
## (handled by _apply_layout, so no feature check here).
func set_mobile_piles(archive_n: int, deck_n: int, discard_n: int, at_min: bool) -> void:
	if _mobile_piles_lbl == null:
		return
	var deck_frag := "deck:%d" % deck_n
	if at_min:
		deck_frag += " ⚠min"
	_mobile_piles_lbl.text = "arch:%d · %s · disc:%d" % [archive_n, deck_frag, discard_n]


## Mobile permanents indicator: compact "perms: codeA · codeB · ..." line.
## Empty list hides the row. Codes come from the local player's permanents.
func set_mobile_perms(codes: Array) -> void:
	if _mobile_perms_lbl == null:
		return
	if codes == null or codes.is_empty():
		_mobile_perms_lbl.text = ""
		_mobile_perms_lbl.visible = false
		return
	var frags: Array = []
	for c in codes:
		frags.append(str(c))
	_mobile_perms_lbl.text = "perms: " + " · ".join(frags)
	var on_mobile := OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")
	_mobile_perms_lbl.visible = on_mobile


## Mobile planning hint ("Tap a card, then tap a hex to move"). Empty text
## hides the label. Only drawn on mobile and only while unpicked.
func set_mobile_hint(text: String) -> void:
	if _mobile_hint == null:
		return
	var on_mobile := OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")
	if not on_mobile or text == "":
		_mobile_hint.visible = false
		_mobile_hint.text = ""
		return
	_mobile_hint.text = text
	_mobile_hint.visible = true


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
		# Defensive fallback — RulesText returns "" for unknown codes; a raw
		# code is still more useful than an empty tooltip.
		if full == null or full == "":
			full = code
		var name: String = RulesText.skill_name(dl, code) if is_skill else str(CODE_NAMES.get(code, code))
		if name == null or name == "":
			name = code
		var is_channel := _card_has_channeling_tag(code)
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
		# Channel chip appended to the slot name — bundled font lacks the
		# ⟳ glyph so " [CHAN]" + a cold-blue tint flag it.
		var disp_name := name + ((" → " + t) if t != "" else "")
		if is_channel:
			disp_name += " [CHAN]"
			_slot_name[i].add_theme_color_override("font_color", Color(0.65, 0.95, 1.0))
		else:
			_slot_name[i].add_theme_color_override("font_color", Color(0.95, 0.95, 0.95))
		_slot_name[i].text = disp_name
		var short := RulesText.card_short(dl, code)
		if short == null or short == "":
			short = code
		_slot_desc[i].text = short
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


## Read-only view of the last `hand` message. Game.gd reads this to push the
## mobile piles indicator from the authoritative server state. Returns {} when
## nothing has arrived yet (solo play without a connected peer).
func server_hand() -> Dictionary:
	return _server_hand


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
	# Tap-to-activate: a tap anywhere on the row fires entity_activated so
	# Game.gd can swap the HUD portrait + camera focus to this unit. The
	# nested perm cards' own gui_input (double-click → destroy intent) is
	# still above us in the input stack so this never swallows those.
	row.mouse_filter = Control.MOUSE_FILTER_STOP
	var _ent_id := e.id
	row.gui_input.connect(func(ev: InputEvent):
		if ev is InputEventMouseButton and (ev as InputEventMouseButton).pressed and (ev as InputEventMouseButton).button_index == MOUSE_BUTTON_LEFT:
			entity_activated.emit(_ent_id)
		elif ev is InputEventScreenTouch and (ev as InputEventScreenTouch).pressed:
			entity_activated.emit(_ent_id)
	)
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
		# >3 perms wrap into 2 columns so the row never overflows into the
		# log panel above. Up to 3 → single column (keeps the familiar look).
		var perm_box: Container
		if perms.size() <= 3:
			perm_box = VBoxContainer.new()
			perm_box.add_theme_constant_override("separation", 3)
		else:
			var g := GridContainer.new()
			g.columns = 2
			g.add_theme_constant_override("h_separation", 4)
			g.add_theme_constant_override("v_separation", 3)
			perm_box = g
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
func _fill_skill_list(box: Container, ids: Variant, full_desc: bool, owner_peer_id: String = "", is_enemy: bool = false) -> void:
	for c in box.get_children():
		c.queue_free()
	if typeof(ids) != TYPE_ARRAY:
		return
	# Keep a single column for ≤3 entries; wrap into 2 columns beyond that so
	# the perm list never grows taller than the log/roster above (parity for
	# the browser's grid-template-columns rule on crowded cards).
	if box is GridContainer:
		var g := box as GridContainer
		g.columns = 1 if (ids as Array).size() <= 3 else 2
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
	var entry_name := RulesText.card_entry_name(dl, card_id)
	if entry_name == null or entry_name == "":
		entry_name = card_id
	# Flag channeled permanents so the player can see which card is "live"
	# (parity with the browser's ⟳ chip in skill_card.js).
	if _card_has_channeling_tag(card_id):
		entry_name = "ch: " + entry_name
	var nm := _label(entry_name, 11, Color(0.95, 0.85, 0.75))
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


## True when the catalog entry for `code` carries the "channeling" tag. Looks
## in effects/* first (effect_blizzard etc.), then skills/* (skill_* ids).
## Unknown codes / missing dl just return false.
func _card_has_channeling_tag(code: String) -> bool:
	if dl == null or code == "":
		return false
	var kind := ""
	if code.begins_with("effect_"):
		kind = "effects"
	elif code.begins_with("skill_"):
		kind = "skills"
	else:
		return false
	var entry := dl.get_entry(kind, code)
	var tags: Variant = entry.get("tags", [])
	if typeof(tags) != TYPE_ARRAY:
		return false
	return (tags as Array).has("channeling")


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
