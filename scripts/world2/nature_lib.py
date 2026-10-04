"""Shared helpers for the world2 nature kit (cliffs / rocks / maple trees / mountains).

Vectorised numpy noise (gradient noise, fbm, ridged multifractal, 3D Voronoi), numpy<->mesh plumbing, voxel remesh,
decimation, world-scale box UVs, `Col` vertex-colour attribute, placeholder materials and glTF export.
Imported by nature_build.py (run inside Blender).
"""
import math
import bpy
import numpy as np




# ------------------------------------------------------------------ noise
class Noise:
    """Classic 3D gradient (Perlin) noise, vectorised. Output roughly in [-1, 1]."""

    def __init__(self, seed=0):
        rs = np.random.RandomState(seed)
        p = rs.permutation(256)
        self.p = np.concatenate([p, p]).astype(np.int64)
        self.off = rs.uniform(-1000, 1000, 3)

    @staticmethod
    def _fade(t):
        return t * t * t * (t * (t * 6 - 15) + 10)

    @staticmethod
    def _grad(h, x, y, z):
        h = h & 15
        u = np.where(h < 8, x, y)
        v = np.where(h < 4, y, np.where((h == 12) | (h == 14), x, z))
        return np.where(h & 1, -u, u) + np.where(h & 2, -v, v)

    def __call__(self, x, y, z):
        x = np.asarray(x, np.float64) + self.off[0]
        y = np.asarray(y, np.float64) + self.off[1]
        z = np.asarray(z, np.float64) + self.off[2]
        xf, yf, zf = np.floor(x), np.floor(y), np.floor(z)
        X, Y, Z = xf.astype(np.int64) & 255, yf.astype(np.int64) & 255, zf.astype(np.int64) & 255
        x, y, z = x - xf, y - yf, z - zf
        u, v, w = self._fade(x), self._fade(y), self._fade(z)
        p = self.p
        A = p[X] + Y; AA = p[A] + Z; AB = p[A + 1] + Z
        B = p[X + 1] + Y; BA = p[B] + Z; BB = p[B + 1] + Z
        g = self._grad
        lerp = lambda t, a, b: a + t * (b - a)
        r = lerp(w, lerp(v, lerp(u, g(p[AA], x, y, z), g(p[BA], x - 1, y, z)),
                         lerp(u, g(p[AB], x, y - 1, z), g(p[BB], x - 1, y - 1, z))),
                 lerp(v, lerp(u, g(p[AA + 1], x, y, z - 1), g(p[BA + 1], x - 1, y, z - 1)),
                      lerp(u, g(p[AB + 1], x, y - 1, z - 1), g(p[BB + 1], x - 1, y - 1, z - 1))))
        return r * 1.1

    def fbm(self, x, y, z, octaves=4, lac=2.03, gain=0.5):
        s, a, f, norm = 0.0, 1.0, 1.0, 0.0
        for o in range(octaves):
            s = s + a * self(x * f + o * 17.3, y * f - o * 9.1, z * f + o * 3.7)
            norm += a
            a *= gain
            f *= lac
        return s / norm

    def ridged(self, x, y, z, octaves=5, lac=2.1, gain=0.55, offset=1.0):
        """Ridged multifractal (Musgrave-ish), output ~[0,1], sharp crests."""
        s, f, w, norm, a = 0.0, 1.0, 1.0, 0.0, 1.0
        for o in range(octaves):
            n = offset - np.abs(self(x * f + o * 11.1, y * f + o * 5.3, z * f - o * 7.7))
            n = n * n
            n = n * w
            w = np.clip(n * 1.6, 0, 1)
            s = s + n * a
            norm += a
            a *= gain
            f *= lac
        return s / norm


def _hash3(cx, cy, cz, seed):
    """int64 cell coords -> three floats in [0,1)."""
    h = (cx.astype(np.int64) * 73856093) ^ (cy.astype(np.int64) * 19349663) ^ (cz.astype(np.int64) * 83492791) ^ (seed * 2654435761)
    h = h & 0xFFFFFFFF
    out = []
    for k in range(4):
        h = (h ^ (h >> 16)) * 0x45d9f3b & 0xFFFFFFFF
        h = (h ^ (h >> 16)) * 0x45d9f3b & 0xFFFFFFFF
        h = h ^ (h >> 16)
        out.append((h & 0xFFFFFF) / float(0x1000000))
        h = h + 0x9E3779B9 + k
    return out


