import * as THREE from 'three';
import { TERRAIN, PATH_HALF, WATER_Y } from './layout.js';
import { TerrainData, PATH_RANGE, RIVER_MIN, RIVER_RANGE } from './terrain_data.js';
import { loadTextureArray } from './terrain_textures.js';
import { FIELD_GLSL } from './veg_field.js';

/**
 * Terrain of the ruined valley.
 *
 * Geometry: a quadtree of 32 x 32-cell patches over the TERRAIN extents (root 2048 m). A patch splits while the camera is
 * closer than SPLIT x its size, so spacing is 1 m within ~70 m of the camera, 2 m to ~140 m, ... 16 m+ on the far backdrop.
 * Patches carry skirts (no cracks between LOD levels) and are cached; heights / normals come from the cached TerrainData
 * grids (1 m over the playable area, 8 m bicubic beyond), so a patch costs well under a millisecond to build.
 *
 * Shading: MeshStandardMaterial + onBeforeCompile splat (keeps three's lights, shadows, fog and tone mapping):
 *   meadow: textured ground under the near grass cards, turning with distance into the "grass carpet" — the vegetation
 *   canopy as seen from afar (veg_field.js: the cards' average albedo, the same tint and flower drifts, flower clumps
 *   as dots that resolve into their average with the pixel footprint, tuft / streak noise, the cards' lighting normal,
 *   blade occlusion from above and sun translucency), so the cards fade into it without a seam,
 *   flagstone on the path (height-blended against the stone texture), dirt on path fringes and river banks,
 *   moss in hollows / shade, weathered stone then triplanar cliff rock on steep slopes, snow rock high on the backdrop.
 * Masks / normals come from 1 m textures (TerrainData) so lighting does not pop with the geometric LOD.
 */
const PATCH = 32;            // cells per patch side
const ROOT = 2048;           // quadtree root size (m)
const MIN_SIZE = 32;         // smallest patch: 1 m spacing
const SPLIT = 1.25;           // split while distance < SPLIT * size
const LAYERS = ['meadow', 'dirt', 'flagstone', 'cliff_rock', 'moss', 'stone_weathered', 'snow_rock'];

export class Terrain2 {
  constructor(scene, env = {}) {
    this.scene = scene;
    this.env = env;
    this.data = new TerrainData();
    this.group = new THREE.Group();
    this.group.name = 'Terrain2';
    scene.add(this.group);
    this.material = makeMaterial(this.data, env);
    this.cache = new Map();          // key -> { mesh, used }
    this.ranges = new Map();         // key -> [minY, maxY]
    this.lastCam = new THREE.Vector3(1e9, 0, 0);
    this.leaves = [];
    this.frame = 0;
    // albedo + normal texture arrays (decoded asynchronously; the shader falls back to a flat colour until then)
    this.ready = Promise.all([
      this.data.ready,
      loadTextureArray(LAYERS.map((n) => `tex/w2/${n}.jpg`), true),
      loadTextureArray(LAYERS.map((n) => `tex/w2/${n}_n.jpg`), false),
    ]).then(([, alb, nrm]) => {
      this.material.userData.uniforms.uAlb.value = alb;
      this.material.userData.uniforms.uNrm.value = nrm;
      this.material.userData.uniforms.uTexReady.value = 1;
    });
  }

  /** cached ground height (cheap; matches layout.heightAt within a few cm) */
  heightAt(x, z) { return this.data.height(x, z); }

  /** select the quadtree leaves for this camera position, building patches on demand */
  update(camPos) {
    if (!camPos || !this.data.isReady) return;
    const sun = this.env.sunDir;
    if (sun) this.material.userData.uniforms.uSunW.value.copy(sun).normalize();
    if (camPos.distanceToSquared(this.lastCam) < 1) return;
    this.lastCam.copy(camPos);
    this.frame++;
    for (const m of this.leaves) m.visible = false;
    this.leaves.length = 0;
    this.visit(TERRAIN.minX, TERRAIN.minZ, ROOT, camPos);
    for (const m of this.leaves) m.visible = true;
    if (this.cache.size > 900) this.evict();
  }

