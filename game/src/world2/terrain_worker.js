import { heightAt, masks, pathDist, riverDist } from './layout.js';
import { fillRows } from './terrain_rows.js';

/**
 * Web worker for TerrainData: evaluates layout.heightAt / masks for a band of grid rows.
 * message in : { id, kind: 'fine' | 'coarse', grid, j0, j1 }   (grid: x0, z0, step, nx, skip rectangle for coarse)
 * message out: { id, h: Float32Array, d: Uint8Array | null }   (buffers transferred)
 */
const L = { heightAt, masks, pathDist, riverDist };
self.onmessage = (e) => {
  const job = e.data;
  const out = fillRows(L, job);
  self.postMessage({ id: job.id, ...out }, [out.h.buffer, ...(out.d ? [out.d.buffer] : [])]);
};
