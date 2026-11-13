# RadicleNode plugin for Godot 4 (Android)

Runs `radicle-node` **in-process** (a JNI library, never an exec'd binary) as
the P2P write path of the team profile in the `chaosD6-Profiles` Radicle repo
(`rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH`), branch `teams/<Team>`. The phone seeds
the repo with scope `followed` (it follows the OCI seed), so it never
replicates other players' namespaces. No live dimension sync.

**Not test-installed on a device yet.** The library, AAR, APK and AAB build;
the commit path is covered by `game/tools/profile-sync-check.mjs` and
`profile-p2p-check.mjs` on the desktop.

## What ships inside the APK

| Piece | Where it lands |
|---|---|
| `libradicle_node_ffi.so` (ARM64, 16 KB-aligned) | `src/main/jniLibs/arm64-v8a/` → packaged in the AAR, loaded with `System.loadLibrary`. An ordinary native lib to Play: no exec, no `useLegacyPackaging` |
| Rust wrapper source | `godot/android/radicle-node/ffi/` (copied into the heartwood workspace at build time) |
| Kotlin plugin + ForegroundService | AAR built from this folder; the service runs in `android:process=":radicle"` |
| Node config template | `assets/radicle/config.template.json` |
| GDScript boot | `godot/scripts/RadicleBoot.gd`, autoloaded via `project.godot` (before `EmbeddedPeer`) |

## How a team-profile save works

The merge logic stays in `game/profile-radicle.mjs` / `profile-sync.mjs`
(nodejs-mobile). One key for everything: `RadicleNode.start(alias, rid,
identityPem)` derives the node key from `user://data/radicle/identity.pem` — the
key profile-sync signs with — so the NID **is** the device id in the team's
`owners`. (Whichever side runs first creates the file, exclusively.)

1. profile-sync builds the commit (`profile.json` only, parent = canonical tip)
   and POSTs it to the node's loopback bridge (`<RAD_HOME>/bridge.json`:
   `{port, token}`; EmbeddedPeer passes the path as `CHAOSD6_RADICLE_BRIDGE`).
2. The node rebuilds the identical commit with libgit2 — it refuses if the oid
   differs — sets `refs/namespaces/<NID>/refs/heads/teams/<Team>`, signs refs
   (`refs/rad/sigrefs`) and announces. First save on a device fetches the repo
   from the OCI seed.
3. The OCI seed fetches the namespace; `infra/oci/profiles-push.mjs`'s promoter
   moves the canonical `teams/<Team>` to it if the NID is an owner (or it is a
   first claim listing itself) and it is a fast-forward, then `git push rad`.
4. profile-sync polls the canonical tip (`PROFILES_BRIDGE_WAIT_MS`, 15 s). Not
   promoted in time, or node down → it pushes the **same commit** over HTTPS
   (`/profiles-push`), so the two paths never conflict.

Join requests (`profiles/<id>`) go the same way.

`rid` may be a comma-separated list: `RadicleBoot.gd` passes
`PROFILES_RID,DIMENSIONS_RID` (chaosD6-Profiles + chaosD6-Dimensions
`rad:z2xbfJfwT3kukR73m8LXmmuvchEwr`); each is seeded with scope `followed`.
`bridge.json` is `{port, token, nid, features: ["save","publish"]}`.

## How a dimension publish works (`POST /publish`)

Same token header (`x-bridge-token`), body ≤ 8 MiB (`/save`: ≤ 1 MiB):

```json
{ "rid": "rad:z2xbf…", "ref": "refs/heads/ActiveDimensions/<Name>",
  "files": { "ActiveDimensions/<Name>/dimension.json": "<utf8>", … },
  "remove": ["ActiveDimensions/<Name>/old.json"], "prune_prefix": "ActiveDimensions/",
  "name": "…", "email": "…", "timestamp": 1763000000, "message": "…", "seed": "<OCI NID>" }
```

- `rid` must be seeded by the node; `ref` must be a valid git ref under
  `refs/heads/ActiveDimensions/`. Every `files` / `remove` path must sit under
  `ActiveDimensions/<Name>/` (no `..`, leading `/`, empty or `.` segments).
  `remove`, `prune_prefix` are optional.
- Base = our own `refs/namespaces/<NID>/<ref>` tip (also the parent), else an
  empty tree with no parent. The repo is fetched from `seed` (45 s) if it is not
  local yet.
- `prune_prefix` drops every entry of that directory except the one leading to
  `ActiveDimensions/<Name>`; then `remove` (files or whole directories), then
  `files` are written as nested trees. Directories left empty disappear.
- Same tree as the base → `{ok:true, oid:<tip>, unchanged:true}`, no commit
  (no tip and an empty tree → `{ok:false}`). Else commit (author = committer,
  tz 0), set the namespaced ref, sign refs, announce →
  `{ok:true, oid}`. Failures: `{ok:false, error}` (HTTP 200); bad token 403;
  other paths / oversize body 404.

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

- **Unencrypted device key** — the keystore and identity.pem have no
  passphrase (no ssh-agent on Android). Anyone with root on the phone can read them.
- **Existing installs** — a device whose `.radicle/keys` predates identity.pem
  derivation gets "radicle key … is not the profile identity" from `start()`;
  clear app data (or delete `files/.radicle`) once.
- **Re-running the runtime** — `Runtime::run` is treated as single-shot; the
  service kills its `:radicle` process in `onDestroy` so each `start()` gets a
  fresh one.
- **Battery / doze** — the node runs for the session; HTTPS covers saves while
  it is down. Keep the `dataSync` foreground-service declaration justified in
  the Play Console.
- **Config template** — only `{{ALIAS}}` is substituted; the OCI seed is
  hard-coded here and in `RadicleNodePlugin.kt`. Update both in lock-step with
  `infra/oci/seeder.json` if the seed changes.

## Debugging on-device

```sh
adb logcat -s radicle-node                 # the node (Rust `log` → logcat)
adb logcat -s RadicleNode:*                # the plugin
adb shell "run-as net.dimensions.radicle ls files/.radicle"
adb shell "run-as net.dimensions.radicle cat files/.radicle/config.json"
adb shell "run-as net.dimensions.radicle cat files/.radicle/bridge.json"   # present while the node runs
```
