import * as THREE from 'three';
import { fbm, smoothstep } from './noise.js';

/**
 * "Ruined valley" open world layout (metres, three.js axes: +Y up, the start view looks down -Z).
 *
 *   foreground  flower meadow plateau (y ~ 8) with a flagstone path winding north past ruined stone gates,
 *               broken pillars and standing slabs; red maples at the edges, one overhanging the start
 *   left        a high grassy hill crowned by a ruined colonnade, more broken arches along its ridge
 *   middle      a river (water level 0) that leaves a waterfall basin at the foot of a cluster of layered cliff mesas,
 *               an arched aqueduct spanning two of them, waterfalls pouring off their lips
 *   right       a tall cliff carrying the ruined gothic castle, a waterfall dropping from its viaduct
 *   far         the snowy mountain massif (dominant pyramidal peak slightly left of centre) and side ranges
 *
 * Everything else (terrain, vegetation, water, prop placement) derives from these definitions.
 */

// towards the sun: upper left (cliff faces lit, as in the reference); low golden-hour sun (~16 deg): long soft shadows
export const SUN_DIR = new THREE.Vector3(-0.8, 0.255, -0.35).normalize();
export const WATER_Y = 0;
export const SPAWN = new THREE.Vector3(0, 0, 72);
export const BOUNDS = { minX: -230, maxX: 230, minZ: -250, maxZ: 112 };      // playable area
const RIM_W = 11;                                                           // width of the steep valley rim inside BOUNDS (m)
export const TERRAIN = { minX: -900, maxX: 900, minZ: -1100, maxZ: 420 };    // built terrain (outer part is backdrop)

const curve = (pts) => new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'catmullrom', 0.5);

// flagstone path from the start meadow down to the river ford
export const PATH = curve([[6, 100], [3, 90], [-1, 72], [-7, 52], [-4, 34], [5, 16], [3, -4], [-6, -24], [2, -46], [10, -62], [4, -78]]);
export const PATH_HALF = 1.9;

// river: from the waterfall basin under the cliffs, past the ford, away to the left
export const RIVER = curve([[57, -210], [56, -184], [40, -168], [22, -142], [8, -116], [6, -96], [-14, -86], [-52, -84], [-96, -92], [-140, -84], [-190, -96], [-260, -118], [-380, -150], [-560, -200]]);
export const riverHalf = (t) => 7 + 7 * t;                  // narrow at the basin, wider downstream
export const BASIN = { x: 57, z: -214, r: 18 };              // plunge pool filling Cliff_1's waterfall gorge and spreading out in front of it

