import * as THREE from 'three';

/**
 * Cloth-vs-leg collision on the GPU: loose cloth wraps over the legs instead of cutting through them.
 *
 * Each leg bone (thigh, shin) gets a signed distance field of the real trouser / boot surface, computed once at load in
 * the bone's own rest frame (3D texture, ~1.5 cm voxels). After skinning, every cloth vertex is mapped into each leg
 * bone's current frame, samples the distance, and if it is closer than the clearance it is moved out along the field
 * gradient (a few fixed-point iterations), so it slides over the actual trouser surface - bulges, folds and all.
 *
 * - Rest inset: a cloth vertex that already hangs closer than the clearance in the rest pose keeps that smaller
 *   clearance, so nothing bulges in the rest pose; it only stops getting any closer.
 * - Side memory: each cloth vertex remembers which side of each leg it hangs on (direction in the bone frame). When a
 *   knee is driven up through a front panel the nearest-surface direction would point out of the back of the thigh;
 *   vertices that are inside and whose escape direction points away from their rest side are pushed out on the rest
 *   side instead, so the panel ends up draped over the knee.
 */
const CLEAR = 0.025;          // cloth stays this far outside the trousers (also covers flat triangle spans)
const VOXEL = 0.015;
const PAD = 0.07;
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _v = new THREE.Vector3();

const san = (n) => n.replace(/[:.]/g, '');
const _pw = new THREE.Vector3(), _pt = new THREE.Vector3(), _pg = new THREE.Vector3();

/** trilinear sample of a distance grid at texel-centre texture coordinates (matches the GPU's linear filter) */
function sampleField(G, u, v, w) {
  const n = G.n, F = G.field;
  const x = Math.min(Math.max(u * n[0] - 0.5, 0), n[0] - 1.001), y = Math.min(Math.max(v * n[1] - 0.5, 0), n[1] - 1.001), z = Math.min(Math.max(w * n[2] - 0.5, 0), n[2] - 1.001);
  const x0 = x | 0, y0 = y | 0, z0 = z | 0, fx = x - x0, fy = y - y0, fz = z - z0;
  const i = x0 + n[0] * (y0 + n[1] * z0), sx = 1, sy = n[0], sz = n[0] * n[1];
  const c00 = F[i] * (1 - fx) + F[i + sx] * fx, c10 = F[i + sy] * (1 - fx) + F[i + sy + sx] * fx;
  const c01 = F[i + sz] * (1 - fx) + F[i + sz + sx] * fx, c11 = F[i + sz + sy] * (1 - fx) + F[i + sz + sy + sx] * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}

/** closest point on triangle (a, b, c) to p -> squared distance, writes the point into out */
function closestOnTri(p, a, b, c, out) {
  const ab = _t0.subVectors(b, a), ac = _t1.subVectors(c, a), ap = _t2.subVectors(p, a);
  const d1 = ab.dot(ap), d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);
  const bp = _t3.subVectors(p, b), d3 = ab.dot(bp), d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return out.copy(a).addScaledVector(ab, d1 / (d1 - d3));
  const cp = _t3.subVectors(p, c), d5 = ab.dot(cp), d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return out.copy(a).addScaledVector(ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return out.copy(b).addScaledVector(_t0.subVectors(c, b), (d4 - d3) / (d4 - d3 + d5 - d6));
  const den = 1 / (va + vb + vc);
  return out.copy(a).addScaledVector(ab, vb * den).addScaledVector(ac, vc * den);
}
const _t0 = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _t3 = new THREE.Vector3();

