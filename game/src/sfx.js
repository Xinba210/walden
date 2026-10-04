/** Tiny procedural WebAudio sound kit (no asset files). */
export class Sfx {
  constructor() {
    this.ctx = null;
  }

  start() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 1.5;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  env(g, t, a, peak, dec) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
  }

  noiseBurst({ f0, f1, q = 1.5, dur = 0.25, peak = 0.6, type = 'bandpass', attack = 0.02 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    this.env(g, t, attack, peak, dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + attack + 0.05);
  }

  /**
   * A symmetric swell (rises and falls like a breath, never struck): optional pitched sine plus airy low-passed noise.
   * `freqs` = sine partials (Hz, may be empty), `air` = noise level, glide from `fromK` x the pitch.
   */
  swell({ freqs = [], peak = 0.01, air = 0.02, dur = 0.8, airFrom = 300, airTo = 1200, fromK = 1, delay = 0 }) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + delay, mid = t + dur * 0.45, end = t + dur;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, mid);
    g.gain.linearRampToValueAtTime(0, end);
    g.connect(this.master);
    for (const f of freqs) {
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f * fromK, t);
      o.frequency.linearRampToValueAtTime(f, end);
      const og = c.createGain(); og.gain.value = peak;
      o.connect(og).connect(g);
      o.start(t); o.stop(end + 0.05);
    }
    if (air > 0) {
      const src = c.createBufferSource(); src.buffer = this.noise;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.4;
      lp.frequency.setValueAtTime(airFrom, t);
      lp.frequency.linearRampToValueAtTime(airTo, mid);
      lp.frequency.linearRampToValueAtTime(Math.min(airFrom, airTo), end);     // rising breath falls back; falling one keeps falling
      const ag = c.createGain(); ag.gain.value = air;
      src.connect(lp).connect(ag).connect(g);
      src.start(t, Math.random()); src.stop(end + 0.05);
    }
  }

  tone({ f0, f1, dur = 0.3, peak = 0.2, type = 'sine', attack = 0.01, delay = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    this.env(g, t, attack, peak, dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + attack + dur + 0.05);
  }

  swoosh(power = 1) {
    this.noiseBurst({ f0: 400 + 200 * power, f1: 2200 + 600 * power, q: 0.9, dur: 0.2 + 0.06 * power, peak: 0.045 + 0.02 * power, attack: 0.03 });
  }

  /** generative background music (see music.js); M toggles it */
  startMusic(Music) {
    if (!this.ctx || this.music) return;
    this.music = new Music(this.ctx, this.ctx.destination);
    this.music.start();
  }

  hit() {
    this.noiseBurst({ f0: 2500, f1: 600, q: 0.8, dur: 0.12, peak: 0.9, type: 'lowpass', attack: 0.002 });
    this.tone({ f0: 160, f1: 50, dur: 0.18, peak: 0.6, type: 'sine', attack: 0.002 });
    this.tone({ f0: 2600, f1: 2300, dur: 0.25, peak: 0.05, type: 'triangle', attack: 0.002 });
  }

  /** sword appearing: an airy rising breath with a faint shimmer inside it (no struck notes) */
  summonCharge() {
    this.swell({ freqs: [587.3, 880], peak: 0.006, air: 0.035, dur: 1.0, airFrom: 250, airTo: 1400, fromK: 0.97 });
  }

  /** (unused) sword fully formed */
  summonRing() {}

  /** sword leaving: a soft falling breath */
  dismiss() {
    this.swell({ freqs: [440], peak: 0.005, air: 0.03, dur: 0.75, airFrom: 1100, airTo: 300, fromK: 1.04 });
  }

  /** take-off: a soft cloth flick (low-passed, quiet) */
  jump() { this.noiseBurst({ f0: 350, f1: 1100, q: 0.5, dur: 0.16, peak: 0.035, type: 'lowpass', attack: 0.02 }); }
  /** landing: a soft dust scuff with a faint low body, no thump */
  land() {
    this.noiseBurst({ f0: 900, f1: 250, q: 0.5, dur: 0.18, peak: 0.05, type: 'lowpass', attack: 0.01 });
    this.tone({ f0: 90, f1: 60, dur: 0.12, peak: 0.03, attack: 0.01 });
  }
  /** roll: a short cloth-and-grass swish */
  roll() { this.noiseBurst({ f0: 300, f1: 800, q: 0.5, dur: 0.3, peak: 0.035, type: 'lowpass', attack: 0.05 }); }

  /** monster, winding up an attack: a low breathy huff (quieter with distance `d` m) */
  monsterGrowl(d = 5) {
    // a low, breathy huff: pure sines with a slow waver (no saw / low noise - those read as buzzing and tearing)
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, k = Math.max(0.15, Math.min(1, 6 / Math.max(d, 1)));
    const out = c.createGain(); out.connect(this.master);
    out.gain.setValueCurveAtTime(this.bell(0.028 * k, 0.35), t, 0.8);
    for (const [f, a] of [[68, 1], [136, 0.3]]) {           // octave only: closer partials beat into a buzz
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.86, t + 0.8);
      const g = c.createGain(); g.gain.value = a;
      o.connect(g).connect(out); o.start(t); o.stop(t + 0.85);
    }
  }
  /** smooth one-shot envelope (raised-cosine rise to `peak` at fraction `at`, cosine fall), for setValueCurveAtTime */
  bell(peak, at = 0.4, n = 64) {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      v[i] = peak * (x < at ? 0.5 - 0.5 * Math.cos(Math.PI * x / at) : 0.5 + 0.5 * Math.cos(Math.PI * (x - at) / (1 - at)));
    }
    return v;
  }
  /**
   * Monster arm swing: a smooth airy whoosh (wide-band noise kept ABOVE ~450 Hz, where its grain sounds like air rather
   * than ripping, swept up and down and panned across) over a soft sine "weight" that falls in pitch; peaks as the arm lands.
   */
  monsterSwipe(d = 5) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, k = Math.max(0.15, Math.min(1, 6 / Math.max(d, 1)));
    const dur = 0.6, peakAt = 0.32, peakT = t + dur * peakAt;
    const out = c.createGain(); out.connect(this.master);
    out.gain.setValueCurveAtTime(this.bell(0.04 * k, peakAt), t, dur);
    const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 450; hp.Q.value = 0.5;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.6;
    bp.frequency.setValueAtTime(650, t);
    bp.frequency.exponentialRampToValueAtTime(1700, peakT);
    bp.frequency.exponentialRampToValueAtTime(600, t + dur);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.4;   // no hiss on top
    const pan = c.createStereoPanner();
    pan.pan.setValueAtTime(-0.35, t); pan.pan.linearRampToValueAtTime(0.35, t + dur);
    src.connect(hp).connect(bp).connect(lp).connect(pan).connect(out);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
    const body = c.createGain(); body.connect(this.master);
    body.gain.setValueCurveAtTime(this.bell(0.03 * k, 0.45), t + 0.05, dur);
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t + 0.05); o.frequency.exponentialRampToValueAtTime(58, t + 0.05 + dur);
    o.connect(body); o.start(t + 0.05); o.stop(t + 0.1 + dur);
  }

  step(v = 1) { this.noiseBurst({ f0: 700, f1: 250, q: 0.8, dur: 0.06, peak: 0.08 * v, type: 'lowpass', attack: 0.003 }); }
}
