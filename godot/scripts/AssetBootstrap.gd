extends Node
## First-launch asset downloader for Android.
##
## On desktop this autoload is a no-op (assets live on the host filesystem;
## Assets.gd reads them directly). On mobile it reads
## res://assets_manifest.json (shipped in the APK), compares against what's
## already under user://, and downloads what's missing from the OCI
## radicle-httpd blob API. Files land as loose files under user://assets/...
## and user://data/..., which is exactly where Assets.gd on mobile looks for
## them (see Assets.repo_root() returning user:// on mobile).
##
## Why loose files instead of imported Godot resources: we never want to drag
## the 2400-file asset tree through Godot's editor import pipeline, and we
## want files written at runtime (not shipped in the AAB) to be loadable the
## same way. Image.load_from_file() + FileAccess read user://... fine.
##
## URL shape:
##   https://92-5-138-121.sslip.io/api/v1/repos/<RID>/blob/<SHA>/<path>
##
## The SHA is resolved once at startup from GET /api/v1/repos/<RID>. If OCI
## does not have the repo yet (fresh seeder, workstation hasn't run `rad
## sync`), we surface that in the overlay with a retry button.

signal bootstrap_complete(ok: bool, error: String)
signal progress(done: int, total: int, bytes_done: int, bytes_total: int, current: String)

const PROJECT_RID := "rad:zqZmP6itceBMqYwi1K1n8phQqCaj"
# chaosD6-Resources (media split out of the Code repo). Manifest entries with "src": "resources" are fetched
# from this repo in "radicle" mode. "" = not published yet: fall back to PROJECT_RID, which still carries the
# media until the cutover. Set with game/tools/out/_resources_rid_patch.py <RID> --apply.
const RESOURCES_RID := "rad:zZA4j9cK1QF5ThY3KjEoLV4HTd14"
const SEED_BASE := "https://92-5-138-121.sslip.io"
const MANIFEST_RES_PATH := "res://assets_manifest.json"
const MAX_PARALLEL := 4
const MAX_RETRIES := 3

# Fast-path sentinels: skip the 2433-entry stat loop on launches where the
# shipped manifest hasn't changed since the last clean drain of the queue.
# Both live under user:// so uninstall-reinstall correctly re-triggers the
# full download (user:// is wiped with the app).
const SENTINEL_HASH_PATH := "user://assets_manifest_hash.txt"
const SENTINEL_OK_PATH := "user://assets_bootstrap_ok"

# Two delivery modes:
#   "static" (default): plain HTTPS GETs to <SEED_BASE>/pack/<path>, served by
#     caddy from /var/www/pack on OCI. Skips SHA resolution. Chosen because
#     radicle-httpd + gitoxide can't stream the ~800 MB asset pack reliably.
#   "radicle": GET <SEED_BASE>/api/v1/repos/<RID>/blob/<SHA>/<path>. Keeps
#     content-addressed verification but needs the repo to actually land on
#     the seeder — currently fails to consume the pack mid-fetch.
const DELIVERY_MODE := "static"

var _is_mobile := OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")
var _blob_base := ""          # e.g. ".../repos/<RID>/blob/<SHA>/"
var _blob_base_res := ""      # same for RESOURCES_RID (media entries); equals _blob_base when unset
var _manifest: Array = []     # [{path, size, missing?}, ...]
var _queue: Array[int] = []   # indexes into _manifest still to fetch
var _in_flight := 0
var _done_count := 0
var _bytes_done := 0
var _bytes_total := 0
var _total := 0
var _completed := false
var _failed := 0              # files skipped after MAX_RETRIES this run
var _overlay: CanvasLayer = null
var _label: Label = null
var _bar: ProgressBar = null
var _retry_btn: Button = null

# SHA256 of the shipped manifest, computed once in _start().
var _manifest_hash := ""
# Rolling-window speed samples for the ETA readout.
var _last_bytes_done := 0
var _last_bytes_time := 0   # Time.get_ticks_msec(); 0 means unsampled
var _eta_text := "?"


func _ready() -> void:
	if not _is_mobile:
		# Desktop: emit immediately so any scene awaiting us doesn't hang.
		call_deferred("_emit_complete", true, "")
		return
	call_deferred("_start")


