"""Ruined classical arcade/colonnade -> game/public/models/world2/colonnade.glb

  blender -b --factory-startup --python scripts/world2/colonnade_build.py -- [out.glb] [only=Colonnade_A]

Colonnade_A: 7 round columns (drums, moulded bases, flared capitals) carrying voussoir arches, coursed spandrels and
an architrave / frieze / cornice entablature; the right half has collapsed (half arch, stumps, fallen drums).
Colonnade_B: a shorter 3-column fragment. Origin at base centre, z=0.
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Vector, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stonelib as S

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = next((a for a in argv if a.endswith(".glb")), os.path.join(ROOT, "game/public/models/world2/colonnade.glb"))
ONLY = next((a[5:].split(",") for a in argv if a.startswith("only=")), None)

S.reset()
T = Matrix.Translation
R = Matrix.Rotation
V = Vector

SP = 3.9                     # column spacing
PL_H, BASE_H, SHAFT, ECH_H, ABA_H = 0.32, 0.22, 3.75, 0.22, 0.2
ZS = PL_H + BASE_H + SHAFT + ECH_H + ABA_H   # springing line = top of abacus (4.71)
RI = (SP - 1.1) / 2          # arch intrados radius
RO = RI + 0.55               # extrados
AD = 0.86                    # arch / wall depth
COURSE = 0.5
ZE = ZS + RO + 0.05          # entablature base
VOX = 0.02


def shaft_r(z):              # entasis: 0.42 at the foot -> 0.355 at the top
    t = max(0.0, min(1.0, z / SHAFT))
    return 0.42 - 0.065 * t ** 1.4


def column(name, x, seed, brk=None, target=4200):
    rng = random.Random(seed)
    mem = [(1.15, 1.15, PL_H, T((x, 0, 0)) @ R(rng.uniform(-0.03, 0.03), 4, "Z"))]
    mem.append(S.cyl_bm(0.54, 0.5, 0.13, 28, T((x, 0, PL_H))))
    mem.append(S.cyl_bm(0.47, 0.44, 0.09, 28, T((x, 0, PL_H + 0.13))))
    z = 0.0
    z0 = PL_H + BASE_H
    top = SHAFT if brk is None else brk - z0 + 0.35
    while z < top - 1e-3:
        h = min(rng.uniform(0.85, 1.3), SHAFT - z)
        if SHAFT - z - h < 0.5:
            h = SHAFT - z
        M = T((x + rng.uniform(-0.012, 0.012), rng.uniform(-0.012, 0.012), z0 + z)) @ R(rng.uniform(0, 6), 4, "Z")
        mem.append(S.cyl_bm(shaft_r(z), shaft_r(z + h), h, 28, M))
        z += h
    cut = []
    if brk is None:
        mem.append(S.cyl_bm(0.37, 0.53, ECH_H, 28, T((x, 0, z0 + SHAFT))))
        mem.append((1.1, 1.1, ABA_H, T((x, 0, z0 + SHAFT + ECH_H)) @ R(rng.uniform(-0.02, 0.02), 4, "Z")))
    else:
        cut.append(S.break_cutter(V((x, 0, brk)), V((rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4), 1)), 1.6, 0.18,
                                  seed, res=0.035))
    crk = []
    if rng.random() < 0.6:
        cz = rng.uniform(1.2, (brk or ZS) - 0.8)
        a = rng.uniform(0, 6.28)
        crk.append((V((x + math.cos(a) * 0.4, math.sin(a) * 0.4, cz)), V((0.15, 0.1, 1)),
                    V((-math.sin(a), math.cos(a), 0)), 0.35, 0.35, 0.02, 0.04, 0.04))
    return S.sculpt(name, mem, VOX, 0.03, cut, 14, (0.05, 0.16), seed, target=target, cracks=crk, zmin=0.05,
                    ero=(0.025, 0.7))


def voussoir_pts(xc, k, n, ri, ro, d, zs=ZS, extra=0.0):
    a0, a1 = math.pi * k / n, math.pi * (k + 1) / n
    ro2 = ro + extra
    P = lambda a, r, y: V((xc - math.cos(a) * r, y, zs + math.sin(a) * r))
    return [P(a0, ri, -d / 2), P(a1, ri, -d / 2), P(a1, ro2, -d / 2), P(a0, ro2, -d / 2),
            P(a0, ri, d / 2), P(a1, ri, d / 2), P(a1, ro2, d / 2), P(a0, ro2, d / 2)]


def arch(name, xc, seed, keep=None, n=13, target=3000):
    rng = random.Random(seed)
    mem = []
    for k in range(n):
        if keep is not None and k not in keep:
            continue
        key = k == n // 2
        pts = voussoir_pts(xc, k, n, RI, RO, AD + (0.08 if key else 0.0), extra=0.12 if key else 0.0)
        jit = V((rng.uniform(-0.012, 0.012), rng.uniform(-0.025, 0.025), rng.uniform(-0.012, 0.0)))
        sh = 0.985   # each voussoir slightly narrower than its slot -> visible joints
        c = sum(pts, V()) / 8
        mem.append(S.hexa_bm([c + (p - c) * V((sh, 1.0, sh)) + jit for p in pts]))
    return S.sculpt(name, mem, 0.018, 0.04, (), 12, (0.05, 0.14), seed, target=target, ero=(0.02, 0.6),
                    flakes=3)


def wall_courses(x0, x1, z0, ncourse, seed, depth=AD, missing=lambda c, xa, xb: False, lmin=0.8, lmax=1.45):
    rng = random.Random(seed)
    mem = []
    for c in range(ncourse):
        x = x0 - (rng.uniform(0, 0.6) if c % 2 else 0.0)
        while x < x1 - 0.05:
            L = rng.uniform(lmin, lmax)
            xa, xb = max(x, x0), min(x + L, x1)
            if xb - xa > 0.25 and not missing(c, xa, xb):
                M = T(((xa + xb) / 2 + rng.uniform(-0.01, 0.01), rng.uniform(-0.015, 0.015), z0 + c * COURSE)) \
                    @ R(rng.uniform(-0.008, 0.008), 4, "Z")
                mem.append((xb - xa - 0.02, depth + rng.uniform(-0.03, 0.01), COURSE - 0.018, M))
            x += L
    return mem


def entablature(x0, x1, seed, layers=("arch", "frieze", "fascia", "cornice"), cut_right=None):
    """Blocks of the entablature between x0..x1 (layers can be truncated with (layer, xmax))."""
    rng = random.Random(seed)
    spec = {"arch": (0.5, 0.92, 1.95, 2.2), "frieze": (0.42, 0.84, 1.1, 1.6), "fascia": (0.12, 0.98, 1.4, 1.9),
            "cornice": (0.34, 1.26, 1.0, 1.4)}
    mem = []
    z = ZE
    for lay in ("arch", "frieze", "fascia", "cornice"):
        h, d, lmin, lmax = spec[lay]
        xmax = x1
        for item in layers:
            if isinstance(item, tuple) and item[0] == lay:
                xmax = item[1]
        present = lay in layers or any(isinstance(i, tuple) and i[0] == lay for i in layers)
        if present:
            x = x0 - rng.uniform(0, 0.5)
            while x < xmax - 0.05:
                L = rng.uniform(lmin, lmax)
                xa, xb = max(x, x0), min(x + L, xmax)
                if xb - xa > 0.2:
                    if lay == "cornice":       # splayed (cavetto-like) cornice: narrow soffit, wide crown
                        yj = rng.uniform(-0.01, 0.01)
                        db, dt = d * 0.82, d
                        mem.append(S.hexa_bm([V((xa, -db / 2 + yj, z)), V((xb, -db / 2 + yj, z)),
                                              V((xb, db / 2 + yj, z)), V((xa, db / 2 + yj, z)),
                                              V((xa, -dt / 2 + yj, z + h)), V((xb, -dt / 2 + yj, z + h)),
                                              V((xb, dt / 2 + yj, z + h)), V((xa, dt / 2 + yj, z + h))]))
                    else:
                        M = T(((xa + xb) / 2, rng.uniform(-0.012, 0.012), z)) @ R(rng.uniform(-0.006, 0.006), 4, "Z")
                        mem.append((xb - xa - 0.02, d, h, M))
                x += L
        z += h
    return mem


def spandrel_cutters(xcs, seed):
    out = []
    for xc in xcs:
        out.append(S.cyl_bm(RO - 0.04, RO - 0.04, 3.0, 64, T((xc, 1.5, ZS)) @ R(math.pi / 2, 4, "X")))
    return out


def rubble_drum(name, at, rz, seed, r=0.4, h=1.05, target=1300):
    o = S.sculpt(name, [S.cyl_bm(r, r * 0.97, h, 24)], VOX, 0.03, [], 8, (0.05, 0.14), seed, target=target * 4)
    S.transform(o, T(at) @ R(rz, 4, "Z") @ R(math.pi / 2, 4, "Y") @ T((0, 0, -h / 2)))
    S.transform(o, T((0, 0, r * 0.88 - at[2])))
    S.ground_cut(o)
    S.decimate(o, target)
    return o


def rubble_block(name, dims, at, rot, seed, target=1100):
    sx, sy, sz = dims
    o = S.sculpt(name, [(sx, sy, sz, Matrix())], VOX, 0.03, [], 10, (0.05, 0.15), seed, target=target * 4)
    S.transform(o, T(at) @ rot @ T((0, 0, -sz / 2)))
    zmin = min(v.co.z for v in o.data.vertices)
    S.transform(o, T((0, 0, -zmin - sz * 0.08)))
    S.ground_cut(o)
    S.decimate(o, target)
    return o


def bay_upper(name, xa, xb, seed, wall_missing=lambda c, a, b: False, ent_layers=None, breaks=(), arches=(),
              target=5200):
    mem = wall_courses(xa, xb, ZS, 4, seed, missing=wall_missing)
    if ent_layers:
        mem += entablature(xa, xb, seed + 1, ent_layers)
    cut = spandrel_cutters(arches, seed) + list(breaks)
    return S.sculpt(name, mem, 0.022, 0.03, cut, 18, (0.05, 0.16), seed, target=target, ero=(0.025, 0.7),
                    flakes=6)


objs = []

# ------------------------------------------------------------------ Colonnade_A
if ONLY is None or "Colonnade_A" in ONLY:
    X = [-3 * SP + i * SP for i in range(7)]
    parts = []
    for i, x in enumerate(X):
        brk = {5: 2.9, 6: 1.35}.get(i)
        parts.append(column(f"c{i}", x, 100 + i, brk=brk, target=4200 if brk is None else (2600 if brk > 2 else 1700)))
    # arches: bays 0-2 whole, bay 3 only the left haunch survives
    for b in range(3):
        parts.append(arch(f"a{b}", (X[b] + X[b + 1]) / 2, 200 + b))
    parts.append(arch("a3", (X[3] + X[4]) / 2, 203, keep=range(0, 3), target=800))
    # bay 0-1: spandrel + full entablature, broken off at the left end
    lb = S.break_cutter(V((X[0] + 0.35, 0, ZE)), V((-1, 0.15, 0.2)), 4.0, 0.2, 301, res=0.05)
    parts.append(bay_upper("u01", X[0], X[2], 300, ent_layers=("arch", "frieze", "fascia", "cornice"),
                           breaks=[lb], arches=[(X[0] + X[1]) / 2, (X[1] + X[2]) / 2], target=9000))
    # bay 2: wall complete, architrave, frieze for 60 %, cornice gone; stepped break on the right
    rb = S.break_cutter(V((X[3] - 0.2, 0, ZE + 0.6)), V((1, -0.1, 0.55)), 4.0, 0.2, 302, res=0.05)
    parts.append(bay_upper("u2", X[2] - 0.07, X[3], 310, ent_layers=("arch", ("frieze", X[2] + 2.6)),
                           breaks=[rb], arches=[(X[2] + X[3]) / 2], target=4200))
    # bay 3: only the lower courses over column 3 remain, stepping down to the right
    parts.append(bay_upper("u3", X[3] - 0.07, X[4], 320, wall_missing=lambda c, a, b: a > X[3] + 1.25 - c * 0.35 or c > 2,
                           arches=[(X[3] + X[4]) / 2],
                           breaks=[S.break_cutter(V((X[3] + 1.0, 0, ZS + 1.2)), V((1, 0.1, 0.8)), 3, 0.15, 321,
                                                  res=0.04)], target=1600))
    # fallen pieces
    parts.append(rubble_drum("r0", V((X[5] + 1.1, -1.6, 0)), 0.5, 401))
    parts.append(rubble_drum("r1", V((X[6] - 0.6, 1.5, 0)), 2.1, 402, h=0.9))
    parts.append(rubble_block("r2", (1.4, 0.9, 0.5), V((X[4] + 1.6, -1.9, 0)), R(0.4, 4, "Z") @ R(0.12, 4, "Y"), 403))
    parts.append(rubble_block("r3", (0.62, 0.86, 0.55), V((X[3] + 2.2, 1.3, 0)), R(1.2, 4, "Z") @ R(0.5, 4, "X"),
                              404, target=800))
    o = S.join("Colonnade_A", parts)
    objs.append(S.finalize(o, ao_dist=3.0, seed=5, moss_low=0.5))

# ------------------------------------------------------------------ Colonnade_B
if ONLY is None or "Colonnade_B" in ONLY:
    X = [-SP, 0.0, SP]
    parts = [column("c0", X[0], 150), column("c1", X[1], 151), column("c2", X[2], 152, brk=3.4, target=2900)]
    parts.append(arch("a0", (X[0] + X[1]) / 2, 250))
    parts.append(arch("a1", (X[1] + X[2]) / 2, 251, keep=range(0, 4), target=1000))
    lb = S.break_cutter(V((X[0] + 0.5, 0, ZE)), V((-1, -0.2, 0.35)), 4.0, 0.22, 351, res=0.05)
    rb = S.break_cutter(V((X[1] + 0.9, 0, ZS + 1.0)), V((1, 0.15, 0.7)), 4.0, 0.2, 352, res=0.05)
    parts.append(bay_upper("u0", X[0], X[1] + 1.6, 350,
                           wall_missing=lambda c, a, b: a > X[1] + 0.8 - c * 0.3,
                           ent_layers=("arch", ("frieze", X[1] - 0.3), ("fascia", X[0] + 2.0), ("cornice", X[0] + 1.6)),
                           breaks=[lb, rb], arches=[(X[0] + X[1]) / 2, (X[1] + X[2]) / 2], target=6500))
    parts.append(rubble_drum("r0", V((X[2] + 1.3, -1.4, 0)), 0.9, 451))
    parts.append(rubble_drum("r1", V((X[2] + 0.3, 1.7, 0)), -0.4, 452, h=1.2))
    parts.append(rubble_block("r2", (1.3, 1.15, 0.33), V((X[0] - 1.3, -1.5, 0)), R(0.3, 4, "Z") @ R(0.1, 4, "X"),
                              453))
    o = S.join("Colonnade_B", parts)
    objs.append(S.finalize(o, ao_dist=3.0, seed=6, moss_low=0.5))

print("\nCOLONNADE SUMMARY")
for o in objs:
    print(f"  {o.name:14s} {S.tris(o):7d} tris  dims=({o.dimensions.x:.2f},{o.dimensions.y:.2f},{o.dimensions.z:.2f})")
S.export(objs, OUT)
