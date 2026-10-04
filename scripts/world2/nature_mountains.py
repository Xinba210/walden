"""Snowy mountain massifs for the world2 kit (imported by nature_build.py).

Heightfield pipeline (numpy): domain-warped multi-faced pyramids (horn peak + sub-peaks, sharp aretes where faces meet)
smooth-maxed with a connecting massif ridge -> ridged-multifractal modulation -> stream-power erosion on a D8 flow
network (dendritic gullies / couloirs) -> masks. Grid mesh -> collapse-decimate to budget (keeps ridges) ->
Col: R = horizon AO, G = snow (altitude + gentle slope + ridges, streaks down gullies), B = exposed rock.
"""
import math
import os
import numpy as np
import bpy


def grid_mesh(name, X, Y, Hh):
    ny, nx = Hh.shape
    co = np.stack([X.ravel(), Y.ravel(), Hh.ravel()], 1)
    j, i = np.meshgrid(np.arange(ny - 1), np.arange(nx - 1), indexing="ij")
    a = (j * nx + i).ravel()
    faces = np.stack([a, a + 1, a + nx + 1, a + nx], 1)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(co))
    me.vertices.foreach_set("co", co.astype(np.float32).ravel())
    me.loops.add(faces.size)
    me.loops.foreach_set("vertex_index", faces.astype(np.int32).ravel())
    me.polygons.add(len(faces))
    me.polygons.foreach_set("loop_start", (np.arange(len(faces)) * 4).astype(np.int32))
    me.update(calc_edges=True)
    me.validate()
    return me


def pyramid(wx, wy, cx, cy, Hp, R, faces, rot, rs, p=1.3):
    angs = rot + np.arange(faces) * 2 * np.pi / faces + rs.uniform(-0.25, 0.25, faces)
    sc = rs.uniform(0.8, 1.2, faces)                       # unequal faces
    d = None
    for a, s in zip(angs, sc):
        di = ((wx - cx) * math.cos(a) + (wy - cy) * math.sin(a)) / (R * s)
        d = di if d is None else np.maximum(d, di)
    t = np.clip(1 - d, 0, None)
    return Hp * t ** p


def smax(a, b, k):
    h = np.clip(0.5 + 0.5 * (a - b) / k, 0, 1)
    return a * h + b * (1 - h) + k * h * (1 - h)


def flow_accum(h, cell):
    """D8 receivers + accumulation (m^2) + slope to receiver."""
    ny, nx = h.shape
    P = np.pad(h, 1, mode="edge")
    best = np.zeros_like(h)
    rec = np.tile(np.arange(ny * nx).reshape(ny, nx), 1)
    dirs = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    for dy, dx in dirs:
        nb = P[1 + dy:1 + dy + ny, 1 + dx:1 + dx + nx]
        dist = cell * math.hypot(dx, dy)
        s = (h - nb) / dist
        jj, ii = np.meshgrid(np.clip(np.arange(ny) + dy, 0, ny - 1), np.clip(np.arange(nx) + dx, 0, nx - 1), indexing="ij")
        better = s > best
        best = np.where(better, s, best)
        rec = np.where(better, jj * nx + ii, rec)
    order = np.argsort(-h.ravel(), kind="stable").tolist()
    recl = rec.ravel().tolist()
    A = [cell * cell] * (ny * nx)
    for i in order:
        r = recl[i]
        if r != i:
            A[r] += A[i]
    return np.array(A).reshape(ny, nx), best, rec


def erode(h, cell, iters, K, m, cap, log):
    for it in range(iters):
        A, S, _ = flow_accum(h, cell)
        e = np.minimum(K * A ** m * S, cap)
        for _ in range(1):                                   # widen channels: box blur of the incision field
            P = np.pad(e, 1, mode="edge")
            e = (P[:-2, 1:-1] + P[2:, 1:-1] + P[1:-1, :-2] + P[1:-1, 2:] + 2 * e) / 6
        h = h - e
        # thermal: lower slopes relax toward a ~52 deg talus angle (summit faces stay steep)
        P = np.pad(h, 1, mode="edge")
        hmin = np.minimum.reduce([P[:-2, 1:-1], P[2:, 1:-1], P[1:-1, :-2], P[1:-1, 2:]])
        ex_ = h - hmin - 1.43 * cell
        low = h < 0.6 * h.max()
        h = np.where((ex_ > 0) & low, h - 0.3 * ex_, h)
        # light thermal relaxation of over-steep spikes (> ~72 deg) to avoid single-cell needles
        P = np.pad(h, 1, mode="edge")
        nbmax = np.maximum.reduce([P[:-2, 1:-1], P[2:, 1:-1], P[1:-1, :-2], P[1:-1, 2:]])
        nbmean = 0.25 * (P[:-2, 1:-1] + P[2:, 1:-1] + P[1:-1, :-2] + P[1:-1, 2:])
        spike = (h - nbmax) > cell * 1.5
        h = np.where(spike, 0.5 * h + 0.5 * nbmean, h)
    A, S, _ = flow_accum(h, cell)
    return h, A


