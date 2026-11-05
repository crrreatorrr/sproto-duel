#!/usr/bin/env node
/**
 * Replays every golden log with dist/duel-sim.server.js inside Chromium and checks the results and
 * end hashes equal the frozen ones (the same check Node runs in npm test and goja runs in
 * tools/goja-replay). Uses Playwright's Chromium (preinstalled in the agent containers; CI runs
 * `npx playwright install chromium`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = fs.readFileSync(path.join(ROOT, 'dist/duel-sim.server.js'), 'utf8');
const dir = path.join(ROOT, 'tests/golden');
const goldens = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: bundle });
const results = await page.evaluate((list) => {
  const out = [];
  for (const g of list) {
    const log = Object.assign({}, g.log, { simVersion: DUEL_SIM_VERSION });
    const t = performance.now();
    const r = DuelSim.replay(log);
    out.push({ name: g.name, ms: performance.now() - t, r });
  }
  return { version: DUEL_SIM_VERSION, browser: navigator.userAgent, out };
}, goldens);
await browser.close();

let failed = 0;
for (let i = 0; i < goldens.length; i++) {
  const g = goldens[i], { r, ms } = results.out[i];
  const bad = Object.keys(g.expect).filter((k) => JSON.stringify(r[k]) !== JSON.stringify(g.expect[k]));
  if (bad.length) failed++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ${g.name.padEnd(34)} ${String(r.ticks).padStart(6)} ticks ${ms.toFixed(1).padStart(7)} ms ${bad.map((k) => `${k}: want ${JSON.stringify(g.expect[k])} got ${JSON.stringify(r[k])}`).join('; ')}`);
}
console.log(`${goldens.length} goldens in Chromium (${results.version}), ${failed} failed`);
process.exit(failed || goldens.length === 0 ? 1 : 0);
