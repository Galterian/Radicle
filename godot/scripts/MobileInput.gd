class_name MobileInput
extends Node
## Touch gesture router for the Godot client. Owns all phone input semantics in
## one place so CameraRig and HexMap don't each re-implement tap vs pan vs
## pinch. Attached as a sibling of CameraRig/HexMap under Main.
##
## Semantics (phone-only — desktop keeps the existing mouse paths untouched):
##   tap_at(viewport_pos)              — one finger, released < TAP_MOVE_PX from
##                                       press, not part of a drag/pinch
##   double_tap_at(viewport_pos)       — second tap within DOUBLE_TAP_MS of a
##                                       tap, within DOUBLE_TAP_PX
##   pan(relative)                     — one finger drag, delta in pixels
##   pinch(factor)                     — two-finger spread/pinch, multiplicative
##                                       zoom factor (> 1 zooms in)
##
## Everything is a signal — nothing is forwarded via get_tree() lookups, so
## reorganising scenes later doesn't break input.

signal tap_at(viewport_pos: Vector2)
signal double_tap_at(viewport_pos: Vector2)
signal pan(relative: Vector2)
signal pinch(factor: float)

const TAP_MOVE_PX := 12.0            # above this a touch is a drag, not a tap
const DOUBLE_TAP_MS := 320
const DOUBLE_TAP_PX := 48.0
const PINCH_DEADZONE := 1.5          # px of pair-distance change needed to emit

var _active: Dictionary = {}         # index:int -> { start:Vector2, pos:Vector2, started_ms:int, moved:bool }
var _last_tap_ms := 0
var _last_tap_pos := Vector2.ZERO
var _pair_prev_dist := -1.0          # tracks distance between two live fingers


func is_mobile() -> bool:
	return OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")


func _ready() -> void:
	# We want to see every touch — including those a UI control might eat —
	# so use `_input` not `_unhandled_input`. We never call set_input_as_handled;
	# UI buttons on the HUD still receive the emulated LMB event normally.
	set_process_input(true)


func _input(event: InputEvent) -> void:
	if event is InputEventScreenTouch:
		_on_touch(event)
	elif event is InputEventScreenDrag:
		_on_drag(event)
	elif event is InputEventMagnifyGesture:
		# Trackpad / phone magnify — direct factor from the OS.
		pinch.emit(event.factor)


func _on_touch(ev: InputEventScreenTouch) -> void:
	var idx := ev.index
	if ev.pressed:
		_active[idx] = {
			"start": ev.position,
			"pos": ev.position,
			"started_ms": Time.get_ticks_msec(),
			"moved": false,
		}
		if _active.size() == 2:
			_pair_prev_dist = _pair_distance()
		return
	# Release.
	var info: Variant = _active.get(idx, null)
	_active.erase(idx)
	# When any finger lifts, the pinch pair is broken; the remaining finger
	# becomes a fresh pan start (its "start" is already recorded).
	_pair_prev_dist = -1.0
	if info == null:
		return
	# A tap only counts if (a) only one finger was ever down during the gesture
	# and (b) it never moved past the slop threshold.
	if info.moved:
		return
	# If a second finger joined at any point, the first finger's release should
	# NOT fire a tap — the user was pinching, not tapping.
	if _active.size() > 0:
		return
	var now := Time.get_ticks_msec()
	var pos: Vector2 = info.pos
	if now - _last_tap_ms <= DOUBLE_TAP_MS and pos.distance_to(_last_tap_pos) <= DOUBLE_TAP_PX:
		double_tap_at.emit(pos)
		_last_tap_ms = 0        # consume so a 3rd tap doesn't chain
	else:
		tap_at.emit(pos)
		_last_tap_ms = now
		_last_tap_pos = pos


func _on_drag(ev: InputEventScreenDrag) -> void:
	var info: Variant = _active.get(ev.index, null)
	if info == null:
		# Drag before touch? Can happen on some stacks when the app regains
		# focus mid-gesture. Treat as a fresh touch so pan keeps working.
		_active[ev.index] = {"start": ev.position, "pos": ev.position, "started_ms": Time.get_ticks_msec(), "moved": true}
		return
	info.pos = ev.position
	if ev.position.distance_to(info.start) > TAP_MOVE_PX:
		info.moved = true
	if _active.size() >= 2:
		var d := _pair_distance()
		if _pair_prev_dist > 0.0 and absf(d - _pair_prev_dist) > PINCH_DEADZONE:
			var factor := d / _pair_prev_dist
			pinch.emit(factor)
			_pair_prev_dist = d
		elif _pair_prev_dist <= 0.0:
			_pair_prev_dist = d
		return
	# Single-finger drag → pan.
	pan.emit(ev.relative)


func _pair_distance() -> float:
	var pts: Array = []
	for k in _active.keys():
		pts.append((_active[k] as Dictionary).pos)
		if pts.size() == 2:
			break
	if pts.size() < 2:
		return -1.0
	return (pts[0] as Vector2).distance_to(pts[1] as Vector2)
