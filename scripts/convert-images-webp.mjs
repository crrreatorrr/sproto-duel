// Re-encodes the PNG/JPG images under public/assets/{textures,ui} as WebP at the same resolution,
// checks each against its source (PSNR over RGB and alpha), and replaces the source when it passes.
// The game resolves images under any extension (resolveImage), so manifest paths stay as they are.
// Usage: node scripts/convert-images-webp.mjs [--dry] [--min-psnr 38]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const minPsnr = args.includes('--min-psnr') ? Number(args[args.indexOf('--min-psnr') + 1]) : 38;
/** Paths (relative to public/assets) left alone. */
const SKIP = new Set(process.env.WEBP_SKIP ? process.env.WEBP_SKIP.split(',') : []);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(png|jpe?g)$/i.test(e.name)) out.push(p);
  }
  return out;
}

async function raw(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}

/** PSNR of premultiplied RGBA: colour under fully transparent pixels is invisible, so it doesn't count. */
function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.length; i += 4) {
    const wa = a[i + 3] / 255;
    const wb = b[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] * wa - b[i + c] * wb;
      se += d * d;
    }
    const d = a[i + 3] - b[i + 3];
    se += d * d;
  }
  const mse = se / a.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

let before = 0;
let after = 0;
const rows = [];
for (const file of ['textures', 'ui'].flatMap((d) => walk(path.join(ROOT, d))).sort()) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (SKIP.has(rel)) continue;
  const src = fs.readFileSync(file);
  const meta = await sharp(src).metadata();
  const alpha = meta.hasAlpha;
  // UI art is shown at a fraction of its size; tiling textures are seen up close, so keep more.
  const a = await raw(src);
  let quality = rel.startsWith('ui/') ? 90 : 88;
  let webp;
  let score;
  // Raise the quality until the WebP is within `minPsnr` of the source (or stop at 98).
  for (;;) {
    webp = await sharp(src).webp({ quality, alphaQuality: 100, effort: 6, smartSubsample: true }).toBuffer();
    score = psnr(a.data, (await raw(webp)).data);
    if (score >= minPsnr || quality >= 98) break;
    quality = Math.min(98, quality + 3);
  }
  if (score < minPsnr) {
    // Sharp edges (text, icons): near-lossless keeps them, still well under the PNG.
    webp = await sharp(src).webp({ nearLossless: true, quality: 60, effort: 6 }).toBuffer();
    score = psnr(a.data, (await raw(webp)).data);
    quality = 'near-lossless';
  }
  const ok = score >= minPsnr && webp.length < src.length;
  rows.push({ file: rel, size: `${meta.width}x${meta.height}${alpha ? ' a' : ''}`, q: quality, before: src.length, after: webp.length, psnr: score.toFixed(1), replaced: ok && !dry });
  before += src.length;
  after += ok ? webp.length : src.length;
  if (ok && !dry) {
    fs.writeFileSync(file.replace(/\.(png|jpe?g)$/i, '.webp'), webp);
    fs.rmSync(file);
  }
}
console.table(rows);
console.log(`images: ${(before / 1048576).toFixed(2)} MB -> ${(after / 1048576).toFixed(2)} MB${dry ? ' (dry run)' : ''}`);
