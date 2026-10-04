import * as THREE from 'three';
import { heightAt, masks, pathDist, riverDist, BOUNDS, TERRAIN } from './layout.js';
import { fillRows, PATH_RANGE, RIVER_MIN, RIVER_RANGE } from './terrain_rows.js';

export { PATH_RANGE, RIVER_MIN, RIVER_RANGE };

/**
 * Cached terrain data shared by the terrain mesh, its splat shader and the GPU vegetation.
 *
 *   fine grid    1 m over BOUNDS + FINE_MARGIN (height, path / river distance, flower mask, normal, cavity)
 *   coarse grid  8 m over TERRAIN (height only, bicubic interpolation; the backdrop)
 *
 * layout.heightAt() costs several µs per call, so it is evaluated once per grid node — in parallel web workers
 * (terrain_worker.js, main-thread fallback) — and everything else interpolates these grids.
 * `ready` resolves when the grids and textures are filled; until then height() falls back to layout.heightAt.
 *
 * GPU textures (fine grid, 1 texel per metre, texel centres on the grid nodes):
 *   heightTex  R32F   height (nearest; the vegetation vertex shader does its own bilinear fetch)
 *   dataTex    RGBA8  R = path distance / 16 m, G = (river distance - river half width + 16) / 64,
 *                     B = flower mask, A = 0.5 + cavity (positive in hollows)
 *   normTex    RGBA8  RGB = normal * 0.5 + 0.5, A = 1
 */
export const FINE_MARGIN = 40;
const COARSE = 8;
const BLEND = 10;                        // metres over which the fine grid fades into the coarse one at its border

export class TerrainData {
  constructor() {
    const f = (this.fine = {
      x0: BOUNDS.minX - FINE_MARGIN, z0: BOUNDS.minZ - FINE_MARGIN,
      x1: BOUNDS.maxX + FINE_MARGIN, z1: BOUNDS.maxZ + FINE_MARGIN, step: 1,
    });
    f.nx = f.x1 - f.x0 + 1;
    f.nz = f.z1 - f.z0 + 1;
    const n = f.nx * f.nz;
    f.h = new Float32Array(n);
    f.n = new Float32Array(n * 3);
    this.dataArr = new Uint8Array(n * 4);
    this.normArr = new Uint8Array(n * 4);
    const c = (this.coarse = { x0: TERRAIN.minX, z0: TERRAIN.minZ, step: COARSE });
    c.nx = Math.round((TERRAIN.maxX - TERRAIN.minX) / COARSE) + 1;
    c.nz = Math.round((TERRAIN.maxZ - TERRAIN.minZ) / COARSE) + 1;
    c.h = new Float32Array(c.nx * c.nz);
    const tex = (arr, format, type, filter) => {
      const t = new THREE.DataTexture(arr, f.nx, f.nz, format, type);
      t.magFilter = t.minFilter = filter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      return t;
    };
    this.heightTex = tex(f.h, THREE.RedFormat, THREE.FloatType, THREE.NearestFilter);
    this.dataTex = tex(this.dataArr, THREE.RGBAFormat, THREE.UnsignedByteType, THREE.LinearFilter);
    this.normTex = tex(this.normArr, THREE.RGBAFormat, THREE.UnsignedByteType, THREE.LinearFilter);
    /** shader uniform: fine grid origin (x0, z0) and size in texels (nx, nz) */
    this.fineRect = new THREE.Vector4(f.x0, f.z0, f.nx, f.nz);
    this.isReady = false;
    this.buildMs = 0;
    this.ready = this.build();
  }

