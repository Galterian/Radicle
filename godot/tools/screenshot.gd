extends SceneTree
## Boots the main scene, waits for sprites/sounds to load, saves a PNG of the viewport and quits.
## Run from godot/ (needs a display):  Godot --path . -s tools/screenshot.gd [out.png] [frames]

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var out := args[0] if args.size() > 0 else "../../_tools/godot_screenshot.png"
	var frames := int(args[1]) if args.size() > 1 else 90
	var scene: PackedScene = load("res://scenes/Main.tscn")
	var node := scene.instantiate()
	get_root().add_child(node)
	for i in range(frames):
		await process_frame
	var img := get_root().get_viewport().get_texture().get_image()
	var err := img.save_png(out)
	print("screenshot ", out, " ", img.get_size(), " err=", err)
	quit(0)
