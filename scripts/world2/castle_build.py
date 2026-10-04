"""Ruined gothic castle / cathedral complex -> game/public/models/world2/castle.glb

  blender -b --factory-startup --python scripts/world2/castle_build.py -- [out.glb] [only=main,round,...]

Castle_Ruin (one object, ~85 x 40 m, main tower ~52 m): buttressed square keep with stage string courses, framed
lancets and traceried belfry openings, corner pinnacles and a stair turret; a round tower with corbelled parapet;
a square tower with collapsed corner; a gatehouse with a deep, multi-order pointed-arch gateway; crenellated curtain
walls with breaches; the traceried wall of a ruined chapel; and an arched viaduct wing on pointed arches whose last
span has fallen. Built from coursed long-block masonry (real joints), voussoir-framed openings and jagged breaks.
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Vector, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stonelib as S

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = next((a for a in argv if a.endswith(".glb")), os.path.join(ROOT, "game/public/models/world2/castle.glb"))
ONLY = next((a[5:].split(",") for a in argv if a.startswith("only=")), None)

S.reset()
T = Matrix.Translation
R = Matrix.Rotation
V = Vector
RZ90 = R(math.pi / 2, 4, "Z")

VOX = 0.075
GAP = 0.09
BEV = 0.09
CHIP = (0.15, 0.45)
SC = dict(ero=(0.07, 2.5), mid=(0.03, 0.7), fine=(0.012, 0.18), pits=0.0, wear=(0.06, 0.035), face_rr=(0.6, 1.3),
          flake_depth=(0.03, 0.07), crazing_on=False)


def want(k):
    return ONLY is None or k in ONLY


def sculpt(name, mem, cut=(), chips=40, target=10000, **kw):
    args = dict(SC)
    args.update(kw)
    return S.sculpt(name, mem, kw.pop("voxel", VOX), BEV, list(cut), chips, CHIP, sum(map(ord, name)) * 7 % 997,
                    target=target,
                    flakes=chips // 2, **{k: v for k, v in args.items() if k != "voxel"})


# ------------------------------------------------------------------ geometry helpers
def frame_x(xc, yc):          # wall running along X (normal = Y): local (u, n, z) -> world
    return T((xc, yc, 0))


def frame_y(xc, yc):          # wall running along Y (normal = X)
    return T((xc, yc, 0)) @ RZ90


def frame_r(cx, cy, phi, r):  # radial frame on a round tower (n = radial direction)
    return T((cx + math.cos(phi) * r, cy + math.sin(phi) * r, 0)) @ R(phi - math.pi / 2, 4, "Z")


def xf(M, mem):
    out = []
    for m in mem:
        if isinstance(m, bmesh.types.BMesh):
            m.transform(M)
            out.append(m)
        else:
            sx, sy, sz, Mm = m
            out.append((sx, sy, sz, M @ Mm))
    return out


def pointed(w, hs, r, n=8):
    """Pointed (two-centred) arch outline of an opening of width w springing at hs, arc radius r >= w/2.
    Returns (right arc springing->apex, left arc apex->springing) as (u, z) lists, plus centres."""
    cR, cL = w / 2 - r, -w / 2 + r          # centre of the arc drawing the right / left side
    ta = math.acos(max(-1.0, min(1.0, -cR / r)))
    right = [(cR + r * math.cos(ta * i / n), hs + r * math.sin(ta * i / n)) for i in range(n + 1)]
    left = [(cL - r * math.cos(ta * (n - i) / n), hs + r * math.sin(ta * (n - i) / n)) for i in range(n + 1)]
    return right, left, cR, cL


def opening_cutter(F, w, hs, r, z0, depth=8.0, n=10):
    right, left, _, _ = pointed(w, hs, r, n)
    poly = [(-w / 2, 0.0), (w / 2, 0.0)] + right + left[1:]
    bm = bmesh.new()
    lo = [bm.verts.new((u, -depth / 2, z + z0)) for u, z in poly]
    hi = [bm.verts.new((u, depth / 2, z + z0)) for u, z in poly]
    bm.faces.new(lo)
    bm.faces.new(hi[::-1])
    for i in range(len(poly)):
        j = (i + 1) % len(poly)
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.transform(F)
    return bm


def rect_cutter(F, w, h, z0, depth=8.0):
    b = S.box_bm(w, depth, h, (0, 0, z0 + h / 2))
    b.transform(F)
    return b


def arch_ring(F, w, hs, r, z0, fw, n0, n1, nseg=6, gap=GAP, jambs=True, sill=True, jamb_blocks=3, seed=0):
    """Voussoir ring (+ jamb blocks + sill) framing a pointed opening; members in world space."""
    rng = random.Random(seed)
    right, left, cR, cL = pointed(w, hs, r, nseg)
    mem = []
    ga = gap / 2 / (r + fw / 2)

    def seg(c, a0, a1):
        P = lambda a, rr, n: V((c + rr * math.cos(a), n, z0 + hs + rr * math.sin(a)))
        a0g, a1g = a0 + ga, a1 - ga
        return S.hexa_bm([P(a0g, r, n0), P(a1g, r, n0), P(a1g, r + fw, n0), P(a0g, r + fw, n0),
                          P(a0g, r, n1), P(a1g, r, n1), P(a1g, r + fw, n1), P(a0g, r + fw, n1)])

    ta = math.acos(max(-1.0, min(1.0, -cR / r)))
    for i in range(nseg):            # right side, centre cR, angles 0..ta
        mem.append(seg(cR, ta * i / nseg, ta * (i + 1) / nseg))
    for i in range(nseg):            # left side, centre cL, angles pi-ta..pi
        mem.append(seg(cL, math.pi - ta * (i + 1) / nseg, math.pi - ta * i / nseg))
    if jambs and hs > 0.3:
        hb = hs / jamb_blocks
        for k in range(jamb_blocks):
            for sgn in (-1, 1):
                wide = fw * (1.25 if (k + (sgn > 0)) % 2 else 1.0)       # alternating long / short jamb stones
                u = sgn * (w / 2 + wide / 2)
                mem.append((wide - gap, n1 - n0, hb - gap,
                            T((u, (n0 + n1) / 2, z0 + k * hb + rng.uniform(-0.01, 0.01)))))
    if sill:
        mem.append((w + 2 * fw + 0.3, n1 - n0 + 0.1, 0.32, T((0, (n0 + n1) / 2, z0 - 0.32))))
    return xf(F, mem)


def course_wall(x0, x1, th, z0, z1, seed, ch=1.0, lx=(2.0, 3.8), skip=None):
    """Long-block coursed wall along X between x0..x1 (local), centred on n=0, thickness th."""
    return S.course_blocks(x0, x1, -th / 2, th / 2, z0, z1, ch, seed, lx, 1, gap=GAP, jit=0.02, skip=skip,
                           rot=0.004)


def stepped(h_full, zones, seed, ch=1.0):
    """Height profile: h_full, with V-shaped stepped collapses: zones = [(xa, xb, depth)]."""
    rng = random.Random(seed)
    jag = {}

    def h(x):
        d = 0.0
        for xa, xb, dep in zones:
            if xa < x < xb:
                t = 1 - abs((x - (xa + xb) / 2) / ((xb - xa) / 2))
                d = max(d, dep * min(1.0, t * 1.6))
        k = int(x // 1.3)
        if k not in jag:
            jag[k] = rng.choice((0.0, 0.0, 0.0, ch, ch))
        return h_full - d - (jag[k] if d > 0 else 0.0)
    return h


def skip_above(h, z0, ch=1.0, x_of=lambda xa, xb: (xa + xb) / 2):
    return lambda c, xa, xb, ya, yb: z0 + (c + 1) * ch > h(x_of(xa, xb)) + 1e-3


def merlons(x0, x1, th, z0, seed, h=1.6, w=1.3, gap_w=0.9, missing=0.2, keep=lambda x: True):
    rng = random.Random(seed)
    mem = []
    x = x0 + 0.1
    while x + w <= x1 + 1e-3:
        xc = x + w / 2
        if rng.random() > missing and keep(xc):
            hh = h * rng.uniform(0.7, 1.0) if rng.random() < 0.3 else h
            mem.append((w - GAP, th, hh, T((xc, rng.uniform(-0.03, 0.03), z0))))
        x += w + gap_w
    return mem


def ring_blocks(r_in, r_out, z0, z1, ch, seed, seg=2.2, skip=None, a_range=(0, 2 * math.pi)):
    """Coursed round-tower wall: wedge blocks between r_in..r_out. skip(course, angle) drops blocks."""
    rng = random.Random(seed)
    mem = []
    nc = max(1, round((z1 - z0) / ch))
    hh = (z1 - z0) / nc
    full = abs(a_range[1] - a_range[0] - 2 * math.pi) < 1e-6
    for c in range(nc):
        z = z0 + c * hh
        n = max(6, int((a_range[1] - a_range[0]) * r_out / seg))
        da = (a_range[1] - a_range[0]) / n
        off = rng.uniform(0, da) if full else 0.0
        for k in range(n):
            a0 = a_range[0] + off + k * da
            a1 = a0 + da * rng.uniform(0.75, 1.0) if not full else a0 + da
            am = (a0 + a1) / 2
            if skip and skip(c, am % (2 * math.pi)):
                continue
            g = GAP / 2 / r_out
            P = lambda a, r, zz: V((math.cos(a) * r, math.sin(a) * r, zz))
            b0, b1 = a0 + g, a1 - g
            zt = z + hh - GAP * 0.7
            mem.append(S.hexa_bm([P(b0, r_in, z), P(b1, r_in, z), P(b1, r_out, z), P(b0, r_out, z),
                                  P(b0, r_in, zt), P(b1, r_in, zt), P(b1, r_out, zt), P(b0, r_out, zt)]))
    return mem


def buttress(F, u, n_face, width, stages, seed):
    """Stepped buttress against a wall face. stages = [(z_top, depth)] from bottom; sloped set-off caps.
    Local frame: projects along +n from n_face."""
    mem = []
    z = 0.0
    for i, (zt, d) in enumerate(stages):
        mem += S.course_blocks(u - width / 2, u + width / 2, n_face - 0.3, n_face + d, z, zt - 0.6, 1.0,
                               seed + i, (width + 0.1, width + 0.2), 1, gap=GAP, jit=0.01)
        nd = stages[i + 1][1] if i + 1 < len(stages) else 0.0
        # sloped weathering cap from depth d down to the next stage's depth
        a, b = u - width / 2, u + width / 2
        mem.append(S.hexa_bm([V((a, n_face - 0.3, zt - 0.6)), V((b, n_face - 0.3, zt - 0.6)),
                              V((b, n_face + d, zt - 0.6)), V((a, n_face + d, zt - 0.6)),
                              V((a, n_face - 0.3, zt)), V((b, n_face - 0.3, zt)),
                              V((b, n_face + nd + 0.02, zt)), V((a, n_face + nd + 0.02, zt))]))
        z = zt
    return xf(F, mem)


def pinnacle(x, y, z, s, h, seed, broken=None):
    mem = [(s, s, h * 0.45, T((x, y, z)))]
    z2 = z + h * 0.45
    mem.append((s + 0.25, s + 0.25, 0.3, T((x, y, z2))))
    z3 = z2 + 0.3
    t = 0.06
    mem.append(S.hexa_bm([V((x - s / 2, y - s / 2, z3)), V((x + s / 2, y - s / 2, z3)), V((x + s / 2, y + s / 2, z3)),
                          V((x - s / 2, y + s / 2, z3)), V((x - t, y - t, z + h)), V((x + t, y - t, z + h)),
                          V((x + t, y + t, z + h)), V((x - t, y + t, z + h))]))
    return mem


def string_course_rect(x0, x1, y0, y1, z, proj=0.3, h=0.4):
    """Projecting moulded band around a rectangular plan (splayed upper face)."""
    mem = []
    for (a, b, c, d) in ((x0 - proj, x1 + proj, y0 - proj, y0 + 0.6), (x0 - proj, x1 + proj, y1 - 0.6, y1 + proj),
                         (x0 - proj, x0 + 0.6, y0 + 0.6, y1 - 0.6), (x1 - 0.6, x1 + proj, y0 + 0.6, y1 - 0.6)):
        mem.append((b - a, d - c, h, T(((a + b) / 2, (c + d) / 2, z))))
    return mem


# ------------------------------------------------------------------ parts
parts = []

# ---------- main keep: 13 x 13 m, ~52 m, hollow (1.9 m walls)
MX, MY, MS, MT = 2.0, 14.0, 13.0, 1.9
MH = 49.0
if want("main"):
    mem, cut = [], []
    h_n = stepped(MH, [(-3.0, 4.5, 6.0)], 11)       # north face top partly collapsed
    h_e = stepped(MH, [(1.0, 6.5, 3.0)], 12)
    for side, (F, L, hf) in enumerate(((frame_x(MX, MY - MS / 2 + MT / 2), MS, lambda x: MH),
                                       (frame_x(MX, MY + MS / 2 - MT / 2), MS, h_n),
                                       (frame_y(MX - MS / 2 + MT / 2, MY), MS - 2 * MT, lambda x: MH),
                                       (frame_y(MX + MS / 2 - MT / 2, MY), MS - 2 * MT, h_e))):
        mem += xf(F, course_wall(-L / 2, L / 2, MT, 0.0, MH, 100 + side, skip=skip_above(hf, 0.0)))
        # openings: stage 2 single lancet, stage 3 twin lancets, belfry big traceried opening
        n0, n1 = -MT / 2 - 0.15, MT / 2 + 0.15
        if side != 0:
            mem += arch_ring(F, 1.6, 4.2, 1.6 * 0.9, 16.5, 0.55, n0, n1, 5, seed=side)
            cut.append(opening_cutter(F, 1.6, 4.2, 1.6 * 0.9, 16.5))
        for u in (-2.4, 2.4):
            mem += arch_ring(F @ T((u, 0, 0)), 1.4, 4.6, 1.4 * 0.9, 29.0, 0.5, n0, n1, 5, seed=side * 3 + int(u))
            cut.append(opening_cutter(F @ T((u, 0, 0)), 1.4, 4.6, 1.4 * 0.9, 29.0))
        mem += arch_ring(F, 4.0, 5.0, 4.0 * 0.85, 39.0, 0.7, n0 - 0.1, n1 + 0.1, 7, jamb_blocks=4, seed=side * 7)
        cut.append(opening_cutter(F, 4.0, 5.0, 4.0 * 0.85, 39.0))
        # arrow slits in the lower stage
        cut.append(rect_cutter(F, 0.35, 2.4, 6.0) if side != 1 else opening_cutter(F, 2.6, 3.4, 2.6 * 0.8, 0.0))
        if side == 1:
            mem += arch_ring(F, 2.6, 3.4, 2.6 * 0.8, 0.0, 0.6, n0, n1, 6, sill=False, seed=99)
    # string courses dividing the stages
    for z in (14.0, 27.0, 37.5):
        mem += string_course_rect(MX - MS / 2, MX + MS / 2, MY - MS / 2, MY + MS / 2, z)
    # angle buttresses: two per corner
    for cx in (-1, 1):
        for cy in (-1, 1):
            if cx > 0 and cy > 0:
                continue      # stair turret sits on the NE corner
            stg = [(14.0, 1.6), (27.0, 1.15), (37.5, 0.7)]
            mem += buttress(frame_x(MX + cx * (MS / 2 - 0.9), MY + cy * MS / 2) @ (R(math.pi, 4, "Z") if cy < 0 else Matrix()),
                            0.0, 0.0, 1.8, stg, 130 + cx * 3 + cy)
            mem += buttress(frame_y(MX + cx * MS / 2, MY + cy * (MS / 2 - 0.9)) @ (R(math.pi, 4, "Z") if cx > 0 else Matrix()),
                            0.0, 0.0, 1.8, stg, 140 + cx * 3 + cy)
    # crenellated parapet on the intact south & west tops, and corner pinnacles
    mem += xf(frame_x(MX, MY - MS / 2 + 0.35), merlons(-MS / 2, MS / 2, 0.7, MH, 150))
    mem += xf(frame_y(MX - MS / 2 + 0.35, MY), merlons(-MS / 2 + 0.7, MS / 2 - 0.7, 0.7, MH, 151, missing=0.35))
    mem += pinnacle(MX - MS / 2 + 0.6, MY - MS / 2 + 0.6, MH, 1.3, 6.0, 152)
    mem += pinnacle(MX + MS / 2 - 0.6, MY - MS / 2 + 0.6, MH, 1.3, 6.0, 153)
    mem += pinnacle(MX - MS / 2 + 0.6, MY + MS / 2 - 0.6, MH - 1.0, 1.3, 6.0, 154)
    cut.append(S.break_cutter(V((MX - MS / 2 + 0.6, MY - MS / 2 + 0.6, MH + 3.6)), V((0.4, 0.5, 1)), 3, 0.25, 155,
                              res=0.12))
    cut.append(S.break_cutter(V((MX + 1, MY + MS / 2, MH - 4.0)), V((0.3, 1, 0.9)), 16, 0.6, 156, res=0.2, scale=0.5))
    parts.append(sculpt("main", mem, cut, chips=90, target=44000))

    # stair turret on the NE corner, slit windows, jagged top
    tx, ty = MX + MS / 2, MY + MS / 2
    tm = xf(T((tx, ty, 0)), ring_blocks(0.4, 2.4, 0.0, MH + 4.0, 1.0, 160, seg=1.8))
    tc = [rect_cutter(frame_r(tx, ty, a, 2.2), 0.3, 1.6, z) for a, z in
          ((0.6, 8.0), (1.3, 15.0), (0.3, 22.0), (1.0, 30.0), (0.5, 38.0), (1.2, 45.0))]
    tc.append(S.break_cutter(V((tx, ty, MH + 1.5)), V((0.5, 0.3, 1)), 7, 0.5, 161, res=0.12))
    parts.append(sculpt("turret", tm, tc, chips=20, target=6000))

    # tracery in the belfry openings (mullion + twin sub-arches + oculus ring), separate so cutters miss it
    tr = []
    for side, F in enumerate((frame_x(MX, MY - MS / 2 + MT / 2), frame_y(MX - MS / 2 + MT / 2, MY),
                              frame_y(MX + MS / 2 - MT / 2, MY))):
        tr.append(xf(F, [(0.35, 0.5, 5.6, T((0, 0, 39.0)))]))
        for u in (-1.0, 1.0):
            tr.append(xf(F @ T((u, 0, 0)), [m for m in arch_ring(Matrix(), 1.65, 5.0, 1.65 * 0.85, 39.0, 0.22, -0.25,
                                                                   0.25, 4, jambs=False, sill=False)]))
    tr = [m for grp in tr for m in grp]
    parts.append(sculpt("tracery", tr, (), chips=8, target=4500, voxel=0.05))

# ---------- round tower (r 5, 34 m) with corbelled parapet, partly collapsed
RX, RY, RR = -24.0, -6.0, 5.0
if want("round"):
    def rskip(c, a):            # a wedge of the upper wall has fallen on the outer (south-west) side
        z = c * 1.0
        return (3.6 < a < 4.7 and z > 20 + 9 * abs(a - 4.15)) or z > 31
    mem = xf(T((RX, RY, 0)), ring_blocks(RR - 1.8, RR, 0.0, 32.0, 1.0, 200, skip=rskip))
    mem += xf(T((RX, RY, 0)), ring_blocks(RR - 0.3, RR + 0.25, 0.0, 1.6, 0.8, 201))       # battered plinth
    # corbels + projecting parapet (only partly surviving)
    rng = random.Random(202)
    for k in range(26):
        a = 2 * math.pi * k / 26
        if 3.0 < a < 5.2:
            continue
        mem.append((0.45, 1.3, 0.9, T((RX + math.cos(a) * (RR + 0.3), RY + math.sin(a) * (RR + 0.3), 27.4)) @ R(a + math.pi / 2, 4, "Z")))
    mem += xf(T((RX, RY, 0)), ring_blocks(RR - 0.2, RR + 0.75, 28.3, 31.5, 0.8, 203,
                                          skip=lambda c, a: not (0.2 < a < 2.9 or 5.4 < a < 6.1) or (c == 3 and rng.random() < 0.5)))
    cut = []
    for a, z, w, hs in ((0.4, 8.0, 0.35, 2.0), (1.7, 13.0, 0.35, 2.0), (5.6, 18.0, 0.35, 2.0), (1.1, 21.0, 1.3, 2.6),
                        (5.9, 22.5, 1.3, 2.6), (2.6, 5.0, 0.35, 2.0)):
        F = frame_r(RX, RY, a, RR - 0.9)
        if w > 1:
            mem += arch_ring(F, w, hs, w * 0.9, z, 0.45, -1.2, 1.2, 4, seed=int(a * 10))
            cut.append(opening_cutter(F, w, hs, w * 0.9, z))
        else:
            cut.append(rect_cutter(F, w, hs, z))
    cut.append(S.break_cutter(V((RX - 3.5, RY - 3.0, 25.0)), V((-0.7, -0.6, 0.7)), 14, 0.6, 205, res=0.2, scale=0.5))
    parts.append(sculpt("round", mem, cut, chips=50, target=19000))

# ---------- square tower (8 x 8, 30 m), one corner collapsed
QX, QY, QS, QT = 22.0, -8.0, 8.0, 1.6
if want("square"):
    mem, cut = [], []
    hfun = [stepped(30, [(0.5, 4.5, 11.0)], 300), stepped(30, [(-4.5, -1.0, 4.0)], 301), lambda x: 30.0,
            stepped(30, [(-4.0, 0.5, 11.0)], 303)]
    for side, (F, L) in enumerate(((frame_x(QX, QY - QS / 2 + QT / 2), QS), (frame_x(QX, QY + QS / 2 - QT / 2), QS),
                                   (frame_y(QX - QS / 2 + QT / 2, QY), QS - 2 * QT),
                                   (frame_y(QX + QS / 2 - QT / 2, QY), QS - 2 * QT))):
        mem += xf(F, course_wall(-L / 2, L / 2, QT, 0.0, 30.0, 310 + side, skip=skip_above(hfun[side], 0.0)))
        n0, n1 = -QT / 2 - 0.12, QT / 2 + 0.12
        if side in (0, 2):
            mem += arch_ring(F, 1.3, 3.6, 1.3 * 0.9, 19.0, 0.45, n0, n1, 4, seed=320 + side)
            cut.append(opening_cutter(F, 1.3, 3.6, 1.3 * 0.9, 19.0))
        cut.append(rect_cutter(F, 0.3, 2.0, 9.0))
    mem += string_course_rect(QX - QS / 2, QX + QS / 2, QY - QS / 2, QY + QS / 2, 15.0, 0.25, 0.35)
    mem += xf(frame_x(QX, QY - QS / 2 + 0.3), merlons(-QS / 2, QS / 2, 0.6, 30.0, 330, missing=0.3,
                                                       keep=lambda x: x < 0.2))
    cut.append(S.break_cutter(V((QX + QS / 2, QY - QS / 2, 21.0)), V((0.7, -0.6, 0.6)), 12, 0.6, 331, res=0.18,
                              scale=0.6))
    parts.append(sculpt("square", mem, cut, chips=45, target=15000))

# ---------- gatehouse with a deep multi-order pointed gateway
GX, GY, GW, GD, GH = -2.0, -10.0, 14.0, 9.0, 20.0
if want("gate"):
    mem, cut = [], []
    F = frame_x(GX, GY)
    # solid block as front/back skins + side walls (gateway passage through it)
    for n_off in (-GD / 2 + 1.2, GD / 2 - 1.2):
        mem += xf(frame_x(GX, GY + n_off), course_wall(-GW / 2, GW / 2, 2.4, 0.0, GH, 400 + int(n_off),
                                                        skip=skip_above(stepped(GH, [(2.0, 6.5, 3.0)], 401), 0.0)))
    for u in (-GW / 2 + 1.1, GW / 2 - 1.1):
        mem += xf(frame_y(GX + u, GY), course_wall(-GD / 2 + 2.4, GD / 2 - 2.4, 2.2, 0.0, GH, 402 + int(u)))
    # gateway: three receding orders of voussoirs on the front face
    wg, hs = 5.0, 6.0
    for k, (dw, dn) in enumerate(((2.0, -0.45), (1.2, -0.15), (0.45, 0.15))):
        w_k = wg + dw * 2 - 0.9
        mem += arch_ring(F, w_k, hs, w_k * 0.82, 0.0, 0.5, -GD / 2 + dn - 0.2, -GD / 2 + dn + 1.0, 8, sill=False,
                         jamb_blocks=5, seed=410 + k)
    mem += arch_ring(F, wg, hs, wg * 0.82, 0.0, 0.6, GD / 2 - 1.4, GD / 2 + 0.15, 7, sill=False, seed=414)
    cut.append(opening_cutter(F, wg, hs, wg * 0.82, 0.0, depth=GD + 4))
    # flanking buttress turrets at the front corners, crenellations, a window above the gate
    for u in (-GW / 2 - 0.8, GW / 2 + 0.8):
        mem += xf(frame_x(GX + u, GY - GD / 2 + 1.4), S.course_blocks(-1.6, 1.6, -1.6, 1.6, 0.0, GH + 3.0, 1.0,
                                                                         420 + int(u), (1.4, 1.8), 2, gap=GAP))
        mem += xf(frame_x(GX + u, GY - GD / 2 + 1.4), merlons(-1.6, 1.6, 3.2, GH + 3.0, 421, h=1.4, w=0.9,
                                                               gap_w=0.5, missing=0.25))
    mem += xf(frame_x(GX, GY - GD / 2 + 0.6), merlons(-GW / 2 + 0.5, GW / 2 - 0.5, 0.8, GH, 430, missing=0.3,
                                                       keep=lambda x: not (1.5 < x < 7)))
    mem += arch_ring(frame_x(GX, GY - GD / 2 + 1.2), 1.6, 3.0, 1.6 * 0.85, 12.5, 0.5, -1.4, 1.4, 5, seed=431)
    cut.append(opening_cutter(frame_x(GX, GY - GD / 2 + 1.2), 1.6, 3.0, 1.6 * 0.85, 12.5))
    mem += string_course_rect(GX - GW / 2, GX + GW / 2, GY - GD / 2, GY + GD / 2, 10.5, 0.25, 0.35)
    parts.append(sculpt("gate", mem, cut, chips=60, target=26000))

# ---------- curtain walls (14 m + parapet) with breaches
CW, CHT = 2.4, 14.0
WALLS = [  # (frame, u0, u1, seed, collapses)
    ("cw_fl", frame_x(0, -10.0), -19.2, -9.0, 500, [(-17.0, -12.5, 6.0)]),
    ("cw_fr", frame_x(0, -10.0), 5.0, 18.0, 510, [(9.0, 14.0, 9.0)]),
    ("cw_e", frame_y(24.5, 0), -4.0, 20.0, 520, [(4.0, 10.0, 14.0), (14.0, 17.0, 4.0)]),
    ("cw_n", frame_x(0, 19.3), 8.5, 24.5, 530, [(15.0, 20.0, 5.0)]),
    ("cw_w", frame_y(-27.0, 0), -1.0, 19.3, 540, [(5.0, 9.0, 3.0)]),
]
if want("walls"):
    for name, F, u0, u1, seed, zones in WALLS:
        h = stepped(CHT, zones, seed)
        mem = xf(F, course_wall(u0, u1, CW, 0.0, CHT, seed, skip=skip_above(h, 0.0)))
        mem += xf(F @ T((0, -CW / 2 + 0.3, 0)), merlons(u0, u1, 0.6, CHT, seed + 1, missing=0.25,
                                                         keep=lambda x, h=h: h(x) >= CHT - 1e-3))
        # battered footing
        mem += xf(F, S.course_blocks(u0, u1, -CW / 2 - 0.35, CW / 2 + 0.35, 0.0, 1.6, 0.8, seed + 2, (2.0, 3.5), 1,
                                     gap=GAP))
        cut = []
        rng = random.Random(seed)
        for k in range(2):
            u = rng.uniform(u0 + 2, u1 - 2)
            cut.append(rect_cutter(F, 0.3, 1.8, rng.uniform(5, 9)) if rng.random() < 0.7 else
                       opening_cutter(F, 1.0, 1.6, 0.9, 8.0))
        L = u1 - u0
        parts.append(sculpt(name, mem, cut, chips=int(10 + L), target=int(800 + 300 * L)))

# ---------- chapel wall: tall traceried lancets between buttresses (north side of the bailey)
if want("chapel"):
    F = frame_x(0, 17.5)
    u0, u1 = -27.0, -4.5
    h = stepped(18.0, [(-22.0, -17.0, 5.0), (-11.0, -8.5, 2.0)], 600)
    mem = xf(F, course_wall(u0, u1, 1.6, 0.0, 18.0, 600, skip=skip_above(h, 0.0)))
    cut = []
    tr = []
    for k, u in enumerate((-23.5, -18.5, -13.5, -8.5)):
        Fu = F @ T((u, 0, 0))
        mem += arch_ring(Fu, 2.4, 6.5, 2.4 * 0.85, 4.0, 0.5, -0.95, 0.95, 6, jamb_blocks=4, seed=610 + k)
        cut.append(opening_cutter(Fu, 2.4, 6.5, 2.4 * 0.85, 4.0))
        tr += xf(Fu, [(0.28, 0.4, 7.4, T((0, 0, 4.0)))])
        for s in (-0.6, 0.6):
            tr += arch_ring(Fu @ T((s, 0, 0)), 0.92, 6.5, 0.92 * 0.85, 4.0, 0.16, -0.2, 0.2, 3, jambs=False,
                            sill=False)
    for u in (-26.0, -21.0, -16.0, -11.0, -6.0):    # buttresses on the outer (north) face
        mem += buttress(F, u, 0.8, 1.4, [(8.0, 1.6), (14.0, 1.0)], 620 + int(u))
    parts.append(sculpt("chapel", mem, cut, chips=40, target=16000))
    parts.append(sculpt("chapel_tr", tr, (), chips=6, target=2500, voxel=0.045))

# ---------- viaduct wing: pointed arches on tall piers east of the square tower, last span fallen
VY, VD, ZD = -8.0, 5.0, 15.5
if want("viaduct"):
    mem, cut = [], []
    F = frame_x(0, VY)
    piers = [26.0, 35.0, 44.0, 53.0]
    pw, wspan, hs = 2.6, 6.4, 7.5
    for i, x in enumerate(piers):
        top = hs if i < 3 else 9.0
        mem += xf(F, S.course_blocks(x - pw / 2 - (0 if i else -0.4), x + pw / 2, -VD / 2, VD / 2, 0.0, top, 1.0,
                                     700 + i, (1.1, 1.6), 2, gap=GAP))
        # cutwater-like buttress ribs on both faces
        if i < 3:
            for s in (-1, 1):
                mem += xf(F, S.course_blocks(x - 0.7, x + 0.7, s * VD / 2 - 0.3 if s > 0 else -VD / 2 - 1.2,
                                             VD / 2 + 1.2 if s > 0 else -VD / 2 + 0.3, 0.0, hs + 3.0, 1.0, 710 + i * 2 + s,
                                             (1.5, 1.6), 1, gap=GAP))
    rings = []
    for i in range(3):
        xc = (piers[i] + piers[i + 1]) / 2
        ring = arch_ring(F @ T((xc, 0, 0)), wspan, hs, wspan * 0.8, 0.0, 0.85, -VD / 2, VD / 2, 7, jambs=False,
                         sill=False, seed=720 + i)
        if i == 2:
            ring = ring[10:14]    # a few voussoirs of the fallen arch cling to the haunch over pier 3
        rings += ring
    parts.append(sculpt("viaduct_arches", rings, (), chips=24, target=6500, voxel=0.06))
    # spandrel + deck walls over the two standing arches
    hdeck = stepped(ZD + 1.6, [(43.0, 50.0, 6.0)], 730)
    mem += xf(F, S.course_blocks(25.0, 45.5, -VD / 2, VD / 2, hs, ZD, 1.0, 731, (1.8, 3.2), 2, gap=GAP,
                                 skip=lambda c, a, b, ya, yb: hs + (c + 1) * 1.0 > hdeck((a + b) / 2) + 1e-3))
    for i in range(2):
        xc = (piers[i] + piers[i + 1]) / 2
        cut.append(opening_cutter(F @ T((xc, 0, 0)), wspan + 1.7, hs, wspan * 0.8 + 0.85, 0.0, depth=12))
    # parapets on the deck
    for s in (-1, 1):
        mem += xf(F, S.course_blocks(25.0, 44.0, s * VD / 2 - (0.6 if s > 0 else 0), s * VD / 2 + (0 if s > 0 else 0.6),
                                     ZD, ZD + 1.4, 0.7, 740 + s, (1.6, 2.6), 1, gap=GAP,
                                     skip=lambda c, a, b, ya, yb: ZD + (c + 1) * 0.7 > hdeck((a + b) / 2) + 1e-3))
    mem += xf(F, S.course_blocks(25.0, 45.0, -VD / 2 - 0.25, VD / 2 + 0.25, ZD - 0.4, ZD, 0.4, 750, (1.6, 2.4), 1,
                                 gap=GAP, skip=lambda c, a, b, ya, yb: ZD > hdeck((a + b) / 2)))
    cut.append(S.break_cutter(V((53.0, VY, 7.5)), V((0.6, 0.15, 1)), 10, 0.6, 760, res=0.18, scale=0.6))
    parts.append(sculpt("viaduct", mem, cut, chips=50, target=19000))

# ---------- fallen masonry in the bailey and under the viaduct
if want("rubble"):
    rng = random.Random(800)
    for k, (x, y, s) in enumerate(((-15.0, -14.5, 1.0), (11.0, -13.5, 1.2), (49.0, -5.0, 1.4), (50.0, -11.5, 1.1),
                                   (21.0, 6.0, 1.0), (-20.0, 13.0, 0.9))):
        d = (1.8 * s, 1.0 * s, 0.9 * s)
        o = S.sculpt(f"rb{k}", [(d[0], d[1], d[2], Matrix())], 0.05, 0.08, (), 8, CHIP, 810 + k, target=2400,
                     ero=(0.05, 1.5), flake_depth=(0.02, 0.05), face_rr=(0.4, 0.8))
        S.transform(o, T((x, y, 0)) @ R(rng.uniform(0, 3), 4, "Z") @ R(rng.uniform(-0.4, 0.4), 4, "X") @ T((0, 0, -d[2] / 2)))
        zmin = min(v.co.z for v in o.data.vertices)
        S.transform(o, T((0, 0, -zmin - 0.12 * d[2])))
        S.ground_cut(o)
        S.decimate(o, 600)
        parts.append(o)

print("\nPART TRIS:", [(p.name, S.tris(p)) for p in parts])
o = S.join("Castle_Ruin", parts)
S.finalize(o, ao_dist=7.0, eps=0.02, rays=20, seed=9, moss_low=2.0, moss_scale=0.25, speck=0.6)
print(f"\nCASTLE SUMMARY  Castle_Ruin {S.tris(o)} tris dims=({o.dimensions.x:.2f},{o.dimensions.y:.2f},{o.dimensions.z:.2f})")
S.export([o], OUT)
