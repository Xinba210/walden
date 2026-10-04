import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';

/**
 * Character mask for the colour grade: renders only the characters (player, katana, monster; camera layer
 * CHAR_LAYER) as flat white into a half-resolution target with the scene's depth respected per object, then blurs it a
 * little. The grade pass reads it to keep the characters crisp and lifted while the world is graded softer.
 * Does not touch the colour chain (needsSwap = false).
 */
export const CHAR_LAYER = 3;

export class CharacterMaskPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.blurRT = this.rt.clone();
    this.white = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `varying vec2 vUv; uniform sampler2D tMap; uniform vec2 uDir;
        void main(){ float s = 0.0; float w[5]; w[0]=0.227; w[1]=0.195; w[2]=0.122; w[3]=0.054; w[4]=0.016;
          s += texture2D(tMap, vUv).r * w[0];
          for (int i = 1; i < 5; i++) { s += texture2D(tMap, vUv + uDir * float(i)).r * w[i]; s += texture2D(tMap, vUv - uDir * float(i)).r * w[i]; }
          gl_FragColor = vec4(s, s, s, 1.0); }`,
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blur);
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.texture = this.rt.texture;
  }

  setSize(w, h) {
    this.rt.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.blurRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.texel = new THREE.Vector2(1 / Math.max(1, w >> 1), 1 / Math.max(1, h >> 1));
  }

  render(renderer) {
    const cam = this.camera, scene = this.scene;
    const layers = cam.layers.mask, bg = scene.background, ov = scene.overrideMaterial, fog = scene.fog;
    const clear = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    cam.layers.set(CHAR_LAYER);
    scene.background = null; scene.overrideMaterial = this.white; scene.fog = null;
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, cam);
    cam.layers.mask = layers;
    scene.background = bg; scene.overrideMaterial = ov; scene.fog = fog;
    renderer.setClearColor(clear, ca);
    // separable blur (soft edge for the grade transition)
    this.blur.uniforms.tMap.value = this.rt.texture;
    this.blur.uniforms.uDir.value.set(this.texel?.x ?? 0.001, 0);
    renderer.setRenderTarget(this.blurRT); renderer.render(this.quadScene, this.quadCam);
    this.blur.uniforms.tMap.value = this.blurRT.texture;
    this.blur.uniforms.uDir.value.set(0, this.texel?.y ?? 0.001);
    renderer.setRenderTarget(this.rt); renderer.render(this.quadScene, this.quadCam);
    renderer.setRenderTarget(null);
  }
}

/** put an object (and its meshes) on the character layer as well as the default one */
export function markCharacter(root) {
  root.traverse((o) => o.layers.enable(CHAR_LAYER));
}
