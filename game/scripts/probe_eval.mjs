// Evaluate a JS expression in the loaded game (headless): node scripts/probe_eval.mjs "<expr>"
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', protocolTimeout: 600000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const tab = await browser.newPage();
const logs = []; tab.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`)); tab.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
await tab.goto('http://127.0.0.1:5299/', { waitUntil: 'domcontentloaded' });
await tab.waitForFunction(() => window.__game?.world?.props, { timeout: 600000, polling: 1000 });
const r = await tab.evaluate(process.argv[2]);
console.log(JSON.stringify(r, null, 1));
console.log(logs.filter((l) => /error|warn/i.test(l)).slice(0, 10).join('\n'));
await browser.close();
