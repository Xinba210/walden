import * as THREE from 'three';

/**
 * Katana materialisation. Every katana vertex gets a 0..1 coordinate along the sword (hilt end -> tip);
 * fragments beyond uProgress are discarded and a hot, noisy energy band rides the reveal edge.
 * A slightly inflated additive shell on the blade gives the steady glow (amplified by bloom).
 */
const EDGE = new THREE.Color(0.45, 0.95, 1.0);

export class Katana {
  constructor(katanaRoot, handBoneName) {
    this.meshes = [];
    katanaRoot.traverse((o) => { if (o.isSkinnedMesh) this.meshes.push(o); });
    const skel = this.meshes[0].skeleton;
    this.handIndex = skel.bones.findIndex((b) => b.name === handBoneName);
    this.hand = skel.bones[this.handIndex];
    this.skinned = this.meshes[0];
    this.uniforms = {
      uProgress: { value: 0 },
      uGlow: { value: 0 },
      uTime: { value: 0 },
      uEdge: { value: EDGE.clone() },
      uFlash: { value: 0 },
    };
    this.progress = 0;
    this.target = 0;
    this.speed = 1;
    this.glow = 0;
    this.flash = 0;

    // sword axis from all katana vertices (bind space)
    const pts = [];
    for (const m of this.meshes) {
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(p, i));
    }
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    const axis = principalAxis(pts, c);
    const handleMesh = this.meshes.find((m) => /Handle/.test(m.material.name)) ?? this.meshes[0];
    const hc = new THREE.Box3().setFromBufferAttribute(handleMesh.geometry.attributes.position).getCenter(new THREE.Vector3());
    if (hc.clone().sub(c).dot(axis) > 0) axis.negate();
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { const d = p.clone().sub(c).dot(axis); lo = Math.min(lo, d); hi = Math.max(hi, d); }
    this.hiltLocal = c.clone().addScaledVector(axis, lo);
    this.tipLocal = c.clone().addScaledVector(axis, hi);
    this.bladeBaseLocal = c.clone().addScaledVector(axis, lo + (hi - lo) * 0.3);
    this.length = hi - lo;

