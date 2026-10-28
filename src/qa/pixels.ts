import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Wizard } from '../wizard/Wizard';

/** How a wizard's look reads in the frame just drawn (QA). Luminance is 0..1 (Rec. 709 on the sRGB bytes). */
export interface LookPixels {
  /** Pixels of the look's silhouette that were sampled (0: off screen or hidden). */
  pixels: number;
  /** Mean luminance inside the silhouette, and how much of it is blown out (all channels near white). */
  mean: number;
  blown: number;
  /** Spread of luminance inside the silhouette (detail; a white blob has almost none). */
  spread: number;
  /** Mean luminance of the background around it (the silhouette's padded screen box, minus the silhouette). */
  background: number;
  /**
   * The colour step across his outline: mean distance (sRGB, 0..1 a channel) between pixels just
   * inside the silhouette and just outside it. A washed-out form melts into what's behind it.
   */
  contrast: number;
}

const MASK_LAYER = 30;
const BLOWN = 235;
let maskTarget: THREE.WebGLRenderTarget | null = null;
const maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
const tmpColor = new THREE.Color();
const tmpV = new THREE.Vector3();

/**
 * Sample the frame the game just drew (call right after `game.advance`, before anything else
 * renders: the drawing buffer is only valid until the frame is composited) inside `w`'s look. The
 * silhouette comes from drawing the look's opaque meshes alone, flat white, into an offscreen
 * target with the same camera.
 */
export function lookPixels(game: Game, w: Wizard): LookPixels {
  const R = game.renderer;
  const r = R.renderer;
  const gl = r.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const cam = R.camera;
  // Screen box of the look (its root's posed bounds), padded for the background ring.
  const v = w.visual;
  const k = v.root.scale.x;
  const rad = v.boundsRadius * k;
  const base = v.root.position;
  const top = v.topHeight * v.root.scale.y;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  cam.updateMatrixWorld();
  for (let i = 0; i < 8; i++) {
    tmpV.set(base.x + (i & 1 ? rad : -rad), base.y + (i & 2 ? top : 0), base.z + (i & 4 ? rad : -rad)).project(cam);
    if (tmpV.z > 1) continue;
    const x = (tmpV.x * 0.5 + 0.5) * W, y = (tmpV.y * 0.5 + 0.5) * H; // GL: origin bottom-left
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const padX = (x1 - x0) * 0.35, padY = (y1 - y0) * 0.2;
  const bx = Math.max(0, Math.floor(x0 - padX)), by = Math.max(0, Math.floor(y0 - padY));
  const bw = Math.min(W, Math.ceil(x1 + padX)) - bx, bh = Math.min(H, Math.ceil(y1 + padY)) - by;
  const empty = { pixels: 0, mean: 0, blown: 0, spread: 0, background: 0, contrast: 0 };
  if (!(bw > 4 && bh > 4)) return empty;
  const frame = new Uint8Array(bw * bh * 4);
  gl.readPixels(bx, by, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, frame);

  // The silhouette: only the look's opaque meshes, flat white, on black.
  if (!maskTarget || maskTarget.width !== W || maskTarget.height !== H) {
    maskTarget?.dispose();
    maskTarget = new THREE.WebGLRenderTarget(W, H);
  }
  const marked: THREE.Object3D[] = [];
  v.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.cineShell) return;
    const mat = m.material as THREE.Material;
    if (Array.isArray(mat) || mat.transparent || (mat as THREE.ShaderMaterial).isShaderMaterial) return;
    m.layers.enable(MASK_LAYER);
    marked.push(m);
  });
  const scene = R.scene;
  const saved = { mask: cam.layers.mask, bg: scene.background, override: scene.overrideMaterial, shadows: r.shadowMap.autoUpdate, alpha: r.getClearAlpha(), target: r.getRenderTarget() };
  r.getClearColor(tmpColor);
  const clear = tmpColor.clone();
  try {
    cam.layers.set(MASK_LAYER);
    scene.background = null;
    scene.overrideMaterial = maskMaterial;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(maskTarget);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(scene, cam);
  } finally {
    cam.layers.mask = saved.mask;
    scene.background = saved.bg;
    scene.overrideMaterial = saved.override;
    r.shadowMap.autoUpdate = saved.shadows;
    r.setClearColor(clear, saved.alpha);
    r.setRenderTarget(saved.target);
    for (const m of marked) m.layers.disable(MASK_LAYER);
  }
  const mask = new Uint8Array(bw * bh * 4);
  r.readRenderTargetPixels(maskTarget, bx, by, bw, bh, mask);

  let n = 0, sum = 0, sum2 = 0, blown = 0, bgN = 0, bgSum = 0;
  for (let i = 0; i < bw * bh; i++) {
    const R8 = frame[i * 4], G8 = frame[i * 4 + 1], B8 = frame[i * 4 + 2];
    const l = (0.2126 * R8 + 0.7152 * G8 + 0.0722 * B8) / 255;
    if (mask[i * 4] > 127) {
      n++;
      sum += l;
      sum2 += l * l;
      if (R8 >= BLOWN && G8 >= BLOWN && B8 >= BLOWN) blown++;
    } else {
      bgN++;
      bgSum += l;
    }
  }
  if (n === 0) return empty;
  const mean = sum / n;
  // Across the outline: pairs `gap` px apart, one inside the silhouette and one outside it.
  const inside = (x: number, y: number) => mask[(y * bw + x) * 4] > 127;
  const gap = Math.max(3, Math.round(bw * 0.012));
  let pairs = 0, step = 0;
  for (let y = gap; y < bh - gap; y += 2) {
    for (let x = gap; x < bw - gap; x += 2) {
      if (!inside(x, y)) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ox = x + dx * gap, oy = y + dy * gap;
        if (inside(ox, oy) || !inside(x + dx, y + dy)) continue;
        const a = (y * bw + x) * 4, b = (oy * bw + ox) * 4;
        step += Math.hypot(frame[a] - frame[b], frame[a + 1] - frame[b + 1], frame[a + 2] - frame[b + 2]) / 255;
        pairs++;
      }
    }
  }
  const d = pairs ? step / pairs : 0;
  return { pixels: n, mean, blown: blown / n, spread: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), background: bgN ? bgSum / bgN : 0, contrast: d };
}
