class_name Game
extends Node2D
## Main scene controller: loads data/*.json, generates the known hex map, spawns entities
## and runs the chaosD6 round loop (planning 6 s -> reveal -> resolution) with the same
## resolution semantics as the Node peer (peer.mjs): move pass with priority & collision
## veto, then damage pass over the A>P>M>B>A matrix with adversarial Empty cards.

const PLAN_SECONDS := 6.0
const REVEAL_SECONDS := 0.8
const EM_MAX_STEPS := 3
const REVEAL_RADIUS := 6
const HAND_SIZE := 5
const EP_MAP := {"A": "P", "P": "M", "M": "EP", "B": "EP"}
const EM_MAP := {"A": "EM", "P": "EM", "M": "EM", "B": "M"}
const MOVE_PRIORITY := {"A": 3, "M": 2, "EM": 1}
const ELEMENT_FX := {
	"elem_fire": "effect_inner_fire", "elem_water": "effect_ice_blast", "elem_air": "effect_elementals_air",
	"elem_earth": "effect_elementals_earth", "elem_vitality": "effect_nature_embrace", "elem_souls": "effect_drain",
	"elem_time": "effect_delay_time", "elem_space": "effect_space_bending", "elem_concentration": "effect_super_sense",
	"elem_harmony": "effect_aura",
}
## Fallback WBC3 sheets used when data/*.json has no `resources` block for an entity.
## Summoned creatures (mon_golem_* / mon_elemental_*) are injected at runtime by
## peer.mjs' BUILT_IN_CREATURES table and never land in data/creatures.json, so
## without an entry here they spawn as the coloured oval + silent sheet.
const FALLBACK_SHEETS := {
	"char_exuberant_firestroker": {"base": "assets/Sprites/Units/Empire/Red Mage/Red Mage - ", "code": "AHGR", "cast": true},
	"char_pride_guardian": {"base": "assets/Sprites/Units/Knights/Knight Lord/Knight Lord - ", "code": "AHEX"},
	"mon_ruinous_minotaur": {"base": "assets/Sprites/Units/Minotaurs/Minotaur/Minotaur - ", "code": "AMIX"},
	"mon_ridge_runnet_3a": {"base": "assets/Sprites/Units/Daemons/Imp/Imp - ", "code": "AAIM"},
	# Golems — WBC3 has 3 variants; the fourth (Living Golem) reuses Stone.
	"mon_golem_worldlives": {"base": "assets/Sprites/Units/Dark Dwarves/Stone Golem/Stone Golem - ", "code": "AAIX"},
	"mon_golem_lifematters": {"base": "assets/Sprites/Units/Dark Dwarves/Bronze Golem/Bronze Golem - ", "code": "AAGX", "cast": true},
	"mon_golem_worldmatters": {"base": "assets/Sprites/Units/Dark Dwarves/Iron Golem/Iron Golem - ", "code": "AAJX"},
	"mon_golem_living": {"base": "assets/Sprites/Units/Dark Dwarves/Stone Golem/Stone Golem - ", "code": "AAIX"},
	# Elementals — one WBC3 unit per element, matched to the dominant stat.
	"mon_elemental_world": {"base": "assets/Sprites/Units/Temples/Earth Elemental/Earth Elemental - ", "code": "AAEE"},
	"mon_elemental_vital": {"base": "assets/Sprites/Units/Temples/Water Elemental/Water Elemental - ", "code": "AAEW"},
	"mon_elemental_matter": {"base": "assets/Sprites/Units/Temples/Air Elemental/Air Elemental - ", "code": "AAEA"},
}
const DEFAULT_SPAWN := [
	{"id": "char_exuberant_firestroker", "kind": "characters", "faction": "player", "at": Vector2i(2, 2)},
	{"id": "char_pride_guardian", "kind": "characters", "faction": "ally", "at": Vector2i(1, 3)},
	{"id": "mon_ruinous_minotaur", "kind": "creatures", "faction": "npc", "at": Vector2i(4, 0)},
	{"id": "mon_ridge_runnet_3a", "kind": "creatures", "faction": "npc", "at": Vector2i(0, 4)},
]

var dl := DataLoader.new()
var gen: MapGen
var map: HexMap
var scatter_layer: ScatterLayer
var bigfeatures_layer: BigFeatureLayer
var features_layer: FeatureLayer
var ents_root: Node2D
var fx: FxPlayer
var cam: CameraRig
var hud: Hud
var net: NetBridge

var entities: Array[Entity] = []
var round_no := 1
var phase := "planning"
var phase_t := 0.0
var edges: Dictionary = {}
var rng := RandomNumberGenerator.new()

# player planning state
var hand: Array = []
var chosen := -1
var target_hex: Variant = null
var locked := false
var discarded := false
var intents: Dictionary = {}   # entity id -> {code, target(Vector2i|null)}
var quiet_rounds := 0
var _resolving := false

# Mobile "journey" state: a multi-round movement plan set by double-tapping a
# far hex. Each planning phase auto-picks M (or EM) targeting the next step;
# any manual card pick or target change cancels. If the double-tapped hex
# holds an enemy, we walk to the nearest adjacent approach and auto-pick A
# on arrival. _clear_journey() is the single reset path.
var _journey_path: Array = []        # Array[Vector2i] — remaining hexes to walk
var _journey_dest: Vector2i = Vector2i.ZERO
var _journey_attack: bool = false    # auto-A at destination (enemy was tapped)

# Channeling (Blizzard et al): once a `channeling`-tagged card commits, re-pick
# the same slot every planning phase until the channel is interrupted. The full
# "temp perm + enemy destroy" rule lives in peer.mjs; the solo sim only tracks
# the resume/interrupt flow so the HUD and audio stay honest.
var _channel_card: String = ""
var _channel_interrupted: bool = false
var _channel_target: Variant = null  # last target_hex when the channel started


