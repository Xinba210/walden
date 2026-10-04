"""Ruins kit -> game/public/models/world2/ruins_kit.glb

  blender -b --factory-startup --python scripts/world2/ruins_build.py -- [out.glb] [only=Gate,Pillar,...]

Gate_A/B/C, Pillar_0..3, Slab_0..2, Block_0..4, PathStone_0..5. Each object: origin at base centre, on z=0.
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Vector, Matrix, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stonelib as S

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = next((a for a in argv if a.endswith(".glb")), os.path.join(ROOT, "game/public/models/world2/ruins_kit.glb"))
ONLY = next((a[5:].split(",") for a in argv if a.startswith("only=")), None)

S.reset()
T = Matrix.Translation
R = Matrix.Rotation
V = Vector


def want(name):
    return ONLY is None or any(name.startswith(p) for p in ONLY)


VOX = 0.014
POST = 0.62


def post_member(name, x, h, seed, plinth=True, split=None, cracks=(), cut_top=None, lean=None, target=3600,
                chips=14):
    """Square post (optionally of two stacked stones) standing on a plinth block at x."""
    rng = random.Random(seed)
    mem = []
    z0 = 0.0
    if plinth:
        ph = 0.34
        mem.append((0.98, 0.98, ph, T((x, 0, 0)) @ R(rng.uniform(-0.04, 0.04), 4, "Z")))
        z0 = ph
    if split:
        h1 = split
        mem.append((POST, POST, h1, T((x, 0, z0))))
        mem.append((POST - 0.02, POST - 0.01, h - z0 - h1,
                    T((x + rng.uniform(-0.02, 0.02), rng.uniform(-0.02, 0.02), z0 + h1)) @ R(rng.uniform(-0.03, 0.03), 4, "Z")))
    else:
        mem.append((POST, POST, h - z0, T((x, 0, z0))))
    cutters = []
    crk = []
    for (cz, side, Lv, hw, dep, tilt) in cracks:   # crack across the post face at height cz, wrapping Lv around
        y = -POST / 2 if side < 0 else POST / 2
        crk.append((V((x + rng.uniform(-0.06, 0.06), y, cz)), V((0, 0, 1)) + V((tilt * 0.3, 0, 0)), V((1, 0, tilt)),
                    POST * 0.75, Lv, hw, dep, 0.035))
    if cut_top:
        tz, nx, ny, amp = cut_top
        cutters.append(S.break_cutter(V((x, 0, tz)), V((nx, ny, 1)), 1.6, amp, seed + 3, res=0.03))
    o = S.sculpt(name, mem, VOX, 0.026, cutters, chips, (0.05, 0.18), seed, target=target * 6 if lean else target,
                 cracks=crk)
    if lean:
        ang, axis, piv = lean
        S.transform(o, T(piv) @ R(ang, 4, axis) @ T(-piv))
        S.ground_cut(o)
        S.decimate(o, target)
    return o


def lintel_member(name, length, h, d, at, seed, rot=Matrix(), breaks=(), target=3200, chips=14, cracks=(),
                  ground=False):
    """Horizontal beam along X, base-centred local frame then placed by T(at) @ rot."""
    mem = [(length, d, h, Matrix())]
    cut = []
    for (bx, sgn, amp, tilt) in breaks:   # break at local x=bx removing the side sgn*X beyond it
        cut.append(S.break_cutter(V((bx, 0, h / 2)), V((sgn, tilt, 0.15 * random.Random(seed).uniform(-1, 1))),
                                  2.0, amp, seed + int(bx * 7) + 11, res=0.03))
    crk = []
    for (cx, side, Lv, hw, dep) in cracks:     # vertical crack running down from the top (side>0) / up from below
        crk.append((V((cx, 0, h if side > 0 else 0)), V((1, 0.12, 0)), V((0, 1, 0)), d * 0.75, Lv, hw, dep, 0.035))
    o = S.sculpt(name, mem, VOX, 0.03, cut, chips, (0.05, 0.19), seed, target=target * 5 if ground else target,
                 cracks=crk)
    S.transform(o, T(at) @ rot)
    if ground:
        S.ground_cut(o)
        S.decimate(o, target)
    return o


objs = []

# ------------------------------------------------------------------ gates
W2 = 1.52          # post centre offset from gate centre
HP = 3.95          # post top
LH, LD = 0.62, 0.78  # lintel height / depth

if want("Gate_A"):
    parts = [post_member("pa", -W2, HP, 11, split=2.25, cracks=[(1.2, -1, 0.3, 0.02, 0.035, 0.2)]),
             post_member("pb", W2, HP, 12, split=1.7)]
    parts.append(lintel_member("la", 4.45, LH, LD, (0, 0, HP), 13))
    # tie beam (nuki) between the posts, slightly recessed
    parts.append(lintel_member("ta", 2.95, 0.38, 0.34, (0, 0.02, 3.05), 14, target=1500, chips=6))
    objs.append(S.finalize(S.join("Gate_A", parts), seed=1))

if want("Gate_B"):
    parts = [post_member("pa", -W2, HP, 21, split=2.6),
             # right post: cracked through, with a second hairline crack
             post_member("pb", W2, HP, 22, target=3300, cracks=[(1.75, -1, 0.75, 0.028, 0.06, -0.25), (2.9, 1, 0.3, 0.018, 0.035, 0.3),
                                                    (0.9, -1, 0.25, 0.016, 0.03, 0.1)])]
    # lintel snapped: long left piece still bridging, short right piece slumped onto the right post
    parts.append(lintel_member("la", 2.85, LH, LD, (-0.8, 0, HP), 23, target=2800, breaks=[(1.3, 1, 0.16, 0.25)],
                               cracks=[(-0.7, 1, 0.4, 0.02, 0.04)]))
    piv = V((W2 + 0.3, 0, HP))
    rot = R(math.radians(-13), 4, "Y")
    rb = lintel_member("lb", 1.45, LH, LD, (0, 0, 0), 24, target=1700, breaks=[(-0.62, -1, 0.16, -0.25)])
    S.transform(rb, T(piv) @ rot @ T((1.53 - piv.x, 0.06, 0)))
    parts.append(rb)
    objs.append(S.finalize(S.join("Gate_B", parts), seed=2))

if want("Gate_C"):
    lean = (math.radians(9), "Y", V((-W2 - 0.3, 0, 0.3)))
    parts = [post_member("pa", -W2, HP, 31, plinth=True, split=2.0, lean=lean, target=3100, cracks=[(0.95, -1, 0.35, 0.02, 0.04, 0.15)]),
             post_member("pb", W2, HP, 32, target=2600, cut_top=(2.75, 0.3, -0.2, 0.18))]
    # fallen lintel on the ground in front, broken in two
    parts.append(lintel_member("la", 2.6, LH, LD, (-0.7, -1.9, -0.06), 33, target=2300,
                               rot=R(math.radians(14), 4, "Z") @ R(math.radians(5), 4, "X"),
                               breaks=[(1.25, 1, 0.13, 0.2)], ground=True))
    parts.append(lintel_member("lb", 1.7, LH, LD, (1.75, -2.25, -0.12), 34, target=1600,
                               rot=R(math.radians(-25), 4, "Z") @ R(math.radians(-8), 4, "X") @ R(math.radians(90), 4, "X") @ T((0, 0, -LH / 2)),
                               breaks=[(-0.8, -1, 0.13, -0.2)], ground=True))
    # broken-off post top lying at the foot of the right post
    parts.append(lintel_member("pt", 1.1, POST, POST, (W2 + 0.95, 0.6, -0.08), 35,
                               rot=R(math.radians(70), 4, "Z") @ R(math.radians(6), 4, "Y"),
                               breaks=[(-0.5, -1, 0.15, 0.3)], target=1300, ground=True))
    objs.append(S.finalize(S.join("Gate_C", parts), seed=3))

# ------------------------------------------------------------------ pillars
for i, (H, seed) in enumerate([(1.55, 41), (2.45, 42), (3.25, 43), (4.0, 44)]):
    name = f"Pillar_{i}"
    if not want(name):
        continue
    rng = random.Random(seed)
    mem = [(1.02, 1.02, 0.42, R(rng.uniform(-0.05, 0.05), 4, "Z"))]
    z = 0.42
    w = 0.7
    while z < H + 0.4:
        bh = rng.uniform(0.55, 0.85)
        mem.append((w + rng.uniform(-0.02, 0.01), w + rng.uniform(-0.02, 0.01), bh,
                    T((rng.uniform(-0.025, 0.025), rng.uniform(-0.025, 0.025), z)) @ R(rng.uniform(-0.045, 0.045), 4, "Z")))
        z += bh
    cut = [S.break_cutter(V((0, 0, H)), V((rng.uniform(-0.35, 0.35), rng.uniform(-0.35, 0.35), 1)), 1.8, 0.2,
                          seed, res=0.03)]
    # a big bite out of one top corner
    cut.append(S.break_cutter(V((0.3, -0.3, H - 0.35)), V((0.7, -0.7, 0.5)), 1.2, 0.1, seed + 1, res=0.03))
    cz = rng.uniform(0.8, H - 0.4)
    crk = [(V((0.05, -w / 2, cz)), V((0.2, 0, 1)), V((1, 0, 0)), w * 0.7, 0.4, 0.022, 0.045, 0.04)]
    target = int(3000 + 1800 * H)
    o = S.sculpt(name, mem, VOX, 0.026, cut, 14, (0.05, 0.16), seed, target=target, cracks=crk)
    objs.append(S.finalize(o, seed=seed))

# ------------------------------------------------------------------ slabs (standing stones / grave markers)
SLABS = [(1.3, 0.86, 0.26, "shoulder", 0.0), (1.75, 0.95, 0.3, "broken", 4.0), (2.0, 1.0, 0.32, "round", 7.0)]
for i, (H, W, D, top, lean) in enumerate(SLABS):
    name = f"Slab_{i}"
    if not want(name):
        continue
    seed = 51 + i
    rng = random.Random(seed)
    mem = [(W, D, H + 0.3, T((0, 0, -0.3)))]
    cut = []
    crk = []
    if top == "shoulder":
        for s in (-1, 1):
            cut.append(S.break_cutter(V((s * W * 0.32, 0, H - 0.02)), V((s * 0.75, 0, 1)), 1.4, 0.03, seed + s,
                                      ridge=False, res=0.04))
    elif top == "broken":
        cut.append(S.break_cutter(V((0, 0, H - 0.15)), V((-0.45, 0.15, 1)), 2.0, 0.16, seed, res=0.03))
        crk.append((V((W / 2, 0, H * 0.45)), V((0.4, 0, 1)), V((0, 1, 0)), D * 0.8, W * 0.5, 0.02, 0.045, 0.04))
    else:  # rounded / arched top approximated by a fan of shallow jagged planes
        for k in range(7):
            a = math.radians(-70 + k * 140 / 6)
            nrm = V((math.sin(a), 0, math.cos(a)))
            c = V((0, 0, H - W * 0.5)) + nrm * (W * 0.5)
            cut.append(S.break_cutter(c, nrm, 0.9, 0.012, seed + k, ridge=False, res=0.05))
        cut.append(S.break_cutter(V((W / 2, -D / 2, H * 0.75)), V((0.7, -0.6, 0.4)), 0.9, 0.06, seed + 20, res=0.03))
    if top in ("shoulder", "round"):   # shallow recessed inscription panel on the front face
        pw, ph = W * 0.62, H * (0.42 if top == "shoulder" else 0.38)
        pz = H * (0.4 if top == "shoulder" else 0.42)
        pb = S.box_bm(pw, 0.2, ph, (0, -D / 2 - 0.1 + 0.022, pz))
        cut.append(pb)
    o = S.sculpt(name, mem, 0.012, 0.026, cut, 12, (0.04, 0.12), seed, target=int(2600 + 1600 * H) * 3,
                 cracks=crk)
    S.transform(o, R(math.radians(lean), 4, "Y") @ R(math.radians(rng.uniform(-3, 3)), 4, "X"))
    S.ground_cut(o)
    S.decimate(o, int(2600 + 1600 * H))
    objs.append(S.finalize(o, seed=seed))

# ------------------------------------------------------------------ fallen blocks / rubble
BLOCKS = [((1.5, 0.82, 0.72), (0, 3, 2), None), ((1.05, 0.7, 0.62), (4, 12, 25), None),
          ((0.62, 0.5, 0.46), (-6, 8, 40), None), ((1.25, 0.75, 0.68), (2, -5, 10), "end"),
          ((0.55, 0.45, 0.42), (14, 22, 55), "two")]
for i, ((sx, sy, sz), (rx, ry, rz), brk) in enumerate(BLOCKS):
    name = f"Block_{i}"
    if not want(name):
        continue
    seed = 61 + i
    cut = []
    if brk == "end":
        cut.append(S.break_cutter(V((sx * 0.33, 0, sz / 2)), V((1, 0.2, 0.1)), 1.6, 0.13, seed, res=0.03))
    elif brk == "two":
        cut.append(S.break_cutter(V((sx * 0.25, 0, sz / 2)), V((1, 0.3, -0.2)), 1.2, 0.1, seed, res=0.025))
        cut.append(S.break_cutter(V((0, sy * 0.2, sz * 0.7)), V((-0.2, 1, 0.6)), 1.2, 0.08, seed + 1, res=0.025))
    mem = [(sx, sy, sz, Matrix())]
    vol = sx * sy * sz
    target = int(min(9000, 2200 + 6000 * vol))
    o = S.sculpt(name, mem, 0.011 if vol < 0.3 else 0.013, 0.032, cut, int(10 + 8 * vol), (0.05, 0.12 + 0.06 * vol),
                 seed, ero=(0.03, 0.35), target=target * 3)
    S.transform(o, R(math.radians(rz), 4, "Z") @ R(math.radians(ry), 4, "Y") @ R(math.radians(rx), 4, "X")
                @ T((0, 0, -sz / 2)))
    zmin = min(v.co.z for v in o.data.vertices)
    S.transform(o, T((0, 0, -zmin - sz * 0.07)))
    S.ground_cut(o)
    S.decimate(o, target)
    objs.append(S.finalize(o, seed=seed))

# ------------------------------------------------------------------ path stones
for i in range(6):
    name = f"PathStone_{i}"
    if not want(name):
        continue
    seed = 71 + i
    rng = random.Random(seed)
    size = [0.72, 0.88, 1.0, 1.15, 1.3, 1.45][i]
    n = rng.randint(6, 8)
    angs = sorted(rng.uniform(0, 2 * math.pi) for _ in range(n))
    while max((angs[(k + 1) % n] - angs[k]) % (2 * math.pi) for k in range(n)) > 1.6:
        angs = sorted(rng.uniform(0, 2 * math.pi) for _ in range(n))
    ar = rng.uniform(0.7, 0.9)
    poly = []
    for a in angs:
        r = size / 2 * rng.uniform(0.8, 1.0)
        poly.append((math.cos(a) * r, math.sin(a) * r * ar))
    th = rng.uniform(0.12, 0.16)
    bm = S.prism_bm(poly, 0, th)
    o = S.bm_to_obj(name, bm)
    S.bevel(o, 0.025, 2)
    S.remesh(o, 0.014)
    # dome the top
    me = o.data
    for v in me.vertices:
        r2 = (v.co.x ** 2 + (v.co.y / ar) ** 2) / (size / 2) ** 2
        if v.co.z > th * 0.5:
            v.co.z += 0.04 * max(0.0, 1 - r2) * (v.co.z / th)
    me.update()
    edges = [(V((*poly[k], th)), V((*poly[(k + 1) % n], th))) for k in range(n)]
    sp_edges = []
    for a_, b_ in edges:
        nrm = (b_ - a_).cross(V((0, 0, 1))).normalized()
        if nrm.dot(a_) < 0:
            nrm = -nrm
        sp_edges.append((a_, b_, (nrm + V((0, 0, 1))).normalized(), (nrm, V((0, 0, 1)))))
    corners_ = [(e[0], e[2], e[3]) for e in sp_edges]
    faces_ = [(V((0, 0, th + 0.03)), V((0, 0, 1)), size * 0.6, size * 0.5)]
    cuts = S.spall_cutters((sp_edges, corners_, faces_), rng.randint(7, 10), 3, 2, (0.05, 0.13), seed,
                           face_rr=(0.12, 0.22))
    S.boolean(o, cuts[: len(cuts) // 2])
    S.remesh(o, 0.014)
    if i % 2 == 0:
        a = rng.uniform(0, math.pi)
        S.crack_groove(o, V((0, 0, th + 0.03)), V((math.cos(a), math.sin(a), 0)), V((0, 0, 1)), size * 0.45, 0.2,
                       0.016, 0.03, 0.04, seed=seed)
    S.edge_wear(o, 0.012, 0.01, 4.0, seed)
    S.displace(o, 0.018, 0.3, "CLOUDS", 3, seed)
    S.displace(o, 0.007, 0.05, "CLOUDS", 2, seed + 1)
    S.boolean(o, cuts[len(cuts) // 2:])
    for v in o.data.vertices:          # flatten the (hidden) underside onto z=0
        if v.co.z < 0.02:
            v.co.z = min(v.co.z, 0.0)
    S.decimate(o, int(450 + 700 * size))
    objs.append(S.finalize(o, seed=seed, ao_dist=0.6, moss_scale=1.4, up_w=0.25, moss_low=0.08))

print("\nRUINS KIT SUMMARY")
for o in objs:
    print(f"  {o.name:14s} {S.tris(o):7d} tris  dims=({o.dimensions.x:.2f},{o.dimensions.y:.2f},{o.dimensions.z:.2f})")
S.export(objs, OUT)
