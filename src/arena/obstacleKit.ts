import * as THREE from 'three';
import { CONFIG, type ObstacleDef } from '../config';
import { at, box, brokenBox, cyl, hash3, jag, merge, rng, tint } from './geo';
import type { ObstacleKind } from './Pillar';
import type { ArenaTheme } from './themes';

const O = CONFIG.arena.obstacles;

/** One mesh of an obstacle look. */
export interface KitPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Standard materials are cloned per obstacle so damage tint and hit glow stay per obstacle. */
  perPillar: boolean;
  shadow: boolean;
}

/** Standing variants (picked by placement index) and stump variants of one obstacle kind. */
export interface ObstacleLook {
  wholes: KitPart[][];
  stumps: KitPart[][];
}

/** Height every candlestick look is built at; Arena scales it to the placement's height. */
export const CANDLE_REF_HEIGHT = 3;

const furniture = (roughness = 0.8, metalness = 0.05) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness });
const glowMat = () => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

/** A box tilted about x (awnings, fallen panels), then placed. */
function tilted(w: number, h: number, d: number, rx: number, rz: number, x: number, y: number, z: number, hex: number, k = 1): THREE.BufferGeometry {
  const g = tint(new THREE.BoxGeometry(w, h, d), hex, k);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  return at(g, y, x, z);
}

/** A cylinder lying along x (wheels use axis z: pass `alongZ`). */
function lying(r: number, len: number, seg: number, x: number, y: number, z: number, hex: number, alongZ = false, k = 1): THREE.BufferGeometry {
  const g = tint(new THREE.CylinderGeometry(r, r, len, seg), hex, k);
  if (alongZ) g.rotateX(Math.PI / 2);
  else g.rotateZ(Math.PI / 2);
  return at(g, y, x, z);
}

/** A lumpy rock: an icosahedron pushed around by position noise, scaled to (sx, sy, sz), base on the floor. */
function rock(sx: number, sy: number, sz: number, x: number, z: number, hex: number, seed: number, y0 = 0): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    const k = 1 + hash3(px, py, pz, seed) * 0.18;
    pos.setXYZ(i, px * k * sx, (py * k * 0.5 + 0.5) * sy + y0, pz * k * sz);
  }
  g.computeVertexNormals();
  return at(tint(g, hex, 1), 0, x, z);
}

const part = (geometry: THREE.BufferGeometry, material: THREE.Material, perPillar = true, shadow = true): KitPart => ({ geometry, material, perPillar, shadow });

/** Look of an obstacle kind from CONFIG.arena.obstacles (null for kinds built elsewhere). */
export function buildObstacleLook(kind: ObstacleKind, theme: ArenaTheme): ObstacleLook | null {
  const def = (O as Record<string, ObstacleDef>)[kind];
  if (!def) return null;
  const builder = BUILDERS[kind as keyof typeof BUILDERS];
  return builder ? builder(def, theme) : null;
}

type Builder = (def: ObstacleDef, theme: ArenaTheme) => ObstacleLook;

const STRIPES: [number, number][] = [[0xb8342a, 0xf0e2c4], [0x2a6a9a, 0xf0e2c4], [0x2a7a5a, 0xe8b84a]];
const PAINT = [0x2ab0b8, 0xd84a8a, 0xe8e4dc, 0x1c1c22, 0x6a3ab0];
const RUG = [0x8a2a2a, 0x2a4a7a, 0xb8862a, 0x6a2a5a, 0x2a6a5a, 0xc86a3a];

