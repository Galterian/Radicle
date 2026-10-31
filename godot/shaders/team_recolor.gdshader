shader_type canvas_item;
// Recolours the WBC3 player-colour ramp. The extractor normalises palette slots 224..238 to pure
// (0, g, 0); any saturated-green texel is treated as a team pixel and tinted with `team_color`
// scaled by its brightness, preserving the ramp's shading.
// Note: in fragment() the built-in COLOR is already texture * modulate, so the modulate is
// captured in vertex() and applied explicitly.
uniform vec4 team_color : source_color = vec4(0.1, 0.9, 0.2, 1.0);
uniform float chroma_tolerance : hint_range(0.0, 0.3) = 0.08;

varying vec4 modulate;

void vertex() {
	modulate = COLOR;
}

void fragment() {
	vec4 c = texture(TEXTURE, UV);
	float lim = chroma_tolerance * c.g + 0.02;
	float m = step(0.15, c.g) * step(c.r, lim) * step(c.b, lim);
	COLOR = vec4(mix(c.rgb, team_color.rgb * c.g, m), c.a) * modulate;
}
