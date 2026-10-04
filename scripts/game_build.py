"""Build the three.js game asset from the rigged ninja (parts pipeline output).

  blender -b --factory-startup --python scripts/game_build.py -- <rig.blend> <out.glb> <meta.json>

* retargets clips onto the Mixamo-convention rig with per-bone rest alignment (anatomical frames), so sources with a
  different rest pose (UAL: UE skeleton, T-pose; RPM: Mixamo, T-pose) land correctly on our A-pose rig
    - female mocap locomotion from the Ready Player Me library (idle / walk / jog / run)
    - ninja jump, roll, sword idle, slash combo, dash slash and the summon spell from Quaternius UAL (CC0)
* locomotion is made in-place (linear travel removed, sway/bob kept) and its ground speed measured
* per-frame foot grounding, root motion for attacks (UAL RM library)
* old project's katana, re-seated in the right fist (axis through the curled fingers, edge forward)
* attack timing measured from the sword tip: wind-up / strike window / peak / follow-through
* `_end` leaf bones + spring-bone cloth config for the coat and scarf chains
"""
import json, math, os, sys
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
RIG, OUT_GLB, OUT_META = argv[:3]
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
UAL = "/home/shikhar/Projects/3d-anim/samurai/assets_src/ual/"
OLD_GLB = "/home/shikhar/Projects/3d-anim/samurai/game/public/models/samurai.glb"
ANIMS = ROOT + "/anims/"
FPS = 30
P = "mixamorig:"

# (kind, file, clip, output name, mirror, in_place_loco)
CLIPS = [
    ("rpm", ANIMS + "F_Standing_Idle_001.fbx", None, "Idle", False, True),
    ("rpm", ANIMS + "F_Walk_002.fbx", None, "Walk", False, True),
    ("rpm", ANIMS + "F_Jog_001.fbx", None, "Run", False, True),
    ("rpm", ANIMS + "F_Run_001.fbx", None, "Sprint", False, True),
    ("ual", UAL + "UAL2_Standard.glb", "NinjaJump_Start", "JumpStart", False, False),
    ("ual", UAL + "UAL2_Standard.glb", "NinjaJump_Idle_Loop", "JumpLoop", False, False),
    ("ual", UAL + "UAL2_Standard.glb", "NinjaJump_Land", "JumpLand", False, False),
    ("ual", UAL + "UAL1_Standard.glb", "Roll", "Roll", False, False),
    ("ual", UAL + "UAL1_Standard.glb", "Sword_Idle", "SwordIdle", False, False),
    ("ual", UAL + "UAL1_Standard.glb", "Spell_Simple_Enter", "_SummonEnter", True, False),
    ("ual", UAL + "UAL1_Standard.glb", "Spell_Simple_Idle_Loop", "_SummonHold", True, False),
    ("ual", UAL + "UAL2_Standard.glb", "Sword_Regular_A", "SlashA", False, False),
    ("ual", UAL + "UAL2_Standard.glb", "Sword_Regular_A_Rec", "SlashA_Rec", False, False),
    ("ual", UAL + "UAL2_Standard.glb", "Sword_Regular_B", "SlashB", False, False),
    ("ual", UAL + "UAL2_Standard.glb", "Sword_Regular_B_Rec", "SlashB_Rec", False, False),
    ("ual", UAL + "UAL2_Standard.glb", "Sword_Regular_C", "SlashC", False, False),
    ("ual", UAL + "UAL2_Standard.glb", "Sword_Dash", "SwordDash", False, False),
    ("ual", UAL + "UAL1_Standard.glb", "Hit_Chest", "HitReact", False, False),
    ("ual", UAL + "UAL2_Standard.glb", "Hit_Knockback", "Knockback", False, False),
    ("ual", UAL + "UAL1_Standard.glb", "Death01", "Death", False, False),
]
# --monster: an enemy built from the same Mixamo-convention rig pipeline (no katana / cloth / summon / root motion)
MONSTER = "--monster" in sys.argv
MONSTER_CLIPS = [
    ("ual", UAL + "UAL2_Standard.glb", "Zombie_Idle_Loop", "Idle", False, True),
    ("ual", UAL + "UAL2_Standard.glb", "Zombie_Walk_Fwd_Loop", "Walk", False, True),
    ("ual", UAL + "UAL2_Standard.glb", "Zombie_Scratch", "AttackClaw", False, False),
    ("ual", UAL + "UAL2_Standard.glb", "Melee_Hook", "AttackHook", False, False),
    ("ual", UAL + "UAL1_Standard.glb", "Hit_Chest", "HitReact", False, False),
    ("ual", UAL + "UAL1_Standard.glb", "Death01", "Death", False, False),
]
if MONSTER:
    CLIPS = MONSTER_CLIPS
LOCOMOTION = ("Walk", "Run", "Sprint")
ATTACK_CLIPS = ("SlashA", "SlashB", "SlashC", "SwordDash")
MIRROR = Matrix(((-1, 0, 0), (0, 1, 0), (0, 0, 1)))
SIDES = {"l": "Left", "r": "Right"}
FING = ("Thumb", "Index", "Middle", "Ring", "Pinky")
FEET = [f"{P}{s}{b}" for s in ("Left", "Right") for b in ("Foot", "ToeBase", "Toe_End")]
RIGHT_FINGERS = [f"{P}RightHand{f}{i}" for f in FING for i in (1, 2, 3)]
FWD, UP = Vector((0, -1, 0)), Vector((0, 0, 1))


