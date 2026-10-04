"""Red / autumn maple trees for the world2 kit (imported by nature_build.py).

Skeleton growth (gnarled trunk with root flare, 4-8 main limbs, secondary + tertiary branches) -> overlapping tubes ->
voxel-remesh union (smooth crotches) -> bark displacement in branch-local coordinates (spiralling furrows + burls) ->
decimate. UVs are cylindrical per branch: v = arclength from the root (metres), u = angle * branch radius (metres),
so 1 UV unit = 1 m of bark. Crowns: 5-12 lumpy cauliflower blobs clustered around branch tips, unioned + decimated,
material Leaf_Red / Leaf_Orange (guide volumes for foliage.js), baked canopy AO in Col.
"""
import math
import numpy as np
import bpy
import bmesh
from mathutils import Vector
from mathutils.kdtree import KDTree


class Branch:
    def __init__(self, pts, rad, s0, level, parent=None):
        self.pts = np.asarray(pts)
        self.rad = np.asarray(rad)
        seg = np.linalg.norm(np.diff(self.pts, axis=0), axis=1)
        self.s = s0 + np.concatenate([[0], np.cumsum(seg)])
        self.level = level
        self.parent = parent
        self.length = float(self.s[-1] - self.s[0])


def grow(p0, d0, length, r0, r1, level, s0, rs, up=0.0, gnarl=0.35, droop=0.0, step=0.2, taper=1.1, out=None):
    n = max(4, int(length / step))
    seg = length / n
    d = np.asarray(d0, float)
    d /= np.linalg.norm(d)
    kink = np.zeros(3)
    pts = [np.asarray(p0, float)]
    for i in range(n):
        kink = 0.75 * kink + 0.25 * rs.normal(0, 1, 3)
        d = d + kink * gnarl * seg + np.array([0, 0, up - droop]) * seg
        if out is not None:
            d = d + out * seg * 0.15
        d /= np.linalg.norm(d)
        pts.append(pts[-1] + d * seg)
    t = np.linspace(0, 1, n + 1)
    rad = r1 + (r0 - r1) * (1 - t) ** taper
    return Branch(pts, rad, s0, level)


def frames(pts):
    """Parallel-transport frames along a polyline: tangents, normals, binormals."""
    T = np.gradient(pts, axis=0)
    T /= np.linalg.norm(T, axis=1, keepdims=True)
    N = np.zeros_like(T)
    ref = np.array([0, 0, 1.0]) if abs(T[0, 2]) < 0.9 else np.array([1.0, 0, 0])
    n = np.cross(T[0], ref)
    n /= np.linalg.norm(n)
    for i in range(len(T)):
        n = n - T[i] * np.dot(n, T[i])
        n /= np.linalg.norm(n)
        N[i] = n
    B = np.cross(T, N)
    return T, N, B


def rotate_about(v, axis, ang):
    axis = axis / np.linalg.norm(axis)
    return v * math.cos(ang) + np.cross(axis, v) * math.sin(ang) + axis * np.dot(axis, v) * (1 - math.cos(ang))


def tube_mesh(branches, flare=None):
    verts, faces = [], []
    for b in branches:
        T, N, B = frames(b.pts)
        rmax = b.rad.max()
        ns = int(np.clip(2 * math.pi * rmax / 0.06, 7, 22))
        ang = np.linspace(0, 2 * math.pi, ns, endpoint=False)
        base = len(verts)
        for i, p in enumerate(b.pts):
            r = b.rad[i]
            if flare is not None and b.level == 0:
                r = r * flare(p[2])
            for a in ang:
                verts.append(p + (N[i] * math.cos(a) + B[i] * math.sin(a)) * r)
        K = len(b.pts)
        for i in range(K - 1):
            for j in range(ns):
                a0, a1 = base + i * ns + j, base + i * ns + (j + 1) % ns
                faces.append((a0, a1, a1 + ns, a0 + ns))
        # caps
        c0 = len(verts)
        verts.append(b.pts[0] - T[0] * b.rad[0] * 0.3)
        c1 = len(verts)
        verts.append(b.pts[-1] + T[-1] * b.rad[-1] * 0.6)
        for j in range(ns):
            faces.append((base + (j + 1) % ns, base + j, c0))
            e = base + (K - 1) * ns
            faces.append((e + j, e + (j + 1) % ns, c1))
    return np.array(verts), faces


