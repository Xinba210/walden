"""Roman-style stone aqueduct / bridge -> game/public/models/world2/aqueduct.glb

  blender -b --factory-startup --python scripts/world2/aqueduct_build.py -- [out.glb] [only=Aqueduct_Seg]

Aqueduct_Seg: modular 30 m segment (x = -15..15, tiles end-to-end: half piers at both ends), 3 arches on coursed
ashlar piers with plinths, impost bands and putlog stones; triple voussoir rings; coursed spandrel wall; splayed
cornice; water channel with parapet walls and cover slabs, partly ruined.
Aqueduct_End: the broken terminal piece (tiles to a Seg on its -X end): one arch, then a collapsed arch, a broken
pier stepping down and a rubble spill. Origins at base centre, z=0.
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Vector, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stonelib as S

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = next((a for a in argv if a.endswith(".glb")), os.path.join(ROOT, "game/public/models/world2/aqueduct.glb"))
ONLY = next((a[5:].split(",") for a in argv if a.startswith("only=")), None)

S.reset()
T = Matrix.Translation
R = Matrix.Rotation
V = Vector

PW, PD = 3.0, 3.6          # pier width (x) / depth (y)
ZS = 12.0                  # springing line
RI, RO = 3.5, 4.5          # arch radii (span 7 m)
CH = 0.6                   # course height
ZC = 16.8                  # top of spandrel wall / cornice base
WD = 3.4                   # spandrel wall depth
VOX = 0.035
CHIP = (0.08, 0.24)


def pier(name, xa, xb, seed, top=ZS, target=8000, broken=None, end_faces=()):
    """Coursed pier occupying x in [xa, xb]; plinth courses + impost band; broken=(z, normal) jagged top."""
    rng = random.Random(seed)
    mem = []
    # plinth: two projecting courses
    mem += S.course_blocks(max(xa - 0.18, -15.0), min(xb + 0.18, 15.0), -PD / 2 - 0.18, PD / 2 + 0.18, 0.0, 1.2, CH,
                           seed, (1.0, 1.7), 2, gap=0.05)
    hi = min(top, ZS - 0.4)
    mem += S.course_blocks(xa, xb, -PD / 2, PD / 2, 1.2, hi, CH, seed + 1, (0.9, 1.6), 2, gap=0.05)
    if top >= ZS:
        mem += S.course_blocks(max(xa - 0.16, -15.0), min(xb + 0.16, 15.0), -PD / 2 - 0.16, PD / 2 + 0.16, ZS - 0.4,
                               ZS, 0.4, seed + 2,
                               (1.2, 1.9), 2, gap=0.05)
    # putlog stones (projecting scaffold supports) on the faces
    for z in (5.4, 9.0):
        for sy in (-1, 1):
            if rng.random() < 0.8:
                xc = (xa + xb) / 2 + rng.uniform(-0.5, 0.5)
                mem.append((0.42, 0.7, 0.42, T((xc, sy * (PD / 2 + 0.12), z))))
    cut = []
    if broken:
        bz, nrm = broken
        cut.append(S.break_cutter(V(((xa + xb) / 2, 0, bz)), nrm, 7.0, 0.45, seed + 5, res=0.07, scale=0.9))
    return S.sculpt(name, mem, VOX, 0.05, cut, 26, CHIP, seed, target=target, ero=(0.035, 1.2),
                    mid=(0.015, 0.25), fine=(0.008, 0.06), flakes=12, face_rr=(0.3, 0.6), zmin=0.3)


def arch(name, xc, seed, keep=None, target=3600):
    mem = []
    ys = [-PD / 2, -PD / 6, PD / 6, PD / 2]
    for r in range(3):
        mem += S.voussoir_ring(xc, ZS, RI, RO, ys[r] + 0.025, ys[r + 1] - 0.025, 17, seed + r,
                               keep=keep(r) if keep else None, key_extra=0.15 if r != 1 else 0.0,
                               offset=0.5 if r == 1 else 0.0, jit=0.03, gap=0.065)
    return S.sculpt(name, mem, VOX, 0.05, (), 20, CHIP, seed, target=target, ero=(0.03, 1.0), mid=(0.012, 0.25),
                    fine=(0.008, 0.06), flakes=6, face_rr=(0.3, 0.6))


def upper_wall(name, xa, xb, arches_x, seed, skip=None, breaks=(), target=3000):
    mem = S.course_blocks(xa, xb, -WD / 2, WD / 2, ZS, ZC, CH, seed, (1.1, 1.9), 2, gap=0.05, skip=skip)
    cut = [S.cyl_cutter_y(x, ZS, RO - 0.05) for x in arches_x] + list(breaks)
    return S.sculpt(name, mem, VOX, 0.05, cut, 16, CHIP, seed, target=target, ero=(0.035, 1.2), mid=(0.015, 0.25),
                    fine=(0.008, 0.06), flakes=8, face_rr=(0.3, 0.6))


def cornice(name, xa, xb, seed, gaps=(), target=2600):
    rng = random.Random(seed)
    mem = []
    x = xa
    z, h = ZC, 0.42
    while x < xb - 1e-3:
        L = min(rng.uniform(1.4, 2.2), xb - x)
        if xb - (x + L) < 0.6:
            L = xb - x
        if not any(g0 < x + L / 2 < g1 for g0, g1 in gaps):
            db, dt = WD + 0.05, WD + 0.5
            y = rng.uniform(-0.02, 0.02)
            a, b = x + 0.025, x + L - 0.025
            mem.append(S.hexa_bm([V((a, -db / 2 + y, z)), V((b, -db / 2 + y, z)), V((b, db / 2 + y, z)),
                                  V((a, db / 2 + y, z)), V((a, -dt / 2 + y, z + h)), V((b, -dt / 2 + y, z + h)),
                                  V((b, dt / 2 + y, z + h)), V((a, dt / 2 + y, z + h))]))
        x += L
    return S.sculpt(name, mem, VOX, 0.04, (), 14, CHIP, seed, target=target, ero=(0.03, 1.0), flakes=4)


def channel(name, xa, xb, seed, wall_top=lambda x, side: 2.2, slabs=lambda x: True, target=6500):
    """Water channel on top of the cornice: two parapet walls + cover slabs. wall_top(x, side) -> remaining height."""
    rng = random.Random(seed)
    z0 = ZC + 0.42
    mem = []
    for side in (-1, 1):
        y0, y1 = (-1.55, -0.75) if side < 0 else (0.75, 1.55)
        mem += S.course_blocks(xa, xb, y0, y1, z0, z0 + 2.2, 0.55, seed + side, (0.8, 1.4), 1, gap=0.04,
                               skip=lambda c, a, b, ya, yb, s=side: (c + 1) * 0.55 > wall_top((a + b) / 2, s) + 1e-3)
    # channel floor
    mem += S.course_blocks(xa, xb, -0.75, 0.75, z0, z0 + 0.3, 0.3, seed + 7, (1.0, 1.6), 1, gap=0.04)
    # cover slabs
    x = xa
    while x < xb - 0.3:
        L = rng.uniform(0.9, 1.25)
        xc = x + L / 2
        if slabs(xc) and min(wall_top(xc, -1), wall_top(xc, 1)) >= 2.2 - 1e-3:
            M = T((xc + rng.uniform(-0.03, 0.03), rng.uniform(-0.05, 0.05), z0 + 2.2)) @ R(rng.uniform(-0.03, 0.03), 4, "Z")
            mem.append((min(L, xb - x) - 0.05, 3.3, 0.36, M))
        x += L
    return S.sculpt(name, mem, VOX, 0.04, (), 20, (0.06, 0.18), seed, target=target, ero=(0.03, 1.0), flakes=8,
                    face_rr=(0.25, 0.5))


def rubble(name, blocks, seed, target=3000):
    """Fallen blocks lying on the ground: list of (dims, (x, y), rz, tilt)."""
    parts = []
    for k, (d, (x, y), rz, tilt) in enumerate(blocks):
        o = S.sculpt(f"{name}{k}", [(d[0], d[1], d[2], Matrix())], VOX, 0.05, (), 8, CHIP, seed + k,
                     target=target // len(blocks) * 4, ero=(0.035, 1.0))
        S.transform(o, T((x, y, 0)) @ R(rz, 4, "Z") @ R(tilt, 4, "Y") @ T((0, 0, -d[2] / 2)))
        zmin = min(v.co.z for v in o.data.vertices)
        S.transform(o, T((0, 0, -zmin - d[2] * 0.12)))
        S.ground_cut(o)
        S.decimate(o, target // len(blocks))
        parts.append(o)
    return parts


objs = []

# ------------------------------------------------------------------ Aqueduct_Seg (x -15..15, tiles)
if ONLY is None or "Aqueduct_Seg" in ONLY:
    parts = []
    piers = [(-15.0, -15.0 + PW / 2), (-5 - PW / 2, -5 + PW / 2), (5 - PW / 2, 5 + PW / 2), (15 - PW / 2, 15.0)]
    for i, (a, b) in enumerate(piers):
        half = i in (0, 3)
        parts.append(pier(f"p{i}", a, b, 500 + i, target=4300 if half else 8000))
    for i, xc in enumerate((-10.0, 0.0, 10.0)):
        parts.append(arch(f"a{i}", xc, 600 + i))
    for i, (a, b) in enumerate(((-15.0, -5.0), (-5.06, 5.0), (4.94, 15.0))):
        parts.append(upper_wall(f"w{i}", a, b, [(a + b) / 2 + (0.03 if i == 1 else 0.0)], 700 + i))
    parts.append(cornice("cn", -15.0, 15.0, 800, gaps=[(8.2, 9.6)]))

    def wtop(x, side):          # parapet partly fallen in two places
        if side < 0 and -9.0 < x < -4.5:
            return 1.1 if x < -6.5 else 0.55
        if side > 0 and 6.0 < x < 11.5:
            return 0.0 if 7.5 < x < 10.3 else 1.1
        return 2.2

    parts.append(channel("ch", -15.0, 15.0, 900, wtop, slabs=lambda x: not (-2.0 < x < 0.5 or 12.5 < x < 13.8)))
    o = S.join("Aqueduct_Seg", parts)
    objs.append(S.finalize(o, origin="z", ao_dist=5.0, eps=0.01, seed=7, moss_low=1.5, moss_scale=0.35, speck=0.3))

# ------------------------------------------------------------------ Aqueduct_End (x -15..~9, tiles on -X)
if ONLY is None or "Aqueduct_End" in ONLY:
    parts = []
    parts.append(pier("p0", -15.0, -15.0 + PW / 2, 520, target=4300))
    parts.append(pier("p1", -5 - PW / 2, -5 + PW / 2, 521))
    # last pier broken off ~8 m up, stepping down outward
    parts.append(pier("p2", 5 - PW / 2, 5 + PW / 2, 522, top=10.6, broken=(8.2, V((0.55, 0.1, 1))), target=6500))
    parts.append(arch("a0", -10.0, 620))
    # collapsed arch: only the haunch over pier 1 still hangs on (different extent per ring)
    parts.append(arch("a1", 0.0, 621, keep=lambda r: range(0, (5, 4, 6)[r]), target=1500))

    brk = S.break_cutter(V((-2.6, 0, 14.0)), V((1, 0.12, 0.65)), 9.0, 0.5, 731, res=0.08, scale=0.8)
    parts.append(upper_wall("w0", -15.0, -5.0, [-10.0], 720))
    parts.append(upper_wall("w1", -5.06, 1.0, [0.0], 721, breaks=[brk],
                            skip=lambda c, a, b, ya, yb: a > -1.5 - c * 0.35, target=2000))
    parts.append(cornice("cn", -15.0, -3.2, 820))
    parts.append(channel("ch", -15.0, -3.6, 920, lambda x, s: 2.2 if x < -6.0 - (1.2 if s > 0 else 0) else 1.1,
                         slabs=lambda x: x < -7.5, target=3800))
    parts += rubble("rb", [((1.6, 1.0, 0.7), (6.8, -2.6), 0.5, 0.15), ((1.3, 1.7, 0.6), (8.4, 0.8), 1.2, -0.25),
                           ((1.2, 0.7, 0.65), (3.0, -3.4), -0.4, 0.4), ((1.5, 0.9, 0.6), (1.2, 2.6), 0.9, 0.0),
                           ((0.9, 0.8, 0.6), (9.8, -1.2), 2.0, 0.6)], 940, target=3500)
    o = S.join("Aqueduct_End", parts)
    objs.append(S.finalize(o, origin="z", ao_dist=5.0, eps=0.01, seed=8, moss_low=1.5, moss_scale=0.35, speck=0.3))

print("\nAQUEDUCT SUMMARY")
for o in objs:
    print(f"  {o.name:14s} {S.tris(o):7d} tris  dims=({o.dimensions.x:.2f},{o.dimensions.y:.2f},{o.dimensions.z:.2f})")
S.export(objs, OUT)
