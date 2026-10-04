"""Low-detail copies of the world2 asset kits for distance LOD.

  blender -b --factory-startup --python scripts/world2/lod_build.py -- <kit.glb> [<kit.glb> ...]

For every top-level mesh object in each kit writes `<Name>_LOD` (collapse-decimated to a triangle target that depends on
the asset type; UVs, normals and the RGBA colour attribute survive the decimation) into `<kit>_lod.glb` next to it.
Tree canopies (Leaf_* materials) are left untouched - they are guide volumes for the runtime leaf cards.
"""
import bpy, sys, os

TARGET = [            # (name prefix, target triangles) - small repeated props and trees only; one-off structures
    #                     (cliffs, castle, aqueduct, colonnades, mountains) stay full detail: collapse-decimating
    #                     their displaced, multi-shell meshes shatters them into shards
    ("PathStone", 300), ("Block", 900), ("Slab", 1100), ("Pillar", 1400), ("Rock", 2000), ("Gate", 5000),
    ("MapleTree", 4500), ("MapleBranch", 3500),
]

argv = sys.argv[sys.argv.index("--") + 1:]
for path in argv:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    tops = [o for o in bpy.data.objects if o.parent is None]
    keep = []
    for o in tops:
        if o.type != "MESH":
            continue
        target = next((t for p, t in TARGET if o.name.startswith(p)), None)
        if target is None:
            continue
        me = o.data
        tris = sum(len(p.vertices) - 2 for p in me.polygons)
        # canopies are not decimated: only count / decimate the non-leaf faces
        leaf_slots = {i for i, m in enumerate(me.materials) if m and m.name.startswith("Leaf")}
        solid = sum(len(p.vertices) - 2 for p in me.polygons if p.material_index not in leaf_slots)
        lod = o.copy()
        lod.data = me.copy()
        lod.name = lod.data.name = o.name + "_LOD"
        bpy.context.scene.collection.objects.link(lod)
        if solid > target:
            ratio = max(0.01, target / solid)
            if leaf_slots:
                # decimate only the bark: vertex group of non-leaf vertices
                vg = lod.vertex_groups.new(name="_solid")
                ids = {v for p in lod.data.polygons if p.material_index not in leaf_slots for v in p.vertices}
                vg.add(list(ids), 1.0, "REPLACE")
                mod = lod.modifiers.new("dec", "DECIMATE")
                mod.ratio = ratio
                mod.vertex_group = "_solid"
                mod.use_collapse_triangulate = True
            else:
                mod = lod.modifiers.new("dec", "DECIMATE")
                mod.ratio = ratio
                mod.use_collapse_triangulate = True
            bpy.context.view_layer.objects.active = lod
            bpy.ops.object.modifier_apply(modifier=mod.name)
            for g in list(lod.vertex_groups):
                lod.vertex_groups.remove(g)
        keep.append(lod)
        print("LOD %-24s %7d -> %6d tris" % (o.name, tris, sum(len(p.vertices) - 2 for p in lod.data.polygons)))
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    out = os.path.splitext(path)[0] + "_lod.glb"
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=True,
                              export_texcoords=True, export_normals=True, export_vertex_color="ACTIVE",
                              export_materials="EXPORT", export_animations=False)
    print("WROTE", out, os.path.getsize(out) // 1024, "KB")
