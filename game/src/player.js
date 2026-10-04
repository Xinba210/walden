import * as THREE from 'three';

const GRAVITY = 22;
const JUMP_V = 6.6;
const RADIUS = 0.33;
const MAX_SLOPE = 1.0;            // steepest walkable ground (rise / run): 45 degrees
const FRAME = 1 / 30;
const CYAN = new THREE.Color(0.45, 0.92, 1);
const WHITE_CYAN = new THREE.Color(0.8, 0.97, 1);

/**
 * Attack graph. Timing comes from the sword-tip analysis baked into clipMeta.attacks (strike window + peak per clip):
 *  - warp: playback rate per phase (wind-up is compressed so swings start fast, the strike plays at authored speed,
 *    follow-through slightly faster) -> snappy but readable
 *  - a buffered follow-up chains `chainDelay` after the strike window ends (not at a fixed % of a long clip)
 *  - hits are only tested inside the strike window, slash waves fire on the peak frame, swooshes on strike start
 */
const ATTACKS = {
  A: { clip: 'SlashA', rec: 'SlashA_Rec', next: { L: 'B', R: 'Dash' }, power: 1.0, warp: [1.45, 1.0, 1.15], chainDelay: 2 * FRAME, lunge: 1.4 },
  B: { clip: 'SlashB', rec: 'SlashB_Rec', next: { L: 'C', R: 'Dash' }, power: 1.15, warp: [1.45, 1.0, 1.15], chainDelay: 2 * FRAME, lunge: 1.4 },
  C: { clip: 'SlashC', rec: null, next: { L: 'A', R: 'Dash' }, power: 1.6, warp: [1.35, 0.95, 1.3], chainDelay: 5 * FRAME, wave: true, lunge: 2.0, endBlend: 0.3 },
  Dash: { clip: 'SwordDash', rec: null, next: { L: 'A', R: 'Dash' }, power: 1.9, warp: [1.25, 1.0, 1.25], chainDelay: 4 * FRAME, wave: true, dash: true, lunge: 0, endBlend: 0.3 },
};