def horizon_ao(h, cell):
    ny, nx = h.shape
    occ = np.zeros_like(h)
    dirs = [(math.cos(a), math.sin(a)) for a in np.linspace(0, 2 * np.pi, 12, endpoint=False)]
    steps = [2, 4, 8, 16, 32, 64, 120]
    jj, ii = np.meshgrid(np.arange(ny), np.arange(nx), indexing="ij")
    for dx, dy in dirs:
        mx = np.zeros_like(h)
        for s in steps:
            j2 = np.clip(np.round(jj + dy * s).astype(int), 0, ny - 1)
            i2 = np.clip(np.round(ii + dx * s).astype(int), 0, nx - 1)
            el = (h[j2, i2] - h) / (s * cell)
            mx = np.maximum(mx, el)
        occ += np.sin(np.arctan(mx))
    return np.clip(1 - occ / len(dirs) * 0.85, 0, 1)


def laplacian(h, cell, r=1):
    P = np.pad(h, r, mode="edge")
    ny, nx = h.shape
    return (P[:ny, r:r + nx] + P[2 * r:, r:r + nx] + P[r:r + ny, :nx] + P[r:r + ny, 2 * r:] - 4 * h) / (r * cell) ** 2


def bilinear(F, X0, Y0, cell, x, y):
    ny, nx = F.shape
    fx = np.clip((x - X0) / cell, 0, nx - 1.001)
    fy = np.clip((y - Y0) / cell, 0, ny - 1.001)
    i, j = fx.astype(int), fy.astype(int)
    tx, ty = fx - i, fy - j
    return (F[j, i] * (1 - tx) * (1 - ty) + F[j, i + 1] * tx * (1 - ty) + F[j + 1, i] * (1 - tx) * ty + F[j + 1, i + 1] * tx * ty)


