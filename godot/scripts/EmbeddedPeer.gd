extends Node
## Owns the lifecycle of the on-device Node.js peer process on Android.
##
## When the NodejsMobile plugin AAR is present (built from
## godot/android/plugins/nodejs_mobile/), this autoload starts peer.mjs under
## the embedded nodejs-mobile runtime at app launch, listens for its
## "peer listening on 127.0.0.1:<port>" stdout, and exposes that URL for
## NetBridge.gd to connect to.
##
## When the plugin is absent (desktop, or an Android build that hasn't shipped
## the AAR yet), this is a complete no-op — `peer_url` stays "" and NetBridge
## falls back to its usual env/ProjectSetting resolution. That is the
## non-regression guarantee: nothing added here can break the existing WSL-
## backed dev flow.

signal peer_url_ready(url: String)
signal peer_log(line: String, is_err: bool)
signal peer_exited(code: int)

## Final URL for NetBridge.gd to connect to. Empty while booting, filled when
## the plugin fires node_ready. Stays empty forever if the plugin isn't loaded.
var peer_url := ""

## True when we hold a live embedded-peer handle (the plugin was present and
## startNode returned 0). NetBridge checks this before deciding whether to
## wait for peer_url_ready vs. fall through to its own URL resolution.
var active := false

var _plugin: Object = null


func _ready() -> void:
    if OS.get_name() != "Android":
        return
    if not Engine.has_singleton("NodejsMobile"):
        print("[EmbeddedPeer] NodejsMobile plugin not available — Android build without the AAR; using legacy peer URL path")
        return
    _plugin = Engine.get_singleton("NodejsMobile")
    _plugin.connect("node_ready", _on_node_ready)
    _plugin.connect("node_stdout", _on_node_stdout)
    _plugin.connect("node_stderr", _on_node_stderr)
    _plugin.connect("node_exit", _on_node_exit)
    # The peer bundle ships inside the APK (plugin assets/nodejs-project/).
    # NodejsMobile.startNode extracts it into filesDir on first launch keyed on
    # PackageInfo.lastUpdateTime, so new APK installs replace it automatically.
    # mobile-entry.mjs shims TextDecoder (no ICU in nodejs-mobile) then imports peer.mjs.
    _start_with_path("mobile-entry.mjs")


func _start_with_path(script_path: String) -> void:
    # user://assets/ is where AssetBootstrap drops the WBC3 sprite tree the
    # browser UI references as /assets/*. Pass the absolute path to the node
    # process so peer.mjs can serve those sprite URLs. Same for user://data/
    # (unused today, reserved for future per-dimension overrides).
    var assets_dir := ProjectSettings.globalize_path("user://assets")
    var data_dir := ProjectSettings.globalize_path("user://data")
    var env := {
        "PEER_LABEL": "mobile-dev",
        "CHARACTER_ID": OS.get_environment("CHARACTER_ID") if OS.get_environment("CHARACTER_ID") != "" else "random",  # mobile-entry.mjs picks one per launch
        "CHAOSD6_MOBILE": "1",
        "DIM_NAME": OS.get_environment("DIM_NAME") if OS.get_environment("DIM_NAME") != "" else "Ashfall-Micro",
        # Make the UI socket bind to 127.0.0.1 at a stable port — the plugin's
        # ready-regex watches for "peer listening on 127.0.0.1:(\\d+)".
        "PEER_PORT_HTTP": "7401",
        "RADICLE_PUSH_REMOTE": "0",
        "CHAOSD6_ASSETS_DIR": assets_dir,
        "CHAOSD6_USER_DATA_DIR": data_dir,
    }
    # chaosd6://join?... deep link (GodotApp.java puts it in the cmdline args):
    # mobile-entry.mjs reads the dim's Doors and spawns next to the clicked unit.
    for a in OS.get_cmdline_args():
        if a.begins_with("chaosd6://"):
            env["JOIN_URI"] = a
            break
    print("[EmbeddedPeer] startNode script=%s" % script_path)
    var rc: int = _plugin.startNode(script_path, env)
    if rc == 0:
        active = true
        print("[EmbeddedPeer] startNode OK — waiting for node_ready")
    else:
        push_warning("[EmbeddedPeer] startNode returned %d — falling back to legacy URL path" % rc)


func _on_node_ready(port: int) -> void:
    peer_url = "ws://127.0.0.1:%d/" % port
    print("[EmbeddedPeer] node_ready port=%d → %s" % [port, peer_url])
    peer_url_ready.emit(peer_url)


func _on_node_stdout(line: String) -> void:
    print("[peer] %s" % line)
    peer_log.emit(line, false)


func _on_node_stderr(line: String) -> void:
    push_warning("[peer!] %s" % line)
    peer_log.emit(line, true)


func _on_node_exit(code: int) -> void:
    print("[EmbeddedPeer] node exited rc=%d" % code)
    active = false
    peer_url = ""
    peer_exited.emit(code)


func _notification(what: int) -> void:
    if what == NOTIFICATION_WM_CLOSE_REQUEST or what == NOTIFICATION_PREDELETE:
        if _plugin and active:
            _plugin.stopNode()
