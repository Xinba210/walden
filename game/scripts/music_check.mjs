// Render the generative music offline (40 s) and report level + spectrum (headless; no speakers needed).
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 600000, args: ['--autoplay-policy=no-user-gesture-required'] });
const tab = await browser.newPage();
await tab.goto('http://127.0.0.1:5299/index.html', { waitUntil: 'domcontentloaded' });
const r = await tab.evaluate(async () => {
  const { Music } = await import('/src/music.js');
  const SR = 44100, T = Number(new URL(location.href).searchParams.get('T') ?? 0) || 130;
  const ctx = new OfflineAudioContext(2, SR * T, SR);
  const m = new Music(ctx, ctx.destination);
  m.on = true;
  m.master.gain.setValueAtTime(0, 0); m.master.gain.linearRampToValueAtTime(m.volume, 8);
  m.init(0); m.schedule(T - 1);
  const buf = await ctx.startRendering();
  const d = buf.getChannelData(0);
  let peak = 0, sum = 0;
  for (const v of d) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  // crude spectrum: energy above 2 kHz vs total, via first-difference filter (high-pass) ratio
  let hp = 0; for (let i = 1; i < d.length; i++) { const x = d[i] - d[i - 1]; hp += x * x; }
  const secs = []; for (let s = 0; s + 10 <= T; s += 10) { let e = 0, n = 0; for (let i = s * SR; i < (s + 10) * SR; i++) { e += d[i] * d[i]; n++; } secs.push(+Math.sqrt(e / n).toFixed(4)); }
  return { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / d.length).toFixed(4), highFreqRatio: +(hp / Math.max(sum, 1e-9)).toFixed(4), rmsPer10s: secs };
});
console.log(JSON.stringify(r));
await browser.close();