const BUILDERS: Partial<Record<ObstacleKind, Builder>> = {
  // ---------------------------------------------------------------- bazaar
  stall(def) {
    const p = def.parts[0];
    const W = p.halfX! * 2, D = p.halfZ! * 2, H = p.height;
    const wood = 0x6a4a2e, dark = 0x4a3220;
    const wholes: KitPart[][] = [];
    const glow = glowMat();
    const mat = furniture(0.9);
    for (const [c1, c2] of STRIPES) {
      const g: THREE.BufferGeometry[] = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.push(box(0.1, H - 0.1, 0.1, sx * (W / 2 - 0.08), (H - 0.1) / 2, sz * (D / 2 - 0.08), wood));
      const n = 8;
      for (let i = 0; i < n; i++) g.push(box(W / n, 1.9, 0.04, -W / 2 + (i + 0.5) * (W / n), 1.25, -D / 2 + 0.04, i % 2 ? c2 : c1));
      for (const sx of [-1, 1]) g.push(box(0.04, 1.9, D - 0.1, sx * (W / 2 - 0.04), 1.25, 0, c1));
      g.push(box(W - 0.1, 0.9, 0.55, 0, 0.45, D / 2 - 0.32, wood));
      g.push(box(W, 0.06, 0.65, 0, 0.93, D / 2 - 0.32, dark));
      const spice = [0xd8642a, 0xc83a2a, 0xe8b82a, 0x7a9a3a, 0x8a4a2a];
      for (let i = 0; i < 5; i++) {
        const x = -W / 2 + 0.35 + i * ((W - 0.7) / 4);
        g.push(cyl(0.16, 0.12, 0.07, 10, x, 0.995, D / 2 - 0.32, 0x8a6a4a));
        g.push(at(tint(new THREE.ConeGeometry(0.14, 0.16, 10), spice[i], 1), 1.11, x, D / 2 - 0.32));
      }
      for (let i = 0; i < 3; i++) g.push(lying(0.1, W * 0.7, 8, 0, 0.55 + i * 0.2, -D / 2 + 0.25, RUG[i + 1]));
      for (let i = 0; i < n; i++) g.push(tilted(W / n + 0.01, 0.04, D + 0.3, -0.16, 0, -W / 2 + (i + 0.5) * (W / n), H - 0.05, 0.12, i % 2 ? c2 : c1));
      g.push(box(W + 0.05, 0.16, 0.03, 0, H - 0.27, D / 2 + 0.27, c1));
      wholes.push([part(merge(g), mat), part(box(0.12, 0.16, 0.12, W / 2 - 0.35, H - 0.45, D / 2 - 0.1, 0xffc070, 2), glow, false, false)]);
    }
    const stumps: KitPart[][] = [];
    for (let v = 0; v < 3; v++) {
      const [c1, c2] = STRIPES[v];
      const g: THREE.BufferGeometry[] = [box(W - 0.1, 0.9, 0.55, 0, 0.45, D / 2 - 0.32, wood)];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.push(brokenBox(0.1, 0.55, 0.1, sx * (W / 2 - 0.08), 0, sz * (D / 2 - 0.08), wood, v * 7 + sx + sz * 3, 0, 0.2));
      for (let i = 0; i < 6; i++) g.push(tilted(W / 6, 0.03, 1.4, 0, 0.05 * (i - 3), -W / 2 + (i + 0.5) * (W / 6), 0.03, -D / 2 + 0.6, i % 2 ? c2 : c1));
      g.push(lying(0.1, 1.2, 8, 0.3 - v * 0.3, 0.1, -0.6, RUG[v]));
      stumps.push([part(merge(g), mat, false)]);
    }
    return { wholes, stumps };
  },

  rugs(def) {
    const p = def.parts[0];
    const W = p.halfX! * 2, D = p.halfZ! * 2, H = p.height;
    const r = rng(17);
    const wholes: KitPart[][] = [];
    const mat = furniture(1);
    for (let v = 0; v < 3; v++) {
      const g: THREE.BufferGeometry[] = [];
      const layers = 5;
      const th = (H - 0.18) / layers;
      for (let i = 0; i < layers; i++) {
        g.push(box(W - 0.05 - r() * 0.15, th - 0.01, D - 0.05 - r() * 0.15, (r() - 0.5) * 0.08, th / 2 + i * th, (r() - 0.5) * 0.08, RUG[(i + v * 2) % RUG.length], 1, (r() - 0.5) * 0.1));
        g.push(box(W - 0.2, 0.012, 0.04, 0, (i + 1) * th - 0.01, D / 2 - 0.07, 0xe8d8b0));
      }
      for (let k = 0; k < 2; k++) g.push(lying(0.09, W * 0.85, 10, 0, H - 0.18 + 0.09, (k - 0.5) * 0.4, RUG[(v + k + 3) % RUG.length]));
      wholes.push([part(merge(g), mat, true, false)]);
    }
    return { wholes, stumps: [] };
  },

  cart(def) {
    const p = def.parts[0];
    const W = p.halfX! * 2, D = p.halfZ! * 2;
    const wood = 0x7a5232;
    const g = [
      box(W - 0.1, 0.1, D - 0.15, 0, 0.6, 0, wood),
      box(W - 0.1, 0.28, 0.05, 0, 0.78, D / 2 - 0.1, wood),
      box(W - 0.1, 0.28, 0.05, 0, 0.78, -D / 2 + 0.1, wood),
      box(0.05, 0.28, D - 0.15, W / 2 - 0.08, 0.78, 0, wood),
      box(0.05, 0.28, D - 0.15, -W / 2 + 0.08, 0.78, 0, wood),
      lying(0.38, 0.07, 14, 0, 0.38, D / 2 - 0.04, 0x4a3220, true),
      lying(0.38, 0.07, 14, 0, 0.38, -D / 2 + 0.04, 0x4a3220, true),
      lying(0.05, D, 6, 0, 0.38, 0, 0x2a2a2a, true),
      at(tint(new THREE.SphereGeometry(0.24, 10, 8).scale(1, 0.8, 1), 0xb87a4a, 1), 0.85, -0.35, 0.1),
      at(tint(new THREE.SphereGeometry(0.2, 10, 8).scale(1.2, 0.8, 1), 0xd8c89a, 1), 0.82, 0.25, -0.1),
      cyl(0.12, 0.16, 0.36, 10, 0.5, 0.86, 0.15, 0xc86a3a),
    ];
    const mat = furniture(0.9);
    const s = [
      tilted(W - 0.1, 0.1, D - 0.15, 0, 0.35, 0, 0.3, 0, wood),
      lying(0.38, 0.07, 14, 0.4, 0.04, 0.6, 0x4a3220),
      brokenBox(W - 0.3, 0.3, 0.05, 0, 0, -0.2, wood, 4),
    ];
    return { wholes: [[part(merge(g), mat)]], stumps: [[part(merge(s), mat, false)]] };
  },

  pots(def) {
    const R = def.parts[0].radius!;
    const terracotta = [0xb8623a, 0xa8522a, 0xc8783a, 0x8a4a2a];
    const spots: [number, number, number][] = [[0, 0, 0.42], [R * 0.55, 0.15, 0.3], [-R * 0.5, R * 0.3, 0.32], [0.05, -R * 0.55, 0.28], [-R * 0.3, -R * 0.4, 0.22]];
    const g: THREE.BufferGeometry[] = [];
    spots.forEach(([x, z, r], i) => {
      const h = i === 0 ? 0.85 : r * 1.9;
      g.push(at(tint(new THREE.SphereGeometry(r, 12, 9).scale(1, (h * 0.75) / (2 * r), 1), terracotta[i % 4], 1), h * 0.38, x, z));
      g.push(cyl(r * 0.4, r * 0.5, h * 0.25, 10, x, h * 0.8, z, terracotta[(i + 1) % 4]));
      g.push(cyl(r * 0.5, r * 0.45, 0.04, 10, x, h * 0.92, z, 0x6a3a1a));
    });
    const s: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 9; i++) s.push(box(0.18, 0.04, 0.12, Math.cos(i * 2.1) * 0.4, 0.02, Math.sin(i * 2.1) * 0.4, terracotta[i % 4], 1, i));
    s.push(brokenBox(0.5, 0.2, 0.5, 0, 0, 0, terracotta[0], 3));
    const mat = furniture(0.85);
    return { wholes: [[part(merge(g), mat, true, false)]], stumps: [[part(merge(s), mat, false, false)]] };
  },

  // ---------------------------------------------------------------- blockchain void
  candle(def) {
    const p = def.parts[0];
    const W = p.halfX! * 2, H = CANDLE_REF_HEIGHT;
    const wholes: KitPart[][] = [];
    for (const [hex, glow] of [[0x2aff8a, 0x10a050], [0xff3a4a, 0xa01020]] as const) {
      const body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.2, emissive: glow, emissiveIntensity: 1 });
      // Wick and glowing edges share one unlit mesh (one draw call, no shadow).
      const lines = merge([
        ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => box(0.05, H * 0.62, 0.05, sx * W / 2, H * 0.5, sz * W / 2, hex, 1.6))),
        box(0.12, H, 0.12, 0, H / 2, 0, 0x9a9aaa, 0.8),
      ]);
      wholes.push([
        part(box(W - 0.04, H * 0.62, W - 0.04, 0, H * 0.5, 0, hex, 0.55), body),
        part(lines, glowMat(), false, false),
      ]);
    }
    const stump = brokenBox(W - 0.04, 0.45, W - 0.04, 0, 0, 0, 0x2a2a34, 6, 0, 0.25);
    return { wholes, stumps: [[part(stump, furniture(0.4, 0.3), false)]] };
  },

  block(def, theme) {
    const p = def.parts[0];
    const S = p.halfX! * 2;
    const accent = theme.pillar.accent;
    const edges: THREE.BufferGeometry[] = [];
    const e = 0.06, h = S / 2;
    for (const a of [-1, 1]) {
      for (const b of [-1, 1]) {
        edges.push(box(S, e, e, 0, h + a * h, b * h, accent, 1.6));
        edges.push(box(e, e, S, a * h, h + b * h, 0, accent, 1.6));
        edges.push(box(e, S, e, a * h, h, b * h, accent, 1.6));
      }
    }
    // A "#" (hash) on each side.
    for (let f = 0; f < 4; f++) {
      const rot = (f * Math.PI) / 2;
      for (const o of [-0.25, 0.25]) {
        edges.push(at(tint(new THREE.BoxGeometry(0.05, S * 0.6, 0.02), theme.pillar.trim ?? accent, 1.3).translate(o, 0, h + 0.01), h, 0, 0, rot));
        edges.push(at(tint(new THREE.BoxGeometry(S * 0.6, 0.05, 0.02), theme.pillar.trim ?? accent, 1.3).translate(0, o, h + 0.01), h, 0, 0, rot));
      }
    }
    return {
      wholes: [[
        part(box(S - 0.02, S - 0.02, S - 0.02, 0, h, 0, 0x1a1426), furniture(0.3, 0.45)),
        part(merge(edges), glowMat(), false, false),
      ]],
      stumps: [],
    };
  },

  // ---------------------------------------------------------------- los angeles
  car(def) {
    const lower = def.parts[0], cab = def.parts[1];
    const L = lower.halfX! * 2, Wd = lower.halfZ! * 2;
    const wholes: KitPart[][] = [];
    const glow = glowMat();
    for (const paint of PAINT) {
      const g = [
        box(L - 0.1, 0.55, Wd - 0.06, 0, 0.62, 0, paint),
        box(L - 0.12, 0.05, Wd - 0.12, 0, lower.height - 0.02, 0, paint, 0.9),
        box(0.12, 0.22, Wd - 0.1, L / 2 - 0.06, 0.45, 0, 0x8a8a90),
        box(0.12, 0.22, Wd - 0.1, -L / 2 + 0.06, 0.45, 0, 0x8a8a90),
        box(cab.halfX! * 2 - 0.1, 0.18, cab.halfZ! * 2 - 0.06, cab.x ?? 0, 1.0, 0, paint),
        box(cab.halfX! * 2 - 0.2, 0.3, cab.halfZ! * 2 - 0.1, cab.x ?? 0, 1.2, 0, 0x22303a),
        box(cab.halfX! * 2 - 0.3, 0.06, cab.halfZ! * 2 - 0.16, cab.x ?? 0, cab.height - 0.03, 0, paint),
      ];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        g.push(lying(0.34, 0.24, 14, sx * (L / 2 - 0.75), 0.34, sz * (Wd / 2 - 0.08), 0x18181a, true));
        g.push(lying(0.17, 0.26, 10, sx * (L / 2 - 0.75), 0.34, sz * (Wd / 2 - 0.08), 0xa0a0a8, true));
      }
      const lights = merge([
        box(0.04, 0.12, 0.32, L / 2 - 0.02, 0.66, Wd / 2 - 0.3, 0xfff0d0, 1.8),
        box(0.04, 0.12, 0.32, L / 2 - 0.02, 0.66, -Wd / 2 + 0.3, 0xfff0d0, 1.8),
        box(0.04, 0.1, 0.36, -L / 2 + 0.02, 0.7, Wd / 2 - 0.3, 0xff2030, 1.6),
        box(0.04, 0.1, 0.36, -L / 2 + 0.02, 0.7, -Wd / 2 + 0.3, 0xff2030, 1.6),
      ]);
      wholes.push([part(merge(g), furniture(0.4, 0.35)), part(lights, glow, false, false)]);
    }
    const s = [
      brokenBox(L - 0.3, 0.42, Wd - 0.15, 0, 0.12, 0, 0x2a2624, 9, 0, 0.18),
      lying(0.34, 0.24, 12, L / 2 - 0.75, 0.3, Wd / 2 - 0.1, 0x18181a, true),
      lying(0.34, 0.24, 12, -L / 2 + 0.75, 0.3, -Wd / 2 + 0.1, 0x18181a, true),
      tilted(1.4, 0.05, 1.2, 0.3, 0.2, -0.4, 0.62, 0.2, 0x3a3634),
    ];
    return { wholes, stumps: [[part(merge(s), furniture(0.9), false)]] };
  },

  truck(def) {
    const p = def.parts[0];
    const L = p.halfX! * 2, Wd = p.halfZ! * 2;
    const body = 0xf0e6d0, stripe = 0xff4aa0;
    const g = [
      box(L - 1.5, 2.3, Wd - 0.04, -0.75, 1.5, 0, body),
      box(L - 1.48, 0.45, Wd, -0.75, 1.0, 0, stripe),
      box(1.4, 1.5, Wd - 0.1, L / 2 - 0.72, 1.1, 0, body),
      box(0.05, 0.6, Wd - 0.3, L / 2 - 0.02, 1.45, 0, 0x22303a),
      box(L - 1.4, 0.1, Wd, -0.7, 2.7, 0, 0xd8d0c0),
      box(2.4, 0.06, 0.6, -0.8, 2.3, Wd / 2 + 0.12, stripe),
      box(2.3, 0.08, 0.32, -0.8, 1.2, Wd / 2 + 0.1, 0xb8b8b8),
    ];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.push(lying(0.45, 0.3, 14, sx * (L / 2 - 1.0), 0.45, sz * (Wd / 2 - 0.12), 0x18181a, true));
    const glow = merge([
      box(2.2, 0.85, 0.03, -0.8, 1.75, Wd / 2 + 0.005, 0xffc080, 1.25),
      box(2.6, 0.5, 0.14, -0.8, 2.98, 0, 0xff4aa0, 1.9),
      box(2.4, 0.08, 0.16, -0.8, 2.7, 0, 0x30e8d8, 2),
      box(0.04, 0.14, 0.4, L / 2 + 0.02, 0.7, 0.7, 0xfff0d0, 1.6),
      box(0.04, 0.14, 0.4, L / 2 + 0.02, 0.7, -0.7, 0xfff0d0, 1.6),
    ]);
    const s = [
      brokenBox(L - 0.4, 0.8, Wd - 0.1, 0, 0.15, 0, 0x34302c, 11, 0, 0.25),
      lying(0.45, 0.3, 12, L / 2 - 1.0, 0.45, Wd / 2 - 0.12, 0x18181a, true),
      lying(0.45, 0.3, 12, -L / 2 + 1.0, 0.45, -Wd / 2 + 0.12, 0x18181a, true),
      tilted(2.4, 0.06, 1.6, 0.25, 0.15, 0.6, 1.1, 0, stripe),
    ];
    return { wholes: [[part(merge(g), furniture(0.5, 0.3)), part(glow, glowMat(), false, false)]], stumps: [[part(merge(s), furniture(0.9), false)]] };
  },

  dumpster(def) {
    const p = def.parts[0];
    const W = p.halfX! * 2, D = p.halfZ! * 2, H = p.height;
    const wholes: KitPart[][] = [];
    for (const c of [0x2e6a3a, 0x2a4a7a]) {
      const g = [
        box(W - 0.08, H - 0.28, D - 0.06, 0, 0.12 + (H - 0.28) / 2, 0, c),
        tilted(W, 0.07, D + 0.04, 0.06, 0, 0, H - 0.08, 0, 0x1e1e22),
        box(0.07, 0.07, D + 0.08, W / 2 - 0.12, H - 0.42, 0, c, 0.7),
        box(0.07, 0.07, D + 0.08, -W / 2 + 0.12, H - 0.42, 0, c, 0.7),
        box(0.7, 0.24, 0.01, -0.3, 0.7, D / 2 - 0.02, 0xff4aa0),
        box(0.4, 0.14, 0.01, 0.4, 0.5, D / 2 - 0.02, 0x30e8d8),
      ];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.push(lying(0.07, 0.05, 8, sx * (W / 2 - 0.2), 0.07, sz * (D / 2 - 0.15), 0x18181a, true));
      wholes.push([part(merge(g), furniture(0.6, 0.4))]);
    }
    const s = [brokenBox(W - 0.1, 0.45, D - 0.1, 0, 0.05, 0, 0x2a3a2a, 13), tilted(W, 0.06, D, 0.9, 0, 0, 0.5, -D / 2 - 0.2, 0x1e1e22)];
    return { wholes, stumps: [[part(merge(s), furniture(0.8), false)]] };
  },

  shelter(def) {
    const back = def.parts[0], side = def.parts[1], roof = def.parts[2];
    const metal = 0x3a3e44;
    const g = [
      box(back.halfX! * 2, 0.08, 0.1, 0, back.height - 0.04, back.z!, metal),
      box(back.halfX! * 2, 0.08, 0.1, 0, 0.1, back.z!, metal),
      box(back.halfX! * 2 - 0.1, back.height - 0.2, 0.03, 0, back.height / 2, back.z! - 0.02, 0x7a98a0),
      box(0.04, side.height - 0.2, side.halfZ! * 2, side.x!, side.height / 2, side.z!, 0x7a98a0),
      box(roof.halfX! * 2, roof.height - roof.y0!, roof.halfZ! * 2, 0, (roof.height + roof.y0!) / 2, 0, metal),
      box(2.4, 0.07, 0.42, -0.2, 0.46, back.z! + 0.3, 0x8a6a4a),
      box(0.06, 0.42, 0.06, -1.2, 0.21, back.z! + 0.3, metal),
      box(0.06, 0.42, 0.06, 0.8, 0.21, back.z! + 0.3, metal),
    ];
    for (const sx of [-1, 1]) {
      g.push(box(0.08, roof.y0!, 0.08, sx * (back.halfX! - 0.04), roof.y0! / 2, back.z!, metal));
      g.push(box(0.08, roof.y0!, 0.08, sx * (back.halfX! - 0.04), roof.y0! / 2, roof.halfZ! - 0.1, metal));
    }
    const ad = merge([
      box(1.3, 1.6, 0.03, -0.75, 1.25, back.z! + 0.03, 0x58f0d8, 1.1),
      box(0.9, 0.5, 0.032, -0.75, 1.45, back.z! + 0.031, 0xff6ab0, 1.4),
      box(roof.halfX! * 2 - 0.2, 0.05, 0.05, 0, roof.y0! - 0.04, roof.halfZ! - 0.08, 0xfff0d8, 1.8),
    ]);
    const s = [
      box(2.4, 0.07, 0.42, -0.2, 0.42, back.z! + 0.3, 0x8a6a4a),
      brokenBox(back.halfX! * 2, 0.4, 0.1, 0, 0, back.z!, metal, 5),
      tilted(roof.halfX! * 2, 0.12, roof.halfZ! * 2, 0.3, 0.1, 0.2, 0.35, 0.3, metal),
    ];
    return { wholes: [[part(merge(g), furniture(0.5, 0.5)), part(ad, glowMat(), false, false)]], stumps: [[part(merge(s), furniture(0.7, 0.4), false)]] };
  },

  planter(def) {
    const pot = def.parts[0], trunk = def.parts[1];
    const trunkGeo = tint(new THREE.CylinderGeometry(trunk.radius! * 0.75, trunk.radius!, trunk.height, 8, 10), 0x5a463a, 1);
    trunkGeo.translate(0, trunk.height / 2, 0);
    const pos = trunkGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      pos.setX(i, pos.getX(i) + 0.012 * y * y);
    }
    trunkGeo.computeVertexNormals();
    const g = [cyl(pot.radius!, pot.radius! * 0.92, pot.height, 20, 0, pot.height / 2, 0, 0x9a9690), cyl(pot.radius! - 0.08, pot.radius! - 0.08, 0.05, 20, 0, pot.height - 0.01, 0, 0x4a3426), trunkGeo];
    const fronds: THREE.BufferGeometry[] = [];
    const topX = 0.012 * trunk.height * trunk.height;
    for (let k = 0; k < 11; k++) {
      const f = new THREE.PlaneGeometry(2.4, 0.46, 8, 1);
      f.translate(1.2, 0, 0);
      f.rotateX(-Math.PI / 2);
      const fp = f.attributes.position;
      for (let i = 0; i < fp.count; i++) {
        const x = fp.getX(i);
        fp.setY(i, 0.35 * x - 0.24 * x * x);
        fp.setZ(i, fp.getZ(i) * (1.1 - x / 2.6));
      }
      f.rotateY((k / 11) * Math.PI * 2 + (k % 2) * 0.2);
      f.translate(topX, trunk.height, 0);
      f.computeVertexNormals();
      fronds.push(tint(f, 0x2c4426, 1));
    }
    return {
      wholes: [[
        part(merge(g), furniture(0.9)),
        part(merge(fronds), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }), false, true),
      ]],
      stumps: [],
    };
  },

  // ---------------------------------------------------------------- hellfire caldera
  rockA: (def, theme) => rockLook(def, theme, 21),
  rockB: (def, theme) => rockLook(def, theme, 37),

  ruin(def, theme) {
    const p = def.parts[0];
    const r = p.radius!, H = p.height;
    const stone = new THREE.Color(theme.pillar.color).multiplyScalar(0.55).getHex();
    const body = jag(new THREE.CylinderGeometry(r * 0.92, r, H - 0.3, 6, 3), (H - 0.3) / 2 - 0.05, 0.45, 3);
    body.translate(0, (H - 0.3) / 2 + 0.3, 0);
    const g = [tint(body, stone, 1), at(tint(new THREE.CylinderGeometry(r * 1.25, r * 1.4, 0.3, 6), stone, 0.85), 0.15)];
    const seams = merge([0.25, 0.55].map((k) => tint(at(new THREE.CylinderGeometry(r * 1.0, r * 1.0, 0.07, 6, 1, true), H * k), theme.pillar.accent, 2.2)));
    const s = jag(new THREE.CylinderGeometry(r * 0.95, r * 1.3, 0.9, 6, 1), 0.3, 0.35, 8);
    s.translate(0, 0.45, 0);
    return {
      wholes: [[part(merge(g), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true })), part(seams, glowMat(), false, false)]],
      stumps: [[part(tint(s, theme.pillar.stump, 1), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }), false)]],
    };
  },
};