class Skeleton:
    """KD lookup of densely sampled skeleton points -> branch id, arclength, radius, local frame."""

    def __init__(self, branches):
        P, S, R, T, N, Bn, BI = [], [], [], [], [], [], []
        for bi, b in enumerate(branches):
            t, n, bb = frames(b.pts)
            # densify
            m = max(2, int(b.length / 0.05))
            u = np.linspace(0, len(b.pts) - 1, m)
            i0 = np.clip(np.floor(u).astype(int), 0, len(b.pts) - 2)
            f = (u - i0)[:, None]
            lerp = lambda a: a[i0] * (1 - f) + a[i0 + 1] * f
            P.append(lerp(b.pts)); S.append(lerp(b.s[:, None])[:, 0]); R.append(lerp(b.rad[:, None])[:, 0])
            T.append(lerp(t)); N.append(lerp(n)); Bn.append(lerp(bb)); BI.append(np.full(m, bi))
        self.P, self.S, self.R = np.concatenate(P), np.concatenate(S), np.concatenate(R)
        self.T, self.N, self.B, self.BI = np.concatenate(T), np.concatenate(N), np.concatenate(Bn), np.concatenate(BI)
        self.kd = KDTree(len(self.P))
        for i, p in enumerate(self.P):
            self.kd.insert(Vector(p), i)
        self.kd.balance()
        self.per = {}
        for bi in np.unique(self.BI):
            idx = np.nonzero(self.BI == bi)[0]
            kd = KDTree(len(idx))
            for j, i in enumerate(idx):
                kd.insert(Vector(self.P[i]), int(i))
            kd.balance()
            self.per[int(bi)] = kd

    def nearest(self, co, branch=None):
        """Nearest sample index for each point (surface distance: |p - axis| - r)."""
        out = np.empty(len(co), np.int64)
        for k, p in enumerate(co):
            kd = self.kd if branch is None else self.per[int(branch[k])]
            best, bd = None, 1e9
            for (_, i, dist) in kd.find_n(Vector(p), 6):
                dd = dist - self.R[i]
                if dd < bd:
                    best, bd = i, dd
            out[k] = best
        return out

    def local(self, co, idx):
        d = co - self.P[idx]
        along = np.einsum("ij,ij->i", d, self.T[idx])
        d = d - self.T[idx] * along[:, None]
        theta = np.arctan2(np.einsum("ij,ij->i", d, self.B[idx]), np.einsum("ij,ij->i", d, self.N[idx]))
        return theta, self.S[idx] + along, self.R[idx]


