# Hooded-assassin (Tripo Smart Mesh, rigged FBX) prep: keep its skin weights, real-world scale, feet on the floor.
#   blender -b --factory-startup --python scripts/ha_prep.py -- <model.fbx> <out.blend> [height]
import bpy, sys
from mathutils import Matrix
argv = sys.argv[sys.argv.index("--") + 1:]
H = float(argv[2]) if len(argv) > 2 else 1.68
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=argv[0])
A = next(o for o in bpy.data.objects if o.type == "ARMATURE")
M = next(o for o in bpy.data.objects if o.type == "MESH")
A.name, M.name = "Armature", "Ninja"
for pb in A.pose.bones:
    pb.matrix_basis.identity()
zs = [(M.matrix_world @ v.co).z for v in M.data.vertices]
s = H / (max(zs) - min(zs))
A.scale = [x * s for x in A.scale]
A.location.z -= min(zs) * s
bpy.ops.object.select_all(action="DESELECT")
for o in (A, M):
    o.select_set(True)
bpy.context.view_layer.objects.active = A
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for m in M.data.materials:
    b = m.node_tree.nodes.get("Principled BSDF") if m.node_tree else None
    if b:
        b.inputs["Roughness"].default_value = 0.9
bpy.ops.wm.save_as_mainfile(filepath=argv[1])
zs = [(M.matrix_world @ v.co).z for v in M.data.vertices]
print("scale %.3f height %.3f verts %d groups %d" % (s, max(zs) - min(zs), len(M.data.vertices), len(M.vertex_groups)))
