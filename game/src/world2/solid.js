import * as THREE from 'three';

/**
 * Vertical "column" rasterisation of static meshes: every triangle is scan-converted onto a regular xz lattice and
 * each lattice column remembers where the triangle crosses it (y) and whether that face looks up or down.
 * That answers, without ray casts:
 *   top(x, z, below)  the highest up-facing surface under `below` (cliff tiers, ledges)
 *   inside(x, y, z)   is the point inside the solid? (the nearest surface above it faces up -> we are under a roof
 *                     of rock, i.e. inside; open-bottomed meshes sunk into the ground work too)
 * Used for the cliff waterfalls and to build the player's solid occupancy grid (SolidGrid).
 */
export class Columns {
  constructor(cell = 0.5) {
    this.cell = cell;
    this.parts = [];
  }

  /** add every mesh under `root` (world transforms must be current) */
  add(root, tag = root.name) {
    const c = this.cell;
    const tris = [];                                   // world-space vertex triples, flattened
    root.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    root.traverse((m) => {
      if (!m.isMesh) return;
      const pos = m.geometry.attributes.position, idx = m.geometry.index;
      const w = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); w[i * 3] = v.x; w[i * 3 + 1] = v.y; w[i * 3 + 2] = v.z; }
      const n = idx ? idx.count : pos.count;
      for (let t = 0; t < n; t += 3) {
        const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, d = idx ? idx.getX(t + 2) : t + 2;
        tris.push(w[a * 3], w[a * 3 + 1], w[a * 3 + 2], w[b * 3], w[b * 3 + 1], w[b * 3 + 2], w[d * 3], w[d * 3 + 1], w[d * 3 + 2]);
      }
    });
    if (!tris.length) return null;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < tris.length; i += 3) {
      minX = Math.min(minX, tris[i]); maxX = Math.max(maxX, tris[i]);
      minY = Math.min(minY, tris[i + 1]); maxY = Math.max(maxY, tris[i + 1]);
      minZ = Math.min(minZ, tris[i + 2]); maxZ = Math.max(maxZ, tris[i + 2]);
    }
    const i0 = Math.floor(minX / c), k0 = Math.floor(minZ / c);
    const nx = Math.floor(maxX / c) - i0 + 1, nz = Math.floor(maxZ / c) - k0 + 1;
    const count = new Uint32Array(nx * nz + 1);
    const visit = (fn) => {
      for (let t = 0; t < tris.length; t += 9) {
        const ax = tris[t], ay = tris[t + 1], az = tris[t + 2], bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5], dx = tris[t + 6], dy = tris[t + 7], dz = tris[t + 8];
        const area = (bx - ax) * (dz - az) - (dx - ax) * (bz - az);      // 2 x signed projected area (y component of normal, negated)
        if (Math.abs(area) < 1e-6) continue;
        const up = area < 0 ? 1 : -1;                                     // (b-a) x (d-a) . y = -area
        const xa = Math.ceil(Math.min(ax, bx, dx) / c - 0.5), xb = Math.floor(Math.max(ax, bx, dx) / c - 0.5);
        const za = Math.ceil(Math.min(az, bz, dz) / c - 0.5), zb = Math.floor(Math.max(az, bz, dz) / c - 0.5);
        for (let k = za; k <= zb; k++) {
          const pz = (k + 0.5) * c;
          for (let i = xa; i <= xb; i++) {
            const px = (i + 0.5) * c;
            const w1 = ((bx - px) * (dz - pz) - (dx - px) * (bz - pz)) / area;
            const w2 = ((dx - px) * (az - pz) - (ax - px) * (dz - pz)) / area;
            const w3 = 1 - w1 - w2;
            if (w1 < 0 || w2 < 0 || w3 < 0) continue;
            fn((i - i0) + (k - k0) * nx, w1 * ay + w2 * by + w3 * dy, up);
          }
        }
      }
    };
    visit((cell) => count[cell + 1]++);
    for (let i = 1; i < count.length; i++) count[i] += count[i - 1];
    const ys = new Float32Array(count[count.length - 1]), ups = new Int8Array(ys.length), fill = count.slice(0, -1);
    visit((cell, y, up) => { const j = fill[cell]++; ys[j] = y; ups[j] = up; });
    const part = { tag, i0, k0, nx, nz, start: count, ys, ups, minX, maxX, minY, maxY, minZ, maxZ };
    this.parts.push(part);
    return part;
  }

  cellOf(p, x, z) {
    const i = Math.floor(x / this.cell) - p.i0, k = Math.floor(z / this.cell) - p.k0;
    return i < 0 || k < 0 || i >= p.nx || k >= p.nz ? -1 : i + k * p.nx;
  }

  /** highest up-facing surface below `below` at (x, z) (null if none); optionally only parts with this tag */
  top(x, z, below = Infinity, tag = null) {
    let best = null;
    for (const p of this.parts) {
      if (tag && p.tag !== tag) continue;
      const cl = this.cellOf(p, x, z);
      if (cl < 0) continue;
      for (let j = p.start[cl]; j < p.start[cl + 1]; j++) if (p.ups[j] > 0 && p.ys[j] < below && (best == null || p.ys[j] > best)) best = p.ys[j];
    }
    return best;
  }

  /** is (x, y, z) inside one of the meshes (nearest surface above faces up)? */
  inside(x, y, z, tag = null) {
    for (const p of this.parts) {
      if (tag && p.tag !== tag) continue;
      if (y < p.minY || y > p.maxY) continue;
      const cl = this.cellOf(p, x, z);
      if (cl < 0) continue;
      let ny = Infinity, nu = 0;
      for (let j = p.start[cl]; j < p.start[cl + 1]; j++) if (p.ys[j] > y && p.ys[j] < ny) { ny = p.ys[j]; nu = p.ups[j]; }
      if (nu > 0) return true;
    }
    return false;
  }
}

