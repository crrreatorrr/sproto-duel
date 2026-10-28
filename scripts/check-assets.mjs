// Reports every GLB under public/assets: triangles vs budget, file size, and bounding box.
// Run with `npm run check:assets`. Exits non-zero if a model is over its triangle budget.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/core';
import { MeshoptDecoder } from 'meshoptimizer';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');

/** Budgets by folder; matches ASSETS.md. */
function budgetFor(rel) {
  if (rel.includes('debris')) return 400;
  if (rel.startsWith('models/themes/') && rel.endsWith('pillar.glb')) return 5000;
  if (rel.startsWith('models/themes/') && rel.endsWith('prop.glb')) return 8000;
  if (rel.startsWith('models/bosses/')) return 9000;
  return 10000;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.glb')) out.push(p);
  }
  return out;
}

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const files = walk(ROOT).sort();
if (!files.length) {
  console.log('No GLB files in public/assets yet (the game uses placeholders).');
  process.exit(0);
}

let over = 0;
const rows = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  try {
    const doc = await io.read(file);
    let tris = 0;
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const idx = prim.getIndices();
        const pos = prim.getAttribute('POSITION');
        tris += (idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3;
      }
    }
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    const b = scene ? getBounds(scene) : { min: [0, 0, 0], max: [0, 0, 0] };
    const size = b.max.map((v, i) => v - b.min[i]);
    const budget = budgetFor(rel);
    const ok = tris <= budget;
    if (!ok) over++;
    rows.push({
      file: rel,
      tris: Math.round(tris),
      budget,
      ok: ok ? 'ok' : 'OVER',
      kb: Math.round(fs.statSync(file).size / 1024),
      'size x/y/z (m)': size.map((v) => v.toFixed(2)).join(' / '),
      anims: doc.getRoot().listAnimations().length,
    });
  } catch (err) {
    over++;
    rows.push({ file: rel, tris: -1, budget: budgetFor(rel), ok: `ERROR ${err.message}`, kb: 0, 'size x/y/z (m)': '', anims: 0 });
  }
}
console.table(rows);
process.exit(over ? 1 : 0);
