extends Node

## Boots the on-device Radicle node: the P2P write path of the team profile in
## chaosD6-Profiles (refs/heads/teams/<Team>). Only lives on Android — a no-op
## on every other platform.
##
## Pairs with the godot/android/plugins/radicle_node plugin: that plugin
## supplies the native `RadicleNode` singleton. Autoload me from
## project.godot's [autoload] block as `RadicleBoot` (before EmbeddedPeer).
##
## The saves themselves come from game/profile-sync.mjs in the embedded peer
## (EmbeddedPeer passes it bridge_file()): the node commits them to
## teams/<Team> in its own namespace, signs and announces, and the OCI seed
## promotes them to the canonical branch (infra/oci/profiles-push.mjs). The
## node key is the profile identity, user://data/radicle/identity.pem, so its
## NID is this device's id in the team's `owners`. Seeded with scope
## `followed`: it never pulls other players' namespaces.

# chaosD6-Profiles (infra/oci/profiles-setup.sh); same RID as game/profile-sync.mjs.
const PROFILES_RID := "rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH"
# chaosD6-Dimensions: the node also publishes refs/heads/ActiveDimensions/<Name>
# there (bridge POST /publish). Both are seeded; start() takes a comma list.
const DIMENSIONS_RID := "rad:z2xbfJfwT3kukR73m8LXmmuvchEwr"
# chaosD6-Effects (game/effects-repo.mjs, infra/oci/effects-setup.sh): effect definitions as data;
# seeded so peers can read effects/<id>.json at a pinned commit offline.
const EFFECTS_RID := "rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ"
# chaosD6-Skills (game/skills-repo.mjs, infra/oci/skills-setup.sh): skill definitions as data;
# seeded so peers can read skills/<id>.json + lib/<id>.json at a pinned commit offline.
const SKILLS_RID := "rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5"
# chaosD6-Classes (game/classes-repo.mjs, infra/oci/classes-setup.sh): class definitions as data;
# seeded so peers can read classes/<id>.json + lib/<id>.json at a pinned commit offline.
const CLASSES_RID := "rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi"
# TODO(C3) chaosD6-Classes (game/classes-repo.mjs, infra/oci/classes-setup.sh): no RID yet. After the user runs
# game/tools/oci/classes-rad-init.sh, game/tools/out/_classes_rid_patch.py <rid> --apply adds the CLASSES_RID const
# here and appends it to the seeded rid list below.
# game/profile-radicle.mjs: <profileDir>/radicle/identity.pem, profileDir = CHAOSD6_USER_DATA_DIR.
const IDENTITY_PEM := "user://data/radicle/identity.pem"

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
    var rid_list := PackedStringArray([PROFILES_RID])
    for extra in [DIMENSIONS_RID, EFFECTS_RID, SKILLS_RID, CLASSES_RID]:
        if not extra.is_empty():
            rid_list.append(extra)
    var rids := ",".join(rid_list)
    var nid: String = _plugin.call("start", alias, rids, ProjectSettings.globalize_path(IDENTITY_PEM))
    call_deferred("_emit_result", nid)

func _emit_result(nid: String) -> void:
    if nid.is_empty() or nid.begins_with("error:"):
        push_warning("[RadicleBoot] radicle node failed to start: " + nid)
        node_failed.emit(nid if not nid.is_empty() else "empty-nid")
    else:
        print("[RadicleBoot] node ready, NID=", nid)
        node_ready.emit(nid)

## Where the running node publishes its loopback endpoint ({ port, token, nid,
## features: ["save","publish"] }) for profile-sync.mjs and the dimension
## publisher; "" when the node is not available. The file exists only
## while the node runs — profile-sync.mjs falls back to HTTPS otherwise.
func bridge_file() -> String:
    if _plugin == null:
        return ""
    var home := String(_plugin.call("home"))
    return "" if home.is_empty() else home.path_join("bridge.json")

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
