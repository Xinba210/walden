"""World2 nature kit: layered cliff mesas, boulders, red maple trees and snowy mountain massifs -> GLB.

  blender -b --factory-startup --python scripts/world2/nature_build.py -- [cliffs] [trees] [mountains]

Outputs to game/public/models/world2/{cliffs,trees,mountains}.glb (all three when no target is given).
Z-up metres in Blender, exported Y-up. Every mesh carries an RGBA `Col` attribute (active, exported as COLOR_0):
  cliffs / rocks : R = ambient occlusion, G = grass mask (flat tops / ledges), B = talus/scree mask
  trees          : RGB = canopy / bark AO (crowns: darker inside & under the canopy) - multiplied into leaf colour
  mountains      : R = ambient occlusion, G = snow mask, B = exposed-rock mask
UVs: world-scale box projection (cliffs/rocks 1 UV = 4 m, mountains 1 UV = 200 m); bark is cylindrical, 1 UV = 1 m.
Tree crowns use materials Leaf_Red / Leaf_Orange so game/src/world/foliage.js replaces them with leaf cards.
"""
import os
import sys
import math
import time
import importlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bpy
import bmesh
import numpy as np
from mathutils import Vector, Matrix
import nature_lib as L
importlib.reload(L)

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "game", "public", "models", "world2")
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
TARGETS = [a for a in ARGS if a in ("cliffs", "trees", "mountains")] or ["cliffs", "trees", "mountains"]

bpy.ops.wm.read_factory_settings(use_empty=True)
M = L.materials()
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:7.1f}s]", *a, flush=True)


# =====================================================================================================  CLIFFS
class Strata:
    """Horizontal sedimentary layering: per-layer thickness + hardness; hard beds protrude, soft beds recess and
    the wall steps back at soft beds (stepped ledges). Layer boundaries are gently warped / dipping."""

    def __init__(self, H, seed, retreat, caps=()):
        rs = np.random.RandomState(seed)
        z, tops, hard = -12.0, [], []
        while z < H + 12:
            r = rs.rand()
            t = rs.uniform(0.6, 2.0) if r < 0.62 else (rs.uniform(2.2, 4.5) if r < 0.93 else rs.uniform(5.5, 8.5))
            z += t
            tops.append(z)
            hard.append(rs.rand())
        self.tops = np.array(tops)
        self.bots = np.concatenate([[-12.0], self.tops[:-1]])
        self.hard = np.array(hard)
        # caprock: the bed(s) in the top ~5 m are hard and massive
        cap = (self.tops > H - 5.5)
        for hc in caps:
            cap |= (self.tops > hc - 5.0) & (self.bots < hc)
        self.hard[cap] = 0.95
        # setback happens in soft beds; normalise total retreat
        soft = np.clip(0.55 - self.hard, 0, None) * (self.tops - self.bots)
        soft[self.bots > H] = 0
        cum = np.cumsum(soft[::-1])[::-1]          # setback remaining above each bed
        self.setback = cum / max(cum[0], 1e-6) * retreat
        self.soft_w = soft
        self.H = H

    def __call__(self, zw, amp_mod):
        k = np.clip(np.searchsorted(self.tops, zw), 0, len(self.tops) - 1)
        b, t = self.bots[k], self.tops[k]
        u = np.clip((zw - b) / (t - b), 0, 1)
        h = self.hard[k]
        th = t - b
        # stepped retreat: within a soft bed, interpolate from its setback to the one above
        sb_here = self.setback[k]
        sb_above = np.where(k + 1 < len(self.setback), self.setback[np.minimum(k + 1, len(self.setback) - 1)], 0.0)
        step = sb_above + (sb_here - sb_above) * (1 - L.smoothstep(0.0, 1.0, u))
        # band profile
        edge = np.clip(0.35 / th, 0.04, 0.3)
        hardp = L.smoothstep(0, edge, u) * L.smoothstep(1, 1 - edge * 0.6, u)       # flat face, crisp top edge
        softp = -L.smoothstep(0.0, 0.25, u) * L.smoothstep(1.0, 0.7, u)              # notched recess band
        hard_amt = np.minimum(th, 3.0) * 0.55 * (0.4 + 1.2 * (h - 0.5))
        soft_amt = np.minimum(0.5 + 0.22 * th, 1.3) * (0.6 + 0.8 * (0.5 - h))
        band = np.where(h > 0.5, hardp * hard_amt, softp * soft_amt) * amp_mod
        cap = L.smoothstep(self.H - 7, self.H - 5, zw) * L.smoothstep(self.H + 2, self.H - 1, zw)
        return step + band + cap * 2.4 * np.clip(amp_mod, 0.5, 1.5)