func _ready() -> void:
	rng.randomize()
	dl.load_all()
	edges = dl.resolution_edges()
	gen = MapGen.new("Ashfall-Micro")

	map = HexMap.new()
	map.name = "HexMap"
	add_child(map)
	map.setup(gen)
	map.hex_clicked.connect(_on_hex_clicked)
	map.hex_hovered.connect(_on_hex_hovered)
	map.hex_double_tapped.connect(_on_hex_double_tapped)

	# Decorative scatter (grass tufts, boulders, dead trees, flowers — "bonus"
	# WBC3 terrain-features borrowed from the extracted archive). Lives above the
	# terrain and below buildings. Breaks up uniform biome regions so transitions
	# read as smooth rather than hard-edged.
	scatter_layer = ScatterLayer.new()
	scatter_layer.name = "Scatter"
	add_child(scatter_layer)
	scatter_layer.setup(gen)

	# Rare "big feature" landmarks (large forest clusters, pine stands, cactus
	# clumps, boulder piles, ruins) spanning ~2 hex widths visually. These are the
	# WBC3-style anchors that keep a biome strip from feeling repetitive. Lives
	# between the small scatter (z=3) and the buildings (z=5).
	bigfeatures_layer = BigFeatureLayer.new()
	bigfeatures_layer.name = "BigFeatures"
	add_child(bigfeatures_layer)
	bigfeatures_layer.setup(gen)

	# Buildings / permanents on walkable biome hexes. Lives above the terrain
	# (HexMap) and below entities. Deterministic from (dim_seed, q, r), so every
	# new reveal fills in with the right features automatically.
	features_layer = FeatureLayer.new()
	features_layer.name = "Features"
	add_child(features_layer)
	features_layer.setup(gen)

	ents_root = Node2D.new()
	ents_root.name = "Entities"
	ents_root.y_sort_enabled = true
	ents_root.z_index = 10
	add_child(ents_root)

	fx = FxPlayer.new()
	fx.name = "Fx"
	fx.setup(dl)
	add_child(fx)

	cam = CameraRig.new()
	cam.name = "Camera"
	add_child(cam)
	cam.make_current()

	hud = Hud.new()
	hud.name = "Hud"
	hud.dl = dl
	add_child(hud)
	hud.slot_pressed.connect(_pick_slot)
	hud.lock_pressed.connect(_lock)
	hud.destroy_perm_requested.connect(_on_destroy_perm_requested)
	hud.entity_activated.connect(_on_hud_entity_activated)
	if hud.has_signal("stat_tapped"):
		hud.stat_tapped.connect(_on_hud_stat_tapped)
	if hud.has_signal("class_ability_pressed"):
		hud.class_ability_pressed.connect(_on_hud_class_ability_pressed)

	# Touch gesture router. Attached as a child of Main so it sits alongside the
	# camera and hex map in the input chain. On desktop its handlers never fire
	# (no touch events arrive), so there's no cost to keeping it instantiated.
	var mobile_input := MobileInput.new()
	mobile_input.name = "MobileInput"
	add_child(mobile_input)
	cam.attach_mobile_input(mobile_input)
	map.attach_mobile_input(mobile_input)
	hud.attach_mobile_input(mobile_input)

	net = NetBridge.new()
	net.name = "Net"
	add_child(net)
	# When a peer URL is set the bridge connects to game/peer.mjs' WebSocket:
	# the Node peer is the deterministic sim and we observe its state so the
	# roster, perm power badges and destroy intents all stay in sync with the
	# browser client's view (Task 13 parity).
	net.hello_received.connect(_on_net_hello)
	net.hand_received.connect(_on_net_hand)
	net.peers_received.connect(_on_net_peers)
	net.phase_received.connect(_on_net_phase)
	net.evt_received.connect(_on_net_evt)
	net.peek_received.connect(_on_net_peek)
	net.radicle_received.connect(_on_net_radicle)
	net.connected.connect(func(): hud.log_line("peer: connected", Color(0.6, 0.9, 0.6)))
	net.disconnected.connect(func(): hud.log_line("peer: disconnected", Color(0.9, 0.6, 0.6)))

	# Spawn: default roster first, snapped to nearest walkable hex (otherwise a
	# player spawning on a lava or water biome can't move).
	for s in DEFAULT_SPAWN:
		var at: Vector2i = gen.nearest_walkable(s.at, 5)
		spawn(s.id, s.kind, s.faction, at)
	# When DimensionLauncher has resolved a join request before Main.tscn
	# loaded (the mobile picker UI stashes it on the autoload), we move the
	# player entity to the resolved spawn hex and switch its faction to the
	# chosen door's alliance so we land as an ally of that peer right next
	# to their unit — matches the user's "join nearby chosen unit" ask.
	if typeof(DimensionLauncher) == TYPE_OBJECT and "pending_join" in DimensionLauncher:
		var pj: Variant = DimensionLauncher.pending_join
		if typeof(pj) == TYPE_DICTIONARY and pj.has("spawn_hex"):
			var player := player_entity()
			if player != null:
				var hex: Vector2i = pj.spawn_hex
				var landing: Vector2i = gen.nearest_walkable(hex, 5)
				player.teleport(landing)
				var alliance_raw: Variant = pj.get("alliance", "player")
				var alliance: String = String(alliance_raw)
				if alliance != "" and alliance != "player":
					# Mirror peer.mjs: "ally of this peer" = same alliance string
					# so the resolver's friend/foe check treats us as their side.
					player.faction = alliance
				hud.log_line("joined dimension %s as %s near %s" % [
					String(pj.get("dim_name", "?")), alliance, Hex.key_of(landing)
				], Color(0.65, 0.95, 0.75))
			# One-shot — clear the pending join so a subsequent scene reload
			# doesn't re-teleport.
			DimensionLauncher.pending_join = {}
	var p := player_entity()
	if p != null:
		gen.reveal_around(p.hex, REVEAL_RADIUS, "genesis")
		map.queue_redraw(); if scatter_layer: scatter_layer.queue_redraw(); if bigfeatures_layer: bigfeatures_layer.queue_redraw(); if features_layer: features_layer.queue_redraw()
		hud.set_entity(p)
		cam.follow = p
		cam.position = p.position
	hud.log_line("chaosD6 · dimension Ashfall-Micro · seed %s · %d hexes known" % [gen.seed_hex, gen.size()], Color(0.9, 0.75, 0.5))
	hud.log_line("Data: %d characters, %d creatures, %d effects loaded from data/*.json" % [dl.ids("characters").size(), dl.ids("creatures").size(), dl.ids("effects").size()])
	hud.set_roster(entities)
	_begin_planning()
	_push_status()


# ------------------------------------------------------------------ entities

func spawn(id: String, kind: String, faction: String, at: Vector2i) -> Entity:
	var e := Entity.new()
	e.name = id
	var fallback := {}
	if FALLBACK_SHEETS.has(id):
		var fb: Dictionary = FALLBACK_SHEETS[id]
		fallback = {
			"idle": "%s%s [%s].png" % [fb.base, "idle", fb.code],
			"walk": "%s%s [%s%s].png" % [fb.base, "walk", fb.code, "w"],
			"attack": "%s%s [%s%s].png" % [fb.base, "attack", fb.code, "a"],
			"death": "%s%s [%s%s].png" % [fb.base, "death", fb.code, "d"],
			"fidget": "%s%s [%s%s].png" % [fb.base, "fidget", fb.code, "f"],
		}
		if fb.get("cast", false):
			fallback["cast"] = "%s%s [%s%s].png" % [fb.base, "cast", fb.code, "c"]
	if not gen.has(at):
		gen.reveal_around(at, 2, "spawn")
	ents_root.add_child(e)
	e.setup(id, kind, dl, at, faction, fallback)
	e.died.connect(_on_died)
	entities.append(e)
	return e


func player_entity() -> Entity:
	for e in entities:
		if e.faction == "player" and e.alive:
			return e
	return null


func entity_at(h: Vector2i) -> Entity:
	for e in entities:
		if e.alive and e.hex == h:
			return e
	return null


