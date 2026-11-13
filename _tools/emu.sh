#!/usr/bin/env bash
# Drive the Windows Android emulator from inside WSL.
#
# Starts the stack (headless emulator on Windows + adb server + WSL adb proxy + ws-scrcpy),
# installs the release APK, launches the game, and exposes logs / screenshots.
#
# Usage:
#   bash _tools/emu.sh up                 # start emulator + adb + proxy + ws-scrcpy
#   bash _tools/emu.sh install [--release|--debug|APK]
#                                         # default: --release (_tools/chaosd6-release.apk)
#                                         # --debug installs _tools/chaosd6-debug.apk
#   bash _tools/emu.sh run                # launch the game
#   bash _tools/emu.sh deploy [APK]       # up + install + run (one-shot)
#   bash _tools/emu.sh logs               # live logcat filtered to the game
#   bash _tools/emu.sh shot [FILE]        # screencap to FILE (default: _tools/screen.png)
#   bash _tools/emu.sh view [--restart|--new]
#                                         # open native scrcpy window; default
#                                         # just mirrors the running game.
#                                         # --restart force-stops + relaunches
#                                         # --new    also wipes app data first
#   bash _tools/emu.sh status             # what's running
#   bash _tools/emu.sh down               # stop WSL side (emulator stays running on Windows)
#   bash _tools/emu.sh kill-emu           # stop Windows emulator too
#
# adb resolution: $ADB -> ~/android-tools/platform-tools/adb -> adb on PATH
# ws-scrcpy UI:   http://localhost:8000

set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

# --- config ---------------------------------------------------------------
# Known package IDs per build variant.
PKG_RELEASE="net.dimensions.radicle"
PKG_DEBUG="io.chaosd6.dimensions"

# `install` writes the active package to this file so run/logs/shot can pick it up.
PKG_STATE_FILE="$(dirname "$0")/.emu-logs/current.pkg"

# Resolve the package for a non-install command: explicit env var > state file > release.
pick_pkg() {
  if [[ -n "${CHAOSD6_PKG:-}" ]]; then echo "$CHAOSD6_PKG"; return; fi
  if [[ -s "$PKG_STATE_FILE" ]]; then cat "$PKG_STATE_FILE"; return; fi
  echo "$PKG_RELEASE"
}
PKG="$(pick_pkg)"

AVD="${CHAOSD6_AVD:-Pixel_7_API_34}"
GPU="${CHAOSD6_GPU:-host}"      # host | swiftshader_indirect | auto
MEM="${CHAOSD6_MEM:-1792}"      # MB of guest RAM (floor is ~1536)
CORES="${CHAOSD6_CORES:-2}"     # vCPUs for the guest
WIN_SDK="${WIN_SDK:-/mnt/c/Users/grozdevg/android-sdk}"
WIN_EMU="$WIN_SDK/emulator/emulator.exe"
WIN_ADB="$WIN_SDK/platform-tools/adb.exe"
LINUX_ADB="${ADB:-$HOME/android-tools/platform-tools/adb}"
ADB_PROXY_JS="$HOME/adb-proxy.js"
WS_SCRCPY_DIST="$HOME/ws-scrcpy/dist"
LOG_DIR="$REPO/_tools/.emu-logs"
mkdir -p "$LOG_DIR"

# Pick adb: prefer Linux one, fall back to Windows exe (works via WSL interop).
if [[ -x "$LINUX_ADB" ]]; then
  ADB="$LINUX_ADB"
elif command -v adb >/dev/null; then
  ADB="$(command -v adb)"
else
  ADB="$WIN_ADB"
fi

# Resolve nvm so ws-scrcpy / proxy run under the right node.
load_nvm() {
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null 2>&1 || true
}

# Windows gateway IP (adb server lives there).
win_ip() { ip route show default | awk '/default/ {print $3; exit}'; }

# --- helpers --------------------------------------------------------------
pid_of() { pgrep -f "$1" | head -1; }

is_up() {
  curl -fsS -o /dev/null --max-time 2 http://localhost:8000/ 2>/dev/null
}

wait_boot() {
  local max="${1:-60}"
  echo "[emu] waiting for device boot (up to $((max*2))s)..."
  for _ in $(seq 1 "$max"); do
    if "$ADB" shell getprop sys.boot_completed 2>/dev/null | grep -q 1; then
      echo "[emu] boot complete."
      return 0
    fi
    sleep 2
  done
  echo "[emu] boot timed out." >&2
  return 1
}

