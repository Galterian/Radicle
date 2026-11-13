package io.chaosd6.radicle

// Godot 4 Android plugin: wraps the lifecycle of a bundled `radicle-node`
// binary (shipped as libradicle-node.so inside the APK's native lib dir, then
// marked executable at first launch). GDScript gets four entry points:
//
//   RadicleNode.start(alias: String, projectRid: String) -> String   # NID
//   RadicleNode.stop()                                               -> Boolean
//   RadicleNode.isRunning()                                          -> Boolean
//   RadicleNode.nid()                                                -> String
//
// The process runs under a ForegroundService (RadicleNodeService) so Android
// doesn't reap it mid-game. First launch: extracts libradicle-node.so to the
// app's internal files dir with 0700 perms, creates an identity by running
// `radicle-node auth --alias <ALIAS>` with an empty passphrase, writes the
// template config.json, then spawns the daemon.
//
// NOT TESTED on-device. Known uncertain bits:
//   * Some Android 14+ devices refuse to exec() files not inside the app's
//     nativeLibraryDir — we may need to keep it as "lib*.so" there instead of
//     moving to filesDir. If exec fails with EACCES on 14+, revert to
//     applicationInfo.nativeLibraryDir path. See comment in `nodeBinary()`.
//   * `rad auth` in heartwood 1.x reads passphrase from stdin; we pipe "" and
//     rely on empty-passphrase → unencrypted key. If the UX changed, catch
//     the prompt and retry with -q.

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.godotengine.godot.Godot
import org.godotengine.godot.plugin.GodotPlugin
import org.godotengine.godot.plugin.UsedByGodot
import java.io.File
import java.io.FileOutputStream

class RadicleNodePlugin(godot: Godot) : GodotPlugin(godot) {
    override fun getPluginName() = "RadicleNode"

    @UsedByGodot
    fun start(alias: String, projectRid: String): String {
        val ctx = activity ?: return ""
        val radHome = ensureRadHome(ctx)
        val bin = nodeBinary(ctx)

        if (!File(radHome, "keys/radicle").exists()) {
            runAuth(bin, radHome, alias)
            writeConfig(ctx, radHome, alias)
            seedProject(bin, radHome, projectRid)
        }

        val intent = Intent(ctx, RadicleNodeService::class.java).apply {
            putExtra("binary", bin.absolutePath)
            putExtra("radHome", radHome.absolutePath)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent)
        } else {
            ctx.startService(intent)
        }
        return readNid(radHome)
    }

    @UsedByGodot
    fun stop(): Boolean {
        val ctx = activity ?: return false
        return ctx.stopService(Intent(ctx, RadicleNodeService::class.java))
    }

    @UsedByGodot
    fun isRunning(): Boolean = RadicleNodeService.pid > 0

    @UsedByGodot
    fun nid(): String {
        val ctx = activity ?: return ""
        return readNid(ensureRadHome(ctx))
    }

    // ---- helpers ----

    private fun ensureRadHome(ctx: Context): File {
        val home = File(ctx.filesDir, ".radicle")
        home.mkdirs()
        File(home, "keys").mkdirs()
        File(home, "storage").mkdirs()
        return home
    }

    private fun nodeBinary(ctx: Context): File {
        // Android 14+: nativeLibraryDir is exec-allowed, filesDir is not. We
        // keep the binary where the packager put it rather than copying.
        return File(ctx.applicationInfo.nativeLibraryDir, "libradicle-node.so")
    }

    private fun runAuth(bin: File, home: File, alias: String) {
        val pb = ProcessBuilder(bin.absolutePath, "auth", "--alias", alias)
            .redirectErrorStream(true)
        pb.environment()["RAD_HOME"] = home.absolutePath
        pb.environment()["RAD_PASSPHRASE"] = ""
        val p = pb.start()
        p.outputStream.close()
        p.inputStream.bufferedReader().forEachLine { /* drain */ }
        p.waitFor()
    }

    private fun writeConfig(ctx: Context, home: File, alias: String) {
        val tpl = ctx.assets.open("radicle/config.template.json").bufferedReader().use { it.readText() }
        val filled = tpl.replace("{{ALIAS}}", alias)
        File(home, "config.json").writeText(filled)
    }

    private fun seedProject(bin: File, home: File, rid: String) {
        val pb = ProcessBuilder(bin.absolutePath, "seed", rid, "--scope", "all")
            .redirectErrorStream(true)
        pb.environment()["RAD_HOME"] = home.absolutePath
        pb.start().waitFor()
    }

    private fun readNid(home: File): String {
        val nidFile = File(home, "node-nid.txt")
        if (nidFile.exists()) return nidFile.readText().trim()
        val keys = File(home, "keys/radicle.pub")
        return if (keys.exists()) keys.readText().trim() else ""
    }
}

class RadicleNodeService : Service() {
    companion object {
        @Volatile var pid: Long = 0
        const val CHANNEL_ID = "radicle_node"
        const val NOTIFICATION_ID = 1337
    }

    private var process: Process? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val bin = intent?.getStringExtra("binary") ?: return START_NOT_STICKY
        val home = intent.getStringExtra("radHome") ?: return START_NOT_STICKY

        createChannel()
        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("chaosD6 — dimensions node")
            .setContentText("Seeding dimensions over Radicle")
            .setSmallIcon(android.R.drawable.stat_sys_download) // placeholder
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notif)
        }

        val pb = ProcessBuilder(bin, "--listen", "0.0.0.0:8776")
            .redirectErrorStream(true)
            .directory(File(home).parentFile)
        pb.environment()["RAD_HOME"] = home
        pb.environment()["RUST_LOG"] = "warn"
        process = pb.start()
        pid = process?.pid() ?: 0

        // Drain stdout/stderr into logcat so the device log is useful.
        Thread {
            process?.inputStream?.bufferedReader()?.forEachLine { android.util.Log.i("radicle-node", it) }
        }.start()

        return START_STICKY
    }

    override fun onDestroy() {
        process?.destroy()
        process?.waitFor()
        pid = 0
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        mgr.createNotificationChannel(NotificationChannel(
            CHANNEL_ID, "Radicle node", NotificationManager.IMPORTANCE_LOW
        ).apply { description = "Keeps the dimensions node alive while the app is open." })
    }
}
