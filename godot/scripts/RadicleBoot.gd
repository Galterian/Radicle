extends Node

## Boots the on-device Radicle node and saves the player's profile into the
## chaosD6-Profiles repo. Only lives on Android — a no-op on every other platform.
##
## Pairs with the godot/android/plugins/radicle_node plugin: that plugin
## supplies the native `RadicleNode` singleton. Autoload me from
## project.godot's [autoload] block as `RadicleBoot`.
##
## The phone only ever writes PROFILE_BRANCH in its own namespace
## (refs/namespaces/<NID>/refs/heads/profile) and seeds the repo with scope
## `followed`, so it never pulls other players' profiles.

# chaosD6-Profiles RID — set once the repo exists (`rad init` on the desktop,
# then seed it on OCI with scope all). Empty = node is not started.
const PROFILES_RID := ""
const PROFILE_BRANCH := "profile"
const PROFILE_FILE := "profile.json"

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
    if PROFILES_RID.is_empty():
        push_warning("[RadicleBoot] PROFILES_RID not set — on-device Radicle node disabled")
        node_failed.emit("no-rid")
        return

    _plugin = Engine.get_singleton("RadicleNode")
    var alias := "chaos-mobile-%s" % _short_device_id()

    # Doing it on a thread so we don't block the Godot main loop while rad
    # auth + initial seed replication run on the first launch.
    var th := Thread.new()
    th.start(_start_on_thread.bind(alias))

func _start_on_thread(alias: String) -> void:
    var nid: String = _plugin.call("start", alias, PROFILES_RID)
    call_deferred("_emit_result", nid)

func _emit_result(nid: String) -> void:
    if nid.is_empty() or nid.begins_with("error:"):
        push_warning("[RadicleBoot] radicle node failed to start: " + nid)
        node_failed.emit(nid if not nid.is_empty() else "empty-nid")
    else:
        print("[RadicleBoot] node ready, NID=", nid)
        node_ready.emit(nid)

## Commits `profile` as PROFILE_FILE on PROFILE_BRANCH, signs and announces it.
## Blocking (first call on a device fetches the repo, up to 60 s) — call from a
## Thread. Returns the commit id, or "error: …".
func save_profile(profile: Dictionary) -> String:
    if _plugin == null:
        return "error: radicle node not available"
    return String(_plugin.call("saveProfile", PROFILES_RID, PROFILE_BRANCH, PROFILE_FILE,
        JSON.stringify(profile, "  ")))

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
