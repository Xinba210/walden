"""Re-import exported GLBs in a fresh Blender session and report what the game will get.

  blender -b --factory-startup --python scripts/world2/stone_verify.py -- a.glb [b.glb ...]

Prints per mesh object: triangles, UV layers, colour attributes, materials, bbox (Blender Z-up after import),
min z (should be 0), XY centre of the base, and the UV texel density (metres per UV unit, target 2.0).
"""
import bpy, sys, math
import numpy as np
from mathutils import Vector

files = sys.argv[sys.argv.index("--") + 1:]
for path in files:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    print(f"\n=== {path}")
    tot = 0
    for o in sorted(bpy.context.scene.objects, key=lambda o: o.name):
        if o.type != "MESH":
            continue
        me = o.data
        me.calc_loop_triangles()
        nt = len(me.loop_triangles)
        tot += nt
        cs = [o.matrix_world @ Vector(c) for c in o.bound_box]
        lo = Vector(map(min, zip(*cs)))
        hi = Vector(map(max, zip(*cs)))
        # uv density
        dens = float("nan")
        if me.uv_layers:
            tl = np.empty(nt * 3, np.int64)
            me.loop_triangles.foreach_get("loops", tl)
            tv = np.empty(nt * 3, np.int64)
            me.loop_triangles.foreach_get("vertices", tv)
            co = np.empty(len(me.vertices) * 3)
            me.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)[tv].reshape(-1, 3, 3)
            uv = np.empty(len(me.loops) * 2)
            me.uv_layers[0].data.foreach_get("uv", uv)
            uv = uv.reshape(-1, 2)[tl].reshape(-1, 3, 2)
            A = 0.5 * np.linalg.norm(np.cross(co[:, 1] - co[:, 0], co[:, 2] - co[:, 0]), axis=1).sum()
            e1, e2 = uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0]
            U = 0.5 * np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]).sum()
            dens = 1 / math.sqrt(U / A)
        cols = [(c.name, c.domain, c.data_type) for c in me.color_attributes]
        cstat = ""
        if me.color_attributes:
            c = me.color_attributes[0]
            arr = np.empty(len(c.data) * 4, np.float32)
            c.data.foreach_get("color", arr)
            arr = arr.reshape(-1, 4)
            cstat = " RGBA mean=(" + ",".join(f"{v:.2f}" for v in arr.mean(0)) + ")"
        print(f"  {o.name:14s} tris={nt:7d} uv={[u.name for u in me.uv_layers]} col={cols}{cstat}")
        print(f"  {'':14s} mats={[m.name for m in me.materials]} bbox=({hi.x - lo.x:.2f} x {hi.y - lo.y:.2f} x "
              f"{hi.z - lo.z:.2f}) minz={lo.z:.3f} base_ctr=({(lo.x + hi.x) / 2:.2f},{(lo.y + hi.y) / 2:.2f}) "
              f"origin={tuple(round(v, 2) for v in o.location)} m/UV={dens:.2f}")
    print(f"  TOTAL tris={tot}")
