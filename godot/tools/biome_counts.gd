extends SceneTree
## Prints biome counts over a square hex window for a raw dim seed, as a JSON
## object with sorted keys, so the output can be diffed byte-for-byte against the
## browser mirror:
##
##   _tools/godot --headless --path godot -s tools/biome_counts.gd ++ 0xddf9bd5f -20 20
##   node -e "import('./game/js/biome.js').then(m=>{const b=m.biomeFor('0xddf9bd5f');const c={};
##     for(let q=-20;q<20;q++)for(let r=-20;r<20;r++){const k=b.biomeAt(q,r);c[k]=(c[k]||0)+1}
##     console.log(JSON.stringify(Object.fromEntries(Object.entries(c).sort())))})"
##
## Also prints a per-hex FNV-1a digest of the biome strings so a count match can't
## hide two compensating mismatches.

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var seed_hex: String = args[0] if args.size() > 0 else "0xddf9bd5f"
	var lo: int = int(args[1]) if args.size() > 1 else -20
	var hi: int = int(args[2]) if args.size() > 2 else 20
	var b := Biome.new(seed_hex)
	var counts: Dictionary = {}
	var digest := 0x811c9dc5
	for q in range(lo, hi):
		for r in range(lo, hi):
			var k := b.biome_at(q, r)
			counts[k] = int(counts.get(k, 0)) + 1
			var s := "%s@%d,%d;" % [k, q, r]
			for i in range(s.length()):
				digest ^= s.unicode_at(i)
				digest = (digest * 0x01000193) & 0xFFFFFFFF
	var keys := counts.keys()
	keys.sort()
	var parts: Array = []
	for k in keys:
		parts.append("\"%s\":%d" % [k, counts[k]])
	print("{" + ",".join(parts) + "}")
	print("digest=%08x" % digest)
	quit()
