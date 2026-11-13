extends Node
# NOTE: no `class_name` — this script is registered as an autoload in
# godot/project.godot (`DimensionLauncher="*res://scripts/DimensionLauncher.gd"`).
# Adding `class_name DimensionLauncher` conflicts with the autoload singleton
# ("Class … hides an autoload singleton" at parse time, preventing boot on
# Android). Game.gd accesses `DimensionLauncher.pending_join` through the
# autoload accessor, which resolves fine at runtime without class_name.
## Fetches the "Active Dimensions" list from the dedicated chaosD6-Dimensions
## Radicle repo via radicle-httpd on OCI, so mobile peers can show a joinable
## dim list without a native git toolchain.
##
## The three endpoints we hit (all plain HTTPS, no auth):
##
##   GET  <seed>/api/v1/repos/rad:<DIM_RID>/remotes
##     → list of every namespace that has pushed into the repo. Each namespace
##       has a `heads` dict; keys that start with "ActiveDimensions/" are live
##       dims this peer has advertised. Union across namespaces gives us the
##       full catalogue.
##
##   GET  <seed>/api/v1/repos/rad:<DIM_RID>/tree/<sha>/ActiveDimensions/<Name>/dimension.json
##     → shared dimension doc (map seed, bounds, blocks). All doors on the
##       same branch publish an identical copy; we read whichever we find.
##
##   GET  <seed>/api/v1/repos/rad:<DIM_RID>/tree/<sha>/ActiveDimensions/<Name>/doors/<peer>.json
##     → one Door per publisher — contains their alias, unit, tile, faction,
##       and the full map/clock snapshot. The launcher UI picks a door; the
##       joining peer then spawns as an ally of that door's faction at the
##       nearest walkable neighbour of its unit.
##
## This script is deliberately a free-standing autoload candidate so the Main
## scene can `DimensionLauncher.fetch_dim_list()` without wiring instances; see
## project.godot to register it. Nothing here reads the Radicle protocol
## directly — all requests go through radicle-httpd, which does the right
## thing with the Radicle storage behind the scenes.

signal dim_list_received(dims: Array)        # Array[Dictionary] {name, namespaces, commit}
signal doors_received(dim: String, doors: Array)  # Array[Dictionary] (parsed door docs)
signal dimension_doc_received(dim: String, doc: Dictionary)
signal fetch_failed(stage: String, reason: String)
## Emitted when a deep-link join finishes resolving (after Main.tscn's _ready).
signal join_resolved(join: Dictionary)

## RID of the dims-only Radicle repo. Overridden at runtime via Godot
## `OS.get_environment("RADICLE_DIMS_RID")` on desktop; on Android we fall
## back to this const (Android has no shell env, so the APK bakes this in).
const DEFAULT_DIMS_RID := "rad:z2xbfJfwT3kukR73m8LXmmuvchEwr"

## Explorer / radicle-httpd base. 92-5-138-121.sslip.io is the OCI seed
## backing dimensions-4e9ae.web.app, so this is the same endpoint the browser
## SPA uses. Falls back to a desktop env var the same way as DIMS_RID.
const DEFAULT_SEED_HOST := "92-5-138-121.sslip.io"

var _dims_rid := DEFAULT_DIMS_RID
var _seed_host := DEFAULT_SEED_HOST
var _http: HTTPRequest

## Set by the launcher UI once the player picks a dim+door. Game.gd's _ready()
## checks this on scene load and teleports the local player to spawn_hex with
## the right alliance; it then clears the field so a scene restart doesn't
## re-apply the same join. Shape: {dim_name, alliance, spawn_hex, unit_hex, door}.
var pending_join: Dictionary = {}

## Populated by fetch_dim_list(); keyed by dim name → {commit, namespaces[]}.
## _namespace_ was tempting but Radicle namespaces are per-peer identities,
## not per-dim, so a dim can live across several namespaces (each publisher
## has their own door file). We keep the list so door fetches can scan them.
var _dim_index: Dictionary = {}