export class ClothPush {
  constructor(model, colliders, clothTest = /^cloth_coat/) {
    // glTF primitives with different materials become sibling SkinnedMeshes sharing one skeleton: handle them all
    this.meshes = [];
    model.traverse((o) => { if (o.isSkinnedMesh && !/Katana/.test(o.name)) this.meshes.push(o); });
    this.mesh = this.meshes[0];
    const bones = this.mesh.skeleton.bones;
    const byName = Object.fromEntries(bones.map((b) => [b.name, b]));
    this.caps = colliders.filter((c) => c.tail).slice(0, 4).map((c) => ({ a: byName[san(c.bone)], b: byName[san(c.tail)], r: c.radius }))
      .filter((c) => c.a && c.b);
    // 5th field on the hips: the trouser seat / waistband is skinned mostly to the hips, not to the thighs
    const hipsBone = bones.find((b) => /Hips$/.test(b.name)), spine = bones.find((b) => /Spine$/.test(b.name));
    if (hipsBone && spine) this.caps[4] = { a: hipsBone, b: spine, r: 0.12, hips: true };
    this.uM = [0, 1, 2, 3, 4].map(() => new THREE.Matrix4().makeTranslation(-9, -9, -9));   // mesh -> texture coords
    this.uR = [0, 1, 2, 3, 4].map(() => new THREE.Matrix3());                                // bone -> mesh rotation
    this.tex = [0, 1, 2, 3, 4].map(() => null);
    this.debug = { value: 0 };
    this.on = { value: 1 };
    // side memory steers vertices back to their rest side of a leg bone; it misfires once a thigh swings far (the
    // bone frame rotates with it), so it is off: plain nearest-surface push
    this.sideMem = { value: 0 };

    model.updateMatrixWorld(true);
    const cloth = bones.map((b) => clothTest.test(b.name));
    const boneIdx = Object.fromEntries(bones.map((b, i) => [b.name, i]));
    const legBones = new Set(this.caps.filter((c) => !c.hips).map((c) => boneIdx[c.a.name]));
    const p = new THREE.Vector3(), q = new THREE.Vector3();

    // ---- rest geometry (mesh-local), cloth weight per vertex, leg surface triangles
    const meshInv = new THREE.Matrix4().copy(this.mesh.matrixWorld).invert();
    const data = this.meshes.map((mesh) => {
      const g = mesh.geometry, P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
      const N = P.count, rest = new Float32Array(N * 3), clothW = new Float32Array(N), legW = new Float32Array(N);
      const toLocal = new THREE.Matrix4().multiplyMatrices(meshInv, mesh.bindMatrix);
      for (let i = 0; i < N; i++) {
        p.fromBufferAttribute(P, i).applyMatrix4(toLocal).toArray(rest, i * 3);
        for (let k = 0; k < 4; k++) {
          const bi = SI.getComponent(i, k), w = SW.getComponent(i, k);
          if (cloth[bi]) clothW[i] += w;
          if (legBones.has(bi)) legW[i] += w;
        }
      }
      return { mesh, g, SI, SW, N, rest, clothW, legW, index: g.index };
    });
    // leg surface = triangles whose vertices are all non-cloth and mostly carried by leg bones (trousers, boots)
    const tris = [];
    for (const D of data) {
      const I = D.index ? D.index.array : null, nt = I ? I.length / 3 : D.N / 3;
      for (let t = 0; t < nt; t++) {
        const i0 = I ? I[t * 3] : t * 3, i1 = I ? I[t * 3 + 1] : t * 3 + 1, i2 = I ? I[t * 3 + 2] : t * 3 + 2;
        if (D.clothW[i0] > 0.05 || D.clothW[i1] > 0.05 || D.clothW[i2] > 0.05) continue;
        if (D.legW[i0] + D.legW[i1] + D.legW[i2] < 0.45) continue;     // incl. the waistband (partly hips-skinned)
        tris.push([new THREE.Vector3().fromArray(D.rest, i0 * 3), new THREE.Vector3().fromArray(D.rest, i1 * 3), new THREE.Vector3().fromArray(D.rest, i2 * 3)]);
      }
    }
    const triN = tris.map(([a, b, c]) => new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize());
    // spatial hash of triangles (5 cm cells) for nearest-surface queries
    const CELL = 0.05, hash = new Map(), key = (x, y, z) => `${x},${y},${z}`;
    tris.forEach(([a, b, c], ti) => {
      const lo = [0, 1, 2].map((k) => Math.floor(Math.min(a.getComponent(k), b.getComponent(k), c.getComponent(k)) / CELL));
      const hi = [0, 1, 2].map((k) => Math.floor(Math.max(a.getComponent(k), b.getComponent(k), c.getComponent(k)) / CELL));
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        const k = key(x, y, z);
        if (!hash.has(k)) hash.set(k, []);
        hash.get(k).push(ti);
      }
    });
    const cp = new THREE.Vector3();
    const signedDist = (pt) => {
      const cx = Math.floor(pt.x / CELL), cy = Math.floor(pt.y / CELL), cz = Math.floor(pt.z / CELL);
      let best = Infinity, bt = -1;
      const bestP = new THREE.Vector3();
      for (let rad = 0; rad <= 4; rad++) {
        for (let x = cx - rad; x <= cx + rad; x++) for (let y = cy - rad; y <= cy + rad; y++) for (let z = cz - rad; z <= cz + rad; z++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== rad) continue;
          const list = hash.get(key(x, y, z));
          if (!list) continue;
          for (const ti of list) {
            closestOnTri(pt, tris[ti][0], tris[ti][1], tris[ti][2], cp);
            const d2 = cp.distanceToSquared(pt);
            if (d2 < best) { best = d2; bt = ti; bestP.copy(cp); }
          }
        }
        if (bt >= 0 && Math.sqrt(best) < rad * CELL) break;
      }
      if (bt < 0) return 0.3;
      const d = Math.sqrt(best);
      return _v.subVectors(pt, bestP).dot(triN[bt]) < 0 ? -d : d;
    };

    // bone-local axis (towards the child joint) + perpendicular basis, for the side memory
    this.basis = this.caps.map((c) => {
      const axis = c.b.position.clone().normalize();
      const u = new THREE.Vector3(1, 0, 0).addScaledVector(axis, -axis.x);
      if (u.lengthSq() < 1e-4) u.set(0, 0, 1).addScaledVector(axis, -axis.z);
      u.normalize();
      return { axis, u, v: new THREE.Vector3().crossVectors(axis, u) };
    });
    this.uAx = [0, 1, 2, 3, 4].map((i) => (this.basis[i] ? this.basis[i].axis : new THREE.Vector3(0, 1, 0)));
    this.uU = [0, 1, 2, 3, 4].map((i) => (this.basis[i] ? this.basis[i].u : new THREE.Vector3(1, 0, 0)));
    this.uV = [0, 1, 2, 3, 4].map((i) => (this.basis[i] ? this.basis[i].v : new THREE.Vector3(0, 0, 1)));

    // ---- one SDF per leg bone, in the bone's rest frame
    this.update();
    const restBone = this.caps.map((c) => new THREE.Matrix4().multiplyMatrices(meshInv, c.a.matrixWorld));   // bone -> mesh (rest)
    this.grids = [];
    this.caps.forEach((c, ci) => {
      const bi = boneIdx[c.a.name];
      const toBone = restBone[ci].clone().invert();
      const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (const D of data) {
        for (let i = 0; i < D.N; i++) {
          if (D.clothW[i] > 0.05) continue;
          let w = 0;
          for (let k = 0; k < 4; k++) if (D.SI.getComponent(i, k) === bi) w += D.SW.getComponent(i, k);
          if (w < 0.35 || (c.hips && D.legW[i] < 0.05)) continue;     // hips field: only the trouser top
          p.fromArray(D.rest, i * 3).applyMatrix4(toBone);
          lo.min(p); hi.max(p);
        }
      }
      if (!Number.isFinite(lo.x)) return;
      lo.subScalar(PAD); hi.addScalar(PAD);
      const n = [0, 1, 2].map((k) => Math.max(4, Math.ceil((hi.getComponent(k) - lo.getComponent(k)) / VOXEL) + 1));
      const sz = new THREE.Vector3((n[0] - 1) * VOXEL, (n[1] - 1) * VOXEL, (n[2] - 1) * VOXEL);
      const field = new Float32Array(n[0] * n[1] * n[2]);
      for (let z = 0; z < n[2]; z++) for (let y = 0; y < n[1]; y++) for (let x = 0; x < n[0]; x++) {
        p.set(lo.x + x * VOXEL, lo.y + y * VOXEL, lo.z + z * VOXEL).applyMatrix4(restBone[ci]);
        field[x + n[0] * (y + n[1] * z)] = signedDist(p);
      }
      const tex = new THREE.Data3DTexture(field, n[0], n[1], n[2]);
      tex.format = THREE.RedFormat;
      tex.type = THREE.FloatType;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      this.tex[ci] = tex;
      // bone-local -> texel-centre texture coordinates
      const toTex = new THREE.Matrix4().makeScale((n[0] - 1) / n[0] / sz.x, (n[1] - 1) / n[1] / sz.y, (n[2] - 1) / n[2] / sz.z)
        .premultiply(new THREE.Matrix4().makeTranslation(0.5 / n[0], 0.5 / n[1], 0.5 / n[2]))
        .multiply(new THREE.Matrix4().makeTranslation(-lo.x, -lo.y, -lo.z));
      this.grids.push({ ci, toTex, n, lo, sz, field });
      c.grid = { n, size: sz.toArray().map((x) => +x.toFixed(3)) };
    });
    this.grids.forEach((g) => { this.caps[g.ci].toTex = g.toTex; });
    this.update();

    // ---- per cloth vertex: rest inset + rest side (direction in each bone frame)
    const sampleRest = (ci, pt) => {
      const G = this.grids.find((g) => g.ci === ci);
      if (!G) return 1;
      const t = q.copy(pt).applyMatrix4(restBone[ci].clone().invert()).sub(G.lo).divideScalar(VOXEL);
      const i = [Math.round(t.x), Math.round(t.y), Math.round(t.z)];
      if (i.some((x, k) => x < 0 || x >= G.n[k])) return 1;
      return G.field[i[0] + G.n[0] * (i[1] + G.n[1] * i[2])];
    };
    const insets = [];
    let count = 0;
    for (const D of data) {
      const clear = new Float32Array(D.N * 4), inset4 = new Float32Array(D.N * 4), sideA = new Float32Array(D.N * 4);
      for (let i = 0; i < D.N; i++) {
        const w = D.clothW[i];
        if (w < 0.05) { clear[i * 4 + 2] = D.legW[i] > 0.35 ? 1 : 0; continue; }
        clear[i * 4] = 1;
        p.fromArray(D.rest, i * 3);
        let mx = 0;
        this.caps.forEach((c, ci) => {
          const d = sampleRest(ci, p);
          const ins = Math.max(0, CLEAR - d);
          if (ci < 4) inset4[i * 4 + ci] = ins; else clear[i * 4 + 1] = ins;
          mx = Math.max(mx, ins);
          // rest side: direction from the bone axis, in bone-local coordinates (packed as two angles)
          const loc = q.copy(p).applyMatrix4(restBone[ci].clone().invert());
          const B = this.basis[ci];
          loc.addScaledVector(B.axis, -loc.dot(B.axis));
          const ang = Math.atan2(loc.dot(B.v), loc.dot(B.u));
          if (ci < 4) sideA[i * 4 + ci] = ang; else clear[i * 4 + 3] = ang;
        });
        insets.push(mx);
        count++;
      }
      D.g.setAttribute('aClear', new THREE.BufferAttribute(clear, 4));
      D.g.setAttribute('aInset', new THREE.BufferAttribute(inset4, 4));
      D.g.setAttribute('aSide', new THREE.BufferAttribute(sideA, 4));
      for (const m of [D.mesh.material].flat()) this.install(m);
    }
    insets.sort((x, y) => x - y);
    this.insetStats = [0.5, 0.9, 0.99].map((f) => +(insets[Math.floor(insets.length * f)] ?? 0).toFixed(3));
    this.count = count;
    this.tris = tris.length;
  }

  /** debug view: legs red, cloth green-tinted, everything else grey - any red showing through the cloth is clipping */
  setDebug(on) { this.debug.value = on ? 1 : 0; }

  install(material) {
    const prev = material.onBeforeCompile;
    const self = this;
    const empty = new THREE.Data3DTexture(new Float32Array([1]), 1, 1, 1);
    empty.format = THREE.RedFormat; empty.type = THREE.FloatType; empty.needsUpdate = true;
    material.onBeforeCompile = (sh, r) => {
      prev?.call(material, sh, r);
      Object.assign(sh.uniforms, {
        uSdfM: { value: self.uM }, uSdfR: { value: self.uR }, uClothOn: self.on, uClothDebug: self.debug, uSideMem: self.sideMem,
        uAxL: { value: self.uAx }, uUL: { value: self.uU }, uVL: { value: self.uV },
        uSdf0: { value: self.tex[0] ?? empty }, uSdf1: { value: self.tex[1] ?? empty },
        uSdf2: { value: self.tex[2] ?? empty }, uSdf3: { value: self.tex[3] ?? empty }, uSdf4: { value: self.tex[4] ?? empty },
      });
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uClothDebug; varying float vClothW; varying float vLeg;')
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
          if (uClothDebug > 0.5) gl_FragColor.rgb = vClothW > 0.0 ? gl_FragColor.rgb * 0.6 + vec3(0.0, 0.25, 0.0) : vLeg > 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.35);`);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aClear; attribute vec4 aInset; attribute vec4 aSide; varying float vClothW; varying float vLeg;
          precision highp sampler3D;
          uniform sampler3D uSdf0, uSdf1, uSdf2, uSdf3, uSdf4;
          uniform mat4 uSdfM[5]; uniform mat3 uSdfR[5]; uniform float uClothOn; uniform float uSideMem;
          uniform vec3 uAxL[5]; uniform vec3 uUL[5]; uniform vec3 uVL[5];
          float sdfS(int k, vec3 t) {
            return k == 0 ? texture(uSdf0, t).r : k == 1 ? texture(uSdf1, t).r : k == 2 ? texture(uSdf2, t).r : k == 3 ? texture(uSdf3, t).r : texture(uSdf4, t).r;
          }
          vec3 pushLeg(vec3 p, int k, float inset, float side) {
            vec3 t = (uSdfM[k] * vec4(p, 1.0)).xyz;
            if (any(lessThan(t, vec3(0.0))) || any(greaterThan(t, vec3(1.0)))) return p;
            float target = ${CLEAR.toFixed(4)} - inset;
            float d = sdfS(k, t);
            if (d >= target) return p;
            vec3 e = vec3(0.6) / vec3(textureSize(uSdf0, 0));
            if (k == 1) e = vec3(0.6) / vec3(textureSize(uSdf1, 0));
            if (k == 2) e = vec3(0.6) / vec3(textureSize(uSdf2, 0));
            if (k == 3) e = vec3(0.6) / vec3(textureSize(uSdf3, 0));
            if (k == 4) e = vec3(0.6) / vec3(textureSize(uSdf4, 0));
            vec3 g = vec3(sdfS(k, t + vec3(e.x, 0, 0)) - sdfS(k, t - vec3(e.x, 0, 0)),
                          sdfS(k, t + vec3(0, e.y, 0)) - sdfS(k, t - vec3(0, e.y, 0)),
                          sdfS(k, t + vec3(0, 0, e.z)) - sdfS(k, t - vec3(0, 0, e.z)));
            vec3 gl = length(g) > 1e-6 ? normalize(g) : vec3(1.0, 0.0, 0.0);
            // side memory (bone frame): inside and escaping away from the rest side -> leave on the rest side
            vec3 rs = cos(side) * uUL[k] + sin(side) * uVL[k];
            vec3 gp = normalize(gl - uAxL[k] * dot(gl, uAxL[k]) + 1e-5);
            if (uSideMem > 0.5 && d < 0.0 && dot(gp, rs) < 0.0) gl = normalize(mix(gl, rs, smoothstep(0.0, -0.5, dot(gp, rs))));
            vec3 dir = normalize(uSdfR[k] * gl);
            return p + dir * (target - d);
          }`)
        .replace('#include <skinning_vertex>', `#include <skinning_vertex>
          vClothW = aClear.x; vLeg = aClear.z;
          if (aClear.x > 0.0 && uClothOn > 0.5) {
            for (int it = 0; it < 3; it++) {
              transformed = pushLeg(transformed, 0, aInset.x, aSide.x);
              transformed = pushLeg(transformed, 1, aInset.y, aSide.y);
              transformed = pushLeg(transformed, 2, aInset.z, aSide.z);
              transformed = pushLeg(transformed, 3, aInset.w, aSide.w);
              transformed = pushLeg(transformed, 4, aClear.y, aClear.w);
            }
          }`);
    };
    const key = material.customProgramCacheKey?.bind(material);
    material.customProgramCacheKey = () => (key ? key() : '') + '-clothsdf5';
    material.needsUpdate = true;
  }

  /**
   * CPU version of the shader push for the cloth simulation: moves a WORLD-space point out of the trouser distance
   * fields to at least `clear` metres outside (side memory is the simulation's job: it collides every substep).
   */
  pushOutWorld(p, clear) {
    if (!this.grids?.length) return p;
    const toLocal = _m.copy(this.mesh.matrixWorld).invert();
    const lp = _pw.copy(p).applyMatrix4(toLocal);
    let moved = false;
    for (const G of this.grids) {
      const t = _pt.copy(lp).applyMatrix4(this.uM[G.ci]);
      if (t.x < 0 || t.y < 0 || t.z < 0 || t.x > 1 || t.y > 1 || t.z > 1) continue;
      const d = sampleField(G, t.x, t.y, t.z);
      if (d >= clear) continue;
      const ex = 0.6 / G.n[0], ey = 0.6 / G.n[1], ez = 0.6 / G.n[2];
      _pg.set(sampleField(G, t.x + ex, t.y, t.z) - sampleField(G, t.x - ex, t.y, t.z),
        sampleField(G, t.x, t.y + ey, t.z) - sampleField(G, t.x, t.y - ey, t.z),
        sampleField(G, t.x, t.y, t.z + ez) - sampleField(G, t.x, t.y, t.z - ez));
      if (_pg.lengthSq() < 1e-12) continue;
      _pg.normalize().applyMatrix3(this.uR[G.ci]).normalize();
      lp.addScaledVector(_pg, clear - d);
      moved = true;
    }
    if (moved) p.copy(lp.applyMatrix4(this.mesh.matrixWorld));
    return p;
  }

  /** signed distance (m) from a WORLD-space point to the nearest trouser field surface (Infinity outside all fields) */
  distanceWorld(p) {
    if (!this.grids?.length) return Infinity;
    const lp = _pw.copy(p).applyMatrix4(_m.copy(this.mesh.matrixWorld).invert());
    let best = Infinity;
    for (const G of this.grids) {
      const t = _pt.copy(lp).applyMatrix4(this.uM[G.ci]);
      if (t.x < 0 || t.y < 0 || t.z < 0 || t.x > 1 || t.y > 1 || t.z > 1) continue;
      best = Math.min(best, sampleField(G, t.x, t.y, t.z));
    }
    return best;
  }

  /** bone frames in the mesh's local (skinned) space - call after the skeleton is posed each frame */
  update() {
    this.on.value = this.enabled === false ? 0 : 1;
    const meshInv = _m.copy(this.mesh.matrixWorld).invert();
    this.caps.forEach((c, i) => {
      const boneToMesh = _m2.multiplyMatrices(meshInv, c.a.matrixWorld);
      this.uR[i].setFromMatrix4(boneToMesh);
      if (c.toTex) this.uM[i].copy(boneToMesh).invert().premultiply(c.toTex);
    });
  }
}