// features
export const LEFT_HILL = { x: -165, z: -160, r: 95, h: 46 };
export const CLIFFS = [            // layered mesas (meshes from cliffs.glb), base sunk into the terrain
  { name: 'Cliff_0', x: -40, z: -262, rot: Math.PI, scale: 1.0 },          // waterfall notch faces the valley
  { name: 'Cliff_1', x: 52, z: -272, rot: Math.PI / 2, scale: 1.0, sink: 6.5 },   // waterfall notch -> the basin; sunk so the gorge's plunge hollow floods
  { name: 'Cliff_2', x: 150, z: -300, rot: 0.9, scale: 1.3 },
  { name: 'Cliff_3', x: 215, z: -205, rot: 2.2, scale: 1.15 },             // carries the castle
];
export const AQUEDUCT = { from: 'Cliff_0', to: 'Cliff_1' };
export const CASTLE_ON = 'Cliff_3';
// ruined arcades: on the left hill, and silhouetted along the far ridge behind the left cliffs (reference centre-left)
export const RIDGE = { x0: -210, x1: -30, z: -330, w: 45, h: 38 };
export const COLONNADES = [
  { name: 'Colonnade_A', x: -160, z: -165, rot: 0.25, scale: 1.0 },
  { name: 'Colonnade_B', x: -112, z: -128, rot: -0.35, scale: 1.0 },
  { name: 'Colonnade_A', x: -150, z: -330, rot: 0.08, scale: 1.8 },
  { name: 'Colonnade_B', x: -105, z: -338, rot: -0.12, scale: 1.7 },
  { name: 'Colonnade_A', x: -70, z: -326, rot: 0.15, scale: 1.6 },
  { name: 'Colonnade_B', x: -190, z: -322, rot: 0.3, scale: 1.5 },
];
// stone gateways (big framing gate at the left of the start view, like the reference)
export const GATES = [
  { name: 'Gate_A', x: -12, z: 66, rot: 0.2, scale: 1.7 },       // big frame at the left of the start view
  { name: 'Gate_B', x: -17, z: 58, rot: 0.1, scale: 1.45 },      // a second post pair behind it
  { name: 'Gate_B', x: -5, z: 30, rot: 0, scale: 1.45, onPath: true },   // straddles the path (snapped to it, faces along it)
  { name: 'Gate_C', x: 20, z: -2, rot: 0.6, scale: 1.1 },
  { name: 'Gate_A', x: -34, z: -40, rot: -0.3, scale: 1.1 },
  { name: 'Gate_B', x: 44, z: -58, rot: 0.8, scale: 1.1 },
  { name: 'Gate_C', x: -84, z: 18, rot: 1.2, scale: 1.15 },
];
// path gates straddle the path: centred on its nearest point, the opening (local +Z) along the path tangent
for (const g of GATES) {
  if (!g.onPath) continue;
  let best = null;
  for (let i = 0; i <= 600; i++) {
    const p = PATH.getPointAt(i / 600), d = Math.hypot(p.x - g.x, p.z - g.z);
    if (!best || d < best.d) best = { d, u: i / 600, p };
  }
  const tan = PATH.getTangentAt(best.u);
  g.x = best.p.x; g.z = best.p.z; g.rot = Math.atan2(tan.x, tan.z);
}
// big standing slabs placed by hand (right foreground of the start view)
export const HERO_SLABS = [
  { name: 'Slab_2', x: 12, z: 64, rot: 0.4, scale: 1.6 }, { name: 'Slab_1', x: 15, z: 60, rot: -0.3, scale: 1.4 },
  { name: 'Slab_0', x: 10, z: 57, rot: 0.9, scale: 1.3 },
];
export const MOUNTAINS = [          // far backdrop: the dominant peak ~3 km away, side ranges further out
  { name: 'Mountain_Main', x: -100, z: -3000, rot: 0.2, scale: 0.65 },
  { name: 'Mountain_Range_L', x: -2500, z: -3500, rot: 0.5, scale: 0.6 },
  { name: 'Mountain_Range_R', x: 2500, z: -3500, rot: -0.4, scale: 0.6 },
];

// ------------------------------------------------------------------ distance fields (2 m grid over the terrain)
const GRID = 2;
const GW = Math.round((TERRAIN.maxX - TERRAIN.minX) / GRID) + 1;
const GH = Math.round((TERRAIN.maxZ - TERRAIN.minZ) / GRID) + 1;

function distanceGrid(curveObj, samples, band) {
  const pts = curveObj.getSpacedPoints(samples);
  const dist = new Float32Array(GW * GH).fill(1e4);
  const param = new Float32Array(GW * GH);
  for (let s = 0; s < pts.length - 1; s++) {
    const a = pts[s], b = pts[s + 1];
    const x0 = Math.floor((Math.min(a.x, b.x) - band - TERRAIN.minX) / GRID), x1 = Math.ceil((Math.max(a.x, b.x) + band - TERRAIN.minX) / GRID);
    const z0 = Math.floor((Math.min(a.z, b.z) - band - TERRAIN.minZ) / GRID), z1 = Math.ceil((Math.max(a.z, b.z) + band - TERRAIN.minZ) / GRID);
    const abx = b.x - a.x, abz = b.z - a.z, L2 = abx * abx + abz * abz || 1;
    for (let gz = Math.max(0, z0); gz <= Math.min(GH - 1, z1); gz++) {
      const z = TERRAIN.minZ + gz * GRID;
      for (let gx = Math.max(0, x0); gx <= Math.min(GW - 1, x1); gx++) {
        const x = TERRAIN.minX + gx * GRID;
        const t = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / L2, 0, 1);
        const dx = x - (a.x + abx * t), dz = z - (a.z + abz * t);
        const d = Math.sqrt(dx * dx + dz * dz), k = gx + gz * GW;
        if (d < dist[k]) { dist[k] = d; param[k] = (s + t) / (pts.length - 1); }
      }
    }
  }
  return { dist, param };
}
function sampleGrid(g, x, z) {
  const fx = THREE.MathUtils.clamp((x - TERRAIN.minX) / GRID, 0, GW - 1.001), fz = THREE.MathUtils.clamp((z - TERRAIN.minZ) / GRID, 0, GH - 1.001);
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz, k = ix + iz * GW;
  const d = (g.dist[k] * (1 - tx) + g.dist[k + 1] * tx) * (1 - tz) + (g.dist[k + GW] * (1 - tx) + g.dist[k + GW + 1] * tx) * tz;
  return { d, t: g.param[k] };
}
const PATH_G = distanceGrid(PATH, 600, 40);
const RIVER_G = distanceGrid(RIVER, 1200, 90);

