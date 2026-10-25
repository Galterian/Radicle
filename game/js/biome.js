// Deterministic biome generator — mirror of godot/scripts/Biome.gd. The same
// (dim_seed, q, r) must yield the same biome in both runtimes so a dimension
// renders identically whether a Node peer, the browser, or Godot drew it.
import { hash32 } from './map.js';

export const WATER_LEVEL = 0.26;
export const COAST_BAND = 0.05;
export const HIGHLAND = 0.60;
export const ROUGH = 0.78;
export const PEAK = 0.90;
export const BASE_SCALE = 0.07;
export const DETAIL_SCALE = 0.17;

// Sub-biome structure (applied AFTER the Whittaker matrix picks a base biome).
// Two extra independent noise channels break up long uniform regions the way
// real WBC3 maps do: `ridge` grows snow-capped mountain clusters (with a rock
// rim) inside cold/high regions, `lake` carves lakes (with a shore ring and the
// occasional isle) into lowlands. Both use a finer lattice than the base
// channels so a ~700-hex reveal sees several of them. Measured percentiles of
// the raw channel: 0.70 = top 15%, 0.77 = top 7%, 0.80 = top 5%, 0.88 = top 1%.
// SUB_CONTRAST stretches the channel around 0.5 (1.0 = off) — kept as a single
// knob so both runtimes can be retuned together.
export const SUB_BASE_SCALE = 0.18;    // ~5.5 hexes per lattice step
export const SUB_DETAIL_SCALE = 0.42;
export const SUB_CONTRAST = 1.0;
export const RIDGE_MOUNTAIN = 0.80;    // ridge above this -> mountains
export const RIDGE_FOOTHILL = 0.70;    // ridge in [FOOTHILL, MOUNTAIN) inside snow -> rock rim
export const LAKE_WATER = 0.80;        // lake above this -> water
export const LAKE_SHORE = 0.77;        // lake in [SHORE, WATER) -> coast variant of the land biome
export const LAKE_ISLE = 0.88;         // lake above this (inside a lake) -> the land biome again

// Base biomes that can grow mountains. grass is deliberately included: the
// archive's best-covered mountain transition set is grass<->mountains (18
// tiles) and the reference screenshots show exactly that pairing.
const RIDGE_BIOMES = new Set(['snow', 'rock', 'high_dirt', 'high_grass', 'grass']);
// Shore ring variant per land biome. jungle/marsh shores read as grass_coast
// (grass<->marsh 12 / grass<->jungle 14 transition tiles cover the seam).
const SHORE_OF = {
  grass: 'grass_coast', high_grass: 'grass_coast', grass_coast: 'grass_coast',
  marsh: 'grass_coast', jungle: 'grass_coast',
  snow: 'snow_coast', snow_coast: 'snow_coast',
  dirt: 'rock_coast', high_dirt: 'rock_coast', desert: 'rock_coast',
  rock: 'rock_coast', rock_coast: 'rock_coast',
};

export const BIOMES = [
  'grass', 'high_grass', 'grass_coast',
  'dirt', 'high_dirt',
  'desert', 'desert_cliffs',
  'snow', 'snow_coast',
  'rock', 'rock_coast', 'rock_cliffs',
  'mountains', 'jungle', 'marsh',
  'water', 'lava', 'caverns',
];

// Fallback flat-poly colours used when the matching terrain PNG hasn't loaded
// yet (or at all). Mirrors the `fill` key for each biome in
// assets/terrain/terrain_tiles.json so the raw outline doesn't flash plain
// black during asset load.
export const BIOME_FILL = {
  grass:         '#2d4a26',
  high_grass:    '#243d1f',
  grass_coast:   '#3a4e2e',
  dirt:          '#4a3e26',
  high_dirt:     '#3d321f',
  desert:        '#b89a5d',
  desert_cliffs: '#8a6a3a',
  snow:          '#d9e6ea',
  snow_coast:    '#b9c9d0',
  rock:          '#555b64',
  rock_coast:    '#6a6e74',
  rock_cliffs:   '#3f444a',
  mountains:     '#4a4e55',
  jungle:        '#1f3a1b',
  marsh:         '#324a30',
  water:         '#204a66',
  lava:          '#8a2e14',
  caverns:       '#1b1a22',
};

const UNWALKABLE = new Set(['water', 'lava', 'mountains', 'rock_cliffs', 'desert_cliffs']);
export const isWalkable = (biome) => !UNWALKABLE.has(biome);

const rand01 = (seed, ix, iy, salt) => hash32(`${seed}:${salt}:${ix}:${iy}`) / 4294967296;

// Exported so bigfeature.js can share the lattice (mirrors Biome._value_noise).
export function valueNoise(seed, x, y, salt) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = rand01(seed, ix,     iy,     salt);
  const b = rand01(seed, ix + 1, iy,     salt);
  const c = rand01(seed, ix,     iy + 1, salt);
  const d = rand01(seed, ix + 1, iy + 1, salt);
  const ab = a + sx * (b - a);
  const cd = c + sx * (d - c);
  return ab + sy * (cd - ab);
}

function fbm(seed, qf, rf, salt) {
  const v = valueNoise(seed, qf * BASE_SCALE, rf * BASE_SCALE, salt)
          + 0.5 * valueNoise(seed, qf * DETAIL_SCALE, rf * DETAIL_SCALE, salt + '.d');
  return Math.min(1, Math.max(0, v / 1.5));
}