  visit(x0, z0, size, cam) {
    if (x0 >= TERRAIN.maxX || z0 >= TERRAIN.maxZ) return;
    const [lo, hi] = this.range(x0, z0, size);
    const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + size));
    const dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + size));
    const dy = Math.max(lo - cam.y, 0, cam.y - hi);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (size > MIN_SIZE && d < size * SPLIT) {
      const h = size / 2;
      this.visit(x0, z0, h, cam); this.visit(x0 + h, z0, h, cam);
      this.visit(x0, z0 + h, h, cam); this.visit(x0 + h, z0 + h, h, cam);
      return;
    }
    const key = `${x0},${z0},${size}`;
    let e = this.cache.get(key);
    if (!e) {
      e = { mesh: this.buildPatch(x0, z0, size) };
      this.cache.set(key, e);
      this.group.add(e.mesh);
    }
    e.used = this.frame;
    this.leaves.push(e.mesh);
  }

  /** conservative height range of a node (from the 8 m coarse grid) */
  range(x0, z0, size) {
    const key = `${x0},${z0},${size}`;
    let r = this.ranges.get(key);
    if (r) return r;
    const c = this.data.coarse;
    const i0 = Math.max(0, Math.floor((x0 - c.x0) / c.step)), i1 = Math.min(c.nx - 1, Math.ceil((x0 + size - c.x0) / c.step));
    const j0 = Math.max(0, Math.floor((z0 - c.z0) / c.step)), j1 = Math.min(c.nz - 1, Math.ceil((z0 + size - c.z0) / c.step));
    let lo = 1e9, hi = -1e9;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const h = c.h[i + j * c.nx];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    r = [lo - 4, hi + 4];
    this.ranges.set(key, r);
    return r;
  }

  buildPatch(x0, z0, size) {
    const D = this.data, f = D.fine;
    const s = size / PATCH, n = PATCH + 1;
    const nv = n * n + 4 * n;
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
    const tmp = new THREE.Vector3();
    const useFine = s === 1 && x0 >= f.x0 + 12 && x0 + size <= f.x1 - 12 && z0 >= f.z0 + 12 && z0 + size <= f.z1 - 12;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = Math.min(x0 + i * s, TERRAIN.maxX), z = Math.min(z0 + j * s, TERRAIN.maxZ), k = (i + j * n) * 3;
        pos[k] = x; pos[k + 2] = z;
        if (useFine) {
          const g = (x - f.x0) + (z - f.z0) * f.nx;
          pos[k + 1] = f.h[g];
          nrm[k] = f.n[g * 3]; nrm[k + 1] = f.n[g * 3 + 1]; nrm[k + 2] = f.n[g * 3 + 2];
        } else {
          pos[k + 1] = D.height(x, z);
          D.normal(x, z, Math.max(1, s * 0.75), tmp);
          nrm[k] = tmp.x; nrm[k + 1] = tmp.y; nrm[k + 2] = tmp.z;
        }
      }
    }
    // skirts: a copy of each border row pushed down
    const drop = 0.6 + s * 1.5;
    const border = [];
    for (let i = 0; i < n; i++) border.push(i);                         // z0 edge
    for (let i = 0; i < n; i++) border.push(i + (n - 1) * n);           // z1 edge
    for (let j = 0; j < n; j++) border.push(j * n);                     // x0 edge
    for (let j = 0; j < n; j++) border.push(n - 1 + j * n);             // x1 edge
    border.forEach((src, b) => {
      const k = (n * n + b) * 3;
      pos[k] = pos[src * 3]; pos[k + 1] = pos[src * 3 + 1] - drop; pos[k + 2] = pos[src * 3 + 2];
      nrm[k] = nrm[src * 3]; nrm[k + 1] = nrm[src * 3 + 1]; nrm[k + 2] = nrm[src * 3 + 2];
    });
    const idx = [];
    for (let j = 0; j < PATCH; j++) for (let i = 0; i < PATCH; i++) {
      const a = i + j * n, b = a + 1, c = a + n, d = c + 1;
      if ((i + j) & 1) idx.push(a, c, b, b, c, d);
      else idx.push(a, c, d, a, d, b);
    }
    for (let e = 0; e < 4; e++) {
      for (let t = 0; t < PATCH; t++) {
        const a = border[e * n + t], b = border[e * n + t + 1];
        const as = n * n + e * n + t, bs = as + 1;
        idx.push(a, as, b, b, as, bs, a, b, as, b, bs, as);          // both windings (edge orientation varies)
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.material);
    m.receiveShadow = true;
    m.castShadow = true;
    m.matrixAutoUpdate = false;
    m.visible = false;
    return m;
  }

  evict() {
    const old = [...this.cache.entries()].filter(([, e]) => this.frame - e.used > 30).sort((a, b) => a[1].used - b[1].used);
    for (const [k, e] of old.slice(0, this.cache.size - 600)) {
      this.group.remove(e.mesh);
      e.mesh.geometry.dispose();
      this.cache.delete(k);
    }
  }

  /** triangles in the currently selected patches */
  get triangles() {
    let t = 0;
    for (const m of this.leaves) t += m.geometry.index.count / 3;
    return t;
  }
}

