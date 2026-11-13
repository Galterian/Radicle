# nodejs_mobile plugin for Godot 4 (Android)

Hosts a `nodejs-mobile` runtime inside the APK and launches `peer.mjs` on it, so
the installed app is itself a chaosD6 peer (libp2p + gossipsub over TCP) with no
WSL-side peer dependency.

**Status:** scaffold. Not yet built, not yet installed on device. The Kotlin
service + JNI bridge are structurally complete, but need the nodejs-mobile
prebuilt libraries fetched by `_tools/fetch_nodejs_mobile.sh` and a one-time
`./gradlew assembleRelease` to produce the AAR.

## What ships inside the APK

| Piece | Where it lands |
|---|---|
| `libnode.so` from nodejs-mobile v18.20.4 | `jniLibs/{arm64-v8a,x86_64}/libnode.so` (packaged automatically — nativeLibraryDir is exec-allowed on Android 14+) |
| JNI bridge | `cpp/native-lib.cpp` → `libnodejs_mobile_bridge.so` |
| Kotlin plugin + ForegroundService | AAR built from this folder |
| peer.mjs + node_modules | `assets/nodejs-project/` (staged from `game/` by `_tools/stage_peer_js.sh`, copied to `filesDir` on first launch) |
| GDScript autoload | `godot/scripts/EmbeddedPeer.gd` (added at wiring step; not committed yet) |

## Build sequence

```sh
cd chaosD6
# 1. One-time: fetch nodejs-mobile prebuilt + sample reference
_tools/fetch_nodejs_mobile.sh
# 2. Stage peer.mjs + minimal node_modules into assets/
_tools/stage_peer_js.sh
# 3. Build the plugin AAR
cd godot/android/plugins/nodejs_mobile
cp ~/path/to/godot-lib.release.aar libs/           # same AAR radicle_node uses
./gradlew assembleRelease
cp build/outputs/aar/nodejs_mobile-release.aar ./nodejs_mobile.aar
# 4. Build the APK (existing script, no changes required)
cd ../../../../..
_tools/build_android_apk.sh
```

## GDScript surface

```gdscript
var np = Engine.get_singleton("NodejsMobile")
np.connect("node_ready", func(port): print("peer up on ", port))
np.connect("node_stdout", _on_line)
np.connect("node_exit", _on_exit)
np.startNode("peer.mjs", {
    "PEER_LABEL": "mobile-dev",
    "CHARACTER_ID": "char_oran_rief",
    "CHAOSD6_MOBILE": "1",   # mobile branch of peer/adapter: no radicle writes
})
```

## Why `CHAOSD6_MOBILE=1`

Mobile peer is a FULL player (libp2p writer, round participant), but it does NOT
run radicle: no `rad`/`git`/`git-remote-rad` subprocesses, no OCI push, no
10-minute lottery participation. The desktop peer in the swarm handles all
radicle persistence. See `game/peer.mjs` and `game/radicle-adapter.mjs` for the
env-gated mobile branches.

## Known pitfalls (verify on first device test)

- **Single Node instance per process lifetime.** `node::Start` is not re-entrant.
  The service must survive Godot scene reloads; don't call `startNode` twice.
- **16KB page alignment.** The v18.20.4 prebuilt is 4KB-aligned → Play Store
  rejects when targetSdk is 35+. Dev-build (sideload) is fine. For production,
  run `_tools/build_nodejs_mobile_16k.sh` after the fetch script (source build
  of `main` @ d9552e0e, 1–3 h). The JNI bridge gets the 16KB link flags from
  `CMakeLists.txt`. Godot itself must be 4.5+ (4.3's engine lib is 4KB) — its
  AGP 8.6 template also 16KB-aligns the uncompressed libs inside the APK/AAB.
  Check a build with `zipalign -c -P 16 -v 4 <apk>`.
- **Cleartext loopback.** `AndroidManifest.xml` enables cleartext for
  127.0.0.1 only; the game's own WebSocket to the on-device peer uses it.
- **No C++ addons.** Audit (`find node_modules -name '*.node'`) ran clean on
  2026-11-07 — all deps pure JS.
- **Battery / doze.** The ForegroundService keeps the peer alive while the game
  is open. When the screen locks mid-planning, phase ticks stop; wake with a
  `PARTIAL_WAKE_LOCK` scoped to active-dimension state.