// Finer-lattice, contrast-stretched FBM for the ridge / lake sub-biome channels.
// Mirror of Biome.gd._fbm_sub — same scales, same stretch, same clamp order.
function fbmSub(seed, qf, rf, salt) {
  const v = valueNoise(seed, qf * SUB_BASE_SCALE, rf * SUB_BASE_SCALE, salt)
          + 0.5 * valueNoise(seed, qf * SUB_DETAIL_SCALE, rf * SUB_DETAIL_SCALE, salt + '.d');
  return Math.min(1, Math.max(0, (v / 1.5 - 0.5) * SUB_CONTRAST + 0.5));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function createBiome(seedHex) {
  const heatBias = ((hash32(seedHex + ':heat') % 1000) / 1000 - 0.5) * 0.8;
  const wetBias  = ((hash32(seedHex + ':wet')  % 1000) / 1000 - 0.5) * 0.6;

  function sample(q, r) {
    const qf = q, rf = r;
    const elev  = fbm(seedHex, qf, rf, 'e');
    const moist = clamp(fbm(seedHex, qf + 1000, rf - 1000, 'm') + wetBias, 0, 1);
    const temp  = clamp(fbm(seedHex, qf -  500, rf +  500, 't') + heatBias, 0, 1);
    return { elev, moist, temp };
  }

  // Sub-biome channels. Offsets decorrelate them from the base channels'
  // lattice even though the salts already differ — mirrors Biome.gd exactly.
  function sampleSub(q, r) {
    const qf = q, rf = r;
    const ridge = fbmSub(seedHex, qf + 3000, rf + 3000, 'r');
    const lake  = fbmSub(seedHex, qf - 3000, rf + 3000, 'l');
    return { ridge, lake };
  }

  // Final biome = base Whittaker pick, then the ridge / lake overlays. Order and
  // thresholds must stay identical to Biome.gd.biome_at.
  function biomeAt(q, r) {
    const s = sample(q, r);
    const base = baseBiome(s.elev, s.moist, s.temp);
    const { ridge, lake } = sampleSub(q, r);
    // --- mountains inside cold / high regions (rock rim inside snow) ---
    if (RIDGE_BIOMES.has(base)) {
      if (ridge > RIDGE_MOUNTAIN) return 'mountains';
      if (base === 'snow' && ridge > RIDGE_FOOTHILL) return 'rock';
    }
    // --- lakes inside lowlands: shore ring, water, isle ---
    if (s.elev < HIGHLAND && isWalkable(base) && SHORE_OF[base]) {
      if (lake > LAKE_ISLE) return base;
      if (lake > LAKE_WATER) return 'water';
      if (lake > LAKE_SHORE) return SHORE_OF[base];
    }
    return base;
  }

  function baseBiome(e, m, t) {
    if (e < WATER_LEVEL) {
      if (t > 0.78 && e < WATER_LEVEL - 0.03) return 'lava';
      return 'water';
    }
    if (e < WATER_LEVEL + COAST_BAND) {
      if (t < 0.3) return 'snow_coast';
      if (m > 0.55) return 'grass_coast';
      return 'rock_coast';
    }
    if (e < HIGHLAND) {
      if (t > 0.82 && m < 0.3) return 'lava';
      if (t < 0.28) return m > 0.3 ? 'snow' : 'snow_coast';
      // Cool buffer (0.28..0.42): no jungle/marsh neighbours to snow since the
      // archive has no snow<->jungle / snow<->marsh transition tiles.
      if (t < 0.42) {
        if (m < 0.3) return 'dirt';
        if (m < 0.65) return 'grass';
        return 'high_grass';
      }
      if (t > 0.7) {
        if (m < 0.25) return 'desert';
        if (m < 0.55) return 'dirt';
        return m > 0.75 ? 'jungle' : 'grass';
      }
      if (m < 0.18) return 'desert';
      if (m < 0.35) return 'dirt';
      if (m < 0.65) return 'grass';
      if (m < 0.82) return 'marsh';
      return 'jungle';
    }
    if (e < ROUGH) {
      if (t < 0.3) return 'snow';
      if (t < 0.45) return m < 0.3 ? 'high_dirt' : 'high_grass';
      if (m < 0.3) return 'high_dirt';
      if (m < 0.65) return 'high_grass';
      return t > 0.6 ? 'jungle' : 'marsh';
    }
    if (e < PEAK) {
      if (t < 0.3) return 'snow';
      if (t > 0.78 && m < 0.4) return 'desert_cliffs';
      if (m < 0.4) return 'rock';
      if (m < 0.7) return 'rock_cliffs';
      return 'caverns';
    }
    return t < 0.4 ? 'snow' : 'mountains';
  }

  return { seedHex, heatBias, wetBias, sample, sampleSub, baseBiome, biomeAt, isWalkable: (q, r) => isWalkable(biomeAt(q, r)) };
}

// Memoised per-seed biome. Features and scatter both need to know a hex's
// biome type dozens of times per frame; recomputing the heat/wet bias on each
// call would waste work. One biome instance per dim seed is kept forever
// (seeds change rarely — only when the player enters a new dimension — and
// the memoisation is just a Map of seed→biome).
const _biomes = new Map();
export function biomeFor(seedHex) {
  let b = _biomes.get(seedHex);
  if (!b) { b = createBiome(seedHex); _biomes.set(seedHex, b); }
  return b;
}
