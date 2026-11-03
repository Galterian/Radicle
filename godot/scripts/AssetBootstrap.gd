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
const SEED_BASE := "https://92-5-138-121.sslip.io"
const MANIFEST_RES_PATH := "res://assets_manifest.json"
const MAX_PARALLEL := 4
const MAX_RETRIES := 3

var _is_mobile := OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")
var _blob_base := ""          # e.g. ".../repos/<RID>/blob/<SHA>/"
var _manifest: Array = []     # [{path, size, missing?}, ...]
var _queue: Array[int] = []   # indexes into _manifest still to fetch
var _in_flight := 0
var _done_count := 0
var _bytes_done := 0
var _bytes_total := 0
var _total := 0
var _completed := false
var _overlay: CanvasLayer = null
var _label: Label = null
var _bar: ProgressBar = null
var _retry_btn: Button = null


func _ready() -> void:
	if not _is_mobile:
		# Desktop: emit immediately so any scene awaiting us doesn't hang.
		call_deferred("_emit_complete", true, "")
		return
	call_deferred("_start")


func _start() -> void:
	_build_overlay()
	_set_status("Reading manifest…")
	var mf := _load_manifest()
	if mf.is_empty():
		_fail("manifest missing or empty — rebuild APK with tools/build-asset-manifest.mjs")
		return
	_manifest = mf
	_total = _manifest.size()
	for e in _manifest:
		_bytes_total += int(e.get("size", 0))
	_bar.max_value = max(1.0, float(_bytes_total))

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
		else:
			var ok := _write_file(rel, body)
			if not ok:
				push_warning("[AssetBootstrap] failed to write %s" % rel)
		_done_count += 1
		_bytes_done += int(entry.get("size", body.size()))
		_emit_progress(rel)
		if _queue.is_empty() and _in_flight == 0:
			_set_status("Assets ready.")
			_emit_complete(true, "")
		else:
			_pump()
	)
	var url := _blob_base + _url_encode_path(rel)
	var err := req.request(url)
	if err != OK:
		req.queue_free()
		_in_flight -= 1
		if attempt + 1 < MAX_RETRIES:
			_fetch(idx, attempt + 1)
		else:
			push_warning("[AssetBootstrap] request() failed for %s err=%d" % [rel, err])
			_done_count += 1
			_emit_progress(rel)
			if _queue.is_empty() and _in_flight == 0:
				_emit_complete(true, "")
			else:
				_pump()


func _resolve_blob_base() -> bool:
	# radicle-httpd: GET /api/v1/repos/<RID> → { "head": "<sha>", ... }
	var req := HTTPRequest.new()
	add_child(req)
	req.request("%s/api/v1/repos/%s" % [SEED_BASE, PROJECT_RID])
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
	_blob_base = "%s/api/v1/repos/%s/blob/%s/" % [SEED_BASE, PROJECT_RID, sha]
	return true


func _load_manifest() -> Array:
	if not FileAccess.file_exists(MANIFEST_RES_PATH):
		return []
	var txt := FileAccess.get_file_as_string(MANIFEST_RES_PATH)
	var parsed: Variant = JSON.parse_string(txt)
	if typeof(parsed) != TYPE_DICTIONARY or not parsed.has("entries"):
		return []
	return parsed["entries"]


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
	if _label and current != "":
		_label.text = "%d / %d  —  %s  —  %s" % [_done_count, _total, _fmt_bytes(_bytes_done), current.get_file()]
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
