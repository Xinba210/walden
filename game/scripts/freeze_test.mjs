import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 300000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 640, height: 400 } });
const tab = await browser.newPage();
const logs = []; tab.on('pageerror', (e) => logs.push('[pageerror] ' + e.message)); tab.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') logs.push(m.text().slice(0, 200)); });
await tab.goto('http://127.0.0.1:5299/?model=ninja', { waitUntil: 'domcontentloaded' });
await tab.waitForFunction(() => window.__game?.monster && window.__step, { timeout: 600000, polling: 1000 });
const r = await tab.evaluate(async () => {
  const g = window.__game, S = window.__step, m = g.monster, p = g.player;
  const k = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, key: c, bubbles: true }));
  const click = (b = 0) => { g.renderer.domElement.dispatchEvent(new MouseEvent('mousedown', { button: b, bubbles: true })); window.dispatchEvent(new MouseEvent('mouseup', { button: b, bubbles: true })); };
  S.pause(true);
  p.pos.set(m.object.position.x, 0, m.object.position.z + 4); p.pos.y = g.world.ground(p.pos.x, p.pos.z);
  k('keydown', 'KeyE'); S.step(0.05, 60, false); k('keyup', 'KeyE'); S.step(3, 60, false);
  const log = [], slow = [];
  const progs = () => g.renderer.info.programs.length;
  let pc = progs(); log.push('programs at start ' + pc);
  let lastState = '';
  for (let f = 0; f < 60 * 12; f++) {
    p.yaw = Math.atan2(m.object.position.x - p.pos.x, m.object.position.z - p.pos.z);
    if (f % 9 === 0) click(f % 90 === 0 ? 2 : 0);
    const t0 = performance.now();
    try { S.step(1 / 60, 60, true); } catch (e) { log.push('EXC ' + e.message + ' ' + e.stack.split('\n').slice(1, 4).join(' | ')); break; }
    const dtms = performance.now() - t0;
    if (dtms > 400) slow.push([f, Math.round(dtms), p.state, m.state]);
    if (progs() !== pc) { log.push(`f${f} NEW PROGRAMS ${pc}->${progs()} (${Math.round(dtms)} ms) p:${p.state} m:${m.state}`); pc = progs(); }
    const st = `${p.state}/${m.state}`;
    if (st !== lastState) { log.push(`f${f} ${st} php${p.hp.toFixed(0)} mhp${m.hp.toFixed(0)}`); lastState = st; }
    if (p.hp < 30) p.hp = 100;
  }
  return { log: log.slice(0, 60), slow: slow.slice(0, 20), final: [p.state, m.state, p.hp, m.hp] };
});
console.log(JSON.stringify(r, null, 0).replace(/","/g, '"\n"'));
console.log(logs.slice(0, 15).join('\n'));
await browser.close();
