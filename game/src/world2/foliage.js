import * as THREE from 'three';
import { rng } from './noise.js';

/**
 * Maple canopies for the ruined valley. Tree crowns from trees.glb (materials Leaf_Red / Leaf_Orange, vertex colour R =
 * baked canopy AO) are invisible guide volumes: thousands of alpha-cut cards with the generated maple-leaf cluster
 * textures are scattered over and just inside them. Card normals point out of the crown so the canopy shades as one
 * soft volume; colours carry the AO; cards sway in the wind and cast leaf-shaped shadows.
 */
export const FOLIAGE_TIME = { value: 0 };

const loader = new THREE.TextureLoader();
const cache = {};
function cardTexture(name) {
  if (cache[name]) return cache[name];
  const t = loader.load(`tex/w2/${name}.png`);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return (cache[name] = t);
}

const KINDS = [
  { test: /^Leaf_Red/, tex: 'maple_red_card', tint: '#ffffff', density: 9, size: [0.9, 1.6] },
  { test: /^Leaf_Orange/, tex: 'maple_orange_card', tint: '#ffffff', density: 9, size: [0.9, 1.6] },
  { test: /^Leaf/, tex: 'maple_red_card', tint: '#ffffff', density: 9, size: [0.9, 1.6] },
];

const materials = {};
function leafMaterial(kind) {
  if (materials[kind.tex]) return materials[kind.tex];
  const map = cardTexture(kind.tex);
  const m = new THREE.MeshStandardMaterial({
    map, alphaTest: 0.45, side: THREE.DoubleSide, vertexColors: true, roughness: 0.85,
    color: new THREE.Color(kind.tint),
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = FOLIAGE_TIME;
    // sun shining through the leaves when backlit (thin maple leaves glow amber-red against the low sun)
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      #if NUM_SUN_LIGHTS > 0
        float leafBack = pow(max(dot(-geometryViewDir, sunLights[0].direction), 0.0), 6.0);
        reflectedLight.directDiffuse += diffuseColor.rgb * vec3(0.9, 0.75, 0.45) * sunLights[0].color * leafBack * 0.1;
      #endif`);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute vec3 aAnchor;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float ph = dot(aAnchor, vec3(0.37, 0.11, 0.29));
        float sway = 0.06 * clamp(aAnchor.y * 0.08, 0.0, 1.5);
        transformed += vec3(sin(uTime * 1.3 + ph), 0.25 * sin(uTime * 2.1 + ph * 1.7), cos(uTime * 1.1 + ph * 1.3)) * sway;`);
  };
  m.customProgramCacheKey = () => `w2leaf-${kind.tex}`;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.45, side: THREE.DoubleSide });
  return (materials[kind.tex] = { m, depth });
}

/** Replace the crown meshes of a tree prototype with leaf cards (in place). `budget` caps cards per tree. */
export function convertTree(proto, { budget = 2500, seed = 1 } = {}) {
  proto.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(proto.matrixWorld).invert();
  const crowns = [];
  proto.traverse((o) => { if (o.isMesh && KINDS.some((k) => k.test.test(o.material.name))) crowns.push(o); });
  if (!crowns.length) return 0;
  const r = rng(seed);
  let total = 0;
  for (const crown of crowns) {
    const kind = KINDS.find((k) => k.test.test(crown.material.name));
    const g = crown.geometry, P = g.attributes.position, N = g.attributes.normal, C = g.attributes.color, idx = g.index;
    const toProto = new THREE.Matrix4().multiplyMatrices(inv, crown.matrixWorld);
    const nm = new THREE.Matrix3().getNormalMatrix(toProto);
    const tris = idx ? idx.count / 3 : P.count / 3, cum = new Float32Array(tris);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
    let area = 0;
    for (let t = 0; t < tris; t++) {
      a.fromBufferAttribute(P, vi(t, 0)).applyMatrix4(toProto); b.fromBufferAttribute(P, vi(t, 1)).applyMatrix4(toProto); c.fromBufferAttribute(P, vi(t, 2)).applyMatrix4(toProto);
      area += b.sub(a).cross(c.sub(a)).length() * 0.5;
      cum[t] = area;
    }
    const n = Math.min(Math.round(area * kind.density), Math.round(budget / crowns.length));
    const pos = new Float32Array(n * 12), nor = new Float32Array(n * 12), col = new Float32Array(n * 12), uv = new Float32Array(n * 8), anc = new Float32Array(n * 12), ind = [];
    const p = new THREE.Vector3(), nn = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler(), cc = new THREE.Color();
    const corner = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    for (let i = 0; i < n; i++) {
      const x = r() * area;
      let lo = 0, hi = tris - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; }
      let u = r(), v = r(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const i0 = vi(lo, 0), i1 = vi(lo, 1), i2 = vi(lo, 2);
      p.fromBufferAttribute(P, i0).multiplyScalar(1 - u - v).add(b.fromBufferAttribute(P, i1).multiplyScalar(u)).add(c.fromBufferAttribute(P, i2).multiplyScalar(v)).applyMatrix4(toProto);
      nn.fromBufferAttribute(N, i0).add(b.fromBufferAttribute(N, i1)).add(c.fromBufferAttribute(N, i2)).applyMatrix3(nm).normalize();
      const ao0 = C ? THREE.MathUtils.clamp(C.getX(i0), 0, 1) : 1;
      const depth = r();
      p.addScaledVector(nn, -depth * 0.6 + 0.12);                     // fill the volume, not just the shell
      const ao = (0.4 + 0.6 * ao0) * (0.55 + 0.45 * (1 - depth));     // canopy interior clearly darker
      const tint = 0.85 + r() * 0.3;
      const size = kind.size[0] + r() * (kind.size[1] - kind.size[0]);
      // cards roughly face outwards with random roll so the canopy reads as leaves from every side
      e.set((r() - 0.5) * 1.6, Math.atan2(nn.x, nn.z) + (r() - 0.5) * 1.2, r() * Math.PI * 2);
      q.setFromEuler(e);
      // ~30 % of the cards turn autumn orange (red card x warm tint), as in the reference
      if (kind.tex === 'maple_red_card' && r() < 0.3) cc.setRGB(ao * tint * 1.05, ao * tint * 1.7, ao * tint * 0.85);
      else cc.setRGB(ao * tint, ao * tint, ao * tint);
      for (let k = 0; k < 4; k++) {
        const w = new THREE.Vector3(corner[k][0] * size, corner[k][1] * size, 0).applyQuaternion(q).add(p);
        w.toArray(pos, (i * 4 + k) * 3);
        nn.toArray(nor, (i * 4 + k) * 3);
        p.toArray(anc, (i * 4 + k) * 3);
        cc.toArray(col, (i * 4 + k) * 3);
        uv[(i * 4 + k) * 2] = corner[k][0] + 0.5; uv[(i * 4 + k) * 2 + 1] = corner[k][1] + 0.5;
      }
      const o = i * 4;
      ind.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aAnchor', new THREE.BufferAttribute(anc, 3));
    geo.setIndex(ind);
    geo.computeBoundingSphere();
    const { m, depth } = leafMaterial(kind);
    const mesh = new THREE.Mesh(geo, m);
    mesh.customDepthMaterial = depth;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `${proto.name}_leaves`;
    proto.add(mesh);
    crown.parent.remove(crown);
    total += n;
  }
  return total;
}