func blocked_map(except: Entity = null) -> Dictionary:
	var b := {}
	for e in entities:
		if e.alive and e != except:
			b[Hex.key_of(e.hex)] = true
	# Unwalkable biomes (water, lava, mountains, cliffs) are impassable for the
	# pathfinder. The biome sampler is pure (seed, q, r), so this stays consistent
	# as the map grows via reveal_around.
	# Labyrinth walls (Features.gd#_labyrinth_wall_at — parity mirror of
	# features.js#labyrinthWallAt) are static impassable scenery owned by nobody.
	# Pure (seed, q, r), so same hexes are blocked on every peer.
	for h in gen.tiles():
		if not gen.terrain_at(h.x, h.y).walkable:
			b[Hex.key_of(h)] = true
		elif gen.features != null and gen.features.is_labyrinth_wall(h.x, h.y, gen.biome):
			b[Hex.key_of(h)] = true
	return b


func is_enemy(a: Entity, b: Entity) -> bool:
	var fa := "npc" if a.faction == "npc" else "player"
	var fb := "npc" if b.faction == "npc" else "player"
	return fa != fb


# ------------------------------------------------------------------ round loop

func _process(dt: float) -> void:
	phase_t += dt
	match phase:
		"planning":
			hud.set_phase("round %d · planning %.1fs" % [round_no, maxf(0.0, PLAN_SECONDS - phase_t)], 1.0 - phase_t / PLAN_SECONDS)
			if phase_t >= PLAN_SECONDS or locked:
				_begin_reveal()
		"reveal":
			hud.set_phase("round %d · reveal" % round_no, 1.0)
			if phase_t >= REVEAL_SECONDS and not _resolving:
				_resolve()
		"resolution":
			hud.set_phase("round %d · resolution" % round_no, 1.0)
		"over":
			hud.set_phase("dimension collapsed · press C", 0.0)


func _begin_planning() -> void:
	phase = "planning"
	phase_t = 0.0
	locked = false
	discarded = false
	chosen = -1
	target_hex = null
	intents.clear()
	map.path_preview = []
	# Journey preview is drawn from map.selected; after a resolution move the
	# hero stands on a new hex, so re-anchor selected before anything redraws
	# or the dashed journey line origins stay on the previous tile.
	var _pb := player_entity()
	if _pb != null:
		map.selected = _pb.hex
	_deal_hand()
	_update_reach()
	_refresh_hand()
	var p := player_entity()
	if p != null:
		hud.update_life(p)
	# Life totals change between rounds (damage pass); keep roster in sync.
	hud.set_roster(entities)
	_push_status()
	# A live channel takes precedence over a journey: find the same card in the
	# fresh hand and auto-pick it. If the deck didn't deal it, the channel breaks
	# (matches peer.mjs: lose the component → channel ends).
	if _channel_card != "":
		var slot := _find_card_slot([_channel_card])
		if slot >= 0:
			_auto_pick(slot, _channel_target)
			hud.log_line("channel continues (round %d)" % round_no, Color(0.65, 0.8, 0.95))
		else:
			hud.log_line("channel broken", Color(0.8, 0.55, 0.4))
			_channel_interrupted = true
			_channel_card = ""
			_channel_target = null
			if hud.has_method("set_channel_label"):
				hud.set_channel_label("")
	# Resume a queued journey (auto-pick M + next step) BEFORE the mobile hint
	# so the hint reflects the auto-picked state rather than the fresh deal.
	_journey_resume()
	_push_mobile_hint()
	_push_mobile_piles()


func _begin_reveal() -> void:
	phase = "reveal"
	phase_t = 0.0
	var p := player_entity()
	if p != null:
		var code := "EP"
		var tgt = null
		if chosen >= 0 and chosen < hand.size():
			code = str(hand[chosen])
			tgt = target_hex
		intents[p.id] = {"code": code, "target": tgt}
	for e in entities:
		if e.alive and e != p:
			intents[e.id] = _npc_plan(e)
	var reveal_list := []
	for k in intents.keys():
		reveal_list.append({"entity": k, "code": intents[k].code, "target": str(intents[k].target)})
	_push_status()
	_push_mobile_hint()
	net.reveal(round_no, reveal_list, "")
	for k in intents.keys():
		var e := _find(k)
		if e != null:
			var t: String = (" → %s" % Hex.key_of(intents[k].target)) if intents[k].target != null else ""
			hud.log_line("%s reveals %s%s" % [e.display_name, intents[k].code, t], Color(0.75, 0.75, 0.8) if e.faction == "npc" else Color(0.9, 0.85, 0.7))
	map.reach = {}
	map.queue_redraw(); if scatter_layer: scatter_layer.queue_redraw(); if bigfeatures_layer: bigfeatures_layer.queue_redraw(); if features_layer: features_layer.queue_redraw()


func _npc_plan(e: Entity) -> Dictionary:
	var foe := _nearest_enemy(e)
	if foe == null:
		return {"code": "EP", "target": null}
	var d := Hex.distance(e.hex, foe.hex)
	var r := rng.randf()
	# If the hex-distance says "adjacent" but the foe sits across a labyrinth
	# wall / unwalkable biome, A would move 1 step into the wall and swing at
	# nothing. Downgrade to P so the NPC doesn't waste the round.
	var reachable := not Pathfinding.find_path(e.hex, foe.hex, blocked_map(e), func(h): return gen.has(h)).is_empty()
	if d <= 1:
		if not reachable:
			return {"code": "P", "target": null}
		if r < 0.6:
			return {"code": "A", "target": foe.hex}
		if r < 0.8:
			return {"code": "B", "target": null}
		return {"code": "P", "target": foe.hex}
	# Any mover branch below needs a traversable path; otherwise cast defensively.
	if not reachable:
		return {"code": "P", "target": null}
	if d >= 4 and r < 0.6:
		return {"code": "EM", "target": foe.hex}
	if r < 0.75:
		return {"code": "M", "target": foe.hex}
	if r < 0.9:
		return {"code": "A", "target": foe.hex}  # A with a tile target = 1 step
	return {"code": "P", "target": null}


func _nearest_enemy(e: Entity) -> Entity:
	var best: Entity = null
	var bd := 1 << 30
	for o in entities:
		if o.alive and o != e and is_enemy(e, o):
			var d := Hex.distance(e.hex, o.hex)
			if d < bd:
				bd = d
				best = o
	return best


func _find(id: String) -> Entity:
	for e in entities:
		if e.id == id:
			return e
	return null


