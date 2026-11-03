class_name NetBridge
extends Node
## WebSocket client to a running Node peer (game/peer.mjs).
##
## The peer is the deterministic simulator; this Godot process is a thin UI /
## renderer that observes state and sends intents. Keeping the two sides on
## the same wire protocol — exactly the one the browser's main.js consumes —
## means Godot never diverges from the resolver and the mobile APK can ride
## straight on top without a parallel sim.
##
## Server → client (we receive, surface as signals):
##   hello     — initial dump: peer_id, entity, hand, map, peers, phase …
##   hand      — hand / casting / queued* state updates
##   peers     — peer position / life updates
##   evt       — hashgraph envelope (reveal, state_hash, map_sync)
##   phase     — phase name + seconds + turn/round
##   map       — map summary
##   peek      — Vision / Prophet / Avenger peek payload
##   radicle   — Door push status
##
## Client → server (we send via send_cmd(kind, extra)):
##   queue, target, lock, bonus, destroy, link, elem, rebless,
##   phylactery, class_ability, attach, discard, archive, unarchive, uilog

signal connected()
signal disconnected()
signal hello_received(payload: Dictionary)
signal hand_received(payload: Dictionary)
signal peers_received(payload: Dictionary)
signal evt_received(envelope: Dictionary, from_peer: bool)
signal phase_received(payload: Dictionary)
signal map_received(payload: Dictionary)
signal peek_received(payload: Dictionary)
signal radicle_received(payload: Dictionary)

var peer_id := ""
var dimension_id := ""
var offline := false

var _ws: WebSocketPeer = null
var _url := ""
var _connected := false
var _reconnect_at := 0


func _ready() -> void:
	_url = _resolve_url()
	if _url == "":
		offline = true
		print("[NetBridge] no peer URL — running offline (set CHAOSD6_PEER_WS or ProjectSettings 'chaosd6/peer_ws_url')")
		return
	_connect()
	set_process(true)


func _resolve_url() -> String:
	var env_url := OS.get_environment("CHAOSD6_PEER_WS")
	if env_url != "":
		return env_url
	var proj: Variant = ProjectSettings.get_setting("chaosd6/peer_ws_url", "")
	if typeof(proj) == TYPE_STRING and String(proj) != "":
		return String(proj)
	# On Android we don't have a local Node launcher — fall back to the
	# always-on OCI chaosD6 peer. (Follow-up: run start-all.mjs on OCI so
	# this URL actually serves. Until then, Android connects to the local
	# dev host set in CHAOSD6_PEER_WS.)
	if OS.get_name() == "Android":
		return "wss://92-5-138-121.sslip.io/peer"
	# Default: first local peer the launcher spawns.
	return "ws://127.0.0.1:7401/"


func _connect() -> void:
	_ws = WebSocketPeer.new()
	var err := _ws.connect_to_url(_url)
	if err != OK:
		push_warning("[NetBridge] connect_to_url(%s) failed: %s" % [_url, err])
		_reconnect_at = Time.get_ticks_msec() + 2000


func _process(_delta: float) -> void:
	if _ws == null:
		if Time.get_ticks_msec() >= _reconnect_at:
			_connect()
		return
	_ws.poll()
	var state := _ws.get_ready_state()
	match state:
		WebSocketPeer.STATE_OPEN:
			if not _connected:
				_connected = true
				connected.emit()
				print("[NetBridge] connected to ", _url)
			while _ws.get_available_packet_count() > 0:
				var buf := _ws.get_packet()
				_on_message(buf.get_string_from_utf8())
		WebSocketPeer.STATE_CLOSED:
			if _connected:
				_connected = false
				disconnected.emit()
				print("[NetBridge] disconnected from ", _url)
			_ws = null
			_reconnect_at = Time.get_ticks_msec() + 2000


