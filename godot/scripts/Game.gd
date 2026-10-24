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
const FALLBACK_SHEETS := {
	"char_exuberant_firestroker": {"base": "assets/Sprites/Units/Empire/Red Mage/Red Mage - ", "code": "AHGR", "cast": true},
	"char_pride_guardian": {"base": "assets/Sprites/Units/Knights/Knight Lord/Knight Lord - ", "code": "AHEX"},
	"mon_ruinous_minotaur": {"base": "assets/Sprites/Units/Minotaurs/Minotaur/Minotaur - ", "code": "AMIX"},
	"mon_ridge_runnet_3a": {"base": "assets/Sprites/Units/Daemons/Imp/Imp - ", "code": "AAIM"},
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

	# Buildings / permanents on walkable biome hexes. Lives above the terrain
	# (HexMap) and below entities. Deterministic from (dim_seed, q, r), so every
	# new reveal fills in with the right features automatically.
	var features := FeatureLayer.new()
	features.name = "Features"
	add_child(features)
	features.setup(gen)

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
	add_child(hud)
	hud.slot_pressed.connect(_pick_slot)
	hud.lock_pressed.connect(_lock)

	net = NetBridge.new()
	net.name = "Net"
	add_child(net)

	# Spawn: snap each default spawn to the nearest walkable hex (otherwise a
	# player spawning on a lava or water biome can't move).
	for s in DEFAULT_SPAWN:
		var at: Vector2i = gen.nearest_walkable(s.at, 5)
		spawn(s.id, s.kind, s.faction, at)
	var p := player_entity()
	if p != null:
		gen.reveal_around(p.hex, REVEAL_RADIUS, "genesis")
		map.queue_redraw()
		hud.set_entity(p)
		cam.follow = p
		cam.position = p.position
	hud.log_line("chaosD6 · dimension Ashfall-Micro · seed %s · %d hexes known" % [gen.seed_hex, gen.size()], Color(0.9, 0.75, 0.5))
	hud.log_line("Data: %d characters, %d creatures, %d effects loaded from data/*.json" % [dl.ids("characters").size(), dl.ids("creatures").size(), dl.ids("effects").size()])
	_begin_planning()


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
	_deal_hand()
	_update_reach()
	_refresh_hand()
	var p := player_entity()
	if p != null:
		hud.update_life(p)


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
	net.reveal(round_no, reveal_list, "")
	for k in intents.keys():
		var e := _find(k)
		if e != null:
			var t: String = (" → %s" % Hex.key_of(intents[k].target)) if intents[k].target != null else ""
			hud.log_line("%s reveals %s%s" % [e.display_name, intents[k].code, t], Color(0.75, 0.75, 0.8) if e.faction == "npc" else Color(0.9, 0.85, 0.7))
	map.reach = {}
	map.queue_redraw()


func _npc_plan(e: Entity) -> Dictionary:
	var foe := _nearest_enemy(e)
	if foe == null:
		return {"code": "EP", "target": null}
	var d := Hex.distance(e.hex, foe.hex)
	var r := rng.randf()
	if d <= 1:
		if r < 0.6:
			return {"code": "A", "target": foe.hex}
		if r < 0.8:
			return {"code": "B", "target": null}
		return {"code": "P", "target": foe.hex}
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
		var blocked := {}
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
			map.queue_redraw()

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
	net.publish_state(_state())
	if player_entity() == null:
		phase = "over"
		hud.log_line("Your character has fallen. The dimension collapses.", Color(0.95, 0.5, 0.4))
		return
	if _nearest_enemy(player_entity()) == null:
		hud.log_line("All hostiles cleared — the dimension is yours.", Color(0.6, 0.95, 0.6))
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


func _refresh_hand() -> void:
	var targets := {}
	if chosen >= 0 and target_hex != null:
		targets[chosen] = Hex.key_of(target_hex)
	hud.set_hand(hand, chosen, locked, targets)


func _update_reach() -> void:
	map.reach = {}
	var p := player_entity()
	if p == null or chosen < 0:
		map.queue_redraw()
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
	map.queue_redraw()


func _pick_slot(i: int) -> void:
	if phase != "planning" or locked or i < 0 or i >= hand.size():
		return
	chosen = i
	target_hex = null
	map.path_preview = []
	var p := player_entity()
	if p != null:
		p.play_sound("select")
		hud.set_quote(p.quote_for("select"))
	_update_reach()
	_refresh_hand()


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
	_refresh_hand()


func _on_hex_clicked(h: Vector2i, button: int) -> void:
	if phase != "planning" or locked:
		return
	var p := player_entity()
	if p == null:
		return
	if button == MOUSE_BUTTON_RIGHT:
		# discard the chosen card once per round -> redraw a random one
		if chosen >= 0 and not discarded:
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
		return
	if chosen < 0:
		# clicking a friendly entity re-selects it in the HUD
		var e := entity_at(h)
		if e != null:
			hud.set_entity(e)
			e.play_sound("select")
		return
	var code := str(hand[chosen])
	if code in ["B", "EP"]:
		return
	target_hex = h
	var blocked := blocked_map(p)
	var path := Pathfinding.find_path(p.hex, h, blocked, func(x): return gen.has(x))
	var budget := 1 if code != "EM" else mini(EM_MAX_STEPS, maxi(1, roundi(Hex.distance(p.hex, h) / 2.0)))
	map.selected = p.hex
	map.path_preview = []
	for i in range(mini(budget, path.size())):
		map.path_preview.append(path[i])
	map.queue_redraw()
	_refresh_hand()


func _on_hex_hovered(h: Vector2i) -> void:
	if not gen.has(h):
		hud.set_hover("")
		return
	var terr := gen.terrain_at(h.x, h.y)
	var e := entity_at(h)
	var s := "%s · %s" % [Hex.key_of(h), terr.type]
	if e != null:
		s += " · %s (%d/%d)" % [e.display_name, e.life, e.life_max]
	hud.set_hover(s)


func _unhandled_input(event: InputEvent) -> void:
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
