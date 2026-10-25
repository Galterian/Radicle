#!/usr/bin/env python3
"""Decode WBC3 transition tiles into (owning_biome, foreign_biome, edge_mask) records.

For every TRANSITION-role BMP in the extracted WBC3 archive, this tool:
  1. Converts and hex-masks the BMP into a PNG under assets/terrain/transitions/.
  2. Samples the pixel colour at the 6 hex edge midpoints (in Hex.DIRS order:
     E, NE, NW, W, SW, SE).
  3. Classifies each edge as "owning" (0) or "foreign" (1) by comparing the edge
     sample to the average colour of base tiles for the owning biome and the
     foreign biome (or to the tile centre as fallback).
  4. Packs the 6 bits into an edge_mask (bit i = edge i).
  5. Writes assets/terrain/terrain_transitions.json keyed by
     owning_biome -> foreign_biome -> [{code, edge_mask, path}, ...].

Idempotent: re-running overwrites PNGs and the JSON.
"""
import json
import math
import os
import re
import sys

from PIL import Image, ImageDraw

CHAOS_ROOT  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPPER_ROOT = os.path.dirname(CHAOS_ROOT)
EXTRACTED   = os.path.join(MAPPER_ROOT, "extracted")
DECODE_PATH = "/tmp/wbc3_tile_decode.json"
if not os.path.isfile(DECODE_PATH):
    # Fall back to the WSL mirror when running under native Windows.
    alt = r"\\wsl.localhost\Ubuntu\tmp\wbc3_tile_decode.json"
    if os.path.isfile(alt):
        DECODE_PATH = alt
DECODE = json.load(open(DECODE_PATH))

# WBC3 BMP geometry.
TILE_W, TILE_H = 320, 240

# Single-letter biome letter -> chaosD6 terrain key. Keep in sync with
# tools/import_wbc3_terrain.py CHAOS_TO_FOLDER / MapGen.BIOME_FILL.
BIOME_LETTER = {
    "G": "grass",       "D": "dirt",
    "H": "high_grass",  "E": "high_dirt",
    "I": "snow",        "S": "desert",
    "J": "jungle",      "K": "rock",
    "L": "lava",        "M": "marsh",
    "W": "water",       "Y": "water",      # deep water collapses to water
    "A": "mountains",   "C": "caverns",
    "U": "jungle",      "V": "caverns",    # overgrowth / caverns-rock subsets
}
# Role letter in B2 slot -> foreign chaosD6 biome. R = rock cliff edge subset;
# W is already a biome letter so it never appears as a *role*-only alias here.
ROLE_LETTER = {
    "R": "rock",
    "W": "water",
}
# When the foreign biome is rock-cliff-coded, also register the mapping under
# "rock_cliffs" so neighbour-biome lookups at render time match both terrain keys.
FOREIGN_ALIASES = {
    "rock":  ["rock_cliffs"],
    "water": [],
    "jungle": [],  # add aliases if biome ever splits
}

# chaosD6 biome -> folder it owns in the extracted archive (to find its base tiles
# for the mean-colour reference). Mirrors tools/import_wbc3_terrain.py.
BIOME_TO_FOLDER = {
    "grass": "Grass",       "high_grass": "High Grass",
    "dirt":  "Dirt",        "high_dirt":  "High Dirt",
    "desert": "Desert",     "snow": "Snow",
    "rock": "Rock",         "mountains": "Mountains",
    "jungle": "Jungle",     "marsh": "Marsh",
    "water": "Water",       "lava": "Lava",
    "caverns": "Caverns",
}


def _hex_mask(w, h):
    """Mirror of tools/import_wbc3_terrain.py — multi-ring radial feather so
    adjacent-biome tiles bleed into each other at hex edges."""
    m = Image.new("L", (w, h), 0)
    cx, cy = w / 2, h / 2
    rx = w * 0.50
    ry = rx * 0.72
    pts = []
    for i in range(6):
        a = i * math.pi / 3
        pts.append((cx + rx * math.cos(a), cy + ry * math.sin(a)))
    rings = [(1.18, 25), (1.14, 70), (1.10, 130), (1.06, 190), (1.03, 230), (1.00, 255)]
    for scale, alpha in rings:
        poly = [(cx + (p[0] - cx) * scale, cy + (p[1] - cy) * scale) for p in pts]
        ImageDraw.Draw(m).polygon(poly, fill=alpha)
    return m


