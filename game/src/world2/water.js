import * as THREE from 'three';
import { WATER_Y, RIVER, BASIN, riverDist, heightAt } from './layout.js';
import { rng, noise2 } from './noise.js';
import { SKY_GLSL } from './sky.js';

/**
 * River, plunge pool, waterfalls and mist.
 *
 *  - water surface: ONE flat plane at WATER_Y over the river corridor, drawn after the terrain (the terrain hides it wherever
 *    the ground is above water). A baked data texture (2 m texels) holds per-texel water depth (heightAt) and the flow vector
 *    (river tangent, radial spreading in the basin), so the river, its bends and the basin share one seamless surface.
 *    Shader: flow-mapped ripple normals (two-phase advection), painted-sky reflection (SKY_GLSL) + Fresnel, teal body colour
 *    by depth, soft shore foam and churned foam under the falls, sun glint, sun shadows, scene fog.
 *  - waterfalls: ballistic curved sheets (outward arc at the lip, widening) with streaks that stretch as the water
 *    accelerates; a veil layer; billowing instanced mist at the base and spray at the lip.
 *  - mist: GPU-animated camera-facing puffs (life cycle in the vertex shader), pseudo-volumetric sun lighting, fade at
 *    the floor plane so they don't cut hard lines into the water.
 */

const GLSL_NOISE = /* glsl */ `
  float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y);
  }
  float wFbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * wNoise(p); p = p * 2.03 + 1.7; a *= 0.5; } return s / 0.9375; }
`;