/** distance (xz) to the path centre line + path parameter 0..1 */
export const pathDist = (x, z) => sampleGrid(PATH_G, x, z);
/** distance to the river centre line, river parameter and local half width */
export function riverDist(x, z) {
  const r = sampleGrid(RIVER_G, x, z);
  return { d: r.d, t: r.t, half: riverHalf(r.t) };
}

// ------------------------------------------------------------------ height
const gauss = (x, z, c, r) => Math.exp(-((x - c.x) ** 2 + (z - c.z) ** 2) / (r * r));

/**
 * Levelled pads under the long / wide structures (colonnades, gates): the terrain blends to one constant height
 * over the footprint (+ margin) so the structure sits on flat ground instead of being buried on the uphill side.
 * {x, z, rot (three.js yaw), hx, hz (core half extents, m), edge (blend width, m), y (filled from the mean ground)}
 */
const PAD_SIZE = { Colonnade_A: [12.3, 2.3], Colonnade_B: [5.9, 2.3], Gate_A: [2.2, 0.5], Gate_B: [2.2, 0.5], Gate_C: [2.5, 2.1] };
const pad = (o, margin, edge) => ({ x: o.x, z: o.z, rot: o.rot, hx: PAD_SIZE[o.name][0] * o.scale + margin, hz: PAD_SIZE[o.name][1] * o.scale + margin, edge, y: null });
export const FLAT_PADS = [...COLONNADES.map((c) => pad(c, 1.5, 10)), ...GATES.map((g) => pad(g, 0.8, 4))];
/** 0..1 weight of a pad at (x, z) (1 on the core rectangle, smooth falloff over `edge`) */
function padWeight(p, x, z) {
  const dx = x - p.x, dz = z - p.z, c = Math.cos(p.rot), s = Math.sin(p.rot);
  const u = Math.abs(dx * c - dz * s) - p.hx, v = Math.abs(dx * s + dz * c) - p.hz;   // local x / z (three.js yaw)
  if (u > p.edge || v > p.edge) return 0;
  return 1 - smoothstep(0, p.edge, Math.hypot(Math.max(u, 0), Math.max(v, 0)));
}

function rawHeight(x, z) {
  const h = baseHeight(x, z);
  // overlapping pads: each pad's own core stays exactly level (sharp weighting), blends stay continuous
  let wMax = 0, sw = 0, sy = 0;
  for (const p of FLAT_PADS) {
    const w = padWeight(p, x, z);
    if (w <= 0) continue;
    const k = w ** 8;
    wMax = Math.max(wMax, w); sw += k; sy += k * p.y;
  }
  return wMax > 0 ? h + (sy / sw - h) * wMax : h;
}
for (const p of FLAT_PADS) {          // pad height: mean natural ground over the core
  let s = 0, n = 0;
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
    const lx = (i / 3) * p.hx, lz = (j / 3) * p.hz, c = Math.cos(p.rot), sn = Math.sin(p.rot);
    s += baseHeight(p.x + lx * c + lz * sn, p.z - lx * sn + lz * c); n++;
  }
  p.y = s / n;
}

