import * as THREE from 'three';
import { PATH_HALF, WATER_Y } from './layout.js';
import { PATH_RANGE, RIVER_MIN, RIVER_RANGE } from './terrain_data.js';
import { FIELD_GLSL } from './veg_field.js';

/**
 * GPU-placed grass and red-flower cards, in four rings around the camera; the terrain splat paints the same meadow
 * (veg_field.js: same tint / flower drifts, the cards' average albedo, same lighting normal) beyond and under them.
 *
 *   ring  cell     density   reach (3D distance, fade bands)   card                          verts / instance
 *   0     0.34 m   8.7 /m²   0 .. 33-45 m                      2 crossed quads               8
 *   1     0.55 m   3.3 /m²   33-45 .. 95-120 m                 1 camera-facing quad          4
 *   2     1.10 m   0.83 /m²  95-120 .. 220-260 m               1 camera-facing quad, wider   4
 *   3     2.50 m   0.16 /m²  220-260 .. 460-550 m              1 camera-facing quad, widest  4  (low far grass)
 *   beyond (and under everything): the terrain's grass carpet (terrain.js)
 *
 * Each ring is ONE instanced draw call. Instances are not stored: the ring is cut into world-anchored square tiles of
 * TILE x TILE cells; per frame (in onBeforeRender, with the real camera) the tiles that touch the ring's distance band and
 * the view frustum are listed, sorted near to far, and passed as a uniform array; gl_InstanceID -> (tile, cell). The
 * vertex shader hashes the world cell (no swimming), early-outs dead cells before any texture fetch, reads height (4
 * texelFetch, the normal comes from the same 4 taps) and the 1 m path / river / flower data (1 fetch), and decides
 * habitat, flower vs grass and size. Neighbouring rings cross-fade with complementary per-instance thresholds (an
 * instance shrinks smoothly to nothing instead of popping); size grows with distance so coverage holds while density
 * drops ~3x per ring.
 *
 * Everything but the texture lookup is per vertex: lighting (sun with ONE hardware-PCF shadow tap, hemisphere,
 * ambient), sun translucency, base occlusion, tint and the height fog collapse into one colour multiply + add, so the
 * fragment shader is a texture fetch, an alpha test and a multiply-add. Cards never cast shadows; they are drawn after
 * the opaque world (renderOrder) so hidden fragments fail the depth test early.
 */
const RINGS = [
  { cell: 0.34, tile: 16, r0: 0, r1: 45, f1: 12, quads: 2, seed: 11 },       // full detail: crossed cards
  { cell: 0.55, tile: 24, r0: 45, r1: 120, f1: 25, quads: 1, seed: 23 },
  { cell: 1.1, tile: 24, r0: 120, r1: 260, f1: 40, quads: 1, seed: 37 },
  { cell: 2.5, tile: 24, r0: 260, r1: 550, f1: 90, quads: 1, seed: 53 },     // low far grass towards the horizon
];
// inner fade band of ring k = outer fade band of ring k-1 (complementary weights)
RINGS.forEach((r, k) => { r.f0 = k > 0 ? RINGS[k - 1].f1 : 0; });
const MAX_TILES = 192;