func _start() -> void:
	_failed = 0
	_build_overlay()
	_set_status("Reading manifest…")
	# Read raw bytes once so we can both hash and parse without a second read.
	if not FileAccess.file_exists(MANIFEST_RES_PATH):
		_fail("manifest missing or empty — rebuild APK with tools/build-asset-manifest.mjs")
		return
	var _manifest_bytes := FileAccess.get_file_as_bytes(MANIFEST_RES_PATH)
	if _manifest_bytes.is_empty():
		_fail("manifest missing or empty — rebuild APK with tools/build-asset-manifest.mjs")
		return
	_manifest_hash = _sha256_hex(_manifest_bytes)
	# Fast path: identical manifest + clean sentinel ⇒ assets are already in
	# place from a previous drain. Skip the per-entry stat loop entirely; on
	# low-end Android that saves multiple seconds per launch.
	if _bootstrap_sentinel_matches(_manifest_hash):
		_completed = true
		bootstrap_complete.emit(true, "")
		if _overlay:
			_overlay.queue_free()
			_overlay = null
		return
	var mf := _parse_manifest(_manifest_bytes)
	if mf.is_empty():
		_fail("manifest missing or empty — rebuild APK with tools/build-asset-manifest.mjs")
		return
	_manifest = mf
	_total = _manifest.size()
	for e in _manifest:
		_bytes_total += int(e.get("size", 0))
	_bar.max_value = max(1.0, float(_bytes_total))

	if DELIVERY_MODE == "static":
		_blob_base = "%s/pack/" % SEED_BASE
		_blob_base_res = _blob_base
	else:
		_set_status("Resolving seed head…")
		var ok: bool = await _resolve_blob_base()
		if not ok:
			return

	# Build the fetch queue — skip files already fully downloaded.
	for i in _manifest.size():
		var e: Dictionary = _manifest[i]
		if _is_satisfied(e):
			_done_count += 1
			_bytes_done += int(e.get("size", 0))
			continue
		_queue.append(i)
	_emit_progress("")
	if _queue.is_empty():
		_set_status("Assets ready.")
		_emit_complete(true, "")
		return

	_set_status("Downloading %d files (%s)…" % [_queue.size(), _fmt_bytes(_bytes_total - _bytes_done)])
	_pump()


func _pump() -> void:
	while _in_flight < MAX_PARALLEL and not _queue.is_empty():
		var idx: int = _queue.pop_front()
		_fetch(idx, 0)


func _fetch(idx: int, attempt: int) -> void:
	_in_flight += 1
	var entry: Dictionary = _manifest[idx]
	var rel: String = entry["path"]
	var req := HTTPRequest.new()
	req.use_threads = true
	req.timeout = 30.0
	add_child(req)
	req.request_completed.connect(func(result, code, _hdrs, body):
		req.queue_free()
		_in_flight -= 1
		if result != HTTPRequest.RESULT_SUCCESS or code < 200 or code >= 300:
			if attempt + 1 < MAX_RETRIES:
				_fetch(idx, attempt + 1)
				return
			push_warning("[AssetBootstrap] failed %s (code=%d result=%d after %d tries) — skipping" % [rel, code, result, MAX_RETRIES])
			_failed += 1
		else:
			var ok := _write_file(rel, body)
			if not ok:
				push_warning("[AssetBootstrap] failed to write %s" % rel)
				_failed += 1
		_done_count += 1
		_bytes_done += int(entry.get("size", body.size()))
		_emit_progress(rel)
		if _queue.is_empty() and _in_flight == 0:
			_set_status("Assets ready.")
			_emit_complete(true, "")
		else:
			_pump()
	)
	var base := _blob_base_res if str(entry.get("src", "")) == "resources" else _blob_base
	var url := base + _url_encode_path(rel)
	var err := req.request(url)
	if err != OK:
		req.queue_free()
		_in_flight -= 1
		if attempt + 1 < MAX_RETRIES:
			_fetch(idx, attempt + 1)
		else:
			push_warning("[AssetBootstrap] request() failed for %s err=%d" % [rel, err])
			_failed += 1
			_done_count += 1
			_emit_progress(rel)
			if _queue.is_empty() and _in_flight == 0:
				_emit_complete(true, "")
			else:
				_pump()


func _resolve_blob_base() -> bool:
	var ok_code: bool = await _resolve_head(PROJECT_RID, false)
	if not ok_code:
		return false
	_blob_base_res = _blob_base
	if RESOURCES_RID != "" and RESOURCES_RID != PROJECT_RID:
		var ok_res: bool = await _resolve_head(RESOURCES_RID, true)
		if not ok_res:
			return false
	return true