const smooth = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const smoothstep = (e0, e1, x) => { const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

export class Player {
  constructor(o) {
    Object.assign(this, o); // object, animator, katana, meta, cloth, fx, particles, dustParticles, trail, sfx, cam, dummies, colliders, ground
    this.pos = new THREE.Vector3();
    this.yaw = Math.PI;
    this.yawRate = 0;
    this.speed = 0;
    this.moveDir = new THREE.Vector3(0, 0, -1);
    this.vy = 0;
    this.grounded = true;
    this.armed = false;
    this.state = 'move';
    this.sprintT = 0;
    this.enterFade = 0.3;
    this.hitstop = 0;
    this.time = 0;
    this.tipPrev = new THREE.Vector3();
    this.basePrev = new THREE.Vector3();
    this.tipSpeed = 0;
    this.lean = 0;
    this.pitchLean = 0;
    this.buffer = null;            // {btn, t}
    this.invuln = 0;
    this.maxHp = 100;
    this.hp = this.maxHp;
    this.alive = true;
    const c = this.meta.clips;
    this.gaits = {
      walk: { clip: 'Walk', speed: c.Walk.speed, plant: c.Walk.leftPlant ?? 0 },
      run: { clip: 'Run', speed: c.Run.speed, plant: c.Run.leftPlant ?? 0 },
      sprint: { clip: 'Sprint', speed: c.Sprint.speed, plant: c.Sprint.leftPlant ?? 0 },
    };
    this.animator.play('Idle', { fade: 0 });
  }

  /* ------------------------------------------------------------------ helpers */
  forward(out = new THREE.Vector3()) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  rightDir(out = new THREE.Vector3()) { return out.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw)); }

  inputDir(input) {
    const { forward, right } = this.cam.basis();
    const v = new THREE.Vector3()
      .addScaledVector(forward, (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0))
      .addScaledVector(right, (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0));
    return v.lengthSq() > 0 ? v.normalize() : null;
  }

  bone(name) {
    if (!this._bones) {
      this._bones = {};
      this.object.traverse((o) => { if (o.isBone) this._bones[o.name] = o; });
    }
    return this._bones[name];
  }

  palm(out = new THREE.Vector3()) {
    const hand = this.bone('mixamorigRightHand'), mid = this.bone('mixamorigRightHandMiddle1');
    return out.setFromMatrixPosition(hand.matrixWorld).lerp(new THREE.Vector3().setFromMatrixPosition(mid.matrixWorld), 0.6);
  }

  turnTowards(dir, rate, dt) {
    if (!dir) return;
    const target = Math.atan2(dir.x, dir.z);
    const d = angleDiff(this.yaw, target) * (1 - Math.exp(-rate * dt));
    this.yaw += d;
    return d;
  }

  sampleRM(clip, t) {
    const rm = this.meta.rootMotion[clip];
    if (!rm) return null;
    const f = THREE.MathUtils.clamp(t * this.meta.fps, 0, rm.length - 1);
    const i = Math.floor(f), k = f - i, j = Math.min(i + 1, rm.length - 1);
    return [THREE.MathUtils.lerp(rm[i][0], rm[j][0], k), THREE.MathUtils.lerp(rm[i][1], rm[j][1], k)];
  }

  /** nearest dummy in a forward cone (soft lock for lunges) */
  target(range = 3.2) {
    const f = this.forward();
    let best = null, bd = range;
    for (const d of this.dummies.list) {
      if (d.alive === false) continue;
      const v = new THREE.Vector3(d.root.position.x - this.pos.x, 0, d.root.position.z - this.pos.z);
      const dist = v.length();
      if (dist < bd && v.normalize().dot(f) > 0.35) { best = d; bd = dist; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ main update */
  update(dt, input) {
    this.time += dt;
    this.invuln = Math.max(0, this.invuln - dt);
    const dir = this.inputDir(input);
    const btn = input.hit('MouseLeft') ? 'L' : input.hit('MouseRight') ? 'R' : null;
    if (btn) this.buffer = { btn, t: this.time };
    if (this.buffer && this.time - this.buffer.t > 0.4) this.buffer = null;     // input buffer window

    const canAct = this.state !== 'hurt' && this.state !== 'dead';
    if (canAct && input.hit('KeyE')) this.toggleSword();
    if (canAct && input.hit('KeyC')) this.tryRoll(dir);
    if (canAct && input.hit('Space')) this.tryJump();
    if (canAct && this.buffer) this.onAttackInput(this.buffer.btn);
    if (this.state === 'dead' && input.hit('KeyR')) this.respawn?.();

    const yaw0 = this.yaw;
    (this.prevPos ??= new THREE.Vector3()).copy(this.pos);     // for the solid / slope checks in resolveCollisions
    if (this.state === 'move') this.updateMove(dt, dir, input);
    else if (this.state === 'jump') this.updateJump(dt, dir);
    else if (this.state === 'summon') this.updateSummon(dt, dir);
    else if (this.state === 'attack') this.updateAttack(dt, dir);
    else if (this.state === 'roll') this.updateRoll(dt, dir);
    else if (this.state === 'hurt') this.updateHurt(dt);
    else if (this.state === 'dead') this.updateDead(dt);
    this.yawRate = smooth(this.yawRate, angleDiff(yaw0, this.yaw) / Math.max(dt, 1e-4), 10, dt);

    this.resolveCollisions();
    if (this.grounded) this.pos.y = this.ground(this.pos.x, this.pos.z);
    this.object.position.copy(this.pos);
    this.object.rotation.y = this.yaw;
  }

  /** Procedural layer applied after the mixer, before cloth: lean into turns, tilt with acceleration. */
  procedural(dt) {
    const moving = this.state === 'move' && this.speed > 0.4;
    const bank = moving ? THREE.MathUtils.clamp(-this.yawRate * this.speed * 0.045, -0.28, 0.28) : 0;
    this.lean = smooth(this.lean, bank, 8, dt);
    const acc = (this.speed - (this._speedPrev ?? this.speed)) / Math.max(dt, 1e-4);
    this._speedPrev = this.speed;
    this.pitchLean = smooth(this.pitchLean, moving ? THREE.MathUtils.clamp(acc * 0.012, -0.08, 0.1) : 0, 6, dt);
    const hips = this.bone('mixamorigHips'), spine = this.bone('mixamorigSpine1');
    if (Math.abs(this.lean) > 1e-4) hips.rotateOnWorldAxis(this.forward(), this.lean * 0.6);
    if (Math.abs(this.pitchLean) > 1e-4) spine.rotateOnWorldAxis(this.rightDir(), -this.pitchLean);
    if (Math.abs(this.lean) > 1e-4) spine.rotateOnWorldAxis(this.forward(), -this.lean * 0.25);
  }

  /** Called after mixer + cloth (bones final): sword trail, sparks, hit tests on the strike window. */
  postAnimate(dt) {
    const k = this.katana;
    const tip = k.tip(new THREE.Vector3()), base = k.base(new THREE.Vector3());
    this.tipSpeed = dt > 0 ? tip.distanceTo(this.tipPrev) / dt : 0;
    const striking = this.state === 'attack' && this.atk.phase === 'strike';
    const inten = k.progress > 0.05 && (this.state === 'attack' || this.state === 'summon') ? smoothstep(2.5, 9, this.tipSpeed) * k.progress * (striking ? 1.15 : 0.6) : 0;
    if (inten > 0.02) this.trail.push(base, tip, this.time, Math.min(1, inten));
    this.trail.update(this.time);
    if (striking) {
      if (Math.random() < 0.9) {
        const p = k.at(0.55 + Math.random() * 0.45);
        this.particles.emit(p, new THREE.Vector3((Math.random() - 0.5) * 0.6, Math.random() * 0.5, (Math.random() - 0.5) * 0.6), CYAN, { life: 0.35, size: 0.035, drag: 2 });
      }
      this.checkHits(tip, base);
    }
    this.tipPrev.copy(tip);
    this.basePrev.copy(base);
  }

  /* ------------------------------------------------------------------ locomotion */
  updateMove(dt, dir, input) {
    const shift = input.down('ShiftLeft') || input.down('ShiftRight');
    this.sprintT = dir && shift ? this.sprintT + dt : 0;
    const gait = !shift ? 'walk' : this.sprintT > 1.2 ? 'sprint' : 'run';
    const target = dir ? this.gaits[gait].speed : 0;
    const accel = target > this.speed ? (gait === 'walk' ? 4 : gait === 'run' ? 9 : 6) : 12;
    this.speed = Math.max(0, this.speed + Math.sign(target - this.speed) * Math.min(Math.abs(target - this.speed), accel * dt));
    if (dir) this.moveDir.lerp(dir, 1 - Math.exp(-12 * dt)).normalize();
    // sharper turns when slow, wider arcs at speed
    this.turnTowards(this.speed > 0.05 ? this.moveDir : null, THREE.MathUtils.lerp(14, 7, smoothstep(1, 5, this.speed)), dt);
    const vel = this.forward().multiplyScalar(this.speed * 0.85).addScaledVector(this.moveDir, this.speed * 0.15);
    this.pos.addScaledVector(vel, dt);

    const moving = this.speed > 0.2 || (dir && this.speed > 0.05);
    const fade = this.enterFade;
    this.enterFade = 0.3;
    if (!moving) {
      this.animator.play(this.armed ? 'SwordIdle' : 'Idle', { fade: Math.max(fade, 0.35) });
      this.currentLoco = null;
      return;
    }
    const g = this.speed > this.gaits.run.speed * 1.12 ? 'sprint' : this.speed > this.gaits.walk.speed * 1.5 ? 'run' : 'walk';
    const G = this.gaits[g];
    const ts = THREE.MathUtils.clamp(this.speed / G.speed, 0.65, 1.3);
    // phase-matched gait switch: keep the left-foot plant phase when changing clips
    let startAt = 0;
    if (this.currentLoco && this.currentLoco !== G.clip) {
      const prev = Object.values(this.gaits).find((x) => x.clip === this.currentLoco);
      const a = this.animator.action(prev.clip, 'lower');
      const ph = ((a.time / a.getClip().duration) - prev.plant + 1) % 1;
      startAt = ((ph + G.plant) % 1) * this.animator.duration(G.clip);
    }
    const f = this.currentLoco && this.currentLoco !== G.clip ? 0.28 : Math.max(fade, 0.25);
    this.animator.play(G.clip, { fade: f, startAt }, ['lower', 'torso']);
    this.animator.play(this.armed ? 'SwordIdle' : G.clip, { fade: this.armed ? Math.max(fade, 0.3) : f, startAt }, ['rarm']);
    this.animator.setTimeScale(G.clip, ts);
    this.currentLoco = G.clip;
    this.footsteps(G.clip, dt);
  }

  /**
   * Footsteps from the real foot plants: each foot's height above the ground is tracked; a step sounds when a foot
   * comes down to its contact height after having been lifted (hysteresis, so one plant = one sound), whatever the
   * clip's stride count or timing. Walk steps are quieter than run steps.
   */
  footsteps(clip, dt = 1 / 60) {
    this.feet ??= ['Left', 'Right'].map((s) => ({ bone: this.bone(`mixamorig${s}Foot`), low: Infinity, lifted: false }));
    const g = this.ground(this.pos.x, this.pos.z), w = new THREE.Vector3();
    const walking = clip === 'Walk';
    for (const f of this.feet) {
      if (!f.bone) continue;
      const y = f.bone.getWorldPosition(w).y - g;
      // contact height: running minimum that slowly relaxes (adapts to clip / slope changes)
      f.low = Math.min(f.low + dt * 0.05, y);
      if (y > f.low + (walking ? 0.05 : 0.07)) f.lifted = true;
      else if (f.lifted && y < f.low + (walking ? 0.018 : 0.025)) {
        f.lifted = false;
        this.sfx.step(walking ? 0.3 : 1);
        if (!walking) this.dust(w.setY(this.pos.y), 3, 0.8, 0.5);
      }
    }
  }

  /* ------------------------------------------------------------------ jump */
  /** an enemy blow landed: damage, knock back, stagger (rolling = invulnerable, the dodge) */
  takeHit(dmg, dir, at) {
    if (!this.alive || this.invuln > 0) return false;
    if (!(dir?.lengthSq() > 1e-8) || !Number.isFinite(dir.x)) dir = this.forward().negate();
    this.hp = Math.max(0, this.hp - dmg);
    this.cam.shake(0.35);
    this.dustParticles?.burst(at ?? this.pos.clone().setY(this.pos.y + 1.2), 26, { speed: 4, color: new THREE.Color(0.45, 0.02, 0.04), life: 0.6, size: 0.045, gravity: 8, drag: 2 });
    this.knock = dir.clone().multiplyScalar(dmg > 15 ? 4.2 : 2.6);
    this.yaw = Math.atan2(-dir.x, -dir.z);                  // face the attacker
    if (this.hp <= 0) {
      this.alive = false;
      this.state = 'dead';
      this.deadT = 0;
      if (this.animator.clips.Death) this.animator.play('Death', { fade: 0.12, loop: false, restart: true });
      return true;
    }
    this.state = 'hurt';
    this.hurtT = 0;
    const has = (c) => !!this.animator.clips[c];
    const clip = dmg > 15 && has('Knockback') ? 'Knockback' : has('HitReact') ? 'HitReact' : null;
    this.hurtClip = clip;
    this.hurtSlowed = false;
    // a knockdown plays out fully and the getting-up half runs at 0.45x (heavy, slow recovery); a flinch is short
    const len = clip ? this.animator.duration(clip) : 0.45;
    this.hurtDur = clip === 'Knockback' ? len * 0.4 + (len * 0.6) / 0.45 : clip ? Math.min(len * 0.75, 0.9) : 0.45;
    if (clip) this.animator.play(clip, { fade: 0.06, loop: false, restart: true });
    this.invuln = this.hurtDur + 0.5;                       // a short grace period after being hit
    return true;
  }

  updateHurt(dt) {
    this.hurtT += dt;
    if (this.hurtClip === 'Knockback' && !this.hurtSlowed && this.hurtT > this.animator.duration('Knockback') * 0.4) {
      this.animator.setTimeScale('Knockback', 0.45);
      this.hurtSlowed = true;
    }
    this.pos.addScaledVector(this.knock, dt);
    this.knock.multiplyScalar(Math.exp(-6 * dt));
    this.speed = 0;
    if (this.hurtT >= this.hurtDur) { this.state = 'move'; this.enterFade = 0.2; }
  }

  updateDead(dt) {
    this.deadT += dt;
    if (this.knock) { this.pos.addScaledVector(this.knock, dt); this.knock.multiplyScalar(Math.exp(-5 * dt)); }
    this.speed = 0;
  }

  tryJump() {
    if (!this.grounded || !(this.state === 'move' || (this.state === 'jump' && this.jump.phase === 'land'))) return;
    this.state = 'jump';
    this.jump = { phase: 'start', t: 0, took: false, landT: 0, carry: this.speed };
    this.animator.play('JumpStart', { fade: 0.08, loop: false, restart: true });
    this.animator.setTimeScale('JumpStart', 1.2);
  }

  updateJump(dt, dir) {
    const j = this.jump;
    j.t += dt;
    const air = dir ? Math.max(j.carry, this.gaits.run.speed * 0.6) : j.carry * 0.6;
    this.speed = smooth(this.speed, air, j.phase === 'land' ? 10 : 3, dt);
    if (dir) this.moveDir.lerp(dir, 1 - Math.exp(-5 * dt)).normalize();
    this.turnTowards(dir ? this.moveDir : null, 5, dt);
    this.pos.addScaledVector(this.forward(), this.speed * dt);
    const takeoff = this.meta.clips.JumpStart.takeoff / 1.2;
    if (j.phase === 'start' && !j.took && j.t >= takeoff) {
      j.took = true;
      this.vy = JUMP_V;
      this.grounded = false;
      this.sfx.jump();
      this.dust(this.pos, 14, 2.2);
    }
    if (!this.grounded) {
      this.vy -= GRAVITY * dt;
      this.pos.y += this.vy * dt;
      if (j.phase === 'start' && (this.vy < 2.5 || j.t > takeoff + 0.35)) {
        j.phase = 'air';
        this.animator.play('JumpLoop', { fade: 0.25 });
      }
      const gy = this.ground(this.pos.x, this.pos.z);
      if (this.pos.y <= gy && this.vy < 0) {
        const impact = -this.vy;
        this.pos.y = gy;
        this.vy = 0;
        this.grounded = true;
        j.phase = 'land';
        j.landT = 0;
        this.animator.play('JumpLand', { fade: 0.06, loop: false, restart: true, startAt: this.meta.clips.JumpLand.touchdown });
        this.animator.setTimeScale('JumpLand', 1.25);
        this.cam.shake(0.08 + impact * 0.015);
        this.sfx.land();
        this.dust(this.pos, 22, 2.8);
      }
    }
    if (j.phase === 'land') {
      j.landT += dt;
      if ((j.landT > 0.16 && dir) || j.landT > 0.55) {
        this.state = 'move';
        this.enterFade = dir ? 0.18 : 0.35;
      }
    }
  }

  /* ------------------------------------------------------------------ dodge roll */
  tryRoll(dir) {
    const okAttack = this.state === 'attack' && (this.atk.phase === 'follow' || this.atk.phase === 'rec');
    if (!(this.state === 'move' || okAttack || (this.state === 'jump' && this.jump.phase === 'land'))) return;
    const d = dir ?? this.forward();
    this.yaw = Math.atan2(d.x, d.z);
    this.state = 'roll';
    this.roll = { t: 0, dur: this.animator.duration('Roll') / 1.45 };
    this.invuln = this.roll.dur * 0.6;
    this.animator.play('Roll', { fade: 0.06, loop: false, restart: true });
    this.animator.setTimeScale('Roll', 1.45);
    this.sfx.roll?.();
    this.dust(this.pos, 10, 1.6);
  }

  updateRoll(dt, dir) {
    const r = this.roll;
    r.t += dt;
    const u = r.t / r.dur;
    this.speed = 6.2 * Math.pow(Math.max(0, 1 - u), 1.3) + (u < 0.1 ? u * 10 : 0);
    if (dir) this.turnTowards(dir, 2.5, dt);
    this.pos.addScaledVector(this.forward(), this.speed * dt);
    if (u > 0.3 && u < 0.35) this.sfx.step(0.5);
    if ((u > 0.72 && dir) || u >= 0.92) {
      this.state = 'move';
      this.enterFade = 0.25;
      this.speed = dir ? this.gaits.run.speed * 0.7 : 0;
    }
  }

  dust(at, n, speed, life = 0.8) {
    const c = new THREE.Color(0.5, 0.47, 0.6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = new THREE.Vector3(Math.cos(a), 0.25 + Math.random() * 0.4, Math.sin(a)).multiplyScalar(speed * (0.4 + Math.random() * 0.6));
      this.dustParticles.emit(at.clone().add(new THREE.Vector3(Math.cos(a) * 0.2, 0.05, Math.sin(a) * 0.2)), v, c, { life, size: 0.22, sizeEnd: 0.55, drag: 4 });
    }
  }

  /* ------------------------------------------------------------------ summon / dismiss */
  toggleSword() {
    if (this.state === 'summon') return;
    if (!this.armed && this.state === 'move') this.startSummon(null);
    else if (this.armed && (this.state === 'move' || this.state === 'jump')) this.dismissSword();
  }

  startSummon(pending) {
    this.state = 'summon';
    this.summon = { t: 0, charged: false, reveal: false, done: false, pending };
    this.animator.play('Summon', { fade: 0.18, loop: false, restart: true });
  }

  updateSummon(dt, dir) {
    const s = this.summon, m = this.meta.summon;
    s.t = this.animator.action('Summon').time;
    this.speed = smooth(this.speed, 0, 10, dt);
    this.pos.addScaledVector(this.forward(), this.speed * dt);
    const palm = this.palm();
    if (!s.charged && s.t >= m.handOut - 0.3) { s.charged = true; this.sfx.summonCharge(); }
    if (s.charged && !s.reveal) {
      for (let i = 0; i < 4; i++) {
        const off = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(0.45 + Math.random() * 0.35);
        this.particles.emit(palm.clone().add(off), off.clone().multiplyScalar(-2.8), CYAN, { life: 0.28, size: 0.05, sizeEnd: 0.01, drag: 0 });
      }
    }
    // the blade grows hilt->tip exactly while the fingers close (curlStart..curlEnd)
    if (!s.reveal && s.t >= m.curlStart) {
      s.reveal = true;
      this.katana.summon(Math.max(0.15, m.curlEnd - m.curlStart));
      this.fx.ring(palm, { color: CYAN, radius: 0.45, life: 0.3, flat: false, normal: this.forward() });
      this.fx.flash(palm, this.cam.camera, { size: 0.7, life: 0.18 });
    }
    if (s.reveal && !this.katana.full) {
      const front = this.katana.at(this.katana.progress);
      for (let i = 0; i < 6; i++) {
        const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).multiplyScalar(2.2);
        this.particles.emit(front, v, Math.random() < 0.3 ? WHITE_CYAN : CYAN, { life: 0.42, size: 0.045, drag: 3, gravity: -0.5 });
      }
    }
    const dur = this.animator.duration('Summon');
    // a queued attack fires as soon as the sword is complete; movement can cancel the settle
    if (s.done && s.pending && s.t >= m.curlEnd + 0.05) { this.finishSummon(); this.startAttack(s.pending === 'L' ? 'A' : 'Dash', 0.12); return; }
    if (s.done && ((dir && s.t > m.curlEnd + 0.15) || s.t >= dur - 0.15)) this.finishSummon();
  }

  finishSummon() { this.armed = true; this.state = 'move'; this.enterFade = 0.22; }

  onSwordComplete() {
    if (this.state !== 'summon') return;
    this.summon.done = true;
    this.armed = true;
    const tip = this.katana.tip(new THREE.Vector3()), mid = this.katana.at(0.6);
    this.katana.flash = 0.8;
    this.fx.flash(tip, this.cam.camera, { size: 0.55, life: 0.22, intensity: 0.5 });
    this.fx.ring(mid, { color: CYAN, radius: 0.9, life: 0.4, flat: false, normal: tip.clone().sub(mid).normalize(), intensity: 0.6 });
    this.particles.burst(mid, 50, { speed: 3.5, color: CYAN, life: 0.6, size: 0.035, drag: 2.5 });
    this.cam.shake(0.25);
  }

  dismissSword() {
    this.armed = false;
    this.katana.dismiss(0.4);
    this.sfx.dismiss();
    this.enterFade = 0.4;
    this.dismissing = true;
  }

  updateDismissFx() {
    if (!this.dismissing) return;
    if (!this.katana.visible) { this.dismissing = false; return; }
    const front = this.katana.at(this.katana.progress);
    for (let i = 0; i < 5; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(1.4);
      this.particles.emit(front, v, CYAN, { life: 0.6, size: 0.04, drag: 1.5, gravity: -1 });
    }
  }

  /* ------------------------------------------------------------------ attacks */
  timing(clip) { return this.meta.attacks[clip]; }

  onAttackInput(btn) {
    if (this.state === 'summon') { this.summon.pending = btn; this.buffer = null; return; }
    if (this.state === 'move' || (this.state === 'jump' && this.jump.phase === 'land')) {
      this.buffer = null;
      if (!this.armed) {
        if (this.katana.progress > 0.5 && this.katana.target > 0) { this.armed = true; this.startAttack(btn === 'L' ? 'A' : 'Dash', 0.1); }
        else this.startSummon(btn);
      } else this.startAttack(btn === 'L' ? 'A' : 'Dash', 0.1);
      return;
    }
    if (this.state === 'attack') {
      const a = this.atk;
      // a follow-up is already queued: keep this press buffered so it carries into the next swing
      if (a.buffered) return;
      // accept the follow-up once the swing has committed (half-way through the wind-up)
      if (a.phase === 'rec' || a.t >= this.timing(a.def.clip).strike[0] * 0.5) {
        a.buffered = a.phase === 'rec' && a.t > 0.25 ? (btn === 'L' ? 'A' : 'Dash') : a.def.next[btn];
        this.buffer = null;
      }
    }
  }

  startAttack(id, fade) {
    const def = ATTACKS[id];
    this.state = 'attack';
    this.atk = { id, def, clip: def.clip, phase: 'wind', t: 0, hits: new Set(), buffered: null, peaked: false };
    this.animator.play(def.clip, { fade, loop: false, restart: true });
    this.animator.setTimeScale(def.clip, def.warp[0]);
    this.speed = Math.min(this.speed, 4.5);
    // soft lock: snap facing toward a dummy in front, else toward input
    const tg = this.target();
    if (tg) this.atk.aim = Math.atan2(tg.root.position.x - this.pos.x, tg.root.position.z - this.pos.z);
    if (def.dash) { this.dust(this.pos, 18, 3.5); this.cam.shake(0.1); }
  }

  updateAttack(dt, dir) {
    const a = this.atk;
    const act = this.animator.action(a.clip);
    const prevT = a.t;
    a.t = act.time;
    const dur = this.animator.duration(a.clip);
    this.speed = smooth(this.speed, 0, 8, dt);
    this.pos.addScaledVector(this.forward(), this.speed * dt);
    if (a.phase === 'rec') return this.updateRecovery(dt, dir, dur);

    const T = this.timing(a.clip);
    const phase = a.t < T.strike[0] ? 'wind' : a.t <= T.strike[1] + FRAME ? 'strike' : 'follow';
    if (phase !== a.phase) {
      a.phase = phase;
      this.animator.setTimeScale(a.clip, a.def.warp[phase === 'wind' ? 0 : phase === 'strike' ? 1 : 2]);
      if (phase === 'strike') { this.sfx.swoosh(a.def.power); this.katana.flash = Math.max(this.katana.flash, 0.3); }
    }
    // aim during the wind-up: soft-lock target or input direction
    if (a.phase === 'wind') {
      if (a.aim !== undefined) this.yaw += angleDiff(this.yaw, a.aim) * (1 - Math.exp(-20 * dt));
      else if (dir) this.turnTowards(dir, 18, dt);
    }
    // lunge toward the target during the wind-up (closes small gaps), plus authored root motion
    if (a.phase === 'wind' && a.def.lunge && a.aim !== undefined) {
      const tg = this.target(3.5);
      if (tg) {
        const d = Math.hypot(tg.root.position.x - this.pos.x, tg.root.position.z - this.pos.z);
        if (d > 1.25) this.pos.addScaledVector(this.forward(), Math.min(d - 1.25, a.def.lunge * dt * 3));
      }
    }
    const r0 = this.sampleRM(a.clip, prevT), r1 = this.sampleRM(a.clip, a.t);
    if (r0 && r1 && a.t >= prevT) {
      this.pos.addScaledVector(this.forward(), r1[0] - r0[0]);
      this.pos.addScaledVector(this.rightDir(), r1[1] - r0[1]);
    }
    if (!a.peaked && a.t >= T.peak) {
      a.peaked = true;
      if (a.def.wave) this.spawnWave(this.katana.tip(new THREE.Vector3()), this.katana.base(new THREE.Vector3()));
    }
    // chain: buffered follow-up right after the strike window
    if (a.buffered && a.t >= T.strike[1] + a.def.chainDelay) {
      this.startAttack(a.buffered, a.def.next.L === a.buffered ? 0.07 : 0.12);
      return;
    }
    if (a.def.rec && a.t >= dur - 1e-3) {
      a.phase = 'rec';
      a.clip = a.def.rec;
      a.t = 0;
      this.animator.play(a.def.rec, { fade: 0.04, loop: false, restart: true });
      this.animator.setTimeScale(a.def.rec, 1.15);
      return;
    }
    if (!a.def.rec) {
      // long finishers: movement cancels the follow-through, otherwise blend out near the end
      if ((dir && a.t > T.strike[1] + 0.3) || a.t >= dur - a.def.endBlend) {
        this.state = 'move';
        this.enterFade = dir ? 0.2 : a.def.endBlend;
      }
    }
  }

  updateRecovery(dt, dir, dur) {
    const a = this.atk;
    if (a.buffered) { this.startAttack(a.buffered, 0.1); return; }
    if ((dir && a.t / dur > 0.22) || a.t >= dur - 0.1) {
      this.state = 'move';
      this.enterFade = dir ? 0.2 : 0.22;
    }
  }

  spawnWave(tip, base) {
    const fwd = this.forward(), right = this.rightDir();
    const blade = tip.clone().sub(base).normalize();
    const roll = Math.atan2(blade.y, -blade.dot(right));
    const origin = this.pos.clone().addScaledVector(fwd, 0.9).setY(this.pos.y + 1.05);
    this.fx.slashWave(origin, fwd, { roll, size: this.atk.id === 'Dash' ? 2.0 : 1.7, speed: 16 });
    this.particles.burst(origin, 25, { speed: 5, dir: fwd.clone().multiplyScalar(2), color: CYAN, life: 0.4, size: 0.04 });
    this.cam.shake(0.12);
  }

  checkHits(tip, base) {
    if (!this.katana.full) return;
    const a = this.atk;
    const pts = [];
    for (const s of [0, 0.33, 0.66, 1]) {
      const t0 = this.tipPrev.clone().lerp(tip, s), b0 = this.basePrev.clone().lerp(base, s);
      for (const u of [0, 0.35, 0.7, 1]) pts.push(b0.clone().lerp(t0, u));
    }
    for (const d of this.dummies.list) {
      if (a.hits.has(d) || d.alive === false) continue;
      const c = d.root.position;
      const hit = pts.find((p) => Math.hypot(p.x - c.x, p.z - c.z) < d.radius + 0.08 && p.y > c.y + d.height[0] && p.y < c.y + d.height[1]);
      if (!hit) continue;
      a.hits.add(d);
      const dir = new THREE.Vector3(c.x - this.pos.x, 0, c.z - this.pos.z).normalize();
      this.dummies.hit(d, dir, a.def.power);
      this.hitstop = 0.055 + 0.03 * a.def.power;
      this.cam.shake(0.2 + 0.12 * a.def.power);
      const sparkDir = tip.clone().sub(this.tipPrev).normalize();
      if (d.isMonster) {
        // flesh: a blood slash smear along the cut + spray thrown along the swing, no glow
        // a little spray off the body's skin where the blade met it
        const sf = d.surfaceNear?.(hit, this.pos) ?? { pos: hit, normal: dir.clone().negate(), bone: null };
        this.dustParticles.burst(sf.pos, 18, { speed: 3.5, dir: sf.normal.clone().add(sparkDir).multiplyScalar(0.9), spread: 0.6, color: new THREE.Color(0.4, 0.02, 0.04), life: 0.6, size: 0.035, drag: 1.5, gravity: 9 });
        continue;
      }
      this.katana.flash = Math.max(this.katana.flash, 0.7);
      this.particles.burst(hit, 40, { speed: 7, dir: sparkDir.multiplyScalar(1.5), spread: 0.8, color: new THREE.Color(1, 0.85, 0.5), life: 0.35, size: 0.035, drag: 3, gravity: 9 });
      this.particles.burst(hit, 20, { speed: 3, color: CYAN, life: 0.45, size: 0.035, drag: 2 });
      this.particles.burst(hit, 14, { speed: 2.5, color: new THREE.Color(0.8, 0.65, 0.3), life: 0.9, size: 0.06, drag: 1.5, gravity: 4 });
      this.fx.flash(hit, this.cam.camera, { size: 0.7 + 0.2 * a.def.power, life: 0.14, intensity: 0.35, color: new THREE.Color(0.9, 0.97, 1) });
    }
  }

  /** would stepping from `from` towards (x, z) climb a slope steeper than MAX_SLOPE (rise / run over a short look-ahead)? */
  tooSteep(from, x, z) {
    const dx = x - from.x, dz = z - from.z, d = Math.hypot(dx, dz);
    if (!this.grounded || d < 1e-4) return false;
    const L = 0.5, g0 = this.ground(from.x, from.z), g1 = this.ground(from.x + (dx / d) * L, from.z + (dz / d) * L);
    return (g1 - g0) / L > MAX_SLOPE;
  }

  resolveCollisions() {
    const solids = [];
    for (const c of this.colliders()) {
      if (c.blocked) { solids.push(c); continue; }       // occupancy-grid collider (world2: cliffs, piers, deep water)
      const dx = this.pos.x - c.x, dz = this.pos.z - c.z;
      const d = Math.hypot(dx, dz), min = c.r + RADIUS;
      if (d < min && d > 1e-5) { this.pos.x = c.x + (dx / d) * min; this.pos.z = c.z + (dz / d) * min; }
    }
    // solid cells and too-steep ground: slide along whichever axis is still free, else stay put. If the previous
    // position was already inside a solid (spawned / teleported there) movement is not restricted, so it can't trap.
    const prev = this.prevPos;
    if (prev) {
      const solidAt = (x, z) => solids.some((c) => c.blocked(x, z, RADIUS));
      const blocked = (x, z) => solidAt(x, z) || this.tooSteep(prev, x, z);
      if (!solidAt(prev.x, prev.z) && blocked(this.pos.x, this.pos.z)) {
        if (!blocked(this.pos.x, prev.z)) this.pos.z = prev.z;
        else if (!blocked(prev.x, this.pos.z)) this.pos.x = prev.x;
        else { this.pos.x = prev.x; this.pos.z = prev.z; }
      }
    }
    // stay inside the world's playable area
    const B = this.bounds;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, B.minX, B.maxX);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, B.minZ, B.maxZ);
  }

  debug() {
    const a = this.atk;
    return [
      `state   ${this.state}${this.state === 'jump' ? ':' + this.jump.phase : ''}${this.state === 'attack' ? ':' + a.id + '/' + a.phase + (a.buffered ? ' >' + a.buffered : '') : ''}`,
      `armed   ${this.armed}  sword ${this.katana.progress.toFixed(2)}`,
      `speed   ${this.speed.toFixed(2)}  tip ${this.tipSpeed.toFixed(1)}  lean ${this.lean.toFixed(2)}`,
      `anim    ${['lower', 'torso', 'rarm'].map((p) => this.animator.current(p)).join(' / ')}`,
      `pos     ${this.pos.toArray().map((v) => v.toFixed(1)).join(' ')}`,
    ].join('\n');
  }
}
