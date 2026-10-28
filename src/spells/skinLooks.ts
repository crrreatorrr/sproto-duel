import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TeamPalette } from '../config';
import type { ProjectileSkin } from '../campaign/levels';

/**
 * The boss projectile looks themselves: low-poly geometry built from primitives, with UVs into a
 * small canvas atlas painted in the caster's palette (ProjectileSkins instances and animates them).
 * Sizes are meters at a spell's full-power radius, facing +z (the flight direction).
 */

/** A projectile skin other than the plain spell orb. */
export type ObjectSkin = Exclude<ProjectileSkin, 'orb'>;

/** A rectangle of an atlas canvas, in pixels from the top-left. */
export type Rect = readonly [x: number, y: number, w: number, h: number];
export type Paint = (g: CanvasRenderingContext2D, n: number, pal: TeamPalette) => void;

export interface SkinDef {
  /** Atlas canvas size (square, px). */
  atlas: number;
  /** Opaque object geometry with UVs into the atlas (built once, shared by both teams). */
  solid(n: number): THREE.BufferGeometry;
  /** Colour atlas. */
  paint: Paint;
  /** Glowing parts, painted over a dimmed copy of the colour atlas (`baseGlow`). */
  glow?: Paint;
  /** Share of the colour atlas that glows anyway, so objects read in any arena's lighting. */
  baseGlow: number;
  emissive: number;
  roughness: number;
  doubleSided?: boolean;
  /** Additive part (tracer streak, flames): geometry, texture size and painter, brightness. */
  aura?: {
    geometry(): THREE.BufferGeometry;
    w: number;
    h: number;
    paint: Paint;
    intensity: number;
    /** Brightness left where the surface is seen edge-on (soft silhouettes instead of hard planes). */
    edge: number;
  };
  /** Glow sprite size on top of CONFIG.projectileSkins.glowScale. */
  glowSize: number;
  /** Vertex animation on the GPU: the carpet's ripple, or the pig's flailing legs and wagging tail. */
  shader?: 'ripple' | 'flail';
}

const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();
/** Build-time scratch for placing parts (kept apart from the per-frame pose scratch). */
const buildEuler = new THREE.Euler();
const buildQ = new THREE.Quaternion();
const buildPos = new THREE.Vector3();
const buildScale = new THREE.Vector3();
const buildMat = new THREE.Matrix4();

