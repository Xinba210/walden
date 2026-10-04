"""Preview renders + re-import report for the world2 nature kit.

  blender -b --factory-startup --python scripts/world2/nature_preview.py -- cliffs|trees|mountains [--verify-only] [--fast]

Imports the exported GLB into a fresh session, prints per-object stats (tris, UV / colour layers, bbox, UV density),
then renders Cycles previews to scripts/world2/previews/. Vertex colours are visualised: cliffs G = grass, B = talus,
R = AO; mountains G = snow, B = rock, R = AO; tree crowns are shown as leaf-card clouds scattered on the guide volume.
"""
import os
import sys
import math
import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
GLB_DIR = os.path.join(ROOT, "game", "public", "models", "world2")
PREV = os.path.join(HERE, "previews")
ARGS = sys.argv[sys.argv.index("--") + 1:]
KIND = ARGS[0]
VERIFY_ONLY = "--verify-only" in ARGS
FAST = "--fast" in ARGS

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(GLB_DIR, f"{KIND}.glb"))
SC = bpy.context.scene


# ------------------------------------------------------------------ verify
def stats():
    print(f"=== {KIND}.glb ===")
    for o in sorted(SC.objects, key=lambda o: o.name):
        if o.type != "MESH":
            if o.parent is None or o.type == "EMPTY":
                print(f"  {o.name:24s} {o.type:6s} parent={o.parent.name if o.parent else None} loc(Z-up)={tuple(round(c, 2) for c in o.matrix_world.translation)}")
            continue
        me = o.data
        me.calc_loop_triangles()
        mw = o.matrix_world
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3) @ np.array(mw)[:3, :3].T + np.array(mw)[:3, 3]
        mn, mx = co.min(0), co.max(0)
        mats = [m.name for m in me.materials]
        mi = np.empty(len(me.loop_triangles), np.int64)
        me.loop_triangles.foreach_get("material_index", mi)
        per_mat = {(mats[k] if mats else "-"): int((mi == k).sum()) for k in np.unique(mi)}
        dens = ""
        if me.uv_layers:
            lt = np.empty(len(me.loop_triangles) * 3, np.int64)
            me.loop_triangles.foreach_get("loops", lt)
            lt = lt.reshape(-1, 3)
            lv = np.empty(len(me.loops), np.int64)
            me.loops.foreach_get("vertex_index", lv)
            uv = np.empty(len(me.loops) * 2)
            me.uv_layers[0].data.foreach_get("uv", uv)
            uv = uv.reshape(-1, 2)[lt]
            P = co[lv[lt]]
            a3 = 0.5 * np.linalg.norm(np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]), axis=1)
            e1, e2 = uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0]
            a2 = 0.5 * np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0])
            ok = (a2 > 1e-12) & (a3 > 1e-9)
            r = np.sqrt(a3[ok] / a2[ok])
            dens = f"m/UV median {np.median(r):.2f} (p10 {np.percentile(r, 10):.2f}, p90 {np.percentile(r, 90):.2f})"
        cols = [(c.name, c.domain, c.data_type) for c in me.color_attributes]
        cstat = ""
        if me.color_attributes:
            ca = me.color_attributes[0]
            arr = np.empty(len(ca.data) * 4)
            ca.data.foreach_get("color", arr)
            arr = arr.reshape(-1, 4)
            cstat = "Col mean RGBA " + " ".join(f"{x:.2f}" for x in arr.mean(0)) + " min " + " ".join(f"{x:.2f}" for x in arr.min(0))
        print(f"  {o.name:24s} tris={len(me.loop_triangles):6d} {per_mat} size={tuple(round(float(s), 1) for s in mx - mn)} "
              f"bbox_min={tuple(round(float(s), 1) for s in mn)} uv={[u.name for u in me.uv_layers]} col={cols}")
        print(f"  {'':24s} {dens}  {cstat}")


stats()
if VERIFY_ONLY:
    sys.exit(0)