/** tileable ripple normal map (sum of periodic waves): rg = normal xz, b = height (for foam) */
function rippleTexture(size = 256, seed = 7) {
  const r = rng(seed), waves = [];
  for (let i = 0; i < 56; i++) {
    const k = 2 + Math.floor(Math.pow(r(), 1.6) * 26), a = r() * Math.PI * 2;
    const kx = Math.round(Math.cos(a) * k), ky = Math.round(Math.sin(a) * k);
    if (!kx && !ky) continue;
    waves.push({ kx, ky, amp: 1 / Math.pow(Math.hypot(kx, ky), 1.25), ph: r() * Math.PI * 2 });
  }
  const data = new Uint8Array(size * size * 4), hs = new Float32Array(size * size), nx = new Float32Array(size * size), nz = new Float32Array(size * size);
  let hMin = 1e9, hMax = -1e9, gMax = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let h = 0, dx = 0, dy = 0;
    for (const w of waves) {
      const ph = 2 * Math.PI * (w.kx * x + w.ky * y) / size + w.ph;
      h += w.amp * Math.cos(ph);
      const s = -w.amp * Math.sin(ph) * 2 * Math.PI / size;
      dx += s * w.kx; dy += s * w.ky;
    }
    const i = x + y * size;
    hs[i] = h; nx[i] = dx; nz[i] = dy;
    hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); gMax = Math.max(gMax, Math.abs(dx), Math.abs(dy));
  }
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = (nx[i] / gMax * 0.5 + 0.5) * 255;
    data[i * 4 + 1] = (nz[i] / gMax * 0.5 + 0.5) * 255;
    data[i * 4 + 2] = (hs[i] - hMin) / (hMax - hMin) * 255;
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** soft billowy puffs, 2x2 atlas (white, alpha = density): ridged-noise "cauliflower" density inside a soft round mask */
function puffAtlas(seed = 3) {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S * 2;
  const g = c.getContext('2d'), img = g.createImageData(S * 2, S * 2), d = img.data;
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * S, oy = Math.floor(cell / 2) * S, sx = seed * 17.3 + cell * 41.7;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S - 0.5, v = (y + 0.5) / S - 0.5;
      const r = Math.hypot(u, v * 1.1) / 0.5;
      if (r >= 1) continue;
      let b = 0, a = 0.5, f = 3.2;
      for (let o = 0; o < 4; o++) { b += a * (1 - Math.abs(noise2(u * f + sx, v * f - sx))); f *= 2.1; a *= 0.5; }
      const fall = Math.pow(1 - r, 1.3);
      const den = THREE.MathUtils.clamp(fall * (0.35 + 1.1 * b) * 1.25 - 0.18, 0, 1);
      const k = ((oy + y) * S * 2 + ox + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = 255;
      d[k + 3] = den * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;               // soft and magnified; mips would bleed between atlas cells
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

// ================================================================== mist
/** Instanced, GPU-animated mist / spray puffs. */
class Mist {
  constructor(scene, env, shared) {
    this.items = [];
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uMap: { value: null },
      uSunDir: { value: env.sunDir }, uSunCol: { value: env.sunColor }, uSkyCol: { value: env.skyColor },
      uShadeCol: { value: new THREE.Color('#c3c7e3') }, uWind: { value: new THREE.Vector3(-1.0, 0, 0.35) },
    }]);
    this.uniforms.uTime = shared.uTime;
    this.uniforms.uMap.value = puffAtlas();
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, fog: true,
      vertexShader: /* glsl */ `
        attribute vec4 aCenter;      // xyz, floor y
        attribute vec4 aP;           // radius, phase, rate, seed
        attribute vec2 aO;           // opacity, rise
        uniform float uTime; uniform vec3 uWind;
        varying vec2 vUv; varying vec2 vCorner; varying float vAlpha; varying vec3 vW; varying float vFloor; varying float vR;
        varying vec3 vRight; varying vec3 vUp; varying vec2 vCell;
        #include <fog_pars_vertex>
        void main() {
          float life = fract(uTime * aP.z + aP.y);
          float seed = aP.w;
          float size = aP.x * (0.55 + 0.8 * life);
          float ang = seed * 6.2832;
          vec3 c = aCenter.xyz + vec3(cos(ang), 0.0, sin(ang)) * aP.x * 0.5 * life
                 + vec3(0.0, aP.x * aO.y * life, 0.0) + uWind * life * aP.x * 0.35;
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float rot = ang + life * (seed > 0.5 ? 0.7 : -0.7);
          vec2 q = mat2(cos(rot), sin(rot), -sin(rot), cos(rot)) * position.xy;
          vec3 corner = (right * position.x + up * position.y) * size * 2.0;
          vW = c + corner; vFloor = aCenter.w; vR = size; vRight = right; vUp = up;
          // no depth buffer for soft particles: pull the quad towards the camera (keeping its screen size) so it doesn't
          // slice hard lines through the cliff / ground behind it
          vec3 toC = cameraPosition - c; float dc = max(length(toC), 1e-3);
          float pull = min(size * 1.2, dc * 0.6);
          vec3 w = c + toC / dc * pull + corner * ((dc - pull) / dc);
          vCorner = position.xy * 2.0;
          vUv = q + 0.5;
          float cellI = floor(fract(seed * 7.13) * 4.0);
          vCell = vec2(mod(cellI, 2.0), floor(cellI / 2.0 + 0.25)) * 0.5;      // atlas offset (computed per vertex: no float-floor flicker)
          vAlpha = aO.x * smoothstep(0.0, 0.18, life) * (1.0 - smoothstep(0.5, 1.0, life));
          vec4 mvPosition = viewMatrix * vec4(w, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uSkyCol; uniform vec3 uShadeCol;
        varying vec2 vUv; varying vec2 vCorner; varying float vAlpha; varying vec3 vW; varying float vFloor; varying float vR;
        varying vec3 vRight; varying vec3 vUp; varying vec2 vCell;
        #include <fog_pars_fragment>
        void main() {
          vec4 m = texture2D(uMap, clamp(vUv, 0.01, 0.99) * 0.5 + vCell);
          float a = m.a * vAlpha * (1.0 - smoothstep(0.75, 1.0, length(vCorner)));   // never reaches the quad edge
          a *= smoothstep(vFloor - 0.3, vFloor + vR * 0.45, vW.y);                     // soft contact with the water/ground
          float camD = length(vW - cameraPosition);
          a *= smoothstep(vR * 0.15, vR * 0.9, camD);                                   // don't smear over the lens
          if (a < 0.003) discard;
          // pseudo-volumetric shading: the quad as a sphere
          vec3 V = normalize(cameraPosition - vW);
          float r2 = dot(vCorner, vCorner);
          vec3 n = normalize(vRight * vCorner.x + vUp * vCorner.y + V * sqrt(max(1.0 - r2, 0.05)));
          float diff = dot(n, uSunDir) * 0.5 + 0.5;
          float back = pow(max(dot(-V, uSunDir), 0.0), 4.0) * (1.0 - m.a) * 1.4;     // silver edges when backlit
          vec3 lit = vec3(1.0, 0.97, 0.93) * (0.8 + 0.2 * uSunCol);
          vec3 col = mix(uShadeCol, lit, smoothstep(0.0, 1.0, diff * 0.7 + 0.3)) + uSunCol * back * 0.5;
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.mesh = null;
    this.scene = scene;
    this.r = rng(91);
  }

  /** add `count` puffs around pos within `radius` (opts: count, size (puff radius factor), rate, opacity, rise, spread) */
  add(pos, radius, opts = {}) {
    const r = this.r;
    const n = opts.count ?? Math.round(8 + radius * 0.8);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * radius * (opts.spread ?? 0.6);
      const pr = radius * (opts.size ?? 0.5) * (0.65 + r() * 0.7);
      this.items.push({
        c: [pos.x + Math.cos(a) * d, pos.y + (opts.lift ?? 0.25) * pr + r() * pr * 0.3, pos.z + Math.sin(a) * d, opts.floor ?? pos.y],
        p: [pr, (i + r() * 0.5) / n, (opts.rate ?? 0.06) * (0.75 + r() * 0.5), r()],
        o: [(opts.opacity ?? 0.5) * (0.7 + r() * 0.3), opts.rise ?? 0.6],
      });
    }
    this._rebuild();
  }

  _rebuild() {
    const g = new THREE.InstancedBufferGeometry();
    const q = new THREE.PlaneGeometry(1, 1);
    g.index = q.index;
    g.setAttribute('position', q.getAttribute('position'));
    const N = this.items.length, c = new Float32Array(N * 4), p = new Float32Array(N * 4), o = new Float32Array(N * 2);
    this.items.forEach((it, i) => { c.set(it.c, i * 4); p.set(it.p, i * 4); o.set(it.o, i * 2); });
    g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(c, 4));
    g.setAttribute('aP', new THREE.InstancedBufferAttribute(p, 4));
    g.setAttribute('aO', new THREE.InstancedBufferAttribute(o, 2));
    g.instanceCount = N;
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.geometry = g; return; }
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.scene.add(this.mesh);
  }
}

// ================================================================== Water2
export class Water2 {
  /**
   * @param {THREE.Scene} scene
   * @param {object} env  Sky2.env (sunDir, sunColor, skyColor, fogColor, skyUniforms, ...)
   */
  constructor(scene, env) {
    this.scene = scene;
    this.env = env;
    this.falls = [];
    this.shared = { uTime: { value: 0 } };
    this._buildSurface();
    this.mist = new Mist(scene, env, this.shared);
    this._fallMats = [];
  }

  // ---------------------------------------------------------------- surface
  _buildSurface() {
    const env = this.env;
    // bounds of the river corridor
    const pts = RIVER.getSpacedPoints(400);
    let minX = BASIN.x - BASIN.r - 40, maxX = BASIN.x + BASIN.r + 40, minZ = BASIN.z - BASIN.r - 40, maxZ = BASIN.z + BASIN.r + 40;
    for (const p of pts) { minX = Math.min(minX, p.x - 50); maxX = Math.max(maxX, p.x + 50); minZ = Math.min(minZ, p.z - 50); maxZ = Math.max(maxZ, p.z + 50); }
    const cell = 2, W = Math.ceil((maxX - minX) / cell) + 1, H = Math.ceil((maxZ - minZ) / cell) + 1;
    maxX = minX + (W - 1) * cell; maxZ = minZ + (H - 1) * cell;
    // tangent lookup along the river
    const NT = 512, tan = [];
    for (let i = 0; i <= NT; i++) tan.push(RIVER.getTangentAt(i / NT));
    const data = new Uint8Array(W * H * 4);
    const t0 = performance.now();
    for (let j = 0; j < H; j++) {
      const z = minZ + j * cell;
      for (let i = 0; i < W; i++) {
        const x = minX + i * cell, k = (i + j * W) * 4;
        const rd = riverDist(x, z), bd = Math.hypot(x - BASIN.x, z - BASIN.z);
        if (rd.d > rd.half + 24 && bd > BASIN.r + 26) { data[k + 1] = data[k + 2] = 128; continue; }
        const depth = Math.max(0, WATER_Y - heightAt(x, z));
        const T = tan[Math.round(THREE.MathUtils.clamp(rd.t, 0, 1) * NT)];
        // faster in mid-stream, slow near the banks; slow spreading in the pool
        const prof = 0.45 + 0.55 * (1 - THREE.MathUtils.smoothstep(rd.d / rd.half, 0.2, 1.3));
        let fx = T.x * 1.1 * prof, fz = T.z * 1.1 * prof;
        const wb = 1 - THREE.MathUtils.smoothstep(bd, BASIN.r * 0.5, BASIN.r + 8);
        if (wb > 0) {
          const ox = (x - BASIN.x) / (bd || 1), oz = (z - BASIN.z) / (bd || 1);
          fx = THREE.MathUtils.lerp(fx, ox * 0.35, wb); fz = THREE.MathUtils.lerp(fz, oz * 0.35, wb);
        }
        data[k] = Math.min(255, depth / 4 * 255);
        data[k + 1] = THREE.MathUtils.clamp(fx / 2 * 0.5 + 0.5, 0, 1) * 255;
        data[k + 2] = THREE.MathUtils.clamp(fz / 2 * 0.5 + 0.5, 0, 1) * 255;
        data[k + 3] = 255;
      }
    }
    this.bakeMs = performance.now() - t0;
    const dataTex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    dataTex.magFilter = dataTex.minFilter = THREE.LinearFilter;
    dataTex.needsUpdate = true;

    this.falls = [];
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog, {
      uData: { value: dataTex }, uRect: { value: new THREE.Vector4(minX, minZ, 1 / (maxX - minX + cell), 1 / (maxZ - minZ + cell)) },
      uRipple: { value: rippleTexture() },
      uSunCol: { value: env.sunColor }, uSkyCol: { value: env.skyColor },
      uDeep: { value: new THREE.Color('#13474f') }, uShallow: { value: new THREE.Color('#4c8a7c') }, uBank: { value: new THREE.Color('#4a5a3a') },
      uFalls: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uFallCount: { value: 0 },
    }]);
    // shared objects (merge clones them)
    Object.assign(uniforms, env.skyUniforms, this.shared);
    uniforms.uSunCol.value = env.sunColor; uniforms.uSkyCol.value = env.skyColor;
    this.uniforms = uniforms;

    const mat = new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: true, fog: true, lights: true,
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        #include <shadowmap_pars_vertex>
        varying vec3 vWorld;
        void main() {
          vec3 transformed = position;
          vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
          vWorld = worldPosition.xyz;
          vec4 mvPosition = viewMatrix * worldPosition;
          vec3 transformedNormal = normalMatrix * vec3(0.0, 1.0, 0.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <shadowmap_vertex>
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <packing>
        #include <fog_pars_fragment>
        #include <lights_pars_begin>
        #include <shadowmap_pars_fragment>
        #include <shadowmask_pars_fragment>
        ${SKY_GLSL}
        uniform sampler2D uData; uniform vec4 uRect; uniform sampler2D uRipple; uniform float uTime;
        uniform vec3 uSunCol; uniform vec3 uSkyCol; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uBank;
        uniform vec4 uFalls[6]; uniform int uFallCount;
        varying vec3 vWorld;

        // two-phase flow-mapped sample of the ripple texture (xy = slope, z = height)
        vec3 flowSample(vec2 p, vec2 flow, float tile, float period, float off) {
          float t = uTime / period + off;
          float p0 = fract(t), p1 = fract(t + 0.5);
          float w = abs(1.0 - 2.0 * p0);
          vec3 a = texture2D(uRipple, (p - flow * p0 * period) / tile + off).xyz;
          vec3 b = texture2D(uRipple, (p - flow * p1 * period) / tile + off + 0.37).xyz;
          return mix(a, b, w);
        }

        void main() {
          vec2 duv = (vWorld.xz - uRect.xy) * uRect.zw;
          vec4 D = texture2D(uData, duv);
          float depth = D.r * 4.0;
          if (depth < 0.004) discard;
          vec2 flow = (D.gb * 2.0 - 1.0) * 2.0;
          float speed = length(flow);
          vec3 toCam = cameraPosition - vWorld;
          float dist = length(toCam);
          vec3 V = toCam / dist;

          // waterfall impacts: churn + foam
          float churn = 0.0;
          for (int i = 0; i < 6; i++) {
            if (i >= uFallCount) break;
            vec4 F = uFalls[i];
            float d = length(vWorld.xz - F.xy);
            churn = max(churn, (1.0 - smoothstep(F.z * 0.25, F.z * 1.4, d)) * F.w);
          }

          // ripple normals: two flow-advected octaves + a slow broad swell
          vec3 s1 = flowSample(vWorld.xz, flow, 9.0, 2.4, 0.0);
          vec3 s2 = flowSample(vWorld.xz, flow * 1.3, 3.4, 1.6, 0.21);
          vec2 broad = texture2D(uRipple, vWorld.xz / 41.0 + vec2(uTime * 0.004, uTime * 0.003)).xy * 2.0 - 1.0;
          vec2 slope = (s1.xy * 2.0 - 1.0) * 0.55 + (s2.xy * 2.0 - 1.0) * 0.3 + broad * 0.35;
          float strength = (0.045 + speed * 0.035 + churn * 0.4) * mix(1.0, 0.4, smoothstep(30.0, 300.0, dist));
          vec3 N = normalize(vec3(slope.x * strength, 1.0, slope.y * strength));

          // reflection of the painted sky (+ fake reflection of the grassy banks in the shallows)
          vec3 R = reflect(-V, N);
          R.y = abs(R.y);
          vec3 refl = skyColorLod(normalize(R + vec3(0.0, 0.015, 0.0)), 2.2 + churn * 2.0);
          refl *= vec3(0.9, 0.98, 1.0);                                                 // slightly teal
          float bankK = (1.0 - smoothstep(0.05, 1.4, depth)) * 0.55;
          refl = mix(refl, uBank * (uSunCol * 0.25 + uSkyCol * 0.45), bankK);
          float cosV = max(dot(N, V), 0.0);
          float fres = 0.04 + 0.96 * pow(1.0 - cosV, 5.0);
          fres = mix(0.28, 1.0, fres);                                                  // painterly: a bright, sky-coloured river

          float shadow = getShadowMask();
          float sunK = mix(0.35, 1.0, shadow);
          vec3 body = mix(uShallow, uDeep, smoothstep(0.1, 2.4, depth));
          body *= uSkyCol * 0.55 + uSunCol * 0.35 * sunK * max(uSunDir.y, 0.0);
          refl *= mix(0.82, 1.0, shadow);                                            // shade reads on the water
          vec3 col = mix(body, refl, fres);

          // foam: shoreline lace + churned water below the falls, advected with the flow
          float fn = flowSample(vWorld.xz, flow, 3.1, 2.6, 0.5).z;
          float fn2 = texture2D(uRipple, vWorld.xz * 0.037 - flow * uTime * 0.01 + 0.31).z;
          float shore = 1.0 - smoothstep(0.0, 0.1 + fn2 * 0.12, depth);
          float foam = smoothstep(0.55, 0.9, fn * 0.7 + shore * 0.5) * shore * 0.8;
          foam = max(foam, smoothstep(0.35, 0.75, fn * 0.6 + fn2 * 0.5) * churn);
          foam = max(foam, smoothstep(0.55, 0.85, fn * 0.7 + fn2 * 0.4) * churn * 0.6 + churn * 0.35);
          vec3 foamCol = uSkyCol * 0.55 + uSunCol * 0.6 * sunK;
          col = mix(col, foamCol, clamp(foam, 0.0, 1.0) * 0.85);

          // sun glint
          float sd = max(dot(R, uSunDir), 0.0);
          col += uSunCol * (pow(sd, 900.0) * 10.0 + pow(sd, 90.0) * 0.5) * shadow * (1.0 - foam);

          float alpha = smoothstep(0.0, 0.22, depth);
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    const geo = new THREE.PlaneGeometry(maxX - minX + cell, maxZ - minZ + cell, 48, 16);
    geo.rotateX(-Math.PI / 2);
    this.surface = new THREE.Mesh(geo, mat);
    this.surface.position.set((minX + maxX) / 2, WATER_Y, (minZ + maxZ) / 2);
    this.surface.receiveShadow = true;
    this.surface.renderOrder = 1;
    this.scene.add(this.surface);
  }

  // ---------------------------------------------------------------- waterfalls
  /**
   * A tall curved sheet from `top` (cliff lip) to `bottom` (pool / ground), with mist at the base and spray at the lip.
   * @param {{top: THREE.Vector3, bottom: THREE.Vector3, width: number, mist?: boolean}} o
   */
  addWaterfall({ top, bottom, width, mist = true }) {
    const env = this.env;
    const drop = Math.max(2, top.y - bottom.y);
    const dir = new THREE.Vector3(bottom.x - top.x, 0, bottom.z - top.z);
    const reach = dir.length();
    if (reach < 0.01) dir.set(0, 0, 1); else dir.divideScalar(reach);
    const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
    const seed = this.falls.length * 1.37 + 0.5;

    const layer = (wScale, push, alpha, seedOff, nu, nv) => {
      const pos = [], uv = [], tau = [], idx = [];
      for (let j = 0; j <= nv; j++) {
        const v = j / nv;
        const f = 0.72 * Math.sqrt(v) + 0.28 * v;                       // ballistic: leaves the lip horizontally
        const w = width * wScale * (1 + 0.5 * Math.pow(v, 1.3));         // spreads as it falls
        const c = new THREE.Vector3().copy(top).addScaledVector(dir, reach * f + push).setY(top.y - drop * v);
        for (let i = 0; i <= nu; i++) {
          const u = i / nu, s = u * 2 - 1;
          const bulge = (1 - s * s) * w * 0.07;                           // convex towards the outside
          const p = c.clone().addScaledVector(side, s * w * 0.5).addScaledVector(dir, bulge);
          pos.push(p.x, p.y, p.z);
          uv.push(u, v);
          tau.push(Math.sqrt(2 * drop * v / 9.81));                        // seconds since the lip: streaks stretch
          if (i < nu && j < nv) { const k = j * (nu + 1) + i; idx.push(k, k + nu + 1, k + 1, k + 1, k + nu + 1, k + nu + 2); }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('aTau', new THREE.Float32BufferAttribute(tau, 1));
      g.setIndex(idx);
      g.computeVertexNormals();
      const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uSeed: { value: seed + seedOff }, uWidth: { value: width * wScale }, uAlpha: { value: alpha }, uDrop: { value: drop },
        uOut: { value: dir.clone() },
      }]);
      Object.assign(uniforms, this.shared, { uSunDir: { value: env.sunDir }, uSunCol: { value: env.sunColor }, uSkyCol: { value: env.skyColor } });
      const m = new THREE.ShaderMaterial({
        uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
        vertexShader: /* glsl */ `
          attribute float aTau;
          varying vec2 vUv; varying float vTau; varying vec3 vW; varying vec3 vN;
          #include <fog_pars_vertex>
          void main() {
            vUv = uv; vTau = aTau;
            vec4 w = modelMatrix * vec4(position, 1.0);
            vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
            vec4 mvPosition = viewMatrix * w;
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime; uniform float uSeed; uniform float uWidth; uniform float uAlpha; uniform float uDrop;
          uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uSkyCol; uniform vec3 uOut;
          varying vec2 vUv; varying float vTau; varying vec3 vW; varying vec3 vN;
          #include <fog_pars_fragment>
          ${GLSL_NOISE}
          void main() {
            float x = vUv.x * uWidth;
            float y = vTau * 3.2 - uTime * 3.2;                       // pattern moves with the falling water
            // streak columns: very stretched noise; fine detail fades with screen-space frequency
            float aa = 1.0 - smoothstep(0.3, 1.2, fwidth(x * 6.0));
            float streak = wFbm(vec2(x * 1.6 + uSeed * 13.0, y * 0.55 + uSeed));
            float fine = wNoise(vec2(x * 6.0 + uSeed * 7.0, y * 2.2));
            float body = mix(streak, streak * 0.65 + fine * 0.35, aa);
            float clumps = wNoise(vec2(x * 0.7 + uSeed, y * 0.35));       // big travelling surges
            body = body * 0.8 + clumps * 0.3;
            // edges: ragged, fraying more lower down; the sheet thins near the bottom into the mist
            float e = min(vUv.x, 1.0 - vUv.x) * 2.0;
            float jag = wNoise(vec2(y * 1.5 + (vUv.x > 0.5 ? 17.0 : 3.0), uSeed));
            float edge = smoothstep(0.0, 0.18 + 0.5 * vUv.y * jag, e);
            float bottom = 1.0 - smoothstep(0.7, 0.98, vUv.y + (jag - 0.5) * 0.12);
            float lip = 1.0 - smoothstep(0.0, 0.3, vTau);              // glassy water right at the lip
            float a = (0.25 + 0.75 * smoothstep(0.38, 0.66, body)) * edge * bottom;
            a = mix(a, 0.92 * edge, lip);
            a *= uAlpha;
            if (a < 0.004) discard;
            // shading: wrap diffuse on the sheet + translucency when backlit
            vec3 V = normalize(cameraPosition - vW);
            vec3 N = normalize(vN); if (dot(N, V) < 0.0) N = -N;
            float diff = dot(N, uSunDir) * 0.5 + 0.5;
            float thin = 1.0 - smoothstep(0.3, 0.8, body);
            float trans = pow(max(dot(-V, uSunDir), 0.0), 3.0) * (0.35 + 0.65 * thin);
            vec3 white = mix(vec3(0.74, 0.79, 0.9), vec3(1.0, 0.96, 0.9), diff) * (0.75 + 0.25 * uSunCol);
            vec3 shade = vec3(0.5, 0.58, 0.7);
            vec3 col = mix(shade, white, smoothstep(0.35, 0.7, body));
            col = mix(col, vec3(0.42, 0.62, 0.66) * (0.7 + 0.3 * diff), lip * 0.5);  // teal glassy lip
            col += uSunCol * trans * 0.35;
            gl_FragColor = vec4(col, a);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
            #include <fog_fragment>
          }`,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.renderOrder = 4;
      this.scene.add(mesh);
      return mesh;
    };
    const nv = Math.max(24, Math.round(drop / 1.2));
    const main = layer(1.0, 0, 0.95, 0, 14, nv);
    const veil = layer(1.18, 0.6, 0.45, 3.1, 14, nv);

    // pool churn (water shader) and mist
    const impact = new THREE.Vector3().copy(top).addScaledVector(dir, reach + 0.3).setY(bottom.y);
    impact.y = Math.max(bottom.y, heightAt(impact.x, impact.z));          // mist sits on the ground if the fall ends above it
    if (this.falls.length < 6) {
      this.uniforms.uFalls.value[this.falls.length].set(impact.x, impact.z, width * 1.3, 1);
      this.uniforms.uFallCount.value = this.falls.length + 1;
    }
    if (mist) {
      const m = this.mist;
      m.add(impact, width * 1.4, { count: 28, size: 0.53, rate: 0.07, opacity: 0.6, rise: 0.9, spread: 0.8 });
      m.add(impact, width * 2.4, { count: 10, size: 0.45, rate: 0.045, opacity: 0.4, rise: 0.35, spread: 0.9 });          // low spreading skirt          // churning base
      m.add(impact.clone().addScaledVector(dir, width * 0.8), width * 2.4, { count: 12, size: 0.45, rate: 0.03, opacity: 0.26, rise: 1.4, spread: 0.8, lift: 0.5 });  // drifting cloud
      const midY = impact.y + drop * 0.18;
      const mid = new THREE.Vector3().copy(top).addScaledVector(dir, reach * 0.97).setY(midY);
      m.add(mid, width * 0.9, { count: 8, size: 0.5, rate: 0.09, opacity: 0.3, rise: 0.8, floor: impact.y });          // spray around the lower sheet
      const lipP = new THREE.Vector3().copy(top).addScaledVector(dir, 0.8).setY(top.y - 0.6);
      m.add(lipP, width * 0.45, { count: 5, size: 0.45, rate: 0.12, opacity: 0.2, rise: 0.5, floor: top.y - 3 });       // lip spray
    }
    const fall = { top: top.clone(), bottom: bottom.clone(), width, meshes: [main, veil], impact };
    this.falls.push(fall);
    return fall;
  }

  /** a cluster of billowing mist puffs anywhere (radius in metres; opts see Mist.add) */
  addMist(pos, radius, opts = {}) { this.mist.add(pos, radius, opts); }

  update(t, camPos) {
    this.shared.uTime.value = t;
  }
}
