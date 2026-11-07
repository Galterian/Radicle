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

## RID of the dims-only Radicle repo. Overridden at runtime via Godot
## `OS.get_environment("RADICLE_DIMS_RID")` on desktop; on Android we fall
## back to this const (Android has no shell env, so the APK bakes this in).
## TODO: update this const to the new RID after `rad init` completes.
const DEFAULT_DIMS_RID := "rad:zqZmP6itceBMqYwi1K1n8phQqCaj"

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
	var path_tail := "tree/%s/ActiveDimensions/%s/dimension.json" % [sha, dim_name]
	_request("dimension/" + dim_name, _repo_url(path_tail), func(code: int, body: PackedByteArray):
		if code != 200:
			fetch_failed.emit("dimension", "HTTP %d" % code)
			return
		var doc: Variant = JSON.parse_string(body.get_string_from_utf8())
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
			var file_tail := "tree/%s/ActiveDimensions/%s/doors/%s" % [sha, dim_name, name]
			# Serialize via nested requests — HTTPRequest allows only one in-flight
			# per node; the free HTTPClient alternative is heavier. For N<10 doors
			# per dim, serial fetches finish in a few hundred ms.
			await _one_shot(_repo_url(file_tail), func(c: int, b: PackedByteArray):
				if c == 200:
					var doc: Variant = JSON.parse_string(b.get_string_from_utf8())
					if typeof(doc) == TYPE_DICTIONARY:
						out.append(doc)
				pending -= 1
			)
		doors_received.emit(dim_name, out)
	)


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


## One-shot variant used from within an already-active _request handler so we
## can `await` it in sequence. Uses a throwaway HTTPRequest to avoid stepping
## on the parent request's in-flight state.
func _one_shot(url: String, on_done: Callable) -> void:
	var h := HTTPRequest.new()
	add_child(h)
	h.request_completed.connect(func(_result: int, code: int, _headers: PackedStringArray, body: PackedByteArray):
		on_done.call(code, body)
		h.queue_free()
	)
	var err := h.request(url, PackedStringArray(["Accept: application/json"]))
	if err != OK:
		on_done.call(-1, PackedByteArray())
		h.queue_free()
