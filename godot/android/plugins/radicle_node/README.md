# RadicleNode plugin for Godot 4 (Android)

Runs a `radicle-node` process alongside the Godot game on Android, so the
installed APK is itself a Radicle peer that replicates dimensions.

**Nothing in this directory has been built or test-installed on a device.** It
is a complete scaffold; expect to iterate once an APK boots on hardware.

## What ships inside the APK

| Piece | Where it lands |
|---|---|
| `radicle-node` native binary (ARM64) | `lib/arm64-v8a/libradicle-node.so` (packaged as a `.so` so Android's installer puts it in `nativeLibraryDir`, which is exec-allowed on Android 14+) |
| Kotlin plugin + ForegroundService | AAR built from this folder |
| Node config template | `assets/radicle/config.template.json` |
| GDScript boot | `godot/scripts/RadicleBoot.gd`, autoloaded via `project.godot` |

## Build sequence

Three steps, in order. Each is independent and idempotent.

### 1. Cross-compile `radicle-node`

```sh
cd chaosD6
export ANDROID_NDK_HOME=~/Android/Sdk/ndk/26.3.11579264   # or wherever
cargo install cargo-ndk                                   # one-off
rustup target add aarch64-linux-android                   # one-off
godot/android/radicle-node/build.sh                       # 10–20 min first run
```

Output: `godot/android/build/libs/arm64-v8a/libradicle-node.so`

### 2. Build the plugin AAR

```sh
cd godot/android/plugins/radicle_node
# Supply the Godot engine's android lib (ships with the editor):
cp ~/path/to/godot-lib.release.aar libs/
./gradlew assembleRelease
cp build/outputs/aar/radicle_node-release.aar ./radicle_node.aar
```

The `radicle_node.gdap` descriptor + `radicle_node.aar` pair is what Godot
expects. Keep both next to each other inside `godot/android/plugins/`.

### 3. Export the AAB

```sh
# Make sure godot/android/build is the "custom build template" (one-time via
# the editor: Project → Install Android Build Template…).
godot --headless --path godot --export-release "Android Play Store (AAB)" \
      ../_tools/chaosd6-release.aab
```

The export preset's `Android Play Store (AAB)` already enables gradle_build +
`arm64-v8a` only, which matches the libs/ layout above.

## What's uncertain (fix on first device test)

- **`exec()` from `nativeLibraryDir`** — on Android 14+ non-NDK executables
  may be blocked by SELinux. If that bites: switch to copying the binary into
  `ctx.filesDir`, `chmod 0700`, and set `android:allowNativeHeapPointerTagging="false"`
  in the plugin manifest.
- **`rad auth` passphrase handshake** — we pipe empty + `RAD_PASSPHRASE=""`.
  If the heartwood tag we build moved to an interactive flow, the first-run
  `start()` will hang. Timeout + fall back to `--stdin` with a null byte.
- **Battery / doze** — the ForegroundService stays alive while the game is
  open, but Android will kill the gossip side on screen-off. Fix by registering
  for a `PARTIAL_WAKE_LOCK` while a dimension is live (not while idle).
- **Config template substitution** — only `{{ALIAS}}` is substituted; the OCI
  seed is hard-coded. If the seed IP changes, this template needs updating in
  lock-step with `infra/oci/seeder.json`.
- **Seeding scope** — the policy is `default: "block"` and we `seed <RID>
  --scope all`. The project RID still contains the codebase branches (master,
  feature/*). Phones therefore replicate the game source history too. Fixing
  this cleanly is tracked as task #6 ("split codebase vs dimensions into
  separate RIDs"); until then the Android storage grows with the codebase.

## Debugging on-device

```sh
adb logcat -s radicle-node                 # the node's own stdout/stderr
adb logcat -s RadicleNode:*                # the plugin
adb shell "run-as net.dimensions.radicle ls files/.radicle"
adb shell "run-as net.dimensions.radicle cat files/.radicle/config.json"
```

## When to tear this out

If/when `peer.mjs` is ported to GDScript (or run under nodejs-mobile), the
Radicle node becomes just one of many libp2p processes you need to supervise;
at that point the plugin's `start()`/`stop()` surface area grows. The Kotlin
service skeleton is designed to be a thin wrapper around any native sidecar
process, so retrofitting a second native binary is a copy-paste of the
`ProcessBuilder` block, not a rewrite.
