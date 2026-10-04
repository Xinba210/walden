"""Preview renders of an exported GLB (re-imported fresh) with Cycles.

  blender -b --factory-startup --python scripts/world2/stone_previews.py -- <in.glb> <out_prefix> [lineup|single] [res]

lineup: objects grouped into rows by name prefix, a 1.8 m scale box at the left of each row; renders an overview plus a
close-up per row. single: every object rendered alone from 3 angles. The preview material visualises the baked `Col`
masks (R = AO darkening, G = moss tint, B = edge-wear lightening) on top of the flat Stone grey.
"""
import bpy, math, sys, os
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
GLB, PREFIX = argv[0], argv[1]
MODE = argv[2] if len(argv) > 2 else "lineup"
RES = int(argv[3]) if len(argv) > 3 else 1400
ONLY = argv[4].split(",") if len(argv) > 4 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=GLB)
objs = [o for o in sc.objects if o.type == "MESH"]
if ONLY:
    keep = [o for o in objs if any(o.name.startswith(p) for p in ONLY)]
    for o in objs:
        if o not in keep:
            bpy.data.objects.remove(o)
    objs = keep
for o in objs:
    o.parent = None


def srgb(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


# ---------------------------------------------------------------- preview material driven by the Col masks
def preview_mat(colname):
    m = bpy.data.materials.new("Preview")
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    bsdf = N["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.9
    ca = N.new("ShaderNodeVertexColor")
    ca.layer_name = colname
    sep = N.new("ShaderNodeSeparateColor")
    L.new(ca.outputs["Color"], sep.inputs["Color"])
    # stone grey with a little large-scale colour variation
    tc = N.new("ShaderNodeTexNoise")
    tc.inputs["Scale"].default_value = 0.6
    ramp = N.new("ShaderNodeMix")
    ramp.data_type = "RGBA"
    ramp.inputs["A"].default_value = (*srgb("#8a8680"), 1)
    ramp.inputs["B"].default_value = (*srgb("#7c7a74"), 1)
    L.new(tc.outputs["Fac"], ramp.inputs["Factor"])
    # AO: mix(0.3, 1, R)
    aom = N.new("ShaderNodeMapRange")
    aom.inputs["To Min"].default_value = 0.3
    L.new(sep.outputs["Red"], aom.inputs["Value"])
    mul = N.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    L.new(ramp.outputs["Result"], mul.inputs["A"])
    L.new(aom.outputs["Result"], mul.inputs["B"])
    # wear lightening
    wear = N.new("ShaderNodeMix")
    wear.data_type = "RGBA"
    wear.blend_type = "SCREEN"
    wm = N.new("ShaderNodeMath")
    wm.operation = "MULTIPLY"
    wm.inputs[1].default_value = 0.35
    L.new(sep.outputs["Blue"], wm.inputs[0])
    L.new(wm.outputs[0], wear.inputs["Factor"])
    L.new(mul.outputs["Result"], wear.inputs["A"])
    wear.inputs["B"].default_value = (0.6, 0.58, 0.55, 1)
    # moss
    moss = N.new("ShaderNodeMix")
    moss.data_type = "RGBA"
    mm = N.new("ShaderNodeMath")
    mm.operation = "MULTIPLY"
    mm.inputs[1].default_value = 0.85
    L.new(sep.outputs["Green"], mm.inputs[0])
    L.new(mm.outputs[0], moss.inputs["Factor"])
    L.new(wear.outputs["Result"], moss.inputs["A"])
    mc = N.new("ShaderNodeMix")
    mc.data_type = "RGBA"
    mc.blend_type = "MULTIPLY"
    mc.inputs["Factor"].default_value = 1.0
    mc.inputs["A"].default_value = (*srgb("#4d6a2a"), 1)
    L.new(aom.outputs["Result"], mc.inputs["B"])
    L.new(mc.outputs["Result"], moss.inputs["B"])
    L.new(moss.outputs["Result"], bsdf.inputs["Base Color"])
    return m


colname = None
for o in objs:
    if o.data.color_attributes:
        colname = o.data.color_attributes[0].name
        break
PM = preview_mat(colname or "Col")
for o in objs:
    o.data.materials.clear()
    o.data.materials.append(PM)


def bbox(o):
    cs = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return Vector(map(min, zip(*cs))), Vector(map(max, zip(*cs)))


# ---------------------------------------------------------------- layout
rows = {}
order = ["Gate", "Pillar", "Slab", "Block", "PathStone"]
for o in sorted(objs, key=lambda o: o.name):
    key = o.name.split("_")[0]
    rows.setdefault(key, []).append(o)
keys = sorted(rows, key=lambda k: order.index(k) if k in order else 99)

human_mat = bpy.data.materials.new("Human")
human_mat.use_nodes = True
human_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.12, 0.08, 1)


def human(x, y):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, 0.9))
    h = bpy.context.object
    h.scale = (0.45, 0.28, 1.8)
    h.data.materials.append(human_mat)
    return h