func _ready() -> void:
	_http = HTTPRequest.new()
	add_child(_http)
	var r := OS.get_environment("RADICLE_DIMS_RID")
	if r != "":
		_dims_rid = r
	var h := OS.get_environment("RADICLE_SEED")
	if h != "":
		_seed_host = h
	# Handle a chaosd6://join?dim=…&nid=…&rid=…&commit=… deep link if the app
	# was launched from one. Godot forwards the intent's URI as a cmdline arg
	# on Android (via its native launcher glue); on desktop it comes in via
	# --<url> too when registered as a scheme handler. If no join URL is
	# present, this is a no-op — regular launch proceeds via the usual flow.
	_handle_launch_intent()


## Parse a chaosd6://join?... URL from the launch intent (if any) and populate
## `pending_join` so Game.gd._ready() spawns at the chosen unit's neighbour.
##
## Supported shape: chaosd6://join?dim=<name>&nid=<publisher>&rid=<bare RID,
## without the "rad:" prefix>&commit=<sha>. All params optional except `dim`;
## when `nid` is present we fetch doors to find the right unit, otherwise we
## pick the first live door in the dim as the join target.
func _handle_launch_intent() -> void:
	var uri := ""
	for a in OS.get_cmdline_args():
		if a.begins_with("chaosd6://"):
			uri = a
			break
	if uri == "":
		return
	print("[DimensionLauncher] deep link: ", uri)
	var parsed := _parse_join_uri(uri)
	if parsed.is_empty() or String(parsed.get("dim", "")) == "":
		push_warning("[DimensionLauncher] malformed join URI: %s" % uri)
		return
	# If the deep link carries its own RID (dim-split world), prefer it over
	# whatever the APK was baked with — one app build should be able to join
	# dims published to any dims-RID.
	var rid_in: String = String(parsed.get("rid", ""))
	if rid_in != "":
		_dims_rid = "rad:" + rid_in if not rid_in.begins_with("rad:") else rid_in
	_resolve_join_from_uri(parsed)


func _parse_join_uri(uri: String) -> Dictionary:
	# chaosd6://join?dim=X&nid=Y → split on '?' then '&' then '='.
	var q_idx := uri.find("?")
	if q_idx < 0:
		return {}
	var qs := uri.substr(q_idx + 1)
	var out: Dictionary = {}
	for pair in qs.split("&"):
		var eq := String(pair).find("=")
		if eq < 0:
			continue
		var k: String = String(pair).substr(0, eq)
		var v: String = String(pair).substr(eq + 1).uri_decode()
		out[k] = v
	return out


## Chase down the dim via radicle-httpd and set `pending_join` so Game.gd
## honours it on scene load. Runs async — the actual spawn happens after
## fetch_dim_list and fetch_doors complete. If the chosen unit's neighbour
## tiles are all blocked, resolve_join falls back to the unit's own hex.
func _resolve_join_from_uri(parsed: Dictionary) -> void:
	var dim_name: String = String(parsed.get("dim", ""))
	var want_peer: String = String(parsed.get("peer", ""))
	var want_nid: String = String(parsed.get("nid", ""))
	fetch_failed.connect(func(stage: String, reason: String):
		push_warning("[DimensionLauncher] join fetch failed at %s: %s" % [stage, reason]))
	# Kick off the list fetch; the index populates _dim_index.
	dim_list_received.connect(func(_dims):
		# Several peers can share one Radicle NID (a desktop mesh), so match the
		# clicked unit by peer_id first; NID is only a fallback.
		doors_received.connect(func(dn: String, doors: Array):
			if dn != dim_name:
				return
			var chosen: Dictionary = {}
			for d in doors:
				if typeof(d) == TYPE_DICTIONARY and want_peer != "" and String((d as Dictionary).get("peer_id", "")) == want_peer:
					chosen = d
					break
			if chosen.is_empty() and want_nid != "":
				for d in doors:
					var ns: Variant = (d as Dictionary).get("radicle", {}) if typeof(d) == TYPE_DICTIONARY else {}
					if typeof(ns) == TYPE_DICTIONARY and String((ns as Dictionary).get("namespace", "")) == want_nid:
						chosen = d
						break
			if chosen.is_empty() and doors.size() > 0:
				chosen = doors[0]
			if chosen.is_empty():
				push_warning("[DimensionLauncher] no doors for dim %s" % dim_name)
				return
			# Blocked hexes come from the dim's known blocks (minimal here; the
			# resolver nudges on arrival if neighbour tiles turn out occupied).
			pending_join = resolve_join(dim_name, chosen, {})
			print("[DimensionLauncher] join resolved: ", pending_join)
			join_resolved.emit(pending_join)
		, CONNECT_ONE_SHOT)
		fetch_doors(dim_name)
	, CONNECT_ONE_SHOT)
	fetch_dim_list()