def footprint_r(theta, R, seed, aspect=1.0):
    n = L.Noise(seed + 101)
    rs = np.random.RandomState(seed + 5)
    c, s = np.cos(theta), np.sin(theta)
    ell = R / np.sqrt(c * c / aspect + s * s * aspect)
    r = ell * (1 + 0.2 * n.fbm(c * 1.1, s * 1.1, 0.0, 3) + 0.08 * n.fbm(c * 3.5, s * 3.5, 7.7, 2) + 0.03 * n(c * 9, s * 9, 1.1))
    for k in range(rs.randint(3, 6)):                     # embayments / alcoves eroded into the mesa
        a, w, d = rs.uniform(0, 2 * np.pi), rs.uniform(0.07, 0.18), rs.uniform(0.07, 0.17)
        dd = np.angle(np.exp(1j * (theta - a)))
        r = r * (1 - d * np.exp(-(dd / w) ** 2))
    return r


def wall_r(theta, z, R, H, seed, aspect, taper=0.05):
    """Wall radius at (theta, z): footprint, slight taper, 2-3 big terrace set-backs (benches) varying around."""
    n = L.Noise(seed + 202)
    rs = np.random.RandomState(seed + 9)
    c, s = np.cos(theta), np.sin(theta)
    base = footprint_r(theta, R, seed, aspect)
    r = base * (1 + taper * (1 - np.clip(z / H, 0, 1)))
    for j in range(3):
        zj = H * rs.uniform(0.2, 0.72)
        amt = R * rs.uniform(0.06, 0.12) * np.clip(0.45 + 1.4 * n(c * 1.6, s * 1.6, j * 4.1), 0, 1.4)
        r = r - amt * L.smoothstep(zj - 1.2, zj + 1.2, z)
    wob = 0.025 * R * n.fbm(c * 2.0, s * 2.0, z / 25.0, 2)
    return r + wob


def loft(rings, cap_top=True, cap_bot=True):
    """rings: list of (N,3) arrays (bottom->top). Closed tube with ngon caps."""
    verts = np.concatenate(rings)
    n = len(rings[0])
    faces = []
    for j in range(len(rings) - 1):
        a, b = j * n, (j + 1) * n
        for k in range(n):
            faces.append((a + k, a + (k + 1) % n, b + (k + 1) % n, b + k))
    if cap_top:
        faces.append(tuple(range((len(rings) - 1) * n, len(rings) * n)))
    if cap_bot:
        faces.append(tuple(range(n - 1, -1, -1)))
    return verts, faces


def hull_block(center, size, rs, flat=0.75):
    pts = rs.normal(size=(16, 3)) * np.array([1.0, 0.8, flat]) * size * 0.5
    bm = bmesh.new()
    for p in pts:
        bm.verts.new(Vector(p + center))
    bmesh.ops.convex_hull(bm, input=bm.verts)
    return bm