row_boxes = []
row_members = {}
if MODE == "lineup":
    y = 0.0
    for k in keys:
        x = 0.0
        hmn = human(-1.2, y)
        depth = 0
        lo_all = Vector((1e9, 1e9, 1e9))
        hi_all = -lo_all
        for o in rows[k]:
            lo, hi = bbox(o)
            w = hi.x - lo.x
            o.location.x += x - lo.x
            o.location.y += y - (lo.y + hi.y) / 2
            depth = max(depth, hi.y - lo.y)
            x += w + 0.9
            bpy.context.view_layer.update()
            lo2, hi2 = bbox(o)
            lo_all = Vector(map(min, lo_all, lo2))
            hi_all = Vector(map(max, hi_all, hi2))
        lo_all.x = -1.6
        row_boxes.append((k, lo_all, hi_all))
        row_members[k] = rows[k] + [hmn]
        y += depth + 2.5
else:
    x = 0.0
    for o in objs:
        lo, hi = bbox(o)
        o.location.x += x - lo.x
        o.location.y -= (lo.y + hi.y) / 2
        bpy.context.view_layer.update()
        lo2, hi2 = bbox(o)
        row_boxes.append((o.name, lo2, hi2))
        x += (hi.x - lo.x) + 30

# ground
bpy.ops.mesh.primitive_plane_add(size=4000, location=(0, 0, 0))
g = bpy.context.object
gm = bpy.data.materials.new("Ground")
gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.26, 0.26, 0.25, 1)
gm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 1.0
g.data.materials.append(gm)

# light
bpy.ops.object.light_add(type="SUN")
sun = bpy.context.object
sun.data.energy = 4.5
sun.data.angle = math.radians(4)
sun.rotation_euler = (math.radians(50), math.radians(8), math.radians(-35))
w = bpy.data.worlds.new("W")
sc.world = w
w.use_nodes = True
w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.62, 0.75, 1)
w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35

# render settings
sc.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
try:
    prefs.compute_device_type = "OPTIX"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == "OPTIX"
    sc.cycles.device = "GPU"
except Exception:
    sc.cycles.device = "CPU"
sc.cycles.samples = 48
sc.cycles.use_denoising = True
sc.view_settings.view_transform = "AgX"
sc.view_settings.look = "AgX - Medium High Contrast"
sc.render.resolution_x = RES
sc.render.resolution_y = int(RES * 0.5625)

cam_data = bpy.data.cameras.new("Cam")
cam = bpy.data.objects.new("Cam", cam_data)
sc.collection.objects.link(cam)
sc.camera = cam


def shoot(lo, hi, yaw, pitch, path, lens=40, pad=1.08):
    c = (lo + hi) / 2
    cam_data.lens = lens
    tx = 18 / lens
    ty = tx * 0.5625
    d = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    fwd = -d
    right = fwd.cross(Vector((0, 0, 1))).normalized()
    up = right.cross(fwd)
    dist = 0.0
    for x in (lo.x, hi.x):
        for y in (lo.y, hi.y):
            for z in (lo.z, hi.z):
                q = Vector((x, y, z)) - c
                zc = q.dot(fwd)
                dist = max(dist, abs(q.dot(right)) * pad / tx - zc, abs(q.dot(up)) * pad / ty - zc)
    cam.location = c + d * dist
    cam.rotation_euler = fwd.to_track_quat("-Z", "Y").to_euler()
    cam_data.clip_end = dist * 10 + 100
    sun.rotation_euler = (math.radians(48), 0, yaw + math.radians(-40))
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("RENDERED", path)


if MODE == "lineup":
    lo_all = Vector(map(min, *[b[1] for b in row_boxes]))
    hi_all = Vector(map(max, *[b[2] for b in row_boxes]))
    shoot(lo_all, hi_all, math.radians(205), math.radians(32), f"{PREFIX}_overview.png", lens=35, pad=0.95)
    allobj = [o for o in sc.objects if o.type == "MESH" and o.name != g.name]
    for k, lo, hi in ([] if os.environ.get("OVERVIEW_ONLY") else row_boxes):
        for o in allobj:
            o.hide_render = o not in row_members[k]
        shoot(lo, hi, math.radians(-22), math.radians(16), f"{PREFIX}_{k.lower()}_front.png", lens=45, pad=0.95)
        shoot(lo, hi, math.radians(200), math.radians(26), f"{PREFIX}_{k.lower()}_back.png", lens=45, pad=0.95)
        for o in allobj:
            o.hide_render = False
elif os.environ.get("CLOSE"):
    # CLOSE="fx0,fy0,fz0,fx1,fy1,fz1" fractions of the first object's bbox; YAW/PITCH degrees
    f = [float(v) for v in os.environ["CLOSE"].split(",")]
    name, lo, hi = row_boxes[0]
    d = hi - lo
    a = lo + Vector((d.x * f[0], d.y * f[1], d.z * f[2]))
    b = lo + Vector((d.x * f[3], d.y * f[4], d.z * f[5]))
    shoot(a, b, math.radians(float(os.environ.get("YAW", -30))), math.radians(float(os.environ.get("PITCH", 15))),
          f"{PREFIX}_{name.lower()}_close.png", lens=50, pad=1.0)
else:
    for name, lo, hi in row_boxes:
        for tag, yaw, pitch in (("a", -35, 14), ("b", 145, 22), ("c", 60, 40)):
            shoot(lo, hi, math.radians(yaw), math.radians(pitch), f"{PREFIX}_{name.lower()}_{tag}.png", lens=40,
                  pad=1.0)
