/**
 * Row-band evaluation shared by TerrainData (main-thread fallback) and terrain_worker.js.
 * kind 'fine'  : height + RGB data (path distance, river distance, flower mask) per 1 m node
 * kind 'coarse': height only, nodes inside `skip` (the fine grid) are left at 0 and filled from the fine grid later
 */
export const PATH_RANGE = 16;            // dataTex.r encoding (m)
export const RIVER_MIN = -16, RIVER_RANGE = 64;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function fillRows(L, { kind, grid: g, j0, j1 }) {
  const rows = j1 - j0;
  const h = new Float32Array(rows * g.nx);
  const d = kind === 'fine' ? new Uint8Array(rows * g.nx * 4) : null;
  for (let j = j0; j < j1; j++) {
    const z = g.z0 + j * g.step;
    for (let i = 0; i < g.nx; i++) {
      const x = g.x0 + i * g.step, k = i + (j - j0) * g.nx;
      if (kind === 'coarse') {
        const s = g.skip;
        if (s && x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) continue;
        h[k] = L.heightAt(x, z);
        continue;
      }
      h[k] = L.heightAt(x, z);
      const p = L.pathDist(x, z), r = L.riverDist(x, z);
      d[k * 4] = Math.round(clamp01(p.d / PATH_RANGE) * 255);
      d[k * 4 + 1] = Math.round(clamp01((r.d - r.half - RIVER_MIN) / RIVER_RANGE) * 255);
      d[k * 4 + 2] = Math.round(L.masks(x, z).flowers * 255);
    }
  }
  return { h, d };
}
