import * as THREE from 'three';

const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

/* ------------------------------------------------------------------ particles */
export class Particles {
  constructor(scene, max = 4000, { normal = false } = {}) {
    this.max = max;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.data = new Float32Array(max * 6); // life, maxLife, size0, size1, drag, gravity
    this.alpha = new Float32Array(max);
    this.size = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry = g;
    const mat = new THREE.ShaderMaterial({
      ...additive,
      ...(normal ? { blending: THREE.NormalBlending } : {}),
      uniforms: { uScale: { value: 400 } },
      defines: normal ? { NORMAL_BLEND: 1 } : {},
      vertexShader: /* glsl */ `
        attribute float alpha; attribute float size; attribute vec3 color;
        varying float vA; varying vec3 vC; uniform float uScale;
        void main() {
          vA = alpha; vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA; varying vec3 vC;
        void main() {
          vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0;
          if (r > 1.0) discard;
          float core = exp(-r * 3.5);
          #ifdef NORMAL_BLEND
            gl_FragColor = vec4(vC, (1.0 - r) * (1.0 - r) * vA * 0.55);
          #else
            gl_FragColor = vec4(vC * (core * 1.6 + 0.25) * vA, 1.0);
          #endif
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
  }

  emit(p, v, color, { life = 0.6, size = 0.08, sizeEnd = 0, drag = 1.5, gravity = 0 } = {}) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.data.set([life, life, size, sizeEnd, drag, gravity], i * 6);
  }

  burst(center, n, { speed = 3, spread = 1, dir = null, color = new THREE.Color(0.5, 0.9, 1), ...o } = {}) {
    const v = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(spread);
      if (dir) v.add(dir);
      v.normalize().multiplyScalar(speed * (0.35 + Math.random() * 0.65));
      this.emit(center, v, color, { ...o, life: (o.life ?? 0.5) * (0.6 + Math.random() * 0.6) });
    }
  }

  update(dt) {
    let i = 0;
    while (i < this.count) {
      const d = i * 6;
      this.data[d] -= dt;
      if (this.data[d] <= 0) {
        const last = --this.count;
        this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
        this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
        this.col.copyWithin(i * 3, last * 3, last * 3 + 3);
        this.data.copyWithin(d, last * 6, last * 6 + 6);
        continue;
      }
      const t = 1 - this.data[d] / this.data[d + 1];
      const drag = Math.exp(-this.data[d + 4] * dt);
      for (let k = 0; k < 3; k++) {
        this.vel[i * 3 + k] *= drag;
        this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      }
      this.vel[i * 3 + 1] -= this.data[d + 5] * dt;
      this.alpha[i] = Math.min(1, (1 - t) * 1.6) * Math.min(1, t * 12 + 0.2);
      this.size[i] = THREE.MathUtils.lerp(this.data[d + 2], this.data[d + 3], t);
      i++;
    }
    const g = this.geometry;
    g.setDrawRange(0, this.count);
    for (const a of ['position', 'color', 'alpha', 'size']) g.attributes[a].needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ sword trail */
const catmull = (p0, p1, p2, p3, t, out) => {
  const t2 = t * t, t3 = t2 * t;
  return out.set(0, 0, 0)
    .addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t)
    .addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1)
    .addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t)
    .addScaledVector(p3, 0.5 * t3 - 0.5 * t2);
};

export class SwordTrail {
  constructor(scene, { samples = 24, sub = 6, life = 0.16, color = new THREE.Color(0.35, 0.85, 1) } = {}) {
    this.samples = [];
    this.maxSamples = samples;
    this.sub = sub;
    this.life = life;
    this.intensity = 0;
    const verts = (samples - 1) * sub + 1;
    this.verts = verts;
    this.position = new Float32Array(verts * 2 * 3);
    this.uv = new Float32Array(verts * 2 * 2);
    this.alpha = new Float32Array(verts * 2);
    const idx = [];
    for (let i = 0; i < verts - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      ...additive,
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: color }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float alpha; varying float vA; varying vec2 vUv;
        void main() { vA = alpha; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying float vA; varying vec2 vUv; uniform vec3 uColor; uniform float uTime;
        void main() {
          float edge = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
          float tipHot = pow(vUv.y, 3.0);
          float age = vUv.x;
          float streak = 0.75 + 0.25 * sin(vUv.y * 40.0 + uTime * 30.0 - age * 20.0);
          vec3 c = mix(uColor, vec3(0.9, 1.0, 1.0), tipHot * (1.0 - age) * 0.6) * (0.55 + tipHot * 1.3);
          float a = vA * edge * pow(1.0 - age, 2.0) * streak * 0.75;
          gl_FragColor = vec4(c * a, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    scene.add(this.mesh);
  }

  push(base, tip, time, intensity) {
    this.samples.unshift({ base: base.clone(), tip: tip.clone(), time, intensity });
    if (this.samples.length > this.maxSamples) this.samples.pop();
  }

  clear() { this.samples.length = 0; }

  update(time) {
    this.material.uniforms.uTime.value = time;
    const s = this.samples.filter((x) => time - x.time < this.life);
    this.samples = s;
    const n = s.length;
    const g = this.geometry;
    if (n < 2) { g.setDrawRange(0, 0); return; }
    const tmp = new THREE.Vector3();
    let v = 0;
    for (let i = 0; i < n - 1; i++) {
      const p0 = s[Math.max(i - 1, 0)], p1 = s[i], p2 = s[i + 1], p3 = s[Math.min(i + 2, n - 1)];
      const steps = i === n - 2 ? this.sub + 1 : this.sub;
      for (let k = 0; k < steps; k++) {
        const t = k / this.sub;
        const age = THREE.MathUtils.clamp((time - THREE.MathUtils.lerp(p1.time, p2.time, t)) / this.life, 0, 1);
        const inten = THREE.MathUtils.lerp(p1.intensity, p2.intensity, t);
        catmull(p0.base, p1.base, p2.base, p3.base, t, tmp).toArray(this.position, v * 6);
        catmull(p0.tip, p1.tip, p2.tip, p3.tip, t, tmp).toArray(this.position, v * 6 + 3);
        this.uv.set([age, 0, age, 1], v * 4);
        this.alpha[v * 2] = this.alpha[v * 2 + 1] = inten;
        v++;
      }
    }
    g.setDrawRange(0, Math.max(0, (v - 1) * 6));
    g.attributes.position.needsUpdate = g.attributes.uv.needsUpdate = g.attributes.alpha.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ one-shot meshes */
class Transient {
  constructor(mesh, life, onUpdate) { this.mesh = mesh; this.life = life; this.t = 0; this.onUpdate = onUpdate; }
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.ringGeo = new THREE.RingGeometry(0.85, 1, 64);
    this.planeGeo = new THREE.PlaneGeometry(1, 1);
    this.waveGeo = Effects.crescent();
  }

  static crescent() {
    const g = new THREE.BufferGeometry();
    const seg = 40, pos = [], uv = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const a = THREE.MathUtils.lerp(-1.25, 1.25, u);
      const thick = Math.sin(u * Math.PI) * 0.35;
      for (const [r, v] of [[1 - thick, 0], [1, 1]]) {
        pos.push(Math.sin(a) * r, 0, Math.cos(a) * r);
        uv.push(u, v);
      }
      if (i < seg) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  add(mesh, life, onUpdate, parent = this.scene) {
    mesh.renderOrder = 8;
    mesh.frustumCulled = false;
    parent.add(mesh);
    this.items.push(new Transient(mesh, life, onUpdate));
  }

  glowMaterial(color, extra = '') {
    return new THREE.ShaderMaterial({
      ...additive,
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: color.clone() }, uFade: { value: 1 }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `varying vec2 vUv; uniform vec3 uColor; uniform float uFade; uniform float uTime; ${extra}`,
    });
  }

  ring(pos, { color = new THREE.Color(0.4, 0.9, 1), radius = 2, life = 0.5, flat = true, normal = null, intensity = 1 } = {}) {
    const m = new THREE.Mesh(this.ringGeo, this.glowMaterial(color.clone().multiplyScalar(intensity), `void main(){
      gl_FragColor = vec4(uColor * uFade, 1.0); }`));
    m.position.copy(pos);
    if (flat) m.rotation.x = -Math.PI / 2;
    if (normal) m.lookAt(pos.clone().add(normal));
    this.add(m, life, (t) => {
      const k = 1 - Math.pow(1 - t, 3);
      m.scale.setScalar(0.05 + radius * k);
      m.material.uniforms.uFade.value = Math.pow(1 - t, 1.5) * 1.5;
    });
  }

  flash(pos, camera, { color = new THREE.Color(0.7, 0.95, 1), size = 1.2, life = 0.18, intensity = 0.6 } = {}) {
    const m = new THREE.Mesh(this.planeGeo, this.glowMaterial(color.clone().multiplyScalar(intensity), `void main(){
      vec2 d = vUv - 0.5; float r = length(d) * 2.0;
      float star = max(0.0, 1.0 - abs(d.x) * 14.0) * max(0.0, 1.0 - abs(d.y) * 1.6) + max(0.0, 1.0 - abs(d.y) * 14.0) * max(0.0, 1.0 - abs(d.x) * 1.6);
      float a = (exp(-r * r * 6.0) + star * 0.8) * uFade;
      gl_FragColor = vec4((uColor + vec3(0.25) * length(uColor)) * a * 2.0, 1.0); }`));
    m.position.copy(pos);
    m.rotation.z = Math.random() * Math.PI;
    this.add(m, life, (t) => {
      m.quaternion.copy(camera.quaternion);
      m.rotateZ(t * 0.6);
      m.scale.setScalar(size * (0.6 + t * 0.8));
      m.material.uniforms.uFade.value = 1 - t;
    });
  }

  /** Crescent energy wave flying along `dir` (unit, horizontal), tilted by `roll`. */
  slashWave(pos, dir, { color = new THREE.Color(0.35, 0.85, 1), speed = 14, life = 0.45, size = 1.6, roll = 0 } = {}) {
    const m = new THREE.Mesh(this.waveGeo, this.glowMaterial(color, `void main(){
      float edge = smoothstep(0.0, 0.6, vUv.y);
      float ends = sin(vUv.x * 3.14159);
      float hot = pow(vUv.y, 6.0);
      vec3 c = mix(uColor, vec3(0.9, 1.0, 1.0), hot * 0.7) * (0.6 + hot * 1.6);
      float streak = 0.7 + 0.3 * sin(vUv.x * 60.0 - uTime * 40.0);
      gl_FragColor = vec4(c * edge * ends * uFade * streak, 1.0); }`));
    m.position.copy(pos);
    m.lookAt(pos.clone().add(dir));
    m.rotateZ(roll);
    const start = pos.clone();
    this.add(m, life, (t, dt) => {
      m.position.copy(start).addScaledVector(dir, speed * life * (1 - Math.pow(1 - t, 2)));
      m.scale.setScalar(size * (0.6 + t * 0.9));
      m.material.uniforms.uFade.value = Math.pow(1 - t, 1.3) * 1.2;
      m.material.uniforms.uTime.value += dt;
    });
  }

  /**
   * Blood slash where a blow landed: a small dark-red crescent cut lying ON the body surface at `pos` (surface normal
   * `normal`), its arc along the swing direction projected onto the skin. With `parent` (a bone) it is attached to
   * the body and moves with it; it fades out over `life`.
   */
  bloodSlash(pos, swing, normal, { size = 0.45, life = 1.2, parent = null } = {}) {
    const N = normal.clone().normalize();
    const X = swing.clone().addScaledVector(N, -swing.dot(N));
    if (X.lengthSq() < 1e-6) X.set(1, 0, 0).addScaledVector(N, -N.x);
    X.normalize();
    const Z = new THREE.Vector3().crossVectors(X, N).normalize();
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4,
      uniforms: { uFade: { value: 1 }, uSeed: { value: Math.random() * 10 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `varying vec2 vUv; uniform float uFade; uniform float uSeed;
        float h(float x){ return fract(sin(x * 91.7 + uSeed) * 43758.5); }
        void main(){
          float ends = pow(sin(vUv.x * 3.14159), 0.8);
          float ragged = 0.6 + 0.4 * h(floor(vUv.x * 30.0));
          float body = smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.7 * ragged, vUv.y);
          float a = body * ends * uFade;
          if (a < 0.03) discard;
          vec3 c = mix(vec3(0.25, 0.0, 0.02), vec3(0.7, 0.02, 0.05), smoothstep(0.2, 0.8, vUv.y));
          gl_FragColor = vec4(c, a);
        }`,
    });
    const m = new THREE.Mesh(this.waveGeo, mat);
    m.matrixAutoUpdate = false;
    // crescent geometry: arc of radius 1 around +Y, middle at +Z -> scale, and shift so the arc middle sits on `pos`
    const world = new THREE.Matrix4().makeBasis(X, N, Z).scale(new THREE.Vector3(size, size, size));
    world.setPosition(pos.clone().addScaledVector(Z, -size).addScaledVector(N, 0.015));
    const place = (t) => {
      if (parent) m.matrix.copy(parent.matrixWorld).invert().multiply(world);
      else m.matrix.copy(world);
      m.material.uniforms.uFade.value = t < 0.4 ? 1.0 : Math.pow(1 - (t - 0.4) / 0.6, 1.5);
    };
    parent?.updateWorldMatrix(true, false);
    place(0);                                         // the local matrix is fixed from now on (parented: moves with the bone)
    this.add(m, life, (t) => { m.material.uniforms.uFade.value = t < 0.4 ? 1.0 : Math.pow(1 - (t - 0.4) / 0.6, 1.5); }, parent ?? this.scene);
    m.renderOrder = 9;
  }

  update(dt) {
    this.items = this.items.filter((it) => {
      it.t += dt;
      const t = Math.min(1, it.t / it.life);
      it.onUpdate?.(t, dt);
      if (t >= 1) {
        // no material.dispose(): that frees the GPU program, so the next attack would recompile it (seconds on
        // some drivers = a freeze); the JS material is garbage-collected, the program stays cached for the next one
        it.mesh.removeFromParent();
        return false;
      }
      return true;
    });
  }
}