def maple_skeleton(H, seed, n_limbs, spread=1.0):
    rs = np.random.RandomState(seed)
    branches = []
    fork_h = H * rs.uniform(0.26, 0.34)
    rb = 0.036 * H + 0.1
    lean = rs.normal(0, 0.12, 2)
    trunk = grow((0, 0, -0.5), (lean[0], lean[1], 1), fork_h + 0.5, rb, rb * 0.72, 0, 0.0, rs, gnarl=0.5, step=0.15, taper=0.8)
    branches.append(trunk)
    # roots / buttresses
    nr = rs.randint(5, 8)
    for k in range(nr):
        a = k * 2 * math.pi / nr + rs.uniform(-0.3, 0.3)
        p0 = trunk.pts[0] + np.array([0, 0, 0.5 + rs.uniform(0.3, 0.9)])
        r = grow(p0, (math.cos(a), math.sin(a), -0.55), rs.uniform(1.4, 2.4), rb * rs.uniform(0.45, 0.6), 0.06, 0, 0.0, rs,
                 gnarl=0.6, droop=0.25, step=0.12, taper=0.7)
        branches.append(r)
    top = trunk.pts[-1]
    rf = trunk.rad[-1]
    a0 = rs.uniform(0, 2 * math.pi)
    tips = []
    for k in range(n_limbs):
        a = a0 + k * 2 * math.pi / n_limbs + rs.uniform(-0.35, 0.35)
        el = math.radians(rs.uniform(38, 66))
        d = np.array([math.sin(el) * math.cos(a), math.sin(el) * math.sin(a), math.cos(el)])
        start_i = len(trunk.pts) - 1 - rs.randint(0, 4)
        p0 = trunk.pts[start_i]
        L = (H - fork_h) * rs.uniform(0.72, 0.95) * spread
        r0 = rf * rs.uniform(0.5, 0.7)
        limb = grow(p0, d, L, r0, 0.05, 1, trunk.s[start_i], rs, up=0.12, gnarl=0.55, step=0.18, taper=1.0)
        branches.append(limb)
        tips.append(limb.pts[-1])
        outward = np.array([math.cos(a), math.sin(a), 0])
        nsec = rs.randint(3, 6)
        for j in range(nsec):
            t = rs.uniform(0.4, 0.95)
            i = int(t * (len(limb.pts) - 1))
            T = limb.pts[min(i + 1, len(limb.pts) - 1)] - limb.pts[max(i - 1, 0)]
            T /= np.linalg.norm(T)
            side = np.cross(T, rs.normal(0, 1, 3))
            side /= np.linalg.norm(side)
            dd = rotate_about(T, side, math.radians(rs.uniform(35, 65)))
            dd = dd + outward * 0.3 + np.array([0, 0, 0.15])
            Ls = L * rs.uniform(0.32, 0.52) * (1.1 - 0.4 * t)
            sec = grow(limb.pts[i], dd, Ls, max(limb.rad[i] * 0.62, 0.055), 0.045, 2, limb.s[i], rs, up=0.12, gnarl=0.7,
                       step=0.15, out=outward)
            branches.append(sec)
            tips.append(sec.pts[-1])
            for q in range(rs.randint(1, 3)):
                t2 = rs.uniform(0.35, 0.85)
                i2 = int(t2 * (len(sec.pts) - 1))
                T2 = sec.pts[min(i2 + 1, len(sec.pts) - 1)] - sec.pts[max(i2 - 1, 0)]
                T2 /= np.linalg.norm(T2)
                side2 = np.cross(T2, rs.normal(0, 1, 3))
                side2 /= np.linalg.norm(side2)
                d3 = rotate_about(T2, side2, math.radians(rs.uniform(30, 60)))
                ter = grow(sec.pts[i2], d3, Ls * rs.uniform(0.35, 0.55), max(sec.rad[i2] * 0.6, 0.045), 0.04, 3, sec.s[i2], rs,
                           up=0.1, gnarl=0.8, step=0.12)
                branches.append(ter)
                tips.append(ter.pts[-1])
    return branches, np.array(tips), rb, fork_h


def overhang_skeleton(seed):
    """Big limb from the origin along +X, drooping, with hanging side branches (camera-foreground overhang)."""
    rs = np.random.RandomState(seed)
    branches = []
    main = grow((-0.6, 0, 0), (1, 0, 0.12), 6.6, 0.24, 0.05, 1, 0.0, rs, up=0.0, droop=0.12, gnarl=0.45, step=0.15, taper=0.9)
    branches.append(main)
    tips = [main.pts[-1]]
    for j in range(7):
        t = 0.2 + j * 0.11 + rs.uniform(-0.03, 0.03)
        i = int(t * (len(main.pts) - 1))
        side = 1 if j % 2 else -1
        d = np.array([0.6, side * rs.uniform(0.5, 1.0), rs.uniform(-0.6, 0.1)])
        Ls = rs.uniform(1.4, 2.6) * (1.15 - 0.4 * t)
        sec = grow(main.pts[i], d, Ls, max(main.rad[i] * 0.55, 0.05), 0.04, 2, main.s[i], rs, up=0.0, droop=0.25, gnarl=0.7, step=0.12)
        branches.append(sec)
        tips.append(sec.pts[-1])
        for q in range(2):
            i2 = int(rs.uniform(0.4, 0.85) * (len(sec.pts) - 1))
            d3 = sec.pts[-1] - sec.pts[0] + rs.normal(0, 0.6, 3) + np.array([0, 0, -0.4])
            ter = grow(sec.pts[i2], d3, Ls * 0.45, max(sec.rad[i2] * 0.6, 0.045), 0.04, 3, sec.s[i2], rs, droop=0.3, gnarl=0.8, step=0.1)
            branches.append(ter)
            tips.append(ter.pts[-1])
    return branches, np.array(tips), 0.24


def kmeans(X, k, rs, iters=25):
    C = X[rs.choice(len(X), k, replace=False)]
    for _ in range(iters):
        lab = np.argmin(((X[:, None] - C[None]) ** 2).sum(-1), axis=1)
        for j in range(k):
            if (lab == j).any():
                C[j] = X[lab == j].mean(0)
    return C, lab