# ------------------------------------------------------------------ skeleton maps
def target_primary_child():
    c = {"Hips": "Spine", "Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Neck", "Neck": "Head", "Head": "HeadTop_End"}
    for side in SIDES.values():
        c.update({f"{side}Shoulder": f"{side}Arm", f"{side}Arm": f"{side}ForeArm", f"{side}ForeArm": f"{side}Hand",
                  f"{side}Hand": f"{side}HandMiddle1", f"{side}UpLeg": f"{side}Leg", f"{side}Leg": f"{side}Foot",
                  f"{side}Foot": f"{side}ToeBase", f"{side}ToeBase": f"{side}Toe_End"})
        for f in FING:
            for i in (1, 2, 3):
                c[f"{side}Hand{f}{i}"] = f"{side}Hand{f}{i + 1}"
    return c


TPC = target_primary_child()


class SrcKind:
    """Bone naming of a source skeleton: map[source] = target short name, primary child, feet, finger heads."""

    def __init__(self, kind):
        self.kind = kind
        if kind == "ual":
            m = {"pelvis": "Hips", "spine_01": "Spine", "spine_02": "Spine1", "spine_03": "Spine2", "neck_01": "Neck", "Head": "Head"}
            ch = {"pelvis": "spine_01", "spine_01": "spine_02", "spine_02": "spine_03", "spine_03": "neck_01", "neck_01": "Head"}
            fmap = {"thumb": "Thumb", "index": "Index", "middle": "Middle", "ring": "Ring", "pinky": "Pinky"}
            for s, side in SIDES.items():
                m.update({f"clavicle_{s}": f"{side}Shoulder", f"upperarm_{s}": f"{side}Arm", f"lowerarm_{s}": f"{side}ForeArm",
                          f"hand_{s}": f"{side}Hand", f"thigh_{s}": f"{side}UpLeg", f"calf_{s}": f"{side}Leg",
                          f"foot_{s}": f"{side}Foot", f"ball_{s}": f"{side}ToeBase"})
                ch.update({f"clavicle_{s}": f"upperarm_{s}", f"upperarm_{s}": f"lowerarm_{s}", f"lowerarm_{s}": f"hand_{s}",
                           f"hand_{s}": f"middle_01_{s}", f"thigh_{s}": f"calf_{s}", f"calf_{s}": f"foot_{s}",
                           f"foot_{s}": f"ball_{s}", f"ball_{s}": f"ball_leaf_{s}"})
                for f, F in fmap.items():
                    for i in (1, 2, 3):
                        m[f"{f}_0{i}_{s}"] = f"{side}Hand{F}{i}"
                        ch[f"{f}_0{i}_{s}"] = f"{f}_0{i + 1}_{s}" if i < 3 else f"{f}_04_leaf_{s}"
            self.feet = [f"{b}_{s}" for s in ("l", "r") for b in ("foot", "ball", "ball_leaf")]
            self.hips, self.legs = "pelvis", ("thigh_l", "calf_l", "foot_l")
            self.finger_head = lambda side, k: {"index1": f"index_01_{side[0].lower()}", "pinky1": f"pinky_01_{side[0].lower()}"}[k]
        else:  # rpm / mixamo without prefix
            m = {k: k for k in TPC}
            m.update({v: v for v in TPC.values() if not v.endswith(("4", "_End"))})
            ch = dict(TPC)
            self.feet = [f"{s}{b}" for s in ("Left", "Right") for b in ("Foot", "ToeBase", "Toe_End")]
            self.hips, self.legs = "Hips", ("LeftUpLeg", "LeftLeg", "LeftFoot")
            self.finger_head = lambda side, k: f"{side}Hand{'Index1' if k == 'index1' else 'Pinky1'}"
        self.map = {s: P + t for s, t in m.items()}
        self.inv = {t: s for s, t in self.map.items()}
        self.child = ch


def frame(primary, secondary):
    x = primary.normalized()
    z = x.cross(secondary).normalized()
    return Matrix((x, z.cross(x), z)).transposed()


def secondary_axis(tname, hand_vec):
    if "Foot" in tname or "ToeBase" in tname:
        return UP
    if "Hand" in tname or "ForeArm" in tname:
        return hand_vec("Left" if "Left" in tname else "Right")
    return FWD


# ------------------------------------------------------------------ retarget
def walk_order(arm):
    order = []

    def rec(b):
        order.append(b)
        for c in b.children:
            rec(c)
    for b in arm.data.bones:
        if b.parent is None:
            rec(b)
    return order


def find_action(new_acts, clip):
    if clip is None:
        return max(new_acts, key=lambda a: a.frame_range[1] - a.frame_range[0])
    for a in new_acts:
        if a.name == clip or a.name.startswith(clip + "_") or a.name.startswith(clip + "."):
            return a
    for a in bpy.data.actions:          # already imported by an earlier group of the same file
        if a.name == clip or a.name.startswith(clip + "."):
            return a
    raise KeyError(f"clip {clip} not found (new: {[x.name for x in new_acts][:12]})")


