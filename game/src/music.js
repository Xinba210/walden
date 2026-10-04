/**
 * Generative cinematic ambience (WebAudio, no files; nothing struck, no noise layers):
 *   - strings: an ensemble per chord tone (5 detuned saws spread +-14 cents, through a soft lowpass that opens with
 *     the swell) - low celli/violas holding the harmony, swelling in over ~4 s and releasing over ~5 s
 *   - choir: "ah" voices (saw through three vowel-formant band-passes) with slow vibrato, on the upper chord tones
 *   - horns: distant swells on a chord tone, brassier (filter opens) at the peak of each swell
 *   - sub: a deep sine swell under every chord change
 *   - high strings: thin harmonics on top, very soft
 *   - intensity: a slow ~2-minute arc (calm -> fuller -> calm) scales layers, brightness and level
 *   - everything through a long, dark hall reverb (filtered decaying impulse)
 * A look-ahead scheduler on the audio clock lays down the progression independent of the frame rate.
 */
const D3 = 146.83;
const hz = (semi) => D3 * Math.pow(2, semi / 12);
// D minor, i - VI - III - VII - iv - VI - VII - V: (bass, ensemble voicing, choir tones) in semitones from D3
const PROG = [
  { bass: -12, strings: [-5, 0, 3, 7], choir: [12, 15] },        // Dm
  { bass: -16, strings: [-4, 2, 5, 10], choir: [14, 17] },       // Bb
  { bass: -21, strings: [-9, 3, 7, 12], choir: [15, 19] },       // F
  { bass: -14, strings: [-2, 2, 7, 10], choir: [14, 19] },       // C
  { bass: -19, strings: [-7, 1, 5, 8], choir: [12, 17] },        // Gm
  { bass: -16, strings: [-4, 2, 5, 10], choir: [14, 17] },       // Bb
  { bass: -14, strings: [-2, 2, 7, 10], choir: [14, 19] },       // C
  { bass: -17, strings: [-5, 1, 4, 7], choir: [13, 16] },        // A (dominant, back to Dm)
];
const CHORD = 10;          // seconds per chord
const ARC = 120;           // seconds per intensity arc

export class Music {
  constructor(ctx, out, { volume = 0.23 } = {}) {   // a bed under the footsteps
    this.ctx = ctx;
    this.volume = volume;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(out);
    const dry = ctx.createGain(); dry.gain.value = 0.4; dry.connect(this.master);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(7);
    const wet = ctx.createGain(); wet.gain.value = 0.85;
    this.reverb.connect(wet).connect(this.master);
    // gentle overall tone shaping: no harsh top end
    this.tone = ctx.createBiquadFilter(); this.tone.type = 'lowpass'; this.tone.frequency.value = 5200; this.tone.Q.value = 0.3;
    this.bus = ctx.createGain();
    this.bus.connect(this.tone);
    this.tone.connect(dry); this.tone.connect(this.reverb);
    this.on = false;
    this.next = 0;
    this.step = 0;
    this.t0 = 0;
  }