export class Vegetation2 {
  constructor(scene, env = {}, terrain) {
    this.scene = scene;
    this.env = env;
    this.terrain = terrain;
    this.data = terrain.data;
    this.count = 0;
    this.group = new THREE.Group();
    this.group.name = 'Vegetation2';
    scene.add(this.group);

    const loader = new THREE.TextureLoader();
    const load = (url) => new Promise((res) => loader.load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      res(t);
    }, undefined, () => res(null)));
    const sunW = (env.sunDir ? env.sunDir.clone() : new THREE.Vector3(-0.55, 0.42, -0.72)).normalize();
    this.shared = {
      uGrass: { value: null }, uFlower: { value: null },
      uHeight: { value: this.data.heightTex }, uData: { value: this.data.dataTex },
      uFine: { value: this.data.fineRect },
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(0.8, 0.45) },
      uSunW: { value: sunW },
      uSunColor: { value: env.sunColor ? new THREE.Color(env.sunColor) : new THREE.Color(1.0, 0.86, 0.68) },
      // image-based ambient (scene.environment, which the terrain and the props receive) as outgoing radiance for a
      // white diffuse surface facing up / sideways — measured once from the PMREM of the painted sky
      uEnvUp: { value: new THREE.Vector3(0.335, 0.351, 0.691) },
      uEnvSide: { value: new THREE.Vector3(0.467, 0.483, 0.767) },
    };
    this.ready = Promise.all([this.data.ready, load('tex/w2/grass_card.png'), load('tex/w2/red_flowers_card.png')]).then(([, g, f]) => {
      this.shared.uGrass.value = g;
      this.shared.uFlower.value = f;
      for (const r of this.rings) r.mesh.visible = true;
    });

    const geos = { 1: cardGeometry(1), 2: cardGeometry(2) };
    this.rings = RINGS.map((cfg, k) => {
      const tiles = new Float32Array(MAX_TILES * 2);
      const material = makeMaterial(this.shared, {
        uRing: { value: new THREE.Vector4(cfg.cell, cfg.tile, 0, 0) },
        uBand: { value: new THREE.Vector4(cfg.r0 - cfg.f0, cfg.r0, cfg.r1 - cfg.f1, cfg.r1) },
        uSeed: { value: cfg.seed },
        uTiles: { value: tiles },
      }, cfg.quads);
      material.name = `veg2-ring${k}`;
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', geos[cfg.quads].getAttribute('position'));
      geo.setIndex(geos[cfg.quads].getIndex());
      geo.instanceCount = 0;
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = `Vegetation2-ring${k}`;
      mesh.frustumCulled = false;            // tiles are culled per frame instead
      mesh.castShadow = false;
      mesh.receiveShadow = true;             // shadow uniforms (sampled per vertex)
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 2 + k;              // after the opaque world (early depth rejection), near rings first
      mesh.visible = false;                  // until the card textures arrive
      const ring = { ...cfg, k, mesh, material, geo, tiles, T: cfg.cell * cfg.tile, list: [], pool: [] };
      mesh.onBeforeRender = (renderer, scene_, camera) => this.prepare(renderer, camera, ring);
      this.group.add(mesh);
      return ring;
    });
    this._frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._key = '';
    this._cam = new THREE.Vector3();
  }

  /** wind time and sun direction; the tiles are chosen per camera at draw time (prepare) */
  update(t, camPos) {
    this.shared.uTime.value = t ?? 0;
    if (this.env.sunDir) this.shared.uSunW.value.copy(this.env.sunDir).normalize();
  }

  /** per draw: list this ring's tiles for the camera that is rendering (once per camera per frame for all rings) */
  prepare(renderer, camera, ring) {
    const key = `${camera.id}:${renderer.info.render.frame}`;
    if (key !== this._key) {
      this._key = key;
      this.select(camera);
    }
    ring.geo.instanceCount = ring.list.length * ring.tile * ring.tile;
  }

  select(camera) {
    const cam = camera.getWorldPosition(this._cam);
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m, camera.coordinateSystem);
    const f = this.data.fine, box = this._box;
    let count = 0;
    for (const ring of this.rings) {
      ring.list.length = 0;
      if (!this.data.isReady) continue;
      const { T, r1 } = ring;
      const rIn = ring.r0 - ring.f0;
      const i0 = Math.floor((cam.x - r1) / T), i1 = Math.floor((cam.x + r1) / T);
      const j0 = Math.floor((cam.z - r1) / T), j1 = Math.floor((cam.z + r1) / T);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x0 = i * T, z0 = j * T;
          if (x0 + T < f.x0 + 2 || x0 > f.x1 - 2 || z0 + T < f.z0 + 2 || z0 > f.z1 - 2) continue;
          const [lo, hi] = this.data.heightRange(x0, z0, x0 + T, z0 + T);
          const top = hi + 2.0;
          const dx = Math.max(x0 - cam.x, 0, cam.x - x0 - T), dz = Math.max(z0 - cam.z, 0, cam.z - z0 - T);
          const dy = Math.max(lo - cam.y, 0, cam.y - top);
          const dmin2 = dx * dx + dy * dy + dz * dz;
          if (dmin2 > r1 * r1) continue;
          if (rIn > 0) {
            const fx = Math.max(Math.abs(x0 - cam.x), Math.abs(x0 + T - cam.x));
            const fz = Math.max(Math.abs(z0 - cam.z), Math.abs(z0 + T - cam.z));
            const fy = Math.max(Math.abs(lo - cam.y), Math.abs(top - cam.y));
            if (fx * fx + fy * fy + fz * fz < rIn * rIn) continue;   // all inside the finer ring
          }
          box.min.set(x0, lo - 0.5, z0);
          box.max.set(x0 + T, top, z0 + T);
          if (!this._frustum.intersectsBox(box)) continue;
          const t = ring.pool[ring.list.length] || (ring.pool[ring.list.length] = { i: 0, j: 0, d: 0 });
          t.i = i; t.j = j; t.d = dmin2;
          ring.list.push(t);
        }
      }
      ring.list.sort((a, b) => a.d - b.d);
      if (ring.list.length > MAX_TILES) ring.list.length = MAX_TILES;
      ring.list.forEach((t, n) => { ring.tiles[n * 2] = t.i; ring.tiles[n * 2 + 1] = t.j; });
      count += ring.list.length * ring.tile * ring.tile;
    }
    this.count = count;
  }
}