func _resolve() -> void:
	_resolving = true
	phase = "resolution"
	phase_t = 0.0
	# ---- move pass: priority A3 > M2 > EM1, collision veto, one entity per hex.
	var movers: Array = []
	for id in intents.keys():
		var e := _find(id)
		var it: Dictionary = intents[id]
		if e == null or not e.alive:
			continue
		if it.code in ["M", "EM", "A"] and it.target != null:
			movers.append([e, it])
	movers.sort_custom(func(a, b):
		var pa: int = MOVE_PRIORITY.get(a[1].code, 0)
		var pb: int = MOVE_PRIORITY.get(b[1].code, 0)
		return pa > pb if pa != pb else a[0].id < b[0].id)
	var claimed := {}
	for e in entities:
		if e.alive:
			claimed[Hex.key_of(e.hex)] = e
	var moves: Array = []  # [entity, steps]
	for m in movers:
		var e: Entity = m[0]
		var it: Dictionary = m[1]
		var tgt: Vector2i = it.target
		if e.hex == tgt:
			continue
		var d := Hex.distance(e.hex, tgt)
		var budget := 1
		if it.code == "EM":
			budget = mini(EM_MAX_STEPS, maxi(1, roundi(d / 2.0)))
		# Use blocked_map so unwalkable biomes (water / lava / mountains / cliffs)
		# join labyrinth walls and other entities in the pathfinder's blocked set.
		# The inline build used to skip biomes, letting NPCs path through water.
		var blocked := blocked_map(e)
		# Overlay `claimed` so same-round movers that already claimed a dest
		# this pass don't collide; earlier claims shouldn't be re-used.
		for k in claimed.keys():
			if claimed[k] != e:
				blocked[k] = true
		var path := Pathfinding.find_path(e.hex, tgt, blocked, func(h): return gen.has(h))
		if path.is_empty():
			hud.log_line("%s cannot reach %s" % [e.display_name, Hex.key_of(tgt)], Color(0.6, 0.6, 0.6))
			continue
		var steps: Array[Vector2i] = []
		for i in range(mini(budget, path.size())):
			steps.append(path[i])
		# veto if the final hex is already claimed by someone else
		var dest := steps[steps.size() - 1]
		if claimed.has(Hex.key_of(dest)) and claimed[Hex.key_of(dest)] != e:
			hud.log_line("%s's move is vetoed (collision at %s)" % [e.display_name, Hex.key_of(dest)], Color(0.8, 0.6, 0.4))
			continue
		claimed.erase(Hex.key_of(e.hex))
		claimed[Hex.key_of(dest)] = e
		moves.append([e, steps])
	var pending := [moves.size()]
	for m in moves:
		var e: Entity = m[0]
		e.arrived.connect(func(): pending[0] -= 1, CONNECT_ONE_SHOT)
		e.play_sound("order")
		e.move_along(m[1])
	var guard := 0.0
	while pending[0] > 0 and guard < 6.0:
		guard += get_process_delta_time()
		await get_tree().process_frame
	# reveal fog around the player after moving
	var p := player_entity()
	if p != null:
		var b := gen.reveal_around(p.hex, REVEAL_RADIUS, net.peer_id)
		if not b.is_empty():
			net.publish_block(b)
			hud.log_line("map grows: %s (+%d hexes known)" % [b.id, gen.size()], Color(0.6, 0.8, 0.9))
			map.queue_redraw(); if scatter_layer: scatter_layer.queue_redraw(); if bigfeatures_layer: bigfeatures_layer.queue_redraw(); if features_layer: features_layer.queue_redraw()
			_push_status()

	# ---- posture / cast visuals (P) — no damage, shows the adept element effect.
	for id in intents.keys():
		var e := _find(id)
		if e == null or not e.alive or intents[id].code != "P":
			continue
		var tgt: Vector2i = intents[id].target if intents[id].target != null else e.hex
		e.cast(tgt)
		fx.play_effect(_posture_effect(e), e.hex, true)
	# ---- block visuals
	for id in intents.keys():
		var e := _find(id)
		if e != null and e.alive and intents[id].code == "B":
			fx.play_effect("effect_shield", e.hex, true)

	# ---- damage pass: A against an adjacent target after moves.
	var any_damage := false
	var attackers: Array = []
	for id in intents.keys():
		var e := _find(id)
		if e != null and e.alive and intents[id].code == "A":
			attackers.append(e)
	attackers.sort_custom(func(a, b): return a.id < b.id)
	var damage: Dictionary = {}   # entity id -> int
	var strikes: Array = []
	for a in attackers:
		var it: Dictionary = intents[a.id]
		var tgt_e: Entity = null
		if it.target != null:
			tgt_e = entity_at(it.target)
		if tgt_e == null or tgt_e == a:
			tgt_e = _adjacent_enemy(a)
		if tgt_e == null or Hex.distance(a.hex, tgt_e.hex) != 1:
			hud.log_line("%s swings at nothing" % a.display_name, Color(0.6, 0.6, 0.6))
			continue
		# Defence: if either hex went unwalkable mid-round (shouldn't happen with
		# the pure biome sampler, but belt-and-braces for future dynamic terrain),
		# skip the swing rather than ignore the geometry.
		if not gen.terrain_at(a.hex.x, a.hex.y).walkable or not gen.terrain_at(tgt_e.hex.x, tgt_e.hex.y).walkable:
			hud.log_line("%s · terrain blocks the swing" % a.display_name, Color(0.6, 0.6, 0.6))
			continue
		var dcode := "EP"
		if intents.has(tgt_e.id):
			dcode = str(intents[tgt_e.id].code)
		var eff := dcode
		if dcode == "EP":
			eff = EP_MAP.get("A", "EP")
		elif dcode == "EM":
			eff = EM_MAP.get("A", "EM")
		var bonus := int(edges.get("A|%s" % eff, 0))
		var dmg := maxi(0, 1 + bonus)
		damage[tgt_e.id] = damage.get(tgt_e.id, 0) + dmg
		strikes.append([a, tgt_e, dmg, eff])
		if dcode == "B":
			damage[a.id] = damage.get(a.id, 0) + 1   # Block reflects 1 to each attacker
			strikes.append([tgt_e, a, 1, "reflect"])
	for s in strikes:
		var a: Entity = s[0]
		var t: Entity = s[1]
		if s[3] != "reflect":
			a.attack(t)
			a.play_sound("fx")
	if not strikes.is_empty():
		await get_tree().create_timer(0.45).timeout
	for s in strikes:
		var a: Entity = s[0]
		var t: Entity = s[1]
		var dmg: int = s[2]
		var col := Color(1.0, 0.35, 0.3) if dmg > 0 else Color(0.7, 0.7, 0.7)
		fx.float_text(t.position, ("-%d" % dmg) if dmg > 0 else "0", col)
		if s[3] == "reflect":
			hud.log_line("%s's Block reflects 1 to %s" % [a.display_name, t.display_name], Color(0.5, 0.7, 0.95))
		else:
			hud.log_line("%s attacks %s (vs %s): %d" % [a.display_name, t.display_name, s[3], dmg], Color(0.95, 0.7, 0.55))
	for id in damage.keys():
		var e := _find(id)
		if e != null and e.alive and damage[id] > 0:
			any_damage = true
			var killer := _attacker_of(id, strikes)
			e.take_damage(damage[id])
			if not e.alive and killer != null:
				killer.play_sound("deathblow")
				hud.log_line("%s falls." % e.display_name, Color(0.95, 0.4, 0.35))
	if damage.is_empty() and moves.is_empty():
		quiet_rounds += 1
		if quiet_rounds >= 3:
			hud.log_line("standoff · %d quiet rounds" % quiet_rounds, Color(0.6, 0.6, 0.6))
	else:
		quiet_rounds = 0

	await get_tree().create_timer(0.6).timeout
	_resolving = false
	round_no += 1
	_push_status()
	_push_mobile_hint()
	net.publish_state(_state())
	if player_entity() == null:
		phase = "over"
		hud.log_line("Your character has fallen. The dimension collapses.", Color(0.95, 0.5, 0.4))
		return
	if _nearest_enemy(player_entity()) == null:
		hud.log_line("All hostiles cleared — the dimension is yours.", Color(0.6, 0.95, 0.6))
	# Channel bookkeeping: an interrupted channel clears before the next deal;
	# an uninterrupted one survives into _begin_planning for the auto-pick.
	if _channel_card != "" and _channel_interrupted:
		hud.log_line("channel broken", Color(0.8, 0.55, 0.4))
		_channel_card = ""
		_channel_interrupted = false
		_channel_target = null
		if hud.has_method("set_channel_label"):
			hud.set_channel_label("")
	_begin_planning()