def massif(L, name, W, D, cell, peaks, ridge_h, seed, budget, log, top, snowline=820.0, erosion=(12, 0.009, 0.62, 18.0)):
    rs = np.random.RandomState(seed)
    nx, ny = int(W / cell) + 1, int(D / cell) + 1
    X0, Y0 = -W / 2, -D / 2
    xs = X0 + np.arange(nx) * cell
    ys = Y0 + np.arange(ny) * cell
    X, Y = np.meshgrid(xs, ys)
    n1, n2, n3 = L.Noise(seed + 1), L.Noise(seed + 2), L.Noise(seed + 3)
    wx = X + 140 * n1.fbm(X / 900, Y / 900, 0.5, 3) + 25 * n2.fbm(X / 150, Y / 150, 1.5, 2)
    wy = Y + 140 * n2.fbm(X / 900, Y / 900, 2.5, 3) + 25 * n3.fbm(X / 150, Y / 150, 3.5, 2)
    h = np.zeros_like(X)
    for (cx, cy, Hp, R, faces) in peaks:
        h = smax(h, pyramid(wx, wy, cx, cy, Hp, R, faces, rs.uniform(0, 2 * np.pi), rs), 60.0)
    # connecting massif ridge along x (wavy), fading toward the ends
    ry = 0.12 * D * n3.fbm(X / 1400, 0.3, 0.7, 2)
    ridge = ridge_h * np.exp(-((wy - ry) / (0.22 * D)) ** 2) * L.smoothstep(W * 0.5, W * 0.3, np.abs(X))
    ridge *= 0.75 + 0.5 * n1.fbm(X / 600, 1.1, 0.0, 2)
    h = smax(h, ridge, 80.0)
    # foothill apron so the massif does not rise straight off the plain
    edge = np.minimum((X - X0) / W, (X0 + W - X) / W) * 2
    edge = np.minimum(edge, np.minimum((Y - Y0) / D, (Y0 + D - Y) / D) * 2)
    foot = top * 0.16 * L.smoothstep(0.0, 0.55, edge) * (0.6 + 0.6 * n3.fbm(X / 500, Y / 500, 4.4, 3))
    h = smax(h, foot, 60.0)
    # ridged multifractal: aretes + secondary spurs, scaled with height
    rid = n2.ridged(wx / 560, wy / 560, 0.0, 6, lac=2.0, gain=0.47)
    h = h * (0.72 + 0.38 * rid) + 14 * n3.fbm(X / 60, Y / 60, 0.0, 3)
    # border fade so the mesh sinks below the ground plane at the edges
    ex = np.minimum(X - X0, X0 + W - X) / W
    ey = np.minimum(Y - Y0, Y0 + D - Y) / D
    em = np.minimum(ex * W / 3000, ey * D / 3000) * 1.5
    fade = L.smoothstep(0.0, 0.32, em) ** 1.5
    fade_edge = L.smoothstep(0.0, 0.05, em)
    h = h * fade - 40 * (1 - fade)
    log("  shaped", name, h.shape, "max", round(float(h.max()), 1))
    it, K, m, cap = erosion
    h, A = erode(h, cell, it, K, m, cap, log)
    h = h * fade_edge - 40 * (1 - fade_edge)
    h = np.where(h > 0, h * (top / h.max()), h)
    log("  eroded max", round(float(h.max()), 1))

    # ---- masks on the grid
    gy, gx = np.gradient(h, cell)
    nz = 1 / np.sqrt(1 + gx * gx + gy * gy)
    ny_ = -gy * nz                                         # +Y (north) component of the normal
    lap = laplacian(h, cell, 2)
    ao = horizon_ao(h, cell)
    cav = np.clip(1 + lap * 4.0, 0.65, 1.0)               # concave = darker
    ao = np.clip(ao * cav, 0, 1)
    logA = np.log10(np.maximum(A, 1))
    gully = L.smoothstep(3.3, 4.6, logA) * L.smoothstep(-0.002, 0.01, lap)
    ridge_m = L.smoothstep(0.0, -0.03, lap)
    gl = np.maximum(np.hypot(gx, gy), 1e-6)
    uu = (-X * gy + Y * gx) / gl                       # across-slope coordinate
    vv = (X * gx + Y * gy) / gl                        # down-slope coordinate
    streak = np.clip(0.55 + 0.6 * n1.fbm(uu / 28, vv / 260, 7.0, 3), 0, 1)           # streaks run down the fall line
    line = snowline + 240 * n3.fbm(X / 520, Y / 520, 9.0, 3) + 80 * n2.fbm(X / 120, Y / 120, 2.0, 2) - 380 * gully * streak - 120 * np.clip(ny_, 0, 1) \
        - 160 * (streak - 0.5)
    alt = L.smoothstep(line - 160, line + 220, h)
    slope_f = L.smoothstep(0.26, 0.58, nz)
    snow = alt * (slope_f * (0.75 + 0.45 * streak) + 0.55 * ridge_m * L.smoothstep(0.25, 0.5, nz) + 0.5 * gully)
    snow = np.clip(snow, 0, 1)
    snow = np.where(h > line + 450, np.maximum(snow, 0.75 * L.smoothstep(0.25, 0.5, nz)), snow)  # summit cap
    rock = np.clip((1 - snow) * (0.35 + 0.65 * L.smoothstep(0.85, 0.5, nz)), 0, 1)

    me = grid_mesh(name, X, Y, h)
    o = L.link(name, me)
    log("  grid tris", L.tri_count(me))
    L.decimate(o, budget)
    me = o.data
    L.shade(me, 80)
    co = L.get_co(me)
    R_ = bilinear(ao, X0, Y0, cell, co[:, 0], co[:, 1])
    G_ = bilinear(snow, X0, Y0, cell, co[:, 0], co[:, 1])
    B_ = bilinear(rock, X0, Y0, cell, co[:, 0], co[:, 1])
    L.set_col(me, np.stack([R_, G_, B_, np.ones_like(R_)], 1))
    L.box_uv(me, 200.0)
    me.materials.append(bpy.data.materials["Rock"])
    log("  final tris", L.tri_count(me), "dims", tuple(round(d) for d in o.dimensions))
    return o


def build(L, M, OUT_DIR, log):
    objs = []
    log("Mountain_Main")
    objs.append(massif(L, "Mountain_Main", 3200, 2700, 5.5, [
        (0, 80, 1750, 1150, 4),
        (-700, 220, 1000, 760, 3), (660, 280, 1120, 800, 4),
        (-1150, -40, 720, 600, 3), (1140, 30, 780, 640, 4),
        (320, 620, 900, 700, 3), (-380, 660, 980, 720, 4), (80, -480, 520, 520, 3),
    ], 800, 7, 59500, log, 1720, snowline=720.0))
    log("Mountain_Range_L")
    objs.append(massif(L, "Mountain_Range_L", 3400, 2300, 8.0, [
        (-1150, 40, 820, 700, 3), (-450, -30, 1080, 820, 4), (250, 60, 900, 760, 3), (950, -20, 1150, 850, 4),
        (1450, 80, 700, 600, 3),
    ], 720, 21, 29500, log, 1150, snowline=700.0))
    log("Mountain_Range_R")
    objs.append(massif(L, "Mountain_Range_R", 2600, 2100, 7.0, [
        (-900, 0, 700, 650, 3), (-250, 50, 980, 780, 4), (450, -40, 1180, 820, 3), (1050, 30, 760, 600, 4),
    ], 680, 33, 29500, log, 1080, snowline=690.0))
    L.export_glb(os.path.join(OUT_DIR, "mountains.glb"), objs)
    log("exported mountains.glb")