  impulse(sec) {
    const c = this.ctx, n = Math.floor(c.sampleRate * sec), b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        lp += ((Math.random() * 2 - 1) - lp) * 0.1;
        d[i] = lp * Math.pow(1 - i / n, 2.2) * Math.min(1, i / (c.sampleRate * 0.04));   // soft onset, dark tail
      }
    }
    return b;
  }

  /** intensity 0..1 over a slow arc */
  intensity(t) { return 0.5 - 0.5 * Math.cos(((t - this.t0) / ARC) * Math.PI * 2); }

  init(t) {
    this.t0 = t;
    this.next = t + 0.3;
  }

  start() {
    if (this.on) return;
    this.on = true;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(0, t);
    this.master.gain.linearRampToValueAtTime(this.volume, t + 8);
    this.init(t);
    this.timer = setInterval(() => this.schedule(), 500);
  }

  toggle() {
    const t = this.ctx.currentTime;
    this.muted = !this.muted;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(this.muted ? 0 : this.volume, t + 1.5);
  }

  /** string ensemble note: detuned saws, swell + filter opening, long release */
  strings(freq, t, len, amp, bright, pan) {
    const c = this.ctx, rel = 5;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5;
    lp.frequency.setValueAtTime(350, t);
    lp.frequency.linearRampToValueAtTime(700 + 1500 * bright, t + len * 0.5);
    lp.frequency.linearRampToValueAtTime(400, t + len + rel);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + 3.5 + Math.random());
    g.gain.setValueAtTime(amp, t + len);
    g.gain.linearRampToValueAtTime(0.0001, t + len + rel);
    const p = c.createStereoPanner(); p.pan.value = pan;
    lp.connect(g).connect(p).connect(this.bus);
    for (let k = 0; k < 5; k++) {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq;
      o.detune.value = (k - 2) * 7 + (Math.random() - 0.5) * 4;
      const og = c.createGain(); og.gain.value = 0.2;
      o.connect(og).connect(lp);
      o.start(t); o.stop(t + len + rel + 0.1);
    }
  }

  /** choir "ah": saw through three vowel formants, slow vibrato, slow swell */
  choir(freq, t, len, amp, pan) {
    const c = this.ctx, rel = 4;
    const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq;
    const vib = c.createOscillator(); vib.frequency.value = 4.8 + Math.random() * 0.6;
    const vg = c.createGain(); vg.gain.value = freq * 0.006;
    vib.connect(vg).connect(o.frequency);
    const mix = c.createGain();
    for (const [f, q, a] of [[730, 8, 1.0], [1090, 9, 0.5], [2440, 10, 0.18]]) {
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const bg = c.createGain(); bg.gain.value = a;
      o.connect(bp).connect(bg).connect(mix);
    }
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + len * 0.45);
    g.gain.linearRampToValueAtTime(0.0001, t + len + rel);
    const p = c.createStereoPanner(); p.pan.value = pan;
    mix.connect(g).connect(p).connect(this.bus);
    for (const s of [o, vib]) { s.start(t); s.stop(t + len + rel + 0.1); }
  }

  /** distant horn swell: brassier at its peak */
  horn(freq, t, len, amp) {
    const c = this.ctx;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.linearRampToValueAtTime(1300, t + len * 0.55);
    lp.frequency.linearRampToValueAtTime(300, t + len);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + len * 0.55);
    g.gain.linearRampToValueAtTime(0.0001, t + len);
    lp.connect(g).connect(this.bus);
    for (const [type, det, a] of [['sawtooth', -4, 0.5], ['sawtooth', 4, 0.5], ['triangle', 0, 0.6]]) {
      const o = c.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = det;
      const og = c.createGain(); og.gain.value = a;
      o.connect(og).connect(lp);
      o.start(t); o.stop(t + len + 0.1);
    }
  }

  /** deep sine swell under a chord change */
  sub(freq, t, len, amp) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + 2.5);
    g.gain.linearRampToValueAtTime(0.0001, t + len + 3);
    o.connect(g).connect(this.bus);
    o.start(t); o.stop(t + len + 3.1);
  }

  /** thin high string harmonic */
  high(freq, t, len, amp) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    const vib = c.createOscillator(); vib.frequency.value = 5.2;
    const vg = c.createGain(); vg.gain.value = freq * 0.003;
    vib.connect(vg).connect(o.frequency);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + len * 0.5);
    g.gain.linearRampToValueAtTime(0.0001, t + len);
    const p = c.createStereoPanner(); p.pan.value = (Math.random() - 0.5) * 1.4;
    o.connect(g).connect(p).connect(this.bus);
    for (const s of [o, vib]) { s.start(t); s.stop(t + len + 0.1); }
  }

  schedule(horizon = 2) {
    const c = this.ctx;
    while (this.next < c.currentTime + horizon) {
      const t = this.next, ch = PROG[this.step % PROG.length], I = this.intensity(t);
      // strings: always (the bed); fuller and brighter with intensity
      this.strings(hz(ch.bass), t, CHORD, 0.05, I * 0.5, 0);
      ch.strings.forEach((s, i) => this.strings(hz(s), t + i * 0.25, CHORD, 0.028 + 0.012 * I, I, ((i / (ch.strings.length - 1)) - 0.5) * 1.0));
      this.sub(hz(ch.bass - 12), t, CHORD, 0.06 + 0.05 * I);
      // choir enters as the arc rises
      if (I > 0.3) ch.choir.forEach((s, i) => this.choir(hz(s), t + 0.8 + i * 0.6, CHORD, 0.012 * I, i ? 0.35 : -0.35));
      // a distant horn swell on some chords near the top of the arc
      if (I > 0.55 && this.step % 2 === 0) this.horn(hz(ch.strings[2]), t + 2, CHORD * 0.9, 0.018 * I);
      // high harmonics in the calm parts
      if (I < 0.6 && Math.random() < 0.6) this.high(hz(ch.choir[1] + 12), t + 3, CHORD * 0.8, 0.006);
      this.step++;
      this.next = t + CHORD;
    }
  }
}
