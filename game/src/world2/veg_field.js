/**
 * The meadow "field" model shared by the vegetation cards (vegetation.js) and the terrain splat (terrain.js).
 *
 * Both sides call the same GLSL, so the colour of the grass / flower cards and the colour of the painted carpet that
 * replaces them in the distance come from one function of world position: tint drifts, flower drifts (where and how
 * red), and the average albedo of a card as seen from a few tens of metres. Cards fade into the carpet without a seam.
 *
 *   vf_noise(p)            value noise 0..1 (cheap, 4 hashes)
 *   vf_grassTint(xz)       multiplier on the grass card texture (yellow-green / blue-green drifts, brush-stroke dabs)
 *   vf_flowerFrac(flw, xz) share of flower clumps (0..1) from the 1 m flower mask; drift edges sharpened so red patches
 *                          read as patches (red mixed into green averages to brown)
 *   vf_flowerTint(xz, k)   multiplier on the flower card texture; k = per-clump random (0..1), 0.5 = the average clump
 *   VF_GRASS_ALB / VF_FLOWER_ALB   average linear albedo of the covered texels of the card textures (alpha > 0.5)
 *   VF_PETAL_ALB   average of the flower card's red texels
 */
export const VF_GRASS_ALB = [0.114, 0.196, 0.0145];
export const VF_FLOWER_ALB = [0.303, 0.0518, 0.0165];
export const VF_PETAL_ALB = [0.478, 0.016, 0.0147];      // the red texels only (54 % of the covered ones)

const v3 = (a) => `vec3(${a.map((x) => x.toFixed(4)).join(', ')})`;

export const FIELD_GLSL = /* glsl */ `
  #ifndef VF_FIELD
  #define VF_FIELD
  const vec3 VF_GRASS_ALB = ${v3(VF_GRASS_ALB)};
  const vec3 VF_FLOWER_ALB = ${v3(VF_FLOWER_ALB)};
  const vec3 VF_PETAL_ALB = ${v3(VF_PETAL_ALB)};
  float vf_hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vf_noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(vf_hash(i), vf_hash(i + vec2(1, 0)), u.x), mix(vf_hash(i + vec2(0, 1)), vf_hash(i + vec2(1, 1)), u.x), u.y);
  }
  // painterly albedo grade of the card textures (linear, so card averages stay valid for the far carpet):
  // grass loses the lime: a little desaturated and warmed towards olive; petals deepen to crimson
  vec3 vf_grassAlb(vec3 c) {
    return mix(vec3(dot(c, vec3(0.3, 0.6, 0.1))), c, 0.78) * vec3(1.06, 0.98, 0.9);
  }
  vec3 vf_flowerAlb(vec3 c) {
    return mix(vec3(dot(c, vec3(0.3, 0.6, 0.1))), c, 0.9) * vec3(0.86, 0.95, 1.08);
  }
  vec3 vf_grassTint(vec2 xz) {
    // cool sage / olive / golden straw drifts (~40 m) and brighter / darker brush-stroke dabs (~9 m, stretched)
    float a = vf_noise(xz * 0.025 + 3.0), b = vf_noise(xz * 0.011 + 21.0);
    vec3 t = mix(vec3(0.66, 0.8, 0.72), vec3(0.92, 0.9, 0.6), a);
    t = mix(t, vec3(1.1, 0.92, 0.52), smoothstep(0.55, 0.85, b) * 0.6);      // golden drifts
    return t * mix(0.84, 1.1, vf_noise(mat2(0.8, 0.6, -0.6, 0.8) * xz * vec2(0.07, 0.16) + 4.0));
  }
  float vf_flowerFrac(float flw, vec2 xz) {
    float p = pow(max(flw, 0.0), 0.7) * mix(0.62, 0.92, vf_noise(xz * 0.09 + 7.0));   // some grass shows through the drifts
    return mix(p, smoothstep(0.2, 0.55, p), 0.6);
  }
  vec3 vf_flowerTint(vec2 xz, float k) {
    // deep crimson -> scarlet -> coral, drifting with a slow noise (the card itself is scarlet)
    float hk = clamp(vf_noise(xz * 0.04 + 9.0) * 0.9 + k * 0.45 - 0.2, 0.0, 1.0);
    vec3 crimson = vec3(0.6, 0.42, 0.5), scarlet = vec3(1.0), coral = vec3(1.02, 1.3, 1.02);
    return hk < 0.4 ? mix(crimson, scarlet, hk / 0.4) : mix(scarlet, coral, (hk - 0.4) / 0.6);
  }
  #endif
`;