def voronoi(p, seed=0, jitter=1.0):
    """3D Voronoi on points p (N,3). Returns F1, F2 (distances) and a per-cell random value in [0,1)."""
    cell = np.floor(p)
    f = p - cell
    ci = cell.astype(np.int64)
    F1 = np.full(len(p), 9.0)
    F2 = np.full(len(p), 9.0)
    rid = np.zeros(len(p))
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                hx, hy, hz, hv = _hash3(ci[:, 0] + dx, ci[:, 1] + dy, ci[:, 2] + dz, seed)
                ox = dx + 0.5 + (hx - 0.5) * jitter - f[:, 0]
                oy = dy + 0.5 + (hy - 0.5) * jitter - f[:, 1]
                oz = dz + 0.5 + (hz - 0.5) * jitter - f[:, 2]
                d = np.sqrt(ox * ox + oy * oy + oz * oz)
                closer = d < F1
                F2 = np.where(closer, F1, np.minimum(F2, d))
                rid = np.where(closer, hv, rid)
                F1 = np.where(closer, d, F1)
    return F1, F2, rid


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------ materials
def srgb(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def mat(name, color, rough=0.9):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*srgb(color), 1)
    b.inputs["Roughness"].default_value = rough
    m.diffuse_color = (*srgb(color), 1)
    return m


def materials():
    return {
        "rock": mat("Rock", "#7a7570", 0.95),
        "bark": mat("Bark", "#3a2a25", 0.95),
        "leaf_red": mat("Leaf_Red", "#b8283a", 0.9),
        "leaf_orange": mat("Leaf_Orange", "#d0602a", 0.9),
    }


# ------------------------------------------------------------------ mesh plumbing
def link(name, me):
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def mesh_from_np(name, verts, faces):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in np.asarray(verts, float)], [], [tuple(int(i) for i in f) for f in faces])
    me.validate()
    me.update()
    return me


def get_co(me):
    a = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", a)
    return a.reshape(-1, 3)


def set_co(me, co):
    me.vertices.foreach_set("co", np.ascontiguousarray(co, dtype=np.float32).ravel())
    me.update()


def get_vnormals(me):
    a = np.empty(len(me.vertices) * 3)
    me.vertex_normals.foreach_get("vector", a)
    return a.reshape(-1, 3)


def get_edges(me):
    e = np.empty(len(me.edges) * 2, np.int64)
    me.edges.foreach_get("vertices", e)
    return e.reshape(-1, 2)


def smooth_field(me, field, iters=4, edges=None):
    """Laplacian smoothing of a per-vertex field (N,k) over mesh edges."""
    e = get_edges(me) if edges is None else edges
    n = len(me.vertices)
    f = field.copy()
    deg = np.bincount(e.ravel(), minlength=n).astype(float)
    deg[deg == 0] = 1
    for _ in range(iters):
        acc = np.zeros_like(f)
        np.add.at(acc, e[:, 0], f[e[:, 1]])
        np.add.at(acc, e[:, 1], f[e[:, 0]])
        if f.ndim == 1:
            f = 0.5 * f + 0.5 * acc / deg
        else:
            f = 0.5 * f + 0.5 * acc / deg[:, None]
    return f


def smooth_normals(me, iters=6):
    n = smooth_field(me, get_vnormals(me), iters)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)


def apply_modifiers(o):
    dg = bpy.context.evaluated_depsgraph_get()
    oe = o.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(oe)
    old = o.data
    o.modifiers.clear()
    o.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return o


def remesh(o, voxel, smooth=True):
    m = o.modifiers.new("remesh", "REMESH")
    m.mode = "VOXEL"
    m.voxel_size = voxel
    m.adaptivity = 0.0
    m.use_smooth_shade = smooth
    return apply_modifiers(o)


def tri_count(me):
    lt = np.empty(len(me.polygons), np.int64)
    me.polygons.foreach_get("loop_total", lt)
    return int((lt - 2).sum())


def decimate(o, target_tris, symmetric=False):
    for _ in range(3):
        t = tri_count(o.data)
        if t <= target_tris:
            break
        m = o.modifiers.new("dec", "DECIMATE")
        m.decimate_type = "COLLAPSE"
        m.ratio = max(0.001, target_tris / t * 0.98)
        m.use_collapse_triangulate = True
        apply_modifiers(o)
    return o


def triangulate(o):
    m = o.modifiers.new("tri", "TRIANGULATE")
    return apply_modifiers(o)


def laplacian_relax(me, iters=2, factor=0.5):
    co = get_co(me)
    sm = smooth_field(me, co, iters)
    set_co(me, co + (sm - co) * factor)


