import * as THREE from 'three';
import { SUN_DIR } from './layout.js';
import { makeSun, installSunShadowBias } from './sunShadow.js';

/**
 * Painterly late-afternoon sky + aerial perspective for the "ruined valley" world.
 *
 *  - sky dome: the equirectangular painting /tex/w2/sky.jpg, rotated so its glowing horizon sits under SUN_DIR;
 *    towards and below the horizon it dissolves into the same lavender haze that the fog uses, so distant terrain melts into it
 *  - far mountains: a ring of keyed /tex/w2/mountains_far_strip.png segments (~3.5 km away, drawn at the far plane)
 *  - lights: hemisphere + a cascaded-shadow SunLight (sunShadow.js: crisp near cascade around the player, wide far one)
 *  - fog: installAtmosphere() replaces three's fog chunks with an exponential height fog with sun in-scattering (applies to
 *    every material that has fog: true, built-in or ShaderMaterial using the fog chunks)
 *  - envMap: PMREM of the dome, also set as scene.environment
 */

// ------------------------------------------------------------------ atmosphere parameters (shared by fog, sky, strips, water)
export const ATMOS = {
  fogColor: new THREE.Color('#adb6e4'),     // lavender-blue haze (sRGB hex, stored linear)
  sunHaze: new THREE.Color('#f8c690'),      // haze colour looking into the sun (forward scattering, golden hour)
  awayTint: new THREE.Color('#d2e0ff'),     // multiplier on the haze looking away from the sun (cool blue-lavender)
  density: 0.00095,                         // extinction per metre at the haze base height (peaks at ~1.8 km stay readable)
  falloff: 1 / 320,                         // 1 / scale height (m): haze pools in the valley, peaks poke out
  baseY: 0,                                 // height where density = density
  start: 25,                                // the first metres stay crisp (near meadow)
  mistDensity: 0.004, mistHeight: 12, mistBase: 0,          // low valley mist layer (river / cliff feet)
  mistColor: new THREE.Color('#bdbde2'),
  mistSun: new THREE.Color('#f4cfa6'),     // the mist towards the sun (lit from behind)
};

/** GLSL: haze colour seen along a direction + optical depth of the height fog (shared text, prefixed per use). */
function atmosGLSL(p, sunHazeExpr, sunDirExpr) {
  return /* glsl */ `
  vec3 ${p}Haze(vec3 dir, vec3 base) {
    float cs = dot(dir, ${sunDirExpr});
    float s = max(cs, 0.0);
    // golden forward scattering: a broad warm lobe towards the sun plus a tighter bright core; cool blue-lavender away from it
    vec3 c = base * mix(vec3(1.0), ${vec3GLSL(ATMOS.awayTint)}, clamp(-cs, 0.0, 1.0) * 0.7);
    c = mix(c, ${sunHazeExpr}, pow(s, 4.0) * 0.26 + pow(s, 14.0) * 0.22 + pow(s, 48.0) * 0.2);
    c *= 1.0 + pow(s, 32.0) * 0.1;
    return c * (1.0 + 0.06 * clamp(-dir.y * 6.0, 0.0, 1.0));            // a touch denser just below the horizon
  }
  float ${p}FogAmount(float dist, float camY, float dy, float density) {
    float L = max(dist - ${ATMOS.start.toFixed(2)}, 0.0);
    float k = ${ATMOS.falloff.toFixed(6)};
    float kdy = k * dy;
    float vert = abs(kdy) < 1e-3 ? 1.0 - 0.5 * kdy : (1.0 - exp(-kdy)) / kdy;   // mean density factor along the ray
    float tau = density * L * exp(-k * (camY - ${ATMOS.baseY.toFixed(2)})) * vert;
    return 1.0 - exp(-tau);
  }`;
}
const vec3GLSL = (v) => { const [a, b, c] = v.isColor ? [v.r, v.g, v.b] : [v.x, v.y, v.z]; return `vec3(${a.toFixed(5)}, ${b.toFixed(5)}, ${c.toFixed(5)})`; };

let installed = false;
/**
 * Globally patches THREE.ShaderChunk fog chunks (once; call before the first render, Sky2's constructor does it):
 *   colour = mix(colour, haze(viewDir), 1 - exp(-tau)), tau = height-fog optical depth along the camera ray
 *   haze(viewDir) = fogColor warmed towards ATMOS.sunHaze around SUN_DIR (in-scattering)
 * scene.fog must be a FogExp2: its .color is the haze colour, its .density the extinction per metre (NOT squared like three's).
 * A linear THREE.Fog also works (density = 2 / far). Sun direction / falloff / start are baked constants (see ATMOS).
 * World position is reconstructed from mvPosition, so it works for instanced, skinned, sprite and points materials too.
 */
