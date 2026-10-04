"""Shared helpers for the world2 stone-ruin asset builders (Blender 5.2, headless).

Two modelling pipelines:
  * sculpt()  - for kit pieces / columns: bevelled box members -> Bevel mod -> voxel Remesh (union, V-groove seams)
                -> Boolean (MANIFOLD) chips / cracks / jagged breaks -> Remesh -> Displace (Clouds) x2 -> Decimate.
  * masonry   - for big structures (aqueduct / castle): planar faces sliced into coursed ashlar blocks, each block
                grooved + chamfered with insets and individually jittered, then booleans + light displacement.
finalize() then does origin, smooth/sharp shading, world-scale box UVs (1 UV = 2 m), vertex-colour bake `Col`
(R = ray-cast AO, G = moss mask, B = edge wear, A = 1) and assigns the single `Stone` material.
"""
import bpy, bmesh, math, random
import numpy as np
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree

UV_SCALE = 0.5  # 1 UV unit = 2 m

EXPORT_KW = dict(export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
                 export_texcoords=True, export_normals=True, export_tangents=False,
                 export_materials="EXPORT", export_vertex_color="ACTIVE", export_all_vertex_colors=False,
                 export_attributes=False, export_animations=False, export_skins=False, export_morph=False,
                 export_cameras=False, export_lights=False)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def scene():
    return bpy.context.scene


# ------------------------------------------------------------------ material
def srgb(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def stone_mat():
    m = bpy.data.materials.get("Stone")
    if m:
        return m
    m = bpy.data.materials.new("Stone")
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*srgb("#8a8680"), 1)
    b.inputs["Roughness"].default_value = 0.9
    return m


# ------------------------------------------------------------------ object / bmesh plumbing
def link(name, me):
    o = bpy.data.objects.new(name, me)
    scene().collection.objects.link(o)
    return o