    for (const m of this.meshes) {
      const p = m.geometry.attributes.position;
      const u = new Float32Array(p.count);
      for (let i = 0; i < p.count; i++) u[i] = (new THREE.Vector3().fromBufferAttribute(p, i).sub(c).dot(axis) - lo) / (hi - lo);
      m.geometry.setAttribute('aSword', new THREE.BufferAttribute(u, 1));
      m.material = m.material.clone();
      const isBlade = /Blade/.test(m.material.name);
      if (isBlade) {
        m.material.emissive = new THREE.Color(0.3, 0.85, 1);
        m.material.emissiveMap = m.material.map;
        m.material.emissiveIntensity = 1;
      }
      this.patch(m.material, isBlade);
      m.castShadow = true;
      if (isBlade) this.addShell(m);
    }
  }

  patch(material, isBlade) {
    const U = this.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aSword; varying float vSword; varying vec3 vLocalPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSword = aSword; vLocalPos = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vSword; varying vec3 vLocalPos;
          uniform float uProgress; uniform float uGlow; uniform float uTime; uniform vec3 uEdge; uniform float uFlash;
          float h3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
          float n3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x),mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),
                       mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x),mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y),f.z); }`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          float swordNoise = n3(vLocalPos * 260.0 + uTime * 2.0) * 0.06;
          float swordCut = uProgress * 1.08 - vSword - swordNoise;
          if (swordCut < 0.0) discard;
          float swordBand = 1.0 - smoothstep(0.0, 0.07, swordCut);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance *= ${isBlade ? '(0.6 + uGlow * 3.5)' : '1.0'};
          totalEmissiveRadiance += uEdge * swordBand * 9.0 * step(uProgress, 0.999);
          totalEmissiveRadiance += uEdge * uFlash * ${isBlade ? '4.0' : '0.6'};`);
    };
    material.customProgramCacheKey = () => `katana-${isBlade}`;
  }

  addShell(blade) {
    const U = this.uniforms;
    const mat = new THREE.MeshBasicMaterial({ color: EDGE, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aSword; varying float vSword;')
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position) + normal * 0.0035; vSword = aSword;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vSword; uniform float uProgress; uniform float uGlow; uniform float uTime; uniform float uFlash;')
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
          if (vSword > uProgress * 1.02) discard;
          float pulse = 0.8 + 0.2 * sin(uTime * 6.0 + vSword * 12.0);
          vec4 diffuseColor = vec4(diffuse * (uGlow * 0.55 * pulse + uFlash * 1.5) * smoothstep(0.2, 0.35, vSword), 1.0);`);
    };
    mat.customProgramCacheKey = () => 'katana-shell';
    const shell = new THREE.SkinnedMesh(blade.geometry, mat);
    shell.bind(blade.skeleton, blade.bindMatrix);
    shell.bindMode = blade.bindMode;
    shell.frustumCulled = false;
    shell.renderOrder = 5;
    blade.parent.add(shell);
    shell.position.copy(blade.position);
    shell.quaternion.copy(blade.quaternion);
    shell.scale.copy(blade.scale);
    this.shell = shell;
    this.meshes.push(shell);
  }

  /** World-space point of a bind-space katana position (rigid on the hand bone). */
  world(local, out = new THREE.Vector3()) {
    const s = this.skinned;
    const m = new THREE.Matrix4().multiplyMatrices(this.hand.matrixWorld, s.skeleton.boneInverses[this.handIndex]).multiply(s.bindMatrix);
    return out.copy(local).applyMatrix4(m);
  }

  tip(out) { return this.world(this.tipLocal, out); }
  hilt(out) { return this.world(this.hiltLocal, out); }
  base(out) { return this.world(this.bladeBaseLocal, out); }
  /** world point at fraction u (0 hilt .. 1 tip) */
  at(u, out = new THREE.Vector3()) { return this.world(this.hiltLocal.clone().lerp(this.tipLocal, u), out); }

  summon(duration = 0.5) { this.target = 1; this.speed = 1 / duration; }
  dismiss(duration = 0.4) { this.target = 0; this.speed = 1 / duration; }
  get visible() { return this.progress > 0.001; }
  get full() { return this.progress >= 0.999; }

  update(dt, time) {
    const was = this.progress;
    const d = this.target - this.progress;
    this.progress += Math.sign(d) * Math.min(Math.abs(d), this.speed * dt);
    const glowTarget = this.progress >= 0.999 ? 1 : this.progress * 0.6;
    this.glow += (glowTarget - this.glow) * (1 - Math.exp(-4 * dt));
    this.flash = Math.max(0, this.flash - dt * 2.2);
    this.uniforms.uProgress.value = this.progress;
    this.uniforms.uGlow.value = this.glow;
    this.uniforms.uTime.value = time;
    this.uniforms.uFlash.value = this.flash;
    for (const m of this.meshes) m.visible = this.progress > 0.001;
    return { completed: was < 0.999 && this.progress >= 0.999, gone: was > 0.001 && this.progress <= 0.001 };
  }
}

function principalAxis(pts, c) {
  let v = new THREE.Vector3(1, 0.3, 0.2).normalize();
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z;
    cov[0] += x * x; cov[1] += x * y; cov[2] += x * z; cov[4] += y * y; cov[5] += y * z; cov[8] += z * z;
  }
  cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];
  for (let i = 0; i < 50; i++) {
    v = new THREE.Vector3(cov[0] * v.x + cov[1] * v.y + cov[2] * v.z, cov[3] * v.x + cov[4] * v.y + cov[5] * v.z, cov[6] * v.x + cov[7] * v.y + cov[8] * v.z).normalize();
  }
  return v;
}