/** Basalt outcrop: a lumpy rock over each collider part, boulders at the foot, glowing magma veins. */
function rockLook(def: ObstacleDef, theme: ArenaTheme, seed: number): ObstacleLook {
  const r = rng(seed);
  const g: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  def.parts.forEach((p, i) => {
    const sx = p.shape === 'box' ? p.halfX! : p.radius!;
    const sz = p.shape === 'box' ? p.halfZ! : p.radius!;
    const geo = rock(sx * 1.08, p.height, sz * 1.08, 0, 0, i % 2 ? 0x3a302e : 0x2e2624, seed + i * 13);
    if (p.yaw) geo.rotateY(p.yaw);
    geo.translate(p.x ?? 0, 0, p.z ?? 0);
    g.push(geo);
    for (let k = 0; k < 3; k++) {
      const a = r() * Math.PI * 2;
      const d = Math.max(sx, sz) * (0.9 + r() * 0.3);
      const s = 0.3 + r() * 0.35;
      g.push(rock(s, s * 1.2, s, (p.x ?? 0) + Math.cos(a) * d, (p.z ?? 0) + Math.sin(a) * d, 0x241e1c, seed + i * 7 + k));
      if (k === 0) glow.push(rock(s * 0.5, s * 0.5, s * 0.5, (p.x ?? 0) + Math.cos(a + 0.6) * d, (p.z ?? 0) + Math.sin(a + 0.6) * d, theme.pillar.accent, seed + k, 0));
    }
  });
  for (const v of glow) {
    const col = v.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * 2, col.getY(i) * 2, col.getZ(i) * 2);
  }
  return {
    wholes: [[
      part(merge(g), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true })),
      part(merge(glow), glowMat(), false, false),
    ]],
    stumps: [],
  };
}