def bm_to_obj(name, bm, free=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    if free:
        bm.free()
    return link(name, me)


def obj_to_bm(o, world=False):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    if world:
        bm.transform(o.matrix_world)
    return bm


def delete(o):
    me = o.data
    bpy.data.objects.remove(o, do_unlink=True)
    if me and me.users == 0:
        bpy.data.meshes.remove(me)


def apply_mods(o):
    """Bake the modifier stack into the mesh (no operators needed)."""
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    old = o.data
    o.modifiers.clear()
    o.data = me
    me.name = o.name
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return o


def join(name, objs):
    """Join objects (world transforms baked) into a new object; sources removed."""
    bm = bmesh.new()
    for o in objs:
        tmp = o.data.copy()
        tmp.transform(o.matrix_world)
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
        delete(o)
    return bm_to_obj(name, bm)


def tris(o):
    me = o.data
    me.calc_loop_triangles()
    return len(me.loop_triangles)


def transform(o, M):
    o.data.transform(M)
    o.data.update()


def box_bm(sx, sy, sz, at=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    bmesh.ops.scale(bm, verts=bm.verts, vec=(sx, sy, sz))
    bmesh.ops.translate(bm, verts=bm.verts, vec=at)
    return bm


def taper_bm(bm, top_scale_x, top_scale_y, z0, z1):
    for v in bm.verts:
        t = (v.co.z - z0) / max(z1 - z0, 1e-6)
        v.co.x *= 1 + (top_scale_x - 1) * t
        v.co.y *= 1 + (top_scale_y - 1) * t
    return bm


def prism_bm(poly, z0, z1):
    """Extrude a CCW 2D polygon [(x,y)...] between z0..z1."""
    bm = bmesh.new()
    lo = [bm.verts.new((x, y, z0)) for x, y in poly]
    hi = [bm.verts.new((x, y, z1)) for x, y in poly]
    n = len(poly)
    bm.faces.new(lo[::-1])
    bm.faces.new(hi)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bm.normal_update()
    return bm


def fbm(p, octaves=3, lac=2.0, gain=0.5):
    n, a, f, tot = 0.0, 1.0, 1.0, 0.0
    for _ in range(octaves):
        n += a * noise.noise(p * f)
        tot += a
        a *= gain
        f *= lac
    return n / tot


def ridged(p, octaves=3):
    n, a, f = 0.0, 1.0, 1.0
    for _ in range(octaves):
        n += a * (1 - abs(noise.noise(p * f)))
        a *= 0.5
        f *= 2.1
    return n


def sheet_solid(nu, nv, su, sv, f_lo, f_hi, M=Matrix()):
    """Closed grid solid over u in [-su/2,su/2], v in [-sv/2,sv/2] with bottom z=f_lo(u,v), top z=f_hi(u,v);
    transformed by M. Used for jagged break cutters (top = far away) and crack wedges (thin sheet)."""
    bm = bmesh.new()
    lo, hi = {}, {}
    for i in range(nu + 1):
        for j in range(nv + 1):
            u = -su / 2 + su * i / nu
            v = -sv / 2 + sv * j / nv
            a, b = f_lo(u, v), f_hi(u, v)
            if b - a < 0.003:
                m = (a + b) / 2
                a, b = m - 0.0015, m + 0.0015
            lo[i, j] = bm.verts.new((u, v, a))
            hi[i, j] = bm.verts.new((u, v, b))
    for i in range(nu):
        for j in range(nv):
            bm.faces.new((lo[i, j], lo[i, j + 1], lo[i + 1, j + 1], lo[i + 1, j]))
            bm.faces.new((hi[i, j], hi[i + 1, j], hi[i + 1, j + 1], hi[i, j + 1]))
    ring = [(i, 0) for i in range(nu)] + [(nu, j) for j in range(nv)] + \
           [(i, nv) for i in range(nu, 0, -1)] + [(0, j) for j in range(nv, 0, -1)]
    for k in range(len(ring)):
        a, b = ring[k], ring[(k + 1) % len(ring)]
        bm.faces.new((lo[a], lo[b], hi[b], hi[a]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.transform(M)
    return bm


def frame(origin, normal, up_hint=Vector((0, 0, 1))):
    """Matrix whose local Z = normal, placed at origin."""
    z = Vector(normal).normalized()
    x = up_hint.cross(z)
    if x.length < 1e-4:
        x = Vector((1, 0, 0)).cross(z)
    x.normalize()
    y = z.cross(x)
    R = Matrix((x, y, z)).transposed().to_4x4()
    return Matrix.Translation(origin) @ R


def break_cutter(origin, normal, size, amp, seed, res=0.05, depth=20.0, tilt=(0.0, 0.0), ridge=True, scale=1.6):
    """Solid occupying everything beyond a jagged surface through `origin`, facing `normal` (removed by boolean)."""
    n = max(4, int(size / res))
    off = Vector((seed * 7.31, seed * 3.17, seed * 1.93))

    def f(u, v):
        p = Vector((u, v, 0)) * scale + off
        h = (ridged(p, 4) - 1.2) * 0.8 if ridge else fbm(p, 3)
        h += 0.35 * fbm(p * 3.1, 2) + 0.12 * noise.noise(p * 9.0)
        return h * amp + u * tilt[0] + v * tilt[1]

    return sheet_solid(n, n, size, size, f, lambda u, v: depth, frame(origin, normal))


def crack_cutter(origin, normal, along, length, depth_in, width, seed, res=0.025, wander=0.05):
    """Thin wedge crack: sheet in the plane through `origin` with normal `normal`; spans `length` along `along`
    (u) and `depth_in` into the stone (v from 0 at the surface to depth_in); thickness tapers to 0."""
    nu, nv = max(6, int(length / res)), max(4, int(depth_in / res))
    off = Vector((seed * 5.1, seed * 2.3, seed * 8.7))
    z = Vector(normal).normalized()
    x = Vector(along)
    x = (x - z * x.dot(z)).normalized()
    y = z.cross(x)
    R = Matrix((x, y, z)).transposed().to_4x4()
    # v=-depth_in/2..depth_in/2 maps 0..depth (y axis points into the stone: caller passes `along`, normal so that
    # y = normal x along points inward)
    M = Matrix.Translation(origin) @ R @ Matrix.Translation((0, depth_in / 2, 0))

    def mid(u, v):
        p = Vector((u, v, 0)) * 5 + off
        return fbm(p, 4) * wander * 1.6 + 0.5 * wander * noise.noise(p * 4)

    def th(u, v):
        s = (v + depth_in / 2) / depth_in            # 0 at surface .. 1 at tip
        e = 1 - (2 * abs(u) / length) ** 2           # thin out at the crack ends
        q = 0.65 + 0.35 * noise.noise(Vector((u * 7, 0.3, 0)) + off)
        return width * q * max(0.0, 1 - s) ** 1.3 * max(0.0, e) ** 0.5

    return sheet_solid(nu, nv, length, depth_in * 1.0, lambda u, v: mid(u, v) - th(u, v) / 2,
                       lambda u, v: mid(u, v) + th(u, v) / 2, M)


def rock_bm(r, seed, sub=1, sx=1.0, sy=1.0, sz=1.0, amp=0.35):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    off = Vector((seed * 3.7, seed * 1.3, seed * 2.9))
    for v in bm.verts:
        d = v.co.normalized()
        v.co += d * r * amp * noise.noise(d * 1.7 + off)
        v.co.x *= sx
        v.co.y *= sy
        v.co.z *= sz
    rot = Matrix.Rotation(seed * 1.7, 4, "Z") @ Matrix.Rotation(seed * 0.9, 4, "X")
    bm.transform(rot)
    return bm


# ------------------------------------------------------------------ modifier ops
_TEX = {}


def tex(kind, size, depth=2, basis="BLENDER_ORIGINAL"):
    key = (kind, size, depth, basis)
    if key not in _TEX:
        t = bpy.data.textures.new(f"{kind}_{size}", kind)
        t.noise_scale = size
        if hasattr(t, "noise_depth"):
            t.noise_depth = depth
        t.noise_basis = basis
        if kind in ("CLOUDS", "STUCCI", "MARBLE", "WOOD"):
            t.noise_type = "SOFT_NOISE"
        _TEX[key] = t
    return _TEX[key]


def bevel(o, width, segments=3, angle=None):
    m = o.modifiers.new("bev", "BEVEL")
    m.width = width
    m.segments = segments
    m.profile = 0.5
    m.limit_method = "ANGLE" if angle else "NONE"
    if angle:
        m.angle_limit = math.radians(angle)
    m.use_clamp_overlap = True
    m.harden_normals = False
    return apply_mods(o)


def remesh(o, voxel):
    m = o.modifiers.new("rem", "REMESH")
    m.mode = "VOXEL"
    m.voxel_size = voxel
    m.adaptivity = 0.0
    m.use_smooth_shade = True
    return apply_mods(o)


def boolean(o, cutter_bms, op="DIFFERENCE", solver="MANIFOLD", batch=True):
    """Subtract a list of closed bmeshes. batch: all cutters as one COLLECTION operand (fast n-ary manifold
    boolean); if that result looks suspicious (lost >70 % of the vertices) it is redone one cutter at a time and
    whichever result keeps more geometry is used."""
    if not cutter_bms:
        return o

    def objs():
        out = []
        for bm in cutter_bms:
            c = bm_to_obj("_cut", bm, free=False)
            c.matrix_world = o.matrix_world
            out.append(c)
        return out

    def sequential(src_mesh):
        o.data = src_mesh.copy()
        for c in objs():
            m = o.modifiers.new("bool", "BOOLEAN")
            m.operation = op
            m.solver = solver
            m.object = c
            apply_mods(o)
            delete(c)
        return o.data

    before = len(o.data.vertices)
    src = o.data.copy()
    if batch and len(cutter_bms) > 1:
        cut_objs = objs()
        coll = bpy.data.collections.new("_cutters")
        scene().collection.children.link(coll)
        for c in cut_objs:
            scene().collection.objects.unlink(c)
            coll.objects.link(c)
        m = o.modifiers.new("bool", "BOOLEAN")
        m.operation = op
        m.solver = solver
        m.operand_type = "COLLECTION"
        m.collection = coll
        apply_mods(o)
        for c in cut_objs:
            delete(c)
        bpy.data.collections.remove(coll)
        if len(o.data.vertices) < before * 0.3:
            batch_mesh = o.data
            seq_mesh = sequential(src)
            if len(batch_mesh.vertices) >= len(seq_mesh.vertices):
                o.data = batch_mesh
                bpy.data.meshes.remove(seq_mesh)
            else:
                print(f"  {o.name}: batch boolean lost geometry, used sequential result")
                bpy.data.meshes.remove(batch_mesh)
    else:
        old = o.data
        sequential(src)
        bpy.data.meshes.remove(old)
    if src.users == 0:
        bpy.data.meshes.remove(src)
    o.data.name = o.name
    for bm in cutter_bms:
        bm.free()
    if len(o.data.vertices) == 0 and before:
        raise RuntimeError("boolean wiped mesh " + o.name)
    return o


def displace(o, strength, size, kind="CLOUDS", depth=2, seed=0, basis="BLENDER_ORIGINAL"):
    m = o.modifiers.new("disp", "DISPLACE")
    m.texture = tex(kind, size, depth, basis)
    m.texture_coords = "GLOBAL"
    m.direction = "NORMAL"
    m.mid_level = 0.5
    m.strength = strength
    loc = o.location.copy()
    o.location = Vector((seed * 13.37 % 97, seed * 7.13 % 89, seed * 3.71 % 83))
    apply_mods(o)
    o.location = loc
    return o


def decimate(o, target):
    t = tris(o)
    if t > target:
        m = o.modifiers.new("dec", "DECIMATE")
        m.decimate_type = "COLLAPSE"
        m.ratio = target / t
        m.use_collapse_triangulate = True
        apply_mods(o)
    return o


def ground_cut(o, z=0.0):
    """Remove everything below z (for leaning / sunk pieces)."""
    return boolean(o, [box_bm(400, 400, 100, (0, 0, z - 50))])


# ------------------------------------------------------------------ sculpt pipeline
def hexa_bm(pts):
    """Closed hexahedron from 8 corners ordered like a box: bottom (0..3 CCW from below-left), top (4..7)."""
    bm = bmesh.new()
    v = [bm.verts.new(p) for p in pts]
    for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        bm.faces.new([v[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def cyl_bm(r0, r1, h, seg=28, M=Matrix()):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r0, radius2=r1, depth=h)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, h / 2))
    bm.transform(M)
    return bm


def bm_feats(bm, sharp_deg=35.0):
    """Generic chip sites of a closed convex member: sharp edges (with outward bisector), corners, faces, planes."""
    bm.normal_update()
    th = math.radians(sharp_deg)
    edges, corners, faces = [], [], []
    for e in bm.edges:
        if len(e.link_faces) != 2:
            continue
        n1, n2 = e.link_faces[0].normal.copy(), e.link_faces[1].normal.copy()
        if n1.angle(n2, 0) > th:
            edges.append((e.verts[0].co.copy(), e.verts[1].co.copy(), (n1 + n2).normalized(), (n1, n2)))
    for v in bm.verts:
        ns = []
        for f in v.link_faces:
            if all(f.normal.angle(n, 0) > th for n in ns):
                ns.append(f.normal.copy())
        if len(ns) >= 3:
            corners.append((v.co.copy(), sum(ns, Vector()).normalized(), ns))
    for f in bm.faces:
        A = f.calc_area()
        faces.append((f.calc_center_median(), f.normal.copy(), math.sqrt(A), math.sqrt(A), A))
    planes = [(f.calc_center_median(), f.normal.copy()) for f in bm.faces]
    return edges, corners, faces, planes


def spall_bm(p, d, r, flat, depth, seed, elong=1.0, axis=None):
    """Flattened jagged ellipsoid whose short axis is `d`, sunk `depth` past the tangent plane at p (a flake scar)."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
    off = Vector((seed * 2.7, seed * 1.1, seed * 3.9))
    for v in bm.verts:
        q = v.co.copy()
        v.co = q * (1 + 0.22 * noise.noise(q * 1.9 + off) + 0.08 * noise.noise(q * 5.0 + off))
        v.co.x *= r * elong
        v.co.y *= r
        v.co.z *= r * flat
    a = r * flat
    M = frame(p + d * (a - depth), d, axis if axis is not None else Vector((0, 0, 1)))
    bm.transform(M @ Matrix.Rotation(seed * 2.3, 4, "Z"))
    return bm


def _inside_any(p, solids, margin=0.035):
    for planes in solids:
        if all((p - c).dot(n) < margin for c, n in planes):
            return True
    return False


def _exposed(p, normals, solids, step=0.06):
    return not any(_inside_any(p + n * step, solids) for n in normals)


def spall_cutters(feats, n_edge, n_corner, n_face, rr, seed, face_rr=(0.2, 0.4), zmin=-1e9, solids=(),
                  flake_depth=(0.008, 0.02)):
    """feats: (edges, corners, faces[, planes]) - flake-scar cutters on exposed edges / corners / faces.
    `solids` = list of plane-sets of all members; sites buried against another member (seams) are skipped."""
    rng = random.Random(seed)
    edges, corners, faces = feats[:3]
    out = []
    if edges and n_edge:
        w = [(a - b).length for a, b, *_ in edges]
        tries = k = 0
        while k < n_edge and tries < n_edge * 8:
            tries += 1
            a, b, d, ns = rng.choices(edges, w)[0]
            p = a.lerp(b, rng.uniform(0.04, 0.96))
            if p.z < zmin or (solids and not _exposed(p, ns, solids)):
                continue
            k += 1
            r = rng.uniform(*rr) * (1.8 if rng.random() < 0.25 else 1.0)
            out.append(spall_bm(p, d, r, rng.uniform(0.4, 0.65), r * rng.uniform(0.18, 0.42), seed * 17 + k,
                                elong=rng.uniform(1.0, 1.8), axis=(b - a)))
    if corners and n_corner:
        tries = k = 0
        while k < n_corner and tries < n_corner * 8:
            tries += 1
            p, d, ns = rng.choice(corners)
            if p.z < zmin or (solids and not _exposed(p, ns, solids)):
                continue
            k += 1
            r = rng.uniform(*rr) * 1.6
            out.append(spall_bm(p, d, r, rng.uniform(0.5, 0.75), r * rng.uniform(0.35, 0.6), seed * 23 + k))
    if faces and n_face:
        w = [f[4] if len(f) > 4 else f[2] * f[3] for f in faces]
        tries = k = 0
        while k < n_face and tries < n_face * 8:
            tries += 1
            c, n, eu, ev = rng.choices(faces, w)[0][:4]
            if n.z < -0.9:
                continue
            t = n.orthogonal().normalized()
            bt = n.cross(t)
            p = c + t * rng.uniform(-0.35, 0.35) * eu + bt * rng.uniform(-0.35, 0.35) * ev
            if p.z < zmin or (solids and not _exposed(p, [n], solids)):
                continue
            k += 1
            r = rng.uniform(*face_rr)
            out.append(spall_bm(p, n, r, 0.12, rng.uniform(*flake_depth), seed * 29 + k, elong=rng.uniform(1.2, 2.0)))
    return out


def edge_wear(o, amt=0.02, groove=0.012, scale=3.0, seed=0):
    """Erode convex arrises (irregularly, noise-modulated) and deepen concave seams/cracks."""
    me = o.data
    co, nr, ed = _arrays(me)
    nv = len(co)
    acc = np.zeros_like(co)
    cnt = np.zeros(nv)
    np.add.at(acc, ed[:, 0], co[ed[:, 1]])
    np.add.at(acc, ed[:, 1], co[ed[:, 0]])
    np.add.at(cnt, ed[:, 0], 1)
    np.add.at(cnt, ed[:, 1], 1)
    lap = co - acc / np.maximum(cnt, 1)[:, None]
    el = np.linalg.norm(co[ed[:, 0]] - co[ed[:, 1]], axis=1).mean()
    k = (lap * nr).sum(1) / (el * el)
    k = _smooth_field(k, ed, 4, nv)
    s = np.percentile(np.abs(k), 97) + 1e-9
    cvx = np.clip(k / s, 0, 1)
    ccv = np.clip(-k / s, 0, 1)
    off = Vector((seed * 4.1, seed * 2.9, seed * 6.3))
    nz = np.array([0.5 + 0.5 * fbm(Vector(c) * scale + off, 3) for c in co])
    nz = np.clip(nz * 2.2 - 0.7, 0, 1)
    d = -(amt * cvx ** 0.8 * (0.25 + 0.75 * nz)) - groove * ccv ** 0.7
    co += nr * d[:, None]
    me.vertices.foreach_set("co", co.ravel())
    me.update()
    return o


def crazing(o, depth=0.006, scale=5.0, seed=0, thr=0.93):
    """Fine network of weathering crevices (ridged-noise zero crossings pushed inward)."""
    me = o.data
    co, nr, ed = _arrays(me)
    off = Vector((seed * 1.3, seed * 4.7, seed * 2.2))
    v = np.array([1 - abs(noise.noise(Vector(c) * scale + off)) for c in co])
    m = np.array([0.5 + 0.5 * noise.noise(Vector(c) * 1.3 + off * 2) for c in co])
    d = smoothstep(thr, 1.0, v) * smoothstep(0.35, 0.65, m)
    co -= nr * (d * depth)[:, None]
    me.vertices.foreach_set("co", co.ravel())
    me.update()
    return o


def crack_groove(o, origin, normal, along, Lu, Lv, width, depth, wander=0.03, seed=0):
    """Weathered crack as a V-groove: vertices near a wandering plane (inside an elliptic patch of it) pushed inward."""
    me = o.data
    co, nr, ed = _arrays(me)
    z = Vector(normal).normalized()
    x = Vector(along)
    x = (x - z * x.dot(z)).normalized()
    y = z.cross(x)
    q = co - np.array(origin)
    u, v, w = q @ np.array(x), q @ np.array(y), q @ np.array(z)
    sel = np.where((np.abs(u) < Lu * 1.4) & (np.abs(v) < Lv * 1.4) & (np.abs(w) < wander * 3 + width * 2))[0]
    off = Vector((seed * 3.3, seed * 1.9, seed * 0.7))
    for i in sel:
        p2 = Vector((u[i], v[i], 0))
        e = (u[i] / Lu) ** 2 + (v[i] / Lv) ** 2
        e *= 1 + 0.35 * noise.noise(p2 * 3 + off)
        m = max(0.0, 1 - e) ** 0.6
        if m <= 0:
            continue
        sw = w[i] - wander * (fbm(p2 * 5 + off, 3) * 1.4 + 0.15 * noise.noise(p2 * 11 + off))
        wd = width * (0.55 + 0.45 * m) * (0.75 + 0.25 * noise.noise(p2 * 9 + off))
        g = max(0.0, 1 - abs(sw) / wd) ** 1.6 * m
        co[i] -= nr[i] * depth * g
    me.vertices.foreach_set("co", co.ravel())
    me.update()
    return o


def member_bm(m):
    """(sx, sy, sz, M) base-centred box tuple or a ready (world-space) BMesh."""
    if isinstance(m, bmesh.types.BMesh):
        return m
    sx, sy, sz, M = m
    b = box_bm(sx, sy, sz, (0, 0, sz / 2))
    b.transform(M)
    return b


def sculpt(name, members, voxel=0.013, bevel_w=0.026, cutters=(), chips=8, chip_r=(0.05, 0.16), seed=0,
           ero=(0.022, 0.6), mid=(0.012, 0.15), fine=(0.007, 0.04), pits=0.005, wear=(0.02, 0.014),
           target=4000, cut_ground=False, post=None, flakes=None, corners=None, zmin=-1e9, cracks=(),
           fresh=0.5, face_rr=(0.2, 0.4), bevel_seg=3, flake_depth=(0.008, 0.02), crazing_on=True):
    """members: (sx, sy, sz, Matrix) base-centred boxes and/or closed convex BMeshes (world space).
    cutters: jagged break solids (weathered). cracks: crack_groove arg tuples.
    Chips: spall booleans on exposed edges/corners/faces; `fresh` fraction is applied after erosion (crisp facets)."""
    bm = bmesh.new()
    E, Cn, F, solids = [], [], [], []
    for m in members:
        b = member_bm(m)
        e, c, f, pl = bm_feats(b)
        E += e
        Cn += c
        F += f
        solids.append(pl)
        tmp = bpy.data.meshes.new("_t")
        b.to_mesh(tmp)
        b.free()
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    if len(solids) < 2:
        solids = []
    o = bm_to_obj(name, bm)
    bevel(o, bevel_w, bevel_seg, angle=30)
    remesh(o, voxel)
    n_face = flakes if flakes is not None else max(2, chips // 2)
    n_corner = corners if corners is not None else max(2, chips // 3)
    sp = spall_cutters((E, Cn, F), chips, n_corner, n_face, chip_r, seed + 101, face_rr, zmin=zmin, solids=solids,
                       flake_depth=flake_depth)
    random.Random(seed).shuffle(sp)
    nf = int(len(sp) * fresh)
    boolean(o, list(cutters) + sp[nf:])
    if cut_ground:
        ground_cut(o)
    remesh(o, voxel)
    if cracks:
        for k, c in enumerate(cracks):
            crack_groove(o, *c, seed=seed + 7 * k)
        remesh(o, voxel)
    if wear:
        edge_wear(o, wear[0], wear[1], 3.0 * 0.026 / max(bevel_w, 0.01), seed)
        if crazing_on:
            crazing(o, 0.006, 4.0, seed)
    displace(o, ero[0], ero[1], "CLOUDS", 3, seed)
    displace(o, mid[0], mid[1], "CLOUDS", 2, seed + 3)
    displace(o, fine[0], fine[1], "CLOUDS", 2, seed + 5)
    if pits:
        displace(o, pits, 0.02, "STUCCI", 1, seed + 9)
    boolean(o, sp[:nf])
    if post:
        post(o)
    decimate(o, target)
    return o


# ------------------------------------------------------------------ masonry layout helpers
def course_blocks(x0, x1, y0, y1, z0, z1, ch, seed, lx=(0.9, 1.6), ny=2, gap=0.04, jit=0.015, skip=None,
                  rot=0.006):
    """Fill the box [x0,x1]x[y0,y1]x[z0,z1] with coursed ashlar (course height ch, random x joints staggered per
    course, `ny` blocks through the depth). Blocks are shrunk by `gap` so joints read as real grooves.
    skip(course, xa, xb, ya, yb) -> True drops a block (ruined / stepped tops)."""
    rng = random.Random(seed)
    out = []
    nc = max(1, round((z1 - z0) / ch))
    hh = (z1 - z0) / nc
    for c in range(nc):
        z = z0 + c * hh
        ys = [y0] + sorted(rng.uniform(y0 + (y1 - y0) * (k + 0.3) / ny, y0 + (y1 - y0) * (k + 0.7) / ny)
                           for k in range(ny - 1)) + [y1]
        for j in range(ny):
            ya, yb = ys[j], ys[j + 1]
            x = x0 - rng.uniform(0, lx[0] * 0.8)
            while x < x1 - 1e-3:
                L = rng.uniform(*lx)
                xa, xb = max(x, x0), min(x + L, x1)
                if x1 - xb < lx[0] * 0.35:
                    xb = x1
                    L = xb - x
                if xb - xa > 0.15 and not (skip and skip(c, xa, xb, ya, yb)):
                    M = Matrix.Translation(((xa + xb) / 2 + rng.uniform(-jit, jit), (ya + yb) / 2 + rng.uniform(-jit, jit),
                                            z + rng.uniform(-jit * 0.3, 0))) @ Matrix.Rotation(rng.uniform(-rot, rot), 4, "Z")
                    out.append((xb - xa - gap, yb - ya - gap * (0.0 if j in (0, ny - 1) and ny == 1 else 1.0),
                                hh - gap * 0.7, M))
                x += L
    return out


def voussoir_ring(xc, zs, ri, ro, y0, y1, n, seed, a0=0.0, a1=math.pi, keep=None, key_extra=0.0, gap=0.05,
                  jit=0.02, offset=0.0):
    """Arch ring (axis along Y) of `n` wedge voussoirs between angles a0..a1 (0 = springing at -X side)."""
    rng = random.Random(seed)
    out = []
    da = (a1 - a0) / n
    for k in range(n + (1 if offset else 0)):
        b0 = a0 + (k - offset) * da
        b1 = b0 + da
        b0, b1 = max(b0, a0), min(b1, a1)
        if b1 - b0 < 1e-3 or (keep is not None and k not in keep):
            continue
        key = abs((b0 + b1) / 2 - math.pi / 2) < da * 0.5
        ga = gap / 2 / ((ri + ro) / 2)
        b0, b1 = b0 + (ga if b0 > a0 + 1e-6 else 0.0), b1 - (ga if b1 < a1 - 1e-6 else 0.0)
        r2 = ro + (key_extra if key else 0.0)
        P = lambda a, r, y: Vector((xc - math.cos(a) * r, y, zs + math.sin(a) * r))
        pts = [P(b0, ri, y0), P(b1, ri, y0), P(b1, r2, y0), P(b0, r2, y0),
               P(b0, ri, y1), P(b1, ri, y1), P(b1, r2, y1), P(b0, r2, y1)]
        c = sum(pts, Vector()) / 8
        j = Vector((rng.uniform(-jit, jit) * 0.5, rng.uniform(-jit, jit), rng.uniform(-jit, 0)))
        out.append(hexa_bm([p + j for p in pts]))
    return out


def cyl_cutter_y(xc, zc, r, length=20.0, seg=72):
    return cyl_bm(r, r, length, seg, Matrix.Translation((xc, length / 2, zc)) @ Matrix.Rotation(math.pi / 2, 4, "X"))


# ------------------------------------------------------------------ finalize: shading, UV, colours
def _arrays(me):
    nv = len(me.vertices)
    co = np.empty(nv * 3, np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    nr = np.empty(nv * 3, np.float64)
    me.vertices.foreach_get("normal", nr)
    nr = nr.reshape(-1, 3)
    ed = np.empty(len(me.edges) * 2, np.int64)
    me.edges.foreach_get("vertices", ed)
    ed = ed.reshape(-1, 2)
    return co, nr, ed


def _smooth_field(f, ed, iters, nv):
    for _ in range(iters):
        acc = np.zeros_like(f)
        cnt = np.zeros(nv)
        np.add.at(acc, ed[:, 0], f[ed[:, 1]])
        np.add.at(acc, ed[:, 1], f[ed[:, 0]])
        np.add.at(cnt, ed[:, 0], 1)
        np.add.at(cnt, ed[:, 1], 1)
        cnt = np.maximum(cnt, 1)
        f = 0.5 * f + 0.5 * (acc / (cnt[:, None] if f.ndim == 2 else cnt))
    return f


def box_uv(o, smooth_iters=8):
    me = o.data
    co, nr, ed = _arrays(me)
    nv = len(co)
    sn = _smooth_field(nr.copy(), ed, smooth_iters, nv)
    nl = len(me.loops)
    lv = np.empty(nl, np.int64)
    me.loops.foreach_get("vertex_index", lv)
    ls = np.empty(len(me.polygons), np.int64)
    lt = np.empty(len(me.polygons), np.int64)
    me.polygons.foreach_get("loop_start", ls)
    me.polygons.foreach_get("loop_total", lt)
    lf = np.repeat(np.arange(len(me.polygons)), lt)
    fn = np.zeros((len(me.polygons), 3))
    np.add.at(fn, lf, sn[lv])
    ax = np.argmax(np.abs(fn), axis=1)
    sg = np.sign(fn[np.arange(len(fn)), ax])
    sg[sg == 0] = 1
    p = co[lv] * UV_SCALE
    la, lsg = ax[lf], sg[lf]
    u = np.where(la == 0, p[:, 1] * lsg, np.where(la == 1, -p[:, 0] * lsg, p[:, 0]))
    v = np.where(la == 2, p[:, 1] * lsg, p[:, 2])
    uvl = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    uvl.data.foreach_set("uv", np.stack([u, v], 1).ravel())
    me.uv_layers.active = uvl
    return uv_density(o)


def uv_density(o):
    """Returns (uv area / surface area, metres per UV unit) - ideal 0.25 / 2.0."""
    me = o.data
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    tl = np.empty(nt * 3, np.int64)
    me.loop_triangles.foreach_get("loops", tl)
    tv = np.empty(nt * 3, np.int64)
    me.loop_triangles.foreach_get("vertices", tv)
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)[tv].reshape(-1, 3, 3)
    uv = np.empty(len(me.loops) * 2)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)[tl].reshape(-1, 3, 2)
    A = 0.5 * np.linalg.norm(np.cross(co[:, 1] - co[:, 0], co[:, 2] - co[:, 0]), axis=1).sum()
    e1, e2 = uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0]
    U = 0.5 * np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]).sum()
    r = U / max(A, 1e-9)
    return r, 1 / math.sqrt(max(r, 1e-9))


def _hemi(k, seed=1):
    rng = np.random.default_rng(seed)
    out = []
    ga = math.pi * (3 - math.sqrt(5))
    for i in range(k):
        r = math.sqrt((i + 0.5) / k)               # cosine-weighted disk -> hemisphere
        a = i * ga + rng.uniform(0, 0.3)
        x, y = r * math.cos(a), r * math.sin(a)
        out.append((x, y, math.sqrt(max(0.0, 1 - r * r))))
    return out


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def bake_col(o, ao_dist=1.5, rays=24, ground=True, moss_scale=0.8, moss_low=0.35, seed=0, eps=0.004, up_w=0.9):
    me = o.data
    co, nr, ed = _arrays(me)
    nv = len(co)
    me.calc_loop_triangles()
    polys = [tuple(t.vertices) for t in me.loop_triangles]
    bvh = BVHTree.FromPolygons([Vector(c) for c in co], polys, all_triangles=True, epsilon=0.0)
    H = _hemi(rays, seed + 3)
    occ = np.zeros(nv)
    zmin = co[:, 2].min()
    for i in range(nv):
        n = Vector(nr[i])
        p = Vector(co[i]) + n * eps
        t = n.orthogonal().normalized()
        b = n.cross(t)
        hit = 0
        for x, y, z in H:
            d = t * x + b * y + n * z
            if ground and d.z < -1e-3 and (p.z - zmin) / -d.z < ao_dist:
                hit += 1
                continue
            if bvh.ray_cast(p, d, ao_dist)[0] is not None:
                hit += 1
        occ[i] = hit / rays
    ao = 1 - occ
    # convexity (edge wear / cavity)
    d = co[ed[:, 0]] - co[ed[:, 1]]
    dl = np.linalg.norm(d, axis=1)[:, None] + 1e-9
    d /= dl
    cv = np.zeros(nv)
    cnt = np.zeros(nv)
    np.add.at(cv, ed[:, 0], (nr[ed[:, 0]] * d).sum(1))
    np.add.at(cv, ed[:, 1], -(nr[ed[:, 1]] * d).sum(1))
    np.add.at(cnt, ed[:, 0], 1)
    np.add.at(cnt, ed[:, 1], 1)
    cv /= np.maximum(cnt, 1)
    cv = _smooth_field(cv, ed, 2, nv)
    ao = _smooth_field(ao, ed, 1, nv)
    R = np.clip(ao * (1 - 0.6 * smoothstep(0.0, -0.25, cv)) ** 1.0, 0, 1)
    # noise fields
    off = Vector((seed * 1.7, seed * 5.3, seed * 2.1))
    nz1 = np.array([fbm(Vector(c) * moss_scale + off, 3) for c in co])
    nz2 = np.array([noise.noise(Vector(c) * 3.3 + off) for c in co])
    B = np.clip(smoothstep(0.03, 0.3, cv) * (0.75 + 0.25 * nz2) + 0.15 * smoothstep(0.3, 0.7, nz2), 0, 1)
    up = smoothstep(0.25, 0.85, nr[:, 2])
    crev = (1 - ao) * smoothstep(-0.4, 0.2, nr[:, 2])
    h = co[:, 2] - zmin
    low = 1 - smoothstep(0.0, moss_low, h)
    breakup = smoothstep(-0.35, 0.3, nz1)
    G = np.clip((up * up_w + crev * 0.9 + low * 0.45 * smoothstep(-0.6, 0.2, nr[:, 2])) * breakup
                * (1 - 0.6 * B), 0, 1)
    G = _smooth_field(G, ed, 1, nv)
    col = me.color_attributes.get("Col") or me.color_attributes.new("Col", "BYTE_COLOR", "POINT")
    rgba = np.stack([R, G, B, np.ones(nv)], 1).astype(np.float32)
    col.data.foreach_set("color", rgba.ravel())
    me.color_attributes.active_color = col
    me.color_attributes.render_color_index = me.color_attributes.active_color_index
    return float(R.mean()), float(G.mean()), float(B.mean())


def components(nv, ed):
    """Connected-component label per vertex (vectorised hook + pointer-jumping union-find)."""
    parent = np.arange(nv)
    if len(ed) == 0:
        return parent
    for _ in range(200):
        p0, p1 = parent[ed[:, 0]], parent[ed[:, 1]]
        if (p0 == p1).all():
            break
        lo, hi = np.minimum(p0, p1), np.maximum(p0, p1)
        np.minimum.at(parent, hi, lo)
        while True:
            pp = parent[parent]
            if (pp == parent).all():
                break
            parent = pp
    return parent


def drop_specks(o, min_size=0.1, min_verts=40):
    """Delete tiny disconnected fragments (boolean / decimation leftovers)."""
    me = o.data
    co, nr, ed = _arrays(me)
    lab = components(len(co), ed)
    uniq, inv, cnt = np.unique(lab, return_inverse=True, return_counts=True)
    lo = np.full((len(uniq), 3), np.inf)
    hi = np.full((len(uniq), 3), -np.inf)
    np.minimum.at(lo, inv, co)
    np.maximum.at(hi, inv, co)
    diag = np.linalg.norm(hi - lo, axis=1)
    bad = (cnt < min_verts) | (diag < min_size)
    if not bad.any():
        return 0
    kill = np.where(bad[inv])[0]
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in kill], context="VERTS")
    bm.to_mesh(me)
    bm.free()
    me.update()
    return int(bad.sum())


def finalize(o, sharp=55, origin="base", ao_dist=1.5, rays=24, moss_scale=0.8, moss_low=0.35, seed=0, eps=0.004,
             up_w=0.9, speck=0.06):
    me = o.data
    drop_specks(o, speck)
    if origin == "base":
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        c = (co.min(0) + co.max(0)) / 2
        me.transform(Matrix.Translation((-c[0], -c[1], -co[:, 2].min())))
    elif origin == "z":
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        me.transform(Matrix.Translation((0, 0, -co.reshape(-1, 3)[:, 2].min())))
    me.update()
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.set_sharp_from_angle(angle=math.radians(sharp))
    dens = box_uv(o)
    m = bake_col(o, ao_dist, rays, True, moss_scale, moss_low, seed, eps, up_w)
    me.materials.clear()
    me.materials.append(stone_mat())
    me.update()
    dims = o.dimensions
    print(f"  {o.name:16s} tris={tris(o):7d}  dims=({dims.x:.2f},{dims.y:.2f},{dims.z:.2f})  "
          f"uv_ratio={dens[0]:.3f} ({dens[1]:.2f} m/UV)  col_mean=({m[0]:.2f},{m[1]:.2f},{m[2]:.2f})")
    return o


def export(objs, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, **EXPORT_KW)
    print("EXPORTED", path, len(objs), "objects,", sum(tris(o) for o in objs), "tris")
