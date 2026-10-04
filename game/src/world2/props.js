import * as THREE from 'three';
import { rng } from './noise.js';
import { heightAt, pathDist, riverDist, masks, CLIFFS, AQUEDUCT, CASTLE_ON, COLONNADES, GATES, HERO_SLABS, MOUNTAINS, LEFT_HILL, BOUNDS, SPAWN, BASIN, WATER_Y, PATH_HALF } from './layout.js';
import { surfaceMaterial } from './materials.js';
import { convertTree } from './foliage.js';
import { Columns, SolidGrid } from './solid.js';

/**
 * Places the Blender asset kits (public/models/world2/*.glb) according to the layout: cliffs (with their waterfalls),
 * the aqueduct between two of them, the castle on its cliff, colonnades on the left hill, stone gates along the path,
 * an instanced scatter of pillars / standing slabs / rubble / rocks, maple trees with leaf-card canopies and the far
 * mountains.
 *
 * Collision: small props are circles {x, z, r}; the big one-off structures (cliffs, aqueduct, colonnades) and the deep
 * plunge pool go into a 0.5 m occupancy grid (solid.js) built from their real geometry at player height, exposed to the
 * player as one collider entry with a `blocked(x, z, r)` method.
 */
const DIR = 'models/world2/';
const KITS = ['ruins_kit', 'colonnade', 'aqueduct', 'castle', 'cliffs', 'trees', 'mountains'];
// kits that ship a <kit>_lod.glb with `<name>_LOD` copies (lod_build.py), and which prototypes must have one. The big
// one-off structures (cliffs, castle, aqueduct, colonnades, mountains) intentionally have none: decimating them broke
// their silhouettes, so they always render at full detail.
const LOD_KITS = { ruins_kit: () => true, trees: () => true, cliffs: (n) => /^Rock_/.test(n) };
// switch distance (m) to the low-detail copy for individually placed props
const LOD_DIST = [['MapleTree', 45], ['MapleBranch', 30], ['Gate', 60]];
// instanced scatter: full detail within `near` m of the camera, the _LOD copy beyond; nothing beyond `far`
const SCATTER_DIST = [['Pillar', 16, 420], ['Slab', 14, 320], ['Block', 10, 160], ['PathStone', 7, 70], ['Rock', 16, 520]];
const SCATTER_SHADOW = 60;            // m, low-detail scatter within this distance still casts shadows (all directions)

export class Props2 {
  static async create(scene, loader, env, water) {
    const p = new Props2();
    await p.build(scene, loader, env, water);
    return p;
  }

  async build(scene, loader, env, water) {
    this.scene = scene;
    this.water = water;
    this.colliders = [];
    this.protos = {};
    this.cols = new Columns(0.5);        // column rasterisation of the big static meshes (waterfalls, plateau, solids)
    const load = (f) => loader.loadAsync(`${DIR}${f}.glb`).catch((e) => { console.warn(`world2: could not load ${f}.glb (${e?.message ?? e})`); return null; });
    const kits = await Promise.all(KITS.map((k) => load(k)));
    const lods = await Promise.all(KITS.map((k) => (LOD_KITS[k] ? load(`${k}_lod`) : null)));
    kits.forEach((g, i) => {
      if (!g) { console.warn('world2: missing kit', KITS[i]); return; }
      for (const o of g.scene.children) this.protos[o.name] = o;
      this.protos[`__kit_${KITS[i]}`] = g.scene;
      const l = lods[i];
      if (l) {
        for (const o of l.scene.children) this.protos[o.name] = o;
        this.protos[`__kit_${KITS[i]}_lod`] = l.scene;
      }
      const need = LOD_KITS[KITS[i]];
      if (need) {
        const missing = g.scene.children.map((o) => o.name).filter((n) => need(n) && !this.protos[`${n}_LOD`]);
        if (missing.length) console.warn(`world2: ${KITS[i]}_lod.glb ${l ? 'lacks' : 'missing ->'} low-detail copies for ${missing.join(', ')} (full detail used)`);
      }
    });
    this.applyMaterials();
    this.cliffs = this.placeCliffs();
    this.placeAqueduct();
    this.placeCastle();
    this.placeColonnades();
    this.placeGates();
    this.placeHeroSlabs();
    this.scatter();
    this.placeTrees();
    this.placeMountains();
    this.buildSolids();
  }

  /** swap the placeholder Blender materials for the textured surface materials */
  applyMaterials() {
    for (const k0 of KITS.flatMap((k) => [k, `${k}_lod`])) {
      const k = k0.replace(/_lod$/, '');
      const root = this.protos[`__kit_${k0}`];
      if (!root) continue;
      root.traverse((o) => {
        if (!o.isMesh) return;
        const n = o.material.name || '';
        if (/^Leaf/.test(n)) return;                                 // canopies -> leaf cards later
        let kind = 'stone';
        if (k === 'mountains') kind = 'mountain';
        else if (k === 'cliffs') kind = 'rock';
        else if (/Bark/.test(n)) kind = 'bark';
        else if (k === 'castle' || k === 'aqueduct' || k === 'colonnade') kind = 'masonry';
        o.material = surfaceMaterial(kind);
        o.castShadow = k !== 'mountains';
        o.receiveShadow = true;
      });
    }
  }

