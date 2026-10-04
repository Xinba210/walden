import * as THREE from 'three';

/**
 * Spring-bone cloth (VRM style): every chain joint keeps a simulated tail point that follows
 * inertia, gravity and a stiffness pull back to the animated rest direction, is pushed out of
 * capsule/sphere colliders and limited to a cone around the rest direction. Runs at a fixed
 * 120 Hz substep after the animation mixer.
 */
const sanitize = (n) => THREE.PropertyBinding.sanitizeNodeName(n);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _m3 = new THREE.Vector3();

class Joint {
  constructor(bone, tail, params, scale) {
    this.bone = bone;
    this.tail = tail;
    this.params = params;
    this.restLocal = bone.quaternion.clone();
    this.axis = tail.position.clone().normalize();
    this.length = tail.position.length() * scale;
    this.cur = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.reset();
  }

  head(out) { return out.setFromMatrixPosition(this.bone.matrixWorld); }

  restDir(out) {
    const parent = this.bone.parent;
    parent.matrixWorld.decompose(_v2, _q2, _s);
    return out.copy(this.axis).applyQuaternion(_q2.multiply(this.restLocal)).normalize();
  }

  reset() {
    this.bone.updateWorldMatrix(true, false);
    this.head(this.cur).addScaledVector(this.restDir(_v), this.length);
    this.prev.copy(this.cur);
  }
}

export class SpringCloth {
  constructor(root, config, modelScale) {
    this.root = root;
    this.scale = modelScale;
    this.joints = [];
    this.colliders = [];
    this.gravity = new THREE.Vector3(0, -1, 0);
    this.acc = 0;
    this.step = 1 / 120;
    this.inertia = 0.25;
    this.smoothing = 0.07;         // seconds: time constant of the output smoothing           // share of the body's own movement the cloth feels as inertia (the rest it follows)
    this.enabled = true;
    const byName = {};
    root.traverse((o) => { if (o.isBone) byName[o.name] = o; });
    this.byName = byName;

    for (const c of config.colliders) {
      const bone = byName[sanitize(c.bone)];
      if (!bone) continue;
      this.colliders.push({
        bone,
        tail: c.tail ? byName[sanitize(c.tail)] : null,
        radius: c.radius * modelScale,
        a: new THREE.Vector3(),
        b: new THREE.Vector3(),
        group: c.tail || c.bone.includes('Hips') ? 'legs+hips' : 'spine',
      });
    }
    // knees: the thigh capsule ends at the knee joint, where the kneecap bulges forward on a kick - add a sphere there
    for (const side of ['Left', 'Right']) {
      const bone = byName[`mixamorig${side}Leg`];
      const thigh = this.colliders.find((c) => c.bone.name === `mixamorig${side}UpLeg`);
      if (bone && thigh) this.colliders.push({ bone, tail: null, radius: thigh.radius * 1.05, a: new THREE.Vector3(), b: new THREE.Vector3(), group: 'legs+hips' });
    }
    for (const chain of config.chains) {
      const bones = chain.bones.map((n) => byName[sanitize(n)]);
      if (bones.some((b) => !b)) { console.warn('missing chain bones', chain.name); continue; }
      const params = {
        stiffness: chain.stiffness * 3.2,
        gravity: chain.gravity * 2.0,
        drag: chain.drag,
        hit: chain.hitRadius * modelScale * 0.6,
        maxAngle: chain.maxAngle ?? (chain.kind === 'coat' ? 1.0 : 1.4),
        colliders: config.colliderGroups[chain.kind],
      };
      for (let i = 0; i < bones.length - 1; i++) this.joints.push(new Joint(bones[i], bones[i + 1], params, modelScale));
    }
    this.jointSet = new Set(this.joints.map((j) => j.bone));
  }

  reset() {
    this.prevRoot = null;
    for (const j of this.joints) j.qs = null;
    this.root.updateMatrixWorld(true);
    for (const j of this.joints) {
      j.bone.quaternion.copy(j.restLocal);
      j.bone.updateMatrixWorld(true);
      j.reset();
    }
    // per-joint collision radius: never larger than the joint's clearance in the rest pose, so cloth that hangs close
    // to a collider is not shoved (and flipped through the legs) every frame; it only stops further penetration
    for (const c of this.colliders) {
      c.a.setFromMatrixPosition(c.bone.matrixWorld);
      if (c.tail) c.b.setFromMatrixPosition(c.tail.matrixWorld);
    }
    const mid = new THREE.Vector3();
    for (const j of this.joints) {
      // per-joint rest clearance: a joint that hangs closer than the collider at rest keeps exactly that clearance
      // (no minimum), so nothing is shoved out at rest - it only stops getting any closer
      j.cr = this.colliders.map((c) => {
        const r = c.radius + j.params.hit;
        const d = this.distTo(j.cur, c);
        return d < r ? d * 0.97 : r;
      });
      // the bone's midpoint too: a thigh swinging forward must not slip between two joints of a coat column
      j.head(mid).add(j.cur).multiplyScalar(0.5);
      j.crm = this.colliders.map((c) => {
        const r = c.radius + j.params.hit;
        const d = this.distTo(mid, c);
        return d < r ? d * 0.97 : r;
      });
    }
  }

  distTo(p, c) {
    if (!c.tail) return p.distanceTo(c.a);
    const ab = _v2.subVectors(c.b, c.a);
    const t = THREE.MathUtils.clamp(_v.subVectors(p, c.a).dot(ab) / ab.lengthSq(), 0, 1);
    return p.distanceTo(_s.copy(c.a).addScaledVector(ab, t));
  }