/**
 * `quads` vertical quads crossed around the Y axis (1 = a camera-facing card); position = (x -0.5..0.5, y 0..1, quad
 * index). The card spans the texture's opaque part only (u 0.02..0.98, v 0.03..0.93: less empty area to rasterise).
 */
function cardGeometry(quads) {
  const pos = [], idx = [];
  for (let q = 0; q < quads; q++) {
    const b = pos.length / 3;
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) pos.push(c - 0.5, r, q);
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function makeMaterial(shared, own, quads) {
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines: { QUADS: quads },
    lights: true,
    fog: true,
    side: THREE.DoubleSide,
  });
  Object.assign(mat.uniforms, shared, own);
  return mat;
}

const VERT = /* glsl */ `
  #include <common>
  #include <lights_pars_begin>
  #ifdef USE_FOG
    #include <fog_pars_fragment>
  #endif
  #if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
    // the sun's cascaded shadow (sunShadow.js): one hardware-PCF tap per vertex in the cascade the vertex falls in
    uniform mat4 sunShadowMatrix[ NUM_SUN_LIGHT_SHADOWS * 2 ];
    uniform vec4 sunShadowCascade[ NUM_SUN_LIGHT_SHADOWS * 2 ];
    #if defined( SHADOWMAP_TYPE_PCF )
      uniform sampler2DShadow sunShadowMap[ NUM_SUN_LIGHT_SHADOWS ];
    #else
      uniform sampler2D sunShadowMap[ NUM_SUN_LIGHT_SHADOWS ];
    #endif
    struct SunLightShadow { float shadowIntensity; float shadowBias; float shadowNormalBias; float shadowRadius; vec2 shadowMapSize; };
    uniform SunLightShadow sunLightShadows[ NUM_SUN_LIGHT_SHADOWS ];
    // soft shadow at the blade ROOT (the terrain point under the card), so the whole card shares one value that matches
    // the ground's shadow under it: same normal offset / bias per cascade as the terrain (sunShadow.js), 5 hardware-PCF
    // taps on a fixed disc (no per-pixel noise in a vertex shader -> no swimming), cascades cross-faded like getSunShadow
    float vg_cascadeShadow(int ci, vec3 p, vec3 n) {
      float far = ci == 0 ? 0.0 : 1.0;
      vec4 sc = sunShadowMatrix[ci] * vec4(p + n * sunLightShadows[0].shadowNormalBias * mix(1.0, 5.0, far), 1.0);
      sc.xyz /= sc.w;
      sc.z += sunLightShadows[0].shadowBias * mix(1.0, 6.0, far);
      if (sc.z > 1.0) return 1.0;
      vec2 r = (sunLightShadows[0].shadowRadius * mix(1.6, 1.0, far)) / sunLightShadows[0].shadowMapSize;
    #if defined( SHADOWMAP_TYPE_PCF )
      float s = textureLod(sunShadowMap[0], sc.xyz, 0.0) * 2.0;
      s += textureLod(sunShadowMap[0], vec3(sc.xy + vec2(0.95, 0.31) * r, sc.z), 0.0);
      s += textureLod(sunShadowMap[0], vec3(sc.xy + vec2(-0.31, 0.95) * r, sc.z), 0.0);
      s += textureLod(sunShadowMap[0], vec3(sc.xy + vec2(-0.95, -0.31) * r, sc.z), 0.0);
      s += textureLod(sunShadowMap[0], vec3(sc.xy + vec2(0.31, -0.95) * r, sc.z), 0.0);
      return s / 6.0;
    #else
      return step(sc.z, textureLod(sunShadowMap[0], sc.xy, 0.0).r);
    #endif
    }
    float vg_sunShadow(vec3 p, vec3 n) {
      float vz = -(viewMatrix * vec4(p, 1.0)).z;
      vec4 c0 = sunShadowCascade[0], c1 = sunShadowCascade[1];
      float sh = 1.0;
      if (vz >= c1.x && vz < c1.y) sh = mix(vg_cascadeShadow(1, p, n), 1.0, smoothstep(c1.z, c1.y, vz));
      if (vz < c0.y) sh = mix(vg_cascadeShadow(0, p, n), sh, smoothstep(c0.z, c0.y, vz));
      return mix(1.0, sh, sunLightShadows[0].shadowIntensity);
    }
  #elif defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
    #if defined( SHADOWMAP_TYPE_PCF )
      uniform sampler2DShadow directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
    #else
      uniform sampler2D directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
    #endif
    struct DirectionalLightShadow { float shadowIntensity; float shadowBias; float shadowNormalBias; float shadowRadius; vec2 shadowMapSize; };
    uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
  #endif
  ${FIELD_GLSL}
  uniform highp sampler2D uHeight;
  uniform sampler2D uData;
  uniform vec4 uFine;
  uniform vec4 uRing;          // cell size, cells per tile side
  uniform vec4 uBand;          // fade in from x to y, fade out from z to w (3D distance)
  uniform vec4 uTiles[ ${MAX_TILES / 2} ];
  uniform float uSeed;
  uniform float uTime;
  uniform vec2 uWind;
  uniform vec3 uSunW;
  uniform vec3 uSunColor;
  uniform vec3 uEnvUp;
  uniform vec3 uEnvSide;
  out vec2 vUv;
  out vec3 vCol;
  out vec3 vAdd;
  flat out float vType;

  uint vg_h(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
  vec4 vg_rand(ivec2 c, uint seed) {
    uint h = vg_h(uint(c.x) * 1597334677u ^ vg_h(uint(c.y) * 3812015801u + seed));
    return vec4(uvec4(h, vg_h(h + 1u), vg_h(h + 2u), vg_h(h + 3u)) >> 8u) * (1.0 / 16777216.0);
  }

  void main() {
    int NT = int(uRing.y + 0.5);
    int per = NT * NT;
    int tile = gl_InstanceID / per, li = gl_InstanceID - tile * per;
    vec4 tv = uTiles[ tile >> 1 ];
    vec2 tc = (tile & 1) == 0 ? tv.xy : tv.zw;
    ivec2 cell = ivec2(tc) * NT + ivec2(li % NT, li / NT);
    vec4 r = vg_rand(cell, uint(uSeed));
    vec2 xz = (vec2(cell) + 0.1 + r.xy * 0.8) * uRing.x;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);          // dead instances: a degenerate point outside the clip volume
    vCol = vAdd = vec3(0.0); vUv = vec2(0.0); vType = 0.0;

    // cheap early-out on the horizontal distance (the 3D distance is never smaller)
    vec2 hd = xz - cameraPosition.xz;
    if (dot(hd, hd) > uBand.w * uBand.w) return;
    vec2 g = xz - uFine.xy;
    vec2 em = min(g, uFine.zw - 1.0 - g);
    if (min(em.x, em.y) < 2.0) return;

    // height: bilinear from 4 texels; the same taps give the slope
    ivec2 i0 = ivec2(floor(g));
    vec2 fr = g - vec2(i0);
    float ha = texelFetch(uHeight, i0, 0).r, hb = texelFetch(uHeight, i0 + ivec2(1, 0), 0).r;
    float hc = texelFetch(uHeight, i0 + ivec2(0, 1), 0).r, hd2 = texelFetch(uHeight, i0 + ivec2(1, 1), 0).r;
    float gh = mix(mix(ha, hb, fr.x), mix(hc, hd2, fr.x), fr.y);
    vec3 tN = normalize(vec3(-0.5 * (hb - ha + hd2 - hc), 1.0, -0.5 * (hc - ha + hd2 - hb)));
    vec3 base = vec3(xz.x, gh, xz.y);
    float d = distance(base, cameraPosition);
    float w = smoothstep(uBand.x, uBand.y, d) * (1.0 - smoothstep(uBand.z, uBand.w, d));
    if (uBand.y <= 0.0) w = 1.0 - smoothstep(uBand.z, uBand.w, d);
    // per-instance threshold; an instance grows over GROW of weight (~1 m of camera motion in a fade band), centred
    // on its threshold so the two rings' expected cover sums to 1 across the band (no dip, no pop)
    const float GROW = 0.3;
    float thr = mix(0.5 * GROW, 1.0 - 0.5 * GROW, r.z);
    if (w <= thr - 0.5 * GROW) return;

    vec4 Dt = textureLod(uData, (g + 0.5) / uFine.zw, 0.0);
    vec4 r2 = vg_rand(cell + ivec2(7919, 104729), uint(uSeed) + 101u);
    float pathD = Dt.r * ${PATH_RANGE.toFixed(1)};
    float rivS = Dt.g * ${RIVER_RANGE.toFixed(1)} + (${RIVER_MIN.toFixed(1)});
    // habitat: not on the path, in the water, on steep rock or outside the baked data
    float hab = smoothstep(2.0, 20.0, min(em.x, em.y));
    hab *= smoothstep(${(PATH_HALF + 0.1).toFixed(2)}, ${(PATH_HALF + 0.8).toFixed(2)}, pathD + (r2.z - 0.5) * 0.5);
    hab *= smoothstep(0.3, 1.3, rivS);
    hab *= smoothstep(0.8, 0.87, tN.y);
    hab *= step(${(WATER_Y + 0.3).toFixed(2)}, gh);
    float isFlower = step(r.w, vf_flowerFrac(Dt.b, xz));
    float edge = smoothstep(${PATH_HALF.toFixed(2)}, ${(PATH_HALF + 3.5).toFixed(2)}, pathD);
    float dens = isFlower > 0.5 ? 1.0 : mix(0.6, 1.0, vf_noise(xz * 0.13 + 2.0)) * mix(0.55, 1.0, edge);
    float alive = clamp((w * hab * dens - thr) / GROW + 0.5, 0.0, 1.0);
    if (alive <= 0.0) return;

    // size: knee-high at most near the camera; grows with distance (width more than height) to keep the cover
    float far = smoothstep(30.0, 300.0, d);
    float H = isFlower > 0.5 ? mix(0.3, 0.6, r2.x) : mix(0.25, 0.55, r2.x) * mix(0.75, 1.15, vf_noise(xz * 0.05));
    H *= mix(0.5, 1.0, edge) * mix(0.8, 1.0, smoothstep(0.0, 6.0, rivS));
    float sv = fract(r2.y * 13.7);                   // grass: some tufts tall and narrow, some low and wide
    float shape = isFlower > 0.5 ? 1.2 : 1.15 * mix(0.7, 1.25, sv);
    H *= isFlower > 0.5 ? 1.0 : mix(1.35, 0.85, sv);
    H *= (1.0 + 0.7 * far) * alive;
    float W = H * shape * (1.0 + 1.1 * far) / (1.0 + 0.7 * far) * (1.0 + 0.9 * far);
    // sparse outer rings: cards scale with their cell so the far field keeps its cover (wide, low clumps)
    float cellK = max(1.0, uRing.x / 1.0);
    H *= mix(1.0, cellK, 0.45);
    W *= cellK;

    vec3 right, up = vec3(0.0, 1.0, 0.0);
    vec3 toCam = cameraPosition - base;
  #if QUADS == 1
    // camera-facing around Y (jittered a little), lying back when seen from above so fields keep their cover
    float ja = (r2.y - 0.5) * 0.6;
    vec2 fc = normalize(toCam.xz + vec2(1e-4, 0.0));
    fc = mat2(cos(ja), sin(ja), -sin(ja), cos(ja)) * fc;
    right = vec3(fc.y, 0.0, -fc.x);
    vec3 v = toCam / max(d, 1e-3);
    up = normalize(mix(up, normalize(up - v * v.y + vec3(0.0, 1e-3, 0.0)), 0.6));
  #else
    float ang = r2.y * 6.2832 + position.z * 1.5708;
    right = vec3(cos(ang), 0.0, sin(ang));
  #endif
    float tH = position.y;
    vec3 wp = base + right * position.x * W + up * tH * H;
    // natural lean + wind on the top edge (length roughly preserved)
    float gust = 0.5 + 0.5 * sin(uTime * 0.55 + dot(xz, vec2(0.031, 0.017)));
    float sway = sin(uTime * 1.7 + dot(xz, vec2(0.23, 0.19)) + r.z * 4.0) * 0.6 + sin(uTime * 3.1 + dot(xz, vec2(0.71, -0.53))) * 0.25;
    vec2 bend = ((r2.zw - 0.5) * 0.4 + uWind * (0.1 + 0.28 * gust) * (0.7 + sway)) * H * (1.0 - 0.6 * far);
    wp.xz += bend * tH;
    wp.y -= dot(bend, bend) * tH * 0.4 / max(H, 0.05);
    wp.y -= 0.05 + d * 0.002;
    gl_Position = projectionMatrix * (viewMatrix * vec4(wp, 1.0));

    // ---- colour: tint x (lighting / PI + translucency) x base occlusion, then the height fog as multiply + add
    vec3 tint;
    if (isFlower > 0.5) {
      tint = vf_flowerTint(xz, r2.z);
      tint = mix(tint, vec3(1.0, 0.9, 1.45), step(0.9, fract(r2.w * 7.3)) * 0.8);   // the odd pink clump
      tint *= mix(0.62, 1.08, r2.w);
    } else tint = vf_grassTint(xz) * mix(0.75, 1.05, r2.w);
    // lighting normal: mostly the terrain's, a little facing the camera side of the card (the carpet uses the same)
    vec3 fn = normalize(vec3(toCam.x, 0.0, toCam.z) + vec3(1e-4, 0.0, 0.0));
    vec3 N = normalize(tN + fn * 0.35 + vec3(0.0, 0.25, 0.0));
    vec3 nV = normalize(mat3(viewMatrix) * N);
    vec3 irr = getAmbientLightIrradiance(ambientLightColor);
  #if NUM_HEMI_LIGHTS > 0
    irr += getHemisphereLightIrradiance(hemisphereLights[0], nV);
  #endif
  #if NUM_SUN_LIGHTS > 0
    float sh = 1.0;
    #if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
    // root of the card (+5 cm), the terrain normal: identical for the 4 corners -> one stable value per card; the
    // blades keep a little sky-lit translucency in shade (soft, not a hard on / off per blade)
    sh = mix(0.06, 1.0, vg_sunShadow(base + vec3(0.0, 0.05, 0.0), tN));
    #endif
    irr += sunLights[0].color * max(dot(nV, sunLights[0].direction), 0.0) * sh;
  #elif NUM_DIR_LIGHTS > 0
    float sh = 1.0;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      vec4 sc = directionalShadowMatrix[0] * vec4(wp + uSunW * 0.25 + vec3(0.0, 0.08, 0.0), 1.0);
      sc.xyz /= sc.w;
      sc.z += directionalLightShadows[0].shadowBias;
      if (all(greaterThanEqual(sc.xyz, vec3(0.0))) && all(lessThanEqual(sc.xyz, vec3(1.0)))) {
      #if defined( SHADOWMAP_TYPE_PCF )
        sh = textureLod(directionalShadowMap[0], sc.xyz, 0.0);
      #else
        sh = step(sc.z, textureLod(directionalShadowMap[0], sc.xy, 0.0).r);
      #endif
        sh = mix(1.0, sh, directionalLightShadows[0].shadowIntensity);
      }
    #endif
    irr += directionalLights[0].color * max(dot(nV, directionalLights[0].direction), 0.0) * sh;
  #else
    float sh = 1.0;
  #endif
    float back = pow(max(dot(normalize(wp - cameraPosition), uSunW), 0.0), 3.0) * (0.25 + 0.75 * tH * tH) * sh;   // sun through the blade tips
    float ao = mix(mix(0.42, 1.0, tH), 1.0, far * 0.6);
    vec3 env = mix(uEnvSide, uEnvUp, clamp(N.y, 0.0, 1.0));
    vCol = tint * (irr * RECIPROCAL_PI + env * 0.91 + uSunColor * back * 0.85) * ao;
  #ifdef USE_FOG
    vFogWorld = wp;
    vec4 vgFC = vec4(0.0);
    #define gl_FragColor vgFC
    {
      #include <fog_fragment>
    }
    vAdd = vgFC.rgb;
    vgFC = vec4(1.0);
    {
      #include <fog_fragment>
    }
    #undef gl_FragColor
    vCol *= vgFC.r - vAdd.r;
  #endif
    vType = isFlower;
    // card UVs over the opaque part of the texture; alpha boost keeps the coverage in the small mips
    vUv = vec2(mix(0.02, 0.98, position.x + 0.5), mix(0.03, 0.93, tH));
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uGrass;
  uniform sampler2D uFlower;
  in vec2 vUv;
  in vec3 vCol;
  in vec3 vAdd;
  flat in float vType;
  #include <common>
  ${FIELD_GLSL}
  void main() {
    vec2 gx = dFdx(vUv), gy = dFdy(vUv);
    vec4 tc = vType > 0.5 ? textureGrad(uFlower, vUv, gx, gy) : textureGrad(uGrass, vUv, gx, gy);
    // keep coverage in the small mips (alpha would otherwise erode with distance)
    float mip = 0.5 * log2(max(dot(gx, gx), dot(gy, gy)) * 1048576.0);
    if (tc.a * (1.0 + clamp(mip, 0.0, 4.0) * 0.12) < 0.5) discard;
    vec3 alb = vType > 0.5 ? vf_flowerAlb(tc.rgb) : vf_grassAlb(tc.rgb);
    gl_FragColor = vec4(alb * vCol + vAdd, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