def cliff(name, H, R, aspect, seed, falls=0, tier=True, voxel=0.42, budget=39000):
    """Mesa: lofted irregular footprint with terrace benches (+ optional stacked upper tier), boolean waterfall
    notches, talus apron + fallen blocks, voxel-remeshed then displaced by strata / joints / weathering noise."""
    log("cliff", name)
    rs = np.random.RandomState(seed)
    NT, NZ = 160, 28
    th = np.linspace(0, 2 * np.pi, NT, endpoint=False)
    Hb = H * 0.82 if tier else H                     # main plateau height (upper tier rises to H)
    zs = np.linspace(-4, Hb, NZ)
    rings = []
    for z in zs:
        r = wall_r(th, np.full(NT, z), R, H, seed, aspect)
        rings.append(np.stack([r * np.cos(th), r * np.sin(th), np.full(NT, z)], 1))
    v, f = loft(rings)
    body = L.link(name, L.mesh_from_np(name, v, f))
    fall_ang0 = rs.uniform(0, 2 * np.pi)

    # ---- waterfall notch(es): channel across the top + plunge groove down the face (boolean cut)
    fall_dirs = []
    if falls:
        for k in range(falls):
            a = fall_ang0 + k * 2.3
            fall_dirs.append(a)
            H_, H = H, Hb
            rr = float(wall_r(np.array([a]), np.array([H]), R, H_, seed, aspect)[0])
            d = np.array([math.cos(a), math.sin(a), 0.0])
            side = np.array([-d[1], d[0], 0.0])
            cutters = []
            w = rs.uniform(9.0, 11.0)
            # channel on top (slightly deeper toward the lip)
            for (r0, r1, zb0, zb1, ww) in ((rr - 34, rr - 10, H - 3.0, H - 5.5, w * 0.75), (rr - 11, rr + 12, H - 5.5, H - 7.5, w)):
                bm = bmesh.new()
                corners = []
                for rad, zb in ((r0, zb0), (r1, zb1)):
                    for s in (-1, 1):
                        for zz in (zb, H + 25):
                            corners.append(d * rad + side * s * ww / 2 + np.array([0, 0, zz]))
                for c in corners:
                    bm.verts.new(Vector(c))
                bmesh.ops.convex_hull(bm, input=bm.verts)
                cutters.append(bm)
            # plunge groove down the wall (narrowing downward)
            bm = bmesh.new()
            for rad, zz, ww in ((rr - 4.5, H + 25, w * 0.8), (rr - 1.5, -6, w * 0.45), (rr + 15, H + 25, w * 0.8), (rr + 15, -6, w * 0.45)):
                for s in (-1, 1):
                    bm.verts.new(Vector(d * rad + side * s * ww / 2 + np.array([0, 0, zz])))
            bmesh.ops.convex_hull(bm, input=bm.verts)
            cutters.append(bm)
            for i, bm in enumerate(cutters):
                me = bpy.data.meshes.new(f"_cut{i}")
                bm.to_mesh(me)
                bm.free()
                co = L.link(f"_cut{k}_{i}", me)
                mod = body.modifiers.new("cut", "BOOLEAN")
                mod.operation = "DIFFERENCE"
                mod.object = co
                mod.solver = "EXACT"
                L.apply_modifiers(body)
                bpy.data.objects.remove(co, do_unlink=True)
            H = H_

    # ---- talus apron + fallen blocks (joined, unioned by the voxel remesh)
    na = L.Noise(seed + 303)
    hs = H * (0.05 + 0.3 * np.clip(0.5 + 0.9 * na.fbm(np.cos(th) * 1.5, np.sin(th) * 1.5, 0.5, 3), 0, 1))
    for a in fall_dirs:                     # plunge pool side: talus lower near falls
        dd = np.abs(np.angle(np.exp(1j * (th - a))))
        hs = hs * (0.55 + 0.45 * L.smoothstep(0.05, 0.3, dd))
    r_in = wall_r(th, hs, R, H, seed, aspect) * 0.96
    r_out = wall_r(th, np.zeros(NT), R, H, seed, aspect) + hs * 1.25
    ring_b = np.stack([r_out * np.cos(th), r_out * np.sin(th), np.full(NT, -4.0)], 1)
    ring_g = np.stack([r_out * np.cos(th), r_out * np.sin(th), np.full(NT, -0.8)], 1)
    rm = 0.5 * (r_in + r_out) - hs * 0.08
    ring_m = np.stack([rm * np.cos(th), rm * np.sin(th), hs * 0.42], 1)
    ring_t = np.stack([r_in * np.cos(th), r_in * np.sin(th), hs], 1)
    v, f = loft([ring_b, ring_g, ring_m, ring_t])
    apron_me = L.mesh_from_np("_apron", v, f)
    bm_all = bmesh.new()
    bm_all.from_mesh(body.data)
    bm_all.from_mesh(apron_me)
    bpy.data.meshes.remove(apron_me)
    nblocks = int(12 + R / 2.5)
    for i in range(nblocks):
        a = rs.uniform(0, 2 * np.pi)
        t = rs.uniform(0.3, 1.15)
        ia = int(a / (2 * np.pi) * NT) % NT
        rr = r_in[ia] + (r_out[ia] - r_in[ia]) * t
        zz = hs[ia] * (1 - t) * 0.9
        sz = rs.uniform(1.5, 6.0) * rs.uniform(0.6, 1.0)
        tmp = bpy.data.meshes.new("_blk")
        hb = hull_block(np.array([rr * math.cos(a), rr * math.sin(a), zz]), sz, rs)
        hb.to_mesh(tmp)
        hb.free()
        bm_all.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    if tier:                                          # stacked upper tier, away from the waterfall side
        ta = fall_ang0 + np.pi + rs.uniform(-0.6, 0.6)
        tc = np.array([math.cos(ta), math.sin(ta)]) * R * rs.uniform(0.25, 0.4)
        Rt = R * rs.uniform(0.42, 0.55)
        trings = []
        for z in np.linspace(Hb - 5, H, 10):
            r = footprint_r(th, Rt, seed + 50, 1.15) * (1 + 0.04 * (H - z) / (H - Hb + 5))
            trings.append(np.stack([tc[0] + r * np.cos(th), tc[1] + r * np.sin(th), np.full(NT, z)], 1))
        v, f = loft(trings)
        tme = L.mesh_from_np("_tier", v, f)
        bm_all.from_mesh(tme)
        bpy.data.meshes.remove(tme)
    bm_all.to_mesh(body.data)
    bm_all.free()

    L.remesh(body, voxel)
    me = body.data
    log("  remeshed verts", len(me.vertices))

    # ---- displacement
    co = L.get_co(me)
    nrm = L.smooth_normals(me, 8)
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    th_v = np.arctan2(y, x)
    rv = np.hypot(x, y)
    rw = wall_r(th_v, z, R, H, seed, aspect)
    apron = L.smoothstep(0.4, 2.0, rv - rw) * L.smoothstep(H * 0.45, H * 0.25, z)
    nz = nrm[:, 2]
    wall_w = L.smoothstep(0.82, 0.45, nz)
    top_w = L.smoothstep(0.55, 0.85, nz) * L.smoothstep(Hb - 12, Hb - 6, z)
    nh = nrm[:, :2] / np.maximum(np.linalg.norm(nrm[:, :2], axis=1, keepdims=True), 1e-6)

    n1, n2, n3 = L.Noise(seed + 1), L.Noise(seed + 2), L.Noise(seed + 3)
    zw = z + 1.4 * n1.fbm(x / 90, y / 90, 0.3, 2) + 0.012 * x - 0.008 * y + 0.18 * n2(x / 5, y / 5, z / 5)
    # joint blocks: vertically elongated Voronoi columns
    jx = x + 1.6 * n2(x / 20, y / 20, z / 14)          # joints: near-vertical, slightly wavy
    jy = y + 1.6 * n3(x / 20, y / 20, z / 14 + 5)
    F1, F2, rid = L.voronoi(np.stack([jx / 12.0, jy / 12.0, z / 300.0], 1), seed + 11)
    G1, G2, gid = L.voronoi(np.stack([jx / 30.0, jy / 30.0, z / 900.0], 1), seed + 12)
    amp_mod = np.clip(0.65 + 0.8 * n3.fbm(x / 30, y / 30, zw / 9, 2) + 0.35 * (rid - 0.5), 0.15, 1.5)
    strata = Strata(H, seed + 5, retreat=0.1 * R, caps=(Hb,) if tier else ())
    D = strata(zw, amp_mod)
    D -= (rid ** 1.6) * 0.8                                                    # blocky joint facets
    D -= L.smoothstep(0.08, 0.0, F2 - F1) * 1.1                                # joint cracks
    D -= L.smoothstep(0.09, 0.0, G2 - G1) * 3.2 * L.smoothstep(0.3, 0.7, gid)  # deep clefts / chimneys
    D -= (gid ** 2) * 1.2
    D += 0.30 * n1.fbm(x / 2.6, y / 2.6, z / 2.6, 3)
    D += 0.22 * n2(x / 4, y / 4, z / 0.7)                                       # fine laminations
    D -= 0.25 * n3.ridged(x / 6, y / 6, z / 3, 3)
    wall_disp = (D * wall_w * (1 - apron))[:, None] * np.concatenate([nh, np.zeros((len(co), 1))], 1)

    # top: gentle undulating plateau, drop toward rim channels done by the boolean
    top_d = (0.9 * n1.fbm(x / 30, y / 30, 1.7, 3) + 0.25 * n2.fbm(x / 5, y / 5, 2.2, 2) - 0.15 * (rid ** 2)) * top_w
    # talus: lumpy scree, coarse block noise
    P1, P2, pid = L.voronoi(np.stack([x / 2.2, y / 2.2, z / 2.2], 1), seed + 21)
    scree = (0.55 - P1) * 0.9 + 0.35 * n2.fbm(x / 6, y / 6, z / 6, 3) + 0.25 * pid
    disp = wall_disp + (nrm * (scree * apron)[:, None]) + np.stack([np.zeros_like(z), np.zeros_like(z), top_d], 1)
    co = co + disp
    L.set_co(me, co)
    L.laplacian_relax(me, 1, 0.25)
    log("  displaced")

    L.decimate(body, budget)
    L.shade(me := body.data, 50)
    log("  decimated tris", L.tri_count(me))

    # ---- vertex colours
    co = L.get_co(me)
    nrm = L.get_vnormals(me)
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    rv = np.hypot(x, y)
    rw = wall_r(np.arctan2(y, x), z, R, H, seed, aspect)
    apron = L.smoothstep(0.5, 3.0, rv - rw) * L.smoothstep(H * 0.5, H * 0.3, z)
    ao = L.ray_ao(body, rays=14, dist=9.0, bias=0.05)
    ao = np.clip(ao * (0.75 + 0.25 * L.smoothstep(-2, 6, z)), 0, 1)
    gn = L.Noise(seed + 77)
    patch = L.smoothstep(-0.25, 0.25, gn.fbm(x / 7, y / 7, z / 7, 3))
    top = L.smoothstep(0.72, 0.9, nrm[:, 2]) * L.smoothstep(Hb - 12, Hb - 5, z)
    ledge = L.smoothstep(0.8, 0.95, nrm[:, 2]) * patch * 0.85 * (1 - apron)
    base = L.smoothstep(0.86, 0.97, nrm[:, 2]) * apron * patch * 0.7
    grass = np.clip(np.maximum(top * (0.75 + 0.25 * patch), np.maximum(ledge, base)), 0, 1)
    L.set_col(me, np.stack([ao, grass, apron, np.ones_like(ao)], 1))
    L.box_uv(me, 4.0)
    me.materials.clear()
    me.materials.append(M["rock"])
    me.polygons.foreach_set("material_index", np.zeros(len(me.polygons), np.int32))

    # ---- fall markers: walk outward along the channel axis, the lip is the last point still on the plateau
    from mathutils.bvhtree import BVHTree
    bvh = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())
    for k, a in enumerate(fall_dirs):
        d = Vector((math.cos(a), math.sin(a), 0))
        lip, prev = None, None
        for rad in np.arange(R * 0.3, R * 2.5, 0.2):
            hit = bvh.ray_cast(Vector((0, 0, H + 40)) + d * rad, Vector((0, 0, -1)), 200)
            if hit[0] is None or hit[0].z < Hb - 14 or (prev is not None and hit[0].z < prev - 2.5):
                break
            lip = prev = hit[0]
            prev = hit[0].z
        e = bpy.data.objects.new(f"{name}_Fall" if k == 0 else f"{name}_Fall{k}", None)
        e.empty_display_type = "ARROWS"
        e.empty_display_size = 3
        e.location = lip
        e.rotation_euler = (0, 0, a)                           # local +X points out over the edge (flow direction)
        e.parent = body
        bpy.context.scene.collection.objects.link(e)
        log("  fall marker", e.name, tuple(round(c, 2) for c in lip))
    return body