  proto(name) { return this.protos[name] ?? null; }

  /** clone a prototype into the scene at (x, y, z) with yaw / uniform scale; switches to its _LOD copy with distance */
  put(name, x, y, z, rot = 0, scale = 1) {
    const src = this.proto(name);
    if (!src) return null;
    const low = this.proto(`${name}_LOD`);
    let o = src.clone(true);
    if (low) {
      const lod = new THREE.LOD();
      lod.name = name;
      lod.addLevel(o, 0);
      lod.addLevel(low.clone(true), LOD_DIST.find(([p]) => name.startsWith(p))?.[1] ?? 80);
      o = lod;
    }
    o.position.set(x, y, z);
    o.rotation.set(0, rot, 0);
    o.scale.setScalar(scale);
    this.scene.add(o);
    o.updateMatrixWorld(true);
    return o;
  }

  /** lowest terrain height under a footprint (so props never float) */
  baseY(x, z, r) {
    let h = heightAt(x, z);
    for (let a = 0; a < 6; a++) h = Math.min(h, heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r));
    return h;
  }

  /** bounding box of a prototype's geometry around its own origin (identity transform), cached */
  localBox(name) {
    this._boxes ??= {};
    if (this._boxes[name]) return this._boxes[name];
    const c = this.proto(name).clone(true);
    c.position.set(0, 0, 0); c.rotation.set(0, 0, 0); c.scale.setScalar(1);
    c.updateMatrixWorld(true);
    return (this._boxes[name] = new THREE.Box3().setFromObject(c));
  }

  /** world xz samples over the oriented footprint of a prototype placed at (x, z, rot, scale) */
  footprint(name, x, z, rot, scale, n = 5) {
    const b = this.localBox(name), c = Math.cos(rot), s = Math.sin(rot), pts = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const lx = THREE.MathUtils.lerp(b.min.x, b.max.x, i / (n - 1)), lz = THREE.MathUtils.lerp(b.min.z, b.max.z, j / (n - 1));
      pts.push([x + (lx * c + lz * s) * scale, z + (-lx * s + lz * c) * scale]);
    }
    return pts;
  }

  /**
   * y that seats a prototype on the LOWEST ground under its whole footprint, sunk by `sink` m: nothing hangs over a
   * slope; on the uphill side the base is simply buried, like a real ruin settling into the hillside.
   */
  seatY(name, x, z, rot, scale, sink = 0.3, ground = heightAt) {
    let h = Infinity;
    for (const [px, pz] of this.footprint(name, x, z, rot, scale, 6)) h = Math.min(h, ground(px, pz));
    return h - sink - this.localBox(name).min.y * scale;
  }

  /** cliff top / ledge height at (x, z) below `below` from the column rasterisation (null if no cliff there) */
  cliffTop(x, z, below = Infinity, tag = null) { return this.cols.top(x, z, below, tag); }

  placeCliffs() {
    const out = {};
    for (const c of CLIFFS) {
      if (!this.proto(c.name)) continue;
      const o = this.put(c.name, c.x, this.seatY(c.name, c.x, c.z, c.rot, c.scale, c.sink ?? 1.5), c.z, c.rot, c.scale);
      out[c.name] = o;
      this.cols.add(o, c.name);                      // -> waterfalls, castle plateau, player solids (buildSolids)
    }
    // waterfalls at the notch markers, cascading down the visible cliff surface into the water / onto the ground
    this.fallInfo = [];
    for (const [name, o] of Object.entries(out)) {
      o.traverse((m) => {
        if (!/_Fall$/.test(m.name)) return;
        const lip = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
        const dir = new THREE.Vector3(lip.x - o.position.x, 0, lip.z - o.position.z).normalize();
        const notch = this.notch(name, lip, dir);
        lip.addScaledVector(notch.side, notch.offset);
        this.fallInfo.push({ cliff: name, notch: +notch.width.toFixed(1), segs: this.cascade(name, lip, dir, Math.min(14, Math.max(3, notch.width * 0.8))) });
      });
    }
    return out;
  }

  /** surface under (x, z) below height `below`: a cliff ledge if it stands above the ground there, else terrain / water */
  surfaceAt(tag, x, z, below = Infinity) {
    const t = this.cols.top(x, z, below, tag);
    const g = Math.max(heightAt(x, z), WATER_Y);
    return t != null && t > g + 0.3 ? { y: t, onCliff: true } : { y: g, onCliff: false };
  }

  /** the notch opening at a waterfall lip: free width between the rock walls rising above the lip, and its centre offset */
  notch(tag, lip, dir) {
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    let width = Infinity, offset = 0;
    for (const back of [0, -1.5, -3]) {
      const free = (sgn) => {
        for (let w = 0.25; w < 20; w += 0.25) {
          const x = lip.x + dir.x * back + side.x * w * sgn, z = lip.z + dir.z * back + side.z * w * sgn;
          const t = this.cols.top(x, z, Infinity, tag);
          if (t != null && t > lip.y + 1.0) return w;
        }
        return 20;
      };
      const l = free(-1), r = free(1);
      if (l + r < width) { width = l + r; offset = (r - l) / 2; }
    }
    return { side, width, offset };
  }

  /** free width of a falling sheet at (x, y, z) across `dir`: distance between the rock on either side (max 2 x 10 m) */
  freeSpan(tag, x, y, z, dir) {
    const span = (sgn) => {
      for (let w = 0.25; w < 10; w += 0.25) if (this.cols.inside(x - dir.z * w * sgn, y, z + dir.x * w * sgn, tag)) return w;
      return 10;
    };
    return span(-1) + span(1);
  }

  /**
   * Water runs out along `dir` from the lip. Where the rock in front rises above it, it pools and spills over the top;
   * where the surface drops away by more than 3 m it falls: a ballistic sheet (Water2's profile) with the reach
   * (<= what a sheet of that height can plausibly throw) that lands lowest while the whole sheet stays outside the rock.
   * It lands on a ledge (and cascades on) or, once clear of the cliff, in the water / on the ground, where the plunge
   * mist goes. Returns the segments for diagnostics.
   */
  cascade(tag, lip, dir, width) {
    const p = lip.clone(), segs = [];
    for (let seg = 0; seg < 8; seg++) {
      const q = p.clone();
      let edge = null;
      for (let step = 0; step < 160 && !edge; step++) {
        q.addScaledVector(dir, 0.5);
        if (this.cols.inside(q.x, p.y + 0.3, q.z, tag)) {             // rock ahead: pool behind it, spill over its top
          const t = this.cols.top(q.x, q.z, p.y + 14, tag);
          if (t == null || t < p.y) break;
          p.y = t;
          continue;
        }
        const s = this.surfaceAt(tag, q.x, q.z, p.y + 0.5);
        if (s.y < p.y - 3) edge = q.clone().addScaledVector(dir, -0.25);
        else p.y = Math.min(p.y, s.y + 0.05);                          // small steps: runs on down without a sheet
      }
      if (!edge) break;
      // candidate reaches: the sheet narrows to the gap it falls through, and must clear the rock at its centre and sides
      const drop0 = p.y - Math.max(heightAt(edge.x, edge.z), WATER_Y), Rmax = 1.5 + 0.12 * Math.max(drop0, 4);
      const cands = [];
      for (let R = 0.5; R <= Rmax; R += 0.25) {
        const L = edge.clone().addScaledVector(dir, R);
        const s = this.surfaceAt(tag, L.x, L.z, p.y - 0.5);
        const at = (v) => { const f = (0.72 * Math.sqrt(v) + 0.28 * v) * R; return [edge.x + dir.x * f, p.y - (p.y - s.y) * v, edge.z + dir.z * f]; };
        let w = width;
        for (const v of [0.25, 0.5, 0.75]) w = Math.min(w, 0.8 * this.freeSpan(tag, ...at(v), dir));
        if (w < Math.min(2.5, 0.4 * width)) continue;
        let ok = true;
        for (let v = 0.06; v < 0.97 && ok; v += 0.06) {
          const [cx, y, cz] = at(v);
          for (const k of v < 0.85 ? [-0.3, 0, 0.3] : [0]) {          // the sides may sink into the plunge hollow
            const x = cx - dir.z * k * w, z = cz + dir.x * k * w;
            if (this.cols.inside(x, y, z, tag) || y < heightAt(x, z) - 0.5) { ok = false; break; }
          }
        }
        if (ok) cands.push({ pt: L.clone().setY(s.y), onCliff: s.onCliff, R, w });
      }
      if (!cands.length) break;
      // land as low as it can, as close to the face as possible (within 1.5 m of the lowest landing)
      const lowest = Math.min(...cands.map((c) => c.pt.y));
      const land = cands.find((c) => c.pt.y < lowest + 1.5);
      const ground = Math.max(heightAt(land.pt.x, land.pt.z), WATER_Y);
      const final = !land.onCliff || land.pt.y - ground < 1.5;
      const w = land.w;
      const top = new THREE.Vector3(edge.x, p.y, edge.z);
      this.water?.addWaterfall?.({ top, bottom: land.pt.clone(), width: w });
      this.water?.addMist?.(land.pt.clone().setY(land.pt.y + (final ? 2 : 1.5)), final ? 13 : 6);
      segs.push({ top: top.toArray().map((v) => +v.toFixed(1)), bottom: land.pt.toArray().map((v) => +v.toFixed(1)), R: land.R, onCliff: land.onCliff, ground: +ground.toFixed(1), width: +w.toFixed(1) });
      if (final) break;
      p.copy(land.pt);
      width = w * 1.1;
    }
    return segs;
  }

  placeAqueduct() {
    const a = this.cliffs[AQUEDUCT.from], b = this.cliffs[AQUEDUCT.to];
    const seg = this.proto('Aqueduct_Seg');
    if (!a || !b || !seg) return;
    // span between the cliffs' facing sides, slightly in front of their centres (towards the viewer)
    const pa = a.position.clone().add(new THREE.Vector3(0, 0, 22)), pb = b.position.clone().add(new THREE.Vector3(0, 0, 22));
    const sbox = new THREE.Box3().setFromObject(seg);
    const segLen = sbox.max.x - sbox.min.x, segH = sbox.max.y - sbox.min.y;
    const dir = pb.clone().sub(pa); dir.y = 0;
    const L = dir.length(); dir.normalize();
    const yaw = Math.atan2(-dir.z, dir.x);
    // deck height: a bit below the lower cliff top
    const deck = Math.min(this.cliffTop(a.position.x, a.position.z, Infinity, AQUEDUCT.from) ?? 40, this.cliffTop(b.position.x, b.position.z, Infinity, AQUEDUCT.to) ?? 40) - 8;
    for (let s = segLen / 2; s < L - segLen / 2 + 1; s += segLen) {
      const x = pa.x + dir.x * s, z = pa.z + dir.z * s;
      let g = Infinity;
      for (const [px, pz] of this.footprint('Aqueduct_Seg', x, z, yaw, 1, 5)) g = Math.min(g, heightAt(px, pz));
      const sc = Math.max(1, (deck - g) / segH);
      const name = s + segLen > L - segLen / 2 + 1 && this.proto('Aqueduct_End') ? 'Aqueduct_End' : 'Aqueduct_Seg';
      const o = this.put(name, x, g - 1, z, yaw, 1);
      if (!o) continue;
      o.scale.set(1, sc, 1);
      o.updateMatrixWorld(true);
      this.cols.add(o, 'solid');                       // piers are solid, the arches stay walkable
    }
  }

  /** the castle sits on its cliff's top plateau: aligned with the plateau's long axis, scaled to fit, sunk in */
  placeCastle() {
    const cl = this.cliffs[CASTLE_ON];
    if (!cl || !this.proto('Castle_Ruin')) return;
    const wb = new THREE.Box3().setFromObject(cl);
    const pts = [];
    let maxTop = -Infinity;
    for (let x = wb.min.x; x <= wb.max.x; x += 2) for (let z = wb.min.z; z <= wb.max.z; z += 2) {
      const t = this.cliffTop(x, z, Infinity, CASTLE_ON);
      if (t != null) { pts.push([x, z, t]); maxTop = Math.max(maxTop, t); }
    }
    const plat = pts.filter((p) => p[2] > maxTop - 6);
    let mx = 0, mz = 0;
    for (const p of plat) { mx += p[0]; mz += p[1]; }
    mx /= plat.length; mz /= plat.length;
    let cxx = 0, cxz = 0, czz = 0;
    for (const p of plat) { const dx = p[0] - mx, dz = p[1] - mz; cxx += dx * dx; cxz += dx * dz; czz += dz * dz; }
    const th = 0.5 * Math.atan2(2 * cxz, cxx - czz), ax = Math.cos(th), az = Math.sin(th);
    let lo = Infinity, hi = -Infinity, wlo = Infinity, whi = -Infinity;
    for (const p of plat) {
      const u = (p[0] - mx) * ax + (p[1] - mz) * az, w = -(p[0] - mx) * az + (p[1] - mz) * ax;
      lo = Math.min(lo, u); hi = Math.max(hi, u); wlo = Math.min(wlo, w); whi = Math.max(whi, w);
    }
    const b = this.localBox('Castle_Ruin');
    const scale = Math.min(1, (0.9 * (hi - lo)) / (b.max.x - b.min.x), (0.9 * (whi - wlo)) / (b.max.z - b.min.z));
    const cx = mx + ax * (lo + hi) / 2 - az * (wlo + whi) / 2, cz = mz + az * (lo + hi) / 2 + ax * (wlo + whi) / 2;
    const rot = Math.atan2(-az, ax);
    const ground = (x, z) => Math.max(this.cliffTop(x, z, Infinity, CASTLE_ON) ?? -Infinity, maxTop - 5);   // the plateau, not the tiers below
    const y = this.seatY('Castle_Ruin', cx, cz, rot, scale, 2.0, ground);
    this.put('Castle_Ruin', cx, y, cz, rot, scale);
    // fallen masonry around its foot on the plateau
    const r = rng(9);
    this.rubble = [];
    for (let k = 0; k < 40; k++) {
      const p = plat[Math.floor(r() * plat.length)];
      this.rubble.push({ x: p[0] + (r() - 0.5) * 3, z: p[1] + (r() - 0.5) * 3, y: p[2], name: `Block_${Math.floor(r() * 5)}`, rot: r() * 6.28, scale: 0.8 + r() * 1.2 });
    }
    this.castleInfo = { scale: +scale.toFixed(2), plateau: [+(hi - lo).toFixed(1), +(whi - wlo).toFixed(1)] };
  }

  /** max / min burial of a placed prototype: ground minus its base over the footprint (positive = buried) */
  burial(name, x, y, z, rot, scale) {
    const base = y + this.localBox(name).min.y * scale;
    let lo = Infinity, hi = -Infinity;
    for (const [px, pz] of this.footprint(name, x, z, rot, scale, 7)) { const d = heightAt(px, pz) - base; lo = Math.min(lo, d); hi = Math.max(hi, d); }
    return [+hi.toFixed(2), +lo.toFixed(2)];
  }

  placeColonnades() {
    const r = rng(41);
    this.seatInfo = [];
    for (const c of COLONNADES) {
      // the terrain is levelled under each colonnade (layout FLAT_PADS), so it seats evenly
      const y = this.seatY(c.name, c.x, c.z, c.rot, c.scale, 0.3);
      const o = this.put(c.name, c.x, y, c.z, c.rot, c.scale);
      if (!o) continue;
      this.seatInfo.push([c.name, c.x, c.z, ...this.burial(c.name, c.x, y, c.z, c.rot, c.scale)]);
      // tumbled blocks along its foot
      for (let k = 0; k < 6; k++) (this.footRubble ??= []).push({ x: c.x + (r() - 0.5) * 20 * c.scale, z: c.z + (r() - 0.5) * 8 * c.scale, scale: c.scale });
      this.cols.add(o, 'solid');                       // columns solid, the gaps between them walkable
    }
  }

  placeHeroSlabs() {
    for (const h of HERO_SLABS) {
      const o = this.put(h.name, h.x, this.seatY(h.name, h.x, h.z, h.rot, h.scale, 0.3), h.z, h.rot, h.scale);
      if (o) this.colliders.push({ x: h.x, z: h.z, r: 0.6 * h.scale });
    }
  }

  /**
   * the solid parts of a prototype at player height (0.5 .. 1.8 m), from its own vertices: clustered on a 0.25 m grid
   * into posts; each post becomes one or more circles {x, z, r} in prototype space (long pieces -> a row of circles)
   */
  postCircles(name) {
    this._posts ??= {};
    if (this._posts[name]) return this._posts[name];
    const proto = this.proto(name), cell = 0.25, occ = new Map(), v = new THREE.Vector3();
    proto.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(proto.matrixWorld).invert();
    proto.traverse((m) => {
      if (!m.isMesh) return;
      const toProto = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld), pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(toProto);
        if (v.y < 0.5 || v.y > 1.8) continue;
        const key = `${Math.floor(v.x / cell)},${Math.floor(v.z / cell)}`;
        if (!occ.has(key)) occ.set(key, []);
        occ.get(key).push(v.x, v.z);
      }
    });
    const seen = new Set(), out = [];
    for (const key of occ.keys()) {
      if (seen.has(key)) continue;
      const stack = [key], pts = [];
      seen.add(key);
      while (stack.length) {
        const k = stack.pop();
        pts.push(...occ.get(k));
        const [i, j] = k.split(',').map(Number);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const nk = `${i + di},${j + dj}`;
          if (occ.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
        }
      }
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); z0 = Math.min(z0, pts[i + 1]); z1 = Math.max(z1, pts[i + 1]); }
      const w = x1 - x0, d = z1 - z0, r = Math.min(w, d) / 2 + 0.05, long = Math.max(w, d);
      const n = Math.max(1, Math.ceil(long / (2 * r)));
      for (let k = 0; k < n; k++) {
        const t = n === 1 ? 0.5 : (r + (k / (n - 1)) * (long - 2 * r)) / long;
        out.push(w >= d ? { x: x0 + t * w, z: (z0 + z1) / 2, r } : { x: (x0 + x1) / 2, z: z0 + t * d, r });
      }
    }
    return (this._posts[name] = out);
  }

  placeGates() {
    this.gateInfo = [];
    for (const g0 of GATES) {
      const g = { ...g0 }, posts = this.postCircles(g.name) ?? [];
      if (g.onPath && posts.length) {
        // big enough that the posts stand clear of the path (layout already centred it on the path, facing along it)
        const inner = Math.min(...posts.map((c) => Math.abs(c.x) - c.r));
        g.scale = Math.max(g.scale, (PATH_HALF + 0.3) / Math.max(inner, 0.1));
      }
      const y = this.seatY(g.name, g.x, g.z, g.rot, g.scale, 0.25);
      const o = this.put(g.name, g.x, y, g.z, g.rot, g.scale);
      if (!o) continue;
      const c = Math.cos(g.rot), s = Math.sin(g.rot);
      for (const p of posts) this.colliders.push({ x: g.x + (p.x * c + p.z * s) * g.scale, z: g.z + (-p.x * s + p.z * c) * g.scale, r: p.r * g.scale });
      this.gateInfo.push({ name: g.name, x: +g.x.toFixed(1), z: +g.z.toFixed(1), scale: +g.scale.toFixed(2), posts: posts.length, path: +pathDist(g.x, g.z).d.toFixed(2) });
    }
  }

  /** is (x, z) under / inside one of the big structures (cliff rock above the ground there)? */
  underStructure(x, z, r = 0) {
    for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      const t = this.cols.top(x + dx, z + dz);
      if (t != null && t > heightAt(x + dx, z + dz) + 0.2) return true;
    }
    return false;
  }

  /** collider radius for a scattered prototype from its footprint (0 when it is small enough to ignore) */
  scatterRadius(name, scale, min = 1.2) {
    const b = this.localBox(name), w = (b.max.x - b.min.x) * scale, d = (b.max.z - b.min.z) * scale;
    return Math.max(w, d) < min ? 0 : 0.45 * Math.min(w, d) + 0.1 * Math.max(w, d);
  }

  /** instanced scatter of pillars, standing slabs, rubble, loose path stones and rocks */
  scatter() {
    const r = rng(77);
    const lists = {};
    const add = (name, x, z, rot, scale, sink = 0.15, collide = 0) => {
      if (!this.proto(name)) return;
      if (this.underStructure(x, z, 0.6 * scale)) return;        // never inside / against a cliff, pier or colonnade
      (lists[name] ??= []).push({ x, y: this.baseY(x, z, 0.8 * scale) - sink * scale, z, rot, scale });
      if (collide) this.colliders.push({ x, z, r: collide * scale });
    };
    const inPlay = (x, z) => x > BOUNDS.minX + 5 && x < BOUNDS.maxX - 5 && z > BOUNDS.minZ + 5 && z < BOUNDS.maxZ - 5;
    const clear = (x, z, d = 4) => pathDist(x, z).d > d && riverDist(x, z).d > riverDist(x, z).half + 4 && Math.hypot(x - SPAWN.x, z - SPAWN.z) > 6;
    // standing slabs: many, loosely in groups across the meadow like old grave markers (as in the reference)
    for (let g = 0; g < 26; g++) {
      const cx = -150 + r() * 300, cz = -70 + r() * 175;
      const n = 2 + Math.floor(r() * 5);
      for (let k = 0; k < n; k++) {
        const x = cx + (r() - 0.5) * 14, z = cz + (r() - 0.5) * 14;
        if (!inPlay(x, z) || !clear(x, z)) continue;
        add(`Slab_${Math.floor(r() * 3)}`, x, z, r() * 6.28, 0.8 + r() * 0.6, 0.25, 0.45);
      }
    }
    for (let k = 0; k < 34; k++) {
      const x = -170 + r() * 340, z = -80 + r() * 185;
      if (!inPlay(x, z) || !clear(x, z, 6)) continue;
      add(`Pillar_${Math.floor(r() * 4)}`, x, z, r() * 6.28, 0.85 + r() * 0.4, 0.2, 0.55);
    }
    for (let k = 0; k < 90; k++) {
      const x = -180 + r() * 360, z = -90 + r() * 195;
      if (!inPlay(x, z) || !clear(x, z, 3)) continue;
      add(`Block_${Math.floor(r() * 5)}`, x, z, r() * 6.28, 0.7 + r() * 0.7, 0.3, 0);
    }
    // castle and colonnade rubble
    for (const rb of this.rubble ?? []) (lists[rb.name] ??= []).push({ x: rb.x, y: rb.y - 0.2 * rb.scale, z: rb.z, rot: rb.rot, scale: rb.scale });
    for (const fr of this.footRubble ?? []) add(`Block_${Math.floor(r() * 5)}`, fr.x, fr.z, r() * 6.28, (0.7 + r() * 0.8) * Math.min(fr.scale, 1.5), 0.3, 0);
    // loose flagstones along the path edges
    for (let k = 0; k < 220; k++) {
      const x = -40 + r() * 80, z = -85 + r() * 195;
      const pd = pathDist(x, z).d;
      if (pd < 2.2 || pd > 4.5) continue;
      add(`PathStone_${Math.floor(r() * 6)}`, x, z, r() * 6.28, 0.7 + r() * 0.5, 0.05, 0);
    }
    // rocks: river banks, the foot of the cliffs and the left hill; the big ones (> 1.2 m across) are solid
    this.bigRocks = 0;
    for (let k = 0; k < 160; k++) {
      const x = -260 + r() * 520, z = -300 + r() * 380;
      const rd = riverDist(x, z);
      const nearBank = rd.d > rd.half + 1 && rd.d < rd.half + 16;
      const nearCliff = CLIFFS.some((c) => Math.hypot(x - c.x, z - c.z) < 95);
      if (!(nearBank || nearCliff || r() < 0.08)) continue;
      const name = `Rock_${Math.floor(r() * 6)}`, rot = r() * 6.28, sc = 0.6 + r() * 2.2;
      const cr = this.proto(name) ? this.scatterRadius(name, sc) : 0;
      if (cr) this.bigRocks++;
      add(name, x, z, rot, sc, 0.35, cr / sc);
    }
    this.buildScatter(lists);
  }

  /**
   * Instanced scatter, culled per instance on the CPU every time the camera moves / turns (a few hundred sphere tests):
   * per prototype three InstancedMeshes —
   *   near  full detail, within the prototype's `near` distance (casts shadows)
   *   mid   the _LOD copy up to SCATTER_SHADOW m, in every direction so off-screen casters still shadow the view
   *   far   the _LOD copy beyond that, only instances inside the view frustum and nearer than the prototype's `far`
   *         distance, no shadows
   * Each mesh gets a bounding sphere around its live instances, so three's own frustum culling works on it too.
   */
  buildScatter(lists) {
    this.scatterSets = [];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const parts = (proto) => {
      const out = [];
      proto.updateMatrixWorld(true);
      proto.traverse((o) => {
        if (o.isMesh) out.push({ geometry: o.geometry, material: o.material, local: new THREE.Matrix4().copy(proto.matrixWorld).invert().multiply(o.matrixWorld) });
      });
      return out;
    };
    const mkIMs = (ps, n, shadow) => ps.map((p) => {
      const im = new THREE.InstancedMesh(p.geometry, p.material, n);
      im.count = 0;
      im.visible = false;
      im.castShadow = shadow;
      im.receiveShadow = true;
      im.boundingSphere = new THREE.Sphere();
      this.scene.add(im);
      return im;
    });
    for (const [name, list] of Object.entries(lists)) {
      const [, near, far] = SCATTER_DIST.find(([p]) => name.startsWith(p)) ?? [name, 20, 300];
      const nearParts = parts(this.proto(name)), farParts = parts(this.proto(`${name}_LOD`) ?? this.proto(name));
      const lb = this.localBox(name), c = lb.getCenter(new THREE.Vector3()), lr = lb.getSize(new THREE.Vector3()).length() / 2;
      for (const it of list) {
        it.m = m4.compose(pv.set(it.x, it.y, it.z), q.setFromAxisAngle(up, it.rot), sv.setScalar(it.scale)).clone();
        it.sphere = new THREE.Sphere(c.clone().applyMatrix4(it.m), lr * it.scale);
      }
      this.scatterSets.push({
        name, list, near, far, nearParts, farParts,
        near_: mkIMs(nearParts, list.length, true), mid_: mkIMs(farParts, list.length, true), far_: mkIMs(farParts, list.length, false),
      });
    }
    this.scatterCounts = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length]));
    this._cullCam = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    // cull with the camera that is actually rendering (before three projects the scene / renders the shadow maps)
    const prev = this.scene.onBeforeRender;
    this.scene.onBeforeRender = (renderer, scene, camera, ...rest) => {
      prev.call(scene, renderer, scene, camera, ...rest);
      if (camera.isPerspectiveCamera) this.cullScatter(camera);
    };
  }

  cullScatter(camera) {
    const e = camera.matrixWorld.elements, l = this._cullCam.elements;
    let moved = Math.hypot(e[12] - l[12], e[13] - l[13], e[14] - l[14]) > 0.5;
    if (!moved) for (let i = 0; i < 12; i++) if (Math.abs(e[i] - l[i]) > 0.015) { moved = true; break; }
    if (!moved) return;
    this._cullCam.copy(camera.matrixWorld);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cam = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld), m4 = new THREE.Matrix4();
    const stats = { near: 0, mid: 0, far: 0 };
    for (const set of this.scatterSets) {
      const groups = { near_: [], mid_: [], far_: [] };
      for (const it of set.list) {
        const d = it.sphere.center.distanceTo(cam) - it.sphere.radius;
        if (d < set.near) groups.near_.push(it);
        else if (d < SCATTER_SHADOW) groups.mid_.push(it);
        else if (d < set.far && frustum.intersectsSphere(it.sphere)) groups.far_.push(it);
      }
      for (const key of ['near_', 'mid_', 'far_']) {
        const its = groups[key], ps = key === 'near_' ? set.nearParts : set.farParts;
        set[key].forEach((im, k) => {
          its.forEach((it, i) => im.setMatrixAt(i, m4.copy(it.m).multiply(ps[k].local)));
          im.count = its.length;
          im.visible = its.length > 0;
          im.instanceMatrix.needsUpdate = true;
          if (its.length) {                                 // sphere around the live instances (three culls the mesh too)
            const b = new THREE.Box3();
            for (const it of its) b.expandByPoint(it.sphere.center);
            b.getBoundingSphere(im.boundingSphere);
            im.boundingSphere.radius += Math.max(...its.map((it) => it.sphere.radius));
          }
        });
        stats[key.slice(0, -1)] += its.length;
      }
    }
    this.scatterStats = stats;
  }

  /** per-frame hook (the scatter culls itself in scene.onBeforeRender) */
  update() {}

  placeTrees() {
    const names = ['MapleTree_0', 'MapleTree_1', 'MapleTree_2'].filter((n) => this.proto(n));
    if (!names.length) return;
    names.forEach((n, i) => {
      convertTree(this.proto(n), { budget: 2600, seed: 11 + i });
      if (this.proto(`${n}_LOD`)) convertTree(this.proto(`${n}_LOD`), { budget: 1900, seed: 11 + i });
    });
    if (this.proto('MapleBranch_Overhang')) convertTree(this.proto('MapleBranch_Overhang'), { budget: 1500, seed: 5 });
    if (this.proto('MapleBranch_Overhang_LOD')) convertTree(this.proto('MapleBranch_Overhang_LOD'), { budget: 900, seed: 5 });
    const r = rng(303);
    const spots = [];
    // framing trees near the start (one leans its crown over the path, like the reference foreground)
    spots.push({ x: -14, z: 74, n: 'MapleTree_2', s: 1.1, rot: 0.4 }, { x: 26, z: 96, n: 'MapleTree_0', s: 1.0, rot: 2.0 });
    // meadow edges, river banks, the left hill and around the ruins
    for (let k = 0; k < 120 && spots.length < 46; k++) {
      const x = -200 + r() * 400, z = -170 + r() * 280;
      const pd = pathDist(x, z).d, rd = riverDist(x, z);
      if (pd < 9 || rd.d < rd.half + 5 || Math.hypot(x - SPAWN.x, z - SPAWN.z) < 14) continue;
      const hill = Math.hypot(x - LEFT_HILL.x, z - LEFT_HILL.z) < LEFT_HILL.r * 0.9;
      const bank = rd.d < rd.half + 30;
      if (!(hill || bank || masks(x, z).flowers < 0.5 || r() < 0.25)) continue;
      if (spots.some((s2) => Math.hypot(s2.x - x, s2.z - z) < 12)) continue;
      if (this.underStructure(x, z, 2)) continue;
      spots.push({ x, z, n: names[Math.floor(r() * names.length)], s: 0.8 + r() * 0.5, rot: r() * 6.28 });
    }
    const placed = [];
    for (const sp of spots) {
      const o = this.put(sp.n, sp.x, this.baseY(sp.x, sp.z, 1) - 0.4, sp.z, sp.rot, sp.s);
      placed.push(o);
      if (o) this.colliders.push({ x: sp.x, z: sp.z, r: 0.6 * sp.s });
    }
    // a few trees on the cliff tops
    for (const [name, cl] of Object.entries(this.cliffs)) {
      if (name === CASTLE_ON) continue;
      for (let k = 0; k < 3; k++) {
        const x = cl.position.x + (r() - 0.5) * 50, z = cl.position.z + (r() - 0.5) * 50;
        const top = this.cliffTop(x, z, Infinity, name);
        if (top == null || top < cl.position.y + 15) continue;
        this.put(names[Math.floor(r() * names.length)], x, top - 0.5, z, r() * 6.28, 0.9 + r() * 0.4);
      }
    }
    // the overhanging branch grows out of the first framing tree's crown, reaching towards the start path
    const host = placed[0];
    if (host && this.proto('MapleBranch_Overhang')) {
      const base = host.localToWorld(new THREE.Vector3(0.5, 6.4, 0.4));
      const toPath = new THREE.Vector3(SPAWN.x - base.x, 0, SPAWN.z - 2 - base.z).normalize();
      this.put('MapleBranch_Overhang', base.x, base.y, base.z, Math.atan2(-toPath.z, toPath.x), 1.15);
    }
    this.treeCount = spots.length;
  }

  /**
   * The player's occupancy grid: the cliffs, aqueduct piers and colonnade columns rasterised at knee..head height,
   * plus the deep core of the plunge pool (the river itself stays wadeable).
   */
  buildSolids() {
    const t0 = performance.now();
    const ground = (x, z) => Math.max(heightAt(x, z), WATER_Y - 0.35);
    const grid = new SolidGrid(BOUNDS, 0.5);
    const n = grid.fromColumns(this.cols, ground);
    const R = BASIN.r + 14;
    let deep = 0;
    for (let z = BASIN.z - R + 0.25; z <= BASIN.z + R; z += 0.5) for (let x = BASIN.x - R + 0.25; x <= BASIN.x + R; x += 0.5) {
      if (Math.hypot(x - BASIN.x, z - BASIN.z) < R && heightAt(x, z) < WATER_Y - 1.3 && !grid.solid(x, z)) { grid.mark(x, z); deep++; }
    }
    this.solid = grid;
    this.colliders.push({ x: 1e9, z: 1e9, r: 0, blocked: (x, z, r) => grid.blocked(x, z, r) });
    this.solidInfo = { cells: n, deepCells: deep, ms: Math.round(performance.now() - t0) };
  }

  placeMountains() {
    for (const m of MOUNTAINS) {
      const o = this.put(m.name, m.x, -40, m.z, m.rot, m.scale);
      if (o) o.traverse((c) => { if (c.isMesh) { c.castShadow = false; c.receiveShadow = false; } });
    }
  }
}
