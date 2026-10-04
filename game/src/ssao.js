import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Half-resolution depth-only ambient occlusion (SAO / Alchemy estimator), from the composer's scene depth texture: no
 * extra scene render (the grass cards are only in the depth buffer they already wrote).
 *
 *   1. AO at half resolution: view position from depth, normal from the depth neighbours (the smaller difference on each
 *      axis, so silhouettes don't smear), 12 taps on a per-pixel rotated spiral within a world radius (~1.3 m),
 *      falloff with distance (the haze takes over far away). Writes (ao, view depth).
 *   2. Depth-aware separable blur at half resolution (2 x 9 taps).
 *   3. Composite at full resolution: joint-bilateral upsample (4 half-res taps weighted by depth similarity to the
 *      full-res depth), multiplies the HDR scene colour. Sky (far-plane depth) untouched; weak on the characters
 *      (character mask) so they stay readable.
 *
 * Cost at 1080p (960 x 540 AO): ~17 depth reads per AO texel + 18 blur taps + 6 reads per full-res pixel: ~0.35-0.45 ms
 * on a mid-range GPU. Reads readBuffer (colour + depthTexture), writes writeBuffer (needsSwap = true).
 */
export class SAOPass extends Pass {
  constructor(camera, charTexture) {
    super();
    this.camera = camera;
    this.needsSwap = true;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, format: THREE.RGFormat };
    this.rtA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, opts);
    this.params = { radius: 1.0, intensity: 0.6, bias: 0.002, fadeStart: 35, fadeEnd: 90, charKeep: 0.75, strength: 0.65 };
    const vert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    const depthFns = /* glsl */ `
      uniform sampler2D tDepth; uniform vec4 uProj; uniform vec2 uNearFar;
      float viewZ(vec2 uv) {
        float d = texture2D(tDepth, uv).r;
        return (uNearFar.x * uNearFar.y) / ((uNearFar.y - uNearFar.x) * d - uNearFar.y);   // negative in front
      }
      vec3 viewPos(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0 + uProj.zw) * (-z) / uProj.xy, z); }`;
    this.uniforms = {
      tDepth: { value: null }, uProj: { value: new THREE.Vector4() }, uNearFar: { value: new THREE.Vector2() },
      uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 }, uIntensity: { value: 1 }, uBias: { value: 0.01 },
      uFade: { value: new THREE.Vector2(45, 110) }, uPxScale: { value: 1 },
    };
    this.aoMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: vert, depthTest: false, depthWrite: false,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform vec2 uTexel; uniform float uRadius, uIntensity, uBias, uPxScale; uniform vec2 uFade;
        ${depthFns}
        void main() {
          float z = viewZ(vUv);
          if (z < -uFade.y || texture2D(tDepth, vUv).r >= 0.99999) { gl_FragColor = vec4(1.0, z, 0.0, 1.0); return; }
          vec3 P = viewPos(vUv, z);
          // normal from the depth neighbours: the smaller difference per axis (no smearing across silhouettes)
          vec2 ox = vec2(uTexel.x, 0.0), oy = vec2(0.0, uTexel.y);
          vec3 Pr = viewPos(vUv + ox, viewZ(vUv + ox)), Pl = viewPos(vUv - ox, viewZ(vUv - ox));
          vec3 Pu = viewPos(vUv + oy, viewZ(vUv + oy)), Pd = viewPos(vUv - oy, viewZ(vUv - oy));
          vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
          vec3 dy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
          vec3 N = normalize(cross(dx, dy));
          // spiral of 12 taps, rotated per pixel (interleaved gradient noise; the blur removes the pattern)
          float rPx = min(uRadius * uPxScale / -z, 90.0);          // screen radius in half-res pixels
          float rot = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
          float r2 = uRadius * uRadius, sum = 0.0;
          for (int i = 0; i < 12; i++) {
            float a = (float(i) + 0.5) / 12.0;
            float ang = a * 6.2831853 * 3.0 + rot;
            vec2 suv = vUv + vec2(cos(ang), sin(ang)) * (a * rPx + 1.0) * uTexel;
            vec3 Q = viewPos(suv, viewZ(suv));
            vec3 v = Q - P;
            float vv = dot(v, v), vn = dot(v, N);
            float f = max(r2 - vv, 0.0);
            sum += f * f * f * max((vn - 0.01 - uBias * -z) / (vv + 0.01), 0.0);
          }
          float ao = max(0.0, 1.0 - sum * uIntensity / (r2 * r2 * r2) * (5.0 / 12.0));
          ao = mix(ao, 1.0, smoothstep(uFade.x, uFade.y, -z));
          gl_FragColor = vec4(ao, z, 0.0, 1.0);
        }`,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: null }, uDir: { value: new THREE.Vector2() } }, vertexShader: vert, depthTest: false, depthWrite: false,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tMap; uniform vec2 uDir;
        void main() {
          vec2 c = texture2D(tMap, vUv).rg;
          float s = c.r * 0.2, ws = 0.2;
          for (int i = 1; i <= 4; i++) {
            float g = exp(-float(i * i) * 0.18);
            vec2 a = texture2D(tMap, vUv + uDir * float(i)).rg, b = texture2D(tMap, vUv - uDir * float(i)).rg;
            float wa = g * exp(-abs(a.g - c.g) / (abs(c.g) * 0.02 + 0.05) * 1.5), wb = g * exp(-abs(b.g - c.g) / (abs(c.g) * 0.02 + 0.05) * 1.5);
            s += a.r * wa + b.r * wb; ws += wa + wb;
          }
          gl_FragColor = vec4(s / ws, c.g, 0.0, 1.0);
        }`,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tAO: { value: this.rtA.texture }, tChar: { value: charTexture }, uAOTexel: { value: new THREE.Vector2() },
        uStrength: { value: 1 }, uCharKeep: { value: 0.75 }, tDepth: this.uniforms.tDepth, uProj: this.uniforms.uProj, uNearFar: this.uniforms.uNearFar,
      },
      vertexShader: vert, depthTest: false, depthWrite: false,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tDiffuse; uniform sampler2D tAO; uniform sampler2D tChar; uniform vec2 uAOTexel;
        uniform float uStrength, uCharKeep;
        ${depthFns}
        void main() {
          vec4 col = texture2D(tDiffuse, vUv);
          float d = texture2D(tDepth, vUv).r;
          if (d >= 0.99999) { gl_FragColor = col; return; }
          float z = (uNearFar.x * uNearFar.y) / ((uNearFar.y - uNearFar.x) * d - uNearFar.y);
          // joint-bilateral upsample: the 4 nearest half-res texels, weighted by bilinear x depth similarity
          vec2 p = vUv / uAOTexel - 0.5, f = fract(p), b = (floor(p) + 0.5) * uAOTexel;
          vec2 s00 = texture2D(tAO, b).rg, s10 = texture2D(tAO, b + vec2(uAOTexel.x, 0.0)).rg;
          vec2 s01 = texture2D(tAO, b + vec2(0.0, uAOTexel.y)).rg, s11 = texture2D(tAO, b + uAOTexel).rg;
          float k = 1.0 / (abs(z) * 0.03 + 0.03);
          vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y) + 1e-4;
          w *= exp(-abs(vec4(s00.g, s10.g, s01.g, s11.g) - z) * k);
          float ao = dot(vec4(s00.r, s10.r, s01.r, s11.r), w) / max(dot(w, vec4(1.0)), 1e-5);
          float ch = clamp(texture2D(tChar, vUv).r * 1.6, 0.0, 1.0);
          ao = mix(1.0, ao, uStrength * (1.0 - uCharKeep * ch));
          gl_FragColor = vec4(col.rgb * ao, col.a);
        }`,
    });
    this.quad = new FullScreenQuad(this.aoMat);
  }

  setSize(w, h) {
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    this.rtA.setSize(hw, hh); this.rtB.setSize(hw, hh);
    this.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this.compMat.uniforms.uAOTexel.value.set(1 / hw, 1 / hh);
    this.halfH = hh;
  }

  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera, P = cam.projectionMatrix.elements, U = this.uniforms, prm = this.params;
    U.tDepth.value = readBuffer.depthTexture;
    U.uProj.value.set(P[0], P[5], P[8], P[9]);
    U.uNearFar.value.set(cam.near, cam.far);
    U.uRadius.value = prm.radius; U.uIntensity.value = prm.intensity; U.uBias.value = prm.bias;
    U.uFade.value.set(prm.fadeStart, prm.fadeEnd);
    U.uPxScale.value = P[5] * 0.5 * (this.halfH ?? 540);            // metres at 1 m depth -> half-res pixels
    this.quad.material = this.aoMat;
    renderer.setRenderTarget(this.rtA); this.quad.render(renderer);
    this.quad.material = this.blurMat;
    this.blurMat.uniforms.tMap.value = this.rtA.texture; this.blurMat.uniforms.uDir.value.set(U.uTexel.value.x, 0);
    renderer.setRenderTarget(this.rtB); this.quad.render(renderer);
    this.blurMat.uniforms.tMap.value = this.rtB.texture; this.blurMat.uniforms.uDir.value.set(0, U.uTexel.value.y);
    renderer.setRenderTarget(this.rtA); this.quad.render(renderer);
    this.quad.material = this.compMat;
    this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.compMat.uniforms.uStrength.value = prm.strength;
    this.compMat.uniforms.uCharKeep.value = prm.charKeep;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() { this.rtA.dispose(); this.rtB.dispose(); this.aoMat.dispose(); this.blurMat.dispose(); this.compMat.dispose(); this.quad.dispose(); }
}