def build_trunk(L, name, branches, rb, seed, budget):
    flare = lambda z: 1.0 + 0.55 * math.exp(-max(z, 0) / 0.6)
    v, f = tube_mesh(branches, flare)
    o = L.link(name, L.mesh_from_np(name, v, f))
    L.remesh(o, 0.035)
    me = o.data
    co = L.get_co(me)
    sk = Skeleton(branches)
    idx = sk.nearest(co)
    theta, s, r = sk.local(co, idx)
    nrm = L.smooth_normals(me, 3)
    n1, n2 = L.Noise(seed + 1), L.Noise(seed + 2)
    circ = theta * np.maximum(r, 0.05)                          # metres around
    tw = s * 0.35                                               # spiral twist
    # furrows: ridged noise stretched along the branch, ~ every 12-20 cm around, depth scales with radius
    ridge = n1.ridged((theta + tw) * np.clip(r * 30, 5, 14) / (2 * math.pi) * 2.0, s * 0.6, 0.0, 3)
    fur = -(1 - ridge) * np.clip(r, 0.05, 0.6) * 0.16
    burl = n2.fbm(co[:, 0] * 0.9, co[:, 1] * 0.9, co[:, 2] * 0.9, 3) * np.clip(r, 0.05, 0.6) * 0.35
    knots = np.clip(n2(co[:, 0] * 3, co[:, 1] * 3, co[:, 2] * 3) - 0.35, 0, None) * np.clip(r, 0.05, 0.6) * 0.6
    D = fur + burl + knots
    co = co + nrm * D[:, None]
    L.set_co(me, co)
    L.decimate(o, budget)
    L.shade(o.data, 70)
    return o, sk


def bark_uv(L, o, sk):
    me = o.data
    co = L.get_co(me)
    uvl = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    nf = len(me.polygons)
    cent = np.empty(nf * 3)
    me.polygons.foreach_get("center", cent)
    cent = cent.reshape(-1, 3)
    fbr = sk.BI[sk.nearest(cent)]
    ls = np.empty(nf, np.int64); lt = np.empty(nf, np.int64)
    me.polygons.foreach_get("loop_start", ls); me.polygons.foreach_get("loop_total", lt)
    lv = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get("vertex_index", lv)
    loop_face = np.repeat(np.arange(nf), lt)
    lbr = fbr[loop_face]
    pts = co[lv]
    idx = sk.nearest(pts, lbr)
    theta, s, r = sk.local(pts, idx)
    rr = np.maximum(sk.R[idx], 0.04)
    u = theta * rr
    per = 2 * math.pi * rr
    # seam fix per face: unwrap angles relative to the first loop of the face
    for fi in range(nf):
        a, n = ls[fi], lt[fi]
        th = theta[a:a + n]
        ref = th[0]
        dth = (th - ref + math.pi) % (2 * math.pi) - math.pi
        u[a:a + n] = (ref + dth) * rr[a:a + n]
    uv = np.stack([u, s], 1)
    uvl.data.foreach_set("uv", uv.astype(np.float32).ravel())


def blob_mesh(L, centers, radii, seed, squash=0.78):
    rs = np.random.RandomState(seed)
    bm = bmesh.new()
    for c, r in zip(centers, radii):
        lumps = [(c, r)]
        for k in range(rs.randint(5, 9)):                          # cauliflower sub-lumps
            d = rs.normal(0, 1, 3)
            d[2] = abs(d[2]) * 0.6 + 0.1
            d /= np.linalg.norm(d)
            lumps.append((c + d * r * rs.uniform(0.55, 0.85), r * rs.uniform(0.35, 0.55)))
        for (cc, rr) in lumps:
            tmp = bmesh.new()
            bmesh.ops.create_icosphere(tmp, subdivisions=3, radius=rr)
            for v in tmp.verts:
                v.co.z *= squash
                v.co += Vector(cc)
            me = bpy.data.meshes.new("_b")
            tmp.to_mesh(me)
            tmp.free()
            bm.from_mesh(me)
            bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new("crown")
    bm.to_mesh(me)
    bm.free()
    return me