# Edge midpoint offsets (unit-radius, y-down) in Hex.DIRS order:
# 0=E, 1=NE, 2=NW, 3=W, 4=SW, 5=SE. These match the hex geometry in
# godot/scripts/Hex.gd (corners at angles 30 + 60k degrees, y-axis scaled by H_SQUASH).
EDGE_UNIT = [
    (0.866,  0.000),  # E
    (0.433, -0.540),  # NE  (y = sin(-60 deg) * H_SQUASH = -0.866*0.72/... see note below)
    (-0.433,-0.540),  # NW
    (-0.866, 0.000),  # W
    (-0.433, 0.540),  # SW
    (0.433,  0.540),  # SE
]
# Note: edge midpoint between two Hex.gd corners (angles a1,a2) is
#   ((cos a1 + cos a2)/2, (sin a1 + sin a2)/2 * H_SQUASH).
# E midpoint uses corners 0,5 (30, 330 deg) -> (0.866, 0*H_SQUASH) = (0.866, 0).
# NE midpoint uses corners 4,5 (270, 330)   -> (0.433, (-0.5+-1)/2*0.72) = (0.433, -0.54).


SAMPLE_RADII_FRAC = (0.65, 0.80, 0.92)   # try several radii along each edge-midpoint ray
PATCH_HALF = 4                           # (2*HALF+1)^2 patch per sample point
CENTER_PATCH_HALF = 16                   # center sample half-size (32x32 region)


def _avg_patch(img, cx, cy, half=PATCH_HALF):
    px = img.load()
    x0 = max(0, cx - half); x1 = min(img.width,  cx + half + 1)
    y0 = max(0, cy - half); y1 = min(img.height, cy + half + 1)
    r = g = b = n = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            p = px[x, y]
            # Pillow may give 3-tuple or 4-tuple.
            if len(p) >= 4 and p[3] < 32:
                continue
            r += p[0]; g += p[1]; b += p[2]; n += 1
    if n == 0:
        return (0, 0, 0)
    return (r / n, g / n, b / n)


