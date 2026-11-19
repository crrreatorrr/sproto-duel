// Re-encodes the embedded textures of staff GLBs as WebP (EXT_texture_webp) at their own
// resolution. Geometry, animation and the meshopt compression are written back unchanged.
// A texture is replaced only when its WebP is smaller and within --min-psnr dB of the source
// (default 38); the others (normal maps, mostly) stay as they are.
// Usage: node scripts/staff-textures-webp.mjs [--dry] <file.glb>...
import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const minPsnr = args.includes('--min-psnr') ? Number(args[args.indexOf('--min-psnr') + 1]) : 38;
const files = args.filter((a, i) => a.endsWith('.glb') && args[i - 1] !== '--min-psnr');

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

async function rgba(buf) {
  return (await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data;
}
function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.length; i++) se += (a[i] - b[i]) ** 2;
  const mse = se / a.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

for (const file of files) {
  const before = fs.statSync(file).size;
  const doc = await io.read(file);
  let changed = 0;
  const notes = [];
  for (const tex of doc.getRoot().listTextures()) {
    const img = tex.getImage();
    if (!img || tex.getMimeType() === 'image/webp') continue;
    const src = await rgba(img);
    let quality = 90;
    let out;
    let score;
    for (;;) {
      out = await sharp(img).webp({ quality, effort: 6 }).toBuffer();
      score = psnr(src, await rgba(out));
      if (score >= minPsnr || quality >= 98) break;
      quality += 2;
    }
    const pass = score >= minPsnr && out.length < img.length;
    notes.push(`${tex.getName()} q${quality} ${(img.length / 1024).toFixed(0)}->${(out.length / 1024).toFixed(0)} KB ${score.toFixed(1)} dB${pass ? '' : ' (kept)'}`);
    if (!pass) continue;
    changed++;
    tex.setImage(new Uint8Array(out)).setMimeType('image/webp');
    const uri = tex.getURI();
    if (uri) tex.setURI(uri.replace(/\.(png|jpe?g)$/i, '.webp'));
  }
  if (!changed) {
    console.log(`${file}: unchanged\n  ${notes.join('\n  ')}`);
    continue;
  }
  doc.createExtension(EXTTextureWebP).setRequired(true);
  const glb = await io.writeBinary(doc);
  console.log(`${file}: ${(before / 1024).toFixed(0)} -> ${(glb.length / 1024).toFixed(0)} KB${dry ? ' (dry run)' : ''}\n  ${notes.join('\n  ')}`);
  if (!dry) fs.writeFileSync(file, glb);
}