func _attacker_of(victim_id: String, strikes: Array) -> Entity:
	for s in strikes:
		if s[1].id == victim_id and s[2] > 0:
			return s[0]
	return null


func _adjacent_enemy(e: Entity) -> Entity:
	for n in Hex.neighbours(e.hex):
		var o := entity_at(n)
		if o != null and is_enemy(e, o):
			return o
	return null


func _posture_effect(e: Entity) -> String:
	if e.kind == "creatures" and e.data.has("innate_effect") and dl.get_entry("effects", str(e.data.innate_effect)).size() > 0:
		return str(e.data.innate_effect)
	var el := str(e.data.get("adept_element", ""))
	return ELEMENT_FX.get(el, "effect_empower")


func _state() -> Dictionary:
	var ents := []
	for e in entities:
		ents.append({"id": e.id, "q": e.hex.x, "r": e.hex.y, "life": e.life, "alive": e.alive, "faction": e.faction})
	return {"round": round_no, "dimension": net.dimension_id, "seed": gen.seed_hex, "entities": ents}


func _on_died(e: Entity) -> void:
	if e.faction == "player":
		hud.update_life(e)
	# Roster reflects alive/dead state and life totals, so refresh on every death.
	hud.set_roster(entities)


# ------------------------------------------------------------------ player input

func _deal_hand() -> void:
	var p := player_entity()
	hand = []
	if p == null:
		return
	var pool: Array = ["A", "B", "M", "P"]
	for i in range(HAND_SIZE - 1):
		# bias toward the character's combo (its signature cards)
		if rng.randf() < 0.5 and not p.combo.is_empty():
			hand.append(str(p.combo[rng.randi_range(0, p.combo.size() - 1)]))
		else:
			hand.append(pool[rng.randi_range(0, pool.size() - 1)])
	hand.append("EM" if rng.randf() < 0.5 else "EP")
	hand.shuffle()
	_push_status()


func _refresh_hand() -> void:
	var targets := {}
	if chosen >= 0 and target_hex != null:
		targets[chosen] = Hex.key_of(target_hex)
	hud.set_hand(hand, chosen, locked, targets)


# Guarded: parallel Hud.gd work may not have landed yet, so skip silently
# when set_status / set_mobile_hint aren't on the HUD.
func _push_status() -> void:
	if hud == null or not hud.has_method("set_status"):
		return
	# MapGen has no `name` field; the dimension string lives on NetBridge after
	# hello, with the generator's constructor literal as the solo-play fallback.
	var dim := "Ashfall-Micro"
	if net != null and net.dimension_id != "":
		dim = net.dimension_id
	var hex_count := 0
	if gen != null:
		hex_count = gen.size()
	hud.set_status(round_no, dim, hand.size(), hex_count)


## Mobile only. Pushes the compact pile row (arch / deck / disc) and the perms
## row above the hand bar. Solo play has no real deck/discard so we fall back
## to hand size + a dash; a connected peer's `hand` message overrides via
## _on_net_hand. Perms come from the local player's entity data.
func _push_mobile_piles() -> void:
	if hud == null:
		return
	var is_mobile := OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")
	if not is_mobile:
		return
	var archive_n := 0
	var deck_n := hand.size()
	var discard_n := 0
	var at_min := false
	if hud.has_method("server_hand"):
		var sh: Dictionary = hud.server_hand()
		if not sh.is_empty():
			archive_n = int(sh.get("archiveLeft", sh.get("archive", 0)))
			deck_n = int(sh.get("deckLeft", sh.get("deck", deck_n)))
			discard_n = int(sh.get("discardLeft", sh.get("discard", 0)))
			at_min = bool(sh.get("circulatingAtMin", false))
	if hud.has_method("set_mobile_piles"):
		hud.set_mobile_piles(archive_n, deck_n, discard_n, at_min)
	var p := player_entity()
	var codes: Array = []
	if p != null:
		var perms: Variant = p.data.get("permanents", [])
		if typeof(perms) == TYPE_ARRAY:
			for pm in perms:
				codes.append(str(pm))
	if hud.has_method("set_mobile_perms"):
		hud.set_mobile_perms(codes)
	# Q class-ability button is live iff the player's permanents include a
	# `class_*` card (parity with the browser's Q keypress gate).
	if hud.has_method("set_class_ability_available"):
		var has_class := false
		for c in codes:
			if str(c).begins_with("class_"):
				has_class = true
				break
		hud.set_class_ability_available(has_class)


## Mobile roster tap handler. Finds the entity by id and makes it the HUD's
## active one (portrait + quote) plus centres the camera on it. The player's
## faction stays whatever it is — this is a view switch, not a possession.
func _on_hud_entity_activated(entity_id: String) -> void:
	for e in entities:
		if e.id == entity_id and e.alive:
			hud.set_entity(e)
			if cam != null:
				cam.follow = e
			e.play_sound("select")
			return


func _push_mobile_hint() -> void:
	if hud == null or not hud.has_method("set_mobile_hint"):
		return
	var is_mobile := OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")
	if not is_mobile:
		hud.set_mobile_hint("")
		return
	if phase == "planning" and chosen == -1 and not locked:
		hud.set_mobile_hint("Tap a card then tap a hex. Or tap a neighbour hex to auto-move.")
	else:
		hud.set_mobile_hint("")


func _update_reach() -> void:
	map.reach = {}
	var p := player_entity()
	if p == null or chosen < 0:
		map.queue_redraw(); if scatter_layer: scatter_layer.queue_redraw(); if bigfeatures_layer: bigfeatures_layer.queue_redraw(); if features_layer: features_layer.queue_redraw()
		return
	var code := str(hand[chosen])
	var radius := 0
	if code == "M" or code == "A":
		radius = 1
	elif code == "EM":
		radius = EM_MAX_STEPS
	if radius > 0:
		for t in MapGen.block_tiles({"kind": "disc", "q": p.hex.x, "r": p.hex.y, "radius": radius}):
			if gen.has(t) and t != p.hex:
				map.reach[Hex.key_of(t)] = true
	map.queue_redraw(); if scatter_layer: scatter_layer.queue_redraw(); if bigfeatures_layer: bigfeatures_layer.queue_redraw(); if features_layer: features_layer.queue_redraw()