export function installAtmosphere() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorld;
#endif`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogWorld = cameraPosition + mvPosition.xyz * mat3(viewMatrix);      // = inverse(view) * mvPosition (rigid view matrix)
#endif`;
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  ${atmosGLSL('atmos', vec3GLSL(ATMOS.sunHaze), vec3GLSL(SUN_DIR))}
#endif`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  vec3 fogRay = vFogWorld - cameraPosition;
  float fogDist = length(fogRay);
  #ifdef FOG_EXP2
    float fogDens = fogDensity;
  #else
    float fogDens = 2.0 / max(fogFar, 1.0);
  #endif
  float fogFactor = atmosFogAmount(fogDist, cameraPosition.y, fogRay.y, fogDens);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, atmosHaze(fogRay / max(fogDist, 1e-4), fogColor), fogFactor);
  // valley mist: a thin, low lavender layer pooled over the river and around the cliff feet (scale height 12 m),
  // starting 40 m out so the meadow around the player stays clear
  {
    float mk = ${(1 / ATMOS.mistHeight).toFixed(5)};
    float mL = max(fogDist - 40.0, 0.0);
    float mkdy = mk * fogRay.y;
    float mvert = abs(mkdy) < 1e-3 ? 1.0 - 0.5 * mkdy : (1.0 - exp(-mkdy)) / mkdy;
    float mtau = ${ATMOS.mistDensity.toFixed(5)} * mL * exp(-mk * max(cameraPosition.y - ${ATMOS.mistBase.toFixed(2)}, 0.0)) * min(mvert, 30.0);
    float msun = pow(max(dot(fogRay / max(fogDist, 1e-4), ${vec3GLSL(SUN_DIR)}), 0.0), 4.0);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(${vec3GLSL(ATMOS.mistColor)}, ${vec3GLSL(ATMOS.mistSun)}, msun * 0.75), (1.0 - exp(-mtau)) * 0.85);
  }
#endif`;
}

// ------------------------------------------------------------------ sky dome GLSL (exported for the water reflection)
/** where the sun glow sits in sky.jpg (u from the left edge, measured) */
const SKY_SUN_U = 1580 / 2048;
/**
 * Sky colour along a world direction. Uniforms: uSky (equirect texture), uSkyOffset, uHazeColor, uSunHaze, uSunDir.
 * skyColor(dir) uses screen-space derivatives (seam free); skyColorLod(dir, lod) is for reflections.
 */
