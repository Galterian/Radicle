extends Node
## On Android, once the embedded peer is up and serving HTTP, attach an Android
## WebView overlay that loads http://127.0.0.1:<port>/ — i.e. the SAME browser
## UI (game/index.html + /css + /js) the desktop uses. The Godot HUD scene
## stays loaded underneath but is visually covered; input is captured by the
## WebView.
##
## On desktop (or Android without the WebViewHud plugin), this is a no-op.
##
## Flow:
##   EmbeddedPeer.peer_url_ready(ws://127.0.0.1:7401/)
##     → convert ws → http, call WebViewHud.showFullScreen(http://127.0.0.1:7401/)
##     → WebView loads index.html, WS to peer established from inside the page.

signal web_hud_loaded(url: String)
signal web_hud_failed(code: int, description: String)

var _plugin: Object = null
var _loaded_url := ""


func _ready() -> void:
    if OS.get_name() != "Android":
        return
    if not Engine.has_singleton("WebViewHud"):
        print("[MobileHudWebView] WebViewHud plugin not available — Godot HUD stays visible")
        return
    _plugin = Engine.get_singleton("WebViewHud")
    _plugin.connect("page_loaded", _on_page_loaded)
    _plugin.connect("load_error", _on_load_error)

    var ep := get_node_or_null("/root/EmbeddedPeer")
    if ep == null:
        push_warning("[MobileHudWebView] EmbeddedPeer autoload missing — nothing to overlay")
        return
    if ep.active and ep.peer_url != "":
        _show_for_ws(ep.peer_url)
    else:
        ep.peer_url_ready.connect(_show_for_ws)


func _show_for_ws(ws_url: String) -> void:
    # Peer URL is "ws://127.0.0.1:<port>/" — the HTTP endpoint on the same
    # port serves the UI. index.html's own JS will reopen the WebSocket.
    var http_url := ws_url
    if http_url.begins_with("ws://"):
        http_url = "http://" + http_url.substr(5)
    elif http_url.begins_with("wss://"):
        http_url = "https://" + http_url.substr(6)
    # The embedded peer already IS the session: ?peer=<port> makes launcher.js
    # skip the dimension picker (which needs the desktop ui-server's /api/*);
    # mobile=1 switches the page to its phone layout + touch input.
    var m := RegEx.create_from_string("^http://127\\.0\\.0\\.1:(\\d+)/?$").search(http_url)
    if m:
        http_url = "http://127.0.0.1:%s/?peer=%s&mobile=1" % [m.get_string(1), m.get_string(1)]
    print("[MobileHudWebView] loading ", http_url)
    _plugin.showFullScreen(http_url)


func _on_page_loaded(url: String) -> void:
    _loaded_url = url
    print("[MobileHudWebView] page loaded: ", url)
    web_hud_loaded.emit(url)


func _on_load_error(code: int, description: String) -> void:
    push_warning("[MobileHudWebView] load error %d: %s" % [code, description])
    web_hud_failed.emit(code, description)