def retarget_all(tgt, scene):
    tb = tgt.data.bones
    t_rest = {b.name: b.matrix_local.to_3x3() for b in tb}
    t_head = {b.name: b.head_local.copy() for b in tb}
    offs = {b.name: t_rest[b.parent.name].inverted() @ (t_head[b.name] - t_head[b.parent.name]) for b in tb if b.parent}
    order = walk_order(tgt)
    t_hand = lambda side: tb[f"{P}{side}HandIndex1"].head_local - tb[f"{P}{side}HandPinky1"].head_local
    clips = {}
    groups = {}
    for kind, path, clip, name, mirror, loco in CLIPS:
        groups.setdefault((kind, path), []).append((clip, name, mirror, loco))
    for (kind, path), items in groups.items():
        K = SrcKind(kind)
        before, acts_before = set(bpy.data.objects), set(bpy.data.actions)
        if path.endswith(".fbx"):
            bpy.ops.import_scene.fbx(filepath=path)
        else:
            bpy.ops.import_scene.gltf(filepath=path)
        new_objs = [o for o in bpy.data.objects if o not in before]
        src = next(o for o in new_objs if o.type == "ARMATURE")
        new_acts = [a for a in bpy.data.actions if a not in acts_before]
        sb = src.data.bones
        W = src.matrix_world.copy()
        t_mapped = [t for t in K.inv if t in tb]
        s_hand = lambda side: (W @ sb[K.finger_head(side, "index1")].head_local) - (W @ sb[K.finger_head(side, "pinky1")].head_local)
        # anatomical rest frames on both rigs -> per-bone alignment
        t_frames, s_frames, s_rest = {}, {}, {}
        for tn in t_mapped:
            sn = K.inv[tn]
            ch = tb.get(P + TPC.get(tn[len(P):], ""))
            t_frames[tn] = frame((ch.head_local if ch else tb[tn].tail_local) - tb[tn].head_local, secondary_axis(tn, t_hand))
            sch = sb.get(K.child.get(sn, ""))
            sh = W @ sb[sn].head_local
            st = W @ (sch.head_local if sch else sb[sn].tail_local)
            s_frames[tn] = frame(st - sh, secondary_axis(tn, s_hand))
            s_rest[tn] = (W @ sb[sn].matrix_local).to_3x3().normalized()
        align = {tn: s_frames[tn] @ t_frames[tn].inverted() for tn in t_mapped}
        for side in SIDES.values():
            for i in (1, 2, 3):
                if f"{P}{side}HandThumb{i}" in align:
                    align[f"{P}{side}HandThumb{i}"] = align[f"{P}{side}Hand"]
        leg = lambda head, names: (head(names[1]) - head(names[0])).length + (head(names[2]) - head(names[1])).length
        scale = leg(lambda n: t_head[P + n], ("LeftUpLeg", "LeftLeg", "LeftFoot")) / leg(lambda n: W @ sb[n].head_local, K.legs)
        s_hips_rest = W @ sb[K.hips].head_local
        t_hips = t_head[P + "Hips"]
        for clip, name, mirror, loco in items:
            act = find_action(new_acts, clip)
            src.animation_data_create()
            src.animation_data.action = act
            try:
                src.animation_data.action_slot = act.slots[0]
            except Exception:
                pass
            f0, f1 = (int(round(x)) for x in act.frame_range)
            data = {"rot": {n: [] for n in t_mapped}, "loc": [], "pos": {n: [] for n in FEET + [P + "Hips"]},
                    "src_contact": [], "scale": scale, "src_hips": []}
            for f in range(f0, f1 + 1):
                scene.frame_set(f)
                sp = src.pose.bones
                data["src_contact"].append(min((W @ sp[n].head).z - (W @ sb[n].head_local).z for n in K.feet if n in sp))
                s_head = (W @ sp[K.hips].matrix).to_translation()
                if mirror:
                    s_head = MIRROR @ s_head
                data["src_hips"].append(s_head.copy())
                want = t_hips + (s_head - s_hips_rest) * scale
                posed, pos = {}, {}
                for b in order:
                    n = b.name
                    prot = posed[b.parent.name] if b.parent else Matrix.Identity(3)
                    lrest = (t_rest[b.parent.name].inverted() @ t_rest[n]) if b.parent else t_rest[n]
                    pos[n] = pos[b.parent.name] + prot @ offs[n] if b.parent else want
                    if n in align:
                        sn = K.inv[mirror_name(n) if mirror else n]
                        delta = (W @ sp[sn].matrix).to_3x3().normalized() @ s_rest[mirror_name(n) if mirror else n].inverted()
                        if mirror:
                            delta = MIRROR @ delta @ MIRROR
                        w = delta @ align[n] @ t_rest[n]
                        q = (lrest.inverted() @ prot.inverted() @ w).to_quaternion()
                        keys = data["rot"][n]
                        if keys and keys[-1].dot(q) < 0:
                            q.negate()
                        keys.append(q)
                        posed[n] = w
                    else:
                        posed[n] = prot @ lrest
                data["loc"].append(want - t_hips)
                for n in data["pos"]:
                    data["pos"][n].append(pos[n].copy())
            if loco:
                make_in_place(data)
            clips[name] = data
            print(f"RETARGET {kind}:{clip or os.path.basename(path)} -> {name} frames={len(data['loc'])} scale={scale:.3f}")
        for o in new_objs:
            bpy.data.objects.remove(o, do_unlink=True)
        for a in new_acts:
            bpy.data.actions.remove(a)
    return clips, t_head, t_rest


