class_name CameraRig
extends Camera2D
## Middle/right-drag pan, wheel zoom, optional follow target, C to recenter.

var follow: Node2D = null
var _dragging := false
var _target_zoom := 1.0
const ZOOM_MIN := 0.45
const ZOOM_MAX := 2.6


func _ready() -> void:
	position_smoothing_enabled = true
	position_smoothing_speed = 8.0
	_target_zoom = zoom.x


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_MIDDLE:
			_dragging = event.pressed
		elif event.button_index == MOUSE_BUTTON_WHEEL_UP and event.pressed:
			_target_zoom = clampf(_target_zoom * 1.12, ZOOM_MIN, ZOOM_MAX)
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN and event.pressed:
			_target_zoom = clampf(_target_zoom / 1.12, ZOOM_MIN, ZOOM_MAX)
	elif event is InputEventMouseMotion and _dragging:
		follow = null
		position -= event.relative / zoom.x
	elif event.is_action_pressed("recenter"):
		recenter()


func _process(dt: float) -> void:
	zoom = zoom.lerp(Vector2.ONE * _target_zoom, minf(1.0, dt * 10.0))
	if follow != null and is_instance_valid(follow):
		position = follow.position


func recenter() -> void:
	var g := get_parent()
	if g != null and g.has_method("player_entity"):
		var e = g.player_entity()
		if e != null:
			follow = e
			position = e.position