/**
 * Player occupancy grid over the playable area: a cell is solid when static geometry fills it between knee and head
 * height above the ground. player.js queries it through a collider entry with a `blocked(x, z)` method.
 */
export class SolidGrid {
  constructor(bounds, cell = 0.5) {
    this.cell = cell;
    this.x0 = bounds.minX; this.z0 = bounds.minZ;
    this.nx = Math.ceil((bounds.maxX - bounds.minX) / cell) + 1;
    this.nz = Math.ceil((bounds.maxZ - bounds.minZ) / cell) + 1;
    this.bits = new Uint8Array(this.nx * this.nz);
  }

  /** mark the cells where `cols` (a Columns) has solid between ground + h0 .. ground + h1 */
  fromColumns(cols, ground, tag = null, heights = [0.4, 1.0, 1.6]) {
    const c = this.cell;
    let n = 0;
    for (const p of cols.parts) {
      if (tag && p.tag !== tag) continue;
      const ia = Math.max(0, Math.floor((p.minX - this.x0) / c)), ib = Math.min(this.nx - 1, Math.ceil((p.maxX - this.x0) / c));
      const ka = Math.max(0, Math.floor((p.minZ - this.z0) / c)), kb = Math.min(this.nz - 1, Math.ceil((p.maxZ - this.z0) / c));
      for (let k = ka; k <= kb; k++) for (let i = ia; i <= ib; i++) {
        const x = this.x0 + (i + 0.5) * c, z = this.z0 + (k + 0.5) * c, g = ground(x, z);
        if (heights.some((h) => cols.inside(x, g + h, z, p.tag))) { if (!this.bits[i + k * this.nx]) n++; this.bits[i + k * this.nx] = 1; }
      }
    }
    return n;
  }

  /** mark a disc as solid (deep water, big rocks) */
  disc(x, z, r) {
    const c = this.cell;
    for (let k = Math.floor((z - r - this.z0) / c); k <= Math.ceil((z + r - this.z0) / c); k++) {
      for (let i = Math.floor((x - r - this.x0) / c); i <= Math.ceil((x + r - this.x0) / c); i++) {
        if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) continue;
        if (Math.hypot(this.x0 + (i + 0.5) * c - x, this.z0 + (k + 0.5) * c - z) <= r) this.bits[i + k * this.nx] = 1;
      }
    }
  }

  /** mark the cell containing (x, z) as solid */
  mark(x, z) {
    const i = Math.floor((x - this.x0) / this.cell), k = Math.floor((z - this.z0) / this.cell);
    if (i >= 0 && k >= 0 && i < this.nx && k < this.nz) this.bits[i + k * this.nx] = 1;
  }

  solid(x, z) {
    const i = Math.floor((x - this.x0) / this.cell), k = Math.floor((z - this.z0) / this.cell);
    return i >= 0 && k >= 0 && i < this.nx && k < this.nz && this.bits[i + k * this.nx] === 1;
  }

  /** does a body of radius r at (x, z) overlap a solid cell? */
  blocked(x, z, r = 0.33) {
    if (this.solid(x, z)) return true;
    for (let a = 0; a < 8; a++) if (this.solid(x + Math.cos(a * 0.785) * r, z + Math.sin(a * 0.785) * r)) return true;
    return false;
  }
}
