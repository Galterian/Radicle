extends SceneTree
## Boots a dimension, walks the default cast to grow the map, then zooms the camera
## out to fit all revealed hexes and takes a screenshot. Repeat for several dim ids
## to compare biome variety.
##
## Run (needs a display):
##   ../_tools/godot --path . -s tools/overview.gd ++ <dim_id> <steps> <out_png>

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var dim: String = args[0] if args.size() > 0 else "Ashfall-Micro"
	var steps: int = int(args[1]) if args.size() > 1 else 60
	var out_png: String = args[2] if args.size() > 2 else "../_tools/overview.png"
	print("overview dim=%s steps=%d" % [dim, steps])

	var scene: PackedScene = load("res://scenes/Main.tscn")
	var node := scene.instantiate()
	get_root().add_child(node)
	await process_frame
	await process_frame

	# Force the dim: replace gen with a new one and respawn the default cast.
	var dl = node.get("dl")
	for e in node.entities.duplicate():
		e.queue_free()
	node.entities.clear()
	node.gen = MapGen.new(dim)
	node.map.setup(node.gen)
	if node.scatter_layer: node.scatter_layer.setup(node.gen)
	if node.bigfeatures_layer: node.bigfeatures_layer.setup(node.gen)
	node.features_layer.setup(node.gen)
	for s in node.DEFAULT_SPAWN:
		var at: Vector2i = node.gen.nearest_walkable(s.at, 5)
		node.spawn(s.id, s.kind, s.faction, at)
	var player = node.player_entity()
	if player != null:
		node.gen.reveal_around(player.hex, node.REVEAL_RADIUS, "genesis")

	# Wander each entity along a drunkard walk; reveal_around each step.
	var rng := RandomNumberGenerator.new()
	rng.seed = 0xBADC0DE
	var ents = node.entities
	for step in range(steps):
		for e in ents:
			if not e.alive: continue
			# Pick a random walkable neighbour; fall back to any neighbour if all unwalkable.
			var neigh := Hex.neighbours(e.hex)
			neigh.shuffle()
			var picked := Vector2i(e.hex)
			for n in neigh:
				if node.gen.terrain_at(n.x, n.y).walkable:
					picked = n; break
			if picked == e.hex and neigh.size() > 0:
				picked = neigh[0]
			e.hex = picked
			e.position = Hex.hex_to_pixel(picked.x, picked.y)
			node.gen.reveal_around(picked, node.REVEAL_RADIUS, "bot")
		if step % 5 == 0: await process_frame
	node.map.queue_redraw()
	if node.scatter_layer: node.scatter_layer.queue_redraw()
	if node.bigfeatures_layer: node.bigfeatures_layer.queue_redraw()
	node.features_layer.queue_redraw()

	# Fit camera to all revealed hexes.
	var b = node.gen.bounds()
	var tl := Hex.hex_to_pixel(b.min_q - 1, b.min_r - 1)
	var br := Hex.hex_to_pixel(b.max_q + 1, b.max_r + 1)
	var centre := (tl + br) * 0.5
	var viewport := get_root().get_viewport().get_visible_rect().size
	var span_x: float = abs(br.x - tl.x) + 200.0
	var span_y: float = abs(br.y - tl.y) + 200.0
	var zoom := minf(viewport.x / span_x, viewport.y / span_y)
	zoom = clampf(zoom, 0.08, 0.9)
	node.cam.follow = null
	node.cam.position_smoothing_enabled = false
	node.cam.position = centre
	# CameraRig._process lerps zoom back toward its own _target_zoom every frame,
	# so set that too or the overview snaps back to the default 1.0 zoom.
	node.cam._target_zoom = zoom
	node.cam.zoom = Vector2(zoom, zoom)
	for i in range(30): await process_frame

	# Count biomes + features in the revealed region for a stats print.
	var biome_cnt: Dictionary = {}
	for h in node.gen.tiles():
		var b2: String = node.gen.terrain_at(h.x, h.y).type
		biome_cnt[b2] = int(biome_cnt.get(b2, 0)) + 1
	var biomes := biome_cnt.keys(); biomes.sort_custom(func(a, b): return biome_cnt[a] > biome_cnt[b])
	var line := ""
	for k in biomes: line += "%s:%d  " % [k, biome_cnt[k]]
	print("  biomes: " + line)
	# Sub-biome structure: how much of the reveal is lake/sea vs mountain, and how
	# many of the water hexes are *lakes* carved by the lake channel rather than the
	# base elevation sea. Lets a threshold change be judged from the log alone.
	var water_n := int(biome_cnt.get("water", 0))
	var lake_n := 0
	var mount_n := int(biome_cnt.get("mountains", 0))
	var shore_n := int(biome_cnt.get("grass_coast", 0)) + int(biome_cnt.get("snow_coast", 0)) + int(biome_cnt.get("rock_coast", 0))
	var bad_adj := 0
	for h in node.gen.tiles():
		var t: String = node.gen.biome.biome_at(h.x, h.y)
		if t == "water":
			var s = node.gen.biome.sample(h.x, h.y)
			if node.gen.biome.base_biome(s.elev, s.moist, s.temp) != "water":
				lake_n += 1
		if t == "snow" or t == "snow_coast":
			for n in Hex.neighbours(h):
				var nt: String = node.gen.biome.biome_at(n.x, n.y)
				if nt == "jungle" or nt == "marsh":
					bad_adj += 1
	print("  water: %d (lake-carved %d)  mountains: %d  shore: %d  snow<->jungle/marsh edges: %d" % [water_n, lake_n, mount_n, shore_n, bad_adj])
	# Feature breakdown by kind, and big features split into forest (tree/pine/palm/log
	# sprites) vs the rest (boulders, ruins, wrecks).
	var kinds: Dictionary = {}
	for f in node.gen.features_for_known():
		var k: String = f.feature.get("kind", "building")
		kinds[k] = int(kinds.get(k, 0)) + 1
	var kl := ""
	for k in kinds: kl += "%s:%d  " % [k, kinds[k]]
	print("  features: %d  (%s)" % [node.gen.features_for_known().size(), kl.strip_edges()])
	var forest_n := 0
	var bigs: Array = node.gen.bigfeatures_for_known()
	for bf in bigs:
		var lbl: String = str(bf.big_feature.get("label", "")).to_lower()
		if lbl.contains("tree") or lbl.contains("pine") or lbl.contains("palm") or lbl.contains("log"):
			forest_n += 1
	print("  big features: %d  (forest %d, other %d)" % [bigs.size(), forest_n, bigs.size() - forest_n])
	print("  hexes: %d  heat=%+.2f  wet=%+.2f" % [node.gen.size(), node.gen.biome.heat_bias, node.gen.biome.wet_bias])

	var img := get_root().get_viewport().get_texture().get_image()
	img.save_png(out_png)
	print("wrote %s" % out_png)
	quit()