func _repo_url(path_tail: String) -> String:
	return "https://%s/api/v1/repos/%s/%s" % [_seed_host, _dims_rid, path_tail]


## Fetch /api/v1/repos/<rid>/remotes and dim_list_received the parsed catalogue.
## Multiple calls queue — the response signal fires once per completed cycle.
func fetch_dim_list() -> void:
	_request("remotes", _repo_url("remotes"), func(code: int, body: PackedByteArray):
		if code != 200:
			fetch_failed.emit("remotes", "HTTP %d" % code)
			return
		var raw: Variant = JSON.parse_string(body.get_string_from_utf8())
		if typeof(raw) != TYPE_ARRAY:
			fetch_failed.emit("remotes", "expected array, got %s" % typeof(raw))
			return
		var seen: Dictionary = {}
		for remote in raw:
			if typeof(remote) != TYPE_DICTIONARY:
				continue
			var nid: String = String(remote.get("id", ""))
			var heads: Variant = remote.get("heads", {})
			if typeof(heads) != TYPE_DICTIONARY:
				continue
			for key in heads.keys():
				var k: String = String(key)
				if not k.begins_with("ActiveDimensions/"):
					continue
				var dim_name: String = k.substr("ActiveDimensions/".length())
				if not seen.has(dim_name):
					seen[dim_name] = {"name": dim_name, "namespaces": [], "commit": ""}
				(seen[dim_name].namespaces as Array).append({"nid": nid, "sha": String(heads[k])})
				# Any commit sha works for a tree read; prefer the first.
				if seen[dim_name].commit == "":
					seen[dim_name].commit = String(heads[k])
		_dim_index = seen
		dim_list_received.emit(seen.values())
	)


## Fetch the shared dimension.json for a given dim. Walks the known namespaces
## until one responds 200 — any publisher's branch has an identical copy.
func fetch_dimension_doc(dim_name: String) -> void:
	var entry: Variant = _dim_index.get(dim_name, null)
	if typeof(entry) != TYPE_DICTIONARY or (entry as Dictionary).commit == "":
		fetch_failed.emit("dimension", "unknown dim %s (call fetch_dim_list first)" % dim_name)
		return
	var sha: String = String((entry as Dictionary).commit)
	var path_tail := "blob/%s/ActiveDimensions/%s/dimension.json" % [sha, dim_name]
	_request("dimension/" + dim_name, _repo_url(path_tail), func(code: int, body: PackedByteArray):
		if code != 200:
			fetch_failed.emit("dimension", "HTTP %d" % code)
			return
		var doc: Variant = _blob_json(code, body)
		if typeof(doc) != TYPE_DICTIONARY:
			fetch_failed.emit("dimension", "doc is not an object")
			return
		dimension_doc_received.emit(dim_name, doc)
	)