def mirror_name(n):
    return n.replace("Left", "\0").replace("Right", "Left").replace("\0", "Right")


def make_in_place(c):
    """Remove the linear travel (x, y) of a locomotion clip, keep sway/bob; remember ground speed."""
    n = len(c["loc"])
    t = np.arange(n) / FPS
    xy = np.array([[v.x, v.y] for v in c["loc"]])
    A = np.c_[t, np.ones(n)]
    coef = np.linalg.lstsq(A, xy, rcond=None)[0]
    trend = A @ coef
    c["speed"] = float(np.hypot(*coef[0]))
    for f in range(n):
        d = Vector((trend[f, 0] - trend[0, 0], trend[f, 1] - trend[0, 1], 0))
        c["loc"][f] = c["loc"][f] - d
        for k in c["pos"]:
            c["pos"][k][f] = c["pos"][k][f] - d


def nframes(c):
    return len(c["loc"])


def contact(c, t_head):
    return [min(c["pos"][j][f].z - t_head[j].z for j in FEET) for f in range(nframes(c))]


def pose_at(c, f):
    f = max(0, min(nframes(c) - 1, f))
    return {n: q[f] for n, q in c["rot"].items()}, c["loc"][f]


def blend_pose(a, b, t):
    rot = {}
    for n, qa in a[0].items():
        qb = b[0].get(n, qa)
        rot[n] = qa.slerp(qb if qa.dot(qb) >= 0 else -qb, t)
    return rot, a[1].lerp(b[1], t)


def smoothstep(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def new_clip(poses):
    c = {"rot": {n: [] for n in poses[0][0]}, "loc": [], "pos": {}}
    for rot, loc in poses:
        for n, q in rot.items():
            k = c["rot"][n]
            k.append(-q if k and k[-1].dot(q) < 0 else q.copy())
        c["loc"].append(loc.copy())
    return c


def compose_summon(clips):
    """Right hand thrust forward (mirrored spell), fingers curl into the grip, settle into SwordIdle.
    Tighter than the old version: shorter hold, faster curl, so the sword arrives on the beat."""
    enter, hold, idle = clips["_SummonEnter"], clips["_SummonHold"], clips["SwordIdle"]
    grip = pose_at(idle, 0)
    poses = [pose_at(enter, f) for f in range(nframes(enter))]
    hold_n, settle_n = 14, 10
    curl0, curl1 = 0.2, 0.75
    for f in range(hold_n):
        rot, loc = pose_at(hold, f)
        rot = dict(rot)
        s = smoothstep((f / (hold_n - 1) - curl0) / (curl1 - curl0))
        for n in RIGHT_FINGERS:
            if n in rot and n in grip[0]:
                q = grip[0][n]
                rot[n] = rot[n].slerp(q if rot[n].dot(q) >= 0 else -q, s)
        poses.append((rot, loc))
    last = poses[-1]
    for f in range(1, settle_n + 1):
        poses.append(blend_pose(last, grip, smoothstep(f / settle_n)))
    ne = nframes(enter)
    meta = {"handOut": ne / FPS, "curlStart": (ne + curl0 * hold_n) / FPS, "curlEnd": (ne + curl1 * hold_n) / FPS,
            "duration": (len(poses) - 1) / FPS}
    return new_clip(poses), meta


def write_action(name, c, t_rest):
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    slot = action.slots.new(id_type="OBJECT", name="Armature")
    bag = action.layers.new("Layer").strips.new(type="KEYFRAME").channelbag(slot, ensure=True)
    xs = [float(f) for f in range(nframes(c))]

    def put(path, idx, vals, group):
        fc = bag.fcurves.new(path, index=idx)
        fc.group = bag.groups.get(group) or bag.groups.new(group)
        fc.keyframe_points.add(len(vals))
        fc.keyframe_points.foreach_set("co", [v for xy in zip(xs, vals) for v in xy])
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
        fc.update()
    for n, qs in c["rot"].items():
        for i in range(4):
            put(f'pose.bones["{n}"].rotation_quaternion', i, [q[i] for q in qs], n)
    hinv = t_rest[P + "Hips"].inverted()
    locs = [hinv @ v for v in c["loc"]]
    for i in range(3):
        put(f'pose.bones["{P}Hips"].location', i, [v[i] for v in locs], P + "Hips")
    return action


ROOT_MOTION = {"SlashA": "Sword_Regular_A", "SlashA_Rec": "Sword_Regular_A_Rec", "SlashB": "Sword_Regular_B",
               "SlashB_Rec": "Sword_Regular_B_Rec", "SlashC": "Sword_Regular_C", "SwordDash": "Sword_Dash"}


def extract_root_motion(scene, scale):
    before, acts_before = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=UAL + "UAL2_Standard_RM.glb")
    new_objs = [o for o in bpy.data.objects if o not in before]
    src = next(o for o in new_objs if o.type == "ARMATURE")
    new_acts = [a for a in bpy.data.actions if a not in acts_before]
    out = {}
    for name, clip in ROOT_MOTION.items():
        act = find_action(new_acts, clip)
        src.animation_data_create()
        src.animation_data.action = act
        src.animation_data.action_slot = act.slots[0]
        f0, f1 = (int(round(x)) for x in act.frame_range)
        rows = []
        for f in range(f0, f1 + 1):
            scene.frame_set(f)
            m = src.matrix_world @ src.pose.bones["root"].matrix
            fwd = m.to_3x3() @ Vector((0, 1, 0))
            rows.append((-m.translation.y, -m.translation.x, math.atan2(fwd.x, fwd.y)))
        b = rows[0]
        out[name] = [[round((r[0] - b[0]) * scale, 4), round((r[1] - b[1]) * scale, 4), round(r[2] - b[2], 4)] for r in rows]
    for o in new_objs:
        bpy.data.objects.remove(o, do_unlink=True)
    for a in new_acts:
        bpy.data.actions.remove(a)
    return out


