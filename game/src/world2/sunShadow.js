import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { SunLightShadow } from 'three/addons/lights/SunLightShadow.js';

/**
 * Cascaded sun shadows, on three's built-in SunLight (r186: two cascades in one 2:1 atlas, fitted to the view frustum,
 * texel-snapped, blended over a fade band; the core shader chunks handle it for every built-in / onBeforeCompile
 * material, no per-material setup).
 *
 * Changes over the stock SunLightShadow:
 *  - the split is a fixed distance (`split`, metres) instead of the practical split scheme, so the near cascade stays
 *    tight around the player (~0.03 m texels) whatever the coverage distance (`camera.far`)
 *  - per-cascade bias (installSunShadowBias): the far cascade's texels are ~6x larger, so it gets a larger normal / depth
 *    bias (no acne on the low-sun terrain) while the near cascade keeps contact shadows tight (no peter-panning)
 */
const CASCADES = 2;          // must match SUN_LIGHT_CASCADES in the shader chunks
const FADE = 0.1;            // share of a cascade's depth range that blends into the next one

const _orient = new THREE.Matrix4(), _viewToLight = new THREE.Matrix4();
const _dir = new THREE.Vector3(), _up = new THREE.Vector3(), _center = new THREE.Vector3();
const _near = [0, 1, 2, 3].map(() => new THREE.Vector3()), _far = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _corners = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new THREE.Vector3());

export class FixedSplitSunShadow extends SunLightShadow {
  constructor(split = 30) {
    super();
    this.split = split;
  }

  updateMatrices(light, viewCamera) {
    if (viewCamera === undefined) return;
    const insetX = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.x);
    const insetY = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.y);
    for (let i = 0; i < CASCADES; i++) this._viewports[i].set(i + insetX, insetY, 1 - 2 * insetX, 1 - 2 * insetY);
    const resX = this.mapSize.x * (1 - 2 * insetX), resY = this.mapSize.y * (1 - 2 * insetY);
    const res = Math.min(resX, resY);

    const camera = this.camera;
    const cNear = viewCamera.near;
    const cFar = Math.max(cNear + 1e-6, Math.min(camera.far, viewCamera.far));
    const splits = this._cascadeSplits;
    splits[0] = cNear;
    splits[1] = THREE.MathUtils.clamp(this.split, cNear + 1, cFar * 0.5);
    splits[2] = cFar;

    _dir.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_dir)) > 0.99) _up.set(0, 0, 1);
    _orient.lookAt(_center.set(0, 0, 0), _dir, _up);
    _viewToLight.copy(_orient).transpose().multiply(viewCamera.matrixWorld);

    const inv = viewCamera.projectionMatrixInverse;
    let maxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1, y = i === 0 || i === 3 ? 1 : -1;
      const n = _near[i].set(x, y, -1).applyMatrix4(inv);
      const f = _far[i];
      if (viewCamera.isPerspectiveCamera) f.copy(n).multiplyScalar(cFar / cNear); else f.set(n.x, n.y, -cFar);
      n.applyMatrix4(_viewToLight); f.applyMatrix4(_viewToLight);
      maxZ = Math.max(maxZ, n.z, f.z);
    }
    maxZ += cFar;                       // casters up to one coverage distance towards the sun still cast
    const sNear = camera.near;

    for (let i = 0; i < CASCADES; i++) {
      const cascadeNear = i === 0 ? splits[0] : this._cascadeData[i - 1].z;
      const cascadeFar = splits[i + 1];
      const fadeStart = cascadeFar - FADE * (cascadeFar - splits[i]);
      this._cascadeData[i].set(i === 0 ? -1e10 : cascadeNear, cascadeFar, fadeStart, 0);
      const a0 = (cascadeNear - cNear) / (cFar - cNear), a1 = (cascadeFar - cNear) / (cFar - cNear);
      _center.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        _corners[j * 2].lerpVectors(_near[j], _far[j], a0);
        _corners[j * 2 + 1].lerpVectors(_near[j], _far[j], a1);
        _center.add(_corners[j * 2]).add(_corners[j * 2 + 1]);
      }
      _center.multiplyScalar(1 / 8);
      let r2 = 0, minZ = Infinity;
      for (let j = 0; j < 8; j++) { r2 = Math.max(r2, _corners[j].distanceToSquared(_center)); minZ = Math.min(minZ, _corners[j].z); }
      let radius = Math.sqrt(r2);
      // radius quantised (the camera's fov kick must not resize the cascade every frame) + texel snapping: no shimmer
      radius = Math.ceil(radius / 2) * 2;
      if (res > 1) {
        radius /= 1 - 1 / res;
        const tx = 2 * radius / resX, ty = 2 * radius / resY;
        _center.x = Math.round(_center.x / tx) * tx;
        _center.y = Math.round(_center.y / ty) * ty;
      }
      _center.z = maxZ + sNear;
      _center.applyMatrix4(_orient);
      const cam = this._cameras[i];
      cam.position.copy(_center);
      cam.quaternion.setFromRotationMatrix(_orient);
      cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
      cam.near = sNear;
      cam.far = maxZ - minZ + 2 * sNear;
      cam.coordinateSystem = camera.coordinateSystem;
      cam._reversedDepth = camera.reversedDepth;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      this._updateMatrix(cam, this._matrices[i], this._frustums[i], this._viewports[i]);
    }
  }
}

/** a shadow-casting SunLight shining along `dir` (towards the sun) with the fixed-split cascades */
export function makeSun(color, intensity, dir, { mapSize = 2048, split = 30, distance = 220 } = {}) {
  const sun = new SunLight(color, intensity);
  sun.position.copy(dir).normalize();
  sun.shadow = new FixedSplitSunShadow(split);
  sun.shadow.mapSize.set(mapSize, mapSize);          // per cascade (the atlas is 2 x mapSize wide)
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = distance;                  // shadow coverage from the camera
  sun.shadow.bias = -0.00006;                        // near cascade (the far one is scaled, see below)
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 1.6;
  sun.castShadow = true;
  return sun;
}

let biasInstalled = false;
/**
 * Per-cascade bias in the core sun-shadow lookup (patched once, before any program compiles): cascade 1's texels are
 * several times larger, so its normal offset / depth bias are scaled by FAR_BIAS.
 */
export function installSunShadowBias(farNormal = 5.0, farDepth = 6.0) {
  if (biasInstalled) return;
  biasInstalled = true;
  const C = THREE.ShaderChunk;
  const src = C.shadowmap_pars_fragment;
  const a = 'sunLightShadow.shadowBias,\n\t\t\t\t\t\tsunLightShadow.shadowRadius,\n\t\t\t\t\t\tsunShadowMatrix[ cascadeOffset + i ] * shadowWorldPosition';
  if (!src.includes(a)) { console.warn('sun shadow chunk changed: per-cascade bias not installed'); return; }
  C.shadowmap_pars_fragment = src.replace(a, `sunLightShadow.shadowBias * (i == 0 ? 1.0 : ${farDepth.toFixed(2)}),
						sunLightShadow.shadowRadius * (i == 0 ? 1.0 : 0.75),
						sunShadowMatrix[ cascadeOffset + i ] * vec4( shadowWorldPosition.xyz + vSunShadowWorldNormal * sunLightShadow.shadowNormalBias * (i == 0 ? 0.0 : ${(farNormal - 1).toFixed(2)}), 1.0 )`);
}
