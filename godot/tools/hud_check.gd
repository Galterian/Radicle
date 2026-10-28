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

	# ---- 4) rich hover card: a hover on a living entity shows thumb + name +
	# hp + stats + (optional) tier/skills/permanents. Parity target is
	# renderHoverCard in game/js/main.js.
	var hover_target: Entity = null
	for e in node.entities:
		if e != null and e.alive:
			hover_target = e
			break
	if hover_target == null:
		print("  FAIL no living entity to hover")
		fail += 1
	else:
		node._on_hex_hovered(hover_target.hex)
		for i in range(4):
			await process_frame
		var hv: bool = node.hud.hover_unit_visible()
		print(("  ok   " if hv else "  FAIL ") + "hover card visible on unit (%s)" % hover_target.display_name)
		if hv: ok += 1
		else: fail += 1
		var hname: String = node.hud._hover_name.text
		var hhp: String = node.hud._hover_hp.text
		var hstats: String = node.hud._hover_stats.text
		print("  hover: name='%s' hp='%s' stats='%s'" % [hname, hhp, hstats])
		var fields_ok := hname != "" and hhp.begins_with("hp ") and hstats.contains("V ") and hstats.contains("Wi ")
		print(("  ok   " if fields_ok else "  FAIL ") + "hover card carries name + hp + V/W/M/Wi stats")
		if fields_ok: ok += 1
		else: fail += 1
		var id_match: bool = node.hud.hover_unit_id() == hover_target.id
		print(("  ok   " if id_match else "  FAIL ") + "hover card references the hovered entity id")
		if id_match: ok += 1
		else: fail += 1
		# Permanent-list parity: the panel shows one mini card per entity.data.permanents
		# entry. In today's catalog `permanents` is usually unset — we just assert the
		# count matches what the data says (both 0 is a pass).
		var perms = hover_target.data.get("permanents", [])
		var want: int = perms.size() if typeof(perms) == TYPE_ARRAY else 0
		var got: int = node.hud.hover_perm_count()
		print(("  ok   " if want == got else "  FAIL ") + "permanent count parity (data=%d, panel=%d)" % [want, got])
		if want == got: ok += 1
		else: fail += 1
		# Move off the unit and the card should hide.
		node._on_hex_hovered(Vector2i(1 << 20, 0))
		print(("  ok   " if not node.hud.hover_unit_visible() else "  FAIL ") + "hover card hides when cursor leaves the unit")
		if not node.hud.hover_unit_visible(): ok += 1
		else: fail += 1
		# Re-show for the screenshot.
		node._on_hex_hovered(hover_target.hex)

	# ---- 5) skill-icon badges: for every skill_* in a canned hand, we must
	# either load a real sprite texture (icon or effect-strip fallback) or fall
	# back to the words-form string in the code label. hud_check reports which
	# of the two happened; sibling #1's `resources.sprites.icon` schema being
	# wired flips every entry to the texture path.
	node.hud.set_hand(["skill_powerful_attack", "skill_sanctuary", "skill_dodge", "skill_bluff", "skill_barricade"], 0, false, {})
	for i in range(6):
		await process_frame
	var tex_hits := 0
	var tex_total := 0
	var dedicated := 0
	for sid in ["skill_powerful_attack", "skill_sanctuary", "skill_dodge", "skill_bluff", "skill_barricade"]:
		tex_total += 1
		var tx := RulesText.skill_icon_texture(node.dl, sid)
		if tx != null:
			tex_hits += 1
			if RulesText.has_dedicated_icon(node.dl, sid):
				dedicated += 1
	print("  skill icon textures: %d/%d resolved (%d dedicated, %d fallback)" % [tex_hits, tex_total, dedicated, tex_hits - dedicated])
	# Soft assertion: at least ONE icon must resolve — otherwise the UI will
	# show the "SKILL" words-form everywhere. Dedicated-icon count is an
	# information line; sibling #1 flips it to tex_total once the field lands.
	print(("  ok   " if tex_hits > 0 else "  FAIL ") + "at least one skill icon loaded (texture or effect fallback)")
	if tex_hits > 0: ok += 1
	else: fail += 1

	# ---- 6) roster parity: one row per entity, each row visible.
	node.hud.set_roster(node.entities)
	for i in range(6):
		await process_frame
	var rows: int = node.hud._roster_box.get_child_count()
	var want_rows: int = node.entities.size()
	print(("  ok   " if rows == want_rows else "  FAIL ") + "roster row count matches entities (data=%d, panel=%d)" % [want_rows, rows])
	if rows == want_rows: ok += 1
	else: fail += 1

	# ---- 7) effect icon resolution: data/effects.json browser parity (sibling #2
	# wired skill_card.js to ingest effects the same way as skills). Godot's
	# RulesText.effect_icon_texture mirrors skill_icon_texture — slices frame 0
	# off resources.sprites.icon with an effect-strip fallback. We assert both
	# the live-catalog path on a real id AND the fallback path on a synthetic
	# entry that only carries `resources.sprites.effect`.
	var eff_id := "effect_summoning"
	var eff_tex: Texture2D = RulesText.effect_icon_texture(node.dl, eff_id)
	var dedicated_eff: bool = RulesText.has_dedicated_effect_icon(node.dl, eff_id)
	print("  %s: tex=%s dedicated=%s" % [eff_id, "yes" if eff_tex != null else "no", "yes" if dedicated_eff else "no"])
	print(("  ok   " if eff_tex != null else "  FAIL ") + "effect_icon_texture resolves a texture for %s" % eff_id)
	if eff_tex != null: ok += 1
	else: fail += 1
	# Non-dedicated path should still produce an AtlasTexture via the effect-strip
	# fallback. (A dedicated icon field would be a direct sheet; both are valid
	# Texture2D — the AtlasTexture assertion only applies when the fallback or a
	# multi-frame icon sheet was sliced.)
	if not dedicated_eff:
		var is_atlas: bool = eff_tex is AtlasTexture
		print(("  ok   " if is_atlas else "  FAIL ") + "fallback path produces an AtlasTexture for %s" % eff_id)
		if is_atlas: ok += 1
		else: fail += 1

	# Synthetic entry: force the fallback branch regardless of whether sibling #1
	# has populated the real catalog yet. The entry carries only
	# `resources.sprites.effect`, so icon_texture_from_entry MUST slice frame 0
	# off the strip. We re-use effect_summoning's known effect-strip path.
	var real_entry: Dictionary = node.dl.get_entry("effects", eff_id)
	var real_eff_path := ""
	var _res = real_entry.get("resources", {})
	if typeof(_res) == TYPE_DICTIONARY:
		var _sp = _res.get("sprites", {})
		if typeof(_sp) == TYPE_DICTIONARY:
			var _ef = _sp.get("effect", null)
			if typeof(_ef) == TYPE_DICTIONARY:
				real_eff_path = str(_ef.get("path", ""))
	var mock_entry := {
		"id": "effect_mock",
		"resources": {
			"sprites": {
				# No `icon` key — the slicer must take the fallback branch.
				"effect": {"path": real_eff_path},
			},
		},
	}
	var mock_tex: Texture2D = RulesText.icon_texture_from_entry(mock_entry)
	print("  mock-entry fallback: path='%s' tex=%s" % [real_eff_path, "yes" if mock_tex != null else "no"])
	print(("  ok   " if mock_tex != null else "  FAIL ") + "icon_texture_from_entry resolves a Texture2D from a synthetic entry (fallback path)")
	if mock_tex != null: ok += 1
	else: fail += 1
	var mock_is_atlas: bool = mock_tex is AtlasTexture
	print(("  ok   " if mock_is_atlas else "  FAIL ") + "synthetic-entry fallback returns an AtlasTexture (sliced from the effect strip)")
	if mock_is_atlas: ok += 1
	else: fail += 1
	# Negative control: an entry with no sprites at all must return null.
	var empty_tex: Texture2D = RulesText.icon_texture_from_entry({"id": "effect_void"})
	print(("  ok   " if empty_tex == null else "  FAIL ") + "icon_texture_from_entry returns null when neither icon nor effect sprite exists")
	if empty_tex == null: ok += 1
	else: fail += 1

	for i in range(6):
		await process_frame
	img = get_root().get_viewport().get_texture().get_image()
	var p4 := out_dir.path_join("hud_hover_card.png")
	print("  wrote %s err=%d" % [p4, img.save_png(p4)])

	print("== hud_check: %d ok, %d failed" % [ok, fail])
	quit(1 if fail > 0 else 0)