function baseHeight(x, z) {
  // meadow plateau (south of the river), gently rolling; north bank rises towards the cliffs
  const south = smoothstep(-130, -70, z);
  const meadow = 7.5 + fbm(x * 0.012, z * 0.012, 4) * 4 + fbm(x * 0.05 + 3, z * 0.05, 3) * 0.7;
  const north = 3 + fbm(x * 0.01 + 11, z * 0.01, 4) * 6 + Math.max(0, -150 - z) * 0.08;
  let h = THREE.MathUtils.lerp(north, meadow, south);
  // left hill with the colonnade, high ground under the castle cliff, backdrop ridges framing the valley
  h += LEFT_HILL.h * gauss(x, z, LEFT_HILL, LEFT_HILL.r) * (0.85 + 0.3 * fbm(x * 0.02, z * 0.02, 3));
  h += 14 * gauss(x, z, { x: 200, z: -210 }, 90);
  // the cliffs rise from one connected rocky massif (not isolated mesas on a plain) + ridged foothills behind
  // a gentle, wide rise under the cliff group (the cliffs themselves carry the relief)
  for (const c of CLIFFS) h += 7 * gauss(x, z, c, 120);
  const farSide = smoothstep(-140, -200, z);
  h += farSide * 15 * (1 - Math.abs(fbm(x * 0.012 + 50, z * 0.012, 4)) * 1.6);
  // the far ridge carrying the arcade silhouettes
  h += RIDGE.h * Math.exp(-(((z - RIDGE.z) / RIDGE.w) ** 2)) * smoothstep(RIDGE.x0 - 60, RIDGE.x0, x) * smoothstep(RIDGE.x1 + 60, RIDGE.x1, x);
  h += Math.max(0, Math.abs(x) - 250) * 0.35 * (1 + fbm(x * 0.006, z * 0.006, 3));
  h += Math.max(0, z - 120) * 0.25 + Math.max(0, -300 - z) * 0.12 * (1 + fbm(x * 0.004, 5, 3));
  // the valley rim: the ground rises steeply (> the player's 45 deg slope limit) over the last metres inside the
  // playable bounds, so the edge of the world is a grassy bank rather than an invisible wall
  const e = Math.min(x - BOUNDS.minX, BOUNDS.maxX - x, z - BOUNDS.minZ, BOUNDS.maxZ - z);
  if (e < RIM_W) h += (13 + 3 * fbm(x * 0.02 + 70, z * 0.02 - 30, 3)) * smoothstep(RIM_W, 0, e);
  return h;
}

/** final ground height: raw terrain with the river channel, basin and a flattened path bed carved in */
export function heightAt(x, z) {
  let h = rawHeight(x, z);
  const r = riverDist(x, z);
  const bank = smoothstep(r.half, r.half + 22, r.d);
  const bed = WATER_Y - 2.2 * (1 - smoothstep(0, r.half, r.d)) - 0.4;
  h = THREE.MathUtils.lerp(bed, Math.max(h, WATER_Y + 0.6), bank);
  const bd = Math.hypot(x - BASIN.x, z - BASIN.z);
  if (bd < BASIN.r + 45) h = THREE.MathUtils.lerp(WATER_Y - 3, h, smoothstep(BASIN.r * 0.6, BASIN.r + 45, bd));   // long natural banks
  const p = pathDist(x, z);
  if (p.d < PATH_HALF + 3) {                             // path bed: slightly sunk and smoothed along the path
    const k = 1 - smoothstep(PATH_HALF, PATH_HALF + 3, p.d);
    h = THREE.MathUtils.lerp(h, h - 0.12, k);
  }
  return h;
}

/** 0..1 masks used by terrain shading and vegetation */
export function masks(x, z) {
  const p = pathDist(x, z), r = riverDist(x, z);
  return {
    path: 1 - smoothstep(PATH_HALF - 0.4, PATH_HALF + 0.8, p.d),
    pathEdge: 1 - smoothstep(PATH_HALF, PATH_HALF + 4, p.d),
    river: 1 - smoothstep(r.half, r.half + 3, r.d),
    riverBank: 1 - smoothstep(r.half, r.half + 14, r.d),
    // dense red flower fields: the meadow (south bank) and the left hill slopes, thinner near paths and water
    // drifts of red with real green gaps (reference), on the south meadow and the left hill; sparse beyond the river
    flowers: THREE.MathUtils.clamp(0.2 + fbm(x * 0.018 + 40, z * 0.018, 3) * 1.7, 0, 1) * smoothstep(PATH_HALF + 0.5, PATH_HALF + 5, p.d)
      * smoothstep(r.half + 2, r.half + 10, r.d)
      * Math.max(smoothstep(-125, -95, z), gauss(x, z, LEFT_HILL, LEFT_HILL.r * 1.1), 0.25),
  };
}

/** a ground position helper */
export const groundPoint = (x, z) => new THREE.Vector3(x, heightAt(x, z), z);