# ------------------------------------------------------------------ UVs / colours / shading
def box_uv(me, scale, name="UVMap"):
    """World-scale box projection: per face, project along the dominant normal axis. 1 UV unit = `scale` metres."""
    uvl = me.uv_layers.get(name) or me.uv_layers.new(name=name)
    nl = len(me.loops)
    lv = np.empty(nl, np.int64)
    me.loops.foreach_get("vertex_index", lv)
    co = get_co(me)
    fn = np.empty(len(me.polygons) * 3)
    me.polygons.foreach_get("normal", fn)
    fn = fn.reshape(-1, 3)
    ls = np.empty(len(me.polygons), np.int64)
    lt = np.empty(len(me.polygons), np.int64)
    me.polygons.foreach_get("loop_start", ls)
    me.polygons.foreach_get("loop_total", lt)
    face_of_loop = np.repeat(np.arange(len(me.polygons)), lt)
    n = fn[face_of_loop]
    p = co[lv]
    ax = np.argmax(np.abs(n), axis=1)
    sgn = np.sign(n[np.arange(nl), ax])
    sgn[sgn == 0] = 1
    u = np.where(ax == 0, -p[:, 1] * sgn, np.where(ax == 1, p[:, 0] * sgn, p[:, 0]))
    v = np.where(ax == 2, p[:, 1] * sgn, p[:, 2])
    uv = np.stack([u, v], 1) / scale
    uvl.data.foreach_set("uv", uv.astype(np.float32).ravel())
    return uvl


def uv_density(me, name="UVMap"):
    """Median metres-per-UV-unit (sqrt(area3d / areaUV)) over triangles."""
    me.calc_loop_triangles()
    lt = np.empty(len(me.loop_triangles) * 3, np.int64)
    me.loop_triangles.foreach_get("loops", lt)
    lt = lt.reshape(-1, 3)
    lv = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get("vertex_index", lv)
    co = get_co(me)[lv[lt]]
    uv = np.empty(len(me.loops) * 2)
    me.uv_layers[name].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)[lt]
    a3 = 0.5 * np.linalg.norm(np.cross(co[:, 1] - co[:, 0], co[:, 2] - co[:, 0]), axis=1)
    e1, e2 = uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0]
    a2 = 0.5 * np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0])
    ok = (a2 > 1e-12) & (a3 > 1e-9)
    r = np.sqrt(a3[ok] / a2[ok])
    return float(np.median(r)), float(np.percentile(r, 10)), float(np.percentile(r, 90))


def set_col(me, rgba):
    """rgba (N,4) per vertex -> FLOAT_COLOR POINT attribute `Col`, made active + render."""
    a = me.color_attributes.get("Col")
    if a is None:
        a = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    a.data.foreach_set("color", np.ascontiguousarray(np.clip(rgba, 0, 1), dtype=np.float32).ravel())
    me.color_attributes.active_color = a
    try:
        me.color_attributes.render_color_index = me.color_attributes.active_color_index
    except Exception:
        pass
    return a


def shade(me, sharp_deg=None):
    me.shade_smooth()
    if sharp_deg is not None:
        me.set_sharp_from_angle(angle=math.radians(sharp_deg))


def ray_ao(o, others=(), rays=24, dist=10.0, bias=0.02, seed=1, up_bias=0.0):
    """Hemisphere ray-cast AO per vertex of `o` against `o` + `others` (BVH). Returns (N,) in [0,1] (1 = open)."""
    from mathutils.bvhtree import BVHTree
    trees = []
    for ob in (o, *others):
        bm_co = get_co(ob.data) @ np.array(ob.matrix_world)[:3, :3].T + np.array(ob.matrix_world)[:3, 3]
        polys = [tuple(p.vertices) for p in ob.data.polygons]
        trees.append(BVHTree.FromPolygons([tuple(c) for c in bm_co], polys))
    co = get_co(o.data)
    nrm = get_vnormals(o.data)
    rs = np.random.RandomState(seed)
    d = rs.normal(size=(rays, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    out = np.empty(len(co))
    from mathutils import Vector
    for i in range(len(co)):
        n = nrm[i]
        dirs = d * np.where((d @ n) < 0, -1.0, 1.0)[:, None]
        if up_bias:
            dirs = dirs + np.array([0, 0, up_bias])
            dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        p0 = Vector(co[i] + n * bias)
        hit = 0.0
        for k in range(rays):
            dv = Vector(dirs[k])
            for t in trees:
                h = t.ray_cast(p0, dv, dist)
                if h[0] is not None:
                    hit += 1.0 - 0.5 * (h[3] / dist)
                    break
        out[i] = 1.0 - hit / rays
    return out


def export_glb(path, objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        if o.type == "MESH":
            o.data.name = o.name
            o.data.validate()
        o.select_set(True)
        for c in o.children_recursive:
            c.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True,
                              export_apply=True, export_texcoords=True, export_normals=True,
                              export_vertex_color="ACTIVE", export_all_vertex_colors=False,
                              export_materials="EXPORT", export_image_format="NONE")


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for m in list(bpy.data.meshes):
        bpy.data.meshes.remove(m)
