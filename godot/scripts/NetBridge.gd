class_name NetBridge
extends Node
## Stub for the decentralised layer. Mirrors the message shapes the Node peer (peer.mjs)
## exchanges — commit (hash of intents), reveal (intents + nonce), apply_state — so a
## WebSocket/libp2p transport can be dropped in later without touching Game.gd.
## In offline mode it echoes locally with a tiny delay so the round loop is exercised.

signal commit_received(peer_id: String, round_no: int, hash: String)
signal reveal_received(peer_id: String, round_no: int, intents: Array, nonce: String)
signal state_received(state: Dictionary)
signal block_received(block: Dictionary)

var peer_id := "godot-%08x" % (randi() & 0xFFFFFFFF)
var offline := true
var dimension_id := "Ashfall-Micro"


func commit(round_no: int, intents: Array) -> String:
	var nonce := "%08x%08x" % [randi(), randi()]
	var h := sha256_hex(JSON.stringify(intents) + ":" + nonce)
	if offline:
		await get_tree().create_timer(0.05).timeout
		commit_received.emit(peer_id, round_no, h)
	return nonce


func reveal(round_no: int, intents: Array, nonce: String) -> void:
	if offline:
		await get_tree().create_timer(0.05).timeout
		reveal_received.emit(peer_id, round_no, intents, nonce)


func publish_block(block: Dictionary) -> void:
	if offline:
		block_received.emit(block)


func publish_state(state: Dictionary) -> void:
	if offline:
		state_received.emit(state)


static func sha256_hex(s: String) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(s.to_utf8_buffer())
	return ctx.finish().hex_encode()
