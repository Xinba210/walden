// Headless: arm, attack the monster until a hit lands, screenshot the blood slash; also a monster-hits-player check.
import puppeteer from 'puppeteer-core';
const out = process.argv[2] ?? '/tmp/hit';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 900000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 1100, height: 650 } });
const tab = await browser.newPage();
const logs = []; tab.on('pageerror', (e) => logs.push('[pageerror] ' + e.message)); tab.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 300)); });
await tab.goto('http://127.0.0.1:5299/?model=ninja', { waitUntil: 'domcontentloaded' });
await tab.waitForFunction(() => window.__game?.monster && window.__step, { timeout: 600000, polling: 1000 });
const r = await tab.evaluate(() => {
  document.getElementById('overlay').style.display = 'none'; document.getElementById('hud').style.display = 'none';
  const g = window.__game, S = window.__step, m = g.monster, p = g.player;
  const k = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, key: c, bubbles: true }));
  const click = () => { g.renderer.domElement.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })); window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true })); };
  S.pause(true);
  m.state = 'roam'; m.wait = 99; m.cool = 99;                         // hold it still for the shot
  p.pos.set(m.object.position.x, 0, m.object.position.z + 2.4); p.pos.y = g.world.ground(p.pos.x, p.pos.z);
  k('keydown', 'KeyE'); S.step(0.05, 60, false); k('keyup', 'KeyE'); S.step(3, 60, false);
  m.state = 'roam'; m.wait = 99; m.cool = 99;
  const hp0 = m.hp; let f = 0;
  for (; f < 240 && m.hp === hp0; f++) { p.yaw = Math.atan2(m.object.position.x - p.pos.x, m.object.position.z - p.pos.z); if (f % 12 === 0) click(); m.wait = 99; m.state = m.state === 'chase' ? 'roam' : m.state; S.step(1 / 60, 60, false); }
  S.step(0.05, 60, false);
  g.tpc.lockYaw = Math.PI + 0.6; g.tpc.targetDistance = 6; g.tpc.distance = 6; g.tpc.pitch = 0.15;
  S.step(1 / 60);
  const dec = g.player.fx.items.map((it) => { const w = new it.mesh.position.constructor(); it.mesh.getWorldPosition(w); return { parent: it.mesh.parent?.name, y: +w.y.toFixed(2), dMon: +Math.hypot(w.x - m.object.position.x, w.z - m.object.position.z).toFixed(2) }; });
  return { framesToHit: f, monsterHp: [hp0, m.hp], decals: dec, pState: p.state };
});
await tab.screenshot({ path: `${out}_blood.png` });
const r2 = await tab.evaluate(() => {
  const g = window.__game, S = window.__step, m = g.monster, p = g.player;
  m.state = 'chase'; m.cool = 0; m.wait = 0;
  const hp0 = p.hp; let f = 0;
  for (; f < 600 && p.hp === hp0; f++) S.step(1 / 60, 60, false);
  return { framesToBeHit: f, playerHp: [hp0, p.hp], pState: p.state };
});
console.log(JSON.stringify(r), JSON.stringify(r2));
console.log(logs.slice(0, 10).join('\n') || 'no page errors');
await browser.close();