## Fetch every door file under ActiveDimensions/<dim>/doors/ by issuing one
## tree listing + per-file reads. The index tree gives us the filenames; the
## content fetch gives us the parsed door docs. Mobile UI gets `doors_received`
## with the union across every publishing namespace, so the picker can show
## one row per unit regardless of which peer published it.
func fetch_doors(dim_name: String) -> void:
	var entry: Variant = _dim_index.get(dim_name, null)
	if typeof(entry) != TYPE_DICTIONARY:
		fetch_failed.emit("doors", "unknown dim %s" % dim_name)
		return
	var sha: String = String((entry as Dictionary).commit)
	var list_tail := "tree/%s/ActiveDimensions/%s/doors" % [sha, dim_name]
	_request("doors-list/" + dim_name, _repo_url(list_tail), func(code: int, body: PackedByteArray):
		if code != 200:
			fetch_failed.emit("doors", "HTTP %d" % code)
			return
		var tree: Variant = JSON.parse_string(body.get_string_from_utf8())
		# radicle-httpd returns {entries: [{name, kind, ...}]} for a tree node.
		var entries: Variant = tree.get("entries", []) if typeof(tree) == TYPE_DICTIONARY else []
		var filenames: Array = []
		for e in entries:
			if typeof(e) == TYPE_DICTIONARY and String(e.get("name", "")).ends_with(".json"):
				filenames.append(String(e.name))
		var pending: int = filenames.size()
		var out: Array = []
		if pending == 0:
			doors_received.emit(dim_name, out)
			return
		for name in filenames:
			# Serial fetches: N<10 doors per dim finish in a few hundred ms.
			var file_tail := "blob/%s/ActiveDimensions/%s/doors/%s" % [sha, dim_name, name]
			var res: Array = await _one_shot(_repo_url(file_tail))
			var doc: Variant = _blob_json(int(res[0]), res[1])
			if typeof(doc) == TYPE_DICTIONARY:
				out.append(doc)
		doors_received.emit(dim_name, out)
	)


## radicle-httpd's /blob/<sha>/<path> wraps file contents as {"content": "<text>"}.
func _blob_json(code: int, body: PackedByteArray) -> Variant:
	if code != 200:
		return null
	var wrapper: Variant = JSON.parse_string(body.get_string_from_utf8())
	if typeof(wrapper) != TYPE_DICTIONARY:
		return null
	return JSON.parse_string(String((wrapper as Dictionary).get("content", "")))


## Resolve the Join action: given a chosen dim + a door the user picked, return
## {alliance, spawn_hex, dim_doc, door, unit_hex}. Game.gd consumes this to
## spawn the local player at `spawn_hex` with the alliance of the chosen door's
## unit (ally of that peer) rather than DEFAULT_SPAWN. Picks the nearest
## walkable neighbour of the chosen unit so arrival is adjacent.
func resolve_join(dim_name: String, chosen_door: Dictionary, blocked_hexes: Dictionary) -> Dictionary:
	var tile: Variant = chosen_door.get("tile", {})
	if typeof(tile) != TYPE_DICTIONARY:
		return {}
	var ux: int = int(tile.get("q", 0))
	var uy: int = int(tile.get("r", 0))
	var unit_hex := Vector2i(ux, uy)
	# Try each of the six neighbours; pick the first that is not in blocked_hexes
	# (blocked_hexes keyed by "q,r" strings). Fall back to the unit's own hex if
	# everything is occupied — the resolver will nudge in the next action.
	var neighbours := [
		Vector2i( 1,  0), Vector2i( 1, -1), Vector2i( 0, -1),
		Vector2i(-1,  0), Vector2i(-1,  1), Vector2i( 0,  1),
	]
	var spawn_hex := unit_hex
	for d in neighbours:
		var cand: Vector2i = unit_hex + d
		var key := "%d,%d" % [cand.x, cand.y]
		if not blocked_hexes.has(key):
			spawn_hex = cand
			break
	return {
		"dim_name": dim_name,
		"alliance": String(chosen_door.get("alliance", "player")),
		"spawn_hex": spawn_hex,
		"unit_hex": unit_hex,
		"door": chosen_door,
	}


# ---------------------------------------------------------------- HTTP plumbing

func _request(_tag: String, url: String, on_done: Callable) -> void:
	_http.request_completed.connect(func(_result: int, code: int, _headers: PackedStringArray, body: PackedByteArray):
		on_done.call(code, body)
	, CONNECT_ONE_SHOT)
	var err := _http.request(url, PackedStringArray(["Accept: application/json"]))
	if err != OK:
		fetch_failed.emit("http", "HTTPRequest.request() returned error %d for %s" % [err, url])


## Awaitable GET on a throwaway HTTPRequest (the shared one may be in flight).
## Returns [code, body].
func _one_shot(url: String) -> Array:
	var h := HTTPRequest.new()
	add_child(h)
	var err := h.request(url, PackedStringArray(["Accept: application/json"]))
	if err != OK:
		h.queue_free()
		return [-1, PackedByteArray()]
	var r: Array = await h.request_completed
	h.queue_free()
	return [int(r[1]), r[3]]
