import * as THREE from 'three';

const damp = (a, b, lambda, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-lambda * dt));
const wrapPi = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;

// smoothing rates (1/s; higher = snappier): mouse look, horizontal follow, vertical follow (jumps, landings, steps),
// and the terrain clamp (camera rising over a bump)
const LOOK_RATE = 16, FOLLOW_XZ = 9, FOLLOW_Y = 4.5, CLAMP_RATE = 10;

export class ThirdPersonCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;              // where the mouse wants the camera (input / code write these)
    this.pitch = 0.22;
    this.viewYaw = null;       // what is shown: eased towards yaw / pitch
    this.viewPitch = 0.22;
    this.lift = 0;             // eased height added by the terrain clamp
    this.distance = 4.2;
    this.targetDistance = 4.2;
    this.target = new THREE.Vector3();
    this.trauma = 0;
    this.fovKick = 0;
    this.baseFov = camera.fov;
    this.time = 0;
  }

  shake(amount) { this.trauma = Math.min(1, this.trauma + amount); }

  update(dt, input, focus, { fovKick = 0, playerYaw = 0, ground = null } = {}) {
    this.time += dt;
    this.yaw -= input.mouseDX * 0.0025;
    if (this.lockYaw != null) this.yaw = playerYaw + this.lockYaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.mouseDY * 0.002, -0.35, 1.1);
    this.targetDistance = THREE.MathUtils.clamp(this.targetDistance + input.wheel * 0.5, 2.2, 9);
    this.distance = damp(this.distance, this.targetDistance, 8, dt);

    // ease the view towards the mouse (no per-frame mouse jitter), the follow point towards the player (vertical
    // slower, so jumps / landings / footfalls don't jolt the frame)
    if (this.viewYaw == null) { this.viewYaw = this.yaw; this.viewPitch = this.pitch; this.target.copy(focus); }
    const kl = 1 - Math.exp(-LOOK_RATE * dt);
    this.viewYaw += wrapPi(this.yaw - this.viewYaw) * kl;
    this.viewPitch += (this.pitch - this.viewPitch) * kl;
    const kxz = 1 - Math.exp(-FOLLOW_XZ * dt), ky = 1 - Math.exp(-FOLLOW_Y * dt);
    this.target.x += (focus.x - this.target.x) * kxz;
    this.target.z += (focus.z - this.target.z) * kxz;
    this.target.y += (focus.y - this.target.y) * ky;
    // never let the eased height trail too far (falls, big drops)
    this.target.y = THREE.MathUtils.clamp(this.target.y, focus.y - 1.2, focus.y + 1.2);

    const yaw = this.viewYaw, pitch = this.viewPitch;
    const cp = Math.cos(pitch);
    const offset = new THREE.Vector3(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const pos = this.target.clone().addScaledVector(offset, this.distance).addScaledVector(right, 0.35);
    // terrain clamp, eased (rising fast enough never to sink in, but without a pop)
    const need = ground ? Math.max(0, ground(pos.x, pos.z) + 0.45 - pos.y) : 0;
    this.lift = need > this.lift ? damp(this.lift, need, CLAMP_RATE * 2, dt) : damp(this.lift, need, CLAMP_RATE * 0.5, dt);
    pos.y += this.lift;
    if (ground) pos.y = Math.max(pos.y, ground(pos.x, pos.z) + 0.25);   // hard floor, never under the ground
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target.clone().addScaledVector(right, 0.35));

    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    const s = this.trauma * this.trauma;
    if (s > 0) {
      const t = this.time * 38;
      this.camera.rotateZ((Math.sin(t * 1.3) + Math.sin(t * 2.7)) * 0.012 * s);
      this.camera.rotateX((Math.sin(t * 1.9 + 3) + Math.sin(t * 3.1)) * 0.01 * s);
      this.camera.rotateY((Math.sin(t * 1.7 + 7)) * 0.012 * s);
    }
    this.fovKick = damp(this.fovKick, fovKick, 6, dt);
    const fov = this.baseFov + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Unit vectors on the ground plane for camera-relative movement. */
  basis() {
    return {
      forward: new THREE.Vector3(-Math.sin(this.viewYaw ?? this.yaw), 0, -Math.cos(this.viewYaw ?? this.yaw)),
      right: new THREE.Vector3(Math.cos(this.viewYaw ?? this.yaw), 0, -Math.sin(this.viewYaw ?? this.yaw)),
    };
  }
}
