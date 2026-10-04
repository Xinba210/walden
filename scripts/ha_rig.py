"""Hooded-assassin rig (Tripo Smart Mesh, rigged): Tripo's body skin + a real cloth rig for the coat and scarf.

  blender -b --factory-startup --python scripts/ha_rig.py -- <prep.blend> <out.blend>

The mesh comes in separate pieces: trousers (complete and closed - the coat can finally be kept off real legs), boots,
loose coat panels, scarf tail, scabbard / strap sticks, and one big torso piece whose skirt below the belt is the rest
of the coat. Classification is geometric (no hand-made part map):
  arm      vertices whose Tripo weight is mostly arm / hand bones
  trousers the piece carrying the most thigh weight; boots: pieces carried by feet / shins below the knee
  stick    pieces thinner than 3.5 cm across (scabbard, straps)        -> rigid on Hips
  scarf    loose pieces hanging from above the chest to below the hips -> 2 spring chains on Spine2
  coat     torso-piece vertices below the belt + loose pieces hanging below the waist -> 12 spring columns on Hips
Coat / scarf weights are the 3d-anim/samurai analytic scheme (columns by angle, rows by height, blended into the body
over 4 cm at the top). Tripo's hand / forearm weights are stripped from everything that is not the arm.
"""
import json, math, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT + "/scripts")
sys.path.append(ROOT + "/.venv/lib/python3.14/site-packages")
import bpy, bmesh, numpy as np
from mathutils import Vector
from scipy.spatial import cKDTree
import regions

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[:2]
PHYSICS = "--physics" in argv          # coat = pure cloth simulation (no thigh lock)
SPRING = "--spring" in argv            # coat = free spring-bone chains like the 3d-anim/samurai game (no lock, no sim)
SLIM = "--slim" in argv
PANELS = "--panels" in argv
FLARE = "--flare" in argv
FOLLOW = "--follow" in argv            # front / side panels partly follow the thigh under them (stay over spread legs)              # reshape the coat into a cone flaring out from the waist (room for the legs)            # each separate coat part gets its own chains; its vertices only follow them
PANEL_BONES = 5                # make clearance: slim the trouser thighs under the coat, lift the coat off them
P = "mixamorig:"
OLD_GAME_SCALE = 1.75
PHYS = {
    "coat": {"stiffness": 0.8, "gravity": 0.45, "drag": 0.35, "hitRadius": 0.018, "maxAngle": 2.3},  # keep the cone flare, drape a little
    "drape": {"stiffness": 0.5, "gravity": 0.3, "drag": 0.3, "hitRadius": 0.015, "maxAngle": 1.5},
}
COAT_BONES, COLUMN_STEP = 6, 30

bpy.ops.wm.open_mainfile(filepath=SRC)
Arm = bpy.data.objects["Armature"]
M = bpy.data.objects["Ninja"]


