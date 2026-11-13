package io.chaosd6.radicle

// Godot 4 Android plugin: runs radicle-node in-process from
// libradicle_node_ffi.so (built by godot/android/radicle-node/build.sh). The
// library is System.loadLibrary'd, not exec()'d. The one program it runs is
// the bundled git (libgit.so, for `git upload-pack`; see installGit).
// GDScript entry points:
//
//   RadicleNode.start(alias, rid, identityPem: String) -> String     # NID, or "error: …"
//   RadicleNode.stop()                                    -> Boolean
//   RadicleNode.isRunning()                               -> Boolean
//   RadicleNode.nid()                                     -> String
//   RadicleNode.home()                                    -> String  # RAD_HOME
//
// start(): first-run key + config + seeding policy (RadicleNative.init, in
// this process), then RadicleNodeService runs the node in the ":radicle"
// process so a Rust abort can't take Godot down. The node key is derived from
// identityPem — the profile key game/profile-sync.mjs signs team branches
// with — so the NID is the id in a team's `owners`. Saves come from
// profile-sync.mjs (nodejs-mobile) through the node's loopback bridge,
// <home()>/bridge.json; EmbeddedPeer.gd passes that path as
// CHAOSD6_RADICLE_BRIDGE. No git/rad binaries.
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
import android.system.ErrnoException
import android.system.Os
import android.util.Log
import androidx.core.app.NotificationCompat
import org.godotengine.godot.Godot
import org.godotengine.godot.plugin.GodotPlugin
import org.godotengine.godot.plugin.UsedByGodot
import java.io.File

// The chaosD6 OCI seed (infra/oci/seeder.json). Followed so `followed`-scope
// fetches pull its refs; also the peer the first save fetches the repo from.
private const val OCI_SEED_NID = "z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT"

/** JNI surface of libradicle_node_ffi.so; every call returns "error: …" on failure. */
object RadicleNative {
    init { System.loadLibrary("radicle_node_ffi") }
    @JvmStatic external fun init(home: String, alias: String, config: String, rid: String, follow: String, identity: String): String
    @JvmStatic external fun run(home: String): String
    @JvmStatic external fun stop(): String
}

internal fun radHome(ctx: Context): File = File(ctx.filesDir, ".radicle").apply { mkdirs() }

class RadicleNodePlugin(godot: Godot) : GodotPlugin(godot) {
    override fun getPluginName() = "RadicleNode"

    @UsedByGodot
    fun start(alias: String, rid: String, identityPem: String): String {
        val ctx = activity ?: return "error: no activity"
        val home = radHome(ctx)
        val tpl = ctx.assets.open("radicle/config.template.json").bufferedReader().use { it.readText() }
        val nid = RadicleNative.init(home.absolutePath, alias, tpl.replace("{{ALIAS}}", alias), rid, OCI_SEED_NID, identityPem)
        if (nid.startsWith("error:")) return nid

        val intent = Intent(ctx, RadicleNodeService::class.java).putExtra("radHome", home.absolutePath)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent) else ctx.startService(intent)
        return nid
    }

    @UsedByGodot
    fun home(): String {
        val ctx = activity ?: return ""
        return radHome(ctx).absolutePath
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
            .setContentText("Saving your team profile over Radicle")
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
        installGit(File(home))
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

    /**
     * radicle-node serves peers' fetches (the OCI seed pulling our profile refs) by spawning
     * `git upload-pack`, resolved on PATH — the only variable it passes to the child. git ships as
     * libgit.so (godot/android/radicle-node/build_git.sh) in nativeLibraryDir, the one place an app
     * may exec from; <RAD_HOME>/bin/git -> it (re-made each start: nativeLibraryDir changes on
     * update), and that dir goes first on this process's PATH (libc environ, which Rust reads).
     */
    private fun installGit(home: File) {
        val target = File(applicationInfo.nativeLibraryDir, "libgit.so")
        if (!target.exists()) {
            Log.w("RadicleNode", "no $target (native libs not extracted?): peers cannot fetch from this node")
            return
        }
        val bin = File(home, "bin").apply { mkdirs() }
        val link = File(bin, "git")
        try {
            link.delete()
            Os.symlink(target.absolutePath, link.absolutePath)
            val path = Os.getenv("PATH") ?: "/system/bin"
            if (!path.split(':').contains(bin.absolutePath)) Os.setenv("PATH", "${bin.absolutePath}:$path", true)
        } catch (e: ErrnoException) {
            Log.e("RadicleNode", "git setup failed: $e")
        }
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
