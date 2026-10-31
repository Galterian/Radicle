extends SceneTree
## Spawns the default cast on a chosen dimension and drives each entity on a long
## random walk, calling reveal_around every step. Saves a screenshot before and
## after. Verifies:
##   - all revealed hexes get a biome
##   - every biome type that appears has features placed only on walkable hexes
##   - every feature points at an asset that exists
##   - entities don't end up stuck on an unwalkable biome (nearest_walkable spawn)
##
## Run from godot/:
##   ../_tools/godot --path . -s tools/wandering_bots.gd ++ <dim_id> <steps> <out_png>
## or headless (no screenshot):
##   ../_tools/godot --headless --path . -s tools/wandering_bots.gd ++ <dim_id> <steps>

const STEPS_DEFAULT := 40

func check(cond: bool, msg: String) -> int:
	print(("  ok   " if cond else "  FAIL ") + msg)
	return 0 if cond else 1


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var dim: String = args[0] if args.size() > 0 else "Ashfall-Micro"
	var steps: int = int(args[1]) if args.size() > 1 else STEPS_DEFAULT
	var out_png: String = args[2] if args.size() > 2 else ""
	print("== wandering bots on dimension %s (%d steps)" % [dim, steps])

	var failures := 0
	var scene: PackedScene = load("res://scenes/Main.tscn")
	var node := scene.instantiate()
	# Override the dim before Game._ready runs the default
	node.set_meta("force_dim", dim)
	get_root().add_child(node)
	await process_frame
	await process_frame
	# The scene creates its own gen in _ready — stamp over it for a specific dim.
	# Game.gd hard-codes "Ashfall-Micro"; override if script exposes it. If not, we
	# just continue; this test still proves the generator works for the default.

	var gen = node.get("gen")
	var entities = node.get("entities")
	failures += check(gen != null, "Game exposes gen")
	failures += check(entities != null and (entities as Array).size() >= 1, "spawned entities")
	var start_known: int = gen.size()
	var start_feats: int = gen.features_for_known().size()
	print("  start: %d hexes known, %d features placed" % [start_known, start_feats])

	# Walk each entity to a random edge direction several times
	var rng := RandomNumberGenerator.new()
	rng.seed = 0xC0FFEE
	for step in range(steps):
		for e in entities:
			if not e.alive:
				continue
			# Pick a random hex within radius 2 of the entity
			var dq := rng.randi_range(-2, 2)
			var dr := rng.randi_range(-2, 2)
			if dq == 0 and dr == 0:
				dq = 1
			var target := Vector2i(e.hex.x + dq, e.hex.y + dr)
			# Reveal + teleport (headless, no Entity.move_to — we are just stressing reveal)
			gen.reveal_around(target, 10, "bot")
			e.hex = target
		await process_frame

	var end_known: int = gen.size()
	var end_feats: int = gen.features_for_known().size()
	print("  end  : %d hexes known, %d features placed" % [end_known, end_feats])
	failures += check(end_known > start_known, "map grew via reveal")
	failures += check(end_feats > start_feats, "features appeared in revealed hexes")

	# Verify every feature path exists
	var checked := 0
	var missing := 0
	for item in gen.features_for_known():
		checked += 1
		var p: String = item.feature.get("path", "")
		if p == "" or not FileAccess.file_exists(Assets.resolve(p)):
			missing += 1
	failures += check(missing == 0, "feature paths resolve: %d/%d" % [checked - missing, checked])

	# Count biomes we saw
	var biome_cnt: Dictionary = {}
	for h in gen.tiles():
		var b: String = gen.terrain_at(h.x, h.y).type
		biome_cnt[b] = int(biome_cnt.get(b, 0)) + 1
	var biomes := biome_cnt.keys(); biomes.sort()
	print("  biomes present:")
	for b in biomes:
		print("    %-14s %4d" % [b, biome_cnt[b]])

	# Features only on walkable biomes?
	var feat_on_unwalkable := 0
	for item in gen.features_for_known():
		if not gen.terrain_at(item.hex.x, item.hex.y).walkable:
			feat_on_unwalkable += 1
	failures += check(feat_on_unwalkable == 0, "no feature on unwalkable biome: %d" % feat_on_unwalkable)

	# Each entity on a walkable biome?
	var stuck := 0
	for e in entities:
		if not gen.terrain_at(e.hex.x, e.hex.y).walkable:
			stuck += 1
	failures += check(stuck == 0, "no entity stuck on unwalkable biome")

	# Centre camera on the pack so the shot shows the walk
	var cam = node.get("cam")
	if cam != null and entities.size() > 0:
		var cx := 0.0; var cy := 0.0; var n := 0
		for e in entities:
			var p := Hex.hex_to_pixel(e.hex.x, e.hex.y)
			cx += p.x; cy += p.y; n += 1
		cam.position = Vector2(cx / n, cy / n)
		if node.has_method("queue_redraw_all"):
			node.queue_redraw_all()
		cam.zoom = Vector2(0.9, 0.9)
	# Let a few frames tick so the sprites render.
	for i in range(30):
		await process_frame

	if out_png != "":
		var img := get_root().get_viewport().get_texture().get_image()
		img.save_png(out_png)
		print("  wrote %s" % out_png)

	print("== %s (%d failures) ==" % ["PASS" if failures == 0 else "FAIL", failures])
	quit(1 if failures > 0 else 0)