func _pick_slot(i: int) -> void:
	if phase != "planning" or locked or i < 0 or i >= hand.size():
		return
	_clear_journey("manual card pick")
	chosen = i
	target_hex = null
	map.path_preview = []
	var p := player_entity()
	if p != null:
		p.play_sound("select")
		hud.set_quote(p.quote_for("select"))
	_update_reach()
	_refresh_hand()
	_push_mobile_hint()


# Internal variant of _pick_slot that does NOT clear the journey — used by the
# double-tap handler and _journey_resume so the auto-plan survives the pick.
func _auto_pick(slot: int, target: Variant) -> void:
	if slot < 0 or slot >= hand.size() or phase != "planning" or locked:
		return
	chosen = slot
	target_hex = target
	var p := player_entity()
	if p != null:
		p.play_sound("select")
	_update_reach()
	_refresh_hand()
	_push_mobile_hint()


func _channel_label_text(code: String) -> String:
	# Short "<Name> ch." for the status-strip channel indicator. Falls back to
	# the raw code if the data entry can't be resolved.
	if dl == null:
		return "%s ch." % code
	var kind := ""
	if code.begins_with("effect_"):
		kind = "effects"
	elif code.begins_with("skill_"):
		kind = "skills"
	if kind == "":
		return "%s ch." % code
	var entry: Dictionary = dl.get_entry(kind, code)
	var name := String(entry.get("name", code))
	return "%s ch." % name


func _find_card_slot(codes: Array) -> int:
	for code in codes:
		for i in range(hand.size()):
			if str(hand[i]) == code:
				return i
	return -1


func _clear_journey(reason: String) -> void:
	if _journey_path.is_empty() and not _journey_attack:
		return
	_journey_path = []
	_journey_attack = false
	if map != null:
		map.path_preview = []
	if reason != "" and hud != null:
		hud.log_line("journey cleared: %s" % reason, Color(0.75, 0.7, 0.5))


func _on_hex_double_tapped(h: Vector2i) -> void:
	if phase != "planning" or locked or not gen.has(h):
		return
	var p := player_entity()
	if p == null:
		return
	# Adjacent enemy → auto-attack this round.
	var e := entity_at(h)
	if e != null and is_enemy(p, e) and Hex.distance(p.hex, h) == 1:
		_clear_journey("")
		var a_slot := _find_card_slot(["A"])
		if a_slot < 0:
			hud.log_line("no Attack card in hand", Color(0.75, 0.6, 0.5))
			return
		_auto_pick(a_slot, h)
		map.path_preview = []
		hud.log_line("auto attack → %s" % e.display_name, Color(0.95, 0.75, 0.5))
		return
	# Far hex (empty or enemy): plan the walk. If an enemy sits on `h`, journey
	# to its nearest walkable, unoccupied neighbour and flag auto-attack.
	var want_attack: bool = e != null and is_enemy(p, e)
	var dest := h
	if want_attack:
		var best := p.hex
		var bd := 1 << 30
		for n in Hex.neighbours(h):
			if gen.has(n) and gen.terrain_at(n.x, n.y).walkable and entity_at(n) == null:
				var d := Hex.distance(p.hex, n)
				if d < bd:
					bd = d
					best = n
		if best == p.hex:
			hud.log_line("no walkable approach to %s" % e.display_name, Color(0.75, 0.6, 0.5))
			return
		dest = best
	var blocked := blocked_map(p)
	var path := Pathfinding.find_path(p.hex, dest, blocked, func(x): return gen.has(x))
	if path.is_empty():
		hud.log_line("no path to %s" % Hex.key_of(h), Color(0.75, 0.6, 0.5))
		return
	_journey_path = path
	_journey_dest = h
	_journey_attack = want_attack
	map.selected = p.hex
	map.path_preview = path
	map.queue_redraw()
	var m_slot := _find_card_slot(["M", "EM"])
	if m_slot < 0:
		# Journey is queued; _journey_resume will auto-pick when a mover appears.
		hud.log_line("journey → %s (%d steps · waiting for M)" % [Hex.key_of(h), path.size()], Color(0.75, 0.85, 0.5))
		return
	_auto_pick(m_slot, path[0])
	hud.log_line("journey → %s (%d steps%s)" % [
		Hex.key_of(h), path.size(), " then attack" if want_attack else ""
	], Color(0.6, 0.9, 0.7))


func _journey_resume() -> void:
	# Called at the end of _begin_planning so a running journey picks up where it
	# left off. Prune hexes we've already walked past (player is now standing on
	# them). If the path is drained and attack was requested, swap to A against
	# the nearest adjacent enemy.
	if _journey_path.is_empty() and not _journey_attack:
		return
	var p := player_entity()
	if p == null:
		_clear_journey("")
		return
	while not _journey_path.is_empty() and _journey_path[0] == p.hex:
		_journey_path.pop_front()
	if _journey_path.is_empty():
		if _journey_attack:
			_journey_attack = false
			map.path_preview = []
			var foe := _nearest_enemy(p)
			if foe != null and Hex.distance(p.hex, foe.hex) == 1:
				var a_slot := _find_card_slot(["A"])
				if a_slot >= 0:
					_auto_pick(a_slot, foe.hex)
					hud.log_line("journey ended · auto attack %s" % foe.display_name, Color(0.95, 0.75, 0.5))
					return
		_clear_journey("")
		return
	var m_slot := _find_card_slot(["M", "EM"])
	if m_slot < 0:
		# No mover this round — hold the plan, don't force EM.
		hud.log_line("journey paused: no mover in hand", Color(0.8, 0.7, 0.5))
		return
	_auto_pick(m_slot, _journey_path[0])
	map.selected = p.hex
	map.path_preview = _journey_path
	map.queue_redraw()


func _lock() -> void:
	if phase != "planning" or locked:
		return
	locked = true
	var p := player_entity()
	if p != null:
		var code := str(hand[chosen]) if chosen >= 0 else "EP"
		p.play_sound("order")
		net.commit(round_no, [{"entity": p.id, "code": code, "target": str(target_hex)}])
		hud.log_line("You lock %s%s" % [code, (" → " + Hex.key_of(target_hex)) if target_hex != null else ""], Color(0.95, 0.85, 0.6))
		if _is_channeling_card(code):
			_channel_card = code
			_channel_target = target_hex
			_channel_interrupted = false
			hud.log_line("channeling %s started" % code, Color(0.65, 0.8, 0.95))
			hud.log_line("channeling %s · temp perm (not yet implemented in solo mode — see peer.mjs for the full rule)" % code, Color(0.6, 0.7, 0.75))
			if hud.has_method("set_channel_label"):
				hud.set_channel_label(_channel_label_text(code))
	_refresh_hand()
	_push_mobile_hint()


## True when `code` resolves to an effect/skill whose top-level tags OR latest-version
## data.tags include "channeling". Basic cards (A/B/M/P/EP/EM) short-circuit false.
func _is_channeling_card(code: String) -> bool:
	if code == "" or code in ["A", "B", "M", "P", "EP", "EM"]:
		return false
	for kind in ["effects", "skills"]:
		var entry: Dictionary = dl.get_entry(kind, code)
		if entry.is_empty():
			continue
		var top: Variant = entry.get("tags", [])
		if typeof(top) == TYPE_ARRAY and "channeling" in top:
			return true
		var data: Dictionary = dl.data_of(kind, code)
		var inner: Variant = data.get("tags", [])
		if typeof(inner) == TYPE_ARRAY and "channeling" in inner:
			return true
	return false