# ------------------------------------------------------------------ render setup
def setup_render(w=1600, h=900, samples=96):
    SC.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for dt in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = dt
                prefs.get_devices()
                for d in prefs.devices:
                    d.use = True
                SC.cycles.device = "GPU"
                break
            except Exception:
                continue
    except Exception:
        pass
    SC.cycles.samples = 24 if FAST else samples
    SC.cycles.use_denoising = True
    SC.render.resolution_x, SC.render.resolution_y = w, h
    SC.render.film_transparent = False
    SC.view_settings.view_transform = "AgX"
    SC.view_settings.exposure = -1.0
    SC.view_settings.look = "AgX - Medium High Contrast" if "AgX - Medium High Contrast" in [i.identifier for i in SC.view_settings.bl_rna.properties["look"].enum_items] else "None"
    world = bpy.data.worlds.new("W")
    SC.world = world
    world.use_nodes = True
    nt = world.node_tree
    sky = nt.nodes.new("ShaderNodeTexSky")
    for t in ("MULTIPLE_SCATTERING", "SINGLE_SCATTERING", "NISHITA", "HOSEK_WILKIE"):
        try:
            sky.sky_type = t
            break
        except Exception:
            pass
    try:
        sky.sun_elevation = math.radians(28)
        sky.sun_rotation = math.radians(215)
        sky.sun_disc = False
    except Exception:
        pass
    bg = nt.nodes["Background"]
    bg.inputs["Strength"].default_value = 0.35
    nt.links.new(sky.outputs[0], bg.inputs[0])
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 3.0
    sun.angle = math.radians(1.5)
    so = bpy.data.objects.new("Sun", sun)
    so.rotation_euler = (math.radians(62), 0, math.radians(215 - 90 + 180))
    SC.collection.objects.link(so)


def ground(size, z=0.0, color=(0.16, 0.16, 0.15)):
    me = bpy.data.meshes.new("Ground")
    s = size / 2
    me.from_pydata([(-s, -s, z), (s, -s, z), (s, s, z), (-s, s, z)], [], [(0, 1, 2, 3)])
    o = bpy.data.objects.new("Ground", me)
    SC.collection.objects.link(o)
    m = bpy.data.materials.new("GroundMat")
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*color, 1)
    m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 1.0
    me.materials.append(m)
    return o


def camera(name, loc, target, lens=35, clip=5000):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.clip_end = clip
    cd.clip_start = 0.1
    c = bpy.data.objects.new(name, cd)
    SC.collection.objects.link(c)
    c.location = loc
    d = Vector(target) - Vector(loc)
    c.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return c


def render(cam, fname):
    SC.camera = cam
    SC.render.filepath = os.path.join(PREV, fname)
    bpy.ops.render.render(write_still=True)
    print("rendered", SC.render.filepath)


def col_node(nt, me):
    n = nt.nodes.new("ShaderNodeVertexColor")
    n.layer_name = me.color_attributes[0].name if me.color_attributes else ""
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(n.outputs["Color"], sep.inputs[0])
    return sep


def mix(nt, a, b, fac):
    m = nt.nodes.new("ShaderNodeMix")
    m.data_type = "RGBA"
    for s, v in ((6, a), (7, b)):
        if isinstance(v, tuple):
            m.inputs[s].default_value = (*v, 1)
        else:
            nt.links.new(v, m.inputs[s])
    if isinstance(fac, float):
        m.inputs[0].default_value = fac
    else:
        nt.links.new(fac, m.inputs[0])
    return m.outputs[2]


def math_node(nt, op, a, b):
    m = nt.nodes.new("ShaderNodeMath")
    m.operation = op
    for i, v in enumerate((a, b)):
        if isinstance(v, float):
            m.inputs[i].default_value = v
        else:
            nt.links.new(v, m.inputs[i])
    return m.outputs[0]


