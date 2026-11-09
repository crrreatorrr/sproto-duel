// Finishes a staff exported by tools/blender/alien_ray_staff.py for the game:
// - simplifies each mesh to its triangle target with meshoptimizer. Tripo meshes are cut into
//   hundreds of small UV islands, and the plain simplifier won't collapse across those seams (it
//   stalled at ~20k triangles), so this runs in Permissive mode with the UVs and normals weighted
//   into the error: seams may collapse, but only where the texture and shading stay put,
// - merges Blender's per-object animations into one clip,
// - resizes the textures to JPEG, then meshopt-compresses like the other staffs.
//
//   node tools/blender/finish-staff.mjs <in.glb> <out.glb> <clip name> <targets> <texture size>
//   targets: comma-separated `part=triangles`, matched against the end of each mesh name; a mesh
//   named `<slug>_alien_3` matches `alien` (the trailing number is ignored).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, meshopt, prune, textureCompress, weldPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const [input, output, clip, targetArg, sizeArg] = process.argv.slice(2);
if (!input || !output || !clip || !targetArg || !sizeArg) {
  console.error('usage: finish-staff.mjs <in.glb> <out.glb> <clip name> <part=tris,...> <texture size>');
  process.exit(1);
}
const targets = Object.fromEntries(targetArg.split(',').map((kv) => {
  const [k, v] = kv.split('=');
  return [k, Number(v)];
}));
const size = Number(sizeArg);

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(input);
const root = doc.getRoot();

/** UV error weight, and normal error weight, relative to position error (meshopt normalises by mesh scale). */
const UV_WEIGHT = 20;
const NORMAL_WEIGHT = 0.25;

/** Simplifies `prim` in place to about `ratio` of its triangles; see the note at the top. */
function simplifyPermissive(document, prim, ratio) {
  const position = prim.getAttribute('POSITION');
  const uv = prim.getAttribute('TEXCOORD_0');
  const normal = prim.getAttribute('NORMAL');
  const count = position.getCount();
  const pos = Float32Array.from(position.getArray());
  const stride = (uv ? 2 : 0) + (normal ? 3 : 0);
  const attrs = new Float32Array(Math.max(stride, 1) * count);
  const weights = [];
  if (uv) weights.push(UV_WEIGHT, UV_WEIGHT);
  if (normal) weights.push(NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT);
  const el = [];
  for (let v = 0; v < count; v++) {
    let o = v * stride;
    if (uv) for (const c of uv.getElement(v, el)) attrs[o++] = c;
    if (normal) for (const c of normal.getElement(v, el)) attrs[o++] = c;
  }
  const src = prim.getIndices();
  const indices = new Uint32Array(src.getArray());
  const target = Math.floor((ratio * indices.length) / 3) * 3;
  const [dst] = stride
    ? MeshoptSimplifier.simplifyWithAttributes(indices, pos, 3, attrs, stride, weights, null, target, 1, ['Permissive'])
    : MeshoptSimplifier.simplify(indices, pos, 3, target, 1, []);
  prim.setIndices(document.createAccessor().setType('SCALAR').setArray(dst).setBuffer(src.getBuffer()));
  if (src.listParents().length === 1) src.dispose();
  compactPrimitive(prim);
  if (prim.getAttribute('POSITION').getCount() <= 65534) prim.getIndices().setArray(new Uint16Array(prim.getIndices().getArray()));
}

const tris = (prim) => (prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION').getCount()) / 3;
let total = 0;
for (const mesh of root.listMeshes()) {
  const part = mesh.getName().replace(/_\d+$/, '').split('_').pop();
  const target = targets[part];
  if (!target) throw new Error(`no triangle target for mesh ${mesh.getName()} (part "${part}")`);
  for (const prim of mesh.listPrimitives()) {
    weldPrimitive(prim);
    // The vertex ratio tracks the triangle ratio closely; nudge it until the count is near the target.
    const before = tris(prim);
    let ratio = target / before;
    let snapshot = null;
    for (let i = 0; i < 6; i++) {
      const trial = prim.clone();
      simplifyPermissive(doc, trial, ratio);
      const got = tris(trial);
      if (snapshot) snapshot.dispose();
      snapshot = trial;
      if (Math.abs(got - target) <= target * 0.06) break;
      ratio *= target / Math.max(got, 1);
    }
    mesh.removePrimitive(prim);
    mesh.addPrimitive(snapshot);
    prim.dispose();
    total += tris(snapshot);
    console.log(`  ${mesh.getName()}: ${before} -> ${tris(snapshot)} tris`);
  }
}

const anims = root.listAnimations();
if (anims.length) {
  const keep = anims[0];
  keep.setName(clip);
  for (const a of anims.slice(1)) {
    for (const s of a.listSamplers()) keep.addSampler(s);
    for (const c of a.listChannels()) keep.addChannel(c);
    a.dispose();
  }
}

await doc.transform(
  dedup(),
  prune({ keepLeaves: true }),
  textureCompress({ encoder: sharp, targetFormat: 'jpeg', resize: [size, size], quality: 86 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
await io.write(output, doc);
const a = root.listAnimations()[0];
console.log(`${output}: ${total} tris, clip ${a?.getName()} with ${a?.listChannels().length ?? 0} channels`);