export const SKY_GLSL = /* glsl */ `
  uniform sampler2D uSky;
  uniform float uSkyOffset;
  uniform float uUntone;
  uniform float uCloudWhiten;
  uniform vec3 uHazeColor;
  uniform vec3 uSunHaze;
  uniform vec3 uSunDir;
  ${atmosGLSL('sky', 'uSunHaze', 'uSunDir')}
  // the painting is display-referred: undo NeutralToneMapping's highlight compression so it ends up on screen as painted
  vec3 skyUntone(vec3 o) {
    const float st = 0.76, d = 0.24;
    vec3 c = o;
    float m = min(max(o.r, max(o.g, o.b)), 0.93);
    if (m > st) {                                                        // undo the highlight compression
      float p = d * d / (1.0 - m) - d + st;
      float g = 1.0 - 1.0 / (0.15 * (p - m) + 1.0);
      c = (min(o, vec3(m)) - g * m) / (1.0 - g) * p / m;
    }
    float mn = min(c.r, min(c.g, c.b));                                  // undo the toe offset
    float x = sqrt(max(mn, 0.0) / 6.25);
    c += mn < 0.04 ? x - mn : 0.04;
    return mix(o, c, uUntone);
  }
  // equirect uv; the painting is not periodic, so the last 5% of its width is cross-faded into its start (no seam)
  const float SKY_SEAM = 0.05;
  vec2 skyUv(vec3 d) {
    return vec2(atan(d.z, d.x) * 0.15915494 + 0.5 + uSkyOffset, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  }
  vec3 skySample(vec2 uv, vec2 dx, vec2 dy, float lod, bool useGrad) {
    float x = fract(uv.x) * (1.0 - SKY_SEAM);
    vec2 a = vec2(x, uv.y), b = vec2(x + 1.0 - SKY_SEAM, uv.y);
    dx.x *= 1.0 - SKY_SEAM; dy.x *= 1.0 - SKY_SEAM;
    vec3 ca = useGrad ? textureGrad(uSky, a, dx, dy).rgb : textureLod(uSky, a, lod).rgb;
    if (x < SKY_SEAM) {
      vec3 cb = useGrad ? textureGrad(uSky, b, dx, dy).rgb : textureLod(uSky, b, lod).rgb;
      float k = smoothstep(0.0, 1.0, x / SKY_SEAM);
      ca = mix(cb, ca, k);
    }
    // grade: warm highlights read as cream / white cumulus rather than peach (uCloudWhiten 0..1)
    float lum = dot(ca, vec3(0.299, 0.587, 0.114));
    float warm = smoothstep(0.0, 0.3, ca.r - ca.b) * smoothstep(0.45, 0.85, lum);
    ca = mix(ca, lum * vec3(1.07, 1.0, 0.87), warm * uCloudWhiten);
    return skyUntone(ca);
  }
  // the painting -> haze towards/below the horizon
  vec3 skyCompose(vec3 d, vec3 tex) {
    float h = d.y;
    float hz = 1.0 - smoothstep(-0.015, 0.2, h);
    hz = hz * hz * (3.0 - 2.0 * hz);
    vec3 haze = skyHaze(d, uHazeColor);
    return mix(tex, haze, clamp(hz * 0.92 + (1.0 - smoothstep(-0.06, 0.0, h)) * 0.08, 0.0, 1.0));
  }
  vec3 skyColor(vec3 d) {
    vec2 uv = skyUv(d);
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    dx.x -= floor(dx.x + 0.5); dy.x -= floor(dy.x + 0.5);                 // the atan wrap must not pick the smallest mip
    return skyCompose(d, skySample(uv, dx, dy, 0.0, true));
  }
  vec3 skyColorLod(vec3 d, float lod) { return skyCompose(d, skySample(skyUv(d), vec2(0.0), vec2(0.0), lod, false)); }
`;

// ------------------------------------------------------------------ mountain strip keying
/**
 * The strip PNG has an opaque painted glow above the ridge line. Key it out: per column, the ridge top is the first row
 * with textured detail (local gradient energy inside the solid alpha), everything above it becomes transparent.
 */
function keyStrip(img) {
  const W = img.width, H = img.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const id = g.getImageData(0, 0, W, H), d = id.data;
  const lum = new Float32Array(W * H), solid = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { lum[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3; solid[i] = d[i * 4 + 3] > 200 ? 1 : 0; }
  // eroded (vertically, 12 px) solid mask so the anti-aliased matte edge doesn't count as detail
  const er = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    let run = 0;
    const ok = new Uint8Array(H);
    for (let y = 0; y < H; y++) { run = solid[x + y * W] ? run + 1 : 0; if (run >= 25) ok[y - 12] = 1; }
    for (let y = 0; y < H; y++) er[x + y * W] = ok[y];
  }
  // gradient energy, box-filtered 9x9 with an integral image
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      let e = 0;
      if (x > 0 && x < W - 1 && y > 0 && y < H - 1 && er[x + y * W]) {
        const i = x + y * W;
        e = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + W] - lum[i - W]);
      }
      row += e;
      S[(x + 1) + (y + 1) * (W + 1)] = S[(x + 1) + y * (W + 1)] + row;
    }
  }
  const box = (x, y, r) => {
    const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    return (S[x1 + y1 * (W + 1)] - S[x0 + y1 * (W + 1)] - S[x1 + y0 * (W + 1)] + S[x0 + y0 * (W + 1)]) / ((x1 - x0) * (y1 - y0));
  };
  const top = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H && box(x, y, 4) <= 8) y++;
    top[x] = y;
  }
  for (let x = 0; x < W; x++) {
    const edge = Math.min(1, Math.min(x, W - 1 - x) / (W * 0.06));                 // soft ends: segments overlap
    for (let y = 0; y < H; y++) {
      const i = (x + y * W) * 4;
      d[i + 3] *= THREE.MathUtils.clamp((y - top[x] + 2) / 5, 0, 1) * edge;
    }
  }
  g.putImageData(id, 0, 0);
  return c;
}

