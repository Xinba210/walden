// Headless screenshots of the actual game world from fixed cameras.
//   node scripts/gameshot.mjs <outDir> '<json views>' [width height] [query]
// view: {name, pos:[x,y,z], look:[x,y,z], fov?}; y may be null for "1.7 m above the ground" at pos.
// Uses window.__step.view() (pauses the game loop, renders one composited frame).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const [out = '/tmp/gameshots', viewsJson = '[]', W = '1280', H = '720', query = ''] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const views = JSON.parse(viewsJson);
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 900000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: +W, height: +H },
});
const tab = await browser.newPage();
const logs = [];
tab.on('console', (m) => { if (['error', 'warning'].includes(m.type()) || /built/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); });
tab.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await tab.goto(`http://127.0.0.1:5299/${query}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await tab.waitForFunction(() => window.__game && window.__step?.view, { timeout: 600000, polling: 1000 });
await tab.evaluate(() => { document.querySelectorAll('body > div').forEach((d) => { if (d.id !== 'app') d.style.display = 'none'; }); });
console.log(`loaded in ${Date.now() - t0} ms`);
for (const v of views) {
  const t1 = Date.now();
  await tab.evaluate((view) => {
    const g = window.__game;
    const pos = view.pos.slice();
    if (pos[1] == null) pos[1] = g.world.ground(pos[0], pos[2]) + 1.7;
    // warm-up frames so LOD / texture streaming settle
    for (let i = 0; i < 3; i++) window.__step.view({ ...view, pos });
  }, v);
  await tab.screenshot({ path: `${out}/${v.name}.png` });
  console.log(`${v.name}.png (${Date.now() - t1} ms)`);
}
if (logs.length) console.log(logs.slice(0, 30).join('\n'));
await browser.close();
