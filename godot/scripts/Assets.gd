class_name Assets
## Locates the chaosD6 repo root (parent of godot/) and loads PNG/BMP/WAV files from
## `assets/...` relative paths at runtime, with caching.
##
## Two modes based on `OS.has_feature("mobile")`:
##   * Desktop/dev: resolves `assets/...` from the repo root on the host
##     filesystem (one dir up from res://). PNGs/WAVs are loose files — no
##     Godot .import step needed. Fast iteration.
##   * Mobile (Android/iOS): resolves to `user://assets/...`. Those files are
##     NOT shipped in the APK; AssetBootstrap (autoload) downloads them from
##     the OCI Radicle seed on first launch, following
##     `godot/assets_manifest.json`. Afterwards everything is a plain
##     Image.load_from_file / FileAccess read, same as desktop.
##
## If a file is missing on-device (manifest hole, aborted bootstrap), we log
## a grep-able warning the first time and the caller falls back to its stub
## (colored oval for units, empty terrain, etc.).

static var _root := ""
static var _tex_cache: Dictionary = {}
static var _img_cache: Dictionary = {}
static var _wav_cache: Dictionary = {}
static var _frames: Dictionary = {}
static var _frames_loaded := false
static var _mobile := OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")
static var _missing_logged: Dictionary = {}


static func repo_root() -> String:
	if _root == "":
		if _mobile:
			# AssetBootstrap writes everything under user://. "root" acts as
			# the virtual parent so callers that do root.path_join("data/...")
			# or root.path_join("assets/...") stay source-compatible.
			_root = "user://"
		else:
			var proj := ProjectSettings.globalize_path("res://").trim_suffix("/").trim_suffix("\\")
			_root = proj.get_base_dir()
	return _root


## "assets/Sprites/..." -> absolute path (desktop) or user:// path (mobile).
## Falls back to chaos_mapper/extracted/... on desktop when the curated copy
## has not been collected yet.
static func resolve(rel: String) -> String:
	if rel == "":
		return ""
	rel = rel.replace("\\", "/")
	if rel.is_absolute_path():
		return rel
	if _mobile:
		var mp := repo_root().path_join(rel)
		# .bmp portraits ship as their .png twin (half the bytes).
		# Transparently fall back when the bmp is missing.
		if rel.ends_with(".bmp") and not FileAccess.file_exists(mp):
			var png_twin := repo_root().path_join(rel.trim_suffix(".bmp") + ".png")
			if FileAccess.file_exists(png_twin):
				return png_twin
		return mp
	var p := repo_root().path_join(rel)
	if FileAccess.file_exists(p):
		return p
	if rel.begins_with("assets/"):
		var alt := repo_root().get_base_dir().path_join("extracted").path_join(rel.trim_prefix("assets/"))
		if FileAccess.file_exists(alt):
			return alt
	return p


static func exists(rel: String) -> bool:
	if rel == "":
		return false
	return FileAccess.file_exists(resolve(rel))


static func _log_missing(rel: String) -> void:
	if _missing_logged.has(rel):
		return
	_missing_logged[rel] = true
	push_warning("[Assets] missing on-device: %s — not in assets_manifest.json or bootstrap incomplete" % rel)


static func load_image(rel: String) -> Image:
	if _img_cache.has(rel):
		return _img_cache[rel]
	var abs := resolve(rel)
	var img: Image = null
	if FileAccess.file_exists(abs):
		img = Image.load_from_file(abs)
	if img != null and not img.is_empty():
		if img.get_format() != Image.FORMAT_RGBA8:
			img.convert(Image.FORMAT_RGBA8)
	else:
		img = null
		if _mobile:
			_log_missing(rel)
	_img_cache[rel] = img
	return img


static func load_texture(rel: String) -> Texture2D:
	if _tex_cache.has(rel):
		return _tex_cache[rel]
	var img := load_image(rel)
	var tex: Texture2D = null
	if img != null:
		tex = ImageTexture.create_from_image(img)
	_tex_cache[rel] = tex
	return tex


static func load_wav(rel: String) -> AudioStreamWAV:
	if _wav_cache.has(rel):
		return _wav_cache[rel]
	var s := WavLoader.load_wav(resolve(rel))
	_wav_cache[rel] = s
	return s


## assets/frames.json (produced by tools/sheet_grid.py) keyed by relative asset path.
static func frames() -> Dictionary:
	if not _frames_loaded:
		_frames_loaded = true
		var p := resolve("assets/frames.json")
		if FileAccess.file_exists(p):
			var txt := FileAccess.get_file_as_string(p)
			var parsed = JSON.parse_string(txt)
			if typeof(parsed) == TYPE_DICTIONARY:
				_frames = parsed
	return _frames


static func frame_info(rel: String) -> Dictionary:
	var f := frames()
	rel = rel.replace("\\", "/")
	if f.has(rel):
		return f[rel]
	# tolerate keys without the "assets/" prefix or with "extracted/"
	var alt := rel.trim_prefix("assets/")
	for k in ["extracted/" + alt, alt]:
		if f.has(k):
			return f[k]
	return {}


static func read_json(rel_or_abs: String) -> Variant:
	var p := rel_or_abs if rel_or_abs.is_absolute_path() else repo_root().path_join(rel_or_abs)
	if not FileAccess.file_exists(p):
		return null
	return JSON.parse_string(FileAccess.get_file_as_string(p))


## Called by AssetBootstrap after a successful mobile download so lookups
## that previously missed (and cached null) re-check the filesystem.
static func clear_caches() -> void:
	_tex_cache.clear()
	_img_cache.clear()
	_wav_cache.clear()
	_frames.clear()
	_frames_loaded = false
	_missing_logged.clear()
