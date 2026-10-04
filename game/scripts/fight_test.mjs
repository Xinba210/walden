// Headless fight test: approach the monster, let it attack, fight back. Logs states / HP, saves a few screenshots.
import puppeteer from 'puppeteer-core';
const out = process.argv[2] ?? '/tmp/fight';
import fs from 'node:fs'; fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 900000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 1000, height: 600 } });
const tab = await browser.newPage();
const logs = []; tab.on('pageerror', (e) => logs.push('[pageerror] ' + e.message)); tab.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
await tab.goto('http://127.0.0.1:5299/?model=ninja', { waitUntil: 'domcontentloaded' });
await tab.waitForFunction(() => window.__game?.monster && window.__step, { timeout: 600000, polling: 1000 });
await tab.evaluate(() => { document.getElementById('overlay').style.display = 'none'; document.getElementById('hud').style.display = 'none'; });
const shot = async (name) => { await tab.screenshot({ path: `${out}/${name}.png` }); };
const run = (code) => tab.evaluate(code);
const trace = await run(async () => {
  const g = window.__game, S = window.__step, m = g.monster, p = g.player;
  const k = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, key: c, bubbles: true }));
  const click = () => { g.renderer.domElement.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })); window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true })); };
  S.pause(true);
  const log = [];
  const rec = (tag) => log.push(`${tag} t=${g.player.time.toFixed(1)} p:${p.state} hp${p.hp.toFixed(0)} | m:${m.state} hp${m.hp.toFixed(0)} d=${Math.hypot(p.pos.x - m.object.position.x, p.pos.z - m.object.position.z).toFixed(2)}`);
  // start 20 m from the monster's home, summon the sword
  p.pos.set(m.home.x, 0, m.home.z + 20); p.pos.y = g.world.ground(p.pos.x, p.pos.z);
  m.object.position.copy(m.home); m.state = 'roam'; m.wait = 5;
  k('keydown', 'KeyE'); S.step(0.05, 60, false); k('keyup', 'KeyE'); S.step(2.5, 60, false); rec('armed');
  // walk towards it until it notices
  for (let i = 0; i < 300 && m.state === 'roam'; i++) {
    p.yaw = Math.atan2(m.object.position.x - p.pos.x, m.object.position.z - p.pos.z);
    g.tpc.yaw = p.yaw + Math.PI; k('keydown', 'KeyW'); S.step(1 / 30, 30, false);
  }
  k('keyup', 'KeyW'); rec('noticed');
  // wait for it to come and attack
  let minD = 99, hitTaken = false;
  for (let i = 0; i < 600 && !hitTaken; i++) {
    const hp0 = p.hp; S.step(1 / 30, 30, false);
    minD = Math.min(minD, Math.hypot(p.pos.x - m.object.position.x, p.pos.z - m.object.position.z));
    if (p.hp < hp0) { hitTaken = true; rec('player hit'); }
  }
  log.push('closest centre distance ' + minD.toFixed(2) + ' (no overlap if >= ' + (1.25 + 0.33).toFixed(2) + ')');
  S.step(1.2, 30, false);
  // dodge test: roll as an attack winds up
  let dodged = false;
  for (let i = 0; i < 600 && !dodged; i++) {
    if (m.state === 'attack' && m.current.time > m.atk.window[0] - 0.25 && m.current.time < m.atk.window[0]) {
      const hp0 = p.hp; k('keydown', 'KeyC'); S.step(1 / 60, 60, false); k('keyup', 'KeyC');
      S.step(0.6, 60, false); dodged = true; rec(p.hp === hp0 ? 'dodge OK (no damage)' : 'dodge FAILED');
    } else S.step(1 / 30, 30, false);
  }
  // fight back until it dies
  let swings = 0;
  for (let i = 0; i < 2400 && m.alive && p.alive; i++) {
    const d = Math.hypot(p.pos.x - m.object.position.x, p.pos.z - m.object.position.z);
    p.yaw = Math.atan2(m.object.position.x - p.pos.x, m.object.position.z - p.pos.z);
    if (d > 2.0) { k('keydown', 'KeyW'); S.step(1 / 30, 30, false); k('keyup', 'KeyW'); }
    else { if (i % 8 === 0) { click(); swings++; } S.step(1 / 30, 30, false); }
    if (p.hp < 40) p.hp = 100;     // test focus is the monster's death, keep the player alive
  }
  rec(`after ${swings} swings`);
  if (!m.alive) { S.step(1.0, 30, false); rec('dying'); }
  return log;
});
console.log(trace.join('\n'));
await run(() => { const g = window.__game; g.tpc.lockYaw = 0.6; g.tpc.targetDistance = 5; window.__step.step(0.3); });
await shot('dying');
await run(() => { window.__step.step(2.0, 30, false); window.__step.step(0.02); });
await shot('dissolve');
const end = await run(() => ({ visible: window.__game.monster.object.visible, dissolve: window.__game.monster.dissolve.value, state: window.__game.monster.state }));
console.log(JSON.stringify(end));
console.log(logs.slice(0, 10).join('\n'));
await browser.close();
