class_name WavLoader
## Minimal RIFF/WAVE reader -> AudioStreamWAV (8/16-bit PCM, mono/stereo). WBC3 speech is
## 22 kHz 16-bit mono; everything else we just pass through as PCM.

static func load_wav(abs_path: String) -> AudioStreamWAV:
	if abs_path == "" or not FileAccess.file_exists(abs_path):
		return null
	var f := FileAccess.open(abs_path, FileAccess.READ)
	if f == null:
		return null
	var bytes := f.get_buffer(f.get_length())
	f.close()
	if bytes.size() < 12 or bytes.slice(0, 4).get_string_from_ascii() != "RIFF" or bytes.slice(8, 12).get_string_from_ascii() != "WAVE":
		return null
	var pos := 12
	var fmt_tag := 1
	var channels := 1
	var rate := 22050
	var bits := 16
	var data := PackedByteArray()
	while pos + 8 <= bytes.size():
		var cid := bytes.slice(pos, pos + 4).get_string_from_ascii()
		var csz := bytes.decode_u32(pos + 4)
		var body := pos + 8
		if cid == "fmt ":
			fmt_tag = bytes.decode_u16(body)
			channels = bytes.decode_u16(body + 2)
			rate = bytes.decode_u32(body + 4)
			bits = bytes.decode_u16(body + 14)
		elif cid == "data":
			var end := mini(body + csz, bytes.size())
			data = bytes.slice(body, end)
		pos = body + csz + (csz & 1)
	if data.is_empty() or (fmt_tag != 1 and fmt_tag != 0xFFFE):
		return null
	var s := AudioStreamWAV.new()
	s.mix_rate = rate
	s.stereo = channels >= 2
	if bits == 8:
		# WAV 8-bit is unsigned; Godot wants signed.
		for i in range(data.size()):
			data[i] = (data[i] - 128) & 0xFF
		s.format = AudioStreamWAV.FORMAT_8_BITS
	elif bits == 16:
		s.format = AudioStreamWAV.FORMAT_16_BITS
	elif bits == 24 or bits == 32:
		# Down-convert to 16-bit.
		var step := bits / 8
		var out := PackedByteArray()
		out.resize((data.size() / step) * 2)
		var j := 0
		for i in range(0, data.size() - step + 1, step):
			out[j] = data[i + step - 2]
			out[j + 1] = data[i + step - 1]
			j += 2
		data = out
		s.format = AudioStreamWAV.FORMAT_16_BITS
	else:
		return null
	s.data = data
	return s
