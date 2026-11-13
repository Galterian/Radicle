# RadicleNode plugin for Godot 4 (Android)

Runs `radicle-node` **in-process** (a JNI library, never an exec'd binary) so
the installed APK can save the player's profile into the `chaosD6-Profiles`
Radicle repo. The phone writes exactly one branch — `profile`, in its own
namespace — and seeds the repo with scope `followed`, so it never replicates
other players' profiles. No live dimension sync.

**Nothing in this directory has been built or test-installed on a device.** It
is a complete scaffold; expect to iterate once an APK boots on hardware.

## What ships inside the APK

| Piece | Where it lands |
|---|---|
| `libradicle_node_ffi.so` (ARM64, 16 KB-aligned) | `src/main/jniLibs/arm64-v8a/` → packaged in the AAR, loaded with `System.loadLibrary`. An ordinary native lib to Play: no exec, no `useLegacyPackaging` |
| Rust wrapper source | `godot/android/radicle-node/ffi/` (copied into the heartwood workspace at build time) |
| Kotlin plugin + ForegroundService | AAR built from this folder; the service runs in `android:process=":radicle"` |
| Node config template | `assets/radicle/config.template.json` |
| GDScript boot + `save_profile()` | `godot/scripts/RadicleBoot.gd`, autoloaded via `project.godot` |

## How a profile save works

`RadicleBoot.save_profile(dict)` → `RadicleNode.saveProfile` →
`RadicleNative.saveFile` (Rust), which:

1. on the first save on a device, fetches the repo from the OCI seed (node must be running);
2. commits `profile.json` onto `refs/namespaces/<NID>/refs/heads/profile` with libgit2;
3. signs refs (`refs/rad/sigrefs`) with the device key;
4. announces to the network; the OCI seed (scope `all`) picks it up.

That is what `git push rad profile` does on the desktop, minus the `git`
and `git-remote-rad` binaries. Radicle's protocol has no shallow fetch; the
`followed` scope is the equivalent of `--single-branch`.

## One-time repo setup (desktop + OCI)

```sh
# desktop: create the repo, then put its RID into RadicleBoot.gd PROFILES_RID
mkdir chaosD6-Profiles && cd chaosD6-Profiles && git init -b master
echo '# chaosD6 profiles' > README.md && git add . && git commit -m init
rad init --name chaosD6-Profiles --description "chaosD6 player profiles" --public --default-branch master
# OCI seed: replicate every player's namespace
rad seed <RID> --scope all
```

## Build sequence

Three steps, in order. Each is independent and idempotent.

### 1. Cross-compile the wrapper

```sh
cd chaosD6
export ANDROID_NDK_HOME=~/Android/Sdk/ndk/<r26+>          # or wherever
cargo install cargo-ndk                                   # one-off
rustup target add aarch64-linux-android                   # one-off
godot/android/radicle-node/build.sh                       # 10–20 min first run
```

Output: `godot/android/plugins/radicle_node/src/main/jniLibs/arm64-v8a/libradicle_node_ffi.so`.
Check alignment with `llvm-readelf -l <so> | grep LOAD` → `Align 0x4000`.

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
`arm64-v8a` only, which matches the jniLibs layout above.

## What's uncertain (fix on first device test)

- **Never compiled.** `ffi/src/lib.rs` was written against the heartwood
  `releases/1.10.3` sources but has not been through `cargo check` yet.
- **Unencrypted device key** — `init()` creates the key without a passphrase
  (no ssh-agent on Android). Anyone with root on the phone can read it.
- **Re-running the runtime** — `Runtime::run` is treated as single-shot; the
  service kills its `:radicle` process in `onDestroy` so each `start()` gets a
  fresh one.
- **Battery / doze** — run the node only around a save (start → save → stop)
  rather than for the whole session; that also keeps the `dataSync`
  foreground-service declaration in the Play Console easy to justify.
- **Config template** — only `{{ALIAS}}` is substituted; the OCI seed is
  hard-coded here and in `RadicleNodePlugin.kt`. Update both in lock-step with
  `infra/oci/seeder.json` if the seed changes.

## Debugging on-device

```sh
adb logcat -s radicle-node                 # the node (Rust `log` → logcat)
adb logcat -s RadicleNode:*                # the plugin
adb shell "run-as net.dimensions.radicle ls files/.radicle"
adb shell "run-as net.dimensions.radicle cat files/.radicle/config.json"
```