def preview_material(o, kind):
    """Replace each imported material with a vertex-colour visualisation of the same name family."""
    me = o.data
    for i, src in enumerate(me.materials):
        if src is None:
            continue
        name = src.name.split(".")[0]
        m = bpy.data.materials.new(f"prev_{name}_{o.name}")
        m.use_nodes = True
        nt = m.node_tree
        bsdf = nt.nodes["Principled BSDF"]
        bsdf.inputs["Roughness"].default_value = 0.95
        sep = col_node(nt, me)
        R, G, B = sep.outputs[0], sep.outputs[1], sep.outputs[2]
        ao = math_node(nt, "MULTIPLY_ADD", R, 0.75)
        nt.links[-1]
        ao_n = ao.node
        ao_n.inputs[2].default_value = 0.25
        if name == "Rock" and kind == "mountains":
            rockc = mix(nt, (0.09, 0.085, 0.08), (0.05, 0.045, 0.045), B)
            snow = mix(nt, rockc, (0.85, 0.88, 0.95), G)
            col = mix(nt, snow, ao, 1.0)
            col.node.blend_type = "MULTIPLY"
        elif name == "Rock":
            # procedural streaky rock tint so preview shows strata like a texture would
            tex = nt.nodes.new("ShaderNodeTexNoise")
            tex.inputs["Scale"].default_value = 0.6
            tc = nt.nodes.new("ShaderNodeTexCoord")
            mp = nt.nodes.new("ShaderNodeMapping")
            mp.inputs["Scale"].default_value = (0.25, 0.25, 3.0)
            nt.links.new(tc.outputs["Object"], mp.inputs[0])
            nt.links.new(mp.outputs[0], tex.inputs["Vector"])
            rockc = mix(nt, (0.12, 0.10, 0.09), (0.25, 0.22, 0.20), tex.outputs["Fac"])
            talus = mix(nt, rockc, (0.2, 0.18, 0.16), B)
            grass = mix(nt, talus, (0.07, 0.13, 0.03), G)
            col = mix(nt, grass, ao, 1.0)
            col.node.blend_type = "MULTIPLY"
        elif name == "Bark":
            col = mix(nt, (0.045, 0.026, 0.022), ao, 1.0)
            col.node.blend_type = "MULTIPLY"
        elif name.startswith("Leaf"):
            base = (0.48, 0.03, 0.05) if "Red" in name else (0.65, 0.17, 0.035)
            col = mix(nt, base, ao, 1.0)
            col.node.blend_type = "MULTIPLY"
        else:
            col = mix(nt, (0.5, 0.5, 0.5), ao, 1.0)
            col.node.blend_type = "MULTIPLY"
        nt.links.new(col, bsdf.inputs["Base Color"])
        me.materials[i] = m