// ------------------------------------------------------------------ Sky2
export class Sky2 {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {{shadowMapSize?: number, shadowExtent?: number}} [opts]
   */
  constructor(scene, renderer, opts = {}) {
    installAtmosphere();
    installSunShadowBias();
    this.scene = scene;
    this.renderer = renderer;
    const maxAniso = renderer.capabilities.getMaxAnisotropy();

    // ---- env (lighting + fog parameters, consumed by water / terrain / vegetation)
    const sunDir = SUN_DIR.clone();
    this.env = {
      sunDir,
      sunColor: new THREE.Color('#ffd6a6'),     // golden-hour sun
      sunIntensity: 3.7,
      skyColor: new THREE.Color('#93b2ec'),     // cool sky fill: shadows read blue against the warm sunlit side
      groundColor: new THREE.Color('#6a6446'),
      fogColor: ATMOS.fogColor.clone(),
      fogDensity: ATMOS.density,
      sunHaze: ATMOS.sunHaze.clone(),
      envMap: null,                    // PMREM of the sky, set once sky.jpg is loaded (also scene.environment)
      skyTexture: null,
      skyUniforms: null,               // shared uniforms for SKY_GLSL (water reflections)
    };
    const env = this.env;

    // ---- fog
    scene.fog = new THREE.FogExp2(env.fogColor, env.fogDensity);
    scene.fog.color = env.fogColor;   // same object: tweaking env.fogColor updates everything

    // ---- lights
    this.hemi = new THREE.HemisphereLight(env.skyColor, env.groundColor, 0.5);
    scene.add(this.hemi);
    // two cascades fitted to the view frustum: 0..30 m (~0.03 m texels) and 27..220 m (~0.17 m texels)
    const sun = makeSun(env.sunColor, env.sunIntensity, sunDir, { mapSize: opts.shadowMapSize ?? 2048, split: 30, distance: opts.shadowDistance ?? 220 });
    this.sun = sun;
    scene.add(sun);

    // ---- sky dome
    const skyTex = new THREE.Texture();
    this.uniforms = {
      uSky: { value: skyTex },
      uSkyOffset: { value: 0 },
      uCloudWhiten: { value: 0.22 },          // keep the golden cloud tops (golden hour)
      uUntone: { value: 1 },                  // 1 = sky shows as painted after NeutralToneMapping (exposure 1)
      uHazeColor: { value: env.fogColor },
      uSunHaze: { value: env.sunHaze },
      uSunDir: { value: sunDir },
      uFogDensity: { value: env.fogDensity },
      uStripFog: { value: 0.82 },
      uSunDisc: { value: new THREE.Color(1.0, 0.86, 0.62) },   // sun disc + halo (dome only, not the reflections)
    };
    // rotate the painting so its sun glow lies in the azimuth of SUN_DIR
    const uSun = Math.atan2(sunDir.z, sunDir.x) / (2 * Math.PI) + 0.5;
    this.uniforms.uSkyOffset.value = SKY_SUN_U / (1 - 0.05) - uSun;       // (0.05 = SKY_SEAM: u is compressed by it)
    env.skyUniforms = this.uniforms;

    const domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;                                           // at the far plane, independent of camera.far
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 uSunDisc;
        ${SKY_GLSL}
        void main() {
          vec3 d = normalize(vDir);
          vec3 c = skyColor(d);
          // sun: a small HDR disc (blooms a little), a warm corona and a wide golden glow that ties into the painted horizon
          float s = max(dot(d, uSunDir), 0.0);
          float disc = smoothstep(0.99985, 0.99992, s);
          c = mix(c, uSunDisc * 9.0, disc);
          c += uSunDisc * (pow(s, 2500.0) * 2.5 + pow(s, 300.0) * 0.4 + pow(s, 40.0) * 0.06) * (1.0 - disc);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 96, 48), domeMat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    // ---- far mountain ring
    this.strips = new THREE.Group();
    this.strips.renderOrder = -9;
    scene.add(this.strips);

    const loader = new THREE.TextureLoader();
    const skyReady = loader.loadAsync('tex/w2/sky.jpg').then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.RepeatWrapping;
      t.anisotropy = Math.min(8, maxAniso);
      this.uniforms.uSky.value = t;
      env.skyTexture = t;
      this._buildEnvMap();
    });
    const stripReady = new THREE.ImageLoader().loadAsync('tex/w2/mountains_far_strip.png').then((img) => {
      const tex = new THREE.CanvasTexture(keyStrip(img));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, maxAniso);
      this._buildStrips(tex);
    });
    /** resolves when the textures, the far mountains and the envMap are ready */
    this.ready = Promise.all([skyReady, stripReady]);
  }

  /** PMREM env map of the dome (sky + haze), used as scene.environment for sky-tinted ambient/specular. */
  _buildEnvMap() {
    const pm = new THREE.PMREMGenerator(this.renderer);
    const s = new THREE.Scene();
    const dome = new THREE.Mesh(this.dome.geometry, this.dome.material);
    s.add(dome);
    const rt = pm.fromScene(s, 0.02, 1, 2000);
    pm.dispose();
    this.env.envMap = rt.texture;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.5;
  }

  /**
   * Cylinder segments of the keyed strip ~3.5 km away. Drawn at the far plane after the opaque pass (transparent),
   * so they only show where nothing else is drawn. Each: azimuth centre (deg, 0 = -Z, + towards +X), span (deg),
   * height scale, texture u range, radius (only matters for the fog amount).
   */
  _buildStrips(tex) {
    const segs = [
      { az: 22, span: 78, h: 1.0, u0: 0.0, u1: 1.0, r: 3600 },
      { az: -48, span: 72, h: 0.8, u0: 0.18, u1: 0.98, r: 3300 },
      { az: 92, span: 74, h: 0.72, u0: 0.02, u1: 0.85, r: 3800 },
      { az: -118, span: 76, h: 0.7, u0: 0.1, u1: 0.95, r: 3500 },
      { az: 160, span: 80, h: 0.62, u0: 0.0, u1: 0.9, r: 3700 },
      { az: -178, span: 66, h: 0.66, u0: 0.25, u1: 1.0, r: 3400 },
    ];
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      uniforms: { ...this.uniforms, uMap: { value: tex } },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vDir; varying float vR;
        void main() {
          vUv = uv;
          vDir = position;
          vR = length(position.xz);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vDir; varying float vR;
        uniform sampler2D uMap; uniform float uFogDensity; uniform float uStripFog;
        ${SKY_GLSL}
        void main() {
          vec4 m = texture2D(uMap, vUv);
          m.rgb = skyUntone(m.rgb);
          if (m.a < 0.004) discard;
          vec3 d = normalize(vDir);
          // aerial perspective: the same height fog as the scene, from eye level (~10 m) out to the strip
          float f = skyFogAmount(vR, 10.0, vDir.y, uFogDensity) * uStripFog;
          f = max(f, 1.0 - smoothstep(0.0, 0.06, d.y) * 0.9);                // feet dissolve into the horizon haze
          vec3 c = mix(m.rgb, skyHaze(d, uHazeColor), clamp(f, 0.0, 1.0));
          gl_FragColor = vec4(c, m.a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const aspect = tex.image.width / tex.image.height;
    for (const s of segs) {
      const n = 64, pos = [], uv = [], idx = [];
      const span = THREE.MathUtils.degToRad(s.span), az0 = THREE.MathUtils.degToRad(s.az) - span / 2;
      const width = s.r * span;
      const height = (width / (s.u1 - s.u0)) / aspect * s.h * 0.62;   // keep the painting's proportions (scaled down a bit)
      const yBot = -s.r * Math.tan(THREE.MathUtils.degToRad(1.2)) - height * 0.18;
      for (let i = 0; i <= n; i++) {
        const a = az0 + span * i / n, x = Math.sin(a) * s.r, z = -Math.cos(a) * s.r;
        const u = s.u0 + (s.u1 - s.u0) * i / n;
        pos.push(x, yBot, z, x, yBot + height, z);
        uv.push(u, 0, u, 1);
        if (i < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = -s.r / 1e5;          // far ones first (group order -9 puts the ring before other transparents)
      this.strips.add(mesh);
    }
  }

  /** (kept for callers) the cascades follow the view camera by themselves, texel-snapped: nothing to do */
  setFocus() {}

  /** per frame: keep the dome / ring centred on the camera, sync fog density */
  update(t, camPos) {
    this.dome.position.copy(camPos);
    this.strips.position.copy(camPos);
    this.uniforms.uFogDensity.value = this.scene.fog?.density ?? this.env.fogDensity;
  }
}