func _resolve_head(rid: String, resources: bool) -> bool:
	# radicle-httpd: GET /api/v1/repos/<RID> → { "head": "<sha>", ... }
	var req := HTTPRequest.new()
	add_child(req)
	req.request("%s/api/v1/repos/%s" % [SEED_BASE, rid])
	var r: Array = await req.request_completed
	req.queue_free()
	var code: int = r[1]
	var body: PackedByteArray = r[3]
	if code < 200 or code >= 300:
		_fail("Seed does not have the repo yet (HTTP %d). Run `rad sync` on the workstation then reopen the app." % code)
		return false
	var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
	if typeof(parsed) != TYPE_DICTIONARY or not parsed.has("head"):
		_fail("Seed returned unexpected payload (no `head`).")
		return false
	var sha: String = str(parsed["head"])
	var base := "%s/api/v1/repos/%s/blob/%s/" % [SEED_BASE, rid, sha]
	if resources:
		_blob_base_res = base
	else:
		_blob_base = base
	return true


func _parse_manifest(bytes: PackedByteArray) -> Array:
	var parsed: Variant = JSON.parse_string(bytes.get_string_from_utf8())
	if typeof(parsed) != TYPE_DICTIONARY or not parsed.has("entries"):
		return []
	return parsed["entries"]


func _sha256_hex(bytes: PackedByteArray) -> String:
	var hc := HashingContext.new()
	hc.start(HashingContext.HASH_SHA256)
	hc.update(bytes)
	var digest: PackedByteArray = hc.finish()
	return digest.hex_encode()


func _bootstrap_sentinel_matches(current_hash: String) -> bool:
	# Both files must be present. The sentinel being missing while the hash
	# file is present means a previous run crashed between the two writes;
	# treat that as "re-verify" rather than trusting the hash.
	if not FileAccess.file_exists(SENTINEL_HASH_PATH):
		return false
	if not FileAccess.file_exists(SENTINEL_OK_PATH):
		return false
	var stored := FileAccess.get_file_as_string(SENTINEL_HASH_PATH).strip_edges()
	return stored != "" and stored == current_hash


func _write_bootstrap_sentinel() -> void:
	# Order matters: write hash first, then the "ok" marker — a crash
	# between the two leaves us conservative on the next launch.
	var fh := FileAccess.open(SENTINEL_HASH_PATH, FileAccess.WRITE)
	if fh != null:
		fh.store_string(_manifest_hash)
		fh.close()
	var fok := FileAccess.open(SENTINEL_OK_PATH, FileAccess.WRITE)
	if fok != null:
		fok.store_string("ok")
		fok.close()


func force_rebootstrap() -> void:
	# Escape hatch for a future "re-check assets" button. Clears both
	# sentinels so the next _start() falls through to the full-check path,
	# then runs it immediately.
	if FileAccess.file_exists(SENTINEL_HASH_PATH):
		DirAccess.remove_absolute(SENTINEL_HASH_PATH)
	if FileAccess.file_exists(SENTINEL_OK_PATH):
		DirAccess.remove_absolute(SENTINEL_OK_PATH)
	_completed = false
	_done_count = 0
	_bytes_done = 0
	_bytes_total = 0
	_total = 0
	_manifest.clear()
	_queue.clear()
	_in_flight = 0
	_last_bytes_done = 0
	_last_bytes_time = 0
	_eta_text = "?"
	_start()


func _is_satisfied(entry: Dictionary) -> bool:
	var rel: String = entry["path"]
	var abs := "user://" + rel
	if not FileAccess.file_exists(abs):
		return false
	var expected: int = int(entry.get("size", -1))
	if expected <= 0:
		return true
	var f := FileAccess.open(abs, FileAccess.READ)
	if f == null:
		return false
	var actual := f.get_length()
	f.close()
	return actual == expected


func _write_file(rel: String, body: PackedByteArray) -> bool:
	var abs := "user://" + rel
	var dir := abs.get_base_dir()
	var err := DirAccess.make_dir_recursive_absolute(dir)
	if err != OK and err != ERR_ALREADY_EXISTS:
		return false
	var f := FileAccess.open(abs, FileAccess.WRITE)
	if f == null:
		return false
	f.store_buffer(body)
	f.close()
	return true