def leaf_cards(o):
    """Preview-only stand-in for the game's foliage.js: scatter small alpha leaf cards over Leaf_* faces."""
    me = o.data
    li = [i for i, m in enumerate(me.materials) if m and "Leaf" in m.name]
    if not li:
        return
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index not in li], context="FACES")
    gme = bpy.data.meshes.new(o.name + "_guide")
    bm.to_mesh(gme)
    bm.free()
    g = bpy.data.objects.new(o.name + "_guide", gme)
    SC.collection.objects.link(g)
    g.matrix_world = o.matrix_world
    leafmat = me.materials[li[0]]
    gme.materials.append(leafmat)
    # leaf card object
    cm = bpy.data.meshes.new("card")
    s = 0.32
    cm.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    card = bpy.data.objects.new("card", cm)
    SC.collection.objects.link(card)
    card.hide_render = True
    cm.materials.append(None)
    # geometry nodes: distribute + instance + realize, capture vertex colour
    ng = bpy.data.node_groups.new("cards", "GeometryNodeTree")
    ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    N = ng.nodes
    gi, go = N.new("NodeGroupInput"), N.new("NodeGroupOutput")
    dist = N.new("GeometryNodeDistributePointsOnFaces")
    dist.inputs["Density"].default_value = 28.0
    inst = N.new("GeometryNodeInstanceOnPoints")
    oi = N.new("GeometryNodeObjectInfo")
    oi.inputs["Object"].default_value = card
    rnd = N.new("FunctionNodeRandomValue")
    rnd.data_type = "FLOAT_VECTOR"
    rnd.inputs["Max"].default_value = (6.3, 6.3, 6.3)
    sc = N.new("FunctionNodeRandomValue")
    fsock(sc, "Min").default_value = 0.7
    fsock(sc, "Max").default_value = 1.3
    off = N.new("GeometryNodeSetPosition")
    nrm = N.new("GeometryNodeInputNormal")
    rv = N.new("FunctionNodeRandomValue")
    fsock(rv, "Min").default_value = -0.35
    fsock(rv, "Max").default_value = 0.08
    vm = N.new("ShaderNodeVectorMath")
    vm.operation = "SCALE"
    real = N.new("GeometryNodeRealizeInstances")
    L = ng.links
    L.new(gi.outputs[0], dist.inputs["Mesh"])
    L.new(dist.outputs["Points"], off.inputs["Geometry"])
    L.new(dist.outputs["Normal"], vm.inputs[0])
    L.new(fout(rv), vm.inputs["Scale"])
    L.new(vm.outputs[0], off.inputs["Offset"])
    L.new(off.outputs[0], inst.inputs["Points"])
    L.new(oi.outputs["Geometry"], inst.inputs["Instance"])
    L.new(rnd.outputs[0], inst.inputs["Rotation"])
    L.new(fout(sc), inst.inputs["Scale"])
    L.new(inst.outputs[0], real.inputs[0])
    L.new(real.outputs[0], go.inputs[0])
    mod = g.modifiers.new("cards", "NODES")
    mod.node_group = ng
    # card material: leaf colour * baked crown AO (Col propagated through distribute/instance/realize), alpha leaf clusters
    cmat = bpy.data.materials.new("cards_" + o.name)
    cm.materials[0] = cmat
    nt = cmat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    base = (0.48, 0.03, 0.05) if "Red" in leafmat.name else (0.65, 0.17, 0.035)
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = me.color_attributes[0].name if me.color_attributes else "Col"
    tint = mix(nt, base, attr.outputs["Color"], 1.0)
    tint.node.blend_type = "MULTIPLY"
    nt.links.new(tint, bsdf.inputs["Base Color"])
    tc = nt.nodes.new("ShaderNodeTexCoord")
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.inputs["Scale"].default_value = 7.0
    nt.links.new(tc.outputs["Object"], vor.inputs["Vector"])
    thr = math_node(nt, "LESS_THAN", vor.outputs["Distance"], 0.33)
    nt.links.new(thr, bsdf.inputs["Alpha"])
    try:
        bsdf.inputs["Transmission Weight"].default_value = 0.1
    except Exception:
        pass
    # guide volume itself: hidden (as in game) - keep only the cards
    gme_mat = bpy.data.materials.new("guide_hidden")
    gme_mat.use_nodes = True
    # replace leaf faces of the original by deleting them
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in li], context="FACES")
    bm.to_mesh(me)
    bm.free()
    g.data.materials[0] = cmat
    for mod_ in [mod]:
        pass
    # the cards inherit material 0 of the realised instances (cmat); vertex colours are not carried -> fine for preview


def fsock(node, name):
    return next(i for i in node.inputs if i.name == name and i.type == "VALUE" and i.enabled)


def fout(node):
    return next(o for o in node.outputs if o.type == "VALUE" and o.enabled)


def human(loc):
    me = bpy.data.meshes.new("Human")
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(0.5, 0.3, 1.8), verts=bm.verts)
    bmesh.ops.translate(bm, vec=(0, 0, 0.9), verts=bm.verts)
    bm.to_mesh(me)
    o = bpy.data.objects.new("Human", me)
    SC.collection.objects.link(o)
    o.location = loc
    m = bpy.data.materials.new("HumanMat")
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.25, 0.8, 1)
    me.materials.append(m)
    return o


def obj(name):
    return SC.objects[name]


setup_render()
meshes = [o for o in SC.objects if o.type == "MESH"]
for o in meshes:
    preview_material(o, KIND)