def _tile_center_color(img):
    return _avg_patch(img, img.width // 2, img.height // 2, CENTER_PATCH_HALF)


def _biome_base_avg(biome_key):
    """Average centre-colour over the base/base_variant tiles that back `biome_key`.
    Returns None if no base tiles exist for this biome."""
    folder = BIOME_TO_FOLDER.get(biome_key)
    if folder is None:
        return None
    biome_decode = DECODE["biomes"].get(folder, {})
    codes = list(biome_decode.get("base_codes", [])) + list(biome_decode.get("base_variant_codes", []))
    if not codes:
        return None
    src_dir = os.path.join(EXTRACTED, "Images", "Terrain", folder)
    rr = gg = bb = n = 0
    for code in codes[:8]:   # cap for speed; averages stabilise fast
        src = os.path.join(src_dir, code + ".bmp")
        if not os.path.isfile(src):
            continue
        try:
            im = Image.open(src).convert("RGB")
        except Exception:
            continue
        c = _tile_center_color(im)
        rr += c[0]; gg += c[1]; bb += c[2]; n += 1
    if n == 0:
        return None
    return (rr / n, gg / n, bb / n)


def _color_dist(a, b):
    d = 0.0
    for i in range(3):
        d += (a[i] - b[i]) ** 2
    return math.sqrt(d)


def _collect_transition_prefixes():
    """Return [(code, folder, owning_biome, foreign_biome), ...] across the archive."""
    out = []
    for folder, biome_entry in DECODE["biomes"].items():
        for prefix, info in biome_entry.get("prefixes", {}).items():
            if info.get("role") != "TRANSITION":
                continue
            if len(prefix) < 3:
                continue
            b1 = prefix[1]
            b2 = prefix[2]
            owning  = BIOME_LETTER.get(b1)
            foreign = BIOME_LETTER.get(b2) or ROLE_LETTER.get(b2)
            if owning is None or foreign is None:
                print(f"  [skip] {prefix} unrecognised biome letters b1={b1!r} b2={b2!r}", file=sys.stderr)
                continue
            if owning == foreign:
                # Degenerate self-transition (e.g. TJU jungle<->overgrowth both map to jungle).
                continue
            for code in info.get("tile_codes", []):
                out.append((code, folder, owning, foreign, prefix))
    return out


def _classify_edges(img, owning_avg, foreign_avg):
    """Return (edge_mask, per_edge_debug). 6 bits: bit i = 1 if edge i is foreign.

    Approach: colour-classify every pixel in the hex region (owning vs. foreign
    reference colour), then bin the foreign pixels into the 6 edge wedges by
    direction. An edge is "foreign" when its wedge accumulates more foreign
    pixels than the owning-wedge count scaled by a threshold. This is robust to
    small/localised foreign content (e.g. rock-cliff spikes on an otherwise
    uniformly snowy tile) that would be missed by point sampling."""
    import numpy as np
    w, h = img.width, img.height
    cx, cy = w / 2, h / 2

    # Owning reference: biome base avg, or tile centre as fallback.
    if owning_avg is None:
        owning_avg = _tile_center_color(img)

    arr = np.asarray(img, dtype=np.int16)   # (h, w, 3)
    ys, xs = np.mgrid[0:h, 0:w]

    # Hex-mask gate: only consider pixels inside the authored flat-top hex ellipse.
    rx = w * 0.5
    ry = rx * 0.72
    inside = ((xs - cx) / rx) ** 2 + ((ys - cy) / ry) ** 2 <= 0.98 ** 2

    d_own_sq = ((arr - np.asarray(owning_avg, dtype=np.int16)) ** 2).sum(axis=2)
    if foreign_avg is None:
        # Derive a foreign reference from the pixels furthest from the owner.
        gated = d_own_sq.copy()
        gated[~inside] = -1
        flat = gated.ravel()
        # Top-5% distance pixel as the foreign colour proxy.
        n_inside = int(inside.sum())
        if n_inside < 100:
            return 0, []
        thresh_idx = int(n_inside * 0.95)
        order = np.argsort(flat)
        far_px_indices = order[-max(1, n_inside - thresh_idx):]
        if far_px_indices.size == 0:
            return 0, []
        far_pixels = arr.reshape(-1, 3)[far_px_indices]
        foreign_avg = tuple(float(x) for x in far_pixels.mean(axis=0))
        if _color_dist(foreign_avg, owning_avg) < 15.0:
            return 0, []

    d_for_sq = ((arr - np.asarray(foreign_avg, dtype=np.int16)) ** 2).sum(axis=2)
    foreign_px = (d_for_sq < d_own_sq) & inside
    owning_px  = (~foreign_px) & inside

    # Angle from centre -> which wedge?
    dx = (xs - cx).astype(np.float32)
    dy = (ys - cy).astype(np.float32) / 0.72    # undo H_SQUASH so wedges are 60 deg true
    ang = np.degrees(np.arctan2(dy, dx)) % 360.0

    # Edge directions (midpoint angles) for Hex.DIRS order, y-down:
    # E=0, NE=-60 (300), NW=-120 (240), W=180, SW=120, SE=60.
    # We undid the H_SQUASH on dy so these are the pure-geometry angles.
    edge_angles = [0.0, 300.0, 240.0, 180.0, 120.0, 60.0]
    fracs = []
    f_cnts = []
    for mid in edge_angles:
        lo = (mid - 30.0) % 360.0
        hi = (mid + 30.0) % 360.0
        if lo < hi:
            wedge = (ang >= lo) & (ang < hi)
        else:
            wedge = (ang >= lo) | (ang < hi)
        f_cnt = int((foreign_px & wedge).sum())
        o_cnt = int((owning_px  & wedge).sum())
        total = f_cnt + o_cnt
        fracs.append((f_cnt / total) if total > 0 else 0.0)
        f_cnts.append(f_cnt)

    baseline = min(fracs)              # the "owning" edges' noise floor
    peak     = max(fracs)
    spread   = peak - baseline
    # Two thresholds: an absolute floor for high-contrast transitions,
    # and an adaptive one for subtle biome pairs where owning/foreign colours
    # are similar (TER, TGH, etc.). We mark an edge foreign when:
    #   frac >= 0.25 (absolute), OR
    #   frac >= baseline + 0.4*spread AND spread >= 0.06
    mask = 0
    details = []
    for i, (frac, f_cnt) in enumerate(zip(fracs, f_cnts)):
        abs_hit = frac >= 0.25 and f_cnt >= 60
        rel_hit = (spread >= 0.06) and (frac >= baseline + 0.4 * spread) and (frac - baseline) >= 0.04 and f_cnt >= 60
        is_foreign = abs_hit or rel_hit
        if is_foreign:
            mask |= (1 << i)
        details.append({"wedge_angle": edge_angles[i], "foreign_frac": round(frac, 3), "foreign_px": f_cnt, "picked": is_foreign})
    return mask, details


def main():
    print("== decode WBC3 transition edges ==")
    out_dir = os.path.join(CHAOS_ROOT, "assets", "terrain", "transitions")
    os.makedirs(out_dir, exist_ok=True)

    # Pre-compute biome-average colours.
    base_avg = {}
    for biome in BIOME_TO_FOLDER:
        c = _biome_base_avg(biome)
        if c is not None:
            base_avg[biome] = c
    print("base averages:", {k: tuple(int(x) for x in v) for k, v in base_avg.items()})

    out = {}             # owning -> foreign -> [records]
    stats_pairs = {}     # (owning, foreign) -> count
    skipped_missing_file = 0
    skipped_zero_mask = 0

    for code, folder, owning, foreign, prefix in _collect_transition_prefixes():
        src = os.path.join(EXTRACTED, "Images", "Terrain", folder, code + ".bmp")
        if not os.path.isfile(src):
            skipped_missing_file += 1
            continue
        try:
            img = Image.open(src).convert("RGBA")
        except Exception as e:
            print(f"  [skip] {code}: {e}", file=sys.stderr)
            continue
        if img.size != (TILE_W, TILE_H):
            img = img.resize((TILE_W, TILE_H), Image.LANCZOS)

        rgb = img.convert("RGB")
        own_ref = base_avg.get(owning)
        for_ref = base_avg.get(foreign)
        # Heuristic: if the tile centre is closer to the foreign reference than
        # to the owning reference, the artist drew this prefix "backwards"
        # (owning biome shows only at the edges). Flip owning/foreign so the
        # mask correctly reads "bit=1 means foreign shows here".
        if own_ref is not None and for_ref is not None:
            cc = _tile_center_color(rgb)
            if _color_dist(cc, for_ref) < _color_dist(cc, own_ref):
                owning, foreign = foreign, owning
                own_ref, for_ref = for_ref, own_ref
        mask, _dbg = _classify_edges(rgb, own_ref, for_ref)
        if mask == 0:
            # Edge classifier found no foreign edges; still store under mask=0b111111
            # as a "fallback for any mask" is not quite right. Skip and let base variants
            # cover this tile — but we still emit the PNG so it is reusable.
            skipped_zero_mask += 1

        # Convert to hex-masked PNG under assets/terrain/transitions/.
        img.putalpha(_hex_mask(TILE_W, TILE_H))
        png_rel = f"assets/terrain/transitions/{code}.png"
        png_abs = os.path.join(CHAOS_ROOT, png_rel)
        img.save(png_abs)

        if mask == 0:
            continue    # not useful as a transition pick

        record = {"code": code, "prefix": prefix, "edge_mask": mask, "path": png_rel}
        for target_foreign in [foreign] + FOREIGN_ALIASES.get(foreign, []):
            out.setdefault(owning, {}).setdefault(target_foreign, []).append(record)
            stats_pairs[(owning, target_foreign)] = stats_pairs.get((owning, target_foreign), 0) + 1

    out_path = os.path.join(CHAOS_ROOT, "assets", "terrain", "terrain_transitions.json")
    # Order the output deterministically to make diffs readable.
    ordered = {}
    for owning in sorted(out):
        ordered[owning] = {}
        for foreign in sorted(out[owning]):
            ordered[owning][foreign] = sorted(out[owning][foreign], key=lambda r: r["code"])
    with open(out_path, "w") as fh:
        json.dump({
            "_comment": "Owner->Foreign->list of transition tiles. edge_mask bit i (LSB=0) "
                        "is 1 when edge i (Hex.DIRS order: E,NE,NW,W,SW,SE) shows the foreign biome. "
                        "Generated by tools/decode_transition_edges.py.",
            "edge_order": ["E", "NE", "NW", "W", "SW", "SE"],
            "transitions": ordered,
        }, fh, indent=2)
    print(f"wrote {out_path}")
    total_tiles = sum(len(v) for pairs in out.values() for v in pairs.values())
    pair_count  = sum(1 for owning in out for _ in out[owning])
    print(f"  tiles decoded: {total_tiles}")
    print(f"  owner->foreign pairs: {pair_count}")
    if skipped_missing_file:
        print(f"  skipped (missing BMP): {skipped_missing_file}")
    if skipped_zero_mask:
        print(f"  tiles with zero edge mask (ignored): {skipped_zero_mask}")
    for (own, foe), n in sorted(stats_pairs.items()):
        print(f"    {own:12s} -> {foe:12s}  {n}")


if __name__ == "__main__":
    main()