## Public stub so a future "enemy destroyed my temp perm" wire can break the
## channel. The browser peer owns the real rule; this is here so Hud.gd / NetBridge
## can call it without a crash.
func interrupt_channel() -> void:
	if _channel_card == "":
		return
	_channel_interrupted = true


## Map object (building / scatter / landmark) on a hex, with its `desc` filled in, or {}.
## Buildings win over landmarks, landmarks over small scatter — same stacking as the layers.
func object_at(h: Vector2i) -> Dictionary:
	if not gen.has(h):
		return {}
	var obj: Dictionary = gen.feature_at(h.x, h.y)
	if obj.is_empty() and gen.bigfeature != null and gen.biome != null:
		obj = gen.bigfeature.big_feature_at(h.x, h.y, gen.biome)
	if obj.is_empty() and gen.scatter != null and gen.biome != null:
		obj = gen.scatter.scatter_at(h.x, h.y, gen.biome)
	if obj.is_empty():
		return {}
	obj = obj.duplicate()
	if str(obj.get("desc", "")) == "":
		obj["desc"] = RulesText.object_desc(obj)
	return obj


## Show (or hide) the HUD object card for whatever sits on `h`. Returns true if a card is shown.
func inspect_hex(h: Vector2i) -> bool:
	var obj := object_at(h)
	hud.show_object_card(obj, h)
	return not obj.is_empty()


## True when `h` is a sensible target for the chosen card: A/M/EM aimed at another
## known, walkable hex (far targets are fine — the path is cut to the card's budget).
func _is_card_target(h: Vector2i) -> bool:
	if phase != "planning" or locked or chosen < 0 or chosen >= hand.size():
		return false
	var p := player_entity()
	if p == null or h == p.hex:
		return false
	var code := str(hand[chosen])
	if not code in ["A", "M", "EM"]:
		return false
	return gen.terrain_at(h.x, h.y).walkable or entity_at(h) != null


func _on_hex_clicked(h: Vector2i, button: int) -> void:
	if button == MOUSE_BUTTON_RIGHT:
		# discard the chosen card once per round -> redraw a random one
		if phase == "planning" and not locked and chosen >= 0 and not discarded and player_entity() != null:
			discarded = true
			var pool := ["A", "B", "M", "P", "EM", "EP"]
			hand[chosen] = pool[rng.randi_range(0, pool.size() - 1)]
			target_hex = null
			map.path_preview = []
			hud.log_line("discarded → drew %s" % hand[chosen], Color(0.7, 0.7, 0.75))
			_update_reach()
			_refresh_hand()
		return
	if not gen.has(h):
		hud.hide_object_card()
		return
	# Mobile fallback: tapping a neighbour hex with nothing picked auto-picks a
	# mover from the hand. The HUD slot bar is still the primary path; this just
	# unblocks phones until that bar is wired for touch.
	var is_mobile := OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")
	if phase == "planning" and not locked and chosen == -1 and is_mobile:
		var pm := player_entity()
		if pm == null:
			return
		if Hex.distance(pm.hex, h) == 1:
			var found_i := -1
			for i in range(hand.size()):
				if str(hand[i]) == "M":
					found_i = i
					break
			if found_i == -1:
				for i in range(hand.size()):
					if str(hand[i]) in ["M", "EM", "A"]:
						found_i = i
						break
			if found_i == -1:
				hud.log_line("no mover in hand", Color(0.75, 0.6, 0.5))
				return
			_pick_slot(found_i)
			target_hex = h
			_refresh_hand()
			_update_reach()
			map.queue_redraw()
			hud.log_line("auto-picked %s → %s" % [str(hand[found_i]), Hex.key_of(h)], Color(0.6, 0.9, 0.6))
			return
	if not _is_card_target(h):
		# Not a targeting click: an entity re-selects it in the HUD, an object opens
		# its info card, bare ground closes any open card.
		var e := entity_at(h)
		if e != null:
			hud.hide_object_card()
			hud.set_entity(e)
			e.play_sound("select")
			return
		inspect_hex(h)
		return
	hud.hide_object_card()
	# A manual target click overrides any auto-plan — unless the user is
	# just confirming the next step of the queued journey.
	if not _journey_path.is_empty() and h != _journey_path[0]:
		_clear_journey("retargeted")
	var p := player_entity()
	var code := str(hand[chosen])
	target_hex = h
	var blocked := blocked_map(p)
	var path := Pathfinding.find_path(p.hex, h, blocked, func(x): return gen.has(x))
	var budget := 1 if code != "EM" else mini(EM_MAX_STEPS, maxi(1, roundi(Hex.distance(p.hex, h) / 2.0)))
	map.selected = p.hex
	map.path_preview = []
	for i in range(mini(budget, path.size())):
		map.path_preview.append(path[i])
	map.queue_redraw(); if scatter_layer: scatter_layer.queue_redraw(); if bigfeatures_layer: bigfeatures_layer.queue_redraw(); if features_layer: features_layer.queue_redraw()
	_refresh_hand()


func _on_hex_hovered(h: Vector2i) -> void:
	if not gen.has(h):
		hud.set_hover("")
		hud.hide_unit_hover()
		return
	var terr := gen.terrain_at(h.x, h.y)
	var e := entity_at(h)
	var s := "%s · %s" % [Hex.key_of(h), terr.type]
	if e != null:
		s += " · %s (%d/%d)" % [e.display_name, e.life, e.life_max]
	var obj := object_at(h)
	if not obj.is_empty():
		s += " · %s" % str(obj.get("label", obj.get("id", "")))
	hud.set_hover(s)
	# Rich hover card for units — mirror of game/js/main.js renderHoverCard.
	# Only fires on a unit; empty / object hexes close any open card so the
	# right column reverts to log + roster.
	if e != null:
		hud.show_unit_hover(e)
	else:
		hud.hide_unit_hover()


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_cancel"):
		if hud.object_card_visible():
			hud.hide_object_card()
			return
	for i in range(5):
		if event.is_action_pressed("hand_%d" % (i + 1)):
			_pick_slot(i)
			return
	if event.is_action_pressed("hand_empty"):
		for i in range(hand.size()):
			if str(hand[i]).begins_with("E"):
				_pick_slot(i)
				return
	elif event.is_action_pressed("lock_commit"):
		_lock()


# ---------------------------------------------------------- Net signal relay
# These handlers accept the Node peer's broadcasts and forward the pieces the
# HUD cares about. Everything is idempotent: a reconnect simply re-fires
# hello_received + an immediate hand/peers burst, and the HUD rebuilds from
# the fresh snapshot. Game.gd's local sim keeps running for solo play; the
# server view sits on top of it until Task 8 refactors Game.gd to be purely
# server-authoritative.