if KIND == "cliffs":
    ground(2000, 0.0)
    pos = {"Cliff_0": (-70, 60, 0), "Cliff_1": (40, 150, 0), "Cliff_2": (-120, 190, 0), "Cliff_3": (150, 30, 0)}
    for k, v in pos.items():
        obj(k).location = v
    rocks = [f"Rock_{i}" for i in range(6)]
    rp = [(-11, -60), (-8, -57), (-4, -59), (1, -55), (7, -57), (14, -54)]
    for i, r in enumerate(rocks):
        obj(r).location = (*rp[i], 0)
        obj(r).rotation_euler = (0, 0, i * 1.3)
    human((-6, -62, 0))
    render(camera("C1", (-40, -260, 70), (20, 90, 25), 32), "cliffs_overview.png")
    render(camera("C2", (-28, -95, 9), (-30, 60, 28), 28), "cliffs_close.png")
    render(camera("C3", (1, -79, 5.0), (1, -56, 1.2), 30), "cliffs_rocks.png")
    render(camera("C4", (260, -60, 50), (100, 90, 30), 40), "cliffs_side.png")
    bpy.context.view_layer.update()
    for e in [o for o in SC.objects if "_Fall" in o.name]:
        for o in meshes:
            o.hide_render = o.name.startswith("Cliff") and o != e.parent
        m = e.matrix_world
        p = m.translation.copy()
        out = (m.to_3x3() @ Vector((1, 0, 0))).normalized()
        side = Vector((-out.y, out.x, 0))
        render(camera("F_" + e.name, p + out * 120 + side * 45 + Vector((0, 0, 8)), p - Vector((0, 0, 14)), 35), f"cliffs_fall_{e.name}.png")

elif KIND == "trees":
    ground(400, 0.0)
    xs = {"MapleTree_0": (-16, 0, 0), "MapleTree_1": (0, 6, 0), "MapleTree_2": (16, 0, 0), "MapleBranch_Overhang": (-63.5, -33, 8.0)}
    for k, v in xs.items():
        if k in SC.objects:
            obj(k).location = v
    human((-6, -8, 0))
    bpy.context.view_layer.update()
    for o in meshes:
        leaf_cards(o)
    render(camera("T1", (0, -55, 9), (0, 0, 6.5), 32), "trees_overview.png")
    render(camera("T2", (-30, -16, 3), (-16, 0, 5.5), 30), "trees_close.png")
    # overhang branch hanging into top-left like the reference foreground
    ob = obj("MapleBranch_Overhang")
    ob.rotation_euler = (0, 0, math.radians(62))
    bpy.context.view_layer.update()
    for g in [x for x in SC.objects if x.name.startswith("MapleBranch_Overhang_guide")]:
        g.matrix_world = ob.matrix_world
    render(camera("T3", (-56.5, -42.5, 4.0), (-61, -22, 7.0), 24), "trees_overhang.png")
    # crown guide volumes as exported (no cards): hide cards objects
    for o in SC.objects:
        if o.name.endswith("_guide"):
            o.hide_render = True
    render(camera("T4", (0, -55, 9), (0, 0, 6.5), 32), "trees_trunks.png")

elif KIND == "mountains":
    SC.render.resolution_x, SC.render.resolution_y = 1920, 820
    ground(40000, -5.0, (0.16, 0.2, 0.12))
    obj("Mountain_Main").location = (0, 2500, 0)
    obj("Mountain_Range_L").location = (-2600, 3400, 0)
    obj("Mountain_Range_R").location = (2500, 3200, 0)
    # haze
    SC.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.4
    render(camera("M1", (200, -6500, 260), (0, 2500, 700), 42, 60000), "mountains_overview.png")
    render(camera("M2", (-1800, -1500, 900), (0, 2500, 800), 50, 60000), "mountains_close.png")
    render(camera("M3", (3500, 6500, 2500), (0, 2500, 600), 35, 60000), "mountains_back.png")