/** CSS colour for a palette hex, scaled by `k` and optionally mixed toward `mix`. */
function css(hex: number, k = 1, mix?: number, t = 0): string {
  tmpColor.setHex(hex);
  if (mix !== undefined) tmpColor.lerp(tmpColor2.setHex(mix), t);
  tmpColor.multiplyScalar(k);
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${c(tmpColor.r)},${c(tmpColor.g)},${c(tmpColor.b)})`;
}

/** Deterministic pseudo-random so painted atlases look the same every time. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

/** Remap a geometry's 0..1 UVs into `r` of an `n`-px atlas (canvas y down, texture v up). */
function inRect<T extends THREE.BufferGeometry>(geo: T, n: number, r: Rect): T {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const u0 = r[0] / n, du = r[2] / n, v0 = 1 - (r[1] + r[3]) / n, dv = r[3] / n;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * du, v0 + uv.getY(i) * dv);
  return geo;
}

/** BoxGeometry with one atlas rect per face (+x, -x, +y, -y, +z, -z). */
function boxInRects(geo: THREE.BoxGeometry, n: number, faces: readonly Rect[]): THREE.BoxGeometry {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let f = 0; f < 6; f++) {
    const r = faces[f];
    const u0 = r[0] / n, du = r[2] / n, v0 = 1 - (r[1] + r[3]) / n, dv = r[3] / n;
    for (let i = f * 4; i < f * 4 + 4; i++) uv.setXY(i, u0 + uv.getX(i) * du, v0 + uv.getY(i) * dv);
  }
  return geo;
}

/** Place a part: rotate (XYZ radians, optional), scale, then move. */
function place<T extends THREE.BufferGeometry>(geo: T, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): T {
  buildQ.setFromEuler(buildEuler.set(rx, ry, rz));
  geo.applyMatrix4(buildMat.compose(buildPos.set(x, y, z), buildQ, buildScale.set(sx, sy, sz)));
  return geo;
}

/** Merge parts into one geometry (indexed if they all are). */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const indexed = parts.every((g) => g.index !== null);
  const list = indexed ? parts : parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = mergeGeometries(list);
  for (const g of parts) g.dispose();
  if (!out) throw new Error('ProjectileSkins: incompatible part geometries');
  return out;
}

/** Two crossed planes along -z (head at z = 0, tail at z = -1): reads from any side. */
function crossedStreak(width: number): THREE.BufferGeometry {
  const a = new THREE.PlaneGeometry(width, 1).rotateX(Math.PI / 2).translate(0, 0, -0.5);
  const b = a.clone().rotateZ(Math.PI / 2);
  return merge([a, b]);
}

/** Flame cone around/behind an object: base ring at `front`, apex trailing back along -z. */
function flameCone(radius: number, length: number, front: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(radius, length, 12, 1, true);
  g.rotateX(-Math.PI / 2); // apex (+y) to -z
  g.translate(0, 0, front - length / 2);
  return g;
}

/** Additive flame texture: hot at the base (bottom row), licking tongues fading toward the apex. */
function paintFlame(hot: number, mid: number, seed: number): Paint {
  return (g, n) => {
    const w = g.canvas.width, h = g.canvas.height;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    const r = rng(seed);
    // Tongues: vertical strokes of varying height, brightest at the bottom.
    for (let i = 0; i < 9; i++) {
      const x = ((i + r() * 0.6) / 9) * w;
      const top = h * (0.05 + r() * 0.55);
      const grad = g.createLinearGradient(0, h, 0, top);
      grad.addColorStop(0, css(hot, 1, 0xffe0a0, 0.45));
      grad.addColorStop(0.3, css(hot, 0.85));
      grad.addColorStop(0.7, css(mid, 0.5));
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath();
      const half = w * (0.04 + r() * 0.04);
      g.moveTo(x - half, h);
      g.quadraticCurveTo(x - half * 0.3, (h + top) / 2, x, top);
      g.quadraticCurveTo(x + half * 0.3, (h + top) / 2, x + half, h);
      g.fill();
    }
  };
}

// ------------------------------------------------------------------- the skins

/** Rolled carpet: a patterned cylinder with spiral ends and a fringe, tumbling end over end. */
const RUG_ROLL: SkinDef = {
  atlas: 128,
  baseGlow: 0.24,
  emissive: 1.4,
  roughness: 0.9,
  glowSize: 1,
  solid(n) {
    const len = 0.8, r = 0.12;
    const side: Rect = [0, 0, 128, 96], cap: Rect = [0, 96, 32, 32], fringe: Rect = [32, 96, 96, 32];
    const parts: THREE.BufferGeometry[] = [inRect(new THREE.CylinderGeometry(r, r, len, 12, 1, true), n, side)];
    for (const end of [1, -1]) {
      parts.push(place(inRect(new THREE.CircleGeometry(r, 12), n, cap), 0, end * len / 2, 0, -end * Math.PI / 2));
      // Fringe: short strands sticking out of the roll's ends.
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const s = inRect(new THREE.BoxGeometry(0.016, 0.075, 0.016), n, fringe);
        parts.push(place(s, Math.cos(a) * r * 0.85, end * (len / 2 + 0.033), Math.sin(a) * r * 0.85, Math.sin(a) * 0.35 * end, 0, -Math.cos(a) * 0.35 * end));
      }
    }
    return merge(parts);
  },
  paint(g, n, p) {
    const W = 128, H = 96;
    g.fillStyle = css(p.robe);
    g.fillRect(0, 0, W, H);
    // Borders at both ends of the rug (the cylinder's v runs along its length).
    for (const y of [0, H - 12]) {
      g.fillStyle = css(p.trim);
      g.fillRect(0, y, W, 12);
      g.fillStyle = css(p.robe, 0.55);
      for (let x = 0; x < W; x += 8) g.fillRect(x + 2, y + 4, 4, 4);
    }
    g.fillStyle = css(p.spell);
    g.fillRect(0, 14, W, 2);
    g.fillRect(0, H - 16, W, 2);
    // Zigzag bands and diamonds through the field.
    g.lineWidth = 3;
    for (const y of [28, 48, 68]) {
      g.strokeStyle = y === 48 ? css(p.trim) : css(p.spell);
      g.beginPath();
      for (let x = 0; x <= W; x += 8) g.lineTo(x, y + ((x / 8) % 2 ? -5 : 5));
      g.stroke();
    }
    g.fillStyle = css(p.blast, 1, 0xffffff, 0.15);
    for (let x = 16; x < W; x += 32) {
      for (const y of [38, 58]) {
        g.beginPath();
        g.moveTo(x, y - 6);
        g.lineTo(x + 6, y);
        g.lineTo(x, y + 6);
        g.lineTo(x - 6, y);
        g.fill();
      }
    }
    // Spiral end: rings of rug wound on itself.
    const cx = 16, cy = H + 16;
    for (let k = 0; k < 6; k++) {
      g.fillStyle = k % 2 ? css(p.robe, 0.8) : css(p.trim, 0.9);
      g.beginPath();
      g.arc(cx, cy, 16 - k * 2.6, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = css(p.robe, 0.35);
    g.lineWidth = 1.2;
    g.beginPath();
    for (let a = 0; a < Math.PI * 10; a += 0.2) g.lineTo(cx + Math.cos(a) * a * 0.5, cy + Math.sin(a) * a * 0.5);
    g.stroke();
    // Fringe threads.
    g.fillStyle = css(p.trim, 1.05, 0xffffff, 0.3);
    g.fillRect(32, H, 96, 32);
    g.fillStyle = css(p.trim, 0.7);
    for (let x = 32; x < 128; x += 4) g.fillRect(x, H, 1, 32);
  },
  glow(g, _n, p) {
    g.globalAlpha = 0.55;
    g.strokeStyle = css(p.spell);
    g.lineWidth = 3;
    for (const y of [28, 68]) {
      g.beginPath();
      for (let x = 0; x <= 128; x += 8) g.lineTo(x, y + ((x / 8) % 2 ? -5 : 5));
      g.stroke();
    }
    g.globalAlpha = 1;
  },
};

/** Unrolled flying carpet: rippling in a tiny vertex shader, tassels on both ends. */
const CARPET: SkinDef = {
  atlas: 256,
  baseGlow: 0.26,
  emissive: 1.5,
  roughness: 0.92,
  doubleSided: true,
  glowSize: 1,
  shader: 'ripple',
  solid(n) {
    const w = 1.0, len = 1.5;
    const top: Rect = [0, 0, 256, 224], tassel: Rect = [0, 224, 256, 32];
    const parts: THREE.BufferGeometry[] = [inRect(new THREE.PlaneGeometry(w, len, 1, 12), n, top).rotateX(-Math.PI / 2)];
    for (const end of [1, -1]) {
      for (let i = 0; i < 9; i++) {
        const x = -w / 2 + 0.07 + (i / 8) * (w - 0.14);
        parts.push(place(inRect(new THREE.BoxGeometry(0.025, 0.012, 0.13), n, tassel), x, 0, end * (len / 2 + 0.06)));
      }
    }
    return merge(parts);
  },
  paint(g, n, p) {
    const W = 256, H = 224;
    g.fillStyle = css(p.trim);
    g.fillRect(0, 0, W, H);
    g.fillStyle = css(p.robe, 0.6);
    g.fillRect(9, 9, W - 18, H - 18);
    // Inner border: a row of small medallions.
    g.fillStyle = css(p.spell);
    for (let x = 18; x < W - 12; x += 14) {
      g.beginPath();
      g.arc(x, 16, 3, 0, Math.PI * 2);
      g.arc(x, H - 16, 3, 0, Math.PI * 2);
      g.fill();
    }
    for (let y = 30; y < H - 24; y += 14) {
      g.beginPath();
      g.arc(16, y, 3, 0, Math.PI * 2);
      g.arc(W - 16, y, 3, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = css(p.robe);
    g.fillRect(25, 25, W - 50, H - 50);
    // Corner pieces and the central lozenge medallion.
    g.fillStyle = css(p.trim, 0.85);
    for (const [x, y, sx, sy] of [[25, 25, 1, 1], [W - 25, 25, -1, 1], [25, H - 25, 1, -1], [W - 25, H - 25, -1, -1]]) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + sx * 40, y);
      g.lineTo(x, y + sy * 40);
      g.fill();
    }
    const cx = W / 2, cy = H / 2;
    const lozenge = (rx: number, ry: number, fill: string) => {
      g.fillStyle = fill;
      g.beginPath();
      g.moveTo(cx, cy - ry);
      g.lineTo(cx + rx, cy);
      g.lineTo(cx, cy + ry);
      g.lineTo(cx - rx, cy);
      g.fill();
    };
    lozenge(78, 70, css(p.trim));
    lozenge(70, 62, css(p.blast));
    lozenge(44, 40, css(p.robe, 0.7));
    lozenge(26, 24, css(p.spell));
    g.fillStyle = css(p.trim);
    for (const [dx, dy] of [[0, -54], [0, 54], [-60, 0], [60, 0]]) {
      g.beginPath();
      g.arc(cx + dx, cy + dy, 5, 0, Math.PI * 2);
      g.fill();
    }
    // Tassels.
    g.fillStyle = css(p.trim, 1.05, 0xffffff, 0.25);
    g.fillRect(0, H, W, 32);
    g.fillStyle = css(p.blast, 0.9);
    g.fillRect(0, H + 20, W, 12);
  },
  glow(g, _n, p) {
    const cx = 128, cy = 112;
    g.fillStyle = css(p.spell, 0.8);
    g.beginPath();
    g.moveTo(cx, cy - 24);
    g.lineTo(cx + 26, cy);
    g.lineTo(cx, cy + 24);
    g.lineTo(cx - 26, cy);
    g.fill();
    g.globalAlpha = 0.45;
    g.fillStyle = css(p.spell);
    for (let x = 18; x < 244; x += 14) {
      g.beginPath();
      g.arc(x, 16, 3, 0, Math.PI * 2);
      g.arc(x, 208, 3, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  },
};

/** Smartphone: dark slab, palette-gold frame and a glowing screen. */
const PHONE: SkinDef = {
  atlas: 128,
  baseGlow: 0.22,
  emissive: 1.9,
  roughness: 0.45,
  glowSize: 0.9,
  solid(n) {
    const screen: Rect = [0, 0, 64, 128], back: Rect = [64, 0, 64, 64], frame: Rect = [64, 64, 64, 64];
    return boxInRects(new THREE.BoxGeometry(0.24, 0.46, 0.045), n, [frame, frame, frame, frame, screen, back]);
  },
  paint(g, n, p) {
    // Screen face: bezel, lit wallpaper, a coin and an app row.
    g.fillStyle = '#07070a';
    g.fillRect(0, 0, 64, 128);
    const grad = g.createLinearGradient(0, 6, 0, 122);
    grad.addColorStop(0, css(p.spell, 1, 0xffffff, 0.45));
    grad.addColorStop(1, css(p.spell, 0.55, p.blast, 0.3));
    g.fillStyle = grad;
    g.fillRect(5, 7, 54, 114);
    g.fillStyle = '#07070a';
    g.fillRect(24, 8, 16, 4); // notch
    g.fillStyle = css(p.trim, 1, 0xffffff, 0.2);
    g.beginPath();
    g.arc(32, 52, 17, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = css(p.spell, 0.5);
    g.font = 'bold 24px Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('₿', 32, 53);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < 4; i++) g.fillRect(9 + i * 12.5, 100, 9, 9);
    g.fillRect(14, 82, 36, 4);
    // Back: palette colour, camera bump, logo.
    g.fillStyle = css(p.trim, 0.85);
    g.fillRect(64, 0, 64, 64);
    g.fillStyle = '#121216';
    g.fillRect(70, 5, 22, 22);
    g.fillStyle = '#2a2a33';
    for (const [x, y] of [[76, 11], [86, 11], [76, 21]]) {
      g.beginPath();
      g.arc(x, y, 3.6, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = css(p.trim, 1.2);
    g.beginPath();
    g.arc(96, 40, 7, 0, Math.PI * 2);
    g.fill();
    // Frame: brushed palette metal.
    const fr = g.createLinearGradient(64, 64, 128, 128);
    fr.addColorStop(0, css(p.trim, 1.1));
    fr.addColorStop(0.5, css(p.trim, 0.6));
    fr.addColorStop(1, css(p.trim, 1));
    g.fillStyle = fr;
    g.fillRect(64, 64, 64, 64);
  },
  glow(g, n, p) {
    // The whole screen lights up (drawn at full strength over the dimmed base).
    g.save();
    g.beginPath();
    g.rect(5, 7, 54, 114);
    g.clip();
    PHONE.paint(g, n, p);
    g.restore();
    g.fillStyle = '#000';
    g.fillRect(24, 8, 16, 4);
  },
};

/** Tag a part as limb `id` (1-4 legs swing about x, 5 = tail wags about y) pivoting at `pivot`; 0 = rigid. */
function limb(geo: THREE.BufferGeometry, id: number, pivot: readonly [number, number, number] = [0, 0, 0]): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const pivots = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) pivots.set(pivot, i * 3);
  geo.setAttribute('aLimb', new THREE.BufferAttribute(new Float32Array(n).fill(id), 1));
  geo.setAttribute('aPivot', new THREE.BufferAttribute(pivots, 3));
  return geo;
}

/** A chubby pink pig (a piggy bank: coin stamps in the palette), legs flailing as it tumbles. */
const PIG: SkinDef = {
  atlas: 128,
  baseGlow: 0.22,
  emissive: 1.4,
  roughness: 0.75,
  glowSize: 1,
  shader: 'flail',
  solid(n) {
    const head: Rect = [0, 0, 64, 64], body: Rect = [64, 0, 64, 64], snout: Rect = [0, 64, 32, 32];
    const hoof: Rect = [32, 64, 32, 32], ear: Rect = [64, 64, 32, 32], plain: Rect = [96, 64, 32, 32];
    const parts: THREE.BufferGeometry[] = [
      limb(place(inRect(new THREE.SphereGeometry(0.3, 14, 10), n, body), 0, 0, 0, 0, 0, 0, 1, 0.88, 1.22), 0),
      limb(place(inRect(new THREE.SphereGeometry(0.2, 12, 9), n, head), 0, 0.07, 0.36), 0),
      limb(place(inRect(new THREE.CylinderGeometry(0.085, 0.095, 0.09, 12, 1, true), n, plain), 0, 0.03, 0.56, Math.PI / 2), 0),
      limb(place(inRect(new THREE.CircleGeometry(0.085, 12), n, snout), 0, 0.03, 0.605), 0),
    ];
    for (const side of [1, -1]) {
      parts.push(limb(place(inRect(new THREE.ConeGeometry(0.07, 0.14, 4), n, ear), side * 0.12, 0.27, 0.38, 0.5, 0, -side * 0.45), 0));
    }
    let id = 1;
    for (const z of [0.2, -0.2]) {
      for (const side of [1, -1]) {
        const hip: [number, number, number] = [side * 0.15, -0.18, z];
        parts.push(limb(place(inRect(new THREE.CylinderGeometry(0.06, 0.05, 0.2, 8), n, hoof), hip[0], -0.27, z), id++, hip));
      }
    }
    // Curly tail: a little coil at the rump.
    parts.push(limb(place(inRect(new THREE.TorusGeometry(0.045, 0.014, 5, 12), n, plain), 0, 0.09, -0.4, 0, Math.PI / 2, 0), 5, [0, 0.09, -0.36]));
    return merge(parts);
  },
  paint(g, n, p) {
    const pink = '#ee8aa6', deep = '#c9617f';
    // Head (its front, u = 0.25, is x = 16): eyes and blushing cheeks.
    g.fillStyle = pink;
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#20121a';
    for (const dx of [-5, 5]) {
      g.beginPath();
      g.arc(16 + dx, 24, 2.4, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = 'rgba(230,90,120,0.45)';
    for (const dx of [-9, 9]) {
      g.beginPath();
      g.arc(16 + dx, 33, 3.2, 0, Math.PI * 2);
      g.fill();
    }
    // Body: pink with a darker belly and a coin stamp on both flanks, in the palette.
    const b = g.createLinearGradient(0, 0, 0, 64);
    b.addColorStop(0, '#f39bb3');
    b.addColorStop(0.65, pink);
    b.addColorStop(1, deep);
    g.fillStyle = b;
    g.fillRect(64, 0, 64, 64);
    g.font = 'bold 8px Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const x of [64, 96, 128]) {
      g.fillStyle = css(p.spell);
      g.beginPath();
      g.arc(x, 30, 5.5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = css(p.spell, 0.55);
      g.fillText('₿', x, 29);
    }
    // Snout disc with nostrils.
    g.fillStyle = deep;
    g.fillRect(0, 64, 32, 32);
    g.fillStyle = '#e48aa2';
    g.beginPath();
    g.arc(16, 80, 14, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#5a2232';
    for (const dx of [-5, 5]) {
      g.beginPath();
      g.ellipse(16 + dx, 80, 2.2, 3.6, 0, 0, Math.PI * 2);
      g.fill();
    }
    // Legs ending in dark hooves; ears with a darker inside; plain pink for the snout rim and tail.
    const h = g.createLinearGradient(0, 64, 0, 96);
    h.addColorStop(0, pink);
    h.addColorStop(0.7, deep);
    h.addColorStop(0.72, '#4a2a30');
    h.addColorStop(1, '#3a2026');
    g.fillStyle = h;
    g.fillRect(32, 64, 32, 32);
    g.fillStyle = pink;
    g.fillRect(64, 64, 64, 32);
    g.fillStyle = deep;
    g.fillRect(72, 72, 16, 18);
  },
  glow(g, _n, p) {
    g.fillStyle = css(p.spell, 0.7);
    for (const x of [64, 96, 128]) {
      g.beginPath();
      g.arc(x, 30, 5, 0, Math.PI * 2);
      g.fill();
    }
  },
};

/** Broccoli floret painter: bumpy florets over a stalk strip. */
const paintBroccoli: Paint = (g, n, p) => {
  const H = Math.round(n * 0.625);
  g.fillStyle = css(p.robe, 1.3, p.spell, 0.55);
  g.fillRect(0, 0, n, H);
  const r = rng(11);
  for (let i = 0; i < 260; i++) {
    const x = r() * n, y = r() * H, rad = 2 + r() * 4;
    g.fillStyle = r() < 0.4 ? css(p.robe, 0.9) : css(p.spell, 1, p.robe, 0.25);
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = css(p.trim, 0.9, p.spell, 0.4);
    g.beginPath();
    g.arc(x - rad * 0.3, y - rad * 0.3, rad * 0.35, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = css(p.trim, 1.05, 0xf4ffe0, 0.25);
  g.fillRect(0, H, n, n - H);
  g.fillStyle = css(p.trim, 0.75, p.robe, 0.3);
  for (let x = 2; x < n; x += 6) g.fillRect(x, H, 2, n - H);
};

const paintBroccoliGlow: Paint = (g, n, p) => {
  const H = Math.round(n * 0.625);
  const r = rng(23);
  g.fillStyle = css(p.spell, 0.4);
  for (let i = 0; i < 60; i++) {
    g.beginPath();
    g.arc(r() * n, r() * H, 1.5 + r() * 2.5, 0, Math.PI * 2);
    g.fill();
  }
};

/** A cluster of floret spheres on a stalk; `florets` are [x, y, z, radius]. */
function broccoliGeometry(n: number, stalk: [r0: number, r1: number, h: number, y: number], florets: number[][], branches: number[][] = []): THREE.BufferGeometry {
  const head: Rect = [0, 0, n, Math.round(n * 0.625)], stem: Rect = [0, Math.round(n * 0.625), n, n - Math.round(n * 0.625)];
  const parts: THREE.BufferGeometry[] = [place(inRect(new THREE.CylinderGeometry(stalk[0], stalk[1], stalk[2], 8), n, stem), 0, stalk[3], 0)];
  for (const [x, y, z, rz, len, r] of branches) parts.push(place(inRect(new THREE.CylinderGeometry(r * 0.7, r, len, 6), n, stem), x, y, z, 0, 0, rz));
  for (const [x, y, z, r] of florets) parts.push(place(inRect(new THREE.SphereGeometry(r, 8, 6), n, head), x, y, z));
  return merge(parts);
}

/** A small broccoli floret (bolts). */
const FLORET: SkinDef = {
  atlas: 128,
  baseGlow: 0.3,
  emissive: 1.4,
  roughness: 0.85,
  glowSize: 0.9,
  solid(n) {
    const ring = [0, 1, 2, 3, 4].map((i) => {
      const a = (i / 5) * Math.PI * 2;
      return [Math.cos(a) * 0.085, 0.03, Math.sin(a) * 0.085, 0.07];
    });
    return broccoliGeometry(n, [0.04, 0.055, 0.17, -0.1], [[0, 0.08, 0, 0.095], ...ring]);
  },
  paint: paintBroccoli,
  glow: paintBroccoliGlow,
};

/** A whole head of broccoli (blasts). */
const BROCCOLI: SkinDef = {
  atlas: 128,
  baseGlow: 0.3,
  emissive: 1.4,
  roughness: 0.85,
  glowSize: 1,
  solid(n) {
    const florets: number[][] = [[0, 0.2, 0, 0.21]];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      florets.push([Math.cos(a) * 0.22, 0.09, Math.sin(a) * 0.22, 0.16]);
    }
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.4;
      florets.push([Math.cos(a) * 0.33, -0.06, Math.sin(a) * 0.33, 0.12]);
    }
    const branches = [[0.12, -0.17, 0, -0.7, 0.22, 0.05], [-0.12, -0.17, 0.02, 0.7, 0.22, 0.05]];
    return broccoliGeometry(n, [0.09, 0.12, 0.42, -0.3], florets, branches);
  },
  paint: paintBroccoli,
  glow: paintBroccoliGlow,
};

/** A brass round with a long additive tracer streak behind it. */
const BULLET: SkinDef = {
  atlas: 64,
  baseGlow: 0.45,
  emissive: 1.5,
  roughness: 0.35,
  glowSize: 0.45,
  solid(n) {
    const brass: Rect = [0, 0, 32, 64], copper: Rect = [32, 0, 32, 64];
    return merge([
      place(inRect(new THREE.CylinderGeometry(0.042, 0.042, 0.15, 10), n, brass), 0, 0, -0.075, Math.PI / 2),
      place(inRect(new THREE.ConeGeometry(0.042, 0.09, 10), n, copper), 0, 0, 0.045, Math.PI / 2),
    ]);
  },
  paint(g) {
    const b = g.createLinearGradient(0, 0, 32, 0);
    b.addColorStop(0, '#8a6a2a');
    b.addColorStop(0.45, '#f2d27a');
    b.addColorStop(1, '#7a5a22');
    g.fillStyle = b;
    g.fillRect(0, 0, 32, 64);
    g.fillStyle = 'rgba(60,40,10,0.7)';
    g.fillRect(0, 50, 32, 4); // extractor groove
    const c = g.createLinearGradient(32, 0, 64, 0);
    c.addColorStop(0, '#7a3a1c');
    c.addColorStop(0.45, '#e08a52');
    c.addColorStop(1, '#6a3018');
    g.fillStyle = c;
    g.fillRect(32, 0, 32, 64);
  },
  aura: {
    geometry: () => crossedStreak(0.085),
    w: 32,
    h: 128,
    intensity: 1.8,
    edge: 0.25,
    paint(g, _n, p) {
      // Across (x): a hot centre line. Along (y, head at the top): white-hot, palette, fading out.
      g.fillStyle = '#000';
      g.fillRect(0, 0, 32, 128);
      const along = g.createLinearGradient(0, 0, 0, 128);
      along.addColorStop(0, '#ffffff');
      along.addColorStop(0.12, css(p.spell, 1, 0xffffff, 0.5));
      along.addColorStop(0.5, css(p.spell, 0.75));
      along.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = along;
      g.fillRect(0, 0, 32, 128);
      g.globalCompositeOperation = 'multiply';
      const across = g.createLinearGradient(0, 0, 32, 0);
      across.addColorStop(0, '#000');
      across.addColorStop(0.5, '#fff');
      across.addColorStop(1, '#000');
      g.fillStyle = across;
      g.fillRect(0, 0, 32, 128);
      g.globalCompositeOperation = 'source-over';
    },
  },
};

/** An olive "pineapple" grenade with a palette band, fuse, spoon and pin ring. */
const GRENADE: SkinDef = {
  atlas: 128,
  baseGlow: 0.24,
  emissive: 1.5,
  roughness: 0.6,
  glowSize: 0.8,
  solid(n) {
    const body: Rect = [0, 0, 128, 88], metal: Rect = [0, 88, 128, 40];
    return merge([
      place(inRect(new THREE.SphereGeometry(0.15, 12, 9), n, body), 0, 0, 0, 0, 0, 0, 1, 1.22, 1),
      place(inRect(new THREE.CylinderGeometry(0.045, 0.052, 0.09, 8), n, metal), 0, 0.21, 0),
      place(inRect(new THREE.BoxGeometry(0.036, 0.21, 0.014), n, metal), 0.078, 0.13, 0, 0, 0, -0.32),
      place(inRect(new THREE.TorusGeometry(0.04, 0.009, 5, 10), n, metal), -0.065, 0.24, 0, 0, Math.PI / 2, 0),
    ]);
  },
  paint(g, n, p) {
    g.fillStyle = '#56652f';
    g.fillRect(0, 0, 128, 88);
    g.fillStyle = '#3a4620';
    for (let y = 16; y < 88; y += 14) g.fillRect(0, y, 128, 3);
    for (let x = 0; x < 128; x += 16) g.fillRect(x, 14, 3, 74);
    g.fillStyle = 'rgba(255,255,230,0.12)';
    for (let x = 4; x < 128; x += 16) g.fillRect(x, 20, 6, 60);
    g.fillStyle = css(p.blast);
    g.fillRect(0, 5, 128, 6); // marking band near the top
    const m = g.createLinearGradient(0, 88, 0, 128);
    m.addColorStop(0, css(p.trim, 1.05));
    m.addColorStop(1, css(p.trim, 0.55));
    g.fillStyle = m;
    g.fillRect(0, 88, 128, 40);
  },
  glow(g, _n, p) {
    g.fillStyle = css(p.blast, 0.8);
    g.fillRect(0, 5, 128, 6);
  },
};

/** Hellfire: a white-hot fireball wrapped in a trailing flame cone. */
const HELLFIRE: SkinDef = {
  atlas: 64,
  baseGlow: 1,
  emissive: 1.4,
  roughness: 1,
  glowSize: 1.5,
  solid: (n) => inRect(new THREE.IcosahedronGeometry(0.16, 1), n, [0, 0, 64, 64]),
  paint(g, n, p) {
    g.fillStyle = css(p.spell, 1, 0xffd060, 0.45);
    g.fillRect(0, 0, n, n);
    const r = rng(5);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = r() < 0.5 ? css(0xfff2c0) : css(p.blast);
      g.beginPath();
      g.arc(r() * n, r() * n, 2 + r() * 6, 0, Math.PI * 2);
      g.fill();
    }
  },
  aura: { geometry: () => flameCone(0.21, 0.9, 0.02), w: 64, h: 128, intensity: 1.0, edge: 0.1, paint: (g, n, p) => paintFlame(p.spell, p.blast, 3)(g, n, p) },
};

/** A burning skull: bone cranium and jaw, glowing eyes, flames streaming back over the top. */
const SKULL: SkinDef = {
  atlas: 256,
  baseGlow: 0.3,
  emissive: 2,
  roughness: 0.7,
  glowSize: 1.25,
  solid(n) {
    const cranium: Rect = [0, 0, 256, 192], jaw: Rect = [0, 192, 256, 64];
    return merge([
      place(inRect(new THREE.SphereGeometry(0.3, 14, 10), n, cranium), 0, 0.05, 0, 0, 0, 0, 0.92, 0.9, 1.0),
      // Upper jaw and teeth: a squashed sphere under the front of the cranium.
      place(inRect(new THREE.SphereGeometry(1, 12, 6), n, jaw), 0, -0.17, 0.11, 0, 0, 0, 0.17, 0.11, 0.16),
    ]);
  },
  paint(g, n, p) {
    const bone = (k: number) => css(p.robe, k, 0xe8e0c8, 0.55);
    const grad = g.createLinearGradient(0, 0, 0, 192);
    grad.addColorStop(0, bone(1.05));
    grad.addColorStop(1, bone(0.7));
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 192);
    // The face sits at u = 0.25 (the sphere's +z): sockets, nose, cracks.
    g.fillStyle = '#1a0d0a';
    for (const dx of [-19, 19]) {
      g.beginPath();
      g.ellipse(64 + dx, 100, 15, 17, dx * 0.012, 0, Math.PI * 2);
      g.fill();
    }
    g.beginPath();
    g.moveTo(64, 120);
    g.lineTo(57, 140);
    g.lineTo(71, 140);
    g.fill();
    // Brow ridge shading over the sockets.
    g.fillStyle = bone(0.75);
    g.fillRect(36, 78, 56, 4);
    g.strokeStyle = bone(0.45);
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(170, 20);
    g.lineTo(182, 60);
    g.lineTo(172, 90);
    g.moveTo(40, 30);
    g.lineTo(52, 56);
    g.stroke();
    // Jaw (a sphere, so its front is also u = 0.25): teeth on bone, a dark bite line.
    g.fillStyle = bone(0.85);
    g.fillRect(0, 192, 256, 64);
    g.fillStyle = bone(1.1);
    g.fillRect(16, 206, 96, 36);
    g.fillStyle = '#1a0d0a';
    g.fillRect(16, 222, 96, 4);
    for (let x = 16; x <= 112; x += 12) g.fillRect(x, 206, 2, 36);
  },
  glow(g, _n, p) {
    for (const dx of [-19, 19]) {
      const r = g.createRadialGradient(64 + dx, 102, 1, 64 + dx, 102, 13);
      r.addColorStop(0, '#ffffff');
      r.addColorStop(0.35, css(p.spell));
      r.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = r;
      g.fillRect(64 + dx - 14, 86, 28, 32);
    }
  },
  aura: {
    geometry: () => flameCone(0.34, 1.25, 0.02).rotateX(0.5).translate(0, 0.2, -0.02),
    w: 64,
    h: 128,
    intensity: 1.8,
    edge: 0.25,
    paint: (g, n, p) => paintFlame(p.blast, p.spell, 9)(g, n, p),
  },
};

/** Every object look, by skin. */
export const SKIN_LOOKS: Record<ObjectSkin, SkinDef> = {
  rugRoll: RUG_ROLL,
  carpet: CARPET,
  phone: PHONE,
  pig: PIG,
  floret: FLORET,
  broccoli: BROCCOLI,
  bullet: BULLET,
  grenade: GRENADE,
  hellfire: HELLFIRE,
  skull: SKULL,
};

/** Every object skin (everything but 'orb'). */
export const OBJECT_SKINS = Object.keys(SKIN_LOOKS) as ObjectSkin[];
