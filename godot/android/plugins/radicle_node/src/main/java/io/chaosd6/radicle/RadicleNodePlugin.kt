package io.chaosd6.radicle

// Godot 4 Android plugin: runs radicle-node in-process from
// libradicle_node_ffi.so (built by godot/android/radicle-node/build.sh). The
// library is System.loadLibrary'd, never exec()'d, so the APK carries no
// executable. GDScript entry points:
//
//   RadicleNode.start(alias: String, rid: String) -> String          # NID, or "error: …"
//   RadicleNode.saveProfile(rid, branch, file, json) -> String       # commit id, or "error: …"
//   RadicleNode.stop()                                                -> Boolean
//   RadicleNode.isRunning()                                           -> Boolean
//   RadicleNode.nid()                                                 -> String
//
// start(): first-run identity + config + seeding policy (RadicleNative.init,
// in this process), then RadicleNodeService runs the node in the ":radicle"
// process so a Rust abort can't take Godot down. saveProfile() commits one
// file onto `branch` in our own namespace, signs refs and announces — the
// phone's whole write path, no git/rad binaries. It talks to the node over the
// control socket, so the node must be running for the announce (and for the
// first save on a device, which fetches the repo from the OCI seed).
//
// NOT TESTED on-device.

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.util.Log
import androidx.core.app.NotificationCompat
import org.godotengine.godot.Godot
import org.godotengine.godot.plugin.GodotPlugin
import org.godotengine.godot.plugin.UsedByGodot
import java.io.File

// The chaosD6 OCI seed (infra/oci/seeder.json). Followed so `followed`-scope
// fetches pull its refs; also the peer the first saveProfile() fetches from.
private const val OCI_SEED_NID = "z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT"

/** JNI surface of libradicle_node_ffi.so; every call returns "error: …" on failure. */
object RadicleNative {
    init { System.loadLibrary("radicle_node_ffi") }
    @JvmStatic external fun init(home: String, alias: String, config: String, rid: String, follow: String): String
    @JvmStatic external fun run(home: String): String
    @JvmStatic external fun stop(): String
    @JvmStatic external fun saveFile(home: String, rid: String, branch: String, file: String,
                                     bytes: ByteArray, message: String, seed: String): String
}

internal fun radHome(ctx: Context): File = File(ctx.filesDir, ".radicle").apply { mkdirs() }

class RadicleNodePlugin(godot: Godot) : GodotPlugin(godot) {
    override fun getPluginName() = "RadicleNode"

    @UsedByGodot
    fun start(alias: String, rid: String): String {
        val ctx = activity ?: return "error: no activity"
        val home = radHome(ctx)
        val tpl = ctx.assets.open("radicle/config.template.json").bufferedReader().use { it.readText() }
        val nid = RadicleNative.init(home.absolutePath, alias, tpl.replace("{{ALIAS}}", alias), rid, OCI_SEED_NID)
        if (nid.startsWith("error:")) return nid

        val intent = Intent(ctx, RadicleNodeService::class.java).putExtra("radHome", home.absolutePath)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent) else ctx.startService(intent)
        return nid
    }

    @UsedByGodot
    fun saveProfile(rid: String, branch: String, file: String, json: String): String {
        val ctx = activity ?: return "error: no activity"
        return RadicleNative.saveFile(radHome(ctx).absolutePath, rid, branch, file,
            json.toByteArray(Charsets.UTF_8), "profile: update $file", OCI_SEED_NID)
    }

    @UsedByGodot
    fun stop(): Boolean {
        val ctx = activity ?: return false
        return ctx.stopService(Intent(ctx, RadicleNodeService::class.java))
    }

    // The node lives in another process, so ask the filesystem: the runtime
    // binds the control socket while running and removes it on clean exit.
    @UsedByGodot
    fun isRunning(): Boolean {
        val ctx = activity ?: return false
        return File(radHome(ctx), "node/control.sock").exists()
    }

    @UsedByGodot
    fun nid(): String {
        val ctx = activity ?: return ""
        val pub = File(radHome(ctx), "keys/radicle.pub")
        // OpenSSH format "ssh-ed25519 <base64> <comment>"; the z6Mk… NID is what start() returns.
        return if (pub.exists()) pub.readText().trim() else ""
    }
}

/** Runs in android:process=":radicle" (see AndroidManifest.xml). */
class RadicleNodeService : Service() {
    companion object {
        const val CHANNEL_ID = "radicle_node"
        const val NOTIFICATION_ID = 1337
    }

    private var node: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val home = intent?.getStringExtra("radHome") ?: return START_NOT_STICKY

        createChannel()
        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("chaosD6 — profile sync")
            .setContentText("Saving your profile over Radicle")
            .setSmallIcon(android.R.drawable.stat_sys_upload) // placeholder
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notif)
        }

        // The runtime is single-shot per process (like node::Start); a second
        // start intent while it runs is a no-op.
        if (node?.isAlive == true) return START_NOT_STICKY
        node = Thread({
            val result = RadicleNative.run(home)
            if (result.isNotEmpty()) Log.e("RadicleNode", "node exited: $result")
            stopSelf()
        }, "radicle-node").apply { start() }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        RadicleNative.stop()
        node?.join(10_000)
        super.onDestroy()
        // Fresh process for the next start(): never re-enter the runtime.
        Process.killProcess(Process.myPid())
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        mgr.createNotificationChannel(NotificationChannel(
            CHANNEL_ID, "Radicle node", NotificationManager.IMPORTANCE_LOW
        ).apply { description = "Runs while your profile is being saved to Radicle." })
    }
}
