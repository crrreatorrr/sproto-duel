#!/usr/bin/env node
/**
 * Runs the in-browser QA harness (`__duel.qa.runAll()`) in headless Chrome, with no extra
 * dependencies: it starts the Vite dev server (the harness is dev-only), launches Chrome with
 * SwiftShader WebGL2 and a CDP port, and talks to it over Node 22's global WebSocket.
 *
 *   npm run qa:headless                 # every scenario
 *   npm run qa:headless -- versus.      # only scenarios whose name contains "versus."
 *   QA_PERF=10 npm run qa:headless      # also print __duel.qa.perf(10) and renderer.info
 *   QA_URL_QUERY='&netsim=80' ...       # extra query string for the page
 *
 * Exits non-zero when any scenario fails. Perf under SwiftShader is only comparable run to run
 * on the same machine.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.QA_PORT || 4174);
const CDP_PORT = Number(process.env.QA_CDP_PORT || 9333);
const filter = process.argv[2] || '';
const perfSeconds = Number(process.env.QA_PERF || 0);
const timeoutMs = Number(process.env.QA_TIMEOUT_MS || 30 * 60 * 1000);
const chromeBin = process.env.CHROME_BIN || 'google-chrome';
const extraQuery = process.env.QA_URL_QUERY || '';

const children = [];
function cleanup() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

// Through the JS API with HMR and the file watcher off: edits made while a run is going (or a
// dependency re-optimization) must not reload the page under the harness.
const { createServer } = await import('vite');
const vite = await createServer({
  server: { port: PORT, strictPort: true, host: '127.0.0.1', hmr: false, watch: null },
  logLevel: 'warn',
});
await vite.listen();
process.on('exit', () => { void vite.close(); });

const base = `http://127.0.0.1:${PORT}/`;
await waitFor(async () => (await fetch(base)).ok, 60_000, 'vite dev server');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-chrome-'));
const chrome = spawn(chromeBin, [
  '--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--window-size=' + (process.env.QA_WINDOW || '800,450'), '--force-device-scale-factor=1', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
children.push(chrome);

const targets = await waitFor(async () => {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const list = await r.json();
  return list.find((t) => t.type === 'page') ? list : null;
}, 30_000, 'chrome devtools');
const page = targets.find((t) => t.type === 'page');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(msg.error.message));
    else res(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    console.error('[page exception]', msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    console.error('[console.error]', text.slice(0, 400));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression, ms = 60_000) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    sleep(ms).then(() => { throw new Error(`evaluate timed out: ${expression.slice(0, 80)}`); }),
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `${base}?nolock${extraQuery}` });
const ready = () => waitFor(() => evaluate('!!(window.__duel && window.__duel.qa)', 5_000), 180_000, '__duel.qa');
await ready();
// A first visit can re-optimize dependencies and reload once: settle before measuring.
await sleep(3000);
await ready();

if (perfSeconds > 0) {
  const perf = await evaluate(`(async () => {
    const p = await __duel.qa.perf(${perfSeconds});
    const info = __duel.game.renderer.renderer.info.render;
    return { perf: p, calls: info.calls, triangles: info.triangles };
  })()`, (perfSeconds + 30) * 1000);
  console.log('[perf]', JSON.stringify(perf));
}

const t0 = Date.now();
const runAll = () => evaluate(`(async () => {
  const r = await __duel.qa.runAll(${JSON.stringify(filter)} || undefined);
  return { passed: r.passed, failed: r.failed, failures: r.results.filter((x) => !x.pass).map((x) => ({ name: x.name, detail: String(x.detail).slice(0, 600) })) };
})()`, timeoutMs);
let summary;
try {
  summary = await runAll();
} catch (err) {
  if (!/navigated|closed/i.test(String(err))) throw err;
  console.warn('[qa] page reloaded during the run; running again');
  await ready();
  summary = await runAll();
}
const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`QA: ${summary.passed} passed, ${summary.failed} failed (${secs}s)${filter ? ` [filter "${filter}"]` : ''}`);
for (const f of summary.failures) console.log(`FAIL ${f.name}: ${f.detail}`);
ws.close();
cleanup();
fs.rmSync(profile, { recursive: true, force: true });
process.exit(summary.failed > 0 || summary.passed === 0 ? 1 : 0);