  async build() {
    const t0 = performance.now();
    const f = this.fine, c = this.coarse;
    const jobs = [];
    const band = (kind, grid, nz, rows) => {
      for (let j = 0; j < nz; j += rows) jobs.push({ id: jobs.length, kind, grid, j0: j, j1: Math.min(nz, j + rows) });
    };
    band('fine', { x0: f.x0, z0: f.z0, step: 1, nx: f.nx }, f.nz, 16);
    band('coarse', { x0: c.x0, z0: c.z0, step: COARSE, nx: c.nx, skip: { x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1 } }, c.nz, 24);
    let results;
    try {
      results = await runInWorkers(jobs);
      this.mode = 'workers';
    } catch (e) {
      console.warn('TerrainData: workers unavailable, computing on the main thread', e);
      const L = { heightAt, masks, pathDist, riverDist };
      results = jobs.map((j) => fillRows(L, j));
      this.mode = 'main thread';
    }
    for (const job of jobs) {
      const r = results[job.id];
      const g = job.kind === 'fine' ? f : c;
      g.h.set(r.h, job.j0 * g.nx);
      if (r.d) this.dataArr.set(r.d, job.j0 * g.nx * 4);
    }
    this.finish();
    this.buildMs = performance.now() - t0;
    this.isReady = true;
    return this;
  }

  /** normals, cavity, coarse nodes inside the fine grid, block min / max; flag textures for upload */
  finish() {
    const f = this.fine, c = this.coarse, data = this.dataArr, norm = this.normArr;
    const H = (i, j) => f.h[THREE.MathUtils.clamp(i, 0, f.nx - 1) + THREE.MathUtils.clamp(j, 0, f.nz - 1) * f.nx];
    const v = new THREE.Vector3();
    for (let j = 0; j < f.nz; j++) {
      for (let i = 0; i < f.nx; i++) {
        const k = i + j * f.nx;
        v.set((H(i - 1, j) - H(i + 1, j)) * 0.5, 1, (H(i, j - 1) - H(i, j + 1)) * 0.5).normalize();
        f.n[k * 3] = v.x; f.n[k * 3 + 1] = v.y; f.n[k * 3 + 2] = v.z;
        norm[k * 4] = Math.round((v.x * 0.5 + 0.5) * 255);
        norm[k * 4 + 1] = Math.round((v.y * 0.5 + 0.5) * 255);
        norm[k * 4 + 2] = Math.round((v.z * 0.5 + 0.5) * 255);
        norm[k * 4 + 3] = 255;
        const ring = (H(i - 6, j) + H(i + 6, j) + H(i, j - 6) + H(i, j + 6) + H(i - 4, j - 4) + H(i + 4, j + 4) + H(i - 4, j + 4) + H(i + 4, j - 4)) / 8;
        data[k * 4 + 3] = Math.round(THREE.MathUtils.clamp(0.5 + (ring - f.h[k]) * 0.25, 0, 1) * 255);
      }
    }
    for (let j = 0; j < c.nz; j++) for (let i = 0; i < c.nx; i++) {
      const x = c.x0 + i * COARSE, z = c.z0 + j * COARSE;
      if (x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1) c.h[i + j * c.nx] = f.h[(x - f.x0) + (z - f.z0) * f.nx];
    }
    // min / max per 16 m block of the fine grid (vegetation tile bounds)
    const B = (this.block = { size: 16 });
    B.nx = Math.ceil(f.nx / 16); B.nz = Math.ceil(f.nz / 16);
    B.min = new Float32Array(B.nx * B.nz).fill(1e9);
    B.max = new Float32Array(B.nx * B.nz).fill(-1e9);
    for (let j = 0; j < f.nz; j++) for (let i = 0; i < f.nx; i++) {
      const b = (i >> 4) + (j >> 4) * B.nx, h = f.h[i + j * f.nx];
      if (h < B.min[b]) B.min[b] = h;
      if (h > B.max[b]) B.max[b] = h;
    }
    this.heightTex.needsUpdate = this.dataTex.needsUpdate = this.normTex.needsUpdate = true;
  }

  /** bilinear sample of the fine grid (clamped to it) */
  fineHeight(x, z) {
    const f = this.fine;
    const gx = THREE.MathUtils.clamp(x - f.x0, 0, f.nx - 1.0001), gz = THREE.MathUtils.clamp(z - f.z0, 0, f.nz - 1.0001);
    const i = Math.floor(gx), j = Math.floor(gz), tx = gx - i, tz = gz - j, k = i + j * f.nx;
    return (f.h[k] * (1 - tx) + f.h[k + 1] * tx) * (1 - tz) + (f.h[k + f.nx] * (1 - tx) + f.h[k + f.nx + 1] * tx) * tz;
  }

