package io.chaosd6.webview

// Godot 4 Android plugin: overlays an Android WebView on the Godot activity
// so the mobile client renders the exact same browser UI as the desktop
// (game/index.html + /css + /js) served by the embedded peer at
// http://127.0.0.1:<port>/.
//
// GDScript surface:
//   WebViewHud.showFullScreen(url: String)            — attach a full-screen
//     WebView over the Godot GLSurfaceView and load `url`. Idempotent: a
//     second call reuses the view and reloads.
//   WebViewHud.hide()                                 — detach and null out.
//   WebViewHud.setBackgroundTransparent(flag: Boolean) — if true, lets Godot
//     pixels show through for the WebView body background. The HTML must
//     also use transparent styles.
//
// Signals: page_loaded(url:String), load_error(code:int, description:String)

import android.content.Context
import android.graphics.Color
import android.util.Log
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.godotengine.godot.Godot
import org.godotengine.godot.plugin.GodotPlugin
import org.godotengine.godot.plugin.SignalInfo
import org.godotengine.godot.plugin.UsedByGodot

class WebViewHudPlugin(godot: Godot) : GodotPlugin(godot) {
    companion object {
        private const val TAG = "WebViewHud"
    }

    override fun getPluginName() = "WebViewHud"

    override fun getPluginSignals(): MutableSet<SignalInfo> = mutableSetOf(
        SignalInfo("page_loaded", String::class.java),
        SignalInfo("load_error", Integer::class.java, String::class.java),
    )

    private var webView: WebView? = null

    @UsedByGodot
    fun showFullScreen(url: String): Boolean {
        val act = activity ?: return false
        act.runOnUiThread {
            if (webView == null) {
                val wv = WebView(act).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                    settings.apply {
                        javaScriptEnabled = true
                        domStorageEnabled = true
                        // Needed so the browser UI's XHR/fetch to /status, /data/*,
                        // and WebSocket upgrade to ws://127.0.0.1:<port>/ succeed.
                        allowFileAccess = true
                        allowContentAccess = true
                        // The game is heavy on scrolling (hand, roster) — keep
                        // overview mode off so the layout isn't zoomed out.
                        useWideViewPort = false
                        loadWithOverviewMode = false
                        mediaPlaybackRequiresUserGesture = false
                        cacheMode = WebSettings.LOAD_DEFAULT
                        // Mixed-content allowed for 127.0.0.1 (never used for
                        // remote hosts — see network_security_config).
                        mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                    }
                    // Report page loads and errors back to GDScript so autoloads
                    // can decide what to show while the peer is still booting.
                    webViewClient = object : WebViewClient() {
                        override fun onPageFinished(view: WebView?, loadedUrl: String?) {
                            emitSignal("page_loaded", loadedUrl ?: "")
                        }
                        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                            val code = error?.errorCode ?: -1
                            val desc = error?.description?.toString() ?: ""
                            // Only surface the main-frame failure; subresources are noisy.
                            if (request?.isForMainFrame == true) {
                                emitSignal("load_error", code, desc)
                            }
                        }
                    }
                }
                // Attach to the activity's root content view so it floats over
                // the Godot GLSurfaceView. decorView's content frame is reliable
                // across Godot editor templates.
                val root = act.findViewById<ViewGroup>(android.R.id.content)
                root.addView(wv)
                webView = wv
                Log.i(TAG, "WebView attached, loading $url")
            }
            webView?.loadUrl(url)
        }
        return true
    }

    @UsedByGodot
    fun hide(): Boolean {
        val act = activity ?: return false
        act.runOnUiThread {
            val wv = webView
            if (wv != null) {
                (wv.parent as? ViewGroup)?.removeView(wv)
                wv.destroy()
                webView = null
            }
        }
        return true
    }

    @UsedByGodot
    fun setBackgroundTransparent(flag: Boolean) {
        val act = activity ?: return
        act.runOnUiThread {
            webView?.setBackgroundColor(if (flag) Color.TRANSPARENT else Color.WHITE)
        }
    }

    @UsedByGodot
    fun reload() {
        val act = activity ?: return
        act.runOnUiThread { webView?.reload() }
    }

    @UsedByGodot
    fun isAttached(): Boolean = webView != null
}
