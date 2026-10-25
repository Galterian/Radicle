extends SceneTree
## Visual check for the HUD object card and the always-visible card rule text.
## Boots Main.tscn, finds a building on a known hex, runs the same code path as a
## left-click on it (Game._on_hex_clicked with no card chosen) and screenshots; then
## sets a fixed hand and screenshots the deck bar with its descriptions.
##
## Run (needs a display):
##   ../_tools/godot --path . --resolution 1600x1000 -s tools/hud_check.gd [out_dir]

const DEFAULT_OUT := "/home/galt/chaosd6_mapper/chaosD6/_tools"
const SETTLE_FRAMES := 60


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var out_dir: String = args[0] if args.size() > 0 else DEFAULT_OUT
	var scene: PackedScene = load("res://scenes/Main.tscn")
	var node := scene.instantiate()
	get_root().add_child(node)
	for i in range(SETTLE_FRAMES):
		await process_frame
	# Freeze the round loop so the dealt hand / phase don't change under us.
	node.phase = "hud_check"
	node.chosen = -1
	node.hud.set_phase("hud check · frozen", 1.0)

	# ---- 1) object card: pick the first known building that has no entity on it.
	var target: Variant = null
	var feat: Dictionary = {}
	for f in node.gen.features_for_known():
		var h: Vector2i = f.hex
		if node.entity_at(h) == null:
			target = h
			feat = f.feature
			break
	if target == null:
		# No building known yet: fall back to a landmark, then any scatter.
		for f in node.gen.bigfeatures_for_known():
			if node.entity_at(f.hex) == null:
				target = f.hex; feat = f.big_feature; break
	if target == null:
		for s in node.gen.scatter_for_known():
			if node.entity_at(s.hex) == null:
				target = s.hex; feat = s.scatter; break
	var ok := 0
	var fail := 0
	if target == null:
		print("  FAIL no map object found on known hexes")
		fail += 1
	else:
		var h: Vector2i = target
		print("  object at %s: %s (%s, %s)" % [Hex.key_of(h), feat.get("label", "?"), feat.get("kind", "?"), feat.get("biome", "?")])
		node.cam.follow = null
		node.cam.position = Hex.hex_to_pixel(h.x, h.y)
		node.map.hover = h
		node._on_hex_hovered(h)
		node._on_hex_clicked(h, MOUSE_BUTTON_LEFT)
		var shown: bool = node.hud.object_card_visible()
		print(("  ok   " if shown else "  FAIL ") + "object card visible after click")
		if shown: ok += 1
		else: fail += 1
		var desc: String = node.hud._obj_desc.text
		print("  card: title='%s' kind='%s' coords='%s'" % [node.hud._obj_title.text, node.hud._obj_kind.text, node.hud._obj_coords.text])
		print("  card desc: %s" % desc)
		print(("  ok   " if desc != "" else "  FAIL ") + "desc line non-empty")
		if desc != "": ok += 1
		else: fail += 1
		var hover: String = node.hud._hover_lbl.text
		print("  hover: %s" % hover)
		print(("  ok   " if hover.ends_with(str(feat.get("label", ""))) else "  FAIL ") + "hover line appends object label")
		# Esc hides the card.
		var ev := InputEventAction.new()
		ev.action = "ui_cancel"
		ev.pressed = true
		node._unhandled_input(ev)
		print(("  ok   " if not node.hud.object_card_visible() else "  FAIL ") + "Esc hides the card")
		if node.hud.object_card_visible(): fail += 1
		# Reopen for the screenshot.
		node._on_hex_clicked(h, MOUSE_BUTTON_LEFT)
	for i in range(10):
		await process_frame
	var img := get_root().get_viewport().get_texture().get_image()
	var p1 := out_dir.path_join("hud_object_card.png")
	print("  wrote %s err=%d" % [p1, img.save_png(p1)])

	# ---- 2) deck bar with rule text.
	node.hud.hide_object_card()
	node.hud.set_hand(["A", "B", "M", "P", "EP"], 0, false, {0: "3,2"})
	for code in ["A", "B", "M", "P", "EP", "EM"]:
		print("  %-2s  slot: %s" % [code, RulesText.action_short(code)])
		print("      full: %s" % RulesText.action_help(code))
	for i in range(10):
		await process_frame
	img = get_root().get_viewport().get_texture().get_image()
	var p2 := out_dir.path_join("hud_cards.png")
	print("  wrote %s err=%d" % [p2, img.save_png(p2)])

	# ---- 3) bonus: EM + skill cards (uses data/skills.json text).
	node.hud.set_hand(["EM", "skill_powerful_attack", "skill_sanctuary", "A", "B"], 1, false, {})
	for i in range(10):
		await process_frame
	img = get_root().get_viewport().get_texture().get_image()
	var p3 := out_dir.path_join("hud_cards_skill.png")
	print("  wrote %s err=%d" % [p3, img.save_png(p3)])
	print("== hud_check: %d ok, %d failed" % [ok, fail])
	quit(1 if fail > 0 else 0)