  /** Catmull-Rom bicubic sample of the coarse grid */
  coarseHeight(x, z) {
    const c = this.coarse;
    const gx = THREE.MathUtils.clamp((x - c.x0) / c.step, 0, c.nx - 1.0001), gz = THREE.MathUtils.clamp((z - c.z0) / c.step, 0, c.nz - 1.0001);
    const i = Math.floor(gx), j = Math.floor(gz), tx = gx - i, tz = gz - j;
    const row = (jj) => {
      const r = THREE.MathUtils.clamp(jj, 0, c.nz - 1) * c.nx;
      const p = (ii) => c.h[r + THREE.MathUtils.clamp(ii, 0, c.nx - 1)];
      return cubic(p(i - 1), p(i), p(i + 1), p(i + 2), tx);
    };
    return cubic(row(j - 1), row(j), row(j + 1), row(j + 2), tz);
  }

  /** 0 outside the fine grid, 1 more than BLEND metres inside it */
  fineWeight(x, z) {
    const f = this.fine;
    const e = Math.min(x - f.x0, f.x1 - x, z - f.z0, f.z1 - z);
    return e <= 0 ? 0 : e >= BLEND ? 1 : smooth(e / BLEND);
  }

  /** cached ground height anywhere on the terrain (matches heightAt to a few cm) */
  height(x, z) {
    if (!this.isReady) return heightAt(x, z);
    const w = this.fineWeight(x, z);
    if (w >= 1) return this.fineHeight(x, z);
    if (w <= 0) return this.coarseHeight(x, z);
    return this.coarseHeight(x, z) * (1 - w) + this.fineHeight(x, z) * w;
  }

  /** surface normal from the cached heights, finite differences over `eps` metres */
  normal(x, z, eps, out = new THREE.Vector3()) {
    return out.set(this.height(x - eps, z) - this.height(x + eps, z), 2 * eps, this.height(x, z - eps) - this.height(x, z + eps)).normalize();
  }

  /** min / max height over an xz rectangle of the fine grid */
  heightRange(x0, z0, x1, z1) {
    const f = this.fine, B = this.block;
    const bi0 = Math.floor((x0 - f.x0) / 16), bi1 = Math.floor((x1 - f.x0) / 16);
    const bj0 = Math.floor((z0 - f.z0) / 16), bj1 = Math.floor((z1 - f.z0) / 16);
    let lo = 1e9, hi = -1e9;
    for (let j = Math.max(0, bj0); j <= Math.min(B.nz - 1, bj1); j++) {
      for (let i = Math.max(0, bi0); i <= Math.min(B.nx - 1, bi1); i++) {
        lo = Math.min(lo, B.min[i + j * B.nx]); hi = Math.max(hi, B.max[i + j * B.nx]);
      }
    }
    if (lo > hi) { lo = hi = this.height((x0 + x1) / 2, (z0 + z1) / 2); }
    return [lo, hi];
  }
}

/** run row-band jobs on a small worker pool; resolves to results indexed by job id */
function runInWorkers(jobs) {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') { reject(new Error('no Worker')); return; }
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const count = Math.max(2, Math.min(8, cores - 1));
    const results = new Array(jobs.length);
    const queue = [...jobs];
    const workers = [];
    let done = 0, failed = false;
    const finish = (err) => {
      for (const w of workers) w.terminate();
      if (err) reject(err); else resolve(results);
    };
    for (let i = 0; i < count; i++) {
      let w;
      try {
        w = new Worker(new URL('./terrain_worker.js', import.meta.url), { type: 'module' });
      } catch (e) { finish(e); return; }
      workers.push(w);
      const next = () => { const j = queue.shift(); if (j) w.postMessage(j); };
      w.onmessage = (e) => {
        results[e.data.id] = e.data;
        if (++done === jobs.length) finish();
        else next();
      };
      w.onerror = (e) => { if (!failed) { failed = true; finish(e.error || new Error(e.message || 'worker error')); } };
      next();
    }
  });
}

function cubic(p0, p1, p2, p3, t) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}
const smooth = (t) => t * t * (3 - 2 * t);