# --- commands -------------------------------------------------------------
cmd_up() {
  # 1. Make sure the Windows adb server is up and bound on all interfaces
  #    (so the WSL side can reach it) BEFORE we check for devices.
  "$WIN_ADB" kill-server >/dev/null 2>&1 || true
  "$WIN_ADB" -a start-server >"$LOG_DIR/adb-server.log" 2>&1 || true
  sleep 2

  # 2. Does the AVD look like it's actually running and responsive?
  emu_alive() {
    "$WIN_ADB" devices 2>/dev/null | grep -q "emulator-.*device$" \
      && "$WIN_ADB" shell true 2>/dev/null
  }

  if emu_alive; then
    echo "[emu] Windows emulator already attached."
  else
    echo "[emu] starting headless emulator on Windows (AVD=$AVD, gpu=$GPU)..."
    nohup "$WIN_EMU" -avd "$AVD" -no-window -no-audio -no-snapshot-save \
      -gpu "$GPU" -memory "$MEM" -cores "$CORES" \
      >"$LOG_DIR/emulator.log" 2>&1 &
    disown || true
  fi

  # 3. Make sure WSL localhost:5037 is OUR proxy (node), not a stray WSL adb daemon.
  #    `adb` auto-starts a local server at 5037 whenever a client runs without
  #    a reachable server — that server has no devices and shadows the proxy.
  proxy_up() {
    ss -tlnp 2>/dev/null | awk -v p=127.0.0.1:5037 '$4==p {print $NF}' | grep -q node
  }
  if ! proxy_up; then
    pkill -9 adb 2>/dev/null || true     # kill WSL adb daemons (process name match)
    sleep 1
    load_nvm
    WIN_IP="$(win_ip)" nohup node "$ADB_PROXY_JS" >"$LOG_DIR/adb-proxy.log" 2>&1 &
    disown || true
    sleep 1
    proxy_up || { echo "[emu] adb-proxy failed to bind 127.0.0.1:5037" >&2; exit 1; }
  fi

  # 5. ws-scrcpy — needs `adb` on its PATH so it can push scrcpy-server.jar.
  if ! is_up; then
    load_nvm
    (
      cd "$WS_SCRCPY_DIST"
      export PATH="$(dirname "$ADB"):$PATH"
      nohup node ./index.js >"$LOG_DIR/ws-scrcpy.log" 2>&1 &
      disown
    ) || true
    for _ in $(seq 1 20); do is_up && break; sleep 1; done
  fi

  if ! wait_boot; then
    echo "[emu] first boot attempt failed. Nuking QEMU and retrying once..."
    cmd_kill_emu
    nohup "$WIN_EMU" -avd "$AVD" -no-window -no-audio -no-snapshot-save \
      -gpu "$GPU" -memory "$MEM" -cores "$CORES" \
      >"$LOG_DIR/emulator.log" 2>&1 &
    disown || true
    "$WIN_ADB" kill-server >/dev/null 2>&1 || true
    nohup "$WIN_ADB" -a nodaemon server >"$LOG_DIR/adb-server.log" 2>&1 &
    disown || true
    sleep 2
    wait_boot 90 || { echo "[emu] still not booting — check $LOG_DIR/emulator.log" >&2; exit 1; }
  fi

  "$ADB" devices
  echo "[emu] ws-scrcpy UI: http://localhost:8000"
}

cmd_install() {
  # Pick APK + package based on first arg: --release / --debug / explicit path / nothing (= release).
  local apk pkg
  case "${1:-}" in
    --release|"")
      apk="$REPO/_tools/chaosd6-release.apk"; pkg="$PKG_RELEASE" ;;
    --debug)
      apk="$REPO/_tools/chaosd6-debug.apk";   pkg="$PKG_DEBUG" ;;
    *)
      apk="$1"
      # Explicit APK path: try to extract its real package from the badging dump
      # if aapt is available; otherwise fall back to the current state.
      if command -v aapt >/dev/null; then
        pkg="$(aapt dump badging "$apk" 2>/dev/null | awk -F"'" '/package: name=/ {print $2; exit}')"
      fi
      pkg="${pkg:-$(pick_pkg)}"
      ;;
  esac
  [[ -f "$apk" ]] || { echo "[emu] APK not found: $apk" >&2; exit 2; }
  echo "[emu] installing $apk  (package: $pkg)"
  "$ADB" install -r "$apk"
  mkdir -p "$(dirname "$PKG_STATE_FILE")"
  echo "$pkg" > "$PKG_STATE_FILE"
  PKG="$pkg"
}

