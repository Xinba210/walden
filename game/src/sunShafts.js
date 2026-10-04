import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Screen-space sun shafts ("god rays") at quarter resolution.
 *
 *   1. prefilter: sky pixels (scene depth at the far plane) near the sun, weighted by their brightness -> quarter-res mask
 *      (geometry occludes because it is not sky: trees, ruins and cliffs cut dark wedges into the shafts)
 *   2. two radial blur passes towards the sun's screen position (16 taps each, second pass at 1/4 the step: ~256 effective)
 *
 * The result (this.texture, linear, ~0..1) is composited by the grade pass, so no extra full-resolution pass is spent.
 * Needs the composer's read buffer to carry a DepthTexture. Does not touch the colour chain (needsSwap = false).
 * `this.strength` is the 0..1 visibility factor of the sun (0 when it is behind the camera / far off screen): the
 * passes are skipped entirely then.
 */
export class SunShaftsPass extends Pass {
  constructor(camera, sunDir) {
    super();
    this.camera = camera;
    this.sunDir = sunDir;
    this.needsSwap = false;
    this.strength = 0;
    this.maxStrength = 0.55;                // overall shaft intensity (the world's grade can set it)
    this.uStrength = { value: 0 };          // shared with the grade pass (strength x maxStrength)
    this.force = false;                     // render even when the sun is out of view (shader warm-up)
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, opts);
    this.texture = this.rtA.texture;
    this.sunUv = new THREE.Vector2(0.5, 0.5);
    this.aspect = 1;

    const vert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    this.prefilter = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, tDepth: { value: null }, uSun: { value: this.sunUv }, uAspect: { value: 1 }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: vert,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 uSun; uniform float uAspect; uniform vec2 uTexel;
        void main() {
          // 4 taps over the quarter-res texel: sky coverage (far-plane depth) x sky brightness
          vec3 acc = vec3(0.0);
          for (int i = 0; i < 4; i++) {
            vec2 o = (vec2(float(i & 1), float(i >> 1)) - 0.5) * uTexel;
            float sky = step(0.99999, texture2D(tDepth, vUv + o).r);
            vec3 c = texture2D(tColor, vUv + o).rgb;
            float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
            acc += sky * c * smoothstep(0.55, 1.6, l);
          }
          vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
          float fall = exp(-dot(d, d) * 7.0);                  // only the sky around the sun emits shafts
          gl_FragColor = vec4(min(acc * 0.25 * fall, vec3(2.0)), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: null }, uSun: { value: this.sunUv }, uStep: { value: 1 } },
      vertexShader: vert,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform sampler2D tMap; uniform vec2 uSun; uniform float uStep;
        void main() {
          vec2 dir = (uSun - vUv) * uStep / 16.0;
          vec2 p = vUv;
          vec3 s = vec3(0.0);
          float w = 1.0, ws = 0.0;
          for (int i = 0; i < 16; i++) { s += texture2D(tMap, p).rgb * w; ws += w; w *= 0.94; p += dir; }
          gl_FragColor = vec4(s / ws, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.prefilter);
  }

  setSize(w, h) {
    const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));
    this.rtA.setSize(qw, qh);
    this.rtB.setSize(qw, qh);
    this.prefilter.uniforms.uTexel.value.set(0.5 / qw, 0.5 / qh);
    this.aspect = w / h;
  }

  /** sun visibility + screen position for this frame (call before composer.render) */
  update() {
    const cam = this.camera;
    if (!this.sunDir) return (this.strength = 0);
    const fwd = cam.getWorldDirection(_v);
    const facing = fwd.dot(this.sunDir);
    _p.copy(cam.position).addScaledVector(this.sunDir, 1000).project(cam);
    this.sunUv.set(_p.x * 0.5 + 0.5, _p.y * 0.5 + 0.5);
    const off = Math.max(Math.abs(_p.x), Math.abs(_p.y));
    this.strength = facing <= 0 ? 0 : THREE.MathUtils.smoothstep(facing, 0.25, 0.65) * (1 - THREE.MathUtils.smoothstep(off, 1.1, 1.9));
    return this.strength;
  }

  render(renderer, writeBuffer, readBuffer) {
    this.update();
    this.uStrength.value = this.strength * this.maxStrength;
    if ((this.strength <= 0.001 && !this.force) || !readBuffer.depthTexture) { this.uStrength.value = 0; return; }
    this.prefilter.uniforms.tColor.value = readBuffer.texture;
    this.prefilter.uniforms.tDepth.value = readBuffer.depthTexture;
    this.prefilter.uniforms.uAspect.value = this.aspect;
    this.quad.material = this.prefilter;
    renderer.setRenderTarget(this.rtA); this.quad.render(renderer);
    this.quad.material = this.blur;
    this.blur.uniforms.tMap.value = this.rtA.texture; this.blur.uniforms.uStep.value = 0.85;
    renderer.setRenderTarget(this.rtB); this.quad.render(renderer);
    this.blur.uniforms.tMap.value = this.rtB.texture; this.blur.uniforms.uStep.value = 0.85 / 4;
    renderer.setRenderTarget(this.rtA); this.quad.render(renderer);
    renderer.setRenderTarget(null);
  }

  dispose() { this.rtA.dispose(); this.rtB.dispose(); this.prefilter.dispose(); this.blur.dispose(); this.quad.dispose(); }
}
const _v = new THREE.Vector3(), _p = new THREE.Vector3();
