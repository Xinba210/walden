import * as THREE from 'three';

/**
 * Layered animator. The skeleton is split into partitions (lower body, torso + left arm, right arm);
 * each partition crossfades independently between filtered copies of the clips, with weights
 * normalised so the bind pose never leaks in. Full-body one-shots are played on all partitions with
 * identical timing so they stay in sync.
 */
const LOWER = /^(mixamorigHips|mixamorig(Left|Right)(UpLeg|Leg|Foot|ToeBase|Toe_End))$/;
const RARM = /^mixamorigRight(Shoulder|Arm|ForeArm|Hand)/;
export const PARTS = ['lower', 'torso', 'rarm'];
export const ALL = PARTS;

function partOf(boneName) {
  if (/^cloth_/.test(boneName)) return 'torso';
  if (LOWER.test(boneName)) return 'lower';
  if (RARM.test(boneName)) return 'rarm';
  return 'torso';
}

class Layer {
  constructor(mixer, clips) {
    this.mixer = mixer;
    this.clips = clips;
    this.entries = new Map();
    this.current = null;
  }

  entry(name) {
    let e = this.entries.get(name);
    if (!e) {
      const action = this.mixer.clipAction(this.clips[name]);
      action.enabled = true;
      action.setEffectiveWeight(0);
      e = { name, action, weight: 0, target: 0, rate: 1 };
      this.entries.set(name, e);
    }
    return e;
  }

  play(name, { fade = 0.25, loop = true, timeScale = 1, restart = false, startAt = 0 } = {}) {
    const e = this.entry(name);
    const a = e.action;
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = !loop;
    a.timeScale = timeScale;
    if (this.current !== e || restart) {
      if (restart || e.weight <= 0.001 || !a.isRunning()) {
        a.reset();
        a.time = startAt;
        a.play();
      }
      for (const o of this.entries.values()) {
        o.target = o === e ? 1 : 0;
        o.rate = fade > 0 ? 1 / fade : 1e6;
      }
      this.current = e;
    }
    return a;
  }

  update(dt) {
    let sum = 0;
    for (const e of this.entries.values()) {
      const d = e.target - e.weight;
      const step = e.rate * dt;
      e.weight = Math.abs(d) <= step ? e.target : e.weight + Math.sign(d) * step;
      sum += e.weight;
    }
    for (const e of this.entries.values()) {
      const w = sum > 0 ? e.weight / sum : 0;
      e.action.setEffectiveWeight(w);
      if (e.weight === 0 && e.target === 0 && e.action.isRunning()) e.action.stop();
    }
  }
}

export class Animator {
  constructor(root, gltfClips) {
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = {};
    this.layers = {};
    const perPart = { lower: {}, torso: {}, rarm: {} };
    for (const clip of gltfClips) {
      const tracks = clip.tracks.filter((t) => !/^(Coat_|Scarf_|cloth)/.test(t.name));
      this.clips[clip.name] = new THREE.AnimationClip(clip.name, clip.duration, tracks);
      for (const p of PARTS) {
        const sub = tracks.filter((t) => partOf(t.name.split('.')[0]) === p);
        perPart[p][clip.name] = new THREE.AnimationClip(`${clip.name}__${p}`, clip.duration, sub);
      }
    }
    for (const p of PARTS) this.layers[p] = new Layer(this.mixer, perPart[p]);
  }

  duration(name) { return this.clips[name].duration; }

  play(name, opts = {}, parts = ALL) {
    if (opts.loop !== false && !opts.restart) {
      const ref = PARTS.map((p) => this.layers[p].entries.get(name)).find((e) => e && e.weight > 0 && e.action.isRunning());
      if (ref) opts = { ...opts, startAt: ref.action.time };
    }
    let action;
    for (const p of parts) action = this.layers[p].play(name, opts);
    return action;
  }

  /** Action of `name` on a partition (used to read playback time). */
  action(name, part = 'torso') { return this.layers[part].entry(name).action; }

  current(part = 'torso') { return this.layers[part].current?.name; }

  setTimeScale(name, ts, parts = ALL) {
    for (const p of parts) {
      const e = this.layers[p].entries.get(name);
      if (e) e.action.timeScale = ts;
    }
  }

  update(dt) {
    for (const p of PARTS) this.layers[p].update(dt);
    this.mixer.update(dt);
  }
}
