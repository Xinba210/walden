// Headless screenshots of a world2 test page.
//   node scripts/w2shot.mjs <page.html> <outDir> '<json views>' [width height]
// The page must set window.__ready = true when loaded and provide window.__view(view) which positions the camera
// (view = {pos:[x,y,z], look:[x,y,z], t?:seconds, ...anything the page understands}) and renders one frame.
// Each view: {name, pos, look, ...}. Writes <outDir>/<name>.png and prints console errors.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const [page = 'w2-terrain.html', out = '/tmp/w2shots', viewsJson = '[]', W = '1280', H = '720'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const views = JSON.parse(viewsJson);
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: +W, height: +H },
  protocolTimeout: 600000,
});
const tab = await browser.newPage();
const logs = [];
tab.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || /READY|ms/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); });
tab.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await tab.goto(`http://127.0.0.1:5299/${page}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
try {
  await tab.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 500 });
} catch (e) {
  await tab.screenshot({ path: `${out}/timeout.png` });
  console.log('TIMEOUT waiting for __ready\n' + logs.join('\n'));
  await browser.close();
  process.exit(1);
}
console.log(`loaded in ${Date.now() - t0} ms`);
for (const v of views) {
  const t1 = Date.now();
  await tab.evaluate(async (view) => { await window.__view(view); }, v);
  await tab.screenshot({ path: `${out}/${v.name}.png` });
  console.log(`${v.name}.png (${Date.now() - t1} ms)`);
}
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
