class_name Pathfinding
## A* over the known hex set — port of findPath() in game/js/hex.js.
## `blocked` : Dictionary of "q,r" -> true (occupied hexes), `known` : Callable(Vector2i)->bool.

const MAX_EXPAND := 20000


## Returns the path as Array[Vector2i] *excluding* `from`, ending at `to` (or the nearest
## free neighbour of `to` when the goal itself is blocked). Empty when unreachable.
static func find_path(from: Vector2i, to: Vector2i, blocked: Dictionary, known: Callable) -> Array[Vector2i]:
	var empty: Array[Vector2i] = []
	if from == to:
		return empty
	var goal := to
	if blocked.has(Hex.key_of(to)):
		# Goal occupied: route to the closest known, free neighbour of the goal instead.
		var best := Vector2i.ZERO
		var best_d := 1 << 30
		var found := false
		for n in Hex.neighbours(to):
			if not known.call(n) or blocked.has(Hex.key_of(n)):
				continue
			var d := Hex.distance(from, n)
			if d < best_d:
				best_d = d
				best = n
				found = true
		if not found:
			return empty
		goal = best
		if goal == from:
			return empty

	var open := PriorityQueue.new()
	var came: Dictionary = {}
	var g: Dictionary = {Hex.key_of(from): 0}
	open.push(from, Hex.distance(from, goal))
	var expanded := 0
	while not open.is_empty():
		var cur: Vector2i = open.pop()
		if cur == goal:
			return _reconstruct(came, cur, from)
		expanded += 1
		if expanded > MAX_EXPAND:
			break
		var ck := Hex.key_of(cur)
		var cg: int = g[ck]
		for n in Hex.neighbours(cur):
			var nk := Hex.key_of(n)
			if not known.call(n):
				continue
			if blocked.has(nk) and n != goal:
				continue
			var ng := cg + 1
			if not g.has(nk) or ng < g[nk]:
				g[nk] = ng
				came[nk] = cur
				open.push(n, ng + Hex.distance(n, goal))
	return empty


static func _reconstruct(came: Dictionary, cur: Vector2i, from: Vector2i) -> Array[Vector2i]:
	var out: Array[Vector2i] = []
	var c := cur
	while c != from:
		out.push_front(c)
		var k := Hex.key_of(c)
		if not came.has(k):
			break
		c = came[k]
	return out


## Minimal binary heap keyed by int priority (ties FIFO).
class PriorityQueue:
	var _items: Array = []  # [priority, seq, Vector2i]
	var _seq := 0

	func is_empty() -> bool:
		return _items.is_empty()

	func push(v: Vector2i, pri: int) -> void:
		_items.append([pri, _seq, v])
		_seq += 1
		var i := _items.size() - 1
		while i > 0:
			var p := (i - 1) >> 1
			if _less(_items[i], _items[p]):
				var t = _items[i]
				_items[i] = _items[p]
				_items[p] = t
				i = p
			else:
				break

	func pop() -> Vector2i:
		var top: Array = _items[0]
		var last: Array = _items.pop_back()
		if not _items.is_empty():
			_items[0] = last
			var i := 0
			var n := _items.size()
			while true:
				var l := 2 * i + 1
				var r := l + 1
				var m := i
				if l < n and _less(_items[l], _items[m]):
					m = l
				if r < n and _less(_items[r], _items[m]):
					m = r
				if m == i:
					break
				var t = _items[i]
				_items[i] = _items[m]
				_items[m] = t
				i = m
		return top[2]

	static func _less(a: Array, b: Array) -> bool:
		return a[0] < b[0] or (a[0] == b[0] and a[1] < b[1])