# ------------------------------------------------------------------ katana
def import_katana(tgt, scene, length=0.95):
    """Old project's katana: take its mesh, scale to `length`, align it to the right fist of SwordIdle."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=OLD_GLB)
    new = [o for o in bpy.data.objects if o not in before]
    k = next(o for o in new if o.name.startswith("Katana"))
    me = k.data.copy()
    me.transform(k.matrix_world)
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        if a.users == 0 and not a.use_fake_user:
            bpy.data.actions.remove(a)
    kat = bpy.data.objects.new("Katana", me)
    scene.collection.objects.link(kat)
    for g in list(kat.vertex_groups):
        kat.vertex_groups.remove(g)
    for a in [a for a in me.attributes if a.name in ("custom_normal",)]:
        me.attributes.remove(a)
    names = {"part_23": "Katana_Blade", "part_17": "Katana_Handle", "part_6": "Katana_Guard", "part_31": "Katana_Collar"}
    for m in me.materials:
        for k_, v in names.items():
            if m.name.endswith(k_):
                m.name = v
    co = np.array([v.co[:] for v in me.vertices])
    mi = np.array([p.material_index for p in me.polygons])
    vmat = np.zeros(len(co), int)
    for p in me.polygons:
        for v in p.vertices:
            vmat[v] = p.material_index
    handle_idx = [i for i, m in enumerate(me.materials) if m.name == "Katana_Handle"][0]
    c = co.mean(0)
    axis = np.linalg.svd(co - c)[2][0]
    if (co[vmat == handle_idx].mean(0) - c) @ axis > 0:
        axis = -axis  # +axis points hilt -> tip
    t = (co - c) @ axis
    s = length / (t.max() - t.min())
    hc = co[vmat == handle_idx].mean(0)
    # blade flat direction: the thin cross-section axis of the blade
    blade_idx = [i for i, m in enumerate(me.materials) if m.name == "Katana_Blade"][0]
    bl = co[vmat == blade_idx] - c
    bl = bl - np.outer(bl @ axis, axis)
    _, sv, vt = np.linalg.svd(bl)
    edge_dir = vt[0]  # widest direction across the blade = edge-to-spine
    # pose: SwordIdle frame 0
    act = bpy.data.actions["SwordIdle"]
    tgt.animation_data_create()
    tgt.animation_data.action = act
    tgt.animation_data.action_slot = act.slots[0]
    scene.frame_set(0)
    pb = tgt.pose.bones
    ring = lambda f: [pb[f"{P}RightHand{f}{i}"].head for i in (1, 2, 3)] + [pb[f"{P}RightHand{f}4"].head]
    rings = [ring(f) for f in ("Index", "Middle", "Ring", "Pinky")]
    fist = sum((sum(r, Vector()) / 4 for r in rings), Vector()) / 4
    grip_axis = (pb[f"{P}RightHandIndex1"].head - pb[f"{P}RightHandPinky1"].head).normalized()
    hand = pb[f"{P}RightHand"]
    knuckles = (pb[f"{P}RightHandMiddle1"].head - hand.head)
    edge_w = (knuckles - grip_axis * knuckles.dot(grip_axis)).normalized()
    # rotation: katana axis -> grip axis, katana edge -> knuckle direction
    A = Matrix((Vector(axis), Vector(edge_dir), Vector(np.cross(axis, edge_dir)))).transposed()
    B = Matrix((grip_axis, edge_w, grip_axis.cross(edge_w))).transposed()
    R = B @ A.inverted()
    M_pose = Matrix.Translation(fist) @ R.to_4x4() @ Matrix.Diagonal((s, s, s, 1)) @ Matrix.Translation(-Vector(hc))
    to_rest = (hand.bone.matrix_local @ hand.matrix.inverted())
    me.transform(to_rest @ M_pose)
    tgt.animation_data.action = None
    for p_ in tgt.pose.bones:
        p_.matrix_basis.identity()
    scene.frame_set(0)
    kat.parent = tgt
    g = kat.vertex_groups.new(name=P + "RightHand")
    g.add(range(len(me.vertices)), 1.0, "REPLACE")
    mod = kat.modifiers.new("Armature", "ARMATURE")
    mod.object = tgt
    co2 = np.array([v.co[:] for v in me.vertices])
    tl = (co2 - co2.mean(0)) @ np.array(to_rest.to_3x3() @ grip_axis)
    print(f"KATANA length {tl.max() - tl.min():.3f} m, scale {s:.3f}")
    return kat


def analyse_attacks(tgt, scene, kat, clips_meta):
    """Sword-tip speed per frame -> wind-up end, strike window, peak, follow-through end."""
    me = kat.data
    co = np.array([v.co[:] for v in me.vertices])
    c = co.mean(0)
    axis = np.linalg.svd(co - c)[2][0]
    hm = [i for i, m in enumerate(me.materials) if m.name == "Katana_Handle"][0]
    hv = sorted({v for p in me.polygons if p.material_index == hm for v in p.vertices})
    if (co[hv].mean(0) - c) @ axis > 0:
        axis = -axis
    t = (co - c) @ axis
    tip_rest, base_rest = Vector(c + axis * t.max()), Vector(c + axis * (t.min() + (t.max() - t.min()) * 0.3))
    hand = tgt.pose.bones[P + "RightHand"]
    inv = hand.bone.matrix_local.inverted()
    out = {}
    for name in ATTACK_CLIPS + ("SlashA_Rec", "SlashB_Rec"):
        act = bpy.data.actions[name]
        tgt.animation_data.action = act
        tgt.animation_data.action_slot = act.slots[0]
        n = int(round(act.frame_range[1])) + 1
        tips = []
        for f in range(n):
            scene.frame_set(f)
            m = hand.matrix @ inv
            tips.append(np.array((m @ tip_rest)[:]))
        tips = np.array(tips)
        sp = np.r_[0, np.linalg.norm(np.diff(tips, axis=0), axis=1) * FPS]
        sp = np.convolve(sp, [0.25, 0.5, 0.25], mode="same")
        pk = int(np.argmax(sp))
        thr = 0.45 * sp[pk]
        a = pk
        while a > 0 and sp[a - 1] > thr:
            a -= 1
        b = pk
        while b < n - 1 and sp[b + 1] > thr:
            b += 1
        out[name] = {"frames": n, "peak": round(pk / FPS, 4), "strike": [round(a / FPS, 4), round(b / FPS, 4)],
                     "peakSpeed": round(float(sp[pk]), 2), "speed": [round(float(x), 2) for x in sp]}
        print(f"ATTACK {name}: strike {a}-{b} peak {pk} ({sp[pk]:.1f} m/s) of {n} frames")
    tgt.animation_data.action = None
    return out


def analyse_hands(tgt, scene, names):
    """Arm attacks: fastest hand per frame -> strike window (speed > 45 % of peak), peak, and which hand."""
    out = {}
    for name in names:
        act = bpy.data.actions[name]
        tgt.animation_data.action = act
        tgt.animation_data.action_slot = act.slots[0]
        n = int(round(act.frame_range[1])) + 1
        pos = {s: [] for s in ("Left", "Right")}
        for f in range(n):
            scene.frame_set(f)
            for sd in pos:
                pos[sd].append(np.array((tgt.matrix_world @ tgt.pose.bones[P + sd + "Hand"].head)[:]))
        best = None
        for sd, ps in pos.items():
            ps = np.array(ps)
            sp = np.r_[0, np.linalg.norm(np.diff(ps, axis=0), axis=1) * FPS]
            sp = np.convolve(sp, [0.25, 0.5, 0.25], mode="same")
            if best is None or sp.max() > best[1].max():
                best = (sd, sp)
        sd, sp = best
        pk = int(np.argmax(sp)); thr = 0.45 * sp[pk]; a = pk; b = pk
        while a > 0 and sp[a - 1] > thr:
            a -= 1
        while b < n - 1 and sp[b + 1] > thr:
            b += 1
        out[name] = {"frames": n, "hand": sd, "peak": round(pk / FPS, 4), "strike": [round(a / FPS, 4), round(b / FPS, 4)],
                     "peakSpeed": round(float(sp[pk]), 2)}
        print(f"ATTACK {name}: {sd} hand, strike {a}-{b} peak {pk} ({sp[pk]:.1f} m/s) of {n} frames")
    tgt.animation_data.action = None
    return out


def main_monster():
    bpy.ops.wm.open_mainfile(filepath=RIG)
    scene = bpy.context.scene
    scene.render.fps = FPS
    tgt = bpy.data.objects["Armature"]
    body = bpy.data.objects["Ninja"]
    body.name = "Monster"
    for pb in tgt.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.matrix_basis.identity()
    if tgt.animation_data:
        tgt.animation_data.action = None
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    clips, t_head, t_rest = retarget_all(tgt, scene)
    meta = {"fps": FPS, "clips": {}}
    for name, c in clips.items():
        ct = contact(c, t_head)
        dz = [cs * c["scale"] - t for cs, t in zip(c["src_contact"], ct)]
        c["loc"] = [v + Vector((0, 0, d)) for v, d in zip(c["loc"], dz)]
        for nm in c["pos"]:
            c["pos"][nm] = [p + Vector((0, 0, d)) for p, d in zip(c["pos"][nm], dz)]
        meta["clips"][name] = {}
        if "speed" in c:
            meta["clips"][name]["speed"] = round(c["speed"], 4)
    for name, c in clips.items():
        write_action(name, c, t_rest)
        meta["clips"][name]["frames"] = nframes(c)
    meta["attacks"] = analyse_hands(tgt, scene, [n for n in clips if n.startswith("Attack")])
    zs = [(body.matrix_world @ v.co).z for v in body.data.vertices]
    meta["height"] = round(max(zs) - min(zs), 3)
    for img in bpy.data.images:
        if img.size[0] > 2048:
            img.scale(2048, 2048)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures):
        for d in [d for d in block if d.users == 0]:
            block.remove(d)
    tgt.animation_data.action = None
    for pb in tgt.pose.bones:
        pb.matrix_basis.identity()
    bpy.ops.object.select_all(action="DESELECT")
    for o in (tgt, body):
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format="GLB", use_selection=True, export_skins=True,
                              export_animations=True, export_animation_mode="ACTIONS", export_anim_single_armature=True,
                              export_reset_pose_bones=True, export_force_sampling=True, export_optimize_animation_size=True,
                              export_yup=True, export_image_format="JPEG", export_jpeg_quality=88, export_def_bones=False)
    with open(OUT_META, "w") as f:
        json.dump(meta, f, indent=1)
    print("WROTE", OUT_GLB, os.path.getsize(OUT_GLB) // 1024, "KB", list(clips))


# ------------------------------------------------------------------ cloth
def add_end_bones_and_cloth_config(tgt):
    if "cloth_cfg" in tgt:          # rig that ships its own spring-chain setup (ref_prep.py)
        return json.loads(tgt["cloth_cfg"])
    bpy.context.view_layer.objects.active = tgt
    bpy.ops.object.mode_set(mode="EDIT")
    eb = tgt.data.edit_bones
    chains = {}
    for b in eb:
        if b.name.startswith(("Coat_", "Scarf_")):
            k, i = b.name.rsplit("_", 1)
            chains.setdefault(k, []).append((int(i), b.name))
    for k, lst in chains.items():
        last = eb[sorted(lst)[-1][1]]
        e = eb.new(k + "_end")
        e.head = last.tail
        e.tail = last.tail + (last.tail - last.head).normalized() * 0.04
        e.parent = last
        e.use_connect = True
        e.use_deform = False
    bpy.ops.object.mode_set(mode="OBJECT")
    cfg = {"chains": [], "colliders": [], "colliderGroups": {"coat": "legs+hips", "scarf": "spine"}}
    for k, lst in sorted(chains.items()):
        names = [n for _, n in sorted(lst)] + [k + "_end"]
        scarf = k.startswith("Scarf")
        cfg["chains"].append({"name": k, "kind": "scarf" if scarf else "coat", "bones": names,
                              "stiffness": 0.35 if scarf else 0.9, "gravity": 0.9 if scarf else 0.8,
                              "drag": 0.18 if scarf else 0.28, "hitRadius": 0.02})
    for b, t, r in (("Hips", None, 0.15), ("LeftUpLeg", "LeftLeg", 0.125), ("RightUpLeg", "RightLeg", 0.125),
                    ("LeftLeg", "LeftFoot", 0.105), ("RightLeg", "RightFoot", 0.105)):   # sized to the baggy pants
        cfg["colliders"].append({"bone": P + b, "tail": P + t if t else None, "radius": r})
    for b, r in (("Spine", 0.13), ("Spine1", 0.13), ("Spine2", 0.12)):
        cfg["colliders"].append({"bone": P + b, "tail": None, "radius": r})
    return cfg


# ------------------------------------------------------------------ albedo grade
def grade_albedo(img):
    """Tripo's albedo is slate-grey (median saturation ~0.2) with pale painted streaks. Per hue family:
    grey-blue cloth -> rich indigo/navy, highlights compressed; browns (leather, wood) richer; skin kept warm;
    cyan accents boosted; global contrast curve. Works on the sRGB-encoded pixels."""
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    rgb = px[:, :3]
    mx, mn = rgb.max(1), rgb.min(1)
    v = mx
    d = mx - mn
    sat = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    hue = np.zeros_like(v)
    nz = d > 1e-6
    hr = nz & (mx == r); hg = nz & (mx == g) & ~hr; hb = nz & ~hr & ~hg
    hue[hr] = ((g - b)[hr] / d[hr]) % 6
    hue[hg] = (b - r)[hg] / d[hg] + 2
    hue[hb] = (r - g)[hb] / d[hb] + 4
    hue = hue / 6.0                                       # 0..1
    brown = ((hue < 0.12) | (hue > 0.95)) & (sat >= 0.12)
    blueish = (((hue > 0.5) & (hue < 0.78)) | (sat < 0.12)) & ~brown
    skin = brown & (v > 0.45) & (sat > 0.2) & (sat < 0.65)
    cyan = (hue > 0.42) & (hue < 0.56) & (sat > 0.4)
    # cloth: hue toward indigo, saturation up, painted highlights compressed, mids deepened
    cl = blueish & ~cyan
    hue = np.where(cl, 0.64 + (hue - 0.64) * 0.35, hue)
    sat = np.where(cl, np.clip(sat * 2.1 + 0.16, 0, 0.72) * np.clip(1.25 - v * 1.4, 0.45, 1.0), sat)   # highlights less saturated
    v = np.where(cl, np.where(v > 0.26, 0.26 + (v - 0.26) * 0.35, v) * 0.95, v)                          # painted streaks compressed
    lb = brown & ~skin
    sat = np.where(lb, np.clip(sat * 1.45 + 0.05, 0, 0.85), sat)
    v = np.where(lb, v * 1.05, v)
    sat = np.where(skin, np.clip(sat * 1.12, 0, 0.7), sat)
    hue = np.where(skin, hue * 0.9, hue)
    sat = np.where(cyan, np.clip(sat * 1.3, 0, 1), sat)
    v = np.where(cyan, np.clip(v * 1.25, 0, 1), v)
    v = np.clip(v, 0, 1)
    v = v * v * (3 - 2 * v) * 0.35 + v * 0.65               # contrast S-curve
    # HSV -> RGB
    i = np.floor(hue * 6).astype(int) % 6
    f = hue * 6 - np.floor(hue * 6)
    p_ = v * (1 - sat); q = v * (1 - f * sat); t = v * (1 - (1 - f) * sat)
    out = np.stack([np.choose(i, [v, q, p_, p_, t, v]), np.choose(i, [t, v, v, q, p_, p_]), np.choose(i, [p_, p_, t, v, v, q])], 1)
    px[:, :3] = out
    img.pixels.foreach_set(px.ravel())
    img.update()
    print(f"GRADED {img.name}: cloth {cl.mean():.0%} leather {lb.mean():.0%} skin {skin.mean():.0%} cyan {cyan.mean():.1%}")


# ------------------------------------------------------------------ main
def main():
    bpy.ops.wm.open_mainfile(filepath=RIG)
    scene = bpy.context.scene
    scene.render.fps = FPS
    tgt = bpy.data.objects["Armature"]
    body = bpy.data.objects["Ninja"]
    for pb in tgt.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.matrix_basis.identity()
    if tgt.animation_data:
        tgt.animation_data.action = None
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    cloth_cfg = add_end_bones_and_cloth_config(tgt)

    clips, t_head, t_rest = retarget_all(tgt, scene)
    meta = {"fps": FPS, "clips": {}}
    for name, c in clips.items():
        ct = contact(c, t_head)
        dz = [cs * c["scale"] - t for cs, t in zip(c["src_contact"], ct)]
        if name in LOCOMOTION or name == "Idle":     # keep feet planted on the floor on average
            dz = [d - min(ct[f] + d for f, d in enumerate(dz)) for d in dz] if False else dz
        c["loc"] = [v + Vector((0, 0, d)) for v, d in zip(c["loc"], dz)]
        for n in c["pos"]:
            c["pos"][n] = [p + Vector((0, 0, d)) for p, d in zip(c["pos"][n], dz)]
        meta["clips"][name] = {"groundFix": [round(min(dz), 4), round(max(dz), 4)]}
        if "speed" in c:
            meta["clips"][name]["speed"] = round(c["speed"], 4)
        if name in LOCOMOTION:   # normalised time where the left foot is planted (lowest) -> phase-matched gait switches
            lz = [p.z for p in c["pos"][P + "LeftToeBase"]]
            meta["clips"][name]["leftPlant"] = round(int(np.argmin(lz)) / max(len(lz) - 1, 1), 4)
    cs = clips["JumpStart"]["src_contact"]
    low = min(range(len(cs) // 2 + 1), key=lambda f: cs[f])
    meta["clips"]["JumpStart"]["takeoff"] = next((f for f in range(low, len(cs)) if cs[f] > 0.02), len(cs) - 1) / FPS
    cs = clips["JumpLand"]["src_contact"]
    meta["clips"]["JumpLand"]["touchdown"] = next((f for f in range(len(cs)) if cs[f] < 0.01), 0) / FPS
    # roll: horizontal hips travel in the source (the game moves the body along it)
    r = clips["Roll"]
    hy = [(-(v.y - r["loc"][0].y)) for v in r["loc"]]
    meta["clips"]["Roll"]["travel"] = [round(float(x), 4) for x in hy]
    r["loc"] = [Vector((v.x, r["loc"][0].y, v.z)) for v in r["loc"]]   # in-place, travel applied by the game
    clips["Summon"], meta["summon"] = compose_summon(clips)
    meta["rootMotion"] = extract_root_motion(scene, clips["SlashA"]["scale"])
    exported = []
    for name, c in clips.items():
        if name.startswith("_"):
            continue
        write_action(name, c, t_rest)
        meta["clips"].setdefault(name, {})["frames"] = nframes(c)
        exported.append(name)
    kat = import_katana(tgt, scene)
    meta["attacks"] = analyse_attacks(tgt, scene, kat, meta["clips"])
    meta["cloth"] = cloth_cfg
    # web textures: 2048 max
    for img in bpy.data.images:
        if img.size[0] > 2048:
            img.scale(2048, 2048)
    # (character albedo is kept as authored; grade_albedo() is available if a stylised re-grade is ever wanted)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures):
        for d in [d for d in block if d.users == 0]:
            block.remove(d)
    tgt.animation_data.action = None
    for pb in tgt.pose.bones:
        pb.matrix_basis.identity()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, "out", "game_ninja.blend"))
    bpy.ops.object.select_all(action="DESELECT")
    for o in (tgt, body, kat):
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format="GLB", use_selection=True, export_skins=True,
                              export_animations=True, export_animation_mode="ACTIONS", export_anim_single_armature=True,
                              export_reset_pose_bones=True, export_force_sampling=True, export_optimize_animation_size=True,
                              export_yup=True, export_image_format="JPEG", export_jpeg_quality=88, export_def_bones=False)
    with open(OUT_META, "w") as f:
        json.dump(meta, f, indent=1)
    print("WROTE", OUT_GLB, os.path.getsize(OUT_GLB) // 1024, "KB", exported)


main_monster() if MONSTER else main()
