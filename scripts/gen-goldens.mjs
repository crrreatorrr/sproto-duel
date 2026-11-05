#!/usr/bin/env node
// Rewrites tests/golden/*.json from src/sim-core/testing/goldens.ts. Run only for an intended sim change.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'goldens-')), 'goldens.mjs');
await build({ entryPoints: [path.join(ROOT, 'src/sim-core/testing/goldens.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { GOLDEN_CASES, buildGolden } = await import(pathToFileURL(out).href);
const dir = path.join(ROOT, 'tests/golden');
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
for (const c of GOLDEN_CASES) {
  const t0 = Date.now();
  const g = buildGolden(c);
  const json = JSON.stringify(g, null, 1);
  fs.writeFileSync(path.join(dir, `${c.name}.json`), json + '\n');
  console.log(`${c.name}: ${g.expect.ticks} ticks, winner ${g.expect.winnerSeat}, ${g.expect.endReason}, log ${JSON.stringify(g.log).length} B (${Date.now() - t0} ms)`);
}