cmd_run() {
  # --new|--fresh|--wipe clears app data before launch (destroys saves) so the
  # app starts from true cold boot. Without it, Godot resumes its save file.
  local wipe=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --new|--fresh|--wipe) wipe=1 ;;
      *) echo "[emu] run: unknown option $1" >&2; return 2 ;;
    esac
    shift
  done
  if [[ $wipe -eq 1 ]]; then
    echo "[emu] wiping $PKG app data (NEW GAME — saves lost)"
    "$ADB" shell pm clear "$PKG" >/dev/null || true
  fi

  # Return the currently top-resumed component (e.g. "io.chaosd6.dimensions/com.godot.game.GodotApp").
  top_component() {
    "$ADB" shell dumpsys activity activities 2>/dev/null \
      | awk '/topResumedActivity=/ {for (i=1;i<=NF;i++) if ($i ~ /\//) {print $i; exit}}'
  }
  # Known foreground-stealers to swat if they resume.
  local INTRUDERS=(
    com.google.android.gm                       # Gmail
    com.google.android.googlequicksearchbox     # Google Search / Assistant
    com.google.android.apps.messaging           # Messages
    com.android.vending                         # Play Store
  )

  # Prep: unlock, kill intruders + stale PKG, swipe up to dismiss any lockscreen.
  "$ADB" shell wm dismiss-keyguard >/dev/null 2>&1 || true
  "$ADB" shell input keyevent 224 >/dev/null 2>&1 || true   # WAKEUP
  for app in "${INTRUDERS[@]}"; do
    "$ADB" shell am force-stop "$app" >/dev/null 2>&1 || true
  done
  "$ADB" shell am force-stop "$PKG" >/dev/null 2>&1 || true
  "$ADB" shell input keyevent 3 >/dev/null 2>&1 || true     # HOME

  # Launch and verify PKG actually ends up on top. Retry a few times if something grabs focus.
  local tries=0 top
  while : ; do
    "$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
    for _ in $(seq 1 10); do
      sleep 1
      top="$(top_component || true)"
      [[ "$top" == "$PKG/"* ]] && break
    done
    [[ "$top" == "$PKG/"* ]] && break
    tries=$((tries+1))
    if [[ $tries -ge 3 ]]; then
      echo "[emu] gave up: top activity is $top (expected $PKG). You may need to tap/dismiss manually." >&2
      break
    fi
    # Something else grabbed focus — kill it and retry.
    local intruder_pkg="${top%%/*}"
    if [[ -n "$intruder_pkg" && "$intruder_pkg" != "$PKG" ]]; then
      echo "[emu] intruder $intruder_pkg stole focus — force-stopping and retrying ($tries/3)"
      "$ADB" shell am force-stop "$intruder_pkg" >/dev/null 2>&1 || true
      "$ADB" shell input keyevent 3 >/dev/null 2>&1 || true   # HOME
    fi
  done

  local pid
  pid="$("$ADB" shell pidof "$PKG" | tr -d '\r\n')"
  echo "[emu] launched $PKG pid=$pid (top=$top)"
}

cmd_deploy() {
  cmd_up
  cmd_install "$@"   # --release (default) / --debug / explicit path all pass through
  cmd_run
  echo "[emu] deploy done. Package: $PKG"
  echo "[emu] Logs: bash $0 logs    Screenshot: bash $0 shot"
}

cmd_logs() {
  local pid
  pid="$("$ADB" shell pidof "$PKG" | tr -d '\r\n')"
  if [[ -z "$pid" ]]; then
    echo "[emu] $PKG not running; falling back to full logcat filtered by tag." >&2
    exec "$ADB" logcat -v time godot:V '*:S'
  fi
  echo "[emu] tailing logcat for $PKG (pid=$pid) — Ctrl-C to stop"
  exec "$ADB" logcat --pid="$pid" -v time
}

cmd_shot() {
  local out="${1:-$REPO/_tools/screen.png}"
  "$ADB" exec-out screencap -p >"$out"
  echo "[emu] wrote $out"
}

cmd_view() {
  # Launch Genymobile scrcpy on Windows (reliable live mirror). ws-scrcpy's
  # bundled server can't capture Android 14 headless; use this instead.
  #
  # Default behaviour: JUST MIRROR. Don't touch the running game — otherwise
  # a `deploy` followed by `view` would force-stop the APK while AssetBootstrap
  # is still fetching assets, aborting the sentinel write and triggering a
  # full re-download on the next launch.
  #   view               # mirror only (default — safe for `deploy && view`)
  #   view --restart     # force-stop + relaunch (good for dead-hero reset)
  #   view --new         # pm clear + launch (NEW GAME, saves + assets lost)
  local restart=0 wipe=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --restart|--relaunch) restart=1 ;;
      --new|--fresh|--wipe) restart=1; wipe=1 ;;
      --no-restart|--keep|--continue) restart=0 ;;   # kept for back-compat; now a no-op (default)
      *) echo "[emu] view: unknown option $1" >&2; return 2 ;;
    esac
    shift
  done
  if [[ $restart -eq 1 ]]; then
    if "$ADB" shell true >/dev/null 2>&1; then
      if [[ $wipe -eq 1 ]]; then
        echo "[emu] wiping $PKG app data (NEW GAME — saves + downloaded assets lost)"
        "$ADB" shell pm clear "$PKG" >/dev/null || true
      fi
      echo "[emu] (re)launching $PKG"
      cmd_run
    else
      echo "[emu] skipping restart — adb not reachable (run \`bash $0 up\` first)" >&2
    fi
  fi
  local SCRCPY="${SCRCPY:-/mnt/c/Users/grozdevg/scrcpy/scrcpy-win64-v5.0.1/scrcpy.exe}"
  [[ -x "$SCRCPY" ]] || { echo "[emu] scrcpy not found at $SCRCPY" >&2; exit 2; }
  echo "[emu] launching scrcpy window (chaosD6 — emulator-5554)"
  # --mouse-bind=++++:++++  : stop right-click from sending Android BACK (which
  #                           Godot treats as "quit app"). All mouse buttons now
  #                           forward as normal clicks instead of system keys.
  nohup "$SCRCPY" -s emulator-5554 \
    --window-title="chaosD6 (emulator-5554)" --no-audio \
    --mouse-bind=++++:++++ \
    >"$LOG_DIR/scrcpy.log" 2>&1 &
  disown || true
  sleep 1
  echo "[emu] see $LOG_DIR/scrcpy.log if nothing appears"
}