// ------------------------------------------------------------------------------------------------ splat material
function makeMaterial(data, env) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, color: 0xffffff });
  if (env.envMap) { mat.envMap = env.envMap; mat.envMapIntensity = 0.45; }
  const placeholder = (rgba) => {
    const t = new THREE.DataArrayTexture(new Uint8Array([...rgba]), 1, 1, 1);
    t.needsUpdate = true;
    return t;
  };
  const uniforms = {
    uAlb: { value: placeholder([70, 110, 50, 255]) },
    uNrm: { value: placeholder([128, 128, 255, 255]) },
    uTexReady: { value: 0 },
    uData: { value: data.dataTex },
    uNormT: { value: data.normTex },
    uFine: { value: data.fineRect },
    uSunW: { value: (env.sunDir ? env.sunDir.clone() : new THREE.Vector3(-0.55, 0.42, -0.72)).normalize() },
    uCarpet: { value: new THREE.Color(0.34, 0.03, 0.022) },
    uCanopy: { value: new THREE.Vector3(0.85, 0.85, 1.0) },     // carpet albedo / card average albedo (grass, flowers)
    uSunColor: { value: env.sunColor ? new THREE.Color(env.sunColor) : new THREE.Color(1.0, 0.86, 0.68) },
    uSunIntensity: { value: env.sunIntensity ?? 3.2 },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNrm = normalize(mat3(modelMatrix) * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${SPLAT_COMMON}`)
      .replace('#include <map_fragment>', SPLAT_MAIN)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = th_rough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(th_N, 0.0)).xyz);')
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        // the carpet is a canopy of blades, not a glossy surface: no specular lobe (the cards have none either)
        material.specularColor *= 1.0 - vegW;
        material.specularColorBlended *= 1.0 - vegW;
        material.specularF90 *= 1.0 - vegW;`)
      .replace('#include <lights_fragment_begin>', lightsBegin());
  };
  mat.customProgramCacheKey = () => 'terrain2-splat';
  return mat;
}

// sun translucency of the grass carpet: added inside the sun light loop (or the directional one), so it follows the sun's
// shadow. Built at compile time: the shadow / light chunks are patched by sky.js before the first compile.
function lightsBegin() {
  const src = THREE.ShaderChunk.lights_fragment_begin;
  let at = src.indexOf('#if ( NUM_SUN_LIGHTS > 0 ) && defined( RE_Direct )');
  if (at < 0) at = src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const call = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const k = at < 0 ? -1 : src.indexOf(call, at);
  if (k < 0) return '#include <lights_fragment_begin>';
  return `${src.slice(0, k + call.length)}\n\t\treflectedLight.directDiffuse += directLight.color * th_back;${src.slice(k + call.length)}`;
}

const SPLAT_COMMON = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray uAlb;
  uniform sampler2DArray uNrm;
  uniform float uTexReady;
  uniform sampler2D uData;
  uniform sampler2D uNormT;
  uniform vec4 uFine;
  uniform vec3 uSunW;
  uniform vec3 uCarpet;
  uniform vec3 uCanopy;
  uniform vec3 uSunColor;
  uniform float uSunIntensity;
  varying vec3 vWPos;
  ${FIELD_GLSL}
  varying vec3 vWNrm;

  float th_hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float th_noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(th_hash(i), th_hash(i + vec2(1, 0)), u.x), mix(th_hash(i + vec2(0, 1)), th_hash(i + vec2(1, 1)), u.x), u.y);
  }
  float th_fbm(vec2 p) {          // ~0..1
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * th_noise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3; a *= 0.5; }
    return s / 0.9375;
  }
  vec4 th_alb(float layer, vec2 uv, vec2 gx, vec2 gy) { return textureGrad(uAlb, vec3(uv, layer), gx, gy); }
  vec3 th_nrm(float layer, vec2 uv, vec2 gx, vec2 gy, float k) {
    vec3 n = textureGrad(uNrm, vec3(uv, layer), gx, gy).xyz * 2.0 - 1.0;
    n.xy *= k;
    return n;
  }
