// Cold-boot network measurement: serves dist/ with `vite preview`, opens it in the preinstalled
// Playwright Chromium with an empty cache and counts requests and bytes (a) until the main menu is
// up (requests sent before the menu's DOM first appeared) and (b) after the page has idled a few
// seconds (background loads: fight sounds, the next boss).
// Usage: npm run build && node scripts/measure-boot.mjs [--port 4199] [--idle 6000] [--json]
import { preview } from 'vite';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const port = Number(opt('port', '4199'));
const idleMs = Number(opt('idle', '6000'));
const asJson = args.includes('--json');

const server = await preview({ preview: { port, strictPort: true }, logLevel: 'silent' });
// Never hang a CI job or an agent shell.
setTimeout(() => {
  console.error('measure-boot: timed out');
  process.exit(2);
}, 240000).unref();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const reqs = new Map();
  cdp.on('Network.requestWillBeSent', (e) => reqs.set(e.requestId, { url: e.request.url, at: e.wallTime * 1000, bytes: 0 }));
  // When the main menu first appears (page clock = wall clock): requests sent before it are boot.
  await page.addInitScript(() => {
    new MutationObserver((_, obs) => {
      if (!document.querySelector('#ui > .loading') && document.querySelector('.menu-screen')) {
        window.__menuAt = Date.now();
        obs.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.bytes = e.encodedDataLength;
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => !document.querySelector('#ui > .loading') && !!document.querySelector('.menu-screen'), null, { timeout: 120000 });
  const menuAt = await page.evaluate(() => window.__menuAt);
  const menuMs = menuAt - t0;
  await page.waitForTimeout(idleMs);
  for (const r of reqs.values()) r.phase = r.at <= menuAt ? 'boot' : 'idle';
  const summarize = (filter) => {
    const list = [...reqs.values()].filter(filter);
    return { requests: list.length, bytes: list.reduce((s, r) => s + r.bytes, 0) };
  };
  const kind = (u) => {
    const p = new URL(u).pathname;
    if (p.includes('/audio/')) return 'audio';
    if (/\.(glb|gltf)$/.test(p)) return 'model';
    if (/\.(png|jpe?g|webp|ktx2)$/.test(p)) return 'image';
    if (/\.js$/.test(p)) return 'js';
    if (/\.css$/.test(p)) return 'css';
    return 'other';
  };
  const byKind = (ph) => {
    const out = {};
    for (const r of reqs.values()) {
      if (ph && r.phase !== ph) continue;
      const k = kind(r.url);
      out[k] ??= { requests: 0, bytes: 0 };
      out[k].requests++;
      out[k].bytes += r.bytes;
    }
    return out;
  };
  const result = {
    menuMs,
    boot: summarize((r) => r.phase === 'boot'),
    bootByKind: byKind('boot'),
    total: summarize(() => true),
    totalByKind: byKind(null),
    idleExtra: [...reqs.values()].filter((r) => r.phase === 'idle').map((r) => `${new URL(r.url).pathname} ${r.bytes}`),
    bootFiles: [...reqs.values()].filter((r) => r.phase === 'boot').map((r) => `${new URL(r.url).pathname} ${r.bytes}`),
    errors,
  };
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;
    console.log(`menu up after ${menuMs} ms`);
    console.log(`boot (until menu): ${result.boot.requests} requests, ${mb(result.boot.bytes)}`);
    for (const [k, v] of Object.entries(result.bootByKind)) console.log(`  ${k}: ${v.requests} req, ${mb(v.bytes)}`);
    console.log(`after ${idleMs} ms idle: ${result.total.requests} requests, ${mb(result.total.bytes)}`);
    for (const [k, v] of Object.entries(result.totalByKind)) console.log(`  ${k}: ${v.requests} req, ${mb(v.bytes)}`);
    if (errors.length) console.log('page errors:', errors);
  }
} finally {
  await browser.close();
  await server.close();
}
