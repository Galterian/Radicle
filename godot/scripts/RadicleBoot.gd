extends Node

## Boots the on-device Radicle node on first launch and keeps it running while
## the game is open. Only lives on Android — a no-op on every other platform.
##
## Pairs with the godot/android/plugins/radicle_node plugin: that plugin
## supplies the native `RadicleNode` singleton. Autoload me from
## project.godot's [autoload] block as `RadicleBoot`.

const PROJECT_RID := "rad:zqZmP6itceBMqYwi1K1n8phQqCaj"

signal node_ready(nid: String)
signal node_failed(reason: String)

var _plugin: Object = null

func _ready() -> void:
    if OS.get_name() != "Android":
        print("[RadicleBoot] not Android — skipping on-device Radicle node")
        return
    if not Engine.has_singleton("RadicleNode"):
        push_warning("[RadicleBoot] RadicleNode plugin missing from this build. See godot/android/plugins/radicle_node/README.")
        node_failed.emit("plugin-missing")
        return

    _plugin = Engine.get_singleton("RadicleNode")
    var alias := "chaos-mobile-%s" % _short_device_id()

    # Doing it on a thread so we don't block the Godot main loop while rad
    # auth + initial seed replication run on the first launch.
    var th := Thread.new()
    th.start(_start_on_thread.bind(alias))

func _start_on_thread(alias: String) -> void:
    var nid: String = _plugin.call("start", alias, PROJECT_RID)
    call_deferred("_emit_result", nid)

func _emit_result(nid: String) -> void:
    if nid.is_empty():
        push_warning("[RadicleBoot] radicle node returned empty NID")
        node_failed.emit("empty-nid")
    else:
        print("[RadicleBoot] node ready, NID=", nid)
        node_ready.emit(nid)

func stop() -> void:
    if _plugin != null:
        _plugin.call("stop")

func is_running() -> bool:
    if _plugin == null:
        return false
    return bool(_plugin.call("isRunning"))

func nid() -> String:
    if _plugin == null:
        return ""
    return String(_plugin.call("nid"))

func _short_device_id() -> String:
    # Stable-ish 6-char suffix so aliases survive restarts but don't leak
    # the full Android device id into the Radicle gossip.
    var raw := OS.get_unique_id()
    if raw.is_empty():
        raw = str(Time.get_unix_time_from_system())
    return raw.sha256_text().substr(0, 6)
