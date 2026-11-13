package io.chaosd6.nodejs

// Foreground service that owns the Node.js runtime thread. One instance per
// app process; a second startService Intent is a no-op (node::Start can't be
// re-entered). Keeps a persistent low-importance notification so Doze doesn't
// kill the peer while the game is open.
//
// The actual node::Start call is in the JNI layer (native-lib.cpp); this
// class spawns a worker thread, loads libnodejs_mobile_bridge.so, and
// forwards the plugin's env + script path. stdout/stderr lines emerge via
// the native layer calling back into onNativeStdout/Stderr (JNI static
// methods), which fan out to the registered plugin sink.

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

class NodejsMobileService : Service() {
    companion object {
        private const val TAG = "NodejsMobileSvc"
        const val CHANNEL_ID = "nodejs_mobile"
        const val NOTIFICATION_ID = 1338

        @Volatile var pid: Long = 0
        @Volatile var sink: NodejsMobilePlugin? = null
        @Volatile private var nodeThread: Thread? = null

        init {
            // Loads libnode.so (packaged as a jniLib) and our JNI bridge.
            // Order matters: libnode must be present before the bridge's
            // dlopen hooks resolve.
            try {
                System.loadLibrary("node")
                System.loadLibrary("nodejs_mobile_bridge")
            } catch (t: Throwable) {
                Log.e(TAG, "native lib load failed: ${t.message}", t)
            }
        }

        // JNI entry: start node::Start on the current thread. Returns the
        // process exit code when node loop ends. Native code also installs
        // stdout/stderr dup2 so lines come back through the callbacks below.
        @JvmStatic external fun nativeStartNode(argv: Array<String>, envp: Array<String>): Int

        // JNI entry: post a message onto a named channel inside the running
        // Node instance. No-op if Node is not running.
        @JvmStatic external fun nativePostMessage(channel: String, msg: String)

        // Called by the native layer when a stdout/stderr line is available.
        @JvmStatic
        fun onNativeStdout(line: String) {
            Log.i(TAG, "stdout: $line")
            sink?.onNodeStdout(line)
        }

        @JvmStatic
        fun onNativeStderr(line: String) {
            Log.w(TAG, "stderr: $line")
            sink?.onNodeStderr(line)
        }

        fun postMessage(channel: String, msg: String) {
            if (pid == 0L) return
            try {
                nativePostMessage(channel, msg)
            } catch (t: UnsatisfiedLinkError) {
                Log.e(TAG, "nativePostMessage not linked: ${t.message}")
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val mainScript = intent?.getStringExtra("mainScript")
        val projectDir = intent?.getStringExtra("projectDir")
        val env = intent?.getStringArrayExtra("env") ?: emptyArray()
        if (mainScript.isNullOrEmpty() || projectDir.isNullOrEmpty()) {
            Log.e(TAG, "missing mainScript / projectDir extras")
            return START_NOT_STICKY
        }
        if (nodeThread != null) {
            Log.w(TAG, "node thread already running; onStartCommand ignored")
            return START_STICKY
        }

        startInForeground()

        nodeThread = Thread({
            pid = android.os.Process.myPid().toLong()
            val argv = arrayOf("node", mainScript)
            val code = try {
                nativeStartNode(argv, env)
            } catch (t: Throwable) {
                Log.e(TAG, "nativeStartNode threw: ${t.message}", t)
                -1
            }
            pid = 0
            sink?.onNodeExit(code)
            stopSelf()
        }, "nodejs-mobile").apply { isDaemon = false; start() }

        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        // Node runs in-process; actual shutdown is via `process.exit(0)` from
        // JS, triggered through the bridge channel. Here we just forget our
        // handles and let the thread die with the process if it's still alive.
        nodeThread = null
        pid = 0
    }

    private fun startInForeground() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
                mgr.createNotificationChannel(NotificationChannel(
                    CHANNEL_ID, "chaosD6 peer", NotificationManager.IMPORTANCE_LOW
                ).apply { description = "Keeps the embedded game peer alive while the app is open." })
            }
        }
        val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("chaosD6 — peer")
            .setContentText("Hosting the embedded game peer")
            .setSmallIcon(android.R.drawable.stat_sys_download) // placeholder
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notif)
        }
    }
}
