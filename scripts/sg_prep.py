"""Segmented model (model-tri-segment.glb: 81 separate Tripo parts, unrigged) + the hooded-assassin rig.

  blender -b --factory-startup --python scripts/sg_prep.py -- <segmented.glb> <rigged_prep.blend> <out.blend>

Same sculpt as the hooded-assassin export, so its armature and skin weights carry over:
* parts joined into one mesh "Ninja" (int attribute `part` = Tripo part number), scaled to the rig (1 m -> 1.68 m)
* weights transferred surface -> surface from the rigged mesh (nearest face, interpolated), like the reference project
* the result has the same object names as ha_prep.py's output, so ha_rig.py can rig the cloth on it unchanged
"""
import bpy, sys, numpy as np
from mathutils import Matrix

argv = sys.argv[sys.argv.index("--") + 1:]
SEG, RIG, OUT = argv[:3]

bpy.ops.wm.open_mainfile(filepath=RIG)
Arm = bpy.data.objects["Armature"]
src = bpy.data.objects["Ninja"]
src.name = "TripoSkin"
hz = [(src.matrix_world @ v.co).z for v in src.data.vertices]
H = max(hz) - min(hz)

before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=SEG)
new = [o for o in bpy.data.objects if o not in before]
parts = [o for o in new if o.type == "MESH"]
for o in new:
    if o.type != "MESH":
        bpy.data.objects.remove(o, do_unlink=True)
import bmesh
for o in parts:
    pid = int(o.name.split("_")[-1].split(".")[0])
    me = o.data
    # glTF splits vertices along UV seams: weld them back within the part (UVs live on the loops and are kept)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bm.to_mesh(me)
    bm.free()
    a = me.attributes.new("part", "INT", "POINT")
    a.data.foreach_set("value", [pid] * len(me.vertices))
    o.parent = None
    me.transform(o.matrix_world)
    o.matrix_world = Matrix()
# scale to the rig: same sculpt, 1 m tall -> rig height, feet on the floor
zs = np.concatenate([[v.co.z for v in o.data.vertices] for o in parts])
s = H / (zs.max() - zs.min())
for o in parts:
    o.data.transform(Matrix.Translation((0, 0, -zs.min() * s)) @ Matrix.Scale(s, 4))
bpy.ops.object.select_all(action="DESELECT")
for o in parts:
    o.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
M = bpy.context.view_layer.objects.active
M.name = M.data.name = "Ninja"

# alignment check against the rigged mesh
from mathutils.bvhtree import BVHTree
sm = src.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
sm.transform(src.matrix_world)
bvh = BVHTree.FromPolygons([v.co.copy() for v in sm.vertices], [p.vertices[:] for p in sm.polygons])
d = np.array([bvh.find_nearest(M.matrix_world @ v.co)[3] for v in M.data.vertices])
print("ALIGN to rigged mesh (cm): median %.2f  p95 %.2f  max %.2f" % tuple(np.percentile(d * 100, [50, 95, 100])))

# skin weights: surface -> surface from the rigged mesh
for g in src.vertex_groups:
    M.vertex_groups.new(name=g.name)
dt = M.modifiers.new("WeightTransfer", "DATA_TRANSFER")
dt.object = src
dt.use_object_transform = True
dt.use_vert_data = True
dt.data_types_verts = {"VGROUP_WEIGHTS"}
dt.vert_mapping = "POLYINTERP_NEAREST"
dt.layers_vgroup_select_src = "ALL"
dt.layers_vgroup_select_dst = "NAME"
bpy.context.view_layer.objects.active = M
bpy.ops.object.modifier_apply(modifier=dt.name)
bpy.data.objects.remove(src, do_unlink=True)
M.parent = Arm
M.matrix_parent_inverse = Arm.matrix_world.inverted()
mod = M.modifiers.new("Armature", "ARMATURE")
mod.object = Arm
for m in M.data.materials:
    b = m.node_tree.nodes.get("Principled BSDF") if m and m.node_tree else None
    if b:
        b.inputs["Roughness"].default_value = 0.9
for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for x in [x for x in block if x.users == 0]:
        block.remove(x)
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print("SG verts %d parts %d groups %d scale %.3f" % (len(M.data.vertices), len(parts), len(M.vertex_groups), s))