func _on_message(text: String) -> void:
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		return
	var m: Dictionary = parsed
	var kind: String = String(m.get("kind", ""))
	match kind:
		"hello":
			peer_id = String(m.get("peer_id", ""))
			dimension_id = String(m.get("dimension", ""))
			hello_received.emit(m)
		"hand":
			hand_received.emit(m)
		"peers":
			peers_received.emit(m)
		"evt":
			var env: Dictionary = m.get("env", {})
			evt_received.emit(env, bool(m.get("from_peer", false)))
		"phase":
			phase_received.emit(m)
		"map":
			map_received.emit(m)
		"peek":
			peek_received.emit(m)
		"radicle":
			radicle_received.emit(m)
		_:
			# Unknown kinds are forwarded verbatim — a newer peer may add fields
			# before the client learns about them, but we never silently drop.
			pass


## Public API — intent commands matching peer.mjs line 4376 dispatcher.

func is_online() -> bool:
	return _connected and _ws != null


func send_cmd(kind: String, extra: Dictionary = {}) -> void:
	if _ws == null or not _connected:
		return
	var payload := extra.duplicate()
	payload["kind"] = kind
	_ws.send_text(JSON.stringify(payload))


func queue_pick(slots: Array, skills: Array = [], extra: Variant = null,
		effect: Variant = null, effect2: Variant = null, chain: Array = [],
		aura: bool = false) -> void:
	var m := {"slots": slots, "skills": skills, "chain": chain, "aura": aura}
	if extra != null:
		m["extra"] = extra
	if effect != null:
		m["effect"] = effect
	if effect2 != null:
		m["effect2"] = effect2
	send_cmd("queue", m)


func set_target(target: Variant) -> void:
	# target: {kind:"character", ref:peer_id} | {kind:"tile", ref:{q,r}} | null
	send_cmd("target", {"target": target})


func lock() -> void:
	send_cmd("lock")


func toggle_destroy(stat: String, cls: String = "", elem: String = "",
		recast: bool = false, untap: bool = false) -> void:
	var m := {"stat": stat}
	if cls != "": m["class"] = cls
	if elem != "": m["elem"] = elem
	if recast: m["recast"] = true
	if untap: m["untap"] = true
	send_cmd("destroy", m)


func set_link(peer_id_val: String, stat: String) -> void:
	send_cmd("link", {"peer_id": peer_id_val, "stat": stat})


func set_elem(elem: String) -> void:
	send_cmd("elem", {"elem": elem})


func rebless(card_id: String) -> void:
	send_cmd("rebless", {"card_id": card_id})


func phylactery(peer_id_val: String, perm: String) -> void:
	send_cmd("phylactery", {"peer_id": peer_id_val, "perm": perm})


func class_ability() -> void:
	send_cmd("class_ability")


func attach(index: int) -> void:
	send_cmd("attach", {"index": index})


func toggle_discard(card_id: String) -> void:
	send_cmd("discard", {"card_id": card_id})


func toggle_archive(card_id: String) -> void:
	send_cmd("archive", {"card_id": card_id})


func unarchive(card_id: String) -> void:
	send_cmd("unarchive", {"card_id": card_id})


func bonus_plan(plan: Dictionary) -> void:
	# plan carries whichever fields peer.mjs' bonus handler expects: slots,
	# skills, extra, effect, chain, target. Forward as-is.
	send_cmd("bonus", plan)


func uilog(event: String, detail: Dictionary = {}) -> void:
	send_cmd("uilog", {"event": event, "detail": detail})


## --- Legacy offline-sim stubs ---------------------------------------------
## Game.gd still runs its local simulation for solo play and calls these to
## echo intents back to itself when there's no peer. Kept as no-ops so the
## existing local-sim loop keeps compiling until Game.gd is refactored to be
## purely server-authoritative (Task 8). None of these go over the wire — a
## real peer owns commit/reveal/state via `evt_received`.

func commit(_round_no: int, _intents: Array) -> String:
	return "%08x%08x" % [randi(), randi()]


func reveal(_round_no: int, _intents: Array, _nonce: String) -> void:
	pass


func publish_block(_block: Dictionary) -> void:
	pass


func publish_state(_state: Dictionary) -> void:
	pass
