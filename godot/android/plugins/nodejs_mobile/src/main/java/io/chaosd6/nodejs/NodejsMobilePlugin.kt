package io.chaosd6.nodejs

// Godot 4 Android plugin: hosts a nodejs-mobile runtime and launches peer.mjs
// on it. The Node process runs inside a ForegroundService so Android doesn't
// reap it when the game backgrounds. GDScript surface:
//
//   NodejsMobile.startNode(mainScript: String, env: Dictionary) -> Int
//     Returns 0 on success, non-zero on error. Starts peer.mjs; stdout/stderr
//     are relayed via `node_stdout(line)` / `node_stderr(line)` signals.
//     Fires `node_ready(port)` when the first line matching
//     "peer listening on 127.0.0.1:(\\d+)" is observed. (This is how we hand
//     the WebSocket port back to NetBridge.gd without hard-coding 7401.)
//
//   NodejsMobile.stopNode() -> Boolean
//     Posts a shutdown message on the control channel; the Node runtime calls
//     `process.exit(0)` from peer.mjs. The service stops after the thread
//     joins (or 2s timeout, whichever comes first).
//
//   NodejsMobile.sendToNode(channel: String, msg: String)
//     Forwards a message onto a named channel inside Node. Used for the
//     eventual bidirectional bridge (shutdown, config updates). The JS side
//     listens via `process._linkedBinding('chaosd6-bridge').on(channel, cb)`
//     (shim installed by the service before node::Start — see native-lib.cpp).
//
//   Signals: node_ready(port:int), node_stdout(line:String),
//            node_stderr(line:String), node_exit(code:int)
//
// Single-instance: node::Start is not re-entrant. A second startNode() after
// a successful first returns 1 and emits a warning line. Scene reloads must
// NOT restart the peer.

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.godotengine.godot.Dictionary
import org.godotengine.godot.Godot
import org.godotengine.godot.plugin.GodotPlugin
import org.godotengine.godot.plugin.SignalInfo
import org.godotengine.godot.plugin.UsedByGodot
import java.io.File

class NodejsMobilePlugin(godot: Godot) : GodotPlugin(godot) {
    companion object {
        private const val TAG = "NodejsMobile"
        private const val READY_RE = """peer listening on 127\.0\.0\.1:(\d+)"""
    }

    override fun getPluginName() = "NodejsMobile"

    override fun getPluginSignals(): MutableSet<SignalInfo> = mutableSetOf(
        SignalInfo("node_ready", Integer::class.java),
        SignalInfo("node_stdout", String::class.java),
        SignalInfo("node_stderr", String::class.java),
        SignalInfo("node_exit", Integer::class.java),
    )

    @Volatile private var started = false
    private val readyPattern = Regex(READY_RE)

    @UsedByGodot
    fun startNode(mainScript: String, env: Dictionary): Int {
        if (started) {
            Log.w(TAG, "startNode called twice — node::Start is single-shot per process")
            emitSignal("node_stderr", "startNode called twice; ignored")
            return 1
        }
        val ctx = activity ?: return 2

        // Two provisioning modes:
        //   (a) Absolute path (release APKs, PeerBootstrap-managed): the GDScript
        //       side has already downloaded peer-pack.zip into user://peer/ and
        //       hands us the globalized filesystem path. No asset copy needed.
        //   (b) Relative path (debug APKs, pre-lazy-peer builds): the AAR shipped
        //       assets/nodejs-project/, we extract it into filesDir/nodejs-project
        //       on first run keyed on PackageInfo.lastUpdateTime.
        val scriptPath: File
        val projectDir: File
        if (mainScript.startsWith("/")) {
            scriptPath = File(mainScript)
            projectDir = scriptPath.parentFile ?: ctx.filesDir
        } else {
            projectDir = ensureProjectDir(ctx)
            scriptPath = File(projectDir, mainScript)
        }
        if (!scriptPath.exists()) {
            emitSignal("node_stderr", "main script missing at ${scriptPath.absolutePath}")
            return 3
        }

        // Serialize env dictionary → "KEY=VALUE" array for ProcessBuilder-style
        // consumption on the service side. Node will see them via process.env.
        val envList = ArrayList<String>()
        for (entry in env.entries) {
            val k = entry.key.toString()
            val v = entry.value?.toString() ?: ""
            envList.add("$k=$v")
        }

        val intent = Intent(ctx, NodejsMobileService::class.java).apply {
            putExtra("mainScript", scriptPath.absolutePath)
            putExtra("projectDir", projectDir.absolutePath)
            putExtra("env", envList.toTypedArray())
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent)
        } else {
            ctx.startService(intent)
        }
        // Register ourselves with the service as the signal sink. The service
        // calls back into onNodeStdout/Stderr/Exit, which fan out as GodotPlugin
        // signals on the engine thread.
        NodejsMobileService.sink = this
        started = true
        return 0
    }

    @UsedByGodot
    fun stopNode(): Boolean {
        val ctx = activity ?: return false
        val ok = ctx.stopService(Intent(ctx, NodejsMobileService::class.java))
        started = false
        NodejsMobileService.sink = null
        return ok
    }

    @UsedByGodot
    fun sendToNode(channel: String, msg: String) {
        NodejsMobileService.postMessage(channel, msg)
    }

    @UsedByGodot
    fun isRunning(): Boolean = started && NodejsMobileService.pid > 0

    // ---- callbacks from the service / native layer ----

    internal fun onNodeStdout(line: String) {
        emitSignal("node_stdout", line)
        val m = readyPattern.find(line) ?: return
        val port = m.groupValues[1].toIntOrNull() ?: return
        emitSignal("node_ready", port)
    }

    internal fun onNodeStderr(line: String) {
        emitSignal("node_stderr", line)
    }

    internal fun onNodeExit(code: Int) {
        emitSignal("node_exit", code)
        started = false
    }

    // ---- helpers ----

    private fun ensureProjectDir(ctx: Context): File {
        // First-run copy from assets/nodejs-project/ into filesDir/nodejs-project.
        // Keyed on PackageInfo.lastUpdateTime: if the APK was updated since the
        // last copy, re-stage. On a cold install the sentinel file is absent
        // so we always copy.
        val dst = File(ctx.filesDir, "nodejs-project")
        val sentinel = File(dst, ".apk-stamp")
        val prefs = ctx.getSharedPreferences("NodejsMobile", Context.MODE_PRIVATE)
        val lastStamp = prefs.getLong("apkStamp", -1L)
        val currentStamp = ctx.packageManager
            .getPackageInfo(ctx.packageName, 0)
            .lastUpdateTime

        if (dst.exists() && sentinel.exists() && lastStamp == currentStamp) {
            return dst
        }
        if (dst.exists()) dst.deleteRecursively()
        dst.mkdirs()
        copyAssetFolder(ctx, "nodejs-project", dst)
        sentinel.writeText(currentStamp.toString())
        prefs.edit().putLong("apkStamp", currentStamp).apply()
        return dst
    }

    private fun copyAssetFolder(ctx: Context, assetPath: String, outDir: File) {
        val assets = ctx.assets
        val entries = assets.list(assetPath) ?: return
        if (entries.isEmpty()) {
            // Leaf: copy as file.
            assets.open(assetPath).use { input ->
                outDir.parentFile?.mkdirs()
                outDir.outputStream().use { out -> input.copyTo(out) }
            }
            return
        }
        outDir.mkdirs()
        for (name in entries) {
            val child = File(outDir, name)
            val childAssetPath = "$assetPath/$name"
            // node_modules directories can be nested deep — recurse.
            copyAssetFolder(ctx, childAssetPath, child)
        }
    }
}