`;

const SPLAT_MAIN = /* glsl */ `
  vec3 P = vWPos;
  vec2 xz = P.xz;
  vec2 dX = dFdx(xz), dY = dFdy(xz);
  float dist = length(P - cameraPosition);

  // ---- baked 1 m data (fades out at the border of the fine grid)
  vec2 fuv = (xz - uFine.xy + 0.5) / uFine.zw;
  vec2 em = min(xz - uFine.xy, uFine.xy + uFine.zw - 1.0 - xz);
  float fineW = smoothstep(0.0, 10.0, min(em.x, em.y));
  vec4 Dt = texture(uData, fuv);
  vec3 NT = texture(uNormT, fuv).xyz * 2.0 - 1.0;
  vec3 N = normalize(mix(normalize(vWNrm), normalize(NT), fineW));
  float pathD = mix(99.0, Dt.r * ${PATH_RANGE.toFixed(1)}, fineW);
  float rivS = mix(99.0, Dt.g * ${RIVER_RANGE.toFixed(1)} + (${RIVER_MIN.toFixed(1)}), fineW);
  float cav = (Dt.a - 0.5) * 4.0 * fineW;
  float hgt = P.y;

  float n0 = th_fbm(xz * 0.011 + 3.1);
  float n1 = th_fbm(xz * 0.06 + 13.1);
  float n2 = th_fbm(xz * 0.31 + 7.7);
  float macro = th_fbm(xz * 0.0045 + 5.0);

  // flower mask: baked inside the playable area, noise patches on the backdrop meadows
  float flwFar = smoothstep(0.52, 0.72, th_fbm(xz * 0.008 + 41.0)) * smoothstep(0.8, 0.9, N.y) * (1.0 - smoothstep(60.0, 110.0, hgt));
  float flw = mix(flwFar * 0.8, Dt.b, fineW);

  // ---- meadow: two rotated scales, blended by noise (anti-tiling), macro hue / brightness variation
  const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
  vec2 uvA = xz / 7.0;
  vec2 uvB = ROT * xz / 10.3 + vec2(0.31, 0.77);
  float mb = smoothstep(0.4, 0.6, th_fbm(xz * 0.05 + 3.3));
  vec3 colA = th_alb(0.0, uvA, dX / 7.0, dY / 7.0).rgb;
  vec3 colB = th_alb(0.0, uvB, ROT * dX / 10.3, ROT * dY / 10.3).rgb;
  vec3 col = vf_grassAlb(mix(colA, colB, mb));
  vec3 meadowTex = col;
  vec3 tnA = th_nrm(0.0, uvA, dX / 7.0, dY / 7.0, 0.7);
  vec3 tnB = th_nrm(0.0, uvB, ROT * dX / 10.3, ROT * dY / 10.3, 0.7);
  tnB.xy = transpose(ROT) * tnB.xy;
  vec3 tn = mix(tnA, tnB, mb);
  col *= mix(0.82, 1.12, n0) * mix(0.92, 1.06, n1);
  col = mix(col, col * vec3(1.18, 1.08, 0.62), smoothstep(0.5, 0.78, macro) * 0.55);      // sunny yellow-green drifts
  col = mix(col, col * vec3(0.72, 0.88, 0.95), smoothstep(0.5, 0.22, macro) * 0.45);      // deep cool green

  // ---- grass carpet: the card canopy as seen from afar (same drifts / albedo as the cards, see veg_field.js)
  vec3 V = (cameraPosition - P) / max(dist, 1e-3);
  float fF = vf_flowerFrac(flw, xz);
  float vegW = smoothstep(5.0, 28.0, dist);
  vec3 canopy = col;
  if (vegW > 0.0) {
    // flower clumps as dots that resolve into their average as the pixel footprint grows (no shimmer): fine dots are
    // single clumps (~0.45 m), coarse dots clusters of clumps (~1.8 m) that stay resolved 4x further out (painterly
    // dabs). The noise sums are stretched to a ~uniform distribution, so the dots cover fF of the ground like the
    // clumps do; resolved dots are the petals (~60 % of a clump, vivid), fully blurred the clumps' average colour.
    float carpet = 0.0, blurF = 1.0;
    if (fF > 0.002) {
      float fw = length(fwidth(xz));
      float sF = clamp(fw * 1.6, 0.08, 0.5), sC = clamp(fw * 0.4, 0.08, 0.5);
      float useC = smoothstep(0.2, 0.45, sF);
      float dotN = 0.0;
      if (useC < 1.0) dotN = clamp((vf_noise(xz * 2.2 + 31.0) * 0.7 + vf_noise(xz * 0.75 + 5.0) * 0.3) * 2.0 - 0.5, 0.0, 1.0);
      if (useC > 0.0) dotN = mix(dotN, clamp((vf_noise(xz * 0.55 + 17.0) * 0.7 + vf_noise(xz * 0.19 + 2.0) * 0.3) * 2.0 - 0.5, 0.0, 1.0), useC);
      float dotS = mix(sF, sC, useC);
      blurF = smoothstep(0.25, 0.5, dotS);
      // (seen over the grass the clumps' petals dominate: the flower share and redness of the far field run above fF)
      float fD = min(fF * mix(0.6, 1.3, blurF), 1.0);
      carpet = mix(smoothstep(1.0 - fD - dotS, 1.0 - fD + dotS, dotN), fD, blurF);
    }
    float lumT = dot(meadowTex, vec3(0.3, 0.6, 0.1)) / 0.172;                                // blade detail from the texture
    float tuft = mix(0.8, 1.12, vf_noise(xz * 1.4 + 3.7)) * mix(0.86, 1.1, vf_noise(xz * 0.33 + 1.7)) * mix(0.9, 1.08, n2);
    float streak = mix(0.93, 1.06, vf_noise(ROT * xz * vec2(0.3, 1.9) + 11.0));              // wind-combed streaks
    vec3 grassC = vf_grassAlb(VF_GRASS_ALB) * vf_grassTint(xz) * uCanopy.x;
    vec3 flowerC = vf_flowerAlb(mix(VF_PETAL_ALB, VF_FLOWER_ALB, blurF * 0.5)) * vf_flowerTint(xz, 0.5) * uCanopy.y;
    canopy = mix(grassC, flowerC, carpet) * tuft * streak * mix(1.0, clamp(lumT, 0.6, 1.5), 0.3);
    canopy *= mix(0.84, 1.0, 1.0 - abs(dot(V, N)));                                        // blade gaps seen from above
  }
  // near the camera: the ground between the dense cards — the meadow texture in the shade of the blades, dark litter
  // under the flower clumps
  vec3 under = mix(col * vec3(0.55, 0.42, 0.36), uCarpet * 0.45, 0.6);
  vec3 ground = mix(col * 0.62, under, smoothstep(0.35, 0.65, fF));
  col = mix(ground, canopy, vegW);
  float rough = 0.95;

  // ---- weathered stony soil on moderately steep ground
  float stoneW = smoothstep(0.93, 0.8, N.y + (n1 - 0.5) * 0.12) * 0.6;
  if (stoneW > 0.01) {
    vec2 uv = xz / 5.0;
    col = mix(col, th_alb(5.0, uv, dX / 5.0, dY / 5.0).rgb * vec3(0.95, 0.97, 0.9), stoneW);
    vegW *= 1.0 - stoneW;
    tn = mix(tn, th_nrm(5.0, uv, dX / 5.0, dY / 5.0, 1.0), stoneW);
  }

  // ---- moss in hollows, shade and near water
  float shade = 1.0 - clamp(dot(N, uSunW) * 1.4, 0.0, 1.0);
  float mossW = smoothstep(0.68, 0.9, cav * 0.3 + shade * 0.3 + n1 * 0.55 + (1.0 - smoothstep(0.0, 8.0, rivS)) * 0.1) * (1.0 - fF) * mix(0.8, 0.35, vegW);
  if (mossW > 0.01) {
    vec2 uv = xz / 4.5;
    col = mix(col, th_alb(4.0, uv, dX / 4.5, dY / 4.5).rgb * vec3(1.05, 1.08, 0.78), mossW);
    vegW *= 1.0 - mossW;
    tn = mix(tn, th_nrm(4.0, uv, dX / 4.5, dY / 4.5, 0.8), mossW);
  }

  // ---- dirt: patchy fringes along the path, river banks and bed, low ground by water on the backdrop
  float pd = pathD + (n2 - 0.5) * 0.9 + (n1 - 0.5) * 0.9;
  float edgeF = 1.0 - smoothstep(${PATH_HALF.toFixed(2)}, ${PATH_HALF.toFixed(2)} + 3.2, pd);
  float bank = 1.0 - smoothstep(0.0, 1.2 + n1 * 4.5, rivS);
  float dirtW = max(edgeF * (0.5 + (n2 - 0.5) * 1.1 + (n1 - 0.5) * 0.8), bank * (0.85 + (n1 - 0.5) * 0.8));
  dirtW = max(smoothstep(0.38, 0.62, dirtW), (1.0 - fineW) * (1.0 - smoothstep(${(WATER_Y + 0.8).toFixed(2)}, ${(WATER_Y + 2.8).toFixed(2)}, hgt + (n1 - 0.5) * 2.0)));
  if (dirtW > 0.01) {
    vec2 uv = ROT * xz / 4.0;
    col = mix(col, th_alb(1.0, uv, ROT * dX / 4.0, ROT * dY / 4.0).rgb, dirtW);
    vegW *= 1.0 - dirtW;
    vec3 t = th_nrm(1.0, uv, ROT * dX / 4.0, ROT * dY / 4.0, 0.9);
    t.xy = transpose(ROT) * t.xy;
    tn = mix(tn, t, dirtW);
  }
  // wet ground at the waterline and below
  float wet = 1.0 - smoothstep(-0.3, 2.4 + n2 * 1.5, min(rivS, mix(99.0, (hgt - ${WATER_Y.toFixed(1)}) * 1.5, 1.0 - fineW)));
  col *= mix(1.0, 0.42, wet);
  col = mix(col, col * vec3(0.9, 0.95, 1.0), wet);                 // damp soil reads a little cooler
  rough = mix(rough, 0.5, wet);

  // ---- flagstone path: stones (bright) win over the gaps (dark) along a noisy edge
  float pathW = 0.0;
  if (pathD < ${(PATH_HALF + 2.5).toFixed(2)}) {
    vec2 uv = xz / 3.0;
    vec3 fs = th_alb(2.0, uv, dX / 3.0, dY / 3.0).rgb;
    float stoneH = dot(fs, vec3(0.3, 0.55, 0.15));
    float base = 1.0 - smoothstep(${(PATH_HALF - 0.9).toFixed(2)}, ${(PATH_HALF + 0.5).toFixed(2)}, pathD + (n2 - 0.5) * 0.7 + (n1 - 0.5) * 0.6);
    pathW = clamp((base - 0.5) * 3.0 + (stoneH - 0.16) * 4.0 + 0.5, 0.0, 1.0) * step(0.02, base);
    col = mix(col, fs * mix(0.9, 1.1, n1), pathW);
    vegW *= 1.0 - pathW;
    tn = mix(tn, th_nrm(2.0, uv, dX / 3.0, dY / 3.0, 1.3), pathW);
    rough = mix(rough, 0.8, pathW);
  }

  // ---- planar normal (tangent frame: +u = +x, +v = +z)
  vec3 T = normalize(vec3(1.0, 0.0, 0.0) - N * N.x);
  vec3 B = normalize(vec3(0.0, 0.0, 1.0) - N * N.z);
  vec3 th_N = normalize(T * tn.x + B * tn.y + N * max(tn.z, 0.2));
  // the carpet is lit like the cards: terrain normal + a little towards the camera side + up
  vec3 fnH = normalize(vec3(V.x, 0.0, V.z) + vec3(1e-4, 0.0, 0.0));
  th_N = normalize(mix(th_N, normalize(N + fnH * 0.35 + vec3(0.0, 0.25, 0.0)), vegW * (1.0 - wet)));
  rough = mix(rough, 1.0, vegW);

  // ---- cliff rock on steep slopes: triplanar (strata stay horizontal), whiteout-blended normals
  float rockW = smoothstep(0.8, 0.68, N.y + (n2 - 0.5) * 0.08 + (n1 - 0.5) * 0.1) * (1.0 - pathW);
  if (rockW > 0.01) {
    vec3 bw = pow(abs(N), vec3(4.0)); bw /= dot(bw, vec3(1.0));
    vec3 Pr = P / 9.0;
    vec3 gx3 = dFdx(P) / 9.0, gy3 = dFdy(P) / 9.0;
    vec3 sg = vec3(N.x < 0.0 ? -1.0 : 1.0, N.y < 0.0 ? -1.0 : 1.0, N.z < 0.0 ? -1.0 : 1.0);
    vec2 uvX = vec2(Pr.z * sg.x, Pr.y), uvY = vec2(Pr.x * sg.y, Pr.z), uvZ = vec2(-Pr.x * sg.z, Pr.y);
    vec2 gxX = vec2(gx3.z * sg.x, gx3.y), gyX = vec2(gy3.z * sg.x, gy3.y);
    vec2 gxY = vec2(gx3.x * sg.y, gx3.z), gyY = vec2(gy3.x * sg.y, gy3.z);
    vec2 gxZ = vec2(-gx3.x * sg.z, gx3.y), gyZ = vec2(-gy3.x * sg.z, gy3.y);
    vec3 rc = th_alb(3.0, uvX, gxX, gyX).rgb * bw.x + th_alb(3.0, uvY, gxY, gyY).rgb * bw.y + th_alb(3.0, uvZ, gxZ, gyZ).rgb * bw.z;
    vec3 nX = th_nrm(3.0, uvX, gxX, gyX, 1.2), nY = th_nrm(3.0, uvY, gxY, gyY, 1.2), nZ = th_nrm(3.0, uvZ, gxZ, gyZ, 1.2);
    nX.x *= sg.x; nY.x *= sg.y; nZ.x *= -sg.z;
    nX = vec3(nX.xy + N.zy, abs(nX.z) * N.x);
    nY = vec3(nY.xy + N.xz, abs(nY.z) * N.y);
    nZ = vec3(nZ.xy + N.xy, abs(nZ.z) * N.z);
    vec3 rn = normalize(nX.zyx * bw.x + nY.xzy * bw.y + nZ.xyz * bw.z);
    rc *= vec3(1.3, 1.25, 1.18) * mix(0.85, 1.1, n1);
    // moss / grass clinging to ledges (upward facing parts of the rock)
    float ledge = smoothstep(0.5, 0.72, N.y + (dot(rc, vec3(0.33)) - 0.15) * 0.8 + (n2 - 0.5) * 0.2);
    rc = mix(rc, th_alb(4.0, xz / 4.5, dX / 4.5, dY / 4.5).rgb * vec3(1.0, 1.05, 0.8), ledge * 0.85);
    col = mix(col, rc, rockW);
    vegW *= 1.0 - rockW;
    th_N = normalize(mix(th_N, rn, rockW));
    rough = mix(rough, 0.88, rockW);
  }

  // ---- snow rock high on the backdrop (more on flatter ground)
  float snowW = smoothstep(150.0, 185.0, hgt + (n0 - 0.5) * 70.0 + (N.y - 0.75) * 70.0);
  if (snowW > 0.01) {
    vec2 uv = xz / 55.0;
    vec3 sc = th_alb(6.0, uv, dX / 55.0, dY / 55.0).rgb;
    sc = mix(sc, vec3(0.75, 0.78, 0.86), smoothstep(300.0, 900.0, dist) * 0.6);
    col = mix(col, sc, snowW);
    vegW *= 1.0 - snowW;
    rough = mix(rough, 0.7, snowW);
  }

  // ---- broad cavity occlusion
  col *= 1.0 - clamp(cav * 0.18, 0.0, 0.25);
  if (uTexReady < 0.5) col = vec3(0.12, 0.2, 0.07);
  float th_rough = rough;
  diffuseColor.rgb *= col;
  // sun translucency of the carpet (the cards: + albedo * sun * back * 0.7, averaged over the card height)
  vec3 th_back = col * (vegW * 0.55 / uSunIntensity) * pow(max(dot(-V, uSunW), 0.0), 3.0);
`;