  update(dt) {
    if (!this.enabled) return;
    dt = Math.min(dt, 1 / 20);
    for (const j of this.joints) j.bone.quaternion.copy(j.restLocal);
    this.root.updateMatrixWorld(true);
    // carry the cloth with the character's own movement (walk / run / turn): only `inertia` of the body's motion this
    // frame is felt as real inertia (a gentle trail); the rest moves the cloth rigidly with the body. Without this the
    // whole locomotion step lands on the cloth once per frame and it jerks.
    const now = this.rootMat ??= new THREE.Matrix4();
    now.copy(this.root.matrixWorld);
    if (this.prevRoot) {
      const delta = _m.copy(this.prevRoot).invert().premultiply(now);
      for (const j of this.joints) {
        _v.copy(j.cur).applyMatrix4(delta); j.cur.lerp(_v, 1 - this.inertia);
        _v.copy(j.prev).applyMatrix4(delta); j.prev.lerp(_v, 1 - this.inertia);
      }
    }
    (this.prevRoot ??= new THREE.Matrix4()).copy(now);
    for (const c of this.colliders) {
      c.a.setFromMatrixPosition(c.bone.matrixWorld);
      if (c.tail) c.b.setFromMatrixPosition(c.tail.matrixWorld);
    }
    // even sub-steps that divide THIS frame's time (no accumulator: every frame advances the cloth by exactly dt)
    const n = Math.max(1, Math.ceil(dt / this.step));
    for (let s = 0; s < n; s++) this.simulate(dt / n);
    // light temporal smoothing of each cloth bone's rotation relative to its parent: removes the frame-to-frame
    // jitter (keyframe kinks, collision pushes) without lagging behind the body, which the parent already carries
    const a = 1 - Math.exp(-dt / this.smoothing);
    for (const j of this.joints) {
      if (!j.qs) { j.qs = j.bone.quaternion.clone(); continue; }
      j.qs.slerp(j.bone.quaternion, a);
      j.bone.quaternion.copy(j.qs);
    }
    for (const j of this.joints) if (j.bone.parent && !this.jointSet.has(j.bone.parent)) j.bone.updateMatrixWorld(true);
  }

  simulate(dt) {
    const head = new THREE.Vector3();
    const rest = new THREE.Vector3();
    const next = new THREE.Vector3();
    for (const j of this.joints) {
      const p = j.params;
      j.bone.updateWorldMatrix(false, false);
      j.head(head);
      j.restDir(rest);

      // velocity damping per second (frame-rate independent), from the per-step drag tuned at 120 Hz
      const keep = Math.pow(1 - p.drag, dt * 120);
      next.copy(j.cur)
        .addScaledVector(_v.subVectors(j.cur, j.prev), keep)
        .addScaledVector(rest, p.stiffness * dt * this.scale)
        .addScaledVector(this.gravity, p.gravity * dt * this.scale * 0.5);
      this.constrain(next, head, rest, j);
      for (let it = 0; it < 8; it++) {
        for (let ci = 0; ci < this.colliders.length; ci++) {
          const c = this.colliders[ci];
          if (c.group !== p.colliders) continue;
          this.collide(next, c, j.cr ? j.cr[ci] : c.radius + p.hit);
          this.collideMid(head, next, c, j.crm ? j.crm[ci] : c.radius + p.hit);
        }
        this.constrain(next, head, rest, j);
      }
      j.prev.copy(j.cur);
      j.cur.copy(next);

      // rotate the bone so its tail points at the simulated position
      const dir = _v.subVectors(next, head).normalize();
      j.bone.parent.matrixWorld.decompose(_v2, _q2, _s);
      const worldRest = _q.copy(_q2).multiply(j.restLocal);
      const from = _v2.copy(j.axis).applyQuaternion(worldRest).normalize();
      const delta = new THREE.Quaternion().setFromUnitVectors(from, dir);
      const world = delta.multiply(worldRest);
      j.bone.quaternion.copy(_q2.invert().multiply(world));
      j.bone.updateMatrixWorld(true);
    }
  }

  constrain(next, head, rest, j) {
    _v.subVectors(next, head);
    let len = _v.length();
    if (len < 1e-6) { _v.copy(rest); len = 1; }
    _v.divideScalar(len);
    const ang = _v.angleTo(rest);
    if (ang > j.params.maxAngle) {
      const axis = _v2.crossVectors(rest, _v).normalize();
      if (axis.lengthSq() > 1e-8) _v.copy(rest).applyAxisAngle(axis, j.params.maxAngle);
    }
    next.copy(head).addScaledVector(_v, j.length);
  }

  /** push the bone's tail so that its midpoint (head + tail) / 2 leaves the collider */
  collideMid(head, tail, c, r) {
    const m = _m3.addVectors(head, tail).multiplyScalar(0.5);
    let closest;
    if (c.tail) {
      const ab = _v2.subVectors(c.b, c.a);
      const t = THREE.MathUtils.clamp(_v.subVectors(m, c.a).dot(ab) / ab.lengthSq(), 0, 1);
      closest = _s.copy(c.a).addScaledVector(ab, t);
    } else {
      closest = _s.copy(c.a);
    }
    const d = _v.subVectors(m, closest);
    const len = d.length();
    if (len < r && len > 1e-6) tail.addScaledVector(d, (2 * (r - len)) / len);
  }

  collide(p, c, r) {
    let closest;
    if (c.tail) {
      const ab = _v2.subVectors(c.b, c.a);
      const t = THREE.MathUtils.clamp(_v.subVectors(p, c.a).dot(ab) / ab.lengthSq(), 0, 1);
      closest = _s.copy(c.a).addScaledVector(ab, t);
    } else {
      closest = _s.copy(c.a);
    }
    const d = _v.subVectors(p, closest);
    const len = d.length();
    if (len < r && len > 1e-6) p.copy(closest).addScaledVector(d, r / len);
  }
}
