// Screenshot of the built game's main menu (dist/, served by vite preview), for before/after
// spot checks of asset re-encodes. Usage: node scripts/screenshot-menu.mjs out.png [--wait 8000]
import { preview } from 'vite';
import { chromium } from 'playwright';

const out = process.argv[2] ?? 'menu.png';
const waitMs = Number(process.argv.includes('--wait') ? process.argv[process.argv.indexOf('--wait') + 1] : 8000);
const server = await preview({ preview: { port: 4198, strictPort: true }, logLevel: 'silent' });
setTimeout(() => process.exit(2), 180000).unref();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Same attract duel every run: seed Math.random.
  await page.addInitScript(() => {
    let s = 12345;
    Math.random = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  });
  await page.goto('http://localhost:4198/');
  await page.waitForFunction(() => !document.querySelector('#ui > .loading') && !!document.querySelector('.menu-screen'), null, { timeout: 120000 });
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: out });
  if (errors.length) console.log('page errors:', errors);
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
  await server.close();
}
