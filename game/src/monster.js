import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Forest monster: roams a patch of meadow ahead of the spawn; when the player comes close it notices her, walks over
 * (slowly) and attacks with its arms (claw swipe / hook / smash; strike windows from monsterMeta.attacks, measured on
 * the fastest hand). It takes hits from the katana, staggers on heavy ones and, when killed, collapses and dissolves
 * away like the summoned sword (noisy reveal edge running from the feet up). Bodies never overlap (capsule push-out).
 *
 * Interface used by Player: list (hit targets with root/radius/height), colliders, hit(target, dir, power).
 */
const HP = 260;
const RADIUS = 1.25;            // body capsule radius (m) - the wraith is 4.6 m tall
const WALK = 1.7;               // m/s: long strides, still slower than the player's walk
const NOTICE = 18, GIVE_UP = 32, REACH = 3.7;
const ATTACKS = [               // clip, damage, reach (m), cooldown after (s), weight
  { clip: 'AttackClaw', dmg: 16, reach: 4.4, rest: 1.3, w: 3 },
  { clip: 'AttackHook', dmg: 12, reach: 3.9, rest: 0.9, w: 2 },
];
const EDGE = new THREE.Color(1.0, 0.35, 0.18);

export class Monster {
  constructor(scene, gltf, meta, { home, roamRadius = 14, ground }) {
    this.scene = scene;
    this.meta = meta;
    this.ground = ground;
    this.home = home.clone();
    this.roamRadius = roamRadius;
    this.object = cloneSkinned(gltf.scene);
    this.object.position.copy(home);
    scene.add(this.object);
    this.mixer = new THREE.AnimationMixer(this.object);
    this.actions = {};
    this.blend = new Map();          // action -> eased weight state
    for (const c of gltf.animations) this.actions[c.name] = this.mixer.clipAction(c);
    // hit flinch as an ADDITIVE upper-body layer: hips / legs keep whatever they were doing (no snap to straight legs)
    const hitSrc = gltf.animations.find((c) => c.name === 'HitReact');
    if (hitSrc) {
      const upper = hitSrc.clone();
      upper.name = 'HitReactUpper';
      upper.tracks = upper.tracks.filter((t) => !/(Hips|UpLeg|Leg|Foot|Toe)[^.]*\./.test(t.name));
      THREE.AnimationUtils.makeClipAdditive(upper);
      this.flinch = this.mixer.clipAction(upper);
      this.flinch.blendMode = THREE.AdditiveAnimationBlendMode;
      this.flinch.setLoop(THREE.LoopOnce, 1);
      this.flinch.clampWhenFinished = true;
      this.flinchT = Infinity;
      this.flinchDur = upper.duration;
    }
    this.hp = HP;
    this.maxHp = HP;
    this.state = 'roam';
    this.yaw = Math.random() * Math.PI * 2;
    this.speed = 0;
    this.target = this.pickRoamTarget();
    this.wait = 1.5;
    this.cool = 0;
    this.flash = 0;
    this.dissolve = { value: 0 };   // 0 = solid, 1 = gone
    this.time = { value: 0 };
    this.flashU = { value: 0 };
    this.size = meta.height ?? 4.6;
    this.hands = {};
    this.object.traverse((o) => {
      if (o.isBone && /mixamorig(Left|Right)Hand$/.test(o.name)) this.hands[/Left/.test(o.name) ? 'Left' : 'Right'] = o;
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; this.patch(o.material); }
    });
    this.play('Idle');
    // what Player's hit tests read
    this.isMonster = true;
    // feet: the retargeted clips don't plant the scaled-up feet exactly; ground them from the toe bones every frame
    this.toes = [];
    this.object.traverse((o) => { if (o.isBone && /mixamorig(Left|Right)ToeBase$/.test(o.name)) this.toes.push(o); });
    this.object.updateMatrixWorld(true);
    this.toeRest = this.toes.length ? Math.min(...this.toes.map((b) => b.getWorldPosition(new THREE.Vector3()).y)) - home.y : 0;
    this.footOffset = 0;
    // a sparse sample of skin vertices: where a blade hit lands on the actual body (blood decals sit on the skin)
    this.skin = null;
    this.object.traverse((o) => { if (o.isSkinnedMesh && (!this.skin || o.geometry.attributes.position.count > this.skin.geometry.attributes.position.count)) this.skin = o; });
    if (this.skin) {
      const n = this.skin.geometry.attributes.position.count, step = Math.max(1, Math.floor(n / 900));
      this.skinIdx = [];
      for (let i = 0; i < n; i += step) this.skinIdx.push(i);
    }
    this.list = [this];
    this.root = this.object;
    this.radius = RADIUS;
    this.height = [0.2, this.size * 0.95];              // vertical hit range for the katana tests
  }

  get alive() { return this.hp > 0; }

  /** circle collider for the player (and the monster pushes the player out itself, see separate()) */
  get colliders() { return this.alive ? [{ x: this.object.position.x, z: this.object.position.z, r: RADIUS }] : []; }

  patch(material) {
    const D = this.dissolve, T = this.time, F = this.flashU;
    material.onBeforeCompile = (sh) => {
      sh.uniforms.uDissolve = D; sh.uniforms.uTime = T; sh.uniforms.uHitFlash = F;
      sh.uniforms.uEdge = { value: EDGE };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vDisPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDisPos = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vDisPos; uniform float uDissolve; uniform float uTime; uniform vec3 uEdge; uniform float uHitFlash;
          float mh3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
          float mn3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(mix(mh3(i),mh3(i+vec3(1,0,0)),f.x),mix(mh3(i+vec3(0,1,0)),mh3(i+vec3(1,1,0)),f.x),f.y),
                       mix(mix(mh3(i+vec3(0,0,1)),mh3(i+vec3(1,0,1)),f.x),mix(mh3(i+vec3(0,1,1)),mh3(i+vec3(1,1,1)),f.x),f.y),f.z); }`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          // dissolve like the summoned katana: a noisy edge sweeps through the body, fragments past it vanish
          float dn = mn3(vDisPos * 18.0 + uTime * 0.5) * 0.25;
          float dpos = clamp(vDisPos.y / ${(this.size).toFixed(2)}, 0.0, 1.0);
          float dEdge = 0.0;
          if (uDissolve > 0.0) {
            float lvl = uDissolve * 1.3 - (1.0 - dpos) * 0.3 - dn;   // burns from the top down
            if (lvl > dpos) discard;
            dEdge = 1.0 - smoothstep(0.0, 0.06, dpos - lvl);
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += uEdge * dEdge * 8.0;`);
    };
    material.customProgramCacheKey = () => 'forest-monster';
    material.needsUpdate = true;
  }

  /**
   * Switch animation with an eased blend: every action has a weight that moves towards its target over `fade`
   * seconds; the applied weights are smoothstep-eased and normalised (no bind-pose dip, no pops). Re-playing the
   * current loop only eases its speed; re-playing the current one-shot restarts it under a short blend.
   */
  play(name, { fade = 0.35, loop = true, timeScale = 1 } = {}) {
    const a = this.actions[name];
    if (!a) return a;
    const e = this.blend.get(a) ?? { w: 0, from: 0, t: 1, dur: 0, target: 0 };
    this.blend.set(a, e);
    if (this.current === a && loop) { e.ts = timeScale; return a; }
    if (this.current !== a || !loop) {
      if (e.w <= 0.001 || !loop || !a.isRunning()) { a.reset(); a.play(); }
      a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      a.clampWhenFinished = !loop;
      a.timeScale = timeScale;
      e.ts = timeScale;
      for (const [act, o] of this.blend) {
        o.from = o.w; o.target = act === a ? 1 : 0; o.t = 0; o.dur = Math.max(fade, 1e-3);
      }
      this.current = a;
    }
    return a;
  }

  updateBlend(dt) {
    let sum = 0;
    for (const [a, o] of this.blend) {
      o.t = Math.min(1, o.t + dt / o.dur);
      const k = o.t * o.t * (3 - 2 * o.t);                   // ease in-out
      o.w = o.from + (o.target - o.from) * k;
      if (o.ts !== undefined) a.timeScale += (o.ts - a.timeScale) * (1 - Math.exp(-6 * dt));
      sum += o.w;
    }
    for (const [a, o] of this.blend) {
      a.setEffectiveWeight(sum > 0 ? o.w / sum : 0);
      if (o.w <= 0.001 && o.target === 0 && a.isRunning()) a.stop();
    }
  }

  pickRoamTarget() {
    const a = Math.random() * Math.PI * 2, r = this.roamRadius * Math.sqrt(Math.random());
    return new THREE.Vector3(this.home.x + Math.cos(a) * r, 0, this.home.z + Math.sin(a) * r);
  }

  /**
   * Turn towards (x, z). The body only turns as fast as its feet carry it: the turn rate scales with the walk cycle
   * that is playing, and a big turn on the spot plays the walk in place (stepping round) - never a frozen slide.
   */
  turnTowards(x, z, dt, rate = 1.1) {
    const want = Math.atan2(x - this.object.position.x, z - this.object.position.z);
    let d = want - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const walking = this.current === this.actions.Walk;
    const r = walking ? rate : rate * 0.25;           // standing still: barely turns until it starts stepping
    this.yaw += THREE.MathUtils.clamp(d, -r * dt, r * dt);
    this.turnNeed = Math.abs(d);
    return Math.abs(d);
  }

  /**
   * The point on the body skin nearest to `p`, among vertices facing `from` (the attacker): {pos, normal, bone}.
   * Normal ~ outward from the body's vertical axis; bone = the vertex's dominant skin bone (to attach decals).
   */
  surfaceNear(p, from) {
    if (!this.skin) return null;
    const m = this.skin, SI = m.geometry.attributes.skinIndex, SW = m.geometry.attributes.skinWeight;
    const v = new THREE.Vector3(), best = new THREE.Vector3(), c = this.object.position;
    const toward = new THREE.Vector3(from.x - c.x, 0, from.z - c.z).normalize();
    let bd = Infinity, bi = -1;
    for (const i of this.skinIdx) {
      m.getVertexPosition(i, v);
      v.applyMatrix4(m.matrixWorld);
      const out = (v.x - c.x) * toward.x + (v.z - c.z) * toward.z;
      if (out < 0.05) continue;                                    // back side of the body
      const d = v.distanceToSquared(p);
      if (d < bd) { bd = d; bi = i; best.copy(v); }
    }
    if (bi < 0) return null;
    let k = 0;
    for (let j = 1; j < 4; j++) if (SW.getComponent(bi, j) > SW.getComponent(bi, k)) k = j;
    const bone = m.skeleton.bones[SI.getComponent(bi, k)];
    const normal = new THREE.Vector3(best.x - c.x, 0, best.z - c.z).normalize().lerp(toward, 0.5).normalize();
    return { pos: best, normal, bone };
  }

  /** katana hit from the player */
  hit(_target, dir, power = 1) {
    if (!this.alive) return;
    this.hp = Math.max(0, this.hp - 14 * power);
    this.flash = 1;
    this.object.position.addScaledVector(dir, 0.05 * power);   // heavy: barely moves
    if (this.hp <= 0) { this.die(); return; }
    // every hit: an upper-body flinch layered on top (legs untouched)
    if (this.flinch) { this.flinch.reset(); this.flinch.timeScale = 1.2; this.flinch.play(); this.flinchT = 0; }
    if (this.state !== 'attack' || power >= 1.4) {   // heavy hits interrupt attacks: it pauses, legs settle to idle
      this.state = 'stagger';
      this.stateT = 0;
      this.play('Idle', { fade: 0.5 });
      this.staggerDur = this.flinchDur ? this.flinchDur / 1.2 + 0.1 : 0.5;
    }
    if (this.state === 'roam') this.state = 'chase';
  }

  /** back to full health at its home (a fresh one appears a while after the last one burned away) */
  revive() {
    this.hp = this.maxHp;
    this.state = 'roam';
    this.gone = false;
    this.dissolve.value = 0;
    this.object.visible = true;
    this.object.position.copy(this.home);
    this.target = this.pickRoamTarget();
    this.wait = 1;
    this.current = null;
    this.mixer.stopAllAction();
    this.blend.clear();
    this.play('Idle', { fade: 0.001 });
  }

  die() {
    this.state = 'dead';
    this.stateT = 0;
    this.flinch?.stop(); this.flinchT = Infinity;
    this.play('Death', { fade: 0.3, loop: false });
    this.deathDur = this.actions.Death?.getClip().duration ?? 1.5;
  }

  /**
   * Plant the feet: the lowest toe should sit at its rest height above the terrain under it. The body is shifted by a
   * smoothed offset (fast down, a bit slower up so steps don't bob); skipped while lying dead.
   */
  groundFeet(dt) {
    if (!this.toes.length) return;
    if (this.state === 'dead') {     // lying down: keep the last offset (no snap), the death clip owns the pose
      this.object.position.y += this.footOffset;
      return;
    }
    this.object.updateMatrixWorld(true);
    let err = Infinity;
    const v = new THREE.Vector3();
    for (const b of this.toes) {
      b.getWorldPosition(v);
      err = Math.min(err, v.y - (this.ground(v.x, v.z) + this.toeRest));
    }
    if (!Number.isFinite(err)) return;
    const target = -err;                  // measured before this frame's offset is applied (pos.y = ground)
    const rate = target < this.footOffset ? 18 : 8;
    this.footOffset += (target - this.footOffset) * Math.min(1, dt * rate);
    this.footOffset = THREE.MathUtils.clamp(this.footOffset, -1.5, 0.5);
    this.object.position.y += this.footOffset;
    this.object.updateMatrixWorld(true);
  }

  /** keep the two capsules apart: the player is pushed out (the monster is heavy) */
  separate(player) {
    if (!this.alive) return;
    const p = player.pos, m = this.object.position;
    const dx = p.x - m.x, dz = p.z - m.z, d = Math.hypot(dx, dz), min = RADIUS + 0.38;
    if (d < min && d > 1e-4) { p.x = m.x + (dx / d) * min; p.z = m.z + (dz / d) * min; }
  }

  update(dt, player) {
    this.time.value += dt;
    this.flash = Math.max(0, this.flash - dt * 4);
    this.flashU.value = this.flash;
    this.cool = Math.max(0, this.cool - dt);
    this.stateT = (this.stateT ?? 0) + dt;
    const pos = this.object.position;
    const toP = new THREE.Vector3(player.pos.x - pos.x, 0, player.pos.z - pos.z);
    const dist = toP.length();
    this.lastDist = dist;
    let moveSpeed = 0;

    switch (this.state) {
      case 'roam': {
        if (player.alive !== false && dist < NOTICE) { this.state = 'chase'; break; }
        const td = Math.hypot(this.target.x - pos.x, this.target.z - pos.z);
        if (this.wait > 0) { this.wait -= dt; this.play('Idle', { fade: 0.6 }); break; }
        if (td < 1.0) { this.wait = 2 + Math.random() * 3; this.target = this.pickRoamTarget(); break; }
        this.turnTowards(this.target.x, this.target.z, dt, 1.2);
        moveSpeed = WALK * 0.7;
        this.play('Walk', { fade: 0.6, timeScale: 0.75 });
        break;
      }
      case 'chase': {
        if (player.alive === false || dist > GIVE_UP || Math.hypot(pos.x - this.home.x, pos.z - this.home.z) > this.roamRadius + 22) {
          this.state = 'roam'; this.target = this.home.clone(); break;
        }
        const off = this.turnTowards(player.pos.x, player.pos.z, dt);
        if (dist < REACH + 0.2 && this.cool <= 0 && off < 0.35) { this.startAttack(); break; }
        // gait choice with hysteresis (hold for >= 0.4 s) so it never flickers between walk and idle
        this.gaitT = (this.gaitT ?? 0) + dt;
        let gait = dist > REACH * (this.gait === 'walk' ? 0.8 : 0.95) ? 'walk' : off > (this.gait === 'step' ? 0.12 : 0.25) ? 'step' : 'idle';
        if (gait !== this.gait && this.gaitT < 0.4 && this.gait) gait = this.gait;
        if (gait !== this.gait) { this.gait = gait; this.gaitT = 0; }
        if (gait === 'walk') {
          // a sharp turn slows it down so it curves round on its feet instead of pivoting
          moveSpeed = WALK * THREE.MathUtils.clamp(1.2 - off, 0.25, 1);
          this.play('Walk', { fade: 0.45 });
        } else if (gait === 'step') {
          moveSpeed = 0.15;                                  // step round on the spot
          this.play('Walk', { fade: 0.45, timeScale: 0.7 });
        } else this.play('Idle', { fade: 0.5 });
        break;
      }
      case 'attack': {
        const atk = this.atk;
        const t = this.current.time;
        if (t < atk.window[0]) this.turnTowards(player.pos.x, player.pos.z, dt, 1.0);      // small tracking during wind-up
        if (!atk.swished && t >= atk.window[0]) { atk.swished = true; this.sfx?.monsterSwipe?.(dist); }   // peaks ~0.18 s later, as the arm lands
        if (!atk.done && t >= atk.window[0] && t <= atk.window[1]) this.tryHit(player);
        if (t >= atk.dur - 0.05) { this.state = 'chase'; this.cool = atk.def.rest; }
        break;
      }
      case 'stagger':
        if (this.stateT > this.staggerDur) this.state = 'chase';
        break;
      case 'dead': {
        // fall, then burn away like the summoned sword and leave
        if (this.stateT > this.deathDur * 0.75) this.dissolve.value = Math.min(1, (this.stateT - this.deathDur * 0.75) / 1.6);
        if (this.dissolve.value >= 1 && !this.gone) { this.gone = true; this.object.visible = false; this.goneT = 0; }
        if (this.gone && (this.goneT += dt) > 12) this.revive();
        break;
      }
    }
    if (moveSpeed > 0) {
      this.speed = THREE.MathUtils.lerp(this.speed, moveSpeed, 1 - Math.exp(-4 * dt));
    } else this.speed = THREE.MathUtils.lerp(this.speed, 0, 1 - Math.exp(-6 * dt));
    pos.x += Math.sin(this.yaw) * this.speed * dt;
    pos.z += Math.cos(this.yaw) * this.speed * dt;
    pos.y = this.ground(pos.x, pos.z);
    this.object.rotation.y = this.yaw;
    this.updateBlend(dt);
    if (this.flinch && this.flinchT < Infinity) {          // flinch envelope: quick in, eased out
      this.flinchT += dt;
      const d = this.flinchDur / 1.2, t = this.flinchT;
      const w = Math.min(1, t / 0.06) * (1 - THREE.MathUtils.smoothstep(t, d * 0.55, d));
      this.flinch.setEffectiveWeight(w);
      if (t >= d) { this.flinch.stop(); this.flinchT = Infinity; }
    }
    this.mixer.update(dt);
    this.groundFeet(dt);
    this.separate(player);
  }

  startAttack() {
    const total = ATTACKS.reduce((s, a) => s + a.w, 0);
    let r = Math.random() * total, def = ATTACKS[0];
    for (const a of ATTACKS) { if ((r -= a.w) <= 0) { def = a; break; } }
    const info = this.meta.attacks[def.clip];
    const a = this.play(def.clip, { fade: 0.3, loop: false, timeScale: 0.85 });
    if (!a) return;
    const ts = 0.85;
    this.atk = { def, done: false, dur: a.getClip().duration, window: [info.strike[0] - 0.04, info.strike[1] + 0.06], hand: info.hand, ts, swished: false };
    this.sfx?.monsterGrowl?.(this.lastDist ?? 5);
    this.state = 'attack';
    this.stateT = 0;
  }

  tryHit(player) {
    const hand = this.hands[this.atk.hand];
    const hp = new THREE.Vector3();
    hand.getWorldPosition(hp);
    const dx = player.pos.x - hp.x, dz = player.pos.z - hp.z;
    const handNear = Math.hypot(dx, dz) < 1.3 && hp.y > player.pos.y - 0.3 && hp.y < player.pos.y + 2.6;
    const front = Math.hypot(player.pos.x - this.object.position.x, player.pos.z - this.object.position.z) < this.atk.def.reach;
    if (!(handNear || front)) return;
    this.atk.done = true;
    const dir = new THREE.Vector3(player.pos.x - this.object.position.x, 0, player.pos.z - this.object.position.z).normalize();
    player.takeHit?.(this.atk.def.dmg, dir, hp);
  }
}
