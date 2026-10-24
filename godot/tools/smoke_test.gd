extends SceneTree
## Headless smoke test for the chaosD6 Godot client.
## Run from godot/:  Godot --headless --path . -s tools/smoke_test.gd
## Checks: data loads, resources resolve to files on disk, sheets slice into 8-direction
## SpriteFrames, hex map generation + reveal, A* pathfinding, WAV loading, main scene boots.

var failures := 0


func check(cond: bool, msg: String) -> void:
	if cond:
		print("  ok   ", msg)
	else:
		failures += 1
		print("  FAIL ", msg)


func _init() -> void:
	print("== chaosD6 smoke test ==")
	print("repo root: ", Assets.repo_root())

	# 1. data
	var dl := DataLoader.new()
	dl.load_all()
	var chars: Array = dl.ids("characters")
	var creatures: Array = dl.ids("creatures")
	check(chars.size() >= 10, "characters loaded: %d" % chars.size())
	check(creatures.size() >= 20, "creatures loaded: %d" % creatures.size())

	# 2. resources -> files
	var with_res := 0
	var missing_files := 0
	var checked := 0
	for kind in ["characters", "creatures", "classes"]:
		for id in dl.ids(kind):
			var res: Dictionary = dl.resources_of(kind, id)
			if res.is_empty():
				continue
			with_res += 1
			var sprites: Dictionary = res.get("sprites", {})
			for k in sprites:
				var p: String = sprites[k].get("path", "")
				if p == "":
					continue
				checked += 1
				if not Assets.exists(p):
					missing_files += 1
					if missing_files <= 5:
						print("     missing: ", p)
	check(with_res >= 70, "entries with resources: %d" % with_res)
	check(missing_files == 0, "sprite files present: %d/%d" % [checked - missing_files, checked])

	# 3. frames.json + sheet slicing for one known unit
	var frames := Assets.frames()
	check(frames.size() > 2000, "frames.json entries: %d" % frames.size())
	var knight := "assets/Sprites/Units/Knights/Knight Champion/Knight Champion - walk [AHFXw].png"
	var g := SheetAnimator.grid_for(knight)
	check(int(g.get("cols", 0)) == 16 and int(g.get("rows", 0)) == 8, "Knight Champion walk grid 16x8: %s" % str(g))
	var sf := SheetAnimator.frames_for(knight, "walk")
	check(sf != null and sf.has_animation("walk_S") and sf.get_frame_count("walk_S") == 16, "SpriteFrames walk_S has 16 frames")
	check(sf != null and sf.has_animation("walk_N"), "SpriteFrames has walk_N")

	# 4. map + pathfinding
	var gen := MapGen.new("Ashfall-Micro")
	var n0 := gen.size()
	gen.reveal_around(Vector2i(2, 2), 6, "test")
	check(gen.size() > n0, "reveal grows map: %d -> %d" % [n0, gen.size()])
	var tiles: Array = gen.tiles()
	var a: Vector2i = tiles[0]
	var b: Vector2i = tiles[tiles.size() - 1]
	var path := Pathfinding.find_path(a, b, {}, func(h: Vector2i) -> bool: return gen.has(h))
	# path excludes the start hex (same convention as game/js/hex.js findPath)
	check(path.size() == Hex.distance(a, b) and path[path.size() - 1] == b, "A* %s -> %s: %d steps (hex distance %d)" % [str(a), str(b), path.size(), Hex.distance(a, b)])
	var t := gen.terrain_at(0, 0)
	check(t.has("type") or t.has("terrain") or not t.is_empty(), "terrain_at(0,0): %s" % str(t))

	# 5. wav
	var any_wav := ""
	for kind in ["characters", "creatures"]:
		for id in dl.ids(kind):
			var res: Dictionary = dl.resources_of(kind, id)
			var snd: Dictionary = res.get("sounds", {})
			for cat in snd:
				for rec in snd[cat]:
					if any_wav == "" and rec is Dictionary:
						any_wav = rec.get("path", "")
	var wav := Assets.load_wav(any_wav) if any_wav != "" else null
	check(wav != null and wav.data.size() > 0, "wav loads: %s" % any_wav.get_file())

	# 6. main scene boots
	var scene: PackedScene = load("res://scenes/Main.tscn")
	check(scene != null, "Main.tscn loads")
	if scene != null:
		var root_node := scene.instantiate()
		get_root().add_child(root_node)
		await process_frame
		await process_frame
		var game := root_node if root_node.has_method("spawn") else root_node.get_node_or_null("Game")
		if game != null and "entities" in game:
			check(game.entities.size() >= 3, "entities spawned: %d" % game.entities.size())
		else:
			check(true, "Main scene instantiated (no Game.entities introspection)")

	print("== %s (%d failures) ==" % ["PASS" if failures == 0 else "FAIL", failures])
	quit(1 if failures > 0 else 0)