def rock(name, size, seed, budget=3900):
    """Fractured, eroded boulder ~`size` m across: convex-hull block with a flat bedding base, bedding grooves,
    a few through-going fractures with chipped (offset) facets, and eroded fbm / ridged weathering."""
    log("rock", name)
    rs = np.random.RandomState(seed)
    flat = rs.uniform(0.6, 0.85)
    pts = rs.normal(size=(13, 3))
    pts /= np.linalg.norm(pts, axis=1, keepdims=True)
    pts *= rs.uniform(0.6, 1.0, (13, 1))
    pts *= np.array([1.0, rs.uniform(0.7, 0.95), flat])
    if rs.rand() < 0.7:                                   # fresh fracture plane: slice one side flat
        nrm_c = rs.normal(size=3); nrm_c[2] *= 0.3; nrm_c /= np.linalg.norm(nrm_c)
        dist = pts @ nrm_c
        lim = np.percentile(dist, 70)
        pts -= np.maximum(dist - lim, 0)[:, None] * nrm_c
    pts[:, 2] = np.maximum(pts[:, 2], -0.3)
    ext = np.ptp(pts[:, :2], axis=0).max()
    pts *= size / ext
    bm = bmesh.new()
    for p in pts:
        bm.verts.new(Vector(p))
    bmesh.ops.convex_hull(bm, input=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = L.link(name, me)
    L.remesh(o, size / 60)
    me = o.data
    co = L.get_co(me)
    nrm = L.smooth_normals(me, 3)
    x, y, z = co.T / size
    n1, n2, n3 = L.Noise(seed + 1), L.Noise(seed + 2), L.Noise(seed + 3)
    tilt = 0.18 * x + 0.07 * y
    zw = (z + tilt) / 0.075 + 0.5 * n1(x * 2, y * 2, z * 2)
    band = (np.abs(((zw % 1.0) - 0.5)) * 2) ** 4                         # thin bedding grooves
    F1, F2, rid = L.voronoi(np.stack([x / 0.42, y / 0.42, z / 0.6], 1) + n3.fbm(x, y, z, 2)[:, None] * 0.15, seed + 5)
    D = -0.018 * band * (0.5 + n2(x * 3, y * 3, z * 3))
    D -= L.smoothstep(0.035, 0.0, F2 - F1) * 0.022                        # fractures
    D -= 0.045 * rid ** 1.5                                               # chipped facets
    D += 0.03 * n1.fbm(x * 2.5, y * 2.5, z * 2.5, 4)
    D -= 0.022 * n2.ridged(x * 5, y * 5, z * 5, 3)
    co = co + nrm * (D * size)[:, None]
    hgt = np.ptp(co[:, 2])
    co[:, 2] -= co[:, 2].min() + 0.12 * hgt
    co[:, :2] -= 0.5 * (co[:, :2].min(0) + co[:, :2].max(0))
    L.set_co(me, co)
    L.decimate(o, budget)
    L.shade(o.data, 50)
    me = o.data
    co = L.get_co(me)
    nrm = L.get_vnormals(me)
    hgt = np.ptp(co[:, 2])
    ao = L.ray_ao(o, rays=12, dist=size * 0.8, bias=size * 0.003)
    ao *= 0.55 + 0.45 * L.smoothstep(-0.05 * hgt, 0.35 * hgt, co[:, 2])
    moss = L.smoothstep(0.65, 0.9, nrm[:, 2]) * L.smoothstep(-0.2, 0.3, n1.fbm(*(co.T / size * 3), 2))
    L.set_col(me, np.stack([ao, moss * 0.8, np.zeros_like(ao), np.ones_like(ao)], 1))
    L.box_uv(me, 4.0)
    me.materials.append(M["rock"])
    return o


def build_cliffs():
    objs = [
        cliff("Cliff_0", 46, 34, 1.15, 11, falls=1, tier=False),
        cliff("Cliff_1", 68, 46, 1.25, 23, falls=1),
        cliff("Cliff_2", 32, 21, 1.0, 37, tier=False),
        cliff("Cliff_3", 56, 40, 1.6, 41),
    ]
    for i, s in enumerate((1.0, 1.6, 2.4, 3.3, 4.5, 6.0)):
        objs.append(rock(f"Rock_{i}", s, 300 + i * 7))
    # lay out side by side (positions only matter for previews; game instantiates prototypes by name)
    for o in objs:
        o.location = (0, 0, 0)
    L.export_glb(os.path.join(OUT_DIR, "cliffs.glb"), objs)
    log("exported cliffs.glb")


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    if "cliffs" in TARGETS:
        build_cliffs()
        L.clear_scene()
    if "trees" in TARGETS:
        import nature_trees
        importlib.reload(nature_trees)
        nature_trees.build(L, M, OUT_DIR, log)
        L.clear_scene()
    if "mountains" in TARGETS:
        import nature_mountains
        importlib.reload(nature_mountains)
        nature_mountains.build(L, M, OUT_DIR, log)