func _on_net_hello(payload: Dictionary) -> void:
	hud.log_line("peer %s · dim %s" % [String(payload.get("peer_id", "?")).substr(0, 10), String(payload.get("dimension", "?"))])
	if hud.has_method("set_server_hand"):
		hud.set_server_hand(payload)
	if hud.has_method("set_server_peers"):
		hud.set_server_peers(payload.get("peers", []))
	# Fill the top chip row from the hello dump — dimension / door / peer_id
	# + the first turn/round/phase values. phase_received keeps the timer +
	# phase pills live afterwards.
	if hud.has_method("set_status_bar"):
		hud.set_status_bar(payload)

func _on_net_hand(payload: Dictionary) -> void:
	if hud.has_method("set_server_hand"):
		hud.set_server_hand(payload)
	_push_mobile_piles()
	# Mirror the browser's myEmissionPreview — union of the queued action, any
	# extra, and all queued effects' elements. The HUD fades the chip out
	# shortly after, so leaving an action queued keeps re-triggering it (which
	# matches "this is what you'll emit on reveal").
	var emit_set := {}
	var q := String(payload.get("queued", ""))
	if q != "": emit_set[q] = true
	var qe := String(payload.get("queued_extra", ""))
	if qe != "": emit_set[qe] = true
	for key in ["queued_effect", "queued_effect2"]:
		var fx: Variant = payload.get(key, null)
		if typeof(fx) == TYPE_DICTIONARY:
			var els: Variant = (fx as Dictionary).get("elements", [])
			if typeof(els) == TYPE_ARRAY:
				for el in (els as Array):
					var s := String(el)
					if s != "": emit_set[s] = true
	if hud.has_method("show_emit"):
		if emit_set.is_empty():
			hud.show_emit("")
		else:
			hud.show_emit(" ".join(PackedStringArray(emit_set.keys())))

func _on_net_peers(payload: Dictionary) -> void:
	if hud.has_method("set_server_peers"):
		hud.set_server_peers(payload.get("peers", []))

func _on_net_phase(payload: Dictionary) -> void:
	var label := "%s · T%d.R%d · %.1fs" % [
		String(payload.get("name", "")), int(payload.get("turn", 0)),
		int(payload.get("round", 0)) + 1, float(payload.get("seconds", 0.0))
	]
	hud.log_line(label, Color(0.7, 0.7, 0.9))
	# Phase ticks also drive the top chip row. peer.mjs re-sends every phase
	# transition and every second during planning, so the timer chip ticks
	# down live and tier flips strong↔reachable as neighbours change.
	if hud.has_method("set_status_bar"):
		# Translate "name" → "phase" to match set_status_bar's field schema
		# (hello uses "phase", phase uses "name").
		var merged := payload.duplicate()
		if payload.has("name"):
			merged["phase"] = payload["name"]
		hud.set_status_bar(merged)

func _on_net_evt(env: Dictionary, from_peer: bool) -> void:
	# Hashgraph envelopes — only surfaced in debug for now; the HUD rebuilds
	# off hand / peers / phase instead so the player never sees raw envelope
	# payloads.
	var t := String(env.get("type", ""))
	# Destroy intents from any peer land here on reveal — the player should
	# see "foe-1 tries to destroy a perm (will)" even for NPCs, matching the
	# browser's reveal-log line. We still filter the generic reveal spam.
	if t == "evt_action_reveal":
		var payload: Variant = env.get("payload", {})
		if typeof(payload) == TYPE_DICTIONARY:
			var d: Variant = (payload as Dictionary).get("destroy", null)
			if typeof(d) == TYPE_DICTIONARY and String((d as Dictionary).get("stat", "")) != "":
				var actor := String(env.get("peer_id", "?"))
				var stat := String((d as Dictionary).get("stat", ""))
				hud.log_line("%s emits %s at a permanent (destroy intent)" % [actor.substr(0, 10), stat], Color(0.95, 0.6, 0.5))
		return
	if from_peer:
		return
	if t == "evt_state_hash":
		return
	hud.log_line("evt %s" % t, Color(0.6, 0.7, 0.75))


## Fired when Hud detects a double-click / double-tap on an enemy perm card.
## Pick the player's highest live stat as the emission source (matching
## peer.mjs L1788's fallback) and send the intent down the wire; sending the
## same stat twice toggles it off, which is the browser's cancel path too.
func _on_destroy_perm_requested(_target_peer_id: String, _perm_id: String, suggested_stat: String) -> void:
	if net == null or not net.is_online():
		hud.log_line("destroy ignored — not connected to a peer", Color(0.9, 0.6, 0.4))
		return
	var stat := suggested_stat
	if stat == "":
		var me := player_entity()
		if me != null:
			var stats: Dictionary = me.data.get("stats", {})
			var best := ""
			var best_v := -1
			for key in ["vitality", "world", "matter", "will"]:
				var v := int(stats.get(key, 0))
				if v > best_v:
					best_v = v
					best = key
			stat = best
	if stat == "":
		return
	net.toggle_destroy(stat)
	hud.log_line("destroy queued: emits %s (double-tap again to cancel)" % stat, Color(0.95, 0.75, 0.4))

## Roster stat chip tapped. Browser parity:
##   - own row stat tap → arm destroy with that stat (emit this element
##     against the closest enemy's matching perm, Rule 24; tapping again
##     cancels — toggle_destroy toggles when the same stat re-fires).
##   - enemy row stat tap → route through the existing destroy-perm hook so
##     the player can arm a destroy against this unit without first picking
##     a perm from a submenu.
func _on_hud_stat_tapped(entity_id: String, stat_key: String, is_own: bool) -> void:
	if net == null or not net.is_online():
		hud.log_line("stat tap ignored — not connected to a peer", Color(0.9, 0.6, 0.4))
		return
	if is_own:
		net.toggle_destroy(stat_key)
		hud.log_line("emit via %s armed (tap again to cancel)" % stat_key, Color(0.95, 0.75, 0.4))
		return
	# Enemy row: route through the existing destroy hook. It picks the
	# player's best emission stat if `suggested_stat` is empty; here we
	# pass the enemy's tapped stat so the destroy intent targets that
	# colour-group explicitly (Rule 24). _on_destroy_perm_requested
	# ignores the first two args, so we can leave them empty.
	_on_destroy_perm_requested("", "", stat_key)

## Q class-ability button pressed on mobile — browser's Q keypress parity.
func _on_hud_class_ability_pressed() -> void:
	if net == null or not net.is_online():
		hud.log_line("class ability ignored — not connected", Color(0.9, 0.6, 0.4))
		return
	net.class_ability()
	hud.log_line("class ability triggered", Color(0.85, 0.75, 1.0))

func _on_net_peek(payload: Dictionary) -> void:
	hud.log_line("👁 %s" % String(payload.get("text", "")), Color(0.9, 0.85, 0.6))

func _on_net_radicle(payload: Dictionary) -> void:
	var pub = payload.get("published", false)
	hud.log_line("Door %s%s" % [
		"published" if pub else "pushed locally",
		(" → " + String(payload.get("url", ""))) if String(payload.get("url", "")) != "" else ""
	], Color(0.6, 0.9, 0.6) if pub else Color(0.75, 0.75, 0.6))