func _url_encode_path(rel: String) -> String:
	# URL-encode each segment separately so slashes stay literal.
	var parts := rel.split("/")
	var out: Array[String] = []
	for p in parts:
		out.append(p.uri_encode())
	return "/".join(out)


# --- overlay UI -------------------------------------------------------------

func _build_overlay() -> void:
	_overlay = CanvasLayer.new()
	_overlay.layer = 100
	add_child(_overlay)
	var panel := ColorRect.new()
	panel.color = Color(0, 0, 0, 0.85)
	panel.anchor_right = 1.0
	panel.anchor_bottom = 1.0
	_overlay.add_child(panel)
	var vb := VBoxContainer.new()
	vb.anchor_left = 0.1
	vb.anchor_right = 0.9
	vb.anchor_top = 0.4
	vb.anchor_bottom = 0.6
	vb.add_theme_constant_override("separation", 12)
	_overlay.add_child(vb)
	_label = Label.new()
	_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_label.add_theme_color_override("font_color", Color(1, 1, 1))
	_label.text = "Preparing…"
	vb.add_child(_label)
	_bar = ProgressBar.new()
	_bar.show_percentage = false
	_bar.custom_minimum_size = Vector2(0, 24)
	vb.add_child(_bar)
	_retry_btn = Button.new()
	_retry_btn.text = "Retry"
	_retry_btn.visible = false
	_retry_btn.pressed.connect(_on_retry)
	vb.add_child(_retry_btn)


func _set_status(s: String) -> void:
	if _label: _label.text = s


func _on_retry() -> void:
	_retry_btn.visible = false
	_done_count = 0
	_bytes_done = 0
	_queue.clear()
	_in_flight = 0
	_start()


func _emit_progress(current: String) -> void:
	if _bar:
		_bar.max_value = max(1.0, float(_bytes_total))
		_bar.value = float(_bytes_done)
	# Rolling ETA: resample baseline every ~500 ms and keep the last window's
	# speed as the shown estimate so the label stays stable between resamples.
	var now := Time.get_ticks_msec()
	if _last_bytes_time == 0:
		_last_bytes_time = now
		_last_bytes_done = _bytes_done
	elif now - _last_bytes_time >= 500:
		var dt := float(now - _last_bytes_time) / 1000.0
		var speed := float(_bytes_done - _last_bytes_done) / dt
		if speed > 1.0:
			var remaining := float(_bytes_total - _bytes_done)
			_eta_text = "%.1f" % (remaining / speed / 60.0)
		_last_bytes_time = now
		_last_bytes_done = _bytes_done
	if _label and current != "":
		_label.text = "%d / %d  —  %s / %s  —  %s min  —  %s" % [
			_done_count, _total,
			_fmt_bytes(_bytes_done), _fmt_bytes(_bytes_total),
			_eta_text, current.get_file()
		]
	progress.emit(_done_count, _total, _bytes_done, _bytes_total, current)


func _fail(reason: String) -> void:
	if _label: _label.text = reason
	if _retry_btn: _retry_btn.visible = true
	bootstrap_complete.emit(false, reason)


func _emit_complete(ok: bool, error: String) -> void:
	if _completed:
		return
	_completed = true
	bootstrap_complete.emit(ok, error)
	if not ok:
		return
	# Persist the fast-path sentinel BEFORE the scene reload — but only after a
	# clean drain. With skipped failures the next launch re-checks and fetches
	# just the missing files (the embedded peer also back-fills on demand).
	if _is_mobile and _manifest_hash != "" and _failed == 0:
		_write_bootstrap_sentinel()
	elif _failed > 0:
		push_warning("[AssetBootstrap] %d files failed — will retry next launch" % _failed)
	# Mobile first launch: the main scene has already started with empty
	# user://, so Assets.gd cached a lot of null textures and DataLoader
	# saw no data/index.json. Drop those caches and reload so everything
	# re-reads from the now-populated user://.
	if _is_mobile:
		Assets.clear_caches()
		get_tree().reload_current_scene()
	if _overlay:
		_overlay.queue_free()
		_overlay = null


func _fmt_bytes(n: int) -> String:
	if n < 1024: return "%d B" % n
	if n < 1024 * 1024: return "%.1f KB" % (n / 1024.0)
	if n < 1024 * 1024 * 1024: return "%.1f MB" % (n / 1024.0 / 1024.0)
	return "%.2f GB" % (n / 1024.0 / 1024.0 / 1024.0)