def build_crown(L, name, tips, n_blobs, seed, budget, extra_down=0.0, min_z=None):
    rs = np.random.RandomState(seed)
    if min_z is not None:
        tips = tips[tips[:, 2] > min_z]
    C, lab = kmeans(tips, n_blobs, rs)
    radii = []
    for j in range(n_blobs):
        sel = tips[lab == j]
        spread = np.sqrt(((sel - C[j]) ** 2).sum(1).mean()) if len(sel) > 1 else 0.8
        radii.append(np.clip(spread * 0.9 + 0.95, 1.2, 2.5))
    C = C + np.array([0, 0, 0.25 - extra_down])
    me = blob_mesh(L, C, radii, seed)
    o = L.link(name, me)
    L.remesh(o, 0.11)
    me = o.data
    co = L.get_co(me)
    nrm = L.smooth_normals(me, 2)
    n1 = L.Noise(seed + 9)
    D = 0.22 * n1.fbm(co[:, 0] * 0.9, co[:, 1] * 0.9, co[:, 2] * 0.9, 3) - 0.12 * n1.ridged(co[:, 0] * 2, co[:, 1] * 2, co[:, 2] * 2, 2)
    co = co + nrm * D[:, None]
    L.set_co(me, co)
    L.laplacian_relax(me, 2, 0.5)
    L.decimate(o, budget)
    L.shade(o.data)
    return o


def finish_tree(L, M, name, trunk, sk, crown, leaf_mat):
    """AO bake (crown: inside/under darker; bark: crotches/roots/under-canopy darker), UVs, materials, join."""
    tme, cme = trunk.data, crown.data
    # crown AO
    cao = L.ray_ao(crown, others=(trunk,), rays=28, dist=3.5, bias=0.03)
    cco, cn = L.get_co(cme), L.get_vnormals(cme)
    z0, z1 = cco[:, 2].min(), cco[:, 2].max()
    h = L.smoothstep(z0, z1, cco[:, 2])
    under = 0.62 + 0.38 * (cn[:, 2] * 0.5 + 0.5)
    ao = np.clip(cao * (0.55 + 0.45 * h) * under, 0.08, 1.0)
    L.set_col(cme, np.stack([ao, ao, ao, np.ones_like(ao)], 1))
    L.box_uv(cme, 1.0)
    cme.materials.append(leaf_mat)
    # bark AO
    tao = L.ray_ao(trunk, others=(crown,), rays=16, dist=2.5, bias=0.01)
    tco = L.get_co(tme)
    ground = 0.6 + 0.4 * L.smoothstep(-0.2, 0.8, tco[:, 2])
    ao = np.clip(tao * ground, 0.05, 1)
    L.set_col(tme, np.stack([ao, ao, ao, np.ones_like(ao)], 1))
    bark_uv(L, trunk, sk)
    tme.materials.append(M["bark"])
    # join crown into trunk object (one prototype, two material primitives)
    bpy.ops.object.select_all(action="DESELECT")
    trunk.select_set(True)
    crown.select_set(True)
    bpy.context.view_layer.objects.active = trunk
    bpy.ops.object.join()
    trunk.name = name
    trunk.data.name = name
    me = trunk.data
    me.color_attributes.active_color = me.color_attributes["Col"]
    return trunk


def build(L, M, OUT_DIR, log):
    import os
    objs = []
    specs = [("MapleTree_0", 12.0, 101, 6, M["leaf_red"], 10),
             ("MapleTree_1", 9.0, 202, 5, M["leaf_orange"], 8),
             ("MapleTree_2", 12.4, 303, 7, M["leaf_red"], 12)]
    for name, H, seed, nl, lm, nb in specs:
        log("tree", name)
        br, tips, rb, fork_h = maple_skeleton(H, seed, nl)
        trunk, sk = build_trunk(L, name + "_trunk", br, rb, seed, 7900)
        log("  trunk tris", L.tri_count(trunk.data), "branches", len(br))
        crown = build_crown(L, name + "_crown", tips, nb, seed, 3950, min_z=fork_h + 1.0)
        log("  crown tris", L.tri_count(crown.data))
        objs.append(finish_tree(L, M, name, trunk, sk, crown, lm))
    log("overhang")
    br, tips, rb = overhang_skeleton(404)
    trunk, sk = build_trunk(L, "MapleBranch_Overhang_trunk", br, rb, 404, 6000)
    crown = build_crown(L, "MapleBranch_Overhang_crown", tips, 6, 404, 3000, extra_down=0.5)
    objs.append(finish_tree(L, M, "MapleBranch_Overhang", trunk, sk, crown, M["leaf_red"]))
    for o in objs:
        log(" ", o.name, "tris", L.tri_count(o.data), "dims", tuple(round(d, 2) for d in o.dimensions))
    L.export_glb(os.path.join(OUT_DIR, "trees.glb"), objs)
    log("exported trees.glb")