cmd_status() {
  echo "ADB binary:   $ADB"
  echo "Package:      $PKG  (change via --debug/--release on install, or \$CHAOSD6_PKG)"
  echo "Windows adb:  $("$WIN_ADB" devices 2>&1 | tr '\n' ' ')"
  echo "WSL proxy:    $(ss -tlnp 2>/dev/null | awk '/127.0.0.1:5037/ {print $NF; exit}' || echo none)"
  echo "ws-scrcpy:    $(is_up && echo 'up (localhost:8000)' || echo down)"
  echo "Game pid:     $("$ADB" shell pidof "$PKG" 2>/dev/null | tr -d '\r\n' || echo not-running)"
}

cmd_down() {
  pkill -f adb-proxy.js 2>/dev/null || true
  pkill -f 'ws-scrcpy/dist/index.js' 2>/dev/null || true
  echo "[emu] WSL proxy + ws-scrcpy stopped. Windows emulator still running."
}

cmd_kill_emu() {
  cmd_down
  # Try graceful shutdown first via adb (gives QEMU time to release the AVD lock).
  "$ADB" emu kill >/dev/null 2>&1 || true
  "$WIN_ADB" kill-server >/dev/null 2>&1 || true

  # Then taskkill the whole family. `/T` kills child processes too.
  # NOTE: the running binary is `qemu-system-x86_64-headless.exe` when launched
  # with -no-window, NOT `qemu-system-x86_64.exe`. Kill both to be safe.
  local tk=/mnt/c/Windows/System32/taskkill.exe
  for img in emulator.exe \
             qemu-system-x86_64.exe        qemu-system-x86_64-headless.exe \
             qemu-system-aarch64.exe       qemu-system-aarch64-headless.exe \
             emulator-crash-service.exe    crashpad_handler.exe \
             adb.exe; do
    "$tk" /IM "$img" /F /T >/dev/null 2>&1 || true
  done

  # Wait for the real culprit (headless qemu) to actually die.
  for _ in $(seq 1 15); do
    /mnt/c/Windows/System32/tasklist.exe /FI "IMAGENAME eq qemu-system-x86_64-headless.exe" 2>/dev/null \
      | grep -qi qemu-system || break
    sleep 1
  done

  # Clear stale AVD locks. QEMU writes `hardware-qemu.ini.lock` as a DIRECTORY
  # (not a file), so plain `rm -f` leaves it behind and blocks the next launch
  # with: "Running multiple emulators with the same AVD". Use rm -rf.
  local avd_dir="/mnt/c/Users/grozdevg/.android/avd/${AVD}.avd"
  if [[ -d "$avd_dir" ]]; then
    rm -rf "$avd_dir"/hardware-qemu.ini.lock 2>/dev/null || true
    rm -f  "$avd_dir"/*.lock                 2>/dev/null || true
  fi
  echo "[emu] Windows emulator + adb killed."
}

# --- dispatch -------------------------------------------------------------
cmd="${1:-}"
shift || true
case "$cmd" in
  up)        cmd_up "$@" ;;
  install)   cmd_install "$@" ;;
  run)       cmd_run "$@" ;;
  deploy)    cmd_deploy "$@" ;;
  logs)      cmd_logs "$@" ;;
  shot)      cmd_shot "$@" ;;
  view)      cmd_view "$@" ;;
  status)    cmd_status "$@" ;;
  down)      cmd_down "$@" ;;
  kill-emu)  cmd_kill_emu "$@" ;;
  ""|-h|--help|help)
    sed -n '2,20p' "$0"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    sed -n '2,20p' "$0"
    exit 2
    ;;
esac