def analyse():
    """classify every vertex of the current mesh; returns the arrays the rest of the script uses"""
    global me, nv, co, z, J, hips, names0, W0, lab, belt_z, knee_z, comp, w_arm, body_c
    me = M.data
    nv = len(me.vertices)
    co = np.array([M.matrix_world @ v.co for v in me.vertices])
    z = co[:, 2]
    J = {b.name[len(P):]: np.array(Arm.matrix_world @ b.head_local) for b in Arm.data.bones if b.name.startswith(P)}
    hips = J["Hips"]

    # ------------------------------------------------------------------ Tripo weights -> matrix
    names0 = [g.name for g in M.vertex_groups]
    W0 = np.zeros((nv, len(names0)))
    for v in me.vertices:
        for g in v.groups:
            W0[v.index, g.group] = g.weight
    W0 /= np.maximum(W0.sum(1, keepdims=True), 1e-9)


    def wsum(pred):
        cols = [i for i, n in enumerate(names0) if pred(n)]
        return W0[:, cols].sum(1) if cols else np.zeros(nv)


    w_arm = wsum(lambda n: any(k in n for k in ("Arm", "Hand", "Shoulder")))
    w_thigh = wsum(lambda n: "UpLeg" in n)
    w_low = wsum(lambda n: any(k in n for k in ("Foot", "Toe")) or n.endswith("Leg") and "UpLeg" not in n)

    # ------------------------------------------------------------------ pieces
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    comp = np.full(nv, -1)
    nc = 0
    for v in bm.verts:
        if comp[v.index] >= 0:
            continue
        st = [v]
        comp[v.index] = nc
        while st:
            x = st.pop()
            for e in x.link_edges:
                w = e.other_vert(x)
                if comp[w.index] < 0:
                    comp[w.index] = nc
                    st.append(w)
        nc += 1
    bm.free()
    # the torso piece: the one carrying the most spine weight (on a segmented export the biggest piece may be a boot)
    w_spine = wsum(lambda n: "Spine" in n or n.endswith("Hips"))
    body_c = int(np.argmax([w_spine[comp == c].sum() for c in range(nc)]))
    if TROUSERS_V is None:
        # trousers: pieces that wrap all the way round a thigh close to its bone (a coat panel only covers one side)
        def wraps(p):
            best = 0
            for side in ("Left", "Right"):
                a, b = J[side + "UpLeg"], J[side + "Leg"]
                ab = b - a
                t = np.clip(((p - a) @ ab) / (ab @ ab), 0, 1)
                q = a + t[:, None] * ab
                ins = (t > 0.05) & (t < 0.95)
                if ins.sum() < 10:
                    continue
                v = p[ins] - q[ins]
                cov = len(np.unique((np.degrees(np.arctan2(v[:, 1], v[:, 0])) // 20).astype(int))) * 20
                if np.median(np.linalg.norm(v, axis=1)) < 0.13:
                    best = max(best, cov)
            return best
        trous_cs = [c for c in range(nc) if c != body_c and co[comp == c][:, 2].min() > 0.2 and wraps(co[comp == c]) >= 340]
        if not trous_cs:          # fallback: the piece carrying the most thigh weight
            trous_cs = [int(np.argmax([w_thigh[comp == c].sum() if c != body_c else -1 for c in range(nc)]))]
    else:                         # after the coat split: same pieces as the first pass (vertex indices are kept)
        trous_cs = list(np.unique(comp[TROUSERS_V]))
    trous_c = trous_cs[0]
    knee_z = J["LeftLeg"][2]
    belt_z = hips[2] + 0.05                       # below this the torso piece is coat skirt (checked against the belt band)
    lab = np.full(nv, "body", object)
    lab[w_arm >= 0.5] = "arm"
    lab[np.isin(comp, trous_cs)] = "trousers"
    for c in range(nc):
        m = comp == c
        if c == body_c or c in trous_cs:
            continue
        p = co[m]
        ext = np.sort(np.linalg.svd(p - p.mean(0), compute_uv=False) / math.sqrt(max(m.sum(), 1)) * 4)
        zr = (p[:, 2].min(), p[:, 2].max())
        if w_low[m].mean() > 0.5 and zr[1] < knee_z + 0.05:
            lab[m] = "boot"
        elif ext[0] > 0.02 and ext[1] < 0.07 and ext[2] > 6 * ext[1]:      # solid rod (scabbard), not a flat cloth strip
            lab[m] = "stick"
        elif zr[1] > J["Spine2"][2] - 0.05 and zr[0] < hips[2] - 0.1:
            lab[m] = "scarf"
        elif zr[0] < hips[2] - 0.2 and zr[1] < hips[2] + 0.12 and w_arm[m].mean() < 0.3:
            lab[m] = "coat"
    skirt = (comp == body_c) & (w_arm < 0.5) & (z < belt_z)
    lab[skirt] = "coat"
    for k in ("body", "arm", "trousers", "boot", "stick", "scarf", "coat"):
        print("LAB %-9s %6d verts" % (k, (lab == k).sum()))
    print("pieces", nc, "torso piece", body_c, "trousers pieces", trous_cs, "belt_z %.3f hips %.3f" % (belt_z, hips[2]))

    return lab


TROUSERS_V = None
lab = analyse()
TROUSERS_V = np.where(lab == "trousers")[0]
# the coat is the part that has to wrap over the legs and bend away from them: split its faces once (short triangles
# follow the trouser surface) and cut horizontal rings every RING m so it can curve smoothly outwards and down instead of
# folding at a few long faces
RING = 0.03
bm = bmesh.new()
bm.from_mesh(me)
bm.verts.ensure_lookup_table()
cl = bm.verts.layers.int.new("is_coat")
for v in bm.verts:
    v[cl] = 1 if lab[v.index] == "coat" else 0
bm.edges.ensure_lookup_table()
cedges = [e for e in bm.edges if e.verts[0][cl] and e.verts[1][cl]]
bmesh.ops.subdivide_edges(bm, edges=cedges, cuts=1, use_grid_fill=True)
for v in bm.verts:                                   # new midpoints between two coat vertices are coat as well
    if not v[cl] and v.link_edges and all(e.other_vert(v)[cl] for e in v.link_edges if len(e.link_faces)) and \
            sum(1 for e in v.link_edges if e.other_vert(v)[cl]) >= 2:
        v[cl] = 1
czs = [v.co.z for v in bm.verts if v[cl]]
nring = 0
for zc in np.arange(min(czs) + RING, max(czs), RING):
    faces = [f for f in bm.faces if all(v[cl] for v in f.verts)]
    if not faces:
        continue
    geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
    res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, zc), plane_no=(0, 0, 1))
    for v in res["geom_cut"]:
        if isinstance(v, bmesh.types.BMVert):
            v[cl] = 1
    nring += 1
bm.verts.layers.int.remove(cl)
bm.to_mesh(me)
bm.free()
me.update()
print("coat subdivided: edges", len(cedges), "rings", nring)
lab = analyse()

# ------------------------------------------------------------------ clearance between coat and trousers
# The sculpt's baggy trousers fill the coat with zero gap, so any leg motion drives the thighs into the panels.
# Standard game fix: shrink the body under clothing. Trouser vertices covered by the coat move towards their thigh
# bone axis (full effect mid-thigh, fading out towards the knee so the visible lower trousers keep their shape, and
# towards the waist seam), and coat vertices close to the trousers are lifted a little off them.
if SLIM:
    knee = {sd: J[sd + "Leg"] for sd in ("Left", "Right")}
    hipj = {sd: J[sd + "UpLeg"] for sd in ("Left", "Right")}
    tv = np.where(lab == "trousers")[0]
    moved = 0
    for i in tv:
        p = co[i]
        sd = "Left" if np.linalg.norm(p[:2] - hipj["Left"][:2]) < np.linalg.norm(p[:2] - hipj["Right"][:2]) else "Right"
        a, b = hipj[sd], knee[sd]
        ab = b - a
        t = float(np.clip((p - a) @ ab / (ab @ ab), 0, 1))
        q = a + ab * t
        w = np.clip((t - 0.0) / 0.25, 0, 1) * np.clip((1.05 - t) / 0.35, 0, 1)      # waist seam / knee fade
        w = w * w * (3 - 2 * w)
        k = 1 - 0.24 * w
        if k < 0.999:
            new = q + (p - q) * k
            me.vertices[i].co = (M.matrix_world.inverted() @ Vector(new))
            moved += 1
    me.update()
    co = np.array([M.matrix_world @ v.co for v in me.vertices])
    tr = co[lab == "trousers"]
    from scipy.spatial import cKDTree as _KD
    kd = _KD(tr)
    cv = np.where(lab == "coat")[0]
    d, nn = kd.query(co[cv])
    lifted = 0
    for i, dd in zip(cv, d):
        if dd > 0.05 or co[i, 2] > hips[2] - 0.05:
            continue
        sd = "Left" if np.linalg.norm(co[i, :2] - hipj["Left"][:2]) < np.linalg.norm(co[i, :2] - hipj["Right"][:2]) else "Right"
        a, b = hipj[sd], knee[sd]
        ab = b - a
        t = float(np.clip((co[i] - a) @ ab / (ab @ ab), 0, 1))
        out = co[i] - (a + ab * t)
        out[2] *= 0.3
        n = np.linalg.norm(out)
        if n < 1e-6:
            continue
        new = co[i] + out / n * (0.05 - dd) * 0.5
        me.vertices[i].co = (M.matrix_world.inverted() @ Vector(new))
        lifted += 1
    me.update()
    co = np.array([M.matrix_world @ v.co for v in me.vertices])
    z = co[:, 2]
    print("clearance: slimmed trouser verts", moved, "lifted coat verts", lifted)

HANG = []
# ------------------------------------------------------------------ cone flare
# Coats that move well in games are cut as a cone: the skirt stands away from the legs and widens towards the hem.
# Every coat vertex moves horizontally away from the hips' vertical axis by tan(angle) x (depth below the belt), eased
# in over the first 8 cm so the waist stays put; the back flares a little more (it hangs flattest in the sculpt).
# The same offset at the same height keeps the layered panels in order.
if FLARE:
    cv = np.where(lab == "coat")[0]
    belt = belt_z - 0.02
    for i in cv:
        d = belt - co[i, 2]
        if d <= 0:
            continue
        ease = min(1.0, d / 0.08)
        ease = ease * ease * (3 - 2 * ease)
        out = co[i, :2] - hips[:2]
        n = np.linalg.norm(out)
        if n < 1e-4:
            continue
        out /= n
        back = max(0.0, out[1])                       # +Y is the character's back
        dr = math.tan(math.radians(13.0 + 6.0 * back)) * d * ease
        new = co[i].copy()
        new[:2] += out * dr
        me.vertices[i].co = (M.matrix_world.inverted() @ Vector(new))
    # pieces hanging from the waist over the coat (straps, tabs, pouches, scabbard): same cone offset + 1.5 cm, so
    # they keep lying on top of the (now flared) coat instead of ending up inside it
    hang = []
    for c in np.unique(comp):
        m = np.where(comp == c)[0]
        if c == body_c or not np.isin(lab[m], ["body", "stick"]).all():
            continue
        if co[m, 2].max() > belt_z + 0.12 or co[m, 2].min() > belt - 0.04:
            continue
        hang.append(m)
    for m in hang:
        for i in m:
            d = belt - co[i, 2]
            if d <= 0:
                continue
            ease = min(1.0, d / 0.08)
            ease = ease * ease * (3 - 2 * ease)
            out = co[i, :2] - hips[:2]
            n = np.linalg.norm(out)
            if n < 1e-4:
                continue
            out /= n
            back = max(0.0, out[1])
            dr = math.tan(math.radians(13.0 + 6.0 * back)) * d * ease + 0.015 * ease
            new = co[i].copy()
            new[:2] += out * dr
            me.vertices[i].co = (M.matrix_world.inverted() @ Vector(new))
    HANG = hang
    print("waist-hanging pieces moved onto the coat:", len(hang), "verts", sum(len(m) for m in hang))
    me.update()
    co = np.array([M.matrix_world @ v.co for v in me.vertices])
    z = co[:, 2]
    print("flare: coat verts", len(cv), "hem widened by up to %.2f m" % (math.tan(math.radians(19)) * (belt - z[cv].min())))

# ------------------------------------------------------------------ chains
def angle(p):
    return (math.degrees(math.atan2(p[0] - hips[0], -(p[1] - hips[1]))) + 360) % 360


def adiff(a, b):
    return np.abs((a - b + 180) % 360 - 180)


coat = np.where(lab == "coat")[0]
COAT_TOP = belt_z - 0.02
ang = np.array([angle(co[i]) for i in coat])
rad = np.linalg.norm(co[coat, :2] - hips[:2], axis=1)
chains, columns = [], []
for k in range(360 // COLUMN_STEP):
    th = COLUMN_STEP / 2 + COLUMN_STEP * k
    sel = np.where((adiff(ang, th) < COLUMN_STEP * 0.75) & (z[coat] < COAT_TOP + 0.03))[0]
    if len(sel) < 8:
        continue
    hem = z[coat[sel]].min()
    if hem > COAT_TOP - 0.15:
        continue
    joints = []
    for j in range(COAT_BONES + 1):
        h = COAT_TOP - (COAT_TOP - hem) * j / COAT_BONES
        near = sel[np.argsort(np.abs(z[coat[sel]] - h))[:6]]
        r = rad[near].mean() * (0.85 if j == 0 else 1.0)
        a = math.radians(th)
        joints.append(Vector((hips[0] + r * math.sin(a), hips[1] - r * math.cos(a), h)))
    columns.append({"theta": th, "hem": hem, "name": f"cloth_coat_{k}"})
    chains.append({"name": f"cloth_coat_{k}", "parent": P + "Hips", "joints": joints, "kind": "coat"})
if PANELS:
    # rebuild: one set of chains per coat part, laid down that part's own surface
    chains, columns = [], []
    panels = []
    for pk, piece in enumerate(np.unique(comp[coat])):
        V = coat[comp[coat] == piece]
        a = ang[comp[coat] == piece]
        mean = math.degrees(math.atan2(np.sin(np.radians(a)).mean(), np.cos(np.radians(a)).mean()))
        rel = (a - mean + 180) % 360 - 180
        lo, hi = np.percentile(rel, 3), np.percentile(rel, 97)
        r = np.median(np.linalg.norm(co[V, :2] - hips[:2], axis=1))
        width = math.radians(hi - lo) * r
        tol = 6.0
        if hi - lo < 60:
            # a narrow / edge-on panel: measure across its own horizontal width direction instead of the angle
            xy = co[V, :2] - co[V, :2].mean(0)
            axis = np.linalg.svd(xy, full_matrices=False)[2][0]
            rel = xy @ axis
            lo, hi = np.percentile(rel, 3), np.percentile(rel, 97)
            width = hi - lo
            tol = 0.02
        # ONE chain per panel: the whole piece bends as a unit, it can never stretch sideways between columns
        cang = [float(np.median(rel))]
        spacing = 1e9
        pcols = []
        for ci, ca in enumerate(cang):
            # the chain runs ON the panel: vertices around the panel's middle (angle or across-width), not the arc's
            # centroid (which lies inside the curve, i.e. inside the leg, and gets shoved out by the collider)
            band = max(15.0, 0.12 * (hi - lo)) if tol > 1 else max(0.04, 0.15 * (hi - lo))
            sel = V[(np.abs(rel - ca) < band) & (z[V] < COAT_TOP + 0.03)]
            if len(sel) < 20:
                sel = V[z[V] < COAT_TOP + 0.03]
            if len(sel) < 10:
                continue
            hem = np.percentile(z[sel], 1.5)
            if hem > COAT_TOP - 0.12:
                continue
            joints = []
            for j in range(PANEL_BONES + 1):
                h = COAT_TOP - (COAT_TOP - hem) * j / PANEL_BONES
                near = sel[np.argsort(np.abs(z[sel] - h))[:40]]
                pnt = np.median(co[near], axis=0)
                joints.append(Vector((pnt[0], pnt[1], h)))
            name = f"cloth_coat_p{pk}_{ci}"
            pcols.append({"rel": ca, "hem": hem, "name": name})
            chains.append({"name": name, "parent": P + "Hips", "joints": joints, "kind": "coat"})
        panels.append({"verts": V, "rel": rel, "cols": pcols})
        print("PANEL piece %d verts %d span %.0f deg width %.2f m -> %d chains" % (piece, len(V), hi - lo, width, len(pcols)))
scarf = np.where(lab == "scarf")[0]
scarf_lines = []
if len(scarf) > 20:
    ps = co[scarf]
    sc_top = min(J["Spine2"][2], np.percentile(ps[:, 2], 97) - 0.04)
    sc_hem = np.percentile(ps[:, 2], 1) + 0.01
    for nm, pcl in (("cloth_scarfA", 25), ("cloth_scarfB", 75)):
        pts = []
        for l in np.linspace(sc_top, sc_hem, 5):
            kk = np.abs(ps[:, 2] - l) < 0.05
            if kk.sum() < 3:
                kk = np.argsort(np.abs(ps[:, 2] - l))[:6]
            qq = ps[kk]
            xs = np.percentile(qq[:, 0], pcl)
            s_ = qq[np.abs(qq[:, 0] - xs) <= np.abs(qq[:, 0] - xs).min() + 0.03]
            pts.append(Vector((xs, np.median(s_[:, 1]), l)))
        chains.append({"name": nm, "parent": P + "Spine2", "joints": pts, "kind": "drape"})
        scarf_lines.append(np.array([p[:] for p in pts]))

bpy.context.view_layer.objects.active = Arm
Arm.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
eb = Arm.data.edit_bones
inv = Arm.matrix_world.inverted()
for c in chains:
    parent = eb[c["parent"]]
    c["bones"] = []
    for j in range(len(c["joints"]) - 1):
        b = eb.new(f"{c['name']}_{j}")
        b.head, b.tail = inv @ c["joints"][j], inv @ c["joints"][j + 1]
        b.align_roll(Vector((b.head.x - hips[0], b.head.y - hips[1], 0)).normalized())
        b.parent = parent
        b.use_connect = j > 0
        parent = b
        c["bones"].append(b.name)
    e = eb.new(c["name"] + "_end")
    tip = c["joints"][-1]
    e.head, e.tail = inv @ tip, inv @ (tip + (tip - c["joints"][-2]) * 0.25)
    e.parent = parent
    e.use_connect = True
    e.use_deform = False
    c["end"] = e.name
bpy.ops.object.mode_set(mode="OBJECT")

# ------------------------------------------------------------------ weights
names = [b.name for b in Arm.data.bones if b.use_deform]
idx = {n: i for i, n in enumerate(names)}
W = np.zeros((nv, len(names)))
for j, n in enumerate(names0):
    if n in idx:
        W[:, idx[n]] = W0[:, j]
D = {}


def dist_to(b):
    if b not in D:
        bb = Arm.data.bones[b]
        D[b] = regions.seg_dist(co, np.array(Arm.matrix_world @ bb.head_local), np.array(Arm.matrix_world @ bb.tail_local))[0]
    return D[b]


# Tripo leaks: no forearm / hand weight off the arms, upper arm / shoulder only near the shoulder
not_arm = lab != "arm"
for side in ("Left", "Right"):
    low = [idx[n] for n in names if n.startswith(P + side) and any(k in n for k in ("ForeArm", "Hand"))]
    W[np.ix_(not_arm, low)] = 0
    sh = J[side + "Arm"]
    near = (np.linalg.norm(co - sh, axis=1) < 0.15) & (z > sh[2] - 0.12)
    for b in (P + side + "Arm", P + side + "Shoulder"):
        W[not_arm & ~near, idx[b]] = 0
empty = W.sum(1) < 1e-6
W[empty, idx[P + "Hips"]] = 1
W /= W.sum(1, keepdims=True)
LEGB = np.array([any(k in n for k in ("UpLeg", "Leg", "Foot", "Toe")) for n in names])
ARMB = np.array([any(k in n for k in ("Arm", "Hand", "Shoulder")) for n in names])


def body_top(i):
    w = W[i].copy()
    w[idx[P + "Hips"]] += w[LEGB].sum() + w[ARMB].sum()
    w[LEGB | ARMB] = 0
    return w / w.sum()


def chain_w(bones, u):
    out = np.zeros(len(names))
    n = len(bones)
    x = u - 0.5
    if x <= 0:
        out[idx[bones[0]]] = 1
    elif x >= n - 1:
        out[idx[bones[-1]]] = 1
    else:
        b = int(x)
        f = x - b
        out[idx[bones[b]]] = 1 - f
        out[idx[bones[b + 1]]] = f
    return out


byname = {c["name"]: c for c in chains}
cols = sorted(columns, key=lambda c: c["theta"])
if PANELS:
    for pnl in panels:
        pc = sorted(pnl["cols"], key=lambda c: c["rel"])
        if not pc:
            continue
        ra = np.array([c["rel"] for c in pc])
        for i, rv in zip(pnl["verts"], pnl["rel"]):
            top = body_top(i)
            if z[i] >= COAT_TOP:
                W[i] = top
                continue
            if len(pc) == 1 or rv <= ra[0]:
                mix = [(pc[0], 1.0)] if rv <= ra[0] or len(pc) == 1 else None
            if len(pc) > 1 and rv >= ra[-1]:
                mix = [(pc[-1], 1.0)]
            elif len(pc) > 1 and rv > ra[0]:
                k = int(np.searchsorted(ra, rv)) - 1
                f = (rv - ra[k]) / max(ra[k + 1] - ra[k], 1e-6)
                mix = [(pc[k], 1 - f), (pc[k + 1], f)]
            w = np.zeros(len(names))
            for c, sgt in mix:
                u = np.clip((COAT_TOP - z[i]) / (COAT_TOP - c["hem"]), 0, 1) * PANEL_BONES
                w += sgt * chain_w(byname[c["name"]]["bones"], u)
            blend = min(1.0, (COAT_TOP - z[i]) / 0.04)
            W[i] = blend * w + (1 - blend) * top
for i, th in zip(coat if not PANELS else [], ang if not PANELS else []):
    top = body_top(i)
    if z[i] >= COAT_TOP:
        W[i] = top
        continue
    best = sorted(cols, key=lambda c: adiff(c["theta"], th))[:2]
    gap = adiff(best[0]["theta"], best[1]["theta"])
    d0, d1 = adiff(best[0]["theta"], th), adiff(best[1]["theta"], th)
    mix = [(best[0], 1.0)] if gap > COLUMN_STEP * 1.5 or d0 + d1 > gap + 1e-3 else \
        [(best[0], 1 - d0 / gap), (best[1], d0 / gap)]
    w = np.zeros(len(names))
    for c, s in mix:
        u = np.clip((COAT_TOP - z[i]) / (COAT_TOP - c["hem"]), 0, 1) * COAT_BONES
        w += s * chain_w(byname[c["name"]]["bones"], u)
    blend = min(1.0, (COAT_TOP - z[i]) / 0.04)
    W[i] = blend * w + (1 - blend) * top
# coat panels share the thigh weights (the usual game rig for long coats): below the waist band each coat vertex blends
# onto the thigh it hangs over, so it moves with that leg and stays on top of it instead of being hit by it; the rest
# of the weight stays on the spring columns for sway. Front and side panels lock to the thighs; the two back panels
# (more than ~125 deg round from the front) stay pure spring cloth.
LEG_UP = {s: J[s + "UpLeg"] for s in ("Left", "Right")}
n_follow = 0
for i, th in zip(coat if not (PHYSICS or SPRING) else [], ang):
    side = min(LEG_UP, key=lambda s: abs(co[i, 0] - LEG_UP[s][0]))
    dfront = float(adiff(th, 0.0))                           # 0 at the front, 180 at the back
    sb = np.clip((dfront - 110) / 30, 0, 1)
    a_max = 0.9 * (1 - sb * sb * (3 - 2 * sb))               # front + sides lock to the thigh, back panels stay physics
    t = np.clip((COAT_TOP - 0.02 - z[i]) / 0.16, 0, 1)
    a = a_max * t * t * (3 - 2 * t)
    if a <= 0:
        continue
    leg = np.zeros(len(names))
    leg[idx[P + side + "UpLeg"]] = 1
    W[i] = (1 - a) * W[i] + a * leg
    n_follow += 1
print("coat vertices following the thighs", n_follow)
# partial thigh follow: lower front / side coat close to a thigh takes up to 35 % of that thigh's motion (fading with
# distance from the thigh, depth below the belt and towards the back), so a leg swinging out carries the panel on top
if FOLLOW and PANELS:
    nf = 0
    for i, th in zip(coat, ang):
        dfront = float(adiff(th, 0.0))
        fb = 1 - np.clip((dfront - 95) / 35, 0, 1)
        if fb <= 0 or z[i] >= COAT_TOP - 0.06:
            continue
        best = None
        for sd in ("Left", "Right"):
            a, b = J[sd + "UpLeg"], J[sd + "Leg"]
            ab = b - a
            t = float(np.clip((co[i] - a) @ ab / (ab @ ab), 0, 1))
            d = float(np.linalg.norm(co[i] - (a + ab * t)))
            if best is None or d < best[0]:
                best = (d, sd)
        d, sd = best
        near = np.clip((0.32 - d) / 0.14, 0, 1)
        depth = np.clip((COAT_TOP - 0.06 - z[i]) / 0.15, 0, 1)
        a_ = 0.35 * fb * near * depth
        if a_ <= 0.01:
            continue
        leg = np.zeros(len(names))
        leg[idx[P + sd + "UpLeg"]] = 1
        W[i] = (1 - a_) * W[i] + a_ * leg
        nf += 1
    print("coat verts partly following a thigh", nf)
# waist-hanging pieces: one rigid weight set per piece = the coat weights under it (so it rides on the coat surface)
# blended half with the hips (stable), instead of Tripo's leg weights (which swung them through the coat)
if HANG:
    from scipy.spatial import cKDTree as _KD2
    cidx = np.where(lab == "coat")[0]
    kdc = _KD2(co[cidx])
    hipw = np.zeros(len(names)); hipw[idx[P + "Hips"]] = 1
    for m in HANG:
        d, nn = kdc.query(co[m], k=4)
        near = cidx[nn[d < 0.08]] if (d < 0.08).any() else cidx[nn[:, 0]]
        w = W[near].mean(0)
        w = 0.5 * w / max(w.sum(), 1e-9) + 0.5 * hipw
        W[m] = w
for i in scarf:
    if not scarf_lines or z[i] >= sc_top:
        continue
    dA, dB = (np.min(np.linalg.norm(ln - co[i], axis=1)) for ln in scarf_lines)
    f = dA / max(dA + dB, 1e-6)
    u = np.clip((sc_top - z[i]) / (sc_top - sc_hem), 0, 1) * 4
    w = (1 - f) * chain_w(byname["cloth_scarfA"]["bones"], u) + f * chain_w(byname["cloth_scarfB"]["bones"], u)
    blend = min(1.0, (sc_top - z[i]) / 0.04)
    top = np.zeros(len(names))
    top[idx[P + "Spine2"]] = 1
    W[i] = blend * w + (1 - blend) * top
m = (lab == "stick") & ~np.isin(np.arange(nv), np.concatenate(HANG) if HANG else [])
W[m] = 0
W[m, idx[P + "Hips"]] = 1
order = np.argsort(-W, 1)
keep = np.zeros_like(W, bool)
np.put_along_axis(keep, order[:, :4], True, 1)
W = np.where(keep & (W > 0.01), W, 0)
W /= W.sum(1, keepdims=True)
for g in list(M.vertex_groups):
    M.vertex_groups.remove(g)
for j, n in enumerate(names):
    g = M.vertex_groups.new(name=n)
    for i in np.where(W[:, j] > 0)[0]:
        g.add([int(i)], float(W[i, j]), "REPLACE")

# ------------------------------------------------------------------ spring config (colliders sized from the trousers)
def leg_radius(side, b0, b1):
    a, b = J[side + b0], J[side + b1]
    dd, t = regions.seg_dist(co[lab == "trousers"], a, b)
    near = dd[(dd < 0.25) & (t > 0.05) & (t < 0.95)]
    return float(np.percentile(near, 60)) if len(near) > 20 else 0.07


colliders = []
for side in ("Left", "Right"):
    colliders.append({"bone": P + side + "UpLeg", "tail": P + side + "Leg", "radius": round(leg_radius(side, "UpLeg", "Leg"), 4)})
    colliders.append({"bone": P + side + "Leg", "tail": P + side + "Foot", "radius": round(leg_radius(side, "Leg", "Foot"), 4)})
colliders.append({"bone": P + "Hips", "tail": None, "radius": 0.12})
colliders.append({"bone": P + "Spine1", "tail": None, "radius": 0.13})
cfg = {"chains": [], "colliders": colliders, "colliderGroups": {"coat": "legs+hips", "drape": "spine"}}
s = 1.68
for c in chains:
    ph = dict(PHYS[c["kind"]])
    ph["stiffness"] = round(ph["stiffness"] * OLD_GAME_SCALE, 4)
    ph["gravity"] = round(ph["gravity"] * OLD_GAME_SCALE, 4)
    ph["hitRadius"] = round(ph["hitRadius"] * s, 4)
    cfg["chains"].append({"name": c["name"], "kind": c["kind"], "bones": c["bones"] + [c["end"]], **ph})
if PANELS:
    cfg["panels"] = True               # one chain per separate cloth part (the game skips the per-vertex leg push)
if PHYSICS:
    cfg["sim"] = "pbd"                 # the game simulates the coat as a particle lattice (clothSim.js)
Arm["cloth_cfg"] = json.dumps(cfg)
labels = np.array([["body", "arm", "trousers", "boot", "stick", "scarf", "coat"].index(x) for x in lab])
np.save(os.path.splitext(OUT)[0] + "_lab.npy", labels)
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print("CHAINS", [(c["name"], len(c["bones"])) for c in chains])
print("COLLIDERS", colliders)
